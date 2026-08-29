import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVISOR_MODULE_PERMISSION_ERROR,
  AUTHORIZATION_BOUNDARY_KEYS,
  EXCLUDED_FEATURES,
  FEATURE_DEFINITIONS,
  FEATURE_SEMANTIC_SCENARIOS,
  REAL_FEATURE_MATRIX_SCHEMA,
  TOOLBOX_CASES,
  advisorFlowReadbackValid,
  artifactReadbackEvidence,
  automationRunReady,
  backgroundContentReady,
  billingEvidenceFromRows,
  buildDeterministicVisionFixturePng,
  buildFeatureJobs,
  classifyFeatureAttempt,
  checkpointPassReusable,
  compareTenantSnapshots,
  createFeatureState,
  exactBillingLedgerEvidence,
  evaluateFeatureSemantics,
  featureExecutionFingerprint,
  isYunwuCloudBaseUrl,
  isAdvisorModulePermissionDenial,
  isLocalServiceBaseUrl,
  isModulePermissionDenial,
  mergeFeatureAttempt,
  normalizeFeatureState,
  parseOnlyFilter,
  parsePositiveInteger,
  parseSseEvents,
  requestWithRetryPolicy,
  restaurantTaskFlowReadback,
  roleMatchesMatrixLane,
  sanitizeEvidence,
} from "../../scripts/lib/real-feature-matrix.mjs";

function passingAttempt(overrides = {}) {
  const attempt = {
    featureKey: "test:feature",
    providerPolicy: "direct",
    externalSideEffects: false,
    persistent: true,
    terminalStatus: "completed",
    terminalValid: true,
    contractValid: true,
    aiMode: "api",
    models: ["gpt-5.5"],
    inputTokens: 300,
    outputTokens: 180,
    billingState: "settled",
    billingHoldIds: [700],
    expectedBillingCount: 1,
    billingEvidenceCount: 1,
    billingEvidenceMissingFeatures: [],
    exactBillingLedgerPass: true,
    exactBillingLedgerErrors: [],
    expectedFeatures: ["测试功能·真实调用"],
    billingEvidence: [
      {
        id: 88,
        feature: "测试功能·真实调用",
        model: "gpt-5.5",
        inputTokens: 300,
        outputTokens: 180,
        aiMode: "api",
        holdId: 700,
        holdLogId: 88,
        holdStatus: "settled",
        settledCredits: 50,
        credits: 50,
      },
    ],
    businessIds: [101],
    templateFingerprintDetected: false,
    resultChars: 120,
    resultHash: "a".repeat(64),
    l2Pass: true,
    reviewPolicy: "boss_test_zero_approvals",
    approvalCountsBefore: { approvals: 5, approvalsPending: 0, reviewPending: 0 },
    approvalCountsAfter: { approvals: 5, approvalsPending: 0, reviewPending: 0 },
    approvalDelta: 0,
    reviewPendingDelta: 0,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "semanticEvidence")) {
    attempt.semanticEvidence = {
      oracleVersion: "feature-semantic-oracles.v1",
      featureKey: attempt.featureKey,
      checks: [{ id: "fixture", pass: true, expectation: "单元测试语义证据" }],
      pass: true,
      errors: [],
    };
    attempt.semanticErrors = [];
  }
  return attempt;
}

function passingPermissionBoundaryAttempt(overrides = {}) {
  const attempt = {
    featureKey: "advisor:manager:standard",
    expectation: "authorization_boundary",
    providerPolicy: "authorization_boundary",
    externalSideEffects: false,
    requestReachedLocalService: true,
    endpoint: "/api/advisor/chat",
    endpointTemplate: "/api/advisor/chat",
    method: "POST",
    modulePermissionAbsent: true,
    httpStatus: 403,
    boundaryError: ADVISOR_MODULE_PERMISSION_ERROR,
    readbackHttpStatus: 403,
    readbackError: ADVISOR_MODULE_PERMISSION_ERROR,
    artifactProbeComplete: true,
    artifactReadbackFound: false,
    businessArtifactCreated: false,
    businessArtifactAbsenceProven: true,
    businessArtifactProof: {
      strategy: "pre_handler_guard_plus_full_tenant_database_snapshot",
      guardBeforeHandler: true,
      databaseSnapshotEqual: true,
      changedTables: [],
      responseBusinessIdCount: 0,
      newBillingOrHoldRows: 0,
    },
    businessIds: [],
    persistent: false,
    expectedFeatures: ["老板参谋诊断"],
    expectedBillingCount: 0,
    billingAuditComplete: true,
    billingProbeBeforeId: 100,
    billingProbeAfterId: 100,
    billingEvidenceCount: 0,
    billingEvidenceMissingFeatures: [],
    billingEvidenceExpectedAbsentFeatures: ["老板参谋诊断"],
    billingEvidence: [],
    billingHoldIds: [],
    billingState: null,
    aiMode: null,
    models: [],
    inputTokens: 0,
    outputTokens: 0,
    costYuan: 0,
    chargedCredits: 0,
    resultChars: 0,
    resultHash: null,
    terminalStatus: "authorization_denied",
    terminalValid: true,
    contractValid: true,
    contractErrors: [],
    l2Pass: true,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "semanticEvidence")) {
    attempt.semanticEvidence = {
      oracleVersion: "feature-semantic-oracles.v1",
      featureKey: attempt.featureKey,
      checks: [
        { id: "permission-fixture", pass: true, expectation: "权限语义证据" },
      ],
      pass: true,
      errors: [],
    };
    attempt.semanticErrors = [];
  }
  return attempt;
}

function mockHttpResponse(status, payload, headers = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (key) => normalizedHeaders.get(String(key).toLowerCase()) || null,
    },
    text: async () => (payload == null ? "" : JSON.stringify(payload)),
  };
}

