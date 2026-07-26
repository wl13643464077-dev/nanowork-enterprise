import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildContentEmployeeWorkbenchProfile } from '../src/engines/content-employee-workbench.js';
import {
  validateContentEmployeeOutputContract,
  validateContentOutputContract,
} from '../src/engines/content-output-contract.js';

const VALUE_BY_KEY = Object.freeze({
  briefing: '趋势简报',
  channel_scan: [],
  topics: [],
  summary: '工作摘要',
  facts: [],
  data_points: [],
  viewpoints: [],
  source_coverage: [],
  sources: [],
  benchmarks: [],
  comment_insights: [],
  user_language: [],
  takeaways: [],
  title_candidates: [],
  body: '正文 Markdown',
  tags: [],
  image_plan: [],
  consistency_note: '一致性说明',
  images: [],
  covers: [],
  html: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>演绎正文</body></html>',
  versions: [],
  publish_plan: '发布计划',
  report: '复盘报告 Markdown',
  next_topics: [],
  profile_updates: [],
});

function minimalValidOutput(idx) {
  const schema = buildContentEmployeeWorkbenchProfile(idx).jobProfile.outputSchema;
  return Object.fromEntries(schema.keys.map(key => [key, structuredClone(VALUE_BY_KEY[key])]));
}

test('10个内容岗位均按自身outputSchema接受覆盖全部outputKeys的最小对象', () => {
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
  }
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
    summary: '另一份摘要不会改变文件名',
    html: '<html><head></head><body>另一份完整正文</body></html>',
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
