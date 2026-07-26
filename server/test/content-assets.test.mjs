import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DBP = path.join(os.tmpdir(), `nanowork-content-assets-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* fresh database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.SEED_DEMO = 'false';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { contentAssetBaseValue, ensureContentAsset } = await import('../src/engines/content-assets.js');

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'内容资产测试企业','已开通',10000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);
const userId = Number(q.run(`INSERT INTO users(
  username,password_hash,name,role,status,tenant_id
) VALUES('content-asset-owner','x','内容资产负责人','boss','启用',1)`).lastInsertRowid);

test('内容资产基础价值按内容类型稳定映射', () => {
  assert.equal(contentAssetBaseValue({ type: '朋友圈文案' }), 50);
  assert.equal(contentAssetBaseValue({ type: 'AIPPT' }), 180);
  assert.equal(contentAssetBaseValue({ type: 'AI视频' }), 220);
  assert.equal(contentAssetBaseValue({ type: '未知内容' }), 80);
});

test('ensureContentAsset 幂等补建，并把既有发布效果纳入最低价值与使用次数', () => {
  const contentId = runWithTenant(1, () => Number(q.run(`INSERT INTO contents(
    type,title,body,status,creator_id,effect_views,effect_leads
  ) VALUES('朋友圈文案','可追溯内容','正文','可使用',?,100,3)`, userId).lastInsertRowid));

  runWithTenant(1, () => {
    const first = ensureContentAsset(contentId);
    assert.equal(first.value, 80);
    assert.equal(first.use_count, 0);

    q.run(`INSERT INTO content_publish_logs(
      content_id,channel,views,leads,idempotency_key,created_by
    ) VALUES(?,?,?,?,?,?)`, contentId, '朋友圈', 100, 3, '11111111-1111-4111-8111-111111111111', userId);
    q.run(`INSERT INTO content_publish_logs(
      content_id,channel,views,leads,idempotency_key,created_by
    ) VALUES(?,?,?,?,?,?)`, contentId, '社群', 50, 2, '22222222-2222-4222-8222-222222222222', userId);
    q.run(`UPDATE contents SET effect_views=150,effect_leads=5,status='已发布' WHERE id=?`, contentId);

    const second = ensureContentAsset(contentId);
    assert.equal(second.existed, true);
    assert.equal(second.value, 100);
    assert.equal(second.use_count, 2);
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets
      WHERE tenant_id=1 AND source_type='content' AND source_id=?`, contentId).n, 1);
  });
});

after(() => {
  db.close();
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
});
