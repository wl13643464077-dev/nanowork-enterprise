import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  REAL_MATRIX_DEFAULT_JOB_TIMEOUT_MS,
  REAL_MATRIX_SCHEMA,
  applyProviderCostSemantics,
  buildContentDispatch,
  buildJobs,
  buildRestaurantMatrixGateDispatch,
  buildRestaurantDispatch,
  buildRestaurantRequiredInputEvidence,
  classifyAttempt,
  classifyProviderEvidence,
  classifyRestaurantRequiredInput,
  createContentLineageEnvelope,
  createInitialState,
  createProviderPricingSnapshot,
  employeeKey,
  evaluateRestaurantMatrixOutputEvidence,
  formatAttemptCostForCli,
  formatSummaryCostForCli,
  isRealProviderEvidence,
  isLoopbackServiceBaseUrl,
  isOfficialYunwuBaseUrl,
  mergeRunSelection,
  mergeAttempt,
  parseOnlyFilter,
  projectProviderBudget,
  projectProviderAttempts,
  restaurantRequiredInputTags,
  summarizeProviderAttempts,
  summarizeWebResearchEvidence,
  summarizeState,
  validateContentDispatchEvidence,
  validateContentProfileCompleteness,
  validateContentProfileExecutionChain,
  validateContentLineageEdge,
  validateContentLineageInput,
  validateAttemptInvocation,
  validateRestaurantDispatchEvidence,
  validateProviderInvocationEvidence,
} from "../../scripts/lib/real-employee-matrix.mjs";
import { validateContentEmployeeOutputContract } from "../src/engines/content-output-contract.js";
import { loadRestaurantCatalog } from "../src/catalog/restaurant.js";
import { VALID_CONTENT_EMPLOYEE_OUTPUTS } from "./helpers/content-output-fixtures.mjs";
import { buildContentEmployeeWorkbenchProfile } from "../src/engines/content-employee-workbench.js";
import {
  auditRestaurantMaterialCoverage,
  restaurantMaterialAuditMarkdown,
} from "../../scripts/lib/restaurant-material-coverage-audit.mjs";
import { assessRestaurantTaskCompleteness } from "../../scripts/lib/restaurant-required-input-facts.mjs";

const RESTAURANT_CATALOG = loadRestaurantCatalog();
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const RUNNER = path.join(ROOT, "scripts", "run-real-employee-matrix.mjs");

function catalogProfile(employee) {
  return {
    identity: {
      idx: employee.idx,
      key: employee.key,
      name: employee.name,
      duty: employee.duty,
    },
    dispatch: {
      defaultTaskType: "执行方案",
      requiredInputs: employee.inputs,
      guidance: {
        taskExamples: [employee.duty],
        deliverableChecklist: employee.deliverables,
      },
    },
  };
}

function dispatchRegulatorySnapshot(dispatch) {
  for (const line of String(dispatch?.requirement || '').split('\n')) {
    const bodyAt = line.indexOf('正文=');
    if (bodyAt < 0) continue;
    try {
      const evidence = JSON.parse(line.slice(bodyAt + '正文='.length));
      const regulation = evidence?.fields?.facts?.regulation;
      if (!regulation) continue;
      const blockers = [
        evidence?.realWorldBlockers,
        regulation?.realWorldBlockers,
        regulation?.QA_ONLY_PROOF?.originalOperationalBlockers,
      ].flatMap((items) => Array.isArray(items) ? items.map(String) : []);
      const qaOnly = evidence?.qaOnlyRegulatoryProof === true
        || regulation?.QA_ONLY === true
        || regulation?.结论状态 === 'QA_ONLY'
        || regulation?.数据性质 === 'QA_ONLY_SYNTHETIC';
      return { qaOnly, regulation, realWorldBlockers: [...new Set(blockers)] };
    } catch {
      // The dispatch validator reports malformed JSON; this helper only
      // extracts the first parseable regulation record for assertions.
    }
  }
  return { qaOnly: false, regulation: null, realWorldBlockers: [] };
}

function passingRow(overrides = {}) {
  return {
    domain: "restaurant",
    idx: 101,
    businessId: 123,
    invocationId: "batch-1",
    aiMode: "api",
    model: "gpt-5.5",
    inputTokens: 300,
    outputTokens: 200,
    providerMode: "api",
    providerModel: "gpt-5.5",
    providerInputTokens: 300,
    providerOutputTokens: 200,
    providerEvidence: "real_cloud_api",
    providerEvidenceValid: true,
    billingState: "settled",
    heldCredits: 75,
    settledCredits: 75,
    tenantId: 801,
    userId: 91,
    billingTenantId: 801,
    creditLogTenantId: 801,
    billingUserId: 91,
    creditLogUserId: 91,
    billingId: 455,
    billingHoldLogId: 456,
    billingHoldCount: 1,
    billingCreditLogCount: 1,
    billingRefType: "agent_task",
    billingRefId: 123,
    billingFeature: "数字员工任务",
    creditLogFeature: "数字员工任务",
    billingKind: "text",
    creditLogKind: "text",
    billingHoldModel: "gpt-5.5",
    creditLogModel: "gpt-5.5",
    creditLogCredits: 75,
    balanceBefore: 1_000_000,
    balanceAfter: 999_925,
    tenantBalance: 999_925,
    billingBaselineHoldId: 454,
    billingBaselineLogId: 455,
    billingBalanceWindowHoldCount: 1,
    billingBalanceWindowConcurrentHoldCount: 0,
    billingBalanceWindowInvalidCount: 0,
    billingBalanceWindowAmbiguousTimestampCount: 0,
    billingBalanceWindowTargetCount: 1,
    billingBalanceWindowCurrentDebit: 75,
    billingBalanceWindowSettlementDebit: 75,
    billingExpectedCurrentBalance: 999_925,
    billingExpectedSettlementBalance: 999_925,
    billingTargetSettledAt: "2026-08-01 01:00:00",
    billingAiMode: "api",
    billingModel: "gpt-5.5",
    billingInputTokens: 300,
    billingOutputTokens: 200,
    billingLinkValid: true,
    billingFreshForAttempt: true,
    creditLogId: 456,
    chargedCredits: 75,
    contractValid: true,
    semanticValid: true,
    inputEvidenceValid: true,
    outputId: 234,
    primaryArtifactCount: 1,
    resultChars: 800,
    resultHash: "a".repeat(64),
    resultHashValid: true,
    artifactHashValid: true,
    reviewDecision: "adopt",
    reviewId: 345,
    assetId: 567,
    knowledgeId: 678,
    terminalStatus: "已完成",
    outputStatus: "可使用",
    businessFlowStatus: "approved",
    businessFlowTerminal: true,
    businessFlowComplete: true,
    businessFlowBillingSettled: true,
    externalPublish: false,
    contentProfileChainValid: true,
    ...overrides,
  };
}

