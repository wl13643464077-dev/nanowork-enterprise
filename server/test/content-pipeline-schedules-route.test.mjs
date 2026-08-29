import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import express from "express";

process.env.NANOWORK_DB = ":memory:";

const {
  createContentPipelineScheduleService,
  createSqliteContentPipelineScheduleRepository,
} = await import("../src/engines/content-pipeline-schedules.js");
const { createContentPipelineScheduleRouter } =
  await import("../src/routes/content-pipeline-schedules.js");
const { resolveContentStructuredBrief } =
  await import("../src/engines/content-structured-brief.js");

const EXACT_TASK = {
  direction: "每天跑一次0到9完整团队",
  template: "日更选题",
  industry: "企业服务",
  material: "离线约束",
  ref_link: "",
  platforms: ["小红书"],
  image_mode: "ai",
  image_count: 1,
  enable_deck: false,
  xhs_style: null,
  dy_style: null,
};

async function withServer(app, operation) {
  const server = await new Promise((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  try {
    const address = server.address();
    return await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  return { status: response.status, body: await response.json() };
}

test("计划CRUD与run-now共用同一pipeline create/resume链并返回稳定deepLink", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const repository = createSqliteContentPipelineScheduleRepository({ db });
  repository.ensureSchema();
  const calls = { create: [], resume: [] };
  let pipelineId = 900;
  const service = createContentPipelineScheduleService({
    repository,
    preflight: ({ schedule }) => ({ workflow: schedule.workflow }),
    findExistingPipeline: () => null,
    createPipeline: (input) => {
      calls.create.push(structuredClone(input));
      pipelineId += 1;
      return { id: pipelineId, tenantId: input.tenantId, status: "running" };
    },
    resumePipeline: (input) => {
      calls.resume.push(structuredClone(input));
      return { id: input.pipelineId, status: "completed" };
    },
  });
  const scheduled = [];
  const router = createContentPipelineScheduleRouter({
    service,
    profileStore: { load: () => ({ revision: 7, profile: {} }) },
    resolveBrief: ({ tenantId }) => ({
      paihuoBrief: EXACT_TASK,
      handlerContext: {
        profile: { persona: { tone: "结论先行" } },
        companyProfile: { brand: `tenant-${tenantId}` },
      },
      evidence: { fingerprint: `tenant-${tenantId}-brief` },
    }),
    scheduleFn: (task) => scheduled.push(task),
    runWithTenantFn: (_tenantId, task) => task(),
    logOpFn: () => {},
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 11, tenant_id: 1, role: "boss", name: "老板" };
    req.aiGuard = { defer: () => () => {} };
    next();
  });
  app.use("/api/content", router);

  await withServer(app, async (base) => {
    const created = await request(base, "/api/content/pipeline-schedules", {
      method: "POST",
      body: JSON.stringify({
        name: "每日完整团队",
        kind: "daily",
        atTime: "09:00",
        brief: { direction: EXACT_TASK.direction },
        workflow: {
          mode: "fullauto",
          approvalPolicy: { mode: "custom", reviewStations: [] },
          paidMediaAuthorized: false,
        },
      }),
    });
    assert.equal(created.status, 201);
    const scheduleId = created.body.schedule.id;
    assert.deepEqual(created.body.schedule.task, EXACT_TASK);
    assert.equal(created.body.schedule.persona.tone, "结论先行");
    assert.equal(
      created.body.schedule.settings.companyProfile.brand,
      "tenant-1",
    );

    const listed = await request(base, "/api/content/pipeline-schedules");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.schedules.length, 1);

    const updated = await request(
      base,
      `/api/content/pipeline-schedules/${scheduleId}`,
      {
        method: "PUT",
        body: JSON.stringify({ kind: "interval", everyHours: 12 }),
      },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.schedule.human, "每 12 小时");

    const run = await request(
      base,
      `/api/content/pipeline-schedules/${scheduleId}/run-now`,
      {
        method: "POST",
        body: "{}",
      },
    );
    assert.equal(run.status, 202);
    assert.equal(run.body.pipeline.id, 901);
    assert.equal(run.body.deepLink, "/content?pipelineId=901");
    assert.equal(calls.create.length, 1);
    assert.equal(
      calls.create[0].settings.scheduleOrigin.scheduleId,
      scheduleId,
    );
    assert.equal(scheduled.length, 1);
    await scheduled[0]();
    assert.deepEqual(calls.resume, [{ tenantId: 1, pipelineId: 901 }]);

    const runs = await request(
      base,
      `/api/content/pipeline-schedules/${scheduleId}/runs`,
    );
    assert.equal(runs.status, 200);
    assert.equal(runs.body.runs[0].deepLink, "/content?pipelineId=901");
  });
});

