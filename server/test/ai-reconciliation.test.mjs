import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { VALID_CONTENT_EMPLOYEE_OUTPUTS } from './helpers/content-output-fixtures.mjs';

const DBP = path.join(os.tmpdir(), `nanowork-ai-reconciliation-${process.pid}.db`);
for (const filename of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(filename, { force: true }); } catch { /* clean test database */ }
}
process.env.NANOWORK_DB = DBP;
process.env.NODE_ENV = 'test';
process.env.YUNWU_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
const { holdCredits } = await import('../src/engines/credits.js');
const { canonicalContentEmployeeProfileFor } = await import('../src/engines/canonical-employee-profile.js');
const { createSqliteContentProductionPipelineRepository } = await import('../src/engines/content-production-pipeline.js');
const { ensureContentPipelineSpecialProviderAttemptSchema } = await import('../src/routes/content-production-pipeline.js');
const systemRoutes = (await import('../src/routes/system.js')).default;

initSchema();
migrateV2();
const pipelineRepository = createSqliteContentProductionPipelineRepository({ db });
pipelineRepository.ensureSchema();
ensureContentPipelineSpecialProviderAttemptSchema();
q.run(`UPDATE tenants SET status='已开通',credits=100000 WHERE id=1`);
const bossId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,1)`, 'reconcile-boss', hashPassword('Secret123!'), '对账老板', 'boss', '启用').lastInsertRowid);
const opsId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,1)`, 'reconcile-ops', hashPassword('Secret123!'), '对账运营', 'ops_director', '启用').lastInsertRowid);
const salesId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,1)`, 'reconcile-sales', hashPassword('Secret123!'), '对账员工', 'sales', '启用').lastInsertRowid);

const boss = { id: bossId, name: '对账老板', role: 'boss', tenant_id: 1 };
const ops = { id: opsId, name: '对账运营', role: 'ops_director', tenant_id: 1 };
const sales = { id: salesId, name: '对账员工', role: 'sales', tenant_id: 1 };

function appFor(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => {
    req.user = user;
    next();
  }));
  app.use('/sys', systemRoutes);
  return app;
}

async function withServer(user, work) {
  const server = appFor(user).listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await work(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function createContentRun({ valid, status = '待审阅', title }) {
  const employeeIdx = 5;
  const requirement = '已核验事实：营业额100000元，食材成本35000元，目标食材成本率32%，订单2000单；未提供的信息必须列为待确认。';
  const parsedOutput = valid ? structuredClone(VALID_CONTENT_EMPLOYEE_OUTPUTS[employeeIdx]) : { bad: true };
  const snapshot = {
    contractValid: valid,
    parsedOutput,
    providerAttempt: {
      mode: 'api',
      model: 'gpt-5.5',
      usage: { inputTokens: 1200, outputTokens: 480 },
    },
    internalProfileLeakage: { detected: false },
    web: { results: [] },
    dispatch: { title, requirement, feedback: '' },
  };
  const runId = Number(q.run(`INSERT INTO content_employee_runs(
      employee_idx,employee_key,employee_name,employee_group,title,type,requirement,status,
      result_md,ai_mode,model,profile_version,prompt_hash,snapshot_json,created_by)
    VALUES(5,'media','多媒体师','内容生产仓',?,'视觉素材',?,?,?,?,?,?,?,?,?)`,
  title, requirement, status, JSON.stringify(parsedOutput), 'api', 'gpt-5.5', 'profile-test', 'prompt-test', JSON.stringify(snapshot), bossId).lastInsertRowid);
  const hold = holdCredits({
    userId: bossId,
    feature: `内容员工·${title}`,
    kind: 'text',
    model: 'gpt-5.5',
    credits: 40,
    refType: 'content_employee_run',
    refId: runId,
  });
  return { runId, hold };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function outputFingerprint(value) {
  return `sha256:${crypto.createHash('sha256')
    .update(JSON.stringify(stableValue(value)), 'utf8')
    .digest('hex')}`;
}

function createPipelineStation({
  valid,
  active = false,
  title,
  stationIdx = 5,
  resumeStationStatus = 'completed',
} = {}) {
  const task = {
    direction: title,
    template: '观点输出',
    industry: '企业服务',
    material: '已核验事实：营业额100000元，样本量30，未提供信息必须标记待确认。',
    ref_link: '',
    platforms: ['小红书'],
    image_mode: 'ai',
    image_count: 2,
    enable_deck: false,
    xhs_style: null,
    dy_style: null,
  };
  const pipelineId = pipelineRepository.createJob({
    tenantId: 1,
    createdBy: bossId,
    title,
    task,
    persona: { tone: '老板' },
    settings: { companyProfile: { brand: '对账测试企业' } },
    workflow: { mode: 'fullauto' },
  });
  const refId = pipelineId * 10 + stationIdx + 1;
  const hold = holdCredits({
    userId: bossId,
    feature: `内容生产流水线·${title}`,
    kind: 'text',
    model: 'gpt-5.5',
    credits: 40,
    refType: 'content_production_pipeline_station',
    refId,
  });

  if (active) {
    q.run(`UPDATE content_production_pipeline_stations
      SET status='running',attempt=1,started_at=datetime('now','localtime'),updated_at=datetime('now','localtime')
      WHERE tenant_id=1 AND pipeline_id=? AND station_idx=?`, pipelineId, stationIdx);
    q.run(`UPDATE content_production_pipeline_jobs
      SET status='running',current_station=?,updated_at=datetime('now','localtime')
      WHERE tenant_id=1 AND id=?`, stationIdx, pipelineId);
    return { pipelineId, stationIdx, refId, hold };
  }

  const output = valid
    ? structuredClone(VALID_CONTENT_EMPLOYEE_OUTPUTS[stationIdx])
    : { invalid_delivery: true };
  const canonical = canonicalContentEmployeeProfileFor(stationIdx);
  const providerDelivery = {
    mode: 'api',
    validated: true,
    model: 'gpt-5.5',
    usage: { inputTokens: 1200, outputTokens: 480 },
    outputFingerprint: outputFingerprint(output),
  };
  const runtimePackageLoad = {
    aggregateFingerprint: canonical.fingerprints.aggregate,
    allRequiredFieldsLoaded: true,
    fullCanonicalObjectInSystemMessage: true,
  };
  const handlerEvidence = {
    employeeIdx: stationIdx,
    executionMode: 'pipeline',
    completed: true,
    runtimePackageLoad,
    providerDelivery,
    productionRuntime: {
      providerDelivery,
      web: { required: false, verified: false, results: [] },
    },
  };
  const billingEvidence = {
    holdId: Number(hold.holdId),
    state: 'pending_reconciliation',
    status: 'pending_reconciliation',
    pendingReconciliation: true,
    resumeStationStatus,
  };
  const contextSnapshot = { runtimePackageLoad, billingEvidence };
  const failure = {
    code: 'CONTENT_PIPELINE_BILLING_SETTLEMENT_FAILED',
    message: '工位产物已持久化，等待账务对账',
    stationIdx,
  };
  q.run(`UPDATE content_production_pipeline_stations
    SET status='billing_pending',attempt=1,output_json=?,handler_evidence_json=?,
        billing_evidence_json=?,context_snapshot_json=?,failure_json=?,
        completed_at=datetime('now','localtime'),updated_at=datetime('now','localtime')
    WHERE tenant_id=1 AND pipeline_id=? AND station_idx=?`,
  JSON.stringify(output), JSON.stringify(handlerEvidence), JSON.stringify(billingEvidence),
  JSON.stringify(contextSnapshot), JSON.stringify(failure), pipelineId, stationIdx);
  q.run(`UPDATE content_production_pipeline_jobs
    SET status='billing_pending',current_station=?,pending_station=NULL,failure_json=?,
        version=version+1,updated_at=datetime('now','localtime')
    WHERE tenant_id=1 AND id=?`, stationIdx, JSON.stringify(failure), pipelineId);
  return { pipelineId, stationIdx, refId, hold, output };
}

function createSpecialProviderAttempt({
  valid = true,
  active = false,
  title,
  stationIdx = 5,
  refId: suppliedRefId = null,
} = {}) {
  const pipelineId = pipelineRepository.createJob({
    tenantId: 1,
    createdBy: bossId,
    title,
    task: {
      direction: title,
      template: '视觉内容',
      industry: '企业服务',
      material: '已核验素材',
      ref_link: '',
      platforms: ['小红书'],
      image_mode: 'ai',
      image_count: 1,
      enable_deck: false,
    },
    persona: { tone: '老板' },
    settings: { companyProfile: { brand: '对账测试企业' } },
    workflow: { mode: 'fullauto' },
  });
  const refId = suppliedRefId || pipelineId * 100_000 + 5_001;
  const attemptId = `content-production-pipeline:pipeline:${pipelineId}:station:${stationIdx}:provider:image:attempt:1`;
  const hold = holdCredits({
    userId: bossId,
    feature: `内容流水线特殊图片Provider·${title}`,
    kind: 'image',
    model: 'gpt-image-2',
    credits: 75,
    refType: 'content_special_provider',
    refId,
  });
  const billing = {
    state: 'pending_reconciliation',
    status: 'pending_reconciliation',
    holdId: Number(hold.holdId),
    estimatedCredits: Number(hold.credits),
    heldCredits: Number(hold.credits),
    chargedCredits: null,
    credits: null,
    pendingReconciliation: true,
  };

  if (active) {
    q.run(`INSERT INTO content_pipeline_special_provider_attempts(
      tenant_id,pipeline_id,station_idx,provider_kind,attempt_id,request_fingerprint,
      billing_ref_type,billing_ref_id,hold_id,status,billing_json,created_by
    ) VALUES(1,?,?,?,?,?,?,?,?,?,?,?)`,
    pipelineId, stationIdx, 'image', attemptId, `sha256:${'a'.repeat(64)}`,
    'content_special_provider', refId, Number(hold.holdId), 'claimed', JSON.stringify(billing), bossId);
    q.run(`UPDATE content_production_pipeline_stations
      SET status='running',attempt=1,started_at=datetime('now','localtime'),updated_at=datetime('now','localtime')
      WHERE tenant_id=1 AND pipeline_id=? AND station_idx=?`, pipelineId, stationIdx);
    q.run(`UPDATE content_production_pipeline_jobs
      SET status='running',current_station=?,updated_at=datetime('now','localtime')
      WHERE tenant_id=1 AND id=?`, stationIdx, pipelineId);
    return { pipelineId, stationIdx, refId, attemptId, hold };
  }

  const url = `https://images.example/reconciliation-${pipelineId}.png`;
  const contentSha256 = rawHash(url);
  const output = {
    images: [{ url, mimeType: 'image/png', model: 'gpt-image-2' }],
    provider: { name: 'yunwu-compatible', model: 'gpt-image-2', mode: 'api' },
    model: 'gpt-image-2',
    mode: 'api',
    usage: {
      imageCount: 1,
      tokenUsageApplicable: false,
      pricingMode: 'fixed_price_per_image',
    },
  };
  const artifactSnapshot = {
    schemaVersion: 'nanowork.content-pipeline-provider-artifact/2',
    kind: 'image',
    employeeIdx: stationIdx,
    pipelineId,
    attemptId,
    attemptOrdinal: 1,
    artifactIndex: 0,
    billingRefType: 'content_special_provider',
    billingRefId: refId,
    model: 'gpt-image-2',
    mimeType: 'image/png',
    credentialsIncluded: false,
    binaryInMetadata: false,
    contentSha256: valid ? contentSha256 : '0'.repeat(64),
  };
  const materialId = Number(q.run(`INSERT INTO materials(
      name,type,tags,url,source_type,source_id,creator_id,note,
      body_snapshot,artifact_snapshot_json,snapshot_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  `特殊Provider对账图片${pipelineId}`, '图片', '[]', url,
  'content_pipeline_provider', pipelineId, bossId, `attempt=${attemptId}`,
  null, JSON.stringify(artifactSnapshot), contentSha256).lastInsertRowid);
  const delivery = {
    persisted: true,
    artifactIds: [`material:${materialId}`],
    targetType: 'material',
    targetId: materialId,
  };
  q.run(`INSERT INTO content_pipeline_special_provider_attempts(
    tenant_id,pipeline_id,station_idx,provider_kind,attempt_id,request_fingerprint,
    billing_ref_type,billing_ref_id,hold_id,status,output_json,delivery_json,billing_json,created_by
  ) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  pipelineId, stationIdx, 'image', attemptId, `sha256:${'b'.repeat(64)}`,
  'content_special_provider', refId, Number(hold.holdId), 'pending_reconciliation',
  JSON.stringify(output), JSON.stringify(delivery), JSON.stringify(billing), bossId);
  const stationBilling = {
    state: 'pending_reconciliation',
    status: 'pending_reconciliation',
    pendingReconciliation: true,
    holdId: Number(hold.holdId),
    estimatedCredits: Number(hold.credits),
    heldCredits: Number(hold.credits),
    chargedCredits: null,
    credits: null,
    resumeStationStatus: 'completed',
    components: {
      stationText: null,
      specialProviders: [{
        attemptId,
        kind: 'image',
        refType: 'content_special_provider',
        refId,
        holdId: Number(hold.holdId),
        billing,
        delivery,
        replayed: false,
      }],
    },
  };
  const failure = {
    code: 'CONTENT_PIPELINE_BILLING_PENDING_RECONCILIATION',
    message: '特殊provider产物已持久化，等待对账',
    stationIdx,
  };
  q.run(`UPDATE content_production_pipeline_stations
    SET status='billing_pending',attempt=1,output_json=?,billing_evidence_json=?,
        context_snapshot_json=?,failure_json=?,completed_at=datetime('now','localtime'),
        updated_at=datetime('now','localtime')
    WHERE tenant_id=1 AND pipeline_id=? AND station_idx=?`,
  JSON.stringify(VALID_CONTENT_EMPLOYEE_OUTPUTS[stationIdx]),
  JSON.stringify(stationBilling),
  JSON.stringify({ billingEvidence: stationBilling }),
  JSON.stringify(failure),
  pipelineId,
  stationIdx);
  q.run(`UPDATE content_production_pipeline_jobs
    SET status='billing_pending',current_station=?,pending_station=NULL,failure_json=?,
        version=version+1,updated_at=datetime('now','localtime')
    WHERE tenant_id=1 AND id=?`, stationIdx, JSON.stringify(failure), pipelineId);
  return { pipelineId, stationIdx, refId, attemptId, hold, materialId, contentSha256 };
}

