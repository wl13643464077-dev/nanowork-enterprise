import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DBP = path.join(os.tmpdir(), `nanowork-legacy-terminology-zero-${process.pid}.db`);
for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(f, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { hashPassword, today } = await import('../src/util.js');
const activityRoutes = (await import('../src/routes/activities.js')).default;
const executionRoutes = (await import('../src/routes/execution.js')).default;

initSchema();
migrateV2();

const bossId = q.run(
  `INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`,
  'boss',
  hashPassword('123456'),
  '老板',
  'boss',
  '决策层',
).lastInsertRowid;
q.run(`UPDATE tenants SET credits=100000 WHERE id=1`);

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => runWithTenant(1, () => {
    req.user = { id: Number(bossId), name: '老板', role: 'boss', tenant_id: 1 };
    next();
  }));
  app.use('/activities', activityRoutes);
  app.use('/execution', executionRoutes);
  return app;
}

async function withServer(fn) {
  const server = makeApp().listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function jsonReq(base, urlPath, opts = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  return { status: res.status, body: await res.json() };
}

test('activities 读时规范化历史库旧活动类型并保持写入兼容', async () => {
  const actDate = today();
  const cases = [
    ['历史记录-试吃', '品鉴会', '主题试吃'],
    ['历史记录-沙龙', '沙龙会', '门店沙龙'],
    ['历史记录-开放日', '回厂游', '后厨开放日'],
    ['历史记录-新品', '封坛仪式', '新品发布'],
  ];
  const ids = new Map();
  for (const [title, legacyType] of cases) {
    const id = q.run(
      `INSERT INTO activities(title,type,status,date,location,target_join,owner_id,tenant_id) VALUES(?,?,?,?,?,?,?,1)`,
      title,
      legacyType,
      '筹备中',
      actDate,
      '中心门店',
      20,
      bossId,
    ).lastInsertRowid;
    ids.set(title, Number(id));
  }
  const draftId = Number(q.run(
    `INSERT INTO activity_plan_drafts(user_id,title,type,date,goal,audience,budget,target_join,plan,status,tenant_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,1)`,
    bossId,
    '历史新品草稿',
    '封坛仪式',
    actDate,
    '新品体验',
    '会员客户',
    '1万以内',
    25,
    JSON.stringify({ theme: '历史新品草稿', flow: [{ time: '14:00', item: '签到' }], materials: ['菜单'], sop: ['复核'] }),
    '草稿',
  ).lastInsertRowid);

  await withServer(async base => {
    const list = await jsonReq(base, '/activities');
    assert.equal(list.status, 200);
    for (const [title, , expected] of cases) {
      const hit = list.body.find(item => item.title === title);
      assert.ok(hit, `应返回活动 ${title}`);
      assert.equal(hit.type, expected);
    }
    assert.doesNotMatch(JSON.stringify(list.body), /品鉴会|沙龙会|回厂游|封坛仪式/);

    const drill = await jsonReq(base, '/activities/stats-drill');
    assert.equal(drill.status, 200);
    for (const [title, , expected] of cases) {
      const hit = drill.body.rows.find(item => item.title === title);
      assert.ok(hit, `stats-drill 应返回活动 ${title}`);
      assert.equal(hit.type, expected);
    }
    assert.doesNotMatch(JSON.stringify(drill.body), /品鉴会|沙龙会|回厂游|封坛仪式/);

    const updated = await jsonReq(base, `/activities/${ids.get('历史记录-试吃')}`, {
      method: 'PUT',
      body: JSON.stringify({ revenue: 1800 }),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.type, '主题试吃');

    const drafts = await jsonReq(base, '/activities/plan-drafts/list');
    assert.equal(drafts.status, 200);
    assert.equal(drafts.body.find(item => item.id === draftId)?.type, '新品发布');
    const draftDetail = await jsonReq(base, `/activities/plan-drafts/${draftId}`);
    assert.equal(draftDetail.status, 200);
    assert.equal(draftDetail.body.type, '新品发布');

    // 新建写入：现代口径透传，旧值写入兼容且不落库旧词
    const modernCreate = await jsonReq(base, '/activities', {
      method: 'POST',
      body: JSON.stringify({ title: '现代餐饮活动', date: actDate, type: '主题试吃' }),
    });
    assert.equal(modernCreate.status, 200);
    assert.equal(q.get(`SELECT type FROM activities WHERE tenant_id=1 AND id=?`, modernCreate.body.id).type, '主题试吃');

    const legacyLaunchCreate = await jsonReq(base, '/activities', {
      method: 'POST',
      body: JSON.stringify({ title: '兼容新品活动', date: actDate, type: '封坛仪式' }),
    });
    assert.equal(legacyLaunchCreate.status, 200);
    assert.equal(q.get(`SELECT type FROM activities WHERE tenant_id=1 AND id=?`, legacyLaunchCreate.body.id).type, '新品发布');
  });
});

test('execution 读时规范化历史合作伙伴等级 馆主 -> 门店负责人', async () => {
  const activePartnerId = Number(q.run(
    `INSERT INTO partners(name,level,region,status,tenant_id) VALUES('林青','馆主','上海','活跃',1)`,
  ).lastInsertRowid);
  const silentPartnerId = Number(q.run(
    `INSERT INTO partners(name,level,region,status,tenant_id) VALUES('周明','馆主','杭州','活跃',1)`,
  ).lastInsertRowid);
  q.run(
    `INSERT INTO partner_actions(partner_id,date,studied,posted_moments,posted_videos,invited,invite_count,intent_count,arrive_count,deal_count,score,tenant_id)
     VALUES(?,?,1,2,1,1,3,2,1,1,120,1)`,
    activePartnerId,
    today(),
  );

  await withServer(async base => {
    const partners = await jsonReq(base, '/execution/partners');
    assert.equal(partners.status, 200);
    assert.equal(partners.body.find(p => p.id === activePartnerId)?.level, '门店负责人');
    assert.equal(partners.body.find(p => p.id === silentPartnerId)?.level, '门店负责人');
    assert.doesNotMatch(JSON.stringify(partners.body), /馆主/);

    const leaderboard = await jsonReq(base, '/execution/partners/leaderboard');
    assert.equal(leaderboard.status, 200);
    assert.equal(leaderboard.body.find(p => p.id === activePartnerId)?.level, '门店负责人');
    assert.doesNotMatch(JSON.stringify(leaderboard.body), /馆主/);

    const silent = await jsonReq(base, '/execution/partners/silent');
    assert.equal(silent.status, 200);
    assert.equal(silent.body.find(p => p.id === silentPartnerId)?.level, '门店负责人');
    assert.doesNotMatch(JSON.stringify(silent.body), /馆主/);

    const tiers = await jsonReq(base, '/execution/partners/tiers');
    assert.equal(tiers.status, 200);
    const members = tiers.body.groups.flatMap(g => g.members);
    assert.equal(members.find(p => p.id === activePartnerId)?.level, '门店负责人');
    assert.doesNotMatch(JSON.stringify(tiers.body), /馆主/);

    const detail = await jsonReq(base, `/execution/partners/${activePartnerId}/detail`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.level, '门店负责人');
    assert.doesNotMatch(JSON.stringify(detail.body), /馆主/);

    const remind = await jsonReq(base, `/execution/partners/${silentPartnerId}/remind`, { method: 'POST', body: '{}' });
    assert.equal(remind.status, 200);
    assert.equal(remind.body.level, '门店负责人');
    assert.doesNotMatch(JSON.stringify(remind.body), /馆主/);
  });
});

test('前端界面契约 check-ui-contract.mjs 0 违约 0 豁免', () => {
  const output = execFileSync(process.execPath, [path.join(ROOT, 'scripts/check-ui-contract.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(output, /前端界面契约通过/);
  assert.doesNotMatch(output, /存量豁免/);

  for (const rel of ['web/src/pages/Activities.tsx', 'web/src/pages/Dashboard.tsx', 'web/src/pages/Execution.tsx']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /馆主|封坛仪式|回厂游|品鉴会|沙龙会/, `${rel} 不得再出现旧酒水术语`);
  }
});

test('cleanup', () => {
  for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
});
