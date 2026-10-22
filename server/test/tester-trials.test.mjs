import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const databasePath = path.join(os.tmpdir(), `tester-trials-${process.pid}.db`);
process.env.NANOWORK_DB = databasePath;
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.ENABLE_SCHEDULER = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'tester-regression-private-key-'.repeat(3);
const { db, q, initSchema, migrateV2 } = await import('../src/db.js');
initSchema(); migrateV2();
const api = await import('../src/engines/tester-trials.js');
const access = await import('../src/engines/tester-access.js');
const { providerContext, runWithProviderContext } = await import('../src/engines/tester-provider-context.js');
const { signToken, createSession, sessionActive, authMiddleware } = await import('../src/util.js');
const { createTesterRouter, createPublicTrialRouter } = await import('../src/routes/testers.js');
const superId = Number(q.run("INSERT INTO users(username,password_hash,name,role,tenant_id,status) VALUES('tester_super','unused','超管','platform_super',1,'启用')").lastInsertRowid);
const admin = { id: superId };
let sequence = 0;
const data = () => ({ username: `tester_user_${++sequence}`, name: `销售${sequence}`, phone: `1380000${String(sequence).padStart(4, '0')}`, password: 'Tester-Password-123', consent: true });
function tester() {
  const input = data(); api.applyTester(input);
  const user = q.get('SELECT id FROM users WHERE username=?', input.username);
  api.updateTesterStatus(admin, user.id, 'approved');
  api.setTesterProvider(user, '360');
  api.setTesterKey(user, `fk-${input.username}-private-test-key`);
  return user;
}
let receiptCounter = 0;
const reply = ({ text = '今天鲜切的牛肉，上桌就涮，和朋友一起吃一顿热乎的。', cost = 0.01 } = {}) => ({
  text, model: 'deepseek/deepseek-v4-flash', inputTokens: 10, outputTokens: 20,
  supplierCosts: [{ status: 'known', costYuanOverride: cost,
    costSource: { type: 'provider_receipt', provider: '360', basis: 'upstream_debit', currency: 'CNY',
      amount: cost, exchangeRate: 1, requestId: `receipt-${++receiptCounter}` } }],
});
function leadFor(owner) {
  const invitation = api.createTesterInvitation(owner, {}, 'https://example.test');
  const input = { name: '体验顾客', phone: `1390000${String(++sequence).padStart(4, '0')}`, consent: true, storeName: '火锅店' };
  const applied = api.applyTrial(invitation.token, input);
  api.updateLeadStatus(owner, applied.lead.id, 'approved');
  return { invitation, ...applied, phone: input.phone };
}
const message = requestId => ({ employeeId: 'content-11', message: '帮我的火锅店写一个种草标题。', requestId });

test('测试员申请独立空间，审核才能登录，禁止重复手机号及用户名，不创建企业共享席位', () => {
  const input = data(); const result = api.applyTester(input);
  assert.equal(result.status, 'pending');
  const user = q.get('SELECT * FROM users WHERE username=?', input.username);
  assert.equal(user.status, '停用'); assert.equal(user.role, 'sales'); assert.equal(user.modules, '[]');
  assert.notEqual(user.tenant_id, 1);
  const tenant = q.get('SELECT * FROM tenants WHERE id=?', user.tenant_id);
  assert.equal(tenant.seat_limit, 1); assert.equal(tenant.credits, 0); assert.equal(tenant.modules, '[]');
  assert.throws(() => api.testerMe(user), error => error.code === 'TESTER_INACTIVE');
  assert.throws(() => api.applyTester({ ...input, username: 'different_username' }), error => error.code === 'PHONE_ALREADY_APPLIED');
  assert.throws(() => api.updateTesterStatus(user, user.id, 'approved'), error => error.status === 403);
  api.updateTesterStatus(admin, user.id, 'approved');
  assert.equal(api.testerMe(user).accountType, 'tester');
  assert.equal(api.testerMe(user).activeProvider, '360');
  assert.equal(api.testerMe(user).employees.length, 73);
});

