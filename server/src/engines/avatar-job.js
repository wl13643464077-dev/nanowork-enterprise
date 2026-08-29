import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  curTenant,
  getTenantConfig,
  q,
  runWithTenant,
} from "../db.js";
import { canAccessOwner, userScopeClause } from "./access.js";
import {
  balanceOfTenant,
  billing,
  estimateMaxCredits,
  findHoldByRef,
  holdCredits,
  releaseHold,
  settleHold,
} from "./credits.js";
import { decodeBase64File } from "./filehub.js";
import createMiniMaxVoiceClient from "./minimax-voice.js";
import { parseMiniMaxAudioUrl } from "./minimax-voice.js";
import createHeyGenAvatarClient from "./heygen-avatar.js";
import createKlingAvatarClient from "./kling-avatar.js";
import createRunningHubClient, {
  parseRunningHubVideoUrl,
  RUNNINGHUB_DEFAULT_MODEL,
} from "./runninghub.js";
import {
  avatarProviderPublicBaseUrl,
  createAvatarProviderAssetUrl,
} from "./avatar-provider-assets.js";
import { downloadProviderVideoClip } from "./video-provider-download.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_ROOT = path.join(
  __dirname,
  "..",
  "..",
  "data",
  "uploads",
  "files",
);
const execFileAsync = promisify(execFile);

export const AVATAR_DURATIONS = Object.freeze([15, 30, 60]);
export const AVATAR_ENGINES = Object.freeze([
  "auto",
  "runninghub",
  "heygen",
  "kling",
]);
export const AVATAR_SYSTEM_VOICES = Object.freeze([
  { id: "male-qn-qingse", label: "青涩男声（阳光少年）", cloned: false },
  { id: "male-qn-jingying", label: "精英男声（干练商务）", cloned: false },
  { id: "presenter_male", label: "主持男声（播音腔）", cloned: false },
  { id: "female-shaonv", label: "少女音（活泼）", cloned: false },
  { id: "female-yujie", label: "御姐音（沉稳）", cloned: false },
  { id: "presenter_female", label: "主持女声（播音腔）", cloned: false },
  { id: "audiobook_male_1", label: "有声书男声（讲述感）", cloned: false },
  { id: "audiobook_female_1", label: "有声书女声（温柔）", cloned: false },
]);
export const AVATAR_MAX_FREE_RETRIES = 3;
export const AVATAR_HARD_TIMEOUT_MS = 35 * 60 * 1000;
export const AVATAR_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const AVATAR_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const AVATAR_MAX_VIDEO_BYTES = 512 * 1024 * 1024;

const BILLING_REF = "avatar_job";
const VOICE_BILLING_REF = "avatar_voice_clone";
const ACTIVE_TERMINAL = new Set(["done", "failed", "cancelled"]);
const SAFE_CODE = /^[A-Z0-9_:-]{1,80}$/u;

export class AvatarJobError extends Error {
  constructor(message, { status = 400, code = "AVATAR_JOB_INVALID" } = {}) {
    super(message);
    this.name = "AvatarJobError";
    this.status = status;
    this.code = code;
  }
}

function failure(message, status, code) {
  return new AvatarJobError(message, { status, code });
}

function idOf(value, label = "编号") {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw failure(`${label}不正确`, 400, "AVATAR_ID_INVALID");
  }
  return id;
}

function durationOf(value) {
  const duration = Number(value);
  if (!AVATAR_DURATIONS.includes(duration)) {
    throw failure(
      "视频时长只能选择 15、30 或 60 秒",
      400,
      "AVATAR_DURATION_INVALID",
    );
  }
  return duration;
}

function engineOf(value) {
  const requested = String(value || "auto").trim().toLowerCase();
  const normalized = requested === "basic" ? "runninghub" : requested || "auto";
  if (!AVATAR_ENGINES.includes(normalized)) {
    throw failure(
      "数字人引擎只能选择自动、RunningHub、HeyGen 或可灵",
      400,
      "AVATAR_ENGINE_INVALID",
    );
  }
  return normalized;
}

function scriptOf(value, durationSeconds) {
  const script = String(value || "").trim();
  const limit = { 15: 120, 30: 240, 60: 480 }[durationOf(durationSeconds)];
  if (!script || script.length > limit) {
    throw failure(
      `口播稿必须为1至${limit}个字符`,
      400,
      "AVATAR_SCRIPT_INVALID",
    );
  }
  return script;
}

function safeVoiceId(value) {
  const id = String(value || "").trim();
  if (!/^[a-z0-9_-]{3,64}$/iu.test(id)) {
    throw failure("数字人音色编号无效", 400, "AVATAR_VOICE_INVALID");
  }
  return id;
}

function safePrompt(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}

function safeTitle(value) {
  const title = String(value || "数字人口播视频")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  return title || "数字人口播视频";
}

function safeVoiceLabel(value) {
  return (
    String(value || "我的声音")
      .replace(/[\u0000-\u001f\u007f]/gu, "")
      .replace(/\s+/gu, "")
      .trim()
      .slice(0, 12) || "我的声音"
  );
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value || "");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function jsonForStorage(value, max = 24_000) {
  let encoded = "{}";
  try {
    encoded = JSON.stringify(value ?? {});
  } catch {
    encoded = "{}";
  }
  return encoded.length <= max
    ? encoded
    : JSON.stringify({ truncated: true, byteLength: Buffer.byteLength(encoded) });
}

function timestamp(now = Date.now) {
  const value = Number(now());
  return new Date(Number.isFinite(value) ? value : Date.now()).toISOString();
}

function tableExists(name) {
  return Boolean(
    q.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name),
  );
}

function billingModelForEngine(engine, durationSeconds) {
  const requested = engineOf(engine);
  const duration = durationOf(durationSeconds);
  return requested === "auto"
    ? `avatar-auto-${duration}`
    : `${requested}-avatar-${duration}`;
}

function configuredVideoPrice(model) {
  const config = billing();
  const amount = Number(config.video?.[model] ?? config.video?.default);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw failure(
      "数字人成片计费价格未正确配置",
      503,
      "AVATAR_BILLING_PRICE_MISSING",
    );
  }
  return amount;
}

function creditsForCostCny(amount) {
  const value = Number(amount);
  const config = billing();
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isFinite(Number(config.marginMultiplier)) ||
    !Number.isFinite(Number(config.creditYuan)) ||
    Number(config.creditYuan) <= 0
  ) {
    throw failure(
      "供应商费用证据不足，任务已转待账务对账",
      409,
      "AVATAR_BILLING_EVIDENCE_MISSING",
    );
  }
  return Math.max(
    1,
    Math.ceil(
      (value * Number(config.marginMultiplier)) / Number(config.creditYuan),
    ),
  );
}

function parseAvatarVideoUrl(value) {
  try {
    return parseRunningHubVideoUrl(value);
  } catch {
    throw failure(
      "数字人供应商成片地址未通过安全校验",
      502,
      "AVATAR_OUTPUT_UNSAFE",
    );
  }
}

function bufferStartsWith(buffer, signature, offset = 0) {
  return (
    buffer.length >= offset + signature.length &&
    buffer.subarray(offset, offset + signature.length).equals(signature)
  );
}

