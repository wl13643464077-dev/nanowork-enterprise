import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-activity-two-phase-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = 'sk-local-activity-two-phase-test';
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
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const {
  balanceOfTenant,
  holdCredits,
  releaseHold,
} = await import('../src/engines/credits.js');

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

const tenantId = Number(qRaw.run(
  "INSERT INTO tenants(name,status,credits) VALUES('活动两阶段计费企业','已开通',5000)",
).lastInsertRowid);
const userId = Number(qRaw.run(
  `INSERT INTO users(username,password_hash,name,role,tenant_id)
   VALUES('activity-two-phase-u','x','活动计费用户','boss',?)`,
  tenantId,
).lastInsertRowid);
const user = {
  id: userId,
  name: '活动计费用户',
  role: 'boss',
  tenant_id: tenantId,
};
const REQUEST_ID = 'activity-two-phase-request';

// 让本地假供应商在旧实现的 RED 阶段也能读取占扣表；初始化占扣立即释放，
// 不改变租户余额，只留下可审计的 0 分初始化流水。
const bootstrapHold = holdCredits({
  userId,
  feature: '活动两阶段测试初始化',
  kind: 'text',
  model: 'gpt-5.5',
  credits: 1,
});
releaseHold(bootstrapHold, '活动两阶段测试初始化完成');

const activityId = Number(qRaw.run(
  `INSERT INTO activities(
    title,type,status,date,target_join,target_deal,invited,signed_up,arrived,converted,
    revenue,cost,satisfaction,owner_id,tenant_id
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  '两阶段活动样本',
  '门店主题活动',
  '已结束',
  '2026-09-01',
  20,
  3,
  20,
  12,
  9,
  2,
  1800,
  600,
  4.5,
  userId,
  tenantId,
).lastInsertRowid);

const providerObservations = [];
let failNextReviewProvider = false;
const providerApp = express();
providerApp.use(express.json({ limit: '2mb' }));
providerApp.post('/v1/embeddings', (_req, res) => {
  res.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
});
providerApp.post('/v1/chat/completions', (req, res) => {
  const held = db.prepare(
    `SELECT COUNT(*) n FROM credit_holds WHERE tenant_id=? AND status='held'`,
  ).get(tenantId).n;
  providerObservations.push({
    held,
    model: req.body?.model,
    structured: Boolean(req.body?.response_format),
  });
  const messagesText = JSON.stringify(req.body?.messages || []);
  if (failNextReviewProvider) {
    return res.status(504).json({ error: { message: 'injected activity review provider timeout' } });
  }
  if (messagesText.includes('强制活动上游失败')) {
    return res.status(500).json({ error: { message: 'injected activity provider failure' } });
  }
  if (messagesText.includes('强制活动无效结构')) {
    return res.json({
      choices: [{ message: { content: '这是真实接口返回，但不是活动策划JSON' } }],
      usage: { prompt_tokens: 120, completion_tokens: 20 },
    });
  }
  const content = req.body?.response_format
    ? JSON.stringify({
      theme: '本地假供应商活动方案',
      flow: [{ time: '18:00', item: '签到与授权确认' }],
      materials: ['签到表', '过敏原提示卡'],
      invites: '仅触达已授权顾客，名单由负责人复核',
      sop: ['核对容量', '确认菜单与食安', '记录真实活动数据'],
      kpi: {
        邀约确认率: '待按企业历史数据确认',
        报名到场率: '待按企业历史数据确认',
        现场成交率: '待按企业历史数据确认',
        加微率: '仅统计已授权顾客',
        ROI: '按真实收入和成本计算',
      },
      budgetNote: '预算逐项由负责人审批',
    })
    : '本地假供应商复盘：本场到场与成交数据已记录；下一场应核对触达授权、菜单食安和真实成本。';
  res.json({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 120, completion_tokens: 80 },
  });
});
const providerServer = providerApp.listen(0, '127.0.0.1');
const providerPort = await new Promise(resolve => {
  providerServer.once('listening', () => resolve(providerServer.address().port));
});
setConfig('yunwu_base_url', `http://127.0.0.1:${providerPort}/v1`);

const activityRoutes = (await import('../src/routes/activities.js')).default;
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, _res, next) => runWithTenant(tenantId, () => {
  req.user = user;
  req.requestId = REQUEST_ID;
  next();
}));
app.use('/activities', activityRoutes);
const server = app.listen(0, '127.0.0.1');
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

