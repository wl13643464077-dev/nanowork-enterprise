import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildContentEmployeeWorkbenchProfile } from '../src/engines/content-employee-workbench.js';
import {
  findUnsupportedWriterMarketingFactClaims,
  getContentEmployeeOutputResponseSchema,
  retrospectiveNoDataFallbackOutput,
  validateContentEmployeeOutputContract,
  validateContentOutputContract,
} from '../src/engines/content-output-contract.js';
import { assembleContentPipelineDelivery } from '../src/engines/content-pipeline-delivery.js';
import { resolveWriterTitleCountRequirement } from '../src/engines/content-title-count.js';
import { VALID_CONTENT_EMPLOYEE_OUTPUTS } from './helpers/content-output-fixtures.mjs';

const VALID_OUTPUTS = VALID_CONTENT_EMPLOYEE_OUTPUTS;

function minimalValidOutput(idx) {
  const schema = buildContentEmployeeWorkbenchProfile(idx).jobProfile.outputSchema;
  const output = structuredClone(VALID_OUTPUTS[idx]);
  assert.deepEqual(Object.keys(output), schema.keys);
  return output;
}

test('10个内容岗位均按自身outputSchema接受覆盖全部outputKeys的完整岗位样本', () => {
  const expectedKinds = [
    'json',
    'json',
    'json',
    'markdown',
    'markdown',
    'images',
    'covers',
    'html',
    'publish_packages',
    'markdown',
  ];

  for (let idx = 0; idx < 10; idx += 1) {
    const output = minimalValidOutput(idx);
    const result = validateContentEmployeeOutputContract(idx, JSON.stringify(output));
    const profile = buildContentEmployeeWorkbenchProfile(idx);

    assert.equal(result.valid, true, `${profile.identity.name}: ${result.errors.join('；')}`);
    assert.deepEqual(result.parsed, output);
    assert.deepEqual(result.errors, []);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].kind, expectedKinds[idx]);
    assert.equal(result.artifacts[0].kind, profile.jobProfile.outputSchema.primaryArtifact);
    assert.equal(result.artifacts[0].primary, true);
    assert.equal(result.artifacts[0].employeeIdx, idx);
    assert.equal(result.artifacts[0].employeeKey, profile.identity.key);
    assert.deepEqual(result.artifacts[0].sourceKeys, profile.jobProfile.outputSchema.keys);
    assert.match(
      result.artifacts[0].filename,
      /^content-employee-\d{2}-[a-z0-9-]+-[a-f0-9]{12}\.(?:json|md|html)$/u,
    );
    assert.ok(result.previewMarkdown);
    assert.match(result.previewMarkdown, /^# .+(?:报告|交付)/u);
    assert.doesNotMatch(result.previewMarkdown, /^```json/u);
    assert.doesNotMatch(result.previewMarkdown, /^\s*\{/u);
    if (!['markdown'].includes(expectedKinds[idx])) {
      assert.match(result.previewMarkdown, /内容团队数字员工交付报告/u);
      assert.match(result.previewMarkdown, /## 交付文件/u);
      assert.match(result.previewMarkdown, /## 下一步建议/u);
    }
  }
});

test('文风师必需输入门支持多段完整原稿，仍拒绝“暂无”标签借后文凑长度', () => {
  const output = minimalValidOutput(4);
  const accepted = validateContentEmployeeOutputContract(4, output, {
    enforceRequiredInputs: true,
    requirement: [
      '待改写完整原稿：# 先核对口径，再谈结论',
      '',
      '本周复盘先统一门店范围和统计期间，然后逐笔核对采购、入库、领用、报损与销售记录。',
      '没有原始凭证支持的判断只记为待核验，最后写清责任人、复核节点和下一步动作。',
      '账号人设档案：实战型餐饮老板。',
      '语气规则：直接、克制、先证据后判断。',
    ].join('\n'),
  });
  assert.equal(accepted.valid, true, accepted.errors.join('；'));

  const rejected = validateContentEmployeeOutputContract(4, output, {
    enforceRequiredInputs: true,
    requirement: [
      '完整原稿：暂无',
      '账号人设档案：实战型餐饮老板。',
      '语气规则：直接、克制、先证据后判断。',
      '其他任务说明：这段文字故意写得很长，但它不是待改写原稿，不能用来绕过必需输入门禁。',
    ].join('\n'),
  });
  assert.equal(rejected.valid, false);
  assert.match(rejected.errors.join('；'), /文风师必须同时取得待改写的完整原稿/u);
});

function assertSchemaObjectsAreStrict(schema, path = '$') {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, `${path} 必须拒绝未知字段`);
    assert.deepEqual(schema.required, Object.keys(schema.properties), `${path} 必须要求全部字段`);
    for (const [key, child] of Object.entries(schema.properties)) {
      assertSchemaObjectsAreStrict(child, `${path}.${key}`);
    }
  }
  if (schema.type === 'array') {
    if (path === '$.profile_updates') {
      assert.equal(schema.minItems, 0, `${path} 无可回流经验时必须允许空数组`);
    } else {
      assert.ok(schema.minItems >= 1, `${path} 必须拒绝空数组`);
    }
    assertSchemaObjectsAreStrict(schema.items, `${path}[]`);
  }
}

test('10岗均导出可复用严格JSON Schema，数量边界与现有验证器一致', () => {
  for (let idx = 0; idx < 10; idx += 1) {
    const profile = buildContentEmployeeWorkbenchProfile(idx);
    const responseSchema = getContentEmployeeOutputResponseSchema(idx);
    assert.equal(responseSchema.name, `content_employee_${idx}_output`);
    assert.equal(responseSchema.schema.type, 'object');
    assert.deepEqual(responseSchema.schema.required, profile.jobProfile.outputSchema.keys);
    assert.deepEqual(Object.keys(responseSchema.schema.properties), profile.jobProfile.outputSchema.keys);
    assertSchemaObjectsAreStrict(responseSchema.schema);

    responseSchema.schema.required.length = 0;
    assert.deepEqual(
      getContentEmployeeOutputResponseSchema(idx).schema.required,
      profile.jobProfile.outputSchema.keys,
      `岗位${idx}必须返回防御性副本`,
    );
  }

  const writer = getContentEmployeeOutputResponseSchema(3).schema.properties;
  assert.equal(getContentEmployeeOutputResponseSchema(0).schema.properties.briefing.minLength, 120);
  assert.equal(getContentEmployeeOutputResponseSchema(0).schema.properties.channel_scan.minItems, 3);
  assert.equal(getContentEmployeeOutputResponseSchema(1).schema.properties.facts.minItems, 3);
  assert.equal(getContentEmployeeOutputResponseSchema(1).schema.properties.sources.minItems, 2);
  assert.equal(getContentEmployeeOutputResponseSchema(2).schema.properties.benchmarks.minItems, 3);
  assert.equal(
    Object.keys(getContentEmployeeOutputResponseSchema(2)
      .schema.properties.benchmarks.items.properties.dimensions.properties).length,
    6,
  );
  assert.equal(writer.title_candidates.minItems, 3);
  assert.equal(writer.title_candidates.maxItems, 5);
  assert.equal(writer.body.minLength, 240);
  assert.equal(writer.tags.minItems, 5);
  assert.equal(writer.tags.maxItems, 8);
  assert.equal(writer.image_plan.minItems, 2);
  assert.equal(writer.image_plan.maxItems, 4);
  assert.equal(writer.tags.items.pattern, '^[^#＃]+$');
  assert.equal(getContentEmployeeOutputResponseSchema(4).schema.properties.body.minLength, 240);
  assert.equal(getContentEmployeeOutputResponseSchema(4).schema.properties.title_candidates.minItems, 3);
  assert.equal(getContentEmployeeOutputResponseSchema(4).schema.properties.title_candidates.maxItems, 3);
  assert.equal(getContentEmployeeOutputResponseSchema(5).schema.properties.images.minItems, 2);
  assert.equal(getContentEmployeeOutputResponseSchema(5)
    .schema.properties.images.items.properties.svg.minLength, 180);
  assert.equal(getContentEmployeeOutputResponseSchema(6).schema.properties.covers.minItems, 3);
  assert.equal(getContentEmployeeOutputResponseSchema(6).schema.properties.covers.maxItems, 3);
  assert.equal(getContentEmployeeOutputResponseSchema(7).schema.properties.html.minLength, 500);

  const distributor = getContentEmployeeOutputResponseSchema(8).schema.properties;
  assert.equal(distributor.versions.minItems, 3);
  assert.equal(distributor.versions.maxItems, 3);
  assert.deepEqual(distributor.versions.items.required, [
    'platform',
    'title',
    'body',
    'tags',
    'best_time',
    'checklist',
    'note',
  ]);
  assert.equal(distributor.versions.items.additionalProperties, false);
  assert.equal(distributor.versions.items.properties.body.minLength, 120);
  assert.equal(distributor.versions.items.properties.tags.minItems, 3);
  assert.equal(distributor.versions.items.properties.tags.items.pattern, '^[^#＃]+$');
  assert.equal(distributor.versions.items.properties.checklist.minItems, 2);
  assert.equal(distributor.versions.items.properties.checklist.maxItems, 4);

  const retro = getContentEmployeeOutputResponseSchema(9).schema.properties;
  assert.equal(retro.report.minLength, 180);
  assert.equal(retro.report.maxLength, 1200);
  assert.match(retro.report.description, /发布后复盘计划.*T\+1\/T\+3\/T\+7.*待验证假设/su);
  assert.equal(retro.next_topics.minItems, 3);
  assert.equal(retro.next_topics.items.properties.title.maxLength, 80);
  assert.equal(retro.next_topics.items.properties.reason.maxLength, 160);
  assert.equal(retro.profile_updates.minItems, 0);
  assert.equal(retro.profile_updates.items.maxLength, 160);
  assert.match(retro.profile_updates.items.description, /没有可写回经验.*空数组/u);
});

test('分发官响应Schema按任务书平台动态约束，旧调用仍兼容三平台契约', () => {
  const singlePlatform = getContentEmployeeOutputResponseSchema(8, {
    brief: { platforms: ['小红书'] },
  }).schema.properties.versions;
  assert.equal(singlePlatform.minItems, 1);
  assert.equal(singlePlatform.maxItems, 3);
  assert.deepEqual(singlePlatform.items.properties.platform.enum, ['小红书']);
  assert.match(singlePlatform.description, /每个请求平台.*主发布包.*可选变体/u);

  const twoPlatforms = getContentEmployeeOutputResponseSchema(8, {
    requirement: JSON.stringify({ brief: { platforms: ['微信公众号', '小红书'] } }),
  }).schema.properties.versions;
  assert.equal(twoPlatforms.minItems, 2);
  assert.equal(twoPlatforms.maxItems, 6);
  assert.deepEqual(
    twoPlatforms.items.properties.platform.enum,
    ['微信公众号', '小红书'],
  );

  const legacy = getContentEmployeeOutputResponseSchema(8).schema.properties.versions;
  assert.equal(legacy.minItems, 3);
  assert.equal(legacy.maxItems, 3);
  assert.equal(legacy.items.properties.platform.enum, undefined);
});

test('分发官单平台任务只需一个完整主发布包，不得补造未请求平台', () => {
  const output = minimalValidOutput(8);
  output.versions = [output.versions.find(version => version.platform === '小红书')];
  const context = {
    requirement: JSON.stringify({ brief: { platforms: ['小红书'] } }),
  };

  const accepted = validateContentEmployeeOutputContract(8, output, context);
  assert.equal(accepted.valid, true, accepted.errors.join('；'));
  assert.equal(accepted.parsed.versions.length, 1);
  assert.equal(accepted.artifacts.length, 1);

  const fabricated = structuredClone(output);
  fabricated.versions.push(minimalValidOutput(8).versions[0]);
  const rejected = validateContentEmployeeOutputContract(8, fabricated, context);
  assert.equal(rejected.valid, false);
  assert.match(rejected.errors.join('；'), /微信公众号.*未在任务书请求平台/u);
  assert.deepEqual(rejected.artifacts, []);
});

test('分发官允许同平台可选变体，但重复项不能冒充缺失平台主包', () => {
  const base = minimalValidOutput(8);
  const xhs = base.versions.find(version => version.platform === '小红书');
  const wechat = base.versions.find(version => version.platform === '微信公众号');
  const context = { brief: { platforms: ['微信公众号', '小红书'] } };

  const withVariant = structuredClone(base);
  withVariant.versions = [wechat, xhs, {
    ...structuredClone(xhs),
    title: '成本异常先查口径：小红书清单版',
    body: `${xhs.body} 本变体改用清单结构呈现，仍保留同一事实边界与人工复核节点。`,
    note: '这是小红书同平台可选清单变体，不替代其他请求平台的主发布包。',
  }];
  const accepted = validateContentEmployeeOutputContract(8, withVariant, context);
  assert.equal(accepted.valid, true, accepted.errors.join('；'));

  const missingWechat = structuredClone(withVariant);
  missingWechat.versions = [xhs, withVariant.versions[2]];
  const rejected = validateContentEmployeeOutputContract(8, missingWechat, context);
  assert.equal(rejected.valid, false);
  assert.match(rejected.errors.join('；'), /缺少请求平台“微信公众号”的主发布包/u);
  assert.doesNotMatch(rejected.errors.join('；'), /必须包含3项/u);
});

test('撰稿人标题静态契约为3-5，明确要求则匹配数量，无要求时至少保留3个', () => {
  const fiveTitles = minimalValidOutput(3);
  fiveTitles.title_candidates.push(
    '经营异常先核口径，再沿业务链找证据',
    '门店复盘别停在争论，把问题变成行动清单',
  );

  const explicitFive = validateContentEmployeeOutputContract(3, fiveTitles, {
    requirement: '请交付1篇小红书正文初稿、5个差异化标题、6至8个标签，并给出配图点位建议。',
  });
  assert.equal(explicitFive.valid, true, explicitFive.errors.join('；'));

  const onlyThree = minimalValidOutput(3);
  const missesExplicitFive = validateContentEmployeeOutputContract(3, onlyThree, {
    requirement: '请交付1篇小红书正文初稿、5个差异化标题、6至8个标签，并给出配图点位建议。',
  });
  assert.equal(missesExplicitFive.valid, false);
  assert.match(missesExplicitFive.errors.join('；'), /title_candidates.*明确要求.*恰好包含5项/u);

  const feedbackOverridesRequirement = validateContentEmployeeOutputContract(3, fiveTitles, {
    requirement: '原任务要求3个标题。',
    feedback: '上一版数量不够，这次请给出五个候选标题。',
  });
  assert.equal(
    feedbackOverridesRequirement.valid,
    true,
    feedbackOverridesRequirement.errors.join('；'),
  );

  const fourTitles = structuredClone(onlyThree);
  fourTitles.title_candidates.push('把经营争论变成证据闭环的复盘方法');
  const modifiedTitleWording = validateContentEmployeeOutputContract(3, fourTitles, {
    feedback: '反馈要求4个不同风格的备选标题。',
  });
  assert.equal(modifiedTitleWording.valid, true, modifiedTitleWording.errors.join('；'));

  const unrelatedFive = validateContentEmployeeOutputContract(3, onlyThree, {
    requirement: '交付内容包括：5个门店案例、标题数量不限定。',
  });
  assert.equal(unrelatedFive.valid, true, unrelatedFive.errors.join('；'));

  const negatedFive = validateContentEmployeeOutputContract(3, onlyThree, {
    requirement: '不要给5个标题，按岗位默认数量交付正文、标签和配图建议。',
  });
  assert.equal(negatedFive.valid, true, negatedFive.errors.join('；'));

  const feedbackCancelsFive = validateContentEmployeeOutputContract(3, onlyThree, {
    requirement: '原任务请给5个标题。',
    feedback: '不要给5个标题，按岗位默认数量交付。',
  });
  assert.equal(feedbackCancelsFive.valid, true, feedbackCancelsFive.errors.join('；'));

  const impossibleEight = validateContentEmployeeOutputContract(3, onlyThree, {
    requirement: '请给8个标题，正文、标签和配图建议也要完整。',
  });
  assert.equal(impossibleEight.valid, false);
  assert.match(
    impossibleEight.errors.join('；'),
    /明确要求8个标题.*岗位契约仅允许3-5个.*当前任务无法满足/u,
  );

  const defaultThree = validateContentEmployeeOutputContract(3, onlyThree);
  assert.equal(defaultThree.valid, true, defaultThree.errors.join('；'));
  const noRequirementFive = validateContentEmployeeOutputContract(3, fiveTitles);
  assert.equal(noRequirementFive.valid, true, noRequirementFive.errors.join('；'));

  const belowMinimum = minimalValidOutput(3);
  belowMinimum.title_candidates = belowMinimum.title_candidates.slice(0, 2);
  const belowMinimumResult = validateContentEmployeeOutputContract(3, belowMinimum);
  assert.equal(belowMinimumResult.valid, false);
  assert.match(belowMinimumResult.errors.join('；'), /title_candidates.*3-5/u);

  const aboveMaximum = structuredClone(fiveTitles);
  aboveMaximum.title_candidates.push(
    '经营问题先形成证据链，再进入责任判断',
    '一张复盘清单，让跨部门协作有据可查',
    '发现数字波动后，老板应先完成这三步',
  );
  const aboveMaximumResult = validateContentEmployeeOutputContract(3, aboveMaximum, {
    requirement: '请给8个标题。',
  });
  assert.equal(aboveMaximumResult.valid, false);
  assert.match(aboveMaximumResult.errors.join('；'), /title_candidates.*3-5/u);
});

test('撰稿人标题数量解析区分改数、历史引用、自由数量与上下界语义', () => {
  const exactCases = new Map([
    ['标题给5个', 5],
    ['标题写5个', 5],
    ['候选标题来5个', 5],
    ['标题还是5个', 5],
    ['还是5个标题', 5],
    ['改成4个标题', 4],
    ['由3个标题改为5个标题', 5],
    ['标题数量改为5个', 5],
    ['这次做五版标题', 5],
  ]);
  for (const [feedback, expected] of exactCases) {
    const resolved = resolveWriterTitleCountRequirement({
      requirement: '请给3个标题',
      feedback,
    });
    assert.equal(resolved.constraintKind, 'exact', feedback);
    assert.equal(resolved.count, expected, feedback);
    assert.equal(resolved.source, 'feedback', feedback);
  }

  for (const feedback of [
    '原来要3个标题，现在标题数量你看着办',
    '不用拘泥于5个标题，按内容需要写',
  ]) {
    const resolved = resolveWriterTitleCountRequirement({
      requirement: '请给5个标题',
      feedback,
    });
    assert.equal(resolved.hasConstraint, false, feedback);
    assert.equal(resolved.explicit, false, feedback);
  }

  for (const feedback of ['至少给3个标题', '3个标题起步']) {
    const resolved = resolveWriterTitleCountRequirement({ feedback });
    assert.equal(resolved.constraintKind, 'range', feedback);
    assert.equal(resolved.min, 3, feedback);
    assert.equal(resolved.count, null, feedback);
    assert.equal(resolved.effectiveMax, 5, feedback);
  }
  const tooFew = resolveWriterTitleCountRequirement({ feedback: '三个标题太少了' });
  assert.equal(tooFew.constraintKind, 'range');
  assert.equal(tooFew.min, 4);
  assert.equal(tooFew.effectiveMin, 4);

  const onlyThree = minimalValidOutput(3);
  const five = structuredClone(onlyThree);
  five.title_candidates.push('证据不足时先列缺口再写正文', '从异常数字走到可验证行动');
  assert.equal(validateContentEmployeeOutputContract(3, onlyThree, {
    requirement: '至少给5个标题',
  }).valid, false);
  assert.equal(validateContentEmployeeOutputContract(3, five, {
    requirement: '至少给5个标题',
  }).valid, true);
});

test('语义数量数组拒绝复制凑数，标题、标签、来源与洞察必须唯一', () => {
  const cases = [
    [0, output => { output.channel_scan[1] = structuredClone(output.channel_scan[0]); }],
    [1, output => { output.facts[1] = output.facts[0]; }],
    [1, output => { output.data_points[1] = output.data_points[0]; }],
    [1, output => { output.viewpoints[1] = output.viewpoints[0]; }],
    [1, output => { output.source_coverage[1] = structuredClone(output.source_coverage[0]); }],
    [1, output => { output.sources[1] = structuredClone(output.sources[0]); }],
    [2, output => { output.benchmarks[1] = structuredClone(output.benchmarks[0]); }],
    [2, output => { output.comment_insights[1] = output.comment_insights[0]; }],
    [2, output => { output.user_language[1] = output.user_language[0]; }],
    [2, output => { output.takeaways[1] = output.takeaways[0]; }],
    [3, output => { output.title_candidates[1] = output.title_candidates[0]; }],
    [3, output => { output.tags[1] = output.tags[0]; }],
    [3, output => { output.image_plan[1] = structuredClone(output.image_plan[0]); }],
    [4, output => { output.title_candidates[1] = output.title_candidates[0]; }],
  ];
  for (const [idx, mutate] of cases) {
    const output = minimalValidOutput(idx);
    mutate(output);
    const result = validateContentEmployeeOutputContract(idx, output);
    assert.equal(result.valid, false, `content:${idx}`);
    assert.match(result.errors.join('；'), /必须唯一/u, `content:${idx}`);
    assert.deepEqual(result.artifacts, []);
  }
});

test('Markdown岗位交付物与界面预览完整呈现契约全字段', () => {
  const writer = minimalValidOutput(3);
  writer.title_candidates.push(
    '经营异常先核口径，再沿业务链找证据',
    '门店复盘别停在争论，把问题变成行动清单',
  );
  const writerResult = validateContentEmployeeOutputContract(3, writer, {
    requirement: '请交付5个差异化标题、完整正文、5至8个标签和配图建议。',
  });
  assert.equal(writerResult.valid, true, writerResult.errors.join('；'));
  assert.equal(writerResult.previewMarkdown, writerResult.artifacts[0].content);
  assert.deepEqual(writerResult.parsedOutput.fields.title_candidates, writer.title_candidates);
  assert.deepEqual(writerResult.parsedOutput.fields.tags, writer.tags);
  assert.deepEqual(writerResult.parsedOutput.fields.image_plan, writer.image_plan);
  assert.equal(writerResult.parsedOutput.fields.body.storedIn, 'artifact.content');
  assert.equal(writerResult.parsedOutput.fields.body.sectionHeading, '正文');
  assert.match(writerResult.parsedOutput.fields.body.contentSha256, /^[a-f0-9]{64}$/u);
  assert.match(writerResult.parsedOutput.artifactContentSha256, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(writerResult.parsedOutput).includes(writer.body), false);
  assert.match(writerResult.previewMarkdown, /## 标题候选/u);
  assert.match(writerResult.previewMarkdown, /## 正文/u);
  assert.match(writerResult.previewMarkdown, /## 标签/u);
  assert.match(writerResult.previewMarkdown, /## 配图计划/u);
  for (const title of writer.title_candidates) {
    assert.ok(writerResult.previewMarkdown.includes(title), title);
  }
  for (const tag of writer.tags) {
    assert.ok(writerResult.previewMarkdown.includes(`#${tag}`), tag);
  }
  for (const plan of writer.image_plan) {
    assert.ok(writerResult.previewMarkdown.includes(plan.slot), plan.slot);
    assert.ok(writerResult.previewMarkdown.includes(plan.desc), plan.desc);
  }
  assert.ok(writerResult.previewMarkdown.includes(writer.body));

  const stylist = minimalValidOutput(4);
  const stylistResult = validateContentEmployeeOutputContract(4, stylist);
  assert.equal(stylistResult.valid, true, stylistResult.errors.join('；'));
  assert.equal(stylistResult.previewMarkdown, stylistResult.artifacts[0].content);
  assert.ok(stylistResult.previewMarkdown.includes(stylist.body));
  assert.ok(stylist.title_candidates.every(title => stylistResult.previewMarkdown.includes(title)));
  assert.ok(stylistResult.previewMarkdown.includes(stylist.consistency_note));

  const retrospective = minimalValidOutput(9);
  const retrospectiveResult = validateContentEmployeeOutputContract(9, retrospective);
  assert.equal(retrospectiveResult.valid, true, retrospectiveResult.errors.join('；'));
  assert.equal(retrospectiveResult.previewMarkdown, retrospectiveResult.artifacts[0].content);
  assert.ok(retrospectiveResult.previewMarkdown.includes(retrospective.report));
  for (const topic of retrospective.next_topics) {
    assert.ok(retrospectiveResult.previewMarkdown.includes(topic.title), topic.title);
    assert.ok(retrospectiveResult.previewMarkdown.includes(topic.reason), topic.reason);
  }
  assert.ok(retrospective.profile_updates
    .every(update => retrospectiveResult.previewMarkdown.includes(update)));
});

