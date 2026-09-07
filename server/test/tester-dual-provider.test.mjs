import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const databasePath = path.join(os.tmpdir(), `tester-dual-provider-${process.pid}.db`);
process.env.NANOWORK_DB = databasePath;
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'dual-provider-test-secret-'.repeat(3);
const { db, q, initSchema, migrateV2 } = await import('../src/db.js');
initSchema(); migrateV2();
const access = await import('../src/engines/tester-access.js');
const oldKey = 'legacy-360-only-fake-key';
const oldCipher = access.encryptTesterSecret(oldKey);
const oldUserId = Number(q.run("INSERT INTO users(username,password_hash,name,role,tenant_id,status) VALUES('legacy_tester','unused','旧测试员','sales',1,'启用')").lastInsertRowid);
db.exec(`CREATE TABLE tester_accounts (
  user_id INTEGER PRIMARY KEY, phone TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  api_key_cipher TEXT, key_updated_at TEXT, consent_at TEXT NOT NULL,
  reviewed_by INTEGER,reviewed_at TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
); CREATE TABLE tester_invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,owner_user_id INTEGER NOT NULL,token_hash TEXT UNIQUE NOT NULL,
  token_cipher TEXT NOT NULL,title TEXT NOT NULL,sales_phone TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);`);
q.run("INSERT INTO tester_accounts(user_id,phone,status,api_key_cipher,consent_at) VALUES(?,?,'approved',?,?)", oldUserId, '13899110000', oldCipher, new Date().toISOString());
q.run('INSERT INTO tester_invitations(owner_user_id,token_hash,token_cipher,title,sales_phone) VALUES(?,?,?,?,?)', oldUserId, 'legacy-hash', access.encryptTesterSecret('legacy-token'), '旧码', '13899110000');
access.ensureTesterSchema();
const api = await import('../src/engines/tester-trials.js');
const { testerAnalytics } = await import('../src/engines/tester-analytics.js');
const { testerCostEvidence, testerEvidenceTotals, validTesterReceipt } = await import('../src/engines/tester-cost-evidence.js');
const { providerContext, runWithProviderContext } = await import('../src/engines/tester-provider-context.js');
const { signToken } = await import('../src/util.js');
const { createTesterRouter } = await import('../src/routes/testers.js');
const admin = { id: Number(q.run("INSERT INTO users(username,password_hash,name,role,tenant_id,status) VALUES('dual_tester_super','unused','超管','platform_super',1,'启用')").lastInsertRowid) };
let counter = 0;
function owner() {
  const number = ++counter;
  api.applyTester({ username: `dual_tester_${number}`, name: `测试${number}`, phone: `1389922${String(number).padStart(4, '0')}`, password: 'Fake-Tester-Password!', consent: true });
  const user = q.get('SELECT id FROM users WHERE username=?', `dual_tester_${number}`);
  api.updateTesterStatus(admin, user.id, 'approved');
  return user;
}
function customer(user) {
  const invitation = api.createTesterInvitation(user, {}, 'https://example.test');
  const applied = api.applyTrial(invitation.token, { name: '顾客', phone: `1399933${String(++counter).padStart(4, '0')}`, consent: true });
  api.updateLeadStatus(user, applied.lead.id, 'approved');
  return { invitation, ...applied };
}
const input = requestId => ({ employeeId: 'content-11', message: '门店叫示例店，供应鲜切牛肉，写自然的介绍。', requestId });
const cost360 = (id = 'same-request', amount = 0.07) => ({ status: 'known', costYuanOverride: amount,
  costSource: { type: 'provider_receipt', provider: '360', basis: 'upstream_debit', requestId: id, currency: 'CNY', amount, exchangeRate: 1 } });
const costOpenLux = (id = 'same-request') => ({ status: 'known', costYuanOverride: 0.07,
  costSource: { type: 'provider_receipt', provider: 'openlux', basis: 'upstream_debit', requestId: id,
    currency: 'USD', amount: 0.01, exchangeRate: 7, quota: 10000, quotaPerUnit: 1000000,
    exchangeRateSource: 'https://api.openlux.ai/api/status', statusRetrievedAt: '2026-09-07T00:00:00.000Z' } });
const reply = (provider, requestId, text = '示例店供应鲜切牛肉，欢迎来店了解。') => ({ text,
  model: provider === '360' ? 'deepseek/deepseek-v4-flash' : 'deepseek-v4-flash', inputTokens: 12, outputTokens: 18,
  supplierCosts: [provider === '360' ? cost360(requestId) : costOpenLux(requestId)] });

