import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  expectedContentEmployeeArtifactContent,
  validContentEmployeeOutput,
} from './helpers/content-output-fixtures.mjs';

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
const { resolveContentHandlerRuntimeSettings } = await import(
  '../src/engines/content-handler-runtime-context.js'
);
const { releaseHold } = await import('../src/engines/credits.js');
const { decideContentOutput } = await import('../src/engines/restaurant-output-review.js');
const { validateContentEmployeeOutputContract } = await import('../src/engines/content-output-contract.js');
const {
  loadContentAdoptionAvailability,
  loadContentDeliveryState,
} = await import('../src/engines/delivery-state.js');

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

function adoptAutomationContent(contentId, tenantId = 1, reviewerId = bossA) {
  return runWithTenant(tenantId, () => {
    const approval = q.get(`SELECT * FROM approvals
      WHERE tenant_id=? AND target_type='content' AND target_id=? AND status='待审核'
      ORDER BY id DESC LIMIT 1`, tenantId, contentId);
    assert.ok(approval, '自动内容必须产生可达的待审核审批单');
    return decideContentOutput({
      outputId: contentId,
      approvalId: approval.id,
      actor: {
        id: reviewerId,
        name: tenantId === 1 ? 'A店老板' : 'B店老板',
        role: 'boss',
        tenant_id: tenantId,
      },
      decision: 'adopt',
      reason: '已人工核验自动内容的事实、契约和发布边界。',
      tenantId,
    });
  });
}

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
  const output = validContentEmployeeOutput(0);
  output.briefing += ' [来源1]';
  output.channel_scan.forEach(item => { item.finding += ' [来源1]'; });
  output.topics.forEach(item => { item.evidence += ' [来源1]'; });
  return output;
}

function validDraftOutput() {
  return validContentEmployeeOutput(3);
}

test('首轮真实API契约失败后只返工一次，二轮合格时合并用量且只结算一次', async () => {
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 3,
    contentType: '文案初稿',
    claimKey: 'contract-retry-success',
    userId: bossA,
  });
  const calls = [];
  const result = await runWithTenant(1, () => executeContentAutomationRun({
    ruleId,
    runId,
    trigger: 'immediate',
    initiatedBy: bossA,
    generateFn: async options => {
      calls.push(options);
      if (calls.length === 1) {
        return {
          text: JSON.stringify({ title_candidates: ['只有标题，没有正文'] }),
          mode: 'api',
          model: 'contract-test-model',
          usage: { inputTokens: 11, outputTokens: 7 },
        };
      }
      return {
        text: JSON.stringify(validDraftOutput()),
        mode: 'api',
        model: 'contract-test-model',
        usage: { inputTokens: 13, outputTokens: 19 },
      };
    },
  }));

  assert.equal(result.status, '成功');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, 'content-automation');
  assert.equal(calls[1].kind, 'content-automation-contract-retry');
  assert.match(calls[1].userMsg, /撰稿人/u);
  assert.match(calls[1].userMsg, /契约化内容.*文案初稿.*只能使用已确认事实/su);
  assert.match(calls[1].userMsg, /body.*tags.*image_plan/su);
  assert.equal(result.billing.state, 'settled');
  // 无人值守产物一律停在待人工审阅：恰好1张待审单，审阅通过前
  // 不生成业务资产、不写知识库。
  assert.equal(result.contentStatus, '待审核');
  assert.equal(runWithTenant(1, () => q.get(`SELECT COUNT(*) n FROM approvals
    WHERE tenant_id=1 AND target_type='content' AND target_id=? AND status='待审核'`, result.contentId).n), 1);
  assert.equal(runWithTenant(1, () => q.get(`SELECT COUNT(*) n FROM biz_assets
    WHERE tenant_id=1 AND source_type='content' AND source_id=?`, result.contentId).n), 0);
  assert.equal(runWithTenant(1, () => q.get(`SELECT COUNT(*) n FROM kb_docs
    WHERE tenant_id=1 AND source_type='content' AND source_id=?`, result.contentId).n), 0);
  assert.equal(runWithTenant(1, () => q.get(`SELECT COUNT(*) n FROM content_publish_logs
    WHERE tenant_id=1 AND content_id=?`, result.contentId).n), 0);

  const stored = runWithTenant(1, () => q.get(
    'SELECT snapshot_json FROM content_automation_runs WHERE tenant_id=1 AND id=?',
    runId,
  ));
  const snapshot = JSON.parse(stored.snapshot_json);
  assert.equal(snapshot.qualityRetry.attempted, true);
  assert.equal(snapshot.qualityRetry.succeeded, true);
  assert.equal(snapshot.qualityRetry.retryCount, 1);
  assert.equal(snapshot.qualityRetry.attempts.length, 2);
  assert.deepEqual(snapshot.qualityRetry.totalUsage, { inputTokens: 24, outputTokens: 26 });
  assert.deepEqual(snapshot.providerAttempt.usage, { inputTokens: 24, outputTokens: 26 });
  assert.equal(snapshot.providerAttempt.attemptCount, 2);
  assert.equal(snapshot.handlerExecution.invocationCount, 2);
  assert.equal(snapshot.handlerExecution.finalHandlerId,
    'content-handler-adapter:run_draft');
  assert.equal(snapshot.handlerExecution.bindingStatus, 'bound_callable');
  assert.deepEqual(
    snapshot.handlerExecution.handlerInvocations.map(item => item.kind),
    ['initial', 'contract_retry'],
  );
  assert.ok(snapshot.handlerExecution.handlerInvocations
    .every(item => item.handlerId === 'content-handler-adapter:run_draft'));
  assert.ok(snapshot.handlerExecution.handlerInvocations
    .every(item => item.currentAdapter === 'content-handler-adapters.invoke'));
  assert.ok(snapshot.handlerExecution.handlerInvocations
    .every(item => item.provenance === 'reimplemented_verified'));
  assert.ok(snapshot.handlerExecution.handlerInvocations
    .every(item => item.completed === true && item.credentialsIncluded === false));
  assert.equal(snapshot.qualityRetry.attempts[0].mode, 'api');
  assert.equal(snapshot.qualityRetry.attempts[0].model, 'contract-test-model');
  assert.match(snapshot.qualityRetry.attempts[0].errors.join(' '), /body.*tags.*image_plan/u);
  assert.equal(Object.hasOwn(snapshot.qualityRetry.attempts[0], 'text'), false);

  const billingEvidence = runWithTenant(1, () => q.get(`SELECT
    COUNT(*) n,MAX(l.input_tokens) input_tokens,MAX(l.output_tokens) output_tokens,
    MAX(l.ai_mode) ai_mode,MAX(h.status) hold_status,MAX(h.settled_credits) settled_credits
    FROM credit_holds h JOIN credit_logs l ON l.id=h.log_id AND l.tenant_id=h.tenant_id
    WHERE h.tenant_id=1 AND h.ref_type='content_automation_run' AND h.ref_id=?`, runId));
  assert.equal(billingEvidence.n, 1);
  assert.equal(billingEvidence.input_tokens, 24);
  assert.equal(billingEvidence.output_tokens, 26);
  assert.equal(billingEvidence.ai_mode, 'api');
  assert.equal(billingEvidence.hold_status, 'settled');
  assert.ok(billingEvidence.settled_credits > 0);
});

