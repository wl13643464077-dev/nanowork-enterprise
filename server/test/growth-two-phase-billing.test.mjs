import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-growth-two-phase-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = 'sk-local-growth-two-phase-test';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_DEMO = 'false';

const {
  db,
  qRaw,
  initSchema,
  migrateV2,
  runWithTenant,
  setConfig,
} = await import('../src/db.js');
const { balanceOfTenant } = await import('../src/engines/credits.js');
const growthRoutes = (await import('../src/routes/growth.js')).default;

initSchema();
migrateV2();

const tenantId = Number(qRaw.run(
  "INSERT INTO tenants(name,status,credits) VALUES('增长两阶段计费企业','已开通',500)",
).lastInsertRowid);
const userId = Number(qRaw.run(
  `INSERT INTO users(username,password_hash,name,role,tenant_id)
   VALUES('growth-two-phase-u','x','增长计费用户','boss',?)`,
  tenantId,
).lastInsertRowid);
const leadId = Number(qRaw.run(
  `INSERT INTO leads(name,source,identity_tag,budget_level,stage,owner_id,tenant_id)
   VALUES('两阶段顾客','到店','普通消费者','中','已沟通',?,?)`,
  userId,
  tenantId,
).lastInsertRowid);
const user = { id: userId, name: '增长计费用户', role: 'boss', tenant_id: tenantId };

let providerCalls = 0;
const providerApp = express();
providerApp.use(express.json());
providerApp.post('/v1/chat/completions', (_req, res) => {
  providerCalls += 1;
  res.json({
    choices: [{ message: { content: '1. 已核实信息后回复顾客。\\n2. 请负责人确认。\\n3. 尊重顾客选择。' } }],
    usage: { prompt_tokens: 120, completion_tokens: 80 },
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
app.use('/growth', growthRoutes);
const server = app.listen(0, '127.0.0.1');
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

async function post(route, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

const heldRows = () => db.prepare(
  `SELECT * FROM credit_holds WHERE tenant_id=? AND status='held' ORDER BY id`,
).all(tenantId);

test('增长话术在调用供应商前预授权，成功交付后按真实用量结算', async () => {
  const before = balanceOfTenant(tenantId);
  const result = await post('/growth/suggest-reply', {
    leadId,
    context: '顾客想确认本周到店安排',
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.mode, 'api');
  assert.equal(result.payload.billing.state, 'settled');
  assert.ok(result.payload.billing.estimatedCredits > result.payload.billing.chargedCredits);
  assert.ok(result.payload.billing.chargedCredits > 0);
  assert.equal(heldRows().length, 0);
  assert.equal(
    balanceOfTenant(tenantId),
    before - result.payload.billing.chargedCredits,
  );
  assert.equal(providerCalls, 1);
});

test('增长话术落库失败时全额释放预授权，不收费也不留下半成品', async () => {
  const context = '强制增长话术落库失败';
  const before = balanceOfTenant(tenantId);
  db.exec(`CREATE TRIGGER injected_growth_suggestion_failure
    BEFORE INSERT ON lead_ai_suggestions
    WHEN NEW.context='${context}'
    BEGIN
      SELECT RAISE(ABORT,'injected growth suggestion persistence failure');
    END`);
  try {
    const failed = await post('/growth/suggest-reply', { leadId, context });
    assert.equal(failed.response.status, 500);
    assert.equal(failed.payload.billing.state, 'released');
    assert.equal(failed.payload.billing.chargedCredits, 0);
    assert.equal(
      db.prepare(
        'SELECT COUNT(*) n FROM lead_ai_suggestions WHERE tenant_id=? AND context=?',
      ).get(tenantId, context).n,
      0,
    );
    assert.equal(balanceOfTenant(tenantId), before);
    assert.equal(heldRows().length, 0);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_growth_suggestion_failure');
  }
});

test('增长异议处理成功后才更新顾客档案并完成两阶段结算', async () => {
  const before = balanceOfTenant(tenantId);
  const result = await post(`/growth/leads/${leadId}/objection`, {
    text: '价格和可预约时间需要确认',
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.billing.state, 'settled');
  assert.ok(result.payload.billing.chargedCredits > 0);
  assert.equal(heldRows().length, 0);
  assert.equal(balanceOfTenant(tenantId), before - result.payload.billing.chargedCredits);
  const concerns = JSON.parse(
    db.prepare('SELECT concerns FROM leads WHERE tenant_id=? AND id=?').get(tenantId, leadId).concerns,
  );
  assert.ok(concerns.some(item => item.text === '价格和可预约时间需要确认'));
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
