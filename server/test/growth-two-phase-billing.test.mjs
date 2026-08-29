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
const sameTenantEmployeeId = Number(qRaw.run(
  `INSERT INTO users(username,password_hash,name,role,tenant_id)
   VALUES('growth-two-phase-other','x','同企业其他员工','sales',?)`,
  tenantId,
).lastInsertRowid);
const leadId = Number(qRaw.run(
  `INSERT INTO leads(name,source,identity_tag,budget_level,stage,owner_id,tenant_id)
   VALUES('两阶段顾客','到店','普通消费者','中','已沟通',?,?)`,
  userId,
  tenantId,
).lastInsertRowid);
const user = { id: userId, name: '增长计费用户', role: 'boss', tenant_id: tenantId };
const sameTenantEmployee = {
  id: sameTenantEmployeeId,
  name: '同企业其他员工',
  role: 'sales',
  tenant_id: tenantId,
};
const otherTenantId = Number(qRaw.run(
  "INSERT INTO tenants(name,status,credits) VALUES('增长隔离企业','已开通',500)",
).lastInsertRowid);
const otherTenantBossId = Number(qRaw.run(
  `INSERT INTO users(username,password_hash,name,role,tenant_id)
   VALUES('growth-two-phase-cross','x','跨企业老板','boss',?)`,
  otherTenantId,
).lastInsertRowid);
const otherTenantBoss = {
  id: otherTenantBossId,
  name: '跨企业老板',
  role: 'boss',
  tenant_id: otherTenantId,
};
const actors = { primary: user, sameTenantEmployee, otherTenantBoss };
const REQUEST_ID = 'growth-two-phase-request';