test('旧密文原样迁移到360槽、旧账号和旧码保持360；删除后再次启动不复活', async () => {
  assert.equal(access.testerAccount(oldUserId).active_provider, '360');
  assert.equal(q.get('SELECT provider FROM tester_invitations WHERE owner_user_id=?', oldUserId).provider, '360');
  assert.equal(access.testerProviderKey(oldUserId, '360').api_key_cipher, oldCipher);
  assert.equal(access.decryptTesterSecret(access.testerProviderKey(oldUserId, '360').api_key_cipher), oldKey);
  assert.equal(access.testerAccount(oldUserId).api_key_cipher, null);
  assert.equal(access.testerProviderKey(oldUserId, 'openlux'), null);
  api.clearTesterKey({ id: oldUserId }, '360');
  const restartedAccess = await import('../src/engines/tester-access.js?migration-restart');
  restartedAccess.ensureTesterSchema();
  assert.equal(restartedAccess.testerProviderKey(oldUserId, '360'), null);
});

test('新账号默认OpenLux，两家Key独立加密与删除；缺少选中Key拒绝调用而不取其他槽', async () => {
  const user = owner();
  assert.equal(api.testerMe(user).activeProvider, 'openlux');
  const key = 'fake-openlux-private-slot-key';
  api.setTesterKey(user, key);
  api.setTesterKey(user, 'fake-360-private-slot-key', '360');
  const profile = api.testerMe(user);
  assert.equal(profile.providers.length, 2);
  assert.ok(profile.providers.every(item => item.configured));
  assert.ok(!JSON.stringify(profile).includes(key));
  assert.ok(!access.testerProviderKey(user.id, 'openlux').api_key_cipher.includes(key));
  api.clearTesterKey(user, 'openlux');
  assert.equal(api.testerMe(user).keyConfigured, false);
  assert.equal(api.testerMe(user).providers.find(item => item.id === '360').configured, true);
  await assert.rejects(() => api.testerChat(user, input('missing-active-key'), { chatFn: () => assert.fail('must not call another key') }), error => error.code === 'PERSONAL_KEY_REQUIRED');
  assert.throws(() => api.createTesterInvitation(user, {}, 'https://example.test'), error => error.code === 'PERSONAL_KEY_REQUIRED');
  assert.throws(() => api.setTesterProvider(user, 'https://attacker.example'), error => error.code === 'TESTER_PROVIDER_INVALID');
});

test('在途对话与失败重试绑定创建时供应商；切换只影响新对话且不改原记录', async () => {
  const user = owner(); api.setTesterKey(user, 'openlux-bound-test-key'); api.setTesterKey(user, '360-bound-test-key', '360');
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const running = api.testerChat(user, input('bound-failed-turn'), { chatFn: async options => {
    assert.equal(options.model, 'deepseek-v4-flash'); assert.equal(options.thinking, false); assert.equal(options.maxTokens, 2400);
    assert.equal(providerContext().provider, 'openlux'); await barrier;
    assert.equal(providerContext().provider, 'openlux'); return reply('openlux', 'failed-upstream-cost', '');
  } });
  api.setTesterProvider(user, '360'); release();
  await assert.rejects(() => running, error => error.code === 'EMPTY_OUTPUT');
  const recovered = await api.testerChat(user, input('bound-failed-turn'), { chatFn: async () => {
    assert.equal(providerContext().provider, 'openlux'); return reply('openlux', 'successful-retry');
  } });
  assert.equal(recovered.provider, 'openlux'); assert.equal(recovered.supplierCostCny, 0.14);
  assert.deepEqual(recovered.callAttempts.map(item => item.provider), ['openlux', 'openlux']);
  const fresh = await api.testerChat(user, input('new-provider-turn'), { chatFn: async options => {
    assert.equal(options.model, 'deepseek/deepseek-v4-flash'); assert.equal(providerContext().provider, '360'); return reply('360', 'fresh-360');
  } });
  assert.equal(fresh.provider, '360'); assert.equal(fresh.usedCredits, 0);
  api.clearTesterKey(user, 'openlux');
  const replay = await api.testerChat(user, input('bound-failed-turn'), { chatFn: () => assert.fail('completed result never recharges') });
  assert.equal(replay.id, recovered.id);
});

