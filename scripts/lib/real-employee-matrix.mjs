import crypto from "node:crypto";
import {
  assessRestaurantTaskCompleteness,
  buildRestaurantInputFacts,
  restaurantInputFactSpecs,
  validateRestaurantInputFacts,
} from "./restaurant-required-input-facts.mjs";
import { augmentRestaurantOperationalFixtures101To130 } from "./restaurant-operational-fixtures-101-130.mjs";
import { augmentRestaurantOperationalMaterialEvidence } from "./restaurant-operational-fixtures-131-161.mjs";
import {
  buildUnifiedAcceptancePlan,
  isSingleSentenceDemand,
} from "./real-acceptance-gates.mjs";

const FORBIDDEN_PROVIDER =
  /(?:mock|template|fallback|fixture|offline|no[-_ ]?network)/iu;

export const REAL_MATRIX_SCHEMA = "nanowork.real-employee-matrix.v2";
export const LEGACY_REAL_MATRIX_SCHEMA = "nanowork.real-employee-matrix.v1";
// The restaurant provider can legally consume its full 45-minute wall-clock
// budget (three 15-minute candidate/transport windows). The runner must wait
// longer than the provider, then leave enough time to read billing, review the
// output and persist the checkpoint instead of timing out a still-running job.
export const REAL_MATRIX_DEFAULT_JOB_TIMEOUT_MS = 3_600_000;
export const RESTAURANT_INDEXES = Object.freeze(
  Array.from({ length: 61 }, (_, offset) => offset + 101),
);
export const CONTENT_INDEXES = Object.freeze(
  // Capability coverage includes the native NanoWork AI 带货员 (idx=10).
  // Keep the independent 0→9 production pipeline separate: that workflow is
  // intentionally ten stages and must not grow a synthetic eleventh station.
  Array.from({ length: 11 }, (_, index) => index),
);
export const CONTENT_PIPELINE_INDEXES = Object.freeze(
  Array.from({ length: 10 }, (_, index) => index),
);
export const CONTENT_PIPELINE_STAGE_COUNT = CONTENT_PIPELINE_INDEXES.length;

const SHA256_HEX = /^[a-f0-9]{64}$/u;

function normalizedSha256(value) {
  const hash = String(value || "").trim().toLowerCase();
  return SHA256_HEX.test(hash) ? hash : null;
}

/**
 * Report-first restaurant deliveries intentionally persist readable Markdown
 * instead of the intermediate employee JSON.  The matrix runner must branch
 * before invoking the structured JSON validator, otherwise a valid
 * `parsedOutput: null` delivery is turned into a systematic false negative.
 */
export function isRestaurantMatrixReportFirstContract(contract) {
  const qualityMode = String(contract?.qualityMode || "").trim();
  return (
    contract?.reportFirstMarkdown === true &&
    (qualityMode === "report_first" ||
      qualityMode === "paihuo_markdown" ||
      contract?.deliveryStyle === "paihuo_markdown")
  );
}

/**
 * Resolve the semantic and hash evidence consumed by the real employee
 * matrix.  Structured deliveries continue to use the independently parsed
 * artifact.  Report-first deliveries use the server-persisted Markdown hash
 * chain (DB body -> rendered body -> primary artifact -> provider response)
 * plus the hard-delivery decision; they never manufacture JSON from Markdown.
 */
export function evaluateRestaurantMatrixOutputEvidence({
  contract = null,
  outputBody = "",
  structuredSemantic = null,
} = {}) {
  const reportFirst = isRestaurantMatrixReportFirstContract(contract);
  const body = String(outputBody || "");
  const resultHash = body
    ? crypto.createHash("sha256").update(body).digest("hex")
    : null;
  const artifacts = Array.isArray(contract?.artifacts)
    ? contract.artifacts
    : [];
  const serverPrimaryArtifact = artifacts.find(
    (item) => item?.primary === true,
  );
  const serverArtifactHash = normalizedSha256(
    serverPrimaryArtifact?.contentSha256,
  );
  const serverProviderResponseHash = normalizedSha256(
    contract?.providerResponseSha256,
  );
  const serverRenderedBodyHash = normalizedSha256(
    contract?.renderedBodySha256,
  );

  const reportFirstSemanticErrors = [];
  if (reportFirst) {
    if (contract?.valid !== true) {
      reportFirstSemanticErrors.push("report-first输出契约未通过");
    }
    if (contract?.parsedOutput != null) {
      reportFirstSemanticErrors.push(
        "report-first交付不应声称存在结构化parsedOutput",
      );
    }
    if (
      contract?.qualityMode === "report_first" &&
      contract?.structuredReportFirst !== true
    ) {
      reportFirstSemanticErrors.push("缺少structuredReportFirst权威标记");
    }
    if (
      contract?.hardDelivery?.valid !== true ||
      (Array.isArray(contract?.hardDelivery?.errors) &&
        contract.hardDelivery.errors.length > 0)
    ) {
      reportFirstSemanticErrors.push(
        ...(
          Array.isArray(contract?.hardDelivery?.errors) &&
          contract.hardDelivery.errors.length > 0
            ? contract.hardDelivery.errors
            : ["report-first最终交付硬门未通过"]
        ).map(String),
      );
    }
    if (!body.trim()) {
      reportFirstSemanticErrors.push("report-first报告正文为空");
    }
    if (
      serverPrimaryArtifact &&
      String(serverPrimaryArtifact.kind || "").trim() !== "markdown"
    ) {
      reportFirstSemanticErrors.push("report-first主产物不是Markdown");
    }
  }

  const semanticValid = reportFirst
    ? reportFirstSemanticErrors.length === 0
    : structuredSemantic?.valid === true;
  const semanticErrors = semanticValid
    ? []
    : reportFirst
      ? [...new Set(reportFirstSemanticErrors)]
      : Array.isArray(structuredSemantic?.errors)
        ? structuredSemantic.errors.map(String)
        : ["结构化岗位输出语义契约未通过"];

  let localArtifactHash = null;
  let artifactHashValid = false;
  let artifactHashSource = "structured_local_artifact";
  const artifactHashErrors = [];
  if (reportFirst) {
    artifactHashSource = "authoritative_report_first_chain";
    const authoritativeHashes = [
      ["output_body", resultHash],
      ["renderedBodySha256", serverRenderedBodyHash],
      ["primaryArtifact.contentSha256", serverArtifactHash],
      ["providerResponseSha256", serverProviderResponseHash],
    ];
    for (const [field, hash] of authoritativeHashes) {
      if (!hash) artifactHashErrors.push(`${field}缺少有效sha256`);
    }
    if (
      artifactHashErrors.length === 0 &&
      authoritativeHashes.some(([, hash]) => hash !== resultHash)
    ) {
      for (const [field, hash] of authoritativeHashes.slice(1)) {
        if (hash !== resultHash) {
          artifactHashErrors.push(`${field}与报告正文sha256不一致`);
        }
      }
    }
    artifactHashValid = artifactHashErrors.length === 0;
  } else {
    const localPrimaryArtifact = Array.isArray(structuredSemantic?.artifacts)
      ? structuredSemantic.artifacts.find((item) => item?.primary === true)
      : null;
    localArtifactHash = localPrimaryArtifact?.content
      ? crypto
          .createHash("sha256")
          .update(localPrimaryArtifact.content)
          .digest("hex")
      : null;
    if (!localArtifactHash) {
      artifactHashErrors.push("结构化本地主产物缺少有效sha256");
    }
    if (!serverArtifactHash) {
      artifactHashErrors.push("primaryArtifact.contentSha256缺失");
    }
    if (!serverProviderResponseHash) {
      artifactHashErrors.push("providerResponseSha256缺失");
    }
    if (
      localArtifactHash &&
      serverArtifactHash &&
      localArtifactHash !== serverArtifactHash
    ) {
      artifactHashErrors.push("结构化本地主产物与服务端主产物sha256不一致");
    }
    if (
      localArtifactHash &&
      serverProviderResponseHash &&
      localArtifactHash !== serverProviderResponseHash
    ) {
      artifactHashErrors.push("结构化本地主产物与provider响应sha256不一致");
    }
    artifactHashValid = artifactHashErrors.length === 0;
  }

  return {
    reportFirst,
    qualityMode: contract?.qualityMode || null,
    reportFirstMarkdown: contract?.reportFirstMarkdown === true,
    structuredReportFirst: contract?.structuredReportFirst === true,
    hardDeliveryValid: contract?.hardDelivery?.valid === true,
    semanticValid,
    semanticErrors,
    analysisProduced: reportFirst
      ? semanticValid && body.trim().length > 0
      : semanticValid &&
        contract?.parsedOutput &&
        typeof contract.parsedOutput === "object" &&
        !Array.isArray(contract.parsedOutput) &&
        Object.keys(contract.parsedOutput).length > 0,
    resultHash,
    resultHashValid:
      Boolean(resultHash) && resultHash === serverRenderedBodyHash,
    localArtifactHash,
    serverArtifactHash,
    serverProviderResponseHash,
    serverRenderedBodyHash,
    artifactHashValid,
    artifactHashSource,
    artifactHashErrors: [...new Set(artifactHashErrors)],
  };
}

/** Keep the complete original requirement attached to the unified gate. */
export function buildRestaurantMatrixGateDispatch({
  pending = null,
  attempt = null,
} = {}) {
  return {
    requirement: String(pending?.requirement || ""),
    acceptanceDemand: String(attempt?.acceptanceDemand || ""),
  };
}

export function isLoopbackServiceBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ["127.0.0.1", "localhost", "::1"].includes(hostname)
    );
  } catch {
    return false;
  }
}

export function isOfficialYunwuBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!url.port || url.port === "443") &&
      (hostname === "yunwu.ai" || hostname.endsWith(".yunwu.ai")) &&
      (url.pathname === "/v1" || url.pathname.startsWith("/v1/"))
    );
  } catch {
    return false;
  }
}

const TESTED_DEFAULT_PROVIDER_PRICING = Object.freeze({
  pricingSource: "runner_tested_default_billing_snapshot",
  pricingVersion: "server-credits-default-2026-07-31",
  currency: "CNY",
  unit: "yuan_per_million_tokens",
  models: Object.freeze({
    "gpt-5.5": Object.freeze({
      inputYuanPerMillion: 30,
      outputYuanPerMillion: 60,
    }),
    "gemini-3.1-flash-lite": Object.freeze({
      inputYuanPerMillion: 2.5,
      outputYuanPerMillion: 7.5,
    }),
    "deepseek-v4-flash": Object.freeze({
      inputYuanPerMillion: 5,
      outputYuanPerMillion: 5,
    }),
    "claude-opus-4-8": Object.freeze({
      inputYuanPerMillion: 36,
      outputYuanPerMillion: 180,
    }),
  }),
});

export const REAL_MATRIX_COST_SEMANTICS = Object.freeze({
  version: 2,
  providerEstimatedCostYuan:
    "按真实provider token和有来源的模型价快照估算；未知价格必须为null，不能写0",
  chargedCostYuan: "客户账本实际结算人民币金额",
  chargedCredits: "客户账本实际结算积分",
  qualityGateRefunded: "质量门失败且预授权已全额退回",
  fullRefund: "已验证的全额退款；不代表供应商调用没有成本",
  current:
    "当前结果口径：每个岗位只取latest；用于判断当前72岗（61餐饮+11内容）通过/失败与当前账务投影",
  cumulative:
    "累计调用口径：遍历jobs[*].attempts并按attemptId去重；provider调用/usage/估算成本累加，客户实扣按权威hold+log去重",
  legacyFields: Object.freeze({
    costYuan: Object.freeze({
      deprecated: true,
      aliasOf: "chargedCostYuan",
    }),
    credits: Object.freeze({
      deprecated: true,
      aliasOf: "chargedCredits",
    }),
  }),
});

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeProviderRate(value) {
  const inputYuanPerMillion = finiteNonNegative(
    value?.inputYuanPerMillion ?? value?.in,
  );
  const outputYuanPerMillion = finiteNonNegative(
    value?.outputYuanPerMillion ?? value?.out,
  );
  if (inputYuanPerMillion == null || outputYuanPerMillion == null) return null;
  return { inputYuanPerMillion, outputYuanPerMillion };
}

export function createProviderPricingSnapshot(
  billingConfig = {},
  {
    pricingSource = "runtime_api_config.billing.text",
    pricingVersion = null,
    capturedAt = null,
  } = {},
) {
  const source =
    billingConfig?.text && typeof billingConfig.text === "object"
      ? billingConfig.text
      : billingConfig;
  const models = {};
  if (source && typeof source === "object" && !Array.isArray(source)) {
    for (const [model, rawRate] of Object.entries(source)) {
      // 服务端的default是内部兜底，不足以证明未知供应商模型的实际价格。
      if (!model || model === "default") continue;
      const rate = normalizeProviderRate(rawRate);
      if (rate) models[model] = rate;
    }
  }
  if (!Object.keys(models).length) return null;
  return {
    pricingSource: String(pricingSource || "runtime_api_config.billing.text"),
    pricingVersion: pricingVersion == null ? null : String(pricingVersion),
    capturedAt: capturedAt == null ? null : String(capturedAt),
    currency: "CNY",
    unit: "yuan_per_million_tokens",
    models,
  };
}

function providerUsageTokens(row, providerField, legacyField) {
  const source = Object.hasOwn(row, providerField)
    ? row[providerField]
    : row[legacyField];
  const parsed = finiteNonNegative(source);
  return parsed == null ? 0 : Math.floor(parsed);
}

function webResearchUsageValue(value, snakeCase) {
  const direct = finiteNonNegative(value);
  if (direct != null) return direct;
  return finiteNonNegative(snakeCase);
}

/**
 * Reduce the web/agentic research snapshot to cost evidence without copying
 * URLs, prompts, page text, headers, or other provider payloads into the
 * matrix report.  Agentic WebSearch reports usage and cost in USD; the final
 * text provider estimate remains a separate CNY value and is never silently
 * converted with an invented exchange rate.
 */
export function summarizeWebResearchEvidence(web = null) {
  const channels = Array.isArray(web?.channels) ? web.channels : [];
  const channelRows = channels.map((channel) => {
    const evidence = channel?.evidence && typeof channel.evidence === "object"
      ? channel.evidence
      : {};
    const usage = evidence.usage && typeof evidence.usage === "object"
      ? evidence.usage
      : {};
    const inputTokens = Math.floor(
      webResearchUsageValue(usage.inputTokens, usage.input_tokens) || 0,
    );
    const outputTokens = Math.floor(
      webResearchUsageValue(usage.outputTokens, usage.output_tokens) || 0,
    );
    const cacheReadInputTokens = Math.floor(
      webResearchUsageValue(
        usage.cacheReadInputTokens,
        usage.cache_read_input_tokens,
      ) || 0,
    );
    const rawCostUsd = webResearchUsageValue(evidence.costUsd, evidence.cost_usd);
    return {
      kind: String(channel?.kind || "unknown").slice(0, 80),
      provider: String(channel?.provider || evidence.provider || "").slice(0, 160) || null,
      attempted: channel?.attempted === true,
      ok: channel?.ok === true,
      externalCall: evidence.externalCall === true,
      usage: { inputTokens, outputTokens, cacheReadInputTokens },
      costUsd: rawCostUsd == null ? null : roundedYuan(rawCostUsd),
    };
  });
  const usageRows = channelRows.filter((row) =>
    row.usage.inputTokens + row.usage.outputTokens + row.usage.cacheReadInputTokens > 0,
  );
  const pricedRows = usageRows.filter((row) => row.costUsd != null);
  const summarizeRows = (rows) => ({
    channelCount: rows.length,
    inputTokens: rows.reduce((sum, row) => sum + row.usage.inputTokens, 0),
    outputTokens: rows.reduce((sum, row) => sum + row.usage.outputTokens, 0),
    cacheReadInputTokens: rows.reduce(
      (sum, row) => sum + row.usage.cacheReadInputTokens,
      0,
    ),
    usageRows: rows.length,
    pricedRows: rows.filter((row) => row.costUsd != null).length,
    costUsd:
      rows.length > 0 && rows.every((row) => row.costUsd != null)
        ? roundedYuan(rows.reduce((sum, row) => sum + Number(row.costUsd || 0), 0))
        : null,
    costCurrency: "USD",
    costComplete: rows.length > 0 && rows.every((row) => row.costUsd != null),
  });
  const agenticRows = channelRows.filter(
    (row) => row.kind === "agentic_web_research",
  );
  const attempted = channelRows.some((row) => row.attempted);
  const ok = channelRows.some((row) => row.ok);
  return {
    schema: "nanowork.web-research-cost.v1",
    attempted,
    ok,
    channels: channelRows,
    agenticWebResearch: summarizeRows(agenticRows),
    allResearchChannels: summarizeRows(usageRows),
    // Aliases make the report self-describing while preserving the exact
    // source split: this USD amount is not the final model's CNY estimate.
    usage: summarizeRows(agenticRows),
    costUsd:
      agenticRows.length > 0 && agenticRows.every((row) => row.costUsd != null)
        ? roundedYuan(agenticRows.reduce((sum, row) => sum + Number(row.costUsd || 0), 0))
        : null,
    costCurrency: "USD",
    usageRows: usageRows.length,
    pricedRows: pricedRows.length,
    costComplete:
      agenticRows.length > 0 && agenticRows.every((row) => row.costUsd != null),
  };
}

function webResearchAggregate(rows) {
  const evidence = rows
    .map((row) => row?.webResearchEvidence)
    .filter((item) => item && typeof item === "object");
  const usageRows = evidence
    .map((item) => item.agenticWebResearch || item.usage || null)
    .filter((item) => item && typeof item === "object");
  const pricedRows = usageRows.filter((item) => finiteNonNegative(item.costUsd) != null);
  return {
    attempts: evidence.length,
    inputTokens: usageRows.reduce((sum, item) => sum + Number(item.inputTokens || 0), 0),
    outputTokens: usageRows.reduce((sum, item) => sum + Number(item.outputTokens || 0), 0),
    cacheReadInputTokens: usageRows.reduce(
      (sum, item) => sum + Number(item.cacheReadInputTokens || 0),
      0,
    ),
    usageRows: usageRows.length,
    pricedRows: pricedRows.length,
    costUsd:
      usageRows.length > 0 && usageRows.every((item) => finiteNonNegative(item.costUsd) != null)
        ? roundedYuan(usageRows.reduce((sum, item) => sum + Number(item.costUsd || 0), 0))
        : null,
    costCurrency: "USD",
    costComplete:
      usageRows.length > 0 && usageRows.every((item) => finiteNonNegative(item.costUsd) != null),
  };
}

function providerPricingFor(model, pricingSnapshot) {
  const explicitRate = normalizeProviderRate(pricingSnapshot?.models?.[model]);
  if (explicitRate) {
    return {
      ...explicitRate,
      pricingSource: String(
        pricingSnapshot.pricingSource || "explicit_provider_pricing_snapshot",
      ),
      pricingVersion:
        pricingSnapshot.pricingVersion == null
          ? null
          : String(pricingSnapshot.pricingVersion),
    };
  }
  const testedRate = normalizeProviderRate(
    TESTED_DEFAULT_PROVIDER_PRICING.models[model],
  );
  if (!testedRate) return null;
  return {
    ...testedRate,
    pricingSource: TESTED_DEFAULT_PROVIDER_PRICING.pricingSource,
    pricingVersion: TESTED_DEFAULT_PROVIDER_PRICING.pricingVersion,
  };
}

