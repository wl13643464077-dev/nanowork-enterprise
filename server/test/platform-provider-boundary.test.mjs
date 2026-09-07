import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const databasePath = path.join(os.tmpdir(), `platform-provider-boundary-${process.pid}.db`);
process.env.NANOWORK_DB = databasePath;
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.ENABLE_SCHEDULER = 'false';
process.env.YUNWU_API_KEY = '';
const { db, q, qRaw, initSchema, migrateV2, runWithTenant, setConfig, getConfig } = await import('../src/db.js');
initSchema(); migrateV2();
const { seed } = await import('../src/seed.js');
seed();
const admin = (await import('../src/routes/admin.js')).default;
const system = (await import('../src/routes/system.js')).default;
const auth = (await import('../src/routes/auth.js')).default;
const workbench = (await import('../src/routes/employee-workbench.js')).default;
const contentWorkbench = (await import('../src/routes/content-employee-workbench.js')).default;
const agents = (await import('../src/routes/agents.js')).default;
const { allowedModelCatalog, routing, isAllowedModel } = await import('../src/engines/yunwu.js');
const tenant2 = Number(qRaw.run("INSERT INTO tenants(name,status,credits) VALUES('隔离企业','已开通',100000)").lastInsertRowid);
function actor(role, tenant = 1) {
  const id = Number(qRaw.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES(?,?,?,?, '启用',?)",
    `boundary_${role}_${tenant}`, 'original-password-hash', role, role, tenant).lastInsertRowid);
  return { id, role, tenant_id: tenant, name: role };
}
const superUser = actor('platform_super');
const tenantActors = [1, tenant2].flatMap(tid => ['boss', 'admin', 'manager', 'ops_director', 'sales', 'partner'].map(role => actor(role, tid)));
const boss = tenantActors.find(user => user.role === 'boss' && user.tenant_id === 1);
// 此用例需要多种角色同时存在，显式提供隔离测试额度，不能依赖旧企业1自动999席。
for (const tid of [1, tenant2]) q.run('UPDATE tenants SET seat_limit=30,primary_user_id=? WHERE id=?',
  tenantActors.find(user => user.role === 'boss' && user.tenant_id === tid).id, tid);
