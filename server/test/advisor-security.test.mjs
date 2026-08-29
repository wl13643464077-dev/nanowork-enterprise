import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `shanmei-advisor-security-${process.pid}.db`);
for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
const advisorRoutes = (await import('../src/routes/advisor.js')).default;
const { tplDiagnosis } = await import('../src/engines/ai.js');

initSchema();
migrateV2();

q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`, 'boss', hashPassword('123456'), '老板', 'boss', '决策层');
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`, 'ops', hashPassword('123456'), '运营总监', 'ops_director', '运营中心');
q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id) VALUES(?,?,?,?,?,1)`, 'sales', hashPassword('123456'), '一线员工', 'sales', '销售部');
q.run(`UPDATE tenants SET credits=100000 WHERE id=1`);

const boss = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='boss'`);
const ops = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='ops'`);
const sales = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='sales'`);

function makeApp(user) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => runWithTenant(user.tenant_id || 1, () => { req.user = user; next(); }));
  app.use('/advisor', advisorRoutes);
  return app;
}

async function withServer(user, fn) {
  const server = makeApp(user).listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function call(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

test('AI总参谋会话：同企业其他用户不能读取或续写别人的会话', async () => {
  const conversationId = runWithTenant(1, () => {
    const r = q.run('INSERT INTO ai_conversations(user_id,title,diag_type) VALUES(?,?,?)', boss.id, '老板会诊', '经营诊断');
    q.run('INSERT INTO ai_messages(conversation_id,role,content) VALUES(?,?,?)', r.lastInsertRowid, 'user', '老板私有问题');
    return r.lastInsertRowid;
  });

  await withServer(boss, async base => {
    const own = await call(base, `/advisor/conversations/${conversationId}/messages`);
    assert.equal(own.status, 200);
    assert.equal(own.json[0].content, '老板私有问题');
  });

  await withServer(ops, async base => {
    const blockedRead = await call(base, `/advisor/conversations/${conversationId}/messages`);
    assert.equal(blockedRead.status, 404);

    const blockedWrite = await call(base, '/advisor/chat', {
      method: 'POST',
      body: JSON.stringify({ conversationId, question: '继续分析这个会话' }),
    });
    assert.equal(blockedWrite.status, 404);
  });
});

test('AI总参谋模板兜底：上传表格时也必须引用文件内容', () => {
  const text = tplDiagnosis('经营诊断', '分析这份销售表', {
    bottleneck: '已邀约',
    revenueRate: 42,
    convRate: 9,
    partnerRate: 35,
    leads: 30,
    invited: 8,
    arrived: 4,
    deals: 2,
    amount: 26000,
    aCount: 5,
    festival: '中秋',
    pendingApprovals: 1,
  }, [{ name: '销售数据.xlsx', content: '| 客户 | 金额 | 阶段 |\n| 张三 | 12000 | 已成交 |' }]);
  assert.match(text, /【用户上传·销售数据\.xlsx】/);
  assert.match(text, /张三/);
  assert.match(text, /优先参考文件字段与表格样本/);
  assert.match(text, /1 条待审批事项需负责人确认/);
  assert.doesNotMatch(text, /高风险内容待终审/);
});

test('AI总参谋后续追问：无真实API时保留会话与附件证据，但不交付模板答案', async () => {
  const fileId = runWithTenant(1, () => q.run(`INSERT INTO uploaded_files(user_id,name,stored_name,ext,mime,size,purpose,file_path,file_url,extracted_text,extract_mode)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, ops.id, '历史销售表.xlsx', 'history.xlsx', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  128, 'chat', '/tmp/history.xlsx', '/uploads/files/1/chat/history.xlsx', '客户：李四；成交金额：36000；阶段：已成交', '自动提取正文').lastInsertRowid);

  await withServer(ops, async base => {
    const first = await call(base, '/advisor/chat', {
      method: 'POST', body: JSON.stringify({ question: '先分析这份表', fileIds: [fileId] }),
    });
    assert.equal(first.status, 502);
    assert.equal(first.json.code, 'AI_REAL_OUTPUT_REQUIRED');
    assert.equal(first.json.retryable, true);
    assert.ok(first.json.conversationId);
    assert.equal(first.json.billing.state, 'released');

    const followup = await call(base, '/advisor/chat', {
      method: 'POST', body: JSON.stringify({ conversationId: first.json.conversationId, question: '表里的成交金额是多少' }),
    });
    assert.equal(followup.status, 502);
    assert.equal(followup.json.code, 'AI_REAL_OUTPUT_REQUIRED');
    assert.equal(followup.json.conversationId, first.json.conversationId);
    assert.equal(q.get(`SELECT COUNT(*) n FROM ai_messages
      WHERE tenant_id=1 AND conversation_id=? AND role='assistant'`, first.json.conversationId).n, 0);
    const firstUser = q.get(`SELECT attachments_json FROM ai_messages
      WHERE tenant_id=1 AND conversation_id=? AND role='user' AND attachments_json IS NOT NULL
      ORDER BY id LIMIT 1`, first.json.conversationId);
    assert.match(firstUser.attachments_json, /历史销售表\.xlsx/);
  });
});

test('AI总参谋请求契约：拒绝对象型问题、非法会话号和不存在的元帅', async () => {
  await withServer(ops, async base => {
    const before = q.get('SELECT COUNT(*) n FROM ai_conversations WHERE tenant_id=1 AND user_id=?', ops.id).n;
    const objectQuestion = await call(base, '/advisor/chat', {
      method: 'POST', body: JSON.stringify({ question: { text: '不应被隐式转换' } }),
    });
    assert.equal(objectQuestion.status, 400);
    assert.match(objectQuestion.json.error, /必须是文本/);

    const badConversation = await call(base, '/advisor/chat', {
      method: 'POST', body: JSON.stringify({ conversationId: 'not-an-id', question: '继续会话' }),
    });
    assert.equal(badConversation.status, 400);

    const missingMarshal = await call(base, '/advisor/chat', {
      method: 'POST', body: JSON.stringify({ marshalCode: 'M-99', question: '请元帅分析' }),
    });
    assert.equal(missingMarshal.status, 404);
    assert.equal(q.get('SELECT COUNT(*) n FROM ai_conversations WHERE tenant_id=1 AND user_id=?', ops.id).n, before);
  });
});

test('AI总参谋转派与能力矩阵：非法元帅不产生任务，运行数按人员范围隔离', async () => {
  q.run(`INSERT OR IGNORE INTO marshals(code,name,title,sort) VALUES('M-01','战略规划元帅','战略',1)`);
  const marshal = q.get(`SELECT id FROM marshals WHERE code='M-01'`);
  const before = q.get('SELECT COUNT(*) n FROM agent_tasks WHERE tenant_id=1').n;

  await withServer(ops, async base => {
    const invalid = await call(base, '/advisor/dispatch', {
      method: 'POST', body: JSON.stringify({ marshalCodes: ['M-01', 'M-99'], title: '运营会诊' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(q.get('SELECT COUNT(*) n FROM agent_tasks WHERE tenant_id=1').n, before);
  });

  runWithTenant(1, () => {
    q.run(`INSERT INTO agent_tasks(marshal_id,title,type,status,created_by) VALUES(?,?,'会诊','执行中',?)`, marshal.id, '老板私有任务', boss.id);
    q.run(`INSERT INTO agent_tasks(marshal_id,title,type,status,created_by) VALUES(?,?,'会诊','执行中',?)`, marshal.id, '运营私有任务', ops.id);
  });
  await withServer(ops, async base => {
    const result = await call(base, '/advisor/capability');
    assert.equal(result.status, 200);
    assert.equal(result.json.networkStatus.find(item => item.code === 'M-01').running, 1);
  });
  await withServer(boss, async base => {
    const result = await call(base, '/advisor/capability');
    assert.equal(result.status, 200);
    assert.equal(result.json.networkStatus.find(item => item.code === 'M-01').running, 2);
  });
});

test('AI总参谋会诊动作按执行人交给管理层，重复转换幂等且员工无下发权', async () => {
  const messageId = runWithTenant(1, () => {
    const conversation = q.run('INSERT INTO ai_conversations(user_id,title,diag_type) VALUES(?,?,?)', boss.id, '分层执行会诊', '经营诊断');
    return q.run(`INSERT INTO ai_messages(conversation_id,role,content) VALUES(?,?,?)`, conversation.lastInsertRowid, 'assistant',
      '【今日目标】完成本周门店复盘｜【执行人】运营负责人｜【截止】周五18:00｜【检查标准】提交复盘并派到岗位').lastInsertRowid;
  });

  await withServer(boss, async base => {
    const first = await call(base, `/advisor/messages/${messageId}/to-tasks`, { method: 'POST', body: '{}' });
    assert.equal(first.status, 200);
    assert.equal(first.json.created.length, 1);
    assert.equal(first.json.created[0].assigneeId, ops.id);
    assert.equal(first.json.created[0].status, '待执行');
    assert.equal(first.json.nextUrl, '/execution#task-board');
    const persisted = q.get(`SELECT assigned_by FROM tasks WHERE tenant_id=1 AND id=?`, first.json.created[0].id);
    assert.equal(persisted.assigned_by, boss.id);

    const second = await call(base, `/advisor/messages/${messageId}/to-tasks`, { method: 'POST', body: '{}' });
    assert.equal(second.status, 200);
    assert.equal(second.json.created.length, 0);
    assert.equal(second.json.existing.length, 1);
  });

  await withServer(sales, async base => {
    const denied = await call(base, `/advisor/messages/${messageId}/to-tasks`, { method: 'POST', body: '{}' });
    assert.equal(denied.status, 403);
  });
});

test('会诊转派分部只创建管理层待执行任务，不制造没有 worker 的执行中数字员工任务', async () => {
  q.run(`INSERT OR IGNORE INTO marshals(code,name,title,sort,online) VALUES('M-02','经营增长元帅','增长',2,1)`);
  const sourceMessageId = runWithTenant(1, () => {
    const conversation = q.run('INSERT INTO ai_conversations(user_id,title,diag_type) VALUES(?,?,?)', boss.id, '分部协同会诊', '经营诊断');
    return q.run(`INSERT INTO ai_messages(conversation_id,role,content) VALUES(?,?,?)`, conversation.lastInsertRowid, 'assistant', '建议经营分部与增长分部协同').lastInsertRowid;
  });
  const beforeAgentTasks = q.get('SELECT COUNT(*) n FROM agent_tasks WHERE tenant_id=1').n;
  const beforeTasks = q.get('SELECT COUNT(*) n FROM tasks WHERE tenant_id=1').n;

  await withServer(boss, async base => {
    const first = await call(base, '/advisor/dispatch', {
      method: 'POST',
      body: JSON.stringify({
        marshalCodes: ['M-01', 'M-02'],
        title: '把门店经营复盘拆到具体岗位',
        sourceMessageId,
        owner: '一线员工',
      }),
    });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.created.length, 2);
    assert.equal(first.json.owner.id, ops.id);
    assert.equal(first.json.nextUrl, '/execution#task-board');
    assert.equal(first.json.traceUrl, `/business-flow/advisor_message/${sourceMessageId}`);
    assert.ok(first.json.created.every(item => item.status === '待执行' && item.assigneeId === ops.id));

    const repeated = await call(base, '/advisor/dispatch', {
      method: 'POST',
      body: JSON.stringify({
        marshalCodes: ['M-01', 'M-02'],
        title: '把门店经营复盘拆到具体岗位',
        sourceMessageId,
        owner: '老板',
      }),
    });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.json.created.length, 0);
    assert.equal(repeated.json.existing.length, 2);
    assert.ok(repeated.json.existing.every(item => item.assignee_id === ops.id && item.owner === ops.name));
  });

  assert.equal(q.get('SELECT COUNT(*) n FROM agent_tasks WHERE tenant_id=1').n, beforeAgentTasks);
  assert.equal(q.get('SELECT COUNT(*) n FROM tasks WHERE tenant_id=1').n, beforeTasks + 2);
  const handoffs = q.all(`SELECT status,assignee_id,assigned_by,source,detail FROM tasks WHERE tenant_id=1 AND source='会诊分派'`);
  assert.ok(handoffs.every(task => task.status === '待执行' && task.assignee_id === ops.id));
  assert.ok(handoffs.every(task => task.assigned_by === boss.id));
  assert.ok(handoffs.every(task => /下一步：负责人接单/.test(task.detail)));

  await withServer(sales, async base => {
    const denied = await call(base, '/advisor/dispatch', {
      method: 'POST',
      body: JSON.stringify({ marshalCodes: ['M-01'], title: '员工不应直接下发会诊' }),
    });
    assert.equal(denied.status, 403);
  });
});
