import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import express from 'express';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const databasePath = path.join(os.tmpdir(), `tester-trial-full-${process.pid}.db`);
process.env.NANOWORK_DB = databasePath;
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.ENABLE_SCHEDULER = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'tester-full-blood-fake-test-secret-'.repeat(3);
const { db, q, initSchema, migrateV2 } = await import('../src/db.js');
initSchema(); migrateV2();
const api = await import('../src/engines/tester-trials.js');
const { TESTER_EMPLOYEES, testerEmployeePrompt, FEATURED_TRIAL_EMPLOYEE_IDS } = await import('../src/engines/tester-employee-catalog.js');
const { providerContext } = await import('../src/engines/tester-provider-context.js');
const { testerAnalytics } = await import('../src/engines/tester-analytics.js');
const { createTesterRouter, createPublicTrialRouter } = await import('../src/routes/testers.js');
const { signToken } = await import('../src/util.js');
const featuredIds = [...FEATURED_TRIAL_EMPLOYEE_IDS];
const featuredLabels = { 'restaurant-104': '选址', 'restaurant-160': '超级店长', 'restaurant-161': '巡店', 'content-11': '小红书种草', 'content-10': 'AI带货' };
const admin = { id: Number(q.run("INSERT INTO users(username,password_hash,name,role,tenant_id,status) VALUES('full_super','unused','超管','platform_super',1,'启用')").lastInsertRowid) };
let sequence = 0;
function tester() {
  const n = ++sequence; const username = `full_sales_${n}`;
  api.applyTester({ username, name: `销售${n}`, phone: `1382000${String(n).padStart(4, '0')}`, password: 'Fake-Tester-Pass-123', consent: true });
  const owner = q.get('SELECT id FROM users WHERE username=?', username);
  api.updateTesterStatus(admin, owner.id, 'approved');
  api.setTesterKey(owner, `fk-only-fake-full-key-${owner.id}`, '360');
  return owner;
}
function customer(owner) {
  const invitation = api.createTesterInvitation(owner, {}, 'https://example.test');
  const result = api.applyTrial(invitation.token, { name: '体验客户', phone: `1392000${String(++sequence).padStart(4, '0')}`, consent: true });
  api.updateLeadStatus(owner, result.lead.id, 'approved');
  return { ...result, invitation };
}
const input = (employeeId, requestId = `full-request-${++sequence}`) => ({ employeeId, requestId, message: '请根据我提供的门店资料列出下一步行动。' });
const result = () => ({ text: '先整理已提供的资料，再补充缺失信息。', model: 'deepseek/deepseek-v4-flash' });

test('新旧二维码都只返回五个满血体验岗，常用入口原名不变', () => {
  const owner = tester(); const lead = customer(owner);
  q.run("UPDATE tester_invitations SET created_at='2026-08-01T00:00:00.000Z' WHERE id=?", lead.invitation.id);
  const publicData = api.publicTrial(lead.invitation.token); const me = api.testerMe(owner);
  assert.equal(publicData.employees.length, 5);
  assert.deepEqual(publicData.employees.map(item => item.id), featuredIds);
  assert.deepEqual(me.trialEmployees.map(item => item.id), featuredIds);
  assert.equal(me.employees.length, 73);
  assert.deepEqual(me.employees, TESTER_EMPLOYEES);
  assert.equal(publicData.turnLimit, 2); assert.equal(publicData.provider, '360');
  assert.match(api.TRIAL_DISCLOSURE, /五位与正式产品相同能力的数字员工/);
  for (const id of featuredIds) {
    const employee = publicData.employees.find(item => item.id === id);
    const original = TESTER_EMPLOYEES.find(item => item.id === id);
    assert.equal(employee.name, original.name);
    assert.equal(employee.displayName, featuredLabels[id]);
    assert.equal(employee.example, original.example);
    assert.equal(employee.experienceMode, 'full');
    assert.ok(employee.description && employee.example && employee.experienceNote);
  }
  assert.ok(Object.isFrozen(api.TRIAL_EMPLOYEES)); assert.ok(Object.isFrozen(api.TRIAL_EMPLOYEES[0]));
});

