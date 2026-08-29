import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-output-analysis-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.SEED_DEMO = 'false';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { holdCredits, settleHold } = await import('../src/engines/credits.js');
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const {
  buildRestaurantOutputDeliverableFixture,
  getRestaurantOutputContract,
  renderRestaurantOutputMarkdown,
  validateRestaurantEmployeeOutputContract,
} = await import('../src/engines/restaurant-output-contract.js');
const outputRoutes = (await import('../src/routes/employee-outputs.js')).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(2,'B店测试租户','已开通',0)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status`);

// 与经营工具模块的正式迁移字段保持一致；IF NOT EXISTS 兼容两组测试的加载顺序。
db.exec(`CREATE TABLE IF NOT EXISTS tool_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  tool_key TEXT NOT NULL,
  tool_title TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  employee_idx INTEGER,
  employee_name TEXT,
  specialist_id INTEGER,
  created_by INTEGER NOT NULL,
  input_json TEXT DEFAULT '{}',
  input_summary TEXT,
  result_md TEXT,
  assumptions_json TEXT DEFAULT '[]',
  evidence_json TEXT DEFAULT '[]',
  provenance_json TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT
);`);

q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,?)`, 'output-boss-a', 'x', 'A店老板', 'boss', '老板办', 1);
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,?)`, 'output-boss-b', 'x', 'B店老板', 'boss', '老板办', 2);
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,?)`, 'output-ops-a', 'x', 'A店运营负责人', 'ops_director', '运营部', 1);
const opsA = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='output-ops-a'`);
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id,manager_id) VALUES(?,?,?,?,?,?,?)`,
  'output-staff-a', 'x', 'A店员工', 'staff', '内容部', 1, opsA.id);
