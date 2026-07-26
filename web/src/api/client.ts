import { message } from 'antd';

// 新项目只使用自有 HttpOnly Cookie，不从 localStorage 读取或迁移其他项目会话。
let currentUser: any = null;

export const getToken = () => currentUser ? 'cookie-session' : null;
export const setAuth = (_token: string, user: any) => {
  currentUser = user;
};
export const clearAuth = () => {
  currentUser = null;
  void fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
};
export const bootstrapSession = async () => {
  const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (!response.ok) {
    currentUser = null;
    return null;
  }
  currentUser = await response.json();
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
  return 60000;
}

async function request(method: string, url: string, body?: any) {
  let res: Response;
  const controller = new AbortController();
  const timeoutMs = timeoutFor(url);
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const requestId = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  try {
    res = await fetch(`/api${url}`, {
      method,
      credentials: 'same-origin',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // 网络层失败（断网/超时/服务未响应）——此前唯一会"完全静默"的路径。
    // 节流 3s：避免一个页面并发多个请求时错误提示刷屏。
    const now = Date.now();
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    if (now - lastNetErrAt > 3000) {
      lastNetErrAt = now;
      message.error(aborted ? `请求超过${Math.round(timeoutMs / 1000)}秒，已自动停止，请缩短要求后重试` : '网络连接失败，请检查网络后重试');
    }
    throw e;
  } finally { window.clearTimeout(timeout); }
  if (res.status === 401) {
    clearAuth();
    if (location.pathname !== '/login') location.href = '/login';
    throw new Error('登录已过期');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    message.error(data.error || `请求失败 (${res.status})`);
    throw new Error(data.error || `HTTP ${res.status}`);
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
      method: 'POST', credentials: 'same-origin', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
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
    message.error(data.error || `请求失败 (${res.status})`);
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', final: any = null, errText = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        let obj: any; try { obj = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (obj.error) errText = obj.error;
        else if (obj.done) final = obj;
        else onEvent(obj);
      }
      if (final || errText) break;
    }
    if (errText) { message.error(errText); throw new Error(errText); }
    if (!final) { message.error('流式响应中断，请重试'); throw new Error('stream interrupted'); }
    return final;
  } finally { window.clearTimeout(hardCap); }
}

export const api = {
  get: (url: string) => request('GET', url),
  post: (url: string, body?: any) => request('POST', url, body),
  put: (url: string, body?: any) => request('PUT', url, body),
  del: (url: string) => request('DELETE', url),
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
  } catch { return '#'; }
}

export const fmtMoney = (n: number) => `¥${Number(n || 0).toLocaleString('zh-CN')}`;
export const fmtWan = (n: number) => (n >= 10000 ? `¥${(n / 10000).toFixed(1)}万` : fmtMoney(n));