function roundedYuan(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Adds reporting-only cost semantics. It never changes server billing and never
 * treats a zero customer charge as proof that the provider call cost zero.
 */
export function applyProviderCostSemantics(row = {}, pricingSnapshot = null) {
  const model = text(row.providerModel || row.model);
  const inputTokens = providerUsageTokens(
    row,
    "providerInputTokens",
    "inputTokens",
  );
  const outputTokens = providerUsageTokens(
    row,
    "providerOutputTokens",
    "outputTokens",
  );
  const pricing = model ? providerPricingFor(model, pricingSnapshot) : null;
  const hasProviderUsage = inputTokens + outputTokens > 0;
  const providerEstimatedCostYuan =
    pricing && hasProviderUsage
      ? roundedYuan(
          (inputTokens * pricing.inputYuanPerMillion +
            outputTokens * pricing.outputYuanPerMillion) /
            1_000_000,
        )
      : null;
  const explicitChargedCost = Object.hasOwn(row, "chargedCostYuan")
    ? finiteNonNegative(row.chargedCostYuan)
    : null;
  const legacyChargedCost = Object.hasOwn(row, "costYuan")
    ? finiteNonNegative(row.costYuan)
    : null;
  const chargedCostYuan = explicitChargedCost ?? legacyChargedCost;
  const estimated = providerEstimatedCostYuan != null;
  const qualityGateRefunded =
    typeof row.qualityGateRefunded === "boolean"
      ? row.qualityGateRefunded
      : classifyProviderEvidence(row).qualityGateRefunded;
  const fullRefund = row.fullRefund === true || qualityGateRefunded === true;
  return {
    ...row,
    providerEstimatedCostYuan,
    providerCostEstimate: {
      estimated,
      pricingSource: estimated ? pricing.pricingSource : null,
      pricingVersion: estimated ? pricing.pricingVersion : null,
      currency: "CNY",
      unit: "yuan_per_million_tokens",
      model: model || null,
      inputYuanPerMillion: estimated ? pricing.inputYuanPerMillion : null,
      outputYuanPerMillion: estimated ? pricing.outputYuanPerMillion : null,
      unavailableReason: estimated
        ? null
        : hasProviderUsage
          ? "model_price_unknown"
          : "provider_usage_unavailable",
    },
    chargedCostYuan,
    // 兼容旧报告读取方；costYuan从未表示供应商云成本。
    costYuan: chargedCostYuan,
    costYuanDeprecated: true,
    costYuanDeprecatedMeaning: "alias_of_chargedCostYuan_customer_ledger",
    qualityGateRefunded,
    fullRefund,
    refundState: fullRefund
      ? "full_quality_gate_refund"
      : row.refundState || "unverified",
  };
}

function moneyForCli(value) {
  const parsed = finiteNonNegative(value);
  if (parsed == null) return "unknown";
  return parsed.toFixed(6).replace(/\.?0+$/u, "");
}

export function formatAttemptCostForCli(row = {}) {
  const inputTokens = providerUsageTokens(
    row,
    "providerInputTokens",
    "inputTokens",
  );
  const outputTokens = providerUsageTokens(
    row,
    "providerOutputTokens",
    "outputTokens",
  );
  const providerCost =
    row.providerCostEstimate?.estimated === true &&
    finiteNonNegative(row.providerEstimatedCostYuan) != null
      ? `providerEstimatedCost≈¥${moneyForCli(row.providerEstimatedCostYuan)}`
      : "providerEstimatedCost=unknown";
  const chargedCost = finiteNonNegative(row.chargedCostYuan);
  const customerCharge =
    chargedCost == null
      ? "customerCharge=unknown"
      : `customerCharge=¥${moneyForCli(chargedCost)}/${Number(row.chargedCredits) || 0} credits`;
  const refund =
    row.fullRefund === true
      ? "refund=full(quality_gate)"
      : row.refundState === "none"
        ? "refund=none"
        : "refund=unverified";
  const webResearch = row.webResearchEvidence?.agenticWebResearch || row.webResearchEvidence?.usage || {};
  const webCost = finiteNonNegative(webResearch.costUsd);
  const webUsage = `${Number(webResearch.inputTokens) || 0}+${Number(webResearch.outputTokens) || 0}`;
  return `providerUsage=${inputTokens}+${outputTokens} ${providerCost} webResearchUsage=${webUsage} webResearchCostUsd=${webCost == null ? "unknown" : moneyForCli(webCost)} ${customerCharge} ${refund}`;
}

export function formatSummaryCostForCli(summary = {}) {
  const formatScope = (scope, fallback = {}) => {
    const providerUsage = scope?.providerUsage || fallback.providerUsage || {};
    const coverage =
      scope?.providerEstimatedCostCoverage ||
      fallback.providerEstimatedCostCoverage ||
      {};
    const estimatedCost =
      scope?.providerEstimatedCostYuan ?? fallback.providerEstimatedCostYuan;
    const providerCost =
      coverage.complete === true && finiteNonNegative(estimatedCost) != null
        ? `providerEstimatedCost≈¥${moneyForCli(estimatedCost)}`
        : `providerEstimatedCost=unknown(priced=${Number(coverage.pricedRows) || 0}/${Number(coverage.providerUsageRows) || 0})`;
    const ledger = scope?.customerLedger || {};
    const chargedCost = Object.hasOwn(ledger, "chargedCostYuan")
      ? ledger.chargedCostYuan
      : fallback.chargedCostYuan;
    const chargedCredits = Object.hasOwn(ledger, "chargedCredits")
      ? ledger.chargedCredits
      : fallback.chargedCredits;
    const customerCharge =
      finiteNonNegative(chargedCost) == null ||
      finiteNonNegative(chargedCredits) == null
        ? "customerCharge=unknown"
        : `customerCharge=¥${moneyForCli(chargedCost)}/${Number(chargedCredits)} credits`;
    const web = scope?.webResearch || fallback.webResearch || {};
    const webCost = finiteNonNegative(web.costUsd);
    return [
      `providerAttempts=${Number(scope?.providerAttemptCount) || 0}`,
      `providerUsage=${Number(providerUsage.inputTokens ?? providerUsage.input) || 0}+${Number(providerUsage.outputTokens ?? providerUsage.output) || 0}`,
      providerCost,
      `webResearchUsage=${Number(web.inputTokens) || 0}+${Number(web.outputTokens) || 0}`,
      `webResearchCostUsd=${webCost == null ? "unknown" : moneyForCli(webCost)}`,
      customerCharge,
      `qualityGateFullRefunds=${Number(ledger.fullRefundCount ?? fallback.fullRefundCount) || 0}`,
    ].join(" ");
  };
  return [
    `current(${formatScope(summary.current, summary)})`,
    `cumulative(${formatScope(summary.cumulative, {
      providerUsage:
        summary.cumulativeProviderUsage || summary.providerUsage,
      providerEstimatedCostYuan:
        summary.cumulativeProviderEstimatedCostYuan ??
        summary.providerEstimatedCostYuan,
      providerEstimatedCostCoverage:
        summary.cumulative?.providerEstimatedCostCoverage ||
        summary.providerEstimatedCostCoverage,
      chargedCostYuan:
        summary.cumulativeChargedCostYuan ?? summary.chargedCostYuan,
      chargedCredits:
        summary.cumulativeChargedCredits ?? summary.chargedCredits,
      fullRefundCount:
        summary.cumulative?.customerLedger?.fullRefundCount ??
        summary.fullRefundCount,
      webResearch:
        summary.cumulative?.webResearch || summary.cumulativeWebResearch,
    })})`,
  ].join(" ");
}

export function employeeKey(domain, idx) {
  return `${domain}:${Number(idx)}`;
}

export function parsePositiveInteger(
  value,
  fallback,
  { min = 1, max = Number.MAX_SAFE_INTEGER } = {},
) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

export function parseOnlyFilter(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const selected = new Set();
  for (const part of text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const match = part.match(/^(restaurant|content):(\d+)$/u);
    if (!match) throw new Error(`--only包含无效岗位：${part}`);
    const domain = match[1];
    const idx = Number(match[2]);
    const valid =
      domain === "restaurant" ? idx >= 101 && idx <= 161 : idx >= 0 && idx <= 10;
    if (!valid) throw new Error(`--only岗位越界：${part}`);
    selected.add(employeeKey(domain, idx));
  }
  return selected;
}

export function buildJobs(only = null) {
  return [
    ...RESTAURANT_INDEXES.map((idx) => ({
      domain: "restaurant",
      idx,
      key: employeeKey("restaurant", idx),
    })),
    ...CONTENT_INDEXES.map((idx) => ({
      domain: "content",
      idx,
      key: employeeKey("content", idx),
    })),
  ].filter((job) => !only || only.has(job.key));
}

export function mergeRunSelection(
  state,
  {
    baseUrl,
    selectedJobs,
    concurrency,
    force = false,
    retryFailures = true,
    invocationId,
    startedAt = new Date().toISOString(),
  } = {},
) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("矩阵断点状态必须是对象");
  }
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/u, "");
  const previousBaseUrl = String(state.run?.baseUrl || "").replace(/\/+$/u, "");
  if (
    previousBaseUrl &&
    normalizedBaseUrl &&
    previousBaseUrl !== normalizedBaseUrl
  ) {
    throw new Error(`断点文件属于不同服务：${previousBaseUrl}`);
  }
  const currentSelection = [
    ...new Set((Array.isArray(selectedJobs) ? selectedJobs : []).map(String)),
  ];
  const knownKeys = new Set(buildJobs().map((job) => job.key));
  const invalidKeys = currentSelection.filter((key) => !knownKeys.has(key));
  if (invalidKeys.length)
    throw new Error(`断点岗位范围无效：${invalidKeys.join(",")}`);
  const accumulatedSelection = [
    ...new Set([
      ...(Array.isArray(state.run?.selectedJobs)
        ? state.run.selectedJobs.map(String)
        : []),
      ...currentSelection,
    ]),
  ].sort((left, right) => {
    const [leftDomain, leftIdx] = left.split(":");
    const [rightDomain, rightIdx] = right.split(":");
    if (leftDomain !== rightDomain) return leftDomain === "restaurant" ? -1 : 1;
    return Number(leftIdx) - Number(rightIdx);
  });
  const invocation = {
    id: String(invocationId || crypto.randomUUID()),
    startedAt,
    selectedJobs: currentSelection,
    concurrency: Number(concurrency) || 1,
    force: force === true,
    retryFailures: retryFailures !== false,
    executedJobs: [],
    resumedJobs: [],
    skippedJobs: [],
  };
  state.run = {
    ...(state.run || {}),
    baseUrl: normalizedBaseUrl || previousBaseUrl,
    selectedJobs: accumulatedSelection,
    currentSelection,
    concurrency: Number(concurrency) || Number(state.run?.concurrency) || 1,
    invocations: [
      ...(Array.isArray(state.run?.invocations) ? state.run.invocations : []),
      invocation,
    ],
  };
  state.pipeline ||= {
    enabled: false,
    mode: "sequential_0_to_9",
    stages: {},
    edges: [],
  };
  const pipelineRequested = CONTENT_PIPELINE_INDEXES.every((idx) =>
    currentSelection.includes(employeeKey("content", idx)),
  );
  state.pipeline.enabled = state.pipeline.enabled === true || pipelineRequested;
  state.pipeline.runRequested = pipelineRequested;
  return state;
}

export function validateAttemptInvocation(state, attempt) {
  const errors = [];
  const invocationId = text(attempt?.invocationId);
  const invocation = (
    Array.isArray(state?.run?.invocations) ? state.run.invocations : []
  ).find((item) => String(item?.id || "") === invocationId);
  if (!invocationId) errors.push("任务证据缺少运行批次ID");
  if (!invocation) errors.push("任务证据找不到对应运行批次");
  if (
    !invocation?.runtimeEvidence ||
    invocation.runtimeEvidence.available !== true ||
    !/云雾|yunwu/iu.test(String(invocation.runtimeEvidence.provider || ""))
  ) {
    errors.push("运行批次缺少云雾API就绪证据");
  }
  if (!Number.isFinite(Date.parse(String(attempt?.dispatchedAt || "")))) {
    errors.push("任务证据缺少有效派活时间");
  }
  if (!text(attempt?.attemptId)) errors.push("任务证据缺少唯一attemptId");
  return { valid: errors.length === 0, errors, invocation: invocation || null };
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

const PROVIDER_FAILURE_SUMMARIES = Object.freeze({
  provider_timeout: "供应商响应超时",
  provider_auth_failed: "供应商鉴权失败",
  provider_rate_limited: "供应商请求受限",
  provider_upstream_error: "供应商服务暂时异常",
  provider_request_failed: "供应商拒绝本次请求",
  provider_unavailable: "云雾供应商当前不可用",
  provider_non_api: "供应商未返回真实API结果",
  provider_error: "供应商调用失败",
  CONTENT_EMPLOYEE_EMPTY_OUTPUT: "内容员工未返回正文",
  CONTENT_EMPLOYEE_TEMPLATE_ONLY: "内容员工未取得真实API结果",
  CONTENT_EMPLOYEE_REAL_OUTPUT_REQUIRED: "内容员工真实API证据不完整",
  CONTENT_EMPLOYEE_CONTRACT_INVALID: "内容员工输出契约未通过",
  CONTENT_EMPLOYEE_QUALITY_RETRY_CALL_FAILED: "内容员工质检返工调用失败",
});

const PROVIDER_SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;
const PROVIDER_SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,119}$/u;
const PROVIDER_SENSITIVE_TEXT =
  /(?:https?:\/\/|\bsk-[A-Za-z0-9_-]{4,}|api[_-]?key|authorization|bearer\s+)/iu;

function providerIdentifier(value) {
  const normalized = String(value ?? "").trim();
  return PROVIDER_SAFE_IDENTIFIER.test(normalized) ? normalized : null;
}

function providerModel(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || PROVIDER_SENSITIVE_TEXT.test(normalized)) return null;
  return PROVIDER_SAFE_MODEL.test(normalized) ? normalized : null;
}

function providerTokenCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function providerBudgetCount(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * 真实矩阵报告的供应商预算投影。只保留有限的计数与停止原因；
 * prompt、正文、地址、凭据及任意扩展字段均不会进入验收产物。
 */
export function projectProviderBudget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    candidateLimit: providerBudgetCount(value.candidateLimit),
    transportFailureLimit: providerBudgetCount(value.transportFailureLimit),
    totalAttemptLimit: providerBudgetCount(value.totalAttemptLimit),
    wallClockLimitMs: providerBudgetCount(value.wallClockLimitMs),
    candidateAttempts: providerBudgetCount(value.candidateAttempts),
    transportFailures: providerBudgetCount(value.transportFailures),
    totalAttempts: providerBudgetCount(value.totalAttempts),
    stoppedReason: providerIdentifier(value.stoppedReason),
  };
}

function providerAttemptFailure(rawAttempt) {
  const rawFailure =
    rawAttempt?.failure && typeof rawAttempt.failure === "object"
      ? rawAttempt.failure
      : null;
  const code = providerIdentifier(rawFailure?.code || rawAttempt?.failureCode);
  if (!rawFailure && !code) return null;
  const safeCode = code || "provider_error";
  const rawStatus = Number(rawFailure?.status);
  const status =
    Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
      ? rawStatus
      : null;
  const timedOut = rawFailure?.timedOut === true || /timeout/iu.test(safeCode);
  const retryable =
    typeof rawFailure?.retryable === "boolean"
      ? rawFailure.retryable
      : !new Set([
          "provider_auth_failed",
          "provider_request_failed",
          "provider_unavailable",
        ]).has(safeCode);
  return {
    code: safeCode,
    status,
    timedOut,
    retryable,
    // 绝不复制原始 summary/error/message；只按安全错误码重建摘要。
    summary:
      PROVIDER_FAILURE_SUMMARIES[safeCode] ||
      (timedOut ? "供应商响应超时" : "供应商调用未通过"),
  };
}

/**
 * 真实矩阵报告的供应商尝试投影。输出是严格白名单：原始地址、
 * Error/message/stack、Key、prompt 和模型正文都没有进入返回对象的通道。
 */
export function projectProviderAttempts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((rawAttempt, index) => {
    const rawNumber = Number(rawAttempt?.number ?? rawAttempt?.attempt);
    const number =
      Number.isSafeInteger(rawNumber) && rawNumber > 0 ? rawNumber : index + 1;
    const rawPhase = String(rawAttempt?.phase || rawAttempt?.kind || "").trim();
    const phase =
      rawPhase === "initial"
        ? "acquire"
        : rawPhase === "quality_retry"
          ? "repair"
          : providerIdentifier(rawPhase);
    const mode = providerIdentifier(rawAttempt?.mode) || "error";
    const contractValid =
      typeof rawAttempt?.contractValid === "boolean"
        ? rawAttempt.contractValid
        : typeof rawAttempt?.valid === "boolean"
          ? rawAttempt.valid
          : null;
    return {
      number,
      phase,
      mode,
      model: providerModel(rawAttempt?.model),
      apiObtained:
        typeof rawAttempt?.apiObtained === "boolean"
          ? rawAttempt.apiObtained
          : mode === "api",
      succeeded:
        typeof rawAttempt?.succeeded === "boolean"
          ? rawAttempt.succeeded
          : contractValid === true,
      contractValid,
      budgetClass: ["candidate", "transport"].includes(rawAttempt?.budgetClass)
        ? rawAttempt.budgetClass
        : null,
      failure: providerAttemptFailure(rawAttempt),
      usage: {
        inputTokens: providerTokenCount(rawAttempt?.usage?.inputTokens),
        outputTokens: providerTokenCount(rawAttempt?.usage?.outputTokens),
      },
    };
  });
}

export function summarizeProviderAttempts(value) {
  const attempts = projectProviderAttempts(value);
  if (!attempts.length) return null;
  const timedOut = attempts.filter(
    (attempt) => attempt.failure?.timedOut === true,
  ).length;
  const apiObtained = attempts.filter(
    (attempt) => attempt.apiObtained === true,
  ).length;
  const contractValid = attempts.filter(
    (attempt) => attempt.contractValid === true,
  ).length;
  if (timedOut === attempts.length && apiObtained === 0) {
    return `共${attempts.length}轮供应商尝试：${timedOut}轮超时，未取得真实API候选`;
  }
  const details = [
    `${attempts.length}轮总计`,
    timedOut ? `${timedOut}轮超时` : null,
    `${apiObtained}轮取得真实API候选`,
    `${contractValid}轮契约通过`,
  ].filter(Boolean);
  return `共${attempts.length}轮供应商尝试：${details.join("，")}`;
}

function hasRealProviderSummary({
  aiMode,
  model,
  inputTokens,
  outputTokens,
  billingState,
}) {
  return (
    aiMode === "api" &&
    text(model).length > 0 &&
    !FORBIDDEN_PROVIDER.test(model) &&
    Number(inputTokens) > 0 &&
    Number(outputTokens) > 0 &&
    billingState === "settled"
  );
}

/**
 * Proves that the supplier was actually invoked. This evidence is deliberately
 * independent from output acceptance and billing: a real API response can be
 * rejected by the quality gate and fully refunded without becoming "unverified".
 */
export function validateProviderInvocationEvidence(row = {}) {
  const errors = [];
  const attempts = projectProviderAttempts(row.providerAttempts);
  const apiAttempts = attempts.filter(
    (attempt) => attempt.apiObtained === true,
  );
  const verifiedAttempts = apiAttempts.filter(
    (attempt) =>
      attempt.mode === "api" &&
      text(attempt.model) &&
      !FORBIDDEN_PROVIDER.test(attempt.model) &&
      Number(attempt.usage?.inputTokens) > 0 &&
      Number(attempt.usage?.outputTokens) > 0,
  );

  if (attempts.length) {
    if (!apiAttempts.length) errors.push("供应商尝试账本未取得真实API候选");
    if (apiAttempts.length && !verifiedAttempts.length) {
      errors.push("真实API候选缺少模型或正数输入/输出token证据");
    }
  } else {
    const providerModel = text(row.providerModel);
    if (row.providerMode !== "api") {
      errors.push(
        `provider_mode=${row.providerMode || "missing"}，不是实际API调用快照`,
      );
    }
    if (!providerModel || FORBIDDEN_PROVIDER.test(providerModel)) {
      errors.push("provider调用快照缺少真实模型");
    }
    if (
      !(Number(row.providerInputTokens) > 0) ||
      !(Number(row.providerOutputTokens) > 0)
    ) {
      errors.push("provider调用快照缺少正数输入/输出token");
    }
  }

  if (verifiedAttempts.length) {
    const attemptInputTokens = verifiedAttempts.reduce(
      (sum, attempt) => sum + Number(attempt.usage.inputTokens || 0),
      0,
    );
    const attemptOutputTokens = verifiedAttempts.reduce(
      (sum, attempt) => sum + Number(attempt.usage.outputTokens || 0),
      0,
    );
    const models = [
      ...new Set(
        verifiedAttempts.map((attempt) => text(attempt.model).toLowerCase()),
      ),
    ];
    if (models.length > 1) errors.push("供应商尝试账本中真实API模型不一致");
    if (row.providerMode && row.providerMode !== "api") {
      errors.push("provider汇总模式与尝试账本的真实API记录不一致");
    }
    const providerModel = text(row.providerModel);
    if (
      providerModel &&
      models.length === 1 &&
      providerModel.toLowerCase() !== models[0]
    ) {
      errors.push("provider汇总模型与尝试账本不一致");
    }
    if (
      Number(row.providerInputTokens) > 0 &&
      Number(row.providerInputTokens) !== attemptInputTokens
    ) {
      errors.push("provider汇总输入token与尝试账本不一致");
    }
    if (
      Number(row.providerOutputTokens) > 0 &&
      Number(row.providerOutputTokens) !== attemptOutputTokens
    ) {
      errors.push("provider汇总输出token与尝试账本不一致");
    }
  }

  const source = attempts.length
    ? "provider_attempt_ledger"
    : "provider_snapshot";
  return {
    valid: errors.length === 0,
    errors,
    source,
    totalAttempts: attempts.length || (errors.length ? 0 : 1),
    apiObtainedAttempts: attempts.length
      ? apiAttempts.length
      : errors.length
        ? 0
        : 1,
    verifiedApiAttempts: attempts.length
      ? verifiedAttempts.length
      : errors.length
        ? 0
        : 1,
  };
}