const bossA = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='output-boss-a'`);
const bossB = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='output-boss-b'`);
const staffA = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='output-staff-a'`);
const employee = q.get(`SELECT id,marshal_id,employee_idx,name,group_name FROM specialists WHERE employee_idx=101`);
assert.ok(employee);

function restaurantDelivery(employeeIdx, title, requirement) {
  const task = { title, requirement };
  const parsedOutput = buildRestaurantOutputDeliverableFixture(employeeIdx, task);
  const contract = getRestaurantOutputContract(employeeIdx);
  const validated = validateRestaurantEmployeeOutputContract(employeeIdx, parsedOutput, { task });
  assert.equal(validated.valid, true, validated.errors?.join('\n'));
  const body = renderRestaurantOutputMarkdown(employeeIdx, parsedOutput, { task });
  const contentSha256 = crypto.createHash('sha256')
    .update(validated.artifacts[0].content, 'utf8').digest('hex');
  return {
    body,
    evidence: {
      kind: 'restaurant_employee_execution_evidence',
      outputContract: {
        valid: true,
        contractId: contract.contractId,
        schemaVersion: contract.schemaVersion,
        primaryArtifact: contract.primaryArtifact,
        parsedOutput,
        providerResponseSha256: contentSha256,
        renderedBodySha256: crypto.createHash('sha256').update(body, 'utf8').digest('hex'),
        artifacts: [{
          primary: true,
          kind: contract.primaryArtifact,
          contractId: contract.contractId,
          schemaVersion: contract.schemaVersion,
          contentSha256,
        }],
      },
      internalProfileLeakage: { detected: false, matches: [] },
    },
  };
}

let taskA;
let taskB;
runWithTenant(1, () => {
  const title = 'A店菜单复盘';
  const requirement = '核对菜单表现';
  const delivery = restaurantDelivery(Number(employee.employee_idx), title, requirement);
  const output = q.run(`INSERT INTO contents(type,title,body,status,ai_mode,creator_id,marshal_id,created_at) VALUES(?,?,?,?,?,?,?,?)`,
    '员工产出', 'A店任务产出', delivery.body, '待审核', 'api', staffA.id, employee.marshal_id, '2026-07-20 10:01:00').lastInsertRowid;
  taskA = q.run(`INSERT INTO agent_tasks(marshal_id,specialist_id,title,type,requirement,status,output_id,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`, employee.marshal_id, employee.id, title, '常规', requirement, '待审阅', output, staffA.id, '2026-07-20 10:00:00').lastInsertRowid;
  q.run(`UPDATE agent_tasks SET
    employee_profile_version='restaurant-test-profile',
    employee_prompt_hash='restaurant-test-prompt-hash',
    employee_capabilities_snapshot=?,
    employee_config_snapshot=?,
    employee_skills_snapshot=?,
    employee_web_snapshot=?
    WHERE id=?`,
  JSON.stringify([{ name: '专属商圈证据地图', description: '建立仅供内部执行的证据地图' }]),
  JSON.stringify({ outputLength: 'full', textModel: 'restaurant-secret-model' }),
  JSON.stringify([{ title: '商圈证据秘策', detail: '只供服务端执行注入' }]),
  JSON.stringify(delivery.evidence),
  taskA);
});
runWithTenant(2, () => {
  taskB = q.run(`INSERT INTO agent_tasks(marshal_id,specialist_id,title,type,requirement,status,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?)`, employee.marshal_id, employee.id, 'B店私有任务', '常规', '不得跨租户看到', '执行中', bossB.id, '2026-07-20 11:00:00').lastInsertRowid;
});

db.prepare(`INSERT INTO tool_runs(
  tenant_id,tool_key,tool_title,title,status,employee_idx,employee_name,specialist_id,created_by,
  input_json,input_summary,result_md,assumptions_json,evidence_json,provenance_json,created_at,updated_at
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  1, 'hot', '今日必发', '午市上新内容', 'done', 101, employee.name, employee.id, staffA.id,
  JSON.stringify({ topic: '午市新品' }), '主题：午市新品', '## 工具结果\n\n待老板确认后发布。',
  JSON.stringify(['未接入真实平台曝光']), JSON.stringify([]), JSON.stringify({
    mode: 'api',
    engine: 'yunwu',
    completionState: 'completed',
    contract: { validator: 'toolbox-delivery-contract', status: 'valid', valid: true, errors: [] },
    promptVersion: 'tool-prompt-secret-v9',
    persisted: true,
    billing: { state: 'settled', pendingReconciliation: false },
    employeeSnapshot: {
      identity: { idx: 101, name: employee.name },
      capabilities: [{ name: '工具箱专属隐秘能力' }],
      skills: [{ title: '工具箱专属隐秘技能' }],
      prompts: { effectiveTemplate: '工具箱专属隐秘提示词' },
      workMethod: { steps: ['工具箱专属隐秘工作方式'] },
      workConfig: { model: 'toolbox-secret-model' },
      jobProfile: { duty: '工具箱专属隐秘岗位档案' },
      systemContext: '工具箱完整岗位手册秘密',
      profileVersion: 'tool-profile-secret-r9',
    },
    internalTrace: { sourcePath: '/private/toolbox/profile' },
  }),
  '2026-07-21 09:00:00', '2026-07-21 09:00:01',
);

const soloSnapshotA = {
  schemaVersion: 'content-employee-run-snapshot.v1',
  profileVersion: 'content-0-r3',
  promptHash: 'prompt-hash-a',
  messageMode: 'single_user',
  employee: { idx: 0, key: 'trend', name: '趋势官', group: '热点雷达部' },
  capabilities: [
    { name: '热榜扫描', desc: '扫描授权渠道热点', required: true, enabled: true, locked: true },
  ],
  coreSkill: [
    { title: '热点判断', source: 'Paihuo内容员工出厂岗位 Skill', required: true, locked: true },
  ],
  historicalSkills: [
    { title: '旧平台趋势卡', source: 'Paihuo历史技能快照', verificationStatus: 'legacy_unverified' },
  ],
  customSkills: [
    { title: 'A店节气菜品', source: 'A店自定义', enabled: true },
  ],
  workMethod: {
    approval: { code: 'boss_review', description: '老板审核后才能发布' },
    handoff: { target: '文案部' },
  },
  workConfig: {
    factory: { common: { outputLength: 'std' } },
    effective: { outputLength: 'full', approvalMode: '老板审核' },
  },
  jobProfile: {
    duty: '提供热点候选，不直接对外发布',
    boundaries: ['对外发布必须由有权限的人类审批。'],
  },
  dispatch: { title: 'A店夏日菜单趋势', type: '分析建议', requirement: '结合门店素材给出候选选题' },
  provenance: {
    contentCatalog: { referencePath: 'server/catalog/restaurant-content.json', schemaVersion: 'v1' },
    historicalSkills: { snapshot: { sha256: 'skills-hash-a' } },
  },
  promptCompilation: {
    factoryPromptHash: 'content-factory-secret-hash',
    enterprisePromptAppended: true,
  },
};

function insertSoloRun({
  tenantId,
  employeeIdx,
  employeeKey,
  employeeName,
  employeeGroup,
  title,
  status,
  resultMd,
  createdBy,
  createdAt,
  snapshot,
  aiMode,
  type = '分析建议',
  requirement = `输入：${title}`,
}) {
  return Number(db.prepare(`INSERT INTO content_employee_runs(
    tenant_id,employee_idx,employee_key,employee_name,employee_group,
    title,type,requirement,due_at,status,result_md,ai_mode,model,
    profile_version,prompt_hash,snapshot_json,created_by,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    tenantId, employeeIdx, employeeKey, employeeName, employeeGroup,
    title, type, requirement, '2026-07-31 18:00:00', status, resultMd,
    aiMode || (status === '失败' ? 'failed' : null),
    resultMd ? (aiMode === 'api' ? 'test-model' : 'template') : null,
    snapshot.profileVersion, snapshot.promptHash, JSON.stringify(snapshot),
    createdBy, createdAt, createdAt,
  ).lastInsertRowid);
}

function proofFeature(refType, refId, tenantId) {
  if (refType === 'tool_run') {
    return `经营工具箱·${q.get('SELECT tool_title FROM tool_runs WHERE tenant_id=? AND id=?', tenantId, refId)?.tool_title || ''}`;
  }
  if (refType === 'agent_task') {
    return `员工任务·${q.get(`SELECT m.name FROM agent_tasks t JOIN marshals m ON m.id=t.marshal_id
      WHERE t.tenant_id=? AND t.id=?`, tenantId, refId)?.name || ''}`;
  }
  if (refType === 'content_employee_run') {
    return `内容员工单派·${q.get(`SELECT employee_name FROM content_employee_runs
      WHERE tenant_id=? AND id=?`, tenantId, refId)?.employee_name || ''}`;
  }
  return '历史修复证据测试';
}

function settledApiProof({
  refType,
  refId,
  userId = bossA.id,
  tenantId = 1,
  holdModel = 'test-model',
  actualModel = holdModel,
  usage = { inputTokens: 80, outputTokens: 40 },
}) {
  return runWithTenant(tenantId, () => {
    const currentCredits = Number(q.get('SELECT credits FROM tenants WHERE id=?', tenantId)?.credits || 0);
    const testTopUp = Math.max(5, 5 - currentCredits);
    q.run('UPDATE tenants SET credits=credits+? WHERE id=?', testTopUp, tenantId);
    const feature = proofFeature(refType, refId, tenantId);
    const hold = holdCredits({
      userId,
      feature,
      kind: 'text',
      model: holdModel,
      credits: 2,
      refType,
      refId,
    });
    settleHold(hold, {
      model: actualModel,
      aiMode: 'api',
      credits: 1,
      usage,
      note: '真实API正用量结算测试',
    });
    return { ...hold, testTopUp };
  });
}

function restaurantFailoverEvidence(baseEvidence, { legal = true } = {}) {
  const requestedModel = 'deepseek-v4-flash';
  const effectiveModel = 'gpt-5.5';
  const modelFailover = {
    from: requestedModel,
    to: effectiveModel,
    reason: 'retryable_zero_usage_transport_failure',
    attempt: 3,
  };
  const usage = { inputTokens: 80, outputTokens: 40 };
  const providerAttempts = [
    {
      number: 1,
      phase: 'acquire',
      mode: 'error',
      model: requestedModel,
      requestedModel,
      effectiveModel: requestedModel,
      modelFailover: null,
      apiObtained: false,
      contractValid: null,
      // 503本身不会触发换模，但仍属于同一首选模型的零Token传输尝试。
      // 后一轮502才是实际触发切换的权威尝试。
      failure: {
        code: 'provider_upstream_error',
        status: 503,
        timedOut: false,
        retryable: true,
      },
      usage: { inputTokens: 0, outputTokens: 0 },
      receivedChars: 0,
      budgetClass: 'transport',
    },
    {
      number: 2,
      phase: 'acquire',
      mode: 'error',
      model: requestedModel,
      requestedModel,
      effectiveModel: requestedModel,
      modelFailover: null,
      apiObtained: false,
      contractValid: null,
      failure: legal
        ? {
            code: 'provider_upstream_error',
            status: 502,
            timedOut: false,
            retryable: true,
          }
        : {
            // HTTP 502不能与“请求参数失败”机器码拼接成合法换模证据。
            code: 'provider_request_failed',
            status: 502,
            timedOut: false,
            retryable: true,
          },
      usage: { inputTokens: 0, outputTokens: 0 },
      receivedChars: 0,
      budgetClass: 'transport',
    },
    {
      number: 3,
      phase: 'acquire',
      mode: 'api',
      model: effectiveModel,
      requestedModel,
      effectiveModel,
      modelFailover,
      apiObtained: true,
      contractValid: true,
      failure: null,
      usage,
      receivedChars: 0,
      budgetClass: 'candidate',
    },
  ];
  return {
    ...baseEvidence,
    outputContract: {
      ...baseEvidence.outputContract,
      requestedModel,
      effectiveModel,
      modelFailover,
      providerAttempts,
      providerBudget: {
        requestedModel,
        effectiveModel,
        modelFailover,
        candidateLimit: 3,
        transportFailureLimit: 3,
        totalAttemptLimit: 6,
      },
    },
    providerAttempt: {
      mode: 'api',
      model: effectiveModel,
      requestedModel,
      effectiveModel,
      modelFailover,
      usage,
    },
  };
}

function heldApiProof({ refType, refId, userId = bossA.id, tenantId = 1 }) {
  return runWithTenant(tenantId, () => {
    const currentCredits = Number(q.get('SELECT credits FROM tenants WHERE id=?', tenantId)?.credits || 0);
    const testTopUp = Math.max(5, 5 - currentCredits);
    q.run('UPDATE tenants SET credits=credits+? WHERE id=?', testTopUp, tenantId);
    const feature = proofFeature(refType, refId, tenantId);
    const hold = holdCredits({
      userId,
      feature,
      kind: 'text',
      model: 'test-model',
      credits: 2,
      refType,
      refId,
    });
    return { ...hold, testTopUp };
  });
}

function removeSettledProof(hold, tenantId = 1) {
  if (!hold) return;
  runWithTenant(tenantId, () => {
    const proof = q.get('SELECT status,held_credits,settled_credits FROM credit_holds WHERE id=?', hold.holdId);
    const restore = proof?.status === 'held'
      ? Number(proof.held_credits || 0)
      : Number(proof?.settled_credits || 0);
    q.run('UPDATE tenants SET credits=credits+? WHERE id=?', restore, tenantId);
    q.run('DELETE FROM credit_holds WHERE id=?', hold.holdId);
    q.run('DELETE FROM credit_logs WHERE id=?', hold.logId);
    q.run('UPDATE tenants SET credits=credits-? WHERE id=?', Number(hold.testTopUp || 0), tenantId);
  });
}

function strictToolProvenance(resultMd, hold, {
  inputTokens = 80,
  outputTokens = 40,
  model = 'test-model',
} = {}) {
  return {
    mode: 'api',
    model,
    usage: { inputTokens, outputTokens },
    attempts: [{
      attempt: 1,
      mode: 'api',
      model,
      usage: { inputTokens, outputTokens },
      outcome: 'accepted',
      reason: 'accepted',
    }],
    completionState: 'completed',
    contract: {
      validator: 'toolbox-delivery-contract',
      status: 'valid',
      valid: true,
      requiresManualRepair: false,
      errors: [],
    },
    persisted: true,
    internalProfileLeakage: {
      schemaVersion: 'internal-profile-leakage.v1',
      detected: false,
      status: 'clear',
      outputHash: crypto.createHash('sha256').update(resultMd, 'utf8').digest('hex'),
      reasons: [],
      categories: [],
    },
    billing: {
      state: 'settled',
      holdId: hold?.holdId || null,
      requestedModel: model,
      chargedCredits: 1,
      credits: 1,
      pendingReconciliation: false,
    },
  };
}

function validRestaurantExecutionEvidence(seed = 'b') {
  return {
    kind: 'restaurant_employee_execution_evidence',
    outputContract: {
      valid: true,
      contractId: 'restaurant-remediation-contract',
      schemaVersion: 'restaurant-remediation.v1',
      primaryArtifact: 'report',
      artifacts: [{
        primary: true,
        kind: 'report',
        contractId: 'restaurant-remediation-contract',
        schemaVersion: 'restaurant-remediation.v1',
        contentSha256: seed.repeat(64).slice(0, 64),
      }],
    },
    internalProfileLeakage: { detected: false, matches: [] },
  };
}

const initialTaskProof = settledApiProof({
  refType: 'agent_task', refId: Number(taskA), userId: staffA.id,
});
const initialToolProof = settledApiProof({
  refType: 'tool_run', refId: 1, userId: staffA.id,
});
runWithTenant(1, () => q.run('UPDATE tool_runs SET provenance_json=? WHERE id=1',
  JSON.stringify({
    ...strictToolProvenance('## 工具结果\n\n待老板确认后发布。', initialToolProof),
    employeeSnapshot: {
      identity: { idx: 101, name: employee.name },
      capabilities: [{ name: '工具箱专属隐秘能力' }],
      skills: [{ title: '工具箱专属隐秘技能' }],
      prompts: { effectiveTemplate: '工具箱专属隐秘提示词' },
      workMethod: { steps: ['工具箱专属隐秘工作方式'] },
      workConfig: { model: 'toolbox-secret-model' },
      jobProfile: { duty: '工具箱专属隐秘岗位档案' },
    },
  })));

const soloReadyA = insertSoloRun({
  tenantId: 1,
  employeeIdx: 0,
  employeeKey: 'trend',
  employeeName: '趋势官',
  employeeGroup: '热点雷达部',
  title: 'A店夏日菜单趋势',
  status: '待审阅',
  resultMd: '# 待审阅结果\n\n三个候选选题，发布前由老板审核。',
  createdBy: staffA.id,
  createdAt: '2026-07-22 09:00:00',
  snapshot: {
    ...soloSnapshotA,
    contractValid: true,
    billing: { state: 'settled', chargedCredits: 1 },
    internalProfileLeakage: { detected: false, matches: [] },
    providerAttempt: {
      mode: 'api', model: 'test-model', usage: { inputTokens: 80, outputTokens: 40 },
    },
  },
  aiMode: 'api',
});
const initialSoloProof = settledApiProof({
  refType: 'content_employee_run', refId: soloReadyA, userId: staffA.id,
});
const soloRunningA = insertSoloRun({
  tenantId: 1,
  employeeIdx: 1,
  employeeKey: 'research',
  employeeName: '资料官',
  employeeGroup: '热点雷达部',
  title: 'A店平台规则核验',
  status: '生成中',
  resultMd: null,
  createdBy: bossA.id,
  createdAt: '2026-07-23 09:00:00',
  snapshot: { ...soloSnapshotA, profileVersion: 'content-1-r0', promptHash: 'prompt-hash-running' },
});
const soloFailedA = insertSoloRun({
  tenantId: 1,
  employeeIdx: 2,
  employeeKey: 'planner',
  employeeName: '策划官',
  employeeGroup: '内容策划部',
  title: 'A店月度选题规划',
  status: '失败',
  resultMd: null,
  createdBy: bossA.id,
  createdAt: '2026-07-24 09:00:00',
  snapshot: { ...soloSnapshotA, profileVersion: 'content-2-r0', promptHash: 'prompt-hash-failed' },
});
const soloPrivateB = insertSoloRun({
  tenantId: 2,
  employeeIdx: 0,
  employeeKey: 'trend',
  employeeName: '趋势官',
  employeeGroup: 'B店私有内容部',
  title: 'B店私有趋势任务',
  status: '待审阅',
  resultMd: '# B店私有结果\n\nA店不得读取。',
  createdBy: bossB.id,
  createdAt: '2026-07-22 10:00:00',
  snapshot: {
    ...soloSnapshotA,
    profileVersion: 'content-0-r8',
    promptHash: 'prompt-hash-b-secret',
    billing: { state: 'released' },
  },
});

function appFor(user) {
  const app = express();
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => { req.user = user; next(); }));
  app.use('/employee-outputs', outputRoutes);
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function collectJsonKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonKeys(item, keys);
    return keys;
  }
  if (!value || typeof value !== 'object') return keys;
  for (const [key, nested] of Object.entries(value)) {
    keys.add(key);
    collectJsonKeys(nested, keys);
  }
  return keys;
}

test('统一聚合数字员工任务、经营工具与内容员工单独派活，并按来源透视', async () => {
  await withServer(bossA, async base => {
    const response = await fetch(`${base}/employee-outputs?start=2026-07-01&end=2026-07-31&dimension=source`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.summary.total, 5);
    assert.equal(data.summary.withOutput, 3);
    assert.deepEqual(data.summary, {
      total: 5,
      withOutput: 3,
      completed: 1,
      pending: 3,
      failed: 1,
      remediated: 0,
    });
    const pendingTask = data.rows.find(row => row.ref === `task:${taskA}`);
    const completedTool = data.rows.find(row => row.ref === 'tool:1');
    assert.equal(pendingTask.status, '待审核');
    assert.equal(pendingTask.displayStatus, '待人工审阅');
    assert.match(pendingTask.nextAction, /审阅/u);
    assert.equal(completedTool.status, '已通过');
    assert.equal(completedTool.displayStatus, '已人工采纳（可用于业务）');
    assert.deepEqual(data.pivot.map(row => row.label).sort(), ['内容员工单独派活', '数字员工任务', '经营工具']);
    assert.deepEqual(data.rows.map(row => row.ref).sort(), [
      `content_solo:${soloFailedA}`,
      `content_solo:${soloReadyA}`,
      `content_solo:${soloRunningA}`,
      `task:${taskA}`,
      'tool:1',
    ].sort());
    assert.match(data.dataset.disclaimer, /不代表营业额/);
    assert.equal(data.dataset.store.id, 1);
    assert.ok(data.dataset.store.name);
    assert.equal(data.calculation.unit, '一条持久化运行记录');
  });
});

test('内容员工聚合列表仅对老板、管理员和平台超管保留内部版本与提示词哈希', async () => {
  for (const role of ['boss', 'admin', 'platform_super']) {
    await withServer({ ...bossA, role }, async base => {
      const data = await fetch(`${base}/employee-outputs?start=2026-07-01&end=2026-07-31&source=content_solo`)
        .then(response => response.json());
      const ready = data.rows.find(row => row.ref === `content_solo:${soloReadyA}`);
      assert.ok(ready, role);
      assert.equal(ready.profileVersion, 'content-0-r3', role);
      assert.equal(ready.promptHash, 'prompt-hash-a', role);
    });
  }
});

test('内容员工运行支持来源、分部、员工、日期、状态筛选与多维透视', async () => {
  await withServer(bossA, async base => {
    const sourceQuery = new URLSearchParams({
      start: '2026-07-01', end: '2026-07-31', source: 'content_solo', dimension: 'status',
    });
    const sourceData = await fetch(`${base}/employee-outputs?${sourceQuery}`).then(response => response.json());
    assert.equal(sourceData.summary.total, 3);
    assert.equal(sourceData.summary.withOutput, 1);
    assert.equal(sourceData.summary.pending, 2);
    assert.equal(sourceData.summary.failed, 1);
    assert.deepEqual(sourceData.pivot.map(row => row.label).sort(), [
      '生成失败（可重跑）', '待审核', '生成中',
    ].sort());
    assert.ok(sourceData.rows.every(row => row.source === 'content_solo'));
    assert.equal(sourceData.rows.find(row => row.status === '生成中').hasOutput, false);
    assert.equal(sourceData.rows.find(row => row.status === '生成失败（可重跑）').hasOutput, false);

    const groupPivot = await fetch(`${base}/employee-outputs?start=2026-07-01&end=2026-07-31&source=content_solo&dimension=group`)
      .then(response => response.json());
    assert.deepEqual(groupPivot.pivot.map(row => [row.label, row.total]), [
      ['热点雷达部', 2],
      ['内容策划部', 1],
    ]);
    const domainPivot = await fetch(`${base}/employee-outputs?start=2026-07-01&end=2026-07-31&source=content_solo&dimension=domain`)
      .then(response => response.json());
    assert.deepEqual(domainPivot.pivot.map(row => [row.label, row.total]), [['Paihuo内容生产部', 3]]);

    const combined = new URLSearchParams({
      start: '2026-07-22',
      end: '2026-07-22',
      domain: 'content',
      source: 'content_solo',
      group: '热点雷达部',
      employee: '0',
      status: '待审核',
      dimension: 'employee',
    });
    const filtered = await fetch(`${base}/employee-outputs?${combined}`).then(response => response.json());
    assert.equal(filtered.summary.total, 1);
    assert.equal(filtered.rows[0].ref, `content_solo:${soloReadyA}`);
    assert.equal(filtered.rows[0].abilityDomain, 'content');
    assert.equal(filtered.rows[0].abilityDomainLabel, 'Paihuo内容生产部');
    assert.equal(filtered.rows[0].group, '热点雷达部');
    assert.equal(filtered.pivot[0].label, '0 · 趋势官');
  });
});

test('能力域筛选与透视生效，来源和能力域保持独立口径', async () => {
  await withServer(bossA, async base => {
    const query = new URLSearchParams({
      start: '2026-07-01', end: '2026-07-31', domain: 'tool', source: 'all', dimension: 'domain',
    });
    const response = await fetch(`${base}/employee-outputs?${query}`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.summary.total, 1);
    assert.equal(data.rows[0].abilityDomain, 'tool');
    assert.deepEqual(data.pivot.map(row => row.label), ['餐饮经营工具']);
    assert.ok(data.options.domains.some(item => item.value === 'restaurant'));
    assert.ok(data.options.domains.some(item => item.value === 'tool'));
  });
});

test('模板工具底稿标记质检失败，不计入合格产出或已通过', async () => {
  let draftId;
  runWithTenant(1, () => {
    draftId = q.run(`INSERT INTO tool_runs(
      tool_key,tool_title,title,status,employee_idx,employee_name,specialist_id,created_by,
      input_json,input_summary,result_md,assumptions_json,evidence_json,provenance_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'hot', '今日必发', '未完成模板工具', 'done', 101, employee.name, employee.id, bossA.id,
    '{}', '仅模板输入', '# 待补材料模板', '[]', '[]',
    JSON.stringify({ mode: 'template', completionState: 'draft' }),
    '2026-07-25 09:00:00', '2026-07-25 09:00:01').lastInsertRowid;
  });
  try {
    await withServer(bossA, async base => {
      const data = await fetch(`${base}/employee-outputs?start=2026-07-25&end=2026-07-25&source=tool`)
        .then(response => response.json());
      assert.equal(data.summary.total, 1);
      assert.equal(data.summary.withOutput, 0);
      assert.equal(data.summary.completed, 0);
      assert.equal(data.rows[0].status, '质检失败（可重跑）');
      assert.equal(data.rows[0].displayStatus, '失败需返工（质检未通过）');
      assert.equal(data.rows[0].nextAction, '查看岗位质检错误，补充或修正材料后重新派活');
      assert.equal(data.rows[0].evidenceKind, '质检失败记录');
    });
  } finally {
    runWithTenant(1, () => q.run('DELETE FROM tool_runs WHERE id=?', draftId));
  }
});