async function post(route, body = {}) {
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

const latestActivityLog = feature => db.prepare(
  `SELECT ai_mode,credits,note FROM credit_logs
   WHERE tenant_id=? AND feature=? ORDER BY id DESC LIMIT 1`,
).get(tenantId, feature);

test('活动AI策划在调用本地假供应商前已占扣，产物落库后按真实用量结算', async () => {
  const before = balanceOfTenant(tenantId);
  const observationIndex = providerObservations.length;
  const result = await post(`/activities/${activityId}/plan`, {
    goal: '提升真实到场率',
    audience: '已授权触达顾客',
    budget: '3000元内',
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
  assert.ok(providerObservations.slice(observationIndex).some(item => item.structured && item.held > 0));
  assert.equal(heldRows().length, 0);
  assert.equal(
    balanceOfTenant(tenantId),
    before - result.payload.billing.chargedCredits,
  );
  const stored = db.prepare(
    'SELECT plan,plan_status FROM activities WHERE tenant_id=? AND id=?',
  ).get(tenantId, activityId);
  assert.equal(stored.plan_status, '草稿');
  const persistedPlan = JSON.parse(stored.plan);
  assert.equal(persistedPlan.theme, '本地假供应商活动方案');
  assert.equal(persistedPlan.aiMeta.mode, 'api');
  assert.equal(persistedPlan.aiMeta.model, result.payload.model);
  assert.deepEqual(persistedPlan.aiMeta.usage, result.payload.usage);
  assert.equal(persistedPlan.aiMeta.billing.state, 'settled');
  const linkedPlanHold = db.prepare(`SELECT ref_type,ref_id FROM credit_holds
    WHERE tenant_id=? AND feature='活动中心·AI策划' ORDER BY id DESC LIMIT 1`).get(tenantId);
  assert.deepEqual({ ...linkedPlanHold }, { ref_type: 'activity', ref_id: activityId });
});

test('活动策划上游失败降级模板时不落草稿，全额退回且标记可重试', async () => {
  const title = '强制活动上游失败';
  const before = balanceOfTenant(tenantId);
  const failed = await post('/activities/plan-drafts/generate', {
    title,
    date: '2026-09-04',
    targetJoin: 18,
  });

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
    db.prepare('SELECT COUNT(*) n FROM activity_plan_drafts WHERE tenant_id=? AND title=?')
      .get(tenantId, title).n,
    0,
  );
  assert.equal(balanceOfTenant(tenantId), before);
  assert.equal(heldRows().length, 0);
  const log = latestActivityLog('活动策划室·AI策划');
  assert.equal(log.ai_mode, 'failed');
  assert.equal(log.credits, 0);
  assert.match(log.note, /阶段=generate/);
  assert.match(log.note, /错误码=AI_REAL_OUTPUT_REQUIRED/);
});

test('真实接口返回无效策划结构时不用本地模板偷换，不落库且全额退回', async () => {
  const title = '强制活动无效结构';
  const before = balanceOfTenant(tenantId);
  const failed = await post('/activities/plan-drafts/generate', {
    title,
    date: '2026-09-05',
    targetJoin: 18,
  });

  assert.equal(failed.response.status, 502, JSON.stringify(failed.payload));
  assert.equal(failed.payload.code, 'AI_OUTPUT_CONTRACT_INVALID');
  assert.equal(failed.payload.aiStatus, 'failed');
  assert.equal(failed.payload.deliveryState, 'failed');
  assert.equal(failed.payload.failurePhase, 'generate');
  assert.equal(failed.payload.retryable, true);
  assert.match(failed.payload.retryHint, /格式质检未通过/);
  assert.equal(failed.payload.requestId, REQUEST_ID);
  assert.equal(failed.payload.ai.mode, 'api');
  assert.equal(failed.payload.ai.usage.inputTokens, 120);
  assert.equal(failed.payload.billing.state, 'released');
  assert.equal(failed.payload.billing.chargedCredits, 0);
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM activity_plan_drafts WHERE tenant_id=? AND title=?')
      .get(tenantId, title).n,
    0,
  );
  assert.equal(balanceOfTenant(tenantId), before);
  assert.equal(heldRows().length, 0);
  const log = latestActivityLog('活动策划室·AI策划');
  assert.equal(log.ai_mode, 'failed');
  assert.equal(log.credits, 0);
  assert.match(log.note, /阶段=generate/);
  assert.match(log.note, /错误码=AI_OUTPUT_CONTRACT_INVALID/);
});

test('独立策划草案落库失败时释放预授权，不收费且不留下半成品', async () => {
  const title = '强制活动草案落库失败';
  const before = balanceOfTenant(tenantId);
  db.exec(`CREATE TRIGGER injected_activity_draft_failure
    BEFORE INSERT ON activity_plan_drafts
    WHEN NEW.title='${title}'
    BEGIN
      SELECT RAISE(ABORT,'injected activity draft persistence failure');
    END`);
  try {
    const failed = await post('/activities/plan-drafts/generate', {
      title,
      date: '2026-09-02',
      targetJoin: 18,
    });
    assert.equal(failed.response.status, 500);
    assert.equal(failed.payload.deliveryState, 'failed');
    assert.equal(failed.payload.failurePhase, 'persist');
    assert.equal(failed.payload.retryable, true);
    assert.equal(failed.payload.requestId, REQUEST_ID);
    assert.equal(failed.payload.billing.state, 'released');
    assert.equal(failed.payload.billing.chargedCredits, 0);
    assert.equal(
      db.prepare(
        'SELECT COUNT(*) n FROM activity_plan_drafts WHERE tenant_id=? AND title=?',
      ).get(tenantId, title).n,
      0,
    );
    assert.equal(balanceOfTenant(tenantId), before);
    assert.equal(heldRows().length, 0);
    const log = latestActivityLog('活动策划室·AI策划');
    assert.equal(log.ai_mode, 'failed');
    assert.match(log.note, /阶段=persist/);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_activity_draft_failure');
  }
});

test('活动复盘上游失败降级时不写复盘、不改状态、不同步知识库', async () => {
  const before = balanceOfTenant(tenantId);
  const storedBefore = db.prepare(
    'SELECT review,status FROM activities WHERE tenant_id=? AND id=?',
  ).get(tenantId, activityId);
  const kbBefore = db.prepare(
    `SELECT COUNT(*) n FROM kb_docs WHERE tenant_id=? AND title='活动复盘：两阶段活动样本'`,
  ).get(tenantId).n;

  failNextReviewProvider = true;
  let failed;
  try {
    failed = await post(`/activities/${activityId}/review`);
  } finally {
    failNextReviewProvider = false;
  }
  assert.equal(failed.response.status, 502, JSON.stringify(failed.payload));
  assert.equal(failed.payload.code, 'AI_REAL_OUTPUT_REQUIRED');
  assert.equal(failed.payload.deliveryState, 'failed');
  assert.equal(failed.payload.failurePhase, 'generate');
  assert.equal(failed.payload.retryable, true);
  assert.equal(failed.payload.requestId, REQUEST_ID);
  assert.equal(failed.payload.billing.state, 'released');
  assert.equal(failed.payload.billing.chargedCredits, 0);
  assert.deepEqual(
    db.prepare('SELECT review,status FROM activities WHERE tenant_id=? AND id=?')
      .get(tenantId, activityId),
    storedBefore,
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) n FROM kb_docs
      WHERE tenant_id=? AND title='活动复盘：两阶段活动样本'`).get(tenantId).n,
    kbBefore,
  );
  assert.equal(balanceOfTenant(tenantId), before);
  assert.equal(heldRows().length, 0);
  const log = latestActivityLog('活动中心·数据分析复盘');
  assert.equal(log.ai_mode, 'failed');
  assert.equal(log.credits, 0);
  assert.match(log.note, /阶段=generate/);
  assert.match(log.note, /错误码=AI_REAL_OUTPUT_REQUIRED/);
});

test('活动复盘生成阶段异常时释放预授权，活动与知识库都不产生半成品', async () => {
  const marshal = db.prepare(`SELECT id,kb_deps FROM marshals WHERE code='M-07'`).get();
  const before = balanceOfTenant(tenantId);
  db.prepare(`UPDATE marshals SET kb_deps=? WHERE id=?`).run(
    Buffer.from('invalid-binary-kb-scope'),
    marshal.id,
  );
  try {
    const failed = await post(`/activities/${activityId}/review`);
    assert.equal(failed.response.status, 500);
    assert.equal(failed.payload.deliveryState, 'failed');
    assert.equal(failed.payload.failurePhase, 'generate');
    assert.equal(failed.payload.retryable, true);
    assert.equal(failed.payload.requestId, REQUEST_ID);
    assert.equal(failed.payload.billing.state, 'released');
    assert.equal(failed.payload.billing.chargedCredits, 0);
    assert.equal(balanceOfTenant(tenantId), before);
    assert.equal(heldRows().length, 0);
    assert.equal(
      db.prepare('SELECT review,status FROM activities WHERE tenant_id=? AND id=?')
        .get(tenantId, activityId).review,
      null,
    );
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) n FROM kb_docs WHERE tenant_id=? AND title='活动复盘：两阶段活动样本'`,
      ).get(tenantId).n,
      0,
    );
    const log = latestActivityLog('活动中心·数据分析复盘');
    assert.equal(log.ai_mode, 'failed');
    assert.match(log.note, /阶段=generate/);
  } finally {
    db.prepare(`UPDATE marshals SET kb_deps=? WHERE id=?`).run(marshal.kb_deps, marshal.id);
  }
});

