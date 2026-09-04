// 视频/图片样片库：销售在宣讲会现场可直接点开的样板。
//
// 数据落在 materials 表（追加列 is_sample / sample_tags / sample_note / sample_scope）：
// - sample_scope='platform'：平台级共享，由 platform_super 导入，所有租户可读；
// - sample_scope='tenant'  ：租户自有样片，严格按 tenant_id 隔离。
// materials 属于隔离表：平台级读取必须走显式 SQL（不能用 scopedAll），
// 写入平台样片走 qRaw.run 显式 tenant_id。
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { curTenant, q, qRaw } from "../db.js";
import { resolveFfprobe } from "./media-binaries.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SAMPLE_SCOPES = Object.freeze(["platform", "tenant"]);
export const SAMPLE_TYPES = Object.freeze(["video", "image"]);
export const SAMPLE_VIDEO_EXTS = Object.freeze(["mp4"]);
export const SAMPLE_IMAGE_EXTS = Object.freeze(["png", "jpg", "jpeg", "webp"]);
export const SAMPLE_MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const SAMPLE_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const SAMPLE_MAX_TAGS = 12;
export const SAMPLE_MAX_TAG_CHARS = 20;
export const SAMPLE_MAX_NOTE_CHARS = 2000;
export const SAMPLE_MAX_NAME_CHARS = 120;
export const SAMPLE_MAX_VIDEO_SECONDS = 15 * 60;
export const SAMPLE_IMPORT_ROLES = Object.freeze(["platform_super", "boss"]);
export const SAMPLE_UPLOAD_ROOT = process.env.NANOWORK_SAMPLE_UPLOAD_ROOT
  ? path.resolve(process.env.NANOWORK_SAMPLE_UPLOAD_ROOT)
  : path.resolve(__dirname, "..", "..", "data", "uploads", "samples");

const VIDEO_MATERIAL_TYPE = "视频";
const IMAGE_MATERIAL_TYPE = "海报";
const IMAGE_MATERIAL_TYPES = new Set(["海报", "产品图", "Logo", "图片"]);
const SAMPLE_SOURCE_TYPES = Object.freeze({
  uploaded_file: "sample_uploaded_file",
  media_job: "sample_media_job",
  material: "sample_material",
  script: "sample_script_import",
});

export class ContentSampleError extends Error {
  constructor(message, { status = 400, code = "CONTENT_SAMPLE_INVALID" } = {}) {
    super(message);
    this.name = "ContentSampleError";
    this.status = status;
    this.code = code;
  }
}

const failure = (message, status, code) => new ContentSampleError(message, { status, code });

// ---------- 纯函数：解析 / 规范化 ----------

export function normalizeSampleTags(input) {
  let raw = input;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text.startsWith("[")) {
      try {
        raw = JSON.parse(text);
      } catch {
        raw = text.slice(1, -1).split(/[，,、;；|]/u);
      }
    } else {
      raw = text.split(/[，,、;；|\n]/u);
    }
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const tags = [];
  for (const item of raw) {
    const tag = String(item ?? "")
      .replace(/[\u0000-\u001f\u007f]/gu, "")
      .trim()
      .slice(0, SAMPLE_MAX_TAG_CHARS);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= SAMPLE_MAX_TAGS) break;
  }
  return tags;
}

export function normalizeSampleNote(input) {
  return String(input ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\r\n?/gu, "\n")
    .trim()
    .slice(0, SAMPLE_MAX_NOTE_CHARS);
}

export function normalizeSampleName(input, fallback = "样片") {
  const name = String(input ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, SAMPLE_MAX_NAME_CHARS);
  return name || fallback;
}

export function normalizeSampleScope(input, { allowPlatform = false } = {}) {
  const scope = String(input || (allowPlatform ? "platform" : "tenant")).trim().toLowerCase();
  if (!SAMPLE_SCOPES.includes(scope)) throw failure("scope 仅支持 platform / tenant");
  if (scope === "platform" && !allowPlatform) {
    throw failure("只有平台超管可以导入平台级共享样片", 403, "CONTENT_SAMPLE_SCOPE_FORBIDDEN");
  }
  return scope;
}

export function sampleTypeForExt(ext) {
  const value = String(ext || "").toLowerCase().replace(/^\./u, "");
  if (SAMPLE_VIDEO_EXTS.includes(value)) return "video";
  if (SAMPLE_IMAGE_EXTS.includes(value)) return "image";
  return null;
}

export function sampleTypeForMaterialType(type) {
  const value = String(type || "");
  if (value === VIDEO_MATERIAL_TYPE) return "video";
  if (IMAGE_MATERIAL_TYPES.has(value)) return "image";
  return null;
}

export function materialTypeForSampleType(sampleType) {
  return sampleType === "video" ? VIDEO_MATERIAL_TYPE : IMAGE_MATERIAL_TYPE;
}

