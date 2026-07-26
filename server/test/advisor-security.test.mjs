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
q.run(`UPDATE tenants SET credits=100000 WHERE id=1`);

const boss = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='boss'`);
const ops = q.get(`SELECT id,name,role,tenant_id FROM users WHERE username='ops'`);

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
});

test('AI总参谋后续追问：模板模式仍会重新读取历史附件正文', async () => {
  const fileId = runWithTenant(1, () => q.run(`INSERT INTO uploaded_files(user_id,name,stored_name,ext,mime,size,purpose,file_path,file_url,extracted_text,extract_mode)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, ops.id, '历史销售表.xlsx', 'history.xlsx', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  128, 'chat', '/tmp/history.xlsx', '/uploads/files/1/chat/history.xlsx', '客户：李四；成交金额：36000；阶段：已成交', '自动提取正文').lastInsertRowid);

  await withServer(ops, async base => {
    const first = await call(base, '/advisor/chat', {
      method: 'POST', body: JSON.stringify({ question: '先分析这份表', fileIds: [fileId] }),
    });
    assert.equal(first.status, 200);
    assert.match(first.json.reply, /历史销售表\.xlsx/);

    const followup = await call(base, '/advisor/chat', {
      method: 'POST', body: JSON.stringify({ conversationId: first.json.conversationId, question: '表里的成交金额是多少' }),
    });
    assert.equal(followup.status, 200);
    assert.match(followup.json.reply, /历史销售表\.xlsx/);
    assert.match(followup.json.reply, /36000/);
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
