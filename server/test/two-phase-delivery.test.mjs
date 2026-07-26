import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  executeHeldDelivery,
  twoPhaseBillingSummary,
  withImmediateTransaction,
} from '../src/engines/two-phase-delivery.js';
import { executeContentDailyPackParts } from '../src/engines/content-employee-workbench.js';

const hold = Object.freeze({
  holdId: 7,
  logId: 8,
  credits: 30,
  balance: 70,
  model: 'test-model',
});

test('生成与原子落库成功后才结算，并返回真实 settled 状态', async () => {
  const events = [];
  const result = await executeHeldDelivery({
    hold,
    generate: async () => {
      events.push('generate');
      return { text: '已生成', usage: { inputTokens: 12, outputTokens: 8 }, model: 'm', mode: 'api' };
    },
    persist: output => {
      events.push(`persist:${output.text}`);
      return { id: 99 };
    },
    settle: (_held, args) => {
      events.push(`settle:${args.model}`);
      return { credits: 3, balance: 97, costYuan: 0.02 };
    },
    release: () => assert.fail('成功交付不得释放占扣'),
    settlement: output => ({
      usage: output.usage,
      model: output.model,
      aiMode: output.mode,
    }),
  });
  assert.deepEqual(events, ['generate', 'persist:已生成', 'settle:m']);
  assert.equal(result.delivery.id, 99);
  assert.deepEqual(result.billing, {
    state: 'settled',
    holdId: 7,
    estimatedCredits: 30,
    heldCredits: 0,
    chargedCredits: 3,
    credits: 3,
    balance: 97,
    costYuan: 0.02,
    pendingReconciliation: false,
    note: '业务产物已交付，并按真实用量完成结算。',
    error: null,
  });
});

for (const failingPhase of ['generate', 'persist']) {
  test(`${failingPhase}失败视为未交付并全额释放`, async () => {
    const events = [];
    await assert.rejects(
      executeHeldDelivery({
        hold,
        generate: async () => {
          events.push('generate');
          if (failingPhase === 'generate') throw new Error('上游失败');
          return { text: '供应商已返回' };
        },
        persist: () => {
          events.push('persist');
          if (failingPhase === 'persist') throw new Error('落库失败');
          return { id: 1 };
        },
        settle: () => assert.fail('未交付不得结算'),
        release: () => {
          events.push('release');
          return { credits: 0, balance: 100 };
        },
      }),
      error => {
        assert.equal(error.deliveryPhase, failingPhase);
        assert.equal(error.billing.state, 'released');
        assert.equal(error.billing.chargedCredits, 0);
        assert.equal(error.billing.balance, 100);
        return true;
      },
    );
    assert.equal(events.at(-1), 'release');
  });
}

test('释放异常保留 hold 待对账，不能谎称已退款', async () => {
  await assert.rejects(
    executeHeldDelivery({
      hold,
      generate: async () => { throw new Error('供应商失败'); },
      persist: () => assert.fail('不应落库'),
      settle: () => assert.fail('不应结算'),
      release: () => { throw new Error('数据库繁忙'); },
    }),
    error => {
      assert.equal(error.billing.state, 'pending_reconciliation');
      assert.equal(error.billing.heldCredits, 30);
      assert.equal(error.billing.chargedCredits, null);
      assert.match(error.billing.error, /数据库繁忙/);
      return true;
    },
  );
});

test('结算异常保留已交付产物与 hold，并显式标记 pending_reconciliation', async () => {
  let marked = null;
  const result = await executeHeldDelivery({
    hold,
    generate: async () => ({ text: '可交付产物' }),
    persist: () => ({ id: 123 }),
    settle: () => { throw new Error('结算事务失败'); },
    release: () => assert.fail('已交付不得退款'),
    onPendingReconciliation: event => { marked = event; },
  });
  assert.equal(result.delivery.id, 123);
  assert.equal(result.billing.state, 'pending_reconciliation');
  assert.equal(result.billing.heldCredits, 30);
  assert.equal(result.billing.chargedCredits, null);
  assert.match(result.billing.error, /结算事务失败/);
  assert.equal(marked.delivery.id, 123);
});

test('事务包装器在落库异常时回滚，不允许异步工作函数', () => {
  const events = [];
  const fakeDb = { exec: sql => events.push(sql) };
  assert.throws(() => withImmediateTransaction(fakeDb, () => {
    events.push('write');
    throw new Error('write failed');
  }), /write failed/);
  assert.deepEqual(events, ['BEGIN IMMEDIATE', 'write', 'ROLLBACK']);

  events.length = 0;
  assert.throws(() => withImmediateTransaction(fakeDb, async () => 1), /必须是同步函数/);
  assert.deepEqual(events, ['BEGIN IMMEDIATE', 'ROLLBACK']);
});

test('held 摘要不会把占扣金额说成已实扣', () => {
  const summary = twoPhaseBillingSummary({ state: 'held', hold, note: '等待供应商' });
  assert.equal(summary.heldCredits, 30);
  assert.equal(summary.chargedCredits, null);
  assert.equal(summary.pendingReconciliation, false);
});

test('日更包三个子任务各自占扣/落库/结算，单项失败只退款本项', async () => {
  let balance = 90;
  let holdSeq = 0;
  const events = [];
  const parts = [
    { type: '短视频脚本', count: 3 },
    { type: '朋友圈文案', count: 5 },
    { type: '社群话题', count: 3 },
  ];
  const run = await executeContentDailyPackParts(parts, async part => {
    const itemHold = {
      holdId: ++holdSeq,
      credits: 20,
      balance: balance -= 20,
      model: 'test-model',
    };
    events.push(`hold:${part.type}:${balance}`);
    const result = await executeHeldDelivery({
      hold: itemHold,
      generate: async () => {
        events.push(`generate:${part.type}`);
        if (part.type === '朋友圈文案') throw new Error('本子任务上游失败');
        return { text: `${part.type}产物`, usage: {}, mode: 'api', model: 'test-model' };
      },
      persist: output => {
        events.push(`persist:${part.type}`);
        return { id: itemHold.holdId, body: output.text };
      },
      settle: held => {
        balance += held.credits - 5;
        events.push(`settle:${part.type}:${balance}`);
        return { credits: 5, balance };
      },
      release: held => {
        balance += held.credits;
        events.push(`release:${part.type}:${balance}`);
        return { credits: 0, balance };
      },
      settlement: output => ({ usage: output.usage, model: output.model, aiMode: output.mode }),
    });
    return { type: part.type, count: part.count, ...result.delivery, billing: result.billing };
  });

  assert.equal(run.status, 'partial');
  assert.deepEqual(run.successes.map(item => item.type), ['短视频脚本', '社群话题']);
  assert.deepEqual(run.failures.map(item => item.type), ['朋友圈文案']);
  assert.equal(run.failures[0].billing.state, 'released');
  assert.equal(run.successes.every(item => item.billing.state === 'settled'), true);
  assert.equal(balance, 80, '只实扣两个成功子任务各5分，失败子任务完整退款');
  assert.ok(events.includes('release:朋友圈文案:85'));
  assert.equal(events.some(event => event.startsWith('persist:朋友圈文案')), false);
});
