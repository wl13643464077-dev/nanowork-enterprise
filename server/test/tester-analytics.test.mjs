import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const databasePath = path.join(os.tmpdir(), `tester-analytics-${process.pid}.db`);
process.env.NANOWORK_DB = databasePath;
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.ENABLE_SCHEDULER = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'tester-analytics-fake-private-secret-'.repeat(3);
const { db, q, initSchema, migrateV2 } = await import('../src/db.js');
initSchema(); migrateV2();
const api = await import('../src/engines/tester-trials.js');
const { testerAnalytics } = await import('../src/engines/tester-analytics.js');
const { TESTER_EMPLOYEES, testerEmployeePrompt } = await import('../src/engines/tester-employee-catalog.js');
const { loadRestaurantCatalog } = await import('../src/catalog/restaurant.js');
const { CONTENT_EMPLOYEE_ROSTER } = await import('../src/catalog/content-crew.js');
const { RESTAURANT_PRIMARY_TASKS } = await import('../src/employee-workbench.js');
const { signToken } = await import('../src/util.js');
const { createTesterRouter, createPublicTrialRouter } = await import('../src/routes/testers.js');
const admin = { id: Number(q.run("INSERT INTO users(username,password_hash,name,role,tenant_id,status) VALUES('analytics_super','unused','超管','platform_super',1,'启用')").lastInsertRowid) };
let serial = 0;
function tester() {
  const n = ++serial; const username = `analytics_sales_${n}`;
  api.applyTester({ username, name: `销售${n}`, phone: `1381000${String(n).padStart(4, '0')}`, password: 'Fake-Tester-Pass-123', consent: true });
  const user = q.get('SELECT id FROM users WHERE username=?', username);
  api.updateTesterStatus(admin, user.id, 'approved'); api.setTesterProvider(user, '360'); api.setTesterKey(user, `fk-fake-analytics-${n}-private-key`);
  return user;
}
function customer(owner, status = 'approved') {
  const invitation = api.createTesterInvitation(owner, {}, 'https://example.test');
  const result = api.applyTrial(invitation.token, { name: `客户${++serial}`, phone: `1391000${String(serial).padStart(4, '0')}`, consent: true });
  if (status !== 'pending') api.updateLeadStatus(owner, result.lead.id, status);
  return { ...result, invitation };
}
const receipt = (cost, requestId = `receipt-${++serial}`) => ({ status: 'known', costYuanOverride: cost,
  costSource: { type: 'provider_receipt', provider: '360', basis: 'upstream_debit', currency: 'CNY', amount: cost, exchangeRate: 1, requestId } });