test('工具箱聚合与工具箱权威可用门一致：真实API、契约、落库、泄漏与结算缺一不可', async () => {
  const baseProvenance = {
    mode: 'api',
    completionState: 'completed',
    contract: { validator: 'toolbox-delivery-contract', status: 'valid', valid: true, errors: [] },
    persisted: true,
    billing: { state: 'settled', pendingReconciliation: false },
    internalProfileLeakage: { detected: false, matches: [] },
  };
  const fixtures = [
    ['可验证工具终态', 'done', baseProvenance],
    ['工具账务待对账', 'done', {
      ...baseProvenance,
      billing: { state: 'pending_reconciliation', pendingReconciliation: true },
    }],
    ['工具契约无效', 'done', {
      ...baseProvenance,
      contract: { validator: 'toolbox-delivery-contract', status: 'invalid', valid: false, errors: ['缺少主产物'] },
    }],
    ['工具未确认落库', 'done', { ...baseProvenance, persisted: false }],
    ['工具内部档案泄漏', 'done', {
      ...baseProvenance,
      internalProfileLeakage: { detected: true, matches: [{ type: 'exact' }] },
    }],
    ['工具仍在运行', 'running', {
      ...baseProvenance,
      completionState: 'generating',
      persisted: false,
      billing: { state: 'held', pendingReconciliation: false },
    }],
  ];
  const ids = runWithTenant(1, () => fixtures.map(([title, status, provenance]) => Number(q.run(`INSERT INTO tool_runs(
      tool_key,tool_title,title,status,employee_idx,employee_name,specialist_id,created_by,
      input_json,input_summary,result_md,assumptions_json,evidence_json,provenance_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'hot', '今日必发', title, status, 101, employee.name, employee.id, bossA.id,
    '{}', '权威可用门反例', `# ${title}`, '[]', '[]', JSON.stringify(provenance),
    '2026-07-28 09:00:00', '2026-07-28 09:00:01').lastInsertRowid)));
  const validProof = settledApiProof({ refType: 'tool_run', refId: ids[0] });
  runWithTenant(1, () => q.run('UPDATE tool_runs SET provenance_json=? WHERE id=?',
    JSON.stringify(strictToolProvenance('# 可验证工具终态', validProof)), ids[0]));
  try {
    await withServer(bossA, async base => {
      const data = await fetch(`${base}/employee-outputs?start=2026-07-28&end=2026-07-28&source=tool`)
        .then(response => response.json());
      const byTitle = new Map(data.rows.map(row => [row.title, row]));
      assert.equal(byTitle.get('可验证工具终态').status, '已通过');
      assert.equal(byTitle.get('可验证工具终态').hasOutput, true);
      assert.equal(byTitle.get('工具账务待对账').status, '待账务对账');
      assert.equal(byTitle.get('工具账务待对账').hasOutput, false);
      for (const title of ['工具契约无效', '工具未确认落库', '工具内部档案泄漏']) {
        assert.equal(byTitle.get(title).status, '待账务对账', title);
        assert.equal(byTitle.get(title).hasOutput, false, title);
      }
      assert.equal(byTitle.get('工具仍在运行').status, '生成中');
      assert.equal(byTitle.get('工具仍在运行').hasOutput, false);
      assert.equal(data.summary.withOutput, 1);
      assert.equal(data.summary.completed, 1);
      for (const [index, [title]] of fixtures.entries()) {
        const detail = await fetch(`${base}/employee-outputs/drill/tool/${ids[index]}`)
          .then(response => response.json());
        assert.equal(detail.record.status, byTitle.get(title).status, `${title}:list/drill`);
      }
    });
  } finally {
    removeSettledProof(validProof);
    runWithTenant(1, () => ids.forEach(id => q.run('DELETE FROM tool_runs WHERE id=?', id)));
  }
});

