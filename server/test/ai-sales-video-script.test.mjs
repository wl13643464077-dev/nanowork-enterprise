import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.NODE_ENV = 'test';
process.env.NANOWORK_DB = ':memory:';
process.env.YUNWU_API_KEY = '';
const {
  validateAiSalesVideoScript,
  generateAiSalesVideoScript,
  condenseAiSalesVideoShot,
  countSpeechChars,
  buildAiSalesVideoScriptPrompt,
} = await import('../src/engines/ai-sales-video-script.js');

export function validScript() {
  const a = '今天吃什么？' + '口味可以按自己的喜好来选。'.repeat(4);
  const b = '想知道菜品详情吗？' + '口味可以按自己的喜好来选。'.repeat(3) + '选好再下单。到店咨询详情。';
  return {
    hook_3s: '今天吃什么？',
    shots: [a, b].map((voiceover, i) => ({
      index: i + 1,
      start: i * 15,
      end: (i + 1) * 15,
      visual: '菜品近景',
      voiceover,
      subtitle: voiceover,
      sfx: '无',
      reference_hint: 'dish',
    })),
    cta: '到店咨询详情。',
    facts_used: [],
    total_chars: countSpeechChars(a + b),
    estimated_seconds: 30,
    risk_flags: [],
  };
}
const output = script => ({
  mode: 'api',
  model: 'test-text',
  usage: { inputTokens: 1200, outputTokens: 450 },
  text: JSON.stringify(script),
});

test('独白完整schema正例，不补缺字段、不忽略额外控制字段', () => {
  const script = validScript();
  assert.equal(validateAiSalesVideoScript(script).ok, true, JSON.stringify(validateAiSalesVideoScript(script).errors));
  for (const key of ['risk_flags', 'facts_used', 'cta']) {
    const bad = structuredClone(script);
    delete bad[key];
    assert.equal(validateAiSalesVideoScript(bad).ok, false, key);
  }
  assert.equal(validateAiSalesVideoScript({ ...script, approve: true }).ok, false);
  assert.equal(validateAiSalesVideoScript({ ...script, total_chars: 1.5 }).ok, false);
  assert.equal(validateAiSalesVideoScript({ ...script, hook_3s: { text: script.hook_3s } }).ok, false);
  const timeString = structuredClone(script);
  timeString.shots[0].start = '0';
  assert.equal(validateAiSalesVideoScript(timeString).ok, false);
});
test('字幕必须对应口播，风控异常不可按未命中放行', () => {
  const bad = validScript();
  bad.shots[0].subtitle = '这里换成另一段话。';
  assert.equal(validateAiSalesVideoScript(bad).ok, false);
  assert.equal(
    validateAiSalesVideoScript(validScript(), {
      scanText: () => {
        throw new Error('unavailable');
      },
    }).ok,
    false,
  );
});
test('登记事实声明不能伪造，顾客原句也不能偷偷写在画面说明', () => {
  const pack = {
    facts: [
      { id: 'name', kind: 'store_name', value: '测试餐厅', claim: '门店名称：测试餐厅' },
      {
        id: 'review',
        kind: 'review_quote',
        usage: 'internal_evidence',
        value: '这是顾客提供的一句内部评价',
        claim: '这是顾客提供的一句内部评价',
      },
    ],
  };
  const script = validScript();
  script.shots[0].visual = '测试餐厅的菜品近景';
  script.facts_used = [{ factId: 'name', claim: '门店名称：测试餐厅' }];
  assert.equal(validateAiSalesVideoScript(script, { pack }).ok, true);
  script.facts_used[0].claim = '门店名称：另一家店';
  assert.equal(validateAiSalesVideoScript(script, { pack }).ok, false);
  const quote = validScript();
  quote.shots[1].visual = pack.facts[1].value;
  assert.equal(validateAiSalesVideoScript(quote, { pack }).ok, false);
});
test('精简不能改非目标段标点、画面、CTA、事实，合法改写仅更新目标口播字幕', async () => {
  for (const mutate of [
    s => {
      s.shots[1].visual = '改成别的画面';
    },
    s => {
      s.shots[1].voiceover = s.shots[1].voiceover.replace('？', '！');
      s.shots[1].subtitle = s.shots[1].voiceover;
    },
    s => {
      s.shots[0].sfx = '新的音乐';
    },
  ]) {
    const script = validScript(),
      altered = structuredClone(script);
    mutate(altered);
    await assert.rejects(
      condenseAiSalesVideoShot({ script, shotIndex: 1, measuredSeconds: 18, generateFn: async () => output(altered) }),
      /非目标|字段|改动/u,
    );
  }
  const script = validScript(),
    altered = structuredClone(script);
  altered.shots[0].voiceover = altered.shots[0].voiceover.replace('自己的', '个人的');
  altered.shots[0].subtitle = altered.shots[0].voiceover;
  const result = await condenseAiSalesVideoShot({
    script,
    shotIndex: 1,
    measuredSeconds: 18,
    generateFn: async () => output(altered),
  });
  assert.equal(result.script.shots[0].voiceover, altered.shots[0].voiceover);
});
test('最多两次脚本调用，模板不冒充产出；输入边界和修复计数可核验', async () => {
  let calls = 0;
  await assert.rejects(
    generateAiSalesVideoScript({
      brief: '本店带货',
      maxAttempts: 20,
      generateFn: async () => {
        calls += 1;
        return { ...output({}), text: '{}' };
      },
    }),
  );
  assert.equal(calls, 2);
  await assert.rejects(
    generateAiSalesVideoScript({
      brief: '本店带货',
      generateFn: async () => ({ mode: 'template', text: JSON.stringify(validScript()) }),
    }),
    /模板/u,
  );
  const seen = [];
  const result = await generateAiSalesVideoScript({
    brief: '本店带货',
    generateFn: async p => {
      seen.push(p);
      return output(seen.length === 1 ? {} : validScript());
    },
  });
  assert.equal(result.attempts.length, 2);
  assert.equal(result.usage.inputTokens, 2400);
  assert.match(seen[1].userMsg, /校验失败原因/u);
});
test('已确认结构卡和人工心得进入实际user消息，不能进入system或读取未确认卡', async () => {
  const card = {
    platform: '抖音',
    hook_type: '痛点',
    opening_3s: '结构卡开头独特标记',
    structure: ['先问需求', '展示事实', '邀请咨询'],
    emotion_trigger: '信任',
    selling_point_presentation: '现场展示',
    cta_type: '到店',
    duration_or_length: '30秒',
    reusable_pattern: '结构卡模式独特标记',
    risk_flags: [],
  };
  let actual;
  await generateAiSalesVideoScript({
    brief: '本店带货',
    benchmarkCards: [
      { verified: 1, card },
      { verified: 0, card: { ...card, opening_3s: '未确认不得读取' } },
    ],
    evolutionNotes: [{ note: '人工心得独特标记', rationale: '已回填复盘' }],
    generateFn: async p => {
      actual = p;
      return output(validScript());
    },
  });
  assert.match(actual.userMsg, /结构卡开头独特标记/u);
  assert.match(actual.userMsg, /人工心得独特标记/u);
  assert.doesNotMatch(actual.userMsg, /未确认不得读取/u);
  assert.doesNotMatch(actual.system, /独特标记/u);
  assert.equal(
    buildAiSalesVideoScriptPrompt({ brief: '任务' }).system,
    buildAiSalesVideoScriptPrompt({ brief: '其它任务' }).system,
  );
});
