import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  CONTENT_HANDLER_ADAPTER_CATALOG,
  createContentHandlerAdapterRegistry,
} from "../src/engines/content-handler-adapters.js";
import {
  CONTENT_PRODUCTION_PIPELINE_SCHEMA,
  createContentProductionPipeline,
  createSqliteContentProductionPipelineRepository,
  executeStationDeliveryDirect,
} from "../src/engines/content-production-pipeline.js";
import { createContentProductionHandlerRegistry } from "../src/engines/content-production-handler-registry.js";
import { createContentPaidMediaAuthorization } from "../src/engines/content-paid-media-authorization.js";
import { VALID_CONTENT_EMPLOYEE_OUTPUTS } from "./helpers/content-output-fixtures.mjs";

const OUTPUTS = Object.freeze([
  Object.freeze({
    briefing: "2026-08-01趋势简报",
    channel_scan: [{ channel: "小红书", signal: "老板向AI执行闭环" }],
    topics: [
      {
        id: "topic-a",
        title: "聊天框不是数字员工",
        angle: "业务闭环",
        hook: "为什么任务总是卡住",
      },
      {
        id: "topic-b",
        title: "数字员工必须有真实上游",
        angle: "数据证据",
        hook: "别再合成上游",
      },
    ],
  }),
  Object.freeze({
    summary: "已交叉核验三份资料",
    facts: ["事实A"],
    data_points: [{ name: "样本量", value: 30 }],
    viewpoints: ["观点A"],
    source_coverage: "官方、行业、案例",
    sources: [{ title: "官方资料", url: "https://example.com/source" }],
  }),
  Object.freeze({
    benchmarks: [{ title: "对标内容A" }],
    comment_insights: ["老板关心任务是否真执行"],
    user_language: ["不要忽悠人"],
    takeaways: ["展示handler证据"],
  }),
  Object.freeze({
    title_candidates: ["真实数字员工的三道门槛"],
    body: "这是基于真实上游产物撰写的初稿。",
    tags: ["数字员工"],
    image_plan: [{ slot: "首图", desc: "0→9流水线" }],
  }),
  Object.freeze({
    body: "这是保留事实后的文风定稿。",
    title_candidates: ["真实流水线，不是聊天框"],
    consistency_note: "未改变事实",
  }),
  Object.freeze({
    images: [
      { id: "image-a", url: "/artifacts/image-a.png" },
      { id: "image-b", url: "/artifacts/image-b.png" },
    ],
  }),
  Object.freeze({
    covers: [
      { id: "cover-a", url: "/artifacts/cover-a.png" },
      { id: "cover-b", url: "/artifacts/cover-b.png" },
    ],
  }),
  Object.freeze({ summary: "演绎页已生成", html: "<main>真实流水线</main>" }),
  Object.freeze({
    versions: [{ platform: "小红书", title: "真实流水线", body: "定稿正文" }],
    publish_plan: [{ platform: "小红书", action: "人工发布" }],
  }),
  Object.freeze({
    report: "本次从趋势到复盘全部留痕",
    next_topics: ["如何检查真实API证据"],
    profile_updates: [{ field: "corpus", suggestion: "多用业务证据" }],
  }),
]);
const ARTIFACT_KINDS = Object.freeze([
  "json",
  "json",
  "json",
  "markdown",
  "markdown",
  "images",
  "covers",
  "html",
  "publish_packages",
  "markdown",
]);

function stationArtifact(employeeIdx, output = OUTPUTS[employeeIdx]) {
  const descriptor = CONTENT_HANDLER_ADAPTER_CATALOG[employeeIdx];
  const kind = ARTIFACT_KINDS[employeeIdx];
  const extension =
    kind === "markdown" ? "md" : kind === "html" ? "html" : "json";
  const content =
    kind === "html" ? output.html : JSON.stringify(output, null, 2);
  return {
    kind,
    primary: true,
    filename: `station-${employeeIdx}.${extension}`,
    mediaType:
      kind === "markdown"
        ? "text/markdown"
        : kind === "html"
          ? "text/html"
          : "application/json",
    content,
    employeeIdx,
    employeeKey: descriptor.employeeKey,
    sourceKeys: [...descriptor.outputKeys],
  };
}

function testFingerprint(value) {
  const stable = (input) => {
    if (Array.isArray(input)) return input.map(stable);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .map((key) => [key, stable(input[key])]),
    );
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stable(value)), "utf8")
    .digest("hex")}`;
}

function clock() {
  let tick = 0;
  return () => {
    const date = new Date(Date.UTC(2026, 7, 1, 0, 0, tick));
    tick += 1;
    return date;
  };
}

function runtimeContextBuilder(calls) {
  return async (input) => {
    calls.push(structuredClone(input));
    const keys = Object.keys(input.outputs).sort(
      (a, b) => Number(a) - Number(b),
    );
    return {
      context: {
        executionMode: "pipeline",
        today: "2026-08-01",
        brief: input.task,
        task: input.task,
        profile: {
          persona: input.persona,
          account: { id: input.actorId, role: "boss" },
        },
        companyProfile: { name: "测试企业" },
        knowledge: { text: "", refs: [] },
        outputs: structuredClone(input.outputs),
        settings: input.settings,
        workflow: {
          ...input.workflow,
          executionMode: "pipeline",
          upstreamSynthesized: false,
        },
        tenantId: input.tenantId,
        actorId: input.actorId,
        jobId: input.jobId,
      },
      snapshot: {
        executionMode: "pipeline",
        upstream: {
          synthesized: false,
          stationKeys: keys,
          stationCount: keys.length,
          rawOutputsIncluded: false,
        },
      },
    };
  };
}

function pipelineFixture({
  failOnceAt = null,
  workflowMode = "copilot",
  enableDeck = true,
  executeStationDelivery = undefined,
  approvalPolicy = undefined,
  publicationMetrics = {
    schemaVersion: "nanowork.content-publication-metrics/1",
    publication: {
      platform: "小红书",
      url: "https://www.xiaohongshu.com/explore/test-note",
      publishedAt: "2026-08-01T00:00:00.000Z",
    },
    metrics: { views: 1200, likes: 86 },
    submittedBy: { id: 71, role: "boss", name: "老板" },
    submittedAt: "2026-08-01T00:00:01.000Z",
  },
  paidMediaAuthorized = true,
  platforms = ["小红书"],
  imageModel = "gpt-image-2",
  imageUnitCredits = 75,
} = {}) {
  const db = new DatabaseSync(":memory:");
  const now = clock();
  const repository = createSqliteContentProductionPipelineRepository({
    db,
    now,
  });
  repository.ensureSchema();
  const invocations = [];
  const contextCalls = [];
  let failed = false;
  let currentImageModel = imageModel;
  let currentImageUnitCredits = imageUnitCredits;
  const handlerRegistry = createContentHandlerAdapterRegistry({
    compile(input) {
      return {
        system: `system:${input.employeeIdx}`,
        user: `user:${input.employeeIdx}:${JSON.stringify(input.variables)}`,
      };
    },
    async invoke(input) {
      invocations.push({
        stationIdx: input.employeeIdx,
        outputs: structuredClone(input.context.outputs),
        runtimePackageLoad: structuredClone(input.context.runtimePackageLoad),
        system: input.prompt.system,
      });
      if (input.employeeIdx === failOnceAt && !failed) {
        failed = true;
        const error = new Error("云端provider暂时失败");
        error.code = "PROVIDER_TEMPORARY_FAILURE";
        throw error;
      }
      return {
        data: structuredClone(OUTPUTS[input.employeeIdx]),
        artifacts: [stationArtifact(input.employeeIdx)],
        tokens: input.employeeIdx + 10,
      };
    },
    now,
  });
  const pipeline = createContentProductionPipeline({
    repository,
    handlerRegistry,
    resolveImageModel: () => currentImageModel,
    estimateMaxCredits: () => currentImageUnitCredits,
    buildRuntimeContext: runtimeContextBuilder(contextCalls),
    ...(executeStationDelivery ? { executeStationDelivery } : {}),
    now,
  });
  const task = {
    direction: "数字员工如何完成真实业务闭环",
    template: "餐饮老板口播模板",
    industry: "餐饮连锁",
    material: "只能使用任务上下文与已核验资料",
    ref_link: "https://example.com/reference",
    platforms,
    image_mode: "mix",
    image_count: 2,
    enable_deck: enableDeck,
    xhs_style: { name: "老板实战", desc: "先讲问题，再讲证据和动作" },
    dy_style: { name: "口语直给", desc: "前3秒问题钩子，后续给步骤" },
  };
  const created = pipeline.create({
    tenantId: 7,
    createdBy: 71,
    title: "真实内容生产任务",
    task,
    persona: { corpus: "先讲事实，再给动作", visual: "暖白底黑字" },
    settings: {
      trend: { channels: ["小红书热门"] },
      companyProfile: {
        brand: "三石餐饮",
        business: "餐饮连锁数字化",
        sellingPoints: ["基于真实任务证据"],
      },
    },
    workflow: {
      mode: workflowMode,
      ...(approvalPolicy ? { approvalPolicy } : {}),
      ...(publicationMetrics ? { publicationMetrics } : {}),
      ...(paidMediaAuthorized
        ? {
            paidMediaAuthorization: createContentPaidMediaAuthorization({
              task,
              actor: boss,
              imageModel: currentImageModel,
              estimatedUnitCredits: currentImageUnitCredits,
              now,
            }),
          }
        : {}),
    },
  });
  return {
    db,
    repository,
    handlerRegistry,
    pipeline,
    created,
    invocations,
    contextCalls,
    now,
    setPaidMediaRuntime({
      model = currentImageModel,
      unitCredits = currentImageUnitCredits,
    } = {}) {
      currentImageModel = model;
      currentImageUnitCredits = unitCredits;
    },
  };
}

function privateSnapshotPipelineFixture() {
  const db = new DatabaseSync(":memory:");
  const now = clock();
  const repository = createSqliteContentProductionPipelineRepository({
    db,
    now,
  });
  repository.ensureSchema();
  let webCalls = 0;
  let modelCalls = 0;
  let failContract = true;
  const handlerRegistry = createContentProductionHandlerRegistry({
    role: "boss",
    model: "yunwu-real-text-model",
    validateOutputFn(employeeIdx, rawOutput) {
      const parsed = JSON.parse(rawOutput);
      const keys = CONTENT_HANDLER_ADAPTER_CATALOG[employeeIdx].outputKeys;
      const valid =
        keys.every((key) => Object.hasOwn(parsed, key)) &&
        Object.keys(parsed).every((key) => keys.includes(key));
      return {
        valid,
        parsed,
        errors: valid ? [] : ["outputKeys不完整"],
        artifacts: valid ? [stationArtifact(employeeIdx, parsed)] : [],
      };
    },
    webSearchFn: async () => {
      throw new Error("普通snippet搜索不得绕过Agentic→受控WebFetch主链");
    },
    agenticWebResearchFn: async () => {
      const start = webCalls + 1;
      webCalls += 6;
      const fetchCandidates = Array.from({ length: 6 }, (_, index) => ({
        title: `真实联网证据${start + index}`,
        url: `https://evidence.example/pipeline/${start + index}`,
        snippet: "公开候选只用于后续受控WebFetch，不直接进入最终内容模型。",
      }));
      return {
        attempted: true,
        ok: true,
        candidateReady: true,
        provider: "offline-agentic-search-test-provider",
        results: fetchCandidates.slice(0, 3),
        fetchCandidates,
        evidence: {
          toolCalls: 6,
          toolAttempts: 6,
          qualityGate: {
            requiredSearches: 5,
            observedSearches: 6,
            observedSuccessfulToolResults: 6,
            observedSources: 6,
            passed: true,
          },
        },
      };
    },
    controlledWebFetchFn: async (sources) => ({
      attempted: true,
      ok: true,
      provider: "offline-controlled-webfetch-test-provider",
      results: sources.map((source) => ({
        ...source,
        body: `这是服务器私有联网快照正文，不得进入流水线inspect或list响应。${"受控正文只用于本次模型执行并以哈希留证。".repeat(4)}`,
      })),
      evidence: {
        requested: sources.length,
        fetched: sources.length,
        failures: [],
      },
    }),
    generateFn: async () => {
      modelCalls += 1;
      return {
        text: JSON.stringify(
          failContract
            ? {
                ...structuredClone(VALID_CONTENT_EMPLOYEE_OUTPUTS[0]),
                unexpected: true,
              }
            : VALID_CONTENT_EMPLOYEE_OUTPUTS[0],
        ),
        mode: "api",
        model: "yunwu-real-text-model",
        usage: { inputTokens: 120, outputTokens: 60 },
      };
    },
  });
  const pipeline = createContentProductionPipeline({
    repository,
    handlerRegistry,
    resolveImageModel: () => "gpt-image-2",
    estimateMaxCredits: () => 75,
    buildRuntimeContext: runtimeContextBuilder([]),
    now,
  });
  const created = pipeline.create({
    tenantId: 7,
    createdBy: 71,
    title: "联网快照重试测试",
    task: {
      direction: "太原餐饮趋势证据核验",
      template: "老板经营内容",
      industry: "餐饮连锁",
      material: "只可使用真实联网证据",
      platforms: ["小红书"],
      image_mode: "mix",
      image_count: 2,
      enable_deck: false,
    },
    workflow: { mode: "copilot" },
  });
  return {
    db,
    repository,
    pipeline,
    pipelineId: created.id,
    setContractValid() {
      failContract = false;
    },
    counts() {
      return { webCalls, modelCalls };
    },
  };
}

