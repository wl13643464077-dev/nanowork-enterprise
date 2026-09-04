import { createHash } from "node:crypto";

import {
  CONTENT_HANDLER_ADAPTER_CATALOG,
  sanitizeContentRuntimeErrorMessage,
} from "./content-handler-adapters.js";
import { assertContentHandlerApprovalBoundary } from "./content-handler-approval-boundary.js";
import { buildContentHandlerRuntimeContext } from "./content-handler-runtime-context.js";
import { getContentEmployeeOutputResponseSchema, validateContentEmployeeOutputContract } from "./content-output-contract.js";
import { validatePrivateOutputSnapshot } from './content-production-private-output-snapshot.js';
import { assembleContentPipelineDelivery } from "./content-pipeline-delivery.js";
import { resolveXhsSalesContext } from './content-xhs-playbook.js';
import { xhsVersionId } from './content-xhs-output.js';
import { isXhsPipelineDraft } from './content-xhs-pipeline.js';
import {
  CANONICAL_EMPLOYEE_PROFILE_FIELDS,
  canonicalContentEmployeeProfileFor,
  validateCanonicalEmployeeProfile,
} from "./canonical-employee-profile.js";
import { validateContentProductionPrivateWebSnapshot } from "./content-production-handler-registry.js";
import {
  contentPaidMediaMaximumImageCount,
  validateContentPaidMediaAuthorization,
} from "./content-paid-media-authorization.js";

export const CONTENT_PRODUCTION_PIPELINE_SCHEMA =
  "nanowork.content-production-pipeline/1";
export const CONTENT_PRODUCTION_PIPELINE_STATION_COUNT = 10;
export const CONTENT_PRODUCTION_RUNTIME_PACKAGE_LOAD_SCHEMA =
  "nanowork.content-production-runtime-package-load/1";
export const CONTENT_PRODUCTION_STATION_DELIVERY_SCHEMA =
  "nanowork.content-production-station-delivery/1";
export const CONTENT_PRODUCTION_KNOWLEDGE_SINK_SCHEMA =
  "nanowork.content-production-knowledge-sink/1";
export const CONTENT_PRODUCTION_PHASE_EVENT_SCHEMA =
  "nanowork.content-production-phase-event/1";
export const CONTENT_PRODUCTION_INTERRUPTED_STALE_MS = 30 * 60 * 1_000;
// 首轮执行之外最多允许2次重试；每次attempt仍走独立hold/usage/settlement，
// 防止无限点击重试造成无法封顶的供应商费用。
export const CONTENT_PRODUCTION_MAX_RETRY_ATTEMPTS = 2;
export const CONTENT_PRODUCTION_MAX_STATION_ATTEMPTS =
  1 + CONTENT_PRODUCTION_MAX_RETRY_ATTEMPTS;
export const CONTENT_PRODUCTION_VISUAL_POLICY_VERSION = "v2";

const WORKFLOW_MODES = new Set(["fullauto", "autopilot", "copilot", "manual"]);
const CONTENT_PLATFORMS = new Set([
  "小红书",
  "公众号",
  "抖音",
  "视频号",
  "B站",
  "微博",
]);
const OWNER_APPROVAL_POLICY_ROLES = new Set([
  "boss",
  "admin",
  "platform_super",
]);
const PAID_MEDIA_AUTHORIZATION_FAILURE_CODES = new Set([
  "CONTENT_PAID_MEDIA_AUTHORIZATION_REQUIRED",
  "CONTENT_PAID_MEDIA_AUTHORIZATION_STALE",
  "CONTENT_PAID_MEDIA_AUTHORIZATION_EXPIRED",
  "CONTENT_PAID_MEDIA_AUTHORIZATION_TAMPERED",
  "CONTENT_PAID_MEDIA_AUTHORIZATION_LIMIT_EXCEEDED",
  "CONTENT_PAID_MEDIA_REAUTHORIZATION_REQUIRED",
]);
const PUBLICATION_METRIC_KEYS = new Set([
  "views",
  "impressions",
  "reads",
  "likes",
  "comments",
  "shares",
  "saves",
  "clicks",
  "followersGained",
  "leads",
  "orders",
  "revenue",
]);
const PLATFORM_PUBLICATION_HOSTS = Object.freeze({
  小红书: Object.freeze(["xiaohongshu.com", "xhslink.com"]),
  公众号: Object.freeze(["mp.weixin.qq.com"]),
  视频号: Object.freeze(["channels.weixin.qq.com", "weixin.qq.com"]),
  抖音: Object.freeze(["douyin.com", "iesdouyin.com"]),
  B站: Object.freeze(["bilibili.com", "b23.tv"]),
  微博: Object.freeze(["weibo.com", "weibo.cn"]),
});
const PUBLICATION_METRICS_COLLECTION_SCHEMA =
  "nanowork.content-publication-metrics-collection/2";
const PUBLICATION_METRICS_ENTRY_SCHEMA =
  "nanowork.content-publication-metrics-entry/2";
const PUBLICATION_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

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
]);
const STATION_ARTIFACT_MEDIA_TYPES = Object.freeze({
  json: "application/json",
  markdown: "text/markdown",
  images: "application/json",
  covers: "application/json",
  html: "text/html",
  publish_packages: "application/json",
  svg: "image/svg+xml",
});
const STATION_ARTIFACT_EXTENSIONS = Object.freeze({
  json: "json",
  markdown: "md",
  images: "json",
  covers: "json",
  html: "html",
  publish_packages: "json",
  svg: "svg",
});
const MAX_STATION_ARTIFACTS = 8;
const MAX_STATION_ARTIFACT_BYTES = 8 * 1024 * 1024;
const CONTENT_PRODUCTION_PHASES = new Set([
  "claim",
  "context",
  "agentic_search",
  "controlled_fetch",
  "provider",
  "validate",
  "persist",
  "settle",
  "failure",
  "retry",
  "recover",
]);
const CONTENT_PRODUCTION_PHASE_STATES = new Set([
  "started",
  "completed",
  "failed",
  "skipped",
  "waiting",
  "recovered",
  "retrying",
]);
const CONTENT_PRODUCTION_LIFECYCLE_ACTIVE_STATES = new Set([
  "running",
  "paused",
  "awaiting_approval",
  "billing_pending",
  "failed",
]);
const PHASE_EVENT_INTEGER_DETAIL_KEYS = new Set([
  "upstreamStationCount",
  "candidateCount",
  "verifiedBodyCount",
  "resultCount",
  "artifactCount",
  "providerCall",
  "attemptCount",
]);
const PHASE_EVENT_BOOLEAN_DETAIL_KEYS = new Set([
  "required",
  "reused",
  "verified",
  "providerCalled",
  "billingPending",
]);
const PHASE_EVENT_HASH_DETAIL_KEYS = new Set([
  "contextFingerprint",
  "evidenceFingerprint",
  "outputFingerprint",
  "snapshotFingerprint",
]);
const PHASE_EVENT_TEXT_DETAIL_KEYS = new Set([
  "code",
  "providerKind",
  "source",
]);
const PHASE_EVENT_USAGE_NUMERIC_KEYS = new Set([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "heldCredits",
  "settledCredits",
  "chargedCredits",
  "costYuan",
  "costUsd",
]);

export class ContentProductionPipelineError extends Error {
  constructor(
    message,
    code = "CONTENT_PRODUCTION_PIPELINE_INVALID",
    status = 409,
  ) {
    super(message);
    this.name = "ContentProductionPipelineError";
    this.code = code;
    this.status = status;
  }
}

function fail(message, code, status) {
  throw new ContentProductionPipelineError(message, code, status);
}

function positiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    fail(`${field}必须是正整数`, undefined, 400);
  return parsed;
}

function cleanText(value, max = 2_000) {
  let output = String(value ?? "");
  for (const rule of SECRET_TEXT_PATTERNS)
    output = output.replace(rule.pattern, rule.replacement);
  return output.trim().slice(0, max);
}

function safeValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return cleanText(value, 100_000);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) fail("流水线数据不能包含循环引用", undefined, 400);
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => safeValue(item, seen));
    seen.delete(value);
    return output;
  }
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    const normalized = safeValue(child, seen);
    if (normalized !== undefined) output[key] = normalized;
  }
  seen.delete(value);
  return output;
}

function normalizePipelineIdempotency(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) {
    fail(
      "pipeline idempotency必须是对象",
      "CONTENT_PIPELINE_IDEMPOTENCY_INVALID",
      400,
    );
  }
  const namespace = cleanText(value.namespace, 80);
  const key = cleanText(value.key, 240);
  if (
    !/^[a-z][a-z0-9_.-]{2,79}$/u.test(namespace) ||
    !key ||
    key.length > 240
  ) {
    fail(
      "pipeline idempotency namespace或key无效",
      "CONTENT_PIPELINE_IDEMPOTENCY_INVALID",
      400,
    );
  }
  return Object.freeze({ namespace, key });
}

function normalizedPhaseEventDetail(value) {
  if (!isObject(value)) return {};
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (PHASE_EVENT_INTEGER_DETAIL_KEYS.has(key)) {
      if (raw === null || raw === undefined || raw === "") continue;
      const number = Number(raw);
      if (Number.isSafeInteger(number) && number >= 0) output[key] = number;
      continue;
    }
    if (PHASE_EVENT_BOOLEAN_DETAIL_KEYS.has(key)) {
      if (typeof raw === "boolean") output[key] = raw;
      continue;
    }
    if (PHASE_EVENT_HASH_DETAIL_KEYS.has(key)) {
      const hash = cleanText(raw, 80).toLowerCase();
      if (/^sha256:[a-f0-9]{64}$/u.test(hash)) output[key] = hash;
      continue;
    }
    if (PHASE_EVENT_TEXT_DETAIL_KEYS.has(key)) {
      const text = cleanText(raw, 160);
      const valid =
        key === "code"
          ? /^[A-Z][A-Z0-9_:-]{0,159}$/u.test(text)
          : /^[a-z0-9][a-z0-9._:-]{0,159}$/u.test(text);
      if (valid) output[key] = text;
    }
  }
  return output;
}

function normalizedPhaseEventUsageRef(value) {
  if (!isObject(value)) return null;
  const output = {};
  const source = cleanText(value.source, 80);
  if (/^[a-z0-9][a-z0-9._:-]{0,79}$/u.test(source)) output.source = source;
  const model = cleanText(value.model, 160);
  if (
    model &&
    !/:\/\//u.test(model) &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/u.test(model)
  ) {
    output.model = model;
  }
  const evidenceFingerprint = cleanText(value.evidenceFingerprint, 80)
    .toLowerCase()
    .trim();
  if (/^sha256:[a-f0-9]{64}$/u.test(evidenceFingerprint)) {
    output.evidenceFingerprint = evidenceFingerprint;
  }
  for (const key of PHASE_EVENT_USAGE_NUMERIC_KEYS) {
    if (value[key] === null || value[key] === undefined || value[key] === "")
      continue;
    const number = Number(value[key]);
    if (Number.isFinite(number) && number >= 0) output[key] = number;
  }
  return Object.keys(output).length ? output : null;
}

function normalizePhaseEventInput(value) {
  const tenantId = positiveInteger(value?.tenantId, "tenantId");
  const pipelineId = positiveInteger(value?.pipelineId, "pipelineId");
  const stationIdx = Number(value?.stationIdx);
  const stationAttempt = Number(value?.stationAttempt);
  const phase = cleanText(value?.phase, 80);
  const state = cleanText(value?.state, 80);
  if (!Number.isInteger(stationIdx) || stationIdx < 0 || stationIdx > 9) {
    fail("phase event的stationIdx必须是0..9", undefined, 400);
  }
  if (!Number.isInteger(stationAttempt) || stationAttempt < 0) {
    fail("phase event的stationAttempt必须是非负整数", undefined, 400);
  }
  if (!CONTENT_PRODUCTION_PHASES.has(phase)) {
    fail("phase event包含未知phase", undefined, 400);
  }
  if (!CONTENT_PRODUCTION_PHASE_STATES.has(state)) {
    fail("phase event包含未知state", undefined, 400);
  }
  return {
    tenantId,
    pipelineId,
    stationIdx,
    stationAttempt,
    phase,
    state,
    detail: normalizedPhaseEventDetail(value?.detail),
    usageRef: normalizedPhaseEventUsageRef(value?.usageRef),
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
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

function redactArtifactContent(value) {
  let output = String(value ?? "");
  for (const rule of SECRET_TEXT_PATTERNS)
    output = output.replace(rule.pattern, rule.replacement);
  return output;
}

function safeArtifactFilename(value, stationIdx, index, kind) {
  const extension = STATION_ARTIFACT_EXTENSIONS[kind] || "txt";
  const fallback = `content-pipeline-station-${stationIdx}-${index + 1}.${extension}`;
  const filename = String(value || fallback)
    .replace(/[\r\n]/gu, "")
    .replace(/[^a-zA-Z0-9._-]/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 180);
  return filename || fallback;
}

function normalizeStationArtifacts(value, stationIdx) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_STATION_ARTIFACTS
  ) {
    fail(
      `工位${stationIdx}必须交付1-${MAX_STATION_ARTIFACTS}个已通过岗位契约的主产物`,
      "CONTENT_PIPELINE_ARTIFACT_REQUIRED",
      422,
    );
  }
  const descriptor = descriptorAt(stationIdx);
  const artifacts = value.map((raw, index) => {
    if (!isObject(raw)) {
      fail(
        `工位${stationIdx}产物${index + 1}格式无效`,
        "CONTENT_PIPELINE_ARTIFACT_INVALID",
        422,
      );
    }
    const kind = cleanText(raw.kind, 80);
    const mediaType = STATION_ARTIFACT_MEDIA_TYPES[kind];
    const content = redactArtifactContent(raw.content);
    const byteSize = Buffer.byteLength(content, "utf8");
    if (!mediaType || !content || byteSize > MAX_STATION_ARTIFACT_BYTES) {
      fail(
        `工位${stationIdx}产物${index + 1}缺少正文、类型不受支持或超过8MB`,
        "CONTENT_PIPELINE_ARTIFACT_INVALID",
        422,
      );
    }
    if (
      Number(raw.employeeIdx) !== stationIdx ||
      cleanText(raw.employeeKey, 160) !== descriptor.employeeKey
    ) {
      fail(
        `工位${stationIdx}产物${index + 1}与当前数字员工身份不一致`,
        "CONTENT_PIPELINE_ARTIFACT_IDENTITY_MISMATCH",
        422,
      );
    }
    return {
      kind,
      primary: raw.primary === true,
      filename: safeArtifactFilename(raw.filename, stationIdx, index, kind),
      mediaType,
      content,
      employeeIdx: stationIdx,
      employeeKey: descriptor.employeeKey,
      sourceKeys: Array.isArray(raw.sourceKeys)
        ? raw.sourceKeys
            .slice(0, 100)
            .map((item) => cleanText(item, 160))
            .filter(Boolean)
        : [],
    };
  });
  if (!artifacts.some((artifact) => artifact.primary)) {
    fail(
      `工位${stationIdx}没有标记主产物`,
      "CONTENT_PIPELINE_PRIMARY_ARTIFACT_MISSING",
      422,
    );
  }
  return artifacts;
}

function generationOwnedOutput(stationIdx, value) {
  if (!isObject(value)) return null;
  const output = structuredClone(value);
  if (stationIdx === 0) {
    delete output.selection;
    delete output.selected;
  } else if (stationIdx === 3 && isXhsPipelineDraft(output)) {
    delete output.selection;
    delete output.xhsSelection;
  } else if (stationIdx === 5) {
    delete output.selection;
    delete output.selected_image;
  } else if (stationIdx === 6) {
    delete output.selection;
    delete output.selected_cover;
  }
  return output;
}

