import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-360-websearch-'));
const dbPath = path.join(testRoot, 'test.db');
const originalEnv = {
  NANOWORK_DB: process.env.NANOWORK_DB,
  NANOWORK_TEST_TEMPLATE_AI: process.env.NANOWORK_TEST_TEMPLATE_AI,
  NANOWORK_AI_PROVIDER: process.env.NANOWORK_AI_PROVIDER,
  AI360_API_KEY: process.env.AI360_API_KEY,
  YUNWU_API_KEY: process.env.YUNWU_API_KEY,
  YUNWU_BASE_URL: process.env.YUNWU_BASE_URL,
  NANOWORK_RESEARCH_MODEL: process.env.NANOWORK_RESEARCH_MODEL,
  NANOWORK_360_RESEARCH_MODEL: process.env.NANOWORK_360_RESEARCH_MODEL,
};

process.env.NANOWORK_DB = dbPath;
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.NANOWORK_AI_PROVIDER = '360';
process.env.AI360_API_KEY = 'platform-360-websearch-secret';
process.env.YUNWU_API_KEY = '';
process.env.YUNWU_BASE_URL = 'https://api.360.cn/v1';
delete process.env.NANOWORK_RESEARCH_MODEL;
delete process.env.NANOWORK_360_RESEARCH_MODEL;

const { initSchema, db } = await import('../src/db.js');
initSchema();
const {
  provider360ClaudeWebSearchReadiness,
  publicResearchSearchQuery,
  run360ClaudeWebSearch,
} = await import('../src/engines/provider-360-websearch.js');
const { runWithProviderContext } = await import('../src/engines/tester-provider-context.js');
const { agenticWebResearch } = await import('../src/engines/agentic-web-research.js');

function providerPayload({ id = 'search-request|one', count = 8 } = {}) {
  return {
    id,
    model: 'qiniu/claude-sonnet-4-6',
    choices: [{ message: { role: 'assistant', content: 'MODEL_TEXT_URL https://forged.example/not-a-source' } }],
    context: {
      web_search_records: Array.from({ length: count }, (_unused, index) => ({
        rank: String(index + 1),
        title: `360搜索上下文来源${index + 1}`,
        url: `https://source-${index + 1}.example/food-safety`,
        summary: `上游搜索记录摘要${index + 1}`,
        site_name: `source-${index + 1}.example`,
        date: '2026-09-07',
      })),
    },
    usage: {
      prompt_tokens: 321,
      completion_tokens: 45,
      prompt_cache_hit_tokens: 6,
      amount: '0.1234',
    },
  };
}

function providerResponse(payload = providerPayload(), status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': 'header-search-request',
    },
  });
}

