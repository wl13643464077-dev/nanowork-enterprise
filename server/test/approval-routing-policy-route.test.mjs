import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-approval-routing-route-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const {
  db,
  initSchema,
  migrateV2,
  q,
  qRaw,
  runWithTenant,
} = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
const activitiesRoutes = (await import('../src/routes/activities.js')).default;
const systemRoutes = (await import('../src/routes/system.js')).default;

initSchema();
migrateV2();
qRaw.run(`UPDATE tenants SET name='审批策略租户一',status='已开通',credits=100000 WHERE id=1`);
qRaw.run(`INSERT INTO tenants(id,name,status,credits,total_recharged,seat_limit)
  VALUES(2,'审批策略租户二','已开通',100000,0,20)`);

function insertUser({ username, name, role, tenantId = 1, status = '启用', managerId = null }) {
  return Number(qRaw.run(`INSERT INTO users(
      username,password_hash,name,role,dept,status,manager_id,tenant_id
    ) VALUES(?,?,?,?,?,?,?,?)`,
  username, hashPassword('ApprovalRoute123'), name, role, '审批测试部', status, managerId, tenantId).lastInsertRowid);
}

const ids = {
  platformSuper: insertUser({ username: 'approval_route_platform_super', name: '平台超级管理员', role: 'platform_super' }),
  boss: insertUser({ username: 'approval_route_boss', name: '测试老板', role: 'boss' }),
  admin: insertUser({ username: 'approval_route_admin', name: '测试管理员', role: 'admin' }),
  opsOne: insertUser({ username: 'approval_route_ops_1', name: '负责人甲', role: 'ops_director' }),
  opsTwo: insertUser({ username: 'approval_route_ops_2', name: '负责人乙', role: 'ops_director' }),
  manager: insertUser({ username: 'approval_route_manager', name: '直属经理', role: 'manager' }),
  disabledOps: insertUser({
    username: 'approval_route_disabled', name: '已停用负责人', role: 'ops_director', status: '停用',
  }),
  sales: insertUser({ username: 'approval_route_sales', name: '普通员工', role: 'sales' }),
  crossTenantOps: insertUser({
    username: 'approval_route_cross_tenant', name: '其他企业负责人', role: 'ops_director', tenantId: 2,
  }),
};

const actors = {
  platformSuper: { id: ids.platformSuper, name: '平台超级管理员', role: 'platform_super', tenant_id: 1 },
  boss: { id: ids.boss, name: '测试老板', role: 'boss', tenant_id: 1 },
  admin: { id: ids.admin, name: '测试管理员', role: 'admin', tenant_id: 1 },
  opsOne: { id: ids.opsOne, name: '负责人甲', role: 'ops_director', tenant_id: 1 },
  opsTwo: { id: ids.opsTwo, name: '负责人乙', role: 'ops_director', tenant_id: 1 },
  manager: { id: ids.manager, name: '直属经理', role: 'manager', tenant_id: 1 },
  sales: { id: ids.sales, name: '普通员工', role: 'sales', tenant_id: 1 },
};

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  const actor = actors[String(req.get('x-test-actor') || '')];
  if (!actor) return res.status(401).json({ error: '测试身份不存在' });
  return runWithTenant(actor.tenant_id, () => {
    req.user = actor;
    next();
  });
});
app.use('/activities', activitiesRoutes);
app.use('/sys', systemRoutes);

const server = app.listen(0);
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => setTimeout(resolve, 30));
  try { db.close(); } catch {}
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

async function api(actor, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-test-actor': actor,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    json: await response.json().catch(() => ({})),
  };
}

function policyWithActivityPlan(activityPlan) {
  return {
    policy: {
      activityPlan,
    },
  };
}

async function savePlanPolicy(actor, activityPlan, expectedStatus = 200) {
  const response = await api(actor, '/sys/approval-policy', {
    method: 'PUT',
    body: policyWithActivityPlan(activityPlan),
  });
  assert.equal(response.status, expectedStatus, JSON.stringify(response.json));
  return response.json;
}

