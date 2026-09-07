// 双供应商管理后台契约：平台分别查看/测试/保存 OpenLux 与 360 并独立改默认；
// 企业只选供应商与模型（预览不落库、保存同事务、另一家偏好保留、reset 清空）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const databasePath = path.join(os.tmpdir(), `dual-provider-admin-${process.pid}.db`);
Object.assign(process.env, {
  NANOWORK_DB: databasePath, NANOWORK_TEST_TEMPLATE_AI: '1', ENABLE_SCHEDULER: 'false', NODE_ENV: 'test',
  // 环境残留仍是 360；显式默认与企业选择必须胜过它。
  NANOWORK_AI_PROVIDER: '360', YUNWU_BASE_URL: 'https://api.360.cn/v1', YUNWU_API_KEY: '',
  AI360_API_KEY: 'sk-360-platform-secret-key-0001', OPENLUX_API_KEY: 'sk-openlux-platform-secret-key-0002',
});
const { db, q, qRaw, initSchema, migrateV2, runWithTenant, getConfig, setConfig } = await import('../src/db.js');
initSchema(); migrateV2();
const admin = (await import('../src/routes/admin.js')).default;
const { routing } = await import('../src/engines/yunwu.js');
const nativeFetch = globalThis.fetch;

const tenant = Number(qRaw.run("INSERT INTO tenants(name,status,credits) VALUES('双供应商企业','已开通',100000)").lastInsertRowid);
function actor(role, tenantId) {
  const id = Number(qRaw.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES(?,?,?,?, '启用',?)",
    `dual_${role}_${tenantId}`, 'x', role, role, tenantId).lastInsertRowid);
  return { id, role, tenant_id: tenantId, name: role };
}
const superUser = actor('platform_super', 1);
const boss = actor('boss', tenant);
q.run('UPDATE tenants SET primary_user_id=? WHERE id=?', boss.id, tenant);

async function serverFor(user, fn) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => { req.user = user; next(); }));
  app.use('/admin', admin);
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
const noSecrets = payload => {
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /sk-360-platform-secret-key-0001|sk-openlux-platform-secret-key-0002/u, '响应不得泄露任何一家完整 Key');
};

test('平台按供应商分别读取通道、模型偏好，并可独立改默认；未配置 Key 的一家不能设为默认', async () => {
  await serverFor(superUser, async request => {
    const legacy = await request('/admin/api-config');
    assert.equal(legacy.status, 200); noSecrets(legacy.body);
    assert.equal(legacy.body.defaultProvider, '360', '未显式设置默认时沿用环境残留的 360');
    assert.equal(legacy.body.selectedProvider, '360');
    assert.deepEqual(legacy.body.providers.map(item => [item.id, item.available]).sort(), [['360', true], ['openlux', true]]);
    assert.equal(legacy.body.channel.baseUrl, 'https://api.360.cn/v1');
    assert.match(legacy.body.channel.key, /^sk-360-p\*\*\*\*0001$/u);

    const openlux = await request('/admin/api-config?provider=openlux');
    assert.equal(openlux.status, 200); noSecrets(openlux.body);
    assert.equal(openlux.body.selectedProvider, 'openlux');
    assert.equal(openlux.body.channel.providerId, 'openlux');
    assert.equal(openlux.body.channel.baseUrl, 'https://api.openlux.ai/v1');
    assert.match(openlux.body.channel.key, /^sk-openl\*\*\*\*0002$/u);
    assert.equal(openlux.body.routing.text.sales, 'deepseek-v4-flash', 'OpenLux 视图给 OpenLux 模型');
    assert.equal(openlux.body.defaultProvider, '360', '查看另一家不改变平台默认');
    assert.equal((await request('/admin/api-config?provider=attacker')).status, 400);

    assert.equal((await request('/admin/api-config', 'PUT', { provider: 'openlux', defaultProvider: 'attacker' })).status, 400);
    const previousKey = process.env.OPENLUX_API_KEY;
    process.env.OPENLUX_API_KEY = '';
    try {
      const blocked = await request('/admin/api-config', 'PUT', { provider: 'openlux', defaultProvider: 'openlux' });
      assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'AI_PROVIDER_UNAVAILABLE');
    } finally { process.env.OPENLUX_API_KEY = previousKey; }
    assert.equal(getConfig('ai_provider_default', null), null);

    const switched = await request('/admin/api-config', 'PUT', { provider: 'openlux', defaultProvider: 'openlux' });
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.equal(getConfig('ai_provider_default'), 'openlux');
    const after = await request('/admin/api-config');
    assert.equal(after.body.defaultProvider, 'openlux'); assert.equal(after.body.selectedProvider, 'openlux');
    assert.equal(after.body.channel.providerId, 'openlux');
    const view360 = await request('/admin/api-config?provider=360');
    assert.equal(view360.body.channel.providerId, '360'); assert.equal(view360.body.defaultProvider, 'openlux');
    assert.equal(view360.body.routing.text.sales, 'deepseek/deepseek-v4-flash', '360 视图给 360 模型，即使平台默认已是 OpenLux');
  });
});