test("非70员工矩阵盘点36个可安全入口并明确隔离不可逆功能", () => {
  assert.equal(FEATURE_DEFINITIONS.length, 36);
  assert.deepEqual(
    Object.keys(FEATURE_SEMANTIC_SCENARIOS).sort(),
    FEATURE_DEFINITIONS.map((item) => item.key).sort(),
  );
  assert.equal(new Set(FEATURE_DEFINITIONS.map((item) => item.key)).size, 36);
  assert.ok(FEATURE_DEFINITIONS.every((item) => item.endpoints.length > 0));
  assert.ok(
    FEATURE_DEFINITIONS.every((item) =>
      item.endpoints.every((endpoint) => endpoint.startsWith("/api/")),
    ),
  );
  const aiDeliveries = FEATURE_DEFINITIONS.filter(
    (item) => item.expectation === "real_ai_delivery",
  );
  const permissionBoundaries = FEATURE_DEFINITIONS.filter(
    (item) => item.expectation === "authorization_boundary",
  );
  assert.equal(aiDeliveries.length, 31);
  assert.equal(permissionBoundaries.length, 5);
  assert.deepEqual(
    permissionBoundaries.map((item) => item.key),
    [...AUTHORIZATION_BOUNDARY_KEYS],
  );
  assert.ok(
    aiDeliveries.every((item) =>
      ["api", "api_from_same_run_source"].includes(item.assertions.mode),
    ),
  );
  assert.ok(
    aiDeliveries.every(
      (item) => item.assertions.model === "real_non_template_model",
    ),
  );
  assert.ok(
    aiDeliveries.every(
      (item) =>
        item.assertions.tokens ===
        "positive_input_and_output_for_every_billing_row",
    ),
  );
  assert.ok(
    aiDeliveries.every(
      (item) =>
        item.assertions.billing === "settled_with_hold_id_and_credit_log",
    ),
  );
  assert.ok(
    aiDeliveries.every(
      (item) =>
        item.assertions.persistence === "authenticated_readback_required",
    ),
  );
  assert.ok(
    aiDeliveries.every(
      (item) =>
        item.assertions.terminal === "feature_terminal_contract_required",
    ),
  );
  assert.ok(
    aiDeliveries.every(
      (item) =>
        item.assertions.output === "non_empty_contract_valid_hash_required",
    ),
  );
  assert.ok(
    aiDeliveries.every((item) =>
      item.assertions.semantic.includes("oracle_required"),
    ),
  );
  assert.ok(
    permissionBoundaries.every(
      (item) => item.providerPolicy === "authorization_boundary",
    ),
  );
  assert.ok(
    permissionBoundaries.every(
      (item) => item.assertions.mode === "no_ai_call_due_to_module_guard",
    ),
  );
  assert.ok(
    permissionBoundaries.every(
      (item) => item.assertions.billing === "no_new_credit_log_or_hold",
    ),
  );
  assert.ok(
    permissionBoundaries.every(
      (item) =>
        item.assertions.terminal === "http_403_exact_module_permission_denial",
    ),
  );
  assert.ok(
    permissionBoundaries.every(
      (item) =>
        item.assertions.semantic ===
        "role_lane_and_zero_effects_oracle_required",
    ),
  );
  assert.deepEqual(
    FEATURE_DEFINITIONS.filter((item) => item.kind === "marshal_chat").map(
      (item) => item.key,
    ),
    [
      "marshal-chat:boss:sync",
      "marshal-chat:manager:sse",
      "marshal-chat:employee:forbidden",
    ],
  );
  assert.deepEqual(
    FEATURE_DEFINITIONS.filter((item) => item.kind === "marshal_task").map(
      (item) => item.key,
    ),
    [
      "marshal-task:boss:specialist",
      "marshal-task:manager:department",
      "marshal-task:employee:forbidden",
    ],
  );
  assert.ok(
    FEATURE_DEFINITIONS.find(
      (item) => item.key === "marshal-skill-file:boss:four-formats",
    )?.endpoints.includes("/api/marshals/:id/skill-file"),
  );
  assert.ok(
    FEATURE_DEFINITIONS.find(
      (item) => item.key === "system-kb:manager:image-vision",
    )?.endpoints.includes("/api/sys/kb/upload"),
  );
  assert.deepEqual(Object.keys(TOOLBOX_CASES), [
    "hot",
    "remix",
    "pcal",
    "bench",
    "warm",
    "leads",
    "shot",
    "vars",
  ]);
  for (const key of Object.keys(TOOLBOX_CASES)) {
    assert.ok(
      FEATURE_DEFINITIONS.some((item) => item.key === `toolbox:${key}`),
    );
  }
  assert.ok(
    FEATURE_DEFINITIONS.find(
      (item) => item.key === "growth:objection",
    )?.endpoints.includes("/api/growth/leads/:id/objections"),
  );
  const excludedEndpoints = EXCLUDED_FEATURES.flatMap((item) => item.endpoints);
  assert.ok(
    excludedEndpoints.some((endpoint) => endpoint.includes("recharge")),
  );
  assert.ok(excludedEndpoints.some((endpoint) => endpoint.includes("feishu")));
  assert.ok(
    excludedEndpoints.some((endpoint) => endpoint.includes("publish-log")),
  );
  assert.ok(
    excludedEndpoints.some((endpoint) => endpoint.includes("generate-video")),
  );
  assert.ok(EXCLUDED_FEATURES.every((item) => item.reason.length >= 12));
});

test("only过滤精确选择功能且并发硬限制为3", () => {
  const selected = buildFeatureJobs(
    parseOnlyFilter("toolbox:hot,growth:objection,files:artifacts"),
  );
  assert.deepEqual(
    selected.map((item) => item.key),
    ["toolbox:hot", "growth:objection", "files:artifacts"],
  );
  assert.throws(() => parseOnlyFilter("unknown:feature"), /未知功能/u);
  assert.equal(parsePositiveInteger("3", 1, { min: 1, max: 3 }), 3);
  assert.equal(parsePositiveInteger("4", 1, { min: 1, max: 3 }), 1);
});

const semanticContentText = [
  "已知营业额100000元、采购入库35000元、订单2000单。",
  "采购入库占营业额35%，客单收入50元/单；这两项是可复核的派生指标。",
  "期初/期末库存未提供，报损、调拨也未提供，因此不能把35%认定为食材成本率。",
  "本文仅作内部待审核初稿，未发布；负责人核对盘点、报损和调拨台账后再下结论。",
].join("");

function validPlan({ people = 12, deal = 3, budget = 2000 } = {}) {
  return {
    theme: `已授权顾客团队聚餐验收活动，目标人数${people}人`,
    flow: [
      { time: "17:00", item: "负责人核对菜单与过敏原" },
      { time: "17:30", item: "签到并确认联系授权" },
      { time: "18:00", item: "用餐与履约检查" },
      { time: "20:00", item: "当日数据归档与复盘" },
    ],
    materials: ["授权签到表", "菜单确认单", "食安与过敏原提示"],
    sop: ["店长在活动前审批价格", "厨师长核对食材", "运营在24小时内归档"],
    kpi: { targetJoin: `${people}人`, targetDeal: `${deal}单` },
    budgetNote: `预算上限${budget}元，优惠与对外承诺待负责人审批`,
  };
}

function validPpt() {
  const page = (title, extra) => ({
    title,
    bullets: [`${extra}：负责人核对`, `${extra}：截止下周一`],
    note: `说明${extra}的事实与未知边界`,
  });
  return {
    title: "门店一周经营复盘",
    subtitle: "仅内部待审核",
    pages: [
      page("数据口径", "营业额100000元、采购入库35000元、订单2000单"),
      page("异常定位", "采购入库占营业额35%、客单收入50元/单"),
      page("行动方案", "期初/期末库存未提供"),
      page("风险边界", "报损、调拨未提供，不能认定食材成本率为35%"),
      page("下周检查", "盘点、报损、调拨台账验收"),
    ],
  };
}

