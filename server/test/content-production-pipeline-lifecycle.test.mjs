import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  CONTENT_HANDLER_ADAPTER_CATALOG,
  createContentHandlerAdapterRegistry,
} from "../src/engines/content-handler-adapters.js";
import {
  CONTENT_PRODUCTION_INTERRUPTED_STALE_MS,
  createContentProductionPipeline,
  createSqliteContentProductionPipelineRepository,
} from "../src/engines/content-production-pipeline.js";
import { VALID_CONTENT_EMPLOYEE_OUTPUTS } from "./helpers/content-output-fixtures.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function testClock(start = "2026-08-08T00:00:00.000Z") {
  let value = Date.parse(start);
  const now = () => new Date(value);
  now.advance = (milliseconds) => {
    value += milliseconds;
  };
  return now;
}

function artifact(employeeIdx, output) {
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

function runtimeContextBuilder() {
  return async (input) => {
    const stationKeys = Object.keys(input.outputs).sort(
      (a, b) => Number(a) - Number(b),
    );
    return {
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
          synthesized: false,
          persistedOnly: true,
          stationKeys,
          stationCount: stationKeys.length,
        },
      },
    };
  };
}

function lifecycleFixture({ invoke, classifyRecovery, releaseUndeliveredHolds } = {}) {
  const db = new DatabaseSync(":memory:");
  const now = testClock();
  const repository = createSqliteContentProductionPipelineRepository({
    db,
    now,
  });
  repository.ensureSchema();
  let invocationCount = 0;
  const handlerRegistry = createContentHandlerAdapterRegistry({
    compile({ employeeIdx }) {
      return { system: `system-${employeeIdx}`, user: `user-${employeeIdx}` };
    },
    async invoke(input) {
      invocationCount += 1;
      if (invoke) return invoke(input);
      const output = structuredClone(
        VALID_CONTENT_EMPLOYEE_OUTPUTS[input.employeeIdx],
      );
      return {
        data: output,
        artifacts: [artifact(input.employeeIdx, output)],
        tokens: 10,
      };
    },
    now,
  });
  const makePipeline = () =>
    createContentProductionPipeline({
      repository,
      handlerRegistry,
      resolveImageModel: () => "offline-image-model",
      estimateMaxCredits: () => 75,
      classifyRecovery,
      releaseUndeliveredHolds,
      buildRuntimeContext: runtimeContextBuilder(),
      now,
    });
  const create = (pipeline, tenantId = 7) =>
    pipeline.create({
      tenantId,
      createdBy: tenantId * 10 + 1,
      title: `tenant-${tenantId}-lifecycle`,
      task: {
        direction: "内容团队生命周期离线验收",
        platforms: ["小红书"],
        image_mode: "ai",
        image_count: 1,
        enable_deck: false,
      },
      workflow: { mode: "manual" },
    });
  return {
    db,
    now,
    repository,
    makePipeline,
    create,
    invocationCount: () => invocationCount,
  };
}

test("pause/resume使用CAS中止活动handler，迟到回调不能推进工位", async (t) => {
  const invoked = deferred();
  const finish = deferred();
  const fixture = lifecycleFixture({
    async invoke(input) {
      invoked.resolve(input.runtime.signal);
      await finish.promise;
      const output = structuredClone(
        VALID_CONTENT_EMPLOYEE_OUTPUTS[input.employeeIdx],
      );
      return {
        data: output,
        artifacts: [artifact(input.employeeIdx, output)],
        tokens: 10,
      };
    },
  });
  t.after(() => fixture.db.close());
  const pipeline = fixture.makePipeline();
  const created = fixture.create(pipeline);
  const running = pipeline.resume({ tenantId: 7, pipelineId: created.id });
  const signal = await invoked.promise;

  const paused = pipeline.pause({ tenantId: 7, pipelineId: created.id });
  assert.equal(paused.status, "paused");
  assert.equal(paused.stations[0].status, "paused");
  assert.equal(signal.aborted, true);

  finish.resolve();
  const late = await running;
  assert.equal(late.status, "paused");
  assert.equal(late.currentStation, 0);
  assert.equal(late.stations[0].output, null);

  const resumed = pipeline.resumePaused({
    tenantId: 7,
    pipelineId: created.id,
  });
  assert.equal(resumed.status, "running");
  assert.equal(resumed.stations[0].status, "pending");
  const completedAttempt = await pipeline.resume({
    tenantId: 7,
    pipelineId: created.id,
  });
  assert.equal(completedAttempt.status, "awaiting_approval");
  assert.equal(completedAttempt.stations[0].attempt, 2);
});