test('平台保存一家的模型偏好只写入该家配置；另一家不受影响且跨家模型被拒绝', async () => {
  await serverFor(superUser, async request => {
    const saved360 = await request('/admin/api-config', 'PUT', { provider: '360', routing: { text: { sales: 'deepseek/deepseek-v4-pro' }, image: 'openai/gpt-image-2', videoDefault: 'alibaba/wan3.0-video' } });
    assert.equal(saved360.status, 200, JSON.stringify(saved360.body)); assert.equal(saved360.body.provider, '360');
    assert.equal(getConfig('model_routing_360').text.sales, 'deepseek/deepseek-v4-pro');
    assert.equal(getConfig('model_routing_openlux', null), null);
    // 已知旧模型名会被迁移到 360 对应产品档位；目录外模型必须被拒绝。
    const wrong = await request('/admin/api-config', 'PUT', { provider: '360', routing: { text: { sales: 'MiniMax-M3-attacker' } } });
    assert.equal(wrong.status, 400, '360 通道不接受目录外模型名');
    const savedOpenlux = await request('/admin/api-config', 'PUT', { provider: 'openlux', routing: { text: { sales: 'gpt-5.5' }, image: 'gpt-image-2' } });
    assert.equal(savedOpenlux.status, 200, JSON.stringify(savedOpenlux.body));
    assert.equal(getConfig('model_routing_openlux').text.sales, 'gpt-5.5');
    assert.equal(getConfig('model_routing_360').text.sales, 'deepseek/deepseek-v4-pro', '保存 OpenLux 不覆盖 360');
    assert.equal((await request('/admin/api-config?provider=360')).body.routing.text.sales, 'deepseek/deepseek-v4-pro');
    assert.equal((await request('/admin/api-config?provider=openlux')).body.routing.text.sales, 'gpt-5.5');
    assert.equal((await request('/admin/api-config', 'PUT', { provider: 'openlux', apiKey: 'sk-new' })).status, 400, 'Key 只走环境变量');
    assert.equal((await request('/admin/api-config', 'PUT', { provider: 'openlux', baseUrl: 'https://evil.invalid/v1' })).status, 400, 'OpenLux 地址固定');
    assert.equal(getConfig('yunwu_base_url', null), null);
  });
});

test('平台测试连接只把对应家的 Key 发往对应家的目录地址', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), auth: options.headers.Authorization });
    return Response.json({ data: [{ id: 'deepseek/deepseek-v4-flash' }, { id: 'alibaba/wan3.0-video' }, { id: 'gpt-5.5' }] });
  };
  try {
    await serverFor(superUser, async request => {
      const test360 = await request('/admin/api-config/test', 'POST', { provider: '360' });
      assert.equal(test360.status, 200); assert.equal(test360.body.ok, true, JSON.stringify(test360.body)); noSecrets(test360.body);
      assert.equal(test360.body.provider, '360');
      assert.equal(test360.body.imageAvailability.verdict, 'no_image_models');
      const testOpenlux = await request('/admin/api-config/test', 'POST', { provider: 'openlux' });
      assert.equal(testOpenlux.body.ok, true, JSON.stringify(testOpenlux.body)); assert.equal(testOpenlux.body.provider, 'openlux');
      assert.equal(testOpenlux.body.imageAvailability, null);
      assert.equal((await request('/admin/api-config/test', 'POST', { provider: 'attacker' })).status, 400);
    });
  } finally { globalThis.fetch = nativeFetch; }
  assert.deepEqual(calls, [
    { url: 'https://api.360.cn/v1/models', auth: 'Bearer sk-360-platform-secret-key-0001' },
    { url: 'https://api.openlux.ai/v1/models', auth: 'Bearer sk-openlux-platform-secret-key-0002' },
  ]);
});

