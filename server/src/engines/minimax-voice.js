import crypto from "node:crypto";
import { isIP } from "node:net";
import { isPublicWebAddress } from "./controlled-web-evidence.js";

export const MINIMAX_VOICE_BASE_URL = "https://yunwu.ai";
export const MINIMAX_TTS_MODEL = "speech-2.8-hd";

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const SENSITIVE_KEY =
  /^(?:api[_-]?key|access[_-]?token|authorization|auth|signature|secret|token|password|passwd|credential)$/iu;

export class MiniMaxVoiceError extends Error {
  constructor(message, { code = "MINIMAX_VOICE_FAILED", status = 502 } = {}) {
    super(message);
    this.name = "MiniMaxVoiceError";
    this.code = code;
    this.status = status;
    this.provider = "yunwu-minimax";
  }
}

function failure(message, code, status = 502) {
  return new MiniMaxVoiceError(message, { code, status });
}

function strictDecode(value) {
  let current = String(value || "");
  for (let depth = 0; depth < 2; depth += 1) {
    const next = decodeURIComponent(current.replace(/\+/gu, "%20"));
    if (next === current) break;
    current = next;
  }
  if (current.includes("�")) throw new URIError("invalid encoding");
  return current;
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

function sensitiveUrl(parsed) {
  try {
    strictDecode(parsed.pathname);
    strictDecode(parsed.search.slice(1));
    for (const [rawKey, rawValue] of parsed.searchParams.entries()) {
      const key = strictDecode(rawKey);
      const value = strictDecode(rawValue);
      if (
        SENSITIVE_KEY.test(key) ||
        /\bBearer\s+[a-z0-9._~+/-]{8,}\b/iu.test(value) ||
        /\bsk-[a-z0-9_-]{8,}\b/iu.test(value)
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

export function parseMiniMaxAudioUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw failure(
      "配音服务返回的音频地址未通过安全校验",
      "MINIMAX_AUDIO_URL_UNSAFE",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    privateHost(parsed.hostname) ||
    sensitiveUrl(parsed)
  ) {
    throw failure(
      "配音服务返回的音频地址未通过安全校验",
      "MINIMAX_AUDIO_URL_UNSAFE",
    );
  }
  return parsed.href;
}

function safeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || MINIMAX_VOICE_BASE_URL).trim());
  } catch {
    throw failure("声音服务地址配置无效", "MINIMAX_VOICE_CONFIG_INVALID", 500);
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
    throw failure("声音服务地址配置无效", "MINIMAX_VOICE_CONFIG_INVALID", 500);
  }
  return parsed.href.replace(/\/+$/gu, "");
}

function safeVoiceId(value) {
  const id = String(value || "").trim();
  if (!/^[a-z0-9_-]{3,64}$/iu.test(id)) {
    throw failure("声音ID格式不正确", "MINIMAX_VOICE_ID_INVALID", 400);
  }
  return id;
}

function safeLabel(value) {
  return (
    String(value || "我的声音")
      .replace(/[\u0000-\u001f\u007f]/gu, "")
      .replace(/\s+/gu, "")
      .trim()
      .slice(0, 12) || "我的声音"
  );
}

function normalizeAudio(
  value,
  { fileName = "voice-sample.mp3", mimeType } = {},
) {
  let bytes;
  if (Buffer.isBuffer(value)) bytes = value;
  else if (value instanceof Uint8Array) bytes = Buffer.from(value);
  else {
    throw failure(
      "声音样本必须由租户文件服务读取后传入",
      "MINIMAX_AUDIO_INPUT_INVALID",
      400,
    );
  }
  if (bytes.length < 1 || bytes.length > MAX_AUDIO_BYTES) {
    throw failure("声音样本大小不符合要求", "MINIMAX_AUDIO_INPUT_INVALID", 400);
  }
  const name = String(fileName || "voice-sample.mp3")
    .replace(/[^a-z0-9._-]/giu, "_")
    .slice(-120);
  const mime = String(mimeType || "audio/mpeg").toLowerCase();
  if (
    !new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"]).has(mime)
  ) {
    throw failure(
      "声音样本格式仅支持 MP3 或 WAV",
      "MINIMAX_AUDIO_INPUT_INVALID",
      400,
    );
  }
  return { bytes, fileName: name || "voice-sample.mp3", mimeType: mime };
}

function positiveTimeout(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 300_000
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}

function providerStatus(payload) {
  const status = payload?.base_resp?.status_code;
  return status === null || status === undefined || status === ""
    ? Number.NaN
    : Number(status);
}

function providerMessage(payload) {
  return String(payload?.base_resp?.status_msg || "").toLowerCase();
}

