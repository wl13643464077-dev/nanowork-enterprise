import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { fileURLToPath } from 'node:url';

const DBP = path.join(os.tmpdir(), `shanmei-execution-permissions-${process.pid}.db`);
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const writtenFiles = [];
for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
const executionRoutes = (await import('../src/routes/execution.js')).default;

initSchema();
migrateV2();

q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`, 'boss', hashPassword('123456'), '老板', 'boss', '决策层');
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`, 'ops', hashPassword('123456'), '运营总监', 'ops_director', '运营中心');
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`, 'sales_a', hashPassword('123456'), '王强', 'sales', '销售部');
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`, 'sales_b', hashPassword('123456'), '李娜', 'sales', '销售部');

const boss = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='boss'`);
const salesA = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='sales_a'`);
const salesB = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='sales_b'`);

function makeApp(user) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => runWithTenant(1, () => { req.user = user; next(); }));
  app.use('/execution', executionRoutes);
  return app;
}

async function withServer(user, fn) {
  const server = makeApp(user).listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function call(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

test('经营执行任务权限：员工只能看和提交自己负责的任务，管理层可审核', async () => {
  let ownTaskId;
  let otherTaskId;

  await withServer(boss, async base => {
    let r = await call(base, '/execution/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: '王强自己的任务', type: '跟进', assignee_id: salesA.id, due_at: '2026-06-21 18:00' }),
    });
    assert.equal(r.status, 200);
    ownTaskId = r.json.id;

    r = await call(base, '/execution/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: '李娜的任务', type: '邀约', assignee_id: salesB.id, due_at: '2026-06-21 18:00' }),
    });
    assert.equal(r.status, 200);
    otherTaskId = r.json.id;
  });

  await withServer(salesA, async base => {
    const list = await call(base, '/execution/tasks');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.map(x => x.id), [ownTaskId]);

    let blocked = await call(base, `/execution/tasks/${otherTaskId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: '进行中' }),
    });
    assert.equal(blocked.status, 403);

    blocked = await call(base, `/execution/tasks/${otherTaskId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ content: '尝试提交别人的任务' }),
    });
    assert.equal(blocked.status, 403);

    const started = await call(base, `/execution/tasks/${ownTaskId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: '进行中' }),
    });
    assert.equal(started.status, 200);

    const edited = await call(base, `/execution/tasks/${ownTaskId}`, {
      method: 'PUT',
      body: JSON.stringify({ title: '王强自己的任务-已补要求', detail: '需要上传邀约名单', type: '邀约', priority: '高' }),
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.json.title, '王强自己的任务-已补要求');
    assert.equal(edited.json.detail, '需要上传邀约名单');

    const submitted = await call(base, `/execution/tasks/${ownTaskId}/submit`, {
      method: 'POST',
      body: JSON.stringify({
        content: '已邀约8人，确认到店5人',
        attachments: [{ name: '邀约名单.csv', b64: Buffer.from('姓名,电话\n张三,13900000000').toString('base64') }],
      }),
    });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.json.attachments.length, 1);
    writtenFiles.push(path.join(SERVER_ROOT, 'data', decodeURIComponent(submitted.json.attachments[0].url)));

    const duplicateSubmit = await call(base, `/execution/tasks/${ownTaskId}/submit`, {
      method: 'POST', body: JSON.stringify({ content: '不应重复提交' }),
    });
    assert.equal(duplicateSubmit.status, 409);

    const subs = await call(base, `/execution/submissions?taskId=${ownTaskId}`);
    assert.equal(subs.status, 200);
    assert.equal(subs.json.length, 1);
    assert.equal(subs.json[0].user_name, '王强');
    const submitBody = JSON.parse(subs.json[0].content);
    assert.equal(submitBody.kind, 'task_submit_v2');
    assert.equal(submitBody.attachments[0].name, '邀约名单.csv');
  });

  await withServer(salesB, async base => {
    const started = await call(base, `/execution/tasks/${otherTaskId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: '进行中' }),
    });
    assert.equal(started.status, 200);
    const submitted = await call(base, `/execution/tasks/${otherTaskId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ content: '李娜已确认3位客户本周到店' }),
    });
    assert.equal(submitted.status, 200);
  });

  await withServer(salesA, async base => {
    const subs = await call(base, '/execution/submissions');
    assert.equal(subs.status, 200);
    assert.ok(subs.json.some(x => x.user_name === '王强'));
    assert.ok(!subs.json.some(x => x.user_name === '李娜'));

    const monthRank = await call(base, '/execution/ranking?period=month');
    assert.equal(monthRank.status, 200);
    assert.ok(monthRank.json.some(x => x.name === '王强'));
    assert.ok(monthRank.json.some(x => x.name === '李娜'));

    const quarterRank = await call(base, '/execution/ranking?period=quarter');
    assert.equal(quarterRank.status, 200);
    assert.ok(quarterRank.json.length >= 2);
  });

  await withServer(boss, async base => {
    const missingDecision = await call(base, `/execution/tasks/${ownTaskId}/review`, {
      method: 'POST', body: JSON.stringify({}),
    });
    assert.equal(missingDecision.status, 400);

    const reviewed = await call(base, `/execution/tasks/${ownTaskId}/review`, {
      method: 'POST',
      body: JSON.stringify({ pass: true }),
    });
    assert.equal(reviewed.status, 200);

    const repeatedReview = await call(base, `/execution/tasks/${ownTaskId}/review`, {
      method: 'POST', body: JSON.stringify({ pass: true }),
    });
    assert.equal(repeatedReview.status, 409);
  });

  assert.equal(q.get(`SELECT status FROM tasks WHERE id=?`, ownTaskId).status, '已完成');
  assert.equal(q.get(`SELECT result FROM task_submissions WHERE task_id=?`, ownTaskId).result, '通过');
});

