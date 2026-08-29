import { isIP } from "node:net";

import { isPublicWebAddress } from "./controlled-web-evidence.js";

export const KLING_AVATAR_BASE_URL = "https://yunwu.ai";
export const KLING_AVATAR_MODEL = "kling-avatar-image2video";

const AVATAR_PATH = "/kling/v1/videos/avatar/image2video";
const DEFAULT_MODE = "pro";
const DEFAULT_POLL_INTERVAL_MS = 12_000;
const DEFAULT_POLL_TIMEOUT_MS = 25 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const SAFE_ERROR = Symbol("nanowork.kling-avatar.safe-error");
const SAFE_ID = /^[a-z0-9._:-]{1,200}$/iu;

export class KlingAvatarError extends Error {
  constructor(message, { status = 502, code = "KLING_AVATAR_FAILED" } = {}) {
    super(message);
    this.name = "KlingAvatarError";
    Object.defineProperties(this, {
      status: { value: status, enumerable: true },
      code: { value: code, enumerable: true },
      provider: { value: "kling", enumerable: true },
      [SAFE_ERROR]: { value: true },
    });
  }
}

function failure(message, code, status = 502) {
  return new KlingAvatarError(message, { code, status });
}

function missingCredentials() {
  return failure(
    "可灵数字人通道未配置云雾服务端凭据",
    "PROVIDER_CREDENTIALS_MISSING",
    503,
  );
}

function cancelled() {
  return failure("可灵数字人任务已取消", "KLING_AVATAR_CANCELLED", 499);
}

function abortIfRequested(signal) {
  if (signal?.aborted) throw cancelled();
}

function configured(options) {
  try {
    return typeof options.config === "function"
      ? options.config() || {}
      : options.config || {};
  } catch {
    throw failure(
      "可灵数字人服务端配置无法读取",
      "KLING_AVATAR_CONFIG_INVALID",
      500,
    );
  }
}

function strictDecode(value) {
  let decoded = String(value || "");
  for (let depth = 0; depth < 2; depth += 1) {
    const next = decodeURIComponent(decoded.replace(/\+/gu, "%20"));
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded.includes("�")) throw new URIError("invalid encoding");
  return decoded;
}

function privateHost(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  return (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home") ||
    host.endsWith(".arpa") ||
    (!isIP(host) && !host.includes(".")) ||
    (isIP(host) && !isPublicWebAddress(host))
  );
}

function safeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || KLING_AVATAR_BASE_URL).trim());
    strictDecode(parsed.pathname);
  } catch {
    throw failure(
      "可灵数字人服务端地址配置无效",
      "KLING_AVATAR_CONFIG_INVALID",
      500,
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    parsed.search ||
    parsed.hash ||
    privateHost(parsed.hostname)
  ) {
    throw failure(
      "可灵数字人服务端地址配置无效",
      "KLING_AVATAR_CONFIG_INVALID",
      500,
    );
  }
  // YUNWU_BASE_URL is commonly the OpenAI-compatible `/v1` root. Kling's
  // provider-specific route is rooted beside that path, as in the golden app.
  parsed.pathname = parsed.pathname.replace(/\/v1\/?$/u, "/");
  return parsed.href.replace(/\/+$/gu, "");
}

function parsePublicHttpsUrl(
  value,
  { code, message, apiKey = "", status = 400 },
) {
  const raw = String(value || "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
    strictDecode(parsed.pathname);
    strictDecode(parsed.search.slice(1));
  } catch {
    throw failure(message, code, status);
  }
  if (
    raw.length > 8_192 ||
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    parsed.hash ||
    privateHost(parsed.hostname) ||
    (apiKey && raw.includes(apiKey))
  ) {
    throw failure(message, code, status);
  }
  return parsed.href;
}

export function parseKlingPublicAssetUrl(value) {
  return parsePublicHttpsUrl(value, {
    code: "KLING_AVATAR_PUBLIC_URL_UNSAFE",
    message: "可灵数字人素材必须使用安全的公网 HTTPS 地址",
  });
}

