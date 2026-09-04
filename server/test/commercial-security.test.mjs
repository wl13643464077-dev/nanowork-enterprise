import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { assertPrivateArtifact } from '../src/engines/private-artifact.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const DBP = path.join(os.tmpdir(), `shanmei-commercial-security-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) fs.rmSync(file, { force: true });
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant, getConfig, mergeMarshal } = await import('../src/db.js');
const { seed } = await import('../src/seed.js');
const { hashPassword } = await import('../src/util.js');
const { charge } = await import('../src/engines/credits.js');
const adminRoutes = (await import('../src/routes/admin.js')).default;
const rechargeRoutes = (await import('../src/routes/recharge.js')).default;
const systemRoutes = (await import('../src/routes/system.js')).default;
const dashboardRoutes = (await import('../src/routes/dashboard.js')).default;

initSchema();
migrateV2();
seed();
const hqBoss = q.get("SELECT id,name,username,role,tenant_id FROM users WHERE tenant_id=1 AND role='boss' ORDER BY id LIMIT 1");
const hqOps = q.get("SELECT id,name,username,role,tenant_id FROM users WHERE tenant_id=1 AND role='ops_director' ORDER BY id LIMIT 1");
const hqAdmin = q.get("SELECT id,name,username,role,tenant_id FROM users WHERE tenant_id=1 AND role='admin' ORDER BY id LIMIT 1");
const hqSales = q.get("SELECT id,name,username,role,tenant_id FROM users WHERE tenant_id=1 AND role='sales' ORDER BY id LIMIT 1");
const tenant2 = Number(q.run("INSERT INTO tenants(name,status,credits) VALUES('安全测试企业','已开通',10000)").lastInsertRowid);
const tenantBossId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'security_t2_boss', hashPassword('Commercial-Test-Password-1'), '乙企业老板', 'boss', '启用', tenant2).lastInsertRowid);
const tenantBoss = q.get('SELECT id,name,username,role,tenant_id FROM users WHERE id=?', tenantBossId);
const platformSuperId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,1)`, 'security_platform_super', hashPassword('Commercial-Test-Password-2'), '平台超管', 'platform_super', '启用').lastInsertRowid);
const platformSuper = q.get('SELECT id,name,username,role,tenant_id FROM users WHERE id=?', platformSuperId);
const createdBackups = [];

function makeApp(user) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => {
    req.user = { ...user, ip: '127.0.0.1' };
    next();
  }));
  app.use('/admin', adminRoutes);
  app.use('/recharge', rechargeRoutes);
  app.use('/sys', systemRoutes);
  app.use('/dashboard', dashboardRoutes);
  return app;
}

async function withServer(user, fn) {
  const server = makeApp(user).listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function request(base, url, method = 'GET', body, expectedStatus = 200) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  assert.equal(response.status, expectedStatus, `${method} ${url}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

test('平台模型密钥与计费配置不能被客户租户修改，BaseURL 拒绝内网地址', async () => {
  await withServer(tenantBoss, async base => {
    await request(base, '/admin/api-config', 'GET', undefined, 403);
    await request(base, '/admin/api-config', 'PUT', { apiKey: 'attacker-controlled-secret', billing: { creditYuan: 999 } }, 403);
  });
  assert.notEqual(getConfig('yunwu_api_key', ''), 'attacker-controlled-secret');
  await withServer(hqBoss, async base => {
    await request(base, '/admin/api-config', 'PUT', { baseUrl: 'http://127.0.0.1:9999/v1' }, 400);
    await request(base, '/sys/config', 'PUT', { arbitrary_global_key: 'forbidden' }, 400);
  });
});

test('元帅上下线状态保存在租户覆盖层，不再污染全平台基线', async () => {
  const marshal = q.get('SELECT id,code,online FROM marshals ORDER BY id LIMIT 1');
  await withServer(tenantBoss, async base => {
    await request(base, `/admin/marshals/${marshal.id}`, 'PUT', { online: !marshal.online });
  });
  assert.equal(q.get('SELECT online FROM marshals WHERE id=?', marshal.id).online, marshal.online);
  const tenantValue = runWithTenant(tenant2, () => mergeMarshal({ ...q.get('SELECT * FROM marshals WHERE id=?', marshal.id) }).online);
  const hqValue = runWithTenant(1, () => mergeMarshal({ ...q.get('SELECT * FROM marshals WHERE id=?', marshal.id) }).online);
  assert.equal(tenantValue, marshal.online ? 0 : 1);
  assert.equal(hqValue, marshal.online);
});

