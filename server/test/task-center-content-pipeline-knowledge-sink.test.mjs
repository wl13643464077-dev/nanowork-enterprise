import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test, { after } from "node:test";

import express from "express";

const dbPath = path.join(
  os.tmpdir(),
  `nanowork-task-center-pipeline-knowledge-${process.pid}.db`,
);
for (const suffix of ["", "-wal", "-shm"])
  fs.rmSync(`${dbPath}${suffix}`, { force: true });
process.env.NANOWORK_DB = dbPath;

const { db, initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const { createSqliteContentProductionPipelineRepository } =
  await import("../src/engines/content-production-pipeline.js");
const { holdCredits, settleHold } = await import("../src/engines/credits.js");
const { ensureContentPipelineSpecialProviderAttemptSchema } =
  await import("../src/routes/content-production-pipeline.js");
const taskCenterRoutes = (await import("../src/routes/task-center.js")).default;

initSchema();
migrateV2();
const repository = createSqliteContentProductionPipelineRepository({ db });
repository.ensureSchema();
ensureContentPipelineSpecialProviderAttemptSchema();
q.run("UPDATE tenants SET credits=1000 WHERE id=1");

const ownerId = Number(
  q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id)
    VALUES('pipeline_sink_owner','x','内容负责人','sales','内容部',1)`)
    .lastInsertRowid,
);
q.run(
  "UPDATE users SET modules=? WHERE id=?",
  JSON.stringify(["execution", "content"]),
  ownerId,
);
const otherId = Number(
  q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id)
    VALUES('pipeline_sink_other','x','其他员工','sales','内容部',1)`)
    .lastInsertRowid,
);
const pipelineId = repository.createJob({
  tenantId: 1,
  createdBy: ownerId,
  title: "已沉淀的内容团队任务",
  task: {
    direction: "复盘真实发布数据",
    template: "",
    industry: "餐饮",
    material: "",
    ref_link: "",
    platforms: ["小红书"],
    image_mode: "ai",
    image_count: 1,
    enable_deck: false,
    xhs_style: null,
    dy_style: null,
  },
  persona: {},
  settings: {},
  workflow: { mode: "fullauto" },
});
q.run(
  `UPDATE content_production_pipeline_jobs
  SET status='completed',current_station=10,updated_at=datetime('now','localtime')
  WHERE tenant_id=1 AND id=?`,
  pipelineId,
);
repository.recordPhaseEvent({
  tenantId: 1,
  pipelineId,
  stationIdx: 9,
  stationAttempt: 1,
  phase: "provider",
  state: "completed",
  detail: {
    providerCalled: true,
    providerCall: 1,
    source: "offline_task_center_test",
  },
  usageRef: {
    source: "provider_delivery",
    model: "offline-real-shape-model",
    inputTokens: 120,
    outputTokens: 60,
    totalTokens: 180,
  },
});
repository.recordPhaseEvent({
  tenantId: 1,
  pipelineId,
  stationIdx: 9,
  stationAttempt: 1,
  phase: "settle",
  state: "completed",
  detail: { billingPending: false, source: "offline_task_center_test" },
  usageRef: { source: "billing_evidence", settledCredits: 2 },
});
q.run(
  `UPDATE content_production_pipeline_stations
  SET status='completed',attempt=2,output_json='{"report":"复盘完成"}',
      completed_at=datetime('now','localtime'),updated_at=datetime('now','localtime')
  WHERE tenant_id=1 AND pipeline_id=? AND station_idx=9`,
  pipelineId,
);
const pipelineArtifactBody = "# 内容团队复盘\n\n复盘完成。";
const pipelineArtifactId = Number(
  q.run(
    `INSERT INTO content_production_pipeline_artifacts(
      tenant_id,pipeline_id,station_idx,station_attempt,artifact_index,kind,is_primary,
      filename,media_type,byte_size,content_sha256,source_keys_json,content,created_at
    ) VALUES(1,?,9,2,0,'markdown',1,'content-team-report.md','text/markdown',?,?,
      '[]',?,datetime('now','localtime'))`,
    pipelineId,
    Buffer.byteLength(pipelineArtifactBody),
    createHash("sha256").update(pipelineArtifactBody).digest("hex"),
    pipelineArtifactBody,
  ).lastInsertRowid,
);
const oldPipelineArtifactBody = "# 旧版复盘\n\n这是第1次attempt的旧产物。";
const oldPipelineArtifactId = Number(
  q.run(
    `INSERT INTO content_production_pipeline_artifacts(
      tenant_id,pipeline_id,station_idx,station_attempt,artifact_index,kind,is_primary,
      filename,media_type,byte_size,content_sha256,source_keys_json,content,created_at
    ) VALUES(1,?,9,1,0,'markdown',1,'content-team-report-old.md','text/markdown',?,?,
      '[]',?,datetime('now','localtime'))`,
    pipelineId,
    Buffer.byteLength(oldPipelineArtifactBody),
    createHash("sha256").update(oldPipelineArtifactBody).digest("hex"),
    oldPipelineArtifactBody,
  ).lastInsertRowid,
);

