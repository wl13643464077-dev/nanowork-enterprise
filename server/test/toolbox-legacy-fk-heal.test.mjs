import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DBP = path.join(os.tmpdir(), `nanowork-legacy-fk-heal-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}

// 复现 menu-copy 迁移事故后的现网库形态：
// 1) tool_runs/tool_run_events 仍是旧版 8 工具 CHECK（触发 menu-copy 迁移段，用于用例B）；
// 2) toolbox_automation_runs 的外键已被 RENAME 事故改写成指向 tool_runs_legacy_menu_copy，
//    且该 legacy 表并不存在——外键悬空，任何写操作报 no such table（用例A）；
// 3) tool_run_pcal_edits 外键健康地指向 tool_runs（用例B 断言迁移后不被再次改坏）。
const legacy = new DatabaseSync(DBP);
// 悬空外键的表无法在外键检查开启时插入种子数据，构造现场必须先关掉
legacy.exec("PRAGMA foreign_keys=OFF");
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
  CREATE TABLE toolbox_automation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    automation_key TEXT NOT NULL
      CHECK(automation_key IN ('hot_daily','bench_weekly')),
    trigger TEXT NOT NULL CHECK(trigger IN ('scheduled','manual')),
    claim_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'claimed'
      CHECK(status IN ('claimed','enqueuing','running','completing','done','failed')),
    attempt_count INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER NOT NULL,
    tool_run_id INTEGER,
    config_snapshot_json TEXT NOT NULL DEFAULT '{}',
    request_json TEXT NOT NULL DEFAULT '{}',
    result_snapshot_json TEXT NOT NULL DEFAULT '{}',
    failure_json TEXT,
    knowledge_id INTEGER,
    notification_id INTEGER,
    next_retry_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(tenant_id,claim_key),
    FOREIGN KEY(created_by) REFERENCES users(id),
    FOREIGN KEY(tool_run_id) REFERENCES "tool_runs_legacy_menu_copy"(id),
    FOREIGN KEY(knowledge_id) REFERENCES kb_docs(id),
    FOREIGN KEY(notification_id) REFERENCES notifications(id)
  );
  CREATE INDEX idx_toolbox_automation_runs_recovery
    ON toolbox_automation_runs(tenant_id,status,next_retry_at,updated_at);
  CREATE INDEX idx_toolbox_automation_runs_tool
    ON toolbox_automation_runs(tenant_id,tool_run_id);
  INSERT INTO toolbox_automation_runs(
    id,tenant_id,automation_key,trigger,claim_key,status,created_by,tool_run_id
  ) VALUES(501,1,'hot_daily','manual','legacy:claim:501','done',1,77);
  CREATE TABLE tool_run_pcal_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    run_id INTEGER NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    calendar_json TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(tenant_id,run_id,version),
    FOREIGN KEY(run_id) REFERENCES tool_runs(id),
    FOREIGN KEY(created_by) REFERENCES users(id)
  );
  CREATE INDEX idx_tool_run_pcal_edits_latest
    ON tool_run_pcal_edits(tenant_id,run_id,version DESC);
  INSERT INTO tool_run_pcal_edits(id,tenant_id,run_id,version,calendar_json,created_by)
  VALUES(601,1,77,1,'{"days":[]}',1);
`);
// 记下健康表的原始 DDL：迁移后若发生任何字节变化，说明它被 RENAME 改写或走了重建
const pcalSqlBefore = legacy
  .prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_run_pcal_edits'`,
  )
  .get().sql;
legacy.close();

process.env.NANOWORK_DB = DBP;
process.env.NODE_ENV = "test";
process.env.NANOWORK_TEST_TEMPLATE_AI = "1";
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";

const { db, initSchema, migrateV2 } = await import("../src/db.js");