test('复盘官首轮自造效果阈值时进入自动契约返工，改为待补基线后才成功', async () => {
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 9,
    contentType: '复盘报告',
    claimKey: 'retrospective-metric-retry',
    userId: bossA,
  });
  const calls = [];
  const fabricated = validContentEmployeeOutput(9);
  fabricated.report += '\n\n把餐饮完播率≥30%、互动率≥5%和收藏率权重40%作为行业达标线。';
  const repaired = validContentEmployeeOutput(9);
  repaired.report += '\n\n本次仅记录自动返工验收：历史基线待补，达标阈值和权重由负责人在回收真实数据后设定。';

  const result = await runWithTenant(1, () => executeContentAutomationRun({
    ruleId,
    runId,
    trigger: 'immediate',
    initiatedBy: bossA,
    generateFn: async options => {
      calls.push(options);
      return calls.length === 1
        ? {
            text: JSON.stringify(fabricated),
            mode: 'api',
            model: 'contract-test-model',
            usage: { inputTokens: 17, outputTokens: 23 },
          }
        : {
            text: JSON.stringify(repaired),
            mode: 'api',
            model: 'contract-test-model',
            usage: { inputTokens: 19, outputTokens: 29 },
          };
    },
  }));

  assert.equal(result.status, '成功');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].kind, 'content-automation-contract-retry');
  assert.match(calls[1].userMsg, /复盘指标事实门禁.*原值已脱敏/su);
  assert.match(calls[1].userMsg, /复盘数值事实全局纠错/u);
  assert.doesNotMatch(calls[1].userMsg, /30%|5%|40%/u);
  const snapshot = JSON.parse(runWithTenant(1, () => q.get(
    'SELECT snapshot_json FROM content_automation_runs WHERE tenant_id=1 AND id=?',
    runId,
  )).snapshot_json);
  assert.equal(snapshot.qualityRetry.succeeded, true);
  assert.deepEqual(snapshot.providerAttempt.usage, { inputTokens: 36, outputTokens: 52 });
  assert.match(snapshot.qualityRetry.firstErrors.join('；'), /复盘指标事实门禁/u);
  assert.doesNotMatch(snapshot.qualityRetry.firstErrors.join('；'), /30%|5%|40%/u);
});