const finalFingerprint = `sha256:${"a".repeat(64)}`;
const summaryFingerprint = `sha256:${"b".repeat(64)}`;
const metricsFingerprint = `sha256:${"c".repeat(64)}`;
const assetId = Number(
  q.run(
    `INSERT INTO biz_assets(
    tenant_id,name,category,status,owner,source_type,source_id,creator_id,url,note
  ) VALUES(1,'内容团队最终交付','内容资产','使用中','内容团队','content_pipeline',?,?,?,?)`,
    pipelineId,
    ownerId,
    `/content?pipelineId=${pipelineId}`,
    JSON.stringify({
      finalArtifactFingerprint: finalFingerprint,
      stationSummaryFingerprint: summaryFingerprint,
      publicationMetricsFingerprint: metricsFingerprint,
      completedAt: "2026-08-08T08:00:00.000Z",
    }),
  ).lastInsertRowid,
);
const kbDocId = Number(
  q.run(
    `INSERT INTO kb_docs(
    tenant_id,category,title,body,source_type,source_id,enabled
  ) VALUES(1,'员工产出','内容团队交付复盘','复盘与回流选题','content_pipeline',?,1)`,
    pipelineId,
  ).lastInsertRowid,
);

function appFor(user) {
  const app = express();
  app.use((req, _res, next) =>
    runWithTenant(1, () => {
      req.user = user;
      next();
    }),
  );
  app.use("/task-center", taskCenterRoutes);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0);
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("TaskCenter content_pipeline详情投影最终资产与知识追溯证据", async () => {
  const owner = {
    id: ownerId,
    name: "内容负责人",
    role: "sales",
    tenant_id: 1,
  };
  await withServer(owner, async (base) => {
    const response = await fetch(
      `${base}/task-center/content_pipeline/${pipelineId}`,
    );
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.pipeline.knowledgeSink.status, "completed");
    assert.equal(detail.pipeline.knowledgeSink.assetId, assetId);
    assert.equal(detail.pipeline.knowledgeSink.kbDocId, kbDocId);
    assert.equal(
      detail.pipeline.knowledgeSink.finalArtifactFingerprint,
      finalFingerprint,
    );
    assert.equal(
      detail.pipeline.knowledgeSink.stationSummaryFingerprint,
      summaryFingerprint,
    );
    assert.equal(
      detail.pipeline.knowledgeSink.publicationMetricsFingerprint,
      metricsFingerprint,
    );
    assert.equal(
      detail.pipeline.knowledgeSink.pipelineDeepLink,
      `/content?pipelineId=${pipelineId}`,
    );
    assert.deepEqual(
      detail.pipeline.stations[9].phaseEvents.map(
        (event) => `${event.phase}:${event.state}`,
      ),
      ["provider:completed", "settle:completed"],
    );
    assert.equal(
      detail.pipeline.stations[9].phaseEvents[0].usageRef.totalTokens,
      180,
    );
    assert.equal(
      detail.conversationDeepLink,
      `/content?pipelineId=${pipelineId}`,
    );
    assert.equal(detail.conversationAvailability.available, true);
    assert.match(detail.report.markdown, /复盘完成/u);
    assert.doesNotMatch(detail.report.markdown, /^\s*\{/u);
    const artifact = detail.pipeline.artifacts.find(
      (candidate) => candidate.id === pipelineArtifactId,
    );
    assert.ok(artifact);
    assert.equal(artifact.stationAttempt, 2);
    assert.equal(artifact.previewAvailable, true);
    assert.equal(artifact.downloadAvailable, true);
    assert.equal(
      detail.pipeline.artifacts.some(
        (candidate) => candidate.id === oldPipelineArtifactId,
      ),
      false,
      "旧attempt产物不得出现在当前交付列表",
    );
    assert.equal(
      artifact.previewUrl,
      `/api/content/pipelines/${pipelineId}/stations/9/artifacts/${pipelineArtifactId}/preview`,
    );
    assert.equal(
      artifact.downloadUrl,
      `/api/content/pipelines/${pipelineId}/stations/9/artifacts/${pipelineArtifactId}/download`,
    );

    q.run(
      "UPDATE users SET modules=? WHERE id=?",
      JSON.stringify(["execution"]),
      ownerId,
    );
    try {
      const restrictedResponse = await fetch(
        `${base}/task-center/content_pipeline/${pipelineId}`,
      );
      assert.equal(restrictedResponse.status, 200);
      const restricted = await restrictedResponse.json();
      assert.equal(restricted.conversationAvailability.available, false);
      assert.match(restricted.conversationAvailability.reason, /内容模块/u);
      assert.ok(
        restricted.pipeline.artifacts.every(
          (item) =>
            item.previewAvailable === false && item.downloadAvailable === false,
        ),
      );
    } finally {
      q.run(
        "UPDATE users SET modules=? WHERE id=?",
        JSON.stringify(["execution", "content"]),
        ownerId,
      );
    }
  });
});

