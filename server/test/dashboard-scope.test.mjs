import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `shanmei-dashboard-scope-${process.pid}.db`);
for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
const dashboardRoutes = (await import('../src/routes/dashboard.js')).default;

initSchema();
migrateV2();

q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`, 'boss', hashPassword('123456'), '老板', 'boss', '决策层');
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`, 'sales', hashPassword('123456'), '销售', 'sales', '销售部');
const boss = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='boss'`);
const sales = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='sales'`);

function addLead(name, source, createdAt, stage = '新线索') {
  const ret = q.run(`INSERT INTO leads(name,source,stage,owner_id,created_at,updated_at) VALUES(?,?,?,?,?,?)`,
    name, source, stage, sales.id, createdAt, createdAt);
  return ret.lastInsertRowid;
}

const aprilLead = addLead('四月客户', '社群', '2026-04-10 09:00:00', '已成交');
const mayLeadA = addLead('五月客户A', '短视频', '2026-05-02 10:00:00', '已成交');
const mayLeadB = addLead('五月客户B', '转介绍', '2026-05-18 11:00:00', '已沟通');
const julyLead = addLead('七月客户', '到店', '2026-07-01 12:00:00', '已成交');

q.run(`INSERT INTO orders(lead_id,product,amount,type,region,channel,created_at) VALUES(?,?,?,?,?,?,?)`, aprilLead, '青花清', 2000, '零售', '太原', '社群', '2026-04-10 13:00:00');
q.run(`INSERT INTO orders(lead_id,product,amount,type,region,channel,created_at) VALUES(?,?,?,?,?,?,?)`, mayLeadA, '青花清', 1200, '零售', '太原', '短视频', '2026-05-02 15:00:00');
q.run(`INSERT INTO orders(lead_id,product,amount,type,region,channel,created_at) VALUES(?,?,?,?,?,?,?)`, mayLeadB, '封坛酒', 1800, '封坛', '太原', '转介绍', '2026-05-18 16:00:00');
q.run(`INSERT INTO orders(lead_id,product,amount,type,region,channel,created_at) VALUES(?,?,?,?,?,?,?)`, julyLead, '青花清', 9000, '团购', '太原', '到店', '2026-07-01 16:00:00');

q.run(`INSERT INTO follow_ups(lead_id,user_id,content,stage_after,created_at) VALUES(?,?,?,?,?)`, aprilLead, sales.id, '四月跟进', '已成交', '2026-04-10 14:00:00');
q.run(`INSERT INTO follow_ups(lead_id,user_id,content,stage_after,created_at) VALUES(?,?,?,?,?)`, mayLeadA, sales.id, '五月跟进A', '已成交', '2026-05-02 17:00:00');
q.run(`INSERT INTO follow_ups(lead_id,user_id,content,stage_after,created_at) VALUES(?,?,?,?,?)`, mayLeadB, sales.id, '五月跟进B', '已沟通', '2026-05-18 17:00:00');
q.run(`INSERT INTO follow_ups(lead_id,user_id,content,stage_after,created_at) VALUES(?,?,?,?,?)`, julyLead, sales.id, '七月跟进', '已成交', '2026-07-01 17:00:00');

q.run(`INSERT INTO activities(title,type,status,date,location,owner_id) VALUES(?,?,?,?,?,?)`, '四月品鉴会', '品鉴会', '已结束', '2026-04-12', '酒道馆', boss.id);
q.run(`INSERT INTO activities(title,type,status,date,location,owner_id) VALUES(?,?,?,?,?,?)`, '五月品鉴会', '品鉴会', '已结束', '2026-05-20', '酒道馆', boss.id);
q.run(`INSERT INTO activities(title,type,status,date,location,owner_id) VALUES(?,?,?,?,?,?)`, '七月品鉴会', '品鉴会', '筹备中', '2026-07-02', '酒道馆', boss.id);

q.run(`INSERT INTO tasks(title,type,status,assignee_id,created_at,done_at) VALUES(?,?,?,?,?,?)`, '五月成交复盘', '数据', '已完成', sales.id, '2026-05-03 10:00:00', '2026-05-03 18:00:00');
q.run(`INSERT INTO tasks(title,type,status,assignee_id,created_at,done_at) VALUES(?,?,?,?,?,?)`, '七月客户回访', '跟进', '已完成', sales.id, '2026-07-02 10:00:00', '2026-07-02 18:00:00');

function makeApp(user = boss) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => runWithTenant(1, () => { req.user = user; next(); }));
  app.use('/dashboard', dashboardRoutes);
  return app;
}

