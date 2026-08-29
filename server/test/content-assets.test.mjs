import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const DBP = path.join(os.tmpdir(), `nanowork-content-assets-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* fresh database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.SEED_DEMO = 'false';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { contentAssetBaseValue, ensureContentAsset } = await import('../src/engines/content-assets.js');
const { holdCredits, releaseHold, settleHold } = await import('../src/engines/credits.js');
const {
  buildRestaurantOutputDeliverableFixture,
  getRestaurantOutputContract,
  renderRestaurantOutputMarkdown,
  validateRestaurantEmployeeOutputContract,
} = await import('../src/engines/restaurant-output-contract.js');
const {
  loadContentAdoptionAvailability,
  loadContentDeliveryState,
} = await import('../src/engines/delivery-state.js');

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'内容资产测试企业','已开通',10000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);
q.run(`INSERT OR IGNORE INTO marshals(id,code,name,title,duty)
  VALUES(1,'M-ASSET','内容资产测试分部','测试','交付门禁测试')`);
const userId = Number(q.run(`INSERT INTO users(
  username,password_hash,name,role,status,tenant_id
) VALUES('content-asset-owner','x','内容资产负责人','boss','启用',1)`).lastInsertRowid);

function approveContent(contentId, reason = '内容资产测试已完成真实人工复核') {
  return Number(q.run(`INSERT INTO approvals(
    target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,
    reviewer_id,reason,approval_level,decided_at
  ) VALUES('content',?,'内容资产测试人工采纳','已核验正文、来源、契约和结算',
    'none','["content_asset_test_human_adoption"]','已通过',?,?,?,'boss',
    datetime('now','localtime'))`,
  contentId, userId, userId, reason).lastInsertRowid);
}

test('内容资产基础价值按内容类型稳定映射', () => {
  assert.equal(contentAssetBaseValue({ type: '朋友圈文案' }), 50);
  assert.equal(contentAssetBaseValue({ type: 'AIPPT' }), 180);
  assert.equal(contentAssetBaseValue({ type: 'AI视频' }), 220);
  assert.equal(contentAssetBaseValue({ type: '未知内容' }), 80);
});

test('ensureContentAsset 幂等补建，并把既有发布效果纳入最低价值与使用次数', () => {
  const contentId = runWithTenant(1, () => Number(q.run(`INSERT INTO contents(
    type,title,body,status,ai_mode,creator_id,effect_views,effect_leads
  ) VALUES('朋友圈文案','可追溯内容','正文','可使用','manual',?,100,3)`, userId).lastInsertRowid));

  runWithTenant(1, () => {
    const first = ensureContentAsset(contentId);
    assert.equal(first.value, 80);
    assert.equal(first.use_count, 0);

    q.run(`INSERT INTO content_publish_logs(
      content_id,channel,views,leads,idempotency_key,created_by
    ) VALUES(?,?,?,?,?,?)`, contentId, '朋友圈', 100, 3, '11111111-1111-4111-8111-111111111111', userId);
    q.run(`INSERT INTO content_publish_logs(
      content_id,channel,views,leads,idempotency_key,created_by
    ) VALUES(?,?,?,?,?,?)`, contentId, '社群', 50, 2, '22222222-2222-4222-8222-222222222222', userId);
    q.run(`UPDATE contents SET effect_views=150,effect_leads=5,status='已发布' WHERE id=?`, contentId);

    const second = ensureContentAsset(contentId);
    assert.equal(second.existed, true);
    assert.equal(second.value, 100);
    assert.equal(second.use_count, 2);
    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets
      WHERE tenant_id=1 AND source_type='content' AND source_id=?`, contentId).n, 1);
  });
});

test('统一交付门禁拒绝 template/fallback/failed、无效契约与调用方伪造状态', () => {
  runWithTenant(1, () => {
    for (const mode of ['template', 'fallback', 'failed']) {
      const id = Number(q.run(`INSERT INTO contents(
        type,title,body,status,ai_mode,creator_id
      ) VALUES('朋友圈文案',?,?, '可使用',?,?)`,
      `${mode}底稿`, `${mode}不得入资产`, mode, userId).lastInsertRowid);
      assert.throws(
        () => ensureContentAsset({ id, status: '可使用', ai_mode: 'api' }),
        error => error?.code === 'DELIVERY_PROVENANCE_BLOCKED' && error?.status === 409,
      );
    }

    const invalidContractId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,ai_mode,creator_id,snapshot_json
    ) VALUES('朋友圈文案','无效契约','契约未通过','可使用','api',?,?)`,
    userId, JSON.stringify({
      contract: { status: 'invalid', valid: false, errors: ['schema invalid'] },
      billing: { state: 'settled', chargedCredits: 1 },
    })).lastInsertRowid);
    assert.throws(
      () => ensureContentAsset(invalidContractId),
      error => error?.code === 'DELIVERY_CONTRACT_INVALID' && /schema invalid/u.test(error.message),
    );

    assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1
      AND source_type='content' AND source_id IN (SELECT id FROM contents WHERE title IN (
        'template底稿','fallback底稿','failed底稿','无效契约'
      ))`).n, 0);
  });
});