function createReconcileOnlyFixture(tempDir) {
  const databasePath = path.join(tempDir, "isolated.db");
  const reportPath = path.join(tempDir, "matrix.json");
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE tenants (id INTEGER PRIMARY KEY, credits INTEGER NOT NULL);
    CREATE TABLE sys_config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE credit_holds (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      log_id INTEGER,
      status TEXT NOT NULL,
      feature TEXT,
      kind TEXT,
      model TEXT,
      held_credits INTEGER NOT NULL,
      settled_credits INTEGER NOT NULL,
      ref_type TEXT,
      ref_id INTEGER,
      created_at TEXT,
      settled_at TEXT
    );
    CREATE TABLE credit_logs (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      feature TEXT,
      kind TEXT,
      model TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_yuan REAL NOT NULL,
      credits INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      ai_mode TEXT,
      created_at TEXT
    );
  `);
  const now = Date.now();
  const createdAt = new Date(now - 60_000).toISOString();
  const concurrentCreatedAt = new Date(now - 45_000).toISOString();
  const targetSettledAt = new Date(now - 30_000).toISOString();
  const concurrentSettledAt = new Date(now - 10_000).toISOString();
  const dispatchedAt = new Date(now - 75_000).toISOString();
  db.prepare("INSERT INTO tenants(id,credits) VALUES(?,?)").run(
    801,
    999_805,
  );
  db.prepare("INSERT INTO sys_config(key,value) VALUES(?,?)").run(
    "real_employee_matrix_isolated:801",
    "REAL_EMPLOYEE_MATRIX_ISOLATED_V1",
  );
  db.prepare(
    `INSERT INTO credit_holds(
      id,tenant_id,user_id,log_id,status,feature,kind,model,
      held_credits,settled_credits,ref_type,ref_id,created_at,settled_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    455,
    801,
    91,
    456,
    "settled",
    "数字员工任务",
    "text",
    "gpt-5.5",
    75,
    75,
    "agent_task",
    123,
    createdAt,
    targetSettledAt,
  );
  db.prepare(
    `INSERT INTO credit_holds(
      id,tenant_id,user_id,log_id,status,feature,kind,model,
      held_credits,settled_credits,ref_type,ref_id,created_at,settled_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    456,
    801,
    91,
    457,
    "settled",
    "并发任务",
    "text",
    "gpt-5.5",
    200,
    120,
    "agent_task",
    124,
    concurrentCreatedAt,
    concurrentSettledAt,
  );
  db.prepare(
    `INSERT INTO credit_logs(
      id,tenant_id,user_id,feature,kind,model,input_tokens,output_tokens,
      cost_yuan,credits,balance_after,ai_mode,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    456,
    801,
    91,
    "数字员工任务",
    "text",
    "gpt-5.5",
    300,
    200,
    0.5,
    75,
    999_725,
    "api",
    createdAt,
  );
  db.close();

  const canonicalDatabasePath = fs.realpathSync.native(databasePath);
  const stat = fs.statSync(canonicalDatabasePath);
  const databaseIdentity = `${stat.dev}:${stat.ino}`;
  const row = passingRow({
    attemptId: "reconcile-attempt-1",
    phase: "reviewed",
    acceptanceKind: "capability",
    qaCapabilityRunnable: true,
    operationalReady: false,
    operationalBlockReasons: ["QA材料可跑，业务生产材料未齐"],
    reviewDecision: "reject",
    terminalStatus: "已驳回",
    outputStatus: "已驳回",
    assetId: null,
    knowledgeId: null,
    businessFlowStatus: "review_rejected",
    balanceAfter: 999_725,
    tenantBalance: 999_725,
    dispatchedAt,
    ledgerBaseline: { balance: 1_000_000, holdId: 454, logId: 455 },
    billingCreatedAt: createdAt,
    pass: false,
    capabilityPass: false,
    businessProductionPass: false,
    verdict: "FAIL_REAL_API",
    failureReasons: ["旧验收器未计入并发hold"],
  });
  for (const field of [
    "billingBalanceWindowHoldCount",
    "billingBalanceWindowConcurrentHoldCount",
    "billingBalanceWindowInvalidCount",
    "billingBalanceWindowAmbiguousTimestampCount",
    "billingBalanceWindowTargetCount",
    "billingBalanceWindowCurrentDebit",
    "billingBalanceWindowSettlementDebit",
    "billingExpectedCurrentBalance",
    "billingExpectedSettlementBalance",
    "billingTargetSettledAt",
  ]) {
    delete row[field];
  }
  const state = createInitialState({
    baseUrl: "http://127.0.0.1:9",
    selectedJobs: ["restaurant:101"],
    concurrency: 1,
  });
  state.run.invocations = [
    {
      id: "batch-1",
      startedAt: new Date(now - 120_000).toISOString(),
      selectedJobs: ["restaurant:101"],
      runtimeEvidence: {
        available: true,
        provider: "云雾API (yunwu.ai)",
      },
    },
  ];
  state.billingEvidenceSource = {
    kind: "sqlite_read_only",
    path: canonicalDatabasePath,
    identity: databaseIdentity,
    authoritative: true,
    noteFallbackAllowed: false,
  };
  state.jobs["restaurant:101"] = {
    attempts: [structuredClone(row)],
    latest: structuredClone(row),
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    databasePath: canonicalDatabasePath,
    reportPath,
    state,
    row,
  };
}

function runReconcileOnly({ databasePath, reportPath }) {
  const env = { ...process.env };
  delete env.MATRIX_USERNAME;
  delete env.MATRIX_PASSWORD;
  return spawnSync(
    process.execPath,
    [
      RUNNER,
      "--reconcile-only",
      "--base-url",
      "http://127.0.0.1:9",
      "--db",
      databasePath,
      "--out",
      reportPath,
      "--only",
      "restaurant:101",
    ],
    { cwd: ROOT, env, encoding: "utf8", timeout: 5_000 },
  );
}

test("真实矩阵只落脱敏providerAttempts，三轮timeout报告明确说明三轮超时", () => {
  const rawAttempts = Array.from({ length: 3 }, (_, index) => ({
    number: index + 1,
    phase: "acquire",
    mode: "error",
    model: null,
    apiObtained: false,
    succeeded: false,
    contractValid: null,
    failure: {
      code: "provider_timeout",
      status: 504,
      timedOut: true,
      retryable: true,
      summary: `原始超时错误 https://secret.example/${index}?key=sk-never-save`,
      rawError: "不得写入报告的原始错误",
    },
    usage: { inputTokens: 0, outputTokens: 0 },
    rawUrl: "https://secret.example/v1",
    body: "不得写入报告的供应商正文",
    apiKey: "sk-never-save",
  }));

  const providerAttempts = projectProviderAttempts(rawAttempts);
  assert.equal(providerAttempts.length, 3);
  assert.deepEqual(
    providerAttempts.map((item) => item.failure),
    Array.from({ length: 3 }, () => ({
      code: "provider_timeout",
      status: 504,
      timedOut: true,
      retryable: true,
      summary: "供应商响应超时",
    })),
  );
  assert.ok(
    providerAttempts.every(
      (item) =>
        Object.keys(item).join(",") ===
        [
          "number",
          "phase",
          "mode",
          "model",
          "apiObtained",
          "succeeded",
          "contractValid",
          "budgetClass",
          "failure",
          "usage",
        ].join(","),
    ),
  );
  const serialized = JSON.stringify(providerAttempts);
  assert.doesNotMatch(
    serialized,
    /secret\.example|sk-never-save|原始错误|供应商正文/u,
  );

  const providerAttemptSummary = summarizeProviderAttempts(providerAttempts);
  assert.equal(
    providerAttemptSummary,
    "共3轮供应商尝试：3轮超时，未取得真实API候选",
  );
  const result = classifyAttempt(
    passingRow({
      providerAttempts,
      providerAttemptSummary,
      providerEvidence: "unverified",
      providerEvidenceValid: false,
      providerMode: "error",
      providerModel: null,
      providerInputTokens: 0,
      providerOutputTokens: 0,
    }),
  );
  assert.equal(result.pass, false);
  assert.match(
    result.failureReasons.join("；"),
    /共3轮供应商尝试：3轮超时，未取得真实API候选/u,
  );
});

test("失败任务保留脱敏的尝试预算分类与providerBudget证据", () => {
  const providerAttempts = projectProviderAttempts([
    {
      number: 1,
      phase: "acquire",
      mode: "error",
      apiObtained: false,
      succeeded: false,
      contractValid: null,
      budgetClass: "transport",
      failure: {
        code: "provider_timeout",
        status: 504,
        timedOut: true,
        retryable: true,
        summary: "https://secret.example/?key=sk-never-save",
      },
      usage: { inputTokens: 0, outputTokens: 0 },
      apiKey: "sk-never-save",
    },
    {
      number: 2,
      phase: "acquire",
      mode: "api",
      model: "gpt-5.5",
      apiObtained: true,
      succeeded: true,
      contractValid: false,
      budgetClass: "candidate",
      usage: { inputTokens: 120, outputTokens: 80 },
      body: "不得写入报告的供应商正文",
    },
  ]);
  const providerBudget = projectProviderBudget({
    candidateLimit: 3,
    transportFailureLimit: 3,
    totalAttemptLimit: 6,
    wallClockLimitMs: 2_700_000,
    candidateAttempts: 1,
    transportFailures: 1,
    totalAttempts: 2,
    stoppedReason: "candidate_budget_exhausted",
    apiKey: "sk-never-save",
    body: "不得写入报告的供应商正文",
  });

  assert.deepEqual(
    providerAttempts.map((item) => item.budgetClass),
    ["transport", "candidate"],
  );
  assert.deepEqual(providerBudget, {
    candidateLimit: 3,
    transportFailureLimit: 3,
    totalAttemptLimit: 6,
    wallClockLimitMs: 2_700_000,
    candidateAttempts: 1,
    transportFailures: 1,
    totalAttempts: 2,
    stoppedReason: "candidate_budget_exhausted",
  });

  const result = classifyAttempt(
    passingRow({
      providerAttempts,
      providerBudget,
      providerMode: "api",
      providerModel: "gpt-5.5",
      providerInputTokens: 120,
      providerOutputTokens: 80,
      inputTokens: 120,
      outputTokens: 80,
      generationStatus: "失败",
      contractValid: false,
      contractErrors: ["RESTAURANT_OUTPUT_CONTRACT_INVALID"],
      semanticValid: false,
      semanticErrors: ["契约输出不可验收"],
      billingInputTokens: 0,
      billingOutputTokens: 0,
      chargedCredits: 0,
      creditLogCredits: 0,
      balanceAfter: 1_000_000,
      tenantBalance: 1_000_000,
      costYuan: 0,
      outputId: null,
      resultChars: 0,
      businessFlowStatus: "quality_failed",
      businessFlowBillingSettled: false,
    }),
  );
  assert.deepEqual(result.providerBudget, providerBudget);
  assert.deepEqual(
    result.providerAttempts.map((item) => item.budgetClass),
    ["transport", "candidate"],
  );
  const serialized = JSON.stringify({
    providerAttempts: result.providerAttempts,
    providerBudget: result.providerBudget,
  });
  assert.doesNotMatch(serialized, /secret\.example|sk-never-save|供应商正文/u);
});

test("三轮真实API候选均契约失败时，调用证据与质量门退款证据分离", () => {
  const providerAttempts = projectProviderAttempts([
    {
      number: 1,
      phase: "acquire",
      mode: "api",
      model: "gpt-5.5",
      apiObtained: true,
      succeeded: true,
      contractValid: false,
      usage: { inputTokens: 19_107, outputTokens: 11_817 },
    },
    {
      number: 2,
      phase: "repair",
      mode: "api",
      model: "gpt-5.5",
      apiObtained: true,
      succeeded: false,
      contractValid: false,
      usage: { inputTokens: 31_848, outputTokens: 11_867 },
    },
    {
      number: 3,
      phase: "repair",
      mode: "api",
      model: "gpt-5.5",
      apiObtained: true,
      succeeded: false,
      contractValid: false,
      usage: { inputTokens: 31_728, outputTokens: 12_265 },
    },
  ]);
  const inputTokens = providerAttempts.reduce(
    (sum, attempt) => sum + attempt.usage.inputTokens,
    0,
  );
  const outputTokens = providerAttempts.reduce(
    (sum, attempt) => sum + attempt.usage.outputTokens,
    0,
  );
  const row = passingRow({
    businessId: 23,
    billingRefId: 23,
    providerAttempts,
    providerAttemptSummary: summarizeProviderAttempts(providerAttempts),
    providerMode: "api",
    providerModel: "gpt-5.5",
    providerInputTokens: inputTokens,
    providerOutputTokens: outputTokens,
    aiMode: "api",
    model: "gpt-5.5",
    inputTokens,
    outputTokens,
    generationStatus: "失败",
    contractValid: false,
    contractErrors: ["RESTAURANT_OUTPUT_CONTRACT_INVALID"],
    semanticValid: false,
    semanticErrors: ["契约输出不可验收"],
    billingState: "settled",
    billingAiMode: "api",
    billingModel: "gpt-5.5",
    billingInputTokens: 0,
    billingOutputTokens: 0,
    chargedCredits: 0,
    creditLogCredits: 0,
    balanceAfter: 1_000_000,
    tenantBalance: 1_000_000,
    billingBalanceWindowCurrentDebit: 0,
    billingBalanceWindowSettlementDebit: 0,
    billingExpectedCurrentBalance: 1_000_000,
    billingExpectedSettlementBalance: 1_000_000,
    costYuan: 0,
    heldCredits: 75,
    settledCredits: 0,
    outputId: null,
    primaryArtifactCount: 0,
    resultChars: 0,
    resultHash: null,
    resultHashValid: false,
    artifactHashValid: false,
    reviewDecision: null,
    reviewId: null,
    assetId: null,
    knowledgeId: null,
    terminalStatus: "失败",
    outputStatus: null,
    businessFlowStatus: "quality_failed",
    businessFlowTerminal: true,
    businessFlowComplete: true,
    businessFlowBillingSettled: false,
  });

  const invocation = validateProviderInvocationEvidence(row);
  assert.equal(invocation.valid, true);
  assert.equal(invocation.apiObtainedAttempts, 3);
  assert.equal(invocation.verifiedApiAttempts, 3);

  const evidence = classifyProviderEvidence(row);
  assert.equal(evidence.providerEvidence, "real_cloud_api_invoked");
  assert.equal(evidence.providerEvidenceValid, true);
  assert.equal(evidence.providerInvocationEvidenceValid, true);
  assert.equal(evidence.providerInvocationApiAttempts, 3);
  assert.equal(evidence.businessDeliveryBillingEvidence, "quality_gate_refund");
  assert.equal(evidence.businessDeliveryBillingEvidenceValid, false);
  assert.equal(evidence.qualityGateRefunded, true);
  assert.equal(evidence.fullRefund, true);
  assert.equal(evidence.refundState, "full_quality_gate_refund");
  assert.match(evidence.evidenceNotes.join("；"), /3轮取得真实API候选/u);
  assert.match(evidence.evidenceNotes.join("；"), /全额退回预授权/u);

  const result = classifyAttempt(row);
  assert.equal(result.pass, false);
  assert.equal(result.capabilityPass, false);
  assert.equal(result.businessProductionPass, false);
  assert.equal(result.verdict, "FAIL_REAL_API");
  assert.equal(result.providerEvidence, "real_cloud_api_invoked");
  assert.equal(result.providerInvocationEvidenceValid, true);
  assert.equal(result.businessDeliveryBillingEvidenceValid, false);
  assert.equal(result.qualityGateRefunded, true);
  assert.equal(result.fullRefund, true);
  assert.equal(result.refundState, "full_quality_gate_refund");
  assert.match(result.failureReasons.join("；"), /真实API候选/u);
  assert.match(result.failureReasons.join("；"), /0 token、0积分结算/u);
  assert.match(result.failureReasons.join("；"), /全额退回预授权/u);
  // 真实API候选契约失败直接走质量门退款；新默认策略不创建内容审批，
  // 因此不能把“缺少人工审批/期望已驳回”误报成额外生产缺陷。
  assert.doesNotMatch(result.failureReasons.join("；"), /缺少人工审批|期望已驳回|QA能力验收结论/u);
  assert.doesNotMatch(
    result.failureReasons.join("；"),
    /真实供应商证据未由本次runner校验|未调用API/u,
  );
});

test("供应商成本估算与质量退款后的客户0实扣严格分离", () => {
  const providerAttempts = projectProviderAttempts([
    {
      number: 1,
      phase: "acquire",
      mode: "api",
      model: "gpt-5.5",
      apiObtained: true,
      succeeded: true,
      contractValid: false,
      usage: { inputTokens: 1_000, outputTokens: 500 },
    },
  ]);
  const qualityFailure = passingRow({
    providerAttempts,
    providerAttemptSummary: summarizeProviderAttempts(providerAttempts),
    providerInputTokens: 1_000,
    providerOutputTokens: 500,
    inputTokens: 1_000,
    outputTokens: 500,
    generationStatus: "失败",
    contractValid: false,
    contractErrors: ["RESTAURANT_OUTPUT_CONTRACT_INVALID"],
    semanticValid: false,
    billingInputTokens: 0,
    billingOutputTokens: 0,
    chargedCostYuan: 0,
    costYuan: 0,
    chargedCredits: 0,
    creditLogCredits: 0,
    balanceAfter: 1_000_000,
    tenantBalance: 1_000_000,
    billingBalanceWindowCurrentDebit: 0,
    billingBalanceWindowSettlementDebit: 0,
    billingExpectedCurrentBalance: 1_000_000,
    billingExpectedSettlementBalance: 1_000_000,
    heldCredits: 75,
    settledCredits: 0,
    outputId: null,
    primaryArtifactCount: 0,
    resultChars: 0,
    resultHash: null,
    resultHashValid: false,
    artifactHashValid: false,
    businessFlowStatus: "quality_failed",
  });
  const evidence = classifyProviderEvidence(qualityFailure);
  const pricingSnapshot = createProviderPricingSnapshot(
    {
      text: {
        "gpt-5.5": { in: 30, out: 60 },
        default: { in: 30, out: 30 },
      },
    },
    {
      pricingSource: "runtime_api_config.billing.text",
      capturedAt: "2026-07-31T00:00:00.000Z",
    },
  );
  const reported = applyProviderCostSemantics(
    { ...qualityFailure, ...evidence },
    pricingSnapshot,
  );

  assert.equal(reported.providerEstimatedCostYuan, 0.06);
  assert.equal(reported.providerCostEstimate.estimated, true);
  assert.equal(
    reported.providerCostEstimate.pricingSource,
    "runtime_api_config.billing.text",
  );
  assert.equal(reported.chargedCostYuan, 0);
  assert.equal(reported.chargedCredits, 0);
  assert.equal(reported.costYuan, 0);
  assert.equal(reported.costYuanDeprecated, true);
  assert.equal(reported.fullRefund, true);
  assert.equal(reported.refundState, "full_quality_gate_refund");

  const cli = formatAttemptCostForCli(reported);
  assert.match(cli, /providerUsage=1000\+500/u);
  assert.match(cli, /providerEstimatedCost≈¥0\.06/u);
  assert.match(cli, /customerCharge=¥0\/0 credits/u);
  assert.match(cli, /refund=full\(quality_gate\)/u);
  assert.doesNotMatch(cli, /\bcost=¥0\b/iu);
});

test("未知模型价格不回落成0，受测默认模型价才允许估算", () => {
  const known = applyProviderCostSemantics({
    providerModel: "gpt-5.5",
    providerInputTokens: 1_000,
    providerOutputTokens: 500,
    chargedCostYuan: 0,
    chargedCredits: 0,
  });
  assert.equal(known.providerEstimatedCostYuan, 0.06);
  assert.equal(known.providerCostEstimate.estimated, true);
  assert.equal(
    known.providerCostEstimate.pricingSource,
    "runner_tested_default_billing_snapshot",
  );

  const unknown = applyProviderCostSemantics(
    {
      providerModel: "brand-new-model",
      providerInputTokens: 1_000,
      providerOutputTokens: 500,
      chargedCostYuan: 0,
      chargedCredits: 0,
    },
    createProviderPricingSnapshot({
      text: { "gpt-5.5": { in: 30, out: 60 } },
    }),
  );
  assert.equal(unknown.providerEstimatedCostYuan, null);
  assert.equal(unknown.providerCostEstimate.estimated, false);
  assert.equal(
    unknown.providerCostEstimate.unavailableReason,
    "model_price_unknown",
  );
  assert.match(
    formatAttemptCostForCli(unknown),
    /providerEstimatedCost=unknown/u,
  );

  const summary = summarizeState({
    providerPricingSnapshot: createProviderPricingSnapshot({
      text: { "gpt-5.5": { in: 30, out: 60 } },
    }),
    jobs: {
      known: { latest: known },
      unknown: { latest: unknown },
    },
  });
  assert.equal(summary.providerEstimatedCostYuan, null);
  assert.deepEqual(summary.providerEstimatedCostCoverage, {
    pricedRows: 1,
    providerUsageRows: 2,
    complete: false,
  });
  assert.match(
    formatSummaryCostForCli(summary),
    /providerEstimatedCost=unknown\(priced=1\/2\)/u,
  );
});

test("真实矩阵严格拒绝mock/template/failed、零token、契约失败和未闭环任务", () => {
  const normal = classifyAttempt(passingRow());
  assert.equal(normal.pass, true);
  assert.equal(normal.capabilityPass, true);
  assert.equal(normal.businessProductionPass, true);
  for (const mutation of [
    { aiMode: "template" },
    { model: "deterministic-mock/no-network" },
    { model: "fallback-model" },
    { inputTokens: 0 },
    { outputTokens: 0 },
    { billingState: "released" },
    { billingLinkValid: false },
    { billingFreshForAttempt: false },
    { billingBaselineHoldId: null },
    { billingBaselineLogId: null },
    { billingId: 454 },
    { creditLogId: 455, billingHoldLogId: 455 },
    { billingTenantId: 999 },
    { billingInputTokens: 299 },
    { providerModel: "another-model" },
    { chargedCredits: 0 },
    { contractValid: false, contractErrors: ["schema invalid"] },
    { semanticValid: false, semanticErrors: ["placeholder"] },
    { inputEvidenceValid: false },
    { reviewDecision: "reject" },
    { terminalStatus: "已驳回" },
    { businessFlowStatus: "review_pending" },
    { businessFlowStatus: "generation_failed", businessFlowTerminal: true },
    { businessFlowTerminal: false },
    { businessFlowBillingSettled: false },
    { reviewId: null },
    { assetId: null },
    { resultHashValid: false },
    { artifactHashValid: false },
  ]) {
    const result = classifyAttempt(passingRow(mutation));
    assert.equal(result.pass, false, JSON.stringify(mutation));
    assert.equal(result.verdict, "FAIL_REAL_API");
    assert.ok(result.failureReasons.length > 0);
  }
  assert.equal(isRealProviderEvidence(passingRow()), true);
  assert.equal(
    classifyAttempt(passingRow({ businessFlowStatus: "published" })).pass,
    false,
  );
  assert.equal(
    classifyAttempt(
      passingRow({ businessFlowStatus: "published", externalPublish: true }),
    ).pass,
    false,
  );
  assert.equal(
    classifyAttempt(
      passingRow({ businessFlowStatus: "approved", externalPublish: true }),
    ).pass,
    false,
  );

  const operationalHold = classifyAttempt(
    passingRow({
      qaCapabilityRunnable: true,
      operationalReady: false,
      operationalBlockReasons: ["BLOCKED_LOCAL_RULE_CONFIRMATION"],
      reviewDecision: "reject",
      terminalStatus: "已驳回",
      outputStatus: "已驳回",
      assetId: null,
      knowledgeId: null,
      businessFlowStatus: "review_rejected",
    }),
  );
  assert.equal(operationalHold.pass, true);
  assert.equal(operationalHold.capabilityPass, true);
  assert.equal(operationalHold.businessProductionPass, false);
  assert.equal(
    operationalHold.capabilityVerdict,
    "PASS_CAPABILITY_OPERATIONALLY_BLOCKED",
  );
  assert.equal(
    classifyAttempt(
      passingRow({
        qaCapabilityRunnable: true,
        operationalReady: false,
        operationalBlockReasons: ["BLOCKED_LOCAL_RULE_CONFIRMATION"],
        reviewDecision: "adopt",
        terminalStatus: "已完成",
        outputStatus: "可使用",
        businessFlowStatus: "approved",
      }),
    ).pass,
    false,
  );
  assert.equal(
    classifyAttempt(
      passingRow({
        acceptanceKind: "capability",
        qaCapabilityRunnable: true,
        operationalReady: false,
        operationalBlockReasons: [],
        reviewDecision: "reject",
        terminalStatus: "已驳回",
        outputStatus: "已驳回",
        assetId: null,
        knowledgeId: null,
        businessFlowStatus: "review_rejected",
      }),
    ).pass,
    false,
  );
});

test("并发任务的独立hold会进入余额窗口，不把目标任务误判为账务不一致", () => {
  const concurrent = classifyAttempt(
    passingRow({
      balanceAfter: 998_390,
      tenantBalance: 998_390,
      billingBalanceWindowHoldCount: 2,
      billingBalanceWindowConcurrentHoldCount: 1,
      billingBalanceWindowCurrentDebit: 1_610,
      billingBalanceWindowSettlementDebit: 1_610,
      billingExpectedCurrentBalance: 998_390,
      billingExpectedSettlementBalance: 998_390,
    }),
  );
  assert.equal(concurrent.pass, true);
  assert.equal(concurrent.capabilityPass, true);

  const tampered = classifyAttempt({
    ...concurrent,
    tenantBalance: 998_391,
  });
  assert.equal(tampered.pass, false);
  assert.match(tampered.failureReasons.join("；"), /并发净占用\/结算窗口/u);
});

test("岗位选择覆盖61名餐饮员工和11名内容员工并支持精确过滤", () => {
  const all = buildJobs();
  assert.equal(all.length, 72);
  assert.equal(all.filter((job) => job.domain === "restaurant").length, 61);
  assert.equal(all.filter((job) => job.domain === "content").length, 11);
  assert.equal(new Set(all.map((job) => job.key)).size, 72);
  assert.deepEqual(
    all.filter((job) => job.domain === "restaurant").map((job) => job.idx),
    Array.from({ length: 61 }, (_, offset) => offset + 101),
  );
  const filtered = buildJobs(parseOnlyFilter("restaurant:101,content:8"));
  assert.deepEqual(
    filtered.map((job) => job.key),
    ["restaurant:101", "content:8"],
  );
  assert.throws(() => parseOnlyFilter("restaurant:99"), /越界/u);
  assert.throws(() => parseOnlyFilter("unknown:1"), /无效岗位/u);
});

test("同一报告分批执行会累计岗位范围，但不同服务地址和隐式流水线会被阻断", () => {
  const state = createInitialState({
    baseUrl: "http://127.0.0.1:3109",
    selectedJobs: ["restaurant:101", "restaurant:102"],
    concurrency: 2,
  });
  mergeRunSelection(state, {
    baseUrl: "http://127.0.0.1:3109/",
    selectedJobs: ["restaurant:103", "restaurant:104"],
    concurrency: 2,
    force: true,
    invocationId: "batch-2",
  });
  assert.deepEqual(state.run.selectedJobs, [
    "restaurant:101",
    "restaurant:102",
    "restaurant:103",
    "restaurant:104",
  ]);
  assert.deepEqual(state.run.currentSelection, [
    "restaurant:103",
    "restaurant:104",
  ]);
  assert.equal(state.run.invocations.length, 1);
  assert.deepEqual(state.run.invocations[0].executedJobs, []);
  assert.deepEqual(state.run.invocations[0].skippedJobs, []);
  assert.equal(state.pipeline.runRequested, false);
  assert.throws(
    () =>
      mergeRunSelection(state, {
        baseUrl: "http://127.0.0.1:3110",
        selectedJobs: ["restaurant:105"],
      }),
    /不同服务/u,
  );
});

test("断点复用必须能回溯到同一批次的云雾就绪证据和原始派活时间", () => {
  const state = createInitialState({
    baseUrl: "http://127.0.0.1:3109",
    selectedJobs: ["restaurant:101"],
    concurrency: 1,
  });
  mergeRunSelection(state, {
    baseUrl: "http://127.0.0.1:3109",
    selectedJobs: ["restaurant:101"],
    invocationId: "batch-resume",
  });
  state.run.invocations[0].runtimeEvidence = {
    available: true,
    provider: "云雾 API",
  };
  const resumable = {
    attemptId: "attempt-resume",
    invocationId: "batch-resume",
    dispatchedAt: "2026-07-31T20:00:00.000Z",
  };
  assert.equal(validateAttemptInvocation(state, resumable).valid, true);
  assert.equal(
    validateAttemptInvocation(state, {
      ...resumable,
      invocationId: "old-batch",
    }).valid,
    false,
  );
  assert.equal(
    validateAttemptInvocation(state, { ...resumable, dispatchedAt: null })
      .valid,
    false,
  );
});

test("餐饮派活提供岗位匹配的实际材料正文，占位资料被确定性拦截", () => {
  const profile = {
    identity: { idx: 101, key: "test", name: "测试岗位", duty: "核验成本" },
    dispatch: {
      defaultTaskType: "执行方案",
      requiredInputs: ["营业数据", "采购明细"],
      guidance: {
        taskExamples: ["分析成本差异"],
        deliverableChecklist: ["差异清单"],
      },
    },
  };
  const restaurant = buildRestaurantDispatch(profile, "restaurant-nonce");
  assert.match(restaurant.requirement, /restaurant-nonce/u);
  assert.match(restaurant.requirement, /验收数据集/u);
  assert.match(restaurant.requirement, /不得声称已发布/u);
  assert.match(restaurant.requirement, /营业数据/u);
  assert.match(restaurant.requirement, /记录批次=E-101-1/u);
  assert.match(restaurant.requirement, /营业额100000元/u);
  assert.equal(restaurant.dueAt, "2026-08-07T18:00:00");
  assert.match(restaurant.requirement, /验收截止时间：2026-08-07T18:00:00/u);
  assert.equal(
    validateRestaurantDispatchEvidence(restaurant, profile).valid,
    true,
  );

  const placeholder = {
    ...restaurant,
    requirement:
      "岗位材料：1. 营业数据：本轮已提供“岗位验收资料-101-1”；2. 采购明细：本轮已提供“岗位验收资料-101-2”。",
  };
  const rejected = validateRestaurantDispatchEvidence(placeholder, profile);
  assert.equal(rejected.valid, false);
  assert.match(rejected.errors.join("；"), /占位|缺少/u);

  const content = buildContentDispatch(
    {
      identity: { idx: 8, name: "分发官" },
      dispatch: { defaultTaskType: "发布包" },
    },
    "content-nonce",
  );
  assert.match(content.requirement, /content-nonce/u);
  assert.match(content.requirement, /历史最佳发布时间.*未提供/u);
  assert.match(content.requirement, /不得登录账号/u);
});

test("本地证照台账与缺失的实时法规分类独立，每项输入都有唯一可追溯记录", () => {
  for (const input of [
    "现有证照状态",
    "供应商主体、生产／经营许可、检验报告和召回记录",
    "UGC 原始来源、创作者、许可范围、期限和可否编辑",
    "许可、验收、施工、设备和消防／食品安全状态",
  ]) {
    assert.notEqual(
      classifyRestaurantRequiredInput(input),
      "external_current_regulation",
      input,
    );
  }
  for (const input of [
    "菜单复杂度、制作节拍、包装和当地许可要求",
    "当前法规、许可证、合同、企业 SOP 和认证要求",
    "司法辖区、适用标准、许可证和认证范围",
    "当前平台评价、商家回复、索评和激励政策",
  ]) {
    assert.equal(
      classifyRestaurantRequiredInput(input),
      "external_current_regulation",
      input,
    );
  }

  const localProfile = {
    identity: {
      idx: 107,
      key: "license",
      name: "证照岗",
      duty: "核验本地台账",
    },
    dispatch: {
      defaultTaskType: "检查清单",
      requiredInputs: ["现有证照状态", "供应商生产／经营许可与检验报告"],
      guidance: {
        taskExamples: ["核对本地证照台账"],
        deliverableChecklist: ["台账差异清单"],
      },
    },
  };
  const local = buildRestaurantDispatch(localProfile, "license-local");
  assert.equal(
    validateRestaurantDispatchEvidence(local, localProfile).valid,
    true,
  );
  assert.match(local.requirement, /"recordId":"E-107-1-R1"/u);
  assert.match(local.requirement, /"recordId":"E-107-2-R1"/u);
  assert.match(local.requirement, /QA-LIC-107-1/u);
  assert.equal(
    (local.requirement.match(/"recordId":"E-107-[12]-R1"/gu) || []).length,
    2,
  );

  const liveLawProfile = {
    ...localProfile,
    identity: { ...localProfile.identity, idx: 124 },
    dispatch: {
      ...localProfile.dispatch,
      requiredInputs: ["当前法规、许可证、合同、企业 SOP 和认证要求"],
    },
  };
  const liveLaw = buildRestaurantDispatch(liveLawProfile, "live-law");
  const bounded = validateRestaurantDispatchEvidence(liveLaw, liveLawProfile);
  assert.equal(bounded.valid, true);
  assert.equal(bounded.qaCapabilityRunnable, true);
  assert.equal(bounded.operationalReady, true);
  assert.equal(liveLaw.qaCapabilityRunnable, true);
  assert.equal(liveLaw.operationalReady, true);
  assert.deepEqual(liveLaw.operationalBlockReasons, []);
  assert.match(liveLaw.requirement, /"recordId":"E-124-1-R1"/u);
  assert.match(liveLaw.requirement, /"mapping":"mapped"/u);
  assert.match(liveLaw.requirement, /"qaCapabilityRunnable":true/u);
  assert.match(liveLaw.requirement, /"operationalReady":true/u);
  assert.match(liveLaw.requirement, /https:\/\/www\.samr\.gov\.cn\//u);
  assert.match(
    liveLaw.requirement,
    /"法规名称":"《食品经营许可和备案管理办法》"/u,
  );
  assert.match(
    liveLaw.requirement,
    /"文号条款":"市场监管总局令第78号·第二条\/第四条"/u,
  );
  assert.match(liveLaw.requirement, /"要求原文":/u);
  assert.match(liveLaw.requirement, /"结论状态":"未形成法律结论"/u);
  assert.match(liveLaw.requirement, /"QA能力验收资格":"RUNNABLE"/u);
  assert.match(liveLaw.requirement, /"业务执行资格":"READY"/u);
  assert.match(liveLaw.requirement, /"业务采纳资格":"BLOCKED"/u);
  assert.match(liveLaw.requirement, /"外部执行资格":"BLOCKED"/u);
  assert.match(liveLaw.requirement, /"realWorldBlockers":\["BLOCKED_LOCAL_AUDIT_CRITERIA","BLOCKED_PRIVATE_LICENSE_SOP_CERTIFICATION"\]/u);
  assert.deepEqual(bounded.errors, []);
  assert.deepEqual(bounded.operationalErrors, []);
  const liveLawSnapshot = dispatchRegulatorySnapshot(liveLaw);
  assert.equal(liveLawSnapshot.qaOnly, true);
  assert.deepEqual(liveLawSnapshot.realWorldBlockers, [
    "BLOCKED_LOCAL_AUDIT_CRITERIA",
    "BLOCKED_PRIVATE_LICENSE_SOP_CERTIFICATION",
  ]);
});

test("61个餐饮岗位的350项输入均可跑隔离QA；fixture任务就绪与法规业务范围独立", () => {
  assert.equal(RESTAURANT_CATALOG.employees.length, 61);
  let requiredInputCount = 0;
  let regulationInputCount = 0;
  let operationalReadyJobCount = 0;
  const realWorldBlockedJobIndexes = [];
  const tagCounts = new Map();
  for (const employee of RESTAURANT_CATALOG.employees) {
    const profile = catalogProfile(employee);
    let employeeRequiresRegulation = false;
    for (const [inputIndex, input] of employee.inputs.entries()) {
      requiredInputCount += 1;
      const tags = restaurantRequiredInputTags(input);
      assert.ok(
        tags.length > 0,
        `${employee.idx}存在UNMAPPED_REQUIRED_INPUT：${input}`,
      );
      const evidence = buildRestaurantRequiredInputEvidence({
        input,
        idx: employee.idx,
        inputIndex,
      });
      assert.deepEqual(evidence.tags, tags, `${employee.idx}：${input}`);
      assert.equal(evidence.recordId, `E-${employee.idx}-${inputIndex + 1}-R1`);
      assert.equal(
        evidence.fields.rid,
        evidence.recordId,
        `${employee.idx}：${input}`,
      );
      assert.ok(
        evidence.dimensions.length > 0,
        `${employee.idx}缺少事实维度：${input}`,
      );
      const regulationRequired = evidence.dimensions.includes("regulation");
      if (regulationRequired) {
        employeeRequiresRegulation = true;
        regulationInputCount += 1;
        assert.equal(evidence.mapping, "mapped", `${employee.idx}：${input}`);
        assert.equal(evidence.qaCapabilityRunnable, true);
        assert.equal(evidence.operationalReady, false);
        assert.equal(
          evidence.regulationEvidence,
          "OFFICIAL_BASELINE_ATTACHED_OPERATIONALLY_BLOCKED",
        );
        assert.ok(
          evidence.regulationBlockers.length > 0,
          `${employee.idx}法规输入缺少具体阻塞码：${input}`,
        );
      } else {
        assert.equal(evidence.mapping, "mapped", `${employee.idx}：${input}`);
        assert.equal(evidence.qaCapabilityRunnable, true);
        assert.equal(evidence.operationalReady, true);
        assert.equal("regulationEvidence" in evidence, false);
      }
      for (const dimensionId of evidence.dimensions) {
        const fields = evidence.fields.facts[dimensionId];
        assert.ok(
          fields && typeof fields === "object",
          `${employee.idx}/${dimensionId}缺少事实对象：${input}`,
        );
        assert.ok(
          Object.keys(fields).length >= 2,
          `${employee.idx}/${dimensionId}缺少实际字段：${input}`,
        );
      }
      for (const tag of tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
    const dispatch = buildRestaurantDispatch(profile, `matrix-${employee.idx}`);
    assert.ok(
      dispatch.requirement.length <= 8000,
      `${employee.idx}派活${dispatch.requirement.length}字，超过8000`,
    );
    assert.equal(dispatch.dueAt, "2026-08-07T18:00:00");
    const validation = validateRestaurantDispatchEvidence(dispatch, profile);
    assert.equal(
      dispatch.qaCapabilityRunnable,
      true,
      `${employee.idx}隔离QA应可调用真实API`,
    );
    assert.equal(
      validation.valid,
      true,
      `${employee.idx}：${validation.errors.join("；")}`,
    );
    assert.equal(
      validation.qaCapabilityRunnable,
      true,
      `${employee.idx}隔离QA前置校验失败`,
    );
    operationalReadyJobCount += 1;
    assert.equal(
      dispatch.operationalReady,
      true,
      `${employee.idx}隔离QA生成不应被业务法规门误报阻断`,
    );
    assert.deepEqual(dispatch.operationalBlockReasons, []);
    assert.equal(
      validation.operationalReady,
      true,
      `${employee.idx}：${validation.operationalErrors.join("；")}`,
    );
    const regulatory = dispatchRegulatorySnapshot(dispatch);
    if (employeeRequiresRegulation) {
      assert.equal(regulatory.qaOnly, true, `${employee.idx}法规材料必须带QA_ONLY标记`);
      assert.equal(regulatory.regulation?.业务执行资格, "READY");
      assert.equal(regulatory.regulation?.业务采纳资格, "BLOCKED");
      assert.equal(regulatory.regulation?.外部执行资格, "BLOCKED");
      assert.ok(regulatory.realWorldBlockers.length > 0, `${employee.idx}缺少真实业务阻断证据`);
      realWorldBlockedJobIndexes.push(employee.idx);
    }
  }
  assert.equal(requiredInputCount, 350);
  assert.equal(regulationInputCount, 23);
  // Two deterministic fixture augmenters make all task gates runnable.  The
  // 23 regulatory/private-scope jobs remain blocked for business adoption and
  // external execution, represented by QA_ONLY + realWorldBlockers rather
  // than falsely marking isolated generation as unavailable.
  assert.equal(operationalReadyJobCount, 61);
  assert.deepEqual(
    realWorldBlockedJobIndexes,
    [
      109, 114, 115, 116, 117, 118, 120, 122, 123, 124, 133, 135, 137, 138,
      139, 140, 141, 142, 145, 149, 155, 157, 159,
    ],
  );
  for (const requiredTag of [
    "location",
    "demand",
    "competition",
    "finance",
    "capex",
    "facility",
    "menu_recipe",
    "food_compliance",
    "supply_chain",
    "operations_data",
    "growth_customer",
    "workforce",
  ]) {
    assert.ok(
      (tagCounts.get(requiredTag) || 0) > 0,
      `${requiredTag}标签没有覆盖任何输入`,
    );
  }
});

test("101-106 fixture补齐任务可完成性门且不阻断真实API能力验收", () => {
  for (const idx of [101, 102, 103, 104, 105, 106]) {
    const employee = RESTAURANT_CATALOG.employees.find(
      (item) => item.idx === idx,
    );
    const profile = catalogProfile(employee);
    const dispatch = buildRestaurantDispatch(profile, `completeness-${idx}`);
    const validation = validateRestaurantDispatchEvidence(dispatch, profile);
    assert.equal(
      dispatch.qaCapabilityRunnable,
      true,
      `${idx}仍应允许真实API能力验收`,
    );
    assert.equal(dispatch.operationalReady, true, `${idx}隔离QA任务材料应已就绪`);
    assert.equal(
      validation.valid,
      true,
      `${idx}：${validation.errors.join("；")}`,
    );
    assert.equal(validation.qaCapabilityRunnable, true);
    assert.equal(validation.operationalReady, true);
    assert.deepEqual(dispatch.operationalBlockReasons, []);

    const forgedReady = {
      ...dispatch,
      operationalReady: false,
      operationalBlockReasons: ["TASK_COMPLETENESS_FORGED"],
    };
    assert.match(
      validateRestaurantDispatchEvidence(forgedReady, profile).errors.join(
        "；",
      ),
      /operationalReady与证据重算结果不一致|operationalBlockReasons与证据重算结果不一致/u,
    );
  }
});

test("任务可完成性门由材料事实驱动，补齐第二个可区分商圈后101不再被固定阻断", () => {
  const first = buildRestaurantRequiredInputEvidence({
    input: "国家/城市/商圈、计划覆盖半径或通行时间",
    idx: 101,
    inputIndex: 0,
  });
  const second = structuredClone(first);
  second.recordId = "E-101-2-R1";
  second.fields.rid = second.recordId;
  second.fields.facts.address = {
    地址: "太原市迎泽区验收路200号",
    坐标: "37.86,112.57",
    商圈: "迎泽验收商圈",
  };
  assert.equal(
    assessRestaurantTaskCompleteness({
      idx: 101,
      materialEvidence: [first],
    }).operationalReady,
    false,
  );
  assert.equal(
    assessRestaurantTaskCompleteness({
      idx: 101,
      materialEvidence: [first, second],
    }).operationalReady,
    true,
  );
});

test("餐饮材料按语义多标签映射，地址不会冒充投诉，投资设备不会被食安首命中截断", () => {
  const address = "门店地址、时区、商圈、服务半径、经营定位和目标顾客场景";
  const addressEvidence = buildRestaurantRequiredInputEvidence({
    input: address,
    idx: 141,
    inputIndex: 0,
  });
  assert.ok(addressEvidence.tags.includes("location"));
  assert.ok(addressEvidence.tags.includes("demand"));
  assert.equal(addressEvidence.fields.rid, "E-141-1-R1");
  assert.equal(
    addressEvidence.fields.facts.address.地址,
    "太原市小店区验收路100号",
  );
  assert.equal(addressEvidence.fields.facts.catchment.覆盖半径公里, 3);
  assert.equal(
    addressEvidence.fields.facts.customer_segment.客群,
    "周边办公人群",
  );
  assert.notDeepEqual(
    addressEvidence.fields.facts.address,
    addressEvidence.fields.facts.customer_segment,
  );

  const investment = "开办投资、押金、设备、装修、预开业和营运资金";
  const investmentEvidence = buildRestaurantRequiredInputEvidence({
    input: investment,
    idx: 106,
    inputIndex: 3,
  });
  for (const tag of ["finance", "capex", "facility"])
    assert.ok(investmentEvidence.tags.includes(tag), tag);
  assert.equal(investmentEvidence.fields.facts.capital_budget.预算元, 300000);
  assert.equal(investmentEvidence.fields.facts.property_lease.押金元, 36000);
  assert.equal(
    investmentEvidence.fields.facts.equipment.资产名称,
    "曳引式杂物电梯",
  );
  assert.equal(
    investmentEvidence.fields.facts.equipment.维修责任人,
    "设施经理",
  );
});

test("139-2设备输入必须给出资产身份、场所、用途、关键性和维修责任人", () => {
  const input = "资产编号、型号、序列号、位置、用途、额定参数和关键性";
  const evidence = buildRestaurantRequiredInputEvidence({
    input,
    idx: 139,
    inputIndex: 1,
  });
  assert.ok(evidence.tags.includes("facility"));
  assert.ok(evidence.dimensions.includes("equipment"));
  assert.deepEqual(Object.keys(evidence.fields.facts.equipment), [
    "资产名称",
    "型号",
    "序列号",
    "位置",
    "用途",
    "关键性",
    "维修责任人",
  ]);
  assert.equal(evidence.fields.facts.equipment.序列号, "SN-QA-139-02");
  assert.equal(evidence.fields.facts.equipment.关键性, "高");
});

test("125岗位的“收集并标注来源日期”是引导语，不冒充第351项材料", () => {
  const employee = RESTAURANT_CATALOG.employees.find(
    (item) => item.idx === 125,
  );
  assert.ok(employee);
  assert.equal(employee.inputs.includes("收集并标注来源日期"), false);
  assert.equal(
    RESTAURANT_CATALOG.employees.reduce(
      (sum, item) => sum + item.inputs.length,
      0,
    ),
    350,
  );
});

test("独立材料审计同时报告61/61 fixture任务就绪与法规业务阻断", () => {
  const report = auditRestaurantMaterialCoverage({
    catalog: RESTAURANT_CATALOG,
  });
  assert.equal(report.valid, true);
  assert.deepEqual(report.summary.qaCapabilityRunnable, {
    passed: 61,
    total: 61,
  });
  assert.deepEqual(report.summary.fixtureOperationalReady, {
    passed: 61,
    total: 61,
  });
  assert.deepEqual(report.summary.operationalReady, { passed: 61, total: 61 });
  assert.deepEqual(report.summary.operationalBlocked, { count: 0, total: 61 });
  assert.deepEqual(
    report.summary.operationalBlockedEmployeeIndexes,
    [],
  );
  assert.deepEqual(report.summary.businessOperationalReady, { passed: 38, total: 61 });
  assert.deepEqual(report.summary.businessOperationalBlocked, { count: 23, total: 61 });
  assert.deepEqual(report.summary.businessOperationalBlockedEmployeeIndexes, [
    109, 114, 115, 116, 117, 118, 120, 122, 123, 124, 133, 135, 137, 138,
    139, 140, 141, 142, 145, 149, 155, 157, 159,
  ]);
  const markdown = restaurantMaterialAuditMarkdown(report);
  assert.match(markdown, /隔离 QA 能力可跑：61\/61 岗/u);
  assert.match(markdown, /材料 fixture 任务就绪（operationalReady）：61\/61 岗/u);
  assert.match(markdown, /隔离生成派活就绪（operationalReady）：61\/61 岗/u);
  assert.match(markdown, /真实业务采纳\/外部执行就绪：38\/61 岗/u);
  assert.match(markdown, /QA_ONLY真实业务\/外部执行阻断：23\/61 岗/u);
});

test("餐饮材料校验会重算标签并拦截缺字段、错recordId、错截止时间和未映射输入", () => {
  const profile = {
    identity: {
      idx: 141,
      key: "semantic-check",
      name: "语义核验岗",
      duty: "核验输入语义",
    },
    dispatch: {
      defaultTaskType: "执行方案",
      requiredInputs: [
        "门店地址、时区、商圈、服务半径、经营定位和目标顾客场景",
      ],
      guidance: {
        taskExamples: ["核验商圈材料"],
        deliverableChecklist: ["核验结果"],
      },
    },
  };
  const dispatch = buildRestaurantDispatch(profile, "semantic-tamper");
  assert.equal(
    validateRestaurantDispatchEvidence(dispatch, profile).valid,
    true,
  );

  const missingAddress = {
    ...dispatch,
    requirement: dispatch.requirement.replace(
      '"地址":"太原市小店区验收路100号"',
      '"地址":""',
    ),
  };
  assert.match(
    validateRestaurantDispatchEvidence(missingAddress, profile).errors.join(
      "；",
    ),
    /address\.地址/u,
  );

  const wrongRecord = {
    ...dispatch,
    requirement: dispatch.requirement.replace(
      '"recordId":"E-141-1-R1"',
      '"recordId":"E-141-99-R1"',
    ),
  };
  assert.match(
    validateRestaurantDispatchEvidence(wrongRecord, profile).errors.join("；"),
    /recordId/u,
  );

  const wrongDueAt = { ...dispatch, dueAt: "2026-08-09T18:00:00" };
  assert.match(
    validateRestaurantDispatchEvidence(wrongDueAt, profile).errors.join("；"),
    /截止时间/u,
  );

  const unmappedProfile = {
    ...profile,
    dispatch: { ...profile.dispatch, requiredInputs: ["完全未知占位XYZ"] },
  };
  const unmapped = buildRestaurantDispatch(unmappedProfile, "unmapped");
  assert.match(
    validateRestaurantDispatchEvidence(unmapped, unmappedProfile).errors.join(
      "；",
    ),
    /UNMAPPED_REQUIRED_INPUT/u,
  );
});

test("10个内容岗使用岗位专属完整输入，通用任务不得冒充能力验收", () => {
  for (let idx = 0; idx <= 9; idx += 1) {
    const profile = {
      identity: { idx, key: `content-${idx}`, name: `内容岗${idx}` },
      dispatch: { defaultTaskType: "岗位交付" },
    };
    const dispatch = buildContentDispatch(profile, `nonce-${idx}`);
    const checked = validateContentDispatchEvidence(dispatch, idx);
    assert.equal(checked.valid, true, `${idx}: ${checked.errors.join("；")}`);
    if (idx === 4) {
      assert.match(dispatch.requirement, /待改写完整原稿：# 一周复盘/u);
      assert.match(dispatch.requirement, /账号人设/u);
    }
    if (idx === 9) {
      assert.match(dispatch.requirement, /发布记录（仅验收数据集内）/u);
      assert.match(dispatch.requirement, /阅读量842/u);
      assert.match(dispatch.requirement, /不声称已在任何外部平台发布/u);
    }
  }

  const generic = {
    title: "通用内容任务",
    requirement: "写一篇餐饮成本文章，要真实且详细。",
    industry: "餐饮",
    feedback: "写好一点",
  };
  for (let idx = 0; idx <= 9; idx += 1) {
    const checked = validateContentDispatchEvidence(generic, idx);
    assert.equal(checked.valid, false, `content:${idx}`);
    assert.match(checked.errors.join("；"), /缺少本岗必需输入/u);
  }
});

test("10个内容岗必须在派活前读到完整能力、工作方式、技能库、提示词、工作配置和岗位档案", () => {
  for (let idx = 0; idx <= 9; idx += 1) {
    const profile = buildContentEmployeeWorkbenchProfile(idx);
    const checked = validateContentProfileCompleteness(profile, idx, profile);
    assert.equal(checked.valid, true, `${idx}: ${checked.errors.join("；")}`);
    assert.equal(checked.evidence.complete, true);
    assert.equal(checked.evidence.identityIdx, idx);
    assert.ok(checked.evidence.capabilityCount > 0);
    assert.ok(checked.evidence.requiredSkillCount > 0);
    assert.ok(checked.evidence.historicalSkillCount > 0);
  }

  const canonicalApiProfile = buildContentEmployeeWorkbenchProfile(3);
  const normalizedApiProfile = structuredClone(canonicalApiProfile);
  normalizedApiProfile.workMethod = {
    inputs: [canonicalApiProfile.workMethod.input.upstream],
    steps: ["服务端规范化展示"],
    raw: structuredClone(canonicalApiProfile.workMethod),
  };
  normalizedApiProfile.workConfig = {
    fields: [{ key: "textModel", label: "文本模型" }],
    values: { textModel: "gpt-5.5" },
    factoryDefault: structuredClone(
      canonicalApiProfile.workConfig.factoryDefault,
    ),
    safeLegacyConfig: structuredClone(
      canonicalApiProfile.workConfig.safeLegacyConfig,
    ),
    enterpriseOverrides: {},
    version: "r0",
    mode: "factory_plus_tenant_overlay",
    summary: "出厂配置完整保留，企业配置只追加。",
    boundary: "核心能力不可关闭。",
  };
  const normalizedChecked = validateContentProfileCompleteness(
    normalizedApiProfile,
    3,
    canonicalApiProfile,
  );
  assert.equal(
    normalizedChecked.valid,
    true,
    normalizedChecked.errors.join("；"),
  );

  // The public workbench response intentionally omits the aggregate
  // skillLibrary.defaultInjected array while retaining a defaultInjected
  // flag on every required/historical skill row.  The real runner must
  // accept that projection and still reject rows whose flags are missing.
  const publicProjection = structuredClone(canonicalApiProfile);
  delete publicProjection.skillLibrary.defaultInjected;
  const publicChecked = validateContentProfileCompleteness(
    publicProjection,
    3,
    canonicalApiProfile,
  );
  assert.equal(publicChecked.valid, true, publicChecked.errors.join("；"));
  assert.equal(publicChecked.evidence.defaultInjectedFieldPresent, false);
  assert.equal(
    publicChecked.evidence.defaultInjectedCount,
    publicProjection.skillLibrary.required.length +
      publicProjection.skillLibrary.historical.length,
  );

  const publicMissingFlag = structuredClone(publicProjection);
  delete publicMissingFlag.skillLibrary.historical[0].defaultInjected;
  const publicMissingFlagChecked = validateContentProfileCompleteness(
    publicMissingFlag,
    3,
    canonicalApiProfile,
  );
  assert.equal(publicMissingFlagChecked.valid, false);
  assert.match(publicMissingFlagChecked.errors.join("；"), /历史技能/u);

  const incomplete = structuredClone(buildContentEmployeeWorkbenchProfile(3));
  delete incomplete.prompts;
  incomplete.skillLibrary.historical = [];
  incomplete.jobProfile.expectedDeliverables = [];
  const checked = validateContentProfileCompleteness(
    incomplete,
    3,
    buildContentEmployeeWorkbenchProfile(3),
  );
  assert.equal(checked.valid, false);
  assert.match(checked.errors.join("；"), /提示词/u);
  assert.match(checked.errors.join("；"), /历史技能/u);
  assert.match(checked.errors.join("；"), /岗位档案/u);

  const passingContent = passingRow({
    domain: "content",
    idx: 3,
    billingRefType: "content_employee_run",
    contentProfileComplete: true,
    contentProfileEvidence: { complete: true },
    localContractValid: true,
    primaryArtifactHashValid: true,
    artifactReadbackValid: true,
  });
  assert.equal(classifyAttempt(passingContent).pass, true);
  const missingProfile = classifyAttempt({
    ...passingContent,
    contentProfileComplete: false,
    contentProfileEvidence: { complete: false },
    contentProfileErrors: ["技能库不完整"],
  });
  assert.equal(missingProfile.pass, false);
  assert.match(missingProfile.failureReasons.join("；"), /完整岗位档案/u);
});

test("完整岗位档案按canonical能力/技能ID、数量和稳定指纹校验，同数量替换不得假通过", () => {
  const canonical = buildContentEmployeeWorkbenchProfile(0);
  const valid = validateContentProfileCompleteness(canonical, 0, canonical);
  assert.equal(valid.valid, true, valid.errors.join("；"));
  assert.equal(valid.evidence.canonicalMatch, true);
  assert.match(valid.evidence.profileFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(valid.evidence.capabilityIds.length, canonical.capabilities.length);
  assert.equal(
    valid.evidence.skillIds.length,
    canonical.skillLibrary.required.length +
      canonical.skillLibrary.historical.length,
  );

  const forged = structuredClone(canonical);
  forged.capabilities[0].name = "伪造的同数量能力";
  forged.skillLibrary.historical[0].id = "legacy-skill:v1:e000:s999";
  forged.skillLibrary.defaultInjected = [
    ...forged.skillLibrary.required,
    ...forged.skillLibrary.historical,
  ];
  const rejected = validateContentProfileCompleteness(forged, 0, canonical);
  assert.equal(rejected.valid, false);
  assert.match(rejected.errors.join("；"), /canonical|指纹|能力ID|技能ID/u);
});

test("API档案、执行快照和数据库落库版本/指纹必须三方一致", () => {
  const fingerprint = "a".repeat(64);
  const valid = validateContentProfileExecutionChain({
    api: {
      profileVersion: "content-2-r7",
      profileFingerprint: fingerprint,
      capabilityFingerprint: "b".repeat(64),
      skillFingerprint: "c".repeat(64),
    },
    execution: {
      profileVersion: "content-2-r7",
      profileFingerprint: fingerprint,
      capabilityFingerprint: "b".repeat(64),
      skillFingerprint: "c".repeat(64),
    },
    persisted: {
      profileVersion: "content-2-r7",
      profileFingerprint: fingerprint,
      capabilityFingerprint: "b".repeat(64),
      skillFingerprint: "c".repeat(64),
    },
  });
  assert.equal(valid.valid, true, valid.errors.join("；"));
  const stale = validateContentProfileExecutionChain({
    api: valid.api,
    execution: valid.execution,
    persisted: { ...valid.persisted, profileVersion: "content-2-r6" },
  });
  assert.equal(stale.valid, false);
  assert.match(stale.errors.join("；"), /版本/u);
});

test("真实员工矩阵只允许loopback业务服务和官方Yunwu HTTPS v1", () => {
  assert.equal(isLoopbackServiceBaseUrl("http://127.0.0.1:3109"), true);
  assert.equal(isLoopbackServiceBaseUrl("http://localhost:3107"), true);
  assert.equal(isLoopbackServiceBaseUrl("https://[::1]:3107"), true);
  assert.equal(isLoopbackServiceBaseUrl("https://example.com"), false);
  assert.equal(isOfficialYunwuBaseUrl("https://yunwu.ai/v1"), true);
  assert.equal(isOfficialYunwuBaseUrl("https://api.yunwu.ai/v1/"), true);
  assert.equal(isOfficialYunwuBaseUrl("http://yunwu.ai/v1"), false);
  assert.equal(
    isOfficialYunwuBaseUrl("https://yunwu.ai.example.test/v1"),
    false,
  );
});

test("真实员工运行器强制专用库标记、权威账务和非幂等POST按nonce恢复", () => {
  const source = fs.readFileSync(RUNNER, "utf8");
  assert.equal(REAL_MATRIX_DEFAULT_JOB_TIMEOUT_MS, 3_600_000);
  assert.match(source, /REAL_MATRIX_DEFAULT_JOB_TIMEOUT_MS/u);
  assert.match(source, /isLoopbackServiceBaseUrl\(options\.baseUrl\)/u);
  assert.match(source, /REAL_EMPLOYEE_MATRIX_ISOLATED_V1/u);
  assert.match(source, /new DatabaseSync\(canonicalBillingDatabase, \{ readOnly: true \}\)/u);
  assert.match(source, /noteFallbackAllowed: false/u);
  assert.match(source, /MUTATION_RESULT_AMBIGUOUS/u);
  assert.match(source, /async function dispatchWithNonce/u);
  assert.match(source, /FROM content_employee_runs/u);
  assert.match(source, /requirement LIKE \? ESCAPE/u);
  assert.match(source, /flag: "wx"/u);
  assert.doesNotMatch(source, /function billingFromApi/u);
});

test("餐饮矩阵接受parsedOutput为空的report-first硬交付，并以权威哈希链复验", () => {
  const outputBody = [
    "# 太原商圈机会报告",
    "",
    "## 结论",
    "公开证据与经营输入已经映射为可执行的选址判断。",
    "",
    "## 下一步",
    "由招商主管在2026-08-25前完成两个候选商圈的线下客流复核。",
  ].join("\n");
  const bodySha256 = crypto
    .createHash("sha256")
    .update(outputBody)
    .digest("hex");
  const contract = {
    valid: true,
    qualityMode: "report_first",
    reportFirstMarkdown: true,
    structuredReportFirst: true,
    parsedOutput: null,
    providerResponseSha256: bodySha256,
    renderedBodySha256: bodySha256,
    hardDelivery: { valid: true, errors: [] },
    artifacts: [
      {
        kind: "markdown",
        primary: true,
        contentSha256: bodySha256,
      },
    ],
  };

  const evidence = evaluateRestaurantMatrixOutputEvidence({
    contract,
    outputBody,
    structuredSemantic: null,
  });
  assert.equal(evidence.reportFirst, true);
  assert.equal(evidence.semanticValid, true);
  assert.deepEqual(evidence.semanticErrors, []);
  assert.equal(evidence.analysisProduced, true);
  assert.equal(evidence.resultHashValid, true);
  assert.equal(evidence.artifactHashValid, true);
  assert.equal(evidence.artifactHashSource, "authoritative_report_first_chain");
  assert.equal(evidence.localArtifactHash, null);

  const tampered = evaluateRestaurantMatrixOutputEvidence({
    contract: {
      ...contract,
      providerResponseSha256: "f".repeat(64),
    },
    outputBody,
    structuredSemantic: null,
  });
  assert.equal(tampered.semanticValid, true);
  assert.equal(tampered.artifactHashValid, false);
  assert.match(tampered.artifactHashErrors.join("；"), /providerResponseSha256/u);
});

test("餐饮矩阵统一验收门收到完整requirement而不是只有验收句", () => {
  const gateDispatch = buildRestaurantMatrixGateDispatch({
    pending: {
      requirement:
        "老板真实需求：评估太原吾悦广场餐饮机会。\n验收资料：候选商圈、客流与竞品证据。",
    },
    attempt: {
      acceptanceDemand: "请评估太原吾悦广场餐饮机会并给出下一步行动。",
    },
  });
  assert.equal(
    gateDispatch.requirement,
    "老板真实需求：评估太原吾悦广场餐饮机会。\n验收资料：候选商圈、客流与竞品证据。",
  );
  assert.equal(
    gateDispatch.acceptanceDemand,
    "请评估太原吾悦广场餐饮机会并给出下一步行动。",
  );
  const source = fs.readFileSync(RUNNER, "utf8");
  assert.match(
    source,
    /dispatch:\s*buildRestaurantMatrixGateDispatch\(\{\s*pending,\s*attempt\s*\}\)/u,
  );
});

test("reconcile-only只读重建v7并发hold窗口，不发HTTP且同步latest与最后attempt", (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "nanowork-reconcile-pass-"),
  );
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const fixture = createReconcileOnlyFixture(tempDir);
  const result = runReconcileOnly(fixture);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /RECONCILE_ONLY selected=1 passed=1 failed=0/u);
  assert.match(
    result.stdout,
    /network httpRequests=0 providerCalls=0 businessMutations=0/u,
  );

  const report = JSON.parse(fs.readFileSync(fixture.reportPath, "utf8"));
  const slot = report.jobs["restaurant:101"];
  assert.equal(slot.latest.pass, true);
  assert.equal(slot.latest.capabilityPass, true);
  assert.equal(slot.latest.businessProductionPass, false);
  assert.equal(
    slot.latest.capabilityVerdict,
    "PASS_CAPABILITY_OPERATIONALLY_BLOCKED",
  );
  assert.equal(slot.latest.billingBalanceWindowConcurrentHoldCount, 1);
  assert.equal(slot.latest.billingExpectedSettlementBalance, 999_725);
  assert.equal(slot.latest.billingExpectedCurrentBalance, 999_805);
  assert.equal(slot.latest.tenantBalance, 999_805);
  assert.deepEqual(slot.attempts.at(-1), slot.latest);
  assert.deepEqual(report.reconciliation, {
    mode: "sqlite_read_only",
    invocationId: report.reconciliation.invocationId,
    reconciledAt: report.reconciliation.reconciledAt,
    selectedJobs: ["restaurant:101"],
    databaseIdentity: report.billingEvidenceSource.identity,
    httpRequestCount: 0,
    providerCallCount: 0,
    businessMutationCount: 0,
  });
  const invocation = report.run.invocations.at(-1);
  assert.equal(invocation.mode, "reconcile_only");
  assert.equal(invocation.httpRequestCount, 0);
  assert.equal(invocation.providerCallCount, 0);
  assert.equal(invocation.businessMutationCount, 0);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.businessProductionPass, 0);
});

test("reconcile-only对缺失ID、篡改业务ID或DB身份的旧证据fail closed", (t) => {
  for (const scenario of [
    "missing-billing-id",
    "tampered-business-id",
    "tampered-db-identity",
  ]) {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `nanowork-reconcile-${scenario}-`),
    );
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const fixture = createReconcileOnlyFixture(tempDir);
    if (scenario === "missing-billing-id") {
      fixture.state.jobs["restaurant:101"].latest.billingId = null;
      fixture.state.jobs["restaurant:101"].attempts.at(-1).billingId = null;
    } else if (scenario === "tampered-business-id") {
      fixture.state.jobs["restaurant:101"].latest.businessId = 124;
      fixture.state.jobs["restaurant:101"].latest.billingRefId = 124;
      fixture.state.jobs["restaurant:101"].attempts.at(-1).businessId = 124;
      fixture.state.jobs["restaurant:101"].attempts.at(-1).billingRefId = 124;
    } else {
      fixture.state.billingEvidenceSource.identity = "tampered-device:inode";
    }
    fs.writeFileSync(
      fixture.reportPath,
      `${JSON.stringify(fixture.state, null, 2)}\n`,
      { mode: 0o600 },
    );
    const before = fs.readFileSync(fixture.reportPath, "utf8");
    const result = runReconcileOnly(fixture);
    assert.notEqual(result.status, 0, scenario);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(fs.readFileSync(fixture.reportPath, "utf8"), before);
    const unchanged = JSON.parse(before).jobs["restaurant:101"].latest;
    assert.notEqual(unchanged.pass, true);
    assert.equal(unchanged.billingReconciliation, undefined);
  }
});