test('充值后台由服务端限制为老板/管理员，普通员工无法读取企业账单', async () => {
  await withServer(hqSales, async base => {
    await request(base, '/recharge/packages', 'GET', undefined, 403);
    await request(base, '/recharge/balance', 'GET', undefined, 403);
  });
  await withServer(hqBoss, async base => {
    const packages = await request(base, '/recharge/packages');
    assert.ok(packages.length > 0);
  });
});

test('平台超管只走平台控制台，不得进入企业管理后台或企业充值中心', async () => {
  await withServer(platformSuper, async base => {
    await request(base, '/admin/overview', 'GET', undefined, 403);
    await request(base, '/recharge/packages', 'GET', undefined, 403);
    await request(base, '/recharge/balance', 'GET', undefined, 403);
  });
});

test('员工不能读取管理层审批、提示词、系统状态和老板经营简报', async () => {
  await withServer(hqSales, async base => {
    await request(base, '/sys/approvals', 'GET', undefined, 403);
    await request(base, '/sys/prompts', 'GET', undefined, 403);
    await request(base, '/sys/status', 'GET', undefined, 403);
    await request(base, '/dashboard/briefing', 'GET', undefined, 403);
    const widgets = await request(base, '/dashboard/widgets/preferences');
    assert.ok(!widgets.available.some(item => item.key === 'briefing'));
    assert.ok(!widgets.selected.includes('briefing'));
    const todos = await request(base, '/dashboard/todos');
    assert.equal(todos.silentPartners, 0);
    assert.equal(todos.bossLeads, 0);
  });
});

test('提示词载入状态仅老板、管理员和平台超管可读，运营负责人无权访问', async () => {
  await withServer(hqOps, async base => {
    await request(base, '/sys/marshal-prompts/status', 'GET', undefined, 403);
    await request(base, '/sys/prompts', 'GET', undefined, 403);
  });
  for (const user of [hqBoss, hqAdmin, platformSuper]) {
    await withServer(user, async base => {
      const status = await request(base, '/sys/marshal-prompts/status');
      assert.ok(Array.isArray(status));
      await request(base, '/sys/prompts');
    });
  }
});

test('整库备份仅总部运维可执行，快照包含 WAL 最新数据且完整性校验通过', async () => {
  q.run("INSERT INTO kb_docs(category,title,body,enabled) VALUES('安全测试','WAL备份标识','必须进入一致性快照',1)");
  await withServer(tenantBoss, async base => {
    await request(base, '/sys/backup', 'POST', undefined, 403);
  });
  await withServer(hqBoss, async base => {
    const result = await request(base, '/sys/backup', 'POST');
    assert.equal(result.integrity, 'ok');
    const backupPath = path.join(path.dirname(DBP), result.file);
    createdBackups.push(backupPath);
    assertPrivateArtifact(backupPath);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(Object.values(backup.prepare('PRAGMA integrity_check').get())[0], 'ok');
      assert.equal(backup.prepare("SELECT body FROM kb_docs WHERE title='WAL备份标识'").get().body, '必须进入一致性快照');
    } finally { backup.close(); }
  });
});

test('实际扣费使用条件更新，余额不足时不产生负数或伪流水', () => {
  q.run('UPDATE tenants SET credits=1 WHERE id=1');
  const beforeLogs = q.get('SELECT COUNT(*) AS n FROM credit_logs WHERE tenant_id=1').n;
  assert.throws(() => charge({
    userId: hqBoss.id,
    feature: '并发扣费保护测试',
    kind: 'text',
    model: 'gpt-5.5',
    usage: { inputTokens: 100000, outputTokens: 100000 },
    aiMode: 'api',
  }), error => error?.status === 402);
  assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, 1);
  assert.equal(q.get('SELECT COUNT(*) AS n FROM credit_logs WHERE tenant_id=1').n, beforeLogs);
});

after(async () => {
  for (const file of createdBackups) fs.rmSync(file, { force: true });
  await removeTempDbSafely(DBP);
});
