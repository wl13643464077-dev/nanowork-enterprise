import assert from "node:assert/strict";
import test from "node:test";
import {
  auditEmployeeOutput,
  buildEmployeeOutputQualityAudit,
  collectApprovedOutputRecords,
  findExternalActionClaims,
  findKnownFactConflicts,
  findPlaceholderSignals,
  findUnsupportedMarketingFactConflicts,
  renderEmployeeOutputQualityAuditMarkdown,
  sourceHash,
} from "../../scripts/lib/employee-output-quality-audit.mjs";
import {
  buildRestaurantOutputDeliverableFixture,
  getRestaurantOutputContract,
} from "../src/engines/restaurant-output-contract.js";
import { VALID_CONTENT_EMPLOYEE_OUTPUTS } from "./helpers/content-output-fixtures.mjs";

const RESTAURANT_CONTRACT = getRestaurantOutputContract(101).contractId;

function realMatrixEvidence(overrides = {}) {
  return {
    aiMode: "api",
    model: "gpt-5.5",
    inputTokens: 1000,
    outputTokens: 800,
    providerEvidence: "real_cloud_api",
    providerEvidenceValid: true,
    providerMode: "api",
    providerModel: "gpt-5.5",
    providerInputTokens: 1000,
    providerOutputTokens: 800,
    billingState: "settled",
    billingAiMode: "api",
    billingModel: "gpt-5.5",
    billingInputTokens: 1000,
    billingOutputTokens: 800,
    chargedCredits: 120,
    creditLogId: 88,
    billingLinkValid: true,
    billingFreshForAttempt: true,
    businessFlowTerminal: true,
    businessFlowComplete: true,
    businessFlowBillingSettled: true,
    externalPublish: false,
    ...overrides,
  };
}

function restaurantRecord(overrides = {}) {
  const body =
    overrides.body ??
    [
      "# 餐饮市场机会研究",
      "验收门店A本期营业额为100000元，订单为2000单，食材成本为35000元，人工成本为22000元，顾客投诉为12次。",
      "岗位验收资料只有编号，原文未提供，需待核验。",
      "建议先补齐商圈边界、人群、价格带与竞品供给，形成证据地图后再完成决策。",
      "本产出只用于审阅，尚未发布、采购、付款或签约。",
      "补充说明：".repeat(70),
    ].join("\n");
  return {
    domain: "restaurant",
    idx: 101,
    employeeKey: "01-restaurant-market-opportunity",
    employeeName: "餐饮市场机会研究",
    businessId: 25,
    attemptId: "attempt-secret",
    body,
    taskTitle: "餐饮市场机会研究",
    requirement: "岗位验收资料-101-1：本轮已提供编号，不得猜测。",
    matrix: {
      ...realMatrixEvidence(),
      contractValid: true,
      semanticValid: true,
      inputEvidenceValid: true,
      qaCapabilityRunnable: true,
      operationalReady: true,
      capabilityPass: true,
      businessProductionPass: true,
      reviewDecision: "adopt",
      reviewId: 24,
      terminalStatus: "已完成",
      businessFlowStatus: "approved",
    },
    snapshot: {
      outputContract: {
        valid: true,
        contractId: RESTAURANT_CONTRACT,
        parsedOutput: buildRestaurantOutputDeliverableFixture(101, {
          title: "餐饮市场机会研究",
        }),
        artifacts: [
          {
            primary: true,
            employeeIdx: 101,
            employeeKey: "01-restaurant-market-opportunity",
            contractId: RESTAURANT_CONTRACT,
          },
        ],
      },
      internalProfileLeakage: { detected: false },
    },
    source: {
      taskStatus: "已完成",
      outputId: 148,
      outputStatus: "可使用",
      aiMode: "api",
      specialistIdx: 101,
      specialistKey: "01-restaurant-market-opportunity",
    },
    review: {
      id: 24,
      status: "已通过",
      reviewerId: 1,
      decidedAt: "2026-07-31T01:00:00.000Z",
    },
    ...overrides,
  };
}

