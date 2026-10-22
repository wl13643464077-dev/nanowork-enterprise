import { test, after } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { NANOWORK_DB: ':memory:', NODE_ENV: 'test', NANOWORK_TEST_TEMPLATE_AI: '1',
  NANOWORK_AI_PROVIDER: '360', YUNWU_BASE_URL: 'https://api.360.cn/v1', YUNWU_API_KEY: '',
  AI360_API_KEY: 'platform-360-test', OPENLUX_API_KEY: 'platform-openlux-test', ANTHROPIC_API_KEY: '' });
const { initSchema, migrateV2, setConfig, q, runWithTenant, db } = await import('../src/db.js');
initSchema(); migrateV2();
const selection = await import('../src/engines/ai-provider-selection.js');
const api = await import('../src/engines/yunwu.js');
const { runWithProviderContext } = await import('../src/engines/tester-provider-context.js');
const { xhsImageModel } = await import('../src/engines/ai-xhs-note.js');
const nativeFetch = globalThis.fetch;
after(() => { globalThis.fetch = nativeFetch; db.close(); });
const a = Number(q.run("INSERT INTO tenants(name,status) VALUES('双通道甲','已开通')").lastInsertRowid);
const b = Number(q.run("INSERT INTO tenants(name,status) VALUES('双通道乙','已开通')").lastInsertRowid);
setConfig('ai_provider_default', 'openlux');
setConfig(`ai_provider_tenant_${a}`, '360');
setConfig(`ai_provider_tenant_${b}`, 'openlux');
setConfig('supplier_cost_openlux', { enabled: false, basis: 'upstream_debit' });
const response = data => Response.json(data);
const deferred = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

test('显式默认与企业配置胜过残留360环境；供应商可用性不带Key且平台默认不受当前企业影响', () => {
  assert.equal(selection.platformDefaultProviderId(), 'openlux');
  assert.equal(selection.selectedProviderId(a), '360');
  assert.equal(selection.selectedProviderId(b), 'openlux');
  runWithTenant(a, () => assert.equal(selection.platformDefaultProviderId(), 'openlux'));
  const options = selection.platformProviderAvailability();
  assert.deepEqual(options.map(item => item.id), ['360', 'openlux']);
  assert.ok(options.every(item => item.available && !('apiKey' in item)));
  assert.ok(!JSON.stringify(options).includes('platform-'));
});

test('两企业并发生成使用各自模型/Key/固定origin，切换配置不改变已开始的请求', async () => {
  const gate = deferred(); const seen = [];
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body); seen.push({ url: String(url), key: options.headers.Authorization, body });
    await gate.promise;
    return response({ id: `image-${seen.length}`, data: [{ url: 'https://cdn.example.com/fox.png' }], usage: { amount: '0.2' } });
  };
  const first = runWithTenant(a, () => selection.withPlatformProvider(selection.selectedProviderId(), async () => {
    const out = await api.generateImage({ prompt: '门店菜品', fetchFn });
    assert.equal(selection.selectedProviderId(), '360'); return out;
  }));
  const second = runWithTenant(b, () => selection.withPlatformProvider(selection.selectedProviderId(), async () => {
    const out = await api.generateImage({ prompt: '门店菜品', fetchFn });
    assert.equal(selection.selectedProviderId(), 'openlux'); return out;
  }));
  setConfig(`ai_provider_tenant_${a}`, 'openlux'); gate.release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(out => out.model), ['openai/gpt-image-2', 'gpt-image-2']);
  assert.deepEqual(seen.map(item => [new URL(item.url).origin, item.key]), [
    ['https://api.360.cn', 'Bearer platform-360-test'], ['https://api.openlux.ai', 'Bearer platform-openlux-test'],
  ]);
  setConfig(`ai_provider_tenant_${a}`, '360');
});

test('模型路由分家并过滤旧全局/企业跨供应商模型，动态XHS及默认视频不在启动时固定', () => {
  setConfig('model_routing', { image: 'openai/gpt-image-2', text: { boss: 'deepseek/deepseek-v4-pro' } });
  setConfig('model_routing_360', { text: { boss: 'qwen/qwen3.8-max' } });
  setConfig('model_routing_openlux', { text: { boss: 'deepseek-v4-flash' } });
  q.run('INSERT INTO tenant_model_routing(tenant_id,routing_json) VALUES(?,?)', b,
    JSON.stringify({ providerProfiles: { openlux: { text: { sales: 'gpt-5.5' } }, '360': { text: { sales: 'qwen/qwen3.8-flash' } } } }));
  assert.equal(api.routing(a).text.boss, 'qwen/qwen3.8-max');
  assert.equal(api.routing(b).text.boss, 'deepseek-v4-flash');
  assert.equal(api.routing(b).text.sales, 'gpt-5.5');
  assert.equal(api.routing(b).videoDefault, 'wan2.6-i2v');
  assert.equal(api.routing(a).videoDefault, 'alibaba/wan3.0-video');
  selection.withPlatformProvider('360', () => { assert.equal(xhsImageModel(), 'openai/gpt-image-2'); assert.equal(api.routing(b).text.sales, 'qwen/qwen3.8-flash'); });
  // 2026-10-22 起 OpenLux 通道的小红书配图升级为 GPT-Image-2.5（实测约 ¥0.10/张，支持参考图编辑）。
  selection.withPlatformProvider('openlux', () => assert.equal(xhsImageModel(), 'gpt-image-2.5-flare-c'));
});

