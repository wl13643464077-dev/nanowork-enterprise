import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-assets-crud-${process.pid}.db`);
for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* fresh db */ } }
process.env.NANOWORK_DB = DBP;
process.env.SEED_DEMO = 'false';
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const assetsRoutes = (await import('../src/routes/assets.js')).default;

initSchema();
migrateV2();

for (const [id, name] of [[1, '资产测试企业A'], [2, '资产测试企业B']]) {
  q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(?,?,'已开通',10000)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status`, id, name);
}
const mkUser = (tenant, username, role) => {
  const id = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES(?,?,?,?,'启用',?)`, username, 'x', `${username}-姓名`, role, tenant).lastInsertRowid);
  return q.get('SELECT id,name,role,dept,tenant_id FROM users WHERE id=?', id);
};
const bossA = mkUser(1, 'boss-a', 'boss');
const bossB = mkUser(2, 'boss-b', 'boss');

function makeApp(user, tenant) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => runWithTenant(tenant, () => { req.user = user; next(); }));
  app.use('/assets', assetsRoutes);
  return app;
}

async function withServer(user, tenant, fn) {
  const server = makeApp(user, tenant).listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

const post = (base, url, body) => fetch(`${base}${url}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const put = (base, url, body) => fetch(`${base}${url}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

let assetId = 0;

test('POST /assets 单条创建：写入租户资产并记录创建流水', async () => {
  await withServer(bossA, 1, async base => {
    const res = await post(base, '/assets', {
      name: '门店签约话术手册', category: '知识资产', value: 800, status: '使用中',
      owner: '市场部', url: 'https://example.com/doc', note: '线下资料整理入库',
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.asset.name, '门店签约话术手册');
    assert.equal(data.asset.category, '知识资产');
    assert.equal(data.asset.value, 800);
    assert.equal(data.asset.tenant_id, 1);
    assert.equal(data.asset.source_type, 'manual');
    assetId = data.asset.id;
    const flow = q.get(`SELECT action FROM asset_flows WHERE tenant_id=1 AND asset_id=? ORDER BY id DESC`, assetId);
    assert.equal(flow.action, '创建');
  });
});

test('POST /assets 校验：缺名称 400，非法分类 400，估值允许为 0（未估值）', async () => {
  await withServer(bossA, 1, async base => {
    assert.equal((await post(base, '/assets', { category: '知识资产' })).status, 400);
    assert.equal((await post(base, '/assets', { name: 'x', category: '奇怪分类' })).status, 400);
    const res = await post(base, '/assets', { name: '未估值样品资产', category: '品牌资产', value: 0 });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.asset.value, 0);
  });
});

test('PUT /assets/:id 编辑字段并写更新流水', async () => {
  await withServer(bossA, 1, async base => {
    const res = await put(base, `/assets/${assetId}`, { name: '门店签约话术手册V2', value: 1200, owner: '销售部' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.asset.name, '门店签约话术手册V2');
    assert.equal(data.asset.value, 1200);
    assert.equal(data.asset.owner, '销售部');
    const flow = q.get(`SELECT action,note FROM asset_flows WHERE tenant_id=1 AND asset_id=? ORDER BY id DESC`, assetId);
    assert.equal(flow.action, '更新');
    assert.match(flow.note, /名称|估值|归属/);
  });
});

test('PUT /assets/:id 非法值被拒绝', async () => {
  await withServer(bossA, 1, async base => {
    assert.equal((await put(base, `/assets/${assetId}`, { name: '' })).status, 400);
    assert.equal((await put(base, `/assets/${assetId}`, { category: '外星资产' })).status, 400);
    assert.equal((await put(base, `/assets/${assetId}`, { status: '飞升' })).status, 400);
  });
});

test('跨租户隔离：企业B无法编辑或看到企业A的资产', async () => {
  await withServer(bossB, 2, async base => {
    const res = await put(base, `/assets/${assetId}`, { name: '越权改名' });
    assert.equal(res.status, 404);
    const list = await fetch(`${base}/assets?page=1&size=100`).then(r => r.json());
    assert.equal(list.rows.some(r => r.id === assetId), false);
    assert.equal(list.total, 0);
  });
  // 企业A的资产未被篡改
  assert.equal(q.get('SELECT name FROM biz_assets WHERE tenant_id=1 AND id=?', assetId).name, '门店签约话术手册V2');
});

test('未估值(0)资产不抬高资产总值，且进入信息不完整预警', async () => {
  await withServer(bossA, 1, async base => {
    const summary = await fetch(`${base}/assets/summary`).then(r => r.json());
    // 当前口径：totalValue = SUM(value)，未估值(0)贡献为 0
    assert.equal(summary.total, 2);
    assert.equal(summary.totalValue, 1200);
    const warnings = await fetch(`${base}/assets/warnings`).then(r => r.json());
    assert.equal(warnings.incomplete.some(x => x.name === '未估值样品资产'), true);
  });
});

after(() => {
  db.close();
  for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } }
});
