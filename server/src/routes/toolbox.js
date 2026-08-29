import { createHash } from "node:crypto";
import fs from "node:fs";
import { Router } from "express";
import { db, q, runWithTenant } from "../db.js";
import { logOp, safeJsonParse, today, daysAgo } from "../util.js";
import {
  TOOLBOX_AI_MAX_ATTEMPTS,
  TOOLBOX_PCAL_MAX_OUTPUT_TOKENS,
  TOOLBOX_AI_RETRY_INSTRUCTION,
  ToolboxValidationError,
  assertLinkScriptPublicUrl,
  linkScriptStructuredValid,
  toolboxAiMaxOutputTokens,
  toolboxEmployeeSnapshot,
  toolboxExecutionSpec,
  generateToolboxDraft,
  normalizePrivateCalendar,
  validateToolRunPayload,
} from "../engines/toolbox.js";
import {
  enqueueToolboxRun,
  toolboxJobActive,
  TOOLBOX_JOB_TIMEOUT_MS,
} from "../engines/toolbox-job-runner.js";
import { toolboxResultQuality } from "../engines/toolbox-quality.js";
import { aiAvailable } from "../engines/ai.js";
import { yunwuAvailable } from "../engines/yunwu.js";
import {
  estimateCallCredits,
  estimateMaxCredits,
  holdCredits,
  releaseHold,
  settleHold,
} from "../engines/credits.js";
import { twoPhaseBillingSummary } from "../engines/two-phase-delivery.js";
import { buildEmployeeExecutionProfile } from "../employee-workbench.js";
import {
  inspectInternalProfileLeakage,
  internalProfileLeakageNotice,
  normalizeInternalProfileLeakage,
  projectInternalProfileOutput,
} from "../engines/internal-profile-leakage.js";
import { userScopeClause } from "../engines/access.js";
import { BUSINESS_DELIVERY_LABELS } from "../engines/delivery-state.js";
import { ownedFile, saveUploadedFile } from "../engines/filehub.js";
import { feishuConfig, feishuTenantToken } from "../engines/feishu.js";
import {
  FeishuBitableError,
  parseFeishuBitableUrl,
  syncPrivateCalendarToFeishu,
} from "../engines/feishu-bitable.js";
import {
  ToolboxAutomationError,
  claimManualToolboxAutomation,
  executeToolboxAutomationClaim,
  getToolboxAutomationRun,
  listToolboxAutomationConfigs,
  listToolboxAutomationRuns,
  reconcileToolboxAutomationRuns,
  saveToolboxAutomationConfig,
} from "../engines/toolbox-automations.js";

const r = Router();
const INTERNAL_PROFILE_ROLES = new Set(["boss", "admin", "platform_super"]);
const BLOCKED_DELIVERY_MODES = new Set([
  "template",
  "fallback",
  "failed",
  "error",
  "mock",
  "demo",
  "degraded",
  "unknown",
]);
const FAILED_DELIVERY_STATUS = BUSINESS_DELIVERY_LABELS.qualityFailed;
const EXECUTION_FAILED_STATUS = BUSINESS_DELIVERY_LABELS.executionFailed;
const RETRY_ACTION = "补充或调整输入后重新运行";
const RECONCILIATION_ACTION =
  "等待管理员完成账务对账；对账完成前该产物业务暂不可采用";
const TOOLBOX_FREE_RETRY_LIMIT = 3;
const MENU_COPY_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MENU_COPY_MIME_EXT = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
});
const PUBLIC_PROVENANCE_KEYS = Object.freeze([
  "mode",
  "sourceSystem",
  "engine",
  "generatedAt",
  "confidence",
  "completionState",
  "model",
  "usage",
  "attempts",
  "publicResearch",
  "providerAttempt",
  "executionKind",
  "mediaArtifact",
  "inputModality",
  "structuredOutput",
  "structuredCalendar",
  "automation",
  "contract",
  "billing",
  "persisted",
]);

function toolboxProviderAvailable(spec, appLocals = {}) {
  if (spec.vision) {
    if (typeof appLocals.toolboxVisionAvailable === "function") {
      return appLocals.toolboxVisionAvailable() === true;
    }
    if (
      typeof appLocals.toolboxVisionChat === "function" ||
      typeof appLocals.toolboxVision === "function"
    ) {
      return true;
    }
    return yunwuAvailable();
  }
  if (
    spec.linkScript &&
    (typeof appLocals.toolboxGenerate === "function" ||
      typeof appLocals.toolboxAiAvailable === "function")
  ) {
    return typeof appLocals.toolboxAiAvailable === "function"
      ? appLocals.toolboxAiAvailable() === true
      : true;
  }
  if (spec.kind === "text") {
    if (typeof appLocals.toolboxAiAvailable === "function") {
      return appLocals.toolboxAiAvailable() === true;
    }
    if (typeof appLocals.toolboxGenerate === "function") return true;
    return aiAvailable();
  }
  if (typeof appLocals.toolboxMediaAvailable === "function") {
    return appLocals.toolboxMediaAvailable() === true;
  }
  return yunwuAvailable();
}

function toolboxEstimatedCredits(
  spec,
  employeeExecution,
  inputs,
  visionAsset = null,
) {
  if (spec.vision) {
    return estimateCallCredits({
      kind: "text",
      model: spec.model,
      outputTokens: 1_200,
      texts: [
        employeeExecution?.systemContext || "",
        String(inputs?.want || "写外卖平台菜品描述"),
      ],
      overheadTokens: Math.min(
        100_000,
        Math.max(6_000, Math.ceil(Number(visionAsset?.size || 0) / 2)),
      ),
    });
  }
  if (spec.kind !== "text") return estimateMaxCredits(spec.kind, spec.model);
  const perAttemptEstimate = {
    kind: "text",
    model: spec.model,
    outputTokens: spec.structuredCalendar
      ? TOOLBOX_PCAL_MAX_OUTPUT_TOKENS
      : toolboxAiMaxOutputTokens(employeeExecution),
    texts: [employeeExecution.systemContext, JSON.stringify(inputs)],
    ...(spec.linkScript ? { overheadTokens: 12_000 } : {}),
  };
  return (
    estimateCallCredits(perAttemptEstimate) +
    estimateCallCredits({
      ...perAttemptEstimate,
      texts: [...perAttemptEstimate.texts, TOOLBOX_AI_RETRY_INSTRUCTION],
    }) *
      (TOOLBOX_AI_MAX_ATTEMPTS - 1)
  );
}

async function preflightLinkScriptInput(input, appLocals = {}) {
  if (input?.definition?.key !== "link-script") return input;
  // 链接转口播需要可读取的具体文章/视频正文。首页或纯导航页没有可
  // 归因的事实，继续占扣并让模型反复返回空结构只会制造“无产出”记录。
  try {
    const parsed = new URL(String(input.inputs.url || ""));
    if (parsed.pathname === "/" && !parsed.search && !parsed.hash) {
      throw new ToolboxValidationError(
        "请提供具体文章、视频或公开帖子链接，不要使用网站首页；系统需要正文来源才能生成可核验口播稿",
      );
    }
  } catch (error) {
    if (error instanceof ToolboxValidationError) throw error;
  }
  const guard =
    typeof appLocals.toolboxLinkUrlGuard === "function"
      ? appLocals.toolboxLinkUrlGuard
      : assertLinkScriptPublicUrl;
  const normalized = await guard(input.inputs.url, {
    lookupFn: appLocals.toolboxLinkLookup,
  });
  if (typeof normalized === "string" && normalized.trim()) {
    input.inputs.url = normalized;
  }
  return input;
}

function jsonArray(value) {
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function jsonObject(value) {
  const parsed = safeJsonParse(value, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : {};
}

function menuCopyMimeFromBytes(buffer) {
  if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "";
}

function validateMenuCopyImageBuffer(buffer, claimedMime = "") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new ToolboxValidationError("图片内容为空");
  }
  if (buffer.length > MENU_COPY_MAX_IMAGE_BYTES) {
    throw new ToolboxValidationError("图片太大（最大8MB）");
  }
  const detectedMime = menuCopyMimeFromBytes(buffer);
  if (!detectedMime) {
    throw new ToolboxValidationError("图片仅支持 PNG、JPEG 或 WebP");
  }
  const normalizedClaim = String(claimedMime || "")
    .trim()
    .toLowerCase();
  if (normalizedClaim && normalizedClaim !== detectedMime) {
    throw new ToolboxValidationError("图片MIME与真实文件内容不一致");
  }
  return detectedMime;
}

function decodeMenuCopyDataUrl(value) {
  if (typeof value !== "string") {
    throw new ToolboxValidationError("图片 data URL 必须是文本");
  }
  const match = value.match(
    /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/]+={0,2})$/iu,
  );
  if (!match) {
    throw new ToolboxValidationError(
      "图片 data URL 仅支持 PNG、JPEG 或 WebP 的标准 base64 格式",
    );
  }
  const encoded = match[2];
  const maxEncoded = Math.ceil(MENU_COPY_MAX_IMAGE_BYTES / 3) * 4 + 4;
  if (encoded.length > maxEncoded) {
    throw new ToolboxValidationError("图片太大（最大8MB）");
  }
  const buffer = Buffer.from(encoded, "base64");
  const mime = validateMenuCopyImageBuffer(buffer, match[1].toLowerCase());
  return { buffer, mime, encoded };
}

function resolveMenuCopyFile(imageFileId, user) {
  const row = ownedFile(imageFileId, user, true);
  if (!row) {
    throw Object.assign(new Error("图片文件不存在或无权访问"), {
      status: 404,
      code: "TOOLBOX_VISION_FILE_NOT_FOUND",
    });
  }
  const ext = String(row.ext || "")
    .trim()
    .toLowerCase();
  if (!["png", "jpg", "jpeg", "webp"].includes(ext)) {
    throw new ToolboxValidationError("文件中心图片仅支持 PNG、JPEG 或 WebP");
  }
  if (
    !(Number(row.size) > 0) ||
    Number(row.size) > MENU_COPY_MAX_IMAGE_BYTES ||
    !row.file_path ||
    !fs.existsSync(row.file_path)
  ) {
    throw new ToolboxValidationError("图片文件不完整或超过8MB");
  }
  const buffer = fs.readFileSync(row.file_path);
  const mime = validateMenuCopyImageBuffer(buffer);
  const expectedExt = MENU_COPY_MIME_EXT[mime];
  if (
    expectedExt !== ext &&
    !(mime === "image/jpeg" && ["jpg", "jpeg"].includes(ext))
  ) {
    throw new ToolboxValidationError("图片扩展名与真实文件内容不一致");
  }
  return {
    id: Number(row.id),
    name: String(row.name || `图片#${row.id}`).slice(0, 200),
    mime,
    size: buffer.length,
    url: String(row.file_url || "").slice(0, 1_000),
    dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
  };
}