test("流水线缺上游、错误hash或edge不一致时必须BLOCKED", () => {
  assert.equal(validateContentLineageInput(null).valid, false);
  const correct = createContentLineageEnvelope({
    fromIdx: 3,
    sourceRunId: 41,
    sourceArtifactContent: "这是上游已结算并采纳的完整主产物原文。".repeat(30),
  });
  assert.equal(validateContentLineageInput(correct).valid, true);
  assert.equal(
    validateContentLineageInput({
      ...correct,
      sourceArtifactHash: "0".repeat(64),
    }).valid,
    false,
  );

  const upstream = {
    idx: 3,
    businessId: 41,
    primaryArtifactHash: correct.sourceArtifactHash,
    pipelinePass: true,
    billingState: "settled",
    reviewDecision: "adopt",
  };
  const downstream = {
    idx: 4,
    businessId: 42,
    upstreamArtifactHash: correct.sourceArtifactHash,
    lineageEnvelopeHash: correct.envelopeHash,
    readbackAttachmentHash: correct.envelopeHash,
  };
  const edge = {
    fromIdx: 3,
    toIdx: 4,
    sourceRunId: 41,
    targetRunId: 42,
    sourceArtifactHash: correct.sourceArtifactHash,
    envelopeHash: correct.envelopeHash,
  };
  assert.equal(
    validateContentLineageEdge(edge, upstream, downstream).valid,
    true,
  );
  assert.equal(
    validateContentLineageEdge(
      { ...edge, sourceArtifactHash: "f".repeat(64) },
      upstream,
      downstream,
    ).valid,
    false,
  );
});