test("TaskCenter列表与详情同时聚合流水线文本hold与专项provider账务", async () => {
  const owner = {
    id: ownerId,
    name: "内容负责人",
    role: "sales",
    tenant_id: 1,
  };
  const stationRefId = pipelineId * 10 + 10;
  const stationHold = holdCredits({
    userId: ownerId,
    tenantId: 1,
    feature: "任务中心·流水线文本工位",
    kind: "text",
    model: "offline-task-center-model",
    credits: 7,
    refType: "content_production_pipeline_station",
    refId: stationRefId,
  });
  settleHold(stationHold, {
    credits: 4,
    aiMode: "api",
    model: "offline-task-center-model",
    note: "离线契约文本结算",
  });

  const settledProviderRefId = pipelineId * 100 + 61;
  const settledProviderHold = holdCredits({
    userId: ownerId,
    tenantId: 1,
    feature: "任务中心·封面provider",
    kind: "image",
    model: "offline-task-center-image",
    credits: 8,
    refType: "content_special_provider",
    refId: settledProviderRefId,
  });
  settleHold(settledProviderHold, {
    credits: 6,
    aiMode: "api",
    model: "offline-task-center-image",
    note: "离线契约图片结算",
  });
  q.run(
    `INSERT INTO content_pipeline_special_provider_attempts(
      tenant_id,pipeline_id,station_idx,provider_kind,attempt_id,
      request_fingerprint,billing_ref_type,billing_ref_id,hold_id,status,
      output_json,delivery_json,billing_json,created_by
    ) VALUES(1,?,6,'image',?,'sha256:${"d".repeat(64)}',
      'content_special_provider',?,?,'settled','{}','{}','{}',?)`,
    pipelineId,
    `task-center:pipeline:${pipelineId}:station:6:provider:image:attempt:1`,
    settledProviderRefId,
    settledProviderHold.holdId,
    ownerId,
  );

  await withServer(owner, async (base) => {
    const listResponse = await fetch(`${base}/task-center?pageSize=100`);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    const item = list.items.find(
      (candidate) =>
        candidate.kind === "content_pipeline" && candidate.id === pipelineId,
    );
    assert.ok(item);
    assert.equal(item.billing.state, "settled");
    assert.equal(item.billing.credits, 10);
    assert.equal(item.billing.authoritative, true);
    assert.equal(item.billing.ledger.stationHoldCount, 1);
    assert.equal(item.billing.ledger.specialProviderHoldCount, 1);
    assert.equal(item.billing.ledger.specialProviderAttemptCount, 1);

    const detailResponse = await fetch(
      `${base}/task-center/content_pipeline/${pipelineId}`,
    );
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.billing.state, "settled");
    assert.equal(detail.billing.credits, 10);
    assert.deepEqual(
      new Set(detail.billing.ledger.holdIds),
      new Set([stationHold.holdId, settledProviderHold.holdId]),
    );
  });

  const pendingProviderRefId = pipelineId * 100 + 51;
  const pendingProviderHold = holdCredits({
    userId: ownerId,
    tenantId: 1,
    feature: "任务中心·多媒体provider待对账",
    kind: "image",
    model: "offline-task-center-image",
    credits: 9,
    refType: "content_special_provider",
    refId: pendingProviderRefId,
  });
  const pendingAttemptId = `task-center:pipeline:${pipelineId}:station:5:provider:image:attempt:1`;
  q.run(
    `INSERT INTO content_pipeline_special_provider_attempts(
      tenant_id,pipeline_id,station_idx,provider_kind,attempt_id,
      request_fingerprint,billing_ref_type,billing_ref_id,hold_id,status,
      output_json,delivery_json,billing_json,created_by
    ) VALUES(1,?,5,'image',?,'sha256:${"e".repeat(64)}',
      'content_special_provider',?,?,'pending_reconciliation','{}','{}','{}',?)`,
    pipelineId,
    pendingAttemptId,
    pendingProviderRefId,
    pendingProviderHold.holdId,
    ownerId,
  );

  await withServer(owner, async (base) => {
    const listResponse = await fetch(`${base}/task-center?pageSize=100`);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    const item = list.items.find(
      (candidate) =>
        candidate.kind === "content_pipeline" && candidate.id === pipelineId,
    );
    assert.ok(item);
    assert.equal(item.billing.state, "pending_reconciliation");
    assert.equal(item.billing.credits, 19);
    assert.equal(item.billing.authoritative, false);
    assert.equal(item.state, "blocked");
    assert.equal(item.businessUsable, false);
    assert.equal(item.billing.ledger.specialProviderHoldCount, 2);
    assert.deepEqual(item.billing.ledger.pendingAttemptIds, [pendingAttemptId]);

    const detailResponse = await fetch(
      `${base}/task-center/content_pipeline/${pipelineId}`,
    );
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.billing.state, "pending_reconciliation");
    assert.equal(detail.billing.credits, 19);
    assert.equal(detail.state, "blocked");
    assert.equal(detail.businessUsable, false);
    assert.ok(
      detail.billing.ledger.reconciliationReasons.some((reason) =>
        reason.startsWith("provider_pending_reconciliation:"),
      ),
    );
  });
});

test("TaskCenter仍按创建人范围隔离流水线沉淀证据", async () => {
  const other = { id: otherId, name: "其他员工", role: "sales", tenant_id: 1 };
  await withServer(other, async (base) => {
    const response = await fetch(
      `${base}/task-center/content_pipeline/${pipelineId}`,
    );
    assert.equal(response.status, 404);
  });
});

after(() => {
  try {
    db.close();
  } catch {
    // 共享测试进程已关闭时无需重复处理。
  }
  for (const suffix of ["", "-wal", "-shm"])
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
});
