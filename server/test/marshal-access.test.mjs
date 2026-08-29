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
const { holdCredits, settleHold } = await import('../src/engines/credits.js');
const marshalRoutes = (await import('../src/routes/marshals.js')).default;
const systemRoutes = (await import('../src/routes/system.js')).default;

initSchema();
migrateV2();
seed();
migrateV2();
q.run(`UPDATE tenants SET credits=100000 WHERE id=1`);

const boss = q.get(`SELECT id,name,role,tenant_id FROM users WHERE tenant_id=1 AND role='boss' ORDER BY id LIMIT 1`);
const ops = q.get(`SELECT id,name,role,tenant_id FROM users WHERE tenant_id=1 AND role='ops_director' ORDER BY id LIMIT 1`);
const managerId = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id,manager_id)
  VALUES(?,?,?,?,?,?,?)`, 'marshal-manager', hashPassword('Secret123!'), '元帅直属经理', 'manager', '启用', 1, ops.id).lastInsertRowid;
const manager = q.get(`SELECT id,name,role,tenant_id FROM users WHERE id=?`, managerId);
const adminId = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'marshal-admin', hashPassword('Secret123!'), '元帅管理员', 'admin', '启用', 1).lastInsertRowid;
const admin = q.get(`SELECT id,name,role,tenant_id FROM users WHERE id=?`, adminId);
const platformId = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'marshal-platform', hashPassword('Secret123!'), '元帅平台超管', 'platform_super', '启用', 1).lastInsertRowid;
const platform = q.get(`SELECT id,name,role,tenant_id FROM users WHERE id=?`, platformId);
const employeeA = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'marshal-employee-a', hashPassword('Secret123!'), '元帅员工A', 'sales', '启用', 1).lastInsertRowid;
const employeeB = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'marshal-employee-b', hashPassword('Secret123!'), '元帅员工B', 'sales', '启用', 1).lastInsertRowid;
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(2,'元帅租户二','已开通',10000)
  ON CONFLICT(id) DO UPDATE SET status=excluded.status`);
const employeeC = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'marshal-employee-c', hashPassword('Secret123!'), '元帅员工C', 'sales', '启用', 2).lastInsertRowid;
const specialistId = q.get(`SELECT id FROM specialists WHERE marshal_id=1 ORDER BY id LIMIT 1`).id;
const marshalName = q.get('SELECT name FROM marshals WHERE id=1').name;

function settleTaskFixture(taskId, userId, label) {
  const hold = holdCredits({
    userId,
    feature: `员工任务·${marshalName}`,
    kind: 'text',
    model: 'test-model',
    credits: 3,
    refType: 'agent_task',
    refId: Number(taskId),
  });
  settleHold(hold, {
    credits: 1,
    aiMode: 'api',
    model: 'test-model',
    usage: { inputTokens: 100, outputTokens: 20 },
    note: `测试餐饮任务#${taskId}真实结算凭证`,
  });
}

let taskA; let taskB; let taskC; let outputA; let outputB;
runWithTenant(1, () => {
  taskA = q.run(`INSERT INTO agent_tasks(marshal_id,specialist_id,title,status,created_by) VALUES(1,?,'A的私有任务','待审阅',?)`, specialistId, employeeA).lastInsertRowid;
  taskB = q.run(`INSERT INTO agent_tasks(marshal_id,specialist_id,title,status,created_by) VALUES(1,?,'B的私有任务','待审阅',?)`, specialistId, employeeB).lastInsertRowid;
  outputA = q.run(`INSERT INTO contents(type,title,body,status,risk_level,creator_id,marshal_id,ai_mode)
    VALUES('元帅产出','A的产出','A内容','待审核','none',?,1,'api')`, employeeA).lastInsertRowid;
  outputB = q.run(`INSERT INTO contents(type,title,body,status,risk_level,creator_id,marshal_id,ai_mode)
    VALUES('元帅产出','B的高风险产出','B内容','待审核','high',?,1,'api')`, employeeB).lastInsertRowid;
  q.run(`UPDATE agent_tasks SET output_id=? WHERE id=?`, outputA, taskA);
  q.run(`UPDATE agent_tasks SET output_id=? WHERE id=?`, outputB, taskB);
  settleTaskFixture(taskA, employeeA, 'A的私有任务');
  settleTaskFixture(taskB, employeeB, 'B的私有任务');
  q.run(`INSERT INTO approvals(target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,approval_level)
    VALUES('content',?,'B的高风险产出','B内容','high','[]','待审核',?,'boss')`, outputB, employeeB);
});
runWithTenant(2, () => {
  taskC = q.run(`INSERT INTO agent_tasks(marshal_id,specialist_id,title,status,created_by) VALUES(1,?,'C租户私有任务','生成中',?)`, specialistId, employeeC).lastInsertRowid;
});