test('个人Key加密，接口与DB不能泄露明文；不同账号ALS并发完全隔离', async () => {
  const first = tester(); const second = tester();
  const a = access.testerProviderKey(first.id, '360'); const b = access.testerProviderKey(second.id, '360');
  const keyA = access.decryptTesterSecret(a.api_key_cipher);
  assert.ok(!a.api_key_cipher.includes(keyA)); assert.ok(!JSON.stringify(api.testerMe(first)).includes(keyA));
  assert.ok(api.testerMe(first).keyMasked.includes('••••'));
  await Promise.all([first, second].map(async owner => {
    const result = await api.testerChat(owner, { ...message(`private-${owner.id}`), employeeId: 'content-3' }, { chatFn: async () => {
      await new Promise(resolve => setTimeout(resolve, 3));
      assert.equal(providerContext().ownerUserId, owner.id);
      assert.equal(providerContext().apiKey, access.decryptTesterSecret(owner.id === first.id ? a.api_key_cipher : b.api_key_cipher));
      return reply();
    } });
    assert.equal(result.usedCredits, 0); assert.equal(result.supplierCostCny, 0.01); assert.equal(result.costStatus, 'verified');
  }));
  assert.equal(providerContext(), null);
  assert.throws(() => runWithProviderContext({ provider: '360', apiKey: '' }, () => {}), error => error.code === 'PERSONAL_KEY_REQUIRED');
  api.clearTesterKey(first);
  await assert.rejects(async () => api.testerChat(first, message('missing-key-001'), { chatFn: () => assert.fail('must not invoke platform provider') }), error => error.code === 'PERSONAL_KEY_REQUIRED');
});

test('两轮按成功问答计数；成功请求重放不重复调用，不允许第三轮，也不能换码重申', async () => {
  const owner = tester(); const customer = leadFor(owner); let calls = 0;
  const run = requestId => api.trialChat(customer.invitation.token, customer.accessToken, message(requestId), { chatFn: async () => { calls++; return reply(); } });
  const first = await run('turn-request-001');
  assert.equal(first.lead.usedTurns, 1);
  const replay = await run('turn-request-001');
  assert.equal(replay.conversation.id, first.conversation.id); assert.equal(calls, 1);
  const second = await run('turn-request-002'); assert.equal(second.lead.usedTurns, 2);
  await assert.rejects(() => run('turn-request-003'), error => error.code === 'TRIAL_TURNS_EXHAUSTED'); assert.equal(calls, 2);
  const another = api.createTesterInvitation(tester(), {}, 'https://example.test');
  assert.throws(() => api.applyTrial(another.token, { name: '同一客户', phone: customer.phone, consent: true }), error => error.code === 'TRIAL_ALREADY_APPLIED');
  assert.throws(() => api.trialSession(another.token, customer.accessToken), error => error.status === 401);
});

test('失败不吞次数，同一请求可重试；请求标识复用不同正文被拒绝', async () => {
  const owner = tester(); const customer = leadFor(owner);
  await assert.rejects(() => api.trialChat(customer.invitation.token, customer.accessToken, message('retry-request-001'), {
    chatFn: async () => { throw new Error('upstream network failure with secret that must not escape'); },
  }), error => error.status === 502 && !error.message.includes('secret'));
  assert.equal(api.trialSession(customer.invitation.token, customer.accessToken).lead.usedTurns, 0);
  const success = await api.trialChat(customer.invitation.token, customer.accessToken, message('retry-request-001'), { chatFn: async () => reply() });
  assert.equal(success.lead.usedTurns, 1);
  assert.equal(q.get('SELECT attempts FROM tester_conversations WHERE id=?', success.conversation.id).attempts, 2);
  await assert.rejects(() => api.trialChat(customer.invitation.token, customer.accessToken,
    { ...message('retry-request-001'), message: '不同的问题' }), error => error.code === 'IDEMPOTENCY_CONFLICT');
});

test('并发请求预占名额，同一客户等待上一轮；真实结果之后才扣次数', async () => {
  const owner = tester(); const customer = leadFor(owner);
  let resolve; const barrier = new Promise(done => { resolve = done; });
  const first = api.trialChat(customer.invitation.token, customer.accessToken, message('parallel-turn-001'), { chatFn: async () => { await barrier; return reply(); } });
  await assert.rejects(() => api.trialChat(customer.invitation.token, customer.accessToken, message('parallel-turn-001')), error => error.code === 'REQUEST_RUNNING');
  await assert.rejects(() => api.trialChat(customer.invitation.token, customer.accessToken, message('parallel-turn-002')), error => error.code === 'REQUEST_RUNNING');
  assert.equal(api.trialSession(customer.invitation.token, customer.accessToken).lead.usedTurns, 0);
  resolve(); await first;
  assert.equal(api.trialSession(customer.invitation.token, customer.accessToken).lead.usedTurns, 1);
});