test('10岗信息量硬门逐岗拒绝结构齐全但内容空壳的输出', () => {
  const cases = [
    [0, output => { output.briefing = '趋势简报'; }, /briefing.*至少需要120/u],
    [1, output => { output.facts = ['只有一条']; }, /facts.*至少包含3/u],
    [2, output => { output.benchmarks[0].dimensions['内容结构'] = '很清晰'; }, /内容结构.*至少需要12/u],
    [3, output => { output.body = '正文 Markdown'; }, /body.*至少需要240/u],
    [4, output => { output.body = '风格化正文 Markdown'; }, /body.*至少需要240/u],
    [5, output => { output.images[0].svg = '<svg></svg>'; }, /svg.*至少需要180/u],
    [6, output => { output.covers = output.covers.slice(0, 1); }, /covers.*恰好包含3/u],
    [7, output => { output.html = '<html><body>演绎正文</body></html>'; }, /html.*至少需要500/u],
    [8, output => { output.versions = output.versions.slice(0, 1); }, /versions.*恰好包含3/u],
    [9, output => { output.report = '复盘报告 Markdown'; }, /report.*至少需要180/u],
  ];

  for (const [idx, mutate, expectedError] of cases) {
    const output = minimalValidOutput(idx);
    mutate(output);
    const result = validateContentEmployeeOutputContract(idx, output);
    assert.equal(result.valid, false, `岗位${idx}空壳必须失败`);
    assert.match(result.errors.join('；'), expectedError);
    assert.deepEqual(result.artifacts, []);
  }
});