test('旧二维码固定供应商，两次额度不因切换重置；新码使用新选择且成本由对应销售Key承担', async () => {
  const user = owner(); api.setTesterKey(user, 'openlux-invitation-test-key'); api.setTesterKey(user, '360-invitation-test-key', '360');
  const lead = customer(user); assert.equal(lead.invitation.provider, 'openlux');
  api.setTesterProvider(user, '360');
  assert.equal(api.createTesterInvitation(user, {}, 'https://example.test').provider, '360');
  assert.equal(api.publicTrial(lead.invitation.token).provider, 'openlux');
  for (const requestId of ['old-code-first-turn', 'old-code-second-turn']) {
    const result = await api.trialChat(lead.invitation.token, lead.accessToken, input(requestId), { chatFn: async () => {
      assert.equal(providerContext().provider, 'openlux'); assert.equal(providerContext().apiKey, 'openlux-invitation-test-key');
      return reply('openlux', requestId);
    } });
    assert.equal(result.lead.provider, 'openlux'); assert.equal(result.conversation.provider, 'openlux');
  }
  await assert.rejects(() => api.trialChat(lead.invitation.token, lead.accessToken, input('third-code-turn'), { chatFn: () => assert.fail('third turn') }), error => error.code === 'TRIAL_TURNS_EXHAUSTED');
  const analytics = testerAnalytics(user, { days: 'all' });
  assert.equal(analytics.models[0].provider, 'openlux'); assert.equal(analytics.summary.knownCostCny, 0.14);
  api.clearTesterKey(user, 'openlux');
  assert.equal(api.publicTrial(lead.invitation.token).keyConfigured, false);
  assert.equal(api.testerMe(user).keyConfigured, true);
});

test('360与OpenLux并发上下文互不串Key；供应商和Base不匹配直接拒绝', async () => {
  await Promise.all(['360', 'openlux'].map(provider => runWithProviderContext({ provider,
    baseUrl: provider === '360' ? 'https://api.360.cn/v1' : 'https://api.openlux.ai/v1',
    apiKey: `private-key-${provider}`, ownerUserId: 10 }, async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(providerContext().apiKey, `private-key-${provider}`); assert.equal(providerContext().billingMode, 'personal');
  })));
  assert.equal(providerContext(), null);
  assert.throws(() => runWithProviderContext({ provider: 'openlux', baseUrl: 'https://api.360.cn/v1', apiKey: 'wrong-base-key', ownerUserId: 10 }, () => {}), error => error.code === 'PERSONAL_KEY_REQUIRED');
});

test('OpenLux回执验证quota/USD/汇率并按owner+provider+request去重，不跨供应商吞费用', () => {
  const receipt = costOpenLux(); assert.equal(validTesterReceipt(receipt), true);
  for (const patch of [{ quota: 1 }, { amount: 1 }, { currency: 'CNY' }, { exchangeRate: 0 }, { exchangeRateSource: 'https://example.test/status' }]) {
    assert.equal(validTesterReceipt({ ...receipt, costSource: { ...receipt.costSource, ...patch } }), false);
  }
  const row = (id, provider, receipt, owner = 7) => ({ id, provider, owner_user_id: owner, cost_status: 'verified', supplier_costs_json: [receipt] });
  const rows = [row(1, '360', cost360()), row(2, 'openlux', receipt), row(3, 'openlux', receipt), row(4, 'openlux', receipt, 8)];
  assert.equal(testerEvidenceTotals(rows).supplierCostCny, 0.21);
  assert.equal(testerCostEvidence(rows).get(3).knownCostCny, 0);
  assert.equal(testerEvidenceTotals([row(5, '360', receipt)]).supplierCostCny, null);
  assert.equal(testerEvidenceTotals([row(5, '360', receipt)]).unverifiedCostCount, 1);
});

test('个人OpenLux实际chat协议独立查真实成本，不被平台计价配置关闭或走平台Key', async () => {
  const user = owner(); const key = 'personal-openlux-protocol-only-key'; api.setTesterKey(user, key);
  const previousFetch = globalThis.fetch; const urls = [];
  const { chat } = await import('../src/engines/yunwu.js');
  globalThis.fetch = async (url, options) => {
    const target = new URL(url); urls.push(target.pathname);
    assert.equal(target.origin, 'https://api.openlux.ai');
    if (target.pathname === '/v1/chat/completions') {
      assert.equal(options.headers.Authorization, `Bearer ${key}`);
      assert.equal(JSON.parse(options.body).model, 'deepseek-v4-flash');
      return new Response(JSON.stringify({ choices: [{ message: { content: '示例店供应鲜切牛肉。' } }],
        usage: { prompt_tokens: 12, completion_tokens: 18 } }), { status: 200, headers: { 'x-api-request-id': 'personal-protocol-request' } });
    }
    if (target.pathname === '/api/status') return new Response(JSON.stringify({ success: true,
      data: { quota_per_unit: 1000000, usd_exchange_rate: 7, currency_type: 'CNY' } }));
    assert.equal(target.pathname, '/api/log/token'); assert.equal(target.searchParams.get('key'), key);
    return new Response(JSON.stringify({ success: true, data: [{ request_id: 'personal-protocol-request', model_name: 'deepseek-v4-flash', quota: 10000, type: 2 }] }));
  };
  try {
    const result = await api.testerChat(user, input('personal-protocol-test'), { chatFn: chat });
    assert.equal(result.supplierCostCny, 0.07); assert.equal(result.costStatus, 'verified'); assert.equal(result.usedCredits, 0);
    assert.deepEqual(urls, ['/v1/chat/completions', '/api/status', '/api/log/token']);
  } finally { globalThis.fetch = previousFetch; }
});

