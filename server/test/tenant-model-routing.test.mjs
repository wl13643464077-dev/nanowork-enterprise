// 租户级模型路由：默认行为不变、租户覆盖生效且隔离、白名单外模型 400、恢复默认。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-tenant-routing-${process.pid}.db`);
for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;

const { initSchema, migrateV2, q, qRaw, runWithTenant, setConfig } = await import('../src/db.js');
initSchema();
migrateV2();
const yunwu = await import('../src/engines/yunwu.js');
const adminRoutes = (await import('../src/routes/admin.js')).default;

const { routing, textModelFor, routingSources, allowedModelCatalog, isAllowedModel, tenantRoutingOverride } = yunwu;
const DEFAULT_TEXT = { boss: 'gpt-5.5', ops_director: 'gpt-5.5', manager: 'gpt-5.5', sales: 'deepseek-v4-flash', admin: 'deepseek-v4-flash', partner: 'deepseek-v4-flash' };

qRaw.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'总部','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET status='已开通',credits=100000`);
const T2 = Number(qRaw.run("INSERT INTO tenants(name,status,credits) VALUES('路由企业A','已开通',100000)").lastInsertRowid);
const T3 = Number(qRaw.run("INSERT INTO tenants(name,status,credits) VALUES('路由企业B','已开通',100000)").lastInsertRowid);
const boss2 = Number(qRaw.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES('rt_boss_a','x','老板A','boss','启用',?)", T2).lastInsertRowid);
const boss3 = Number(qRaw.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES('rt_boss_b','x','老板B','boss','启用',?)", T3).lastInsertRowid);

function makeApp(tenantId, user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(tenantId, () => { req.user = user; next(); }));
  app.use('/admin', adminRoutes);
  return app;
}
async function withServer(tenantId, user, fn) {
  const server = makeApp(tenantId, user).listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
async function request(base, route, method = 'GET', body) {
  const response = await fetch(`${base}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

test('无租户覆盖时路由与历史行为完全一致（DEFAULT_ROUTING 锁定）', () => {
  const r = routing(T2);
  assert.deepEqual(r.text, DEFAULT_TEXT);
  assert.equal(r.image, 'gpt-image-2');
  assert.equal(r.vision, 'gemini-3.1-flash-lite');
  assert.equal(r.videoDefault, 'happyhorse-1.0-t2v:floor');
  assert.equal(r.deepThink, 'gpt-5.5');
  assert.ok(r.video.includes('MiniMax-Hailuo-2.3'));
  assert.equal(textModelFor('boss', T2), 'gpt-5.5');
  assert.equal(textModelFor('sales', T2), 'deepseek-v4-flash');
  // 无显式租户参数时走 curTenant()（无上下文=1），结果同样等于默认
  assert.deepEqual(routing().text, DEFAULT_TEXT);
  const src = routingSources(T2);
  assert.equal(src.hasTenantOverride, false);
  assert.equal(src.text.boss, 'default');
  assert.equal(src.image, 'default');
});

test('白名单由 yunwu 导出：文本/图片/识图/视频四类，video 与 routing().video 同源', () => {
  const catalog = allowedModelCatalog();
  assert.ok(catalog.text.some(m => m.id === 'gpt-5.5'));
  assert.ok(catalog.text.some(m => m.id === 'deepseek-v4-flash'));
  assert.ok(catalog.image.some(m => m.id === 'gpt-image-2'));
  assert.ok(catalog.vision.some(m => m.id === 'gemini-3.1-flash-lite'));
  assert.deepEqual(catalog.video.map(m => m.id).sort(), routing(T2).video.slice().sort());
  assert.equal(isAllowedModel('text', 'gpt-5.5'), true);
  assert.equal(isAllowedModel('text', 'gpt-99-ultra'), false);
  assert.equal(isAllowedModel('video', 'kling-video'), true);
  assert.equal(isAllowedModel('video', 'sora-x'), false);
  assert.equal(isAllowedModel('image', ''), false);
});

test('租户覆盖 > 全局 sys_config 覆盖 > 默认；覆盖只影响本租户', async () => {
  setConfig('model_routing', { text: { manager: 'deepseek-v4-flash' } });
  assert.equal(textModelFor('manager', T2), 'deepseek-v4-flash', '全局覆盖对所有租户生效');
  assert.equal(textModelFor('manager', T3), 'deepseek-v4-flash');

  await withServer(T2, { id: boss2, name: '老板A', role: 'boss', tenant_id: T2 }, async base => {
    const before = await request(base, '/admin/model-routing');
    assert.equal(before.status, 200);
    assert.equal(before.json.override, null);
    assert.equal(before.json.sources.text.manager, 'global');
    assert.ok(Array.isArray(before.json.catalog.text) && before.json.catalog.text[0].pricing.label.includes('积分'));

    const saved = await request(base, '/admin/model-routing', 'PUT', {
      routing: { text: { manager: 'gpt-5.5', sales: 'gemini-3.1-flash-lite' }, vision: 'gpt-5.5', videoDefault: 'MiniMax-Hailuo-2.3' },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.effective.text.manager, 'gpt-5.5');
    assert.equal(saved.json.effective.text.sales, 'gemini-3.1-flash-lite');
    assert.equal(saved.json.effective.text.boss, 'gpt-5.5', '未覆盖角色保持上一层');
    assert.equal(saved.json.effective.vision, 'gpt-5.5');
    assert.equal(saved.json.effective.videoDefault, 'MiniMax-Hailuo-2.3');
    assert.equal(saved.json.sources.text.manager, 'tenant');
    assert.equal(saved.json.sources.text.boss, 'default');
    assert.equal(saved.json.sources.hasTenantOverride, true);
    assert.equal(saved.json.overrideUpdatedBy, boss2);
  });

  // 引擎侧按租户解析
  assert.equal(textModelFor('manager', T2), 'gpt-5.5');
  assert.equal(textModelFor('sales', T2), 'gemini-3.1-flash-lite');
  assert.equal(routing(T2).vision, 'gpt-5.5');
  // 隔离：另一家企业不受影响
  assert.equal(textModelFor('manager', T3), 'deepseek-v4-flash');
  assert.equal(textModelFor('sales', T3), 'deepseek-v4-flash');
  assert.equal(routing(T3).vision, 'gemini-3.1-flash-lite');
  assert.equal(tenantRoutingOverride(T3), null);
  // 请求上下文（curTenant）解析
  runWithTenant(T2, () => assert.equal(textModelFor('sales'), 'gemini-3.1-flash-lite'));
  runWithTenant(T3, () => assert.equal(textModelFor('sales'), 'deepseek-v4-flash'));
  // op_logs 已记
  assert.ok(q.get(`SELECT id FROM op_logs WHERE tenant_id=? AND action='修改企业模型路由'`, T2));
});

test('白名单外模型 / 未知角色 / 未知字段 → 400 且不落库', async () => {
  await withServer(T3, { id: boss3, name: '老板B', role: 'boss', tenant_id: T3 }, async base => {
    const bad1 = await request(base, '/admin/model-routing', 'PUT', { routing: { text: { boss: 'gpt-99-ultra' } } });
    assert.equal(bad1.status, 400);
    assert.match(bad1.json.error, /不在允许清单内/);
    const bad2 = await request(base, '/admin/model-routing', 'PUT', { routing: { image: 'midjourney-v9' } });
    assert.equal(bad2.status, 400);
    const bad3 = await request(base, '/admin/model-routing', 'PUT', { routing: { text: { ceo: 'gpt-5.5' } } });
    assert.equal(bad3.status, 400);
    const bad4 = await request(base, '/admin/model-routing', 'PUT', { routing: { deepThink: 'gpt-5.5' } });
    assert.equal(bad4.status, 400);
    const bad5 = await request(base, '/admin/model-routing', 'PUT', { routing: { videoDefault: 'sora-x' } });
    assert.equal(bad5.status, 400);
  });
  assert.equal(tenantRoutingOverride(T3), null);
  assert.equal(textModelFor('boss', T3), 'gpt-5.5');
});

test('库中残留白名单外模型时回落上一层，不把无效模型送到供应商', () => {
  qRaw.run(`INSERT INTO tenant_model_routing(tenant_id,routing_json) VALUES(?,?)`, T3,
    JSON.stringify({ text: { boss: 'retired-model' }, image: 'retired-image', videoDefault: 'sora-x' }));
  const r = routing(T3);
  assert.equal(r.text.boss, 'gpt-5.5');
  assert.equal(r.image, 'gpt-image-2');
  assert.equal(r.videoDefault, 'happyhorse-1.0-t2v:floor');
  qRaw.run('DELETE FROM tenant_model_routing WHERE tenant_id=?', T3);
});

test('恢复平台默认：删除覆盖行，路由回到全局/默认', async () => {
  await withServer(T2, { id: boss2, name: '老板A', role: 'boss', tenant_id: T2 }, async base => {
    const reset = await request(base, '/admin/model-routing', 'PUT', { reset: true });
    assert.equal(reset.status, 200);
    assert.equal(reset.json.override, null);
    assert.equal(reset.json.sources.hasTenantOverride, false);
  });
  assert.equal(textModelFor('manager', T2), 'deepseek-v4-flash', '回到全局覆盖');
  assert.equal(textModelFor('sales', T2), 'deepseek-v4-flash');
  setConfig('model_routing', {});
  assert.deepEqual(routing(T2).text, DEFAULT_TEXT);
});

test('cleanup', () => {
  for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
});
