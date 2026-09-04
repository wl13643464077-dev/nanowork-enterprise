import { message } from 'antd';
import { bindStoreContextTenant, storeHeaders } from './store-context';

// 新项目只使用自有 HttpOnly Cookie，不从 localStorage 读取或迁移其他项目会话。
let currentUser: any = null;

export const getToken = () => (currentUser ? 'cookie-session' : null);
export const setAuth = (_token: string, user: any) => {
  currentUser = user;
  bindStoreContextTenant(user?.tenant?.id);
};
export const clearAuth = () => {
  currentUser = null;
  bindStoreContextTenant(null);
  void fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
};
export const bootstrapSession = async () => {
  const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (!response.ok) {
    currentUser = null;
    bindStoreContextTenant(null);
    return null;
  }
  currentUser = await response.json();
  bindStoreContextTenant(currentUser?.tenant?.id);
  return currentUser;
};
export const ensureSessionCookie = bootstrapSession;
export const getUser = (): any => currentUser;

let lastNetErrAt = 0;
function timeoutFor(url: string) {
  if (/\/content\/generate-video/.test(url)) return 95000;
  if (/\/content\/generate-image/.test(url)) return 125000;
  if (/\/(advisor|marshals|agents)\/.*(chat|skill-file)|\/advisor\/chat/.test(url)) return 135000;
  if (/\/(generate-ppt|artifacts\/generate)/.test(url)) return 120000;
  // 一句话找人链路是重推理调用：组队/拆解/汇总在供应商慢时可达 60-90 秒，
  // 60 秒默认超时会把还在生成的请求掐断（老板看到报错但后端其实在跑）。
  if (/\/employees\/(match-team|team-plan|team-summary)/.test(url)) return 150000;
  return 60000;
}

// 可选请求项：
// - signal 为外部 AbortSignal（如用户点击「取消生成」）
// - silent 用于命令面板等辅助请求；失败交给调用方降级，不弹全局错误提示
// 外部取消与内部超时并存：任一触发即中止请求；用户主动取消不弹全局错误提示。
export type RequestOptions = { signal?: AbortSignal; silent?: boolean };

export type ApiRequestError = Error & {
  status?: number;
  code?: string;
  retryable?: boolean;
  requestId?: string;
  billing?: Record<string, unknown>;
};

function requestError(
  messageText: string,
  meta: Omit<ApiRequestError, keyof Error | 'name' | 'message'> = {},
): ApiRequestError {
  return Object.assign(new Error(messageText), { name: 'ApiRequestError', ...meta });
}

// 月度 AI 预算拦截（服务端 code=BUDGET_EXCEEDED，文案已是老板可读信息）：
// 所有 AI 入口（派活/参谋/内容生产等）统一在这里提示并刷新顶栏预算 Tag，不需要各页面单独处理。
// 一次操作可能并发多个请求，同一错误 5 秒内只提示一次。
export const BUDGET_EXCEEDED_CODE = 'BUDGET_EXCEEDED';
let lastBudgetNoticeAt = 0;
export function handleBudgetExceeded(data: any): boolean {
  if (!data || data.code !== BUDGET_EXCEEDED_CODE) return false;
  const now = Date.now();
  if (now - lastBudgetNoticeAt > 5000) {
    lastBudgetNoticeAt = now;
    message.warning(String(data.error || '本月 AI 预算已用完，请老板在后台调整预算'), 6);
  }
  const budget = data.budget && typeof data.budget === 'object' ? data.budget : {};
  window.dispatchEvent(new CustomEvent('budget-updated', { detail: { state: 'exceeded', ...budget } }));
  return true;
}

