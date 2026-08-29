import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, q, curTenant, getTenantConfig } from "../db.js";
import { logOp, notify } from "../util.js";
import {
  precheck,
  estimateCallCredits,
  holdCredits,
  settleHold,
  releaseHold,
} from "../engines/credits.js";
import {
  executeHeldDelivery,
  withImmediateTransaction,
} from "../engines/two-phase-delivery.js";
import {
  saveUploadedFile,
  updateFileExtraction,
  listFiles,
  ownedFile,
  filePublic,
  isImageExt,
} from "../engines/filehub.js";
import { FILE_SKILLS } from "../engines/skillrun.js";
import { prepareRestaurantOutputForExport } from "../engines/restaurant-output-export.js";
import {
  loadAgentTaskSupersession,
  loadContentDeliveryState,
  loadContentEmployeeRunAuthority,
} from "../engines/delivery-state.js";
import * as yunwu from "../engines/yunwu.js";
import { canAccessOwner, userScopeClause } from "../engines/access.js";
import crypto from "node:crypto";
import { embedDoc } from "../engines/rag.js";

const r = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = process.env.NANOWORK_ARTIFACT_DIR
  ? path.resolve(process.env.NANOWORK_ARTIFACT_DIR)
  : path.join(__dirname, "..", "..", "data", "uploads", "artifacts");
const LEGACY_SKILL_ARTIFACT_DIR = path.join(
  __dirname,
  "..",
  "..",
  "data",
  "uploads",
  "skills",
);
const MANAGERS = new Set(["boss", "ops_director", "admin"]);
const AUTHORITATIVE_SOURCE_TYPES = new Set([
  "agent_task",
  "content_employee_run",
]);
const DEFAULT_SOURCE_FORMATS = ["pdf", "docx", "xlsx"];
export const SOURCE_ARTIFACT_RENDER_VERSION = "restaurant-readable-markdown/1";
const ARTIFACT_MIME_TYPES = Object.freeze({
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
});
const sourceArtifactLocks = new Map();

function safeName(value = "产出") {
  return (
    String(value)
      .replace(/[^\w\-\u4e00-\u9fa5]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 60) || "产出"
  );
}

function artifactForUser(id, user) {
  const row = q.get(
    `SELECT * FROM generated_artifacts WHERE tenant_id=? AND id=?`,
    curTenant(),
    id,
  );
  if (!row) return null;
  return canAccessOwner(user, row.user_id) ? row : null;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function supersededArtifactState(row) {
  if (String(row?.source_type || "") !== "agent_task") return null;
  return loadAgentTaskSupersession(row.source_id, { tenantId: curTenant() });
}

function agentTaskDraftState(row) {
  if (!row || !Number(row.output_id)) return true;
  const delivery = loadContentDeliveryState(row.output_id, {
    tenantId: curTenant(),
  });
  return !(
    String(row.task_status || row.status || "") === "已完成" &&
    ["可使用", "已发布"].includes(
      String(row.output_status || row.status || ""),
    ) &&
    delivery.eligible === true
  );
}

function contentEmployeeRunDraftState(row) {
  const authority = loadContentEmployeeRunAuthority(row?.id, {
    tenantId: curTenant(),
  });
  return !(
    String(row?.status || "") === "已完成" && authority.verified === true
  );
}

function authoritativeArtifactDraft(row) {
  const sourceType = String(row?.source_type || "");
  const sourceId = Number(row?.source_id);
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) return null;
  if (sourceType === "agent_task") {
    const task = q.get(`SELECT t.id,t.status task_status,t.output_id,
        c.status output_status
      FROM agent_tasks t
      LEFT JOIN contents c ON c.tenant_id=t.tenant_id AND c.id=t.output_id
      WHERE t.tenant_id=? AND t.id=?`, curTenant(), sourceId);
    return task ? agentTaskDraftState(task) : null;
  }
  if (sourceType === "content_employee_run") {
    const run = q.get(`SELECT id,status FROM content_employee_runs
      WHERE tenant_id=? AND id=?`, curTenant(), sourceId);
    return run ? contentEmployeeRunDraftState(run) : null;
  }
  return null;
}