function prepareToolboxInput(body, user) {
  if (body?.toolKey !== "menu-copy") {
    return { input: validateToolRunPayload(body), visionAsset: null };
  }
  const rawInputs = body?.inputs;
  if (!rawInputs || typeof rawInputs !== "object" || Array.isArray(rawInputs)) {
    throw new ToolboxValidationError("inputs必须是对象");
  }
  const allowed = new Set(["imageFileId", "imageDataUrl", "want"]);
  const unknown = Object.keys(rawInputs).find((key) => !allowed.has(key));
  if (unknown) {
    throw new ToolboxValidationError(`inputs包含不支持的字段：${unknown}`);
  }
  const hasFileId = rawInputs.imageFileId !== undefined;
  const hasDataUrl =
    typeof rawInputs.imageDataUrl === "string" &&
    rawInputs.imageDataUrl.length > 0;
  if (hasFileId === hasDataUrl) {
    throw new ToolboxValidationError(
      "图片必须且只能选择一种输入：文件中心图片ID或安全 data URL",
    );
  }

  // 先校验工具、员工、标题和诉求，防止非法请求在文件中心留下孤儿文件。
  const probe = validateToolRunPayload({
    ...body,
    inputs: {
      imageFileId: hasFileId ? rawInputs.imageFileId : 1,
      ...(rawInputs.want === undefined ? {} : { want: rawInputs.want }),
    },
  });
  let imageFileId = probe.inputs.imageFileId;
  if (hasDataUrl) {
    const decoded = decodeMenuCopyDataUrl(rawInputs.imageDataUrl);
    const ext = MENU_COPY_MIME_EXT[decoded.mime];
    const saved = saveUploadedFile({
      name: `menu-copy-${Date.now()}.${ext}`,
      b64: decoded.encoded,
      mime: decoded.mime,
      purpose: "toolbox-menu-copy",
      userId: user.id,
    });
    imageFileId = Number(saved.row.id);
  }
  const input = validateToolRunPayload({
    ...body,
    inputs: {
      imageFileId,
      ...(rawInputs.want === undefined ? {} : { want: rawInputs.want }),
    },
  });
  return {
    input,
    visionAsset: resolveMenuCopyFile(input.inputs.imageFileId, user),
  };
}

function visibleProvenance(value, user) {
  const provenance = jsonObject(value);
  if (INTERNAL_PROFILE_ROLES.has(user?.role)) return provenance;
  const visible = Object.fromEntries(
    PUBLIC_PROVENANCE_KEYS.filter((key) => Object.hasOwn(provenance, key)).map(
      (key) => [key, provenance[key]],
    ),
  );
  if (visible.billing && typeof visible.billing === "object") {
    visible.billing = { ...visible.billing };
    delete visible.billing.requestedModel;
  }
  return visible;
}

function normalizedState(value, fallback = "") {
  return String(value || fallback)
    .trim()
    .toLowerCase();
}

function blockedProviderModel(value) {
  const model = normalizedState(value);
  return (
    !model ||
    /(?:^|[_-])(template|fallback|failed|error|mock|demo|degraded|unknown|inherit)(?:$|[_-])/u.test(
      model,
    )
  );
}

function validDeliveryContract(provenance) {
  const contract = jsonObject(provenance.contract);
  return (
    contract.valid === true && normalizedState(contract.status) === "valid"
  );
}

function positiveUsage(value) {
  const usage = jsonObject(value);
  return Number(usage.inputTokens) > 0 && Number(usage.outputTokens) > 0;
}

function structuredMenuCopyValid(value) {
  const output = jsonObject(value);
  return ["item", "selling_point", "desc", "xhs", "price_note"].every(
    (key) => typeof output[key] === "string" && output[key].trim().length > 0,
  );
}