async function request(method: string, url: string, body?: any, options: RequestOptions = {}) {
  let res: Response;
  const external = options.signal;
  const controller = new AbortController();
  const timeoutMs = timeoutFor(url);
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // 手动桥接外部 signal（等效 AbortSignal.any，兼容旧运行时）
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  const requestId = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  try {
    res = await fetch(`/api${url}`, {
      method,
      credentials: 'same-origin',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
        // 多门店：选中门店时附带 X-Store-Id；未选/单店客户不带头，服务端不过滤
        ...storeHeaders(),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    // 用户主动取消：静默抛出，由调用方决定如何提示（与超时/断网区分开）
    if (aborted && !timedOut && external?.aborted) throw e;
    // 网络层失败（断网/超时/服务未响应）——此前唯一会"完全静默"的路径。
    // 节流 3s：避免一个页面并发多个请求时错误提示刷屏。
    const now = Date.now();
    const failureMessage = aborted
      ? `请求超过${Math.round(timeoutMs / 1000)}秒，已自动停止，请稍后重试`
      : '网络连接失败，请检查网络后重试';
    if (!options.silent && now - lastNetErrAt > 3000) {
      lastNetErrAt = now;
      message.error(failureMessage);
    }
    throw requestError(failureMessage, {
      code: aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
      retryable: true,
      requestId,
    });
  } finally {
    window.clearTimeout(timeout);
    external?.removeEventListener('abort', onExternalAbort);
  }
  // 登录被拒绝是表单错误，不是已有会话过期；保留服务端原因交给登录页显示。
  if (res.status === 401 && !(method === 'POST' && url === '/auth/login')) {
    clearAuth();
    if (location.pathname !== '/login') location.href = '/login';
    throw new Error('登录已过期');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const budgetHandled = handleBudgetExceeded(data);
    if (!options.silent && !budgetHandled) message.error(data.error || `请求失败 (${res.status})`);
    throw requestError(data.error || `HTTP ${res.status}`, {
      status: res.status,
      code: typeof data.code === 'string' ? data.code : undefined,
      retryable: typeof data.retryable === 'boolean' ? data.retryable : undefined,
      requestId:
        (typeof data.requestId === 'string' && data.requestId.trim()) || res.headers.get('x-request-id') || requestId,
      billing: data.billing && typeof data.billing === 'object' ? data.billing : undefined,
    });
  }
  // 成功响应也带上可关联的请求编号。team-plan 会在客户端做第二道账务门禁；
  // 若服务端意外以 2xx 返回非 settled 状态，页面仍能给出真实排查编号。
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const responseRequestId =
      (typeof data.requestId === 'string' && data.requestId.trim()) || res.headers.get('x-request-id') || requestId;
    data.requestId = responseRequestId;
  }
  return data;
}

// SSE 流式请求：onEvent 逐事件回调（{delta:文本增量}/{reset:通道切换清屏}），返回 done 事件的完整元数据
// 服务端非 SSE 响应（校验失败等）自动按普通 JSON 错误处理
async function streamRequest(url: string, body: any, onEvent: (e: any) => void): Promise<any> {
  const controller = new AbortController();
  const hardCap = window.setTimeout(() => controller.abort(), 180000); // 总时长兜底
  let res: Response;
  try {
    res = await fetch(`/api${url}`, {
      method: 'POST',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...storeHeaders() },
      body: JSON.stringify(body),
    });
  } catch (e) {
    window.clearTimeout(hardCap);
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    message.error(aborted ? '请求超过180秒，已自动停止，请缩短要求后重试' : '网络连接失败，请检查网络后重试');
    throw e;
  }
  if (res.status === 401) {
    window.clearTimeout(hardCap);
    clearAuth();
    if (location.pathname !== '/login') location.href = '/login';
    throw new Error('登录已过期');
  }
  const ctype = res.headers.get('content-type') || '';
  if (!res.ok || !ctype.includes('text/event-stream') || !res.body) {
    window.clearTimeout(hardCap);
    const data = await res.json().catch(() => ({}));
    if (!handleBudgetExceeded(data)) message.error(data.error || `请求失败 (${res.status})`);
    throw requestError(data.error || `HTTP ${res.status}`, {
      status: res.status,
      code: typeof data.code === 'string' ? data.code : undefined,
    });
  }
  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '',
      final: any = null,
      errText = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        let obj: any;
        try {
          obj = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (obj.error) errText = obj.error;
        else if (obj.done) final = obj;
        else onEvent(obj);
      }
      if (final || errText) break;
    }
    if (errText) {
      message.error(errText);
      throw new Error(errText);
    }
    if (!final) {
      message.error('流式响应中断，请重试');
      throw new Error('stream interrupted');
    }
    return final;
  } finally {
    window.clearTimeout(hardCap);
  }
}

export const api = {
  get: (url: string, options?: RequestOptions) => request('GET', url, undefined, options),
  post: (url: string, body?: any, options?: RequestOptions) => request('POST', url, body, options),
  put: (url: string, body?: any, options?: RequestOptions) => request('PUT', url, body, options),
  del: (url: string, options?: RequestOptions) => request('DELETE', url, undefined, options),
  stream: (url: string, body: any, onEvent: (e: any) => void) => streamRequest(url, body, onEvent),
};

// 积分余额联动：任何返回 billing 的AI调用后，调用方执行 notifyCredits(billing.balance)
// 顶栏监听 'credits-updated' 实时刷新余额显示
export function notifyCredits(balance?: number) {
  if (balance === undefined || balance === null) return;
  const u = getUser();
  if (u) currentUser = { ...u, credits: balance };
  window.dispatchEvent(new CustomEvent('credits-updated', { detail: { balance } }));
}

// 通用 CSV 导出（含 BOM，Excel 打开中文不乱码）。headers: 列名；rows: 二维数组
export function exportCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const esc = (v: any) => {
    const raw = String(v ?? '');
    const s = /^[\t\r ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '\uFEFF' + [headers, ...rows].map(r => r.map(esc).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// 外部/AI 来源 URL 协议白名单：只放行 http(s) 与站内相对路径，拦截 javascript: 等危险协议
export function safeUrl(url: any): string {
  const s = String(url || '').trim();
  if (!s) return '#';
  if (s.startsWith('/') && !s.startsWith('//')) return s; // 站内相对路径
  try {
    const u = new URL(s, window.location.origin);
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : '#';
  } catch {
    return '#';
  }
}

export const fmtMoney = (n: number) => `¥${Number(n || 0).toLocaleString('zh-CN')}`;
export const fmtWan = (n: number) => (n >= 10000 ? `¥${(n / 10000).toFixed(1)}万` : fmtMoney(n));
