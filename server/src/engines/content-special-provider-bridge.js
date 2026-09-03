import { createHash } from "node:crypto";

import {
  estimateMaxCredits,
  holdCredits,
  releaseHold,
  settleHold,
} from "./credits.js";
import { contentPaidMediaAuthorizationReservation } from "./content-paid-media-authorization.js";
import { sanitizeProviderError } from "./provider-errors.js";
import { executeHeldDelivery } from "./two-phase-delivery.js";
import { generateImage } from "./yunwu.js";

export const CONTENT_SPECIAL_PROVIDER_BRIDGE_SCHEMA =
  "nanowork.content-special-provider-bridge/2";

export const CONTENT_SPECIAL_PROVIDER_REF_TYPE = "content_special_provider";

const PROVIDER_KIND_CODE = Object.freeze({ material: 1, image: 2 });

const REQUIRED_EMPLOYEE_PACKAGE_FIELDS = Object.freeze([
  "identity",
  "capabilities",
  "workMethod",
  "prompts",
  "runtimeBindings",
  "workConfig",
  "jobProfile",
]);
const CREDENTIAL_KEY =
  /(?:^|_)(?:api_?key|authorization|cookie|credential|password|private_?key|secret|access_?token|refresh_?token)(?:$|_)/iu;
const SECRET_TEXT_PATTERNS = Object.freeze([
  Object.freeze({
    pattern: /\bsk-\s*[a-z0-9_-]{8,}\b/giu,
    replacement: "[REDACTED]",
  }),
  Object.freeze({
    pattern: /\bBearer\s+[a-z0-9._~+\/-]{8,}\b/giu,
    replacement: "[REDACTED]",
  }),
  Object.freeze({
    pattern:
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[:=]\s*)[^\s,;]+/giu,
    replacement: "$1[REDACTED]",
  }),
]);

// 当前 OpenLux gpt-image-2 兼容端点明确限制 prompt 最多 1000 字符。
// 留出 10% 安全边界，避免网关按不同 Unicode 计数方式把合法业务请求拒成 400。
const IMAGE_PROVIDER_PROMPT_MAX_CHARS = 900;
const IMAGE_PROVIDER_TASK_MAX_CHARS = 140;
const IMAGE_PROVIDER_RUNTIME_MAX_CHARS = 100;
const IMAGE_PROVIDER_PACKAGE_MAX_CHARS = 320;
const IMAGE_PROVIDER_SLOT_MAX_CHARS = 180;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redactText(value) {
  let output = String(value ?? "");
  for (const { pattern, replacement } of SECRET_TEXT_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

function sanitizeValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactText(value);
  if (value === null || ["number", "boolean"].includes(typeof value))
    return value;
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[CIRCULAR_REMOVED]";
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => sanitizeValue(item, seen));
    seen.delete(value);
    return output;
  }
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key)) continue;
    const sanitized = sanitizeValue(child, seen);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  seen.delete(value);
  return output;
}

function withoutLegacyGenerationStyles(value) {
  const sanitized = sanitizeValue(value);
  if (!sanitized || typeof sanitized !== "object") return sanitized;
  const visit = (current) => {
    if (!current || typeof current !== "object") return;
    if (!Array.isArray(current)) {
      delete current.xhs_style;
      delete current.dy_style;
    }
    for (const child of Object.values(current)) visit(child);
  };
  visit(sanitized);
  return sanitized;
}

function withoutImagePlan(value) {
  const sanitized = withoutLegacyGenerationStyles(value);
  if (!isRecord(sanitized)) return sanitized;
  if (isRecord(sanitized.media_request)) delete sanitized.media_request.plan;
  if (isRecord(sanitized.cover_request)) delete sanitized.cover_request.plan;
  delete sanitized.imagePlan;
  delete sanitized.coverPlan;
  return sanitized;
}

function hasCredentialField(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key) || hasCredentialField(child, seen))
      return true;
  }
  return false;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function fingerprint(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex")}`;
}

