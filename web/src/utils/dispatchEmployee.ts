export interface EmployeeTarget {
  idx: number;
  person: string;
  role: string;
}

export type EmployeeNavigator = (to: string, options?: { state?: unknown }) => void;

const ISSUE_EMPLOYEE_RULES: { keywords: RegExp; target: EmployeeTarget }[] = [
  {
    keywords: /菜品|菜单|滞销|毛利|出品|沽清|备货|库存|食材/u,
    target: { idx: 108, person: '王菜单', role: '菜单架构与组合规划' },
  },
  {
    keywords: /差评|口碑|服务|评分|客诉|点评/u,
    target: { idx: 143, person: '评价运营专员', role: '评价与口碑运营' },
  },
  {
    keywords: /会员|复购|沉睡|储值|老客|复访/u,
    target: { idx: 144, person: '葛会员', role: '会员分层与唤回' },
  },
  {
    keywords: /巡店|食安|卫生|日清|督导|漏检/u,
    target: { idx: 161, person: '查巡巡', role: '巡店督导' },
  },
  {
    keywords: /外卖|配送|出餐|美团|饿了么/u,
    target: { idx: 146, person: '外卖运营专员', role: '外卖渠道运营' },
  },
  {
    keywords: /商圈|竞品|选址|周边/u,
    target: { idx: 102, person: '钱商圈', role: '商圈竞争画像' },
  },
];

const DEFAULT_EMPLOYEE_TARGET: EmployeeTarget = {
  idx: 160,
  person: '店小满',
  role: '超级店长·活动策划',
};

/**
 * 按经营问题维度/描述关键词，映射最匹配的餐饮数字员工。
 */
export function resolveEmployeeForIssue(dimension?: string, issue?: string): EmployeeTarget {
  const text = `${dimension || ''} ${issue || ''}`.trim();
  if (!text) return DEFAULT_EMPLOYEE_TARGET;
  const matched = ISSUE_EMPLOYEE_RULES.find(rule => rule.keywords.test(text));
  return matched ? matched.target : DEFAULT_EMPLOYEE_TARGET;
}

/**
 * 一键跳转到指定餐饮数字员工工作台，并预填任务书。
 */
export function dispatchToEmployee(nav: EmployeeNavigator, employeeIdx: number, directive: string): void {
  nav(`/employees?employee=${employeeIdx}`, { state: { directive } });
}
