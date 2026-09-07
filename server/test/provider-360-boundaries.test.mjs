import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import express from 'express';

Object.assign(process.env, { NANOWORK_DB: ':memory:', NANOWORK_TEST_TEMPLATE_AI: '1',
  NANOWORK_AI_PROVIDER: '360', AI360_API_KEY: '360-boundary-secret', YUNWU_API_KEY: 'old-secret',
  YUNWU_BASE_URL: 'https://api.openlux.ai/v1', ANTHROPIC_API_KEY: 'old-anthropic-secret', ENABLE_SCHEDULER: 'false' });
const nativeFetch = globalThis.fetch;
const { initSchema, migrateV2, db, q, setConfig, runWithTenant } = await import('../src/db.js');
initSchema(); migrateV2();
setConfig('yunwu_base_url', 'https://api.openlux.ai/v1');
const uid = Number(q.run("INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES('360-boundary','x','管理员','platform_super',1)").lastInsertRowid);
const admin = (await import('../src/routes/admin.js')).default;
const app = express(); app.use(express.json());
app.use((req, _res, next) => runWithTenant(1, () => { req.user = { id: uid, role: 'platform_super', tenant_id: 1 }; next(); }));
app.use('/admin', admin);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { globalThis.fetch = nativeFetch; await new Promise(resolve => server.close(resolve)); db.close(); });
async function put(body) {
  const res = await nativeFetch(`${base}/admin/api-config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('360配置展示有效供应商和人民币结算，不吸收数据库旧base', async () => {
  const config = await (await nativeFetch(`${base}/admin/api-config`)).json();
  assert.equal(config.channel.providerId, '360');
  assert.equal(config.channel.baseUrl, 'https://api.360.cn/v1');
  assert.equal(config.supplierCost.locked, true);
  assert.equal(config.billing.marginMultiplier, 2);
  assert.equal(config.billing.supplier, '360');
});

test('360拒绝关闭真实费用、更换旧base、旧视频、错误模型及旧H3', async () => {
  for (const body of [{ supplierCost: { enabled: false } }, { baseUrl: 'https://api.openlux.ai/v1' },
    { routing: { videoDefault: 'wan2.6-i2v' } }, { routing: { text: { boss: 'foreign/model' } } }, { h3: {} }]) {
    const res = await put(body); assert.equal(res.status, 400, JSON.stringify(res));
  }
  const saved = await put({ routing: { text: { boss: 'deepseek/deepseek-v4-pro' }, image: 'openai/gpt-image-2', video: ['alibaba/wan3.0-video'], videoDefault: 'alibaba/wan3.0-video' },
    supplierCost: { enabled: true, basis: 'upstream_debit' } });
  assert.equal(saved.status, 200, JSON.stringify(saved));
});

test('连接测试只把360 Key发往360 models，绝不发送到旧数据库地址', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url)); assert.equal(String(url), 'https://api.360.cn/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer 360-boundary-secret');
    return new Response(JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4-flash' }] }), { headers: { 'Content-Type': 'application/json' } });
  };
  const res = await nativeFetch(`${base}/admin/api-config/test`, { method: 'POST' });
  const data = await res.json(); assert.equal(data.ok, true, JSON.stringify(data)); assert.equal(calls.length, 1);
});

test('360生成失败不请求Anthropic备用通道，联网Claude备用也关闭', async () => {
  const { generate, aiChannel } = await import('../src/engines/ai.js');
  const { agenticWebResearchReadiness } = await import('../src/engines/agentic-web-research.js');
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url)); assert.equal(String(url), 'https://api.360.cn/v1/chat/completions');
    return new Response(JSON.stringify({ error: { message: 'unauthorized' } }), { status: 401 });
  };
  const result = await generate({ kind: 'boundary', userMsg: '写一句话', fallback: () => '', model: 'deepseek/deepseek-v4-flash' });
  assert.equal(result.mode, 'template'); assert.equal(result.text, '');
  assert.equal(calls.length, 1); assert.equal(aiChannel(), '360');
  assert.equal(agenticWebResearchReadiness().fallbackReady, false);
});

test('360已扣款但正文为空时，编排层保留费用证据供全退用户后核算平台成本', async () => {
  const { generate } = await import('../src/engines/ai.js');
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 'empty-response|supplier-cost',
    model: 'deepseek/deepseek-v4-flash', choices: [{ message: { content: '' } }],
    usage: { prompt_tokens: 10, completion_tokens: 3, amount: '0.000057' } }), { headers: { 'Content-Type': 'application/json' } });
  const result = await generate({ kind: 'empty-receipt', userMsg: '写一句话', fallback: () => '', model: 'deepseek/deepseek-v4-flash' });
  assert.equal(result.mode, 'template');
  assert.equal(result.usage.supplierCosts[0].costYuanOverride, 0.000057);
  assert.equal(result.usage.supplierCosts[0].status, 'known');
});
