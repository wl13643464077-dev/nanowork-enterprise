// 联网检索引擎（老板参谋「联网」开关，FR-ADV-07）
// 统一链路：TinyFish Search+Fetch 先过材料质量门 → 不足时 Claude WebSearch
// 深度回退 → 旧部署已配置的博查/Tavily/Serper 灾备 → 无 Key 只读来源。
// 注意：免 Key 来源可能限流或反爬，正式部署仍应配置至少一个检索源
// （TINYFISH_API_KEY 免费 / BOCHA_API_KEY / TAVILY_API_KEY / SERPER_API_KEY）。
// 失败安全：超时/网络受限时返回空数组并附 note，不阻塞会诊主流程。
import { providerResponseError, sanitizeProviderError } from './provider-errors.js';
import {
  agenticWebResearch,
  agenticWebResearchReadiness,
} from './agentic-web-research.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function strip(html = '') {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#x27;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\s+/g, ' ').trim();
}
function realUrl(href = '') {
  // DDG 跳转链：//duckduckgo.com/l/?uddg=<encoded>&rut=...
  const decodedHref = strip(href);
  const m = decodedHref.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return href; } }
  return decodedHref.startsWith('//') ? 'https:' + decodedHref : decodedHref;
}

function usableHttpUrl(value = '') {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function attributeValue(attributes = '', name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = attributes.match(new RegExp(
    `(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
    'iu',
  ));
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

function hasClass(attributes = '', expected = []) {
  const tokens = new Set(attributeValue(attributes, 'class').split(/\s+/u).filter(Boolean));
  return expected.some(name => tokens.has(name));
}

function firstClassContent(html = '', expected = []) {
  const openings = html.matchAll(/<([a-z][\w:-]*)\b([^>]*)>/giu);
  for (const match of openings) {
    if (!hasClass(match[2], expected)) continue;
    const contentStart = Number(match.index) + match[0].length;
    const closing = html.slice(contentStart).match(new RegExp(`<\\/${match[1]}\\s*>`, 'iu'));
    if (closing) return html.slice(contentStart, contentStart + Number(closing.index));
  }
  return '';
}

async function fetchJson(url, { headers = {}, body, signal, fetchImpl, service }) {
  const resp = await fetchImpl(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw providerResponseError(resp.status, data, { service });
  return data;
}

const norm = (title, url, snippet) => ({
  title: String(title || '').trim(),
  url: String(url || '').trim(),
  snippet: String(snippet || '').replace(/\s+/g, ' ').trim().slice(0, 160),
});

// 旧商业源适配器：统一分层通道未交付时才继续尝试。
const PROVIDERS = [
  {
    name: '博查',
    key: () => process.env.BOCHA_API_KEY,
    async search(query, max, signal, fetchImpl) {
      const data = await fetchJson('https://api.bochaai.com/v1/web-search', {
        headers: { Authorization: `Bearer ${process.env.BOCHA_API_KEY}` },
        body: { query, count: max, summary: true }, signal, fetchImpl, service: '博查检索服务',
      });
      return (data?.data?.webPages?.value || []).map(v => norm(v.name, v.url, v.summary || v.snippet));
    },
  },
  {
    name: 'Tavily',
    key: () => process.env.TAVILY_API_KEY,
    async search(query, max, signal, fetchImpl) {
      const data = await fetchJson('https://api.tavily.com/search', {
        headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
        body: { query, max_results: max }, signal, fetchImpl, service: 'Tavily检索服务',
      });
      return (data?.results || []).map(v => norm(v.title, v.url, v.content));
    },
  },
  {
    name: 'Serper',
    key: () => process.env.SERPER_API_KEY,
    async search(query, max, signal, fetchImpl) {
      const data = await fetchJson('https://google.serper.dev/search', {
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY },
        body: { q: query, num: max, gl: 'cn', hl: 'zh-cn' }, signal, fetchImpl, service: 'Serper检索服务',
      });
      return (data?.organic || []).map(v => norm(v.title, v.link, v.snippet));
    },
  },
];

async function ddgSearch(query, max, signal, fetchImpl) {
  const resp = await fetchImpl('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + '&kl=cn-zh', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal,
  });
  if (!resp.ok) {
    throw providerResponseError(resp.status, {}, { service: 'DuckDuckGo检索服务' });
  }
  const html = await resp.text();
  const out = [];
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/giu)]
    .filter(match => hasClass(match[1], ['result__a', 'result-link']));
  const seen = new Set();
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    const href = attributeValue(anchor[1], 'href');
    const url = realUrl(href);
    const title = strip(anchor[2]);
    if (!title || !usableHttpUrl(url) || /(^|\.)duckduckgo\.com$/iu.test(new URL(url).hostname)) continue;
    const dedupeKey = url.toLowerCase().replace(/\/$/u, '');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const segmentStart = Number(anchor.index) + anchor[0].length;
    const segmentEnd = index + 1 < anchors.length ? Number(anchors[index + 1].index) : html.length;
    const snippet = firstClassContent(
      html.slice(segmentStart, segmentEnd),
      ['result__snippet', 'result-snippet'],
    );
    out.push({ title, url, snippet: strip(snippet).slice(0, 160) });
    if (out.length >= max) break;
  }
  return out;
}

function xmlTag(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'iu'));
  return match ? strip(match[1].replace(/^<!\[CDATA\[|\]\]>$/gu, '')) : '';
}

async function googleNewsSearch(query, max, signal, fetchImpl) {
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('q', query);
  url.searchParams.set('hl', 'zh-CN');
  url.searchParams.set('gl', 'CN');
  url.searchParams.set('ceid', 'CN:zh-Hans');
  const resp = await fetchImpl(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5' },
    signal,
  });
  if (!resp.ok) {
    throw providerResponseError(resp.status, {}, { service: 'Google News RSS检索服务' });
  }
  const xml = await resp.text();
  const items = xml.match(/<item>[\s\S]*?<\/item>/giu) || [];
  const results = [];
  for (const item of items) {
    const title = xmlTag(item, 'title');
    const link = xmlTag(item, 'link');
    const description = xmlTag(item, 'description');
    const source = xmlTag(item, 'source');
    const publishedAt = xmlTag(item, 'pubDate');
    if (!title || !/^https?:\/\//iu.test(link)) continue;
    results.push(norm(
      title,
      link,
      [source && `来源：${source}`, publishedAt && `发布：${publishedAt}`, description]
        .filter(Boolean)
        .join('；'),
    ));
    if (results.length >= max) break;
  }
  return results;
}

export function webSearchProviders() {
  const tiered = agenticWebResearchReadiness();
  return [
    ...(tiered.primaryReady ? ['TinyFish'] : []),
    ...(tiered.fallbackReady ? ['Claude WebSearch'] : []),
    ...PROVIDERS.filter(p => p.key()).map(p => p.name),
  ];
}

function attemptSignal(timeoutMs, externalSignal, totalSignal) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signals = [timeoutController.signal, totalSignal];
  if (externalSignal) signals.push(externalSignal);
  return {
    signal: AbortSignal.any(signals),
    timedOut: () => timeoutController.signal.aborted,
    clear: () => clearTimeout(timer),
  };
}

function safeFailure(label, error, service) {
  const safe = sanitizeProviderError(error, { service });
  const status = safe.providerStatus ? `（HTTP ${safe.providerStatus}）` : '';
  return { safe, note: `${label}:${safe.message}${status}` };
}

function unavailableResult(failures, reason = '') {
  const evidence = failures.length ? failures.join('；') : '所有检索源均未命中';
  return {
    ok: false,
    provider: null,
    results: [],
    note: `未取得可验证联网来源${reason ? `（${reason}）` : ''}：${evidence}`,
  };
}

export async function webSearch(query, {
  max = 5,
  timeoutMs = 9000,
  signal: externalSignal,
  fetchImpl = globalThis.fetch,
  fallbackOrder = 'news_first',
  tieredResearchFn = agenticWebResearch,
  skipTiered = false,
} = {}) {
  const perAttemptTimeoutMs = Math.max(1, Math.floor(Number(timeoutMs) || 9000));
  const configuredProviders = PROVIDERS.filter(provider => provider.key());
  const tieredReadiness = agenticWebResearchReadiness();
  // 只有首选 TinyFish 确实配置后才进入 TinyFish→Claude。单独存在 Claude
  // 凭证时，深度员工链仍可直接使用 Claude；轻量检索不意外启动 CLI。
  const tieredEnabled = !skipTiered
    && tieredReadiness.primaryReady === true
    && typeof tieredResearchFn === 'function';
  // timeoutMs 是单个检索源的预算；总预算按实际链路长度封顶，防止首个源
  // 用尽一个共享 signal 后，后续真实来源被立即取消。
  const totalController = new AbortController();
  const totalBudgetMs = perAttemptTimeoutMs * Math.max(
    1,
    configuredProviders.length + (tieredEnabled ? 1 : 0) + 2,
  );
  const totalTimer = setTimeout(() => totalController.abort(), totalBudgetMs);
  const failures = [];
  try {
    if (externalSignal?.aborted) return unavailableResult([], '调用方已取消');
    if (typeof fetchImpl !== 'function') return unavailableResult([], '检索客户端不可用');
    if (tieredEnabled) {
      const attempt = attemptSignal(perAttemptTimeoutMs, externalSignal, totalController.signal);
      try {
        const research = await tieredResearchFn(query, {
          maxResults: Math.max(5, Number(max) || 5),
          timeoutMs: perAttemptTimeoutMs,
          signal: attempt.signal,
          researchMode: 'simple_search',
        });
        const source = [
          ...(Array.isArray(research?.results) ? research.results : []),
          ...(Array.isArray(research?.fetchCandidates) ? research.fetchCandidates : []),
        ];
        const seen = new Set();
        const results = source
          .map(item => norm(item?.title, item?.url, item?.snippet || item?.body))
          .filter(item => {
            if (!item.title || !usableHttpUrl(item.url) || seen.has(item.url)) return false;
            seen.add(item.url);
            return true;
          })
          .slice(0, Math.max(1, Number(max) || 5));
        if (research?.ok === true && research?.candidateReady === true && results.length) {
          return {
            ok: true,
            provider: research.provider || 'TinyFish → Claude WebSearch',
            results,
            note: null,
            evidence: research.evidence || null,
          };
        }
        failures.push('TinyFish→Claude:质量门未通过');
      } catch (error) {
        if (externalSignal?.aborted) return unavailableResult(failures, '调用方已取消');
        if (totalController.signal.aborted && !attempt.timedOut()) {
          return unavailableResult(failures, '总预算超时');
        }
        failures.push(safeFailure('TinyFish→Claude', error, '分层联网检索服务').note);
      } finally {
        attempt.clear();
      }
    }
    for (const provider of configuredProviders) {
      const attempt = attemptSignal(perAttemptTimeoutMs, externalSignal, totalController.signal);
      try {
        const results = (await provider.search(query, max, attempt.signal, fetchImpl))
          .filter(r => r.title && usableHttpUrl(r.url))
          .slice(0, max);
        if (results.length) return { ok: true, provider: provider.name, results, note: null };
        failures.push(`${provider.name}:未命中`);
      } catch (e) {
        if (externalSignal?.aborted) return unavailableResult(failures, '调用方已取消');
        if (totalController.signal.aborted && !attempt.timedOut()) {
          return unavailableResult(failures, '总预算超时');
        }
        const { safe, note } = safeFailure(provider.name, e, `${provider.name}检索服务`);
        failures.push(note);
        console.warn(`[websearch] ${provider.name} 检索失败（${safe.message}），尝试下一检索源`);
      } finally {
        attempt.clear();
      }
    }
    // 趋势/新闻入口维持新闻优先；数字员工做地址、竞品、菜单、价格等业务
    // 调研时显式选择 web_first，避免“有相关新闻”抢占真正的网页搜索。
    const freeFallbacks = fallbackOrder === 'web_first'
      ? [
          {
            name: 'DuckDuckGo',
            service: 'DuckDuckGo检索服务',
            search: signal => ddgSearch(query, max, signal, fetchImpl),
          },
          {
            name: 'Google News RSS',
            service: 'Google News RSS检索服务',
            search: signal => googleNewsSearch(query, max, signal, fetchImpl),
          },
        ]
      : [
          {
            name: 'Google News RSS',
            service: 'Google News RSS检索服务',
            search: signal => googleNewsSearch(query, max, signal, fetchImpl),
          },
          {
            name: 'DuckDuckGo',
            service: 'DuckDuckGo检索服务',
            search: signal => ddgSearch(query, max, signal, fetchImpl),
          },
        ];
    for (const fallback of freeFallbacks) {
      const attempt = attemptSignal(perAttemptTimeoutMs, externalSignal, totalController.signal);
      try {
        const results = await fallback.search(attempt.signal);
        if (results.length) {
          return { ok: true, provider: fallback.name, results, note: null };
        }
        failures.push(`${fallback.name}:未命中`);
      } catch (e) {
        if (externalSignal?.aborted) return unavailableResult(failures, '调用方已取消');
        if (totalController.signal.aborted && !attempt.timedOut()) {
          return unavailableResult(failures, '总预算超时');
        }
        failures.push(safeFailure(fallback.name, e, fallback.service).note);
      } finally {
        attempt.clear();
      }
    }
    return unavailableResult(failures);
  } catch (e) {
    if (externalSignal?.aborted) return unavailableResult(failures, '调用方已取消');
    const reason = sanitizeProviderError(e, { service: '联网检索服务' }).message;
    return unavailableResult(failures, reason);
  } finally {
    clearTimeout(totalTimer);
  }
}

// 检索结果 → 提示词参考资料块（AI-H2：包进防注入边界，snippet 里的指令只会被当成引用文本）
import { wrapUntrusted } from './risk.js';
export function refsBlock(results = []) {
  if (!results.length) return '';
  return `\n【联网参考资料】（引用时标注[来源N]）\n` + wrapUntrusted('联网检索结果', results.map((r, i) =>
    `[来源${i + 1}] ${r.title}\n${r.snippet}\n链接：${r.url}`).join('\n'));
}
