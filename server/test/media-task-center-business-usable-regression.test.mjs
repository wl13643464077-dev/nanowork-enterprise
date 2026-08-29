import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Local regression only: no provider runtime, network request, or paid API.
// A media row may be technically delivered and financially settled while it
// is still waiting for the required manager review.  TaskCenter list and
// detail must expose the same businessUsable gate in that state.
const dbPath = path.join(
  os.tmpdir(),
  `nanowork-media-task-center-regression-${process.pid}.db`,
);
for (const suffix of ["", "-wal", "-shm"])
  fs.rmSync(`${dbPath}${suffix}`, { force: true });
process.env.NANOWORK_DB = dbPath;

const { db, initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
initSchema();
migrateV2();

const { holdCredits, settleHold } = await import("../src/engines/credits.js");
const { listUnifiedTasks, getUnifiedTaskDetail } =
  await import("../src/engines/task-center.js");

const TENANT_ID = 9701;
const OWNER_ID = 9701001;
const owner = {
  id: OWNER_ID,
  name: "媒体任务回归老板",
  role: "boss",
  tenant_id: TENANT_ID,
};

q.run(
  `INSERT INTO tenants(id,name,status,credits) VALUES(?,?,?,?)`,
  TENANT_ID,
  "媒体任务回归租户",
  "已开通",
  100_000,
);
q.run(
  `INSERT INTO users(id,username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,'启用',?)`,
  OWNER_ID,
  `media-task-regression-${process.pid}`,
  "x",
  owner.name,
  owner.role,
  TENANT_ID,
);

const mediaId = runWithTenant(TENANT_ID, () =>
  Number(
    q.run(
      `INSERT INTO media_jobs(
    tenant_id,user_id,kind,model,prompt,status,url,content_employee_name,created_at)
  VALUES(?,?,?,?,?,?,?,?,datetime('now','localtime'))`,
      TENANT_ID,
      OWNER_ID,
      "video",
      "media-regression-model",
      "回归：未人工验收的视频",
      "成功",
      "https://cdn.example.com/regression.mp4",
      "AI带货员",
    ).lastInsertRowid,
  ),
);

// Authoritative two-phase billing is settled.  Deliberately do not create a
// material or review op-log: the media is ready for review, not business use.
runWithTenant(TENANT_ID, () => {
  const hold = holdCredits({
    userId: OWNER_ID,
    feature: "媒体TaskCenter业务可用回归",
    kind: "video",
    model: "media-regression-model",
    credits: 12,
    refType: "media_job",
    refId: mediaId,
  });
  settleHold(hold, {
    credits: 12,
    model: "media-regression-model",
    note: "技术交付后结算，但尚未人工验收",
  });
});

test("媒体任务列表与详情在未人工验收时都必须 businessUsable=false", () => {
  const list = runWithTenant(TENANT_ID, () =>
    listUnifiedTasks(owner, {
      kind: "media",
      pageSize: 100,
    }),
  );
  const listed = list.items.find((item) => Number(item.id) === mediaId);
  assert.ok(
    listed,
    "TaskCenter media list should include the scoped media job",
  );

  const detail = runWithTenant(TENANT_ID, () =>
    getUnifiedTaskDetail(owner, "media", mediaId),
  );
  assert.equal(detail.billing.state, "settled");
  assert.equal(
    detail.businessUsable,
    false,
    "detail correctly remains blocked until manager review",
  );
  assert.equal(detail.output, "");

  // Keep this assertion at the list/detail boundary.  A previous projection
  // treated a settled URL as usable in the list while detail applied the
  // manager-review gate; the regression must remain green after that fix.
  console.log(
    "MEDIA_TASK_CENTER_REGRESSION",
    JSON.stringify({
      mediaId,
      listBusinessUsable: listed.businessUsable,
      detailBusinessUsable: detail.businessUsable,
      listBilling: listed.billing,
      detailBilling: detail.billing,
      expected: false,
      source:
        "server/src/engines/task-center.js media loadSources + detail authority",
    }),
  );
  assert.equal(
    listed.businessUsable,
    false,
    "media list must not report businessUsable before manager media review",
  );
});

after(() => {
  try {
    db.close();
  } catch {
    /* test process may already be closing */
  }
  for (const suffix of ["", "-wal", "-shm"])
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
});
