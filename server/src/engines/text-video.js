import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import * as fontkit from "fontkit";

import { curTenant, getTenantConfig, q, runWithTenant } from "../db.js";
import { canAccessOwner, userScopeClause } from "./access.js";
import { aiAvailable, generate as generateText } from "./ai.js";
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
import {
  missingMediaBinaryMessage,
  resolveFfmpeg,
  resolveFfprobe,
} from "./media-binaries.js";
import createMiniMaxVoiceClient, {
  MINIMAX_TTS_MODEL,
  parseMiniMaxAudioUrl,
} from "./minimax-voice.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localRequire = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const UPLOAD_ROOT = path.resolve(
  __dirname,
  "..",
  "..",
  "data",
  "uploads",
  "files",
);

export const TEXT_VIDEO_MAX_FREE_RETRIES = 3;
export const TEXT_VIDEO_HARD_TIMEOUT_MS = 30 * 60 * 1000;
export const TEXT_VIDEO_CONCURRENCY = 2;
export const TEXT_VIDEO_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// Keep the binary ceiling compatible with Express' 32MB JSON limit after
// base64 expansion (20MB -> about 26.7MB plus metadata).
export const TEXT_VIDEO_MAX_CLIP_BYTES = 20 * 1024 * 1024;
export const TEXT_VIDEO_MAX_AUDIO_BYTES = 32 * 1024 * 1024;
export const TEXT_VIDEO_MAX_OUTPUT_BYTES = 768 * 1024 * 1024;
export const TEXT_VIDEO_BILLING_MODEL = "text-video-composer";
export const TEXT_VIDEO_DEFAULT_VOICE = "presenter_female";

const BILLING_REF = "text_video_job";
const TERMINAL = new Set(["done", "failed", "cancelled"]);
const MODES = new Set(["images", "clips"]);
const BGM = new Set(["warm", "up", "calm", "none"]);
const BGM_MOODS = Object.freeze({
  warm: {
    barSeconds: 4,
    chords: [
      [261.63, 329.63, 392],
      [196, 246.94, 392],
      [220, 261.63, 329.63],
      [174.61, 220, 349.23],
    ],
  },
  up: {
    barSeconds: 2.6,
    chords: [
      [261.63, 329.63, 392],
      [174.61, 220, 349.23],
      [196, 246.94, 392],
      [261.63, 329.63, 392],
    ],
  },
  calm: {
    barSeconds: 5,
    chords: [
      [220, 261.63, 329.63],
      [174.61, 220, 349.23],
      [261.63, 329.63, 392],
      [196, 246.94, 392],
    ],
  },
});
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
const CLIP_EXTENSIONS = new Set(["mp4", "mov", "webm"]);
const SAFE_ERROR_CODE = /^[A-Z0-9_:-]{1,80}$/u;
const SEGMENT_MIN = 6;
const SEGMENT_MAX = 26;
const MAX_SENTENCES = 40;
const LONG_BODY_THRESHOLD = 320;
const TEXT_OVERLAY_WIDTH = 1080;
const TEXT_OVERLAY_HEIGHT = 1920;
const TEXT_OVERLAY_MAX_PNG_BYTES = 32 * 1024 * 1024;
const TEXT_OVERLAY_MAX_SVG_BYTES = 4 * 1024 * 1024;
const TEXT_OVERLAY_FONT_WEIGHT = 700;
const TEXT_OVERLAY_FONT_CSS = localRequire.resolve(
  `@fontsource/noto-sans-sc/${TEXT_OVERLAY_FONT_WEIGHT}.css`,
);
const TEXT_OVERLAY_FONT_PRIMARY = localRequire.resolve(
  `@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-${TEXT_OVERLAY_FONT_WEIGHT}-normal.woff2`,
);
const TEXT_OVERLAY_FONT_DIR = path.dirname(TEXT_OVERLAY_FONT_PRIMARY);
const TEXT_OVERLAY_FONT_DIR_REAL = fs.realpathSync(TEXT_OVERLAY_FONT_DIR);
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const FONT_FILE_NAME = /^noto-sans-sc-[a-z0-9-]+-700-normal\.woff2$/u;
const SVG_PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]*$/u;
const fontFileCache = new Map();
let fontRangeIndex = null;
let resvgModulePromise = null;

export class TextVideoError extends Error {
  constructor(message, { status = 400, code = "TEXT_VIDEO_INVALID" } = {}) {
    super(message);
    this.name = "TextVideoError";
    this.status = status;
    this.code = code;
  }
}

function failure(message, status = 400, code = "TEXT_VIDEO_INVALID") {
  return new TextVideoError(message, { status, code });
}

function positiveId(value, label = "编号") {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw failure(`${label}不正确`, 400, "TEXT_VIDEO_ID_INVALID");
  }
  return number;
}

function nowIso(now = Date.now) {
  const value = Number(now());
  return new Date(Number.isFinite(value) ? value : Date.now()).toISOString();
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function jsonForStorage(value, maxLength = 80_000) {
  const encoded = JSON.stringify(value ?? {});
  if (encoded.length <= maxLength) return encoded;
  return JSON.stringify({
    truncated: true,
    sha256: crypto.createHash("sha256").update(encoded).digest("hex"),
    byteLength: Buffer.byteLength(encoded),
  });
}

function cleanLine(value, maximum = 240) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function safeTitle(value) {
  return cleanLine(value || "图文成片", 120) || "图文成片";
}

function modeOf(value) {
  const mode = String(value || "images").trim();
  if (!MODES.has(mode)) {
    throw failure(
      "成片模式只能是图文成片或租户片段混剪",
      400,
      "TEXT_VIDEO_MODE_INVALID",
    );
  }
  return mode;
}

function bgmOf(value) {
  const bgm = value == null || value === "" ? "warm" : String(value);
  if (!BGM.has(bgm)) {
    throw failure("配乐风格无效", 400, "TEXT_VIDEO_BGM_INVALID");
  }
  return bgm;
}

function voiceIdOf(value) {
  const voiceId = String(value || TEXT_VIDEO_DEFAULT_VOICE).trim();
  if (!/^[a-z0-9_-]{3,64}$/iu.test(voiceId)) {
    throw failure("配音声音ID格式无效", 400, "TEXT_VIDEO_VOICE_INVALID");
  }
  return voiceId;
}

function idsOf(value, label, maximum = 40) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw failure(
      `${label}必须是编号数组`,
      400,
      "TEXT_VIDEO_ASSET_IDS_INVALID",
    );
  }
  const ids = [...new Set(value.map(Number))];
  if (
    ids.length > maximum ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw failure(
      `${label}包含无效编号或超过${maximum}项`,
      400,
      "TEXT_VIDEO_ASSET_IDS_INVALID",
    );
  }
  return ids;
}

function codepoints(value) {
  return Array.from(String(value || ""));
}

function codepointLength(value) {
  return codepoints(value).length;
}

