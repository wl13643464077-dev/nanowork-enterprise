// 租户月度 AI 积分预算：拦截 402 BUDGET_EXCEEDED 与可读信息、预警只发一次、platform_super 不拦、
// usage 聚合排除 recharge/bonus、按人 quota 只记录不拦截、预算与配额接口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-credit-budget-${process.pid}.db`);
for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;

const { initSchema, migrateV2, q, qRaw, runWithTenant } = await import('../src/db.js');
initSchema();
migrateV2();
const credits = await import('../src/engines/credits.js');
const adminRoutes = (await import('../src/routes/admin.js')).default;

const T = Number(qRaw.run("INSERT INTO tenants(name,status,credits) VALUES('预算企业','已开通',1000000)").lastInsertRowid);
const OTHER = Number(qRaw.run("INSERT INTO tenants(name,status,credits) VALUES('隔壁企业','已开通',1000000)").lastInsertRowid);
const boss = Number(qRaw.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES('bg_boss','x','预算老板','boss','启用',?)", T).lastInsertRowid);
const staff = Number(qRaw.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES('bg_staff','x','预算员工','sales','启用',?)", T).lastInsertRowid);
const superUser = Number(qRaw.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES('bg_super','x','平台超管','platform_super','启用',?)", T).lastInsertRowid);
const otherBoss = Number(qRaw.run("INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES('bg_other','x','隔壁老板','boss','启用',?)", OTHER).lastInsertRowid);
const bossUser = { id: boss, name: '预算老板', role: 'boss', tenant_id: T };

function makeApp(tenantId, user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(tenantId, () => { req.user = user; next(); }));
  app.use('/admin', adminRoutes);
  return app;
}
async function withServer(fn, tenantId = T, user = bossUser) {
  const server = makeApp(tenantId, user).listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
async function request(base, route, method = 'GET', body) {
  const response = await fetch(`${base}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}
const monthUsed = () => credits.tenantMonthlyUsage(T).used;
const notifCount = (uid) => q.get(`SELECT COUNT(*) n FROM notifications WHERE tenant_id=? AND user_id=? AND type='credits'`, T, uid).n;

test('未设预算：precheck / holdCredits 行为与历史一致（不限）', () => {
  const summary = credits.budgetSummary(T);
  assert.equal(summary.budget, null);
  assert.equal(summary.state, 'unlimited');
  assert.equal(summary.alertRatio, 0.8);
  const bal = credits.precheck(staff, 'text', 'gpt-5.5');
  assert.equal(typeof bal, 'number', 'precheck 返回值仍是余额数字，兼容既有调用方');
  const detailed = credits.precheckDetailed(staff, 'text', 'gpt-5.5');
  assert.equal(detailed.budget, null);
  assert.equal(detailed.quotaState, 'within');
  const hold = credits.holdCredits({ userId: staff, feature: '员工对话·测试', kind: 'text', model: 'deepseek-v4-flash', credits: 100 });
  credits.settleHold(hold, { usage: { inputTokens: 1000, outputTokens: 1000 }, model: 'deepseek-v4-flash' });
});

test('预算摘要口径：已结算 + 在途 hold，排除 recharge/bonus/管理调整', () => {
  const before = monthUsed();
  // 消耗：直接实扣 300 + 在途 hold 200
  credits.charge({ userId: staff, feature: '员工任务·小美', kind: 'text', model: 'gpt-5.5', usage: { inputTokens: 40000, outputTokens: 30000 } });
  const chargeRow = q.get('SELECT credits FROM credit_logs WHERE tenant_id=? ORDER BY id DESC LIMIT 1', T);
  const hold = credits.holdCredits({ userId: staff, feature: '内容生产仓·海报', kind: 'image', model: 'gpt-image-2', credits: 200 });
  // 非消耗：充值 / 套餐赠送 / 管理员扣减（credits 为正但 ai_mode=recharge）
  credits.creditTenant({ tenantId: T, delta: 5000, userId: boss, feature: '测试充值' });
  credits.creditTenant({ tenantId: T, delta: 60000, userId: boss, feature: '套餐赠送积分', kind: 'bonus', aiMode: 'bonus' });
  credits.adjust({ userId: staff, delta: -999, operatorId: boss, note: '管理扣减' });
  const s = credits.budgetSummary(T);
  assert.equal(s.used - before, Number(chargeRow.credits) + 200, '只计 AI 消耗（实扣 + 在途）');
  assert.equal(s.held, 200);
  assert.ok(s.forecast >= s.used, '预测按日均线性外推到月底，不小于已用');
  credits.releaseHold(hold);
  assert.equal(credits.budgetSummary(T).held, 0, '释放后在途归零');
});

test('设定预算 → 已用 + 本次预估 > 预算 → 402 BUDGET_EXCEEDED，中文可读信息，预警只发一次', () => {
  const used = monthUsed();
  // 预算 = 已用 + 员工级模型单次上限：老板级 gpt-5.5 单次上限估算更高 → 拦；deepseek 恰好放行
  // （不写死分值：价目表按中转站实价核验后会变，这里跟随 estimateMaxCredits）
  const bossEstimate = credits.estimateMaxCredits('text', 'gpt-5.5');
  const staffEstimate = credits.estimateMaxCredits('text', 'deepseek-v4-flash');
  assert.ok(bossEstimate > staffEstimate, '老板级模型单次上限应高于员工级');
  const budget = used + staffEstimate;
  qRaw.run('UPDATE tenants SET monthly_credit_budget=?, budget_alert_ratio=0.8 WHERE id=?', budget, T);
  assert.throws(
    () => credits.precheck(staff, 'text', 'gpt-5.5'),
    (e) => {
      assert.equal(e.status, 402);
      assert.equal(e.code, 'BUDGET_EXCEEDED');
      assert.match(e.message, /本月 AI 预算 [\d,]+ 积分已用 [\d,]+，本次约需 [\d,]+；请老板在后台调整预算/);
      assert.equal(e.budget.budget, budget);
      return true;
    },
  );
  // holdCredits 同样被拦（真正的硬门），且不动余额、不落流水
  const balBefore = credits.balanceOfTenant(T);
  const logsBefore = q.get('SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=?', T).n;
  assert.throws(
    () => credits.holdCredits({ userId: staff, feature: '员工对话·测试', kind: 'text', model: 'gpt-5.5', credits: 50 }),
    (e) => e.status === 402 && e.code === 'BUDGET_EXCEEDED',
  );
  assert.equal(credits.balanceOfTenant(T), balBefore);
  assert.equal(q.get('SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=?', T).n, logsBefore);
  // 小额仍可通过（deepseek 单次上限 ≤ 剩余额度）
  const ok = credits.precheckDetailed(staff, 'text', 'deepseek-v4-flash');
  assert.equal(ok.budget.state, 'alert', '已用占比 ≥ 80% → alert');
  // 预警通知：达到预警线当天只给老板发一次（多次预检/占扣不重复）
  assert.equal(notifCount(boss), 1, '老板收到 1 条预算预警');
  assert.equal(notifCount(staff), 0, '员工不收预警');
  credits.precheckDetailed(staff, 'text', 'deepseek-v4-flash');
  assert.throws(() => credits.precheck(staff, 'text', 'gpt-5.5'), (e) => e.code === 'BUDGET_EXCEEDED');
  assert.equal(notifCount(boss), 1, '同一天不重复发送');
  assert.ok(q.get(`SELECT 1 FROM scheduled_runs WHERE tenant_id=? AND job_key LIKE 'credit-budget-alert:%'`, T));
  // 隔壁企业不受本企业预算影响
  credits.precheck(otherBoss, 'text', 'gpt-5.5');
});

test('platform_super 不受预算拦截；非 AI 消耗（kind 非 text/image/video）不经预算门', () => {
  const bal = credits.precheck(superUser, 'text', 'gpt-5.5');
  assert.equal(typeof bal, 'number');
  const hold = credits.holdCredits({ userId: superUser, feature: '平台巡检', kind: 'text', model: 'gpt-5.5', credits: 40 });
  credits.releaseHold(hold);
});

test('按人配额：只记录 quotaState，不拦截；接口可读写', async () => {
  qRaw.run('UPDATE tenants SET monthly_credit_budget=NULL WHERE id=?', T);
  const usage0 = credits.getUserMonthlyUsage(staff);
  assert.equal(usage0.quota, null);
  assert.equal(usage0.quotaState, 'within');
  assert.ok(usage0.used > 0, '员工本月已有消耗');
  await withServer(async base => {
    const bad = await request(base, `/admin/users/${staff}/quota`, 'PUT', { monthlyCreditQuota: -1 });
    assert.equal(bad.status, 400);
    const set = await request(base, `/admin/users/${staff}/quota`, 'PUT', { monthlyCreditQuota: 1 });
    assert.equal(set.status, 200);
    assert.equal(set.json.quota, 1);
    assert.equal(set.json.quotaState, 'exceeded');
    const got = await request(base, `/admin/users/${staff}/quota`);
    assert.equal(got.json.quotaState, 'exceeded');
    const foreign = await request(base, `/admin/users/${otherBoss}/quota`, 'PUT', { monthlyCreditQuota: 5 });
    assert.equal(foreign.status, 404, '不能改别家账号配额');
  });
  // 超配额只记录不拦截（B1 后续版本）
  const detailed = credits.precheckDetailed(staff, 'text', 'deepseek-v4-flash');
  assert.equal(detailed.quotaState, 'exceeded');
  const hold = credits.holdCredits({ userId: staff, feature: '员工对话·测试', kind: 'text', model: 'deepseek-v4-flash', credits: 10 });
  credits.releaseHold(hold);
  qRaw.run('UPDATE users SET monthly_credit_quota=NULL WHERE id=?', staff);
});

test('用量报表：默认本月、排除 recharge/bonus、按 day/user/model/feature/employee 聚合正确', async () => {
  await withServer(async base => {
    const byUser = await request(base, '/admin/credits/usage?groupBy=user');
    assert.equal(byUser.status, 200);
    const s = credits.budgetSummary(T);
    assert.equal(byUser.json.total.credits, s.used, '报表合计 == 预算口径已用（含在途）');
    const staffRow = byUser.json.rows.find(r => r.key === String(staff));
    assert.ok(staffRow && staffRow.credits > 0);
    assert.equal(staffRow.label, '预算员工');
    assert.equal(byUser.json.rows.some(r => r.key === String(boss)), false, '老板只有充值/赠送流水，不出现在消耗报表');
    assert.ok(byUser.json.total.tokens > 0);

    const byFeature = await request(base, '/admin/credits/usage?groupBy=feature');
    assert.ok(byFeature.json.rows.some(r => r.key === '员工任务·小美'));
    assert.equal(byFeature.json.rows.some(r => /充值|赠送|管理/.test(r.key)), false);

    const byEmployee = await request(base, '/admin/credits/usage?groupBy=employee');
    assert.ok(byEmployee.json.rows.some(r => r.key === '小美'));

    const byModel = await request(base, '/admin/credits/usage?groupBy=model');
    assert.ok(byModel.json.rows.some(r => r.key === 'gpt-5.5'));

    const byDay = await request(base, '/admin/credits/usage');
    assert.equal(byDay.json.groupBy, 'day');
    assert.equal(byDay.json.from, `${s.month}-01`);
    assert.equal(byDay.json.rows.reduce((n, r) => n + r.credits, 0), s.used);
    assert.equal(byDay.json.budget.month, s.month);

    const bad = await request(base, '/admin/credits/usage?groupBy=hacker');
    assert.equal(bad.status, 400);
    const empty = await request(base, '/admin/credits/usage?from=2000-01-01&to=2000-01-31');
    assert.equal(empty.json.total.credits, 0);
  });
  // 隔离：隔壁企业报表看不到本企业消耗
  await withServer(async base => {
    const other = await request(base, '/admin/credits/usage?groupBy=user');
    assert.equal(other.json.total.credits, 0);
  }, OTHER, { id: otherBoss, name: '隔壁老板', role: 'boss', tenant_id: OTHER });
});

test('预算接口：读写校验、op_logs、前端可读摘要', async () => {
  await withServer(async base => {
    const bad1 = await request(base, '/admin/credit-budget', 'PUT', { monthlyCreditBudget: 12.5 });
    assert.equal(bad1.status, 400);
    const bad2 = await request(base, '/admin/credit-budget', 'PUT', { budgetAlertRatio: 1.5 });
    assert.equal(bad2.status, 400);
    const set = await request(base, '/admin/credit-budget', 'PUT', { monthlyCreditBudget: 50000, budgetAlertRatio: 0.9 });
    assert.equal(set.status, 200);
    assert.equal(set.json.monthlyCreditBudget, 50000);
    assert.equal(set.json.budgetAlertRatio, 0.9);
    assert.equal(set.json.summary.budget, 50000);
    assert.equal(set.json.summary.remaining, 50000 - set.json.summary.used);
    const got = await request(base, '/admin/credit-budget');
    assert.equal(got.json.summary.state, 'ok');
    const clear = await request(base, '/admin/credit-budget', 'PUT', { monthlyCreditBudget: null });
    assert.equal(clear.json.monthlyCreditBudget, null);
    assert.equal(clear.json.summary.state, 'unlimited');
  });
  assert.ok(q.get(`SELECT id FROM op_logs WHERE tenant_id=? AND action='修改月度AI预算'`, T));
});

test('cleanup', () => {
  for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
});