const boss = Object.freeze({ id: 71, name: "老板", role: "boss" });

test("internal_auto让已认证发起人的内部报告0到9连续执行且不授予外发或业务采纳", async (t) => {
  const fixture = pipelineFixture({
    workflowMode: "fullauto",
    approvalPolicy: {
      mode: "internal_auto",
      configuredBy: { id: 72, role: "manager" },
    },
  });
  t.after(() => fixture.db.close());

  const state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });

  assert.equal(state.status, "completed");
  assert.equal(state.workflow.approvalPolicy.mode, "internal_auto");
  assert.deepEqual(state.workflow.approvalPolicy.reviewStations, []);
  assert.equal(state.workflow.approvalPolicy.externalPublishAllowed, false);
  assert.equal(
    state.workflow.approvalPolicy.automaticBusinessAdoptionAllowed,
    false,
  );
  assert.deepEqual(
    fixture.invocations.map((item) => item.stationIdx),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.equal(
    state.stations.some((station) => station.status === "awaiting_approval"),
    false,
  );
});

test("internal_auto没有发布指标时仍连续执行复盘官，完成后不降级成awaiting_metrics", async (t) => {
  const fixture = pipelineFixture({
    workflowMode: "fullauto",
    approvalPolicy: {
      mode: "internal_auto",
      configuredBy: { id: 72, role: "manager" },
    },
    publicationMetrics: null,
  });
  t.after(() => fixture.db.close());

  const state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });

  assert.equal(state.status, "completed");
  assert.equal(state.stations[9].status, "completed");
  assert.equal(state.stations[9].attempt, 1);
  assert.equal(state.workflow.publicationMetrics, undefined);
  assert.deepEqual(
    fixture.invocations.map((item) => item.stationIdx),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
});

test("internal_auto卡在await_metrics时resume会释放等待并执行复盘官", async (t) => {
  const fixture = pipelineFixture({
    workflowMode: "copilot",
    approvalPolicy: {
      mode: "custom",
      reviewStations: [8],
      configuredBy: { id: 71, role: "boss" },
    },
    publicationMetrics: null,
  });
  t.after(() => fixture.db.close());

  let state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  state = await fixture.pipeline.review({
    tenantId: 7,
    pipelineId: fixture.created.id,
    actor: boss,
    action: "approve",
  });
  assert.equal(state.status, "awaiting_metrics");
  assert.equal(
    fixture.invocations.some((item) => item.stationIdx === 9),
    false,
  );

  const workflow = structuredClone(state.workflow);
  workflow.mode = "fullauto";
  workflow.approvalPolicy = {
    mode: "internal_auto",
    reviewStations: [],
    configuredBy: { id: 72, role: "manager" },
    externalPublishAllowed: false,
    automaticBusinessAdoptionAllowed: false,
  };
  fixture.db
    .prepare(
      `UPDATE content_production_pipeline_jobs
      SET workflow_json=? WHERE tenant_id=7 AND id=?`,
    )
    .run(JSON.stringify(workflow), fixture.created.id);

  state = fixture.pipeline.inspect({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "awaiting_approval");
  assert.equal(state.stations[9].approvalBoundary.code, "await_metrics");

  state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "completed");
  assert.equal(state.stations[9].status, "completed");
  assert.equal(
    fixture.invocations.filter((item) => item.stationIdx === 9).length,
    1,
  );
});

test("fullauto在force终审通过后即使没有发布指标也执行预测性复盘", async (t) => {
  const fixture = pipelineFixture({
    workflowMode: "fullauto",
    publicationMetrics: null,
  });
  t.after(() => fixture.db.close());
  let state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "awaiting_approval");
  assert.equal(state.pendingStation, 8);
  assert.equal(
    fixture.invocations.some((item) => item.stationIdx === 9),
    false,
  );

  state = await fixture.pipeline.review({
    tenantId: 7,
    pipelineId: fixture.created.id,
    actor: boss,
    action: "approve",
  });
  assert.equal(state.status, "completed");
  assert.equal(state.stations[9].status, "completed");
  assert.equal(
    fixture.invocations.filter((item) => item.stationIdx === 9).length,
    1,
  );
});

test("半自动只审发布包时停在工位8，审过后即使没有指标也执行预测性复盘", async (t) => {
  const fixture = pipelineFixture({
    workflowMode: "autopilot",
    approvalPolicy: {
      mode: "custom",
      reviewStations: [8],
      configuredBy: { id: 71, role: "boss" },
    },
    publicationMetrics: null,
  });
  t.after(() => fixture.db.close());
  let state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "awaiting_approval");
  assert.equal(state.pendingStation, 8);
  assert.equal(
    fixture.invocations.some((item) => item.stationIdx === 9),
    false,
  );

  state = await fixture.pipeline.review({
    tenantId: 7,
    pipelineId: fixture.created.id,
    actor: boss,
    action: "approve",
  });
  assert.equal(state.status, "completed");
  assert.equal(state.stations[9].status, "completed");
  assert.equal(
    fixture.invocations.filter((item) => item.stationIdx === 9).length,
    1,
  );
});