const { holdCredits, releaseHold } = await import('../src/engines/credits.js');
q.run('UPDATE tenants SET credits=100000 WHERE id=1');
releaseHold(holdCredits({ userId: boss.id, kind: 'text', model: 'gpt-5.5', credits: 1, feature: '隔离测试初始化' }), '测试初始化后释放');
const nativeFetch = globalThis.fetch;
async function serverFor(user, fn) {
  const app = express(); app.use(express.json({ limit: '2mb' }));
  app.use('/auth', auth);
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => { req.user = user; next(); }));
  app.use('/admin', admin); app.use('/sys', system); app.use('/workbench', workbench);
  app.use('/content-workbench', contentWorkbench); app.use('/agents', agents);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await fn(async (route, method = 'GET', body) => {
      const response = await nativeFetch(`http://127.0.0.1:${server.address().port}${route}`, {
        method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test('所有企业角色（包括企业1老板和管理员）不能读取、写入、测试平台通道或取得整库备份', async () => {
  setConfig('yunwu_base_url', 'https://private-provider.invalid/v1');
  const before = JSON.stringify(q.all('SELECT * FROM sys_config ORDER BY key'));
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw new Error('unauthorized provider call'); };
  try {
    for (const user of tenantActors) await serverFor(user, async request => {
      for (const [route, method, body] of [
        ['/admin/api-config', 'GET'], ['/admin/api-config', 'PUT', { apiKey: 'evil', baseUrl: 'https://evil.invalid', routing: { text: { boss: 'evil' } } }],
        ['/admin/api-config/legacy-key', 'DELETE'], ['/admin/api-config/test', 'POST', {}],
        ['/admin/api-config/amap/test', 'POST', {}], ['/admin/web-search/test', 'POST', {}],
        ['/sys/backup', 'POST'], ['/sys/backups', 'GET'],
      ]) assert.equal((await request(route, method, body)).status, 403, `${user.role}/${user.tenant_id}: ${route}`);
    });
  } finally { globalThis.fetch = nativeFetch; }
  assert.equal(providerCalls, 0);
  assert.equal(JSON.stringify(q.all('SELECT * FROM sys_config ORDER BY key')), before);
  await serverFor(superUser, async request => {
    assert.equal((await request('/admin/api-config')).status, 200);
    assert.equal((await request('/admin/api-config', 'PUT', { routing: { text: { manager: 'deepseek-v4-flash' } } })).status, 200);
    assert.equal((await request('/sys/backups')).status, 200);
  });
});

test('企业用户管理不可接管同企业超管或注入超管角色、跨企业归属', async () => {
  const before = { ...q.get('SELECT * FROM users WHERE id=?', superUser.id) };
  for (const user of tenantActors.filter(user => ['boss', 'admin'].includes(user.role))) await serverFor(user, async request => {
    for (const prefix of ['/admin', '/sys']) {
      const changed = await request(`${prefix}/users/${superUser.id}`, 'PUT', { password: 'attacker-password-123', role: 'boss', tenant_id: tenant2 });
      assert.equal(changed.status, user.tenant_id === 1 ? 403 : 404);
      const injected = await request(`${prefix}/users`, 'POST', { username: 'injected_super', password: 'attacker-password-123', name: 'Injected', role: 'platform_super', tenant_id: 1 });
      assert.equal(injected.status, 400);
    }
  });
  assert.deepEqual({ ...q.get('SELECT * FROM users WHERE id=?', superUser.id) }, before);
  await serverFor(boss, async request => {
    const made = await request('/sys/users', 'POST', { username: 'boundary_local_only', password: 'test-password-123', name: '本企业员工', role: 'sales', tenantId: tenant2, tenant_id: tenant2 });
    assert.equal(made.status, 200);
    assert.equal(q.get('SELECT tenant_id FROM users WHERE id=?', made.body.id).tenant_id, 1);
    const invalidInvite = await request('/auth/register', 'POST', { company: '注册隔离测试', contactName: '测试人', phone: '13812345678', username: 'boundary_registered', password: 'test-password-123', role: 'platform_super', tenantId: 1, tenant_id: 1, inviteCode: 'attacker' });
    assert.equal(invalidInvite.status, 400, '无效邀请码不能退回普通申请流程');
    assert.equal(q.get("SELECT COUNT(*) n FROM users WHERE username='boundary_registered'").n, 0);
    const registered = await request('/auth/register', 'POST', { company: '注册隔离测试', contactName: '测试人', phone: '13812345678', username: 'boundary_registered', password: 'test-password-123', role: 'platform_super', tenantId: 1, tenant_id: 1 });
    assert.equal(registered.status, 200, JSON.stringify(registered.body));
    const created = q.get("SELECT role,tenant_id FROM users WHERE username='boundary_registered'");
    assert.equal(created.role, 'boss'); assert.notEqual(created.tenant_id, 1); assert.notEqual(created.tenant_id, tenant2);
  });
});

test('企业模型偏好只接受精确目录且只写本租户；员工配置和工作流导入不能旁路', async () => {
  const globals = getConfig('model_routing');
  assert.equal(isAllowedModel('video', 'kling-attacker-model'), false);
  assert.equal(isAllowedModel('video', 'wan-private-proxy'), false);
  assert.ok(allowedModelCatalog().video.every(item => item.supported));
  await serverFor(boss, async request => {
    const good = await request('/admin/model-routing', 'PUT', { routing: { text: { boss: 'deepseek-v4-flash', manager: 'gpt-5.5' }, vision: 'gpt-5.5', image: 'gpt-image-2', videoDefault: 'MiniMax-Hailuo-2.3' } });
    assert.equal(good.status, 200, JSON.stringify(good.body));
    for (const value of [{ video: ['kling-attacker-model'] }, { provider: 'attacker' }, { baseUrl: 'https://evil.invalid' }, { text: { platform_super: 'gpt-5.5' } }])
      assert.equal((await request('/admin/model-routing', 'PUT', { routing: value })).status, 400);
    assert.equal((await request('/admin/model-routing', 'PUT', { routing: { image: 'gpt-image-2' }, tenantId: tenant2 })).status, 400);
    assert.equal((await request('/workbench/restaurant/101/config', 'PUT', { values: { textModel: 'attacker-model' } })).status, 400);
    assert.equal((await request('/workbench/restaurant/101/config', 'PUT', { values: { visionModel: 'https://evil.invalid' } })).status, 400);
    assert.equal((await request('/content-workbench/3/config', 'PUT', { values: { textModel: 'attacker-model' } })).status, 400);
    const imported = await request('/agents/import', 'POST', { workflow: { name: '偷渡配置', steps: [{ prompt: '生成正文' }], provider: { baseUrl: 'https://evil.invalid', apiKey: 'evil' } } });
    assert.equal(imported.status, 400);
    assert.equal(imported.body.code, 'AGENT_IMPORT_PROVIDER_CONFIG_FORBIDDEN');
  });
  assert.equal(routing(1).text.boss, 'deepseek-v4-flash');
  assert.equal(routing(tenant2).text.boss, 'gpt-5.5');
  assert.deepEqual(getConfig('model_routing'), globals);
});

test('企业状态只返回业务摘要，平台对账可显式选企业且企业不可越权或自行调账', async () => {
  await serverFor(boss, async request => {
    for (const route of ['/sys/runtime-readiness', '/sys/status', '/admin/runtime-readiness', '/admin/overview']) {
      const result = await request(route); assert.equal(result.status, 200);
      assert.doesNotMatch(JSON.stringify(result.body), /private-provider|baseUrl|keySource|configFingerprint|claude-opus|process_environment/);
    }
    const own = await request('/sys/billing/reconciliation'); assert.equal(own.status, 200); assert.equal(own.body.canResolve, false);
    const creditsBefore = q.get('SELECT credits FROM tenants WHERE id=1').credits;
    assert.equal((await request('/admin/credits/adjust', 'POST', { userId: boss.id, delta: 100000, note: '伪造充值' })).status, 403);
    assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, creditsBefore);
    assert.equal((await request(`/sys/billing/reconciliation?tenantId=${tenant2}`)).status, 403);
    assert.equal((await request('/sys/billing/reconciliation/1/resolve', 'POST', { tenantId: tenant2, action: 'release' })).status, 403);
  });
  await serverFor(superUser, async request => {
    const result = await request(`/sys/billing/reconciliation?tenantId=${tenant2}`);
    assert.equal(result.status, 200); assert.equal(result.body.canResolve, true); assert.equal(result.body.tenantId, tenant2);
    assert.equal((await request('/sys/billing/reconciliation?tenantId=999999')).status, 404);
    assert.equal((await request('/sys/billing/reconciliation/1/resolve', 'POST', { tenantId: 999999 })).status, 404);
  });
});

after(() => { db.close(); removeTempDbSafely(databasePath); });