function contentRecord(overrides = {}) {
  const body =
    overrides.body ??
    `${JSON.stringify({ briefing: "验收门店A营业额为100000元，食材成本为35000元，目标食材成本率为32%，订单为2000单。历史最佳发布时间未提供，待确认。", topics: Array.from({ length: 5 }, (_, index) => ({ title: `选题${index + 1}`, reason: "基于已知事实形成待审阅建议" })), notes: "不执行登录、定时或对外发布。" }, null, 2)}\n${"复盘清单。".repeat(80)}`;
  return {
    domain: "content",
    idx: 0,
    employeeKey: "trend",
    employeeName: "趋势官",
    businessId: 7,
    attemptId: "content-attempt-secret",
    body,
    requirement: "未知项：历史最佳发布时间、账号链接全部未提供。",
    matrix: {
      ...realMatrixEvidence(),
      contractValid: true,
      capabilityPass: true,
      businessProductionPass: true,
      reviewDecision: "adopt",
      materialId: 11,
      terminalStatus: "已完成",
      businessFlowStatus: "approved",
    },
    snapshot: {
      employee: { idx: 0, key: "trend" },
      contractValid: true,
      contractErrors: [],
      validatedOutput: structuredClone(VALID_CONTENT_EMPLOYEE_OUTPUTS[0]),
      artifacts: [{ primary: true, employeeIdx: 0, employeeKey: "trend" }],
      internalProfileLeakage: { detected: false },
      review: {
        decision: "adopt",
        reviewerId: 1,
        reviewerRole: "boss",
        reviewedAt: "2026-07-31T01:00:00.000Z",
        materialId: 11,
      },
    },
    source: {
      runStatus: "已完成",
      materialId: 11,
      employeeIdx: 0,
      employeeKey: "trend",
      aiMode: "api",
    },
    review: {},
    ...overrides,
  };
}

function contentRoleRecord(idx, employeeKey, overrides = {}) {
  const materialId = 100 + idx;
  return contentRecord({
    idx,
    employeeKey,
    employeeName: employeeKey,
    businessId: 200 + idx,
    matrix: {
      ...realMatrixEvidence(),
      contractValid: true,
      capabilityPass: true,
      businessProductionPass: true,
      reviewDecision: "adopt",
      materialId,
      terminalStatus: "已完成",
      businessFlowStatus: "approved",
    },
    snapshot: {
      employee: { idx, key: employeeKey },
      contractValid: true,
      contractErrors: [],
      validatedOutput: structuredClone(VALID_CONTENT_EMPLOYEE_OUTPUTS[idx]),
      artifacts: [{ primary: true, employeeIdx: idx, employeeKey }],
      internalProfileLeakage: { detected: false },
      review: {
        decision: "adopt",
        reviewerId: 1,
        reviewerRole: "boss",
        reviewedAt: "2026-07-31T01:00:00.000Z",
        materialId,
      },
    },
    source: {
      runStatus: "已完成",
      materialId,
      employeeIdx: idx,
      employeeKey,
      aiMode: "api",
    },
    ...overrides,
  });
}

test("完整餐饮和内容员工产出通过八道只读质量门", () => {
  for (const record of [restaurantRecord(), contentRoleRecord(3, "draft")]) {
    const result = auditEmployeeOutput(record);
    assert.equal(result.verdict, "PASS_QUALITY");
    assert.equal(result.checks.length, 8);
    assert.deepEqual(result.failedChecks, []);
  }
});

test("餐饮契约身份以结构化快照为准，渲染正文不需泄露内部URN", () => {
  const record = restaurantRecord();
  assert.equal(record.body.includes(RESTAURANT_CONTRACT), false);
  const valid = auditEmployeeOutput(record);
  assert.equal(
    valid.checks.find((item) => item.code === "CONTRACT_IDENTITY")?.status,
    "PASS",
  );

  const mismatched = structuredClone(record);
  mismatched.snapshot.outputContract.parsedOutput.contract_id =
    "urn:nanowork:restaurant-output:101:wrong-role:v2";
  const invalid = auditEmployeeOutput(mismatched);
  assert.equal(
    invalid.checks.find((item) => item.code === "CONTRACT_IDENTITY")?.status,
    "FAIL",
  );
});

