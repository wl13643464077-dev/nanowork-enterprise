import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isPublicWebAddress } from "./controlled-web-evidence.js";

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 40;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const SENSITIVE_PARAMETER =
  /^(?:api[_-]?key|access[_-]?token|authorization|auth|signature|secret|token|password|passwd|credential)$/iu;

export class ImageHuntError extends Error {
  constructor(message, status = 400, code = "IMAGEHUNT_INVALID_REQUEST") {
    super(message);
    this.name = "ImageHuntError";
    this.status = status;
    this.code = code;
  }
}

function strictDecode(value) {
  let current = String(value || "");
  for (let depth = 0; depth < 2; depth += 1) {
    const decoded = decodeURIComponent(current.replace(/\+/gu, "%20"));
    if (decoded === current) break;
    current = decoded;
  }
  return current;
}

function containsSensitiveUrlMaterial(parsed) {
  try {
    for (const key of parsed.searchParams.keys()) {
      if (SENSITIVE_PARAMETER.test(strictDecode(key))) return true;
    }
    const fragment = strictDecode(parsed.hash.slice(1));
    return /(?:^|[&;{\[,"'\s])(?:api[_-]?key|access[_-]?token|authorization|auth|signature|secret|token|password|passwd|credential)["']?\s*(?:=|:)/iu.test(
      fragment,
    );
  } catch {
    return true;
  }
}

export function parsePublicImageUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new ImageHuntError("图片URL格式无效", 400, "IMAGEHUNT_URL_INVALID");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const defaultPort = parsed.protocol === "https:" ? "443" : "80";
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !hostname ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== defaultPort) ||
    containsSensitiveUrlMaterial(parsed) ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home") ||
    hostname.endsWith(".arpa") ||
    (isIP(hostname) && !isPublicWebAddress(hostname))
  ) {
    throw new ImageHuntError(
      "图片URL协议、凭据、端口或主机不安全",
      400,
      "IMAGEHUNT_URL_UNSAFE",
    );
  }
  try {
    strictDecode(parsed.search.slice(1));
    strictDecode(parsed.hash.slice(1));
  } catch {
    throw new ImageHuntError(
      "图片URL包含无效编码",
      400,
      "IMAGEHUNT_URL_INVALID_ENCODING",
    );
  }
  parsed.hash = "";
  return parsed;
}

async function pinnedAddress(hostname, lookupFn = lookup) {
  if (isIP(hostname)) return hostname;
  const resolved = await lookupFn(hostname, { all: true, verbatim: true });
  if (
    !Array.isArray(resolved) ||
    !resolved.length ||
    resolved.some((item) => !isPublicWebAddress(item?.address))
  ) {
    throw new ImageHuntError(
      "图片域名没有解析到纯公网地址",
      400,
      "IMAGEHUNT_SSRF_BLOCKED",
    );
  }
  return resolved[0].address;
}

function imageTypeFromMagic(buffer) {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  )
    return "image/jpeg";
  if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (
    buffer.length >= 6 &&
    /^GIF8[79]a$/u.test(buffer.subarray(0, 6).toString("ascii"))
  )
    return "image/gif";
  return null;
}