test('360 Claude WebSearch只从provider context取候选，模型正文URL不能混入', async () => {
  const readiness = provider360ClaudeWebSearchReadiness();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.transport, '360_search_api');
  assert.equal(readiness.model, 'anthropic/claude-sonnet-4-6');

  let request = null;
  const result = await run360ClaudeWebSearch('市场监管总局 餐饮服务食品安全操作规范', {
    maxResults: 8,
    fetchFn: async (input, init) => {
      request = { input: String(input), init };
      return providerResponse();
    },
  });

  assert.equal(request.input, 'https://api.360.cn/v1/chat/completions');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.Authorization, 'Bearer platform-360-websearch-secret');
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, 'anthropic/claude-sonnet-4-6');
  assert.equal(body.max_tokens, 64);
  assert.deepEqual(body.tools, [{
    type: 'web_search',
    web_search: {
      search_mode: 'always',
      search_query: '市场监管总局 餐饮服务食品安全操作规范',
    },
  }]);
  assert.equal(result.ok, true);
  assert.equal(result.candidateReady, true);
  assert.equal(result.results.length, 0, '未受控抓取的搜索候选不得冒充已核验来源');
  assert.equal(result.fetchCandidates.length, 8);
  assert.equal(Object.keys(result).includes('fetchCandidates'), false);
  assert.ok(result.fetchCandidates.every(item => item.url.includes('.example/food-safety')));
  assert.equal(result.fetchCandidates.some(item => item.url.includes('forged.example')), false);
  assert.equal(result.evidence.toolCallEvidence, 'context.web_search_records');
  assert.equal(result.evidence.providerRecordCount, 8);
  assert.equal(result.evidence.candidateGate.sourcePath, 'context.web_search_records');
  assert.equal(result.evidence.usage.inputTokens, 321);
  assert.equal(result.evidence.usage.outputTokens, 45);
  assert.equal(result.evidence.supplierCosts.length, 1);
  assert.equal(result.evidence.supplierCosts[0].status, 'known');
  assert.equal(result.evidence.supplierCosts[0].costYuanOverride, 0.1234);
  assert.equal(result.evidence.costYuan, 0.1234);
  assert.deepEqual(result.fetchCandidates[0].sourceProvenance, {
    schemaVersion: 'nanowork.web-search-candidate/1',
    provider: '360',
    transport: '360_search_api',
    sourcePath: 'context.web_search_records',
    recordIndex: 0,
    url: 'https://source-1.example/food-safety',
    requestId: 'header-search-request',
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('platform-360-websearch-secret'), false);
  assert.equal(serialized.includes('forged.example'), false);
  assert.equal(serialized.includes('source-1.example'), false);
});

test('360 HTTP200的Sonnet 4.6路由别名保留30条候选及原始模型真实金额', async () => {
  for (const actualModel of [
    'softwareone/anthropic/claude-sonnet-4.6',
    'tokenmall-genesis/anthropic/claude-sonnet-4-6',
    'anthropic/claude-sonnet-4.6',
    'claude-sonnet-4.6',
  ]) {
    const payload = providerPayload({ id: `alias-search|${actualModel}`, count: 30 });
    payload.model = actualModel;
    payload.usage.amount = '0.660786';
    let sent = null;
    const result = await run360ClaudeWebSearch('杭州滨江星光大道餐饮门店', {
      fetchFn: async (_input, init) => {
        sent = JSON.parse(init.body);
        return providerResponse(payload);
      },
    });
    assert.equal(sent.model, 'anthropic/claude-sonnet-4-6');
    assert.equal(sent.max_tokens, 64);
    assert.equal(result.candidateReady, true);
    assert.equal(result.fetchCandidates.length, 30);
    assert.equal(result.evidence.providerRecordCount, 30);
    assert.equal(result.evidence.actualModel, actualModel);
    assert.equal(result.evidence.costStatus, 'known');
    assert.equal(result.evidence.costYuan, 0.660786);
    const receipt = result.evidence.supplierCosts[0];
    assert.equal(receipt.costYuanOverride, 0.660786);
    assert.equal(receipt.model, actualModel);
    assert.equal(receipt.costSource.actualModel, actualModel);
    assert.equal(receipt.costSource.reportedAmount, '0.660786');
    assert.equal(result.evidence.usage.inputTokens, payload.usage.prompt_tokens);
    assert.equal(result.evidence.usage.outputTokens, payload.usage.completion_tokens);
    assert.equal(result.results.length, 0, '缩短生成预算不改变候选与已核验正文的边界');
  }
});

test('360仅接受已确认Sonnet 4.6别名，其他版本家族或额外后缀仍拒绝', async () => {
  for (const actualModel of [
    'softwareone/anthropic/claude-sonnet-4.5',
    'softwareone/anthropic/claude-opus-4.6',
    'softwareone/anthropic/claude-sonnet-4.6-preview',
    'tokenmall-genesis/anthropic/claude-sonnet-4-60',
    'softwareone/anthropic/not-claude-sonnet-4.6',
    '',
  ]) {
    const payload = providerPayload({ count: 30 });
    payload.model = actualModel;
    await assert.rejects(run360ClaudeWebSearch('杭州餐饮门店', {
      fetchFn: async () => providerResponse(payload),
      costFn: async () => assert.fail('错误模型不可进入成功来源结算分支'),
    }), error => {
      assert.equal(error.status, 502);
      assert.equal(error.code, 'PROVIDER_360_SEARCH_UPSTREAM');
      return true;
    });
  }
});

