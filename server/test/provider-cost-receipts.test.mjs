import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-cost-receipts-'));
process.env.NANOWORK_DB = path.join(fixtureRoot, 'test.db');
const { validateSupplierCostConfig, supplierCostSettings, matchingQuotaReceipt, readOpenLuxCost, aggregateSupplierCosts } = await import('../src/engines/provider-cost-receipts.js');
const { db, setConfig } = await import('../src/db.js');
db.exec('CREATE TABLE IF NOT EXISTS sys_config(key TEXT PRIMARY KEY, value TEXT)');
after(() => { db.close(); fs.rmSync(fixtureRoot, { recursive: true, force: true }); });
const settings = { ...validateSupplierCostConfig({ enabled: true }), ready: true };
const status = { quota_per_unit: 500000, usd_exchange_rate: 6.744675, currency_type: 'USD', display_in_currency: true };
const row = { model_name: 'wan2.6-i2v', quota: 322544, type: 2, other: JSON.stringify({ request_id: 'receipt-test-1', group_ratio: 0.5 }) };
const receiptOptions = { requestId: 'receipt-test-1', model: row.model_name, quotaPerUnit: status.quota_per_unit };
const options = { requestId: 'receipt-test-1', model: row.model_name, baseUrl: 'https://api.openlux.ai/v1',
  apiKey: 'isolated-test-token', settings, retryDelaysMs: [], statusCacheTtlMs: 0 };
const response = data => Response.json({ success: true, data });
const fixtureFetch = (state = status, logs = [row]) => async url => response(url.pathname === '/api/status' ? state : logs);

test('无需充值字段即可启用，旧实付汇率不会暗中覆盖上游扣费模式', async () => {
  assert.deepEqual(validateSupplierCostConfig({ enabled: true }), { enabled: true, basis: 'upstream_debit' });
  assert.deepEqual(validateSupplierCostConfig({ enabled: false }), { enabled: false, basis: 'upstream_debit' });
  const legacy = { enabled: true, rmbPaid: 1, usdCredited: 200, rmbPerCreditUsd: 0.005, paymentReference: 'ignored' };
  assert.deepEqual(validateSupplierCostConfig(legacy), { enabled: true, basis: 'upstream_debit' });
  for (const value of [null, [], {}, { enabled: 'true' }, { enabled: true, basis: 'purchase_cost' }])
    assert.throws(() => validateSupplierCostConfig(value));
  setConfig('supplier_cost_openlux', { enabled: true, basis: 'upstream_debit' });
  assert.deepEqual(supplierCostSettings(), settings);
  const result = await readOpenLuxCost({ ...options, settings: legacy, fetchFn: fixtureFetch() });
  assert.equal(result.status, 'known');
  assert.equal(result.costSource.exchangeRate, status.usd_exchange_rate);
  assert.equal(result.costSource.rmbPaid, undefined);
});

test('真实quota按公开单位汇率换算并保留USD来源，倍率与渠道折扣不重复应用', async () => {
  const paths = [];
  const result = await readOpenLuxCost({ ...options, fetchFn: async (url, init) => {
    paths.push(url.pathname);
    assert.equal(url.origin, 'https://api.openlux.ai');
    assert.equal(init.redirect, 'error');
    if (url.pathname === '/api/status') {
      assert.equal(url.search, '');
      assert.equal(init.headers, undefined, 'Public status must not receive the key');
      return response(status);
    }
    assert.equal(url.pathname, '/api/log/token');
    assert.equal(url.searchParams.get('key'), options.apiKey);
    return response([row]);
  } });
  assert.deepEqual(paths, ['/api/status', '/api/log/token']);
  assert.equal(result.status, 'known');
  assert.equal(result.costSource.amount, 0.645088);
  assert.equal(result.costYuanOverride, 4.3509089064);
  assert.equal(Math.ceil(result.costYuanOverride * 2 / 0.01), 871);
  assert.equal(result.costSource.type, 'provider_receipt');
  assert.equal(result.costSource.basis, 'upstream_debit');
  assert.equal(result.costSource.currency, 'USD');
  assert.equal(result.costSource.quota, row.quota);
  assert.equal(result.costSource.quotaPerUnit, 500000);
  assert.equal(result.costSource.exchangeRateSource, 'https://api.openlux.ai/api/status');
  assert.ok(Number.isFinite(Date.parse(result.costSource.statusRetrievedAt)));
  assert.ok(!JSON.stringify(result).includes(options.apiKey));
});

