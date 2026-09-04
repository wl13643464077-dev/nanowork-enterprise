import { db, q, curTenant } from '../db.js';
import { contentAssetBaseValue, ensureContentAsset } from './content-assets.js';
import {
  assertContentAdoptable,
  assertContentDeliverable,
  loadContentDeliveryState,
  loadContentAdoptionAvailability,
} from './delivery-state.js';
import { releaseHeldCreditsByRefInCurrentTransaction } from './credits.js';
import { canAccessOwner } from './access.js';
import {
  EMPLOYEE_MANAGEMENT_REVIEW_ROLES,
  resolveEmployeeReviewAccess,
} from './content-approval-policy.js';
import {
  approvalAssigneeAccess,
  DEFAULT_APPROVAL_ROUTING_POLICY,
  loadApprovalRoutingPolicy,
  parseApprovalWorkflowSnapshot,
  resolveApprovalRoute,
} from './approval-routing-policy.js';
import { inspectStructuredReportFirstEvidence } from './restaurant-report-first-validation.js';
import { generationProgressFromSnapshot } from './employee-generation-progress.js';
import { publish } from './event-bus.js';

// 事务 COMMIT 之后才发布：事件只是刷新信号，绝不能先于权威落库到达浏览器。
function publishRestaurantTaskStatus(tenantId, task, status, extra = {}) {
  if (!task?.id) return;
  try {
    publish({
      tenantId,
      userIds: [task.created_by].filter(Boolean),
      roles: ['ops_director', 'manager'],
      type: 'task.status_changed',
      payload: {
        kind: 'restaurant',
        id: Number(task.id),
        status,
        title: task.title || '',
        employeeIdx: null,
        outputId: Number(task.output_id) || null,
        ...extra,
      },
    });
  } catch (error) {
    console.error('[restaurant-output-review] 实时事件发布失败:', error?.message || error);
  }
}

function publishApprovalDecided(tenantId, approval, status, actor, content = null) {
  if (!approval?.id) return;
  try {
    publish({
      tenantId,
      roles: ['ops_director', 'manager'],
      userIds: [approval.submitter_id, approval.assigned_reviewer_id, content?.creator_id].filter(Boolean),
      type: 'approval.decided',
      payload: {
        approvalId: Number(approval.id),
        status,
        targetType: approval.target_type,
        targetId: Number(approval.target_id) || null,
        title: approval.title || content?.title || '',
        reviewerId: Number(actor?.id) || null,
      },
    });
  } catch (error) {
    console.error('[restaurant-output-review] 实时事件发布失败:', error?.message || error);
  }
}

// Keep the review engine as the public facade used by output-analysis routes.
export { inspectRestaurantOutputAudit } from './restaurant-output-contract.js';

const REVIEW_ROLES = new Set(EMPLOYEE_MANAGEMENT_REVIEW_ROLES);
const HIGH_RISK_REVIEW_ROLES = new Set(['boss']);
const EMPLOYEE_APPROVAL_MODES = new Set(['owner_review', 'manager_review']);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function contentSnapshot(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  if (value == null || value === '') return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // handled below
  }
  throw httpError(409, '内容快照已损坏，不能记录自动采用的权威审批路径');
}

/**
 * A current structured report-first delivery deliberately has no parsed
 * restaurant JSON. Re-validate its immutable post-persist evidence instead
 * of treating that absence as a failed hard gate. Legacy pure-Markdown
 * snapshots did not bind the report to the structured contract, so they stay
 * fail-closed even in demo mode.
 */
export function inspectDemoReportFirstAutoAdoptEvidence({
  dataMode = 'live',
  content = null,
  task = null,
  executionEvidence = null,
} = {}) {
  return inspectStructuredReportFirstEvidence({
    dataMode,
    content,
    task,
    executionEvidence,
  });
}

function knowledgeCategory(content) {
  if (content.marshal_id) return '员工产出';
  const type = String(content.type || '');
  if (['招商文案'].includes(type)) return '招商政策';
  if (['短视频脚本', '朋友圈文案', '社群话题', '私聊邀约话术', '优惠话术', '复购礼赠文案', '合伙人每日素材包'].includes(type)) {
    return '话术案例';
  }
  return '品牌资料';
}

