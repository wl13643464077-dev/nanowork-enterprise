import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';

import { validContentEmployeeOutput } from './helpers/content-output-fixtures.mjs';

const DBP = path.join(os.tmpdir(), `nanowork-content-automation-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* fresh database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = 'test-only-content-automation-key';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_DEMO = 'false';
process.env.BOCHA_API_KEY = 'content-automation-test-only';

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('https://api.bochaai.com/v1/web-search')) {
    return Response.json({
      data: {
        webPages: {
          value: [{
            name: '夏季餐饮内容趋势核验',
            url: 'https://example.test/summer-food-trend',
            summary: '测试夹具：只用于验证联网证据进入提示词和审计快照，不代表真实趋势。',
          }],
        },
      },
    });
  }
  if (String(url).startsWith('https://yunwu.ai/v1/chat/completions')) {
    const request = JSON.parse(String(options?.body || '{}'));
    const prompt = JSON.stringify(request.messages || []);
    const output = prompt.includes('复盘官') ? validReviewOutput() : validTrendOutput();
    return Response.json({
      choices: [{ message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 80, completion_tokens: 60 },
    });
  }
  return nativeFetch(url, options);
};

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const contentRoutes = (await import('../src/routes/content.js')).default;
const systemRoutes = (await import('../src/routes/system.js')).default;
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
const opsA = { id: insertUser(1, 'automation-ops-a', 'A店运营负责人', 'ops_director'), name: 'A店运营负责人', role: 'ops_director', tenant_id: 1 };
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
  app.use('/system', systemRoutes);
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

async function waitForAutomationRun(base, ruleId, runId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = await jsonRequest(
      base,
      `/content/automations/${ruleId}/runs?runId=${runId}`,
    );
    assert.equal(history.response.status, 200, JSON.stringify(history.data));
    const run = history.data.runs?.[0];
    if (run && run.status !== '运行中') return { history: history.data, run };
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`内容自动化运行#${runId}未在${timeoutMs}ms内进入终态`);
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

function validTrendOutput() {
  const output = validContentEmployeeOutput(0);
  output.briefing += ' [来源1]';
  output.channel_scan.forEach(item => { item.finding += ' [来源1]'; });
  output.topics.forEach(item => { item.evidence += ' [来源1]'; });
  return output;
}

function validReviewOutput() {
  return validContentEmployeeOutput(9);
}

let ruleAId;
let ruleBId;
let riskRuleAId;
let autoHighRuleAId;

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

    const { approvalMode: _legacyExplicitMode, ...autoRuleInput } = dailyRule;
    const defaultAuto = await jsonRequest(base, '/content/automations', {
      method: 'POST',
      body: {
        ...autoRuleInput,
        name: '高风险内部自动采用',
        employeeIdx: 9,
        topic: '保证稳赚的高风险内部复盘',
        requirement: '只形成内部复盘底稿，不发布、不付费、不执行不可逆动作。',
        contentType: '复盘报告',
        runTime: '09:15',
      },
    });
    assert.equal(defaultAuto.response.status, 201, JSON.stringify(defaultAuto.data));
    autoHighRuleAId = defaultAuto.data.rule.id;
    assert.equal(defaultAuto.data.rule.approvalMode, 'auto');
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

test('Boss运行always规则仍锁定完整员工快照，产物停待人工审阅且不外发', async () => {
  await withServer(bossA, async base => {
    const idempotencyKey = randomUUID();
    const accepted = await jsonRequest(base, `/content/automations/${ruleAId}/run`, {
      method: 'POST', body: { idempotencyKey },
    });
    assert.equal(accepted.response.status, 202, JSON.stringify(accepted.data));
    assert.equal(accepted.data.status, '运行中');
    assert.equal(accepted.data.queued, true);
    assert.equal(accepted.data.reused, false);
    assert.ok(Number.isSafeInteger(accepted.data.runId));
    assert.match(accepted.data.pollUrl, new RegExp(`runId=${accepted.data.runId}$`));
    assert.equal(accepted.data.rule.employee.contentEmployeeIdx, 0);
    assert.match(accepted.data.boundary, /未执行发布/);

    const duplicate = await jsonRequest(base, `/content/automations/${ruleAId}/run`, {
      method: 'POST', body: { idempotencyKey },
    });
    assert.ok([200, 202].includes(duplicate.response.status), JSON.stringify(duplicate.data));
    assert.equal(duplicate.data.runId, accepted.data.runId);
    assert.equal(duplicate.data.reused, true);
    assert.equal(q.get(`SELECT COUNT(*) n FROM content_automation_runs
      WHERE tenant_id=1 AND rule_id=? AND trigger='immediate'`, ruleAId).n, 1);

    const completed = await waitForAutomationRun(base, ruleAId, accepted.data.runId);
    const run = completed.run;
    assert.equal(run.status, '成功');
    assert.equal(run.contract.status, 'valid');
    assert.equal(run.contract.valid, true);
    assert.equal(run.billing.state, 'settled');
    assert.ok(Number(run.billing.chargedCredits) > 0);

    const content = q.get(`SELECT * FROM contents WHERE tenant_id=1 AND id=?`, run.contentId);
    // 自动化产物即使由 Boss 触发也不享受自授权豁免：停待审 + 1张待审单，
    // 人工采纳前不生成业务资产。
    assert.equal(content.status, '待审核');
    assert.equal(content.channel, null);
    assert.equal(content.content_employee_idx, 0);
    assert.equal(content.content_run_mode, 'automation_immediate');
    assert.equal(q.get(`SELECT COUNT(*) n FROM approvals
      WHERE tenant_id=1 AND target_type='content' AND target_id=? AND status='待审核'`, content.id).n, 1);
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets
      WHERE tenant_id=1 AND source_type='content' AND source_id=?`, content.id).n, 0);
    assert.equal(q.get(`SELECT COUNT(*) n FROM notifications
      WHERE tenant_id=1 AND user_id=? AND title LIKE '自动内容%'`, bossA.id).n, 1);
    assert.equal(q.get(`SELECT COUNT(*) n FROM op_logs
      WHERE tenant_id=1 AND action='立即自动生成'`).n, 1);

    const history = await jsonRequest(
      base,
      `/content/automations/${ruleAId}/runs?runId=${accepted.data.runId}`,
    );
    assert.equal(history.response.status, 200);
    assert.equal(history.data.runs[0].status, '成功');
    assert.equal(history.data.runs[0].contract.status, 'valid');
    assert.equal(history.data.runs[0].contract.valid, true);
    assert.ok(history.data.runs[0].contract.artifacts[0].sourceKeys.includes('briefing'));
    assert.equal(history.data.runs[0].billing.state, 'settled');
    assert.ok(history.data.runs[0].promptHash);
    assert.equal(history.data.runs[0].profileVersion, 'content-0-r1');
    const stored = q.get(`SELECT snapshot_json FROM content_automation_runs
      WHERE tenant_id=1 AND id=?`, history.data.runs[0].id);
    const snapshot = JSON.parse(stored.snapshot_json);
    assert.equal(snapshot.identity.idx, 0);
    assert.ok(snapshot.capabilities.length > 0);
    assert.ok(snapshot.skillLibrary.required.length > 0);
    assert.equal(
      snapshot.runtimeBindings.currentRuntimeBindings.work.handler,
      'content-handler-adapter:run_trend',
    );
    assert.equal(snapshot.handlerExecution.dispatchMode, 'manual_automation');
    assert.equal(snapshot.handlerExecution.automationTrigger, 'immediate');
    assert.equal(snapshot.handlerExecution.invocationCount, 1);
    assert.equal(snapshot.handlerExecution.finalHandlerId,
      'content-handler-adapter:run_trend');
    assert.equal(snapshot.handlerExecution.bindingStatus, 'bound_callable');
    assert.equal(snapshot.handlerExecution.handlerInvocations.length, 1);
    assert.equal(snapshot.handlerExecution.handlerInvocations[0].kind, 'initial');
    assert.equal(snapshot.handlerExecution.handlerInvocations[0].legacyHandler, 'run_trend');
    assert.equal(snapshot.handlerExecution.handlerInvocations[0].currentAdapter,
      'content-handler-adapters.invoke');
    assert.equal(snapshot.handlerExecution.handlerInvocations[0].provenance,
      'reimplemented_verified');
    assert.equal(snapshot.handlerExecution.handlerInvocations[0].bindingStatus,
      'bound_callable');
    assert.equal(snapshot.handlerExecution.handlerInvocations[0].webRequired, true);
    assert.equal(snapshot.handlerExecution.handlerInvocations[0].webCadence,
      'once_per_task_then_reused_for_retries');
    assert.equal(snapshot.handlerExecution.handlerInvocations[0].legacyWebCadence,
      'every_handler_call');
    assert.match(
      snapshot.handlerExecution.handlerInvocations[0].webEvidence.snapshotFingerprint,
      /^sha256:[a-f0-9]{64}$/u,
    );
    assert.equal(snapshot.handlerExecution.handlerInvocations[0].prompt.promptTextIncluded,
      false);
    assert.equal(snapshot.handlerExecution.handlerInvocations[0].credentialsIncluded, false);
    assert.doesNotMatch(JSON.stringify(snapshot), /test-only-content-automation-key/u);
    assert.equal(
      snapshot.handlerExecution.injectedHistoricalSkillCount,
      snapshot.skillLibrary.historical.length,
    );
    assert.match(snapshot.canonicalProfile.version.aggregateFingerprint, /^sha256:[a-f0-9]{64}$/u);
    assert.match(JSON.stringify(snapshot.jobProfile.boundaries), /老板执行授权.*不是内容审核/u);
    assert.equal(snapshot.enterpriseOverlay.workConfig.outputLength, 'full');
    assert.equal(snapshot.enterpriseOverlay.customSkills[0].title, 'A店菜品事实核验');
    assert.equal(snapshot.enterpriseOverlay.promptOverrideAppended, true);
    assert.equal(snapshot.enterpriseOverlay.promptTextStored, false);
    assert.equal(snapshot.billing.state, 'settled');
    assert.ok(Number(snapshot.billing.chargedCredits) > 0);
    assert.doesNotMatch(JSON.stringify(snapshot), /B店秘密提示词|B店私有技能/);

    const riskRun = await jsonRequest(base, `/content/automations/${riskRuleAId}/run`, {
      method: 'POST', body: { idempotencyKey: randomUUID() },
    });
    assert.equal(riskRun.response.status, 202);
    const riskCompleted = await waitForAutomationRun(base, riskRuleAId, riskRun.data.runId);
    assert.equal(riskCompleted.run.status, '成功');
    const riskContent = q.get(`SELECT status,channel,content_employee_idx FROM contents
      WHERE tenant_id=1 AND id=?`, riskCompleted.run.contentId);
    // risk 模式同样不再免审：自动化产物一律停待人工审阅，审阅前不进资产/知识库。
    assert.equal(riskContent.status, '待审核');
    assert.equal(riskContent.channel, null);
    assert.equal(riskContent.content_employee_idx, 9);
    assert.equal(q.get(`SELECT COUNT(*) n FROM approvals
      WHERE tenant_id=1 AND target_type='content' AND target_id=? AND status='待审核'`,
      riskCompleted.run.contentId).n, 1);
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets
      WHERE tenant_id=1 AND source_type='content' AND source_id=?`, riskCompleted.run.contentId).n, 0);
    assert.equal(q.get(`SELECT COUNT(*) n FROM kb_docs
      WHERE tenant_id=1 AND source_type='content' AND source_id=? AND enabled=1`,
    riskCompleted.run.contentId).n, 0);
    assert.equal(q.get(`SELECT COUNT(*) n FROM content_publish_logs
      WHERE tenant_id=1 AND content_id=?`, riskCompleted.run.contentId).n, 0);

    const autoHighRun = await jsonRequest(base, `/content/automations/${autoHighRuleAId}/run`, {
      method: 'POST', body: { idempotencyKey: randomUUID() },
    });
    assert.equal(autoHighRun.response.status, 202, JSON.stringify(autoHighRun.data));
    const autoHighCompleted = await waitForAutomationRun(
      base,
      autoHighRuleAId,
      autoHighRun.data.runId,
    );
    assert.equal(autoHighCompleted.run.status, '成功');
    const autoHighContent = q.get(`SELECT status,channel,risk_level,content_employee_idx,snapshot_json
      FROM contents WHERE tenant_id=1 AND id=?`, autoHighCompleted.run.contentId);
    assert.equal(autoHighContent.risk_level, 'high');
    // 高风险 + auto 配置同样强制停审：由老板终审，审阅前零资产/零知识库。
    assert.equal(autoHighContent.status, '待审核');
    assert.equal(autoHighContent.channel, null);
    assert.equal(autoHighContent.content_employee_idx, 9);
    assert.equal(q.get(`SELECT COUNT(*) n FROM approvals
      WHERE tenant_id=1 AND target_type='content' AND target_id=? AND status='待审核'`,
    autoHighCompleted.run.contentId).n, 1);
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets
      WHERE tenant_id=1 AND source_type='content' AND source_id=?`,
    autoHighCompleted.run.contentId).n, 0);
    assert.equal(q.get(`SELECT COUNT(*) n FROM kb_docs
      WHERE tenant_id=1 AND source_type='content' AND source_id=? AND enabled=1`,
    autoHighCompleted.run.contentId).n, 0);
    assert.equal(q.get(`SELECT COUNT(*) n FROM content_publish_logs
      WHERE tenant_id=1 AND content_id=?`, autoHighCompleted.run.contentId).n, 0);
    const autoHighSnapshot = JSON.parse(autoHighContent.snapshot_json);
    assert.equal(autoHighSnapshot.approvalRouting.autoAdopt, false);
    assert.equal(autoHighSnapshot.approvalRouting.requiresReview, true);
    assert.equal(autoHighSnapshot.approvalRouting.contentReviewRequired, true);
    assert.equal(autoHighSnapshot.approvalRouting.executionAuthorizationRequired, false);
  });
});

test('自动化运行契约对运营负责人隐藏字段级诊断与源字段，内部角色保留完整证据', async () => {
  const errorSecret = '__AUTOMATION_CONTRACT_FIELD_ERROR_SECRET__';
  const sourceKeySecret = '__AUTOMATION_CONTRACT_SOURCE_KEY_SECRET__';
  const inserted = q.run(`INSERT INTO content_automation_runs(
    rule_id,trigger,claim_key,scheduled_for,status,initiated_by,
    profile_version,prompt_hash,snapshot_json,error,finished_at
  ) VALUES(?,'immediate',?,NULL,'失败',?,?,?,?,?,datetime('now','localtime'))`,
  ruleAId,
  `manual:${opsA.id}:${randomUUID()}`,
  opsA.id,
  'content-0-internal-revision',
  'internal-prompt-hash',
  JSON.stringify({
    contract: {
      status: 'invalid',
      valid: false,
      incomplete: false,
      requiresManualRepair: true,
      errors: [`${errorSecret}：briefing字段缺失`],
      previewMarkdown: '待修复的业务内容预览',
      artifacts: [{
        kind: 'markdown',
        primary: true,
        filename: '趋势简报.md',
        mediaType: 'text/markdown; charset=utf-8',
        employeeIdx: 0,
        employeeKey: 'trend',
        sourceKeys: [sourceKeySecret],
      }],
    },
  }),
  `${errorSecret}：briefing字段缺失`);
  const runId = Number(inserted.lastInsertRowid);

  await withServer(opsA, async base => {
    const history = await jsonRequest(base, `/content/automations/${ruleAId}/runs?runId=${runId}`);
    assert.equal(history.response.status, 200, JSON.stringify(history.data));
    const [run] = history.data.runs;
    assert.deepEqual(run.contract.errors, ['结果格式未通过岗位契约，请联系有权限的审阅人']);
    assert.equal(run.error, '结果格式未通过岗位契约，请联系有权限的审阅人');
    assert.equal(Object.hasOwn(run.contract.artifacts[0], 'sourceKeys'), false);
    assert.equal(Object.hasOwn(run, 'profileVersion'), false);
    assert.equal(Object.hasOwn(run, 'promptHash'), false);
    assert.doesNotMatch(JSON.stringify(run), new RegExp(`${errorSecret}|${sourceKeySecret}`, 'u'));
  });

  await withServer(bossA, async base => {
    const history = await jsonRequest(base, `/content/automations/${ruleAId}/runs?runId=${runId}`);
    assert.equal(history.response.status, 200, JSON.stringify(history.data));
    const [run] = history.data.runs;
    assert.deepEqual(run.contract.errors, [`${errorSecret}：briefing字段缺失`]);
    assert.deepEqual(run.contract.artifacts[0].sourceKeys, [sourceKeySecret]);
    assert.equal(run.error, `${errorSecret}：briefing字段缺失`);
    assert.equal(run.profileVersion, 'content-0-internal-revision');
    assert.equal(run.promptHash, 'internal-prompt-hash');
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
  assert.equal(outcomes[0].status, 'fulfilled', String(outcomes[0].reason?.stack || outcomes[0].reason || ''));
  assert.equal(q.get(`SELECT COUNT(*) n FROM contents
    WHERE tenant_id=1 AND content_run_mode='automation_scheduled'`).n, beforeA + 1);
  const scheduledRun = q.get(`SELECT snapshot_json FROM content_automation_runs
    WHERE tenant_id=1 AND rule_id=? AND trigger='scheduled'
    ORDER BY id DESC LIMIT 1`, ruleAId);
  const scheduledSnapshot = JSON.parse(scheduledRun.snapshot_json);
  assert.equal(scheduledSnapshot.billing.state, 'settled');
  assert.equal(
    scheduledSnapshot.runtimeBindings.currentRuntimeBindings.work.handler,
    'content-handler-adapter:run_trend',
  );
  assert.equal(scheduledSnapshot.handlerExecution.dispatchMode, 'scheduled_automation');
  assert.equal(scheduledSnapshot.handlerExecution.automationTrigger, 'scheduled');
  assert.equal(scheduledSnapshot.handlerExecution.invocationCount, 1);
  assert.equal(scheduledSnapshot.handlerExecution.finalHandlerId,
    'content-handler-adapter:run_trend');
  assert.equal(scheduledSnapshot.handlerExecution.handlerInvocations[0].kind, 'initial');
  assert.equal(scheduledSnapshot.handlerExecution.handlerInvocations[0].completed, true);
  assert.equal(scheduledSnapshot.handlerExecution.handlerInvocations[0].bindingStatus,
    'bound_callable');
  assert.equal(scheduledSnapshot.handlerExecution.handlerInvocations[0].credentialsIncluded,
    false);
  assert.ok(Number(scheduledSnapshot.billing.chargedCredits) > 0);
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

test('手动运行在claim前发现创建者撤权会原子停用规则并记录失败，不占扣不调用AI', async () => {
  await withServer(bossA, async base => {
    const created = await jsonRequest(base, '/content/automations', {
      method: 'POST',
      body: {
        ...dailyRule,
        name: '手动撤权复核规则',
        runTime: '11:30',
      },
    });
    assert.equal(created.response.status, 201);
    const ruleId = created.data.rule.id;
    const creditsBefore = q.get('SELECT credits FROM tenants WHERE id=1').credits;
    q.run(`UPDATE users SET modules='["dashboard"]' WHERE id=?`, bossA.id);
    try {
      const denied = await jsonRequest(base, `/content/automations/${ruleId}/run`, {
        method: 'POST',
        body: { idempotencyKey: randomUUID() },
      });
      assert.equal(denied.response.status, 403);
      assert.match(denied.data.error, /规则已自动停用.*失去内容生产仓模块权限/u);
      assert.ok(Number.isSafeInteger(denied.data.runId));
      assert.equal(denied.data.status, '失败');
      const rule = q.get(`SELECT enabled,next_run_at,last_status,last_error
        FROM content_automation_rules WHERE tenant_id=1 AND id=?`, ruleId);
      assert.equal(rule.enabled, 0);
      assert.equal(rule.next_run_at, null);
      assert.equal(rule.last_status, '已停用');
      assert.match(rule.last_error, /失去内容生产仓模块权限/u);
      const run = q.get(`SELECT status,error,snapshot_json
        FROM content_automation_runs WHERE tenant_id=1 AND id=?`, denied.data.runId);
      assert.equal(run.status, '失败');
      assert.match(run.error, /失去内容生产仓模块权限/u);
      assert.equal(JSON.parse(run.snapshot_json).entitlement.code, 'creator_content_revoked');
      assert.equal(q.get(`SELECT COUNT(*) n FROM credit_holds
        WHERE tenant_id=1 AND ref_type='content_automation_run' AND ref_id=?`,
      denied.data.runId).n, 0);
      assert.equal(q.get('SELECT credits FROM tenants WHERE id=1').credits, creditsBefore);
    } finally {
      q.run('UPDATE users SET modules=NULL WHERE id=?', bossA.id);
    }
  });
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
  globalThis.fetch = nativeFetch;
  delete process.env.BOCHA_API_KEY;
  delete process.env.YUNWU_API_KEY;
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* cleanup */ }
  }
});