test('测试员与销售邀请链路使用AsyncLocal个人360 Key，不偷用平台Key', async () => {
  let authorization = null;
  const context = {
    provider: '360',
    baseUrl: 'https://api.360.cn/v1',
    apiKey: 'personal-360-websearch-secret',
    ownerUserId: 901,
  };
  const result = await runWithProviderContext(context, () => run360ClaudeWebSearch('客户体验联网检索', {
    fetchFn: async (_input, init) => {
      authorization = init.headers.Authorization;
      return providerResponse(providerPayload({ id: 'personal-search|two', count: 6 }));
    },
  }));
  assert.equal(authorization, 'Bearer personal-360-websearch-secret');
  assert.equal(result.candidateReady, true);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('personal-360-websearch-secret'), false);
  assert.equal(serialized.includes('platform-360-websearch-secret'), false);
});

test('个人360 Key上下文跳过平台TinyFish，直接把联网费用归到个人360通道', async () => {
  let tinyfishCalls = 0;
  let claudeCalls = 0;
  const candidates = Array.from({ length: 6 }, (_unused, index) => ({
    title: `个人360来源${index + 1}`,
    url: `https://personal-source-${index + 1}.example/article`,
    snippet: '真实公开候选摘要',
  }));
  const claudeResult = {
    attempted: true,
    ok: true,
    candidateReady: true,
    provider: '360 Claude WebSearch API',
    results: [],
    evidence: { externalCall: true, credentialMode: 'personal' },
  };
  Object.defineProperty(claudeResult, 'fetchCandidates', { value: candidates, enumerable: false });
  const result = await runWithProviderContext({
    provider: '360',
    baseUrl: 'https://api.360.cn/v1',
    apiKey: 'salesperson-owned-search-key',
    ownerUserId: 902,
  }, () => agenticWebResearch('体验客户用销售自己的Key联网', {
    tinyfishEnabled: true,
    tinyfishSearchFn: async () => {
      tinyfishCalls += 1;
      return [];
    },
    claudeResearchFn: async () => {
      claudeCalls += 1;
      return claudeResult;
    },
  }));
  assert.equal(tinyfishCalls, 0);
  assert.equal(claudeCalls, 1);
  assert.equal(result.evidence.routePolicy, 'personal_provider_key_direct_360');
  assert.equal(result.evidence.platformTinyfishSkipped, true);
  assert.deepEqual(result.evidence.providerRoute, ['claude_websearch']);
  assert.equal(result.fetchCandidates.length, 6);
});

test('只有模型文字而没有context.web_search_records时失败关闭，但保留真实费用回执', async () => {
  const result = await run360ClaudeWebSearch('无候选结果', {
    fetchFn: async () => providerResponse(providerPayload({ id: 'empty-search|three', count: 0 })),
  });
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
  assert.equal(result.candidateReady, false);
  assert.deepEqual(result.fetchCandidates, []);
  assert.equal(result.evidence.toolCalls, 0);
  assert.equal(result.evidence.toolCallEvidence, 'none');
  assert.equal(result.evidence.supplierCosts[0].status, 'known');
  assert.match(result.note, /没有返回可打开的真实网页候选/u);
  assert.match(result.note, /360联网检索/u);
  assert.equal(result.evidence.failureCode, 'PROVIDER_360_SEARCH_NO_CANDIDATES');
});

