import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { VALID_CONTENT_EMPLOYEE_OUTPUTS } from './helpers/content-output-fixtures.mjs';

const DBP = path.join(os.tmpdir(), `nanowork-content-connectors-live-${process.pid}.db`);
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
process.env.SEED_DEMO = 'false';

globalThis.fetch = async (input) => {
  throw new Error(`测试环境禁止真实联网：${String(input?.url || input)}`);
};

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const {
  CONTENT_CONNECTOR_REGISTRY,
  CONTENT_LIVE_RESEARCH_CONNECTORS,
  connectorDescriptor,
  executeContentConnector,
  executeContentConnectorLive,
} = await import('../src/engines/content-connectors.js');
const { CONTENT_CREW_CATALOG_PATH } = await import('../src/catalog/content-crew.js');
const { createContentProductionHandlerRegistry } = await import('../src/engines/content-production-handler-registry.js');
const { CANONICAL_EMPLOYEE_PROFILE_FIELDS, canonicalContentEmployeeProfileFor } = await import('../src/engines/canonical-employee-profile.js');
const {
  CONTENT_FRESHNESS_SECTION_MISSING_WARNING,
  liveResearchAnnotation,
  validateContentEmployeeOutputContract,
} = await import('../src/engines/content-output-contract.js');
const { compileContentEmployeeSoloPrompt } = await import('../src/engines/content-employee-workbench.js');
const { renderContentFreshnessSection } = await import('../src/engines/content-live-research.js');
const { findHoldByRef } = await import('../src/engines/credits.js');

initSchema();
migrateV2();
// credit_holds 由 credits.js 懒建表；先触发一次，方便测试直接查表。
findHoldByRef('content_connector_live_research', 0);
q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'连接器联网A店','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET credits=excluded.credits,status=excluded.status`);
const bossId = Number(
  q.run(`INSERT INTO users(username,password_hash,name,role,dept,status,tenant_id)
    VALUES('connector-live-boss','x','A店老板','boss','老板办','启用',1)`).lastInsertRowid,
);

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
const ISO = NOW.toISOString();

function balance() {
  return Number(q.get('SELECT credits FROM tenants WHERE id=1').credits);
}

function liveHolds() {
  return q.all(`SELECT h.*,l.credits AS log_credits,l.ai_mode,l.input_tokens,l.output_tokens
    FROM credit_holds h JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
    WHERE h.tenant_id=1 AND h.ref_type='content_connector_live_research' ORDER BY h.id`);
}

function configured() {
  return {
    configured: true,
    cliAvailable: false,
    summary: '联网检索已启用：TinyFish Search + Fetch',
    lanes: [
      { key: 'tinyfish', label: 'TinyFish Search + Fetch', ready: true },
      { key: 'claude_websearch', label: 'Claude CLI WebSearch（云雾网关）', ready: false },
      { key: 'search_api', label: '商业检索 API', ready: false },
    ],
  };
}

function unconfigured() {
  return { configured: false, cliAvailable: false, summary: '联网检索未配置', lanes: [] };
}

function researchResult({ lane = 'tinyfish', status = 'completed', usage = { inputTokens: 0, outputTokens: 0 } } = {}) {
  const items = [
    {
      title: '小红书餐饮探店内容趋势观察',
      url: 'https://public.example/trend-a',
      source: 'public.example',
      snippet: '公开资料讨论小红书餐饮探店内容的近期趋势。',
      body: 'x'.repeat(120),
      bodySha256: 'a'.repeat(64),
      controlledBody: true,
      publishedAt: '2026-09-01T08:00:00.000Z',
      fetchedAt: ISO,
      stale: false,
      qualityScore: 80,
      lane,
    },
    {
      title: '门店内容运营公开案例合集',
      url: 'https://public.example/trend-b',
      source: 'public.example',
      snippet: '公开案例合集。',
      body: null,
      bodySha256: null,
      controlledBody: false,
      publishedAt: null,
      fetchedAt: ISO,
      stale: null,
      qualityScore: 10,
      lane,
    },
  ];
  const freshness = {
    windowDays: 7,
    fetchedAt: ISO,
    total: 2,
    newest: '2026-09-01T08:00:00.000Z',
    oldest: '2026-09-01T08:00:00.000Z',
    knownCount: 1,
    unknownCount: 1,
    staleCount: 0,
    freshCount: 1,
  };
  return {
    schemaVersion: 'nanowork.content-live-research/1',
    ok: status === 'completed',
    status,
    kind: 'trend',
    lane: status === 'no_results' ? null : lane,
    provider: lane === 'tinyfish' ? 'TinyFish Search + Fetch' : lane === 'claude_websearch' ? 'Yunwu Claude WebSearch gateway' : 'Tavily',
    items: status === 'no_results' ? [] : items,
    fetchedAt: ISO,
    freshness,
    freshnessSection: renderContentFreshnessSection({ freshness, lane, kind: 'trend' }),
    note: status === 'no_results' ? '联网检索已执行但未取得可核验来源' : null,
    provenance: { externalCall: true, templateFallbackUsed: false, lanesAttempted: ['tiered_agentic', 'controlled_fetch'], failures: [] },
    cost: { lane, usage, costUsd: 0, credits: null },
  };
}