test("餐饮report-first以权威Markdown哈希链验收，不要求伪造parsed JSON", () => {
  const base = restaurantRecord();
  const body = `${base.body}\n当前公开客流样本仍待补充，现场峰值需待核验；这是真实证据缺口，不是模板占位。`;
  const bodySha256 = sourceHash(body);
  const reportFirst = restaurantRecord({
    body,
    snapshot: {
      outputContract: {
        valid: true,
        contractId: RESTAURANT_CONTRACT,
        qualityMode: "report_first",
        primaryArtifact: "markdown",
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
            employeeIdx: 101,
            employeeKey: "01-restaurant-market-opportunity",
            contractId: RESTAURANT_CONTRACT,
            contentSha256: bodySha256,
          },
        ],
      },
      internalProfileLeakage: { detected: false },
    },
  });

  const result = auditEmployeeOutput(reportFirst);
  assert.equal(result.verdict, "PASS_QUALITY");
  assert.equal(result.qualityEvidenceMode, "report_first_markdown");
  assert.equal(result.hashSource, "authoritative_report_first_chain");
  assert.equal(result.positiveTokenEvidenceValid, true);
  const contractCheck = result.checks.find(
    (item) => item.code === "CONTRACT_IDENTITY",
  );
  assert.equal(contractCheck?.status, "PASS");
  assert.equal(contractCheck?.semanticValid, true);
  assert.equal(contractCheck?.qualityEvidenceMode, "report_first_markdown");
  assert.equal(contractCheck?.hashSource, "authoritative_report_first_chain");
  assert.equal(contractCheck?.authoritativeBodyHashValid, true);
  const providerCheck = result.checks.find(
    (item) => item.code === "REAL_OUTPUT_NOT_PLACEHOLDER",
  );
  assert.equal(providerCheck?.status, "PASS");
  assert.equal(providerCheck?.qualityEvidenceMode, "report_first_markdown");
  assert.equal(providerCheck?.hashSource, "authoritative_report_first_chain");
  assert.equal(providerCheck?.positiveTokenEvidenceValid, true);

  const paihuoMarkdown = auditEmployeeOutput({
    ...reportFirst,
    snapshot: {
      ...reportFirst.snapshot,
      outputContract: {
        ...reportFirst.snapshot.outputContract,
        qualityMode: "paihuo_markdown",
        deliveryStyle: "paihuo_markdown",
        structuredReportFirst: false,
        artifacts: [
          {
            kind: "markdown",
            primary: true,
            employeeIdx: 101,
            contentSha256: bodySha256,
          },
        ],
      },
    },
  });
  assert.equal(paihuoMarkdown.verdict, "PASS_QUALITY");
  assert.equal(paihuoMarkdown.qualityEvidenceMode, "report_first_markdown");
  assert.equal(paihuoMarkdown.hashSource, "authoritative_report_first_chain");

  for (const contractMutation of [
    { renderedBodySha256: "f".repeat(64) },
    { hardDelivery: { valid: false, errors: ["硬门失败"] } },
    { structuredReportFirst: false },
  ]) {
    const rejected = auditEmployeeOutput({
      ...reportFirst,
      snapshot: {
        ...reportFirst.snapshot,
        outputContract: {
          ...reportFirst.snapshot.outputContract,
          ...contractMutation,
        },
      },
    });
    assert.equal(rejected.verdict, "FAIL_QUALITY");
    assert.ok(rejected.failedChecks.includes("CONTRACT_IDENTITY"));
  }

  const zeroToken = auditEmployeeOutput({
    ...reportFirst,
    matrix: { ...reportFirst.matrix, outputTokens: 0 },
  });
  assert.equal(zeroToken.verdict, "FAIL_QUALITY");
  assert.ok(zeroToken.failedChecks.includes("REAL_OUTPUT_NOT_PLACEHOLDER"));
  assert.equal(zeroToken.positiveTokenEvidenceValid, false);
});

test("餐饮结构化模式继续使用岗位JSON validator并标明证据模式", () => {
  const valid = auditEmployeeOutput(restaurantRecord());
  assert.equal(valid.qualityEvidenceMode, "structured_json");
  assert.equal(valid.hashSource, "structured_runtime_validator");
  const validCheck = valid.checks.find(
    (item) => item.code === "CONTRACT_IDENTITY",
  );
  assert.equal(validCheck?.qualityEvidenceMode, "structured_json");
  assert.equal(validCheck?.hashSource, "structured_runtime_validator");

  const invalid = restaurantRecord();
  invalid.snapshot.outputContract.parsedOutput = null;
  const result = auditEmployeeOutput(invalid);
  assert.equal(result.verdict, "FAIL_QUALITY");
  assert.ok(result.failedChecks.includes("CONTRACT_IDENTITY"));
});