test('content:9线上80字节空壳样本失败，带待确认取数框架的完整复盘可通过', () => {
  const shell = {
    report: '# 餐饮老板内容复盘：食材成本异常识别（基于验收数据集）',
    next_topics: [{ title: '下次', reason: '继续' }],
    profile_updates: ['更新'],
  };
  assert.equal(Buffer.byteLength(shell.report, 'utf8'), 80);
  const rejected = validateContentEmployeeOutputContract(9, shell);
  assert.equal(rejected.valid, false);
  assert.match(rejected.errors.join('；'), /report.*至少需要180/u);
  assert.deepEqual(rejected.artifacts, []);

  const completePending = {
    report: [
      '# 本轮内容复盘（事实待确认版）',
      '## 当前判断',
      '关键经营数据和平台反馈尚未完成回收，因此本轮不虚构播放量、互动率或成交结论。现阶段只确认选题、成稿与发布检查链路已经建立。',
      '## 取数计划',
      '由负责人补齐各平台后台截图、发布时间、曝光、完播、收藏、评论、私信与有效线索，并在同一统计口径下登记来源和采集时间。',
      '## 分析框架',
      '数据齐备后依次比较选题吸引力、首屏留存、正文承接、行动引导与评论问题，区分内容问题、分发问题和样本量不足，所有结论标记证据。',
      '## 复核清单',
      '发布前核对标题、事实、链接与授权；发布后完成数据回填、异常说明、负责人确认和下一轮实验记录。',
    ].join('\n\n'),
    next_topics: [
      { title: '后台数据回收方法', reason: '先解决复盘缺少统一数据口径的问题' },
      { title: '首屏留存诊断清单', reason: '数据齐备后可定位开头流失环节' },
      { title: '评论问题转选题法', reason: '用真实用户提问建立下一轮候选池' },
    ],
    profile_updates: [
      '新增发布后数据回填与来源标记为固定步骤',
      '事实不完整时只输出取数计划和分析框架',
    ],
  };
  const accepted = validateContentEmployeeOutputContract(9, completePending);
  assert.equal(accepted.valid, true, accepted.errors.join('；'));
  assert.equal(accepted.artifacts.length, 1);
});

test('content:9人设回流无经验时可为空，有单条真实经验也与JSON Schema一致', () => {
  const empty = minimalValidOutput(9);
  empty.profile_updates = [];
  const emptyAccepted = validateContentEmployeeOutputContract(9, empty);
  assert.equal(emptyAccepted.valid, true, emptyAccepted.errors.join('；'));

  const single = minimalValidOutput(9);
  single.profile_updates = ['真实数据缺失时先输出采集与验证计划'];
  const singleAccepted = validateContentEmployeeOutputContract(9, single);
  assert.equal(singleAccepted.valid, true, singleAccepted.errors.join('；'));
});

test('content:9简洁上限与云端JSON Schema一致，阻止过长报告再次打满输出窗口', () => {
  const output = minimalValidOutput(9);
  output.report = `# 过长复盘\n\n${'只有真实数据和已核验来源才能形成结论。'.repeat(80)}`;
  assert.ok([...output.report].length > 1200);
  const rejected = validateContentEmployeeOutputContract(9, output);
  assert.equal(rejected.valid, false);
  assert.match(rejected.errors.join('；'), /report.*最多允许1200个字符/u);
  assert.deepEqual(rejected.artifacts, []);
});

test('无数据复盘回退产物通过工位9契约', () => {
  const accepted = validateContentEmployeeOutputContract(
    9,
    retrospectiveNoDataFallbackOutput(),
  );
  assert.equal(accepted.valid, true, accepted.errors.join('；'));
});

test('content:9没有输入证据时拒绝自造百分比、权重、行业基准与达标阈值', () => {
  const output = minimalValidOutput(9);
  output.report += [
    '',
    '## 未经支持的数值结论',
    '建议把餐饮完播率≥30%、互动率≥5%定为行业达标线，收藏率权重超过40%，转发率≥5%才算达标。',
    '以上均直接当作行业基准与本账号阈值，不再等待历史数据或负责人确认。',
  ].join('\n');

  const rejected = validateContentEmployeeOutputContract(9, output);
  assert.equal(rejected.valid, false);
  assert.match(rejected.errors.join('；'), /复盘指标事实门禁/u);
  for (const value of ['30%', '5%', '40%']) {
    assert.match(rejected.errors.join('；'), new RegExp(value.replace('%', '%'), 'u'));
  }
  assert.deepEqual(rejected.artifacts, []);
});

test('content:9待补历史基线与负责人设阈值可通过，不误伤T+1/T+3/T+7观察窗口和前50条采样计划', () => {
  const output = minimalValidOutput(9);
  output.report += [
    '',
    '## 后续取数计划',
    'T+1/T+3/T+7是岗位固定观察窗口，各窗口按同一口径回收曝光、完播、互动、收藏、转发和线索记录。',
    '评论仅抽取前50条作为采样计划，不把样本数当成效果指标。各项历史基线待补，达标阈值和指标权重由负责人根据账号真实数据设定。',
  ].join('\n');

  const accepted = validateContentEmployeeOutputContract(9, output);
  assert.equal(accepted.valid, true, accepted.errors.join('；'));
});

test('content:9可复用任务书或已核验web证据中已提供的真实指标数值', () => {
  const requirementOutput = minimalValidOutput(9);
  requirementOutput.report += [
    '',
    '## 已确认基线回填',
    '本轮只复述任务书已确认的完播率30%、互动率5%、收藏率权重40%和转发率5%，不外推其他指标。',
  ].join('\n');
  const requirementAccepted = validateContentEmployeeOutputContract(9, requirementOutput, {
    requirement: '已核对平台后台：完播率30%、互动率5%、收藏率权重40%、转发率5%均为本账号本轮真实数据。',
  });
  assert.equal(requirementAccepted.valid, true, requirementAccepted.errors.join('；'));

  const webOutput = minimalValidOutput(9);
  webOutput.report += '\n\n已核验来源给出本账号完播率30%，本次仅引用该值并保留链接供人工复核。';
  const webAccepted = validateContentEmployeeOutputContract(9, webOutput, {
    web: {
      verified: true,
      results: [{
        title: '平台后台导出',
        url: 'https://example.test/verified-metric',
        snippet: '本账号本轮完播率30%。',
      }],
    },
  });
  assert.equal(webAccepted.valid, true, webAccepted.errors.join('；'));

  const unverified = validateContentEmployeeOutputContract(9, webOutput, {
    web: {
      verified: false,
      results: [{ snippet: '未核验摘要声称完播率30%。' }],
    },
  });
  assert.equal(unverified.valid, false);
  assert.match(unverified.errors.join('；'), /30%/u);
});

test('content:9无证据时拒绝平台算法权重、平台比较、行业规律与提升因果断言', () => {
  const output = minimalValidOutput(9);
  output.report += [
    '',
    '## 无来源定性规则',
    '抖音收藏率权重变化。',
    '抖音：收藏率≥完播率。',
    '视频号：转发率单列。',
    '小红书：四维得分。',
    '根据餐饮实体门店普遍内容特点，可直接采用这套判断。',
    '菜品教程/攻略收藏率通常高于单纯段子。',
    '引导提问可提升评论链长度。',
    '下一轮按各平台最新算法规则直接改稿。',
  ].join('\n');

  const rejected = validateContentEmployeeOutputContract(9, output);
  assert.equal(rejected.valid, false);
  const errors = rejected.errors.join('；');
  assert.match(errors, /复盘定性事实门禁/u);
  for (const phrase of [
    '收藏率权重变化',
    '收藏率≥完播率',
    '转发率单列',
    '四维得分',
    '普遍内容特点',
    '通常高于',
    '可提升评论链长度',
    '最新算法规则',
  ]) assert.match(errors, new RegExp(phrase, 'u'));
  assert.deepEqual(rejected.artifacts, []);
});

test('content:9仅豁免明确禁止性边界陈述，不豁免平台/行业/因果断言或不低于阈值', () => {
  const boundary = minimalValidOutput(9);
  boundary.report += [
    '',
    '本轮不写平台规则、行业规律或效果因果结论。',
    '当前未形成平台算法结论，只保留数据采集和来源验证计划。',
  ].join('\n');
  const accepted = validateContentEmployeeOutputContract(9, boundary);
  assert.equal(accepted.valid, true, accepted.errors.join('；'));

  const assertions = minimalValidOutput(9);
  assertions.report += [
    '',
    '抖音平台算法优先收藏指标。',
    '餐饮行业通常更看重转发。',
    '引导提问会提升评论链长度。',
    '完播率不低于30%才算达标。',
  ].join('\n');
  const rejected = validateContentEmployeeOutputContract(9, assertions);
  assert.equal(rejected.valid, false);
  assert.match(rejected.errors.join('；'), /复盘定性事实门禁/u);
  assert.match(rejected.errors.join('；'), /复盘指标事实门禁.*30%/su);
});

test('content:9明确标注待验证假设或仅供实验时可通过，不误伤观察窗口与标题关键词建议', () => {
  const output = minimalValidOutput(9);
  output.report += [
    '',
    '## 待验证假设',
    '待验证假设：菜品教程收藏率可能高于段子，当前不作为行业结论。',
    '仅供实验：在两版其他条件一致的内容中测试引导提问是否提升评论链长度，不直接下结论。',
    '需来源核验：各平台算法权重和最新规则当前不写成结论，只列为后续查证项。',
    'T+1/T+3/T+7继续作为固定观察窗口；标题关键词建议优先围绕“成本复盘”与“行动清单”做两版实验。',
  ].join('\n');

  const accepted = validateContentEmployeeOutputContract(9, output);
  assert.equal(accepted.valid, true, accepted.errors.join('；'));
});

