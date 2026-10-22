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
  aiSalesVideoScriptResponseSchema,
} = await import('../src/engines/ai-sales-video-script.js');

// Existing fixtures exercise the optional 30-second/legacy two-shot contract.
const validateThirtySecondScript = (value, options = {}) => validateAiSalesVideoScript(value, { durationSeconds: 30, ...options });

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

test('默认15秒单段方案：结构/真实文本调用/字幕统一，30秒必须明确选择', async () => {
  const value = validScript(), voiceover = '今天吃什么？来店里坐坐。';
  value.shots = [{ ...value.shots[0], voiceover, subtitle: voiceover }];
  value.cta = '来店里坐坐。';
  value.total_chars = countSpeechChars(voiceover);
  value.estimated_seconds = 15;
  assert.equal(validateAiSalesVideoScript(value).ok, true);
  assert.equal(validateAiSalesVideoScript(validScript()).ok, false, '未选择30秒不得接纳两段方案');
  assert.equal(validateAiSalesVideoScript(value, { durationSeconds: 30 }).ok, false);
  assert.equal(aiSalesVideoScriptResponseSchema().schema.properties.shots.maxItems, 1);
  assert.equal(aiSalesVideoScriptResponseSchema({ durationSeconds: 30 }).schema.properties.shots.maxItems, 2);
  assert.throws(() => aiSalesVideoScriptResponseSchema({ durationSeconds: 20 }), /15.*30/u);
  const prompt = buildAiSalesVideoScriptPrompt({ brief: '介绍本次照片', skillPrompt: '已启用的两段资料保留原文。' });
  assert.match(prompt.system, /恰好1段镜头/u);
  assert.match(prompt.system, /已启用的两段资料保留原文/u);
  assert.doesNotMatch(prompt.system, /第 2 段接住/u);
  let calls = 0;
  const generated = await generateAiSalesVideoScript({ brief:'介绍本次照片', generateFn: async params => {
    calls += 1;
    assert.equal(params.responseSchema.schema.properties.shots.maxItems, 1);
    return output(value);
  }});
  assert.equal(calls, 1);
  assert.equal(generated.script.shots.length, 1);
  assert.equal(generated.script.shots[0].end, 15);
});

test('独白完整schema正例，不补缺字段、不忽略额外控制字段', () => {
  const script = validScript();
  assert.equal(validateThirtySecondScript(script).ok, true, JSON.stringify(validateThirtySecondScript(script).errors));
  for (const key of ['risk_flags', 'facts_used', 'cta']) {
    const bad = structuredClone(script);
    delete bad[key];
    assert.equal(validateThirtySecondScript(bad).ok, false, key);
  }
  assert.equal(validateThirtySecondScript({ ...script, approve: true }).ok, false);
  assert.equal(validateThirtySecondScript({ ...script, total_chars: 1.5 }).ok, false);
  assert.equal(validateThirtySecondScript({ ...script, hook_3s: { text: script.hook_3s } }).ok, false);
  const timeString = structuredClone(script);
  timeString.shots[0].start = '0';
  assert.equal(validateThirtySecondScript(timeString).ok, false);
});
test('字幕与口播不一致时按口播原文生成字幕并提示，风控异常不可按未命中放行', () => {
  const bad = validScript();
  bad.shots[0].subtitle = '这里换成另一段话。';
  const normalized = validateThirtySecondScript(bad);
  assert.equal(normalized.ok, true, JSON.stringify(normalized.errors));
  assert.equal(normalized.script.shots[0].subtitle, bad.shots[0].voiceover, '字幕是口播的派生物，按口播原文烧录');
  assert.ok(normalized.warnings.some(item => /字幕与口播不一致/u.test(item)));
  assert.equal(
    validateThirtySecondScript(validScript(), {
      scanText: () => {
        throw new Error('unavailable');
      },
    }).ok,
    false,
  );
});