test("工位5缺少付费媒体授权时在任何工位5 provider/计费边界前停住，授权后从pending恢复", async (t) => {
  const deliveryBoundaryCalls = [];
  const fixture = pipelineFixture({
    workflowMode: "copilot",
    approvalPolicy: {
      mode: "custom",
      reviewStations: [],
      configuredBy: { id: 71, role: "boss" },
    },
    paidMediaAuthorized: false,
    executeStationDelivery: async (input) => {
      deliveryBoundaryCalls.push(input.stationIdx);
      return executeStationDeliveryDirect(input);
    },
  });
  t.after(() => fixture.db.close());

  let state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "awaiting_media_authorization");
  assert.equal(state.currentStation, 5);
  assert.deepEqual(
    fixture.invocations.map((item) => item.stationIdx),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(deliveryBoundaryCalls, [0, 1, 2, 3, 4]);
  assert.equal(state.stations[5].status, "awaiting_media_authorization");
  assert.equal(state.stations[5].billingEvidence, null);

  const policy = createContentPaidMediaAuthorization({
    task: state.task,
    actor: boss,
    imageModel: "gpt-image-2",
    estimatedUnitCredits: 75,
    now: fixture.now,
  });
  state = fixture.pipeline.authorizePaidMedia({
    tenantId: 7,
    pipelineId: fixture.created.id,
    actor: boss,
    policy,
  });
  assert.equal(state.status, "running");
  assert.equal(state.stations[5].status, "pending");
  assert.equal(
    state.workflow.paidMediaAuthorization.authorizationId,
    policy.authorizationId,
  );

  state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.notEqual(state.status, "awaiting_media_authorization");
  assert.equal(
    fixture.invocations.filter((item) => item.stationIdx === 5).length,
    1,
  );
  assert.equal(
    deliveryBoundaryCalls.filter((stationIdx) => stationIdx === 5).length,
    1,
  );
});

test("工位5在hold/provider前重验实际模型与计价，换模型、涨价或降价都零调用阻断", async (t) => {
  const scenarios = [
    { name: "换模型", runtime: { model: "gpt-image-3", unitCredits: 75 } },
    { name: "涨价", runtime: { model: "gpt-image-2", unitCredits: 76 } },
    { name: "降价", runtime: { model: "gpt-image-2", unitCredits: 74 } },
  ];
  for (const scenario of scenarios) {
    const deliveryBoundaryCalls = [];
    const fixture = pipelineFixture({
      workflowMode: "copilot",
      approvalPolicy: {
        mode: "custom",
        reviewStations: [4],
        configuredBy: { id: 71, role: "boss" },
      },
      executeStationDelivery: async (input) => {
        deliveryBoundaryCalls.push(input.stationIdx);
        return executeStationDeliveryDirect(input);
      },
    });
    t.after(() => fixture.db.close());
    let state = await fixture.pipeline.resume({
      tenantId: 7,
      pipelineId: fixture.created.id,
    });
    assert.equal(state.status, "awaiting_approval", scenario.name);
    assert.equal(state.pendingStation, 4, scenario.name);
    fixture.setPaidMediaRuntime(scenario.runtime);
    state = await fixture.pipeline.review({
      tenantId: 7,
      pipelineId: fixture.created.id,
      actor: boss,
      action: "approve",
      resumeAfterApproval: false,
    });
    assert.equal(state.status, "running", scenario.name);
    state = await fixture.pipeline.resume({
      tenantId: 7,
      pipelineId: fixture.created.id,
    });
    assert.equal(state.status, "awaiting_media_authorization", scenario.name);
    assert.equal(
      state.failure.code,
      "CONTENT_PAID_MEDIA_REAUTHORIZATION_REQUIRED",
      scenario.name,
    );
    assert.deepEqual(
      fixture.invocations.map((item) => item.stationIdx),
      [0, 1, 2, 3, 4],
      scenario.name,
    );
    assert.deepEqual(deliveryBoundaryCalls, [0, 1, 2, 3, 4], scenario.name);
    assert.equal(state.stations[5].billingEvidence, null, scenario.name);
  }
});

test("工位5拒绝过期或篡改的付费媒体授权且不调用provider", async (t) => {
  const fixture = pipelineFixture({ paidMediaAuthorized: false });
  t.after(() => fixture.db.close());
  const valid = createContentPaidMediaAuthorization({
    task: fixture.created.task,
    actor: boss,
    imageModel: "gpt-image-2",
    estimatedUnitCredits: 75,
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  });
  assert.throws(
    () =>
      fixture.pipeline.authorizePaidMedia({
        tenantId: 7,
        pipelineId: fixture.created.id,
        actor: boss,
        policy: { ...valid, estimatedMaximumCredits: 1 },
      }),
    (error) =>
      error.code === "CONTENT_PAID_MEDIA_AUTHORIZATION_TAMPERED" ||
      /积分上限/u.test(error.message),
  );
  assert.equal(
    fixture.pipeline.inspect({ tenantId: 7, pipelineId: fixture.created.id })
      .workflow.paidMediaAuthorization,
    undefined,
  );
});

test("工位9缺少真实发布指标时停为awaiting_metrics，普通审批不能绕过，提交指标后才调用复盘模型", async (t) => {
  const fixture = pipelineFixture({
    workflowMode: "copilot",
    approvalPolicy: {
      mode: "custom",
      reviewStations: [8],
      configuredBy: { id: 71, role: "boss" },
    },
    publicationMetrics: null,
  });
  t.after(() => fixture.db.close());

  let state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "awaiting_approval");
  assert.equal(state.pendingStation, 8);
  state = await fixture.pipeline.review({
    tenantId: 7,
    pipelineId: fixture.created.id,
    actor: boss,
    action: "approve",
  });
  assert.equal(state.status, "awaiting_metrics");
  assert.equal(state.pendingStation, 9);
  assert.equal(state.stations[9].status, "awaiting_metrics");
  assert.equal(state.stations[9].approvalBoundary.code, "await_metrics");
  assert.equal(state.stations[9].attempt, 0);
  assert.equal(
    fixture.invocations.some((item) => item.stationIdx === 9),
    false,
  );

  await assert.rejects(
    fixture.pipeline.review({
      tenantId: 7,
      pipelineId: fixture.created.id,
      actor: boss,
      action: "approve",
    }),
    (error) => error.code === "CONTENT_PIPELINE_METRICS_REQUIRED",
  );

  state = fixture.pipeline.submitMetrics({
    tenantId: 7,
    pipelineId: fixture.created.id,
    actor: boss,
    publication: {
      platform: "小红书",
      url: "https://www.xiaohongshu.com/explore/real-note",
      publishedAt: "2026-08-01T00:00:00.000Z",
    },
    metrics: { views: 2345, comments: 17 },
  });
  assert.equal(state.status, "running");
  assert.equal(state.currentStation, 9);
  assert.equal(
    state.workflow.publicationMetrics.entries[0].metrics.views,
    2345,
  );
  assert.equal(state.workflow.publicationMetrics.complete, true);

  state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "completed");
  assert.equal(state.stations[9].status, "completed");
  assert.equal(state.stations[9].attempt, 1);
  assert.equal(
    fixture.invocations.filter((item) => item.stationIdx === 9).length,
    1,
  );
  assert.equal(
    fixture.contextCalls.at(-1).workflow.publicationMetrics.entries[0].metrics
      .comments,
    17,
  );
});

test("多平台发布指标逐平台累计，缺任一目标平台不调用复盘，全部齐备才恢复工位9", async (t) => {
  const fixture = pipelineFixture({
    workflowMode: "copilot",
    approvalPolicy: {
      mode: "custom",
      reviewStations: [],
      configuredBy: { id: 71, role: "boss" },
    },
    publicationMetrics: null,
    platforms: ["小红书", "视频号"],
  });
  t.after(() => fixture.db.close());

  let state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "awaiting_metrics");
  assert.equal(
    fixture.invocations.some((item) => item.stationIdx === 9),
    false,
  );

  state = fixture.pipeline.submitMetrics({
    tenantId: 7,
    pipelineId: fixture.created.id,
    actor: boss,
    publication: {
      platform: "小红书",
      url: "https://www.xiaohongshu.com/explore/first-platform",
      publishedAt: "2026-08-01T00:00:00.000Z",
    },
    metrics: { views: 345, likes: 0 },
  });
  assert.equal(state.status, "awaiting_metrics");
  assert.deepEqual(state.workflow.publicationMetrics.submittedPlatforms, [
    "小红书",
  ]);
  assert.deepEqual(state.workflow.publicationMetrics.missingPlatforms, [
    "视频号",
  ]);
  assert.equal(state.workflow.publicationMetrics.complete, false);
  assert.equal(
    state.workflow.publicationMetrics.entries[0].verification.status,
    "manual_unverified",
  );
  assert.equal(
    fixture.invocations.some((item) => item.stationIdx === 9),
    false,
  );

  state = fixture.pipeline.submitMetrics({
    tenantId: 7,
    pipelineId: fixture.created.id,
    actor: boss,
    publication: {
      platform: "视频号",
      url: "https://channels.weixin.qq.com/web/pages/feed",
      publishedAt: "2026-08-01T00:00:01.000Z",
    },
    metrics: { views: 120 },
  });
  assert.equal(state.status, "running");
  assert.deepEqual(state.workflow.publicationMetrics.submittedPlatforms, [
    "小红书",
    "视频号",
  ]);
  assert.deepEqual(state.workflow.publicationMetrics.missingPlatforms, []);
  assert.equal(state.workflow.publicationMetrics.complete, true);

  state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "completed");
  assert.equal(
    fixture.invocations.filter((item) => item.stationIdx === 9).length,
    1,
  );
});

