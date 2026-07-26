import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DBP = path.join(os.tmpdir(), `nanowork-content-automation-contract-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* fresh database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.SEED_DEMO = 'false';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { executeContentAutomationRun } = await import('../src/routes/content.js');
const { releaseHold } = await import('../src/engines/credits.js');

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'契约测试A店','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(2,'契约测试B店','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);

function insertUser(tenantId, username, name) {
  return Number(q.run(`INSERT INTO users(
    username,password_hash,name,role,dept,status,tenant_id
  ) VALUES(?,?,?,'boss','老板办','启用',?)`,
  username, 'x', name, tenantId).lastInsertRowid);
}

const bossA = insertUser(1, 'contract-boss-a', 'A店老板');
const bossB = insertUser(2, 'contract-boss-b', 'B店老板');

function createRuleAndRun(tenantId, {
  employeeIdx,
  contentType,
  approvalMode = 'risk',
  claimKey,
  userId,
}) {
  return runWithTenant(tenantId, () => {
    const ruleId = Number(q.run(`INSERT INTO content_automation_rules(
      name,enabled,employee_idx,topic,requirement,content_type,content_count,
      frequency,run_time,weekday,approval_mode,next_run_at,created_by
    ) VALUES(?,1,?,?,?,?,?,'daily','10:00',NULL,?,NULL,?)`,
    `契约规则-${claimKey}`, employeeIdx, '契约化内容', '只能使用已确认事实',
    contentType, 1, approvalMode, userId).lastInsertRowid);
    const runId = Number(q.run(`INSERT INTO content_automation_runs(
      rule_id,trigger,claim_key,scheduled_for,status,initiated_by
    ) VALUES(?,'immediate',?,NULL,'运行中',?)`,
    ruleId, claimKey, userId).lastInsertRowid);
    return { ruleId, runId };
  });
}

test('不合规自动化输出失败并保存契约诊断，绝不生成内容、资产或知识库素材', async () => {
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 3,
    contentType: '文案初稿',
    claimKey: 'invalid-output',
    userId: bossA,
  });
  const beforeContents = runWithTenant(1, () => q.get('SELECT COUNT(*) n FROM contents WHERE tenant_id=1').n);
  const beforeAssets = runWithTenant(1, () => q.get('SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1').n);
  const beforeKb = runWithTenant(1, () => q.get('SELECT COUNT(*) n FROM kb_docs WHERE tenant_id=1').n);
  const beforeCredits = runWithTenant(1, () => q.get('SELECT credits FROM tenants WHERE id=1').credits);
  let generateCalls = 0;

  await assert.rejects(
    runWithTenant(1, () => executeContentAutomationRun({
      ruleId,
      runId,
      trigger: 'immediate',
      initiatedBy: bossA,
      generateFn: async () => {
        generateCalls += 1;
        return {
          text: JSON.stringify({ title_candidates: ['只有标题，没有正文'] }),
          mode: 'api',
          model: 'contract-test-model',
          usage: { inputTokens: 5, outputTokens: 3 },
        };
      },
    })),
    /输出契约校验未通过.*body.*tags.*image_plan/u,
  );

  const stored = runWithTenant(1, () => q.get(
    'SELECT status,content_id,snapshot_json,error FROM content_automation_runs WHERE tenant_id=1 AND id=?',
    runId,
  ));
  assert.equal(generateCalls, 1);
  assert.equal(stored.status, '失败');
  assert.equal(stored.content_id, null);
  assert.match(stored.error, /输出契约校验未通过/u);
  const snapshot = JSON.parse(stored.snapshot_json);
  assert.equal(snapshot.identity.idx, 3);
  assert.equal(snapshot.contract.status, 'invalid');
  assert.equal(snapshot.contract.valid, false);
  assert.equal(snapshot.contract.requiresManualRepair, true);
  assert.match(snapshot.contract.errors.join(' '), /body.*tags.*image_plan/u);
  assert.match(snapshot.contract.previewMarkdown, /只有标题/u);
  assert.deepEqual(snapshot.contract.artifacts, []);
  assert.equal(snapshot.billing.state, 'released');
  assert.equal(snapshot.billing.chargedCredits, 0);
  assert.equal(runWithTenant(1, () => q.get('SELECT COUNT(*) n FROM contents WHERE tenant_id=1').n), beforeContents);
  assert.equal(runWithTenant(1, () => q.get('SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1').n), beforeAssets);
  assert.equal(runWithTenant(1, () => q.get('SELECT COUNT(*) n FROM kb_docs WHERE tenant_id=1').n), beforeKb);
  assert.equal(runWithTenant(1, () => q.get('SELECT credits FROM tenants WHERE id=1').credits), beforeCredits);
  assert.equal(runWithTenant(1, () => q.get(
    `SELECT COUNT(*) n FROM credit_holds WHERE tenant_id=1 AND status='held'`,
  ).n), 0);
  assert.equal(runWithTenant(1, () => q.get(
    'SELECT last_status FROM content_automation_rules WHERE tenant_id=1 AND id=?',
    ruleId,
  ).last_status), '失败');

  const repeated = await runWithTenant(1, () => executeContentAutomationRun({
    ruleId,
    runId,
    trigger: 'immediate',
    initiatedBy: bossA,
    generateFn: async () => {
      generateCalls += 1;
      throw new Error('幂等返回时不应再次调用模型');
    },
  }));
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.status, '失败');
  assert.equal(generateCalls, 1);
});

test('合规输出保存完整契约快照后才进入可使用资产与知识库，且租户仍隔离', async () => {
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 9,
    contentType: '复盘报告',
    claimKey: 'valid-output',
    userId: bossA,
  });
  const validOutput = {
    report: '# 自动复盘报告\n\n仅依据已确认数据形成，尚未执行对外发布。',
    next_topics: [{ title: '下次选题', reason: '延续已确认顾客反馈' }],
    profile_updates: [],
  };
  const result = await runWithTenant(1, () => executeContentAutomationRun({
    ruleId,
    runId,
    trigger: 'immediate',
    initiatedBy: bossA,
    generateFn: async options => {
      assert.match(options.userMsg, /当前岗位最终输出契约/u);
      assert.match(options.userMsg, /"report".*"next_topics".*"profile_updates"/su);
      return {
        text: JSON.stringify(validOutput),
        mode: 'api',
        model: 'contract-test-model',
        usage: { inputTokens: 5, outputTokens: 8 },
      };
    },
  }));

  assert.equal(result.status, '成功');
  assert.equal(result.contentStatus, '可使用');
  assert.equal(result.contract.status, 'valid');
  assert.equal(result.contract.valid, true);
  assert.equal(result.billing.state, 'settled');
  assert.ok(result.billing.chargedCredits > 0);
  assert.equal(result.contract.artifacts[0].kind, 'markdown');
  const content = runWithTenant(1, () => q.get(
    'SELECT body,status FROM contents WHERE tenant_id=1 AND id=?',
    result.contentId,
  ));
  assert.equal(content.status, '可使用');
  assert.equal(content.body, validOutput.report);
  assert.equal(runWithTenant(1, () => q.get(`SELECT COUNT(*) n FROM biz_assets
    WHERE tenant_id=1 AND source_type='content' AND source_id=?`, result.contentId).n), 1);
  assert.equal(runWithTenant(1, () => q.get(`SELECT COUNT(*) n FROM kb_docs
    WHERE tenant_id=1 AND body=?`, validOutput.report).n), 1);

  const stored = runWithTenant(1, () => q.get(
    'SELECT status,snapshot_json,error FROM content_automation_runs WHERE tenant_id=1 AND id=?',
    runId,
  ));
  assert.equal(stored.status, '成功');
  assert.equal(stored.error, null);
  const snapshot = JSON.parse(stored.snapshot_json);
  assert.equal(snapshot.contract.status, 'valid');
  assert.equal(snapshot.contract.valid, true);
  assert.deepEqual(snapshot.contract.errors, []);
  assert.equal(snapshot.contract.previewMarkdown, validOutput.report);
  assert.equal(snapshot.contract.artifacts.length, 1);
  assert.equal(snapshot.contract.artifacts[0].content, validOutput.report);
  assert.equal(snapshot.contract.artifacts[0].employeeIdx, 9);
  assert.equal(snapshot.billing.state, 'settled');
  assert.equal(snapshot.billing.chargedCredits, result.billing.chargedCredits);

  const other = createRuleAndRun(2, {
    employeeIdx: 9,
    contentType: '复盘报告',
    claimKey: 'tenant-b-output',
    userId: bossB,
  });
  await assert.rejects(
    runWithTenant(1, () => executeContentAutomationRun({
      ...other,
      trigger: 'immediate',
      initiatedBy: bossA,
      generateFn: async () => {
        throw new Error('跨租户查找失败时不应调用模型');
      },
    })),
    /运行记录不存在/u,
  );
  assert.equal(runWithTenant(2, () => q.get(
    'SELECT status FROM content_automation_runs WHERE tenant_id=2 AND id=?',
    other.runId,
  ).status), '运行中');
});

test('自动化内容已落库但结算异常时保持成功产物并标记待对账', async () => {
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 9,
    contentType: '复盘报告',
    claimKey: 'settlement-pending',
    userId: bossA,
  });
  db.exec(`CREATE TRIGGER injected_automation_settlement_failure
    BEFORE UPDATE OF status ON credit_holds
    WHEN OLD.feature='内容自动化·复盘报告' AND OLD.status='held' AND NEW.status='settled'
    BEGIN
      SELECT RAISE(ABORT,'injected automation settlement failure');
    END`);
  let pendingHold;
  try {
    const result = await runWithTenant(1, () => executeContentAutomationRun({
      ruleId,
      runId,
      trigger: 'scheduled',
      initiatedBy: bossA,
      generateFn: async () => ({
        text: JSON.stringify({
          report: '# 待对账自动复盘\n\n业务产物已经形成。',
          next_topics: [],
          profile_updates: [],
        }),
        mode: 'api',
        model: 'contract-test-model',
        usage: { inputTokens: 5, outputTokens: 8 },
      }),
    }));
    assert.equal(result.status, '成功');
    assert.ok(result.contentId);
    assert.equal(result.billing.state, 'pending_reconciliation');
    assert.equal(result.billing.chargedCredits, null);
    const runRow = runWithTenant(1, () => q.get(
      `SELECT status,content_id,snapshot_json FROM content_automation_runs
       WHERE tenant_id=1 AND id=?`,
      runId,
    ));
    assert.equal(runRow.status, '成功');
    assert.equal(runRow.content_id, result.contentId);
    assert.equal(JSON.parse(runRow.snapshot_json).billing.state, 'pending_reconciliation');
    assert.equal(JSON.parse(runWithTenant(1, () => q.get(
      'SELECT snapshot_json FROM contents WHERE tenant_id=1 AND id=?',
      result.contentId,
    )).snapshot_json).billing.state, 'pending_reconciliation');
    pendingHold = runWithTenant(1, () => q.get(
      `SELECT * FROM credit_holds
       WHERE tenant_id=1 AND ref_type='content_automation_run' AND ref_id=? AND status='held'`,
      runId,
    ));
    assert.ok(pendingHold);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_automation_settlement_failure');
    if (pendingHold) {
      runWithTenant(1, () => releaseHold({
        holdId: pendingHold.id,
        logId: pendingHold.log_id,
        tenantId: pendingHold.tenant_id,
        userId: pendingHold.user_id,
        feature: pendingHold.feature,
        kind: pendingHold.kind,
        model: pendingHold.model,
        credits: pendingHold.held_credits,
        balance: q.get('SELECT credits FROM tenants WHERE id=1').credits,
      }, '专项测试清理自动化待对账占扣'));
    }
  }
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* cleanup */ }
  }
});
