import { isIP } from "node:net";

import { isPublicWebAddress } from "./controlled-web-evidence.js";

export const HEYGEN_API_BASE_URL = "https://api.heygen.com";
export const HEYGEN_UPLOAD_BASE_URL = "https://upload.heygen.com";
export const HEYGEN_AVATAR_MODEL = "Avatar IV";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_POLL_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_CLEANUP_GROUP_LIMIT = 3;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const SAFE_ERROR = Symbol("nanowork.heygen-avatar.safe-error");
const SAFE_ID = /^[a-z0-9._:-]{1,200}$/iu;

export class HeyGenAvatarError extends Error {
  constructor(message, { status = 502, code = "HEYGEN_AVATAR_FAILED" } = {}) {
    super(message);
    this.name = "HeyGenAvatarError";
    Object.defineProperties(this, {
      status: { value: status, enumerable: true },
      code: { value: code, enumerable: true },
      provider: { value: "heygen", enumerable: true },
      [SAFE_ERROR]: { value: true },
    });
  }
}

function failure(message, code, status = 502) {
  return new HeyGenAvatarError(message, { code, status });
}

function missingCredentials() {
  return failure(
    "HeyGen 数字人通道未配置服务端凭据",
    "PROVIDER_CREDENTIALS_MISSING",
    503,
  );
}

function cancelled() {
  return failure("HeyGen 数字人任务已取消", "HEYGEN_CANCELLED", 499);
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
      "HeyGen 服务端配置无法读取",
      "HEYGEN_CONFIG_INVALID",
      500,
    );
  }
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

function safeBaseUrl(value, fallback) {
  let parsed;
  try {
    parsed = new URL(String(value || fallback).trim());
  } catch {
    throw failure(
      "HeyGen 服务端地址配置无效",
      "HEYGEN_CONFIG_INVALID",
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
      "HeyGen 服务端地址配置无效",
      "HEYGEN_CONFIG_INVALID",
      500,
    );
  }
  return parsed.href.replace(/\/+$/gu, "");
}

function safePublicVideoUrl(value, apiKey) {
  const raw = String(value || "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
    strictDecode(parsed.pathname);
    strictDecode(parsed.search.slice(1));
  } catch {
    throw failure(
      "HeyGen 成片地址未通过安全校验",
      "HEYGEN_OUTPUT_UNSAFE",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    parsed.hash ||
    privateHost(parsed.hostname) ||
    (apiKey && raw.includes(apiKey))
  ) {
    throw failure(
      "HeyGen 成片地址未通过安全校验",
      "HEYGEN_OUTPUT_UNSAFE",
    );
  }
  return parsed.href;
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
    throw failure("HeyGen 任务等待失败", "HEYGEN_WAIT_FAILED");
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
  }
}