export function parseKlingVideoUrl(value) {
  return parsePublicHttpsUrl(value, {
    code: "KLING_AVATAR_OUTPUT_UNSAFE",
    message: "可灵数字人成片地址未通过安全校验",
    status: 502,
  });
}

function safeProviderId(value, apiKey) {
  const id = String(value || "").trim();
  return SAFE_ID.test(id) && !(apiKey && id.includes(apiKey)) ? id : "";
}

function safeMode(value, apiKey) {
  const mode = String(value || DEFAULT_MODE).trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,30}$/u.test(mode) || (apiKey && mode.includes(apiKey))) {
    throw failure(
      "可灵数字人模式配置无效",
      "KLING_AVATAR_CONFIG_INVALID",
      500,
    );
  }
  return mode;
}

function safePrompt(value) {
  return Array.from(
    String(value || "")
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  )
    .slice(0, 200)
    .join("");
}

function positiveInteger(value, fallback, { min = 1, max = 86_400_000 } = {}) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function safeNow(now) {
  try {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function notify(onProgress, event) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress(Object.freeze({ ...event }));
  } catch {
    // Progress listeners are observational and cannot break provider work.
  }
}

async function delay(ms, { sleep, signal }) {
  abortIfRequested(signal);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(cancelled());
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  try {
    await Promise.race([Promise.resolve().then(() => sleep(ms)), aborted]);
    abortIfRequested(signal);
  } catch (error) {
    if (error?.[SAFE_ERROR]) throw error;
    if (signal?.aborted || error?.name === "AbortError") throw cancelled();
    throw failure("可灵数字人任务等待失败", "KLING_AVATAR_WAIT_FAILED");
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
  }
}

function pricingEvidence(pricing, networkRequests, apiKey) {
  const configuredAmount = Number(pricing?.amount);
  const estimated = Number.isFinite(configuredAmount) && configuredAmount >= 0;
  const requestedSource = String(
    pricing?.source || "server_configured_estimate",
  ).slice(0, 80);
  const source =
    estimated && !(apiKey && requestedSource.includes(apiKey))
      ? requestedSource
      : estimated
        ? "server_configured_estimate"
        : "kling_response_does_not_report_cost";
  return Object.freeze({
    amount: estimated ? configuredAmount : null,
    currency: estimated ? "CNY" : null,
    estimated,
    providerReported: false,
    source,
    pricingMode: estimated ? "configured_estimate" : "provider_not_reported",
    networkRequests,
  });
}

/**
 * Yunwu/Kling avatar boundary. Kling fetches media itself, so only explicitly
 * published, statically safe HTTPS asset URLs may cross this provider boundary.
 */