test('单位与汇率不硬编码，CNY显示不重复兑换', async () => {
  const changed = { ...status, quota_per_unit: 1000000, usd_exchange_rate: 6, currency_type: 'CNY' };
  const result = await readOpenLuxCost({ ...options, fetchFn: fixtureFetch(changed, [{ ...row, quota: 500000 }]) });
  assert.equal(result.status, 'known');
  assert.equal(result.costSource.amount, 0.5);
  assert.equal(result.costSource.exchangeRate, 6);
  assert.equal(result.costSource.statusDisplayCurrency, 'CNY');
  assert.equal(result.costYuanOverride, 3);
  const hiddenCurrency = await readOpenLuxCost({ ...options,
    fetchFn: fixtureFetch({ ...status, display_in_currency: false }) });
  assert.equal(hiddenCurrency.status, 'known', 'A cosmetic display toggle does not change verified wallet units');
  assert.equal(hiddenCurrency.costYuanOverride, row.quota / status.quota_per_unit * status.usd_exchange_rate);
});

test('其他站点/HTTP/URL凭据均拒绝，明确关闭或未就绪时完全不请求', async () => {
  const noNetwork = () => assert.fail('must not access network');
  for (const baseUrl of ['http://api.openlux.ai/v1', 'https://another.example/v1',
    'https://api.openlux.ai.attacker.example/v1', 'https://api.openlux.ai:444/v1', 'https://user:password@api.openlux.ai/v1']) {
    const result = await readOpenLuxCost({ ...options, baseUrl, fetchFn: noNetwork });
    assert.equal(result.status, 'pending'); assert.equal(result.costYuanOverride, undefined);
  }
  assert.equal(await readOpenLuxCost({ ...options, settings: { enabled: false }, fetchFn: noNetwork }), null);
  for (const change of [{ settings: { enabled: true, ready: false } }, { requestId: 'bad\nrequest' },
    { apiKey: '' }, { settings: { enabled: true, basis: 'purchase_cost' } }])
    assert.equal((await readOpenLuxCost({ ...options, ...change, fetchFn: noNetwork })).status, 'pending');
});

test('非法单位/汇率/币种和无法读取status不得回退估价或查询消费日志', async () => {
  const invalidStates = [null, {}, ...[0, -1, 0.1, '500000', NaN, Infinity, 1e13].map(quota_per_unit => ({ ...status, quota_per_unit })),
    ...[0, -1, '6.7', NaN, Infinity, 0.001, 1001].map(usd_exchange_rate => ({ ...status, usd_exchange_rate })),
    ...['EUR', 'CUSTOM', 'TOKENS', ''].map(currency_type => ({ ...status, currency_type }))];
  for (const state of invalidStates) {
    let calls = 0;
    const result = await readOpenLuxCost({ ...options, fetchFn: async url => {
      calls++; assert.equal(url.pathname, '/api/status'); return response(state);
    } });
    assert.equal(calls, 1); assert.equal(result.status, 'pending'); assert.equal(result.costYuanOverride, undefined);
  }
  for (const fetchFn of [async () => new Response('', { status: 503 }), async () => Response.json({ success: false, data: status }),
    async () => new Response('{bad-json'), async () => { throw new Error('sensitive details must stay private'); }])
    assert.equal((await readOpenLuxCost({ ...options, fetchFn })).status, 'pending');
});

test('status与日志重定向均拒绝，带key错误信息不进入返回结果', async () => {
  for (const redirectPath of ['/api/status', '/api/log/token']) {
    for (const redirect of [() => new Response('', { status: 302, headers: { location: 'https://other.example/' } }),
      () => ({ status: 200, redirected: true, url: 'https://other.example/', json: async () => ({ success: true, data: status }) })]) {
      const result = await readOpenLuxCost({ ...options, fetchFn: async (url, init) => {
        assert.equal(init.redirect, 'error');
        return url.pathname === redirectPath ? redirect() : response(status);
      } });
      assert.equal(result.status, 'pending'); assert.ok(!JSON.stringify(result).includes(options.apiKey));
    }
  }
  const result = await readOpenLuxCost({ ...options, fetchFn: async url => {
    if (url.pathname === '/api/status') return response(status);
    throw new Error(`Could not fetch ${url}`);
  } });
  assert.deepEqual(result, { status: 'pending', requestId: options.requestId, model: options.model });
});