test('仅规范化明确内部字段注记，保留普通括号字句及原始对象，仍校验缺字段和事实', () => {
  const original=validScript();
  const before=structuredClone(original);
  original.shots[0].voiceover=original.shots[0].voiceover.replace(original.hook_3s,original.hook_3s+'（brandName）');
  original.shots[0].subtitle=original.shots[0].voiceover;
  original.cta+='(storeName)';
  const annotated=structuredClone(original);
  const normalized=validateThirtySecondScript(original);
  assert.equal(normalized.ok,true,JSON.stringify(normalized.errors));
  assert.equal(normalized.script.shots[0].voiceover,before.shots[0].voiceover);
  assert.equal(normalized.script.cta,before.cta);
  assert.deepEqual(original,annotated,'不改写原始模型对象');
  assert.equal(normalized.normalizations.length,3);
  assert.ok(normalized.warnings.some(value=>/内部字段注记/.test(value)));
  const ordinary=validScript();ordinary.shots[0].visual+='（仅做缓慢运镜）';
  ordinary.shots[0].voiceover=ordinary.shots[0].voiceover.replace('。','（微辣）。');ordinary.shots[0].subtitle=ordinary.shots[0].voiceover;
  const kept=validateThirtySecondScript(ordinary);
  assert.match(kept.script.shots[0].voiceover,/（微辣）/);
  assert.match(kept.script.shots[0].visual,/（仅做缓慢运镜）/);
  assert.equal(kept.normalizations.length,0);
  const missing=validScript();delete missing.shots[0].voiceover;
  assert.equal(validateThirtySecondScript(missing).ok,false);
});
test('自然到品牌店邀请与用户明确品牌编号可对应，不能借此放过未知价格地址或伪造声明', () => {
  const script = validScript();
  script.cta = '欢迎到罗二火锅坐坐。';
  script.shots[1].voiceover = script.cta;
  script.shots[1].subtitle = script.cta;
  script.facts_used = [{ claim:'罗二火锅', factId:'品牌名称' }];
  const pack = { facts:[{id:'chat:1:brand',kind:'store_name',source:'user_input',sourceId:1,claim:'罗二火锅',value:'罗二火锅'}] };
  const result = validateThirtySecondScript(script,{pack});
  assert.equal(result.ok,true,JSON.stringify(result.errors));
  assert.deepEqual(result.script.facts_used,[{claim:'罗二火锅',factId:'chat:1:brand'}]);
  const withoutMetadata = validateThirtySecondScript(script,{pack:{facts:[]}});
  assert.equal(withoutMetadata.ok,true);
  assert.deepEqual(withoutMetadata.script.facts_used,[]);
  assert.match(withoutMetadata.warnings.join(' '),/移除无法核实/u);
  for (const phrase of ['人均29元。','地址在幸福路18号。']) {
    const bad=structuredClone(script);bad.shots[1].voiceover=phrase+script.cta;bad.shots[1].subtitle=bad.shots[1].voiceover;
    assert.equal(validateThirtySecondScript(bad,{pack}).ok,false,phrase);
  }
  const forged=structuredClone(script);forged.facts_used[0].claim='罗二火锅全场免费';
  const cleaned = validateThirtySecondScript(forged,{pack});
  assert.equal(cleaned.ok,true);
  assert.deepEqual(cleaned.script.facts_used,[{claim:'罗二火锅',factId:'chat:1:brand'}]);
  assert.equal(cleaned.script.shots[1].voiceover,script.cta);
  for (const factId of ['用户输入确认','照片可见','brand']) {
    const badId = structuredClone(script); badId.facts_used = [{factId,claim:'不作为事实的模型自述'}];
    const normalized = validateThirtySecondScript(badId,{pack});
    assert.equal(normalized.ok,true);
    assert.deepEqual(normalized.script.facts_used,[{claim:'罗二火锅',factId:'chat:1:brand'}]);
  }
  const medical = structuredClone(script);
  medical.shots[1].voiceover = '这口锅能治疗疾病。' + script.cta;
  medical.shots[1].subtitle = medical.shots[1].voiceover;
  assert.equal(validateThirtySecondScript(medical,{pack,scanText:()=>({hits:[{name:'医疗功效'}]})}).ok,false);
});
test('原生短独白允许留白，较长独白仅提示并保留全文，均不为字数重复调用模型', async () => {
  for (const long of [false, true]) {
    const script = validScript();
    script.shots[0].voiceover = '今天吃什么？' + (long ? '口味可以按自己的喜好来选。'.repeat(7) : '看看这桌菜吧。');
    script.shots[1].voiceover = '欢迎到店咨询详情。';
    script.shots.forEach(shot => {
      shot.subtitle = shot.voiceover;
    });
    script.cta = '到店咨询详情。';
    let calls = 0;
    const result = await generateAiSalesVideoScript({ durationSeconds: 30,
      brief: '罗二火锅真实参考图',
      generateFn: async () => {
        calls++;
        return output(script);
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.script.shots[0].voiceover, script.shots[0].voiceover);
    assert.equal(result.script.shots[1].voiceover, script.shots[1].voiceover);
    assert.equal(result.warnings.length > 0, long);
    assert.equal(validateThirtySecondScript(script, { audioMode: 'external_tts' }).ok, false);
  }
  const empty = validScript();
  empty.shots[0].voiceover = '';
  empty.shots[0].subtitle = '';
  assert.equal(validateThirtySecondScript(empty).ok, false);
});
test('独白提示面向食客，镜头留在visual，本次品牌优先且不要求凑满字数或优惠口令', () => {
  const prompt = buildAiSalesVideoScriptPrompt({
    brief: '只使用罗二火锅及参考图',
  });
  assert.match(prompt.system, /voiceover只说给食客听/u);
  assert.match(prompt.system, /拍摄、运镜、制作动作只写visual/u);
  assert.match(prompt.system, /允许环境音和画面留白/u);
  assert.match(prompt.system, /本次用户明确的品牌与素材范围优先/u);
  assert.match(prompt.system, /没有已证实的优惠或渠道/u);
  assert.match(prompt.system, /说完保留轻微环境音/u);
  assert.match(prompt.system, /每段写两句，合计约20–35字/u);
  assert.match(prompt.system, /全片品牌邀约只说一次/u);
  assert.match(prompt.system, /cta原样摘取末段口播的收尾句/u);
  assert.match(prompt.system, /静态照片不能证明上菜、烹饪或顾客聚餐的过程/u);
  assert.match(prompt.system, /不得写成已经发生的事实/u);
  assert.match(prompt.system, /可使用未来邀约语气/u);
  assert.match(prompt.system, /不固定以“欢迎到店”结尾/u);
  assert.match(prompt.system, /不按每字定速/u);
  assert.match(prompt.system, /用户已确认的台词不擅自更改/u);
  assert.match(prompt.system, /自然开场首句或前缀/u);
  assert.match(prompt.system, /不必写成提问或悬念/u);
  assert.match(prompt.system, /每段固定一个视角/u);
  assert.doesNotMatch(prompt.system + prompt.user, /53–67|各\s*53|写完先数|每句不超过\s*18|每秒3\.5|中低音区|0\.3秒|换气|14秒|社会证明|强营销/u);
  assert.doesNotMatch(prompt.system + prompt.user, /给出真实、简洁的用餐邀请|接住用餐意愿|左右的一两句|不是验收字数门/u);
  assert.match(buildAiSalesVideoScriptPrompt({durationSeconds:30}).system, /不要把一句话跨过15秒剪辑边界/u);
});
test('自然陈述开场与短邀约可交付，写作字数建议不升级为硬失败', () => {
  const value = validScript(), voiceover = '周末约朋友，到店坐坐。';
  value.hook_3s = '周末约朋友'; value.cta = '到店坐坐。';
  value.shots = [{...value.shots[0],voiceover,subtitle:voiceover}];
  value.total_chars = countSpeechChars(voiceover); value.estimated_seconds = 6;
  const before = structuredClone(value), checked = validateAiSalesVideoScript(value);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
  assert.ok(countSpeechChars(voiceover) < 20);
  assert.equal(checked.script.shots[0].voiceover, voiceover);
  assert.deepEqual(value, before, '检查不能将已确认台词改成模板问句');
  assert.match(aiSalesVideoScriptResponseSchema().schema.properties.hook_3s.description, /不必提问/u);
});
test('登记事实声明不能伪造，顾客原句也不能偷偷写在画面说明', () => {
  const pack = {
    facts: [
      {
        id: 'name',
        kind: 'store_name',
        value: '测试餐厅',
        claim: '门店名称：测试餐厅',
      },
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
  assert.equal(validateThirtySecondScript(script, { pack }).ok, true);
  // 引用编号才是证据；改写过的引用说明按事实包原文登记并提示，不让格式问题拦住已落地的脚本。
  script.facts_used[0].claim = '门店名称：另一家店';
  const canonical = validateThirtySecondScript(script, { pack });
  assert.equal(canonical.ok, true, JSON.stringify(canonical.errors));
  assert.deepEqual(canonical.script.facts_used, [{ claim: '门店名称：测试餐厅', factId: 'name' }]);
  assert.ok(canonical.warnings.some(item => /已按本店事实包原文登记/u.test(item)));
  script.facts_used[0].claim = '门店名称：测试餐厅';
  const quote = validScript();
  quote.shots[1].visual = pack.facts[1].value;
  assert.equal(validateThirtySecondScript(quote, { pack }).ok, false);
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
      condenseAiSalesVideoShot({
        script,
        shotIndex: 1,
        measuredSeconds: 18,
        generateFn: async () => output(altered),
      }),
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
    generateAiSalesVideoScript({ durationSeconds: 30,
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
    generateAiSalesVideoScript({ durationSeconds: 30,
      brief: '本店带货',
      generateFn: async () => ({
        mode: 'template',
        text: JSON.stringify(validScript()),
      }),
    }),
    /模板/u,
  );
  const seen = [];
  const result = await generateAiSalesVideoScript({ durationSeconds: 30,
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
  await generateAiSalesVideoScript({ durationSeconds: 30,
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

test('cta 接受“约上朋友过来，趁热吃吧”这类自然邀请，仍拒绝非行动句', async () => {
  const { validateAiSalesVideoScript } = await import('../src/engines/ai-sales-video-script.js');
  const build = cta => ({
    hook_3s: '下班饿了，',
    shots: [{ index: 1, start: 0, end: 15, visual: '菜品近景', voiceover: `下班饿了，看这碗水煮牛肉。${cta}`, subtitle: `下班饿了｜${cta}`, sfx: '无', reference_hint: 'dish' }],
    cta, facts_used: [], total_chars: 20, estimated_seconds: 5, risk_flags: [],
  });
  for (const cta of ['约上朋友过来，趁热吃吧。', '趁热来尝一口。', '欢迎约上朋友到店看看。', '下班一起来吃。']) {
    const result = validateAiSalesVideoScript(build(cta), { durationSeconds: 15 });
    assert.ok(!result.errors.some(line => /cta 必须是自然行动邀请/.test(line)), `${cta} → ${result.errors.join('|')}`);
  }
  const bad = validateAiSalesVideoScript(build('这碗牛肉红油很亮。'), { durationSeconds: 15 });
  assert.ok(bad.errors.some(line => /cta 必须是自然行动邀请/.test(line)));
});