test("36条功能均有可执行L2 oracle，正向fixture不依赖网络也能逐条通过", () => {
  const advisor =
    "事实依据：仅使用当前可见数据。未知项：库存待确认。三个执行动作均写明负责人、截止时间和检查标准。风险边界：不编造已完成动作。";
  const custom =
    "已知营业额100000元、采购入库35000元，采购占比35%但不能认定食材成本率为35%。期初库存、期末库存未提供；核验清单包含报损、调拨、盘点台账和原始凭证，检查标准是账实一致。";
  const activityReview =
    "数据证据：邀约30、报名18、到场14、成交4，邀约到报名率60%，报名到到场率77.8%，到场到成交率28.6%，ROI 3.2。三条改进均带检查标准；负责人在24小时内回访并经顾客授权，不引用行业均值。";
  const growthReply =
    "1. 您好，已知是6至10人团队聚餐，请确认日期和人数。2. 我先核对菜单和预算，再由员工审核回复。3. 方便告知日期、人数、菜单偏好和预算吗？这是待员工审核话术。";
  const growthObjection =
    "理解您担心团队聚餐当天菜单和价格变化。我们先核对需求，再用书面确认单记录菜单、价格和截止时间，由负责人人工复核后回复，不作未审批保证。";
  const toolboxSuffix =
    "负责人须在发布前完成人工审核、事实核验和检查，系统不会自动对外发布或触达。";
  const toolbox = {
    "toolbox:hot": `验收门店A招牌菜，微信公众号和小红书双渠道。标题1：后厨记录；标题2：菜品故事；标题3：制作细节。${toolboxSuffix}`,
    "toolbox:remix": `视频号分镜依次使用门头、后厨备餐、招牌菜成品、老板口播，字幕按口播断句。肖像与音乐授权待确认。${toolboxSuffix}`,
    "toolbox:pcal": `2026-08企业微信与朋友圈日历：每周分别回答菜品、食安和用餐场景，负责人周五复盘响应数据。${toolboxSuffix}`,
    "toolbox:bench": `对标门店甲与对标门店乙，周期2026-07-01至2026-07-31；只建立公开证据和公开链接核验步骤，再找差异化。${toolboxSuffix}`,
    "toolbox:warm": `小红书30天起号，定位经营1至3家餐饮门店的老板；每周完成选题、制作、审核和复盘。${toolboxSuffix}`,
    "toolbox:leads": `上海市静安区验收商圈，聚焦6至10人团队聚餐的企业行政；只用公开渠道，不抓取隐私，不自动触达，人工确认和跟进。${toolboxSuffix}`,
    "toolbox:shot": `验收招牌菜A已核实堂食现做，图片为门店自有拍摄；分别交付菜单页与小红书文案、配图和发布前检查。${toolboxSuffix}`,
    "toolbox:vars": `视频号口播围绕营业额、采购入库、库存变化和报损；版本1重事实，版本2重流程，版本3重核对。${toolboxSuffix}`,
  };
  const plan12 = validPlan();
  const plan18 = validPlan({ people: 18, deal: 4, budget: 3000 });
  const ppt = validPpt();
  const dailyParts = ["短视频脚本", "朋友圈文案", "社群话题"].map(
    (type, index) => ({
      type,
      body: `${type}第${index + 1}版。${semanticContentText}`,
    }),
  );
  const visionText =
    "图片中文字是 NANOWORK，年份数字是2026，右侧大号数字是47，底部为蓝色色块并写有BLUE。图像内容清晰可供后续引用。";
  const marshalChatText = `${semanticContentText} 负责人须在本周五前完成核验，检查标准为库存、报损与调拨台账可勾稽。`;
  const skillText = [
    `## Word docx\n# 经营复盘\n摘要与结论。${semanticContentText}`,
    `## Excel xlsx\n| 字段 | 数值 |\n| 营业额 | 100000 |\n公式=35000/100000。${semanticContentText}`,
    `## PPT pptx\n# 口径\n${semanticContentText}\n---\n# 已知\n数据\n---\n# 未知\n数据\n---\n# 核验\n动作\n---\n# 风险\n结论`,
    `## PDF pdf\n# 正式报告\n摘要、执行建议、风险边界和结论。${semanticContentText}`,
  ].join("\n");
  const fixtures = {
    "advisor:boss:standard": { resultText: advisor },
    "advisor:boss:web-deep": {
      resultText: advisor,
      metadata: { sourceCount: 2 },
    },
    "custom-agent:boss": { resultText: custom },
    "custom-agent:manager": { resultText: custom },
    "custom-agent:employee": { resultText: custom },
    ...Object.fromEntries(
      Object.entries(toolbox).map(([key, resultText]) => [key, { resultText }]),
    ),
    "activity:existing-plan": {
      resultText: JSON.stringify(plan12),
      structured: plan12,
    },
    "activity:plan-draft": {
      resultText: JSON.stringify(plan18),
      structured: plan18,
    },
    "activity:review": { resultText: activityReview },
    "growth:suggest-reply": { resultText: growthReply },
    "growth:objection": { resultText: growthObjection },
    "content:generate": { resultText: semanticContentText },
    "content:generate-background": { resultText: semanticContentText },
    "content:ppt": { resultText: JSON.stringify(ppt), structured: ppt },
    "content:daily-pack": {
      resultText: dailyParts.map((item) => item.body).join("\n"),
      structured: dailyParts,
    },
    "content:automation": { resultText: semanticContentText },
    "files:vision": { resultText: visionText },
    "files:artifacts": {
      resultText: `# 真实云API经营建议\n${advisor}\n来源哈希：${"a".repeat(64)}\n只做格式转换，不对外发布。`,
    },
    "marshal-chat:boss:sync": {
      resultText: marshalChatText,
      metadata: { transport: "json", replyPersisted: true },
    },
    "marshal-chat:manager:sse": {
      resultText: marshalChatText,
      metadata: {
        transport: "sse",
        replyPersisted: true,
        sseDone: true,
        sseEventCount: 3,
      },
    },
    "marshal-chat:employee:forbidden": {
      metadata: {
        roleLaneMatched: true,
        exactModuleDenial: true,
        zeroBillingAndArtifacts: true,
      },
    },
    "marshal-skill-file:boss:four-formats": {
      resultText: skillText,
      metadata: {
        formats: ["docx", "xlsx", "pptx", "pdf"],
        artifactCount: 4,
        downloadedCount: 4,
      },
    },
    "marshal-skill-file:employee:forbidden": {
      metadata: {
        roleLaneMatched: true,
        exactModuleDenial: true,
        zeroBillingAndArtifacts: true,
      },
    },
    "system-kb:manager:image-vision": {
      resultText: visionText,
      metadata: { kbDocumentPersisted: true, knowledgeAssetPersisted: true },
    },
    "marshal-task:boss:specialist": {
      resultText: semanticContentText,
      metadata: {
        reviewReady: true,
        specialistAssigned: true,
        flowReadbackValid: true,
      },
    },
    "marshal-task:manager:department": {
      resultText: semanticContentText,
      metadata: {
        reviewReady: true,
        specialistAssigned: false,
        flowReadbackValid: true,
      },
    },
    "marshal-task:employee:forbidden": {
      metadata: {
        roleLaneMatched: true,
        exactModuleDenial: true,
        zeroBillingAndArtifacts: true,
      },
    },
    "advisor:manager:standard": {
      metadata: {
        roleLaneMatched: true,
        exactModuleDenial: true,
        zeroBillingAndArtifacts: true,
      },
    },
    "advisor:employee:standard": {
      metadata: {
        roleLaneMatched: true,
        exactModuleDenial: true,
        zeroBillingAndArtifacts: true,
      },
    },
  };
  assert.deepEqual(
    Object.keys(fixtures).sort(),
    FEATURE_DEFINITIONS.map((item) => item.key).sort(),
  );
  for (const feature of FEATURE_DEFINITIONS) {
    const result = evaluateFeatureSemantics(feature.key, fixtures[feature.key]);
    assert.equal(
      result.pass,
      true,
      `${feature.key}: ${result.errors.join("；")}`,
    );
    assert.ok(result.checks.length > 0, feature.key);
  }
});

