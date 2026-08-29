import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const databasePath = path.join(
  os.tmpdir(),
  `nanowork-pipeline-lifecycle-scheduler-${process.pid}.db`,
);
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    fs.rmSync(`${databasePath}${suffix}`, { force: true });
  } catch {
    /* fresh database */
  }
}
process.env.NANOWORK_DB = databasePath;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

const { db, initSchema, migrateV2, q } = await import("../src/db.js");
const {
  recoverStaleContentPipelinesAcrossTenants,
  runScheduledJobs,
} = await import("../src/engines/scheduler.js");

initSchema();
migrateV2();
q.run(
  `INSERT INTO tenants(id,name,status,credits) VALUES(91,'pipeline-a','已开通',1000)
  ON CONFLICT(id) DO UPDATE SET status='已开通'`,
);
q.run(
  `INSERT INTO tenants(id,name,status,credits) VALUES(92,'pipeline-b','已开通',1000)
  ON CONFLICT(id) DO UPDATE SET status='已开通'`,
);

after(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(`${databasePath}${suffix}`, { force: true });
    } catch {
      /* best effort */
    }
  }
});

test("startup与每次scheduler tick都按租户调用内容流水线恢复器", async () => {
  const startupCalls = [];
  const startup = await recoverStaleContentPipelinesAcrossTenants(
    new Date("2026-08-08T00:00:00.000Z"),
    async (input) => {
      startupCalls.push(input);
      return [{ tenantId: input.tenantId, action: "resumed_once" }];
    },
  );
  assert.equal(
    startupCalls.every((item) => item.source === "startup_recovery"),
    true,
  );
  assert.deepEqual(
    startupCalls
      .filter((item) => [91, 92].includes(item.tenantId))
      .map((item) => item.tenantId),
    [91, 92],
  );
  assert.equal(startup.every((item) => item.outcomes.length === 1), true);

  const tickCalls = [];
  const tick = runScheduledJobs(new Date("2026-08-08T00:00:30.000Z"), {
    contentPipelineLifecycleRunner: async (input) => {
      tickCalls.push(input);
      return [];
    },
  });
  await tick.pending;
  assert.equal(
    tickCalls.every((item) => item.source === "scheduler_tick"),
    true,
  );
  assert.deepEqual(
    tickCalls
      .filter((item) => [91, 92].includes(item.tenantId))
      .map((item) => item.tenantId),
    [91, 92],
  );
  assert.equal(
    tick.results.every(
      (item) => item.contentPipelineRecoveryScheduled === true,
    ),
    true,
  );
});
