import assert from 'node:assert/strict';
import { test } from 'node:test';
import { xhsOutput, xhsFactPack } from './helpers/xhs-output-fixtures.mjs';
import { VALID_CONTENT_EMPLOYEE_OUTPUTS } from './helpers/content-output-fixtures.mjs';

Object.assign(process.env, { NANOWORK_TEST_TEMPLATE_AI: '1', NODE_ENV: 'test', NANOWORK_DB: ':memory:',
  ENABLE_SCHEDULER: 'false', ENABLE_BACKGROUND_EMBEDDINGS: 'false', YUNWU_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' });
const { createContentHandlerAdapterRegistry } = await import('../src/engines/content-handler-adapters.js');
const { assembleContentPipelineDelivery, renderContentPipelineDeliveryMarkdown } = await import('../src/engines/content-pipeline-delivery.js');
const { xhsVersionId } = await import('../src/engines/content-xhs-output.js');
const { validatePaihuoContentBrief } = await import('../src/engines/content-production-pipeline.js');
const { buildPaihuoContentBrief } = await import('../../web/src/components/contentBriefForm.js');
const { pipelineCandidates } = await import('../../web/src/components/contentPipelinePresentation.js');
const { validateContentEmployeeOutputContract } = await import('../src/engines/content-output-contract.js');

function chosenOutput(index = 2) {
  const draft = xhsOutput();
  return { ...draft, xhsSelection: { versionId: xhsVersionId(draft.versions[index]), strategy: draft.versions[index].strategy } };
}
async function invocation(employeeIdx, outputs) {
  let observed;
  const registry = createContentHandlerAdapterRegistry({
    compile: input => ({ system: 'test system', user: JSON.stringify(input.variables) }),
    invoke: async input => { observed = input; return { data: { done: true } }; },
  });
  await registry.invoke(employeeIdx, { executionMode: 'pipeline', outputs,
    brief: { direction: '原任务不是发布标题', material: '原任务材料不能成为下游正文', platforms: ['小红书'] } });
  return observed;
}

test('流水线 Brief 保留明确小红书模式与2-4版选项，不因默认平台切换契约', () => {
  const form = { title: '写一组午餐笔记', type: '小红书带货笔记', xhsOptions: { versionCount: 4, audience: '白领', scene: '午餐' } };
  const brief = validatePaihuoContentBrief(buildPaihuoContentBrief(form));
  assert.equal(brief.xhsOptions.versionCount, 4);
  assert.equal(brief.xhsOptions.scene, '午餐');
  assert.equal(validatePaihuoContentBrief({ direction: '普通稿', platforms: ['小红书'] }).xhsOptions, undefined);
  assert.throws(() => validatePaihuoContentBrief({ ...brief, xhsOptions: { versionCount: 5 } }), /2.*4/);
});

test('未选版不能调用下游，不能静默回退到任务材料或自评分最高版', async () => {
  for (const idx of [4, 5, 6, 7, 8, 9]) {
    await assert.rejects(invocation(idx, { 3: xhsOutput() }), /选择.*版本|选版/);
  }
  const delivery = assembleContentPipelineDelivery({ 3: xhsOutput() });
  assert.equal(delivery.body, '');
  assert.equal(delivery.xhsSelectionRequired, true);
  assert.equal(delivery.xhsVersions.length, 3);
  assert.deepEqual(delivery.packs, []);
});

test('已选非推荐版进入各下游变量，封面采用该版封面文案', async () => {
  const draft = chosenOutput();
  const selected = draft.versions[2];
  const style = await invocation(4, { 3: draft });
  assert.equal(style.variables.title, selected.title);
  assert.equal(style.variables.draft_body, selected.body);
  for (const idx of [5, 7, 8, 9]) {
    const result = await invocation(idx, { 3: draft });
    assert.equal(result.variables.body, selected.body);
    assert.equal(result.variables.title, selected.title);
  }
  const cover = await invocation(6, { 3: draft });
  assert.ok(cover.variables.cover_request.plan[0].desc.includes(selected.cover_text));
});

test('最终交付保留全部源版本、选版哈希、配图计划，并补齐首评与封面文案', () => {
  const draft = chosenOutput();
  const selected = draft.versions[2];
  const delivery = assembleContentPipelineDelivery({ 3: draft, 8: {
    versions: [{ platform: '小红书', title: selected.title, body: selected.body, tags: selected.tags, checklist: [] }], publish_plan: '人工去平台发布',
  } });
  assert.equal(delivery.body, selected.body);
  assert.equal(delivery.title, selected.title);
  assert.equal(delivery.xhsVersions.length, 3);
  assert.equal(delivery.xhsSelection.versionId, xhsVersionId(selected));
  assert.deepEqual(delivery.xhsImagePlan, draft.image_plan);
  assert.equal(delivery.packs[0].comment_prompt, selected.comment_prompt);
  assert.equal(delivery.packs[0].cover_text, selected.cover_text);
  assert.equal(delivery.packs[0].source_version_id, xhsVersionId(selected));
  assert.match(renderContentPipelineDeliveryMarkdown(delivery), /首评/);
  const candidates = pipelineCandidates({ stationIdx: 3, output: draft });
  assert.equal(candidates.length, 3);
  assert.match(candidates[2].label, /对比型/);
});

test('文风定稿必须保留已选版的小红书格式，分发不能重写小红书定稿', () => {
  const draft = chosenOutput();
  const version = draft.versions[2];
  const context = { executionMode: 'pipeline', outputs: { 3: draft }, storeFacts: xhsFactPack,
    enforceRequiredInputs: false, brief: { platforms: ['小红书'] } };
  const styled = { ...structuredClone(VALID_CONTENT_EMPLOYEE_OUTPUTS[4]), body: version.body,
    title_candidates: [version.title, '午餐选面先看菜单', '把自己的需求列清楚'] };
  const valid = validateContentEmployeeOutputContract(4, styled, context);
  assert.equal(valid.valid, true, JSON.stringify(valid.errors));
  const invalid = validateContentEmployeeOutputContract(4, { ...styled, body: version.body.replace(/🍜/u, '').replace(/\n\n/gu, '') }, context);
  assert.equal(invalid.valid, false, '通用长段正文不能冒充小红书定稿');
  const publish = { ...structuredClone(VALID_CONTENT_EMPLOYEE_OUTPUTS[8]), versions: [{
    ...structuredClone(VALID_CONTENT_EMPLOYEE_OUTPUTS[8].versions[0]), platform: '小红书',
    title: version.title, body: version.body, tags: version.tags,
  }] };
  const publishContext = { ...context, outputs: { 3: draft, 4: styled } };
  const accepted = validateContentEmployeeOutputContract(8, publish, publishContext);
  assert.equal(accepted.valid, true, JSON.stringify(accepted.errors));
  for (const field of ['title', 'body', 'tags']) {
    const changed = structuredClone(publish);
    changed.versions[0][field] = field === 'tags' ? ['午餐', '面食', '选择', '菜单', '探店'] : `${changed.versions[0][field]} 改写`;
    const result = validateContentEmployeeOutputContract(8, changed, publishContext);
    assert.equal(result.valid, false, `${field}不能悄悄重写`);
    assert.match(result.errors.join(' '), /已选|定稿/);
  }
});