test('catalog 指纹与 status 不变，只在运行期给三类研究连接器注入 networkAccess:true', () => {
  const raw = JSON.parse(fs.readFileSync(CONTENT_CREW_CATALOG_PATH, 'utf8'));
  const rawByKind = new Map(raw.employees.flatMap(employee => employee.connectorPolicy.connectors.map(item => [item.kind, item])));
  assert.deepEqual(Object.keys(CONTENT_LIVE_RESEARCH_CONNECTORS), ['trend_research', 'evidence_research', 'benchmark_analysis']);
  for (const descriptor of CONTENT_CONNECTOR_REGISTRY) {
    const live = Object.hasOwn(CONTENT_LIVE_RESEARCH_CONNECTORS, descriptor.kind);
    assert.equal(descriptor.networkAccess, live, descriptor.kind);
    assert.equal(descriptor.liveResearch.supported, live, descriptor.kind);
    if (rawByKind.has(descriptor.kind)) {
      assert.equal(descriptor.status, rawByKind.get(descriptor.kind).status, `${descriptor.kind} 的 catalog status 不得被运行期改写`);
      assert.equal(rawByKind.get(descriptor.kind).networkAccess, undefined, 'catalog JSON 不得新增 networkAccess 字段');
    }
  }
  assert.equal(connectorDescriptor('trend_research').status, 'requires_live_data');
  assert.equal(connectorDescriptor('trend_research').liveResearch.freshnessWindowDays, 7);
  assert.equal(connectorDescriptor('evidence_research').liveResearch.freshnessWindowDays, 30);
  assert.equal(connectorDescriptor('publish_package').networkAccess, false);
  assert.equal(connectorDescriptor('performance_retro').networkAccess, false);
});

