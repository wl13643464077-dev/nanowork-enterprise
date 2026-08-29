import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { q, curTenant } from "../db.js";
import { extractText, IMAGE_EXTS, ALLOWED_EXTS } from "./extract.js";
import { canAccessOwner, userScopeClause } from "./access.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..", "data", "uploads", "files");
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const FILE_ACCEPT = ALLOWED_EXTS.map((x) => `.${x}`).join(",");

function cleanBase64(raw = "") {
  return String(raw)
    .replace(/^data:[^;]+;base64,/, "")
    .replace(/\s/g, "");
}

export function decodeBase64File(raw, maxBytes = MAX_FILE_BYTES) {
  const encoded = cleanBase64(raw);
  if (
    encoded.length > Math.ceil((maxBytes * 4) / 3) + 8 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw Object.assign(new Error("文件编码无效或超过大小上限"), {
      status: 400,
    });
  }
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length)
    throw Object.assign(new Error("文件内容为空"), { status: 400 });
  if (buffer.length > maxBytes)
    throw Object.assign(new Error("文件超过大小上限"), { status: 400 });
  return buffer;
}

function safePart(value, fallback = "file") {
  const out = String(value || "")
    .replace(/[^\w.\-\u4e00-\u9fa5]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
  return out || fallback;
}

function publicFile(row) {
  if (!row) return null;
  const { file_path, extracted_text, ...safe } = row;
  return {
    ...safe,
    preview: String(extracted_text || "").slice(0, 1800),
    readable: !!String(extracted_text || "").trim(),
  };
}

export function saveUploadedFile({
  name,
  b64,
  mime = "",
  purpose = "chat",
  userId,
}) {
  const originalName = path.basename(String(name || ""));
  const ext = String(originalName.split(".").pop() || "").toLowerCase();
  if (!originalName || !ext)
    throw Object.assign(new Error("文件名与扩展名必填"), { status: 400 });
  if (!ALLOWED_EXTS.includes(ext))
    throw Object.assign(
      new Error(`不支持 .${ext}，可上传文档、表格、PDF及常用图片`),
      { status: 400 },
    );
  const buf = decodeBase64File(b64, MAX_FILE_BYTES);

  const safePurpose = safePart(purpose, "chat").replace(/\./g, "_");
  const dir = path.join(ROOT, String(curTenant()), safePurpose);
  fs.mkdirSync(dir, { recursive: true });
  const storedName = `${Date.now()}-${crypto.randomBytes(5).toString("hex")}-${safePart(originalName)}`;
  const abs = path.join(dir, storedName);
  try {
    fs.writeFileSync(abs, buf, { flag: "wx" });
    const fileUrl = `/uploads/files/${curTenant()}/${safePurpose}/${encodeURIComponent(storedName)}`;

    let extracted = null;
    let mode = IMAGE_EXTS.includes(ext) ? "待AI识图" : "仅存档";
    if (!IMAGE_EXTS.includes(ext)) {
      extracted = extractText(buf, ext);
      mode = extracted?.trim() ? "自动提取正文" : "仅存档（未识别正文）";
    }
    const ret = q.run(
      `INSERT INTO uploaded_files(user_id,name,stored_name,ext,mime,size,purpose,file_path,file_url,extracted_text,extract_mode)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      userId,
      originalName,
      storedName,
      ext,
      mime || "",
      buf.length,
      safePurpose,
      abs,
      fileUrl,
      extracted,
      mode,
    );
    return {
      row: q.get(
        `SELECT * FROM uploaded_files WHERE tenant_id=? AND id=?`,
        curTenant(),
        ret.lastInsertRowid,
      ),
      buffer: buf,
    };
  } catch (error) {
    try {
      fs.rmSync(abs, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}

export function readTenantUploadedFileByUrl({
  tenantId = curTenant(),
  fileUrl,
  maxBytes = MAX_FILE_BYTES,
} = {}) {
  const tid = Number(tenantId);
  const url = String(fileUrl || "").trim();
  const limit = Number(maxBytes);
  if (
    !Number.isSafeInteger(tid) ||
    tid <= 0 ||
    !url.startsWith(`/uploads/files/${tid}/`)
  ) {
    throw Object.assign(new Error("租户本地文件地址无效"), {
      status: 400,
      code: "UPLOADED_FILE_URL_INVALID",
    });
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError("本地文件读取上限无效");
  }
  const row = q.get(
    `SELECT id,tenant_id,file_path,file_url,mime,size FROM uploaded_files
      WHERE tenant_id=? AND file_url=?`,
    tid,
    url,
  );
  if (!row) {
    throw Object.assign(new Error("租户本地文件不存在"), {
      status: 404,
      code: "UPLOADED_FILE_NOT_FOUND",
    });
  }
  const tenantRoot = path.resolve(ROOT, String(tid));
  const absolute = path.resolve(String(row.file_path || ""));
  let resolvedRoot;
  let resolvedFile;
  try {
    resolvedRoot = fs.realpathSync(tenantRoot);
    resolvedFile = fs.realpathSync(absolute);
  } catch {
    throw Object.assign(new Error("租户本地文件已丢失"), {
      status: 404,
      code: "UPLOADED_FILE_NOT_FOUND",
    });
  }
  if (!resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw Object.assign(new Error("租户本地文件路径越界"), {
      status: 409,
      code: "UPLOADED_FILE_PATH_INVALID",
    });
  }
  const stat = fs.statSync(resolvedFile);
  if (
    !stat.isFile() ||
    stat.size <= 0 ||
    stat.size > limit ||
    Number(row.size || 0) !== stat.size
  ) {
    throw Object.assign(new Error("租户本地文件大小或类型不符合要求"), {
      status: 409,
      code: "UPLOADED_FILE_INTEGRITY_INVALID",
    });
  }
  const bytes = fs.readFileSync(resolvedFile);
  return {
    bytes,
    mimeType: String(row.mime || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase(),
    fileId: Number(row.id),
    fileUrl: row.file_url,
  };
}

export function updateFileExtraction(id, text, mode) {
  q.run(
    `UPDATE uploaded_files SET extracted_text=?,extract_mode=? WHERE tenant_id=? AND id=?`,
    text || "",
    mode || "已处理",
    curTenant(),
    id,
  );
  return q.get(
    `SELECT * FROM uploaded_files WHERE tenant_id=? AND id=?`,
    curTenant(),
    id,
  );
}

export function listFiles(user, { purpose, limit = 50 } = {}) {
  const scope = userScopeClause(user, "user_id");
  const params = [curTenant(), ...scope.params];
  let where = `tenant_id=?${scope.sql}`;
  if (purpose) {
    where += " AND purpose=?";
    params.push(String(purpose));
  }
  params.push(Math.min(100, Math.max(1, Number(limit) || 50)));
  return q
    .all(
      `SELECT * FROM uploaded_files WHERE ${where} ORDER BY id DESC LIMIT ?`,
      ...params,
    )
    .map(publicFile);
}

export function ownedFile(id, user, allowManager = true) {
  const row = q.get(
    `SELECT * FROM uploaded_files WHERE tenant_id=? AND id=?`,
    curTenant(),
    id,
  );
  if (!row) return null;
  if (Number(row.user_id) === Number(user.id)) return row;
  if (allowManager && canAccessOwner(user, row.user_id)) return row;
  return null;
}

export function resolveAttachments(ids, user, max = 6) {
  const unique = [
    ...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean)),
  ].slice(0, max);
  return unique
    .map((id) => ownedFile(id, user, true))
    .filter(Boolean)
    .map((row) => {
      const content = String(row.extracted_text || "").slice(0, 16000);
      let hashInput = Buffer.from(content, "utf8");
      if (!content && row.file_path && fs.existsSync(row.file_path)) {
        hashInput = fs.readFileSync(row.file_path);
      }
      return {
        id: row.id,
        name: row.name,
        ext: row.ext,
        url: row.file_url,
        size: Number(row.size || 0),
        content,
        contentSha256: crypto
          .createHash("sha256")
          .update(hashInput)
          .digest("hex"),
        readable: !!content.trim(),
      };
    });
}

export function resolveRequestedAttachments(ids, user, max = 6) {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids))
    throw Object.assign(new Error("文件列表格式不正确"), { status: 400 });
  const unique = [...new Set(ids.map(Number))];
  if (
    unique.length > max ||
    unique.some((id) => !Number.isInteger(id) || id <= 0)
  ) {
    throw Object.assign(new Error(`一次最多引用${max}个有效文件`), {
      status: 400,
    });
  }
  const files = resolveAttachments(unique, user, max);
  if (files.length !== unique.length)
    throw Object.assign(new Error("部分文件不存在或无权访问"), { status: 404 });
  return files;
}

export function attachmentRefsForStorage(attachments = []) {
  return (Array.isArray(attachments) ? attachments : []).map((file) => ({
    ...(Number.isInteger(Number(file?.id)) && Number(file.id) > 0
      ? { id: Number(file.id) }
      : {}),
    name: String(file?.name || "附件").slice(0, 200),
    ext: file?.ext ? String(file.ext).slice(0, 20) : undefined,
    url: file?.url ? String(file.url).slice(0, 1000) : undefined,
    readable: file?.readable !== false,
    contentSha256: /^[a-f0-9]{64}$/iu.test(String(file?.contentSha256 || ""))
      ? String(file.contentSha256).toLowerCase()
      : crypto
          .createHash("sha256")
          .update(String(file?.content || ""), "utf8")
          .digest("hex"),
    ...(!file?.id && typeof file?.content === "string"
      ? { content: file.content.slice(0, 16000) }
      : {}),
  }));
}

export function rehydrateMessageHistory(
  rows,
  user,
  { maxFiles = 12, maxChars = 30000 } = {},
) {
  let remainingFiles = maxFiles;
  let remainingChars = maxChars;
  const source = Array.isArray(rows) ? rows : [];
  const hydrated = new Array(source.length);
  // Spend the bounded attachment budget on the newest turns first. The result
  // remains chronological, but a long conversation cannot evict its latest file.
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const row = source[index];
    let refs = [];
    try {
      const parsed = JSON.parse(row?.attachments_json || "[]");
      refs = Array.isArray(parsed) ? parsed : [];
    } catch {
      refs = [];
    }
    const fragments = [];
    for (const ref of refs) {
      if (remainingFiles <= 0 || remainingChars <= 0) break;
      let name = String(ref?.name || "历史附件").slice(0, 200);
      let content = typeof ref?.content === "string" ? ref.content : "";
      if (!content && Number.isInteger(Number(ref?.id)) && Number(ref.id) > 0) {
        const file = ownedFile(Number(ref.id), user, true);
        if (!file) continue;
        name = String(file.name || name).slice(0, 200);
        content = String(file.extracted_text || "");
      }
      if (!content.trim()) continue;
      const excerpt = content.slice(0, Math.min(5000, remainingChars));
      fragments.push(`【历史附件·${name}】\n${excerpt}`);
      remainingFiles -= 1;
      remainingChars -= excerpt.length;
    }
    hydrated[index] = {
      role: row.role,
      content: `${String(row.content || "")}${fragments.length ? `\n${fragments.join("\n")}` : ""}`,
    };
  }
  return hydrated;
}

export function filePublic(row) {
  return publicFile(row);
}

export function isImageExt(ext) {
  return IMAGE_EXTS.includes(String(ext || "").toLowerCase());
}
