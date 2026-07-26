import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `shanmei-feedback-regression-${process.pid}.db`);
for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
const contentRoutes = (await import('../src/routes/content.js')).default;
const activityRoutes = (await import('../src/routes/activities.js')).default;
const assetRoutes = (await import('../src/routes/assets.js')).default;

initSchema();
migrateV2();
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`, 'boss', hashPassword('123456'), '老板', 'boss', '决策层');
q.run(`UPDATE tenants SET credits=100000 WHERE id=1`);

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => runWithTenant(1, () => { req.user = { id: 1, name: '老板', role: 'boss', tenant_id: 1 }; next(); }));
  app.use('/content', contentRoutes);
  app.use('/activities', activityRoutes);
  app.use('/assets', assetRoutes);
  return app;
}

async function withServer(fn) {
  const server = makeApp().listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('甲方反馈：内容工厂待审核列表遇到系统生成内容也不应500', async () => {
  q.run(`INSERT INTO contents(type,title,body,status,risk_flags,risk_level,creator_id)
    VALUES('朋友圈文案','待审核系统内容','正文','待审核','not-json','medium',NULL)`);

  await withServer(async base => {
    const resp = await fetch(`${base}/content/list?status=${encodeURIComponent('待审核')}&page=1&size=6`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.total, 1);
    assert.equal(data.rows[0].creator, '系统生成');
    assert.equal(data.rows[0].risk_flags, '[]');
  });
});

test('甲方反馈：活动状态随日期自动流转，过期筹备活动进入已结束', async () => {
  q.run(`INSERT INTO activities(title,type,status,date,owner_id)
    VALUES('昨日仍筹备的活动','品鉴会','筹备中',date('now','localtime','-1 day'),1)`);

  await withServer(async base => {
    const rows = await fetch(`${base}/activities`).then(r => r.json());
    const act = rows.find(x => x.title === '昨日仍筹备的活动');
    assert.equal(act.status, '已结束');
  });
});

test('甲方反馈：资产来源为空时不计入信息完整度并进入预警', async () => {
  q.run(`INSERT INTO biz_assets(name,category,value,status,use_count,owner,source_type,creator_id)
    VALUES('有来源资产','数据资产',100,'使用中',1,'内容工厂','content',1)`);
  q.run(`INSERT INTO biz_assets(name,category,value,status,use_count,owner,creator_id)
    VALUES('无来源资产','数据资产',100,'使用中',1,'内容工厂',1)`);

  await withServer(async base => {
    const health = await fetch(`${base}/assets/health`).then(r => r.json());
    const complete = health.subs.find(x => x.name === '信息完整度');
    assert.equal(complete.value, 50);

    const warnings = await fetch(`${base}/assets/warnings`).then(r => r.json());
    assert.equal(warnings.counts.incomplete, 1);
    assert.equal(warnings.incomplete[0].name, '无来源资产');
  });
});

test('cleanup', () => {
  for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
});
