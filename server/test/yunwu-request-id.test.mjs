import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-request-id-'));
process.env.NODE_ENV = 'test';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.NANOWORK_DB = path.join(directory, 'test.db');
process.env.YUNWU_API_KEY = 'isolated-request-id-test-token';
process.env.YUNWU_BASE_URL = 'https://api.openlux.ai/v1';
const { db, setConfig } = await import('../src/db.js');
db.exec('CREATE TABLE IF NOT EXISTS sys_config(key TEXT PRIMARY KEY, value TEXT)');
const { responseRequestId, embed, editImage, submitAliBailianVideoSegment } = await import('../src/engines/yunwu.js');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
const reply = data => Response.json({ success: true, data });

test('OpenLux账单ID优先于不同的下游跟踪ID，兼容New API及历史响应头', () => {
  assert.equal(responseRequestId({ headers: new Headers({ 'X-Api-Request-Id': 'wallet-1', 'X-Request-Id': 'downstream-2' }) }), 'wallet-1');
  assert.equal(responseRequestId({ headers: new Headers({ 'X-Oneapi-Request-Id': 'wallet-3', 'X-Request-Id': 'downstream-4' }) }), 'wallet-3');
  assert.equal(responseRequestId({ headers: new Headers({ 'X-Request-Id': 'legacy-5', 'Request-Id': 'legacy-6' }) }), 'legacy-5');
  assert.equal(responseRequestId({ headers: new Headers({ 'Request-Id': 'legacy-6' }) }), 'legacy-6');
  assert.equal(responseRequestId({}), null);
  assert.equal(responseRequestId(null), null);
});

test('非法或重复合并的网关ID不得降级使用下游ID进行账单归属', () => {
  for (const value of ['', 'unsafe id', 'one,two', 'https://example.test/request', 'a'.repeat(201), 123]) {
    const headers = { get: name => name === 'x-api-request-id' ? value : 'downstream-valid' };
    assert.equal(responseRequestId({ headers }), null);
  }
  const repeated = new Headers({ 'x-request-id': 'downstream-valid' });
  repeated.append('x-api-request-id', 'wallet-one');
  repeated.append('x-api-request-id', 'wallet-two');
  assert.equal(responseRequestId({ headers: repeated }), null);
});

test('真实post传输以OpenLux响应头匹配唯一扣费回执，不采用下游同模型记录', async () => {
  setConfig('supplier_cost_openlux', { enabled: true, basis: 'upstream_debit' });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    if (pathname === '/v1/embeddings') {
      assert.equal(options.method, 'POST');
      return Response.json({ data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 3 } }, {
        headers: { 'x-api-request-id': 'wallet-embedding', 'x-request-id': 'model-internal-id' },
      });
    }
    if (pathname === '/api/status') return reply({ quota_per_unit: 500000, usd_exchange_rate: 6.4, currency_type: 'USD' });
    assert.equal(pathname, '/api/log/token');
    return reply([
      { type: 2, model_name: 'text-embedding-3-small', quota: 100, other: JSON.stringify({ request_id: 'wallet-embedding' }) },
      { type: 2, model_name: 'text-embedding-3-small', quota: 99999, other: JSON.stringify({ request_id: 'model-internal-id' }) },
    ]);
  };
  const output = await embed('测试账单响应头');
  assert.deepEqual(output, [0.1, 0.2]);
  assert.equal(output.supplierCosts[0].status, 'known');
  assert.equal(output.supplierCosts[0].costSource.requestId, 'wallet-embedding');
  assert.equal(output.supplierCosts[0].costSource.quota, 100);
  assert.equal(output.supplierCosts[0].costYuanOverride, 0.00128);
  assert.deepEqual(calls, ['/v1/embeddings', '/api/status', '/api/log/token']);
});

test('Image2响应与持久回执使用同一网关ID，不丢失已返回图片', async () => {
  setConfig('supplier_cost_openlux', { enabled: false });
  const responses = [], receipts = [];
  const output = await editImage({
    prompt: '一张测试图片', model: 'gpt-image-2', image: 'data:image/png;base64,dGVzdA==',
    fetchFn: async () => Response.json({ data: [{ b64_json: 'aW1hZ2U=' }] }, {
      headers: { 'x-api-request-id': 'wallet-image', 'x-request-id': 'downstream-image' },
    }),
    onResponse: value => responses.push(value), onReceipt: value => receipts.push(value),
  });
  assert.equal(responses[0].requestId, 'wallet-image');
  assert.equal(receipts[0].providerRequestId, 'wallet-image');
  assert.equal(output.providerRequestId, 'wallet-image');
  assert.equal(output.b64, 'aW1hZ2U=');
});

test('异步视频提交与不完整响应错误均保留网关ID，不用taskId冒充扣费ID', async () => {
  const input = { prompt: '测试镜头', model: 'wan2.6-i2v', images: ['https://example.test/image.png'], duration: 15 };
  let calls = 0;
  const output = await submitAliBailianVideoSegment({ ...input, fetchImpl: async () => {
    calls++;
    return Response.json({ output: { task_id: 'video-task-1', task_status: 'PENDING' } }, {
      headers: { 'x-api-request-id': 'wallet-video', 'x-request-id': 'downstream-video' },
    });
  } });
  assert.equal(output.taskId, 'video-task-1');
  assert.equal(output.providerRequestId, 'wallet-video');
  assert.equal(calls, 1);
  await assert.rejects(submitAliBailianVideoSegment({ ...input, fetchImpl: async () => {
    calls++;
    return new Response('{', { status: 200, headers: { 'x-api-request-id': 'wallet-incomplete-video' } });
  } }), error => {
    assert.equal(error.providerRequestId, 'wallet-incomplete-video');
    assert.equal(error.providerResponsePhase, 'response_parse');
    return true;
  });
  assert.equal(calls, 2, 'incomplete response must not cause an automatic paid retry');
});
