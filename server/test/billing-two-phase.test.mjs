// 两段式记账测试（审计 BE-C1/BE-H1/BE-H2 + AI-C1）：
// ①按实际内容估算替代固定口径 ②并发占扣/实扣不超卖 ③SSE 占扣不足不开流
// ④视频异步失败全额退分 ⑤结算多退少补且幂等 —— 核心不变量：任意时刻 Σ流水 ≡ 余额变动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `shanmei-two-phase-${process.pid}.db`);
for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { db, q, qRaw, initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
initSchema();
migrateV2();
const credits = await import('../src/engines/credits.js');
const advisorRoutes = (await import('../src/routes/advisor.js')).default;
const marshalRoutes = (await import('../src/routes/marshals.js')).default;
const contentModule = await import('../src/routes/content.js');

// 独立企业 + 员工（sales → deepseek-v4-flash：in/out = 5/5 元/百万token）
const T = Number(qRaw.run("INSERT INTO tenants(name,status,credits) VALUES('两段式企业','已开通',0)").lastInsertRowid);
const U = Number(qRaw.run("INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES('tp_u1','x','两段式员工','sales',?)", T).lastInsertRowid);
qRaw.run(`INSERT INTO marshals(code,name,title,emoji,duty,sort) VALUES('M-01','测试分部','测试','🧪','测试职责',1)`);
const M = Number(db.prepare(`SELECT id FROM marshals WHERE code='M-01'`).get().id);
const REQUEST_ID = 'billing-two-phase-request';

const bal = () => credits.balanceOfTenant(T);
const sumLogs = () => db.prepare('SELECT COALESCE(SUM(credits),0) s FROM credit_logs WHERE tenant_id=?').get(T).s;
const heldCount = () => db.prepare(`SELECT COUNT(*) n FROM credit_holds WHERE tenant_id=? AND status='held'`).get(T).n;
// 对账恒等：期初为 0，任意时刻 余额 ≡ −Σ(流水 credits)（消耗记正、充值记负）
const assertLedger = (msg = '对账恒等：余额 ≡ −Σ流水') => assert.equal(bal(), -sumLogs(), msg);
const setBalance = (target) => {
  const delta = target - bal();
  if (delta !== 0) credits.creditTenant({ tenantId: T, delta, userId: U, feature: '测试调整余额' });
};

function makeApp(user) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => runWithTenant(user.tenant_id || 1, () => {
    req.user = user;
    req.requestId = REQUEST_ID;
    next();
  }));
  app.use('/advisor', advisorRoutes);
  app.use('/marshals', marshalRoutes);
  return app;
}
async function withServer(user, fn) {
  const server = makeApp(user).listen(0);
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('BE-C1：估算按实际内容增长，大上下文不再被固定 4000in/2000out 口径低估', () => {
  const fixed = credits.estimateMaxCredits('text', 'gpt-5.5'); // 老口径：36 分
  const small = credits.estimateCallCredits({ model: 'gpt-5.5', texts: ['你好'] });
  const big = credits.estimateCallCredits({ model: 'gpt-5.5', texts: ['字'.repeat(30000)] }); // 3万字大上下文
  assert.ok(small >= 1, '空内容也有系统提示词/知识库固定余量');
  assert.ok(big > small, '估算必须随实际内容增长');
  assert.ok(big >= fixed * 5, `3万字上下文估算(${big})应远超固定口径(${fixed})，否则大上下文仍会坏账`);
});

test('占扣→结算多退少补：一条流水、余额精确、恒等成立，且结算/释放幂等', () => {
  credits.creditTenant({ tenantId: T, delta: 1000, userId: U, feature: '测试充值' });
  const before = bal();
  const logsBefore = db.prepare('SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=?').get(T).n;
  const hold = credits.holdCredits({ userId: U, feature: '测试会诊', kind: 'text', model: 'deepseek-v4-flash', credits: 100 });
  assert.equal(bal(), before - 100, '占扣立即从租户池扣减');
  assert.equal(heldCount(), 1);
  assertLedger('占扣期间恒等也必须成立');
  // 真实用量 1000in/1000out → 2 分（与既有计费公式一致），冲正退回 98 分
  const bill = credits.settleHold(hold, { usage: { inputTokens: 1000, outputTokens: 1000 }, model: 'deepseek-v4-flash', aiMode: 'api' });
  assert.equal(bill.credits, 2);
  assert.equal(bal(), before - 2, '多退少补后余额只少实扣的 2 分');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=?').get(T).n, logsBefore + 1, '占扣与结算复用同一条流水，不重复计入消耗');
  const log = db.prepare(`SELECT credits,input_tokens,output_tokens,ai_mode FROM credit_logs WHERE id=?`).get(hold.logId);
  assert.equal(log.credits, 2);
  assert.equal(log.input_tokens, 1000);
  assert.equal(log.ai_mode, 'api');
  assertLedger();
  // 幂等：重复结算/释放不动账（防止"结算后再释放"造成双重退款）
  assert.equal(credits.settleHold(hold, { usage: { inputTokens: 9999, outputTokens: 9999 } }), null);
  assert.equal(credits.releaseHold(hold), null);
  assert.equal(bal(), before - 2, '重复结算与释放均不改变余额');
});

test('结算超过占扣时失败关闭：不追加扣款、不伪造实扣并保留 held 待对账', () => {
  const before = bal();
  const hold = credits.holdCredits({ userId: U, feature: '估算偏低补扣', kind: 'text', model: 'deepseek-v4-flash', credits: 5 });
  const afterHold = bal();
  const holdBefore = db.prepare(`SELECT status,held_credits,settled_credits,settled_at
    FROM credit_holds WHERE id=?`).get(hold.holdId);
  const logBefore = db.prepare(`SELECT credits,input_tokens,output_tokens,cost_yuan,ai_mode,balance_after,note
    FROM credit_logs WHERE id=?`).get(hold.logId);
  // 100000in/100000out → (100000×5+100000×5)/1e6=1元 ×1.5/0.01 = 150 分 > 占扣 5 分
  assert.throws(
    () => credits.settleHold(hold, {
      usage: { inputTokens: 100000, outputTokens: 100000 },
      model: 'deepseek-v4-flash',
      aiMode: 'api',
    }),
    error => error?.status === 409
      && error?.code === 'BILLING_HOLD_EXCEEDED'
      && /超过预授权.*待账务对账/u.test(error.message),
  );
  assert.equal(bal(), afterHold, '结算失败不得在占扣之外继续扣减余额');
  assert.deepEqual(
    db.prepare(`SELECT status,held_credits,settled_credits,settled_at
      FROM credit_holds WHERE id=?`).get(hold.holdId),
    holdBefore,
    '占扣必须继续保持 held，交给对账流程处理',
  );
  assert.deepEqual(
    db.prepare(`SELECT credits,input_tokens,output_tokens,cost_yuan,ai_mode,balance_after,note
      FROM credit_logs WHERE id=?`).get(hold.logId),
    logBefore,
    '流水必须保持预授权原状，不得伪造 token、成本或实扣终态',
  );
  assertLedger();

  const released = credits.releaseHold(hold, '专项测试清理超额待对账占扣');
  assert.equal(released.credits, 0);
  assert.equal(bal(), before);
  assertLedger();

  const fixedHold = credits.holdCredits({
    userId: U,
    feature: '固定报价超额阻断',
    kind: 'video',
    model: 'test-video',
    credits: 5,
  });
  const afterFixedHold = bal();
  assert.throws(
    () => credits.settleHold(fixedHold, { credits: 6, model: 'test-video', aiMode: 'api' }),
    error => error?.code === 'BILLING_HOLD_EXCEEDED',
    '显式报价结算也不得绕过预授权上限',
  );
  assert.equal(bal(), afterFixedHold);
  assert.equal(
    db.prepare('SELECT status FROM credit_holds WHERE id=?').get(fixedHold.holdId).status,
    'held',
  );
  credits.releaseHold(fixedHold, '专项测试清理固定报价占扣');
  assert.equal(bal(), before);
  assertLedger();
});

test('真实 API 文本结算缺少有效 usage 时失败关闭：hold、余额与流水原样保留', () => {
  const invalidUsageCases = [
    { label: '缺少用量', usage: {} },
    { label: '非有限数', usage: { inputTokens: Number.NaN, outputTokens: 1 } },
    { label: '负数', usage: { inputTokens: -1, outputTokens: 2 } },
    { label: '总用量为0', usage: { inputTokens: 0, outputTokens: 0 } },
  ];

  for (const item of invalidUsageCases) {
    const balanceBefore = bal();
    const hold = credits.holdCredits({
      userId: U,
      feature: `usage失败关闭·${item.label}`,
      kind: 'text',
      model: 'deepseek-v4-flash',
      credits: 20,
    });
    const balanceAfterHold = bal();
    const holdBefore = db.prepare(`SELECT status,held_credits,settled_credits,settled_at
      FROM credit_holds WHERE id=?`).get(hold.holdId);
    const logBefore = db.prepare(`SELECT credits,input_tokens,output_tokens,cost_yuan,ai_mode,balance_after,note
      FROM credit_logs WHERE id=?`).get(hold.logId);

    assert.throws(
      () => credits.settleHold(hold, {
        usage: item.usage,
        model: 'deepseek-v4-flash',
        aiMode: 'api',
      }),
      error => error?.status === 409
        && error?.code === 'BILLING_USAGE_MISSING'
        && error?.retryable === false,
      item.label,
    );
    assert.equal(bal(), balanceAfterHold, `${item.label}：不得改变占扣后余额`);
    assert.deepEqual(
      db.prepare(`SELECT status,held_credits,settled_credits,settled_at
        FROM credit_holds WHERE id=?`).get(hold.holdId),
      holdBefore,
      `${item.label}：hold 必须保持 held`,
    );
    assert.deepEqual(
      db.prepare(`SELECT credits,input_tokens,output_tokens,cost_yuan,ai_mode,balance_after,note
        FROM credit_logs WHERE id=?`).get(hold.logId),
      logBefore,
      `${item.label}：流水不得被改写为0分已结算`,
    );
    credits.releaseHold(hold, `清理${item.label}专项测试占扣`);
    assert.equal(bal(), balanceBefore);
  }

  const templateHold = credits.holdCredits({
    userId: U,
    feature: '模板底稿退款不受usage门影响',
    kind: 'text',
    model: 'deepseek-v4-flash',
    credits: 20,
  });
  const templateBill = credits.settleHold(templateHold, {
    usage: { inputTokens: 0, outputTokens: 0 },
    model: 'template',
    aiMode: 'template',
  });
  assert.equal(templateBill.credits, 0, '模板底稿仍应全额退回预授权');
  assertLedger();
});

test('释放占扣（调用失败未交付）：全额退回，保留 0 分流水审计', () => {
  const before = bal();
  const hold = credits.holdCredits({ userId: U, feature: '失败释放', kind: 'text', model: 'deepseek-v4-flash', credits: 200 });
  assert.equal(bal(), before - 200);
  const bill = credits.releaseHold(hold, '生成失败，预授权全额退回');
  assert.equal(bill.credits, 0);
  assert.equal(bal(), before, '失败后全额退回');
  assert.equal(db.prepare('SELECT credits FROM credit_logs WHERE id=?').get(hold.logId).credits, 0);
  assert.equal(heldCount(), 0);
  assertLedger();
});

test('并发占扣不超卖：Promise.all 多路同时占扣，只放行余额允许的笔数', async () => {
  setBalance(100);
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => (async () => {
    await new Promise(resolve => setImmediate(resolve));
    return credits.holdCredits({ userId: U, feature: '并发占扣', kind: 'text', model: 'deepseek-v4-flash', credits: 30 });
  })()));
  const ok = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');
  assert.equal(ok.length, 3, '100 分只够 3 笔 30 分的占扣');
  assert.equal(rejected.length, 2);
  for (const r of rejected) assert.equal(r.reason.status, 402);
  assert.equal(bal(), 10, '余额精确 = 100 − 3×30，绝不为负');
  assertLedger('并发占扣期间恒等成立');
  for (const r of ok) credits.releaseHold(r.value, '并发测试释放');
  assert.equal(bal(), 100);
  assertLedger();
});