test("自动采纳前复用同一内容契约，非最终交付不得通过", () => {
  const dispatch = buildContentDispatch(
    {
      identity: { idx: 4, key: "style", name: "文风师" },
      dispatch: { defaultTaskType: "文风定稿" },
    },
    "style-contract",
  );
  const valid = validateContentEmployeeOutputContract(
    4,
    VALID_CONTENT_EMPLOYEE_OUTPUTS[4],
    {
      title: dispatch.title,
      requirement: dispatch.requirement,
      feedback: dispatch.feedback,
      enforceRequiredInputs: true,
      outputForCompletionGate: VALID_CONTENT_EMPLOYEE_OUTPUTS[4],
    },
  );
  assert.equal(valid.valid, true, valid.errors.join("；"));
  const incomplete = {
    ...VALID_CONTENT_EMPLOYEE_OUTPUTS[4],
    body: "当前无法完成改写，本轮仅提供框架与待办清单。".repeat(20),
  };
  const rejected = validateContentEmployeeOutputContract(4, incomplete, {
    title: dispatch.title,
    requirement: dispatch.requirement,
    feedback: dispatch.feedback,
    enforceRequiredInputs: true,
    outputForCompletionGate: incomplete,
  });
  assert.equal(rejected.valid, false);
  assert.match(rejected.errors.join("；"), /任务完成度门禁/u);
});

