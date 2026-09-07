import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeHeldDelivery } from '../src/engines/two-phase-delivery.js';
const hold = { holdId: 91, tenantId: 7, userId: 8, credits: 50, balance: 50 };
const forbidden = () => assert.fail('不得调用该计费路径');
for (const phase of ['generate', 'persist']) {
  test(`最终${phase}失败无成果全退；供应商状态未知不保留用户占扣、不自动再生成`, async () => {
    let calls = 0, refunds = 0;
    await assert.rejects(executeHeldDelivery({ hold,
      externalInvocationStarted: () => true,
      generate: async () => { calls++; if (phase === 'generate') throw new Error('unknown upstream outcome'); return { text: '已返回但无法保存' }; },
      persist: () => { throw new Error('save failed'); },
      hasDeliverable: () => false,
      settle: forbidden, release: forbidden,
      refund: received => { assert.equal(received, hold); refunds++; return { credits: 0, refundedCredits: 50, balance: 100, costYuan: null, supplierCostStatus: 'pending' }; },
    }), error => {
      assert.equal(error.billing.state, 'released');
      assert.equal(error.billing.chargedCredits, 0);
      assert.equal(error.billing.refundedCredits, 50);
      assert.equal(error.billing.balance, 100);
      return true;
    });
    assert.equal(calls, 1); assert.equal(refunds, 1);
  });
}

test('调用前失败只释放未用预授权，不伪造供应商退款费用', async () => {
  let released = 0;
  await assert.rejects(executeHeldDelivery({ hold,
    externalInvocationStarted: () => false,
    generate: async () => { throw new Error('local input invalid'); }, persist: forbidden, settle: forbidden,
    hasDeliverable: () => false, refund: forbidden,
    release: () => { released++; return { credits: 0, balance: 100, costYuan: 0 }; },
  }), error => error.billing.state === 'released' && error.billing.balance === 100);
  assert.equal(released, 1);
});

for (const durable of [true, 'unreadable']) {
  test(`已有结果或成果读取异常（${durable}）保留结果待核对，不错误退款`, async () => {
    await assert.rejects(executeHeldDelivery({ hold, externalInvocationStarted: () => true,
      generate: async () => ({ text: '已生成正文' }), persist: () => { throw new Error('post-save metadata failed'); },
      hasDeliverable: () => { if (durable === 'unreadable') throw new Error('db temporarily unavailable'); return true; },
      settle: forbidden, release: forbidden, refund: forbidden,
    }), error => error.billing.state === 'pending_reconciliation' && error.billing.chargedCredits === null);
  });
}

test('退款写入失败不能声称用户已收到积分，保留待处理且不重新调用', async () => {
  let calls = 0;
  await assert.rejects(executeHeldDelivery({ hold, externalInvocationStarted: () => true,
    generate: async () => { calls++; throw new Error('provider failed'); }, persist: forbidden, settle: forbidden, release: forbidden,
    hasDeliverable: () => false, refund: () => { throw new Error('refund transaction failed'); },
  }), error => error.billing.state === 'pending_reconciliation' && error.billing.chargedCredits === null);
  assert.equal(calls, 1);
});

test('已保存最终结果但结算失败只待对账，正文仍交付且不退款', async () => {
  const result = await executeHeldDelivery({ hold, externalInvocationStarted: () => true,
    generate: async () => ({ text: '完整最终正文' }), persist: output => ({ id: 5, body: output.text }),
    hasDeliverable: () => true, settle: () => { throw new Error('billing unavailable'); }, release: forbidden, refund: forbidden,
  });
  assert.equal(result.delivery.body, '完整最终正文');
  assert.equal(result.billing.state, 'pending_reconciliation');
});
