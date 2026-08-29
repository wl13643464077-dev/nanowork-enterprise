// TinyFish 网络情报引擎（免费 Search + Fetch，真浏览器渲染）。
// 定位：作为联网检索链的最优先来源与受控网页抓取的优先内核——
//   - Search：GET api.search.tinyfish.ai  返回结构化搜索结果（免费 5-30 次/分）
//   - Fetch： POST api.fetch.tinyfish.ai  真浏览器渲染后返回干净 Markdown 正文（免费 25-150 URL/分）
// 失败安全：任何错误只返回失败结果，由调用方回落到既有链路（博查/Tavily/自研抓取），
// 绝不阻塞主流程。未配置 TINYFISH_API_KEY 时全部函数直接短路。
import { sanitizeProviderError } from './provider-errors.js';

const SEARCH_ENDPOINT = 'https://api.search.tinyfish.ai';
const FETCH_ENDPOINT = 'https://api.fetch.tinyfish.ai';
const DEFAULT_TIMEOUT_MS = 15_000;
const BODY_CHAR_LIMIT = 3000; // 与自研受控抓取的正文截断保持同一口径

export function tinyfishAvailable() {
  return Boolean(String(process.env.TINYFISH_API_KEY || '').trim());
}

// —— 进程内保守限流：免费档为 5 搜/分、25 抓/分，按最小间隔节流，
// 超限时不排队等待而是直接放弃（让调用方走回落链），避免拖慢主流程。
const throttle = { searchAt: 0, fetchAt: 0 };
const SEARCH_MIN_INTERVAL_MS = 12_000;
const FETCH_MIN_INTERVAL_MS = 2_500;

function throttled(kind, minInterval) {
  const now = Date.now();
  if (now - throttle[kind] < minInterval) return true;
  throttle[kind] = now;
  return false;
}

function requestSignal(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const signals = [controller.signal];
  if (externalSignal) signals.push(externalSignal);
  return { signal: AbortSignal.any(signals), clear: () => clearTimeout(timer) };
}

const normResult = (title, url, snippet) => ({
  title: String(title || '').trim(),
  url: String(url || '').trim(),
  snippet: String(snippet || '').replace(/\s+/gu, ' ').trim().slice(0, 160),
});

// 搜索：返回统一的 [{title,url,snippet}]（与 websearch.js 的 provider 契约一致）
export async function tinyfishSearch(query, {
  max = 5,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal: externalSignal,
  fetchImpl = globalThis.fetch,
  recencyMinutes,
  purpose,
} = {}) {
  if (!tinyfishAvailable()) throw new Error('TinyFish 未配置 API Key');
  if (throttled('searchAt', SEARCH_MIN_INTERVAL_MS)) {
    throw Object.assign(new Error('TinyFish 搜索触发本地节流（免费档限频），本次跳过'), { code: 'TINYFISH_THROTTLED' });
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

// 抓取：一批 URL（≤10）→ 真浏览器渲染后的干净正文。
// 输出结构与自研 fetchPublicPageEvidence 完全一致（title/url/snippet/body），
// 下游受控证据链无需感知内核差异。
export async function tinyfishFetchPages(urls, {
  timeoutMs = 25_000,
  signal: externalSignal,
  fetchImpl = globalThis.fetch,
  purpose,
  ttlSeconds = 1800,
} = {}) {
  if (!tinyfishAvailable()) throw new Error('TinyFish 未配置 API Key');
  const cleanUrls = [...new Set((Array.isArray(urls) ? urls : []).map(item => String(item || '').trim()).filter(Boolean))]
    .slice(0, 10);
  if (!cleanUrls.length) return { results: [], failures: [] };
  if (throttled('fetchAt', FETCH_MIN_INTERVAL_MS)) {
    throw Object.assign(new Error('TinyFish 抓取触发本地节流（免费档限频），本次跳过'), { code: 'TINYFISH_THROTTLED' });
  }
  const attempt = requestSignal(timeoutMs, externalSignal);
  try {
    const resp = await fetchImpl(FETCH_ENDPOINT, {
      method: 'POST',
      headers: { 'X-API-Key': process.env.TINYFISH_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: cleanUrls,
        format: 'markdown',
        ttl: Math.max(0, Math.trunc(Number(ttlSeconds) || 0)),
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
    const results = [];
    for (const page of Array.isArray(data?.results) ? data.results : []) {
      const body = String(page?.text || '')
        .replace(/[\t\r ]+/gu, ' ')
        .replace(/ *\n+ */gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
        .slice(0, BODY_CHAR_LIMIT);
      // 与自研内核同一门槛：正文太短视为无效证据，交由回落链重试
      if (body.length < 80) continue;
      const finalUrl = String(page?.final_url || page?.url || '').trim();
      results.push({
        title: String(page?.title || '').replace(/\s+/gu, ' ').trim().slice(0, 220)
          || (finalUrl ? new URL(finalUrl).hostname : ''),
        url: finalUrl,
        snippet: body.slice(0, 1200),
        body,
      });
    }
    const failures = (Array.isArray(data?.errors) ? data.errors : []).map(item => ({
      url: String(item?.url || ''),
      code: 'TINYFISH_PAGE_FAILED',
      error: String(item?.error || '').slice(0, 120),
    }));
    return { results, failures };
  } finally {
    attempt.clear();
  }
}

export function tinyfishFailureNote(error) {
  const safe = sanitizeProviderError(error, { service: 'TinyFish 网络情报' });
  return `TinyFish:${safe.message}${safe.providerStatus ? `（HTTP ${safe.providerStatus}）` : ''}`;
}