test('未配置任何检索通道：返回 unavailable、文案诚实、不占扣、不产出模板', async () => {
  const before = balance();
  const result = await executeContentConnectorLive(
    'trend_research',
    { task: '本周小红书餐饮热点' },
    {},
    { userId: bossId, tenantId: 1 },
    { readinessFn: unconfigured, runLiveResearch: async () => { throw new Error('未配置时不得检索'); } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'CONTENT_CONNECTOR_LIVE_RESEARCH_UNAVAILABLE');
  assert.match(result.action, /联网检索未配置/u);
  assert.equal(result.output, undefined, '不得用模板冒充产物');
  assert.equal(result.networkAccess, false);
  assert.equal(result.costIncurred, false);
  assert.equal(result.liveResearch.configured, false);
  assert.equal(liveHolds().length, 0);
  assert.equal(balance(), before);
});

test('TinyFish 车道：先 hold 再检索，零 token 车道按固定费用 0 结算、余额复原，产物带 sources/freshness 与时效标注', async () => {
  const before = balance();
  const holdEvents = [];
  const result = await runWithTenant(1, () => executeContentConnectorLive(
    'trend_research',
    { task: '本周小红书餐饮热点', channels: ['小红书', '抖音'] },
    {},
    { userId: bossId, tenantId: 1 },
    {
      readinessFn: configured,
      runLiveResearch: async (params) => {
        holdEvents.push({ phase: 'research', holds: liveHolds().map(item => item.status) });
        assert.equal(params.kind, 'trend');
        assert.equal(params.tenantId, 1);
        assert.match(params.brief, /小红书餐饮热点/u);
        return researchResult({ lane: 'tinyfish' });
      },
    },
  ));
  assert.deepEqual(holdEvents, [{ phase: 'research', holds: ['held'] }], '检索必须发生在预授权之后（D-014）');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'live_research_completed');
  assert.equal(result.completedScope, 'live_web_research_with_controlled_fetch');
  assert.equal(result.networkAccess, true);
  assert.deepEqual(result.externalActionsPerformed, ['web_search', 'controlled_web_fetch']);
  assert.equal(result.credentialsAccepted, false);
  assert.equal(result.costIncurred, false);
  assert.equal(result.output.sources.length, 2);
  assert.equal(result.output.sources[0].fetchedAt, ISO);
  assert.equal(result.output.sources[0].publishedAt, '2026-09-01T08:00:00.000Z');
  assert.equal(result.output.sources[0].stale, false);
  assert.equal(result.output.sources[0].verification, 'controlled_web_fetch_verified');
  assert.equal(result.output.sources[1].publishedAt, null);
  assert.equal(result.output.sources[1].stale, null);
  assert.equal(result.output.sources[1].verification, 'search_snippet_only');
  assert.equal(result.output.freshness.windowDays, 7);
  assert.match(result.output.freshnessSection, /信息时效/u);
  assert.equal(result.output.candidateTopics.length, 1, '只有受控正文核验过的来源才进入候选选题');
  assert.equal(result.output.candidateTopics[0].heat, 'not_assessed');
  assert.deepEqual(result.output.requestedChannels, ['小红书', '抖音']);
  assert.equal(result.liveResearch.lane, 'tinyfish');
  assert.equal(result.liveResearch.billing.holdReused, false);
  assert.ok(result.liveResearch.billing.heldCredits > 0);
  assert.equal(result.liveResearch.billing.settledCredits, 0);
  const holds = liveHolds();
  assert.equal(holds.length, 1);
  assert.equal(holds[0].status, 'settled');
  assert.equal(holds[0].settled_credits, 0);
  assert.equal(holds[0].log_credits, 0);
  assert.equal(balance(), before);
});

test('Claude WebSearch 车道按真实 token 结算，实扣不超过预授权且余额按实扣减少', async () => {
  const before = balance();
  const result = await runWithTenant(1, () => executeContentConnectorLive(
    'evidence_research',
    { task: '餐饮门店预制菜标识新规' },
    {},
    { userId: bossId, tenantId: 1 },
    {
      readinessFn: configured,
      runLiveResearch: async () => ({
        ...researchResult({ lane: 'claude_websearch', usage: { inputTokens: 900, outputTokens: 300 } }),
        kind: 'intel',
      }),
    },
  ));
  assert.equal(result.ok, true);
  assert.equal(result.costIncurred, true);
  assert.equal(result.output.evidenceLedger.length, 2);
  assert.equal(result.output.evidenceLedger[0].verification, 'controlled_web_fetch_verified');
  assert.equal(result.output.evidenceLedger[0].publishedAt, '2026-09-01T08:00:00.000Z');
  const hold = liveHolds().at(-1);
  assert.equal(hold.status, 'settled');
  assert.ok(hold.settled_credits > 0);
  assert.ok(hold.settled_credits <= hold.held_credits, '实扣不得超过预授权');
  assert.equal(hold.input_tokens, 900);
  assert.equal(hold.output_tokens, 300);
  assert.equal(hold.ai_mode, 'api');
  assert.equal(balance(), before - hold.settled_credits);
  assert.equal(result.liveResearch.billing.settledCredits, hold.settled_credits);
});

