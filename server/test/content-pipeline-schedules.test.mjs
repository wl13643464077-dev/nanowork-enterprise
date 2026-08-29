import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  CONTENT_HANDLER_ADAPTER_CATALOG,
  createContentHandlerAdapterRegistry,
} from "../src/engines/content-handler-adapters.js";
import { createContentPaidMediaAuthorization } from "../src/engines/content-paid-media-authorization.js";
import {
  createContentProductionPipeline,
  createSqliteContentProductionPipelineRepository,
} from "../src/engines/content-production-pipeline.js";
import {
  computeNextContentPipelineSchedule,
  contentPipelineScheduleLaunchBlocker,
  createContentPipelineScheduleService,
  createSqliteContentPipelineScheduleRepository,
} from "../src/engines/content-pipeline-schedules.js";
import { VALID_CONTENT_EMPLOYEE_OUTPUTS } from "./helpers/content-output-fixtures.mjs";

const TASK = Object.freeze({
  direction: "测试0到9完整内容流水线定时开工",
  template: "日更选题",
  industry: "企业服务",
  material: "仅使用离线测试双替身",
  platforms: ["小红书"],
  image_mode: "ai",
  image_count: 1,
  enable_deck: true,
});

function mutableClock(start = "2026-08-08T00:00:00.000Z") {
  let value = Date.parse(start);
  const now = () => new Date(value++);
  now.set = (next) => {
    value = Date.parse(next);
  };
  now.advance = (milliseconds) => {
    value += milliseconds;
  };
  return now;
}

function runtimeContextBuilder() {
  return async (input) => ({
    context: {
      executionMode: "pipeline",
      today: "2026-08-08",
      brief: input.task,
      task: input.task,
      profile: {
        account: { id: input.actorId, role: "boss" },
        persona: input.persona,
      },
      companyProfile: input.settings?.companyProfile || {},
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
        persistedOnly: true,
        synthesized: false,
        stationKeys: Object.keys(input.outputs),
        stationCount: Object.keys(input.outputs).length,
      },
    },
  });
}

function stationArtifact(employeeIdx, output) {
  const descriptor = CONTENT_HANDLER_ADAPTER_CATALOG[employeeIdx];
  return {
    kind: "json",
    primary: true,
    filename: `station-${employeeIdx}.json`,
    content: JSON.stringify(output),
    employeeIdx,
    employeeKey: descriptor.employeeKey,
    sourceKeys: [...descriptor.outputKeys],
  };
}

function pipelineFixture(db, now) {
  const repository = createSqliteContentProductionPipelineRepository({
    db,
    now,
  });
  repository.ensureSchema();
  const invoked = [];
  const handlers = createContentHandlerAdapterRegistry({
    compile({ employeeIdx }) {
      return { system: `system-${employeeIdx}`, user: `user-${employeeIdx}` };
    },
    async invoke(input) {
      invoked.push(input.employeeIdx);
      const output = structuredClone(
        VALID_CONTENT_EMPLOYEE_OUTPUTS[input.employeeIdx],
      );
      return {
        data: output,
        artifacts: [stationArtifact(input.employeeIdx, output)],
        tokens: 10,
      };
    },
    now,
  });
  const pipeline = createContentProductionPipeline({
    repository,
    handlerRegistry: handlers,
    resolveImageModel: () => "offline-image-model",
    estimateMaxCredits: () => 75,
    buildRuntimeContext: runtimeContextBuilder(),
    now,
  });
  return { pipeline, repository, invoked };
}

function fullWorkflow(now) {
  return {
    mode: "fullauto",
    approvalPolicy: {
      mode: "custom",
      reviewStations: [],
      configuredBy: { id: 11, role: "boss" },
    },
    publicationMetrics: {
      schemaVersion: "nanowork.content-publication-metrics-collection/2",
      requiredPlatforms: ["小红书"],
      entries: [
        {
          schemaVersion: "nanowork.content-publication-metrics-entry/2",
          publication: {
            platform: "小红书",
            url: "https://www.xiaohongshu.com/explore/offline-test",
            publishedAt: "2026-08-07T10:00:00.000Z",
          },
          metrics: { views: 100, likes: 8 },
          submittedBy: { id: 11, name: "老板", role: "boss" },
          submittedAt: "2026-08-08T00:00:00.000Z",
          verification: {
            status: "manual_unverified",
            source: "human_submission",
          },
        },
      ],
      submittedPlatforms: ["小红书"],
      missingPlatforms: [],
      complete: true,
      verificationStatus: "manual_unverified",
    },
    paidMediaAuthorized: true,
    _now: now,
  };
}