function parseApprovalRules(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function taskApprovalMode(task) {
  if (!task?.employee_config_snapshot) return null;
  try {
    const config = typeof task.employee_config_snapshot === 'string'
      ? JSON.parse(task.employee_config_snapshot)
      : task.employee_config_snapshot;
    const mode = String(config?.approvalMode || '').trim();
    if (!mode) return null;
    return EMPLOYEE_APPROVAL_MODES.has(mode) ? mode : 'unknown';
  } catch {
    return null;
  }
}

function approvalRuleMode(approval) {
  const modes = parseApprovalRules(approval?.rules_hit)
    .filter(rule => typeof rule === 'string' && rule.startsWith('employee_approval:'))
    .map(rule => rule.slice('employee_approval:'.length));
  if (modes.includes('owner_review')) return 'owner_review';
  if (modes.some(Boolean) && modes.some(mode => !EMPLOYEE_APPROVAL_MODES.has(mode))) return 'unknown';
  if (modes.includes('manager_review')) return 'manager_review';
  return null;
}

function lockedEmployeeApprovalMode(task, approval) {
  const fromTask = taskApprovalMode(task);
  const fromApproval = approvalRuleMode(approval);
  // 两份不可变证据冲突时按更严格的老板审核执行，不能因脏数据降权。
  if (fromTask === 'owner_review' || fromApproval === 'owner_review') return 'owner_review';
  if (fromTask === 'unknown' || fromApproval === 'unknown') return 'unknown';
  return fromTask || fromApproval;
}

export function contentOutputReviewAccess(actor, task, approval, content = null) {
  let workflow = null;
  try {
    workflow = parseApprovalWorkflowSnapshot(approval?.approval_policy_snapshot);
  } catch {
    return {
      allowed: false,
      allowedRoles: [],
      mode: 'unknown',
      approvalLevel: 'boss',
      scopeAllowed: false,
      ownerId: authoritativeContentOutputOwnerId(task, content),
      reason: '审批规则快照已损坏，不能处理该产出',
    };
  }
  if (workflow && workflow.targetType !== 'content') {
    return {
      allowed: false,
      allowedRoles: [],
      mode: 'unknown',
      approvalLevel: 'boss',
      scopeAllowed: false,
      ownerId: authoritativeContentOutputOwnerId(task, content),
      reason: '审批规则快照与员工产出类型不匹配，不能处理',
    };
  }
  const currentStep = workflow?.steps?.[workflow.currentStep] || null;
  if (currentStep && (currentStep.level !== approval?.approval_level
    || Number(currentStep.assignedReviewerId || 0) !== Number(approval?.assigned_reviewer_id || 0))) {
    return {
      allowed: false,
      allowedRoles: [],
      mode: 'unknown',
      approvalLevel: 'boss',
      scopeAllowed: false,
      ownerId: authoritativeContentOutputOwnerId(task, content),
      reason: '审批规则快照与当前审批节点不一致，不能处理',
    };
  }
  // 企业规则选择“沿用岗位”时才叠加任务旧配置；老板明确选择统一按风险、
  // 负责人或老板审批时，以派活时锁定的企业快照为权威，避免假配置。
  const mode = workflow && workflow.policyMode !== 'employee_setting'
    ? currentStep?.level === 'boss' ? 'owner_review' : 'manager_review'
    : lockedEmployeeApprovalMode(task, approval);
  const policy = resolveEmployeeReviewAccess({
    role: actor?.role,
    approvalMode: mode || 'default',
    approvalLevel: currentStep?.level || approval?.approval_level || null,
    riskLevel: content?.risk_level || approval?.risk_level || 'none',
  });
  const scope = contentOutputScopeAccess(actor, task, content);
  return {
    ...policy,
    allowed: policy.allowed && scope.allowed,
    scopeAllowed: scope.allowed,
    ownerId: scope.ownerId,
    reason: !policy.allowed ? policy.reason : scope.reason,
  };
}

/**
 * agent_tasks.created_by is the authoritative owner whenever an output belongs
 * to a dispatched restaurant-employee task. The content creator is only the
 * fallback for legacy/standalone content, so a mismatched creator_id cannot be
 * used to move another manager's task into the caller's review scope.
 */
export function authoritativeContentOutputOwnerId(task, content = null) {
  const taskOwnerId = Number(task?.created_by);
  if (Number.isSafeInteger(taskOwnerId) && taskOwnerId > 0) return taskOwnerId;
  const contentOwnerId = Number(content?.creator_id);
  return Number.isSafeInteger(contentOwnerId) && contentOwnerId > 0 ? contentOwnerId : null;
}

export function contentOutputScopeAccess(actor, task, content = null) {
  const ownerId = authoritativeContentOutputOwnerId(task, content);
  const allowed = canAccessOwner(actor, ownerId);
  return {
    allowed,
    ownerId,
    reason: allowed ? '' : '该产出不属于本人或直属团队，无权查看或审阅',
  };
}

function assertLockedEmployeeReviewer(actor, task, approval, content) {
  const access = contentOutputReviewAccess(actor, task, approval, content);
  const assignee = approvalAssigneeAccess(approval, actor);
  if (access.allowed && assignee.allowed) return { ...access, assigneeAllowed: true };
  if (!assignee.allowed) throw httpError(403, assignee.reason);
  throw httpError(403, access.reason);
}

function ensureContentKnowledge(content, tenantId) {
  assertContentDeliverable(content.id, {
    tenantId,
    action: '沉淀内容知识',
  });
  const existing = q.get(`SELECT id FROM kb_docs
    WHERE tenant_id=? AND source_type='content' AND source_id=?`, tenantId, content.id);
  if (existing) return { id: existing.id, existed: true };
  const inserted = q.run(`INSERT OR IGNORE INTO kb_docs(
    category,title,body,source_type,source_id,enabled
  ) VALUES(?,?,?,'content',?,1)`,
  knowledgeCategory(content), `[${content.type || '员工产出'}] ${content.title || content.topic || `内容#${content.id}`}`,
  typeof content.body === 'string' ? content.body : JSON.stringify(content.body || ''), content.id);
  const row = q.get(`SELECT id FROM kb_docs
    WHERE tenant_id=? AND source_type='content' AND source_id=?`, tenantId, content.id);
  if (!row) throw new Error('内容知识沉淀失败');
  return { id: row.id, existed: inserted.changes === 0 };
}

/**
 * Automatic employee adoption has no human approval row by design.  The
 * regular delivery gate intentionally rejects an AI row without an approved
 * approval, so the automatic command needs a narrower, technical preflight:
 * canonical provenance, output contract and the authoritative settled hold
 * must all be valid.  The route/approval checks remain separate and run before
 * this helper.
 */
function assertAutoAdoptTechnicalQuality(contentId, tenantId, action = '自动采用数字员工产出') {
  const state = loadContentDeliveryState(contentId, {
    tenantId,
    requireFlowStatus: false,
    requireBilling: true,
  });
  if (state?.provenance?.valid && state?.contract?.valid && state?.billing?.valid) {
    return state;
  }

  // report_first唯一放宽的是“没有可复核的岗位JSON”。任何其他契约冲突、
  // 来源问题或账务问题都不能借demo模式绕过。
  const invalidContractSignals = Array.isArray(state?.contract?.signals)
    ? state.contract.signals.filter(signal => signal?.valid !== true)
    : [];
  const reportFirstIsOnlyContractGap = state?.contract?.valid === false
    && invalidContractSignals.length > 0
    && invalidContractSignals.every(signal => signal?.source === 'restaurant_output_audit');
  let reportFirstDecision = null;
  if (
    state?.provenance?.valid &&
    state?.billing?.valid &&
    reportFirstIsOnlyContractGap
  ) {
    const content = q.get(`SELECT id,body,ai_mode FROM contents
      WHERE tenant_id=? AND id=?`, tenantId, contentId);
    const tasks = q.all(`SELECT t.id,t.title,t.type,t.requirement,t.employee_web_snapshot,
        s.employee_idx
      FROM agent_tasks t
      LEFT JOIN specialists s ON s.id=t.specialist_id
      WHERE t.tenant_id=? AND t.output_id=?
      ORDER BY t.id DESC LIMIT 2`, tenantId, contentId);
    const dataMode = q.get('SELECT data_mode FROM tenants WHERE id=?', tenantId)?.data_mode;
    if (content && tasks.length === 1) {
      reportFirstDecision = inspectDemoReportFirstAutoAdoptEvidence({
        dataMode,
        content,
        task: tasks[0],
        executionEvidence: tasks[0].employee_web_snapshot,
      });
      if (reportFirstDecision.valid) {
        return {
          ...state,
          contract: {
            ...state.contract,
            valid: true,
            reportFirst: true,
          },
        };
      }
    }
  }
  throw httpError(
    409,
    `${action}被阻止：${
      reportFirstDecision?.errors?.join('；') ||
      state?.reason ||
      '真实产出、岗位契约或账务证据不完整'
    }`,
  );
}

function taskRoutingPolicy(task, tenantId) {
  try {
    return task?.approval_routing_policy_snapshot
      ? JSON.parse(task.approval_routing_policy_snapshot)
      : loadApprovalRoutingPolicy(tenantId);
  } catch {
    throw httpError(409, '任务的审批规则快照已损坏，不能自动采纳');
  }
}

/**
 * Rebuild the immutable route before mutating an automatic output.  This keeps
 * direct callers fail-closed and ensures a v2 manager/boss or v1 legacy route
 * can never be smuggled through by merely passing an auto policy reason.
 */
function assertAutoAdoptRoute(task, content, tenantId, {
  actorRole = null,
  actorUserId = null,
} = {}) {
  const configMode = taskApprovalMode(task);
  const requestedLevel = configMode === 'owner_review'
    ? 'boss'
    : configMode === 'manager_review'
      ? 'ops_director'
      : null;
  let route;
  try {
    route = resolveApprovalRoute({
      targetType: 'content',
      riskLevel: content.risk_level || 'none',
      requestedLevel,
      actorRole,
      actorUserId,
      policy: taskRoutingPolicy(task, tenantId),
    });
  } catch (error) {
    throw httpError(409, `任务的审批规则无法重建，不能自动采纳：${error.message}`);
  }
  if (!route.autoAdopt || route.requiresReview) {
    throw httpError(409, '该产出按锁定审批规则需要人工审阅，不能自动采纳');
  }
  return route;
}

/**
 * Internal-only equivalents of the knowledge/asset registration calls used by
 * human approval.  They deliberately skip the human-approval delivery gate
 * because the caller has already proven the locked automatic route and the
 * technical quality/billing checks above; all writes remain in the caller's
 * transaction and preserve the same idempotency guarantees.
 */
function ensureAutoAdoptKnowledge(content, tenantId) {
  const existing = q.get(`SELECT id FROM kb_docs
    WHERE tenant_id=? AND source_type='content' AND source_id=?`, tenantId, content.id);
  if (existing) return { id: existing.id, existed: true };
  const inserted = q.run(`INSERT OR IGNORE INTO kb_docs(
    category,title,body,source_type,source_id,enabled
  ) VALUES(?,?,?,'content',?,1)`,
  knowledgeCategory(content), `[${content.type || '员工产出'}] ${content.title || content.topic || `内容#${content.id}`}`,
  typeof content.body === 'string' ? content.body : JSON.stringify(content.body || ''), content.id);
  const row = q.get(`SELECT id FROM kb_docs
    WHERE tenant_id=? AND source_type='content' AND source_id=?`, tenantId, content.id);
  if (!row) throw new Error('内容知识沉淀失败');
  return { id: row.id, existed: inserted.changes === 0 };
}

function ensureAutoAdoptAsset(content, { tenantId, creatorId = null, note = '' } = {}) {
  const contentId = Number(content.id);
  const baseValue = contentAssetBaseValue(content);
  const effectBonus = Math.max(0, Number(content.effect_leads || 0)) * 10;
  const minimumValue = baseValue + effectBonus;
  const publishCount = Number(q.get(`SELECT COUNT(*) n FROM content_publish_logs
    WHERE tenant_id=? AND content_id=?`, tenantId, contentId)?.n || 0);
  const ownerId = Number(creatorId || content.creator_id) || null;
  const assetName = content.title || content.topic || `内容#${contentId}`;
  const traceNote = note || `来源=内容生产仓；content#${contentId}；状态=${content.status || '-'}；效果按人工发布登记回流。`;
  const existing = q.get(`SELECT * FROM biz_assets
    WHERE tenant_id=? AND source_type='content' AND source_id=?
    ORDER BY id LIMIT 1`, tenantId, contentId);
  if (existing) {
    q.run(`UPDATE biz_assets
      SET name=COALESCE(NULLIF(name,''),?),
          value=CASE WHEN COALESCE(value,0)<? THEN ? ELSE value END,
          use_count=CASE WHEN COALESCE(use_count,0)<? THEN ? ELSE use_count END,
          creator_id=COALESCE(creator_id,?),
          note=CASE WHEN note IS NULL OR note='' THEN ? ELSE note END,
          updated_at=datetime('now','localtime')
      WHERE tenant_id=? AND id=?`,
    assetName, minimumValue, minimumValue, publishCount, publishCount,
    ownerId, traceNote, tenantId, existing.id);
    return {
      ...q.get(`SELECT * FROM biz_assets WHERE tenant_id=? AND id=?`, tenantId, existing.id),
      existed: true,
    };
  }
  const inserted = q.run(`INSERT INTO biz_assets(
    name,category,value,status,use_count,owner,source_type,source_id,creator_id,note
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
  assetName, '内容资产', minimumValue, '使用中', publishCount, '内容生产仓',
  'content', contentId, ownerId, traceNote);
  return q.get(`SELECT * FROM biz_assets WHERE tenant_id=? AND id=?`, tenantId, inserted.lastInsertRowid);
}

function ensureApproval(content, task, tenantId) {
  const existing = q.get(`SELECT * FROM approvals
    WHERE tenant_id=? AND target_type='content' AND target_id=?
    ORDER BY CASE status WHEN '待审核' THEN 0 ELSE 1 END, id DESC LIMIT 1`, tenantId, content.id);
  if (existing) return existing;
  const lockedMode = taskApprovalMode(task);
  const configuredLevel = lockedMode === 'owner_review'
    ? 'boss'
    : lockedMode === 'manager_review'
      ? 'ops_director'
      : null;
  let lockedRoutingPolicy;
  try {
    lockedRoutingPolicy = task?.approval_routing_policy_snapshot
      ? JSON.parse(task.approval_routing_policy_snapshot)
      : loadApprovalRoutingPolicy(tenantId);
  } catch {
    throw httpError(409, '任务的审批规则快照已损坏，不能补建审批单');
  }
  let approvalRoute = resolveApprovalRoute({
    targetType: 'content',
    riskLevel: content.risk_level || 'none',
    requestedLevel: configuredLevel,
    policy: lockedRoutingPolicy,
  });
  // This helper only repairs a historical output that is already in the
  // human-review flow.  If today's tenant policy is automatic, preserve that
  // historical intent with an explicit one-step review snapshot instead of
  // dereferencing an empty automatic route or fabricating a reviewer.
  if (!approvalRoute.requiresReview || !approvalRoute.firstStep) {
    const forcedMode = configuredLevel === 'boss' ? 'boss' : 'manager';
    approvalRoute = resolveApprovalRoute({
      targetType: 'content',
      riskLevel: content.risk_level || 'none',
      requestedLevel: configuredLevel || 'ops_director',
      policy: {
        ...DEFAULT_APPROVAL_ROUTING_POLICY,
        employeeOutput: { mode: forcedMode, reviewerUserId: null },
      },
    });
  }
  const inserted = q.run(`INSERT INTO approvals(
    target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,approval_level,
    assigned_reviewer_id,approval_policy_snapshot
  ) VALUES('content',?,?,?,?,?,'待审核',?,?,?,?)`,
  content.id, content.title || task?.title || `内容#${content.id}`, String(content.body || '').slice(0, 200),
  content.risk_level || 'none', JSON.stringify([
    'employee_output_review',
    'legacy_approval_repaired',
    ...(lockedMode ? [`employee_approval:${lockedMode}`] : []),
    `owner_policy:${approvalRoute.mode}`,
  ]),
  content.creator_id || task?.created_by || null,
  approvalRoute.firstStep.level,
  approvalRoute.firstStep.assignedReviewerId,
  JSON.stringify(approvalRoute.snapshot));
  return q.get(`SELECT * FROM approvals WHERE tenant_id=? AND id=?`, tenantId, inserted.lastInsertRowid);
}

function assertReviewer(actor, content) {
  if (!actor || !REVIEW_ROLES.has(actor.role)) {
    throw httpError(403, '餐饮数字员工产出仅老板、运营总监、直属经理或管理员可按任务审批策略审阅');
  }
}

function assertBillingReadyForHumanReview(contentId, tenantId, decision) {
  const adoption = loadContentAdoptionAvailability(contentId, { tenantId });
  if (['DELIVERY_BILLING_MISSING', 'DELIVERY_BILLING_UNSETTLED'].includes(adoption.state?.code)) {
    if (decision === 'reject' && adoption.canReject) return;
    throw httpError(
      409,
      `该产出${adoption.reason}；当前不进入人工审阅，请先完成账务对账`,
    );
  }
}

const SUCCESS_PROGRESS_LABEL = '交付、证据与费用已完成归档';

/**
 * Merge the successful terminal state into the authoritative execution
 * evidence without replacing its web, outputContract, providerAttempt or
 * leakage audit. Temporary heartbeat rows remain guarded by the stricter
 * status='生成中' AND output_id IS NULL condition in the marshal route.
 */
export function terminalRestaurantExecutionEvidence(value, {
  at = new Date().toISOString(),
} = {}) {
  let snapshot;
  try {
    snapshot = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || snapshot.kind !== 'restaurant_employee_execution_evidence') {
    return null;
  }
  const current = generationProgressFromSnapshot(snapshot) || {
    receivedChars: 0,
    attemptNumber: 1,
    phase: 'acquire',
    steps: [],
  };
  if (snapshot.generationProgress?.currentStage === 'done'
    && Number(snapshot.generationProgress?.percent) === 100) return snapshot;
  const timestamp = Number.isFinite(Date.parse(at))
    ? new Date(at).toISOString()
    : new Date().toISOString();
  const doneStep = {
    stage: 'done',
    kind: 'done',
    label: SUCCESS_PROGRESS_LABEL,
    status: 'done',
    at: timestamp,
  };
  const previousSteps = Array.isArray(current.steps) ? current.steps : [];
  const steps = previousSteps.at(-1)?.stage === 'done'
    ? [...previousSteps.slice(0, -1), doneStep]
    : [...previousSteps, doneStep].slice(-30);
  return {
    ...snapshot,
    generationProgress: {
      receivedChars: Number(current.receivedChars || 0),
      lastActivityAt: timestamp,
      attemptNumber: Number(current.attemptNumber || 1),
      phase: current.phase === 'repair' ? 'repair' : 'acquire',
      currentStage: 'done',
      currentLabel: SUCCESS_PROGRESS_LABEL,
      percent: 100,
      steps,
    },
  };
}

function completeAgentTaskInCurrentTransaction(task, tenantId) {
  const completedEvidence = terminalRestaurantExecutionEvidence(
    task?.employee_web_snapshot,
  );
  if (!completedEvidence) {
    // Historical and non-restaurant content tasks predate the structured
    // execution snapshot. Preserve their established adoption path without
    // fabricating evidence; only authoritative restaurant evidence receives
    // the terminal progress merge below.
    q.run(`UPDATE agent_tasks SET status='已完成'
      WHERE tenant_id=? AND id=?`, tenantId, task.id);
    return null;
  }
  q.run(`UPDATE agent_tasks
    SET status='已完成',employee_web_snapshot=?
    WHERE tenant_id=? AND id=?`,
  JSON.stringify(completedEvidence), tenantId, task.id);
  return completedEvidence;
}

/**
 * Auto-adopt an internal employee output after its authoritative hold
 * has settled. This is deliberately separate from decideContentOutput(): an
 * automatic policy decision must not forge a human reviewer or an approval row.
 * The caller is responsible for resolving the locked tenant policy first; this
 * command re-checks the immutable business boundaries before mutating state.
 */
export function autoAdoptContentOutput({
  outputId,
  taskId,
  tenantId = curTenant(),
  policyReason = 'owner_policy:auto',
  actorRole = null,
  actorUserId = null,
}) {
  const contentId = Number(outputId);
  const lockedTaskId = Number(taskId);
  if (!Number.isSafeInteger(contentId) || contentId < 1
    || !Number.isSafeInteger(lockedTaskId) || lockedTaskId < 1) {
    throw httpError(400, '自动采纳缺少有效的任务或产出编号');
  }
  const content = q.get(`SELECT * FROM contents WHERE tenant_id=? AND id=?`, tenantId, contentId);
  const task = q.get(`SELECT * FROM agent_tasks
    WHERE tenant_id=? AND id=? AND output_id=?`, tenantId, lockedTaskId, contentId);
  if (!content || !task) throw httpError(404, '自动采纳的任务与产出不存在或不匹配');
  assertAutoAdoptRoute(task, content, tenantId, { actorRole, actorUserId });
  const approvals = q.all(`SELECT id,status FROM approvals
    WHERE tenant_id=? AND target_type='content' AND target_id=?`, tenantId, contentId);
  if (approvals.length) {
    throw httpError(409, '该产出已经进入人工审批，不能再自动采纳');
  }
  assertAutoAdoptTechnicalQuality(contentId, tenantId);

  db.exec('BEGIN IMMEDIATE');
  try {
    const currentContent = q.get(`SELECT * FROM contents WHERE tenant_id=? AND id=?`, tenantId, contentId);
    const currentTask = q.get(`SELECT * FROM agent_tasks
      WHERE tenant_id=? AND id=? AND output_id=?`, tenantId, lockedTaskId, contentId);
    if (!currentContent || !currentTask) throw httpError(404, '自动采纳对象在执行期间发生变化');
    const inTransactionApprovals = q.all(`SELECT id FROM approvals
      WHERE tenant_id=? AND target_type='content' AND target_id=?`, tenantId, contentId);
    if (inTransactionApprovals.length) throw httpError(409, '该产出已由其他流程进入人工审批');
    if (currentContent.status === '已驳回' || currentTask.status === '已驳回') {
      throw httpError(409, '该产出已经驳回，不能自动改判');
    }
    const currentRoute = assertAutoAdoptRoute(
      currentTask,
      currentContent,
      tenantId,
      { actorRole, actorUserId },
    );
    assertAutoAdoptTechnicalQuality(contentId, tenantId);

    const nextContentSnapshot = {
      ...contentSnapshot(currentContent.snapshot_json),
      approvalRouting: currentRoute.snapshot,
    };
    q.run(`UPDATE contents SET status='可使用',snapshot_json=?
      WHERE tenant_id=? AND id=? AND status<>'已发布'`,
    JSON.stringify(nextContentSnapshot), tenantId, contentId);
    completeAgentTaskInCurrentTransaction(currentTask, tenantId);
    const deliverable = q.get(`SELECT * FROM contents WHERE tenant_id=? AND id=?`, tenantId, contentId);
    const knowledge = ensureAutoAdoptKnowledge(deliverable, tenantId);
    const asset = ensureAutoAdoptAsset(deliverable, {
      tenantId,
      creatorId: deliverable.creator_id || currentTask.created_by,
      note: `数字员工内部产出按企业锁定策略自动采用；${String(policyReason).slice(0, 120)}；kb#${knowledge.id}；未创建内容审核，未执行对外发布。`,
    });
    db.exec('COMMIT');
    publishRestaurantTaskStatus(tenantId, currentTask, '已完成', { adoption: 'auto' });
    return {
      ok: true,
      autoAdopted: true,
      approvalId: null,
      contentId,
      taskId: lockedTaskId,
      knowledgeId: knowledge.id,
      assetId: asset.id,
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
}

/**
 * 餐饮数字员工与普通内容审批共用的权威决策命令。
 * 不自行记录操作日志，调用入口可使用各自的模块名称记录一次用户动作。
 */
export function decideContentOutput({
  outputId,
  approvalId = null,
  actor,
  decision,
  reason = '',
  tenantId = curTenant(),
}) {
  if (!['adopt', 'reject'].includes(decision)) throw httpError(400, '请选择采纳或驳回');
  const reviewReason = typeof reason === 'string' ? reason.trim() : '';
  if (decision === 'reject' && !reviewReason) throw httpError(400, '驳回必须填写理由');
  if (reviewReason.length > 1000) throw httpError(400, '审阅意见最长1000字');

  const content = q.get(`SELECT * FROM contents WHERE tenant_id=? AND id=?`, tenantId, outputId);
  if (!content) throw httpError(404, '待人工审阅内容不存在');
  assertReviewer(actor, content);

  const task = q.get(`SELECT * FROM agent_tasks
    WHERE tenant_id=? AND output_id=? ORDER BY id DESC LIMIT 1`, tenantId, content.id);
  // Authorization must run before provenance/billing preflight. Otherwise an
  // unauthorized reviewer could distinguish missing, held and settled internal
  // states from the 409 response instead of receiving the required 403.
  const authorizationApproval = approvalId
    ? q.get(`SELECT * FROM approvals
      WHERE tenant_id=? AND id=? AND target_type='content' AND target_id=?`,
    tenantId, approvalId, content.id)
    : q.get(`SELECT * FROM approvals
      WHERE tenant_id=? AND target_type='content' AND target_id=?
      ORDER BY CASE status WHEN '待审核' THEN 0 ELSE 1 END, id DESC LIMIT 1`,
    tenantId, content.id);
  if (approvalId && !authorizationApproval) {
    throw httpError(404, '审批不存在或与产出不匹配');
  }
  assertLockedEmployeeReviewer(actor, task, authorizationApproval, content);
  const delivery = loadContentDeliveryState(content.id, {
    tenantId,
    requireFlowStatus: false,
    requireBilling: false,
  });
  if (delivery.code === 'DELIVERY_SUPERSEDED') {
    const error = httpError(
      409,
      `${delivery.reason}；旧版审批仅保留审计，不能再采纳或驳回`,
    );
    error.code = delivery.code;
    error.supersededBy = delivery.supersededBy || null;
    throw error;
  }
  // 账务终态是人工审核的前置条件，不只是“采纳”的前置条件。
  // 待对账时驳回会改写业务结论并释放占扣，因此两种审核决策都必须拦截。
  assertBillingReadyForHumanReview(content.id, tenantId, decision);
  if (decision === 'adopt') {
    const approved = q.get(`SELECT id FROM approvals
      WHERE tenant_id=? AND target_type='content' AND target_id=? AND status='已通过'
      ORDER BY id DESC LIMIT 1`, tenantId, content.id);
    const pending = q.get(`SELECT id FROM approvals
      WHERE tenant_id=? AND target_type='content' AND target_id=? AND status='待审核'
      ORDER BY id DESC LIMIT 1`, tenantId, content.id);
    if (approved && (content.status === '待审核' || pending)) {
      throw httpError(409, '该稿件已经人工审阅通过，不能原地退回审阅或再次处理；请新建修订稿');
    }
    assertContentAdoptable(content.id, {
      tenantId,
      action: '采纳员工产出',
    });
  }

  const expectedApprovalStatus = decision === 'adopt' ? '已通过' : '已驳回';
  const expectedContentStatuses = decision === 'adopt' ? ['可使用', '已发布'] : ['已驳回'];
  const oppositeContentStatuses = decision === 'adopt' ? ['已驳回'] : ['可使用', '已发布'];
  if (oppositeContentStatuses.includes(content.status)) {
    throw httpError(409, '该产出已经按相反结论处理，不能重复改判');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const approval = approvalId
      ? q.get(`SELECT * FROM approvals
        WHERE tenant_id=? AND id=? AND target_type='content' AND target_id=?`, tenantId, approvalId, content.id)
      : ensureApproval(content, task, tenantId);
    if (!approval) throw httpError(404, '审批不存在或与产出不匹配');
    assertLockedEmployeeReviewer(actor, task, approval, content);
    if (approval.status !== '待审核' && approval.status !== expectedApprovalStatus) {
      throw httpError(409, '该审批已经按相反结论处理，不能重复改判');
    }

    const alreadyReviewed = approval.status === expectedApprovalStatus
      && expectedContentStatuses.includes(content.status)
      && (!task || task.status === (decision === 'adopt' ? '已完成' : '已驳回'));

    const billingRelease = decision === 'reject' && task
      ? releaseHeldCreditsByRefInCurrentTransaction({
          tenantId,
          refType: 'agent_task',
          refId: task.id,
          note: `餐饮数字员工任务#${task.id}经人工驳回，未采纳产出，预授权全额退回`,
        })
      : null;

    q.run(`UPDATE approvals
      SET status=?,reviewer_id=COALESCE(reviewer_id,?),reason=COALESCE(reason,?),
          decided_at=COALESCE(decided_at,datetime('now','localtime'))
      WHERE tenant_id=? AND target_type='content' AND target_id=? AND status='待审核'`,
    expectedApprovalStatus, actor.id, reviewReason || null, tenantId, content.id);
    q.run(`UPDATE contents SET status=? WHERE tenant_id=? AND id=?`,
      decision === 'adopt' ? (content.status === '已发布' ? '已发布' : '可使用') : '已驳回', tenantId, content.id);
    if (decision === 'adopt') {
      if (task) completeAgentTaskInCurrentTransaction(task, tenantId);
    } else {
      q.run(`UPDATE agent_tasks SET status='已驳回'
        WHERE tenant_id=? AND output_id=?`, tenantId, content.id);
    }

    let knowledge = null;
    let asset = null;
    if (decision === 'adopt') {
      const deliverableContent = q.get(`SELECT * FROM contents WHERE tenant_id=? AND id=?`,
        tenantId, content.id);
      assertContentDeliverable(deliverableContent.id, {
        tenantId,
        action: '完成产出采纳',
      });
      knowledge = ensureContentKnowledge(deliverableContent, tenantId);
      asset = ensureContentAsset(deliverableContent, {
        tenantId,
        creatorId: content.creator_id,
        note: `内容审批通过后登记；approval#${approval.id}；kb#${knowledge.id}；未执行对外发布。`,
      });
    }
    db.exec('COMMIT');
    if (!alreadyReviewed) {
      publishApprovalDecided(tenantId, approval, expectedApprovalStatus, actor, content);
      if (task) publishRestaurantTaskStatus(tenantId, task, decision === 'adopt' ? '已完成' : '已驳回', { adoption: decision });
    }
    return {
      ok: true,
      alreadyReviewed,
      approvalId: approval.id,
      contentId: content.id,
      taskId: task?.id || null,
      knowledgeId: knowledge?.id || null,
      assetId: asset?.id || null,
      billingRelease,
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
}

export const CONTENT_OUTPUT_REVIEW_ROLES = Object.freeze([...REVIEW_ROLES]);
export const HIGH_RISK_CONTENT_OUTPUT_REVIEW_ROLES = Object.freeze([...HIGH_RISK_REVIEW_ROLES]);
