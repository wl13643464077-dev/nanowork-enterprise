/**
 * POST /api/admin/api-config/amap/test 权限与状态翻转：
 * - 仅 boss/admin 且平台总部（租户 1）可调用；
 * - 未配置密钥不发起外网、不记录进程检查；
 * - 成功 → connected 并落 sys_config.amap_verified_at；配额超限 → blocked；
 * - 响应与就绪矩阵永不泄露密钥。全部 mock fetch，零外网。
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const nativeFetch = globalThis.fetch;
const DBP = path.join(os.tmpdir(), `nanowork-admin-amap-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) fs.rmSync(file, { force: true });
const originalEnv = {
  NANOWORK_DB: process.env.NANOWORK_DB,
  ENABLE_SCHEDULER: process.env.ENABLE_SCHEDULER,
  AMAP_WEB_KEY: process.env.AMAP_WEB_KEY,
  AMAP_BASE_URL: process.env.AMAP_BASE_URL,
};
process.env.NANOWORK_DB = DBP;
process.env.ENABLE_SCHEDULER = 'false';
process.env.AMAP_WEB_KEY = '';
process.env.AMAP_BASE_URL = '';

const { initSchema, migrateV2, q, runWithTenant, getConfig } = await import('../src/db.js');
const adminRoutes = (await import('../src/routes/admin.js')).default;
const { clearRuntimeReadinessChecks } = await import('../src/engines/runtime-readiness.js');
const { resetAmapRuntimeState } = await import('../src/engines/amap.js');

initSchema();
migrateV2();
for (const [id, name] of [[1, '平台总部'], [2, '普通企业']]) {
  q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(?,?,'已开通',10000)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status`, id, name);
}
function makeUser(username, role, tenantId) {
  const id = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES(?,?,?,?,'启用',?)`, username, 'unused', username, role, tenantId).lastInsertRowid);
  return q.get('SELECT id,name,username,role,tenant_id FROM users WHERE id=?', id);
}
const hqBoss = makeUser('amap-hq-boss', 'boss', 1);
const hqManager = makeUser('amap-hq-manager', 'manager', 1);
const tenantBoss = makeUser('amap-tenant-boss', 'boss', 2);

const AMAP_KEY = 'amap-admin-route-key-must-never-leak';

function makeApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => {
    req.user = { ...user, ip: '127.0.0.1' };
    next();
  }));
  app.use('/admin', adminRoutes);
  return app;
}

async function post(user, pathname = '/admin/api-config/amap/test') {
  const server = makeApp(user).listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try {
    const response = await nativeFetch(`http://127.0.0.1:${port}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return { status: response.status, json: await response.json().catch(() => ({})) };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function amapOk() {
  return Response.json({
    status: '1',
    infocode: '10000',
    geocodes: [{ location: '116.48,39.99', adcode: '110105', formatted_address: '北京市朝阳区阜通东大街6号' }],
  });
}

beforeEach(() => {
  clearRuntimeReadinessChecks();
  resetAmapRuntimeState();
  globalThis.fetch = nativeFetch;
  process.env.AMAP_WEB_KEY = '';
});

test('非 boss/admin 角色与非总部租户均被拒绝，且不触发任何高德请求', async () => {
  process.env.AMAP_WEB_KEY = AMAP_KEY;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return amapOk();
  };
  const manager = await post(hqManager);
  assert.equal(manager.status, 403);
  assert.match(manager.json.error, /无权限/u);
  const tenant = await post(tenantBoss);
  assert.equal(tenant.status, 403);
  assert.match(tenant.json.error, /平台总部/u);
  assert.equal(fetchCalls, 0);
});

test('未配置密钥：返回 configured=false 与 disabled 就绪状态，不联网', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('must not call');
  };
  const result = await post(hqBoss);
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.configured, false);
  assert.match(result.json.error, /AMAP_WEB_KEY 未配置/u);
  assert.equal(result.json.readiness.key, 'amap');
  assert.equal(result.json.readiness.effective, 'disabled');
  assert.equal(result.json.readiness.verification, 'not_applicable');
  assert.equal(fetchCalls, 0);
});

test('总部 boss 测试成功 → connected + sys_config.amap_verified_at；再次 10003 → blocked 并作废持久化验证', async () => {
  process.env.AMAP_WEB_KEY = AMAP_KEY;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/v3/geocode/geo');
    assert.equal(url.searchParams.get('key'), AMAP_KEY);
    return amapOk();
  };
  let result = await post(hqBoss);
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.configured, true);
  assert.equal(result.json.blocked, false);
  assert.equal(result.json.adcode, '110105');
  assert.equal(result.json.endpoint, '/v3/geocode/geo');
  assert.equal(result.json.readiness.effective, 'connected');
  assert.equal(result.json.readiness.connected, true);
  assert.equal(result.json.readiness.lastCheck.outcome, 'passed');
  assert.doesNotMatch(JSON.stringify(result.json), /must-never-leak/u);
  const verifiedAt = getConfig('amap_verified_at', '');
  assert.ok(verifiedAt && !Number.isNaN(Date.parse(verifiedAt)), 'amap_verified_at 必须是 ISO 时间');
  assert.ok(getConfig('amap_verified_fingerprint', ''));

  globalThis.fetch = async () => Response.json({ status: '0', info: 'DAILY_QUERY_OVER_LIMIT', infocode: '10003' });
  result = await post(hqBoss);
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.blocked, true);
  assert.equal(result.json.quotaExceeded, true);
  assert.equal(result.json.infocode, '10003');
  assert.match(result.json.error, /日配额/u);
  assert.equal(result.json.readiness.effective, 'blocked');
  assert.equal(result.json.readiness.lastCheck.outcome, 'failed');
  assert.equal(result.json.readiness.lastCheck.evidence.blocked, true);
  assert.equal(getConfig('amap_verified_at', ''), '');

  // 非 blocked 的普通失败（HTTP 500）只记 failed，仍为 configured_unverified
  clearRuntimeReadinessChecks();
  resetAmapRuntimeState();
  globalThis.fetch = async () => new Response('bad gateway', { status: 502 });
  result = await post(hqBoss);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.blocked, false);
  assert.equal(result.json.readiness.effective, 'configured_unverified');
  assert.equal(result.json.readiness.verification, 'failed');
});

after(async () => {
  globalThis.fetch = nativeFetch;
  clearRuntimeReadinessChecks();
  resetAmapRuntimeState();
  await removeTempDbSafely(DBP);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