export function sampleMimeForExt(ext) {
  const value = String(ext || "").toLowerCase().replace(/^\./u, "");
  return {
    mp4: "video/mp4",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
  }[value] || "application/octet-stream";
}

/**
 * 从文件名解析样片元数据。约定：`名称[标签1,标签2].mp4`；方括号可省略。
 * 同名 .json（{ name, tags, note }）优先覆盖文件名解析结果。
 */
export function parseSampleFileMeta(fileName, sidecarJson = null) {
  const base = path.basename(String(fileName || ""));
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
  const stem = ext ? base.slice(0, -(ext.length + 1)) : base;
  const match = stem.match(/^(.*?)\s*[\[【]([^\]】]*)[\]】]\s*$/u);
  let name = normalizeSampleName(match ? match[1] : stem, stem || "样片");
  let tags = normalizeSampleTags(match ? match[2] : []);
  let note = "";
  let sidecar = null;
  if (sidecarJson !== null && sidecarJson !== undefined) {
    if (typeof sidecarJson === "string") {
      try {
        sidecar = JSON.parse(sidecarJson);
      } catch {
        throw failure(`${base} 的同名 .json 不是合法 JSON`);
      }
    } else if (typeof sidecarJson === "object") {
      sidecar = sidecarJson;
    }
  }
  if (sidecar && typeof sidecar === "object" && !Array.isArray(sidecar)) {
    if (sidecar.name) name = normalizeSampleName(sidecar.name, name);
    if (sidecar.tags !== undefined) tags = normalizeSampleTags(sidecar.tags);
    if (sidecar.note !== undefined) note = normalizeSampleNote(sidecar.note);
  }
  const type = sampleTypeForExt(ext);
  return { fileName: base, ext, name, tags, note, type };
}

export function validateSampleFileStat({ ext, size }) {
  const type = sampleTypeForExt(ext);
  if (!type) {
    throw failure(
      `不支持 .${ext || "?"}，样片只接受 ${[...SAMPLE_VIDEO_EXTS, ...SAMPLE_IMAGE_EXTS].map((item) => `.${item}`).join(" / ")}`,
      400,
      "CONTENT_SAMPLE_EXT_INVALID",
    );
  }
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) throw failure("样片文件为空", 400, "CONTENT_SAMPLE_EMPTY");
  const limit = type === "video" ? SAMPLE_MAX_VIDEO_BYTES : SAMPLE_MAX_IMAGE_BYTES;
  if (bytes > limit) {
    throw failure(
      `样片超过大小上限（${type === "video" ? "视频 200MB" : "图片 15MB"}）`,
      413,
      "CONTENT_SAMPLE_TOO_LARGE",
    );
  }
  return type;
}

export function parseFfprobeDuration(stdout) {
  let payload;
  try {
    payload = JSON.parse(String(stdout || ""));
  } catch {
    return null;
  }
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream?.codec_type === "video");
  const duration = Number(payload?.format?.duration ?? video?.duration);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    width: Number(video?.width) || null,
    height: Number(video?.height) || null,
    hasVideoStream: Boolean(video),
  };
}

export async function probeSampleVideo(filePath, { ffprobePath } = {}) {
  const binary = ffprobePath || resolveFfprobe();
  if (!binary) throw failure("未找到 ffprobe，无法校验视频时长", 503, "CONTENT_SAMPLE_FFPROBE_MISSING");
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      binary,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch {
    throw failure("ffprobe 无法读取该视频文件", 400, "CONTENT_SAMPLE_PROBE_FAILED");
  }
  const probe = parseFfprobeDuration(stdout);
  if (!probe?.hasVideoStream || !probe.duration) throw failure("视频缺少可用视频轨或时长", 400, "CONTENT_SAMPLE_PROBE_FAILED");
  if (probe.duration > SAMPLE_MAX_VIDEO_SECONDS) throw failure("样片时长超过 15 分钟上限", 400, "CONTENT_SAMPLE_TOO_LONG");
  return probe;
}