test('OpenLux HTTP失败仍保存已核实上游费用，客户不扣次数且不消费平台余额', async () => {
  const user = owner(); api.setTesterKey(user, 'openlux-error-receipt-private-key'); const lead = customer(user);
  const previousFetch = globalThis.fetch; const { chat } = await import('../src/engines/yunwu.js');
  globalThis.fetch = async url => {
    const target = new URL(url); assert.equal(target.origin, 'https://api.openlux.ai');
    if (target.pathname === '/v1/chat/completions') return new Response(JSON.stringify({ error: { message: 'upstream failure' },
      usage: { prompt_tokens: 12, completion_tokens: 0 } }), { status: 502, headers: { 'x-api-request-id': 'personal-failed-request' } });
    if (target.pathname === '/api/status') return new Response(JSON.stringify({ success: true,
      data: { quota_per_unit: 1000000, usd_exchange_rate: 7, currency_type: 'CNY' } }));
    assert.equal(target.pathname, '/api/log/token'); assert.equal(target.searchParams.get('key'), 'openlux-error-receipt-private-key');
    return new Response(JSON.stringify({ success: true, data: [{ request_id: 'personal-failed-request', model_name: 'deepseek-v4-flash', quota: 10000, type: 2 }] }));
  };
  try {
    await assert.rejects(() => api.trialChat(lead.invitation.token, lead.accessToken, input('personal-failed-protocol'), { chatFn: chat }), error => error.status === 502);
    const detail = api.testerLeadDetail(user, lead.lead.id);
    assert.equal(detail.lead.usedTurns, 0); assert.equal(detail.conversations[0].supplierCostCny, 0.07);
    assert.equal(detail.conversations[0].costStatus, 'verified'); assert.equal(detail.conversations[0].status, 'failed');
    assert.equal(detail.conversations[0].usedCredits, 0); assert.equal(detail.conversations[0].usage.inputTokens, 12);
  } finally { globalThis.fetch = previousFetch; }
});

test('HTTP仅允许本人选择和分槽Key，返回profile不含密文、平台Key或实际Key', async () => {
  const user = owner(); const app = express(); app.use(express.json()); app.use('/api/tester', createTesterRouter());
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const auth = q.get('SELECT auth_version FROM users WHERE id=?', user.id);
  const headers = { Authorization: `Bearer ${signToken({ id: user.id, auth_version: auth.auth_version })}`, 'Content-Type': 'application/json' };
  const url = `http://127.0.0.1:${server.address().port}/api/tester`;
  try {
    let result = await fetch(`${url}/key`, { method: 'PUT', headers, body: JSON.stringify({ apiKey: 'http-openlux-only-fake-key', provider: 'openlux', ownerUserId: oldUserId }) });
    assert.equal(result.status, 200); let profile = await result.json(); assert.equal(profile.activeProvider, 'openlux');
    assert.ok(!JSON.stringify(profile).includes('http-openlux-only-fake-key')); assert.equal(access.testerProviderKey(oldUserId, 'openlux'), null);
    result = await fetch(`${url}/provider`, { method: 'PUT', headers, body: JSON.stringify({ provider: '360' }) });
    profile = await result.json(); assert.equal(result.status, 200); assert.equal(profile.activeProvider, '360'); assert.equal(profile.keyConfigured, false);
    result = await fetch(`${url}/key?provider=openlux`, { method: 'DELETE', headers });
    assert.equal(result.status, 200); assert.equal(access.testerProviderKey(user.id, 'openlux'), null);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

after(() => { db.close(); removeTempDbSafely(databasePath); });
