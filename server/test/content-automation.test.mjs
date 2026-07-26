import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-content-automation-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* fresh database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_DEMO = 'false';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const contentRoutes = (await import('../src/routes/content.js')).default;
const { runScheduledJobs } = await import('../src/engines/scheduler.js');

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'自动化A店','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(2,'自动化B店','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);

function insertUser(tenantId, username, name, role) {
  return Number(q.run(`INSERT INTO users(
    username,password_hash,name,role,dept,status,tenant_id
  ) VALUES(?,?,?,?,?,'启用',?)`,
  username, 'x', name, role, role === 'sales' ? '内容部' : '老板办', tenantId).lastInsertRowid);
}

const bossA = { id: insertUser(1, 'automation-boss-a', 'A店老板', 'boss'), name: 'A店老板', role: 'boss', tenant_id: 1 };
const bossB = { id: insertUser(2, 'automation-boss-b', 'B店老板', 'boss'), name: 'B店老板', role: 'boss', tenant_id: 2 };
const salesA = { id: insertUser(1, 'automation-sales-a', 'A店内容员工', 'sales'), name: 'A店内容员工', role: 'sales', tenant_id: 1 };
runWithTenant(1, () => q.run(`INSERT INTO content_employee_workbench_configs(
  employee_idx,prompt_override,work_config_json,skills_json,revision,updated_by
) VALUES(?,?,?,?,?,?)`,
0, 'A店补充：优先使用已经确认的招牌菜素材。',
JSON.stringify({ outputLength: 'full', approvalMode: '老板审核' }),
JSON.stringify([{ title: 'A店菜品事实核验', detail: '检查菜品、价格和库存是否有门店依据', source: 'A店SOP', enabled: true }]),
1, bossA.id));
runWithTenant(2, () => q.run(`INSERT INTO content_employee_workbench_configs(
  employee_idx,prompt_override,work_config_json,skills_json,revision,updated_by
) VALUES(?,?,?,?,?,?)`,
0, 'B店秘密提示词不得进入A店快照。',
JSON.stringify({ outputLength: 'lite' }),
JSON.stringify([{ title: 'B店私有技能', detail: '仅B店可用', source: 'B店', enabled: true }]),
7, bossB.id));

function appFor(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => {
    req.user = user;
    next();
  }));
  app.use('/content', contentRoutes);
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function jsonRequest(base, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}

const dailyRule = {
  name: '每日招牌菜内容',
  enabled: true,
  employeeIdx: 0,
  topic: '夏季招牌菜',
  requirement: '只使用门店已确认的菜品信息，未知价格与库存标记待确认。',
  contentType: '趋势简报',
  contentCount: 3,
  frequency: 'daily',
  runTime: '10:00',
  weekday: null,
  approvalMode: 'always',
};

let ruleAId;
let ruleBId;
let riskRuleAId;

