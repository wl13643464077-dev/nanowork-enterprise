import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { after, test } from 'node:test';

// Luna isolation gate: these tests deliberately run without a provider key and
// never call the network.  The product contract is failure + refund + empty
// business output; a template/"底稿" is not an acceptable fallback.
const DB_PATH = path.join(
  os.tmpdir(),
  `nanowork-content-no-degradation-${process.pid}.db`,
);
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
}

process.env.NANOWORK_DB = DB_PATH;
process.env.SEED_DEMO = 'false';
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const {
  createContentEmployeeWorkbenchRouter,
} = await import('../src/routes/content-employee-workbench.js');
const { executeContentAutomationRun } = await import('../src/routes/content.js');
const { employeeTemplateFallback, resolveMinimalEmployeeDispatchInput } = await import(
  '../src/employee-workbench.js'
);
const {
  buildRuntimeReadiness,
  clearRuntimeReadinessChecks,
} = await import('../src/engines/runtime-readiness.js');

initSchema();
migrateV2();

const TENANT_ID = 9901;
const BOSS_ID = 990101;
q.run(`INSERT OR REPLACE INTO tenants(id,name,status,credits)
  VALUES(?,?,?,?)`, TENANT_ID, '内容降级门禁隔离企业', '已开通', 1_000_000);
q.run(`INSERT OR REPLACE INTO users(
  id,username,password_hash,name,role,dept,status,tenant_id
) VALUES(?,?,?,?,?,?,?,?)`,
BOSS_ID, 'no-degradation-boss', 'x', '降级门禁老板', 'boss', '内容生产仓', '启用', TENANT_ID);

const boss = {
  id: BOSS_ID,
  name: '降级门禁老板',
  role: 'boss',
  tenant_id: TENANT_ID,
};