function supersededHttpError(supersededBy) {
  return Object.assign(
    new Error(
      `旧报告已由安全修订任务 #${supersededBy.taskId} 取代，请使用修订版文件`,
    ),
    {
      status: 409,
      code: "DELIVERY_SUPERSEDED",
      supersededBy,
    },
  );
}

function errorPayload(error) {
  return {
    error: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(error.supersededBy ? { supersededBy: error.supersededBy } : {}),
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function prepareAuthoritativeSourceBody(
  sourceType,
  rawBody,
  fallbackTitle = "",
  requirement = "",
) {
  const original =
    typeof rawBody === "string" ? rawBody : String(rawBody ?? "");
  if (sourceType !== "agent_task") {
    return {
      body: original,
      rawSourceHash: sha256(original),
      sourceHash: sha256(original),
      renderVersion: null,
      sourceBodyKind: "markdown_or_text",
      transformed: false,
    };
  }

  const prepared = prepareRestaurantOutputForExport(original, {
    title: fallbackTitle,
    requirement,
  });
  const rawSourceHash = sha256(original);
  if (!prepared.candidate) {
    // prepared.body 已剥掉机读归档块（若有）；导出文件用剥净正文并按其哈希缓存。
    return {
      body: prepared.body,
      rawSourceHash,
      sourceHash: sha256(prepared.body),
      renderVersion: null,
      sourceBodyKind: "markdown_or_text",
      transformed: false,
    };
  }

  return {
    body: prepared.body,
    rawSourceHash,
    sourceHash: sha256(`${SOURCE_ARTIFACT_RENDER_VERSION}\0${prepared.body}`),
    renderVersion: SOURCE_ARTIFACT_RENDER_VERSION,
    sourceBodyKind: prepared.transformed
      ? "restaurant_structured_json"
      : "restaurant_structured_json_fallback",
    transformed: prepared.transformed,
  };
}

function parseArtifactMetadata(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function normalizeSourceType(value) {
  const type = String(value || "").trim();
  if (!AUTHORITATIVE_SOURCE_TYPES.has(type)) {
    throw httpError(
      400,
      "仅支持从餐饮数字员工任务或内容数字员工运行产出交付文件",
    );
  }
  return type;
}

function normalizeSourceId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw httpError(400, "产出来源ID无效");
  return id;
}

function resolveArtifactSource(
  sourceType,
  sourceId,
  user,
  { requireBody = true } = {},
) {
  const type = normalizeSourceType(sourceType);
  const id = normalizeSourceId(sourceId);
  let row;
  let source;
  if (type === "agent_task") {
    row = q.get(
      `SELECT t.id,t.title,t.requirement,t.status task_status,t.created_by,t.output_id,t.created_at AS updated_at,
      c.title AS output_title,c.body AS output_body,c.status AS output_status
      FROM agent_tasks t
      LEFT JOIN contents c ON c.tenant_id=t.tenant_id AND c.id=t.output_id
      WHERE t.tenant_id=? AND t.id=?`,
      curTenant(),
      id,
    );
    if (row) {
      const supersededBy = loadAgentTaskSupersession(id, {
        tenantId: curTenant(),
      });
      if (supersededBy) throw supersededHttpError(supersededBy);
      source = {
        type,
        id,
        ownerId: Number(row.created_by),
        title: String(row.output_title || row.title || "餐饮数字员工报告")
          .trim()
          .slice(0, 100),
        requirement: String(row.requirement || "").trim(),
        body: String(row.output_body || ""),
        status: String(row.output_status || row.task_status || ""),
        draft: agentTaskDraftState(row),
        updatedAt: row.updated_at || null,
      };
    }
  } else {
    row = q.get(
      `SELECT id,title,status,result_md,created_by,updated_at
      FROM content_employee_runs WHERE tenant_id=? AND id=?`,
      curTenant(),
      id,
    );
    if (row) {
      source = {
        type,
        id,
        ownerId: Number(row.created_by),
        title: String(row.title || "内容数字员工报告")
          .trim()
          .slice(0, 100),
        body: String(row.result_md || ""),
        status: String(row.status || ""),
        draft: contentEmployeeRunDraftState(row),
        updatedAt: row.updated_at || null,
      };
    }
  }
  if (!source || !source.ownerId || !canAccessOwner(user, source.ownerId)) {
    throw httpError(404, "产出来源不存在或无权访问");
  }
  if (requireBody && !source.body.trim()) {
    throw httpError(409, "数字员工尚未生成可交付的真实报告正文");
  }
  const prepared = prepareAuthoritativeSourceBody(
    source.type,
    source.body,
    source.title,
    source.requirement,
  );
  return {
    ...source,
    ...prepared,
    sourceHash: source.body ? prepared.sourceHash : null,
  };
}

function normalizeFormats(body = {}) {
  const requested = Array.isArray(body.formats)
    ? body.formats
    : body.format
      ? [body.format]
      : DEFAULT_SOURCE_FORMATS;
  const formats = [
    ...new Set(
      requested
        .map((value) =>
          String(value || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ];
  if (
    !formats.length ||
    formats.some((format) => !Object.hasOwn(FILE_SKILLS, format))
  ) {
    throw httpError(400, "支持生成 Word、PDF、Excel 和 PPT 文件");
  }
  return formats;
}

function sourcePublic(source) {
  return {
    sourceType: source.type,
    sourceId: source.id,
    title: source.title,
    ...(source.type === "agent_task"
      ? { requirement: source.requirement || "" }
      : {}),
    status: source.status,
    sourceHash: source.sourceHash,
    rawSourceHash: source.rawSourceHash,
    renderVersion: source.renderVersion,
    sourceBodyKind: source.sourceBodyKind,
    draft: source.draft !== false,
    updatedAt: source.updatedAt,
  };
}

function artifactFilePath(row) {
  const legacySkill = String(row?.file_url || "").startsWith(
    `/uploads/skills/${curTenant()}/`,
  );
  const root = legacySkill ? LEGACY_SKILL_ARTIFACT_DIR : ARTIFACT_DIR;
  const tenantDir = path.resolve(root, String(curTenant()));
  const fileName = String(row?.file_name || "");
  if (!fileName || fileName !== path.basename(fileName)) return null;
  const resolved = path.resolve(tenantDir, fileName);
  if (!resolved.startsWith(`${tenantDir}${path.sep}`)) return null;
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { path: resolved, stat };
  } catch {
    return null;
  }
}

function deliverablePublic(row, { reused = false, source = null } = {}) {
  const metadata = parseArtifactMetadata(row.metadata);
  const format = String(row.format || "");
  const supersededBy = supersededArtifactState(row);
  const authoritativeDraft =
    source &&
    source.type === row.source_type &&
    Number(source.id) === Number(row.source_id)
      ? source.draft !== false
      : authoritativeArtifactDraft(row);
  return {
    id: Number(row.id),
    title: row.title,
    format,
    label: Object.hasOwn(FILE_SKILLS, format)
      ? FILE_SKILLS[format].label
      : format.toUpperCase(),
    mime: ARTIFACT_MIME_TYPES[format] || "application/octet-stream",
    fileName: row.file_name,
    size: Number(metadata.size || 0),
    sha256: metadata.sha256 || null,
    sourceHash: metadata.sourceHash || null,
    rawSourceHash: metadata.rawSourceHash || null,
    renderVersion: metadata.renderVersion || null,
    artifactRenderVersion: metadata.artifactRenderVersion || null,
    sourceBodyKind: metadata.sourceBodyKind || null,
    sourceType: row.source_type || null,
    sourceId: row.source_id == null ? null : Number(row.source_id),
    status: supersededBy ? "superseded" : "ready",
    draft:
      typeof authoritativeDraft === "boolean"
        ? authoritativeDraft
        : metadata.draft !== false,
    reused,
    downloadUrl: supersededBy
      ? null
      : `/api/files/artifacts/${row.id}/download`,
    ...(supersededBy ? { supersededBy } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function synchronizeArtifactDraftMetadata(row, source) {
  const metadata = parseArtifactMetadata(row.metadata);
  const draft = source.draft !== false;
  if (metadata.draft === draft) return row;
  const nextMetadata = JSON.stringify({ ...metadata, draft });
  const priorMetadata = String(row.metadata || "");
  const updated = q.run(`UPDATE generated_artifacts
    SET metadata=?,updated_at=datetime('now','localtime')
    WHERE tenant_id=? AND id=? AND COALESCE(metadata,'')=?`,
  nextMetadata, curTenant(), row.id, priorMetadata);
  if (Number(updated.changes || 0) > 0) {
    return { ...row, metadata: nextMetadata };
  }
  return q.get(`SELECT * FROM generated_artifacts
    WHERE tenant_id=? AND id=?`, curTenant(), row.id) || row;
}

function matchingSourceArtifact(source, format) {
  const rows = q.all(
    `SELECT * FROM generated_artifacts
    WHERE tenant_id=? AND user_id=? AND source_type=? AND source_id=? AND format=?
    ORDER BY id DESC`,
    curTenant(),
    source.ownerId,
    source.type,
    source.id,
    format,
  );
  return (
    rows.find((row) => {
      const metadata = parseArtifactMetadata(row.metadata);
      return (
        metadataMatchesSource(metadata, source, format) && artifactFilePath(row)
      );
    }) || null
  );
}

function metadataMatchesSource(metadata, source, format) {
  const artifactRenderVersion = FILE_SKILLS[format]?.renderVersion || null;
  return (
    metadata.sourceHash === source.sourceHash &&
    (!source.renderVersion || metadata.renderVersion === source.renderVersion) &&
    (!artifactRenderVersion ||
      metadata.artifactRenderVersion === artifactRenderVersion)
  );
}

async function withSourceArtifactLock(key, operation) {
  const previous = sourceArtifactLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  sourceArtifactLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (sourceArtifactLocks.get(key) === current)
      sourceArtifactLocks.delete(key);
  }
}

async function ensureSourceArtifact(source, format) {
  const skill = FILE_SKILLS[format];
  const lockKey = [
    curTenant(),
    source.type,
    source.id,
    source.sourceHash,
    format,
    skill.renderVersion || "default",
  ].join(":");
  return withSourceArtifactLock(lockKey, async () => {
    const existing = matchingSourceArtifact(source, format);
    if (existing) {
      const synchronized = synchronizeArtifactDraftMetadata(existing, source);
      return deliverablePublic(synchronized, { reused: true, source });
    }

    const body = source.body;
    // 传完整标题：渲染器各自负责页眉截断与省略号；这里再切60字只会
    // 制造“……驾车3”式的拦腰断句。
    const buf = await skill.fn(body, source.title);
    if (!Buffer.isBuffer(buf) || !buf.length)
      throw httpError(500, `${skill.label}文件生成失败`);
    const tenantDir = path.join(ARTIFACT_DIR, String(curTenant()));
    fs.mkdirSync(tenantDir, { recursive: true, mode: 0o700 });
    const fileName = `${safeName(source.title)}_${source.type}_${source.id}_${source.sourceHash.slice(0, 12)}_${crypto.randomBytes(4).toString("hex")}.${skill.ext}`;
    const filePath = path.join(tenantDir, fileName);
    const fileUrl = `/uploads/artifacts/${curTenant()}/${encodeURIComponent(fileName)}`;
    const fileSha256 = sha256(buf);
    const metadata = {
      schemaVersion: "nanowork.source-artifact/2",
      size: buf.length,
      mime: ARTIFACT_MIME_TYPES[format] || "application/octet-stream",
      sha256: fileSha256,
      sourceHash: source.sourceHash,
      rawSourceHash: source.rawSourceHash,
      renderVersion: source.renderVersion,
      artifactRenderVersion: skill.renderVersion || null,
      sourceBodyKind: source.sourceBodyKind,
      sourceType: source.type,
      sourceId: source.id,
      sourceStatus: source.status,
      generatedFrom: "authoritative_source",
      draft: source.draft !== false,
    };
    let inserted;
    try {
      fs.writeFileSync(filePath, buf, { flag: "wx", mode: 0o600 });
      inserted = q.run(
        `INSERT INTO generated_artifacts(
        user_id,source_type,source_id,title,format,content,file_url,file_name,status,metadata
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        source.ownerId,
        source.type,
        source.id,
        source.title,
        format,
        body,
        fileUrl,
        fileName,
        "可用",
        JSON.stringify(metadata),
      );
    } catch (error) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        /* best-effort cleanup */
      }
      throw error;
    }
    const row = q.get(
      `SELECT * FROM generated_artifacts WHERE tenant_id=? AND id=?`,
      curTenant(),
      inserted.lastInsertRowid,
    );
    return deliverablePublic(row, { source });
  });
}

async function generateSourceDeliverables(req, res) {
  try {
    const sourceType = req.params.sourceType || req.body?.sourceType;
    const sourceId = req.params.sourceId || req.body?.sourceId;
    const source = resolveArtifactSource(sourceType, sourceId, req.user);
    const formats = normalizeFormats(req.body || {});
    const deliverables = [];
    for (const format of formats)
      deliverables.push(await ensureSourceArtifact(source, format));
    logOp(
      req.user,
      "产出档案",
      "生成数字员工交付文件",
      `${source.type}#${source.id} / ${formats.join(",")}`,
    );
    res.json({ source: sourcePublic(source), deliverables });
  } catch (error) {
    res.status(error.status || 500).json(errorPayload(error));
  }
}

r.post("/upload", async (req, res) => {
  try {
    const {
      name,
      b64,
      mime,
      purpose = "chat",
      recognize = true,
    } = req.body || {};
    if (!name || !b64)
      return res.status(400).json({ error: "请选择要上传的文件" });
    const saved = saveUploadedFile({
      name,
      b64,
      mime,
      purpose,
      userId: req.user.id,
    });
    let row = saved.row;
    let billing = null;
    if (isImageExt(row.ext) && recognize !== false) {
      try {
        if (!yunwu.yunwuAvailable()) {
          throw Object.assign(new Error("识图通道未配置"), { status: 503 });
        }
        const holdModel = yunwu.routing().vision;
        precheck(req.user.id, "text", holdModel);
        const hold = holdCredits({
          userId: req.user.id,
          feature: "文件中心·图片识别",
          kind: "text",
          model: holdModel,
          credits: estimateCallCredits({
            kind: "text",
            model: holdModel,
            texts: [row.name],
            outputTokens: 1600,
            // 视觉模型的图片 token 不等于 base64 长度；按文件体积给出保守占扣，
            // 同时设置上限避免大图在请求线程分配巨量临时字符串。
            overheadTokens: Math.min(
              100000,
              Math.max(6000, Math.ceil(saved.buffer.length / 2)),
            ),
          }),
          refType: "uploaded_file_vision",
          refId: Number(row.id),
          note: `文件#${row.id}图片识别在供应商调用前预授权；正文未落库则全额退回。`,
        });
        const imageMime = row.ext === "jpg" ? "jpeg" : row.ext;
        const delivered = await executeHeldDelivery({
          hold,
          generate: () =>
            yunwu.chat({
              model: holdModel,
              system:
                "你是企业资料识别助手。完整读取图片中的文字、表格、产品、流程和关键数据，按“图片说明、识别内容、可引用字段”输出。不得臆造看不清的信息。",
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: `文件名：${row.name}。请提取这张图片中可供后续对话引用的全部信息。`,
                    },
                    {
                      type: "image_url",
                      image_url: {
                        url: `data:image/${imageMime};base64,${saved.buffer.toString("base64")}`,
                      },
                    },
                  ],
                },
              ],
              maxTokens: 1600,
            }),
          persist: (out) =>
            withImmediateTransaction(db, () =>
              updateFileExtraction(row.id, out.text, `AI识图（${out.model}）`),
            ),
          settle: settleHold,
          release: releaseHold,
          settlement: (out) => ({
            usage: {
              inputTokens: out.inputTokens,
              outputTokens: out.outputTokens,
            },
            model: out.model,
            aiMode: "api",
            note: "图片识别正文已完成业务落库",
          }),
          requirePositiveApiUsage: true,
          releaseNote: "图片识别生成或正文落库失败，预授权全额退回",
        });
        billing = delivered.billing;
        row = delivered.delivery;
      } catch (e) {
        row = updateFileExtraction(row.id, "", "图片已存档·识图待重试");
        billing = e.billing || null;
      }
    }
    logOp(
      req.user,
      "文件中心",
      "上传并读取文件",
      `${row.name} / ${row.extract_mode}`,
    );
    res.json({ file: filePublic(row), billing });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

r.get("/", (req, res) => {
  res.json(
    listFiles(req.user, { purpose: req.query.purpose, limit: req.query.limit }),
  );
});

r.get("/artifacts", (req, res) => {
  try {
    const scope =
      req.query.mine === "1"
        ? { sql: " AND user_id=?", params: [req.user.id] }
        : userScopeClause(req.user, "user_id");
    const params = [curTenant(), ...scope.params];
    let filters = scope.sql;
    const sourceType = req.query.sourceType || req.query.source_type;
    const sourceId = req.query.sourceId || req.query.source_id;
    if ((sourceType && !sourceId) || (!sourceType && sourceId)) {
      throw httpError(400, "筛选产出时需同时提供 sourceType 和 sourceId");
    }
    if (sourceType && sourceId) {
      const source = resolveArtifactSource(sourceType, sourceId, req.user, {
        requireBody: false,
      });
      filters += " AND source_type=? AND source_id=?";
      params.push(source.type, source.id);
    }
    if (req.query.q) {
      filters += " AND (title LIKE ? OR content LIKE ?)";
      params.push(`%${req.query.q}%`, `%${req.query.q}%`);
    }
    const rows = q.all(
      `SELECT id,user_id,source_type,source_id,title,format,file_url,file_name,status,kb_doc_id,metadata,created_at,updated_at
      FROM generated_artifacts WHERE tenant_id=?${filters} ORDER BY id DESC LIMIT 100`,
      ...params,
    );
    res.json(
      rows.map((row) => {
        const deliverable = deliverablePublic(row);
        if (deliverable.status !== "superseded") {
          return { ...row, deliverable };
        }
        const { file_url: _privateFileUrl, ...safeRow } = row;
        return { ...safeRow, deliverable };
      }),
    );
  } catch (error) {
    res.status(error.status || 500).json(errorPayload(error));
  }
});

r.get("/artifacts/source/:sourceType/:sourceId", (req, res) => {
  try {
    const source = resolveArtifactSource(
      req.params.sourceType,
      req.params.sourceId,
      req.user,
    );
    const rows = q.all(
      `SELECT * FROM generated_artifacts
      WHERE tenant_id=? AND user_id=? AND source_type=? AND source_id=? ORDER BY id DESC`,
      curTenant(),
      source.ownerId,
      source.type,
      source.id,
    );
    const deliverables = rows
      .filter((row) =>
        metadataMatchesSource(
          parseArtifactMetadata(row.metadata),
          source,
          row.format,
        ),
      )
      .filter((row) => artifactFilePath(row))
      .map((row) =>
        synchronizeArtifactDraftMetadata(row, source),
      )
      .map((row) => deliverablePublic(row, { reused: true, source }));
    res.json({ source: sourcePublic(source), deliverables });
  } catch (error) {
    res.status(error.status || 500).json(errorPayload(error));
  }
});

r.post("/artifacts/source", generateSourceDeliverables);
r.post("/artifacts/from-source", generateSourceDeliverables);
r.post("/artifacts/source/:sourceType/:sourceId", generateSourceDeliverables);

r.post("/artifacts/generate", async (req, res) => {
  try {
    const {
      title = "AI产出",
      format = "docx",
      content,
      sourceType = "manual",
      sourceId,
    } = req.body || {};
    const skill = Object.hasOwn(FILE_SKILLS, format)
      ? FILE_SKILLS[format]
      : null;
    if (!skill)
      return res
        .status(400)
        .json({ error: "支持生成 Word、PDF、Excel 和 PPT 文件" });
    if (!String(content || "").trim())
      return res.status(400).json({ error: "没有可生成文件的内容" });
    if (String(sourceType || "") === "agent_task") {
      resolveArtifactSource(sourceType, sourceId, req.user, {
        requireBody: false,
      });
    }
    const body = String(content).slice(0, 120000);
    const buf = await skill.fn(body, String(title).slice(0, 60));
    const dir = path.join(ARTIFACT_DIR, String(curTenant()));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fileName = `${safeName(title)}_${Date.now()}_${crypto.randomBytes(5).toString("hex")}.${skill.ext}`;
    const filePath = path.join(dir, fileName);
    const fileUrl = `/uploads/artifacts/${curTenant()}/${encodeURIComponent(fileName)}`;
    let out;
    try {
      fs.writeFileSync(filePath, buf, { flag: "wx", mode: 0o600 });
      const bodyHash = sha256(body);
      const fileHash = sha256(buf);
      out = q.run(
        `INSERT INTO generated_artifacts(user_id,source_type,source_id,title,format,content,file_url,file_name,metadata)
        VALUES(?,?,?,?,?,?,?,?,?)`,
        req.user.id,
        String(sourceType).slice(0, 40),
        sourceId || null,
        String(title).slice(0, 100),
        format,
        body,
        fileUrl,
        fileName,
        JSON.stringify({
          schemaVersion: "nanowork.artifact/1",
          size: buf.length,
          mime: ARTIFACT_MIME_TYPES[format] || "application/octet-stream",
          sha256: fileHash,
          sourceHash: bodyHash,
        }),
      );
    } catch (error) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        /* best-effort cleanup */
      }
      throw error;
    }
    logOp(
      req.user,
      "产出档案",
      `生成${skill.label}`,
      String(title).slice(0, 80),
    );
    const row = q.get(
      `SELECT * FROM generated_artifacts WHERE tenant_id=? AND id=?`,
      curTenant(),
      out.lastInsertRowid,
    );
    res.json({
      id: out.lastInsertRowid,
      title,
      format,
      fileUrl,
      fileName,
      size: buf.length,
      downloadUrl: `/api/files/artifacts/${out.lastInsertRowid}/download`,
      deliverable: deliverablePublic(row),
    });
  } catch (e) {
    res.status(e.status || 500).json(errorPayload(e));
  }
});

r.get("/artifacts/:id/download", (req, res) => {
  const artifact = artifactForUser(req.params.id, req.user);
  if (!artifact) return res.status(404).json({ error: "产出不存在或无权访问" });
  const supersededBy = supersededArtifactState(artifact);
  if (supersededBy) {
    const error = supersededHttpError(supersededBy);
    return res.status(error.status).json(errorPayload(error));
  }
  const file = artifactFilePath(artifact);
  if (!file) return res.status(404).json({ error: "产出文件不存在" });
  const mime =
    ARTIFACT_MIME_TYPES[artifact.format] || "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Length", file.stat.size);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.download(file.path, artifact.file_name, (error) => {
    if (error && !res.headersSent)
      res.status(error.status || 500).json({ error: "产出文件下载失败" });
  });
});

r.post("/artifacts/:id/archive", (req, res) => {
  const artifact = artifactForUser(req.params.id, req.user);
  if (!artifact) return res.status(404).json({ error: "产出不存在或无权访问" });
  const supersededBy = supersededArtifactState(artifact);
  if (supersededBy) {
    const error = supersededHttpError(supersededBy);
    return res.status(error.status).json(errorPayload(error));
  }
  if (artifact.kb_doc_id) {
    const linked = q.get(
      `SELECT id FROM kb_docs WHERE tenant_id=? AND id=?`,
      curTenant(),
      artifact.kb_doc_id,
    );
    if (linked)
      return res.json({ ok: true, kbDocId: linked.id, alreadyArchived: true });
    q.run(
      `UPDATE generated_artifacts SET kb_doc_id=NULL,status='可用',updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?`,
      curTenant(),
      artifact.id,
    );
  }
  const category =
    String(req.body?.category || "员工产出")
      .trim()
      .slice(0, 40) || "员工产出";
  const enabled = MANAGERS.has(req.user.role) ? 1 : 0;
  let kb;
  try {
    db.exec("BEGIN IMMEDIATE");
    const fresh = q.get(
      `SELECT kb_doc_id FROM generated_artifacts WHERE tenant_id=? AND id=?`,
      curTenant(),
      artifact.id,
    );
    if (fresh?.kb_doc_id) {
      db.exec("COMMIT");
      return res.json({
        ok: true,
        kbDocId: fresh.kb_doc_id,
        alreadyArchived: true,
      });
    }
    kb = q.run(
      `INSERT INTO kb_docs(category,title,body,enabled,file_path,file_type,file_name) VALUES(?,?,?,?,?,?,?)`,
      category,
      artifact.title,
      artifact.content || `产出文件：${artifact.file_name}`,
      enabled,
      artifact.file_url,
      artifact.format,
      artifact.file_name,
    );
    q.run(
      `UPDATE generated_artifacts SET status='已入档',kb_doc_id=?,updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?`,
      kb.lastInsertRowid,
      curTenant(),
      artifact.id,
    );
    q.run(
      `INSERT INTO biz_assets(name,category,value,status,owner,source_type,source_id,creator_id,url,note)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
      artifact.title,
      "知识资产",
      3000,
      "使用中",
      "产出档案",
      "kb",
      kb.lastInsertRowid,
      req.user.id,
      artifact.file_url,
      `AI产出入档；格式=${artifact.format}；入档人=${req.user.name}`,
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* transaction already closed */
    }
    return res.status(500).json({ error: error.message });
  }
  embedDoc(
    kb.lastInsertRowid,
    artifact.title,
    artifact.content || artifact.file_name,
  );
  if (!enabled) {
    for (const u of q.all(
      `SELECT id FROM users WHERE tenant_id=? AND role IN ('boss','ops_director','admin')`,
      curTenant(),
    )) {
      notify(
        u.id,
        "知识库",
        `员工产出待启用：${artifact.title}`,
        `${req.user.name} 已将AI产出入档，审核启用后可被AI调用`,
      );
    }
  }
  logOp(req.user, "产出档案", "入档知识库", artifact.title);
  res.json({ ok: true, kbDocId: kb.lastInsertRowid, enabled });
});

r.post("/:id/archive", (req, res) => {
  const file = ownedFile(req.params.id, req.user, true);
  if (!file) return res.status(404).json({ error: "文件不存在或无权访问" });
  const body = String(file.extracted_text || "").trim();
  if (!body)
    return res
      .status(400)
      .json({ error: "该文件尚未提取到可读正文，暂不能入档知识库" });
  const category = String(req.body?.category || "品牌资料").trim();
  const categories = getTenantConfig("kb_categories", [
    "品牌资料",
    "招商政策",
    "产品资料",
    "话术案例",
    "客户画像",
    "数据规范",
    "员工产出",
  ]);
  if (
    !category ||
    category.length > 60 ||
    !Array.isArray(categories) ||
    !categories.includes(category)
  ) {
    return res.status(400).json({ error: "请选择本企业已配置的知识库分类" });
  }
  const title = String(file.name || "上传资料")
    .replace(/\.[^.]+$/, "")
    .slice(0, 100);
  const enabled = MANAGERS.has(req.user.role) ? 1 : 0;
  let kbDocId;
  try {
    db.exec("BEGIN IMMEDIATE");
    const existing = q.get(
      `SELECT id FROM kb_docs WHERE tenant_id=? AND file_path=? LIMIT 1`,
      curTenant(),
      file.file_url,
    );
    if (existing) {
      db.exec("COMMIT");
      return res.json({
        ok: true,
        kbDocId: existing.id,
        alreadyArchived: true,
      });
    }
    const kb = q.run(
      `INSERT INTO kb_docs(category,title,body,enabled,file_path,file_type,file_name) VALUES(?,?,?,?,?,?,?)`,
      category,
      title,
      body.slice(0, 60000),
      enabled,
      file.file_url,
      file.ext,
      file.name,
    );
    kbDocId = kb.lastInsertRowid;
    q.run(
      `INSERT INTO biz_assets(name,category,value,status,owner,source_type,source_id,creator_id,url,note)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
      title,
      "知识资产",
      3000,
      "使用中",
      "文件中心",
      "kb",
      kbDocId,
      req.user.id,
      file.file_url,
      `上传文件入档；原文件=${file.name}；入档人=${req.user.name}`,
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw error;
  }
  embedDoc(kbDocId, title, body);
  if (!enabled) {
    for (const user of q.all(
      `SELECT id FROM users WHERE tenant_id=? AND role IN ('boss','ops_director','admin')`,
      curTenant(),
    )) {
      notify(
        user.id,
        "知识库",
        `员工资料待启用：${title}`,
        `${req.user.name} 已将「${file.name}」入档，审核启用后可被AI调用`,
      );
    }
  }
  logOp(req.user, "文件中心", "入档知识库", file.name);
  res.json({ ok: true, kbDocId, enabled });
});

r.get("/:id", (req, res) => {
  const row = ownedFile(req.params.id, req.user, true);
  if (!row) return res.status(404).json({ error: "文件不存在或无权访问" });
  res.json({ ...filePublic(row), content: row.extracted_text || "" });
});

export default r;