test('客户体验接入满血岗位提示，禁止阉割成不能联网的文字问答', async () => {
  const owner = tester(); const other = tester(); let calls = 0;
  const source = fs.readFileSync(new URL('../src/engines/tester-trials.js', import.meta.url), 'utf8');
  assert.match(source, /marshalWork\(runtime\.marshal/);
  assert.match(source, /requireAgenticResearch: true/);
  assert.match(source, /buildEmployeeExecutionProfile\(employee\.employeeIdx/);
  assert.match(source, /generateImageFn: chatFn === chat \? generateImage/);
  assert.match(source, /campaignSourceType: 'tester_conversation'/);
  for (const employeeId of featuredIds) {
    const lead = customer(owner);
    assert.equal(api.recordTrialInterest(lead.invitation.token, lead.accessToken, { employeeId }).created, true);
    const response = await api.trialChat(lead.invitation.token, lead.accessToken, {
      ...input(employeeId), ownerUserId: other.id, leadId: null, provider: 'openlux', apiKey: 'body-cannot-select-key', scope: 'personal',
    }, { chatFn: async options => {
      calls++;
      assert.equal(options.system, testerEmployeePrompt(employeeId));
      assert.match(options.system, /正式岗位的完整能力体验/);
      assert.match(options.system, /不得声称不能联网/);
      assert.doesNotMatch(options.system, /本体验只交付文字建议|也不能联网、调用工具/);
      assert.equal(providerContext().ownerUserId, owner.id); assert.equal(providerContext().provider, '360');
      assert.equal(providerContext().apiKey, `fk-only-fake-full-key-${owner.id}`);
      return result();
    } });
    assert.equal(response.conversation.status, 'succeeded'); assert.equal(response.conversation.employeeId, employeeId);
    assert.equal(response.conversation.ownerUserId, owner.id); assert.equal(response.conversation.leadId, lead.lead.id);
    assert.equal(response.lead.usedTurns, 1); assert.equal(response.conversation.usedCredits, 0);
  }
  assert.equal(calls, 5); assert.equal(api.listTesterLeads(other).length, 0);
});

test('五个体验岗共用两轮成功额度，重放不重扣，切到第三岗也不能再体验', async () => {
  const owner = tester(); const lead = customer(owner); let calls = 0;
  const options = { chatFn: async () => { calls++; return result(); } };
  const first = input('restaurant-104');
  await api.trialChat(lead.invitation.token, lead.accessToken, first, options);
  const replay = await api.trialChat(lead.invitation.token, lead.accessToken, first, options);
  assert.equal(replay.lead.usedTurns, 1); assert.equal(calls, 1);
  const second = await api.trialChat(lead.invitation.token, lead.accessToken, input('restaurant-160'), options);
  assert.equal(second.lead.usedTurns, 2);
  await assert.rejects(() => api.trialChat(lead.invitation.token, lead.accessToken, input('content-11'), options), error => error.code === 'TRIAL_TURNS_EXHAUSTED');
  assert.equal(calls, 2);
});

test('历史正文仍可查，不在五个体验岗内的岗位不可新发或记录兴趣', async () => {
  const owner = tester(); const lead = customer(owner); const requestId = 'old-public-content-three';
  const id = Number(q.run(`INSERT INTO tester_conversations(owner_user_id,lead_id,request_id,employee_id,input,output,status,model)
    VALUES(?,?,?,'content-3','原来的输入','旧岗位历史正文','succeeded','deepseek/deepseek-v4-flash')`, owner.id, lead.lead.id, requestId).lastInsertRowid);
  q.run('UPDATE tester_leads SET used_turns=1 WHERE id=?', lead.lead.id);
  const originalName = TESTER_EMPLOYEES.find(item => item.id === 'content-3').name;
  for (const record of [api.trialSession(lead.invitation.token, lead.accessToken).conversations[0], api.testerLeadDetail(owner, lead.lead.id).conversations[0]]) {
    assert.equal(record.id, id); assert.equal(record.output, '旧岗位历史正文'); assert.equal(record.employeeName, originalName);
  }
  const analytics = testerAnalytics(owner, { days: 'all' });
  assert.equal(analytics.employees[0].employeeId, 'content-3');
  const noCall = { chatFn: () => assert.fail('unknown employee must not call upstream') };
  const replay = await api.trialChat(lead.invitation.token, lead.accessToken, { ...input('content-3', requestId), message: '原来的输入' }, { chatFn: async () => result() });
  assert.equal(replay.conversation.output, '旧岗位历史正文');
  await assert.rejects(() => api.trialChat(lead.invitation.token, lead.accessToken, input('restaurant-140'), noCall), error => error.code === 'EMPLOYEE_NOT_ALLOWED');
  await assert.rejects(() => api.trialChat(lead.invitation.token, lead.accessToken, input('content-3'), noCall), error => error.code === 'EMPLOYEE_NOT_ALLOWED');
  await assert.rejects(() => api.trialChat(lead.invitation.token, lead.accessToken, input('restaurant-999'), noCall), error => error.code === 'EMPLOYEE_NOT_ALLOWED');
  assert.throws(() => api.recordTrialInterest(lead.invitation.token, lead.accessToken, { employeeId: 'content-3' }), error => error.code === 'EMPLOYEE_NOT_ALLOWED');
  assert.throws(() => api.recordTrialInterest(lead.invitation.token, lead.accessToken, { employeeId: 'content-999' }), error => error.code === 'EMPLOYEE_NOT_ALLOWED');
  assert.equal(api.trialSession(lead.invitation.token, lead.accessToken).lead.usedTurns, 1);
});

test('HTTP公共目录只开放五个满血岗，伪造身份字段不放行；其余岗位拒绝，测试员本人仍可用完整目录', async () => {
  const owner = tester(); const lead = customer(owner); const other = tester(); let calls = 0;
  const app = express(); app.use(express.json());
  const chatFn = async () => { calls++; return result(); };
  app.use('/api/tester', createTesterRouter({ chatFn })); app.use('/api/trial', createPublicTrialRouter({ chatFn }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const trialUrl = `${base}/api/trial/${lead.invitation.token}`;
  const authVersion = q.get('SELECT auth_version FROM users WHERE id=?', owner.id).auth_version;
  const authorization = `Bearer ${signToken({ id: owner.id, auth_version: authVersion })}`;
  try {
    const listing = await fetch(trialUrl); assert.equal(listing.status, 200);
    const employees = (await listing.json()).employees;
    assert.equal(employees.length, 5);
    assert.deepEqual(employees.map(item => item.id), featuredIds);
    for (const employeeId of ['content-999', 'restaurant-999', 'ghost-1', 'restaurant-140', 'content-3']) {
      const body = { ...input(employeeId), ownerUserId: other.id, leadId: null, provider: 'openlux', role: 'platform_super', scope: 'personal' };
      for (const action of ['chat', 'interest']) {
        const response = await fetch(`${trialUrl}/${action}`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Trial-Token': lead.accessToken, Authorization: authorization }, body: JSON.stringify(body) });
        assert.equal(response.status, 400); assert.equal((await response.json()).code, 'EMPLOYEE_NOT_ALLOWED');
      }
    }
    assert.equal(calls, 0);
    for (const employeeId of ['restaurant-104', 'content-11']) {
      const response = await fetch(`${trialUrl}/chat`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trial-Token': lead.accessToken },
        body: JSON.stringify(input(employeeId)) });
      assert.equal(response.status, 200); const payload = await response.json();
      assert.equal(payload.conversation.ownerUserId, owner.id); assert.equal(payload.conversation.leadId, lead.lead.id);
      assert.equal(payload.conversation.employeeName, TESTER_EMPLOYEES.find(item => item.id === employeeId).name);
    }
    const personal = await fetch(`${base}/api/tester/chat`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify(input('content-0')) });
    assert.equal(personal.status, 200);
    assert.equal(calls, 3);
    assert.equal(api.trialSession(lead.invitation.token, lead.accessToken).lead.usedTurns, 2);
    assert.equal(api.ownConversations(owner).length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

after(() => { db.close(); removeTempDbSafely(databasePath); });