test("L2反例：空泛、幻觉、错算、错识图均不能通过", () => {
  const cases = [
    [
      "custom-agent:boss",
      "建议加强管理，提高效率，持续优化经营。待填写，待指定，请自行补充。",
    ],
    [
      "growth:suggest-reply",
      "您好，8月18日可订，团餐价199元，赠送果盘且仅剩3桌，请立即付款锁定。这是三条话术的统一答复。",
    ],
    [
      "content:generate",
      "已知营业额100000元、采购入库35000元、订单2000单，所以食材成本率为35%，客单收入75元/单。库存、报损和调拨都很正常，内容已发布。",
    ],
    [
      "activity:review",
      "邀约30人、报名18人、到场14人、成交4人；报名率50%、到场率80%、成交率40%、ROI 4.2。接下来加强管理。",
    ],
    [
      "files:vision",
      "图中文字为NAN0WORK，年份2028，数字74，主要颜色为红色。这是一张清晰可读的企业资料卡片。",
    ],
  ];
  for (const [featureKey, resultText] of cases) {
    const result = evaluateFeatureSemantics(featureKey, { resultText });
    assert.equal(result.pass, false, featureKey);
    assert.ok(result.errors.length > 0, featureKey);
  }
});

test("识图fixture是640x360真实PNG而非1x1像素", () => {
  const png = buildDeterministicVisionFixturePng();
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 640);
  assert.equal(png.readUInt32BE(20), 360);
  assert.ok(png.length > 2000);
});

test("非幂等POST网络异常只发送1次并标记结果不确定，绝不自动重放", async () => {
  let calls = 0;
  const sleeps = [];
  await assert.rejects(
    requestWithRetryPolicy("http://127.0.0.1:3108/api/content/daily-pack", {
      method: "POST",
      body: "{}",
      requestLabel: "/api/content/daily-pack",
      fetchFn: async () => {
        calls += 1;
        throw new Error("socket aborted after server execution");
      },
      sleepFn: async (delay) => {
        sleeps.push(delay);
      },
      signalFactory: () => undefined,
    }),
    (error) =>
      error.code === "AMBIGUOUS_MUTATION_RESULT" &&
      error.retryable === false &&
      error.networkAttempts === 1 &&
      /daily-pack/u.test(error.message),
  );
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);

  let bodyReadFetches = 0;
  await assert.rejects(
    requestWithRetryPolicy("http://127.0.0.1:3108/api/content/daily-pack", {
      method: "POST",
      fetchFn: async () => {
        bodyReadFetches += 1;
        return {
          ...mockHttpResponse(200, { id: 1 }),
          text: async () => {
            throw new Error("response body aborted");
          },
        };
      },
      sleepFn: async () => {},
      signalFactory: () => undefined,
    }),
    (error) => error.code === "AMBIGUOUS_MUTATION_RESULT",
  );
  assert.equal(bodyReadFetches, 1);

  for (const method of ["PUT", "DELETE"]) {
    let mutationCalls = 0;
    await assert.rejects(
      requestWithRetryPolicy("http://127.0.0.1:3108/api/mutation", {
        method,
        fetchFn: async () => {
          mutationCalls += 1;
          throw new Error("connection lost");
        },
        sleepFn: async () => {},
        signalFactory: () => undefined,
      }),
      (error) => error.code === "AMBIGUOUS_MUTATION_RESULT",
    );
    assert.equal(mutationCalls, 1, method);
  }
});

test("GET/HEAD网络异常仍按安全读请求策略重试", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await requestWithRetryPolicy(
    "http://127.0.0.1:3108/api/admin/credits/logs",
    {
      method: "GET",
      fetchFn: async () => {
        calls += 1;
        if (calls < 3) throw new Error("temporary disconnect");
        return mockHttpResponse(200, { rows: [] });
      },
      sleepFn: async (delay) => {
        sleeps.push(delay);
      },
      signalFactory: () => undefined,
    },
  );
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.deepEqual(result.payload, { rows: [] });
});

test("POST明确收到429时仍遵循Retry-After，不把限流误当成结果不确定", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await requestWithRetryPolicy(
    "http://127.0.0.1:3108/api/content/generate",
    {
      method: "POST",
      body: "{}",
      fetchFn: async () => {
        calls += 1;
        return calls === 1
          ? mockHttpResponse(
              429,
              { error: "请稍后重试" },
              { "retry-after": "3" },
            )
          : mockHttpResponse(200, { id: 9 });
      },
      sleepFn: async (delay) => {
        sleeps.push(delay);
      },
      signalFactory: () => undefined,
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [3000]);
  assert.deepEqual(result.payload, { id: 9 });

  let interrupted429Calls = 0;
  const interrupted429 = await requestWithRetryPolicy(
    "http://127.0.0.1:3108/api/content/generate",
    {
      method: "POST",
      fetchFn: async () => {
        interrupted429Calls += 1;
        if (interrupted429Calls === 1) {
          return {
            ...mockHttpResponse(429, null, { "retry-after": "1" }),
            text: async () => {
              throw new Error("rate-limit body interrupted");
            },
          };
        }
        return mockHttpResponse(200, { id: 10 });
      },
      sleepFn: async () => {},
      signalFactory: () => undefined,
    },
  );
  assert.equal(interrupted429Calls, 2);
  assert.deepEqual(interrupted429.payload, { id: 10 });

  let noRetryCalls = 0;
  await assert.rejects(
    requestWithRetryPolicy("http://127.0.0.1:3108/api/auth/login", {
      method: "POST",
      retry429: false,
      fetchFn: async () => {
        noRetryCalls += 1;
        return mockHttpResponse(429, { error: "登录限流" });
      },
      sleepFn: async () => {},
      signalFactory: () => undefined,
    }),
    (error) => error.status === 429,
  );
  assert.equal(noRetryCalls, 1);
});

