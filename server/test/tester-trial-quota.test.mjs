import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const databasePath = path.join(os.tmpdir(), `tester-trial-quota-${process.pid}.db`);
process.env.NANOWORK_DB = databasePath;
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.ENABLE_SCHEDULER = 'false';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'tester-quota-only-fake-test-secret-'.repeat(3);
const { db, q, initSchema, migrateV2 } = await import('../src/db.js');
initSchema(); migrateV2();
const api = await import('../src/engines/tester-trials.js');
const { testerAnalytics } = await import('../src/engines/tester-analytics.js');
const { createTesterRouter, createPublicTrialRouter } = await import('../src/routes/testers.js');
const { signToken } = await import('../src/util.js');
const admin = { id: Number(q.run("INSERT INTO users(username,password_hash,name,role,tenant_id,status) VALUES('quota_super','unused','超管','platform_super',1,'启用')").lastInsertRowid) };
let sequence = 0;
const employeeIds = ['restaurant-104', 'restaurant-160', 'restaurant-161', 'content-11', 'content-10'];
function tester() {
  const n = ++sequence; const username = `quota_sales_${n}`;
  api.applyTester({ username, name: `销售${n}`, phone: `1383000${String(n).padStart(4, '0')}`, password: 'Fake-Tester-Pass-123', consent: true });
  const owner = q.get('SELECT id FROM users WHERE username=?', username);
  api.updateTesterStatus(admin, owner.id, 'approved'); api.setTesterKey(owner, `fk-only-fake-quota-key-${n}`, '360');
  return owner;
}
const application = () => ({ name: '体验客户', phone: `1393000${String(++sequence).padStart(4, '0')}`, consent: true });
function customer(owner, turnLimit, extra = {}) {
  const invitation = api.createTesterInvitation(owner, turnLimit === undefined ? {} : { turnLimit }, 'https://example.test');
  const input = { ...application(), ...extra }; const result = api.applyTrial(invitation.token, input);
  api.updateLeadStatus(owner, result.lead.id, 'approved');
  return { ...result, invitation, phone: input.phone };
}
const input = (employeeId = 'content-11', requestId = `quota-request-${++sequence}`) => ({ employeeId, requestId, message: '请根据我提供的门店资料列出下一步行动。' });
function result(text = '先整理已提供的资料，再补充缺失信息。') {
  return { text, model: 'deepseek/deepseek-v4-flash', supplierCosts: [{ status: 'known', costYuanOverride: 0.03,
    costSource: { type: 'provider_receipt', provider: '360', basis: 'upstream_debit', currency: 'CNY', amount: 0.03, exchangeRate: 1, requestId: `quota-receipt-${++sequence}` } }] };
}
const chat = (lead, data = input(), chatFn = async () => result()) => api.trialChat(lead.invitation.token, lead.accessToken, data, { chatFn });
const current = lead => api.trialSession(lead.invitation.token, lead.accessToken).lead;

test('创建体验码严格校验1至100 JSON整数，缺省2；无效值不产生邀请', () => {
  const owner = tester();
  for (const value of [null, true, false, 0, -1, 101, 2.5, NaN, Infinity, '', '2', '2.5', 'bad', [], {}, [5]]) {
    assert.throws(() => api.createTesterInvitation(owner, { turnLimit: value }, 'https://example.test'), error => error.code === 'TRIAL_TURN_LIMIT_INVALID', String(value));
  }
  assert.equal(api.listTesterInvitations(owner, 'https://example.test').length, 0);
  const defaultInvitation = api.createTesterInvitation(owner, {}, 'https://example.test');
  assert.equal(defaultInvitation.turnLimit, 2); assert.equal(api.publicTrial(defaultInvitation.token).turnLimit, 2);
  for (const limit of [1, 5, 100]) {
    const invitation = api.createTesterInvitation(owner, { turnLimit: limit }, 'https://example.test');
    assert.equal(invitation.turnLimit, limit); assert.equal(api.publicTrial(invitation.token).turnLimit, limit);
    assert.equal(q.get('SELECT turn_limit FROM tester_invitations WHERE id=?', invitation.id).turn_limit, limit);
  }
  assert.ok(!api.TRIAL_DISCLOSURE.includes('两轮'));
});