test('只有管理角色可管理自动化，创建接口严格校验完整规则', async () => {
  await withServer(salesA, async base => {
    assert.equal((await jsonRequest(base, '/content/automations')).response.status, 403);
    assert.equal((await jsonRequest(base, '/content/automations', {
      method: 'POST', body: dailyRule,
    })).response.status, 403);
  });

  await withServer(bossA, async base => {
    const invalidTime = await jsonRequest(base, '/content/automations', {
      method: 'POST', body: { ...dailyRule, runTime: '29:90' },
    });
    assert.equal(invalidTime.response.status, 400);
    const unknown = await jsonRequest(base, '/content/automations', {
      method: 'POST', body: { ...dailyRule, sql: 'DROP TABLE contents' },
    });
    assert.equal(unknown.response.status, 400);
    const missingWeekday = await jsonRequest(base, '/content/automations', {
      method: 'POST', body: { ...dailyRule, frequency: 'weekly', weekday: null },
    });
    assert.equal(missingWeekday.response.status, 400);
    const mismatchedEmployeeTask = await jsonRequest(base, '/content/automations', {
      method: 'POST', body: { ...dailyRule, contentType: '朋友圈文案' },
    });
    assert.equal(mismatchedEmployeeTask.response.status, 400);
    assert.match(mismatchedEmployeeTask.data.error, /趋势官.*趋势简报.*候选选题.*热点扫描/u);

    const created = await jsonRequest(base, '/content/automations', {
      method: 'POST', body: dailyRule,
    });
    assert.equal(created.response.status, 201);
    ruleAId = created.data.rule.id;
    assert.equal(created.data.rule.employeeIdx, 0);
    assert.equal(created.data.rule.employee.contentEmployeeName, '趋势官');
    assert.equal(created.data.rule.taskTypeValid, true);
    assert.deepEqual(created.data.rule.allowedTaskTypes, ['趋势简报', '候选选题', '热点扫描']);
    assert.equal(created.data.rule.approvalMode, 'always');
    assert.match(created.data.rule.nextRunAt, /^\d{4}-\d{2}-\d{2} 10:00:00$/);

    const weekly = await jsonRequest(base, '/content/automations', {
      method: 'POST',
      body: {
        ...dailyRule,
        name: '每周复盘内容',
        employeeIdx: 9,
        contentType: '复盘报告',
        frequency: 'weekly',
        weekday: 1,
        runTime: '08:30',
        approvalMode: 'risk',
      },
    });
    assert.equal(weekly.response.status, 201);
    riskRuleAId = weekly.data.rule.id;
    assert.equal(weekly.data.rule.employee.contentEmployeeName, '复盘官');
    assert.equal(weekly.data.rule.weekday, 1);
  });
});

test('规则列表、更新、启停与删除严格按租户隔离', async () => {
  await withServer(bossB, async base => {
    const empty = await jsonRequest(base, '/content/automations');
    assert.equal(empty.response.status, 200);
    assert.equal(empty.data.rules.length, 0);
    assert.equal((await jsonRequest(base, `/content/automations/${ruleAId}`, {
      method: 'PUT', body: { name: '越权改名' },
    })).response.status, 404);

    const created = await jsonRequest(base, '/content/automations', {
      method: 'POST',
      body: {
        ...dailyRule,
        name: 'B店私有自动内容',
        topic: 'B店私有菜品',
        employeeIdx: 3,
        contentType: '文案初稿',
      },
    });
    ruleBId = created.data.rule.id;
  });

  await withServer(bossA, async base => {
    const list = await jsonRequest(base, '/content/automations');
    assert.ok(list.data.rules.every(rule => !rule.topic.includes('B店')));
    assert.equal((await jsonRequest(base, `/content/automations/${ruleBId}`, {
      method: 'PUT', body: { name: 'A店越权修改B店' },
    })).response.status, 404);
    assert.equal((await jsonRequest(base, `/content/automations/${ruleAId}`, {
      method: 'PUT', body: { name: '   ' },
    })).response.status, 400);

    const disabled = await jsonRequest(base, `/content/automations/${ruleAId}/toggle`, {
      method: 'POST', body: { enabled: false },
    });
    assert.equal(disabled.data.rule.enabled, false);
    assert.equal(disabled.data.rule.nextRunAt, null);
    const enabled = await jsonRequest(base, `/content/automations/${ruleAId}/toggle`, {
      method: 'POST', body: { enabled: true },
    });
    assert.equal(enabled.data.rule.enabled, true);
    assert.ok(enabled.data.rule.nextRunAt);

    const updated = await jsonRequest(base, `/content/automations/${ruleAId}`, {
      method: 'PUT', body: { name: '每日招牌菜待审内容', contentCount: 2 },
    });
    assert.equal(updated.data.rule.name, '每日招牌菜待审内容');
    assert.equal(updated.data.rule.contentCount, 2);

    const mismatchedUpdate = await jsonRequest(base, `/content/automations/${ruleAId}`, {
      method: 'PUT', body: { employeeIdx: 1 },
    });
    assert.equal(mismatchedUpdate.response.status, 400);
    assert.match(mismatchedUpdate.data.error, /情报员.*事实资料包.*核验报告.*来源清单/u);
  });
});

