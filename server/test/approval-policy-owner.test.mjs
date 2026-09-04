/**
 * B9 审批策略下放企业老板：
 * - boss/admin 可写，sales/ops_director/manager 不可写，platform_super 在任一租户上下文可写；
 * - 三条底线服务端硬编码，PUT 试图关闭 → 400；
 * - 策略按租户隔离（sys_config `approval_routing_policy:<tenant>`）；
 * - 按分部/岗位例外解析进派活快照（员工例外 > 分部例外 > 企业默认）；
 * - 大白话 preview 与服务端纯函数同口径（快照式断言）。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-approval-policy-owner-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
}
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';
delete process.env.NANOWORK_EMPLOYEE_OUTPUT_STYLE;

const { db, initSchema, migrateV2, q, qRaw, runWithTenant, getConfig } = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const { loadRestaurantCatalog } = await import('../src/catalog/restaurant.js');
const {
  APPROVAL_ROUTING_POLICY_KEY,
  DEFAULT_APPROVAL_ROUTING_POLICY,
  approvalPolicyCatalogIndex,
  assertApprovalSafeguardsNotDisabled,
  normalizeApprovalRoutingPolicy,
  parseApprovalWorkflowSnapshot,
  renderApprovalPolicyPlainText,
  resolveApprovalRoute,
  resolveEmployeeOutputPolicy,
} = await import('../src/engines/approval-routing-policy.js');
const systemRoutes = (await import('../src/routes/system.js')).default;
const marshalRoutes = (await import('../src/routes/marshals.js')).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();
qRaw.run(`UPDATE tenants SET name='审批下放租户一',status='已开通',credits=200000 WHERE id=1`);
qRaw.run(`INSERT INTO tenants(id,name,status,credits,total_recharged,seat_limit)
  VALUES(2,'审批下放租户二','已开通',200000,0,20)`);
runWithTenant(1, () => ensureBaselineCatalogs());

function insertUser({ username, name, role, tenantId = 1 }) {
  return Number(qRaw.run(`INSERT INTO users(username,password_hash,name,role,dept,status,tenant_id,credits)
    VALUES(?,?,?,?,?,?,?,?)`,
  username, hashPassword('OwnerPolicy123'), name, role, '审批测试部', '启用', tenantId, 200_000).lastInsertRowid);
}

const ids = {
  boss: insertUser({ username: 'owner_policy_boss', name: '张老板', role: 'boss' }),
  admin: insertUser({ username: 'owner_policy_admin', name: '系统管理员', role: 'admin' }),
  ops: insertUser({ username: 'owner_policy_ops', name: '王店长', role: 'ops_director' }),
  manager: insertUser({ username: 'owner_policy_manager', name: '李经理', role: 'manager' }),
  sales: insertUser({ username: 'owner_policy_sales', name: '一线员工', role: 'sales' }),
  platformSuper: insertUser({ username: 'owner_policy_platform', name: '平台超管', role: 'platform_super' }),
  bossTwo: insertUser({ username: 'owner_policy_boss_2', name: '租户二老板', role: 'boss', tenantId: 2 }),
  platformOnTwo: insertUser({ username: 'owner_policy_platform_2', name: '平台超管(租户二)', role: 'platform_super', tenantId: 2 }),
};

const actors = {
  boss: { id: ids.boss, name: '张老板', role: 'boss', tenant_id: 1 },
  admin: { id: ids.admin, name: '系统管理员', role: 'admin', tenant_id: 1 },
  ops: { id: ids.ops, name: '王店长', role: 'ops_director', tenant_id: 1 },
  manager: { id: ids.manager, name: '李经理', role: 'manager', tenant_id: 1 },
  sales: { id: ids.sales, name: '一线员工', role: 'sales', tenant_id: 1 },
  platformSuper: { id: ids.platformSuper, name: '平台超管', role: 'platform_super', tenant_id: 1 },
  bossTwo: { id: ids.bossTwo, name: '租户二老板', role: 'boss', tenant_id: 2 },
  platformOnTwo: { id: ids.platformOnTwo, name: '平台超管(租户二)', role: 'platform_super', tenant_id: 2 },
};

const CATALOG = loadRestaurantCatalog();
const CATALOG_INDEX = approvalPolicyCatalogIndex(CATALOG);
const FINANCE_DEPARTMENT = [...CATALOG_INDEX.departments.values()].find(item => item.name.includes('财务'));
assert.ok(FINANCE_DEPARTMENT, '目录必须包含财务与数据部');
const FINANCE_EMPLOYEE_IDX = [...CATALOG_INDEX.employees.values()]
  .find(item => item.departmentCode === FINANCE_DEPARTMENT.code)?.idx;
assert.ok(FINANCE_EMPLOYEE_IDX, '财务与数据部必须有成员');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.locals.employeeEstimateCallCredits = () => 100;
app.locals.employeeWebSearch = async () => ({ attempted: true, ok: true, provider: 'offline', results: [], evidence: { externalCall: false } });
app.locals.employeeAgenticWebResearch = async () => ({ attempted: true, ok: false, candidateReady: false, provider: 'offline', results: [], evidence: { externalCall: false } });
app.locals.employeeLocationIntelligence = async () => ({ attempted: false, ok: false, provider: 'offline', results: [] });
app.locals.employeeControlledWebFetch = async () => ({ attempted: false, ok: false, provider: 'offline', results: [] });
app.locals.employeeGenerate = async args => ({
  text: '# 离线测试报告\n\n本轮为策略快照测试。\n\n## 下一步建议\n1. 无\n2. 无\n3. 无\n',
  mode: 'api',
  model: args.model,
  usage: { inputTokens: 200, outputTokens: 80 },
  finishReason: 'stop',
});
app.use((req, res, next) => {
  const actor = actors[String(req.get('x-test-actor') || '')];
  if (!actor) return res.status(401).json({ error: '测试身份不存在' });
  return runWithTenant(actor.tenant_id, () => {
    req.user = actor;
    next();
  });
});
app.use('/sys', systemRoutes);
app.use('/marshals', marshalRoutes);

const server = app.listen(0);
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => setTimeout(resolve, 50));
  try { db.close(); } catch { /* ignore */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
});

