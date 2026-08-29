export const CONTENT_HANDLER_APPROVAL_AUDIT_SCHEMA =
  'nanowork.content-handler-approval-audit/1';

export const CONTENT_HANDLER_APPROVAL_CODES = Object.freeze([
  'pick',
  'review',
  'auto',
  'force',
]);

const APPROVAL_CODE_SET = new Set(CONTENT_HANDLER_APPROVAL_CODES);
const HUMAN_REVIEW_ROLES = new Set(['boss', 'ops_director', 'manager', 'admin', 'platform_super']);
const FINAL_REVIEW_ROLES = new Set(['boss', 'admin', 'platform_super']);
const ACTIONS = new Set(['adopt', 'reject', 'handoff', 'external_publish']);

function clean(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

function instant(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError('now必须返回有效时间');
  return date.toISOString();
}

function boundaryCode(boundary) {
  if (typeof boundary === 'string') return clean(boundary, 32);
  return clean(boundary?.code, 32);
}

function candidateId(candidate) {
  if (candidate === null || candidate === undefined) return '';
  if (['string', 'number'].includes(typeof candidate)) return clean(candidate, 200);
  if (typeof candidate !== 'object' || Array.isArray(candidate)) return '';
  for (const key of ['candidateId', 'id', 'key', 'slug']) {
    const value = clean(candidate[key], 200);
    if (value) return value;
  }
  return '';
}

function indexedCandidates(candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates.map((candidate, index) => ({
    index,
    id: candidateId(candidate),
  }));
}

function selectedCandidate(selection, candidates) {
  if (selection === null || selection === undefined || selection === '') return null;
  let index = null;
  let id = '';
  if (Number.isInteger(selection)) {
    index = selection;
  } else if (typeof selection === 'string') {
    id = clean(selection, 200);
  } else if (typeof selection === 'object' && !Array.isArray(selection)) {
    const hasIndex = selection.candidateIndex !== undefined && selection.candidateIndex !== null;
    const hasId = selection.candidateId !== undefined && selection.candidateId !== null;
    if (hasIndex === hasId) return null;
    if (hasIndex && Number.isInteger(selection.candidateIndex)) index = selection.candidateIndex;
    if (hasId) id = clean(selection.candidateId, 200);
  }

  const match = index !== null
    ? candidates.find(candidate => candidate.index === index)
    : id
      ? candidates.find(candidate => candidate.id === id)
      : null;
  if (!match) return null;
  return { candidateId: match.id || null, candidateIndex: match.index };
}

function actorEvidence(actor, automated) {
  if (automated) {
    return {
      actorType: 'system',
      actorId: null,
      actorName: clean(actor?.name || 'system', 120),
      actorRole: clean(actor?.role || 'system', 64),
    };
  }
  return {
    actorType: 'human',
    actorId: Number.isInteger(Number(actor?.id)) && Number(actor?.id) > 0
      ? Number(actor.id)
      : null,
    actorName: clean(actor?.name, 120),
    actorRole: clean(actor?.role, 64),
  };
}

function controlsFor(code) {
  return {
    candidateSelectionRequired: code === 'pick',
    humanReviewRequired: code === 'pick' || code === 'review' || code === 'force',
    forcedFinalReview: code === 'force',
    automaticHandoffAllowed: code === 'auto',
    automaticBusinessAdoptionAllowed: false,
    externalPublishAllowed: false,
  };
}

function outcome({
  allowed,
  code,
  message,
  status = 409,
  boundary,
  action,
  actor,
  automated,
  selection,
  now,
  runId,
  handlerId,
  workflowMode,
}) {
  const approvalCode = boundaryCode(boundary);
  return Object.freeze({
    allowed,
    code,
    message,
    status: allowed ? 200 : status,
    selection: selection ? Object.freeze({ ...selection }) : null,
    auditRecord: Object.freeze({
      schemaVersion: CONTENT_HANDLER_APPROVAL_AUDIT_SCHEMA,
      source: 'locked_handler_evidence',
      runId: runId === undefined || runId === null ? null : clean(runId, 120),
      handlerId: clean(handlerId || boundary?.handlerId, 200) || null,
      approvalCode: approvalCode || null,
      action: clean(action, 64) || null,
      outcome: allowed ? 'allowed' : 'denied',
      reasonCode: code,
      reason: message,
      automated: automated === true,
      workflowMode: clean(workflowMode, 32) || null,
      actor: Object.freeze(actorEvidence(actor, automated)),
      selection: selection ? Object.freeze({ ...selection }) : null,
      controls: Object.freeze(controlsFor(approvalCode)),
      decidedAt: instant(now),
    }),
  });
}

/**
 * Evaluate the immutable handler approval boundary before a run may cross into
 * handoff, adoption, rejection, or publishing. This function is intentionally
 * side-effect free: callers persist auditRecord in the same transaction as the
 * state transition.
 */
export function evaluateContentHandlerApprovalBoundary({
  boundary,
  action,
  actor = null,
  automated = false,
  candidates = [],
  selection = null,
  now = () => new Date(),
  runId = null,
  handlerId = null,
  workflowMode = null,
} = {}) {
  const approvalCode = boundaryCode(boundary);
  const normalizedAction = clean(action, 64);
  const deny = (code, message, status = 409, selected = null) => outcome({
    allowed: false,
    code,
    message,
    status,
    boundary,
    action: normalizedAction,
    actor,
    automated,
    selection: selected,
    now,
    runId,
    handlerId,
    workflowMode,
  });
  const allow = (code, message, selected = null) => outcome({
    allowed: true,
    code,
    message,
    boundary,
    action: normalizedAction,
    actor,
    automated,
    selection: selected,
    now,
    runId,
    handlerId,
    workflowMode,
  });

  if (!APPROVAL_CODE_SET.has(approvalCode)) {
    return deny(
      'CONTENT_HANDLER_APPROVAL_BOUNDARY_INVALID',
      '任务缺少可信的handler审批边界，已按最严格规则阻断',
    );
  }
  if (!ACTIONS.has(normalizedAction)) {
    return deny('CONTENT_HANDLER_APPROVAL_ACTION_INVALID', '未知的handler审批动作', 400);
  }
  if (normalizedAction === 'external_publish') {
    return deny(
      'CONTENT_HANDLER_EXTERNAL_PUBLISH_FORBIDDEN',
      '内容员工handler只能生成和内部交接，不能执行对外发布',
    );
  }

  const actorInfo = actorEvidence(actor, automated);
  if (automated) {
    if (approvalCode === 'auto' && normalizedAction === 'handoff'
      && clean(workflowMode, 32) !== 'manual') {
      return allow(
        'CONTENT_HANDLER_AUTO_HANDOFF_ALLOWED',
        '自动岗位产出只允许交接到下一内部环节，尚未形成业务采纳',
      );
    }
    if (normalizedAction === 'handoff'
      && ['fullauto', 'autopilot'].includes(clean(workflowMode, 32))
      && approvalCode !== 'force') {
      return allow(
        'CONTENT_HANDLER_WORKFLOW_AUTO_HANDOFF_ALLOWED',
        '流水线托管模式允许该工位自动内部交接，尚未形成业务采纳',
      );
    }
    return deny(
      normalizedAction === 'adopt'
        ? 'CONTENT_HANDLER_AUTO_FINAL_ADOPTION_FORBIDDEN'
        : 'CONTENT_HANDLER_HUMAN_REVIEW_REQUIRED',
      normalizedAction === 'adopt'
        ? '自动流程不能执行最终业务采纳，必须转人工审阅'
        : '该审批动作必须由有权限的人类审阅人处理',
    );
  }

  if (!actorInfo.actorId || !actorInfo.actorRole) {
    return deny(
      'CONTENT_HANDLER_HUMAN_REVIEW_REQUIRED',
      '缺少可落账的人类审阅人身份，不能跨越handler审批边界',
      403,
    );
  }

  const allowedRoles = approvalCode === 'force' ? FINAL_REVIEW_ROLES : HUMAN_REVIEW_ROLES;
  if (!allowedRoles.has(actorInfo.actorRole)) {
    return deny(
      approvalCode === 'force'
        ? 'CONTENT_HANDLER_FORCE_FINAL_REVIEW_ROLE_REQUIRED'
        : 'CONTENT_HANDLER_REVIEW_ROLE_FORBIDDEN',
      approvalCode === 'force'
        ? '该岗位强制最终人工终审，只能由老板或管理员处理'
        : '当前账号没有内容员工审批权限',
      403,
    );
  }

  if (approvalCode === 'pick' && normalizedAction === 'adopt') {
    const indexed = indexedCandidates(candidates);
    if (!indexed.length) {
      return deny(
        'CONTENT_HANDLER_PICK_CANDIDATES_MISSING',
        '该岗位必须从候选结果中选择，但运行快照没有可信候选项',
      );
    }
    const selected = selectedCandidate(selection, indexed);
    if (!selected) {
      return deny(
        'CONTENT_HANDLER_PICK_SELECTION_INVALID',
        '采纳前必须按候选ID或候选索引选择一个合法结果',
      );
    }
    return allow(
      'CONTENT_HANDLER_PICK_SELECTION_RECORDED',
      '已记录人工候选选择，可进入业务采纳事务',
      selected,
    );
  }

  if (normalizedAction === 'adopt') {
    return allow(
      approvalCode === 'force'
        ? 'CONTENT_HANDLER_FORCE_FINAL_REVIEW_RECORDED'
        : approvalCode === 'review'
          ? 'CONTENT_HANDLER_HUMAN_REVIEW_RECORDED'
          : 'CONTENT_HANDLER_HUMAN_ADOPTION_RECORDED',
      approvalCode === 'force'
        ? '已记录老板或管理员最终人工终审，可进入业务采纳事务'
        : '已记录人类审阅，可进入业务采纳事务',
    );
  }

  return allow(
    normalizedAction === 'reject'
      ? 'CONTENT_HANDLER_HUMAN_REJECTION_RECORDED'
      : 'CONTENT_HANDLER_HUMAN_HANDOFF_RECORDED',
    normalizedAction === 'reject'
      ? '已记录人类驳回决定'
      : '已记录人类内部交接决定',
  );
}

export function assertContentHandlerApprovalBoundary(input) {
  const result = evaluateContentHandlerApprovalBoundary(input);
  if (result.allowed) return result;
  const error = Object.assign(new Error(result.message), {
    name: 'ContentHandlerApprovalBoundaryError',
    code: result.code,
    status: result.status,
    auditRecord: result.auditRecord,
  });
  throw error;
}