export function plainTextVideoBody(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/https?:\/\/\S+/giu, "")
    .replace(/[#>*`|_~-]+/gu, " ")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function preferredCut(chars, start, maximum) {
  const end = Math.min(chars.length, start + maximum);
  for (let index = end - 1; index >= start + SEGMENT_MIN; index -= 1) {
    if (/[，,、：:；;。！？!?]/u.test(chars[index])) return index + 1;
  }
  return end;
}

function chunkSentence(value) {
  const chars = codepoints(value.trim());
  const parts = [];
  let cursor = 0;
  while (chars.length - cursor > SEGMENT_MAX) {
    const cut = preferredCut(chars, cursor, SEGMENT_MAX);
    parts.push(chars.slice(cursor, cut).join("").trim());
    cursor = cut;
  }
  const tail = chars.slice(cursor).join("").trim();
  if (tail) parts.push(tail);
  return parts;
}

function repairShortSegments(input) {
  const rows = [...input].filter(Boolean);
  for (let index = 0; index < rows.length; index += 1) {
    if (codepointLength(rows[index]) >= SEGMENT_MIN) continue;
    const previous = rows[index - 1];
    const next = rows[index + 1];
    if (
      previous &&
      codepointLength(previous) + codepointLength(rows[index]) <= SEGMENT_MAX
    ) {
      rows[index - 1] = `${previous}${rows[index]}`;
      rows.splice(index, 1);
      index -= 1;
      continue;
    }
    if (
      next &&
      codepointLength(next) + codepointLength(rows[index]) <= SEGMENT_MAX
    ) {
      rows[index] = `${rows[index]}${next}`;
      rows.splice(index + 1, 1);
      continue;
    }
    if (previous && codepointLength(previous) > SEGMENT_MIN) {
      const needed = SEGMENT_MIN - codepointLength(rows[index]);
      const priorChars = codepoints(previous);
      const transferable = Math.min(needed, priorChars.length - SEGMENT_MIN);
      rows[index - 1] = priorChars.slice(0, -transferable).join("");
      rows[index] = `${priorChars.slice(-transferable).join("")}${rows[index]}`;
    } else if (next && codepointLength(next) > SEGMENT_MIN) {
      const needed = SEGMENT_MIN - codepointLength(rows[index]);
      const nextChars = codepoints(next);
      const transferable = Math.min(needed, nextChars.length - SEGMENT_MIN);
      rows[index] =
        `${rows[index]}${nextChars.slice(0, transferable).join("")}`;
      rows[index + 1] = nextChars.slice(transferable).join("");
    }
  }
  return rows;
}

/** Split a spoken script into screens whose visible text is always 6–26 chars. */
export function splitTextVideoSentences(script) {
  const plain = plainTextVideoBody(script);
  if (codepointLength(plain) < 20) {
    throw failure(
      "口播正文太短，至少需要20字",
      400,
      "TEXT_VIDEO_SCRIPT_TOO_SHORT",
    );
  }
  const coarse = plain
    .split(/(?<=[。！？!?；;])\s*|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap(chunkSentence);
  const repaired = repairShortSegments(coarse);
  if (
    repaired.length < 1 ||
    repaired.length > MAX_SENTENCES ||
    repaired.some((part) => {
      const length = codepointLength(part);
      return length < SEGMENT_MIN || length > SEGMENT_MAX;
    })
  ) {
    throw failure(
      `口播稿无法安全整理为${SEGMENT_MIN}至${SEGMENT_MAX}字分句，请调整正文长度或断句`,
      400,
      "TEXT_VIDEO_SENTENCE_CONTRACT_FAILED",
    );
  }
  return repaired;
}

function normalizeProviderUsage(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    networkRequests: Number(source.networkRequests || 0),
    inputCharacters: Number(source.inputCharacters || 0),
    inputTokens: Number(source.inputTokens || 0),
    outputTokens: Number(source.outputTokens || 0),
  };
}

export async function prepareTextVideoScript({
  title,
  body,
  compressFn,
  signal,
} = {}) {
  const plain = plainTextVideoBody(body);
  if (codepointLength(plain) < 20) {
    throw failure("正文太短，至少需要20字", 400, "TEXT_VIDEO_SCRIPT_TOO_SHORT");
  }
  if (codepointLength(plain) <= LONG_BODY_THRESHOLD) {
    return {
      script: plain,
      compression: {
        required: false,
        mode: "not_required",
        usage: { inputTokens: 0, outputTokens: 0, networkRequests: 0 },
      },
    };
  }
  if (typeof compressFn !== "function") {
    throw failure(
      "正文超过320字，需要真实模型压缩后才能成片",
      503,
      "TEXT_VIDEO_COMPRESSION_UNAVAILABLE",
    );
  }
  const output = await compressFn({
    title: safeTitle(title),
    body: plain.slice(0, 12_000),
    signal,
  });
  const usage = normalizeProviderUsage(output?.usage);
  const script = plainTextVideoBody(output?.text);
  if (
    output?.mode !== "api" ||
    usage.inputTokens + usage.outputTokens <= 0 ||
    codepointLength(script) < 60 ||
    codepointLength(script) > 600
  ) {
    throw failure(
      "真实模型没有返回可核验的60至600字口播稿，任务已停止且不会使用本地草稿",
      502,
      "TEXT_VIDEO_COMPRESSION_INVALID",
    );
  }
  return {
    script,
    compression: {
      required: true,
      mode: "api",
      model: cleanLine(output.model, 100),
      usage,
    },
  };
}

function startsWith(buffer, signature, offset = 0) {
  return (
    buffer.length >= offset + signature.length &&
    buffer.subarray(offset, offset + signature.length).equals(signature)
  );
}

function detectImage(buffer) {
  if (startsWith(buffer, Buffer.from([0xff, 0xd8, 0xff]))) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  if (
    startsWith(
      buffer,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return { ext: "png", mime: "image/png" };
  }
  if (
    startsWith(buffer, Buffer.from("RIFF")) &&
    startsWith(buffer, Buffer.from("WEBP"), 8)
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  throw failure(
    "图片内容必须是JPEG、PNG或WebP",
    400,
    "TEXT_VIDEO_IMAGE_INVALID",
  );
}

function detectClip(buffer) {
  if (buffer.length >= 16 && startsWith(buffer, Buffer.from("ftyp"), 4)) {
    return buffer.subarray(8, 12).toString("ascii") === "qt  "
      ? { ext: "mov", mime: "video/quicktime" }
      : { ext: "mp4", mime: "video/mp4" };
  }
  if (startsWith(buffer, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return { ext: "webm", mime: "video/webm" };
  }
  throw failure("片段内容必须是MP4、MOV或WebM", 400, "TEXT_VIDEO_CLIP_INVALID");
}

function detectAudio(buffer) {
  if (
    startsWith(buffer, Buffer.from("RIFF")) &&
    startsWith(buffer, Buffer.from("WAVE"), 8)
  ) {
    return { ext: "wav", mime: "audio/wav" };
  }
  if (
    startsWith(buffer, Buffer.from("ID3")) ||
    (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
  ) {
    return { ext: "mp3", mime: "audio/mpeg" };
  }
  if (buffer.length >= 12 && startsWith(buffer, Buffer.from("ftyp"), 4)) {
    return { ext: "m4a", mime: "audio/mp4" };
  }
  throw failure(
    "配音服务返回的内容不是真实MP3、WAV或M4A音频",
    502,
    "TEXT_VIDEO_TTS_AUDIO_INVALID",
  );
}

function detectOutputVideo(buffer) {
  if (buffer.length >= 16 && startsWith(buffer, Buffer.from("ftyp"), 4)) {
    return { ext: "mp4", mime: "video/mp4" };
  }
  throw failure(
    "FFmpeg未形成可验证的MP4成片",
    502,
    "TEXT_VIDEO_OUTPUT_INVALID",
  );
}

function assertDeclaredExtension(name, detected, kind) {
  const extension = path
    .extname(String(name || ""))
    .slice(1)
    .toLowerCase();
  if (!extension) return;
  const allowed =
    kind === "image"
      ? detected.ext === "jpg"
        ? new Set(["jpg", "jpeg"])
        : new Set([detected.ext])
      : new Set([detected.ext]);
  if (!allowed.has(extension)) {
    throw failure(
      `${kind === "image" ? "图片" : "片段"}扩展名与真实内容不一致`,
      400,
      "TEXT_VIDEO_ASSET_EXTENSION_MISMATCH",
    );
  }
}

function safeOriginalName(value, fallback) {
  return (
    path
      .basename(String(value || fallback))
      .replace(/[\u0000-\u001f\u007f]/gu, "_")
      .slice(0, 180) || fallback
  );
}

async function persistAssetBytes({
  tenantId,
  userId,
  purpose,
  name,
  bytes,
  format,
  extractMode,
}) {
  if (Number(curTenant()) !== Number(tenantId)) {
    throw failure(
      "租户文件上下文不一致",
      500,
      "TEXT_VIDEO_TENANT_CONTEXT_INVALID",
    );
  }
  const directory = path.join(UPLOAD_ROOT, String(tenantId), purpose);
  await fsp.mkdir(directory, { recursive: true, mode: 0o750 });
  const storedName = `${Date.now()}-${crypto.randomBytes(10).toString("hex")}.${format.ext}`;
  const absolutePath = path.join(directory, storedName);
  const fileUrl = `/uploads/files/${tenantId}/${purpose}/${encodeURIComponent(storedName)}`;
  try {
    await fsp.writeFile(absolutePath, bytes, { flag: "wx", mode: 0o600 });
    const inserted = q.run(
      `INSERT INTO uploaded_files(
        user_id,name,stored_name,ext,mime,size,purpose,file_path,file_url,
        extracted_text,extract_mode
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      userId,
      safeOriginalName(name, storedName),
      storedName,
      format.ext,
      format.mime,
      bytes.length,
      purpose,
      absolutePath,
      fileUrl,
      "",
      extractMode,
    );
    return q.get(
      "SELECT * FROM uploaded_files WHERE tenant_id=? AND id=?",
      tenantId,
      inserted.lastInsertRowid,
    );
  } catch (error) {
    await fsp.rm(absolutePath, { force: true }).catch(() => {});
    throw error;
  }
}

function publicAsset(row) {
  return {
    id: Number(row.id),
    name: row.name,
    kind: row.purpose === "text-video-clip" ? "clip" : "image",
    ext: row.ext,
    mime: row.mime,
    size: Number(row.size || 0),
    url: row.file_url,
    createdAt: row.created_at,
  };
}

export async function saveTextVideoAsset({ user, name, mime = "", b64, kind }) {
  const tenantId = positiveId(user?.tenant_id || curTenant(), "租户编号");
  const userId = positiveId(user?.id, "用户编号");
  if (
    !q.get("SELECT id FROM users WHERE tenant_id=? AND id=?", tenantId, userId)
  ) {
    throw failure("上传账号不存在", 404, "TEXT_VIDEO_USER_NOT_FOUND");
  }
  if (!new Set(["image", "clip"]).has(kind)) {
    throw failure(
      "素材类型只能是图片或视频片段",
      400,
      "TEXT_VIDEO_ASSET_KIND_INVALID",
    );
  }
  const maximum =
    kind === "image" ? TEXT_VIDEO_MAX_IMAGE_BYTES : TEXT_VIDEO_MAX_CLIP_BYTES;
  const bytes = decodeBase64File(b64, maximum);
  const format = kind === "image" ? detectImage(bytes) : detectClip(bytes);
  assertDeclaredExtension(name, format, kind);
  const suppliedMime = String(mime || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (suppliedMime && suppliedMime !== format.mime) {
    throw failure(
      "素材声明类型与真实文件内容不一致",
      400,
      "TEXT_VIDEO_ASSET_MIME_MISMATCH",
    );
  }
  const row = await persistAssetBytes({
    tenantId,
    userId,
    purpose: kind === "image" ? "text-video-image" : "text-video-clip",
    name,
    bytes,
    format,
    extractMode: "图文成片安全素材",
  });
  return publicAsset(row);
}

export function listTextVideoAssets(user, kind = "") {
  const tenantId = positiveId(user?.tenant_id || curTenant(), "租户编号");
  const requested = String(kind || "").trim();
  if (requested && !new Set(["image", "clip"]).has(requested)) {
    throw failure("素材筛选类型无效", 400, "TEXT_VIDEO_ASSET_KIND_INVALID");
  }
  const purposes = requested
    ? [requested === "image" ? "text-video-image" : "text-video-clip"]
    : ["text-video-image", "text-video-clip"];
  const placeholders = purposes.map(() => "?").join(",");
  const scope = userScopeClause(user, "user_id");
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

function safeMaterialRights(row, tenantId) {
  if (
    !row ||
    Number(row.tenant_id) !== tenantId ||
    row.source_type !== "imagehunt"
  ) {
    return null;
  }
  const artifact = parseJson(row.artifact_snapshot_json, null);
  const rights = artifact?.rights;
  const prefix = `/uploads/files/${tenantId}/`;
  if (
    rights?.confirmed !== true ||
    rights?.commercialUse !== true ||
    !cleanLine(rights?.license, 200) ||
    !new Set(["image/jpeg", "image/png", "image/webp"]).has(
      String(artifact?.mimeType || "").toLowerCase(),
    ) ||
    typeof artifact?.fileUrl !== "string" ||
    !artifact.fileUrl.startsWith(prefix) ||
    artifact.fileUrl !== row.url
  ) {
    return null;
  }
  return {
    artifact,
    rights: {
      confirmed: true,
      commercialUse: true,
      license: cleanLine(rights.license, 200),
      attribution: cleanLine(rights.attribution, 300) || null,
    },
  };
}

export function listTextVideoLicensedMaterials(user, limit = 100) {
  const tenantId = positiveId(user?.tenant_id || curTenant(), "租户编号");
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
  return q
    .all(
      `SELECT id,tenant_id,name,url,source_type,artifact_snapshot_json,created_at
      FROM materials WHERE tenant_id=? AND source_type='imagehunt'
      ORDER BY id DESC LIMIT ?`,
      tenantId,
      safeLimit,
    )
    .map((row) => {
      const licensed = safeMaterialRights(row, tenantId);
      return licensed
        ? {
            id: Number(row.id),
            name: row.name || `已授权素材 #${row.id}`,
            url: row.url,
            rights: licensed.rights,
            createdAt: row.created_at,
          }
        : null;
    })
    .filter(Boolean);
}

function resolveTenantFile({ tenantId, fileId, purpose, user = null }) {
  const row = q.get(
    "SELECT * FROM uploaded_files WHERE tenant_id=? AND id=? AND purpose=?",
    tenantId,
    positiveId(fileId, "素材编号"),
    purpose,
  );
  if (!row || (user && !canAccessOwner(user, row.user_id))) {
    throw failure(
      "租户素材不存在或无权引用",
      404,
      "TEXT_VIDEO_ASSET_NOT_FOUND",
    );
  }
  const tenantRoot = path.resolve(UPLOAD_ROOT, String(tenantId));
  let resolvedRoot;
  let resolvedFile;
  try {
    resolvedRoot = fs.realpathSync(tenantRoot);
    resolvedFile = fs.realpathSync(path.resolve(String(row.file_path || "")));
  } catch {
    throw failure("租户素材文件已丢失", 409, "TEXT_VIDEO_ASSET_MISSING");
  }
  const stat = fs.lstatSync(resolvedFile);
  if (
    !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`) ||
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    Number(row.size || 0) !== stat.size
  ) {
    throw failure(
      "租户素材完整性校验失败",
      409,
      "TEXT_VIDEO_ASSET_INTEGRITY_INVALID",
    );
  }
  const maximum =
    purpose === "text-video-clip"
      ? TEXT_VIDEO_MAX_CLIP_BYTES
      : TEXT_VIDEO_MAX_IMAGE_BYTES;
  if (stat.size <= 0 || stat.size > maximum) {
    throw failure(
      "租户素材大小不符合要求",
      409,
      "TEXT_VIDEO_ASSET_INTEGRITY_INVALID",
    );
  }
  const bytes = fs.readFileSync(resolvedFile);
  const detected =
    purpose === "text-video-clip" ? detectClip(bytes) : detectImage(bytes);
  const storedExt = String(row.ext || "").toLowerCase();
  if (
    detected.ext !== storedExt &&
    !(detected.ext === "jpg" && storedExt === "jpeg")
  ) {
    throw failure(
      "租户素材内容已发生变化",
      409,
      "TEXT_VIDEO_ASSET_INTEGRITY_INVALID",
    );
  }
  return { row, path: resolvedFile, format: detected };
}

function resolveMaterialFile({ tenantId, materialId, user = null }) {
  const row = q.get(
    `SELECT id,tenant_id,name,url,source_type,artifact_snapshot_json
    FROM materials WHERE tenant_id=? AND id=?`,
    tenantId,
    positiveId(materialId, "授权素材编号"),
  );
  const licensed = safeMaterialRights(row, tenantId);
  if (!licensed) {
    throw failure(
      "素材没有可核验的商业使用授权，不能用于成片",
      409,
      "TEXT_VIDEO_MATERIAL_RIGHTS_INVALID",
    );
  }
  const file = q.get(
    "SELECT id FROM uploaded_files WHERE tenant_id=? AND file_url=?",
    tenantId,
    row.url,
  );
  if (!file) {
    throw failure(
      "已授权素材的租户文件不存在",
      409,
      "TEXT_VIDEO_MATERIAL_FILE_MISSING",
    );
  }
  const resolved = resolveTenantFile({
    tenantId,
    fileId: file.id,
    purpose: q.get(
      "SELECT purpose FROM uploaded_files WHERE tenant_id=? AND id=?",
      tenantId,
      file.id,
    )?.purpose,
    user: null,
  });
  if (!IMAGE_EXTENSIONS.has(String(resolved.row.ext || "").toLowerCase())) {
    throw failure(
      "已授权素材不是可用图片",
      409,
      "TEXT_VIDEO_MATERIAL_FILE_INVALID",
    );
  }
  return {
    ...resolved,
    materialId: Number(row.id),
    rights: licensed.rights,
  };
}

function absoluteRegularFile(filePath, label) {
  if (
    typeof filePath !== "string" ||
    !path.isAbsolute(filePath) ||
    path.resolve(filePath) !== filePath ||
    filePath.includes("\0")
  ) {
    throw failure(`${label}路径无效`, 500, "TEXT_VIDEO_LOCAL_PATH_INVALID");
  }
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw failure(`${label}不存在`, 409, "TEXT_VIDEO_ASSET_MISSING");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw failure(
      `${label}不是安全的普通文件`,
      409,
      "TEXT_VIDEO_LOCAL_PATH_INVALID",
    );
  }
  return filePath;
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function commandFailure(command, error) {
  const name = path.basename(String(command || "媒体工具"));
  // ENOENT 说明可执行文件本身缺失（常见于 launchd 的最小 PATH），
  // 给出可操作的安装/配置指引，而不是笼统的"执行失败"。
  const missingBinary =
    error?.code === "ENOENT" && /^ff(?:mpeg|probe)/u.test(name)
      ? name.startsWith("ffprobe")
        ? "ffprobe"
        : "ffmpeg"
      : null;
  const wrapped = failure(
    missingBinary
      ? missingMediaBinaryMessage(missingBinary)
      : `${name}执行失败，任务未交付`,
    502,
    "TEXT_VIDEO_MEDIA_COMMAND_FAILED",
  );
  wrapped.command = name;
  wrapped.causeCode = cleanLine(error?.code, 80) || null;
  return wrapped;
}

async function defaultRunner(command, args, options = {}) {
  try {
    const execOptions = {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    };
    if (options.signal) execOptions.signal = options.signal;
    const result = await execFileAsync(command, args, execOptions);
    return { ...result, code: 0 };
  } catch (error) {
    if (options.signal?.aborted || error?.name === "AbortError") {
      throw failure("成片任务已取消或超过硬时限", 499, "TEXT_VIDEO_CANCELLED");
    }
    throw commandFailure(command, error);
  }
}

function parseProbe(result, label, expectedKind) {
  let payload;
  try {
    payload = JSON.parse(String(result?.stdout || ""));
  } catch {
    throw failure(`${label}媒体探测结果无效`, 502, "TEXT_VIDEO_PROBE_INVALID");
  }
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream?.codec_type === "video");
  const audio = streams.find((stream) => stream?.codec_type === "audio");
  const duration = Number(
    payload?.format?.duration || video?.duration || audio?.duration,
  );
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3_600) {
    throw failure(`${label}时长无效`, 502, "TEXT_VIDEO_PROBE_INVALID");
  }
  if (expectedKind === "audio" && !audio) {
    throw failure(`${label}缺少音轨`, 502, "TEXT_VIDEO_PROBE_INVALID");
  }
  if ((expectedKind === "video" || expectedKind === "output") && !video) {
    throw failure(`${label}缺少视频轨`, 502, "TEXT_VIDEO_PROBE_INVALID");
  }
  return {
    duration,
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    videoCodec: String(video?.codec_name || "").toLowerCase(),
    audioCodec: String(audio?.codec_name || "").toLowerCase(),
    hasAudio: Boolean(audio),
  };
}

async function probeFile({
  runner,
  ffprobePath,
  filePath,
  label,
  kind,
  cwd,
  signal,
}) {
  let result;
  try {
    result = await runner(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_name,codec_type,width,height,duration",
        "-of",
        "json",
        filePath,
      ],
      { cwd, timeoutMs: 30_000, signal },
    );
  } catch (error) {
    if (error instanceof TextVideoError) throw error;
    throw commandFailure(ffprobePath, error);
  }
  if (result?.code !== undefined && Number(result.code) !== 0) {
    throw commandFailure(ffprobePath, result);
  }
  return parseProbe(result, label, kind);
}

function escapeDrawtextPath(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'");
}

function wrapSubtitle(value, width = 13, maxLines = 2) {
  const chars = codepoints(value);
  const rows = [];
  for (
    let index = 0;
    index < chars.length && rows.length < maxLines;
    index += width
  ) {
    rows.push(chars.slice(index, index + width).join(""));
  }
  return rows.join("\n");
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw failure("成片任务已取消", 499, "TEXT_VIDEO_CANCELLED");
  }
}

function parseFontRange(token) {
  const value = String(token || "")
    .trim()
    .toLowerCase()
    .replace(/^u\+/u, "");
  if (!/^[0-9a-f?]+(?:-[0-9a-f]+)?$/u.test(value)) return null;
  if (value.includes("?")) {
    return {
      start: Number.parseInt(value.replaceAll("?", "0"), 16),
      end: Number.parseInt(value.replaceAll("?", "f"), 16),
    };
  }
  const [startText, endText = startText] = value.split("-", 2);
  const start = Number.parseInt(startText, 16);
  const end = Number.parseInt(endText, 16);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end)
    ? { start, end }
    : null;
}

function bundledFontRanges() {
  if (fontRangeIndex) return fontRangeIndex;
  let css;
  try {
    css = fs.readFileSync(TEXT_OVERLAY_FONT_CSS, "utf8");
  } catch {
    throw failure(
      "内置中文字幕字体索引不可用",
      503,
      "TEXT_VIDEO_SUBTITLE_FONT_UNAVAILABLE",
    );
  }
  const entries = [];
  for (const match of css.matchAll(/@font-face\s*\{([\s\S]*?)\}/gu)) {
    const block = match[1];
    const fileName = block.match(/url\(\.\/files\/([^)'"\s]+\.woff2)\)/u)?.[1];
    const rangeText = block.match(/unicode-range:\s*([^;]+);/u)?.[1];
    if (!FONT_FILE_NAME.test(String(fileName || "")) || !rangeText) continue;
    const ranges = rangeText.split(",").map(parseFontRange).filter(Boolean);
    if (!ranges.length) continue;
    const candidate = path.resolve(TEXT_OVERLAY_FONT_DIR, fileName);
    let realCandidate;
    try {
      realCandidate = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    if (!realCandidate.startsWith(`${TEXT_OVERLAY_FONT_DIR_REAL}${path.sep}`)) {
      continue;
    }
    entries.push({ filePath: realCandidate, ranges });
  }
  if (!entries.length) {
    throw failure(
      "内置中文字幕字体索引为空",
      503,
      "TEXT_VIDEO_SUBTITLE_FONT_UNAVAILABLE",
    );
  }
  fontRangeIndex = entries;
  return entries;
}

function loadBundledFont(filePath) {
  let realPath;
  try {
    realPath = fs.realpathSync(filePath);
  } catch {
    throw failure(
      "内置中文字幕字体文件不可用",
      503,
      "TEXT_VIDEO_SUBTITLE_FONT_UNAVAILABLE",
    );
  }
  if (!realPath.startsWith(`${TEXT_OVERLAY_FONT_DIR_REAL}${path.sep}`)) {
    throw failure(
      "内置中文字幕字体路径越界",
      500,
      "TEXT_VIDEO_SUBTITLE_FONT_UNAVAILABLE",
    );
  }
  if (fontFileCache.has(realPath)) return fontFileCache.get(realPath);
  let font;
  try {
    font = fontkit.openSync(realPath);
  } catch {
    throw failure(
      "内置中文字幕字体无法解析",
      503,
      "TEXT_VIDEO_SUBTITLE_FONT_UNAVAILABLE",
    );
  }
  if (
    !font ||
    typeof font.glyphForCodePoint !== "function" ||
    typeof font.hasGlyphForCodePoint !== "function" ||
    !Number.isFinite(Number(font.unitsPerEm)) ||
    Number(font.unitsPerEm) <= 0
  ) {
    throw failure(
      "内置中文字幕字体格式无效",
      503,
      "TEXT_VIDEO_SUBTITLE_FONT_UNAVAILABLE",
    );
  }
  fontFileCache.set(realPath, font);
  return font;
}

function bundledFontForCodePoint(codePoint) {
  const primary = loadBundledFont(TEXT_OVERLAY_FONT_PRIMARY);
  if (primary.hasGlyphForCodePoint(codePoint)) return primary;
  for (const entry of bundledFontRanges()) {
    if (
      !entry.ranges.some(
        (range) => codePoint >= range.start && codePoint <= range.end,
      )
    ) {
      continue;
    }
    const font = loadBundledFont(entry.filePath);
    if (font.hasGlyphForCodePoint(codePoint)) return font;
  }
  throw failure(
    "标题或字幕包含内置字体无法绘制的字符，请改用中文、字母、数字或常用标点",
    400,
    "TEXT_VIDEO_SUBTITLE_GLYPH_UNAVAILABLE",
  );
}

function svgNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 1_000_000) {
    throw failure(
      "中文字幕字形坐标无效",
      503,
      "TEXT_VIDEO_SUBTITLE_FONT_UNAVAILABLE",
    );
  }
  return Number(number.toFixed(4));
}

function outlineTextLine({ text, fontSize, baseline, borderWidth, signal }) {
  const groups = [];
  for (const character of codepoints(text)) {
    throwIfAborted(signal);
    const codePoint = character.codePointAt(0);
    const font = bundledFontForCodePoint(codePoint);
    const previous = groups.at(-1);
    if (previous?.font === font) previous.text += character;
    else groups.push({ font, text: character });
  }
  const paths = [];
  let cursor = 0;
  for (const group of groups) {
    const scale = fontSize / Number(group.font.unitsPerEm);
    const run = group.font.layout(group.text);
    if (
      !Array.isArray(run?.glyphs) ||
      !Array.isArray(run?.positions) ||
      run.glyphs.length !== run.positions.length
    ) {
      throw failure(
        "中文字幕字形排版失败",
        503,
        "TEXT_VIDEO_SUBTITLE_FONT_UNAVAILABLE",
      );
    }
    for (let index = 0; index < run.glyphs.length; index += 1) {
      const glyph = run.glyphs[index];
      const position = run.positions[index];
      const d = String(glyph?.path?.toSVG?.() || "");
      if (d && (d.length > 250_000 || !SVG_PATH_DATA.test(d))) {
        throw failure(
          "中文字幕字形轮廓无效",
          503,
          "TEXT_VIDEO_SUBTITLE_FONT_UNAVAILABLE",
        );
      }
      if (d) {
        paths.push({
          d,
          x: cursor + Number(position.xOffset || 0) * scale,
          y: baseline - Number(position.yOffset || 0) * scale,
          scale,
          strokeWidth: borderWidth / scale,
        });
      }
      cursor += Number(position.xAdvance || 0) * scale;
    }
  }
  if (!Number.isFinite(cursor) || cursor <= 0 || cursor > TEXT_OVERLAY_WIDTH) {
    throw failure(
      "标题或字幕排版宽度无效",
      400,
      "TEXT_VIDEO_SUBTITLE_LAYOUT_INVALID",
    );
  }
  const centered = (TEXT_OVERLAY_WIDTH - cursor) / 2;
  return paths
    .map(
      (item) =>
        `<path d="${item.d}" transform="translate(${svgNumber(
          centered + item.x,
        )} ${svgNumber(item.y)}) scale(${svgNumber(item.scale)} ${svgNumber(
          -item.scale,
        )})" fill="#fff" stroke="#000" stroke-opacity="0.9" stroke-width="${svgNumber(
          item.strokeWidth,
        )}" stroke-linejoin="round"/>`,
    )
    .join("");
}