test("业务证据未齐的餐饮岗真实API质量可通过，但必须reject且不得记为业务生产通过", () => {
  const base = restaurantRecord();
  const held = restaurantRecord({
    matrix: {
      ...base.matrix,
      operationalReady: false,
      operationalBlockReasons: ["BLOCKED_LOCAL_RULE_CONFIRMATION"],
      businessProductionPass: false,
      reviewDecision: "reject",
      terminalStatus: "已驳回",
      businessFlowStatus: "review_rejected",
    },
    source: { ...base.source, taskStatus: "已驳回", outputStatus: "已驳回" },
    review: { ...base.review, status: "已驳回" },
  });
  const result = auditEmployeeOutput(held);
  assert.equal(result.verdict, "PASS_CAPABILITY_OPERATIONALLY_BLOCKED");
  assert.equal(result.capabilityPass, true);
  assert.equal(result.businessProductionPass, false);
  assert.equal(result.operationalBlocked, true);
  assert.deepEqual(result.operationalBlockReasons, [
    "BLOCKED_LOCAL_RULE_CONFIRMATION",
  ]);
  assert.deepEqual(result.failedChecks, []);
  const providerCheck = result.checks.find(
    (item) => item.code === "REAL_OUTPUT_NOT_PLACEHOLDER",
  );
  assert.equal(providerCheck?.status, "PASS");
  assert.equal(providerCheck?.providerEvidence, "real_cloud_api");
  assert.equal(providerCheck?.providerEvidenceValid, true);
  assert.equal(providerCheck?.providerInputTokens, 1000);
  assert.equal(providerCheck?.providerOutputTokens, 800);
  assert.equal(providerCheck?.billingState, "settled");
  assert.equal(providerCheck?.chargedCredits, 120);
  assert.equal(providerCheck?.businessFlowTerminal, true);
  assert.equal(providerCheck?.businessFlowBillingSettled, true);
  const reviewCheck = result.checks.find(
    (item) => item.code === "HUMAN_REVIEW_TERMINAL",
  );
  assert.equal(reviewCheck?.reviewDecision, "reject");
  assert.equal(reviewCheck?.terminalStatus, "已驳回");
  assert.equal(reviewCheck?.businessFlowStatus, "review_rejected");

  for (const [mutation, expectedCode] of [
    [{ billingState: "released" }, "REAL_OUTPUT_NOT_PLACEHOLDER"],
    [{ outputTokens: 0 }, "REAL_OUTPUT_NOT_PLACEHOLDER"],
    [{ semanticValid: false }, "REAL_OUTPUT_NOT_PLACEHOLDER"],
    [{ contractValid: false }, "CONTRACT_IDENTITY"],
    [{ model: "deterministic-mock/no-network" }, "REAL_OUTPUT_NOT_PLACEHOLDER"],
    [{ providerEvidenceValid: false }, "REAL_OUTPUT_NOT_PLACEHOLDER"],
    [{ billingInputTokens: 999 }, "REAL_OUTPUT_NOT_PLACEHOLDER"],
    [{ chargedCredits: 0 }, "REAL_OUTPUT_NOT_PLACEHOLDER"],
    [{ businessFlowBillingSettled: false }, "REAL_OUTPUT_NOT_PLACEHOLDER"],
    [{ reviewDecision: "adopt" }, "HUMAN_REVIEW_TERMINAL"],
  ]) {
    const failed = auditEmployeeOutput({
      ...held,
      matrix: { ...held.matrix, ...mutation },
    });
    assert.equal(failed.verdict, "FAIL_QUALITY");
    assert.equal(failed.capabilityPass, false);
    assert.ok(
      failed.failedChecks.includes(expectedCode),
      JSON.stringify(failed.failedChecks),
    );
  }
});

test("离线报告读取器保留预期驳回岗位的provider、token、账务和终态证据", () => {
  const matrix = {
    jobs: {
      "restaurant:101": {
        latest: {
          ...realMatrixEvidence(),
          domain: "restaurant",
          idx: 101,
          employeeKey: "01-restaurant-market-opportunity",
          employeeName: "餐饮市场机会研究",
          businessId: 25,
          attemptId: "blocked-attempt",
          pass: true,
          verdict: "PASS_REAL_API",
          contractValid: true,
          semanticValid: true,
          inputEvidenceValid: true,
          qaCapabilityRunnable: true,
          operationalReady: false,
          operationalBlockReasons: ["BLOCKED_LOCAL_RULE_CONFIRMATION"],
          capabilityPass: true,
          businessProductionPass: false,
          reviewDecision: "reject",
          reviewId: 24,
          terminalStatus: "已驳回",
          businessFlowStatus: "review_rejected",
        },
      },
    },
  };
  const restaurantRow = {
    business_id: 25,
    task_title: "餐饮市场机会研究",
    requirement: "材料不足，须披露并阻断生产采用。",
    task_status: "已驳回",
    output_id: 148,
    employee_web_snapshot: "{}",
    body: restaurantRecord().body,
    output_status: "已驳回",
    output_ai_mode: "api",
    specialist_idx: 101,
    specialist_key: "01-restaurant-market-opportunity",
    approval_id: 24,
    approval_status: "已驳回",
    reviewer_id: 1,
    decided_at: "2026-07-31T01:00:00.000Z",
  };
  const database = {
    prepare(sql) {
      return {
        get: () => (sql.includes("FROM agent_tasks") ? restaurantRow : null),
      };
    },
  };
  const [record] = collectApprovedOutputRecords(matrix, database);
  assert.equal(record.matrix.providerEvidence, "real_cloud_api");
  assert.equal(record.matrix.providerEvidenceValid, true);
  assert.equal(record.matrix.providerInputTokens, 1000);
  assert.equal(record.matrix.providerOutputTokens, 800);
  assert.equal(record.matrix.billingState, "settled");
  assert.equal(record.matrix.chargedCredits, 120);
  assert.equal(record.matrix.creditLogId, 88);
  assert.equal(record.matrix.businessFlowTerminal, true);
  assert.equal(record.matrix.businessFlowBillingSettled, true);
  assert.equal(record.matrix.reviewDecision, "reject");
  assert.equal(record.matrix.terminalStatus, "已驳回");
  assert.equal(record.matrix.businessFlowStatus, "review_rejected");
  assert.equal(record.matrix.capabilityPass, true);
  assert.equal(record.matrix.businessProductionPass, false);
});