test('content:9可复述任务书或已核验web中明确支持的定性规则', () => {
  const requirementOutput = minimalValidOutput(9);
  requirementOutput.report += '\n\n抖音收藏率权重变化。';
  const requirementAccepted = validateContentEmployeeOutputContract(9, requirementOutput, {
    requirement: '平台已书面确认：抖音收藏率权重变化。本轮可原样复述该规则。',
  });
  assert.equal(requirementAccepted.valid, true, requirementAccepted.errors.join('；'));

  const webOutput = minimalValidOutput(9);
  webOutput.report += '\n\n视频号将转发率单列为复盘指标。';
  const webAccepted = validateContentEmployeeOutputContract(9, webOutput, {
    web: {
      verified: true,
      results: [{ snippet: '视频号将转发率单列为复盘指标。' }],
    },
  });
  assert.equal(webAccepted.valid, true, webAccepted.errors.join('；'));
});

test('撰稿人与分发官的tags事后校验严格禁止#和＃', () => {
  for (const [idx, mutate] of [
    [3, output => { output.tags[0] = '#经营'; }],
    [8, output => { output.versions[0].tags[0] = '＃经营'; }],
  ]) {
    const output = minimalValidOutput(idx);
    mutate(output);
    const result = validateContentEmployeeOutputContract(idx, output);
    assert.equal(result.valid, false);
    assert.match(result.errors.join('；'), /tags.*不得包含 # 或＃/u);
    assert.deepEqual(result.artifacts, []);
  }
});

test('撰稿人拒绝真实run#4未经支持的营销事实，同时放行条件式CTA和已核验事实复述', () => {
  const requirement = [
    '已核验事实：产品名为“双人招牌套餐”；目标人群为太原本地周末两人同行顾客；目标动作是到店预约。',
    '价格、折扣、菜品明细、库存、地址、营业时间、联系电话和赠品均未提供，必须标注“发布前补齐”，禁止编造。',
    '请交付1篇小红书正文初稿、5个差异化标题、6至8个标签和配图建议；正文要有明确预约动作，但不得声称已经发布或实际操作平台账号。',
  ].join('');
  const actualRun4Body = '周末又到了，两个人不知道去哪吃？别纠结了，这家店的双人招牌套餐我已经替你们试过了，真的绝！🍽️✨ 每一道都是招牌水准，分量刚好适合两个人，大快朵颐～ 环境也超棒，适合约会、闺蜜小聚，或者周末犒劳自己。💕 重点来了！周末人超多，一定要提前预约哦！现在就可以私信预约周末时段，锁定你的专属双人位～ 记得提前安排好时间，免得白跑一趟。📲 （发布前需补齐：价格、菜品明细、地址、营业时间、联系电话）📝 期待你和你的那个TA，一起来享受这份周末限定快乐～😋🥂  #太原美食 #周末去哪吃 #预约攻略';
  const actualRun4 = minimalValidOutput(3);
  actualRun4.title_candidates.push(
    '太原两人周末用餐预约前要确认什么',
    '双人招牌套餐发布前事实核对清单',
  );
  actualRun4.body = actualRun4Body;

  const rejected = validateContentEmployeeOutputContract(3, actualRun4, { requirement });
  assert.equal(rejected.valid, false);
  const errors = rejected.errors.join('；');
  for (const expected of [
    '亲历/体验背书',
    '产品品质/口味',
    '分量/适用人数',
    '环境/氛围/服务体验',
    '消费场景适配',
    '热度/客流/拥挤',
    '预约渠道/可预约/锁位',
    '限定/稀缺性',
  ]) assert.match(errors, new RegExp(expected, 'u'));
  for (const claim of [
    '我已经替你们试过了',
    '每一道都是招牌水准',
    '分量刚好适合两个人',
    '环境也超棒',
    '周末人超多',
    '现在就可以私信预约周末时段',
    '锁定你的专属双人位',
    '周末限定快乐',
  ]) assert.match(errors, new RegExp(claim, 'u'));
  assert.deepEqual(rejected.artifacts, []);

  const noContext = validateContentEmployeeOutputContract(3, actualRun4);
  assert.equal(noContext.valid, false);
  assert.match(noContext.errors.join('；'), /撰稿事实门禁/u);

  const conditionalCta = minimalValidOutput(3);
  conditionalCta.title_candidates.push(
    '补齐渠道后再引导预约的写作方法',
    '预约文案如何守住事实边界',
  );
  conditionalCta.body += '\n\n如需预约，请在发布前补齐并确认预约渠道；渠道核验完成后再引导预约，不声称当前已经开放预约。';
  const conditionalAccepted = validateContentEmployeeOutputContract(3, conditionalCta, {
    requirement,
  });
  assert.equal(conditionalAccepted.valid, true, conditionalAccepted.errors.join('；'));

  const titleGrounded = minimalValidOutput(3);
  titleGrounded.body += '\n\n已核验事实：本店环境安静。';
  const titleGroundedAccepted = validateContentEmployeeOutputContract(3, titleGrounded, {
    title: '已核验事实：本店环境安静',
  });
  assert.equal(titleGroundedAccepted.valid, true, titleGroundedAccepted.errors.join('；'));

  const creativeSlogan = minimalValidOutput(3);
  creativeSlogan.body += '\n\n周末两个人，把忙碌放下，把一顿饭留给彼此。';
  const creativeAccepted = validateContentEmployeeOutputContract(3, creativeSlogan);
  assert.equal(creativeAccepted.valid, true, creativeAccepted.errors.join('；'));

  const verified = validateContentEmployeeOutputContract(3, actualRun4, {
    requirement: `${requirement}另有带来源的已核验事实：我已经替你们试过；真的绝；每一道都是招牌水准；分量刚好适合两个人；环境超棒；适合约会和闺蜜小聚；周末人超多；一定要提前预约；现在可以私信预约周末时段；可以锁定专属双人位；属于周末限定体验。`,
  });
  assert.equal(verified.valid, true, verified.errors.join('；'));
});

test('撰稿人run#5允许人群同义复述、通用预约CTA和诚实待补清单，危险营销断言仍全拦', () => {
  const requirement = [
    '已核验事实：产品名为“双人招牌套餐”；目标人群为太原本地周末两人同行顾客；目标动作是到店预约。',
    '价格、折扣、菜品明细、库存、地址、营业时间、联系电话和赠品均未提供，必须标注“发布前补齐”，禁止编造。',
    '请交付1篇小红书正文初稿、5个差异化标题、6至8个标签和配图建议；正文要有明确预约动作。',
  ].join('');
  const safe = minimalValidOutput(3);
  safe.title_candidates.push(
    '预约前先核对门店信息清单',
    '双人同行周末预约行动指南',
  );
  safe.body += [
    '',
    '这份双人招牌套餐适合两人同行。赶紧预约，立即预约。',
    '发布前补齐：门店地址、营业时间、联系电话和预约渠道。',
    '地址和预约方式，请咨询门店工作人员。发布前请务必补齐以下信息：门店地址、营业时间、联系电话、预约渠道。',
    '检查项：地址、营业时间、联系电话 - [ ] 确认预约渠道。',
  ].join('\n');
  const accepted = validateContentEmployeeOutputContract(3, safe, { requirement });
  assert.equal(accepted.valid, true, accepted.errors.join('；'));

  const unsafe = structuredClone(safe);
  unsafe.title_candidates[0] = '双人招牌套餐｜周末约会不排队';
  unsafe.title_candidates[1] = '太原约会指南｜两个人吃这个双人招牌套餐太绝了';
  unsafe.body += [
    '',
    '现已开放预约。可私信预约并锁定双人位。现在有空位。',
    '先到先得。这里适合约会，套餐太绝了。',
  ].join('\n');
  const rejected = validateContentEmployeeOutputContract(3, unsafe, { requirement });
  assert.equal(rejected.valid, false);
  const errors = rejected.errors.join('；');
  for (const forbidden of [
    '周末约会不排队',
    '双人招牌套餐太绝了',
    '现已开放预约',
    '可私信预约并锁定双人位',
    '现在有空位',
    '先到先得',
    '适合约会',
    '套餐太绝了',
  ]) assert.match(errors, new RegExp(forbidden, 'u'));
  assert.doesNotMatch(errors, /适合两人同行/u);
  assert.doesNotMatch(errors, /赶紧预约|立即预约/u);
  assert.doesNotMatch(errors, /事实缺失硬校验.*门店地址/u);
  assert.deepEqual(rejected.artifacts, []);
});

test('撰稿人拒绝无依据的高置信感官与出品品质断言，只放行明确支持的事实', () => {
  const unsupported = minimalValidOutput(3);
  unsupported.body += [
    '',
    '双人招牌套餐香气扑鼻。',
    '这份套餐口感层次丰富。',
    '门店出品在线。',
  ].join('\n');
  const rejected = validateContentEmployeeOutputContract(3, unsupported, {
    requirement: '已确认产品名为“双人招牌套餐”；没有提供口味、口感或出品品质证据。',
  });
  assert.equal(rejected.valid, false);
  const errors = rejected.errors.join('；');
  for (const claim of ['香气扑鼻', '口感层次丰富', '出品在线']) {
    assert.match(errors, new RegExp(claim, 'u'));
  }

  const grounded = validateContentEmployeeOutputContract(3, unsupported, {
    requirement: '已核验事实：双人招牌套餐香气扑鼻、口感层次丰富，门店出品在线。',
  });
  assert.equal(grounded.valid, true, grounded.errors.join('；'));

  const structural = minimalValidOutput(3);
  structural.body += '\n\n写作结构：正文层次丰富，产品资料已经在线，编辑核对出品清单，再按问题、信息和行动三段展开。';
  const structuralAccepted = validateContentEmployeeOutputContract(3, structural);
  assert.equal(structuralAccepted.valid, true, structuralAccepted.errors.join('；'));
});

test('营销事实门按断言类别拒绝感官、烹饪质量和顾客推荐，创作目标不能冒充证据', () => {
  const claims = [
    '入口鲜香、余味绵长、火候恰到好处，食客一定会喜欢。',
    '风味醇厚、层次分明、品质令人放心，闭眼入不会错。',
    '这份套餐让人食欲大开，味觉体验很有记忆点。',
  ];
  const unsupported = minimalValidOutput(3);
  unsupported.body += `\n\n${claims.join('\n')}`;
  for (const requirement of [
    '已核验事实：产品名为“双人招牌套餐”。其他经营信息未提供，禁止编造。',
    '创作目标：让人感到产品新鲜、好吃。没有提供任何品质证据，禁止编造。',
    '请把套餐写得好吃、新鲜、有保障；这些只是创作方向，门店没有提供品质证据。',
    '用户希望看到口感层次丰富、香气扑鼻的营销感觉，但没有品质事实。',
  ]) {
    const result = validateContentEmployeeOutputContract(3, unsupported, { requirement });
    assert.equal(result.valid, false, `${requirement}\n${result.errors.join('；')}`);
    assert.match(result.errors.join('；'), /产品品质\/口味|顾客偏好\/推荐/u);
  }

  const grounded = validateContentEmployeeOutputContract(3, unsupported, {
    requirement: claims.map(claim => `已核验事实：${claim}`).join(''),
  });
  assert.equal(grounded.valid, true, grounded.errors.join('；'));
});

test('内容事实门覆盖3-8岗对外成稿字段，不扫描内部一致性说明', () => {
  const context = {
    requirement: '已核验事实：产品名为“双人招牌套餐”。品质、口味、食材和顾客反馈均未提供，禁止编造。',
  };
  const outputs = [];

  const writer = minimalValidOutput(3);
  writer.body += '\n\n双人招牌套餐入口鲜香，食客一定会喜欢。';
  outputs.push([3, writer]);

  const stylist = minimalValidOutput(4);
  stylist.body += '\n\n双人招牌套餐风味醇厚，品质令人放心。';
  outputs.push([4, stylist]);

  const media = minimalValidOutput(5);
  media.images[0].svg = media.images[0].svg.replace(
    '</svg>',
    '<text x="40" y="220">双人招牌套餐香气扑鼻</text></svg>',
  );
  outputs.push([5, media]);

  const cover = minimalValidOutput(6);
  cover.covers[0].html = cover.covers[0].html.replace(
    '</body>',
    '<p>双人招牌套餐口感层次丰富</p></body>',
  );
  outputs.push([6, cover]);

  const deck = minimalValidOutput(7);
  deck.html = deck.html.replace('</body>', '<p>双人招牌套餐火候恰到好处</p></body>');
  outputs.push([7, deck]);

  const distributor = minimalValidOutput(8);
  distributor.versions[0].body += ' 双人招牌套餐新鲜好吃，闭眼入不会错。';
  outputs.push([8, distributor]);

  for (const [idx, output] of outputs) {
    const result = validateContentEmployeeOutputContract(idx, output, context);
    assert.equal(result.valid, false, `content:${idx}\n${result.errors.join('；')}`);
    assert.match(result.errors.join('；'), /(?:撰稿|内容)事实门禁/u);
  }

  const neutral = minimalValidOutput(4);
  neutral.consistency_note = '内部说明：老板希望写出“香气扑鼻”的感觉，但这只是创作目标，正文没有采用未经核验的品质断言。';
  const neutralResult = validateContentEmployeeOutputContract(4, neutral, context);
  assert.equal(neutralResult.valid, true, neutralResult.errors.join('；'));

  const groundedStylist = validateContentEmployeeOutputContract(4, stylist, {
    requirement: '已核验事实：双人招牌套餐风味醇厚，品质令人放心。',
  });
  assert.equal(groundedStylist.valid, true, groundedStylist.errors.join('；'));

  const groundedDistributor = validateContentEmployeeOutputContract(8, distributor, {
    requirement: '已核验事实：双人招牌套餐新鲜好吃，闭眼入不会错。',
  });
  assert.equal(groundedDistributor.valid, true, groundedDistributor.errors.join('；'));
});

test('内容事实门覆盖制作食材、更多口感、分量口碑与售罄稀缺，并扫描用户可见执行字段', () => {
  const context = {
    requirement: '已核验事实：产品名为“双人招牌套餐”。除产品名外，品质、制作、食材、配方、分量、销量与顾客反馈均未提供，禁止编造。',
  };
  const cases = [];

  const writer = minimalValidOutput(3);
  const writerClaim = '双人招牌套餐肉质鲜嫩多汁、入口即化，汤底浓郁，香辣过瘾。';
  writer.body += `\n\n${writerClaim}`;
  cases.push([3, writer, writerClaim]);

  const stylist = minimalValidOutput(4);
  const stylistClaim = '双人招牌套餐现做现卖、当天熬制，全部使用精选食材。';
  stylist.body += `\n\n${stylistClaim}`;
  cases.push([4, stylist, stylistClaim]);

  const media = minimalValidOutput(5);
  const mediaClaim = '双人招牌套餐零添加、纯手工制作，顾客吃完都夸值。';
  media.images[0].desc += ` ${mediaClaim}`;
  cases.push([5, media, mediaClaim]);

  const cover = minimalValidOutput(6);
  const coverClaim = '双人招牌套餐当天熬制，全部使用精选食材。';
  cover.covers[0].html = cover.covers[0].html.replace('</body>', `<p>${coverClaim}</p></body>`);
  cases.push([6, cover, coverClaim]);

  const deck = minimalValidOutput(7);
  const deckClaim = '双人招牌套餐分量实在，两个人吃完全没问题。';
  deck.summary += ` ${deckClaim}`;
  cases.push([7, deck, deckClaim]);

  const distributor = minimalValidOutput(8);
  const distributorClaim = '双人招牌套餐每天很快售罄，晚来就吃不到，顾客一致认可。';
  distributor.publish_plan += ` ${distributorClaim}`;
  cases.push([8, distributor, distributorClaim]);

  for (const [idx, output, claim] of cases) {
    const rejected = validateContentEmployeeOutputContract(idx, output, context);
    assert.equal(rejected.valid, false, `content:${idx}\n${rejected.errors.join('；')}`);
    assert.match(rejected.errors.join('；'), /(?:撰稿|内容)事实门禁/u);

    const accepted = validateContentEmployeeOutputContract(idx, output, {
      requirement: `已核验事实：${claim}`,
    });
    assert.equal(accepted.valid, true, `grounded content:${idx}\n${accepted.errors.join('；')}`);
  }
});

test('餐饮高风险话术按事实类别默认封禁，只有明确已核验事实才能进入3-8岗对外字段', () => {
  const context = {
    requirement: '已核验事实：产品名为“双人招牌套餐”。其余口味、制作、健康、认证、供应链、奖项、排名、口碑、价格比较与稀缺事实均未提供。',
  };
  const cases = [];

  const writer = minimalValidOutput(3);
  const writerClaim = '鲜嫩多汁、入口即化、汤底浓郁、香辣过瘾；现做现卖、当天熬制、精选食材、零添加、纯手工；低脂健康、营养丰富、老少皆宜、减脂放心、零糖零脂、无麸质、无过敏原、糖尿病人放心。';
  writer.body += `\n\n${writerClaim}`;
  cases.push([3, writer, writerClaim]);

  const stylist = minimalValidOutput(4);
  const stylistClaim = '权威认证、安全卫生、孕妇儿童放心、清真、有机认证、农残检测、国家食安标准。';
  stylist.body += `\n\n${stylistClaim}`;
  cases.push([4, stylist, stylistClaim]);

  const media = minimalValidOutput(5);
  const mediaClaim = '米其林推荐、百年老店、非遗品牌、全市销量第一、本地唯一。';
  media.images[0].desc += ` ${mediaClaim}`;
  cases.push([5, media, mediaClaim]);

  const cover = minimalValidOutput(6);
  const coverClaim = '一口上瘾、回头客多、销量冠军、顾客夸值、一致认可；真材实料、绝无预制、原产地、冷链配送。';
  cover.covers[0].html = cover.covers[0].html.replace('</body>', `<p>${coverClaim}</p></body>`);
  cases.push([6, cover, coverClaim]);

  const deck = minimalValidOutput(7);
  const deckClaim = '性价比超高、全城最划算；分量实在、两个人没问题。';
  deck.summary += ` ${deckClaim}`;
  cases.push([7, deck, deckClaim]);

  const distributor = minimalValidOutput(8);
  const distributorClaim = '每天售罄，晚来吃不到。';
  distributor.publish_plan += ` ${distributorClaim}`;
  cases.push([8, distributor, distributorClaim]);

  for (const [idx, output, claim] of cases) {
    const rejected = validateContentEmployeeOutputContract(idx, output, context);
    assert.equal(rejected.valid, false, `content:${idx}\n${rejected.errors.join('；')}`);
    assert.match(rejected.errors.join('；'), /(?:撰稿|内容)事实门禁/u);
    assert.deepEqual(rejected.artifacts, []);

    const accepted = validateContentEmployeeOutputContract(idx, output, {
      requirement: `已核验事实：${claim}`,
    });
    assert.equal(accepted.valid, true, `grounded content:${idx}\n${accepted.errors.join('；')}`);
  }
});

test('餐饮高风险事实门逐条识别口碑、来源、价值、资历与特殊人群常见变体', () => {
  const claims = [
    '让人上瘾', '吃过都说好', '复购率爆表',
    '正宗做法', '绝非预制', '原料来自本地',
    '全城性价比最高', '比周边都便宜',
    '米其林品质', '百年老字号', '非遗技艺',
    '减脂人群首选', '安全放心', '孕妇儿童都能吃',
    '糖尿病人也可放心吃', '本地独家',
    '减脂首选', '孕妇儿童能吃', '糖尿病人可吃',
  ];
  for (const claim of claims) {
    const unsupported = findUnsupportedWriterMarketingFactClaims(
      `双人招牌套餐${claim}。`,
      { requirement: `已确认产品名为双人招牌套餐；“${claim}”未经核验，相关事实均未提供。` },
    );
    assert.ok(unsupported.length > 0, claim);
    const grounded = findUnsupportedWriterMarketingFactClaims(
      `双人招牌套餐${claim}。`,
      { requirement: `已核验事实：双人招牌套餐${claim}。` },
    );
    assert.equal(grounded.length, 0, claim);
  }
});

test('封面与HTML演绎禁止CSS content旁路，并把alt、aria-label与title纳入事实扫描', () => {
  const context = {
    requirement: '已核验事实：产品名为“双人招牌套餐”。品质、销量和顾客反馈均未提供。',
  };
  for (const idx of [6, 7]) {
    const output = minimalValidOutput(idx);
    const html = idx === 6 ? output.covers[0].html : output.html;
    const poisoned = html.replace(
      '</head>',
      '<style>.fake:after{content:"双人招牌套餐每天售罄，入口即化，顾客都会喜欢"}</style></head>',
    ).replace('</body>', '<div class="fake"></div></body>');
    if (idx === 6) output.covers[0].html = poisoned;
    else output.html = poisoned;
    const result = validateContentEmployeeOutputContract(idx, output, context);
    assert.equal(result.valid, false, `content:${idx}`);
    assert.match(result.errors.join('；'), /禁止使用CSS content生成正文/u);
  }

  const accessible = minimalValidOutput(7);
  accessible.html = accessible.html.replace(
    '</body>',
    '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="双人招牌套餐入口即化" aria-label="顾客都会喜欢" title="每天很快售罄"></body>',
  );
  const accessibleResult = validateContentEmployeeOutputContract(7, accessible, context);
  assert.equal(accessibleResult.valid, false);
  assert.match(accessibleResult.errors.join('；'), /内容事实门禁/u);
});

test('联网岗位0-2只能引用本次已验证检索快照，拒绝假来源、同文变体、假热度和假账号', () => {
  const web = {
    verified: true,
    results: [
      {
        title: '餐饮经营趋势公开报告',
        url: 'https://evidence.example/industry',
        snippet: '公开资料讨论成本诊断、菜单优化和分时排班，案例账号为经营研究样本号，不包含具体涨幅。',
      },
      {
        title: '门店经营案例资料',
        url: 'https://evidence.example/store',
        snippet: '案例账号为餐饮增长观察号，公开内容讨论菜单结构诊断。',
      },
      {
        title: '门店管理公开课样本',
        url: 'https://evidence.example/course',
        snippet: '门店管理公开课发布周报减负方法案例。',
      },
    ],
  };

  const trend = minimalValidOutput(0);
  trend.briefing += ' [来源1]';
  trend.channel_scan.forEach((item, index) => { item.finding += ` [来源${(index % 3) + 1}]`; });
  trend.topics.forEach((item, index) => { item.evidence += ` [来源${(index % 3) + 1}]`; });
  assert.equal(validateContentEmployeeOutputContract(0, trend, { web }).valid, true);
  const fakeHeat = structuredClone(trend);
  fakeHeat.briefing += ' 当前热度上涨88%。';
  const fakeHeatResult = validateContentEmployeeOutputContract(0, fakeHeat, { web });
  assert.equal(fakeHeatResult.valid, false);
  assert.match(fakeHeatResult.errors.join('；'), /88%.*检索快照未支持/u);

  const research = minimalValidOutput(1);
  research.summary += ' [来源1]';
  research.facts.forEach((item, index) => { research.facts[index] = `${item} [来源1]`; });
  research.viewpoints = research.viewpoints.map(item => `${item} [来源2]`);
  research.source_coverage.forEach((item, index) => { item.got += ` [来源${(index % 2) + 1}]`; });
  research.sources = web.results.slice(0, 2).map(item => ({ title: item.title, url: item.url }));
  assert.equal(validateContentEmployeeOutputContract(1, research, { web }).valid, true);
  const fakeSource = structuredClone(research);
  fakeSource.sources[0] = { title: '不存在的权威报告', url: 'https://fake.example/report' };
  const fakeSourceResult = validateContentEmployeeOutputContract(1, fakeSource, { web });
  assert.equal(fakeSourceResult.valid, false);
  assert.match(fakeSourceResult.errors.join('；'), /sources\[0\].*不是本次已验证检索快照的子集/u);

  const sameArticleVariants = {
    verified: true,
    results: [
      {
        sourceId: '来源1',
        title: '太原夜宵客流报道版本一',
        url: 'https://News.Example.com:443/report/Case?b=2&utm_source=a&a=1#top',
        snippet: '太原夜宵客流与翻台核验方法。',
      },
      {
        sourceId: '来源2',
        title: '太原夜宵客流报道版本二',
        url: 'https://news.example.com/report/Case?a=1&b=2&utm_source=b&fbclid=x&gclid=y#share',
        snippet: '太原夜宵客流与翻台核验方法。',
      },
    ],
  };
  const sameArticleResearch = structuredClone(research);
  sameArticleResearch.sources = sameArticleVariants.results.map(({ title, url }) => ({ title, url }));
  const sameArticleResult = validateContentEmployeeOutputContract(1, sameArticleResearch, {
    web: sameArticleVariants,
  });
  assert.equal(sameArticleResult.valid, false);
  assert.match(sameArticleResult.errors.join('；'), /sources.*独立来源.*同一篇文章/u);

  const distinctCaseSensitivePaths = {
    verified: true,
    results: [
      {
        sourceId: '来源1',
        title: '大写路径的公开资料',
        url: 'https://evidence.example/report/Case?a=1&b=2',
        snippet: '公开资料讨论菜单结构诊断。',
      },
      {
        sourceId: '来源2',
        title: '小写路径的公开资料',
        url: 'https://evidence.example/report/case?a=1&b=2',
        snippet: '公开资料讨论门店复盘方法。',
      },
    ],
  };
  const caseSensitiveResearch = structuredClone(research);
  caseSensitiveResearch.sources = distinctCaseSensitivePaths.results
    .map(({ title, url }) => ({ title, url }));
  const caseSensitiveResult = validateContentEmployeeOutputContract(1, caseSensitiveResearch, {
    web: distinctCaseSensitivePaths,
  });
  assert.equal(caseSensitiveResult.valid, true, caseSensitiveResult.errors.join('；'));

  const rewrittenPath = structuredClone(caseSensitiveResearch);
  rewrittenPath.sources[0].url = 'https://evidence.example/report/case?a=1&b=2';
  const rewrittenPathResult = validateContentEmployeeOutputContract(1, rewrittenPath, {
    web: distinctCaseSensitivePaths,
  });
  assert.equal(rewrittenPathResult.valid, false);
  assert.match(rewrittenPathResult.errors.join('；'), /sources\[0\].*不是本次已验证检索快照的子集/u);

  const rewrittenTitle = structuredClone(caseSensitiveResearch);
  rewrittenTitle.sources[0].title = '大写路径，的公开资料';
  const rewrittenTitleResult = validateContentEmployeeOutputContract(1, rewrittenTitle, {
    web: distinctCaseSensitivePaths,
  });
  assert.equal(rewrittenTitleResult.valid, false);
  assert.match(rewrittenTitleResult.errors.join('；'), /sources\[0\].*不是本次已验证检索快照的子集/u);

  const credentialSource = structuredClone(caseSensitiveResearch);
  const credentialWeb = structuredClone(distinctCaseSensitivePaths);
  credentialWeb.results[0].url = 'https://user:password@evidence.example/report/Case?a=1&b=2';
  credentialSource.sources[0].url = credentialWeb.results[0].url;
  const credentialResult = validateContentEmployeeOutputContract(1, credentialSource, {
    web: credentialWeb,
  });
  assert.equal(credentialResult.valid, false);
  assert.match(credentialResult.errors.join('；'), /sources.*URL.*凭据|用户名或密码/u);

  const benchmark = minimalValidOutput(2);
  benchmark.benchmarks.forEach((item, index) => { item.why_hot += ` [来源${index + 1}]`; });
  assert.equal(validateContentEmployeeOutputContract(2, benchmark, { web }).valid, true);
  const fakeBenchmark = structuredClone(benchmark);
  fakeBenchmark.benchmarks[0].account = '不存在的千万粉账号';
  fakeBenchmark.benchmarks[0].why_hot += ' 已有一亿播放。';
  const fakeBenchmarkResult = validateContentEmployeeOutputContract(2, fakeBenchmark, { web });
  assert.equal(fakeBenchmarkResult.valid, false);
  assert.match(fakeBenchmarkResult.errors.join('；'), /不存在的千万粉账号|一亿播放/u);

  for (const idx of [0, 1, 2]) {
    const noEvidence = validateContentEmployeeOutputContract(idx, minimalValidOutput(idx), {
      web: { verified: false, results: [] },
    });
    assert.equal(noEvidence.valid, false, `content:${idx}`);
    assert.match(noEvidence.errors.join('；'), /没有已验证检索快照/u);
  }
});

test('联网岗位0-2的定性结论也必须被所引快照支持，引用真实URL不能给假结论洗白', () => {
  const web = {
    verified: true,
    results: [
      {
        title: '菜单分类公开资料',
        url: 'https://evidence.example/menu-only',
        snippet: '账号经营研究样本号；仅讨论菜单分类与字段定义，不包含成本方向、口味偏好、热度、客流或转化结论。',
      },
      {
        title: '排班方法公开资料',
        url: 'https://evidence.example/schedule-only',
        snippet: '账号餐饮增长观察号；仅讨论排班表结构，不包含成本方向、口味偏好、热度、客流或转化结论。',
      },
      {
        title: '周报字段公开资料',
        url: 'https://evidence.example/report-only',
        snippet: '账号门店管理公开课；仅讨论周报字段，不包含成本方向、口味偏好、热度、客流或转化结论。',
      },
    ],
  };

  const trend = minimalValidOutput(0);
  trend.briefing += ' 权威证实全国成本持续下降、顾客偏爱甜味、话题全平台爆发。[来源1]';
  trend.channel_scan.forEach((item, index) => { item.finding += ` [来源${index + 1}]`; });
  trend.topics.forEach((item, index) => { item.evidence += ` [来源${(index % 3) + 1}]`; });
  const trendResult = validateContentEmployeeOutputContract(0, trend, { web });
  assert.equal(trendResult.valid, false);
  assert.match(trendResult.errors.join('；'), /成本趋势|消费者口味偏好|爆款\/全平台热度/u);

  const research = minimalValidOutput(1);
  research.summary += ' [来源1]';
  research.facts = research.facts.map((fact, index) => (
    index === 0
      ? '消费者普遍偏爱甜味，晚市客流增长。[来源1]'
      : `${fact} [来源1]`
  ));
  research.viewpoints = research.viewpoints.map(item => `${item} [来源2]`);
  research.source_coverage.forEach((item, index) => { item.got += ` [来源${(index % 2) + 1}]`; });
  research.sources = web.results.slice(0, 2).map(item => ({ title: item.title, url: item.url }));
  const researchResult = validateContentEmployeeOutputContract(1, research, { web });
  assert.equal(researchResult.valid, false);
  assert.match(researchResult.errors.join('；'), /消费者口味偏好|客流\/到店增长/u);

  const benchmark = minimalValidOutput(2);
  benchmark.benchmarks.forEach((item, index) => {
    item.why_hot += index === 0
      ? ' 顾客一致认可甜味并大量到店，属于行业爆款。[来源1]'
      : ` [来源${index + 1}]`;
  });
  const benchmarkResult = validateContentEmployeeOutputContract(2, benchmark, { web });
  assert.equal(benchmarkResult.valid, false);
  assert.match(benchmarkResult.errors.join('；'), /消费者口味偏好|客流\/到店增长|爆款\/全平台热度/u);
});

test('run_research的summary、data_points和viewpoints与每项事实一样必须完整引用已验证快照', () => {
  const web = {
    verified: true,
    results: [
      {
        sourceId: '来源1',
        title: '菜单工程公开研究资料',
        url: 'https://evidence.example/menu-engineering',
        snippet: '公开资料讨论菜品销售结构、贡献空间、原料消耗和库存变化的交叉核对方法。',
      },
      {
        sourceId: '来源2',
        title: '门店经营复盘公开案例',
        url: 'https://evidence.example/store-review',
        snippet: '公开案例讨论统一统计周期、门店范围、责任人与复核节点。',
      },
      {
        sourceId: '来源3',
        title: '未列入交付的其他资料',
        url: 'https://evidence.example/not-delivered',
        snippet: '该资料只存在于检索快照，未被列入本次最终来源清单。',
      },
    ],
  };
  const research = minimalValidOutput(1);
  research.summary = '本次研究将菜品销售结构、贡献空间、原料消耗与库存变化放在同一统计周期中交叉核对，并把责任人和复核节点写入后续执行清单，保留原始材料供人工复查。[来源1][来源2]';
  research.facts = research.facts.map(item => `${item} [来源1]`);
  research.data_points = [
    '菜品销售结构、贡献空间和原料消耗需要在同一统计周期内交叉核对。[来源1]',
    '目标门店的实际采购单价、销量与损耗记录尚未提供，应列入取数清单。',
  ];
  research.viewpoints = [
    '经营异常应先统一统计周期与门店范围，再沿采购、库存和销售逐层定位。[来源2]',
    '执行清单需同时写明责任人、原始材料和复核节点。[来源2]',
  ];
  research.source_coverage.forEach((item, index) => { item.got += ` [来源${(index % 2) + 1}]`; });
  research.sources = web.results.slice(0, 2).map(({ title, url }) => ({ title, url }));

  const accepted = validateContentEmployeeOutputContract(1, research, { web });
  assert.equal(accepted.valid, true, accepted.errors.join('；'));

  const missingAttribution = structuredClone(research);
  missingAttribution.summary = missingAttribution.summary.replace(/\[来源1\]\[来源2\]$/u, '');
  missingAttribution.data_points[0] = missingAttribution.data_points[0].replace(/\[来源1\]$/u, '');
  missingAttribution.viewpoints[0] = missingAttribution.viewpoints[0].replace(/\[来源2\]$/u, '');
  const rejected = validateContentEmployeeOutputContract(1, missingAttribution, { web });
  assert.equal(rejected.valid, false);
  assert.match(rejected.errors.join('；'), /summary.*必须逐项引用/u);
  assert.match(rejected.errors.join('；'), /data_points\[0\].*必须逐项引用/u);
  assert.match(rejected.errors.join('；'), /viewpoints\[0\].*必须逐项引用/u);
});

test('run_research任何[来源N]引用都必须闭合到最终sources清单', () => {
  const web = {
    verified: true,
    results: [
      { sourceId: '来源1', title: '已交付公开资料一', url: 'https://evidence.example/included-1', snippet: '公开经营指标核对方法。' },
      { sourceId: '来源2', title: '已交付公开资料二', url: 'https://evidence.example/included-2', snippet: '公开门店复盘和责任人方法。' },
      { sourceId: '来源3', title: '未交付公开资料三', url: 'https://evidence.example/omitted-3', snippet: '公开菜单工程分析方法。' },
    ],
  };
  const research = minimalValidOutput(1);
  research.summary += ' [来源1]';
  research.facts = research.facts.map((item, index) => `${item} [来源${index === 0 ? 3 : 1}]`);
  research.data_points = research.data_points.map(item => `${item} [来源1]`);
  research.viewpoints = research.viewpoints.map(item => `${item} [来源2]`);
  research.source_coverage.forEach((item, index) => { item.got += ` [来源${(index % 2) + 1}]`; });
  research.sources = web.results.slice(0, 2).map(({ title, url }) => ({ title, url }));

  const result = validateContentEmployeeOutputContract(1, research, { web });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('；'), /facts\[0\].*最终sources|来源3.*最终sources/u);
});