function rawHash(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

async function getQueue(base) {
  const response = await fetch(`${base}/sys/billing/reconciliation`);
  return { response, body: await response.json() };
}

test('老板只能按持久化模型与正token证据结算有效交付，重复请求幂等阻断', async () => {
  const created = runWithTenant(1, () => createContentRun({ valid: true, title: '有效待对账交付' }));
  await withServer(boss, async base => {
    const queue = await getQueue(base);
    assert.equal(queue.response.status, 200);
    const row = queue.body.rows.find(item => item.holdId === Number(created.hold.holdId));
    assert.deepEqual(row.availableActions, ['settle']);
    assert.equal(row.business.deliveryValid, true);
    assert.deepEqual(row.business.usage, { inputTokens: 1200, outputTokens: 480, valid: true });

    const resolved = await fetch(`${base}/sys/billing/reconciliation/${row.holdId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'settle',
        reason: '主产物通过共享契约且模型与token证据一致',
        evidenceHash: row.evidenceHash,
      }),
    });
    assert.equal(resolved.status, 200, JSON.stringify(await resolved.clone().json()));
    const hold = q.get('SELECT status,settled_credits,log_id FROM credit_holds WHERE id=?', row.holdId);
    const log = q.get('SELECT model,input_tokens,output_tokens,ai_mode FROM credit_logs WHERE id=?', hold.log_id);
    assert.equal(hold.status, 'settled');
    assert.ok(Number(hold.settled_credits) > 0);
    assert.equal(log.model, 'gpt-5.5');
    assert.equal(log.input_tokens, 1200);
    assert.equal(log.output_tokens, 480);
    assert.equal(log.ai_mode, 'api');

    const duplicate = await fetch(`${base}/sys/billing/reconciliation/${row.holdId}/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'settle', reason: '再次尝试同一笔对账不应重复扣费', evidenceHash: row.evidenceHash }),
    });
    assert.equal(duplicate.status, 409);
  });
});