test('检索未取得来源时全额释放预授权并返回 no_results；检索抛错同样释放', async () => {
  const before = balance();
  const empty = await runWithTenant(1, () => executeContentConnectorLive(
    'trend_research',
    { task: '不存在的主题' },
    {},
    { userId: bossId, tenantId: 1 },
    { readinessFn: configured, runLiveResearch: async () => researchResult({ status: 'no_results' }) },
  ));
  assert.equal(empty.ok, false);
  assert.equal(empty.status, 'no_results');
  assert.equal(empty.code, 'CONTENT_CONNECTOR_LIVE_RESEARCH_NO_RESULTS');
  assert.equal(empty.output, undefined);
  assert.equal(empty.networkAccess, true, '确实联网过，但没有来源');
  let hold = liveHolds().at(-1);
  assert.equal(hold.status, 'settled');
  assert.equal(hold.settled_credits, 0);
  assert.equal(balance(), before);

  await assert.rejects(
    runWithTenant(1, () => executeContentConnectorLive(
      'trend_research',
      { task: '会抛错的主题' },
      {},
      { userId: bossId, tenantId: 1 },
      {
        readinessFn: configured,
        runLiveResearch: async () => {
          throw Object.assign(new Error('分层联网检索超过本次总预算'), { code: 'AGENTIC_RESEARCH_TIMEOUT' });
        },
      },
    )),
    /总预算/u,
  );
  hold = liveHolds().at(-1);
  assert.equal(hold.status, 'settled');
  assert.equal(hold.settled_credits, 0);
  assert.equal(balance(), before);
});

test('调用方提供 liveData/samples 时沿用零联网本地整理；分发官/复盘官永不联网；已有 hold 时不重复占扣', async () => {
  const liveData = [{
    title: '调用方观察',
    source: '企业研究资料',
    observedAt: '2026-09-01T09:00:00+08:00',
    excerpt: '调用方自带来源，只做整理。',
  }];
  const holdsBefore = liveHolds().length;
  const supplied = await executeContentConnectorLive(
    'trend_research',
    { task: '整理', liveData },
    {},
    { userId: bossId, tenantId: 1 },
    { readinessFn: configured, runLiveResearch: async () => { throw new Error('有 liveData 时不得联网'); } },
  );
  assert.equal(supplied.ok, true);
  assert.equal(supplied.networkAccess, false);
  assert.equal(supplied.completedScope, 'caller_supplied_signal_organization');
  assert.equal(liveHolds().length, holdsBefore);

  const pack = await executeContentConnectorLive(
    'publish_package',
    { content: '待发布正文', platforms: ['小红书'] },
    {},
    { userId: bossId, tenantId: 1 },
    { readinessFn: configured, runLiveResearch: async () => { throw new Error('分发官不得联网'); } },
  );
  assert.equal(pack.networkAccess, false);
  assert.equal(pack.output.actualPublish, false);
  assert.deepEqual(pack, executeContentConnector('publish_package', { content: '待发布正文', platforms: ['小红书'] }));

  const retro = await executeContentConnectorLive('performance_retro', { contentId: 'c-1' }, {}, {}, { readinessFn: configured });
  assert.equal(retro.networkAccess, false);
  assert.equal(retro.completedScope, 'metrics_collection_plan_only');

  const reused = await runWithTenant(1, () => executeContentConnectorLive(
    'benchmark_analysis',
    { task: '拆解小红书探店爆款', platform: '小红书' },
    {},
    { userId: bossId, tenantId: 1, hold: { holdId: 999_999, credits: 42 } },
    { readinessFn: configured, runLiveResearch: async () => ({ ...researchResult(), kind: 'decompose' }) },
  ));
  assert.equal(reused.ok, true);
  assert.equal(reused.liveResearch.billing.holdReused, true);
  assert.equal(reused.liveResearch.billing.settledCredits, null);
  assert.equal(reused.output.samples.length, 1);
  assert.equal(reused.output.samples[0].metricsStatus, 'not_available_from_public_page');
  assert.equal(liveHolds().length, holdsBefore, '复用调用方 hold 时不新增占扣');
});