test("发布指标拒绝错平台域名、未来时间和全零指标，拒绝后仍等待且不调用复盘", async (t) => {
  const fixture = pipelineFixture({
    workflowMode: "copilot",
    approvalPolicy: {
      mode: "custom",
      reviewStations: [],
      configuredBy: { id: 71, role: "boss" },
    },
    publicationMetrics: null,
  });
  t.after(() => fixture.db.close());
  let state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "awaiting_metrics");

  for (const invalid of [
    {
      publication: {
        platform: "小红书",
        url: "https://example.com/fake-xiaohongshu",
        publishedAt: "2026-08-01T00:00:00.000Z",
      },
      metrics: { views: 10 },
      message: /域名/u,
    },
    {
      publication: {
        platform: "小红书",
        url: "https://xhslink.com/valid",
        publishedAt: "2026-08-02T00:00:00.000Z",
      },
      metrics: { views: 10 },
      message: /未来|5分钟/u,
    },
    {
      publication: {
        platform: "小红书",
        url: "https://xhslink.com/valid",
        publishedAt: "2026-08-01T00:00:00.000Z",
      },
      metrics: { views: 0, likes: 0 },
      message: /大于0/u,
    },
  ]) {
    assert.throws(
      () =>
        fixture.pipeline.submitMetrics({
          tenantId: 7,
          pipelineId: fixture.created.id,
          actor: boss,
          publication: invalid.publication,
          metrics: invalid.metrics,
        }),
      invalid.message,
    );
  }
  state = fixture.pipeline.inspect({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "awaiting_metrics");
  assert.equal(state.workflow.publicationMetrics, undefined);
  assert.equal(
    fixture.invocations.some((item) => item.stationIdx === 9),
    false,
  );
});

test("历史上缺指标却completed的工位9对外降级为awaiting_metrics，补数据后保留旧attempt产物并重做复盘", async (t) => {
  const fixture = pipelineFixture({
    workflowMode: "copilot",
    approvalPolicy: {
      mode: "custom",
      reviewStations: [],
      configuredBy: { id: 71, role: "boss" },
    },
  });
  t.after(() => fixture.db.close());
  let state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "completed");
  assert.equal(state.stations[9].attempt, 1);

  const legacyWorkflow = structuredClone(state.workflow);
  delete legacyWorkflow.publicationMetrics;
  fixture.db
    .prepare(
      `UPDATE content_production_pipeline_jobs
    SET workflow_json=? WHERE tenant_id=? AND id=?`,
    )
    .run(JSON.stringify(legacyWorkflow), 7, fixture.created.id);

  state = fixture.pipeline.inspect({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "awaiting_metrics");
  assert.equal(state.stations[9].status, "awaiting_metrics");
  assert.equal(state.stations[9].artifacts.length, 1);

  state = fixture.pipeline.submitMetrics({
    tenantId: 7,
    pipelineId: fixture.created.id,
    actor: boss,
    publication: {
      platform: "小红书",
      url: "https://www.xiaohongshu.com/explore/backfilled-note",
      publishedAt: "2026-08-01T00:00:00.000Z",
    },
    metrics: { views: 999 },
  });
  assert.equal(state.status, "running");
  assert.equal(state.stations[9].attempt, 1);
  assert.equal(state.stations[9].approvalAudit.at(-1).previousAttempt, 1);
  assert.match(
    state.stations[9].approvalAudit.at(-1).previousOutputFingerprint,
    /^sha256:[a-f0-9]{64}$/u,
  );

  state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "completed");
  assert.equal(state.stations[9].attempt, 2);
  assert.equal(
    fixture.invocations.filter((item) => item.stationIdx === 9).length,
    2,
  );
  const artifactAttempts = fixture.db
    .prepare(
      `SELECT station_attempt
    FROM content_production_pipeline_artifacts
    WHERE tenant_id=? AND pipeline_id=? AND station_idx=9 ORDER BY station_attempt`,
    )
    .all(7, fixture.created.id);
  assert.deepEqual(
    artifactAttempts.map((row) => Number(row.station_attempt)),
    [1, 2],
  );
});