test("断点状态保存每岗完整尝试历史和汇总费用", () => {
  const state = createInitialState({
    baseUrl: "http://127.0.0.1:3107",
    selectedJobs: [employeeKey("restaurant", 101)],
    concurrency: 1,
  });
  assert.equal(state.schemaVersion, REAL_MATRIX_SCHEMA);
  mergeAttempt(state, "restaurant:101", {
    ...passingRow(),
    pass: true,
    verdict: "PASS_REAL_API",
    costYuan: 1.25,
    chargedCredits: 188,
  });
  assert.equal(state.jobs["restaurant:101"].attempts.length, 1);
  assert.equal(state.summary.passed, 1);
  assert.equal(state.summary.costYuan, 1.25);
  assert.equal(state.summary.chargedCostYuan, 1.25);
  assert.equal(state.summary.credits, 188);
  assert.equal(state.summary.chargedCredits, 188);
  assert.equal(state.summary.costYuanDeprecated, true);
  assert.equal(state.summary.providerEstimatedCostYuan, 0.021);
  assert.deepEqual(state.summary.providerEstimatedCostCoverage, {
    pricedRows: 1,
    providerUsageRows: 1,
    complete: true,
  });
});

test("同一岗位force复跑保留current口径并累计全部真实调用与去重客户账单", () => {
  const state = createInitialState({
    baseUrl: "http://127.0.0.1:3107",
    selectedJobs: [employeeKey("restaurant", 101)],
    concurrency: 1,
  });
  const historicalPricing = createProviderPricingSnapshot({
    text: { "gpt-5.5": { in: 30, out: 60 } },
  });
  state.providerPricingSnapshot = createProviderPricingSnapshot({
    text: { "gpt-5.5": { in: 300, out: 600 } },
  });
  const first = passingRow({
    attemptId: "attempt-force-1",
    businessId: 123,
    billingId: 455,
    creditLogId: 456,
    billingHoldLogId: 456,
    billingBaselineHoldId: 454,
    billingBaselineLogId: 455,
    providerInputTokens: 100,
    providerOutputTokens: 50,
    inputTokens: 100,
    outputTokens: 50,
    billingInputTokens: 100,
    billingOutputTokens: 50,
    chargedCostYuan: 0.01,
    chargedCredits: 10,
    settledCredits: 10,
    creditLogCredits: 10,
  });
  const second = passingRow({
    attemptId: "attempt-force-2",
    businessId: 124,
    billingId: 555,
    creditLogId: 556,
    billingHoldLogId: 556,
    billingBaselineHoldId: 554,
    billingBaselineLogId: 555,
    providerInputTokens: 300,
    providerOutputTokens: 150,
    inputTokens: 300,
    outputTokens: 150,
    billingInputTokens: 300,
    billingOutputTokens: 150,
    chargedCostYuan: 0.02,
    chargedCredits: 20,
    settledCredits: 20,
    creditLogCredits: 20,
  });
  const firstCosted = applyProviderCostSemantics(first, historicalPricing);
  const secondCosted = applyProviderCostSemantics(second, historicalPricing);
  mergeAttempt(state, "restaurant:101", firstCosted);
  mergeAttempt(state, "restaurant:101", secondCosted);

  assert.equal(state.jobs["restaurant:101"].attempts.length, 2);
  assert.deepEqual(state.summary.providerUsage, {
    inputTokens: 300,
    outputTokens: 150,
  });
  assert.equal(state.summary.providerEstimatedCostYuan, 0.018);
  assert.equal(state.summary.chargedCostYuan, 0.02);
  assert.equal(state.summary.chargedCredits, 20);
  assert.equal(state.summary.current.matrixAttemptCount, 1);
  assert.equal(state.summary.current.providerAttemptCount, 1);
  assert.deepEqual(state.summary.cumulative.providerUsage, {
    inputTokens: 400,
    outputTokens: 200,
  });
  assert.equal(state.summary.cumulative.matrixAttemptCount, 2);
  assert.equal(state.summary.cumulative.providerAttemptCount, 2);
  assert.equal(state.summary.cumulative.verifiedApiCallCount, 2);
  assert.equal(state.summary.cumulative.providerEstimatedCostYuan, 0.024);
  assert.equal(state.summary.cumulative.customerLedger.chargedCostYuan, 0.03);
  assert.equal(state.summary.cumulative.customerLedger.chargedCredits, 30);
  assert.equal(
    state.summary.cumulative.customerLedger.uniqueSettlementCount,
    2,
  );
  assert.equal(
    state.summary.cumulative.customerLedger.duplicateSettlementReferences,
    0,
  );
  assert.equal(state.summary.currentChargedCostYuan, 0.02);
  assert.equal(state.summary.cumulativeChargedCostYuan, 0.03);

  const duplicateLedgerReference = {
    ...secondCosted,
    attemptId: "attempt-report-duplicate",
  };
  mergeAttempt(state, "restaurant:101", duplicateLedgerReference);
  assert.equal(
    state.summary.cumulative.customerLedger.duplicateSettlementReferences,
    1,
  );
  assert.equal(state.summary.cumulative.customerLedger.chargedCostYuan, 0.03);
  assert.equal(state.summary.cumulative.customerLedger.chargedCredits, 30);
});

