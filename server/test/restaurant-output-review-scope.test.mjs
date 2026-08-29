import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DBP = path.join(os.tmpdir(), `nanowork-restaurant-review-scope-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = ' ';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';
process.env.ENABLE_SCHEDULER = 'false';
process.env.SEED_DEMO = 'false';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const { holdCredits, settleHold } = await import('../src/engines/credits.js');
const {
  normalizeApprovalRoutingPolicy,
  resolveApprovalRoute,
} = await import('../src/engines/approval-routing-policy.js');
const {
  buildRestaurantOutputDeliverableFixture,
  getRestaurantOutputContract,
  renderRestaurantOutputMarkdown,
  validateRestaurantEmployeeOutputContract,
} = await import('../src/engines/restaurant-output-contract.js');
const marshalRoutes = (await import('../src/routes/marshals.js')).default;
const outputRoutes = (await import('../src/routes/employee-outputs.js')).default;
const systemRoutes = (await import('../src/routes/system.js')).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

q.run(`INSERT INTO tenants(id,name,status,plan,credits)
  VALUES(1,'直属团队权限测试企业','已开通','标准版',100000)
  ON CONFLICT(id) DO UPDATE SET status='已开通',credits=100000`);

function insertUser(username, name, role, managerId = null) {
  return Number(q.run(`INSERT INTO users(
    username,password_hash,name,role,status,tenant_id,manager_id,credits
  ) VALUES(?, 'x', ?, ?, '启用', 1, ?, 100000)`,
  username, name, role, managerId).lastInsertRowid);
}

const bossId = insertUser('scope-boss', '权限测试老板', 'boss');
const adminId = insertUser('scope-admin', '权限测试管理员', 'admin');
const opsId = insertUser('scope-ops', '权限测试运营总监', 'ops_director');
const managerAId = insertUser('scope-manager-a', 'A组直属经理', 'manager', opsId);
const managerBId = insertUser('scope-manager-b', 'B组直属经理', 'manager', opsId);
const staffAId = insertUser('scope-staff-a', 'A组员工', 'staff', managerAId);
const staffBId = insertUser('scope-staff-b', 'B组员工', 'staff', managerBId);

function user(id) {
  return q.get('SELECT id,name,role,tenant_id FROM users WHERE tenant_id=1 AND id=?', id);
}

const actors = {
  boss: user(bossId),
  admin: user(adminId),
  ops: user(opsId),
  managerA: user(managerAId),
};
const employee = q.get(`SELECT s.id,s.marshal_id,m.name marshal_name FROM specialists s
  JOIN marshals m ON m.id=s.marshal_id
  WHERE s.tenant_id=1 AND s.employee_idx=101`);
assert.ok(employee);

function settleTask(taskId, ownerId, label) {
  const hold = holdCredits({
    userId: ownerId,
    feature: `员工任务·${employee.marshal_name}`,
    kind: 'text',
    model: 'test-model',
    credits: 3,
    refType: 'agent_task',
    refId: taskId,
  });
  settleHold(hold, {
    credits: 1,
    aiMode: 'api',
    model: 'test-model',
    usage: { inputTokens: 100, outputTokens: 20 },
    note: `直属团队权限测试任务#${taskId}已结算`,
  });
}

function createReviewFixture(label, taskOwnerId, contentCreatorId, minute) {
  return runWithTenant(1, () => {
    const taskTitle = `${label}任务`;
    const taskRequirement = '只输出可审阅的内部清单';
    const parsedOutput = buildRestaurantOutputDeliverableFixture(101, { title: taskTitle, requirement: taskRequirement });
    const contract = getRestaurantOutputContract(101);
    const validated = validateRestaurantEmployeeOutputContract(101, parsedOutput, { task: { title: taskTitle, requirement: taskRequirement } });
    const outputBody = renderRestaurantOutputMarkdown(101, parsedOutput, { task: { title: taskTitle, requirement: taskRequirement } });
    const artifactSha = crypto.createHash('sha256').update(validated.artifacts[0].content).digest('hex');
    const taskId = Number(q.run(`INSERT INTO agent_tasks(
      marshal_id,specialist_id,title,type,requirement,status,created_by,created_at,
      employee_profile_version,employee_config_snapshot,employee_web_snapshot
    ) VALUES(?,?,?,'分析','只输出可审阅的内部清单','待审阅',?,?,'scope-profile',?,?)`,
    employee.marshal_id, employee.id, taskTitle, taskOwnerId,
    `2026-07-31 12:${minute}:00`, JSON.stringify({ approvalMode: 'manager_review' }),
    JSON.stringify({
      kind: 'restaurant_employee_execution_evidence',
      outputContract: {
        valid: true,
        contractId: contract.contractId,
        schemaVersion: contract.schemaVersion,
        primaryArtifact: contract.primaryArtifact,
        parsedOutput,
        providerResponseSha256: artifactSha,
        renderedBodySha256: crypto.createHash('sha256').update(outputBody).digest('hex'),
        artifacts: [{
          primary: true, kind: contract.primaryArtifact, contractId: contract.contractId,
          schemaVersion: contract.schemaVersion, contentSha256: artifactSha,
        }],
      },
      internalProfileLeakage: { detected: false, matches: [] },
    })).lastInsertRowid);
    const outputId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,risk_level,ai_mode,creator_id,marshal_id,created_at
    ) VALUES('员工产出',?,?,'待审核','none','api',?,?,?)`,
    `${label}产出`, outputBody, contentCreatorId, employee.marshal_id,
    `2026-07-31 12:${minute}:30`).lastInsertRowid);
    q.run('UPDATE agent_tasks SET output_id=? WHERE tenant_id=1 AND id=?', outputId, taskId);
    const approvalId = Number(q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,approval_level
    ) VALUES('content',?,?,?,'none',?,'待审核',?,'ops_director')`,
    outputId, `${label}产出`, `${label}摘要`,
    JSON.stringify(['employee_output_review', 'employee_approval:manager_review']),
    taskOwnerId).lastInsertRowid);
    settleTask(taskId, taskOwnerId, label);
    return { taskId, outputId, approvalId };
  });
}

