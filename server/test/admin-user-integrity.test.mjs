import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `shanmei-admin-user-integrity-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
const adminRoutes = (await import('../src/routes/admin.js')).default;
const systemRoutes = (await import('../src/routes/system.js')).default;

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits,total_recharged,seat_limit) VALUES(1,'管理测试企业','已开通',100,0,10)
  ON CONFLICT(id) DO UPDATE SET name='管理测试企业',status='已开通',credits=100,total_recharged=0,seat_limit=10`);
const bossId = q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES('admin_integrity_boss',?,'测试老板','boss','启用',1)`, hashPassword('BossPassword123')).lastInsertRowid;
const boss = { id: Number(bossId), name: '测试老板', role: 'boss', tenant_id: 1 };

function makeApp(user = boss) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(1, () => { req.user = user; next(); }));
  app.use('/admin', adminRoutes);
  app.use('/sys', systemRoutes);
  return app;
}

async function withServer(fn, user = boss) {
  const server = makeApp(user).listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function request(base, route, method, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

test('账号创建：角色和积分严格校验，账号与积分写入保持原子性', async () => {
  await withServer(async base => {
    const decimal = await request(base, '/admin/users', 'POST', {
      username: 'decimal_credit_user', password: 'Password123', name: '小数积分', role: 'sales', credits: 1.5,
    });
    assert.equal(decimal.status, 400);
    assert.equal(q.get(`SELECT COUNT(*) n FROM users WHERE username='decimal_credit_user'`).n, 0);

    const invalidRole = await request(base, '/admin/users', 'POST', {
      username: 'invalid_role_user', password: 'Password123', name: '越权角色', role: 'platform_super', credits: 0,
    });
    assert.equal(invalidRole.status, 400);
    assert.equal(q.get(`SELECT COUNT(*) n FROM users WHERE username='invalid_role_user'`).n, 0);

    const created = await request(base, '/admin/users', 'POST', {
      username: 'atomic_credit_user', password: 'Password123', name: '原子账号', role: 'sales', credits: 25,
    });
    assert.equal(created.status, 200);
    assert.equal(q.get(`SELECT role FROM users WHERE id=?`, created.json.id).role, 'sales');
    assert.equal(q.get(`SELECT credits FROM tenants WHERE id=1`).credits, 125);
    assert.equal(q.get(`SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=1 AND user_id=?`, created.json.id).n, 1);

    const invalidUpdate = await request(base, `/admin/users/${created.json.id}`, 'PUT', { role: 'platform_super' });
    assert.equal(invalidUpdate.status, 400);
    assert.equal(q.get(`SELECT role FROM users WHERE id=?`, created.json.id).role, 'sales');

    const adminVersionBefore = q.get(`SELECT auth_version FROM users WHERE id=?`, created.json.id).auth_version;
    const adminPasswordReset = await request(base, `/admin/users/${created.json.id}`, 'PUT', { password: 'NewAdminPassword123' });
    assert.equal(adminPasswordReset.status, 200);
    assert.equal(q.get(`SELECT auth_version FROM users WHERE id=?`, created.json.id).auth_version, adminVersionBefore + 1);

    const balanceBeforeMissingUser = q.get(`SELECT credits FROM tenants WHERE id=1`).credits;
    const missingUserAdjustment = await request(base, '/admin/credits/adjust', 'POST', {
      userId: 999999, delta: 50, note: '不应写入',
    });
    assert.equal(missingUserAdjustment.status, 404);
    assert.equal(q.get(`SELECT credits FROM tenants WHERE id=1`).credits, balanceBeforeMissingUser);
    assert.equal(q.get(`SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=1 AND user_id=999999`).n, 0);
  });
});

test('系统管理账号：非法字段整体拒绝，更新不会留下半成功状态', async () => {
  await withServer(async base => {
    const invalidRole = await request(base, '/sys/users', 'POST', {
      username: 'system_invalid_role', password: 'Password123', name: '非法角色', role: 'platform_super',
    });
    assert.equal(invalidRole.status, 400);
    assert.equal(q.get(`SELECT COUNT(*) n FROM users WHERE username='system_invalid_role'`).n, 0);

    const created = await request(base, '/sys/users', 'POST', {
      username: 'system_valid_user', password: 'Password123', name: '系统员工', role: 'sales', dept: '销售部',
    });
    assert.equal(created.status, 200);

    const invalidManager = await request(base, `/sys/users/${created.json.id}`, 'PUT', {
      name: '不应写入的新名字', manager_id: 999999,
    });
    assert.equal(invalidManager.status, 400);
    assert.equal(q.get(`SELECT name FROM users WHERE id=?`, created.json.id).name, '系统员工');

    const systemVersionBefore = q.get(`SELECT auth_version FROM users WHERE id=?`, created.json.id).auth_version;
    const systemPasswordReset = await request(base, `/sys/users/${created.json.id}`, 'PUT', { password: 'NewSystemPassword123' });
    assert.equal(systemPasswordReset.status, 200);
    assert.equal(q.get(`SELECT auth_version FROM users WHERE id=?`, created.json.id).auth_version, systemVersionBefore + 1);

    const selfDisable = await request(base, `/sys/users/${boss.id}`, 'PUT', { status: '停用' });
    assert.equal(selfDisable.status, 400);
    assert.equal(q.get(`SELECT status FROM users WHERE id=?`, boss.id).status, '启用');

    const legacyDisable = await request(base, `/sys/users/${created.json.id}`, 'PUT', { status: '停用' });
    assert.equal(legacyDisable.status, 400);
    assert.match(legacyDisable.json.error, /停用账号.*操作/u);
    assert.equal(q.get(`SELECT status FROM users WHERE id=?`, created.json.id).status, '启用');
  });
});

test('停用账号保留用户与历史归属，并原子停用其内容自动化规则', async () => {
  const targetId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES('soft_disable_user',?,'待停用员工','sales','启用',1)`, hashPassword('SoftDisable123')).lastInsertRowid);
  const contentId = Number(q.run(`INSERT INTO contents(type,title,body,status,creator_id)
    VALUES('朋友圈文案','历史内容','正文','可使用',?)`, targetId).lastInsertRowid);
  const taskId = Number(q.run(`INSERT INTO tasks(title,type,status,assignee_id)
    VALUES('历史任务','内容','已完成',?)`, targetId).lastInsertRowid);
  const approvalId = Number(q.run(`INSERT INTO approvals(target_type,target_id,title,status,submitter_id,reviewer_id)
    VALUES('content',?,'历史审批','已通过',?,?)`, contentId, targetId, targetId).lastInsertRowid);
  const enabledRuleId = Number(q.run(`INSERT INTO content_automation_rules(
    name,enabled,employee_idx,topic,requirement,content_type,content_count,
    frequency,run_time,weekday,approval_mode,next_run_at,created_by
  ) VALUES('待停用规则',1,3,'历史主题','','文案初稿',1,'daily','09:00',NULL,'always','2026-08-01 09:00:00',?)`,
  targetId).lastInsertRowid);
  const disabledRuleId = Number(q.run(`INSERT INTO content_automation_rules(
    name,enabled,employee_idx,topic,requirement,content_type,content_count,
    frequency,run_time,weekday,approval_mode,next_run_at,created_by
  ) VALUES('原本已停用规则',0,3,'历史主题','','文案初稿',1,'daily','10:00',NULL,'always',NULL,?)`,
  targetId).lastInsertRowid);
  const automationRunId = Number(q.run(`INSERT INTO content_automation_runs(
    rule_id,trigger,claim_key,status,initiated_by
  ) VALUES(?,'immediate','soft-disable-history','成功',?)`, enabledRuleId, targetId).lastInsertRowid);
  const authVersionBefore = Number(q.get('SELECT auth_version FROM users WHERE id=?', targetId).auth_version || 0);

  await withServer(async base => {
    const disabled = await request(base, `/sys/users/${targetId}`, 'DELETE');
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json.ok, true);
    assert.equal(disabled.json.status, '停用');
    assert.equal(disabled.json.alreadyDisabled, false);
    assert.equal(disabled.json.disabledAutomationRules, 1);
    assert.deepEqual(disabled.json.dependencyCounts, {
      contents: 1,
      tasks: 1,
      approvals: 1,
      automationRules: 2,
      automationRuns: 1,
    });

    const preserved = q.get('SELECT id,status,auth_version FROM users WHERE tenant_id=1 AND id=?', targetId);
    assert.equal(preserved.id, targetId);
    assert.equal(preserved.status, '停用');
    assert.equal(preserved.auth_version, authVersionBefore + 1);
    const disabledRule = q.get(`SELECT enabled,next_run_at FROM content_automation_rules
      WHERE tenant_id=1 AND id=?`, enabledRuleId);
    assert.equal(disabledRule.enabled, 0);
    assert.equal(disabledRule.next_run_at, null);
    assert.equal(q.get(`SELECT enabled FROM content_automation_rules
      WHERE tenant_id=1 AND id=?`, disabledRuleId).enabled, 0);
    assert.equal(q.get(`SELECT id FROM content_automation_runs
      WHERE tenant_id=1 AND id=?`, automationRunId).id, automationRunId);
    assert.equal(q.get('SELECT id FROM contents WHERE tenant_id=1 AND id=?', contentId).id, contentId);
    assert.equal(q.get('SELECT id FROM tasks WHERE tenant_id=1 AND id=?', taskId).id, taskId);
    assert.equal(q.get('SELECT id FROM approvals WHERE tenant_id=1 AND id=?', approvalId).id, approvalId);
    assert.ok(q.get(`SELECT id FROM op_logs WHERE tenant_id=1 AND action='停用账号'
      AND target LIKE ? ORDER BY id DESC LIMIT 1`, `user#${targetId}%`));

    const repeated = await request(base, `/sys/users/${targetId}`, 'DELETE');
    assert.equal(repeated.status, 200);
    assert.equal(repeated.json.alreadyDisabled, true);
    assert.equal(repeated.json.disabledAutomationRules, 0);
    assert.deepEqual(repeated.json.dependencyCounts, disabled.json.dependencyCounts);
    assert.equal(q.get('SELECT auth_version FROM users WHERE tenant_id=1 AND id=?', targetId).auth_version,
      authVersionBefore + 1);

    const restored = await request(base, `/sys/users/${targetId}`, 'PUT', { status: '启用' });
    assert.equal(restored.status, 200);
    assert.equal(q.get('SELECT status FROM users WHERE tenant_id=1 AND id=?', targetId).status, '启用');
    assert.equal(q.get(`SELECT enabled FROM content_automation_rules
      WHERE tenant_id=1 AND id=?`, enabledRuleId).enabled, 0);
    assert.equal(q.get(`SELECT id FROM content_automation_runs
      WHERE tenant_id=1 AND id=?`, automationRunId).id, automationRunId);
  });
});

