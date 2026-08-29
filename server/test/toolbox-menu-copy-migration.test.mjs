import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DBP = path.join(
  os.tmpdir(),
  `nanowork-menu-copy-migration-${process.pid}.db`,
);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}

// 先构造真实存量库的8工具 CHECK，再导入 NanoWork 迁移。
// 这能防止“新库可用、旧库一上线就 CHECK constraint failed”。
const legacy = new DatabaseSync(DBP);
legacy.exec(`
  CREATE TABLE tool_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    tool_key TEXT NOT NULL CHECK(tool_key IN ('hot','remix','pcal','bench','warm','leads','shot','vars')),
    tool_title TEXT NOT NULL,
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
    status TEXT NOT NULL DEFAULT 'done' CHECK(status IN ('running','done','failed')),
    employee_idx INTEGER NOT NULL,
    employee_name TEXT NOT NULL,
    specialist_id INTEGER,
    created_by INTEGER NOT NULL,
    input_json TEXT NOT NULL,
    input_summary TEXT NOT NULL,
    result_md TEXT NOT NULL,
    assumptions_json TEXT NOT NULL DEFAULT '[]',
    evidence_json TEXT NOT NULL DEFAULT '[]',
    provenance_json TEXT NOT NULL,
    progress_json TEXT NOT NULL DEFAULT '[]',
    error_json TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    execution_state TEXT NOT NULL DEFAULT 'queued'
      CHECK(execution_state IN ('queued','running','retrying','done','failed')),
    last_heartbeat_at TEXT,
    timeout_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX idx_tool_runs_tenant_created ON tool_runs(tenant_id,created_at DESC,id DESC);
  CREATE INDEX idx_tool_runs_tenant_employee ON tool_runs(tenant_id,employee_idx,created_at DESC);
  CREATE TABLE tool_run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    run_id INTEGER NOT NULL,
    event_type TEXT NOT NULL DEFAULT 'generated' CHECK(event_type IN ('generated')),
    tool_key TEXT NOT NULL CHECK(tool_key IN ('hot','remix','pcal','bench','warm','leads','shot','vars')),
    employee_idx INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('done','failed')),
    source_system TEXT NOT NULL DEFAULT 'nanowork' CHECK(source_system='nanowork'),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX idx_tool_run_events_tenant_time ON tool_run_events(tenant_id,occurred_at DESC,id DESC);
  CREATE UNIQUE INDEX idx_tool_run_events_generated_once ON tool_run_events(tenant_id,run_id,event_type);
  INSERT INTO tool_runs(
    id,tenant_id,tool_key,tool_title,title,status,employee_idx,employee_name,
    created_by,input_json,input_summary,result_md,provenance_json,execution_state
  ) VALUES(
    77,1,'hot','今日必发','历史工具记录','failed',141,'云营销',
    1,'{"store":"历史门店"}','历史输入','','{"mode":"failed"}','failed'
  );
  INSERT INTO tool_run_events(
    id,tenant_id,run_id,event_type,tool_key,employee_idx,user_id,status,metadata_json
  ) VALUES(88,1,77,'generated','hot',141,1,'failed','{"legacy":true}');
`);
legacy.close();

process.env.NANOWORK_DB = DBP;
process.env.NODE_ENV = "test";
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";

const { db, initSchema, migrateV2 } = await import("../src/db.js");

test("旧库8工具CHECK幂等升级为menu-copy与link-script，历史运行与事件原样保留", () => {
  initSchema();
  db.prepare(
    `INSERT INTO users(id,username,password_hash,name,role,status)
    VALUES(1,'legacy-toolbox-owner','unused','历史工具所有者','boss','启用')`,
  ).run();
  migrateV2();
  migrateV2();

  const runSql = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_runs'`,
    )
    .get().sql;
  const eventSql = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_run_events'`,
    )
    .get().sql;
  assert.match(runSql, /'menu-copy'/u);
  assert.match(eventSql, /'menu-copy'/u);
  assert.match(runSql, /'link-script'/u);
  assert.match(eventSql, /'link-script'/u);

  const historical = db.prepare("SELECT * FROM tool_runs WHERE id=77").get();
  assert.equal(historical.tool_key, "hot");
  assert.equal(historical.title, "历史工具记录");
  assert.equal(historical.execution_state, "failed");
  const historicalEvent = db
    .prepare("SELECT * FROM tool_run_events WHERE id=88")
    .get();
  assert.equal(historicalEvent.run_id, 77);
  assert.equal(historicalEvent.tool_key, "hot");
  assert.deepEqual(JSON.parse(historicalEvent.metadata_json), { legacy: true });

  db.prepare(
    `INSERT INTO tool_runs(
    tenant_id,tool_key,tool_title,title,status,employee_idx,employee_name,created_by,
    input_json,input_summary,result_md,provenance_json,execution_state
  ) VALUES(1,'menu-copy','看图写卖点','迁移后新任务','failed',140,'章文案',1,
    '{"imageFileId":9}','图片ID：9','','{"mode":"failed"}','failed')`,
  ).run();
  const inserted = db
    .prepare(
      `SELECT id FROM tool_runs WHERE tool_key='menu-copy' ORDER BY id DESC LIMIT 1`,
    )
    .get();
  db.prepare(
    `INSERT INTO tool_run_events(
    tenant_id,run_id,event_type,tool_key,employee_idx,user_id,status,metadata_json
  ) VALUES(1,?,'generated','menu-copy',140,1,'failed','{}')`,
  ).run(inserted.id);
  assert.equal(
    db
      .prepare(`SELECT tool_key FROM tool_run_events WHERE run_id=?`)
      .get(inserted.id).tool_key,
    "menu-copy",
  );
  db.prepare(
    `INSERT INTO tool_runs(
    tenant_id,tool_key,tool_title,title,status,employee_idx,employee_name,created_by,
    input_json,input_summary,result_md,provenance_json,execution_state
  ) VALUES(1,'link-script','链接转口播稿','迁移后链接任务','failed',140,'章文案',1,
    '{"url":"https://example.com/public","duration":30}','公开链接','','{"mode":"failed"}','failed')`,
  ).run();
  const linkInserted = db
    .prepare(
      `SELECT id FROM tool_runs WHERE tool_key='link-script' ORDER BY id DESC LIMIT 1`,
    )
    .get();
  db.prepare(
    `INSERT INTO tool_run_events(
    tenant_id,run_id,event_type,tool_key,employee_idx,user_id,status,metadata_json
  ) VALUES(1,?,'generated','link-script',140,1,'failed','{}')`,
  ).run(linkInserted.id);
  assert.equal(
    db
      .prepare(`SELECT tool_key FROM tool_run_events WHERE run_id=?`)
      .get(linkInserted.id).tool_key,
    "link-script",
  );
  assert.throws(
    () =>
      db
        .prepare(`UPDATE tool_runs SET tool_key='not-a-tool' WHERE id=?`)
        .run(inserted.id),
    /CHECK constraint failed/u,
  );
});

test.after(() => {
  db.close();
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
});
