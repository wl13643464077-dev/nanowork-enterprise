import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-embedding-cost-'));
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.NANOWORK_DB = path.join(directory, 'test.db');
process.env.YUNWU_API_KEY = 'embedding-isolated-test-token';
process.env.YUNWU_BASE_URL = 'https://api.openlux.ai/v1';
const { db, initSchema, migrateV2, setConfig } = await import('../src/db.js');
initSchema(); migrateV2();
const { embed } = await import('../src/engines/yunwu.js');
const originalFetch = globalThis.fetch;

test('向量保持纯数组兼容，供应商回执和真实用量供后台单独留账', async () => {
  setConfig('supplier_cost_openlux', { enabled: true, basis: 'upstream_debit' });
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    const parsed = new URL(url);
    if (parsed.pathname === '/v1/embeddings') {
      assert.equal(options.method, 'POST');
      return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 33 } }, { headers: { 'x-request-id': 'embedding-fixture-1' } });
    }
    if (parsed.pathname === '/api/status') return Response.json({ success: true, data: { quota_per_unit: 500000, usd_exchange_rate: 6.4, currency_type: 'USD' } });
    assert.equal(parsed.pathname, '/api/log/token');
    return Response.json({ success: true, data: [{ type: 2, model_name: 'text-embedding-3-small', quota: 100, other: JSON.stringify({ request_id: 'embedding-fixture-1' }) }] });
  };
  const vector = await embed('独立测试文档');
  assert.deepEqual(vector, [0.1, 0.2, 0.3]);
  assert.equal(JSON.stringify(vector), '[0.1,0.2,0.3]');
  assert.deepEqual(vector.providerUsage, { model: 'text-embedding-3-small', inputTokens: 33, outputTokens: 0 });
  assert.equal(vector.supplierCosts[0].status, 'known');
  assert.equal(vector.supplierCosts[0].costYuanOverride, 0.00128);
  assert.equal(calls, 3);
});

test('无供应商用量不伪造token，禁用成本回执时不额外请求', async () => {
  setConfig('supplier_cost_openlux', { enabled: false });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ data: [{ embedding: [0.4] }] }); };
  const vector = await embed('另一份文档');
  assert.deepEqual(vector.providerUsage, { model: 'text-embedding-3-small' });
  assert.deepEqual(vector.supplierCosts, []);
  assert.equal(calls, 1);
});

after(() => { globalThis.fetch = originalFetch; db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