test('run_research不允许在已有结论末尾追加“待核验”绕过引用支持校验', () => {
  const web = {
    verified: true,
    results: [
      {
        sourceId: '来源1',
        title: '菜单字段公开资料',
        url: 'https://evidence.example/menu-fields',
        snippet: '只讨论菜单字段定义，不包含成本方向结论。',
      },
      {
        sourceId: '来源2',
        title: '复盘字段公开资料',
        url: 'https://evidence.example/review-fields',
        snippet: '只讨论复盘字段与责任人结构。',
      },
    ],
  };
  const research = minimalValidOutput(1);
  research.summary += ' [来源1]';
  research.facts = research.facts.map(item => `${item} [来源1]`);
  research.facts[0] = '全国餐饮成本持续上涨。[来源1]；该结论待核验。';
  research.data_points = research.data_points.map(item => `${item} [来源1]`);
  research.viewpoints = research.viewpoints.map(item => `${item} [来源2]`);
  research.source_coverage.forEach((item, index) => { item.got += ` [来源${(index % 2) + 1}]`; });
  research.sources = web.results.map(({ title, url }) => ({ title, url }));

  const result = validateContentEmployeeOutputContract(1, research, { web });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('；'), /facts\[0\].*成本趋势.*未被其引用的检索快照支持/u);
});

