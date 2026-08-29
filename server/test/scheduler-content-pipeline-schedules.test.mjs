import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const databasePath = path.join(
  os.tmpdir(),
  `nanowork-pipeline-schedule-tick-${process.pid}.db`,
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
const { runScheduledJobs } = await import("../src/engines/scheduler.js");

initSchema();
migrateV2();
q.run(
  `INSERT INTO tenants(id,name,status,credits) VALUES(191,'schedule-a','已开通',1000)
  ON CONFLICT(id) DO UPDATE SET status='已开通'`,
);
q.run(
  `INSERT INTO tenants(id,name,status,credits) VALUES(192,'schedule-b','已开通',1000)
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

test("scheduler每个tick按租户调用一次内容流水线计划执行器", async () => {
  const calls = [];
  const tick = runScheduledJobs(new Date("2026-08-08T00:00:30.000Z"), {
    contentPipelineScheduleTick: async (input) => {
      calls.push(input);
      return [];
    },
  });
  await tick.pending;
  assert.equal(
    calls.every((item) => item.source === "scheduler_tick"),
    true,
  );
  assert.deepEqual(
    calls
      .filter((item) => [191, 192].includes(item.tenantId))
      .map((item) => item.tenantId),
    [191, 192],
  );
  assert.equal(
    tick.results.every(
      (item) => item.contentPipelineSchedulesScheduled === true,
    ),
    true,
  );
});