test('无效交付只能隔离并全额退款，不能按自报token收费', async () => {
  const created = runWithTenant(1, () => createContentRun({ valid: false, status: '失败', title: '无效待对账交付' }));
  const before = Number(q.get('SELECT credits FROM tenants WHERE id=1').credits);
  await withServer(boss, async base => {
    const queue = await getQueue(base);
    const row = queue.body.rows.find(item => item.holdId === Number(created.hold.holdId));
    assert.deepEqual(row.availableActions, ['release']);
    assert.equal(row.business.deliveryValid, false);

    const resolved = await fetch(`${base}/sys/billing/reconciliation/${row.holdId}/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'release',
        reason: '岗位输出缺字段且未通过契约，确认没有可用交付',
        evidenceHash: row.evidenceHash,
      }),
    });
    assert.equal(resolved.status, 200, JSON.stringify(await resolved.clone().json()));
  });
  const hold = q.get('SELECT status,settled_credits FROM credit_holds WHERE id=?', created.hold.holdId);
  assert.equal(hold.status, 'settled');
  assert.equal(hold.settled_credits, 0);
  assert.equal(Number(q.get('SELECT credits FROM tenants WHERE id=1').credits), before + Number(created.hold.credits));
  assert.equal(q.get('SELECT status FROM content_employee_runs WHERE id=?', created.runId).status, '失败');
});

test('正常执行窗口、旧证据哈希和无权限角色均不能处理预授权', async () => {
  const created = runWithTenant(1, () => {
    const runId = Number(q.run(`INSERT INTO content_employee_runs(
        employee_idx,employee_key,employee_name,employee_group,title,type,status,
        profile_version,prompt_hash,snapshot_json,created_by)
      VALUES(0,'trend','趋势官','内容生产仓','仍在生成','趋势简报','生成中','p','h','{}',?)`, bossId).lastInsertRowid);
    return { runId, hold: holdCredits({ userId: bossId, feature: '仍在生成', kind: 'text', model: 'gpt-5.5', credits: 20, refType: 'content_employee_run', refId: runId }) };
  });
  let row;
  await withServer(ops, async base => {
    const queue = await getQueue(base);
    assert.equal(queue.response.status, 200);
    assert.equal(queue.body.canResolve, false);
    assert.equal(queue.body.summary.active, 1);
    assert.equal(queue.body.summary.requiresAttention, 0);
    assert.equal(queue.body.summary.activeHeldCredits, 20);
    assert.equal(queue.body.summary.attentionHeldCredits, 0);
    row = queue.body.rows.find(item => item.holdId === Number(created.hold.holdId));
    assert.deepEqual(row.availableActions, []);
    assert.match(row.blockedReason, /正常执行窗口/u);
    const forbidden = await fetch(`${base}/sys/billing/reconciliation/${row.holdId}/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'release', reason: '运营角色不具备财务处理权限', evidenceHash: row.evidenceHash }),
    });
    assert.equal(forbidden.status, 403);
  });
  await withServer(sales, async base => {
    assert.equal((await fetch(`${base}/sys/billing/reconciliation`)).status, 403);
  });
  await withServer(boss, async base => {
    const stale = await fetch(`${base}/sys/billing/reconciliation/${row.holdId}/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'release', reason: '伪造旧快照不应改变积分', evidenceHash: '0'.repeat(64) }),
    });
    assert.equal(stale.status, 409);
  });
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', created.hold.holdId).status, 'held');
});

test('内容流水线有效API产物按真token结算并原子恢复后续工位', async () => {
  const created = runWithTenant(1, () => createPipelineStation({
    valid: true,
    title: '流水线有效工位待对账',
  }));
  await withServer(boss, async base => {
    const queue = await getQueue(base);
    const row = queue.body.rows.find(item => item.holdId === Number(created.hold.holdId));
    assert.ok(row, '待对账列表应该包含流水线工位预授权');
    assert.equal(row.refType, 'content_production_pipeline_station');
    assert.equal(row.business.pipelineId, created.pipelineId);
    assert.equal(row.business.stationIdx, created.stationIdx);
    assert.equal(row.business.contractValid, true, JSON.stringify(row.business.errors));
    assert.equal(row.business.leakageClear, true, JSON.stringify(row.business.errors));
    assert.equal(row.business.deliveryValid, true, JSON.stringify(row.business.errors));
    assert.deepEqual(row.availableActions, ['settle']);

    const resolved = await fetch(`${base}/sys/billing/reconciliation/${row.holdId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'settle',
        reason: '流水线工位产物、API模型、token和完整员工包证据一致',
        evidenceHash: row.evidenceHash,
      }),
    });
    const resolvedBody = await resolved.json();
    assert.equal(resolved.status, 200, JSON.stringify(resolvedBody));

    const hold = q.get('SELECT status,settled_credits,log_id FROM credit_holds WHERE id=?', row.holdId);
    const log = q.get('SELECT model,input_tokens,output_tokens,ai_mode FROM credit_logs WHERE id=?', hold.log_id);
    const station = q.get(`SELECT status,billing_evidence_json,failure_json
      FROM content_production_pipeline_stations
      WHERE tenant_id=1 AND pipeline_id=? AND station_idx=?`, created.pipelineId, created.stationIdx);
    const job = q.get(`SELECT status,current_station,pending_station,failure_json
      FROM content_production_pipeline_jobs WHERE tenant_id=1 AND id=?`, created.pipelineId);
    const billingEvidence = JSON.parse(station.billing_evidence_json);
    assert.equal(hold.status, 'settled');
    assert.ok(Number(hold.settled_credits) > 0);
    assert.equal(log.model, 'gpt-5.5');
    assert.equal(log.input_tokens, 1200);
    assert.equal(log.output_tokens, 480);
    assert.equal(log.ai_mode, 'api');
    assert.equal(station.status, 'completed');
    assert.equal(station.failure_json, null);
    assert.equal(billingEvidence.state, 'settled');
    assert.equal(billingEvidence.pendingReconciliation, false);
    assert.equal(job.status, 'running');
    assert.equal(job.current_station, created.stationIdx + 1);
    assert.equal(job.pending_station, null);
    assert.equal(job.failure_json, null);

    const duplicate = await fetch(`${base}/sys/billing/reconciliation/${row.holdId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'settle',
        reason: '同一流水线工位不得重复结算',
        evidenceHash: row.evidenceHash,
      }),
    });
    assert.equal(duplicate.status, 409);
  });
});

test('内容流水线无效产物禁止结算，全额退款后工位与任务进入失败终态', async () => {
  const created = runWithTenant(1, () => createPipelineStation({
    valid: false,
    title: '流水线无效工位待对账',
  }));
  const beforeRelease = Number(q.get('SELECT credits FROM tenants WHERE id=1').credits);
  await withServer(boss, async base => {
    const queue = await getQueue(base);
    const row = queue.body.rows.find(item => item.holdId === Number(created.hold.holdId));
    assert.ok(row);
    assert.equal(row.business.deliveryValid, false);
    assert.equal(row.business.contractValid, false);
    assert.deepEqual(row.availableActions, ['release']);

    const forbiddenSettlement = await fetch(`${base}/sys/billing/reconciliation/${row.holdId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'settle',
        reason: '无效产物不得凭供应商自报token结算',
        evidenceHash: row.evidenceHash,
      }),
    });
    assert.equal(forbiddenSettlement.status, 409);
    assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', row.holdId).status, 'held');

    const released = await fetch(`${base}/sys/billing/reconciliation/${row.holdId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'release',
        reason: '工位主产物未通过对应内容输出契约，确认不可交付',
        evidenceHash: row.evidenceHash,
      }),
    });
    assert.equal(released.status, 200, JSON.stringify(await released.clone().json()));
  });

  const hold = q.get('SELECT status,settled_credits FROM credit_holds WHERE id=?', created.hold.holdId);
  const station = q.get(`SELECT status,billing_evidence_json,failure_json
    FROM content_production_pipeline_stations
    WHERE tenant_id=1 AND pipeline_id=? AND station_idx=?`, created.pipelineId, created.stationIdx);
  const job = q.get(`SELECT status,current_station,failure_json
    FROM content_production_pipeline_jobs WHERE tenant_id=1 AND id=?`, created.pipelineId);
  const stationFailure = JSON.parse(station.failure_json);
  assert.equal(hold.status, 'settled');
  assert.equal(hold.settled_credits, 0);
  assert.equal(Number(q.get('SELECT credits FROM tenants WHERE id=1').credits),
    beforeRelease + Number(created.hold.credits));
  assert.equal(station.status, 'failed');
  assert.equal(JSON.parse(station.billing_evidence_json).state, 'released');
  assert.equal(stationFailure.code, 'CONTENT_PIPELINE_RECONCILIATION_RELEASED');
  assert.equal(job.status, 'failed');
  assert.equal(job.current_station, created.stationIdx);
  assert.equal(JSON.parse(job.failure_json).code, 'CONTENT_PIPELINE_RECONCILIATION_RELEASED');
});

test('内容流水线正常执行窗口内禁止结算或退款', async () => {
  const created = runWithTenant(1, () => createPipelineStation({
    active: true,
    valid: false,
    title: '流水线仍在真实生成',
  }));
  await withServer(boss, async base => {
    const queue = await getQueue(base);
    const row = queue.body.rows.find(item => item.holdId === Number(created.hold.holdId));
    assert.ok(row);
    assert.equal(row.stillActive, true);
    assert.deepEqual(row.availableActions, []);
    assert.match(row.blockedReason, /正常执行窗口/u);

    const blocked = await fetch(`${base}/sys/billing/reconciliation/${row.holdId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'release',
        reason: '执行窗口内不得擅自退款或终止任务',
        evidenceHash: row.evidenceHash,
      }),
    });
    assert.equal(blocked.status, 409);
  });
  assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', created.hold.holdId).status, 'held');
  assert.equal(q.get(`SELECT status FROM content_production_pipeline_stations
    WHERE tenant_id=1 AND pipeline_id=? AND station_idx=?`, created.pipelineId, created.stationIdx).status, 'running');
  assert.equal(q.get(`SELECT status FROM content_production_pipeline_jobs
    WHERE tenant_id=1 AND id=?`, created.pipelineId).status, 'running');
});