test('复盘官首轮自造平台规则与行业因果时也必须自动返工', async () => {
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 9,
    contentType: '复盘报告',
    claimKey: 'retrospective-qualitative-retry',
    userId: bossA,
  });
  const calls = [];
  const fabricated = validContentEmployeeOutput(9);
  fabricated.report += [
    '',
    '抖音：收藏率≥完播率。视频号：转发率单列。',
    '菜品教程收藏率通常高于段子，引导提问可提升评论链长度。',
  ].join('\n');
  const repaired = validContentEmployeeOutput(9);
  repaired.report += '\n\n本次定性规则返工验收：平台权重、行业规律和提升因果均需来源核验，当前不写成结论。';

  const result = await runWithTenant(1, () => executeContentAutomationRun({
    ruleId,
    runId,
    trigger: 'immediate',
    initiatedBy: bossA,
    generateFn: async options => {
      calls.push(options);
      return calls.length === 1
        ? {
            text: JSON.stringify(fabricated),
            mode: 'api',
            model: 'contract-test-model',
            usage: { inputTokens: 31, outputTokens: 37 },
          }
        : {
            text: JSON.stringify(repaired),
            mode: 'api',
            model: 'contract-test-model',
            usage: { inputTokens: 41, outputTokens: 43 },
          };
    },
  }));

  assert.equal(result.status, '成功');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].kind, 'content-automation-contract-retry');
  assert.match(calls[1].userMsg, /复盘定性事实门禁.*原句已脱敏/su);
  assert.match(calls[1].userMsg, /复盘定性事实全局纠错/u);
  assert.doesNotMatch(calls[1].userMsg, /收藏率≥完播率|转发率单列|通常高于|可提升/u);
  const snapshot = JSON.parse(runWithTenant(1, () => q.get(
    'SELECT snapshot_json FROM content_automation_runs WHERE tenant_id=1 AND id=?',
    runId,
  )).snapshot_json);
  assert.equal(snapshot.qualityRetry.succeeded, true);
  assert.deepEqual(snapshot.providerAttempt.usage, { inputTokens: 72, outputTokens: 80 });
  assert.match(snapshot.qualityRetry.firstErrors.join('；'), /复盘定性事实门禁/u);
  assert.doesNotMatch(snapshot.qualityRetry.firstErrors.join('；'), /收藏率≥完播率|转发率单列/u);
});

test('复盘官首轮非法JSON且任务无真实指标时，返工锁定数据缺口与采集验证计划', async () => {
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 9,
    contentType: '复盘报告',
    claimKey: 'retrospective-invalid-json-no-data-retry',
    userId: bossA,
  });
  const calls = [];
  const runNineFabrication = validContentEmployeeOutput(9);
  runNineFabrication.report += [
    '',
    '复盘计划（待数据补全后执行）：按抖音收藏率优先复盘，以七天完整窗口判定流量池是否突破。',
    '视频号转发单列复盘：检查完播率与互动率是否超过硬阈值（完播率≥30%、互动率≥5%）。',
    '小红书四维得分拆解：分别计算基础质量分、互动分、商业价值分和社交关系分。',
  ].join('\n');
  const noDataPlan = {
    report: [
      '# 本周内容复盘·数据缺口版',
      '当前任务没有提供可核验的发布记录、真实效果指标、历史基线、业务目标完成情况或已核验来源，因此本轮仅完成取数准备，不形成任何内容效果判断。',
      '数据缺口包括内容标识、发布平台与时间、各观察窗口的后台指标、账号历史基线、投放与活动变量、评论样本和有效线索口径。',
      '采集计划是由负责人从各平台后台导出原始记录，同步登记来源、采集时间、统计范围和口径，并将与发布日志无法对齐的项目标记为待确认。',
      '验证计划是先核对发布记录与后台导出是否同源，再确认指标定义和统计窗口，最后由业务负责人复核。证据完整后才可进行对比、异常解释和下一轮实验设计。',
    ].join('\n\n'),
    next_topics: [
      { title: '发布记录回收清单', reason: '先建立内容与后台数据的可追溯对应关系' },
      { title: '指标口径确认流程', reason: '避免不同来源和观察窗口的数据被直接混用' },
      { title: '来源验证与实验台账', reason: '让后续每个判断都能回到原始记录和人工复核' },
    ],
    profile_updates: [],
  };

  const result = await runWithTenant(1, () => executeContentAutomationRun({
    ruleId,
    runId,
    trigger: 'immediate',
    initiatedBy: bossA,
    generateFn: async options => {
      calls.push(options);
      if (calls.length === 1) {
        return {
          text: '{"report":"# 本周内容复盘","next_topics":[{"title":"未闭合的JSON',
          mode: 'api',
          model: 'contract-test-model',
          finishReason: 'length',
          usage: { inputTokens: 43, outputTokens: 47 },
        };
      }
      if (calls.length === 2) {
        return {
          text: JSON.stringify(runNineFabrication),
          mode: 'api',
          model: 'contract-test-model',
          finishReason: 'stop',
          usage: { inputTokens: 53, outputTokens: 59 },
        };
      }
      const combinedPrompt = `${options.system}\n${options.userMsg}`;
      const promptHasSafeMode = [
        /复盘官无数据安全返工模式/u,
        /指标计划.*预测性.*T\+1/su,
        /禁止复述历史技能/u,
        /平台算法.*行业规律.*具体阈值/su,
        /不得输出Markdown围栏/u,
        /复盘定性事实全局纠错.*复盘数值事实全局纠错/su,
      ].every(pattern => pattern.test(combinedPrompt));
      return {
        text: JSON.stringify(promptHasSafeMode ? noDataPlan : runNineFabrication),
        mode: 'api',
        model: 'contract-test-model',
        finishReason: 'stop',
        usage: { inputTokens: 61, outputTokens: 67 },
      };
    },
  }));

  assert.equal(result.status, '成功');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.maxTokens), [5000, 5000, 5000]);
  assert.match(calls[0].system, /【内部岗位执行模板】/u);
  assert.match(calls[0].system, /复盘官无数据安全返工模式/u);
  assert.doesNotMatch(calls[0].userMsg, /【内部岗位执行模板】/u);
  assert.equal(calls[1].kind, 'content-automation-contract-retry');
  assert.equal(calls[2].kind, 'content-automation-contract-retry');
  assert.match(calls[1].userMsg, /输出不是有效 JSON/u);
  assert.match(calls[2].userMsg, /复盘定性事实全局纠错.*复盘数值事实全局纠错/su);
  assert.doesNotMatch(calls[2].userMsg, /30%|5%|40%|收藏率≥完播率|转发率单列|四维得分/u);
  assert.match(calls[1].system, /无真实指标或已核验来源.*发布后复盘计划与预测性复盘/su);
  const snapshot = JSON.parse(runWithTenant(1, () => q.get(
    'SELECT snapshot_json FROM content_automation_runs WHERE tenant_id=1 AND id=?',
    runId,
  )).snapshot_json);
  assert.equal(snapshot.qualityRetry.succeeded, true);
  assert.equal(snapshot.qualityRetry.retryCount, 2);
  assert.match(snapshot.qualityRetry.firstErrors.join('；'), /输出不是有效 JSON/u);
  assert.equal(snapshot.qualityRetry.attempts[0].finishReason, 'length');
  assert.equal(snapshot.qualityRetry.attempts[0].truncated, true);
  assert.equal(snapshot.qualityRetry.attempts[1].finishReason, 'stop');
  assert.equal(snapshot.qualityRetry.attempts[2].finishReason, 'stop');
  assert.equal(snapshot.qualityRetry.attempts.every(attempt => attempt.requestedMaxTokens === 5000), true);
  assert.equal(snapshot.qualityRetry.attempts.slice(1).every(attempt => attempt.truncated === false), true);
  assert.deepEqual(snapshot.providerAttempt.usage, { inputTokens: 157, outputTokens: 173 });
});