test("变更请求只有调用点显式提供幂等重放证明时才能网络重试", async () => {
  let calls = 0;
  const result = await requestWithRetryPolicy(
    "http://127.0.0.1:3108/api/example-idempotent",
    {
      method: "PUT",
      mutationReplayProof: "server_enforces_deterministic_idempotency_key",
      fetchFn: async () => {
        calls += 1;
        if (calls === 1) throw new Error("connection reset");
        return mockHttpResponse(200, { ok: true });
      },
      sleepFn: async () => {},
      signalFactory: () => undefined,
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(result.payload, { ok: true });
});

test("真实矩阵只接受云雾公网HTTPS地址，拒绝本地mock与兼容代理冒充", () => {
  assert.equal(isYunwuCloudBaseUrl("https://yunwu.ai/v1"), true);
  assert.equal(isYunwuCloudBaseUrl("https://api.yunwu.ai/v1"), true);
  assert.equal(isYunwuCloudBaseUrl("http://yunwu.ai/v1"), false);
  assert.equal(isYunwuCloudBaseUrl("http://127.0.0.1:9999/v1"), false);
  assert.equal(isYunwuCloudBaseUrl("https://yunwu.ai.example.com/v1"), false);
  assert.equal(isYunwuCloudBaseUrl("https://example.com/v1"), false);
});

test("旧PASS只有在本地服务、租户、数据库、代码、场景与供应商指纹全部一致时才可复用", () => {
  const fingerprint = featureExecutionFingerprint({
    baseUrl: "http://127.0.0.1:3107",
    tenantId: 7,
    databaseIdentity: "db-hash",
    coreCodeHash: "code-hash",
    scenarioHash: "scenario-hash",
    providerHash: "provider-hash",
  });
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(
    checkpointPassReusable(
      { pass: true, executionFingerprint: fingerprint },
      fingerprint,
    ),
    true,
  );
  assert.equal(
    checkpointPassReusable(
      { pass: true, executionFingerprint: "a".repeat(64) },
      fingerprint,
    ),
    false,
  );
  assert.equal(checkpointPassReusable({ pass: true }, fingerprint), false);
  assert.throws(
    () =>
      featureExecutionFingerprint({
        baseUrl: "https://example.com",
        tenantId: 7,
        databaseIdentity: "db",
        coreCodeHash: "code",
        scenarioHash: "scenario",
        providerHash: "provider",
      }),
    /指纹证据/u,
  );
});

test("403零副作用必须是租户余额与所有租户表内容快照均不变", () => {
  const before = {
    tenant: { id: 7, credits: 1000 },
    tables: {
      tasks: { count: 1, digest: "a" },
      contents: { count: 2, digest: "b" },
    },
    digest: "before",
  };
  const equal = compareTenantSnapshots(before, { ...before, digest: "after" });
  assert.equal(equal.equal, true);
  assert.deepEqual(equal.changedTables, []);
  const changed = compareTenantSnapshots(before, {
    ...before,
    tables: { ...before.tables, tasks: { count: 1, digest: "changed" } },
    digest: "changed",
  });
  assert.equal(changed.equal, false);
  assert.deepEqual(changed.changedTables, ["tasks"]);
});

test("计费通过必须精确一笔流水对一笔已结算hold，且余额可复算", () => {
  const evidence = {
    rows: [
      {
        id: 11,
        credits: 30,
        holdId: 21,
        holdLogId: 11,
        holdStatus: "settled",
        settledCredits: 30,
      },
    ],
  };
  assert.equal(
    exactBillingLedgerEvidence({
      evidence,
      expectedCount: 1,
      expectedHoldIds: [21],
      balanceBefore: 1000,
      balanceAfter: 970,
      allNewLedgerCredits: 30,
    }).pass,
    true,
  );
  assert.equal(
    exactBillingLedgerEvidence({
      evidence: {
        rows: [
          ...evidence.rows,
          { ...evidence.rows[0], id: 12, holdId: 22, holdLogId: 12 },
        ],
      },
      expectedCount: 1,
      expectedHoldIds: [21],
      balanceBefore: 1000,
      balanceAfter: 970,
      allNewLedgerCredits: 30,
    }).pass,
    false,
  );
  assert.equal(
    exactBillingLedgerEvidence({
      evidence,
      expectedCount: 1,
      expectedHoldIds: [21],
      balanceBefore: 1000,
      balanceAfter: 980,
      allNewLedgerCredits: 30,
    }).pass,
    false,
  );
});

test("权限边界必须命中真实本地服务的精确403模块无权限", () => {
  assert.equal(isLocalServiceBaseUrl("http://127.0.0.1:3108"), true);
  assert.equal(isLocalServiceBaseUrl("http://localhost:3107"), true);
  assert.equal(isLocalServiceBaseUrl("https://[::1]:3107"), true);
  assert.equal(isLocalServiceBaseUrl("https://example.com"), false);
  assert.equal(
    isAdvisorModulePermissionDenial(403, {
      error: ADVISOR_MODULE_PERMISSION_ERROR,
    }),
    true,
  );
  assert.equal(
    isModulePermissionDenial(403, { error: ADVISOR_MODULE_PERMISSION_ERROR }),
    true,
  );
  assert.equal(
    isAdvisorModulePermissionDenial(401, {
      error: ADVISOR_MODULE_PERMISSION_ERROR,
    }),
    false,
  );
  assert.equal(
    isAdvisorModulePermissionDenial(403, { error: "任意禁止错误" }),
    false,
  );
});

test("老板、管理层、员工必须使用真实分层账号，不能都拿老板账号冒充", () => {
  assert.equal(roleMatchesMatrixLane("boss", "boss"), true);
  assert.equal(roleMatchesMatrixLane("manager", "ops_director"), true);
  assert.equal(roleMatchesMatrixLane("manager", "manager"), true);
  assert.equal(roleMatchesMatrixLane("employee", "sales"), true);
  assert.equal(roleMatchesMatrixLane("employee", "partner"), true);
  assert.equal(roleMatchesMatrixLane("manager", "boss"), false);
  assert.equal(roleMatchesMatrixLane("employee", "boss"), false);
  assert.equal(roleMatchesMatrixLane("employee", "ops_director"), false);
});

test("会诊转任务必须由业务流读取接口逐个证明下游任务已落库", () => {
  const flow = {
    hasDownstream: true,
    nodes: [
      { id: "advisor-message:7", kind: "advisor_message" },
      { id: "manual-task:101", kind: "manual_task" },
      { id: "manual-task:102", kind: "manual_task" },
    ],
  };
  assert.equal(advisorFlowReadbackValid(flow, [101, 102]), true);
  assert.equal(advisorFlowReadbackValid(flow, [101, 103]), false);
  assert.equal(
    advisorFlowReadbackValid({ ...flow, hasDownstream: false }, [101]),
    false,
  );
  assert.equal(
    advisorFlowReadbackValid(
      { ...flow, nodes: [{ id: "manual-task:101", type: "manual_task" }] },
      [101],
    ),
    false,
  );
  assert.equal(advisorFlowReadbackValid(flow, []), false);
});

test("四格式制品必须由读取接口证明同源、非空文件和可用终态", () => {
  const rows = ["docx", "pdf", "xlsx", "pptx"].map((format, index) => ({
    id: 201 + index,
    source_type: "real_feature_matrix",
    source_id: 99,
    format,
    file_url: `/uploads/artifacts/1/file.${format}`,
    status: "可用",
    metadata: JSON.stringify({ size: 1200 + index }),
  }));
  const options = {
    ids: [201, 202, 203, 204],
    formats: ["docx", "pdf", "xlsx", "pptx"],
    sourceType: "real_feature_matrix",
    sourceId: 99,
  };
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(artifactReadbackEvidence(rows, options)).filter(
        ([key]) => key !== "matched",
      ),
    ),
    {
      persisted: true,
      lineageValid: true,
      terminalValid: true,
      contractValid: true,
    },
  );
  assert.equal(
    artifactReadbackEvidence(
      rows.map((item, index) =>
        index === 1 ? { ...item, metadata: "{}" } : item,
      ),
      options,
    ).terminalValid,
    false,
  );
  assert.equal(
    artifactReadbackEvidence(
      rows.map((item, index) =>
        index === 2 ? { ...item, source_id: 100 } : item,
      ),
      options,
    ).lineageValid,
    false,
  );
  assert.equal(
    artifactReadbackEvidence(rows.slice(0, 3), options).persisted,
    false,
  );

  const skillRows = rows.map((item) => ({
    ...item,
    source_type: "marshal_skill",
    source_id: 7,
    file_url: item.file_url.replace("/uploads/artifacts/", "/uploads/skills/"),
  }));
  assert.equal(
    artifactReadbackEvidence(skillRows, {
      ...options,
      sourceType: "marshal_skill",
      sourceId: 7,
      fileUrlPrefix: "/uploads/skills/",
    }).terminalValid,
    true,
  );
  assert.equal(
    artifactReadbackEvidence(skillRows, {
      ...options,
      sourceType: "marshal_skill",
      sourceId: 7,
    }).terminalValid,
    false,
    "技能文件不能冒充文件中心artifacts路径",
  );
});

