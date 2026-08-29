import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// This file is intentionally isolated from the repository database and all
// external providers.  It is the deterministic business gate for the one
// input used by employee 102's acceptance run.
const DB_PATH = path.join(
  os.tmpdir(),
  `nanowork-employee-102-acceptance-${process.pid}.db`,
);
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // The file may not exist on the first run.
  }
}
process.env.NANOWORK_DB = DB_PATH;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
process.env.ENABLE_SCHEDULER = "false";
process.env.SEED_DEMO = "false";

const { initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { buildEmployeeExecutionProfile } =
  await import("../src/employee-workbench.js");
const { marshalWork } = await import("../src/engines/ai.js");
const {
  buildRestaurantOutputDeliverableFixture,
  getRestaurantOutputContract,
  validateRestaurantEmployeeOutputContract,
} = await import("../src/engines/restaurant-output-contract.js");
const {
  buildRestaurantDispatch,
  classifyAttempt,
  classifyProviderEvidence,
  validateRestaurantDispatchEvidence,
} = await import("../../scripts/lib/real-employee-matrix.mjs");
const { evaluateUnifiedAcceptanceGate, isPublicInfoUserQuestion } =
  await import("../../scripts/lib/real-acceptance-gates.mjs");

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();
q.run(
  `INSERT INTO tenants(id,name,status,plan,credits)
   VALUES(1,'idx102隔离验收企业','已开通','标准版',1000000)
   ON CONFLICT(id) DO UPDATE SET status='已开通',credits=1000000`,
);

const TASK = Object.freeze({
  title: "毛血旺 太原吾悦广场",
  type: "商圈画像",
  requirement:
    "请围绕毛血旺 太原吾悦广场核验竞品与商圈画像，给出下一步可执行的业务结论。",
  dueAt: "2026-08-07T18:00:00",
});

const WEB_SOURCE = Object.freeze({
  title: "大众点评·毛血旺 太原吾悦广场商户正文",
  url: "https://www.dianping.com/shop/maoxuewang-wuyue-menu",
  snippet:
    "太原吾悦广场毛血旺餐厅菜单、菜品、价格、营业状态、评价与外卖公开商户正文。",
  body: "受控网页正文已读取并净化：太原吾悦广场毛血旺店公开菜单、菜品、价格带、营业状态、评价主题与外卖信息可按核验日逐项回看；本段仅用于隔离验收，未知字段保留复核动作，不构成外部执行授权。",
});
const MAP_SOURCE = Object.freeze({
  title: "OpenStreetMap定位·太原吾悦广场",
  url: "https://www.openstreetmap.org/way/7001",
  snippet: "地图显示吾悦广场、公交站和周边餐饮POI。",
});
const MATERIAL_SOURCE = "本次任务材料·门店A验收数据表";

function employee102Profile() {
  return runWithTenant(1, () =>
    buildEmployeeExecutionProfile(102, {
      tenantId: 1,
      user: { id: 1, role: "boss", tenant_id: 1 },
    }),
  );
}

function controlledEvidenceSource() {
  return `${WEB_SOURCE.title}｜${WEB_SOURCE.url}`;
}

function mapEvidenceSource() {
  return `${MAP_SOURCE.title}｜${MAP_SOURCE.url}`;
}

function buildBusinessOutput() {
  const output = buildRestaurantOutputDeliverableFixture(102, TASK);
  output.decision_context.problem =
    "围绕“毛血旺 太原吾悦广场”完成商圈画像：1.5公里办公午餐需求明显，直接竞品与间接替代分层清楚，下一步先做午晚餐实地验证。";
  output.decision_context.period =
    "2026-08-08公开核验日；内部经营基线2026-07-01至2026-07-31";
  output.decision_context.scope =
    "太原吾悦广场步行/骑行1.5公里商圈，毛血旺堂食+外卖午餐、晚餐与周末场景";
  output.decision_context.sources = [
    {
      source: controlledEvidenceSource(),
      period: "2026-08-08",
      fact: "公开页面给出菜单价格、营业状态和评价主题，可用于直接竞品核验。",
    },
    {
      source: mapEvidenceSource(),
      period: "2026-08-08",
      fact: "地图页面定位吾悦广场及周边公交站、餐饮POI，可用于商圈边界与竞品距离核验。",
    },
    {
      source: MATERIAL_SOURCE,
      period: "2026-07-01至2026-07-31",
      fact: "门店A内部记录营业额100000元、订单2000单、食材成本35000元和人工成本22000元。",
    },
  ];

  const bodies = {
    商圈边界与需求发生器清单: [
      "商圈边界：地图中心点覆盖步行/骑行1.5公里，办公楼、公交站、吾悦广场为需求发生器；午餐11:30-13:30和晚餐17:30-20:30是首要餐段。",
      "需求发生器：办公午餐、商场周末家庭客、公交换乘客三类需求可观察，需以客流计数与订单时段验证。",
    ],
    "竞品/替代品矩阵和地图数据表": [
      "直接竞品：同为毛血旺/川味火锅且价格带40-60元的门店在地图POI中与目标点形成可比集，需逐店核验距离和营业状态。",
      "间接竞品：麻辣烫、冒菜和商场快餐争夺同一午餐预算，便利性替代的价格带约20-35元。",
      "地图：OpenStreetMap定位显示吾悦广场、公交站和周边餐饮POI，直接竞品/间接替代分层按距离、餐段和价格比较。",
    ],
    餐段人流与竞争强度热表: [
      "餐段人流：办公午餐11:30-13:30、商场晚餐17:30-20:30和周末12:00-14:00作为三个计数窗口，需记录进店、排队和可见空位。",
      "竞争强度：午餐直接竞品排队与外卖骑手密度是高强度信号，晚餐要区分商场活动带来的脉冲客流与常态需求。",
    ],
    "评价主题、价格带和菜单宽度对标": [
      "评价主题：公开评价集中在口味、等待、环境和性价比，不能把少量极端评价外推为总体。",
      "价格带：公开菜单显示核心单品与套餐处于40-60元可比带，间接替代约20-35元，需标注核验日。",
      "菜单宽度对标：目标店菜单宽度与直接竞品按毛血旺、配菜、套餐和外卖SKU逐项对标，营业状态以公开页面为准。",
    ],
    "三个机会空白、三个风险及下一轮实地调研计划。": [
      "三个机会空白第1项：办公午餐套餐与快速出餐可能形成差异化机会，先用午餐排队时长和转化验证。",
      "三个机会空白第2项：商场周末家庭客的共享锅/小份组合可能形成价格与场景空白。",
      "三个机会空白第3项：公交换乘和外卖自提的便利性组合需要通过地图动线与订单时段证伪。",
      "三个风险第1项：价格带若高于40-60元可比集，午餐需求可能转向20-35元间接替代。",
      "三个风险第2项：公开营业状态或评价样本过期，会把短期活动客流误判为常态。",
      "三个风险第3项：单日实地计数与长期竞争强度属于不同观测口径，多日期样本用于复核。",
    ],
  };

  const contract = getRestaurantOutputContract(102);
  for (const key of contract.deliverableKeys) {
    const item = output.deliverables[key];
    const name = item.deliverable_name;
    const source = name.includes("地图")
      ? mapEvidenceSource()
      : controlledEvidenceSource();
    item.summary = `围绕任务“${TASK.title}”形成${name}实际结论：直接竞品、间接替代、需求发生器、餐段、菜单价格、营业状态和评价主题均按来源与核验日登记，下一步动作与证伪条件明确。`;
    item.evidence = [
      {
        source,
        period: "2026-08-08",
        finding: `${name}已结合公开来源和地图证据登记直接/间接竞品、需求发生器、餐段、菜单价格、营业状态和评价主题，未知项保留证伪条件。`,
      },
    ];
    const body = bodies[name] || [];
    const items = item.work_product.sections[0].items;
    for (let index = 0; index < items.length; index += 1) {
      items[index].result =
        body[index] ||
        `${name}正文第${index + 1}项：依据${source}和门店A材料记录可核验事实、影响和下一步动作，未知字段通过实地调研证伪。`;
      items[index].evidence_ref = source;
      items[index].status = "verified";
    }
    item.actions = [
      {
        action: `围绕“${name}”完成直接竞品、间接替代、餐段需求、菜单价格、营业状态和评价主题逐项核验，登记来源与证伪条件。`,
        owner: "竞品与商圈画像岗位负责人",
        deadline: "2026-08-07 18:00前",
        success_metric: `形成1份${name}正文，至少逐项覆盖来源、核验日、样本、差异和证伪条件，闭环记录不少于3项。`,
      },
      {
        action: `补齐“${name}”：在工作日和周末午晚餐采集客流、排队、菜单价格、营业状态与评价样本。`,
        owner: "商圈实地调研负责人",
        deadline: "2026-08-07 18:00前",
        success_metric: `完成${name}的4个餐段样本和3类竞品对标，缺口逐项登记并可复核。`,
      },
    ];
    item.acceptance_checks = [
      {
        criterion: `${name}的事实边界、来源与证伪条件已逐项登记`,
        result: "pass",
        evidence: `${name}正文已点名直接竞品、间接替代、餐段需求、菜单价格、营业状态、评价主题和下一轮调研动作。`,
      },
    ];
  }
  output.quality_review.overall_status = "pass";
  const qualityChecks = Object.values(output.quality_review.checks);
  qualityChecks[0].status = "pass";
  qualityChecks[0].evidence =
    "地址、营业状态和价格有来源及核验日，已在公开来源与地图正文逐项登记。";
  output.approval.review_note =
    "内部产出通过质量门与账务门后按任务快照策略处理；未经老板执行授权不得外发、真实付费或执行不可逆动作。";
  return output;
}

function fakeResearchResult() {
  const candidates = Array.from({ length: 5 }, (_unused, index) =>
    index === 0
      ? {
          title: "大众点评·毛血旺 太原吾悦广场商户正文",
          url: "https://www.dianping.com/shop/maoxuewang-wuyue-menu",
          snippet:
            "太原吾悦广场毛血旺餐厅菜单、菜品、价格、营业状态、评价与外卖公开商户正文。",
        }
      : {
          title: `太原吾悦广场毛血旺餐厅公开候选${index + 1}`,
          url: `https://research.test/source-${index + 1}`,
          snippet: `太原吾悦广场毛血旺餐厅菜单、价格、营业状态、评价与竞品公开候选${index + 1}`,
        },
  );
  return {
    attempted: true,
    ok: true,
    candidateReady: true,
    provider: "isolated-fake-websearch",
    results: candidates,
    fetchCandidates: candidates,
    evidence: {
      schemaVersion: "nanowork.agentic-web-research/1",
      executionMode: "isolated_fake_cli",
      toolCalls: 5,
      toolAttempts: 5,
      toolResults: candidates.map((_item, index) => ({
        toolUseId: `fake-web-search-${index + 1}`,
        success: true,
        isError: false,
        permissionDenied: false,
        urlCount: 1,
      })),
      qualityGate: {
        requiredSearches: 5,
        requiredSources: 5,
        observedSearches: 5,
        observedSuccessfulToolResults: 5,
        observedToolResultUrls: 5,
        observedSources: 5,
        passed: true,
      },
      queries: [
        "太原吾悦广场 毛血旺 官方位置",
        "太原吾悦广场 交通 周边需求",
        "太原吾悦广场 直接竞品 菜单价格",
        "太原吾悦广场 间接替代 评价主题",
        "太原吾悦广场 营业状态 新闻",
      ],
      facts: [
        {
          claim: "公开检索工具返回五类商圈与竞品候选",
          sourceUrls: [candidates[0].url],
        },
      ],
      usage: { inputTokens: 110, outputTokens: 220 },
      externalCall: true,
      localLoginInherited: false,
    },
  };
}

function fakeMapEvidence() {
  return {
    attempted: true,
    ok: true,
    provider: "isolated-fake-osm",
    results: [MAP_SOURCE],
    evidence: {
      schemaVersion: "nanowork.location-intelligence/1",
      query: "太原吾悦广场",
      externalCall: true,
      center: { displayName: "太原市小店区吾悦广场", lat: 37.81, lon: 112.55 },
      namedPoiCount: 3,
    },
  };
}

function fakeControlledFetch(sources) {
  return {
    attempted: true,
    ok: true,
    provider: "isolated-fake-controlled-web",
    results: [
      WEB_SOURCE,
      ...(sources || []).slice(0, 2).map((source) => ({
        ...source,
        title: source.title || "受控正文候选",
        snippet: source.snippet || "受控网页正文摘要",
        body: "受控网页正文已读取并净化：太原吾悦广场毛血旺目标餐饮门店的菜单、菜品、价格、营业状态、评价与竞品信息仅作为可回看的公开证据，不构成外部执行授权；未知字段保留复核动作。",
      })),
    ],
    evidence: {
      schemaVersion: "nanowork.controlled-web-evidence/1",
      requested: Math.max(1, Number(sources?.length || 0)),
      fetched: 3,
      failures: [],
      externalCall: true,
      ssrfProtected: true,
      redirectsRevalidated: true,
      rawResponseStored: false,
      extractedTextStored: true,
    },
  };
}

function simpleApprovalGate(role) {
  return evaluateUnifiedAcceptanceGate({
    demand: TASK.requirement,
    publicInfoEvidence: {
      required: true,
      attempted: true,
      ok: true,
      citedUrlCount: 2,
      userQuestioned: false,
    },
    providerEvidence: {
      invocationValid: true,
      mode: "api",
      model: "idx102-isolated-provider",
      inputTokens: 120,
      outputTokens: 240,
      attempts: 1,
    },
    dataAnalysisEvidence: {
      inputFactsMapped: true,
      semanticValid: true,
      analysisProduced: true,
    },
    skillInvocationEvidence: {
      profileLoaded: true,
      canonicalVerified: true,
      outputContractBound: true,
      capabilityCount: 7,
      skillCount: 7,
    },
    businessResultEvidence: {
      primaryArtifactCount: 1,
      outputChars: 1800,
      notAbilityList: true,
      resultHashValid: true,
      artifactHashValid: true,
    },
    approvalsBefore: role === "boss" ? 4 : 9,
    approvalsAfter: role === "boss" ? 4 : 9,
    inputRecorded: true,
    outputRecorded: true,
    executionRecorded: true,
    feeEvidenceRecorded: true,
  });
}

test("idx102单一输入生成的派活材料完整可追溯，且不向老板索取公开事实", () => {
  const profile = {
    identity: {
      idx: 102,
      key: "02-trade-area-competitor-profile",
      name: "竞品与商圈画像",
      duty: "竞品与商圈画像",
    },
    dispatch: {
      defaultTaskType: "执行方案",
      requiredInputs: [
        "候选地址或坐标、交通方式和顾客可接受通行时间",
        "业态、菜系、价格带、主要餐段与渠道",
        "需要比较的候选点或已知竞品",
        "可用的地图、客流、评价、菜单、交易或实地观察数据。",
      ],
      guidance: {
        taskExamples: ["核验商圈竞品与需求发生器"],
        deliverableChecklist: ["竞品矩阵", "商圈画像"],
      },
    },
  };
  const dispatch = buildRestaurantDispatch(profile, "idx102-one-input", {
    demand: TASK.requirement,
  });
  const checked = validateRestaurantDispatchEvidence(dispatch, profile);
  assert.equal(checked.valid, true, checked.errors.join("；"));
  assert.equal(dispatch.acceptanceDemand, TASK.requirement);
  assert.equal(dispatch.acceptanceDemandValid, true);
  assert.match(
    dispatch.requirement,
    /公开信息：真实联网\/API核验；不反问老板/u,
  );
  assert.match(dispatch.requirement, /记录批次=E-102-/u);
  assert.doesNotMatch(
    dispatch.requirement,
    /请(?:老板|用户|您)?(?:提供|补充|确认|上传).*(?:地址|坐标|竞品|菜单|价格|评价|交通)/u,
  );
});

test("idx102完整岗位语义与紧凑输出契约进入模型system，完整档案留在快照", () => {
  const execution = employee102Profile();
  const system = execution.systemContext;
  const workbench = execution.workbench;
  assert.equal(
    execution.snapshot.runtimePackageLoad.allRequiredFieldsLoaded,
    true,
  );
  assert.equal(
    execution.snapshot.runtimePackageLoad
      .fullCanonicalObjectPersistedInSnapshot,
    true,
  );
  assert.ok(system.includes(workbench.workMethod.manualMarkdown));
  assert.ok(
    workbench.workMethod.requiredInputs.every((value) =>
      system.includes(value),
    ),
  );
  assert.ok(
    workbench.workMethod.steps.every((value) => system.includes(value)),
  );
  assert.ok(
    workbench.workMethod.qualityGates.every((value) => system.includes(value)),
  );
  assert.ok(
    workbench.workMethod.safetyBoundaries.every((value) =>
      system.includes(value),
    ),
  );
  assert.ok(
    workbench.capabilities.every(
      (item) => system.includes(item.name) && system.includes(item.description),
    ),
  );
  assert.ok(
    workbench.skillLibrary.enabled.every(
      (item) => system.includes(item.title) && system.includes(item.detail),
    ),
  );
  assert.ok(system.includes(workbench.prompts.defaultTemplate));
  assert.ok(system.includes(workbench.jobProfile.outputContract.instruction));
  assert.ok(system.includes(JSON.stringify(workbench.workConfig)));
  assert.equal(
    execution.snapshot.runtimePackageLoad.jobProfileDelivery,
    "compact_manifest_plus_response_schema",
  );
  assert.ok(
    execution.snapshot.runtimePackageLoad.jobProfileManifestCharCount <
      execution.snapshot.runtimePackageLoad.fullJobProfileCharCount / 10,
  );
  assert.ok(system.length < 40_000);
  assert.ok(
    JSON.stringify(execution.responseSchema.schema).includes(
      '"decision_context"',
    ),
  );
  assert.deepEqual(
    execution.snapshot.canonicalProfile.jobProfile,
    workbench.jobProfile,
  );
  assert.deepEqual(execution.snapshot.runtimePackageLoad.requiredFields, [
    "identity",
    "provenance",
    "jobProfile",
    "capabilities",
    "skills",
    "workMethod",
    "prompts",
    "runtimeBindings",
    "workConfig",
    "contracts",
    "permissions",
  ]);
  assert.ok(
    execution.snapshot.runtimePackageLoad.requiredFields.every((field) =>
      Object.hasOwn(execution.snapshot.canonicalProfile, field),
    ),
  );
});

test("idx102真实研究链至少5次搜索并把地图与受控网页正文写入生成prompt/web快照", async () => {
  const execution = employee102Profile();
  const calls = [];
  const agentic = fakeResearchResult();
  const result = await runWithTenant(1, () =>
    marshalWork(
      {
        code: "M-01",
        name: "战略与开店筹备部",
        duty: "仅负责调度",
        prompt: "",
      },
      TASK,
      "boss",
      {
        employeeExecution: execution,
        requireAgenticResearch: true,
        agenticWebResearchFn: async () => agentic,
        webSearchFn: async () => ({
          attempted: true,
          ok: true,
          provider: "isolated-fake-redundancy",
          results: [
            {
              title: "公开冗余来源",
              url: "https://search.test/redundancy",
              snippet: "冗余公开来源",
            },
          ],
        }),
        controlledWebFetchFn: async (sources) => fakeControlledFetch(sources),
        locationIntelligenceFn: async () => fakeMapEvidence(),
        generateFn: async (args) => {
          calls.push(args);
          return {
            text: JSON.stringify(buildBusinessOutput()),
            mode: "api",
            model: "idx102-isolated-provider",
            usage: { inputTokens: 120, outputTokens: 240 },
          };
        },
      },
    ),
  );
  assert.equal(result.mode, "api");
  assert.equal(result.employeeContract.valid, true);
  assert.equal(
    result.web.channels.find(
      (channel) => channel.kind === "agentic_web_research",
    ).evidence.toolCalls,
    5,
  );
  assert.equal(
    result.web.channels.find(
      (channel) => channel.kind === "agentic_web_research",
    ).evidence.qualityGate.passed,
    true,
  );
  assert.equal(
    result.web.channels.find(
      (channel) => channel.kind === "location_intelligence",
    ).evidence.namedPoiCount,
    3,
  );
  const controlled = result.web.channels.find(
    (channel) => channel.kind === "controlled_web_fetch",
  );
  assert.ok(controlled);
  assert.ok(
    controlled.results.some((source) =>
      source.body?.includes("受控网页正文已读取并净化"),
    ),
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].userMsg, /【受控网页正文】/u);
  assert.match(calls[0].system, /老板极简派活规则·最高优先级/u);
  assert.match(
    calls[0].system,
    /网上可查信息，必须使用本次地图、WebSearch和受控网页正文自行补齐/u,
  );
  assert.match(calls[0].system, /不得向老板索取/u);
  assert.match(
    calls[0].userMsg,
    /所有公开可查输入由你调用本次已提供的真实工具证据自行完成/u,
  );
  assert.match(calls[0].userMsg, /不得反问老板补公开资料/u);
  assert.match(calls[0].userMsg, /不得复述岗位能力清单/u);
  assert.match(calls[0].userMsg, /不得输出通道不可用底稿/u);
  assert.match(
    calls[0].userMsg,
    /受控网页正文已读取并净化：太原吾悦广场毛血旺店/u,
  );
  assert.match(calls[0].userMsg, /OpenStreetMap定位·太原吾悦广场/u);
  assert.match(calls[0].userMsg, /www\.openstreetmap\.org\/way\/7001/u);
  assert.equal(isPublicInfoUserQuestion(result.text), false);
  assert.doesNotMatch(
    result.text,
    /能力清单|岗位底稿|AI通道不可用|请提供地址|请补充坐标/u,
  );
  assert.match(JSON.stringify(result.web), /受控网页正文已读取并净化/u);
  assert.match(
    JSON.stringify(result.web),
    /www\.openstreetmap\.org\/way\/7001/u,
  );
});