test('立即自动运行锁定完整员工快照，产出进入审核且绝不自动发布', async () => {
  await withServer(bossA, async base => {
    const run = await jsonRequest(base, `/content/automations/${ruleAId}/run`, {
      method: 'POST', body: {},
    });
    assert.equal(run.response.status, 200);
    assert.equal(run.data.status, '成功');
    assert.equal(run.data.contentStatus, '待审核');
    assert.equal(run.data.published, false);
    assert.equal(run.data.employee.contentEmployeeIdx, 0);
    assert.equal(run.data.contract.status, 'valid');
    assert.equal(run.data.contract.valid, true);
    assert.equal(run.data.billing.state, 'settled');
    assert.equal(run.data.billing.chargedCredits, 0);
    assert.match(run.data.boundary, /未执行发布/);

    const content = q.get(`SELECT * FROM contents WHERE tenant_id=1 AND id=?`, run.data.contentId);
    assert.equal(content.status, '待审核');
    assert.equal(content.channel, null);
    assert.equal(content.content_employee_idx, 0);
    assert.equal(content.content_run_mode, 'automation_immediate');
    assert.equal(q.get(`SELECT COUNT(*) n FROM approvals
      WHERE tenant_id=1 AND target_type='content' AND target_id=?`, content.id).n, 1);
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets
      WHERE tenant_id=1 AND source_type='content' AND source_id=?`, content.id).n, 0);
    assert.equal(q.get(`SELECT COUNT(*) n FROM notifications
      WHERE tenant_id=1 AND user_id=? AND title LIKE '自动内容%'`, bossA.id).n, 1);
    assert.equal(q.get(`SELECT COUNT(*) n FROM op_logs
      WHERE tenant_id=1 AND action='立即自动生成'`).n, 1);

    const history = await jsonRequest(base, `/content/automations/${ruleAId}/runs`);
    assert.equal(history.response.status, 200);
    assert.equal(history.data.runs[0].status, '成功');
    assert.equal(history.data.runs[0].contract.status, 'valid');
    assert.equal(history.data.runs[0].contract.valid, true);
    assert.equal(history.data.runs[0].billing.state, 'settled');
    assert.ok(history.data.runs[0].promptHash);
    assert.equal(history.data.runs[0].profileVersion, 'content-0-r1');
    const stored = q.get(`SELECT snapshot_json FROM content_automation_runs
      WHERE tenant_id=1 AND id=?`, history.data.runs[0].id);
    const snapshot = JSON.parse(stored.snapshot_json);
    assert.equal(snapshot.identity.idx, 0);
    assert.ok(snapshot.capabilities.length > 0);
    assert.ok(snapshot.skillLibrary.required.length > 0);
    assert.match(JSON.stringify(snapshot.jobProfile.boundaries), /人类审批/);
    assert.equal(snapshot.enterpriseOverlay.workConfig.outputLength, 'full');
    assert.equal(snapshot.enterpriseOverlay.customSkills[0].title, 'A店菜品事实核验');
    assert.equal(snapshot.enterpriseOverlay.promptOverrideAppended, true);
    assert.equal(snapshot.enterpriseOverlay.promptTextStored, false);
    assert.equal(snapshot.billing.state, 'settled');
    assert.equal(snapshot.billing.chargedCredits, 0);
    assert.doesNotMatch(JSON.stringify(snapshot), /B店秘密提示词|B店私有技能/);

    const riskRun = await jsonRequest(base, `/content/automations/${riskRuleAId}/run`, {
      method: 'POST', body: {},
    });
    assert.equal(riskRun.response.status, 200);
    assert.equal(riskRun.data.contentStatus, '可使用');
    assert.equal(riskRun.data.published, false);
    const riskContent = q.get(`SELECT status,channel,content_employee_idx FROM contents
      WHERE tenant_id=1 AND id=?`, riskRun.data.contentId);
    assert.equal(riskContent.status, '可使用');
    assert.equal(riskContent.channel, null);
    assert.equal(riskContent.content_employee_idx, 9);
    assert.equal(q.get(`SELECT COUNT(*) n FROM approvals
      WHERE tenant_id=1 AND target_type='content' AND target_id=?`, riskRun.data.contentId).n, 0);
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets
      WHERE tenant_id=1 AND source_type='content' AND source_id=?`, riskRun.data.contentId).n, 1);
  });
});