test('超过20条契约错误时按类别抽样，结构与复盘定性/数值事实门禁同时进入返工', async () => {
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 9,
    contentType: '复盘报告',
    claimKey: 'retrospective-error-category-sampling',
    userId: bossA,
  });
  const noisy = validContentEmployeeOutput(9);
  noisy.report += [
    '',
    '抖音收藏率权重变化，下一轮应直接按平台算法调整。',
    '把完播率30%和互动率5%作为固定达标阈值。',
  ].join('\n');
  noisy.next_topics = Array.from({ length: 5 }, (_unused, index) => ({
    title: '短',
    reason: '短',
    [`extra_${index}`]: '未知字段',
  }));
  noisy.profile_updates = Array.from({ length: 5 }, () => '短');
  noisy.extra_top_level = '未知顶层字段';
  const rawAssessment = validateContentEmployeeOutputContract(9, noisy, {
    requirement: '只能使用已确认事实',
  });
  assert.ok(rawAssessment.errors.length > 20, `实际错误数：${rawAssessment.errors.length}`);
  assert.ok(rawAssessment.errors.findIndex(error => /复盘定性事实门禁/u.test(error)) >= 12);
  assert.ok(rawAssessment.errors.findIndex(error => /复盘指标事实门禁/u.test(error)) >= 12);

  const calls = [];
  const result = await runWithTenant(1, () => executeContentAutomationRun({
    ruleId,
    runId,
    trigger: 'immediate',
    initiatedBy: bossA,
    generateFn: async options => {
      calls.push(options);
      if (calls.length === 1) {
        return {
          text: JSON.stringify(noisy),
          mode: 'api',
          model: 'contract-test-model',
          usage: { inputTokens: 71, outputTokens: 73 },
        };
      }
      assert.match(options.userMsg, /结构字段全局纠错/u);
      assert.match(options.userMsg, /复盘定性事实全局纠错/u);
      assert.match(options.userMsg, /复盘数值事实全局纠错/u);
      assert.match(options.userMsg, /复盘定性事实门禁/u);
      assert.match(options.userMsg, /复盘指标事实门禁/u);
      const repaired = validContentEmployeeOutput(9);
      repaired.report += '\n\n本条仅用于验证错误类别抽样后的安全返工链路。';
      return {
        text: JSON.stringify(repaired),
        mode: 'api',
        model: 'contract-test-model',
        usage: { inputTokens: 79, outputTokens: 83 },
      };
    },
  }));

  assert.equal(result.status, '成功');
  assert.equal(calls.length, 2);
  const snapshot = JSON.parse(runWithTenant(1, () => q.get(
    'SELECT snapshot_json FROM content_automation_runs WHERE tenant_id=1 AND id=?',
    runId,
  )).snapshot_json);
  assert.ok(snapshot.qualityRetry.firstErrors.length <= 12);
  assert.match(snapshot.qualityRetry.firstErrors.join('；'), /字段|未知/u);
  assert.match(snapshot.qualityRetry.firstErrors.join('；'), /复盘定性事实门禁/u);
  assert.match(snapshot.qualityRetry.firstErrors.join('；'), /复盘指标事实门禁/u);
});