test('企业预览不落库；保存同事务写入供应商选择与该家偏好并保留另一家；reset 恢复平台默认', async () => {
  setConfig('ai_provider_default', 'openlux');
  await serverFor(boss, async request => {
    const initial = await request('/admin/model-routing');
    assert.equal(initial.status, 200); noSecrets(initial.body);
    assert.equal(initial.body.providerId, 'openlux'); assert.equal(initial.body.effectiveProvider, 'openlux');
    assert.equal(initial.body.providerOverride, null); assert.equal(initial.body.defaultProvider, 'openlux');
    assert.deepEqual(initial.body.providers.map(item => item.id).sort(), ['360', 'openlux']);
    assert.ok(initial.body.providers.every(item => !('apiKey' in item) && !('baseUrl' in item)));

    const preview = await request('/admin/model-routing?provider=360');
    assert.equal(preview.body.providerId, '360'); assert.equal(preview.body.effectiveProvider, 'openlux');
    assert.ok(preview.body.catalog.text.every(item => item.id.includes('/')), '预览 360 时目录是 360 模型');
    assert.equal(getConfig(`ai_provider_tenant_${tenant}`, null), null, 'GET 预览不能写入选择');
    assert.equal(q.get('SELECT COUNT(*) n FROM tenant_model_routing WHERE tenant_id=?', tenant).n, 0);
    assert.equal((await request('/admin/model-routing?provider=attacker')).status, 400);

    const cross = await request('/admin/model-routing', 'PUT', { provider: '360', routing: { text: { boss: 'gpt-5.5' } } });
    assert.equal(cross.status, 400, '按目标供应商白名单校验');
    const saved360 = await request('/admin/model-routing', 'PUT', { provider: '360', routing: { text: { boss: 'deepseek/deepseek-v4-pro' } } });
    assert.equal(saved360.status, 200, JSON.stringify(saved360.body));
    assert.equal(saved360.body.providerOverride, '360'); assert.equal(saved360.body.effectiveProvider, '360'); assert.equal(saved360.body.providerId, '360');
    assert.equal(saved360.body.effective.text.boss, 'deepseek/deepseek-v4-pro');
    assert.equal(routing(tenant).text.boss, 'deepseek/deepseek-v4-pro');

    const savedOpenlux = await request('/admin/model-routing', 'PUT', { provider: 'openlux', routing: { text: { boss: 'gpt-5.5', sales: 'deepseek-v4-flash' } } });
    assert.equal(savedOpenlux.status, 200, JSON.stringify(savedOpenlux.body));
    assert.equal(savedOpenlux.body.effectiveProvider, 'openlux'); assert.equal(savedOpenlux.body.effective.text.boss, 'gpt-5.5');
    const stored = JSON.parse(q.get('SELECT routing_json FROM tenant_model_routing WHERE tenant_id=?', tenant).routing_json);
    assert.deepEqual(stored.providerProfiles['360'], { text: { boss: 'deepseek/deepseek-v4-pro' } }, '保存 OpenLux 时保留 360 偏好');
    assert.deepEqual(stored.providerProfiles.openlux, { text: { boss: 'gpt-5.5', sales: 'deepseek-v4-flash' } });
    const back = await request('/admin/model-routing?provider=360');
    assert.deepEqual(back.body.override, { text: { boss: 'deepseek/deepseek-v4-pro' } }); assert.equal(back.body.effectiveProvider, 'openlux');

    const previousKey = process.env.AI360_API_KEY;
    process.env.AI360_API_KEY = '';
    try {
      const unavailable = await request('/admin/model-routing', 'PUT', { provider: '360', routing: {} });
      assert.equal(unavailable.status, 409); assert.equal(unavailable.body.code, 'AI_PROVIDER_UNAVAILABLE');
    } finally { process.env.AI360_API_KEY = previousKey; }
    assert.equal((await request('/admin/model-routing', 'PUT', { provider: '360', routing: {}, tenantId: 1 })).status, 400);

    const reset = await request('/admin/model-routing', 'PUT', { reset: true });
    assert.equal(reset.status, 200); assert.equal(reset.body.providerOverride, null); assert.equal(reset.body.override, null);
    assert.equal(reset.body.effectiveProvider, 'openlux');
    assert.equal(getConfig(`ai_provider_tenant_${tenant}`, null), null);
    assert.equal(q.get('SELECT COUNT(*) n FROM tenant_model_routing WHERE tenant_id=?', tenant).n, 0);
  });
});

after(() => { db.close(); removeTempDbSafely(databasePath); });