function appFor(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => { req.user = user; next(); }));
  app.use('/marshals', marshalRoutes);
  app.use('/sys', systemRoutes);
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

test('员工不能自审；两个审批入口复用权威事务且重复采纳不重复沉淀', async () => {
  const user = { id: employeeA, name: '元帅员工A', role: 'sales', tenant_id: 1 };
  await withServer(user, async base => {
    const denied = await fetch(`${base}/marshals/outputs/${outputB}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'adopt' }),
    });
    assert.equal(denied.status, 403);
    const selfReview = await fetch(`${base}/marshals/outputs/${outputA}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'adopt' }),
    });
    assert.equal(selfReview.status, 403);
  });

  const adopt = base => fetch(`${base}/marshals/outputs/${outputA}/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'adopt' }),
  }).then(async response => ({ status: response.status, body: await response.json() }));
  await withServer(boss, async base => {
    assert.equal((await adopt(base)).body.ok, true);
    const repeated = await adopt(base);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.alreadyReviewed, true);
  });

  const approvalB = q.get(`SELECT id FROM approvals WHERE tenant_id=1 AND target_type='content' AND target_id=?`, outputB).id;
  await withServer(ops, async base => {
    const denied = await fetch(`${base}/sys/approvals/${approvalB}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass: true }),
    });
    assert.equal(denied.status, 403);
  });
  await withServer(admin, async base => {
    const denied = await fetch(`${base}/sys/approvals/${approvalB}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass: true }),
    });
    assert.equal(denied.status, 403);
  });
  await withServer(boss, async base => {
    const decide = () => fetch(`${base}/sys/approvals/${approvalB}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass: true }),
    }).then(async response => ({ status: response.status, body: await response.json() }));
    const first = await decide();
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    const repeated = await decide();
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.alreadyReviewed, true);
  });

  for (const outputId of [outputA, outputB]) {
    assert.equal(q.get(`SELECT status FROM contents WHERE tenant_id=1 AND id=?`, outputId).status, '可使用');
    assert.equal(q.get(`SELECT status FROM agent_tasks WHERE tenant_id=1 AND output_id=?`, outputId).status, '已完成');
    assert.equal(q.get(`SELECT status FROM approvals WHERE tenant_id=1 AND target_type='content' AND target_id=?`, outputId).status, '已通过');
    assert.equal(q.get(`SELECT COUNT(*) n FROM kb_docs WHERE tenant_id=1 AND source_type='content' AND source_id=?`, outputId).n, 1);
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1 AND source_type='content' AND source_id=?`, outputId).n, 1);
  }

  let rejectedOutputId;
  let rejectedTaskId;
  runWithTenant(1, () => {
    rejectedTaskId = q.run(`INSERT INTO agent_tasks(marshal_id,specialist_id,title,status,created_by)
      VALUES(1,?,'待驳回任务','待审阅',?)`, specialistId, employeeA).lastInsertRowid;
    rejectedOutputId = q.run(`INSERT INTO contents(type,title,body,status,risk_level,creator_id,marshal_id,ai_mode)
      VALUES('元帅产出','待驳回产出','需要返工','待审核','none',?,1,'api')`, employeeA).lastInsertRowid;
    q.run(`UPDATE agent_tasks SET output_id=? WHERE id=?`, rejectedOutputId, rejectedTaskId);
    settleTaskFixture(rejectedTaskId, employeeA, '待驳回任务');
    q.run(`INSERT INTO approvals(target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id)
      VALUES('content',?,'待驳回产出','需要返工','none','[]','待审核',?)`, rejectedOutputId, employeeA);
  });
  await withServer(boss, async base => {
    const reject = () => fetch(`${base}/marshals/outputs/${rejectedOutputId}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'reject', reason: '关键经营依据不足' }),
    }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.equal((await reject()).status, 200);
    const repeated = await reject();
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.alreadyReviewed, true);
  });
  assert.equal(q.get(`SELECT status FROM contents WHERE id=?`, rejectedOutputId).status, '已驳回');
  assert.equal(q.get(`SELECT status FROM agent_tasks WHERE id=?`, rejectedTaskId).status, '已驳回');
  const rejection = q.get(`SELECT status,reviewer_id,reason,decided_at FROM approvals
    WHERE tenant_id=1 AND target_type='content' AND target_id=?`, rejectedOutputId);
  assert.equal(rejection.status, '已驳回');
  assert.equal(rejection.reviewer_id, boss.id);
  assert.equal(rejection.reason, '关键经营依据不足');
  assert.ok(rejection.decided_at);
  assert.equal(q.get(`SELECT COUNT(*) n FROM kb_docs WHERE tenant_id=1 AND source_type='content' AND source_id=?`, rejectedOutputId).n, 0);
  assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1 AND source_type='content' AND source_id=?`, rejectedOutputId).n, 0);
});

test('餐饮员工产出计费待对账时不进入人工审阅，通过与驳回都被拦截', async () => {
  const balanceBeforeHold = Number(q.get('SELECT credits FROM tenants WHERE id=1').credits);
  const row = runWithTenant(1, () => {
    const taskId = Number(q.run(`INSERT INTO agent_tasks(
      marshal_id,specialist_id,title,status,created_by
    ) VALUES(1,?,'待对账产出任务','待审阅',?)`, specialistId, employeeA).lastInsertRowid);
    const outputId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,risk_level,creator_id,marshal_id,ai_mode
    ) VALUES('员工产出','待对账产出','已生成但计费尚未结算','待审核','none',?,1,'api')`, employeeA).lastInsertRowid);
    q.run('UPDATE agent_tasks SET output_id=? WHERE id=?', outputId, taskId);
    const approvalId = Number(q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id
    ) VALUES('content',?,'待对账产出','已生成但计费尚未结算','none','[]','待审核',?)`,
    outputId, employeeA).lastInsertRowid);
    const hold = holdCredits({
      userId: employeeA,
      feature: '餐饮员工待对账验收',
      kind: 'text',
      model: 'gpt-5.5',
      credits: 17,
      refType: 'agent_task',
      refId: taskId,
    });
    return { taskId, outputId, approvalId, hold };
  });

  await withServer(boss, async base => {
    const approvals = await fetch(`${base}/sys/approvals?status=${encodeURIComponent('待审核')}`);
    assert.equal(approvals.status, 200);
    const approvalRows = await approvals.json();
    const pending = approvalRows.find(item => Number(item.id) === row.approvalId);
    assert.equal(pending.canPass, false);
    assert.equal(pending.canReject, false);
    assert.equal(pending.reviewStatus, '待账务对账');
    assert.match(pending.passBlockedReason, /待账务对账/u);
    assert.match(pending.rejectBlockedReason, /不进入人工审阅/u);

    const adopt = await fetch(`${base}/sys/approvals/${row.approvalId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pass: true }),
    });
    assert.equal(adopt.status, 409);
    assert.match((await adopt.json()).error, /待账务对账.*业务暂不可采用/u);

    const reject = await fetch(`${base}/sys/approvals/${row.approvalId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pass: false, reason: '计费未结算，重新派活' }),
    });
    assert.equal(reject.status, 409);
    assert.match((await reject.json()).error, /不进入人工审阅.*账务对账/u);

    const directReject = await fetch(`${base}/marshals/outputs/${row.outputId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'reject', reason: '直接入口也不得绕过对账' }),
    });
    assert.equal(directReject.status, 409);
    assert.match((await directReject.json()).error, /不进入人工审阅.*账务对账/u);
  });

  assert.equal(q.get('SELECT status FROM contents WHERE id=?', row.outputId).status, '待审核');
  assert.equal(q.get('SELECT status FROM agent_tasks WHERE id=?', row.taskId).status, '待审阅');
  assert.equal(q.get('SELECT status FROM approvals WHERE id=?', row.approvalId).status, '待审核');
  const released = q.get(`SELECT status,settled_credits,settled_at FROM credit_holds
    WHERE id=?`, row.hold.holdId);
  assert.equal(released.status, 'held');
  assert.equal(released.settled_credits, null);
  assert.equal(released.settled_at, null);
  assert.equal(Number(q.get('SELECT credits FROM tenants WHERE id=1').credits), balanceBeforeHold - 17);
  assert.doesNotMatch(q.get('SELECT note FROM credit_logs WHERE id=?', row.hold.logId).note || '', /驳回|全额退回/u);
  assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets
    WHERE tenant_id=1 AND source_type='content' AND source_id=?`, row.outputId).n, 0);
});

test("低风险但approval_level='boss'在两个入口都只允许老板终审", async () => {
  const createBossReviewCase = label => runWithTenant(1, () => {
    const taskId = q.run(`INSERT INTO agent_tasks(marshal_id,specialist_id,title,status,created_by)
      VALUES(1,?,?,?,?)`, specialistId, `${label}任务`, '待审阅', employeeA).lastInsertRowid;
    const outputId = q.run(`INSERT INTO contents(type,title,body,status,risk_level,creator_id,marshal_id,ai_mode)
      VALUES('元帅产出',?,?,'待审核','none',?,1,'api')`, `${label}产出`, `${label}正文`, employeeA).lastInsertRowid;
    q.run(`UPDATE agent_tasks SET output_id=? WHERE id=?`, outputId, taskId);
    settleTaskFixture(taskId, employeeA, label);
    const approvalId = q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,approval_level
    ) VALUES('content',?,?,?,'none','[]','待审核',?,'boss')`,
    outputId, `${label}产出`, `${label}正文`, employeeA).lastInsertRowid;
    return { taskId, outputId, approvalId };
  });

  const bossOnly = createBossReviewCase('老板专审');
  for (const actor of [ops, manager, admin, platform]) {
    await withServer(actor, async base => {
      const response = await fetch(`${base}/sys/approvals/${bossOnly.approvalId}/decide`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass: true }),
      });
      assert.equal(response.status, 403, actor.role);
    });
  }
  assert.equal(q.get(`SELECT status FROM approvals WHERE id=?`, bossOnly.approvalId).status, '待审核');
  assert.equal(q.get(`SELECT status FROM contents WHERE id=?`, bossOnly.outputId).status, '待审核');
  assert.equal(q.get(`SELECT status FROM agent_tasks WHERE id=?`, bossOnly.taskId).status, '待审阅');

  await withServer(boss, async base => {
    const response = await fetch(`${base}/marshals/outputs/${bossOnly.outputId}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'adopt' }),
    });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  });
  assert.equal(q.get(`SELECT status,reviewer_id FROM approvals WHERE id=?`, bossOnly.approvalId).status, '已通过');
  assert.equal(q.get(`SELECT status,reviewer_id FROM approvals WHERE id=?`, bossOnly.approvalId).reviewer_id, boss.id);
  assert.equal(q.get(`SELECT status FROM contents WHERE id=?`, bossOnly.outputId).status, '可使用');
  assert.equal(q.get(`SELECT status FROM agent_tasks WHERE id=?`, bossOnly.taskId).status, '已完成');
});

test('模板与无效契约产出可以驳回但绝不能采纳、入资产或知识库', async () => {
  const cases = runWithTenant(1, () => [
    { label: '模板产出', mode: 'template', snapshot: null, reason: /模板|真实可交付/u },
    {
      label: '契约无效产出',
      mode: 'api',
      snapshot: JSON.stringify({ contract: { status: 'invalid', valid: false, errors: ['缺少必填交付字段'] } }),
      reason: /缺少必填交付字段/u,
    },
  ].map(item => {
    const taskId = Number(q.run(`INSERT INTO agent_tasks(
      marshal_id,specialist_id,title,status,created_by
    ) VALUES(1,?,?,'待审阅',?)`, specialistId, `${item.label}任务`, employeeA).lastInsertRowid);
    const outputId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,risk_level,creator_id,marshal_id,ai_mode,snapshot_json
    ) VALUES('元帅产出',?,?,'待审核','none',?,1,?,?)`,
    item.label, `${item.label}正文`, employeeA, item.mode, item.snapshot).lastInsertRowid);
    q.run(`UPDATE agent_tasks SET output_id=? WHERE id=?`, outputId, taskId);
    const approvalId = Number(q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id
    ) VALUES('content',?,?,?,'none','[]','待审核',?)`,
    outputId, item.label, `${item.label}正文`, employeeA).lastInsertRowid);
    return { ...item, taskId, outputId, approvalId };
  }));

  await withServer(boss, async base => {
    const queueResponse = await fetch(`${base}/sys/approvals?status=${encodeURIComponent('待审核')}`);
    assert.equal(queueResponse.status, 200);
    const queue = await queueResponse.json();
    for (const item of cases) {
      const queueItem = queue.find(row => Number(row.id) === item.approvalId);
      assert.ok(queueItem, item.label);
      assert.equal(queueItem.canPass, false, item.label);
      assert.equal(queueItem.canReject, true, item.label);
      assert.match(queueItem.passBlockedReason, item.reason, item.label);

      const response = await fetch(`${base}/sys/approvals/${item.approvalId}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass: true }),
      });
      const blocked = await response.json();
      assert.equal(response.status, 409, `${item.label}:${JSON.stringify(blocked)}`);
      assert.match(blocked.error, item.reason, item.label);

      const rejected = await fetch(`${base}/sys/approvals/${item.approvalId}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass: false, reason: '质检未通过，请修复后重新派活' }),
      });
      assert.equal(rejected.status, 200, `${item.label}:${JSON.stringify(await rejected.json())}`);
    }
  });

  for (const item of cases) {
    assert.equal(q.get(`SELECT status FROM contents WHERE id=?`, item.outputId).status, '已驳回');
    assert.equal(q.get(`SELECT status FROM agent_tasks WHERE id=?`, item.taskId).status, '已驳回');
    assert.equal(q.get(`SELECT status FROM approvals WHERE id=?`, item.approvalId).status, '已驳回');
    assert.equal(q.get(`SELECT COUNT(*) n FROM kb_docs WHERE tenant_id=1
      AND source_type='content' AND source_id=?`, item.outputId).n, 0);
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1
      AND source_type='content' AND source_id=?`, item.outputId).n, 0);
  }
});