function verifiedPersistedWebEvidence(stationIdx, handlerEvidence) {
  if (stationIdx > 2) return { required: false, evidence: null };
  const web = handlerEvidence?.productionRuntime?.web;
  const minimum = stationIdx === 1 ? 2 : 1;
  const results = Array.isArray(web?.results) ? web.results : [];
  const complete =
    web?.required === true &&
    web?.attempted === true &&
    web?.verified === true &&
    Number(web?.resultCount) >= minimum &&
    results.length >= minimum &&
    results.every((item) => {
      if (
        !isObject(item) ||
        !cleanText(item.title, 500) ||
        !cleanText(item.url, 2_000)
      )
        return false;
      if (!/^sha256:[a-f0-9]{64}$/u.test(String(item.snippetSha256 || "")))
        return false;
      try {
        const url = new URL(item.url);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    });
  return complete
    ? { required: true, evidence: safeValue(web) }
    : { required: true, evidence: null };
}

function researchSourcesMatchPersistedEvidence(output, webEvidence) {
  if (!Array.isArray(output?.sources) || !Array.isArray(webEvidence?.results))
    return false;
  const allow = new Set(
    webEvidence.results.map(
      (item) =>
        `${String(item.title || "").trim()}\n${String(item.url || "")
          .trim()
          .replace(/\/$/u, "")}`,
    ),
  );
  return (
    output.sources.length >= 2 &&
    output.sources.every((item) =>
      allow.has(
        `${String(item?.title || "").trim()}\n${String(item?.url || "")
          .trim()
          .replace(/\/$/u, "")}`,
      ),
    )
  );
}

function evaluateArtifactBackfill({ job, station, upstreamOutputs, privateOutputSnapshot }) {
  const reject = (reasonCode, message, evidence = {}) => ({
    ok: false,
    reasonCode,
    message,
    evidence: safeValue(evidence),
  });
  const output = generationOwnedOutput(station.stationIdx, station.output);
  if (!output) {
    return reject(
      "CONTENT_PIPELINE_ARTIFACT_BACKFILL_OUTPUT_MISSING",
      "当前工位没有可复核的结构化output",
    );
  }
  const descriptor = descriptorAt(station.stationIdx);
  let frozenContext = null;
  if (station.stationIdx >= 3 && (resolveXhsSalesContext(3, { task: job.task }).salesMode
    || isXhsPipelineDraft(station.stationIdx === 3 ? output : upstreamOutputs?.[3]))) {
    if (!privateOutputSnapshot) return reject('CONTENT_PIPELINE_ARTIFACT_BACKFILL_XHS_FACT_SNAPSHOT_REQUIRED',
      '小红书旧产物缺失时必须按原生成事实快照复核；当前记录未保存该快照，不能用现门店资料补猜，请人工核对后重新生成');
    const verified = validatePrivateOutputSnapshot(privateOutputSnapshot, {
      tenantId: job.tenantId, pipelineId: job.id, stationIdx: station.stationIdx,
      stationAttempt: station.attempt, handlerId: station.handlerId,
      providerDelivery: station.handlerEvidence?.providerDelivery,
      outputFingerprint: fingerprint(output), task: job.task, upstreamOutputs,
    });
    if (!verified) return reject('CONTENT_PIPELINE_ARTIFACT_BACKFILL_XHS_FACT_SNAPSHOT_INVALID',
      '原生成事实快照与企业、任务、工位代次、输出或上游不一致，未恢复产物');
    frozenContext = verified.validationContext;
    // A text contract cannot recreate a missing paid image/deck runtime manifest.
    if ([5, 6, 7].includes(station.stationIdx)) return reject('CONTENT_PIPELINE_ARTIFACT_BACKFILL_SPECIAL_RUNTIME_REQUIRED',
      '图像与演绎工位还需原始媒体运行产物，不能用文本计划冒充已生成媒体');
  }
  let responseSchema;
  try {
    responseSchema = frozenContext ? getContentEmployeeOutputResponseSchema(station.stationIdx, frozenContext)?.schema : null;
  } catch {
    return reject('CONTENT_PIPELINE_ARTIFACT_BACKFILL_CONTRACT_FAILED', '原生成上下文无法通过岗位契约预检');
  }
  const expectedKeys = responseSchema?.required || descriptor.outputKeys || [];
  const allowedKeys = responseSchema?.properties ? Object.keys(responseSchema.properties) : expectedKeys;
  if (
    !expectedKeys.every((key) => Object.hasOwn(output, key)) ||
    Object.keys(output).some((key) => !allowedKeys.includes(key))
  ) {
    return reject(
      "CONTENT_PIPELINE_ARTIFACT_BACKFILL_OUTPUT_KEYS_MISMATCH",
      "当前output与锁定岗位字段不一致",
      { expectedKeys, actualKeys: Object.keys(output) },
    );
  }
  const provider = station.handlerEvidence?.providerDelivery;
  const currentFingerprint = fingerprint(output);
  if (
    provider?.validated !== true ||
    provider?.mode !== "api" ||
    provider?.employeeIdx !== station.stationIdx ||
    provider?.handlerId !== station.handlerId ||
    !/^sha256:[a-f0-9]{64}$/u.test(String(provider?.outputFingerprint || "")) ||
    provider.outputFingerprint !== currentFingerprint
  ) {
    return reject(
      "CONTENT_PIPELINE_ARTIFACT_BACKFILL_PROVIDER_EVIDENCE_MISMATCH",
      "provider已验证证据或output指纹与当前工位不一致",
      {
        providerValidated: provider?.validated === true,
        providerMode: provider?.mode || null,
        expectedFingerprint: provider?.outputFingerprint || null,
        currentFingerprint,
      },
    );
  }
  const persistedWeb = verifiedPersistedWebEvidence(
    station.stationIdx,
    station.handlerEvidence,
  );
  if (persistedWeb.required && !persistedWeb.evidence) {
    return reject(
      "CONTENT_PIPELINE_ARTIFACT_BACKFILL_WEB_EVIDENCE_MISSING",
      "联网工位缺少可复用的已持久化检索证据",
    );
  }
  if (
    station.stationIdx === 1 &&
    !researchSourcesMatchPersistedEvidence(output, persistedWeb.evidence)
  ) {
    return reject(
      "CONTENT_PIPELINE_ARTIFACT_BACKFILL_RESEARCH_SOURCES_MISMATCH",
      "情报员工位sources不是已持久化检索证据的子集",
    );
  }
  const validation = validateContentEmployeeOutputContract(
    station.stationIdx,
    output,
    frozenContext || {
      title: job.task?.direction || job.title || "",
      requirement: JSON.stringify(
        safeValue({
          brief: job.task || {},
          outputs: upstreamOutputs || {},
          persona: job.persona || {},
          companyProfile: job.settings?.companyProfile || {},
        }),
      ),
      trustedEvidence: persistedWeb.evidence
        ? {
            source: "persisted_handler_web_evidence",
            web: persistedWeb.evidence,
          }
        : undefined,
      enforceRequiredInputs: false,
    },
  );
  if (validation?.valid !== true) {
    return reject(
      "CONTENT_PIPELINE_ARTIFACT_BACKFILL_CONTRACT_FAILED",
      "当前output重新执行岗位契约校验未通过",
      {
        errors: Array.isArray(validation?.errors)
          ? validation.errors.slice(0, 8)
          : [],
      },
    );
  }
  let artifacts;
  try {
    artifacts = normalizeStationArtifacts(
      validation.artifacts,
      station.stationIdx,
    );
  } catch (error) {
    return reject(
      "CONTENT_PIPELINE_ARTIFACT_BACKFILL_ARTIFACT_INVALID",
      "岗位契约没有生成可安全持久化的artifact",
      { errorCode: cleanText(error?.code || error?.name, 160) },
    );
  }
  return {
    ok: true,
    artifacts,
    reasonCode: "CONTENT_PIPELINE_ARTIFACT_BACKFILL_INSERTED",
    message: "已从原始已验证output安全恢复主产物；未调用API且未改变状态或计费",
    evidence: {
      providerValidated: true,
      outputFingerprint: currentFingerprint,
      contractValid: true,
      persistedWebEvidenceReused: persistedWeb.required,
      originalFactSnapshotReused: Boolean(frozenContext),
      artifactCount: artifacts.length,
    },
  };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function json(value) {
  return JSON.stringify(safeValue(value));
}

function instant(now) {
  const result = now();
  const date = result instanceof Date ? result : new Date(result);
  if (Number.isNaN(date.getTime())) fail("now必须返回有效时间");
  return date.toISOString();
}

function publicationPlatforms(task) {
  return Array.isArray(task?.platforms)
    ? [
        ...new Set(
          task.platforms
            .map((item) => cleanText(item, 40))
            .filter((item) => CONTENT_PLATFORMS.has(item)),
        ),
      ]
    : [];
}

function publicationHostAllowed(platform, hostname) {
  const normalizedHost = cleanText(hostname, 260)
    .toLowerCase()
    .replace(/\.$/u, "");
  return (PLATFORM_PUBLICATION_HOSTS[platform] || []).some(
    (allowed) =>
      normalizedHost === allowed || normalizedHost.endsWith(`.${allowed}`),
  );
}

function publicationNow(now) {
  const raw = typeof now === "function" ? now() : now;
  const date = raw instanceof Date ? raw : new Date(raw || Date.now());
  if (!Number.isFinite(date.getTime())) fail("now必须返回有效时间");
  return date;
}

function normalizePublicationMetricsEntry(
  value,
  { actor = null, task = null, now = () => new Date() } = {},
) {
  if (!isObject(value)) {
    fail(
      "发布复盘必须提交真实发布记录与指标",
      "CONTENT_PIPELINE_METRICS_REQUIRED",
      422,
    );
  }
  const publication = value.publication;
  if (!isObject(publication)) {
    fail("publication必须是对象", "CONTENT_PIPELINE_METRICS_INVALID", 400);
  }
  const platform = cleanText(publication.platform, 40);
  if (
    !CONTENT_PLATFORMS.has(platform) ||
    (Array.isArray(task?.platforms) && !task.platforms.includes(platform))
  ) {
    fail(
      "publication.platform必须属于本任务目标平台",
      "CONTENT_PIPELINE_METRICS_INVALID",
      400,
    );
  }
  const urlText = cleanText(publication.url, 2_000);
  let parsedUrl;
  try {
    parsedUrl = new URL(urlText);
  } catch {
    /* 下方统一拒绝 */
  }
  if (
    !parsedUrl ||
    !["http:", "https:"].includes(parsedUrl.protocol) ||
    !parsedUrl.hostname ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    fail(
      "publication.url必须是不携带凭据的http/https发布地址",
      "CONTENT_PIPELINE_METRICS_INVALID",
      400,
    );
  }
  if (!publicationHostAllowed(platform, parsedUrl.hostname)) {
    fail(
      `publication.url域名与${platform}平台不匹配`,
      "CONTENT_PIPELINE_METRICS_PLATFORM_URL_MISMATCH",
      400,
    );
  }
  const publishedAt = cleanText(publication.publishedAt, 80);
  if (!publishedAt || !Number.isFinite(Date.parse(publishedAt))) {
    fail(
      "publication.publishedAt必须是有效时间",
      "CONTENT_PIPELINE_METRICS_INVALID",
      400,
    );
  }
  const nowDate = publicationNow(now);
  if (
    Date.parse(publishedAt) >
    nowDate.getTime() + PUBLICATION_FUTURE_TOLERANCE_MS
  ) {
    fail(
      "publication.publishedAt不能晚于当前时间5分钟以上",
      "CONTENT_PIPELINE_METRICS_PUBLISHED_AT_IN_FUTURE",
      400,
    );
  }
  if (!isObject(value.metrics)) {
    fail("metrics必须是对象", "CONTENT_PIPELINE_METRICS_INVALID", 400);
  }
  const metrics = {};
  for (const [key, raw] of Object.entries(value.metrics)) {
    if (!PUBLICATION_METRIC_KEYS.has(key)) {
      fail(
        `metrics.${key}不是支持的复盘指标`,
        "CONTENT_PIPELINE_METRICS_INVALID",
        400,
      );
    }
    const number = Number(raw);
    if (!Number.isFinite(number) || number < 0) {
      fail(
        `metrics.${key}必须是非负数`,
        "CONTENT_PIPELINE_METRICS_INVALID",
        400,
      );
    }
    metrics[key] = number;
  }
  if (!Object.keys(metrics).length) {
    fail(
      "metrics至少需要一项真实数值指标",
      "CONTENT_PIPELINE_METRICS_REQUIRED",
      422,
    );
  }
  if (!Object.values(metrics).some((number) => number > 0)) {
    fail(
      "metrics至少需要一项大于0的真实数值指标",
      "CONTENT_PIPELINE_METRICS_REQUIRED",
      422,
    );
  }
  const submittedBySource = actor || value.submittedBy;
  const submittedBy = {
    id: positiveInteger(submittedBySource?.id, "submittedBy.id"),
    role: cleanText(submittedBySource?.role, 64),
    name: cleanText(submittedBySource?.name, 120) || null,
  };
  if (!submittedBy.role) {
    fail("submittedBy.role不能为空", "CONTENT_PIPELINE_METRICS_INVALID", 400);
  }
  return safeValue({
    schemaVersion: PUBLICATION_METRICS_ENTRY_SCHEMA,
    publication: {
      platform,
      url: parsedUrl.toString(),
      publishedAt: new Date(publishedAt).toISOString(),
      externalId: cleanText(publication.externalId, 240) || null,
    },
    metrics,
    evidenceNote: cleanText(value.evidenceNote, 1_000) || null,
    verification: {
      status: "manual_unverified",
      source: "human_submission",
      platformVerified: false,
    },
    submittedBy,
    submittedAt: actor
      ? nowDate.toISOString()
      : new Date(value.submittedAt || publishedAt).toISOString(),
  });
}

function normalizePublicationMetricsCollection(
  value,
  { task = null, now = () => new Date() } = {},
) {
  const requiredPlatforms = publicationPlatforms(task);
  if (!requiredPlatforms.length) {
    fail(
      "任务缺少目标平台，不能接收发布指标",
      "CONTENT_PIPELINE_METRICS_INVALID",
      400,
    );
  }
  const rawEntries =
    isObject(value) &&
    value.schemaVersion === PUBLICATION_METRICS_COLLECTION_SCHEMA &&
    Array.isArray(value.entries)
      ? value.entries
      : isObject(value) &&
          isObject(value.publication) &&
          isObject(value.metrics)
        ? [value]
        : null;
  if (!rawEntries) {
    fail("发布指标集合格式无效", "CONTENT_PIPELINE_METRICS_INVALID", 400);
  }
  const byPlatform = new Map();
  for (const rawEntry of rawEntries) {
    const entry = normalizePublicationMetricsEntry(rawEntry, { task, now });
    if (byPlatform.has(entry.publication.platform)) {
      fail(
        "同一平台不能在发布指标集合中重复出现",
        "CONTENT_PIPELINE_METRICS_INVALID",
        400,
      );
    }
    byPlatform.set(entry.publication.platform, entry);
  }
  const entries = requiredPlatforms
    .map((platform) => byPlatform.get(platform))
    .filter(Boolean);
  const submittedPlatforms = entries.map((entry) => entry.publication.platform);
  const missingPlatforms = requiredPlatforms.filter(
    (platform) => !byPlatform.has(platform),
  );
  return safeValue({
    schemaVersion: PUBLICATION_METRICS_COLLECTION_SCHEMA,
    requiredPlatforms,
    entries,
    submittedPlatforms,
    missingPlatforms,
    complete: missingPlatforms.length === 0,
    verificationStatus: "manual_unverified",
    lastSubmittedPlatform:
      cleanText(value.lastSubmittedPlatform, 40) ||
      entries.at(-1)?.publication?.platform ||
      null,
    updatedAt:
      cleanText(value.updatedAt, 80) || entries.at(-1)?.submittedAt || null,
  });
}

function mergePublicationMetrics(existing, entry, { task, now }) {
  const current =
    existing === null || existing === undefined
      ? null
      : normalizePublicationMetricsCollection(existing, { task, now });
  const byPlatform = new Map(
    (current?.entries || []).map((item) => [item.publication.platform, item]),
  );
  byPlatform.set(entry.publication.platform, entry);
  return normalizePublicationMetricsCollection(
    {
      schemaVersion: PUBLICATION_METRICS_COLLECTION_SCHEMA,
      entries: [...byPlatform.values()],
      lastSubmittedPlatform: entry.publication.platform,
      updatedAt: entry.submittedAt,
    },
    { task, now },
  );
}

function publicationMetricsOrNull(value, task) {
  try {
    const collection = normalizePublicationMetricsCollection(value, { task });
    return collection.complete ? collection : null;
  } catch {
    return null;
  }
}

export function contentPipelineUsesPredictiveRetro(workflow) {
  const policyMode = String(workflow?.approvalPolicy?.mode || "").trim();
  const mode = String(workflow?.mode || "").trim();
  return (
    policyMode === "internal_auto" ||
    mode === "fullauto" ||
    mode === "autopilot"
  );
}

function pipelineMustAwaitPublicationMetrics(job) {
  if (contentPipelineUsesPredictiveRetro(job?.workflow)) return false;
  return !publicationMetricsOrNull(
    job?.workflow?.publicationMetrics,
    job?.task,
  );
}

function descriptorAt(stationIdx) {
  const descriptor = CONTENT_HANDLER_ADAPTER_CATALOG[stationIdx];
  if (!descriptor || descriptor.employeeIdx !== stationIdx) {
    fail(
      `内容工位${stationIdx}没有可执行handler`,
      "CONTENT_PIPELINE_HANDLER_MISSING",
      500,
    );
  }
  return descriptor;
}

function workflowMode(value) {
  const mode = String(value || "copilot").trim();
  if (!WORKFLOW_MODES.has(mode)) {
    fail(
      "workflow.mode必须是fullauto、autopilot、copilot或manual",
      undefined,
      400,
    );
  }
  return mode;
}

export function validatePaihuoContentBrief(value) {
  if (!isObject(value)) fail("Paihuo Brief必须是对象", undefined, 400);
  const source = safeValue(value);
  let xhsOptions;
  if (source.xhsOptions !== undefined) {
    const options = source.xhsOptions;
    if (!resolveXhsSalesContext(3, { task: source }).salesMode || !isObject(options)
      || Object.keys(options).some(key => !['versionCount','audience','scene','category','city'].includes(key))) {
      fail('Paihuo Brief.xhsOptions仅供明确的小红书带货任务，且必须是合法选项对象', undefined, 400);
    }
    const count = options.versionCount ?? 3;
    if (!Number.isInteger(count) || count < 2 || count > 4) fail('小红书版本数必须是2..4的整数', undefined, 400);
    for (const field of ['audience','scene','category','city']) {
      if (options[field] !== undefined && (typeof options[field] !== 'string' || options[field].length > 120)) {
        fail(`xhsOptions.${field}必须是不超过120字的字符串`, undefined, 400);
      }
    }
    xhsOptions = { versionCount: count, ...Object.fromEntries(['audience','scene','category','city']
      .filter(key => options[key] !== undefined).map(key => [key, options[key].trim()])) };
  }
  const text = (field, limit, required = false) => {
    if (
      source[field] !== undefined &&
      source[field] !== null &&
      typeof source[field] !== "string"
    ) {
      fail(`Paihuo Brief.${field}必须是字符串`, undefined, 400);
    }
    const result = cleanText(source[field] || "", limit);
    if (required && !result)
      fail("Paihuo Brief.direction不能为空", undefined, 400);
    return result;
  };
  const refLink = text("ref_link", 2_000);
  if (refLink) {
    let parsed;
    try {
      parsed = new URL(refLink);
    } catch {
      /* 下方统一拒绝 */
    }
    if (
      !parsed ||
      !["http:", "https:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      fail(
        "Paihuo Brief.ref_link必须是不携带凭据的http/https地址",
        undefined,
        400,
      );
    }
  }
  const platforms = source.platforms ?? ["小红书"];
  if (
    !Array.isArray(platforms) ||
    !platforms.length ||
    platforms.length > CONTENT_PLATFORMS.size ||
    platforms.some(
      (item) => typeof item !== "string" || !CONTENT_PLATFORMS.has(item),
    )
  ) {
    fail("Paihuo Brief.platforms包含不支持的平台", undefined, 400);
  }
  const imageMode = source.image_mode || "ai";
  if (!["ai", "real", "mix"].includes(imageMode)) {
    fail("Paihuo Brief.image_mode必须是ai、real或mix", undefined, 400);
  }
  const imageCount = source.image_count ?? null;
  if (
    imageCount !== null &&
    (!Number.isInteger(imageCount) || imageCount < 0 || imageCount > 12)
  ) {
    fail("Paihuo Brief.image_count必须是0..12之间的整数或null", undefined, 400);
  }
  const enableDeck = source.enable_deck ?? false;
  if (typeof enableDeck !== "boolean") {
    fail("Paihuo Brief.enable_deck必须是布尔值", undefined, 400);
  }
  const styles = {};
  for (const field of ["xhs_style", "dy_style"]) {
    if (
      source[field] === undefined ||
      source[field] === null ||
      source[field] === ""
    ) {
      styles[field] = null;
      continue;
    }
    if (
      !isObject(source[field]) ||
      typeof source[field].name !== "string" ||
      typeof source[field].desc !== "string" ||
      source[field].name.length > 300 ||
      source[field].desc.length > 300
    ) {
      fail(`Paihuo Brief.${field}必须是{name,desc}对象`, undefined, 400);
    }
    styles[field] = {
      name: source[field].name.trim(),
      desc: source[field].desc.trim(),
    };
  }
  return {
    direction: text("direction", 2_000, true),
    template: text("template", 120),
    industry: text("industry", 120),
    material: text("material", 20_000),
    ref_link: refLink,
    platforms: [...new Set(platforms)],
    image_mode: imageMode,
    image_count: imageCount,
    enable_deck: enableDeck,
    xhs_style: styles.xhs_style,
    dy_style: styles.dy_style,
    ...(xhsOptions ? { xhsOptions } : {}),
  };
}

function approvalPolicy(value) {
  if (value === undefined || value === null) {
    return { mode: "factory", reviewStations: null, configuredBy: null };
  }
  if (
    !isObject(value) ||
    !["factory", "custom", "internal_auto"].includes(String(value.mode || ""))
  ) {
    fail(
      "workflow.approvalPolicy.mode必须是factory、custom或internal_auto",
      undefined,
      400,
    );
  }
  if (value.mode === "factory") {
    return {
      mode: "factory",
      reviewStations: null,
      configuredBy: isObject(value.configuredBy)
        ? safeValue(value.configuredBy)
        : null,
    };
  }
  if (value.mode === "internal_auto") {
    const configuredBy = isObject(value.configuredBy)
      ? safeValue(value.configuredBy)
      : null;
    if (
      !configuredBy ||
      !Number.isInteger(Number(configuredBy.id)) ||
      Number(configuredBy.id) <= 0 ||
      !cleanText(configuredBy.role, 64)
    ) {
      fail(
        "internal_auto内部流转策略必须绑定已认证发起人",
        "CONTENT_PIPELINE_INTERNAL_AUTO_IDENTITY_REQUIRED",
        403,
      );
    }
    return {
      mode: "internal_auto",
      reviewStations: [],
      configuredBy,
      automaticBusinessAdoptionAllowed: false,
      externalPublishAllowed: false,
    };
  }
  if (!Array.isArray(value.reviewStations)) {
    fail("custom审批策略必须提供reviewStations数组", undefined, 400);
  }
  const reviewStations = [...new Set(value.reviewStations.map(Number))].sort(
    (a, b) => a - b,
  );
  if (
    reviewStations.some((idx) => !Number.isInteger(idx) || idx < 0 || idx > 9)
  ) {
    fail(
      "workflow.approvalPolicy.reviewStations只能包含0..9工位",
      undefined,
      400,
    );
  }
  const configuredBy = isObject(value.configuredBy)
    ? safeValue(value.configuredBy)
    : null;
  if (
    !configuredBy ||
    !Number.isInteger(Number(configuredBy.id)) ||
    Number(configuredBy.id) <= 0 ||
    !OWNER_APPROVAL_POLICY_ROLES.has(cleanText(configuredBy.role, 64))
  ) {
    fail(
      "custom审批策略必须由老板或管理员的已认证身份配置",
      "CONTENT_PIPELINE_APPROVAL_POLICY_AUTHORITY_REQUIRED",
      403,
    );
  }
  return {
    mode: "custom",
    reviewStations,
    configuredBy,
    externalPublishAllowed: false,
  };
}

function stationNeedsReview(boundaryCode, mode, stationIdx, policy) {
  if (policy?.mode === "internal_auto") return false;
  if (policy?.mode === "custom")
    return policy.reviewStations.includes(stationIdx);
  if (boundaryCode === "force") return true;
  if (mode === "fullauto" || mode === "autopilot") return false;
  if (mode === "manual") return true;
  return boundaryCode === "pick" || boundaryCode === "review";
}

function ownerApprovalPolicyAudit({
  pipelineId,
  stationIdx,
  descriptor,
  boundary,
  policy,
  selection,
  now,
}) {
  const internalAuto = policy?.mode === "internal_auto";
  return safeValue({
    schemaVersion: internalAuto
      ? "nanowork.content-production-internal-auto-policy-audit/1"
      : "nanowork.content-production-owner-approval-policy-audit/1",
    source: internalAuto
      ? "authenticated_internal_report_auto_policy"
      : "owner_configured_pipeline_approval_policy",
    runId: String(pipelineId),
    handlerId: descriptor.handlerId,
    stationIdx,
    factoryApprovalCode: boundary.code,
    action: "handoff",
    outcome: "allowed",
    reasonCode: internalAuto
      ? "CONTENT_PIPELINE_INTERNAL_REPORT_AUTO_HANDOFF"
      : "CONTENT_PIPELINE_OWNER_APPROVAL_POLICY_AUTO_HANDOFF",
    reason: internalAuto
      ? "当前任务采用内部报告自动接力；只允许内部交接，不代表对外发布、付费执行或不可逆业务采纳"
      : "本工位未被老板自定义为停站审阅点，只允许内部交接，不代表对外发布或不可逆业务采纳",
    automated: true,
    workflowMode: internalAuto ? "internal_auto" : "custom_approval",
    configuredBy: safeValue(policy.configuredBy),
    reviewStations: [...policy.reviewStations],
    selection: selection ? safeValue(selection) : null,
    controls: {
      automaticInternalHandoffAllowed: true,
      automaticBusinessAdoptionAllowed: false,
      externalPublishAllowed: false,
    },
    decidedAt: instant(now),
  });
}

export async function executeStationDeliveryDirect({ generate, persist } = {}) {
  if (typeof generate !== "function" || typeof persist !== "function") {
    fail(
      "工位交付边界缺少generate或persist回调",
      "CONTENT_PIPELINE_DELIVERY_BOUNDARY_INVALID",
      500,
    );
  }
  const generated = await generate();
  const persisted = await persist(generated);
  return { generated, persisted, billingEvidence: null };
}

function expectedStationPromptEvidence(
  descriptor,
  stationExecution,
  contextSnapshot,
) {
  const profile = stationExecution.canonicalProfile;
  return safeValue({
    schemaVersion: "nanowork.content-production-expected-prompt-evidence/1",
    messageMode:
      descriptor.promptContract?.messageMode || "system_user_separated",
    handlerId: descriptor.handlerId,
    sourcePromptFingerprint:
      profile.prompts?.pipelinePrompt?.sourceFingerprint || null,
    canonicalProfileVersion: profile.version?.profile || null,
    canonicalAggregateFingerprint:
      stationExecution.runtimePackageLoad.aggregateFingerprint,
    canonicalFieldFingerprints:
      stationExecution.runtimePackageLoad.fieldFingerprints,
    allCanonicalFieldsLoaded:
      stationExecution.runtimePackageLoad.allRequiredFieldsLoaded === true,
    estimatedCanonicalPackageChars: JSON.stringify(profile).length,
    runtimeContextFingerprint: contextSnapshot?.contextFingerprint || null,
    upstreamFingerprint: contextSnapshot?.upstream?.fingerprint || null,
    knowledgeInjectedChars:
      contextSnapshot?.knowledgeRecall?.injectedChars || 0,
    promptTextIncluded: false,
    credentialsIncluded: false,
  });
}

function defaultCompileStationExecution({ stationIdx }) {
  const canonicalProfile = validateCanonicalEmployeeProfile(
    canonicalContentEmployeeProfileFor(stationIdx),
  );
  const loadedFields = [...CANONICAL_EMPLOYEE_PROFILE_FIELDS];
  const currentBindings =
    canonicalProfile.runtimeBindings?.currentRuntimeBindings || {};
  return {
    canonicalProfile,
    runtimePackageLoad: {
      schemaVersion: CONTENT_PRODUCTION_RUNTIME_PACKAGE_LOAD_SCHEMA,
      sourceSchemaVersion: canonicalProfile.schemaVersion,
      employeeIdx: stationIdx,
      requiredFields: loadedFields,
      loadedFields,
      fieldFingerprints: safeValue(canonicalProfile.fingerprints.fields),
      aggregateFingerprint: canonicalProfile.fingerprints.aggregate,
      profileVersion: canonicalProfile.version.profile,
      sourcePromptFingerprint:
        canonicalProfile.prompts?.pipelinePrompt?.sourceFingerprint || null,
      allRequiredFieldsLoaded: true,
      fullCanonicalObjectInSystemMessage: true,
      capabilityCount: canonicalProfile.capabilities.length,
      requiredSkillCount: canonicalProfile.skills.required.length,
      historicalSkillCount: canonicalProfile.skills.catalog.length,
      learnedSkillCount: canonicalProfile.skills.learned.length,
      enabledSkillCount: canonicalProfile.skills.enabled.length,
      apiBindingCount: Array.isArray(currentBindings.apis)
        ? currentBindings.apis.length
        : 0,
      toolBindingCount: Array.isArray(currentBindings.tools)
        ? currentBindings.tools.length
        : 0,
      connectorBindingCount: Array.isArray(currentBindings.connectors)
        ? currentBindings.connectors.length
        : 0,
      promptTextIncludedInSystemMessage: true,
      workConfigIncludedInSystemMessage: true,
      jobProfileIncludedInSystemMessage: true,
      contractsIncludedInCanonicalObject: true,
      permissionsIncludedInCanonicalObject: true,
    },
  };
}

function validateStationExecutionPackage(compiled, stationIdx) {
  if (
    !isObject(compiled) ||
    !isObject(compiled.canonicalProfile) ||
    !isObject(compiled.runtimePackageLoad)
  ) {
    fail(
      "工位执行编译器没有返回完整canonical employee package",
      "CONTENT_PIPELINE_RUNTIME_PACKAGE_MISSING",
    );
  }
  let canonicalProfile;
  try {
    canonicalProfile = validateCanonicalEmployeeProfile(
      compiled.canonicalProfile,
    );
  } catch (cause) {
    fail(
      `工位${stationIdx}的canonical employee package校验失败：${cleanText(cause?.message, 240)}`,
      "CONTENT_PIPELINE_RUNTIME_PACKAGE_INVALID",
    );
  }
  const load = compiled.runtimePackageLoad;
  const fieldsComplete = CANONICAL_EMPLOYEE_PROFILE_FIELDS.every(
    (field) =>
      Object.hasOwn(canonicalProfile, field) &&
      Array.isArray(load.loadedFields) &&
      load.loadedFields.includes(field) &&
      load.fieldFingerprints?.[field] ===
        canonicalProfile.fingerprints.fields[field],
  );
  if (
    canonicalProfile.identity?.domain !== "content" ||
    Number(canonicalProfile.identity?.idx) !== stationIdx ||
    Number(load.employeeIdx) !== stationIdx ||
    load.aggregateFingerprint !== canonicalProfile.fingerprints.aggregate ||
    load.allRequiredFieldsLoaded !== true ||
    load.fullCanonicalObjectInSystemMessage !== true ||
    !fieldsComplete
  ) {
    fail(
      `工位${stationIdx}的canonical 11字段、指纹或员工身份不完整`,
      "CONTENT_PIPELINE_RUNTIME_PACKAGE_INVALID",
    );
  }
  const currentBindings =
    canonicalProfile.runtimeBindings?.currentRuntimeBindings || {};
  return {
    canonicalProfile: safeValue(canonicalProfile),
    runtimePackageLoad: safeValue({
      ...load,
      requiredFields: [...CANONICAL_EMPLOYEE_PROFILE_FIELDS],
      loadedFields: [...CANONICAL_EMPLOYEE_PROFILE_FIELDS],
      fieldFingerprints: canonicalProfile.fingerprints.fields,
      aggregateFingerprint: canonicalProfile.fingerprints.aggregate,
      profileVersion: canonicalProfile.version.profile,
      sourcePromptFingerprint:
        canonicalProfile.prompts?.pipelinePrompt?.sourceFingerprint || null,
      employeeIdx: stationIdx,
      allRequiredFieldsLoaded: true,
      fullCanonicalObjectInSystemMessage: true,
      capabilityCount: canonicalProfile.capabilities.length,
      requiredSkillCount: canonicalProfile.skills.required.length,
      historicalSkillCount: canonicalProfile.skills.catalog.length,
      learnedSkillCount: canonicalProfile.skills.learned.length,
      enabledSkillCount: canonicalProfile.skills.enabled.length,
      apiBindingCount: Array.isArray(currentBindings.apis)
        ? currentBindings.apis.length
        : 0,
      toolBindingCount: Array.isArray(currentBindings.tools)
        ? currentBindings.tools.length
        : 0,
      connectorBindingCount: Array.isArray(currentBindings.connectors)
        ? currentBindings.connectors.length
        : 0,
      promptTextIncludedInSystemMessage: true,
      workConfigIncludedInSystemMessage: true,
      jobProfileIncludedInSystemMessage: true,
      contractsIncludedInCanonicalObject: true,
      permissionsIncludedInCanonicalObject: true,
    }),
  };
}

function expectedOutputKeys(stationIdx) {
  const descriptor = descriptorAt(stationIdx);
  const employee = CONTENT_HANDLER_ADAPTER_CATALOG.find(
    (item) => item.employeeIdx === stationIdx,
  );
  return employee?.outputKeys || descriptor.outputKeys || [];
}

function extractOutput(invocation, stationIdx, context = {}) {
  const keys = resolveXhsSalesContext(stationIdx, context).salesMode ? ['versions', 'image_plan'] : expectedOutputKeys(stationIdx);
  const result = invocation?.result;
  const candidates = [
    result?.data,
    result?.output,
    result?.parsed,
    result,
  ].filter(isObject);
  const output = candidates.find((candidate) =>
    keys.every((key) => Object.hasOwn(candidate, key)),
  );
  if (!output) {
    fail(
      `工位${stationIdx}输出未满足契约，缺少：${keys.join("、")}`,
      "CONTENT_PIPELINE_OUTPUT_CONTRACT_FAILED",
      422,
    );
  }
  return stationIdx === 3 && isXhsPipelineDraft(output)
    ? generationOwnedOutput(stationIdx, output) : safeValue(output);
}

function candidateList(stationIdx, output) {
  if (stationIdx === 3 && Array.isArray(output?.versions)) {
    return output.versions.map(version => ({ ...version, candidateId: xhsVersionId(version) }));
  }
  const key =
    stationIdx === 0
      ? "topics"
      : stationIdx === 5
        ? "images"
        : stationIdx === 6
          ? "covers"
          : null;
  return key && Array.isArray(output?.[key]) ? output[key] : [];
}

function applySelection(stationIdx, output, decision) {
  if (!decision?.selection) return output;
  const selected = safeValue(decision.selection);
  const next = { ...safeValue(output), selection: selected };
  if (stationIdx === 0 && Number.isInteger(selected.candidateIndex)) {
    next.selected = selected.candidateIndex;
  } else if (stationIdx === 3 && isXhsPipelineDraft(output) && Number.isInteger(selected.candidateIndex)) {
    const version = output.versions[selected.candidateIndex];
    if (!version) fail('所选小红书版本不存在', 'CONTENT_PIPELINE_XHS_SELECTION_INVALID', 409);
    next.xhsSelection = { versionId: xhsVersionId(version), strategy: version.strategy,
      selectedBy: decision.auditRecord?.actor?.actorId, selectedAt: decision.auditRecord?.decidedAt };
  } else if (stationIdx === 5 && Number.isInteger(selected.candidateIndex)) {
    next.selected_image = selected.candidateIndex;
  } else if (stationIdx === 6 && Number.isInteger(selected.candidateIndex)) {
    next.selected_cover = selected.candidateIndex;
  }
  return next;
}

function assertPersistedUpstream(rows, stationIdx) {
  const outputs = {};
  const seen = new Set();
  const skipped = new Set();
  for (const row of rows) {
    const idx = Number(row.stationIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= stationIdx) continue;
    if (row.status === "skipped") {
      if (idx !== 7 || row.output !== null) {
        fail(
          `工位${idx}的skipped状态不合法`,
          "CONTENT_PIPELINE_SKIPPED_UPSTREAM_INVALID",
        );
      }
      skipped.add(idx);
      seen.add(idx);
      continue;
    }
    if (row.status !== "completed") continue;
    if (!isObject(row.output)) {
      fail(
        `工位${stationIdx}缺少数据库已持久化的工位${idx}上游产物`,
        "CONTENT_PIPELINE_PERSISTED_UPSTREAM_MISSING",
      );
    }
    outputs[idx] = safeValue(row.output);
    seen.add(idx);
  }
  for (let idx = 0; idx < stationIdx; idx += 1) {
    if (!seen.has(idx)) {
      fail(
        `工位${stationIdx}不能执行：数据库中工位${idx}的真实上游产物未完成`,
        "CONTENT_PIPELINE_PERSISTED_UPSTREAM_MISSING",
      );
    }
  }
  return { outputs, skipped: [...skipped].sort((a, b) => a - b) };
}

function normalizeJobRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    createdBy: Number(row.created_by),
    title: row.title,
    status: row.status,
    currentStation: Number(row.current_station),
    pendingStation:
      row.pending_station === null ? null : Number(row.pending_station),
    task: parseJson(row.task_json, {}),
    persona: parseJson(row.persona_json, {}),
    settings: parseJson(row.settings_json, {}),
    workflow: parseJson(row.workflow_json, {}),
    failure: parseJson(row.failure_json, null),
    version: Number(row.version || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeStationRow(row) {
  if (!row) return null;
  return {
    pipelineId: Number(row.pipeline_id),
    tenantId: Number(row.tenant_id),
    stationIdx: Number(row.station_idx),
    employeeKey: row.employee_key,
    handlerId: row.handler_id,
    status: row.status,
    attempt: Number(row.attempt || 0),
    output: parseJson(row.output_json, null),
    handlerEvidence: parseJson(row.handler_evidence_json, null),
    billingEvidence: parseJson(row.billing_evidence_json, null),
    contextSnapshot: parseJson(row.context_snapshot_json, null),
    approvalBoundary: parseJson(row.approval_boundary_json, null),
    approvalAudit: parseJson(row.approval_audit_json, []),
    selection: parseJson(row.selection_json, null),
    failure: parseJson(row.failure_json, null),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function normalizeArtifactRow(row, { includeContent = false } = {}) {
  if (!row) return null;
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    pipelineId: Number(row.pipeline_id),
    stationIdx: Number(row.station_idx),
    stationAttempt: Number(row.station_attempt),
    artifactIndex: Number(row.artifact_index),
    kind: row.kind,
    primary: Number(row.is_primary) === 1,
    filename: row.filename,
    mediaType: row.media_type,
    byteSize: Number(row.byte_size),
    sha256: row.content_sha256,
    sourceKeys: parseJson(row.source_keys_json, []),
    createdAt: row.created_at,
    ...(includeContent ? { content: row.content } : {}),
  };
}

function normalizeArtifactBackfillRow(row) {
  if (!row) return null;
  return {
    pipelineId: Number(row.pipeline_id),
    stationIdx: Number(row.station_idx),
    stationAttempt: Number(row.station_attempt),
    outcome: row.outcome,
    reasonCode: row.reason_code,
    message: row.message,
    evidence: parseJson(row.evidence_json, {}),
    checkedAt: row.checked_at,
  };
}

function normalizePhaseEventRow(row) {
  if (!row) return null;
  return {
    schemaVersion: CONTENT_PRODUCTION_PHASE_EVENT_SCHEMA,
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    pipelineId: Number(row.pipeline_id),
    stationIdx: Number(row.station_idx),
    attempt: Number(row.station_attempt),
    phase: row.phase,
    state: row.state,
    detail: normalizedPhaseEventDetail(parseJson(row.detail_json, {})),
    usageRef: normalizedPhaseEventUsageRef(parseJson(row.usage_ref_json, null)),
    occurredAt: row.occurred_at,
  };
}

/**
 * SQLite持久化适配器。所有读写都显式带tenant_id，不经过全局租户隐式注入。
 * ensureSchema由集成层在启动迁移期调用，引擎本身不会悄悄改表。
 */
export function createSqliteContentProductionPipelineRepository({
  db,
  now = () => new Date(),
  interruptedStaleMs = CONTENT_PRODUCTION_INTERRUPTED_STALE_MS,
} = {}) {
  if (
    !db ||
    typeof db.prepare !== "function" ||
    typeof db.exec !== "function"
  ) {
    fail("创建流水线仓库必须传入SQLite数据库", undefined, 500);
  }
  if (
    !Number.isSafeInteger(interruptedStaleMs) ||
    interruptedStaleMs < 60_000
  ) {
    fail("interruptedStaleMs必须是至少60000毫秒的整数", undefined, 500);
  }
  const timestamp = () => instant(now);
  const transaction = (operation) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 保留原始错误 */
      }
      throw error;
    }
  };

  const insertPhaseEvent = (input, occurredAt = timestamp()) => {
    const event = normalizePhaseEventInput(input);
    const info = db
      .prepare(
        `INSERT INTO content_production_pipeline_phase_events(
        tenant_id,pipeline_id,station_idx,station_attempt,phase,state,
        detail_json,usage_ref_json,occurred_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        event.tenantId,
        event.pipelineId,
        event.stationIdx,
        event.stationAttempt,
        event.phase,
        event.state,
        json(event.detail),
        event.usageRef ? json(event.usageRef) : null,
        occurredAt,
      );
    return normalizePhaseEventRow(
      db
        .prepare(
          `SELECT * FROM content_production_pipeline_phase_events WHERE id=?`,
        )
        .get(Number(info.lastInsertRowid)),
    );
  };

  const tableExists = (table) =>
    Boolean(
      db
        .prepare(
          `SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,
        )
        .get(table)?.ok,
    );
  const knowledgeSinkTablesAvailable = () =>
    tableExists("biz_assets") && tableExists("kb_docs");

  const getJob = (tenantId, pipelineId) =>
    normalizeJobRow(
      db
        .prepare(
          `SELECT *
    FROM content_production_pipeline_jobs WHERE tenant_id=? AND id=?`,
        )
        .get(tenantId, pipelineId),
    );
  const getStation = (tenantId, pipelineId, stationIdx) =>
    normalizeStationRow(
      db
        .prepare(
          `SELECT *
    FROM content_production_pipeline_stations
    WHERE tenant_id=? AND pipeline_id=? AND station_idx=?`,
        )
        .get(tenantId, pipelineId, stationIdx),
    );

  const getKnowledgeSinkRows = (tenantId, pipelineId) => {
    if (!knowledgeSinkTablesAvailable()) return { asset: null, kbDoc: null };
    return {
      asset:
        db
          .prepare(
            `SELECT id,name,category,status,source_type,source_id,url,note,created_at,updated_at
        FROM biz_assets
        WHERE tenant_id=? AND source_type='content_pipeline' AND source_id=?
        ORDER BY id LIMIT 1`,
          )
          .get(tenantId, pipelineId) || null,
      kbDoc:
        db
          .prepare(
            `SELECT id,category,title,body,source_type,source_id,enabled,updated_at
        FROM kb_docs
        WHERE tenant_id=? AND source_type='content_pipeline' AND source_id=?
        ORDER BY id LIMIT 1`,
          )
          .get(tenantId, pipelineId) || null,
    };
  };

  const billingEvidenceReady = (evidence) => {
    if (
      !isObject(evidence) ||
      evidence.pendingReconciliation === true ||
      Number(evidence.heldCredits || 0) > 0
    )
      return false;
    const state = cleanText(
      evidence.state || evidence.status,
      80,
    ).toLowerCase();
    if (state !== "settled") return false;
    const chargedValue = evidence.chargedCredits ?? evidence.credits;
    if (
      chargedValue === null ||
      chargedValue === undefined ||
      chargedValue === ""
    ) {
      return false;
    }
    const chargedCredits = Number(chargedValue);
    return Number.isFinite(chargedCredits) && chargedCredits >= 0;
  };

  const stationSummaryForKnowledge = (station) =>
    safeValue({
      stationIdx: station.stationIdx,
      employeeKey: station.employeeKey,
      handlerId: station.handlerId,
      status: station.status,
      attempt: station.attempt,
      outputFingerprint: station.output ? fingerprint(station.output) : null,
      billingState:
        station.status === "skipped"
          ? "not_required"
          : cleanText(
              station.billingEvidence?.state || station.billingEvidence?.status,
              80,
            ) || null,
    });

  const knowledgeSinkReadiness = (tenantId, pipelineId) => {
    const job = getJob(tenantId, pipelineId);
    if (!job) {
      return {
        ready: false,
        reasonCode: "CONTENT_PIPELINE_KNOWLEDGE_JOB_MISSING",
        reason: "流水线不存在",
      };
    }
    const metrics = publicationMetricsOrNull(
      job.workflow?.publicationMetrics,
      job.task,
    );
    const stations = db
      .prepare(
        `SELECT * FROM content_production_pipeline_stations
      WHERE tenant_id=? AND pipeline_id=? ORDER BY station_idx`,
      )
      .all(tenantId, pipelineId)
      .map(normalizeStationRow);
    const stationByIdx = new Map(
      stations.map((station) => [station.stationIdx, station]),
    );
    const stationSummaries = stations.map(stationSummaryForKnowledge);
    const blocked = (reasonCode, reason) => ({
      ready: false,
      reasonCode,
      reason,
      evidence: safeValue({
        jobStatus: job.status,
        currentStation: job.currentStation,
        publicationMetricsComplete: metrics?.complete === true,
        stationCount: stations.length,
        stationSummaries,
      }),
    });
    if (
      job.status !== "completed" ||
      job.currentStation !== CONTENT_PRODUCTION_PIPELINE_STATION_COUNT
    ) {
      return blocked(
        "CONTENT_PIPELINE_KNOWLEDGE_JOB_NOT_COMPLETED",
        "只有整条0→9流水线完成后才能沉淀最终资产",
      );
    }
    if (!metrics || metrics.complete !== true) {
      return blocked(
        "CONTENT_PIPELINE_KNOWLEDGE_METRICS_NOT_READY",
        "尚未齐备通过服务端校验的真实发布记录与数值指标",
      );
    }
    if (
      stations.length !== CONTENT_PRODUCTION_PIPELINE_STATION_COUNT ||
      [...Array(CONTENT_PRODUCTION_PIPELINE_STATION_COUNT).keys()].some(
        (stationIdx) => !stationByIdx.has(stationIdx),
      )
    ) {
      return blocked(
        "CONTENT_PIPELINE_KNOWLEDGE_STATIONS_INCOMPLETE",
        "十个内容工位记录不完整",
      );
    }
    for (
      let stationIdx = 0;
      stationIdx < CONTENT_PRODUCTION_PIPELINE_STATION_COUNT;
      stationIdx += 1
    ) {
      const station = stationByIdx.get(stationIdx);
      const optionalDeckSkipped =
        stationIdx === 7 &&
        job.task?.enable_deck === false &&
        station.status === "skipped";
      if (optionalDeckSkipped) continue;
      if (station.status !== "completed" || !isObject(station.output)) {
        return blocked(
          "CONTENT_PIPELINE_KNOWLEDGE_STATION_NOT_FINAL",
          `工位${stationIdx}尚未形成可用终态产物`,
        );
      }
      if (!billingEvidenceReady(station.billingEvidence)) {
        return blocked(
          "CONTENT_PIPELINE_KNOWLEDGE_BILLING_NOT_READY",
          `工位${stationIdx}账务尚未权威结算，禁止提前沉淀`,
        );
      }
    }
    const artifacts = db
      .prepare(
        `SELECT a.*
      FROM content_production_pipeline_artifacts a
      JOIN content_production_pipeline_stations s
        ON s.tenant_id=a.tenant_id AND s.pipeline_id=a.pipeline_id
        AND s.station_idx=a.station_idx AND s.attempt=a.station_attempt
      WHERE a.tenant_id=? AND a.pipeline_id=?
      ORDER BY a.station_idx,a.artifact_index,a.id`,
      )
      .all(tenantId, pipelineId);
    const artifactsByStation = new Map();
    for (const artifact of artifacts) {
      const stationArtifacts =
        artifactsByStation.get(Number(artifact.station_idx)) || [];
      stationArtifacts.push(artifact);
      artifactsByStation.set(Number(artifact.station_idx), stationArtifacts);
    }
    for (
      let stationIdx = 0;
      stationIdx < CONTENT_PRODUCTION_PIPELINE_STATION_COUNT;
      stationIdx += 1
    ) {
      if (
        stationIdx === 7 &&
        job.task?.enable_deck === false &&
        stationByIdx.get(stationIdx)?.status === "skipped"
      )
        continue;
      const stationArtifacts = artifactsByStation.get(stationIdx) || [];
      if (
        !stationArtifacts.length ||
        !stationArtifacts.some(
          (artifact) => Number(artifact.is_primary) === 1,
        ) ||
        stationArtifacts.some(
          (artifact) =>
            Number(artifact.byte_size) <= 0 ||
            !/^[a-f0-9]{64}$/u.test(String(artifact.content_sha256 || "")) ||
            !String(artifact.content || ""),
        )
      ) {
        return blocked(
          "CONTENT_PIPELINE_KNOWLEDGE_ARTIFACT_NOT_USABLE",
          `工位${stationIdx}缺少当前执行代次的可用主产物`,
        );
      }
    }
    const finalArtifacts = artifacts
      .filter(
        (artifact) =>
          [8, 9].includes(Number(artifact.station_idx)) &&
          Number(artifact.is_primary) === 1,
      )
      .map((artifact) => ({
        stationIdx: Number(artifact.station_idx),
        kind: artifact.kind,
        filename: artifact.filename,
        byteSize: Number(artifact.byte_size),
        sha256: artifact.content_sha256,
      }));
    if (
      !finalArtifacts.some((artifact) => artifact.stationIdx === 8) ||
      !finalArtifacts.some((artifact) => artifact.stationIdx === 9)
    ) {
      return blocked(
        "CONTENT_PIPELINE_KNOWLEDGE_FINAL_ARTIFACT_MISSING",
        "分发包或复盘报告缺少可用主产物",
      );
    }
    const station9 = stationByIdx.get(9);
    return {
      ready: true,
      job,
      metrics,
      station9,
      stationSummaries,
      stationSummaryFingerprint: fingerprint(stationSummaries),
      finalArtifacts,
      finalArtifactFingerprint: fingerprint(finalArtifacts),
      station9OutputFingerprint: fingerprint(station9.output),
      publicationMetricsFingerprint: fingerprint(metrics),
    };
  };

  const knowledgeSinkPublicState = (tenantId, pipelineId, readiness = null) => {
    if (!knowledgeSinkTablesAvailable()) {
      return safeValue({
        schemaVersion: CONTENT_PRODUCTION_KNOWLEDGE_SINK_SCHEMA,
        status: "unavailable",
        sourceType: "content_pipeline",
        sourceId: pipelineId,
        assetId: null,
        kbDocId: null,
        reasonCode: "CONTENT_PIPELINE_KNOWLEDGE_TABLES_UNAVAILABLE",
      });
    }
    const rows = getKnowledgeSinkRows(tenantId, pipelineId);
    const assetNote = parseJson(rows.asset?.note, {});
    if (rows.asset && rows.kbDoc) {
      return safeValue({
        schemaVersion: CONTENT_PRODUCTION_KNOWLEDGE_SINK_SCHEMA,
        status: "completed",
        sourceType: "content_pipeline",
        sourceId: pipelineId,
        assetId: Number(rows.asset.id),
        kbDocId: Number(rows.kbDoc.id),
        finalArtifactFingerprint: assetNote.finalArtifactFingerprint || null,
        stationSummaryFingerprint: assetNote.stationSummaryFingerprint || null,
        publicationMetricsFingerprint:
          assetNote.publicationMetricsFingerprint || null,
        completedAt:
          assetNote.completedAt ||
          rows.asset.created_at ||
          rows.kbDoc.updated_at ||
          null,
      });
    }
    const checked = readiness || knowledgeSinkReadiness(tenantId, pipelineId);
    return safeValue({
      schemaVersion: CONTENT_PRODUCTION_KNOWLEDGE_SINK_SCHEMA,
      status: rows.asset || rows.kbDoc ? "partial" : "pending",
      sourceType: "content_pipeline",
      sourceId: pipelineId,
      assetId: rows.asset ? Number(rows.asset.id) : null,
      kbDocId: rows.kbDoc ? Number(rows.kbDoc.id) : null,
      ready: checked.ready === true,
      reasonCode: checked.reasonCode || null,
      reason: checked.reason || null,
      evidence: checked.evidence || null,
    });
  };

  const knowledgeItemText = (value) => {
    if (typeof value === "string") return cleanText(value, 2_000);
    if (!isObject(value)) return "";
    return cleanText(
      value.title ||
        value.suggestion ||
        value.tip ||
        value.content ||
        JSON.stringify(safeValue(value)),
      2_000,
    );
  };

  const knowledgeDocumentBody = (readiness) => {
    const output = readiness.station9.output || {};
    const report = cleanText(output.report, 20_000) || "(复盘官未产出报告正文)";
    const topics = (Array.isArray(output.next_topics) ? output.next_topics : [])
      .map(knowledgeItemText)
      .filter(Boolean)
      .slice(0, 50);
    const updates = (
      Array.isArray(output.profile_updates) ? output.profile_updates : []
    )
      .map(knowledgeItemText)
      .filter(Boolean)
      .slice(0, 50);
    const stationLines = readiness.stationSummaries.map(
      (station) =>
        `- 工位${station.stationIdx} ${station.employeeKey}：${station.status}` +
        `；attempt=${station.attempt}` +
        `；output=${station.outputFingerprint || "none"}` +
        `；billing=${station.billingState || "none"}`,
    );
    return [
      `# 《${readiness.job.title}》交付复盘`,
      "",
      `来源流水线：content_pipeline#${readiness.job.id}`,
      `最终产物指纹：${readiness.finalArtifactFingerprint}`,
      `十工位摘要指纹：${readiness.stationSummaryFingerprint}`,
      `发布指标证据指纹：${readiness.publicationMetricsFingerprint}`,
      "",
      "## 复盘官报告",
      report,
      "",
      "## 回流选题",
      ...(topics.length ? topics.map((item) => `- ${item}`) : ["- (无)"]),
      "",
      "## 画像与经验更新",
      ...(updates.length ? updates.map((item) => `- ${item}`) : ["- (无)"]),
      "",
      "## 十工位交付摘要",
      ...stationLines,
    ].join("\n");
  };
  const insertArtifacts = ({
    tenantId,
    pipelineId,
    stationIdx,
    stationAttempt,
    artifacts,
    createdAt,
  }) => {
    const insertArtifact =
      db.prepare(`INSERT INTO content_production_pipeline_artifacts(
      tenant_id,pipeline_id,station_idx,station_attempt,artifact_index,kind,
      is_primary,filename,media_type,byte_size,content_sha256,source_keys_json,
      content,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    artifacts.forEach((artifact, artifactIndex) => {
      const sha256 = createHash("sha256")
        .update(artifact.content, "utf8")
        .digest("hex");
      insertArtifact.run(
        tenantId,
        pipelineId,
        stationIdx,
        stationAttempt,
        artifactIndex,
        artifact.kind,
        artifact.primary ? 1 : 0,
        artifact.filename,
        artifact.mediaType,
        Buffer.byteLength(artifact.content, "utf8"),
        sha256,
        json(artifact.sourceKeys),
        artifact.content,
        createdAt,
      );
    });
  };
  const writeBackfillAudit = ({
    tenantId,
    pipelineId,
    stationIdx,
    stationAttempt,
    result,
    checkedAt,
  }) => {
    db.prepare(
      `INSERT INTO content_production_pipeline_artifact_backfills(
      tenant_id,pipeline_id,station_idx,station_attempt,outcome,reason_code,
      message,evidence_json,checked_at
    ) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id,pipeline_id,station_idx,station_attempt) DO UPDATE SET
      outcome=excluded.outcome,reason_code=excluded.reason_code,message=excluded.message,
      evidence_json=excluded.evidence_json,checked_at=excluded.checked_at`,
    ).run(
      tenantId,
      pipelineId,
      stationIdx,
      stationAttempt,
      result.ok ? "inserted" : "skipped",
      result.reasonCode,
      cleanText(result.message, 500),
      json(result.evidence || {}),
      checkedAt,
    );
  };
  const persistPrivateWebSnapshot = ({
    tenantId,
    pipelineId,
    stationIdx,
    stationAttempt,
    privateWebSnapshot,
    persistedAt,
  }) => {
    if (!privateWebSnapshot) return false;
    const normalized = validateContentProductionPrivateWebSnapshot(
      privateWebSnapshot,
      { tenantId, pipelineId, stationIdx },
    );
    if (!normalized) return false;
    db.prepare(
      `INSERT INTO content_production_pipeline_private_web_snapshots(
      tenant_id,pipeline_id,station_idx,station_attempt,schema_version,
      input_fingerprint,query_plan_fingerprint,upstream_fingerprint,
      snapshot_fingerprint,snapshot_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id,pipeline_id,station_idx) DO UPDATE SET
      station_attempt=excluded.station_attempt,
      schema_version=excluded.schema_version,
      input_fingerprint=excluded.input_fingerprint,
      query_plan_fingerprint=excluded.query_plan_fingerprint,
      upstream_fingerprint=excluded.upstream_fingerprint,
      snapshot_fingerprint=excluded.snapshot_fingerprint,
      snapshot_json=excluded.snapshot_json,
      created_at=excluded.created_at,
      updated_at=excluded.updated_at`,
    ).run(
      tenantId,
      pipelineId,
      stationIdx,
      stationAttempt,
      normalized.schemaVersion,
      normalized.inputFingerprint,
      normalized.queryPlanFingerprint,
      normalized.upstreamFingerprint,
      normalized.snapshotFingerprint,
      json(normalized),
      normalized.createdAt,
      persistedAt,
    );
    return true;
  };
  const migrateLifecycleStatusChecks = () => {
    const jobSql = String(
      db
        .prepare(
          `SELECT sql FROM sqlite_master
        WHERE type='table' AND name='content_production_pipeline_jobs'`,
        )
        .get()?.sql || "",
    );
    const stationSql = String(
      db
        .prepare(
          `SELECT sql FROM sqlite_master
        WHERE type='table' AND name='content_production_pipeline_stations'`,
        )
        .get()?.sql || "",
    );
    if (
      jobSql.includes("'paused'") &&
      jobSql.includes("'cancelled'") &&
      stationSql.includes("'paused'") &&
      stationSql.includes("'cancelled'")
    ) {
      return false;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE content_production_pipeline_jobs
          RENAME TO content_production_pipeline_jobs_lifecycle_legacy;
        ALTER TABLE content_production_pipeline_stations
          RENAME TO content_production_pipeline_stations_lifecycle_legacy;
        CREATE TABLE content_production_pipeline_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          created_by INTEGER NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running','paused','awaiting_approval','billing_pending','completed','failed','rejected','cancelled')),
          current_station INTEGER NOT NULL DEFAULT 0 CHECK(current_station BETWEEN 0 AND 10),
          pending_station INTEGER CHECK(pending_station BETWEEN 0 AND 9),
          task_json TEXT NOT NULL,
          persona_json TEXT NOT NULL DEFAULT '{}',
          settings_json TEXT NOT NULL DEFAULT '{}',
          workflow_json TEXT NOT NULL DEFAULT '{}',
          failure_json TEXT,
          version INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE content_production_pipeline_stations (
          pipeline_id INTEGER NOT NULL,
          tenant_id INTEGER NOT NULL,
          station_idx INTEGER NOT NULL CHECK(station_idx BETWEEN 0 AND 9),
          employee_key TEXT NOT NULL,
          handler_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','running','paused','awaiting_approval','billing_pending','completed','skipped','failed','rejected','cancelled')),
          attempt INTEGER NOT NULL DEFAULT 0,
          output_json TEXT,
          handler_evidence_json TEXT,
          billing_evidence_json TEXT,
          context_snapshot_json TEXT,
          approval_boundary_json TEXT,
          approval_audit_json TEXT NOT NULL DEFAULT '[]',
          selection_json TEXT,
          failure_json TEXT,
          started_at TEXT,
          completed_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(pipeline_id,station_idx)
        );
        INSERT INTO content_production_pipeline_jobs(
          id,tenant_id,created_by,title,status,current_station,pending_station,
          task_json,persona_json,settings_json,workflow_json,failure_json,version,
          created_at,updated_at
        ) SELECT
          id,tenant_id,created_by,title,status,current_station,pending_station,
          task_json,persona_json,settings_json,workflow_json,failure_json,version,
          created_at,updated_at
        FROM content_production_pipeline_jobs_lifecycle_legacy;
        INSERT INTO content_production_pipeline_stations(
          pipeline_id,tenant_id,station_idx,employee_key,handler_id,status,attempt,
          output_json,handler_evidence_json,billing_evidence_json,context_snapshot_json,
          approval_boundary_json,approval_audit_json,selection_json,failure_json,
          started_at,completed_at,updated_at
        ) SELECT
          pipeline_id,tenant_id,station_idx,employee_key,handler_id,status,attempt,
          output_json,handler_evidence_json,billing_evidence_json,context_snapshot_json,
          approval_boundary_json,approval_audit_json,selection_json,failure_json,
          started_at,completed_at,updated_at
        FROM content_production_pipeline_stations_lifecycle_legacy;
        DROP TABLE content_production_pipeline_stations_lifecycle_legacy;
        DROP TABLE content_production_pipeline_jobs_lifecycle_legacy;
        CREATE INDEX idx_content_pipeline_jobs_tenant_status
          ON content_production_pipeline_jobs(tenant_id,status,updated_at DESC,id DESC);
        CREATE INDEX idx_content_pipeline_stations_tenant_pipeline
          ON content_production_pipeline_stations(tenant_id,pipeline_id,station_idx);
      `);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 保留原始错误 */
      }
      throw error;
    }
  };
  const backfillMissingArtifacts = () => {
    const candidates = db
      .prepare(
        `SELECT s.tenant_id,s.pipeline_id,s.station_idx,s.attempt
      FROM content_production_pipeline_stations s
      WHERE s.status IN ('completed','awaiting_approval','billing_pending')
        AND s.attempt>0 AND s.output_json IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM content_production_pipeline_artifacts a
          WHERE a.tenant_id=s.tenant_id AND a.pipeline_id=s.pipeline_id
            AND a.station_idx=s.station_idx AND a.station_attempt=s.attempt
        )
      ORDER BY s.tenant_id,s.pipeline_id,s.station_idx`,
      )
      .all();
    const summary = { checked: 0, inserted: 0, skipped: 0 };
    for (const candidate of candidates) {
      transaction(() => {
        const tenantId = Number(candidate.tenant_id);
        const pipelineId = Number(candidate.pipeline_id);
        const stationIdx = Number(candidate.station_idx);
        const stationAttempt = Number(candidate.attempt);
        const station = getStation(tenantId, pipelineId, stationIdx);
        const job = getJob(tenantId, pipelineId);
        if (
          !job ||
          !station ||
          station.attempt !== stationAttempt ||
          !["completed", "awaiting_approval", "billing_pending"].includes(
            station.status,
          ) ||
          !station.output
        )
          return;
        const exists = db
          .prepare(
            `SELECT 1 ok FROM content_production_pipeline_artifacts
          WHERE tenant_id=? AND pipeline_id=? AND station_idx=? AND station_attempt=? LIMIT 1`,
          )
          .get(tenantId, pipelineId, stationIdx, stationAttempt);
        if (exists?.ok === 1) return;
        const upstreamOutputs = {};
        for (const row of db
          .prepare(
            `SELECT station_idx,status,output_json
          FROM content_production_pipeline_stations
          WHERE tenant_id=? AND pipeline_id=? AND station_idx<? ORDER BY station_idx`,
          )
          .all(tenantId, pipelineId, stationIdx)) {
          if (row.status === "completed" && row.output_json) {
            upstreamOutputs[Number(row.station_idx)] = parseJson(
              row.output_json,
              {},
            );
          }
        }
        const result = evaluateArtifactBackfill({
          job,
          station,
          upstreamOutputs,
          privateOutputSnapshot: parseJson(db.prepare(`SELECT snapshot_json
            FROM content_production_pipeline_private_output_snapshots
            WHERE tenant_id=? AND pipeline_id=? AND station_idx=? AND station_attempt=?`)
            .get(tenantId, pipelineId, stationIdx, stationAttempt)?.snapshot_json, null),
        });
        const checkedAt = timestamp();
        if (result.ok) {
          insertArtifacts({
            tenantId,
            pipelineId,
            stationIdx,
            stationAttempt,
            artifacts: result.artifacts,
            createdAt: checkedAt,
          });
          summary.inserted += 1;
        } else {
          summary.skipped += 1;
        }
        summary.checked += 1;
        writeBackfillAudit({
          tenantId,
          pipelineId,
          stationIdx,
          stationAttempt,
          result,
          checkedAt,
        });
      });
    }
    return summary;
  };

  return Object.freeze({
    ensureSchema() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS content_production_pipeline_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          created_by INTEGER NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running','paused','awaiting_approval','billing_pending','completed','failed','rejected','cancelled')),
          current_station INTEGER NOT NULL DEFAULT 0 CHECK(current_station BETWEEN 0 AND 10),
          pending_station INTEGER CHECK(pending_station BETWEEN 0 AND 9),
          task_json TEXT NOT NULL,
          persona_json TEXT NOT NULL DEFAULT '{}',
          settings_json TEXT NOT NULL DEFAULT '{}',
          workflow_json TEXT NOT NULL DEFAULT '{}',
          failure_json TEXT,
          version INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_content_pipeline_jobs_tenant_status
          ON content_production_pipeline_jobs(tenant_id,status,updated_at DESC,id DESC);
        CREATE TABLE IF NOT EXISTS content_production_pipeline_idempotency (
          tenant_id INTEGER NOT NULL,
          namespace TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          pipeline_id INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(tenant_id,namespace,idempotency_key),
          UNIQUE(tenant_id,pipeline_id,namespace)
        );
        CREATE INDEX IF NOT EXISTS idx_content_pipeline_idempotency_pipeline
          ON content_production_pipeline_idempotency(tenant_id,pipeline_id);
        CREATE TABLE IF NOT EXISTS content_production_pipeline_stations (
          pipeline_id INTEGER NOT NULL,
          tenant_id INTEGER NOT NULL,
          station_idx INTEGER NOT NULL CHECK(station_idx BETWEEN 0 AND 9),
          employee_key TEXT NOT NULL,
          handler_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','running','paused','awaiting_approval','billing_pending','completed','skipped','failed','rejected','cancelled')),
          attempt INTEGER NOT NULL DEFAULT 0,
          output_json TEXT,
          handler_evidence_json TEXT,
          billing_evidence_json TEXT,
          context_snapshot_json TEXT,
          approval_boundary_json TEXT,
          approval_audit_json TEXT NOT NULL DEFAULT '[]',
          selection_json TEXT,
          failure_json TEXT,
          started_at TEXT,
          completed_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(pipeline_id,station_idx)
        );
        CREATE INDEX IF NOT EXISTS idx_content_pipeline_stations_tenant_pipeline
          ON content_production_pipeline_stations(tenant_id,pipeline_id,station_idx);
        CREATE TABLE IF NOT EXISTS content_production_pipeline_phase_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          pipeline_id INTEGER NOT NULL,
          station_idx INTEGER NOT NULL CHECK(station_idx BETWEEN 0 AND 9),
          station_attempt INTEGER NOT NULL CHECK(station_attempt >= 0),
          phase TEXT NOT NULL CHECK(phase IN (
            'claim','context','agentic_search','controlled_fetch','provider',
            'validate','persist','settle','failure','retry','recover'
          )),
          state TEXT NOT NULL CHECK(state IN (
            'started','completed','failed','skipped','waiting','recovered','retrying'
          )),
          detail_json TEXT NOT NULL DEFAULT '{}',
          usage_ref_json TEXT,
          occurred_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_content_pipeline_phase_events_station
          ON content_production_pipeline_phase_events(
            tenant_id,pipeline_id,station_idx,station_attempt,id
          );
        CREATE TABLE IF NOT EXISTS content_production_pipeline_artifacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          pipeline_id INTEGER NOT NULL,
          station_idx INTEGER NOT NULL CHECK(station_idx BETWEEN 0 AND 9),
          station_attempt INTEGER NOT NULL CHECK(station_attempt > 0),
          artifact_index INTEGER NOT NULL CHECK(artifact_index >= 0),
          kind TEXT NOT NULL,
          is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
          filename TEXT NOT NULL,
          media_type TEXT NOT NULL,
          byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
          content_sha256 TEXT NOT NULL,
          source_keys_json TEXT NOT NULL DEFAULT '[]',
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(tenant_id,pipeline_id,station_idx,station_attempt,artifact_index)
        );
        CREATE INDEX IF NOT EXISTS idx_content_pipeline_artifacts_station
          ON content_production_pipeline_artifacts(
            tenant_id,pipeline_id,station_idx,station_attempt,artifact_index
          );
        CREATE TABLE IF NOT EXISTS content_production_pipeline_artifact_backfills (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          pipeline_id INTEGER NOT NULL,
          station_idx INTEGER NOT NULL CHECK(station_idx BETWEEN 0 AND 9),
          station_attempt INTEGER NOT NULL CHECK(station_attempt > 0),
          outcome TEXT NOT NULL CHECK(outcome IN ('inserted','skipped')),
          reason_code TEXT NOT NULL,
          message TEXT NOT NULL,
          evidence_json TEXT NOT NULL DEFAULT '{}',
          checked_at TEXT NOT NULL,
          UNIQUE(tenant_id,pipeline_id,station_idx,station_attempt)
        );
        CREATE INDEX IF NOT EXISTS idx_content_pipeline_artifact_backfills_station
          ON content_production_pipeline_artifact_backfills(
            tenant_id,pipeline_id,station_idx,station_attempt
          );
        CREATE TABLE IF NOT EXISTS content_production_pipeline_private_web_snapshots (
          tenant_id INTEGER NOT NULL,
          pipeline_id INTEGER NOT NULL,
          station_idx INTEGER NOT NULL CHECK(station_idx BETWEEN 0 AND 2),
          station_attempt INTEGER NOT NULL CHECK(station_attempt > 0),
          schema_version TEXT NOT NULL,
          input_fingerprint TEXT NOT NULL,
          query_plan_fingerprint TEXT NOT NULL,
          upstream_fingerprint TEXT NOT NULL,
          snapshot_fingerprint TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(tenant_id,pipeline_id,station_idx)
        );
        CREATE INDEX IF NOT EXISTS idx_content_pipeline_private_web_snapshot_station
          ON content_production_pipeline_private_web_snapshots(
            tenant_id,pipeline_id,station_idx,station_attempt
          );
        CREATE TABLE IF NOT EXISTS content_production_pipeline_private_output_snapshots (
          tenant_id INTEGER NOT NULL,
          pipeline_id INTEGER NOT NULL,
          station_idx INTEGER NOT NULL CHECK(station_idx BETWEEN 3 AND 9),
          station_attempt INTEGER NOT NULL CHECK(station_attempt > 0),
          snapshot_fingerprint TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(tenant_id,pipeline_id,station_idx,station_attempt)
        );
      `);
      migrateLifecycleStatusChecks();
      if (knowledgeSinkTablesAvailable()) {
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_content_pipeline_final_asset_source
            ON biz_assets(tenant_id,source_type,source_id)
            WHERE source_type='content_pipeline';
          CREATE UNIQUE INDEX IF NOT EXISTS idx_content_pipeline_knowledge_source
            ON kb_docs(tenant_id,source_type,source_id)
            WHERE source_type='content_pipeline';
        `);
      }
      return backfillMissingArtifacts();
    },

    createJob(input) {
      const createdAt = timestamp();
      const idempotency = normalizePipelineIdempotency(input.idempotency);
      return transaction(() => {
        if (idempotency) {
          const existing = db
            .prepare(
              `SELECT pipeline_id FROM content_production_pipeline_idempotency
              WHERE tenant_id=? AND namespace=? AND idempotency_key=?`,
            )
            .get(input.tenantId, idempotency.namespace, idempotency.key);
          if (existing?.pipeline_id) return Number(existing.pipeline_id);
        }
        const info = db
          .prepare(
            `INSERT INTO content_production_pipeline_jobs(
          tenant_id,created_by,title,status,current_station,task_json,persona_json,
          settings_json,workflow_json,created_at,updated_at
        ) VALUES(?,?,?,'running',0,?,?,?,?,?,?)`,
          )
          .run(
            input.tenantId,
            input.createdBy,
            input.title,
            json(input.task),
            json(input.persona || {}),
            json(input.settings || {}),
            json(input.workflow || {}),
            createdAt,
            createdAt,
          );
        const pipelineId = Number(info.lastInsertRowid);
        const insert =
          db.prepare(`INSERT INTO content_production_pipeline_stations(
          pipeline_id,tenant_id,station_idx,employee_key,handler_id,status,updated_at
        ) VALUES(?,?,?,?,?,'pending',?)`);
        for (const descriptor of CONTENT_HANDLER_ADAPTER_CATALOG) {
          insert.run(
            pipelineId,
            input.tenantId,
            descriptor.employeeIdx,
            descriptor.employeeKey,
            descriptor.handlerId,
            createdAt,
          );
        }
        if (idempotency) {
          db.prepare(
            `INSERT INTO content_production_pipeline_idempotency(
              tenant_id,namespace,idempotency_key,pipeline_id,created_at
            ) VALUES(?,?,?,?,?)`,
          ).run(
            input.tenantId,
            idempotency.namespace,
            idempotency.key,
            pipelineId,
            createdAt,
          );
        }
        return pipelineId;
      });
    },

    findByIdempotency(tenantId, value) {
      const normalized = normalizePipelineIdempotency(value);
      if (!normalized) return null;
      const row = db
        .prepare(
          `SELECT pipeline_id FROM content_production_pipeline_idempotency
          WHERE tenant_id=? AND namespace=? AND idempotency_key=?`,
        )
        .get(
          positiveInteger(tenantId, "tenantId"),
          normalized.namespace,
          normalized.key,
        );
      return row?.pipeline_id
        ? getJob(tenantId, Number(row.pipeline_id))
        : null;
    },

    getJob,
    getStation,

    getKnowledgeSink(tenantId, pipelineId) {
      return knowledgeSinkPublicState(
        positiveInteger(tenantId, "tenantId"),
        positiveInteger(pipelineId, "pipelineId"),
      );
    },

    finalizeKnowledgeSink(tenantId, pipelineId) {
      const safeTenantId = positiveInteger(tenantId, "tenantId");
      const safePipelineId = positiveInteger(pipelineId, "pipelineId");
      if (!knowledgeSinkTablesAvailable()) {
        return knowledgeSinkPublicState(safeTenantId, safePipelineId);
      }
      return transaction(() => {
        const existing = getKnowledgeSinkRows(safeTenantId, safePipelineId);
        if (existing.asset && existing.kbDoc) {
          return knowledgeSinkPublicState(safeTenantId, safePipelineId);
        }
        const readiness = knowledgeSinkReadiness(safeTenantId, safePipelineId);
        if (!readiness.ready) {
          return knowledgeSinkPublicState(
            safeTenantId,
            safePipelineId,
            readiness,
          );
        }
        const completedAt = timestamp();
        const initialNote = safeValue({
          schemaVersion: CONTENT_PRODUCTION_KNOWLEDGE_SINK_SCHEMA,
          status: "completed",
          sourceType: "content_pipeline",
          sourceId: safePipelineId,
          finalArtifactFingerprint: readiness.finalArtifactFingerprint,
          stationSummaryFingerprint: readiness.stationSummaryFingerprint,
          station9OutputFingerprint: readiness.station9OutputFingerprint,
          publicationMetricsFingerprint:
            readiness.publicationMetricsFingerprint,
          finalArtifacts: readiness.finalArtifacts,
          completedAt,
        });
        db.prepare(
          `INSERT INTO biz_assets(
          tenant_id,name,category,value,status,use_count,owner,source_type,source_id,
          creator_id,url,note,created_at,updated_at
        ) SELECT ?,?,'内容资产',0,'使用中',0,'内容团队','content_pipeline',?,?,?,?,?,?
          WHERE NOT EXISTS (
            SELECT 1 FROM biz_assets
            WHERE tenant_id=? AND source_type='content_pipeline' AND source_id=?
          )`,
        ).run(
          safeTenantId,
          `《${readiness.job.title}》内容团队最终交付`,
          safePipelineId,
          readiness.job.createdBy,
          `/content?pipelineId=${safePipelineId}`,
          json(initialNote),
          completedAt,
          completedAt,
          safeTenantId,
          safePipelineId,
        );
        db.prepare(
          `INSERT INTO kb_docs(
          tenant_id,category,title,body,source_type,source_id,enabled,ref_count,
          version,updated_at
        ) SELECT ?,'员工产出',?,?, 'content_pipeline',?,1,0,1,?
          WHERE NOT EXISTS (
            SELECT 1 FROM kb_docs
            WHERE tenant_id=? AND source_type='content_pipeline' AND source_id=?
          )`,
        ).run(
          safeTenantId,
          `《${readiness.job.title}》交付复盘`,
          knowledgeDocumentBody(readiness),
          safePipelineId,
          completedAt,
          safeTenantId,
          safePipelineId,
        );
        const inserted = getKnowledgeSinkRows(safeTenantId, safePipelineId);
        if (!inserted.asset || !inserted.kbDoc) {
          fail(
            "最终资产与知识必须在同一本地事务中完整沉淀",
            "CONTENT_PIPELINE_KNOWLEDGE_SINK_INCOMPLETE",
            500,
          );
        }
        const finalNote = {
          ...initialNote,
          assetId: Number(inserted.asset.id),
          kbDocId: Number(inserted.kbDoc.id),
        };
        db.prepare(
          `UPDATE biz_assets SET note=?,updated_at=?
          WHERE tenant_id=? AND id=? AND source_type='content_pipeline' AND source_id=?`,
        ).run(
          json(finalNote),
          completedAt,
          safeTenantId,
          Number(inserted.asset.id),
          safePipelineId,
        );
        return knowledgeSinkPublicState(safeTenantId, safePipelineId);
      });
    },

    getPrivateWebSnapshot(tenantId, pipelineId, stationIdx) {
      const row = db
        .prepare(
          `SELECT snapshot_json
        FROM content_production_pipeline_private_web_snapshots
        WHERE tenant_id=? AND pipeline_id=? AND station_idx=?`,
        )
        .get(tenantId, pipelineId, stationIdx);
      return validateContentProductionPrivateWebSnapshot(
        parseJson(row?.snapshot_json, null),
        { tenantId, pipelineId, stationIdx },
      );
    },

    listJobs(tenantId, { createdBy = null, limit = 20 } = {}) {
      const safeTenantId = positiveInteger(tenantId, "tenantId");
      const safeLimit = Number(limit);
      if (!Number.isInteger(safeLimit) || safeLimit < 1 || safeLimit > 100) {
        fail("limit必须是1..100之间的整数", undefined, 400);
      }
      if (createdBy !== null && createdBy !== undefined) {
        const safeCreatedBy = positiveInteger(createdBy, "createdBy");
        return db
          .prepare(
            `SELECT * FROM content_production_pipeline_jobs
          WHERE tenant_id=? AND created_by=? ORDER BY updated_at DESC,id DESC LIMIT ?`,
          )
          .all(safeTenantId, safeCreatedBy, safeLimit)
          .map(normalizeJobRow);
      }
      return db
        .prepare(
          `SELECT * FROM content_production_pipeline_jobs
        WHERE tenant_id=? ORDER BY updated_at DESC,id DESC LIMIT ?`,
        )
        .all(safeTenantId, safeLimit)
        .map(normalizeJobRow);
    },

    listLifecycleCandidates(tenantId, { limit = 50 } = {}) {
      const safeTenantId = positiveInteger(tenantId, "tenantId");
      const safeLimit = Number(limit);
      if (!Number.isInteger(safeLimit) || safeLimit < 1 || safeLimit > 200) {
        fail("limit必须是1..200之间的整数", undefined, 400);
      }
      const staleBefore = new Date(
        Date.parse(timestamp()) - interruptedStaleMs,
      ).toISOString();
      return db
        .prepare(
          `SELECT j.*,s.status station_status,s.attempt station_attempt,
          s.output_json station_output_json,s.billing_evidence_json station_billing_json,
          s.started_at station_started_at,s.updated_at station_updated_at
        FROM content_production_pipeline_jobs j
        JOIN content_production_pipeline_stations s
          ON s.tenant_id=j.tenant_id AND s.pipeline_id=j.id
          AND s.station_idx=j.current_station
        WHERE j.tenant_id=? AND j.status='running'
          AND (
            (s.status='pending' AND datetime(j.updated_at)<=datetime(?))
            OR (s.status='running' AND s.output_json IS NULL
              AND datetime(COALESCE(s.started_at,s.updated_at))<=datetime(?))
          )
        ORDER BY j.updated_at,j.id LIMIT ?`,
        )
        .all(safeTenantId, staleBefore, staleBefore, safeLimit)
        .map((row) => ({
          job: normalizeJobRow(row),
          station: {
            stationIdx: Number(row.current_station),
            status: row.station_status,
            attempt: Number(row.station_attempt || 0),
            output: parseJson(row.station_output_json, null),
            billingEvidence: parseJson(row.station_billing_json, null),
            startedAt: row.station_started_at,
            updatedAt: row.station_updated_at,
          },
        }));
    },

    listStations(tenantId, pipelineId) {
      return db
        .prepare(
          `SELECT * FROM content_production_pipeline_stations
        WHERE tenant_id=? AND pipeline_id=? ORDER BY station_idx`,
        )
        .all(tenantId, pipelineId)
        .map(normalizeStationRow);
    },

    listPhaseEvents(tenantId, pipelineId, stationIdx = null) {
      const safeTenantId = positiveInteger(tenantId, "tenantId");
      const safePipelineId = positiveInteger(pipelineId, "pipelineId");
      const params = [safeTenantId, safePipelineId];
      let stationClause = "";
      if (stationIdx !== null && stationIdx !== undefined) {
        const normalizedStationIdx = Number(stationIdx);
        if (
          !Number.isInteger(normalizedStationIdx) ||
          normalizedStationIdx < 0 ||
          normalizedStationIdx > 9
        ) {
          fail("stationIdx必须是0..9", undefined, 400);
        }
        stationClause = " AND station_idx=?";
        params.push(normalizedStationIdx);
      }
      return db
        .prepare(
          `SELECT * FROM content_production_pipeline_phase_events
        WHERE tenant_id=? AND pipeline_id=?${stationClause}
        ORDER BY id`,
        )
        .all(...params)
        .map(normalizePhaseEventRow);
    },

    recordPhaseEvent(input) {
      return transaction(() => insertPhaseEvent(input));
    },

    listArtifacts(tenantId, pipelineId, stationIdx = null) {
      const params = [tenantId, pipelineId];
      const stationClause =
        stationIdx === null || stationIdx === undefined
          ? ""
          : " AND a.station_idx=?";
      if (stationClause) params.push(stationIdx);
      return db
        .prepare(
          `SELECT a.*
        FROM content_production_pipeline_artifacts a
        JOIN content_production_pipeline_stations s
          ON s.tenant_id=a.tenant_id
          AND s.pipeline_id=a.pipeline_id
          AND s.station_idx=a.station_idx
          AND s.attempt=a.station_attempt
        WHERE a.tenant_id=? AND a.pipeline_id=?${stationClause}
        ORDER BY a.station_idx,a.artifact_index,a.id`,
        )
        .all(...params)
        .map((row) => normalizeArtifactRow(row));
    },

    listArtifactBackfills(tenantId, pipelineId) {
      return db
        .prepare(
          `SELECT b.*
        FROM content_production_pipeline_artifact_backfills b
        JOIN content_production_pipeline_stations s
          ON s.tenant_id=b.tenant_id AND s.pipeline_id=b.pipeline_id
          AND s.station_idx=b.station_idx AND s.attempt=b.station_attempt
        WHERE b.tenant_id=? AND b.pipeline_id=? ORDER BY b.station_idx`,
        )
        .all(tenantId, pipelineId)
        .map(normalizeArtifactBackfillRow);
    },

    getArtifact(tenantId, pipelineId, stationIdx, artifactId) {
      const row = db
        .prepare(
          `SELECT a.*
        FROM content_production_pipeline_artifacts a
        JOIN content_production_pipeline_stations s
          ON s.tenant_id=a.tenant_id
          AND s.pipeline_id=a.pipeline_id
          AND s.station_idx=a.station_idx
          AND s.attempt=a.station_attempt
        WHERE a.tenant_id=? AND a.pipeline_id=? AND a.station_idx=? AND a.id=?`,
        )
        .get(tenantId, pipelineId, stationIdx, artifactId);
      return normalizeArtifactRow(row, { includeContent: true });
    },

    readCompletedOutputsBefore(tenantId, pipelineId, stationIdx) {
      return db
        .prepare(
          `SELECT station_idx,status,output_json
        FROM content_production_pipeline_stations
        WHERE tenant_id=? AND pipeline_id=? AND station_idx<? ORDER BY station_idx`,
        )
        .all(tenantId, pipelineId, stationIdx)
        .map((row) => ({
          stationIdx: Number(row.station_idx),
          status: row.status,
          output: parseJson(row.output_json, null),
        }));
    },

    claimStation(tenantId, pipelineId, stationIdx) {
      return transaction(() => {
        const job = getJob(tenantId, pipelineId);
        if (
          !job ||
          job.status !== "running" ||
          job.currentStation !== stationIdx
        )
          return null;
        const startedAt = timestamp();
        const info = db
          .prepare(
            `UPDATE content_production_pipeline_stations
          SET status='running',attempt=attempt+1,started_at=?,completed_at=NULL,
              failure_json=NULL,updated_at=?
          WHERE tenant_id=? AND pipeline_id=? AND station_idx=? AND status='pending'`,
          )
          .run(startedAt, startedAt, tenantId, pipelineId, stationIdx);
        if (Number(info.changes) !== 1) return null;
        const station = getStation(tenantId, pipelineId, stationIdx);
        insertPhaseEvent(
          {
            tenantId,
            pipelineId,
            stationIdx,
            stationAttempt: station.attempt,
            phase: "claim",
            state: "completed",
            detail: { source: "sqlite_atomic_claim" },
          },
          startedAt,
        );
        return station;
      });
    },

    recordGenerated({
      tenantId,
      pipelineId,
      stationIdx,
      expectedAttempt,
      output,
      handlerEvidence,
      contextSnapshot,
      approvalBoundary,
      approvalAudit = null,
      artifacts,
      awaitingApproval,
      privateWebSnapshot = null,
      privateOutputSnapshot = null,
    }) {
      return transaction(() => {
        const station = getStation(tenantId, pipelineId, stationIdx);
        if (
          !station ||
          station.status !== "running" ||
          station.attempt !== Number(expectedAttempt)
        ) {
          fail(
            "工位不在可提交的running状态",
            "CONTENT_PIPELINE_STATION_NOT_RUNNING",
          );
        }
        const normalizedArtifacts = normalizeStationArtifacts(
          artifacts,
          stationIdx,
        );
        let validatedOutputSnapshot = null;
        if (privateOutputSnapshot || handlerEvidence?.providerDelivery?.validationSnapshotFingerprint) {
          validatedOutputSnapshot = validatePrivateOutputSnapshot(privateOutputSnapshot, {
            tenantId, pipelineId, stationIdx, stationAttempt: expectedAttempt,
            handlerId: station.handlerId, providerDelivery: handlerEvidence?.providerDelivery,
            outputFingerprint: fingerprint(generationOwnedOutput(stationIdx, output)),
            task: getJob(tenantId, pipelineId)?.task,
          });
          if (!validatedOutputSnapshot) fail('私有事实快照与当前工位交付不一致，未提交产物',
            'CONTENT_PIPELINE_PRIVATE_OUTPUT_SNAPSHOT_INVALID', 422);
        }
        const completedAt = timestamp();
        const nextStation = stationIdx + 1;
        const stationStatus = awaitingApproval
          ? "awaiting_approval"
          : "completed";
        const jobStatus = awaitingApproval
          ? "awaiting_approval"
          : nextStation >= CONTENT_PRODUCTION_PIPELINE_STATION_COUNT
            ? "completed"
            : "running";
        const audit = approvalAudit ? [safeValue(approvalAudit)] : [];
        const stationUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_stations
          SET status=?,output_json=?,handler_evidence_json=?,context_snapshot_json=?,
              approval_boundary_json=?,approval_audit_json=?,failure_json=NULL,
              completed_at=?,updated_at=?
          WHERE tenant_id=? AND pipeline_id=? AND station_idx=?
            AND status='running' AND attempt=?`,
          )
          .run(
            stationStatus,
            json(output),
            json(handlerEvidence),
            json(contextSnapshot),
            json(approvalBoundary),
            json(audit),
            completedAt,
            completedAt,
            tenantId,
            pipelineId,
            stationIdx,
            expectedAttempt,
          );
        if (Number(stationUpdate.changes) !== 1) {
          fail(
            "工位执行代次已变化，旧worker不得提交产物",
            "CONTENT_PIPELINE_STALE_ATTEMPT",
          );
        }
        persistPrivateWebSnapshot({
          tenantId,
          pipelineId,
          stationIdx,
          stationAttempt: expectedAttempt,
          privateWebSnapshot,
          persistedAt: completedAt,
        });
        if (validatedOutputSnapshot) db.prepare(`INSERT INTO content_production_pipeline_private_output_snapshots(
          tenant_id,pipeline_id,station_idx,station_attempt,snapshot_fingerprint,snapshot_json,created_at
        ) VALUES(?,?,?,?,?,?,?)`).run(tenantId, pipelineId, stationIdx, expectedAttempt,
          validatedOutputSnapshot.snapshotFingerprint, JSON.stringify(validatedOutputSnapshot), completedAt);
        insertArtifacts({
          tenantId,
          pipelineId,
          stationIdx,
          stationAttempt: expectedAttempt,
          artifacts: normalizedArtifacts,
          createdAt: completedAt,
        });
        insertPhaseEvent(
          {
            tenantId,
            pipelineId,
            stationIdx,
            stationAttempt: expectedAttempt,
            phase: "persist",
            state: "completed",
            detail: {
              artifactCount: normalizedArtifacts.length,
              outputFingerprint: fingerprint(output),
              source: "station_transaction",
            },
            usageRef: {
              source: "handler_evidence",
              model:
                handlerEvidence?.providerDelivery?.model ||
                handlerEvidence?.productionRuntime?.providerDelivery?.model,
              ...(handlerEvidence?.providerDelivery?.usage ||
                handlerEvidence?.productionRuntime?.providerDelivery?.usage ||
                {}),
              evidenceFingerprint: fingerprint(handlerEvidence || {}),
            },
          },
          completedAt,
        );
        const jobUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_jobs
          SET status=?,current_station=?,pending_station=?,failure_json=NULL,
              version=version+1,updated_at=?
          WHERE tenant_id=? AND id=? AND status='running' AND current_station=?`,
          )
          .run(
            jobStatus,
            awaitingApproval ? stationIdx : nextStation,
            awaitingApproval ? stationIdx : null,
            completedAt,
            tenantId,
            pipelineId,
            stationIdx,
          );
        if (Number(jobUpdate.changes) !== 1) {
          fail(
            "流水线状态已变化，旧worker不得推进工位",
            "CONTENT_PIPELINE_STALE_ATTEMPT",
          );
        }
        return getJob(tenantId, pipelineId);
      });
    },

    recordSkipped({
      tenantId,
      pipelineId,
      stationIdx,
      expectedAttempt,
      skipEvidence,
      contextSnapshot,
      approvalAudit,
    }) {
      return transaction(() => {
        const station = getStation(tenantId, pipelineId, stationIdx);
        if (
          !station ||
          station.status !== "running" ||
          station.attempt !== Number(expectedAttempt)
        ) {
          fail(
            "工位不在可跳过的running状态",
            "CONTENT_PIPELINE_STATION_NOT_RUNNING",
          );
        }
        if (stationIdx !== 7) {
          fail(
            "只有可选演绎师工位7可持久化为skipped",
            "CONTENT_PIPELINE_SKIP_FORBIDDEN",
          );
        }
        const skippedAt = timestamp();
        const stationUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_stations
          SET status='skipped',output_json=NULL,handler_evidence_json=?,
              context_snapshot_json=?,approval_boundary_json=NULL,approval_audit_json=?,
              failure_json=NULL,completed_at=?,updated_at=?
          WHERE tenant_id=? AND pipeline_id=? AND station_idx=?
            AND status='running' AND attempt=?`,
          )
          .run(
            json(skipEvidence),
            json(contextSnapshot),
            json([approvalAudit]),
            skippedAt,
            skippedAt,
            tenantId,
            pipelineId,
            stationIdx,
            expectedAttempt,
          );
        if (Number(stationUpdate.changes) !== 1) {
          fail(
            "工位执行代次已变化，旧worker不得提交跳过状态",
            "CONTENT_PIPELINE_STALE_ATTEMPT",
          );
        }
        for (const phase of [
          "agentic_search",
          "controlled_fetch",
          "provider",
          "validate",
          "settle",
        ]) {
          insertPhaseEvent(
            {
              tenantId,
              pipelineId,
              stationIdx,
              stationAttempt: expectedAttempt,
              phase,
              state: "skipped",
              detail: {
                code: "CONTENT_PIPELINE_OPTIONAL_STATION_SKIPPED",
                providerCalled: false,
              },
            },
            skippedAt,
          );
        }
        insertPhaseEvent(
          {
            tenantId,
            pipelineId,
            stationIdx,
            stationAttempt: expectedAttempt,
            phase: "persist",
            state: "completed",
            detail: {
              artifactCount: 0,
              code: "CONTENT_PIPELINE_OPTIONAL_STATION_SKIPPED",
              providerCalled: false,
            },
          },
          skippedAt,
        );
        const jobUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_jobs
          SET status='running',current_station=8,pending_station=NULL,failure_json=NULL,
              version=version+1,updated_at=?
          WHERE tenant_id=? AND id=? AND status='running' AND current_station=7`,
          )
          .run(skippedAt, tenantId, pipelineId);
        if (Number(jobUpdate.changes) !== 1) {
          fail(
            "流水线状态已变化，旧worker不得跳过工位",
            "CONTENT_PIPELINE_STALE_ATTEMPT",
          );
        }
        return getJob(tenantId, pipelineId);
      });
    },

    recordFailure({
      tenantId,
      pipelineId,
      stationIdx,
      expectedAttempt,
      failure,
      handlerEvidence,
      contextSnapshot,
      billingEvidence = null,
      privateWebSnapshot = null,
    }) {
      return transaction(() => {
        const failedAt = timestamp();
        const station = getStation(tenantId, pipelineId, stationIdx);
        if (
          !station ||
          station.attempt !== Number(expectedAttempt) ||
          !["running", "awaiting_approval", "completed"].includes(
            station.status,
          )
        ) {
          return null;
        }
        const persistedContextSnapshot = billingEvidence
          ? {
              ...(contextSnapshot || station?.contextSnapshot || {}),
              billingEvidence: safeValue(billingEvidence),
            }
          : contextSnapshot;
        const stationUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_stations
          SET status='failed',handler_evidence_json=COALESCE(?,handler_evidence_json),
              billing_evidence_json=COALESCE(?,billing_evidence_json),
              context_snapshot_json=COALESCE(?,context_snapshot_json),failure_json=?,
              completed_at=?,updated_at=?
          WHERE tenant_id=? AND pipeline_id=? AND station_idx=?
            AND status IN ('running','awaiting_approval','completed') AND attempt=?`,
          )
          .run(
            handlerEvidence ? json(handlerEvidence) : null,
            billingEvidence ? json(billingEvidence) : null,
            persistedContextSnapshot ? json(persistedContextSnapshot) : null,
            json(failure),
            failedAt,
            failedAt,
            tenantId,
            pipelineId,
            stationIdx,
            expectedAttempt,
          );
        if (Number(stationUpdate.changes) !== 1) return null;
        insertPhaseEvent(
          {
            tenantId,
            pipelineId,
            stationIdx,
            stationAttempt: expectedAttempt,
            phase: "failure",
            state: "failed",
            detail: {
              code: failure?.code || "CONTENT_PIPELINE_STATION_FAILED",
              source: "station_terminal_state",
              evidenceFingerprint: fingerprint({
                failure: failure || null,
                handlerEvidence: handlerEvidence || null,
              }),
            },
            usageRef: billingEvidence
              ? {
                  source: "billing_evidence",
                  ...billingEvidence,
                  evidenceFingerprint: fingerprint(billingEvidence),
                }
              : null,
          },
          failedAt,
        );
        persistPrivateWebSnapshot({
          tenantId,
          pipelineId,
          stationIdx,
          stationAttempt: expectedAttempt,
          privateWebSnapshot,
          persistedAt: failedAt,
        });
        const jobUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_jobs
          SET status='failed',current_station=?,pending_station=NULL,failure_json=?,
              version=version+1,updated_at=?
          WHERE tenant_id=? AND id=? AND status IN ('running','awaiting_approval','completed')
            AND current_station=?`,
          )
          .run(
            stationIdx,
            json(failure),
            failedAt,
            tenantId,
            pipelineId,
            stationIdx,
          );
        if (Number(jobUpdate.changes) !== 1) {
          fail(
            "流水线状态已变化，旧worker不得写入失败终态",
            "CONTENT_PIPELINE_STALE_ATTEMPT",
          );
        }
        return getJob(tenantId, pipelineId);
      });
    },

    attachBillingEvidence({
      tenantId,
      pipelineId,
      stationIdx,
      billingEvidence,
    }) {
      return transaction(() => {
        const station = getStation(tenantId, pipelineId, stationIdx);
        if (
          !station ||
          !["awaiting_approval", "completed"].includes(station.status)
        ) {
          fail(
            "只能在工位产物已持久化后附加账务证据",
            "CONTENT_PIPELINE_BILLING_EVIDENCE_TOO_EARLY",
          );
        }
        const attachedAt = timestamp();
        const contextSnapshot = {
          ...(station.contextSnapshot || {}),
          billingEvidence: safeValue(billingEvidence),
        };
        db.prepare(
          `UPDATE content_production_pipeline_stations
          SET billing_evidence_json=?,context_snapshot_json=?,updated_at=?
          WHERE tenant_id=? AND pipeline_id=? AND station_idx=?`,
        ).run(
          json(billingEvidence),
          json(contextSnapshot),
          attachedAt,
          tenantId,
          pipelineId,
          stationIdx,
        );
        insertPhaseEvent(
          {
            tenantId,
            pipelineId,
            stationIdx,
            stationAttempt: station.attempt,
            phase: "settle",
            state:
              billingEvidence?.pendingReconciliation === true ||
              billingEvidence?.state === "pending_reconciliation"
                ? "waiting"
                : "completed",
            detail: {
              billingPending:
                billingEvidence?.pendingReconciliation === true ||
                billingEvidence?.state === "pending_reconciliation",
              source: "billing_evidence",
              evidenceFingerprint: fingerprint(billingEvidence || {}),
            },
            usageRef: {
              source: "billing_evidence",
              ...(billingEvidence || {}),
              evidenceFingerprint: fingerprint(billingEvidence || {}),
            },
          },
          attachedAt,
        );
        return getStation(tenantId, pipelineId, stationIdx);
      });
    },

    markBillingPending({
      tenantId,
      pipelineId,
      stationIdx,
      billingEvidence,
      failure,
    }) {
      return transaction(() => {
        const station = getStation(tenantId, pipelineId, stationIdx);
        if (
          !station ||
          !["awaiting_approval", "completed"].includes(station.status) ||
          !station.output
        ) {
          fail(
            "只能将已持久化产物标记为billing_pending",
            "CONTENT_PIPELINE_BILLING_PENDING_WITHOUT_OUTPUT",
          );
        }
        const pendingAt = timestamp();
        const evidence = safeValue({
          ...(billingEvidence || {}),
          status: billingEvidence?.status || "pending_reconciliation",
          resumeStationStatus: station.status,
          pendingAt,
        });
        const contextSnapshot = {
          ...(station.contextSnapshot || {}),
          billingEvidence: evidence,
        };
        db.prepare(
          `UPDATE content_production_pipeline_stations
          SET status='billing_pending',billing_evidence_json=?,context_snapshot_json=?,
              failure_json=?,updated_at=?
          WHERE tenant_id=? AND pipeline_id=? AND station_idx=?`,
        ).run(
          json(evidence),
          json(contextSnapshot),
          json(failure),
          pendingAt,
          tenantId,
          pipelineId,
          stationIdx,
        );
        db.prepare(
          `UPDATE content_production_pipeline_jobs
          SET status='billing_pending',current_station=?,pending_station=NULL,
              failure_json=?,version=version+1,updated_at=?
          WHERE tenant_id=? AND id=?`,
        ).run(stationIdx, json(failure), pendingAt, tenantId, pipelineId);
        insertPhaseEvent(
          {
            tenantId,
            pipelineId,
            stationIdx,
            stationAttempt: station.attempt,
            phase: "failure",
            state: "waiting",
            detail: {
              code:
                failure?.code ||
                "CONTENT_PIPELINE_BILLING_PENDING_RECONCILIATION",
              billingPending: true,
              source: "post_persist_settlement",
            },
            usageRef: {
              source: "billing_evidence",
              ...(billingEvidence || {}),
              evidenceFingerprint: fingerprint(billingEvidence || {}),
            },
          },
          pendingAt,
        );
        return getJob(tenantId, pipelineId);
      });
    },

    recoverSettledBillingPending({ tenantId, pipelineId }) {
      return transaction(() => {
        const job = getJob(tenantId, pipelineId);
        if (!job || job.status !== "billing_pending") {
          fail(
            "只能恢复已交付且账务已结清的billing_pending流水线",
            "CONTENT_PIPELINE_BILLING_PENDING_NOT_RECOVERABLE",
          );
        }
        const stationIdx = Number(job.currentStation);
        const station = getStation(tenantId, pipelineId, stationIdx);
        if (
          !station ||
          station.status !== "billing_pending" ||
          !station.output
        ) {
          fail(
            "当前工位没有可恢复的已交付产物",
            "CONTENT_PIPELINE_BILLING_PENDING_WITHOUT_OUTPUT",
          );
        }
        const resumeStatus = ["completed", "awaiting_approval"].includes(
          String(station.billingEvidence?.resumeStationStatus || ""),
        )
          ? station.billingEvidence.resumeStationStatus
          : "completed";
        const recoveredAt = timestamp();
        const evidence = safeValue({
          ...(station.billingEvidence || {}),
          state: "settled",
          status: "settled",
          pendingReconciliation: false,
          note: "预授权已全部结清或释放，流水线从账务停站恢复。",
        });
        db.prepare(
          `UPDATE content_production_pipeline_stations
          SET status=?,billing_evidence_json=?,failure_json=NULL,updated_at=?
          WHERE tenant_id=? AND pipeline_id=? AND station_idx=? AND status='billing_pending'`,
        ).run(
          resumeStatus,
          json(evidence),
          recoveredAt,
          tenantId,
          pipelineId,
          stationIdx,
        );
        const nextStation = stationIdx + 1;
        const jobStatus =
          resumeStatus === "awaiting_approval"
            ? "awaiting_approval"
            : nextStation >= 10
              ? "completed"
              : "running";
        const currentStation =
          resumeStatus === "awaiting_approval" ? stationIdx : nextStation;
        db.prepare(
          `UPDATE content_production_pipeline_jobs
          SET status=?,current_station=?,pending_station=?,failure_json=NULL,
              version=version+1,updated_at=?
          WHERE tenant_id=? AND id=? AND status='billing_pending' AND current_station=?`,
        ).run(
          jobStatus,
          currentStation,
          resumeStatus === "awaiting_approval" ? stationIdx : null,
          recoveredAt,
          tenantId,
          pipelineId,
          stationIdx,
        );
        return getJob(tenantId, pipelineId);
      });
    },

    markPreDeliveryBillingPending({
      tenantId,
      pipelineId,
      stationIdx,
      expectedAttempt = null,
      billingEvidence,
      failure,
      handlerEvidence = null,
      contextSnapshot = null,
      privateWebSnapshot = null,
    }) {
      return transaction(() => {
        const station = getStation(tenantId, pipelineId, stationIdx);
        if (
          !station ||
          !["running", "failed", "pending"].includes(station.status) ||
          station.output !== null ||
          (expectedAttempt !== null &&
            Number(station.attempt) !== Number(expectedAttempt))
        ) {
          fail(
            "只能将无产物且存在未释放占扣的工位标记为billing_pending",
            "CONTENT_PIPELINE_PRE_DELIVERY_BILLING_PENDING_INVALID",
          );
        }
        const pendingAt = timestamp();
        const evidence = safeValue({
          ...(billingEvidence || {}),
          state: "pending_reconciliation",
          status: "pending_reconciliation",
          pendingReconciliation: true,
          preDelivery: true,
          resumeStationStatus: station.status,
          pendingAt,
        });
        const persistedContextSnapshot = {
          ...(contextSnapshot || station.contextSnapshot || {}),
          billingEvidence: evidence,
        };
        const stationUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_stations
          SET status='billing_pending',handler_evidence_json=COALESCE(?,handler_evidence_json),
              billing_evidence_json=?,context_snapshot_json=?,failure_json=?,updated_at=?
          WHERE tenant_id=? AND pipeline_id=? AND station_idx=?
            AND status IN ('running','failed','pending') AND output_json IS NULL
            ${expectedAttempt === null ? "" : "AND attempt=?"}`,
          )
          .run(
            handlerEvidence ? json(handlerEvidence) : null,
            json(evidence),
            json(persistedContextSnapshot),
            json(failure),
            pendingAt,
            tenantId,
            pipelineId,
            stationIdx,
            ...(expectedAttempt === null ? [] : [Number(expectedAttempt)]),
          );
        if (Number(stationUpdate.changes) !== 1) {
          fail(
            "工位状态已变化，不能写入待对账终态",
            "CONTENT_PIPELINE_STALE_ATTEMPT",
          );
        }
        persistPrivateWebSnapshot({
          tenantId,
          pipelineId,
          stationIdx,
          stationAttempt: station.attempt,
          privateWebSnapshot,
          persistedAt: pendingAt,
        });
        const jobUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_jobs
          SET status='billing_pending',current_station=?,pending_station=NULL,
              failure_json=?,version=version+1,updated_at=?
          WHERE tenant_id=? AND id=? AND current_station=?
            AND status IN ('running','failed')`,
          )
          .run(
            stationIdx,
            json(failure),
            pendingAt,
            tenantId,
            pipelineId,
            stationIdx,
          );
        if (Number(jobUpdate.changes) !== 1) {
          fail(
            "流水线状态已变化，不能写入待对账终态",
            "CONTENT_PIPELINE_STALE_ATTEMPT",
          );
        }
        insertPhaseEvent(
          {
            tenantId,
            pipelineId,
            stationIdx,
            stationAttempt: station.attempt,
            phase: "settle",
            state: "waiting",
            detail: {
              code:
                failure?.code ||
                "CONTENT_PIPELINE_PRE_DELIVERY_BILLING_PENDING",
              billingPending: true,
              source: "pre_delivery_settlement",
            },
            usageRef: {
              source: "billing_evidence",
              ...(billingEvidence || {}),
              evidenceFingerprint: fingerprint(billingEvidence || {}),
            },
          },
          pendingAt,
        );
        insertPhaseEvent(
          {
            tenantId,
            pipelineId,
            stationIdx,
            stationAttempt: station.attempt,
            phase: "failure",
            state: "waiting",
            detail: {
              code:
                failure?.code ||
                "CONTENT_PIPELINE_PRE_DELIVERY_BILLING_PENDING",
              billingPending: true,
              source: "pre_delivery_settlement",
            },
          },
          pendingAt,
        );
        return getJob(tenantId, pipelineId);
      });
    },

    recordReview({ tenantId, pipelineId, stationIdx, decision, output }) {
      return transaction(() => {
        const station = getStation(tenantId, pipelineId, stationIdx);
        if (!station || station.status !== "awaiting_approval") {
          fail(
            "该工位不在待审阅状态",
            "CONTENT_PIPELINE_NOT_AWAITING_APPROVAL",
          );
        }
        const decidedAt = timestamp();
        const audits = [
          ...(station.approvalAudit || []),
          safeValue(decision.auditRecord),
        ];
        const rejected = decision.auditRecord.action === "reject";
        const nextStation = stationIdx + 1;
        const jobStatus = rejected
          ? "rejected"
          : nextStation >= CONTENT_PRODUCTION_PIPELINE_STATION_COUNT
            ? "completed"
            : "running";
        db.prepare(
          `UPDATE content_production_pipeline_stations
          SET status=?,output_json=?,approval_audit_json=?,selection_json=?,
              completed_at=?,updated_at=?
          WHERE tenant_id=? AND pipeline_id=? AND station_idx=?`,
        ).run(
          rejected ? "rejected" : "completed",
          json(output),
          json(audits),
          decision.selection ? json(decision.selection) : null,
          decidedAt,
          decidedAt,
          tenantId,
          pipelineId,
          stationIdx,
        );
        db.prepare(
          `UPDATE content_production_pipeline_jobs
          SET status=?,current_station=?,pending_station=NULL,failure_json=NULL,
              version=version+1,updated_at=? WHERE tenant_id=? AND id=?`,
        ).run(
          jobStatus,
          rejected ? stationIdx : nextStation,
          decidedAt,
          tenantId,
          pipelineId,
        );
        return getJob(tenantId, pipelineId);
      });
    },

    pausePipeline({ tenantId, pipelineId, reason = "user_requested" }) {
      return transaction(() => {
        const job = getJob(tenantId, pipelineId);
        if (!job) {
          fail("内容生产流水线不存在", "CONTENT_PIPELINE_NOT_FOUND", 404);
        }
        if (job.status === "paused") return job;
        if (job.status !== "running") {
          fail("只能暂停running流水线", "CONTENT_PIPELINE_NOT_RUNNING");
        }
        const station = getStation(tenantId, pipelineId, job.currentStation);
        if (!station || !["pending", "running"].includes(station.status)) {
          fail(
            "当前工位不在可暂停状态",
            "CONTENT_PIPELINE_PAUSE_STATE_INVALID",
          );
        }
        const pausedAt = timestamp();
        if (station.status === "running") {
          const stationUpdate = db
            .prepare(
              `UPDATE content_production_pipeline_stations
            SET status='paused',updated_at=?
            WHERE tenant_id=? AND pipeline_id=? AND station_idx=?
              AND status='running' AND attempt=?`,
            )
            .run(
              pausedAt,
              tenantId,
              pipelineId,
              job.currentStation,
              station.attempt,
            );
          if (Number(stationUpdate.changes) !== 1) {
            fail("工位状态已变化，暂停失败", "CONTENT_PIPELINE_STALE_ATTEMPT");
          }
        }
        const workflow = safeValue({
          ...(job.workflow || {}),
          lifecycle: {
            status: "paused",
            reason: cleanText(reason, 160) || "user_requested",
            pausedAt,
          },
        });
        const jobUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_jobs
          SET status='paused',workflow_json=?,version=version+1,updated_at=?
          WHERE tenant_id=? AND id=? AND status='running' AND version=?`,
          )
          .run(json(workflow), pausedAt, tenantId, pipelineId, job.version);
        if (Number(jobUpdate.changes) !== 1) {
          fail("流水线状态已变化，暂停失败", "CONTENT_PIPELINE_STALE_ATTEMPT");
        }
        insertPhaseEvent(
          {
            tenantId,
            pipelineId,
            stationIdx: job.currentStation,
            stationAttempt: station.attempt,
            phase: "recover",
            state: "waiting",
            detail: {
              code: "CONTENT_PIPELINE_PAUSED",
              source: "lifecycle_pause",
            },
          },
          pausedAt,
        );
        return getJob(tenantId, pipelineId);
      });
    },

    resumePausedPipeline({ tenantId, pipelineId }) {
      return transaction(() => {
        const job = getJob(tenantId, pipelineId);
        if (!job) {
          fail("内容生产流水线不存在", "CONTENT_PIPELINE_NOT_FOUND", 404);
        }
        if (job.status !== "paused") {
          fail("只能继续已暂停流水线", "CONTENT_PIPELINE_NOT_PAUSED");
        }
        const station = getStation(tenantId, pipelineId, job.currentStation);
        if (!station || !["pending", "paused"].includes(station.status)) {
          fail(
            "暂停工位状态无法安全继续",
            "CONTENT_PIPELINE_PAUSED_STATION_INVALID",
          );
        }
        const billingState = cleanText(
          station.billingEvidence?.state || station.billingEvidence?.status,
          80,
        );
        if (
          station.billingEvidence?.pendingReconciliation === true ||
          Number(station.billingEvidence?.heldCredits || 0) > 0 ||
          ["held", "pending_reconciliation"].includes(billingState)
        ) {
          fail(
            "当前工位仍有未结算占扣，禁止继续",
            "CONTENT_PIPELINE_BILLING_PENDING_RECONCILIATION",
          );
        }
        const resumedAt = timestamp();
        if (station.status === "paused") {
          const stationUpdate = db
            .prepare(
              `UPDATE content_production_pipeline_stations
            SET status='pending',started_at=NULL,completed_at=NULL,updated_at=?
            WHERE tenant_id=? AND pipeline_id=? AND station_idx=?
              AND status='paused' AND attempt=? AND output_json IS NULL`,
            )
            .run(
              resumedAt,
              tenantId,
              pipelineId,
              job.currentStation,
              station.attempt,
            );
          if (Number(stationUpdate.changes) !== 1) {
            fail(
              "暂停工位状态已变化，不能继续",
              "CONTENT_PIPELINE_STALE_ATTEMPT",
            );
          }
        }
        const workflow = safeValue({
          ...(job.workflow || {}),
          lifecycle: {
            status: "running",
            resumedAt,
            previousPausedAt: job.workflow?.lifecycle?.pausedAt || null,
          },
        });
        const jobUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_jobs
          SET status='running',workflow_json=?,failure_json=NULL,
              version=version+1,updated_at=?
          WHERE tenant_id=? AND id=? AND status='paused' AND version=?`,
          )
          .run(json(workflow), resumedAt, tenantId, pipelineId, job.version);
        if (Number(jobUpdate.changes) !== 1) {
          fail("流水线状态已变化，不能继续", "CONTENT_PIPELINE_STALE_ATTEMPT");
        }
        insertPhaseEvent(
          {
            tenantId,
            pipelineId,
            stationIdx: job.currentStation,
            stationAttempt: station.attempt,
            phase: "recover",
            state: "recovered",
            detail: {
              code: "CONTENT_PIPELINE_RESUMED",
              source: "lifecycle_resume",
            },
          },
          resumedAt,
        );
        return getJob(tenantId, pipelineId);
      });
    },

    cancelPipeline({
      tenantId,
      pipelineId,
      reason = "user_requested",
      releaseUndelivered = null,
    }) {
      return transaction(() => {
        const job = getJob(tenantId, pipelineId);
        if (!job) {
          fail("内容生产流水线不存在", "CONTENT_PIPELINE_NOT_FOUND", 404);
        }
        if (job.status === "cancelled") return job;
        if (!CONTENT_PRODUCTION_LIFECYCLE_ACTIVE_STATES.has(job.status)) {
          fail(
            "当前流水线已是不可取消的终态",
            "CONTENT_PIPELINE_CANCEL_STATE_INVALID",
          );
        }
        const station = getStation(tenantId, pipelineId, job.currentStation);
        if (!station) {
          fail("当前流水线工位不存在", "CONTENT_PIPELINE_STATION_MISSING");
        }
        const cancelledAt = timestamp();
        const releaseEvidence =
          typeof releaseUndelivered === "function"
            ? safeValue(
                releaseUndelivered({
                  tenantId,
                  pipelineId,
                  stationIdx: job.currentStation,
                  station: safeValue(station),
                  cancelledAt,
                }) || {},
              )
            : {};
        const workflow = safeValue({
          ...(job.workflow || {}),
          lifecycle: {
            status: "cancelled",
            reason: cleanText(reason, 160) || "user_requested",
            cancelledAt,
            releaseEvidence,
          },
        });
        const jobUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_jobs
          SET status='cancelled',pending_station=NULL,workflow_json=?,
              failure_json=?,version=version+1,updated_at=?
          WHERE tenant_id=? AND id=? AND status=? AND version=?`,
          )
          .run(
            json(workflow),
            json({
              code: "CONTENT_PIPELINE_CANCELLED",
              message: "流水线已取消；已交付与已结算历史原样保留",
              stationIdx: job.currentStation,
              cancelledAt,
            }),
            cancelledAt,
            tenantId,
            pipelineId,
            job.status,
            job.version,
          );
        if (Number(jobUpdate.changes) !== 1) {
          fail("流水线状态已变化，取消失败", "CONTENT_PIPELINE_STALE_ATTEMPT");
        }
        db.prepare(
          `UPDATE content_production_pipeline_stations
          SET status='cancelled',failure_json=COALESCE(failure_json,?),updated_at=?
          WHERE tenant_id=? AND pipeline_id=? AND station_idx>=?
            AND status IN ('pending','running','paused','awaiting_approval','billing_pending','failed')`,
        ).run(
          json({
            code: "CONTENT_PIPELINE_CANCELLED",
            message: "流水线已取消",
            cancelledAt,
          }),
          cancelledAt,
          tenantId,
          pipelineId,
          job.currentStation,
        );
        insertPhaseEvent(
          {
            tenantId,
            pipelineId,
            stationIdx: job.currentStation,
            stationAttempt: station.attempt,
            phase: "failure",
            state: "failed",
            detail: {
              code: "CONTENT_PIPELINE_CANCELLED",
              source: "lifecycle_cancel",
            },
          },
          cancelledAt,
        );
        return getJob(tenantId, pipelineId);
      });
    },

    attachLifecycleBillingEvidence({
      tenantId,
      pipelineId,
      stationIdx,
      expectedAttempt,
      billingEvidence,
      failure = null,
    }) {
      return transaction(() => {
        const job = getJob(tenantId, pipelineId);
        const station = getStation(tenantId, pipelineId, stationIdx);
        if (
          !job ||
          !station ||
          !["paused", "cancelled"].includes(job.status) ||
          Number(station.attempt) !== Number(expectedAttempt)
        ) {
          return null;
        }
        const attachedAt = timestamp();
        const evidence = safeValue(billingEvidence || {});
        const contextSnapshot = {
          ...(station.contextSnapshot || {}),
          billingEvidence: evidence,
        };
        db.prepare(
          `UPDATE content_production_pipeline_stations
          SET billing_evidence_json=?,context_snapshot_json=?,
              failure_json=COALESCE(?,failure_json),updated_at=?
          WHERE tenant_id=? AND pipeline_id=? AND station_idx=? AND attempt=?`,
        ).run(
          json(evidence),
          json(contextSnapshot),
          failure ? json(failure) : null,
          attachedAt,
          tenantId,
          pipelineId,
          stationIdx,
          expectedAttempt,
        );
        insertPhaseEvent(
          {
            tenantId,
            pipelineId,
            stationIdx,
            stationAttempt: expectedAttempt,
            phase: "settle",
            state:
              evidence.pendingReconciliation === true ||
              ["held", "pending_reconciliation"].includes(
                cleanText(evidence.state || evidence.status, 80),
              )
                ? "waiting"
                : "completed",
            detail: {
              billingPending:
                evidence.pendingReconciliation === true ||
                Number(evidence.heldCredits || 0) > 0,
              source: "lifecycle_abort_settlement",
            },
            usageRef: {
              source: "billing_evidence",
              ...evidence,
              evidenceFingerprint: fingerprint(evidence),
            },
          },
          attachedAt,
        );
        return getJob(tenantId, pipelineId);
      });
    },

    resetFailedStation(tenantId, pipelineId) {
      return transaction(() => {
        const job = getJob(tenantId, pipelineId);
        if (!job || job.status !== "failed") {
          fail("只能重试失败的流水线", "CONTENT_PIPELINE_NOT_FAILED");
        }
        const resetAt = timestamp();
        const info = db
          .prepare(
            `UPDATE content_production_pipeline_stations
          SET status='pending',failure_json=NULL,started_at=NULL,completed_at=NULL,updated_at=?
          WHERE tenant_id=? AND pipeline_id=? AND station_idx=? AND status='failed'`,
          )
          .run(resetAt, tenantId, pipelineId, job.currentStation);
        if (Number(info.changes) !== 1) {
          fail(
            "失败工位状态无法恢复",
            "CONTENT_PIPELINE_FAILED_STATION_MISSING",
          );
        }
        db.prepare(
          `UPDATE content_production_pipeline_jobs
          SET status='running',failure_json=NULL,version=version+1,updated_at=?
          WHERE tenant_id=? AND id=?`,
        ).run(resetAt, tenantId, pipelineId);
        const previousStation = getStation(
          tenantId,
          pipelineId,
          job.currentStation,
        );
        insertPhaseEvent(
          {
            tenantId,
            pipelineId,
            stationIdx: job.currentStation,
            stationAttempt: Number(previousStation?.attempt || 0) + 1,
            phase: "retry",
            state: "retrying",
            detail: {
              attemptCount: Number(previousStation?.attempt || 0) + 1,
              source: "explicit_retry",
            },
          },
          resetAt,
        );
        return getJob(tenantId, pipelineId);
      });
    },

    authorizePaidMedia({ tenantId, pipelineId, policy }) {
      return transaction(() => {
        const job = getJob(tenantId, pipelineId);
        if (!job)
          fail("内容生产流水线不存在", "CONTENT_PIPELINE_NOT_FOUND", 404);
        const station = getStation(tenantId, pipelineId, 5);
        const authorizationBlocked =
          job.status === "failed" &&
          job.currentStation === 5 &&
          station?.status === "failed" &&
          PAID_MEDIA_AUTHORIZATION_FAILURE_CODES.has(
            cleanText(station.failure?.code || job.failure?.code, 160),
          );
        const authorizedAt = timestamp();
        const workflow = {
          ...safeValue(job.workflow || {}),
          paidMediaAuthorization: safeValue(policy),
        };
        if (authorizationBlocked) {
          const stationUpdate = db
            .prepare(
              `UPDATE content_production_pipeline_stations
            SET status='pending',failure_json=NULL,started_at=NULL,completed_at=NULL,updated_at=?
            WHERE tenant_id=? AND pipeline_id=? AND station_idx=5 AND status='failed'`,
            )
            .run(authorizedAt, tenantId, pipelineId);
          if (Number(stationUpdate.changes) !== 1) {
            fail(
              "付费媒体授权阻断工位无法恢复",
              "CONTENT_PIPELINE_MEDIA_AUTHORIZATION_RECOVERY_FAILED",
            );
          }
          const jobUpdate = db
            .prepare(
              `UPDATE content_production_pipeline_jobs
            SET status='running',pending_station=NULL,workflow_json=?,failure_json=NULL,
                version=version+1,updated_at=?
            WHERE tenant_id=? AND id=? AND status='failed' AND current_station=5`,
            )
            .run(json(workflow), authorizedAt, tenantId, pipelineId);
          if (Number(jobUpdate.changes) !== 1) {
            fail(
              "付费媒体授权后的流水线状态已变化",
              "CONTENT_PIPELINE_STALE_ATTEMPT",
            );
          }
        } else {
          const jobUpdate = db
            .prepare(
              `UPDATE content_production_pipeline_jobs
            SET workflow_json=?,version=version+1,updated_at=?
            WHERE tenant_id=? AND id=? AND version=?`,
            )
            .run(
              json(workflow),
              authorizedAt,
              tenantId,
              pipelineId,
              job.version,
            );
          if (Number(jobUpdate.changes) !== 1) {
            fail(
              "付费媒体授权写入时流水线状态已变化",
              "CONTENT_PIPELINE_STALE_ATTEMPT",
            );
          }
        }
        return getJob(tenantId, pipelineId);
      });
    },

    recoverInterruptedStation(
      tenantId,
      pipelineId,
      { source = "explicit_stale_recovery" } = {},
    ) {
      return transaction(() => {
        const job = getJob(tenantId, pipelineId);
        if (!job || job.status !== "running") {
          fail("只能恢复running流水线", "CONTENT_PIPELINE_NOT_RUNNING");
        }
        const station = getStation(tenantId, pipelineId, job.currentStation);
        if (
          !station ||
          station.status !== "running" ||
          station.output !== null
        ) {
          fail(
            "当前没有可安全恢复的中断工位",
            "CONTENT_PIPELINE_NOT_INTERRUPTED",
          );
        }
        const recoveredAt = timestamp();
        const startedAtMs = Date.parse(station.startedAt || "");
        const recoveredAtMs = Date.parse(recoveredAt);
        if (
          !Number.isFinite(startedAtMs) ||
          !Number.isFinite(recoveredAtMs) ||
          recoveredAtMs - startedAtMs < interruptedStaleMs
        ) {
          fail(
            "当前工位仍在安全执行窗口内，不能强制恢复；请等待超时后重试",
            "CONTENT_PIPELINE_STATION_STILL_ACTIVE",
          );
        }
        if (station.attempt >= CONTENT_PRODUCTION_MAX_STATION_ATTEMPTS) {
          const exhaustedAt = timestamp();
          const failure = {
            code: "CONTENT_PIPELINE_RETRY_LIMIT_REACHED",
            message: `工位${station.stationIdx}已用完${CONTENT_PRODUCTION_MAX_RETRY_ATTEMPTS}次重试额度，自动恢复已停止`,
            stationIdx: station.stationIdx,
            failedAt: exhaustedAt,
          };
          db.prepare(
            `UPDATE content_production_pipeline_stations
            SET status='failed',failure_json=?,completed_at=?,updated_at=?
            WHERE tenant_id=? AND pipeline_id=? AND station_idx=?
              AND status='running' AND attempt=? AND output_json IS NULL`,
          ).run(
            json(failure),
            exhaustedAt,
            exhaustedAt,
            tenantId,
            pipelineId,
            job.currentStation,
            station.attempt,
          );
          db.prepare(
            `UPDATE content_production_pipeline_jobs
            SET status='failed',failure_json=?,version=version+1,updated_at=?
            WHERE tenant_id=? AND id=? AND status='running' AND current_station=?`,
          ).run(
            json(failure),
            exhaustedAt,
            tenantId,
            pipelineId,
            job.currentStation,
          );
          insertPhaseEvent(
            {
              tenantId,
              pipelineId,
              stationIdx: job.currentStation,
              stationAttempt: station.attempt,
              phase: "failure",
              state: "failed",
              detail: {
                code: "CONTENT_PIPELINE_RETRY_LIMIT_REACHED",
                source: cleanText(source, 80) || "stale_recovery",
              },
            },
            exhaustedAt,
          );
          return getJob(tenantId, pipelineId);
        }
        const stationUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_stations
          SET status='pending',failure_json=?,updated_at=?
          WHERE tenant_id=? AND pipeline_id=? AND station_idx=?
            AND status='running' AND attempt=? AND output_json IS NULL`,
          )
          .run(
            json({
              code: "CONTENT_PIPELINE_INTERRUPTED_RECOVERED",
              message: "进程中断后由管理端明确恢复；没有合成上游产物",
              recoveredAt,
            }),
            recoveredAt,
            tenantId,
            pipelineId,
            job.currentStation,
            station.attempt,
          );
        if (Number(stationUpdate.changes) !== 1) {
          fail(
            "工位状态已变化，不能重复恢复",
            "CONTENT_PIPELINE_STALE_ATTEMPT",
          );
        }
        insertPhaseEvent(
          {
            tenantId,
            pipelineId,
            stationIdx: job.currentStation,
            stationAttempt: station.attempt,
            phase: "recover",
            state: "recovered",
            detail: {
              code: "CONTENT_PIPELINE_INTERRUPTED_RECOVERED",
              source: cleanText(source, 80) || "stale_recovery",
            },
          },
          recoveredAt,
        );
        return getJob(tenantId, pipelineId);
      });
    },

    markAwaitingMetrics(tenantId, pipelineId) {
      return transaction(() => {
        const job = getJob(tenantId, pipelineId);
        const station = getStation(tenantId, pipelineId, 9);
        if (
          !job ||
          job.status !== "running" ||
          job.currentStation !== 9 ||
          !station ||
          station.status !== "pending"
        ) {
          fail(
            "流水线当前不能进入等待发布指标状态",
            "CONTENT_PIPELINE_METRICS_STATE_INVALID",
          );
        }
        const pausedAt = timestamp();
        const boundary = {
          schemaVersion: "nanowork.content-pipeline-await-metrics/1",
          code: "await_metrics",
          label: "等待真实发布指标",
          message: "复盘官只在真实发布记录和至少一项数值指标回传后执行",
          stationIdx: 9,
          providerCalled: false,
          pausedAt,
        };
        const stationUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_stations
          SET status='awaiting_approval',handler_evidence_json=?,context_snapshot_json=?,
              approval_boundary_json=?,failure_json=NULL,updated_at=?
          WHERE tenant_id=? AND pipeline_id=? AND station_idx=9 AND status='pending'`,
          )
          .run(
            json({
              completed: false,
              providerCalled: false,
              reasonCode: "CONTENT_PIPELINE_METRICS_REQUIRED",
            }),
            json({
              executionMode: "pipeline",
              stationIdx: 9,
              awaiting: "publication_metrics",
            }),
            json(boundary),
            pausedAt,
            tenantId,
            pipelineId,
          );
        if (Number(stationUpdate.changes) !== 1) {
          fail(
            "工位状态已变化，不能重复等待指标",
            "CONTENT_PIPELINE_STALE_ATTEMPT",
          );
        }
        const jobUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_jobs
          SET status='awaiting_approval',current_station=9,pending_station=9,
              failure_json=NULL,version=version+1,updated_at=?
          WHERE tenant_id=? AND id=? AND status='running' AND current_station=9`,
          )
          .run(pausedAt, tenantId, pipelineId);
        if (Number(jobUpdate.changes) !== 1) {
          fail(
            "流水线状态已变化，不能写入等待指标状态",
            "CONTENT_PIPELINE_STALE_ATTEMPT",
          );
        }
        return getJob(tenantId, pipelineId);
      });
    },

    releaseAwaitingMetrics(tenantId, pipelineId) {
      return transaction(() => {
        const job = getJob(tenantId, pipelineId);
        const station = getStation(tenantId, pipelineId, 9);
        if (
          !job ||
          job.status !== "awaiting_approval" ||
          job.currentStation !== 9 ||
          !station ||
          station.status !== "awaiting_approval" ||
          station.approvalBoundary?.code !== "await_metrics"
        ) {
          fail(
            "流水线当前不在等待发布指标状态",
            "CONTENT_PIPELINE_NOT_AWAITING_METRICS",
          );
        }
        const releasedAt = timestamp();
        const stationUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_stations
          SET status='pending',handler_evidence_json=NULL,context_snapshot_json=NULL,
              approval_boundary_json=NULL,failure_json=NULL,updated_at=?
          WHERE tenant_id=? AND pipeline_id=? AND station_idx=9 AND status='awaiting_approval'`,
          )
          .run(releasedAt, tenantId, pipelineId);
        if (Number(stationUpdate.changes) !== 1) {
          fail(
            "工位状态已变化，不能恢复复盘官",
            "CONTENT_PIPELINE_STALE_ATTEMPT",
          );
        }
        const jobUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_jobs
          SET status='running',current_station=9,pending_station=NULL,
              failure_json=NULL,version=version+1,updated_at=?
          WHERE tenant_id=? AND id=? AND status='awaiting_approval' AND current_station=9`,
          )
          .run(releasedAt, tenantId, pipelineId);
        if (Number(jobUpdate.changes) !== 1) {
          fail(
            "流水线状态已变化，不能恢复复盘官",
            "CONTENT_PIPELINE_STALE_ATTEMPT",
          );
        }
        return getJob(tenantId, pipelineId);
      });
    },

    submitPublicationMetrics({ tenantId, pipelineId, evidence, actor }) {
      return transaction(() => {
        const job = getJob(tenantId, pipelineId);
        const station = getStation(tenantId, pipelineId, 9);
        const waiting =
          job?.status === "awaiting_approval" &&
          job.pendingStation === 9 &&
          station?.status === "awaiting_approval" &&
          station?.approvalBoundary?.code === "await_metrics";
        const legacyCompleted =
          job?.status === "completed" &&
          job.currentStation === 10 &&
          station?.status === "completed" &&
          !publicationMetricsOrNull(job.workflow?.publicationMetrics, job.task);
        if (!job || !station || (!waiting && !legacyCompleted)) {
          fail(
            "流水线当前不在等待真实发布指标状态",
            "CONTENT_PIPELINE_NOT_AWAITING_METRICS",
          );
        }
        const submittedAt = timestamp();
        const workflow = {
          ...safeValue(job.workflow),
          publicationMetrics: safeValue(evidence),
        };
        const submittedEntry = (evidence.entries || []).find(
          (entry) =>
            entry?.publication?.platform === evidence.lastSubmittedPlatform,
        );
        const audits = [
          ...(station.approvalAudit || []),
          safeValue({
            schemaVersion: "nanowork.content-publication-metrics-audit/1",
            action: "submit_publication_metrics",
            verificationStatus: "manual_unverified",
            stationIdx: 9,
            previousAttempt: station.attempt,
            previousStatus: station.status,
            previousOutputFingerprint: station.output
              ? fingerprint(station.output)
              : null,
            platform: evidence.lastSubmittedPlatform,
            metricKeys: Object.keys(submittedEntry?.metrics || {}).sort(),
            submittedPlatforms: [...(evidence.submittedPlatforms || [])],
            missingPlatforms: [...(evidence.missingPlatforms || [])],
            complete: evidence.complete === true,
            actor: { id: actor.id, role: actor.role, name: actor.name || null },
            submittedAt,
          }),
        ];
        if (evidence.complete !== true) {
          const stationUpdate = db
            .prepare(
              `UPDATE content_production_pipeline_stations
            SET approval_audit_json=?,updated_at=?
            WHERE tenant_id=? AND pipeline_id=? AND station_idx=9
              AND status IN ('awaiting_approval','completed')`,
            )
            .run(json(audits), submittedAt, tenantId, pipelineId);
          if (Number(stationUpdate.changes) !== 1) {
            fail(
              "复盘工位状态已变化，指标不能重复提交",
              "CONTENT_PIPELINE_STALE_ATTEMPT",
            );
          }
          const jobUpdate = db
            .prepare(
              `UPDATE content_production_pipeline_jobs
            SET workflow_json=?,version=version+1,updated_at=?
            WHERE tenant_id=? AND id=? AND status IN ('awaiting_approval','completed')`,
            )
            .run(json(workflow), submittedAt, tenantId, pipelineId);
          if (Number(jobUpdate.changes) !== 1) {
            fail(
              "流水线状态已变化，不能累计发布指标",
              "CONTENT_PIPELINE_STALE_ATTEMPT",
            );
          }
          return getJob(tenantId, pipelineId);
        }
        const stationUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_stations
          SET status='pending',output_json=NULL,handler_evidence_json=NULL,
              billing_evidence_json=NULL,context_snapshot_json=NULL,
              approval_boundary_json=NULL,approval_audit_json=?,selection_json=NULL,
              failure_json=NULL,started_at=NULL,completed_at=NULL,updated_at=?
          WHERE tenant_id=? AND pipeline_id=? AND station_idx=9
            AND status IN ('awaiting_approval','completed')`,
          )
          .run(json(audits), submittedAt, tenantId, pipelineId);
        if (Number(stationUpdate.changes) !== 1) {
          fail(
            "复盘工位状态已变化，指标不能重复提交",
            "CONTENT_PIPELINE_STALE_ATTEMPT",
          );
        }
        const jobUpdate = db
          .prepare(
            `UPDATE content_production_pipeline_jobs
          SET status='running',current_station=9,pending_station=NULL,workflow_json=?,
              failure_json=NULL,version=version+1,updated_at=?
          WHERE tenant_id=? AND id=? AND status IN ('awaiting_approval','completed')`,
          )
          .run(json(workflow), submittedAt, tenantId, pipelineId);
        if (Number(jobUpdate.changes) !== 1) {
          fail(
            "流水线状态已变化，不能恢复复盘工位",
            "CONTENT_PIPELINE_STALE_ATTEMPT",
          );
        }
        return getJob(tenantId, pipelineId);
      });
    },
  });
}

function validateRepository(repository) {
  const methods = [
    "createJob",
    "getJob",
    "listJobs",
    "getStation",
    "listStations",
    "readCompletedOutputsBefore",
    "claimStation",
    "recordGenerated",
    "recordSkipped",
    "recordFailure",
    "attachBillingEvidence",
    "markBillingPending",
    "recoverSettledBillingPending",
    "markPreDeliveryBillingPending",
    "recordReview",
    "resetFailedStation",
    "authorizePaidMedia",
    "recoverInterruptedStation",
    "markAwaitingMetrics",
    "releaseAwaitingMetrics",
    "submitPublicationMetrics",
  ];
  for (const method of methods) {
    if (typeof repository?.[method] !== "function") {
      fail(
        `流水线仓库缺少${method}`,
        "CONTENT_PIPELINE_REPOSITORY_INVALID",
        500,
      );
    }
  }
}

function publicPipeline(repository, tenantId, pipelineId) {
  const job = repository.getJob(tenantId, pipelineId);
  if (!job) fail("内容生产流水线不存在", "CONTENT_PIPELINE_NOT_FOUND", 404);
  const knowledgeSink =
    typeof repository.getKnowledgeSink === "function"
      ? repository.getKnowledgeSink(tenantId, pipelineId)
      : null;
  const artifacts =
    typeof repository.listArtifacts === "function"
      ? repository.listArtifacts(tenantId, pipelineId)
      : [];
  const phaseEvents =
    typeof repository.listPhaseEvents === "function"
      ? repository.listPhaseEvents(tenantId, pipelineId)
      : [];
  const backfills =
    typeof repository.listArtifactBackfills === "function"
      ? repository.listArtifactBackfills(tenantId, pipelineId)
      : [];
  const backfillByStation = new Map(
    backfills.map((item) => [item.stationIdx, safeValue(item)]),
  );
  const artifactsByStation = new Map();
  for (const artifact of artifacts) {
    const rows = artifactsByStation.get(artifact.stationIdx) || [];
    rows.push(safeValue(artifact));
    artifactsByStation.set(artifact.stationIdx, rows);
  }
  const phaseEventsByStation = new Map();
  for (const event of phaseEvents) {
    const rows = phaseEventsByStation.get(event.stationIdx) || [];
    rows.push(safeValue(event));
    phaseEventsByStation.set(event.stationIdx, rows);
  }
  const stations = repository
    .listStations(tenantId, pipelineId)
    .map((station) =>
      safeValue({
        ...station,
        phaseEvents: phaseEventsByStation.get(station.stationIdx) || [],
        artifacts: artifactsByStation.get(station.stationIdx) || [],
        artifactBackfill: backfillByStation.get(station.stationIdx) || null,
      }),
    );
  const station9 = stations.find((station) => station.stationIdx === 9);
  const station5 = stations.find((station) => station.stationIdx === 5);
  const awaitingMediaAuthorization =
    job.status === "failed" &&
    job.currentStation === 5 &&
    station5?.status === "failed" &&
    PAID_MEDIA_AUTHORIZATION_FAILURE_CODES.has(
      cleanText(station5?.failure?.code || job.failure?.code, 160),
    );
  const awaitingMetrics =
    pipelineMustAwaitPublicationMetrics(job) &&
    ((job.status === "awaiting_approval" &&
      station9?.approvalBoundary?.code === "await_metrics") ||
      (job.status === "completed" && station9?.status === "completed"));
  return Object.freeze({
    schemaVersion: CONTENT_PRODUCTION_PIPELINE_SCHEMA,
    mode: "pipeline",
    ...safeValue(job),
    ...(awaitingMediaAuthorization
      ? {
          status: "awaiting_media_authorization",
          currentStation: 5,
          pendingStation: 5,
        }
      : {}),
    ...(awaitingMetrics
      ? {
          status: "awaiting_metrics",
          currentStation: 9,
          pendingStation: 9,
        }
      : {}),
    retryPolicy: {
      maxRetries: CONTENT_PRODUCTION_MAX_RETRY_ATTEMPTS,
      maxStationAttempts: CONTENT_PRODUCTION_MAX_STATION_ATTEMPTS,
      automaticMaxRetries: CONTENT_PRODUCTION_MAX_RETRY_ATTEMPTS,
      automaticMaxStationAttempts: CONTENT_PRODUCTION_MAX_STATION_ATTEMPTS,
      manualAuthorization: "manager_role_required",
      manualUnlimited: true,
      billing: "each_attempt_independently_reconciled",
    },
    knowledgeSink: knowledgeSink ? safeValue(knowledgeSink) : null,
    delivery: assembleContentPipelineDelivery(
      Object.fromEntries(
        stations
          .filter((station) => station?.output != null)
          .map((station) => [station.stationIdx, station.output]),
      ),
    ),
    stations: stations.map((station) => {
      const manualAllowed = station.status === "failed";
      const retry = {
        used: Math.max(0, Number(station.attempt || 0) - 1),
        // `remaining` is the legacy manual-retry field. Manual retries are
        // manager-gated at the HTTP boundary and intentionally unlimited;
        // automated stale recovery keeps its own finite budget below.
        remaining: null,
        allowed: manualAllowed,
        manualAllowed,
        manualUnlimited: true,
        automaticRemaining: Math.max(
          0,
          CONTENT_PRODUCTION_MAX_STATION_ATTEMPTS -
            Number(station.attempt || 0),
        ),
      };
      if (awaitingMetrics && station.stationIdx === 9) {
        return { ...station, status: "awaiting_metrics", retry };
      }
      if (awaitingMediaAuthorization && station.stationIdx === 5) {
        return { ...station, status: "awaiting_media_authorization", retry };
      }
      return { ...station, retry };
    }),
  });
}

/**
 * 0→9内容生产编排器。handlerRegistry必须是已经接入真实模型/媒体provider的
 * content-handler-adapter registry；本层只管可恢复的工位状态、真实上游和审批边界。
 */
export function createContentProductionPipeline({
  repository,
  handlerRegistry,
  resolveImageModel,
  estimateMaxCredits,
  classifyRecovery = () => ({ safeToResume: true }),
  releaseUndeliveredHolds = null,
  buildRuntimeContext = buildContentHandlerRuntimeContext,
  compileStationExecution = defaultCompileStationExecution,
  executeStationDelivery = executeStationDeliveryDirect,
  now = () => new Date(),
} = {}) {
  validateRepository(repository);
  if (!handlerRegistry || typeof handlerRegistry.invoke !== "function") {
    fail(
      "内容生产流水线缺少可执行handler registry",
      "CONTENT_PIPELINE_HANDLER_REGISTRY_INVALID",
      500,
    );
  }
  if (typeof buildRuntimeContext !== "function") {
    fail("内容生产流水线缺少runtime context构建器", undefined, 500);
  }
  if (typeof compileStationExecution !== "function") {
    fail("内容生产流水线缺少工位完整员工包编译器", undefined, 500);
  }
  if (typeof executeStationDelivery !== "function") {
    fail(
      "内容生产流水线缺少工位交付边界",
      "CONTENT_PIPELINE_DELIVERY_BOUNDARY_INVALID",
      500,
    );
  }
  if (
    typeof resolveImageModel !== "function" ||
    typeof estimateMaxCredits !== "function"
  ) {
    fail(
      "内容生产流水线缺少与图片provider共用的模型与计价解析器",
      "CONTENT_PIPELINE_PAID_MEDIA_PRICING_INVALID",
      500,
    );
  }
  if (typeof classifyRecovery !== "function") {
    fail("内容生产流水线缺少恢复分类器", undefined, 500);
  }
  if (
    releaseUndeliveredHolds !== null &&
    typeof releaseUndeliveredHolds !== "function"
  ) {
    fail("内容生产流水线取消账务回调无效", undefined, 500);
  }
  const running = new Set();
  const activeControllers = new Map();

  // 进度事件是业务执行的可观测副产物。写事件失败不得改变provider调用、
  // 产物持久化或账务终态；权威业务状态仍由station/job事务守护。
  const recordPhaseBestEffort = (event) => {
    if (typeof repository.recordPhaseEvent !== "function") return null;
    try {
      return repository.recordPhaseEvent(event);
    } catch {
      return null;
    }
  };

  const paidMediaRuntimePricing = (task) => {
    const imageModel = cleanText(
      resolveImageModel({ task, stationIdx: 5 }),
      160,
    );
    if (!imageModel) {
      fail(
        "工位5执行前无法解析实际图片模型，需要重新授权",
        "CONTENT_PAID_MEDIA_REAUTHORIZATION_REQUIRED",
      );
    }
    let actualUnitCredits;
    try {
      actualUnitCredits = Number(estimateMaxCredits("image", imageModel));
    } catch {
      fail(
        "工位5执行前无法核实当前图片计价，需要重新授权",
        "CONTENT_PAID_MEDIA_REAUTHORIZATION_REQUIRED",
      );
    }
    if (!Number.isSafeInteger(actualUnitCredits) || actualUnitCredits <= 0) {
      fail(
        "工位5执行前返回的当前图片计价无效，需要重新授权",
        "CONTENT_PAID_MEDIA_REAUTHORIZATION_REQUIRED",
      );
    }
    return Object.freeze({
      actualImageModel: imageModel,
      actualUnitCredits,
      actualMaximumImageCount: contentPaidMediaMaximumImageCount(task),
    });
  };

  const inspect = ({ tenantId, pipelineId }) =>
    publicPipeline(
      repository,
      positiveInteger(tenantId, "tenantId"),
      positiveInteger(pipelineId, "pipelineId"),
    );

  const list = ({
    tenantId: rawTenantId,
    createdBy = null,
    limit = 20,
  } = {}) => {
    const tenantId = positiveInteger(rawTenantId, "tenantId");
    return Object.freeze({
      schemaVersion: CONTENT_PRODUCTION_PIPELINE_SCHEMA,
      mode: "pipeline",
      tenantId,
      jobs: repository
        .listJobs(tenantId, { createdBy, limit })
        .map((job) => safeValue(job)),
    });
  };

  const resume = async ({
    tenantId: rawTenantId,
    pipelineId: rawPipelineId,
    refreshWebEvidence = false,
    signal,
  } = {}) => {
    const tenantId = positiveInteger(rawTenantId, "tenantId");
    const pipelineId = positiveInteger(rawPipelineId, "pipelineId");
    const lockKey = `${tenantId}:${pipelineId}`;
    if (running.has(lockKey)) {
      fail("该内容流水线正在本进程执行", "CONTENT_PIPELINE_ALREADY_RUNNING");
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener?.("abort", forwardAbort, { once: true });
    const executionSignal = controller.signal;
    running.add(lockKey);
    activeControllers.set(lockKey, controller);
    try {
      const waitingJob = repository.getJob(tenantId, pipelineId);
      if (!waitingJob)
        fail("内容生产流水线不存在", "CONTENT_PIPELINE_NOT_FOUND", 404);
      const waitingStation =
        Number(waitingJob.currentStation) === 9
          ? repository.getStation(tenantId, pipelineId, 9)
          : null;
      if (
        waitingJob.status === "awaiting_approval" &&
        Number(waitingJob.currentStation) === 9 &&
        waitingStation?.status === "awaiting_approval" &&
        waitingStation?.approvalBoundary?.code === "await_metrics" &&
        contentPipelineUsesPredictiveRetro(waitingJob.workflow)
      ) {
        repository.releaseAwaitingMetrics(tenantId, pipelineId);
      }
      while (true) {
        if (executionSignal.aborted) {
          return publicPipeline(repository, tenantId, pipelineId);
        }
        const job = repository.getJob(tenantId, pipelineId);
        if (!job)
          fail("内容生产流水线不存在", "CONTENT_PIPELINE_NOT_FOUND", 404);
        if (job.status !== "running")
          return publicPipeline(repository, tenantId, pipelineId);
        if (job.currentStation >= CONTENT_PRODUCTION_PIPELINE_STATION_COUNT) {
          fail(
            "流水线状态损坏：running但已越过最后工位",
            "CONTENT_PIPELINE_STATE_CORRUPTED",
          );
        }
        const stationIdx = job.currentStation;
        if (stationIdx === 9 && pipelineMustAwaitPublicationMetrics(job)) {
          repository.markAwaitingMetrics(tenantId, pipelineId);
          return publicPipeline(repository, tenantId, pipelineId);
        }
        const descriptor = descriptorAt(stationIdx);
        const claimed = repository.claimStation(
          tenantId,
          pipelineId,
          stationIdx,
        );
        if (!claimed) {
          const latest = repository.getStation(
            tenantId,
            pipelineId,
            stationIdx,
          );
          if (latest?.status === "running") {
            fail(
              "工位已被其他执行者占用，不会重复调用API",
              "CONTENT_PIPELINE_STATION_BUSY",
            );
          }
          return publicPipeline(repository, tenantId, pipelineId);
        }

        let contextSnapshot = null;
        let generatedPayload = null;
        let currentPrivateWebSnapshot = null;
        let currentPrivateOutputSnapshot = null;
        let stationPersistCompleted = false;
        let activePhase = "context";
        let activePhaseState = "started";
        const phaseEvent = ({ phase, state, detail = {}, usageRef = null }) => {
          if (CONTENT_PRODUCTION_PHASES.has(phase)) {
            activePhase = phase;
            activePhaseState = state;
          }
          return recordPhaseBestEffort({
            tenantId,
            pipelineId,
            stationIdx,
            stationAttempt: claimed.attempt,
            phase,
            state,
            detail,
            usageRef,
          });
        };
        phaseEvent({
          phase: "context",
          state: "started",
          detail: { source: "database_persisted_upstream" },
        });
        try {
          // 工位5正文配图与工位6封面共用同一份老板付费媒体授权。
          // 两站都必须在handler/hold之前重验，防止封面绕过总额度。
          if ([5, 6].includes(stationIdx)) {
            validateContentPaidMediaAuthorization(
              job.workflow?.paidMediaAuthorization,
              {
                task: job.task,
                now,
                ...paidMediaRuntimePricing(job.task),
              },
            );
          }
          if (signal?.aborted) {
            const error = new Error("内容生产流水线已取消");
            error.code = "ABORT_ERR";
            throw error;
          }
          const persistedRows = repository.readCompletedOutputsBefore(
            tenantId,
            pipelineId,
            stationIdx,
          );
          const upstreamState = assertPersistedUpstream(
            persistedRows,
            stationIdx,
          );
          const outputs = upstreamState.outputs;
          const cachedPrivateWebSnapshot =
            typeof repository.getPrivateWebSnapshot === "function"
              ? repository.getPrivateWebSnapshot(
                  tenantId,
                  pipelineId,
                  stationIdx,
                )
              : null;
          if (
            upstreamState.skipped.includes(7) &&
            job.task.enable_deck !== false
          ) {
            fail(
              "演绎稿已启用但工位7被标记为skipped",
              "CONTENT_PIPELINE_SKIPPED_UPSTREAM_INVALID",
            );
          }
          if (stationIdx === 7 && job.task.enable_deck === false) {
            const skippedAt = instant(now);
            contextSnapshot = safeValue({
              schemaVersion: "nanowork.content-production-skipped-context/1",
              executionMode: "pipeline",
              stationIdx,
              workflowMode: workflowMode(job.workflow?.mode),
              upstream: {
                stationKeys: Object.keys(outputs),
                stationCount: Object.keys(outputs).length,
                persistedOnly: true,
                synthesized: false,
              },
              skip: {
                code: "CONTENT_PIPELINE_OPTIONAL_DECK_DISABLED",
                reason:
                  "Paihuo Brief.enable_deck=false，可选演绎师工位按原语义跳过",
                apiCalled: false,
                handlerInvoked: false,
                skippedAt,
              },
            });
            phaseEvent({
              phase: "context",
              state: "completed",
              detail: {
                upstreamStationCount: Object.keys(outputs).length,
                contextFingerprint: fingerprint(contextSnapshot),
                source: "optional_station_skip_context",
              },
            });
            repository.recordSkipped({
              tenantId,
              pipelineId,
              stationIdx,
              expectedAttempt: claimed.attempt,
              skipEvidence: {
                schemaVersion: "nanowork.content-production-station-skip/1",
                employeeIdx: stationIdx,
                employeeKey: descriptor.employeeKey,
                handlerId: descriptor.handlerId,
                completed: false,
                skipped: true,
                apiCalled: false,
                handlerInvoked: false,
                reasonCode: "CONTENT_PIPELINE_OPTIONAL_DECK_DISABLED",
                reason: "Brief.enable_deck=false",
                skippedAt,
              },
              contextSnapshot,
              approvalAudit: {
                schemaVersion: "nanowork.content-production-skip-audit/1",
                action: "skip_optional_station",
                reasonCode: "CONTENT_PIPELINE_OPTIONAL_DECK_DISABLED",
                stationIdx,
                automated: true,
                decidedAt: skippedAt,
              },
            });
            continue;
          }
          const built = await buildRuntimeContext({
            mode: "pipeline",
            tenantId,
            actorId: job.createdBy,
            employeeIdx: stationIdx,
            task: safeValue(job.task),
            outputs,
            persona: safeValue(job.persona),
            companyProfile: safeValue(job.settings?.companyProfile || {}),
            settings: safeValue(job.settings),
            workflow: {
              ...safeValue(job.workflow),
              pipelineId,
              runId: pipelineId,
              stationIdx,
              stationAttempt: claimed.attempt,
              handlerId: descriptor.handlerId,
              sourceSemantics: "paihuo_0_to_9_pipeline",
              upstreamSource: "database_persisted_completed_stations_only",
              upstreamSynthesized: false,
              skippedStations: [...upstreamState.skipped],
            },
            jobId: pipelineId,
            signal: executionSignal,
          });
          if (
            built?.context?.executionMode !== "pipeline" ||
            built?.context?.workflow?.upstreamSynthesized !== false ||
            built?.snapshot?.executionMode !== "pipeline" ||
            built?.snapshot?.upstream?.synthesized !== false
          ) {
            fail(
              "运行上下文未锁定pipeline或上游真实性证据",
              "CONTENT_PIPELINE_CONTEXT_NOT_STRICT",
            );
          }
          const snapshotKeys = built.snapshot.upstream.stationKeys || [];
          const expectedSnapshotKeys = Object.keys(outputs).sort(
            (a, b) => Number(a) - Number(b),
          );
          if (
            JSON.stringify(snapshotKeys) !==
            JSON.stringify(expectedSnapshotKeys)
          ) {
            fail(
              "运行上下文的上游指纹与已持久化工位不一致",
              "CONTENT_PIPELINE_UPSTREAM_EVIDENCE_MISMATCH",
            );
          }
          contextSnapshot = safeValue(built.snapshot);
          const stationExecution = validateStationExecutionPackage(
            await compileStationExecution({
              tenantId,
              pipelineId,
              stationIdx,
              descriptor: safeValue(descriptor),
              job: safeValue(job),
              context: safeValue(built.context),
              contextSnapshot: safeValue(contextSnapshot),
            }),
            stationIdx,
          );
          contextSnapshot.runtimePackageLoad = safeValue(
            stationExecution.runtimePackageLoad,
          );
          phaseEvent({
            phase: "context",
            state: "completed",
            detail: {
              upstreamStationCount: Object.keys(outputs).length,
              contextFingerprint: fingerprint(contextSnapshot),
              source: "database_persisted_upstream",
            },
          });
          const expectedPromptEvidence = expectedStationPromptEvidence(
            descriptor,
            stationExecution,
            contextSnapshot,
          );
          let generateCalled = false;
          let persistCalled = false;
          let persistCompleted = false;
          const deliveryResult = await executeStationDelivery({
            schemaVersion: CONTENT_PRODUCTION_STATION_DELIVERY_SCHEMA,
            tenantId,
            pipelineId,
            stationIdx,
            employee: safeValue({
              idx: descriptor.employeeIdx,
              key: descriptor.employeeKey,
              name: descriptor.employeeName,
              handlerId: descriptor.handlerId,
              legacyHandler: descriptor.legacyHandler,
            }),
            expectedPromptEvidence,
            signal: executionSignal,
            generate: async () => {
              if (generateCalled) {
                fail(
                  "工位交付边界不能重复调用generate",
                  "CONTENT_PIPELINE_GENERATE_CALLED_TWICE",
                );
              }
              generateCalled = true;
              const invocation = await handlerRegistry.invoke(stationIdx, {
                ...built.context,
                canonicalProfile: stationExecution.canonicalProfile,
                runtimePackageLoad: stationExecution.runtimePackageLoad,
                privateWebSnapshot: cachedPrivateWebSnapshot,
                refreshWebEvidence: refreshWebEvidence === true,
                signal: executionSignal,
                progress: (event = {}) => {
                  // registry只允许发送白名单phase元数据；即使未来注入的registry
                  // 误传query/prompt/body/URL，repository normalizer也不会落库。
                  phaseEvent({
                    phase: event.phase,
                    state: event.state,
                    detail: event.detail,
                    usageRef: event.usageRef,
                  });
                },
              });
              currentPrivateWebSnapshot =
                invocation?.privateWebSnapshot || null;
              currentPrivateOutputSnapshot = invocation?.privateOutputSnapshot || null;
              if (
                invocation?.employeeIdx !== stationIdx ||
                invocation?.handlerId !== descriptor.handlerId ||
                invocation?.evidence?.employeeIdx !== stationIdx ||
                invocation?.evidence?.executionMode !== "pipeline" ||
                invocation?.evidence?.completed !== true ||
                invocation?.evidence?.runtimePackageLoad
                  ?.aggregateFingerprint !==
                  stationExecution.runtimePackageLoad.aggregateFingerprint ||
                invocation?.evidence?.runtimePackageLoad
                  ?.allRequiredFieldsLoaded !== true ||
                invocation?.evidence?.runtimePackageLoad
                  ?.fullCanonicalObjectInSystemMessage !== true
              ) {
                fail(
                  "工位handler返回的执行证据与当前流水线工位不匹配",
                  "CONTENT_PIPELINE_HANDLER_EVIDENCE_MISMATCH",
                );
              }
              const output = extractOutput(invocation, stationIdx, built.context);
              const artifacts = normalizeStationArtifacts(
                invocation?.result?.artifacts,
                stationIdx,
              );
              let boundary = safeValue(descriptor.approvalBoundary);
              if (
                invocation?.approvalBoundary?.code !== boundary.code ||
                invocation?.evidence?.approvalBoundary?.code !== boundary.code
              ) {
                fail(
                  "工位审批边界与锁定handler证据不一致",
                  "CONTENT_PIPELINE_APPROVAL_EVIDENCE_MISMATCH",
                );
              }
              const mode = workflowMode(job.workflow?.mode);
              const policy = approvalPolicy(job.workflow?.approvalPolicy);
              const xhsSelectionRequired = stationIdx === 3 && resolveXhsSalesContext(3, { task: job.task }).salesMode;
              if (xhsSelectionRequired) boundary = { ...boundary, factoryCode: boundary.code, code: 'pick',
                reasonCode: 'CONTENT_PIPELINE_XHS_OWNER_SELECTION', ownerSelectionRequired: true,
                description: '老板显式选择小红书版本；模型自评仅推荐，自动接力也不能代选', humanRequired: true, candidateSelectionRequired: true };
              let persistedOutput = output;
              let approvalAudit = null;
              const awaitingApproval = xhsSelectionRequired || stationNeedsReview(
                boundary.code,
                mode,
                stationIdx,
                policy,
              );
              if (!awaitingApproval) {
                let automaticSelection = null;
                if (boundary.code === "pick") {
                  const candidates = candidateList(stationIdx, output);
                  if (!candidates.length) {
                    fail(
                      "托管模式无法自动选择：pick工位没有真实候选产物",
                      "CONTENT_PIPELINE_PICK_CANDIDATES_MISSING",
                    );
                  }
                  automaticSelection = {
                    candidateIndex: 0,
                    candidateId:
                      candidates[0]?.id || candidates[0]?.candidateId || null,
                  };
                  persistedOutput = applySelection(stationIdx, output, {
                    selection: automaticSelection,
                  });
                }
                if (
                  policy.mode === "custom" ||
                  policy.mode === "internal_auto"
                ) {
                  approvalAudit = ownerApprovalPolicyAudit({
                    pipelineId,
                    stationIdx,
                    descriptor,
                    boundary,
                    policy,
                    selection: automaticSelection,
                    now,
                  });
                } else {
                  const autoDecision = assertContentHandlerApprovalBoundary({
                    boundary,
                    action: "handoff",
                    automated: true,
                    runId: pipelineId,
                    handlerId: descriptor.handlerId,
                    workflowMode: mode,
                    now,
                  });
                  approvalAudit = automaticSelection
                    ? {
                        ...autoDecision.auditRecord,
                        selection: automaticSelection,
                      }
                    : autoDecision.auditRecord;
                }
              }
              generatedPayload = {
                ...safeValue({
                  output: persistedOutput,
                  handlerEvidence: invocation.evidence,
                  contextSnapshot,
                  approvalBoundary: boundary,
                  approvalAudit,
                  awaitingApproval,
                }),
                artifacts,
              };
              return generatedPayload;
            },
            persist: async () => {
              if (!generateCalled || !generatedPayload) {
                fail(
                  "工位交付边界必须先generate再persist",
                  "CONTENT_PIPELINE_PERSIST_BEFORE_GENERATE",
                );
              }
              if (persistCalled) {
                fail(
                  "工位交付边界不能重复调用persist",
                  "CONTENT_PIPELINE_PERSIST_CALLED_TWICE",
                );
              }
              persistCalled = true;
              phaseEvent({
                phase: "persist",
                state: "started",
                detail: {
                  artifactCount: generatedPayload.artifacts.length,
                  source: "station_transaction",
                },
              });
              const persisted = repository.recordGenerated({
                tenantId,
                pipelineId,
                stationIdx,
                expectedAttempt: claimed.attempt,
                ...generatedPayload,
                privateWebSnapshot: currentPrivateWebSnapshot,
                privateOutputSnapshot: currentPrivateOutputSnapshot,
              });
              persistCompleted = true;
              stationPersistCompleted = true;
              phaseEvent({
                phase: "settle",
                state: "started",
                detail: { source: "delivery_boundary" },
              });
              return persisted;
            },
          });
          if (
            !generateCalled ||
            !persistCalled ||
            !persistCompleted ||
            !generatedPayload
          ) {
            fail(
              "工位交付边界未完成generate→persist契约",
              "CONTENT_PIPELINE_DELIVERY_BOUNDARY_INCOMPLETE",
            );
          }
          const successfulBillingEvidence =
            deliveryResult?.billingEvidence || deliveryResult?.billing;
          const billingEvidence = successfulBillingEvidence
            ? safeValue(successfulBillingEvidence)
            : null;
          if (billingEvidence) {
            repository.attachBillingEvidence({
              tenantId,
              pipelineId,
              stationIdx,
              billingEvidence,
            });
            if (
              billingEvidence.pendingReconciliation === true ||
              billingEvidence.state === "pending_reconciliation"
            ) {
              repository.markBillingPending({
                tenantId,
                pipelineId,
                stationIdx,
                billingEvidence,
                failure: {
                  code: "CONTENT_PIPELINE_BILLING_PENDING_RECONCILIATION",
                  name: "ContentPipelineBillingPendingReconciliation",
                  message:
                    "业务产物已持久化，但预授权尚未完成结算；流水线已停在当前工位等待对账",
                  stationIdx,
                  employeeKey: descriptor.employeeKey,
                  handlerId: descriptor.handlerId,
                  deliveryStage: "settle",
                  failedAt: instant(now),
                },
              });
              return publicPipeline(repository, tenantId, pipelineId);
            }
          } else {
            phaseEvent({
              phase: "settle",
              state: "completed",
              detail: {
                billingPending: false,
                source: "delivery_boundary",
              },
            });
          }
          if (generatedPayload.awaitingApproval) {
            return publicPipeline(repository, tenantId, pipelineId);
          }
          if (
            stationIdx === 9 &&
            typeof repository.finalizeKnowledgeSink === "function"
          ) {
            repository.finalizeKnowledgeSink(tenantId, pipelineId);
          }
          continue;
        } catch (cause) {
          const failure = {
            code: cleanText(
              cause?.code || "CONTENT_PIPELINE_STATION_FAILED",
              160,
            ),
            name: cleanText(cause?.name || "Error", 100),
            message: sanitizeContentRuntimeErrorMessage(
              cause,
              `内容工位${stationIdx}执行失败`,
            ),
            stationIdx,
            employeeKey: descriptor.employeeKey,
            handlerId: descriptor.handlerId,
            deliveryStage:
              cleanText(
                cause?.deliveryStage || cause?.deliveryPhase || "",
                80,
              ) || null,
            failedAt: instant(now),
          };
          if (
            CONTENT_PRODUCTION_PHASES.has(activePhase) &&
            !["failed", "waiting"].includes(activePhaseState)
          ) {
            phaseEvent({
              phase: activePhase,
              state: "failed",
              detail: {
                code: failure.code,
                source: "pipeline_runtime",
              },
            });
          }
          const billingEvidence =
            cause?.billingEvidence ||
            cause?.billing ||
            cause?.deliveryEvidence ||
            null;
          const lifecycleJob = repository.getJob(tenantId, pipelineId);
          if (["paused", "cancelled"].includes(lifecycleJob?.status)) {
            if (
              billingEvidence &&
              typeof repository.attachLifecycleBillingEvidence === "function"
            ) {
              repository.attachLifecycleBillingEvidence({
                tenantId,
                pipelineId,
                stationIdx,
                expectedAttempt: claimed.attempt,
                billingEvidence,
                failure,
              });
            }
            return publicPipeline(repository, tenantId, pipelineId);
          }
          if (stationPersistCompleted) {
            repository.markBillingPending({
              tenantId,
              pipelineId,
              stationIdx,
              failure,
              billingEvidence,
            });
            return publicPipeline(repository, tenantId, pipelineId);
          }
          const preDeliveryBillingPending =
            billingEvidence?.pendingReconciliation === true ||
            ["held", "pending_reconciliation"].includes(
              String(billingEvidence?.state || billingEvidence?.status || ""),
            ) ||
            Number(billingEvidence?.heldCredits || 0) > 0;
          if (preDeliveryBillingPending) {
            repository.markPreDeliveryBillingPending({
              tenantId,
              pipelineId,
              stationIdx,
              expectedAttempt: claimed.attempt,
              failure: {
                ...failure,
                code: "CONTENT_PIPELINE_PRE_DELIVERY_BILLING_PENDING",
                message:
                  "工位未交付产物，但预授权释放失败；已停为待对账，禁止重跑provider",
              },
              handlerEvidence:
                cause?.contentHandlerEvidence ||
                generatedPayload?.handlerEvidence ||
                null,
              contextSnapshot,
              billingEvidence,
              privateWebSnapshot:
                cause?.privateWebSnapshot || currentPrivateWebSnapshot,
            });
            return publicPipeline(repository, tenantId, pipelineId);
          }
          const failureRecorded = repository.recordFailure({
            tenantId,
            pipelineId,
            stationIdx,
            expectedAttempt: claimed.attempt,
            failure,
            handlerEvidence:
              cause?.contentHandlerEvidence ||
              generatedPayload?.handlerEvidence ||
              null,
            contextSnapshot,
            billingEvidence,
            privateWebSnapshot:
              cause?.privateWebSnapshot || currentPrivateWebSnapshot,
          });
          if (!failureRecorded) {
            return publicPipeline(repository, tenantId, pipelineId);
          }
          return publicPipeline(repository, tenantId, pipelineId);
        }
      }
    } finally {
      signal?.removeEventListener?.("abort", forwardAbort);
      if (activeControllers.get(lockKey) === controller) {
        activeControllers.delete(lockKey);
      }
      running.delete(lockKey);
    }
  };

  const pause = ({
    tenantId: rawTenantId,
    pipelineId: rawPipelineId,
    reason = "user_requested",
  } = {}) => {
    const tenantId = positiveInteger(rawTenantId, "tenantId");
    const pipelineId = positiveInteger(rawPipelineId, "pipelineId");
    if (typeof repository.pausePipeline !== "function") {
      fail("流水线仓库未实现暂停", "CONTENT_PIPELINE_PAUSE_UNAVAILABLE", 500);
    }
    const result = repository.pausePipeline({
      tenantId,
      pipelineId,
      reason,
    });
    activeControllers
      .get(`${tenantId}:${pipelineId}`)
      ?.abort(new Error("CONTENT_PIPELINE_PAUSED"));
    return publicPipeline(repository, tenantId, pipelineId) || result;
  };

  const resumePaused = ({
    tenantId: rawTenantId,
    pipelineId: rawPipelineId,
  } = {}) => {
    const tenantId = positiveInteger(rawTenantId, "tenantId");
    const pipelineId = positiveInteger(rawPipelineId, "pipelineId");
    if (typeof repository.resumePausedPipeline !== "function") {
      fail(
        "流水线仓库未实现暂停恢复",
        "CONTENT_PIPELINE_RESUME_PAUSED_UNAVAILABLE",
        500,
      );
    }
    repository.resumePausedPipeline({ tenantId, pipelineId });
    return publicPipeline(repository, tenantId, pipelineId);
  };

  const cancel = ({
    tenantId: rawTenantId,
    pipelineId: rawPipelineId,
    reason = "user_requested",
  } = {}) => {
    const tenantId = positiveInteger(rawTenantId, "tenantId");
    const pipelineId = positiveInteger(rawPipelineId, "pipelineId");
    if (typeof repository.cancelPipeline !== "function") {
      fail("流水线仓库未实现取消", "CONTENT_PIPELINE_CANCEL_UNAVAILABLE", 500);
    }
    activeControllers
      .get(`${tenantId}:${pipelineId}`)
      ?.abort(new Error("CONTENT_PIPELINE_CANCELLED"));
    repository.cancelPipeline({
      tenantId,
      pipelineId,
      reason,
      releaseUndelivered:
        typeof releaseUndeliveredHolds === "function"
          ? releaseUndeliveredHolds
          : null,
    });
    return publicPipeline(repository, tenantId, pipelineId);
  };

  const recoverStale = async ({
    tenantId: rawTenantId,
    source = "scheduler_tick",
    limit = 50,
  } = {}) => {
    const tenantId = positiveInteger(rawTenantId, "tenantId");
    if (typeof repository.listLifecycleCandidates !== "function") return [];
    const outcomes = [];
    for (const candidate of repository.listLifecycleCandidates(tenantId, {
      limit,
    })) {
      const pipelineId = Number(candidate?.job?.id);
      const stationIdx = Number(candidate?.station?.stationIdx);
      try {
        const classification = safeValue(
          (await classifyRecovery({
            tenantId,
            pipelineId,
            stationIdx,
            job: safeValue(candidate.job),
            station: safeValue(candidate.station),
            source,
          })) || { safeToResume: false },
        );
        if (classification.safeToResume !== true) {
          if (
            typeof repository.markPreDeliveryBillingPending === "function" &&
            ["pending", "running", "failed"].includes(candidate.station.status)
          ) {
            repository.markPreDeliveryBillingPending({
              tenantId,
              pipelineId,
              stationIdx,
              expectedAttempt: candidate.station.attempt,
              billingEvidence: {
                state: "pending_reconciliation",
                pendingReconciliation: true,
                heldCredits: Number(classification.heldCredits || 0),
                classification: cleanText(
                  classification.code || "external_state_uncertain",
                  160,
                ),
              },
              failure: {
                code:
                  cleanText(classification.code, 160) ||
                  "CONTENT_PIPELINE_RECOVERY_UNCERTAIN",
                message:
                  cleanText(classification.message, 500) ||
                  "启动恢复发现未结算占扣或外部provider不确定态，已停止自动重放",
                stationIdx,
                failedAt: instant(now),
              },
            });
          }
          outcomes.push({
            tenantId,
            pipelineId,
            stationIdx,
            action: "blocked_pending_reconciliation",
            code: classification.code || null,
          });
          continue;
        }
        if (candidate.station.status === "running") {
          const recovered = repository.recoverInterruptedStation(
            tenantId,
            pipelineId,
            { source },
          );
          if (recovered?.status !== "running") {
            outcomes.push({
              tenantId,
              pipelineId,
              stationIdx,
              action: "retry_limit_reached",
            });
            continue;
          }
        }
        const state = await resume({ tenantId, pipelineId });
        outcomes.push({
          tenantId,
          pipelineId,
          stationIdx,
          action: "resumed_once",
          status: state.status,
        });
      } catch (error) {
        if (error?.code === "CONTENT_PIPELINE_ALREADY_RUNNING") {
          outcomes.push({
            tenantId,
            pipelineId,
            stationIdx,
            action: "already_running_in_process",
          });
          continue;
        }
        outcomes.push({
          tenantId,
          pipelineId,
          stationIdx,
          action: "recovery_failed",
          code: cleanText(error?.code || error?.name, 160) || null,
          error: sanitizeContentRuntimeErrorMessage(
            error,
            "流水线自动恢复失败",
          ),
        });
      }
    }
    return outcomes;
  };

  return Object.freeze({
    schemaVersion: CONTENT_PRODUCTION_PIPELINE_SCHEMA,
    mode: "pipeline",

    create(input = {}) {
      const tenantId = positiveInteger(input.tenantId, "tenantId");
      const createdBy = positiveInteger(input.createdBy, "createdBy");
      const task = {
        ...validatePaihuoContentBrief(input.task || {}),
        // 仅在创建新流水线时写入。repository读取和retry不得给旧task补默认值，
        // 否则旧mix attempt的provider请求指纹会发生漂移。
        visual_policy_version: CONTENT_PRODUCTION_VISUAL_POLICY_VERSION,
      };
      if (
        !isObject(task) ||
        !cleanText(task.direction || task.title || task.requirement)
      ) {
        fail("task至少需要direction、title或requirement", undefined, 400);
      }
      const title = cleanText(input.title || task.title || task.direction, 100);
      if (!title) fail("流水线标题不能为空", undefined, 400);
      const paidMediaAuthorization =
        input.workflow?.paidMediaAuthorization === undefined
          ? undefined
          : validateContentPaidMediaAuthorization(
              input.workflow.paidMediaAuthorization,
              { task, now, ...paidMediaRuntimePricing(task) },
            );
      const pipelineId = repository.createJob({
        tenantId,
        createdBy,
        title,
        task,
        persona: safeValue(input.persona || {}),
        settings: safeValue(input.settings || {}),
        idempotency: normalizePipelineIdempotency(input.idempotency),
        workflow: {
          ...safeValue(input.workflow || {}),
          mode: workflowMode(input.workflow?.mode),
          approvalPolicy: approvalPolicy(input.workflow?.approvalPolicy),
          ...(paidMediaAuthorization ? { paidMediaAuthorization } : {}),
          executionMode: "pipeline",
          stationCount: CONTENT_PRODUCTION_PIPELINE_STATION_COUNT,
          upstreamPolicy: "database_persisted_completed_stations_only",
          upstreamSynthesized: false,
        },
      });
      return publicPipeline(repository, tenantId, pipelineId);
    },

    inspect,
    list,
    findByIdempotency({ tenantId: rawTenantId, idempotency } = {}) {
      const tenantId = positiveInteger(rawTenantId, "tenantId");
      if (typeof repository.findByIdempotency !== "function") return null;
      const job = repository.findByIdempotency(tenantId, idempotency);
      return job ? publicPipeline(repository, tenantId, job.id) : null;
    },
    resume,
    pause,
    resumePaused,
    cancel,
    recoverStale,

    authorizePaidMedia({
      tenantId: rawTenantId,
      pipelineId: rawPipelineId,
      actor,
      policy,
    } = {}) {
      const tenantId = positiveInteger(rawTenantId, "tenantId");
      const pipelineId = positiveInteger(rawPipelineId, "pipelineId");
      const job = repository.getJob(tenantId, pipelineId);
      if (!job) fail("内容生产流水线不存在", "CONTENT_PIPELINE_NOT_FOUND", 404);
      const actorId = positiveInteger(actor?.id, "授权人id");
      const actorRole = cleanText(actor?.role, 64);
      if (!OWNER_APPROVAL_POLICY_ROLES.has(actorRole)) {
        fail(
          "只有老板、管理员或平台超管可以授权付费媒体provider",
          "CONTENT_PAID_MEDIA_AUTHORITY_REQUIRED",
          403,
        );
      }
      const validated = validateContentPaidMediaAuthorization(policy, {
        task: job.task,
        now,
        ...paidMediaRuntimePricing(job.task),
      });
      if (
        validated.authorizedBy.id !== actorId ||
        validated.authorizedBy.role !== actorRole
      ) {
        fail(
          "付费媒体授权人与当前操作账号不一致",
          "CONTENT_PAID_MEDIA_AUTHORITY_REQUIRED",
          403,
        );
      }
      repository.authorizePaidMedia({
        tenantId,
        pipelineId,
        policy: validated,
      });
      return publicPipeline(repository, tenantId, pipelineId);
    },

    async review({
      tenantId: rawTenantId,
      pipelineId: rawPipelineId,
      actor,
      action,
      selection = null,
      resumeAfterApproval = true,
      signal,
    } = {}) {
      const tenantId = positiveInteger(rawTenantId, "tenantId");
      const pipelineId = positiveInteger(rawPipelineId, "pipelineId");
      const job = repository.getJob(tenantId, pipelineId);
      if (!job) fail("内容生产流水线不存在", "CONTENT_PIPELINE_NOT_FOUND", 404);
      if (job.status !== "awaiting_approval" || job.pendingStation === null) {
        fail(
          "流水线当前没有待审阅工位",
          "CONTENT_PIPELINE_NOT_AWAITING_APPROVAL",
        );
      }
      const station = repository.getStation(
        tenantId,
        pipelineId,
        job.pendingStation,
      );
      if (
        station?.stationIdx === 9 &&
        station?.approvalBoundary?.code === "await_metrics"
      ) {
        fail(
          "复盘官正在等待真实发布记录与数值指标，不能用普通审批绕过",
          "CONTENT_PIPELINE_METRICS_REQUIRED",
          422,
        );
      }
      if (
        !station?.output ||
        !station?.handlerEvidence ||
        !station?.approvalBoundary
      ) {
        fail(
          "待审阅工位缺少已持久化产物或handler证据",
          "CONTENT_PIPELINE_APPROVAL_EVIDENCE_MISSING",
        );
      }
      const normalizedAction =
        action === "reject" ? "reject" : action === "approve" ? "adopt" : "";
      if (!normalizedAction)
        fail("action必须是approve或reject", undefined, 400);
      if (station.approvalBoundary.ownerSelectionRequired && !OWNER_APPROVAL_POLICY_ROLES.has(actor?.role)) {
        fail('小红书发布版本只能由老板或管理员选择', 'CONTENT_PIPELINE_XHS_OWNER_REQUIRED', 403);
      }
      const decision = assertContentHandlerApprovalBoundary({
        boundary: station.approvalBoundary,
        action: normalizedAction,
        actor,
        automated: false,
        candidates: candidateList(station.stationIdx, station.output),
        selection,
        runId: pipelineId,
        handlerId: station.handlerId,
        now,
      });
      const output =
        normalizedAction === "adopt"
          ? applySelection(station.stationIdx, station.output, decision)
          : station.output;
      repository.recordReview({
        tenantId,
        pipelineId,
        stationIdx: station.stationIdx,
        decision,
        output,
      });
      if (
        normalizedAction === "adopt" &&
        station.stationIdx === 9 &&
        typeof repository.finalizeKnowledgeSink === "function"
      ) {
        repository.finalizeKnowledgeSink(tenantId, pipelineId);
      }
      if (normalizedAction === "adopt" && resumeAfterApproval) {
        return resume({ tenantId, pipelineId, signal });
      }
      return publicPipeline(repository, tenantId, pipelineId);
    },

    async retry({
      tenantId: rawTenantId,
      pipelineId: rawPipelineId,
      refreshWebEvidence = false,
      signal,
    } = {}) {
      const tenantId = positiveInteger(rawTenantId, "tenantId");
      const pipelineId = positiveInteger(rawPipelineId, "pipelineId");
      const job = repository.getJob(tenantId, pipelineId);
      if (!job) fail("内容生产流水线不存在", "CONTENT_PIPELINE_NOT_FOUND", 404);
      const station = repository.getStation(
        tenantId,
        pipelineId,
        job.currentStation,
      );
      if (!station || station.status !== "failed") {
        fail("只能重试失败工位", "CONTENT_PIPELINE_NOT_FAILED");
      }
      repository.resetFailedStation(tenantId, pipelineId);
      return resume({
        tenantId,
        pipelineId,
        refreshWebEvidence: refreshWebEvidence === true,
        signal,
      });
    },

    submitMetrics({
      tenantId: rawTenantId,
      pipelineId: rawPipelineId,
      actor,
      publication,
      metrics,
      evidenceNote = "",
    } = {}) {
      const tenantId = positiveInteger(rawTenantId, "tenantId");
      const pipelineId = positiveInteger(rawPipelineId, "pipelineId");
      const job = repository.getJob(tenantId, pipelineId);
      if (!job) fail("内容生产流水线不存在", "CONTENT_PIPELINE_NOT_FOUND", 404);
      const entry = normalizePublicationMetricsEntry(
        { publication, metrics, evidenceNote },
        { actor, task: job.task, now },
      );
      const evidence = mergePublicationMetrics(
        job.workflow?.publicationMetrics,
        entry,
        { task: job.task, now },
      );
      repository.submitPublicationMetrics({
        tenantId,
        pipelineId,
        evidence,
        actor,
      });
      return publicPipeline(repository, tenantId, pipelineId);
    },

    recoverInterrupted({
      tenantId: rawTenantId,
      pipelineId: rawPipelineId,
    } = {}) {
      const tenantId = positiveInteger(rawTenantId, "tenantId");
      const pipelineId = positiveInteger(rawPipelineId, "pipelineId");
      repository.recoverInterruptedStation(tenantId, pipelineId);
      return publicPipeline(repository, tenantId, pipelineId);
    },
  });
}