test("产出审计汇总分列能力通过、业务生产通过和生产阻断", () => {
  const base = restaurantRecord();
  const held = restaurantRecord({
    matrix: {
      ...base.matrix,
      operationalReady: false,
      operationalBlockReasons: ["BLOCKED_LOCAL_RULE_CONFIRMATION"],
      businessProductionPass: false,
      reviewDecision: "reject",
      terminalStatus: "已驳回",
      businessFlowStatus: "review_rejected",
    },
    source: { ...base.source, taskStatus: "已驳回", outputStatus: "已驳回" },
    review: { ...base.review, status: "已驳回" },
  });
  const matrix = {
    run: { selectedJobs: ["restaurant:101"] },
    jobs: {
      "restaurant:101": {
        latest: {
          domain: "restaurant",
          idx: 101,
          pass: true,
          capabilityPass: true,
          businessProductionPass: false,
          verdict: "PASS_REAL_API",
          qaCapabilityRunnable: true,
          operationalReady: false,
        },
      },
    },
  };
  const report = buildEmployeeOutputQualityAudit({ matrix, records: [held] });
  assert.equal(
    report.summary.overallStatus,
    "PASS_PARTIAL_WITH_OPERATIONAL_BLOCKS",
  );
  assert.equal(
    report.schemaVersion,
    "nanowork.employee-output-quality-audit.v3",
  );
  assert.equal(
    report.evidencePolicy.requiresStrictProviderBillingEvidence,
    true,
  );
  assert.equal(
    report.evidencePolicy.expectedBlockedOutputCountsAsCapabilityPass,
    true,
  );
  assert.equal(report.summary.capabilityPassed, 1);
  assert.equal(report.summary.businessProductionPassed, 0);
  assert.equal(report.summary.operationalBlocked, 1);
  assert.deepEqual(report.summary.operationalBlockedEmployeeIndexes, [101]);
  assert.equal(report.coverage.restaurantQaCapabilityRunnable, 1);
  assert.equal(report.coverage.restaurantOperationalReady, 0);
  assert.equal(report.coverage.restaurantOperationalBlocked, 1);
  assert.equal(report.coverage.auditedTerminalOutputs, 1);
  assert.equal(report.coverage.auditedApprovedOutputs, 0);
  assert.equal(report.coverage.auditedRejectedCapabilityOutputs, 1);
  assert.equal(report.coverage.matrixNotPassed, 0);
  const markdown = renderEmployeeOutputQualityAuditMarkdown(report);
  assert.match(markdown, /能力\/\u8d28量通过1，业务生产通过0，生产阻断1/u);
  assert.match(markdown, /能力通过但预期驳回1/u);
  assert.match(markdown, /不计为未跑或失败/u);
});

test("各质量门能独立阻断短正文、错契约、缺审批、内部标记、占位、错事实、缺材料和外部动作", () => {
  const base = restaurantRecord();
  const cases = [
    [restaurantRecord({ body: "太短" }), "BODY_INTEGRITY"],
    [
      restaurantRecord({
        snapshot: {
          outputContract: { valid: true, contractId: "wrong", artifacts: [] },
          internalProfileLeakage: { detected: false },
        },
      }),
      "CONTRACT_IDENTITY",
    ],
    [
      restaurantRecord({ review: { status: "待审核" } }),
      "HUMAN_REVIEW_TERMINAL",
    ],
    [
      restaurantRecord({ body: `${base.body}\nNW-IPG-secret-marker` }),
      "INTERNAL_PROFILE_CLEAR",
    ],
    [
      restaurantRecord({ body: `${base.body}\n{{请填写门店名}}` }),
      "REAL_OUTPUT_NOT_PLACEHOLDER",
    ],
    [
      restaurantRecord({
        body: base.body.replace("营业额为100000元", "营业额为90000元"),
      }),
      "KNOWN_FACTS_CONSISTENT",
    ],
    [
      restaurantRecord({
        body: base.body.replace(
          "岗位验收资料只有编号，原文未提供，需待核验。",
          "岗位验收资料已全部读取。",
        ),
      }),
      "MISSING_MATERIAL_DISCLOSED",
    ],
    [
      restaurantRecord({
        body: `${base.body}\n我们已经对外发布并成功完成付款。`,
      }),
      "NO_EXTERNAL_ACTION_CLAIM",
    ],
  ];
  for (const [record, expectedCode] of cases) {
    const result = auditEmployeeOutput(record);
    assert.equal(result.verdict, "FAIL_QUALITY", expectedCode);
    assert.ok(
      result.failedChecks.includes(expectedCode),
      JSON.stringify(result.failedChecks),
    );
  }
});