test('输出契约运行期附加 sources/freshness；正文缺“信息时效”一节只记 warning，不改写正文', () => {
  const freshness = { windowDays: 7, fetchedAt: ISO, total: 1, newest: '2026-09-01T08:00:00.000Z', oldest: '2026-09-01T08:00:00.000Z', knownCount: 1, unknownCount: 0, staleCount: 0, freshCount: 1 };
  const section = renderContentFreshnessSection({ freshness, lane: 'tinyfish', kind: 'trend' });
  const web = {
    verified: true,
    results: [{
      sourceId: '来源1',
      title: '行业协会公开资料',
      url: 'https://public.example/report',
      snippet: VALID_CONTENT_EMPLOYEE_OUTPUTS[0].briefing,
      fetchedAt: ISO,
      publishedAt: '2026-09-01T08:00:00.000Z',
      stale: false,
    }],
    freshness,
    freshnessSection: section,
  };
  const base = structuredClone(VALID_CONTENT_EMPLOYEE_OUTPUTS[0]);
  base.briefing = `${base.briefing} [来源1]`;
  base.channel_scan = base.channel_scan.map(item => ({ ...item, finding: `${item.finding} [来源1]` }));
  base.topics = base.topics.map(item => ({ ...item, evidence: `${item.evidence} [来源1]` }));

  const missing = validateContentEmployeeOutputContract(0, JSON.stringify(base), { web });
  assert.equal(missing.valid, true, missing.errors.join('；'));
  assert.equal(missing.liveResearch.freshnessSectionRequired, true);
  assert.equal(missing.liveResearch.freshnessSectionPresent, false);
  assert.deepEqual(missing.liveResearch.warnings, [CONTENT_FRESHNESS_SECTION_MISSING_WARNING]);
  assert.deepEqual(missing.liveResearch.sources, [{
    sourceId: '来源1',
    title: '行业协会公开资料',
    url: 'https://public.example/report',
    fetchedAt: ISO,
    publishedAt: '2026-09-01T08:00:00.000Z',
    stale: false,
  }]);
  assert.deepEqual(missing.liveResearch.freshness, freshness);
  assert.equal(missing.liveResearch.freshnessSection, section);
  assert.equal(missing.parsed.briefing, base.briefing, '系统不得改写正文');
  assert.equal(Object.hasOwn(missing.parsed, 'sources'), false, '运行期字段不进入 parsed JSON');

  const withSection = structuredClone(base);
  withSection.briefing = `${base.briefing}\n${section}`;
  const present = validateContentEmployeeOutputContract(0, JSON.stringify(withSection), { web });
  assert.equal(present.valid, true, present.errors.join('；'));
  assert.equal(present.liveResearch.freshnessSectionPresent, true);
  assert.deepEqual(present.liveResearch.warnings, []);

  assert.equal(liveResearchAnnotation(3, {}, { web }), null, '撰稿人不附加联网时效字段');
  assert.equal(liveResearchAnnotation(0, base, {}), null, '没有联网上下文时不附加');
});

test('系统提示词注入联网检索真实状态与时效引用规则；未注入时不得自称已联网', () => {
  const enabled = compileContentEmployeeSoloPrompt(0, { direction: '本周热点', industry: '餐饮', material: '无', feedback: '无', length: 'std' }, {
    liveResearch: configured(),
  });
  assert.match(enabled.systemPrompt, /联网检索已启用：联网检索已启用：TinyFish Search \+ Fetch（可用通道：TinyFish Search \+ Fetch）/u);
  assert.match(enabled.systemPrompt, /引用信息必须标注来源与抓取时间/u);
  assert.match(enabled.systemPrompt, /过期信息要标注/u);
  assert.match(enabled.systemPrompt, /「信息时效」一节，必须原样附在主叙述字段/u);
  assert.equal(enabled.snapshot.handlerExecution.liveResearch.configured, true);

  const disabled = compileContentEmployeeSoloPrompt(1, { direction: '核验', industry: '餐饮', material: '无', feedback: '无', length: 'std' }, {
    liveResearch: unconfigured(),
  });
  assert.match(disabled.systemPrompt, /联网检索未启用：联网检索未配置/u);
  assert.match(disabled.systemPrompt, /不得声称已联网、已抓榜或已核验最新信息/u);
  assert.equal(disabled.snapshot.handlerExecution.liveResearch.configured, false);

  const unknown = compileContentEmployeeSoloPrompt(3, { direction: '写稿', industry: '餐饮', material: '无', feedback: '无', length: 'std' });
  assert.match(unknown.systemPrompt, /联网检索状态未由运行层注入：不得自称已联网/u);
  assert.doesNotMatch(unknown.systemPrompt, /「信息时效」一节，必须原样附在主叙述字段/u);
  assert.equal(unknown.snapshot.handlerExecution.liveResearch.configured, null);
});

