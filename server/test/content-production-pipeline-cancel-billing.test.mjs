import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const databasePath = path.join(
  os.tmpdir(),
  `nanowork-pipeline-cancel-billing-${process.pid}.db`,
);
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    fs.rmSync(`${databasePath}${suffix}`, { force: true });
  } catch {
    /* fresh database */
  }
}
process.env.NANOWORK_DB = databasePath;

const { db, initSchema, migrateV2, q, runWithTenant } = await import(
  "../src/db.js"
);
const { holdCredits, settleHold } = await import("../src/engines/credits.js");
const { releaseContentPipelineUndeliveredHoldsInCurrentTransaction } =
  await import("../src/routes/content-production-pipeline.js");

initSchema();
migrateV2();
q.run(
  `INSERT INTO tenants(id,name,status,credits) VALUES(71,'cancel-billing','已开通',1000)
  ON CONFLICT(id) DO UPDATE SET credits=1000,status='已开通'`,
);
const userId = Number(
  q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES('cancel-billing-owner','x','owner','boss','启用',71)`,
  ).lastInsertRowid,
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

test("cancel billing callback仅释放未交付held，已settled账本历史原样保留", () => {
  runWithTenant(71, () => {
    const pipelineId = 901;
    const stationIdx = 3;
    const refId = pipelineId * 10 + stationIdx + 1;
    const settled = holdCredits({
      userId,
      tenantId: 71,
      feature: "pipeline-settled-history",
      kind: "text",
      model: "offline-model",
      credits: 10,
      refType: "content_production_pipeline_station",
      refId,
    });
    settleHold(settled, {
      credits: 4,
      aiMode: "api",
      model: "offline-model",
      note: "historical delivery settled",
    });
    const held = holdCredits({
      userId,
      tenantId: 71,
      feature: "pipeline-undelivered",
      kind: "text",
      model: "offline-model",
      credits: 25,
      refType: "content_production_pipeline_station",
      refId,
    });

    db.exec("BEGIN IMMEDIATE");
    let evidence;
    try {
      evidence = releaseContentPipelineUndeliveredHoldsInCurrentTransaction({
        tenantId: 71,
        pipelineId,
        stationIdx,
        station: { output: null },
        cancelledAt: "2026-08-08T00:00:00.000Z",
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    assert.equal(evidence.releasedCount, 1);
    assert.equal(evidence.releasedCredits, 25);
    assert.equal(evidence.preservedSettledHistory, true);
    const historical = q.get(
      "SELECT status,settled_credits FROM credit_holds WHERE tenant_id=? AND id=?",
      71,
      settled.holdId,
    );
    const cancelled = q.get(
      "SELECT status,settled_credits FROM credit_holds WHERE tenant_id=? AND id=?",
      71,
      held.holdId,
    );
    assert.equal(historical.status, "settled");
    assert.equal(historical.settled_credits, 4);
    assert.equal(cancelled.status, "settled");
    assert.equal(cancelled.settled_credits, 0);
    assert.equal(q.get("SELECT credits FROM tenants WHERE id=71").credits, 996);
  });
});
