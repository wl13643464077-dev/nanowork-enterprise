// 移动端 /m 的路由约定（子路径驱动 Tab，query 携带二级状态）：
//   /m                 首页        /m/customers   客户（首页二级）
//   /m/dispatch        派活列表    /m/dispatch?employee=IDX&q=原话   派活表单
//   /m/tasks           任务列表    /m/tasks?task=ID（餐饮任务）| /m/tasks?kind=K&id=I
//   /m/inbox           待办        /m/me          我的      /m/content   内容（首页二级）
// 旧的 /m?tab=xxx 深链继续有效（映射到同名子路径）。

export const MOBILE_ROOT = '/m';

export type MobileTab = 'home' | 'dispatch' | 'tasks' | 'inbox' | 'me';
export type MobileView = MobileTab | 'customers' | 'content';

const VIEWS = new Set<MobileView>(['home', 'dispatch', 'tasks', 'inbox', 'me', 'customers', 'content']);

// 二级页归属的底部 Tab（高亮用）
export function tabOfView(view: MobileView): MobileTab {
  if (view === 'customers' || view === 'content') return 'home';
  return view;
}

export function parseMobileLocation(pathname: string, search: string): { view: MobileView; params: URLSearchParams } {
  const params = new URLSearchParams(search);
  const rest = pathname.replace(/^\/m\/?/u, '');
  const segment = rest.split('/')[0] || '';
  let view: MobileView = 'home';
  if (segment && VIEWS.has(segment as MobileView)) view = segment as MobileView;
  else if (!segment) {
    const legacyTab = params.get('tab') || '';
    if (VIEWS.has(legacyTab as MobileView)) view = legacyTab as MobileView;
  }
  return { view, params };
}

type ParamValue = string | number | null | undefined;

export function mobilePath(view: MobileView, params: Record<string, ParamValue> = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    query.set(key, String(value));
  }
  const base = view === 'home' ? MOBILE_ROOT : `${MOBILE_ROOT}/${view}`;
  const search = query.toString();
  return search ? `${base}?${search}` : base;
}

function isSafeInnerPath(link: string) {
  return link.length <= 1000 && /^\/(?!\/)[^\\\r\n]*$/u.test(link);
}

/**
 * 桌面路径 → 移动路径的最小映射（通知深链、收件箱 link 在手机上落到对应移动页）。
 * 没有移动等价页的路径原样返回（走桌面版），非法/外链返回 null。
 */
export function toMobilePath(link: string | null | undefined): string | null {
  const raw = String(link || '').trim();
  if (!raw || !isSafeInnerPath(raw)) return null;
  if (raw === MOBILE_ROOT || raw.startsWith(`${MOBILE_ROOT}/`) || raw.startsWith(`${MOBILE_ROOT}?`)) return raw;
  const [pathname, search = ''] = raw.split('?');
  const params = new URLSearchParams(search);
  switch (pathname.replace(/\/+$/u, '') || '/') {
    case '/':
      return MOBILE_ROOT;
    case '/employees': {
      const task = params.get('task');
      const employee = params.get('employee');
      if (task && /^\d+$/u.test(task)) return mobilePath('tasks', { task });
      if (employee && /^\d+$/u.test(employee)) return mobilePath('dispatch', { employee });
      return mobilePath('dispatch');
    }
    case '/marshals':
      return mobilePath('dispatch');
    case '/tasks': {
      const kind = params.get('kind');
      const id = params.get('id');
      if (kind === 'restaurant' && id && /^\d+$/u.test(id)) return mobilePath('tasks', { task: id });
      if (kind && id) return mobilePath('tasks', { kind, id });
      return mobilePath('tasks');
    }
    case '/system':
      return params.get('tab') === 'approvals' ? mobilePath('inbox') : raw;
    case '/growth':
      return mobilePath('customers');
    case '/content':
      // 内容员工工作台（employee/runId）没有移动等价页，仍走桌面
      return params.has('employee') || params.has('runId') ? raw : mobilePath('content');
    default:
      return raw;
  }
}

// 长任务页切 Tab 不丢状态：记住最近打开的任务，回到「任务」Tab 时直接恢复
const CURRENT_TASK_KEY = 'nw-mobile-current-task';
export type MobileTaskRef = { kind: string; id: number };

export function rememberCurrentTask(ref: MobileTaskRef | null) {
  try {
    if (ref) window.sessionStorage.setItem(CURRENT_TASK_KEY, JSON.stringify(ref));
    else window.sessionStorage.removeItem(CURRENT_TASK_KEY);
  } catch {
    /* 隐私模式不可写：本次会话仅内存态 */
  }
}

export function recallCurrentTask(): MobileTaskRef | null {
  try {
    const raw = window.sessionStorage.getItem(CURRENT_TASK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MobileTaskRef;
    const id = Number(parsed?.id);
    return parsed?.kind && Number.isSafeInteger(id) && id > 0 ? { kind: String(parsed.kind), id } : null;
  } catch {
    return null;
  }
}

// 刚派出的任务（execution 模块未开通时任务列表拉不到，这里兜底可达）
const RECENT_DISPATCH_KEY = 'nw-mobile-recent-dispatch';
export type RecentDispatch = { id: number; title: string; employee: string; at: string };

export function readRecentDispatches(): RecentDispatch[] {
  try {
    const raw = window.sessionStorage.getItem(RECENT_DISPATCH_KEY);
    const parsed = raw ? (JSON.parse(raw) as RecentDispatch[]) : [];
    return Array.isArray(parsed) ? parsed.filter(item => Number.isSafeInteger(Number(item?.id))) : [];
  } catch {
    return [];
  }
}

export function pushRecentDispatch(entry: RecentDispatch) {
  try {
    const next = [entry, ...readRecentDispatches().filter(item => item.id !== entry.id)].slice(0, 12);
    window.sessionStorage.setItem(RECENT_DISPATCH_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式不可写 */
  }
}