async function api(actor, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-actor': actor },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

function storedPolicy(tenantId) {
  return getConfig(`${APPROVAL_ROUTING_POLICY_KEY}:${tenantId}`, null);
}

test('老板与系统管理员可写审批规则，一线员工/店长/经理只读且不可写', async () => {
  for (const actor of ['sales', 'ops', 'manager']) {
    const denied = await api(actor, '/sys/approval-policy', {
      method: 'PUT',
      body: { policy: { employeeOutput: { mode: 'boss' } } },
    });
    assert.equal(denied.status, 403, `${actor}: ${JSON.stringify(denied.json)}`);
  }
  const salesRead = await api('sales', '/sys/approval-policy');
  assert.equal(salesRead.status, 403, '一线员工不在审批规则可见角色内');

  const bossView = await api('boss', '/sys/approval-policy');
  assert.equal(bossView.status, 200);
  assert.equal(bossView.json.canEdit, true);
  assert.equal(bossView.json.catalog.departments.length, 8);
  assert.equal(bossView.json.catalog.employees.length, 61);
  assert.deepEqual(bossView.json.exceptionModes, ['auto', 'risk_based', 'manager', 'boss']);
  assert.equal(bossView.json.immutableSafeguards.length, 3);

  const saved = await api('boss', '/sys/approval-policy', {
    method: 'PUT',
    body: { policy: { employeeOutput: { mode: 'risk_based' }, activityPlan: { mode: 'amount_threshold', ownerAmountThreshold: 20000 } } },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.policy.employeeOutput.mode, 'risk_based');
  assert.equal(saved.json.policy.configuredBy.id, ids.boss);
  assert.equal(saved.json.policy.configuredBy.role, 'boss');
  assert.ok(Array.isArray(saved.json.preview.lines), '保存响应携带大白话预览');
  assert.equal(storedPolicy(1).employeeOutput.mode, 'risk_based', '策略以租户级 key 落库');

  const adminSaved = await api('admin', '/sys/approval-policy', {
    method: 'PUT',
    body: { policy: { employeeOutput: { mode: 'manager', reviewerUserId: ids.ops } } },
  });
  assert.equal(adminSaved.status, 200, JSON.stringify(adminSaved.json));
  assert.equal(adminSaved.json.policy.configuredBy.role, 'admin');
  assert.equal(adminSaved.json.policy.employeeOutput.reviewerUserId, ids.ops);
});

test('三条底线不可被 PUT 关闭：显式传 false 返回 400，且不覆盖现行规则', async () => {
  await api('boss', '/sys/approval-policy', { method: 'PUT', body: { policy: { employeeOutput: { mode: 'auto' } } } });
  const attempts = [
    { safeguards: { externalActionOwnerAuthorization: false } },
    { safeguards: { paidActionOwnerAuthorization: false } },
    { safeguards: { irreversibleActionOwnerAuthorization: false } },
    { safeguards: { internalOutputReviewControlledByPolicy: 0 } },
    { safeguards: 'off' },
  ];
  for (const attempt of attempts) {
    const rejected = await api('boss', '/sys/approval-policy', {
      method: 'PUT',
      body: { policy: { employeeOutput: { mode: 'boss' }, ...attempt } },
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.json));
    assert.equal(rejected.json.code, 'APPROVAL_SAFEGUARD_LOCKED');
  }
  const platformRejected = await api('platformSuper', '/sys/approval-policy', {
    method: 'PUT',
    body: { policy: { safeguards: { paidActionOwnerAuthorization: false } } },
  });
  assert.equal(platformRejected.status, 400, '平台超管同样不能关闭底线');
  const current = await api('boss', '/sys/approval-policy');
  assert.equal(current.json.policy.employeeOutput.mode, 'auto', '失败的写入不得覆盖现行规则');
  assert.deepEqual(current.json.policy.safeguards, {
    internalOutputReviewControlledByPolicy: true,
    externalActionOwnerAuthorization: true,
    paidActionOwnerAuthorization: true,
    irreversibleActionOwnerAuthorization: true,
  });
  // 显式传 true 是允许的；缺省也允许（服务端硬编码补齐）。
  assert.doesNotThrow(() => assertApprovalSafeguardsNotDisabled({ safeguards: { paidActionOwnerAuthorization: true } }));
  assert.doesNotThrow(() => assertApprovalSafeguardsNotDisabled({ employeeOutput: { mode: 'auto' } }));
  const previewRejected = await api('boss', '/sys/approval-policy/preview', {
    method: 'POST',
    body: { policy: { safeguards: { externalActionOwnerAuthorization: false } } },
  });
  assert.equal(previewRejected.status, 400, '预览接口同样拒绝关闭底线的草稿');
});

test('策略按租户隔离：租户二老板与平台超管跨租户写入互不影响租户一', async () => {
  await api('boss', '/sys/approval-policy', { method: 'PUT', body: { policy: { employeeOutput: { mode: 'auto' } } } });
  const tenantTwoSaved = await api('bossTwo', '/sys/approval-policy', {
    method: 'PUT',
    body: { policy: { employeeOutput: { mode: 'boss' }, activityPlan: { mode: 'boss' } } },
  });
  assert.equal(tenantTwoSaved.status, 200, JSON.stringify(tenantTwoSaved.json));
  assert.equal(storedPolicy(2).employeeOutput.mode, 'boss');
  assert.equal(storedPolicy(1).employeeOutput.mode, 'auto', '租户一不受租户二写入影响');

  const platformOnTwo = await api('platformOnTwo', '/sys/approval-policy', {
    method: 'PUT',
    body: { policy: { employeeOutput: { mode: 'manager' } } },
  });
  assert.equal(platformOnTwo.status, 200, JSON.stringify(platformOnTwo.json));
  assert.equal(storedPolicy(2).employeeOutput.mode, 'manager', '平台超管在租户二上下文写租户二');
  assert.equal(storedPolicy(1).employeeOutput.mode, 'auto');
  const tenantOneView = await api('boss', '/sys/approval-policy');
  assert.equal(tenantOneView.json.policy.employeeOutput.mode, 'auto');
  const tenantTwoView = await api('bossTwo', '/sys/approval-policy');
  assert.equal(tenantTwoView.json.policy.employeeOutput.mode, 'manager');
  assert.equal(tenantTwoView.json.policy.configuredBy.role, 'platform_super');
});

test('例外规则：结构与目录校验，员工例外优先于分部例外，未命中回落默认', async () => {
  const invalidCases = [
    [{ scope: 'store', id: 'M-01', mode: 'boss' }, /scope不支持/],
    [{ scope: 'department', id: 'M-99', mode: 'boss' }, /不存在的分部/],
    [{ scope: 'employee', id: 999, mode: 'boss' }, /不存在的数字员工编号/],
    [{ scope: 'employee', id: 'abc', mode: 'boss' }, /员工编号不正确/],
    [{ scope: 'department', id: 'M-01', mode: 'employee_setting' }, /mode不支持/],
  ];
  for (const [exception, pattern] of invalidCases) {
    const rejected = await api('boss', '/sys/approval-policy', {
      method: 'PUT',
      body: { policy: { employeeOutput: { mode: 'auto', exceptions: [exception] } } },
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.json));
    assert.match(rejected.json.error, pattern);
  }
  const duplicated = await api('boss', '/sys/approval-policy', {
    method: 'PUT',
    body: { policy: { employeeOutput: { mode: 'auto', exceptions: [
      { scope: 'department', id: FINANCE_DEPARTMENT.code, mode: 'boss' },
      { scope: 'department', id: FINANCE_DEPARTMENT.code.toLowerCase(), mode: 'manager' },
    ] } } },
  });
  assert.equal(duplicated.status, 400);
  assert.match(duplicated.json.error, /重复/);

  const saved = await api('boss', '/sys/approval-policy', {
    method: 'PUT',
    body: { policy: { employeeOutput: { mode: 'auto', exceptions: [
      { scope: 'department', id: FINANCE_DEPARTMENT.code, mode: 'boss' },
      { scope: 'employee', id: String(FINANCE_EMPLOYEE_IDX), mode: 'manager' },
    ] } } },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(saved.json.policy.employeeOutput.exceptions, [
    { scope: 'department', id: FINANCE_DEPARTMENT.code, mode: 'boss' },
    { scope: 'employee', id: FINANCE_EMPLOYEE_IDX, mode: 'manager' },
  ]);
  assert.equal(saved.json.policy.employeeOutput.resolved, undefined, '保存的企业默认规则不含派活解析结果');

  const policy = saved.json.policy;
  const departmentHit = resolveEmployeeOutputPolicy(policy, { departmentCode: FINANCE_DEPARTMENT.code, employeeIdx: null });
  assert.equal(departmentHit.employeeOutput.mode, 'boss');
  assert.deepEqual(departmentHit.employeeOutput.resolved, {
    mode: 'boss',
    baseMode: 'auto',
    matched: { scope: 'department', id: FINANCE_DEPARTMENT.code, mode: 'boss' },
    departmentCode: FINANCE_DEPARTMENT.code,
    employeeIdx: null,
  });
  const employeeHit = resolveEmployeeOutputPolicy(policy, { departmentCode: FINANCE_DEPARTMENT.code, employeeIdx: FINANCE_EMPLOYEE_IDX });
  assert.equal(employeeHit.employeeOutput.mode, 'manager', '员工例外优先于分部例外');
  assert.equal(employeeHit.employeeOutput.resolved.matched.scope, 'employee');
  const miss = resolveEmployeeOutputPolicy(policy, { departmentCode: 'M-01', employeeIdx: 101 });
  assert.equal(miss.employeeOutput.mode, 'auto');
  assert.equal(miss.employeeOutput.resolved.matched, null);

  // 解析后的快照进入路由：分部例外让普通员工的低风险产出也要老板审。
  const route = resolveApprovalRoute({
    targetType: 'content',
    riskLevel: 'low',
    actorRole: 'sales',
    policy: departmentHit,
  });
  assert.equal(route.requiresReview, true);
  assert.deepEqual(route.steps, [{ level: 'boss', assignedReviewerId: null }]);
  assert.equal(route.snapshot.policyMode, 'boss');
  assert.equal(route.snapshot.policyResolution.matched.scope, 'department');
  // 带解析信息的工作流快照仍可被严格解析器接受。
  assert.deepEqual(parseApprovalWorkflowSnapshot(route.snapshot).steps, route.snapshot.steps);
  // 再次 normalize 不丢失解析结果与例外列表。
  const renormalized = normalizeApprovalRoutingPolicy(JSON.parse(JSON.stringify(departmentHit)));
  assert.equal(renormalized.employeeOutput.mode, 'boss');
  assert.equal(renormalized.employeeOutput.resolved.baseMode, 'auto');
  assert.equal(renormalized.employeeOutput.exceptions.length, 2);
  // 默认策略没有例外键，保持既有快照形状。
  assert.equal(normalizeApprovalRoutingPolicy().employeeOutput.exceptions, undefined);
});

test('派活时快照锁定解析后的最终模式（分部例外命中）', async () => {
  const saved = await api('boss', '/sys/approval-policy', {
    method: 'PUT',
    body: { policy: { employeeOutput: { mode: 'auto', exceptions: [
      { scope: 'department', id: FINANCE_DEPARTMENT.code, mode: 'boss' },
    ] } } },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const financeSpecialist = runWithTenant(1, () => q.get(
    `SELECT s.id,s.marshal_id,s.employee_idx,m.code FROM specialists s JOIN marshals m ON m.id=s.marshal_id
     WHERE s.employee_idx=? LIMIT 1`, FINANCE_EMPLOYEE_IDX));
  assert.ok(financeSpecialist?.id, '基线目录必须包含财务与数据部员工');
  assert.equal(financeSpecialist.code, FINANCE_DEPARTMENT.code, '分部编号与目录顺序一致');
  const otherSpecialist = runWithTenant(1, () => q.get(
    `SELECT s.id,s.marshal_id,s.employee_idx,m.code FROM specialists s JOIN marshals m ON m.id=s.marshal_id
     WHERE m.code='M-01' AND s.employee_idx BETWEEN 101 AND 161 LIMIT 1`));
  assert.ok(otherSpecialist?.id);

  async function dispatch(specialist) {
    const response = await api('boss', `/marshals/${specialist.marshal_id}/tasks`, {
      method: 'POST',
      body: { specialistId: specialist.id, title: `例外快照测试-${specialist.employee_idx}`, type: '经营诊断', requirement: '验证审批策略快照解析。' },
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const taskId = Number(response.json.taskId);
    let row = null;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      row = runWithTenant(1, () => q.get(`SELECT status,approval_routing_policy_snapshot FROM agent_tasks WHERE tenant_id=1 AND id=?`, taskId));
      if (row?.status && row.status !== '生成中') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(row?.approval_routing_policy_snapshot, '派活必须写入策略快照');
    return JSON.parse(row.approval_routing_policy_snapshot);
  }

  const financeSnapshot = await dispatch(financeSpecialist);
  assert.equal(financeSnapshot.employeeOutput.mode, 'boss', '财务与数据部产出按例外锁定为老板审');
  assert.equal(financeSnapshot.employeeOutput.resolved.baseMode, 'auto');
  assert.deepEqual(financeSnapshot.employeeOutput.resolved.matched, { scope: 'department', id: FINANCE_DEPARTMENT.code, mode: 'boss' });
  assert.equal(financeSnapshot.employeeOutput.resolved.departmentCode, FINANCE_DEPARTMENT.code);
  assert.equal(financeSnapshot.employeeOutput.resolved.employeeIdx, FINANCE_EMPLOYEE_IDX);
  assert.equal(financeSnapshot.safeguards.paidActionOwnerAuthorization, true);

  const otherSnapshot = await dispatch(otherSpecialist);
  assert.equal(otherSnapshot.employeeOutput.mode, 'auto', '未命中例外的分部沿用企业默认');
  assert.equal(otherSnapshot.employeeOutput.resolved.matched, null);

  // 改规则不回写在途快照
  await api('boss', '/sys/approval-policy', { method: 'PUT', body: { policy: { employeeOutput: { mode: 'boss' } } } });
  const after = runWithTenant(1, () => q.all(`SELECT approval_routing_policy_snapshot FROM agent_tasks WHERE tenant_id=1 ORDER BY id DESC LIMIT 2`));
  assert.equal(JSON.parse(after[1].approval_routing_policy_snapshot).employeeOutput.mode, 'boss');
  assert.equal(JSON.parse(after[0].approval_routing_policy_snapshot).employeeOutput.mode, 'auto');
});

test('大白话预览：四种员工产出模式、阈值、例外与底线（快照式断言）', async () => {
  const render = (policy, options) => renderApprovalPolicyPlainText(policy, { catalogIndex: CATALOG_INDEX, ...options }).lines
    .map(line => line.text);

  assert.deepEqual(render(DEFAULT_APPROVAL_ROUTING_POLICY), [
    '数字员工的日常产出：自动采用，不用你审。',
    '涉及对外发布、花钱、不可撤销的动作：一律先经你授权。这三条是底线，改不了。',
    '营销活动方案：先由店长（负责人）初审，再由你终审。',
    '活动执行清单（物料、食安、人员分工）：先由店长（负责人）确认，再由你终审。',
    '你自己发起的任务视同已授权，系统不会再给你派一张“请你审你自己”的待办。',
  ]);

  assert.equal(
    render({ employeeOutput: { mode: 'risk_based' } })[0],
    '数字员工的日常产出：按风险分流——低风险自动采用，中风险由店长审，高风险由你亲自审。',
  );
  assert.equal(
    render({ employeeOutput: { mode: 'manager', reviewerUserId: 77 } }, { reviewerNames: new Map([[77, '王店长']]) })[0],
    '数字员工的日常产出：先由店长审过才算数（审批人：你指定的 王店长）。',
  );
  assert.equal(render({ employeeOutput: { mode: 'boss' } })[0], '数字员工的日常产出：每一份都要你亲自审。');

  const planLines = render({
    activityPlan: { mode: 'amount_threshold', ownerAmountThreshold: 10_000 },
    activityChecklist: { mode: 'manager' },
  });
  assert.equal(planLines[2], '营销活动方案：金额达到 1 万元需要你签字，否则店长（负责人）可批。');
  assert.equal(planLines[3], '活动执行清单（物料、食安、人员分工）：店长（负责人）确认即可。');
  assert.equal(
    render({ activityPlan: { mode: 'amount_threshold', ownerAmountThreshold: 5_000 } })[2],
    '营销活动方案：金额达到 5,000 元需要你签字，否则店长（负责人）可批。',
  );
  assert.equal(render({ activityPlan: { mode: 'manager' } })[2], '营销活动方案：店长（负责人）审过即可，不用你签字。');
  assert.equal(render({ activityPlan: { mode: 'boss' } })[2], '营销活动方案：每一份都要你签字。');
  assert.equal(render({ activityChecklist: { mode: 'boss' } })[3], '活动执行清单（物料、食安、人员分工）：每一项都要你确认。');

  const withExceptions = render({
    employeeOutput: {
      mode: 'auto',
      exceptions: [
        { scope: 'department', id: FINANCE_DEPARTMENT.code, mode: 'boss' },
        { scope: 'employee', id: 101, mode: 'auto' },
      ],
    },
  });
  assert.equal(withExceptions[1], `例外：${FINANCE_DEPARTMENT.name}的产出一律由你亲自审。`);
  assert.equal(withExceptions[2], '例外：赵先机·餐饮市场机会研究（编号 101）的产出自动采用，不用你审。');

  // 服务端接口与纯函数同口径
  await api('boss', '/sys/approval-policy', {
    method: 'PUT',
    body: { policy: { employeeOutput: { mode: 'auto' }, activityPlan: { mode: 'amount_threshold', ownerAmountThreshold: 10_000 } } },
  });
  const previewGet = await api('boss', '/sys/approval-policy/preview');
  assert.equal(previewGet.status, 200);
  assert.equal(previewGet.json.lines[0].text, '数字员工的日常产出：自动采用，不用你审。');
  assert.equal(previewGet.json.lines[2].text, '营销活动方案：金额达到 1 万元需要你签字，否则店长（负责人）可批。');
  assert.equal(previewGet.json.text.split('\n').length, previewGet.json.lines.length);

  const previewDraft = await api('manager', '/sys/approval-policy/preview', {
    method: 'POST',
    body: { policy: { employeeOutput: { mode: 'boss' }, activityPlan: { mode: 'manager', reviewerUserId: ids.ops } } },
  });
  assert.equal(previewDraft.status, 200, JSON.stringify(previewDraft.json));
  assert.equal(previewDraft.json.lines[0].text, '数字员工的日常产出：每一份都要你亲自审。');
  assert.equal(previewDraft.json.lines[2].text, '营销活动方案：你指定的 王店长审过即可，不用你签字。');
  const salesPreview = await api('sales', '/sys/approval-policy/preview');
  assert.equal(salesPreview.status, 403);
});
