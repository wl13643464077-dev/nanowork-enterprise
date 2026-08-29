import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-advisor-two-phase-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
}

process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.BOCHA_API_KEY = '';
process.env.TAVILY_API_KEY = '';
process.env.SERPER_API_KEY = '';
process.env.SEED_DEMO = 'false';

const {
  db,
  qRaw,
  initSchema,
  migrateV2,
  runWithTenant,
} = await import('../src/db.js');
const {
  balanceOfTenant,
  holdCredits,
  releaseHold,
} = await import('../src/engines/credits.js');
const {
  createAdvisorChatHandler,
} = await import('../src/routes/advisor.js');

initSchema();
migrateV2();

const tenantId = Number(qRaw.run(
  "INSERT INTO tenants(name,status,credits) VALUES('顾问两阶段计费企业','已开通',5000)",
).lastInsertRowid);
const userId = Number(qRaw.run(
  `INSERT INTO users(username,password_hash,name,role,tenant_id)
   VALUES('advisor-two-phase-u','x','顾问计费用户','boss',?)`,
  tenantId,
).lastInsertRowid);
const user = {
  id: userId,
  name: '顾问计费用户',
  role: 'boss',
  tenant_id: tenantId,
};
const REQUEST_ID = 'advisor-two-phase-request';
const bootstrapHold = holdCredits({
  userId,
  feature: '顾问两阶段测试初始化',
  kind: 'text',
  model: 'deepseek-v4-flash',
  credits: 1,
});
releaseHold(bootstrapHold, '顾问两阶段测试初始化完成');

const providerOutput = {
  text: '【问题本质】先核实真实经营数据。\n【执行动作】今日复核漏斗。',
  mode: 'api',
  model: 'deepseek-v4-flash',
  usage: { inputTokens: 180, outputTokens: 70 },
  kb: { refs: [], degraded: false, mode: 'hot' },
};

function makeApp(overrides = {}) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => runWithTenant(tenantId, () => {
    req.user = user;
    req.requestId = REQUEST_ID;
    next();
  }));
  app.post('/advisor/chat', createAdvisorChatHandler(overrides));
  return app;
}