test('真实 API 经人工审批后可用，明确人工导入免自审批保持可用', () => {
  runWithTenant(1, () => {
    const apiId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,ai_mode,creator_id,snapshot_json
    ) VALUES('朋友圈文案','API有效产物','真实正文','可使用','api',?,?)`,
    userId, JSON.stringify({
      contract: { status: 'valid', valid: true },
      billing: { state: 'settled', chargedCredits: 3 },
    })).lastInsertRowid);
    approveContent(apiId);
    assert.equal(ensureContentAsset(apiId).source_id, apiId);

    const manualId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,ai_mode,source_type,creator_id
    ) VALUES('朋友圈文案','人工导入','人工编写正文','可使用','template','manual',?)`,
    userId).lastInsertRowid);
    assert.equal(q.get(`SELECT COUNT(*) n FROM approvals
      WHERE tenant_id=1 AND target_type='content' AND target_id=?`, manualId).n, 0);
    assert.equal(ensureContentAsset(manualId).source_id, manualId);

    const failedButForgedManualId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,ai_mode,source_type,creator_id
    ) VALUES('朋友圈文案','失败产物伪造人工来源','失败底稿','可使用','failed','manual',?)`,
    userId).lastInsertRowid);
    assert.throws(
      () => ensureContentAsset(failedButForgedManualId),
      error => error?.code === 'DELIVERY_PROVENANCE_BLOCKED',
    );
  });
});

test('真实 AI 内容缺少结算或仍在占扣/待对账时不可采纳，人工内容明确免计费', () => {
  runWithTenant(1, () => {
    for (const [title, snapshot, expectedCode] of [
      ['缺少账务', { contract: { status: 'valid', valid: true } }, 'DELIVERY_BILLING_MISSING'],
      ['仍在占扣', { contract: { status: 'valid', valid: true }, billing: { state: 'held' } }, 'DELIVERY_BILLING_UNSETTLED'],
      ['等待对账', { contract: { status: 'valid', valid: true }, billing: { state: 'pending_reconciliation' } }, 'DELIVERY_BILLING_UNSETTLED'],
    ]) {
      const id = Number(q.run(`INSERT INTO contents(
        type,title,body,status,ai_mode,creator_id,snapshot_json
      ) VALUES('朋友圈文案',?,'真实 API 正文','可使用','api',?,?)`,
      title, userId, JSON.stringify(snapshot)).lastInsertRowid);
      const delivery = loadContentDeliveryState(id);
      assert.equal(delivery.eligible, false, title);
      assert.equal(delivery.code, expectedCode, title);
      assert.equal(loadContentAdoptionAvailability(id).canAdopt, false, title);
      assert.throws(() => ensureContentAsset(id), error => error?.code === expectedCode, title);
    }

    const manualId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,ai_mode,source_type,creator_id,snapshot_json
    ) VALUES('朋友圈文案','人工免计费内容','负责人亲自撰写','可使用','manual','manual',?,NULL)`,
    userId).lastInsertRowid);
    assert.equal(loadContentDeliveryState(manualId).billing.state, 'not_required');
    assert.equal(ensureContentAsset(manualId).source_id, manualId);
  });
});