test("idx102业务主结果必须含商圈结论、直接/间接竞品、需求餐段、菜单价格状态评价、动作和证伪条件", () => {
  const output = buildBusinessOutput();
  const checked = validateRestaurantEmployeeOutputContract(102, output, {
    task: TASK,
    allowedSources: [WEB_SOURCE, MAP_SOURCE],
    requireWebSources: true,
  });
  assert.equal(checked.valid, true, checked.errors.join("；"));
  const body = JSON.stringify(output);
  for (const phrase of [
    "1.5公里",
    "直接竞品",
    "间接竞品",
    "需求发生器",
    "午餐",
    "晚餐",
    "菜单",
    "价格带",
    "营业状态",
    "评价主题",
    "下一步",
    "证伪",
  ]) {
    assert.match(body, new RegExp(phrase, "u"), phrase);
  }
  assert.equal(isPublicInfoUserQuestion(body), false);
});

test("idx102契约门拒绝work_product逐项复用通用营业额正文", () => {
  const weak = buildBusinessOutput();
  const genericResult =
    "营业额100000元、订单2000单、食材成本35000元、人工成本22000元。";
  for (const deliverable of Object.values(weak.deliverables)) {
    for (const section of deliverable.work_product?.sections || []) {
      for (const item of section.items || []) {
        item.result = genericResult;
      }
    }
  }
  const checked = validateRestaurantEmployeeOutputContract(102, weak, {
    task: TASK,
    allowedSources: [WEB_SOURCE, MAP_SOURCE],
    requireWebSources: true,
  });
  assert.equal(
    checked.valid,
    false,
    "逐项复用营业额正文不应被当作毛血旺太原吾悦广场的竞品与商圈业务结论",
  );
});