export function safeSampleFileName(name, ext) {
  const stem = String(name || "sample")
    .replace(/[^\w.\-\u4e00-\u9fa5]/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 80) || "sample";
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${stem}.${ext}`;
}

// ---------- 数据访问 ----------

function parseTags(value) {
  if (!value) return [];
  try {
    return normalizeSampleTags(JSON.parse(value));
  } catch {
    return normalizeSampleTags(value);
  }
}

function safeJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function projectSample(row, { tenantId = curTenant() } = {}) {
  if (!row) return null;
  const artifact = safeJson(row.artifact_snapshot_json, {}) || {};
  const scope = row.sample_scope === "platform" ? "platform" : "tenant";
  const type = sampleTypeForMaterialType(row.type) || artifact.sampleType || "video";
  return {
    id: Number(row.id),
    name: row.name || "",
    type,
    materialType: row.type || materialTypeForSampleType(type),
    url: row.url || "",
    mimeType: artifact.mimeType || sampleMimeForExt(String(row.url || "").split(".").pop()),
    tags: parseTags(row.sample_tags),
    note: row.sample_note || "",
    scope,
    ownTenant: Number(row.tenant_id) === Number(tenantId),
    durationSeconds: Number.isFinite(Number(artifact.durationSeconds)) ? Number(artifact.durationSeconds) : null,
    width: artifact.width || null,
    height: artifact.height || null,
    sourceType: row.source_type || null,
    sourceId: row.source_id == null ? null : Number(row.source_id),
    createdAt: row.created_at || null,
  };
}

export function sampleTypeClause(type) {
  if (type === "video") return { sql: `AND type = ?`, params: [VIDEO_MATERIAL_TYPE] };
  if (type === "image") {
    const list = [...IMAGE_MATERIAL_TYPES];
    return { sql: `AND type IN (${list.map(() => "?").join(",")})`, params: list };
  }
  return { sql: "", params: [] };
}

/**
 * 列出当前租户可见的样片：平台级 + 本租户自有。其他租户的自有样片绝不返回。
 */
export function listSamples({ tenantId = curTenant(), type = "", tag = "", limit = 200 } = {}) {
  const requestedType = String(type || "").trim().toLowerCase();
  if (requestedType && !SAMPLE_TYPES.includes(requestedType)) throw failure("type 仅支持 video / image");
  const clause = sampleTypeClause(requestedType);
  const rows = q.all(
    `SELECT * FROM materials
    WHERE is_sample = 1 AND (sample_scope = 'platform' OR tenant_id = ?) ${clause.sql}
    ORDER BY CASE WHEN tenant_id = ? THEN 0 ELSE 1 END, created_at DESC, id DESC
    LIMIT ?`,
    Number(tenantId),
    ...clause.params,
    Number(tenantId),
    Math.min(500, Math.max(1, Number(limit) || 200)),
  );
  const wanted = String(tag || "").trim();
  const items = rows
    .map((row) => projectSample(row, { tenantId }))
    .filter((item) => !wanted || item.tags.includes(wanted));
  const tagCounts = new Map();
  for (const item of items) {
    for (const value of item.tags) tagCounts.set(value, (tagCounts.get(value) || 0) + 1);
  }
  return {
    items,
    tags: [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hans-CN"))
      .map(([value, count]) => ({ tag: value, count })),
  };
}

export function getVisibleSample(id, { tenantId = curTenant() } = {}) {
  const sampleId = Number(id);
  if (!Number.isSafeInteger(sampleId) || sampleId <= 0) return null;
  const row = q.get(
    `SELECT * FROM materials
    WHERE id = ? AND is_sample = 1 AND (sample_scope = 'platform' OR tenant_id = ?)`,
    sampleId,
    Number(tenantId),
  );
  return row || null;
}

export function canManageSample(user, row) {
  const role = String(user?.role || "");
  if (role === "platform_super") return true;
  if (!SAMPLE_IMPORT_ROLES.includes(role)) return false;
  return row.sample_scope !== "platform" && Number(row.tenant_id) === Number(user?.tenant_id || curTenant());
}

export function canImportSample(user) {
  return SAMPLE_IMPORT_ROLES.includes(String(user?.role || ""));
}

/**
 * 写入一条新的样片素材；平台级与租户级都显式写 tenant_id（绕过自动注入的兜底）。
 */
export function insertSampleMaterial({
  tenantId,
  scope,
  creatorId = null,
  name,
  sampleType,
  url,
  tags = [],
  note = "",
  sourceType,
  sourceId = null,
  artifact = {},
}) {
  const type = SAMPLE_TYPES.includes(sampleType) ? sampleType : null;
  if (!type) throw failure("样片类型无效");
  const target = String(url || "").trim();
  if (!target.startsWith("/uploads/") && !/^https:\/\//iu.test(target)) {
    throw failure("样片地址必须是站内 /uploads/ 路径或 https 链接");
  }
  const tagList = normalizeSampleTags(tags);
  const snapshot = {
    kind: "content_sample",
    sampleType: type,
    mimeType: artifact.mimeType || sampleMimeForExt(target.split("?")[0].split(".").pop()),
    durationSeconds: artifact.durationSeconds ?? null,
    width: artifact.width ?? null,
    height: artifact.height ?? null,
    size: artifact.size ?? null,
    sha256: artifact.sha256 ?? null,
    origin: artifact.origin ?? sourceType,
    boundary: "样片仅供演示与风格参考；不是租户业务产物，不进入内容审批与账务链路。",
  };
  const result = qRaw.run(
    `INSERT INTO materials(
      tenant_id,name,type,tags,url,source_type,source_id,creator_id,note,
      artifact_snapshot_json,snapshot_hash,use_count,
      is_sample,sample_tags,sample_note,sample_scope
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,1,?,?,?)`,
    Number(tenantId),
    normalizeSampleName(name),
    materialTypeForSampleType(type),
    ["样片", scope === "platform" ? "平台样片" : "租户样片", ...tagList].join(","),
    target,
    sourceType,
    sourceId,
    creatorId,
    `样片库：${scope === "platform" ? "平台级共享" : "租户自有"}；来源=${sourceType}${sourceId ? `#${sourceId}` : ""}`,
    JSON.stringify(snapshot),
    crypto.createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex"),
    JSON.stringify(tagList),
    normalizeSampleNote(note),
    scope,
  );
  // 回读刚写入的行：主键 + 显式 tenant_id（平台样片的 tenant_id 为平台租户，同样显式约束）
  return q.get(`SELECT * FROM materials WHERE id = ? AND tenant_id = ?`, Number(result.lastInsertRowid), Number(tenantId));
}

/**
 * 把既有素材（本租户）标记为样片。作用域由调用方按角色决定。
 */
export function markMaterialAsSample(material, { scope, tags, note, name, sampleType, probe = {} }) {
  if (!SAMPLE_SCOPES.includes(scope)) throw failure("scope 仅支持 platform / tenant");
  const type = SAMPLE_TYPES.includes(sampleType) ? sampleType : sampleTypeForMaterialType(material.type);
  if (!type) throw failure("该素材不是视频或图片，不能作为样片", 409, "CONTENT_SAMPLE_SOURCE_TYPE_INVALID");
  const artifact = {
    ...(safeJson(material.artifact_snapshot_json, {}) || {}),
    sampleType: type,
    mimeType:
      (safeJson(material.artifact_snapshot_json, {}) || {}).mimeType ||
      sampleMimeForExt(String(material.url || "").split("?")[0].split(".").pop()),
    ...probe,
  };
  qRaw.run(
    `UPDATE materials
    SET is_sample = 1, sample_scope = ?, sample_tags = ?, sample_note = ?, name = ?, artifact_snapshot_json = ?
    WHERE id = ? AND tenant_id = ?`,
    scope,
    JSON.stringify(normalizeSampleTags(tags)),
    normalizeSampleNote(note),
    normalizeSampleName(name, material.name || "样片"),
    JSON.stringify(artifact),
    Number(material.id),
    Number(material.tenant_id),
  );
  return q.get(`SELECT * FROM materials WHERE id = ? AND tenant_id = ?`, Number(material.id), Number(material.tenant_id));
}

export function updateSample(row, { tags, note, name, enabled }) {
  const sets = [];
  const params = [];
  if (tags !== undefined) {
    sets.push("sample_tags = ?");
    params.push(JSON.stringify(normalizeSampleTags(tags)));
  }
  if (note !== undefined) {
    sets.push("sample_note = ?");
    params.push(normalizeSampleNote(note));
  }
  if (name !== undefined) {
    sets.push("name = ?");
    params.push(normalizeSampleName(name, row.name || "样片"));
  }
  if (enabled === false) {
    sets.push("is_sample = 0");
  }
  if (!sets.length) throw failure("没有可更新的字段（tags / note / name / enabled）");
  qRaw.run(`UPDATE materials SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`, ...params, Number(row.id), Number(row.tenant_id));
  return q.get(`SELECT * FROM materials WHERE id = ? AND tenant_id = ?`, Number(row.id), Number(row.tenant_id));
}

export { SAMPLE_SOURCE_TYPES };

/**
 * 脚本/服务端共用：把本地文件复制进受保护的 uploads/samples/<scope-dir>/ 并返回 URL。
 */
export function persistSampleFile({ sourcePath, scopeDir, name, ext, root = SAMPLE_UPLOAD_ROOT }) {
  if (!/^[a-z0-9_-]{1,40}$/iu.test(String(scopeDir || ""))) throw failure("样片目录名无效", 500, "CONTENT_SAMPLE_PATH_INVALID");
  const directory = path.resolve(root, scopeDir);
  if (!directory.startsWith(`${path.resolve(root)}${path.sep}`)) throw failure("样片目录越界", 500, "CONTENT_SAMPLE_PATH_INVALID");
  fs.mkdirSync(directory, { recursive: true });
  const storedName = safeSampleFileName(name, ext);
  const destination = path.join(directory, storedName);
  fs.copyFileSync(sourcePath, destination, fs.constants.COPYFILE_EXCL);
  const bytes = fs.readFileSync(destination);
  return {
    filePath: destination,
    url: `/uploads/samples/${scopeDir}/${encodeURIComponent(storedName)}`,
    size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}