function textOverlaySvg({ title, subtitle, signal }) {
  const titleRows = wrapSubtitle(title, 14, 2).split("\n").filter(Boolean);
  const subtitleRows = wrapSubtitle(subtitle, 13, 2)
    .split("\n")
    .filter(Boolean);
  if (!titleRows.length || !subtitleRows.length) {
    throw failure("标题或字幕为空", 400, "TEXT_VIDEO_SUBTITLE_LAYOUT_INVALID");
  }
  const paths = [];
  for (const [index, row] of titleRows.entries()) {
    paths.push(
      outlineTextLine({
        text: row,
        fontSize: 54,
        baseline: 220 + index * 74,
        borderWidth: 4,
        signal,
      }),
    );
  }
  for (const [index, row] of subtitleRows.entries()) {
    paths.push(
      outlineTextLine({
        text: row,
        fontSize: 62,
        baseline: 1560 + index * 86,
        borderWidth: 5,
        signal,
      }),
    );
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TEXT_OVERLAY_WIDTH}" ` +
    `height="${TEXT_OVERLAY_HEIGHT}" viewBox="0 0 ${TEXT_OVERLAY_WIDTH} ${TEXT_OVERLAY_HEIGHT}">` +
    paths.join("") +
    "</svg>";
  if (Buffer.byteLength(svg) > TEXT_OVERLAY_MAX_SVG_BYTES) {
    throw failure(
      "中文字幕字形数据超过安全上限",
      413,
      "TEXT_VIDEO_SUBTITLE_RASTER_TOO_LARGE",
    );
  }
  return svg;
}

async function loadResvgModule() {
  if (!resvgModulePromise) {
    resvgModulePromise = import("@resvg/resvg-js");
  }
  try {
    const module = await resvgModulePromise;
    if (typeof module?.renderAsync !== "function")
      throw new Error("renderAsync missing");
    return module;
  } catch {
    resvgModulePromise = null;
    throw failure(
      "服务器缺少可用的中文字幕栅格化组件",
      503,
      "TEXT_VIDEO_SUBTITLE_RASTER_UNAVAILABLE",
    );
  }
}

function validateTextOverlayPng(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 24 ||
    bytes.length > TEXT_OVERLAY_MAX_PNG_BYTES ||
    !startsWith(bytes, PNG_SIGNATURE) ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR" ||
    bytes.readUInt32BE(16) !== TEXT_OVERLAY_WIDTH ||
    bytes.readUInt32BE(20) !== TEXT_OVERLAY_HEIGHT
  ) {
    throw failure(
      "中文字幕没有形成可验证的透明PNG图层",
      502,
      "TEXT_VIDEO_SUBTITLE_RASTER_INVALID",
    );
  }
  return bytes;
}

async function renderTextOverlayPng({ title, subtitle, destination, signal }) {
  throwIfAborted(signal);
  const svg = textOverlaySvg({ title, subtitle, signal });
  const resvg = await loadResvgModule();
  let rendered;
  try {
    rendered = await resvg.renderAsync(
      svg,
      {
        fitTo: { mode: "original" },
        shapeRendering: 2,
        textRendering: 2,
        logLevel: "error",
      },
    );
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") {
      throw failure("成片任务已取消", 499, "TEXT_VIDEO_CANCELLED");
    }
    // 某些 resvg 原生构建不接受高级 shape/text 选项，但仍能安全渲染
    // 已经转换为 SVG path 的中文轮廓。降级只去掉选项，不回退到系统字体，
    // 因而不会改变字形/版权边界，也能避免整单因兼容性差异被误判失败。
    try {
      rendered = await resvg.renderAsync(svg, { fitTo: { mode: "original" } });
    } catch (fallbackError) {
      if (signal?.aborted || fallbackError?.name === "AbortError") {
        throw failure("成片任务已取消", 499, "TEXT_VIDEO_CANCELLED");
      }
      throw failure(
        "中文字幕透明图层栅格化失败",
        502,
        "TEXT_VIDEO_SUBTITLE_RASTER_FAILED",
      );
    }
  }
  throwIfAborted(signal);
  const bytes = validateTextOverlayPng(Buffer.from(rendered.asPng()));
  if (destination) {
    if (
      typeof destination !== "string" ||
      !path.isAbsolute(destination) ||
      path.resolve(destination) !== destination
    ) {
      throw failure(
        "中文字幕临时文件路径无效",
        500,
        "TEXT_VIDEO_LOCAL_PATH_INVALID",
      );
    }
    await fsp.writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
  return bytes;
}

function motionFilter(index, frames) {
  const zoomIn = `zoompan=z='1+0.10*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
  const zoomOut = `zoompan=z='1.10-0.10*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
  const panRight = `zoompan=z='1.10':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)'`;
  const panLeft = `zoompan=z='1.10':x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)'`;
  return [zoomIn, panRight, zoomOut, panLeft][index % 4];
}