export async function fetchPublicImageBytes(
  rawUrl,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = MAX_IMAGE_BYTES,
    redirectCount = 0,
    signal = null,
    lookupFn = lookup,
    requestFactory = null,
  } = {},
) {
  const parsed = parsePublicImageUrl(rawUrl);
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "");
  const address = await pinnedAddress(hostname, lookupFn);
  const makeRequest =
    requestFactory ||
    (parsed.protocol === "https:" ? httpsRequest : httpRequest);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const request = makeRequest(
      {
        protocol: parsed.protocol,
        hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname || "/"}${parsed.search}`,
        method: "GET",
        headers: {
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8",
          "Accept-Encoding": "identity",
          Host: parsed.host,
          "User-Agent": "NanoWork-ImageHunt/1.0",
        },
        ...(isIP(hostname) ? {} : { servername: hostname }),
        lookup: (_host, options, callback) => {
          const family = isIP(address);
          if (options?.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
        timeout: Math.max(250, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
      },
      (response) => {
        const status = Number(response.statusCode || 0);
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          if (redirectCount >= MAX_REDIRECTS || !response.headers.location) {
            finish(
              new ImageHuntError(
                "图片重定向次数过多或缺少目标",
                502,
                "IMAGEHUNT_REDIRECT_FAILED",
              ),
            );
            return;
          }
          let redirected;
          try {
            redirected = new URL(response.headers.location, parsed).toString();
          } catch {
            finish(
              new ImageHuntError(
                "图片重定向目标无效",
                502,
                "IMAGEHUNT_REDIRECT_FAILED",
              ),
            );
            return;
          }
          fetchPublicImageBytes(redirected, {
            timeoutMs,
            maxBytes,
            redirectCount: redirectCount + 1,
            signal,
            lookupFn,
            requestFactory,
          }).then((value) => finish(null, value), finish);
          return;
        }
        if (status !== 200) {
          response.resume();
          finish(
            new ImageHuntError(
              `图片来源返回HTTP ${status || "未知状态"}`,
              502,
              "IMAGEHUNT_HTTP_FAILED",
            ),
          );
          return;
        }
        const contentType = String(response.headers["content-type"] || "")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (!IMAGE_TYPES.has(contentType)) {
          response.resume();
          finish(
            new ImageHuntError(
              "远程内容不是允许的图片格式",
              415,
              "IMAGEHUNT_MIME_INVALID",
            ),
          );
          return;
        }
        const declared = Number(response.headers["content-length"] || 0);
        if (declared > maxBytes) {
          response.resume();
          finish(
            new ImageHuntError(
              "远程图片超过大小上限",
              413,
              "IMAGEHUNT_TOO_LARGE",
            ),
          );
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            request.destroy(
              new ImageHuntError(
                "远程图片超过大小上限",
                413,
                "IMAGEHUNT_TOO_LARGE",
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.once("aborted", () =>
          finish(
            new ImageHuntError(
              "图片连接提前中断",
              502,
              "IMAGEHUNT_RESPONSE_ABORTED",
            ),
          ),
        );
        response.once("error", (error) => finish(error));
        response.once("end", () => {
          const buffer = Buffer.concat(chunks);
          const magicType = imageTypeFromMagic(buffer);
          if (!magicType || magicType !== contentType) {
            finish(
              new ImageHuntError(
                "图片响应头与文件内容不一致",
                415,
                "IMAGEHUNT_MAGIC_INVALID",
              ),
            );
            return;
          }
          finish(null, {
            buffer,
            mimeType: magicType,
            byteSize: buffer.length,
            finalUrl: parsed.href,
          });
        });
      },
    );
    const onAbort = () =>
      request.destroy(
        new ImageHuntError("图片读取已取消", 499, "IMAGEHUNT_ABORTED"),
      );
    signal?.addEventListener?.("abort", onAbort, { once: true });
    request.once("timeout", () =>
      request.destroy(
        new ImageHuntError("图片读取超时", 504, "IMAGEHUNT_TIMEOUT"),
      ),
    );
    request.once("error", (error) => finish(error));
    request.end();
  });
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/giu, '"')
    .replace(/&amp;/giu, "&")
    .replace(/&#39;|&#x27;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

export function parseBingImageResults(html) {
  const rows = [];
  for (const match of String(html || "").matchAll(
    /<a[^>]+class=["'][^"']*iusc[^"']*["'][^>]+m=["']([^"']+)["']/giu,
  )) {
    try {
      const item = JSON.parse(decodeHtml(match[1]));
      rows.push({
        title: String(item.t || item.desc || "Bing图片结果"),
        imageUrl: item.murl,
        thumbnailUrl: item.turl || item.murl,
        sourceUrl: item.purl || null,
        provider: "bing",
      });
    } catch {
      /* a malformed provider item is ignored */
    }
  }
  return rows;
}

export function parseBaiduImageResults(payload) {
  const data = typeof payload === "string" ? JSON.parse(payload) : payload;
  return (Array.isArray(data?.data) ? data.data : []).map((item) => ({
    title: String(
      item.fromPageTitleEnc || item.fromPageTitle || "百度图片结果",
    ),
    imageUrl: item.middleURL || item.hoverURL || item.objURL || item.thumbURL,
    thumbnailUrl: item.thumbURL || item.middleURL,
    sourceUrl: item.fromURL || item.pageNum || null,
    provider: "baidu",
  }));
}

export function parseSoImageResults(payload) {
  const data = typeof payload === "string" ? JSON.parse(payload) : payload;
  const list = Array.isArray(data?.list)
    ? data.list
    : Array.isArray(data?.data)
      ? data.data
      : [];
  return list.map((item) => ({
    title: String(item.title || item.desc || "360图片结果"),
    imageUrl: item.img || item.imgurl || item.objurl,
    thumbnailUrl: item.thumb || item.thumburl || item.img,
    sourceUrl: item.link || item.url || null,
    provider: "so360",
  }));
}

function cleanCandidate(candidate) {
  let image;
  let thumbnail;
  try {
    image = parsePublicImageUrl(candidate?.imageUrl).href;
    thumbnail = parsePublicImageUrl(candidate?.thumbnailUrl || image).href;
  } catch {
    return null;
  }
  let sourceUrl = null;
  if (candidate?.sourceUrl) {
    try {
      sourceUrl = parsePublicImageUrl(candidate.sourceUrl).href;
    } catch {
      sourceUrl = null;
    }
  }
  return {
    title: String(candidate?.title || "图片搜索结果")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 200),
    imageUrl: image,
    thumbnailUrl: thumbnail,
    sourceUrl,
    provider: String(candidate?.provider || "unknown").slice(0, 40),
    rights: {
      status: "unverified",
      commercialUse: false,
      note: "搜索结果只用于候选预览；导入商用前必须人工确认版权、授权与署名要求。",
    },
  };
}

async function defaultSearchProviders(
  query,
  { fetchImpl = fetch, signal = null } = {},
) {
  const encoded = encodeURIComponent(query);
  const requests = [
    fetchImpl(`https://www.bing.com/images/search?q=${encoded}&form=HDRSC2`, {
      signal,
      headers: { "User-Agent": "Mozilla/5.0 NanoWork-ImageHunt/1.0" },
    }).then(async (response) =>
      response.ok ? parseBingImageResults(await response.text()) : [],
    ),
    fetchImpl(
      `https://image.baidu.com/search/acjson?tn=resultjson_com&word=${encoded}&pn=0&rn=30`,
      {
        signal,
        headers: { "User-Agent": "Mozilla/5.0 NanoWork-ImageHunt/1.0" },
      },
    ).then(async (response) =>
      response.ok ? parseBaiduImageResults(await response.json()) : [],
    ),
    fetchImpl(`https://image.so.com/j?q=${encoded}&sn=0&pn=30`, {
      signal,
      headers: { "User-Agent": "Mozilla/5.0 NanoWork-ImageHunt/1.0" },
    }).then(async (response) =>
      response.ok ? parseSoImageResults(await response.json()) : [],
    ),
  ];
  const settled = await Promise.allSettled(requests);
  return settled.flatMap((entry) =>
    entry.status === "fulfilled" ? entry.value : [],
  );
}

export async function searchImageHunt(
  query,
  {
    limit = DEFAULT_LIMIT,
    signal = null,
    fetchImpl = fetch,
    searchProvidersFn = defaultSearchProviders,
  } = {},
) {
  const normalizedQuery = String(query || "")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalizedQuery.length < 2 || normalizedQuery.length > 200) {
    throw new ImageHuntError("搜索词长度必须为2-200字");
  }
  const boundedLimit = Math.max(
    1,
    Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT),
  );
  const raw = await searchProvidersFn(normalizedQuery, { fetchImpl, signal });
  const results = [];
  const seen = new Set();
  for (const candidate of Array.isArray(raw) ? raw : []) {
    const cleaned = cleanCandidate(candidate);
    if (!cleaned || seen.has(cleaned.imageUrl)) continue;
    seen.add(cleaned.imageUrl);
    results.push(cleaned);
    if (results.length >= boundedLimit) break;
  }
  return {
    query: normalizedQuery,
    results,
    providerCount: new Set(results.map((item) => item.provider)).size,
    rightsVerified: false,
    externalCall: true,
  };
}
