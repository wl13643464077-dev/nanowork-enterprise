import { curTenant, getTenantConfig } from '../db.js';

export const APPROVAL_ROUTING_POLICY_KEY = 'approval_routing_policy';
export const APPROVAL_ROUTING_SCHEMA_V1 = 'nanowork.approval-routing-policy/1';
export const APPROVAL_ROUTING_SCHEMA = 'nanowork.approval-routing-policy/2';
export const APPROVAL_WORKFLOW_SNAPSHOT_SCHEMA = 'nanowork.approval-workflow-snapshot/1';

const APPROVAL_ROUTING_SCHEMAS = new Set([APPROVAL_ROUTING_SCHEMA_V1, APPROVAL_ROUTING_SCHEMA]);
const LEGACY_EMPLOYEE_SETTING_MODE = 'employee_setting';

const TARGETS = Object.freeze({
  content: {
    key: 'employeeOutput',
    // employee_setting is intentionally retained only for v1 snapshots and
    // stored policies. New v2 writes expose the four explicit modes below.
    modes: new Set(['auto', 'risk_based', 'manager', 'boss', LEGACY_EMPLOYEE_SETTING_MODE]),
    defaultMode: 'auto',
  },
  activity_plan: {
    key: 'activityPlan',
    modes: new Set(['two_step', 'manager', 'boss', 'amount_threshold']),
    defaultMode: 'two_step',
  },
  activity_checklist: {
    key: 'activityChecklist',
    modes: new Set(['two_step', 'manager', 'boss']),
    defaultMode: 'two_step',
  },
});

const MAX_AMOUNT = 1_000_000_000_000;
const SELF_AUTHORIZING_ROLES = new Set(['boss', 'platform_super']);

export const DEFAULT_APPROVAL_ROUTING_POLICY = Object.freeze({
  schemaVersion: APPROVAL_ROUTING_SCHEMA,
  employeeOutput: Object.freeze({
    mode: 'auto',
    reviewerUserId: null,
  }),
  activityPlan: Object.freeze({
    mode: 'two_step',
    reviewerUserId: null,
    ownerAmountThreshold: 10_000,
  }),
  activityChecklist: Object.freeze({
    mode: 'two_step',
    reviewerUserId: null,
  }),
  safeguards: Object.freeze({
    internalOutputReviewControlledByPolicy: true,
    externalActionOwnerAuthorization: true,
    paidActionOwnerAuthorization: true,
    irreversibleActionOwnerAuthorization: true,
  }),
  configuredBy: null,
  updatedAt: null,
});

function policyError(message, code = 'APPROVAL_ROUTING_POLICY_INVALID') {
  return Object.assign(new Error(message), { status: 400, code });
}

function record(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalUserId(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw policyError(`${label}审批人不正确`);
  return id;
}

function normalizedAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.min(MAX_AMOUNT, amount) : 0;
}

function normalizeRoute(value, target, schemaVersion) {
  const definition = TARGETS[target];
  const source = record(value) ? value : {};
  const defaultMode = target === 'content' && schemaVersion === APPROVAL_ROUTING_SCHEMA_V1
    ? LEGACY_EMPLOYEE_SETTING_MODE
    : definition.defaultMode;
  const mode = String(source.mode || defaultMode).trim();
  if (!definition.modes.has(mode)) {
    throw policyError(`${definition.key}.mode不支持：${mode}`);
  }
  if (target === 'content' && mode === LEGACY_EMPLOYEE_SETTING_MODE && schemaVersion !== APPROVAL_ROUTING_SCHEMA_V1) {
    throw policyError(`${definition.key}.mode不支持：${mode}`);
  }
  const output = {
    mode,
    reviewerUserId: optionalUserId(source.reviewerUserId, definition.key),
  };
  if (target === 'activity_plan') {
    const threshold = source.ownerAmountThreshold ?? DEFAULT_APPROVAL_ROUTING_POLICY.activityPlan.ownerAmountThreshold;
    const amount = Number(threshold);
    if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT) {
      throw policyError(`activityPlan.ownerAmountThreshold必须在0到${MAX_AMOUNT}之间`);
    }
    output.ownerAmountThreshold = Math.round(amount * 100) / 100;
  }
  return output;
}

