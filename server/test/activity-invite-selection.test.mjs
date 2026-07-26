import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-activity-invite-selection-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const activitiesRoutes = (await import('../src/routes/activities.js')).default;

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,plan,credits) VALUES(1,'圈选测试门店','已开通','标准版',0)
  ON CONFLICT(id) DO UPDATE SET status=excluded.status`);
q.run(`INSERT INTO tenants(id,name,status,plan,credits) VALUES(2,'其他门店','已开通','标准版',0)
  ON CONFLICT(id) DO UPDATE SET status=excluded.status`);
const bossId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id)
  VALUES('circle_boss','x','门店老板','boss','决策层',1)`).lastInsertRowid);
const activityId = Number(q.run(`INSERT INTO activities(title,type,status,date,location,owner_id,tenant_id)
  VALUES('顾客复核活动','门店主题活动','筹备中','2026-08-01','中心店',?,1)`, bossId).lastInsertRowid);

function addLead(name, { grade = 'A', score = 80, stage = '已沟通', phone = '13900000000', wechat = '', tenantId = 1 } = {}) {
  return Number(q.run(`INSERT INTO leads(name,phone,wechat,grade,score,stage,owner_id,tenant_id)
    VALUES(?,?,?,?,?,?,?,?)`, name, phone, wechat, grade, score, stage, bossId, tenantId).lastInsertRowid);
}

const high = addLead('高意向顾客', { grade: 'A', score: 95, stage: '已沟通' });
const second = addLead('次高意向顾客', { grade: 'B', score: 82, stage: '已邀约', phone: '', wechat: 'wx-reviewed' });
addLead('缺少联系方式顾客', { grade: 'A', score: 94, stage: '已沟通', phone: '', wechat: '' });
addLead('等级未命中顾客', { grade: 'C', score: 99, stage: '已沟通' });
addLead('阶段不适用顾客', { grade: 'A', score: 98, stage: '已成交' });
const invited = addLead('已在名单顾客', { grade: 'A', score: 97, stage: '已到店' });
q.run(`INSERT INTO activity_invites(activity_id,lead_id,tenant_id) VALUES(?,?,1)`, activityId, invited);
addLead('其他门店顾客', { grade: 'A', score: 100, stage: '已沟通', tenantId: 2 });

const boss = { id: bossId, name: '门店老板', role: 'boss', tenant_id: 1 };

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(1, () => { req.user = boss; next(); }));
  app.use('/activities', activitiesRoutes);
  return app;
}

async function withServer(fn) {
  const server = makeApp().listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('智能圈选先返回透明预览，显示规则、候选数和排除原因且不写入名单', async () => {
  await withServer(async base => {
    const before = q.get(`SELECT COUNT(*) n FROM activity_invites WHERE tenant_id=1 AND activity_id=?`, activityId).n;
    const response = await fetch(`${base}/activities/${activityId}/invite-candidates?limit=10`);
    assert.equal(response.status, 200);
    const preview = await response.json();

    assert.equal(preview.confirmationRequired, true);
    assert.equal(preview.activity.id, activityId);
    assert.ok(preview.rules.length >= 4);
    assert.deepEqual(preview.counts, { scopedTotal: 6, eligible: 2, selected: 2, excluded: 4 });
    assert.deepEqual(preview.candidates.map(item => item.id), [high, second]);
    assert.ok(preview.candidates.every(item => item.matchedRules.length === preview.rules.length));
    assert.ok(preview.exclusions.some(item => item.reason === '客户等级未命中'));
    assert.ok(preview.exclusions.some(item => item.reason === '客户阶段不适用'));
    assert.ok(preview.exclusions.some(item => item.reason === '缺少可用联系方式'));
    assert.ok(preview.exclusions.some(item => item.reason === '已在活动名单'));
    assert.doesNotMatch(JSON.stringify(preview), /其他门店顾客/);
    assert.equal(q.get(`SELECT COUNT(*) n FROM activity_invites WHERE tenant_id=1 AND activity_id=?`, activityId).n, before);
  });
});

test('旧式 autoSelect 不再直接落库，必须由老板显式提交复核后的 leadIds', async () => {
  await withServer(async base => {
    const oldAuto = await fetch(`${base}/activities/${activityId}/invites`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoSelect: 10 }),
    });
    assert.equal(oldAuto.status, 400);
    assert.match((await oldAuto.json()).error, /先预览|明确提交/);

    const invalid = await fetch(`${base}/activities/${activityId}/invites`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadIds: [high, invited], selectionMode: 'smart' }),
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /候选已变化|不符合/);

    const confirmed = await fetch(`${base}/activities/${activityId}/invites`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadIds: [high], selectionMode: 'smart' }),
    });
    assert.equal(confirmed.status, 200);
    assert.deepEqual(await confirmed.json(), { added: 1, skipped: 0 });
    assert.equal(q.get(`SELECT COUNT(*) n FROM activity_invites WHERE tenant_id=1 AND activity_id=? AND lead_id=?`, activityId, high).n, 1);
    assert.equal(q.get(`SELECT COUNT(*) n FROM activity_invites WHERE tenant_id=1 AND activity_id=? AND lead_id=?`, activityId, second).n, 0);
  });
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});