test("SSE员工对话必须同时包含reset、正文delta和done业务终态", () => {
  const raw = [
    `data: ${JSON.stringify({ reset: true })}`,
    `data: ${JSON.stringify({ delta: "完整员工对话正文" })}`,
    `data: ${JSON.stringify({ done: true, sessionId: 12, assistantMessageId: 13, reply: "完整员工对话正文" })}`,
    "",
  ].join("\n\n");
  const parsed = parseSseEvents(raw);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.reset, true);
  assert.equal(parsed.done, true);
  assert.equal(parsed.deltaText, "完整员工对话正文");
  assert.equal(parsed.doneEvent.sessionId, 12);
  assert.equal(
    parseSseEvents(`data: ${JSON.stringify({ delta: "只有正文" })}\n\n`).valid,
    false,
  );
  assert.equal(parseSseEvents("data: {broken}\n\n").errors.length, 1);
});

test("餐饮任务业务流必须回读任务、产物和已结算hold三类节点", () => {
  const flow = {
    nodes: [
      {
        id: "restaurant-task:88",
        kind: "restaurant_task",
        status: "待人工审阅",
      },
      { id: "billing:901", kind: "billing", status: "积分已结算（实扣 20）" },
      { id: "content:301", kind: "content", status: "待人工审阅" },
    ],
    links: [
      {
        from: "restaurant-task:88",
        to: "billing:901",
        relation: "billing",
      },
      {
        from: "restaurant-task:88",
        to: "content:301",
        relation: "produced",
      },
    ],
  };
  assert.deepEqual(restaurantTaskFlowReadback(flow, 88), {
    taskPersisted: true,
    outputPersisted: true,
    billingPersisted: true,
    billingSettled: true,
    billingLinked: true,
    outputLinked: true,
    holdId: 901,
    valid: true,
  });
  assert.equal(
    restaurantTaskFlowReadback({ nodes: flow.nodes.slice(0, 2) }, 88).valid,
    false,
  );
  assert.equal(
    restaurantTaskFlowReadback(
      {
        nodes: flow.nodes.map((item) =>
          item.kind === "billing"
            ? { ...item, status: "积分预授权处理中" }
            : item,
        ),
      },
      88,
    ).valid,
    false,
  );
  assert.equal(
    restaurantTaskFlowReadback({ ...flow, links: flow.links.slice(0, 1) }, 88)
      .valid,
    false,
  );
});

test("mock计费流水按水位、账号和功能精确归集并指出缺项", () => {
  const rows = [
    {
      id: 10,
      user_id: 3,
      feature: "日更包·短视频脚本",
      kind: "text",
      model: "gpt-5.5",
      input_tokens: 100,
      output_tokens: 50,
      cost_yuan: 0.1,
      credits: 15,
      ai_mode: "api",
    },
    {
      id: 11,
      user_id: 4,
      feature: "日更包·朋友圈文案",
      kind: "text",
      model: "gpt-5.5",
      input_tokens: 999,
      output_tokens: 999,
      cost_yuan: 9,
      credits: 900,
      ai_mode: "api",
    },
    {
      id: 12,
      user_id: 3,
      feature: "日更包·朋友圈文案",
      kind: "text",
      model: "gpt-5.5",
      input_tokens: 120,
      output_tokens: 60,
      cost_yuan: 0.12,
      credits: 18,
      ai_mode: "api",
    },
    {
      id: 13,
      user_id: 3,
      feature: "无关功能",
      kind: "text",
      model: "gpt-5.5",
      input_tokens: 500,
      output_tokens: 500,
      cost_yuan: 1,
      credits: 100,
      ai_mode: "api",
    },
  ];
  const evidence = billingEvidenceFromRows(rows, {
    afterId: 9,
    userId: 3,
    features: ["日更包·短视频脚本", "日更包·朋友圈文案", "日更包·社群话题"],
  });
  assert.equal(evidence.count, 2);
  assert.equal(evidence.inputTokens, 220);
  assert.equal(evidence.outputTokens, 110);
  assert.deepEqual(evidence.missingFeatures, ["日更包·社群话题"]);
  assert.deepEqual(
    evidence.rows.map((item) => item.id),
    [10, 12],
  );
});

test("后台内容与自动化不能把业务成功但计费仍held的瞬间状态误判为终态", () => {
  assert.equal(
    backgroundContentReady({ status: "处理中", snapshot_json: "{}" }),
    false,
  );
  assert.equal(
    backgroundContentReady({
      status: "成功",
      snapshot_json: JSON.stringify({ billing: { state: "held" } }),
    }),
    false,
  );
  assert.equal(
    backgroundContentReady({
      status: "成功",
      snapshot_json: JSON.stringify({ billing: { state: "settled" } }),
    }),
    true,
  );
  assert.equal(
    backgroundContentReady({ status: "失败", snapshot_json: "{}" }),
    true,
  );
  assert.equal(
    backgroundContentReady({ status: "成功", snapshot_json: "{broken" }),
    false,
  );

  assert.equal(
    automationRunReady({
      runs: [{ status: "运行中", billing: { state: "held" } }],
    }),
    false,
  );
  assert.equal(
    automationRunReady({
      runs: [{ status: "成功", billing: { state: "held" } }],
    }),
    false,
  );
  assert.equal(
    automationRunReady({
      runs: [{ status: "成功", billing: { state: "settled" } }],
    }),
    true,
  );
  assert.equal(
    automationRunReady({
      runs: [{ status: "失败", billing: { state: "released" } }],
    }),
    true,
  );
});

test("真实API判定严格拒绝模板、零token、未结算、未持久化、模板指纹和缺失流水", () => {
  const baseline = classifyFeatureAttempt(passingAttempt());
  assert.equal(baseline.l1Pass, true);
  assert.equal(baseline.l2Pass, true);
  assert.equal(baseline.pass, true);
  for (const mutation of [
    { aiMode: "template" },
    { models: ["fallback-model"] },
    { inputTokens: 0 },
    { outputTokens: 0 },
    { billingState: "released" },
    { billingHoldIds: [] },
    { billingEvidenceCount: 0 },
    { billingEvidence: [] },
    { billingEvidenceMissingFeatures: ["内容自动化·文案初稿"] },
    { expectedFeatures: [] },
    { persistent: false },
    { terminalValid: false, terminalStatus: "运行中" },
    { contractValid: false, contractErrors: ["schema invalid"] },
    { contractValid: true, contractErrors: ["仍有未解决的契约错误"] },
    { templateFingerprintDetected: true },
    { resultChars: 0, resultHash: null },
    { externalSideEffects: true },
    { l2Pass: false, semanticErrors: ["业务语义错误"] },
    { semanticEvidence: null },
  ]) {
    const result = classifyFeatureAttempt(passingAttempt(mutation));
    assert.equal(result.pass, false, JSON.stringify(mutation));
    assert.equal(result.verdict, "FAIL_REAL_API");
    assert.ok(result.failureReasons.length > 0);
  }
});

test("纯内部AI功能的Boss测试门禁止新增审批或停在待审阅", () => {
  const base = passingAttempt();
  assert.equal(classifyFeatureAttempt(base).pass, true);
  const approval = classifyFeatureAttempt({ ...base, approvalDelta: 1 });
  assert.equal(approval.pass, false);
  assert.match(approval.failureReasons.join("；"), /FAIL_NO_REVIEW_POLICY/u);
  const pending = classifyFeatureAttempt({ ...base, reviewPendingDelta: 1, terminalStatus: "待审阅" });
  assert.equal(pending.pass, false);
  assert.match(pending.failureReasons.join("；"), /FAIL_NO_REVIEW_POLICY/u);
});