test("汇总严格区分能力通过与业务生产通过", () => {
  const state = createInitialState({
    baseUrl: "http://127.0.0.1:3107",
    selectedJobs: [
      employeeKey("restaurant", 101),
      employeeKey("restaurant", 109),
    ],
    concurrency: 1,
  });
  mergeAttempt(state, "restaurant:101", {
    ...passingRow({ idx: 101 }),
    pass: true,
    capabilityPass: true,
    businessProductionPass: true,
    qaCapabilityRunnable: true,
    operationalReady: true,
    verdict: "PASS_REAL_API",
  });
  mergeAttempt(state, "restaurant:109", {
    ...passingRow({
      idx: 109,
      reviewDecision: "reject",
      terminalStatus: "已驳回",
      businessFlowStatus: "review_rejected",
    }),
    pass: true,
    capabilityPass: true,
    businessProductionPass: false,
    qaCapabilityRunnable: true,
    operationalReady: false,
    operationalBlockReasons: ["BLOCKED_LOCAL_RULE_CONFIRMATION"],
    verdict: "PASS_REAL_API",
  });
  assert.equal(state.summary.passed, 2);
  assert.equal(state.summary.capabilityPass, 2);
  assert.equal(state.summary.businessEmployeePass, 1);
  assert.equal(state.summary.businessProductionPass, 1);
  assert.equal(state.summary.restaurant.capabilityPassed, 2);
  assert.equal(state.summary.restaurant.businessProductionPassed, 1);
  assert.equal(
    state.summary.restaurant.operationallyBlockedAfterCapabilityPass,
    1,
  );
});