test('员工长提示提取并去重真实取证查询，岗位指令不能占用搜索词预算', async () => {
  const prompt = [
    '数字员工：商圈分析员',
    `岗位职责：${'只承担经营分析及材料整理职责。'.repeat(50)}`,
    '老板的任务：杭州滨江星光大道商圈分析',
    '具体要求：评估餐饮店经营机会',
    '必须自行检索网上可取得的公开信息，不得反问老板。',
    '岗位技能取证查询1：杭州 滨江 星光大道 餐饮 门店',
    '岗位技能取证查询2：杭州 滨江 星光大道 餐饮 门店',
    '岗位技能取证查询3：杭州 滨江 星光大道 菜单 评价',
  ].join('\n');
  let sentQuery = null;
  await run360ClaudeWebSearch(prompt, {
    fetchFn: async (_input, init) => {
      sentQuery = JSON.parse(init.body).tools[0].web_search.search_query;
      return providerResponse();
    },
  });
  assert.equal(sentQuery, '杭州 滨江 星光大道 餐饮 门店 杭州 滨江 星光大道 菜单 评价');
  assert.equal(sentQuery.includes('岗位'), false);
  assert.equal(sentQuery.includes('必须'), false);
  assert.equal(publicResearchSearchQuery('岗位职责：餐饮经营分析\n老板的任务：杭州星光大道\n具体要求：菜单价格'), '杭州星光大道 菜单价格');
  assert.equal(publicResearchSearchQuery('优先查杭州滨江星光大道餐饮门店'), '优先查杭州滨江星光大道餐饮门店');
});

test('显式searchQuery优先，并在TinyFish和360回退之间保持同一查询', async () => {
  const prompt = '数字员工：商圈分析员\n老板的任务：其他旧任务';
  const explicit = '杭州星光大道 餐饮门店';
  let tinyfishQuery = null;
  let fallbackQuery = null;
  const result = await agenticWebResearch(prompt, {
    searchQuery: `${explicit}\n${explicit}`,
    tinyfishEnabled: true,
    tinyfishSearchFn: async query => {
      tinyfishQuery = query;
      return [];
    },
    claudeResearchFn: (query, options) => run360ClaudeWebSearch(query, {
      ...options,
      fetchFn: async (_input, init) => {
        fallbackQuery = JSON.parse(init.body).tools[0].web_search.search_query;
        return providerResponse();
      },
    }),
  });
  assert.equal(tinyfishQuery, explicit);
  assert.equal(fallbackQuery, explicit);
  assert.equal(result.candidateReady, true);
  assert.equal(result.fetchCandidates[0].sourceProvenance.sourcePath, 'context.web_search_records');
});