test("用例A：悬空外键的表被自愈——外键指回 tool_runs、数据无丢失、索引齐全、可正常写入", () => {
  initSchema();
  db.prepare(
    `INSERT INTO users(id,username,password_hash,name,role,status)
     VALUES(1,'legacy-fk-owner','unused','历史外键所有者','boss','启用')`,
  ).run();
  migrateV2();

  // 整库不允许再残留任何指向 legacy 表的定义
  const leftovers = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE sql LIKE '%legacy_menu_copy%'`,
    )
    .all();
  assert.deepEqual(leftovers, []);

  const runsSql = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='toolbox_automation_runs'`,
    )
    .get().sql;
  assert.match(runsSql, /REFERENCES\s+"?tool_runs"?\s*\(\s*id\s*\)/u);

  // 数据原样保留
  const preserved = db
    .prepare(`SELECT * FROM toolbox_automation_runs WHERE id=501`)
    .get();
  assert.equal(preserved.claim_key, "legacy:claim:501");
  assert.equal(preserved.tool_run_id, 77);
  assert.equal(preserved.status, "done");

  // 显式索引在重建后原样恢复
  const indexNames = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type='index' AND tbl_name='toolbox_automation_runs' AND sql IS NOT NULL
       ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(indexNames, [
    "idx_toolbox_automation_runs_recovery",
    "idx_toolbox_automation_runs_tool",
  ]);

  // 修复后既能正常写入（外键解析到真实的 tool_runs），又能拦住非法引用
  db.prepare(
    `INSERT INTO toolbox_automation_runs(
       tenant_id,automation_key,trigger,claim_key,status,created_by,tool_run_id
     ) VALUES(1,'hot_daily','manual','healed:claim:1','done',1,77)`,
  ).run();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO toolbox_automation_runs(
             tenant_id,automation_key,trigger,claim_key,status,created_by,tool_run_id
           ) VALUES(1,'hot_daily','manual','healed:claim:2','done',1,999999)`,
        )
        .run(),
    /FOREIGN KEY constraint failed/u,
  );
  assert.deepEqual(
    db.prepare(`PRAGMA foreign_key_check(toolbox_automation_runs)`).all(),
    [],
  );
});

test("用例B：menu-copy 迁移不再改写其它表外键——健康表定义与数据在迁移后原封不动", () => {
  // menu-copy 迁移段确实执行过（旧 CHECK 已升级）
  const toolRunsSql = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_runs'`,
    )
    .get().sql;
  assert.match(toolRunsSql, /'menu-copy'/u);
  assert.match(toolRunsSql, /'link-script'/u);

  // 字节级相等：既没被 RENAME 改写成 legacy 名，也没被自愈段重建过
  const pcalSqlAfter = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_run_pcal_edits'`,
    )
    .get().sql;
  assert.equal(pcalSqlAfter, pcalSqlBefore);

  const preserved = db
    .prepare(`SELECT * FROM tool_run_pcal_edits WHERE id=601`)
    .get();
  assert.equal(preserved.run_id, 77);
  assert.equal(preserved.version, 1);

  db.prepare(
    `INSERT INTO tool_run_pcal_edits(tenant_id,run_id,version,calendar_json,created_by)
     VALUES(1,77,2,'{"days":["周一"]}',1)`,
  ).run();
  assert.equal(
    db
      .prepare(
        `SELECT MAX(version) AS v FROM tool_run_pcal_edits WHERE run_id=77`,
      )
      .get().v,
    2,
  );
});

test("用例C：健康库重复跑 migrateV2 幂等——库结构与业务数据零变化", () => {
  const snapshot = () => ({
    schema: db
      .prepare(`SELECT type,name,sql FROM sqlite_master ORDER BY type,name`)
      .all(),
    counts: [
      "tool_runs",
      "tool_run_events",
      "toolbox_automation_runs",
      "tool_run_pcal_edits",
    ].map(
      (table) =>
        db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c,
    ),
  });
  const before = snapshot();
  migrateV2();
  assert.deepEqual(snapshot(), before);
});

test.after(() => {
  db.close();
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
});
