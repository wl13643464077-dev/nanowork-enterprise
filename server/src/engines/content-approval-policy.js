const OWNER_REVIEW = new Set(['owner_review', '老板审核']);
const MANAGER_REVIEW = new Set([
  'manager_review',
  '管理者审核',
  'auto_draft',
  '自动形成草稿',
]);
const DEFAULT_REVIEW = new Set(['', 'default', '岗位默认']);
const DRAFT_REVIEW = new Set(['形成待审阅草稿']);
const AUTO_ADOPT = new Set(['auto']);

export const EMPLOYEE_MANAGEMENT_REVIEW_ROLES = Object.freeze([
  'boss',
  'ops_director',
  'manager',
  'admin',
]);

const EMPLOYEE_MANAGEMENT_REVIEW_ROLE_SET = new Set(EMPLOYEE_MANAGEMENT_REVIEW_ROLES);

export function normalizeEmployeeApprovalMode(value) {
  const mode = String(value ?? '').trim();
  if (OWNER_REVIEW.has(mode)) return 'owner_review';
  if (MANAGER_REVIEW.has(mode) || DRAFT_REVIEW.has(mode)) return 'manager_review';
  if (DEFAULT_REVIEW.has(mode)) return 'default';
  return mode ? 'unknown' : 'default';
}

/**
 * 员工产出的统一业务审阅权限。
 *
 * approvalMode 必须来自派活时锁定的任务/运行快照，而不是当前配置。
 * 损坏或未知模式按老板专审处理，避免脏数据把权限静默放宽。
 */
export function resolveEmployeeReviewAccess({
  role,
  approvalMode = 'default',
  approvalLevel = null,
  riskLevel = 'none',
} = {}) {
  const normalizedMode = normalizeEmployeeApprovalMode(approvalMode);
  const bossOnly = normalizedMode === 'owner_review'
    || normalizedMode === 'unknown'
    || String(approvalLevel || '') === 'boss'
    || String(riskLevel || '') === 'high';
  const allowedRoles = bossOnly ? ['boss'] : [...EMPLOYEE_MANAGEMENT_REVIEW_ROLES];
  const allowed = bossOnly
    ? String(role || '') === 'boss'
    : EMPLOYEE_MANAGEMENT_REVIEW_ROLE_SET.has(String(role || ''));
  return {
    allowed,
    allowedRoles,
    mode: normalizedMode,
    approvalLevel: bossOnly ? 'boss' : 'ops_director',
    reason: allowed
      ? ''
      : bossOnly
        ? '该任务派活时已锁定为老板终审，只能由老板处理'
        : '该任务派活时已锁定为管理层审核，只能由老板、运营总监、直属经理或管理员处理',
  };
}
const CONTENT_EMPLOYEE_APPROVAL_MODES = new Set(['岗位默认', '老板审核', '管理者审核', '形成待审阅草稿']);
const CONTENT_EMPLOYEE_REVIEWER_ROLES = new Set(EMPLOYEE_MANAGEMENT_REVIEW_ROLES);

export function resolveContentApprovalPolicy(approvalMode, risk = {}) {
  const mode = String(approvalMode || '岗位默认').trim();
  const ownerReview = OWNER_REVIEW.has(mode);
  const managerReview = MANAGER_REVIEW.has(mode);
  const isDefault = DEFAULT_REVIEW.has(mode);
  const autoAdopt = AUTO_ADOPT.has(mode);
  if (!ownerReview && !managerReview && !isDefault && !autoAdopt) {
    throw Object.assign(new Error(`未知的内容审批方式：${mode}`), { status: 400 });
  }

  const riskNeedsApproval = risk.needsApproval === true || ['medium', 'high'].includes(risk.level);
  const forced = ownerReview || managerReview;
  const needsApproval = forced || riskNeedsApproval;
  const approvalLevel = !needsApproval
    ? null
    : ownerReview || risk.level === 'high'
      ? 'boss'
      : 'ops_director';
  const hits = Array.isArray(risk.hits) ? risk.hits : [];
  const rulesHit = forced && !riskNeedsApproval
    ? [...hits, {
      code: 'CONTENT_EMPLOYEE_CONFIG_REVIEW',
      name: ownerReview ? '内容员工配置要求：老板审核' : `内容员工配置要求：${mode}`,
      level: 'none',
    }]
    : hits;

  return {
    approvalMode: mode,
    forced,
    needsApproval,
    approvalLevel,
    rulesHit,
  };
}

export function resolveContentEmployeeRunApprovalPolicy(config) {
  const requested = String(config?.approvalMode || config || '岗位默认').trim();
  const mode = CONTENT_EMPLOYEE_APPROVAL_MODES.has(requested) ? requested : '岗位默认';
  const access = resolveEmployeeReviewAccess({ approvalMode: mode });
  return {
    mode,
    level: mode === '岗位默认' ? null : access.approvalLevel,
    allowedRoles: access.allowedRoles,
    source: 'dispatch_snapshot',
  };
}

export function lockedContentEmployeeRunApprovalPolicy(snapshot) {
  const snapshottedMode = snapshot?.workConfig?.effective?.approvalMode;
  const explicitMode = snapshot?.approvalPolicy?.mode;
  const candidates = [snapshottedMode, explicitMode]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const normalized = candidates.map(normalizeEmployeeApprovalMode);
  // 两份不可变证据冲突时采用更严格等级；未知的非空值按老板终审，绝不静默放宽。
  const mode = normalized.includes('owner_review') || normalized.includes('unknown')
    ? '老板审核'
    : normalized.includes('manager_review')
      ? '管理者审核'
      : '岗位默认';
  return resolveContentEmployeeRunApprovalPolicy({ approvalMode: mode });
}

export function canReviewContentEmployeeRun(user, snapshot) {
  if (!CONTENT_EMPLOYEE_REVIEWER_ROLES.has(user?.role)) return false;
  return contentEmployeeRunReviewAccess(user, snapshot).allowed;
}

export function contentEmployeeRunReviewAccess(user, snapshot) {
  const policy = lockedContentEmployeeRunApprovalPolicy(snapshot);
  return resolveEmployeeReviewAccess({
    role: user?.role,
    approvalMode: policy.mode,
    approvalLevel: policy.level,
  });
}