test('每位客户从邀请快照额度，伪造申请/对话次数无效，换码不能重申，暂停恢复不重置', async () => {
  const owner = tester(); const lead = customer(owner, 1, { turnLimit: 100, usedTurns: -99, remainingTurns: 100 });
  assert.equal(lead.lead.turnLimit, 1); assert.equal(lead.lead.remainingTurns, 1);
  // A future invitation-management change must not retroactively alter a lead.
  q.run('UPDATE tester_invitations SET turn_limit=5 WHERE id=?', lead.invitation.id);
  const response = await chat(lead, { ...input(), turnLimit: 100, usedTurns: 0 });
  assert.equal(response.lead.turnLimit, 1); assert.equal(response.lead.usedTurns, 1); assert.equal(response.lead.remainingTurns, 0);
  api.updateLeadStatus(owner, lead.lead.id, 'paused'); api.updateLeadStatus(owner, lead.lead.id, 'approved');
  api.updateTesterStatus(admin, owner.id, 'paused'); api.updateTesterStatus(admin, owner.id, 'approved');
  assert.equal(current(lead).remainingTurns, 0);
  const another = api.createTesterInvitation(owner, { turnLimit: 100 }, 'https://example.test');
  assert.throws(() => api.applyTrial(another.token, { ...application(), phone: lead.phone }), error => error.code === 'TRIAL_ALREADY_APPLIED');
  await assert.rejects(() => chat(lead), error => error.code === 'TRIAL_TURNS_EXHAUSTED');
  assert.equal(api.listTesterLeads(owner)[0].turnLimit, 1);
  assert.equal(api.testerLeadDetail(admin, lead.lead.id, true).lead.turnLimit, 1);
});

test('五位数字员工共享5次成功额度；每个客户独立额度，成功重放不重扣', async () => {
  const owner = tester(); const lead = customer(owner, 5); let calls = 0;
  const chatFn = async () => { calls++; return result(); }; let first;
  for (let i = 0; i < 5; i++) {
    const data = input(employeeIds[i]); if (!first) first = data;
    const response = await chat(lead, data, chatFn);
    assert.equal(response.lead.usedTurns, i + 1); assert.equal(response.lead.remainingTurns, 4 - i);
  }
  const replay = await chat(lead, first, chatFn);
  assert.equal(replay.lead.usedTurns, 5); assert.equal(calls, 5);
  await assert.rejects(() => chat(lead, input(), chatFn), error => error.code === 'TRIAL_TURNS_EXHAUSTED');
  assert.equal(calls, 5);
  const second = api.applyTrial(lead.invitation.token, application()); api.updateLeadStatus(owner, second.lead.id, 'approved');
  assert.equal(second.lead.turnLimit, 5); assert.equal(second.lead.usedTurns, 0);
  assert.equal((await chat({ ...second, invitation: lead.invitation })).lead.remainingTurns, 4);
});

test('最后一次额度只允许一个在途请求；并发请求不能超用，幂等成功重放不再调用', async () => {
  const owner = tester(); const lead = customer(owner, 5);
  for (let i = 0; i < 4; i++) await chat(lead);
  let release; let calls = 0;
  const deferred = new Promise(resolve => { release = resolve; });
  const data = input(); const pending = chat(lead, data, async () => { calls++; return deferred; });
  await assert.rejects(() => chat(lead, input(), async () => { assert.fail('quota must stop the second provider call'); }), error => error.code === 'TRIAL_TURNS_EXHAUSTED');
  assert.equal(current(lead).usedTurns, 4); assert.equal(calls, 1);
  release(result()); assert.equal((await pending).lead.usedTurns, 5);
  await chat(lead, data, async () => assert.fail('successful replay must not call the provider'));
  assert.equal(current(lead).usedTurns, 5);
});

test('空正文及供应商失败不计次，重试成功只计一次，已扣上游费用仍保留', async () => {
  const owner = tester(); const lead = customer(owner, 1); const data = input();
  await assert.rejects(() => chat(lead, data, async () => result('')), error => error.code === 'EMPTY_OUTPUT');
  assert.equal(current(lead).remainingTurns, 1);
  await assert.rejects(() => chat(lead, data, async () => { throw Object.assign(new Error('fake provider failure'), { supplierCosts: result().supplierCosts }); }));
  assert.equal(current(lead).usedTurns, 0);
  const response = await chat(lead, data); assert.equal(response.lead.usedTurns, 1);
  assert.equal(response.conversation.callAttempts.length, 3); assert.equal(response.conversation.supplierCostCny, 0.09);
  const report = testerAnalytics(owner, { days: 'all' });
  assert.equal(report.summary.failedCalls, 2); assert.equal(report.summary.successfulCalls, 1); assert.equal(report.summary.knownCostCny, 0.09);
});