test('Super暂停账号立即吊销会话并停用所有邀请码；在途结果保留成本，不放行正文或扣次数', async () => {
  const owner = tester(); const customer = leadFor(owner);
  const jti = createSession({ userId: owner.id });
  let resolve; const barrier = new Promise(done => { resolve = done; });
  const inFlight = api.trialChat(customer.invitation.token, customer.accessToken, message('pause-running-001'), { chatFn: async () => { await barrier; return reply({ cost: 0.02 }); } });
  api.updateTesterStatus(admin, owner.id, 'paused');
  assert.equal(sessionActive(jti), false);
  assert.throws(() => api.publicTrial(customer.invitation.token), error => error.code === 'TESTER_INACTIVE');
  resolve(); await assert.rejects(() => inFlight, error => error.code === 'TESTER_INACTIVE');
  const detail = api.testerLeadDetail(admin, customer.lead.id, true);
  assert.equal(detail.lead.usedTurns, 0); assert.equal(detail.conversations[0].output, '');
  assert.equal(detail.conversations[0].supplierCostCny, 0.02); assert.equal(detail.conversations[0].status, 'failed');
});

test('销售只能看自己的客户，手机号和输入输出对本人及Super可追溯；客户必须明确知情', async () => {
  const owner = tester(); const other = tester(); const customer = leadFor(owner);
  assert.ok(api.publicTrial(customer.invitation.token).disclosure.includes('输入、输出'));
  assert.throws(() => api.applyTrial(customer.invitation.token, { name: '顾客', phone: '13999999999' }), /阅读并同意/);
  assert.throws(() => api.testerLeadDetail(other, customer.lead.id), error => error.status === 404);
  assert.throws(() => api.updateLeadStatus(other, customer.lead.id, 'approved'), error => error.status === 404);
  assert.throws(() => api.listTesters(other), error => error.code === 'SUPER_REQUIRED');
  await api.trialChat(customer.invitation.token, customer.accessToken, message('audit-turn-001'), { chatFn: async () => reply() });
  const detail = api.testerLeadDetail(owner, customer.lead.id);
  assert.equal(detail.lead.phone, customer.phone); assert.ok(detail.conversations[0].input); assert.ok(detail.conversations[0].output);
  assert.ok(api.listTesters(admin).find(item => item.id === owner.id).usedTurns === 1);
  api.updateLeadStatus(owner, customer.lead.id, 'paused');
  await assert.rejects(() => api.trialChat(customer.invitation.token, customer.accessToken, message('paused-lead-002')), error => error.code === 'TRIAL_UNAVAILABLE');
});

test('供应商没有费用回执时显示待核实，不伪造免费；空正文不扣体验次数', async () => {
  const owner = tester(); const customer = leadFor(owner);
  const result = await api.trialChat(customer.invitation.token, customer.accessToken, message('unverified-001'), { chatFn: async () => ({ text: '完整的正文', model: 'deepseek/deepseek-v4-flash' }) });
  assert.equal(result.conversation.supplierCostCny, null); assert.equal(result.conversation.costStatus, 'unverified');
  await assert.rejects(() => api.trialChat(customer.invitation.token, customer.accessToken, message('empty-output-002'), { chatFn: async () => ({ text: '' }) }), error => error.status === 502);
  assert.equal(api.trialSession(customer.invitation.token, customer.accessToken).lead.usedTurns, 1);
});

