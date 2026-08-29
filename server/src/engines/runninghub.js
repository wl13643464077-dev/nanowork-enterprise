import fsp from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import { isPublicWebAddress } from "./controlled-web-evidence.js";

export const RUNNINGHUB_BASE_URL = "https://www.runninghub.cn";
export const RUNNINGHUB_DEFAULT_WORKFLOW_ID = "1986772059139289089";
export const RUNNINGHUB_DEFAULT_MODEL = "WanVideo InfiniteTalk";

const DEFAULT_INSTANCE_TYPE = "plus";
const DEFAULT_QUEUE_RETRIES = 30;
const DEFAULT_QUEUE_DELAY_MS = 30_000;
const DEFAULT_QUEUE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
// One extra millisecond keeps the golden-source budget of 90 status requests
// while still treating the configured timeout as a strict deadline.
const DEFAULT_POLL_TIMEOUT_MS = 90 * DEFAULT_POLL_INTERVAL_MS + 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const SAFE_ERROR = Symbol("nanowork.runninghub.safe-error");
const SENSITIVE_QUERY_NAME =
  /^(?:api[_-]?key|access[_-]?token|authorization|auth|signature|secret|token|password|passwd|credential)$/iu;
const SENSITIVE_QUERY_VALUE =
  /(?:^|[&;,{\[\s"'])(?:api[_-]?key|access[_-]?token|authorization|auth|signature|secret|token|password|passwd|credential)["']?\s*(?:=|:)/iu;
const VIDEO_PATH =
  /(?:\.mp4|\.mov|\.webm|\.m4v)(?:$|\/)|(?:^|[-_/])video(?:[-_/.]|$)/iu;

export class RunningHubError extends Error {
  constructor(message, { status = 502, code = "RUNNINGHUB_FAILED" } = {}) {
    super(message);
    this.name = "RunningHubError";
    Object.defineProperties(this, {
      status: { value: status, enumerable: true },
      code: { value: code, enumerable: true },
      provider: { value: "runninghub", enumerable: true },
      [SAFE_ERROR]: { value: true },
    });
  }
}

function failure(message, status, code) {
  return new RunningHubError(message, { status, code });
}

function missingCredentials() {
  return failure(
    "RunningHub 数字人通道未配置服务端凭据",
    503,
    "PROVIDER_CREDENTIALS_MISSING",
  );
}

function cancelled() {
  return failure("RunningHub 数字人任务已取消", 499, "RUNNINGHUB_CANCELLED");
}

function abortIfRequested(signal) {
  if (signal?.aborted) throw cancelled();
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

function containsSensitiveQuery(parsed) {
  try {
    for (const [rawKey, rawValue] of parsed.searchParams.entries()) {
      const key = strictDecode(rawKey);
      const value = strictDecode(rawValue);
      if (
        SENSITIVE_QUERY_NAME.test(key) ||
        SENSITIVE_QUERY_VALUE.test(value) ||
        /\bBearer\s+[a-z0-9._~+/-]{8,}\b/iu.test(value) ||
        /\bsk-[a-z0-9_-]{8,}\b/iu.test(value)
      ) {
        return true;
      }
    }
    strictDecode(parsed.pathname);
    strictDecode(parsed.search.slice(1));
    return false;
  } catch {
    return true;
  }
}

/**
 * RunningHub output URLs are later downloaded by a server-side worker. Keep
 * this boundary stricter than a browser link: HTTPS only, no URL credentials,
 * no fragments/secrets, no private-address literals and no malformed escapes.
 */
export function parseRunningHubVideoUrl(value) {
  const raw = String(value || "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw failure(
      "RunningHub 成片地址未通过安全校验",
      502,
      "RUNNINGHUB_OUTPUT_UNSAFE",
    );
  }
  const defaultPort = parsed.protocol === "https:" ? "443" : "";
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== defaultPort) ||
    parsed.hash ||
    privateHost(parsed.hostname) ||
    containsSensitiveQuery(parsed)
  ) {
    throw failure(
      "RunningHub 成片地址未通过安全校验",
      502,
      "RUNNINGHUB_OUTPUT_UNSAFE",
    );
  }
  return parsed;
}

export function buildRunningHubNodeInfoList({
  imageFileName,
  audioFileName,
} = {}) {
  const image = String(imageFileName || "").trim();
  const audio = String(audioFileName || "").trim();
  if (!image || !audio) {
    throw failure(
      "RunningHub 工作流缺少已上传素材",
      500,
      "RUNNINGHUB_WORKFLOW_INPUT_MISSING",
    );
  }
  return [
    { nodeId: "472", fieldName: "image", fieldValue: image },
    { nodeId: "474", fieldName: "audio", fieldValue: audio },
    { nodeId: "484", fieldName: "audio", fieldValue: audio },
  ];
}

function safeIdentifier(value, fallback, label) {
  const id = String(value || fallback || "").trim();
  if (!id || id.length > 180 || !/^[a-z0-9._:-]+$/iu.test(id)) {
    throw failure(
      `RunningHub ${label}配置无效`,
      500,
      "RUNNINGHUB_CONFIG_INVALID",
    );
  }
  return id;
}

function safeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || RUNNINGHUB_BASE_URL).trim());
  } catch {
    throw failure(
      "RunningHub 服务端地址配置无效",
      500,
      "RUNNINGHUB_CONFIG_INVALID",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw failure(
      "RunningHub 服务端地址配置无效",
      500,
      "RUNNINGHUB_CONFIG_INVALID",
    );
  }
  return parsed.href.replace(/\/+$/gu, "");
}