test("0→9流水线按pick/review/force/auto停站，且下游只读数据库已完成产物", async (t) => {
  const fixture = pipelineFixture();
  t.after(() => fixture.db.close());
  const { pipeline, created, invocations } = fixture;
  assert.equal(created.schemaVersion, CONTENT_PRODUCTION_PIPELINE_SCHEMA);
  assert.equal(created.mode, "pipeline");
  assert.equal(created.stations.length, 10);
  assert.equal(created.workflow.mode, "copilot");
  assert.equal(created.workflow.executionMode, "pipeline");

  let state = await pipeline.resume({ tenantId: 7, pipelineId: created.id });
  assert.equal(state.status, "awaiting_approval");
  assert.equal(state.pendingStation, 0);
  assert.deepEqual(state.stations[0].output.topics, OUTPUTS[0].topics);
  assert.equal(state.stations[0].handlerEvidence.executionMode, "pipeline");
  assert.equal(
    state.stations[0].handlerEvidence.runtimePackageLoad.loadedFields.length,
    11,
  );
  assert.equal(
    state.stations[0].handlerEvidence.runtimePackageLoad
      .allRequiredFieldsLoaded,
    true,
  );
  assert.equal(
    state.stations[0].handlerEvidence.runtimePackageLoad
      .fullCanonicalObjectInSystemMessage,
    true,
  );
  assert.match(invocations[0].system, /岗位运行包装载凭证/u);
  assert.equal(invocations[0].runtimePackageLoad.loadedFields.length, 11);
  assert.deepEqual(fixture.contextCalls[0].task, created.task);
  assert.deepEqual(Object.keys(fixture.contextCalls[0].task), [
    "direction",
    "template",
    "industry",
    "material",
    "ref_link",
    "platforms",
    "image_mode",
    "image_count",
    "enable_deck",
    "xhs_style",
    "dy_style",
  ]);
  assert.equal(fixture.contextCalls[0].workflow.mode, "copilot");
  assert.equal(fixture.contextCalls[0].companyProfile.brand, "三石餐饮");
  assert.equal(Object.hasOwn(fixture.contextCalls[0].task, "brand"), false);

  await assert.rejects(
    pipeline.review({ tenantId: 7, pipelineId: created.id, actor: boss }),
    /action必须是approve或reject/u,
  );
  assert.equal(
    pipeline.inspect({ tenantId: 7, pipelineId: created.id }).pendingStation,
    0,
  );

  state = await pipeline.review({
    tenantId: 7,
    pipelineId: created.id,
    actor: boss,
    action: "approve",
    selection: { candidateIndex: 1 },
  });
  assert.equal(state.pendingStation, 3);
  assert.equal(state.stations[0].output.selected, 1);
  assert.equal(
    invocations.find((item) => item.stationIdx === 1).outputs["0"].selected,
    1,
  );
  assert.deepEqual(
    Object.keys(invocations.find((item) => item.stationIdx === 2).outputs),
    ["0", "1"],
  );
  assert.equal(
    state.stations[1].approvalAudit[0].reasonCode,
    "CONTENT_HANDLER_AUTO_HANDOFF_ALLOWED",
  );
  assert.equal(
    state.stations[2].approvalAudit[0].reasonCode,
    "CONTENT_HANDLER_AUTO_HANDOFF_ALLOWED",
  );

  state = await pipeline.review({
    tenantId: 7,
    pipelineId: created.id,
    actor: boss,
    action: "approve",
  });
  assert.equal(state.pendingStation, 5);
  state = await pipeline.review({
    tenantId: 7,
    pipelineId: created.id,
    actor: boss,
    action: "approve",
    selection: { candidateId: "image-b" },
  });
  assert.equal(state.pendingStation, 6);
  assert.equal(state.stations[5].selection.candidateId, "image-b");
  state = await pipeline.review({
    tenantId: 7,
    pipelineId: created.id,
    actor: boss,
    action: "approve",
    selection: { candidateIndex: 0 },
  });
  assert.equal(state.pendingStation, 8);

  await assert.rejects(
    pipeline.review({
      tenantId: 7,
      pipelineId: created.id,
      actor: { id: 72, name: "内容经理", role: "manager" },
      action: "approve",
    }),
    (error) =>
      error.code === "CONTENT_HANDLER_FORCE_FINAL_REVIEW_ROLE_REQUIRED",
  );
  assert.equal(
    pipeline.inspect({ tenantId: 7, pipelineId: created.id }).pendingStation,
    8,
  );

  state = await pipeline.review({
    tenantId: 7,
    pipelineId: created.id,
    actor: boss,
    action: "approve",
  });
  assert.equal(state.status, "completed");
  assert.equal(state.currentStation, 10);
  assert.equal(state.pendingStation, null);
  assert.deepEqual(
    invocations.map((item) => item.stationIdx),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  for (const [idx, station] of state.stations.entries()) {
    assert.equal(station.status, "completed", `station ${idx}`);
    assert.equal(station.handlerEvidence.employeeIdx, idx);
    assert.equal(station.contextSnapshot.executionMode, "pipeline");
    assert.equal(station.contextSnapshot.upstream.stationCount, idx);
    assert.equal(station.artifacts.length, 1);
    assert.equal(station.artifacts[0].kind, ARTIFACT_KINDS[idx]);
    assert.equal(Object.hasOwn(station.artifacts[0], "content"), false);
  }
  assert.equal(state.stations[8].artifacts[0].kind, "publish_packages");
  assert.equal(state.stations[9].artifacts[0].kind, "markdown");
});

test("失败停在具体工位，保留handler失败证据并可从原工位重试", async (t) => {
  const fixture = pipelineFixture({ failOnceAt: 2 });
  t.after(() => fixture.db.close());
  const { pipeline, created, invocations } = fixture;

  let state = await pipeline.resume({ tenantId: 7, pipelineId: created.id });
  assert.equal(state.pendingStation, 0);
  state = await pipeline.review({
    tenantId: 7,
    pipelineId: created.id,
    actor: boss,
    action: "approve",
    selection: { candidateIndex: 0 },
  });
  assert.equal(state.status, "failed");
  assert.equal(state.currentStation, 2);
  assert.equal(state.stations[2].status, "failed");
  assert.equal(state.stations[2].failure.code, "PROVIDER_TEMPORARY_FAILURE");
  assert.equal(state.stations[2].handlerEvidence.completed, false);
  assert.equal(
    state.stations[2].handlerEvidence.failure.phase,
    "invoke_runtime",
  );

  state = await pipeline.retry({ tenantId: 7, pipelineId: created.id });
  assert.equal(state.status, "awaiting_approval");
  assert.equal(state.pendingStation, 3);
  assert.equal(state.stations[2].status, "completed");
  assert.equal(state.stations[2].attempt, 2);
  assert.equal(invocations.filter((item) => item.stationIdx === 2).length, 2);
  assert.deepEqual(Object.keys(invocations.at(-1).outputs), ["0", "1", "2"]);
});

test("上游工位状态即使标记完成，没有持久化产物也会fail closed，禁止任务内容合成上游", async (t) => {
  const fixture = pipelineFixture();
  t.after(() => fixture.db.close());
  const { db, pipeline, created, invocations, contextCalls } = fixture;
  db.prepare(
    `UPDATE content_production_pipeline_stations
    SET status='completed',output_json=? WHERE pipeline_id=? AND station_idx=0`,
  ).run(JSON.stringify(OUTPUTS[0]), created.id);
  db.prepare(
    `UPDATE content_production_pipeline_stations
    SET status='completed',output_json=NULL WHERE pipeline_id=? AND station_idx=1`,
  ).run(created.id);
  db.prepare(
    `UPDATE content_production_pipeline_jobs
    SET status='running',current_station=2,pending_station=NULL WHERE id=?`,
  ).run(created.id);

  const state = await pipeline.resume({ tenantId: 7, pipelineId: created.id });
  assert.equal(state.status, "failed");
  assert.equal(state.currentStation, 2);
  assert.equal(
    state.stations[2].failure.code,
    "CONTENT_PIPELINE_PERSISTED_UPSTREAM_MISSING",
  );
  assert.equal(invocations.length, 0);
  assert.equal(contextCalls.length, 0);
  assert.match(state.stations[2].failure.message, /已持久化|真实上游/u);
});

test("进程中断的running工位必须显式恢复，不会默认重复调用API", async (t) => {
  const fixture = pipelineFixture();
  t.after(() => fixture.db.close());
  const { db, pipeline, created, invocations } = fixture;
  db.prepare(
    `UPDATE content_production_pipeline_stations
    SET status='running',attempt=1,started_at='2026-08-01T00:00:00.000Z'
    WHERE pipeline_id=? AND station_idx=0`,
  ).run(created.id);

  await assert.rejects(
    pipeline.resume({ tenantId: 7, pipelineId: created.id }),
    (error) => error.code === "CONTENT_PIPELINE_STATION_BUSY",
  );
  assert.equal(invocations.length, 0);

  assert.throws(
    () => pipeline.recoverInterrupted({ tenantId: 7, pipelineId: created.id }),
    (error) => error.code === "CONTENT_PIPELINE_STATION_STILL_ACTIVE",
  );
  db.prepare(
    `UPDATE content_production_pipeline_stations
    SET started_at='2026-07-31T22:00:00.000Z',updated_at='2026-07-31T22:00:00.000Z'
    WHERE pipeline_id=? AND station_idx=0`,
  ).run(created.id);

  let state = pipeline.recoverInterrupted({
    tenantId: 7,
    pipelineId: created.id,
  });
  assert.equal(state.stations[0].status, "pending");
  state = await pipeline.resume({ tenantId: 7, pipelineId: created.id });
  assert.equal(state.status, "awaiting_approval");
  assert.equal(state.pendingStation, 0);
  assert.equal(state.stations[0].attempt, 2);
  assert.equal(invocations.length, 1);
});

test("恢复后的新attempt会拒绝旧worker写产物或失败终态，流水线状态不被破坏", (t) => {
  const fixture = pipelineFixture();
  t.after(() => fixture.db.close());
  const { db, repository, created } = fixture;
  const first = repository.claimStation(7, created.id, 0);
  assert.equal(first.attempt, 1);
  db.prepare(
    `UPDATE content_production_pipeline_stations
    SET started_at='2026-07-31T22:00:00.000Z',updated_at='2026-07-31T22:00:00.000Z'
    WHERE pipeline_id=? AND station_idx=0`,
  ).run(created.id);
  repository.recoverInterruptedStation(7, created.id);
  const second = repository.claimStation(7, created.id, 0);
  assert.equal(second.attempt, 2);

  assert.throws(
    () =>
      repository.recordGenerated({
        tenantId: 7,
        pipelineId: created.id,
        stationIdx: 0,
        expectedAttempt: first.attempt,
        output: OUTPUTS[0],
        handlerEvidence: { completed: true },
        contextSnapshot: {},
        approvalBoundary: { code: "pick" },
        awaitingApproval: true,
      }),
    (error) =>
      [
        "CONTENT_PIPELINE_STATION_NOT_RUNNING",
        "CONTENT_PIPELINE_STALE_ATTEMPT",
      ].includes(error.code),
  );
  const staleFailure = repository.recordFailure({
    tenantId: 7,
    pipelineId: created.id,
    stationIdx: 0,
    expectedAttempt: first.attempt,
    failure: { code: "OLD_WORKER_FAILED" },
  });
  assert.equal(staleFailure, null);
  assert.equal(repository.getJob(7, created.id).status, "running");
  assert.equal(repository.getStation(7, created.id, 0).status, "running");
  assert.equal(repository.getStation(7, created.id, 0).attempt, 2);
  assert.equal(repository.listArtifacts(7, created.id, 0).length, 0);
});

test("工位状态、output和artifact在同一事务提交，失败回滚且按tenant与attempt隔离", (t) => {
  const fixture = pipelineFixture();
  t.after(() => fixture.db.close());
  const { db, repository, created } = fixture;
  const claimed = repository.claimStation(7, created.id, 0);
  const artifact = {
    ...stationArtifact(0),
    content: '{"safe":"ok","credential":"sk-exampleSecret123456"}',
  };

  db.exec(`CREATE TRIGGER fail_pipeline_artifact_insert
    BEFORE INSERT ON content_production_pipeline_artifacts
    BEGIN SELECT RAISE(ABORT,'injected artifact failure'); END`);
  assert.throws(
    () =>
      repository.recordGenerated({
        tenantId: 7,
        pipelineId: created.id,
        stationIdx: 0,
        expectedAttempt: claimed.attempt,
        output: OUTPUTS[0],
        artifacts: [artifact],
        handlerEvidence: { completed: true },
        contextSnapshot: {},
        approvalBoundary: { code: "pick" },
        awaitingApproval: true,
      }),
    /injected artifact failure/u,
  );
  assert.equal(repository.getJob(7, created.id).status, "running");
  assert.equal(repository.getStation(7, created.id, 0).status, "running");
  assert.equal(repository.getStation(7, created.id, 0).output, null);
  assert.equal(repository.listArtifacts(7, created.id, 0).length, 0);

  db.exec("DROP TRIGGER fail_pipeline_artifact_insert");
  repository.recordGenerated({
    tenantId: 7,
    pipelineId: created.id,
    stationIdx: 0,
    expectedAttempt: claimed.attempt,
    output: OUTPUTS[0],
    artifacts: [artifact],
    handlerEvidence: { completed: true },
    contextSnapshot: {},
    approvalBoundary: { code: "pick" },
    awaitingApproval: true,
  });
  const listed = repository.listArtifacts(7, created.id, 0);
  assert.equal(listed.length, 1);
  assert.equal(Object.hasOwn(listed[0], "content"), false);
  assert.match(listed[0].sha256, /^[a-f0-9]{64}$/u);
  const stored = repository.getArtifact(7, created.id, 0, listed[0].id);
  assert.equal(stored.content.includes("sk-exampleSecret123456"), false);
  assert.equal(stored.content.includes("[REDACTED]"), true);
  assert.equal(repository.getArtifact(8, created.id, 0, listed[0].id), null);
});

test("历史station0仅在provider指纹、持久化web证据和岗位契约全通过后幂等回填当前attempt", (t) => {
  const fixture = pipelineFixture();
  t.after(() => fixture.db.close());
  const { db, repository, invocations } = fixture;
  const legacy = fixture.pipeline.create({
    tenantId: 7,
    createdBy: 71,
    title: "历史趋势工位",
    task: fixture.created.task,
    persona: fixture.created.persona,
    settings: fixture.created.settings,
    workflow: { mode: "fullauto" },
  });
  const baseOutput = structuredClone(VALID_CONTENT_EMPLOYEE_OUTPUTS[0]);
  const currentOutput = {
    ...structuredClone(baseOutput),
    selection: { candidateIndex: 0, candidateId: null },
    selected: 0,
  };
  const descriptor = CONTENT_HANDLER_ADAPTER_CATALOG[0];
  const handlerEvidence = {
    completed: true,
    providerDelivery: {
      mode: "api",
      employeeIdx: 0,
      handlerId: descriptor.handlerId,
      validated: true,
      outputFingerprint: testFingerprint(baseOutput),
    },
    productionRuntime: {
      web: {
        required: true,
        attempted: true,
        verified: true,
        resultCount: 1,
        results: [
          {
            sourceId: "来源1",
            title: "已持久化趋势证据",
            url: "https://evidence.example/trend",
            snippetSha256: `sha256:${"a".repeat(64)}`,
            rawSnippetIncluded: false,
          },
        ],
      },
    },
  };
  db.prepare(
    `UPDATE content_production_pipeline_stations
    SET status='completed',attempt=2,output_json=?,handler_evidence_json=?,
      billing_evidence_json=?,completed_at='2026-08-01T00:10:00.000Z'
    WHERE tenant_id=7 AND pipeline_id=? AND station_idx=0`,
  ).run(
    JSON.stringify(currentOutput),
    JSON.stringify(handlerEvidence),
    JSON.stringify({ state: "settled", chargedCredits: 123 }),
    legacy.id,
  );
  db.prepare(
    `UPDATE content_production_pipeline_jobs
    SET status='running',current_station=1 WHERE tenant_id=7 AND id=?`,
  ).run(legacy.id);
  db.prepare(
    `INSERT INTO content_production_pipeline_artifacts(
    tenant_id,pipeline_id,station_idx,station_attempt,artifact_index,kind,
    is_primary,filename,media_type,byte_size,content_sha256,source_keys_json,
    content,created_at
  ) VALUES(7,?,0,1,0,'json',1,'old-attempt.json','application/json',2,?,'[]','{}',?)`,
  ).run(
    legacy.id,
    createHash("sha256").update("{}").digest("hex"),
    "2026-08-01T00:00:00.000Z",
  );
  const before = db
    .prepare(
      `SELECT status,attempt,output_json,billing_evidence_json
    FROM content_production_pipeline_stations WHERE tenant_id=7 AND pipeline_id=? AND station_idx=0`,
    )
    .get(legacy.id);

  const first = repository.ensureSchema();
  assert.equal(first.inserted, 1);
  const artifacts = repository.listArtifacts(7, legacy.id, 0);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].stationAttempt, 2);
  assert.equal(artifacts[0].kind, "json");
  assert.equal(
    repository.listArtifactBackfills(7, legacy.id)[0].outcome,
    "inserted",
  );
  assert.equal(
    fixture.pipeline.inspect({ tenantId: 7, pipelineId: legacy.id }).stations[0]
      .artifactBackfill.outcome,
    "inserted",
  );
  const after = db
    .prepare(
      `SELECT status,attempt,output_json,billing_evidence_json
    FROM content_production_pipeline_stations WHERE tenant_id=7 AND pipeline_id=? AND station_idx=0`,
    )
    .get(legacy.id);
  assert.deepEqual(after, before, "回填不得修改状态、output、attempt或计费");
  assert.equal(invocations.length, 0, "回填不得调用handler/provider");

  const second = repository.ensureSchema();
  assert.equal(second.inserted, 0);
  assert.equal(repository.listArtifacts(7, legacy.id, 0).length, 1);
  assert.equal(
    db
      .prepare(
        `SELECT COUNT(*) n FROM content_production_pipeline_artifact_backfills
    WHERE tenant_id=7 AND pipeline_id=? AND station_idx=0 AND station_attempt=2`,
      )
      .get(legacy.id).n,
    1,
  );
});