export function normalizeApprovalRoutingPolicy(value, { configuredBy = null, updatedAt = null } = {}) {
  if (value !== undefined && value !== null && !record(value)) {
    throw policyError('审批规则必须是对象');
  }
  const source = record(value) ? value : {};
  const sourceSchema = source.schemaVersion === undefined || source.schemaVersion === null || source.schemaVersion === ''
    ? APPROVAL_ROUTING_SCHEMA
    : String(source.schemaVersion);
  if (!APPROVAL_ROUTING_SCHEMAS.has(sourceSchema)) {
    throw policyError(`审批规则版本不支持：${sourceSchema}`);
  }
  return {
    // Reading a v1 tenant policy keeps its schema/mode intact so old task
    // snapshots can still be rebuilt exactly. The system route only writes
    // v2 payloads, whose default employee mode is auto.
    schemaVersion: sourceSchema,
    employeeOutput: normalizeRoute(source.employeeOutput, 'content', sourceSchema),
    activityPlan: normalizeRoute(source.activityPlan, 'activity_plan', sourceSchema),
    activityChecklist: normalizeRoute(source.activityChecklist, 'activity_checklist', sourceSchema),
    // 内部产出是否审阅完全由 employeeOutput 策略决定。外发、真实付费
    // 与不可逆动作保留的是“执行授权”安全门，不是内容审核，
    // 且这三条底线不可由客户端关闭。
    safeguards: {
      internalOutputReviewControlledByPolicy: true,
      externalActionOwnerAuthorization: true,
      paidActionOwnerAuthorization: true,
      irreversibleActionOwnerAuthorization: true,
    },
    configuredBy: configuredBy ?? (record(source.configuredBy) ? source.configuredBy : null),
    updatedAt: updatedAt ?? (typeof source.updatedAt === 'string' ? source.updatedAt : null),
  };
}

export function loadApprovalRoutingPolicy(tenantId = curTenant()) {
  return normalizeApprovalRoutingPolicy(
    getTenantConfig(APPROVAL_ROUTING_POLICY_KEY, DEFAULT_APPROVAL_ROUTING_POLICY, tenantId),
  );
}

function normalizedRiskLevel(value) {
  const risk = String(value || 'none').trim().toLowerCase();
  return risk || 'none';
}

function normalizedActorRole(value) {
  return String(value || '').trim().toLowerCase();
}

export function actorCanSelfAuthorize(value) {
  return SELF_AUTHORIZING_ROLES.has(normalizedActorRole(value));
}

function executionAuthorizationGuard({ externalAction = false, paidAction = false, irreversibleAction = false }) {
  if (externalAction) return 'external_action_owner_authorization';
  if (paidAction) return 'paid_action_owner_authorization';
  if (irreversibleAction) return 'irreversible_action_owner_authorization';
  return null;
}

function strictestEmployeeLevel(policyMode, requestedLevel, riskLevel) {
  if (policyMode === 'boss') return 'boss';
  // 只有“沿用岗位设置”才读取派活时锁定的岗位审批等级；这是 v1
  // 快照的兼容路径，v2 不再接受该模式。
  if (policyMode === LEGACY_EMPLOYEE_SETTING_MODE && String(requestedLevel || '') === 'boss') return 'boss';
  return 'ops_director';
}

function routeSteps({
  targetType,
  route,
  riskLevel,
  amount,
  requestedLevel,
  externalAction = false,
  paidAction = false,
  irreversibleAction = false,
}) {
  // 外发、真实付费和不可逆动作必须经老板执行授权，不能通过
  // 企业配置降级。该节点是动作授权，不表示内部内容需要审核。
  if (executionAuthorizationGuard({ externalAction, paidAction, irreversibleAction })) {
    return [{ level: 'boss', assignedReviewerId: null }];
  }

  if (targetType === 'content') {
    const risk = normalizedRiskLevel(riskLevel);
    // 测试阶段的 auto 是真正的“内部产出免审”：none/low/medium/high
    // 都不因文本风险标签创建待审节点。需要真实执行的动作已在上方收口。
    if (route.mode === 'auto') return [];
    const lowRisk = ['none', 'low'].includes(risk);
    // risk_based 仍按风险分流，便于企业主动切回审阅模式。
    // v1 employee_setting 始终保留原有人工节点语义。
    if (route.mode === 'risk_based' && lowRisk) return [];
    if (route.mode === 'risk_based' && risk === 'high') {
      return [{ level: 'boss', assignedReviewerId: null }];
    }
    const level = strictestEmployeeLevel(route.mode, requestedLevel, riskLevel);
    if (route.mode === LEGACY_EMPLOYEE_SETTING_MODE && String(requestedLevel || '') === 'boss') {
      return [{ level: 'boss', assignedReviewerId: null }];
    }
    return [{
      level,
      assignedReviewerId: level === 'boss' ? null : route.reviewerUserId,
    }];
  }

  if (route.mode === 'boss') return [{ level: 'boss', assignedReviewerId: null }];
  if (route.mode === 'manager') {
    return [{ level: 'ops_director', assignedReviewerId: route.reviewerUserId }];
  }
  if (route.mode === 'amount_threshold') {
    const ownerRequired = normalizedAmount(amount) >= Number(route.ownerAmountThreshold || 0);
    return ownerRequired
      ? [{ level: 'boss', assignedReviewerId: null }]
      : [{ level: 'ops_director', assignedReviewerId: route.reviewerUserId }];
  }
  return [
    { level: 'ops_director', assignedReviewerId: route.reviewerUserId },
    { level: 'boss', assignedReviewerId: null },
  ];
}

