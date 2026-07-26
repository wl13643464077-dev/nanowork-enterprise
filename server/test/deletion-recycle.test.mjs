import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `shanmei-deletion-recycle-${process.pid}.db`);
for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
const growthRoutes = (await import('../src/routes/growth.js')).default;
const systemRoutes = (await import('../src/routes/system.js')).default;

initSchema();
migrateV2();

q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`, 'boss', hashPassword('123456'), '老板', 'boss', '决策层');
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`, 'ops', hashPassword('123456'), '运营总监', 'ops_director', '运营中心');
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id,manager_id) VALUES(?,?,?,?,?,?,?)`, 'sales_a', hashPassword('123456'), '王强', 'sales', '销售部', 1, 2);
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id,manager_id) VALUES(?,?,?,?,?,?,?)`, 'sales_b', hashPassword('123456'), '李娜', 'sales', '销售部', 1, 2);

const boss = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='boss'`);
const ops = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='ops'`);
const salesA = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='sales_a'`);
const salesB = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='sales_b'`);

function makeApp(user) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => runWithTenant(1, () => { req.user = user; next(); }));
  app.use('/growth', growthRoutes);
  app.use('/sys', systemRoutes);
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

test('删除客户：本人只能删简单误录，关键客户进老板权限；老板可从回收站恢复', async () => {
  const ownLead = Number(q.run(`INSERT INTO leads(name,phone,stage,owner_id,tenant_id) VALUES('误录客户','13900000001','新线索',?,1)`, salesA.id).lastInsertRowid);
  const otherLead = Number(q.run(`INSERT INTO leads(name,phone,stage,owner_id,tenant_id) VALUES('他人客户','13900000002','新线索',?,1)`, salesB.id).lastInsertRowid);
  const closedLead = Number(q.run(`INSERT INTO leads(name,phone,stage,owner_id,deal_amount,tenant_id) VALUES('成交客户','13900000003','已成交',?,8800,1)`, salesA.id).lastInsertRowid);
  q.run(`INSERT INTO orders(lead_id,product,amount,type,tenant_id) VALUES(?,?,?,?,1)`, closedLead, '青花清', 8800, '零售');

  await withServer(salesA, async base => {
    const blockedOther = await call(base, `/growth/leads/${otherLead}`, { method: 'DELETE' });
    assert.equal(blockedOther.status, 404);

    const blockedClosed = await call(base, `/growth/leads/${closedLead}`, { method: 'DELETE' });
    assert.equal(blockedClosed.status, 403);
    assert.match(blockedClosed.json.error, /老板|管理员/);

    const removed = await call(base, `/growth/leads/${ownLead}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.ok(removed.json.archiveId);
  });

  assert.equal(q.get(`SELECT id FROM leads WHERE id=?`, ownLead), undefined);
  const archive = q.get(`SELECT * FROM deleted_records WHERE entity_type='lead' AND entity_id=?`, ownLead);
  assert.equal(archive.deleted_by_name, '王强');
  assert.equal(archive.restored_at, null);

  await withServer(boss, async base => {
    const list = await call(base, '/sys/deletions?status=active');
    assert.equal(list.status, 200);
    assert.ok(list.json.some(x => x.id === archive.id && x.title === '误录客户'));

    const restored = await call(base, `/sys/deletions/${archive.id}/restore`, { method: 'POST' });
    assert.equal(restored.status, 200);
    assert.ok(restored.json.restored >= 1);
  });

  assert.equal(q.get(`SELECT name FROM leads WHERE id=?`, ownLead).name, '误录客户');
  assert.ok(q.get(`SELECT restored_at FROM deleted_records WHERE id=?`, archive.id).restored_at);
});

test('删除知识库：已启用/引用文档只能老板删，删除后可恢复关联资产', async () => {
  const enabledDoc = Number(q.run(`INSERT INTO kb_docs(category,title,body,enabled,ref_count,tenant_id) VALUES('品牌资料','核心政策','政策正文',1,2,1)`).lastInsertRowid);
  const assetId = Number(q.run(`INSERT INTO biz_assets(name,category,value,status,owner,source_type,source_id,creator_id,tenant_id) VALUES('核心政策','知识资产',5000,'使用中','知识库','kb',?,?,1)`, enabledDoc, salesA.id).lastInsertRowid);
  q.run(`INSERT INTO asset_flows(asset_id,action,note,operator_id,tenant_id) VALUES(?,?,?,?,1)`, assetId, '入库', '知识库自动登记', salesA.id);

  await withServer(ops, async base => {
    const blocked = await call(base, `/sys/kb/${enabledDoc}`, { method: 'DELETE' });
    assert.equal(blocked.status, 403);
    assert.match(blocked.json.error, /老板|管理员/);
  });

  let archiveId;
  await withServer(boss, async base => {
    const removed = await call(base, `/sys/kb/${enabledDoc}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    archiveId = removed.json.archiveId;
  });
  assert.equal(q.get(`SELECT id FROM kb_docs WHERE id=?`, enabledDoc), undefined);
  assert.equal(q.get(`SELECT id FROM biz_assets WHERE id=?`, assetId), undefined);

  await withServer(boss, async base => {
    const restored = await call(base, `/sys/deletions/${archiveId}/restore`, { method: 'POST' });
    assert.equal(restored.status, 200);
  });
  assert.equal(q.get(`SELECT title FROM kb_docs WHERE id=?`, enabledDoc).title, '核心政策');
  assert.equal(q.get(`SELECT name FROM biz_assets WHERE id=?`, assetId).name, '核心政策');
});

test('员工可撤回自己待启用的文件知识，兼容旧资产关联且不留孤儿记录', async () => {
  const fileId = Number(q.run(`INSERT INTO uploaded_files(user_id,name,stored_name,ext,file_url,extracted_text,tenant_id)
    VALUES(?,?,?,?,?,?,1)`, salesA.id, '员工待审资料.txt', 'pending.txt', 'txt', '/uploads/files/1/pending.txt', '待审正文').lastInsertRowid);
  const docId = Number(q.run(`INSERT INTO kb_docs(category,title,body,enabled,ref_count,file_path,file_name,tenant_id)
    VALUES('品牌资料','员工待审资料','待审正文',0,0,'/uploads/files/1/pending.txt','员工待审资料.txt',1)`).lastInsertRowid);
  const assetId = Number(q.run(`INSERT INTO biz_assets(name,category,value,status,owner,source_type,source_id,creator_id,url,tenant_id)
    VALUES('员工待审资料','知识资产',3000,'使用中','文件中心','uploaded_file',?,?,?,1)`,
  fileId, salesA.id, '/uploads/files/1/pending.txt').lastInsertRowid);

  let archiveId;
  await withServer(salesA, async base => {
    const removed = await call(base, `/sys/kb/${docId}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    archiveId = removed.json.archiveId;
  });
  assert.equal(q.get(`SELECT id FROM kb_docs WHERE id=?`, docId), undefined);
  assert.equal(q.get(`SELECT id FROM biz_assets WHERE id=?`, assetId), undefined);

  await withServer(boss, async base => {
    const restored = await call(base, `/sys/deletions/${archiveId}/restore`, { method: 'POST' });
    assert.equal(restored.status, 200);
  });
  assert.equal(q.get(`SELECT title FROM kb_docs WHERE id=?`, docId).title, '员工待审资料');
  assert.equal(q.get(`SELECT source_type FROM biz_assets WHERE id=?`, assetId).source_type, 'uploaded_file');
});

test('cleanup', () => {
  for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
});