function textOverlay(titleFile, subtitleFile) {
  const title = escapeDrawtextPath(titleFile);
  const subtitle = escapeDrawtextPath(subtitleFile);
  return (
    `drawtext=font='Noto Sans CJK SC':textfile='${title}':` +
    "fontsize=54:fontcolor=white:borderw=4:bordercolor=black@0.85:" +
    "x=(w-text_w)/2:y=150:line_spacing=16," +
    `drawtext=font='Noto Sans CJK SC':textfile='${subtitle}':` +
    "fontsize=62:fontcolor=white:alpha='if(lt(t,0.35),t/0.35,1)':" +
    "borderw=5:bordercolor=black@0.9:x=(w-text_w)/2:y=h-430:line_spacing=20"
  );
}

function segmentCommand({
  ffmpegPath,
  visual,
  audio,
  duration,
  textOverlayMode,
  titleFile,
  subtitleFile,
  overlayPath,
  output,
  index,
}) {
  const total = duration + 0.3;
  const frames = Math.max(30, Math.ceil(total * 30) + 2);
  let visualArgs;
  let videoFilter;
  if (visual.type === "image") {
    visualArgs = ["-loop", "1", "-framerate", "30", "-i", visual.path];
    videoFilter =
      "scale=1080:1920:force_original_aspect_ratio=increase," +
      `crop=1080:1920,${motionFilter(index, frames)}:d=${frames}:s=1080x1920:fps=30`;
  } else if (visual.type === "clip") {
    visualArgs = ["-stream_loop", "-1", "-i", visual.path];
    videoFilter =
      "scale=1080:1920:force_original_aspect_ratio=increase," +
      "crop=1080:1920,fps=30,setsar=1," +
      `trim=duration=${total.toFixed(3)},setpts=PTS-STARTPTS`;
  } else {
    visualArgs = [
      "-f",
      "lavfi",
      "-i",
      `color=c=${visual.color}:s=1080x1920:r=30:d=${(total + 0.2).toFixed(3)}`,
    ];
    videoFilter = "null";
  }
  const rasterOverlay = textOverlayMode === "raster_png";
  const overlayArgs = rasterOverlay
    ? ["-loop", "1", "-framerate", "30", "-i", overlayPath]
    : [];
  const filter = rasterOverlay
    ? `[0:v]${videoFilter}[base];` +
      "[base][2:v]overlay=0:0:format=auto[v];" +
      "[1:a]aresample=48000,apad=pad_dur=0.3[a]"
    : `[0:v]${videoFilter},${textOverlay(titleFile, subtitleFile)}[v];` +
      "[1:a]aresample=48000,apad=pad_dur=0.3[a]";
  return {
    command: ffmpegPath,
    args: [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...visualArgs,
      "-i",
      audio,
      ...overlayArgs,
      "-filter_complex",
      filter,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-t",
      total.toFixed(3),
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-ac",
      "2",
      output,
    ],
  };
}

function generatedBgmBytes(mood) {
  const spec = BGM_MOODS[mood];
  if (!spec) {
    throw failure("配乐风格不可用", 400, "TEXT_VIDEO_BGM_INVALID");
  }
  const sampleRate = 24_000;
  const sampleCount = Math.ceil(
    sampleRate * spec.barSeconds * spec.chords.length,
  );
  const dataBytes = sampleCount * 2;
  const wav = Buffer.allocUnsafe(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const elapsed = index / sampleRate;
    const chordIndex = Math.min(
      spec.chords.length - 1,
      Math.floor(elapsed / spec.barSeconds),
    );
    const local = elapsed - chordIndex * spec.barSeconds;
    const attack = Math.min(local / (spec.barSeconds * 0.2), 1);
    const release = Math.min(
      (spec.barSeconds - local) / (spec.barSeconds * 0.3),
      1,
    );
    const envelope = Math.max(0, attack * release);
    const frequencies = spec.chords[chordIndex];
    const sample =
      frequencies.reduce(
        (sum, frequency, tone) =>
          sum +
          Math.sin(2 * Math.PI * frequency * local) * [0.3, 0.24, 0.2][tone],
        0,
      ) +
      0.06 * Math.sin(2 * Math.PI * (frequencies[0] / 2) * local);
    const pcm = Math.max(
      -32_767,
      Math.min(32_767, Math.round(sample * envelope * 32_000)),
    );
    wav.writeInt16LE(pcm, 44 + index * 2);
  }
  return wav;
}

async function writeGeneratedBgm(directory, mood) {
  const destination = path.join(directory, `bgm-${mood}.wav`);
  const bytes = generatedBgmBytes(mood);
  await fsp.writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  return destination;
}

function finalCommand({ ffmpegPath, segments, output, bgm, bgmPath = null }) {
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
  for (const segment of segments) args.push("-i", segment);
  const labels = segments
    .map((_, index) => `[${index}:v][${index}:a]`)
    .join("");
  let filter = `${labels}concat=n=${segments.length}:v=1:a=1[vcat][acat]`;
  if (bgm !== "none") {
    if (!bgmPath) {
      throw failure("合成配乐文件未生成", 500, "TEXT_VIDEO_BGM_MISSING");
    }
    args.push("-stream_loop", "-1", "-i", bgmPath);
    filter += `;[${segments.length}:a]volume=0.055[bg];`;
    filter += "[acat][bg]amix=inputs=2:duration=first:normalize=0[aout]";
  } else {
    filter += ";[acat]anull[aout]";
  }
  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[vcat]",
    "-map",
    "[aout]",
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    output,
  );
  return { command: ffmpegPath, args };
}

async function defaultCompression({ title, body, signal }) {
  const output = await generateText({
    kind: "text-video-compress",
    system:
      "你是短视频口播编辑。只做忠实压缩，不添加原文没有的事实、金额、承诺或功效。只输出口播正文。",
    userMsg:
      `把《${title}》压缩成200至280字、60至90秒的中文口播稿：开头有真实钩子，保留核心事实，结尾有自然行动建议。` +
      `不要标题、不要说明。\n\n${body}`,
    fallback: () => "",
    maxTokens: 900,
    timeoutMs: 180_000,
    signal,
    providerPolicy: "fallback_chain",
  });
  return output;
}

async function defaultTts({ tenantId, text, voiceId, signal }) {
  const config =
    getTenantConfig("text_video_minimax_voice", {}, tenantId) || {};
  const client = createMiniMaxVoiceClient({
    apiKey: config.apiKey || config.key || process.env.YUNWU_API_KEY,
    baseUrl: config.baseUrl,
  });
  return client.synthesize({ text, voiceId, signal });
}

async function defaultDownloadAudio({
  url,
  fetchFn = globalThis.fetch,
  signal,
}) {
  const safeUrl = parseMiniMaxAudioUrl(url);
  if (typeof fetchFn !== "function") {
    throw failure(
      "配音下载器未配置",
      503,
      "TEXT_VIDEO_TTS_DOWNLOAD_UNAVAILABLE",
    );
  }
  let response;
  try {
    response = await fetchFn(safeUrl, {
      method: "GET",
      redirect: "follow",
      signal,
      headers: { Accept: "audio/mpeg,audio/wav,audio/mp4;q=0.9" },
    });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") {
      throw failure("配音下载已取消", 499, "TEXT_VIDEO_CANCELLED");
    }
    throw failure("真实配音下载失败", 502, "TEXT_VIDEO_TTS_DOWNLOAD_FAILED");
  }
  if (!response?.ok) {
    throw failure(
      `真实配音下载失败（HTTP ${Number(response?.status || 0) || "未知"}）`,
      502,
      "TEXT_VIDEO_TTS_DOWNLOAD_FAILED",
    );
  }
  if (response.url) parseMiniMaxAudioUrl(response.url);
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > TEXT_VIDEO_MAX_AUDIO_BYTES) {
    throw failure(
      "配音文件超过安全大小上限",
      413,
      "TEXT_VIDEO_TTS_AUDIO_TOO_LARGE",
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > TEXT_VIDEO_MAX_AUDIO_BYTES) {
    throw failure(
      "配音文件为空或超过安全大小上限",
      502,
      "TEXT_VIDEO_TTS_AUDIO_INVALID",
    );
  }
  return { bytes, format: detectAudio(bytes) };
}

async function defaultMediaPreflight({
  ffmpegPath,
  ffprobePath,
  runner,
  signal,
}) {
  for (const command of [ffmpegPath, ffprobePath]) {
    try {
      const result = await runner(command, ["-version"], {
        timeoutMs: 10_000,
        signal,
      });
      if (result?.code !== undefined && Number(result.code) !== 0) throw result;
    } catch {
      throw failure(
        "服务器缺少可执行的FFmpeg/FFprobe，不能生成真实成片",
        503,
        "TEXT_VIDEO_FFMPEG_UNAVAILABLE",
      );
    }
  }
  let filters;
  let encoders;
  try {
    [filters, encoders] = await Promise.all([
      runner(ffmpegPath, ["-hide_banner", "-filters"], {
        timeoutMs: 10_000,
        signal,
      }),
      runner(ffmpegPath, ["-hide_banner", "-encoders"], {
        timeoutMs: 10_000,
        signal,
      }),
    ]);
  } catch {
    throw failure(
      "FFmpeg能力清单无法验证，不能生成真实成片",
      503,
      "TEXT_VIDEO_FFMPEG_CAPABILITY_MISSING",
    );
  }
  if (
    (filters?.code !== undefined && Number(filters.code) !== 0) ||
    (encoders?.code !== undefined && Number(encoders.code) !== 0)
  ) {
    throw failure(
      "FFmpeg能力清单无法验证，不能生成真实成片",
      503,
      "TEXT_VIDEO_FFMPEG_CAPABILITY_MISSING",
    );
  }
  const filterText = `${filters?.stdout || ""}\n${filters?.stderr || ""}`;
  const encoderText = `${encoders?.stdout || ""}\n${encoders?.stderr || ""}`;
  const requiredFilters = [
    "zoompan",
    "scale",
    "crop",
    "concat",
    "amix",
    "aresample",
    "apad",
  ];
  const missingFilters = requiredFilters.filter(
    (name) => !new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, "mu").test(filterText),
  );
  const missingEncoders = ["libx264", "aac"].filter(
    (name) => !new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, "mu").test(encoderText),
  );
  const hasDrawtext = /(?:^|\s)drawtext(?:\s|$)/mu.test(filterText);
  const hasOverlay = /(?:^|\s)overlay(?:\s|$)/mu.test(filterText);
  if (
    missingFilters.length ||
    missingEncoders.length ||
    (!hasDrawtext && !hasOverlay)
  ) {
    throw failure(
      `FFmpeg缺少成片必需能力：${[
        ...missingFilters,
        ...missingEncoders,
        ...(!hasDrawtext && !hasOverlay ? ["drawtext或overlay"] : []),
      ].join("、")}`,
      503,
      "TEXT_VIDEO_FFMPEG_CAPABILITY_MISSING",
    );
  }
  return {
    textOverlayMode: hasDrawtext ? "drawtext" : "raster_png",
    fontSource: hasDrawtext
      ? "ffmpeg_fontconfig"
      : "bundled_noto_sans_sc_outlines",
  };
}

function assertTtsEvidence(result, sentence) {
  const attempt = result?.providerAttempt || {};
  const usage = normalizeProviderUsage(attempt.usage || result?.usage);
  if (
    attempt.mode !== "api" ||
    usage.networkRequests < 1 ||
    usage.inputCharacters < codepointLength(sentence)
  ) {
    throw failure(
      "配音服务没有返回可核验的真实调用证据",
      502,
      "TEXT_VIDEO_TTS_EVIDENCE_MISSING",
    );
  }
  return { attempt, usage };
}

function normalizeDownloadedAudio(result) {
  const bytes = Buffer.isBuffer(result?.bytes)
    ? result.bytes
    : result?.bytes instanceof Uint8Array
      ? Buffer.from(result.bytes)
      : null;
  if (!bytes?.length || bytes.length > TEXT_VIDEO_MAX_AUDIO_BYTES) {
    throw failure(
      "真实配音为空或超过安全大小上限",
      502,
      "TEXT_VIDEO_TTS_AUDIO_INVALID",
    );
  }
  const format = detectAudio(bytes);
  if (result?.format?.ext && result.format.ext !== format.ext) {
    throw failure(
      "配音格式证据与真实内容不一致",
      502,
      "TEXT_VIDEO_TTS_AUDIO_INVALID",
    );
  }
  return { bytes, format };
}

function outputFileName(jobId) {
  return `text-video-${positiveId(jobId, "成片任务编号")}-${crypto.randomBytes(18).toString("hex")}.mp4`;
}

function configuredFlatCostCny() {
  const config = billing();
  const amount = Number(
    config.video?.[TEXT_VIDEO_BILLING_MODEL] ?? config.video?.default,
  );
  if (!Number.isFinite(amount) || amount <= 0) {
    throw failure(
      "图文成片计费价格未配置",
      503,
      "TEXT_VIDEO_BILLING_PRICE_MISSING",
    );
  }
  return amount;
}

/**
 * Real local renderer. All provider calls, command execution and downloads are
 * injectable so the acceptance suite never opens a network connection or pays.
 */