/** Business delivery and positive billing evidence required for PASS. */
export function validateBusinessDeliveryBillingEvidence(row = {}) {
  const errors = [];
  const providerModel = text(row.providerModel);
  const billingModel = text(row.billingModel);
  const resultModel = text(row.model);
  if (!hasRealProviderSummary(row))
    errors.push("汇总后的真实API模式、模型、token或结算证据不完整");
  if (row.providerMode !== "api")
    errors.push(
      `provider_mode=${row.providerMode || "missing"}，不是实际API调用快照`,
    );
  if (!providerModel || FORBIDDEN_PROVIDER.test(providerModel))
    errors.push("provider调用快照缺少真实模型");
  if (
    !(Number(row.providerInputTokens) > 0) ||
    !(Number(row.providerOutputTokens) > 0)
  ) {
    errors.push("provider调用快照缺少正数输入/输出token");
  }
  if (row.billingAiMode !== "api")
    errors.push(
      `billing_ai_mode=${row.billingAiMode || "missing"}，不是API结算`,
    );
  if (!billingModel || FORBIDDEN_PROVIDER.test(billingModel))
    errors.push("结算流水缺少真实模型");
  if (
    !(Number(row.billingInputTokens) > 0) ||
    !(Number(row.billingOutputTokens) > 0)
  ) {
    errors.push("结算流水缺少正数输入/输出token");
  }
  if (
    providerModel &&
    billingModel &&
    providerModel.toLowerCase() !== billingModel.toLowerCase()
  ) {
    errors.push("provider模型与结算模型不一致");
  }
  if (
    resultModel &&
    providerModel &&
    resultModel.toLowerCase() !== providerModel.toLowerCase()
  ) {
    errors.push("汇总模型与provider模型不一致");
  }
  if (
    Number(row.inputTokens) !== Number(row.providerInputTokens) ||
    Number(row.inputTokens) !== Number(row.billingInputTokens) ||
    Number(row.outputTokens) !== Number(row.providerOutputTokens) ||
    Number(row.outputTokens) !== Number(row.billingOutputTokens)
  ) {
    errors.push("汇总token、provider token与结算token不一致");
  }
  if (!(Number(row.chargedCredits) > 0)) errors.push("结算实扣积分缺失或为0");
  if (
    !Number.isSafeInteger(Number(row.creditLogId)) ||
    Number(row.creditLogId) <= 0
  ) {
    errors.push("缺少可追溯的结算流水ID");
  }
  if (row.billingLinkValid !== true)
    errors.push("结算流水未与本次业务ID精确关联");
  if (row.billingFreshForAttempt !== true)
    errors.push("结算流水时间早于本次派活或缺少新鲜度证据");
  const authority = validateAuthoritativeBillingEvidence(row);
  if (!authority.valid) {
    errors.push(
      ...authority.errors.map((error) => `权威DB账务：${error}`),
    );
  }
  return { valid: errors.length === 0, errors };
}

export function validateAuthoritativeBillingEvidence(row = {}) {
  const errors = [];
  const expectedRefType =
    row.domain === "restaurant" ? "agent_task" : "content_employee_run";
  if (!Number.isSafeInteger(Number(row.tenantId)) || Number(row.tenantId) <= 0)
    errors.push("缺少运行租户ID");
  if (!Number.isSafeInteger(Number(row.userId)) || Number(row.userId) <= 0)
    errors.push("缺少运行用户ID");
  if (
    Number(row.billingTenantId) !== Number(row.tenantId) ||
    Number(row.creditLogTenantId) !== Number(row.tenantId)
  ) {
    errors.push("hold/log租户与运行租户不一致");
  }
  if (
    Number(row.billingUserId) !== Number(row.userId) ||
    Number(row.creditLogUserId) !== Number(row.userId)
  ) {
    errors.push("hold/log用户与运行用户不一致");
  }
  if (Number(row.billingHoldCount) !== 1)
    errors.push("本业务必须恰好关联1条hold");
  if (Number(row.billingCreditLogCount) !== 1)
    errors.push("本业务必须恰好关1条credit log");
  if (
    !Number.isSafeInteger(Number(row.billingId)) ||
    Number(row.billingId) <= 0 ||
    !Number.isSafeInteger(Number(row.creditLogId)) ||
    Number(row.creditLogId) <= 0 ||
    Number(row.billingHoldLogId) !== Number(row.creditLogId)
  ) {
    errors.push("hold.log_id与权威credit log ID未精确关联");
  }
  if (
    row.billingRefType !== expectedRefType ||
    Number(row.billingRefId) !== Number(row.businessId)
  ) {
    errors.push("权威hold的ref_type/ref_id与业务不一致");
  }
  if (
    !text(row.billingFeature) ||
    row.billingFeature !== row.creditLogFeature ||
    !text(row.billingKind) ||
    row.billingKind !== row.creditLogKind
  ) {
    errors.push("hold/log的feature/kind不一致");
  }
  if (
    !text(row.billingModel) ||
    row.billingModel !== row.billingHoldModel ||
    row.billingModel !== row.creditLogModel
  ) {
    errors.push("hold/log的model不一致");
  }
  if (
    Number(row.settledCredits) !== Number(row.chargedCredits) ||
    Number(row.creditLogCredits) !== Number(row.chargedCredits)
  ) {
    errors.push("hold/log的实扣金额不一致");
  }
  const balanceBefore = Number(row.balanceBefore);
  const balanceAfter = Number(row.balanceAfter);
  const tenantBalance = Number(row.tenantBalance);
  const expectedSettlementBalance = Number(
    row.billingExpectedSettlementBalance,
  );
  const expectedCurrentBalance = Number(row.billingExpectedCurrentBalance);
  if (
    !Number.isFinite(balanceBefore) ||
    !Number.isFinite(balanceAfter) ||
    !Number.isFinite(tenantBalance) ||
    !Number.isFinite(expectedSettlementBalance) ||
    !Number.isFinite(expectedCurrentBalance) ||
    Number(row.billingBalanceWindowInvalidCount) !== 0 ||
    Number(row.billingBalanceWindowAmbiguousTimestampCount) !== 0 ||
    Number(row.billingBalanceWindowTargetCount) !== 1 ||
    balanceAfter !== expectedSettlementBalance ||
    tenantBalance !== expectedCurrentBalance
  ) {
    errors.push(
      "租户余额未与派活后全部hold的并发净占用/结算窗口闭合",
    );
  }
  if (
    row.billingBaselineHoldId == null ||
    !Number.isSafeInteger(Number(row.billingBaselineHoldId)) ||
    Number(row.billingBaselineHoldId) < 0
  ) {
    errors.push("缺少本次派活前hold水位");
  } else if (Number(row.billingId) <= Number(row.billingBaselineHoldId)) {
    errors.push("hold ID未高于本次派活前水位");
  }
  if (
    row.billingBaselineLogId == null ||
    !Number.isSafeInteger(Number(row.billingBaselineLogId)) ||
    Number(row.billingBaselineLogId) < 0
  ) {
    errors.push("缺少本次派活前credit log水位");
  } else if (Number(row.creditLogId) <= Number(row.billingBaselineLogId)) {
    errors.push("credit log ID未高于本次派活前水位");
  }
  return { valid: errors.length === 0, errors };
}

