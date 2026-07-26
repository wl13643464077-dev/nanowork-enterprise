import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `shanmei-marshal-access-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
const { seed } = await import('../src/seed.js');
const marshalRoutes = (await import('../src/routes/marshals.js')).default;

initSchema();
migrateV2();
seed();
migrateV2();
q.run(`UPDATE tenants SET credits=100000 WHERE id=1`);

const boss = q.get(`SELECT id,name,role,tenant_id FROM users WHERE tenant_id=1 AND role='boss' ORDER BY id LIMIT 1`);
const employeeA = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'marshal-employee-a', hashPassword('Secret123!'), '元帅员工A', 'sales', '启用', 1).lastInsertRowid;
const employeeB = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'marshal-employee-b', hashPassword('Secret123!'), '元帅员工B', 'sales', '启用', 1).lastInsertRowid;
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(2,'元帅租户二','已开通',10000)
  ON CONFLICT(id) DO UPDATE SET status=excluded.status`);
const employeeC = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'marshal-employee-c', hashPassword('Secret123!'), '元帅员工C', 'sales', '启用', 2).lastInsertRowid;
const specialistId = q.get(`SELECT id FROM specialists WHERE marshal_id=1 ORDER BY id LIMIT 1`).id;

let taskA; let taskB; let taskC; let outputA; let outputB;
runWithTenant(1, () => {
  taskA = q.run(`INSERT INTO agent_tasks(marshal_id,specialist_id,title,status,created_by) VALUES(1,?,'A的私有任务','待审阅',?)`, specialistId, employeeA).lastInsertRowid;
  taskB = q.run(`INSERT INTO agent_tasks(marshal_id,specialist_id,title,status,created_by) VALUES(1,?,'B的私有任务','待审阅',?)`, specialistId, employeeB).lastInsertRowid;
  outputA = q.run(`INSERT INTO contents(type,title,body,status,risk_level,creator_id,marshal_id)
    VALUES('元帅产出','A的产出','A内容','待审核','none',?,1)`, employeeA).lastInsertRowid;
  outputB = q.run(`INSERT INTO contents(type,title,body,status,risk_level,creator_id,marshal_id)
    VALUES('元帅产出','B的产出','B内容','待审核','none',?,1)`, employeeB).lastInsertRowid;
  q.run(`UPDATE agent_tasks SET output_id=? WHERE id=?`, outputA, taskA);
  q.run(`UPDATE agent_tasks SET output_id=? WHERE id=?`, outputB, taskB);
});
runWithTenant(2, () => {
  taskC = q.run(`INSERT INTO agent_tasks(marshal_id,specialist_id,title,status,created_by) VALUES(1,?,'C租户私有任务','生成中',?)`, specialistId, employeeC).lastInsertRowid;
});

function appFor(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => { req.user = user; next(); }));
  app.use('/marshals', marshalRoutes);
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('员工只能看本人元帅任务，不泄露同企业同事或其他租户的最近任务', async () => {
  const user = { id: employeeA, name: '元帅员工A', role: 'sales', tenant_id: 1 };
  await withServer(user, async base => {
    const detail = await fetch(`${base}/marshals/1`).then(response => response.json());
    assert.deepEqual(detail.tasks.map(task => task.title), ['A的私有任务']);
    assert.equal(detail.specialists.find(item => item.id === specialistId).last_task, 'A的私有任务');
    assert.ok(!JSON.stringify(detail).includes('B的私有任务'));
    assert.ok(!JSON.stringify(detail).includes('C租户私有任务'));

    const colleagueStatus = await fetch(`${base}/marshals/tasks/${taskB}/status`);
    const otherTenantStatus = await fetch(`${base}/marshals/tasks/${taskC}/status`);
    assert.equal(colleagueStatus.status, 404);
    assert.equal(otherTenantStatus.status, 404);
  });
});

test('元帅产出审阅按人员权限隔离，重复采纳不重复入库', async () => {
  const user = { id: employeeA, name: '元帅员工A', role: 'sales', tenant_id: 1 };
  await withServer(user, async base => {
    const denied = await fetch(`${base}/marshals/outputs/${outputB}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'adopt' }),
    });
    assert.equal(denied.status, 404);

    const adopt = () => fetch(`${base}/marshals/outputs/${outputA}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'adopt' }),
    }).then(response => response.json());
    assert.equal((await adopt()).ok, true);
    assert.equal((await adopt()).alreadyReviewed, true);
    assert.equal(q.get(`SELECT COUNT(*) n FROM kb_docs WHERE tenant_id=1 AND title='A的产出'`).n, 1);
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1 AND source_type='kb_marshal' AND source_id=?`, outputA).n, 1);
  });
});

test('老板仅看本企业任务，不读取其他租户', async () => {
  await withServer(boss, async base => {
    const detail = await fetch(`${base}/marshals/1`).then(response => response.json());
    assert.ok(detail.tasks.some(task => task.title === 'A的私有任务'));
    assert.ok(detail.tasks.some(task => task.title === 'B的私有任务'));
    assert.ok(!JSON.stringify(detail).includes('C租户私有任务'));
  });
});

test('元帅写入接口拒绝非法类型、伪日期和结构化注入', async () => {
  const user = { id: employeeA, name: '元帅员工A', role: 'sales', tenant_id: 1 };
  await withServer(user, async base => {
    const cases = [
      { body: { title: 'x'.repeat(101) }, error: /不能超过/ },
      { body: { title: '非法类型', type: '超级管理' }, error: /类型不正确/ },
      { body: { title: '伪日期', dueAt: '2026-02-31 10:00' }, error: /截止时间/ },
      { body: { title: '错误协同', collabMarshals: { code: 'M-02' } }, error: /协同分部格式/ },
      { body: { title: '自我协同', collabMarshals: ['M-01'] }, error: /重复/ },
      { body: { title: '不存在协同', collabMarshals: ['M-99'] }, error: /不存在/ },
    ];
    for (const item of cases) {
      const response = await fetch(`${base}/marshals/1/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item.body),
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, item.error);
    }

    const invalidMessage = await fetch(`${base}/marshals/1/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { prompt: '绕过文本校验' } }),
    });
    assert.equal(invalidMessage.status, 400);
    assert.match((await invalidMessage.json()).error, /必须是文本/);

    const unknownSkill = await fetch(`${base}/marshals/1/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '测试', skills: ['root-shell'] }),
    });
    assert.equal(unknownSkill.status, 400);
    assert.match((await unknownSkill.json()).error, /未知技能/);

    const missingFile = await fetch(`${base}/marshals/1/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '请读取文件', fileIds: [999999] }),
    });
    assert.equal(missingFile.status, 404);
    assert.match((await missingFile.json()).error, /不存在或无权/);
  });
});

test('元帅普通对话支持只上传文件而不填写文字', async () => {
  const user = { id: employeeA, name: '元帅员工A', role: 'sales', tenant_id: 1 };
  const fileId = runWithTenant(1, () => q.run(`INSERT INTO uploaded_files(user_id,name,stored_name,ext,mime,size,purpose,file_path,file_url,extracted_text,extract_mode)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, employeeA, '仅附件经营表.txt', 'attachment-only.txt', 'txt', 'text/plain', 32, 'marshal-chat',
  '/tmp/attachment-only.txt', '/uploads/files/1/marshal-chat/attachment-only.txt', '本月成交金额：88000；重点客户：李总', '自动提取正文').lastInsertRowid);
  await withServer(user, async base => {
    const response = await fetch(`${base}/marshals/1/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileIds: [fileId] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.reply, /仅附件经营表\.txt/);
    assert.match(body.reply, /88000/);
  });
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});