function detectImage(buffer) {
  if (bufferStartsWith(buffer, Buffer.from([0xff, 0xd8, 0xff]))) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  if (
    bufferStartsWith(
      buffer,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return { ext: "png", mime: "image/png" };
  }
  if (
    bufferStartsWith(buffer, Buffer.from("RIFF")) &&
    bufferStartsWith(buffer, Buffer.from("WEBP"), 8)
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  throw failure(
    "人物图片内容必须是 JPEG、PNG 或 WebP",
    400,
    "AVATAR_IMAGE_INVALID",
  );
}

function detectAudio(buffer) {
  if (
    bufferStartsWith(buffer, Buffer.from("RIFF")) &&
    bufferStartsWith(buffer, Buffer.from("WAVE"), 8)
  ) {
    return { ext: "wav", mime: "audio/wav" };
  }
  if (
    bufferStartsWith(buffer, Buffer.from("ID3")) ||
    (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
  ) {
    return { ext: "mp3", mime: "audio/mpeg" };
  }
  if (
    buffer.length >= 12 &&
    bufferStartsWith(buffer, Buffer.from("ftyp"), 4)
  ) {
    return { ext: "m4a", mime: "audio/mp4" };
  }
  throw failure(
    "口播音频内容必须是 MP3、WAV 或 M4A",
    400,
    "AVATAR_AUDIO_INVALID",
  );
}

function detectVideo(buffer) {
  if (
    buffer.length >= 16 &&
    bufferStartsWith(buffer, Buffer.from("ftyp"), 4)
  ) {
    const brand = buffer.subarray(8, 12).toString("ascii");
    return brand === "qt  "
      ? { ext: "mov", mime: "video/quicktime" }
      : { ext: "mp4", mime: "video/mp4" };
  }
  if (
    bufferStartsWith(buffer, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  ) {
    return { ext: "webm", mime: "video/webm" };
  }
  throw failure(
    "数字人供应商返回的成片无法验证为真实视频文件",
    502,
    "AVATAR_VIDEO_INVALID",
  );
}

function assertedFileExtension(name, detected, kind) {
  const ext = path.extname(String(name || "")).slice(1).toLowerCase();
  if (!ext) return;
  const aliases =
    kind === "image"
      ? { jpg: ["jpg", "jpeg"], png: ["png"], webp: ["webp"] }
      : { mp3: ["mp3"], wav: ["wav"], m4a: ["m4a", "mp4"] };
  if (!(aliases[detected.ext] || []).includes(ext)) {
    throw failure(
      `${kind === "image" ? "图片" : "音频"}内容与文件扩展名不一致`,
      400,
      "AVATAR_ASSET_EXTENSION_MISMATCH",
    );
  }
}

function cleanOriginalName(value, fallback) {
  const name = path
    .basename(String(value || fallback))
    .replace(/[\u0000-\u001f\u007f]/gu, "_")
    .slice(0, 180);
  return name || fallback;
}

function publicAsset(row) {
  return {
    id: Number(row.id),
    name: row.name,
    kind:
      row.purpose === "avatar-image"
        ? "image"
        : row.purpose === "avatar-audio"
          ? "audio"
          : "video",
    ext: row.ext,
    mime: row.mime,
    size: Number(row.size || 0),
    url: row.file_url,
    createdAt: row.created_at,
  };
}

async function persistUploadedBytes({
  tenantId,
  userId,
  purpose,
  originalName,
  bytes,
  format,
}) {
  if (Number(curTenant()) !== Number(tenantId)) {
    throw failure(
      "租户文件上下文不一致",
      500,
      "AVATAR_TENANT_CONTEXT_INVALID",
    );
  }
  const directory = path.join(UPLOAD_ROOT, String(tenantId), purpose);
  await fsp.mkdir(directory, { recursive: true, mode: 0o750 });
  const storedName = `${Date.now()}-${crypto.randomBytes(10).toString("hex")}.${format.ext}`;
  const absolute = path.join(directory, storedName);
  const fileUrl = `/uploads/files/${tenantId}/${purpose}/${encodeURIComponent(storedName)}`;
  try {
    await fsp.writeFile(absolute, bytes, { flag: "wx", mode: 0o600 });
    const inserted = q.run(
      `INSERT INTO uploaded_files(
        user_id,name,stored_name,ext,mime,size,purpose,file_path,file_url,
        extracted_text,extract_mode
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      userId,
      cleanOriginalName(originalName, storedName),
      storedName,
      format.ext,
      format.mime,
      bytes.length,
      purpose,
      absolute,
      fileUrl,
      "",
      "数字人安全素材",
    );
    return q.get(
      "SELECT * FROM uploaded_files WHERE tenant_id=? AND id=?",
      tenantId,
      inserted.lastInsertRowid,
    );
  } catch (error) {
    await fsp.rm(absolute, { force: true }).catch(() => {});
    throw error;
  }
}

export async function saveAvatarAsset({
  user,
  name,
  mime = "",
  b64,
  kind,
}) {
  const tenantId = idOf(user?.tenant_id || curTenant(), "租户编号");
  const userId = idOf(user?.id, "用户编号");
  if (!q.get("SELECT id FROM users WHERE tenant_id=? AND id=?", tenantId, userId)) {
    throw failure("上传账号不存在", 404, "AVATAR_USER_NOT_FOUND");
  }
  if (!new Set(["image", "audio"]).has(kind)) {
    throw failure("素材类型只能是图片或音频", 400, "AVATAR_ASSET_KIND_INVALID");
  }
  const maxBytes = kind === "image" ? AVATAR_MAX_IMAGE_BYTES : AVATAR_MAX_AUDIO_BYTES;
  const bytes = decodeBase64File(b64, maxBytes);
  const format = kind === "image" ? detectImage(bytes) : detectAudio(bytes);
  assertedFileExtension(name, format, kind);
  const suppliedMime = String(mime || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (suppliedMime && suppliedMime !== format.mime) {
    const compatible =
      format.ext === "mp3" && suppliedMime === "audio/mp3";
    if (!compatible) {
      throw failure(
        "素材内容与声明的文件类型不一致",
        400,
        "AVATAR_ASSET_MIME_MISMATCH",
      );
    }
  }
  const row = await persistUploadedBytes({
    tenantId,
    userId,
    purpose: kind === "image" ? "avatar-image" : "avatar-audio",
    originalName: name,
    bytes,
    format,
  });
  return publicAsset(row);
}

export function listAvatarAssets(user, kind = "") {
  const tenantId = idOf(user?.tenant_id || curTenant(), "租户编号");
  const requested = String(kind || "").trim();
  if (requested && !new Set(["image", "audio"]).has(requested)) {
    throw failure("素材筛选类型不正确", 400, "AVATAR_ASSET_KIND_INVALID");
  }
  const scope = userScopeClause(user, "user_id");
  const purposes = requested
    ? [requested === "image" ? "avatar-image" : "avatar-audio"]
    : ["avatar-image", "avatar-audio"];
  const placeholders = purposes.map(() => "?").join(",");
  return q
    .all(
      `SELECT id,user_id,name,ext,mime,size,purpose,file_url,created_at
      FROM uploaded_files
      WHERE tenant_id=? AND purpose IN (${placeholders})${scope.sql}
      ORDER BY id DESC LIMIT 200`,
      tenantId,
      ...purposes,
      ...scope.params,
    )
    .map(publicAsset);
}

function resolveAvatarAsset({ tenantId, fileId, kind, user = null }) {
  const id = idOf(fileId, kind === "image" ? "图片素材编号" : "音频素材编号");
  const purpose = kind === "image" ? "avatar-image" : "avatar-audio";
  const row = q.get(
    `SELECT * FROM uploaded_files
    WHERE tenant_id=? AND id=? AND purpose=?`,
    tenantId,
    id,
    purpose,
  );
  if (!row || (user && !canAccessOwner(user, row.user_id))) {
    throw failure(
      `${kind === "image" ? "人物图片" : "口播音频"}不存在或无权引用`,
      404,
      "AVATAR_ASSET_NOT_FOUND",
    );
  }
  const tenantRoot = path.resolve(UPLOAD_ROOT, String(tenantId));
  let resolvedRoot;
  let resolvedFile;
  try {
    resolvedRoot = fs.realpathSync(tenantRoot);
    resolvedFile = fs.realpathSync(path.resolve(String(row.file_path || "")));
  } catch {
    throw failure("数字人素材文件已丢失", 409, "AVATAR_ASSET_MISSING");
  }
  if (
    !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`) ||
    fs.lstatSync(resolvedFile).isSymbolicLink()
  ) {
    throw failure("数字人素材文件路径越界", 409, "AVATAR_ASSET_PATH_INVALID");
  }
  const stat = fs.statSync(resolvedFile);
  const maxBytes = kind === "image" ? AVATAR_MAX_IMAGE_BYTES : AVATAR_MAX_AUDIO_BYTES;
  if (
    !stat.isFile() ||
    stat.size <= 0 ||
    stat.size > maxBytes ||
    stat.size !== Number(row.size || 0)
  ) {
    throw failure("数字人素材完整性校验失败", 409, "AVATAR_ASSET_INTEGRITY_INVALID");
  }
  const bytes = fs.readFileSync(resolvedFile);
  const format = kind === "image" ? detectImage(bytes) : detectAudio(bytes);
  if (format.ext !== String(row.ext || "").toLowerCase()) {
    throw failure("数字人素材内容已发生变化", 409, "AVATAR_ASSET_INTEGRITY_INVALID");
  }
  return {
    row,
    bytes,
    path: resolvedFile,
    fileName: row.name,
    mimeType: format.mime,
    ext: format.ext,
  };
}

async function defaultPrepareAudio({ asset, durationSeconds, signal }) {
  if (signal?.aborted) {
    throw failure("数字人任务已取消", 499, "AVATAR_CANCELLED");
  }
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "nanowork-avatar-audio-"));
  const output = path.join(directory, "bounded.wav");
  let source = asset?.path;
  const ffmpeg = String(process.env.AVATAR_FFMPEG_PATH || "ffmpeg").trim();
  try {
    if (!source && asset?.bytes) {
      const bytes = Buffer.isBuffer(asset.bytes)
        ? asset.bytes
        : Buffer.from(asset.bytes);
      const format = detectAudio(bytes);
      source = path.join(directory, `source.${format.ext}`);
      await fsp.writeFile(source, bytes, { flag: "wx", mode: 0o600 });
    }
    if (!source) {
      throw failure(
        "数字人口播音频缺失",
        409,
        "AVATAR_AUDIO_PREPARE_FAILED",
      );
    }
    await execFileAsync(
      ffmpeg,
      [
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-i",
        source,
        "-t",
        String(durationSeconds),
        "-vn",
        "-ac",
        "2",
        "-ar",
        "44100",
        "-c:a",
        "pcm_s16le",
        output,
      ],
      { timeout: 120_000, signal, maxBuffer: 1024 * 1024 },
    );
    const bytes = await fsp.readFile(output);
    if (!bytes.length || bytes.length > AVATAR_MAX_AUDIO_BYTES) {
      throw failure(
        "数字人音频时长限制处理失败",
        502,
        "AVATAR_AUDIO_PREPARE_FAILED",
      );
    }
    detectAudio(bytes);
    return {
      bytes,
      fileName: `voice-${durationSeconds}s.wav`,
      mimeType: "audio/wav",
    };
  } catch (error) {
    if (error instanceof AvatarJobError) throw error;
    if (signal?.aborted || error?.name === "AbortError") {
      throw failure("数字人任务已取消", 499, "AVATAR_CANCELLED");
    }
    throw failure(
      "服务器无法安全限制口播音频时长，请检查 FFmpeg 配置",
      503,
      "AVATAR_AUDIO_PREPARE_FAILED",
    );
  } finally {
    await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function defaultDownloadVideo({ url, signal, fetchImpl }) {
  parseAvatarVideoUrl(url);
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "nanowork-avatar-video-"));
  try {
    const downloaded = await downloadProviderVideoClip({
      url,
      outputDir: directory,
      fetchImpl: fetchImpl || globalThis.fetch,
      signal,
      maxBytes: AVATAR_MAX_VIDEO_BYTES,
    });
    const bytes = await fsp.readFile(downloaded.path);
    const format = detectVideo(bytes);
    return {
      bytes,
      format,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function defaultDownloadTtsAudio({
  url,
  signal,
  fetchImpl = globalThis.fetch,
}) {
  const safeUrl = parseMiniMaxAudioUrl(url);
  if (typeof fetchImpl !== "function") {
    throw failure(
      "数字人配音下载器未配置",
      503,
      "AVATAR_TTS_DOWNLOAD_UNAVAILABLE",
    );
  }
  let response;
  try {
    response = await fetchImpl(safeUrl, {
      method: "GET",
      redirect: "follow",
      signal,
      headers: { Accept: "audio/mpeg,audio/wav,audio/mp4;q=0.9" },
    });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") {
      throw failure("数字人配音下载已取消", 499, "AVATAR_CANCELLED");
    }
    throw failure(
      "数字人真实配音下载失败",
      502,
      "AVATAR_TTS_DOWNLOAD_FAILED",
    );
  }
  if (!response?.ok) {
    throw failure(
      "数字人真实配音下载失败",
      502,
      "AVATAR_TTS_DOWNLOAD_FAILED",
    );
  }
  if (response.url) parseMiniMaxAudioUrl(response.url);
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > AVATAR_MAX_AUDIO_BYTES) {
    throw failure(
      "数字人配音文件超过安全大小上限",
      413,
      "AVATAR_TTS_AUDIO_TOO_LARGE",
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const format = detectAudio(bytes);
  if (!bytes.length || bytes.length > AVATAR_MAX_AUDIO_BYTES) {
    throw failure(
      "数字人配音文件为空或超过安全大小上限",
      502,
      "AVATAR_TTS_AUDIO_INVALID",
    );
  }
  return {
    bytes,
    fileName: `tts.${format.ext}`,
    mimeType: format.mime,
  };
}

function providerPricing(engine, durationSeconds) {
  return {
    amount: configuredVideoPrice(
      billingModelForEngine(engine, durationSeconds),
    ),
    currency: "CNY",
    source: "nanowork_billing_config",
  };
}

function explicitDefaultProvider({ engine, tenantId, durationSeconds }) {
  if (engine === "runninghub") {
    const config = getTenantConfig("avatar_runninghub", {}, tenantId) || {};
    return createRunningHubClient({
      config,
      pricing: providerPricing(engine, durationSeconds),
    });
  }
  if (engine === "heygen") {
    const config = getTenantConfig("avatar_heygen", {}, tenantId) || {};
    return createHeyGenAvatarClient({
      config,
      apiKey: config.apiKey || config.key || process.env.HEYGEN_API_KEY,
      pricing: providerPricing(engine, durationSeconds),
    });
  }
  const config = getTenantConfig("avatar_kling", {}, tenantId) || {};
  const publicBaseUrl = avatarProviderPublicBaseUrl(config.publicBaseUrl);
  const client = createKlingAvatarClient({
    config,
    apiKey: config.apiKey || config.key || process.env.YUNWU_API_KEY,
    baseUrl: config.baseUrl || process.env.YUNWU_BASE_URL,
    publicBaseUrl,
    pricing: providerPricing("kling", durationSeconds),
  });
  if (publicBaseUrl) return client;
  return Object.freeze({
    ...client,
    ready: () => false,
  });
}

function providerIsReady(provider) {
  return Boolean(
    provider &&
      typeof (provider.synthesize || provider.synth) === "function" &&
      (typeof provider.ready !== "function" || provider.ready()),
  );
}

function providerId(provider, fallback = "") {
  const raw = String(
    provider?.providerName || provider?.provider?.id || provider?.id || fallback,
  ).toLowerCase();
  if (raw.includes("runninghub") || raw === "basic") return "runninghub";
  if (raw.includes("heygen")) return "heygen";
  if (raw.includes("kling") || raw.includes("可灵")) return "kling";
  const requested = engineOf(fallback || "auto");
  if (requested !== "auto") return requested;
  throw failure(
    "数字人供应商未返回可核验的引擎标识",
    502,
    "AVATAR_PROVIDER_ID_MISSING",
  );
}

function fallbackEligible(error) {
  const code = String(error?.code || "");
  if (
    error?.name === "AbortError" ||
    code.includes("CANCEL") ||
    code.includes("ABORT") ||
    Number(error?.status) === 499
  ) {
    return false;
  }
  return /^(?:HEYGEN|KLING|RUNNINGHUB|PROVIDER)_/u.test(code);
}

function autoDefaultProvider(context) {
  const candidates = ["heygen", "kling", "runninghub"]
    .map((engine) => ({
      engine,
      provider: explicitDefaultProvider({ ...context, engine }),
    }))
    .filter((item) => providerIsReady(item.provider));
  return createAutoAvatarProvider(candidates);
}

export function createAutoAvatarProvider(candidates = []) {
  const available = candidates
    .map((item) => ({
      engine: engineOf(item?.engine),
      provider: item?.provider,
    }))
    .filter(
      (item) => item.engine !== "auto" && providerIsReady(item.provider),
    );
  return Object.freeze({
    providerName: "auto",
    requiresPublicAssetUrls: available.some(
      (item) => item.provider?.requiresPublicAssetUrls === true,
    ),
    ready: () => available.length > 0,
    async synthesize(payload) {
      const attempts = [];
      for (let index = 0; index < available.length; index += 1) {
        const candidate = available[index];
        payload.onProgress?.({
          phase: index === 0 ? "provider" : "provider_retry",
          message:
            index === 0
              ? `自动选择 ${candidate.engine} 数字人引擎`
              : `自动回退到 ${candidate.engine} 数字人引擎`,
          attempt: index + 1,
        });
        const synthesize =
          candidate.provider.synthesize || candidate.provider.synth;
        try {
          const result = await synthesize.call(candidate.provider, payload);
          return {
            ...result,
            fallbackAttempts: [
              ...attempts,
              { provider: candidate.engine, status: "succeeded" },
            ],
          };
        } catch (error) {
          attempts.push({
            provider: candidate.engine,
            status: "failed",
            code: SAFE_CODE.test(String(error?.code || ""))
              ? String(error.code)
              : "AVATAR_PROVIDER_FAILED",
          });
          if (index === available.length - 1 || !fallbackEligible(error)) {
            if (error && ["object", "function"].includes(typeof error)) {
              try {
                Object.defineProperty(error, "fallbackAttempts", {
                  value: attempts,
                  enumerable: true,
                  configurable: true,
                });
                throw error;
              } catch (attachError) {
                if (attachError === error) throw error;
              }
            }
            const wrapped = failure(
              "自动数字人引擎执行失败",
              Number(error?.status) || 502,
              SAFE_CODE.test(String(error?.code || ""))
                ? String(error.code)
                : "AVATAR_PROVIDER_FAILED",
            );
            Object.defineProperty(wrapped, "fallbackAttempts", {
              value: attempts,
              enumerable: true,
            });
            throw wrapped;
          }
        }
      }
      throw failure(
        "自动模式没有可用的数字人引擎",
        503,
        "PROVIDER_CREDENTIALS_MISSING",
      );
    },
  });
}

function defaultProviderFactory({
  tenantId,
  durationSeconds,
  engineRequested = "auto",
}) {
  const engine = engineOf(engineRequested);
  return engine === "auto"
    ? autoDefaultProvider({ tenantId, durationSeconds })
    : explicitDefaultProvider({ engine, tenantId, durationSeconds });
}

function defaultVoiceClientFactory({ tenantId }) {
  const config = getTenantConfig("avatar_minimax_voice", {}, tenantId) || {};
  return createMiniMaxVoiceClient({
    apiKey: config.apiKey || config.key || process.env.YUNWU_API_KEY,
    baseUrl: config.baseUrl,
  });
}

function assertProvider(provider, engine = "auto") {
  if (
    !provider ||
    typeof (provider.synthesize || provider.synth) !== "function" ||
    (typeof provider.ready === "function" && !provider.ready())
  ) {
    throw failure(
      `${engine === "auto" ? "自动模式没有可用的" : engine} 数字人通道未配置服务端凭据`,
      503,
      "PROVIDER_CREDENTIALS_MISSING",
    );
  }
  return provider;
}

function appendStep(jobId, event, now = Date.now) {
  const row = q.get(
    "SELECT steps_json,status FROM avatar_jobs WHERE tenant_id=? AND id=?",
    curTenant(),
    jobId,
  );
  if (!row || ACTIVE_TERMINAL.has(row.status)) return;
  const steps = parseJson(row.steps_json, []);
  const list = Array.isArray(steps) ? steps : [];
  const step = {
    phase: String(event?.phase || "running").slice(0, 60),
    message: String(event?.message || "数字人任务处理中")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 240),
    at: timestamp(now),
    ...(event?.state ? { state: String(event.state).slice(0, 40) } : {}),
    ...(Number.isFinite(Number(event?.attempt))
      ? { attempt: Number(event.attempt) }
      : {}),
  };
  const progressByPhase = {
    queued: 4,
    validate_assets: 12,
    tts: 16,
    prepare_audio: 20,
    provider: 24,
    provider_retry: 26,
    upload_image: 30,
    upload_audio: 38,
    create: 48,
    queue_wait: 50,
    accepted: 55,
    polling: 70,
    download: 84,
    persist: 90,
    settle: 96,
    done: 100,
  };
  const progress = Math.max(
    Number(q.get("SELECT progress FROM avatar_jobs WHERE tenant_id=? AND id=?", curTenant(), jobId)?.progress || 0),
    Number(progressByPhase[step.phase] || 8),
  );
  q.run(
    `UPDATE avatar_jobs SET steps_json=?,progress=?,updated_at=?
    WHERE tenant_id=? AND id=? AND status IN ('queued','running')`,
    JSON.stringify([...list.slice(-79), step]),
    Math.min(100, progress),
    timestamp(now),
    curTenant(),
    jobId,
  );
}

function safeError(error) {
  if (error instanceof AvatarJobError) {
    return { code: error.code, message: error.message };
  }
  const code = SAFE_CODE.test(String(error?.code || ""))
    ? String(error.code)
    : "AVATAR_PROVIDER_FAILED";
  const known =
    error?.name === "RunningHubError" ||
    error?.name === "HeyGenAvatarError" ||
    error?.name === "KlingAvatarError" ||
    error?.name === "MiniMaxVoiceError" ||
    code.startsWith("RUNNINGHUB_") ||
    code.startsWith("HEYGEN_") ||
    code.startsWith("KLING_") ||
    code.startsWith("MINIMAX_") ||
    code === "PROVIDER_CREDENTIALS_MISSING";
  return {
    code,
    message: known
      ? String(error?.message || "数字人供应商任务失败").slice(0, 300)
      : "数字人任务处理失败，预授权已安全收口，可从原任务免费重试",
  };
}

function fallbackAttemptEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, AVATAR_ENGINES.length).flatMap((item) => {
    const provider = String(item?.provider || "").trim().toLowerCase();
    if (!["runninghub", "heygen", "kling"].includes(provider)) return [];
    const status = item?.status === "succeeded" ? "succeeded" : "failed";
    const code = String(item?.code || "");
    return [{
      provider,
      status,
      ...(status === "failed" && SAFE_CODE.test(code) ? { code } : {}),
    }];
  });
}

function providerEvidence(result) {
  const usage = result?.usage || result?.providerAttempt?.usage || {};
  const cost = result?.costEvidence || result?.cost || result?.providerAttempt?.cost || {};
  const networkRequests = Number(usage.networkRequests);
  const amount = Number(cost.amount);
  const currency = String(cost.currency || "").toUpperCase();
  if (!Number.isSafeInteger(networkRequests) || networkRequests <= 0) {
    throw failure(
      "供应商未返回可核验的真实调用用量，任务已转待账务对账",
      409,
      "AVATAR_BILLING_EVIDENCE_MISSING",
    );
  }
  if (!Number.isFinite(amount) || amount <= 0 || currency !== "CNY") {
    throw failure(
      "供应商未返回可结算的人民币费用证据，任务已转待账务对账",
      409,
      "AVATAR_BILLING_EVIDENCE_MISSING",
    );
  }
  return {
    usage: {
      ...usage,
      networkRequests,
      inputTokens: Number(usage.inputTokens || 0),
      outputTokens: Number(usage.outputTokens || 0),
    },
    cost: {
      ...cost,
      amount,
      currency,
    },
    actualCredits: creditsForCostCny(amount),
  };
}

function outputArtifact(row) {
  if (!row?.output_file_id || !row?.result_url || !row?.result_sha256) return null;
  const file = q.get(
    `SELECT id,user_id,file_path,file_url,size,mime,name
    FROM uploaded_files WHERE tenant_id=? AND id=? AND purpose='avatar-output'`,
    row.tenant_id,
    row.output_file_id,
  );
  if (
    !file ||
    file.file_url !== row.result_url ||
    Number(file.size || 0) !== Number(row.result_bytes || 0)
  ) {
    return null;
  }
  try {
    const stat = fs.statSync(file.file_path);
    if (!stat.isFile() || stat.size !== Number(file.size || 0)) return null;
  } catch {
    return null;
  }
  return file;
}

function ledgerFor(refType, refId, tenantId) {
  if (!tableExists("credit_holds")) return null;
  return q.get(
    `SELECT h.id,h.log_id,h.status,h.held_credits,h.settled_credits,
      l.credits ledger_credits,l.cost_yuan,l.balance_after
    FROM credit_holds h
    LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
    WHERE h.tenant_id=? AND h.ref_type=? AND h.ref_id=?
    ORDER BY h.id DESC LIMIT 1`,
    tenantId,
    refType,
    refId,
  );
}

function ledgerWasReleased(refType, refId, tenantId) {
  const ledger = ledgerFor(refType, refId, tenantId);
  return (
    ledger?.status === "settled" &&
    Number(ledger.settled_credits) === 0 &&
    Number(ledger.ledger_credits) === 0
  );
}

function jobBilling(row) {
  const ledger = ledgerFor(BILLING_REF, row.id, row.tenant_id);
  if (row.billing_status === "included") {
    return {
      state: "not_required",
      credits: 0,
      costYuan: Number(parseJson(row.cost_json)?.amount || 0),
      balance: balanceOfTenant(row.tenant_id),
      label: "免费重试已包含，不重复扣费",
      authoritative: true,
      ledger: {
        source: "avatar_free_retry",
        holdId: ledger ? Number(ledger.id) : null,
        logId: ledger ? Number(ledger.log_id) : null,
      },
    };
  }
  const stateMap = {
    pending: "missing",
    held: "held",
    settled: "settled",
    released: "released",
    pending_reconciliation: "pending_reconciliation",
  };
  const state = stateMap[row.billing_status] || "pending_reconciliation";
  const credits =
    state === "settled"
      ? Number(row.settled_credits ?? ledger?.settled_credits ?? 0)
      : state === "released"
        ? 0
        : Number(row.held_credits || ledger?.held_credits || 0) || null;
  const label = {
    missing: "预授权尚未建立",
    held: `已预授权 ${credits ?? "—"} 积分`,
    settled: `已结算 ${credits ?? 0} 积分`,
    released: "预授权已全额退回",
    pending_reconciliation: "待账务对账",
  }[state];
  return {
    state,
    credits,
    costYuan:
      state === "settled"
        ? Number(ledger?.cost_yuan ?? parseJson(row.cost_json)?.amount ?? 0)
        : null,
    balance:
      ledger?.balance_after == null
        ? balanceOfTenant(row.tenant_id)
        : Number(ledger.balance_after),
    label,
    authoritative: ["held", "settled", "released"].includes(state),
    ledger: {
      source: "credit_holds+credit_logs",
      holdId: ledger ? Number(ledger.id) : null,
      logId: ledger ? Number(ledger.log_id) : null,
      status: ledger?.status || null,
      heldCredits: ledger ? Number(ledger.held_credits) : null,
      settledCredits:
        ledger?.settled_credits == null ? null : Number(ledger.settled_credits),
    },
  };
}

function publicJob(row) {
  const billingView = jobBilling(row);
  const artifact = outputArtifact(row);
  const businessUsable =
    row.status === "done" &&
    Boolean(artifact) &&
    ["settled", "not_required"].includes(billingView.state);
  const steps = parseJson(row.steps_json, []);
  return {
    id: Number(row.id),
    sourceKey: `avatar:${row.id}`,
    deepLink: `/tasks?kind=avatar&id=${encodeURIComponent(String(row.id))}`,
    title: row.title,
    imageFileId: Number(row.image_file_id),
    audioFileId:
      row.audio_file_id == null ? null : Number(row.audio_file_id),
    inputMode: row.input_mode || "audio",
    scriptChars: String(row.script || "").length,
    voiceId: row.input_mode === "script" ? row.voice_id || null : null,
    prompt: row.prompt || "",
    requestedEngine: engineOf(row.engine_requested || "auto"),
    durationSeconds: Number(row.duration_seconds),
    status: row.status,
    billingStatus: row.billing_status,
    billing: billingView,
    progress: Number(row.progress || 0),
    steps: Array.isArray(steps) ? steps : [],
    provider: row.provider_name || null,
    providerTaskId: row.provider_task_id || null,
    usage: parseJson(row.usage_json, null),
    cost: parseJson(row.cost_json, null),
    ttsAttempt: parseJson(row.tts_attempt_json, null),
    retryCount: Number(row.retry_count || 0),
    freeRetriesRemaining: Math.max(
      0,
      AVATAR_MAX_FREE_RETRIES - Number(row.retry_count || 0),
    ),
    retryable:
      row.status === "failed" &&
      ["released", "included"].includes(row.billing_status) &&
      Number(row.retry_count || 0) < AVATAR_MAX_FREE_RETRIES,
    cancelable: ["queued", "running"].includes(row.status),
    artifactReady: Boolean(artifact),
    businessUsable,
    outputUrl: businessUsable ? row.result_url : null,
    resultSha256: businessUsable ? row.result_sha256 : null,
    resultBytes: businessUsable ? Number(row.result_bytes || 0) : null,
    error:
      ["failed", "cancelled"].includes(row.status)
        ? row.error_message || null
        : null,
    errorCode:
      ["failed", "cancelled"].includes(row.status)
        ? row.error_code || null
        : null,
    timeoutAt: row.timeout_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicVoice(row) {
  const billingView = (() => {
    const ledger = ledgerFor(VOICE_BILLING_REF, row.id, row.tenant_id);
    if (row.billing_status === "settled") {
      return {
        state: "settled",
        credits: Number(ledger?.settled_credits || ledger?.ledger_credits || 0),
        balance: Number(ledger?.balance_after ?? balanceOfTenant(row.tenant_id)),
        label: "声音克隆已结算",
      };
    }
    if (row.billing_status === "released") {
      return {
        state: "released",
        credits: 0,
        balance: Number(ledger?.balance_after ?? balanceOfTenant(row.tenant_id)),
        label: "声音克隆预授权已退回",
      };
    }
    return {
      state:
        row.billing_status === "held"
          ? "held"
          : row.billing_status === "pending_reconciliation"
            ? "pending_reconciliation"
            : "missing",
      credits: ledger ? Number(ledger.held_credits || 0) : null,
      balance: balanceOfTenant(row.tenant_id),
      label:
        row.billing_status === "pending_reconciliation"
          ? "声音克隆待账务对账"
          : "声音克隆处理中",
    };
  })();
  return {
    id: Number(row.id),
    sourceFileId: Number(row.source_file_id),
    label: row.label,
    voiceId:
      row.status === "ready" && row.billing_status === "settled"
        ? row.provider_voice_id
        : null,
    status: row.status,
    billingStatus: row.billing_status,
    billing: billingView,
    usable: row.status === "ready" && row.billing_status === "settled",
    providerAttempt: parseJson(row.provider_attempt_json, null),
    error: row.status === "failed" ? row.error_message : null,
    errorCode: row.status === "failed" ? row.error_code : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function authorizedJob(user, jobId) {
  const id = idOf(jobId, "数字人工单编号");
  const row = q.get(
    "SELECT * FROM avatar_jobs WHERE tenant_id=? AND id=?",
    curTenant(),
    id,
  );
  if (!row || !canAccessOwner(user, row.created_by)) {
    throw failure("数字人工单不存在或无权查看", 404, "AVATAR_JOB_NOT_FOUND");
  }
  return row;
}

function availableVoice(user, value) {
  const voiceId = safeVoiceId(value || AVATAR_SYSTEM_VOICES[0].id);
  const system = AVATAR_SYSTEM_VOICES.find((voice) => voice.id === voiceId);
  if (system) return system;
  const row = q.get(
    `SELECT id,created_by,label,provider_voice_id,status,billing_status
    FROM avatar_voices
    WHERE tenant_id=? AND provider_voice_id=? AND status='ready'
      AND billing_status='settled'`,
    curTenant(),
    voiceId,
  );
  if (!row || !canAccessOwner(user, row.created_by)) {
    throw failure(
      "所选克隆音色不存在、尚未结算或无权使用",
      404,
      "AVATAR_VOICE_NOT_FOUND",
    );
  }
  return { id: voiceId, label: row.label, cloned: true };
}

async function removeUploadedFile(row) {
  if (!row?.id) return;
  q.run(
    "DELETE FROM uploaded_files WHERE tenant_id=? AND id=?",
    row.tenant_id,
    row.id,
  );
  await fsp.rm(String(row.file_path || ""), { force: true }).catch(() => {});
}

async function removeOutputFile(row) {
  if (!row?.output_file_id) return;
  const file = q.get(
    `SELECT id,file_path FROM uploaded_files
    WHERE tenant_id=? AND id=? AND purpose='avatar-output'`,
    row.tenant_id,
    row.output_file_id,
  );
  if (!file) return;
  q.run(
    "DELETE FROM uploaded_files WHERE tenant_id=? AND id=? AND purpose='avatar-output'",
    row.tenant_id,
    file.id,
  );
  await fsp.rm(file.file_path, { force: true }).catch(() => {});
}

export function createAvatarJobService(options = {}) {
  const customVoiceClient = Boolean(options.voiceClientFactory || options.voiceClient);
  const providerFactory = options.providerFactory ||
    (options.provider ? () => options.provider : defaultProviderFactory);
  const voiceClientFactory = options.voiceClientFactory ||
    (options.voiceClient ? () => options.voiceClient : defaultVoiceClientFactory);
  const prepareAudioFn = options.prepareAudioFn || defaultPrepareAudio;
  const downloadTtsAudioFn =
    options.downloadTtsAudioFn || defaultDownloadTtsAudio;
  const downloadVideoFn = options.downloadVideoFn || defaultDownloadVideo;
  const publicAssetUrlFactory =
    options.publicAssetUrlFactory ||
    ((file, { tenantId, ttlSeconds }) => {
      const config = getTenantConfig("avatar_kling", {}, tenantId) || {};
      return createAvatarProviderAssetUrl(
        {
          tenantId,
          fileId: file.id,
          purpose: file.purpose,
        },
        {
          publicBaseUrl: config.publicBaseUrl,
          ttlSeconds,
        },
      );
    });
  const now = options.now || Date.now;
  const hardTimeoutMs = Number(options.hardTimeoutMs || AVATAR_HARD_TIMEOUT_MS);
  const active = new Map();

  async function providerFor(context) {
    return assertProvider(
      await providerFactory(context),
      engineOf(context.engineRequested || "auto"),
    );
  }

  async function voiceClientFor(context, capability = "cloneVoice") {
    const client = await voiceClientFactory(context);
    if (!client || typeof client[capability] !== "function") {
      throw failure(
        capability === "synthesize"
          ? "数字人配音通道未配置服务端凭据"
          : "声音克隆通道未配置服务端凭据",
        503,
        "PROVIDER_CREDENTIALS_MISSING",
      );
    }
    if (
      !customVoiceClient &&
      !process.env.YUNWU_API_KEY &&
      !getTenantConfig("avatar_minimax_voice", {}, context.tenantId)?.apiKey &&
      !getTenantConfig("avatar_minimax_voice", {}, context.tenantId)?.key
    ) {
      throw failure(
        "声音克隆通道未配置服务端凭据",
        503,
        "PROVIDER_CREDENTIALS_MISSING",
      );
    }
    return client;
  }

  async function createJob({
    user,
    title,
    imageFileId,
    audioFileId,
    durationSeconds,
    engine,
    script,
    voiceId,
    prompt,
  }) {
    const tenantId = idOf(user?.tenant_id || curTenant(), "租户编号");
    const userId = idOf(user?.id, "用户编号");
    const duration = durationOf(durationSeconds);
    const requestedEngine = engineOf(engine);
    resolveAvatarAsset({ tenantId, fileId: imageFileId, kind: "image", user });
    const inputMode = Number(audioFileId) > 0 ? "audio" : "script";
    let resolvedAudioFileId = null;
    let resolvedScript = "";
    let resolvedVoiceId = null;
    if (inputMode === "audio") {
      const audio = resolveAvatarAsset({
        tenantId,
        fileId: audioFileId,
        kind: "audio",
        user,
      });
      resolvedAudioFileId = Number(audio.row.id);
    } else {
      resolvedScript = scriptOf(script, duration);
      resolvedVoiceId = availableVoice(user, voiceId).id;
      await voiceClientFor({ tenantId }, "synthesize");
    }
    await providerFor({
      tenantId,
      durationSeconds: duration,
      engineRequested: requestedEngine,
    });
    const billingModel = billingModelForEngine(requestedEngine, duration);
    const heldCredits = estimateMaxCredits("video", billingModel);
    const inserted = q.run(
      `INSERT INTO avatar_jobs(
        created_by,title,image_file_id,audio_file_id,input_mode,script,voice_id,
        prompt,engine_requested,duration_seconds,status,
        billing_status,billing_model,held_credits,progress,steps_json,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,'queued','pending',?,?,0,'[]',?)`,
      userId,
      safeTitle(title),
      idOf(imageFileId, "图片素材编号"),
      resolvedAudioFileId,
      inputMode,
      resolvedScript,
      resolvedVoiceId,
      safePrompt(prompt),
      requestedEngine,
      duration,
      billingModel,
      heldCredits,
      timestamp(now),
    );
    const jobId = Number(inserted.lastInsertRowid);
    let hold;
    try {
      hold = holdCredits({
        userId,
        tenantId,
        feature: `数字人·${requestedEngine}·${duration}秒`,
        kind: "video",
        model: billingModel,
        credits: heldCredits,
        refType: BILLING_REF,
        refId: jobId,
        note: `数字人工单 #${jobId} 在 ${requestedEngine} 引擎调用前预授权`,
      });
      const changed = q.run(
        `UPDATE avatar_jobs SET billing_status='held',held_credits=?,updated_at=?
        WHERE tenant_id=? AND id=? AND status='queued' AND billing_status='pending'`,
        hold.credits,
        timestamp(now),
        tenantId,
        jobId,
      );
      if (changed.changes !== 1) {
        releaseHold(hold, "数字人工单开工状态冲突，预授权全额退回");
        q.run(
          `UPDATE avatar_jobs SET status='failed',billing_status='released',
          error_code='AVATAR_JOB_STATE_CONFLICT',
          error_message='数字人工单开工状态冲突，预授权已退回',completed_at=?,updated_at=?
          WHERE tenant_id=? AND id=?`,
          timestamp(now),
          timestamp(now),
          tenantId,
          jobId,
        );
        throw failure(
          "数字人工单状态冲突，请刷新后重试",
          409,
          "AVATAR_JOB_STATE_CONFLICT",
        );
      }
      appendStep(jobId, {
        phase: "queued",
        message: "数字人工单已受理，等待后台执行",
      }, now);
      return publicJob(
        q.get("SELECT * FROM avatar_jobs WHERE tenant_id=? AND id=?", tenantId, jobId),
      );
    } catch (error) {
      if (!hold) {
        q.run(
          "DELETE FROM avatar_jobs WHERE tenant_id=? AND id=? AND billing_status='pending'",
          tenantId,
          jobId,
        );
      }
      throw error;
    }
  }

  function listJobs(user, { limit = 50 } = {}) {
    const tenantId = idOf(user?.tenant_id || curTenant(), "租户编号");
    const scope = userScopeClause(user, "created_by");
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    return q
      .all(
        `SELECT * FROM avatar_jobs
        WHERE tenant_id=?${scope.sql} ORDER BY id DESC LIMIT ?`,
        tenantId,
        ...scope.params,
        safeLimit,
      )
      .map(publicJob);
  }

  function getJob(user, jobId) {
    return publicJob(authorizedJob(user, jobId));
  }

  async function getMeta(user) {
    const tenantId = idOf(user?.tenant_id || curTenant(), "租户编号");
    const durationSeconds = 30;
    const labels = {
      auto: "自动（HeyGen → 可灵 → RunningHub）",
      runninghub: "基础版 · RunningHub",
      heygen: "HeyGen · Avatar IV",
      kling: "可灵 · 照片对口型",
    };
    const availability = {};
    for (const engine of ["runninghub", "heygen", "kling"]) {
      try {
        availability[engine] = providerIsReady(
          await providerFactory({
            tenantId,
            durationSeconds,
            engineRequested: engine,
          }),
        );
      } catch {
        availability[engine] = false;
      }
    }
    availability.auto = Object.values(availability).some(Boolean);
    let ttsReady = false;
    try {
      await voiceClientFor({ tenantId }, "synthesize");
      ttsReady = true;
    } catch {
      ttsReady = false;
    }
    return {
      engines: ["auto", "runninghub", "heygen", "kling"].map((engine) => ({
        key: engine,
        label: labels[engine],
        ready: Boolean(availability[engine]),
        billingModels: Object.fromEntries(
          AVATAR_DURATIONS.map((duration) => [
            String(duration),
            billingModelForEngine(engine, duration),
          ]),
        ),
      })),
      activeEngine:
        ["heygen", "kling", "runninghub"].find(
          (engine) => availability[engine],
        ) || null,
      durations: [...AVATAR_DURATIONS],
      ttsReady,
      systemVoices: AVATAR_SYSTEM_VOICES.map((voice) => ({
        ...voice,
        voiceId: voice.id,
        usable: ttsReady,
        status: ttsReady ? "ready" : "unavailable",
      })),
    };
  }

  async function persistOutput(row, downloaded) {
    const bytes = Buffer.isBuffer(downloaded?.bytes)
      ? downloaded.bytes
      : downloaded?.bytes instanceof Uint8Array
        ? Buffer.from(downloaded.bytes)
        : null;
    if (!bytes?.length || bytes.length > AVATAR_MAX_VIDEO_BYTES) {
      throw failure(
        "数字人供应商成片为空或超过安全大小上限",
        502,
        "AVATAR_VIDEO_INVALID",
      );
    }
    const format = downloaded.format || detectVideo(bytes);
    const detected = detectVideo(bytes);
    if (format.ext !== detected.ext) {
      throw failure(
        "数字人供应商成片格式证据不一致",
        502,
        "AVATAR_VIDEO_INVALID",
      );
    }
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (downloaded.sha256 && downloaded.sha256 !== sha256) {
      throw failure(
        "数字人供应商成片哈希校验失败",
        502,
        "AVATAR_VIDEO_INTEGRITY_INVALID",
      );
    }
    const file = await persistUploadedBytes({
      tenantId: row.tenant_id,
      userId: row.created_by,
      purpose: "avatar-output",
      originalName: `avatar-${row.id}.${format.ext}`,
      bytes,
      format,
    });
    return { file, sha256, bytes: bytes.length };
  }

  function markPendingReconciliation(jobId, error) {
    const safe = safeError(error);
    q.run(
      `UPDATE avatar_jobs SET status='failed',billing_status='pending_reconciliation',
      error_code=?,error_message=?,completed_at=?,updated_at=?
      WHERE tenant_id=? AND id=? AND status='running'`,
      safe.code,
      safe.message,
      timestamp(now),
      timestamp(now),
      curTenant(),
      jobId,
    );
  }

  function settleFailure(jobId, error) {
    const row = q.get(
      "SELECT * FROM avatar_jobs WHERE tenant_id=? AND id=?",
      curTenant(),
      jobId,
    );
    if (!row || row.status === "cancelled" || row.status === "done") return;
    const safe = safeError(error);
    let billingStatus = row.billing_status;
    if (billingStatus === "held") {
      const hold = findHoldByRef(BILLING_REF, jobId, row.tenant_id);
      try {
        const released = hold
          ? releaseHold(hold, `数字人未交付：${safe.message}`)
          : null;
        billingStatus =
          released || ledgerWasReleased(BILLING_REF, jobId, row.tenant_id)
            ? "released"
            : "pending_reconciliation";
      } catch {
        billingStatus = "pending_reconciliation";
      }
    }
    q.run(
      `UPDATE avatar_jobs SET status='failed',billing_status=?,error_code=?,
      error_message=?,completed_at=?,updated_at=?
      WHERE tenant_id=? AND id=? AND status IN ('queued','running')`,
      billingStatus,
      safe.code,
      billingStatus === "pending_reconciliation"
        ? `${safe.message}；退款或结算待账务对账`
        : safe.message,
      timestamp(now),
      timestamp(now),
      row.tenant_id,
      jobId,
    );
  }

  async function runJob(jobId, tenantId = curTenant()) {
    const id = idOf(jobId, "数字人工单编号");
    const tid = idOf(tenantId, "租户编号");
    return runWithTenant(tid, async () => {
      const startedAt = timestamp(now);
      const timeoutAt = new Date(Number(now()) + hardTimeoutMs).toISOString();
      const claimed = q.run(
        `UPDATE avatar_jobs SET status='running',progress=8,started_at=?,timeout_at=?,
        error_code=NULL,error_message=NULL,updated_at=?
        WHERE tenant_id=? AND id=? AND status='queued'
          AND billing_status IN ('held','included')`,
        startedAt,
        timeoutAt,
        startedAt,
        tid,
        id,
      );
      if (claimed.changes !== 1) {
        const current = q.get(
          "SELECT * FROM avatar_jobs WHERE tenant_id=? AND id=?",
          tid,
          id,
        );
        return current ? publicJob(current) : null;
      }
      const controller = new AbortController();
      const key = `${tid}:${id}`;
      active.set(key, controller);
      let timedOut = false;
      let rejectDeadline;
      const deadline = new Promise((_, reject) => {
        rejectDeadline = reject;
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        const error = failure(
          "数字人任务超过硬时限",
          504,
          "AVATAR_HARD_TIMEOUT",
        );
        controller.abort(error);
        rejectDeadline(error);
      }, hardTimeoutMs);
      timeout.unref?.();
      const beforeDeadline = (promise) => Promise.race([promise, deadline]);
      let stagedProviderAudio = null;
      try {
        let row = q.get(
          "SELECT * FROM avatar_jobs WHERE tenant_id=? AND id=?",
          tid,
          id,
        );
        appendStep(id, {
          phase: "validate_assets",
          message: "正在校验本租户人物图片与口播输入",
        }, now);
        const image = resolveAvatarAsset({
          tenantId: tid,
          fileId: row.image_file_id,
          kind: "image",
        });
        let audio;
        if (row.input_mode === "script") {
          appendStep(id, {
            phase: "tts",
            message: "正在用所选系统或克隆音色生成真实口播音频",
          }, now);
          const voiceClient = await beforeDeadline(
            voiceClientFor({ tenantId: tid }, "synthesize"),
          );
          const tts = await beforeDeadline(
            voiceClient.synthesize({
              text: scriptOf(row.script, row.duration_seconds),
              voiceId: safeVoiceId(row.voice_id),
              signal: controller.signal,
            }),
          );
          q.run(
            `UPDATE avatar_jobs SET tts_attempt_json=?,updated_at=?
            WHERE tenant_id=? AND id=? AND status='running'`,
            jsonForStorage(tts?.providerAttempt || {}),
            timestamp(now),
            tid,
            id,
          );
          audio = await beforeDeadline(
            downloadTtsAudioFn({
              url: tts?.audioUrl,
              signal: controller.signal,
              fetchImpl: options.ttsDownloadFetchImpl,
            }),
          );
        } else {
          audio = resolveAvatarAsset({
            tenantId: tid,
            fileId: row.audio_file_id,
            kind: "audio",
          });
        }
        appendStep(id, {
          phase: "prepare_audio",
          message: `正在把音频硬限制到 ${row.duration_seconds} 秒档`,
        }, now);
        const boundedAudio = await beforeDeadline(
          prepareAudioFn({
            asset: audio,
            durationSeconds: Number(row.duration_seconds),
            signal: controller.signal,
          }),
        );
        const provider = await beforeDeadline(
          providerFor({
            tenantId: tid,
            durationSeconds: Number(row.duration_seconds),
            engineRequested: row.engine_requested,
          }),
        );
        const synthesize = provider.synthesize || provider.synth;
        const imageInput = {
          bytes: image.bytes,
          fileName: image.fileName,
          mimeType: image.mimeType,
        };
        const audioInput = {
          ...boundedAudio,
          bytes: Buffer.isBuffer(boundedAudio?.bytes)
            ? boundedAudio.bytes
            : Buffer.from(boundedAudio?.bytes || []),
        };
        if (provider.requiresPublicAssetUrls === true) {
          const audioFormat = detectAudio(audioInput.bytes);
          stagedProviderAudio = await beforeDeadline(
            persistUploadedBytes({
              tenantId: tid,
              userId: row.created_by,
              purpose: "avatar-provider-audio",
              originalName: `avatar-provider-${id}.${audioFormat.ext}`,
              bytes: audioInput.bytes,
              format: audioFormat,
            }),
          );
          const ttlSeconds = Math.ceil(hardTimeoutMs / 1000) + 10 * 60;
          imageInput.publicUrl = publicAssetUrlFactory(image.row, {
            tenantId: tid,
            jobId: id,
            ttlSeconds,
          });
          audioInput.publicUrl = publicAssetUrlFactory(stagedProviderAudio, {
            tenantId: tid,
            jobId: id,
            ttlSeconds,
          });
          if (!imageInput.publicUrl || !audioInput.publicUrl) {
            throw failure(
              "可灵数字人需要配置 HTTPS 公网素材地址",
              503,
              "KLING_PUBLIC_ASSET_URL_MISSING",
            );
          }
        }
        const result = await beforeDeadline(
          synthesize.call(provider, {
            image: imageInput,
            audio: audioInput,
            prompt: row.prompt || "",
            signal: controller.signal,
            onProgress: (event) => appendStep(id, event, now),
          }),
        );
        const evidence = providerEvidence(result);
        const providerTaskId = String(result?.taskId || "").trim();
        if (!providerTaskId || providerTaskId.length > 200) {
          throw failure(
            "数字人供应商未返回有效任务编号",
            502,
            "AVATAR_PROVIDER_TASK_ID_MISSING",
          );
        }
        const actualProvider = providerId(result, row.engine_requested);
        const videoUrl = parseAvatarVideoUrl(result?.videoUrl).href;
        q.run(
          `UPDATE avatar_jobs SET provider_name=?,provider_task_id=?,
          provider_result_json=?,usage_json=?,cost_json=?,updated_at=?
          WHERE tenant_id=? AND id=? AND status='running'`,
          actualProvider,
          providerTaskId.slice(0, 200),
          jsonForStorage({
            provider: result?.provider,
            requestedEngine: row.engine_requested,
            actualProvider,
            model:
              result?.model ||
              (actualProvider === "runninghub"
                ? RUNNINGHUB_DEFAULT_MODEL
                : `${actualProvider}-avatar`),
            taskId: providerTaskId,
            videoUrl,
            fallbackAttempts:
              fallbackAttemptEvidence(result?.fallbackAttempts).length > 0
                ? fallbackAttemptEvidence(result.fallbackAttempts)
                : [{ provider: actualProvider, status: "succeeded" }],
          }),
          jsonForStorage(evidence.usage),
          jsonForStorage(evidence.cost),
          timestamp(now),
          tid,
          id,
        );
        appendStep(id, {
          phase: "download",
          message: `${actualProvider} 渲染完成，正在安全回收成片`,
        }, now);
        const downloaded = await beforeDeadline(
          downloadVideoFn({
            url: videoUrl,
            tenantId: tid,
            jobId: id,
            signal: controller.signal,
            fetchImpl: options.downloadFetchImpl,
          }),
        );
        row = q.get(
          "SELECT * FROM avatar_jobs WHERE tenant_id=? AND id=?",
          tid,
          id,
        );
        if (row?.status !== "running") {
          throw failure("数字人任务已取消", 499, "AVATAR_CANCELLED");
        }
        appendStep(id, {
          phase: "persist",
          message: "正在把真实视频成片写入租户文件库",
        }, now);
        const artifact = await beforeDeadline(persistOutput(row, downloaded));
        q.run(
          `UPDATE avatar_jobs SET output_file_id=?,result_url=?,result_sha256=?,
          result_bytes=?,updated_at=? WHERE tenant_id=? AND id=? AND status='running'`,
          artifact.file.id,
          artifact.file.file_url,
          artifact.sha256,
          artifact.bytes,
          timestamp(now),
          tid,
          id,
        );
        row = q.get(
          "SELECT * FROM avatar_jobs WHERE tenant_id=? AND id=?",
          tid,
          id,
        );
        if (row?.status !== "running") {
          await removeOutputFile({ ...row, output_file_id: artifact.file.id });
          throw failure("数字人任务已取消", 499, "AVATAR_CANCELLED");
        }
        appendStep(id, {
          phase: "settle",
          message: "成片已落库，正在按真实供应商费用结算",
        }, now);
        let settlement;
        if (row.billing_status === "included") {
          settlement = {
            credits: 0,
            balance: balanceOfTenant(tid),
            costYuan: evidence.cost.amount,
          };
        } else {
          const hold = findHoldByRef(BILLING_REF, id, tid);
          if (!hold) {
            throw failure(
              "数字人预授权账本缺失，任务已转待对账",
              409,
              "AVATAR_BILLING_HOLD_MISSING",
            );
          }
          settlement = settleHold(hold, {
            usage: evidence.usage,
            model: row.billing_model,
            aiMode: "api",
            credits: evidence.actualCredits,
            note: `${row.provider_name || "数字人供应商"} 成片已落库并通过哈希校验，真实请求 ${evidence.usage.networkRequests} 次`,
          });
          if (!settlement) {
            throw failure(
              "数字人结算状态发生变化，任务已转待对账",
              409,
              "AVATAR_BILLING_SETTLEMENT_CONFLICT",
            );
          }
        }
        const completedAt = timestamp(now);
        const done = q.run(
          `UPDATE avatar_jobs SET status='done',billing_status=?,settled_credits=?,
          progress=100,error_code=NULL,error_message=NULL,completed_at=?,updated_at=?
          WHERE tenant_id=? AND id=? AND status='running' AND billing_status=?`,
          row.billing_status === "included" ? "included" : "settled",
          Number(settlement.credits || 0),
          completedAt,
          completedAt,
          tid,
          id,
          row.billing_status,
        );
        if (done.changes !== 1) {
          throw failure(
            "数字人成片交付状态冲突，任务已转待对账",
            409,
            "AVATAR_FINALIZATION_CONFLICT",
          );
        }
        return publicJob(
          q.get("SELECT * FROM avatar_jobs WHERE tenant_id=? AND id=?", tid, id),
        );
      } catch (error) {
        const effectiveError = timedOut
          ? failure(
              "数字人任务超过硬时限，预授权已安全收口",
              504,
              "AVATAR_HARD_TIMEOUT",
            )
          : error;
        const code = String(effectiveError?.code || "");
        const row = q.get(
          "SELECT * FROM avatar_jobs WHERE tenant_id=? AND id=?",
          tid,
          id,
        );
        if (row?.status === "cancelled") return publicJob(row);
        const failedAttempts = fallbackAttemptEvidence(
          effectiveError?.fallbackAttempts,
        );
        if (failedAttempts.length > 0 && !row?.provider_result_json) {
          q.run(
            `UPDATE avatar_jobs SET provider_result_json=?,updated_at=?
            WHERE tenant_id=? AND id=? AND status='running'
              AND provider_result_json IS NULL`,
            jsonForStorage({
              requestedEngine: row.engine_requested,
              actualProvider: null,
              fallbackAttempts: failedAttempts,
            }),
            timestamp(now),
            tid,
            id,
          );
        }
        if (
          code.startsWith("AVATAR_BILLING_") ||
          code === "BILLING_HOLD_EXCEEDED" ||
          code === "CREDIT_HOLD_INTEGRITY_MISMATCH"
        ) {
          markPendingReconciliation(id, effectiveError);
        } else {
          settleFailure(id, effectiveError);
        }
        return publicJob(
          q.get("SELECT * FROM avatar_jobs WHERE tenant_id=? AND id=?", tid, id),
        );
      } finally {
        if (stagedProviderAudio) {
          await removeUploadedFile(stagedProviderAudio).catch(() => {});
        }
        clearTimeout(timeout);
        if (active.get(key) === controller) active.delete(key);
      }
    });
  }

  function schedule(jobId, tenantId = curTenant()) {
    const id = idOf(jobId, "数字人工单编号");
    const tid = idOf(tenantId, "租户编号");
    const key = `${tid}:${id}`;
    if (active.has(key)) return false;
    queueMicrotask(() => {
      void runJob(id, tid).catch((error) => {
        console.error(
          "[avatar-job] background failure",
          JSON.stringify({ tenantId: tid, jobId: id, code: safeError(error).code }),
        );
      });
    });
    return true;
  }

  function cancelJob(user, jobId) {
    const row = authorizedJob(user, jobId);
    if (!["queued", "running"].includes(row.status)) {
      throw failure("该数字人工单已经结束，无需取消", 409, "AVATAR_NOT_CANCELABLE");
    }
    const cancelledAt = timestamp(now);
    const changed = q.run(
      `UPDATE avatar_jobs SET status='cancelled',error_code='AVATAR_CANCELLED',
      error_message='用户已取消数字人任务',cancelled_at=?,completed_at=?,updated_at=?
      WHERE tenant_id=? AND id=? AND status IN ('queued','running')`,
      cancelledAt,
      cancelledAt,
      cancelledAt,
      row.tenant_id,
      row.id,
    );
    if (changed.changes !== 1) {
      throw failure("任务状态刚刚发生变化，请刷新", 409, "AVATAR_JOB_STATE_CONFLICT");
    }
    active.get(`${row.tenant_id}:${row.id}`)?.abort();
    let billingStatus = row.billing_status;
    if (row.billing_status === "held") {
      const hold = findHoldByRef(BILLING_REF, row.id, row.tenant_id);
      try {
        const released = hold
          ? releaseHold(hold, "用户取消数字人任务，预授权全额退回")
          : null;
        billingStatus =
          released || ledgerWasReleased(BILLING_REF, row.id, row.tenant_id)
            ? "released"
            : "pending_reconciliation";
      } catch {
        billingStatus = "pending_reconciliation";
      }
    }
    q.run(
      "UPDATE avatar_jobs SET billing_status=?,updated_at=? WHERE tenant_id=? AND id=? AND status='cancelled'",
      billingStatus,
      timestamp(now),
      row.tenant_id,
      row.id,
    );
    return publicJob(
      q.get("SELECT * FROM avatar_jobs WHERE tenant_id=? AND id=?", row.tenant_id, row.id),
    );
  }

  async function retryJob(user, jobId) {
    const row = authorizedJob(user, jobId);
    if (
      row.status !== "failed" ||
      !["released", "included"].includes(row.billing_status)
    ) {
      throw failure(
        "只有已退款或已包含的失败工单可以免费重试",
        409,
        "AVATAR_NOT_RETRYABLE",
      );
    }
    if (Number(row.retry_count || 0) >= AVATAR_MAX_FREE_RETRIES) {
      throw failure(
        "该数字人工单免费重试次数已用完，请新建任务",
        429,
        "AVATAR_RETRY_LIMIT",
      );
    }
    resolveAvatarAsset({
      tenantId: row.tenant_id,
      fileId: row.image_file_id,
      kind: "image",
      user,
    });
    if (row.input_mode === "script") {
      scriptOf(row.script, row.duration_seconds);
      availableVoice(user, row.voice_id);
      await voiceClientFor({ tenantId: row.tenant_id }, "synthesize");
    } else {
      resolveAvatarAsset({
        tenantId: row.tenant_id,
        fileId: row.audio_file_id,
        kind: "audio",
        user,
      });
    }
    await providerFor({
      tenantId: row.tenant_id,
      durationSeconds: row.duration_seconds,
      engineRequested: row.engine_requested,
    });
    await removeOutputFile(row);
    const changed = q.run(
      `UPDATE avatar_jobs SET status='queued',billing_status='included',
      retry_count=retry_count+1,progress=0,steps_json='[]',provider_name=NULL,
      provider_task_id=NULL,provider_result_json=NULL,tts_attempt_json=NULL,
      usage_json=NULL,cost_json=NULL,output_file_id=NULL,
      result_url=NULL,result_sha256=NULL,result_bytes=NULL,error_code=NULL,
      error_message=NULL,timeout_at=NULL,started_at=NULL,completed_at=NULL,
      cancelled_at=NULL,updated_at=?
      WHERE tenant_id=? AND id=? AND status='failed'
        AND billing_status IN ('released','included') AND retry_count<?`,
      timestamp(now),
      row.tenant_id,
      row.id,
      AVATAR_MAX_FREE_RETRIES,
    );
    if (changed.changes !== 1) {
      throw failure("任务状态刚刚发生变化，请刷新", 409, "AVATAR_JOB_STATE_CONFLICT");
    }
    appendStep(row.id, {
      phase: "queued",
      message: "免费重试已排队，本次不重复扣费",
    }, now);
    return publicJob(
      q.get("SELECT * FROM avatar_jobs WHERE tenant_id=? AND id=?", row.tenant_id, row.id),
    );
  }

  function recoverTenant(tenantId) {
    const tid = idOf(tenantId, "租户编号");
    const report = [];
    return runWithTenant(tid, () => {
      const rows = q.all(
        `SELECT * FROM avatar_jobs WHERE tenant_id=?
        AND (status IN ('queued','running') OR billing_status IN ('pending','held'))
        ORDER BY id`,
        tid,
      );
      for (const original of rows) {
        let row = original;
        try {
          if (row.billing_status === "pending") {
            const hold = findHoldByRef(BILLING_REF, row.id, tid);
            if (hold) {
              q.run(
                "UPDATE avatar_jobs SET billing_status='held',held_credits=?,updated_at=? WHERE tenant_id=? AND id=? AND billing_status='pending'",
                hold.credits,
                timestamp(now),
                tid,
                row.id,
              );
              row = q.get("SELECT * FROM avatar_jobs WHERE tenant_id=? AND id=?", tid, row.id);
            } else {
              q.run(
                `UPDATE avatar_jobs SET status='failed',billing_status='released',
                error_code='AVATAR_RECOVERY_NO_HOLD',
                error_message='服务重启前未完成预授权，未调用供应商',completed_at=?,updated_at=?
                WHERE tenant_id=? AND id=?`,
                timestamp(now),
                timestamp(now),
                tid,
                row.id,
              );
              report.push({ id: row.id, action: "failed_without_hold" });
              continue;
            }
          }
          if (row.status === "queued") {
            schedule(row.id, tid);
            report.push({ id: row.id, action: "rescheduled" });
            continue;
          }
          if (row.status === "running" && outputArtifact(row)) {
            const evidence = providerEvidence({
              usage: parseJson(row.usage_json),
              costEvidence: parseJson(row.cost_json),
            });
            if (row.billing_status === "held") {
              const hold = findHoldByRef(BILLING_REF, row.id, tid);
              const settlement = hold
                ? settleHold(hold, {
                    usage: evidence.usage,
                    model: row.billing_model,
                    aiMode: "api",
                    credits: evidence.actualCredits,
                    note: "服务启动时按已持久化真实成片恢复结算",
                  })
                : null;
              if (!settlement) {
                throw failure(
                  "恢复结算缺少预授权",
                  409,
                  "AVATAR_BILLING_HOLD_MISSING",
                );
              }
              q.run(
                `UPDATE avatar_jobs SET status='done',billing_status='settled',
                settled_credits=?,progress=100,completed_at=COALESCE(completed_at,?),updated_at=?
                WHERE tenant_id=? AND id=? AND status='running'`,
                settlement.credits,
                timestamp(now),
                timestamp(now),
                tid,
                row.id,
              );
            } else if (["settled", "included"].includes(row.billing_status)) {
              q.run(
                `UPDATE avatar_jobs SET status='done',progress=100,
                completed_at=COALESCE(completed_at,?),updated_at=?
                WHERE tenant_id=? AND id=? AND status='running'`,
                timestamp(now),
                timestamp(now),
                tid,
                row.id,
              );
            } else {
              throw failure(
                "已落库成片的账务状态无法自动恢复",
                409,
                "AVATAR_BILLING_RECOVERY_FAILED",
              );
            }
            report.push({ id: row.id, action: "finalized_persisted_output" });
            continue;
          }
          if (row.status === "running") {
            settleFailure(
              row.id,
              failure(
                "服务重启中断外部渲染，预授权已退回，请免费重试",
                503,
                "AVATAR_RESTART_INTERRUPTED",
              ),
            );
            report.push({ id: row.id, action: "released_interrupted" });
            continue;
          }
          if (["failed", "cancelled"].includes(row.status) && row.billing_status === "held") {
            const hold = findHoldByRef(BILLING_REF, row.id, tid);
            const released = hold
              ? releaseHold(hold, "启动恢复终态数字人工单，预授权全额退回")
              : null;
            if (!released && !ledgerWasReleased(BILLING_REF, row.id, tid)) {
              throw failure(
                "启动恢复未能退回数字人预授权",
                409,
                "AVATAR_BILLING_RELEASE_CONFLICT",
              );
            }
            q.run(
              "UPDATE avatar_jobs SET billing_status='released',updated_at=? WHERE tenant_id=? AND id=?",
              timestamp(now),
              tid,
              row.id,
            );
            report.push({ id: row.id, action: "released_terminal" });
          }
        } catch (error) {
          const safe = safeError(error);
          q.run(
            `UPDATE avatar_jobs SET billing_status='pending_reconciliation',
            error_code=?,error_message=?,updated_at=?
            WHERE tenant_id=? AND id=? AND status<>'done'`,
            safe.code,
            `${safe.message}；启动恢复未能完成账务收口`,
            timestamp(now),
            tid,
            row.id,
          );
          report.push({
            id: row.id,
            action: "pending_reconciliation",
            code: safeError(error).code,
          });
        }
      }
      return report;
    });
  }

  function recoverAndSchedule({ tenantId = null } = {}) {
    if (!tableExists("avatar_jobs")) return [];
    const tenants = tenantId
      ? [idOf(tenantId, "租户编号")]
      : q
          .all("SELECT DISTINCT tenant_id FROM avatar_jobs ORDER BY tenant_id")
          .map((row) => Number(row.tenant_id));
    return tenants.flatMap((tid) => recoverTenant(tid));
  }

  function listVoices(user) {
    const tenantId = idOf(user?.tenant_id || curTenant(), "租户编号");
    const scope = userScopeClause(user, "created_by");
    return q
      .all(
        `SELECT * FROM avatar_voices WHERE tenant_id=?${scope.sql}
        ORDER BY id DESC LIMIT 100`,
        tenantId,
        ...scope.params,
      )
      .map(publicVoice);
  }

  async function cloneVoice({ user, audioFileId, label }) {
    const tenantId = idOf(user?.tenant_id || curTenant(), "租户编号");
    const userId = idOf(user?.id, "用户编号");
    const audio = resolveAvatarAsset({
      tenantId,
      fileId: audioFileId,
      kind: "audio",
      user,
    });
    if (!["mp3", "wav"].includes(audio.ext)) {
      throw failure(
        "声音克隆样本仅支持 MP3 或 WAV",
        400,
        "MINIMAX_AUDIO_INPUT_INVALID",
      );
    }
    const client = await voiceClientFor({ tenantId }, "cloneVoice");
    const billingModel = "minimax-voice-clone";
    const heldCredits = estimateMaxCredits("video", billingModel);
    const inserted = q.run(
      `INSERT INTO avatar_voices(
        created_by,source_file_id,label,status,billing_status,billing_model,updated_at
      ) VALUES(?,?,?,'pending','pending',?,?)`,
      userId,
      audio.row.id,
      safeVoiceLabel(label),
      billingModel,
      timestamp(now),
    );
    const voiceRowId = Number(inserted.lastInsertRowid);
    let hold;
    try {
      hold = holdCredits({
        userId,
        tenantId,
        feature: "数字人·声音克隆",
        kind: "video",
        model: billingModel,
        credits: heldCredits,
        refType: VOICE_BILLING_REF,
        refId: voiceRowId,
        note: `声音克隆 #${voiceRowId} 在上传供应商前预授权`,
      });
      q.run(
        "UPDATE avatar_voices SET billing_status='held',updated_at=? WHERE tenant_id=? AND id=?",
        timestamp(now),
        tenantId,
        voiceRowId,
      );
      const result = await client.cloneVoice({
        audio: audio.bytes,
        fileName: audio.fileName,
        mimeType: audio.mimeType,
        label: safeVoiceLabel(label),
      });
      const voiceId = String(result?.voice?.id || "").trim();
      const requests = Number(result?.providerAttempt?.usage?.networkRequests || 0);
      if (!/^[a-z0-9_-]{3,64}$/iu.test(voiceId) || requests < 2) {
        throw failure(
          "声音克隆未返回可核验的供应商结果",
          502,
          "MINIMAX_VOICE_CLONE_INVALID",
        );
      }
      const markedReady = q.run(
        `UPDATE avatar_voices SET provider_voice_id=?,label=?,status='ready',
        provider_attempt_json=?,updated_at=?
        WHERE tenant_id=? AND id=? AND status='pending' AND billing_status='held'`,
        voiceId,
        String(result.voice.label || `🧬 ${safeVoiceLabel(label)}`).slice(0, 24),
        jsonForStorage(result.providerAttempt),
        timestamp(now),
        tenantId,
        voiceRowId,
      );
      if (markedReady.changes !== 1) {
        throw failure(
          "声音克隆交付状态发生变化",
          409,
          "AVATAR_VOICE_FINALIZATION_CONFLICT",
        );
      }
      const settlement = settleHold(hold, {
        credits: heldCredits,
        usage: { inputTokens: 0, outputTokens: 0 },
        model: billingModel,
        aiMode: "api",
        note: `声音克隆完成，已核验 ${requests} 次供应商请求`,
      });
      if (!settlement) {
        throw failure(
          "声音克隆结算状态冲突",
          409,
          "AVATAR_BILLING_SETTLEMENT_CONFLICT",
        );
      }
      const finalized = q.run(
        "UPDATE avatar_voices SET billing_status='settled',updated_at=? WHERE tenant_id=? AND id=? AND status='ready'",
        timestamp(now),
        tenantId,
        voiceRowId,
      );
      if (finalized.changes !== 1) {
        throw failure(
          "声音克隆结算已完成但交付状态冲突",
          409,
          "AVATAR_BILLING_FINALIZATION_CONFLICT",
        );
      }
      return publicVoice(
        q.get("SELECT * FROM avatar_voices WHERE tenant_id=? AND id=?", tenantId, voiceRowId),
      );
    } catch (error) {
      const safe = safeError(error);
      let billingStatus = "released";
      try {
        const released = hold
          ? releaseHold(hold, `声音克隆未交付：${safe.message}`)
          : null;
        if (
          hold &&
          !released &&
          !ledgerWasReleased(VOICE_BILLING_REF, voiceRowId, tenantId)
        ) {
          billingStatus = "pending_reconciliation";
        }
      } catch {
        billingStatus = "pending_reconciliation";
      }
      q.run(
        `UPDATE avatar_voices SET status='failed',billing_status=?,error_code=?,
        error_message=?,updated_at=? WHERE tenant_id=? AND id=?`,
        billingStatus,
        safe.code,
        billingStatus === "released"
          ? safe.message
          : `${safe.message}；退款或结算待账务对账`,
        timestamp(now),
        tenantId,
        voiceRowId,
      );
      const wrapped = failure(
        billingStatus === "released"
          ? `${safe.message}；预授权已全额退回`
          : `${safe.message}；账务状态待对账`,
        Number(error?.status) || 502,
        safe.code,
      );
      wrapped.voice = publicVoice(
        q.get("SELECT * FROM avatar_voices WHERE tenant_id=? AND id=?", tenantId, voiceRowId),
      );
      throw wrapped;
    }
  }

  return Object.freeze({
    getMeta,
    createJob,
    listJobs,
    getJob,
    runJob,
    schedule,
    cancelJob,
    retryJob,
    recoverAndSchedule,
    recoverTenant,
    listVoices,
    cloneVoice,
    activeCount: () => active.size,
  });
}

export const avatarJobService = createAvatarJobService();

export default createAvatarJobService;