// 产出创建人与任务负责人一致；权限仍以任务 created_by 的管理链为边界。
const inScope = createReviewFixture('A组', staffAId, staffAId, '01');
const lateral = createReviewFixture('B组', staffBId, staffBId, '02');
const billingConflict = createReviewFixture('错账', staffAId, staffAId, '03');
const enterpriseManagerRoute = createReviewFixture('企业负责人规则', staffAId, staffAId, '04');
runWithTenant(1, () => {
  const hold = q.get(`SELECT id,log_id FROM credit_holds
    WHERE tenant_id=1 AND ref_type='agent_task' AND ref_id=?`, billingConflict.taskId);
  q.run(`UPDATE credit_holds SET user_id=?,feature='伪造功能',kind='image' WHERE id=?`, bossId, hold.id);
  q.run(`UPDATE credit_logs SET user_id=?,feature='伪造功能',kind='image' WHERE id=?`, bossId, hold.log_id);
  q.run(`UPDATE contents SET snapshot_json=? WHERE tenant_id=1 AND id=?`,
    JSON.stringify({ billing: { state: 'settled', chargedCredits: 1 } }), billingConflict.outputId);

  const tenantPolicy = normalizeApprovalRoutingPolicy({
    employeeOutput: { mode: 'manager', reviewerUserId: managerAId },
  }, {
    configuredBy: { id: bossId, name: '权限测试老板', role: 'boss' },
    updatedAt: '2026-08-01T12:00:00.000Z',
  });
  const route = resolveApprovalRoute({
    targetType: 'content',
    riskLevel: 'none',
    requestedLevel: 'boss',
    policy: tenantPolicy,
  });
  q.run(`UPDATE agent_tasks
    SET employee_config_snapshot=?,approval_routing_policy_snapshot=?
    WHERE tenant_id=1 AND id=?`,
  JSON.stringify({ approvalMode: 'owner_review' }), JSON.stringify(tenantPolicy), enterpriseManagerRoute.taskId);
  q.run(`UPDATE approvals
    SET rules_hit=?,approval_level=?,assigned_reviewer_id=?,approval_policy_snapshot=?
    WHERE tenant_id=1 AND id=?`,
  JSON.stringify(['employee_output_review', 'employee_approval:owner_review', 'owner_policy:manager']),
  route.firstStep.level, route.firstStep.assignedReviewerId, JSON.stringify(route.snapshot),
  enterpriseManagerRoute.approvalId);
});

function appFor(actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(1, () => {
    req.user = actor;
    next();
  }));
  app.use('/marshals', marshalRoutes);
  app.use('/employee-outputs', outputRoutes);
  app.use('/system', systemRoutes);
  return app;
}