async function withServer(overrides, fn) {
  const server = makeApp(overrides).listen(0, '127.0.0.1');
  const port = await new Promise(resolve => {
    server.once('listening', () => resolve(server.address().port));
  });
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function post(base, body) {
  const response = await fetch(`${base}/advisor/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    response,
    payload: await response.json(),
  };
}

const heldRows = () => db.prepare(
  `SELECT * FROM credit_holds
   WHERE tenant_id=? AND status='held'
   ORDER BY id`,
).all(tenantId);

const latestAdvisorLog = () => db.prepare(
  `SELECT ai_mode,credits,note FROM credit_logs
   WHERE tenant_id=? AND feature LIKE '老板参谋%'
   ORDER BY id DESC LIMIT 1`,
).get(tenantId);

test('顾问联网检索与供应商/RAG 调用都发生在额度预授权之后，落库完成后才结算', async () => {
  const events = [];
  const before = balanceOfTenant(tenantId);
  await withServer({
    webSearchFn: async () => {
      assert.equal(heldRows().length, 1, '联网检索前必须已经存在 held 预授权');
      events.push('web');
      return {
        ok: true,
        provider: 'local-fake-web',
        results: [{
          title: '本地假搜索证据',
          url: 'https://evidence.invalid/advisor',
          snippet: '这是隔离测试中的本地假搜索结果，不访问公网。',
        }],
        note: null,
      };
    },
    advisorReplyFn: async args => {
      assert.equal(heldRows().length, 1, '供应商/RAG 入口前必须仍为 held');
      assert.equal(args.webRefs.length, 1);
      events.push('provider');
      return providerOutput;
    },
    settleHoldFn: (hold, settlement) => {
      const assistant = db.prepare(
        `SELECT id,content FROM ai_messages
         WHERE tenant_id=? AND role='assistant'
         ORDER BY id DESC LIMIT 1`,
      ).get(tenantId);
      assert.ok(assistant?.id, '结算前助手业务产物必须已经落库');
      assert.equal(
        db.prepare(
          `SELECT ref_type,ref_id FROM credit_holds WHERE tenant_id=? AND id=?`,
        ).get(tenantId, hold.holdId).ref_id,
        assistant.id,
        '占扣必须在业务事务中关联到最终助手消息',
      );
      events.push('settle');
      return releaseHold(hold, settlement.note);
    },
  }, async base => {
    const result = await post(base, {
      question: '请根据联网证据判断本周客流问题',
      web: true,
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.billing.state, 'settled');
    assert.equal(result.payload.billing.chargedCredits, 0);
    assert.equal(result.payload.mode, 'api');
    assert.equal(result.payload.model, providerOutput.model);
    assert.deepEqual(result.payload.usage, providerOutput.usage);
    assert.equal(result.payload.aiStatus, 'succeeded');
    assert.equal(result.payload.deliveryState, 'succeeded');
    assert.equal(result.payload.retryable, false);
    assert.equal(result.payload.sources[0].title, '本地假搜索证据');
  });
  assert.deepEqual(events, ['web', 'provider', 'settle']);
  assert.equal(heldRows().length, 0);
  assert.equal(balanceOfTenant(tenantId), before);
});

test('顾问降级为模板或零token时明确失败，不保存助手产出并可在原会话重试', async () => {
  const before = balanceOfTenant(tenantId);
  const assistantsBefore = db.prepare(
    `SELECT COUNT(*) n FROM ai_messages WHERE tenant_id=? AND role='assistant'`,
  ).get(tenantId).n;

  await withServer({
    advisorReplyFn: async () => ({
      text: '这是不能冒充交付的本地模板',
      mode: 'template',
      model: 'template',
      usage: { inputTokens: 0, outputTokens: 0 },
      kb: { refs: [], degraded: true, mode: 'hot' },
    }),
  }, async base => {
    const failed = await post(base, { question: '强制顾问模板降级' });
    assert.equal(failed.response.status, 502, JSON.stringify(failed.payload));
    assert.equal(failed.payload.code, 'AI_REAL_OUTPUT_REQUIRED');
    assert.equal(failed.payload.aiStatus, 'failed');
    assert.equal(failed.payload.deliveryState, 'failed');
    assert.equal(failed.payload.failurePhase, 'generate');
    assert.equal(failed.payload.retryable, true);
    assert.match(failed.payload.retryHint, /原任务重试|上游状态/);
    assert.equal(failed.payload.requestId, REQUEST_ID);
    assert.ok(failed.payload.conversationId);
    assert.equal(failed.payload.ai.mode, 'template');
    assert.ok(failed.payload.ai.violations.includes('mode_not_api'));
    assert.ok(failed.payload.ai.violations.includes('usage_missing'));
    assert.deepEqual(failed.payload.ai.usage, { inputTokens: 0, outputTokens: 0 });
    assert.equal(failed.payload.billing.state, 'released');
    assert.equal(failed.payload.billing.chargedCredits, 0);
  });

  assert.equal(
    db.prepare(`SELECT COUNT(*) n FROM ai_messages WHERE tenant_id=? AND role='assistant'`).get(tenantId).n,
    assistantsBefore,
  );
  assert.equal(heldRows().length, 0);
  assert.equal(balanceOfTenant(tenantId), before);
  const log = latestAdvisorLog();
  assert.equal(log.ai_mode, 'failed');
  assert.equal(log.credits, 0);
  assert.match(log.note, /阶段=generate/);
  assert.match(log.note, /错误码=AI_REAL_OUTPUT_REQUIRED/);
});

test('顾问上游超时时保留可诊断错误码，不交付助手消息并全额退回', async () => {
  const before = balanceOfTenant(tenantId);
  const assistantsBefore = db.prepare(
    `SELECT COUNT(*) n FROM ai_messages WHERE tenant_id=? AND role='assistant'`,
  ).get(tenantId).n;

  await withServer({
    advisorReplyFn: async () => {
      throw Object.assign(new Error('注入的上游超时'), {
        status: 504,
        code: 'AI_PROVIDER_TIMEOUT',
      });
    },
  }, async base => {
    const failed = await post(base, { question: '强制顾问上游超时' });
    assert.equal(failed.response.status, 504, JSON.stringify(failed.payload));
    assert.equal(failed.payload.code, 'AI_PROVIDER_TIMEOUT');
    assert.equal(failed.payload.deliveryState, 'failed');
    assert.equal(failed.payload.failurePhase, 'generate');
    assert.equal(failed.payload.retryable, true);
    assert.match(failed.payload.retryHint, /上游超时/);
    assert.equal(failed.payload.requestId, REQUEST_ID);
    assert.equal(failed.payload.billing.state, 'released');
    assert.equal(failed.payload.billing.chargedCredits, 0);
  });

  assert.equal(
    db.prepare(`SELECT COUNT(*) n FROM ai_messages WHERE tenant_id=? AND role='assistant'`).get(tenantId).n,
    assistantsBefore,
  );
  assert.equal(heldRows().length, 0);
  assert.equal(balanceOfTenant(tenantId), before);
  const log = latestAdvisorLog();
  assert.equal(log.ai_mode, 'failed');
  assert.equal(log.credits, 0);
  assert.match(log.note, /阶段=generate/);
  assert.match(log.note, /错误码=AI_PROVIDER_TIMEOUT/);
});

test('顾问业务产物事务中后置步骤失败会整体回滚，并全额释放预授权', async () => {
  const before = balanceOfTenant(tenantId);
  const assistantsBefore = db.prepare(
    `SELECT COUNT(*) n FROM ai_messages WHERE tenant_id=? AND role='assistant'`,
  ).get(tenantId).n;
  const approvalsBefore = db.prepare(
    `SELECT COUNT(*) n FROM approvals WHERE tenant_id=?`,
  ).get(tenantId).n;

  await withServer({
    advisorReplyFn: async () => ({
      ...providerOutput,
      text: '这是必须整体回滚的回答，保证必赚。',
      kb: {
        refs: [{ id: 999, title: '本地假知识文档', category: '测试' }],
        degraded: false,
        mode: 'hot',
      },
    }),
    recordKbCitationsFn: () => {
      throw new Error('injected advisor citation persistence failure');
    },
  }, async base => {
    const failed = await post(base, {
      question: '强制顾问业务事务回滚',
    });
    assert.equal(failed.response.status, 500);
    assert.equal(failed.payload.code, 'AI_DELIVERY_FAILED');
    assert.equal(failed.payload.deliveryState, 'failed');
    assert.equal(failed.payload.failurePhase, 'persist');
    assert.equal(failed.payload.retryable, true);
    assert.equal(failed.payload.requestId, REQUEST_ID);
    assert.equal(failed.payload.billing.state, 'released');
    assert.equal(failed.payload.billing.chargedCredits, 0);
  });

  assert.equal(
    db.prepare(
      `SELECT COUNT(*) n FROM ai_messages WHERE tenant_id=? AND role='assistant'`,
    ).get(tenantId).n,
    assistantsBefore,
    '助手消息必须随事务整体回滚',
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) n FROM approvals WHERE tenant_id=?`).get(tenantId).n,
    approvalsBefore,
    '已经创建的风控审批也必须随事务整体回滚',
  );
  assert.equal(heldRows().length, 0);
  assert.equal(balanceOfTenant(tenantId), before);
  const log = latestAdvisorLog();
  assert.equal(log.ai_mode, 'failed');
  assert.match(log.note, /阶段=persist/);
  assert.match(log.note, /错误码=AI_DELIVERY_FAILED/);
});

