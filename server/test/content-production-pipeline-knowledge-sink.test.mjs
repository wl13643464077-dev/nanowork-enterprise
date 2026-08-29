import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  CONTENT_PRODUCTION_KNOWLEDGE_SINK_SCHEMA,
  createContentProductionPipeline,
  createSqliteContentProductionPipelineRepository,
} from "../src/engines/content-production-pipeline.js";

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 8, 0, 0, tick++));
}

function settledBilling(stationIdx) {
  return {
    state: "settled",
    holdId: 10_000 + stationIdx,
    estimatedCredits: 20,
    heldCredits: 0,
    chargedCredits: 10 + stationIdx,
    credits: 10 + stationIdx,
    pendingReconciliation: false,
  };
}

function createFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE biz_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      name TEXT, category TEXT, value REAL DEFAULT 0, status TEXT DEFAULT '使用中',
      use_count INTEGER DEFAULT 0, owner TEXT, source_type TEXT, source_id INTEGER,
      creator_id INTEGER, url TEXT, note TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE kb_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      category TEXT, title TEXT, body TEXT, source_type TEXT, source_id INTEGER,
      enabled INTEGER DEFAULT 1, ref_count INTEGER DEFAULT 0, version INTEGER DEFAULT 1,
      updated_at TEXT
    );
  `);
  const now = clock();
  const repository = createSqliteContentProductionPipelineRepository({
    db,
    now,
  });
  repository.ensureSchema();
  const task = {
    direction: "真实指标回传后的内容复盘",
    template: "老板向内容",
    industry: "餐饮连锁",
    material: "只使用已核验上游",
    ref_link: "https://example.com/source",
    platforms: ["小红书"],
    image_mode: "ai",
    image_count: 1,
    enable_deck: true,
    xhs_style: null,
    dy_style: null,
  };
  const publicationMetrics = {
    schemaVersion: "nanowork.content-publication-metrics-collection/2",
    requiredPlatforms: ["小红书"],
    entries: [
      {
        schemaVersion: "nanowork.content-publication-metrics-entry/2",
        publication: {
          platform: "小红书",
          url: "https://www.xiaohongshu.com/explore/real-pipeline-note",
          publishedAt: "2026-08-07T08:00:00.000Z",
          externalId: "real-pipeline-note",
        },
        metrics: { views: 2300, comments: 37, leads: 8 },
        evidenceNote: "由运营负责人根据平台后台回传",
        verification: {
          status: "manual_unverified",
          source: "human_submission",
          platformVerified: false,
        },
        submittedBy: { id: 71, role: "boss", name: "老板" },
        submittedAt: "2026-08-08T00:00:00.000Z",
      },
    ],
    submittedPlatforms: ["小红书"],
    missingPlatforms: [],
    complete: true,
    verificationStatus: "manual_unverified",
    lastSubmittedPlatform: "小红书",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
  const pipelineId = repository.createJob({
    tenantId: 7,
    createdBy: 71,
    title: "真实内容团队交付",
    task,
    persona: {},
    settings: {},
    workflow: { mode: "fullauto", publicationMetrics },
  });
  db.prepare(
    `UPDATE content_production_pipeline_jobs
    SET status='completed',current_station=10,pending_station=NULL,updated_at=?
    WHERE tenant_id=7 AND id=?`,
  ).run("2026-08-08T00:00:10.000Z", pipelineId);
  for (let stationIdx = 0; stationIdx < 10; stationIdx += 1) {
    const output =
      stationIdx === 9
        ? {
            report: "评论率高于过往基线，老板案例开场带来更高停留。",
            next_topics: [
              { title: "门店真实数据如何变成内容证据" },
              "怎样用两周小样本验证选题",
            ],
            profile_updates: [
              { field: "corpus", suggestion: "优先使用带基线的业务数据" },
            ],
          }
        : { stationIdx, summary: `工位${stationIdx}真实交付` };
    const billing =
      stationIdx === 9
        ? {
            ...settledBilling(stationIdx),
            state: "pending_reconciliation",
            pendingReconciliation: true,
            heldCredits: 20,
            chargedCredits: null,
            credits: null,
          }
        : settledBilling(stationIdx);
    db.prepare(
      `UPDATE content_production_pipeline_stations
      SET status='completed',attempt=1,output_json=?,handler_evidence_json=?,
          billing_evidence_json=?,completed_at=?,updated_at=?
      WHERE tenant_id=7 AND pipeline_id=? AND station_idx=?`,
    ).run(
      JSON.stringify(output),
      JSON.stringify({
        completed: true,
        providerDelivery: { mode: "api", validated: true },
      }),
      JSON.stringify(billing),
      "2026-08-08T00:00:10.000Z",
      "2026-08-08T00:00:10.000Z",
      pipelineId,
      stationIdx,
    );
    const content = JSON.stringify(output);
    db.prepare(
      `INSERT INTO content_production_pipeline_artifacts(
      tenant_id,pipeline_id,station_idx,station_attempt,artifact_index,kind,is_primary,
      filename,media_type,byte_size,content_sha256,source_keys_json,content,created_at
    ) VALUES(7,?,?,1,0,?,1,?,'application/json',?,?,?,?,'2026-08-08T00:00:10.000Z')`,
    ).run(
      pipelineId,
      stationIdx,
      stationIdx === 8
        ? "publish_packages"
        : stationIdx === 9
          ? "markdown"
          : "json",
      `station-${stationIdx}.json`,
      Buffer.byteLength(content),
      createHash("sha256").update(content).digest("hex"),
      "[]",
      content,
    );
  }
  const pipeline = createContentProductionPipeline({
    repository,
    handlerRegistry: {
      invoke: async () => {
        throw new Error("inspect-only fixture");
      },
    },
    resolveImageModel: () => "test-image-model",
    estimateMaxCredits: () => 1,
    now,
  });
  return { db, repository, pipeline, pipelineId };
}

test("复盘工位已完成但账务待对账时不得提前沉淀", () => {
  const fixture = createFixture();
  try {
    const state = fixture.repository.finalizeKnowledgeSink(
      7,
      fixture.pipelineId,
    );
    assert.equal(state.schemaVersion, CONTENT_PRODUCTION_KNOWLEDGE_SINK_SCHEMA);
    assert.equal(state.status, "pending");
    assert.equal(
      state.reasonCode,
      "CONTENT_PIPELINE_KNOWLEDGE_BILLING_NOT_READY",
    );
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) count FROM biz_assets").get().count,
      0,
    );
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) count FROM kb_docs").get().count,
      0,
    );
  } finally {
    fixture.db.close();
  }
});

test("指标、十工位、产物与账务全部ready后租户内幂等沉淀最终资产与知识", () => {
  const fixture = createFixture();
  try {
    fixture.db
      .prepare(
        `UPDATE content_production_pipeline_stations
      SET billing_evidence_json=? WHERE tenant_id=7 AND pipeline_id=? AND station_idx=9`,
      )
      .run(JSON.stringify(settledBilling(9)), fixture.pipelineId);

    const first = fixture.repository.finalizeKnowledgeSink(
      7,
      fixture.pipelineId,
    );
    assert.equal(first.status, "completed");
    assert.ok(first.assetId > 0);
    assert.ok(first.kbDocId > 0);
    assert.match(first.finalArtifactFingerprint, /^sha256:[a-f0-9]{64}$/u);
    assert.match(first.stationSummaryFingerprint, /^sha256:[a-f0-9]{64}$/u);

    const asset = fixture.db
      .prepare(
        `SELECT * FROM biz_assets
      WHERE tenant_id=7 AND source_type='content_pipeline' AND source_id=?`,
      )
      .get(fixture.pipelineId);
    const doc = fixture.db
      .prepare(
        `SELECT * FROM kb_docs
      WHERE tenant_id=7 AND source_type='content_pipeline' AND source_id=?`,
      )
      .get(fixture.pipelineId);
    assert.equal(Number(asset.id), first.assetId);
    assert.equal(Number(doc.id), first.kbDocId);
    assert.equal(asset.category, "内容资产");
    assert.equal(asset.url, `/content?pipelineId=${fixture.pipelineId}`);
    assert.match(doc.body, /评论率高于过往基线/u);
    assert.match(doc.body, /门店真实数据如何变成内容证据/u);
    assert.match(doc.body, /优先使用带基线的业务数据/u);
    assert.equal((doc.body.match(/^- 工位\d/gmu) || []).length, 10);

    const second = fixture.repository.finalizeKnowledgeSink(
      7,
      fixture.pipelineId,
    );
    assert.deepEqual(
      { assetId: second.assetId, kbDocId: second.kbDocId },
      { assetId: first.assetId, kbDocId: first.kbDocId },
    );
    assert.equal(
      fixture.db
        .prepare(
          `SELECT COUNT(*) count FROM biz_assets
      WHERE tenant_id=7 AND source_type='content_pipeline' AND source_id=?`,
        )
        .get(fixture.pipelineId).count,
      1,
    );
    assert.equal(
      fixture.db
        .prepare(
          `SELECT COUNT(*) count FROM kb_docs
      WHERE tenant_id=7 AND source_type='content_pipeline' AND source_id=?`,
        )
        .get(fixture.pipelineId).count,
      1,
    );
    assert.equal(
      fixture.db
        .prepare(
          `SELECT COUNT(*) count FROM biz_assets
      WHERE tenant_id=8 AND source_type='content_pipeline' AND source_id=?`,
        )
        .get(fixture.pipelineId).count,
      0,
    );

    const inspected = fixture.pipeline.inspect({
      tenantId: 7,
      pipelineId: fixture.pipelineId,
    });
    assert.equal(inspected.knowledgeSink.status, "completed");
    assert.equal(inspected.knowledgeSink.assetId, first.assetId);
    assert.equal(inspected.knowledgeSink.kbDocId, first.kbDocId);
  } finally {
    fixture.db.close();
  }
});
