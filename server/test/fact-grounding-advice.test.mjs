import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectUnconfirmedClaims, factGroundingAdvice } from '../src/engines/fact-grounding-advice.js';

test('只标记用户没确认过的具体说法；已确认事实、空正文不产生建议', () => {
  assert.deepEqual(detectUnconfirmedClaims('', '任意'), []);
  assert.deepEqual(factGroundingAdvice('周末，约上想见的人来店里聚一聚。点一份鲜切牛肉，围桌聊聊这一周。', ['鲜切牛肉', '周末聚餐']), []);
  const confirmed = ['我们的招牌是麻辣牛油锅底，人均68元，开了12年老店'];
  assert.deepEqual(detectUnconfirmedClaims('麻辣牛油锅底，人均68元，12年老店，欢迎来坐。', confirmed), []);
  const findings = detectUnconfirmedClaims('麻辣牛油锅底，人均 68 元，还有鲜嫩毛肚，情侣约会首选，网红打卡地。', confirmed);
  assert.deepEqual(findings.map(item => item.category), ['taste', 'audience', 'reputation']);
  assert.deepEqual(findings[0].terms, ['鲜嫩']);
});

test('价格、折扣、年限按原文片段列出，建议文案可直接给老板看', () => {
  const advice = factGroundingAdvice('新店开业全场8折，套餐¥99，传承30年老店手艺，秘制配方。', ['新店开业']);
  assert.equal(advice.length, 4);
  assert.match(advice[0], /配料\/工艺：秘制、传承/u);
  assert.match(advice[1], /顾客评价\/销量：老店/u);
  assert.match(advice[2], /价格\/折扣：8折、¥99/u);
  assert.match(advice[3], /年限\/历史：30年老店/u);
  for (const line of advice) assert.match(line, /发布前请核对/u);
});