test('三轮真实API契约均失败时保存安全诊断并全额退款，绝不生成内容、资产或知识库素材', async () => {
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
      generateFn: async options => {
        generateCalls += 1;
        if (generateCalls === 2) {
          assert.equal(options.kind, 'content-automation-contract-retry');
          assert.match(options.userMsg, /撰稿人/u);
          assert.match(options.userMsg, /body.*tags.*image_plan/su);
        }
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
  assert.equal(generateCalls, 3);
  assert.equal(stored.status, '失败');
  assert.equal(stored.content_id, null);
  assert.match(stored.error, /输出契约校验未通过/u);
  const snapshot = JSON.parse(stored.snapshot_json);
  assert.equal(snapshot.identity.idx, 3);
  assert.equal(snapshot.contract.status, 'invalid');
  assert.equal(snapshot.contract.valid, false);
  assert.equal(snapshot.contract.requiresManualRepair, true);
  assert.match(snapshot.contract.errors.join(' '), /body.*tags.*image_plan/u);
  assert.equal(snapshot.contract.previewMarkdown, '');
  assert.deepEqual(snapshot.contract.artifacts, []);
  assert.equal(snapshot.qualityRetry.attempted, true);
  assert.equal(snapshot.qualityRetry.succeeded, false);
  assert.equal(snapshot.qualityRetry.retryCount, 2);
  assert.equal(snapshot.qualityRetry.attempts.length, 3);
  assert.equal(snapshot.handlerExecution.invocationCount, 3);
  assert.deepEqual(
    snapshot.handlerExecution.handlerInvocations.map(item => item.kind),
    ['initial', 'contract_retry', 'contract_retry'],
  );
  assert.ok(snapshot.handlerExecution.handlerInvocations
    .every(item => item.handlerId === 'content-handler-adapter:run_draft'));
  assert.ok(snapshot.handlerExecution.handlerInvocations
    .every(item => item.bindingStatus === 'bound_callable'));
  assert.deepEqual(snapshot.qualityRetry.totalUsage, { inputTokens: 15, outputTokens: 9 });
  assert.deepEqual(snapshot.providerAttempt.usage, { inputTokens: 15, outputTokens: 9 });
  assert.equal(snapshot.qualityRetry.attempts.every(attempt => !Object.hasOwn(attempt, 'text')), true);
  assert.equal(snapshot.billing.state, 'released');
  assert.equal(snapshot.billing.chargedCredits, 0);
  assert.equal(runWithTenant(1, () => q.get('SELECT COUNT(*) n FROM contents WHERE tenant_id=1').n), beforeContents);
  assert.equal(runWithTenant(1, () => q.get('SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=1').n), beforeAssets);
  assert.equal(runWithTenant(1, () => q.get('SELECT COUNT(*) n FROM kb_docs WHERE tenant_id=1').n), beforeKb);
  assert.equal(runWithTenant(1, () => q.get('SELECT credits FROM tenants WHERE id=1').credits), beforeCredits);
  assert.equal(runWithTenant(1, () => q.get(
    `SELECT COUNT(*) n FROM credit_holds WHERE tenant_id=1 AND status='held'`,
  ).n), 0);
  const released = runWithTenant(1, () => q.get(`SELECT
    COUNT(*) n,MAX(l.credits) credits,MAX(l.input_tokens) input_tokens,
    MAX(l.output_tokens) output_tokens,MAX(h.settled_credits) settled_credits
    FROM credit_holds h JOIN credit_logs l ON l.id=h.log_id AND l.tenant_id=h.tenant_id
    WHERE h.tenant_id=1 AND h.ref_type='content_automation_run' AND h.ref_id=?`, runId));
  assert.equal(released.n, 1);
  assert.equal(released.credits, 0);
  assert.equal(released.input_tokens, 0);
  assert.equal(released.output_tokens, 0);
  assert.equal(released.settled_credits, 0);
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
  assert.equal(generateCalls, 3);
});

test('合规低风险输出结算后仍停待人工审阅，审阅前不进资产与知识库且租户仍隔离', async () => {
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 9,
    contentType: '复盘报告',
    claimKey: 'valid-output',
    userId: bossA,
  });
  const validOutput = validContentEmployeeOutput(9);
  const renderedOutput = expectedContentEmployeeArtifactContent(9);
  const result = await runWithTenant(1, () => executeContentAutomationRun({
    ruleId,
    runId,
    trigger: 'immediate',
    initiatedBy: bossA,
    generateFn: async options => {
      assert.match(options.system, /当前岗位最终输出契约/u);
      assert.match(options.system, /"report".*"next_topics".*"profile_updates"/su);
      assert.doesNotMatch(options.userMsg, /当前岗位最终输出契约/u);
      return {
        text: JSON.stringify(validOutput),
        mode: 'api',
        model: 'contract-test-model',
        usage: { inputTokens: 5, outputTokens: 8 },
      };
    },
  }));

  assert.equal(result.status, '成功');
  // 自动化产物强制停待人工审阅：状态待审核 + 恰好1张待审单；
  // 审阅采纳前不得进资产、不得写知识库。
  assert.equal(result.contentStatus, '待审核');
  assert.equal(result.contract.status, 'valid');
  assert.equal(result.contract.valid, true);
  assert.equal(result.billing.state, 'settled');
  assert.ok(result.billing.chargedCredits > 0);
  assert.equal(result.contract.artifacts[0].kind, 'markdown');
  const content = runWithTenant(1, () => q.get(
    'SELECT body,status FROM contents WHERE tenant_id=1 AND id=?',
    result.contentId,
  ));
  assert.equal(content.status, '待审核');
  assert.equal(content.body, renderedOutput);
  assert.equal(runWithTenant(1, () => q.get(`SELECT COUNT(*) n FROM approvals
    WHERE tenant_id=1 AND target_type='content' AND target_id=? AND status='待审核'`, result.contentId).n), 1);
  assert.equal(runWithTenant(1, () => q.get(`SELECT COUNT(*) n FROM biz_assets
    WHERE tenant_id=1 AND source_type='content' AND source_id=?`, result.contentId).n), 0);
  assert.equal(runWithTenant(1, () => q.get(`SELECT COUNT(*) n FROM kb_docs
    WHERE tenant_id=1 AND body=?`, renderedOutput).n), 0);
  assert.equal(runWithTenant(1, () => q.get(`SELECT COUNT(*) n FROM content_publish_logs
    WHERE tenant_id=1 AND content_id=?`, result.contentId).n), 0);

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
  assert.equal(snapshot.contract.previewMarkdown, renderedOutput);
  assert.equal(snapshot.contract.artifacts.length, 1);
  assert.equal(snapshot.contract.artifacts[0].content, renderedOutput);
  assert.equal(snapshot.contract.artifacts[0].employeeIdx, 9);
  assert.deepEqual(snapshot.contract.parsedOutput.fields.next_topics, validOutput.next_topics);
  assert.deepEqual(snapshot.contract.parsedOutput.fields.profile_updates, validOutput.profile_updates);
  assert.match(snapshot.contract.parsedOutput.fields.report.contentSha256, /^[a-f0-9]{64}$/u);
  assert.equal(snapshot.contract.parsedOutput.fields.report.characterCount, [...validOutput.report].length);
  assert.equal(JSON.stringify(snapshot.contract.parsedOutput).includes(validOutput.report), false);
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
  assert.equal(captured.maxTokens, 3200);
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
  const webQueries = [];
  let generateCalls = 0;
  const result = await runWithTenant(1, () => executeContentAutomationRun({
    ruleId,
    runId,
    trigger: 'immediate',
    initiatedBy: bossA,
    webSearchFn: async (query, options) => {
      webCalls += 1;
      webQueries.push(query);
      assert.equal(options.max, 3);
      assert.equal(options.timeoutMs, 9000);
      assert.match(query, /趋势简报.*契约化内容/su);
      return {
        ok: true,
        provider: 'stub-search',
        note: '测试证据',
        results: [{
          title: `官方资料${webCalls}`,
          url: `https://example.test/official-${webCalls}`,
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
  assert.equal(webCalls, 12);
  for (const channel of [
    '微博热搜', '抖音热点', '小红书热门', '知乎热榜', 'B站热门', '百度热搜',
    '今日头条', '36氪/虎嗅', '少数派/爱范儿', 'X(Twitter)趋势', 'Google News',
    'Product Hunt/HackerNews',
  ]) {
    assert.equal(webQueries.filter(query => query.includes(channel)).length, 1, channel);
  }
  assert.equal(generateCalls, 1);
  const snapshot = JSON.parse(runWithTenant(1, () => q.get(
    'SELECT snapshot_json FROM content_automation_runs WHERE tenant_id=1 AND id=?',
    runId,
  )).snapshot_json);
  assert.equal(snapshot.web.required, true);
  assert.equal(snapshot.web.attempted, true);
  assert.equal(snapshot.web.verified, true);
  assert.equal(snapshot.web.fullCoverage, true);
  assert.equal(snapshot.web.degraded, false);
  assert.equal(snapshot.web.provider, 'stub-search');
  assert.equal(snapshot.web.results.length, 12);
  assert.equal(snapshot.web.queryPlan.length, 12);
  assert.equal(snapshot.web.channelCalls.length, 12);
  assert.equal(snapshot.web.coverage.plannedChannels, 12);
  assert.equal(snapshot.web.coverage.verifiedChannels, 12);
  assert.equal(snapshot.web.queryPlan.every(item => item.queryTextIncluded === false), true);
  assert.equal(snapshot.web.queryPlan.some(item => Object.hasOwn(item, 'query')), false);
  assert.equal(snapshot.web.channelCalls.every(item => item.resultCount === 1), true);
  assert.equal(snapshot.web.results[0].url, 'https://example.test/official-1');
});

test('逐渠道检索部分失败时只把真实返回交给模型，并如实标记覆盖降级', async () => {
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 0,
    contentType: '趋势简报',
    claimKey: 'web-channel-partial-evidence',
    userId: bossA,
  });
  let webCalls = 0;
  let generateCalls = 0;
  const result = await runWithTenant(1, () => executeContentAutomationRun({
    ruleId,
    runId,
    trigger: 'scheduled',
    initiatedBy: bossA,
    webSearchFn: async query => {
      webCalls += 1;
      if (query.includes('微博热搜')) {
        return {
          ok: true,
          provider: 'stub-search',
          results: [{
            title: '微博真实来源',
            url: 'https://example.test/weibo-real',
            snippet: '可核验的微博渠道事实',
          }],
        };
      }
      if (query.includes('抖音热点')) {
        return {
          ok: true,
          provider: 'stub-search',
          results: [{
            title: '抖音真实来源',
            url: 'https://example.test/douyin-real',
            snippet: '可核验的抖音渠道事实',
          }],
        };
      }
      if (query.includes('小红书热门')) {
        throw new Error('sk-test-secret-must-not-persist 渠道服务超时');
      }
      return { ok: true, provider: 'stub-search', note: '该渠道无命中', results: [] };
    },
    generateFn: async options => {
      generateCalls += 1;
      assert.match(options.userMsg, /微博真实来源.*weibo-real/su);
      assert.match(options.userMsg, /抖音真实来源.*douyin-real/su);
      assert.doesNotMatch(options.userMsg, /渠道服务超时|test-secret|该渠道无命中/u);
      return {
        text: JSON.stringify(validTrendOutput()),
        mode: 'api',
        model: options.model,
        usage: { inputTokens: 8, outputTokens: 16 },
      };
    },
  }));

  assert.equal(result.status, '成功');
  assert.equal(webCalls, 12);
  assert.equal(generateCalls, 1);
  const snapshot = JSON.parse(runWithTenant(1, () => q.get(
    'SELECT snapshot_json FROM content_automation_runs WHERE tenant_id=1 AND id=?',
    runId,
  )).snapshot_json);
  assert.equal(snapshot.web.verified, true);
  assert.equal(snapshot.web.fullCoverage, false);
  assert.equal(snapshot.web.degraded, true);
  assert.equal(snapshot.web.coverage.plannedChannels, 12);
  assert.equal(snapshot.web.coverage.attemptedChannels, 12);
  assert.equal(snapshot.web.coverage.verifiedChannels, 2);
  assert.equal(snapshot.web.results.length, 2);
  const failed = snapshot.web.channelCalls.find(call => call.channel === '小红书热门');
  assert.equal(failed.ok, false);
  assert.equal(failed.verified, false);
  assert.equal(failed.failure.rawMessageIncluded, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /test-secret-must-not-persist/u);
});

test('拆解师按Paihuo benchmark.targets逐目标渠道真实调用并记录查询计划', async () => {
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 2,
    contentType: '爆款拆解',
    claimKey: 'benchmark-target-channel-calls',
    userId: bossA,
  });
  const queries = [];
  await assert.rejects(
    runWithTenant(1, () => executeContentAutomationRun({
      ruleId,
      runId,
      trigger: 'immediate',
      initiatedBy: bossA,
      resolveRuntimeSettingsFn: (profile, config) => {
        const resolved = resolveContentHandlerRuntimeSettings(profile, config);
        return {
          ...resolved,
          benchmark: {
            ...resolved.benchmark,
            targets: [
              { name: '对标品牌A', platform: '小红书' },
              { name: '对标账号B', platform: '抖音' },
            ],
          },
        };
      },
      webSearchFn: async query => {
        queries.push(query);
        return {
          ok: true,
          provider: 'stub-search',
          results: [{
            title: `真实对标来源${queries.length}`,
            url: `https://example.test/benchmark-${queries.length}`,
            snippet: query,
          }],
        };
      },
      generateFn: async () => {
        throw new Error('intentional benchmark model stop');
      },
    })),
    /intentional benchmark model stop/u,
  );

  assert.equal(queries.length, 2);
  assert.equal(queries.some(query => query.includes('小红书') && query.includes('对标品牌A')), true);
  assert.equal(queries.some(query => query.includes('抖音') && query.includes('对标账号B')), true);
  const stored = runWithTenant(1, () => q.get(
    'SELECT status,snapshot_json FROM content_automation_runs WHERE tenant_id=1 AND id=?',
    runId,
  ));
  assert.equal(stored.status, '失败');
  const snapshot = JSON.parse(stored.snapshot_json);
  assert.equal(snapshot.web.queryPlan.length, 2);
  assert.deepEqual(snapshot.web.queryPlan.map(item => item.channel), ['小红书', '抖音']);
  assert.deepEqual(snapshot.web.queryPlan.map(item => item.target), ['对标品牌A', '对标账号B']);
  assert.equal(snapshot.web.queryPlan.every(item => item.settingsField === 'targets'), true);
  assert.equal(snapshot.web.channelCalls.every(item => item.verified === true), true);
  assert.equal(snapshot.web.configurationFallback, false);
});

test('强制联网岗位检索失败或没有证据时失败，不调用模型也不冒充正常完成', async () => {
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 1,
    contentType: '事实资料包',
    claimKey: 'web-evidence-failure',
    userId: bossA,
  });
  const beforeContents = runWithTenant(1, () => q.get('SELECT COUNT(*) n FROM contents WHERE tenant_id=1').n);
  let webCalls = 0;
  const webQueries = [];
  let generateCalls = 0;

  await assert.rejects(
    runWithTenant(1, () => executeContentAutomationRun({
      ruleId,
      runId,
      trigger: 'scheduled',
      initiatedBy: bossA,
      webSearchFn: async query => {
        webCalls += 1;
        webQueries.push(query);
        assert.match(query, /事实资料包.*契约化内容/su);
        return {
          ok: true,
          provider: 'stub-search',
          note: '上游返回空结果',
          results: [],
        };
      },
      generateFn: async () => {
        generateCalls += 1;
        return { text: '{}', mode: 'api', model: '不应调用', usage: {} };
      },
    })),
    /联网检索.*可引用证据/u,
  );

  assert.equal(webCalls, 5);
  for (const channel of [
    '权威媒体报道', '行业报告/白皮书', '知乎深度回答', '官方数据/统计局', '海外媒体(英文源)',
  ]) {
    assert.equal(webQueries.filter(query => query.includes(channel)).length, 1, channel);
  }
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
  assert.equal(snapshot.web.degraded, true);
  assert.equal(snapshot.web.queryPlan.length, 5);
  assert.equal(snapshot.web.channelCalls.length, 5);
  assert.equal(snapshot.web.coverage.verifiedChannels, 0);
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
  let generateCalls = 0;

  await assert.rejects(
    runWithTenant(1, () => executeContentAutomationRun({
      ruleId,
      runId,
      trigger: 'scheduled',
      initiatedBy: bossA,
      generateFn: async options => {
        generateCalls += 1;
        return {
          text: options.fallback(),
          mode: 'template',
          model: 'template',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    })),
    /模板.*未完成/u,
  );

  const stored = runWithTenant(1, () => q.get(
    'SELECT status,content_id,snapshot_json,error FROM content_automation_runs WHERE tenant_id=1 AND id=?',
    runId,
  ));
  assert.equal(stored.status, '失败');
  assert.equal(generateCalls, 1);
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

test('降级通道即使返回完整JSON也不能返工或冒充真实API成功', async () => {
  const { ruleId, runId } = createRuleAndRun(1, {
    employeeIdx: 3,
    contentType: '文案初稿',
    claimKey: 'fallback-incomplete',
    userId: bossA,
  });
  const beforeCredits = runWithTenant(1, () => q.get('SELECT credits FROM tenants WHERE id=1').credits);
  let generateCalls = 0;

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
          mode: 'fallback',
          model: 'fallback',
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    })),
    /降级.*未完成|真实云API.*未完成/u,
  );

  assert.equal(generateCalls, 1);
  const stored = runWithTenant(1, () => q.get(
    'SELECT status,content_id,snapshot_json FROM content_automation_runs WHERE tenant_id=1 AND id=?',
    runId,
  ));
  assert.equal(stored.status, '失败');
  assert.equal(stored.content_id, null);
  const snapshot = JSON.parse(stored.snapshot_json);
  assert.equal(snapshot.contract.status, 'incomplete');
  assert.equal(snapshot.contract.valid, false);
  assert.equal(snapshot.providerAttempt.attemptCount, 1);
  assert.equal(snapshot.providerAttempt.mode, 'fallback');
  assert.equal(snapshot.qualityRetry, null);
  assert.equal(snapshot.billing.state, 'released');
  assert.equal(runWithTenant(1, () => q.get('SELECT credits FROM tenants WHERE id=1').credits), beforeCredits);
});