test('分发官事实缺失硬校验拒绝虚构最佳时间、发布间隔与经营信息', () => {
  const output = minimalValidOutput(8);
  output.versions[0] = {
    ...output.versions[0],
    body: '点击预约链接 https://booking.example.test，联系电话13800138000，门店位于北京市朝阳区建国路88号。售价99元、8折优惠、限量100份并赠送可乐1瓶。',
    best_time: '工作日 12:00-13:00',
  };
  output.publish_plan = '公众号发布后间隔30-60分钟发布下一平台。';
  const context = {
    requirement: '历史最佳发布时间未提供，只能写待账号历史数据确认；预约链接、联系电话、门店地址、价格、折扣、库存与赠品均未提供。',
    feedback: '发布间隔也未提供，不得自行补值。',
  };

  const result = validateContentEmployeeOutputContract(8, output, context);
  assert.equal(result.valid, false);
  for (const expected of [
    '预约/报名链接', '联系电话', '门店地址', '价格/金额',
    '折扣/优惠', '库存/限量', '赠品/赠送', 'best_time', 'publish_plan',
  ]) assert.match(result.errors.join('；'), new RegExp(expected, 'u'));
  assert.deepEqual(result.artifacts, []);
});

test('分发官在缺失事实上只写待确认/发布前补齐时可通过', () => {
  const output = minimalValidOutput(8);
  const pendingBody = [
    '预约链接、联系电话和门店地址须在发布前补齐；价格、折扣、库存与赠品未确认前不得写入成稿。',
    '当前版本只保留内容结构、核心问题与人工复核节点，不使用任何未经任务书确认的经营承诺。',
    '负责人完成资料回收后，应逐项核对原始凭证、记录来源和确认时间，再将已确认信息替换进对应位置。',
    '如发布前仍缺少关键事实，则继续保持待确认标记并暂停发布，不能为了成稿完整而自行补值。',
  ].join('');
  output.versions = output.versions.map(version => ({
    ...version,
    body: pendingBody,
    best_time: '待账号历史数据确认',
  }));
  output.publish_plan = '各平台顺序、发布节奏与审核负责人均待业务负责人确认，完成事实复核后再分别进入排期。';
  const context = {
    requirement: '历史最佳发布时间未提供，只能写待账号历史数据确认；预约链接、联系电话、门店地址、价格、折扣、库存与赠品均未提供。',
  };

  const result = validateContentEmployeeOutputContract(8, output, context);
  assert.equal(result.valid, true, result.errors.join('；'));
  assert.equal(result.artifacts.length, 1);
});