test('逐次付费调用保留回执：空产物失败后重试累计两次真实成本，不只显示最后一次', async () => {
  const owner = tester(); const customer = leadFor(owner);
  await assert.rejects(() => api.trialChat(customer.invitation.token, customer.accessToken, message('cost-retry-001'), {
    chatFn: async () => reply({ text: '', cost: 0.07 }),
  }), error => error.code === 'EMPTY_OUTPUT');
  const failed = api.testerLeadDetail(owner, customer.lead.id).conversations[0];
  assert.equal(failed.supplierCostCny, 0.07); assert.equal(failed.callAttempts[0].status, 'failed');
  const result = await api.trialChat(customer.invitation.token, customer.accessToken, message('cost-retry-001'), { chatFn: async () => reply({ cost: 0.03 }) });
  assert.equal(result.lead.usedTurns, 1);
  assert.ok(Math.abs(result.conversation.supplierCostCny - 0.1) < 1e-12);
  assert.equal(result.conversation.costStatus, 'verified');
  assert.deepEqual(result.conversation.callAttempts.map(item => item.status), ['failed', 'succeeded']);
  assert.deepEqual(result.conversation.callAttempts.map(item => item.supplierCostCny), [0.07, 0.03]);
  assert.equal(result.conversation.supplierCosts.length, 2);
  const replay = await api.trialChat(customer.invitation.token, customer.accessToken, message('cost-retry-001'), { chatFn: () => assert.fail('must not recharge replay') });
  assert.equal(replay.conversation.callAttempts.length, 2);
  assert.ok(Math.abs(api.listTesters(admin).find(item => item.id === owner.id).supplierCostCny - 0.1) < 1e-12);
});

test('有未知费用的失败重试不消失：已核实金额继续展示，未知次数单独记录', async () => {
  const owner = tester(); const customer = leadFor(owner);
  await assert.rejects(() => api.trialChat(customer.invitation.token, customer.accessToken, message('unknown-retry-001'), {
    chatFn: async () => { throw Object.assign(new Error('unavailable'), { providerUsage: { inputTokens: 7, outputTokens: 0 } }); },
  }));
  const result = await api.trialChat(customer.invitation.token, customer.accessToken, message('unknown-retry-001'), { chatFn: async () => reply({ cost: 0.04 }) });
  assert.equal(result.conversation.supplierCostCny, 0.04);
  assert.equal(result.conversation.costStatus, 'unverified'); assert.equal(result.conversation.unverifiedCostCount, 1);
  assert.equal(result.conversation.callAttempts.length, 2);
  assert.equal(result.conversation.callAttempts[0].supplierCostCny, null);
  assert.equal(result.conversation.usage.inputTokens, 17);
  assert.equal(api.listTesters(admin).find(item => item.id === owner.id).unverifiedCostCount, 1);
});

test('供应商重放同一扣费回执不在两次尝试合计里重复计价', async () => {
  const owner = tester(); const customer = leadFor(owner); const sameReceipt = reply({ text: '', cost: 0.08 });
  await assert.rejects(() => api.trialChat(customer.invitation.token, customer.accessToken, message('same-receipt-001'), { chatFn: async () => sameReceipt }));
  const result = await api.trialChat(customer.invitation.token, customer.accessToken, message('same-receipt-001'), { chatFn: async () => ({ ...sameReceipt, text: '供应商恢复了同一结果' }) });
  assert.equal(result.conversation.supplierCostCny, 0.08);
  assert.equal(result.conversation.callAttempts.length, 2); assert.equal(result.conversation.costStatus, 'verified');
});

test('已过租约的旧请求晚到只记录它的成本，不能覆盖或终止重试中的新请求', async () => {
  const owner = tester(); const customer = leadFor(owner);
  let resolveOld; let resolveNew;
  const oldBarrier = new Promise(resolve => { resolveOld = resolve; });
  const newBarrier = new Promise(resolve => { resolveNew = resolve; });
  const oldCall = api.trialChat(customer.invitation.token, customer.accessToken, message('expired-retry-001'), { chatFn: async () => { await oldBarrier; return reply({ text: '旧结果', cost: 0.06 }); } });
  q.run('UPDATE tester_conversations SET lease_expires=0 WHERE lead_id=?', customer.lead.id);
  const newCall = api.trialChat(customer.invitation.token, customer.accessToken, message('expired-retry-001'), { chatFn: async () => { await newBarrier; return reply({ text: '新结果', cost: 0.04 }); } });
  resolveOld(); await assert.rejects(() => oldCall, error => error.code === 'REQUEST_INTERRUPTED');
  assert.equal(api.testerLeadDetail(owner, customer.lead.id).conversations[0].status, 'running');
  resolveNew(); const final = await newCall;
  assert.equal(final.conversation.output, '新结果'); assert.equal(final.lead.usedTurns, 1);
  assert.equal(final.conversation.callAttempts.length, 2);
  assert.ok(Math.abs(final.conversation.supplierCostCny - 0.1) < 1e-12);
});

