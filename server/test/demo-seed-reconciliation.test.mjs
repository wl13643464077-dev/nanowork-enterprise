import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DBP = path.join(os.tmpdir(), `nanowork-demo-reconciliation-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) fs.rmSync(file, { force: true });

process.env.NANOWORK_DB = DBP;
process.env.NODE_ENV = 'test';
process.env.SEED_DEMO = 'false';
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { db, q } = await import('../src/db.js');
const {
  reconcileDemoSeedPlaceholders,
  reconcileDemoSeedPlaceholdersAcrossTenants,
  seed,
} = await import('../src/seed.js');
const { creditTenant, holdCredits } = await import('../src/engines/credits.js');

seed();

after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) fs.rmSync(file, { force: true });
});

function employee(idx) {
  const row = q.get(`SELECT id,marshal_id FROM specialists WHERE employee_idx=?`, idx);
  assert.ok(row, `missing employee ${idx}`);
  return row;
}

function user(username) {
  const row = q.get(`SELECT id FROM users WHERE tenant_id=1 AND username=?`, username);
  assert.ok(row, `missing user ${username}`);
  return row;
}

function legacyOutput(title) {
  return Number(q.run(`INSERT INTO contents(
    type,title,body,status,ai_mode,creator_id,marshal_id
  ) VALUES('员工产出',?,?,'待审核','template',?,?)`,
  title,
  `【待企业核验的岗位交付草案】\n${title}\n本记录只是旧演示占位。`,
  user('yunying').id,
  employee(101).marshal_id).lastInsertRowid);
}

function legacyTask({ idx, title, status, outputId = null, creator = 'yunying', webSnapshot = null }) {
  const specialist = employee(idx);
  return Number(q.run(`INSERT INTO agent_tasks(
    marshal_id,specialist_id,title,type,requirement,status,output_id,created_by,employee_web_snapshot
  ) VALUES(?,?,?,'演示占位','旧种子占位',?,?,?,?)`,
  specialist.marshal_id,
  specialist.id,
  title,
  status,
  outputId,
  user(creator).id,
  webSnapshot).lastInsertRowid);
}

test('新演示种子不伪造数字员工运行、审批或模板资产', () => {
  assert.equal(q.get(`SELECT data_mode FROM tenants WHERE id=1`).data_mode, 'demo');
  assert.equal(q.get(`SELECT COUNT(*) n FROM agent_tasks WHERE tenant_id=1`).n, 0);
  assert.equal(q.get(`SELECT COUNT(*) n FROM content_employee_runs WHERE tenant_id=1`).n, 0);
  assert.equal(q.get(`SELECT COUNT(*) n FROM approvals WHERE tenant_id=1`).n, 0);
  assert.equal(q.get(`SELECT COUNT(*) n FROM contents c
    JOIN approvals a ON a.tenant_id=c.tenant_id AND a.target_type='content' AND a.target_id=c.id
    WHERE c.tenant_id=1 AND c.status='待审核' AND a.status='待审核'
      AND (c.ai_mode='template' OR c.ai_mode LIKE '%fallback%' OR c.ai_mode LIKE '%failed%')`).n, 0,
  '新演示库不得生成只能驳回、不能通过的占位审批');
  assert.equal(q.get(`SELECT COUNT(*) n FROM contents
    WHERE tenant_id=1 AND status<>'草稿'`).n, 0);
  assert.equal(q.get(`SELECT COUNT(*) n FROM biz_assets a JOIN contents c
    ON c.tenant_id=a.tenant_id AND c.id=a.source_id
    WHERE a.tenant_id=1 AND a.source_type='content' AND c.ai_mode='template'
      AND a.status='使用中'`).n, 0);

  assert.equal(q.get(`SELECT COUNT(*) n FROM tasks t
    WHERE t.tenant_id=1 AND t.status='待审核'
      AND NOT EXISTS (
        SELECT 1 FROM task_submissions s
        WHERE s.tenant_id=t.tenant_id AND s.task_id=t.id AND s.result='待审核'
      )`).n, 0, '待审核演示任务必须存在待审核提交');
  assert.equal(q.get(`SELECT COUNT(*) n FROM tasks t
    WHERE t.tenant_id=1 AND t.status='已完成'
      AND NOT EXISTS (
        SELECT 1 FROM task_submissions s
        WHERE s.tenant_id=t.tenant_id AND s.task_id=t.id AND s.result='通过'
      )`).n, 0, '已完成演示任务必须存在通过提交');
  assert.equal(q.get(`SELECT COUNT(*) n FROM task_submissions s JOIN tasks t
    ON t.tenant_id=s.tenant_id AND t.id=s.task_id
    WHERE t.tenant_id=1
      AND ((t.status='待审核' AND s.result<>'待审核')
        OR (t.status='已完成' AND s.result<>'通过'))`).n, 0,
  '种子提交结果不得与任务终态相互矛盾');
});

test('旧演示占位修复幂等，且保护 hold、供应商快照与真实审批', () => {
  const seededCompletedTask = q.get(`SELECT t.id FROM tasks t
    WHERE t.tenant_id=1 AND t.status='已完成' AND t.assigned_by IS NULL
    ORDER BY t.id LIMIT 1`);
  const seededPendingTask = q.get(`SELECT t.id FROM tasks t
    WHERE t.tenant_id=1 AND t.status='待审核' AND t.assigned_by IS NULL
    ORDER BY t.id LIMIT 1`);
  assert.ok(seededCompletedTask && seededPendingTask);
  q.run(`UPDATE task_submissions SET result='待审核'
    WHERE tenant_id=1 AND task_id=?`, seededCompletedTask.id);
  q.run(`UPDATE task_submissions SET result='通过'
    WHERE tenant_id=1 AND task_id=?`, seededPendingTask.id);

  const protectedManualTaskId = Number(q.run(`INSERT INTO tasks(
    title,detail,type,status,priority,assignee_id,assigned_by,due_at,source,created_at
  ) VALUES('社区联名活动议程初稿','用户真实任务','活动','待审核','高',?,?,
    '2026-07-31 18:00:00','手动','2026-07-31 09:15:00')`,
  user('sales1').id, user('guan').id).lastInsertRowid);
  const protectedSubmissionId = Number(q.run(`INSERT INTO task_submissions(
    task_id,user_id,content,result,reviewer_id,reviewed_at,review_reason
  ) VALUES(?,?,?,'通过',?,datetime('now','localtime'),'用户已完成真实审核')`,
  protectedManualTaskId, user('sales1').id, '真实业务提交', user('guan').id).lastInsertRowid);

  const invalidResultMd = '# 旧版无效待审产出\n这段正文未通过岗位输出契约。';
  const invalidRunSnapshot = {
    schemaVersion: 'content-employee-run-snapshot.v1',
    contractValid: false,
    contractErrors: ['旧版产物结构不完整'],
    previewMarkdown: invalidResultMd,
    artifacts: [],
    providerAttempt: {
      mode: 'api',
      model: 'deepseek-v4-flash',
      attemptCount: 1,
      usage: { inputTokens: 120, outputTokens: 80 },
    },
    billing: {
      state: 'released',
      estimatedCredits: 10,
      chargedCredits: 0,
      balance: 990,
      model: 'deepseek-v4-flash',
      note: '契约未通过，预授权已释放',
    },
    workConfig: { effective: { approvalMode: '管理者审核' } },
  };
  const inconsistentContentRunId = Number(q.run(`INSERT INTO content_employee_runs(
    employee_idx,employee_key,employee_name,employee_group,title,type,requirement,status,
    result_md,ai_mode,model,profile_version,prompt_hash,snapshot_json,created_by
  ) VALUES(3,'distribution','分发官','内容生产部','旧版无效待审任务','岗位交付','演示对账测试',
    '待审阅',?,'api','deepseek-v4-flash','legacy-v1','legacy-hash',?,?)`,
  invalidResultMd, JSON.stringify(invalidRunSnapshot), user('yunying').id).lastInsertRowid);

  const validPendingSnapshot = {
    schemaVersion: 'content-employee-run-snapshot.v1',
    contractValid: true,
    contractErrors: [],
    previewMarkdown: '# 合格待审产出',
    artifacts: [],
    billing: {
      state: 'settled',
      estimatedCredits: 10,
      chargedCredits: 8,
      balance: 982,
      model: 'deepseek-v4-flash',
    },
    workConfig: { effective: { approvalMode: '管理者审核' } },
  };
  const validPendingContentRunId = Number(q.run(`INSERT INTO content_employee_runs(
    employee_idx,employee_key,employee_name,employee_group,title,type,requirement,status,
    result_md,ai_mode,model,profile_version,prompt_hash,snapshot_json,created_by
  ) VALUES(4,'growth','增长官','内容生产部','真实合格待审任务','岗位交付','保护真实待审任务',
    '待审阅','# 合格待审产出','api','deepseek-v4-flash','current-v1','current-hash',?,?)`,
  JSON.stringify(validPendingSnapshot), user('yunying').id).lastInsertRowid);

  const automationRuleId = Number(q.run(`INSERT INTO content_automation_rules(
    name,enabled,employee_idx,topic,requirement,content_type,content_count,frequency,
    run_time,approval_mode,created_by
  ) VALUES('旧演示质量对账',1,0,'旧演示热点','仅用于升级回归','热点扫描',1,'daily','08:00','always',?)`,
  user('yunying').id).lastInsertRowid);

  const insertAutomationQualityBundle = (label, {
    mode = 'template',
    sourceType = null,
    sourceId = null,
    downstream = false,
    reviewed = false,
  } = {}) => {
    const snapshot = {
      schemaVersion: 'content-automation-snapshot.v1',
      execution: { mode, attempted: false },
      contract: { valid: false, errors: ['模板底稿不是合格交付'] },
    };
    const contentId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,ai_mode,creator_id,content_employee_idx,content_employee_key,
      content_employee_name,content_employee_group,content_run_mode,profile_version,prompt_hash,
      snapshot_json,source_type,source_id
    ) VALUES('员工产出',?,?, '待审核',?, ?,0,'trend','趋势官','内容生产部',
      'automation_scheduled','content-0-r0','legacy-automation-hash',?,?,?)`,
    label, `# ${label}\n当前没有可用AI通道，本记录只是未完成底稿。`, mode,
    user('yunying').id, JSON.stringify(snapshot), sourceType, sourceId).lastInsertRowid);
    if (reviewed) {
      q.run(`INSERT INTO approvals(
        target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,reviewer_id,reason,decided_at
      ) VALUES('content',?,?,'历史已有人工审核证据','none','[]','已通过',?,?,
        '保护真实审核证据',datetime('now','localtime'))`,
      contentId, label, user('yunying').id, user('guan').id);
    }
    const approvalId = Number(q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id
    ) VALUES('content',?,?,'旧演示底稿待审','none','[]','待审核',?)`,
    contentId, label, user('yunying').id).lastInsertRowid);
    const automationRunId = Number(q.run(`INSERT INTO content_automation_runs(
      rule_id,trigger,claim_key,status,content_id,initiated_by,profile_version,prompt_hash,
      snapshot_json,finished_at
    ) VALUES(?,'scheduled',?,'成功',?,?, 'content-0-r0','legacy-automation-hash',?,datetime('now','localtime'))`,
    automationRuleId, `legacy-${label}`, contentId, user('yunying').id,
    JSON.stringify(snapshot)).lastInsertRowid);
    if (downstream) {
      q.run(`INSERT INTO kb_docs(category,title,body,source_type,source_id,enabled)
        VALUES('员工产出',?,'真实下游知识','content',?,1)`, label, contentId);
    }
    return { contentId, approvalId, automationRunId, mode };
  };

  const legacyAutomationBundles = [
    insertAutomationQualityBundle('旧演示自动化底稿1'),
    insertAutomationQualityBundle('旧演示自动化底稿2'),
    insertAutomationQualityBundle('旧演示自动化底稿3', { mode: 'api-fallback' }),
    insertAutomationQualityBundle('旧演示自动化底稿4', { mode: 'failed' }),
  ];

  const insertRestaurantQualityBundle = (label, idx, mode) => {
    const specialist = employee(idx);
    const contentId = Number(q.run(`INSERT INTO contents(
      type,title,body,status,ai_mode,creator_id,marshal_id
    ) VALUES('员工产出',?,?,'待审核',?,?,?)`,
    label, `# ${label}\n未形成可验收业务产物。`, mode, user('yunying').id,
    specialist.marshal_id).lastInsertRowid);
    const evidence = {
      kind: 'restaurant_employee_execution_evidence',
      web: { attempted: false, ok: false, results: [], note: '本次任务未触发联网检索' },
      outputContract: {
        valid: false,
        skipped: 'template_mode',
        contractId: `legacy-contract-${idx}`,
        schemaVersion: 'restaurant-role-output/1',
        artifacts: [],
      },
    };
    const taskId = Number(q.run(`INSERT INTO agent_tasks(
      marshal_id,specialist_id,title,type,requirement,status,output_id,created_by,
      employee_profile_version,employee_prompt_hash,employee_capabilities_snapshot,
      employee_config_snapshot,employee_skills_snapshot,employee_web_snapshot
    ) VALUES(?,?,?,'岗位交付','旧演示质检失败','待审阅',?,?,
      'restaurant-v2-legacy','legacy-prompt-hash','[{"name":"必备能力"}]',
      '{"approvalMode":"manager_review"}','[{"name":"岗位Skill"}]',?)`,
    specialist.marshal_id, specialist.id, label, contentId, user('yunying').id,
    JSON.stringify(evidence)).lastInsertRowid);
    const approvalId = Number(q.run(`INSERT INTO approvals(
      target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id
    ) VALUES('content',?,?,'旧演示餐饮员工底稿','none','[]','待审核',?)`,
    contentId, label, user('yunying').id).lastInsertRowid);
    return { contentId, taskId, approvalId, mode };
  };
  const legacyRestaurantBundles = [
    insertRestaurantQualityBundle('旧演示餐饮底稿1', 102, 'template'),
    insertRestaurantQualityBundle('旧演示餐饮底稿2', 148, 'api-fallback'),
  ];

  const protectedSourceBundle = insertAutomationQualityBundle('保护手工来源底稿', {
    sourceType: 'manual',
    sourceId: 7001,
  });
  const protectedDownstreamBundle = insertAutomationQualityBundle('保护真实下游底稿', {
    downstream: true,
  });
  const protectedReviewedBundle = insertAutomationQualityBundle('保护已审核证据底稿', {
    reviewed: true,
  });

  const safeOutputId = legacyOutput('新店开业30天行动清单');
  const safeCompletedTaskId = legacyTask({
    idx: 101,
    title: '新店开业30天行动清单',
    status: '已完成',
    outputId: safeOutputId,
  });
  const safeRunningTaskId = legacyTask({
    idx: 125,
    title: '核心食材供应风险盘点',
    status: '执行中',
  });

  const heldTaskId = legacyTask({
    idx: 160,
    title: '周末会员日活动作战板',
    status: '执行中',
  });
  creditTenant({ tenantId: 1, delta: 1000, userId: user('guan').id, feature: '演示修复测试充值' });
  const held = holdCredits({
    userId: user('yunying').id,
    feature: '保护有hold的数字员工任务',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 10,
    refType: 'agent_task',
    refId: heldTaskId,
  });

  const providerTaskId = legacyTask({
    idx: 125,
    title: '核心食材供应风险盘点',
    status: '执行中',
    webSnapshot: JSON.stringify({ providerTaskId: 'upstream-task-123' }),
  });

  const reviewedOutputId = legacyOutput('本周招牌菜组合建议');
  const reviewedTaskId = legacyTask({
    idx: 108,
    title: '本周招牌菜组合建议',
    status: '待审阅',
    outputId: reviewedOutputId,
  });
  const realApprovalId = Number(q.run(`INSERT INTO approvals(
    target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id
  ) VALUES('content',?,'真实人工审批','用户已开始处理该产出','none','[]','待审核',?)`,
  reviewedOutputId, user('yunying').id).lastInsertRowid);

  const fakeApprovalTarget = q.get(`SELECT id FROM contents WHERE tenant_id=1 ORDER BY id LIMIT 1`).id;
  q.run(`UPDATE contents SET status='待审核' WHERE tenant_id=1 AND id=?`, fakeApprovalTarget);
  const fakeApprovalId = Number(q.run(`INSERT INTO approvals(
    target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id
  ) VALUES('content',?,'社区联名活动朋友圈（含合作政策表述）',
    '命中规则：未经确认的收益描述','high','["INVEST_RETURN"]','待审核',?)`,
  fakeApprovalTarget, user('sales2').id).lastInsertRowid);
  q.run(`INSERT INTO notifications(user_id,type,title,body)
    VALUES(?,'approval','3条高风险内容待您终审','含未经确认的价格与活动表述，请尽快处理')`, user('guan').id);

  const assetTarget = q.get(`SELECT id FROM contents WHERE tenant_id=1 AND id<>? ORDER BY id LIMIT 1`, fakeApprovalTarget).id;
  q.run(`UPDATE contents SET status='待审核' WHERE tenant_id=1 AND id=?`, assetTarget);
  const assetId = Number(q.run(`INSERT INTO biz_assets(
    name,category,value,status,use_count,owner,source_type,source_id,creator_id,note
  ) VALUES('旧演示占位资产','内容资产',100,'使用中',3,'内容生产仓','content',?,NULL,NULL)`,
  assetTarget).lastInsertRowid);

  // live 租户标记是最外层保险：即使所有文本指纹相同也不修改。
  q.run(`UPDATE tenants SET data_mode='live' WHERE id=1`);
  const skipped = reconcileDemoSeedPlaceholders({ tenantId: 1 });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.qualityFailedContentsReconciled, 0);
  assert.ok(q.get(`SELECT id FROM agent_tasks WHERE tenant_id=1 AND id=?`, safeRunningTaskId));
  assert.equal(q.get(`SELECT status FROM content_employee_runs
    WHERE tenant_id=1 AND id=?`, inconsistentContentRunId).status, '待审阅');
  assert.equal(q.get(`SELECT status FROM contents WHERE tenant_id=1 AND id=?`,
    legacyAutomationBundles[0].contentId).status, '待审核');
  assert.equal(q.get(`SELECT status FROM agent_tasks WHERE tenant_id=1 AND id=?`,
    legacyRestaurantBundles[0].taskId).status, '待审阅');
  q.run(`UPDATE tenants SET data_mode='demo' WHERE id=1`);

  const [first] = reconcileDemoSeedPlaceholdersAcrossTenants();
  assert.equal(first.tasksRemoved, 2);
  assert.equal(first.protectedTasks, 3);
  assert.equal(first.approvalsRemoved, 1);
  assert.equal(first.assetsArchived, 1);
  assert.equal(first.notificationsRemoved, 1);
  assert.equal(first.manualSubmissionsReconciled, 2);
  assert.equal(first.contentRunsReconciled, 1);
  assert.equal(first.qualityFailedApprovalsReconciled, 6);
  assert.equal(first.qualityFailedContentsReconciled, 6);
  assert.equal(first.qualityFailedAgentTasksReconciled, 2);
  assert.equal(first.qualityFailedAutomationRunsReconciled, 4);
  assert.ok(first.draftsRepaired >= 2);

  assert.equal(q.get(`SELECT id FROM agent_tasks WHERE tenant_id=1 AND id=?`, safeCompletedTaskId), undefined);
  assert.equal(q.get(`SELECT id FROM agent_tasks WHERE tenant_id=1 AND id=?`, safeRunningTaskId), undefined);
  assert.equal(q.get(`SELECT status FROM contents WHERE tenant_id=1 AND id=?`, safeOutputId).status, '草稿');
  assert.equal(q.get(`SELECT status FROM contents WHERE tenant_id=1 AND id=?`, fakeApprovalTarget).status, '草稿');
  assert.equal(q.get(`SELECT id FROM approvals WHERE tenant_id=1 AND id=?`, fakeApprovalId), undefined);
  assert.equal(q.get(`SELECT status,note FROM biz_assets WHERE tenant_id=1 AND id=?`, assetId).status, '已归档');

  assert.ok(q.get(`SELECT id FROM agent_tasks WHERE tenant_id=1 AND id=?`, heldTaskId));
  assert.ok(q.get(`SELECT id FROM agent_tasks WHERE tenant_id=1 AND id=?`, providerTaskId));
  assert.ok(q.get(`SELECT id FROM agent_tasks WHERE tenant_id=1 AND id=?`, reviewedTaskId));
  assert.equal(q.get(`SELECT status FROM credit_holds WHERE tenant_id=1 AND id=?`, held.holdId).status, 'held');
  assert.equal(q.get(`SELECT status FROM approvals WHERE tenant_id=1 AND id=?`, realApprovalId).status, '待审核');
  assert.equal(q.get(`SELECT status FROM contents WHERE tenant_id=1 AND id=?`, reviewedOutputId).status, '待审核');
  assert.equal(q.get(`SELECT result FROM task_submissions
    WHERE tenant_id=1 AND task_id=?`, seededCompletedTask.id).result, '通过');
  assert.equal(q.get(`SELECT result FROM task_submissions
    WHERE tenant_id=1 AND task_id=?`, seededPendingTask.id).result, '待审核');
  assert.equal(q.get(`SELECT result FROM task_submissions
    WHERE tenant_id=1 AND id=?`, protectedSubmissionId).result, '通过',
  '有真实分派与审核证据的记录不得自动改写');

  const reconciledContentRun = q.get(`SELECT status,result_md,ai_mode,model,snapshot_json
    FROM content_employee_runs WHERE tenant_id=1 AND id=?`, inconsistentContentRunId);
  assert.equal(reconciledContentRun.status, '失败');
  assert.equal(reconciledContentRun.result_md, null);
  assert.equal(reconciledContentRun.ai_mode, 'failed');
  assert.equal(reconciledContentRun.model, null);
  const reconciledSnapshot = JSON.parse(reconciledContentRun.snapshot_json);
  assert.equal(reconciledSnapshot.failure.code, 'DEMO_CONTENT_RUN_CONTRACT_INVALID');
  assert.equal(reconciledSnapshot.failure.retryable, true);
  assert.equal(reconciledSnapshot.reconciliation.previousStatus, '待审阅');
  assert.equal(reconciledSnapshot.reconciliation.previousAiMode, 'api');
  assert.equal(reconciledSnapshot.reconciliation.resultLength, invalidResultMd.length);
  assert.equal(
    reconciledSnapshot.reconciliation.resultSha256,
    crypto.createHash('sha256').update(invalidResultMd).digest('hex'),
  );
  assert.equal(reconciledSnapshot.billing.state, 'released');
  assert.equal(reconciledSnapshot.billing.chargedCredits, 0);
  assert.deepEqual(reconciledSnapshot.providerAttempt, invalidRunSnapshot.providerAttempt);
  assert.equal(q.get(`SELECT status FROM content_employee_runs
    WHERE tenant_id=1 AND id=?`, validPendingContentRunId).status, '待审阅',
  '契约通过且已结算的真实待审任务必须保留');
  assert.equal(q.get(`SELECT COUNT(*) n FROM op_logs
    WHERE tenant_id=1 AND module='系统升级' AND action='演示内容员工状态对账'`).n, 1);

  for (const item of legacyAutomationBundles) {
    const content = q.get(`SELECT status,ai_mode,snapshot_json FROM contents
      WHERE tenant_id=1 AND id=?`, item.contentId);
    assert.equal(content.status, '已驳回');
    assert.equal(content.ai_mode, item.mode, '需保留原始来源模式审计证据');
    assert.equal(JSON.parse(content.snapshot_json).reconciliation.code,
      'DEMO_UNADOPTABLE_CONTENT_RECONCILED');
    const approval = q.get(`SELECT status,reviewer_id,reason,decided_at FROM approvals
      WHERE tenant_id=1 AND id=?`, item.approvalId);
    assert.equal(approval.status, '已驳回');
    assert.equal(approval.reviewer_id, null);
    assert.match(approval.reason, /系统质量对账.*未形成可采纳产物/u);
    assert.ok(approval.decided_at);
    const automationRun = q.get(`SELECT status,error FROM content_automation_runs
      WHERE tenant_id=1 AND id=?`, item.automationRunId);
    assert.equal(automationRun.status, '失败');
    assert.match(automationRun.error, /质检未通过.*可重跑/u);
  }

  for (const item of legacyRestaurantBundles) {
    const content = q.get(`SELECT status,ai_mode,snapshot_json FROM contents
      WHERE tenant_id=1 AND id=?`, item.contentId);
    assert.equal(content.status, '已驳回');
    assert.equal(content.ai_mode, item.mode);
    assert.equal(JSON.parse(content.snapshot_json).reconciliation.retryable, true);
    const task = q.get(`SELECT status,employee_web_snapshot FROM agent_tasks
      WHERE tenant_id=1 AND id=?`, item.taskId);
    assert.equal(task.status, '失败');
    const taskEvidence = JSON.parse(task.employee_web_snapshot);
    assert.equal(taskEvidence.web.attempted, false, '原始执行证据不得被覆盖');
    assert.equal(taskEvidence.outputContract.valid, false);
    assert.equal(taskEvidence.reconciliation.code, 'DEMO_UNADOPTABLE_CONTENT_RECONCILED');
    assert.equal(q.get(`SELECT status FROM approvals WHERE tenant_id=1 AND id=?`,
      item.approvalId).status, '已驳回');
  }

  for (const item of [protectedSourceBundle, protectedDownstreamBundle, protectedReviewedBundle]) {
    assert.equal(q.get(`SELECT status FROM contents WHERE tenant_id=1 AND id=?`,
      item.contentId).status, '待审核');
    assert.equal(q.get(`SELECT status FROM approvals WHERE tenant_id=1 AND id=?`,
      item.approvalId).status, '待审核');
    assert.equal(q.get(`SELECT status FROM content_automation_runs WHERE tenant_id=1 AND id=?`,
      item.automationRunId).status, '成功');
  }
  assert.equal(q.get(`SELECT COUNT(*) n FROM op_logs
    WHERE tenant_id=1 AND module='系统升级' AND action='演示无效审批质量对账'`).n, 1);

  const [second] = reconcileDemoSeedPlaceholdersAcrossTenants();
  assert.deepEqual(
    [second.tasksRemoved, second.approvalsRemoved, second.draftsRepaired, second.assetsArchived,
      second.notificationsRemoved, second.manualSubmissionsReconciled, second.contentRunsReconciled,
      second.qualityFailedApprovalsReconciled, second.qualityFailedContentsReconciled,
      second.qualityFailedAgentTasksReconciled, second.qualityFailedAutomationRunsReconciled],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
});