test('顾问结算失败保留已交付产物和 held 账目，并明确返回 pending_reconciliation', async () => {
  const before = balanceOfTenant(tenantId);
  db.exec(`CREATE TRIGGER injected_advisor_settlement_failure
    BEFORE UPDATE OF status ON credit_holds
    WHEN OLD.tenant_id=${tenantId}
      AND OLD.status='held'
      AND NEW.status='settled'
      AND OLD.feature LIKE '老板参谋%'
    BEGIN
      SELECT RAISE(ABORT,'injected advisor settlement failure');
    END`);
  try {
    await withServer({
      advisorReplyFn: async () => providerOutput,
    }, async base => {
      const result = await post(base, {
        question: '强制顾问结算进入待对账',
      });
      assert.equal(result.response.status, 200, JSON.stringify(result.payload));
      assert.equal(result.payload.billing.state, 'pending_reconciliation');
      assert.equal(result.payload.billing.chargedCredits, null);
      assert.equal(result.payload.billing.heldCredits > 0, true);
      const assistant = db.prepare(
        `SELECT id FROM ai_messages
         WHERE tenant_id=? AND role='assistant' AND content LIKE ?
         ORDER BY id DESC LIMIT 1`,
      ).get(tenantId, `${providerOutput.text}%`);
      assert.ok(assistant?.id, '结算失败不能回滚已经交付的助手消息');
      const pending = heldRows().at(-1);
      assert.equal(pending.ref_type, 'ai_message');
      assert.equal(pending.ref_id, assistant.id);
      assert.equal(
        balanceOfTenant(tenantId),
        before - result.payload.billing.heldCredits,
      );
    });
  } finally {
    db.exec('DROP TRIGGER IF EXISTS injected_advisor_settlement_failure');
    for (const row of heldRows()) {
      releaseHold({
        holdId: row.id,
        logId: row.log_id,
        tenantId: row.tenant_id,
        userId: row.user_id,
        feature: row.feature,
        kind: row.kind,
        model: row.model,
        credits: row.held_credits,
        balance: null,
      }, '顾问待对账测试清理');
    }
  }
});

test('顾问 SSE 在业务落库失败前不泄露模型增量，失败账单返回 released', async () => {
  const leaked = '不应在落库失败前交付的模型内容';
  const before = balanceOfTenant(tenantId);
  await withServer({
    advisorReplyFn: async args => {
      args.onDelta?.(leaked);
      return {
        ...providerOutput,
        text: leaked,
      };
    },
    recordKbCitationsFn: () => {
      throw new Error('injected advisor SSE persistence failure');
    },
  }, async base => {
    const response = await fetch(`${base}/advisor/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '强制 SSE 产物落库失败',
        stream: true,
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    const body = await response.text();
    assert.doesNotMatch(body, new RegExp(leaked), '落库失败前不得把模型正文增量交付客户端');
    const events = body.split('\n\n').filter(Boolean)
      .map(chunk => JSON.parse(chunk.replace(/^data: /, '')));
    const error = events.find(event => event.error);
    assert.equal(error.deliveryState, 'failed');
    assert.equal(error.failurePhase, 'persist');
    assert.equal(error.requestId, REQUEST_ID);
    assert.equal(error.billing.state, 'released');
  });
  assert.equal(heldRows().length, 0);
  assert.equal(balanceOfTenant(tenantId), before);
});

after(() => {
  delete process.env.YUNWU_API_KEY;
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
  }
});
