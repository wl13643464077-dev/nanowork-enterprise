/*
 * Employee online-learning runtime/route/TaskCenter contract.
 *
 * All provider boundaries are dependency-injected; this file never performs
 * network, WebSearch, WebFetch or paid-model calls.  It verifies the current
 * implementation's tenant, skill-card, billing and unified-task semantics.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const dbPath = path.join(os.tmpdir(), `nanowork-skill-learning-runtime-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
process.env.NANOWORK_DB = dbPath;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';
process.env.ENABLE_SCHEDULER = 'false';
process.env.SEED_DEMO = 'false';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const learning = await import('../src/engines/employee-skill-learning.js');
const { holdCredits, settleHold } = await import('../src/engines/credits.js');
const { createSqliteContentProductionPipelineRepository } = await import('../src/engines/content-production-pipeline.js');
const { listUnifiedTasks, getUnifiedTaskDetail } = await import('../src/engines/task-center.js');
const restaurantRoutes = (await import('../src/routes/employee-workbench.js')).default;
const { createContentEmployeeWorkbenchRouter } = await import('../src/routes/content-employee-workbench.js');

initSchema();
migrateV2();
await ensureBaselineCatalogs();

db.prepare("INSERT OR IGNORE INTO tenants(id,name,status,credits) VALUES(1,'学习契约租户一','启用',1000000)").run();
db.prepare("INSERT OR IGNORE INTO tenants(id,name,status,credits) VALUES(2,'学习契约租户二','启用',1000000)").run();
for (const [id, tenantId, role, username] of [
  [101, 1, 'boss', 'learning-boss-1'],
  [102, 1, 'platform_super', 'learning-platform-1'],
  [201, 2, 'boss', 'learning-boss-2'],
  [301, 1, 'staff', 'learning-staff-1'],
]) {
  db.prepare(`INSERT OR IGNORE INTO users(id,username,password_hash,name,role,status,tenant_id)
    VALUES(?,?,?,'学习契约用户',?,'启用',?)`).run(id, username, 'x', role, tenantId);
}

const users = {
  boss1: { id: 101, username: 'learning-boss-1', name: '学习契约用户', role: 'boss', tenant_id: 1 },
  platform1: { id: 102, username: 'learning-platform-1', name: '学习契约用户', role: 'platform_super', tenant_id: 1 },
  boss2: { id: 201, username: 'learning-boss-2', name: '学习契约用户', role: 'boss', tenant_id: 2 },
  staff1: { id: 301, username: 'learning-staff-1', name: '学习契约用户', role: 'staff', tenant_id: 1 },
};

function employee(domain, idx, name = domain === 'content' ? '趋势官' : '钱商圈') {
  return {
    domain,
    idx,
    name,
    department: domain === 'content' ? '内容生产部' : '商圈分析部',
    duty: domain === 'content' ? '围绕岗位职责形成公开事实与可执行技能' : '核验商圈、竞品与经营事实',
    positionSkill: domain === 'content' ? '趋势检索与内容策划' : '餐饮商圈分析',
    existingSkills: [{ title: '已有技能', detail: '已有技能详情足够长，不应重复进入新的学习结果。', enabled: true }],
    profileFingerprint: `fixture-profile-${domain}-${idx}`,
  };
}

function sourceRows(prefix = 'source') {
  return Array.from({ length: 6 }, (_, index) => ({
    title: `${prefix}来源${index + 1}`,
    url: `https://example.test/${prefix}-${index + 1}`,
    snippet: `公开检索摘要${index + 1}`,
    body: `受控网页正文${index + 1}。这里仅包含公开业务事实、发布日期、执行步骤、适用范围和复核边界；该正文长度超过受控正文门禁，不包含任何内部岗位资料或凭据。正文还包含来源上下文、执行责任、复核动作和适用限制，必须以受控网页正文为准。`,
  }));
}

function learningDependencies({ prefix = 'fixture', failResearch = false, events = [] } = {}) {
  const sources = sourceRows(prefix);
  const providerOutput = JSON.stringify({
    skills: [
      { title: '已有技能', detail: '已有技能详情足够长，不应重复进入新的学习结果。', sourceTitle: sources[0].title, sourceUrl: sources[0].url },
      { title: `${prefix}新技能一`, detail: '新增技能一必须落到具体岗位动作与事实核验边界。', sourceTitle: sources[1].title, sourceUrl: sources[1].url },
      { title: `${prefix}新技能二`, detail: '新增技能二必须落到具体岗位动作与事实核验边界。', sourceTitle: sources[2].title, sourceUrl: sources[2].url },
      { title: `${prefix}新技能三`, detail: '新增技能三必须落到具体岗位动作与事实核验边界。', sourceTitle: sources[3].title, sourceUrl: sources[3].url },
    ],
  });
  return {
    agenticWebResearchFn: async query => {
      events.push({ type: 'websearch', query });
      if (failResearch) throw Object.assign(new Error('fixture search unavailable'), { code: 'FIXTURE_SEARCH_FAILED' });
      return {
        attempted: true,
        ok: true,
        candidateReady: true,
        fetchCandidates: sources,
        results: sources,
        provider: 'fixture-agentic-search',
        evidence: {
          costUsd: 0.12,
          steps: Array.from({ length: 5 }, (_, index) => ({ tool: 'WebSearch', query: `${query} #${index + 1}` })),
        },
      };
    },
    controlledWebFetchFn: async candidates => {
      events.push({ type: 'webfetch', count: candidates.length });
      return {
        attempted: true,
        ok: true,
        results: candidates.map(candidate => ({ ...candidate })),
        provider: 'fixture-controlled-fetch',
        evidence: { fetched: candidates.length },
      };
    },
    generateFn: async payload => {
      events.push({ type: 'provider', kind: payload.kind, userMsg: payload.userMsg });
      return {
        mode: 'api',
        model: 'fixture-real-model',
        text: providerOutput,
        usage: { inputTokens: 120, outputTokens: 80 },
        costUsd: 0.02,
      };
    },
  };
}

function createQueuedRun({ tenantId, domain, idx, createdBy, name = '学习岗位' }) {
  return learning.createSkillLearningRun({
    tenantId,
    domain,
    employeeIdx: idx,
    employeeName: name,
    profileFingerprint: `queued-${tenantId}-${domain}-${idx}`,
    skillsBefore: 1,
    createdBy,
  });
}

function markCompleted(runId, tenantId, domain, idx) {
  const sources = sourceRows(`${domain}-${idx}`);
  q.run(`UPDATE employee_skill_learning_runs SET status='completed',skills_added=3,skills_total=4,
    research_json=?,provider_attempt_json=?,result_json=?,completed_at=datetime('now','localtime'),updated_at=datetime('now','localtime')
    WHERE tenant_id=? AND id=?`,
  JSON.stringify({ controlledSourceCount: 3, costUsd: 0.12, results: sources.slice(0, 3) }),
  JSON.stringify({ mode: 'api', model: 'fixture-real-model', usage: { inputTokens: 120, outputTokens: 80 } }),
  JSON.stringify({ skills: [{ title: '完成技能', detail: '完成技能详情', sourceUrl: sources[0].url, sourceTitle: sources[0].title }] }),
  tenantId, runId);
  return learning.getSkillLearningRun({ tenantId, runId, domain, employeeIdx: idx });
}

function appFor(user, { scheduleFn = () => {}, contentRouter = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => {
    req.user = user;
    next();
  }));
  app.use('/employee', restaurantRoutes);
  app.use('/content', contentRouter || createContentEmployeeWorkbenchRouter({ scheduleFn }));
  app.use('/task-center', (awaitableTaskCenterRoutes));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  return app;
}

// Avoid importing express router inside appFor's hot path; it is initialized
// once below after the static imports have completed.
const awaitableTaskCenterRoutes = (await import('../src/routes/task-center.js')).default;

async function withServer(app, fn) {
  const server = app.listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function request(base, method, url, body = undefined) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed;
  try { parsed = await response.json(); } catch { parsed = {}; }
  return { status: response.status, body: parsed };
}

test('runEmployeeSkillLearning 同时覆盖餐饮/内容、3–6技能、去重、受控正文与来源闭环', async () => {
  for (const [domain, idx] of [['restaurant', 102], ['content', 0]]) {
    const events = [];
    const result = await learning.runEmployeeSkillLearning({
      employee: employee(domain, idx),
      role: 'boss',
      model: 'fixture-real-model',
      ...learningDependencies({ prefix: `${domain}-${idx}`, events }),
    });
    assert.ok(result.skills.length >= 3 && result.skills.length <= 6);
    assert.equal(new Set(result.skills.map(skill => skill.title)).size, result.skills.length);
    assert.ok(result.research.controlledSourceCount >= 3);
    assert.ok(result.research.results.every(source => source.body.length >= 80));
    assert.ok(result.skills.every(skill => skill.sourceTitle && skill.sourceUrl));
    assert.equal(events.filter(event => event.type === 'websearch').length, 1);
    assert.equal(events.filter(event => event.type === 'webfetch').length, 1);
    assert.equal(events.filter(event => event.type === 'provider').length, 1);
  }
  const prompt = learning.buildSkillLearningPrompt(employee('content', 0));
  assert.match(prompt.system, /已有技能详情足够长/u, '下一次进修prompt必须注入已持久化技能详情');
  assert.doesNotMatch(prompt.researchQuery, /已有技能详情足够长/u, '私有技能详情不得进入联网检索query');
});

test('learning run 租户隔离、同岗并发409与失败退款/成功结算', async () => {
  const tenantOne = createQueuedRun({ tenantId: 1, domain: 'restaurant', idx: 150, createdBy: users.boss1.id, name: '租户一巡店' });
  const tenantTwo = createQueuedRun({ tenantId: 2, domain: 'restaurant', idx: 150, createdBy: users.boss2.id, name: '租户二巡店' });
  assert.notEqual(tenantOne.id, tenantTwo.id);
  assert.throws(
    () => createQueuedRun({ tenantId: 1, domain: 'restaurant', idx: 150, createdBy: users.boss1.id }),
    error => error?.status === 409 && error?.code === 'EMPLOYEE_SKILL_LEARNING_BUSY',
  );
  assert.equal(learning.getSkillLearningRun({ tenantId: 2, runId: tenantOne.id }), null);
  assert.equal(learning.listSkillLearningRuns({ tenantId: 1, domain: 'restaurant', employeeIdx: 150 }).length, 1);
  assert.equal(learning.listSkillLearningRuns({ tenantId: 2, domain: 'restaurant', employeeIdx: 150 }).length, 1);

  const failed = createQueuedRun({ tenantId: 1, domain: 'content', idx: 1, createdBy: users.boss1.id, name: '失败进修岗位' });
  const billingEvents = [];
  const failedRun = await learning.startSkillLearningRun({
    tenantId: 1,
    runId: failed.id,
    user: users.boss1,
    employee: employee('content', 1, '失败进修岗位'),
    model: 'fixture-real-model',
    persistSkills: async () => ({ total: 1 }),
    dependencies: {
      estimateCallCreditsFn: () => 9,
      holdCreditsFn: input => ({ holdId: 901, logId: 902, credits: input.credits, costYuan: 0 }),
      releaseHoldFn: (hold, note) => { billingEvents.push({ type: 'release', hold, note }); return { credits: hold.credits, costYuan: 0 }; },
      settleHoldFn: () => { throw new Error('settle must not run on failure'); },
      ...learningDependencies({ prefix: 'failed', failResearch: true }),
    },
  });
  assert.equal(failedRun.status, 'failed');
  assert.equal(failedRun.error.billingState, 'released');
  // The release receipt is reflected in charged_credits for the authoritative
  // ledger row; the error billingState proves it was returned, not settled.
  assert.equal(failedRun.billing.chargedCredits, 9);
  assert.equal(billingEvents.length, 1);

  const completed = createQueuedRun({ tenantId: 2, domain: 'content', idx: 2, createdBy: users.boss2.id, name: '成功进修岗位' });
  const successEvents = [];
  const completedRun = await learning.startSkillLearningRun({
    tenantId: 2,
    runId: completed.id,
    user: users.boss2,
    employee: employee('content', 2, '成功进修岗位'),
    model: 'fixture-real-model',
    persistSkills: async skills => ({ total: 1 + skills.length }),
    dependencies: {
      estimateCallCreditsFn: () => 11,
      holdCreditsFn: input => ({ holdId: 911, logId: 912, credits: input.credits, costYuan: 0 }),
      releaseHoldFn: () => { throw new Error('release must not run on success'); },
      settleHoldFn: (hold, input) => { successEvents.push({ hold, input }); return { credits: 4, costYuan: 0.04 }; },
      ...learningDependencies({ prefix: 'success' }),
    },
  });
  assert.equal(completedRun.status, 'completed');
  assert.equal(completedRun.skillsAdded, 3);
  assert.equal(completedRun.billing.chargedCredits, 4);
  assert.equal(successEvents.length, 1);
  assert.equal(successEvents[0].input.usage.inputTokens, 120);
});

test('restaurant/content learn routes：manager/tenant边界、并发409与202 queued 不触发云调用', async () => {
  const restaurantActive = createQueuedRun({ tenantId: 1, domain: 'restaurant', idx: 151, createdBy: users.boss1.id, name: '餐饮进修并发岗' });
  const contentActive = createQueuedRun({ tenantId: 1, domain: 'content', idx: 3, createdBy: users.boss1.id, name: '内容进修并发岗' });
  const scheduled = [];
  const app = appFor(users.boss1, { scheduleFn: callback => scheduled.push(callback) });
  await withServer(app, async base => {
    const restaurantBusy = await request(base, 'POST', '/employee/restaurant/151/learn');
    assert.equal(restaurantBusy.status, 409);
    assert.match(String(restaurantBusy.body.error), /正在全网进修中/u);
    const restaurantList = await request(base, 'GET', '/employee/restaurant/151/learning-runs');
    assert.equal(restaurantList.status, 200);
    assert.deepEqual(restaurantList.body.runs.map(run => run.id), [restaurantActive.id]);

    const contentBusy = await request(base, 'POST', '/content/3/learn');
    assert.equal(contentBusy.status, 409);
    const contentList = await request(base, 'GET', '/content/3/learning-runs');
    assert.equal(contentList.status, 200);
    assert.deepEqual(contentList.body.runs.map(run => run.id), [contentActive.id]);

    const contentQueued = await request(base, 'POST', '/content/4/learn');
    assert.equal(contentQueued.status, 202);
    assert.equal(contentQueued.body.started, true);
    assert.equal(contentQueued.body.run.status, 'queued');
    assert.equal(scheduled.length, 1, 'route must schedule background runner, not call provider inline');
  });

  const staffApp = appFor(users.staff1, { scheduleFn: callback => scheduled.push(callback) });
  await withServer(staffApp, async base => {
    const denied = await request(base, 'POST', '/content/4/learn');
    assert.equal(denied.status, 403);
  });

  const platformApp = appFor(users.platform1, { scheduleFn: callback => scheduled.push(callback) });
  await withServer(platformApp, async base => {
    const isolated = await request(base, 'GET', '/content/4/learning-runs');
    assert.equal(isolated.status, 200);
    assert.ok(isolated.body.runs.every(run => run.tenantId === 1));
  });
  assert.equal(contentActive.tenantId, 1);
});

test('TaskCenter 列表/详情/deepLink 聚合 content_pipeline 与 skill_learning 且保持租户隔离、0审批', async () => {
  const completed = createQueuedRun({ tenantId: 1, domain: 'content', idx: 5, createdBy: users.boss1.id, name: '任务中心进修岗位' });
  markCompleted(completed.id, 1, 'content', 5);
  const otherTenantRun = createQueuedRun({ tenantId: 2, domain: 'content', idx: 5, createdBy: users.boss2.id, name: '另一租户进修岗位' });

  const repository = createSqliteContentProductionPipelineRepository({ db });
  repository.ensureSchema();
  const pipelineId = repository.createJob({
    tenantId: 1,
    createdBy: users.boss1.id,
    title: '内容团队统一流水线契约',
    task: { direction: '公开主题', industry: '餐饮' },
    persona: {},
    settings: {},
    workflow: { mode: 'fullauto' },
  });

  const list = runWithTenant(1, () => listUnifiedTasks(users.boss1, { pageSize: 100 }));
  const pipelineItem = list.items.find(item => item.kind === 'content_pipeline' && item.id === pipelineId);
  const learningItem = list.items.find(item => item.kind === 'skill_learning' && item.id === completed.id);
  assert.ok(pipelineItem);
  assert.ok(learningItem);
  assert.equal(pipelineItem.deepLink, `/tasks?kind=content_pipeline&id=${pipelineId}`);
  assert.equal(learningItem.deepLink, `/tasks?kind=skill_learning&id=${completed.id}`);
  assert.equal(learningItem.policyContext.kind, 'none', '在线进修不产生内容审批步骤');
  assert.equal(learningItem.reviewReady, false);

  const pipelineDetail = runWithTenant(1, () => getUnifiedTaskDetail(users.boss1, 'content_pipeline', pipelineId));
  const learningDetail = runWithTenant(1, () => getUnifiedTaskDetail(users.boss1, 'skill_learning', completed.id));
  assert.equal(pipelineDetail.sourceKey, `content_pipeline:${pipelineId}`);
  assert.equal(pipelineDetail.pipeline.stations.length, 10);
  assert.equal(pipelineDetail.deepLink, `/tasks?kind=content_pipeline&id=${pipelineId}`);
  assert.equal(learningDetail.sourceKey, `skill_learning:${completed.id}`);
  assert.equal(learningDetail.learning.controlledSourceCount, 3);
  assert.equal(learningDetail.deepLink, `/tasks?kind=skill_learning&id=${completed.id}`);
  assert.equal(learningDetail.policyContext.kind, 'none');

  const otherList = runWithTenant(2, () => listUnifiedTasks(users.boss2, { pageSize: 100 }));
  assert.ok(otherList.items.some(item => item.kind === 'skill_learning' && item.id === otherTenantRun.id));
  assert.equal(otherList.items.some(item => item.id === completed.id), false);
  assert.throws(
    () => runWithTenant(2, () => getUnifiedTaskDetail(users.boss2, 'skill_learning', completed.id)),
    error => error?.status === 404,
  );
  assert.throws(
    () => runWithTenant(2, () => getUnifiedTaskDetail(users.boss2, 'content_pipeline', pipelineId)),
    error => error?.status === 404,
  );
});

test('启动恢复按租户关闭陈旧进修：未开始直接失败、held原子退回、已正向结算转待对账', () => {
  const staleAt = '2000-01-01 00:00:00';
  const now = new Date();
  q.run('UPDATE tenants SET credits=1000 WHERE id IN (1,2)');
  const queued = createQueuedRun({
    tenantId: 1,
    domain: 'restaurant',
    idx: 810,
    createdBy: users.boss1.id,
    name: '排队中断岗位',
  });
  q.run(`UPDATE employee_skill_learning_runs
    SET created_at=?,updated_at=? WHERE tenant_id=? AND id=?`,
  staleAt, staleAt, 1, queued.id);

  const held = createQueuedRun({
    tenantId: 1,
    domain: 'content',
    idx: 811,
    createdBy: users.boss1.id,
    name: '占扣中断岗位',
  });
  const heldAuthorization = holdCredits({
    userId: users.boss1.id,
    tenantId: 1,
    feature: '恢复契约·占扣中断',
    kind: 'text',
    model: 'fixture-real-model',
    credits: 13,
    refType: 'employee_skill_learning_run',
    refId: held.id,
  });
  q.run(`UPDATE employee_skill_learning_runs
    SET status='running',started_at=?,updated_at=?
    WHERE tenant_id=? AND id=?`,
  staleAt, staleAt, 1, held.id);

  const positivelySettled = createQueuedRun({
    tenantId: 1,
    domain: 'content',
    idx: 812,
    createdBy: users.boss1.id,
    name: '已结算中断岗位',
  });
  const settledAuthorization = holdCredits({
    userId: users.boss1.id,
    tenantId: 1,
    feature: '恢复契约·已结算中断',
    kind: 'text',
    model: 'fixture-real-model',
    credits: 10,
    refType: 'employee_skill_learning_run',
    refId: positivelySettled.id,
  });
  settleHold(settledAuthorization, {
    credits: 4,
    aiMode: 'api',
    note: '模拟进程在结算后、任务终态落库前中断',
  });
  q.run(`UPDATE employee_skill_learning_runs
    SET status='running',hold_id=?,credit_log_id=?,held_credits=?,started_at=?,updated_at=?
    WHERE tenant_id=? AND id=?`,
  settledAuthorization.holdId, settledAuthorization.logId, settledAuthorization.credits,
  staleAt, staleAt, 1, positivelySettled.id);

  const fresh = createQueuedRun({
    tenantId: 1,
    domain: 'restaurant',
    idx: 813,
    createdBy: users.boss1.id,
    name: '新鲜运行岗位',
  });
  q.run(`UPDATE employee_skill_learning_runs
    SET status='running',started_at=datetime('now','localtime'),updated_at=datetime('now','localtime')
    WHERE tenant_id=? AND id=?`, 1, fresh.id);

  const otherTenant = createQueuedRun({
    tenantId: 2,
    domain: 'restaurant',
    idx: 814,
    createdBy: users.boss2.id,
    name: '另一租户陈旧岗位',
  });
  q.run(`UPDATE employee_skill_learning_runs
    SET created_at=?,updated_at=? WHERE tenant_id=? AND id=?`,
  staleAt, staleAt, 2, otherTenant.id);

  const balanceBeforeRecovery = Number(q.get('SELECT credits FROM tenants WHERE id=1').credits);
  const recovered = learning.recoverStaleSkillLearningRuns({
    tenantId: 1,
    now,
    staleMinutes: 15,
  });
  assert.deepEqual(
    recovered.map(item => [item.runId, item.status, item.billingState]),
    [
      [queued.id, 'failed', 'not_held'],
      [held.id, 'failed', 'released'],
      [positivelySettled.id, 'pending_reconciliation', 'pending_reconciliation'],
    ],
  );
  assert.equal(Number(q.get('SELECT credits FROM tenants WHERE id=1').credits), balanceBeforeRecovery + 13);

  const queuedAfter = learning.getSkillLearningRun({ tenantId: 1, runId: queued.id });
  const heldAfter = learning.getSkillLearningRun({ tenantId: 1, runId: held.id });
  const settledAfter = learning.getSkillLearningRun({ tenantId: 1, runId: positivelySettled.id });
  assert.equal(queuedAfter.error.code, 'EMPLOYEE_SKILL_LEARNING_INTERRUPTED');
  assert.equal(queuedAfter.error.retryable, true);
  assert.equal(heldAfter.error.billingState, 'released');
  assert.equal(heldAfter.billing.chargedCredits, 0);
  assert.equal(settledAfter.error.retryable, false);
  assert.equal(
    q.get('SELECT status FROM credit_holds WHERE id=?', heldAuthorization.holdId).status,
    'settled',
  );
  assert.equal(
    Number(q.get('SELECT settled_credits FROM credit_holds WHERE id=?', heldAuthorization.holdId).settled_credits),
    0,
  );
  assert.equal(
    Number(q.get('SELECT settled_credits FROM credit_holds WHERE id=?', settledAuthorization.holdId).settled_credits),
    4,
    '恢复不得擅自退回已正向结算的金额',
  );
  assert.equal(learning.getSkillLearningRun({ tenantId: 1, runId: fresh.id }).status, 'running');
  assert.equal(learning.getSkillLearningRun({ tenantId: 2, runId: otherTenant.id }).status, 'queued');

  assert.doesNotThrow(() => createQueuedRun({
    tenantId: 1,
    domain: 'content',
    idx: 811,
    createdBy: users.boss1.id,
    name: '恢复后可重试岗位',
  }));
});