export function createTextVideoRenderer(options = {}) {
  const runner = options.runner || defaultRunner;
  const compressFn = options.compressFn || defaultCompression;
  const ttsFn = options.ttsFn || defaultTts;
  const downloadAudioFn = options.downloadAudioFn || defaultDownloadAudio;
  const mediaPreflightFn = options.mediaPreflightFn || defaultMediaPreflight;
  // 显式选项 > 专用环境变量 > 统一解析器（含 FFMPEG_PATH/FFPROBE_PATH 与
  // Homebrew 目录探测）。解析不到时保留裸命令兜底，真正执行时由
  // commandFailure 把 ENOENT 转成可操作的中文错误。
  const ffmpegPath = String(
    options.ffmpegPath ||
      process.env.TEXT_VIDEO_FFMPEG_PATH ||
      resolveFfmpeg() ||
      "ffmpeg",
  ).trim();
  const ffprobePath = String(
    options.ffprobePath ||
      process.env.TEXT_VIDEO_FFPROBE_PATH ||
      resolveFfprobe() ||
      "ffprobe",
  ).trim();
  const outputRoot = path.resolve(options.outputRoot || UPLOAD_ROOT);
  let verifiedMediaProfile = null;
  if (outputRoot === path.parse(outputRoot).root) {
    throw failure("成片输出根目录无效", 500, "TEXT_VIDEO_OUTPUT_ROOT_INVALID");
  }

  async function ensureMediaProfile(signal = null) {
    if (verifiedMediaProfile) return verifiedMediaProfile;
    const result = await mediaPreflightFn({
      ffmpegPath,
      ffprobePath,
      runner,
      signal,
    });
    const profile =
      result === true
        ? {
            textOverlayMode: "drawtext",
            fontSource: "ffmpeg_fontconfig",
          }
        : result;
    if (
      !profile ||
      !new Set(["drawtext", "raster_png"]).has(profile.textOverlayMode)
    ) {
      throw failure(
        "媒体预检没有返回可验证的字幕渲染模式",
        503,
        "TEXT_VIDEO_FFMPEG_CAPABILITY_MISSING",
      );
    }
    if (profile.textOverlayMode === "raster_png") {
      await renderTextOverlayPng({
        title: "真实中文标题",
        subtitle: "本机字幕回退能力验证",
        signal,
      });
    }
    throwIfAborted(signal);
    verifiedMediaProfile = Object.freeze({
      textOverlayMode: profile.textOverlayMode,
      fontSource: cleanLine(
        profile.fontSource ||
          (profile.textOverlayMode === "raster_png"
            ? "bundled_noto_sans_sc_outlines"
            : "ffmpeg_fontconfig"),
        100,
      ),
    });
    return verifiedMediaProfile;
  }

  async function preflight({ tenantId, body }) {
    positiveId(tenantId, "租户编号");
    const plain = plainTextVideoBody(body);
    if (
      codepointLength(plain) > LONG_BODY_THRESHOLD &&
      !options.compressFn &&
      !aiAvailable()
    ) {
      throw failure(
        "长正文压缩模型未配置，不能用本地草稿冒充口播稿",
        503,
        "TEXT_VIDEO_COMPRESSION_UNAVAILABLE",
      );
    }
    if (!options.ttsFn) {
      const config =
        getTenantConfig("text_video_minimax_voice", {}, tenantId) || {};
      if (!(config.apiKey || config.key || process.env.YUNWU_API_KEY)) {
        throw failure(
          "真实TTS通道未配置服务端凭据",
          503,
          "PROVIDER_CREDENTIALS_MISSING",
        );
      }
    }
    await ensureMediaProfile();
    return true;
  }

  async function render({
    tenantId,
    jobId,
    title,
    body,
    mode = "images",
    imagePaths = [],
    clipPaths = [],
    allowSolidBackground = false,
    voiceId = TEXT_VIDEO_DEFAULT_VOICE,
    bgm = "warm",
    signal = null,
    onStep = () => {},
  } = {}) {
    const tid = positiveId(tenantId, "租户编号");
    const id = positiveId(jobId, "成片任务编号");
    const selectedMode = modeOf(mode);
    const selectedBgm = bgmOf(bgm);
    const selectedVoice = voiceIdOf(voiceId);
    const images = imagePaths.map((item, index) => ({
      ...item,
      path: absoluteRegularFile(item?.path || item, `第${index + 1}张图片`),
    }));
    const clips = clipPaths.map((item, index) => ({
      ...item,
      path: absoluteRegularFile(item?.path || item, `第${index + 1}段视频`),
    }));
    if (
      selectedMode === "images" &&
      !images.length &&
      allowSolidBackground !== true
    ) {
      throw failure(
        "没有可用图片；只有显式允许纯色背景后才能无图成片",
        400,
        "TEXT_VIDEO_IMAGES_REQUIRED",
      );
    }
    if (selectedMode === "clips" && !clips.length) {
      throw failure(
        "混剪模式至少需要一个本租户上传片段",
        400,
        "TEXT_VIDEO_CLIPS_REQUIRED",
      );
    }
    const mediaProfile = await ensureMediaProfile(signal);

    onStep({ phase: "script", message: "正在整理口播稿与逐屏分句" });
    const prepared = await prepareTextVideoScript({
      title,
      body,
      compressFn,
      signal,
    });
    const sentences = splitTextVideoSentences(prepared.script);
    const tempRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), "nanowork-text-video-"),
    );
    let committedPath = null;
    try {
      const titlePlain = codepoints(safeTitle(title)).slice(0, 28).join("");
      const titleText = wrapSubtitle(titlePlain, 14, 2);
      const titleFile =
        mediaProfile.textOverlayMode === "drawtext"
          ? path.join(tempRoot, "title.txt")
          : null;
      if (titleFile) {
        await fsp.writeFile(titleFile, titleText, {
          flag: "wx",
          mode: 0o600,
        });
      }
      const rasterOverlayPaths = [];
      if (mediaProfile.textOverlayMode === "raster_png") {
        onStep({
          phase: "script",
          message: "正在用内置中文字体生成安全字幕图层",
        });
        for (const [index, sentence] of sentences.entries()) {
          const overlayPath = path.join(tempRoot, `text-overlay-${index}.png`);
          await renderTextOverlayPng({
            title: titlePlain,
            subtitle: sentence,
            destination: overlayPath,
            signal,
          });
          rasterOverlayPaths.push(overlayPath);
        }
      }
      const ttsEvidence = [];
      const audioRows = [];
      onStep({
        phase: "tts",
        message: `口播共${sentences.length}句，开始真实TTS逐句配音`,
      });
      for (const [index, sentence] of sentences.entries()) {
        if (signal?.aborted) {
          throw failure("成片任务已取消", 499, "TEXT_VIDEO_CANCELLED");
        }
        const tts = await ttsFn({
          tenantId: tid,
          text: sentence,
          voiceId: selectedVoice,
          signal,
        });
        const evidence = assertTtsEvidence(tts, sentence);
        const downloaded = tts?.bytes
          ? normalizeDownloadedAudio(tts)
          : normalizeDownloadedAudio(
              await downloadAudioFn({
                url: tts?.audioUrl,
                signal,
                fetchFn: options.fetchFn,
              }),
            );
        const audioPath = path.join(
          tempRoot,
          `audio-${index}.${downloaded.format.ext}`,
        );
        await fsp.writeFile(audioPath, downloaded.bytes, {
          flag: "wx",
          mode: 0o600,
        });
        const probe = await probeFile({
          runner,
          ffprobePath,
          filePath: audioPath,
          label: `第${index + 1}句配音`,
          kind: "audio",
          cwd: tempRoot,
          signal,
        });
        if (probe.duration < 0.3 || probe.duration > 120) {
          throw failure(
            `第${index + 1}句配音时长异常`,
            502,
            "TEXT_VIDEO_TTS_DURATION_INVALID",
          );
        }
        audioRows.push({ path: audioPath, duration: probe.duration });
        ttsEvidence.push({
          sentenceIndex: index,
          model: cleanLine(
            tts?.providerAttempt?.model || MINIMAX_TTS_MODEL,
            100,
          ),
          provider: cleanLine(
            tts?.providerAttempt?.provider || "yunwu-minimax",
            80,
          ),
          usage: evidence.usage,
        });
        onStep({
          phase: "tts",
          message: `真实配音 ${index + 1}/${sentences.length}`,
          current: index + 1,
          total: sentences.length,
        });
      }

      const clipProbes = [];
      if (selectedMode === "clips") {
        for (const [index, clip] of clips.entries()) {
          const probe = await probeFile({
            runner,
            ffprobePath,
            filePath: clip.path,
            label: `第${index + 1}段租户视频`,
            kind: "video",
            cwd: tempRoot,
            signal,
          });
          if (probe.duration < 1.5 || probe.duration > 600) {
            throw failure(
              `第${index + 1}段租户视频时长必须在1.5至600秒`,
              400,
              "TEXT_VIDEO_CLIP_DURATION_INVALID",
            );
          }
          clipProbes.push(probe);
        }
      }

      onStep({ phase: "compose", message: "开始合成标题、字幕、运镜与画面" });
      const colors = [
        "0x1f2430",
        "0x2b3a55",
        "0x3a2b45",
        "0x224036",
        "0x40352b",
      ];
      const segments = [];
      for (const [index, sentence] of sentences.entries()) {
        const subtitle =
          mediaProfile.textOverlayMode === "drawtext"
            ? path.join(tempRoot, `subtitle-${index}.txt`)
            : null;
        if (subtitle) {
          await fsp.writeFile(subtitle, wrapSubtitle(sentence), {
            flag: "wx",
            mode: 0o600,
          });
        }
        const visual =
          selectedMode === "clips"
            ? { type: "clip", path: clips[index % clips.length].path }
            : images.length
              ? {
                  type: "image",
                  path: images[
                    Math.floor((index * images.length) / sentences.length)
                  ].path,
                }
              : { type: "solid", color: colors[index % colors.length] };
        const segment = path.join(tempRoot, `segment-${index}.mp4`);
        const command = segmentCommand({
          ffmpegPath,
          visual,
          audio: audioRows[index].path,
          duration: audioRows[index].duration,
          textOverlayMode: mediaProfile.textOverlayMode,
          titleFile,
          subtitleFile: subtitle,
          overlayPath: rasterOverlayPaths[index] || null,
          output: segment,
          index,
        });
        let commandResult;
        try {
          commandResult = await runner(command.command, command.args, {
            cwd: tempRoot,
            timeoutMs: 5 * 60 * 1000,
            signal,
          });
        } catch (error) {
          if (error instanceof TextVideoError) throw error;
          throw commandFailure(ffmpegPath, error);
        }
        if (
          commandResult?.code !== undefined &&
          Number(commandResult.code) !== 0
        ) {
          throw commandFailure(ffmpegPath, commandResult);
        }
        const stat = await fsp.stat(segment).catch(() => null);
        if (
          !stat?.isFile() ||
          stat.size < 16 ||
          stat.size > TEXT_VIDEO_MAX_OUTPUT_BYTES
        ) {
          throw failure(
            `第${index + 1}句没有形成真实视频片段`,
            502,
            "TEXT_VIDEO_SEGMENT_INVALID",
          );
        }
        segments.push(segment);
        onStep({
          phase: "compose",
          message: `画面合成 ${index + 1}/${sentences.length}`,
          current: index + 1,
          total: sentences.length,
        });
      }

      onStep({
        phase: "finalize",
        message:
          selectedBgm === "none"
            ? "正在拼装1080×1920竖版成片"
            : "正在拼装1080×1920竖版成片并混入免版权合成配乐",
      });
      const temporaryOutput = path.join(tempRoot, "final.mp4");
      const bgmPath =
        selectedBgm === "none"
          ? null
          : await writeGeneratedBgm(tempRoot, selectedBgm);
      const command = finalCommand({
        ffmpegPath,
        segments,
        output: temporaryOutput,
        bgm: selectedBgm,
        bgmPath,
      });
      let result;
      try {
        result = await runner(command.command, command.args, {
          cwd: tempRoot,
          timeoutMs: 20 * 60 * 1000,
          signal,
        });
      } catch (error) {
        if (error instanceof TextVideoError) throw error;
        throw commandFailure(ffmpegPath, error);
      }
      if (result?.code !== undefined && Number(result.code) !== 0) {
        throw commandFailure(ffmpegPath, result);
      }
      const stat = await fsp.stat(temporaryOutput).catch(() => null);
      if (
        !stat?.isFile() ||
        stat.size < 16 ||
        stat.size > TEXT_VIDEO_MAX_OUTPUT_BYTES
      ) {
        throw failure(
          "FFmpeg没有形成真实成片",
          502,
          "TEXT_VIDEO_OUTPUT_INVALID",
        );
      }
      const header = await fsp
        .open(temporaryOutput, "r")
        .then(async (handle) => {
          try {
            const bytes = Buffer.alloc(Math.min(4096, stat.size));
            const read = await handle.read(bytes, 0, bytes.length, 0);
            return bytes.subarray(0, read.bytesRead);
          } finally {
            await handle.close();
          }
        });
      detectOutputVideo(header);
      const outputProbe = await probeFile({
        runner,
        ffprobePath,
        filePath: temporaryOutput,
        label: "最终成片",
        kind: "output",
        cwd: tempRoot,
        signal,
      });
      if (
        outputProbe.width !== 1080 ||
        outputProbe.height !== 1920 ||
        !new Set(["h264", "avc1"]).has(outputProbe.videoCodec) ||
        outputProbe.audioCodec !== "aac"
      ) {
        throw failure(
          "成片未通过1080×1920/H264/AAC交付校验",
          502,
          "TEXT_VIDEO_OUTPUT_CONTRACT_FAILED",
        );
      }
      const outputDirectory = path.resolve(
        outputRoot,
        String(tid),
        "text-video-output",
      );
      if (!outputDirectory.startsWith(`${outputRoot}${path.sep}`)) {
        throw failure(
          "成片输出目录越界",
          500,
          "TEXT_VIDEO_OUTPUT_ROOT_INVALID",
        );
      }
      await fsp.mkdir(outputDirectory, { recursive: true, mode: 0o750 });
      const fileName = outputFileName(id);
      const finalPath = path.join(outputDirectory, fileName);
      await fsp.rename(temporaryOutput, finalPath);
      committedPath = finalPath;
      await fsp.chmod(finalPath, 0o600);
      const sha256 = await sha256File(finalPath);
      const ttsNetworkRequests = ttsEvidence.reduce(
        (sum, item) => sum + Number(item.usage.networkRequests || 0),
        0,
      );
      return {
        script: prepared.script,
        sentences,
        absolutePath: finalPath,
        fileName,
        fileUrl: `/uploads/files/${tid}/text-video-output/${encodeURIComponent(fileName)}`,
        mimeType: "video/mp4",
        byteSize: stat.size,
        sha256,
        probe: outputProbe,
        evidence: {
          schemaVersion: "nanowork.text-video-render-evidence/1",
          realDelivery: true,
          template: false,
          mode: selectedMode,
          sentenceCount: sentences.length,
          imageCount: images.length,
          clipCount: clips.length,
          solidBackgroundExplicit:
            selectedMode === "images" &&
            !images.length &&
            allowSolidBackground === true,
          compression: prepared.compression,
          tts: {
            provider: "yunwu-minimax",
            model: MINIMAX_TTS_MODEL,
            networkRequests: ttsNetworkRequests,
            inputCharacters: ttsEvidence.reduce(
              (sum, item) => sum + Number(item.usage.inputCharacters || 0),
              0,
            ),
            calls: ttsEvidence,
          },
          render: {
            engine: "ffmpeg",
            width: outputProbe.width,
            height: outputProbe.height,
            videoCodec: outputProbe.videoCodec,
            audioCodec: outputProbe.audioCodec,
            durationSeconds: outputProbe.duration,
            bgm: selectedBgm,
            bgmSource:
              selectedBgm === "none"
                ? "none"
                : "server_generated_pcm_chord_loop",
            kenBurns: selectedMode === "images" && images.length > 0,
            subtitles: true,
            title: true,
            textOverlayMode: mediaProfile.textOverlayMode,
            subtitleFontSource: mediaProfile.fontSource,
          },
          usage: {
            networkRequests:
              ttsNetworkRequests +
              Number(prepared.compression.usage?.networkRequests || 0),
            inputTokens: Number(prepared.compression.usage?.inputTokens || 0),
            outputTokens: Number(prepared.compression.usage?.outputTokens || 0),
            ttsCharacters: ttsEvidence.reduce(
              (sum, item) => sum + Number(item.usage.inputCharacters || 0),
              0,
            ),
            ffmpegSegments: segments.length,
          },
          cost: {
            amount: configuredFlatCostCny(),
            currency: "CNY",
            pricingMode: "configured_verified_output_flat_rate",
            billingModel: TEXT_VIDEO_BILLING_MODEL,
          },
          artifact: {
            sha256,
            bytes: stat.size,
            mimeType: "video/mp4",
          },
        },
      };
    } catch (error) {
      if (committedPath)
        await fsp.rm(committedPath, { force: true }).catch(() => {});
      throw error;
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  return Object.freeze({ preflight, render });
}