test('分发官publish_plan只允许任务书已给出的具体时间间隔', () => {
  const output = minimalValidOutput(8);
  output.versions.forEach(version => { version.best_time = '待账号历史数据确认'; });
  output.publish_plan = '公众号与小红书之间间隔30分钟，两端发布前均须人工确认事实、账号与素材版本。';
  const result = validateContentEmployeeOutputContract(8, output, {
    requirement: '历史最佳发布时间未提供；公众号与小红书发布间隔按30分钟执行。',
  });
  assert.equal(result.valid, true, result.errors.join('；'));
});

test('分发官默认允许派活式建议时段和发布节奏', () => {
  const output = minimalValidOutput(8);
  output.versions.forEach(version => { version.best_time = '工作日 12:00-13:00'; });
  output.publish_plan = '先发公众号，间隔2小时再发小红书，两端发布前均须人工确认事实。';
  const result = validateContentEmployeeOutputContract(8, output, {
    requirement: '为餐饮老板生产一套可核验内容。预约链接、联系电话均未提供。',
  });
  assert.equal(result.valid, true, result.errors.join('；'));
});

test('趋势官未覆盖渠道允许写无明显信号，不必引用来源', () => {
  const web = {
    verified: true,
    results: [
      {
        title: '餐饮经营趋势公开报告',
        url: 'https://evidence.example/industry',
        snippet: '公开资料讨论成本诊断、菜单优化和分时排班，案例账号为经营研究样本号，不包含具体涨幅。',
      },
      {
        title: '门店经营案例资料',
        url: 'https://evidence.example/store',
        snippet: '案例账号为餐饮增长观察号，公开内容讨论菜单结构诊断。',
      },
      {
        title: '门店管理公开课样本',
        url: 'https://evidence.example/course',
        snippet: '门店管理公开课发布周报减负方法案例。',
      },
    ],
  };
  const trend = minimalValidOutput(0);
  trend.briefing += ' [来源1]';
  trend.channel_scan[0].finding = '无明显信号';
  trend.channel_scan.slice(1).forEach((item, index) => {
    item.finding += ` [来源${index + 1}]`;
  });
  trend.topics.forEach((item, index) => {
    item.evidence += ` [来源${(index % 3) + 1}]`;
  });
  const result = validateContentEmployeeOutputContract(0, trend, { web });
  assert.equal(result.valid, true, result.errors.join('；'));
});

test('文风师把小标题压成一行空格时契约失败', () => {
  const output = minimalValidOutput(4);
  output.body = output.body.replaceAll('\n', ' ');
  const result = validateContentEmployeeOutputContract(4, output);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('；'), /分段 Markdown/u);
});

test('内容流水线按派活组装各平台拿来即发 packs', () => {
  const delivery = assembleContentPipelineDelivery({
    3: minimalValidOutput(3),
    4: minimalValidOutput(4),
    5: minimalValidOutput(5),
    6: minimalValidOutput(6),
    8: minimalValidOutput(8),
    9: minimalValidOutput(9),
  });
  assert.equal(delivery.schemaVersion, 'nanowork.content-pipeline-delivery/1');
  assert.ok(delivery.title);
  assert.equal(delivery.packs.length, 3);
  assert.equal(delivery.packs[0].emoji, '💬');
  assert.match(delivery.packs[0].upload_url, /mp\.weixin\.qq\.com/u);
  assert.ok(delivery.packs[0].cover);
  assert.ok(Array.isArray(delivery.packs[0].images));
  assert.ok(delivery.publish_plan);
  assert.ok(delivery.retro.report);
});

test('价格字段缺失时允许复用输入已确认金额及等值货币格式，仍拒绝新造99元', () => {
  const output = minimalValidOutput(4);
  output.body = [
    '# 本月经营数据解读',
    '任务书已经确认本月营业额为¥100,000，食材成本为￥35,000。本文只复述这两个已知金额，不把它们改写成菜品价格、客单价或活动售价。',
    '## 可确认结论',
    '现阶段可以围绕营业额和食材成本建立复核表，逐项标记数据来源、统计周期、门店范围与负责人。商品价格仍待确认，因此正文不推导折扣、套餐价或促销承诺。',
    '## 执行清单',
    '第一步核对收银系统营业额口径；第二步核对采购与领用记录；第三步由负责人补齐商品价格表；第四步在发布前复查每个数字是否能回到原始凭证。',
    '## 内容边界',
    '在缺少商品价格的情况下，只讲已知经营指标的核验方法，不给消费者价格结论，也不使用未经确认的金额制造吸引力。',
  ].join('\n\n');
  const context = {
    requirement: '本月营业额100000元、食材成本35000元已经确认；商品价格和客单价未提供。',
  };

  const accepted = validateContentEmployeeOutputContract(4, output, context);
  assert.equal(accepted.valid, true, accepted.errors.join('；'));

  const reverseFormat = structuredClone(output);
  reverseFormat.body = reverseFormat.body
    .replace('¥100,000', '100000元')
    .replace('￥35,000', '35000元');
  const reverseAccepted = validateContentEmployeeOutputContract(4, reverseFormat, {
    requirement: '本月营业额¥100,000、食材成本￥35,000已经确认；商品价格和客单价未提供。',
  });
  assert.equal(reverseAccepted.valid, true, reverseAccepted.errors.join('；'));

  output.body += '\n\n建议售价99元，这是输入中没有出现的新金额。';
  const rejected = validateContentEmployeeOutputContract(4, output, context);
  assert.equal(rejected.valid, false);
  assert.match(rejected.errors.join('；'), /未在输入中确认的具体值“99元”/u);
  assert.deepEqual(rejected.artifacts, []);
});

test('其他缺失事实类别也只允许复用输入已确认具体值', () => {
  const output = minimalValidOutput(8);
  const confirmedBody = [
    '本次只使用任务书明确确认的信息：预约链接 https://confirmed.example.test/book，联系电话13800138000，门店位于北京市朝阳区建国路88号，会员8折，限量100份并赠送可乐1瓶。',
    '除此之外的报名入口、联系方式、门店定位、优惠方式、库存数量与赠品内容都继续标记为待确认。',
    '发布前由负责人逐项比对原始材料并记录确认时间，任何新增值都必须重新审核，不能根据常识补写。',
  ].join('');
  output.versions.forEach(version => { version.body = confirmedBody; });
  const context = {
    requirement: '已确认预约入口 https://confirmed.example.test/book、联系电话13800138000、门店位于北京市朝阳区建国路88号、会员折扣8折、限量100份、赠送可乐1瓶；其他报名链接、联系电话、门店地址、优惠、库存与赠品均未提供。',
  };

  const accepted = validateContentEmployeeOutputContract(8, output, context);
  assert.equal(accepted.valid, true, accepted.errors.join('；'));

  output.versions[0].body = output.versions[0].body.replace('13800138000', '13900139000');
  const rejected = validateContentEmployeeOutputContract(8, output, context);
  assert.equal(rejected.valid, false);
  assert.match(rejected.errors.join('；'), /联系电话.*13900139000/u);
  assert.deepEqual(rejected.artifacts, []);
});

test('真实矩阵上下文允许确定性派生目标成本与差额，疑问式赠送核验不算赠品断言', () => {
  const output = minimalValidOutput(4);
  output.body = [
    '# 本月成本目标复核',
    '已知本月营业额100000元、食材成本35000元、目标成本率32%。按照任务书明确允许的计算边界，目标成本为32000元，当前食材成本与目标成本的差额为3000元。',
    '以上结果只来自已确认金额和比例，不代表菜品售价、客单价或促销金额，也不引入新的门店经营事实。',
    '下一步应核对收入与成本是否使用同一统计周期、门店范围和会计口径，并逐项回到收银、采购、入库与领用凭证。',
    '还需要向负责人核验：赠送有没有被算进成本？这个问题只进入待核验清单，在取得原始记录前不声称存在任何赠品。',
    '复核完成后记录材料来源、确认人和确认时间；若口径变化，则重新计算并保留前后版本，不能用推测补齐空白。',
  ].join('\n\n');
  const context = {
    requirement: '本月营业额100000元、食材成本35000元、目标成本率32%已经确认；商品价格、客单价与赠品均未提供；差额与比例只可基于这些数字计算。',
    feedback: '请给出目标成本和差额，并把“赠送有没有被算进成本”列为待核验问题。',
  };

  const accepted = validateContentEmployeeOutputContract(4, output, context);
  assert.equal(accepted.valid, true, accepted.errors.join('；'));

  const noPermission = validateContentEmployeeOutputContract(4, output, {
    ...context,
    requirement: '本月营业额100000元、食材成本35000元、目标成本率32%已经确认；商品价格、客单价与赠品均未提供。',
  });
  assert.equal(noPermission.valid, false);
  assert.match(noPermission.errors.join('；'), /价格\/金额.*32000元/u);

  const inventedPrice = structuredClone(output);
  inventedPrice.body += '\n\n建议售价99元。';
  const inventedPriceResult = validateContentEmployeeOutputContract(4, inventedPrice, context);
  assert.equal(inventedPriceResult.valid, false);
  assert.match(inventedPriceResult.errors.join('；'), /价格\/金额.*99元/u);

  const inventedGift = structuredClone(output);
  inventedGift.body = inventedGift.body.replace(
    '赠送有没有被算进成本？这个问题只进入待核验清单',
    '已经赠送可乐1瓶。这个结论进入执行清单',
  );
  const inventedGiftResult = validateContentEmployeeOutputContract(4, inventedGift, context);
  assert.equal(inventedGiftResult.valid, false);
  assert.match(inventedGiftResult.errors.join('；'), /赠品\/赠送.*赠送可乐1瓶/u);
});