function serviceFixture({
  db = new DatabaseSync(":memory:"),
  now = mutableClock(),
} = {}) {
  const scheduleRepository = createSqliteContentPipelineScheduleRepository({
    db,
    now,
  });
  scheduleRepository.ensureSchema();
  const runtime = pipelineFixture(db, now);
  let preflightCalls = 0;
  let createCalls = 0;
  const service = createContentPipelineScheduleService({
    repository: scheduleRepository,
    findExistingPipeline: ({ tenantId, idempotency }) =>
      runtime.pipeline.findByIdempotency({ tenantId, idempotency }),
    preflight: ({ schedule }) => {
      preflightCalls += 1;
      const workflow = structuredClone(schedule.workflow);
      delete workflow.paidMediaAuthorized;
      workflow.paidMediaAuthorization = createContentPaidMediaAuthorization({
        task: schedule.task,
        actor: { id: schedule.createdBy, role: "boss", name: "老板" },
        imageModel: "offline-image-model",
        estimatedUnitCredits: 75,
        now,
      });
      return { workflow };
    },
    createPipeline: (input) => {
      createCalls += 1;
      return runtime.pipeline.create(input);
    },
    resumePipeline: (input) => runtime.pipeline.resume(input),
    now,
  });
  const createSchedule = (overrides = {}) =>
    service.create({
      tenantId: 1,
      createdBy: 11,
      name: "每日完整团队",
      kind: "daily",
      atTime: "08:00",
      task: TASK,
      persona: { tone: "结论先行" },
      settings: { companyProfile: { brand: "离线品牌" } },
      workflow: fullWorkflow(now),
      ...overrides,
    });
  return {
    db,
    now,
    runtime,
    scheduleRepository,
    service,
    createSchedule,
    counters: {
      get preflight() {
        return preflightCalls;
      },
      get create() {
        return createCalls;
      },
    },
  };
}

test("北京时间daily/weekly/interval计算不受服务器时区影响", () => {
  const now = new Date("2026-08-08T00:30:00.000Z"); // 北京周六 08:30
  assert.equal(
    computeNextContentPipelineSchedule({ kind: "daily", atTime: "09:00" }, now),
    "2026-08-08T01:00:00.000Z",
  );
  assert.equal(
    computeNextContentPipelineSchedule(
      { kind: "weekly", weekday: 0, atTime: "09:00" },
      now,
    ),
    "2026-08-10T01:00:00.000Z",
  );
  assert.equal(
    computeNextContentPipelineSchedule(
      { kind: "interval", everyHours: 6 },
      now,
    ),
    "2026-08-08T06:30:00.000Z",
  );
});