function validateQualityGateRefundEvidence(row = {}, invocation = null) {
  const errors = [];
  const providerInvocation =
    invocation || validateProviderInvocationEvidence(row);
  if (!providerInvocation.valid) errors.push("缺少已校验的真实API调用证据");
  const qualityFailed =
    row.contractValid === false ||
    row.businessFlowStatus === "quality_failed" ||
    (row.generationStatus === "失败" &&
      Array.isArray(row.contractErrors) &&
      row.contractErrors.length > 0);
  if (!qualityFailed) errors.push("未证明本次是输出质量门阻断");
  if (!["settled", "released"].includes(String(row.billingState || ""))) {
    errors.push("退款账务未进入已关闭状态");
  }
  if (
    Number(row.billingInputTokens) !== 0 ||
    Number(row.billingOutputTokens) !== 0 ||
    Number(row.chargedCredits) !== 0 ||
    Number(row.costYuan) !== 0
  ) {
    errors.push("质量门阻断后客户账本不是0 token、0积分、0成本结算");
  }
  if (
    !Number.isSafeInteger(Number(row.creditLogId)) ||
    Number(row.creditLogId) <= 0 ||
    row.billingLinkValid !== true ||
    row.billingFreshForAttempt !== true
  ) {
    errors.push("退款结算流水未与本次业务精确关联");
  }
  if (Number(row.outputId) > 0 || Number(row.resultChars) > 0) {
    errors.push("质量门失败任务不应存在可交付主产物");
  }
  const authority = validateAuthoritativeBillingEvidence(row);
  if (!authority.valid) {
    errors.push(
      ...authority.errors.map((error) => `权威DB账务：${error}`),
    );
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Produces two orthogonal report dimensions. `businessDeliveryBilling*` stays
 * false for refunded quality failures, so recording a real invocation can
 * never accidentally count the row as passed, billed or delivered.
 */
export function classifyProviderEvidence(row = {}) {
  const invocation = validateProviderInvocationEvidence(row);
  const deliveryBilling = validateBusinessDeliveryBillingEvidence(row);
  const qualityGateRefund = deliveryBilling.valid
    ? { valid: false, errors: [] }
    : validateQualityGateRefundEvidence(row, invocation);
  const providerAttemptSummary = summarizeProviderAttempts(
    row.providerAttempts,
  );
  const providerEvidence = deliveryBilling.valid
    ? "real_cloud_api"
    : invocation.valid
      ? "real_cloud_api_invoked"
      : "unverified";
  const businessDeliveryBillingEvidence = deliveryBilling.valid
    ? "settled_real_api_delivery"
    : qualityGateRefund.valid
      ? "quality_gate_refund"
      : "unverified";
  const evidenceNotes = [];
  if (invocation.valid) {
    evidenceNotes.push(
      `真实API调用已确认：${providerAttemptSummary || `${invocation.verifiedApiAttempts}次真实API调用快照通过校验`}`,
    );
  }
  if (qualityGateRefund.valid) {
    evidenceNotes.push(
      "业务交付未成立：输出契约/质量门未通过，未形成产物；客户账本已按0 token、0积分结算（实扣¥0）并全额退回预授权，供应商调用成本另行估算",
    );
  }
  return {
    providerEvidence,
    // 兼容字段从此只表示“真实供应商调用是否已校验”。
    providerEvidenceValid: invocation.valid,
    providerEvidenceErrors: invocation.errors,
    providerInvocationEvidence: invocation.valid
      ? "verified_real_cloud_api_invocation"
      : "unverified",
    providerInvocationEvidenceValid: invocation.valid,
    providerInvocationEvidenceErrors: invocation.errors,
    providerInvocationEvidenceSource: invocation.source,
    providerInvocationApiAttempts: invocation.verifiedApiAttempts,
    businessDeliveryBillingEvidence,
    // 仅这个字段代表“可交付+正向计费”是否成立。
    businessDeliveryBillingEvidenceValid: deliveryBilling.valid,
    businessDeliveryBillingEvidenceErrors: deliveryBilling.errors,
    qualityGateRefunded: qualityGateRefund.valid,
    fullRefund: qualityGateRefund.valid,
    refundState: qualityGateRefund.valid
      ? "full_quality_gate_refund"
      : deliveryBilling.valid
        ? "none"
        : "unverified",
    qualityGateRefundEvidenceErrors: qualityGateRefund.errors,
    evidenceNotes,
  };
}

export function validateRealProviderEvidence(row = {}) {
  const invocation = validateProviderInvocationEvidence(row);
  const deliveryBilling = validateBusinessDeliveryBillingEvidence(row);
  return {
    valid: invocation.valid && deliveryBilling.valid,
    errors: [
      ...invocation.errors.map((error) => `调用证据：${error}`),
      ...deliveryBilling.errors.map((error) => `交付/结算证据：${error}`),
    ],
    invocation,
    deliveryBilling,
  };
}

export function isRealProviderEvidence(row = {}) {
  return validateRealProviderEvidence(row).valid;
}

function classifyNativeVideoAttempt(row = {}) {
  const reasons = [];
  const status = String(row.nativeVideoStatus || row.terminalStatus || "").toLowerCase();
  const blocked = row.nativeVideoBlocked === true || status === "blocked" || status === "阻塞";
  const completed = row.nativeVideoStatus === "成功" || status === "success";
  const composition = row.nativeVideoComposition || {};
  const durationOk = Number(composition.durationSeconds || row.durationSeconds) === 30;
  const providerCalls = Number(row.nativeVideoProviderCalls || row.providerCallCount || 0);
  const billingSettled = row.billingState === "settled";
  if (row.httpError) reasons.push(`HTTP：${row.httpError}`);
  if (Array.isArray(row.videoGateReasons)) reasons.push(...row.videoGateReasons.map(String));
  if (row.unifiedGate && row.unifiedGate.pass !== true) {
    const failed = Array.isArray(row.unifiedGate.failedChecks)
      ? row.unifiedGate.failedChecks.join(",")
      : "unknown";
    reasons.push(`统一验收门禁未通过：${failed}`);
  }
  if (blocked) {
    reasons.push("AI带货员视频安全门未全部满足，按真实路由返回BLOCKED；未发起供应商调用");
  } else {
    if (!completed) reasons.push(`视频任务终态=${row.nativeVideoStatus || row.terminalStatus || "missing"}，期望成功`);
    if (!durationOk) reasons.push("受控成片时长不是30秒");
    if (!(providerCalls > 0)) reasons.push("视频任务缺少供应商分段调用证据");
    if (!billingSettled) reasons.push(`视频账务未结算：${row.billingState || "missing"}`);
  }
  const pass = !blocked && reasons.length === 0;
  return {
    ...row,
    nativeVideo: true,
    providerEvidence: blocked ? "blocked_by_safety_gate" : providerCalls > 0 ? "verified_video_provider" : "unverified",
    providerInvocationEvidenceValid: blocked ? true : providerCalls > 0,
    businessDeliveryBillingEvidenceValid: blocked ? false : pass,
    capabilityPass: pass,
    businessProductionPass: pass,
    pass,
    verdict: pass ? "PASS_REAL_API" : blocked ? "BLOCKED_VIDEO" : "FAIL_REAL_API",
    capabilityVerdict: pass ? "PASS_CAPABILITY_AND_BUSINESS" : blocked ? "BLOCKED_VIDEO_SAFETY_GATE" : "FAIL_CAPABILITY",
    failureReasons: reasons,
    terminalStatus: row.nativeVideoStatus || row.terminalStatus || (blocked ? "阻塞" : "失败"),
    externalPublish: false,
    providerAttemptSummary: providerCalls > 0 ? `video_segments=${providerCalls}` : "video_segments=0",
  };
}

export function classifyAttempt(row) {
  if (row?.nativeVideo === true) return classifyNativeVideoAttempt(row);
  const reasons = [];
  const providerAttempts = projectProviderAttempts(row.providerAttempts);
  const providerBudget = projectProviderBudget(row.providerBudget);
  // A real provider candidate can still fail the output contract.  That is a
  // quality-gate/refund terminal, not a pending human-review flow: do not add
  // stale pre-policy expectations such as “missing approval/expected reject”.
  // The explicit quality-gate reason below keeps the row FAIL_REAL_API while
  // preserving the distinction between provider usage and customer billing.
  const qualityGateFailure =
    row.contractValid === false ||
    row.businessFlowStatus === "quality_failed" ||
    (row.generationStatus === "失败" &&
      Array.isArray(row.contractErrors) &&
      row.contractErrors.length > 0);
  const operationalHold =
    row.domain === "restaurant" &&
    row.qaCapabilityRunnable === true &&
    row.operationalReady === false;
  if (row.httpError) reasons.push(`HTTP：${row.httpError}`);
  if (row.generationError) reasons.push(`生成：${row.generationError}`);
  const evidence = classifyProviderEvidence({ ...row, providerAttempts });
  const providerInvocation = validateProviderInvocationEvidence({
    ...row,
    providerAttempts,
  });
  const deliveryBilling = validateBusinessDeliveryBillingEvidence(row);
  const unifiedGatePresent = row.unifiedGate && typeof row.unifiedGate === "object";
  const unifiedGatePass = unifiedGatePresent && row.unifiedGate.pass === true;
  if (unifiedGatePresent && !unifiedGatePass) {
    const failed = Array.isArray(row.unifiedGate.failedChecks)
      ? row.unifiedGate.failedChecks.join(",")
      : "unknown";
    reasons.push(`统一验收门禁未通过：${failed}`);
  }
  if (!providerInvocation.valid)
    reasons.push(
      ...providerInvocation.errors.map((error) => `真实API调用证据：${error}`),
    );
  const providerAttemptSummary = summarizeProviderAttempts(providerAttempts);
  if (!providerInvocation.valid && providerAttemptSummary) {
    reasons.push(`供应商调用账本：${providerAttemptSummary}`);
  }
  if (evidence.qualityGateRefunded) {
    reasons.push(
      `业务交付/质量门：${providerAttemptSummary || "已取得真实API候选"}，但输出契约未通过；未形成可交付产物，客户账本已按0 token、0积分结算（实扣¥0）并全额退回预授权；供应商调用成本另行估算`,
    );
  } else if (!deliveryBilling.valid) {
    reasons.push(
      ...deliveryBilling.errors.map((error) => `业务交付/结算证据：${error}`),
    );
  }
  if (!text(row.invocationId)) reasons.push("缺少本次运行批次ID");
  if (row.contractValid !== true)
    reasons.push(
      `输出契约未通过${row.contractErrors?.length ? `：${row.contractErrors.join("；")}` : ""}`,
    );
  if (
    row.domain === "restaurant" &&
    row.semanticValid !== true &&
    !qualityGateFailure
  ) {
    reasons.push(
      `运行时业务语义未通过${row.semanticErrors?.length ? `：${row.semanticErrors.join("；")}` : ""}`,
    );
  }
  if (row.domain === "restaurant" && row.inputEvidenceValid !== true) {
    reasons.push("岗位输入缺少可追溯的实际材料正文，禁止自动采纳");
  }
  if (row.domain === "restaurant" && row.acceptanceKind === "capability") {
    if (row.qaCapabilityRunnable !== true)
      reasons.push("餐饮岗未通过隔离QA能力前置门");
    if (typeof row.operationalReady !== "boolean")
      reasons.push("餐饮岗缺少独立的业务生产就绪状态");
  }
  if (row.domain === "content" && row.inputEvidenceValid !== true) {
    reasons.push("内容岗位未取得该岗完整必需输入，禁止自动采纳");
  }
  if (
    row.domain === "content" &&
    (row.contentProfileComplete !== true ||
      row.contentProfileEvidence?.complete !== true)
  ) {
    reasons.push(
      `内容员工完整岗位档案未通过派活前复验${row.contentProfileErrors?.length ? `：${row.contentProfileErrors.join("；")}` : ""}`,
    );
  }
  if (row.domain === "content" && row.contentProfileChainValid !== true) {
    reasons.push(
      `内容员工API档案、执行快照与落库版本/指纹未完整一致${row.contentProfileChainErrors?.length ? `：${row.contentProfileChainErrors.join("；")}` : ""}`,
    );
  }
  if (row.domain === "content" && row.localContractValid !== true) {
    reasons.push(
      `runner采纳前复验未通过${row.localContractErrors?.length ? `：${row.localContractErrors.join("；")}` : ""}`,
    );
  }
  if (row.domain === "content" && row.primaryArtifactHashValid !== true) {
    reasons.push("内容主产物哈希未在采纳前与服务端已验证输出一致");
  }
  if (row.domain === "content" && row.artifactReadbackValid !== true) {
    reasons.push("内容主产物采纳后读回原文与采纳前哈希不一致");
  }
  if (row.acceptanceKind === "pipeline" && row.lineageValid !== true) {
    reasons.push(
      `内容流水线上游血缘未通过${row.lineageErrors?.length ? `：${row.lineageErrors.join("；")}` : ""}`,
    );
  }
  if (row.domain === "restaurant" && qualityGateFailure) {
    if (Number(row.outputId) > 0 || Number(row.assetId) > 0 || Number(row.knowledgeId) > 0) {
      reasons.push("质量门失败任务不应创建主产物、业务资产或知识沉淀");
    }
    if (Number(row.reviewId) > 0 || text(row.reviewDecision)) {
      reasons.push("质量门失败任务不得创建人工审批记录");
    }
    if (row.businessFlowTerminal !== true || row.businessFlowComplete !== true) {
      reasons.push("质量门失败业务流未收敛到失败终态");
    }
  } else if (row.domain === "restaurant") {
    const autoAdoptedWithoutApproval =
      row.operationalReady !== false &&
      unifiedGatePass &&
      Number(row.approvalDelta) === 0;
    if (
      !Number.isSafeInteger(Number(row.outputId)) ||
      Number(row.outputId) <= 0
    )
      reasons.push("餐饮岗缺少主产物ID");
    if (Number(row.primaryArtifactCount) !== 1)
      reasons.push("餐饮岗必须且只能有一个主产物");
    if (
      !(Number(row.resultChars) > 0) ||
      !/^[a-f0-9]{64}$/u.test(String(row.resultHash || ""))
    ) {
      reasons.push("餐饮岗主产物正文或sha256证据缺失");
    }
    if (row.resultHashValid !== true)
      reasons.push("餐饮岗数据库正文与服务端渲染hash不一致");
    if (row.artifactHashValid !== true)
      reasons.push("餐饮岗结构化主工件与契约审计hash不一致");
    if (!autoAdoptedWithoutApproval &&
      (!Number.isSafeInteger(Number(row.reviewId)) || Number(row.reviewId) <= 0))
      reasons.push("餐饮岗缺少人工审批记录ID");
    if (operationalHold) {
      if (Number(row.assetId) > 0 || Number(row.knowledgeId) > 0) {
        reasons.push("业务证据未齐的产物已错误进入资产或知识库");
      }
      if (row.outputStatus !== "已驳回")
        reasons.push(
          `餐饮岗产物状态=${row.outputStatus || "missing"}，期望已驳回`,
        );
    } else {
      if (
        !Number.isSafeInteger(Number(row.assetId)) ||
        Number(row.assetId) <= 0
      )
        reasons.push("采纳后缺少内部业务资产ID");
      if (
        !Number.isSafeInteger(Number(row.knowledgeId)) ||
        Number(row.knowledgeId) <= 0
      )
        reasons.push("采纳后缺少知识沉淀ID");
      if (row.outputStatus !== "可使用")
        reasons.push(
          `餐饮岗产物状态=${row.outputStatus || "missing"}，期望可使用`,
        );
    }
  }
  if (!qualityGateFailure) {
    const expectedReviewDecision = operationalHold ? "reject" : "adopt";
    const autoAdoptedWithoutApproval =
      row.domain === "restaurant" &&
      !operationalHold &&
      unifiedGatePass &&
      Number(row.approvalDelta) === 0;
    if (!autoAdoptedWithoutApproval && row.reviewDecision !== expectedReviewDecision) {
      reasons.push(
        operationalHold
          ? `QA能力验收结论=${row.reviewDecision || "missing"}，业务证据未齐时必须reject以阻止生产采纳`
          : `审阅结论=${row.reviewDecision || "missing"}，未采纳`,
      );
    }
    if (
      operationalHold &&
      (!Array.isArray(row.operationalBlockReasons) ||
        !row.operationalBlockReasons.length)
    ) {
      reasons.push("业务执行未就绪但缺少operationalBlockReasons");
    }
    const expectedTerminal = operationalHold ? "已驳回" : "已完成";
    if (row.terminalStatus !== expectedTerminal)
      reasons.push(
        `终态=${row.terminalStatus || "missing"}，期望${expectedTerminal}`,
      );
  }
  if (
    !Number.isSafeInteger(Number(row.businessId)) ||
    Number(row.businessId) <= 0
  )
    reasons.push("缺少业务ID");
  if (row.externalPublish !== false)
    reasons.push("检测到或未能排除外部发布，本验收禁止对外发布");
  if (!qualityGateFailure) {
    const acceptedFlowStatuses = operationalHold
      ? ["review_rejected"]
      : ["approved"];
    if (!acceptedFlowStatuses.includes(row.businessFlowStatus)) {
      reasons.push(
        `业务流=${row.businessFlowStatus || "missing"}，未到${operationalHold ? "QA能力验收驳回" : "人工通过"}终态`,
      );
    }
    if (row.businessFlowTerminal !== true || row.businessFlowComplete !== true) {
      reasons.push("业务流未形成可验证终态");
    }
    if (row.businessFlowBillingSettled !== true)
      reasons.push("业务流未确认正向积分结算");
  }
  const pass =
    reasons.length === 0 &&
    providerInvocation.valid &&
    deliveryBilling.valid &&
    (!unifiedGatePresent || unifiedGatePass);
  return {
    ...evidence,
    pass,
    capabilityPass: pass,
    businessProductionPass: pass && !operationalHold,
    capabilityVerdict: pass
      ? operationalHold
        ? "PASS_CAPABILITY_OPERATIONALLY_BLOCKED"
        : "PASS_CAPABILITY_AND_BUSINESS"
      : "FAIL_CAPABILITY",
    verdict: pass ? "PASS_REAL_API" : "FAIL_REAL_API",
    failureReasons: reasons,
    // classifyAttempt 会覆盖 runner/旧断点中的同名字段，因此即使
    // 输入意外夹带额外诊断，落盘前也只会保留白名单投影。
    providerAttempts,
    providerBudget,
    providerAttemptSummary,
  };
}

const EXTERNAL_CURRENT_REGULATION_INPUT =
  /(?:(?:司法辖区|当地|法定|受监管)[^\n]{0,30}(?:法规|要求|规则|义务|清单|联系方式)|(?:现行|当前|最新)[^\n]{0,16}(?:法规|官方政策|监管规则)|(?:法规|法定检验|许可|监管报告|无障碍|劳动|消费者|隐私)[^\n]{0,20}(?:要求|规则|义务|差异|原文)|平台[^\n]{0,30}(?:条款|规则|政策)|(?:适用追溯|适用标准)[^\n]{0,20}(?:规则|要求|范围))/u;

const LOCAL_CREDENTIAL_INPUT =
  /(?:证照|许可证|经营许可|生产许可|备案|资质|认证|许可信息|许可范围|授权范围|许可[^\n]{0,30}状态)/u;

/**
 * 区分企业自有的证照/备案台账与必须另行取得官方实时原文的外部合规输入。
 * 分类只决定验收资料是否齐备，不代替业务语义契约或法律判断。
 */
export function classifyRestaurantRequiredInput(value) {
  const name = String(value || "").trim();
  if (EXTERNAL_CURRENT_REGULATION_INPUT.test(name))
    return "external_current_regulation";
  if (LOCAL_CREDENTIAL_INPUT.test(name)) return "local_credential_record";
  return "business_record";
}

const RESTAURANT_INPUT_EVIDENCE_SCHEMA = "rri-evidence.v3";
const REGULATORY_SOURCE_CODES = "REG-NPC|REG-SAMR|REG-STD";

const RESTAURANT_INPUT_FAMILIES = Object.freeze([
  {
    tag: "scope",
    pattern:
      /(?:国家|地区|司法辖区|门店|中央厨房|期间|日期|时区|范围|目标|期限|周期|负责人|审批|权限|决策|来源|版本|生效日|合同|企业标准|不可妥协|问题|阶段|开业日|活动类型|活动主题|收集并标注)/u,
    required: ["期间", "范围", "责任"],
    fields: () => ({ 期间: "2026-07", 范围: "验收门店A", 责任: "QA_OWNER" }),
  },
  {
    tag: "location",
    pattern:
      /(?:城市|商圈|地址|坐标|交通|通行|覆盖半径|地图|候选点|楼层|门面|场地|服务区域|客流|学校|社区|周边|物业)/u,
    required: ["城市", "商圈", "地址", "通行分钟"],
    fields: () => ({
      城市: "太原",
      商圈: "QA-A",
      地址: "验收路100号",
      通行分钟: 15,
    }),
  },
  {
    tag: "demand",
    pattern:
      /(?:品类|业态|菜系|目标顾客|目标客群|客群|消费者|人群|餐段|场景|渠道|客单|需求|预测|销量|销售组合|座位|营业时段|用餐时长|到店|候位|餐饮|堂食|外卖|自提|宴会|季节)/u,
    required: ["品类", "业态", "客群", "月订单"],
    fields: () => ({
      品类: "中式简餐",
      业态: "堂食+外卖",
      客群: "工作日午餐",
      月订单: 2000,
    }),
  },
  {
    tag: "competition",
    pattern:
      /(?:竞品|竞争|价格带|地图|调研|搜索|评价|顾客访谈|试卖反馈|外部事件|供给密度)/u,
    required: ["竞品数", "样本", "价格带"],
    fields: () => ({ 竞品数: 8, 样本: "QA-C1/C2/C3", 价格带: "40-60元" }),
  },
  {
    tag: "finance",
    pattern:
      /(?:投资|CAPEX|OPEX|预算|租金|管理费|抽成|押金|免租|递增|币种|税|融资|回报|售价|价格|费用|成本|利润|损益|现金|银行|应收|应付|工资|社保|折旧|账期|报价|付款|毛利|营业额|净销售额|资金|库存金额|客单价)/u,
    required: ["营业额元", "食材元", "人工元", "预算元"],
    fields: () => ({
      营业额元: 100000,
      食材元: 35000,
      人工元: 22000,
      预算元: 300000,
    }),
  },
  {
    tag: "capex",
    pattern:
      /(?:开办投资|投资上限|设备报价|装修|预开业|营运资金|资本支出|回收期|回报期限|租赁|押金|租金|固定成本)/u,
    required: ["CAPEX元", "OPEX月元", "租金月元", "押金元"],
    fields: () => ({
      CAPEX元: 280000,
      OPEX月元: 69000,
      租金月元: 12000,
      押金元: 36000,
    }),
  },
  {
    tag: "facility",
    pattern:
      /(?:面积|楼层|门面|平面|水电气|排烟|隔油|消防|承重|垃圾|装卸|厨房|设备|资产|工位|容器|设施|通风|排水|冷藏|冷冻|洗消|虫害|车辆|电源|储存容量|库区|库位|公用工程|能源|用水|燃气|空调|照明|施工|装修|场地|容量|额定能力)/u,
    required: ["面积平方米", "座位", "设备报价元", "设备批次"],
    fields: () => ({
      面积平方米: 180,
      座位: 64,
      设备报价元: 85000,
      设备批次: "EQ-202607",
    }),
  },
  {
    tag: "menu_recipe",
    pattern:
      /(?:菜单|菜品|菜名|菜系|配方|原料|配料|份量|出成|食材|制作|烹调|工艺|摆盘|营养|过敏原|包装|售价|停售|售罄|产品|食品形态|饮料|调味料|装饰|份数|可食部|熟制|净料|毛料|修切|去皮|去骨|烹饪后重量|(?:AP|EP)[^\n]{0,8}(?:重量|净重))/u,
    required: ["菜单版本", "配方版本", "菜品数", "标准份量克"],
    fields: () => ({
      菜单版本: "M-202607",
      配方版本: "R-202607",
      菜品数: 12,
      标准份量克: 350,
    }),
  },
  {
    tag: "food_compliance",
    pattern:
      /(?:法规|法定|司法辖区|许可|证照|备案|监管|认证|合规|食品安全|卫生|HACCP|PRP|GHP|SSOP|危害|温控|温度|冷却|复热|报废|过敏原|交叉|清洁|消毒|健康|病假|污染|召回|追溯|检验|检测|官方|隐私|消费者|无障碍|劳动|安全|质量|资质|限值|标准|声称|标签|授权|症状|洗手|感官)/u,
    required: ["食安批次", "证照凭证", "国家基线"],
    fields: ({ idx, inputIndex }) => ({
      食安批次: "SAFE-202607",
      证照凭证: `QA-LIC-${idx}-${inputIndex + 1}`,
      国家基线: REGULATORY_SOURCE_CODES,
    }),
  },
  {
    tag: "supply_chain",
    pattern:
      /(?:供应商|采购|进货|收货|交付|储运|运输|配送|冷链|批次|库存|在途|起订量|包装倍数|退货|调拨|领用|仓储|库位|FEFO|保质|效期|承运商|票据|分包商|关键上游|进料|隔离区|验收|车辆)/u,
    required: ["供应商", "采购批次", "明细数", "交期天"],
    fields: () => ({
      供应商: "QA-S01",
      采购批次: "PO-202607",
      明细数: 18,
      交期天: 2,
    }),
  },
  {
    tag: "operations_data",
    pattern:
      /(?:营业|流程|SOP|POS|KDS|ERP|系统|平台|班次|开店|闭店|交接|服务|订座|等位|桌台|出餐|工艺|记录|日志|检查表|产能|节拍|时间|订单|退款|取消|支付|收银|钥匙|门禁|关账|核对|盘点|报损|维护|校准|维修|故障|停机|保修|安装|测量|抽样|工具|排期|上线|统计|数据|明细|仪表盘|刷新)/u,
    required: ["SOP版本", "POS批次", "订单", "状态"],
    fields: () => ({
      SOP版本: "OPS-202607",
      POS批次: "POS-202607",
      订单: 2000,
      状态: "已核验",
    }),
  },
  {
    tag: "growth_customer",
    pattern:
      /(?:品牌|营销|活动|促销|内容|社媒|UGC|CRM|会员|忠诚|生命周期|顾客|评价|口碑|渠道|广告|优惠券|积分|触达|投放|账号|创作者|达人|肖像|商标|节日|赛事|展会|合作方|客诉|投诉|反馈|回复|舆情|转化|咨询|奖项|人物故事|预订)/u,
    required: ["活动批次", "会员样本", "评价样本", "投诉"],
    fields: () => ({
      活动批次: "MKT-202607",
      会员样本: 500,
      评价样本: 120,
      投诉: 12,
    }),
  },
  {
    tag: "workforce",
    pattern:
      /(?:人员|员工|岗位|排班|工时|考勤|技能|培训|资格|带教|主管|休假|缺勤|借调|外包|组织|团队|健康证明|工服|访客|责任人|审核员|班次|工资|加班|福利|语言|考核人)/u,
    required: ["员工数", "班次数", "工时批次", "培训批次"],
    fields: () => ({
      员工数: 18,
      班次数: 3,
      工时批次: "HR-202607",
      培训批次: "TR-202607",
    }),
  },
  {
    tag: "expansion_risk",
    pattern:
      /(?:扩店|多店|跨店|开业|爬坡|试点|回滚|延期|业务连续|恢复|RTO|RPO|风险|事故|异常|偏差|不合格|投诉|召回|保险|应急|隔离|停业|危害|约束|不可比|演练|攻击|故障|备用|影响|升级|纠正|预防|内审|迎检|审核|停止条件|食品转移)/u,
    required: ["门店数", "阶段", "RTO小时", "风险批次"],
    fields: () => ({
      门店数: 3,
      阶段: "试点",
      RTO小时: 4,
      风险批次: "RISK-202607",
    }),
  },
]);

const RESTAURANT_INPUT_FAMILY_BY_TAG = new Map(
  RESTAURANT_INPUT_FAMILIES.map((family) => [family.tag, family]),
);

export function restaurantRequiredInputTags(value) {
  const name = String(value || "").trim();
  return RESTAURANT_INPUT_FAMILIES.filter((family) =>
    family.pattern.test(name),
  ).map((family) => family.tag);
}

function normalizeRestaurantRequiredInputs(values) {
  return (Array.isArray(values) ? values : []).filter((value) =>
    !/^(?:收集并标注(?:缺失项|来源日期)|必要输入如下|请提供以下信息|请先提供)[:：]?$/u.test(
      String(value || "").trim(),
    ),
  );
}

export function buildRestaurantRequiredInputEvidence({
  input,
  idx,
  inputIndex,
}) {
  const name = String(input || "").trim();
  const recordId = `E-${Number(idx)}-${Number(inputIndex) + 1}-R1`;
  const tags = restaurantRequiredInputTags(name);
  const detail = buildRestaurantInputFacts({
    input: name,
    idx,
    inputIndex,
    recordId,
  });
  const mapping =
    !tags.length || !detail.dimensionIds.length
      ? "UNMAPPED_REQUIRED_INPUT"
      : !detail.regulationComplete
        ? "BLOCKED_CURRENT_REGULATION_EVIDENCE"
        : "mapped";
  return {
    schema: RESTAURANT_INPUT_EVIDENCE_SCHEMA,
    recordId,
    inputHash: shaToken(name),
    mapping,
    tags,
    dimensions: detail.dimensionIds,
    fields: { rid: recordId, facts: detail.facts },
    qaCapabilityRunnable: mapping === "mapped" && detail.qaCapabilityRunnable,
    operationalReady: mapping === "mapped" && detail.operationalReady,
    ...(detail.regulationRequired
      ? {
          regulationEvidence: detail.regulationComplete
            ? detail.operationalReady
              ? "OFFICIAL_EVIDENCE_OPERATIONALLY_READY"
              : "OFFICIAL_BASELINE_ATTACHED_OPERATIONALLY_BLOCKED"
            : "BLOCKED_CURRENT_REGULATION_EVIDENCE",
        }
      : {}),
    ...(detail.regulationBlockers.length
      ? { regulationBlockers: detail.regulationBlockers }
      : {}),
  };
}

function mergeFixtureValues(existing, extra) {
  if (Array.isArray(existing) && Array.isArray(extra)) {
    return [...existing, ...extra];
  }
  if (
    existing &&
    typeof existing === "object" &&
    !Array.isArray(existing) &&
    extra &&
    typeof extra === "object" &&
    !Array.isArray(extra)
  ) {
    const merged = { ...existing };
    for (const [key, value] of Object.entries(extra)) {
      merged[key] = Object.hasOwn(merged, key)
        ? mergeFixtureValues(merged[key], value)
        : structuredClone(value);
    }
    return merged;
  }
  return existing === undefined ? structuredClone(extra) : existing;
}

function mergeFixtureFacts(existingFacts, extraFacts) {
  const merged = existingFacts && typeof existingFacts === "object" && !Array.isArray(existingFacts)
    ? structuredClone(existingFacts)
    : {};
  if (!extraFacts || typeof extraFacts !== "object" || Array.isArray(extraFacts)) return merged;
  for (const [dimension, value] of Object.entries(extraFacts)) {
    merged[dimension] = Object.hasOwn(merged, dimension)
      ? mergeFixtureValues(merged[dimension], value)
      : structuredClone(value);
  }
  return merged;
}

function mergeOperationalFixtureRecords(records, baseLength) {
  const cloned = Array.isArray(records) ? records.map((item) => structuredClone(item)) : [];
  if (cloned.length <= baseLength) return cloned;
  const targetIndex = Math.max(
    0,
    cloned.slice(0, baseLength).findIndex(
      (record) => !record?.fields?.facts?.regulation && !record?.facts?.regulation,
    ),
  );
  const target = cloned[targetIndex] || {};
  const targetFields = target.fields && typeof target.fields === "object" && !Array.isArray(target.fields)
    ? target.fields
    : {};
  const targetFacts = targetFields.facts && typeof targetFields.facts === "object" && !Array.isArray(targetFields.facts)
    ? targetFields.facts
    : target.facts && typeof target.facts === "object" && !Array.isArray(target.facts)
      ? target.facts
      : {};
  for (const extra of cloned.slice(baseLength)) {
    const extraFacts = extra?.fields?.facts || extra?.facts;
    if (!extraFacts || typeof extraFacts !== "object" || Array.isArray(extraFacts)) continue;
    const mergedFacts = mergeFixtureFacts(targetFacts, extraFacts);
    for (const key of Object.keys(targetFacts)) delete targetFacts[key];
    Object.assign(targetFacts, mergedFacts);
    target.qaFixture = true;
    target.qaFixtureEvidence = [
      ...(Array.isArray(target.qaFixtureEvidence) ? target.qaFixtureEvidence : []),
      {
        recordId: extra.recordId || extra.evidenceId || null,
        source: extra.source || extra.sourceKind || "synthetic_qa",
        evidenceDate: extra.evidenceDate || null,
      },
    ];
  }
  cloned[targetIndex] = {
    ...target,
    fields: { ...targetFields, facts: targetFacts },
  };
  return cloned.slice(0, baseLength);
}

// The complete materialEvidence remains in the runner's in-memory task gate
// and is written to the isolated evidence DB.  The provider-facing requirement
// has an existing 8,000-character contract, so only the fixture fields needed
// by a deterministic task rule are carried into the serialized line.  This is
// a lossless operation for ordinary (non-fixture) records: required input facts
// and their record/hash/schema fields are always retained.
const COMPACT_FIXTURE_FACT_SPECS = Object.freeze({
  131: Object.freeze({
    business_scope: Object.freeze(["中央厨房编号"]),
    logistics: Object.freeze({
      配送路线明细: Object.freeze(["接收门店", "路线里程公里", "停靠顺序", "备用路线"]),
    }),
  }),
  134: Object.freeze({
    orders_demand: Object.freeze({
      订单事件明细: Object.freeze(["订单号", "菜品", "订单来源", "状态", "状态时间", "返工", "错漏"]),
    }),
    systems_data: Object.freeze({
      KDS事件明细: Object.freeze(["订单号", "菜品", "订单来源", "状态", "状态时间", "返工", "错漏"]),
    }),
  }),
  136: Object.freeze({
    workforce: Object.freeze({
      员工排班明细: Object.freeze(["员工编号", "可用时间", "合同工时", "休假状态", "资格", "技能"]),
      员工可用性明细: Object.freeze(["员工编号", "可用时间", "合同工时", "休假状态", "资格", "技能"]),
    }),
    orders_demand: Object.freeze({
      小时需求明细: Object.freeze(["时段", "需求人数", "订单数"]),
      分时需求明细: Object.freeze(["时段", "需求人数", "订单数"]),
    }),
  }),
  143: Object.freeze({
    customer_feedback: Object.freeze({
      评价明细: Object.freeze(["评价原文", "星级", "时间", "平台", "订单号", "订单事实"]),
      差评明细: Object.freeze(["评价原文", "星级", "时间", "平台", "订单号", "订单事实"]),
    }),
  }),
  146: Object.freeze({
    orders_demand: Object.freeze({
      渠道经营明细: Object.freeze(["渠道", "订单数", "退款数", "履约时长分钟", "合同费率"]),
    }),
    packaging_storage: Object.freeze(["保持测试批次"]),
  }),
  147: Object.freeze({
    cash_payment: Object.freeze({
      交易明细: Object.freeze(["交易号", "渠道", "应收元", "实收元", "状态", "发生时间"]),
      支付流水明细: Object.freeze(["交易号", "渠道", "应收元", "实收元", "状态", "发生时间"]),
      平台结算明细: Object.freeze(["交易号", "渠道", "应收元", "实收元", "状态", "发生时间"]),
    }),
    systems_data: Object.freeze({
      交易明细: Object.freeze(["交易号", "渠道", "应收元", "实收元", "状态", "发生时间"]),
      支付流水明细: Object.freeze(["交易号", "渠道", "应收元", "实收元", "状态", "发生时间"]),
      平台结算明细: Object.freeze(["交易号", "渠道", "应收元", "实收元", "状态", "发生时间"]),
    }),
  }),
  148: Object.freeze({
    recipe_ingredient: Object.freeze({
      理论实际耗用明细: Object.freeze(["原料", "菜品净销量", "标准耗用", "期初库存", "采购数量", "期末库存"]),
      菜品耗用明细: Object.freeze(["原料", "菜品净销量", "标准耗用", "期初库存", "采购数量", "期末库存"]),
    }),
    inventory_batch: Object.freeze({
      理论实际耗用明细: Object.freeze(["原料", "菜品净销量", "标准耗用", "期初库存", "采购数量", "期末库存"]),
      菜品耗用明细: Object.freeze(["原料", "菜品净销量", "标准耗用", "期初库存", "采购数量", "期末库存"]),
    }),
  }),
  150: Object.freeze({
    cost_margin: Object.freeze([
      "包装成本元", "渠道可变费元", "工资附加元", "占用成本元", "能源成本元",
      "维修费元", "折旧元", "中央分摊元", "一次性事项元",
    ]),
  }),
  151: Object.freeze({
    cash_payment: Object.freeze({
      周现金流明细: Object.freeze(["周次", "销售流入元", "应付元", "工资元", "税费元", "租金元", "债务元", "资本支出元", "期间"]),
    }),
  }),
  152: Object.freeze({
    price_volume: Object.freeze({
      历史价格销量明细: Object.freeze(["价格元", "销量", "期间", "促销标记", "缺货标记", "外部事件"]),
      价格实验明细: Object.freeze(["价格元", "销量", "期间", "促销标记", "缺货标记", "外部事件"]),
    }),
    orders_demand: Object.freeze({
      历史价格销量明细: Object.freeze(["价格元", "销量", "期间", "促销标记", "缺货标记", "外部事件"]),
      价格实验明细: Object.freeze(["价格元", "销量", "期间", "促销标记", "缺货标记", "外部事件"]),
    }),
  }),
  153: Object.freeze({
    orders_demand: Object.freeze({
      去标识订单明细: Object.freeze(["渠道", "餐段", "菜品", "顾客群键", "净收入元", "可变成本元"]),
      多维经营明细: Object.freeze(["渠道", "餐段", "菜品", "顾客群键", "净收入元", "可变成本元"]),
    }),
    systems_data: Object.freeze({
      去标识订单明细: Object.freeze(["渠道", "餐段", "菜品", "顾客群键", "净收入元", "可变成本元"]),
      多维经营明细: Object.freeze(["渠道", "餐段", "菜品", "顾客群键", "净收入元", "可变成本元"]),
    }),
  }),
  155: Object.freeze({
    business_scope: Object.freeze({
      门店清单: true,
      门店明细: true,
    }),
  }),
  156: Object.freeze({
    deadline_constraint: Object.freeze(["目标开业日"]),
    quality_audit: Object.freeze({
      开业就绪明细: Object.freeze(["模块", "状态", "证据编号", "负责人"]),
      就绪状态明细: Object.freeze(["模块", "状态", "证据编号", "负责人"]),
    }),
    systems_data: Object.freeze({
      开业就绪明细: Object.freeze(["模块", "状态", "证据编号", "负责人"]),
      就绪状态明细: Object.freeze(["模块", "状态", "证据编号", "负责人"]),
    }),
  }),
  158: Object.freeze({
    sustainability: Object.freeze({
      能源账单明细: Object.freeze(["能源类型", "用量", "费率元", "金额元", "期间"]),
      包装品项明细: Object.freeze(["包装品项", "用量", "单位成本元", "回收去向"]),
    }),
    equipment: Object.freeze({
      设备负荷明细: Object.freeze(["设备", "负荷千瓦", "费率元", "金额元", "期间"]),
    }),
    packaging_storage: Object.freeze({
      包装品项明细: Object.freeze(["包装品项", "用量", "单位成本元", "回收去向"]),
    }),
  }),
});

// These 101–130 jobs have no task-completeness rule beyond the regular
// evidence contract; their large QA-only regulatory proof is compacted to the
// original input facts plus the preserved QA_ONLY regulation snapshot.
const COMPACT_QA_ONLY_NON_TASK_INDEXES = new Set([
  109, 114, 115, 116, 117, 118, 120, 122, 123, 124,
]);

function stripFixtureMetadata(value) {
  if (Array.isArray(value)) return value.map(stripFixtureMetadata);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(QA标签|QA证据编号|QA证据日期|QA对象)$/u.test(key)) continue;
    result[key] = stripFixtureMetadata(child);
  }
  return result;
}