const reply = (cost = 0.01, text = '基于您提供的门店资料，以下是可以立即使用的文字方案。', receipts = [receipt(cost)]) => ({
  text, model: 'deepseek/deepseek-v4-flash', inputTokens: 10, outputTokens: 20, supplierCosts: receipts,
});
const input = (requestId, employeeId = 'content-11') => ({ requestId, employeeId, message: '我们店主打牛肉火锅，请帮我写适合门店的宣传文案。' });
const chat = (lead, data, out) => api.trialChat(lead.invitation.token, lead.accessToken, data, { chatFn: async () => {
  if (out instanceof Error) throw out;
  return out;
} });
function seedCall(owner, lead, { at, completedAt = at, cost = 0.01, receipts = [receipt(cost)], status = 'succeeded',
  costStatus = 'verified', model = 'deepseek/deepseek-v4-flash', employeeId = 'content-11', legacy = false } = {}) {
  const id = Number(q.run(`INSERT INTO tester_conversations(owner_user_id,lead_id,request_id,employee_id,input,output,
    status,model,supplier_costs_json,supplier_cost_cny,cost_status,created_at,completed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, owner.id, lead?.lead.id ?? null, `seed-${++serial}`, employeeId, '隔离测试输入',
  status === 'succeeded' ? '隔离测试输出' : '', status, model, JSON.stringify(receipts), cost, costStatus, at, completedAt).lastInsertRowid);
  if (!legacy) q.run(`INSERT INTO tester_call_attempts(conversation_id,attempt_number,status,model,supplier_costs_json,
    supplier_cost_cny,cost_status,created_at,completed_at) VALUES(?,1,?,?,?,?,?,?,?)`, id, status, model, JSON.stringify(receipts), cost, costStatus, at, completedAt);
  return id;
}

test('正式目录61个餐饮岗位+12个内容岗位，保留历史ID且每岗真实上下文和具体示例完整', () => {
  const expected = [...loadRestaurantCatalog().employees.map(employee => `restaurant-${employee.idx}`),
    ...CONTENT_EMPLOYEE_ROSTER.map(employee => `content-${employee.idx}`)];
  assert.equal(TESTER_EMPLOYEES.length, 73); assert.deepEqual(TESTER_EMPLOYEES.map(employee => employee.id), expected);
  const prompts = new Set();
  for (const employee of TESTER_EMPLOYEES) {
    assert.ok(employee.name && employee.group && employee.department && employee.description && employee.example, employee.id);
    assert.equal(employee.experienceMode, 'full'); assert.ok(employee.capabilities.length);
    const prompt = testerEmployeePrompt(employee.id); prompts.add(prompt);
    assert.ok(prompt.includes(employee.name)); assert.ok(prompt.includes('岗位职责')); assert.ok(prompt.includes('不能读取企业后台'));
    assert.match(prompt, /正式岗位的完整能力体验/);
    assert.doesNotMatch(prompt, /本体验只交付文字建议|也不能联网、调用工具/);
    assert.ok(!/\[object Object\]|undefined/.test(prompt + JSON.stringify(employee)), employee.id);
    if (employee.domain === 'restaurant' && ![104, 110, 160, 161].includes(employee.employeeIdx)) assert.ok(employee.example.includes(RESTAURANT_PRIMARY_TASKS[employee.employeeIdx]));
  }
  assert.equal(prompts.size, 73); assert.equal(testerEmployeePrompt('content-999'), null);
});

test('实际对话接入各自满血岗位提示，不降级成不能联网的文字问答', async () => {
  const owner = tester(); const seen = [];
  for (const employeeId of ['restaurant-140', 'content-10', 'content-11']) {
    await api.testerChat(owner, input(`prompt-${employeeId}`, employeeId), { chatFn: async options => {
      seen.push(options.system); assert.equal(options.system, testerEmployeePrompt(employeeId));
      assert.ok(options.system.includes('未提供的产品细节一律省略'));
      assert.ok(options.system.includes('宣传文案使用商家本人口吻'));
      assert.ok(options.system.includes('不冒充探店客户'));
      assert.ok(options.system.includes('点一份鲜切牛肉，围桌聊聊这一周'));
      assert.ok(options.system.includes('严格遵守岗位要求的条数、字数和格式'));
      assert.match(options.system, /正式岗位的完整能力体验/);
      assert.doesNotMatch(options.system, /本体验只交付文字建议|也不能联网、调用工具/);
      assert.ok(!/现点现切|慢火熬制|不加浓汤宝|老人孩子都爱/.test(options.system));
      assert.equal(options.model, 'deepseek/deepseek-v4-flash'); assert.equal(options.thinking, false);
      return reply();
    } });
  }
  assert.equal(new Set(seen).size, 3); assert.ok(seen[1].includes('明确说明文件尚未生成'));
});

test('主动选岗按客户+岗位去重且不占次数；token越权、旧同意版本和暂停被拒绝，旧用户仍可正常对话', async () => {
  const owner = tester(); const lead = customer(owner); const other = customer(tester());
  assert.ok(api.TRIAL_DISCLOSURE.includes('选择的数字员工/功能'));
  assert.equal(lead.lead.consentVersion, api.TRIAL_CONSENT_VERSION);
  assert.equal(api.recordTrialInterest(lead.invitation.token, lead.accessToken, { employeeId: 'restaurant-104' }).created, true);
  assert.equal(api.recordTrialInterest(lead.invitation.token, lead.accessToken, { employeeId: 'restaurant-104' }).created, false);
  assert.equal(api.recordTrialInterest(lead.invitation.token, lead.accessToken, { employeeId: 'content-11' }).created, true);
  assert.equal(q.get('SELECT used_turns FROM tester_leads WHERE id=?', lead.lead.id).used_turns, 0);
  assert.equal(q.get('SELECT COUNT(*) n FROM tester_interests WHERE lead_id=?', lead.lead.id).n, 2);
  assert.throws(() => api.recordTrialInterest(other.invitation.token, lead.accessToken, { employeeId: 'content-11' }), error => error.status === 401);
  assert.throws(() => api.recordTrialInterest(lead.invitation.token, lead.accessToken, { employeeId: 'restaurant-999' }), error => error.code === 'EMPLOYEE_NOT_ALLOWED');
  q.run("UPDATE tester_leads SET consent_version='2026-09-tester-v1' WHERE id=?", lead.lead.id);
  assert.throws(() => api.recordTrialInterest(lead.invitation.token, lead.accessToken, { employeeId: 'content-10' }), error => error.code === 'INTEREST_CONSENT_REQUIRED');
  const result = await chat(lead, input('legacy-consent-chat'), reply()); assert.equal(result.lead.usedTurns, 1);
  api.updateTesterStatus(admin, owner.id, 'paused');
  assert.throws(() => api.recordTrialInterest(lead.invitation.token, lead.accessToken, { employeeId: 'content-10' }), error => error.code === 'TESTER_INACTIVE');
});

test('客户看板逐次计失败重试、保留已知费用与待核，重放不新增；本人用量独立', async () => {
  const owner = tester(); const lead = customer(owner); customer(owner, 'pending');
  api.recordTrialInterest(lead.invitation.token, lead.accessToken, { employeeId: 'content-11' });
  await assert.rejects(() => chat(lead, input('retry-known-cost'), reply(0.07, '')));
  await chat(lead, input('retry-known-cost'), reply(0.03));
  await chat(lead, input('retry-known-cost'), new Error('a replay must never call provider'));
  await assert.rejects(() => chat(lead, input('retry-unknown-cost'), new Error('network failed')));
  await chat(lead, input('retry-unknown-cost'), reply(0.04));
  await api.testerChat(owner, input('personal-usage-001', 'restaurant-140'), { chatFn: async () => reply(0.2) });
  const report = testerAnalytics(owner, { days: 'all', scope: 'customers' });
  assert.equal(report.summary.totalCustomers, 2); assert.equal(report.summary.usedCustomers, 1);
  assert.equal(report.summary.unusedCustomers, 1); assert.equal(report.summary.exhaustedCustomers, 1);
  assert.equal(report.summary.successfulConversations, 2); assert.equal(report.summary.failedConversations, 0);
  assert.equal(report.summary.totalCalls, 4); assert.equal(report.summary.successfulCalls, 2); assert.equal(report.summary.failedCalls, 2);
  assert.equal(report.summary.knownCostCny, 0.14); assert.equal(report.summary.unverifiedCostCount, 1);
  assert.equal(report.personalSummary.totalCalls, 1); assert.equal(report.personalSummary.knownCostCny, 0.2);
  assert.equal(report.employees.length, 1); assert.equal(report.employees[0].employeeId, 'content-11');
  assert.equal(report.interests[0].selectedCustomers, 1); assert.equal(report.interests[0].usedCustomers, 1);
  assert.equal(report.models.length, 1); assert.equal(report.models[0].model, 'deepseek/deepseek-v4-flash');
  assert.equal(report.models[0].failedCalls, 2);
});

test('同一回执跨对话只计一次，部分known+pending在详情/客户列表/销售列表/看板金额一致', async () => {
  const owner = tester(); const lead = customer(owner); const shared = receipt(0.08);
  await chat(lead, input('duplicate-receipt-1'), reply(0.08, '第一条', [shared]));
  await chat(lead, input('duplicate-receipt-2'), reply(0.08, '第二条', [shared]));
  assert.equal(testerAnalytics(owner, { days: 'all' }).summary.knownCostCny, 0.08);
  assert.equal(api.listTesterLeads(owner)[0].supplierCostCny, 0.08);
  assert.equal(api.listTesters(admin).find(item => item.id === owner.id).supplierCostCny, 0.08);
  const partialOwner = tester(); const partialLead = customer(partialOwner);
  const output = await chat(partialLead, input('partial-receipt-1'), reply(0.07, '可交付正文', [receipt(0.07), { status: 'pending' }]));
  assert.equal(output.conversation.supplierCostCny, 0.07); assert.equal(output.conversation.costStatus, 'unverified');
  const report = testerAnalytics(partialOwner, { days: 'all' });
  assert.equal(report.summary.knownCostCny, 0.07); assert.equal(report.summary.unverifiedCostCount, 1);
  assert.equal(api.listTesterLeads(partialOwner)[0].supplierCostCny, 0.07);
  assert.equal(api.listTesters(admin).find(item => item.id === partialOwner.id).supplierCostCny, 0.07);
});

test('所有统计严格按销售范围隔离，Super可全局/指定销售，不信客户端role或owner覆盖', async () => {
  const first = tester(); const second = tester(); const a = customer(first); const b = customer(second);
  await chat(a, input('scope-first-chat'), reply(0.12)); await chat(b, input('scope-second-chat'), reply(0.21));
  const own = testerAnalytics(first, { days: 'all' }); assert.equal(own.summary.totalCustomers, 1); assert.equal(own.summary.knownCostCny, 0.12);
  assert.throws(() => testerAnalytics(first, { ownerUserId: second.id }), error => error.status === 403);
  assert.throws(() => testerAnalytics({ ...first, role: 'platform_super' }, {}, true), error => error.code === 'SUPER_REQUIRED');
  const filtered = testerAnalytics(admin, { days: 'all', ownerUserId: second.id }, true);
  assert.equal(filtered.ownerUserId, second.id); assert.equal(filtered.summary.totalCustomers, 1); assert.equal(filtered.summary.knownCostCny, 0.21);
  const all = testerAnalytics(admin, { days: 'all' }, true); assert.ok(all.summary.totalCustomers > filtered.summary.totalCustomers);
  assert.throws(() => testerAnalytics(first, { days: '1' })); assert.throws(() => testerAnalytics(first, { scope: 'all' }));
  api.updateTesterStatus(admin, second.id, 'paused');
  assert.throws(() => testerAnalytics(second), error => error.code === 'TESTER_INACTIVE');
  assert.equal(testerAnalytics(admin, { days: 'all', ownerUserId: second.id }, true).summary.knownCostCny, 0.21);
});

test('上海日期边界包含第7天零点、排除前1秒/未来；旧回执跨窗口重放不重复计价', () => {
  const owner = tester(); const lead = customer(owner); const now = Date.parse('2026-09-06T12:00:00Z');
  q.run("UPDATE tester_leads SET created_at='2026-08-30T16:00:00.000Z' WHERE id=?", lead.lead.id);
  const shared = receipt(0.17);
  seedCall(owner, lead, { at: '2026-08-30T15:59:59.000Z', receipts: [shared], cost: 0.17 });
  seedCall(owner, lead, { at: '2026-08-30T16:00:00.000Z', cost: 0.02 });
  seedCall(owner, lead, { at: '2026-09-01T00:00:00.000Z', receipts: [shared], cost: 0.17 });
  seedCall(owner, lead, { at: '2026-09-06T12:00:01.000Z', cost: 9 });
  // Existing SQLite rows use server-local timestamps: equivalent instant must
  // be counted in the same Shanghai day as ISO timestamps.
  const localDate = q.get("SELECT datetime('2026-09-02T02:00:00Z','localtime') date").date;
  seedCall(owner, lead, { at: localDate, cost: 0.03 });
  const report = testerAnalytics(owner, { days: '7' }, false, now);
  assert.equal(report.period.from, '2026-08-30T16:00:00.000Z'); assert.equal(report.timeline.length, 7);
  assert.equal(report.summary.totalCustomers, 1); assert.equal(report.summary.totalCalls, 3); assert.equal(report.summary.knownCostCny, 0.05);
  assert.equal(report.timeline[0].date, '2026-08-31'); assert.equal(report.timeline[0].newCustomers, 1);
  assert.equal(report.timeline.find(day => day.date === '2026-09-02').knownCostCny, 0.03);
});

test('旧对话无attempt记录时保留真实回执；没有回执的旧裸金额不冒充已核实费用', () => {
  const owner = tester(); const lead = customer(owner); const at = new Date().toISOString();
  seedCall(owner, lead, { at, cost: 0.01, legacy: true }); seedCall(owner, lead, { at, cost: 0.02, legacy: true });
  seedCall(owner, lead, { at, cost: 99, receipts: [], legacy: true });
  const report = testerAnalytics(owner, { days: 'all' });
  assert.equal(report.summary.totalCalls, 3); assert.equal(report.summary.legacyRecordCount, 3);
  assert.equal(report.summary.knownCostCny, 0.03); assert.equal(report.summary.unverifiedCostCount, 1);
  assert.equal(api.listTesterLeads(owner)[0].supplierCostCny, 0.03);
  assert.equal(api.listTesterLeads(owner)[0].unverifiedCostCount, 1);
});

test('同秒调用按数值ID保持先后；冲突回执不计为已核实金额', () => {
  const owner = tester(); const lead = customer(owner); const at = new Date().toISOString(); const shared = receipt(0.09);
  // Cross a decimal digit boundary (9→10 or 99→100) in global attempt ids.
  const current = q.get('SELECT COALESCE(MAX(id),0) n FROM tester_call_attempts').n;
  const target = 10 ** String(current + 2).length - 1;
  q.run("UPDATE sqlite_sequence SET seq=? WHERE name='tester_call_attempts'", target - 1);
  seedCall(owner, lead, { at, cost: 0.09, receipts: [shared] });
  seedCall(owner, null, { at, cost: 0.09, receipts: [shared] });
  let report = testerAnalytics(owner, { days: 'all' });
  assert.equal(report.summary.knownCostCny, 0.09); assert.equal(report.personalSummary.knownCostCny, 0);
  seedCall(owner, lead, { at, cost: 0.1, receipts: [receipt(0.1, shared.costSource.requestId)] });
  report = testerAnalytics(owner, { days: 'all' });
  assert.equal(report.summary.knownCostCny, 0); assert.equal(report.summary.unverifiedCostCount, 2);
});

test('HTTP真实权限与参数验证：未知时间/重复参数返回400，普通tester不能查其他销售，public interest需要客户token', async () => {
  const owner = tester(); const lead = customer(owner); const app = express(); app.use(express.json());
  app.use('/api/tester', createTesterRouter({ chatFn: async () => reply() })); app.use('/api/trial', createPublicTrialRouter({ chatFn: async () => reply() }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const user = q.get('SELECT * FROM users WHERE id=?', owner.id); const headers = { Authorization: `Bearer ${signToken({ id: owner.id, auth_version: user.auth_version })}` };
  try {
    for (const query of ['now=8640000000000000&days=all', 'days=7&days=30', 'anything=x', 'scope=self']) {
      assert.equal((await fetch(`${base}/api/tester/analytics?${query}`, { headers })).status, 400, query);
    }
    assert.equal((await fetch(`${base}/api/tester/analytics?ownerUserId=${admin.id}`, { headers })).status, 403);
    assert.equal((await fetch(`${base}/api/tester/admin/analytics?days=all`, { headers })).status, 403);
    const own = await fetch(`${base}/api/tester/analytics?days=7&scope=customers`, { headers }); assert.equal(own.status, 200);
    assert.equal((await own.json()).timeline.length, 7);
    const route = `${base}/api/trial/${lead.invitation.token}/interest`;
    const data = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeId: 'content-11' }) };
    assert.equal((await fetch(route, data)).status, 401);
    const response = await fetch(route, { ...data, headers: { ...data.headers, 'X-Trial-Token': lead.accessToken } });
    assert.equal(response.status, 200); assert.equal((await response.json()).created, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

after(() => { db.close(); removeTempDbSafely(databasePath); });