test('明确计算授权时允许已知金额除以已知数量，不放行任意金额或零除', () => {
  const context = {
    requirement: '食材成本35000元、订单2000单已经确认；商品价格、客单价未提供；只可基于这些已知数字计算。',
  };
  const derived = minimalValidOutput(5);
  derived.images[0].svg = derived.images[0].svg.replace(
    '</svg>',
    '<text x="40" y="180">已知成本除以已知订单数为17.5元/单</text></svg>',
  );

  const accepted = validateContentEmployeeOutputContract(5, derived, context);
  assert.equal(accepted.valid, true, accepted.errors.join('；'));

  const noPermission = validateContentEmployeeOutputContract(5, derived, {
    requirement: '食材成本35000元、订单2000单已经确认；商品价格、客单价未提供。',
  });
  assert.equal(noPermission.valid, false);
  assert.match(noPermission.errors.join('；'), /价格\/金额.*17\.5元/u);

  for (const inventedAmount of ['50元', '99元']) {
    const invented = structuredClone(derived);
    invented.images[0].svg = invented.images[0].svg.replace('17.5元/单', `${inventedAmount}/单`);
    const result = validateContentEmployeeOutputContract(5, invented, context);
    assert.equal(result.valid, false, inventedAmount);
    assert.match(result.errors.join('；'), new RegExp(`价格\\/金额.*${inventedAmount}`, 'u'));
  }

  const zeroDivisor = validateContentEmployeeOutputContract(5, derived, {
    requirement: '食材成本35000元、订单0单已经确认；商品价格、客单价未提供；只可基于这些已知数字计算。',
  });
  assert.equal(zeroDivisor.valid, false);
  assert.match(zeroDivisor.errors.join('；'), /价格\/金额.*17\.5元/u);
});

test('赠品事实缺失时允许核验、建议、条件与分类统计，仍拒绝明确发生断言', () => {
  const context = {
    requirement: '赠品与赠送记录均未提供，只能给出核验程序和分类统计方法。',
  };
  const proceduralMentions = [
    '赠送、退单、员工餐、试菜等项目分开看，再由负责人回到原始凭证核验。',
    '建议把赠送项目单列统计，当前不对是否存在赠品下结论。',
    '如有赠送可乐1瓶的情况，需单列记录并等待负责人核验。',
    '需要核对赠品是否存在？未取得凭证前不写入经营结论。',
  ];

  for (const mention of proceduralMentions) {
    const output = minimalValidOutput(4);
    output.body += `\n\n${mention}`;
    const result = validateContentEmployeeOutputContract(4, output, context);
    assert.equal(result.valid, true, `${mention}\n${result.errors.join('；')}`);
  }

  for (const assertion of [
    '已赠送可乐1瓶，该数量将直接进入成本统计。',
    '本次赠送了饮料2瓶，请把结论写入执行清单。',
    '建议记录：实际附赠伴手礼1份。',
  ]) {
    const output = minimalValidOutput(4);
    output.body += `\n\n${assertion}`;
    const result = validateContentEmployeeOutputContract(4, output, context);
    assert.equal(result.valid, false, assertion);
    assert.match(result.errors.join('；'), /赠品\/赠送/u);
    assert.deepEqual(result.artifacts, []);
  }
});

test('10个岗位逐字段拒绝null、错类型、空数组与缺字段', () => {
  for (let idx = 0; idx < VALID_OUTPUTS.length; idx += 1) {
    const profile = buildContentEmployeeWorkbenchProfile(idx);
    for (const key of profile.jobProfile.outputSchema.keys) {
      const valid = minimalValidOutput(idx);
      const expected = valid[key];
      const cases = [
        ['缺字段', output => { delete output[key]; }],
        ['null', output => { output[key] = null; }],
        ['错类型', output => { output[key] = Array.isArray(expected) ? {} : []; }],
      ];
      if (Array.isArray(expected) && !(idx === 9 && key === 'profile_updates')) {
        cases.push(['空数组', output => { output[key] = []; }]);
      }
      for (const [label, mutate] of cases) {
        const output = minimalValidOutput(idx);
        mutate(output);
        const result = validateContentEmployeeOutputContract(idx, JSON.stringify(output));
        assert.equal(
          result.valid,
          false,
          `${profile.identity.name}.${key} 应拒绝${label}`,
        );
        assert.match(result.errors.join(' '), new RegExp(key, 'u'));
        assert.deepEqual(result.artifacts, []);
      }
    }
  }
});

test('岗位数组中的对象结构、数量与内层非空数组同样严格校验', () => {
  const cases = [
    [0, output => { output.topics = output.topics.slice(0, 4); }, /topics.*恰好.*5/iu],
    [0, output => { delete output.channel_scan[0].finding; }, /channel_scan\[0\]\.finding/iu],
    [1, output => { output.sources[0].url = '不是链接'; }, /sources\[0\]\.url/iu],
    [2, output => { output.benchmarks[0].dimensions = {}; }, /benchmarks\[0\]\.dimensions/iu],
    [3, output => { output.title_candidates = ['只有一个']; }, /title_candidates.*3-5/iu],
    [3, output => { output.tags = ['一', '二', '三', '四']; }, /tags.*5-8/iu],
    [3, output => { delete output.image_plan[0].desc; }, /image_plan\[0\]\.desc/iu],
    [5, output => { output.images[0].svg = '不是SVG'; }, /images\[0\]\.svg/iu],
    [6, output => { output.covers[0].html = '<div>不是完整页面</div>'; }, /covers\[0\]\.html/iu],
    [8, output => { output.versions[0].tags = []; }, /versions\[0\]\.tags/iu],
    [8, output => { output.versions[0].checklist = ['只有一步']; }, /versions\[0\]\.checklist.*2-4/iu],
    [9, output => { output.next_topics[0].reason = null; }, /next_topics\[0\]\.reason/iu],
  ];

  for (const [idx, mutate, expectedError] of cases) {
    const output = minimalValidOutput(idx);
    mutate(output);
    const result = validateContentEmployeeOutputContract(idx, JSON.stringify(output));
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), expectedError);
    assert.deepEqual(result.artifacts, []);
  }
});

test('严格契约拒绝未知顶层字段和未知对象字段', () => {
  const topLevel = minimalValidOutput(3);
  topLevel.uncontracted = '不在契约内';
  const topResult = validateContentEmployeeOutputContract(3, JSON.stringify(topLevel));
  assert.equal(topResult.valid, false);
  assert.match(topResult.errors.join(' '), /未知字段.*uncontracted/u);

  const nested = minimalValidOutput(0);
  nested.topics[0].uncontracted = '不在契约内';
  const nestedResult = validateContentEmployeeOutputContract(0, JSON.stringify(nested));
  assert.equal(nestedResult.valid, false);
  assert.match(nestedResult.errors.join(' '), /topics\[0\].*未知字段.*uncontracted/u);
});

test('支持完整的json Markdown围栏且兼容导出别名', () => {
  const output = minimalValidOutput(0);
  const fenced = `\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\``;
  const result = validateContentOutputContract(0, fenced);

  assert.equal(validateContentOutputContract, validateContentEmployeeOutputContract);
  assert.equal(result.valid, true);
  assert.deepEqual(result.parsed, output);
  assert.equal(result.artifacts[0].kind, 'json');
});

test('缺字段时不静默补齐且不生成artifact', () => {
  const output = minimalValidOutput(3);
  delete output.body;
  const result = validateContentEmployeeOutputContract(3, JSON.stringify(output));

  assert.equal(result.valid, false);
  assert.equal(Object.hasOwn(result.parsed, 'body'), false);
  assert.match(result.errors.join(' '), /缺少必需字段：body/u);
  assert.deepEqual(result.artifacts, []);
  assert.equal(result.previewMarkdown, JSON.stringify(output));
});

test('畸形JSON和非JSON降级底稿返回明确错误并原样保留preview', () => {
  const malformed = '{"briefing":';
  const malformedResult = validateContentEmployeeOutputContract(0, malformed);
  assert.equal(malformedResult.valid, false);
  assert.equal(malformedResult.parsed, null);
  assert.match(malformedResult.errors.join(' '), /不是有效 JSON/u);
  assert.equal(malformedResult.previewMarkdown, malformed);
  assert.deepEqual(malformedResult.artifacts, []);

  const draft = '# 暂存底稿\n\n材料不完整，以下仅为待核验草案。';
  const draftResult = validateContentEmployeeOutputContract(9, draft);
  assert.equal(draftResult.valid, false);
  assert.match(draftResult.errors.join(' '), /不是有效 JSON/u);
  assert.equal(draftResult.previewMarkdown, draft);
  assert.deepEqual(draftResult.artifacts, []);
});

test('顶层数组不是岗位输出对象', () => {
  const result = validateContentEmployeeOutputContract(1, '[]');
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /顶层必须是 JSON 对象/u);
  assert.deepEqual(result.artifacts, []);
});

test('演绎师提取真实HTML主产物并生成安全确定的文件名', () => {
  const firstOutput = minimalValidOutput(7);
  const first = validateContentEmployeeOutputContract(7, JSON.stringify(firstOutput));
  const repeated = validateContentEmployeeOutputContract(7, JSON.stringify(firstOutput));
  const second = validateContentEmployeeOutputContract(7, JSON.stringify({
    ...firstOutput,
    summary: '这是另一份完整演绎稿摘要，调整了标题表达但继续保留口径、证据与行动闭环。',
    html: firstOutput.html.replace('成本异常，先别急着追责', '经营异常，先把证据找齐'),
  }));

  assert.equal(first.valid, true);
  assert.equal(first.artifacts[0].kind, 'html');
  assert.match(first.artifacts[0].filename, /^content-employee-07-deck-[a-f0-9]{12}\.html$/u);
  assert.equal(repeated.artifacts[0].filename, first.artifacts[0].filename);
  assert.notEqual(second.artifacts[0].filename, first.artifacts[0].filename);
  assert.equal(first.artifacts[0].mediaType, 'text/html');
  assert.equal(first.artifacts[0].content, firstOutput.html);
  assert.match(first.previewMarkdown, /HTML 主产物已通过契约校验/u);
  assert.match(first.artifacts[0].filename, /^[a-z0-9.-]+$/u);
});

test('演绎师拒绝不完整HTML、javascript协议和外部脚本', () => {
  const unsafeCases = [
    {
      html: '<div>不是完整页面</div>',
      error: /html.*根元素|body.*正文元素/iu,
    },
    {
      html: '<html><body><a href="java&#x73;cript:alert(1)">危险链接</a></body></html>',
      error: /javascript: URL/u,
    },
    {
      html: '<html><body><script src="https://example.com/app.js"></script></body></html>',
      error: /外部脚本/u,
    },
  ];

  for (const unsafe of unsafeCases) {
    const rawOutput = JSON.stringify({
      summary: '不安全演绎稿',
      html: unsafe.html,
    });
    const result = validateContentEmployeeOutputContract(7, rawOutput);
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), unsafe.error);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.previewMarkdown, rawOutput);
  }
});