test('特殊图片provider核验真实素材后按预授权固定价结算并恢复流水线', async () => {
  const created = runWithTenant(1, () => createSpecialProviderAttempt({
    valid: true,
    title: '特殊图片Provider有效交付',
  }));
  await withServer(boss, async base => {
    const queue = await getQueue(base);
    const row = queue.body.rows.find(item => item.holdId === Number(created.hold.holdId));
    assert.ok(row);
    assert.equal(row.refType, 'content_special_provider');
    assert.equal(row.business.providerKind, 'image');
    assert.equal(row.business.providerValid, true, JSON.stringify(row.business.errors));
    assert.equal(row.business.artifactsValid, true, JSON.stringify(row.business.errors));
    assert.equal(row.business.deliveryValid, true, JSON.stringify(row.business.errors));
    assert.deepEqual(row.availableActions, ['settle']);

    const resolved = await fetch(`${base}/sys/billing/reconciliation/${row.holdId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'settle',
        reason: '图片provider、素材内容哈希、attempt与计费引用均一致',
        evidenceHash: row.evidenceHash,
      }),
    });
    assert.equal(resolved.status, 200, JSON.stringify(await resolved.clone().json()));

    const hold = q.get('SELECT status,held_credits,settled_credits,log_id FROM credit_holds WHERE id=?', row.holdId);
    const log = q.get('SELECT kind,model,input_tokens,output_tokens,credits,ai_mode FROM credit_logs WHERE id=?', hold.log_id);
    const attempt = q.get(`SELECT status,billing_json FROM content_pipeline_special_provider_attempts
      WHERE tenant_id=1 AND attempt_id=?`, created.attemptId);
    const station = q.get(`SELECT status,billing_evidence_json,failure_json
      FROM content_production_pipeline_stations
      WHERE tenant_id=1 AND pipeline_id=? AND station_idx=?`, created.pipelineId, created.stationIdx);
    const job = q.get(`SELECT status,current_station,failure_json
      FROM content_production_pipeline_jobs WHERE tenant_id=1 AND id=?`, created.pipelineId);
    assert.equal(hold.status, 'settled');
    assert.equal(hold.settled_credits, hold.held_credits);
    assert.equal(log.kind, 'image');
    assert.equal(log.model, 'gpt-image-2');
    assert.equal(log.input_tokens, 0);
    assert.equal(log.output_tokens, 0);
    assert.equal(log.credits, hold.held_credits);
    assert.equal(log.ai_mode, 'api');
    assert.equal(attempt.status, 'settled');
    assert.equal(JSON.parse(attempt.billing_json).pendingReconciliation, false);
    assert.equal(station.status, 'completed');
    assert.equal(JSON.parse(station.billing_evidence_json).state, 'settled');
    assert.equal(station.failure_json, null);
    assert.equal(job.status, 'running');
    assert.equal(job.current_station, created.stationIdx + 1);
    assert.equal(job.failure_json, null);
    assert.equal(q.get('SELECT source_type FROM materials WHERE id=?', created.materialId).source_type,
      'content_pipeline_provider');

    const duplicate = await fetch(`${base}/sys/billing/reconciliation/${row.holdId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'settle',
        reason: '同一图片provider预授权不得重复结算',
        evidenceHash: row.evidenceHash,
      }),
    });
    assert.equal(duplicate.status, 409);
  });
});