test('停用账号禁止自身、平台超管和最后一个启用老板/管理员', async () => {
  const platformId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES('soft_disable_platform',?,'平台账号','platform_super','启用',1)`, hashPassword('Platform123')).lastInsertRowid);

  await withServer(async base => {
    const self = await request(base, `/sys/users/${boss.id}`, 'DELETE');
    assert.equal(self.status, 400);
    assert.equal(q.get('SELECT status FROM users WHERE id=?', boss.id).status, '启用');

    const platform = await request(base, `/sys/users/${platformId}`, 'DELETE');
    assert.equal(platform.status, 403);
    assert.equal(q.get('SELECT status FROM users WHERE id=?', platformId).status, '启用');
  });

  q.run(`UPDATE users SET status='停用' WHERE tenant_id=1 AND id=?`, boss.id);
  const lastManagerId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES('soft_disable_last_admin',?,'最后管理账号','admin','启用',1)`, hashPassword('LastAdmin123')).lastInsertRowid);
  try {
    await withServer(async base => {
      const lastManager = await request(base, `/sys/users/${lastManagerId}`, 'DELETE');
      assert.equal(lastManager.status, 409);
      assert.match(lastManager.json.error, /最后一个启用/u);
      assert.equal(q.get('SELECT status FROM users WHERE id=?', lastManagerId).status, '启用');
    });
  } finally {
    q.run(`UPDATE users SET status='启用' WHERE tenant_id=1 AND id=?`, boss.id);
  }
});