function routeReason({
  targetType,
  route,
  riskLevel,
  amount,
  externalAction = false,
  paidAction = false,
  irreversibleAction = false,
}) {
  const guard = executionAuthorizationGuard({ externalAction, paidAction, irreversibleAction });
  if (guard) return guard;
  if (targetType === 'activity_plan' && route.mode === 'amount_threshold') {
    return normalizedAmount(amount) >= Number(route.ownerAmountThreshold || 0)
      ? 'owner_amount_threshold_hit'
      : 'below_owner_amount_threshold';
  }
  if (targetType === 'content' && route.mode === 'auto') {
    return 'auto_internal_output';
  }
  if (targetType === 'content' && route.mode === 'risk_based'
    && ['none', 'low'].includes(normalizedRiskLevel(riskLevel))) {
    return 'risk_based_low_risk_auto';
  }
  if (targetType === 'content' && route.mode === 'employee_setting') return 'locked_employee_setting';
  return `owner_configured_${route.mode}`;
}

export function resolveApprovalRoute({
  targetType,
  riskLevel = 'none',
  amount = 0,
  requestedLevel = null,
  externalAction = false,
  paidAction = false,
  irreversibleAction = false,
  actorRole = null,
  actorUserId = null,
  policy = null,
} = {}) {
  const definition = TARGETS[targetType];
  if (!definition) throw policyError(`未知审批业务类型：${String(targetType || '')}`);
  const normalizedPolicy = normalizeApprovalRoutingPolicy(policy || DEFAULT_APPROVAL_ROUTING_POLICY);
  const route = normalizedPolicy[definition.key];
  const policySteps = routeSteps({
    targetType,
    route,
    riskLevel,
    amount,
    requestedLevel,
    externalAction,
    paidAction,
    irreversibleAction,
  });
  const policyReason = routeReason({
    targetType,
    route,
    riskLevel,
    amount,
    externalAction,
    paidAction,
    irreversibleAction,
  });
  // Boss/平台超管亲自发起，等价于该最高权限主体已经作出本次决定，
  // 不得再创建一张“请自己审批自己”的待办。角色只由服务端会话传入，
  // 不能从请求body读取。普通员工与管理层仍严格执行企业策略。
  const actorAuthorizationSatisfied = actorCanSelfAuthorize(actorRole)
    && policySteps.length > 0;
  const steps = actorAuthorizationSatisfied ? [] : policySteps;
  const reason = actorAuthorizationSatisfied
    ? `${normalizedActorRole(actorRole)}_self_authorized:${policyReason}`
    : policyReason;
  const requiresReview = steps.length > 0;
  const autoAdopt = targetType === 'content' && !requiresReview;
  const executionAuthorization = executionAuthorizationGuard({
    externalAction,
    paidAction,
    irreversibleAction,
  });
  const executionAuthorizationRequired = Boolean(executionAuthorization)
    && !actorAuthorizationSatisfied;
  const executionAuthorizationSatisfied = Boolean(executionAuthorization)
    && actorAuthorizationSatisfied;
  const contentReviewAuthorizationSatisfied = !executionAuthorization
    && actorAuthorizationSatisfied;
  const contentReviewRequired = requiresReview && !executionAuthorizationRequired;
  const snapshot = {
    schemaVersion: APPROVAL_WORKFLOW_SNAPSHOT_SCHEMA,
    policySchemaVersion: normalizedPolicy.schemaVersion,
    targetType,
    policyMode: route.mode,
    reason,
    policyReason,
    riskLevel: String(riskLevel || 'none'),
    requestedLevel: requestedLevel || null,
    externalAction: Boolean(externalAction),
    paidAction: Boolean(paidAction),
    irreversibleAction: Boolean(irreversibleAction),
    actorRole: actorAuthorizationSatisfied ? normalizedActorRole(actorRole) : null,
    actorUserId: actorAuthorizationSatisfied && Number.isSafeInteger(Number(actorUserId))
      && Number(actorUserId) > 0
      ? Number(actorUserId)
      : null,
    actorAuthorizationSatisfied,
    amount: targetType === 'activity_plan' ? normalizedAmount(amount) : null,
    ownerAmountThreshold: targetType === 'activity_plan' ? route.ownerAmountThreshold : null,
    steps: steps.map((step, index) => ({
      index,
      level: step.level,
      assignedReviewerId: step.assignedReviewerId ?? null,
    })),
    currentStep: 0,
    requiresReview,
    autoAdopt,
    decisionKind: executionAuthorizationSatisfied
      ? 'execution_self_authorized'
      : contentReviewAuthorizationSatisfied
        ? 'review_self_authorized'
        : executionAuthorizationRequired
      ? 'execution_authorization'
      : contentReviewRequired
        ? 'content_review'
        : 'auto_adopt',
    contentReviewRequired,
    executionAuthorizationRequired,
    executionAuthorizationSatisfied,
    contentReviewAuthorizationSatisfied,
    configuredBy: normalizedPolicy.configuredBy,
    configuredAt: normalizedPolicy.updatedAt,
    safeguards: normalizedPolicy.safeguards,
  };
  return {
    targetType,
    mode: route.mode,
    reason,
    steps,
    firstStep: steps[0] || null,
    requiresReview,
    autoAdopt,
    autoApprove: !requiresReview,
    contentReviewRequired,
    executionAuthorizationRequired,
    executionAuthorizationSatisfied,
    contentReviewAuthorizationSatisfied,
    actorAuthorizationSatisfied,
    snapshot,
  };
}