test('已通过版本即使数据被错误改回待审核，审批引擎也必须409拒绝原地再审', async () => {
  const item = runWithTenant(1, () => {
    const taskId = Number(q.run(`INSERT INTO agent_tasks(
      marshal_id,specialist_id,title,status,created_by
    ) VALUES(1,?,'回退异常任务','待审阅',?)`, specialistId, employeeA).lastInsertRowid);
    const outputId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,risk_level,creator_id,marshal_id,ai_mode
    ) VALUES('元帅产出','已通过却回退','已通过版本正文','待审核','none',?,1,'api')`,
    employeeA).lastInsertRowid);
    q.run(`UPDATE agent_tasks SET output_id=? WHERE id=?`, outputId, taskId);
    settleTaskFixture(taskId, employeeA, '已通过却回退');
    const approvalId = Number(q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,reviewer_id,decided_at
    ) VALUES('content',?,'已通过却回退','正文','none','[]','已通过',?,?,datetime('now','localtime'))`,
    outputId, employeeA, boss.id).lastInsertRowid);
    return { taskId, outputId, approvalId };
  });

  await withServer(boss, async base => {
    const response = await fetch(`${base}/sys/approvals/${item.approvalId}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass: true }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /新建修订稿/u);
  });
  assert.equal(q.get(`SELECT status FROM contents WHERE id=?`, item.outputId).status, '待审核');
  assert.equal(q.get(`SELECT status FROM approvals WHERE id=?`, item.approvalId).status, '已通过');
});

test('非内容审批的列表按钮与提交接口复用同一权限结论', async () => {
  const cases = runWithTenant(1, () => ({
    normal: Number(q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id
    ) VALUES('generic',900001,'通用普通审批','用于验证权限一致','none','[]','待审核',?)`,
    employeeA).lastInsertRowid),
    bossOnly: Number(q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,approval_level
    ) VALUES('generic',900002,'通用老板专审','只允许老板处理','none','[]','待审核',?,'boss')`,
    employeeA).lastInsertRowid),
    highRisk: Number(q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id
    ) VALUES('generic',900003,'通用高风险审批','高风险只允许老板处理','high','[]','待审核',?)`,
    employeeA).lastInsertRowid),
  }));

  await withServer(manager, async base => {
    const response = await fetch(`${base}/sys/approvals?status=${encodeURIComponent('待审核')}`);
    assert.equal(response.status, 200);
    const rows = await response.json();
    const visible = rows.find(row => Number(row.id) === cases.normal);
    assert.ok(visible, '直属经理可看到通用审批状态');
    assert.equal(visible.canPass, false);
    assert.equal(visible.canReject, false);
    const blocked = await fetch(`${base}/sys/approvals/${cases.normal}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pass: true }),
    });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error, visible.passBlockedReason);
  });

  await withServer(ops, async base => {
    const response = await fetch(`${base}/sys/approvals?status=${encodeURIComponent('待审核')}`);
    assert.equal(response.status, 200);
    const rows = await response.json();
    const normal = rows.find(row => Number(row.id) === cases.normal);
    const bossOnly = rows.find(row => Number(row.id) === cases.bossOnly);
    const highRisk = rows.find(row => Number(row.id) === cases.highRisk);
    assert.equal(normal.canPass, true);
    assert.equal(normal.canReject, true);
    for (const item of [bossOnly, highRisk]) {
      assert.ok(item);
      assert.equal(item.canPass, false);
      const blocked = await fetch(`${base}/sys/approvals/${item.id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass: true }),
      });
      assert.equal(blocked.status, 403);
      assert.equal((await blocked.json()).error, item.passBlockedReason);
    }
    const accepted = await fetch(`${base}/sys/approvals/${cases.normal}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pass: true }),
    });
    assert.equal(accepted.status, 200, JSON.stringify(await accepted.clone().json()));
  });

  await withServer(boss, async base => {
    for (const id of [cases.bossOnly, cases.highRisk]) {
      const response = await fetch(`${base}/sys/approvals?status=${encodeURIComponent('待审核')}`);
      const row = (await response.json()).find(item => Number(item.id) === id);
      assert.ok(row);
      assert.equal(row.canPass, true);
      assert.equal(row.canReject, true);
      const accepted = await fetch(`${base}/sys/approvals/${id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass: true }),
      });
      assert.equal(accepted.status, 200, JSON.stringify(await accepted.clone().json()));
    }
  });

  assert.equal(q.get('SELECT status FROM approvals WHERE id=?', cases.normal).status, '已通过');
  assert.equal(q.get('SELECT status FROM approvals WHERE id=?', cases.bossOnly).status, '已通过');
  assert.equal(q.get('SELECT status FROM approvals WHERE id=?', cases.highRisk).status, '已通过');
});