test('账号停用与自动规则停用在同一事务，规则更新失败时账号保持启用', async () => {
  const targetId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES('soft_disable_rollback',?,'事务员工','sales','启用',1)`, hashPassword('Rollback123')).lastInsertRowid);
  q.run(`INSERT INTO content_automation_rules(
    name,enabled,employee_idx,topic,requirement,content_type,content_count,
    frequency,run_time,weekday,approval_mode,next_run_at,created_by
  ) VALUES('事务失败规则',1,3,'事务主题','','文案初稿',1,'daily','11:00',NULL,'always','2026-08-01 11:00:00',?)`,
  targetId);
  db.exec(`CREATE TRIGGER fail_soft_disable_rule
    BEFORE UPDATE OF enabled ON content_automation_rules
    WHEN OLD.tenant_id=1 AND OLD.created_by=${targetId} AND NEW.enabled=0
    BEGIN
      SELECT RAISE(ABORT, 'injected soft-disable failure');
    END`);
  try {
    await withServer(async base => {
      const failed = await request(base, `/sys/users/${targetId}`, 'DELETE');
      assert.equal(failed.status, 500);
      assert.equal(q.get('SELECT status FROM users WHERE tenant_id=1 AND id=?', targetId).status, '启用');
      assert.equal(q.get(`SELECT enabled FROM content_automation_rules
        WHERE tenant_id=1 AND created_by=?`, targetId).enabled, 1);
      assert.equal(q.get(`SELECT COUNT(*) n FROM op_logs WHERE tenant_id=1
        AND action='停用账号' AND target LIKE ?`, `user#${targetId}%`).n, 0);
    });
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_soft_disable_rule');
  }
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});