export function resolveTenantApprovalRoute(input, tenantId = curTenant()) {
  return resolveApprovalRoute({ ...input, policy: loadApprovalRoutingPolicy(tenantId) });
}

export function approvalRouteSummary(route) {
  const labels = (route?.steps || []).map(step => step.level === 'boss' ? '老板终审' : '负责人审批');
  if (route?.actorAuthorizationSatisfied) return 'Boss已自行授权，直接执行';
  if (route?.executionAuthorizationRequired) return '老板执行授权';
  return labels.length ? labels.join(' → ') : '内部产出自动采纳';
}

function normalizeSnapshotStep(step, index) {
  if (!record(step) || Number(step.index) !== index || !['boss', 'ops_director'].includes(step.level)) {
    throw policyError('审批规则快照步骤损坏', 'APPROVAL_WORKFLOW_SNAPSHOT_INVALID');
  }
  try {
    return {
      index,
      level: step.level,
      assignedReviewerId: optionalUserId(step.assignedReviewerId, `steps[${index}]`),
    };
  } catch {
    throw policyError('审批规则快照指定审批人不可信', 'APPROVAL_WORKFLOW_SNAPSHOT_INVALID');
  }
}

function snapshotSafeguardGeneration(safeguards) {
  if (!record(safeguards)) return null;
  // 兼容已落库的旧快照：当时 high 风险文本被当成全局老板审核门。
  if (safeguards.highRiskOwnerReview === true
    && safeguards.externalActionOwnerReview === true
    && safeguards.paidActionOwnerReview === true) {
    return 'legacy_review_guards';
  }
  if (safeguards.internalOutputReviewControlledByPolicy === true
    && safeguards.externalActionOwnerAuthorization === true
    && safeguards.paidActionOwnerAuthorization === true
    && safeguards.irreversibleActionOwnerAuthorization === true) {
    return 'execution_authorization_guards';
  }
  return null;
}

function legacyGuardReason(source) {
  if (normalizedRiskLevel(source.riskLevel) === 'high') return 'high_risk_owner_guard';
  if (source.externalAction === true) return 'external_action_owner_guard';
  if (source.paidAction === true) return 'paid_action_owner_guard';
  if (source.irreversibleAction === true) return 'irreversible_action_owner_guard';
  return null;
}

