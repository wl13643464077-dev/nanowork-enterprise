// 联网检索引擎（老板参谋「联网」开关，FR-ADV-07）
// 方案：DuckDuckGo HTML 轻量端点（无需 Key、无需配置），解析前 N 条标题/摘要/链接注入提示词。
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

export async function webSearch(query, { max = 5, timeoutMs = 9000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + '&kl=cn-zh', {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal: ctrl.signal,
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
    return { ok: true, results: out, note: out.length ? null : '检索成功但未命中结果' };
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