test("路由列表不返回其他租户计划", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const repository = createSqliteContentPipelineScheduleRepository({ db });
  repository.ensureSchema();
  repository.create({
    tenantId: 2,
    createdBy: 21,
    name: "其他租户",
    kind: "daily",
    atTime: "09:00",
    task: EXACT_TASK,
    persona: {},
    settings: {},
    workflow: { mode: "copilot" },
  });
  const service = createContentPipelineScheduleService({
    repository,
    preflight: () => ({}),
    findExistingPipeline: () => null,
    createPipeline: () => ({ id: 1, status: "running" }),
    resumePipeline: () => ({ id: 1, status: "completed" }),
  });
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 11, tenant_id: 1, role: "boss" };
    next();
  });
  app.use(
    "/api/content",
    createContentPipelineScheduleRouter({
      service,
      profileStore: { load: () => null },
      resolveBrief: () => ({}),
    }),
  );
  await withServer(app, async (base) => {
    const listed = await request(base, "/api/content/pipeline-schedules");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.schedules, []);
  });
});

test("部分编辑保留已保存的完整Brief、人设、企业设置与审批策略快照", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const repository = createSqliteContentPipelineScheduleRepository({ db });
  repository.ensureSchema();
  const service = createContentPipelineScheduleService({
    repository,
    preflight: () => ({}),
    findExistingPipeline: () => null,
    createPipeline: () => ({ id: 1, status: "running" }),
    resumePipeline: () => ({ id: 1, status: "completed" }),
  });
  let profile = {
    brief: { xhsStyle: { name: "租户默认", desc: "不应覆盖计划快照" } },
    persona: { tone: "租户默认语气" },
    enterprise: { brand: "租户默认品牌" },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 11, tenant_id: 1, role: "boss", name: "老板" };
    next();
  });
  app.use(
    "/api/content",
    createContentPipelineScheduleRouter({
      service,
      profileStore: { load: () => ({ revision: 3, profile }) },
      resolveBrief: resolveContentStructuredBrief,
      logOpFn: () => {},
    }),
  );

  await withServer(app, async (base) => {
    const created = await request(base, "/api/content/pipeline-schedules", {
      method: "POST",
      body: JSON.stringify({
        name: "保留完整快照",
        kind: "daily",
        atTime: "09:00",
        brief: {
          direction: "原始完整方向",
          template: "日更选题",
          platforms: ["小红书", "抖音"],
          image_mode: "ai",
          image_count: 2,
          enable_deck: true,
          xhs_style: { name: "计划小红书风格", desc: "保留" },
          dy_style: { name: "计划抖音风格", desc: "保留" },
          persona: { tone: "计划专属语气" },
          enterprise: { brand: "计划专属品牌" },
        },
        workflow: {
          mode: "copilot",
          approvalPolicy: { mode: "custom", reviewStations: [0, 6, 8] },
        },
      }),
    });
    assert.equal(created.status, 201);
    profile = {
      brief: { xhsStyle: { name: "后来修改的租户默认", desc: "不能渗入" } },
      persona: { tone: "后来修改的租户语气" },
      enterprise: { brand: "后来修改的租户品牌" },
    };
    const updated = await request(
      base,
      `/api/content/pipeline-schedules/${created.body.schedule.id}`,
      {
        method: "PUT",
        body: JSON.stringify({
          brief: { direction: "只修改内容方向" },
          workflow: { mode: "manual" },
        }),
      },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.schedule.task.direction, "只修改内容方向");
    assert.deepEqual(updated.body.schedule.task.xhs_style, {
      name: "计划小红书风格",
      desc: "保留",
    });
    assert.deepEqual(updated.body.schedule.task.dy_style, {
      name: "计划抖音风格",
      desc: "保留",
    });
    assert.equal(updated.body.schedule.persona.tone, "计划专属语气");
    assert.equal(
      updated.body.schedule.settings.companyProfile.brand,
      "计划专属品牌",
    );
    assert.equal(updated.body.schedule.settings.contentProfileRevision, 3);
    assert.equal(updated.body.schedule.workflow.mode, "manual");
    assert.deepEqual(
      updated.body.schedule.workflow.approvalPolicy.reviewStations,
      [0, 6, 8],
    );
    assert.equal(
      updated.body.schedule.workflow.approvalPolicy.configuredBy.id,
      11,
    );
  });
});