test('审批可见性必须在分页前生效，总数与兼容返回均不漏单', async () => {
  const scopedEmployeeId = Number(q.run(`INSERT INTO users(
    username,password_hash,name,role,status,tenant_id,manager_id
  ) VALUES(?,?,?,?,?,?,?)`, 'marshal-scoped-pagination', hashPassword('Secret123!'),
  '分页验收直属员工', 'sales', '启用', 1, manager.id).lastInsertRowid);
  const markerStatus = '分页可见性验收';
  const visibleApprovalId = runWithTenant(1, () => {
    const visibleContentId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,risk_level,creator_id,ai_mode
    ) VALUES('分页验收','最早的可见审批','应在过滤后分页','待审核','none',?,'manual')`,
    scopedEmployeeId).lastInsertRowid);
    const visibleId = Number(q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id
    ) VALUES('content',?,'最早的可见审批','应在过滤后分页','none','[]',?,?)`,
    visibleContentId, markerStatus, scopedEmployeeId).lastInsertRowid);
    for (let index = 1; index <= 60; index += 1) {
      const contentId = Number(q.run(`INSERT INTO contents(
        type,title,body,status,risk_level,creator_id,ai_mode
      ) VALUES('分页验收',?,?,'待审核','none',?,'manual')`,
      `链外新审批${index}`, '直属经理不应看到', employeeB).lastInsertRowid);
      q.run(`INSERT INTO approvals(
        target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id
      ) VALUES('content',?,?,?,'none','[]',?,?)`,
      contentId, `链外新审批${index}`, '直属经理不应看到', markerStatus, employeeB);
    }
    return visibleId;
  });

  await withServer(manager, async base => {
    const metaResponse = await fetch(`${base}/sys/approvals?status=${encodeURIComponent(markerStatus)}&limit=50&meta=1`);
    assert.equal(metaResponse.status, 200);
    assert.equal(metaResponse.headers.get('x-total-count'), '1');
    const meta = await metaResponse.json();
    assert.equal(meta.total, 1);
    assert.equal(meta.limit, 50);
    assert.equal(meta.offset, 0);
    assert.equal(meta.hasMore, false);
    assert.deepEqual(meta.rows.map(row => Number(row.id)), [visibleApprovalId]);

    const legacyResponse = await fetch(`${base}/sys/approvals?status=${encodeURIComponent(markerStatus)}&limit=50`);
    assert.equal(legacyResponse.status, 200);
    const legacyRows = await legacyResponse.json();
    assert.ok(Array.isArray(legacyRows), '旧版前端仍应收到数组');
    assert.deepEqual(legacyRows.map(row => Number(row.id)), [visibleApprovalId]);
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
      { body: { title: '伪ISO日期', dueAt: '2026-02-31T10:00:00+08:00' }, error: /截止时间/ },
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

    const zonedDueAt = await fetch(`${base}/marshals/1/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '带时区截止时间',
        dueAt: '2026-07-30T18:00:00+08:00',
      }),
    });
    assert.equal(zonedDueAt.status, 200, JSON.stringify(await zonedDueAt.clone().json()));
    const dispatched = await zonedDueAt.json();
    assert.equal(q.get(`SELECT due_at FROM agent_tasks WHERE tenant_id=1 AND id=?`, dispatched.taskId).due_at,
      '2026-07-30 10:00:00');

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