test('定时调度原子认领且同周期幂等，停用规则不会运行', async () => {
  q.run(`UPDATE content_automation_rules SET enabled=1,next_run_at='2026-07-23 10:00:00'
    WHERE tenant_id=1 AND id=?`, ruleAId);
  q.run(`UPDATE content_automation_rules SET enabled=0,next_run_at='2026-07-23 09:59:00'
    WHERE tenant_id=2 AND id=?`, ruleBId);
  const beforeA = q.get(`SELECT COUNT(*) n FROM contents
    WHERE tenant_id=1 AND content_run_mode='automation_scheduled'`).n;
  const beforeB = q.get(`SELECT COUNT(*) n FROM contents
    WHERE tenant_id=2 AND content_run_mode='automation_scheduled'`).n;
  const now = new Date('2026-07-23T02:00:30.000Z'); // 上海 10:00
  const first = runScheduledJobs(now);
  assert.equal(first.results.find(item => item.tenantId === 1).contentAutomationClaimed, 1);
  assert.equal(first.results.find(item => item.tenantId === 2).contentAutomationClaimed, 0);
  const outcomes = await first.pending;
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(q.get(`SELECT COUNT(*) n FROM contents
    WHERE tenant_id=1 AND content_run_mode='automation_scheduled'`).n, beforeA + 1);
  const scheduledRun = q.get(`SELECT snapshot_json FROM content_automation_runs
    WHERE tenant_id=1 AND rule_id=? AND trigger='scheduled'
    ORDER BY id DESC LIMIT 1`, ruleAId);
  const scheduledSnapshot = JSON.parse(scheduledRun.snapshot_json);
  assert.equal(scheduledSnapshot.billing.state, 'settled');
  assert.equal(scheduledSnapshot.billing.chargedCredits, 0);
  assert.equal(q.get(`SELECT COUNT(*) n FROM contents
    WHERE tenant_id=2 AND content_run_mode='automation_scheduled'`).n, beforeB);
  assert.equal(q.get(`SELECT next_run_at FROM content_automation_rules
    WHERE tenant_id=1 AND id=?`, ruleAId).next_run_at, '2026-07-24 10:00:00');

  const second = runScheduledJobs(now);
  await second.pending;
  assert.equal(second.results.find(item => item.tenantId === 1).contentAutomationClaimed, 0);
  assert.equal(q.get(`SELECT COUNT(*) n FROM content_automation_runs
    WHERE tenant_id=1 AND rule_id=? AND trigger='scheduled'
      AND scheduled_for='2026-07-23 10:00:00'`, ruleAId).n, 1);
  assert.equal(q.get(`SELECT COUNT(*) n FROM contents
    WHERE tenant_id=1 AND content_run_mode='automation_scheduled'`).n, beforeA + 1);
});

test('已完成规则可以删除且不会删除已生成内容', async () => {
  await withServer(bossA, async base => {
    const contentCount = q.get(`SELECT COUNT(*) n FROM contents
      WHERE tenant_id=1 AND content_employee_idx=0`).n;
    const deleted = await jsonRequest(base, `/content/automations/${ruleAId}`, { method: 'DELETE' });
    assert.equal(deleted.response.status, 200);
    assert.equal(q.get(`SELECT COUNT(*) n FROM content_automation_rules
      WHERE tenant_id=1 AND id=?`, ruleAId).n, 0);
    assert.equal(q.get(`SELECT COUNT(*) n FROM content_automation_runs
      WHERE tenant_id=1 AND rule_id=?`, ruleAId).n, 0);
    assert.equal(q.get(`SELECT COUNT(*) n FROM contents
      WHERE tenant_id=1 AND content_employee_idx=0`).n, contentCount);
  });
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* cleanup */ }
  }
});