test('并发实扣不超卖：既有 charge 条件更新在 Promise.all 下恒等成立', async () => {
  setBalance(100);
  // 每笔 20000in/20000out → 0.2元 ×1.5/0.01 ≈ 30～31 分（向上取整），5 路并发只够放行 3 笔
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => (async () => {
    await new Promise(resolve => setImmediate(resolve));
    return credits.charge({ userId: U, feature: '并发实扣', kind: 'text', model: 'deepseek-v4-flash', usage: { inputTokens: 20000, outputTokens: 20000 }, aiMode: 'api' });
  })()));
  const ok = results.filter(r => r.status === 'fulfilled');
  assert.equal(ok.length, 3);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.status === 402).length, 2);
  const spent = ok.reduce((n, r) => n + r.value.credits, 0);
  assert.equal(bal(), 100 - spent, '余额精确 = 100 − Σ放行实扣，绝不为负');
  assert.ok(bal() >= 0, '并发下积分池绝不为负');
  assertLedger();
});

test('BE-H2/SSE：总参谋占扣不足时不开流——402 前不 writeHead、不留占扣、不产生流水', async () => {
  setBalance(6); // 通过老口径预检（sales 档需 5 分），但按实际内容占扣需 8+ 分 → 必须在开流前 402
  const logsBefore = db.prepare('SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=?').get(T).n;
  const user = { id: U, name: '两段式员工', role: 'sales', tenant_id: T };
  await withServer(user, async base => {
    const res = await fetch(`${base}/advisor/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '预检要通过但占扣要拦截的问题', stream: true }),
    });
    assert.equal(res.status, 402, '占扣不足必须 402，而不是先开流再报错');
    assert.match(res.headers.get('content-type') || '', /application\/json/, '必须是 JSON 拒绝，不是 event-stream');
    const body = await res.json();
    assert.match(body.error, /积分余额不足/);
    assert.equal(body.code, 'INSUFFICIENT_CREDITS');
    assert.equal(body.aiStatus, 'failed');
    assert.equal(body.deliveryState, 'failed');
    assert.equal(body.failurePhase, 'preflight');
    assert.equal(body.retryable, false, '额度未补足前不应误导用户直接重试');
    assert.match(body.retryHint, /充值|分配额度/);
    assert.equal(body.requestId, REQUEST_ID);
  });
  assert.equal(bal(), 6, '拒绝后余额分毫未动');
  assert.equal(heldCount(), 0, '不留悬挂占扣');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=?').get(T).n, logsBefore, '拒绝不产生流水');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM ai_messages WHERE tenant_id=? AND role='assistant'`).get(T).n, 0, '没有任何已交付答案');
  assertLedger();
});

test('BE-H2/SSE：元帅对话占扣不足时同样在开流前 402', async () => {
  setBalance(6);
  const user = { id: U, name: '两段式员工', role: 'sales', tenant_id: T };
  await withServer(user, async base => {
    const res = await fetch(`${base}/marshals/${M}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '预检要通过但占扣要拦截', stream: true }),
    });
    assert.equal(res.status, 402);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    assert.match((await res.json()).error, /积分余额不足/);
  });
  assert.equal(bal(), 6);
  assert.equal(heldCount(), 0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM marshal_chat_msgs WHERE tenant_id=? AND role='assistant'`).get(T).n, 0);
  assertLedger();
});

test('BE-H2/SSE 无真实AI时：先占扣再明确失败，不交付模板正文并全额退回', async () => {
  setBalance(1000);
  const user = { id: U, name: '两段式员工', role: 'sales', tenant_id: T };
  await withServer(user, async base => {
    const res = await fetch(`${base}/advisor/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '本月经营怎么破局', stream: true }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const events = (await res.text()).split('\n\n').filter(Boolean)
      .map(chunk => { try { return JSON.parse(chunk.replace(/^data: /, '')); } catch { return null; } })
      .filter(Boolean);
    assert.equal(events.some(e => e.done), false, '没有真实AI产出时不得发送 done 伪装交付');
    const failed = events.find(e => e.error);
    assert.ok(failed, '流必须返回可解释的失败事件');
    assert.equal(failed.code, 'AI_REAL_OUTPUT_REQUIRED');
    assert.equal(failed.aiStatus, 'failed');
    assert.equal(failed.deliveryState, 'failed');
    assert.equal(failed.failurePhase, 'generate');
    assert.equal(failed.retryable, true);
    assert.match(failed.retryHint, /原任务重试|上游状态/);
    assert.equal(failed.requestId, REQUEST_ID);
    assert.equal(failed.ai.mode, 'template');
    assert.ok(failed.ai.violations.includes('mode_not_api'));
    assert.ok(failed.ai.violations.includes('usage_missing'));
    assert.equal(failed.billing.state, 'released');
    assert.equal(failed.billing.credits, 0, '未交付产出时占扣全额退回');
  });
  assert.equal(bal(), 1000, '未交付结算后余额不变');
  assert.equal(heldCount(), 0, '占扣已全部结算');
  const lastLog = db.prepare('SELECT credits,ai_mode,note FROM credit_logs WHERE tenant_id=? ORDER BY id DESC LIMIT 1').get(T);
  assert.equal(lastLog.credits, 0);
  assert.equal(lastLog.ai_mode, 'failed');
  assert.match(lastLog.note, /阶段=generate/);
  assert.match(lastLog.note, /错误码=AI_REAL_OUTPUT_REQUIRED/);
  assert.match(lastLog.note, /预授权.*实扣0分/);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM ai_messages WHERE tenant_id=? AND role='assistant'`).get(T).n, 0);
  assertLedger();
});

test('BE-H1：视频任务提交占扣，异步上游 Fail 时全额退分并冲正流水', () => {
  setBalance(2000);
  runWithTenant(T, () => {
    const jobId = q.run(`INSERT INTO media_jobs(user_id,kind,model,prompt,status,task_id,credits) VALUES(?,?,?,?,?,?,?)`,
      U, 'video', 'happyhorse-1.0-t2v:floor', '测试失败退分', '处理中', 'task-fail-1', 1200).lastInsertRowid;
    // 模拟 /generate-video 提交时的占扣（happyhorse floor：8元 ×1.5/0.01 = 1200 分）
    const held = credits.holdCredits({
      userId: U, feature: 'AI视频生成', kind: 'video', model: 'happyhorse-1.0-t2v:floor',
      credits: credits.estimateMaxCredits('video', 'happyhorse-1.0-t2v:floor'),
      refType: 'media_job', refId: jobId,
    });
    assert.equal(held.credits, 1200);
    assert.equal(bal(), 800);
    assertLedger('视频占扣期间恒等成立');
    // 模拟轮询发现上游 Fail（refreshProcessingVideoJobs 的失败分支）
    const job = q.get('SELECT * FROM media_jobs WHERE tenant_id=? AND id=?', T, jobId);
    contentModule.refundVideoJobFailure(job);
    assert.equal(bal(), 2000, '客户不为失败产出付费：1200 分全额退回');
    const after = q.get('SELECT status,credits,error FROM media_jobs WHERE tenant_id=? AND id=?', T, jobId);
    assert.equal(after.status, '失败');
    assert.equal(after.credits, 0, '任务上不再显示已消耗积分');
    assert.match(after.error, /已退回1200积分/);
    assert.equal(db.prepare('SELECT credits FROM credit_logs WHERE id=?').get(held.logId).credits, 0, '流水冲正为 0 分并保留审计');
    assert.equal(heldCount(), 0);
    assertLedger();
    // 幂等：重复触发失败处理不会二次退款
    contentModule.refundVideoJobFailure(q.get('SELECT * FROM media_jobs WHERE tenant_id=? AND id=?', T, jobId));
    assert.equal(bal(), 2000);
    assertLedger();
  });
});

test('BE-H1：视频任务异步成功回填时确认实扣（余额保持扣减，流水记实扣）', () => {
  setBalance(2000);
  runWithTenant(T, () => {
    const jobId = q.run(`INSERT INTO media_jobs(user_id,kind,model,prompt,status,task_id,credits) VALUES(?,?,?,?,?,?,?)`,
      U, 'video', 'happyhorse-1.0-t2v:floor', '测试成功实扣', '处理中', 'task-ok-1', 1200).lastInsertRowid;
    const held = credits.holdCredits({
      userId: U, feature: 'AI视频生成', kind: 'video', model: 'happyhorse-1.0-t2v:floor',
      credits: credits.estimateMaxCredits('video', 'happyhorse-1.0-t2v:floor'),
      refType: 'media_job', refId: jobId,
    });
    const job = q.get('SELECT * FROM media_jobs WHERE tenant_id=? AND id=?', T, jobId);
    contentModule.settleVideoJobSuccess(job, 'https://cdn.example.com/v1.mp4');
    assert.equal(bal(), 800, '成功回填后实扣 1200 分');
    const after = q.get('SELECT status,url,credits FROM media_jobs WHERE tenant_id=? AND id=?', T, jobId);
    assert.equal(after.status, '成功');
    assert.equal(after.url, 'https://cdn.example.com/v1.mp4');
    assert.equal(after.credits, 1200);
    const log = db.prepare('SELECT credits,ai_mode FROM credit_logs WHERE id=?').get(held.logId);
    assert.equal(log.credits, 1200, '流水按提交时报价确认实扣');
    assert.equal(log.ai_mode, 'api');
    assert.equal(heldCount(), 0);
    assertLedger();
  });
});

test('cleanup', () => {
  for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
});