function appFor(router) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    runWithTenant(TENANT_ID, () => {
      req.user = boss;
      req.requestSignal = new AbortController().signal;
      req.aiGuard = { defer: () => () => {} };
      next();
    });
  });
  app.use('/employee-workbench/content', router);
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ error: error.message });
  });
  return app;
}

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function post(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

function insertedAutomationRun({ employeeIdx = 3, contentType = '文案初稿', key }) {
  return runWithTenant(TENANT_ID, () => {
    const ruleId = Number(q.run(`INSERT INTO content_automation_rules(
      name,enabled,employee_idx,topic,requirement,content_type,content_count,
      frequency,run_time,weekday,approval_mode,next_run_at,created_by
    ) VALUES(?,1,?,?,?,?,?,'daily','10:00',NULL,'auto',NULL,?)`,
    `不降级规则-${key}`, employeeIdx, '门店内容自动化', '只完成真实云API交付',
    contentType, 1, BOSS_ID).lastInsertRowid);
    const runId = Number(q.run(`INSERT INTO content_automation_runs(
      rule_id,trigger,claim_key,scheduled_for,status,initiated_by
    ) VALUES(?,'immediate',?,NULL,'运行中',?)`, ruleId, key, BOSS_ID).lastInsertRowid);
    return { ruleId, runId };
  });
}

test('源码门禁禁止保留底稿/待核验降级文本与误导性的 readiness 能力声明', () => {
  const workbenchRoute = fs.readFileSync(
    new URL('../src/routes/content-employee-workbench.js', import.meta.url),
    'utf8',
  );
  const contentRoute = fs.readFileSync(
    new URL('../src/routes/content.js', import.meta.url),
    'utf8',
  );
  const readiness = fs.readFileSync(
    new URL('../src/engines/runtime-readiness.js', import.meta.url),
    'utf8',
  );
  const employeeWorkbench = fs.readFileSync(
    new URL('../src/employee-workbench.js', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(workbenchRoute, /function honestDraft\s*\(/u);
  assert.doesNotMatch(workbenchRoute, /fallback:\s*\(\)\s*=>\s*honestDraft/u);
  assert.doesNotMatch(contentRoute, /function automationSafeDraftValue\s*\(/u);
  assert.doesNotMatch(contentRoute, /当前仅形成待人工审阅底稿|当前没有可用AI通道/u);
  assert.doesNotMatch(readiness, /能生成本地底稿|当前仅生成本地底稿|仅本地底稿/u);
  assert.doesNotMatch(employeeWorkbench, /失败必须列待核验项|必须明确列出待核验项/u);
});

test('内容员工云通道不可用时：失败终态、空正文、结构化证据、退款且审批增量为零', async () => {
  const scheduled = [];
  const router = createContentEmployeeWorkbenchRouter({
    // Simulate the old generate() fallback leaking a local template value.
    generateFn: async () => ({
      text: '# 仅供审阅的底稿\n当前没有可用AI通道，待人工补充公开资料。',
      mode: 'template',
      model: 'template',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    scheduleFn: task => scheduled.push(task),
    webSearchFn: async () => ({ ok: false, provider: 'offline', results: [] }),
    notifyFn: () => {},
    logOpFn: () => {},
  });

  const beforeApprovals = Number(q.get(
    'SELECT COUNT(*) count FROM approvals WHERE tenant_id=?', TENANT_ID,
  )?.count || 0);
  const beforeContents = Number(q.get(
    'SELECT COUNT(*) count FROM contents WHERE tenant_id=?', TENANT_ID,
  )?.count || 0);
  const beforeCredits = Number(q.get(
    'SELECT credits FROM tenants WHERE id=?', TENANT_ID,
  )?.credits || 0);

  await withServer(appFor(router), async base => {
    const queued = await post(base, '/employee-workbench/content/3/dispatch', {
      question: '请生成本周门店经营复盘',
    });
    assert.equal(queued.response.status, 200, JSON.stringify(queued.payload));
    assert.equal(queued.payload.queued, true);
    while (scheduled.length) await scheduled.shift()();

    const row = q.get(`SELECT status,result_md,ai_mode,model,snapshot_json
      FROM content_employee_runs WHERE tenant_id=? AND id=?`, TENANT_ID, queued.payload.runId);
    assert.ok(row);
    assert.equal(row.status, '失败');
    assert.equal(row.result_md, null);
    assert.equal(row.ai_mode, 'failed');
    assert.equal(row.model, null);
    const snapshot = JSON.parse(row.snapshot_json);
    assert.equal(snapshot.contractValid, false);
    assert.equal(snapshot.previewMarkdown, null);
    assert.deepEqual(snapshot.artifacts, []);
    assert.equal(snapshot.billing.state, 'released');
    assert.equal(snapshot.billing.chargedCredits, 0);
    assert.ok(snapshot.failure?.code, 'failure code must be persisted');
    assert.ok(snapshot.web && typeof snapshot.web === 'object', 'web evidence must be persisted');
    assert.ok(snapshot.providerAttempt && typeof snapshot.providerAttempt === 'object', 'provider evidence must be persisted');
    assert.equal(snapshot.providerAttempt.mode, 'template');
    assert.deepEqual(snapshot.providerAttempt.usage, { inputTokens: 0, outputTokens: 0 });
    assert.ok(Array.isArray(snapshot.handlerExecution?.handlerInvocations));
    assert.ok(snapshot.handlerExecution.handlerInvocations.length >= 1);
    assert.equal(Number(q.get(
      'SELECT COUNT(*) count FROM approvals WHERE tenant_id=?', TENANT_ID,
    )?.count || 0), beforeApprovals);
    assert.equal(Number(q.get(
      'SELECT COUNT(*) count FROM contents WHERE tenant_id=?', TENANT_ID,
    )?.count || 0), beforeContents);
    assert.equal(Number(q.get(
      'SELECT credits FROM tenants WHERE id=?', TENANT_ID,
    )?.credits || 0), beforeCredits);
    const publicRun = await fetch(
      `${base}/employee-workbench/content/3/runs/${queued.payload.runId}`,
    ).then(response => response.json());
    const publicResult = publicRun.run || publicRun;
    assert.equal(publicResult.resultPreview, null);
    assert.equal(publicResult.resultMd, null);
    assert.doesNotMatch(
      `${publicResult.error || ''}\n${publicResult.resultPreview || ''}`,
      /待人工审阅底稿|请.*补.*公开资料/u,
    );
    assert.equal(publicResult.status, '失败');
  });
});

test('内容员工云调用抛错时保留 failure/web/provider 结构化证据，不泄漏密钥且仍退款', async () => {
  const scheduled = [];
  const router = createContentEmployeeWorkbenchRouter({
    generateFn: async () => {
      throw new Error('upstream timeout sk-no-degradation-secret-12345678');
    },
    scheduleFn: task => scheduled.push(task),
    notifyFn: () => {},
    logOpFn: () => {},
  });

  await withServer(appFor(router), async base => {
    const queued = await post(base, '/employee-workbench/content/3/dispatch', {
      question: '请执行一次真实内容生产',
    });
    assert.equal(queued.response.status, 200, JSON.stringify(queued.payload));
    while (scheduled.length) await scheduled.shift()();
    const row = q.get(`SELECT status,result_md,snapshot_json
      FROM content_employee_runs WHERE tenant_id=? AND id=?`, TENANT_ID, queued.payload.runId);
    assert.equal(row.status, '失败');
    assert.equal(row.result_md, null);
    const snapshot = JSON.parse(row.snapshot_json);
    assert.ok(snapshot.failure?.code);
    assert.equal(snapshot.billing.state, 'released');
    assert.deepEqual(snapshot.artifacts, []);
    assert.equal(snapshot.previewMarkdown, null);
    assert.ok(snapshot.web && typeof snapshot.web === 'object');
    // Provider evidence must remain machine-readable even when no provider
    // response exists; an opaque error-only row cannot be audited or refunded.
    assert.ok(snapshot.providerAttempt && typeof snapshot.providerAttempt === 'object');
    assert.deepEqual(snapshot.providerAttempt.usage, { inputTokens: 0, outputTokens: 0 });
    const invocation = snapshot.handlerExecution?.handlerInvocations?.at(-1);
    assert.ok(invocation?.failure, 'handler failure evidence must be retained');
    assert.equal(invocation.failure.rawMessageIncluded, false);
    assert.doesNotMatch(JSON.stringify(snapshot), /sk-no-degradation-secret/u);
    assert.equal(Number(q.get(
      "SELECT COUNT(*) count FROM credit_holds WHERE tenant_id=? AND status='held'", TENANT_ID,
    )?.count || 0), 0);
    assert.equal(Number(q.get(
      'SELECT COUNT(*) count FROM approvals WHERE tenant_id=?', TENANT_ID,
    )?.count || 0), 0);
  });
});

test('自动化 fallback/无真实云API时只落失败运行，不落内容正文或待审阅草稿', async () => {
  const { ruleId, runId } = insertedAutomationRun({ key: `fallback-${Date.now()}` });
  const beforeContents = Number(q.get('SELECT COUNT(*) n FROM contents WHERE tenant_id=?', TENANT_ID).n);
  const beforeCredits = Number(q.get('SELECT credits FROM tenants WHERE id=?', TENANT_ID).credits);
  await assert.rejects(
    runWithTenant(TENANT_ID, () => executeContentAutomationRun({
      ruleId,
      runId,
      trigger: 'immediate',
      initiatedBy: BOSS_ID,
      generateFn: async () => ({
        text: '{"summary":"自动任务待人工审阅底稿"}',
        mode: 'template',
        model: 'template',
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    })),
    /只返回模板或降级底稿|真实云API执行未完成|未完成/u,
  );

  const run = q.get(`SELECT status,content_id,error,snapshot_json
    FROM content_automation_runs WHERE tenant_id=? AND id=?`, TENANT_ID, runId);
  assert.equal(run.status, '失败');
  assert.equal(run.content_id, null);
  assert.match(run.error, /未完成|模板|真实云API/u);
  const snapshot = JSON.parse(run.snapshot_json);
  assert.equal(snapshot.billing.state, 'released');
  assert.equal(snapshot.billing.chargedCredits, 0);
  assert.equal(snapshot.contract.valid, false);
  assert.deepEqual(snapshot.contract.artifacts, []);
  assert.equal(Number(q.get('SELECT COUNT(*) n FROM contents WHERE tenant_id=?', TENANT_ID).n), beforeContents);
  assert.equal(Number(q.get('SELECT credits FROM tenants WHERE id=?', TENANT_ID).credits), beforeCredits);
  assert.equal(Number(q.get(
    "SELECT COUNT(*) n FROM credit_holds WHERE tenant_id=? AND status='held'", TENANT_ID,
  ).n), 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /自动任务待人工审阅底稿/u);
  assert.ok(snapshot.failure || snapshot.contract, 'structured failure/contract evidence must exist');
});

test('无 provider 的运行就绪矩阵不得宣称可生成本地底稿或可交付人工审阅', () => {
  clearRuntimeReadinessChecks();
  const matrix = runWithTenant(TENANT_ID, () => buildRuntimeReadiness({ tenantId: TENANT_ID }));
  const ai = matrix.channels.find(item => item.key === 'ai');
  assert.ok(ai);
  assert.equal(ai.configured, false);
  assert.equal(ai.canGenerateLocalDraft, false);
  assert.equal(ai.canDeliverForHumanReview, false);
  assert.equal(ai.canExecute, false);
  assert.doesNotMatch(ai.capabilitySummary, /底稿|人工审阅/u);
  const connectors = matrix.channels.find(item => item.key === 'content_connectors');
  assert.ok(connectors);
  assert.doesNotMatch(connectors.capabilitySummary, /本地底稿/u);
});

test('老板只提交一句问题时由系统补派生字段，不向客户暴露公开资料准备清单', () => {
  const input = resolveMinimalEmployeeDispatchInput({
    question: '比较毛血旺太原吾悦广场的竞品与商圈机会',
  });
  assert.equal(input.question, '比较毛血旺太原吾悦广场的竞品与商圈机会');
  assert.equal(input.requirement, '比较毛血旺太原吾悦广场的竞品与商圈机会');
  assert.equal(input.type, '常规');
  assert.match(input.title, /毛血旺太原吾悦广场/u);
  assert.doesNotMatch(JSON.stringify(input), /开始前必须补齐|全部必备能力执行清单|请.*补.*公开资料/u);
  const fallback = employeeTemplateFallback(
    { workbench: { identity: { idx: 101 } } },
    { requirement: '任意任务' },
  );
  assert.equal(fallback, '');
});

after(() => {
  clearRuntimeReadinessChecks();
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
});