test("文风师缺完整原稿或人设时即使诚实补料也不得PASS", () => {
  const disclosure =
    "当前缺少原稿、账号人设和目标平台信息，无法确认具体文风；请补充原始稿件与品牌语气样例，待材料补齐后再进行逐段改写和一致性核验。";
  const body =
    `${disclosure}${"本轮仅整理可执行的补料清单与后续校验步骤，不虚构原文内容。".repeat(9)}`.slice(
      0,
      246,
    );
  assert.ok(body.length >= 240 && body.length < 400);
  const result = auditEmployeeOutput(
    contentRoleRecord(4, "style", {
      body,
      requirement: "当前没有额外岗位材料，原稿与账号人设未提供。",
    }),
  );
  assert.equal(result.verdict, "FAIL_QUALITY");
  assert.equal(
    result.checks.find((item) => item.code === "BODY_INTEGRITY")?.status,
    "FAIL",
  );
  assert.equal(
    result.checks
      .find((item) => item.code === "BODY_INTEGRITY")
      ?.detail.includes("未达到400字符门槛"),
    true,
  );
  assert.equal(
    result.checks.find((item) => item.code === "CONTRACT_IDENTITY")?.status,
    "FAIL",
  );
  assert.equal(
    result.checks.find((item) => item.code === "MISSING_MATERIAL_DISCLOSED")
      ?.status,
    "PASS",
  );
});

test("封面师完整视觉HTML不因任务通用缺料描述被误判，依赖素材的复盘官仍须披露", () => {
  const requirement = "未知项：历史素材链接、账号发布时间全部未提供。";
  const visualBody = `<!doctype html><html><head><meta charset="utf-8"><title>品牌经营复盘封面</title></head><body><main><h1>验收门店A经营复盘</h1><p>营业额100000元，订单2000单，食材成本35000元，目标食材成本率32%。</p><section>以清晰的大标题、经营数字和复盘主题构成可直接审阅的视觉层级。</section></main></body></html>${"视觉规范包含字号、留白、颜色、对齐和移动端安全区。".repeat(12)}`;
  assert.ok(visualBody.length >= 400);
  const coverResult = auditEmployeeOutput(
    contentRoleRecord(6, "cover", { body: visualBody, requirement }),
  );
  assert.equal(coverResult.verdict, "PASS_QUALITY");
  const coverDisclosure = coverResult.checks.find(
    (item) => item.code === "MISSING_MATERIAL_DISCLOSED",
  );
  assert.equal(coverDisclosure?.status, "PASS");
  assert.equal(coverDisclosure?.applicable, false);
  assert.equal(coverDisclosure?.roleRequiresDisclosure, false);

  const retrospectiveBody =
    "本期复盘围绕内容结构、读者反馈、经营事实和下一轮选题形成结论。".repeat(24);
  const retroResult = auditEmployeeOutput(
    contentRoleRecord(9, "retro", { body: retrospectiveBody, requirement }),
  );
  assert.equal(retroResult.verdict, "FAIL_QUALITY");
  assert.deepEqual(retroResult.failedChecks, [
    "CONTRACT_IDENTITY",
    "MISSING_MATERIAL_DISCLOSED",
  ]);
  const retroDisclosure = retroResult.checks.find(
    (item) => item.code === "MISSING_MATERIAL_DISCLOSED",
  );
  assert.equal(retroDisclosure?.applicable, true);
  assert.equal(retroDisclosure?.roleRequiresDisclosure, true);
});

