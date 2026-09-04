import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { tinyfishAvailable, tinyfishFetchPages } from './tinyfish.js';

const MAX_REDIRECTS = 3;
const MAX_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const TEXT_TYPES = /^(?:text\/(?:html|plain)|application\/(?:xhtml\+xml|json|ld\+json))(?:;|$)/iu;
const SENSITIVE_QUERY_NAME = /^(?:api[_-]?key|access[_-]?token|authorization|auth|signature|secret|token|password|passwd|credential)$/iu;

function sensitiveFragment(parsed) {
  try {
    let hash = parsed.hash.slice(1);
    for (let depth = 0; depth < 2; depth += 1) {
      const decoded = decodeURIComponent(hash);
      if (decoded === hash) break;
      hash = decoded;
    }
    return /(?:^|[&;{\[,"'\s])(?:api[_-]?key|access[_-]?token|authorization|auth|signature|secret|token|password|passwd|credential)["']?\s*(?:=|:)/iu.test(hash);
  } catch {
    return true;
  }
}

function sensitiveQuery(parsed) {
  return [...parsed.searchParams.keys()].some(key => {
    let decoded = key;
    try {
      for (let depth = 0; depth < 2; depth += 1) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
    } catch {
      return true;
    }
    return SENSITIVE_QUERY_NAME.test(decoded);
  });
}

function malformedEncodedUrlMaterial(parsed) {
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

function clashFakeIpAddress(address) {
  const normalized = String(address || '').toLowerCase().replace(/^\[|\]$/gu, '');
  const ipv4 = isIP(normalized) === 4 ? normalized : mappedIpv4(normalized);
  if (!ipv4) return false;
  const [a, b] = ipv4.split('.').map(Number);
  return a === 198 && (b === 18 || b === 19);
}

export function isPublicWebAddress(address) {
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

function auditFailureTarget(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
    const privateHost = hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || hostname.endsWith('.internal')
      || hostname.endsWith('.home')
      || hostname.endsWith('.arpa')
      || (isIP(hostname) && !isPublicWebAddress(hostname));
    return { host: privateHost ? 'private_or_invalid' : hostname || 'invalid' };
  } catch {
    return { host: 'invalid' };
  }
}

function parsePublicUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl || '').trim()); } catch {
    throw Object.assign(new Error('公开来源URL格式无效'), { code: 'CONTROLLED_WEB_URL_UNSAFE' });
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username || parsed.password || !hostname
    || malformedEncodedUrlMaterial(parsed)
    || sensitiveQuery(parsed)
    || sensitiveFragment(parsed)
    || (parsed.port && parsed.port !== defaultPort)
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.home')
    || hostname.endsWith('.arpa')) {
    throw Object.assign(new Error('公开来源URL协议、凭据、端口或主机不安全'), { code: 'CONTROLLED_WEB_URL_UNSAFE' });
  }
  if (isIP(hostname) && !isPublicWebAddress(hostname)) {
    throw Object.assign(new Error('公开来源URL指向本机或非公网地址'), { code: 'CONTROLLED_WEB_URL_UNSAFE' });
  }
  parsed.hash = '';
  return parsed;
}

async function pinnedAddress(hostname, lookupFn = lookup) {
  if (isIP(hostname)) {
    if (!isPublicWebAddress(hostname)) {
      throw Object.assign(new Error('公开来源域名未解析到纯公网地址'), { code: 'CONTROLLED_WEB_SSRF_BLOCKED' });
    }
    return hostname;
  }
  const addresses = await lookupFn(hostname, { all: true, verbatim: true });
  const values = (Array.isArray(addresses) ? addresses : [])
    .map(item => item?.address)
    .filter(Boolean);
  if (!values.length) {
    throw Object.assign(new Error('公开来源域名未解析到纯公网地址'), { code: 'CONTROLLED_WEB_SSRF_BLOCKED' });
  }
  const publicAddress = values.find(isPublicWebAddress);
  if (publicAddress) return publicAddress;
  // Clash/同类透明代理会把公开域名解析到 198.18.0.0/15 fake-ip。
  // IP 字面量仍拒绝；仅当 FQDN 的全部记录都是 fake-ip 时才钉住该地址，
  // 避免把混有 RFC1918/回环的解析当成可抓取来源。
  if (values.every(clashFakeIpAddress)) return values[0];
  throw Object.assign(new Error('公开来源域名未解析到纯公网地址'), { code: 'CONTROLLED_WEB_SSRF_BLOCKED' });
}

function decodeEntity(value) {
  return String(value || '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#(?:39|x27);/giu, "'")
    .replace(/&#(\d+);/gu, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

const PUBLISHED_AT_META_PATTERNS = [
  /<meta[^>]+(?:property|name)=["'](?:article:published_time|og:article:published_time|article:modified_time|og:updated_time|pubdate|publishdate|publish_date|publication_date|dc\.date(?:\.issued)?|datePublished|date|weibo:article:create_at|og:release_date)["'][^>]+content=["']([^"']+)["']/iu,
  /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:article:published_time|og:article:published_time|pubdate|publishdate|publish_date|publication_date|datePublished)["']/iu,
  /"datePublished"\s*:\s*"([^"]+)"/iu,
  /<time[^>]+datetime=["']([^"']+)["']/iu,
];

/**
 * 从公开网页元数据中提取发布时间；只接受可解析且不晚于当前时间+1天的
 * 时间戳，解析失败一律返回 null，绝不用抓取时间冒充发布时间。
 */
export function extractPublishedAt(rawHtml) {
  const html = String(rawHtml || '');
  for (const pattern of PUBLISHED_AT_META_PATTERNS) {
    const match = html.match(pattern);
    if (!match) continue;
    const candidate = decodeEntity(match[1]).trim();
    const normalized = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/u.test(candidate)
      ? candidate.replace(/[/.]/gu, '-').replace(' ', 'T')
      : candidate;
    const parsed = Date.parse(normalized);
    if (!Number.isFinite(parsed)) continue;
    if (parsed > Date.now() + 24 * 60 * 60 * 1000 || parsed < Date.parse('1995-01-01T00:00:00Z')) continue;
    return new Date(parsed).toISOString();
  }
  return null;
}

function pageEvidence(buffer, contentType, finalUrl) {
  const charset = String(contentType || '').match(/charset\s*=\s*["']?([^;"'\s]+)/iu)?.[1] || 'utf-8';
  let raw;
  try { raw = new TextDecoder(charset).decode(buffer); } catch { raw = new TextDecoder('utf-8').decode(buffer); }
  const title = decodeEntity(
    raw.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/iu)?.[1]
      || raw.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/iu)?.[1]
      || '',
  ).replace(/\s+/gu, ' ').trim().slice(0, 220);
  const publishedAt = extractPublishedAt(raw);
  const text = decodeEntity(raw
    .replace(/<(?:script|style|noscript|template|svg|canvas)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template|svg|canvas)\s*>/giu, ' ')
    .replace(/<\/(?:p|div|article|section|li|h[1-6]|tr|br)\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' '))
    .replace(/[\t\r ]+/gu, ' ')
    .replace(/ *\n+ */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
    .slice(0, 3000);
  if (text.length < 80) {
    throw Object.assign(new Error('公开网页没有形成足够正文证据'), { code: 'CONTROLLED_WEB_BODY_EMPTY' });
  }
  return {
    title: title || new URL(finalUrl).hostname,
    url: finalUrl,
    snippet: text.slice(0, 1200),
    body: text,
    publishedAt,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchPublicPageEvidence(rawUrl, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_BYTES,
  redirectCount = 0,
  signal = null,
  lookupFn = lookup,
} = {}) {
  const parsed = parsePublicUrl(rawUrl);
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '');
  const address = await pinnedAddress(hostname, lookupFn);
  const requestFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const request = requestFn({
      protocol: parsed.protocol,
      hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname || '/'}${parsed.search}`,
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8',
        'Accept-Encoding': 'identity',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
        Host: parsed.host,
        'User-Agent': 'NanoWork-Public-Evidence/1.0',
      },
      ...(isIP(hostname) ? {} : { servername: hostname }),
      lookup: (_host, options, callback) => {
        const family = isIP(address);
        // Node 20+ 的 http(s) 客户端可能以 all:true 请求地址列表以支持
        // autoSelectFamily。固定DNS防重绑定时必须同时实现两种回调形状；
        // 否则单个字符串会被当成地址数组并抛 ERR_INVALID_IP_ADDRESS。
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
      timeout: Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
    }, response => {
      const status = Number(response.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        if (redirectCount >= MAX_REDIRECTS || !response.headers.location) {
          finish(Object.assign(new Error('公开网页重定向次数过多或缺少目标'), { code: 'CONTROLLED_WEB_REDIRECT_FAILED' }));
          return;
        }
        let redirected;
        try { redirected = new URL(response.headers.location, parsed).toString(); } catch {
          finish(Object.assign(new Error('公开网页重定向目标无效'), { code: 'CONTROLLED_WEB_REDIRECT_FAILED' }));
          return;
        }
        fetchPublicPageEvidence(redirected, {
          timeoutMs, maxBytes, redirectCount: redirectCount + 1, signal, lookupFn,
        }).then(value => finish(null, value), finish);
        return;
      }
      if (status !== 200) {
        response.resume();
        finish(Object.assign(new Error(`公开网页返回HTTP ${status || '未知状态'}`), { code: 'CONTROLLED_WEB_HTTP_FAILED' }));
        return;
      }
      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      if (!TEXT_TYPES.test(contentType)) {
        response.resume();
        finish(Object.assign(new Error('公开来源不是可读取的文本网页'), { code: 'CONTROLLED_WEB_MIME_INVALID' }));
        return;
      }
      const declared = Number(response.headers['content-length'] || 0);
      if (declared > maxBytes) {
        response.resume();
        finish(Object.assign(new Error('公开网页超过读取大小上限'), { code: 'CONTROLLED_WEB_TOO_LARGE' }));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.once('aborted', () => finish(Object.assign(
        new Error('公开网页在正文读取完成前中断连接'),
        { code: 'CONTROLLED_WEB_RESPONSE_ABORTED' },
      )));
      response.once('error', error => finish(Object.assign(
        new Error('公开网页正文读取失败'),
        { code: error?.code || 'CONTROLLED_WEB_RESPONSE_FAILED' },
      )));
      response.once('close', () => {
        if (!response.complete) finish(Object.assign(
          new Error('公开网页连接提前关闭'),
          { code: 'CONTROLLED_WEB_RESPONSE_ABORTED' },
        ));
      });
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          request.destroy(Object.assign(new Error('公开网页超过读取大小上限'), { code: 'CONTROLLED_WEB_TOO_LARGE' }));
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => {
        try { finish(null, pageEvidence(Buffer.concat(chunks), contentType, parsed.href)); }
        catch (error) { finish(error); }
      });
    });
    const onAbort = () => request.destroy(Object.assign(new Error('公开网页读取已取消'), { code: 'CONTROLLED_WEB_ABORTED' }));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    request.once('timeout', () => request.destroy(Object.assign(new Error('公开网页读取超时'), { code: 'CONTROLLED_WEB_TIMEOUT' })));
    request.once('error', error => finish(error));
    request.end();
  });
}

export async function fetchControlledWebEvidence(sources, {
  limit = 4,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal = null,
  fetchPageFn = fetchPublicPageEvidence,
  tinyfishFetchFn = tinyfishFetchPages,
} = {}) {
  const urls = [...new Set((Array.isArray(sources) ? sources : [])
    .map(source => String(source?.url || '').trim()).filter(Boolean))]
    .slice(0, Math.max(1, Math.min(8, Number(limit) || 4)));
  const results = [];
  const failures = [];
  let usedTinyfish = false;
  let usedLocalFetch = false;
  // 剩余待抓 URL：TinyFish（真浏览器渲染，JS 重的页面也能拿到正文）优先，
  // 失败或未覆盖的 URL 回落自研裸 HTTP 抓取。安全口径不降：URL 一律先过
  // parsePublicUrl 白检（协议/凭据/端口/内网主机拦截）再交给任一内核。
  let pending = [];
  for (const url of urls) {
    try {
      pending.push(parsePublicUrl(url).href);
    } catch (error) {
      failures.push({ ...auditFailureTarget(url), code: error?.code || 'CONTROLLED_WEB_URL_UNSAFE' });
    }
  }
  if (pending.length && tinyfishAvailable()) {
    try {
      const batch = await tinyfishFetchFn(pending, { signal, purpose: '为门店经营调研核验公开网页正文' });
      const got = new Set();
      const pendingSet = new Set(pending);
      for (const page of Array.isArray(batch?.results) ? batch.results : []) {
        try {
          const requestedUrl = parsePublicUrl(page?.requestedUrl || page?.url).href;
          const finalUrl = parsePublicUrl(page?.url).href;
          if (!pendingSet.has(requestedUrl)) continue;
          results.push({ ...page, url: finalUrl, requestedUrl });
          got.add(requestedUrl);
          got.add(finalUrl);
        } catch { /* TinyFish 输出再次经过静态公开URL边界，异常项直接丢弃 */ }
      }
      // 同时记录 requestedUrl 与 final_url，跟随重定向成功后不能再重复裸抓原地址。
      pending = pending.filter(url => !got.has(url));
      usedTinyfish = results.length > 0;
    } catch {
      // TinyFish 整批失败（节流/网络）：全部回落自研内核，不记失败噪音
    }
  }
  if (pending.length) {
    usedLocalFetch = true;
    const settled = await Promise.allSettled(pending.map(url => fetchPageFn(url, { timeoutMs, signal })));
    settled.forEach((entry, index) => {
      if (entry.status === 'fulfilled') results.push(entry.value);
      else failures.push({
        ...auditFailureTarget(pending[index]),
        code: entry.reason?.code || 'CONTROLLED_WEB_FETCH_FAILED',
      });
    });
  }
  return {
    attempted: urls.length > 0,
    ok: results.length > 0,
    provider: usedTinyfish
      ? usedLocalFetch
        ? 'TinyFish Fetch + NanoWork controlled WebFetch'
        : 'TinyFish Fetch'
      : 'NanoWork controlled WebFetch',
    results,
    note: results.length ? null : '已检索到来源，但受控网页正文核验未取得有效文本',
    evidence: {
      schemaVersion: 'nanowork.controlled-web-evidence/1',
      requested: urls.length,
      fetched: results.length,
      failures,
      externalCall: urls.length > 0,
      // TinyFish 只接收已通过静态公开URL边界的目标，实际出网发生在供应商
      // 一侧，不会让本服务连接候选主机；本地回落则额外执行DNS钉住。
      ssrfProtected: true,
      // 自研抓取会逐跳重新做URL与DNS校验；TinyFish只可核验请求URL和最终
      // 返回URL，无法证明供应商内部每个中间跳，因此含TinyFish产物时不虚报。
      redirectsRevalidated: !usedTinyfish,
      rawResponseStored: false,
      extractedTextStored: true,
      renderedFetch: usedTinyfish,
    },
  };
}
