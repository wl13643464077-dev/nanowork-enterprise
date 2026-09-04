import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stageServerRuntime } from './helpers/stage-server-runtime.mjs';

const DBP = path.join(os.tmpdir(), `shanmei-baseline-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;
process.env.NODE_ENV = 'production';

const stage = stageServerRuntime();
const { db, initSchema, migrateV2, q } = await import(pathToFileURL(path.join(stage.serverDir, 'src/db.js')));
const { ensureBaselineCatalogs } = await import(pathToFileURL(path.join(stage.serverDir, 'src/baseline.js')));

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

test('生产基础目录独立于演示数据，且重复执行不覆盖现有配置', () => {
  assert.equal(q.get('SELECT COUNT(*) n FROM users').n, 0);
  assert.equal(q.get('SELECT COUNT(*) n FROM leads').n, 0);
  assert.equal(q.get('SELECT COUNT(*) n FROM activities').n, 0);
  assert.equal(q.get('SELECT COUNT(*) n FROM kb_docs').n, 0);
  assert.equal(q.get(`SELECT COUNT(*) n FROM marshals WHERE code LIKE 'M-__' AND online=1`).n, 8);
  assert.equal(q.get('SELECT COUNT(*) n FROM specialists WHERE employee_idx IS NOT NULL').n, 61);
  assert.equal(q.get('SELECT MIN(employee_idx) n FROM specialists').n, 101);
  assert.equal(q.get('SELECT MAX(employee_idx) n FROM specialists').n, 161);
  assert.equal(q.get('SELECT data_mode FROM tenants WHERE id=1').data_mode, 'live');
  assert.throws(() => q.run(`UPDATE tenants SET data_mode='unknown' WHERE id=1`), /CHECK constraint failed/);
  assert.equal(q.get(`SELECT COUNT(*) n FROM prompts WHERE code IN ('PROMPT-01','PROMPT-02','PROMPT-03')`).n, 3);
  assert.equal(JSON.parse(q.get(`SELECT value FROM sys_config WHERE key='month_revenue_target'`).value), 500000);
  assert.ok(q.get(`SELECT prompt FROM marshals WHERE code='M-01'`).prompt);

  q.run(`UPDATE marshals SET name='企业自定义总指挥' WHERE code='M-01'`);
  q.run(`UPDATE prompts SET style='企业自定义风格' WHERE code='PROMPT-03'`);
  ensureBaselineCatalogs();

  assert.equal(q.get(`SELECT name FROM marshals WHERE code='M-01'`).name, '企业自定义总指挥');
  assert.equal(q.get(`SELECT style FROM prompts WHERE code='PROMPT-03'`).style, '企业自定义风格');
  assert.equal(q.get(`SELECT COUNT(*) n FROM marshals WHERE code LIKE 'M-__' AND online=1`).n, 8);
  assert.equal(q.get('SELECT COUNT(*) n FROM specialists WHERE employee_idx IS NOT NULL').n, 61);
});

test('cleanup', () => {
  db.close();
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  stage.cleanup();
});
