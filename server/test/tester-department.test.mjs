import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
process.env.NANOWORK_DB = ':memory:';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'department-isolated-test-secret-'.repeat(3);
const { db, q, initSchema, migrateV2 } = await import('../src/db.js');
initSchema(); migrateV2();
const access = await import('../src/engines/tester-access.js');
const api = await import('../src/engines/tester-trials.js');
const { testerAnalytics } = await import('../src/engines/tester-analytics.js');
const { createTesterRouter } = await import('../src/routes/testers.js');
const { signToken } = await import('../src/util.js');
const admin = { id: Number(q.run("INSERT INTO users(username,password_hash,name,role,tenant_id,status) VALUES('dept_super','unused','测试超管','platform_super',1,'启用')").lastInsertRowid) };
let serial = 0;
function application(department) {
  const n = ++serial;
  return { username: `dept_sales_${n}`, name: `测试销售${n}`, phone: `1387000${String(n).padStart(4,'0')}`, password: 'Fake-Dept-123!', consent: true, department };
}
function tester(department, approve = true) {
  const input = application(department); api.applyTester(input);
  const actor = q.get('SELECT id FROM users WHERE username=?', input.username);
  if (approve) { api.updateTesterStatus(admin, actor.id, 'approved'); api.setTesterKey(actor, 'fk-fake-department-private-key'); }
  return actor;
}
function customer(owner, use = false) {
  const invitation = api.createTesterInvitation(owner, {turnLimit: 5}, 'https://example.test');
  const n = ++serial;
  const result = api.applyTrial(invitation.token, { name: `测试客户${n}`, phone: `1397000${String(n).padStart(4,'0')}`, consent: true });
  api.updateLeadStatus(owner, result.lead.id, 'approved');
  if (use) q.run('UPDATE tester_leads SET used_turns=1 WHERE id=?',result.lead.id);
  return { ...result, invitation };
}
function call(owner, lead, {cost = 0.1, status = 'succeeded', model = 'dept-test-model', employee = 'content-11'} = {}) {
  const requestId = `dept-call-${++serial}`, at = new Date().toISOString();
  const receipts = cost === null ? [] : [{status:'known', costYuanOverride:cost, costSource:{type:'provider_receipt',provider:'360',basis:'upstream_debit',currency:'CNY',amount:cost,exchangeRate:1,requestId}}];
  q.run(`INSERT INTO tester_conversations(owner_user_id,lead_id,request_id,employee_id,input,output,status,model,supplier_costs_json,supplier_cost_cny,cost_status,created_at,completed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, owner.id, lead?.lead.id ?? null,requestId,employee,'隔离测试输入',status === 'succeeded'?'测试正文':'',status,model,JSON.stringify(receipts),cost,cost===null?'unverified':'verified',at,at);
}

test('旧表自动补部门列，原申请与密钥不丢失，重复初始化可用', () => {
  // Recreate the immediately preceding schema, before the module initializes.
  q.run(`CREATE TABLE tester_accounts(user_id INTEGER PRIMARY KEY, phone TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',api_key_cipher TEXT,
    key_updated_at TEXT,reviewed_by INTEGER,reviewed_at TEXT,consent_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))`);
  q.run("INSERT INTO tester_accounts(user_id,phone,consent_at,api_key_cipher) VALUES(?,'13879999999','2026-09-01','retained-cipher')",admin.id);
  access.ensureTesterSchema(); access.ensureTesterSchema();
  const row = q.get('SELECT * FROM tester_accounts WHERE user_id=?', admin.id);
  assert.equal(row.department,''); assert.equal(q.get('SELECT api_key_cipher FROM tester_provider_keys WHERE owner_user_id=?',admin.id).api_key_cipher,'retained-cipher');
  q.run('DELETE FROM tester_accounts WHERE user_id=?',admin.id);
});

test('申请保存规范部门名称；旧客户端省略字段归未分类；非法输入不创建账号', () => {
  const owner = tester('  成都   销售一部  ');
  assert.equal(api.testerMe(owner).department,'成都 销售一部');
  const legacy = tester(); assert.equal(api.testerMe(legacy).department,'');
  for (const department of [null,123,{},['部门'],'部'.repeat(41),'部\0门']) {
    const input = application(department);
    assert.throws(() => api.applyTester(input),error => error.status === 400);
    assert.equal(q.get('SELECT id FROM users WHERE username=?',input.username),undefined);
  }
});

test('仅真实Super可调整部门，保存审计且不改变权限、密钥、租户和客户次数', () => {
  const owner = tester('原部门'), other = tester('其他部门'), lead = customer(owner,true);
  const userBefore = q.get('SELECT * FROM users WHERE id=?',owner.id);
  const accountBefore = q.get('SELECT * FROM tester_accounts WHERE user_id=?',owner.id);
  const customerBefore = q.get('SELECT * FROM tester_leads WHERE id=?',lead.lead.id);
  for (const actor of [owner,{...other,role:'platform_super'}])
    assert.throws(() => api.updateTesterDepartment(actor,owner.id,'越权部门'),error => error.status === 403);
  const updated = api.updateTesterDepartment(admin,owner.id,'  新部门 ');
  assert.equal(updated.tester.department,'新部门');
  assert.deepEqual(q.get('SELECT * FROM users WHERE id=?',owner.id),userBefore);
  assert.deepEqual(q.get('SELECT * FROM tester_leads WHERE id=?',lead.lead.id),customerBefore);
  const accountAfter = q.get('SELECT * FROM tester_accounts WHERE user_id=?',owner.id);
  assert.deepEqual({...accountAfter,department:accountBefore.department},{...accountBefore});
  assert.ok(q.get("SELECT id FROM tester_audit WHERE action LIKE '%department_changed%'"));
  assert.throws(() => api.updateTesterDepartment(admin,owner.id),error => error.status === 400);
  assert.equal(api.updateTesterDepartment(admin,owner.id,'').tester.department,'');
});

test('部门效果与明细同源；部门和销售交叉筛选、已用未用、失败与待核成本正确', () => {
  const a=tester('效果A'),a2=tester('效果A',false),b=tester('效果B'),empty=tester('效果空');
  const la=customer(a,true); customer(a,false); const lb=customer(b,true);
  call(a,la,{cost:0.12}); call(a,la,{cost:null,status:'failed'}); call(a,null,{cost:8});
  call(b,lb,{cost:0.32,model:'other-dept-model',employee:'restaurant-104'});
  api.recordTrialInterest(la.invitation.token,la.accessToken,{employeeId:'content-11'});
  api.recordTrialInterest(lb.invitation.token,lb.accessToken,{employeeId:'restaurant-104'});
  let report=testerAnalytics(admin,{days:'all',department:'效果A'},true);
  assert.equal(report.departments.length,1); const row=report.departments[0];
  assert.equal(row.testerCount,2); assert.equal(row.approvedTesters,1);
  assert.equal(row.totalCustomers,2); assert.equal(row.usedCustomers,1); assert.equal(row.unusedCustomers,1);
  assert.equal(row.successfulConversations,1); assert.equal(row.totalCalls,2); assert.equal(row.failedCalls,1);
  assert.equal(row.knownCostCny,0.12); assert.equal(row.unverifiedCostCount,1);
  assert.equal(report.summary.knownCostCny,row.knownCostCny); assert.equal(report.personalSummary.knownCostCny,8);
  assert.deepEqual(report.models.map(x=>x.model),['dept-test-model']);
  assert.deepEqual(report.interests.map(x=>x.employeeId),['content-11']);
  const mismatch=testerAnalytics(admin,{days:'all',department:'效果A',ownerUserId:b.id},true);
  assert.equal(mismatch.summary.totalCustomers,0); assert.equal(mismatch.summary.totalCalls,0); assert.equal(mismatch.personalSummary.totalCalls,0);
  assert.equal(mismatch.departments.length,0);
  assert.equal(testerAnalytics(admin,{days:'all',department:'效果空'},true).departments[0].totalCalls,0);
  assert.equal(testerAnalytics(admin,{department:"' OR 1=1 --"},true).summary.totalCustomers,0);
  api.updateTesterDepartment(admin,a.id,'效果B');
  assert.equal(testerAnalytics(admin,{days:'all',department:'效果A'},true).summary.totalCustomers,0);
  report=testerAnalytics(admin,{days:'all',department:'效果B'},true);
  assert.equal(report.summary.totalCustomers,3); assert.equal(report.summary.knownCostCny,0.44);
  const unclassified=tester(); customer(unclassified);
  assert.ok(testerAnalytics(admin,{days:'all',department:''},true).departments.every(x=>x.department===''));
  const own=testerAnalytics(a,{days:'all'}); assert.equal(own.summary.totalCustomers,2); assert.equal(own.departments,undefined);
  assert.throws(()=>testerAnalytics(a,{department:'效果B'}),error=>error.status===403);
});

test('HTTP部门申请、审核修改、看板筛选和拒绝越权',async()=>{
  const owner=tester('HTTP部门'); const app=express();app.use(express.json()); app.use('/api/tester',createTesterRouter());
  const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/tester`;
  const headers=actor=>({'Content-Type':'application/json',Authorization:`Bearer ${signToken({id:actor.id,auth_version:q.get('SELECT auth_version FROM users WHERE id=?',actor.id).auth_version})}`});
  try {
    const path=`${base}/admin/applications/${owner.id}/department`;
    assert.equal((await fetch(path,{method:'PATCH',headers:headers(owner),body:JSON.stringify({department:'跨权'})})).status,403);
    const response=await fetch(path,{method:'PATCH',headers:headers(admin),body:JSON.stringify({department:'HTTP更新'})});
    assert.equal(response.status,200);assert.equal((await response.json()).tester.department,'HTTP更新');
    const report=await fetch(`${base}/admin/analytics?days=all&department=${encodeURIComponent('HTTP更新')}`,{headers:headers(admin)});
    assert.equal(report.status,200);assert.equal((await report.json()).departments[0].testerCount,1);
    assert.equal((await fetch(`${base}/admin/analytics?department=a&department=b`,{headers:headers(admin)})).status,400);
    assert.equal((await fetch(`${base}/analytics?department=`,{headers:headers(owner)})).status,403);
    const input=application('HTTP申请');
    const applied=await fetch(`${base}/apply`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    assert.equal(applied.status,201);
    assert.equal(q.get('SELECT a.department FROM tester_accounts a JOIN users u ON u.id=a.user_id WHERE u.username=?',input.username).department,'HTTP申请');
  } finally {await new Promise(resolve=>server.close(resolve));}
});
after(()=>db.close());