test("历史artifact回填拒绝被篡改output并留下可见skip审计", (t) => {
  const fixture = pipelineFixture();
  t.after(() => fixture.db.close());
  const { db, repository } = fixture;
  const baseOutput = structuredClone(VALID_CONTENT_EMPLOYEE_OUTPUTS[0]);
  const tampered = {
    ...structuredClone(baseOutput),
    briefing: `${baseOutput.briefing}（篡改）`,
  };
  const descriptor = CONTENT_HANDLER_ADAPTER_CATALOG[0];
  db.prepare(
    `UPDATE content_production_pipeline_stations
    SET status='completed',attempt=1,output_json=?,handler_evidence_json=?
    WHERE tenant_id=7 AND pipeline_id=? AND station_idx=0`,
  ).run(
    JSON.stringify(tampered),
    JSON.stringify({
      providerDelivery: {
        mode: "api",
        employeeIdx: 0,
        handlerId: descriptor.handlerId,
        validated: true,
        outputFingerprint: testFingerprint(baseOutput),
      },
      productionRuntime: {
        web: {
          required: true,
          attempted: true,
          verified: true,
          resultCount: 1,
          results: [
            {
              title: "证据",
              url: "https://evidence.example/trend",
              snippetSha256: `sha256:${"b".repeat(64)}`,
            },
          ],
        },
      },
    }),
    fixture.created.id,
  );
  db.prepare(
    `UPDATE content_production_pipeline_jobs
    SET status='running',current_station=1 WHERE tenant_id=7 AND id=?`,
  ).run(fixture.created.id);

  const result = repository.ensureSchema();
  assert.equal(result.inserted, 0);
  assert.equal(result.skipped, 1);
  assert.equal(repository.listArtifacts(7, fixture.created.id, 0).length, 0);
  const audit = repository.listArtifactBackfills(7, fixture.created.id)[0];
  assert.equal(audit.outcome, "skipped");
  assert.equal(
    audit.reasonCode,
    "CONTENT_PIPELINE_ARTIFACT_BACKFILL_PROVIDER_EVIDENCE_MISMATCH",
  );
  assert.equal(
    fixture.pipeline.inspect({ tenantId: 7, pipelineId: fixture.created.id })
      .stations[0].artifactBackfill.outcome,
    "skipped",
  );
});

test("canonical员工包11字段或指纹不完整时，在handler/API调用前fail closed", async (t) => {
  const fixture = pipelineFixture();
  t.after(() => fixture.db.close());
  const brokenPipeline = createContentProductionPipeline({
    repository: fixture.repository,
    handlerRegistry: fixture.handlerRegistry,
    resolveImageModel: () => "gpt-image-2",
    estimateMaxCredits: () => 75,
    buildRuntimeContext: runtimeContextBuilder([]),
    compileStationExecution: async () => ({
      canonicalProfile: { identity: { domain: "content", idx: 0 } },
      runtimePackageLoad: { loadedFields: ["identity"] },
    }),
    now: fixture.now,
  });

  const state = await brokenPipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "failed");
  assert.equal(state.currentStation, 0);
  assert.equal(
    state.stations[0].failure.code,
    "CONTENT_PIPELINE_RUNTIME_PACKAGE_INVALID",
  );
  assert.equal(fixture.invocations.length, 0);
});

test("可注入交付边界严格按generate→persist→settle执行，待审站产物已落库后才结算", async (t) => {
  const events = [];
  let repositoryRef;
  const fixture = pipelineFixture({
    executeStationDelivery: async (input) => {
      events.push("hold");
      assert.equal(
        input.schemaVersion,
        "nanowork.content-production-station-delivery/1",
      );
      assert.equal(input.stationIdx, 0);
      assert.equal(input.employee.key, "trend");
      assert.equal(input.expectedPromptEvidence.allCanonicalFieldsLoaded, true);
      assert.equal(
        Object.keys(input.expectedPromptEvidence.canonicalFieldFingerprints)
          .length,
        11,
      );
      const generated = await input.generate();
      events.push("generate");
      const persisted = await input.persist(generated);
      const station = repositoryRef.getStation(
        input.tenantId,
        input.pipelineId,
        input.stationIdx,
      );
      events.push(`persist:${station.status}`);
      assert.equal(station.status, "awaiting_approval");
      assert.deepEqual(station.output.topics, OUTPUTS[0].topics);
      events.push("settle");
      return {
        persisted,
        billingEvidence: {
          status: "settled",
          holdId: 8801,
          actualTokens: 27,
          settledAt: "2026-08-01T00:00:30.000Z",
        },
      };
    },
  });
  repositoryRef = fixture.repository;
  t.after(() => fixture.db.close());

  const state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.deepEqual(events, [
    "hold",
    "generate",
    "persist:awaiting_approval",
    "settle",
  ]);
  assert.equal(state.status, "awaiting_approval");
  assert.equal(state.stations[0].billingEvidence.status, "settled");
  assert.equal(state.stations[0].contextSnapshot.billingEvidence.holdId, 8801);
});

test("persist失败会进入交付边界release语义，流水线失败且recordFailure只执行一次", async (t) => {
  const fixture = pipelineFixture();
  t.after(() => fixture.db.close());
  const events = [];
  let recordFailureCount = 0;
  const repository = {
    ...fixture.repository,
    recordGenerated() {
      events.push("persist");
      const error = new Error("测试持久化失败");
      error.code = "TEST_PERSIST_FAILED";
      error.deliveryStage = "persist";
      throw error;
    },
    recordFailure(input) {
      recordFailureCount += 1;
      return fixture.repository.recordFailure(input);
    },
  };
  const pipeline = createContentProductionPipeline({
    repository,
    handlerRegistry: fixture.handlerRegistry,
    resolveImageModel: () => "gpt-image-2",
    estimateMaxCredits: () => 75,
    buildRuntimeContext: runtimeContextBuilder([]),
    executeStationDelivery: async (input) => {
      events.push("hold");
      try {
        const generated = await input.generate();
        events.push("generate");
        await input.persist(generated);
        events.push("settle");
      } catch (cause) {
        events.push("release");
        cause.billingEvidence = {
          status: "released",
          holdId: 8802,
          reason: "persist_failed",
        };
        throw cause;
      }
      return null;
    },
    now: fixture.now,
  });

  const state = await pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.deepEqual(events, ["hold", "generate", "persist", "release"]);
  assert.equal(recordFailureCount, 1);
  assert.equal(state.status, "failed");
  assert.equal(state.currentStation, 0);
  assert.equal(state.stations[0].failure.code, "TEST_PERSIST_FAILED");
  assert.equal(state.stations[0].failure.deliveryStage, "persist");
  assert.equal(state.stations[0].billingEvidence.status, "released");
  assert.equal(state.stations[0].contextSnapshot.billingEvidence.holdId, 8802);
});