test('特殊provider素材校验失败时禁止结算，退款后隔离素材并停止流水线', async () => {
  const created = runWithTenant(1, () => createSpecialProviderAttempt({
    valid: false,
    title: '特殊图片Provider无效交付',
  }));
  const beforeRelease = Number(q.get('SELECT credits FROM tenants WHERE id=1').credits);
  await withServer(boss, async base => {
    const queue = await getQueue(base);
    const row = queue.body.rows.find(item => item.holdId === Number(created.hold.holdId));
    assert.ok(row);
    assert.equal(row.business.artifactsValid, false);
    assert.equal(row.business.deliveryValid, false);
    assert.deepEqual(row.availableActions, ['release']);

    const forbidden = await fetch(`${base}/sys/billing/reconciliation/${row.holdId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'settle',
        reason: '内容哈希不一致的素材不得扣费',
        evidenceHash: row.evidenceHash,
      }),
    });
    assert.equal(forbidden.status, 409);

    const released = await fetch(`${base}/sys/billing/reconciliation/${row.holdId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'release',
        reason: '素材内容哈希与不可变快照不一致，确认校验失败',
        evidenceHash: row.evidenceHash,
      }),
    });
    assert.equal(released.status, 200, JSON.stringify(await released.clone().json()));
  });
  const hold = q.get('SELECT status,settled_credits FROM credit_holds WHERE id=?', created.hold.holdId);
  const attempt = q.get(`SELECT status,billing_json,error_json
    FROM content_pipeline_special_provider_attempts WHERE tenant_id=1 AND attempt_id=?`, created.attemptId);
  const station = q.get(`SELECT status,failure_json FROM content_production_pipeline_stations
    WHERE tenant_id=1 AND pipeline_id=? AND station_idx=?`, created.pipelineId, created.stationIdx);
  const job = q.get(`SELECT status,failure_json FROM content_production_pipeline_jobs
    WHERE tenant_id=1 AND id=?`, created.pipelineId);
  assert.equal(hold.status, 'settled');
  assert.equal(hold.settled_credits, 0);
  assert.equal(Number(q.get('SELECT credits FROM tenants WHERE id=1').credits),
    beforeRelease + Number(created.hold.credits));
  assert.equal(attempt.status, 'failed');
  assert.equal(JSON.parse(attempt.billing_json).state, 'released');
  assert.equal(JSON.parse(attempt.error_json).code, 'CONTENT_SPECIAL_PROVIDER_RECONCILIATION_RELEASED');
  assert.equal(q.get('SELECT source_type FROM materials WHERE id=?', created.materialId).source_type,
    'content_pipeline_provider_quality_quarantine');
  assert.equal(station.status, 'failed');
  assert.equal(JSON.parse(station.failure_json).code, 'CONTENT_PIPELINE_SPECIAL_PROVIDER_RECONCILIATION_FAILED');
  assert.equal(job.status, 'failed');
});

