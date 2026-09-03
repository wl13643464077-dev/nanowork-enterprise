import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";

import express from "express";

process.env.NANOWORK_DB = ":memory:";

const {
  contentPipelineReviewAudienceIds,
  contentPipelineUnsettledStationBilling,
  createContentProductionPipelineRouter,
  mergeContentPipelineStationBillingEvidence,
} = await import("../src/routes/content-production-pipeline.js");
const { db, runWithTenant } = await import("../src/db.js");
const { CONTENT_PAID_MEDIA_PRICING_VERSION, contentPaidMediaPricingSnapshot } =
  await import("../src/engines/content-paid-media-authorization.js");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    manager_id INTEGER,
    name TEXT,
    role TEXT,
    status TEXT
  );
  INSERT INTO users(id,tenant_id,manager_id,name,role,status) VALUES
    (101,11,NULL,'老板','boss','启用'),
    (102,11,101,'经理','manager','启用'),
    (103,11,102,'员工甲','sales','启用'),
    (104,11,NULL,'员工乙','sales','启用'),
    (105,11,NULL,'管理员','admin','启用'),
    (106,11,101,'同级经理','manager','启用'),
    (107,11,106,'同级下属','sales','启用'),
    (108,11,102,'停用经理','manager','停用'),
    (201,12,NULL,'其他租户老板','boss','启用');
  CREATE TABLE IF NOT EXISTS credit_holds (
    id INTEGER PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    held_credits INTEGER NOT NULL,
    settled_credits INTEGER,
    ref_type TEXT,
    ref_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT,
    type TEXT,
    tags TEXT,
    url TEXT,
    source_type TEXT,
    source_id INTEGER,
    creator_id INTEGER,
    note TEXT,
    body_snapshot TEXT,
    artifact_snapshot_json TEXT,
    snapshot_hash TEXT,
    use_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

after(() => {
  try {
    db.close();
  } catch {
    // 共享测试进程已关闭时无需重复处理。
  }
});

const EXACT_BRIEF = Object.freeze({
  direction: "真实数字员工如何完成一条老板向内容",
  template: "观点输出",
  industry: "企业服务",
  material: "只使用已经确认的产品资料与客户访谈",
  ref_link: "https://example.com/confirmed-source",
  platforms: Object.freeze(["小红书", "视频号"]),
  image_mode: "mix",
  image_count: 0,
  enable_deck: false,
  xhs_style: Object.freeze({ name: "老板口吻", desc: "结论先行" }),
  dy_style: null,
});

const ACTORS = Object.freeze({
  boss: Object.freeze({ id: 101, tenant_id: 11, role: "boss", name: "老板" }),
  manager: Object.freeze({
    id: 102,
    tenant_id: 11,
    role: "manager",
    name: "经理",
  }),
  admin: Object.freeze({
    id: 105,
    tenant_id: 11,
    role: "admin",
    name: "管理员",
  }),
  peerManager: Object.freeze({
    id: 106,
    tenant_id: 11,
    role: "manager",
    name: "同级经理",
  }),
  staff: Object.freeze({
    id: 103,
    tenant_id: 11,
    role: "sales",
    name: "员工甲",
  }),
  peer: Object.freeze({
    id: 104,
    tenant_id: 11,
    role: "sales",
    name: "员工乙",
  }),
  otherBoss: Object.freeze({
    id: 201,
    tenant_id: 12,
    role: "boss",
    name: "其他租户老板",
  }),
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function canonicalApprovalPolicy(value) {
  if (!value) return undefined;
  return {
    mode: value.mode,
    reviewStations: [...new Set((value.reviewStations || []).map(Number))].sort(
      (a, b) => a - b,
    ),
    configuredBy: clone(value.configuredBy),
    externalPublishAllowed: false,
  };
}

function fakePipelineFixture({ materialProviderAvailable = true } = {}) {
  let nextId = 1_000;
  const states = new Map();
  const resumeUpdates = new Map();
  const artifactRows = new Map();
  const scheduled = [];
  const calls = {
    create: [],
    inspect: [],
    list: [],
    review: [],
    submitMetrics: [],
    authorizePaidMedia: [],
    retry: [],
    recoverInterrupted: [],
    pause: [],
    resumePaused: [],
    cancel: [],
    resume: [],
    precheck: [],
    logs: [],
    notifications: [],
  };

  const seed = ({
    id = nextId++,
    tenantId = 11,
    createdBy = 101,
    title = `流水线 ${id}`,
    status = "running",
    currentStation = 0,
    pendingStation = null,
    task = EXACT_BRIEF,
    workflow = { mode: "copilot" },
    stations = [],
  } = {}) => {
    nextId = Math.max(nextId, id + 1);
    const state = {
      id,
      tenantId,
      createdBy,
      title,
      status,
      currentStation,
      pendingStation,
      task: clone(task),
      workflow: clone(workflow),
      stations: clone(stations),
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    states.set(id, state);
    return state;
  };

  const stateFor = (tenantId, pipelineId) => {
    const state = states.get(Number(pipelineId));
    return state && Number(state.tenantId) === Number(tenantId) ? state : null;
  };

  const pipeline = {
    create(input) {
      calls.create.push(clone(input));
      const policy = canonicalApprovalPolicy(input.workflow?.approvalPolicy);
      return seed({
        tenantId: input.tenantId,
        createdBy: input.createdBy,
        title: input.title,
        task: input.task,
        workflow: {
          mode: input.workflow?.mode,
          ...(policy ? { approvalPolicy: policy } : {}),
          ...(input.workflow?.paidMediaAuthorization
            ? {
                paidMediaAuthorization: clone(
                  input.workflow.paidMediaAuthorization,
                ),
              }
            : {}),
        },
      });
    },
    inspect(input) {
      calls.inspect.push(clone(input));
      return stateFor(input.tenantId, input.pipelineId);
    },
    list(input) {
      calls.list.push(clone(input));
      const jobs = [...states.values()]
        .filter((state) => Number(state.tenantId) === Number(input.tenantId))
        .filter(
          (state) =>
            input.createdBy == null ||
            Number(state.createdBy) === Number(input.createdBy),
        )
        .slice(0, input.limit);
      return {
        schemaVersion: "nanowork.content-production-pipeline/1",
        mode: "pipeline",
        tenantId: input.tenantId,
        jobs,
      };
    },
    async review(input) {
      calls.review.push(clone(input));
      const state = stateFor(input.tenantId, input.pipelineId);
      if (input.action === "reject") {
        state.status = "rejected";
      } else {
        state.status = "running";
        state.pendingStation = null;
        state.currentStation += 1;
      }
      return state;
    },
    submitMetrics(input) {
      calls.submitMetrics.push(clone(input));
      const state = stateFor(input.tenantId, input.pipelineId);
      const requiredPlatforms = [...new Set(state.task.platforms || [])];
      const existingEntries = state.workflow?.publicationMetrics?.entries || [];
      const byPlatform = new Map(
        existingEntries.map((entry) => [
          entry.publication.platform,
          clone(entry),
        ]),
      );
      byPlatform.set(input.publication.platform, {
        publication: clone(input.publication),
        metrics: clone(input.metrics),
        evidenceNote: input.evidenceNote || null,
        verification: { status: "manual_unverified", platformVerified: false },
      });
      const entries = requiredPlatforms
        .map((platform) => byPlatform.get(platform))
        .filter(Boolean);
      const submittedPlatforms = entries.map(
        (entry) => entry.publication.platform,
      );
      const missingPlatforms = requiredPlatforms.filter(
        (platform) => !byPlatform.has(platform),
      );
      if (!missingPlatforms.length) {
        state.status = "running";
        state.currentStation = 9;
        state.pendingStation = null;
      }
      state.workflow = {
        ...state.workflow,
        publicationMetrics: {
          schemaVersion: "nanowork.content-publication-metrics-collection/2",
          requiredPlatforms,
          entries,
          submittedPlatforms,
          missingPlatforms,
          complete: missingPlatforms.length === 0,
          verificationStatus: "manual_unverified",
        },
      };
      return state;
    },
    async retry(input) {
      calls.retry.push(clone(input));
      const state = stateFor(input.tenantId, input.pipelineId);
      state.status = "running";
      return state;
    },
    authorizePaidMedia(input) {
      calls.authorizePaidMedia.push(clone(input));
      const state = stateFor(input.tenantId, input.pipelineId);
      state.workflow = {
        ...state.workflow,
        paidMediaAuthorization: clone(input.policy),
      };
      if (state.status === "awaiting_media_authorization") {
        state.status = "running";
        state.pendingStation = null;
        const station = state.stations.find(
          (item) => Number(item.stationIdx) === 5,
        );
        if (station) {
          station.status = "pending";
          station.failure = null;
        }
      }
      return state;
    },
    recoverInterrupted(input) {
      calls.recoverInterrupted.push(clone(input));
      const state = stateFor(input.tenantId, input.pipelineId);
      state.status = "running";
      return state;
    },
    pause(input) {
      calls.pause.push(clone(input));
      const state = stateFor(input.tenantId, input.pipelineId);
      state.status = "paused";
      const station = state.stations.find(
        (item) => Number(item.stationIdx) === Number(state.currentStation),
      );
      if (station?.status === "running") station.status = "paused";
      return state;
    },
    resumePaused(input) {
      calls.resumePaused.push(clone(input));
      const state = stateFor(input.tenantId, input.pipelineId);
      state.status = "running";
      const station = state.stations.find(
        (item) => Number(item.stationIdx) === Number(state.currentStation),
      );
      if (station?.status === "paused") station.status = "pending";
      return state;
    },
    cancel(input) {
      calls.cancel.push(clone(input));
      const state = stateFor(input.tenantId, input.pipelineId);
      state.status = "cancelled";
      state.failure = { code: "CONTENT_PIPELINE_CANCELLED" };
      for (const station of state.stations) {
        if (Number(station.stationIdx) >= Number(state.currentStation)) {
          station.status = "cancelled";
        }
      }
      return state;
    },
    async resume(input) {
      calls.resume.push(clone(input));
      const state = stateFor(input.tenantId, input.pipelineId);
      const update = resumeUpdates.get(Number(input.pipelineId));
      if (state && update) Object.assign(state, clone(update));
      return state;
    },
  };

  const repository = {
    getArtifact(tenantId, pipelineId, stationIdx, artifactId) {
      const row = artifactRows.get(Number(artifactId));
      if (
        !row ||
        Number(row.tenantId) !== Number(tenantId) ||
        Number(row.pipelineId) !== Number(pipelineId) ||
        Number(row.stationIdx) !== Number(stationIdx)
      )
        return null;
      return clone(row);
    },
  };

  const seedArtifact = (artifact) => {
    artifactRows.set(Number(artifact.id), clone(artifact));
    return artifact;
  };

  const router = createContentProductionPipelineRouter({
    getRuntime: () => ({ pipeline, repository }),
    profileStore: {
      load: (tenantId) => ({
        revision: 7,
        profile: { tenantId, persona: { tone: "真实、直接" } },
      }),
    },
    resolveStructuredBriefFn: ({ explicitInput }) => ({
      paihuoBrief: clone(explicitInput),
      handlerContext: {
        profile: { persona: { tone: "真实、直接" } },
        companyProfile: { brand: "测试企业" },
      },
      evidence: { source: "route_test_exact_brief" },
    }),
    providerAvailableFn: () => true,
    materialProviderAvailableFn: () => materialProviderAvailable,
    precheckByRoleFn: (...args) => calls.precheck.push(clone(args)),
    scheduleFn: (task) => scheduled.push(task),
    runWithTenantFn: (_tenantId, task) => task(),
    logOpFn: (...args) => calls.logs.push(clone(args)),
    notifyFn: (...args) => calls.notifications.push(clone(args)),
    estimateMaxCreditsFn: () => 75,
    resolveImageModelFn: () => "gpt-image-2",
    nowFn: () => new Date("2026-08-02T00:00:00.000Z"),
  });

  return {
    calls,
    pipeline,
    repository,
    router,
    scheduled,
    seed,
    seedArtifact,
    setResumeUpdate(pipelineId, update) {
      resumeUpdates.set(Number(pipelineId), clone(update));
    },
    async flushNext() {
      const task = scheduled.shift();
      assert.equal(typeof task, "function", "应存在一个待执行的假后台任务");
      await task();
    },
  };
}

async function routeServer(t, options = {}) {
  const { attachAiGuard = true, ...fixtureOptions } = options;
  const fixture = fakePipelineFixture(fixtureOptions);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const encodedActor = String(req.get("x-test-actor") || "e30");
    const actor = JSON.parse(
      Buffer.from(encodedActor, "base64url").toString("utf8"),
    );
    req.user = { ...actor, status: "启用" };
    if (attachAiGuard) req.aiGuard = { defer: () => () => {} };
    runWithTenant(actor.tenant_id, () => next());
  });
  app.use("/api/content", fixture.router);
  const server = app.listen(0, "127.0.0.1");
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const request = async (
    pathname,
    { actor = ACTORS.boss, method = "GET", body } = {},
  ) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: {
        "x-test-actor": Buffer.from(JSON.stringify(actor), "utf8").toString(
          "base64url",
        ),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const contentType = response.headers.get("content-type") || "";
    return {
      status: response.status,
      payload: contentType.includes("application/json")
        ? await response.json()
        : contentType.startsWith("image/")
          ? Buffer.from(await response.arrayBuffer())
          : await response.text(),
      headers: response.headers,
    };
  };

  return { ...fixture, request };
}

test("boss创建保留exact 11字段Brief，自定义停审点且配置人不可伪造", async (t) => {
  const fixture = await routeServer(t);
  assert.equal(Object.keys(EXACT_BRIEF).length, 11);

  const result = await fixture.request("/api/content/pipelines", {
    method: "POST",
    body: {
      brief: EXACT_BRIEF,
      workflow: {
        mode: "copilot",
        approvalPolicy: {
          mode: "custom",
          reviewStations: [8, 0, 8],
          configuredByRole: "staff",
          configuredBy: { id: 999, role: "platform_super" },
        },
      },
    },
  });

  assert.equal(result.status, 202, JSON.stringify(result.payload));
  assert.equal(result.payload.queued, true);
  assert.equal(result.headers.get("retry-after"), "2");
  assert.deepEqual(Object.keys(fixture.calls.create[0].task), [
    ...Object.keys(EXACT_BRIEF),
    "visual_policy_version",
  ]);
  assert.deepEqual(fixture.calls.create[0].task, {
    ...EXACT_BRIEF,
    visual_policy_version: "v2",
  });
  assert.equal(Object.hasOwn(EXACT_BRIEF, "visual_policy_version"), false);
  assert.deepEqual(
    fixture.calls.create[0].workflow.approvalPolicy.configuredBy,
    {
      id: ACTORS.boss.id,
      role: ACTORS.boss.role,
    },
  );
  assert.deepEqual(
    result.payload.pipeline.workflow.approvalPolicy.reviewStations,
    [0, 8],
  );
  assert.deepEqual(
    result.payload.pipeline.workflow.approvalPolicy.configuredBy,
    {
      id: ACTORS.boss.id,
      role: ACTORS.boss.role,
    },
  );
  assert.equal(
    Object.hasOwn(
      result.payload.pipeline.workflow.approvalPolicy,
      "configuredByRole",
    ),
    false,
  );
  assert.equal(
    result.payload.pipeline.workflow.approvalPolicy.externalPublishAllowed,
    false,
  );
  assert.equal(fixture.scheduled.length, 1);
});

test("老板创建时可一次明确授权当前Brief的付费媒体上限，客户端不能夹带伪造授权", async (t) => {
  const fixture = await routeServer(t);
  const estimate = await fixture.request(
    "/api/content/pipelines/paid-media-estimate?imageCount=auto",
  );
  assert.equal(estimate.status, 200, JSON.stringify(estimate.payload));
  const pricing = contentPaidMediaPricingSnapshot({
    imageModel: "gpt-image-2",
    estimatedUnitCredits: 75,
  });
  assert.deepEqual(estimate.payload.estimate, {
    imageModel: "gpt-image-2",
    pricingVersion: CONTENT_PAID_MEDIA_PRICING_VERSION,
    pricingFingerprint: pricing.pricingFingerprint,
    maximumContentImageCount: 4,
    maximumCoverImageCount: 1,
    maximumImageCount: 5,
    estimatedUnitCredits: 75,
    estimatedMaximumCredits: 375,
    authorizationValidHours: 24,
    externalPublishAllowed: false,
  });
  const result = await fixture.request("/api/content/pipelines", {
    method: "POST",
    body: {
      brief: EXACT_BRIEF,
      workflow: { mode: "copilot", paidMediaAuthorized: true },
    },
  });
  assert.equal(result.status, 202, JSON.stringify(result.payload));
  const policy = fixture.calls.create[0].workflow.paidMediaAuthorization;
  assert.equal(policy.authorizedBy.id, ACTORS.boss.id);
  assert.equal(policy.authorizedBy.role, "boss");
  assert.equal(policy.maximumContentImageCount, 4);
  assert.equal(policy.maximumCoverImageCount, 2);
  assert.equal(policy.maximumImageCount, 6);
  assert.equal(policy.imageModel, "gpt-image-2");
  assert.equal(policy.pricingVersion, CONTENT_PAID_MEDIA_PRICING_VERSION);
  assert.equal(policy.pricingFingerprint, pricing.pricingFingerprint);
  assert.equal(policy.estimatedUnitCredits, 75);
  assert.equal(policy.estimatedMaximumCredits, 450);
  assert.equal(policy.externalPublishAllowed, false);

  const forged = await fixture.request("/api/content/pipelines", {
    method: "POST",
    body: {
      brief: EXACT_BRIEF,
      workflow: {
        mode: "copilot",
        paidMediaAuthorization: {
          authorized: true,
          estimatedMaximumCredits: 1,
        },
      },
    },
  });
  assert.equal(forged.status, 400);
  assert.equal(
    forged.payload.code,
    "CONTENT_PIPELINE_MEDIA_AUTHORIZATION_FORGED",
  );
  assert.equal(fixture.calls.create.length, 1);
});

test("普通员工不能付费授权；老板授权阻断中的工位5后原子恢复并排队，早期失败任务只落授权不乱重试", async (t) => {
  const fixture = await routeServer(t);
  fixture.seed({
    id: 1401,
    createdBy: ACTORS.staff.id,
    status: "awaiting_media_authorization",
    currentStation: 5,
    pendingStation: 5,
    workflow: { mode: "copilot" },
    stations: [
      {
        stationIdx: 5,
        status: "awaiting_media_authorization",
        failure: { code: "CONTENT_PAID_MEDIA_AUTHORIZATION_REQUIRED" },
      },
    ],
  });
  const denied = await fixture.request(
    "/api/content/pipelines/1401/paid-media-authorization",
    {
      actor: ACTORS.staff,
      method: "POST",
      body: { authorized: true },
    },
  );
  assert.equal(denied.status, 403);
  assert.equal(fixture.calls.authorizePaidMedia.length, 0);

  const authorized = await fixture.request(
    "/api/content/pipelines/1401/paid-media-authorization",
    {
      actor: ACTORS.boss,
      method: "POST",
      body: { authorized: true },
    },
  );
  assert.equal(authorized.status, 202, JSON.stringify(authorized.payload));
  assert.equal(authorized.payload.queued, true);
  assert.equal(fixture.calls.authorizePaidMedia.length, 1);
  assert.equal(
    fixture.calls.authorizePaidMedia[0].policy.imageModel,
    "gpt-image-2",
  );
  assert.equal(
    fixture.calls.authorizePaidMedia[0].policy.pricingVersion,
    CONTENT_PAID_MEDIA_PRICING_VERSION,
  );
  assert.equal(
    fixture.calls.authorizePaidMedia[0].policy.estimatedMaximumCredits,
    450,
  );
  assert.equal(fixture.scheduled.length, 1);

  fixture.seed({
    id: 1402,
    status: "failed",
    currentStation: 1,
    workflow: { mode: "copilot" },
    stations: [
      { stationIdx: 1, status: "failed", failure: { code: "SEARCH_FAILED" } },
    ],
  });
  const oldPipeline = await fixture.request(
    "/api/content/pipelines/1402/paid-media-authorization",
    {
      actor: ACTORS.admin,
      method: "POST",
      body: { authorized: true },
    },
  );
  assert.equal(oldPipeline.status, 200, JSON.stringify(oldPipeline.payload));
  assert.equal(oldPipeline.payload.queued, false);
  assert.equal(fixture.calls.authorizePaidMedia.length, 2);
  assert.equal(fixture.scheduled.length, 1);
});

test("旧授权在工位6失败后可由老板重新授权并安全排队恢复封面工位", async (t) => {
  const fixture = await routeServer(t);
  fixture.seed({
    id: 1403,
    status: "failed",
    currentStation: 6,
    workflow: {
      mode: "copilot",
      paidMediaAuthorization: {
        schemaVersion: "nanowork.content-paid-media-authorization/2",
      },
    },
    stations: [
      {
        stationIdx: 6,
        status: "failed",
        failure: { code: "CONTENT_PAID_MEDIA_REAUTHORIZATION_REQUIRED" },
      },
    ],
  });
  const reauthorized = await fixture.request(
    "/api/content/pipelines/1403/paid-media-authorization",
    {
      actor: ACTORS.boss,
      method: "POST",
      body: { authorized: true },
    },
  );
  assert.equal(reauthorized.status, 202, JSON.stringify(reauthorized.payload));
  assert.equal(reauthorized.payload.queued, true);
  assert.equal(
    fixture.calls.authorizePaidMedia[0].policy.schemaVersion,
    "nanowork.content-paid-media-authorization/3",
  );
  assert.equal(fixture.scheduled.length, 1);
  await fixture.flushNext();
  assert.equal(fixture.calls.retry.length, 1);
  assert.equal(fixture.calls.retry[0].pipelineId, 1403);
});

test("未配置授权素材provider时仅严格real禁用，mix仍可由GPT Image 2补齐", async (t) => {
  const fixture = await routeServer(t, { materialProviderAvailable: false });
  const realResult = await fixture.request("/api/content/pipelines", {
    method: "POST",
    body: { brief: { ...EXACT_BRIEF, image_mode: "real" } },
  });
  assert.equal(realResult.status, 503, JSON.stringify(realResult.payload));
  assert.equal(
    realResult.payload.code,
    "CONTENT_PIPELINE_LICENSED_MATERIAL_PROVIDER_UNAVAILABLE",
  );
  assert.match(realResult.payload.error, /GPT Image 2自动补足/u);
  assert.equal(fixture.calls.create.length, 0);
  assert.equal(fixture.scheduled.length, 0);

  const mixResult = await fixture.request("/api/content/pipelines", {
    method: "POST",
    body: { brief: EXACT_BRIEF },
  });
  assert.equal(mixResult.status, 202, JSON.stringify(mixResult.payload));
  assert.equal(fixture.calls.create.length, 1);
  assert.equal(fixture.calls.create[0].task.image_mode, "mix");
  assert.equal(fixture.scheduled.length, 1);
});

test("后台AI守卫缺失时在创建业务记录前失败关闭", async (t) => {
  const fixture = await routeServer(t, { attachAiGuard: false });
  const result = await fixture.request("/api/content/pipelines", {
    method: "POST",
    body: { brief: { ...EXACT_BRIEF, image_mode: "ai" } },
  });
  assert.equal(result.status, 503, JSON.stringify(result.payload));
  assert.equal(result.payload.code, "CONTENT_PIPELINE_AI_GUARD_REQUIRED");
  assert.equal(fixture.calls.create.length, 0);
  assert.equal(fixture.scheduled.length, 0);
});

test("special bridge任一pending hold会覆盖已结算文本账务并停为billing_pending证据", () => {
  const generated = {
    handlerEvidence: {
      productionRuntime: {
        specialRuntime: {
          bridge: {
            attempts: [
              {
                attemptId:
                  "content-production-pipeline:pipeline:49:station:5:provider:image:attempt:1",
                kind: "image",
                status: "pending_reconciliation",
                replayed: false,
                hold: {
                  holdId: 701,
                  refType: "content_special_provider",
                  refId: 900_701,
                },
                billing: {
                  state: "pending_reconciliation",
                  estimatedCredits: 150,
                  heldCredits: 150,
                  chargedCredits: null,
                  pendingReconciliation: true,
                },
                delivery: { persisted: true, artifactIds: ["material:801"] },
              },
            ],
          },
        },
      },
    },
  };
  const merged = mergeContentPipelineStationBillingEvidence(generated, {
    state: "settled",
    holdId: 700,
    estimatedCredits: 20,
    heldCredits: 0,
    chargedCredits: 12,
    pendingReconciliation: false,
  });
  assert.equal(merged.state, "pending_reconciliation");
  assert.equal(merged.pendingReconciliation, true);
  assert.equal(merged.chargedCredits, null);
  assert.equal(merged.heldCredits, 150);
  assert.equal(merged.components.stationText.state, "settled");
  assert.equal(merged.components.specialProviders[0].holdId, 701);
  assert.equal(merged.components.specialProviders[0].delivery.persisted, true);
});

test("special bridge全部结算时工位账单合并文本与图片实扣，不遗漏专项provider费用", () => {
  const generated = {
    handlerEvidence: {
      productionRuntime: {
        specialRuntime: {
          bridge: {
            attempts: [
              {
                attemptId:
                  "content-production-pipeline:pipeline:50:station:5:provider:image:attempt:1",
                kind: "image",
                status: "settled",
                replayed: false,
                hold: {
                  holdId: 711,
                  refType: "content_special_provider",
                  refId: 900_711,
                },
                billing: {
                  state: "settled",
                  estimatedCredits: 150,
                  heldCredits: 0,
                  chargedCredits: 130,
                  costYuan: 1.3,
                  balance: 9_858,
                  pendingReconciliation: false,
                },
                delivery: { persisted: true, artifactIds: ["material:811"] },
              },
            ],
          },
        },
      },
    },
  };
  const merged = mergeContentPipelineStationBillingEvidence(generated, {
    state: "settled",
    holdId: 710,
    estimatedCredits: 20,
    heldCredits: 0,
    chargedCredits: 12,
    costYuan: 0.12,
    balance: 9_858,
    pendingReconciliation: false,
  });
  assert.equal(merged.state, "settled");
  assert.equal(merged.pendingReconciliation, false);
  assert.equal(merged.estimatedCredits, 170);
  assert.equal(merged.chargedCredits, 142);
  assert.equal(merged.heldCredits, 0);
  assert.equal(merged.costYuan, 1.42);
  assert.equal(merged.balance, 9_858);
  assert.equal(merged.components.stationText.holdId, 710);
  assert.equal(merged.components.specialProviders[0].holdId, 711);
});

test("同一工位的多笔主文本held全部进入待对账证据并严格隔离租户与ref", (t) => {
  const tenantId = ACTORS.boss.tenant_id;
  const pipelineId = 1_489;
  const stationIdx = 2;
  const refId = pipelineId * 10 + stationIdx + 1;
  const ids = [89_901, 89_902, 89_903, 89_904, 89_905];
  t.after(() => {
    db.prepare(
      `DELETE FROM credit_holds WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).run(...ids);
  });
  const insert = db.prepare(`INSERT INTO credit_holds(
    id,tenant_id,status,held_credits,settled_credits,ref_type,ref_id
  ) VALUES(?,?,?,?,?,?,?)`);
  insert.run(
    ids[1],
    tenantId,
    "held",
    59,
    null,
    "content_production_pipeline_station",
    refId,
  );
  insert.run(
    ids[0],
    tenantId,
    "held",
    41,
    null,
    "content_production_pipeline_station",
    refId,
  );
  insert.run(
    ids[2],
    tenantId,
    "settled",
    77,
    77,
    "content_production_pipeline_station",
    refId,
  );
  insert.run(
    ids[3],
    ACTORS.otherBoss.tenant_id,
    "held",
    83,
    null,
    "content_production_pipeline_station",
    refId,
  );
  insert.run(
    ids[4],
    tenantId,
    "held",
    97,
    null,
    "content_production_pipeline_station",
    refId + 1,
  );

  const billing = contentPipelineUnsettledStationBilling({
    tenantId,
    pipelineId,
    stationIdx,
  });

  assert.equal(billing.state, "pending_reconciliation");
  assert.equal(billing.heldCredits, 100);
  assert.deepEqual(billing.holdIds, [ids[0], ids[1]]);
  assert.equal(new Set(billing.holdIds).size, billing.holdIds.length);
  assert.deepEqual(
    billing.components.map((component) => ({
      component: component.component,
      holdId: component.holdId,
      heldCredits: component.heldCredits,
      refType: component.refType,
      refId: component.refId,
    })),
    [
      {
        component: "stationText",
        holdId: ids[0],
        heldCredits: 41,
        refType: "content_production_pipeline_station",
        refId,
      },
      {
        component: "stationText",
        holdId: ids[1],
        heldCredits: 59,
        refType: "content_production_pipeline_station",
        refId,
      },
    ],
  );
});

test("manager与staff不能提交自定义审批，但可使用不含外发授权的internal_auto连续出内部报告", async (t) => {
  const fixture = await routeServer(t);
  for (const actor of [ACTORS.manager, ACTORS.staff]) {
    const denied = await fixture.request("/api/content/pipelines", {
      actor,
      method: "POST",
      body: {
        brief: EXACT_BRIEF,
        workflow: {
          mode: "copilot",
          approvalPolicy: { mode: "custom", reviewStations: [8] },
        },
      },
    });
    assert.equal(
      denied.status,
      403,
      `${actor.role}:${JSON.stringify(denied.payload)}`,
    );
    assert.equal(
      denied.payload.code,
      "CONTENT_PIPELINE_APPROVAL_POLICY_ROLE_FORBIDDEN",
    );
  }
  assert.equal(fixture.calls.create.length, 0);

  for (const actor of [ACTORS.manager, ACTORS.staff]) {
    const accepted = await fixture.request("/api/content/pipelines", {
      actor,
      method: "POST",
      body: {
        brief: EXACT_BRIEF,
        workflow: {
          mode: "fullauto",
          approvalPolicy: { mode: "internal_auto" },
        },
      },
    });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.payload));
  }
  assert.deepEqual(
    fixture.calls.create.map((call) => call.workflow.approvalPolicy),
    [
      {
        mode: "internal_auto",
        configuredBy: { id: ACTORS.manager.id, role: ACTORS.manager.role },
      },
      {
        mode: "internal_auto",
        configuredBy: { id: ACTORS.staff.id, role: ACTORS.staff.role },
      },
    ],
  );

  const managerCreated = await fixture.request("/api/content/pipelines", {
    actor: ACTORS.manager,
    method: "POST",
    body: { brief: EXACT_BRIEF, workflow: { mode: "manual" } },
  });
  const staffCreated = await fixture.request("/api/content/pipelines", {
    actor: ACTORS.staff,
    method: "POST",
    body: { brief: EXACT_BRIEF },
  });
  assert.equal(
    managerCreated.status,
    202,
    JSON.stringify(managerCreated.payload),
  );
  assert.equal(staffCreated.status, 202, JSON.stringify(staffCreated.payload));
  assert.deepEqual(
    fixture.calls.create
      .slice(2)
      .map((call) => [
        call.createdBy,
        call.workflow.mode,
        call.workflow.approvalPolicy,
      ]),
    [
      [ACTORS.manager.id, "manual", undefined],
      [ACTORS.staff.id, "copilot", undefined],
    ],
  );
});

test("list与detail同时执行租户隔离和账号数据范围", async (t) => {
  const fixture = await routeServer(t);
  const bossOwned = fixture.seed({ id: 1_101, createdBy: ACTORS.boss.id });
  const staffOwned = fixture.seed({ id: 1_102, createdBy: ACTORS.staff.id });
  const peerOwned = fixture.seed({ id: 1_103, createdBy: ACTORS.peer.id });
  const otherTenant = fixture.seed({
    id: 1_201,
    tenantId: ACTORS.otherBoss.tenant_id,
    createdBy: ACTORS.otherBoss.id,
  });

  const bossList = await fixture.request("/api/content/pipelines");
  assert.equal(bossList.status, 200);
  assert.deepEqual(
    bossList.payload.pipelines.map((item) => item.id).sort((a, b) => a - b),
    [bossOwned.id, staffOwned.id, peerOwned.id],
  );

  const staffList = await fixture.request("/api/content/pipelines", {
    actor: ACTORS.staff,
  });
  assert.equal(staffList.status, 200);
  assert.deepEqual(
    staffList.payload.pipelines.map((item) => item.id),
    [staffOwned.id],
  );

  const managerList = await fixture.request("/api/content/pipelines", {
    actor: ACTORS.manager,
  });
  assert.equal(managerList.status, 200);
  assert.deepEqual(
    managerList.payload.pipelines.map((item) => item.id),
    [staffOwned.id],
  );

  const ownDetail = await fixture.request(
    `/api/content/pipelines/${staffOwned.id}`,
    { actor: ACTORS.staff },
  );
  const peerDetail = await fixture.request(
    `/api/content/pipelines/${peerOwned.id}`,
    { actor: ACTORS.staff },
  );
  const managerDetail = await fixture.request(
    `/api/content/pipelines/${staffOwned.id}`,
    {
      actor: ACTORS.manager,
    },
  );
  const managerPeerDenied = await fixture.request(
    `/api/content/pipelines/${peerOwned.id}`,
    {
      actor: ACTORS.manager,
    },
  );
  const crossTenantDetail = await fixture.request(
    `/api/content/pipelines/${otherTenant.id}`,
  );
  assert.equal(ownDetail.status, 200);
  assert.equal(ownDetail.payload.pipeline.id, staffOwned.id);
  assert.equal(peerDetail.status, 403);
  assert.equal(peerDetail.payload.code, "CONTENT_PIPELINE_ACCESS_FORBIDDEN");
  assert.equal(managerDetail.status, 200);
  assert.equal(managerDetail.payload.pipeline.id, staffOwned.id);
  assert.equal(managerPeerDenied.status, 403);
  assert.equal(crossTenantDetail.status, 404);
  assert.equal(crossTenantDetail.payload.code, "CONTENT_PIPELINE_NOT_FOUND");
});

test("artifact详情只给安全元数据；billing_pending可授权预览下载但不可标为最终可用", async (t) => {
  const fixture = await routeServer(t);
  const pipelineId = 1_250;
  const artifactId = 9_001;
  const content = "<main>可信交付</main><script>window.evil=true</script>";
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  const artifact = {
    id: artifactId,
    tenantId: ACTORS.staff.tenant_id,
    pipelineId,
    stationIdx: 7,
    stationAttempt: 1,
    artifactIndex: 0,
    kind: "html",
    primary: true,
    filename: "deck.html",
    mediaType: "text/html",
    byteSize: Buffer.byteLength(content, "utf8"),
    sha256,
    content,
  };
  fixture.seed({
    id: pipelineId,
    createdBy: ACTORS.staff.id,
    status: "billing_pending",
    currentStation: 7,
    stations: [
      {
        pipelineId,
        tenantId: ACTORS.staff.tenant_id,
        stationIdx: 7,
        employeeKey: "deck",
        status: "billing_pending",
        attempt: 1,
        output: { summary: "演绎稿已保存" },
        artifacts: [{ ...artifact, content: undefined }],
      },
    ],
  });
  fixture.seedArtifact(artifact);

  const detail = await fixture.request(`/api/content/pipelines/${pipelineId}`, {
    actor: ACTORS.staff,
  });
  assert.equal(detail.status, 200, JSON.stringify(detail.payload));
  const metadata = detail.payload.pipeline.stations[0].artifacts[0];
  assert.equal(Object.hasOwn(metadata, "content"), false);
  assert.equal(Object.hasOwn(metadata, "tenantId"), false);
  assert.equal(metadata.availability, "billing_pending");
  assert.equal(metadata.finalUsable, false);
  assert.equal(metadata.sha256, sha256);
  assert.match(metadata.previewUrl, /\/preview$/u);
  assert.match(metadata.downloadUrl, /\/download$/u);

  const preview = await fixture.request(metadata.previewUrl, {
    actor: ACTORS.staff,
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.payload, content);
  assert.match(preview.headers.get("content-type"), /^text\/plain/u);
  assert.equal(preview.headers.get("x-original-content-type"), "text/html");
  assert.equal(preview.headers.get("x-artifact-final-usable"), "false");
  assert.match(preview.headers.get("content-security-policy"), /sandbox/u);
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");

  const download = await fixture.request(metadata.downloadUrl, {
    actor: ACTORS.manager,
  });
  assert.equal(download.status, 200);
  assert.equal(download.payload, content);
  assert.match(download.headers.get("content-disposition"), /^attachment;/u);
  assert.match(download.headers.get("content-type"), /^text\/html/u);

  const sameTenantDenied = await fixture.request(metadata.previewUrl, {
    actor: ACTORS.peer,
  });
  assert.equal(sameTenantDenied.status, 403);
  assert.equal(
    sameTenantDenied.payload.code,
    "CONTENT_PIPELINE_ACCESS_FORBIDDEN",
  );
  const crossTenant = await fixture.request(metadata.downloadUrl, {
    actor: ACTORS.otherBoss,
  });
  assert.equal(crossTenant.status, 404);
  assert.equal(crossTenant.payload.code, "CONTENT_PIPELINE_NOT_FOUND");
});

test("provider图片从material安全投影到工位与发布包，只能通过租户内端点预览下载", async (t) => {
  const fixture = await routeServer(t);
  const pipelineId = 1_251;
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const bodySnapshot = `data:image/png;base64,${png.toString("base64")}`;
  const snapshotHash = createHash("sha256").update(png).digest("hex");
  const artifactSnapshot = {
    schemaVersion: "nanowork.content-pipeline-provider-artifact/2",
    kind: "image",
    employeeIdx: 5,
    pipelineId,
    artifactIndex: 0,
    mimeType: "image/png",
    byteSize: png.length,
    contentSha256: snapshotHash,
  };
  const materialId = runWithTenant(ACTORS.staff.tenant_id, () =>
    Number(
      db
        .prepare(
          `INSERT INTO materials(
    tenant_id,name,type,tags,url,source_type,source_id,creator_id,note,
    body_snapshot,artifact_snapshot_json,snapshot_hash
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          ACTORS.staff.tenant_id,
          "小红书竖版配图1",
          "图片",
          "[]",
          "https://cdn.example.com/private.png?token=must-not-leak",
          "content_pipeline_provider",
          pipelineId,
          ACTORS.staff.id,
          "仅租户内产物",
          bodySnapshot,
          JSON.stringify(artifactSnapshot),
          snapshotHash,
        ).lastInsertRowid,
    ),
  );
  t.after(() => db.prepare("DELETE FROM materials WHERE id=?").run(materialId));

  const providerEvidence = {
    productionRuntime: {
      specialRuntime: {
        bridge: {
          attempts: [
            {
              delivery: {
                persisted: true,
                artifactIds: [`material:${materialId}`],
              },
            },
          ],
        },
      },
    },
  };
  fixture.seed({
    id: pipelineId,
    createdBy: ACTORS.staff.id,
    status: "awaiting_approval",
    currentStation: 8,
    pendingStation: 8,
    stations: [
      {
        pipelineId,
        tenantId: ACTORS.staff.tenant_id,
        stationIdx: 5,
        employeeKey: "media",
        status: "completed",
        attempt: 1,
        output: { image_plan: [{ slot: "首图" }] },
        handlerEvidence: providerEvidence,
      },
      {
        pipelineId,
        tenantId: ACTORS.staff.tenant_id,
        stationIdx: 8,
        employeeKey: "publish",
        status: "awaiting_approval",
        attempt: 1,
        output: { package: "小红书发布包" },
        approvalBoundary: { code: "force" },
      },
    ],
  });

  const detail = await fixture.request(`/api/content/pipelines/${pipelineId}`, {
    actor: ACTORS.staff,
  });
  assert.equal(detail.status, 200, JSON.stringify(detail.payload));
  assert.doesNotMatch(
    JSON.stringify(detail.payload),
    /must-not-leak|cdn\.example\.com/u,
  );
  const station5Asset = detail.payload.pipeline.stations.find(
    (station) => station.stationIdx === 5,
  ).providerAssets[0];
  assert.deepEqual(
    {
      id: station5Asset.id,
      sourceStationIdx: station5Asset.sourceStationIdx,
      kind: station5Asset.kind,
      mediaType: station5Asset.mediaType,
      availability: station5Asset.availability,
      finalUsable: station5Asset.finalUsable,
    },
    {
      id: materialId,
      sourceStationIdx: 5,
      kind: "image",
      mediaType: "image/png",
      availability: "final",
      finalUsable: true,
    },
  );
  assert.match(
    station5Asset.previewUrl,
    new RegExp(`/provider-assets/${materialId}/preview$`, "u"),
  );
  assert.match(
    station5Asset.downloadUrl,
    new RegExp(`/provider-assets/${materialId}/download$`, "u"),
  );

  const station8Asset = detail.payload.pipeline.stations.find(
    (station) => station.stationIdx === 8,
  ).providerAssets[0];
  assert.equal(station8Asset.id, materialId);
  assert.equal(station8Asset.sourceStationIdx, 5);
  assert.equal(station8Asset.projectedIntoPublishPackage, true);
  assert.equal(station8Asset.availability, "awaiting_approval");
  assert.equal(station8Asset.finalUsable, false);
  assert.notEqual(station8Asset.previewUrl, station5Asset.previewUrl);
  assert.match(station8Asset.previewUrl, /\/stations\/8\/provider-assets\//u);

  const publishPackagePreview = await fixture.request(
    station8Asset.previewUrl,
    {
      actor: ACTORS.staff,
    },
  );
  assert.equal(
    publishPackagePreview.status,
    200,
    JSON.stringify(publishPackagePreview.payload),
  );
  assert.deepEqual(publishPackagePreview.payload, png);
  assert.equal(
    publishPackagePreview.headers.get("x-provider-asset-final-usable"),
    "false",
  );

  const preview = await fixture.request(station5Asset.previewUrl, {
    actor: ACTORS.staff,
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.payload, png);
  assert.match(preview.headers.get("content-type"), /^image\/png/u);
  assert.equal(preview.headers.get("cache-control"), "private, no-store");
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
  assert.equal(preview.headers.get("x-provider-asset-final-usable"), "true");

  const download = await fixture.request(station5Asset.downloadUrl, {
    actor: ACTORS.manager,
  });
  assert.equal(download.status, 200);
  assert.deepEqual(download.payload, png);
  assert.match(download.headers.get("content-disposition"), /^attachment;/u);

  const peerDenied = await fixture.request(station5Asset.previewUrl, {
    actor: ACTORS.peer,
  });
  assert.equal(peerDenied.status, 403);
  const otherTenantDenied = await fixture.request(station5Asset.downloadUrl, {
    actor: ACTORS.otherBoss,
  });
  assert.equal(otherTenantDenied.status, 404);
});

test("provider material证据、归属、快照完整性或安全URL任一失败即禁止读取", async (t) => {
  const fixture = await routeServer(t);
  const pipelineId = 1_252;
  const makeMaterial = ({
    sourceType = "content_pipeline_provider",
    sourceId = pipelineId,
    bodySnapshot = "",
    url = "https://images.example.com/safe.png",
    snapshotHash,
  } = {}) => {
    const source = bodySnapshot
      ? Buffer.from(String(bodySnapshot).split(",")[1] || "", "base64")
      : url;
    return Number(
      db
        .prepare(
          `INSERT INTO materials(
      tenant_id,name,type,tags,url,source_type,source_id,creator_id,note,
      body_snapshot,artifact_snapshot_json,snapshot_hash
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          ACTORS.staff.tenant_id,
          "待校验图片",
          "图片",
          "[]",
          url,
          sourceType,
          sourceId,
          ACTORS.staff.id,
          "",
          bodySnapshot || null,
          JSON.stringify({
            schemaVersion: "nanowork.content-pipeline-provider-artifact/2",
            kind: "image",
            employeeIdx: 5,
            pipelineId,
            artifactIndex: 0,
            mimeType: "image/png",
          }),
          snapshotHash || createHash("sha256").update(source).digest("hex"),
        ).lastInsertRowid,
    );
  };
  const noEvidenceId = makeMaterial();
  const wrongSourceId = makeMaterial({ sourceType: "content_employee_run" });
  const wrongPipelineId = makeMaterial({ sourceId: pipelineId + 1 });
  const tamperedId = makeMaterial({
    bodySnapshot: "data:image/png;base64,aW1hZ2U=",
    snapshotHash: "a".repeat(64),
  });
  const invalidBase64Id = makeMaterial({
    bodySnapshot: "data:image/png;base64,%%%",
  });
  const mimeMismatchId = makeMaterial({
    bodySnapshot: "data:image/jpeg;base64,aW1hZ2U=",
  });
  const disguisedHtmlId = makeMaterial({
    bodySnapshot: `data:image/png;base64,${Buffer.from("<html>not an image</html>", "utf8").toString("base64")}`,
  });
  const unsafeUrlId = makeMaterial({ url: "http://127.0.0.1:3109/private" });
  const ids = [
    noEvidenceId,
    wrongSourceId,
    wrongPipelineId,
    tamperedId,
    invalidBase64Id,
    mimeMismatchId,
    disguisedHtmlId,
    unsafeUrlId,
  ];
  t.after(() =>
    db
      .prepare(
        `DELETE FROM materials WHERE id IN (${ids.map(() => "?").join(",")})`,
      )
      .run(...ids),
  );
  const evidenceIds = [
    wrongSourceId,
    wrongPipelineId,
    tamperedId,
    invalidBase64Id,
    mimeMismatchId,
    disguisedHtmlId,
    unsafeUrlId,
  ];
  fixture.seed({
    id: pipelineId,
    createdBy: ACTORS.staff.id,
    status: "completed",
    currentStation: 9,
    stations: [
      {
        pipelineId,
        tenantId: ACTORS.staff.tenant_id,
        stationIdx: 5,
        employeeKey: "media",
        status: "completed",
        handlerEvidence: {
          productionRuntime: {
            specialRuntime: {
              bridge: {
                attempts: [
                  {
                    delivery: {
                      persisted: true,
                      artifactIds: evidenceIds.map((id) => `material:${id}`),
                    },
                  },
                ],
              },
            },
          },
        },
      },
    ],
  });

  const missingEvidence = await fixture.request(
    `/api/content/pipelines/${pipelineId}/stations/5/provider-assets/${noEvidenceId}/preview`,
    { actor: ACTORS.staff },
  );
  assert.equal(missingEvidence.status, 404);
  assert.equal(
    missingEvidence.payload.code,
    "CONTENT_PIPELINE_PROVIDER_ASSET_NOT_FOUND",
  );

  for (const materialId of [wrongSourceId, wrongPipelineId]) {
    const denied = await fixture.request(
      `/api/content/pipelines/${pipelineId}/stations/5/provider-assets/${materialId}/preview`,
      { actor: ACTORS.staff },
    );
    assert.equal(denied.status, 404, JSON.stringify(denied.payload));
    assert.equal(
      denied.payload.code,
      "CONTENT_PIPELINE_PROVIDER_ASSET_NOT_FOUND",
    );
  }
  const tampered = await fixture.request(
    `/api/content/pipelines/${pipelineId}/stations/5/provider-assets/${tamperedId}/preview`,
    { actor: ACTORS.staff },
  );
  assert.equal(tampered.status, 409);
  assert.equal(
    tampered.payload.code,
    "CONTENT_PIPELINE_PROVIDER_ASSET_INTEGRITY_FAILED",
  );

  for (const materialId of [invalidBase64Id, mimeMismatchId, disguisedHtmlId]) {
    const invalidSnapshot = await fixture.request(
      `/api/content/pipelines/${pipelineId}/stations/5/provider-assets/${materialId}/preview`,
      { actor: ACTORS.staff },
    );
    assert.equal(
      invalidSnapshot.status,
      409,
      JSON.stringify(invalidSnapshot.payload),
    );
    assert.equal(
      invalidSnapshot.payload.code,
      "CONTENT_PIPELINE_PROVIDER_ASSET_INTEGRITY_FAILED",
    );
  }

  const unsafe = await fixture.request(
    `/api/content/pipelines/${pipelineId}/stations/5/provider-assets/${unsafeUrlId}/preview`,
    { actor: ACTORS.staff },
  );
  assert.equal(unsafe.status, 409);
  assert.equal(
    unsafe.payload.code,
    "CONTENT_PIPELINE_PROVIDER_ASSET_URL_UNSAFE",
  );
});

test("awaiting_metrics不能走普通审批，老板或管理层回传真实指标后才排队恢复复盘", async (t) => {
  const fixture = await routeServer(t);
  const target = fixture.seed({
    id: 1_299,
    createdBy: ACTORS.staff.id,
    status: "awaiting_metrics",
    currentStation: 9,
    pendingStation: 9,
    task: { ...EXACT_BRIEF, platforms: ["小红书"] },
    stations: [
      {
        pipelineId: 1_299,
        tenantId: ACTORS.staff.tenant_id,
        stationIdx: 9,
        employeeKey: "retro",
        status: "awaiting_metrics",
        attempt: 0,
        output: null,
        approvalBoundary: { code: "await_metrics" },
        artifacts: [
          {
            id: 9_299,
            pipelineId: 1_299,
            stationIdx: 9,
            kind: "markdown",
            primary: true,
            filename: "legacy-retro.md",
            mediaType: "text/markdown",
            byteSize: 18,
            sha256: "a".repeat(64),
          },
        ],
      },
    ],
  });

  const detail = await fixture.request(`/api/content/pipelines/${target.id}`, {
    actor: ACTORS.manager,
  });
  const legacyArtifact = detail.payload.pipeline.stations[0].artifacts[0];
  assert.equal(legacyArtifact.availability, "awaiting_metrics");
  assert.equal(legacyArtifact.finalUsable, false);

  const review = await fixture.request(
    `/api/content/pipelines/${target.id}/review`,
    {
      actor: ACTORS.manager,
      method: "POST",
      body: { action: "approve" },
    },
  );
  assert.equal(review.status, 422, JSON.stringify(review.payload));
  assert.equal(review.payload.code, "CONTENT_PIPELINE_METRICS_REQUIRED");
  assert.equal(fixture.calls.review.length, 0);

  const denied = await fixture.request(
    `/api/content/pipelines/${target.id}/metrics`,
    {
      actor: ACTORS.staff,
      method: "POST",
      body: {
        publication: {
          platform: "小红书",
          url: "https://www.xiaohongshu.com/explore/real-note",
          publishedAt: "2026-08-01T00:00:00.000Z",
        },
        metrics: { views: 2888 },
      },
    },
  );
  assert.equal(denied.status, 403, JSON.stringify(denied.payload));
  assert.equal(denied.payload.code, "CONTENT_PIPELINE_METRICS_ROLE_FORBIDDEN");
  assert.equal(fixture.calls.submitMetrics.length, 0);

  const accepted = await fixture.request(
    `/api/content/pipelines/${target.id}/metrics`,
    {
      actor: ACTORS.manager,
      method: "POST",
      body: {
        publication: {
          platform: "小红书",
          url: "https://www.xiaohongshu.com/explore/real-note",
          publishedAt: "2026-08-01T00:00:00.000Z",
        },
        metrics: { views: 2888, comments: 21 },
        evidenceNote: "平台创作者中心截图已核对",
      },
    },
  );
  assert.equal(accepted.status, 202, JSON.stringify(accepted.payload));
  assert.equal(accepted.payload.queued, true);
  assert.equal(accepted.payload.pollUrl, `/content/pipelines/${target.id}`);
  assert.deepEqual(fixture.calls.submitMetrics.at(-1), {
    tenantId: ACTORS.manager.tenant_id,
    pipelineId: target.id,
    actor: { ...ACTORS.manager, status: "启用" },
    publication: {
      platform: "小红书",
      url: "https://www.xiaohongshu.com/explore/real-note",
      publishedAt: "2026-08-01T00:00:00.000Z",
    },
    metrics: { views: 2888, comments: 21 },
    evidenceNote: "平台创作者中心截图已核对",
  });
  assert.equal(fixture.scheduled.length, 1);
  await fixture.flushNext();
  assert.equal(fixture.calls.resume.at(-1).pipelineId, target.id);
});

test("多平台指标首条只累计不排队，最后一个目标平台提交后才恢复复盘", async (t) => {
  const fixture = await routeServer(t);
  const target = fixture.seed({
    id: 1_300,
    createdBy: ACTORS.boss.id,
    status: "awaiting_metrics",
    currentStation: 9,
    pendingStation: 9,
    task: { ...EXACT_BRIEF, platforms: ["小红书", "视频号"] },
    stations: [
      {
        pipelineId: 1_300,
        tenantId: ACTORS.boss.tenant_id,
        stationIdx: 9,
        employeeKey: "retro",
        status: "awaiting_metrics",
        attempt: 0,
        output: null,
        approvalBoundary: { code: "await_metrics" },
      },
    ],
  });

  const first = await fixture.request(
    `/api/content/pipelines/${target.id}/metrics`,
    {
      method: "POST",
      body: {
        publication: {
          platform: "小红书",
          url: "https://www.xiaohongshu.com/explore/first",
          publishedAt: "2026-08-01T00:00:00.000Z",
        },
        metrics: { views: 100 },
      },
    },
  );
  assert.equal(first.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.queued, false);
  assert.equal(first.payload.pipeline.status, "awaiting_metrics");
  assert.deepEqual(
    first.payload.pipeline.workflow.publicationMetrics.missingPlatforms,
    ["视频号"],
  );
  assert.equal(fixture.scheduled.length, 0);

  const second = await fixture.request(
    `/api/content/pipelines/${target.id}/metrics`,
    {
      method: "POST",
      body: {
        publication: {
          platform: "视频号",
          url: "https://channels.weixin.qq.com/web/pages/feed",
          publishedAt: "2026-08-01T00:00:01.000Z",
        },
        metrics: { views: 88 },
      },
    },
  );
  assert.equal(second.status, 202, JSON.stringify(second.payload));
  assert.equal(second.payload.queued, true);
  assert.equal(second.payload.pipeline.status, "running");
  assert.deepEqual(
    second.payload.pipeline.workflow.publicationMetrics.missingPlatforms,
    [],
  );
  assert.equal(fixture.scheduled.length, 1);
});

test("review拒绝非法action并保持approve与reject的HTTP排队契约", async (t) => {
  const fixture = await routeServer(t);
  const invalidTarget = fixture.seed({
    id: 1_301,
    status: "awaiting_approval",
    currentStation: 3,
    pendingStation: 3,
  });
  const invalid = await fixture.request(
    `/api/content/pipelines/${invalidTarget.id}/review`,
    {
      method: "POST",
      body: { action: "publish" },
    },
  );
  assert.equal(invalid.status, 400, JSON.stringify(invalid.payload));
  assert.equal(fixture.calls.review.length, 0);

  const missingAction = await fixture.request(
    `/api/content/pipelines/${invalidTarget.id}/review`,
    { method: "POST", body: {} },
  );
  assert.equal(
    missingAction.status,
    400,
    JSON.stringify(missingAction.payload),
  );
  assert.equal(fixture.calls.review.length, 0);

  const approveTarget = fixture.seed({
    id: 1_302,
    status: "awaiting_approval",
    currentStation: 5,
    pendingStation: 5,
  });
  const approved = await fixture.request(
    `/api/content/pipelines/${approveTarget.id}/review`,
    {
      method: "POST",
      body: {
        action: "approve",
        selection: { candidateIndex: 1 },
        resumeAfterApproval: true,
      },
    },
  );
  assert.equal(approved.status, 202, JSON.stringify(approved.payload));
  assert.equal(approved.payload.queued, true);
  assert.deepEqual(fixture.calls.review.at(-1), {
    tenantId: ACTORS.boss.tenant_id,
    pipelineId: approveTarget.id,
    actor: { ...ACTORS.boss, status: "启用" },
    action: "approve",
    selection: { candidateIndex: 1 },
    resumeAfterApproval: false,
  });
  assert.match(String(fixture.calls.logs.at(-1)?.[3] || ""), /station#5/u);

  const rejectTarget = fixture.seed({
    id: 1_303,
    status: "awaiting_approval",
    currentStation: 8,
    pendingStation: 8,
  });
  const rejected = await fixture.request(
    `/api/content/pipelines/${rejectTarget.id}/review`,
    {
      method: "POST",
      body: { action: "reject" },
    },
  );
  assert.equal(rejected.status, 200, JSON.stringify(rejected.payload));
  assert.equal(rejected.payload.queued, false);
  assert.equal(rejected.payload.pipeline.status, "rejected");

  const staffDenied = await fixture.request(
    `/api/content/pipelines/${invalidTarget.id}/review`,
    {
      actor: ACTORS.staff,
      method: "POST",
      body: { action: "approve" },
    },
  );
  assert.equal(staffDenied.status, 403);
  assert.equal(staffDenied.payload.code, "CONTENT_PIPELINE_ACCESS_FORBIDDEN");
});

test("retry、recover与resume保持可轮询的HTTP契约且只运行fake runtime", async (t) => {
  const fixture = await routeServer(t);

  const failed = fixture.seed({
    id: 1_401,
    status: "failed",
    currentStation: 2,
  });
  const retry = await fixture.request(
    `/api/content/pipelines/${failed.id}/retry`,
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(retry.status, 202, JSON.stringify(retry.payload));
  assert.equal(retry.payload.queued, true);
  assert.equal(retry.payload.pipeline.status, "failed");
  assert.equal(
    Object.hasOwn(retry.payload.pipeline.task, "visual_policy_version"),
    false,
  );
  await fixture.flushNext();
  assert.deepEqual(fixture.calls.retry.at(-1), {
    tenantId: ACTORS.boss.tenant_id,
    pipelineId: failed.id,
  });
  assert.equal(Object.hasOwn(failed.task, "visual_policy_version"), false);

  const staffFailed = fixture.seed({
    id: 1_406,
    createdBy: ACTORS.staff.id,
    status: "failed",
    currentStation: 2,
  });
  const retryDenied = await fixture.request(
    `/api/content/pipelines/${staffFailed.id}/retry`,
    {
      actor: ACTORS.staff,
      method: "POST",
      body: {},
    },
  );
  assert.equal(retryDenied.status, 403, JSON.stringify(retryDenied.payload));
  assert.equal(
    retryDenied.payload.code,
    "CONTENT_PIPELINE_RETRY_ROLE_FORBIDDEN",
  );
  assert.equal(fixture.calls.retry.length, 1);
  assert.equal(fixture.scheduled.length, 0);

  const notFailed = fixture.seed({
    id: 1_402,
    status: "running",
    currentStation: 1,
  });
  const retryRejected = await fixture.request(
    `/api/content/pipelines/${notFailed.id}/retry`,
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(retryRejected.status, 409);
  assert.equal(retryRejected.payload.code, "CONTENT_PIPELINE_NOT_FAILED");

  const interrupted = fixture.seed({
    id: 1_403,
    status: "running",
    currentStation: 4,
  });
  const recover = await fixture.request(
    `/api/content/pipelines/${interrupted.id}/recover`,
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(recover.status, 202, JSON.stringify(recover.payload));
  assert.equal(recover.payload.queued, true);
  assert.deepEqual(fixture.calls.recoverInterrupted.at(-1), {
    tenantId: ACTORS.boss.tenant_id,
    pipelineId: interrupted.id,
  });
  await fixture.flushNext();
  assert.deepEqual(fixture.calls.resume.at(-1), {
    tenantId: ACTORS.boss.tenant_id,
    pipelineId: interrupted.id,
  });

  const running = fixture.seed({
    id: 1_404,
    status: "running",
    currentStation: 6,
  });
  const resume = await fixture.request(
    `/api/content/pipelines/${running.id}/resume`,
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(resume.status, 202, JSON.stringify(resume.payload));
  assert.equal(resume.payload.queued, true);
  await fixture.flushNext();
  assert.deepEqual(fixture.calls.resume.at(-1), {
    tenantId: ACTORS.boss.tenant_id,
    pipelineId: running.id,
  });

  const completed = fixture.seed({
    id: 1_405,
    status: "completed",
    currentStation: 10,
  });
  const noQueue = await fixture.request(
    `/api/content/pipelines/${completed.id}/resume`,
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(noQueue.status, 200, JSON.stringify(noQueue.payload));
  assert.equal(noQueue.payload.queued, false);
  assert.equal(fixture.scheduled.length, 0);
});

test("internal_auto停在await_metrics时继续运行会排队恢复预测性复盘", async (t) => {
  const fixture = await routeServer(t);
  const target = fixture.seed({
    id: 1_301,
    createdBy: ACTORS.boss.id,
    status: "awaiting_metrics",
    currentStation: 9,
    pendingStation: 9,
    workflow: {
      mode: "fullauto",
      approvalPolicy: { mode: "internal_auto" },
    },
    stations: [
      {
        pipelineId: 1_301,
        tenantId: ACTORS.boss.tenant_id,
        stationIdx: 9,
        employeeKey: "retro",
        status: "awaiting_metrics",
        attempt: 0,
        output: null,
        approvalBoundary: { code: "await_metrics" },
      },
    ],
  });

  const resumed = await fixture.request(
    `/api/content/pipelines/${target.id}/resume`,
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(resumed.status, 202, JSON.stringify(resumed.payload));
  assert.equal(resumed.payload.queued, true);
  await fixture.flushNext();
  assert.equal(fixture.calls.resume.at(-1).pipelineId, target.id);
});

test("失败重试、中断恢复和继续运行遇到未释放hold时都禁止重跑provider", async (t) => {
  const fixture = await routeServer(t);
  const failed = fixture.seed({
    id: 1_490,
    status: "failed",
    currentStation: 1,
  });
  const failedRefId = failed.id * 10 + failed.currentStation + 1;
  db.prepare(
    `INSERT INTO credit_holds(
    id,tenant_id,status,held_credits,settled_credits,ref_type,ref_id
  ) VALUES(?,?,?,?,?,?,?)`,
  ).run(
    90_001,
    ACTORS.boss.tenant_id,
    "held",
    88,
    null,
    "content_production_pipeline_station",
    failedRefId,
  );

  const retry = await fixture.request(
    `/api/content/pipelines/${failed.id}/retry`,
    { method: "POST", body: {} },
  );
  assert.equal(retry.status, 409, JSON.stringify(retry.payload));
  assert.equal(
    retry.payload.code,
    "CONTENT_PIPELINE_BILLING_PENDING_RECONCILIATION",
  );
  assert.equal(fixture.calls.retry.length, 0);
  assert.equal(fixture.scheduled.length, 0);

  const running = fixture.seed({
    id: 1_491,
    status: "running",
    currentStation: 3,
  });
  const runningRefId = running.id * 10 + running.currentStation + 1;
  db.prepare(
    `INSERT INTO credit_holds(
    id,tenant_id,status,held_credits,settled_credits,ref_type,ref_id
  ) VALUES(?,?,?,?,?,?,?)`,
  ).run(
    90_002,
    ACTORS.boss.tenant_id,
    "held",
    99,
    null,
    "content_production_pipeline_station",
    runningRefId,
  );

  const recover = await fixture.request(
    `/api/content/pipelines/${running.id}/recover`,
    { method: "POST", body: {} },
  );
  assert.equal(recover.status, 409, JSON.stringify(recover.payload));
  assert.equal(
    recover.payload.code,
    "CONTENT_PIPELINE_BILLING_PENDING_RECONCILIATION",
  );
  assert.equal(fixture.calls.recoverInterrupted.length, 0);

  const resume = await fixture.request(
    `/api/content/pipelines/${running.id}/resume`,
    { method: "POST", body: {} },
  );
  assert.equal(resume.status, 409, JSON.stringify(resume.payload));
  assert.equal(
    resume.payload.code,
    "CONTENT_PIPELINE_BILLING_PENDING_RECONCILIATION",
  );
  assert.equal(fixture.calls.resume.length, 0);
  assert.equal(fixture.scheduled.length, 0);

  db.prepare("DELETE FROM credit_holds WHERE id IN (?,?)").run(90_001, 90_002);
});

test("待审队列只投影管理范围内流水线并精确返回当前人可审能力", async (t) => {
  const fixture = await routeServer(t);
  const station = (pipelineId, stationIdx, code, tenantId = 11) => ({
    pipelineId,
    tenantId,
    stationIdx,
    employeeKey: `station-${stationIdx}`,
    employeeName: stationIdx === 8 ? "分发官" : "撰稿人",
    status: "awaiting_approval",
    approvalBoundary: { code },
    artifacts: [],
  });
  fixture.seed({
    id: 1_501,
    createdBy: ACTORS.staff.id,
    title: "下属普通待审",
    status: "awaiting_approval",
    currentStation: 3,
    pendingStation: 3,
    stations: [station(1_501, 3, "review")],
  });
  fixture.seed({
    id: 1_502,
    createdBy: ACTORS.staff.id,
    title: "下属强制终审",
    status: "awaiting_approval",
    currentStation: 8,
    pendingStation: 8,
    stations: [station(1_502, 8, "force")],
  });
  fixture.seed({
    id: 1_503,
    createdBy: ACTORS.peerManager.id,
    title: "同级经理待审",
    status: "awaiting_approval",
    currentStation: 3,
    pendingStation: 3,
    stations: [station(1_503, 3, "review")],
  });
  fixture.seed({
    id: 2_501,
    tenantId: ACTORS.otherBoss.tenant_id,
    createdBy: ACTORS.otherBoss.id,
    title: "其他租户待审",
    status: "awaiting_approval",
    currentStation: 8,
    pendingStation: 8,
    stations: [station(2_501, 8, "force", 12)],
  });

  const managerQueue = await fixture.request(
    "/api/content/pipelines/pending-reviews",
    { actor: ACTORS.manager },
  );
  assert.equal(managerQueue.status, 200, JSON.stringify(managerQueue.payload));
  assert.equal(
    managerQueue.payload.schemaVersion,
    "nanowork.content-pipeline-pending-reviews/1",
  );
  assert.deepEqual(
    managerQueue.payload.reviews.map((item) => item.pipelineId),
    [1_501, 1_502],
  );
  assert.deepEqual(
    managerQueue.payload.reviews.map((item) => item.canReview),
    [true, false],
  );
  assert.equal(
    managerQueue.payload.reviews[1].reviewBlockedReason,
    "该工位必须由老板或管理员终审",
  );
  assert.deepEqual(managerQueue.payload.reviews[1].approvalBoundary, {
    code: "force",
    label: "老板/管理员终审",
  });
  assert.deepEqual(managerQueue.payload.reviews[0].creator, {
    id: ACTORS.staff.id,
    name: ACTORS.staff.name,
    role: ACTORS.staff.role,
  });

  const staffQueue = await fixture.request(
    "/api/content/pipelines/pending-reviews",
    { actor: ACTORS.staff },
  );
  assert.deepEqual(staffQueue.payload.reviews, []);
  assert.equal(staffQueue.payload.total, 0);

  const bossQueue = await fixture.request(
    "/api/content/pipelines/pending-reviews",
    { actor: ACTORS.boss },
  );
  assert.deepEqual(
    bossQueue.payload.reviews.map((item) => item.pipelineId),
    [1_501, 1_502, 1_503],
  );
  assert.equal(
    bossQueue.payload.reviews.find((item) => item.pipelineId === 1_502)
      ?.canReview,
    true,
  );

  const otherTenantQueue = await fixture.request(
    "/api/content/pipelines/pending-reviews",
    { actor: ACTORS.otherBoss },
  );
  assert.deepEqual(
    otherTenantQueue.payload.reviews.map((item) => item.pipelineId),
    [2_501],
  );
});

test("force只通知本租户老板管理员，普通待审只通知有权管理链", async (t) => {
  const fixture = await routeServer(t);
  const force = fixture.seed({
    id: 1_601,
    createdBy: ACTORS.manager.id,
    title: "管理层创建的发布包",
    status: "running",
    currentStation: 8,
  });
  fixture.setResumeUpdate(force.id, {
    status: "awaiting_approval",
    pendingStation: 8,
    stations: [
      {
        pipelineId: force.id,
        tenantId: 11,
        stationIdx: 8,
        employeeKey: "publish",
        employeeName: "分发官",
        status: "awaiting_approval",
        approvalBoundary: { code: "force" },
        artifacts: [],
      },
    ],
  });
  const queuedForce = await fixture.request(
    `/api/content/pipelines/${force.id}/resume`,
    { actor: ACTORS.manager, method: "POST", body: {} },
  );
  assert.equal(queuedForce.status, 202, JSON.stringify(queuedForce.payload));
  await fixture.flushNext();
  assert.deepEqual(
    fixture.calls.notifications.map((call) => call[0]),
    [ACTORS.boss.id, ACTORS.admin.id],
  );
  assert.ok(
    fixture.calls.notifications.every(
      (call) => call[4] === `/content?pipelineId=${force.id}`,
    ),
  );
  assert.ok(
    fixture.calls.notifications.every((call) => /待终审/u.test(call[2])),
  );

  const ordinary = fixture.seed({
    id: 1_602,
    createdBy: ACTORS.staff.id,
    title: "下属创建的初稿",
    status: "running",
    currentStation: 3,
  });
  fixture.setResumeUpdate(ordinary.id, {
    status: "awaiting_approval",
    pendingStation: 3,
    stations: [
      {
        pipelineId: ordinary.id,
        tenantId: 11,
        stationIdx: 3,
        employeeKey: "draft",
        employeeName: "撰稿人",
        status: "awaiting_approval",
        approvalBoundary: { code: "review" },
        artifacts: [],
      },
    ],
  });
  const queuedOrdinary = await fixture.request(
    `/api/content/pipelines/${ordinary.id}/resume`,
    { actor: ACTORS.staff, method: "POST", body: {} },
  );
  assert.equal(
    queuedOrdinary.status,
    202,
    JSON.stringify(queuedOrdinary.payload),
  );
  await fixture.flushNext();
  assert.deepEqual(
    fixture.calls.notifications.slice(2).map((call) => call[0]),
    [ACTORS.boss.id, ACTORS.manager.id, ACTORS.admin.id],
  );
  assert.ok(
    fixture.calls.notifications.every(
      (call) =>
        ![ACTORS.peerManager.id, ACTORS.otherBoss.id, 108].includes(call[0]),
    ),
  );
});

test("待审通知受众计算排除force经理、同级和停用账号", () => {
  const users = [
    { id: 1, role: "boss", status: "启用", manager_id: null },
    { id: 2, role: "manager", status: "启用", manager_id: 1 },
    { id: 3, role: "sales", status: "启用", manager_id: 2 },
    { id: 4, role: "manager", status: "启用", manager_id: 1 },
    { id: 5, role: "admin", status: "启用", manager_id: null },
    { id: 6, role: "manager", status: "停用", manager_id: 2 },
  ];
  assert.deepEqual(
    contentPipelineReviewAudienceIds({
      users,
      creatorId: 3,
      boundaryCode: "force",
    }),
    [1, 5],
  );
  assert.deepEqual(
    contentPipelineReviewAudienceIds({
      users,
      creatorId: 3,
      boundaryCode: "review",
    }),
    [1, 2, 5],
  );
});

test("管理端pause/resume/cancel返回数据库权威状态并保持租户边界", async (t) => {
  const fixture = await routeServer(t);
  fixture.seed({
    id: 1_701,
    createdBy: ACTORS.staff.id,
    status: "running",
    currentStation: 2,
    stations: [
      { stationIdx: 2, status: "running", output: null, artifacts: [] },
    ],
  });

  const paused = await fixture.request("/api/content/pipelines/1701/pause", {
    actor: ACTORS.manager,
    method: "POST",
    body: {},
  });
  assert.equal(paused.status, 200, JSON.stringify(paused.payload));
  assert.equal(paused.payload.pipeline.status, "paused");
  assert.equal(paused.payload.pipeline.stations[0].status, "paused");
  assert.equal(fixture.calls.pause.length, 1);

  const resumed = await fixture.request("/api/content/pipelines/1701/resume", {
    actor: ACTORS.manager,
    method: "POST",
    body: {},
  });
  assert.equal(resumed.status, 202, JSON.stringify(resumed.payload));
  assert.equal(resumed.payload.pipeline.status, "running");
  assert.equal(fixture.calls.resumePaused.length, 1);
  assert.equal(fixture.scheduled.length, 1);

  const cancelled = await fixture.request(
    "/api/content/pipelines/1701/cancel",
    { actor: ACTORS.manager, method: "POST", body: {} },
  );
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.payload));
  assert.equal(cancelled.payload.pipeline.status, "cancelled");
  assert.equal(cancelled.payload.pipeline.stations[0].status, "cancelled");
  assert.equal(fixture.calls.cancel.length, 1);

  const hidden = await fixture.request("/api/content/pipelines/1701/pause", {
    actor: ACTORS.otherBoss,
    method: "POST",
    body: {},
  });
  assert.equal(hidden.status, 404);
  assert.equal(fixture.calls.pause.length, 1);
});
