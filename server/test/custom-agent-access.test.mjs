import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `shanmei-custom-agent-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
const agentRoutes = (await import('../src/routes/agents.js')).default;

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status) VALUES(2,'智能体租户二','已开通')
  ON CONFLICT(id) DO UPDATE SET status=excluded.status`);
const boss = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'agent-boss', hashPassword('Secret123!'), '智能体老板', 'boss', '启用', 1).lastInsertRowid;
const employeeA = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'agent-a', hashPassword('Secret123!'), '智能体员工A', 'sales', '启用', 1).lastInsertRowid;
const employeeB = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'agent-b', hashPassword('Secret123!'), '智能体员工B', 'sales', '启用', 1).lastInsertRowid;
const employeeC = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'agent-c', hashPassword('Secret123!'), '智能体员工C', 'sales', '启用', 2).lastInsertRowid;

let agentA; let agentB; let agentC;
runWithTenant(1, () => {
  agentA = q.run(`INSERT INTO custom_agents(name,tier,prompt,skills,creator_id) VALUES('员工A智能体','simple','A提示词','[]',?)`, employeeA).lastInsertRowid;
  agentB = q.run(`INSERT INTO custom_agents(name,tier,prompt,skills,creator_id) VALUES('员工B智能体','simple','B提示词','[]',?)`, employeeB).lastInsertRowid;
});
runWithTenant(2, () => {
  agentC = q.run(`INSERT INTO custom_agents(name,tier,prompt,skills,creator_id) VALUES('租户二智能体','simple','C提示词','[]',?)`, employeeC).lastInsertRowid;
});

function appFor(user) {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => { req.user = user; next(); }));
  app.use('/agents', agentRoutes);
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function jsonRequest(base, url, method = 'GET', body) {
  const response = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json().catch(() => ({})) };
}

test('员工不能读取、编辑或删除同事的自定义智能体', async () => {
  const user = { id: employeeA, name: '智能体员工A', role: 'sales', tenant_id: 1 };
  await withServer(user, async base => {
    const list = await jsonRequest(base, '/agents');
    assert.deepEqual(list.body.map(item => item.id), [agentA]);

    const update = await jsonRequest(base, `/agents/${agentB}`, 'PUT', { name: '越权修改' });
    const remove = await jsonRequest(base, `/agents/${agentB}`, 'DELETE');
    const chats = await jsonRequest(base, `/agents/${agentB}/chats`);
    assert.equal(update.response.status, 404);
    assert.equal(remove.response.status, 404);
    assert.equal(chats.response.status, 404);
    assert.equal(q.get(`SELECT name FROM custom_agents WHERE tenant_id=1 AND id=?`, agentB).name, '员工B智能体');
  });
});

test('老板可管理本企业智能体，但不可见其他租户', async () => {
  const user = { id: boss, name: '智能体老板', role: 'boss', tenant_id: 1 };
  await withServer(user, async base => {
    const list = await jsonRequest(base, '/agents');
    assert.deepEqual(new Set(list.body.map(item => item.id)), new Set([agentA, agentB]));
    assert.ok(!JSON.stringify(list.body).includes('租户二智能体'));
    const update = await jsonRequest(base, `/agents/${agentB}`, 'PUT', { name: '老板已审核' });
    assert.equal(update.response.status, 200);
    assert.equal(q.get(`SELECT name FROM custom_agents WHERE tenant_id=1 AND id=?`, agentB).name, '老板已审核');
  });
});

test('自定义智能体接口拒绝未知档位、未知技能和结构化消息', async () => {
  const user = { id: employeeA, name: '智能体员工A', role: 'sales', tenant_id: 1 };
  await withServer(user, async base => {
    const invalidTier = await jsonRequest(base, '/agents', 'POST', { name: '错误档位', prompt: '测试', tier: 'root' });
    const unknownSkill = await jsonRequest(base, '/agents', 'POST', { name: '错误技能', prompt: '测试', tier: 'normal', skills: ['shell-root'] });
    const invalidMessage = await jsonRequest(base, `/agents/${agentA}/chat`, 'POST', { message: { prompt: '绕过校验' } });
    assert.equal(invalidTier.response.status, 400);
    assert.equal(unknownSkill.response.status, 400);
    assert.equal(invalidMessage.response.status, 400);
    assert.match(invalidMessage.body.error, /必须是文本/);
  });
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});