function positiveInteger(value, fallback, { min = 1, max = 10_000 } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    return fallback;
  }
  return number;
}

function nonNegativeInteger(value, fallback, max = 10_000) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) return fallback;
  return number;
}

function safeFileName(value, fallback) {
  const name = path
    .basename(String(value || fallback || "asset.bin"))
    .replace(/[\0\r\n"]/gu, "_")
    .slice(0, 160);
  return name || fallback;
}

function defaultMime(kind) {
  return kind === "image" ? "application/octet-stream" : "audio/mpeg";
}

function bytesFrom(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

async function normalizeAsset(value, kind) {
  const fallbackName = kind === "image" ? "portrait.bin" : "voice.bin";
  if (value instanceof Blob) {
    if (!value.size || value.size > MAX_ASSET_BYTES) {
      throw failure(
        `RunningHub ${kind === "image" ? "图片" : "音频"}素材大小无效`,
        400,
        "RUNNINGHUB_ASSET_INVALID",
      );
    }
    return {
      blob: value,
      fileName: fallbackName,
      mimeType: value.type || defaultMime(kind),
    };
  }

  if (typeof value === "string") {
    if (/^data:/iu.test(value)) {
      const match = value.match(
        /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/iu,
      );
      if (!match) {
        throw failure(
          `RunningHub ${kind === "image" ? "图片" : "音频"}素材格式无效`,
          400,
          "RUNNINGHUB_ASSET_INVALID",
        );
      }
      const bytes = Buffer.from(match[2].replace(/\s/gu, ""), "base64");
      if (!bytes.length || bytes.length > MAX_ASSET_BYTES) {
        throw failure(
          `RunningHub ${kind === "image" ? "图片" : "音频"}素材大小无效`,
          400,
          "RUNNINGHUB_ASSET_INVALID",
        );
      }
      return {
        blob: new Blob([bytes], { type: match[1].toLowerCase() }),
        fileName: fallbackName,
        mimeType: match[1].toLowerCase(),
      };
    }
    try {
      const bytes = await fsp.readFile(value);
      if (!bytes.length || bytes.length > MAX_ASSET_BYTES) throw new Error();
      return {
        blob: new Blob([bytes], { type: defaultMime(kind) }),
        fileName: safeFileName(value, fallbackName),
        mimeType: defaultMime(kind),
      };
    } catch {
      throw failure(
        `RunningHub ${kind === "image" ? "图片" : "音频"}素材无法读取`,
        400,
        "RUNNINGHUB_ASSET_INVALID",
      );
    }
  }

  const source = value && typeof value === "object" ? value : {};
  const directBytes =
    bytesFrom(value) || bytesFrom(source.bytes ?? source.buffer ?? source.data);
  if (!directBytes?.length || directBytes.length > MAX_ASSET_BYTES) {
    throw failure(
      `RunningHub ${kind === "image" ? "图片" : "音频"}素材无效`,
      400,
      "RUNNINGHUB_ASSET_INVALID",
    );
  }
  const mimeType = String(
    source.mimeType || source.mime || source.type || defaultMime(kind),
  )
    .trim()
    .toLowerCase()
    .slice(0, 120);
  return {
    blob: new Blob([directBytes], { type: mimeType }),
    fileName: safeFileName(
      source.fileName || source.filename || source.name,
      fallbackName,
    ),
    mimeType,
  };
}

function taskIdFrom(payload) {
  return (
    payload?.data?.taskId || payload?.data?.task_id || payload?.taskId || ""
  );
}

function safeTaskId(payload, apiKey) {
  const taskId = String(taskIdFrom(payload) || "").trim();
  if (
    !taskId ||
    taskId.length > 200 ||
    !/^[a-z0-9._:-]+$/iu.test(taskId) ||
    (apiKey && taskId.includes(apiKey))
  ) {
    throw failure(
      "RunningHub 任务提交失败，请稍后重试",
      502,
      "RUNNINGHUB_CREATE_FAILED",
    );
  }
  return taskId;
}

function statusFrom(payload) {
  const data = payload?.data;
  const raw =
    (typeof data === "string" ? data : data?.status || data?.state) ||
    payload?.status ||
    payload?.state ||
    "";
  return String(raw).trim().toUpperCase();
}

function queueMaxed(payload) {
  try {
    return /QUEUE_MAXED/iu.test(JSON.stringify(payload));
  } catch {
    return false;
  }
}

function responseCodeOk(payload) {
  return Number(payload?.code) === 0;
}

function outputUrls(payload) {
  const data = payload?.data;
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.outputs)
      ? data.outputs
      : Array.isArray(payload?.outputs)
        ? payload.outputs
        : [];
  return rows
    .map((item) =>
      typeof item === "string"
        ? item
        : item?.fileUrl || item?.file_url || item?.url || "",
    )
    .filter((value) => typeof value === "string" && value.trim());
}

function safeVideoOutput(payload, apiKey) {
  let unsafeVideo = false;
  for (const value of outputUrls(payload)) {
    let parsed;
    try {
      parsed = new URL(String(value).trim());
    } catch {
      continue;
    }
    if (!VIDEO_PATH.test(parsed.pathname)) continue;
    let decodedValue = String(value);
    try {
      decodedValue = strictDecode(decodedValue);
    } catch {
      unsafeVideo = true;
    }
    if (apiKey && decodedValue.includes(apiKey)) unsafeVideo = true;
    if (unsafeVideo) continue;
    try {
      return parseRunningHubVideoUrl(value).href;
    } catch (error) {
      if (error?.code === "RUNNINGHUB_OUTPUT_UNSAFE") unsafeVideo = true;
    }
  }
  if (unsafeVideo) {
    throw failure(
      "RunningHub 成片地址未通过安全校验",
      502,
      "RUNNINGHUB_OUTPUT_UNSAFE",
    );
  }
  throw failure(
    "RunningHub 未返回可用成片地址，请稍后重试",
    502,
    "RUNNINGHUB_OUTPUT_MISSING",
  );
}

function safeNow(now) {
  const value = Number(now());
  return Number.isFinite(value) ? value : Date.now();
}

function notify(progress, event) {
  if (typeof progress !== "function") return;
  try {
    progress(Object.freeze({ ...event }));
  } catch {
    // Progress listeners are observational and may not break provider work.
  }
}

async function delay(ms, { sleep, signal }) {
  abortIfRequested(signal);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(cancelled());
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([Promise.resolve().then(() => sleep(ms)), aborted]);
    abortIfRequested(signal);
  } catch (error) {
    if (error?.[SAFE_ERROR]) throw error;
    if (signal?.aborted || error?.name === "AbortError") throw cancelled();
    throw failure(
      "RunningHub 任务等待失败，请稍后重试",
      502,
      "RUNNINGHUB_WAIT_FAILED",
    );
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
  }
}

function pricingEvidence(pricing, networkRequests, apiKey) {
  const configuredAmount = Number(pricing?.amount);
  const estimated = Number.isFinite(configuredAmount) && configuredAmount >= 0;
  const amount = estimated ? configuredAmount : null;
  const requestedCurrency = String(pricing?.currency || "CNY").toUpperCase();
  const currency =
    estimated && /^[A-Z]{3,8}$/u.test(requestedCurrency)
      ? requestedCurrency
      : estimated
        ? "CNY"
        : null;
  const requestedSource = String(
    pricing?.source || "server_configured_estimate",
  ).slice(0, 80);
  const source = estimated
    ? apiKey && requestedSource.includes(apiKey)
      ? "server_configured_estimate"
      : requestedSource
    : "runninghub_response_does_not_report_cost";
  return Object.freeze({
    amount,
    currency,
    estimated,
    providerReported: false,
    source,
    pricingMode: estimated ? "configured_estimate" : "provider_not_reported",
    networkRequests,
  });
}

/**
 * Build the provider boundary used by the avatar workflow. Secrets are kept in
 * this closure, sent only to RunningHub's required request fields and never
 * copied into a result or Error. fetch/sleep/now are injectable for no-cloud
 * acceptance tests.
 */
export function createRunningHubClient(options = {}) {
  let configured;
  try {
    configured =
      typeof options.config === "function"
        ? options.config() || {}
        : options.config || {};
  } catch {
    throw failure(
      "RunningHub 服务端配置无法读取",
      500,
      "RUNNINGHUB_CONFIG_INVALID",
    );
  }
  const apiKey = String(
    options.apiKey ??
      configured.apiKey ??
      configured.key ??
      configured.runninghubKey ??
      configured.runninghub_key ??
      process.env.RUNNINGHUB_API_KEY ??
      process.env.RUNNINGHUB_KEY ??
      "",
  ).trim();
  const root = safeBaseUrl(
    options.baseUrl ??
      configured.baseUrl ??
      configured.runninghubBaseUrl ??
      configured.runninghub_base_url ??
      RUNNINGHUB_BASE_URL,
  );
  const workflowId = safeIdentifier(
    options.workflowId ??
      configured.workflowId ??
      configured.runninghubWorkflow ??
      configured.runninghub_workflow ??
      process.env.RUNNINGHUB_WORKFLOW_ID,
    RUNNINGHUB_DEFAULT_WORKFLOW_ID,
    "workflowId",
  );
  const instanceType = safeIdentifier(
    options.instanceType ??
      configured.instanceType ??
      configured.runninghubInstance ??
      configured.runninghub_instance ??
      process.env.RUNNINGHUB_INSTANCE_TYPE,
    DEFAULT_INSTANCE_TYPE,
    "instanceType",
  );
  const configuredModel = String(
    options.model ?? configured.model ?? RUNNINGHUB_DEFAULT_MODEL,
  )
    .trim()
    .slice(0, 120);
  const model =
    apiKey && configuredModel.includes(apiKey)
      ? RUNNINGHUB_DEFAULT_MODEL
      : configuredModel;
  const fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis.fetch;
  const sleep =
    options.sleep ??
    options.sleepFn ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? options.nowFn ?? Date.now;
  const maxQueueRetries = nonNegativeInteger(
    options.maxQueueRetries,
    DEFAULT_QUEUE_RETRIES,
    100,
  );
  const queueRetryDelayMs = positiveInteger(
    options.queueRetryDelayMs,
    DEFAULT_QUEUE_DELAY_MS,
    { min: 1, max: 5 * 60 * 1000 },
  );
  const queueTimeoutMs = positiveInteger(
    options.queueTimeoutMs,
    DEFAULT_QUEUE_TIMEOUT_MS,
    { min: 1, max: 24 * 60 * 60 * 1000 },
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
  const requestTimeoutMs = positiveInteger(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    { min: 100, max: 30 * 60 * 1000 },
  );
  const maxPollAttempts = positiveInteger(
    options.maxPollAttempts,
    Math.max(1, Math.ceil(pollTimeoutMs / pollIntervalMs)),
    { min: 1, max: 10_000 },
  );
  const pricing = options.pricing ?? configured.pricing ?? null;

  async function synthesize({
    image,
    photo,
    photoPath,
    audio,
    audioPath,
    signal = null,
    onProgress = null,
  } = {}) {
    if (!apiKey) throw missingCredentials();
    if (typeof fetchImpl !== "function") {
      throw failure(
        "RunningHub 数字人通道不可用",
        503,
        "RUNNINGHUB_TRANSPORT_MISSING",
      );
    }
    if (typeof sleep !== "function" || typeof now !== "function") {
      throw failure(
        "RunningHub 运行时配置无效",
        500,
        "RUNNINGHUB_CONFIG_INVALID",
      );
    }
    abortIfRequested(signal);
    const imageAsset = await normalizeAsset(
      image ?? photo ?? photoPath,
      "image",
    );
    abortIfRequested(signal);
    const audioAsset = await normalizeAsset(audio ?? audioPath, "audio");
    abortIfRequested(signal);
    const counters = { networkRequests: 0 };

    const requestJson = async (endpoint, { body, form } = {}) => {
      abortIfRequested(signal);
      const timeoutController = new AbortController();
      const timer = setTimeout(
        () => timeoutController.abort(),
        requestTimeoutMs,
      );
      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;
      let onRequestAbort;
      const requestAborted = new Promise((_, reject) => {
        onRequestAbort = () => {
          const error = new Error("request aborted");
          error.name = "AbortError";
          reject(error);
        };
        requestSignal.addEventListener("abort", onRequestAbort, {
          once: true,
        });
        if (requestSignal.aborted) onRequestAbort();
      });
      counters.networkRequests += 1;
      try {
        const response = await Promise.race([
          Promise.resolve().then(() =>
            fetchImpl(`${root}${endpoint}`, {
              method: "POST",
              ...(form
                ? { body: form }
                : {
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                  }),
              signal: requestSignal,
            }),
          ),
          requestAborted,
        ]);
        let payload;
        try {
          payload = await response.json();
        } catch {
          throw failure(
            "RunningHub 服务返回无效响应",
            502,
            "RUNNINGHUB_RESPONSE_INVALID",
          );
        }
        if (response?.ok === false) {
          throw failure(
            "RunningHub 数字人服务暂时不可用",
            Number(response.status) === 429 ? 503 : 502,
            Number(response.status) === 429
              ? "RUNNINGHUB_BUSY"
              : "RUNNINGHUB_UPSTREAM_FAILED",
          );
        }
        return payload && typeof payload === "object" ? payload : {};
      } catch (error) {
        if (error?.[SAFE_ERROR]) throw error;
        if (signal?.aborted) throw cancelled();
        if (timeoutController.signal.aborted) {
          throw failure(
            "RunningHub 数字人服务响应超时",
            504,
            "RUNNINGHUB_REQUEST_TIMEOUT",
          );
        }
        throw failure(
          "RunningHub 数字人服务暂时不可用",
          502,
          "RUNNINGHUB_UPSTREAM_FAILED",
        );
      } finally {
        clearTimeout(timer);
        requestSignal.removeEventListener("abort", onRequestAbort);
      }
    };

    const upload = async (asset, fileType) => {
      const form = new FormData();
      form.append("apiKey", apiKey);
      form.append("fileType", fileType);
      form.append("file", asset.blob, asset.fileName);
      const payload = await requestJson("/task/openapi/upload", { form });
      const fileName = String(payload?.data?.fileName || "").trim();
      if (
        !responseCodeOk(payload) ||
        !fileName ||
        fileName.length > 512 ||
        /[\0\r\n]/u.test(fileName) ||
        fileName.includes(apiKey)
      ) {
        throw failure(
          "RunningHub 素材上传失败，请稍后重试",
          502,
          "RUNNINGHUB_UPLOAD_FAILED",
        );
      }
      return fileName;
    };

    notify(onProgress, {
      phase: "upload_image",
      message: "RunningHub 正在上传图片",
    });
    const imageFileName = await upload(imageAsset, "image");
    abortIfRequested(signal);
    notify(onProgress, {
      phase: "upload_audio",
      message: "RunningHub 正在上传音频",
    });
    const audioFileName = await upload(audioAsset, "audio");
    abortIfRequested(signal);

    const nodeInfoList = buildRunningHubNodeInfoList({
      imageFileName,
      audioFileName,
    });
    const createBody = {
      apiKey,
      workflowId,
      nodeInfoList,
      instanceType,
    };
    const queueStartedAt = safeNow(now);
    let createPayload;
    let taskId;
    for (let retry = 0; retry <= maxQueueRetries; retry += 1) {
      notify(onProgress, {
        phase: "create",
        message: "RunningHub 正在提交工作流",
        attempt: retry + 1,
      });
      createPayload = await requestJson("/task/openapi/create", {
        body: createBody,
      });
      if (responseCodeOk(createPayload)) {
        taskId = safeTaskId(createPayload, apiKey);
        break;
      }
      if (!queueMaxed(createPayload)) {
        throw failure(
          "RunningHub 任务提交失败，请稍后重试",
          502,
          "RUNNINGHUB_CREATE_FAILED",
        );
      }
      const elapsed = Math.max(0, safeNow(now) - queueStartedAt);
      if (
        retry >= maxQueueRetries ||
        elapsed + queueRetryDelayMs > queueTimeoutMs
      ) {
        throw failure(
          "RunningHub 渲染队列繁忙，请稍后重试",
          503,
          "RUNNINGHUB_QUEUE_MAXED",
        );
      }
      notify(onProgress, {
        phase: "queue_wait",
        message: "RunningHub 渲染队列繁忙，正在有界等待",
        attempt: retry + 1,
        delayMs: queueRetryDelayMs,
      });
      await delay(queueRetryDelayMs, { sleep, signal });
    }
    if (!taskId) {
      throw failure(
        "RunningHub 任务提交失败，请稍后重试",
        502,
        "RUNNINGHUB_CREATE_FAILED",
      );
    }

    notify(onProgress, {
      phase: "accepted",
      message: "RunningHub 任务已受理",
    });
    const pollStartedAt = safeNow(now);
    let success = false;
    for (let attempt = 1; attempt <= maxPollAttempts; attempt += 1) {
      const elapsed = Math.max(0, safeNow(now) - pollStartedAt);
      const remaining = pollTimeoutMs - elapsed;
      if (remaining <= 0) break;
      await delay(Math.min(pollIntervalMs, remaining), { sleep, signal });
      const afterWaitElapsed = Math.max(0, safeNow(now) - pollStartedAt);
      if (afterWaitElapsed >= pollTimeoutMs) break;
      const statusPayload = await requestJson("/task/openapi/status", {
        body: { apiKey, taskId },
      });
      if (!responseCodeOk(statusPayload)) {
        throw failure(
          "RunningHub 工作流状态查询失败",
          502,
          "RUNNINGHUB_STATUS_FAILED",
        );
      }
      const status = statusFrom(statusPayload);
      if (status === "SUCCESS") {
        success = true;
        break;
      }
      if (
        ["FAILED", "FAIL", "ERROR", "CANCELLED", "CANCELED"].includes(status)
      ) {
        throw failure(
          "RunningHub 工作流执行失败",
          502,
          "RUNNINGHUB_WORKFLOW_FAILED",
        );
      }
      notify(onProgress, {
        phase: "polling",
        message: "RunningHub 正在合成数字人视频",
        attempt,
        elapsedMs: afterWaitElapsed,
        state: ["RUNNING", "QUEUED", "WAITING"].includes(status)
          ? status
          : "WAITING",
      });
    }
    if (!success) {
      throw failure("RunningHub 数字人合成超时", 504, "RUNNINGHUB_TIMEOUT");
    }

    const outputPayload = await requestJson("/task/openapi/outputs", {
      body: { apiKey, taskId },
    });
    if (!responseCodeOk(outputPayload)) {
      throw failure(
        "RunningHub 成片结果获取失败",
        502,
        "RUNNINGHUB_OUTPUT_FAILED",
      );
    }
    const videoUrl = safeVideoOutput(outputPayload, apiKey);
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
        id: "runninghub",
        name: "RunningHub",
        kind: "avatar_video",
        mode: "api",
      }),
      providerName: "runninghub",
      model: model || RUNNINGHUB_DEFAULT_MODEL,
      usage,
      cost: costEvidence,
      costEvidence,
    });
  }

  return Object.freeze({
    ready: () => Boolean(apiKey),
    synthesize,
    synth: synthesize,
  });
}

export default createRunningHubClient;