test('人工采纳内容只继承同租户来源运行的结算凭证，显式未结算状态不得被覆盖', () => {
  runWithTenant(1, () => {
    const insertRun = billing => {
      const runId = Number(q.run(`INSERT INTO content_employee_runs(
      employee_idx,employee_key,employee_name,employee_group,title,type,requirement,status,
      result_md,ai_mode,model,profile_version,prompt_hash,snapshot_json,created_by
    ) VALUES(8,'distribution','分发官','分发运营部','来源运行','平台发布包','形成待发布内容',
      '已完成','已人工采纳正文','api','test-model','profile-v1','prompt-hash',?,?)`,
    JSON.stringify({
      contractValid: true,
      contract: { valid: true },
      billing,
      providerAttempt: { mode: 'api', model: 'test-model', usage: { inputTokens: 120, outputTokens: 40 } },
      internalProfileLeakage: { detected: false },
      review: { decision: 'adopt' },
    }), userId).lastInsertRowid);
      if (billing.state === 'settled') {
        const hold = holdCredits({
          userId,
          feature: '内容员工单派·分发官',
          kind: 'text',
          model: 'test-model',
          credits: 6,
          refType: 'content_employee_run',
          refId: runId,
        });
        settleHold(hold, {
          credits: Number(billing.chargedCredits),
          aiMode: 'api',
          model: 'test-model',
          usage: { inputTokens: 120, outputTokens: 40 },
        });
      } else if (billing.state === 'pending_reconciliation') {
        holdCredits({
          userId,
          feature: '内容员工单派·分发官',
          kind: 'text',
          model: 'test-model',
          credits: 6,
          refType: 'content_employee_run',
          refId: runId,
        });
      }
      return runId;
    };
    const insertDerived = (runId, title, snapshot = { contract: { status: 'valid', valid: true } }) =>
      Number(q.run(`INSERT INTO contents(
        type,title,body,status,ai_mode,creator_id,source_type,source_id,snapshot_json
      ) VALUES('平台发布包',?,'已人工采纳正文','可使用','api',?,'content_employee_run',?,?)`,
      title, userId, runId, JSON.stringify(snapshot)).lastInsertRowid);

    const settledRunId = insertRun({ state: 'settled', chargedCredits: 4 });
    const settledContentId = insertDerived(settledRunId, '继承已结算凭证');
    approveContent(settledContentId);
    const settled = loadContentDeliveryState(settledContentId);
    assert.equal(settled.eligible, true);
    assert.equal(settled.billing.state, 'settled');
    assert.equal(settled.billing.evidenceSource, 'content_employee_run');
    assert.equal(settled.billing.evidenceSourceId, settledRunId);

    const pendingRunId = insertRun({ state: 'pending_reconciliation', chargedCredits: null });
    const pendingContentId = insertDerived(pendingRunId, '继承待对账凭证');
    assert.equal(loadContentDeliveryState(pendingContentId).code, 'DELIVERY_BILLING_UNSETTLED');
    assert.equal(loadContentAdoptionAvailability(pendingContentId).canAdopt, false);

    const secondSettledRunId = insertRun({ state: 'settled', chargedCredits: 4 });
    const explicitPendingId = insertDerived(secondSettledRunId, '下游显式待对账', {
      contract: { status: 'valid', valid: true },
      billing: { state: 'held' },
    });
    approveContent(explicitPendingId);
    const explicitPending = loadContentDeliveryState(explicitPendingId);
    assert.equal(explicitPending.eligible, true);
    assert.equal(explicitPending.billing.state, 'settled');
    assert.equal(explicitPending.billing.evidenceSource, 'content_employee_run');
  });
});