export function createKlingAvatarClient(options = {}) {
  const config = configured(options);
  const apiKey = String(
    options.apiKey ??
      config.apiKey ??
      config.key ??
      config.yunwuApiKey ??
      config.yunwu_api_key ??
      process.env.YUNWU_API_KEY ??
      "",
  ).trim();
  const root = safeBaseUrl(
    options.baseUrl ??
      config.baseUrl ??
      config.yunwuBaseUrl ??
      config.yunwu_base_url ??
      process.env.YUNWU_BASE_URL,
  );
  const fetchImpl =
    options.fetchImpl ?? options.fetchFn ?? options.fetch ?? globalThis.fetch;
  const sleep =
    options.sleep ??
    options.sleepFn ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? options.nowFn ?? Date.now;
  const mode = safeMode(options.mode ?? config.mode, apiKey);
  const requestTimeoutMs = positiveInteger(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    { min: 1, max: 30 * 60 * 1000 },
  );
  const pollIntervalMs = positiveInteger(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    { min: 1, max: 5 * 60 * 1000 },
  );
  const pollTimeoutMs = positiveInteger(
    options.pollTimeoutMs,
    DEFAULT_POLL_TIMEOUT_MS,
    { min: 1, max: 24 * 60 * 60 * 1000 },
  );
  const maxPollAttempts = positiveInteger(
    options.maxPollAttempts,
    Math.max(1, Math.ceil(pollTimeoutMs / pollIntervalMs)),
    { min: 1, max: 10_000 },
  );
  const configuredModel = String(
    options.model ?? config.model ?? KLING_AVATAR_MODEL,
  )
    .trim()
    .slice(0, 120);
  const model =
    configuredModel && !(apiKey && configuredModel.includes(apiKey))
      ? configuredModel
      : KLING_AVATAR_MODEL;
  const pricing =
    options.pricing ??
    config.pricing ??
    (options.costCny !== undefined || config.costCny !== undefined
      ? {
          amount: options.costCny ?? config.costCny,
          source: "server_configured_estimate",
        }
      : null);

  async function requestJson(pathname, init, signal, counters) {
    if (!apiKey) throw missingCredentials();
    abortIfRequested(signal);
    if (typeof fetchImpl !== "function") {
      throw failure(
        "可灵数字人通道缺少 HTTP 客户端",
        "KLING_AVATAR_TRANSPORT_MISSING",
        503,
      );
    }
    const controller = new AbortController();
    let rejectBoundary;
    let boundaryError = null;
    const boundary = new Promise((_, reject) => {
      rejectBoundary = reject;
    });
    const failBoundary = (error) => {
      if (boundaryError) return;
      boundaryError = error;
      controller.abort(error);
      rejectBoundary(error);
    };
    const timeout = setTimeout(
      () =>
        failBoundary(
          failure(
            "可灵数字人服务响应超时",
            "KLING_AVATAR_REQUEST_TIMEOUT",
            504,
          ),
        ),
      requestTimeoutMs,
    );
    timeout.unref?.();
    const onAbort = () => failBoundary(cancelled());
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    counters.networkRequests += 1;
    try {
      let response;
      try {
        response = await Promise.race([
          Promise.resolve().then(() =>
            fetchImpl(`${root}${pathname}`, {
              ...init,
              headers: {
                Authorization: `Bearer ${apiKey}`,
                ...(init?.headers || {}),
              },
              signal: controller.signal,
            }),
          ),
          boundary,
        ]);
      } catch (error) {
        if (error?.[SAFE_ERROR]) throw error;
        if (boundaryError) throw boundaryError;
        throw failure(
          "可灵数字人服务暂时不可用",
          "KLING_AVATAR_UPSTREAM_FAILED",
        );
      }
      if (!response || typeof response.json !== "function") {
        throw failure(
          "可灵数字人服务返回无效响应",
          "KLING_AVATAR_RESPONSE_INVALID",
        );
      }
      let payload;
      try {
        payload = await Promise.race([
          Promise.resolve().then(() => response.json()),
          boundary,
        ]);
      } catch (error) {
        if (error?.[SAFE_ERROR]) throw error;
        if (boundaryError) throw boundaryError;
        throw failure(
          "可灵数字人服务返回无效响应",
          "KLING_AVATAR_RESPONSE_INVALID",
        );
      }
      if (!payload || typeof payload !== "object") {
        throw failure(
          "可灵数字人服务返回无效响应",
          "KLING_AVATAR_RESPONSE_INVALID",
        );
      }
      if (response.ok === false) {
        throw failure(
          "可灵数字人服务暂时不可用",
          Number(response.status) === 429
            ? "KLING_AVATAR_BUSY"
            : "KLING_AVATAR_UPSTREAM_FAILED",
          Number(response.status) === 429 ? 503 : 502,
        );
      }
      return payload;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", onAbort);
    }
  }

  async function synthesize({
    image,
    audio,
    signal = null,
    onProgress = null,
    prompt = "",
  } = {}) {
    if (!apiKey) throw missingCredentials();
    if (typeof sleep !== "function" || typeof now !== "function") {
      throw failure(
        "可灵数字人运行时配置无效",
        "KLING_AVATAR_CONFIG_INVALID",
        500,
      );
    }
    abortIfRequested(signal);
    const imageUrl = parsePublicHttpsUrl(image?.publicUrl, {
      code: "KLING_AVATAR_PUBLIC_URL_UNSAFE",
      message: "可灵数字人图片必须使用安全的公网 HTTPS 地址",
      apiKey,
    });
    const audioUrl = parsePublicHttpsUrl(audio?.publicUrl, {
      code: "KLING_AVATAR_PUBLIC_URL_UNSAFE",
      message: "可灵数字人音频必须使用安全的公网 HTTPS 地址",
      apiKey,
    });
    const safeInputPrompt = safePrompt(prompt);
    const body = {
      image: imageUrl,
      sound_file: audioUrl,
      mode,
      ...(safeInputPrompt ? { prompt: safeInputPrompt } : {}),
    };
    const counters = { networkRequests: 0 };
    notify(onProgress, {
      phase: "create",
      message: "可灵正在提交数字人任务",
    });
    const created = await requestJson(
      AVATAR_PATH,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      signal,
      counters,
    );
    const taskId = safeProviderId(created?.data?.task_id, apiKey);
    if (!taskId) {
      throw failure("可灵数字人任务提交失败", "KLING_AVATAR_CREATE_FAILED");
    }
    notify(onProgress, {
      phase: "accepted",
      message: "可灵数字人任务已受理",
    });
    const pollStartedAt = safeNow(now);
    let videoUrl = "";
    for (let attempt = 1; attempt <= maxPollAttempts; attempt += 1) {
      const elapsed = Math.max(0, safeNow(now) - pollStartedAt);
      const remaining = pollTimeoutMs - elapsed;
      if (remaining <= 0) break;
      await delay(Math.min(pollIntervalMs, remaining), { sleep, signal });
      const afterWaitElapsed = Math.max(0, safeNow(now) - pollStartedAt);
      if (afterWaitElapsed >= pollTimeoutMs) break;
      const statusPayload = await requestJson(
        `${AVATAR_PATH}/${encodeURIComponent(taskId)}`,
        { method: "GET" },
        signal,
        counters,
      );
      const data = statusPayload?.data || {};
      const state = String(data.task_status || "").toLowerCase();
      if (state === "succeed") {
        const candidate = data?.task_result?.videos?.[0]?.url;
        if (!candidate) {
          throw failure(
            "可灵数字人成片状态成功但未返回视频地址",
            "KLING_AVATAR_OUTPUT_MISSING",
          );
        }
        videoUrl = parsePublicHttpsUrl(candidate, {
          code: "KLING_AVATAR_OUTPUT_UNSAFE",
          message: "可灵数字人成片地址未通过安全校验",
          apiKey,
          status: 502,
        });
        break;
      }
      if (["failed", "error", "cancelled", "canceled"].includes(state)) {
        throw failure("可灵数字人生成失败", "KLING_AVATAR_RENDER_FAILED");
      }
      notify(onProgress, {
        phase: "polling",
        message: "可灵正在合成数字人视频",
        attempt,
        elapsedMs: afterWaitElapsed,
        state: ["submitted", "processing"].includes(state)
          ? state
          : "submitted",
      });
    }
    if (!videoUrl) {
      throw failure("可灵数字人合成超时", "KLING_AVATAR_TIMEOUT", 504);
    }
    const usage = Object.freeze({
      networkRequests: counters.networkRequests,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      tokenUsageApplicable: false,
    });
    const costEvidence = pricingEvidence(
      pricing,
      counters.networkRequests,
      apiKey,
    );
    return Object.freeze({
      taskId,
      videoUrl,
      provider: Object.freeze({
        id: "kling",
        name: "云雾·可灵",
        kind: "avatar_video",
        mode: "api",
      }),
      providerName: "kling",
      model: model || KLING_AVATAR_MODEL,
      usage,
      cost: costEvidence,
      costEvidence,
    });
  }

  return Object.freeze({
    providerName: "kling",
    requiresPublicAssetUrls: true,
    ready: () => Boolean(apiKey),
    synthesize,
    synth: synthesize,
  });
}

export default createKlingAvatarClient;