test('唯一requestId和模型严格匹配，重复/退款/错币种/非法quota不可计费', () => {
  assert.equal(matchingQuotaReceipt([row], { ...receiptOptions, requestId: 'other' }), null);
  assert.equal(matchingQuotaReceipt([row], { ...receiptOptions, model: 'other-model' }), null);
  assert.equal(matchingQuotaReceipt([row, row], receiptOptions), null);
  for (const quota of [-1, 0.1, NaN, Infinity, '322544', Number.MAX_SAFE_INTEGER + 1])
    assert.equal(matchingQuotaReceipt([{ ...row, quota }], receiptOptions), null);
  for (const change of [{ type: 1 }, { type: undefined }, { currency: 'CNY' }, { currency: 'EUR' },
    { request_id: 'conflicting-id' }, { request_id: options.requestId, other: '{bad' },
    { other: JSON.stringify({ request_id: options.requestId, currency: 'CNY' }) }])
    assert.equal(matchingQuotaReceipt([{ ...row, ...change }], receiptOptions), null);
  assert.equal(matchingQuotaReceipt([{ ...row, quota: 0 }], receiptOptions).usd, 0);
  assert.equal(matchingQuotaReceipt({ data: [row] }, receiptOptions), null);
  assert.equal(matchingQuotaReceipt([row], { ...receiptOptions, quotaPerUnit: undefined }), null);
});

test('日志短延迟只免费重查，匹配即停且共用已读取状态快照', async () => {
  let statusCalls = 0, logCalls = 0;
  const delays = [];
  const result = await readOpenLuxCost({ ...options, retryDelaysMs: [250, 750], sleepFn: async ms => delays.push(ms),
    fetchFn: async (url, init) => {
      assert.equal(init.method, undefined, 'Only default GET is permitted');
      if (url.pathname === '/api/status') { statusCalls++; return response(status); }
      logCalls++;
      return response(logCalls === 1 ? [{ ...row, other: '{"request_id":"previous-request"}' }] : { items: [row] });
    } });
  assert.equal(result.status, 'known'); assert.equal(statusCalls, 1); assert.equal(logCalls, 2);
  assert.deepEqual(delays, [250]);
});

test('缺失回执重查最多两次，冲突不会借后续窗口变化冒充唯一回执', async () => {
  for (const logs of [[], [row, row], [{ ...row, type: 4 }], [{ ...row, quota: -1 }]]) {
    let logCalls = 0, slept = 0;
    const result = await readOpenLuxCost({ ...options, retryDelaysMs: [0, 0, 0, 0], sleepFn: async () => { slept++; },
      fetchFn: async url => {
        if (url.pathname === '/api/status') return response(status);
        logCalls++; return response(logCalls === 1 ? logs : logs.length ? [row] : []);
      } });
    assert.equal(result.status, 'pending');
    assert.equal(logCalls, logs.length ? 1 : 3); assert.equal(slept, logs.length ? 0 : 2);
  }
});

test('status短缓存可复用/禁用且不跨fetch适配器，失败不缓存为成功', async () => {
  let state = status, calls = 0;
  const fetchFn = async url => {
    if (url.pathname === '/api/status') { calls++; return response(state); }
    return response([row]);
  };
  const cached = { ...options, fetchFn, statusCacheTtlMs: 60000 };
  const first = await readOpenLuxCost(cached);
  state = { ...status, usd_exchange_rate: 7 };
  const second = await readOpenLuxCost(cached);
  assert.equal(calls, 1); assert.equal(second.costSource.statusRetrievedAt, first.costSource.statusRetrievedAt);
  assert.equal(second.costSource.exchangeRate, status.usd_exchange_rate);
  assert.equal((await readOpenLuxCost({ ...cached, statusCacheTtlMs: 0 })).costSource.exchangeRate, 7);
  assert.equal(calls, 2);
  assert.equal((await readOpenLuxCost({ ...cached, fetchFn: fixtureFetch(null) })).status, 'pending');
  let valid = false;
  const initiallyInvalid = async url => response(url.pathname === '/api/status' ? valid ? status : {} : [row]);
  assert.equal((await readOpenLuxCost({ ...cached, fetchFn: initiallyInvalid })).status, 'pending');
  valid = true;
  assert.equal((await readOpenLuxCost({ ...cached, fetchFn: initiallyInvalid })).status, 'known');
});

