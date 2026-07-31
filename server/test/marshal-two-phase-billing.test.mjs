import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-marshal-two-phase-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = 'sk-local-marshal-two-phase-test';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const {
  db,
  qRaw,
  initSchema,
  migrateV2,
  runWithTenant,
  setConfig,
} = await import('../src/db.js');
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const { balanceOfTenant } = await import('../src/engines/credits.js');
const marshalRoutes = (await import('../src/routes/marshals.js')).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

const tenantId = Number(qRaw.run(
  "INSERT INTO tenants(name,status,credits) VALUES('员工两阶段计费企业','已开通',5000)",
).lastInsertRowid);
const userId = Number(qRaw.run(
  `INSERT INTO users(username,password_hash,name,role,tenant_id)
   VALUES('marshal-two-phase-u','x','员工计费用户','boss',?)`,
  tenantId,
).lastInsertRowid);
const user = { id: userId, name: '员工计费用户', role: 'boss', tenant_id: tenantId };
const department = db.prepare("SELECT id FROM marshals WHERE code='M-01'").get();
assert.ok(department?.id);

const heldAtProvider = [];
const providerApp = express();
providerApp.use(express.json({ limit: '20mb' }));
providerApp.post('/v1/embeddings', (_req, res) => {
  res.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
});
providerApp.post('/v1/chat/completions', (req, res) => {
  heldAtProvider.push(db.prepare(
    `SELECT COUNT(*) n FROM credit_holds WHERE tenant_id=? AND status='held'`,
  ).get(tenantId).n);
  const prompt = JSON.stringify(req.body?.messages || []);
  const text = prompt.includes('强制员工对话落库失败')
    ? '强制员工对话落库失败'
    : prompt.includes('强制员工任务落库失败')
      ? '强制员工任务落库失败'
      : prompt.includes('强制技能制品落库失败')
        ? '# 强制技能制品落库失败\n\n正文'
        : '已依据当前岗位要求生成完整、可复核的员工交付。';
  res.json({
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 220, completion_tokens: 80 },
  });
});
const providerServer = providerApp.listen(0, '127.0.0.1');
const providerPort = await new Promise(resolve => {
  providerServer.once('listening', () => resolve(providerServer.address().port));
});
setConfig('yunwu_base_url', `http://127.0.0.1:${providerPort}/v1`);

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use((req, _res, next) => runWithTenant(tenantId, () => {
  req.user = user;
  next();
}));
app.use('/marshals', marshalRoutes);
const server = app.listen(0, '127.0.0.1');
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

async function post(route, payload) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { response, payload: await response.json() };
}

const heldRows = () => db.prepare(
  `SELECT * FROM credit_holds WHERE tenant_id=? AND status='held' ORDER BY id`,
).all(tenantId);

test('员工对话在供应商调用前预授权，助手消息、风控、引用和摘要落库后结算', async () => {
  const before = balanceOfTenant(tenantId);
  const result = await post(`/marshals/${department.id}/chat`, {
    message: '请给出今天可执行的门店动作',
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.billing.state, 'settled');
  assert.ok(result.payload.billing.chargedCredits > 0);
  assert.ok(result.payload.assistantMessageId);
  assert.equal(
    db.prepare(
      `SELECT COUNT(*) n FROM marshal_chat_msgs
       WHERE tenant_id=? AND id=? AND role='assistant'`,
    ).get(tenantId, result.payload.assistantMessageId).n,
    1,
  );
  assert.ok(heldAtProvider.at(-1) > 0, '供应商调用发生时必须已存在预授权');
  assert.equal(heldRows().length, 0);
  assert.equal(balanceOfTenant(tenantId), before - result.payload.billing.chargedCredits);
});

test('员工对话助手消息落库失败时释放预授权，SSE 不提前泄露模型正文', async () => {
  const before = balanceOfTenant(tenantId);
  db.exec(`CREATE TRIGGER injected_marshal_chat_persist_failure
    BEFORE INSERT ON marshal_chat_msgs
    WHEN NEW.role='assistant' AND NEW.content='强制员工对话落库失败'
    BEGIN
      SELECT RAISE(ABORT,'injected marshal chat persistence failure');
    END`);
  try {
    const response = await fetch(`${base}/marshals/${department.id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '强制员工对话落库失败', stream: true }),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(body, /"delta":"强制员工对话落库失败"/);
    assert.match(body, /"state":"released"/);
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) n FROM marshal_chat_msgs
         WHERE tenant_id=? AND role='assistant' AND content='强制员工对话落库失败'`,
      ).get(tenantId).n,
      0,
    );
    assert.equal(balanceOfTenant(tenantId), before);
    assert.equal(heldRows().length, 0);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_marshal_chat_persist_failure');
  }
});

test('异步员工任务产出落库失败时释放预授权并标记任务失败', async () => {
  const before = balanceOfTenant(tenantId);
  db.exec(`CREATE TRIGGER injected_marshal_task_persist_failure
    BEFORE INSERT ON contents
    WHEN NEW.body='强制员工任务落库失败'
    BEGIN
      SELECT RAISE(ABORT,'injected marshal task persistence failure');
    END`);
  try {
    const dispatched = await post(`/marshals/${department.id}/tasks`, {
      title: '强制员工任务落库失败',
      type: '常规',
      requirement: '强制员工任务落库失败',
    });
    assert.equal(dispatched.response.status, 200, JSON.stringify(dispatched.payload));
    const taskId = dispatched.payload.taskId;
    const linkedHold = db.prepare(
      `SELECT id,ref_type,ref_id FROM credit_holds
       WHERE tenant_id=? AND ref_type='agent_task' AND ref_id=?
       ORDER BY id DESC LIMIT 1`,
    ).get(tenantId, taskId);
    assert.ok(linkedHold?.id, '异步任务返回前必须把预授权关联到 agent_task，供崩溃恢复使用');
    let task = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      task = db.prepare(
        'SELECT status,output_id FROM agent_tasks WHERE tenant_id=? AND id=?',
      ).get(tenantId, taskId);
      if (task?.status !== '生成中') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(task?.status, '失败');
    assert.equal(task?.output_id, null);
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) n FROM contents
         WHERE tenant_id=? AND body='强制员工任务落库失败'`,
      ).get(tenantId).n,
      0,
    );
    assert.equal(balanceOfTenant(tenantId), before);
    assert.equal(heldRows().length, 0);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_marshal_task_persist_failure');
  }
});

test('技能文件制品记录落库失败时删除文件并释放预授权', async () => {
  const before = balanceOfTenant(tenantId);
  db.exec(`CREATE TRIGGER injected_marshal_artifact_persist_failure
    BEFORE INSERT ON generated_artifacts
    WHEN NEW.title='强制技能制品落库失败'
    BEGIN
      SELECT RAISE(ABORT,'injected marshal artifact persistence failure');
    END`);
  try {
    const result = await post(`/marshals/${department.id}/skill-file`, {
      message: '强制技能制品落库失败',
      format: 'docx',
    });
    assert.equal(result.response.status, 500);
    assert.equal(result.payload.billing.state, 'released');
    assert.equal(result.payload.billing.chargedCredits, 0);
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) n FROM generated_artifacts
         WHERE tenant_id=? AND title='强制技能制品落库失败'`,
      ).get(tenantId).n,
      0,
    );
    assert.equal(balanceOfTenant(tenantId), before);
    assert.equal(heldRows().length, 0);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_marshal_artifact_persist_failure');
  }
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => providerServer.close(resolve));
  delete process.env.YUNWU_API_KEY;
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
  }
});
