// 联网检索引擎（老板参谋「联网」开关，FR-ADV-07）
// 多源链路：按已配置的 API Key 依次尝试 博查 → Tavily → Serper，全部未配置或失败时
// 兜底 DuckDuckGo HTML 解析（注意：DDG 在中国大陆网络环境通常不可达，正式部署请配置
// 至少一个商业检索源：BOCHA_API_KEY / TAVILY_API_KEY / SERPER_API_KEY）。
// 失败安全：超时/网络受限时返回空数组并附 note，不阻塞会诊主流程。
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function strip(html = '') {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
function realUrl(href = '') {
  // DDG 跳转链：//duckduckgo.com/l/?uddg=<encoded>&rut=...
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return href; } }
  return href.startsWith('//') ? 'https:' + href : href;
}

async function fetchJson(url, { headers = {}, body, signal }) {
  const resp = await fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

const norm = (title, url, snippet) => ({
  title: String(title || '').trim(),
  url: String(url || '').trim(),
  snippet: String(snippet || '').replace(/\s+/g, ' ').trim().slice(0, 160),
});

// 各商业源适配器：返回统一 [{title,url,snippet}]
const PROVIDERS = [
  {
    name: '博查',
    key: () => process.env.BOCHA_API_KEY,
    async search(query, max, signal) {
      const data = await fetchJson('https://api.bochaai.com/v1/web-search', {
        headers: { Authorization: `Bearer ${process.env.BOCHA_API_KEY}` },
        body: { query, count: max, summary: true }, signal,
      });
      return (data?.data?.webPages?.value || []).map(v => norm(v.name, v.url, v.summary || v.snippet));
    },
  },
  {
    name: 'Tavily',
    key: () => process.env.TAVILY_API_KEY,
    async search(query, max, signal) {
      const data = await fetchJson('https://api.tavily.com/search', {
        headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
        body: { query, max_results: max }, signal,
      });
      return (data?.results || []).map(v => norm(v.title, v.url, v.content));
    },
  },
  {
    name: 'Serper',
    key: () => process.env.SERPER_API_KEY,
    async search(query, max, signal) {
      const data = await fetchJson('https://google.serper.dev/search', {
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY },
        body: { q: query, num: max, gl: 'cn', hl: 'zh-cn' }, signal,
      });
      return (data?.organic || []).map(v => norm(v.title, v.link, v.snippet));
    },
  },
];

async function ddgSearch(query, max, signal) {
  const resp = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + '&kl=cn-zh', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal,
  });
  const html = await resp.text();
  const out = [];
  const blocks = html.split(/class="result results_links/).slice(1);
  for (const b of blocks) {
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const sn = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const url = realUrl(a[1]);
    const title = strip(a[2]);
    if (!title || /duckduckgo\.com/.test(url)) continue;
    out.push({ title, url, snippet: strip(sn ? sn[1] : '').slice(0, 160) });
    if (out.length >= max) break;
  }
  return out;
}

export function webSearchProviders() {
  return PROVIDERS.filter(p => p.key()).map(p => p.name);
}

export async function webSearch(query, { max = 5, timeoutMs = 9000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const failures = [];
  try {
    for (const provider of PROVIDERS) {
      if (!provider.key()) continue;
      try {
        const results = (await provider.search(query, max, ctrl.signal)).filter(r => r.title && r.url).slice(0, max);
        return { ok: true, provider: provider.name, results, note: results.length ? null : '检索成功但未命中结果' };
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        failures.push(`${provider.name}:${e.message}`);
        console.warn(`[websearch] ${provider.name} 检索失败（${e.message}），尝试下一检索源`);
      }
    }
    // 兜底：DDG（无 Key 可用，但国内网络通常不可达）
    const results = await ddgSearch(query, max, ctrl.signal);
    return {
      ok: true, provider: 'DuckDuckGo', results,
      note: results.length ? null : (failures.length ? `商业检索源失败（${failures.join('；')}），兜底源亦未命中` : '检索成功但未命中结果；建议配置 BOCHA_API_KEY 等商业检索源'),
    };
  } catch (e) {
    return { ok: false, results: [], note: `联网检索暂不可用（${e.name === 'AbortError' ? '超时' : e.message}），本次按内部数据作答` };
  } finally { clearTimeout(timer); }
}

// 检索结果 → 提示词参考资料块（AI-H2：包进防注入边界，snippet 里的指令只会被当成引用文本）
import { wrapUntrusted } from './risk.js';
export function refsBlock(results = []) {
  if (!results.length) return '';
  return `\n【联网参考资料】（引用时标注[来源N]）\n` + wrapUntrusted('联网检索结果', results.map((r, i) =>
    `[来源${i + 1}] ${r.title}\n${r.snippet}\n链接：${r.url}`).join('\n'));
}
