import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DBP = path.join(os.tmpdir(), `nanowork-ai-delivery-status-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
}
process.env.NANOWORK_DB = DBP;
process.env.SEED_DEMO = 'false';

const { db, qRaw, initSchema, migrateV2 } = await import('../src/db.js');
const { balanceOfTenant, holdCredits } = await import('../src/engines/credits.js');
const {
  aiFailurePayload,
  aiFailureReleaseNote,
  assertRealAiOutput,
  realAiOutputViolations,
  releaseFailedAiHold,
} = await import('../src/engines/ai-delivery-status.js');

initSchema();
migrateV2();
const tenantId = Number(qRaw.run(
  "INSERT INTO tenants(name,status,credits) VALUES('AI失败状态测试','已开通',100)",
).lastInsertRowid);
const userId = Number(qRaw.run(
  `INSERT INTO users(username,password_hash,name,role,tenant_id)
   VALUES('ai-delivery-status-u','x','AI失败状态用户','boss',?)`,
  tenantId,
).lastInsertRowid);

test('真实AI门禁统一识别模板、空输出、模板模型和零token', () => {
  const output = {
    text: '   ',
    mode: 'template',
    model: 'template',
    usage: { inputTokens: Number.NaN, outputTokens: -1 },
  };
  const diagnosis = realAiOutputViolations(output);
  assert.deepEqual(diagnosis.evidence.usage, { inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(diagnosis.violations, [
    'mode_not_api',
    'empty_output',
    'model_not_real',
    'usage_missing',
  ]);
  assert.throws(
    () => assertRealAiOutput(output, { label: '统一门禁测试' }),
    error => error.code === 'AI_REAL_OUTPUT_REQUIRED'
      && error.status === 502
      && error.retryable === true
      && error.ai.violations.includes('usage_missing'),
  );
});

test('真实AI门禁不接受对象或数字冒充文本交付', () => {
  const diagnosis = realAiOutputViolations({
    text: { answer: '不能靠隐式转字符落库' },
    mode: 'api',
    model: 'gpt-5.5',
    usage: { inputTokens: 12, outputTokens: 8 },
  });
  assert.deepEqual(diagnosis.violations, ['text_not_string']);
});

test('真实AI门禁接受有正文、真实模型和正token的api产出', () => {
  const evidence = assertRealAiOutput({
    text: '已生成可执行结果',
    mode: 'api',
    model: 'gpt-5.5',
    usage: { inputTokens: 12.9, outputTokens: 5.2 },
  });
  assert.deepEqual(evidence, {
    mode: 'api',
    model: 'gpt-5.5',
    usage: { inputTokens: 12, outputTokens: 5 },
  });
});

test('统一错误结构区分不可直接重试的402与可重试的上游超时', () => {
  const insufficient = aiFailurePayload(Object.assign(new Error('积分不足'), {
    status: 402,
    code: 'INSUFFICIENT_CREDITS',
  }), { requestId: 'req-402' });
  assert.equal(insufficient.deliveryState, 'failed');
  assert.equal(insufficient.failurePhase, 'preflight');
  assert.equal(insufficient.retryable, false);
  assert.match(insufficient.retryHint, /充值|分配额度/);
  assert.equal(insufficient.requestId, 'req-402');

  const timeoutError = Object.assign(new Error('上游超时'), {
    status: 504,
    code: 'AI_PROVIDER_TIMEOUT',
    deliveryPhase: 'generate',
  });
  const timeout = aiFailurePayload(timeoutError);
  assert.equal(timeout.retryable, true);
  assert.equal(timeout.failurePhase, 'generate');
  assert.match(timeout.retryHint, /原任务重试/);

  const network = aiFailurePayload(Object.assign(new TypeError('fetch failed'), {
    cause: { code: 'ECONNRESET' },
    deliveryPhase: 'generate',
  }));
  assert.equal(network.code, 'AI_PROVIDER_NETWORK_ERROR');
  assert.equal(network.failurePhase, 'generate');
  assert.equal(network.retryable, true);
  assert.match(network.retryHint, /网络连接失败/);

  const rawTimeoutCode = aiFailurePayload(Object.assign(new Error('socket stopped'), {
    code: 'ETIMEDOUT',
    deliveryPhase: 'generate',
  }));
  assert.equal(rawTimeoutCode.code, 'AI_PROVIDER_TIMEOUT');
});

test('失败退款流水标记failed，保留阶段、错误码且不改变余额', () => {
  const before = balanceOfTenant(tenantId);
  const hold = holdCredits({
    userId,
    feature: 'AI失败状态专项',
    kind: 'text',
    model: 'gpt-5.5',
    credits: 10,
  });
  const error = Object.assign(new Error('上游网络中断'), {
    code: 'AI_PROVIDER_NETWORK_ERROR',
  });
  const note = aiFailureReleaseNote('专项测试')(error, 'generate');
  const released = releaseFailedAiHold(hold, note);
  assert.equal(released.credits, 0);
  assert.equal(balanceOfTenant(tenantId), before);
  const log = db.prepare(`SELECT ai_mode,credits,note FROM credit_logs
    WHERE tenant_id=? AND id=?`).get(tenantId, hold.logId);
  assert.equal(log.ai_mode, 'failed');
  assert.equal(log.credits, 0);
  assert.match(log.note, /阶段=generate/);
  assert.match(log.note, /错误码=AI_PROVIDER_NETWORK_ERROR/);
  assert.match(log.note, /预授权.*实扣0分/);
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* clean test database */ }
  }
});