function pipelineContext(stationIdx) {
  const profile = structuredClone(canonicalContentEmployeeProfileFor(stationIdx));
  return {
    executionMode: 'pipeline',
    today: '2026-09-03',
    brief: { direction: '为餐饮老板生产可核验经营内容', industry: '餐饮连锁', material: '未提供数据不得编造。', platforms: ['小红书'], image_mode: 'ai', image_count: 1, enable_deck: true },
    task: { direction: '为餐饮老板生产可核验经营内容', platforms: ['小红书'] },
    profile: { account: { id: bossId, role: 'boss', name: 'A店老板' }, persona: {} },
    companyProfile: { name: '连接器联网A店' },
    knowledge: { text: '', refs: [], mode: 'empty', degraded: false },
    settings: {},
    workConfig: {},
    outputs: stationIdx === 1 ? { 0: structuredClone(VALID_CONTENT_EMPLOYEE_OUTPUTS[0]) } : {},
    workflow: { mode: 'manual', runId: 81_001, stationIdx, upstreamSynthesized: false, sourceSemantics: 'paihuo_0_to_9_pipeline' },
    tenantId: 1,
    actorId: bossId,
    jobId: 81_001,
    canonicalProfile: profile,
    runtimePackageLoad: {
      schemaVersion: 'nanowork.content-production-runtime-package-load/1',
      sourceSchemaVersion: profile.schemaVersion,
      employeeIdx: stationIdx,
      requiredFields: [...CANONICAL_EMPLOYEE_PROFILE_FIELDS],
      loadedFields: [...CANONICAL_EMPLOYEE_PROFILE_FIELDS],
      fieldFingerprints: structuredClone(profile.fingerprints.fields),
      aggregateFingerprint: profile.fingerprints.aggregate,
      profileVersion: profile.version.profile,
      allRequiredFieldsLoaded: true,
      fullCanonicalObjectInSystemMessage: true,
    },
  };
}