test('合伙人经营数据：员工无权读取或录入，管理层可录入并查看', async () => {
  const partnerId = q.run(`INSERT INTO partners(name,level,region,status) VALUES('魏红','馆主','天津','活跃')`).lastInsertRowid;

  await withServer(salesA, async base => {
    const list = await call(base, '/execution/partners');
    assert.equal(list.status, 403);

    const checkin = await call(base, '/execution/partner-actions', {
      method: 'POST',
      body: JSON.stringify({ partner_id: partnerId, date: '2026-06-20', studied: true, invite_count: 1 }),
    });
    assert.equal(checkin.status, 403);
  });

  await withServer(boss, async base => {
    const checkin = await call(base, '/execution/partner-actions', {
      method: 'POST',
      body: JSON.stringify({ partner_id: partnerId, date: '2026-06-20', studied: true, invite_count: 1, arrive_count: 1 }),
    });
    assert.equal(checkin.status, 200);
    assert.ok(checkin.json.score > 0);

    const tiers = await call(base, '/execution/partners/tiers');
    assert.equal(tiers.status, 200);
    assert.equal(tiers.json.total, 1);
  });
});

test('经营目标缺失或为0时不伪造完成率，并返回可解释状态', async () => {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const quarter = `${year}-Q${Math.ceil((now.getMonth() + 1) / 3)}`;
  q.run(`DELETE FROM goals WHERE tenant_id=1 AND period IN (?,?,?)`, year, quarter, month);

  await withServer(boss, async base => {
    const missing = await call(base, '/execution/goals');
    assert.equal(missing.status, 200);
    assert.equal(missing.json.length, 3);
    for (const goal of missing.json) {
      assert.equal(goal.target, 0);
      assert.equal(goal.rate, null);
      assert.equal(goal.risk, null);
      assert.equal(goal.status, 'missing');
      assert.match(goal.statusText, /尚未设置/);
    }

    const summary = await call(base, '/execution/summary');
    assert.equal(summary.status, 200);
    assert.equal(summary.json.goalRate, null);
    assert.equal(summary.json.goalStatus, 'missing');
    assert.match(summary.json.goalStatusText, /尚未设置月度经营目标/);

  });

  q.run(`INSERT INTO goals(period,revenue_target,tenant_id) VALUES(?,?,1)`, month, 0);
  q.run(`INSERT INTO sys_config(key,value) VALUES('month_revenue_target:1','0')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  await withServer(boss, async base => {
    const zero = await call(base, '/execution/goals');
    assert.equal(zero.status, 200);
    const monthGoal = zero.json.find(item => item.period === month);
    assert.equal(monthGoal.target, 0);
    assert.equal(monthGoal.rate, null);
    assert.equal(monthGoal.risk, null);
    assert.equal(monthGoal.status, 'zero');
    assert.match(monthGoal.statusText, /目标为0/);

    const summary = await call(base, '/execution/summary');
    assert.equal(summary.json.goalRate, null);
    assert.equal(summary.json.goalStatus, 'zero');
    assert.match(summary.json.goalStatusText, /目标为0/);

    const drill = await call(base, '/execution/goals-drill');
    assert.equal(drill.json.month.rate, null);
    assert.equal(drill.json.month.status, 'zero');
    assert.equal(drill.json.month.gap, null);
    assert.equal(drill.json.month.needDealsPerDay, null);
    assert.equal(drill.json.month.inviteTarget, null);
  });

  q.run(`DELETE FROM sys_config WHERE key='month_revenue_target:1'`);
  q.run(`DELETE FROM goals WHERE tenant_id=1 AND period IN (?,?,?)`, year, quarter, month);
});

test('今日作战计划：四类任务有各自目标拆解依据，员工可查看但不能重新生成', async () => {
  q.run(`INSERT OR REPLACE INTO sys_config(key,value) VALUES('month_revenue_target','500000')`);
  q.run(`INSERT INTO goals(period,revenue_target,tenant_id) VALUES(?,?,1)`, '2026-06', 500000);
  q.run(`INSERT OR IGNORE INTO daily_ops(date,content_count,new_leads,invited,arrived,deals,deal_amount,tenant_id)
    VALUES('2026-06-20',8,9,6,3,1,12000,1)`);
  q.run(`INSERT INTO leads(name,phone,source,identity_tag,budget_level,stage,score,grade,owner_id,next_follow_at,tenant_id)
    VALUES('赵玲','13900000001','品鉴会','企业主','高','已邀约',88,'A',?,datetime('now','-1 day'),1)`, salesA.id);
  q.run(`INSERT INTO leads(name,phone,source,identity_tag,budget_level,stage,score,grade,owner_id,next_follow_at,tenant_id)
    VALUES('罗明','13900000002','转介绍','企业主','高','已沟通',82,'A',?,datetime('now','+1 day'),1)`, salesA.id);
  q.run(`INSERT INTO partners(name,level,region,status,tenant_id) VALUES('魏红','馆主','天津','活跃',1)`);

  await withServer(salesA, async base => {
    const plan = await call(base, '/execution/battle-plan/today');
    assert.equal(plan.status, 200);
    assert.equal(plan.json.planVersion, 2);
    const byType = Object.fromEntries(plan.json.tasks.map(t => [t.type, t]));
    assert.match(byType['内容'].basis.source, /不直接按销售回款额/);
    assert.match(byType['邀约'].basis.formula, /邀约到店率/);
    assert.match(byType['跟进'].basis.formula, /A类客户/);
    assert.match(byType['培训'].basis.source, /协作伙伴活跃分层/);

    const confirmed = await call(base, '/execution/battle-plan/confirm', { method: 'POST', body: JSON.stringify({ index: 0 }) });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.json.created, 1);
    assert.equal(confirmed.json.confirmation.items[0].confirmed, true);
    assert.equal(confirmed.json.confirmation.confirmed, false);

    const repeated = await call(base, '/execution/battle-plan/confirm', { method: 'POST', body: JSON.stringify({ index: 0 }) });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.json.created, 0);
    assert.equal(repeated.json.existing, 1);

    const confirmedAll = await call(base, '/execution/battle-plan/confirm', { method: 'POST', body: '{}' });
    assert.equal(confirmedAll.status, 200);
    assert.equal(confirmedAll.json.created, plan.json.tasks.length - 1);
    assert.equal(confirmedAll.json.confirmation.confirmed, true);

    const list = await call(base, '/execution/tasks');
    assert.equal(list.status, 200);
    const planTaskTitles = new Set(plan.json.tasks.map(t => t.action));
    const pendingPlanTasks = list.json.filter(t => planTaskTitles.has(t.title) && t.status === '待执行');
    assert.equal(pendingPlanTasks.length, plan.json.tasks.length);

    const rollup = await call(base, '/execution/battle-plan/rollup');
    assert.equal(rollup.status, 200);
    assert.match(rollup.json.scope, /员工视角/);
    assert.ok(rollup.json.today.total >= plan.json.tasks.length);
    assert.ok(rollup.json.today.rows.length >= plan.json.tasks.length);
    assert.ok(rollup.json.week.total >= plan.json.tasks.length);
    assert.ok(rollup.json.month.total >= plan.json.tasks.length);

    const score = await call(base, '/execution/drill/exec-score');
    assert.equal(score.status, 200);
    assert.equal(score.json.formula.steps.length, 4);
    assert.ok(score.json.formula.steps.some(x => x.key === 'submit'));
    assert.ok(Array.isArray(score.json.processRows));

    const regen = await call(base, '/execution/battle-plan/generate', { method: 'POST', body: '{}' });
    assert.equal(regen.status, 403);
  });
});

test('cleanup', () => {
  for (const file of writtenFiles) { try { fs.rmSync(file, { force: true }); } catch {} }
  for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
});