async function withServer(actor, fn) {
  const server = appFor(actor).listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function jsonRequest(base, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test('直属经理只能在审批队列、产出透视和两个决策入口处理本团队产出', async () => {
  await withServer(actors.managerA, async base => {
    const queue = await jsonRequest(base, `/system/approvals?status=${encodeURIComponent('待审核')}`);
    assert.equal(queue.response.status, 200);
    assert.equal(queue.payload.some(item => Number(item.id) === inScope.approvalId), true);
    assert.equal(queue.payload.some(item => Number(item.id) === lateral.approvalId), false);

    const aggregate = await jsonRequest(base,
      '/employee-outputs?start=2026-07-01&end=2026-08-31&source=task');
    assert.equal(aggregate.response.status, 200);
    assert.equal(aggregate.payload.rows.some(item => item.ref === `task:${inScope.taskId}`), true);
    assert.equal(aggregate.payload.rows.some(item => item.ref === `task:${lateral.taskId}`), false);

    const ownDrill = await jsonRequest(base, `/employee-outputs/drill/task/${inScope.taskId}`);
    assert.equal(ownDrill.response.status, 200);
    assert.equal(ownDrill.payload.record.canReview, true);
    const lateralDrill = await jsonRequest(base, `/employee-outputs/drill/task/${lateral.taskId}`);
    assert.equal(lateralDrill.response.status, 404);

    const directDenied = await jsonRequest(base, `/marshals/outputs/${lateral.outputId}/review`, {
      method: 'POST',
      body: { decision: 'adopt', reason: '不应跨组审阅' },
    });
    assert.equal(directDenied.response.status, 403);
    assert.match(directDenied.payload.error, /直属团队|无权/u);

    const systemDenied = await jsonRequest(base, `/system/approvals/${lateral.approvalId}/decide`, {
      method: 'POST',
      body: { pass: false, reason: '不应跨组驳回' },
    });
    assert.equal(systemDenied.response.status, 403);
    assert.match(systemDenied.payload.error, /直属团队|无权/u);

    const ownAccepted = await jsonRequest(base, `/system/approvals/${inScope.approvalId}/decide`, {
      method: 'POST',
      body: { pass: true, reason: 'A组直属经理验收通过' },
    });
    assert.equal(ownAccepted.response.status, 200, JSON.stringify(ownAccepted.payload));
  });

  assert.equal(q.get('SELECT status FROM contents WHERE tenant_id=1 AND id=?', inScope.outputId).status, '可使用');
  assert.equal(q.get('SELECT status FROM contents WHERE tenant_id=1 AND id=?', lateral.outputId).status, '待审核');
  assert.equal(q.get('SELECT status FROM approvals WHERE tenant_id=1 AND id=?', lateral.approvalId).status, '待审核');
});

test('老板和管理员全租户可见，运营总监可审下属团队的横向任务', async () => {
  for (const actor of [actors.boss, actors.admin, actors.ops]) {
    await withServer(actor, async base => {
      const queue = await jsonRequest(base, `/system/approvals?status=${encodeURIComponent('待审核')}`);
      assert.equal(queue.response.status, 200, actor.role);
      assert.equal(queue.payload.some(item => Number(item.id) === lateral.approvalId), true, actor.role);
    });
  }

  await withServer(actors.ops, async base => {
    const accepted = await jsonRequest(base, `/marshals/outputs/${lateral.outputId}/review`, {
      method: 'POST',
      body: { decision: 'adopt', reason: '运营总监验收B组产出' },
    });
    assert.equal(accepted.response.status, 200, JSON.stringify(accepted.payload));
  });
  assert.equal(q.get('SELECT status FROM contents WHERE tenant_id=1 AND id=?', lateral.outputId).status, '可使用');
});

test('中央v2负责人策略锁定后，指定负责人能够真实处理而不是假配置', async () => {
  await withServer(actors.managerA, async base => {
    const queue = await jsonRequest(base, `/system/approvals?status=${encodeURIComponent('待审核')}`);
    const row = queue.payload.find(item => Number(item.id) === enterpriseManagerRoute.approvalId);
    assert.ok(row);
    assert.equal(row.approval_level, 'ops_director');
    assert.equal(Number(row.assigned_reviewer_id), managerAId);
    assert.equal(row.canPass, true);

    const accepted = await jsonRequest(base, `/system/approvals/${enterpriseManagerRoute.approvalId}/decide`, {
      method: 'POST',
      body: { pass: true, reason: '按老板企业风险规则由指定负责人采纳' },
    });
    assert.equal(accepted.response.status, 200, JSON.stringify(accepted.payload));
  });
  assert.equal(
    q.get('SELECT status FROM contents WHERE tenant_id=1 AND id=?', enterpriseManagerRoute.outputId).status,
    '可使用',
  );
});

test('错用户、错feature/kind与contents伪造settled不得绕过两个采纳入口', async () => {
  await withServer(actors.managerA, async base => {
    const aggregate = await jsonRequest(base,
      '/employee-outputs?start=2026-07-01&end=2026-08-31&source=task');
    const row = aggregate.payload.rows.find(item => item.ref === `task:${billingConflict.taskId}`);
    assert.equal(row.status, '待账务对账');
    assert.equal(row.hasOutput, false);

    const systemDenied = await jsonRequest(base,
      `/system/approvals/${billingConflict.approvalId}/decide`, {
        method: 'POST', body: { pass: true, reason: '伪造账务不得通过' },
      });
    assert.equal(systemDenied.response.status, 409);
    assert.match(systemDenied.payload.error, /结算|对账|账务/u);

    const directDenied = await jsonRequest(base,
      `/marshals/outputs/${billingConflict.outputId}/review`, {
        method: 'POST', body: { decision: 'adopt', reason: '伪造账务不得通过' },
      });
    assert.equal(directDenied.response.status, 409);
    assert.match(directDenied.payload.error, /结算|对账|账务/u);
  });
});

after(() => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* test cleanup */ }
  }
});