function safeError(error) {
  if (error instanceof TextVideoError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  const code = SAFE_ERROR_CODE.test(String(error?.code || ""))
    ? String(error.code)
    : "TEXT_VIDEO_EXECUTION_FAILED";
  const known =
    code.startsWith("TEXT_VIDEO_") ||
    code.startsWith("MINIMAX_") ||
    code === "PROVIDER_CREDENTIALS_MISSING";
  return {
    code,
    status: Number(error?.status) || 500,
    message: known
      ? cleanLine(error?.message, 300)
      : "成片任务处理失败，预授权已安全收口，可从原任务免费重试",
  };
}

function appendStep(jobId, event, now = Date.now) {
  const row = q.get(
    "SELECT status,steps_json,progress FROM text_video_jobs WHERE tenant_id=? AND id=?",
    curTenant(),
    jobId,
  );
  if (!row || TERMINAL.has(row.status)) return;
  const steps = parseJson(row.steps_json, []);
  const list = Array.isArray(steps) ? steps : [];
  const phase = cleanLine(event?.phase || "running", 60);
  const progressByPhase = {
    queued: 3,
    script: 12,
    tts: 32,
    compose: 68,
    finalize: 84,
    persist: 92,
    settle: 97,
    done: 100,
  };
  const eventProgress =
    Number.isFinite(Number(event?.current)) && Number(event?.total) > 0
      ? Math.round(
          Number(progressByPhase[phase] || 8) +
            (Number(event.current) / Number(event.total)) *
              (phase === "tts" ? 20 : phase === "compose" ? 16 : 4),
        )
      : Number(progressByPhase[phase] || 8);
  const step = {
    phase,
    message: cleanLine(event?.message || "成片任务处理中", 240),
    at: nowIso(now),
    ...(Number.isFinite(Number(event?.current))
      ? { current: Number(event.current) }
      : {}),
    ...(Number.isFinite(Number(event?.total))
      ? { total: Number(event.total) }
      : {}),
  };
  q.run(
    `UPDATE text_video_jobs SET steps_json=?,progress=?,updated_at=?
    WHERE tenant_id=? AND id=? AND status IN ('queued','running')`,
    JSON.stringify([...list.slice(-119), step]),
    Math.min(99, Math.max(Number(row.progress || 0), eventProgress)),
    nowIso(now),
    curTenant(),
    jobId,
  );
}

function ledgerFor(jobId, tenantId) {
  return q.get(
    `SELECT h.*,l.credits ledger_credits,l.cost_yuan,l.balance_after
    FROM credit_holds h
    LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
    WHERE h.tenant_id=? AND h.ref_type=? AND h.ref_id=?
    ORDER BY h.id DESC LIMIT 1`,
    tenantId,
    BILLING_REF,
    jobId,
  );
}

function billingView(row) {
  const ledger = ledgerFor(row.id, row.tenant_id);
  const state =
    {
      pending: "missing",
      held: "held",
      settled: "settled",
      released: "released",
      included: "not_required",
      pending_reconciliation: "pending_reconciliation",
    }[row.billing_status] || "missing";
  const credits =
    state === "settled"
      ? Number(row.settled_credits ?? ledger?.settled_credits ?? 0)
      : state === "held"
        ? Number(row.held_credits || ledger?.held_credits || 0)
        : 0;
  return {
    state,
    credits,
    costYuan:
      state === "settled"
        ? Number(ledger?.cost_yuan ?? parseJson(row.cost_json)?.amount ?? 0)
        : null,
    balance: Number(ledger?.balance_after ?? balanceOfTenant(row.tenant_id)),
    label:
      {
        missing: "尚未预授权",
        held: `已预授权 ${credits} 积分`,
        settled: `已结算 ${credits} 积分`,
        released: "预授权已全额退回",
        not_required: "免费重试，不重复扣费",
        pending_reconciliation: "待账务对账",
      }[state] || "账务状态未知",
    authoritative: ["held", "settled", "released", "not_required"].includes(
      state,
    ),
    ledger: {
      source:
        state === "not_required" ? "free_retry" : "credit_holds+credit_logs",
      holdId: ledger ? Number(ledger.id) : null,
      logId: ledger ? Number(ledger.log_id) : null,
      status: ledger?.status || null,
      heldCredits: ledger ? Number(ledger.held_credits) : null,
      settledCredits:
        ledger?.settled_credits == null ? null : Number(ledger.settled_credits),
    },
  };
}

function outputArtifact(row) {
  if (!row?.output_file_id || !row.result_url || !row.result_sha256)
    return null;
  const file = q.get(
    `SELECT * FROM uploaded_files
    WHERE tenant_id=? AND id=? AND purpose='text-video-output'`,
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
  let stat;
  try {
    stat = fs.lstatSync(file.file_path);
  } catch {
    return null;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size !== Number(file.size)
  ) {
    return null;
  }
  return file;
}

function publicJob(row) {
  const billing = billingView(row);
  const artifact = outputArtifact(row);
  const steps = parseJson(row.steps_json, []);
  const usable =
    row.status === "done" &&
    Boolean(artifact) &&
    ["settled", "not_required"].includes(billing.state);
  const params = parseJson(row.params_json, {});
  return {
    id: Number(row.id),
    sourceKey: `text_video:${row.id}`,
    deepLink: `/tasks?kind=text_video&id=${encodeURIComponent(String(row.id))}`,
    studioDeepLink: `/toolbox?studio=text-video&jobId=${encodeURIComponent(String(row.id))}`,
    title: row.title,
    mode: row.mode,
    input: {
      imageFileIds: Array.isArray(params.imageFileIds)
        ? params.imageFileIds
        : [],
      materialIds: Array.isArray(params.materialIds) ? params.materialIds : [],
      clipFileIds: Array.isArray(params.clipFileIds) ? params.clipFileIds : [],
      allowSolidBackground: params.allowSolidBackground === true,
      bgm: params.bgm,
      voiceId: params.voiceId,
    },
    script: row.status === "done" ? row.script || "" : "",
    status: row.status,
    billingStatus: row.billing_status,
    billing,
    progress: Number(row.progress || 0),
    steps: Array.isArray(steps) ? steps : [],
    usage: parseJson(row.usage_json, null),
    cost: parseJson(row.cost_json, null),
    renderEvidence: parseJson(row.render_evidence_json, null),
    retryCount: Number(row.retry_count || 0),
    freeRetriesRemaining: Math.max(
      0,
      TEXT_VIDEO_MAX_FREE_RETRIES - Number(row.retry_count || 0),
    ),
    retryable:
      row.status === "failed" &&
      ["released", "included"].includes(row.billing_status) &&
      Number(row.retry_count || 0) < TEXT_VIDEO_MAX_FREE_RETRIES,
    cancelable: ["queued", "running"].includes(row.status),
    artifactReady: Boolean(artifact),
    businessUsable: usable,
    outputUrl: usable ? row.result_url : null,
    resultSha256: usable ? row.result_sha256 : null,
    resultBytes: usable ? Number(row.result_bytes || 0) : null,
    durationSeconds:
      usable && row.duration_seconds != null
        ? Number(row.duration_seconds)
        : null,
    error: ["failed", "cancelled"].includes(row.status)
      ? row.error_message || null
      : null,
    errorCode: ["failed", "cancelled"].includes(row.status)
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

function authorizedJob(user, jobId) {
  const id = positiveId(jobId, "成片任务编号");
  const row = q.get(
    "SELECT * FROM text_video_jobs WHERE tenant_id=? AND id=?",
    curTenant(),
    id,
  );
  if (!row || !canAccessOwner(user, row.created_by)) {
    throw failure("成片任务不存在或无权查看", 404, "TEXT_VIDEO_JOB_NOT_FOUND");
  }
  return row;
}

function resolveVoiceForTenant(tenantId, requested) {
  const voiceId = voiceIdOf(requested);
  const config =
    getTenantConfig("text_video_minimax_voice", {}, tenantId) || {};
  const configuredDefault = voiceIdOf(
    config.defaultVoiceId || TEXT_VIDEO_DEFAULT_VOICE,
  );
  if (voiceId === configuredDefault || voiceId === TEXT_VIDEO_DEFAULT_VOICE) {
    return voiceId;
  }
  const cloned = q.get(
    `SELECT id FROM avatar_voices
    WHERE tenant_id=? AND provider_voice_id=? AND status='ready'
      AND billing_status='settled'`,
    tenantId,
    voiceId,
  );
  if (!cloned) {
    throw failure(
      "所选声音不是本租户已结算可用的克隆声音",
      403,
      "TEXT_VIDEO_VOICE_NOT_AUTHORIZED",
    );
  }
  return voiceId;
}

function resolveJobAssets(row, user = null) {
  const params = parseJson(row.params_json, {});
  const imagePaths = idsOf(params.imageFileIds, "图片素材").map((fileId) => {
    const file = q.get(
      "SELECT purpose FROM uploaded_files WHERE tenant_id=? AND id=?",
      row.tenant_id,
      fileId,
    );
    if (
      !file ||
      !new Set(["text-video-image", "avatar-image", "imagehunt"]).has(
        file.purpose,
      )
    ) {
      throw failure(
        "图片素材不是本租户成片可用文件",
        409,
        "TEXT_VIDEO_IMAGE_NOT_AUTHORIZED",
      );
    }
    return resolveTenantFile({
      tenantId: row.tenant_id,
      fileId,
      purpose: file.purpose,
      user,
    });
  });
  for (const materialId of idsOf(params.materialIds, "授权素材")) {
    imagePaths.push(
      resolveMaterialFile({ tenantId: row.tenant_id, materialId, user }),
    );
  }
  const clipPaths = idsOf(params.clipFileIds, "视频片段", 12).map((fileId) =>
    resolveTenantFile({
      tenantId: row.tenant_id,
      fileId,
      purpose: "text-video-clip",
      user,
    }),
  );
  return { imagePaths, clipPaths };
}

async function deleteOutput(row) {
  if (!row?.output_file_id) return;
  const file = q.get(
    `SELECT id,file_path FROM uploaded_files
    WHERE tenant_id=? AND id=? AND purpose='text-video-output'`,
    row.tenant_id,
    row.output_file_id,
  );
  if (!file) return;
  q.run(
    "DELETE FROM uploaded_files WHERE tenant_id=? AND id=? AND purpose='text-video-output'",
    row.tenant_id,
    file.id,
  );
  await fsp.rm(file.file_path, { force: true }).catch(() => {});
}

function billingCreditsForCost(amount) {
  const config = billing();
  const value = Number(amount);
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isFinite(Number(config.marginMultiplier)) ||
    !Number.isFinite(Number(config.creditYuan)) ||
    Number(config.creditYuan) <= 0
  ) {
    throw failure(
      "成片费用证据不足",
      409,
      "TEXT_VIDEO_BILLING_EVIDENCE_MISSING",
    );
  }
  return Math.max(
    1,
    Math.ceil(
      (value * Number(config.marginMultiplier)) / Number(config.creditYuan),
    ),
  );
}

function renderBillingEvidence(rendered) {
  const evidence = rendered?.evidence;
  const cost = evidence?.cost;
  const usage = evidence?.usage;
  if (
    evidence?.realDelivery !== true ||
    evidence?.template === true ||
    !Number.isSafeInteger(Number(usage?.networkRequests)) ||
    Number(usage.networkRequests) < Number(evidence?.sentenceCount || 1) ||
    !Number.isFinite(Number(cost?.amount)) ||
    Number(cost.amount) <= 0 ||
    String(cost?.currency).toUpperCase() !== "CNY" ||
    rendered?.probe?.width !== 1080 ||
    rendered?.probe?.height !== 1920 ||
    !["h264", "avc1"].includes(rendered?.probe?.videoCodec) ||
    rendered?.probe?.audioCodec !== "aac" ||
    !/^[a-f0-9]{64}$/u.test(String(rendered?.sha256 || ""))
  ) {
    throw failure(
      "成片缺少真实TTS、FFmpeg或费用证据，不能结算交付",
      409,
      "TEXT_VIDEO_BILLING_EVIDENCE_MISSING",
    );
  }
  return {
    usage: {
      networkRequests: Number(usage.networkRequests),
      inputTokens: Number(usage.inputTokens || 0),
      outputTokens: Number(usage.outputTokens || 0),
      ttsCharacters: Number(usage.ttsCharacters || 0),
      ffmpegSegments: Number(usage.ffmpegSegments || 0),
    },
    cost: {
      amount: Number(cost.amount),
      currency: "CNY",
      pricingMode: cost.pricingMode,
    },
    actualCredits: billingCreditsForCost(cost.amount),
  };
}

function createSlotPool(maximum) {
  const limit = Math.max(1, Number(maximum) || TEXT_VIDEO_CONCURRENCY);
  let running = 0;
  const waiters = [];
  async function acquire(signal) {
    if (signal?.aborted)
      throw failure("成片任务已取消", 499, "TEXT_VIDEO_CANCELLED");
    if (running < limit) {
      running += 1;
      return;
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: null };
      waiter.abort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(failure("成片任务已取消", 499, "TEXT_VIDEO_CANCELLED"));
      };
      signal?.addEventListener?.("abort", waiter.abort, { once: true });
      waiters.push(waiter);
    });
    running += 1;
  }
  function release() {
    running = Math.max(0, running - 1);
    const next = waiters.shift();
    if (next) {
      next.signal?.removeEventListener?.("abort", next.abort);
      next.resolve();
    }
  }
  return {
    acquire,
    release,
    active: () => running,
    waiting: () => waiters.length,
  };
}

