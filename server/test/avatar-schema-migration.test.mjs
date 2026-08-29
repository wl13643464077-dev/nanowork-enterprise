import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dbPath = path.join(
  os.tmpdir(),
  `nanowork-avatar-schema-migration-${process.pid}.db`,
);
for (const suffix of ["", "-wal", "-shm"]) {
  fs.rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.NANOWORK_DB = dbPath;

const { db, initSchema, migrateV2 } = await import("../src/db.js");

initSchema();
db.exec(`CREATE TABLE avatar_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  title TEXT NOT NULL,
  image_file_id INTEGER NOT NULL,
  audio_file_id INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  billing_status TEXT NOT NULL DEFAULT 'pending',
  billing_model TEXT NOT NULL,
  held_credits INTEGER NOT NULL DEFAULT 0,
  settled_credits INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0,
  steps_json TEXT NOT NULL DEFAULT '[]',
  provider_name TEXT,
  provider_task_id TEXT,
  provider_result_json TEXT,
  usage_json TEXT,
  cost_json TEXT,
  output_file_id INTEGER,
  result_url TEXT,
  result_sha256 TEXT,
  result_bytes INTEGER,
  error_code TEXT,
  error_message TEXT,
  timeout_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
  updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
);
CREATE INDEX idx_avatar_jobs_tenant_created
  ON avatar_jobs(tenant_id,created_at DESC,id DESC);
CREATE INDEX idx_avatar_jobs_recovery
  ON avatar_jobs(tenant_id,status,billing_status,updated_at);
INSERT INTO avatar_jobs(
  id,tenant_id,created_by,title,image_file_id,audio_file_id,duration_seconds,
  status,billing_status,billing_model,held_credits,progress,steps_json,
  provider_name,provider_task_id
) VALUES(
  7,1,1,'历史 RunningHub 工单',101,102,30,
  'done','settled','runninghub-avatar-30',1800,100,'[]',
  'runninghub','legacy-provider-task'
);`);

test("历史 avatar_jobs 原声工单无损迁移到多引擎与脚本输入结构", () => {
  migrateV2();
  const columns = db.prepare("PRAGMA table_info('avatar_jobs')").all();
  const byName = new Map(columns.map((column) => [column.name, column]));
  assert.equal(Number(byName.get("audio_file_id").notnull), 0);
  for (const name of [
    "input_mode",
    "script",
    "voice_id",
    "prompt",
    "engine_requested",
    "tts_attempt_json",
  ]) {
    assert.ok(byName.has(name), `missing migrated column ${name}`);
  }
  const row = db.prepare("SELECT * FROM avatar_jobs WHERE id=7").get();
  assert.equal(row.title, "历史 RunningHub 工单");
  assert.equal(row.audio_file_id, 102);
  assert.equal(row.input_mode, "audio");
  assert.equal(row.script, "");
  assert.equal(row.voice_id, null);
  assert.equal(row.prompt, "");
  assert.equal(row.engine_requested, "auto");
  assert.equal(row.provider_name, "runninghub");
  assert.equal(row.provider_task_id, "legacy-provider-task");
  assert.equal(row.tts_attempt_json, null);
  assert.equal(row.billing_status, "settled");
  assert.equal(row.held_credits, 1800);

  const indexes = new Set(
    db
      .prepare("PRAGMA index_list('avatar_jobs')")
      .all()
      .map((index) => index.name),
  );
  assert.ok(indexes.has("idx_avatar_jobs_tenant_created"));
  assert.ok(indexes.has("idx_avatar_jobs_recovery"));

  migrateV2();
  assert.equal(
    db.prepare("SELECT COUNT(*) total FROM avatar_jobs WHERE id=7").get().total,
    1,
  );
});

after(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
});