function bytesOf(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function assetMime(asset, kind) {
  const supplied = String(asset?.mimeType || asset?.type || "").toLowerCase();
  if (supplied) return supplied;
  const name = String(asset?.fileName || asset?.name || "").toLowerCase();
  if (kind === "image") {
    if (name.endsWith(".png")) return "image/png";
    return "image/jpeg";
  }
  if (name.endsWith(".wav")) return "audio/wav";
  if (name.endsWith(".m4a")) return "audio/mp4";
  return "audio/mpeg";
}

function normalizeAsset(value, kind) {
  const bytes = bytesOf(value?.bytes ?? value);
  const maxBytes = kind === "image" ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
  const allowed =
    kind === "image"
      ? new Set(["image/jpeg", "image/jpg", "image/png"])
      : new Set([
          "audio/mpeg",
          "audio/mp3",
          "audio/mp4",
          "audio/m4a",
          "audio/wav",
          "audio/x-wav",
        ]);
  const mimeType = assetMime(value, kind);
  if (!bytes || bytes.length < 1 || bytes.length > maxBytes || !allowed.has(mimeType)) {
    throw failure(
      kind === "image"
        ? "HeyGen 人物图片格式或大小不符合要求"
        : "HeyGen 口播音频格式或大小不符合要求",
      "HEYGEN_INPUT_INVALID",
      400,
    );
  }
  return { bytes, mimeType };
}

function safeProviderId(value, apiKey) {
  const id = String(value || "").trim();
  return SAFE_ID.test(id) && !(apiKey && id.includes(apiKey)) ? id : "";
}

function photoSlotLimit(payload) {
  let text = "";
  try {
    text = JSON.stringify(payload || {}).slice(0, 20_000).toLowerCase();
  } catch {
    return false;
  }
  return (
    /(?:^|\D)401028(?:\D|$)/u.test(text) ||
    text.includes("exceeded") ||
    text.includes("limit") ||
    text.includes("slot full")
  );
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
        : "heygen_response_does_not_report_cost";
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
 * HeyGen Avatar IV boundary. Secrets remain inside the closure, raw media is
 * uploaded directly, and fetch/sleep/now are injectable for offline tests.
 */
export function createHeyGenAvatarClient(options = {}) {
  const config = configured(options);
  const apiKey = String(
    options.apiKey ??
      config.apiKey ??
      config.key ??
      config.heygenApiKey ??
      config.heygen_key ??
      process.env.HEYGEN_API_KEY ??
      process.env.HEYGEN_KEY ??
      "",
  ).trim();
  const apiRoot = safeBaseUrl(
    options.baseUrl ?? config.baseUrl ?? config.apiBaseUrl,
    HEYGEN_API_BASE_URL,
  );
  const uploadRoot = safeBaseUrl(
    options.uploadBaseUrl ?? config.uploadBaseUrl,
    HEYGEN_UPLOAD_BASE_URL,
  );
  const fetchImpl =
    options.fetchImpl ?? options.fetchFn ?? options.fetch ?? globalThis.fetch;
  const sleep =
    options.sleep ??
    options.sleepFn ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? options.nowFn ?? Date.now;
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
  const cleanupGroupLimit = positiveInteger(
    options.cleanupGroupLimit,
    DEFAULT_CLEANUP_GROUP_LIMIT,
    { min: 1, max: 10 },
  );
  const configuredModel = String(
    options.model ?? config.model ?? HEYGEN_AVATAR_MODEL,
  )
    .trim()
    .slice(0, 120);
  const model =
    configuredModel && !(apiKey && configuredModel.includes(apiKey))
      ? configuredModel
      : HEYGEN_AVATAR_MODEL;
  const pricing =
    options.pricing ??
    config.pricing ??
    (options.costCny !== undefined || config.costCny !== undefined
      ? {
          amount: options.costCny ?? config.costCny,
          source: "server_configured_estimate",
        }
      : null);

  async function requestJson(
    root,
    pathname,
    init,
    signal,
    counters,
    { allowHttpError = false } = {},
  ) {
    if (!apiKey) throw missingCredentials();
    abortIfRequested(signal);
    if (typeof fetchImpl !== "function") {
      throw failure(
        "HeyGen 数字人通道缺少 HTTP 客户端",
        "HEYGEN_TRANSPORT_MISSING",
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
            "HeyGen 数字人服务响应超时",
            "HEYGEN_REQUEST_TIMEOUT",
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
                "X-Api-Key": apiKey,
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
          "HeyGen 数字人服务暂时不可用",
          "HEYGEN_UPSTREAM_FAILED",
        );
      }
      if (!response || typeof response.json !== "function") {
        throw failure(
          "HeyGen 服务返回无效响应",
          "HEYGEN_RESPONSE_INVALID",
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
          "HeyGen 服务返回无效响应",
          "HEYGEN_RESPONSE_INVALID",
        );
      }
      if (!payload || typeof payload !== "object") {
        throw failure(
          "HeyGen 服务返回无效响应",
          "HEYGEN_RESPONSE_INVALID",
        );
      }
      if (response.ok === false && !allowHttpError) {
        throw failure(
          "HeyGen 数字人服务暂时不可用",
          Number(response.status) === 429
            ? "HEYGEN_BUSY"
            : "HEYGEN_UPSTREAM_FAILED",
          Number(response.status) === 429 ? 503 : 502,
        );
      }
      return { payload, response };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", onAbort);
    }
  }

  async function cleanupPhotos(signal, counters, onProgress) {
    notify(onProgress, {
      phase: "cleanup_photos",
      message: "HeyGen 照片槽位已满，正在有界清理旧照片组",
    });
    let listed;
    try {
      listed = await requestJson(
        apiRoot,
        "/v2/avatar_group.list?include_public=false",
        { method: "GET" },
        signal,
        counters,
        { allowHttpError: true },
      );
    } catch (error) {
      if (signal?.aborted || error?.code === "HEYGEN_CANCELLED") throw error;
      return;
    }
    if (listed.response.ok === false) return;
    const groups = listed.payload?.data?.avatar_group_list;
    if (!Array.isArray(groups)) return;
    for (const group of groups.slice(0, cleanupGroupLimit)) {
      abortIfRequested(signal);
      const groupId = safeProviderId(group?.id, apiKey);
      if (!groupId) continue;
      for (const prefix of ["/v2/photo_avatar/", "/v2/avatar_group/"]) {
        let removed;
        try {
          removed = await requestJson(
            apiRoot,
            `${prefix}${encodeURIComponent(groupId)}`,
            { method: "DELETE" },
            signal,
            counters,
            { allowHttpError: true },
          );
        } catch (error) {
          if (signal?.aborted || error?.code === "HEYGEN_CANCELLED") throw error;
          continue;
        }
        if (
          removed.response.ok !== false &&
          (Number(removed.payload?.code) === 100 ||
            removed.payload?.success === true ||
            removed.payload?.data === true)
        ) {
          break;
        }
      }
    }
  }

  async function uploadTalkingPhoto(asset, signal, counters, onProgress) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      notify(onProgress, {
        phase: "upload_image",
        message: "HeyGen 正在上传人物图片",
        attempt,
      });
      const uploaded = await requestJson(
        uploadRoot,
        "/v1/talking_photo",
        {
          method: "POST",
          headers: { "Content-Type": asset.mimeType },
          body: asset.bytes,
        },
        signal,
        counters,
        { allowHttpError: true },
      );
      const id = safeProviderId(
        uploaded.payload?.data?.talking_photo_id ?? uploaded.payload?.data?.id,
        apiKey,
      );
      if (uploaded.response.ok !== false && id) return id;
      const slotsFull = photoSlotLimit(uploaded.payload);
      if (attempt === 1 && slotsFull) {
        await cleanupPhotos(signal, counters, onProgress);
        continue;
      }
      if (slotsFull) {
        throw failure(
          "HeyGen 照片槽位已满且有界清理后仍不可用",
          "HEYGEN_PHOTO_SLOTS_FULL",
          503,
        );
      }
      throw failure(
        "HeyGen 人物图片上传失败",
        "HEYGEN_PHOTO_UPLOAD_FAILED",
      );
    }
    throw failure(
      "HeyGen 人物图片上传失败",
      "HEYGEN_PHOTO_UPLOAD_FAILED",
    );
  }

  async function uploadAudio(asset, signal, counters, onProgress) {
    notify(onProgress, {
      phase: "upload_audio",
      message: "HeyGen 正在上传口播音频",
    });
    const uploaded = await requestJson(
      uploadRoot,
      "/v1/asset",
      {
        method: "POST",
        headers: { "Content-Type": asset.mimeType },
        body: asset.bytes,
      },
      signal,
      counters,
      { allowHttpError: true },
    );
    const id = safeProviderId(
      uploaded.payload?.data?.id ?? uploaded.payload?.data?.asset_id,
      apiKey,
    );
    if (uploaded.response.ok === false || !id) {
      throw failure("HeyGen 口播音频上传失败", "HEYGEN_AUDIO_UPLOAD_FAILED");
    }
    return id;
  }

  async function synthesize({
    image,
    audio,
    signal = null,
    onProgress = null,
    prompt: _prompt = "",
  } = {}) {
    if (!apiKey) throw missingCredentials();
    if (typeof sleep !== "function" || typeof now !== "function") {
      throw failure(
        "HeyGen 运行时配置无效",
        "HEYGEN_CONFIG_INVALID",
        500,
      );
    }
    abortIfRequested(signal);
    const imageAsset = normalizeAsset(image, "image");
    const audioAsset = normalizeAsset(audio, "audio");
    void _prompt;
    const counters = { networkRequests: 0 };
    const talkingPhotoId = await uploadTalkingPhoto(
      imageAsset,
      signal,
      counters,
      onProgress,
    );
    abortIfRequested(signal);
    const audioAssetId = await uploadAudio(
      audioAsset,
      signal,
      counters,
      onProgress,
    );
    abortIfRequested(signal);
    notify(onProgress, {
      phase: "create",
      message: "HeyGen 正在提交 Avatar IV 数字人任务",
    });
    const created = await requestJson(
      apiRoot,
      "/v2/video/generate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video_inputs: [
            {
              character: {
                type: "talking_photo",
                talking_photo_id: talkingPhotoId,
              },
              voice: { type: "audio", audio_asset_id: audioAssetId },
            },
          ],
          dimension: { width: 720, height: 1280 },
          use_avatar_iv_model: true,
          title: "纳米Work 数字人",
        }),
      },
      signal,
      counters,
    );
    const taskId = safeProviderId(created.payload?.data?.video_id, apiKey);
    if (!taskId) {
      throw failure("HeyGen 数字人任务提交失败", "HEYGEN_CREATE_FAILED");
    }
    notify(onProgress, {
      phase: "accepted",
      message: "HeyGen 数字人任务已受理",
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
      const statusResult = await requestJson(
        apiRoot,
        `/v1/video_status.get?video_id=${encodeURIComponent(taskId)}`,
        { method: "GET" },
        signal,
        counters,
      );
      const data = statusResult.payload?.data || {};
      const state = String(data.status || "").toLowerCase();
      if (state === "completed") {
        videoUrl = safePublicVideoUrl(data.video_url, apiKey);
        break;
      }
      if (["failed", "error", "cancelled", "canceled"].includes(state)) {
        throw failure("HeyGen 数字人生成失败", "HEYGEN_RENDER_FAILED");
      }
      notify(onProgress, {
        phase: "polling",
        message: "HeyGen 正在合成数字人视频",
        attempt,
        elapsedMs: afterWaitElapsed,
        state: ["pending", "waiting", "processing"].includes(state)
          ? state
          : "waiting",
      });
    }
    if (!videoUrl) {
      throw failure("HeyGen 数字人合成超时", "HEYGEN_TIMEOUT", 504);
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
        id: "heygen",
        name: "HeyGen",
        kind: "avatar_video",
        mode: "api",
      }),
      providerName: "heygen",
      model: model || HEYGEN_AVATAR_MODEL,
      usage,
      cost: costEvidence,
      costEvidence,
    });
  }

  return Object.freeze({
    providerName: "heygen",
    requiresPublicAssetUrls: false,
    ready: () => Boolean(apiKey),
    synthesize,
    synth: synthesize,
  });
}

export default createHeyGenAvatarClient;