test('当前状态权威门拦截重复账本、创建人错配和已释放记录，待结算优先显示对账', async () => {
  const created = runWithTenant(1, () => {
    const toolResult = '# 重复账本工具\n\n不得标记已通过。';
    const toolId = Number(q.run(`INSERT INTO tool_runs(
      tool_key,tool_title,title,status,employee_idx,employee_name,created_by,
      input_json,input_summary,result_md,provenance_json,created_at,updated_at
    ) VALUES('hot','今日必发','重复账本工具','done',101,?,?,'{}','反例',?,'{}',
      '2026-07-28 12:00:00','2026-07-28 12:00:01')`, employee.name, bossA.id, toolResult).lastInsertRowid);
    const pendingSoloId = insertSoloRun({
      tenantId: 1, employeeIdx: 5, employeeKey: 'visual', employeeName: '视觉官',
      employeeGroup: '视觉制作部', title: '待结算单派', status: '待审阅',
      resultMd: '有正文但账务未结算。', createdBy: bossA.id,
      createdAt: '2026-07-28 12:10:00', aiMode: 'api',
      snapshot: {
        ...soloSnapshotA, contractValid: true,
        billing: { state: 'pending_reconciliation', pendingReconciliation: true },
        internalProfileLeakage: { detected: false },
        providerAttempt: { mode: 'api', model: 'test-model', usage: { inputTokens: 80, outputTokens: 40 } },
      },
    });
    const releasedSoloId = insertSoloRun({
      tenantId: 1, employeeIdx: 6, employeeKey: 'distribute', employeeName: '分发官',
      employeeGroup: '分发增长部', title: '已释放单派', status: '待审阅',
      resultMd: '已释放费用的文本不得待审。', createdBy: bossA.id,
      createdAt: '2026-07-28 12:20:00', aiMode: 'api',
      snapshot: {
        ...soloSnapshotA, contractValid: true, billing: { state: 'released', chargedCredits: 0 },
        internalProfileLeakage: { detected: false },
        providerAttempt: { mode: 'api', model: 'test-model', usage: { inputTokens: 80, outputTokens: 40 } },
      },
    });
    const mismatchSoloId = insertSoloRun({
      tenantId: 1, employeeIdx: 7, employeeKey: 'operate', employeeName: '运营官',
      employeeGroup: '运营策略部', title: '创建人错配单派', status: '待审阅',
      resultMd: '账本归属不是任务创建人。', createdBy: staffA.id,
      createdAt: '2026-07-28 12:30:00', aiMode: 'api',
      snapshot: {
        ...soloSnapshotA, contractValid: true, billing: { state: 'settled', chargedCredits: 1 },
        internalProfileLeakage: { detected: false },
        providerAttempt: { mode: 'api', model: 'test-model', usage: { inputTokens: 80, outputTokens: 40 } },
      },
    });
    const restaurantOutputId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,ai_mode,creator_id,marshal_id,created_at
    ) VALUES('员工产出','创建人错配餐饮产出','不得标记已通过。','可使用','api',?,?,
      '2026-07-28 12:41:00')`, bossA.id, employee.marshal_id).lastInsertRowid);
    const restaurantTaskId = Number(q.run(`INSERT INTO agent_tasks(
      marshal_id,specialist_id,title,type,requirement,status,output_id,created_by,created_at,
      employee_profile_version,employee_web_snapshot
    ) VALUES(?,?,?,'岗位交付','核验创建人','已完成',?,?,
      '2026-07-28 12:40:00','restaurant-authority-test',?)`,
    employee.marshal_id, employee.id, '创建人错配餐饮任务', restaurantOutputId, staffA.id,
    JSON.stringify(validRestaurantExecutionEvidence('c'))).lastInsertRowid);
    const restaurantApprovalId = Number(q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,reviewer_id,decided_at
    ) VALUES('content',?,'创建人错配餐饮产出','反例','none','[]','已通过',?,?,
      '2026-07-28 12:42:00')`, restaurantOutputId, staffA.id, bossA.id).lastInsertRowid);
    return {
      toolId, toolResult, pendingSoloId, releasedSoloId, mismatchSoloId,
      restaurantOutputId, restaurantTaskId, restaurantApprovalId,
    };
  });
  const toolProofOne = settledApiProof({ refType: 'tool_run', refId: created.toolId });
  const toolProofTwo = settledApiProof({ refType: 'tool_run', refId: created.toolId });
  runWithTenant(1, () => q.run('UPDATE tool_runs SET provenance_json=? WHERE id=?',
    JSON.stringify(strictToolProvenance(created.toolResult, toolProofTwo)), created.toolId));
  const pendingProof = heldApiProof({ refType: 'content_employee_run', refId: created.pendingSoloId });
  const releasedProof = heldApiProof({ refType: 'content_employee_run', refId: created.releasedSoloId });
  runWithTenant(1, () => settleHold(releasedProof, {
    model: 'test-model', aiMode: 'api', credits: 0,
    usage: { inputTokens: 0, outputTokens: 0 }, note: '测试释放',
  }));
  const mismatchProof = settledApiProof({
    refType: 'content_employee_run', refId: created.mismatchSoloId, userId: bossA.id,
  });
  const restaurantProof = settledApiProof({
    refType: 'agent_task', refId: created.restaurantTaskId, userId: staffA.id,
  });
  try {
    await withServer(bossA, async base => {
      const data = await fetch(`${base}/employee-outputs?start=2026-07-28&end=2026-07-28`)
        .then(response => response.json());
      const expected = new Map([
        [`tool:${created.toolId}`, '待账务对账'],
        [`content_solo:${created.pendingSoloId}`, '待账务对账'],
        [`content_solo:${created.releasedSoloId}`, '质检失败（可重跑）'],
        [`content_solo:${created.mismatchSoloId}`, '待账务对账'],
        [`task:${created.restaurantTaskId}`, '待账务对账'],
      ]);
      for (const [ref, status] of expected) {
        const listRow = data.rows.find(row => row.ref === ref);
        assert.equal(listRow?.status, status, `${ref}:list`);
        assert.equal(listRow?.hasOutput, false, `${ref}:usable`);
        const [source, rawId] = ref.split(':');
        const detail = await fetch(`${base}/employee-outputs/drill/${source}/${rawId}`)
          .then(response => response.json());
        assert.equal(detail.record.status, status, `${ref}:drill`);
      }
    });
  } finally {
    for (const proof of [
      toolProofOne, toolProofTwo, pendingProof, releasedProof, mismatchProof, restaurantProof,
    ]) {
      removeSettledProof(proof);
    }
    runWithTenant(1, () => {
      q.run('DELETE FROM tool_runs WHERE id=?', created.toolId);
      q.run('DELETE FROM content_employee_runs WHERE id IN (?,?,?)',
        created.pendingSoloId, created.releasedSoloId, created.mismatchSoloId);
      q.run('DELETE FROM approvals WHERE id=?', created.restaurantApprovalId);
      q.run('DELETE FROM agent_tasks WHERE id=?', created.restaurantTaskId);
      q.run('DELETE FROM contents WHERE id=?', created.restaurantOutputId);
    });
  }
});

test('餐饮账务只在完整零Token传输failover证据下允许requested与actual模型不同', async () => {
  const fixtures = runWithTenant(1, () => [
    { title: '合法传输切换账务', legal: true },
    { title: '伪造契约切换账务', legal: false },
  ].map(({ title, legal }) => {
    const requirement = `${title}：核验模型切换账务权威门`;
    const delivery = restaurantDelivery(Number(employee.employee_idx), title, requirement);
    const outputId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,ai_mode,creator_id,marshal_id,created_at
    ) VALUES('员工产出',?,?,'可使用','api',?,?,
      '2026-07-28 14:01:00')`, title, delivery.body, bossA.id, employee.marshal_id).lastInsertRowid);
    const evidence = restaurantFailoverEvidence(delivery.evidence, { legal });
    const taskId = Number(q.run(`INSERT INTO agent_tasks(
      marshal_id,specialist_id,title,type,requirement,status,output_id,created_by,created_at,
      employee_profile_version,employee_web_snapshot
    ) VALUES(?,?,?,'岗位交付',?,'已完成',?,?,
      '2026-07-28 14:00:00','restaurant-failover-billing-test',?)`,
    employee.marshal_id, employee.id, title, requirement, outputId, bossA.id,
    JSON.stringify(evidence)).lastInsertRowid);
    const approvalId = Number(q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,reviewer_id,decided_at
    ) VALUES('content',?,?,'模型切换账务验收','none','[]','已通过',?,?,
      '2026-07-28 14:02:00')`, outputId, title, bossA.id, bossA.id).lastInsertRowid);
    return { title, legal, outputId, taskId, approvalId };
  }));
  const proofs = fixtures.map(item => settledApiProof({
    refType: 'agent_task',
    refId: item.taskId,
    userId: bossA.id,
    holdModel: 'deepseek-v4-flash',
    actualModel: 'gpt-5.5',
  }));
  try {
    await withServer(bossA, async base => {
      const data = await fetch(
        `${base}/employee-outputs?start=2026-07-28&end=2026-07-28&source=task`,
      ).then(response => response.json());
      const byTitle = new Map(data.rows.map(row => [row.title, row]));
      assert.equal(byTitle.get('合法传输切换账务')?.status, '已通过');
      assert.equal(byTitle.get('合法传输切换账务')?.hasOutput, true);
      assert.equal(byTitle.get('伪造契约切换账务')?.status, '待账务对账');
      assert.equal(byTitle.get('伪造契约切换账务')?.hasOutput, false);
    });
  } finally {
    proofs.forEach(proof => removeSettledProof(proof));
    runWithTenant(1, () => fixtures.forEach(item => {
      q.run('DELETE FROM approvals WHERE id=?', item.approvalId);
      q.run('DELETE FROM agent_tasks WHERE id=?', item.taskId);
      q.run('DELETE FROM contents WHERE id=?', item.outputId);
    }));
  }
});

test('降级、错误、模拟与演示模式在工具、内容和单派聚合中都是质检失败', async () => {
  const inserted = runWithTenant(1, () => {
    const toolId = Number(q.run(`INSERT INTO tool_runs(
      tool_key,tool_title,title,status,employee_idx,employee_name,specialist_id,created_by,
      input_json,input_summary,result_md,assumptions_json,evidence_json,provenance_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'hot', '今日必发', '降级工具伪产出', 'done', 101, employee.name, employee.id, bossA.id,
    '{}', '降级输入', '不应计入合格产出的正文', '[]', '[]',
    JSON.stringify({ mode: 'fallback', completionState: 'completed' }),
    '2026-07-27 08:00:00', '2026-07-27 08:00:01').lastInsertRowid);
    const contentId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,ai_mode,creator_id,content_employee_idx,content_employee_key,
      content_employee_name,content_employee_group,content_run_mode,snapshot_json,created_at
    ) VALUES('朋友圈文案','错误模式伪内容','不应可使用的正文','可使用','error',?,3,'draft',
      '撰稿人','文案创作部','single_station',?,'2026-07-27 09:00:00')`,
    bossA.id, JSON.stringify({ contract: { valid: true, status: 'valid' } })).lastInsertRowid);
    const soloId = insertSoloRun({
      tenantId: 1,
      employeeIdx: 3,
      employeeKey: 'draft',
      employeeName: '撰稿人',
      employeeGroup: '文案创作部',
      title: '模拟模式伪单派产出',
      status: '待审阅',
      resultMd: '不应进入待审的正文',
      createdBy: bossA.id,
      createdAt: '2026-07-27 10:00:00',
      snapshot: { ...soloSnapshotA, contractValid: true, billing: { state: 'released' } },
      aiMode: 'mock',
    });
    return { toolId, contentId, soloId };
  });
  try {
    await withServer(bossA, async base => {
      const data = await fetch(
        `${base}/employee-outputs?start=2026-07-27&end=2026-07-27`,
      ).then(response => response.json());
      for (const ref of [
        `tool:${inserted.toolId}`,
        `content:output:${inserted.contentId}`,
      ]) {
        const row = data.rows.find(candidate => candidate.ref === ref);
        assert.ok(row, ref);
        assert.equal(row.status, '质检失败（可重跑）', ref);
        assert.equal(row.displayStatus, '失败需返工（质检未通过）', ref);
        assert.equal(row.hasOutput, false, ref);
      }
      const solo = data.rows.find(candidate => candidate.ref === `content_solo:${inserted.soloId}`);
      assert.equal(solo.status, '待账务对账');
      assert.equal(solo.hasOutput, false);
    });
  } finally {
    runWithTenant(1, () => {
      q.run('DELETE FROM tool_runs WHERE id=?', inserted.toolId);
      q.run('DELETE FROM contents WHERE id=?', inserted.contentId);
      q.run('DELETE FROM content_employee_runs WHERE id=?', inserted.soloId);
    });
  }
});