export function createMiniMaxVoiceClient(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const apiKey = String(
    options.apiKey ?? process.env.YUNWU_API_KEY ?? "",
  ).trim();
  const baseUrl = safeBaseUrl(options.baseUrl);
  const requestTimeoutMs = positiveTimeout(options.requestTimeoutMs);
  const randomUUID = options.randomUUID || crypto.randomUUID;

  if (typeof fetchFn !== "function") {
    throw failure(
      "声音服务缺少HTTP客户端",
      "MINIMAX_VOICE_CONFIG_INVALID",
      500,
    );
  }

  async function request(pathname, init, signal) {
    if (!apiKey) {
      throw failure(
        "声音克隆与配音通道未配置服务端凭据",
        "PROVIDER_CREDENTIALS_MISSING",
        503,
      );
    }
    if (signal?.aborted) {
      throw failure("声音任务已取消", "MINIMAX_VOICE_CANCELLED", 499);
    }
    const controller = new AbortController();
    let rejectTimeout;
    const timeoutError = failure(
      "声音服务请求超时",
      "MINIMAX_VOICE_TIMEOUT",
      504,
    );
    const timeoutPromise = new Promise((resolve, reject) => {
      void resolve;
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      controller.abort(timeoutError);
      rejectTimeout(timeoutError);
    }, requestTimeoutMs);
    timeout.unref?.();
    const abort = () => {
      const error = failure("声音任务已取消", "MINIMAX_VOICE_CANCELLED", 499);
      controller.abort(error);
      rejectTimeout(error);
    };
    signal?.addEventListener?.("abort", abort, { once: true });
    try {
      let response;
      try {
        response = await Promise.race([
          fetchFn(`${baseUrl}${pathname}`, {
            ...init,
            headers: {
              Authorization: `Bearer ${apiKey}`,
              ...(init?.headers || {}),
            },
            signal: controller.signal,
          }),
          timeoutPromise,
        ]);
      } catch (error) {
        if (error instanceof MiniMaxVoiceError) throw error;
        throw failure(
          "声音服务暂时不可用",
          "MINIMAX_VOICE_TRANSPORT_FAILED",
          502,
        );
      }
      let payload;
      try {
        payload = await Promise.race([response.json(), timeoutPromise]);
      } catch (error) {
        if (error instanceof MiniMaxVoiceError) throw error;
        throw failure(
          "声音服务响应无法解析",
          "MINIMAX_VOICE_RESPONSE_INVALID",
          502,
        );
      }
      if (!response.ok) {
        throw failure(
          "声音服务请求失败",
          "MINIMAX_VOICE_UPSTREAM_FAILED",
          502,
        );
      }
      return payload;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", abort);
    }
  }

  async function cloneVoice({
    audio,
    fileName,
    mimeType,
    label,
    voiceId,
    signal,
  } = {}) {
    const sample = normalizeAudio(audio, { fileName, mimeType });
    const form = new FormData();
    form.append(
      "file",
      new Blob([sample.bytes], { type: sample.mimeType }),
      sample.fileName,
    );
    form.append("purpose", "voice_clone");
    const uploaded = await request(
      "/minimax/v1/files",
      { method: "POST", body: form },
      signal,
    );
    const fileId = String(uploaded?.file?.file_id || "").trim();
    if (!fileId || fileId.length > 180) {
      throw failure(
        "声音样本上传未返回有效文件ID",
        "MINIMAX_VOICE_UPLOAD_INVALID",
      );
    }
    const assignedVoiceId = safeVoiceId(
      voiceId || `boss${String(randomUUID()).replace(/-/gu, "").slice(0, 12)}`,
    );
    const cloned = await request(
      "/minimax/v1/voice_clone",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: fileId, voice_id: assignedVoiceId }),
      },
      signal,
    );
    if (providerStatus(cloned) !== 0) {
      const shortSample =
        providerMessage(cloned).includes("duration too short");
      throw failure(
        shortSample
          ? "录音太短：声音克隆至少需要10秒，建议30秒至1分钟"
          : "声音克隆失败",
        shortSample
          ? "MINIMAX_VOICE_SAMPLE_TOO_SHORT"
          : "MINIMAX_VOICE_CLONE_FAILED",
        shortSample ? 400 : 502,
      );
    }
    return {
      voice: {
        id: assignedVoiceId,
        label: `🧬 ${safeLabel(label)}`,
        cloned: true,
      },
      providerAttempt: {
        provider: "yunwu-minimax",
        model: "voice_clone",
        mode: "api",
        verifiedApiCallCount: 2,
        usage: { networkRequests: 2, inputBytes: sample.bytes.length },
        cost: {
          amount: null,
          currency: null,
          note: "供应商响应未返回可核验成本；客户积分由业务账本独立结算",
        },
      },
    };
  }

  async function synthesize({ text, voiceId, signal } = {}) {
    const content = String(text || "").trim();
    if (content.length < 1 || content.length > 2_000) {
      throw failure(
        "配音文本长度必须为1至2000字",
        "MINIMAX_TTS_INPUT_INVALID",
        400,
      );
    }
    const resolvedVoiceId = safeVoiceId(voiceId);
    const payload = await request(
      "/minimax/v1/t2a_v2",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MINIMAX_TTS_MODEL,
          text: content,
          stream: false,
          output_format: "url",
          voice_setting: { voice_id: resolvedVoiceId, speed: 1 },
          audio_setting: { sample_rate: 32_000, format: "mp3" },
        }),
      },
      signal,
    );
    if (providerStatus(payload) !== 0 || !payload?.data?.audio) {
      throw failure("配音服务生成失败", "MINIMAX_TTS_FAILED");
    }
    return {
      audioUrl: parseMiniMaxAudioUrl(payload.data.audio),
      providerAttempt: {
        provider: "yunwu-minimax",
        model: MINIMAX_TTS_MODEL,
        mode: "api",
        verifiedApiCallCount: 1,
        usage: { networkRequests: 1, inputCharacters: content.length },
        cost: {
          amount: null,
          currency: null,
          note: "供应商响应未返回可核验成本；客户积分由业务账本独立结算",
        },
      },
    };
  }

  return { cloneVoice, synthesize };
}

export default createMiniMaxVoiceClient;
