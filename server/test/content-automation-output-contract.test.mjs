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

function setEmployeeConfig(tenantId, employeeIdx, workConfig, userId) {
  return runWithTenant(tenantId, () => q.run(`INSERT INTO content_employee_workbench_configs(
    employee_idx,prompt_override,work_config_json,skills_json,revision,updated_by
  ) VALUES(?,NULL,?,'[]',1,?)
  ON CONFLICT(tenant_id,employee_idx) DO UPDATE SET
    work_config_json=excluded.work_config_json,
    revision=content_employee_workbench_configs.revision+1,
    updated_by=excluded.updated_by`,
  employeeIdx, JSON.stringify(workConfig), userId));
}

function validTrendOutput() {
  return {
    briefing: '基于官方资料形成的趋势简报。',
    channel_scan: [{ channel: '官方资料', finding: '发现一个可核验信号' }],
    topics: Array.from({ length: 5 }, (_, index) => ({
      title: `候选选题${index + 1}`,
      angle: '经营者视角',
      hook: '先给可核验结论',
      reason: '与目标账号定位匹配',
      heat: '中',
      evidence: '官方资料',
    })),
  };
}

function validDraftOutput() {
  return {
    title_candidates: ['标题一', '标题二', '标题三'],
    body: '# 完整初稿\n\n只使用已确认事实。',
    tags: ['经营', '门店', '增长', '复盘', '实操'],
    image_plan: [
      { slot: '开头', desc: '核心结论信息图' },
      { slot: '正文', desc: '执行步骤示意图' },
    ],
  };
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
    profile_updates: ['读者更关注有证据的可执行建议'],
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

test('自动与定时共用的执行器采用员工模型、输出长度和超时配置', async () => {
  setEmployeeConfig(1, 3, {
    textModel: 'employee-contract-model',
    outputLength: 'lite',
    timeoutSeconds: 47,
  }, bossA);
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 3,
    contentType: '文案初稿',
    claimKey: 'effective-work-config',
    userId: bossA,
  });
  let captured;
  const result = await runWithTenant(1, () => executeContentAutomationRun({
    ruleId,
    runId,
    trigger: 'scheduled',
    initiatedBy: bossA,
    generateFn: async options => {
      captured = options;
      return {
        text: JSON.stringify(validDraftOutput()),
        mode: 'api',
        model: options.model,
        usage: { inputTokens: 6, outputTokens: 12 },
      };
    },
  }));

  assert.equal(result.status, '成功');
  assert.equal(captured.model, 'employee-contract-model');
  assert.equal(captured.maxTokens, 1600);
  assert.equal(captured.timeoutMs, 47000);
  assert.match(captured.userMsg, /精简：保留关键结论与行动项/u);
  const snapshot = JSON.parse(runWithTenant(1, () => q.get(
    'SELECT snapshot_json FROM content_automation_runs WHERE tenant_id=1 AND id=?',
    runId,
  )).snapshot_json);
  assert.deepEqual(snapshot.enterpriseOverlay.workConfig, {
    textModel: 'employee-contract-model',
    imageModel: 'inherit',
    outputLength: 'lite',
    approvalMode: '岗位默认',
    timeoutSeconds: 47,
  });
});

test('强制联网岗位只有取得可引用证据后才调用模型，并把证据写入提示词和快照', async () => {
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 0,
    contentType: '趋势简报',
    claimKey: 'web-evidence-success',
    userId: bossA,
  });
  let webCalls = 0;
  let generateCalls = 0;
  const result = await runWithTenant(1, () => executeContentAutomationRun({
    ruleId,
    runId,
    trigger: 'immediate',
    initiatedBy: bossA,
    webSearchFn: async query => {
      webCalls += 1;
      assert.match(query, /趋势简报.*契约化内容/su);
      return {
        ok: true,
        provider: 'stub-search',
        note: '测试证据',
        results: [{
          title: '官方资料',
          url: 'https://example.test/official',
          snippet: '一条可核验事实',
        }],
      };
    },
    generateFn: async options => {
      generateCalls += 1;
      assert.match(options.userMsg, /\[来源1\].*官方资料.*https:\/\/example\.test\/official/su);
      return {
        text: JSON.stringify(validTrendOutput()),
        mode: 'api',
        model: options.model,
        usage: { inputTokens: 8, outputTokens: 16 },
      };
    },
  }));

  assert.equal(result.status, '成功');
  assert.equal(webCalls, 1);
  assert.equal(generateCalls, 1);
  const snapshot = JSON.parse(runWithTenant(1, () => q.get(
    'SELECT snapshot_json FROM content_automation_runs WHERE tenant_id=1 AND id=?',
    runId,
  )).snapshot_json);
  assert.equal(snapshot.web.required, true);
  assert.equal(snapshot.web.attempted, true);
  assert.equal(snapshot.web.verified, true);
  assert.equal(snapshot.web.provider, 'stub-search');
  assert.equal(snapshot.web.results.length, 1);
  assert.equal(snapshot.web.results[0].url, 'https://example.test/official');
});

