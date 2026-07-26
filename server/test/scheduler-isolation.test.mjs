import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DBP = path.join(os.tmpdir(), `shanmei-scheduler-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
const { runScheduledJobs } = await import('../src/engines/scheduler.js');

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'企业一','已开通',10000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(2,'企业二','已开通',10000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);
const user1 = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'tenant-one-user', hashPassword('Secret123!'), '企业一员工', 'sales', '启用', 1).lastInsertRowid;
const user2 = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'tenant-two-user', hashPassword('Secret123!'), '企业二员工', 'sales', '启用', 2).lastInsertRowid;
runWithTenant(1, () => q.run(`INSERT INTO leads(name,stage,owner_id,next_follow_at) VALUES('企业一客户','已沟通',?,'2020-01-01 09:00:00')`, user1));
runWithTenant(2, () => q.run(`INSERT INTO leads(name,stage,owner_id,next_follow_at) VALUES('企业二客户','已沟通',?,'2020-01-01 09:00:00')`, user2));

test('定时提醒按租户隔离，同一小时重试不重复发送', () => {
  const now = new Date('2026-07-13T01:00:10.000Z'); // 上海2026-07-13 09:00
  const first = runScheduledJobs(now);
  assert.deepEqual(first.results.map(item => item.tenantId), [1, 2]);
  assert.equal(q.get(`SELECT COUNT(*) n FROM notifications WHERE tenant_id=1 AND user_id=?`, user1).n, 1);
  assert.equal(q.get(`SELECT COUNT(*) n FROM notifications WHERE tenant_id=2 AND user_id=?`, user2).n, 1);
  assert.equal(q.get(`SELECT COUNT(*) n FROM notifications WHERE tenant_id=1 AND user_id=?`, user2).n, 0);

  runScheduledJobs(now);
  assert.equal(q.get(`SELECT COUNT(*) n FROM notifications WHERE tenant_id=1`).n, 1);
  assert.equal(q.get(`SELECT COUNT(*) n FROM notifications WHERE tenant_id=2`).n, 1);
});

test('每日作战计划逐租户生成且幂等', () => {
  const now = new Date('2026-07-12T22:30:15.000Z'); // 上海2026-07-13 06:30
  runScheduledJobs(now);
  runScheduledJobs(now);
  assert.equal(q.get(`SELECT COUNT(*) n FROM battle_plans WHERE tenant_id=1 AND date='2026-07-13'`).n, 1);
  assert.equal(q.get(`SELECT COUNT(*) n FROM battle_plans WHERE tenant_id=2 AND date='2026-07-13'`).n, 1);
  assert.equal(q.get(`SELECT COUNT(*) n FROM scheduled_runs WHERE tenant_id=1 AND job_key='battle-plan:2026-07-13'`).n, 1);
  assert.equal(q.get(`SELECT COUNT(*) n FROM scheduled_runs WHERE tenant_id=2 AND job_key='battle-plan:2026-07-13'`).n, 1);
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});
