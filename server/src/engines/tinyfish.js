// TinyFish 网络情报引擎（Search + Fetch，真浏览器渲染）。
// 定位：所有公开联网调研的免费优先通道。这里只负责供应商协议、限流和
// 短期正文缓存；是否达到业务证据门、是否回退 Claude 由上层统一编排。
// 未配置 TINYFISH_API_KEY 时全部函数直接短路，密钥只从服务端环境读取。
import { isIP } from 'node:net';
import { sanitizeProviderError } from './provider-errors.js';

const SEARCH_ENDPOINT = 'https://api.search.tinyfish.ai';
const FETCH_ENDPOINT = 'https://api.fetch.tinyfish.ai';
const DEFAULT_TIMEOUT_MS = 12_000;
const BODY_CHAR_LIMIT = 3000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_REQUESTS_PER_MINUTE = 30;
const FETCH_URLS_PER_MINUTE = 150;
const MAX_CACHE_ENTRIES = 1000;
const SENSITIVE_QUERY_NAME = /^(?:api[_-]?key|apikey|key|access[_-]?token|accesstoken|authorization|auth|auth[_-]?token|authtoken|bearer|signature|sig|secret|token|password|passwd|credential|code|session|session[_-]?id|sessionid|jwt)$/iu;

export function tinyfishAvailable() {
  return Boolean(String(process.env.TINYFISH_API_KEY || '').trim());
}

// 滚动窗口只在确实达到官方默认额度时才短路；不能用固定间隔把同一业务
// 任务的后续核验误判成限流并提前烧到付费回退通道。
const requestHistory = { search: [], fetch: [] };
const pageCache = new Map();

function claimBudget(kind, weight, limit) {
  const now = Date.now();
  const history = requestHistory[kind];
  while (history.length && history[0] <= now - 60_000) history.shift();
  if (history.length + weight > limit) return false;
  for (let index = 0; index < weight; index += 1) history.push(now);
  return true;
}

function publicIpv4(address) {
  const parts = String(address || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return !(a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0 && c === 113)
    || a >= 224);
}

