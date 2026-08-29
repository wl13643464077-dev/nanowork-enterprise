import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  CONTENT_HANDLER_ADAPTER_CATALOG,
  createContentHandlerAdapterRegistry,
} from "../src/engines/content-handler-adapters.js";
import {
  CONTENT_PRODUCTION_PHASE_EVENT_SCHEMA,
  createContentProductionPipeline,
  createSqliteContentProductionPipelineRepository,
} from "../src/engines/content-production-pipeline.js";
import { VALID_CONTENT_EMPLOYEE_OUTPUTS } from "./helpers/content-output-fixtures.mjs";

function testClock(start = "2026-08-08T00:00:00.000Z") {
  let value = Date.parse(start);
  const now = () => {
    const date = new Date(value);
    value += 1_000;
    return date;
  };
  now.advance = (milliseconds) => {
    value += milliseconds;
  };
  return now;
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

function phasePipelineFixture({ failFirst = false } = {}) {
  const db = new DatabaseSync(":memory:");
  const now = testClock();
  const repository = createSqliteContentProductionPipelineRepository({
    db,
    now,
  });
  repository.ensureSchema();
  let failed = false;
  const handlerRegistry = createContentHandlerAdapterRegistry({
    compile({ employeeIdx }) {
      return { system: `system-${employeeIdx}`, user: `user-${employeeIdx}` };
    },
    async invoke(input) {
      const progress = input.runtime.progress;
      await progress({
        phase: "agentic_search",
        state: "started",
        detail: {
          required: true,
          providerCalled: true,
          query: "不能落库的真实检索query",
          url: "https://private.example/secret",
        },
      });
      await progress({
        phase: "agentic_search",
        state: "completed",
        detail: {
          required: true,
          verified: true,
          candidateCount: 6,
          prompt: "不能落库的prompt",
        },
      });
      await progress({
        phase: "controlled_fetch",
        state: "started",
        detail: { required: true, providerCalled: true },
      });
      await progress({
        phase: "controlled_fetch",
        state: "completed",
        detail: {
          required: true,
          verified: true,
          verifiedBodyCount: 4,
          body: "不能落库的受控网页正文",
        },
      });
      await progress({
        phase: "provider",
        state: "started",
        detail: { providerCalled: true, providerCall: 1 },
      });
      if (failFirst && !failed) {
        failed = true;
        const error = new Error("provider failed with sk-test-secret-value");
        error.code = "OFFLINE_PROVIDER_FAILED";
        throw error;
      }
      await progress({
        phase: "provider",
        state: "completed",
        detail: { providerCalled: true, providerCall: 1 },
        usageRef: {
          source: "provider_delivery",
          model: "offline-real-shape-model",
          inputTokens: 120,
          outputTokens: 60,
          totalTokens: 180,
          url: "https://must-not-persist.example/usage",
          apiKey: "sk-must-not-persist",
        },
      });
      await progress({
        phase: "validate",
        state: "started",
        detail: { source: "content_output_contract" },
      });
      await progress({
        phase: "validate",
        state: "completed",
        detail: { verified: true, source: "content_output_contract" },
      });
      const output = structuredClone(
        VALID_CONTENT_EMPLOYEE_OUTPUTS[input.employeeIdx],
      );
      return {
        data: output,
        artifacts: [stationArtifact(input.employeeIdx, output)],
        tokens: 180,
      };
    },
    now,
  });
  const pipeline = createContentProductionPipeline({
    repository,
    handlerRegistry,
    resolveImageModel: () => "offline-real-shape-image-model",
    estimateMaxCredits: () => 75,
    buildRuntimeContext: runtimeContextBuilder(),
    now,
  });
  const created = pipeline.create({
    tenantId: 7,
    createdBy: 71,
    title: "真实phase event离线验收",
    task: {
      direction: "离线核验内容团队真实进度链",
      industry: "软件服务",
      material: "只使用注入的离线provider/search/fetch测试双替身",
      platforms: ["小红书"],
      image_mode: "ai",
      image_count: 1,
      enable_deck: false,
    },
    workflow: { mode: "manual" },
  });
  return { db, now, repository, pipeline, created };
}

test("publicPipeline按轮询返回同一SQLite真实phase链，且严格剔除query/prompt/body/URL/凭据", async (t) => {
  const fixture = phasePipelineFixture();
  t.after(() => fixture.db.close());

  const state = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(state.status, "awaiting_approval");
  const publicEvents = state.stations[0].phaseEvents;
  const persistedEvents = fixture.repository.listPhaseEvents(
    7,
    fixture.created.id,
    0,
  );
  assert.deepEqual(publicEvents, persistedEvents);
  assert.equal(
    publicEvents.every(
      (event) =>
        event.schemaVersion === CONTENT_PRODUCTION_PHASE_EVENT_SCHEMA &&
        event.attempt === 1 &&
        event.occurredAt,
    ),
    true,
  );
  for (const required of [
    "claim",
    "context",
    "agentic_search",
    "controlled_fetch",
    "provider",
    "validate",
    "persist",
    "settle",
  ]) {
    assert.equal(
      publicEvents.some((event) => event.phase === required),
      true,
      required,
    );
  }
  const providerCompleted = publicEvents.find(
    (event) => event.phase === "provider" && event.state === "completed",
  );
  assert.deepEqual(providerCompleted.usageRef, {
    source: "provider_delivery",
    model: "offline-real-shape-model",
    inputTokens: 120,
    outputTokens: 60,
    totalTokens: 180,
  });
  const serialized = JSON.stringify(state);
  for (const forbidden of [
    "private.example",
    "must-not-persist.example",
    "不能落库的真实检索query",
    "不能落库的prompt",
    "不能落库的受控网页正文",
    "sk-must-not-persist",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("失败与显式retry各自持久化attempt事件，新attempt不覆盖旧链", async (t) => {
  const fixture = phasePipelineFixture({ failFirst: true });
  t.after(() => fixture.db.close());

  const failed = await fixture.pipeline.resume({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(failed.status, "failed");
  assert.equal(
    failed.stations[0].phaseEvents.some(
      (event) => event.phase === "failure" && event.state === "failed",
    ),
    true,
  );

  const retried = await fixture.pipeline.retry({
    tenantId: 7,
    pipelineId: fixture.created.id,
  });
  assert.equal(retried.status, "awaiting_approval");
  assert.equal(retried.stations[0].attempt, 2);
  const events = retried.stations[0].phaseEvents;
  assert.equal(
    events.some(
      (event) =>
        event.phase === "retry" &&
        event.state === "retrying" &&
        event.attempt === 2,
    ),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        event.phase === "claim" &&
        event.state === "completed" &&
        event.attempt === 2,
    ),
    true,
  );
  assert.equal(
    events.some((event) => event.phase === "failure" && event.attempt === 1),
    true,
  );
});

test("超时running工位显式recover落真实恢复事件，未超时不会伪造事件", (t) => {
  const db = new DatabaseSync(":memory:");
  const now = testClock();
  const repository = createSqliteContentProductionPipelineRepository({
    db,
    now,
    interruptedStaleMs: 60_000,
  });
  repository.ensureSchema();
  t.after(() => db.close());
  const pipelineId = repository.createJob({
    tenantId: 7,
    createdBy: 71,
    title: "recover event",
    task: { direction: "recover" },
    workflow: { mode: "manual" },
  });
  repository.claimStation(7, pipelineId, 0);
  assert.throws(
    () => repository.recoverInterruptedStation(7, pipelineId),
    (error) => error.code === "CONTENT_PIPELINE_STATION_STILL_ACTIVE",
  );
  assert.equal(
    repository
      .listPhaseEvents(7, pipelineId, 0)
      .some((event) => event.phase === "recover"),
    false,
  );
  now.advance(61_000);
  repository.recoverInterruptedStation(7, pipelineId);
  assert.equal(
    repository
      .listPhaseEvents(7, pipelineId, 0)
      .some(
        (event) =>
          event.phase === "recover" &&
          event.state === "recovered" &&
          event.attempt === 1,
      ),
    true,
  );
});
