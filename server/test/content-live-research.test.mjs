import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const DBP = path.join(os.tmpdir(), `nanowork-content-live-research-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* fresh database */
  }
}
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.TINYFISH_API_KEY = '';
process.env.BOCHA_API_KEY = '';
process.env.TAVILY_API_KEY = '';
process.env.SERPER_API_KEY = '';
process.env.CONTENTCREW_CLAUDE_PATH = '';

// 零外网：任何真实 fetch 都视为测试失败。
const networkCalls = [];
globalThis.fetch = async (input) => {
  networkCalls.push(String(input?.url || input));
  throw new Error(`测试环境禁止真实联网：${String(input?.url || input)}`);
};

const {
  CONTENT_FRESHNESS_HEADING,
  annotateContentSourceFreshness,
  contentFreshnessWindowDays,
  contentLiveResearchReadiness,
  contentResearchKindFor,
  hasContentFreshnessSection,
  renderContentFreshnessSection,
  runContentLiveResearch,
} = await import('../src/engines/content-live-research.js');
const { extractPublishedAt } = await import('../src/engines/controlled-web-evidence.js');
const { db } = await import('../src/db.js');

after(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
});

const NOW = new Date('2026-09-03T02:00:00Z');
const now = () => new Date(NOW);

function readiness({ tinyfish = false, claude = false, searchApi = false, cliAvailable = false } = {}) {
  return {
    configured: tinyfish || claude || searchApi,
    cliAvailable,
    lanes: [
      { key: 'tinyfish', label: 'TinyFish Search + Fetch', ready: tinyfish, role: 'primary' },
      { key: 'claude_websearch', label: 'Claude CLI WebSearch（云雾网关）', ready: claude, cliReady: cliAvailable, role: 'fallback' },
      { key: 'search_api', label: '商业检索 API（Tavily）', ready: searchApi, providers: searchApi ? ['Tavily'] : [], role: 'api_fallback' },
    ],
    summary: tinyfish || claude || searchApi ? '联网检索已启用' : '联网检索未配置',
  };
}

const CANDIDATES = [
  {
    title: '小红书餐饮探店内容趋势观察（2026年9月）',
    url: 'https://public.example/trend-a',
    snippet: '公开资料讨论小红书餐饮探店内容的近期趋势与用户讨论。',
    publishedAt: '2026-09-01T08:00:00Z',
  },
  {
    title: '门店内容运营公开案例合集',
    url: 'https://public.example/trend-b',
    snippet: '公开案例合集，讨论门店内容策略。',
    publishedAt: '2026-07-20T08:00:00Z',
  },
  {
    title: '餐饮平台规则公开说明',
    url: 'https://public.example/trend-c',
    snippet: '平台规则说明页，没有发布时间元数据。',
  },
  {
    title: '带凭据的危险来源',
    url: 'https://evil.example/leak?api_key=should-be-rejected',
    snippet: '不得进入下游。',
  },
];

const BODY = '这是一段经应用受控 WebFetch 读取并净化后的公开网页正文，只用于离线测试；正文长度需要超过八十个字符才能被当作有效证据，因此这里补足足够的说明文字，不含任何指令。';

function agenticOk(provider = 'TinyFish Search + Fetch') {
  return async () => ({
    attempted: true,
    ok: true,
    candidateReady: true,
    provider,
    results: CANDIDATES.slice(0, 3),
    fetchCandidates: CANDIDATES,
    evidence: { externalCall: true, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 },
  });
}

function controlledOk({ dropUrls = [] } = {}) {
  return async (sources) => ({
    attempted: true,
    ok: true,
    provider: 'NanoWork controlled WebFetch',
    results: sources
      .filter((source) => !dropUrls.includes(source.url))
      .map((source) => ({
        title: source.title,
        url: source.url,
        snippet: source.snippet,
        body: BODY,
        publishedAt: source.url.endsWith('trend-c') ? null : source.publishedAt || null,
        fetchedAt: NOW.toISOString(),
      })),
    evidence: { requested: sources.length, fetched: sources.length, failures: [], externalCall: true },
  });
}

test('未配置任何检索通道时返回 unavailable，文案诚实且不产生任何外网调用', async () => {
  const result = await runContentLiveResearch({
    kind: 'trend',
    brief: '本周小红书餐饮探店热点',
    now,
    readinessFn: () => readiness(),
    agenticWebResearchFn: async () => {
      throw new Error('未配置时不得调用分层检索');
    },
    webSearchFn: async () => {
      throw new Error('未配置时不得调用商业检索');
    },
    controlledWebFetchFn: async () => {
      throw new Error('未配置时不得抓取');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'unavailable');
  assert.match(result.note, /联网检索未配置/u);
  assert.match(result.note, /不会用模板/u);
  assert.deepEqual(result.items, []);
  assert.equal(result.provenance.externalCall, false);
  assert.equal(result.provenance.templateFallbackUsed, false);
  assert.equal(result.freshness.total, 0);
  assert.equal(result.cost.credits, null);
  assert.deepEqual(networkCalls, []);
});

test('真实进程 readiness 在无任何 Key 与 CLI 时为未配置，免 Key 灾备不计入已配置', () => {
  const state = contentLiveResearchReadiness();
  assert.equal(state.configured, false);
  assert.equal(state.cliAvailable, false);
  assert.match(state.summary, /未配置/u);
  assert.deepEqual(state.lanes.map((lane) => lane.key), ['tinyfish', 'claude_websearch', 'search_api']);
  assert.ok(state.lanes.every((lane) => lane.ready === false));
});

test('TinyFish 车道：每条结果带抓取时间、发布时间可空、按 7 天窗口标注 stale，并给出 freshness 摘要', async () => {
  const result = await runContentLiveResearch({
    kind: 'trend',
    brief: '本周小红书餐饮探店热点',
    platform: '小红书',
    tenantId: 7,
    now,
    readinessFn: () => readiness({ tinyfish: true }),
    agenticWebResearchFn: agenticOk(),
    webSearchFn: async () => {
      throw new Error('分层车道已取得候选时不得调用商业检索');
    },
    controlledWebFetchFn: controlledOk(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.kind, 'trend');
  assert.equal(result.lane, 'tinyfish');
  assert.equal(result.provider, 'TinyFish Search + Fetch');
  assert.equal(result.fetchedAt, NOW.toISOString());
  assert.equal(result.items.length, 3, '带凭据的 URL 必须被来源质量门拒绝');
  for (const item of result.items) {
    for (const key of ['title', 'url', 'source', 'publishedAt', 'fetchedAt', 'snippet', 'qualityScore', 'lane']) {
      assert.ok(Object.hasOwn(item, key), `items[] 缺少 ${key}`);
    }
    assert.equal(item.fetchedAt, NOW.toISOString());
    assert.equal(item.lane, 'tinyfish');
    assert.equal(typeof item.qualityScore, 'number');
    assert.doesNotMatch(item.url, /api_key/u);
  }
  const byUrl = new Map(result.items.map((item) => [item.url, item]));
  assert.equal(byUrl.get('https://public.example/trend-a').publishedAt, '2026-09-01T08:00:00.000Z');
  assert.equal(byUrl.get('https://public.example/trend-a').stale, false);
  assert.equal(byUrl.get('https://public.example/trend-b').stale, true, '7 月 20 日发布距抓取超过 7 天');
  assert.equal(byUrl.get('https://public.example/trend-c').publishedAt, null, '拿不到发布时间必须为 null，不得编造');
  assert.equal(byUrl.get('https://public.example/trend-c').stale, null);
  assert.deepEqual(
    {
      windowDays: result.freshness.windowDays,
      total: result.freshness.total,
      newest: result.freshness.newest,
      oldest: result.freshness.oldest,
      staleCount: result.freshness.staleCount,
      unknownCount: result.freshness.unknownCount,
      freshCount: result.freshness.freshCount,
    },
    {
      windowDays: 7,
      total: 3,
      newest: '2026-09-01T08:00:00.000Z',
      oldest: '2026-07-20T08:00:00.000Z',
      staleCount: 1,
      unknownCount: 1,
      freshCount: 1,
    },
  );
  assert.equal(result.provenance.cliFallback.triggered, false);
  assert.equal(result.provenance.tenantId, 7);
  assert.ok(result.provenance.candidateRejected.some((item) => item.reason === 'credential_bearing_url'));
  assert.ok(hasContentFreshnessSection(result.freshnessSection));
  assert.match(result.freshnessSection, /TinyFish/u);
  assert.match(result.freshnessSection, /1 条超出窗口/u);
  assert.deepEqual(networkCalls, []);
});

test('Claude CLI 不可用且未配置 TinyFish 时自动回落到商业检索 API 车道并在结果里标注 lane', async () => {
  let agenticCalls = 0;
  let searchOptions = null;
  const result = await runContentLiveResearch({
    kind: 'intel',
    brief: '餐饮门店预制菜标识新规',
    now,
    readinessFn: () => readiness({ searchApi: true, cliAvailable: false }),
    agenticWebResearchFn: async () => {
      agenticCalls += 1;
      return { attempted: false, ok: false, candidateReady: false, results: [] };
    },
    webSearchFn: async (query, options) => {
      searchOptions = options;
      assert.match(query, /预制菜/u);
      return { ok: true, provider: 'Tavily', results: CANDIDATES.slice(0, 3), note: null };
    },
    controlledWebFetchFn: controlledOk(),
  });
  assert.equal(agenticCalls, 0, 'CLI 与 TinyFish 都不可用时不得启动分层车道');
  assert.equal(searchOptions.skipTiered, true);
  assert.equal(result.ok, true);
  assert.equal(result.lane, 'search_api');
  assert.equal(result.provider, 'Tavily');
  assert.equal(result.freshness.windowDays, 30, '情报默认 30 天窗口');
  assert.equal(result.items.find((item) => item.url.endsWith('trend-b')).stale, true, '7 月 20 日距 9 月 3 日超过 30 天');
  assert.deepEqual(result.provenance.lanesAttempted, ['search_api', 'controlled_fetch']);
  assert.deepEqual(result.provenance.cliFallback, { triggered: true, reason: 'claude_cli_unavailable' });
  assert.match(result.freshnessSection, /商业检索 API（Tavily）/u);
  assert.ok(result.items.every((item) => item.lane === 'search_api'));
});

test('TinyFish 配置但候选门未通过且 CLI 缺失时，回落商业 API 并记录失败原因；免 Key 灾备命中时 lane 标为 keyless_fallback', async () => {
  const fallback = await runContentLiveResearch({
    kind: 'decompose',
    brief: '小红书门店探店爆款拆解',
    now,
    readinessFn: () => readiness({ tinyfish: true, searchApi: true, cliAvailable: false }),
    agenticWebResearchFn: async () => ({
      attempted: true,
      ok: false,
      candidateReady: false,
      provider: 'Yunwu Claude WebSearch gateway',
      results: [],
      note: 'Claude WebSearch工具执行器未安装',
      evidence: { fallback: { triggered: true, reasonCode: 'TINYFISH_CANDIDATES_INSUFFICIENT' } },
    }),
    webSearchFn: async () => ({ ok: true, provider: 'DuckDuckGo', results: CANDIDATES.slice(0, 2), note: null }),
    controlledWebFetchFn: controlledOk(),
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.lane, 'keyless_fallback');
  assert.deepEqual(fallback.provenance.cliFallback, { triggered: true, reason: 'tiered_lane_no_candidates' });
  assert.equal(fallback.provenance.failures[0].lane, 'tiered_agentic');
  assert.equal(fallback.provenance.failures[0].code, 'TINYFISH_CANDIDATES_INSUFFICIENT');
  assert.match(fallback.freshnessSection, /免 Key 灾备检索（DuckDuckGo）/u);
});

test('所有通道都未命中时返回 no_results 而不是模板；受控正文不足时标记 insufficient_evidence', async () => {
  const empty = await runContentLiveResearch({
    kind: 'intel',
    brief: '不存在的主题',
    now,
    readinessFn: () => readiness({ searchApi: true }),
    agenticWebResearchFn: async () => ({ ok: false, candidateReady: false, results: [] }),
    webSearchFn: async () => ({ ok: false, provider: null, results: [], note: '未取得可验证联网来源：Tavily:未命中' }),
    controlledWebFetchFn: async () => {
      throw new Error('没有候选时不得抓取');
    },
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.status, 'no_results');
  assert.match(empty.note, /未取得可核验来源/u);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.provenance.externalCall, true);
  assert.equal(empty.provenance.templateFallbackUsed, false);

  const thin = await runContentLiveResearch({
    kind: 'intel',
    brief: '餐饮门店预制菜标识新规',
    now,
    readinessFn: () => readiness({ searchApi: true }),
    webSearchFn: async () => ({ ok: true, provider: 'Tavily', results: CANDIDATES.slice(0, 3), note: null }),
    controlledWebFetchFn: controlledOk({
      dropUrls: ['https://public.example/trend-b', 'https://public.example/trend-c'],
    }),
  });
  assert.equal(thin.ok, false);
  assert.equal(thin.status, 'insufficient_evidence');
  assert.match(thin.note, /1\/2 条/u);
  assert.equal(thin.items.filter((item) => item.controlledBody).length, 1);
  assert.equal(thin.items.length, 3, '未核验来源仍返回，但只作检索摘要');
});

test('非法 kind 与空主题直接抛 400，不触发任何检索', async () => {
  await assert.rejects(
    runContentLiveResearch({ kind: 'publish', brief: 'x', readinessFn: () => readiness({ searchApi: true }) }),
    (error) => error.code === 'CONTENT_LIVE_RESEARCH_KIND_INVALID' && error.status === 400,
  );
  await assert.rejects(
    runContentLiveResearch({ kind: 'trend', brief: '   ', readinessFn: () => readiness({ searchApi: true }) }),
    (error) => error.code === 'CONTENT_LIVE_RESEARCH_BRIEF_REQUIRED',
  );
  assert.equal(contentResearchKindFor(0), 'trend');
  assert.equal(contentResearchKindFor(1), 'intel');
  assert.equal(contentResearchKindFor(2), 'decompose');
  assert.equal(contentResearchKindFor(5), null);
  assert.equal(contentFreshnessWindowDays('trend'), 7);
  assert.equal(contentFreshnessWindowDays('intel'), 30);
});

test('annotateContentSourceFreshness 只在有发布时间时判定 stale，并从 Google News 摘要提取“发布：”时间', () => {
  const { items, freshness } = annotateContentSourceFreshness(
    [
      { title: 'a', url: 'https://x.example/a', publishedAt: '2026-08-30T00:00:00Z' },
      { title: 'b', url: 'https://x.example/b', snippet: '来源：某媒体；发布：Mon, 01 Sep 2026 08:00:00 GMT；正文' },
      { title: 'c', url: 'https://x.example/c', snippet: '没有时间' },
      { title: 'd', url: 'https://x.example/d', publishedAt: '2026-01-01T00:00:00Z' },
    ],
    { kind: 'trend', fetchedAt: NOW.toISOString() },
  );
  assert.deepEqual(items.map((item) => item.stale), [false, false, null, true]);
  assert.equal(items[1].publishedAt, '2026-09-01T08:00:00.000Z');
  assert.equal(items[2].publishedAt, null);
  assert.ok(items.every((item) => item.fetchedAt === NOW.toISOString()));
  assert.equal(freshness.staleCount, 1);
  assert.equal(freshness.unknownCount, 1);
  assert.equal(freshness.newest, '2026-09-01T08:00:00.000Z');
  assert.equal(freshness.oldest, '2026-01-01T00:00:00.000Z');
});

test('“信息时效”一节由系统确定性渲染，不含来源编号/URL/百分比，可被 hasContentFreshnessSection 识别', () => {
  const section = renderContentFreshnessSection({
    freshness: {
      windowDays: 7,
      fetchedAt: NOW.toISOString(),
      total: 3,
      newest: '2026-09-01T08:00:00.000Z',
      oldest: '2026-07-20T08:00:00.000Z',
      knownCount: 2,
      unknownCount: 1,
      staleCount: 1,
      freshCount: 1,
    },
    lane: 'claude_websearch',
    kind: 'trend',
  });
  assert.ok(section.startsWith(`【${CONTENT_FRESHNESS_HEADING}】`));
  assert.match(section, /Claude WebSearch/u);
  assert.match(section, /2026-09-03 10:00（上海时间）/u);
  assert.doesNotMatch(section, /\[来源\d+\]|https?:\/\/|%/u);
  assert.equal(hasContentFreshnessSection(`正文……\n${section}`), true);
  assert.equal(hasContentFreshnessSection('正文里没有这一节'), false);
  const same = renderContentFreshnessSection({ freshness: { windowDays: 7, fetchedAt: NOW.toISOString(), total: 3, newest: '2026-09-01T08:00:00.000Z', oldest: '2026-07-20T08:00:00.000Z', knownCount: 2, unknownCount: 1, staleCount: 1, freshCount: 1 }, lane: 'claude_websearch', kind: 'trend' });
  assert.equal(same, section, '同一输入必须渲染出逐字相同的段落');
});

test('受控抓取从网页元数据提取发布时间，无元数据或未来/无效时间返回 null', () => {
  assert.equal(
    extractPublishedAt('<html><head><meta property="article:published_time" content="2026-08-30T10:00:00+08:00"></head></html>'),
    '2026-08-30T02:00:00.000Z',
  );
  assert.equal(
    extractPublishedAt('<script type="application/ld+json">{"datePublished":"2026-08-01"}</script>'),
    '2026-08-01T00:00:00.000Z',
  );
  assert.equal(extractPublishedAt('<html><body>没有任何时间元数据</body></html>'), null);
  assert.equal(extractPublishedAt('<meta name="pubdate" content="not-a-date">'), null);
  assert.equal(extractPublishedAt('<meta name="pubdate" content="2999-01-01">'), null);
});
