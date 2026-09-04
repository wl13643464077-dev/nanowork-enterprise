/**
 * P0-2 RAG 向量自动回填 + 红点（离线）。
 * 锁定：零向量文档被入队且不重复、查询向量化失败记事件、调度器 04:00 幂等、
 * /sys/kb/health 口径、embed-backfill 脚本纯函数（参数/游标/批次）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

process.env.NANOWORK_DB = ":memory:";
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "true";
process.env.ENABLE_SCHEDULER = "false";

const { initSchema, migrateV2, q, runWithTenant, getTenantConfig } = await import("../src/db.js");
const {
  enqueueMissingVectorDocs,
  kbHealthSummary,
  recordKbHealthEvent,
  runKbVectorBackfillSweep,
} = await import("../src/engines/rag.js");
const { kbSearch } = await import("../src/engines/ai.js");
const { runScheduledJobs } = await import("../src/engines/scheduler.js");
const {
  BACKFILL_USAGE,
  formatBackfillProgress,
  needsBackfill,
  parseBackfillArgs,
  parseCursor,
  selectBackfillBatch,
  serializeCursor,
} = await import("../src/engines/kb-backfill-plan.js");
const systemRoutes = (await import("../src/routes/system.js")).default;

initSchema();
migrateV2();

const TENANT_ID = 91_401;
q.run(
  `INSERT INTO tenants(id,name,status,plan,credits) VALUES(?,?,?,?,?)
   ON CONFLICT(id) DO UPDATE SET status='已开通',credits=100000`,
  TENANT_ID,
  "知识库健康租户",
  "已开通",
  "旗舰版",
  100_000,
);
const bossId = Number(
  q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id,credits) VALUES(?,?,?,?,?,?,?)`,
    `kb-health-boss-${process.pid}`,
    "x",
    "知识库老板",
    "boss",
    "启用",
    TENANT_ID,
    100_000,
  ).lastInsertRowid,
);

function insertDoc(title, body, embedding = null) {
  return Number(
    q.run(
      `INSERT INTO kb_docs(tenant_id,category,title,body,enabled,embedding) VALUES(?,?,?,?,1,?)`,
      TENANT_ID,
      "品牌资料",
      title,
      body,
      embedding,
    ).lastInsertRowid,
  );
}
const zeroVectorDocId = insertDoc(
  "无向量文档",
  "这是一篇尚未生成语义向量的品牌资料，正文足够长以便被后台向量化任务接受。".repeat(3),
);
const vectorizedDocId = insertDoc(
  "已向量化文档",
  "这是一篇已经有整文向量的品牌资料。",
  JSON.stringify(Array.from({ length: 8 }, () => 0.1)),
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("检索发现零向量文档：交给既有后台向量化任务入队，重复调用不重复排队并记事件", async () => {
  const first = runWithTenant(TENANT_ID, () =>
    enqueueMissingVectorDocs([zeroVectorDocId, vectorizedDocId, zeroVectorDocId], {
      tenantId: TENANT_ID,
      source: "test",
    }),
  );
  assert.equal(first.candidates, 1, "已有向量的文档与重复 ID 不参与排队");
  assert.equal(first.accepted, 1, JSON.stringify(first.results));
  const jobs = q.all(
    `SELECT status FROM kb_embedding_jobs WHERE tenant_id=? AND doc_id=?`,
    TENANT_ID,
    zeroVectorDocId,
  );
  assert.equal(jobs.length, 1);

  const second = runWithTenant(TENANT_ID, () =>
    enqueueMissingVectorDocs([zeroVectorDocId], { tenantId: TENANT_ID, source: "test" }),
  );
  assert.equal(second.candidates, 0, "运行中/刚结束的任务不得重复排队");
  assert.equal(second.accepted, 0);
  // 等后台任务结束（无向量服务 → 释放），冷却期内仍不重复排队
  for (let index = 0; index < 100; index += 1) {
    const row = q.get(
      `SELECT status FROM kb_embedding_jobs WHERE tenant_id=? AND doc_id=?`,
      TENANT_ID,
      zeroVectorDocId,
    );
    if (row && !["preparing", "queued", "running"].includes(row.status)) break;
    await sleep(20);
  }
  const third = runWithTenant(TENANT_ID, () =>
    enqueueMissingVectorDocs([zeroVectorDocId], { tenantId: TENANT_ID, source: "test" }),
  );
  assert.equal(third.candidates, 0, "一小时冷却内不在检索路径上反复重试");
  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM kb_embedding_jobs WHERE tenant_id=? AND doc_id=?`,
      TENANT_ID,
      zeroVectorDocId,
    ).n,
    1,
  );
  const events = q.all(
    `SELECT kind,detail FROM kb_health_events WHERE tenant_id=? AND kind='zero_vector_doc'`,
    TENANT_ID,
  );
  assert.equal(events.length, 1, "只有真正排队那一次记 zero_vector_doc 事件");
  const detail = JSON.parse(events[0].detail);
  assert.deepEqual(detail.docIds, [zeroVectorDocId]);
  assert.equal(detail.accepted, 1);
});

test("查询向量化失败：保持不注入，但记录 query_embed_failed 事件", async () => {
  const before = q.get(
    `SELECT COUNT(*) n FROM kb_health_events WHERE tenant_id=? AND kind='query_embed_failed'`,
    TENANT_ID,
  ).n;
  const result = await runWithTenant(TENANT_ID, () =>
    kbSearch(["品牌资料"], "boss", "太原吾悦广场晚市两人套餐", { embedTimeoutMs: 500 }),
  );
  assert.equal(result.degraded, true);
  assert.equal(result.mode, "unavailable");
  assert.equal(result.text, "", "向量化失败时禁止注入热度资料");
  const after = q.get(
    `SELECT COUNT(*) n FROM kb_health_events WHERE tenant_id=? AND kind='query_embed_failed'`,
    TENANT_ID,
  ).n;
  assert.equal(after - before, 1);
  assert.equal(recordKbHealthEvent("not_a_kind", {}, { tenantId: TENANT_ID }), false);
});

test("每日 04:00 上海时钟回填扫描：runOnce 幂等，结果写 sys_config 与事件表", async () => {
  // 2026-09-03 04:00 Asia/Shanghai = 2026-09-02T20:00:00Z
  const at4 = new Date("2026-09-02T20:00:00Z");
  const first = runScheduledJobs(at4, { contentAutomationRunner: async () => ({}) });
  await first.pending;
  const tenantResult = first.results.find((item) => item.tenantId === TENANT_ID);
  assert.ok(tenantResult, "调度器应遍历已开通租户");
  assert.equal(tenantResult.kbVectorBackfill, true, JSON.stringify(tenantResult));
  const second = runScheduledJobs(at4, { contentAutomationRunner: async () => ({}) });
  await second.pending;
  assert.equal(
    second.results.find((item) => item.tenantId === TENANT_ID)?.kbVectorBackfill,
    false,
    "同一天第二次 tick 不得重复执行",
  );
  const other = runScheduledJobs(new Date("2026-09-02T21:00:00Z"), {
    contentAutomationRunner: async () => ({}),
  });
  await other.pending;
  assert.equal(
    other.results.find((item) => item.tenantId === TENANT_ID)?.kbVectorBackfill,
    false,
    "非 04:00 不触发",
  );
  const last = runWithTenant(TENANT_ID, () => getTenantConfig("kb_vector_backfill_last", null, TENANT_ID));
  assert.ok(last?.ranAt, "最近回填时间必须写入 sys_config");
  assert.equal(last.source, "scheduler");
  assert.ok(
    q.get(
      `SELECT COUNT(*) n FROM kb_health_events WHERE tenant_id=? AND kind IN ('backfill_run','backfill_needed')`,
      TENANT_ID,
    ).n >= 1,
  );
  const manual = runWithTenant(TENANT_ID, () =>
    runKbVectorBackfillSweep({ tenantId: TENANT_ID, source: "manual", userId: bossId }),
  );
  assert.equal(manual.source, "manual");
  assert.equal(typeof manual.missingBefore, "number");
});

test("GET /sys/kb/health 口径：文档总数/已向量化/待回填/24h失败/最近回填/红点/建议；仅 boss/admin", async () => {
  const app = express();
  app.use(express.json());
  let role = "boss";
  app.use((req, _res, next) => {
    req.user = { id: bossId, name: "知识库老板", role, tenant_id: TENANT_ID };
    runWithTenant(TENANT_ID, () => next());
  });
  app.use("/sys", systemRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/sys/kb/health`);
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.enabledDocs, 2);
    assert.equal(health.vectorizedDocs, 1);
    assert.equal(health.pendingBackfill, 1);
    assert.ok(health.queryEmbedFailures24h >= 1);
    assert.equal(health.needsAttention, true);
    assert.ok(health.lastBackfillAt, "应返回最近回填时间");
    assert.equal(typeof health.nextStep, "string");
    assert.ok(health.nextStep.length > 0);
    assert.equal(health.providerConfigured, false, "无向量服务凭据时如实报告");
    assert.equal(health.canBackfill, false);

    const backfill = await fetch(`${base}/sys/kb/backfill`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(backfill.status, 409, "向量服务未配置时不能开始回填");

    role = "sales";
    const denied = await fetch(`${base}/sys/kb/health`);
    assert.equal(denied.status, 403);
  } finally {
    server.close();
  }

  // 纯函数：无待回填且无失败时不亮红点
  const summary = runWithTenant(TENANT_ID, () => kbHealthSummary({ tenantId: 999_999, providerConfigured: true }));
  assert.equal(summary.enabledDocs, 0);
  assert.equal(summary.needsAttention, false);
  assert.match(summary.nextStep, /暂无已启用知识/u);
});

test("embed-backfill 脚本纯函数：参数解析、游标断点、批次限流、进度文案", () => {
  const parsed = parseBackfillArgs(["--tenant=12", "--dry-run", "--limit", "5", "--cursor-file=./c.json"]);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.tenant, 12);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.limit, 5);
  assert.equal(parsed.cursorFile, "./c.json");
  assert.ok(parseBackfillArgs(["--tenant=abc"]).errors.length === 1);
  assert.ok(parseBackfillArgs(["--wat"]).errors.length === 1);
  assert.equal(parseBackfillArgs([]).limit, 200);
  assert.equal(parseBackfillArgs([]).help, false);
  assert.equal(parseBackfillArgs(["--help"]).help, true);
  assert.equal(parseBackfillArgs(["-h"]).help, true);
  assert.match(BACKFILL_USAGE, /--dry-run/u);
  assert.match(BACKFILL_USAGE, /--tenant=ID/u);
  assert.match(BACKFILL_USAGE, /--limit=N/u);

  const docs = [{ id: 5 }, { id: 1 }, { id: 9 }, { id: 3 }, { id: 7 }];
  const batch = selectBackfillBatch(docs, { lastDocId: 3, limit: 2 });
  assert.deepEqual(batch.batch.map((doc) => doc.id), [5, 7]);
  assert.equal(batch.remaining, 1);
  assert.equal(batch.nextCursor, 7);
  const empty = selectBackfillBatch(docs, { lastDocId: 9, limit: 2 });
  assert.equal(empty.batch.length, 0);
  assert.equal(empty.nextCursor, 9);

  const cursor = parseCursor(serializeCursor({ lastDocId: 7, tenant: 12, processed: 4 }), { tenant: 12 });
  assert.equal(cursor.lastDocId, 7);
  assert.equal(cursor.processed, 4);
  assert.equal(parseCursor(serializeCursor({ lastDocId: 7, tenant: 12 }), { tenant: null }).discarded, "tenant_mismatch");
  assert.equal(parseCursor("{bad json", { tenant: null }).discarded, "corrupt");
  assert.equal(parseCursor("", { tenant: null }).lastDocId, 0);

  assert.match(formatBackfillProgress({ processed: 3, total: 12, failed: 1, docId: 42 }), /\[3\/12 25%\] 失败 1 · 当前 doc#42/u);
  assert.equal(needsBackfill({ embedding: null, body: "x" }), true);
  assert.equal(needsBackfill({ embedding: "[0.1]", body: "x".repeat(800) }, { chunkCount: 0 }), true);
  assert.equal(needsBackfill({ embedding: "[0.1]", body: "x".repeat(800) }, { chunkCount: 3 }), false);
  assert.equal(needsBackfill({ embedding: "[0.1]", body: "short" }), false);
});
