import dayjs from 'dayjs';

const PLAN_FIELD_LABELS: Record<string, string> = {
  totalBudget: '总预算',
  allocation: '预算明细',
  approvalNote: '审批说明',
  item: '项目',
  amount: '金额',
  targetCount: '目标到场',
  targetAudience: '目标人群',
  inviteTotalSuggested: '建议邀约',
  confirmationTarget: '确认目标',
  arrivalTarget: '到场目标',
  channels: '邀约渠道',
  inviteScript: '邀约话术',
  confirmationScript: '确认话术',
  reminderPlan: '提醒计划',
  time: '时间',
  action: '动作',
  owner: '负责人',
  output: '交付物',
  name: '名称',
  step: '步骤',
};

const isRecord = (value: any) => !!value && typeof value === 'object' && !Array.isArray(value);

export const displayText = (value: any): string => {
  if (value == null || value === '') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.map(displayText).filter(Boolean).join('；');
  if (!isRecord(value)) return String(value);
  return Object.entries(value)
    .map(([key, child]) => {
      const text = displayText(child);
      return text ? `${PLAN_FIELD_LABELS[key] || key}：${text}` : '';
    })
    .filter(Boolean)
    .join('；');
};

export const asList = (value: any): string[] =>
  Array.isArray(value)
    ? value.map(displayText).filter(Boolean)
    : value == null || value === ''
      ? []
      : [displayText(value)];

export const normalizePlanView = (input: any) => {
  const plan = isRecord(input) ? input : {};
  const flowRows = Array.isArray(plan.flow) ? plan.flow : isRecord(plan.flow) ? Object.values(plan.flow) : [];
  const flow = flowRows
    .map((row: any, index: number) =>
      isRecord(row)
        ? {
            time: displayText(row.time ?? row.start ?? row.duration),
            item: displayText(row.item ?? row.action ?? row.name ?? row.title ?? row.content ?? row),
          }
        : { time: '', item: displayText(row) || `活动环节${index + 1}` },
    )
    .filter((row: any) => row.time || row.item);
  const sop = (Array.isArray(plan.sop) ? plan.sop : plan.sop == null || plan.sop === '' ? [] : [plan.sop])
    .map((row: any, index: number) => {
      if (!isRecord(row)) return displayText(row);
      return [
        `${displayText(row.step) || index + 1}. ${displayText(row.name ?? row.title) || '执行步骤'}`,
        displayText(row.action ?? row.content ?? row.detail),
        row.owner ? `负责人：${displayText(row.owner)}` : '',
        row.output ? `交付物：${displayText(row.output)}` : '',
      ]
        .filter(Boolean)
        .join('｜');
    })
    .filter(Boolean);
  return {
    ...plan,
    theme: displayText(plan.theme ?? plan.title) || '活动策划案',
    flow,
    materials: asList(plan.materials),
    invites: displayText(plan.invites),
    sop,
    kpi: isRecord(plan.kpi)
      ? Object.fromEntries(Object.entries(plan.kpi).map(([key, value]) => [key, displayText(value)]))
      : {},
    budgetNote: displayText(plan.budgetNote),
  };
};

export const cloneJson = (value: any) => JSON.parse(JSON.stringify(value || {}));

export const listText = (value: any) => asList(value).join('\n');

export const textList = (value: string) =>
  String(value || '')
    .split(/\r?\n|[；;]/)
    .map(item => item.trim())
    .filter(Boolean);

export function assignmentDrafts(plan: any, activity: any) {
  const baseDate = dayjs(activity?.date);
  const dueAt = (offsetDays: number, hour: number) =>
    baseDate.isValid()
      ? baseDate.add(offsetDays, 'day').hour(hour).minute(0).second(0)
      : dayjs()
          .add(Math.max(1, offsetDays + 2), 'day')
          .hour(hour)
          .minute(0)
          .second(0);
  const flow = (plan?.flow || [])
    .map((item: any) => `${item.time || ''} ${item.item || ''}`.trim())
    .filter(Boolean)
    .join('\n');
  const sop = asList(plan?.sop);
  return [
    {
      key: 'invite',
      title: '客户邀约与到场确认',
      priority: '高',
      assigneeId: undefined,
      dueAt: dueAt(-3, 18),
      detail:
        [displayText(plan?.invites), ...sop.slice(0, 3)].filter(Boolean).join('\n') ||
        '完成目标客户筛选、首邀、二次确认和到场提醒，并回传名单。',
    },
    {
      key: 'materials',
      title: '场地与活动物料准备',
      priority: '高',
      assigneeId: undefined,
      dueAt: dueAt(-1, 18),
      detail: asList(plan?.materials).join('、') || '完成场地、试吃菜品、物料、设备和签到工具准备，并逐项检查。',
    },
    {
      key: 'onsite',
      title: '现场流程与人员协同',
      priority: '高',
      assigneeId: undefined,
      dueAt: dueAt(0, 12),
      detail: flow || '按活动流程完成签到、主持、试吃体验、成交与现场数据记录。',
    },
    {
      key: 'followup',
      title: '会后跟进与活动复盘',
      priority: '中',
      assigneeId: undefined,
      dueAt: dueAt(1, 18),
      detail:
        [...sop.slice(3), plan?.kpi ? `复盘指标：${displayText(plan.kpi)}` : ''].filter(Boolean).join('\n') ||
        '会后24小时回访，录入成交与未成交原因，并完成活动复盘。',
    },
  ];
}