test("idx102联网结构化候选拒绝公开资料反问、通道底稿和能力清单退化", () => {
  const mutations = [
    [
      "公开资料反问",
      "请老板补充门店地址、坐标、交通方式和竞品菜单价格评价后再输出。",
    ],
    [
      "通道不可用底稿",
      "AI通道不可用，仅生成岗位执行底稿，待老板补充公开资料后再核验。",
    ],
    [
      "能力清单冒充结果",
      "已形成全部必备能力执行清单，详见附件，尚未给出商圈与竞品结论。",
    ],
  ];
  for (const [label, summary] of mutations) {
    const output = buildBusinessOutput();
    const firstDeliverableKey = Object.keys(output.deliverables)[0];
    output.deliverables[firstDeliverableKey].summary = summary;
    const checked = validateRestaurantEmployeeOutputContract(102, output, {
      task: TASK,
      allowedSources: [WEB_SOURCE, MAP_SOURCE],
      requireWebSources: true,
    });
    assert.equal(
      checked.valid,
      false,
      `${label}: ${checked.errors.join("；")}`,
    );
    assert.match(
      checked.errors.join("；"),
      /公开资料检索责任退回给老板/u,
      `${label} must be rejected by the public-research deflection gate`,
    );
  }
});

test("Boss与platform_super统一验收门审批增量均为0", () => {
  for (const role of ["boss", "platform_super"]) {
    const gate = simpleApprovalGate(role);
    assert.equal(gate.pass, true, `${role}: ${JSON.stringify(gate)}`);
    assert.equal(
      gate.checks.find((item) => item.id === "boss_zero_approvals").pass,
      true,
    );
    assert.equal(gate.policy.requiredApprovalDelta, 0);
  }
});

