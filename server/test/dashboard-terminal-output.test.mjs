import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DBP = path.join(os.tmpdir(), `nanowork-dashboard-terminal-output-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.SEED_DEMO = 'false';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const { hashPassword, today } = await import('../src/util.js');
const { holdCredits, settleHold } = await import('../src/engines/credits.js');
const dashboardRoutes = (await import('../src/routes/dashboard.js')).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();
q.run(`UPDATE tenants SET status='已开通',credits=10000 WHERE id=1`);
q.run(`INSERT INTO users(username,password_hash,name,role,dept,status,tenant_id)
  VALUES(?,?,?,?,?,'启用',1)`, 'terminal-boss', hashPassword('Secret123!'), '验收老板', 'boss', '决策层');
q.run(`INSERT INTO users(username,password_hash,name,role,dept,status,tenant_id)
  VALUES(?,?,?,?,?,'启用',1)`, 'terminal-sales', hashPassword('Secret123!'), '验收员工', 'sales', '销售部');
const boss = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='terminal-boss'`);
const sales = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='terminal-sales'`);
const marshal = q.get(`SELECT id,code,name FROM marshals ORDER BY sort,id LIMIT 1`);
const specialist = q.get(`SELECT id FROM specialists WHERE marshal_id=? ORDER BY id LIMIT 1`, marshal.id);
const day = today();

function insertContent({ title, aiMode, sourceType = null, snapshot = {}, body = '可验收产出正文' }) {
  return Number(q.run(`INSERT INTO contents(
    type,title,body,status,ai_mode,source_type,creator_id,marshal_id,snapshot_json,created_at
  ) VALUES('员工产出',?,?,'可使用',?,?,?,?,?,?)`,
  title, body, aiMode, sourceType, sales.id, marshal.id, JSON.stringify(snapshot), `${day} 09:00:00`).lastInsertRowid);
}

function insertAgentTask(title, status, outputId = null) {
  return Number(q.run(`INSERT INTO agent_tasks(
    marshal_id,specialist_id,title,type,requirement,status,output_id,created_by,created_at
  ) VALUES(?,?,?,'常规','终态口径验收',?,?,?,?)`,
  marshal.id, specialist?.id || null, title, status, outputId, sales.id, `${day} 10:00:00`).lastInsertRowid);
}

function insertCompletedManualTask(title, {
  content = '员工人工完成并提交了可验收结果',
  sourceRefType = null,
  sourceRefId = null,
} = {}) {
  const taskId = Number(q.run(`INSERT INTO tasks(
    title,type,status,assignee_id,assigned_by,source,created_at,done_at
  ) VALUES(?, '数据', '已完成', ?, ?, '手动', ?, ?)`,
  title, sales.id, boss.id, `${day} 08:00:00`, `${day} 12:00:00`).lastInsertRowid);
  q.run(`INSERT INTO task_submissions(
    task_id,user_id,content,result,source_ref_type,source_ref_id,reviewer_id,reviewed_at,review_reason,created_at
  ) VALUES(?,?,?,'通过',?,?,?,?,?,?)`,
  taskId, sales.id, content, sourceRefType, sourceRefId, boss.id, `${day} 12:00:00`, '人工审核确认', `${day} 11:30:00`);
  return taskId;
}

const manualContentId = insertContent({
  title: '人工明确免计费内容',
  aiMode: 'manual',
  sourceType: 'manual',
});
const settledContentId = insertContent({
  title: '真实API已结算内容',
  aiMode: 'api',
  snapshot: {
    contract: { status: 'valid', valid: true, errors: [] },
    billing: { state: 'settled', pendingReconciliation: false },
  },
});
q.run(`INSERT INTO approvals(
  target_type,target_id,title,summary,risk_level,rules_hit,status,
  submitter_id,reviewer_id,reason,created_at,decided_at
) VALUES('content',?,?,?,'低','[]','已通过',?,?,?,?,?)`,
settledContentId,
'真实 API 内容人工采纳',
'结算、契约与正文均已核验',
sales.id,
boss.id,
'人工验收通过，可进入正式业务统计',
`${day} 09:10:00`,
`${day} 09:20:00`);
const templateContentId = insertContent({
  title: '模板伪终态内容',
  aiMode: 'template',
  body: '模板底稿不是产出',
});
const pendingContentId = insertContent({
  title: '待对账伪终态内容',
  aiMode: 'api',
  snapshot: {
    contract: { status: 'valid', valid: true, errors: [] },
    billing: { state: 'pending_reconciliation', pendingReconciliation: true },
  },
});

insertCompletedManualTask('已验收人工任务');
q.run(`INSERT INTO tasks(title,type,status,assignee_id,assigned_by,source,created_at,done_at)
  VALUES('无产出伪完成任务','数据','已完成',?,?,'手动',?,?)`,
sales.id, boss.id, `${day} 08:10:00`, `${day} 12:10:00`);

const agentId = Number(q.run(`INSERT INTO custom_agents(name,prompt,creator_id) VALUES('验收智能体','只输出真实结果',?)`, sales.id).lastInsertRowid);
const sessionId = Number(q.run(`INSERT INTO custom_agent_chat_sessions(agent_id,user_id,title)
  VALUES(?,?,'终态验收')`, agentId, sales.id).lastInsertRowid);
const settledMessageId = Number(q.run(`INSERT INTO custom_agent_chat_msgs(session_id,role,content)
  VALUES(?,'assistant','已完成真实API分析')`, sessionId).lastInsertRowid);
const heldMessageId = Number(q.run(`INSERT INTO custom_agent_chat_msgs(session_id,role,content)
  VALUES(?,'assistant','仍在预授权占扣的AI分析')`, sessionId).lastInsertRowid);
const settledHold = holdCredits({
  userId: sales.id,
  feature: '排行榜AI任务终态',
  kind: 'text',
  model: 'gpt-5.5',
  credits: 20,
  refType: 'custom_agent_msg',
  refId: settledMessageId,
});
settleHold(settledHold, {
  usage: { inputTokens: 200, outputTokens: 100 },
  model: 'gpt-5.5',
  aiMode: 'api',
  note: '测试真实正向结算',
});
holdCredits({
  userId: sales.id,
  feature: '排行榜AI任务待对账',
  kind: 'text',
  model: 'gpt-5.5',
  credits: 20,
  refType: 'custom_agent_msg',
  refId: heldMessageId,
});
insertCompletedManualTask('已结算AI引用任务', {
  content: '结合真实AI结果完成业务提交',
  sourceRefType: 'custom_agent_msg',
  sourceRefId: settledMessageId,
});
insertCompletedManualTask('未结算AI引用任务', {
  content: '该引用尚未形成可计分终态',
  sourceRefType: 'custom_agent_msg',
  sourceRefId: heldMessageId,
});

insertAgentTask('今日已验收人工产出', '已完成', manualContentId);
const settledAgentTaskId = insertAgentTask('今日已验收API产出', '已完成', settledContentId);
const settledAgentTaskHold = holdCredits({
  userId: sales.id,
  feature: `员工任务·${marshal.name}`,
  kind: 'text',
  model: 'gpt-5.5',
  credits: 20,
  refType: 'agent_task',
  refId: settledAgentTaskId,
});
settleHold(settledAgentTaskHold, {
  usage: { inputTokens: 240, outputTokens: 160 },
  model: 'gpt-5.5',
  aiMode: 'api',
  note: '测试数字员工真实正向结算',
});
insertAgentTask('今日刚新建', '执行中');
insertAgentTask('今日运行失败', '失败');
insertAgentTask('今日待审不是终态', '待审阅', manualContentId);
insertAgentTask('今日模板伪完成', '已完成', templateContentId);
insertAgentTask('今日待对账伪完成', '已完成', pendingContentId);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(1, () => {
    req.user = boss;
    next();
  }));
  app.use('/dashboard', dashboardRoutes);
  return app;
}

async function withServer(fn) {
  const server = makeApp().listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('员工排行只计可验证终态：内容走canonical delivery，任务需有效产出及正向结算或人工免计费', async () => {
  await withServer(async base => {
    const payload = await fetch(`${base}/dashboard/follow-overview?mode=day&date=${day}`)
      .then(response => response.json());
    const row = payload.staff.find(item => Number(item.user_id) === Number(sales.id));
    assert.ok(row);
    assert.equal(row.content_count, 2, '仅人工明确产出与已结算API内容可计分');
    assert.equal(row.completed_tasks, 2, '仅人工免计费任务与真实正向结算AI任务可计分');
    assert.equal(row.passed_submissions, 2, '通过提交也不得绕过终态可验证门');

    const detail = await fetch(`${base}/dashboard/employees/${sales.id}/detail?mode=day&date=${day}`)
      .then(response => response.json());
    assert.match(detail.score.score_formula, /可验证终态任务/u);
    assert.match(detail.score.score_formula, /已通过交付门禁并由人工采纳的内容/u);
  });
});

test('分部快捷入口“今日产出”仅统计已完成且通过canonical delivery的真正终态', async () => {
  await withServer(async base => {
    const payload = await fetch(`${base}/dashboard/marshal-shortcuts`).then(response => response.json());
    const row = payload.find(item => Number(item.id) === Number(marshal.id));
    assert.ok(row);
    assert.equal(row.today_outputs, 2);
  });
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
  }
});
