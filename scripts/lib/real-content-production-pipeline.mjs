import crypto from "node:crypto";

import { CANONICAL_EMPLOYEE_PROFILE_FIELDS } from "../../server/src/engines/canonical-employee-profile.js";
import { CONTENT_HANDLER_ADAPTER_CATALOG } from "../../server/src/engines/content-handler-adapters.js";

export const REAL_CONTENT_PRODUCTION_PIPELINE_ACCEPTANCE_SCHEMA =
  "nanowork.real-content-production-pipeline-acceptance.v1";
export const REAL_CONTENT_PRODUCTION_LINEAGE_SCHEMA =
  "nanowork.content-production-pipeline-lineage/1";

const REAL_MODEL_DENY =
  /(?:mock|template|fallback|fixture|offline|no[-_ ]?network)/iu;
const SELECTION_KEYS = new Set([
  "selection",
  "selected",
  "selected_image",
  "selected_cover",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

export function contentProductionStableFingerprint(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex")}`;
}

function rawHash(value) {
  return contentProductionStableFingerprint(value).slice("sha256:".length);
}

function positive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function check(errors, condition, message) {
  if (!condition) errors.push(message);
}

function sortedStationKeys(value) {
  return Object.keys(isRecord(value) ? value : {}).sort(
    (left, right) => Number(left) - Number(right),
  );
}

function providerOutputView(output) {
  if (!isRecord(output)) return output;
  return Object.fromEntries(
    Object.entries(output).filter(([key]) => !SELECTION_KEYS.has(key)),
  );
}

export function buildRealContentProductionPipelineBrief(nonce) {
  const marker = String(nonce || "").trim();
  if (!/^[a-f0-9-]{20,80}$/iu.test(marker)) {
    throw new Error("0→9真实内容流水线nonce无效");
  }
  return Object.freeze({
    direction: `隔离真实0→9内容流水线-${marker}`,
    template: "完整内容团队流水线",
    industry: "餐饮连锁经营",
    material:
      "已知：营业额100000元、采购入库35000元、订单2000单。可计算采购入库占营业额35%、客单收入50元/单；期初/期末库存、报损、调拨未提供，禁止把35%写成食材成本率。每岗必须使用数据库已持久化的全部真实上游工位产物，未提供事实标记待核验。",
    ref_link: "",
    platforms: Object.freeze(["小红书", "视频号"]),
    image_mode: "ai",
    image_count: 1,
    enable_deck: true,
    xhs_style: Object.freeze({
      name: "老板经营复盘",
      desc: "结论先行、事实与未知分层、动作可执行",
    }),
    dy_style: Object.freeze({
      name: "克制口播",
      desc: "不夸大经营成效，不伪造客户证言或平台数据",
    }),
  });
}

export function contentProductionPickSelection(station) {
  const idx = Number(station?.stationIdx);
  const key = idx === 0 ? "topics" : idx === 5 ? "images" : idx === 6 ? "covers" : null;
  if (!key) return null;
  const candidates = Array.isArray(station?.output?.[key])
    ? station.output[key]
    : [];
  if (!candidates.length) {
    throw new Error(`工位${idx}是pick边界但没有真实候选产物`);
  }
  const first = candidates[0];
  const candidateId = isRecord(first)
    ? first.candidateId ?? first.id ?? first.key ?? first.slug ?? null
    : null;
  // 审批引擎要求candidateIndex与candidateId二选一。索引最稳定，
  // 也不依赖模型是否给候选项生成了额外ID。
  return {
    candidateIndex: 0,
    candidateIdObserved: candidateId == null ? null : String(candidateId),
  };
}

function normalizedAuthority(value) {
  return isRecord(value) ? value : {};
}

export function evaluateRealContentProductionStation({
  pipeline,
  station,
  upstreamOutputs = {},
  mainBilling = null,
  specialProvider = null,
  requireHumanReview = true,
} = {}) {
  const errors = [];
  const idx = Number(station?.stationIdx);
  const descriptor = CONTENT_HANDLER_ADAPTER_CATALOG[idx];
  const evidence = station?.handlerEvidence || {};
  const runtime = evidence?.productionRuntime || {};
  const provider = evidence?.providerDelivery || runtime?.providerDelivery || {};
  const load = evidence?.runtimePackageLoad || station?.contextSnapshot?.runtimePackageLoad || {};
  const canonical = runtime?.canonicalPackage || {};
  const output = station?.output;
  const expectedKeys = descriptor?.outputKeys || [];
  const outputKeys = isRecord(output) ? Object.keys(output) : [];
  const unknownOutputKeys = outputKeys.filter(
    (key) => !expectedKeys.includes(key) && !SELECTION_KEYS.has(key),
  );
  const providerView = providerOutputView(output);
  const expectedUpstreamKeys = sortedStationKeys(upstreamOutputs);
  const contextUpstream = station?.contextSnapshot?.upstream || {};
  const runtimeUpstream = runtime?.upstream || {};
  const expectedUpstreamFingerprint =
    contentProductionStableFingerprint(upstreamOutputs);
  const billing = station?.billingEvidence || {};
  const main = normalizedAuthority(mainBilling);
  const special = isRecord(specialProvider)
    ? specialProvider
    : {
        expected: false,
        attemptCount: 0,
        totalEstimatedCredits: 0,
        totalChargedCredits: 0,
        totalHeldCredits: 0,
        materialCount: 0,
        attempts: [],
      };
  const expectedSpecial = [5, 6].includes(idx);
  const mainComponent = billing?.components?.stationText || billing;
  const approvalAudits = Array.isArray(station?.approvalAudit)
    ? station.approvalAudit
    : [];
  const humanAdoption = approvalAudits.find(
    (item) =>
      item?.action === "adopt" &&
      item?.outcome === "allowed" &&
      item?.automated === false &&
      item?.actor?.actorType === "human" &&
      Number(item?.actor?.actorId) > 0,
  );

  check(errors, pipeline?.mode === "pipeline", "顶层响应不是pipeline语义");
  check(errors, Number(pipeline?.id) > 0, "缺少真实流水线ID");
  check(errors, descriptor?.employeeIdx === idx, `工位${idx}没有锁定handler目录`);
  check(errors, station?.pipelineId === pipeline?.id, `工位${idx}与流水线ID不一致`);
  check(
    errors,
    requireHumanReview
      ? station?.status === "completed" && Boolean(humanAdoption)
      : station?.status === "awaiting_approval",
    requireHumanReview
      ? `工位${idx}没有完成可落账的人工采纳`
      : `工位${idx}不在可审阅终态`,
  );
  check(errors, isRecord(output), `工位${idx}缺少已持久化结构化产物`);
  check(
    errors,
    expectedKeys.every((key) => Object.hasOwn(output || {}, key)) &&
      unknownOutputKeys.length === 0,
    `工位${idx}产物没有精确覆盖岗位outputKeys`,
  );
  check(errors, evidence?.executionMode === "pipeline", `工位${idx}错用了单岗语义`);
  check(errors, evidence?.completed === true, `工位${idx}handler证据未完成`);
  check(errors, evidence?.employeeIdx === idx, `工位${idx}handler员工身份不一致`);
  check(
    errors,
    load?.allRequiredFieldsLoaded === true &&
      load?.fullCanonicalObjectInSystemMessage === true &&
      Array.isArray(load?.loadedFields) &&
      CANONICAL_EMPLOYEE_PROFILE_FIELDS.every((field) =>
        load.loadedFields.includes(field),
      ) &&
      CANONICAL_EMPLOYEE_PROFILE_FIELDS.every(
        (field) => typeof load?.fieldFingerprints?.[field] === "string",
      ) &&
      typeof load?.aggregateFingerprint === "string",
    `工位${idx}没有加载活派同源的canonical 11字段完整包`,
  );
  check(
    errors,
    canonical?.allRequiredFieldsLoaded === true &&
      canonical?.fullCanonicalObjectInSystemMessage === true &&
      canonical?.aggregateFingerprint === load?.aggregateFingerprint &&
      Array.isArray(canonical?.requiredFields) &&
      CANONICAL_EMPLOYEE_PROFILE_FIELDS.every((field) =>
        canonical.requiredFields.includes(field),
      ),
    `工位${idx}真实handler没有证明完整员工包进入system消息`,
  );
  check(
    errors,
    provider?.mode === "api" &&
      provider?.validated === true &&
      !REAL_MODEL_DENY.test(String(provider?.model || "")) &&
      positive(provider?.usage?.inputTokens) &&
      positive(provider?.usage?.outputTokens),
    `工位${idx}缺少非降级真实API与正token证据`,
  );
  check(
    errors,
    provider?.outputFingerprint ===
      contentProductionStableFingerprint(providerView),
    `工位${idx}产物与provider验证指纹不一致`,
  );
  check(
    errors,
    contextUpstream?.synthesized === false &&
      runtimeUpstream?.synthesized === false &&
      JSON.stringify(contextUpstream?.stationKeys || []) ===
        JSON.stringify(expectedUpstreamKeys) &&
      JSON.stringify(runtimeUpstream?.stationKeys || []) ===
        JSON.stringify(expectedUpstreamKeys) &&
      contextUpstream?.fingerprint === expectedUpstreamFingerprint &&
      runtimeUpstream?.fingerprint === expectedUpstreamFingerprint &&
      runtimeUpstream?.source ===
        "database_persisted_completed_stations_only",
    `工位${idx}没有百分之百使用数据库已完成的全部真实上游`,
  );
  if (idx <= 2) {
    check(
      errors,
      runtime?.web?.required === true &&
        runtime?.web?.attempted === true &&
        runtime?.web?.verified === true &&
        Number(runtime?.web?.resultCount) > 0,
      `工位${idx}是强制联网岗但缺少可引用证据`,
    );
  }
  check(
    errors,
    billing?.state === "settled" &&
      billing?.pendingReconciliation === false &&
      Number(billing?.heldCredits || 0) === 0 &&
      positive(billing?.chargedCredits),
    `工位${idx}总账单未完成权威结算`,
  );
  check(
    errors,
    main?.valid === true &&
      main?.state === "settled" &&
      positive(main?.holdId) &&
      positive(main?.logId) &&
      positive(main?.inputTokens) &&
      positive(main?.outputTokens) &&
      main?.aiMode === "api" &&
      mainComponent?.holdId === main.holdId &&
      Number(mainComponent?.estimatedCredits) === Number(main.heldCredits) &&
      Number(mainComponent?.chargedCredits) === Number(main.chargedCredits),
    `工位${idx}正文预授权/流水/模型token没有唯一关联`,
  );
  check(errors, special?.expected === expectedSpecial, `工位${idx}专项provider适用性标记错误`);
  if (expectedSpecial) {
    const attempt = special?.attempts?.[0];
    check(
      errors,
      special?.attemptCount === 1 &&
        special?.materialCount === 1 &&
        attempt?.status === "settled" &&
        attempt?.kind === "image" &&
        attempt?.namespaceStable === true &&
        attempt?.evidenceValid === true &&
        attempt?.delivery?.persisted === true &&
        attempt?.delivery?.artifactCount === 1 &&
        attempt?.materialCount === 1 &&
        positive(attempt?.chargedCredits),
      `工位${idx}没有完整复用真实图片provider能力及素材证据`,
    );
  } else {
    check(
      errors,
      Number(special?.attemptCount || 0) === 0,
      `工位${idx}错误产生了专项provider尝试`,
    );
  }
  const totalEstimated = Number(main?.heldCredits || 0) +
    Number(special?.totalEstimatedCredits || 0);
  const totalCharged = Number(main?.chargedCredits || 0) +
    Number(special?.totalChargedCredits || 0);
  check(
    errors,
    Number(billing?.estimatedCredits) === totalEstimated &&
      Number(billing?.chargedCredits) === totalCharged,
    `工位${idx}总账单漏计正文或专项provider费用`,
  );
  check(
    errors,
    station?.approvalBoundary?.code === descriptor?.approvalBoundary?.code,
    `工位${idx}审批边界与锁定handler不一致`,
  );
  check(
    errors,
    approvalAudits.every(
      (item) => item?.controls?.externalPublishAllowed === false,
    ),
    `工位${idx}审批证据未锁死无外发边界`,
  );

  const pass = errors.length === 0;
  return {
    schemaVersion: REAL_CONTENT_PRODUCTION_PIPELINE_ACCEPTANCE_SCHEMA,
    pass,
    errors,
    stage: {
      domain: "content",
      idx,
      employeeId: `content:${idx}`,
      employeeKey: descriptor?.employeeKey || station?.employeeKey || null,
      employeeName: descriptor?.employeeName || station?.employeeName || null,
      acceptanceKind: "pipeline",
      pipelineApi: true,
      pipelineId: Number(pipeline?.id) || null,
      businessId: Number(pipeline?.id) || null,
      stationAttempt: Number(station?.attempt || 0),
      phase: requireHumanReview ? "reviewed" : "awaiting_review",
      verdict: pass ? "PASS_REAL_API" : "FAIL_REAL_API",
      pass,
      pipelinePass: pass,
      capabilityPass: null,
      businessProductionPass: pass,
      generationStatus: station?.status || null,
      terminalStatus: requireHumanReview ? "已完成" : "待审阅",
      reviewDecision: requireHumanReview ? (humanAdoption ? "adopt" : null) : null,
      reviewActorId: Number(humanAdoption?.actor?.actorId || 0) || null,
      handlerId: station?.handlerId || null,
      handlerExecutionMode: evidence?.executionMode || null,
      contentProfileComplete:
        load?.allRequiredFieldsLoaded === true &&
        canonical?.allRequiredFieldsLoaded === true,
      canonicalAggregateFingerprint: load?.aggregateFingerprint || null,
      outputKeyCount: outputKeys.length,
      expectedOutputKeyCount: expectedKeys.length,
      primaryArtifactHash: isRecord(output) ? rawHash(output) : null,
      primaryArtifactHashValid:
        provider?.outputFingerprint ===
        contentProductionStableFingerprint(providerView),
      primaryArtifactBytes: isRecord(output)
        ? Buffer.byteLength(JSON.stringify(output))
        : 0,
      providerMode: provider?.mode || null,
      providerModel: provider?.model || null,
      providerInputTokens: Number(provider?.usage?.inputTokens || 0),
      providerOutputTokens: Number(provider?.usage?.outputTokens || 0),
      inputTokens: Number(main?.inputTokens || 0),
      outputTokens: Number(main?.outputTokens || 0),
      billingState: billing?.state || null,
      billingId: Number(main?.holdId || 0) || null,
      creditLogId: Number(main?.logId || 0) || null,
      chargedCredits: Number(billing?.chargedCredits || 0),
      heldCredits: Number(billing?.heldCredits || 0),
      specialProviderExpected: expectedSpecial,
      specialProviderAttemptCount: Number(special?.attemptCount || 0),
      specialProviderMaterialCount: Number(special?.materialCount || 0),
      upstreamStationKeys: expectedUpstreamKeys,
      upstreamSetFingerprint: expectedUpstreamFingerprint,
      upstreamSynthesized: contextUpstream?.synthesized !== false,
      lineageValid: idx === 0 ? true : undefined,
      lineageErrors: [],
      externalPublish: false,
      failureReasons: errors,
    },
  };
}

export function buildRealContentProductionLineageEdge({
  pipelineId,
  upstreamStage,
  downstreamStage,
} = {}) {
  return {
    schemaVersion: REAL_CONTENT_PRODUCTION_LINEAGE_SCHEMA,
    pipelineId: Number(pipelineId),
    fromIdx: Number(upstreamStage?.idx),
    toIdx: Number(downstreamStage?.idx),
    sourceOutputFingerprint: `sha256:${String(
      upstreamStage?.primaryArtifactHash || "",
    )}`,
    downstreamUpstreamFingerprint:
      downstreamStage?.upstreamSetFingerprint || null,
    downstreamStationKeys: Array.isArray(downstreamStage?.upstreamStationKeys)
      ? [...downstreamStage.upstreamStationKeys]
      : [],
    source: "database_persisted_completed_stations_only",
    upstreamSynthesized: downstreamStage?.upstreamSynthesized === true,
    verified: true,
  };
}