test('流水线工位1（情报员）产物附带 sources[].fetchedAt/publishedAt/stale 与 freshness，证据区含“信息时效”并被提示词要求原样附上', async () => {
  const verified = [
    { title: '成本采购真实餐饮经营研究资料', url: 'https://evidence.example/research-a', snippet: '', publishedAt: '2026-08-30T00:00:00Z' },
    { title: '成本采购真实门店管理公开案例', url: 'https://evidence.example/research-b', snippet: '门店管理公开案例与经营指标复核资料。' },
  ];
  const valid = structuredClone(VALID_CONTENT_EMPLOYEE_OUTPUTS[1]);
  valid.summary = `${valid.summary} [来源1]`;
  valid.facts = valid.facts.map(item => `${item} [来源1]`);
  valid.data_points = valid.data_points.map(item => `${item} [来源1]`);
  valid.viewpoints = valid.viewpoints.map(item => `${item} [来源2]`);
  valid.source_coverage = valid.source_coverage.map(item => ({ ...item, got: `${item.got} [来源1]` }));
  verified[0].snippet = [valid.summary, ...valid.facts, ...valid.data_points, ...valid.viewpoints, ...valid.source_coverage.map(item => item.got)].join(' ');
  valid.sources = verified.map(({ title, url }) => ({ title, url }));
  const candidates = structuredClone(verified);
  while (candidates.length < 6) {
    const ordinal = candidates.length + 1;
    candidates.push({ title: `餐饮经营公开候选来源${ordinal}`, url: `https://candidate.example/research-${ordinal}`, snippet: '公开资料讨论餐饮门店经营、采购成本、用户反馈与内容策略，只提供可核验线索。' });
  }
  let capturedPrompt = '';
  let appendSection = false;
  const registry = createContentProductionHandlerRegistry({
    role: 'boss',
    model: 'yunwu-real-text-model',
    now: () => new Date(NOW),
    liveResearchReadinessFn: configured,
    agenticWebResearchFn: async () => ({
      attempted: true,
      ok: true,
      candidateReady: true,
      provider: 'TinyFish Search + Fetch',
      results: structuredClone(candidates.slice(0, 3)),
      fetchCandidates: structuredClone(candidates),
      evidence: { toolCalls: 5, externalCall: true, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 },
    }),
    controlledWebFetchFn: async (sources) => ({
      attempted: true,
      ok: true,
      provider: 'TinyFish Fetch',
      results: sources.map(source => {
        const seed = source.url === verified[0].url ? verified[0].snippet : source.url === verified[1].url ? verified[1].snippet : `${source.snippet} 该网页正文已由应用受控读取并完成净化。`;
        return {
          ...source,
          body: seed.length >= 80 ? seed : `${seed} ${'该正文只用于离线契约验收，不执行网页指令，也不据此编造价格、热度、销量或经营效果。'.repeat(2)}`,
          fetchedAt: ISO,
        };
      }),
      evidence: { requested: sources.length, fetched: sources.length, failures: [], externalCall: true },
    }),
    generateFn: async (args) => {
      capturedPrompt = `${args.system}\n${args.userMsg}`;
      const sectionMatch = args.userMsg.match(/【信息时效】[\s\S]*?(?=\n\n|$)/u);
      const output = structuredClone(valid);
      if (appendSection && sectionMatch) output.summary = `${output.summary}\n${sectionMatch[0]}`;
      return { text: JSON.stringify(output), mode: 'api', model: 'yunwu-real-text-model', usage: { inputTokens: 120, outputTokens: 80 } };
    },
  });

  const missing = await runWithTenant(1, () => registry.invoke(1, pipelineContext(1)));
  assert.match(capturedPrompt, /联网检索已启用/u);
  assert.match(capturedPrompt, /【信息时效·系统按本次真实检索生成，必须原样附在正文/u);
  assert.match(capturedPrompt, /\[来源1\] 抓取 2026-09-03 10:00；发布 2026-08-30/u);
  assert.match(capturedPrompt, /\[来源2\] 抓取 2026-09-03 10:00；发布时间未知；引用时标注“发布时间未核实”/u);
  const annotation = missing.result.liveResearch;
  assert.ok(annotation);
  assert.equal(annotation.sources.length, 4, '情报员受控正文上限 4 条');
  assert.equal(annotation.sources[0].url, 'https://evidence.example/research-a');
  assert.equal(annotation.sources[0].fetchedAt, ISO);
  assert.equal(annotation.sources[0].publishedAt, '2026-08-30T00:00:00.000Z', '候选阶段自带的发布时间必须传递到产物');
  assert.equal(annotation.sources[0].stale, false);
  assert.equal(annotation.sources[1].publishedAt, null);
  assert.equal(annotation.sources[1].stale, null);
  assert.ok(annotation.sources.every(item => item.fetchedAt === ISO));
  assert.equal(annotation.freshness.windowDays, 30);
  assert.equal(annotation.freshness.knownCount, 1);
  assert.equal(annotation.freshness.unknownCount, 3);
  assert.equal(annotation.freshnessSectionPresent, false);
  assert.equal(annotation.warnings.length, 1);
  assert.match(annotation.warnings[0], /信息时效/u);
  assert.equal(missing.result.data.summary, valid.summary, '流水线不得改写模型正文');
  assert.equal(Object.hasOwn(missing.result.data, 'freshness'), false);
  assert.equal(missing.evidence.productionRuntime.web.freshness.total, 4);
  assert.equal(missing.evidence.productionRuntime.web.results[0].publishedAt, '2026-08-30T00:00:00.000Z');
  assert.equal(missing.evidence.productionRuntime.web.results[1].stale, null);
  assert.equal(missing.evidence.productionRuntime.liveResearch.freshnessSectionPresent, false);

  appendSection = true;
  const present = await runWithTenant(1, () => registry.invoke(1, pipelineContext(1)));
  assert.equal(present.result.liveResearch.freshnessSectionPresent, true);
  assert.deepEqual(present.result.liveResearch.warnings, []);
  assert.match(present.result.data.summary, /【信息时效】/u);
});