test('HTTP权限闭环：tester可访问业务和附件守卫入口，不能管理子账号/API配置或冒充Super', async () => {
  const owner = tester(); const customer = leadFor(owner);
  const app = express(); app.use(express.json());
  app.use('/api/tester', createTesterRouter({ chatFn: async () => reply() }));
  app.use('/api/trial', createPublicTrialRouter({ chatFn: async () => reply() }));
  for (const path of ['/api/admin/users', '/api/sys/config', '/api/employee-workbench', '/uploads/private.png']) {
    app.all(path, authMiddleware, (_req, res) => res.json({ forbiddenData: true }));
  }
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const user = q.get('SELECT * FROM users WHERE id=?', owner.id);
  const token = signToken({ id: owner.id, auth_version: user.auth_version });
  const headers = { Authorization: `Bearer ${token}` };
  try {
    for (const route of ['/api/admin/users', '/api/sys/config', '/api/tester/admin/applications']) {
      const result = await fetch(`${base}${route}`, { headers }); assert.equal(result.status, 403, route);
    }
    for (const route of ['/api/employee-workbench', '/uploads/private.png']) {
      const result = await fetch(`${base}${route}`, { headers }); assert.equal(result.status, 200, `${route}: auth permits business; mounted ownership guards remain required`);
    }
    const me = await fetch(`${base}/api/tester/me`, { headers }); assert.equal(me.status, 200); assert.equal((await me.json()).accountType, 'tester');
    const publicResult = await fetch(`${base}/api/trial/${customer.invitation.token}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trial-Token': customer.accessToken }, body: JSON.stringify(message('http-trial-001')),
    });
    assert.equal(publicResult.status, 200); assert.equal((await publicResult.json()).lead.usedTurns, 1);
    const missing = await fetch(`${base}/api/trial/${customer.invitation.token}/session`); assert.equal(missing.status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('体验正文里模型自行添加的口味、人群、价格、工艺、评价被标记为待核实建议，交付与计次不受影响', async () => {
  const owner = tester(); const customer = leadFor(owner);
  const invented = '周末来店里聚一聚。鲜切牛肉入口即化，麻辣鲜香，秘制老汤慢炖8小时，人均58元，回头客都说必点，老少皆宜。';
  const result = await api.trialChat(customer.invitation.token, customer.accessToken,
    { employeeId: 'content-11', message: '我们店只确认一道菜：鲜切牛肉，主题是周末聚餐。写一段文案。', requestId: 'fact-advice-001' },
    { chatFn: async () => reply({ text: invented }) });
  assert.equal(result.conversation.output, invented, '正文原样保存交付，不做改写');
  assert.equal(result.lead.usedTurns, 1, '有正文即计次，建议不影响计次');
  const advice = result.conversation.factAdvice;
  assert.ok(Array.isArray(advice) && advice.length >= 4, JSON.stringify(advice));
  assert.ok(advice.some(line => /口味\/口感.*入口即化/u.test(line)));
  assert.ok(advice.some(line => /适合人群.*老少皆宜/u.test(line)));
  assert.ok(advice.some(line => /配料\/工艺.*秘制/u.test(line)));
  assert.ok(advice.some(line => /顾客评价\/销量.*回头客/u.test(line)));
  assert.ok(advice.some(line => /价格\/折扣.*58元/u.test(line)));
  assert.ok(!advice.some(line => /鲜切/u.test(line)), '用户确认过的菜名不能被当作编造');
  const grounded = await api.trialChat(customer.invitation.token, customer.accessToken,
    { employeeId: 'content-11', message: '第二段。', requestId: 'fact-advice-002' }, { chatFn: async () => reply() });
  assert.deepEqual(grounded.conversation.factAdvice, []);
  assert.deepEqual(api.testerLeadDetail(owner, customer.lead.id).conversations.map(item => item.factAdvice.length > 0), [true, false]);
});

after(() => { db.close(); removeTempDbSafely(databasePath); });