test('餐饮任务只接受权威任务账本，快照自报不得覆盖结算结论', () => {
  runWithTenant(1, () => {
    const marshalName = q.get('SELECT name FROM marshals WHERE id=1').name;
    const taskTitle = '餐饮任务账本验收任务';
    const taskRequirement = '只使用门店验收材料形成可审阅交付';
    const parsedOutput = buildRestaurantOutputDeliverableFixture(101, { title: taskTitle, requirement: taskRequirement });
    const contract = getRestaurantOutputContract(101);
    const validated = validateRestaurantEmployeeOutputContract(101, parsedOutput, { task: { title: taskTitle, requirement: taskRequirement } });
    const outputBody = renderRestaurantOutputMarkdown(101, parsedOutput, { task: { title: taskTitle, requirement: taskRequirement } });
    const primary = validated.artifacts[0];
    const artifactSha = crypto.createHash('sha256').update(primary.content).digest('hex');
    const executionEvidence = JSON.stringify({
      kind: 'restaurant_employee_execution_evidence',
      outputContract: {
        valid: true, contractId: contract.contractId, schemaVersion: contract.schemaVersion,
        primaryArtifact: contract.primaryArtifact, parsedOutput,
        providerResponseSha256: artifactSha,
        renderedBodySha256: crypto.createHash('sha256').update(outputBody).digest('hex'),
        artifacts: [{
          primary: true, kind: contract.primaryArtifact, contractId: contract.contractId,
          schemaVersion: contract.schemaVersion, contentSha256: artifactSha,
        }],
      },
      internalProfileLeakage: { detected: false, matches: [] },
    });
    const insertLinked = (title, snapshot = { contract: { status: 'valid', valid: true } }) => {
      const contentId = Number(q.run(`INSERT INTO contents(
        type,title,body,status,ai_mode,creator_id,snapshot_json
      ) VALUES('员工产出',?,'餐饮员工真实产出','可使用','api',?,?)`,
      title, userId, JSON.stringify(snapshot)).lastInsertRowid);
      q.run('UPDATE contents SET body=? WHERE tenant_id=1 AND id=?', outputBody, contentId);
      const taskId = Number(q.run(`INSERT INTO agent_tasks(
        marshal_id,title,status,output_id,created_by,employee_profile_version,employee_web_snapshot
      ) VALUES(1,?,'待审阅',?,?,'asset-test-profile',?)`,
      taskTitle, contentId, userId, executionEvidence).lastInsertRowid);
      return { contentId, taskId };
    };
    const createHold = taskId => holdCredits({
      userId,
      feature: `员工任务·${marshalName}`,
      kind: 'text',
      model: 'test-model',
      credits: 5,
      refType: 'agent_task',
      refId: taskId,
    });

    const settled = insertLinked('餐饮任务已结算');
    settleHold(createHold(settled.taskId), {
      credits: 2,
      aiMode: 'api',
      model: 'test-model',
      usage: { inputTokens: 120, outputTokens: 40 },
    });
    approveContent(settled.contentId);
    const settledState = loadContentDeliveryState(settled.contentId);
    assert.equal(settledState.eligible, true);
    assert.equal(settledState.billing.evidenceSource, 'agent_task_credit_hold');

    const pending = insertLinked('餐饮任务待对账');
    createHold(pending.taskId);
    const pendingState = loadContentDeliveryState(pending.contentId);
    assert.equal(pendingState.code, 'DELIVERY_BILLING_UNSETTLED');
    assert.equal(pendingState.billing.state, 'pending_reconciliation');
    assert.match(pendingState.reason, /待账务对账.*业务暂不可采用/u);

    const released = insertLinked('餐饮任务已退款');
    releaseHold(createHold(released.taskId), '模拟失败或驳回后全额退款');
    const releasedState = loadContentDeliveryState(released.contentId);
    assert.equal(releasedState.code, 'DELIVERY_BILLING_UNSETTLED');
    assert.equal(releasedState.billing.state, 'released');
    assert.equal(loadContentAdoptionAvailability(released.contentId).canAdopt, false);
    assert.throws(() => ensureContentAsset(released.contentId), error => (
      error?.code === 'DELIVERY_BILLING_UNSETTLED'
    ));

    const malformed = insertLinked('餐饮任务显式异常账务', {
      contract: { status: 'valid', valid: true },
      billing: null,
    });
    settleHold(createHold(malformed.taskId), {
      credits: 2,
      aiMode: 'api',
      model: 'test-model',
      usage: { inputTokens: 100, outputTokens: 30 },
    });
    approveContent(malformed.contentId);
    assert.equal(loadContentDeliveryState(malformed.contentId).eligible, true);
  });
});

test('待审核必须有待审单，审批未结束时即使状态被改成可使用也不可交付', () => {
  runWithTenant(1, () => {
    const contentId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,ai_mode,creator_id
    ) VALUES('朋友圈文案','审批一致性','待审正文','待审核','manual',?)`, userId).lastInsertRowid);

    assert.equal(loadContentDeliveryState(contentId).code, 'DELIVERY_APPROVAL_MISSING');
    const approvalId = Number(q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id
    ) VALUES('content',?,'审批一致性','待审正文','none','[]','待审核',?)`,
    contentId, userId).lastInsertRowid);
    assert.equal(loadContentDeliveryState(contentId).code, 'DELIVERY_REVIEW_PENDING');

    q.run(`UPDATE contents SET status='可使用' WHERE id=?`, contentId);
    assert.equal(loadContentDeliveryState(contentId).code, 'DELIVERY_REVIEW_PENDING');
    assert.throws(() => ensureContentAsset(contentId), error => error?.code === 'DELIVERY_REVIEW_PENDING');

    q.run(`UPDATE approvals SET status='已通过',reviewer_id=?,decided_at=datetime('now','localtime')
      WHERE id=?`, userId, approvalId);
    assert.equal(loadContentDeliveryState(contentId).eligible, true);
    assert.equal(ensureContentAsset(contentId).source_id, contentId);
  });
});

after(() => {
  db.close();
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
});