test('api标记但模板模型或零Token同样被真实交付门禁拦截，不进入契约返工', async () => {
  const cases = [
    {
      key: 'api-template-model',
      model: 'template',
      usage: { inputTokens: 7, outputTokens: 9 },
      violation: 'model_not_real',
    },
    {
      key: 'api-zero-usage',
      model: 'contract-test-model',
      usage: { inputTokens: 0, outputTokens: 0 },
      violation: 'usage_missing',
    },
  ];
  for (const item of cases) {
    const { ruleId, runId } = createRuleAndRun(1, {
      employeeIdx: 3,
      contentType: '文案初稿',
      claimKey: item.key,
      userId: bossA,
    });
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
            text: JSON.stringify(validDraftOutput()),
            mode: 'api',
            model: item.model,
            usage: item.usage,
          };
        },
      })),
      /真实云API.*未完成|模板.*未完成/u,
    );
    assert.equal(generateCalls, 1);
    const stored = runWithTenant(1, () => q.get(
      'SELECT status,content_id,snapshot_json FROM content_automation_runs WHERE tenant_id=1 AND id=?',
      runId,
    ));
    const snapshot = JSON.parse(stored.snapshot_json);
    assert.equal(stored.status, '失败');
    assert.equal(stored.content_id, null);
    assert.equal(snapshot.contract.status, 'incomplete');
    assert.equal(snapshot.qualityRetry, null);
    assert.equal(snapshot.providerAttempt.attemptCount, 1);
    assert.match(snapshot.providerAttempt.attempts[0].errors.join('；'), new RegExp(item.violation, 'u'));
    assert.equal(snapshot.billing.state, 'released');
    assert.equal(runWithTenant(1, () => q.get('SELECT credits FROM tenants WHERE id=1').credits), beforeCredits);
  }
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
        text: JSON.stringify(validContentEmployeeOutput(9)),
        mode: 'api',
        model: 'contract-test-model',
        usage: { inputTokens: 5, outputTokens: 8 },
      }),
    }));
    assert.equal(result.status, '成功');
    assert.ok(result.contentId);
    assert.equal(result.billing.state, 'pending_reconciliation');
    assert.equal(result.billing.chargedCredits, null);
    assert.equal(result.kbCat, null);
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
    const delivery = runWithTenant(1, () => loadContentDeliveryState(result.contentId));
    assert.equal(delivery.eligible, false);
    assert.equal(delivery.code, 'DELIVERY_BILLING_UNSETTLED');
    assert.equal(runWithTenant(1, () => loadContentAdoptionAvailability(result.contentId).canAdopt), false);
    assert.equal(runWithTenant(1, () => q.get(`SELECT COUNT(*) n FROM biz_assets
      WHERE tenant_id=1 AND source_type='content' AND source_id=?`, result.contentId).n), 0);
    assert.equal(runWithTenant(1, () => q.get(`SELECT COUNT(*) n FROM kb_docs
      WHERE tenant_id=1 AND source_type='content' AND source_id=? AND enabled=1`, result.contentId).n), 0);
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