test("失败尝试必须收敛为失败/退款证据而不是挂起（runner纯函数门）", () => {
  const businessId = 10201;
  const failed = {
    domain: "restaurant",
    idx: 102,
    businessId,
    invocationId: "idx102-timeout-run",
    providerAttempts: [
      {
        number: 1,
        phase: "acquire",
        mode: "api",
        model: "idx102-isolated-provider",
        apiObtained: true,
        usage: { inputTokens: 120, outputTokens: 240 },
      },
    ],
    providerMode: "api",
    providerModel: "idx102-isolated-provider",
    providerInputTokens: 120,
    providerOutputTokens: 240,
    providerEvidence: "real_cloud_api_invoked",
    providerEvidenceValid: true,
    contractValid: false,
    contractErrors: ["输出缺少竞品矩阵正文"],
    generationStatus: "失败",
    businessFlowStatus: "quality_failed",
    businessFlowTerminal: true,
    businessFlowComplete: true,
    businessFlowBillingSettled: true,
    outputId: null,
    resultChars: 0,
    reviewId: null,
    reviewDecision: null,
    assetId: null,
    knowledgeId: null,
    terminalStatus: "失败",
    outputStatus: "失败",
    billingState: "settled",
    billingInputTokens: 0,
    billingOutputTokens: 0,
    billingAiMode: "api",
    billingModel: "idx102-isolated-provider",
    chargedCredits: 0,
    costYuan: 0,
    settledCredits: 0,
    creditLogId: 456,
    billingId: 455,
    billingHoldLogId: 456,
    billingLinkValid: true,
    billingFreshForAttempt: true,
    tenantId: 1,
    userId: 1,
    billingTenantId: 1,
    creditLogTenantId: 1,
    billingUserId: 1,
    creditLogUserId: 1,
    billingHoldCount: 1,
    billingCreditLogCount: 1,
    billingRefType: "agent_task",
    billingRefId: businessId,
    billingFeature: "数字员工任务",
    creditLogFeature: "数字员工任务",
    billingKind: "text",
    creditLogKind: "text",
    billingHoldModel: "idx102-isolated-provider",
    creditLogModel: "idx102-isolated-provider",
    creditLogCredits: 0,
    balanceBefore: 1000000,
    balanceAfter: 1000000,
    tenantBalance: 1000000,
    billingExpectedCurrentBalance: 1000000,
    billingExpectedSettlementBalance: 1000000,
    billingBaselineHoldId: 400,
    billingBaselineLogId: 400,
    billingBalanceWindowHoldCount: 1,
    billingBalanceWindowConcurrentHoldCount: 0,
    billingBalanceWindowInvalidCount: 0,
    billingBalanceWindowAmbiguousTimestampCount: 0,
    billingBalanceWindowTargetCount: 1,
    externalPublish: false,
  };
  const evidence = classifyProviderEvidence(failed);
  assert.equal(evidence.qualityGateRefunded, true, JSON.stringify(evidence));
  assert.equal(evidence.businessDeliveryBillingEvidence, "quality_gate_refund");
  const classified = classifyAttempt(failed);
  assert.equal(classified.verdict, "FAIL_REAL_API");
  assert.equal(classified.pass, false);
  assert.ok(
    classified.failureReasons.some((reason) => /全额退回预授权/u.test(reason)),
  );
  assert.equal(failed.businessFlowTerminal, true);
  assert.equal(failed.businessFlowComplete, true);
  assert.equal(failed.chargedCredits, 0);
  assert.equal(failed.outputId, null);
});

after(() => {
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Best-effort cleanup of the isolated test database.
    }
  }
});