let activitySequence = 0;
const samplePlan = {
  theme: '老板自定义审批链路验收',
  flow: [{ time: '19:00', item: '签到与安全说明' }],
  materials: ['签到表'],
  invites: '已授权顾客',
  sop: ['活动前复核场地与参与名单'],
  kpi: { inviteSign: 30, signArrive: 70, arriveDeal: 20, roi: 1.5 },
  budgetNote: '以活动预算字段为审批金额依据',
};

// Approval-routing scenarios must use a non-self-authorizing submitter.  Boss and
// platform_super sessions intentionally bypass approval creation; that contract
// is covered by activity-approval.test.mjs.  Keeping the route tests on a normal
// employee session exercises the configured manager/boss chain itself.
async function createSubmittedPlan({ budget, actor = 'sales' }) {
  activitySequence += 1;
  const created = await api(actor, '/activities', {
    method: 'POST',
    body: {
      title: `审批路由活动-${activitySequence}`,
      date: `2026-09-${String(10 + activitySequence).padStart(2, '0')}`,
      type: '主题活动',
      budget,
      target_join: 20,
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const activityId = Number(created.json.id);
  const submitted = await api(actor, `/activities/${activityId}/plan/submit`, {
    method: 'POST',
    body: { plan: { ...samplePlan, theme: `审批路由活动-${activitySequence}` } },
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.json));
  return { activityId, submitted: submitted.json };
}

function approvalsFor(activityId) {
  return q.all(`SELECT * FROM approvals
    WHERE tenant_id=1 AND target_type='activity_plan' AND target_id=? ORDER BY id`, activityId);
}

async function decide(actor, approvalId, pass = true, reason = undefined) {
  return api(actor, `/sys/approvals/${approvalId}/decide`, {
    method: 'POST',
    body: { pass, ...(reason === undefined ? {} : { reason }) },
  });
}

test('管理层可查看审批规则，老板/管理员/平台超级管理员可修改，负责人与经理不可修改', async () => {
  // B9 审批策略下放：boss/admin 现在是企业级编辑者；ops_director/manager 仍只读。
  for (const actor of ['opsOne', 'manager']) {
    const visible = await api(actor, '/sys/approval-policy');
    assert.equal(visible.status, 200, JSON.stringify(visible.json));
    assert.equal(visible.json.canEdit, false);
    assert.equal(visible.json.policy.schemaVersion, 'nanowork.approval-routing-policy/2');
    assert.equal(visible.json.policy.employeeOutput.mode, 'auto');
    assert.equal(visible.json.policy.activityPlan.mode, 'two_step');
    assert.deepEqual(visible.json.reviewerCandidates, [], '非编辑者不需要取得审批人候选名单');

    const denied = await api(actor, '/sys/approval-policy', {
      method: 'PUT',
      body: policyWithActivityPlan({ mode: 'manager', reviewerUserId: ids.opsOne }),
    });
    assert.equal(denied.status, 403, `${actor}: ${JSON.stringify(denied.json)}`);
    assert.equal(denied.json.error, '无权限执行此操作');
  }
  for (const actor of ['boss', 'admin']) {
    const visible = await api(actor, '/sys/approval-policy');
    assert.equal(visible.status, 200, JSON.stringify(visible.json));
    assert.equal(visible.json.canEdit, true, `${actor} 应可编辑企业审批规则`);
    assert.ok(visible.json.reviewerCandidates.length > 0);
  }
  const bossSaved = await savePlanPolicy('boss', { mode: 'boss' });
  assert.equal(bossSaved.policy.activityPlan.mode, 'boss');
  assert.equal(bossSaved.policy.configuredBy.role, 'boss');
  const adminSaved = await savePlanPolicy('admin', { mode: 'two_step' });
  assert.equal(adminSaved.policy.configuredBy.role, 'admin');

  const platformSaved = await savePlanPolicy('platformSuper', {
    mode: 'manager', reviewerUserId: ids.opsOne,
  });
  assert.equal(platformSaved.policy.activityPlan.mode, 'manager');
  assert.equal(platformSaved.policy.configuredBy.id, ids.platformSuper);
  assert.equal(platformSaved.policy.configuredBy.role, 'platform_super');
  const platformVisible = await api('platformSuper', '/sys/approval-policy');
  assert.equal(platformVisible.status, 200);
  assert.equal(platformVisible.json.canEdit, true);
  assert.ok(platformVisible.json.reviewerCandidates.length > 0);

  const legacyWrite = await api('platformSuper', '/sys/approval-policy', {
    method: 'PUT',
    body: {
      policy: {
        schemaVersion: 'nanowork.approval-routing-policy/1',
        employeeOutput: { mode: 'employee_setting' },
      },
    },
  });
  assert.equal(legacyWrite.status, 400);
  assert.match(legacyWrite.json.error, /employeeOutput\.mode不支持/);
});

test('指定审批人必须是本企业启用且角色正确的负责人，失败配置不会覆盖现行规则', async () => {
  await savePlanPolicy('platformSuper', { mode: 'manager', reviewerUserId: ids.opsOne });
  const invalidCases = [
    ['跨租户负责人', ids.crossTenantOps],
    ['停用负责人', ids.disabledOps],
    ['活动审批不允许直属经理', ids.manager],
    ['普通员工', ids.sales],
  ];
  for (const [label, reviewerUserId] of invalidCases) {
    const rejected = await api('platformSuper', '/sys/approval-policy', {
      method: 'PUT',
      body: policyWithActivityPlan({ mode: 'manager', reviewerUserId }),
    });
    assert.equal(rejected.status, 400, `${label}: ${JSON.stringify(rejected.json)}`);
    assert.equal(rejected.json.code, 'APPROVAL_REVIEWER_INVALID', label);
  }

  const current = await api('platformSuper', '/sys/approval-policy');
  assert.equal(current.status, 200);
  assert.equal(current.json.policy.activityPlan.mode, 'manager');
  assert.equal(current.json.policy.activityPlan.reviewerUserId, ids.opsOne);
});

test('负责人单级审批通过后活动方案直接终态，不再偷偷生成老板审批单', async () => {
  await savePlanPolicy('platformSuper', { mode: 'manager', reviewerUserId: ids.opsOne });
  const { activityId } = await createSubmittedPlan({ budget: 3_000 });
  const first = approvalsFor(activityId);
  assert.equal(first.length, 1);
  assert.equal(first[0].approval_level, 'ops_director');
  assert.equal(Number(first[0].assigned_reviewer_id), ids.opsOne);

  const accepted = await decide('opsOne', first[0].id);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  assert.equal(q.get(`SELECT plan_status FROM activities WHERE tenant_id=1 AND id=?`, activityId).plan_status, '已通过');
  const all = approvalsFor(activityId);
  assert.equal(all.length, 1, '单级负责人审批不得追加老板审批单');
  assert.equal(all[0].status, '已通过');
  assert.equal(all.filter(row => row.status === '待审核').length, 0);
});

test('两级审批仍按负责人初审、老板终审逐级推进', async () => {
  await savePlanPolicy('platformSuper', { mode: 'two_step', reviewerUserId: ids.opsOne });
  const { activityId } = await createSubmittedPlan({ budget: 3_000 });
  const first = approvalsFor(activityId)[0];
  assert.equal(first.approval_level, 'ops_director');
  assert.equal(Number(first.assigned_reviewer_id), ids.opsOne);

  const firstDecision = await decide('opsOne', first.id);
  assert.equal(firstDecision.status, 200, JSON.stringify(firstDecision.json));
  assert.match(firstDecision.json.message, /老板终审/);
  const afterFirst = approvalsFor(activityId);
  assert.equal(afterFirst.length, 2);
  assert.equal(afterFirst[0].status, '已通过');
  assert.equal(afterFirst[1].status, '待审核');
  assert.equal(afterFirst[1].approval_level, 'boss');
  assert.equal(afterFirst[1].parent_id, first.id);
  assert.equal(q.get(`SELECT plan_status FROM activities WHERE tenant_id=1 AND id=?`, activityId).plan_status, '总审中');

  const finalDecision = await decide('boss', afterFirst[1].id);
  assert.equal(finalDecision.status, 200, JSON.stringify(finalDecision.json));
  assert.equal(q.get(`SELECT plan_status FROM activities WHERE tenant_id=1 AND id=?`, activityId).plan_status, '已通过');
  assert.equal(approvalsFor(activityId).filter(row => row.status === '待审核').length, 0);
});

test('金额阈值规则让小额方案走负责人、大额方案直接走老板', async () => {
  await savePlanPolicy('platformSuper', {
    mode: 'amount_threshold',
    reviewerUserId: ids.opsOne,
    ownerAmountThreshold: 5_000,
  });

  const small = await createSubmittedPlan({ budget: 4_999.99 });
  const smallApproval = approvalsFor(small.activityId)[0];
  assert.equal(smallApproval.approval_level, 'ops_director');
  assert.equal(Number(smallApproval.assigned_reviewer_id), ids.opsOne);
  const smallDecision = await decide('opsOne', smallApproval.id);
  assert.equal(smallDecision.status, 200, JSON.stringify(smallDecision.json));
  assert.equal(q.get(`SELECT plan_status FROM activities WHERE tenant_id=1 AND id=?`, small.activityId).plan_status, '已通过');
  assert.equal(approvalsFor(small.activityId).length, 1);

  const large = await createSubmittedPlan({ budget: 5_000 });
  const largeApproval = approvalsFor(large.activityId)[0];
  assert.equal(largeApproval.approval_level, 'boss');
  assert.equal(largeApproval.assigned_reviewer_id, null);
  const managerDenied = await decide('opsOne', largeApproval.id);
  assert.equal(managerDenied.status, 403, JSON.stringify(managerDenied.json));
  assert.equal(q.get(`SELECT status FROM approvals WHERE tenant_id=1 AND id=?`, largeApproval.id).status, '待审核');
  const ownerAccepted = await decide('boss', largeApproval.id);
  assert.equal(ownerAccepted.status, 200, JSON.stringify(ownerAccepted.json));
  assert.equal(q.get(`SELECT plan_status FROM activities WHERE tenant_id=1 AND id=?`, large.activityId).plan_status, '已通过');
});

test('小额提交后提高预算会作废旧审批并重新按大额老板门禁路由', async () => {
  await savePlanPolicy('platformSuper', {
    mode: 'amount_threshold',
    reviewerUserId: ids.opsOne,
    ownerAmountThreshold: 5_000,
  });
  const first = await createSubmittedPlan({ budget: 4_000 });
  const oldApproval = approvalsFor(first.activityId)[0];
  assert.equal(oldApproval.approval_level, 'ops_director');

  const updated = await api('boss', `/activities/${first.activityId}`, {
    method: 'PUT',
    body: { budget: 8_000 },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.equal(updated.json.approvalReset, true);
  assert.equal(updated.json.plan_status, '草稿');
  assert.equal(q.get('SELECT status FROM approvals WHERE tenant_id=1 AND id=?', oldApproval.id).status, '已驳回');

  const staleDecision = await decide('opsOne', oldApproval.id);
  assert.equal(staleDecision.status, 409, JSON.stringify(staleDecision.json));
  // Re-submit as the regular employee after the owner edits the activity; a
  // Boss session is intentionally self-authorizing and would skip this route.
  const resubmitted = await api('sales', `/activities/${first.activityId}/plan/submit`, {
    method: 'POST',
    body: { plan: { ...samplePlan, theme: '提高预算后重新提交' } },
  });
  assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.json));
  const current = approvalsFor(first.activityId).at(-1);
  assert.equal(current.status, '待审核');
  assert.equal(current.approval_level, 'boss');

  const tampered = await createSubmittedPlan({ budget: 4_500 });
  const tamperedApproval = approvalsFor(tampered.activityId)[0];
  q.run('UPDATE activities SET budget=9000 WHERE tenant_id=1 AND id=?', tampered.activityId);
  const failClosed = await decide('opsOne', tamperedApproval.id);
  assert.equal(failClosed.status, 409, JSON.stringify(failClosed.json));
  assert.equal(failClosed.json.code, 'ACTIVITY_APPROVAL_SUBJECT_CHANGED');
  assert.equal(q.get('SELECT status FROM approvals WHERE tenant_id=1 AND id=?', tamperedApproval.id).status, '待审核');
  assert.equal(q.get('SELECT plan_status FROM activities WHERE tenant_id=1 AND id=?', tampered.activityId).plan_status, '待审批');
});

test('指定审批人以外的负责人返回403，老板可作为兜底审批人直接处理', async () => {
  await savePlanPolicy('platformSuper', { mode: 'manager', reviewerUserId: ids.opsOne });
  const { activityId } = await createSubmittedPlan({ budget: 2_000 });
  const approval = approvalsFor(activityId)[0];

  const wrongReviewer = await decide('opsTwo', approval.id);
  assert.equal(wrongReviewer.status, 403, JSON.stringify(wrongReviewer.json));
  assert.match(wrongReviewer.json.error, /指定给其他负责人/);
  assert.equal(q.get(`SELECT status FROM approvals WHERE tenant_id=1 AND id=?`, approval.id).status, '待审核');

  const ownerFallback = await decide('boss', approval.id);
  assert.equal(ownerFallback.status, 200, JSON.stringify(ownerFallback.json));
  assert.equal(q.get(`SELECT plan_status FROM activities WHERE tenant_id=1 AND id=?`, activityId).plan_status, '已通过');
  assert.equal(approvalsFor(activityId).length, 1);
});

test('老板修改规则只影响新任务，在途两级审批继续使用提交时锁定的快照', async () => {
  await savePlanPolicy('platformSuper', { mode: 'two_step', reviewerUserId: ids.opsOne });
  const { activityId } = await createSubmittedPlan({ budget: 2_500 });
  const inFlight = approvalsFor(activityId)[0];
  const lockedSnapshot = inFlight.approval_policy_snapshot;

  await savePlanPolicy('platformSuper', { mode: 'manager', reviewerUserId: ids.opsTwo });
  const firstDecision = await decide('opsOne', inFlight.id);
  assert.equal(firstDecision.status, 200, JSON.stringify(firstDecision.json));
  const rows = approvalsFor(activityId);
  assert.equal(rows.length, 2, '在途 two_step 不得被新 manager 规则截断');
  assert.equal(rows[1].approval_level, 'boss');
  assert.equal(rows[1].assigned_reviewer_id, null);
  assert.notEqual(rows[1].assigned_reviewer_id, ids.opsTwo);
  assert.equal(rows[0].approval_policy_snapshot, lockedSnapshot, '历史审批快照不可被规则更新回写');

  const nextSnapshot = JSON.parse(rows[1].approval_policy_snapshot);
  assert.equal(nextSnapshot.policyMode, 'two_step');
  assert.equal(nextSnapshot.currentStep, 1);
  assert.equal(Number(nextSnapshot.steps[0].assignedReviewerId), ids.opsOne);
});

test('审批快照被篡改后路由返回409并保持业务与审批状态不变', async () => {
  await savePlanPolicy('platformSuper', { mode: 'manager', reviewerUserId: ids.opsOne });
  const { activityId } = await createSubmittedPlan({ budget: 1_500 });
  const approval = approvalsFor(activityId)[0];
  const snapshot = JSON.parse(approval.approval_policy_snapshot);
  snapshot.reason = 'owner_configured_boss';
  q.run(`UPDATE approvals SET approval_policy_snapshot=? WHERE tenant_id=1 AND id=?`,
    JSON.stringify(snapshot), approval.id);

  const blocked = await decide('opsOne', approval.id);
  assert.equal(blocked.status, 409, JSON.stringify(blocked.json));
  assert.match(blocked.json.error, /快照|审批路径|规则/);
  assert.equal(q.get(`SELECT status FROM approvals WHERE tenant_id=1 AND id=?`, approval.id).status, '待审核');
  assert.equal(q.get(`SELECT plan_status FROM activities WHERE tenant_id=1 AND id=?`, activityId).plan_status, '待审批');
  assert.equal(approvalsFor(activityId).length, 1);
});