function selectFixtureFacts(value, selector) {
  if (selector === true) return stripFixtureMetadata(value);
  if (Array.isArray(selector)) {
    if (Array.isArray(value)) {
      return value.map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return row;
        return Object.fromEntries(selector
          .filter((key) => Object.hasOwn(row, key))
          .map((key) => [key, stripFixtureMetadata(row[key])]));
      });
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(selector
        .filter((key) => Object.hasOwn(value, key))
        .map((key) => [key, stripFixtureMetadata(value[key])]));
    }
    return value;
  }
  if (selector && typeof selector === "object" && value && typeof value === "object") {
    return Object.fromEntries(Object.entries(selector)
      .filter(([key]) => Object.hasOwn(value, key))
      .map(([key, childSelector]) => [key, selectFixtureFacts(value[key], childSelector)]));
  }
  return undefined;
}

const QA_REGULATION_FACT_KEYS = Object.freeze([
  "QA_ONLY",
  "QA_ONLY_MARKER",
  "数据性质",
  "证据编号",
  "证据日期",
  "数据来源",
  "QA能力验收资格",
  "业务执行资格",
  "QA业务执行资格",
  "业务采纳资格",
  "外部执行资格",
  "法律结论",
  "结论状态",
  "禁止用途",
  "生成资格说明",
  "realWorldBlockers",
  "阻塞原因",
  "QA状态",
  "QA核验日期",
  "QA来源",
  "QA证据编号",
  "QA对象",
  "QA禁止事项",
  "QA_ONLY_PROOF",
]);
const REGULATION_BASE_FACT_KEYS = Object.freeze([
  "验收司法辖区",
  "核验日期",
  "法规名称",
  "文号条款",
  "要求原文",
  "官方链接",
  "适用范围",
  "结论状态",
  "人工法务确认",
  "QA能力验收资格",
  "业务执行资格",
  "阻塞原因",
]);

function preserveQaOnlyRegulation(compact, evidence, baseEvidence) {
  const currentFacts = evidence?.fields?.facts;
  const currentRegulation = currentFacts?.regulation;
  if (
    !currentRegulation ||
    typeof currentRegulation !== "object" ||
    Array.isArray(currentRegulation) ||
    !(
      evidence?.qaOnlyRegulatoryProof === true ||
      evidence?.qaRegulationScope ||
      currentRegulation.QA_ONLY === true ||
      currentRegulation.结论状态 === "QA_ONLY" ||
      currentRegulation.数据性质 === "QA_ONLY_SYNTHETIC"
    )
  ) {
    return compact;
  }
  const baseRegulation = baseEvidence?.fields?.facts?.regulation;
  const qaRegulation = stripFixtureMetadata(currentRegulation);
  const cleanBaseRegulation =
    baseRegulation && typeof baseRegulation === "object"
      ? stripFixtureMetadata(baseRegulation)
      : {};
  const preserved = Object.fromEntries(
    REGULATION_BASE_FACT_KEYS
      .filter((key) => Object.hasOwn(cleanBaseRegulation, key))
      .map((key) => [key, cleanBaseRegulation[key]]),
  );
  for (const key of QA_REGULATION_FACT_KEYS) {
    if (Object.hasOwn(qaRegulation, key)) preserved[key] = qaRegulation[key];
  }
  if (compact.fields && typeof compact.fields === "object") {
    compact.fields.facts = {
      ...(compact.fields.facts && typeof compact.fields.facts === "object" ? compact.fields.facts : {}),
      regulation: preserved,
    };
  }
  compact.qaOnlyRegulatoryProof = true;
  compact.regulationEvidence = evidence.regulationEvidence || compact.regulationEvidence || "QA_ONLY_SYNTHETIC_TASK_READY_EXTERNAL_BLOCKED";
  const originalBlockers = Array.isArray(evidence.realWorldBlockers)
    ? [...evidence.realWorldBlockers]
    : Array.isArray(baseEvidence?.regulationBlockers)
      ? [...baseEvidence.regulationBlockers]
      : Array.isArray(baseRegulation?.阻塞原因)
        ? [...baseRegulation.阻塞原因]
        : [];
  if (originalBlockers.length) compact.realWorldBlockers = originalBlockers;
  // The full qaEvidence object is retained in the in-memory dispatch/DB
  // snapshot, but it duplicates the same source/date/blocker/adoption fields
  // already preserved under fields.facts.regulation.  Omitting that duplicate
  // from the provider-facing line keeps large regulation rows under the
  // 8,000-character dispatch contract without dropping the QA_ONLY boundary.
  return compact;
}

function compactRestaurantEvidenceForDispatch(evidence, baseEvidence, idx) {
  const compact = stripFixtureMetadata(evidence);
  for (const key of ["objects", "verifiedResults", "verifiedActualResult", "qaFixtureEvidence", "qaEvidence", "qaOperationalFacts", "qaRegulationScope", "source", "sourceKind"]) {
    delete compact[key];
  }
  if (compact.fields && typeof compact.fields === "object") delete compact.fields.qa;
  const numericIdx = Number(idx);
  const compactFixture =
    evidence?.qaOperationalFacts === true ||
    (evidence?.qaFixture === true && COMPACT_QA_ONLY_NON_TASK_INDEXES.has(numericIdx)) ||
    Boolean(evidence?.qaRegulationScope);
  if (numericIdx < 101 || numericIdx > 161 || !compactFixture) {
    return preserveQaOnlyRegulation(compact, evidence, baseEvidence);
  }
  const baseFacts = baseEvidence?.fields?.facts && typeof baseEvidence.fields.facts === "object"
    ? stripFixtureMetadata(baseEvidence.fields.facts)
    : {};
  const currentFacts = evidence?.fields?.facts && typeof evidence.fields.facts === "object"
    ? evidence.fields.facts
    : {};
  const compactFacts = { ...baseFacts };
  const selectors = COMPACT_FIXTURE_FACT_SPECS[numericIdx] || {};
  for (const [dimension, selector] of Object.entries(selectors)) {
    if (!Object.hasOwn(currentFacts, dimension)) continue;
    const selected = selectFixtureFacts(currentFacts[dimension], selector);
    if (selected === undefined) continue;
    compactFacts[dimension] = dimension in compactFacts && compactFacts[dimension] && typeof compactFacts[dimension] === "object" && !Array.isArray(compactFacts[dimension]) && selected && typeof selected === "object" && !Array.isArray(selected)
      ? { ...compactFacts[dimension], ...selected }
      : selected;
  }
  if (compact.fields && typeof compact.fields === "object") compact.fields.facts = compactFacts;
  return preserveQaOnlyRegulation(compact, evidence, baseEvidence);
}

export function buildRestaurantDispatch(profile, nonce, options = {}) {
  const employee = profile?.identity || {};
  const guidance = profile?.dispatch?.guidance || {};
  const requiredInputs = normalizeRestaurantRequiredInputs(
    Array.isArray(profile?.dispatch?.requiredInputs)
      ? profile.dispatch.requiredInputs
      : Array.isArray(guidance.materialChecklist)
        ? guidance.materialChecklist
        : [],
  );
  const desiredOutputs = Array.isArray(guidance.deliverableChecklist)
    ? guidance.deliverableChecklist
    : [];
  const primaryTask =
    Array.isArray(guidance.taskExamples) && guidance.taskExamples[0]
      ? guidance.taskExamples[0]
      : `${employee.name || `员工${employee.idx}`}完成本岗位专项分析`;
  const explicitDemand = String(
    options?.demand ||
      profile?.dispatch?.acceptanceDemand ||
      guidance?.acceptanceDemand ||
      "",
  ).trim();
  const acceptanceDemand =
    explicitDemand ||
    (Number(employee.idx) === 102
      ? "请围绕“毛血旺 太原吾悦广场”核验竞品与商圈画像，给出下一步可执行的业务结论。"
      : `请围绕${employee.name || `员工${employee.idx}`}对应的门店经营问题，给出下一步可执行的业务结论。`);
  const acceptanceGatePlan = buildUnifiedAcceptancePlan({
    demand: acceptanceDemand,
    publicInfoRequired: true,
  });
  const baseMaterialEvidence = requiredInputs.map((item, index) =>
    buildRestaurantRequiredInputEvidence({
      input: item,
      idx: employee.idx,
      inputIndex: index,
    }),
  );
  const fixtureEvidence = augmentRestaurantOperationalFixtures101To130({
    idx: employee.idx,
    materialEvidence: baseMaterialEvidence,
  });
  const materialEvidence = mergeOperationalFixtureRecords(
    fixtureEvidence,
    baseMaterialEvidence.length,
  );
  const allFixtureEvidence = augmentRestaurantOperationalMaterialEvidence({
    idx: employee.idx,
    materialEvidence,
  });
  materialEvidence.splice(0, materialEvidence.length, ...allFixtureEvidence);
  const materials = requiredInputs.map(
    (item, index) => {
      const serializedEvidence = compactRestaurantEvidenceForDispatch(
        materialEvidence[index],
        baseMaterialEvidence[index],
        employee.idx,
      );
      return (
        `${index + 1}. 【材料 E-${employee.idx}-${index + 1}】名称=${item}；` +
        `记录批次=E-${employee.idx}-${index + 1}；证据编号:E-${employee.idx}-${index + 1}-R1；` +
        `正文=${JSON.stringify(serializedEvidence)}`
      );
    },
  );
  const qaBlockedEvidence = materialEvidence.filter(
    (evidence) => evidence.qaCapabilityRunnable !== true,
  );
  const operationalBlockedEvidence = materialEvidence.filter(
    (evidence) => evidence.operationalReady !== true,
  );
  const taskCompleteness = assessRestaurantTaskCompleteness({
    idx: employee.idx,
    materialEvidence,
  });
  const operationalBlockReasons = [
    ...new Set([
      ...operationalBlockedEvidence.flatMap(
        (evidence) => evidence.regulationBlockers || [],
      ),
      ...taskCompleteness.operationalBlockReasons,
    ]),
  ];
  return {
    title: `[真实API逐岗验收] ${primaryTask}`.slice(0, 100),
    type: profile?.dispatch?.defaultTaskType || "执行方案",
    requirement: [
      `任务唯一标识：${nonce}`,
      `执行岗位：${employee.name || employee.idx}；岗位职责：${employee.duty || "以服务端完整岗位档案为准"}。`,
      `老板真实需求：${acceptanceDemand}`,
      "公开信息：真实联网/API核验；不反问老板，无法核验项标未知并给补查动作。",
      "隔离QA真实云API验收：按岗位契约交付一个主产物。",
      "业务对象：纳米Work验收数据集·门店A。",
      "统一已知事实：验收期营业额100000元，订单2000单，食材成本35000元，人工成本22000元，顾客投诉12次；除这些事实及下列材料外不得自行补造数字。",
      "验收截止时间：2026-08-07T18:00:00；所有行动项必须使用这一明确截止时间或更早的可验证子节点。",
      "岗位材料：",
      ...(materials.length
        ? materials
        : [
            "1. 当前没有额外岗位材料；必须明确列出待补证据并给出可执行的收集方案。",
          ]),
      "证据规则：主交付物必须在evidence.source或evidence.finding中引用至少一个【材料 E-岗位号-序号】；未引用不通过。",
      desiredOutputs.length
        ? `期望交付：${desiredOutputs.join("；")}。`
        : "期望交付：按岗位机器契约交付完整、可审阅主产物。",
      "边界：本次只能生成隔离QA草案/差距清单；属地、平台版本或私有记录未齐时禁止业务采纳和外部执行。不得声称已发布/采购/付款/签约/调整账号，不得泄露内部配置。",
    ].join("\n"),
    dueAt: "2026-08-07T18:00:00",
    qaCapabilityRunnable: qaBlockedEvidence.length === 0,
    operationalReady:
      operationalBlockedEvidence.length === 0 &&
      taskCompleteness.operationalReady,
    operationalBlockReasons,
    acceptanceDemand,
    acceptanceGatePlan,
    acceptanceDemandValid: isSingleSentenceDemand(acceptanceDemand),
  };
}