function mappedIpv4(normalized) {
  const dotted = String(normalized || '').match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
  if (dotted) return dotted[1];
  const hex = String(normalized || '').match(/^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo)) return null;
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function publicIpLiteral(address) {
  const normalized = String(address || '').toLowerCase().replace(/^\[|\]$/gu, '');
  const family = isIP(normalized);
  if (family === 4) return publicIpv4(normalized);
  if (family !== 6) return false;
  const mapped = mappedIpv4(normalized);
  if (mapped) return publicIpv4(mapped);
  return !(normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:'));
}

function decodedQueryKey(value) {
  let decoded = String(value || '');
  try {
    for (let depth = 0; depth < 2; depth += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    return decoded;
  } catch {
    return null;
  }
}

function sensitiveQuery(parsed) {
  return [...parsed.searchParams.keys()].some(key => {
    const decoded = decodedQueryKey(key);
    return decoded === null || SENSITIVE_QUERY_NAME.test(decoded);
  });
}

function sensitiveFragment(parsed) {
  let decoded = parsed.hash.slice(1);
  try {
    for (let depth = 0; depth < 2; depth += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    return /(?:^|[&;{\[,"'\s])(?:api[_-]?key|apikey|key|access[_-]?token|accesstoken|authorization|auth|auth[_-]?token|authtoken|bearer|signature|sig|secret|token|password|passwd|credential|code|session|session[_-]?id|sessionid|jwt)["']?\s*(?:=|:)/iu.test(decoded);
  } catch {
    return true;
  }
}

function malformedEncodedMaterial(parsed) {
  try {
    for (const initial of [parsed.search.slice(1), parsed.hash.slice(1)]) {
      const decoded = decodeURIComponent(initial.replace(/\+/gu, '%20'));
      if (decoded.includes('�')) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function normalizedPublicUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
    const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password || !hostname
      || malformedEncodedMaterial(parsed)
      || sensitiveQuery(parsed)
      || sensitiveFragment(parsed)
      || (parsed.port && parsed.port !== defaultPort)
      || hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || hostname.endsWith('.internal')
      || hostname.endsWith('.home')
      || hostname.endsWith('.arpa')
      || (isIP(hostname) && !publicIpLiteral(hostname))) return null;
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

function cacheKeyFor(value) {
  const normalized = normalizedPublicUrl(value);
  if (!normalized) return null;
  // 查询串经常承载一次性能力、追踪标识或租户相关参数；即使参数名看似
  // 普通，也不把对应正文放进跨请求的进程缓存。
  return new URL(normalized).search ? null : normalized;
}

function cachedPage(url, now = Date.now()) {
  const key = cacheKeyFor(url);
  if (!key) return null;
  const entry = pageCache.get(key);
  if (!entry || entry.expiresAt <= now) {
    pageCache.delete(key);
    return null;
  }
  return { ...entry.page };
}

function rememberPage(page, aliases = [], now = Date.now()) {
  const keys = [page?.url, ...aliases].map(cacheKeyFor).filter(Boolean);
  for (const key of keys) pageCache.set(key, { page: { ...page }, expiresAt: now + CACHE_TTL_MS });
  while (pageCache.size > MAX_CACHE_ENTRIES) pageCache.delete(pageCache.keys().next().value);
}

export function clearTinyfishRuntimeState() {
  requestHistory.search.length = 0;
  requestHistory.fetch.length = 0;
  pageCache.clear();
}

function requestSignal(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const signals = [controller.signal];
  if (externalSignal) signals.push(externalSignal);
  return { signal: AbortSignal.any(signals), clear: () => clearTimeout(timer) };
}

const normResult = (title, url, snippet) => {
  const normalizedUrl = normalizedPublicUrl(url);
  return {
    title: String(title || '').trim(),
    url: normalizedUrl || '',
    snippet: String(snippet || '').replace(/\s+/gu, ' ').trim().slice(0, 160),
  };
};

export async function tinyfishSearch(query, {
  max = 5,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal: externalSignal,
  fetchImpl = globalThis.fetch,
  recencyMinutes,
  purpose,
} = {}) {
  if (!tinyfishAvailable()) throw new Error('TinyFish 未配置 API Key');
  if (!claimBudget('search', 1, SEARCH_REQUESTS_PER_MINUTE)) {
    throw Object.assign(new Error('TinyFish 搜索达到本地滚动额度，本次切换备用通道'), { code: 'TINYFISH_THROTTLED' });
  }
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set('query', String(query || '').slice(0, 400));
  url.searchParams.set('language', 'zh');
  if (Number(recencyMinutes) > 0) url.searchParams.set('recency_minutes', String(Math.trunc(Number(recencyMinutes))));
  if (purpose) url.searchParams.set('purpose', String(purpose).slice(0, 500));
  const attempt = requestSignal(timeoutMs, externalSignal);
  try {
    const resp = await fetchImpl(url, {
      headers: { 'X-API-Key': process.env.TINYFISH_API_KEY },
      signal: attempt.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw Object.assign(
        new Error(`TinyFish 搜索返回 HTTP ${resp.status}`),
        { code: 'TINYFISH_HTTP_FAILED', providerStatus: resp.status },
      );
    }
    return (Array.isArray(data?.results) ? data.results : [])
      .map(item => normResult(item.title, item.url, item.snippet))
      .filter(item => item.title && item.url)
      .slice(0, Math.max(1, Number(max) || 5));
  } finally {
    attempt.clear();
  }
}

// 一批 URL（≤10）→ 真浏览器渲染后的干净正文。输出结构与自研受控抓取一致。
export async function tinyfishFetchPages(urls, {
  timeoutMs = 20_000,
  signal: externalSignal,
  fetchImpl = globalThis.fetch,
  purpose,
  ttlSeconds = 1800,
} = {}) {
  if (!tinyfishAvailable()) throw new Error('TinyFish 未配置 API Key');
  const cleanUrls = [...new Set((Array.isArray(urls) ? urls : [])
    .map(normalizedPublicUrl).filter(Boolean))]
    .slice(0, 10);
  if (!cleanUrls.length) return { results: [], failures: [] };
  const cached = cleanUrls.map(url => cachedPage(url)).filter(Boolean);
  const cachedUrls = new Set(cached.flatMap(page => [page.url, page.requestedUrl])
    .map(normalizedPublicUrl).filter(Boolean));
  const pending = cleanUrls.filter(url => !cachedUrls.has(url));
  const pendingSet = new Set(pending);
  if (!pending.length) return { results: cached, failures: [], cached: cached.length };
  if (!claimBudget('fetch', pending.length, FETCH_URLS_PER_MINUTE)) {
    throw Object.assign(new Error('TinyFish 抓取达到本地滚动额度，本次切换备用通道'), { code: 'TINYFISH_THROTTLED' });
  }
  const attempt = requestSignal(timeoutMs, externalSignal);
  try {
    const resp = await fetchImpl(FETCH_ENDPOINT, {
      method: 'POST',
      headers: { 'X-API-Key': process.env.TINYFISH_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: pending,
        format: 'markdown',
        ttl: Math.max(0, Math.trunc(Number(ttlSeconds) || 0)),
        per_url_timeout_ms: Math.max(1_000, Math.min(110_000, Math.trunc(Number(timeoutMs) || 20_000))),
        ...(purpose ? { purpose: String(purpose).slice(0, 500) } : {}),
      }),
      signal: attempt.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw Object.assign(
        new Error(`TinyFish 抓取返回 HTTP ${resp.status}`),
        { code: 'TINYFISH_HTTP_FAILED', providerStatus: resp.status },
      );
    }
    const results = [...cached];
    for (const page of Array.isArray(data?.results) ? data.results : []) {
      const body = String(page?.text || '')
        .replace(/[\t\r ]+/gu, ' ')
        .replace(/ *\n+ */gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
        .slice(0, BODY_CHAR_LIMIT);
      if (body.length < 80) continue;
      const requestedUrl = normalizedPublicUrl(page?.url);
      if (!requestedUrl || !pendingSet.has(requestedUrl)) continue;
      const finalUrl = normalizedPublicUrl(page?.final_url || requestedUrl);
      if (!finalUrl) continue;
      const normalizedPage = {
        title: String(page?.title || '').replace(/\s+/gu, ' ').trim().slice(0, 220)
          || new URL(finalUrl).hostname,
        url: finalUrl,
        requestedUrl,
        snippet: body.slice(0, 1200),
        body,
      };
      results.push(normalizedPage);
      rememberPage(normalizedPage, [requestedUrl]);
    }
    const failures = (Array.isArray(data?.errors) ? data.errors : [])
      .map(item => ({
        url: normalizedPublicUrl(item?.url),
        code: String(item?.error?.type || item?.type || 'TINYFISH_PAGE_FAILED').slice(0, 120),
        error: String(item?.error?.message || item?.message || item?.error || '').slice(0, 120),
      }))
      .filter(item => item.url && pendingSet.has(item.url));
    return { results, failures, cached: cached.length };
  } finally {
    attempt.clear();
  }
}

export function tinyfishFailureNote(error) {
  const safe = sanitizeProviderError(error, { service: 'TinyFish 网络情报' });
  return `TinyFish:${safe.message}${safe.providerStatus ? `（HTTP ${safe.providerStatus}）` : ''}`;
}