test("产物落库前失败且hold释放异常时直接进入billing_pending，禁止retry重跑provider", async (t) => {
  let deliveryCalls = 0;
  const fixture = pipelineFixture({
    executeStationDelivery: async (input) => {
      deliveryCalls += 1;
      await input.generate();
      const error = new Error("业务产物未落库，且预授权释放失败");
      error.code = "TEST_PRE_DELIVERY_RELEASE_FAILED";
      error.deliveryPhase = "generate";
      error.billing = {
        state: "pending_reconciliation",
        holdId: 8_805,
        estimatedCredits: 80,
        heldCredits: 80,
        chargedCredits: null,
        pendingReconciliation: true,
      };
      throw error;
    },
  });
  t.after(() => fixture.db.close());

  const state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(deliveryCalls, 1);
  assert.equal(fixture.invocations.length, 1);
  assert.equal(state.status, "billing_pending");
  assert.equal(state.currentStation, 0);
  assert.equal(state.stations[0].status, "billing_pending");
  assert.equal(state.stations[0].output, null);
  assert.equal(state.stations[0].billingEvidence.preDelivery, true);
  assert.equal(state.stations[0].billingEvidence.pendingReconciliation, true);
  assert.equal(state.stations[0].billingEvidence.holdId, 8_805);
  await assert.rejects(
    fixture.pipeline.retry({ tenantId: 7, pipelineId: fixture.created.id }),
    (error) => error.code === "CONTENT_PIPELINE_NOT_FAILED",
  );
  assert.equal(deliveryCalls, 1);
  assert.equal(fixture.invocations.length, 1);
});

test("persist成功后settle失败进入billing_pending，保留产物且不继续或重跑供应商", async (t) => {
  const fixture = pipelineFixture({
    workflowMode: "fullauto",
    executeStationDelivery: async (input) => {
      const generated = await input.generate();
      await input.persist(generated);
      const error = new Error("结算通道暂时不可用");
      error.code = "TEST_SETTLE_FAILED";
      error.deliveryPhase = "settle";
      error.billing = {
        status: "pending_reconciliation",
        holdId: 8803,
        actualTokens: 31,
      };
      throw error;
    },
  });
  t.after(() => fixture.db.close());

  let state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "billing_pending");
  assert.equal(state.currentStation, 0);
  assert.equal(state.stations[0].status, "billing_pending");
  assert.deepEqual(state.stations[0].output.topics, OUTPUTS[0].topics);
  assert.equal(state.stations[0].failure.deliveryStage, "settle");
  assert.equal(state.stations[0].billingEvidence.holdId, 8803);
  assert.equal(
    state.stations[0].billingEvidence.resumeStationStatus,
    "completed",
  );
  assert.deepEqual(
    fixture.invocations.map((item) => item.stationIdx),
    [0],
  );

  state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "billing_pending");
  assert.deepEqual(
    fixture.invocations.map((item) => item.stationIdx),
    [0],
  );
  await assert.rejects(
    fixture.pipeline.retry({ tenantId: 7, pipelineId: fixture.created.id }),
    (error) => error.code === "CONTENT_PIPELINE_NOT_FAILED",
  );
  assert.deepEqual(
    fixture.invocations.map((item) => item.stationIdx),
    [0],
  );
});

test("settle异常被两阶段执行器吸收为待对账返回值时也必须停站", async (t) => {
  const fixture = pipelineFixture({
    workflowMode: "fullauto",
    executeStationDelivery: async (input) => {
      const generated = await input.generate();
      const persisted = await input.persist(generated);
      return {
        generated,
        persisted,
        billingEvidence: {
          state: "pending_reconciliation",
          pendingReconciliation: true,
          holdId: 8804,
          chargedCredits: null,
        },
      };
    },
  });
  t.after(() => fixture.db.close());

  const state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "billing_pending");
  assert.equal(state.currentStation, 0);
  assert.equal(state.stations[0].status, "billing_pending");
  assert.equal(state.stations[0].billingEvidence.holdId, 8804);
  assert.equal(
    state.stations[0].failure.code,
    "CONTENT_PIPELINE_BILLING_PENDING_RECONCILIATION",
  );
  assert.deepEqual(
    fixture.invocations.map((item) => item.stationIdx),
    [0],
  );
});

test("fullauto模式为pick自动选取第一个真实候选，跳过普通审批但仍停在force终审", async (t) => {
  const fixture = pipelineFixture({ workflowMode: "fullauto" });
  t.after(() => fixture.db.close());
  let state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "awaiting_approval");
  assert.equal(state.pendingStation, 8);
  assert.equal(state.stations[0].output.selected, 0);
  assert.equal(state.stations[5].output.selected_image, 0);
  assert.equal(state.stations[6].output.selected_cover, 0);
  assert.equal(
    state.stations[3].approvalAudit[0].reasonCode,
    "CONTENT_HANDLER_WORKFLOW_AUTO_HANDOFF_ALLOWED",
  );
  assert.equal(state.stations[8].approvalBoundary.code, "force");
  state = await fixture.pipeline.review({
    tenantId: 7,
    pipelineId: fixture.created.id,
    actor: boss,
    action: "approve",
  });
  assert.equal(state.status, "completed");
});

test("老板自定义审批点只在选中工位停站，其他工位仅自动内部交接", async (t) => {
  const fixture = pipelineFixture({
    workflowMode: "copilot",
    approvalPolicy: {
      mode: "custom",
      reviewStations: [3, 8],
      configuredBy: { id: 71, role: "boss" },
    },
  });
  t.after(() => fixture.db.close());

  let state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.pendingStation, 3);
  assert.equal(state.stations[0].output.selected, 0);
  assert.equal(
    state.stations[0].approvalAudit[0].reasonCode,
    "CONTENT_PIPELINE_OWNER_APPROVAL_POLICY_AUTO_HANDOFF",
  );
  assert.equal(
    state.stations[0].approvalAudit[0].controls.externalPublishAllowed,
    false,
  );

  state = await fixture.pipeline.review({
    tenantId: 7,
    pipelineId: fixture.created.id,
    actor: boss,
    action: "approve",
  });
  assert.equal(state.pendingStation, 8);
  assert.equal(state.stations[5].output.selected_image, 0);
  assert.equal(state.stations[6].output.selected_cover, 0);
  assert.equal(
    state.stations[5].approvalAudit[0].reasonCode,
    "CONTENT_PIPELINE_OWNER_APPROVAL_POLICY_AUTO_HANDOFF",
  );

  state = await fixture.pipeline.review({
    tenantId: 7,
    pipelineId: fixture.created.id,
    actor: boss,
    action: "approve",
  });
  assert.equal(state.status, "completed");
  assert.deepEqual(state.workflow.approvalPolicy.reviewStations, [3, 8]);
});

test("老板可选全自动内部流转，即使force岗也不停审但仍禁止外发", async (t) => {
  const fixture = pipelineFixture({
    workflowMode: "copilot",
    approvalPolicy: {
      mode: "custom",
      reviewStations: [],
      configuredBy: { id: 71, role: "boss" },
    },
  });
  t.after(() => fixture.db.close());

  const state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "completed");
  assert.equal(state.pendingStation, null);
  assert.equal(
    state.stations[8].approvalAudit[0].reasonCode,
    "CONTENT_PIPELINE_OWNER_APPROVAL_POLICY_AUTO_HANDOFF",
  );
  assert.equal(state.stations[8].approvalAudit[0].factoryApprovalCode, "force");
  assert.equal(
    state.stations[8].approvalAudit[0].controls.externalPublishAllowed,
    false,
  );
});

test("enable_deck=false时工位7持久化为skipped，工位8/9不会收到合成的7号产物", async (t) => {
  const fixture = pipelineFixture({
    workflowMode: "fullauto",
    enableDeck: false,
  });
  t.after(() => fixture.db.close());
  let state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.pendingStation, 8);
  assert.equal(state.stations[7].status, "skipped");
  assert.equal(state.stations[7].output, null);
  assert.equal(
    state.stations[7].handlerEvidence.reasonCode,
    "CONTENT_PIPELINE_OPTIONAL_DECK_DISABLED",
  );
  assert.equal(state.stations[7].handlerEvidence.apiCalled, false);
  assert.equal(
    state.stations[7].approvalAudit[0].action,
    "skip_optional_station",
  );
  assert.deepEqual(
    fixture.invocations.map((item) => item.stationIdx),
    [0, 1, 2, 3, 4, 5, 6, 8],
  );
  assert.deepEqual(Object.keys(fixture.invocations.at(-1).outputs), [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
  ]);

  state = await fixture.pipeline.review({
    tenantId: 7,
    pipelineId: fixture.created.id,
    actor: boss,
    action: "approve",
  });
  assert.equal(state.status, "completed");
  assert.deepEqual(Object.keys(fixture.invocations.at(-1).outputs), [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "8",
  ]);
});

test("enable_deck=true时工位7真实调用handler并持久化HTML产物", async (t) => {
  const fixture = pipelineFixture({
    workflowMode: "fullauto",
    enableDeck: true,
  });
  t.after(() => fixture.db.close());
  const state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.pendingStation, 8);
  assert.equal(state.stations[7].status, "completed");
  assert.equal(state.stations[7].output.html, OUTPUTS[7].html);
  assert.equal(
    fixture.invocations.some((item) => item.stationIdx === 7),
    true,
  );
  assert.equal(Object.hasOwn(fixture.invocations.at(-1).outputs, "7"), true);
});