test("联网调研供应商usage/cost与最终生成模型成本分列且不混入客户账本", () => {
  const web = summarizeWebResearchEvidence({
    attempted: true,
    ok: true,
    channels: [
      {
        kind: "agentic_web_research",
        attempted: true,
        ok: true,
        provider: "Claude WebSearch",
        evidence: {
          externalCall: true,
          usage: { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 50 },
          costUsd: 0.0125,
        },
      },
      {
        kind: "controlled_web_fetch",
        attempted: true,
        ok: true,
        provider: "NanoWork controlled WebFetch",
        evidence: { externalCall: true },
      },
    ],
  });
  assert.equal(web.schema, "nanowork.web-research-cost.v1");
  assert.deepEqual(web.agenticWebResearch, {
    channelCount: 1,
    inputTokens: 1200,
    outputTokens: 340,
    cacheReadInputTokens: 50,
    usageRows: 1,
    pricedRows: 1,
    costUsd: 0.0125,
    costCurrency: "USD",
    costComplete: true,
  });
  assert.equal(web.allResearchChannels.inputTokens, 1200);
  assert.equal(web.allResearchChannels.outputTokens, 340);
  assert.equal(web.allResearchChannels.costUsd, 0.0125);
  const state = createInitialState({
    baseUrl: "http://127.0.0.1:3107",
    selectedJobs: [employeeKey("restaurant", 102)],
    concurrency: 1,
  });
  mergeAttempt(state, "restaurant:102", {
    ...passingRow({ idx: 102 }),
    webResearchEvidence: web,
    providerEstimatedCostYuan: 0.24,
    providerCostEstimate: { estimated: true },
    tenantId: 1,
    billingId: 11,
    creditLogId: 12,
    billingState: "settled",
    chargedCostYuan: 0.02,
  });
  assert.equal(state.summary.providerEstimatedCostYuan, 0.24);
  assert.equal(state.summary.webResearch.costUsd, 0.0125);
  assert.equal(state.summary.chargedCostYuan, 0.02);
});

test("summarizeState对undefined、非对象和空岗位槽保持稳定", () => {
  for (const value of [
    undefined,
    null,
    [],
    "bad-state",
    { jobs: { a: undefined }, pipeline: { stages: { x: undefined } } },
  ]) {
    const summary = summarizeState(value);
    assert.equal(summary.total, 0);
    assert.equal(summary.passed, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.pipeline.stages, 0);
    assert.deepEqual(summary.tokens, { input: 0, output: 0 });
  }
});