function assertSnapshotSemantics(source, steps) {
  if (!APPROVAL_ROUTING_SCHEMAS.has(source.policySchemaVersion)) {
    throw policyError('审批规则快照引用的策略版本不可信', 'APPROVAL_WORKFLOW_SNAPSHOT_INVALID');
  }
  const target = TARGETS[source.targetType];
  const policyMode = String(source.policyMode || '');
  if (!target?.modes.has(policyMode)) {
    throw policyError('审批规则快照的业务模式不匹配', 'APPROVAL_WORKFLOW_SNAPSHOT_INVALID');
  }
  const safeguardGeneration = snapshotSafeguardGeneration(source.safeguards);
  if (!safeguardGeneration) {
    throw policyError('审批规则快照安全底线被修改', 'APPROVAL_WORKFLOW_SNAPSHOT_INVALID');
  }

  const reviewerUserId = steps.find(step => step.level === 'ops_director')?.assignedReviewerId || null;
  const policyInput = {
    schemaVersion: source.policySchemaVersion,
    employeeOutput: {
      mode: source.policySchemaVersion === APPROVAL_ROUTING_SCHEMA_V1
        ? LEGACY_EMPLOYEE_SETTING_MODE
        : 'auto',
      reviewerUserId: null,
    },
    activityPlan: {
      mode: 'two_step',
      reviewerUserId: null,
      ownerAmountThreshold: DEFAULT_APPROVAL_ROUTING_POLICY.activityPlan.ownerAmountThreshold,
    },
    activityChecklist: { mode: 'two_step', reviewerUserId: null },
  };
  policyInput[target.key] = {
    mode: policyMode,
    reviewerUserId,
    ...(source.targetType === 'activity_plan'
      ? { ownerAmountThreshold: source.ownerAmountThreshold }
      : {}),
  };
  let expected;
  try {
    expected = resolveApprovalRoute({
      targetType: source.targetType,
      riskLevel: source.riskLevel,
      amount: source.amount,
      requestedLevel: source.requestedLevel,
      externalAction: source.externalAction === true,
      paidAction: source.paidAction === true,
      irreversibleAction: source.irreversibleAction === true,
      actorRole: source.actorRole || null,
      actorUserId: source.actorUserId || null,
      policy: policyInput,
    });
    // 旧快照的语义必须原样可重建，不能因当前 auto 改为全部内部
    // 产出免审就拒绝历史在途任务。旧 hard guard 只用于校验旧快照，
    // 不会参与任何新路由。
    const legacyReason = safeguardGeneration === 'legacy_review_guards'
      ? legacyGuardReason(source)
      : null;
    if (legacyReason) {
      expected = {
        ...expected,
        reason: legacyReason,
        steps: [{ level: 'boss', assignedReviewerId: null }],
        requiresReview: true,
        autoAdopt: false,
      };
    }
  } catch {
    throw policyError('审批规则快照无法重建可信路径', 'APPROVAL_WORKFLOW_SNAPSHOT_INVALID');
  }
  const expectedSteps = expected.steps.map((step, index) => ({ index, ...step }));
  // v1 snapshots predate the explicit outcome flags. Derive their old
  // review semantics instead of rejecting in-flight work during rollout.
  const snapshotRequiresReview = source.requiresReview === undefined
    ? steps.length > 0
    : source.requiresReview;
  const snapshotAutoAdopt = source.autoAdopt === undefined
    ? false
    : source.autoAdopt;
  if (source.policySchemaVersion === APPROVAL_ROUTING_SCHEMA
    && (typeof source.requiresReview !== 'boolean' || typeof source.autoAdopt !== 'boolean')) {
    throw policyError('审批规则快照结果标记不完整', 'APPROVAL_WORKFLOW_SNAPSHOT_INVALID');
  }
  if (safeguardGeneration === 'execution_authorization_guards') {
    const expectedExecutionAuthorization = expected.executionAuthorizationRequired === true;
    const expectedContentReview = expected.contentReviewRequired === true;
    const expectedDecisionKind = expected.snapshot.decisionKind;
    if (source.executionAuthorizationRequired !== expectedExecutionAuthorization
      || source.contentReviewRequired !== expectedContentReview
      || source.decisionKind !== expectedDecisionKind) {
      throw policyError('审批规则快照决策类型不一致', 'APPROVAL_WORKFLOW_SNAPSHOT_INVALID');
    }
    if (source.actorAuthorizationSatisfied === true) {
      if (expected.actorAuthorizationSatisfied !== true
        || source.executionAuthorizationSatisfied !== expected.executionAuthorizationSatisfied
        || source.contentReviewAuthorizationSatisfied !== expected.contentReviewAuthorizationSatisfied) {
        throw policyError('审批规则快照自授权证据不一致', 'APPROVAL_WORKFLOW_SNAPSHOT_INVALID');
      }
    }
  }
  if (expected.reason !== source.reason
    || expected.requiresReview !== snapshotRequiresReview
    || expected.autoAdopt !== snapshotAutoAdopt
    || JSON.stringify(expectedSteps) !== JSON.stringify(steps)) {
    throw policyError('审批规则快照语义与审批路径不一致', 'APPROVAL_WORKFLOW_SNAPSHOT_INVALID');
  }
}

