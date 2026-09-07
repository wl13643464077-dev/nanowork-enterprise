import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiSalesVideoNeedsWeb } from '../src/engines/ai-sales-video.js';

test('品牌官方口吻与禁止编造事实不触发无关联网', () => {
  assert.equal(aiSalesVideoNeedsWeb('以当前门店官方账号口吻介绍上传的火锅图'), false);
  assert.equal(aiSalesVideoNeedsWeb('不要编造最新优惠、实时热度或销量。无需联网。'), false);
});
test('明确实时检索仍联网，否定句不吞掉随后明确查询', () => {
  assert.equal(aiSalesVideoNeedsWeb('结合最新官方信息介绍招牌菜'), true);
  assert.equal(aiSalesVideoNeedsWeb('不要编造最新优惠，但请联网查询最新平台规则'), true);
});