test('个人Key上下文优先平台冻结/企业/全局，未配置同家平台Key也只用个人Key', async () => {
  const calls = [];
  const personal = { provider: '360', baseUrl: 'https://api.360.cn/v1', apiKey: 'own-360-test', ownerUserId: 700 };
  await runWithTenant(b, () => selection.withPlatformProvider('openlux', () => runWithProviderContext(personal, async () => {
    assert.equal(selection.selectedProviderId(), '360');
    const credentials = selection.selectedProviderCredentials();
    assert.equal(credentials.billingMode, 'personal');
    await api.generateImage({ prompt: '个人试用', fetchFn: async (url, options) => {
      calls.push([String(url), options.headers.Authorization]);
      return response({ id: 'own-image', data: [{ url: 'https://cdn.example.com/a.png' }], usage: { amount: '0.5' } });
    } });
  })));
  assert.deepEqual(calls, [['https://api.360.cn/v1/images/generations', 'Bearer own-360-test']]);
});

test('平台两份Key不相互借用，遗留环境Key/DB Key必须各自base同源', () => {
  const previous = process.env.OPENLUX_API_KEY;
  process.env.OPENLUX_API_KEY = ''; process.env.YUNWU_API_KEY = 'legacy-360-test';
  setConfig('yunwu_base_url', 'https://api.360.cn/v1'); setConfig('yunwu_api_key', 'db-360-test');
  selection.withPlatformProvider('openlux', () => assert.equal(api.yunwuApiKey(), ''));
  setConfig('yunwu_base_url', 'https://api.openlux.ai/v1'); setConfig('yunwu_api_key', 'db-openlux-test');
  selection.withPlatformProvider('openlux', () => assert.equal(api.yunwuApiKey(), 'db-openlux-test'));
  const old360 = process.env.AI360_API_KEY; process.env.AI360_API_KEY = ''; process.env.YUNWU_API_KEY = '';
  selection.withPlatformProvider('360', () => assert.equal(api.yunwuApiKey(), ''));
  process.env.AI360_API_KEY = old360; process.env.OPENLUX_API_KEY = previous;
});

test('双向切换后的历史视频仍向原供应商查询，任务ID编码保留且没有新POST', async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), key: options.headers.Authorization, method: options.method || 'GET' });
    return String(url).startsWith('https://api.360.cn/')
      ? response({ id: 'old^^alibaba/wan3.0-video^^1', status: 'SUCCEEDED', video_url: 'https://cdn.example.com/a.mp4', usage: { amount: '0' } })
      : response({ output: { task_id: 'openlux-old', task_status: 'SUCCEEDED', video_url: 'https://cdn.example.com/b.mp4' } });
  };
  await selection.withPlatformProvider('openlux', () => api.fetchVideoTask({ taskId: 'old^^alibaba/wan3.0-video^^1', model: 'alibaba/wan3.0-video' }));
  await selection.withPlatformProvider('360', () => api.fetchVideoTask({ taskId: 'openlux-old', model: 'wan2.6-i2v' }));
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/api\.360\.cn\/v1\/videos\/async_generations\/old%5E%5E/);
  assert.match(calls[1].url, /^https:\/\/api\.openlux\.ai\/alibailian\/api\/v1\/tasks\/openlux-old$/);
  assert.deepEqual(calls.map(item => item.key), ['Bearer platform-360-test', 'Bearer platform-openlux-test']);
  assert.ok(calls.every(item => item.method === 'GET'));
});

test('未知或矛盾任务归属不猜测、不重发；个人查询不切换到平台或其他供应商凭据', async () => {
  globalThis.fetch = () => { throw new Error('must not send'); };
  await assert.rejects(api.fetchVideoTask({ taskId: 'unknown', model: 'unknown-video' }), { code: 'TASK_PROVIDER_UNKNOWN' });
  await assert.rejects(api.fetchVideoTask({ taskId: 'wrong', model: 'wan2.6-i2v', providerId: '360' }), { code: 'TASK_PROVIDER_MISMATCH' });
  await runWithProviderContext({ provider: '360', baseUrl: 'https://api.360.cn/v1', apiKey: 'own-360-test', ownerUserId: 700 }, async () => {
    await assert.rejects(api.fetchVideoTask({ taskId: 'old', model: 'wan2.6-i2v' }), { code: 'TASK_PERSONAL_PROVIDER_MISMATCH' });
  });
  const cost = await api.supplierRequestCost({ requestId: 'unknown-cost', model: 'unknown-model' });
  assert.equal(cost.status, 'pending'); assert.equal(cost.reason, 'unknown_provider');
});
