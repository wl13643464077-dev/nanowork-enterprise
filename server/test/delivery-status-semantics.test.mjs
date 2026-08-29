import assert from 'node:assert/strict';
import test from 'node:test';

import { BUSINESS_DELIVERY_LABELS } from '../src/engines/delivery-state.js';

test('业务交付状态统一表达是否可验收、可采用与失败处理责任', () => {
  assert.deepEqual(BUSINESS_DELIVERY_LABELS, {
    awaitingAssignment: '待派活',
    generating: '生成中',
    draft: '草稿（待提交人工审阅）',
    reviewReady: '可验收（待提交人工审阅）',
    reviewPending: '待人工审阅',
    adopted: '已人工采纳（可用于业务）',
    published: '已发布',
    businessBlocked: '业务暂不可采用（待账务对账）',
    qualityFailed: '失败需返工（质检未通过）',
    executionFailed: '失败需处理（执行异常）',
    reviewRejected: '失败需返工（人工审阅未通过）',
    remediated: '历史失败（后续已修复）',
    superseded: '已由安全修订版取代',
  });

  const labels = Object.values(BUSINESS_DELIVERY_LABELS);
  assert.equal(new Set(labels).size, labels.length, '不同业务状态不能共用同一展示文案');
  for (const label of labels) {
    assert.doesNotMatch(label, /可重跑|暂不可使用|待人工审核/u);
  }
});