async function withServer(fn) {
  const server = makeApp().listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function withUserServer(user, fn) {
  const server = makeApp(user).listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('首页自定义指定月：summary 聚合只包含该自然月', async () => {
  await withServer(async base => {
    const data = await fetch(`${base}/dashboard/summary?mode=month&month=2026-05`).then(r => r.json());
    assert.equal(data.scope.label, '2026年05月');
    assert.equal(data.scope.start, '2026-05-01');
    assert.equal(data.scope.end, '2026-05-31');
    assert.equal(data.todaySales, 3000);
    assert.equal(data.monthLeads, 2);
    assert.equal(data.followRecords, 2);
    assert.equal(data.runningActivities, 1);
    assert.equal(data.taskRate, 100);
  });
});

test('首页自定义指定日：trend 返回单日连续序列和当日来源数据', async () => {
  await withServer(async base => {
    const data = await fetch(`${base}/dashboard/trend?mode=day&date=2026-05-02`).then(r => r.json());
    assert.equal(data.scope.label, '2026-05-02');
    assert.equal(data.rows.length, 1);
    assert.equal(data.rows[0].date, '2026-05-02');
    assert.equal(data.rows[0].deal_amount, 1200);
    assert.equal(data.rows[0].deals, 1);
    assert.equal(data.rows[0].new_leads, 1);
  });
});

test('首页自定义指定季度：summary 与活动列表覆盖完整季度', async () => {
  await withServer(async base => {
    const summary = await fetch(`${base}/dashboard/summary?mode=quarter&quarter=2026-Q2`).then(r => r.json());
    assert.equal(summary.scope.label, '2026年第2季度');
    assert.equal(summary.todaySales, 5000);
    assert.equal(summary.monthLeads, 3);
    assert.equal(summary.runningActivities, 2);

    const acts = await fetch(`${base}/dashboard/week-activities?mode=quarter&quarter=2026-Q2`).then(r => r.json());
    assert.equal(acts.scope.label, '2026年第2季度');
    assert.deepEqual(acts.rows.map(x => x.title), ['四月品鉴会', '五月品鉴会']);
  });
});

test('首页自定义指定月：沟通看板和渠道也跟随范围', async () => {
  await withServer(async base => {
    const follow = await fetch(`${base}/dashboard/follow-overview?mode=month&month=2026-05`).then(r => r.json());
    assert.equal(follow.scope.label, '2026年05月');
    assert.equal(follow.summary.followRecords, 2);
    assert.equal(follow.staff[0].follow_count, 2);
    assert.equal(follow.recent.length, 2);

    const channels = await fetch(`${base}/dashboard/channels?mode=month&month=2026-05`).then(r => r.json());
    assert.deepEqual(channels.rows.map(x => x.channel).sort(), ['短视频', '转介绍']);
  });
});

test('首页全部经营数据：默认口径覆盖历史导入日期和所有业务模块', async () => {
  await withServer(async base => {
    const data = await fetch(`${base}/dashboard/summary?mode=all`).then(r => r.json());
    assert.equal(data.scope.label, '全部经营数据');
    assert.equal(data.scope.start, '2026-04-10');
    assert.equal(data.scope.end, '2026-07-02');
    assert.equal(data.todaySales, 14000);
    assert.equal(data.monthLeads, 4);
    assert.equal(data.salesWow, 0);
    assert.equal(data.leadsWow, 0);
    assert.equal(data.runningActivities, 3);
    assert.equal(data.businessRows, 13);
    assert.equal(data.timeScope.hasData, true);
  });
});

test('普通员工驾驶舱不得用全租户日报补齐本人无数据的指标、趋势、健康度或下钻', async () => {
  const hiddenLead = Number(q.run(`INSERT INTO leads(name,source,stage,owner_id,created_at,updated_at)
    VALUES('老板私有客户','老板渠道','已成交',?,'2026-06-15 09:00:00','2026-06-15 09:00:00')`, boss.id).lastInsertRowid);
  q.run(`INSERT INTO orders(lead_id,product,amount,type,region,channel,created_at)
    VALUES(?,?,?,?,?,?,?)`, hiddenLead, '老板私有订单', 88888, '团购', '太原', '老板渠道', '2026-06-15 10:00:00');
  q.run(`INSERT INTO daily_ops(date,deal_amount,deals,new_leads,tenant_id)
    VALUES('2026-06-15',999999,99,999,1)`);
  try {
    await withUserServer(sales, async base => {
      const summary = await fetch(`${base}/dashboard/summary?mode=day&date=2026-06-15`).then(r => r.json());
      assert.equal(summary.todaySales, 0);
      assert.equal(summary.monthLeads, 0);
      assert.equal(summary.health, null);
      assert.equal(summary.timeScope.latestOps, null);

      const trend = await fetch(`${base}/dashboard/trend?mode=day&date=2026-06-15`).then(r => r.json());
      assert.deepEqual(
        trend.rows.map(row => [row.deal_amount, row.deals, row.new_leads]),
        [[0, 0, 0]],
      );

      const detail = await fetch(`${base}/dashboard/day-detail?date=2026-06-15`).then(r => r.json());
      assert.equal(detail.ops, null);
      assert.equal(detail.orders.length, 0);
      assert.equal(detail.newLeads.length, 0);

      const salesFunnel = await fetch(`${base}/dashboard/funnel`).then(r => r.json());
      assert.equal(salesFunnel.funnel[0].count, 4);
    });
  } finally {
    q.run(`DELETE FROM orders WHERE lead_id=?`, hiddenLead);
    q.run(`DELETE FROM leads WHERE id=?`, hiddenLead);
    q.run(`DELETE FROM daily_ops WHERE date='2026-06-15'`);
  }
});

test('每日经营日报仅管理层可读，普通员工不得读取全租户经营归因', async () => {
  await withUserServer(sales, async base => {
    const response = await fetch(`${base}/dashboard/daily-digest`);
    const data = await response.json();
    assert.equal(response.status, 403);
    assert.match(data.error, /无权限/);
  });

  await withUserServer(boss, async base => {
    const response = await fetch(`${base}/dashboard/daily-digest`);
    assert.equal(response.status, 200);
  });
});

test('cleanup', () => {
  for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
});