test("到点只claim一次，完整task/persona/settings/workflow触发0→9真实工位", async (t) => {
  const fixture = serviceFixture();
  t.after(() => fixture.db.close());
  const schedule = fixture.createSchedule();
  fixture.now.set(schedule.nextRunAt);
  const first = fixture.scheduleRepository.claimDue(1, fixture.now());
  const duplicate = fixture.scheduleRepository.claimDue(1, fixture.now());
  assert.equal(first.length, 1);
  assert.equal(duplicate.length, 0);
  const result = await fixture.service.execute(first[0]);
  assert.equal(result.pipeline.status, "completed");
  assert.deepEqual(fixture.runtime.invoked, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const stored = fixture.service.getSchedule(1, schedule.id);
  assert.equal(stored.task.direction, TASK.direction);
  assert.deepEqual(stored.task.platforms, TASK.platforms);
  assert.equal(stored.task.image_mode, TASK.image_mode);
  assert.equal(stored.task.image_count, TASK.image_count);
  assert.equal(stored.persona.tone, "结论先行");
  assert.equal(stored.settings.companyProfile.brand, "离线品牌");
  assert.equal(stored.lastPipelineId, result.pipeline.id);
  assert.equal(stored.deepLink, `/content?pipelineId=${result.pipeline.id}`);
});

test("崩溃发生在pipeline.create后也通过occurrence幂等映射复用原pipeline", async (t) => {
  const fixture = serviceFixture();
  t.after(() => fixture.db.close());
  const schedule = fixture.createSchedule();
  fixture.now.set(schedule.nextRunAt);
  const originalClaim = fixture.scheduleRepository.claimDue(
    1,
    fixture.now(),
  )[0];
  const idempotency = {
    namespace: "content_pipeline_schedule",
    key: `${schedule.id}:${originalClaim.occurrenceKey}`,
  };
  const workflow = fullWorkflow(fixture.now);
  delete workflow.paidMediaAuthorized;
  workflow.paidMediaAuthorization = createContentPaidMediaAuthorization({
    task: TASK,
    actor: { id: 11, role: "boss", name: "老板" },
    imageModel: "offline-image-model",
    estimatedUnitCredits: 75,
    now: fixture.now,
  });
  const orphan = fixture.runtime.pipeline.create({
    tenantId: 1,
    createdBy: 11,
    title: TASK.direction,
    task: TASK,
    persona: {},
    settings: {},
    workflow,
    idempotency,
  });
  fixture.now.advance(16 * 60 * 1_000);
  const reclaimed = fixture.scheduleRepository.claimDue(1, fixture.now())[0];
  const resumed = await fixture.service.execute(reclaimed);
  assert.equal(resumed.pipeline.id, orphan.id);
  assert.equal(fixture.counters.create, 0);
  assert.equal(fixture.counters.preflight, 0);
  assert.equal(
    fixture.db
      .prepare("SELECT COUNT(*) n FROM content_production_pipeline_jobs")
      .get().n,
    1,
  );
});

test("pipeline已提交但调用方抛错时原occurrence立即找回且不推进为重复任务", async (t) => {
  const db = new DatabaseSync(":memory:");
  const now = mutableClock();
  const repository = createSqliteContentPipelineScheduleRepository({ db, now });
  repository.ensureSchema();
  const runtime = pipelineFixture(db, now);
  let createCalls = 0;
  const service = createContentPipelineScheduleService({
    repository,
    findExistingPipeline: ({ tenantId, idempotency }) =>
      runtime.pipeline.findByIdempotency({ tenantId, idempotency }),
    preflight: ({ schedule }) => {
      const workflow = structuredClone(schedule.workflow);
      delete workflow.paidMediaAuthorized;
      workflow.paidMediaAuthorization = createContentPaidMediaAuthorization({
        task: schedule.task,
        actor: { id: schedule.createdBy, role: "boss", name: "老板" },
        imageModel: "offline-image-model",
        estimatedUnitCredits: 75,
        now,
      });
      return { workflow };
    },
    createPipeline: (input) => {
      createCalls += 1;
      runtime.pipeline.create(input);
      throw Object.assign(new Error("模拟提交成功后连接中断"), {
        code: "SIMULATED_POST_COMMIT_DISCONNECT",
      });
    },
    resumePipeline: (input) => runtime.pipeline.resume(input),
    now,
  });
  t.after(() => db.close());
  const schedule = service.create({
    tenantId: 1,
    createdBy: 11,
    name: "提交后断线",
    kind: "daily",
    atTime: "08:00",
    task: TASK,
    persona: {},
    settings: {},
    workflow: fullWorkflow(now),
  });
  now.set(schedule.nextRunAt);
  const claim = repository.claimDue(1, now())[0];
  const launched = await service.launch(claim);
  const stored = service.getSchedule(1, schedule.id);
  assert.equal(createCalls, 1);
  assert.equal(launched.run.status, "pipeline_created");
  assert.equal(stored.lastPipelineId, launched.pipeline.id);
  assert.notEqual(stored.nextRunAt, schedule.nextRunAt);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM content_production_pipeline_jobs").get()
      .n,
    1,
  );
});