function shaToken(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function validateRestaurantDispatchEvidence(dispatch, profile) {
  const requirement = String(dispatch?.requirement || "");
  const requiredInputs = normalizeRestaurantRequiredInputs(
    Array.isArray(profile?.dispatch?.requiredInputs)
      ? profile.dispatch.requiredInputs
      : Array.isArray(profile?.dispatch?.guidance?.materialChecklist)
        ? profile.dispatch.guidance.materialChecklist
        : [],
  );
  const errors = [];
  const operationalErrors = [];
  const operationalBlockReasons = [];
  const materialEvidence = [];
  const demandMatch = requirement.match(/^老板真实需求：(.+)$/mu);
  const acceptanceDemand = String(dispatch?.acceptanceDemand || "").trim();
  if (!demandMatch || !isSingleSentenceDemand(demandMatch[1])) {
    errors.push("统一验收门禁缺少一句有效的老板真实需求");
  } else if (acceptanceDemand && demandMatch[1].trim() !== acceptanceDemand) {
    errors.push("派活中的老板真实需求与dispatch.acceptanceDemand不一致");
  }
  if (!requirement.includes("公开信息：真实联网/API核验；不反问老板")) {
    errors.push("统一验收门禁缺少公开信息自行联网且不得反问老板边界");
  }
  if (/本轮已提供[“"]?岗位验收资料/u.test(requirement)) {
    errors.push("材料仅有占位名称，没有实际正文");
  }
  const dueAt = String(dispatch?.dueAt || "").trim();
  if (
    dueAt !== "2026-08-07T18:00:00" ||
    !requirement.includes(`验收截止时间：${dueAt}`)
  ) {
    errors.push("派活缺少与任务要求一致的明确验收截止时间");
  }
  const seenRecordIds = new Set();
  requiredInputs.forEach((item, index) => {
    const marker = `【材料 E-${profile?.identity?.idx}-${index + 1}】`;
    const recordId = `E-${profile?.identity?.idx}-${index + 1}-R1`;
    const markerStart = requirement.indexOf(marker);
    const lineEnd =
      markerStart < 0 ? -1 : requirement.indexOf("\n", markerStart);
    const materialLine =
      markerStart < 0
        ? ""
        : requirement.slice(
            markerStart,
            lineEnd < 0 ? requirement.length : lineEnd,
          );
    if (
      !materialLine.includes(`名称=${item}`) ||
      !materialLine.includes(`证据编号:${recordId}`)
    ) {
      errors.push(`缺少岗位输入“${item}”的独立材料记录`);
      return;
    }
    const expectedTags = restaurantRequiredInputTags(item);
    if (!expectedTags.length) {
      errors.push(`UNMAPPED_REQUIRED_INPUT：${item}`);
      return;
    }
    const bodyStart = materialLine.indexOf("正文=");
    if (bodyStart < 0) {
      errors.push(`岗位输入“${item}”缺少结构化证据正文`);
      return;
    }
    let evidence;
    try {
      evidence = JSON.parse(materialLine.slice(bodyStart + "正文=".length));
    } catch {
      errors.push(`岗位输入“${item}”的结构化证据正文不是有效JSON`);
      return;
    }
    materialEvidence.push(evidence);
    if (evidence?.schema !== RESTAURANT_INPUT_EVIDENCE_SCHEMA) {
      errors.push(`岗位输入“${item}”的证据schema不正确`);
    }
    if (evidence?.recordId !== recordId || seenRecordIds.has(recordId)) {
      errors.push(`岗位输入“${item}”的recordId缺失、错误或重复`);
    }
    seenRecordIds.add(recordId);
    if (evidence?.inputHash !== shaToken(item))
      errors.push(`岗位输入“${item}”的inputHash不匹配`);
    if (evidence?.mapping !== "mapped")
      errors.push(
        `岗位输入“${item}”未形成mapped证据：${evidence?.mapping || "missing"}`,
      );
    if (evidence?.qaCapabilityRunnable !== true) {
      errors.push(`岗位输入“${item}”不具备隔离QA能力验收条件`);
    }
    const actualTags = Array.isArray(evidence?.tags) ? evidence.tags : [];
    if (
      actualTags.length !== expectedTags.length ||
      expectedTags.some((tag, tagIndex) => actualTags[tagIndex] !== tag)
    ) {
      errors.push(`岗位输入“${item}”的标签集合与语义重算结果不一致`);
    }
    const expectedDimensions = restaurantInputFactSpecs(item).map(
      (spec) => spec.id,
    );
    const actualDimensions = Array.isArray(evidence?.dimensions)
      ? evidence.dimensions
      : [];
    if (
      actualDimensions.length !== expectedDimensions.length ||
      expectedDimensions.some(
        (dimensionId, dimensionIndex) =>
          actualDimensions[dimensionIndex] !== dimensionId,
      )
    ) {
      errors.push(`岗位输入“${item}”的事实维度与语义重算结果不一致`);
    }
    const factValidation = validateRestaurantInputFacts({
      input: item,
      facts: evidence?.fields?.facts,
      recordId,
    });
    if (evidence?.fields?.rid !== recordId)
      errors.push(`岗位输入“${item}”的fields.rid不匹配`);
    errors.push(
      ...factValidation.errors.map((error) => `岗位输入“${item}”：${error}`),
    );
    operationalErrors.push(
      ...factValidation.operationalErrors.map(
        (error) => `岗位输入“${item}”：${error}`,
      ),
    );
    if (
      evidence?.qaCapabilityRunnable !== factValidation.qaCapabilityRunnable
    ) {
      errors.push(`岗位输入“${item}”的qaCapabilityRunnable与事实不一致`);
    }
    if (evidence?.operationalReady !== factValidation.operationalReady) {
      errors.push(`岗位输入“${item}”的operationalReady与事实不一致`);
    }
    if (evidence?.operationalReady === false) {
      if (
        !Array.isArray(evidence.regulationBlockers) ||
        !evidence.regulationBlockers.length
      ) {
        errors.push(`岗位输入“${item}”业务未就绪但缺少阻塞码`);
      } else {
        operationalBlockReasons.push(
          ...evidence.regulationBlockers.map(String),
        );
      }
    }
  });
  const recordCount = (requirement.match(/记录批次=/gu) || []).length;
  if (requiredInputs.length && recordCount < requiredInputs.length) {
    errors.push("岗位材料缺少可追溯记录批次");
  }
  const taskCompleteness = assessRestaurantTaskCompleteness({
    idx: profile?.identity?.idx,
    materialEvidence,
  });
  operationalErrors.push(...taskCompleteness.operationalErrors);
  operationalBlockReasons.push(...taskCompleteness.operationalBlockReasons);
  const uniqueOperationalBlockReasons = [...new Set(operationalBlockReasons)];
  const operationalReady =
    operationalErrors.length === 0 && taskCompleteness.operationalReady;
  if (dispatch?.qaCapabilityRunnable !== true) {
    errors.push("派活未声明qaCapabilityRunnable=true");
  }
  if (dispatch?.operationalReady !== operationalReady) {
    errors.push("派活operationalReady与证据重算结果不一致");
  }
  const declaredBlockReasons = Array.isArray(dispatch?.operationalBlockReasons)
    ? dispatch.operationalBlockReasons.map(String)
    : [];
  if (
    declaredBlockReasons.length !== uniqueOperationalBlockReasons.length ||
    declaredBlockReasons.some(
      (reason, index) => reason !== uniqueOperationalBlockReasons[index],
    )
  ) {
    errors.push("派活operationalBlockReasons与证据重算结果不一致");
  }
  return {
    valid: errors.length === 0,
    errors,
    qaCapabilityRunnable: errors.length === 0,
    operationalReady: errors.length === 0 && operationalReady,
    operationalErrors,
    operationalBlockReasons: uniqueOperationalBlockReasons,
  };
}

function nonEmptyRecord(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

function nonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJsonValue(value[key])]),
  );
}

function stableFingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableJsonValue(value)), "utf8")
    .digest("hex");
}

function employeeOrdinal(idx) {
  return String(Number(idx)).padStart(3, "0");
}

function capabilityEntries(profile, idx) {
  return (Array.isArray(profile?.capabilities) ? profile.capabilities : []).map(
    (item, index) => ({
      id: `capability:v1:e${employeeOrdinal(idx)}:c${String(index + 1).padStart(3, "0")}`,
      fingerprint: stableFingerprint({
        name: item?.name || null,
        emoji: item?.emoji || null,
        desc: item?.desc || null,
        required: item?.required === true,
        enabled: item?.enabled === true,
        locked: item?.locked === true,
      }),
    }),
  );
}

function skillEntries(profile, idx) {
  const library = nonEmptyRecord(profile?.skillLibrary)
    ? profile.skillLibrary
    : {};
  const required = Array.isArray(library.required) ? library.required : [];
  const historical = Array.isArray(library.historical)
    ? library.historical
    : [];
  return [
    ...required.map((item, index) => ({
      id:
        text(item?.id) ||
        `factory-skill:v1:e${employeeOrdinal(idx)}:s${String(index + 1).padStart(3, "0")}`,
      fingerprint: stableFingerprint({
        title: item?.title || null,
        detail: item?.detail || null,
        source: item?.source || null,
        origin: item?.origin || null,
        required: item?.required === true,
        enabled: item?.enabled === true,
        locked: item?.locked === true,
        defaultInjected: item?.defaultInjected === true,
      }),
    })),
    ...historical.map((item) => ({
      id: text(item?.id) || null,
      fingerprint: stableFingerprint({
        id: item?.id || null,
        employeeIdx: Number(item?.employeeIdx),
        roleKey: item?.roleKey || null,
        title: item?.title || null,
        detail: item?.detail || null,
        source: item?.source || null,
        version: item?.version || null,
        contentFingerprint: item?.contentFingerprint || null,
        verificationLevel: item?.verificationLevel || null,
        effectValidation: item?.effectValidation || null,
        enabled: item?.enabled === true,
        locked: item?.locked === true,
        defaultInjected: item?.defaultInjected === true,
      }),
    })),
  ];
}

function profilePrompts(profile) {
  const prompts = nonEmptyRecord(profile?.prompts) ? profile.prompts : {};
  return {
    systemPrompt: prompts.systemPrompt || null,
    pipelinePrompt: prompts.pipelinePrompt || null,
    soloPrompt: prompts.soloPrompt || null,
    placeholders: prompts.placeholders || null,
    interpolationPolicy: prompts.interpolationPolicy || null,
  };
}

function profileWorkMethod(profile) {
  return nonEmptyRecord(profile?.workMethod?.raw)
    ? profile.workMethod.raw
    : profile?.workMethod || null;
}

function profileCore(profile, idx) {
  const job = nonEmptyRecord(profile?.jobProfile) ? profile.jobProfile : {};
  const dispatch = nonEmptyRecord(profile?.dispatch) ? profile.dispatch : {};
  const workConfig = nonEmptyRecord(profile?.workConfig)
    ? profile.workConfig
    : {};
  return {
    identity: {
      idx: Number(profile?.identity?.idx),
      key: profile?.identity?.key || null,
      name: profile?.identity?.name || null,
      group: profile?.identity?.group || null,
      moduleGroup: profile?.identity?.moduleGroup || null,
      positionSkill: profile?.identity?.positionSkill || null,
      duty: profile?.identity?.duty || null,
    },
    capabilities: capabilityEntries(profile, idx),
    skills: skillEntries(profile, idx),
    workMethod: profileWorkMethod(profile),
    prompts: profilePrompts(profile),
    workConfig: {
      factoryDefault: workConfig.factoryDefault || null,
      safeLegacyConfig: workConfig.safeLegacyConfig || null,
    },
    jobProfile: {
      employeeNumber: job.employeeNumber ?? null,
      roleKey: job.roleKey || null,
      roleTitle: job.roleTitle || null,
      moduleGroup: job.moduleGroup || null,
      positionSkill: job.positionSkill || null,
      responsibilities: job.responsibilities || null,
      useCases: job.useCases || null,
      scope: job.scope || null,
      requiredInputs: job.requiredInputs || null,
      expectedDeliverables: job.expectedDeliverables || null,
      qualityStandards: job.qualityStandards || null,
      safetyBoundaries: job.safetyBoundaries || null,
      nonGoals: job.nonGoals || null,
      collaborators: job.collaborators || null,
      outputKeys: job.outputKeys || null,
      outputSchema: job.outputSchema || null,
      connectorPolicy: job.connectorPolicy || null,
      serviceLevel: job.serviceLevel || null,
      authority: job.authority || null,
    },
    dispatch: {
      form: dispatch.form || null,
      guidance: dispatch.guidance || null,
      approval: dispatch.approval || null,
      handoff: dispatch.handoff || null,
    },
  };
}

export function contentProfileIntegrityEvidence(
  profile,
  expectedIdx,
  canonicalProfile,
) {
  const capabilityRows = capabilityEntries(profile, expectedIdx);
  const skillRows = skillEntries(profile, expectedIdx);
  const canonicalCapabilityRows = capabilityEntries(
    canonicalProfile,
    expectedIdx,
  );
  const canonicalSkillRows = skillEntries(canonicalProfile, expectedIdx);
  const profileFingerprint = stableFingerprint(profileCore(profile, expectedIdx));
  const canonicalProfileFingerprint = canonicalProfile
    ? stableFingerprint(profileCore(canonicalProfile, expectedIdx))
    : null;
  const capabilityFingerprint = stableFingerprint(capabilityRows);
  const canonicalCapabilityFingerprint = canonicalProfile
    ? stableFingerprint(canonicalCapabilityRows)
    : null;
  const skillFingerprint = stableFingerprint(skillRows);
  const canonicalSkillFingerprint = canonicalProfile
    ? stableFingerprint(canonicalSkillRows)
    : null;
  const capabilityIds = capabilityRows.map((item) => item.id);
  const canonicalCapabilityIds = canonicalCapabilityRows.map((item) => item.id);
  const skillIds = skillRows.map((item) => item.id);
  const canonicalSkillIds = canonicalSkillRows.map((item) => item.id);
  const canonicalMatch =
    Boolean(canonicalProfile) &&
    profileFingerprint === canonicalProfileFingerprint &&
    capabilityFingerprint === canonicalCapabilityFingerprint &&
    skillFingerprint === canonicalSkillFingerprint &&
    JSON.stringify(capabilityIds) === JSON.stringify(canonicalCapabilityIds) &&
    JSON.stringify(skillIds) === JSON.stringify(canonicalSkillIds);
  return {
    profileFingerprint,
    canonicalProfileFingerprint,
    capabilityFingerprint,
    canonicalCapabilityFingerprint,
    skillFingerprint,
    canonicalSkillFingerprint,
    capabilityIds,
    skillIds,
    canonicalMatch,
  };
}

function profileVersionFrom(value) {
  return (
    text(value?.profileVersion) ||
    text(value?.provenance?.profileVersion) ||
    text(value?.jobProfile?.profileVersion) ||
    text(value?.prompts?.version) ||
    null
  );
}

export function validateContentProfileExecutionChain({
  api,
  execution,
  persisted,
} = {}) {
  const errors = [];
  const rows = { api, execution, persisted };
  for (const [label, row] of Object.entries(rows)) {
    if (!row || typeof row !== "object") {
      errors.push(`${label}岗位证据缺失`);
      continue;
    }
    if (!/^content-\d+-r\d+$/u.test(String(row.profileVersion || ""))) {
      errors.push(`${label}岗位版本无效`);
    }
    for (const field of [
      "profileFingerprint",
      "capabilityFingerprint",
      "skillFingerprint",
    ]) {
      if (!/^[a-f0-9]{64}$/u.test(String(row[field] || ""))) {
        errors.push(`${label}.${field}无效`);
      }
    }
  }
  for (const field of [
    "profileVersion",
    "profileFingerprint",
    "capabilityFingerprint",
    "skillFingerprint",
  ]) {
    const values = new Set(
      Object.values(rows)
        .map((row) => row?.[field])
        .filter(Boolean),
    );
    if (values.size !== 1) {
      errors.push(
        `API/执行/落库${field === "profileVersion" ? "岗位版本" : field}不一致`,
      );
    }
  }
  return { valid: errors.length === 0, errors, api, execution, persisted };
}

export function validateContentProfileCompleteness(
  profile,
  expectedIdx,
  canonicalProfile = null,
) {
  const errors = [];
  const identity = nonEmptyRecord(profile?.identity) ? profile.identity : {};
  const capabilities = Array.isArray(profile?.capabilities)
    ? profile.capabilities
    : [];
  const skillLibrary = nonEmptyRecord(profile?.skillLibrary)
    ? profile.skillLibrary
    : {};
  const requiredSkills = Array.isArray(skillLibrary.required)
    ? skillLibrary.required
    : [];
  const historicalSkills = Array.isArray(skillLibrary.historical)
    ? skillLibrary.historical
    : [];
  const canonicalHistoricalPolicy =
    canonicalProfile?.skillLibrary?.injectionPolicy?.historicalSkills ||
    canonicalProfile?.workConfig?.historicalSkillPolicy?.historicalSkills ||
    null;
  const profileHistoricalPolicy =
    profile?.skillLibrary?.injectionPolicy?.historicalSkills ||
    profile?.workConfig?.historicalSkillPolicy?.historicalSkills ||
    null;
  const nativeHistoricalSkillsNone =
    historicalSkills.length === 0 &&
    (canonicalHistoricalPolicy === "none" ||
      profileHistoricalPolicy === "none" ||
      canonicalProfile?.provenance?.historicalSkills?.expectedSkillCount === 0);
  const defaultInjected = Array.isArray(skillLibrary.defaultInjected)
    ? skillLibrary.defaultInjected
    : [];
  // The public workbench projection intentionally omits the aggregate
  // `skillLibrary.defaultInjected` array (it only exposes the per-skill
  // `defaultInjected` flags).  Keep the runner's completeness check strict
  // without requiring an internal-only field: when the aggregate is absent,
  // derive the injected set from the required + historical rows and still
  // require every row to be explicitly marked defaultInjected=true.
  const effectiveDefaultInjected = Array.isArray(skillLibrary.defaultInjected)
    ? defaultInjected
    : [...requiredSkills, ...historicalSkills].filter(
        (item) => item?.defaultInjected === true,
      );
  const expectedProfileArrays = [
    "responsibilities",
    "useCases",
    "requiredInputs",
    "expectedDeliverables",
    "qualityStandards",
    "safetyBoundaries",
    "boundaries",
    "nonGoals",
    "collaborators",
    "outputKeys",
  ];
  const workMethod = nonEmptyRecord(profile?.workMethod?.raw)
    ? profile.workMethod.raw
    : profile?.workMethod;
  const workMethodComplete = [
    "input",
    "execution",
    "output",
    "approval",
    "handoff",
  ].every((key) => nonEmptyRecord(workMethod?.[key]));
  const promptsComplete = [
    "systemPrompt",
    "pipelinePrompt",
    "soloPrompt",
    "placeholders",
    "interpolationPolicy",
  ].every((key) => nonEmptyRecord(profile?.prompts?.[key]));
  const workConfig = profile?.workConfig;
  const staticWorkConfigComplete = [
    "factoryDefault",
    "safeLegacyConfig",
    "capabilityPolicy",
    "historicalSkillPolicy",
  ].every((key) => nonEmptyRecord(workConfig?.[key]));
  const normalizedApiWorkConfigComplete =
    nonEmptyRecord(workConfig?.factoryDefault) &&
    nonEmptyRecord(workConfig?.safeLegacyConfig) &&
    nonEmptyArray(workConfig?.fields) &&
    nonEmptyRecord(workConfig?.values) &&
    workConfig?.mode === "factory_plus_tenant_overlay" &&
    text(workConfig?.summary) &&
    text(workConfig?.boundary);
  const workConfigComplete =
    staticWorkConfigComplete || normalizedApiWorkConfigComplete;
  const jobProfileComplete =
    nonEmptyRecord(profile?.jobProfile) &&
    expectedProfileArrays.every((key) =>
      nonEmptyArray(profile.jobProfile[key]),
    ) &&
    nonEmptyRecord(profile.jobProfile.outputSchema) &&
    nonEmptyRecord(profile.jobProfile.connectorPolicy) &&
    nonEmptyRecord(profile.jobProfile.authority);
  const dispatchComplete = ["form", "guidance", "approval", "handoff"].every(
    (key) => nonEmptyRecord(profile?.dispatch?.[key]),
  );
  const capabilitiesLocked =
    capabilities.length > 0 &&
    capabilities.every(
      (item) =>
        nonEmptyRecord(item) &&
        text(item.name) &&
        item.required === true &&
        item.enabled === true &&
        item.locked === true,
    );
  const requiredSkillsLocked =
    requiredSkills.length > 0 &&
    requiredSkills.every(
      (item) =>
        nonEmptyRecord(item) &&
        text(item.title) &&
        item.required === true &&
        item.enabled === true &&
        item.locked === true &&
        item.defaultInjected === true,
    );
  const historicalSkillsInjected = nativeHistoricalSkillsNone || (
    historicalSkills.length > 0 &&
      historicalSkills.every(
        (item) =>
          nonEmptyRecord(item) &&
          text(item.title) &&
          item.enabled === true &&
          item.locked === true &&
          item.defaultInjected === true,
      ) &&
      effectiveDefaultInjected.length ===
        requiredSkills.length + historicalSkills.length
  );
  const integrity = contentProfileIntegrityEvidence(
    profile,
    expectedIdx,
    canonicalProfile,
  );

  if (
    Number(identity.idx) !== Number(expectedIdx) ||
    !text(identity.key) ||
    !text(identity.name) ||
    !text(identity.duty)
  ) {
    errors.push("岗位身份不完整或与目标内容员工不一致");
  }
  if (!capabilitiesLocked)
    errors.push("全部岗位能力未以必需、已启用、已锁定的完整形态加载");
  if (!requiredSkillsLocked) errors.push("必需出厂技能库未完整锁定并注入");
  if (!historicalSkillsInjected) errors.push("历史技能库未完整保留或默认注入");
  if (!workMethodComplete) errors.push("工作方式五段契约不完整");
  if (!promptsComplete) errors.push("提示词模板、占位符或插值策略不完整");
  if (!workConfigComplete) errors.push("工作配置与能力/技能策略不完整");
  if (!jobProfileComplete) errors.push("岗位档案、交付标准或输出契约不完整");
  if (!dispatchComplete) errors.push("派活、操作指引、审批或交接契约不完整");
  if (!nonEmptyRecord(profile?.provenance)) errors.push("岗位来源证据不完整");
  if (!canonicalProfile) errors.push("缺少canonical岗位档案基准");
  else if (!integrity.canonicalMatch) {
    errors.push("canonical能力ID/技能ID、数量或稳定指纹不一致");
  }

  const evidence = {
    identityIdx: Number.isSafeInteger(Number(identity.idx))
      ? Number(identity.idx)
      : null,
    identityKey: text(identity.key) || null,
    capabilityCount: capabilities.length,
    capabilitiesLocked,
    requiredSkillCount: requiredSkills.length,
    requiredSkillsLocked,
    historicalSkillCount: historicalSkills.length,
    historicalSkillsInjected,
    historicalSkillsPolicy: nativeHistoricalSkillsNone ? "none" : "required",
    defaultInjectedFieldPresent: Array.isArray(skillLibrary.defaultInjected),
    defaultInjectedCount: effectiveDefaultInjected.length,
    workMethodComplete,
    promptsComplete,
    workConfigComplete,
    jobProfileComplete,
    dispatchComplete,
    provenanceComplete: nonEmptyRecord(profile?.provenance),
    profileVersion: profileVersionFrom(profile),
    ...integrity,
    complete: errors.length === 0,
  };
  return { valid: errors.length === 0, errors, evidence };
}