let providerCalls = 0;
const providerApp = express();
providerApp.use(express.json());
providerApp.post('/v1/chat/completions', (req, res) => {
  providerCalls += 1;
  const messages = JSON.stringify(req.body?.messages || []);
  if (messages.includes('强制增长上游失败')) {
    return res.status(500).json({ error: { message: 'injected growth provider failure' } });
  }
  if (messages.includes('强制增长零token')) {
    return res.json({
      choices: [{ message: { content: '这段话术虽然有正文，但没有可验证的输入或输出token，不能交付。' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    });
  }
  if (messages.includes('强制增长零输入token')) {
    return res.json({
      choices: [{ message: { content: '只有输出token、没有输入token的响应也不能交付。' } }],
      usage: { prompt_tokens: 0, completion_tokens: 80 },
    });
  }
  if (messages.includes('强制增长零输出token')) {
    return res.json({
      choices: [{ message: { content: '只有输入token、没有输出token的响应也不能交付。' } }],
      usage: { prompt_tokens: 120, completion_tokens: 0 },
    });
  }
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
app.use((req, _res, next) => {
  const actor = actors[String(req.headers['x-test-actor'] || 'primary')] || user;
  return runWithTenant(actor.tenant_id, () => {
    req.user = actor;
    req.requestId = REQUEST_ID;
    next();
  });
});
app.use('/growth', growthRoutes);
const server = app.listen(0, '127.0.0.1');
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

async function post(route, body, actor = 'primary') {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-actor': actor },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

async function get(route, actor = 'primary') {
  const response = await fetch(`${base}${route}`, {
    headers: { 'x-test-actor': actor },
  });
  return { response, payload: await response.json() };
}

const heldRows = () => db.prepare(
  `SELECT * FROM credit_holds WHERE tenant_id=? AND status='held' ORDER BY id`,
).all(tenantId);

const latestGrowthLog = feature => db.prepare(
  `SELECT ai_mode,credits,note FROM credit_logs
   WHERE tenant_id=? AND feature=? ORDER BY id DESC LIMIT 1`,
).get(tenantId, feature);

test('增长话术在调用供应商前预授权，成功交付后按真实用量结算', async () => {
  const before = balanceOfTenant(tenantId);
  const result = await post('/growth/suggest-reply', {
    leadId,
    context: '顾客想确认本周到店安排',
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.mode, 'api');
  assert.equal(result.payload.aiStatus, 'succeeded');
  assert.equal(result.payload.deliveryState, 'succeeded');
  assert.equal(result.payload.retryable, false);
  assert.ok(result.payload.model);
  assert.deepEqual(result.payload.usage, { inputTokens: 120, outputTokens: 80 });
  assert.equal(result.payload.billing.state, 'settled');
  assert.ok(result.payload.billing.estimatedCredits > result.payload.billing.chargedCredits);
  assert.ok(result.payload.billing.chargedCredits > 0);
  assert.equal(heldRows().length, 0);
  assert.equal(
    balanceOfTenant(tenantId),
    before - result.payload.billing.chargedCredits,
  );
  assert.equal(providerCalls, 1);
  const suggestion = db.prepare(`SELECT id FROM lead_ai_suggestions
    WHERE tenant_id=? AND lead_id=? ORDER BY id DESC LIMIT 1`).get(tenantId, leadId);
  const linkedHold = db.prepare(`SELECT ref_type,ref_id FROM credit_holds
    WHERE tenant_id=? AND feature='增长中心·私域话术' ORDER BY id DESC LIMIT 1`).get(tenantId);
  assert.deepEqual({ ...linkedHold }, { ref_type: 'lead_ai_suggestion', ref_id: suggestion.id });
});

test('只提交跟进内容时省略可选计划字段也能持久化，不把 undefined 传给 SQLite', async () => {
  const result = await post(`/growth/leads/${leadId}/follow`, {
    content: '已向顾客发送经人工确认的话术，等待对方回复。',
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  const follow = db.prepare(
    'SELECT content FROM follow_ups WHERE tenant_id=? AND lead_id=? ORDER BY id DESC LIMIT 1',
  ).get(tenantId, leadId);
  assert.equal(follow.content, '已向顾客发送经人工确认的话术，等待对方回复。');
  const lead = db.prepare(
    'SELECT next_follow_at,next_action FROM leads WHERE tenant_id=? AND id=?',
  ).get(tenantId, leadId);
  assert.equal(lead.next_follow_at, null);
  assert.equal(lead.next_action, null);
});

test('增长话术上游失败后的本地模板不得落库，预授权全额退回并明确可重试', async () => {
  const context = '强制增长上游失败';
  const before = balanceOfTenant(tenantId);
  const suggestionsBefore = db.prepare(
    'SELECT COUNT(*) n FROM lead_ai_suggestions WHERE tenant_id=? AND lead_id=?',
  ).get(tenantId, leadId).n;

  const failed = await post('/growth/suggest-reply', { leadId, context });
  assert.equal(failed.response.status, 502, JSON.stringify(failed.payload));
  assert.equal(failed.payload.code, 'AI_REAL_OUTPUT_REQUIRED');
  assert.equal(failed.payload.aiStatus, 'failed');
  assert.equal(failed.payload.deliveryState, 'failed');
  assert.equal(failed.payload.failurePhase, 'generate');
  assert.equal(failed.payload.retryable, true);
  assert.match(failed.payload.retryHint, /原任务重试|上游状态/);
  assert.equal(failed.payload.requestId, REQUEST_ID);
  assert.equal(failed.payload.ai.mode, 'template');
  assert.ok(failed.payload.ai.violations.includes('mode_not_api'));
  assert.ok(failed.payload.ai.violations.includes('usage_missing'));
  assert.deepEqual(failed.payload.ai.usage, { inputTokens: 0, outputTokens: 0 });
  assert.equal(failed.payload.billing.state, 'released');
  assert.equal(failed.payload.billing.chargedCredits, 0);
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM lead_ai_suggestions WHERE tenant_id=? AND lead_id=?')
      .get(tenantId, leadId).n,
    suggestionsBefore,
  );
  assert.equal(balanceOfTenant(tenantId), before);
  assert.equal(heldRows().length, 0);
  const log = latestGrowthLog('增长中心·私域话术');
  assert.equal(log.ai_mode, 'failed');
  assert.equal(log.credits, 0);
  assert.match(log.note, /阶段=generate/);
  assert.match(log.note, /错误码=AI_REAL_OUTPUT_REQUIRED/);
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
    assert.equal(failed.payload.deliveryState, 'failed');
    assert.equal(failed.payload.failurePhase, 'persist');
    assert.equal(failed.payload.retryable, true);
    assert.equal(failed.payload.requestId, REQUEST_ID);
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
    const log = latestGrowthLog('增长中心·私域话术');
    assert.equal(log.ai_mode, 'failed');
    assert.match(log.note, /阶段=persist/);
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
  assert.equal(result.payload.mode, 'api');
  assert.equal(result.payload.aiStatus, 'succeeded');
  assert.equal(result.payload.deliveryState, 'succeeded');
  assert.ok(Number.isSafeInteger(Number(result.payload.suggestionId)));
  assert.equal(Number(result.payload.objection.suggestionId), Number(result.payload.suggestionId));
  assert.ok(result.payload.model);
  assert.deepEqual(result.payload.usage, { inputTokens: 120, outputTokens: 80 });
  assert.equal(result.payload.billing.state, 'settled');
  assert.ok(result.payload.billing.chargedCredits > 0);
  assert.equal(heldRows().length, 0);
  assert.equal(balanceOfTenant(tenantId), before - result.payload.billing.chargedCredits);
  const concerns = JSON.parse(
    db.prepare('SELECT concerns FROM leads WHERE tenant_id=? AND id=?').get(tenantId, leadId).concerns,
  );
  const savedConcern = concerns.find(item => item.text === '价格和可预约时间需要确认');
  assert.equal(Number(savedConcern.suggestionId), Number(result.payload.suggestionId));
  assert.equal(Object.hasOwn(savedConcern, 'suggestion'), false, '话术正文只保存一份，concerns仅保存安全引用');
  const savedSuggestion = db.prepare(
    `SELECT id,lead_id,user_id,context,suggestion,purpose FROM lead_ai_suggestions
     WHERE tenant_id=? AND id=?`,
  ).get(tenantId, result.payload.suggestionId);
  assert.deepEqual({ ...savedSuggestion }, {
    id: Number(result.payload.suggestionId),
    lead_id: leadId,
    user_id: userId,
    context: '价格和可预约时间需要确认',
    suggestion: result.payload.suggestion,
    purpose: '异议处理',
  });
  const linkedHold = db.prepare(`SELECT ref_type,ref_id FROM credit_holds
    WHERE tenant_id=? AND feature='增长中心·异议处理' ORDER BY id DESC LIMIT 1`).get(tenantId);
  assert.deepEqual({ ...linkedHold }, {
    ref_type: 'lead_ai_suggestion',
    ref_id: Number(result.payload.suggestionId),
  });
});

test('异议话术只允许有权账号按本租户顾客回读', async () => {
  const allowed = await get(`/growth/leads/${leadId}/objections`);
  assert.equal(allowed.response.status, 200, JSON.stringify(allowed.payload));
  assert.match(allowed.response.headers.get('cache-control') || '', /private/u);
  const item = allowed.payload.objections.find(row => row.text === '价格和可预约时间需要确认');
  assert.ok(item);
  assert.ok(item.suggestion);
  assert.ok(Number(item.suggestionId) > 0);

  const sameTenantDenied = await get(`/growth/leads/${leadId}/objections`, 'sameTenantEmployee');
  assert.equal(sameTenantDenied.response.status, 404);
  assert.equal(sameTenantDenied.payload.error, '客户不存在或无权访问');

  const crossTenantDenied = await get(`/growth/leads/${leadId}/objections`, 'otherTenantBoss');
  assert.equal(crossTenantDenied.response.status, 404);
  assert.equal(crossTenantDenied.payload.error, '客户不存在或无权访问');
});

test('增长异议处理上游失败时不修改顾客档案，失败流水可诊断', async () => {
  const before = balanceOfTenant(tenantId);
  const concernsBefore = db.prepare(
    'SELECT concerns FROM leads WHERE tenant_id=? AND id=?',
  ).get(tenantId, leadId).concerns;
  const suggestionsBefore = db.prepare(
    `SELECT COUNT(*) n FROM lead_ai_suggestions
     WHERE tenant_id=? AND lead_id=? AND purpose='异议处理'`,
  ).get(tenantId, leadId).n;
  const failed = await post(`/growth/leads/${leadId}/objection`, {
    text: '强制增长上游失败',
  });

  assert.equal(failed.response.status, 502, JSON.stringify(failed.payload));
  assert.equal(failed.payload.code, 'AI_REAL_OUTPUT_REQUIRED');
  assert.equal(failed.payload.deliveryState, 'failed');
  assert.equal(failed.payload.failurePhase, 'generate');
  assert.equal(failed.payload.retryable, true);
  assert.equal(failed.payload.requestId, REQUEST_ID);
  assert.equal(failed.payload.ai.mode, 'template');
  assert.ok(failed.payload.ai.violations.includes('mode_not_api'));
  assert.ok(failed.payload.ai.violations.includes('usage_missing'));
  assert.equal(failed.payload.billing.state, 'released');
  assert.equal(failed.payload.billing.chargedCredits, 0);
  assert.equal(
    db.prepare('SELECT concerns FROM leads WHERE tenant_id=? AND id=?').get(tenantId, leadId).concerns,
    concernsBefore,
  );
  assert.equal(db.prepare(
    `SELECT COUNT(*) n FROM lead_ai_suggestions
     WHERE tenant_id=? AND lead_id=? AND purpose='异议处理'`,
  ).get(tenantId, leadId).n, suggestionsBefore);
  assert.equal(balanceOfTenant(tenantId), before);
  assert.equal(heldRows().length, 0);
  const log = latestGrowthLog('增长中心·异议处理');
  assert.equal(log.ai_mode, 'failed');
  assert.equal(log.credits, 0);
  assert.match(log.note, /阶段=generate/);
  assert.match(log.note, /错误码=AI_REAL_OUTPUT_REQUIRED/);
});

test('增长异议处理任一token为零时不落话术或顾客异议', async () => {
  for (const scenario of [
    { text: '强制增长零token', violations: ['input_tokens_missing', 'output_tokens_missing'] },
    { text: '强制增长零输入token', violations: ['input_tokens_missing'] },
    { text: '强制增长零输出token', violations: ['output_tokens_missing'] },
  ]) {
    const before = balanceOfTenant(tenantId);
    const concernsBefore = db.prepare(
      'SELECT concerns FROM leads WHERE tenant_id=? AND id=?',
    ).get(tenantId, leadId).concerns;
    const suggestionsBefore = db.prepare(
      `SELECT COUNT(*) n FROM lead_ai_suggestions
       WHERE tenant_id=? AND lead_id=? AND purpose='异议处理'`,
    ).get(tenantId, leadId).n;

    const failed = await post(`/growth/leads/${leadId}/objection`, { text: scenario.text });
    assert.equal(failed.response.status, 502, JSON.stringify(failed.payload));
    assert.equal(failed.payload.code, 'AI_REAL_OUTPUT_REQUIRED');
    assert.equal(failed.payload.failurePhase, 'generate');
    assert.equal(failed.payload.billing.state, 'released');
    for (const violation of scenario.violations) {
      assert.ok(failed.payload.ai.violations.includes(violation), `${scenario.text}缺少${violation}`);
    }
    assert.equal(
      db.prepare('SELECT concerns FROM leads WHERE tenant_id=? AND id=?').get(tenantId, leadId).concerns,
      concernsBefore,
    );
    assert.equal(db.prepare(
      `SELECT COUNT(*) n FROM lead_ai_suggestions
       WHERE tenant_id=? AND lead_id=? AND purpose='异议处理'`,
    ).get(tenantId, leadId).n, suggestionsBefore);
    assert.equal(balanceOfTenant(tenantId), before);
    assert.equal(heldRows().length, 0);
  }
});

test('增长异议话术落库事务后段失败时回滚话术与顾客索引并释放预授权', async () => {
  const concern = '强制异议落库回滚';
  const before = balanceOfTenant(tenantId);
  const concernsBefore = db.prepare(
    'SELECT concerns FROM leads WHERE tenant_id=? AND id=?',
  ).get(tenantId, leadId).concerns;
  db.exec(`CREATE TRIGGER injected_objection_index_failure
    BEFORE UPDATE OF concerns ON leads
    WHEN NEW.tenant_id=${tenantId} AND NEW.id=${leadId}
      AND instr(NEW.concerns,'${concern}') > 0
    BEGIN
      SELECT RAISE(ABORT,'injected objection index persistence failure');
    END`);
  try {
    const failed = await post(`/growth/leads/${leadId}/objection`, { text: concern });
    assert.equal(failed.response.status, 500, JSON.stringify(failed.payload));
    assert.equal(failed.payload.deliveryState, 'failed');
    assert.equal(failed.payload.failurePhase, 'persist');
    assert.equal(failed.payload.billing.state, 'released');
    assert.equal(failed.payload.billing.chargedCredits, 0);
    assert.equal(
      db.prepare('SELECT concerns FROM leads WHERE tenant_id=? AND id=?').get(tenantId, leadId).concerns,
      concernsBefore,
    );
    assert.equal(db.prepare(
      `SELECT COUNT(*) n FROM lead_ai_suggestions
       WHERE tenant_id=? AND lead_id=? AND context=?`,
    ).get(tenantId, leadId, concern).n, 0, '事务前段插入的话术必须随顾客索引失败一起回滚');
    assert.equal(balanceOfTenant(tenantId), before);
    assert.equal(heldRows().length, 0);
    const log = latestGrowthLog('增长中心·异议处理');
    assert.equal(log.ai_mode, 'failed');
    assert.equal(log.credits, 0);
    assert.match(log.note, /阶段=persist/);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_objection_index_failure');
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
