const FIELD_LABELS = {
  totalBudget: '总预算', allocation: '预算明细', approvalNote: '审批说明',
  item: '项目', amount: '金额', targetCount: '目标到场', targetAudience: '目标人群',
  inviteTotalSuggested: '建议邀约', confirmationTarget: '确认目标', arrivalTarget: '到场目标',
  channels: '邀约渠道', inviteScript: '首轮邀约话术', confirmationScript: '确认话术',
  reminderPlan: '提醒计划', manualReviewRequired: '需人工确认', time: '时间', action: '动作',
  owner: '负责人', output: '交付物', name: '名称', step: '步骤', quantity: '数量', unit: '单位', note: '备注',
};

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function activityPlanText(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.map(activityPlanText).filter(Boolean).join('；');
  if (!isRecord(value)) return String(value);
  return Object.entries(value)
    .map(([key, item]) => {
      const text = activityPlanText(item);
      return text ? `${FIELD_LABELS[key] || key}：${text}` : '';
    })
    .filter(Boolean)
    .join('；');
}

function normalizeFlow(value) {
  const rows = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  return rows.map((row, index) => {
    if (!isRecord(row)) return { time: '', item: activityPlanText(row) || `活动环节${index + 1}` };
    return {
      time: activityPlanText(row.time ?? row.start ?? row.duration),
      item: activityPlanText(row.item ?? row.action ?? row.name ?? row.title ?? row.content ?? row),
    };
  }).filter(row => row.time || row.item);
}

function normalizeMaterials(value) {
  const rows = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  return rows.map(row => {
    if (!isRecord(row)) return activityPlanText(row);
    const title = activityPlanText(row.name ?? row.item ?? row.title);
    const details = Object.entries(row)
      .filter(([key]) => !['name', 'item', 'title'].includes(key))
      .map(([key, item]) => {
        const text = activityPlanText(item);
        return text ? `${FIELD_LABELS[key] || key}：${text}` : '';
      }).filter(Boolean);
    return [title, ...details].filter(Boolean).join('｜') || activityPlanText(row);
  }).filter(Boolean);
}

function normalizeSop(value) {
  const rows = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  return rows.map((row, index) => {
    if (!isRecord(row)) return activityPlanText(row);
    const step = activityPlanText(row.step) || String(index + 1);
    const name = activityPlanText(row.name ?? row.title);
    const action = activityPlanText(row.action ?? row.content ?? row.detail);
    const owner = activityPlanText(row.owner);
    const output = activityPlanText(row.output);
    const head = `${step}. ${name || '执行步骤'}`;
    return [head, action, owner ? `负责人：${owner}` : '', output ? `交付物：${output}` : ''].filter(Boolean).join('｜');
  }).filter(Boolean);
}

function normalizeKpi(value) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, activityPlanText(item)]));
}

function normalizeBudget(value) {
  if (!isRecord(value)) return activityPlanText(value);
  const lines = [];
  if (value.totalBudget != null) lines.push(`总预算：${activityPlanText(value.totalBudget)}`);
  if (Array.isArray(value.allocation)) {
    lines.push(`预算明细：${value.allocation.map(item => activityPlanText(item)).filter(Boolean).join('；')}`);
  }
  if (value.approvalNote != null) lines.push(`审批说明：${activityPlanText(value.approvalNote)}`);
  const known = new Set(['totalBudget', 'allocation', 'approvalNote']);
  for (const [key, item] of Object.entries(value)) {
    if (!known.has(key)) lines.push(`${FIELD_LABELS[key] || key}：${activityPlanText(item)}`);
  }
  return lines.filter(Boolean).join('\n');
}

export function normalizeActivityPlan(input, fallbackTitle = '活动策划案') {
  const plan = isRecord(input) ? input : {};
  return {
    ...plan,
    theme: activityPlanText(plan.theme ?? plan.title) || fallbackTitle,
    flow: normalizeFlow(plan.flow),
    materials: normalizeMaterials(plan.materials),
    invites: activityPlanText(plan.invites),
    sop: normalizeSop(plan.sop),
    kpi: normalizeKpi(plan.kpi),
    budgetNote: normalizeBudget(plan.budgetNote),
  };
}