test("演绎师以身份匹配的素材主HTML做正文审计，同时保留短业务摘要", () => {
  const summary = "演绎任务已生成一份可供老板审阅的网页成果。".padEnd(
    101,
    "。",
  );
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>老板经营复盘</title></head><body><main><h1>经营复盘与下一步</h1><p>本期营业额100000元，订单2000单，食材成本35000元，目标食材成本率32%。</p>${"<section><h2>决策视角</h2><p>页面使用清晰的信息层级呈现经营事实、关键判断和下一步行动，供负责人逐项审阅。</p></section>".repeat(18)}</main></body></html>`;
  const base = contentRoleRecord(7, "deck", {
    body: summary,
    requirement: "把已知经营事实整理成可供负责人审阅的网页。",
  });
  const record = {
    ...base,
    source: {
      ...base.source,
      artifactSnapshotJson: JSON.stringify({
        kind: "html",
        primary: true,
        mediaType: "text/html",
        employeeIdx: 7,
        employeeKey: "deck",
        content: html,
      }),
    },
  };
  const result = auditEmployeeOutput(record);
  const bodyCheck = result.checks.find(
    (item) => item.code === "BODY_INTEGRITY",
  );
  assert.equal(record.body, summary);
  assert.equal(result.verdict, "PASS_QUALITY");
  assert.equal(bodyCheck?.status, "PASS");
  assert.equal(bodyCheck?.bodySource, "material_primary_artifact");
  assert.equal(bodyCheck?.chars, html.trim().length);
  assert.equal(
    JSON.stringify(result).includes("页面使用清晰的信息层级"),
    false,
  );
});

test("演绎师素材快照损坏或主工件身份不匹配时不得替代短摘要", () => {
  const summary = "演绎任务业务摘要。".padEnd(101, "。");
  const longHtml = `<html><body>${"这段内容来自身份不匹配的工件，绝不能被当前员工用于质量验收。".repeat(30)}</body></html>`;
  const base = contentRoleRecord(7, "deck", {
    body: summary,
    requirement: "把已知经营事实整理成可供负责人审阅的网页。",
  });
  const snapshots = [
    '{"kind":"html","primary":true,',
    JSON.stringify({
      kind: "html",
      primary: true,
      mediaType: "text/html",
      employeeIdx: 6,
      employeeKey: "cover",
      content: longHtml,
    }),
  ];
  for (const artifactSnapshotJson of snapshots) {
    const result = auditEmployeeOutput({
      ...base,
      source: { ...base.source, artifactSnapshotJson },
    });
    const bodyCheck = result.checks.find(
      (item) => item.code === "BODY_INTEGRITY",
    );
    assert.equal(result.verdict, "FAIL_QUALITY");
    assert.deepEqual(result.failedChecks, ["BODY_INTEGRITY"]);
    assert.equal(bodyCheck?.bodySource, "business_record");
    assert.equal(bodyCheck?.chars, summary.length);
  }
});

test("外部动作扫描区分已执行、禁止声明和建议计划", () => {
  assert.deepEqual(findExternalActionClaims("我们已经发布，并已成功付款。"), [
    "PAY",
    "PUBLISH",
  ]);
  assert.deepEqual(
    findExternalActionClaims("禁止声明已发布、已采购、已付款；尚未签约。"),
    [],
  );
  assert.deepEqual(
    findExternalActionClaims("建议发布，待人工审核后再投放。"),
    [],
  );
});

test("事实和占位扫描只返回脱敏类别与数值冲突", () => {
  assert.deepEqual(findPlaceholderSignals("正式产出\n{{brand_name}}\nTODO"), [
    "TODO_TOKEN",
    "TEMPLATE_VARIABLE",
  ]);
  assert.deepEqual(
    findPlaceholderSignals(
      "公开客流样本待补充，现场峰值待核验；证据齐备前不下定论。",
    ),
    [],
  );
  assert.deepEqual(findPlaceholderSignals("待填写：门店名称"), [
    "PLAIN_RUNTIME_PLACEHOLDER",
  ]);
  const audit = findKnownFactConflicts(
    "验收门店A本期营业额为9万元，但目标营业额为12万元。",
    "restaurant",
  );
  assert.deepEqual(audit.conflicts, [
    { code: "REVENUE", expected: 100000, observed: 90000, unit: "元" },
  ]);
  assert.deepEqual(
    findKnownFactConflicts(
      "实际订单为2000单；按已知贡献率测算的保本订单=1153单/月。",
      "restaurant",
    ).conflicts,
    [],
  );
  assert.deepEqual(
    findKnownFactConflicts("实际订单=1153单。", "restaurant").conflicts,
    [{ code: "ORDERS", expected: 2000, observed: 1153, unit: "单" }],
  );
  assert.deepEqual(
    findKnownFactConflicts("盈亏平衡分析中，实际订单=1153单。", "restaurant")
      .conflicts,
    [{ code: "ORDERS", expected: 2000, observed: 1153, unit: "单" }],
  );
});

test("历史质量审计复用撰稿事实门禁，覆盖run#4营销编造且不落原句", () => {
  const requirement =
    "已核验事实：产品名为“双人招牌套餐”；目标人群为太原本地周末两人同行顾客；目标动作是到店预约。价格、折扣、菜品明细、库存、地址、营业时间、联系电话和赠品均未提供。";
  const actualRun4Body =
    "周末又到了，两个人不知道去哪吃？别纠结了，这家店的双人招牌套餐我已经替你们试过了，真的绝！每一道都是招牌水准，分量刚好适合两个人。环境也超棒，适合约会、闺蜜小聚。周末人超多，一定要提前预约哦！现在就可以私信预约周末时段，锁定你的专属双人位。期待你们享受这份周末限定快乐。";
  const audit = findUnsupportedMarketingFactConflicts(
    actualRun4Body,
    requirement,
  );
  assert.ok(audit.checked >= 8);
  assert.deepEqual(
    new Set(audit.conflicts.map((item) => item.category)),
    new Set([
      "亲历/体验背书",
      "产品品质/口味",
      "分量/适用人数",
      "环境/氛围/服务体验",
      "消费场景适配",
      "热度/客流/拥挤",
      "预约渠道/可预约/锁位",
      "限定/稀缺性",
    ]),
  );
  assert.equal(JSON.stringify(audit).includes("我已经替你们试过"), false);
  assert.equal(JSON.stringify(audit).includes("现在就可以私信预约"), false);

  const sensoryQuality = findUnsupportedMarketingFactConflicts(
    "双人招牌套餐香气扑鼻，口感层次丰富，门店出品在线。",
    requirement,
  );
  assert.equal(sensoryQuality.checked, 3);
  assert.deepEqual(
    new Set(sensoryQuality.conflicts.map((item) => item.category)),
    new Set(["产品品质/口味"]),
  );
  assert.equal(JSON.stringify(sensoryQuality).includes("香气扑鼻"), false);

  const groundedSensoryQuality = findUnsupportedMarketingFactConflicts(
    "双人招牌套餐香气扑鼻，口感层次丰富，门店出品在线。",
    `${requirement} 已核验事实：双人招牌套餐香气扑鼻、口感层次丰富，门店出品在线。`,
  );
  assert.deepEqual(groundedSensoryQuality.conflicts, []);

  const conditional = findUnsupportedMarketingFactConflicts(
    "如需预约，请在发布前补齐并确认预约渠道；渠道核验完成后再引导预约，不声称当前已经开放预约。",
    requirement,
  );
  assert.deepEqual(conditional.conflicts, []);

  const verifiedWebFact = findUnsupportedMarketingFactConflicts(
    "本店环境安静。",
    {
      requirement,
      web: {
        verified: true,
        results: [{ snippet: "现场核验记录：本店环境安静。" }],
      },
    },
  );
  assert.deepEqual(verifiedWebFact.conflicts, []);

  const paddedBody = `${actualRun4Body}\n${"本段只用于补足审计长度，不新增任何门店事实。".repeat(20)}`;
  const result = auditEmployeeOutput(
    contentRoleRecord(3, "draft", {
      body: paddedBody,
      requirement,
    }),
  );
  assert.equal(result.verdict, "FAIL_QUALITY");
  assert.deepEqual(result.failedChecks, ["KNOWN_FACTS_CONSISTENT"]);
  const check = result.checks.find(
    (item) => item.code === "KNOWN_FACTS_CONSISTENT",
  );
  assert.equal(check?.status, "FAIL");
  assert.ok(check?.marketingClaimsDetected >= 8);
  assert.equal(JSON.stringify(check).includes("周末人超多"), false);
});

test("脱敏JSON和Markdown不落盘正文、任务原文或完整尝试ID", () => {
  const record = restaurantRecord({
    body: `${restaurantRecord().body}\n不可落盘的秘密正文`,
  });
  const matrix = {
    run: { selectedJobs: ["restaurant:101"] },
    jobs: {
      "restaurant:101": { latest: { pass: true, verdict: "PASS_REAL_API" } },
    },
  };
  const report = buildEmployeeOutputQualityAudit({
    matrix,
    records: [record],
    matrixFile: "/tmp/matrix.json",
    databaseFile: "/tmp/private.db",
  });
  const json = JSON.stringify(report);
  const markdown = renderEmployeeOutputQualityAuditMarkdown(report);
  for (const forbidden of [
    "不可落盘的秘密正文",
    "岗位验收资料-101-1",
    "attempt-secret",
    "/tmp/private.db",
  ]) {
    assert.equal(json.includes(forbidden), false, forbidden);
    assert.equal(markdown.includes(forbidden), false, forbidden);
  }
  assert.equal(report.summary.overallStatus, "PASS_PARTIAL");
});