test("31个真实AI交付入口统一经过完整证据门槛，HTTP 200、空结果或任一伪证据都不能PASS", () => {
  const mutations = [
    { httpStatus: 200, aiMode: null },
    { httpStatus: 200, resultChars: 0, resultHash: null },
    { models: ["template"] },
    { inputTokens: 0 },
    { outputTokens: 0 },
    { billingState: "held" },
    { persistent: false },
    { terminalValid: false, terminalStatus: "处理中" },
    { contractValid: false },
    { l2Pass: false, semanticErrors: ["幻觉事实"] },
    {
      billingEvidence: [
        {
          id: 88,
          feature: "测试功能·真实调用",
          model: "gpt-5.5",
          inputTokens: 0,
          outputTokens: 180,
          aiMode: "api",
        },
      ],
    },
    {
      billingEvidence: [
        {
          id: 88,
          feature: "测试功能·真实调用",
          model: "gpt-5.5",
          inputTokens: 300,
          outputTokens: 0,
          aiMode: "api",
        },
      ],
    },
    {
      billingEvidence: [
        {
          id: 88,
          feature: "测试功能·真实调用",
          model: "fallback",
          inputTokens: 300,
          outputTokens: 180,
          aiMode: "api",
        },
      ],
    },
    {
      billingEvidence: [
        {
          id: 88,
          feature: "别的并发功能",
          model: "gpt-5.5",
          inputTokens: 300,
          outputTokens: 180,
          aiMode: "api",
        },
      ],
    },
  ];
  const aiDeliveries = FEATURE_DEFINITIONS.filter(
    (item) => item.expectation === "real_ai_delivery",
  );
  assert.equal(aiDeliveries.length, 31);
  for (const feature of aiDeliveries) {
    const base = passingAttempt({
      featureKey: feature.key,
      expectation: feature.expectation,
    });
    assert.equal(classifyFeatureAttempt(base).pass, true, feature.key);
    for (const mutation of mutations) {
      assert.equal(
        classifyFeatureAttempt({ ...base, ...mutation }).pass,
        false,
        `${feature.key}错误通过：${JSON.stringify(mutation)}`,
      );
    }
  }
});

test("5条模块权限边界只允许精确403且零AI、零计费/hold、零产物通过", () => {
  const fixtures = [
    {
      featureKey: "advisor:manager:standard",
      endpoint: "/api/advisor/chat",
      endpointTemplate: "/api/advisor/chat",
      expectedFeature: "老板参谋诊断",
    },
    {
      featureKey: "advisor:employee:standard",
      endpoint: "/api/advisor/chat",
      endpointTemplate: "/api/advisor/chat",
      expectedFeature: "老板参谋诊断",
    },
    {
      featureKey: "marshal-chat:employee:forbidden",
      endpoint: "/api/marshals/7/chat",
      endpointTemplate: "/api/marshals/:id/chat",
      expectedFeature: "员工对话·战略分部",
    },
    {
      featureKey: "marshal-skill-file:employee:forbidden",
      endpoint: "/api/marshals/7/skill-file",
      endpointTemplate: "/api/marshals/:id/skill-file",
      expectedFeature: "生成Word·战略分部",
    },
    {
      featureKey: "marshal-task:employee:forbidden",
      endpoint: "/api/marshals/7/tasks",
      endpointTemplate: "/api/marshals/:id/tasks",
      expectedFeature: "员工任务·战略分部",
    },
  ];
  for (const fixture of fixtures) {
    const input = passingPermissionBoundaryAttempt({
      featureKey: fixture.featureKey,
      endpoint: fixture.endpoint,
      endpointTemplate: fixture.endpointTemplate,
      expectedFeatures: [fixture.expectedFeature],
      billingEvidenceExpectedAbsentFeatures: [fixture.expectedFeature],
    });
    const passed = classifyFeatureAttempt(input);
    assert.equal(
      passed.pass,
      true,
      `${fixture.featureKey}: ${passed.failureReasons.join("；")}`,
    );
    assert.equal(passed.verdict, "PASS_PERMISSION_BOUNDARY");
  }

  const mutations = [
    { requestReachedLocalService: false },
    { endpoint: "/api/advisor/unknown" },
    { endpointTemplate: "/api/advisor/unknown" },
    { modulePermissionAbsent: false },
    { httpStatus: 401 },
    { httpStatus: 404 },
    { httpStatus: 500 },
    { httpStatus: 403, boundaryError: "禁止访问" },
    { readbackHttpStatus: 200, readbackError: "" },
    { artifactProbeComplete: false },
    { terminalValid: false },
    { contractValid: false },
    { artifactReadbackFound: true },
    { businessArtifactCreated: true },
    { businessArtifactAbsenceProven: false },
    { businessArtifactProof: { strategy: "response_only" } },
    { businessIds: [901] },
    { persistent: true },
    { billingAuditComplete: false },
    { billingProbeBeforeId: null },
    { expectedFeatures: [] },
    {
      billingEvidenceCount: 1,
      billingEvidence: [{ id: 101, feature: "老板参谋诊断", aiMode: "hold" }],
    },
    { billingHoldIds: [88] },
    { billingState: "held" },
    { aiMode: "api" },
    { models: ["gpt-5.5"] },
    { inputTokens: 1 },
    { outputTokens: 1 },
    { costYuan: 0.01 },
    { chargedCredits: 1 },
    { resultChars: 10, resultHash: "a".repeat(64) },
    { executionError: "连接失败" },
    { l2Pass: false, semanticErrors: ["角色语义边界失败"] },
  ];
  for (const mutation of mutations) {
    const result = classifyFeatureAttempt(
      passingPermissionBoundaryAttempt(mutation),
    );
    assert.equal(result.pass, false, JSON.stringify(mutation));
    assert.equal(result.verdict, "FAIL_PERMISSION_BOUNDARY");
    assert.ok(result.failureReasons.length > 0);
  }
});

test("多调用功能要求每一笔流水都有真实模型和正向token，不能靠总和掩盖单项失败", () => {
  const multi = passingAttempt({
    expectedFeatures: ["子任务A", "子任务B", "子任务C"],
    expectedBillingCount: 3,
    billingEvidenceCount: 3,
    billingHoldIds: [701, 702, 703],
    billingEvidence: [
      {
        id: 1,
        feature: "子任务A",
        model: "gpt-5.5",
        inputTokens: 100,
        outputTokens: 80,
        aiMode: "api",
      },
      {
        id: 2,
        feature: "子任务B",
        model: "gpt-5.5",
        inputTokens: 120,
        outputTokens: 90,
        aiMode: "api",
      },
      {
        id: 3,
        feature: "子任务C",
        model: "gpt-5.5",
        inputTokens: 140,
        outputTokens: 100,
        aiMode: "api",
      },
    ],
    inputTokens: 360,
    outputTokens: 270,
  });
  assert.equal(classifyFeatureAttempt(multi).pass, true);
  multi.billingEvidence[1] = { ...multi.billingEvidence[1], outputTokens: 0 };
  assert.equal(classifyFeatureAttempt(multi).pass, false);
});