test('按各自额度判定用尽，默认旧客户仍2次，v2/v3授权仍可记录五岗兴趣', async () => {
  const owner = tester(); const one = customer(owner, 1); const five = customer(owner, 5); const two = customer(owner);
  await chat(one); await chat(five); await chat(five); await chat(two); await chat(two);
  let report = testerAnalytics(owner, { days: 'all' });
  assert.equal(report.summary.exhaustedCustomers, 2); assert.equal(current(five).remainingTurns, 3);
  for (let i = 0; i < 3; i++) await chat(five);
  report = testerAnalytics(owner, { days: 'all' }); assert.equal(report.summary.exhaustedCustomers, 3);
  for (const version of ['2026-09-tester-v2', '2026-09-tester-v3']) {
    q.run('UPDATE tester_leads SET consent_version=? WHERE id=?', version, five.lead.id);
    assert.equal(api.recordTrialInterest(five.invitation.token, five.accessToken, { employeeId: 'content-11' }).ok, true);
  }
});

test('真实HTTP创建返回额度与二维码，公开页面/申请/会话同额度，非法值400且客户端不能改限额', async () => {
  const owner = tester(); const app = express(); app.use(express.json());
  app.use('/api/tester', createTesterRouter({ chatFn: async () => result() }));
  app.use('/api/trial', createPublicTrialRouter({ chatFn: async () => result() }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const user = q.get('SELECT * FROM users WHERE id=?', owner.id);
  const headers = { Authorization: `Bearer ${signToken({ id: owner.id, auth_version: user.auth_version })}`, 'Content-Type': 'application/json' };
  try {
    for (const turnLimit of [null, true, '5', 5.5, 0, 101]) {
      const response = await fetch(`${base}/api/tester/invitations`, { method: 'POST', headers, body: JSON.stringify({ turnLimit }) });
      assert.equal(response.status, 400); assert.equal((await response.json()).code, 'TRIAL_TURN_LIMIT_INVALID');
    }
    const response = await fetch(`${base}/api/tester/invitations`, { method: 'POST', headers, body: JSON.stringify({ turnLimit: 5 }) });
    assert.equal(response.status, 201); const invitation = await response.json();
    assert.equal(invitation.turnLimit, 5); assert.ok(invitation.qrDataUrl.startsWith('data:image/png;base64,'));
    assert.equal((await (await fetch(`${base}/api/trial/${invitation.token}`)).json()).turnLimit, 5);
    const applied = await fetch(`${base}/api/trial/${invitation.token}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...application(), turnLimit: 100 }) });
    assert.equal(applied.status, 201); const customer = await applied.json();
    assert.equal(customer.lead.turnLimit, 5); assert.equal(customer.lead.remainingTurns, 5);
    const session = await (await fetch(`${base}/api/trial/${invitation.token}/session`, { headers: { 'X-Trial-Token': customer.accessToken } })).json();
    assert.equal(session.lead.turnLimit, 5);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

// Separate process gives each migration test a genuinely old database and a
// fresh ensureTesterSchema guard, independent from the functional test data.
const legacyFixture = `
  import assert from 'node:assert/strict';
  const { db } = await import('./server/src/db.js');
  db.exec(\`CREATE TABLE tester_invitations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL,
    token_hash TEXT UNIQUE NOT NULL, token_cipher TEXT NOT NULL,
    title TEXT NOT NULL, sales_phone TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT '2026-09-01');
  CREATE TABLE tester_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL, invitation_id INTEGER NOT NULL,
    phone TEXT UNIQUE NOT NULL, name TEXT NOT NULL, store_name TEXT NOT NULL DEFAULT '',
    access_hash TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'approved',
    used_turns INTEGER NOT NULL DEFAULT 0 CHECK(used_turns BETWEEN 0 AND 2),
    consent_at TEXT NOT NULL, consent_version TEXT NOT NULL,
    reviewed_by INTEGER, reviewed_at TEXT, last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT '2026-09-01', retained_custom_note TEXT);
  CREATE TABLE tester_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL,
    lead_id INTEGER REFERENCES tester_leads(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, employee_id TEXT NOT NULL, input TEXT NOT NULL,
    output TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'succeeded',
    model TEXT, usage_json TEXT NOT NULL DEFAULT '{}', supplier_costs_json TEXT NOT NULL DEFAULT '[]',
    supplier_cost_cny REAL, cost_status TEXT NOT NULL DEFAULT 'unverified', error_code TEXT,
    attempts INTEGER NOT NULL DEFAULT 1, lease_expires INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT '2026-09-01', completed_at TEXT);
  CREATE TABLE tester_interests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL,
    lead_id INTEGER NOT NULL REFERENCES tester_leads(id) ON DELETE CASCADE,
    employee_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(lead_id,employee_id));
  CREATE TABLE quota_trigger_audit (lead_id INTEGER);
  CREATE INDEX retained_quota_index ON tester_leads(retained_custom_note);
  CREATE TRIGGER retained_quota_trigger AFTER UPDATE ON tester_leads BEGIN
    INSERT INTO quota_trigger_audit(lead_id) VALUES(NEW.id); END;
  INSERT INTO tester_invitations(id,owner_user_id,token_hash,token_cipher,title,sales_phone)
    VALUES(11,77,'fake-token-hash','fake-cipher','旧邀请','13930000000');
  INSERT INTO tester_leads(id,owner_user_id,invitation_id,phone,name,access_hash,used_turns,consent_at,consent_version,retained_custom_note)
    VALUES(7,77,11,'13930000001','旧客户','fake-access-hash',2,'2026-09-01','2026-09-tester-v3','保留字段');
  INSERT INTO tester_conversations(id,owner_user_id,lead_id,request_id,employee_id,input,output,supplier_cost_cny)
    VALUES(21,77,7,'old-successful-request','content-11','旧输入','旧输出',0.13);
  INSERT INTO tester_interests(owner_user_id,lead_id,employee_id,created_at) VALUES(77,7,'content-11','2026-09-01');
  UPDATE sqlite_sequence SET seq=99 WHERE name='tester_leads';
  PRAGMA foreign_keys=ON;\`);
  const before = db.prepare('SELECT * FROM tester_leads').get();
  const access = await import('./server/src/engines/tester-access.js');
`;
async function runMigrationTest(script, suffix) {
  const testPath = path.join(os.tmpdir(), `tester-quota-${suffix}-${process.pid}.db`);
  try {
    execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', legacyFixture + script], {
      cwd: path.resolve(import.meta.dirname, '../..'), env: { ...process.env, NANOWORK_DB: testPath }, encoding: 'utf8', stdio: 'pipe',
    });
  } finally { await removeTempDbSafely(testPath, { closeDb: false }); }
}

test('旧schema迁移保留已用2、关联外键历史、触发器/自定义列/索引/自增序号；重复启动幂等', async () => {
  await runMigrationTest(String.raw`
    access.ensureTesterSchema();
    const { turn_limit, ...after } = db.prepare('SELECT * FROM tester_leads').get();
    assert.equal(turn_limit,2); assert.deepEqual(after,{...before});
    assert.equal(db.prepare('SELECT turn_limit FROM tester_invitations').get().turn_limit,2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM tester_conversations').get().n,1);
    assert.equal(db.prepare('SELECT output FROM tester_conversations').get().output,'旧输出');
    assert.equal(db.prepare('SELECT supplier_cost_cny FROM tester_conversations').get().supplier_cost_cny,0.13);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM tester_interests').get().n,1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
    assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='tester_leads'").get().seq,99);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('retained_quota_index','retained_quota_trigger')").get().n,2);
    db.exec('UPDATE tester_leads SET turn_limit=5,used_turns=5 WHERE id=7');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM quota_trigger_audit').get().n,1);
    assert.throws(()=>db.exec('UPDATE tester_leads SET used_turns=6 WHERE id=7'));
    assert.throws(()=>db.exec('UPDATE tester_leads SET turn_limit=0 WHERE id=7'));
    access.ensureTesterSchema();
    (await import('./server/src/engines/tester-access.js?fresh-restart')).ensureTesterSchema();
    assert.equal(db.prepare('SELECT used_turns,turn_limit FROM tester_leads').get().used_turns,5);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM tester_conversations').get().n,1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]); db.close();
  `, 'migration');
});

test('迁移复制失败时回滚所有额度变更，不丢客户/关联历史，不遗留新表且恢复外键设置', async () => {
  await runMigrationTest(String.raw`
    db.exec('PRAGMA ignore_check_constraints=ON; UPDATE tester_leads SET used_turns=3; PRAGMA ignore_check_constraints=OFF;');
    assert.throws(()=>access.ensureTesterSchema(),/CHECK constraint/);
    assert.equal(db.prepare('SELECT used_turns FROM tester_leads').get().used_turns,3);
    for(const table of ['tester_invitations','tester_leads']) assert.ok(!db.prepare('PRAGMA table_info('+table+')').all().some(c=>c.name==='turn_limit'));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='tester_leads_quota_upgrade'").get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM tester_conversations').get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM tester_interests').get().n,1);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    db.exec('UPDATE tester_leads SET used_turns=2');
    access.ensureTesterSchema(); assert.equal(db.prepare('SELECT turn_limit FROM tester_leads').get().turn_limit,2); db.close();
  `, 'rollback');
});

after(() => { db.close(); return removeTempDbSafely(databasePath); });