function boundedProviderText(value, maxChars) {
  const text = redactText(value).trim();
  if (text.length <= maxChars) return text;
  const marker =
    "\n…[已由服务端按图片接口上限压缩，完整原文仍保留在任务上下文]…\n";
  const remaining = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(remaining * 0.72);
  const tail = remaining - head;
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`;
}

function compactProviderValue(
  value,
  {
    depth = 0,
    maxDepth = 6,
    stringLimit = 420,
    arrayLimit = 12,
    objectLimit = 36,
  } = {},
) {
  if (typeof value === "string") return boundedProviderText(value, stringLimit);
  if (value === null || ["number", "boolean"].includes(typeof value))
    return value;
  if (typeof value !== "object") return undefined;
  if (depth >= maxDepth) return "[完整配置已在服务端装载；此处省略深层正文]";
  const next = {
    depth: depth + 1,
    maxDepth,
    stringLimit,
    arrayLimit,
    objectLimit,
  };
  if (Array.isArray(value)) {
    return value
      .slice(0, arrayLimit)
      .map((item) => compactProviderValue(item, next))
      .filter((item) => item !== undefined);
  }
  const output = {};
  for (const [key, child] of Object.entries(value).slice(0, objectLimit)) {
    if (CREDENTIAL_KEY.test(key)) continue;
    const compacted = compactProviderValue(child, next);
    if (compacted !== undefined) output[key] = compacted;
  }
  return output;
}

function compactProviderJson(value, maxChars) {
  const passes = [
    { maxDepth: 7, stringLimit: 420, arrayLimit: 14, objectLimit: 40 },
    { maxDepth: 6, stringLimit: 260, arrayLimit: 10, objectLimit: 30 },
    { maxDepth: 5, stringLimit: 140, arrayLimit: 7, objectLimit: 24 },
  ];
  for (const options of passes) {
    const compacted = compactProviderValue(value, options);
    const json = JSON.stringify(compacted);
    if (json.length <= maxChars) return { json, compacted, truncated: false };
  }
  const fallback = {
    v: "image-brief/1",
    fp: fingerprint(value),
    role: boundedProviderText(value?.role?.name || "内容视觉岗位", 36),
    duty: boundedProviderText(value?.role?.duty || "按任务生成真实位图", 56),
    quality: boundedProviderText(
      Array.isArray(value?.quality) ? value.quality.join("；") : value?.quality,
      70,
    ),
    boundary: boundedProviderText(
      Array.isArray(value?.boundaries)
        ? value.boundaries.join("；")
        : value?.boundaries,
      80,
    ),
  };
  const fallbackJson = JSON.stringify(fallback);
  return {
    json: boundedProviderText(fallbackJson, maxChars),
    compacted: fallback,
    truncated: true,
  };
}

function providerExecutionPackage(employeePackage) {
  const skills = employeePackage.skills || employeePackage.skillLibrary || {};
  const enabledSkills = [
    ...(Array.isArray(skills.required) ? skills.required : []),
    ...(Array.isArray(skills.enabled) ? skills.enabled : []),
  ];
  const uniqueSkills = [];
  const seenSkills = new Set();
  for (const skill of enabledSkills) {
    if (!isRecord(skill)) continue;
    const title = redactText(skill.title || skill.name || "").trim();
    if (!title || seenSkills.has(title)) continue;
    seenSkills.add(title);
    uniqueSkills.push({
      title,
      detail: redactText(skill.detail || skill.desc || ""),
      required: skill.required === true,
      enabled: skill.enabled !== false,
      locked: skill.locked === true,
      verificationStatus: redactText(skill.verificationStatus || "") || null,
    });
  }
  const jobProfile = isRecord(employeePackage.jobProfile)
    ? employeePackage.jobProfile
    : {};
  const promptRules = [
    employeePackage.prompts?.systemPrompt?.template,
    employeePackage.prompts?.soloPrompt?.template,
  ]
    .map((item) => redactText(item || "").trim())
    .filter(Boolean);
  return sanitizeValue({
    v: "image-brief/1",
    fp:
      employeePackage.version?.aggregateFingerprint ||
      employeePackage.fingerprints?.aggregate ||
      fingerprint(employeePackage),
    role: {
      name: employeePackage.identity?.name || "内容视觉岗位",
      duty: employeePackage.identity?.duty || jobProfile.duty || "",
    },
    capabilities: (employeePackage.capabilities || [])
      .filter((capability) => capability?.enabled !== false)
      .map((capability) => capability?.name)
      .filter(Boolean),
    skills: uniqueSkills.map((skill) => skill.title),
    deliverables:
      jobProfile.expectedDeliverables || jobProfile.outputKeys || [],
    quality: jobProfile.qualityStandards || [],
    boundaries:
      jobProfile.safetyBoundaries ||
      jobProfile.boundaries ||
      employeePackage.contracts?.approval?.boundaries ||
      [],
    approval: employeePackage.workMethod?.approval || null,
    promptRules,
  });
}

function attemptNamespace(value) {
  const normalized = String(value || "content-special-provider")
    .normalize("NFKC")
    .replace(/[^a-z0-9_-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return normalized || "content-special-provider";
}

function stablePositiveRefId(value) {
  const hex = createHash("sha256")
    .update(String(value), "utf8")
    .digest("hex")
    .slice(0, 13);
  const refId = Number.parseInt(hex, 16) + 1;
  if (!Number.isSafeInteger(refId) || refId <= 0) {
    throw Object.assign(new Error("特殊provider稳定计费引用生成失败"), {
      status: 500,
      code: "CONTENT_SPECIAL_PROVIDER_REFERENCE_INVALID",
    });
  }
  return refId;
}

export function contentSpecialProviderAttemptIdentity({
  namespace,
  runId,
  employeeIdx,
  kind,
  attemptOrdinal = 1,
  requestFingerprint,
} = {}) {
  const normalizedRunId = positiveInteger(runId, "runId");
  const normalizedEmployeeIdx = employeeIndex(employeeIdx);
  const normalizedAttemptOrdinal = positiveInteger(
    attemptOrdinal,
    "attemptOrdinal",
  );
  if (!Object.hasOwn(PROVIDER_KIND_CODE, kind)) {
    throw Object.assign(new Error("特殊provider kind必须是image或material"), {
      status: 400,
    });
  }
  const scope = attemptNamespace(namespace);
  const attemptId =
    `${scope}:pipeline:${normalizedRunId}:station:${normalizedEmployeeIdx}` +
    `:provider:${kind}:attempt:${normalizedAttemptOrdinal}`;
  return Object.freeze({
    schemaVersion: "nanowork.content-special-provider-attempt-identity/1",
    namespace: scope,
    runId: normalizedRunId,
    employeeIdx: normalizedEmployeeIdx,
    kind,
    kindCode: PROVIDER_KIND_CODE[kind],
    attemptOrdinal: normalizedAttemptOrdinal,
    attemptId,
    refType: CONTENT_SPECIAL_PROVIDER_REF_TYPE,
    refId: stablePositiveRefId(attemptId),
    requestFingerprint: String(requestFingerprint || ""),
  });
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw Object.assign(new Error(`${label}必须是正整数`), { status: 400 });
  }
  return number;
}

function employeeIndex(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 9) {
    throw Object.assign(new Error("employeeIdx必须是0-9之间的整数"), {
      status: 400,
    });
  }
  return number;
}

function nonEmptyText(value, label, max = 240) {
  const text = redactText(value).trim();
  if (!text)
    throw Object.assign(new Error(`${label}不能为空`), { status: 400 });
  if (text.length > max)
    throw Object.assign(new Error(`${label}不能超过${max}个字符`), {
      status: 400,
    });
  return text;
}

function normalizeEmployeePackage(value, employeeIdx) {
  if (!isRecord(value)) {
    throw Object.assign(new Error("完整员工包必须是对象"), { status: 400 });
  }
  const missing = REQUIRED_EMPLOYEE_PACKAGE_FIELDS.filter((field) =>
    field === "capabilities"
      ? !Array.isArray(value[field])
      : !isRecord(value[field]),
  );
  const hasSkills = isRecord(value.skills) || isRecord(value.skillLibrary);
  if (!hasSkills) missing.push("skills/skillLibrary");
  if (missing.length) {
    throw Object.assign(new Error(`完整员工包缺少：${missing.join("、")}`), {
      status: 400,
    });
  }
  if (Number(value.identity?.idx) !== employeeIdx) {
    throw Object.assign(new Error("完整员工包与employeeIdx不一致"), {
      status: 400,
    });
  }
  return sanitizeValue(value);
}

function normalizeRequest(value) {
  if (!isRecord(value))
    throw Object.assign(new Error("provider请求必须是对象"), { status: 400 });
  if (hasCredentialField(value)) {
    throw Object.assign(
      new Error("provider请求不能携带API Key、Token或其他凭据"),
      { status: 400 },
    );
  }
  const request = sanitizeValue(value);
  const prompt = nonEmptyText(request.prompt, "provider请求.prompt", 200_000);
  if (!Object.hasOwn(request, "image_count")) {
    throw Object.assign(
      new Error("provider请求必须保留Paihuo Brief原字段image_count"),
      { status: 400 },
    );
  }
  const imageMode = String(request.image_mode || "").trim();
  if (!["real", "mix", "ai"].includes(imageMode)) {
    throw Object.assign(
      new Error("provider请求.image_mode必须是real、mix或ai"),
      { status: 400 },
    );
  }
  const rawCount = request.image_count;
  const autoCount =
    rawCount === null || rawCount === undefined || Number(rawCount) === 0;
  let imageCount = null;
  if (!autoCount) {
    imageCount = positiveInteger(rawCount, "provider请求.image_count");
    if (imageCount > 12) {
      throw Object.assign(new Error("provider请求.image_count不能超过12"), {
        status: 400,
      });
    }
  }
  if (!Array.isArray(request.platforms)) {
    throw Object.assign(new Error("provider请求.platforms必须是数组"), {
      status: 400,
    });
  }
  const platforms = [
    ...new Set(
      request.platforms
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ),
  ].slice(0, 6);
  const explicitSize =
    Object.hasOwn(value, "size") && String(value.size ?? "").trim().length > 0;
  const size = explicitSize
    ? String(request.size).trim()
    : platforms.length === 1 && platforms[0] === "小红书"
      ? "1024x1536"
      : "1024x1024";
  if (!/^\d{3,5}x\d{3,5}$/u.test(size)) {
    throw Object.assign(new Error("provider请求.size必须是宽x高"), {
      status: 400,
    });
  }
  const excludedLegacyStyleFields = ["xhs_style", "dy_style"].filter((field) =>
    Object.hasOwn(request, field),
  );
  const normalized = {
    ...request,
    prompt,
    image_mode: imageMode,
    image_count: imageCount,
    image_count_mode: autoCount ? "auto" : "explicit",
    platforms,
    size,
    size_source: explicitSize
      ? "explicit"
      : platforms.length === 1 && platforms[0] === "小红书"
        ? "platform_default"
        : "generic_default",
    excludedLegacyStyleFields,
  };
  delete normalized.xhs_style;
  delete normalized.dy_style;
  delete normalized.count;
  delete normalized.imageCount;
  delete normalized.imageMode;
  return normalized;
}

function normalizedRuntimeImagePlan(runtimeInput) {
  const source = Array.isArray(runtimeInput?.imagePlan)
    ? runtimeInput.imagePlan
    : Array.isArray(runtimeInput?.coverPlan)
      ? runtimeInput.coverPlan
      : Array.isArray(runtimeInput?.variables?.media_request?.plan)
        ? runtimeInput.variables.media_request.plan
        : Array.isArray(runtimeInput?.variables?.cover_request?.plan)
          ? runtimeInput.variables.cover_request.plan
          : [];
  return source
    .slice(0, 12)
    .map((item) => {
      if (!isRecord(item)) return null;
      const slot = redactText(item.slot || "")
        .trim()
        .slice(0, 160);
      const desc = redactText(item.desc || item.description || "")
        .trim()
        .slice(0, 2_000);
      const size = String(item.size || "").trim();
      const platform = redactText(item.platform || "")
        .trim()
        .slice(0, 120);
      const displaySize = redactText(
        item.displaySize || item.display_size || "",
      )
        .trim()
        .slice(0, 120);
      const style = redactText(item.style || "")
        .trim()
        .slice(0, 120);
      return slot && desc
        ? {
            slot,
            desc,
            source:
              runtimeInput?.purpose === "platform_covers"
                ? "cover_platform_plan"
                : "upstream_image_plan",
            ...(platform ? { platform } : {}),
            ...(/^\d{3,5}x\d{3,5}$/u.test(size) ? { size } : {}),
            ...(displaySize ? { displaySize } : {}),
            ...(style ? { style } : {}),
          }
        : null;
    })
    .filter(Boolean);
}

function resolvedImageSlots(runtimeInput, requestedCount) {
  const plan = normalizedRuntimeImagePlan(runtimeInput);
  return Array.from(
    { length: requestedCount },
    (_, index) =>
      plan[index] || {
        slot: `配图${index + 1}`,
        desc: `围绕本次业务任务生成第${index + 1}张独立配图`,
        source: plan.length ? "derived_plan_overflow" : "derived_runtime_slot",
        size: null,
      },
  );
}

function publicImageSlotEvidence(item, index) {
  return {
    ordinal: index + 1,
    source: redactText(item.source || item.slotSource || "unknown").slice(
      0,
      80,
    ),
    slotFingerprint: String(
      item.slotFingerprint ||
        fingerprint({
          slot: item.slot || "",
          desc: item.desc || item.description || "",
        }),
    ),
    providerPromptSha256: String(item.providerPromptSha256 || ""),
    providerPromptChars:
      Number.isSafeInteger(Number(item.providerPromptChars)) &&
      Number(item.providerPromptChars) >= 0
        ? Number(item.providerPromptChars)
        : null,
    providerPromptMaxChars: IMAGE_PROVIDER_PROMPT_MAX_CHARS,
    providerPromptWithinLimit:
      Number.isSafeInteger(Number(item.providerPromptChars)) &&
      Number(item.providerPromptChars) <= IMAGE_PROVIDER_PROMPT_MAX_CHARS,
    idempotencyKeySha256: String(item.idempotencyKeySha256 || ""),
    platform: redactText(item.platform || "").slice(0, 120) || null,
    requestedSize: /^\d{3,5}x\d{3,5}$/u.test(String(item.size || ""))
      ? String(item.size)
      : null,
    displaySize: redactText(item.displaySize || "").slice(0, 120) || null,
    rawSlotIncluded: false,
    rawPromptIncluded: false,
  };
}

function imageSlotEvidenceFromOutput(output) {
  return providerEntries(output).map((item, index) =>
    publicImageSlotEvidence(item, index),
  );
}

function providerEntries(value) {
  const source = [
    ...(Array.isArray(value?.images) ? value.images : []),
    ...(Array.isArray(value?.assets) ? value.assets : []),
  ];
  if (!source.length && (value?.url || value?.b64 || value?.file))
    source.push(value);
  return source.filter(
    (item) =>
      isRecord(item) && (item.url || item.b64 || item.file || item.content),
  );
}

function publicDelivery(value) {
  if (!isRecord(value)) return null;
  const artifactIds = Array.isArray(value.artifactIds)
    ? value.artifactIds
        .map((item) => redactText(item).slice(0, 160))
        .filter(Boolean)
        .slice(0, 20)
    : [];
  const artifactId = redactText(
    value.artifactId || value.businessArtifactId || "",
  ).slice(0, 160);
  return {
    persisted: value.persisted === true,
    artifactIds: artifactIds.length
      ? artifactIds
      : artifactId
        ? [artifactId]
        : [],
    targetType: redactText(value.targetType || "").slice(0, 100) || null,
    targetId: Number.isSafeInteger(Number(value.targetId))
      ? Number(value.targetId)
      : null,
  };
}

function assertPersistedDelivery(value) {
  const delivery = publicDelivery(value);
  if (!delivery?.persisted || !delivery.artifactIds.length) {
    throw Object.assign(new Error("provider业务产物持久化回执无效，禁止结算"), {
      status: 500,
      code: "CONTENT_SPECIAL_PROVIDER_PERSISTENCE_INVALID",
    });
  }
  return delivery;
}

function providerAttemptBillingPending(attempt) {
  const billing = isRecord(attempt?.billing) ? attempt.billing : {};
  const settlement = isRecord(attempt?.settlement) ? attempt.settlement : {};
  return (
    attempt?.status === "pending_reconciliation" ||
    billing.state === "pending_reconciliation" ||
    billing.pendingReconciliation === true ||
    settlement.pendingReconciliation === true
  );
}

function publicProviderAttemptBilling(attempt) {
  const billing = isRecord(attempt?.billing) ? clone(attempt.billing) : {};
  return {
    attemptId: redactText(attempt?.attemptId || "").slice(0, 160),
    kind: redactText(attempt?.kind || "").slice(0, 40),
    status: redactText(attempt?.status || billing.state || "").slice(0, 80),
    refType: redactText(
      attempt?.hold?.refType || attempt?.idempotency?.refType || "",
    ).slice(0, 100),
    refId:
      Number(attempt?.hold?.refId || attempt?.idempotency?.refId || 0) || null,
    holdId: Number(attempt?.hold?.holdId || billing.holdId || 0) || null,
    billing,
    delivery: publicDelivery(attempt?.delivery),
    replayed: attempt?.replayed === true,
  };
}

/**
 * 把文本交付与图片/素材provider的独立账务汇总为一个业务交付账单。
 * 主账单仍保留自己的holdId，components记录每一笔权威占扣；任一专项账单
 * 未结清时整体必须是pending_reconciliation，不能用文本已结算冒充全链路完成。
 */
export function mergeContentSpecialProviderBillingEvidence(
  primaryBilling,
  rawAttempts = [],
  {
    primaryComponent = "text",
    pendingNote = "主产物已持久化，但图片/素材provider仍有预授权待对账。",
    settledNote = "文本与图片/素材provider均已完成权威结算。",
  } = {},
) {
  const primary = isRecord(primaryBilling) ? clone(primaryBilling) : null;
  const sourceAttempts = (Array.isArray(rawAttempts) ? rawAttempts : []).filter(
    isRecord,
  );
  const attempts = sourceAttempts.map(publicProviderAttemptBilling);
  if (!attempts.length) return primary;

  const terminalBilling = new Set(["settled", "released", "not_held"]);
  const pending =
    sourceAttempts.some(providerAttemptBillingPending) ||
    primary?.state === "pending_reconciliation" ||
    primary?.pendingReconciliation === true ||
    attempts.some(
      (attempt) => !terminalBilling.has(String(attempt.billing?.state || "")),
    );
  const estimatedCredits =
    Number(primary?.estimatedCredits || 0) +
    attempts.reduce(
      (sum, attempt) => sum + Number(attempt.billing?.estimatedCredits || 0),
      0,
    );
  const heldCredits =
    Number(primary?.heldCredits || 0) +
    attempts.reduce(
      (sum, attempt) => sum + Number(attempt.billing?.heldCredits || 0),
      0,
    );
  const settledCredits =
    Number(primary?.chargedCredits || 0) +
    attempts.reduce(
      (sum, attempt) => sum + Number(attempt.billing?.chargedCredits || 0),
      0,
    );
  const latestBalance =
    primary?.balance ??
    attempts
      .map((attempt) => attempt.billing?.balance)
      .filter(
        (value) =>
          value !== null &&
          value !== undefined &&
          Number.isFinite(Number(value)),
      )
      .at(-1);

  return {
    ...(primary || {}),
    state: pending ? "pending_reconciliation" : "settled",
    pendingReconciliation: pending,
    estimatedCredits,
    heldCredits: pending ? heldCredits : 0,
    chargedCredits: pending ? null : settledCredits,
    credits: pending ? null : settledCredits,
    balance: latestBalance === undefined ? null : Number(latestBalance),
    costYuan: pending
      ? null
      : Number(primary?.costYuan || 0) +
        attempts.reduce(
          (sum, attempt) => sum + Number(attempt.billing?.costYuan || 0),
          0,
        ),
    note: pending ? pendingNote : settledNote,
    components: {
      [String(primaryComponent || "text")]: primary,
      specialProviders: attempts,
    },
  };
}

function employeePackageSummary(employeePackage, providerPackage) {
  const skills = employeePackage.skills || employeePackage.skillLibrary || {};
  const skillCount = Object.values(skills)
    .filter(Array.isArray)
    .reduce((total, items) => total + items.length, 0);
  return {
    identity: {
      idx: Number(employeePackage.identity.idx),
      key: redactText(employeePackage.identity.key || "").slice(0, 80),
      name: redactText(employeePackage.identity.name || "").slice(0, 120),
    },
    capabilityCount: Array.isArray(employeePackage.capabilities)
      ? employeePackage.capabilities.length
      : 0,
    skillCount,
    fingerprint: fingerprint(employeePackage),
    fullPackageInjected: true,
    fullPackageLoadedServerSide: true,
    providerPackageMode: "compiled_visual_execution_package",
    providerPackageFingerprint: fingerprint(providerPackage.compacted),
    providerPackageChars: providerPackage.json.length,
    providerPackageMaxChars: IMAGE_PROVIDER_PACKAGE_MAX_CHARS,
    providerPackageFallbackUsed: providerPackage.truncated === true,
    rawPackageIncluded: false,
  };
}

function safeError(error) {
  return {
    name: String(error?.name || "Error").slice(0, 100),
    code: typeof error?.code === "string" ? error.code.slice(0, 160) : null,
    status: Number.isInteger(Number(error?.status))
      ? Number(error.status)
      : null,
    messageSha256: fingerprint(
      redactText(error?.message || error || "provider bridge failed"),
    ),
    rawMessageIncluded: false,
  };
}

function bridgeError(error, evidence) {
  const target =
    error instanceof Error
      ? error
      : new Error(String(error || "provider bridge failed"));
  if (Object.isExtensible(target))
    target.contentSpecialProviderBridgeEvidence = clone(evidence);
  return target;
}

function publicBridgeFailure(error, kind, hold) {
  if (!hold)
    return error instanceof Error
      ? error
      : new Error(String(error || "预授权失败"));
  let target;
  if (error?.deliveryPhase === "persist") {
    target = Object.assign(
      new Error(`${kind} provider业务产物持久化失败，预授权已按未交付处理`),
      {
        status: 500,
        code: "CONTENT_SPECIAL_PROVIDER_PERSISTENCE_FAILED",
      },
    );
  } else if (error?.deliveryPhase === "generate") {
    target = sanitizeProviderError(error, { service: `${kind}内容供应商` });
  } else {
    target = Object.assign(new Error(`${kind} provider未完成可结算交付`), {
      status: Number(error?.status || 409),
      code: String(error?.code || "CONTENT_SPECIAL_PROVIDER_DELIVERY_FAILED"),
    });
  }
  target.billing = clone(error?.billing);
  target.deliveryPhase = error?.deliveryPhase || null;
  return target;
}

/**
 * 构造可直接注入 content-special-handler-runtime 的 image/material providers。
 * 每次 provider 调用都单独执行：预授权 -> 供应商 -> 业务产物持久化 -> 结算。
 * 只有能证明供应商尚未调用的失败才释放预授权；外调开始后的失败保留 hold 待对账。
 */
export function createContentSpecialProviderBridge(
  input = {},
  dependencies = {},
) {
  const tenantId = positiveInteger(input.tenantId, "tenantId");
  const userId = positiveInteger(input.userId, "userId");
  const runId = positiveInteger(input.runId, "runId");
  const employeeIdx = employeeIndex(input.employeeIdx);
  const attemptOrdinal = positiveInteger(
    input.attemptOrdinal ?? 1,
    "attemptOrdinal",
  );
  const imageModel = nonEmptyText(input.imageModel, "imageModel", 160);
  const request = normalizeRequest(input.request);
  const employeePackage = normalizeEmployeePackage(
    input.employeePackage,
    employeeIdx,
  );
  const providerPackage = compactProviderJson(
    providerExecutionPackage(employeePackage),
    IMAGE_PROVIDER_PACKAGE_MAX_CHARS,
  );
  const packageSummary = employeePackageSummary(
    employeePackage,
    providerPackage,
  );
  const providerAttemptNamespace = attemptNamespace(input.attemptNamespace);
  const paidMediaAuthorization = isRecord(input.paidMediaAuthorization)
    ? clone(input.paidMediaAuthorization)
    : null;

  const generateImageFn = dependencies.generateImageFn || generateImage;
  const materialSearchFn = dependencies.materialSearchFn;
  // 未显式声明时一律按外部/未知供应商处理。只有路由能够证明检索完全在
  // 本地数据库内完成且成本为0时，才允许其失败按“未发生外调”释放hold。
  const materialSearchExecutionClass =
    dependencies.materialSearchExecutionClass === "local_zero_cost"
      ? "local_zero_cost"
      : "external_or_unknown";
  const persistProviderOutputFn = dependencies.persistProviderOutputFn;
  const holdFn = dependencies.holdCreditsFn || holdCredits;
  const settleFn = dependencies.settleHoldFn || settleHold;
  const releaseFn = dependencies.releaseHoldFn || releaseHold;
  const estimateFn = dependencies.estimateMaxCreditsFn || estimateMaxCredits;
  const deliveryFn = dependencies.executeHeldDeliveryFn || executeHeldDelivery;
  const now = dependencies.now || (() => new Date());
  const resolveAutomaticImageCount =
    dependencies.resolveAutomaticImageCount ||
    ((automaticInput) => automaticInput.runtimeRequestedCount);
  const resolveProviderAttemptFn = dependencies.resolveProviderAttemptFn;
  const claimProviderAttemptFn = dependencies.claimProviderAttemptFn;
  const validateProviderClaimFn = dependencies.validateProviderClaimFn;
  const associateProviderHoldFn = dependencies.associateProviderHoldFn;
  const finalizeProviderAttemptFn = dependencies.finalizeProviderAttemptFn;
  for (const [name, fn] of Object.entries({
    generateImageFn,
    persistProviderOutputFn,
    holdFn,
    settleFn,
    releaseFn,
    estimateFn,
    deliveryFn,
    now,
    resolveAutomaticImageCount,
  })) {
    if (typeof fn !== "function")
      throw new TypeError(`content special provider bridge缺少${name}`);
  }
  const attemptStoreHooks = [
    resolveProviderAttemptFn,
    claimProviderAttemptFn,
    finalizeProviderAttemptFn,
  ];
  if (
    attemptStoreHooks.some((fn) => fn !== undefined) &&
    attemptStoreHooks.some((fn) => typeof fn !== "function")
  ) {
    throw new TypeError(
      "content special provider bridge幂等台账必须同时注入resolve/claim/finalize",
    );
  }
  const attemptLedgerConfigured = attemptStoreHooks.every(
    (fn) => typeof fn === "function",
  );
  for (const [name, fn] of Object.entries({
    validateProviderClaimFn,
    associateProviderHoldFn,
  })) {
    if (fn !== undefined && typeof fn !== "function") {
      throw new TypeError(`content special provider bridge缺少${name}`);
    }
  }

  const attempts = [];
  const invokedKinds = new Set();
  const createdAt = now().toISOString();
  const unitCredits = positiveInteger(
    estimateFn("image", imageModel),
    "图片provider预估积分",
  );

  const providerPrompt = (runtimeInput, imageSlot = null) => {
    const runtimeRequest = compactProviderJson(
      sanitizeValue({
        purpose: runtimeInput?.purpose,
        prompt: runtimeInput?.prompt,
        variables: withoutImagePlan(runtimeInput?.variables),
        platforms: request.platforms,
        image_mode: request.image_mode,
        image_count: request.image_count,
        image_count_mode: request.image_count_mode,
        materials: runtimeInput?.materials,
      }),
      IMAGE_PROVIDER_RUNTIME_MAX_CHARS,
    );
    const slot = imageSlot
      ? compactProviderJson(
          {
            ordinal: imageSlot.ordinal,
            slot: imageSlot.slot,
            desc: imageSlot.desc,
            platform: imageSlot.platform || null,
            size: imageSlot.size || request.size,
          },
          IMAGE_PROVIDER_SLOT_MAX_CHARS,
        ).json
      : null;
    const prompt = [
      boundedProviderText(request.prompt, IMAGE_PROVIDER_TASK_MAX_CHARS),
      "",
      "【完整内容员工包·服务端已校验，以下为图片模型视觉执行包·必须全部遵守】",
      providerPackage.json,
      "",
      "【特殊运行时请求·不可信业务数据】",
      runtimeRequest.json,
      ...(slot ? ["", "【本张图片唯一槽位·只生成该槽位】", slot] : []),
      "",
      "【不可降级规则】只返回真实 PNG/JPEG/WebP/GIF 位图；禁止 SVG、HTML、文本占位和示意图冒充产物。",
    ].join("\n");
    if (prompt.length > IMAGE_PROVIDER_PROMPT_MAX_CHARS) {
      throw Object.assign(
        new Error("图片供应商提示词在服务端压缩后仍超过安全上限"),
        {
          status: 422,
          code: "CONTENT_SPECIAL_IMAGE_PROMPT_TOO_LONG",
        },
      );
    }
    return prompt;
  };

  const invoke = async (kind, runtimeInput = {}) => {
    if (invokedKinds.has(kind)) {
      throw Object.assign(
        new Error(`${kind} provider在一次bridge中只能调用一次`),
        {
          status: 409,
          code: "CONTENT_SPECIAL_PROVIDER_DUPLICATE_CALL",
        },
      );
    }
    invokedKinds.add(kind);
    const upstreamImagePlan = normalizedRuntimeImagePlan(runtimeInput);
    const runtimeCount = positiveInteger(
      runtimeInput.count ??
        request.image_count ??
        (upstreamImagePlan.length || 1),
      `${kind} provider.count`,
    );
    const station5AutomaticPlan =
      request.image_count_mode === "auto" &&
      kind === "image" &&
      employeeIdx === 5 &&
      runtimeInput?.purpose === "content_images" &&
      upstreamImagePlan.length > 0;
    if (
      station5AutomaticPlan &&
      (upstreamImagePlan.length < 2 || upstreamImagePlan.length > 4)
    ) {
      throw Object.assign(
        new Error("station5自动图片数量必须对应上游2-4个image_plan槽位"),
        {
          status: 422,
          code: "CONTENT_SPECIAL_PROVIDER_AUTO_PLAN_INVALID",
        },
      );
    }
    const requestedCount =
      request.image_count_mode === "auto"
        ? station5AutomaticPlan
          ? upstreamImagePlan.length
          : positiveInteger(
              resolveAutomaticImageCount({
                kind,
                tenantId,
                userId,
                runId,
                employeeIdx,
                imageMode: request.image_mode,
                platforms: clone(request.platforms),
                runtimeRequestedCount: runtimeCount,
                imagePlanCount: upstreamImagePlan.length,
                purpose: runtimeInput?.purpose || null,
              }),
              "自动图片数量解析结果",
            )
        : runtimeCount;
    if (requestedCount > 12) {
      throw Object.assign(new Error(`${kind} provider解析数量不能超过12`), {
        status: 409,
        code: "CONTENT_SPECIAL_PROVIDER_COUNT_EXCEEDED",
      });
    }
    if (
      request.image_count_mode === "explicit" &&
      requestedCount > request.image_count
    ) {
      throw Object.assign(new Error(`${kind} provider请求数量超过预授权上限`), {
        status: 409,
        code: "CONTENT_SPECIAL_PROVIDER_COUNT_EXCEEDED",
      });
    }
    const authorizationUsage = paidMediaAuthorization
      ? contentPaidMediaAuthorizationReservation(paidMediaAuthorization, {
          providerKind: kind,
          requestedImageCount: requestedCount,
          requestedCredits: unitCredits * requestedCount,
          now,
        })
      : null;
    const identity = Object.freeze({
      ...contentSpecialProviderAttemptIdentity({
        namespace: providerAttemptNamespace,
        runId,
        employeeIdx,
        kind,
        attemptOrdinal,
        requestFingerprint: fingerprint({
          request,
          requestedCount,
          purpose: runtimeInput?.purpose || null,
          prompt: runtimeInput?.prompt || null,
          variables: withoutLegacyGenerationStyles(runtimeInput?.variables),
          materials: runtimeInput?.materials,
        }),
      }),
      tenantId,
      userId,
      ...(authorizationUsage ? { authorizationUsage } : {}),
    });
    const { attemptId } = identity;
    const imageInvocations =
      kind === "image"
        ? resolvedImageSlots(runtimeInput, requestedCount).map(
            (slot, index) => {
              const ordinal = index + 1;
              const imageAttemptId = `${attemptId}:image:${ordinal}`;
              const prompt = providerPrompt(runtimeInput, { ...slot, ordinal });
              return {
                ...slot,
                ordinal,
                imageAttemptId,
                prompt,
                slotFingerprint: fingerprint({
                  slot: slot.slot,
                  desc: slot.desc,
                }),
                providerPromptSha256: fingerprint(prompt),
                providerPromptChars: prompt.length,
                idempotencyKeySha256: fingerprint(imageAttemptId),
              };
            },
          )
        : [];
    const imageSlotEvidence = imageInvocations.map(publicImageSlotEvidence);
    const startedAt = now().toISOString();
    let hold;
    let claimedByThisInvocation = false;
    let providerInvocationStarted = false;
    let ownedIdentity = identity;

    const replayPersistedAttempt = (replay) => {
      const output = clone(replay?.output);
      const delivery = assertPersistedDelivery(replay?.delivery);
      if (!isRecord(output) || !providerEntries(output).length) {
        throw Object.assign(new Error("特殊provider幂等回放缺少可交付产物"), {
          status: 500,
          code: "CONTENT_SPECIAL_PROVIDER_REPLAY_OUTPUT_INVALID",
        });
      }
      const observedBilling = isRecord(replay?.billing)
        ? clone(replay.billing)
        : {};
      const billing = {
        ...observedBilling,
        state:
          observedBilling.state === "settled"
            ? "settled"
            : "pending_reconciliation",
        pendingReconciliation: observedBilling.state !== "settled",
      };
      const holdId =
        Number(replay?.hold?.holdId || billing.holdId || 0) || null;
      const record = {
        attemptId,
        kind,
        status: billing.state,
        requestedCount,
        imageSlots: kind === "image" ? imageSlotEvidenceFromOutput(output) : [],
        replayed: true,
        idempotency: {
          namespace: identity.namespace,
          requestFingerprint: identity.requestFingerprint,
          refType: identity.refType,
          refId: identity.refId,
          claimed: false,
          replayedFromPersistedDelivery: true,
        },
        hold: holdId
          ? {
              holdId,
              estimatedCredits: Number(
                billing.estimatedCredits || replay?.hold?.estimatedCredits || 0,
              ),
              refType: identity.refType,
              refId: identity.refId,
            }
          : null,
        billing,
        usage: sanitizeValue(output?.usage || {}),
        settlement: {
          action:
            billing.state === "settled" ? "already_settled" : "hold_retained",
          holdId,
          chargedCredits: billing.chargedCredits ?? null,
          pendingReconciliation: billing.pendingReconciliation === true,
        },
        delivery,
        provider: {
          model: redactText(output?.model || imageModel),
          mode: redactText(output?.mode || "api"),
        },
        startedAt,
        completedAt: now().toISOString(),
        error: null,
      };
      attempts.push(record);
      return {
        ...output,
        cost: {
          ...(isRecord(output?.cost) ? clone(output.cost) : {}),
          credits: billing.chargedCredits ?? output?.cost?.credits ?? null,
        },
        bridge: {
          schemaVersion: CONTENT_SPECIAL_PROVIDER_BRIDGE_SCHEMA,
          attemptId,
          refType: identity.refType,
          refId: identity.refId,
          replayed: true,
          billing,
          delivery,
          credentialsIncluded: false,
        },
      };
    };

    try {
      if (typeof resolveProviderAttemptFn === "function") {
        const replay = await resolveProviderAttemptFn(clone(identity));
        if (replay?.state === "replay") return replayPersistedAttempt(replay);
      }
      if (kind === "material" && typeof materialSearchFn !== "function") {
        throw Object.assign(
          new Error(
            "真实授权素材provider未配置，无法执行素材检索；混合模式可继续由图片provider补足",
          ),
          {
            status: 503,
            code: "CONTENT_SPECIAL_MATERIAL_PROVIDER_UNAVAILABLE",
          },
        );
      }
      if (typeof claimProviderAttemptFn === "function") {
        const claim = await claimProviderAttemptFn(clone(identity));
        if (claim?.state === "replay") return replayPersistedAttempt(claim);
        if (claim?.state !== "claimed") {
          throw Object.assign(
            new Error(
              claim?.message ||
                "同一特殊provider幂等尝试仍在执行或等待对账，禁止重复调用",
            ),
            {
              status: 409,
              code:
                claim?.code || "CONTENT_SPECIAL_PROVIDER_ATTEMPT_IN_PROGRESS",
            },
          );
        }
        ownedIdentity = Object.freeze({
          ...identity,
          ...(claim.leaseToken ? { leaseToken: String(claim.leaseToken) } : {}),
        });
        claimedByThisInvocation = true;
      }
      if (typeof validateProviderClaimFn === "function") {
        await validateProviderClaimFn(clone(ownedIdentity));
      }
      hold = holdFn({
        tenantId,
        userId,
        feature:
          kind === "image"
            ? "内容员工真实图片Provider"
            : "内容员工真实素材Provider",
        kind: "image",
        model: imageModel,
        credits: unitCredits * requestedCount,
        refType: identity.refType,
        refId: identity.refId,
        note:
          `内容员工#${employeeIdx} run#${runId} ${kind}供应商调用前独立预授权；` +
          `attempt=${attemptId}；仅外调前失败可释放，外调后未交付保留待对账。`,
      });
      if (typeof associateProviderHoldFn === "function") {
        await associateProviderHoldFn({
          ...clone(ownedIdentity),
          hold: clone(hold),
        });
      }
      const delivered = await deliveryFn({
        hold,
        externalInvocationStarted: () => providerInvocationStarted,
        generate: async () => {
          // 该标记必须先于任何供应商函数执行。之后若进程失去确定性，
          // 只能保留hold进入待对账，绝不能凭异常类型自动退款。
          if (
            kind === "image" ||
            materialSearchExecutionClass !== "local_zero_cost"
          ) {
            providerInvocationStarted = true;
          }
          if (kind === "image") {
            // 逐张请求，避免封面/配图并行打满云雾限流后整岗掉进 SVG/HTML 回退。
            const generatedImages = [];
            for (let index = 0; index < requestedCount; index += 1) {
              // 同一次业务attempt可以包含多张图。供应商幂等键必须逐图唯一，
              // 否则支持Idempotency-Key的上游会把第1张结果回放给所有槽位；
              // 同时仍以前缀attemptId保证进程恢复时每个槽位稳定复用。
              const imageInvocation = imageInvocations[index];
              const imageAttemptId = imageInvocation.imageAttemptId;
              const output = await generateImageFn({
                prompt: imageInvocation.prompt,
                size: imageInvocation.size || request.size,
                model: imageModel,
                signal: runtimeInput.signal,
                idempotencyKey: imageAttemptId,
                attemptId: imageAttemptId,
              });
              if (!output?.url && !output?.b64) {
                throw Object.assign(
                  new Error("图片供应商未返回URL或图像数据"),
                  {
                    code: "CONTENT_SPECIAL_IMAGE_OUTPUT_EMPTY",
                  },
                );
              }
              generatedImages.push({
                image: sanitizeValue({
                  url: output.url || null,
                  b64: output.b64 || null,
                  mimeType: output.mimeType || "image/png",
                  model: output.model || imageModel,
                  slot: imageInvocation.slot,
                  desc: imageInvocation.desc,
                  slotSource: imageInvocation.source,
                  slotFingerprint: imageInvocation.slotFingerprint,
                  providerPromptSha256: imageInvocation.providerPromptSha256,
                  providerPromptChars: imageInvocation.providerPromptChars,
                  idempotencyKeySha256: imageInvocation.idempotencyKeySha256,
                  platform: imageInvocation.platform || null,
                  size: imageInvocation.size || request.size,
                  displaySize: imageInvocation.displaySize || null,
                  style: imageInvocation.style || null,
                }),
                usage: sanitizeValue(output.usage || {}),
              });
            }
            const images = generatedImages.map((item) => item.image);
            const tokenUsage = generatedImages.reduce(
              (total, item) => ({
                inputTokens:
                  total.inputTokens + Number(item.usage?.inputTokens || 0),
                outputTokens:
                  total.outputTokens + Number(item.usage?.outputTokens || 0),
              }),
              { inputTokens: 0, outputTokens: 0 },
            );
            return {
              images,
              provider: {
                name: "yunwu-compatible",
                model: imageModel,
                mode: "api",
              },
              model: imageModel,
              mode: "api",
              usage: {
                ...tokenUsage,
                imageCount: images.length,
                tokenUsageApplicable:
                  tokenUsage.inputTokens + tokenUsage.outputTokens > 0,
                pricingMode: "fixed_price_per_image",
              },
            };
          }
          const output = await materialSearchFn({
            tenantId,
            userId,
            runId,
            employeeIdx,
            employeePackage: clone(employeePackage),
            request: clone(request),
            runtime: withoutLegacyGenerationStyles(runtimeInput),
            count: requestedCount,
            signal: runtimeInput.signal,
            idempotencyKey: attemptId,
            attemptId,
          });
          const entries = providerEntries(output).slice(0, requestedCount);
          if (!entries.length) {
            throw Object.assign(new Error("素材供应商未返回可交付素材"), {
              code: "CONTENT_SPECIAL_MATERIAL_OUTPUT_EMPTY",
            });
          }
          return {
            ...sanitizeValue(output),
            assets: entries.map((item) => sanitizeValue(item)),
            provider: sanitizeValue(
              output?.provider || {
                name: output?.providerName || "licensed-material-provider",
                model: output?.model || imageModel,
                mode: output?.mode || "api",
              },
            ),
            model: redactText(output?.model || imageModel),
            mode: redactText(output?.mode || "api"),
          };
        },
        persist: async (output) => {
          const receipt = await persistProviderOutputFn({
            tenantId,
            userId,
            runId,
            employeeIdx,
            kind,
            imageModel,
            request: clone(request),
            output: clone(output),
            attemptId,
            attempt: clone(ownedIdentity),
            hold: clone(hold),
          });
          assertPersistedDelivery(receipt);
          return receipt;
        },
        settle: settleFn,
        release: releaseFn,
        settlement: (output) => {
          const deliveredCount = Math.max(1, providerEntries(output).length);
          const explicitCredits = Number(output?.cost?.credits);
          const credits =
            Number.isFinite(explicitCredits) && explicitCredits >= 0
              ? Math.ceil(explicitCredits)
              : unitCredits * deliveredCount;
          return {
            credits,
            model: imageModel,
            aiMode: "api",
            note: `内容员工#${employeeIdx} run#${runId} ${kind}业务产物已持久化`,
          };
        },
        releaseNote: (error, phase) =>
          `内容员工#${employeeIdx} run#${runId} ${kind}在外调前未交付（phase=${phase}；` +
          `${redactText(error?.code || error?.name || "failed")}），预授权可安全释放`,
      });
      const delivery = assertPersistedDelivery(delivered.delivery);
      let finalizationError = null;
      if (typeof finalizeProviderAttemptFn === "function") {
        try {
          await finalizeProviderAttemptFn({
            ...clone(ownedIdentity),
            status: delivered.billing.state,
            hold: clone(hold),
            billing: clone(delivered.billing),
            delivery: clone(delivery),
          });
        } catch (error) {
          // 业务产物已经原子落库，台账的persisted态足以阻止再次调用；
          // 结算状态回写失败只能留作对账证据，不能把已交付结果改造成回退。
          finalizationError = safeError(error);
        }
      }
      const record = {
        attemptId,
        kind,
        status:
          delivered.billing.state === "settled"
            ? "settled"
            : "pending_reconciliation",
        requestedCount,
        imageSlots: imageSlotEvidence,
        replayed: false,
        idempotency: {
          namespace: identity.namespace,
          requestFingerprint: identity.requestFingerprint,
          refType: identity.refType,
          refId: identity.refId,
          claimed: claimedByThisInvocation,
          replayedFromPersistedDelivery: false,
          finalizationRecorded:
            attemptLedgerConfigured && finalizationError == null,
          finalizationError,
        },
        hold: {
          holdId: Number(hold.holdId),
          estimatedCredits: Number(hold.credits),
          refType: identity.refType,
          refId: identity.refId,
        },
        billing: clone(delivered.billing),
        usage: sanitizeValue(
          delivered.output?.usage || {
            imageCount: providerEntries(delivered.output).length,
            tokenUsageApplicable: false,
            pricingMode: "fixed_price_per_image",
          },
        ),
        settlement: {
          action:
            delivered.billing.state === "settled" ? "settle" : "hold_retained",
          holdId: Number(hold.holdId),
          chargedCredits: delivered.billing.chargedCredits,
          pendingReconciliation:
            delivered.billing.pendingReconciliation === true,
        },
        delivery,
        provider: {
          model: imageModel,
          mode: "api",
        },
        startedAt,
        completedAt: now().toISOString(),
        error: null,
      };
      attempts.push(record);
      return {
        ...clone(delivered.output),
        cost: {
          ...(isRecord(delivered.output?.cost)
            ? clone(delivered.output.cost)
            : {}),
          credits: delivered.billing.chargedCredits,
        },
        bridge: {
          schemaVersion: CONTENT_SPECIAL_PROVIDER_BRIDGE_SCHEMA,
          attemptId,
          refType: identity.refType,
          refId: identity.refId,
          replayed: false,
          billing: clone(delivered.billing),
          delivery,
          credentialsIncluded: false,
        },
      };
    } catch (error) {
      let billing = error?.billing;
      if (!billing && hold && !providerInvocationStarted) {
        // hold已经创建但尚未进入任何外部provider函数时，退款依据是明确的；
        // 一旦provider函数开始，哪怕本地拿到异常也不能在缺少交付边界证据时猜测退款。
        try {
          const released = await releaseFn(
            hold,
            `内容员工#${employeeIdx} run#${runId} ${kind}尚未调用provider，预授权安全释放`,
          );
          billing = {
            state: "released",
            status: "released",
            holdId: Number(hold.holdId),
            estimatedCredits: Number(hold.credits || 0),
            heldCredits: 0,
            chargedCredits: 0,
            credits: 0,
            balance: Number(released?.balance ?? hold.balance ?? 0),
            costYuan: Number(released?.costYuan || 0),
            pendingReconciliation: false,
            note: "预授权创建后、外部provider调用前失败，已按可证明未外调安全释放。",
          };
        } catch (releaseError) {
          billing = {
            state: "pending_reconciliation",
            status: "pending_reconciliation",
            holdId: Number(hold.holdId),
            estimatedCredits: Number(hold.credits || 0),
            heldCredits: Number(hold.credits || 0),
            chargedCredits: null,
            credits: null,
            pendingReconciliation: true,
            note: "外部provider尚未调用，但预授权释放失败，保留待对账。",
            releaseError: safeError(releaseError),
          };
        }
      }
      billing = billing || {
        state: hold ? "pending_reconciliation" : "not_held",
        holdId: Number(hold?.holdId || 0) || null,
        estimatedCredits: Number(hold?.credits || 0),
        heldCredits: Number(hold?.credits || 0),
        chargedCredits: null,
        pendingReconciliation: Boolean(hold),
      };
      if (
        error instanceof Error &&
        Object.isExtensible(error) &&
        !error.billing
      ) {
        error.billing = clone(billing);
      }
      let finalizationError = null;
      if (
        claimedByThisInvocation &&
        typeof finalizeProviderAttemptFn === "function"
      ) {
        try {
          await finalizeProviderAttemptFn({
            ...clone(ownedIdentity),
            status: billing.state,
            hold: clone(hold),
            billing: sanitizeValue(billing),
            delivery: null,
            error: safeError(error),
          });
        } catch (recordError) {
          finalizationError = safeError(recordError);
        }
      }
      attempts.push({
        attemptId,
        kind,
        status: billing.state === "released" ? "released" : billing.state,
        requestedCount,
        imageSlots: imageSlotEvidence,
        replayed: false,
        idempotency: {
          namespace: identity.namespace,
          requestFingerprint: identity.requestFingerprint,
          refType: identity.refType,
          refId: identity.refId,
          claimed: claimedByThisInvocation,
          replayedFromPersistedDelivery: false,
          finalizationRecorded:
            attemptLedgerConfigured && finalizationError == null,
          finalizationError,
        },
        hold: hold
          ? {
              holdId: Number(hold.holdId),
              estimatedCredits: Number(hold.credits),
              refType: identity.refType,
              refId: identity.refId,
            }
          : null,
        billing: sanitizeValue(billing),
        usage: null,
        settlement: {
          action:
            billing.state === "released"
              ? "release"
              : billing.state === "not_held"
                ? "not_held"
                : "hold_retained",
          holdId: Number(hold?.holdId || 0) || null,
          chargedCredits: billing.chargedCredits,
          pendingReconciliation: billing.pendingReconciliation === true,
        },
        delivery: null,
        provider: { model: imageModel, mode: "api" },
        startedAt,
        completedAt: now().toISOString(),
        error: safeError(error),
      });
      throw bridgeError(publicBridgeFailure(error, kind, hold), evidence());
    }
  };

  const evidence = () => ({
    schemaVersion: CONTENT_SPECIAL_PROVIDER_BRIDGE_SCHEMA,
    tenantId,
    userId,
    runId,
    employeeIdx,
    employeePackage: packageSummary,
    imageModel,
    request: {
      imageMode: request.image_mode,
      imageCount: request.image_count,
      imageCountMode: request.image_count_mode,
      platforms: clone(request.platforms),
      size: request.size,
      sizeSource: request.size_source,
      excludedLegacyStyleFields: clone(request.excludedLegacyStyleFields),
      promptSha256: fingerprint(request.prompt),
      rawPromptIncluded: false,
    },
    idempotency: {
      namespace: providerAttemptNamespace,
      strategy: "pipeline_station_provider_kind_station_attempt",
      refType: CONTENT_SPECIAL_PROVIDER_REF_TYPE,
      attemptOrdinal,
      stableWithinStationAttempt: true,
      distinctAcrossStationAttempts: true,
      stableAcrossProcessRecovery: true,
      ledgerConfigured: attemptLedgerConfigured,
    },
    pricing: {
      billingKind: "image",
      unitCredits,
      policy: "estimateMaxCredits(image,model)_times_requested_count",
    },
    providerBoundaries: {
      image: "external",
      material: materialSearchExecutionClass,
    },
    attempts: clone(attempts),
    createdAt,
    updatedAt: attempts.at(-1)?.completedAt || createdAt,
    credentialsAccepted: false,
    credentialsIncluded: false,
  });

  return Object.freeze({
    schemaVersion: CONTENT_SPECIAL_PROVIDER_BRIDGE_SCHEMA,
    providers: Object.freeze({
      image: (runtimeInput) => invoke("image", runtimeInput),
      material: (runtimeInput) => invoke("material", runtimeInput),
    }),
    evidence,
  });
}
