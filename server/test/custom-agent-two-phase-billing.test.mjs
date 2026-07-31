import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-custom-agent-two-phase-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = 'sk-local-custom-agent-test';
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
const { balanceOfTenant } = await import('../src/engines/credits.js');
const agentRoutes = (await import('../src/routes/agents.js')).default;

initSchema();
migrateV2();

const tenantId = Number(qRaw.run(
  "INSERT INTO tenants(name,status,credits) VALUES('自定义智能体计费企业','已开通',500)",
).lastInsertRowid);
const userId = Number(qRaw.run(
  `INSERT INTO users(username,password_hash,name,role,tenant_id)
   VALUES('custom-agent-two-phase-u','x','智能体计费用户','boss',?)`,
  tenantId,
).lastInsertRowid);
const agentId = Number(qRaw.run(
  `INSERT INTO custom_agents(name,tier,prompt,skills,creator_id,tenant_id)
   VALUES('完整岗位智能体','expert','只依据真实业务资料回答','[]',?,?)`,
  userId,
  tenantId,
).lastInsertRowid);
const user = { id: userId, name: '智能体计费用户', role: 'boss', tenant_id: tenantId };

const providerApp = express();
providerApp.use(express.json({ limit: '2mb' }));
providerApp.post('/v1/chat/completions', (req, res) => {
  const userText = JSON.stringify(req.body?.messages || []);
  const reply = userText.includes('强制助手消息落库失败')
    ? '强制助手消息落库失败'
    : '已根据岗位提示词给出可执行建议，并标明待负责人确认事项。';
  res.json({
    choices: [{ message: { content: reply } }],
    usage: { prompt_tokens: 180, completion_tokens: 70 },
  });
});
const providerServer = providerApp.listen(0, '127.0.0.1');
const providerPort = await new Promise(resolve => {
  providerServer.once('listening', () => resolve(providerServer.address().port));
});
setConfig('yunwu_base_url', `http://127.0.0.1:${providerPort}/v1`);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, _res, next) => runWithTenant(tenantId, () => {
  req.user = user;
  next();
}));
app.use('/agents', agentRoutes);
const server = app.listen(0, '127.0.0.1');
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

async function chat(message) {
  const response = await fetch(`${base}/agents/${agentId}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  return { response, payload: await response.json() };
}

const heldRows = () => db.prepare(
  `SELECT * FROM credit_holds WHERE tenant_id=? AND status='held' ORDER BY id`,
).all(tenantId);

test('自定义智能体先预授权，助手消息与风控结果落库后才结算', async () => {
  const before = balanceOfTenant(tenantId);
  const result = await chat('给我一份今天可执行的门店动作');

  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.mode, 'api');
  assert.equal(result.payload.billing.state, 'settled');
  assert.ok(result.payload.billing.chargedCredits > 0);
  assert.ok(result.payload.assistantMessageId);
  assert.equal(
    db.prepare(
      `SELECT COUNT(*) n FROM custom_agent_chat_msgs
       WHERE tenant_id=? AND id=? AND role='assistant'`,
    ).get(tenantId, result.payload.assistantMessageId).n,
    1,
  );
  assert.equal(heldRows().length, 0);
  assert.equal(balanceOfTenant(tenantId), before - result.payload.billing.chargedCredits);
});

test('自定义智能体助手消息落库失败时释放预授权，不产生收费半成品', async () => {
  const before = balanceOfTenant(tenantId);
  db.exec(`CREATE TRIGGER injected_custom_agent_assistant_failure
    BEFORE INSERT ON custom_agent_chat_msgs
    WHEN NEW.role='assistant' AND NEW.content='强制助手消息落库失败'
    BEGIN
      SELECT RAISE(ABORT,'injected custom agent assistant persistence failure');
    END`);
  try {
    const failed = await chat('强制助手消息落库失败');
    assert.equal(failed.response.status, 500);
    assert.equal(failed.payload.billing.state, 'released');
    assert.equal(failed.payload.billing.chargedCredits, 0);
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) n FROM custom_agent_chat_msgs
         WHERE tenant_id=? AND role='assistant' AND content='强制助手消息落库失败'`,
      ).get(tenantId).n,
      0,
    );
    assert.equal(balanceOfTenant(tenantId), before);
    assert.equal(heldRows().length, 0);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_custom_agent_assistant_failure');
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