test("四格式文件制品只允许继承同轮真实云来源证据", () => {
  const inherited = passingAttempt({
    providerPolicy: "inherited",
    providerLineagePass: true,
    businessIds: [10, 20, 21, 22, 23, 24],
  });
  assert.equal(classifyFeatureAttempt(inherited).pass, true);
  assert.equal(
    classifyFeatureAttempt({ ...inherited, providerLineagePass: false }).pass,
    false,
  );
});

test("证据报告剔除密码、授权头、API Key、base64并脱敏sk值", () => {
  const safe = sanitizeEvidence({
    username: "guan",
    sessionId: 123,
    password: "never-store",
    authorization: "Bearer secret",
    apiKey: "sk-example123456789",
    nested: {
      b64: "abc",
      cookie: "sid=secret",
      rawResponse: "upstream body",
      note: "provider sk-another987654321 failed; Bearer abcdefghijklmnop; password=hunter2",
    },
  });
  assert.equal(safe.username, "guan");
  assert.equal(safe.sessionId, 123);
  assert.equal(Object.hasOwn(safe, "password"), false);
  assert.equal(Object.hasOwn(safe, "authorization"), false);
  assert.equal(Object.hasOwn(safe, "apiKey"), false);
  assert.equal(Object.hasOwn(safe.nested, "b64"), false);
  assert.equal(Object.hasOwn(safe.nested, "cookie"), false);
  assert.equal(Object.hasOwn(safe.nested, "rawResponse"), false);
  assert.equal(
    safe.nested.note,
    "provider [REDACTED] failed; [REDACTED]; [REDACTED]",
  );
});

test("证据脱敏区分重复引用与真循环，latest不再被误写成Circular字符串", () => {
  const shared = {
    verdict: "PASS_REAL_API",
    pass: true,
    resultHash: "a".repeat(64),
  };
  const duplicated = sanitizeEvidence({ attempts: [shared], latest: shared });
  assert.equal(typeof duplicated.latest, "object");
  assert.deepEqual(duplicated.latest, duplicated.attempts[0]);
  assert.notStrictEqual(duplicated.latest, duplicated.attempts[0]);

  const cyclic = { name: "cycle" };
  cyclic.self = cyclic;
  assert.equal(sanitizeEvidence(cyclic).self, "[CIRCULAR]");
});

test("v4-v7旧断点可迁移，但缺少新账本或L2证据的旧PASS必须失效重跑", () => {
  const legacyAttempt = {
    ...passingAttempt(),
    expectation: "real_ai_delivery",
    pass: true,
    verdict: "PASS_REAL_API",
    category: "toolbox",
  };
  delete legacyAttempt.l2Pass;
  delete legacyAttempt.semanticEvidence;
  delete legacyAttempt.semanticErrors;
  const migrated = normalizeFeatureState({
    schemaVersion: "nanowork.real-feature-matrix.v4",
    jobs: {
      "toolbox:hot": {
        attempts: [legacyAttempt],
        latest: "[CIRCULAR]",
      },
      "advisor:manager:standard": {
        attempts: [
          {
            featureKey: "advisor:manager:standard",
            pass: false,
            verdict: "FAIL_REAL_API",
            executionError: "POST /api/advisor/chat返回403",
          },
        ],
        latest: {
          featureKey: "advisor:manager:standard",
          pass: false,
          verdict: "FAIL_REAL_API",
          executionError: "POST /api/advisor/chat返回403",
        },
      },
    },
    inventory: {},
    evidencePolicy: {},
  });
  assert.equal(migrated.changed, true);
  assert.deepEqual(migrated.repairedLatestKeys, ["toolbox:hot"]);
  assert.equal(migrated.state.schemaVersion, REAL_FEATURE_MATRIX_SCHEMA);
  assert.equal(
    migrated.state.jobs["toolbox:hot"].latest.verdict,
    "FAIL_REAL_API",
  );
  assert.equal(migrated.state.jobs["toolbox:hot"].latest.l1Pass, true);
  assert.equal(migrated.state.jobs["toolbox:hot"].latest.l2Pass, false);
  assert.notStrictEqual(
    migrated.state.jobs["toolbox:hot"].latest,
    migrated.state.jobs["toolbox:hot"].attempts.at(-1),
  );
  assert.equal(migrated.state.summary.passed, 0);
  assert.equal(migrated.state.summary.failed, 2);
  assert.equal(
    migrated.state.jobs["advisor:manager:standard"].latest.expectation,
    "authorization_boundary",
  );
  assert.equal(
    migrated.state.jobs["advisor:manager:standard"].latest.verdict,
    "FAIL_PERMISSION_BOUNDARY",
  );
  assert.equal(migrated.state.summary.permissionBoundaries.failed, 1);
  assert.equal(migrated.state.inventory.runnable.length, 36);
  assert.deepEqual(migrated.state.evidencePolicy.permissionBoundaries.keys, [
    ...AUTHORIZATION_BOUNDARY_KEYS,
  ]);
  assert.equal(
    migrated.state.evidencePolicy.requestReplaySafety.mutationsDefault,
    "never_replay_ambiguous_result",
  );
  assert.throws(
    () =>
      normalizeFeatureState({
        schemaVersion: "nanowork.real-feature-matrix.v3",
      }),
    /版本不兼容/u,
  );

  const v7 = normalizeFeatureState({
    schemaVersion: "nanowork.real-feature-matrix.v7",
    jobs: {
      "toolbox:hot": {
        attempts: [
          {
            ...passingAttempt(),
            exactBillingLedgerPass: undefined,
            exactBillingLedgerErrors: undefined,
          },
        ],
        latest: {
          ...passingAttempt(),
          exactBillingLedgerPass: undefined,
          exactBillingLedgerErrors: undefined,
        },
      },
    },
  });
  assert.equal(v7.state.jobs["toolbox:hot"].latest.pass, false);
  assert.match(
    v7.state.jobs["toolbox:hot"].latest.failureReasons.join("\n"),
    /精确对账/u,
  );
});

test("断点报告保存完整尝试历史和token/费用汇总", () => {
  const state = createFeatureState({
    baseUrl: "http://127.0.0.1:3107",
    selectedJobs: ["toolbox:hot"],
    concurrency: 1,
  });
  assert.equal(state.schemaVersion, REAL_FEATURE_MATRIX_SCHEMA);
  const realAttempt = {
    ...passingAttempt(),
    expectation: "real_ai_delivery",
    pass: true,
    verdict: "PASS_REAL_API",
    category: "toolbox",
    costYuan: 1.25,
    chargedCredits: 188,
  };
  mergeFeatureAttempt(state, "toolbox:hot", realAttempt);
  const boundaryInput = passingPermissionBoundaryAttempt({
    featureKey: "advisor:manager:standard",
    category: "advisor",
  });
  const boundaryAttempt = {
    ...boundaryInput,
    ...classifyFeatureAttempt(boundaryInput),
  };
  mergeFeatureAttempt(state, "advisor:manager:standard", boundaryAttempt);
  assert.equal(state.jobs["toolbox:hot"].attempts.length, 1);
  assert.notStrictEqual(
    state.jobs["toolbox:hot"].attempts[0],
    state.jobs["toolbox:hot"].latest,
  );
  assert.equal(state.summary.passed, 2);
  assert.equal(state.summary.realApi.passed, 1);
  assert.equal(state.summary.permissionBoundaries.passed, 1);
  assert.equal(state.summary.tokens.input, 300);
  assert.equal(state.summary.costYuan, 1.25);
  assert.equal(state.summary.credits, 188);
});
