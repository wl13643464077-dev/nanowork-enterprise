import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildContentEmployeeWorkbenchProfile } from '../src/engines/content-employee-workbench.js';
import {
  validateContentEmployeeOutputContract,
  validateContentOutputContract,
} from '../src/engines/content-output-contract.js';

const VALID_OUTPUTS = Object.freeze([
  {
    briefing: '趋势简报',
    channel_scan: [{ channel: '官方公告', finding: '发现一项可核验的新信号' }],
    topics: Array.from({ length: 5 }, (_, index) => ({
      title: `选题${index + 1}`,
      angle: '从经营者视角切入',
      hook: '一个可验证的开头钩子',
      reason: '与目标账号和当前信号匹配',
      heat: '中',
      evidence: '来自官方公告',
    })),
  },
  {
    summary: '工作摘要',
    facts: ['事实一（来源：官方公告）'],
    data_points: ['数据点一（来源：官方公告）'],
    viewpoints: ['观点一'],
    source_coverage: [{ channel: '官方公告', got: '找到可核验事实' }],
    sources: [{ title: '官方资料', url: 'https://example.test/source' }],
  },
  {
    benchmarks: Array.from({ length: 3 }, (_, index) => ({
      title: `对标内容${index + 1}`,
      platform: '公众号',
      account: '示例账号',
      dimensions: { 开头: '直接说明用户问题' },
      why_hot: '结构清晰且回应真实问题',
    })),
    comment_insights: ['读者关注可执行性'],
    user_language: ['这一步到底怎么做'],
    takeaways: ['开头先给结论'],
  },
  {
    title_candidates: ['标题一', '标题二', '标题三'],
    body: '正文 Markdown',
    tags: ['经营', '门店', '增长', '复盘', '实操'],
    image_plan: [
      { slot: '开头', desc: '核心结论信息图' },
      { slot: '正文', desc: '执行步骤示意图' },
    ],
  },
  {
    body: '风格化正文 Markdown',
    title_candidates: ['标题一', '标题二', '标题三'],
    consistency_note: '已保持历史表达节奏，并保留事实边界。',
  },
  {
    images: [{
      slot: '正文',
      desc: '经营步骤信息图',
      platform: '通用',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1440"><text x="20" y="40">步骤</text></svg>',
    }],
  },
  {
    covers: [{
      style: '简洁商务',
      platform: '公众号',
      size: '1080×1440',
      html: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>封面</body></html>',
    }],
  },
  {
    summary: '演绎稿说明',
    html: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>演绎正文</body></html>',
  },
  {
    versions: [{
      platform: '公众号',
      title: '适配标题',
      body: '适配正文',
      tags: ['经营'],
      best_time: '工作日 12:00-13:00',
      checklist: ['检查标题', '人工确认发布'],
      note: '发布前复核事实与链接。',
    }],
    publish_plan: '先发布公众号，复核反馈后再适配其他平台。',
  },
  {
    report: '复盘报告 Markdown',
    next_topics: [{ title: '下一轮选题', reason: '延续真实反馈' }],
    profile_updates: ['读者更关注可执行步骤'],
  },
]);

function minimalValidOutput(idx) {
  const schema = buildContentEmployeeWorkbenchProfile(idx).jobProfile.outputSchema;
  const output = structuredClone(VALID_OUTPUTS[idx]);
  assert.deepEqual(Object.keys(output), schema.keys);
  return output;
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
      if (Array.isArray(expected)) {
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
    [3, output => { output.title_candidates = ['只有一个']; }, /title_candidates.*恰好.*3/iu],
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