test('跨汇率/单位的组合按各自CNY求和，保留完整逐请求证据而不伪造共同汇率', async () => {
  const first = await readOpenLuxCost({ ...options, fetchFn: fixtureFetch() });
  const second = await readOpenLuxCost({ ...options, requestId: 'receipt-test-2', fetchFn: fixtureFetch(
    { ...status, quota_per_unit: 1000000, usd_exchange_rate: 7 }, [{ ...row, quota: 1542, other: '{"request_id":"receipt-test-2"}' }]) });
  const combined = aggregateSupplierCosts([first, second]);
  assert.equal(combined.status, 'known');
  assert.equal(combined.costYuanOverride, first.costYuanOverride + second.costYuanOverride);
  assert.equal(combined.costSource.currency, 'CNY');
  assert.equal(combined.costSource.amount, combined.costYuanOverride);
  assert.equal(combined.costSource.exchangeRate, 1);
  assert.deepEqual(combined.costSource.requestIds, ['receipt-test-1', 'receipt-test-2']);
  assert.deepEqual(combined.costSource.receipts, [first.costSource, second.costSource]);
  assert.equal(combined.costSource.quotaPerUnit, undefined);
  for (const costs of [[first, first], [first, { status: 'pending' }], [first, { ...second, costSource: null }],
    [first, { ...second, costYuanOverride: NaN }], [first, { ...second, costYuanOverride: 100 }],
    [first, { ...second, costSource: { ...second.costSource, currency: 'CNY' } }],
    [first, { ...second, costSource: { ...second.costSource, quota: 0 } }]])
    assert.equal(aggregateSupplierCosts(costs).status, 'pending');
  assert.equal(aggregateSupplierCosts([]), null);
});

test('历史非新模式仍拒混合币种、不同汇率及重复，不覆盖历史结算来源', () => {
  const historical = requestId => ({ status: 'known', costYuanOverride: 2,
    costSource: { type: 'provider_receipt', provider: 'openlux', requestId, currency: 'USD', amount: 0.3125, exchangeRate: 6.4 } });
  const a = historical('a'), b = historical('b');
  assert.equal(aggregateSupplierCosts([a,b]).costYuanOverride, 4);
  assert.equal(aggregateSupplierCosts([a,a]).status, 'pending');
  assert.equal(aggregateSupplierCosts([a,{ ...b, costSource: { ...b.costSource, currency: 'CNY' } }]).status, 'pending');
  assert.equal(aggregateSupplierCosts([a,{ ...b, costYuanOverride: 3, costSource: { ...b.costSource, exchangeRate: 9.6 } }]).status, 'pending');
});

test('异步视频“预扣+多退少补”按净额核销，未标注的重复行仍待核', () => {
  const rid = 'seedance-req-1', model = 'doubao-seedance-2-5-260628';
  const base = { model_name: model, other: JSON.stringify({ request_id: rid }) };
  const opts = { requestId: rid, model, quotaPerUnit: 500000 };
  const pre = { ...base, type: 2, quota: 3866616, content: '模型 doubao-seedance-2-5-260628，输出15s' };
  const refund = { ...base, type: 6, quota: -16169, content: '任务 task_x 多退少补：预扣 3866616，实际 3850447，退回 16169' };
  const extra = { ...base, type: 2, quota: 11642, content: '任务 task_y 多退少补：预扣 1560060，实际 1571702，补扣 11642' };
  assert.equal(matchingQuotaReceipt([pre, refund], opts).quota, 3850447);
  assert.equal(matchingQuotaReceipt([{ ...pre, quota: 1560060 }, extra], opts).quota, 1571702);
  assert.equal(matchingQuotaReceipt([pre], opts).quota, 3866616, '调整行未到时先按预扣');
  assert.equal(matchingQuotaReceipt([pre, { ...refund, content: '退款' }], opts), null, '未标注多退少补的退款不认');
  assert.equal(matchingQuotaReceipt([pre, pre, refund], opts), null, '两条主扣费仍待核');
  assert.equal(matchingQuotaReceipt([refund], opts), null, '只有调整行没有主扣费不认');
  assert.equal(matchingQuotaReceipt([{ ...pre, quota: 10 }, { ...refund, quota: -100 }], opts), null, '净额不能为负');
});