function storedProviderEvidenceValid(provenance) {
  const attempts = Array.isArray(provenance.attempts)
    ? provenance.attempts
    : [];
  const executionKind = normalizedState(provenance.executionKind, "text");
  const mediaExecution = ["image", "video"].includes(executionKind);
  const accepted = attempts.filter(
    (attempt) =>
      normalizedState(attempt?.mode) === "api" &&
      normalizedState(attempt?.outcome) === "accepted" &&
      normalizedState(attempt?.reason) === "accepted" &&
      !blockedProviderModel(attempt?.model) &&
      (mediaExecution || positiveUsage(attempt?.usage)),
  );
  const attemptUsage = attempts.reduce(
    (sum, attempt) => ({
      inputTokens: sum.inputTokens + (Number(attempt?.usage?.inputTokens) || 0),
      outputTokens:
        sum.outputTokens + (Number(attempt?.usage?.outputTokens) || 0),
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
  if (mediaExecution) {
    const artifact = jsonObject(provenance.mediaArtifact);
    const artifactUrl = String(artifact.url || "");
    const artifactUrlValid =
      /^https:\/\/[^\s]+$/iu.test(artifactUrl) ||
      (executionKind === "image" &&
        /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/iu.test(
          artifactUrl,
        ));
    return (
      normalizedState(provenance.mode) === "api" &&
      !blockedProviderModel(provenance.model) &&
      accepted.length === 1 &&
      normalizedState(accepted[0].model) ===
        normalizedState(provenance.model) &&
      normalizedState(artifact.kind) === executionKind &&
      normalizedState(artifact.status) === "ready" &&
      artifactUrlValid &&
      String(artifact.mimeType || "").startsWith(`${executionKind}/`)
    );
  }
  return (
    normalizedState(provenance.mode) === "api" &&
    !blockedProviderModel(provenance.model) &&
    positiveUsage(provenance.usage) &&
    (normalizedState(provenance.inputModality) !== "image" ||
      structuredMenuCopyValid(provenance.structuredOutput)) &&
    (normalizedState(provenance.inputModality) !== "url" ||
      (linkScriptStructuredValid(provenance.structuredOutput) &&
        normalizedState(provenance.publicResearch?.status) === "verified" &&
        /^https?:\/\//iu.test(
          String(provenance.publicResearch?.originalUrl || ""),
        ) &&
        Array.isArray(provenance.publicResearch?.sources) &&
        provenance.publicResearch.sources.length > 0)) &&
    accepted.length === 1 &&
    normalizedState(accepted[0].model) === normalizedState(provenance.model) &&
    attemptUsage.inputTokens === Number(provenance.usage?.inputTokens) &&
    attemptUsage.outputTokens === Number(provenance.usage?.outputTokens)
  );
}

function storedLeakageAuditClear(provenance, resultMd) {
  const audit = jsonObject(provenance.internalProfileLeakage);
  const outputHash = createHash("sha256")
    .update(String(resultMd || ""), "utf8")
    .digest("hex");
  return (
    audit.detected === false &&
    normalizedState(audit.status) === "clear" &&
    typeof audit.outputHash === "string" &&
    audit.outputHash === outputHash
  );
}

// 交付质检（toolboxResultQuality）已抽到 engines/toolbox-quality.js，
// 与生成循环的定向返工共用同一套口径。

function authoritativeBillingState(row, provenance, user) {
  if (
    !q.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='credit_holds'",
    )
  ) {
    return { settled: false, pendingReconciliation: false };
  }
  const rows = q.all(
    `SELECT
      h.id AS hold_id,h.tenant_id,h.user_id AS hold_user_id,h.log_id,h.feature AS hold_feature,
      h.kind AS hold_kind,h.model AS hold_model,h.held_credits,h.settled_credits,h.status AS hold_status,
      h.ref_type,h.ref_id,
      l.id AS ledger_id,l.user_id AS log_user_id,l.feature AS log_feature,l.kind AS log_kind,
      l.model AS log_model,l.input_tokens,l.output_tokens,l.credits AS log_credits,l.ai_mode
    FROM credit_holds h
    LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
    WHERE h.tenant_id=? AND h.ref_type='tool_run' AND h.ref_id=?`,
    Number(user?.tenant_id),
    Number(row.id),
  );
  const expectedKind = ["image", "video"].includes(
    normalizedState(provenance.executionKind),
  )
    ? normalizedState(provenance.executionKind)
    : "text";
  const textExecution = expectedKind === "text";
  const settledPositive = rows.filter(
    (item) =>
      item.hold_status === "settled" &&
      Number(item.settled_credits) > 0 &&
      Number(item.ledger_id) === Number(item.log_id) &&
      Number(item.hold_user_id) === Number(row.created_by) &&
      Number(item.log_user_id) === Number(row.created_by) &&
      Number(item.hold_user_id) === Number(item.log_user_id) &&
      item.hold_feature ===
        `经营工具箱·${String(row.tool_title || "").trim()}` &&
      item.hold_kind === expectedKind &&
      item.hold_feature === item.log_feature &&
      item.hold_kind === item.log_kind &&
      normalizedState(item.hold_model) ===
        normalizedState(provenance.billing?.requestedModel) &&
      Number(item.log_credits) === Number(item.settled_credits) &&
      normalizedState(item.ai_mode) === "api" &&
      normalizedState(item.log_model) === normalizedState(provenance.model) &&
      (!textExecution || Number(item.input_tokens) > 0) &&
      (!textExecution || Number(item.output_tokens) > 0) &&
      (!textExecution ||
        Number(item.input_tokens) === Number(provenance.usage?.inputTokens)) &&
      (!textExecution ||
        Number(item.output_tokens) ===
          Number(provenance.usage?.outputTokens)) &&
      Number(item.hold_id) === Number(provenance.billing?.holdId) &&
      Number(item.log_credits) === Number(provenance.billing?.chargedCredits),
  );
  const released = rows.filter(
    (item) =>
      item.hold_status === "settled" &&
      Number(item.settled_credits) === 0 &&
      Number(item.log_credits) === 0 &&
      Number(item.ledger_id) === Number(item.log_id) &&
      Number(item.hold_user_id) === Number(row.created_by) &&
      Number(item.log_user_id) === Number(row.created_by) &&
      item.hold_feature ===
        `经营工具箱·${String(row.tool_title || "").trim()}` &&
      item.hold_kind === expectedKind &&
      item.hold_feature === item.log_feature &&
      item.hold_kind === item.log_kind,
  );
  // 免费重试会在同一 run 上留下“已全退的失败轮次 + 当前成功轮次”。
  // 历史全退 hold 是合法账本证据，不应因 rows.length>1 把重试成果误判为待对账。
  const settled =
    settledPositive.length === 1 &&
    settledPositive.length + released.length === rows.length;
  const releasedCleanly = rows.length > 0 && released.length === rows.length;
  const claimedState = normalizedState(provenance.billing?.state);
  const ledgerConflict =
    (rows.some(
      (item) =>
        item.hold_status === "settled" && Number(item.settled_credits) > 0,
    ) &&
      !settled) ||
    (claimedState === "settled" && !settled) ||
    (settled &&
      [
        "held",
        "unsettled",
        "pending_reconciliation",
        "pending_settlement",
      ].includes(claimedState)) ||
    (claimedState === "released" && !releasedCleanly);
  return {
    settled,
    released: releasedCleanly,
    pendingReconciliation:
      rows.some((item) => item.hold_status === "held") || ledgerConflict,
    ledgerConflict,
  };
}

function storedRunDeliveryState(row, provenance, internalProfileLeakage, user) {
  const mode = normalizedState(provenance.mode, "unknown");
  const input = jsonObject(row.input_json);
  const resultQuality = toolboxResultQuality(
    row.tool_key,
    input,
    row.result_md,
    {
      strictActions: mode === "api",
    },
  );
  const authoritativeBilling = authoritativeBillingState(row, provenance, user);
  const qualityValid =
    row.status === "done" &&
    mode === "api" &&
    normalizedState(provenance.completionState) === "completed" &&
    validDeliveryContract(provenance) &&
    storedProviderEvidenceValid(provenance) &&
    provenance.persisted === true &&
    !internalProfileLeakage &&
    storedLeakageAuditClear(provenance, row.result_md) &&
    resultQuality.valid;
  const verified = qualityValid && authoritativeBilling.settled;
  // 质检失败后的预授权“释放”同样可能失败。只要账务明确处于待处理态，
  // 就必须优先显示待对账，不能因为质量无效而把冻结积分藏进普通失败状态。
  const needsReconciliation =
    row.status !== "running" && authoritativeBilling.pendingReconciliation;
  const qualityFailure =
    !verified &&
    !needsReconciliation &&
    row.status !== "running" &&
    (row.status === "done" ||
      BLOCKED_DELIVERY_MODES.has(mode) ||
      internalProfileLeakage ||
      jsonObject(provenance.contract).valid === false);
  return { verified, needsReconciliation, qualityFailure };
}

function toolboxDeliveryContract(
  definition,
  inputs,
  draft,
  resultMd,
  internalProfileLeakage,
) {
  const errors = [];
  const provenance = jsonObject(draft?.provenance);
  const mode = normalizedState(provenance.mode, "unknown");
  const model = normalizedState(provenance.model);
  const usage = jsonObject(provenance.usage);
  const executionKind = normalizedState(provenance.executionKind, "text");
  const mediaExecution = ["image", "video"].includes(executionKind);
  const attempts = Array.isArray(provenance.attempts)
    ? provenance.attempts
    : [];
  const acceptedAttempt = attempts.find(
    (attempt) =>
      normalizedState(attempt?.mode) === "api" &&
      normalizedState(attempt?.outcome) === "accepted" &&
      normalizedState(attempt?.reason) === "accepted" &&
      !blockedProviderModel(attempt?.model),
  );
  if (mode !== "api") {
    errors.push("本次未形成真实 API 产物");
  }
  if (normalizedState(provenance.completionState) !== "completed") {
    errors.push("生成过程未达到 completed 状态");
  }
  if (mode === "api" && blockedProviderModel(model)) {
    errors.push("真实 API 模型证据缺失或为降级模型");
  }
  if (mode === "api" && !mediaExecution && !(Number(usage.inputTokens) > 0)) {
    errors.push("真实 API 输入 token 证据缺失");
  }
  if (mode === "api" && !mediaExecution && !(Number(usage.outputTokens) > 0)) {
    errors.push("真实 API 输出 token 证据缺失");
  }
  if (mode === "api" && !acceptedAttempt) {
    errors.push("缺少通过验收的真实 API 尝试记录");
  }
  if (
    acceptedAttempt &&
    !mediaExecution &&
    (!(Number(acceptedAttempt.usage?.inputTokens) > 0) ||
      !(Number(acceptedAttempt.usage?.outputTokens) > 0))
  ) {
    errors.push("通过验收的 API 尝试缺少正 token 用量");
  }
  if (mediaExecution) {
    const artifact = jsonObject(provenance.mediaArtifact);
    const artifactUrl = String(artifact.url || "");
    const urlValid =
      /^https:\/\/[^\s]+$/iu.test(artifactUrl) ||
      (executionKind === "image" &&
        /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/iu.test(
          artifactUrl,
        ));
    if (
      normalizedState(artifact.kind) !== executionKind ||
      normalizedState(artifact.status) !== "ready" ||
      !String(artifact.mimeType || "").startsWith(`${executionKind}/`) ||
      !urlValid
    ) {
      errors.push("真实媒体产物证据缺失或不可预览");
    }
  }
  if (
    definition.key === "menu-copy" &&
    !structuredMenuCopyValid(provenance.structuredOutput)
  ) {
    errors.push("看图文案缺少 item/selling_point/desc/xhs/price_note 完整结构");
  }
  if (definition.key === "link-script") {
    const publicResearch = jsonObject(provenance.publicResearch);
    if (!linkScriptStructuredValid(provenance.structuredOutput)) {
      errors.push("链接口播缺少 script/hook/core_points/cta 完整结构");
    }
    if (
      normalizedState(provenance.inputModality) !== "url" ||
      normalizedState(publicResearch.status) !== "verified" ||
      String(publicResearch.originalUrl || "") !== String(inputs.url || "") ||
      !Array.isArray(publicResearch.sources) ||
      publicResearch.sources.length < 1 ||
      publicResearch.sources.some(
        (source) =>
          source?.bodyVerified !== true ||
          !(Number(source?.bodyChars) >= 80) ||
          !/^[a-f0-9]{64}$/iu.test(String(source?.snapshotHash || "")),
      )
    ) {
      errors.push("原链接、受控正文与来源快照证据不完整");
    }
  }
  if (definition.key === "pcal") {
    try {
      const calendar = normalizePrivateCalendar(
        provenance.structuredCalendar,
        inputs.month,
      );
      if (calendar.days.length < 28 || calendar.month !== inputs.month) {
        errors.push("私域日历整月结构不完整");
      }
    } catch {
      errors.push("私域日历缺少无重复、无缺日的整月结构化数据");
    }
  }
  if (!String(resultMd || "").trim()) errors.push("工具产物正文为空");
  if (internalProfileLeakage?.detected)
    errors.push("工具产物触发内部档案泄漏质检");
  errors.push(
    ...toolboxResultQuality(definition.key, inputs, resultMd, {
      strictActions: mode === "api",
    }).errors,
  );
  return {
    validator: "toolbox-delivery-contract",
    status: errors.length ? "invalid" : "valid",
    valid: errors.length === 0,
    requiresManualRepair: errors.length > 0,
    errors,
  };
}

function latestPrivateCalendarState(row, tenantId) {
  if (!row || row.tool_key !== "pcal") return null;
  const inputs = jsonObject(row.input_json);
  const provenance = jsonObject(row.provenance_json);
  const edit = q.get(
    `SELECT version,calendar_json,created_at
    FROM tool_run_pcal_edits
    WHERE tenant_id=? AND run_id=?
    ORDER BY version DESC LIMIT 1`,
    tenantId,
    row.id,
  );
  try {
    return {
      calendar: normalizePrivateCalendar(
        edit ? jsonObject(edit.calendar_json) : provenance.structuredCalendar,
        inputs.month,
      ),
      version: Number(edit?.version || 0),
      editedAt: edit?.created_at || null,
    };
  } catch {
    return null;
  }
}

function publicFeishuExport(runId, tenantId, currentCalendarVersion = null) {
  const row = q.get(
    `SELECT status,table_name,table_id,synced,attempt_count,error_json,
      calendar_version,export_version,created_at,updated_at
    FROM tool_run_feishu_exports WHERE tenant_id=? AND run_id=?`,
    tenantId,
    runId,
  );
  if (!row) return null;
  const error = row.error_json ? jsonObject(row.error_json) : null;
  return {
    status: row.status,
    table: row.table_name || "",
    tableId: row.table_id || "",
    synced: Number(row.synced || 0),
    attemptCount: Number(row.attempt_count || 0),
    calendarVersion: Number(row.calendar_version || 0),
    exportVersion: Number(row.export_version || 1),
    outdated:
      Number.isInteger(Number(currentCalendarVersion)) &&
      Number(row.calendar_version || 0) !== Number(currentCalendarVersion),
    error:
      error && (error.code || error.message)
        ? {
            code: String(error.code || "FEISHU_BITABLE_FAILED").slice(0, 120),
            message: String(error.message || "飞书同步失败").slice(0, 300),
          }
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(row, user) {
  if (!row) return null;
  const storedProvenance = jsonObject(row.provenance_json);
  const internalProfileLeakage = normalizeInternalProfileLeakage(
    storedProvenance.internalProfileLeakage,
  );
  const deliveryState = storedRunDeliveryState(
    row,
    storedProvenance,
    internalProfileLeakage,
    user,
  );
  // 质检结果不推断账务结果；可使用与待对账状态由权威 hold/log 回读，
  // provenance.billing 仅作为展示快照，不能把伪造字段当作结算事实。
  const displayStatus = deliveryState.verified
    ? "已完成"
    : deliveryState.needsReconciliation
      ? BUSINESS_DELIVERY_LABELS.businessBlocked
      : deliveryState.qualityFailure
        ? FAILED_DELIVERY_STATUS
        : row.status === "failed"
          ? EXECUTION_FAILED_STATUS
          : BUSINESS_DELIVERY_LABELS.generating;
  const nextAction = deliveryState.verified
    ? "查看并核对工具结果"
    : deliveryState.needsReconciliation
      ? RECONCILIATION_ACTION
      : row.status === "running"
        ? "等待生成完成"
        : `${RETRY_ACTION}；当前正文只作为审计记录`;
  const pcalState = latestPrivateCalendarState(row, user.tenant_id);
  return {
    id: row.id,
    toolKey: row.tool_key,
    toolTitle: row.tool_title,
    title: row.title,
    status: row.status,
    employeeIdx: row.employee_idx,
    employeeName: row.employee_name,
    inputSummary: row.input_summary,
    resultMd: projectInternalProfileOutput(
      row.result_md,
      internalProfileLeakage,
      user,
    ),
    assumptions: jsonArray(row.assumptions_json),
    evidence: jsonArray(row.evidence_json),
    provenance: visibleProvenance(row.provenance_json, user),
    progress: jsonArray(row.progress_json),
    error: row.error_json ? jsonObject(row.error_json) : null,
    retryCount: Number(row.retry_count || 0),
    executionState: row.execution_state || row.status,
    retryable:
      row.status === "failed" &&
      Number(row.retry_count || 0) < TOOLBOX_FREE_RETRY_LIMIT,
    freeRetriesRemaining: Math.max(
      0,
      TOOLBOX_FREE_RETRY_LIMIT - Number(row.retry_count || 0),
    ),
    feishuExport:
      row.tool_key === "pcal"
        ? publicFeishuExport(row.id, user.tenant_id, pcalState?.version ?? 0)
        : null,
    pcalCalendar: pcalState?.calendar || null,
    pcalEditVersion: pcalState?.version ?? 0,
    pcalEditedAt: pcalState?.editedAt || null,
    deepLink: `/tasks?kind=tool&id=${row.id}`,
    displayStatus,
    verified: deliveryState.verified,
    canUse: deliveryState.verified,
    nextAction,
    ...(internalProfileLeakage ? { internalProfileLeakage } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function recordToolProgress(runId, tenantId, event) {
  if (!runId || !tenantId) return;
  const row = q.get(
    "SELECT progress_json FROM tool_runs WHERE tenant_id=? AND id=?",
    tenantId,
    runId,
  );
  if (!row) return;
  const progress = jsonArray(row.progress_json);
  progress.push({
    phase: String(event?.phase || "running").slice(0, 80),
    message: String(event?.message || "任务执行中").slice(0, 300),
    ...(Number.isInteger(Number(event?.attempt))
      ? { attempt: Number(event.attempt) }
      : {}),
    ...(Number.isInteger(Number(event?.batch))
      ? { batch: Number(event.batch) }
      : {}),
    ...(Number.isInteger(Number(event?.requested))
      ? { requested: Number(event.requested) }
      : {}),
    at: new Date().toISOString(),
  });
  const executionState =
    {
      queued: "queued",
      retrying: "retrying",
      completed: "done",
      quality_failed: "failed",
      failed: "failed",
    }[event?.phase] || "running";
  q.run(
    `UPDATE tool_runs SET progress_json=?,execution_state=?,last_heartbeat_at=datetime('now','localtime'),
      timeout_at=CASE WHEN ? IN ('done','failed') THEN timeout_at ELSE datetime('now','+12 minutes') END,
      updated_at=datetime('now','localtime')
    WHERE tenant_id=? AND id=?`,
    JSON.stringify(progress.slice(-100)),
    executionState,
    executionState,
    tenantId,
    runId,
  );
}

async function finalizeToolboxRun(context, draft) {
  const {
    input,
    user,
    employeeExecution,
    runId,
    initialBilling,
    requestedModel,
    holdModel,
  } = context;
  const storedBeforeFinish = q.get(
    "SELECT provenance_json FROM tool_runs WHERE tenant_id=? AND id=?",
    user.tenant_id,
    runId,
  );
  const automationSnapshot =
    context.automation ||
    jsonObject(storedBeforeFinish?.provenance_json).automation ||
    null;
  const internalProfileLeakage = inspectInternalProfileLeakage(
    draft.resultMd,
    employeeExecution.leakGuard,
  );
  const storedResult = internalProfileLeakage.detected
    ? internalProfileLeakageNotice()
    : draft.resultMd;
  const contract = toolboxDeliveryContract(
    input.definition,
    input.inputs,
    draft,
    storedResult,
    internalProfileLeakage,
  );
  const runStatus = contract.valid ? "done" : "failed";
  const provenance = {
    ...draft.provenance,
    internalProfileLeakage,
    ...(internalProfileLeakage.detected
      ? {
          completionState: "quality_failed",
        }
      : draft.provenance.mode !== "api"
        ? {
            completionState: "non_api_failed",
          }
        : {}),
    contract,
    billing: initialBilling,
    ...(automationSnapshot ? { automation: automationSnapshot } : {}),
    persisted: true,
  };

  db.exec("SAVEPOINT finish_toolbox_run");
  try {
    const finished = q.run(
      `UPDATE tool_runs SET
        status=?,execution_state=?,input_summary=?,result_md=?,assumptions_json=?,evidence_json=?,
        provenance_json=?,error_json=NULL,updated_at=datetime('now','localtime')
      WHERE tenant_id=? AND id=? AND status='running'`,
      runStatus,
      runStatus,
      draft.inputSummary,
      storedResult,
      JSON.stringify(draft.assumptions),
      JSON.stringify(draft.evidence),
      JSON.stringify(provenance),
      user.tenant_id,
      runId,
    );
    if (Number(finished.changes) !== 1)
      throw new Error("工具运行未完成本次落库确认");
    q.run(
      `INSERT OR REPLACE INTO tool_run_events(
      run_id,event_type,tool_key,employee_idx,user_id,status,source_system,metadata_json
    ) VALUES(?,?,?,?,?,?,?,?)`,
      runId,
      "generated",
      input.definition.key,
      input.definition.employeeIdx,
      user.id,
      runStatus,
      draft.provenance.sourceSystem,
      JSON.stringify({
        promptVersion: draft.provenance.promptVersion,
        mode: draft.provenance.mode,
        confidence: draft.provenance.confidence,
        retryCount: Number(context.retryCount || 0),
      }),
    );
    db.exec("RELEASE SAVEPOINT finish_toolbox_run");
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT finish_toolbox_run");
    db.exec("RELEASE SAVEPOINT finish_toolbox_run");
    throw error;
  }

  let billing = initialBilling;
  if (context.hold) {
    try {
      const settled =
        contract.valid && provenance.persisted === true
          ? settleHold(context.hold, {
              usage: draft.provenance.usage || {},
              model: draft.provenance.model || holdModel,
              aiMode: "api",
              note: "工具产物已落库并通过质检，按真实用量结算",
            })
          : releaseHold(
              context.hold,
              internalProfileLeakage.detected
                ? "工具结果触发内部档案泄漏质检，未形成正式交付并全额退回"
                : "工具产物未通过交付门槛，未形成正式交付并全额退回",
            );
      if (!settled) throw new Error("工具箱预授权未完成本次结算");
      billing = {
        ...twoPhaseBillingSummary({
          state: contract.valid ? "settled" : "released",
          hold: context.hold,
          settled,
          note: contract.valid
            ? "工具产物已交付并完成实际用量结算。"
            : "产物未通过交付门槛，预授权已全额退回。",
        }),
        requestedModel,
      };
      context.hold = null;
    } catch (settleError) {
      billing = {
        ...twoPhaseBillingSummary({
          state: "pending_reconciliation",
          hold: context.hold,
          error: settleError,
          note: contract.valid
            ? "工具产物已落库，但预授权尚未确认实扣，需对账。"
            : "工具产物未通过交付门槛，但预授权释放尚未确认，需对账。",
        }),
        requestedModel,
      };
      context.hold = null;
    }
  }
  provenance.billing = billing;
  q.run(
    `UPDATE tool_runs SET provenance_json=?,updated_at=datetime('now','localtime')
    WHERE tenant_id=? AND id=?`,
    JSON.stringify(provenance),
    user.tenant_id,
    runId,
  );
  recordToolProgress(runId, user.tenant_id, {
    phase: runStatus === "done" ? "completed" : "quality_failed",
    message:
      runStatus === "done"
        ? "工具结果已通过质量门并完成结算"
        : "工具结果未通过质量门，预授权已处理",
  });
  logOp(
    user,
    "经营工具箱",
    "后台运行工具并回流数据",
    `${input.definition.key}#${runId}`,
  );
  reconcileAutomationAfterToolRun(context);
}

async function failToolboxRun(context, error) {
  const { input, user, runId, requestedModel } = context;
  let failureBilling = context.initialBilling;
  if (context.hold) {
    try {
      const released = releaseHold(
        context.hold,
        "工具箱后台任务未交付，预授权全额退回",
      );
      if (!released) throw new Error("工具箱预授权未完成本次释放");
      failureBilling = {
        ...twoPhaseBillingSummary({
          state: "released",
          hold: context.hold,
          settled: released,
          note: "工具运行未交付，预授权已全额退回。",
        }),
        requestedModel,
      };
    } catch (releaseError) {
      failureBilling = {
        ...twoPhaseBillingSummary({
          state: "pending_reconciliation",
          hold: context.hold,
          error: releaseError,
          note: "工具运行未交付，但预授权释放尚未确认，需对账。",
        }),
        requestedModel,
      };
    }
    context.hold = null;
  }
  const existing = q.get(
    "SELECT * FROM tool_runs WHERE tenant_id=? AND id=?",
    user.tenant_id,
    runId,
  );
  if (!existing || ["done", "failed"].includes(existing.execution_state))
    return;
  const failureProvenance = {
    ...jsonObject(existing.provenance_json),
    completionState: "failed",
    contract: {
      validator: "toolbox-delivery-contract",
      status: "invalid",
      valid: false,
      requiresManualRepair: true,
      errors: ["工具后台运行未形成可交付产物"],
    },
    billing: failureBilling,
    ...(error?.researchEvidence
      ? { publicResearch: error.researchEvidence }
      : {}),
    ...(error?.providerEvidence
      ? { providerAttempt: error.providerEvidence }
      : {}),
    persisted: true,
  };
  q.run(
    `UPDATE tool_runs SET status='failed',execution_state='failed',result_md='',
      assumptions_json='[]',evidence_json='[]',provenance_json=?,error_json=?,
      updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?`,
    JSON.stringify(failureProvenance),
    JSON.stringify({
      code: String(error?.code || "TOOLBOX_EXECUTION_FAILED").slice(0, 120),
      message: String(error?.message || "工具运行失败").slice(0, 500),
    }),
    user.tenant_id,
    runId,
  );
  recordToolProgress(runId, user.tenant_id, {
    phase: "failed",
    message: String(error?.message || "工具运行失败").slice(0, 300),
  });
  q.run(
    `INSERT OR REPLACE INTO tool_run_events(
    run_id,event_type,tool_key,employee_idx,user_id,status,source_system,metadata_json
  ) VALUES(?,?,?,?,?,'failed','nanowork',?)`,
    runId,
    "generated",
    input.definition.key,
    input.definition.employeeIdx,
    user.id,
    JSON.stringify({
      mode: "failed",
      reason: String(error?.code || "delivery_failed"),
      retryCount: Number(context.retryCount || 0),
    }),
  );
  reconcileAutomationAfterToolRun(context);
}

function enqueueToolboxContext(context) {
  q.run(
    `UPDATE tool_runs SET execution_state=?,last_heartbeat_at=datetime('now','localtime'),
      timeout_at=datetime('now','+12 minutes'),updated_at=datetime('now','localtime')
    WHERE tenant_id=? AND id=?`,
    context.retrying ? "retrying" : "queued",
    context.user.tenant_id,
    context.runId,
  );
  return enqueueToolboxRunWithContext(context);
}

// ===== 业务穿插：把门店真实台账实况交给文案类工具 =====
// 「今日必发」等工具的选题若能结合今天真的沽清了什么、最近差评集中在哪、
// 本周有几位客户生日，产出才贴店况而不是通用模板。只给事实，不编数据。
function buildToolboxStoreContext(tenantId) {
  try {
    const lines = [];
    const soldout = db.prepare(
      `SELECT DISTINCT d.name FROM dish_soldout_marks m JOIN dishes d ON d.id=m.dish_id
       WHERE m.tenant_id=? AND m.date=? AND m.soldout=1
         AND m.id IN (SELECT MAX(id) FROM dish_soldout_marks WHERE tenant_id=? AND date=? GROUP BY dish_id)
       LIMIT 6`,
    ).all(tenantId, today(), tenantId, today());
    if (soldout.length) lines.push(`今日已沽清菜品：${soldout.map(row => row.name).join('、')}（选题避开或做成"手慢无"话题）`);
    const badCategories = db.prepare(
      `SELECT category, COUNT(*) n FROM store_reviews
       WHERE tenant_id=? AND rating<=3 AND category IS NOT NULL
         AND created_at >= datetime('now','localtime','-7 days')
       GROUP BY category ORDER BY n DESC LIMIT 2`,
    ).all(tenantId);
    if (badCategories.length) {
      lines.push(`近7天差评集中在：${badCategories.map(row => `${row.category}(${row.n}条)`).join('、')}（内容里可主动展示对应改进，别踩雷区）`);
    }
    // 只统计生日雷达真正识别得了的格式（MM-DD / YYYY-MM-DD），避免「登记了 N 位」与雷达显示数对不上
    const birthdayCount = db.prepare(
      `SELECT COUNT(*) n FROM leads WHERE tenant_id=? AND birthday LIKE '%-%'
       AND stage NOT IN ('已流失')`,
    ).get(tenantId)?.n || 0;
    if (birthdayCount > 0) lines.push(`会员档案里有 ${birthdayCount} 位客户登记了生日（可做生日到店福利选题）`);
    // 与沽清看板同口径：按「每菜每天最后一条标记」判定当日收盘态，排除已下架菜
    const soldFrequent = db.prepare(
      `SELECT d.name, COUNT(*) days FROM (
         SELECT dish_id, date, MAX(id) mid FROM dish_soldout_marks
         WHERE tenant_id=? AND date >= ? GROUP BY dish_id, date
       ) lastm
       JOIN dish_soldout_marks m ON m.id = lastm.mid AND m.soldout = 1
       JOIN dishes d ON d.id = lastm.dish_id
       WHERE d.status IS NULL OR d.status != '下架'
       GROUP BY lastm.dish_id HAVING days >= 3 ORDER BY days DESC LIMIT 3`,
    ).all(tenantId, daysAgo(6));
    if (soldFrequent.length) {
      lines.push(`近7天频繁卖断的菜：${soldFrequent.map(row => row.name).join('、')}（天然的爆款素材，可写"每天卖断"的真实稀缺）`);
    }
    return lines.length ? lines.join('\n') : '';
  } catch {
    // 实况组装失败不阻塞工具执行（工具没有实况也能跑）
    return '';
  }
}

function enqueueToolboxRunWithContext(context) {
  return enqueueToolboxRun({
    tenantId: context.user.tenant_id,
    runId: context.runId,
    definition: context.input.definition,
    inputs: context.input.inputs,
    retrying: context.retrying,
    timeoutMs: TOOLBOX_JOB_TIMEOUT_MS,
    generationOptions: {
      employeeExecution: context.employeeExecution,
      role: context.user.role,
      storeContext: buildToolboxStoreContext(context.user.tenant_id),
      generateFn: context.appLocals.toolboxGenerate,
      aiAvailableFn: context.appLocals.toolboxAiAvailable,
      transcribeLinkFn: context.appLocals.toolboxTranscribeLink,
      fetchPublicPageEvidenceFn:
        context.appLocals.toolboxFetchPublicPageEvidence,
      linkMinimumBodyChars: context.appLocals.toolboxLinkMinimumBodyChars,
      linkPageTimeoutMs: context.appLocals.toolboxLinkPageTimeoutMs,
      visionGenerateFn:
        context.appLocals.toolboxVisionChat || context.appLocals.toolboxVision,
      visionAvailableFn: context.appLocals.toolboxVisionAvailable,
      visionImageDataUrl: context.visionAsset?.dataUrl,
      visionImageMeta: context.visionAsset
        ? {
            id: context.visionAsset.id,
            name: context.visionAsset.name,
            mime: context.visionAsset.mime,
            size: context.visionAsset.size,
            url: context.visionAsset.url,
          }
        : null,
      generateImageFn: context.appLocals.toolboxGenerateImage,
      generateVideoFn: context.appLocals.toolboxGenerateVideo,
      fetchVideoTaskFn: context.appLocals.toolboxFetchVideoTask,
      mediaAvailableFn: context.appLocals.toolboxMediaAvailable,
      videoPollMs: context.appLocals.toolboxVideoPollMs,
      videoPollLimit: context.appLocals.toolboxVideoPollLimit,
      idempotencyKey: `toolbox-${context.user.tenant_id}-${context.runId}-${context.retryCount || 0}`,
      agenticWebResearchFn: context.appLocals.employeeAgenticWebResearch,
      controlledWebFetchFn: context.appLocals.employeeControlledWebFetch,
    },
    onProgress: (event) =>
      recordToolProgress(context.runId, context.user.tenant_id, event),
    onSuccess: (draft) => finalizeToolboxRun(context, draft),
    onFailure: (error) => failToolboxRun(context, error),
  });
}

function reconcileAutomationAfterToolRun(context) {
  if (!context.automation) return;
  try {
    // 手动 run-now 即使部署关闭周期调度，也必须在真实工具完成后立即把
    // 通知/知识沉淀与 claim 一起收口。失败仍由启动恢复和 scheduler tick 兜底。
    reconcileToolboxAutomationRuns(new Date());
  } catch (error) {
    console.error(
      `[toolbox automation] run#${context.runId} reconciliation failed:`,
      error?.message || error,
    );
  }
}

function parseLimit(value) {
  if (value === undefined) return 20;
  if (typeof value !== "string" || !/^\d{1,2}$/.test(value)) {
    throw new ToolboxValidationError("limit必须是1-50之间的整数");
  }
  const limit = Number(value);
  if (limit < 1 || limit > 50)
    throw new ToolboxValidationError("limit必须是1-50之间的整数");
  return limit;
}

function parseRunId(value) {
  const text = String(value || "");
  if (
    !/^\d{1,15}$/.test(text) ||
    Number(text) < 1 ||
    !Number.isSafeInteger(Number(text))
  ) {
    throw new ToolboxValidationError("运行记录ID格式不正确");
  }
  return Number(text);
}

r.get("/automations", (_req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.json({
    configs: listToolboxAutomationConfigs(),
    runs: listToolboxAutomationRuns({ limit: 20 }),
    timezone: "Asia/Shanghai",
  });
});

r.get("/automations/runs/:id", (req, res) => {
  try {
    const run = getToolboxAutomationRun(req.params.id);
    if (!run) return res.status(404).json({ error: "自动化运行不存在" });
    res.set("Cache-Control", "private, no-store");
    return res.json({ run });
  } catch (error) {
    if (error instanceof ToolboxAutomationError) {
      return res.status(error.status || 400).json({
        error: error.message,
        code: error.code,
      });
    }
    throw error;
  }
});

r.put("/automations/:key", (req, res, next) => {
  try {
    const config = saveToolboxAutomationConfig(
      req.params.key,
      req.body,
      req.user,
    );
    logOp(
      req.user,
      "经营工具箱",
      config.enabled ? "启用工具自动化" : "更新工具自动化",
      config.key,
    );
    res.set("Cache-Control", "private, no-store");
    return res.json({ ok: true, config });
  } catch (error) {
    if (error instanceof ToolboxAutomationError) {
      return res.status(error.status || 400).json({
        error: error.message,
        code: error.code,
      });
    }
    return next(error);
  }
});

r.post("/automations/:key/run-now", async (req, res, next) => {
  try {
    const claimed = claimManualToolboxAutomation(req.params.key, {
      user: req.user,
      idempotencyKey:
        req.get("Idempotency-Key") || req.get("X-Request-Id") || undefined,
    });
    let run = claimed.run;
    if (claimed.claimed) {
      run = await executeToolboxAutomationClaim(run, {
        createToolboxRunFn: createToolboxBackgroundRun,
        appLocals: req.app.locals,
      });
    }
    if (run?.status === "failed") {
      return res.status(Number(run.failure?.status) || 502).json({
        error: run.failure?.message || "自动化未能启动",
        code: run.failure?.code || "TOOLBOX_AUTOMATION_FAILED",
        automationRun: run,
      });
    }
    logOp(
      req.user,
      "经营工具箱",
      "手动触发工具自动化",
      `${req.params.key}#${run?.id || ""}`,
    );
    res.set("Cache-Control", "private, no-store");
    return res.status(claimed.idempotent ? 200 : 202).json({
      ok: true,
      idempotent: claimed.idempotent,
      automationRun: run,
      pollUrl: `/toolbox/automations/runs/${run.id}`,
      deepLink: run.deepLink,
      message: claimed.idempotent
        ? "该手动请求已处理，已返回同一自动化运行。"
        : "自动化已进入真实工具后台链，可到任务中心查看。",
    });
  } catch (error) {
    if (error instanceof ToolboxAutomationError) {
      return res.status(error.status || 400).json({
        error: error.message,
        code: error.code,
      });
    }
    return next(error);
  }
});

r.get("/runs", (req, res) => {
  try {
    const limit = parseLimit(req.query.limit);
    const access = userScopeClause(req.user, "created_by");
    const rows = q.scopedAll(
      "tool_runs",
      `${access.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...access.params,
      limit,
    );
    res.set("Cache-Control", "private, no-store");
    res.json({ runs: rows.map((row) => toRun(row, req.user)) });
  } catch (error) {
    if (error instanceof ToolboxValidationError)
      return res.status(400).json({ error: error.message });
    throw error;
  }
});

r.get("/runs/:id", (req, res) => {
  try {
    const id = parseRunId(req.params.id);
    const access = userScopeClause(req.user, "created_by");
    const row = q.scopedGet(
      "tool_runs",
      `AND id=?${access.sql}`,
      id,
      ...access.params,
    );
    if (!row) return res.status(404).json({ error: "工具运行记录不存在" });
    res.set("Cache-Control", "private, no-store");
    res.json({ run: toRun(row, req.user) });
  } catch (error) {
    if (error instanceof ToolboxValidationError)
      return res.status(400).json({ error: error.message });
    throw error;
  }
});

r.put("/runs/:id/pcal", (req, res) => {
  let transactionOpen = false;
  try {
    const id = parseRunId(req.params.id);
    const access = userScopeClause(req.user, "created_by");
    const row = q.scopedGet(
      "tool_runs",
      `AND id=?${access.sql}`,
      id,
      ...access.params,
    );
    if (!row) return res.status(404).json({ error: "工具运行记录不存在" });
    if (row.tool_key !== "pcal") {
      return res.status(409).json({ error: "只有私域日历支持逐日编辑" });
    }
    const visibleRun = toRun(row, req.user);
    if (
      row.status !== "done" ||
      visibleRun.canUse !== true ||
      visibleRun.verified !== true
    ) {
      return res
        .status(409)
        .json({ error: "仅已完成、已结算且可使用的私域日历可编辑" });
    }
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ToolboxValidationError("私域日历编辑请求必须是对象");
    }
    const topKeys = Object.keys(body);
    if (topKeys.some((key) => !["days", "expectedVersion"].includes(key))) {
      throw new ToolboxValidationError(
        "私域日历只允许修改每日朋友圈文案和社群话术",
      );
    }
    if (!Array.isArray(body.days) || body.days.length < 1) {
      throw new ToolboxValidationError("days必须至少包含一条每日修改");
    }
    const current = latestPrivateCalendarState(row, req.user.tenant_id);
    if (!current) {
      return res.status(409).json({ error: "私域日历结构已损坏，不能编辑" });
    }
    const expectedVersion =
      body.expectedVersion === undefined
        ? current.version
        : Number(body.expectedVersion);
    if (
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 0 ||
      expectedVersion !== current.version
    ) {
      return res.status(409).json({
        error: "私域日历已被其他会话更新，请刷新后再编辑",
        code: "PCAL_EDIT_VERSION_CONFLICT",
      });
    }
    const syncing = q.get(
      `SELECT 1 ok FROM tool_run_feishu_exports
      WHERE tenant_id=? AND run_id=? AND status='syncing'`,
      req.user.tenant_id,
      id,
    );
    if (syncing) {
      return res.status(409).json({
        error: "飞书同步进行中，请等待完成后再编辑日历",
        code: "PCAL_EXPORT_IN_PROGRESS",
      });
    }
    const byDate = new Map(
      current.calendar.days.map((day) => [day.date, { ...day }]),
    );
    const seen = new Set();
    for (const patch of body.days) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new ToolboxValidationError("每日修改必须是对象");
      }
      if (
        Object.keys(patch).some(
          (key) => !["date", "moment", "group"].includes(key),
        )
      ) {
        throw new ToolboxValidationError(
          "日期、星期、节日和月度提示属于原始日历结构，不能修改",
        );
      }
      const date = String(patch.date || "").trim();
      if (!date || !byDate.has(date) || seen.has(date)) {
        throw new ToolboxValidationError("每日修改包含非法或重复日期");
      }
      if (patch.moment === undefined && patch.group === undefined) {
        throw new ToolboxValidationError("每日修改必须包含moment或group");
      }
      for (const [field, label] of [
        ["moment", "朋友圈文案"],
        ["group", "社群话术"],
      ]) {
        if (patch[field] === undefined) continue;
        if (typeof patch[field] !== "string") {
          throw new ToolboxValidationError(`${label}必须是文本`);
        }
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(patch[field])) {
          throw new ToolboxValidationError(`${label}包含不允许的控制字符`);
        }
        if (patch[field].length > 1_000) {
          throw new ToolboxValidationError(`${label}不得超过1000字`);
        }
      }
      const day = byDate.get(date);
      byDate.set(date, {
        ...day,
        ...(patch.moment !== undefined ? { moment: patch.moment } : {}),
        ...(patch.group !== undefined ? { group: patch.group } : {}),
      });
      seen.add(date);
    }
    const inputs = jsonObject(row.input_json);
    const calendar = normalizePrivateCalendar(
      {
        month: current.calendar.month,
        tips: current.calendar.tips,
        days: current.calendar.days.map((day) => byDate.get(day.date)),
      },
      inputs.month,
    );
    if (JSON.stringify(calendar) === JSON.stringify(current.calendar)) {
      res.set("Cache-Control", "private, no-store");
      return res.json({ ok: true, idempotent: true, run: visibleRun });
    }

    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const lockedVersion = Number(
      q.get(
        `SELECT COALESCE(MAX(version),0) version
        FROM tool_run_pcal_edits WHERE tenant_id=? AND run_id=?`,
        req.user.tenant_id,
        id,
      )?.version || 0,
    );
    if (lockedVersion !== current.version) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return res.status(409).json({
        error: "私域日历已被其他会话更新，请刷新后再编辑",
        code: "PCAL_EDIT_VERSION_CONFLICT",
      });
    }
    q.run(
      `INSERT INTO tool_run_pcal_edits(
        tenant_id,run_id,version,calendar_json,created_by
      ) VALUES(?,?,?,?,?)`,
      req.user.tenant_id,
      id,
      current.version + 1,
      JSON.stringify(calendar),
      req.user.id,
    );
    db.exec("COMMIT");
    transactionOpen = false;
    logOp(
      req.user,
      "经营工具箱",
      "编辑私域日历",
      `pcal#${id}:v${current.version + 1}`,
    );
    const updatedRow = q.scopedGet(
      "tool_runs",
      `AND id=?${access.sql}`,
      id,
      ...access.params,
    );
    res.set("Cache-Control", "private, no-store");
    return res.json({
      ok: true,
      idempotent: false,
      run: toRun(updatedRow, req.user),
    });
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* preserve original error */
      }
    }
    if (error instanceof ToolboxValidationError) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }
});

r.post("/runs/:id/feishu", async (req, res) => {
  let claimed = false;
  let id = null;
  let calendarVersion = 0;
  try {
    id = parseRunId(req.params.id);
    const access = userScopeClause(req.user, "created_by");
    const row = q.scopedGet(
      "tool_runs",
      `AND id=?${access.sql}`,
      id,
      ...access.params,
    );
    if (!row) return res.status(404).json({ error: "工具运行记录不存在" });
    if (row.tool_key !== "pcal") {
      return res
        .status(409)
        .json({ error: "只有私域日历可同步到飞书多维表格" });
    }
    const visibleRun = toRun(row, req.user);
    if (
      row.status !== "done" ||
      visibleRun.canUse !== true ||
      visibleRun.verified !== true
    ) {
      return res
        .status(409)
        .json({ error: "仅已完成、已结算且可使用的私域日历可同步飞书" });
    }
    const pcalState = latestPrivateCalendarState(row, req.user.tenant_id);
    if (!pcalState) {
      return res
        .status(409)
        .json({ error: "私域日历结构已损坏，不能同步飞书" });
    }
    const calendar = pcalState.calendar;
    calendarVersion = pcalState.version;
    const tableName = `私域日历${calendar.month}`;
    const current = q.get(
      `SELECT status,calendar_version,export_version FROM tool_run_feishu_exports
      WHERE tenant_id=? AND run_id=?`,
      req.user.tenant_id,
      id,
    );
    if (
      current?.status === "done" &&
      Number(current.calendar_version || 0) === calendarVersion
    ) {
      res.set("Cache-Control", "private, no-store");
      return res.json({
        ok: true,
        idempotent: true,
        feishuExport: publicFeishuExport(
          id,
          req.user.tenant_id,
          calendarVersion,
        ),
      });
    }
    if (current?.status === "syncing") {
      return res
        .status(409)
        .json({ error: "该日历正在同步飞书，请勿重复提交" });
    }
    const config = feishuConfig(req.user.tenant_id);
    // 在任何外部请求之前完成固定域名、HTTPS、路径与 token 格式校验。
    // 解析结果只用于校验，不进入数据库、日志或响应。
    parseFeishuBitableUrl(config.bitableUrl);

    if (current) {
      const retried = q.run(
        `UPDATE tool_run_feishu_exports SET status='syncing',table_name=?,table_id='',synced=0,
          error_json=NULL,attempt_count=attempt_count+1,created_by=?,
          export_version=CASE WHEN calendar_version<>? THEN export_version+1 ELSE export_version END,
          calendar_version=?,updated_at=datetime('now','localtime')
        WHERE tenant_id=? AND run_id=? AND status IN ('failed','done')`,
        tableName,
        req.user.id,
        calendarVersion,
        calendarVersion,
        req.user.tenant_id,
        id,
      );
      if (Number(retried.changes) !== 1) {
        return res
          .status(409)
          .json({ error: "飞书同步状态已变化，请刷新后重试" });
      }
    } else {
      try {
        q.run(
          `INSERT INTO tool_run_feishu_exports(
            tenant_id,run_id,status,table_name,created_by,calendar_version,export_version
          ) VALUES(?,?,'syncing',?,?,?,1)`,
          req.user.tenant_id,
          id,
          tableName,
          req.user.id,
          calendarVersion,
        );
      } catch (error) {
        const raced = q.get(
          `SELECT status,calendar_version FROM tool_run_feishu_exports
          WHERE tenant_id=? AND run_id=?`,
          req.user.tenant_id,
          id,
        );
        if (
          raced?.status === "done" &&
          Number(raced.calendar_version || 0) === calendarVersion
        ) {
          return res.json({
            ok: true,
            idempotent: true,
            feishuExport: publicFeishuExport(
              id,
              req.user.tenant_id,
              calendarVersion,
            ),
          });
        }
        return res
          .status(409)
          .json({ error: "该日历正在同步飞书，请勿重复提交" });
      }
    }
    claimed = true;

    const injectedToken = req.app.locals.toolboxFeishuToken;
    const fetchFn = req.app.locals.toolboxFeishuFetch || fetch;
    const result = await syncPrivateCalendarToFeishu({
      calendar,
      bitableUrl: config.bitableUrl,
      fetchFn,
      tokenFn:
        typeof injectedToken === "function"
          ? () => injectedToken({ tenantId: req.user.tenant_id })
          : () =>
              feishuTenantToken(req.user.tenant_id, {
                fetchFn: req.app.locals.toolboxFeishuAuthFetch || fetch,
                useCache: !req.app.locals.toolboxFeishuAuthFetch,
              }),
      timeoutMs: req.app.locals.toolboxFeishuTimeoutMs,
    });
    const updated = q.run(
      `UPDATE tool_run_feishu_exports SET status='done',table_name=?,table_id=?,synced=?,
        error_json=NULL,updated_at=datetime('now','localtime')
      WHERE tenant_id=? AND run_id=? AND status='syncing' AND calendar_version=?`,
      result.table,
      result.tableId,
      result.synced,
      req.user.tenant_id,
      id,
      calendarVersion,
    );
    if (Number(updated.changes) !== 1) {
      throw Object.assign(new Error("飞书同步完成状态未能落库"), {
        code: "FEISHU_EXPORT_PERSIST_FAILED",
        status: 500,
      });
    }
    logOp(
      req.user,
      "经营工具箱",
      "私域日历同步飞书多维表格",
      `pcal#${id}:${result.synced}`,
    );
    res.set("Cache-Control", "private, no-store");
    return res.json({
      ok: true,
      idempotent: false,
      feishuExport: publicFeishuExport(id, req.user.tenant_id, calendarVersion),
    });
  } catch (error) {
    const safe =
      error instanceof FeishuBitableError
        ? error
        : Object.assign(new Error("飞书多维表格同步暂时不可用，请稍后重试"), {
            code: String(error?.code || "FEISHU_BITABLE_FAILED").slice(0, 120),
            status: Number(error?.status) || 502,
          });
    if (claimed && id) {
      q.run(
        `UPDATE tool_run_feishu_exports SET status='failed',table_id='',synced=0,error_json=?,
          updated_at=datetime('now','localtime')
        WHERE tenant_id=? AND run_id=? AND status='syncing' AND calendar_version=?`,
        JSON.stringify({
          code: String(safe.code || "FEISHU_BITABLE_FAILED").slice(0, 120),
          message: String(safe.message || "飞书同步失败").slice(0, 300),
        }),
        req.user.tenant_id,
        id,
        calendarVersion,
      );
    }
    return res.status(Number(safe.status) || 502).json({
      error: safe.message,
      code: safe.code,
      ...(claimed
        ? {
            feishuExport: publicFeishuExport(
              id,
              req.user.tenant_id,
              calendarVersion,
            ),
          }
        : {}),
    });
  }
});

r.post("/runs/:id/retry", async (req, res, next) => {
  let retryHold = null;
  try {
    const id = parseRunId(req.params.id);
    const access = userScopeClause(req.user, "created_by");
    const row = q.scopedGet(
      "tool_runs",
      `AND id=?${access.sql}`,
      id,
      ...access.params,
    );
    if (!row) return res.status(404).json({ error: "工具运行记录不存在" });
    if (row.status !== "failed")
      return res.status(409).json({ error: "只有失败任务可以免费重试" });
    if (toolboxJobActive(req.user.tenant_id, id))
      return res.status(409).json({ error: "该工具任务仍在后台执行" });
    const retryCount = Number(row.retry_count || 0);
    if (retryCount >= TOOLBOX_FREE_RETRY_LIMIT) {
      return res.status(409).json({
        error: `该任务已用完${TOOLBOX_FREE_RETRY_LIMIT}次免费重试额度`,
      });
    }
    const held = q.get(
      `SELECT id FROM credit_holds
      WHERE tenant_id=? AND ref_type='tool_run' AND ref_id=? AND status='held'
      ORDER BY id DESC LIMIT 1`,
      req.user.tenant_id,
      id,
    );
    if (held)
      return res
        .status(409)
        .json({ error: "该失败任务仍有预授权待退款或对账，暂不能重试" });
    const input = validateToolRunPayload({
      toolKey: row.tool_key,
      employeeIdx: Number(row.employee_idx),
      title: row.title,
      inputs: jsonObject(row.input_json),
    });
    await preflightLinkScriptInput(input, req.app.locals);
    const visionAsset =
      input.definition.key === "menu-copy"
        ? resolveMenuCopyFile(input.inputs.imageFileId, req.user)
        : null;
    const employeeExecution = buildEmployeeExecutionProfile(
      input.definition.employeeIdx,
      {
        tenantId: req.user.tenant_id,
        user: req.user,
        // 工具箱交付Markdown草案；沿用派活JSON契约会让质检必然失败。
        outputMode: "markdown_draft",
      },
    );
    const executionSpec = toolboxExecutionSpec(
      input.definition,
      employeeExecution,
      req.user.role,
    );
    const requestedModel = executionSpec.model;
    const initialDraft = generateToolboxDraft(input.definition, input.inputs);
    let initialBilling = {
      state: "not_applicable",
      estimatedCredits: 0,
      heldCredits: 0,
      chargedCredits: 0,
      credits: 0,
      pendingReconciliation: false,
      note: "真实AI通道未配置；本次重试会失败闭环且不生成本地底稿。",
    };
    if (toolboxProviderAvailable(executionSpec, req.app.locals)) {
      const estimatedCredits = toolboxEstimatedCredits(
        executionSpec,
        employeeExecution,
        input.inputs,
        visionAsset,
      );
      retryHold = holdCredits({
        userId: req.user.id,
        feature: `经营工具箱·${input.definition.title}`,
        kind: executionSpec.kind,
        model: requestedModel,
        credits: estimatedCredits,
        refType: "tool_run",
        refId: id,
        note: `工具任务#${id}免费重试预授权；只有形成合格结果才结算，失败继续全额退回，不重复收取失败轮次。`,
      });
      initialBilling = {
        ...twoPhaseBillingSummary({
          state: "held",
          hold: retryHold,
          note: "免费重试已预授权；失败不实扣。",
        }),
        requestedModel,
      };
    }
    const updated = q.run(
      `UPDATE tool_runs SET status='running',execution_state='retrying',
        retry_count=retry_count+1,result_md='',assumptions_json='[]',evidence_json='[]',error_json=NULL,
        progress_json='[]',last_heartbeat_at=datetime('now','localtime'),timeout_at=datetime('now','+12 minutes'),
        provenance_json=?,updated_at=datetime('now','localtime')
      WHERE tenant_id=? AND id=? AND status='failed' AND retry_count=?`,
      JSON.stringify({
        ...initialDraft.provenance,
        mode: retryHold ? "pending" : null,
        executionKind: executionSpec.kind,
        completionState: "retrying",
        employeeSnapshot: toolboxEmployeeSnapshot(employeeExecution),
        contract: {
          validator: "toolbox-delivery-contract",
          status: "pending",
          valid: false,
          errors: [],
        },
        billing: initialBilling,
        persisted: false,
      }),
      req.user.tenant_id,
      id,
      retryCount,
    );
    if (Number(updated.changes) !== 1)
      throw Object.assign(new Error("工具任务重试状态已变化"), { status: 409 });
    recordToolProgress(id, req.user.tenant_id, {
      phase: "retrying",
      message: `第${retryCount + 1}次免费重试已排队`,
    });
    const context = {
      runId: id,
      input,
      user: { ...req.user },
      employeeExecution,
      appLocals: req.app.locals,
      hold: retryHold,
      holdModel: requestedModel,
      executionKind: executionSpec.kind,
      initialBilling,
      requestedModel,
      retryCount: retryCount + 1,
      retrying: true,
      visionAsset,
    };
    const queued = enqueueToolboxContext(context);
    if (!queued.queued)
      throw Object.assign(new Error("工具任务已在后台执行"), { status: 409 });
    retryHold = null;
    const current = q.get(
      "SELECT * FROM tool_runs WHERE tenant_id=? AND id=?",
      req.user.tenant_id,
      id,
    );
    return res.status(202).json({
      run: toRun(current, req.user),
      queued: true,
      freeRetry: true,
      pollAfterMs: 2_000,
      pollUrl: `/toolbox/runs/${id}`,
      deepLink: `/tasks?kind=tool&id=${id}`,
      message: "免费重试已进入后台；失败轮次不实扣，任务中心会显示最新进度。",
    });
  } catch (error) {
    if (retryHold) {
      try {
        releaseHold(retryHold, "工具重试未成功入队，预授权全额退回");
      } catch {
        /* 留待账务对账 */
      }
    }
    return next(error);
  }
});

export async function createToolboxRunHttp(req, res, next) {
  let input;
  let hold = null;
  let runId = null;
  let employeeExecution = null;
  let initialDraft = null;
  let initialBilling = null;
  let requestedModel = null;
  let businessResultPersisted = false;
  let visionAsset = null;
  try {
    const prepared = prepareToolboxInput(req.body, req.user);
    input = prepared.input;
    visionAsset = prepared.visionAsset;
  } catch (error) {
    if (error instanceof ToolboxValidationError)
      return res.status(400).json({ error: error.message });
    return next(error);
  }

  try {
    await preflightLinkScriptInput(input, req.app.locals);
    const specialist = q.get(
      `SELECT id,employee_idx,person,name FROM specialists WHERE employee_idx=? LIMIT 1`,
      input.definition.employeeIdx,
    );
    const employeeName = specialist?.person || input.definition.employeeName;
    employeeExecution = buildEmployeeExecutionProfile(
      input.definition.employeeIdx,
      {
        tenantId: req.user.tenant_id,
        user: req.user,
        // 工具箱交付Markdown草案；沿用派活JSON契约会让质检必然失败。
        outputMode: "markdown_draft",
      },
    );
    const config = employeeExecution.workbench.workConfig;
    const executionSpec = toolboxExecutionSpec(
      input.definition,
      employeeExecution,
      req.user.role,
    );
    const holdModel = executionSpec.model;
    requestedModel = holdModel;
    initialDraft = generateToolboxDraft(input.definition, input.inputs);
    if (toolboxProviderAvailable(executionSpec, req.app.locals)) {
      // 可能真实发起两轮供应商请求，必须在第一轮之前一次性占扣两轮的
      // 输入上下文、固定开销与输出上限，不允许首轮调用后再追加占扣。
      // 图片/视频工具只调用一次媒体供应商，按单件媒体最高价预授权。
      const estimatedCredits = toolboxEstimatedCredits(
        executionSpec,
        employeeExecution,
        input.inputs,
        visionAsset,
      );
      if (config.maxCost != null && estimatedCredits > Number(config.maxCost)) {
        throw Object.assign(
          new Error(
            `本次预计需${estimatedCredits}积分，超过员工配置的${config.maxCost}积分上限`,
          ),
          { status: 422 },
        );
      }
      hold = holdCredits({
        userId: req.user.id,
        feature: `经营工具箱·${input.definition.title}`,
        kind: executionSpec.kind,
        model: holdModel,
        credits: estimatedCredits,
        note: executionSpec.vision
          ? `工具“${input.title}”按一次真实视觉模型识图与结构化文案输出预授权；未形成完整五字段交付则全额退回。`
          : executionSpec.kind === "text"
            ? `工具“${input.title}”按完整员工提示词、${config.outputLength}篇幅与最多${TOOLBOX_AI_MAX_ATTEMPTS}轮调用一次性预授权；未交付则全额退回。`
            : `工具“${input.title}”按一次真实${executionSpec.kind === "image" ? "图片" : "视频"}生成预授权；未形成可预览媒体产物则全额退回。`,
      });
    }
    const inputJson = JSON.stringify(input.inputs);
    initialBilling = hold
      ? {
          ...twoPhaseBillingSummary({
            state: "held",
            hold,
            note: "已预授权，等待业务产物落库与实际用量结算。",
          }),
          requestedModel,
        }
      : {
          state: "not_applicable",
          estimatedCredits: 0,
          heldCredits: 0,
          chargedCredits: 0,
          credits: 0,
          pendingReconciliation: false,
          note: "当前没有真实AI生成通道；任务将失败闭环且不产生业务产物或费用。",
        };
    const startingProvenance = {
      ...initialDraft.provenance,
      mode: hold ? "pending" : initialDraft.provenance.mode,
      executionKind: executionSpec.kind,
      completionState: "generating",
      employeeSnapshot: toolboxEmployeeSnapshot(employeeExecution),
      contract: {
        validator: "toolbox-delivery-contract",
        status: "pending",
        valid: false,
        requiresManualRepair: false,
        errors: [],
      },
      billing: initialBilling,
      ...(req.toolboxAutomation
        ? {
            automation: {
              id: Number(req.toolboxAutomation.id),
              key: String(req.toolboxAutomation.key || "").slice(0, 40),
              trigger: String(req.toolboxAutomation.trigger || "").slice(0, 20),
              claimKey: String(req.toolboxAutomation.claimKey || "").slice(
                0,
                180,
              ),
              attemptCount: Number(req.toolboxAutomation.attemptCount || 1),
            },
          }
        : {}),
      persisted: false,
    };

    // 先创建用户可见的 running 记录，并在同一 savepoint 内把预授权绑定到它。
    // 只有这一步完成后才允许调用外部模型；因此上游异常和退款异常都能落到明确 runId。
    db.exec("SAVEPOINT create_toolbox_run");
    try {
      const inserted = q.run(
        `INSERT INTO tool_runs(
        tool_key,tool_title,title,status,employee_idx,employee_name,specialist_id,created_by,
        input_json,input_summary,result_md,assumptions_json,evidence_json,provenance_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        input.definition.key,
        input.definition.title,
        input.title,
        "running",
        input.definition.employeeIdx,
        employeeName,
        specialist?.id || null,
        req.user.id,
        inputJson,
        initialDraft.inputSummary,
        "# 工具运行中\n\n数字员工正在生成结果；完成质检和账务结算前，本记录仅用于执行审计，尚不是业务产物。",
        "[]",
        "[]",
        JSON.stringify(startingProvenance),
      );
      runId = Number(inserted.lastInsertRowid);
      if (hold) {
        const linked = q.run(
          `UPDATE credit_holds SET ref_type='tool_run',ref_id=?
          WHERE tenant_id=? AND id=? AND status='held' AND ref_type IS NULL AND ref_id IS NULL`,
          runId,
          req.user.tenant_id,
          hold.holdId,
        );
        if (Number(linked.changes) !== 1) {
          throw Object.assign(new Error("工具运行未能绑定本次有效预授权"), {
            status: 409,
            code: "TOOLBOX_HOLD_LINK_FAILED",
          });
        }
      }
      if (req.toolboxAutomation) {
        const automationId = Number(req.toolboxAutomation.id);
        if (!Number.isSafeInteger(automationId) || automationId <= 0) {
          throw Object.assign(new Error("自动化运行ID不正确"), {
            status: 409,
            code: "TOOLBOX_AUTOMATION_LINK_INVALID",
          });
        }
        const automationLinked = q.run(
          `UPDATE toolbox_automation_runs SET tool_run_id=?,status='running',
            updated_at=datetime('now','localtime')
          WHERE tenant_id=? AND id=? AND created_by=?
            AND status IN ('claimed','enqueuing') AND tool_run_id IS NULL`,
          runId,
          req.user.tenant_id,
          automationId,
          req.user.id,
        );
        if (Number(automationLinked.changes) !== 1) {
          throw Object.assign(new Error("工具运行未能绑定本次自动化claim"), {
            status: 409,
            code: "TOOLBOX_AUTOMATION_LINK_FAILED",
          });
        }
      }
      db.exec("RELEASE SAVEPOINT create_toolbox_run");
      recordToolProgress(runId, req.user.tenant_id, {
        phase: "queued",
        message: "工具任务已创建，等待执行",
      });
    } catch (error) {
      db.exec("ROLLBACK TO SAVEPOINT create_toolbox_run");
      db.exec("RELEASE SAVEPOINT create_toolbox_run");
      throw error;
    }

    const context = {
      runId,
      input,
      user: { ...req.user },
      employeeExecution,
      appLocals: req.app.locals,
      hold,
      holdModel,
      executionKind: executionSpec.kind,
      initialBilling,
      requestedModel,
      retryCount: 0,
      retrying: false,
      visionAsset,
      automation: req.toolboxAutomation || null,
    };
    const queued = enqueueToolboxContext(context);
    if (!queued.queued)
      throw Object.assign(new Error("工具任务已在后台执行"), { status: 409 });
    // 预授权对象的所有权已经交给后台worker；HTTP请求退出时不得重复释放。
    hold = null;
    businessResultPersisted = true;
    const row = q.get(
      "SELECT * FROM tool_runs WHERE tenant_id=? AND id=?",
      req.user.tenant_id,
      runId,
    );
    res.status(202).json({
      run: toRun(row, req.user),
      billing: initialBilling,
      queued: true,
      pollAfterMs: 2_000,
      pollUrl: `/toolbox/runs/${runId}`,
      deepLink: `/tasks?kind=tool&id=${runId}`,
      message: `${input.definition.title}已进入后台执行；搜索、受控取证、模型生成和账务进度可在任务中心持续查看。`,
    });
  } catch (error) {
    let failureBilling = initialBilling;
    if (hold) {
      try {
        const released = releaseHold(hold, "工具箱任务未交付，预授权全额退回");
        if (!released) throw new Error("工具箱预授权未完成本次释放");
        failureBilling = {
          ...twoPhaseBillingSummary({
            state: "released",
            hold,
            settled: released,
            note: "工具运行未交付，预授权已全额退回。",
          }),
          requestedModel,
        };
      } catch (releaseError) {
        failureBilling = {
          ...twoPhaseBillingSummary({
            state: "pending_reconciliation",
            hold,
            error: releaseError,
            note: "工具运行未交付，但预授权释放尚未确认，需人工对账。",
          }),
          requestedModel,
        };
      }
      hold = null;
    }
    if (runId && !businessResultPersisted) {
      const existing = q.scopedGet("tool_runs", "AND id=?", runId);
      if (existing) {
        const failureProvenance = {
          ...jsonObject(existing.provenance_json),
          completionState: "failed",
          contract: {
            validator: "toolbox-delivery-contract",
            status: "invalid",
            valid: false,
            requiresManualRepair: true,
            errors: ["工具运行未形成可交付产物"],
          },
          billing: failureBilling,
          ...(error?.researchEvidence
            ? { publicResearch: error.researchEvidence }
            : {}),
          ...(error?.providerEvidence
            ? { providerAttempt: error.providerEvidence }
            : {}),
          persisted: true,
        };
        q.run(
          `UPDATE tool_runs SET status='failed',result_md=?,assumptions_json='[]',evidence_json='[]',
          provenance_json=?,error_json=?,updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?`,
          "# 工具运行未完成\n\n外部生成或结果落库未完成。本记录仅供审计，请按页面提示重跑或等待账务对账。",
          JSON.stringify(failureProvenance),
          JSON.stringify({
            code: String(error?.code || "TOOLBOX_EXECUTION_FAILED").slice(
              0,
              120,
            ),
            message: String(error?.message || "工具运行失败").slice(0, 500),
          }),
          req.user.tenant_id,
          runId,
        );
        recordToolProgress(runId, req.user.tenant_id, {
          phase: "failed",
          message: String(error?.message || "工具运行失败").slice(0, 300),
        });
        q.run(
          `INSERT OR IGNORE INTO tool_run_events(
          run_id,event_type,tool_key,employee_idx,user_id,status,source_system,metadata_json
        ) VALUES(?,?,?,?,?,'failed','nanowork',?)`,
          runId,
          "generated",
          input.definition.key,
          input.definition.employeeIdx,
          req.user.id,
          JSON.stringify({ mode: "failed", reason: "delivery_failed" }),
        );
      }
    }
    return next(error);
  }
}

// 定时自动化与 HTTP 手动运行共用同一个创建、预授权、后台 worker、
// 真实 agentic→受控取证→Yunwu-only 和结算闭环；这里只把 Express 响应投影成
// 可编排 Promise，不存在第二套模板或降级生成路径。
export function createToolboxBackgroundRun({
  body,
  user,
  appLocals = {},
  automation = null,
}) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    const req = {
      body,
      user,
      app: { locals: appLocals },
      toolboxAutomation: automation,
    };
    const res = {
      status(code) {
        statusCode = Number(code) || 500;
        return this;
      },
      json(payload) {
        if (statusCode >= 400) {
          const error = Object.assign(
            new Error(payload?.error || "工具后台任务创建失败"),
            {
              status: statusCode,
              code: payload?.code || "TOOLBOX_RUN_CREATE_FAILED",
            },
          );
          finish(reject, error);
        } else {
          finish(resolve, {
            ...payload,
            runId: Number(payload?.run?.id || payload?.id || 0) || null,
          });
        }
        return this;
      },
    };
    const next = (error) =>
      finish(
        reject,
        error ||
          Object.assign(new Error("工具后台任务创建失败"), {
            status: 500,
            code: "TOOLBOX_RUN_CREATE_FAILED",
          }),
      );
    Promise.resolve(createToolboxRunHttp(req, res, next)).catch(next);
  });
}

r.post("/runs", createToolboxRunHttp);

export default r;