test('特殊provider重复占扣、未知attempt和正常执行窗口均保持阻断', async () => {
  const duplicate = runWithTenant(1, () => {
    const created = createSpecialProviderAttempt({
      valid: true,
      title: '特殊Provider重复占扣',
    });
    const secondHold = holdCredits({
      userId: bossId,
      feature: '特殊Provider重复占扣',
      kind: 'image',
      model: 'gpt-image-2',
      credits: 75,
      refType: 'content_special_provider',
      refId: created.refId,
    });
    return { ...created, secondHold };
  });
  const unknown = runWithTenant(1, () => ({
    hold: holdCredits({
      userId: bossId,
      feature: '特殊Provider未知attempt',
      kind: 'image',
      model: 'gpt-image-2',
      credits: 75,
      refType: 'content_special_provider',
      refId: 8_999_999_999,
    }),
  }));
  const active = runWithTenant(1, () => createSpecialProviderAttempt({
    active: true,
    title: '特殊Provider仍在生成',
  }));

  await withServer(boss, async base => {
    const queue = await getQueue(base);
    for (const holdId of [Number(duplicate.hold.holdId), Number(duplicate.secondHold.holdId)]) {
      const row = queue.body.rows.find(item => item.holdId === holdId);
      assert.ok(row);
      assert.deepEqual(row.availableActions, []);
      assert.match(row.blockedReason, /多笔占扣/u);
    }
    const unknownRow = queue.body.rows.find(item => item.holdId === Number(unknown.hold.holdId));
    assert.ok(unknownRow);
    assert.deepEqual(unknownRow.availableActions, []);
    assert.match(unknownRow.blockedReason, /attempt不存在/u);

    const activeRow = queue.body.rows.find(item => item.holdId === Number(active.hold.holdId));
    assert.ok(activeRow);
    assert.equal(activeRow.stillActive, true);
    assert.deepEqual(activeRow.availableActions, []);
    assert.match(activeRow.blockedReason, /正常执行窗口/u);
    const blocked = await fetch(`${base}/sys/billing/reconciliation/${activeRow.holdId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'release',
        reason: '特殊provider仍在执行，不得擅自退款',
        evidenceHash: activeRow.evidenceHash,
      }),
    });
    assert.equal(blocked.status, 409);
  });
  for (const holdId of [
    duplicate.hold.holdId,
    duplicate.secondHold.holdId,
    unknown.hold.holdId,
    active.hold.holdId,
  ]) {
    assert.equal(q.get('SELECT status FROM credit_holds WHERE id=?', holdId).status, 'held');
  }
});