test("定时开工在模型占用或并行已满时顺延，不硬塞新流水线", () => {
  assert.deepEqual(
    contentPipelineScheduleLaunchBlocker({ running: 1, active: 1 }),
    {
      code: "CONTENT_PIPELINE_SCHEDULE_PROVIDER_BUSY",
      message: "已有流水线正在占用模型，定时计划已顺延10分钟",
      status: 429,
    },
  );
  assert.deepEqual(
    contentPipelineScheduleLaunchBlocker({ running: 0, active: 3 }),
    {
      code: "CONTENT_PIPELINE_SCHEDULE_CAPACITY_FULL",
      message: "并行流水线已满(3)",
      status: 429,
    },
  );
  assert.equal(
    contentPipelineScheduleLaunchBlocker({ running: 0, active: 2 }),
    null,
  );
});

test("模型占用失败会保留计划并改到10分钟后重试", async (t) => {
  const db = new DatabaseSync(":memory:");
  const now = mutableClock("2026-08-14T01:00:00.000Z");
  const repository = createSqliteContentPipelineScheduleRepository({ db, now });
  repository.ensureSchema();
  let created = 0;
  const service = createContentPipelineScheduleService({
    repository,
    preflight: () => {
      throw Object.assign(new Error("已有流水线正在占用模型，定时计划已顺延10分钟"), {
        status: 429,
        code: "CONTENT_PIPELINE_SCHEDULE_PROVIDER_BUSY",
      });
    },
    findExistingPipeline: () => null,
    createPipeline: () => {
      created += 1;
      return { id: 1, status: "running" };
    },
    resumePipeline: () => ({ id: 1, status: "completed" }),
    now,
  });
  t.after(() => db.close());
  const schedule = service.create({
    tenantId: 1,
    createdBy: 11,
    name: "占用顺延",
    kind: "daily",
    atTime: "09:00",
    task: TASK,
    persona: {},
    settings: {},
    workflow: { mode: "fullauto" },
  });
  now.set(schedule.nextRunAt);
  const outcome = await service.tick({ tenantId: 1, now: now() });
  assert.equal(outcome[0].status, "failed");
  assert.equal(created, 0);
  const updated = service.getSchedule(1, schedule.id);
  assert.equal(updated.enabled, true);
  assert.equal(updated.lastStatus, "deferred");
  assert.equal(updated.lastNote, "已有流水线正在占用模型，10分钟后重试");
  assert.equal(
    Date.parse(updated.nextRunAt) - Date.parse(updated.lastRunAt),
    10 * 60 * 1000,
  );
});

test("计划与运行严格跨租户隔离", (t) => {
  const fixture = serviceFixture();
  t.after(() => fixture.db.close());
  fixture.createSchedule();
  fixture.createSchedule({ tenantId: 2, createdBy: 21, name: "租户2" });
  assert.equal(fixture.service.list(1).length, 1);
  assert.equal(fixture.service.list(2).length, 1);
  assert.equal(fixture.service.getSchedule(2, 1), null);
});

test("余额预检失败不创建pipeline，定时计划失败关闭", async (t) => {
  const db = new DatabaseSync(":memory:");
  const now = mutableClock();
  const repository = createSqliteContentPipelineScheduleRepository({ db, now });
  repository.ensureSchema();
  let created = 0;
  const service = createContentPipelineScheduleService({
    repository,
    preflight: () => {
      throw Object.assign(new Error("积分余额不足"), {
        status: 402,
        code: "CREDIT_BALANCE_INSUFFICIENT",
      });
    },
    findExistingPipeline: () => null,
    createPipeline: () => {
      created += 1;
      return { id: 1, status: "running" };
    },
    resumePipeline: () => ({ id: 1, status: "completed" }),
    now,
  });
  t.after(() => db.close());
  const schedule = service.create({
    tenantId: 1,
    createdBy: 11,
    name: "余额门禁",
    kind: "daily",
    atTime: "08:00",
    task: TASK,
    persona: {},
    settings: {},
    workflow: { mode: "fullauto" },
  });
  now.set(schedule.nextRunAt);
  const outcome = await service.tick({ tenantId: 1, now: now() });
  assert.equal(outcome[0].status, "failed");
  assert.equal(created, 0);
  assert.equal(service.getSchedule(1, schedule.id).enabled, false);
  assert.equal(service.listRuns(1, schedule.id)[0].pipelineId, null);
});
