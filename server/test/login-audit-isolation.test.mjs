import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `shanmei-login-audit-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
const systemRoutes = (await import('../src/routes/system.js')).default;

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status) VALUES(1,'审计租户一','已开通')
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status`);
q.run(`INSERT INTO tenants(id,name,status) VALUES(2,'审计租户二','已开通')
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status`);
const boss1 = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'audit-boss-1', hashPassword('Secret123!'), '审计老板一', 'boss', '启用', 1).lastInsertRowid;
const boss2 = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'audit-boss-2', hashPassword('Secret123!'), '审计老板二', 'boss', '启用', 2).lastInsertRowid;

q.run(`INSERT INTO login_logs(tenant_id,username,success,ip,ua,created_at)
  VALUES(1,'audit-boss-1',1,'10.0.0.1','test',datetime('now','localtime'))`);
q.run(`INSERT INTO login_logs(tenant_id,username,success,ip,ua,created_at)
  VALUES(2,'audit-boss-2',1,'10.0.0.2','test',datetime('now','localtime'))`);
q.run(`INSERT INTO login_logs(tenant_id,username,success,ip,ua,created_at)
  VALUES(2,'audit-staff-2',1,'10.0.0.3','test',datetime('now','localtime'))`);

function appFor(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => { req.user = user; next(); }));
  app.use('/sys', systemRoutes);
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('登录审计日志和在线人数严格按租户隔离', async () => {
  await withServer({ id: boss1, name: '审计老板一', role: 'boss', tenant_id: 1 }, async base => {
    const logs = await fetch(`${base}/sys/login-logs`).then(response => response.json());
    assert.deepEqual(logs.map(row => row.username), ['audit-boss-1']);
    const status = await fetch(`${base}/sys/status`).then(response => response.json());
    assert.equal(status.online, 1);
  });

  await withServer({ id: boss2, name: '审计老板二', role: 'boss', tenant_id: 2 }, async base => {
    const logs = await fetch(`${base}/sys/login-logs`).then(response => response.json());
    assert.deepEqual(new Set(logs.map(row => row.username)), new Set(['audit-boss-2', 'audit-staff-2']));
    assert.ok(logs.every(row => Number(row.tenant_id) === 2));
    const status = await fetch(`${base}/sys/status`).then(response => response.json());
    assert.equal(status.online, 2);
  });
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});
