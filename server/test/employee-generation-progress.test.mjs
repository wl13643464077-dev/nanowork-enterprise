import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createEmployeeGenerationProgressHeartbeat,
  EMPLOYEE_GENERATION_PROGRESS_KIND,
  generationProgressFromSnapshot,
} from "../src/engines/employee-generation-progress.js";

test("员工长任务进度按时间或字符节流，且持久化结构只含四个安全字段", () => {
  let timestamp = Date.parse("2026-07-31T12:00:00.000Z");
  const writes = [];
  const heartbeat = createEmployeeGenerationProgressHeartbeat({
    now: () => timestamp,
    write: (snapshot) => {
      writes.push(structuredClone(snapshot));
      return true;
    },
  });

  assert.equal(
    heartbeat({
      receivedChars: 120,
      attemptNumber: 1,
      phase: "acquire",
      partialBody: "正文绝不能落库",
      prompt: "PROMPT_SECRET",
      url: "https://secret.example/stream",
      key: "sk-progress-secret",
      rawError: new Error("raw provider error"),
    }),
    true,
  );
  timestamp += 100;
  assert.equal(
    heartbeat({ receivedChars: 619, attemptNumber: 1, phase: "acquire" }),
    false,
  );
  assert.equal(writes.length, 1);

  assert.equal(
    heartbeat({ receivedChars: 620, attemptNumber: 1, phase: "acquire" }),
    true,
  );
  timestamp += 1_999;
  assert.equal(
    heartbeat({ receivedChars: 621, attemptNumber: 1, phase: "acquire" }),
    false,
  );
  timestamp += 1;
  assert.equal(
    heartbeat({ receivedChars: 622, attemptNumber: 1, phase: "acquire" }),
    true,
  );

  // 新的供应商尝试/阶段即刻落一次，不能等满两秒或五百字。
  assert.equal(
    heartbeat({ receivedChars: 1, attemptNumber: 2, phase: "repair" }),
    true,
  );
  assert.equal(writes.length, 4);
  assert.deepEqual(Object.keys(writes.at(-1)).sort(), ["kind", "progress"]);
  assert.equal(writes.at(-1).kind, EMPLOYEE_GENERATION_PROGRESS_KIND);
  assert.deepEqual(Object.keys(writes.at(-1).progress).sort(), [
    "attemptNumber",
    "lastActivityAt",
    "phase",
    "receivedChars",
  ]);
  const persisted = JSON.stringify(writes);
  assert.doesNotMatch(
    persisted,
    /正文绝不能落库|PROMPT_SECRET|secret\.example|sk-progress-secret|raw provider error/u,
  );
});

test("进度写库失败后仍推进节流基线，避免每个流式分片连续重试", () => {
  let timestamp = Date.parse("2026-07-31T12:00:00.000Z");
  let writeAttempts = 0;
  const heartbeat = createEmployeeGenerationProgressHeartbeat({
    now: () => timestamp,
    write: () => {
      writeAttempts += 1;
      return false;
    },
  });

  assert.equal(
    heartbeat({ receivedChars: 0, attemptNumber: 1, phase: "acquire" }),
    false,
  );
  assert.equal(writeAttempts, 1);

  timestamp += 100;
  assert.equal(
    heartbeat({ receivedChars: 499, attemptNumber: 1, phase: "acquire" }),
    false,
  );
  assert.equal(writeAttempts, 1);

  // 达到字符阈值后可以再次尝试；本次失败同样成为下一轮退避基线。
  assert.equal(
    heartbeat({ receivedChars: 500, attemptNumber: 1, phase: "acquire" }),
    false,
  );
  assert.equal(writeAttempts, 2);

  timestamp += 1_999;
  assert.equal(
    heartbeat({ receivedChars: 501, attemptNumber: 1, phase: "acquire" }),
    false,
  );
  assert.equal(writeAttempts, 2);

  timestamp += 1;
  assert.equal(
    heartbeat({ receivedChars: 501, attemptNumber: 1, phase: "acquire" }),
    false,
  );
  assert.equal(writeAttempts, 3);

  // 新的供应商尝试不受上一尝试节流影响，但仍只尝试一次。
  assert.equal(
    heartbeat({ receivedChars: 0, attemptNumber: 2, phase: "repair" }),
    false,
  );
  assert.equal(writeAttempts, 4);
});

test("进度投影拒绝损坏结构，最终成功或失败证据不会被误判为临时进度", () => {
  const valid = {
    kind: EMPLOYEE_GENERATION_PROGRESS_KIND,
    progress: {
      receivedChars: 888,
      lastActivityAt: "2026-07-31T12:00:00.000Z",
      attemptNumber: 2,
      phase: "repair",
      ignoredSecret: "sk-never-project",
    },
    ignoredBody: "partial output",
  };
  assert.deepEqual(generationProgressFromSnapshot(JSON.stringify(valid)), {
    receivedChars: 888,
    lastActivityAt: "2026-07-31T12:00:00.000Z",
    attemptNumber: 2,
    phase: "repair",
  });
  assert.equal(generationProgressFromSnapshot("{broken"), null);
  assert.equal(
    generationProgressFromSnapshot({
      ...valid,
      progress: { ...valid.progress, phase: "persist" },
    }),
    null,
  );
  assert.equal(
    generationProgressFromSnapshot({
      kind: "restaurant_employee_execution_evidence",
      providerAttempt: { mode: "api" },
      outputContract: { valid: true },
    }),
    null,
  );
  assert.equal(
    generationProgressFromSnapshot({
      kind: "restaurant_employee_execution_evidence",
      failure: { code: "provider_timeout" },
    }),
    null,
  );
});

test("真实阶段日志只接受固定阶段与数字计数，不持久化任意标签、查询或网址", () => {
  let timestamp = Date.parse("2026-08-09T12:00:00.000Z");
  const writes = [];
  const heartbeat = createEmployeeGenerationProgressHeartbeat({
    now: () => timestamp,
    write: (snapshot) => {
      writes.push(structuredClone(snapshot));
      return true;
    },
  });

  assert.equal(
    heartbeat.stage("search", {
      status: "active",
      count: 5,
      label: "恶意自定义标签 https://secret.example/?token=abc",
      query: "老板私有查询",
    }),
    true,
  );
  timestamp += 1_000;
  assert.equal(
    heartbeat.stage("fetch", {
      status: "done",
      count: 3,
      url: "https://secret.example/private",
    }),
    true,
  );
  assert.equal(heartbeat.stage("untrusted_custom_stage", {}), false);

  const projected = generationProgressFromSnapshot(writes.at(-1));
  assert.equal(projected.currentStage, "fetch");
  assert.equal(projected.percent, 52);
  assert.deepEqual(
    projected.steps.map((step) => [step.stage, step.status, step.count]),
    [
      ["search", "active", 5],
      ["fetch", "done", 3],
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(writes),
    /secret\.example|token=abc|老板私有查询|恶意自定义标签/u,
  );
});