test('强制联网岗位检索失败或没有证据时失败，不调用模型也不冒充正常完成', async () => {
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 1,
    contentType: '事实资料包',
    claimKey: 'web-evidence-failure',
    userId: bossA,
  });
  const beforeContents = runWithTenant(1, () => q.get('SELECT COUNT(*) n FROM contents WHERE tenant_id=1').n);
  let generateCalls = 0;

  await assert.rejects(
    runWithTenant(1, () => executeContentAutomationRun({
      ruleId,
      runId,
      trigger: 'scheduled',
      initiatedBy: bossA,
      webSearchFn: async () => ({
        ok: true,
        provider: 'stub-search',
        note: '上游返回空结果',
        results: [],
      }),
      generateFn: async () => {
        generateCalls += 1;
        return { text: '{}', mode: 'api', model: '不应调用', usage: {} };
      },
    })),
    /联网检索.*可引用证据/u,
  );

  assert.equal(generateCalls, 0);
  const stored = runWithTenant(1, () => q.get(
    'SELECT status,content_id,snapshot_json,error FROM content_automation_runs WHERE tenant_id=1 AND id=?',
    runId,
  ));
  assert.equal(stored.status, '失败');
  assert.equal(stored.content_id, null);
  assert.match(stored.error, /联网检索.*可引用证据/u);
  const snapshot = JSON.parse(stored.snapshot_json);
  assert.equal(snapshot.web.required, true);
  assert.equal(snapshot.web.attempted, true);
  assert.equal(snapshot.web.verified, false);
  assert.deepEqual(snapshot.web.results, []);
  assert.equal(runWithTenant(1, () => q.get('SELECT COUNT(*) n FROM contents WHERE tenant_id=1').n), beforeContents);
  assert.equal(runWithTenant(1, () => q.get(
    `SELECT COUNT(*) n FROM credit_holds WHERE tenant_id=1 AND status='held'`,
  ).n), 0);
});

test('模型只返回模板或契约底稿时标记未完成，不进入成功、内容与资产口径', async () => {
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 4,
    contentType: '文风改写',
    claimKey: 'template-incomplete',
    userId: bossA,
  });
  const beforeContents = runWithTenant(1, () => q.get('SELECT COUNT(*) n FROM contents WHERE tenant_id=1').n);

  await assert.rejects(
    runWithTenant(1, () => executeContentAutomationRun({
      ruleId,
      runId,
      trigger: 'scheduled',
      initiatedBy: bossA,
      generateFn: async options => ({
        text: options.fallback(),
        mode: 'template',
        model: 'template',
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    })),
    /模板.*未完成/u,
  );

  const stored = runWithTenant(1, () => q.get(
    'SELECT status,content_id,snapshot_json,error FROM content_automation_runs WHERE tenant_id=1 AND id=?',
    runId,
  ));
  assert.equal(stored.status, '失败');
  assert.equal(stored.content_id, null);
  assert.match(stored.error, /模板.*未完成/u);
  const snapshot = JSON.parse(stored.snapshot_json);
  assert.equal(snapshot.contract.status, 'incomplete');
  assert.equal(snapshot.contract.valid, false);
  assert.equal(snapshot.contract.incomplete, true);
  assert.equal(snapshot.contract.requiresManualRepair, true);
  assert.deepEqual(snapshot.contract.artifacts, []);
  assert.equal(snapshot.billing.state, 'released');
  assert.equal(runWithTenant(1, () => q.get('SELECT COUNT(*) n FROM contents WHERE tenant_id=1').n), beforeContents);
  assert.equal(runWithTenant(1, () => q.get(
    'SELECT last_status FROM content_automation_rules WHERE tenant_id=1 AND id=?',
    ruleId,
  ).last_status), '未完成');
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
          next_topics: [{ title: '后续选题', reason: '延续真实数据复盘' }],
          profile_updates: ['继续保留可核验的经营数据来源'],
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

test('claim后创建者失去content权限会在供应商调用和占扣前失败并自动停用规则', async () => {
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 3,
    contentType: '文案初稿',
    claimKey: 'revoked-before-execute',
    userId: bossA,
  });
  const beforeCredits = runWithTenant(1, () => q.get('SELECT credits FROM tenants WHERE id=1').credits);
  let generateCalls = 0;
  q.run(`UPDATE users SET modules='["dashboard"]' WHERE id=?`, bossA);
  try {
    await assert.rejects(
      runWithTenant(1, () => executeContentAutomationRun({
        ruleId,
        runId,
        trigger: 'scheduled',
        initiatedBy: bossA,
        generateFn: async () => {
          generateCalls += 1;
          return {
            text: JSON.stringify(validDraftOutput()),
            mode: 'api',
            model: 'contract-test-model',
            usage: { inputTokens: 5, outputTokens: 8 },
          };
        },
      })),
      /规则创建者已失去内容生产仓模块权限/u,
    );
    assert.equal(generateCalls, 0);
    assert.equal(runWithTenant(1, () => q.get('SELECT credits FROM tenants WHERE id=1').credits), beforeCredits);
    assert.equal(runWithTenant(1, () => q.get(`SELECT COUNT(*) n FROM credit_holds
      WHERE tenant_id=1 AND ref_type='content_automation_run' AND ref_id=?`, runId).n), 0);
    const run = runWithTenant(1, () => q.get(`SELECT status,error,snapshot_json
      FROM content_automation_runs WHERE tenant_id=1 AND id=?`, runId));
    assert.equal(run.status, '失败');
    assert.match(run.error, /规则创建者已失去内容生产仓模块权限/u);
    assert.equal(JSON.parse(run.snapshot_json).entitlement.code, 'creator_content_revoked');
    const rule = runWithTenant(1, () => q.get(`SELECT enabled,next_run_at,last_status,last_error
      FROM content_automation_rules WHERE tenant_id=1 AND id=?`, ruleId));
    assert.equal(rule.enabled, 0);
    assert.equal(rule.next_run_at, null);
    assert.equal(rule.last_status, '已停用');
    assert.match(rule.last_error, /规则创建者已失去内容生产仓模块权限/u);
  } finally {
    q.run('UPDATE users SET modules=NULL WHERE id=?', bossA);
  }
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* cleanup */ }
  }
});
