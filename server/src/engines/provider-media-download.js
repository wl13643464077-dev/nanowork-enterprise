import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { isPublicWebAddress } from './controlled-web-evidence.js';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const failure = (message, code = 'PROVIDER_MEDIA_DOWNLOAD_FAILED', status = 502) => Object.assign(new Error(message), { code, status });

// Provider-signed query strings are intentionally allowed, but never logged or
// returned. This parser is not an authorization mechanism for user-supplied URLs.
export function parseProviderMediaUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw failure('供应商媒体地址无效'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !host || host === 'localhost' || !host.includes('.') && !isIP(host)
    || /\.(?:localhost|local|internal|home|arpa)$/u.test(host)
    || isIP(host) && !isPublicWebAddress(host)) {
    throw failure('供应商媒体必须使用安全的公网 HTTPS 地址', 'PROVIDER_MEDIA_URL_UNSAFE', 400);
  }
  url.hash = '';
  return url;
}

async function publicAddress(host, lookupFn, signal) {
  if (isIP(host)) return host;
  let onAbort;
  try {
    const records = await Promise.race([
      lookupFn(host, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        onAbort = () => reject(failure('供应商媒体下载已取消或超时'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
    if (!Array.isArray(records) || !records.length || records.some(r => !isPublicWebAddress(r?.address))) {
      throw failure('供应商媒体域名未解析到纯公网地址', 'PROVIDER_MEDIA_URL_UNSAFE', 400);
    }
    return records[0].address;
  } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

function nodeResponse(url, address, { requestFactory, signal }) {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  return new Promise((resolve, reject) => {
    const req = requestFactory({
      protocol: 'https:', hostname, port: 443, path: `${url.pathname}${url.search}`,
      method: 'GET', agent: false, signal,
      headers: { Accept: 'audio/*,video/*,application/octet-stream', 'Accept-Encoding': 'identity' },
      ...(isIP(hostname) ? {} : { servername: hostname }),
      lookup: (_hostname, options, callback) => {
        const record = { address, family: isIP(address) };
        if (options?.all) callback(null, [record]);
        else callback(null, address, record.family);
      },
    }, response => resolve({
      status: response.statusCode,
      headers: { get: name => response.headers[name.toLowerCase()] },
      body: response,
      cancel: () => response.destroy(),
    }));
    req.once('error', reject);
    req.end();
  });
}

/** Production uses a pinned HTTPS connection. fetchImpl/requestFactory are
 * trusted internal test adapters, never derived from HTTP request input. */
export async function fetchProviderMediaBytes(rawUrl, {
  kind = 'video', maxBytes = kind === 'audio' ? 15 * 1024 * 1024 : 180 * 1024 * 1024,
  timeoutMs = 120_000, signal, lookupFn = lookup, requestFactory = request, fetchImpl,
} = {}) {
  if (!['video', 'audio'].includes(kind) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 ** 3) {
    throw failure('媒体下载参数无效', 'PROVIDER_MEDIA_OPTIONS_INVALID', 500);
  }
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(300_000, Number(timeoutMs) || 120_000)));
  const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let current = parseProviderMediaUrl(rawUrl);
  try {
    for (let hop = 0; hop <= 3; hop += 1) {
      boundedSignal.throwIfAborted();
      const host = current.hostname.replace(/^\[|\]$/gu, '');
      // Injected fetch must not silently follow redirects. Production never
      // uses global fetch: checking DNS without pinning would permit rebinding.
      const response = fetchImpl
        ? await fetchImpl(current, { method: 'GET', redirect: 'manual', signal: boundedSignal, headers: { 'Accept-Encoding': 'identity' } })
        : await nodeResponse(current, await publicAddress(host, lookupFn, boundedSignal), { requestFactory, signal: boundedSignal });
      const cancel = async () => {
        if (response.cancel) response.cancel();
        else await response.body?.cancel?.().catch(() => {});
      };
      try {
        if (response.redirected) throw failure('下载适配器不得自动跟随重定向');
        if (REDIRECTS.has(Number(response.status))) {
          const location = response.headers?.get?.('location');
          if (!location || hop === 3) throw failure('供应商媒体重定向无效或次数过多');
          current = parseProviderMediaUrl(new URL(location, current));
          continue;
        }
        if (Number(response.status) !== 200) throw failure(`供应商媒体下载失败（HTTP ${Number(response.status) || '未知'}）`);
        const mime = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
        const encoding = String(response.headers?.get?.('content-encoding') || '').trim().toLowerCase();
        if (encoding && encoding !== 'identity') throw failure('供应商媒体不接受压缩传输');
        if (mime && !mime.startsWith(`${kind}/`) && mime !== 'application/octet-stream') throw failure('供应商媒体文件类型不符');
        if (Number(response.headers?.get?.('content-length')) > maxBytes) throw failure('供应商媒体超过安全大小上限', 'PROVIDER_MEDIA_TOO_LARGE', 413);
        if (!response.body?.[Symbol.asyncIterator]) throw failure('供应商媒体下载器缺少有界流式读取能力');
        const chunks = [];
        let count = 0;
        for await (const chunk of response.body) {
          boundedSignal.throwIfAborted();
          const bytes = Buffer.from(chunk);
          count += bytes.length;
          if (count > maxBytes) throw failure('供应商媒体超过安全大小上限', 'PROVIDER_MEDIA_TOO_LARGE', 413);
          chunks.push(bytes);
        }
        if (!count) throw failure('供应商媒体文件为空');
        return { bytes: Buffer.concat(chunks, count), contentType: mime || 'application/octet-stream' };
      } finally { await cancel(); }
    }
  } catch (error) {
    if (String(error?.code || '').startsWith('PROVIDER_MEDIA_')) throw error;
    throw failure(boundedSignal.aborted ? '供应商媒体下载已取消或超时' : '供应商媒体下载失败');
  }
}
