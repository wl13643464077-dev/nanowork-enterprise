import { InputNumber, Select, Tag } from 'antd';

import { ROLE_MAP } from './SystemPrimitives';
import './SystemGovernance.css';

export type ApprovalRouteKey = 'employeeOutput' | 'activityPlan' | 'activityChecklist';

const APPROVAL_RULE_DEFINITIONS: Record<
  ApprovalRouteKey,
  {
    title: string;
    description: string;
    modes: { value: string; label: string; description: string }[];
  }
> = {
  employeeOutput: {
    title: '数字员工产出',
    description: '适用于餐饮和内容数字员工新提交的交付物。',
    modes: [
      {
        value: 'auto',
        label: '内部产出自动采用',
        description:
          'none / low / medium / high 内部产出通过质量门与账务门后自动采用；外发、真实付费和不可逆动作仍须老板执行授权。',
      },
      { value: 'risk_based', label: '按风险分流', description: '普通风险由负责人审批，高风险固定由老板终审。' },
      { value: 'manager', label: '负责人单级审批', description: '普通产出交给负责人一次审批。' },
      { value: 'boss', label: '老板统一终审', description: '该类产出全部直接进入老板终审。' },
    ],
  },
  activityPlan: {
    title: '活动方案',
    description: '适用于新提交的活动策划、预算和执行方案。',
    modes: [
      { value: 'two_step', label: '负责人初审 → 老板终审', description: '先由负责人核对，再由老板做最终决定。' },
      { value: 'manager', label: '负责人单级审批', description: '未触发安全底线的方案由负责人一次审批。' },
      { value: 'boss', label: '老板统一终审', description: '所有新活动方案直接由老板审批。' },
      { value: 'amount_threshold', label: '按金额阈值分流', description: '低于阈值由负责人审批，达到阈值转老板终审。' },
    ],
  },
  activityChecklist: {
    title: '活动待确认事项',
    description: '适用于物料、食安、人员分工等活动执行清单。',
    modes: [
      { value: 'two_step', label: '负责人初审 → 老板终审', description: '负责人确认后，再由老板终审。' },
      { value: 'manager', label: '负责人单级审批', description: '未触发安全底线的事项由负责人一次审批。' },
      { value: 'boss', label: '老板统一终审', description: '所有新待确认事项直接由老板审批。' },
    ],
  },
};

export const approvalPolicyPayload = (policy: any) => ({
  employeeOutput: {
    mode: policy?.employeeOutput?.mode,
    reviewerUserId: policy?.employeeOutput?.reviewerUserId ?? null,
  },
  activityPlan: {
    mode: policy?.activityPlan?.mode,
    reviewerUserId: policy?.activityPlan?.reviewerUserId ?? null,
    ownerAmountThreshold: Number(policy?.activityPlan?.ownerAmountThreshold ?? 0),
  },
  activityChecklist: {
    mode: policy?.activityChecklist?.mode,
    reviewerUserId: policy?.activityChecklist?.reviewerUserId ?? null,
  },
});

export function ApprovalRuleEditor({
  routeKey,
  route,
  canEdit,
  reviewerCandidates,
  onChange,
}: {
  routeKey: ApprovalRouteKey;
  route: any;
  canEdit: boolean;
  reviewerCandidates: any[];
  onChange: (patch: any) => void;
}) {
  const definition = APPROVAL_RULE_DEFINITIONS[routeKey];
  const legacyEmployeeSetting = routeKey === 'employeeOutput' && route?.mode === 'employee_setting';
  const selectedMode =
    definition.modes.find(item => item.value === route?.mode) ||
    (legacyEmployeeSetting
      ? {
          value: 'employee_setting',
          label: '历史岗位设置（兼容）',
          description: '该租户仍在使用 v1 规则；新 v2 规则请改为低风险自动采纳、按风险分流、负责人或老板审批。',
        }
      : undefined);
  const activityRoute = routeKey !== 'employeeOutput';
  const candidates = reviewerCandidates.filter(candidate => !activityRoute || candidate.role !== 'manager');
  const selectedReviewer = reviewerCandidates.find(candidate => Number(candidate.id) === Number(route?.reviewerUserId));
  const reviewerDisabled = route?.mode === 'boss';

  return (
    <div className="system-approval-rule-card">
      <div className="system-approval-rule-title">{definition.title}</div>
      <div className="system-approval-rule-description">{definition.description}</div>
      <div className="system-approval-rule-label system-approval-rule-label--approval">审批方式</div>
      {canEdit ? (
        <Select
          value={route?.mode}
          className="system-approval-rule-control"
          options={[
            ...(legacyEmployeeSetting
              ? [{ value: 'employee_setting', label: '历史岗位设置（兼容，只读）', disabled: true }]
              : []),
            ...definition.modes.map(item => ({ value: item.value, label: item.label })),
          ]}
          onChange={mode => onChange({ mode, ...(mode === 'boss' ? { reviewerUserId: null } : {}) })}
        />
      ) : (
        <Tag color="blue" className="system-approval-rule-readonly-tag">
          {selectedMode?.label || '规则未返回'}
        </Tag>
      )}
      <div className="system-approval-rule-description system-approval-rule-description--selected">
        {selectedMode?.description || '当前规则说明未返回。'}
      </div>

      {routeKey === 'activityPlan' && route?.mode === 'amount_threshold' && (
        <div className="system-approval-rule-threshold">
          <div className="system-approval-rule-label system-approval-rule-label--threshold">老板终审金额阈值（元）</div>
          {canEdit ? (
            <InputNumber
              min={0}
              max={1_000_000_000_000}
              precision={2}
              value={route?.ownerAmountThreshold}
              className="system-approval-rule-control"
              onChange={value => onChange({ ownerAmountThreshold: Number(value ?? 0) })}
            />
          ) : (
            <Tag color="gold">≥ {Number(route?.ownerAmountThreshold || 0).toLocaleString()} 元转老板终审</Tag>
          )}
        </div>
      )}

      <div className="system-approval-rule-label system-approval-rule-label--reviewer">指定负责人</div>
      {canEdit ? (
        <Select
          allowClear
          disabled={reviewerDisabled}
          placeholder={reviewerDisabled ? '老板终审无需指定负责人' : '不指定，按当前职责范围匹配'}
          value={reviewerDisabled ? undefined : (route?.reviewerUserId ?? undefined)}
          className="system-approval-rule-control"
          options={candidates.map(candidate => ({
            value: candidate.id,
            label: `${candidate.name}·${ROLE_MAP[candidate.role]?.label || candidate.role}${candidate.dept ? `·${candidate.dept}` : ''}`,
          }))}
          onChange={reviewerUserId => onChange({ reviewerUserId: reviewerUserId ?? null })}
        />
      ) : (
        <div className="system-approval-rule-reviewer-readonly">
          {route?.mode === 'boss'
            ? '老板终审'
            : route?.reviewerUserId
              ? selectedReviewer?.name || '已由老板指定负责人'
              : '按当前管理职责范围匹配'}
        </div>
      )}
    </div>
  );
}
