import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `shanmei-upload-access-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;
process.env.JWT_SECRET = 'upload-access-test-secret';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { authMiddleware, hashPassword, signToken, SESSION_COOKIE } = await import('../src/util.js');
const { uploadAccessGuard } = await import('../src/engines/upload-access.js');

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,plan,credits) VALUES(2,'隔离测试企业','已开通','标准版',0)`);

const addUser = (username, role, tenantId, managerId = null) => q.run(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id,manager_id) VALUES(?,?,?,?, '启用', ?,?)`,
  username, hashPassword('TestPass123!'), username, role, tenantId, managerId,
).lastInsertRowid;
const opsAId = addUser('ops_a', 'ops_director', 1);
const opsBId = addUser('ops_b', 'ops_director', 1);
const managerId = addUser('upload_manager', 'manager', 1, opsAId);
const ownerId = addUser('upload_owner', 'sales', 1, managerId);
const peerId = addUser('upload_peer', 'sales', 1, opsBId);
const bossId = addUser('upload_boss', 'boss', 1);
const otherBossId = addUser('other_boss', 'boss', 2);
const fileUrl = '/uploads/files/1/private.txt';
q.run(`INSERT INTO uploaded_files(user_id,name,stored_name,ext,size,purpose,file_path,file_url,tenant_id)
  VALUES(?,?,?,?,?,?,?,?,?)`, ownerId, 'private.txt', 'private.txt', 'txt', 8, 'test', '/tmp/private.txt', fileUrl, 1);
const archivedUrl = '/uploads/artifacts/1/archived.pdf';
q.run(`INSERT INTO generated_artifacts(user_id,title,format,file_url,file_name,tenant_id) VALUES(?,?,?,?,?,?)`,
  ownerId, '已入档报告', 'pdf', archivedUrl, 'archived.pdf', 1);
q.run(`INSERT INTO kb_docs(category,title,body,enabled,file_path,visible_roles,tenant_id) VALUES(?,?,?,?,?,?,?)`,
  '元帅产出', '已入档报告', '团队可检索内容', 1, archivedUrl, JSON.stringify(['sales']), 1);
const malformedAclUrl = '/uploads/kb/1/malformed.pdf';
q.run(`INSERT INTO kb_docs(category,title,body,enabled,file_path,visible_roles,tenant_id) VALUES(?,?,?,?,?,?,?)`,
  '品牌资料', '损坏权限样本', '不可失败放行', 1, malformedAclUrl, '{bad-json', 1);
const taskAttachmentUrl = '/uploads/tasks/1/report_01.pdf';
const taskId = q.run(`INSERT INTO tasks(title,assignee_id,status,tenant_id) VALUES(?,?,?,?)`, '附件权限任务', ownerId, '待审核', 1).lastInsertRowid;
q.run(`INSERT INTO task_submissions(task_id,user_id,content,tenant_id) VALUES(?,?,?,?)`, taskId, ownerId,
  JSON.stringify({ kind: 'task_submit_v2', attachments: [{ name: 'report.pdf', url: taskAttachmentUrl }] }), 1);

const tokenFor = (id, role, tenantId) => signToken({ id, username: `u${id}`, name: `u${id}`, role, tenant_id: tenantId });

async function withServer(fn) {
  const app = express();
  app.use('/uploads', authMiddleware, (req, _res, next) => runWithTenant(req.user.tenant_id, () => next()), uploadAccessGuard, (_req, res) => res.send('ok'));
  const server = app.listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('附件访问：未登录拒绝、本人和本企业管理层可读、同级与跨租户均隐藏', async () => {
  await withServer(async base => {
    assert.equal((await fetch(base + fileUrl)).status, 401);
    assert.equal((await fetch(base + fileUrl, { headers: { Cookie: `${SESSION_COOKIE}=${tokenFor(ownerId, 'sales', 1)}` } })).status, 200);
    assert.equal((await fetch(base + fileUrl, { headers: { Authorization: `Bearer ${tokenFor(peerId, 'sales', 1)}` } })).status, 404);
    assert.equal((await fetch(base + fileUrl, { headers: { Authorization: `Bearer ${tokenFor(managerId, 'manager', 1)}` } })).status, 200);
    assert.equal((await fetch(base + fileUrl, { headers: { Authorization: `Bearer ${tokenFor(opsAId, 'ops_director', 1)}` } })).status, 200);
    assert.equal((await fetch(base + fileUrl, { headers: { Authorization: `Bearer ${tokenFor(opsBId, 'ops_director', 1)}` } })).status, 404);
    assert.equal((await fetch(base + fileUrl, { headers: { Authorization: `Bearer ${tokenFor(bossId, 'boss', 1)}` } })).status, 200);
    assert.equal((await fetch(base + fileUrl, { headers: { Authorization: `Bearer ${tokenFor(otherBossId, 'boss', 2)}` } })).status, 404);
    assert.equal((await fetch(`${base}/uploads/files/1/missing.txt`, { headers: { Authorization: `Bearer ${tokenFor(bossId, 'boss', 1)}` } })).status, 404);
    const legacySkill = '/uploads/skills/PPT_1710000000000.pptx';
    assert.equal((await fetch(base + legacySkill, { headers: { Authorization: `Bearer ${tokenFor(ownerId, 'sales', 1)}` } })).status, 404);
    assert.equal((await fetch(base + legacySkill, { headers: { Authorization: `Bearer ${tokenFor(otherBossId, 'boss', 2)}` } })).status, 404);
    assert.equal((await fetch(`${base}/uploads/skills/1/new.pptx`, { headers: { Authorization: `Bearer ${tokenFor(bossId, 'boss', 1)}` } })).status, 404);
    assert.equal((await fetch(base + archivedUrl, { headers: { Authorization: `Bearer ${tokenFor(peerId, 'sales', 1)}` } })).status, 200);
    assert.equal((await fetch(base + archivedUrl, { headers: { Authorization: `Bearer ${tokenFor(otherBossId, 'boss', 2)}` } })).status, 404);
    assert.equal((await fetch(base + malformedAclUrl, { headers: { Authorization: `Bearer ${tokenFor(peerId, 'sales', 1)}` } })).status, 404);
    assert.equal((await fetch(base + malformedAclUrl, { headers: { Authorization: `Bearer ${tokenFor(bossId, 'boss', 1)}` } })).status, 200);
    assert.equal((await fetch(base + taskAttachmentUrl, { headers: { Authorization: `Bearer ${tokenFor(managerId, 'manager', 1)}` } })).status, 200);
    assert.equal((await fetch(base + taskAttachmentUrl, { headers: { Authorization: `Bearer ${tokenFor(peerId, 'sales', 1)}` } })).status, 404);
    assert.equal((await fetch(`${base}/uploads/tasks/1/reportX01.pdf`, { headers: { Authorization: `Bearer ${tokenFor(managerId, 'manager', 1)}` } })).status, 404);
  });
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});