export function createTextVideoJobService(options = {}) {
  const renderer =
    options.renderer || createTextVideoRenderer(options.rendererOptions);
  const now = options.now || Date.now;
  const hardTimeoutMs = Math.max(
    1_000,
    Number(options.hardTimeoutMs || TEXT_VIDEO_HARD_TIMEOUT_MS),
  );
  const slots = createSlotPool(options.concurrency || TEXT_VIDEO_CONCURRENCY);
  const active = new Map();
  const scheduled = new Set();

  async function createJob({
    user,
    title,
    body,
    mode = "images",
    imageFileIds = [],
    materialIds = [],
    clipFileIds = [],
    allowSolidBackground = false,
    voiceId,
    bgm,
  }) {
    const tenantId = positiveId(user?.tenant_id || curTenant(), "租户编号");
    const userId = positiveId(user?.id, "用户编号");
    const cleanBody = plainTextVideoBody(body);
    if (
      codepointLength(cleanBody) < 20 ||
      codepointLength(cleanBody) > 12_000
    ) {
      throw failure(
        "正文长度必须为20至12000字",
        400,
        "TEXT_VIDEO_SCRIPT_LENGTH_INVALID",
      );
    }
    const selectedMode = modeOf(mode);
    const params = {
      imageFileIds: idsOf(imageFileIds, "图片素材"),
      materialIds: idsOf(materialIds, "授权素材"),
      clipFileIds: idsOf(clipFileIds, "视频片段", 12),
      allowSolidBackground: allowSolidBackground === true,
      voiceId: resolveVoiceForTenant(tenantId, voiceId),
      bgm: bgmOf(bgm),
    };
    if (
      selectedMode === "images" &&
      !params.imageFileIds.length &&
      !params.materialIds.length &&
      !params.allowSolidBackground
    ) {
      throw failure(
        "请选择本租户图片/已授权素材，或显式允许纯色背景",
        400,
        "TEXT_VIDEO_IMAGES_REQUIRED",
      );
    }
    if (selectedMode === "clips" && !params.clipFileIds.length) {
      throw failure(
        "混剪模式至少选择一个本租户上传片段",
        400,
        "TEXT_VIDEO_CLIPS_REQUIRED",
      );
    }
    const probeRow = {
      tenant_id: tenantId,
      params_json: JSON.stringify(params),
    };
    resolveJobAssets(probeRow, user);
    await renderer.preflight({ tenantId, body: cleanBody });
    const heldCredits = estimateMaxCredits("video", TEXT_VIDEO_BILLING_MODEL);
    const inserted = q.run(
      `INSERT INTO text_video_jobs(
        created_by,title,mode,body,params_json,status,billing_status,billing_model,
        held_credits,progress,steps_json,updated_at
      ) VALUES(?,?,?,?,?,'queued','pending',?,?,0,'[]',?)`,
      userId,
      safeTitle(title),
      selectedMode,
      cleanBody,
      JSON.stringify(params),
      TEXT_VIDEO_BILLING_MODEL,
      heldCredits,
      nowIso(now),
    );
    const jobId = Number(inserted.lastInsertRowid);
    let hold;
    try {
      hold = holdCredits({
        userId,
        tenantId,
        feature: "图文/素材一键成片",
        kind: "video",
        model: TEXT_VIDEO_BILLING_MODEL,
        credits: heldCredits,
        refType: BILLING_REF,
        refId: jobId,
        note: `成片任务 #${jobId} 在真实TTS与FFmpeg执行前预授权`,
      });
      const changed = q.run(
        `UPDATE text_video_jobs SET billing_status='held',held_credits=?,updated_at=?
        WHERE tenant_id=? AND id=? AND status='queued' AND billing_status='pending'`,
        hold.credits,
        nowIso(now),
        tenantId,
        jobId,
      );
      if (changed.changes !== 1) {
        releaseHold(hold, "成片任务状态冲突，预授权全额退回");
        throw failure(
          "成片任务状态冲突，请刷新后重试",
          409,
          "TEXT_VIDEO_STATE_CONFLICT",
        );
      }
      appendStep(
        jobId,
        { phase: "queued", message: "成片任务已受理，等待本机渲染槽位" },
        now,
      );
      return publicJob(
        q.get(
          "SELECT * FROM text_video_jobs WHERE tenant_id=? AND id=?",
          tenantId,
          jobId,
        ),
      );
    } catch (error) {
      if (!hold) {
        q.run(
          "DELETE FROM text_video_jobs WHERE tenant_id=? AND id=? AND billing_status='pending'",
          tenantId,
          jobId,
        );
      }
      throw error;
    }
  }

  function listJobs(user, { limit = 50 } = {}) {
    const tenantId = positiveId(user?.tenant_id || curTenant(), "租户编号");
    const scope = userScopeClause(user, "created_by");
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    return q
      .all(
        `SELECT * FROM text_video_jobs
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

  async function persistOutput(row, rendered) {
    const stat = await fsp.lstat(rendered.absolutePath).catch(() => null);
    if (
      !stat?.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== Number(rendered.byteSize) ||
      stat.size <= 0 ||
      stat.size > TEXT_VIDEO_MAX_OUTPUT_BYTES
    ) {
      throw failure(
        "最终成片落盘完整性校验失败",
        502,
        "TEXT_VIDEO_OUTPUT_INTEGRITY_INVALID",
      );
    }
    const header = Buffer.alloc(Math.min(4096, stat.size));
    const handle = await fsp.open(rendered.absolutePath, "r");
    try {
      const read = await handle.read(header, 0, header.length, 0);
      detectOutputVideo(header.subarray(0, read.bytesRead));
    } finally {
      await handle.close();
    }
    const persistedSha256 = await sha256File(rendered.absolutePath);
    if (persistedSha256 !== rendered.sha256) {
      throw failure(
        "最终成片SHA256证据与落盘文件不一致",
        502,
        "TEXT_VIDEO_OUTPUT_INTEGRITY_INVALID",
      );
    }
    const inserted = q.run(
      `INSERT INTO uploaded_files(
        user_id,name,stored_name,ext,mime,size,purpose,file_path,file_url,
        extracted_text,extract_mode
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      row.created_by,
      rendered.fileName,
      rendered.fileName,
      "mp4",
      "video/mp4",
      rendered.byteSize,
      "text-video-output",
      rendered.absolutePath,
      rendered.fileUrl,
      "",
      "真实TTS+FFmpeg竖版成片",
    );
    return q.get(
      "SELECT * FROM uploaded_files WHERE tenant_id=? AND id=?",
      row.tenant_id,
      inserted.lastInsertRowid,
    );
  }

  async function failAndRefund(jobId, error) {
    const row = q.get(
      "SELECT * FROM text_video_jobs WHERE tenant_id=? AND id=?",
      curTenant(),
      jobId,
    );
    if (!row || ["done", "cancelled"].includes(row.status)) return row;
    const safe = safeError(error);
    let billingStatus = row.billing_status;
    if (billingStatus === "held") {
      try {
        const hold = findHoldByRef(BILLING_REF, row.id, row.tenant_id);
        if (hold) releaseHold(hold, `成片未交付：${safe.message}`);
        billingStatus = "released";
      } catch {
        billingStatus = "pending_reconciliation";
      }
    }
    await deleteOutput(row);
    q.run(
      `UPDATE text_video_jobs SET status='failed',billing_status=?,output_file_id=NULL,
      result_url=NULL,result_sha256=NULL,result_bytes=NULL,error_code=?,error_message=?,
      completed_at=?,updated_at=?
      WHERE tenant_id=? AND id=? AND status IN ('queued','running')`,
      billingStatus,
      safe.code,
      billingStatus === "pending_reconciliation"
        ? `${safe.message}；退款待账务对账`
        : safe.message,
      nowIso(now),
      nowIso(now),
      row.tenant_id,
      row.id,
    );
    return q.get(
      "SELECT * FROM text_video_jobs WHERE tenant_id=? AND id=?",
      row.tenant_id,
      row.id,
    );
  }

  async function runJob(jobId, tenantId = curTenant()) {
    const id = positiveId(jobId, "成片任务编号");
    const tid = positiveId(tenantId, "租户编号");
    return runWithTenant(tid, async () => {
      const controller = new AbortController();
      const key = `${tid}:${id}`;
      active.set(key, controller);
      let acquired = false;
      try {
        const current = q.get(
          "SELECT status FROM text_video_jobs WHERE tenant_id=? AND id=?",
          tid,
          id,
        );
        if (!current || current.status !== "queued")
          return current ? publicJob(current) : null;
        if (slots.active() >= (options.concurrency || TEXT_VIDEO_CONCURRENCY)) {
          appendStep(
            id,
            { phase: "queued", message: "本机并发槽位已满，任务保持排队" },
            now,
          );
        }
        await slots.acquire(controller.signal);
        acquired = true;
        const startedAt = nowIso(now);
        const timeoutAt = new Date(Number(now()) + hardTimeoutMs).toISOString();
        const claimed = q.run(
          `UPDATE text_video_jobs SET status='running',progress=7,started_at=?,timeout_at=?,
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
          const row = q.get(
            "SELECT * FROM text_video_jobs WHERE tenant_id=? AND id=?",
            tid,
            id,
          );
          return row ? publicJob(row) : null;
        }
        const timeout = setTimeout(
          () =>
            controller.abort(
              failure("成片任务超过硬时限", 504, "TEXT_VIDEO_HARD_TIMEOUT"),
            ),
          hardTimeoutMs,
        );
        timeout.unref?.();
        const abortFailure = () =>
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : failure("成片任务已取消", 499, "TEXT_VIDEO_CANCELLED");
        let onAbort;
        const aborted = new Promise((_, reject) => {
          onAbort = () => reject(abortFailure());
          if (controller.signal.aborted) onAbort();
          else
            controller.signal.addEventListener("abort", onAbort, {
              once: true,
            });
        });
        let rendered = null;
        try {
          let row = q.get(
            "SELECT * FROM text_video_jobs WHERE tenant_id=? AND id=?",
            tid,
            id,
          );
          const assets = resolveJobAssets(row);
          const params = parseJson(row.params_json, {});
          let acceptRenderResult = true;
          const rendering = Promise.resolve().then(() =>
            renderer.render({
              tenantId: tid,
              jobId: id,
              title: row.title,
              body: row.body,
              mode: row.mode,
              imagePaths: assets.imagePaths,
              clipPaths: assets.clipPaths,
              allowSolidBackground: params.allowSolidBackground === true,
              voiceId: params.voiceId,
              bgm: params.bgm,
              signal: controller.signal,
              onStep: (event) => appendStep(id, event, now),
            }),
          );
          // A provider/runner bug must not defeat the hard deadline by ignoring
          // AbortSignal. If it eventually returns an artifact after the race was
          // lost, remove that unowned file instead of leaving a ghost delivery.
          void rendering.then(
            (late) => {
              if (!acceptRenderResult && late?.absolutePath) {
                void fsp.rm(late.absolutePath, { force: true }).catch(() => {});
              }
            },
            () => {},
          );
          try {
            rendered = await Promise.race([rendering, aborted]);
          } catch (error) {
            acceptRenderResult = false;
            throw error;
          }
          if (controller.signal.aborted) throw abortFailure();
          const evidence = renderBillingEvidence(rendered);
          row = q.get(
            "SELECT * FROM text_video_jobs WHERE tenant_id=? AND id=?",
            tid,
            id,
          );
          if (row?.status !== "running") {
            await fsp
              .rm(rendered.absolutePath, { force: true })
              .catch(() => {});
            throw failure("成片任务已取消", 499, "TEXT_VIDEO_CANCELLED");
          }
          appendStep(
            id,
            { phase: "persist", message: "真实MP4已生成，正在写入租户文件库" },
            now,
          );
          const file = await persistOutput(row, rendered);
          if (controller.signal.aborted) {
            await deleteOutput({ ...row, output_file_id: file.id });
            throw abortFailure();
          }
          const persisted = q.run(
            `UPDATE text_video_jobs SET script=?,output_file_id=?,result_url=?,
            result_sha256=?,result_bytes=?,duration_seconds=?,usage_json=?,cost_json=?,
            render_evidence_json=?,updated_at=?
            WHERE tenant_id=? AND id=? AND status='running'`,
            rendered.script,
            file.id,
            file.file_url,
            rendered.sha256,
            rendered.byteSize,
            rendered.probe.duration,
            jsonForStorage(evidence.usage),
            jsonForStorage(evidence.cost),
            jsonForStorage(rendered.evidence),
            nowIso(now),
            tid,
            id,
          );
          if (persisted.changes !== 1) {
            await deleteOutput({ ...row, output_file_id: file.id });
            throw failure("成片任务已取消", 499, "TEXT_VIDEO_CANCELLED");
          }
          row = q.get(
            "SELECT * FROM text_video_jobs WHERE tenant_id=? AND id=?",
            tid,
            id,
          );
          appendStep(
            id,
            {
              phase: "settle",
              message: "成片已落库，按真实调用与编码证据结算",
            },
            now,
          );
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
                "成片预授权账本缺失",
                409,
                "TEXT_VIDEO_BILLING_HOLD_MISSING",
              );
            }
            settlement = settleHold(hold, {
              credits: evidence.actualCredits,
              usage: evidence.usage,
              model: TEXT_VIDEO_BILLING_MODEL,
              aiMode: "api",
              note: `MP4已落库并通过SHA256与1080×1920/H264/AAC校验；真实网络调用${evidence.usage.networkRequests}次`,
            });
            if (!settlement) {
              throw failure(
                "成片结算状态发生变化",
                409,
                "TEXT_VIDEO_BILLING_SETTLEMENT_CONFLICT",
              );
            }
          }
          const completedAt = nowIso(now);
          const done = q.run(
            `UPDATE text_video_jobs SET status='done',billing_status=?,settled_credits=?,
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
              "成片交付终态冲突",
              409,
              "TEXT_VIDEO_FINALIZATION_CONFLICT",
            );
          }
          return publicJob(
            q.get(
              "SELECT * FROM text_video_jobs WHERE tenant_id=? AND id=?",
              tid,
              id,
            ),
          );
        } catch (error) {
          const row = q.get(
            "SELECT * FROM text_video_jobs WHERE tenant_id=? AND id=?",
            tid,
            id,
          );
          if (rendered?.absolutePath) {
            await fsp
              .rm(rendered.absolutePath, { force: true })
              .catch(() => {});
          }
          if (row?.status === "cancelled") {
            await deleteOutput(row);
            return publicJob(
              q.get(
                "SELECT * FROM text_video_jobs WHERE tenant_id=? AND id=?",
                tid,
                id,
              ),
            );
          }
          await failAndRefund(id, error);
          return publicJob(
            q.get(
              "SELECT * FROM text_video_jobs WHERE tenant_id=? AND id=?",
              tid,
              id,
            ),
          );
        } finally {
          clearTimeout(timeout);
          if (onAbort) controller.signal.removeEventListener("abort", onAbort);
        }
      } finally {
        if (acquired) slots.release();
        if (active.get(key) === controller) active.delete(key);
        scheduled.delete(key);
      }
    });
  }

  function schedule(jobId, tenantId = curTenant()) {
    const id = positiveId(jobId, "成片任务编号");
    const tid = positiveId(tenantId, "租户编号");
    const key = `${tid}:${id}`;
    if (scheduled.has(key) || active.has(key)) return false;
    scheduled.add(key);
    queueMicrotask(() => {
      void runJob(id, tid).catch((error) => {
        scheduled.delete(key);
        console.error(
          "[text-video] background failure",
          JSON.stringify({
            tenantId: tid,
            jobId: id,
            code: safeError(error).code,
          }),
        );
      });
    });
    return true;
  }

  async function cancelJob(user, jobId) {
    const row = authorizedJob(user, jobId);
    if (!["queued", "running"].includes(row.status)) {
      throw failure(
        "该成片任务已经结束，不能取消",
        409,
        "TEXT_VIDEO_NOT_CANCELABLE",
      );
    }
    const at = nowIso(now);
    const changed = q.run(
      `UPDATE text_video_jobs SET status='cancelled',error_code='TEXT_VIDEO_CANCELLED',
      error_message='用户已取消成片任务',cancelled_at=?,completed_at=?,updated_at=?
      WHERE tenant_id=? AND id=? AND status IN ('queued','running')`,
      at,
      at,
      at,
      row.tenant_id,
      row.id,
    );
    if (changed.changes !== 1) {
      throw failure(
        "任务状态刚刚发生变化，请刷新",
        409,
        "TEXT_VIDEO_STATE_CONFLICT",
      );
    }
    active.get(`${row.tenant_id}:${row.id}`)?.abort();
    let billingStatus = row.billing_status;
    if (row.billing_status === "held") {
      try {
        const hold = findHoldByRef(BILLING_REF, row.id, row.tenant_id);
        if (hold) releaseHold(hold, "用户取消成片任务，预授权全额退回");
        billingStatus = "released";
      } catch {
        billingStatus = "pending_reconciliation";
      }
    }
    await deleteOutput(row);
    q.run(
      `UPDATE text_video_jobs SET billing_status=?,output_file_id=NULL,result_url=NULL,
      result_sha256=NULL,result_bytes=NULL,updated_at=?
      WHERE tenant_id=? AND id=? AND status='cancelled'`,
      billingStatus,
      nowIso(now),
      row.tenant_id,
      row.id,
    );
    return publicJob(
      q.get(
        "SELECT * FROM text_video_jobs WHERE tenant_id=? AND id=?",
        row.tenant_id,
        row.id,
      ),
    );
  }

  async function retryJob(user, jobId) {
    const row = authorizedJob(user, jobId);
    if (
      row.status !== "failed" ||
      !["released", "included"].includes(row.billing_status)
    ) {
      throw failure(
        "只有已退款的失败任务可以免费重试",
        409,
        "TEXT_VIDEO_NOT_RETRYABLE",
      );
    }
    if (Number(row.retry_count || 0) >= TEXT_VIDEO_MAX_FREE_RETRIES) {
      throw failure(
        "免费重试次数已用完，请新建成片任务",
        429,
        "TEXT_VIDEO_RETRY_LIMIT",
      );
    }
    resolveJobAssets(row, user);
    await renderer.preflight({ tenantId: row.tenant_id, body: row.body });
    await deleteOutput(row);
    const changed = q.run(
      `UPDATE text_video_jobs SET status='queued',billing_status='included',
      retry_count=retry_count+1,progress=0,steps_json='[]',script=NULL,
      usage_json=NULL,cost_json=NULL,render_evidence_json=NULL,output_file_id=NULL,
      result_url=NULL,result_sha256=NULL,result_bytes=NULL,duration_seconds=NULL,
      error_code=NULL,error_message=NULL,timeout_at=NULL,started_at=NULL,
      completed_at=NULL,cancelled_at=NULL,updated_at=?
      WHERE tenant_id=? AND id=? AND status='failed'
        AND billing_status IN ('released','included') AND retry_count<?`,
      nowIso(now),
      row.tenant_id,
      row.id,
      TEXT_VIDEO_MAX_FREE_RETRIES,
    );
    if (changed.changes !== 1) {
      throw failure(
        "任务状态刚刚发生变化，请刷新",
        409,
        "TEXT_VIDEO_STATE_CONFLICT",
      );
    }
    appendStep(
      row.id,
      { phase: "queued", message: "免费重试已排队，本次不重复扣费" },
      now,
    );
    return publicJob(
      q.get(
        "SELECT * FROM text_video_jobs WHERE tenant_id=? AND id=?",
        row.tenant_id,
        row.id,
      ),
    );
  }

  function recoverTenant(tenantId) {
    const tid = positiveId(tenantId, "租户编号");
    return runWithTenant(tid, () => {
      const report = [];
      const rows = q.all(
        `SELECT * FROM text_video_jobs WHERE tenant_id=?
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
                "UPDATE text_video_jobs SET billing_status='held',held_credits=?,updated_at=? WHERE tenant_id=? AND id=? AND billing_status='pending'",
                hold.credits,
                nowIso(now),
                tid,
                row.id,
              );
              row = q.get(
                "SELECT * FROM text_video_jobs WHERE tenant_id=? AND id=?",
                tid,
                row.id,
              );
            } else {
              q.run(
                `UPDATE text_video_jobs SET status='failed',billing_status='released',
                error_code='TEXT_VIDEO_RECOVERY_NO_HOLD',
                error_message='服务重启前未完成预授权，未调用供应商',completed_at=?,updated_at=?
                WHERE tenant_id=? AND id=?`,
                nowIso(now),
                nowIso(now),
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
            const evidence = {
              usage: parseJson(row.usage_json),
              cost: parseJson(row.cost_json),
              actualCredits: billingCreditsForCost(
                parseJson(row.cost_json).amount,
              ),
            };
            if (row.billing_status === "held") {
              const hold = findHoldByRef(BILLING_REF, row.id, tid);
              const settlement = hold
                ? settleHold(hold, {
                    credits: evidence.actualCredits,
                    usage: evidence.usage,
                    model: TEXT_VIDEO_BILLING_MODEL,
                    aiMode: "api",
                    note: "启动恢复：已持久化成片按真实证据结算",
                  })
                : null;
              if (!settlement) throw new Error("missing settlement");
              q.run(
                `UPDATE text_video_jobs SET status='done',billing_status='settled',
                settled_credits=?,progress=100,completed_at=COALESCE(completed_at,?),updated_at=?
                WHERE tenant_id=? AND id=? AND status='running'`,
                settlement.credits,
                nowIso(now),
                nowIso(now),
                tid,
                row.id,
              );
            } else if (row.billing_status === "included") {
              q.run(
                `UPDATE text_video_jobs SET status='done',progress=100,
                completed_at=COALESCE(completed_at,?),updated_at=?
                WHERE tenant_id=? AND id=? AND status='running'`,
                nowIso(now),
                nowIso(now),
                tid,
                row.id,
              );
            } else {
              throw new Error("invalid recovery billing state");
            }
            report.push({ id: row.id, action: "finalized_persisted_output" });
            continue;
          }
          if (row.status === "running") {
            const hold = findHoldByRef(BILLING_REF, row.id, tid);
            if (hold) releaseHold(hold, "服务重启中断成片，预授权全额退回");
            q.run(
              `UPDATE text_video_jobs SET status='failed',billing_status='released',
              error_code='TEXT_VIDEO_RESTART_INTERRUPTED',
              error_message='服务重启中断渲染，预授权已退回，可免费重试',completed_at=?,updated_at=?
              WHERE tenant_id=? AND id=? AND status='running'`,
              nowIso(now),
              nowIso(now),
              tid,
              row.id,
            );
            report.push({ id: row.id, action: "released_interrupted" });
            continue;
          }
          if (TERMINAL.has(row.status) && row.billing_status === "held") {
            const hold = findHoldByRef(BILLING_REF, row.id, tid);
            if (hold) releaseHold(hold, "启动恢复终态成片任务，预授权全额退回");
            q.run(
              "UPDATE text_video_jobs SET billing_status='released',updated_at=? WHERE tenant_id=? AND id=?",
              nowIso(now),
              tid,
              row.id,
            );
            report.push({ id: row.id, action: "released_terminal" });
          }
        } catch (error) {
          const hold = findHoldByRef(BILLING_REF, row.id, tid);
          try {
            if (hold) releaseHold(hold, "成片恢复失败，预授权全额退回");
          } catch {
            // The row is marked reconciliation-only below when even the refund fails.
          }
          const stillHeld = Boolean(findHoldByRef(BILLING_REF, row.id, tid));
          q.run(
            `UPDATE text_video_jobs SET status='failed',billing_status=?,error_code=?,
            error_message=?,completed_at=?,updated_at=? WHERE tenant_id=? AND id=?`,
            stillHeld ? "pending_reconciliation" : "released",
            "TEXT_VIDEO_RECOVERY_FAILED",
            stillHeld
              ? "重启恢复失败，退款待账务对账"
              : "重启恢复失败，预授权已退回，可免费重试",
            nowIso(now),
            nowIso(now),
            tid,
            row.id,
          );
          report.push({
            id: row.id,
            action: stillHeld ? "pending_reconciliation" : "released_failed",
            code: safeError(error).code,
          });
        }
      }
      return report;
    });
  }

  function recoverAndSchedule({ tenantId = null } = {}) {
    const exists = q.get(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='text_video_jobs'",
    );
    if (!exists) return [];
    const tenants = tenantId
      ? [positiveId(tenantId, "租户编号")]
      : q
          .all(
            "SELECT DISTINCT tenant_id FROM text_video_jobs ORDER BY tenant_id",
          )
          .map((row) => Number(row.tenant_id));
    return tenants.flatMap((tid) => recoverTenant(tid));
  }

  return Object.freeze({
    createJob,
    listJobs,
    getJob,
    runJob,
    schedule,
    cancelJob,
    retryJob,
    recoverTenant,
    recoverAndSchedule,
    activeCount: () => slots.active(),
    waitingCount: () => slots.waiting(),
  });
}

export const textVideoJobService = createTextVideoJobService();

export default createTextVideoJobService;