const CONTENT_DATASET_FACTS = Object.freeze([
  "验收数据集：纳米Work门店A；期间=2026-07-01至2026-07-31。",
  "已核验经营事实：营业额100000元、食材成本35000元、目标食材成本率32%、订单2000单。",
  "目标受众：经营1至3家餐饮门店的老板；内容目标：让读者保存一周成本复盘清单并留言自己的成本率。",
  "主题：如何用一周复盘发现食材成本异常。",
  "事实边界：历史最佳发布时间、地址、电话、价格、折扣、库存、礼品和外部账号链接未提供；必须标记待确认，不得虚构。",
]);

const FULL_WRITER_DRAFT = [
  "# 一周复盘，先别急着砍菜价",
  "门店本期营业额100000元，食材成本35000元，对应食材成本率为35%，高于32%的目标3个百分点。这个差额只说明需要追查，不能直接归因为供应商涨价或后厨浪费。",
  "第一步，把2000笔订单按日期和品类分组，核对销售结构是否变化；第二步，对照采购、领料、报损和盘点记录，找出差额发生的环节；第三步，只把有凭证的异常交给责任人复核。",
  "一周复盘清单可以只保留四列：日期、品类、差额、证据编号。没有采购单、领料单或盘点记录支持的判断，先写“待核验”，不急着当结论。",
  "把你门店本周的食材成本率和差额环节记下来，留言一个最想先核对的品类。发布前还需人工确认账号链接、联系方式和经营信息。",
].join("\n\n");

const CONTENT_REQUIRED_MARKERS = Object.freeze({
  0: [
    "老板Brief",
    "账号人设",
    "目标平台",
    "时间窗口",
    "近期已发内容",
    "内容禁区",
  ],
  1: ["已选选题", "核心研究问题", "地区与时间范围", "优先来源", "事实截止日"],
  2: [
    "已选选题",
    "情报员证据包",
    "对标样本",
    "拆解维度",
    "评论样本",
    "合规边界",
  ],
  3: ["已选选题", "已核验事实包", "对标拆解", "账号人设", "目标平台", "CTA"],
  4: [
    "待改写完整原稿",
    "账号人设",
    "语气规则",
    "参考样文",
    "必须保留的事实",
    "禁用词",
  ],
  5: [
    "定稿标题与正文",
    "配图点位",
    "品牌色与字体",
    "Logo",
    "平台尺寸",
    "版权来源",
  ],
  6: [
    "定稿标题候选",
    "正文摘要",
    "目标平台与尺寸",
    "品牌色与字体",
    "安全区",
    "A/B测试变量",
  ],
  7: [
    "定稿正文",
    "封面与图表资产",
    "品牌规范",
    "目标设备",
    "章节顺序",
    "可访问性",
    "部署限制",
  ],
  8: [
    "已终审正文",
    "封面与全部素材",
    "目标平台",
    "账号定位",
    "发布时间窗口",
    "版权与广告合规",
    "最终审批人",
  ],
  9: ["发布记录", "真实指标", "历史基线", "业务目标", "评论反馈", "异常情况"],
});

function capabilityInputs(idx, { pipeline = false, lineage = null } = {}) {
  const upstream = lineage
    ? `上游主产物：完整原文见附件“${lineage.filename}”；sourceRunId=${lineage.sourceRunId}；sha256=${lineage.sourceArtifactHash}。`
    : "";
  const inputs = {
    0: [
      "老板Brief：扫描本周餐饮老板关注的成本复盘信号，交付5个候选选题。",
      "账号人设：实战型餐饮创业者，先列证据再下判断，口吻克制，禁止夸大。",
      "目标平台：微信公众号、小红书、视频号。时间窗口：2026-07-24至2026-07-31。",
      "近期已发内容：《不要只看营业额》《盘点表里的三个信号》《忙不等于赚钱》。",
      "内容禁区：不编造平台热度、不承诺降本效果、不把验收数据写成真实客户战果；指定观察渠道：上述三个平台及官方行业公告。",
    ],
    1: [
      `${upstream || "已选选题：一周复盘如何发现食材成本异常。"}`,
      "已选选题：一周复盘如何发现食材成本异常。核心研究问题：35%如何核算，与32%目标的差距如何解释，还需哪些证据才能归因。",
      "地区与时间范围：中国大陆餐饮门店，事实截止日=2026-07-31。",
      "优先来源：任务内已核验数据、官方统计/行业文件、可追溯原始链接；不得用无来源营销文代替事实。",
    ],
    2: [
      `${upstream || "情报员证据包：验收数据显示35%的食材成本率与32%目标存在3个百分点差距，归因仍需采购、领料、报损和盘点证据。"}`,
      "已选选题：一周成本复盘。情报员证据包：使用上游已结算主产物和本任务的数据白名单。",
      "对标样本：S1“成本率不等于浪费率”、S2“四张表定位食材差额”、S3“菜单结构变化的成本信号”，均为验收样本摘要，不声称平台热度。",
      "拆解维度：选题角度、标题钩子、内容结构、情绪曲线、封面视觉、评论区洞察。",
      "评论样本：C1“我只有销售数没有领料表”、C2“怎么区分涨价和浪费”、C3“小店一周查一次可以吗”；合规边界：不复制原文，不虚构互动量。",
    ],
    3: [
      `${upstream || "对标拆解：用“先算差距—再查证据—最后归因”结构，开头避免把成本超标直接归因。"}`,
      "已选选题：一周复盘如何发现食材成本异常。已核验事实包：只允许使用任务白名单中的4个数字及可直接计算的35%和3个百分点差距。",
      "对标拆解：开头给差距，中段给证据链清单，结尾引导留言品类；不复制任何样本原句。",
      "账号人设：实战型餐饮老板，克制、句子短、事实先行。目标平台：微信公众号。篇幅：800至1200字。CTA：保存复盘清单并留言最想先核对的品类。",
    ],
    4: [
      pipeline
        ? `${upstream}\n待改写完整原稿：附件中“完整原稿”标记后是上游撰稿人已结算主产物的逐字原文，必须完整改写而非只给补料清单。`
        : `待改写完整原稿：${FULL_WRITER_DRAFT}`,
      "账号人设：一位经营多年的实战型餐饮老板，不摆架子，先讲账本上的事实，再给能当天执行的动作。",
      "语气规则：第一人称复盘口吻，短句，不用“震惊”“必看”“轻松翻倍”。参考样文：“先别急着找人背锅，把单据摆出来。”",
      "必须保留的事实：营业额100000元、食材成本35000元、成本率35%、目标32%、订单2000单。禁用词：稳赚、秘籍、财富密码、绝对有效。",
    ],
    5: [
      `${upstream || `定稿标题与正文：《一周复盘，先别急着砍菜价》\n${FULL_WRITER_DRAFT}`}`,
      "配图点位：1.首屏成本率35%与目标32%对比；2.采购—领料—报损—盘点证据链；3.四列复盘清单。",
      "品牌色与字体：深墨色#1F2A24、米白#F5F0E8，中文无衬线字体。Logo：本验收数据集未授权Logo，产物中不得伪造。",
      "平台尺寸：小红书1080×1440、公众号900×383；文件格式：SVG方案与画面说明。版权来源：只用自制图表和系统字体，不引用未授权照片。",
    ],
    6: [
      `${upstream || "定稿标题候选：《一周复盘，先别急着砍菜价》《35%不是结论，是查账起点》《成本超了3个点，先查哪张表》。"}`,
      "定稿标题候选：沿用上游的经审阅标题，不新增经营事实。正文摘要：35%与32%存在3个百分点差距，需通过单据链查证，不能直接归因。",
      "目标平台与尺寸：小红书1080×1440，顶部120px和底部120px为安全区。品牌色与字体：#1F2A24/#F5F0E8，中文无衬线字体。",
      "A/B测试变量：A版突出“3个百分点”，B版突出“四张表”；人物照和Logo未授权，禁止使用。",
    ],
    7: [
      `${upstream || `定稿正文：${FULL_WRITER_DRAFT}`}`,
      "定稿正文：使用上游已结算主产物与本任务事实白名单。封面与图表资产：成本率对比卡、证据链流程图、四列复盘清单。",
      "品牌规范：#1F2A24/#F5F0E8，无外部Logo。目标设备：375px宽手机竖屏。章节顺序：差距—证据链—一周清单—CTA。",
      "可访问性：正文对比度不低于WCAG AA思路，图表提供文本摘要，键盘可按顺序阅读。部署限制：单文件HTML，不加载外部脚本、不执行发布。",
    ],
    8: [
      `${upstream || `已终审正文：${FULL_WRITER_DRAFT}`}`,
      "已终审正文：上游主产物只用于生成待人工发布包。封面与全部素材：成本率对比卡、证据链图、复盘清单、单文件HTML。",
      "目标平台：微信公众号、小红书、视频号。账号定位：面向餐饮老板的克制经营复盘。发布时间窗口：2026-08-03 09:00至2026-08-07 18:00，仅做人工排期建议。",
      "版权与广告合规：只用自制素材，不作效果承诺，不写未核验的价格、折扣、库存或平台规则。最终审批人：验收账号老板；未经审批不得操作外部账号。",
    ],
    9: [
      `${upstream || "分发官产物：已生成三平台待人工发布包与终审清单，没有执行外部发布。"}`,
      "发布记录（仅验收数据集内）：内容ID=NW-QA-PUB-20260730-01；平台字段=小红书；数据集记录时间=2026-07-30 10:00；该记录不声称已在任何外部平台发布。",
      "真实指标（验收数据集采集值）：阅读量842，收藏量37，评论量12；数据批次=METRIC-20260731-A，不外推为真实经营成效。",
      "历史基线（同一验收数据集）：阅读量700、收藏量30、评论量10。业务目标：验证“证据链清单”结构是否便于收藏。",
      "评论反馈：12条中4条追问领料表，3条追问盘点频率；异常情况：无外部投放数据，不得推断平台算法或自然流量权重。",
    ],
  };
  return inputs[idx] || [];
}

export function buildContentDispatch(
  profile,
  nonce,
  { acceptanceKind = "capability", lineage = null, demand = "" } = {},
) {
  const employee = profile?.identity || {};
  const idx = Number(employee.idx);
  const pipeline = acceptanceKind === "pipeline";
  const explicitDemand = String(
    demand || profile?.dispatch?.acceptanceDemand || "",
  ).trim();
  const acceptanceDemand =
    explicitDemand ||
    `请围绕${employee.name || `内容员工${idx}`}本次岗位任务核验公开信息并给出下一步可执行的业务结论。`;
  const acceptanceGatePlan = buildUnifiedAcceptancePlan({
    demand: acceptanceDemand,
    publicInfoRequired: true,
  });
  return {
    title:
      `[${pipeline ? "0→9真实流水线" : "真实API单岗能力验收"}] ${employee.name || `内容员工${idx}`}专属任务`.slice(
        0,
        100,
      ),
    type: profile?.dispatch?.defaultTaskType || "岗位交付",
    requirement: [
      `任务唯一标识：${nonce}`,
      `验收类型：${pipeline ? "content_pipeline" : "content_capability"}；执行岗位：${employee.name || idx}。`,
      `老板真实需求：${acceptanceDemand}`,
      "公开信息：真实联网/API核验；不反问老板，无法核验项标未知并给补查动作。",
      "必须使用真实云模型并严格按本岗位最终JSON输出契约交付完整主产物；补料说明、框架或非最终交付不算完成。",
      ...CONTENT_DATASET_FACTS,
      "本岗完整输入：",
      ...capabilityInputs(idx, { pipeline, lineage }),
      "发布边界：只生成可审阅岗位产物；不得登录账号、不得定时、不得发布、不得投放、不得声称外部动作已完成。",
    ].join("\n"),
    industry: "餐饮门店经营内容",
    feedback: "优先事实准确、岗位契约完整和上游血缘一致；不得用猜测补齐。",
    acceptanceDemand,
    acceptanceGatePlan,
    acceptanceDemandValid: isSingleSentenceDemand(acceptanceDemand),
    ...(lineage?.fileId ? { fileIds: [lineage.fileId] } : {}),
  };
}

export function validateContentDispatchEvidence(
  dispatch,
  idx,
  { acceptanceKind = "capability", lineage = null } = {},
) {
  const requirement = String(dispatch?.requirement || "");
  const errors = [];
  if (
    !dispatch?.title ||
    !requirement ||
    !dispatch?.industry ||
    !dispatch?.feedback
  ) {
    errors.push("内容岗位任务书缺少标题、要求、行业或质量反馈");
  }
  const demandMatch = requirement.match(/^老板真实需求：(.+)$/mu);
  const acceptanceDemand = String(dispatch?.acceptanceDemand || "").trim();
  if (!demandMatch || !isSingleSentenceDemand(demandMatch[1])) {
    errors.push("统一验收门禁缺少一句有效的老板真实需求");
  } else if (acceptanceDemand && demandMatch[1].trim() !== acceptanceDemand) {
    errors.push("内容派活中的老板真实需求与dispatch.acceptanceDemand不一致");
  }
  if (!requirement.includes("公开信息：真实联网/API核验；不反问老板")) {
    errors.push("统一验收门禁缺少公开信息自行联网且不得反问老板边界");
  }
  for (const marker of CONTENT_REQUIRED_MARKERS[Number(idx)] || []) {
    if (!requirement.includes(marker))
      errors.push(`缺少本岗必需输入“${marker}”`);
  }
  if (
    !/营业额100000元/u.test(requirement) ||
    !/食材成本35000元/u.test(requirement) ||
    !/订单2000单/u.test(requirement)
  ) {
    errors.push("缺少验收数据集事实白名单");
  }
  if (Number(idx) === 4) {
    if (
      !requirement.includes("账号人设") ||
      !requirement.includes("语气规则")
    ) {
      errors.push("文风师缺少账号人设和语气规则");
    }
    if (
      acceptanceKind === "capability" &&
      !requirement.includes(FULL_WRITER_DRAFT)
    ) {
      errors.push("文风师单岗能力验收必须提供完整原稿");
    }
  }
  if (Number(idx) === 9) {
    if (
      !/内容ID=NW-QA-PUB-/u.test(requirement) ||
      !/(?:阅读|曝光|播放)量\d+/u.test(requirement)
    ) {
      errors.push("复盘官必须有验收数据集内的发布记录和至少一项真实指标");
    }
    if (!requirement.includes("不声称已在任何外部平台发布")) {
      errors.push("复盘官验收数据必须明确不代表外部发布");
    }
  }
  if (acceptanceKind === "pipeline" && Number(idx) > 0) {
    const checked = validateContentLineageInput(lineage);
    if (!checked.valid) errors.push(...checked.errors);
    if (
      !Array.isArray(dispatch.fileIds) ||
      dispatch.fileIds.length !== 1 ||
      Number(dispatch.fileIds[0]) !== Number(lineage?.fileId)
    ) {
      errors.push("流水线任务未绑定唯一上游原文附件");
    }
  }
  return { valid: errors.length === 0, errors };
}

function contentHash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex");
}

export function createContentLineageEnvelope({
  fromIdx,
  sourceRunId,
  sourceArtifactContent,
  sourceArtifactHash,
} = {}) {
  const content = String(sourceArtifactContent || "");
  const calculatedHash = contentHash(content);
  const declaredHash = String(
    sourceArtifactHash || calculatedHash,
  ).toLowerCase();
  const filename = `content-pipeline-${Number(fromIdx)}-run-${Number(sourceRunId)}-${declaredHash.slice(0, 12)}.md`;
  const envelope = [
    "【NANOWORK_CONTENT_PIPELINE_LINEAGE_V1】",
    `sourceStage=${Number(fromIdx)}`,
    `sourceRunId=${Number(sourceRunId)}`,
    `sourceArtifactSha256=${declaredHash}`,
    `sourceArtifactChars=${[...content].length}`,
    `待改写完整原稿：${content.replace(/\s+/gu, " ").slice(0, 240)}`,
    "【PRIMARY_ARTIFACT_ORIGINAL_BEGIN】",
    content,
    "【PRIMARY_ARTIFACT_ORIGINAL_END】",
  ].join("\n");
  return {
    fromIdx: Number(fromIdx),
    sourceRunId: Number(sourceRunId),
    sourceArtifactHash: declaredHash,
    calculatedArtifactHash: calculatedHash,
    sourceArtifactChars: [...content].length,
    sourceArtifactContent: content,
    filename,
    envelope,
    envelopeHash: contentHash(envelope),
  };
}