export function parseApprovalWorkflowSnapshot(value) {
  if (value === undefined || value === null || value === '') return null;
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch {
      throw policyError('审批规则快照无法解析', 'APPROVAL_WORKFLOW_SNAPSHOT_INVALID');
    }
  }
  if (!record(source) || source.schemaVersion !== APPROVAL_WORKFLOW_SNAPSHOT_SCHEMA) {
    throw policyError('审批规则快照版本不可信', 'APPROVAL_WORKFLOW_SNAPSHOT_INVALID');
  }
  if (!TARGETS[source.targetType] || !Array.isArray(source.steps) || source.steps.length > 2) {
    throw policyError('审批规则快照内容不完整', 'APPROVAL_WORKFLOW_SNAPSHOT_INVALID');
  }
  if (source.steps.length === 0 && source.targetType !== 'content'
    && source.actorAuthorizationSatisfied !== true) {
    throw policyError('非数字员工产出不得免审', 'APPROVAL_WORKFLOW_SNAPSHOT_INVALID');
  }
  const steps = source.steps.map(normalizeSnapshotStep);
  assertSnapshotSemantics(source, steps);
  const currentStep = Number(source.currentStep);
  if (!Number.isSafeInteger(currentStep) || currentStep < 0
    || (steps.length > 0 ? currentStep >= steps.length : currentStep !== 0)) {
    throw policyError('审批规则快照当前步骤不正确', 'APPROVAL_WORKFLOW_SNAPSHOT_INVALID');
  }
  return { ...source, steps, currentStep };
}

export function approvalWorkflowTransition(value) {
  const snapshot = parseApprovalWorkflowSnapshot(value);
  if (!snapshot) return { kind: 'legacy', current: null, next: null, nextSnapshot: null };
  const current = snapshot.steps[snapshot.currentStep];
  const next = snapshot.steps[snapshot.currentStep + 1] || null;
  return {
    kind: 'configured',
    current,
    next,
    nextSnapshot: next ? { ...snapshot, currentStep: snapshot.currentStep + 1 } : null,
  };
}

export function approvalAssigneeAccess(approval, actor) {
  const assignedReviewerId = Number(approval?.assigned_reviewer_id || 0);
  if (!assignedReviewerId || Number(actor?.id) === assignedReviewerId || actor?.role === 'boss') {
    return { allowed: true, reason: '' };
  }
  return {
    allowed: false,
    reason: '该审批已由老板指定给其他负责人处理',
  };
}

function nullableText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function finiteNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

// 活动审批的关键业务事实快照。预算阈值只是其中一项；标题、时间、地点、
// 类型和目标也会改变审批判断，必须与方案正文一起锁定。
export function activityApprovalSubjectSnapshot(activity = {}) {
  return {
    activityId: Number(activity.id),
    title: nullableText(activity.title),
    type: nullableText(activity.type),
    date: nullableText(activity.date),
    location: nullableText(activity.location),
    budget: finiteNumber(activity.budget),
    targetJoin: finiteNumber(activity.target_join),
    targetDeal: finiteNumber(activity.target_deal),
  };
}

export function activityApprovalSubjectMatches(snapshot, activity) {
  if (!record(snapshot)) return false;
  return JSON.stringify(snapshot) === JSON.stringify(activityApprovalSubjectSnapshot(activity));
}