test('仅有岗位指令而无搜索任务时不请求360', async () => {
  let calls = 0;
  const result = await run360ClaudeWebSearch('数字员工：调研员\n岗位职责：分析公开信息\n必须取得真实来源', {
    fetchFn: async () => {
      calls += 1;
      throw new Error('must not call');
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.attempted, false);
  assert.match(result.note, /检索任务为空/u);
});

test('360候选来源标记绑定真实记录URL与索引，忽略上游伪造标记且不修改短摘要', async () => {
  const payload = providerPayload();
  payload.context.web_search_records.unshift({ title: '无效记录', url: 'not-a-url' });
  payload.context.web_search_records[1].summary = '';
  payload.context.web_search_records[1].sourceProvenance = {
    sourcePath: 'model.text', url: 'https://forged.example/', recordIndex: 999,
  };
  const result = await run360ClaudeWebSearch('杭州餐饮', {
    fetchFn: async () => providerResponse(payload),
  });
  const first = result.fetchCandidates[0];
  assert.equal(first.snippet, '');
  assert.equal(first.sourceProvenance.recordIndex, 1);
  assert.equal(first.sourceProvenance.url, first.url);
  assert.equal(first.sourceProvenance.sourcePath, 'context.web_search_records');
  assert.equal(Object.isFrozen(first.sourceProvenance), true);
  assert.equal(JSON.stringify(first).includes('forged.example'), false);
});

test('1到4条360候选仍交给受控抓取，只有零候选才算检索失败', async () => {
  const four = await run360ClaudeWebSearch('杭州餐饮', {
    fetchFn: async () => providerResponse(providerPayload({ count: 4 })),
  });
  assert.equal(four.candidateReady, true);
  assert.equal(four.fetchCandidates.length, 4);
  assert.equal(four.evidence.candidateGate.requiredCandidates, 1);
  assert.equal(four.evidence.failureCode, undefined);

  const zero = await run360ClaudeWebSearch('杭州餐饮', {
    fetchFn: async () => providerResponse(providerPayload({ count: 0 })),
  });
  assert.equal(zero.candidateReady, false);
  assert.deepEqual(zero.fetchCandidates, []);
  assert.equal(zero.evidence.failureCode, 'PROVIDER_360_SEARCH_NO_CANDIDATES');
  assert.match(zero.note, /没有返回可打开的真实网页候选/u);
});

test('360鉴权限流和TimeoutError在直接及回退通道保留脱敏诊断', async () => {
  const cases = [
    { reason: 'auth', status: 401, note: /鉴权/u },
    { reason: 'rate_limit', status: 429, note: /繁忙|额度/u },
    { reason: 'timeout', status: null, note: /超时/u },
  ];
  for (const item of cases) {
    for (const tinyfishEnabled of [false, true]) {
      const progress = [];
      const result = await agenticWebResearch('杭州餐饮门店', {
        tinyfishEnabled,
        tinyfishSearchFn: async () => [],
        onProgress: event => progress.push(event),
        claudeResearchFn: (query, options) => run360ClaudeWebSearch(query, {
          ...options,
          fetchFn: async () => {
            if (item.reason === 'timeout') throw new DOMException('secret-timeout-detail', 'TimeoutError');
            return providerResponse({ error: { message: 'secret-upstream-detail' } }, item.status);
          },
        }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.evidence.transport, '360_search_api');
      assert.equal(result.evidence.providerReason, item.reason);
      assert.equal(result.evidence.providerStatus, item.status);
      assert.equal(result.evidence.failureCode, `PROVIDER_360_SEARCH_${item.reason.toUpperCase()}`);
      assert.match(result.note, /360联网检索/u);
      assert.match(result.note, item.note);
      assert.equal(result.note.includes('Claude'), false);
      assert.equal(JSON.stringify(result).includes('secret-'), false);
      if (tinyfishEnabled) {
        assert.equal(result.evidence.claude.providerReason, item.reason);
        assert.equal(progress.find(event => event.kind === 'fallback').tool, '360联网检索');
      }
    }
  }
});

test('360非JSON鉴权错误仍保留真实HTTP状态', async () => {
  await assert.rejects(run360ClaudeWebSearch('杭州餐饮门店', {
    fetchFn: async () => new Response('<html>secret-provider-error</html>', { status: 401 }),
  }), error => {
    assert.equal(error.providerReason, 'auth');
    assert.equal(error.providerStatus, 401);
    assert.equal(error.code, 'PROVIDER_360_SEARCH_AUTH');
    assert.equal(error.transport, '360_search_api');
    assert.equal(error.message.includes('secret-provider-error'), false);
    return true;
  });
});

test('上游错误不回显provider message或Key', async () => {
  await assert.rejects(
    run360ClaudeWebSearch('错误脱敏', {
      fetchFn: async () => providerResponse({
        error: {
          code: 'upstream_internal',
          message: 'Authorization Bearer secret-should-never-leak',
        },
      }, 502),
    }),
    error => {
      assert.equal(error.status, 502);
      assert.match(error.message, /360联网检索服务/u);
      assert.equal(error.message.includes('secret-should-never-leak'), false);
      assert.equal(JSON.stringify(error).includes('secret-should-never-leak'), false);
      return true;
    },
  );
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(testRoot, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
