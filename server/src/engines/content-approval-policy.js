const OWNER_REVIEW = new Set(['owner_review', '老板审核']);
const MANAGER_REVIEW = new Set([
  'manager_review',
  '管理者审核',
  'auto_draft',
  '自动形成草稿',
]);
const DEFAULT_REVIEW = new Set(['', 'default', '岗位默认']);

export function resolveContentApprovalPolicy(approvalMode, risk = {}) {
  const mode = String(approvalMode || '岗位默认').trim();
  const ownerReview = OWNER_REVIEW.has(mode);
  const managerReview = MANAGER_REVIEW.has(mode);
  const isDefault = DEFAULT_REVIEW.has(mode);
  if (!ownerReview && !managerReview && !isDefault) {
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