test("Paihuo Brief与workflow mode严格校验，不接受越界图片数或伪造模式", (t) => {
  const fixture = pipelineFixture();
  t.after(() => fixture.db.close());
  const brief = fixture.created.task;
  assert.throws(
    () =>
      fixture.pipeline.create({
        tenantId: 7,
        createdBy: 71,
        task: { ...brief, image_count: 13 },
        workflow: { mode: "manual" },
      }),
    /image_count/u,
  );
  assert.throws(
    () =>
      fixture.pipeline.create({
        tenantId: 7,
        createdBy: 71,
        task: brief,
        workflow: { mode: "pipeline" },
      }),
    /fullauto.*autopilot.*copilot.*manual/u,
  );
  assert.throws(
    () =>
      fixture.pipeline.create({
        tenantId: 7,
        createdBy: 71,
        task: brief,
        workflow: {
          mode: "copilot",
          approvalPolicy: { mode: "custom", reviewStations: [10] },
        },
      }),
    /0\.\.9/u,
  );
  assert.throws(
    () =>
      fixture.pipeline.create({
        tenantId: 7,
        createdBy: 71,
        task: brief,
        workflow: { mode: "copilot", approvalPolicy: { mode: "custom" } },
      }),
    /reviewStations/u,
  );
  assert.throws(
    () =>
      fixture.pipeline.create({
        tenantId: 7,
        createdBy: 71,
        task: brief,
        workflow: {
          mode: "copilot",
          approvalPolicy: { mode: "custom", reviewStations: [8] },
        },
      }),
    (error) =>
      error.code === "CONTENT_PIPELINE_APPROVAL_POLICY_AUTHORITY_REQUIRED",
  );
  assert.throws(
    () =>
      fixture.pipeline.create({
        tenantId: 7,
        createdBy: 71,
        task: brief,
        workflow: {
          mode: "copilot",
          approvalPolicy: {
            mode: "custom",
            reviewStations: [8],
            configuredBy: { id: 72, role: "manager" },
          },
        },
      }),
    (error) =>
      error.code === "CONTENT_PIPELINE_APPROVAL_POLICY_AUTHORITY_REQUIRED",
  );
  for (const mode of ["fullauto", "autopilot", "copilot", "manual"]) {
    const accepted = fixture.pipeline.create({
      tenantId: 7,
      createdBy: 71,
      task: brief,
      workflow: { mode },
    });
    assert.equal(accepted.workflow.mode, mode);
  }
});

test("listJobs只按显式tenantId返回流水线，createdBy过滤不会跨租户", (t) => {
  const fixture = pipelineFixture();
  t.after(() => fixture.db.close());
  const brief = fixture.created.task;
  const sameTenantOtherCreator = fixture.pipeline.create({
    tenantId: 7,
    createdBy: 72,
    task: brief,
    workflow: { mode: "copilot" },
  });
  fixture.pipeline.create({
    tenantId: 8,
    createdBy: 71,
    task: brief,
    workflow: { mode: "copilot" },
  });

  const tenantSeven = fixture.pipeline.list({ tenantId: 7, limit: 20 });
  assert.equal(tenantSeven.jobs.length, 2);
  assert.equal(
    tenantSeven.jobs.every((job) => job.tenantId === 7),
    true,
  );
  const creatorFiltered = fixture.pipeline.list({
    tenantId: 7,
    createdBy: 72,
    limit: 20,
  });
  assert.deepEqual(
    creatorFiltered.jobs.map((job) => job.id),
    [sameTenantOtherCreator.id],
  );
  assert.equal(
    fixture.pipeline.list({ tenantId: 8, createdBy: 72 }).jobs.length,
    0,
  );
  assert.throws(
    () => fixture.pipeline.list({ tenantId: 7, limit: 101 }),
    /limit/u,
  );
});

test("锁定handler目录的10个工位与流水线索引一一对齐", () => {
  assert.equal(CONTENT_HANDLER_ADAPTER_CATALOG.length, 10);
  assert.deepEqual(
    CONTENT_HANDLER_ADAPTER_CATALOG.map((item) => item.employeeIdx),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.deepEqual(
    CONTENT_HANDLER_ADAPTER_CATALOG.map((item) => item.approvalBoundary.code),
    [
      "pick",
      "auto",
      "auto",
      "review",
      "auto",
      "pick",
      "pick",
      "auto",
      "force",
      "auto",
    ],
  );
});

test("岗位契约失败会原子保存私有检索快照，attempt2复用且inspect/list永不返回snippet", async (t) => {
  const fixture = privateSnapshotPipelineFixture();
  t.after(() => fixture.db.close());

  const failed = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.pipelineId,
  });
  assert.equal(failed.status, "failed");
  assert.deepEqual(fixture.counts(), { webCalls: 6, modelCalls: 1 });
  assert.equal(
    fixture.db
      .prepare(
        `SELECT COUNT(*) n
      FROM content_production_pipeline_private_web_snapshots
      WHERE tenant_id=7 AND pipeline_id=? AND station_idx=0 AND station_attempt=1`,
      )
      .get(fixture.pipelineId).n,
    1,
  );
  const publicInspect = fixture.pipeline.inspect({
    tenantId: 7,
    pipelineId: fixture.pipelineId,
  });
  const publicList = fixture.pipeline.list({ tenantId: 7 });
  assert.equal(
    JSON.stringify(publicInspect).includes("服务器私有联网快照正文"),
    false,
  );
  assert.equal(
    JSON.stringify(publicList).includes("服务器私有联网快照正文"),
    false,
  );
  assert.equal(JSON.stringify(publicInspect).includes("snapshot_json"), false);
  assert.equal(JSON.stringify(publicInspect).includes("verifiedAt"), false);

  fixture.setContractValid();
  const retried = await fixture.pipeline.retry({
    tenantId: 7,
    pipelineId: fixture.pipelineId,
  });
  assert.equal(
    retried.status,
    "awaiting_approval",
    JSON.stringify(retried.failure),
  );
  assert.equal(retried.stations[0].attempt, 2);
  assert.deepEqual(fixture.counts(), { webCalls: 6, modelCalls: 2 });
  assert.equal(
    retried.stations[0].handlerEvidence.productionRuntime.web.reused,
    true,
  );
  assert.equal(
    retried.stations[0].handlerEvidence.productionRuntime.web.webSearchCalled,
    false,
  );
  assert.equal(
    retried.stations[0].handlerEvidence.productionRuntime.web.cache.expired,
    false,
  );
});

test("显式刷新或篡改私有缓存时拒绝复用并重新联网，现有DB可幂等迁移", async (t) => {
  const refreshFixture = privateSnapshotPipelineFixture();
  t.after(() => refreshFixture.db.close());
  await refreshFixture.pipeline.resume({
    tenantId: 7,
    pipelineId: refreshFixture.pipelineId,
  });
  refreshFixture.setContractValid();
  const refreshed = await refreshFixture.pipeline.retry({
    tenantId: 7,
    pipelineId: refreshFixture.pipelineId,
    refreshWebEvidence: true,
  });
  assert.deepEqual(refreshFixture.counts(), { webCalls: 12, modelCalls: 2 });
  assert.equal(
    refreshed.stations[0].handlerEvidence.productionRuntime.web.reused,
    false,
  );

  const tamperFixture = privateSnapshotPipelineFixture();
  t.after(() => tamperFixture.db.close());
  await tamperFixture.pipeline.resume({
    tenantId: 7,
    pipelineId: tamperFixture.pipelineId,
  });
  const row = tamperFixture.db
    .prepare(
      `SELECT snapshot_json
    FROM content_production_pipeline_private_web_snapshots
    WHERE tenant_id=7 AND pipeline_id=? AND station_idx=0`,
    )
    .get(tamperFixture.pipelineId);
  const tampered = JSON.parse(row.snapshot_json);
  tampered.results[0].url = "https://user:password@evidence.example/private";
  tamperFixture.db
    .prepare(
      `UPDATE content_production_pipeline_private_web_snapshots
    SET snapshot_json=? WHERE tenant_id=7 AND pipeline_id=? AND station_idx=0`,
    )
    .run(JSON.stringify(tampered), tamperFixture.pipelineId);
  assert.equal(
    tamperFixture.repository.getPrivateWebSnapshot(
      7,
      tamperFixture.pipelineId,
      0,
    ),
    null,
  );
  tamperFixture.setContractValid();
  await tamperFixture.pipeline.retry({
    tenantId: 7,
    pipelineId: tamperFixture.pipelineId,
  });
  assert.deepEqual(tamperFixture.counts(), { webCalls: 12, modelCalls: 2 });
  assert.doesNotThrow(() => tamperFixture.repository.ensureSchema());
  assert.equal(
    tamperFixture.db
      .prepare(
        `SELECT COUNT(*) n
      FROM content_production_pipeline_private_web_snapshots`,
      )
      .get().n,
    1,
  );
});

test("ensureSchema在已有SQLite文件上幂等新增私有快照表，不改写既有业务表", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE existing_business_rows (
    id INTEGER PRIMARY KEY,
    payload TEXT NOT NULL
  );
  INSERT INTO existing_business_rows(id,payload) VALUES(1,'keep-me');`);
  const repository = createSqliteContentProductionPipelineRepository({
    db,
    now: clock(),
  });
  assert.doesNotThrow(() => repository.ensureSchema());
  assert.doesNotThrow(() => repository.ensureSchema());
  assert.equal(
    db.prepare(`SELECT payload FROM existing_business_rows WHERE id=1`).get()
      .payload,
    "keep-me",
  );
  assert.equal(
    db
      .prepare(
        `SELECT COUNT(*) n FROM sqlite_master
      WHERE type='table' AND name='content_production_pipeline_private_web_snapshots'`,
      )
      .get().n,
    1,
  );
});