test('系统收口的餐饮模板底稿在员工任务列表仍显示质检失败，不冒充人工驳回', async () => {
  const item = runWithTenant(1, () => {
    const outputId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,ai_mode,creator_id,marshal_id,created_at
    ) VALUES('员工产出','系统收口模板底稿','未形成可验收产物','已驳回','template',?,?,
      '2026-07-26 10:01:00')`, staffA.id, employee.marshal_id).lastInsertRowid);
    const taskId = Number(q.run(`INSERT INTO agent_tasks(
      marshal_id,specialist_id,title,type,requirement,status,output_id,created_by,created_at,
      employee_profile_version,employee_prompt_hash,employee_capabilities_snapshot,
      employee_config_snapshot,employee_skills_snapshot,employee_web_snapshot
    ) VALUES(?,?,?,'岗位交付','补充材料后重跑','失败',?,?,
      '2026-07-26 10:00:00','restaurant-reconciled','reconciled-prompt','[]','{}','[]',?)`,
    employee.marshal_id, employee.id, '系统收口模板任务', outputId, staffA.id,
    JSON.stringify({
      kind: 'restaurant_employee_execution_evidence',
      web: { attempted: false, ok: false, results: [] },
      outputContract: { valid: false, skipped: 'template_mode', artifacts: [] },
      reconciliation: {
        code: 'DEMO_UNADOPTABLE_CONTENT_RECONCILED',
        retryable: true,
      },
    })).lastInsertRowid);
    const approvalId = Number(q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,reviewer_id,
      reason,decided_at
    ) VALUES('content',?,'系统收口模板底稿','质检未通过','none','[]','已驳回',?,NULL,
      '系统质量对账：未形成可采纳产物',datetime('now','localtime'))`,
    outputId, staffA.id).lastInsertRowid);
    return { outputId, taskId, approvalId };
  });
  try {
    await withServer(bossA, async base => {
      const data = await fetch(
        `${base}/employee-outputs?start=2026-07-26&end=2026-07-26&source=task`,
      ).then(response => response.json());
      const row = data.rows.find(candidate => candidate.ref === `task:${item.taskId}`);
      assert.ok(row);
      assert.equal(row.status, '质检失败（可重跑）');
      assert.equal(row.displayStatus, '失败需返工（质检未通过）');
      assert.notEqual(row.displayStatus, '失败需返工（人工审阅未通过）');
      assert.equal(row.nextAction, '查看岗位质检错误，补充或修正材料后重新派活');
    });
  } finally {
    runWithTenant(1, () => {
      q.run(`DELETE FROM approvals WHERE id=?`, item.approvalId);
      q.run(`DELETE FROM agent_tasks WHERE id=?`, item.taskId);
      q.run(`DELETE FROM contents WHERE id=?`, item.outputId);
    });
  }
});

test('待核验数据集标记来自数据库持久状态，并使用中性真实表述', async () => {
  q.run(`UPDATE tenants SET data_mode='demo' WHERE id=1`);
  try {
    await withServer(bossA, async base => {
      const data = await fetch(`${base}/employee-outputs?start=2026-07-01&end=2026-07-31`).then(response => response.json());
      assert.equal(process.env.SEED_DEMO, 'false');
      assert.equal(data.dataset.isDemoEnvironment, true);
      assert.equal(data.dataset.kind, '当前环境待核验运行记录');
      assert.equal(data.dataset.kind.includes('演示'), false);
    });
  } finally {
    q.run(`UPDATE tenants SET data_mode='live' WHERE id=1`);
  }
});

test('员工、来源、状态筛选共同生效', async () => {
  await withServer(bossA, async base => {
    const query = new URLSearchParams({
      start: '2026-07-01', end: '2026-07-31', employee: '101', source: 'tool', status: '已通过', dimension: 'employee',
    });
    const data = await fetch(`${base}/employee-outputs?${query}`).then(response => response.json());
    assert.equal(data.summary.total, 1);
    assert.equal(data.rows[0].source, 'tool');
    assert.equal(data.rows[0].employeeIdx, 101);
  });
});

test('穿透返回运行输入、输出、假设与来源', async () => {
  await withServer(bossA, async base => {
    const task = await fetch(`${base}/employee-outputs/drill/task/${taskA}`).then(response => response.json());
    assert.equal(task.record.employeeIdx, 101);
    assert.match(task.output.body, /A店菜单复盘/u);
    assert.match(task.output.body, /可追溯/u);
    assert.equal(task.execution.snapshot.capabilities[0].name, '专属商圈证据地图');
    assert.equal(task.execution.snapshot.skills[0].title, '商圈证据秘策');
    assert.equal(task.execution.snapshot.workConfig.textModel, 'restaurant-secret-model');

    const tool = await fetch(`${base}/employee-outputs/drill/tool/1`).then(response => response.json());
    assert.equal(tool.record.inputs.topic, '午市新品');
    assert.equal(tool.output.provenance.persisted, true);
    assert.equal(tool.output.provenance.employeeSnapshot.capabilities[0].name, '工具箱专属隐秘能力');
    assert.equal(tool.output.provenance.employeeSnapshot.workConfig.model, 'toolbox-secret-model');
    assert.match(tool.disclaimer, /不等同于真实经营成效/);
  });
});

test('非内部档案角色可看本人或下属业务结果，但所有员工内部档案旁路均由服务端删除', async () => {
  const restrictedUsers = [
    staffA,
    { ...staffA, role: 'sales' },
    { ...staffA, role: 'partner' },
    { ...staffA, role: 'manager' },
    opsA,
  ];
  for (const user of restrictedUsers) {
    await withServer(user, async base => {
      const aggregateResponse = await fetch(`${base}/employee-outputs?start=2026-07-01&end=2026-07-31&source=content_solo`);
      assert.equal(aggregateResponse.status, 200, `${user.role}:aggregate`);
      const aggregate = await aggregateResponse.json();
      const readyRow = aggregate.rows.find(row => row.ref === `content_solo:${soloReadyA}`);
      assert.ok(readyRow, `${user.role}:aggregate ready row`);
      assert.equal(readyRow.profileVersion, undefined, user.role);
      assert.equal(readyRow.promptHash, undefined, user.role);
      const aggregateKeys = collectJsonKeys(aggregate);
      assert.equal(aggregateKeys.has('profileVersion'), false, `${user.role}:aggregate profileVersion key`);
      assert.equal(aggregateKeys.has('promptHash'), false, `${user.role}:aggregate promptHash key`);
      for (const secret of [
        'content-0-r3', 'prompt-hash-a', 'prompt-hash-running', 'prompt-hash-failed',
      ]) {
        assert.equal(JSON.stringify(aggregate).includes(secret), false, `${user.role}:aggregate leaked ${secret}`);
      }

      const taskResponse = await fetch(`${base}/employee-outputs/drill/task/${taskA}`);
      assert.equal(taskResponse.status, 200, user.role);
      const task = await taskResponse.json();
      assert.match(task.output.body, /A店菜单复盘/u);
      assert.match(task.output.body, /可追溯/u);
      assert.equal(task.execution.profileVersion, undefined, user.role);
      assert.equal(task.execution.promptHash, undefined, user.role);
      assert.equal(task.execution.snapshot, undefined, user.role);
      assert.equal(task.execution.internalProfileApplied, true, user.role);
      assert.equal(task.execution.redacted, true, user.role);
      for (const forbidden of ['inputEvidence', 'webEvidence', 'outputContract', 'contentSha256']) {
        assert.equal(JSON.stringify(task).includes(forbidden), false, `${user.role}:task leaked ${forbidden}`);
      }
      assert.equal(JSON.stringify(task).includes('专属商圈证据地图'), false, user.role);
      assert.equal(JSON.stringify(task).includes('商圈证据秘策'), false, user.role);
      assert.equal(JSON.stringify(task).includes('restaurant-secret-model'), false, user.role);

      const toolResponse = await fetch(`${base}/employee-outputs/drill/tool/1`);
      assert.equal(toolResponse.status, 200, user.role);
      const tool = await toolResponse.json();
      assert.match(tool.output.body, /待老板确认后发布/u);
      assert.equal(tool.output.provenance.mode, 'api');
      assert.equal(tool.output.provenance.persisted, true);
      assert.equal(tool.output.provenance.promptVersion, undefined, user.role);
      assert.equal(tool.output.provenance.employeeSnapshot, undefined, user.role);
      assert.equal(JSON.stringify(tool).includes('工具箱专属隐秘能力'), false, user.role);
      assert.equal(JSON.stringify(tool).includes('工具箱专属隐秘技能'), false, user.role);
      assert.equal(JSON.stringify(tool).includes('工具箱专属隐秘提示词'), false, user.role);
      assert.equal(JSON.stringify(tool).includes('toolbox-secret-model'), false, user.role);
      assert.equal(JSON.stringify(tool).includes('/private/toolbox/profile'), false, user.role);

      const soloResponse = await fetch(`${base}/employee-outputs/drill/content_solo/${soloReadyA}`);
      assert.equal(soloResponse.status, 200, user.role);
      const solo = await soloResponse.json();
      assert.match(solo.output.body, /三个候选选题/u);
      assert.equal(solo.execution.profileVersion, undefined, user.role);
      assert.equal(solo.execution.promptHash, undefined, user.role);
      assert.equal(solo.output.provenance.profileVersion, undefined, user.role);
      assert.equal(solo.output.provenance.promptHash, undefined, user.role);
      assert.equal(solo.execution.snapshot, undefined, user.role);
      assert.equal(solo.execution.internalProfileApplied, true, user.role);
      assert.equal(solo.execution.redacted, true, user.role);
      for (const forbidden of [
        'capabilities', 'skills', 'workMethod', 'workConfig', 'jobProfile',
        'promptCompilation', 'provenance', 'skillSources', 'messageMode', 'schemaVersion',
      ]) {
        assert.equal(JSON.stringify(solo.execution).includes(forbidden), false, `${user.role}:${forbidden}`);
      }
      assert.equal(JSON.stringify(solo).includes('热榜扫描'), false, user.role);
      assert.equal(JSON.stringify(solo).includes('热点判断'), false, user.role);
      assert.equal(JSON.stringify(solo).includes('旧平台趋势卡'), false, user.role);
      assert.equal(JSON.stringify(solo).includes('A店节气菜品'), false, user.role);
      assert.equal(JSON.stringify(solo).includes('老板审核后才能发布'), false, user.role);
      assert.equal(JSON.stringify(solo).includes('skills-hash-a'), false, user.role);
      assert.equal(JSON.stringify(solo).includes('content-factory-secret-hash'), false, user.role);
      assert.equal(JSON.stringify(solo).includes('prompt-hash-a'), false, user.role);
    });
  }
});