test('活动复盘的AI文本、知识库和活动状态在同一业务事务落库后结算', async () => {
  const before = balanceOfTenant(tenantId);
  const result = await post(`/activities/${activityId}/review`, {
    ok: ['现场数据已核验'],
    bad: ['会后回访需提速'],
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.mode, 'api');
  assert.equal(result.payload.aiStatus, 'succeeded');
  assert.equal(result.payload.deliveryState, 'succeeded');
  assert.ok(result.payload.model);
  assert.deepEqual(result.payload.usage, { inputTokens: 120, outputTokens: 80 });
  assert.equal(result.payload.billing.state, 'settled');
  assert.equal(result.payload.aiMeta.billing.state, 'settled');
  assert.equal(result.payload.aiMeta.divisionCode, 'M-07');
  assert.match(result.payload.aiText, /本地假供应商复盘/);
  assert.equal(heldRows().length, 0);
  assert.equal(
    balanceOfTenant(tenantId),
    before - result.payload.billing.chargedCredits,
  );
  const stored = db.prepare(
    'SELECT review,status FROM activities WHERE tenant_id=? AND id=?',
  ).get(tenantId, activityId);
  const review = JSON.parse(stored.review);
  assert.equal(stored.status, '已复盘');
  assert.equal(review.aiMeta.billing.state, 'settled');
  assert.deepEqual(review.aiMeta.usage, { inputTokens: 120, outputTokens: 80 });
  assert.match(review.aiText, /本地假供应商复盘/);
  assert.equal(
    db.prepare(
      `SELECT COUNT(*) n FROM kb_docs WHERE tenant_id=? AND title='活动复盘：两阶段活动样本'`,
    ).get(tenantId).n,
    1,
  );
  const linkedReviewHold = db.prepare(`SELECT ref_type,ref_id FROM credit_holds
    WHERE tenant_id=? AND feature='活动中心·数据分析复盘' ORDER BY id DESC LIMIT 1`).get(tenantId);
  assert.deepEqual({ ...linkedReviewHold }, { ref_type: 'activity_review', ref_id: activityId });
});

test('结算失败时策划草案仍交付，响应与持久账本明确 pending_reconciliation', async () => {
  const title = '结算异常仍交付活动草案';
  const before = balanceOfTenant(tenantId);
  db.exec(`CREATE TRIGGER injected_activity_settlement_failure
    BEFORE UPDATE OF status ON credit_holds
    WHEN OLD.feature='活动策划室·AI策划'
      AND OLD.status='held'
      AND NEW.status='settled'
    BEGIN
      SELECT RAISE(ABORT,'injected activity settlement failure');
    END`);
  let pendingHold;
  try {
    const pending = await post('/activities/plan-drafts/generate', {
      title,
      date: '2026-09-03',
      targetJoin: 16,
    });
    assert.equal(pending.response.status, 200, JSON.stringify(pending.payload));
    assert.equal(pending.payload.billing.state, 'pending_reconciliation');
    assert.equal(pending.payload.billing.chargedCredits, null);
    assert.ok(pending.payload.draftId);
    const linkedDraftHold = db.prepare(`SELECT ref_type,ref_id FROM credit_holds
      WHERE tenant_id=? AND feature='活动策划室·AI策划' ORDER BY id DESC LIMIT 1`).get(tenantId);
    assert.deepEqual({ ...linkedDraftHold }, {
      ref_type: 'activity_plan_draft',
      ref_id: pending.payload.draftId,
    });
    assert.equal(
      db.prepare(
        'SELECT COUNT(*) n FROM activity_plan_drafts WHERE tenant_id=? AND id=?',
      ).get(tenantId, pending.payload.draftId).n,
      1,
    );
    [pendingHold] = heldRows();
    assert.ok(pendingHold);
    assert.equal(balanceOfTenant(tenantId), before - pendingHold.held_credits);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_activity_settlement_failure');
    if (pendingHold) {
      releaseHold({
        holdId: pendingHold.id,
        logId: pendingHold.log_id,
        tenantId: pendingHold.tenant_id,
        userId: pendingHold.user_id,
        feature: pendingHold.feature,
        kind: pendingHold.kind,
        model: pendingHold.model,
        credits: pendingHold.held_credits,
        balance: balanceOfTenant(tenantId),
      }, '活动两阶段专项测试清理待对账占扣');
    }
  }
  assert.equal(balanceOfTenant(tenantId), before);
  assert.equal(heldRows().length, 0);
});

after(async () => {
  await new Promise(resolve => setTimeout(resolve, 30));
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => providerServer.close(resolve));
  delete process.env.YUNWU_API_KEY;
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
  }
});