export function validateContentLineageInput(lineage) {
  const errors = [];
  if (!lineage || typeof lineage !== "object")
    return { valid: false, errors: ["缺少上游血缘对象"] };
  if (
    !Number.isSafeInteger(Number(lineage.fromIdx)) ||
    Number(lineage.fromIdx) < 0 ||
    Number(lineage.fromIdx) > 8
  ) {
    errors.push("上游阶段编号无效");
  }
  if (
    !Number.isSafeInteger(Number(lineage.sourceRunId)) ||
    Number(lineage.sourceRunId) <= 0
  ) {
    errors.push("上游source run id无效");
  }
  const content = String(lineage.sourceArtifactContent || "");
  if (!content.trim()) errors.push("上游主产物原文为空");
  if (content.length > 15_500) {
    errors.push("上游主产物超出当前附件逐字传递上限，禁止截断后继续");
  }
  const expectedHash = contentHash(content);
  if (
    !/^[a-f0-9]{64}$/u.test(String(lineage.sourceArtifactHash || "")) ||
    String(lineage.sourceArtifactHash).toLowerCase() !== expectedHash
  ) {
    errors.push("上游主产物sha256与原文不一致");
  }
  if (
    !String(lineage.envelope || "").includes(
      "【PRIMARY_ARTIFACT_ORIGINAL_BEGIN】",
    ) ||
    !String(lineage.envelope || "").includes(content) ||
    contentHash(lineage.envelope) !==
      String(lineage.envelopeHash || "").toLowerCase()
  ) {
    errors.push("上游原文信封不完整或信封哈希不一致");
  }
  if (String(lineage.envelope || "").length > 16_000) {
    errors.push("上游原文信封超出附件正文提取上限，禁止截断传递");
  }
  if (
    lineage.fileId != null &&
    (!Number.isSafeInteger(Number(lineage.fileId)) ||
      Number(lineage.fileId) <= 0)
  ) {
    errors.push("上游原文附件ID无效");
  }
  return { valid: errors.length === 0, errors };
}

export function validateContentLineageEdge(
  edge,
  upstreamStage,
  downstreamStage,
) {
  const errors = [];
  if (!edge || typeof edge !== "object")
    return { valid: false, errors: ["缺少lineage edge"] };
  if (
    edge.schemaVersion === "nanowork.content-production-pipeline-lineage/1"
  ) {
    const pipelineId = Number(edge.pipelineId);
    const expectedStationKeys = Array.from(
      { length: Number(edge.toIdx) },
      (_, idx) => String(idx),
    );
    if (!Number.isSafeInteger(pipelineId) || pipelineId <= 0)
      errors.push("edge缺少真实pipeline id");
    if (
      Number(upstreamStage?.pipelineId) !== pipelineId ||
      Number(downstreamStage?.pipelineId) !== pipelineId
    ) {
      errors.push("edge与上下游工位不属于同一真实流水线");
    }
    if (upstreamStage?.pipelinePass !== true)
      errors.push("上游阶段未通过流水线质量门");
    if (upstreamStage?.billingState !== "settled")
      errors.push("上游阶段未完成真实结算");
    if (upstreamStage?.reviewDecision !== "adopt")
      errors.push("上游阶段未经人工采纳");
    if (Number(edge.fromIdx) + 1 !== Number(edge.toIdx))
      errors.push("edge不是相邻内容工位");
    if (
      Number(edge.fromIdx) !== Number(upstreamStage?.idx) ||
      Number(edge.toIdx) !== Number(downstreamStage?.idx)
    ) {
      errors.push("edge岗位编号与阶段不一致");
    }
    if (
      String(edge.sourceOutputFingerprint || "") !==
      `sha256:${String(upstreamStage?.primaryArtifactHash || "")}`
    ) {
      errors.push("edge上游产物指纹与已完成工位不一致");
    }
    if (
      edge.source !== "database_persisted_completed_stations_only" ||
      edge.verified !== true ||
      edge.upstreamSynthesized !== false ||
      downstreamStage?.upstreamSynthesized !== false
    ) {
      errors.push("edge没有证明上游来自数据库已完成产物");
    }
    if (
      JSON.stringify(edge.downstreamStationKeys || []) !==
        JSON.stringify(expectedStationKeys) ||
      JSON.stringify(downstreamStage?.upstreamStationKeys || []) !==
        JSON.stringify(expectedStationKeys)
    ) {
      errors.push("下游没有加载当前工位之前的全部真实上游");
    }
    if (
      String(edge.downstreamUpstreamFingerprint || "") !==
      String(downstreamStage?.upstreamSetFingerprint || "")
    ) {
      errors.push("下游上游集合指纹与edge不一致");
    }
    return { valid: errors.length === 0, errors };
  }
  if (upstreamStage?.pipelinePass !== true)
    errors.push("上游阶段未通过流水线质量门");
  if (upstreamStage?.billingState !== "settled")
    errors.push("上游阶段未完成真实结算");
  if (upstreamStage?.reviewDecision !== "adopt")
    errors.push("上游阶段未经采纳");
  if (Number(edge.sourceRunId) !== Number(upstreamStage?.businessId))
    errors.push("edge sourceRunId与上游任务不一致");
  if (Number(edge.targetRunId) !== Number(downstreamStage?.businessId))
    errors.push("edge targetRunId与下游任务不一致");
  if (Number(edge.fromIdx) + 1 !== Number(edge.toIdx))
    errors.push("edge不是相邻内容工位");
  if (
    Number(edge.fromIdx) !== Number(upstreamStage?.idx) ||
    Number(edge.toIdx) !== Number(downstreamStage?.idx)
  ) {
    errors.push("edge岗位编号与阶段不一致");
  }
  if (
    !/^[a-f0-9]{64}$/u.test(String(edge.sourceArtifactHash || "")) ||
    String(edge.sourceArtifactHash) !==
      String(upstreamStage?.primaryArtifactHash || "")
  ) {
    errors.push("edge主产物哈希与上游不一致");
  }
  if (
    String(edge.sourceArtifactHash || "") !==
    String(downstreamStage?.upstreamArtifactHash || "")
  ) {
    errors.push("下游读回的上游哈希与edge不一致");
  }
  if (
    !/^[a-f0-9]{64}$/u.test(String(edge.envelopeHash || "")) ||
    String(edge.envelopeHash) !==
      String(downstreamStage?.lineageEnvelopeHash || "") ||
    String(edge.envelopeHash) !==
      String(downstreamStage?.readbackAttachmentHash || "")
  ) {
    errors.push("edge原文信封哈希未被下游附件原样读回");
  }
  return { valid: errors.length === 0, errors };
}

function uniqueJobAttemptRows(jobs) {
  const rows = [];
  const seenAttemptIds = new Set();
  for (const [jobKey, item] of Object.entries(jobs)) {
    const attempts = Array.isArray(item?.attempts) && item.attempts.length
      ? item.attempts
      : item?.latest
        ? [item.latest]
        : [];
    attempts.forEach((row, index) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return;
      const attemptId = text(row.attemptId);
      const identity = attemptId
        ? `attempt:${attemptId}`
        : `legacy:${jobKey}:${index}`;
      if (seenAttemptIds.has(identity)) return;
      seenAttemptIds.add(identity);
      rows.push(row);
    });
  }
  return rows;
}

function providerCallCounts(rows) {
  let providerAttemptCount = 0;
  let verifiedApiCallCount = 0;
  for (const row of rows) {
    const attempts = projectProviderAttempts(row?.providerAttempts);
    if (attempts.length) {
      providerAttemptCount += attempts.length;
      verifiedApiCallCount += attempts.filter(
        (attempt) =>
          attempt.apiObtained === true &&
          attempt.mode === "api" &&
          text(attempt.model) &&
          !FORBIDDEN_PROVIDER.test(attempt.model) &&
          Number(attempt.usage?.inputTokens) > 0 &&
          Number(attempt.usage?.outputTokens) > 0,
      ).length;
      continue;
    }
    const hasProviderAttempt =
      row?.providerMode === "api" ||
      providerUsageTokens(row, "providerInputTokens", "inputTokens") +
        providerUsageTokens(row, "providerOutputTokens", "outputTokens") >
        0;
    if (!hasProviderAttempt) continue;
    providerAttemptCount += 1;
    if (validateProviderInvocationEvidence(row).valid) {
      verifiedApiCallCount += 1;
    }
  }
  return { providerAttemptCount, verifiedApiCallCount };
}

function customerLedgerAggregate(rows) {
  const unique = new Map();
  let duplicateSettlementReferences = 0;
  rows.forEach((row, index) => {
    const hasLedgerEvidence =
      Number(row?.billingId) > 0 ||
      Number(row?.creditLogId) > 0 ||
      ["settled", "released"].includes(String(row?.billingState || ""));
    if (!hasLedgerEvidence) return;
    const authoritativeKey =
      Number(row?.tenantId) > 0 &&
      Number(row?.billingId) > 0 &&
      Number(row?.creditLogId) > 0
        ? `ledger:${Number(row.tenantId)}:${Number(row.billingId)}:${Number(row.creditLogId)}`
        : `unlinked:${text(row?.attemptId) || index}`;
    if (unique.has(authoritativeKey)) {
      duplicateSettlementReferences += 1;
      return;
    }
    unique.set(authoritativeKey, row);
  });
  const ledgerRows = [...unique.values()];
  const chargedCostValues = ledgerRows.map((row) =>
    finiteNonNegative(row.chargedCostYuan),
  );
  const chargedCreditValues = ledgerRows.map((row) =>
    finiteNonNegative(row.chargedCredits),
  );
  const costComplete = chargedCostValues.every((value) => value != null);
  const creditsComplete = chargedCreditValues.every((value) => value != null);
  return {
    uniqueSettlementCount: ledgerRows.length,
    duplicateSettlementReferences,
    chargedCostYuan: costComplete
      ? Math.round(
          chargedCostValues.reduce((sum, value) => sum + value, 0) * 10000,
        ) / 10000
      : null,
    chargedCredits: creditsComplete
      ? chargedCreditValues.reduce((sum, value) => sum + value, 0)
      : null,
    costComplete,
    creditsComplete,
    fullRefundCount: ledgerRows.filter((row) => row.fullRefund === true).length,
  };
}

function accountingScope(rows, scope) {
  const providerUsageRows = rows.filter(
    (row) =>
      providerUsageTokens(row, "providerInputTokens", "inputTokens") +
        providerUsageTokens(row, "providerOutputTokens", "outputTokens") >
      0,
  );
  const pricedProviderUsageRows = providerUsageRows.filter(
    (row) => row.providerCostEstimate?.estimated === true,
  );
  const providerEstimateComplete =
    providerUsageRows.length > 0 &&
    pricedProviderUsageRows.length === providerUsageRows.length;
  const providerEstimatedCostYuan = providerEstimateComplete
    ? roundedYuan(
        pricedProviderUsageRows.reduce(
          (sum, row) => sum + Number(row.providerEstimatedCostYuan || 0),
          0,
        ),
      )
    : null;
  return {
    scope,
    matrixAttemptCount: rows.length,
    ...providerCallCounts(rows),
    providerUsage: {
      inputTokens: rows.reduce(
        (sum, row) =>
          sum + providerUsageTokens(row, "providerInputTokens", "inputTokens"),
        0,
      ),
      outputTokens: rows.reduce(
        (sum, row) =>
          sum +
          providerUsageTokens(row, "providerOutputTokens", "outputTokens"),
        0,
      ),
    },
    providerEstimatedCostYuan,
    providerEstimatedCostCoverage: {
      pricedRows: pricedProviderUsageRows.length,
      providerUsageRows: providerUsageRows.length,
      complete: providerEstimateComplete,
    },
    webResearch: webResearchAggregate(rows),
    customerLedger: customerLedgerAggregate(rows),
  };
}

function costSemanticsForSummary(row, fallbackPricingSnapshot) {
  if (
    row?.providerCostEstimate &&
    typeof row.providerCostEstimate === "object" &&
    !Array.isArray(row.providerCostEstimate) &&
    Object.hasOwn(row, "providerEstimatedCostYuan")
  ) {
    // 每次真实调用完成时已经把当时的价格来源、费率与估算结果锁进attempt。
    // 后续force复跑可能拿到新的价格快照；汇总历史attempt时不得用新价格倒灌改写旧成本。
    return row;
  }
  return applyProviderCostSemantics(row, fallbackPricingSnapshot);
}

export function summarizeState(state = {}) {
  const safeState =
    state && typeof state === "object" && !Array.isArray(state) ? state : {};
  const jobs =
    safeState.jobs &&
    typeof safeState.jobs === "object" &&
    !Array.isArray(safeState.jobs)
      ? safeState.jobs
      : {};
  const pipeline =
    safeState.pipeline &&
    typeof safeState.pipeline === "object" &&
    !Array.isArray(safeState.pipeline)
      ? safeState.pipeline
      : {};
  const pipelineStageMap =
    pipeline.stages &&
    typeof pipeline.stages === "object" &&
    !Array.isArray(pipeline.stages)
      ? pipeline.stages
      : {};
  const pricingSnapshot =
    safeState.providerPricingSnapshot ||
    safeState.runtimeEvidence?.providerPricingSnapshot ||
    null;
  const rows = Object.values(jobs)
    .map((item) => item?.latest)
    .filter(Boolean)
    .map((row) => costSemanticsForSummary(row, pricingSnapshot));
  const cumulativeRows = uniqueJobAttemptRows(jobs).map((row) =>
    costSemanticsForSummary(row, pricingSnapshot),
  );
  const currentAccounting = accountingScope(rows, "latest_per_job");
  const cumulativeAccounting = accountingScope(
    cumulativeRows,
    "all_unique_jobs_attempts",
  );
  const capabilityPassedRows = rows.filter(
    (row) =>
      row.capabilityPass === true ||
      (row.capabilityPass == null && row.pass === true),
  );
  const businessProductionPassedRows = rows.filter(
    (row) =>
      row.businessProductionPass === true ||
      (row.businessProductionPass == null &&
        row.pass === true &&
        row.reviewDecision === "adopt"),
  );
  const passed = capabilityPassedRows.length;
  const failed = rows.filter((row) => row.verdict === "FAIL_REAL_API").length;
  const blocked = rows.filter((row) => String(row.verdict || "").startsWith("BLOCKED")).length;
  const running = rows.filter(
    (row) => !["PASS_REAL_API", "FAIL_REAL_API", "BLOCKED_VIDEO"].includes(row.verdict),
  ).length;
  const restaurantRows = rows.filter((row) => row.domain === "restaurant");
  const contentRows = rows.filter((row) => row.domain === "content");
  const restaurantCapabilityPassed = capabilityPassedRows.filter(
    (row) => row.domain === "restaurant",
  ).length;
  const contentCapabilityPassed = capabilityPassedRows.filter(
    (row) => row.domain === "content",
  ).length;
  const restaurantBusinessProductionPassed =
    businessProductionPassedRows.filter(
      (row) => row.domain === "restaurant",
    ).length;
  const contentBusinessProductionPassed = businessProductionPassedRows.filter(
    (row) => row.domain === "content",
  ).length;
  const restaurantOperationallyBlocked = restaurantRows.filter(
    (row) => row.capabilityPass === true && row.operationalReady === false,
  ).length;
  const pipelineStages = Object.values(pipelineStageMap)
    .map((item) => item?.latest || item)
    .filter(Boolean);
  const pipelinePassed = pipelineStages.filter(
    (row) => row.pipelinePass === true,
  ).length;
  const providerEstimatedCostYuan =
    currentAccounting.providerEstimatedCostYuan;
  const chargedCostYuan = currentAccounting.customerLedger.chargedCostYuan;
  const chargedCredits = currentAccounting.customerLedger.chargedCredits;
  const fullRefundCount = currentAccounting.customerLedger.fullRefundCount;
  return {
    total: rows.length,
    passed,
    capabilityPass: passed,
    businessEmployeePass: businessProductionPassedRows.length,
    businessProductionPass: businessProductionPassedRows.length,
    failed,
    blocked,
    running,
    restaurant: {
      total: restaurantRows.length,
      passed: restaurantCapabilityPassed,
      capabilityPassed: restaurantCapabilityPassed,
      businessProductionPassed: restaurantBusinessProductionPassed,
      operationallyBlockedAfterCapabilityPass: restaurantOperationallyBlocked,
    },
    content: {
      total: contentRows.length,
      passed: contentCapabilityPassed,
      capabilityPassed: contentCapabilityPassed,
      businessProductionPassed: contentBusinessProductionPassed,
    },
    pipeline: {
      enabled: pipeline.enabled === true,
      stages: pipelineStages.length,
      passed: pipelinePassed,
      expected: pipeline.enabled === true ? CONTENT_PIPELINE_STAGE_COUNT : 0,
      complete:
        pipeline.enabled === true &&
        pipelineStages.length === CONTENT_PIPELINE_STAGE_COUNT &&
        pipelinePassed === CONTENT_PIPELINE_STAGE_COUNT,
    },
    tokens: {
      input: rows.reduce((sum, row) => sum + (Number(row.inputTokens) || 0), 0),
      output: rows.reduce(
        (sum, row) => sum + (Number(row.outputTokens) || 0),
        0,
      ),
    },
    providerUsage: currentAccounting.providerUsage,
    providerEstimatedCostYuan,
    providerEstimatedCostCoverage:
      currentAccounting.providerEstimatedCostCoverage,
    webResearch: currentAccounting.webResearch,
    cumulativeWebResearch: cumulativeAccounting.webResearch,
    chargedCostYuan,
    chargedCredits,
    qualityGateRefundedCount: fullRefundCount,
    fullRefundCount,
    current: currentAccounting,
    cumulative: cumulativeAccounting,
    currentProviderUsage: currentAccounting.providerUsage,
    cumulativeProviderUsage: cumulativeAccounting.providerUsage,
    currentProviderAttemptCount: currentAccounting.providerAttemptCount,
    cumulativeProviderAttemptCount:
      cumulativeAccounting.providerAttemptCount,
    currentVerifiedApiCallCount: currentAccounting.verifiedApiCallCount,
    cumulativeVerifiedApiCallCount:
      cumulativeAccounting.verifiedApiCallCount,
    currentProviderEstimatedCostYuan:
      currentAccounting.providerEstimatedCostYuan,
    cumulativeProviderEstimatedCostYuan:
      cumulativeAccounting.providerEstimatedCostYuan,
    currentWebResearch: currentAccounting.webResearch,
    cumulativeWebResearchCostUsd: cumulativeAccounting.webResearch.costUsd,
    currentChargedCostYuan: currentAccounting.customerLedger.chargedCostYuan,
    cumulativeChargedCostYuan:
      cumulativeAccounting.customerLedger.chargedCostYuan,
    currentChargedCredits: currentAccounting.customerLedger.chargedCredits,
    cumulativeChargedCredits:
      cumulativeAccounting.customerLedger.chargedCredits,
    // Deprecated aliases retained so older report consumers do not break.
    costYuan: chargedCostYuan,
    costYuanDeprecated: true,
    costYuanDeprecatedMeaning: "alias_of_chargedCostYuan_customer_ledger",
    credits: chargedCredits,
    creditsDeprecated: true,
    creditsDeprecatedMeaning: "alias_of_chargedCredits_customer_ledger",
  };
}

export function createInitialState({ baseUrl, selectedJobs, concurrency }) {
  const pipelineEnabled = CONTENT_PIPELINE_INDEXES.every((idx) =>
    selectedJobs.includes(employeeKey("content", idx)),
  );
  return {
    schemaVersion: REAL_MATRIX_SCHEMA,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    evidencePolicy: {
      provider: "real_cloud_api_only",
      rejectedModes: ["template", "failed", "mock", "fixture", "fallback"],
      requiresPositiveTokenUsage: true,
      requiresSettledBilling: true,
      requiresValidContract: true,
      requiresRunnerContractRevalidation: true,
      contentAcceptance: {
        capabilityEmployees: 11,
        pipelineStages: 10,
        pipelineDoesNotReplaceEmployeeCount: true,
      },
      restaurantAcceptance: {
        qaCapabilityUsesIsolatedDataset: true,
        operationalReadinessIsIndependent: true,
        operationallyBlockedOutputMustBeRejected: true,
        capabilityPassNeverMeansBusinessProductionPass: true,
      },
      costSemantics: REAL_MATRIX_COST_SEMANTICS,
      externalPublish: false,
    },
    run: {
      baseUrl,
      selectedJobs,
      concurrency,
    },
    jobs: {},
    pipeline: {
      enabled: pipelineEnabled,
      mode: "sequential_0_to_9",
      stages: {},
      edges: [],
    },
    summary: { total: 0, passed: 0, failed: 0, running: 0 },
  };
}

export function mergeAttempt(state, key, attempt) {
  const previous = state.jobs?.[key] || { attempts: [] };
  const attempts = [
    ...(Array.isArray(previous.attempts) ? previous.attempts : []),
    attempt,
  ];
  state.jobs ||= {};
  state.jobs[key] = { latest: attempt, attempts };
  state.updatedAt = new Date().toISOString();
  state.summary = summarizeState(state);
  return state;
}