test('内容员工单独派活穿透返回任务、结果、能力配置技能来源与人工审批边界', async () => {
  await withServer(bossA, async base => {
    const response = await fetch(`${base}/employee-outputs/drill/content_solo/${soloReadyA}`);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.source, 'content_solo');
    assert.equal(detail.record.employeeIdx, 0);
    assert.equal(detail.record.inputs.requirement, '输入：A店夏日菜单趋势');
    assert.match(detail.output.body, /三个候选选题/);
    assert.equal(detail.execution.profileVersion, 'content-0-r3');
    assert.equal(detail.execution.promptHash, 'prompt-hash-a');
    assert.equal(detail.execution.snapshot.capabilities[0].name, '热榜扫描');
    assert.equal(detail.execution.snapshot.workConfig.effective.outputLength, 'full');
    assert.equal(detail.execution.snapshot.skills.core[0].title, '热点判断');
    assert.equal(detail.execution.snapshot.skills.historical[0].verificationStatus, 'legacy_unverified');
    assert.equal(detail.execution.snapshot.skills.custom[0].source, 'A店自定义');
    assert.equal(detail.execution.snapshot.skillSources.historical.snapshot.sha256, 'skills-hash-a');
    assert.match(JSON.stringify(detail.execution.snapshot.approvalBoundary), /老板审核后才能发布/);
    assert.match(JSON.stringify(detail.execution.snapshot.approvalBoundary), /对外发布必须由有权限的人类审批/);
    assert.match(detail.disclaimer, /不归因/);

    const running = await fetch(`${base}/employee-outputs/drill/content_solo/${soloRunningA}`).then(result => result.json());
    const failed = await fetch(`${base}/employee-outputs/drill/content_solo/${soloFailedA}`).then(result => result.json());
    assert.equal(running.record.status, '生成中');
    assert.equal(running.output, null);
    assert.equal(running.evidenceKind, '内容员工运行状态');
    assert.equal(failed.record.status, '生成失败（可重跑）');
    assert.equal(failed.output, null);
    assert.equal(failed.evidenceKind, '内容员工生成失败');
  });
});