test("cancel先在同一SQLite事务释放未交付hold，已结算历史不会被改写", async (t) => {
  const invoked = deferred();
  const finish = deferred();
  let repository;
  const releaseCalls = [];
  const fixture = lifecycleFixture({
    async invoke(input) {
      invoked.resolve();
      await finish.promise;
      const output = structuredClone(
        VALID_CONTENT_EMPLOYEE_OUTPUTS[input.employeeIdx],
      );
      return {
        data: output,
        artifacts: [artifact(input.employeeIdx, output)],
        tokens: 10,
      };
    },
    releaseUndeliveredHolds(input) {
      releaseCalls.push({
        statusBeforeCancel: repository.getJob(
          input.tenantId,
          input.pipelineId,
        ).status,
        stationOutput: input.station.output,
      });
      return {
        releasedCount: 1,
        releasedCredits: 25,
        preservedSettledHistory: true,
      };
    },
  });
  repository = fixture.repository;
  t.after(() => fixture.db.close());
  const pipeline = fixture.makePipeline();
  const created = fixture.create(pipeline);
  const running = pipeline.resume({ tenantId: 7, pipelineId: created.id });
  await invoked.promise;

  const cancelled = pipeline.cancel({
    tenantId: 7,
    pipelineId: created.id,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.stations[0].status, "cancelled");
  assert.deepEqual(releaseCalls, [
    { statusBeforeCancel: "running", stationOutput: null },
  ]);
  assert.equal(
    cancelled.workflow.lifecycle.releaseEvidence.preservedSettledHistory,
    true,
  );

  finish.resolve();
  const late = await running;
  assert.equal(late.status, "cancelled");
  assert.equal(late.stations[0].output, null);
  assert.throws(
    () => pipeline.resumePaused({ tenantId: 7, pipelineId: created.id }),
    { code: "CONTENT_PIPELINE_NOT_PAUSED" },
  );
});

test("startup/tick只恢复无歧义stale工位一次，held/pending转待对账且按租户隔离", async (t) => {
  const blockedIds = new Set();
  const fixture = lifecycleFixture({
    classifyRecovery({ pipelineId }) {
      return blockedIds.has(pipelineId)
        ? {
            safeToResume: false,
            code: "CONTENT_PIPELINE_RECOVERY_UNSETTLED_BILLING",
            message: "held hold",
            heldCredits: 33,
          }
        : { safeToResume: true };
    },
  });
  t.after(() => fixture.db.close());
  const originalProcess = fixture.makePipeline();
  const safe = fixture.create(originalProcess, 7);
  const blocked = fixture.create(originalProcess, 7);
  const otherTenant = fixture.create(originalProcess, 8);
  blockedIds.add(blocked.id);

  fixture.repository.claimStation(7, safe.id, 0);
  fixture.repository.claimStation(7, blocked.id, 0);
  fixture.repository.claimStation(8, otherTenant.id, 0);
  fixture.now.advance(CONTENT_PRODUCTION_INTERRUPTED_STALE_MS + 1_000);

  // 新pipeline实例模拟进程重启，内存running lock/controller均为空。
  const restartedProcess = fixture.makePipeline();
  const outcomes = await restartedProcess.recoverStale({
    tenantId: 7,
    source: "startup_recovery",
  });
  assert.deepEqual(
    outcomes.map((item) => item.action).sort(),
    ["blocked_pending_reconciliation", "resumed_once"],
  );
  assert.equal(
    restartedProcess.inspect({ tenantId: 7, pipelineId: safe.id }).status,
    "awaiting_approval",
  );
  const blockedState = restartedProcess.inspect({
    tenantId: 7,
    pipelineId: blocked.id,
  });
  assert.equal(blockedState.status, "billing_pending");
  assert.equal(blockedState.stations[0].billingEvidence.heldCredits, 33);
  assert.equal(
    restartedProcess.inspect({ tenantId: 8, pipelineId: otherTenant.id })
      .status,
    "running",
  );
  assert.equal(
    (
      await restartedProcess.recoverStale({
        tenantId: 7,
        source: "scheduler_tick",
      })
    ).length,
    0,
  );
  assert.equal(fixture.invocationCount(), 1);
});

test("ensureSchema将旧CHECK安全迁移为paused/cancelled且保留数据", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE content_production_pipeline_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id INTEGER NOT NULL,
      created_by INTEGER NOT NULL,title TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','awaiting_approval','billing_pending','completed','failed','rejected')),
      current_station INTEGER NOT NULL DEFAULT 0,pending_station INTEGER,
      task_json TEXT NOT NULL,persona_json TEXT NOT NULL DEFAULT '{}',
      settings_json TEXT NOT NULL DEFAULT '{}',workflow_json TEXT NOT NULL DEFAULT '{}',
      failure_json TEXT,version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE content_production_pipeline_stations (
      pipeline_id INTEGER NOT NULL,tenant_id INTEGER NOT NULL,station_idx INTEGER NOT NULL,
      employee_key TEXT NOT NULL,handler_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','awaiting_approval','billing_pending','completed','skipped','failed','rejected')),
      attempt INTEGER NOT NULL DEFAULT 0,output_json TEXT,handler_evidence_json TEXT,
      billing_evidence_json TEXT,context_snapshot_json TEXT,approval_boundary_json TEXT,
      approval_audit_json TEXT NOT NULL DEFAULT '[]',selection_json TEXT,failure_json TEXT,
      started_at TEXT,completed_at TEXT,updated_at TEXT NOT NULL,
      PRIMARY KEY(pipeline_id,station_idx)
    );
    INSERT INTO content_production_pipeline_jobs(
      id,tenant_id,created_by,title,status,current_station,task_json,created_at,updated_at
    ) VALUES(1,7,71,'legacy','running',0,'{}','2026-08-01','2026-08-01');
    INSERT INTO content_production_pipeline_stations(
      pipeline_id,tenant_id,station_idx,employee_key,handler_id,status,updated_at
    ) VALUES(1,7,0,'content-0','handler-0','pending','2026-08-01');
  `);
  const repository = createSqliteContentProductionPipelineRepository({ db });
  repository.ensureSchema();
  db.prepare(
    `UPDATE content_production_pipeline_jobs SET status='paused'
    WHERE tenant_id=7 AND id=1`,
  ).run();
  db.prepare(
    `UPDATE content_production_pipeline_stations SET status='cancelled'
    WHERE tenant_id=7 AND pipeline_id=1 AND station_idx=0`,
  ).run();
  assert.equal(repository.getJob(7, 1).status, "paused");
  assert.equal(repository.getStation(7, 1, 0).status, "cancelled");
});