test('媒体穿透在结算与人工验收完成前不投影原始导出URL', async () => {
  let jobId;
  let hold;
  let materialId = null;
  let startingCredits = 0;
  runWithTenant(1, () => {
    startingCredits = Number(q.get('SELECT credits FROM tenants WHERE id=1')?.credits || 0);
    q.run('UPDATE tenants SET credits=credits+10 WHERE id=1');
    jobId = Number(q.run(`INSERT INTO media_jobs(
      user_id,kind,model,prompt,status,url,
      content_employee_idx,content_employee_key,content_employee_name,content_employee_group,
      content_run_mode,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    bossA.id, 'image', 'media-gate-test', '穿透页私有原始媒体', '成功',
    '/private/media-output-before-review.png',
    5, 'media', '多媒体师', '视觉工厂', 'single_station',
    '2026-07-28 10:00:00').lastInsertRowid);
  });

  try {
    await withServer(bossA, async base => {
      const missing = await fetch(
        `${base}/employee-outputs/drill/content/media-${jobId}`,
      ).then(response => response.json());
      assert.equal(missing.record.status, '待账务对账');
      assert.equal(missing.output.provenance.billingState, 'missing');
      assert.equal(Object.hasOwn(missing.output, 'artifactUrl'), false);
      assert.equal(JSON.stringify(missing).includes('/private/media-output-before-review.png'), false);
    });

    hold = runWithTenant(1, () => {
      const created = holdCredits({
        userId: bossA.id,
        feature: '媒体穿透门禁测试',
        kind: 'image',
        model: 'media-gate-test',
        credits: 2,
        refType: 'media_job',
        refId: jobId,
      });
      settleHold(created, {
        credits: 2,
        model: 'media-gate-test',
        note: '媒体穿透门禁正向结算',
      });
      return created;
    });

    await withServer(bossA, async base => {
      const awaitingReview = await fetch(
        `${base}/employee-outputs/drill/content/media-${jobId}`,
      ).then(response => response.json());
      assert.equal(awaitingReview.record.status, '待审核');
      assert.equal(awaitingReview.output.provenance.billingState, 'settled');
      assert.equal(awaitingReview.output.provenance.reviewStatus, '可验收（待管理层审阅）');
      assert.equal(Object.hasOwn(awaitingReview.output, 'artifactUrl'), false);
      assert.equal(JSON.stringify(awaitingReview).includes('/private/media-output-before-review.png'), false);
    });

    runWithTenant(1, () => {
      materialId = Number(q.run(`INSERT INTO materials(
        name,type,url,source_type,source_id,creator_id,artifact_snapshot_json
      ) VALUES(?,?,?,?,?,?,?)`,
      '已验收媒体', '图片', '/private/media-output-before-review.png', 'media_job', jobId,
      bossA.id, JSON.stringify({
        manualReview: {
          decision: 'accepted',
          source: 'manager_manual_media_review',
          reviewedById: bossA.id,
          reviewedByName: bossA.name,
          reviewedByRole: bossA.role,
          reviewedAt: '2026-07-28 10:05:00',
        },
      })).lastInsertRowid);
    });

    await withServer(bossA, async base => {
      const accepted = await fetch(
        `${base}/employee-outputs/drill/content/media-${jobId}`,
      ).then(response => response.json());
      assert.equal(accepted.record.status, '已通过');
      assert.equal(accepted.output.artifactUrl, '/private/media-output-before-review.png');
    });
  } finally {
    runWithTenant(1, () => {
      if (materialId) q.run('DELETE FROM materials WHERE id=?', materialId);
      q.run('DELETE FROM media_jobs WHERE id=?', jobId);
      if (hold?.holdId) q.run('DELETE FROM credit_holds WHERE id=?', hold.holdId);
      if (hold?.logId) q.run('DELETE FROM credit_logs WHERE id=?', hold.logId);
      q.run('UPDATE tenants SET credits=? WHERE id=1', startingCredits);
    });
  }
});

test('餐饮员工旧失败只在同岗同题的后续真API产出已结算且审批通过后标记修复', async () => {
  const fixture = runWithTenant(1, () => {
    const repairedTitle = '餐饮历史修复菜单';
    const requirement = '修复同一菜单任务';
    const delivery = restaurantDelivery(Number(employee.employee_idx), repairedTitle, requirement);
    const oldTaskId = Number(q.run(`INSERT INTO agent_tasks(
      marshal_id,specialist_id,title,type,requirement,status,created_by,created_at
    ) VALUES(?,?,?,'岗位交付','修复同一菜单任务','失败',?,'2026-07-29 08:00:00')`,
    employee.marshal_id, employee.id, '餐饮　历史 修复菜单', bossA.id).lastInsertRowid);
    const outputId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,ai_mode,creator_id,marshal_id,created_at
    ) VALUES('员工产出',?,?,'可使用','api',?,?,
      '2026-07-29 09:01:00')`, repairedTitle, delivery.body, bossA.id, employee.marshal_id).lastInsertRowid);
    const repairedTaskId = Number(q.run(`INSERT INTO agent_tasks(
      marshal_id,specialist_id,title,type,requirement,status,output_id,created_by,created_at,
      employee_profile_version,employee_prompt_hash,employee_capabilities_snapshot,
      employee_config_snapshot,employee_skills_snapshot,employee_web_snapshot
    ) VALUES(?,?,?,'岗位交付','修复同一菜单任务','已完成',?,?,
      '2026-07-29 09:00:00','restaurant-remediation-profile','prompt-remediation',
      '[]','{}','[]',?)`,
    employee.marshal_id, employee.id, repairedTitle, outputId, bossA.id,
    JSON.stringify(delivery.evidence)).lastInsertRowid);
    const approvalId = Number(q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,
      submitter_id,reviewer_id,reason,decided_at
    ) VALUES('content',?,'餐饮历史修复菜单','已核验真实API产出','none','[]','已通过',?,?,
      '人工采纳','2026-07-29 09:02:00')`, outputId, bossA.id, bossA.id).lastInsertRowid);
    return { oldTaskId, outputId, repairedTaskId, approvalId };
  });
  const proof = settledApiProof({ refType: 'agent_task', refId: fixture.repairedTaskId });
  try {
    await withServer(bossA, async base => {
      const data = await fetch(
        `${base}/employee-outputs?start=2026-07-29&end=2026-07-29&source=task&dimension=status`,
      ).then(response => response.json());
      const old = data.rows.find(row => row.ref === `task:${fixture.oldTaskId}`);
      assert.equal(old.status, '历史未通过（后续已修复）');
      assert.equal(old.originalStatus, '生成失败（可重跑）');
      assert.equal(old.remediatedByRunId, fixture.repairedTaskId);
      assert.equal(old.hasOutput, false);
      assert.match(old.nextAction, /无需重跑/u);
      assert.equal(data.summary.completed, 1);
      assert.equal(data.summary.failed, 0);
      assert.equal(data.summary.pending, 0);
      assert.equal(data.summary.remediated, 1);

      const filtered = await fetch(
        `${base}/employee-outputs?start=2026-07-29&end=2026-07-29&source=task&status=${encodeURIComponent('历史未通过（后续已修复）')}`,
      ).then(response => response.json());
      assert.deepEqual(filtered.rows.map(row => row.ref), [`task:${fixture.oldTaskId}`]);

      const detail = await fetch(
        `${base}/employee-outputs/drill/task/${fixture.oldTaskId}`,
      ).then(response => response.json());
      assert.equal(detail.record.status, '历史未通过（后续已修复）');
      assert.equal(detail.record.remediatedByRunId, fixture.repairedTaskId);
      assert.match(detail.evidenceKind, /后续已修复/u);
    });
  } finally {
    removeSettledProof(proof);
    runWithTenant(1, () => {
      q.run('DELETE FROM approvals WHERE id=?', fixture.approvalId);
      q.run('DELETE FROM agent_tasks WHERE id IN (?,?)', fixture.oldTaskId, fixture.repairedTaskId);
      q.run('DELETE FROM contents WHERE id=?', fixture.outputId);
    });
  }
});

test('内容员工旧失败只在后续运行具备正token结算、采纳决策和落库材料后标记修复', async () => {
  const oldRunId = insertSoloRun({
    tenantId: 1,
    employeeIdx: 4,
    employeeKey: 'style',
    employeeName: '文风师',
    employeeGroup: '风格工坊',
    title: '品牌　语气 返工',
    status: '失败',
    resultMd: null,
    createdBy: bossA.id,
    createdAt: '2026-07-30 08:00:00',
    snapshot: { ...soloSnapshotA, profileVersion: 'content-4-old', promptHash: 'old-failed' },
  });
  const repairedRunId = insertSoloRun({
    tenantId: 1,
    employeeIdx: 4,
    employeeKey: 'style',
    employeeName: '文风师',
    employeeGroup: '风格工坊',
    title: '品牌语气返工',
    status: '已完成',
    resultMd: '# 已采纳文风稿\n\n真实API结果已经人工采纳并落库。',
    createdBy: bossA.id,
    createdAt: '2026-07-30 09:00:00',
    aiMode: 'api',
    snapshot: {
      ...soloSnapshotA,
      profileVersion: 'content-4-repaired',
      promptHash: 'repaired-success',
      contractValid: true,
      billing: { state: 'settled', chargedCredits: 1 },
      internalProfileLeakage: { detected: false, matches: [] },
      providerAttempt: {
        mode: 'api',
        model: 'test-model',
        usage: { inputTokens: 80, outputTokens: 40 },
      },
      review: { decision: 'adopt', reviewerId: bossA.id },
    },
  });
  const materialId = runWithTenant(1, () => Number(q.run(`INSERT INTO materials(
    name,type,source_type,source_id,creator_id,artifact_snapshot_json
  ) VALUES('文风师｜品牌语气返工','内容文稿','content_employee_run',?,?,?)`,
  repairedRunId, bossA.id, JSON.stringify({ kind: 'markdown', primary: true })).lastInsertRowid));
  const proof = settledApiProof({ refType: 'content_employee_run', refId: repairedRunId });
  try {
    await withServer(bossA, async base => {
      const data = await fetch(
        `${base}/employee-outputs?start=2026-07-30&end=2026-07-30&source=content_solo&dimension=status`,
      ).then(response => response.json());
      const old = data.rows.find(row => row.ref === `content_solo:${oldRunId}`);
      assert.equal(old.status, '历史未通过（后续已修复）');
      assert.equal(old.remediatedByRunId, repairedRunId);
      assert.equal(old.hasOutput, false);
      assert.equal(data.summary.completed, 1);
      assert.equal(data.summary.failed, 0);
      assert.equal(data.summary.pending, 0);
      assert.equal(data.summary.remediated, 1);

      const detail = await fetch(
        `${base}/employee-outputs/drill/content_solo/${oldRunId}`,
      ).then(response => response.json());
      assert.equal(detail.record.status, '历史未通过（后续已修复）');
      assert.equal(detail.record.originalStatus, '生成失败（可重跑）');
      assert.equal(detail.record.remediatedByRunId, repairedRunId);
    });
  } finally {
    removeSettledProof(proof);
    runWithTenant(1, () => {
      q.run('DELETE FROM materials WHERE id=?', materialId);
      q.run('DELETE FROM content_employee_runs WHERE id IN (?,?)', oldRunId, repairedRunId);
    });
  }
});

test('缺少正token结算、仍待审或属于其他员工的后续记录不得消除当前失败', async () => {
  const ids = [];
  let pendingProof = null;
  let otherProof = null;
  let otherMaterialId = null;
  try {
    const oldRunId = insertSoloRun({
      tenantId: 1,
      employeeIdx: 2,
      employeeKey: 'benchmark',
      employeeName: '拆解师',
      employeeGroup: '内容策划部',
      title: '严格证据门禁',
      status: '失败',
      resultMd: null,
      createdBy: bossA.id,
      createdAt: '2026-07-28 07:00:00',
      snapshot: { ...soloSnapshotA, profileVersion: 'strict-old', promptHash: 'strict-old' },
    });
    ids.push(oldRunId);
    const pendingRunId = insertSoloRun({
      tenantId: 1,
      employeeIdx: 2,
      employeeKey: 'benchmark',
      employeeName: '拆解师',
      employeeGroup: '内容策划部',
      title: '严格证据门禁',
      status: '待审阅',
      resultMd: '只是待审稿，不是采纳终态。',
      createdBy: bossA.id,
      createdAt: '2026-07-28 08:00:00',
      aiMode: 'api',
      snapshot: {
        ...soloSnapshotA,
        contractValid: true,
        billing: { state: 'settled', chargedCredits: 1 },
        internalProfileLeakage: { detected: false, matches: [] },
        providerAttempt: {
          mode: 'api', model: 'test-model', usage: { inputTokens: 80, outputTokens: 40 },
        },
      },
    });
    ids.push(pendingRunId);
    pendingProof = settledApiProof({ refType: 'content_employee_run', refId: pendingRunId });
    const otherEmployeeRunId = insertSoloRun({
      tenantId: 1,
      employeeIdx: 3,
      employeeKey: 'draft',
      employeeName: '撰稿人',
      employeeGroup: '文案创作部',
      title: '严格证据门禁',
      status: '已完成',
      resultMd: '其他员工的采纳结果不能修复拆解师。',
      createdBy: bossA.id,
      createdAt: '2026-07-28 09:00:00',
      aiMode: 'api',
      snapshot: {
        ...soloSnapshotA,
        contractValid: true,
        billing: { state: 'settled', chargedCredits: 1 },
        internalProfileLeakage: { detected: false, matches: [] },
        providerAttempt: {
          mode: 'api', model: 'test-model', usage: { inputTokens: 80, outputTokens: 40 },
        },
        review: { decision: 'adopt' },
      },
    });
    ids.push(otherEmployeeRunId);
    otherMaterialId = runWithTenant(1, () => Number(q.run(`INSERT INTO materials(
      name,type,source_type,source_id,creator_id,artifact_snapshot_json
    ) VALUES('撰稿人｜严格证据门禁','内容文稿','content_employee_run',?,?,?)`,
    otherEmployeeRunId, bossA.id, JSON.stringify({ kind: 'markdown', primary: true })).lastInsertRowid));
    otherProof = settledApiProof({ refType: 'content_employee_run', refId: otherEmployeeRunId });
    await withServer(bossA, async base => {
      const data = await fetch(
        `${base}/employee-outputs?start=2026-07-28&end=2026-07-28&source=content_solo`,
      ).then(response => response.json());
      const old = data.rows.find(row => row.ref === `content_solo:${oldRunId}`);
      assert.equal(old.status, '生成失败（可重跑）');
      assert.equal(old.remediated, undefined);
      assert.equal(data.summary.remediated, 0);
      assert.equal(data.summary.failed, 1);
    });
  } finally {
    removeSettledProof(pendingProof);
    removeSettledProof(otherProof);
    runWithTenant(1, () => {
      if (otherMaterialId) q.run('DELETE FROM materials WHERE id=?', otherMaterialId);
      for (const id of ids) q.run('DELETE FROM content_employee_runs WHERE id=?', id);
    });
  }
});

test('同标题类型需求但feedback或附件不同的成功运行不得闭环旧失败', async () => {
  const oldRunId = insertSoloRun({
    tenantId: 1, employeeIdx: 8, employeeKey: 'review', employeeName: '复盘官',
    employeeGroup: '质量复盘部', title: '穿透指纹任务', status: '失败', resultMd: null,
    createdBy: bossA.id, createdAt: '2026-07-26 07:00:00',
    snapshot: {
      ...soloSnapshotA,
      dispatch: {
        ...soloSnapshotA.dispatch, feedback: '保留A版反馈', dueAt: '2026-07-30',
        attachments: [{ id: 'asset-a' }],
      },
    },
  });
  const resultMd = '# B版交付\n\n这是另一份反馈与附件产生的结果。';
  const repairedRunId = insertSoloRun({
    tenantId: 1, employeeIdx: 8, employeeKey: 'review', employeeName: '复盘官',
    employeeGroup: '质量复盘部', title: '穿透指纹任务', status: '已完成', resultMd,
    createdBy: bossA.id, createdAt: '2026-07-26 08:00:00', aiMode: 'api',
    snapshot: {
      ...soloSnapshotA,
      dispatch: {
        ...soloSnapshotA.dispatch, feedback: '改用B版反馈', dueAt: '2026-07-31',
        attachments: [{ id: 'asset-b' }],
      },
      contractValid: true, billing: { state: 'settled', chargedCredits: 1 },
      internalProfileLeakage: { detected: false },
      providerAttempt: { mode: 'api', model: 'test-model', usage: { inputTokens: 80, outputTokens: 40 } },
      review: { decision: 'adopt', reviewerId: bossA.id },
    },
  });
  const proof = settledApiProof({ refType: 'content_employee_run', refId: repairedRunId });
  const materialId = runWithTenant(1, () => Number(q.run(`INSERT INTO materials(
    name,type,source_type,source_id,creator_id,artifact_snapshot_json
  ) VALUES('复盘官丨B版','内容文稿','content_employee_run',?,?,?)`, repairedRunId,
  bossA.id, JSON.stringify({ kind: 'markdown', primary: true })).lastInsertRowid));
  try {
    await withServer(bossA, async base => {
      const data = await fetch(`${base}/employee-outputs?start=2026-07-26&end=2026-07-26&source=content_solo`)
        .then(response => response.json());
      const old = data.rows.find(row => row.ref === `content_solo:${oldRunId}`);
      assert.equal(old.status, '生成失败（可重跑）');
      assert.equal(old.remediated, undefined);
      assert.equal(data.summary.remediated, 0);
    });
  } finally {
    removeSettledProof(proof);
    runWithTenant(1, () => {
      q.run('DELETE FROM materials WHERE id=?', materialId);
      q.run('DELETE FROM content_employee_runs WHERE id IN (?,?)', oldRunId, repairedRunId);
    });
  }
});

test('经营工具旧失败只在同租户同工具、稳定任务标题和输入的后续严格成功后标记已修复', async () => {
  const fixture = runWithTenant(1, () => {
    const oldRunId = Number(q.run(`INSERT INTO tool_runs(
      tool_key,tool_title,title,status,employee_idx,employee_name,created_by,
      input_json,input_summary,result_md,assumptions_json,evidence_json,provenance_json,created_at,updated_at
    ) VALUES('pcal','私域日历','私域日历真实验收-aaaaaaaa','failed',141,'云营销',?,
      '{"month":"2026-08"}','旧版真实验收未完成','# 旧模板底稿','[]','[]',?,
      '2026-07-31 08:00:00','2026-07-31 08:00:01')`, bossA.id, JSON.stringify({
      mode: 'template',
      completionState: 'template_only',
      usage: { inputTokens: 0, outputTokens: 0 },
      billing: { state: 'released', chargedCredits: 0 },
    })).lastInsertRowid);
    const resultMd = '# 私域日历当前版交付\n\n真实 API 产物已按当前契约落库。';
    const repairedRunId = Number(q.run(`INSERT INTO tool_runs(
      tool_key,tool_title,title,status,employee_idx,employee_name,created_by,
      input_json,input_summary,result_md,assumptions_json,evidence_json,provenance_json,created_at,updated_at
    ) VALUES('pcal','私域日历','私域日历真实验收-bbbbbbbb','done',141,'云营销',?,
      '{"month":"2026-08"}','当前严格重跑',?,'[]','[]','{}',
      '2026-07-31 09:00:00','2026-07-31 09:00:01')`, bossA.id, resultMd).lastInsertRowid);
    return { oldRunId, repairedRunId, resultMd };
  });
  const proof = settledApiProof({ refType: 'tool_run', refId: fixture.repairedRunId });
  const oldReleaseProof = heldApiProof({ refType: 'tool_run', refId: fixture.oldRunId });
  runWithTenant(1, () => settleHold(oldReleaseProof, {
    model: 'test-model', aiMode: 'api', credits: 0,
    usage: { inputTokens: 0, outputTokens: 0 }, note: '历史失败已释放',
  }));
  runWithTenant(1, () => q.run('UPDATE tool_runs SET provenance_json=? WHERE id=?',
    JSON.stringify(strictToolProvenance(fixture.resultMd, proof)), fixture.repairedRunId));

  try {
    await withServer(bossA, async base => {
      const data = await fetch(
        `${base}/employee-outputs?start=2026-07-31&end=2026-07-31&source=tool&dimension=status`,
      ).then(response => response.json());
      const old = data.rows.find(row => row.ref === `tool:${fixture.oldRunId}`);
      const repaired = data.rows.find(row => row.ref === `tool:${fixture.repairedRunId}`);
      assert.equal(old.status, '历史未通过（后续已修复）');
      assert.equal(old.originalStatus, '质检失败（可重跑）');
      assert.equal(old.remediatedByRunId, fixture.repairedRunId);
      assert.equal(old.remediatedByRef, `tool:${fixture.repairedRunId}`);
      assert.equal(old.hasOutput, false);
      assert.ok(old.originalFailureReasons.some(reason => reason.includes('真实 API')));
      assert.ok(old.originalFailureReasons.some(reason => reason.includes('交付契约')));
      assert.equal(repaired.status, '已通过');
      assert.equal(data.summary.completed, 1);
      assert.equal(data.summary.failed, 0);
      assert.equal(data.summary.pending, 0);
      assert.equal(data.summary.remediated, 1);

      const filtered = await fetch(
        `${base}/employee-outputs?start=2026-07-31&end=2026-07-31&source=tool&status=${encodeURIComponent('历史未通过（后续已修复）')}`,
      ).then(response => response.json());
      assert.deepEqual(filtered.rows.map(row => row.ref), [`tool:${fixture.oldRunId}`]);

      const detail = await fetch(
        `${base}/employee-outputs/drill/tool/${fixture.oldRunId}`,
      ).then(response => response.json());
      assert.equal(detail.record.status, '历史未通过（后续已修复）');
      assert.equal(detail.record.remediatedByRunId, fixture.repairedRunId);
      assert.ok(detail.record.originalFailureReasons.some(reason => reason.includes('历史运行')));
      assert.match(detail.evidenceKind, /后续已修复/u);
    });
  } finally {
    removeSettledProof(proof);
    removeSettledProof(oldReleaseProof);
    runWithTenant(1, () => q.run('DELETE FROM tool_runs WHERE id IN (?,?)',
      fixture.oldRunId, fixture.repairedRunId));
  }
});

test('后续done伪成功、零token证据或其他租户的真成功都不得修复工具旧失败', async () => {
  const tenantOne = runWithTenant(1, () => {
    const oldRunId = Number(q.run(`INSERT INTO tool_runs(
      tool_key,tool_title,title,status,employee_idx,employee_name,created_by,
      input_json,input_summary,result_md,provenance_json,created_at,updated_at
    ) VALUES('bench','竞品盯梢','竞品盯梢真实验收-aaaaaaaa','failed',102,'竞品情报官',?,
      '{"brand":"A"}','失败记录','# 失败记录',?,
      '2026-07-31 10:00:00','2026-07-31 10:00:01')`, bossA.id,
    JSON.stringify({ mode: 'failed', completionState: 'failed' })).lastInsertRowid);
    const noLedgerResult = '# 伪修复\n\n仅 provenance 宣称已成功，没有唯一结算账本。';
    const noLedgerRunId = Number(q.run(`INSERT INTO tool_runs(
      tool_key,tool_title,title,status,employee_idx,employee_name,created_by,
      input_json,input_summary,result_md,provenance_json,created_at,updated_at
    ) VALUES('bench','竞品盯梢','竞品盯梢真实验收-bbbbbbbb','done',102,'竞品情报官',?,
      '{"brand":"A"}','缺少唯一账本',?,?,
      '2026-07-31 10:10:00','2026-07-31 10:10:01')`, bossA.id, noLedgerResult,
    JSON.stringify(strictToolProvenance(noLedgerResult, null))).lastInsertRowid);
    const zeroUsageResult = '# 零token伪修复\n\n账本有真实用量，但产物溯源声称零用量。';
    const zeroUsageRunId = Number(q.run(`INSERT INTO tool_runs(
      tool_key,tool_title,title,status,employee_idx,employee_name,created_by,
      input_json,input_summary,result_md,provenance_json,created_at,updated_at
    ) VALUES('bench','竞品盯梢','竞品盯梢真实验收-cccccccc','done',102,'竞品情报官',?,
      '{"brand":"A"}','零token溯源',?,'{}',
      '2026-07-31 10:20:00','2026-07-31 10:20:01')`, bossA.id, zeroUsageResult).lastInsertRowid);
    const unrelatedResult = '# 另一项任务的严格成功\n\n输入对象不同，不能修复旧任务。';
    const unrelatedRunId = Number(q.run(`INSERT INTO tool_runs(
      tool_key,tool_title,title,status,employee_idx,employee_name,created_by,
      input_json,input_summary,result_md,provenance_json,created_at,updated_at
    ) VALUES('bench','竞品盯梢','竞品盯梢真实验收-eeeeeeee','done',102,'竞品情报官',?,
      '{"brand":"B"}','另一业务输入',?,'{}',
      '2026-07-31 10:25:00','2026-07-31 10:25:01')`, bossA.id, unrelatedResult).lastInsertRowid);
    return {
      oldRunId,
      noLedgerRunId,
      zeroUsageRunId,
      zeroUsageResult,
      unrelatedRunId,
      unrelatedResult,
    };
  });
  const zeroUsageProof = settledApiProof({ refType: 'tool_run', refId: tenantOne.zeroUsageRunId });
  runWithTenant(1, () => q.run('UPDATE tool_runs SET provenance_json=? WHERE id=?',
    JSON.stringify(strictToolProvenance(tenantOne.zeroUsageResult, zeroUsageProof, {
      inputTokens: 0,
      outputTokens: 0,
    })), tenantOne.zeroUsageRunId));
  const unrelatedProof = settledApiProof({ refType: 'tool_run', refId: tenantOne.unrelatedRunId });
  runWithTenant(1, () => q.run('UPDATE tool_runs SET provenance_json=? WHERE id=?',
    JSON.stringify(strictToolProvenance(tenantOne.unrelatedResult, unrelatedProof)),
    tenantOne.unrelatedRunId));

  const tenantTwo = runWithTenant(2, () => {
    const resultMd = '# B店严格成功\n\n不得修复 A 店的失败。';
    const runId = Number(q.run(`INSERT INTO tool_runs(
      tool_key,tool_title,title,status,employee_idx,employee_name,created_by,
      input_json,input_summary,result_md,provenance_json,created_at,updated_at
    ) VALUES('bench','竞品盯梢','竞品盯梢真实验收-dddddddd','done',102,'竞品情报官',?,
      '{"brand":"A"}','B店严格运行',?,'{}',
      '2026-07-31 10:30:00','2026-07-31 10:30:01')`, bossB.id, resultMd).lastInsertRowid);
    return { runId, resultMd };
  });
  const tenantTwoProof = settledApiProof({
    refType: 'tool_run', refId: tenantTwo.runId, userId: bossB.id, tenantId: 2,
  });
  runWithTenant(2, () => q.run('UPDATE tool_runs SET provenance_json=? WHERE id=?',
    JSON.stringify(strictToolProvenance(tenantTwo.resultMd, tenantTwoProof)), tenantTwo.runId));

  try {
    await withServer(bossA, async base => {
      const data = await fetch(
        `${base}/employee-outputs?start=2026-07-31&end=2026-07-31&source=tool`,
      ).then(response => response.json());
      const old = data.rows.find(row => row.ref === `tool:${tenantOne.oldRunId}`);
      assert.equal(old.status, '质检失败（可重跑）');
      assert.equal(old.remediated, undefined);
      assert.equal(data.summary.remediated, 0);
      assert.ok(data.summary.failed >= 1);
    });
  } finally {
    removeSettledProof(zeroUsageProof);
    removeSettledProof(unrelatedProof);
    removeSettledProof(tenantTwoProof, 2);
    runWithTenant(1, () => q.run('DELETE FROM tool_runs WHERE id IN (?,?,?,?)',
      tenantOne.oldRunId, tenantOne.noLedgerRunId, tenantOne.zeroUsageRunId,
      tenantOne.unrelatedRunId));
    runWithTenant(2, () => q.run('DELETE FROM tool_runs WHERE id=?', tenantTwo.runId));
  }
});

test('租户隔离覆盖聚合与穿透端点', async () => {
  await withServer(bossB, async base => {
    const data = await fetch(`${base}/employee-outputs?start=2026-07-01&end=2026-07-31`).then(response => response.json());
    assert.equal(data.summary.total, 2);
    assert.deepEqual(data.rows.map(row => row.ref).sort(), [`content_solo:${soloPrivateB}`, `task:${taskB}`].sort());
    assert.equal(data.rows.find(row => row.ref === `task:${taskB}`).status, '待派活');
    assert.equal(data.rows.find(row => row.ref === `content_solo:${soloPrivateB}`).status, '待账务对账');

    const taskResponse = await fetch(`${base}/employee-outputs/drill/task/${taskA}`);
    const toolResponse = await fetch(`${base}/employee-outputs/drill/tool/1`);
    const soloResponse = await fetch(`${base}/employee-outputs/drill/content_solo/${soloReadyA}`);
    assert.equal(taskResponse.status, 404);
    assert.equal(toolResponse.status, 404);
    assert.equal(soloResponse.status, 404);
  });
  await withServer(bossA, async base => {
    assert.equal((await fetch(`${base}/employee-outputs/drill/content_solo/${soloPrivateB}`)).status, 404);
  });
});

test('拒绝非法时间范围与透视维度', async () => {
  await withServer(bossA, async base => {
    assert.equal((await fetch(`${base}/employee-outputs?start=2026-08-01&end=2026-07-01`)).status, 400);
    assert.equal((await fetch(`${base}/employee-outputs?dimension=sql`)).status, 400);
  });
});

test('旧库没有内容员工运行表时聚合降级且穿透返回404', async () => {
  db.exec('DROP TABLE content_employee_runs');
  await withServer(bossA, async base => {
    const response = await fetch(`${base}/employee-outputs?start=2026-07-01&end=2026-07-31&dimension=source`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.summary.total, 2);
    assert.ok(data.rows.every(row => row.source !== 'content_solo'));
    assert.equal((await fetch(`${base}/employee-outputs/drill/content_solo/${soloReadyA}`)).status, 404);
  });
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
  }
});
