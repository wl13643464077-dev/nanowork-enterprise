import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTempDirSafely } from './helpers/temp-db.mjs';

// Task 126 regression. All search, location, trade-area, page-fetch and model
// boundaries are injected. The real 360 adapter only consumes a local Response
// fixture so this test also exercises its actual candidate provenance contract.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-employee-102-research-integration-'));
const dbPath = path.join(testRoot, 'test.db');
Object.assign(process.env, {
  NANOWORK_DB: dbPath,
  NANOWORK_TEST_TEMPLATE_AI: '1',
  NANOWORK_EMPLOYEE_OUTPUT_STYLE: 'contract_json',
  NANOWORK_AI_PROVIDER: '360',
  AI360_API_KEY: 'offline-employee-102-research-fixture',
  YUNWU_BASE_URL: 'https://api.360.cn/v1',
  YUNWU_API_KEY: '',
  OPENLUX_API_KEY: '',
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  TINYFISH_API_KEY: '',
  AMAP_WEB_KEY: '',
  ENABLE_BACKGROUND_EMBEDDINGS: 'false',
  ENABLE_SCHEDULER: 'false',
  SEED_DEMO: 'false',
});
delete process.env.NANOWORK_RESEARCH_MODEL;
delete process.env.NANOWORK_360_RESEARCH_MODEL;
const originalFetch = globalThis.fetch;
const unexpectedNetworkCalls = [];
globalThis.fetch = async input => {
  unexpectedNetworkCalls.push(String(input));
  throw new Error('Integration regression must not use external network');
};

const { initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const { buildEmployeeExecutionProfile } = await import('../src/employee-workbench.js');
const { marshalWork } = await import('../src/engines/ai.js');
const { run360ClaudeWebSearch } = await import('../src/engines/provider-360-websearch.js');
const { buildRestaurantOutputDeliverableFixture } = await import('../src/engines/restaurant-output-contract.js');

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

const TASK = Object.freeze({
  title: '清凤时代城商圈竞品与流量勘察',
  type: '商圈画像',
  requirement: '请分析成都清凤时代城1楼底商周边1-3公里，拟经营烘焙门店，核验商圈竞品与流量，并给出附近地铁站距离和步行分钟数。',
});
const MAP_SOURCE = Object.freeze({
  title: 'OpenStreetMap定位·成都清凤时代城',
  url: 'https://www.openstreetmap.org/way/102126',
  snippet: '成都清凤时代城地图中心及附近地铁站位置，距离与步行时长仍按可核验路网记录核对。',
});
const FETCHED_AT = '2026-09-09T08:00:00.000Z';

function searchPayload() {
  return {
    id: 'employee-102-research-integration|126',
    model: 'softwareone/anthropic/claude-sonnet-4.6',
    choices: [{ message: { role: 'assistant', content: '' } }],
    usage: { prompt_tokens: 1, completion_tokens: 0, amount: '0' },
    context: {
      web_search_records: Array.from({ length: 5 }, (_unused, index) => ({
        title: `烘焙门店资料${index + 1}`,
        url: `https://www.dianping.com/shop/research-integration-${index + 1}`,
        summary: index === 0 ? '' : '门店菜单与营业信息',
      })),
    },
  };
}

function employeeProfile(outputMode) {
  return buildEmployeeExecutionProfile(102, {
    tenantId: 1,
    user: { id: 1, role: 'boss', tenant_id: 1 },
    ...(outputMode ? { outputMode } : {}),
  });
}

function controlledPage(source, bodyMode) {
  if (bodyMode === 'unrelated_city') {
    return {
      ...source,
      title: '上海陆家嘴烘焙门店菜单',
      snippet: '上海浦东陆家嘴烘焙店营业信息。',
      body: '上海浦东陆家嘴烘焙门店提供面包、蛋糕和下午茶，公开商户页面记录营业时间、菜单价格和顾客评价主题；经营状态与产品供应应按核验日期复查。本页描述上海陆家嘴商户，不包含其他城市或项目的商户资料。',
      fetchedAt: FETCHED_AT,
    };
  }
  return {
    ...source,
    title: '成都清凤时代城烘焙门店菜单',
    snippet: '成都清凤时代城烘焙门店的公开菜单与营业信息。',
    body: bodyMode === 'empty'
      ? ''
      : '成都清凤时代城烘焙门店的受控网页正文记录：面包、蛋糕等菜单品类，营业时间、堂食和外带方式，公开评价涉及口味、出餐等待和价格感受。门店经营状态、菜单与价格应按核验日期逐项回看；地铁站距离和步行时长由地图路网来源核对，不能用商户摘要替代。',
    fetchedAt: FETCHED_AT,
  };
}

async function runProbe({
  bodyMode = 'valid',
  multiSource = false,
  tamperProvenance = false,
  missingMap = false,
  amapMode = null,
  outputMode = null,
  dataMode = 'live',
  task = TASK,
} = {}) {
  const calls = { agentic: [], locate: [], trade: [], controlled: [], generate: [], search: [], snapshot: null, supplemental: [] };
  let verifiedPage = null;
  let result = null;
  let failure = null;
  try {
    result = await runWithTenant(1, () => marshalWork(
      { code: 'M-01', name: '战略与开店筹备部', duty: '仅负责调度', prompt: '', kb_deps: '' },
      task,
      'boss',
      {
        employeeExecution: employeeProfile(outputMode),
        dataMode,
        requireAgenticResearch: true,
        parallelInjectedWebSearch: false,
        agenticWebResearchFn: async (query, options) => {
          calls.agentic.push({ query, searchQuery: options.searchQuery });
          const response = await run360ClaudeWebSearch(query, {
            ...options,
            fetchFn: async (_input, init) => {
              calls.search.push(JSON.parse(init.body));
              return new Response(JSON.stringify(searchPayload()), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'offline-research-126' },
              });
            },
          });
          if (tamperProvenance) {
            for (const source of response.fetchCandidates) {
              source.sourceProvenance = {
                ...source.sourceProvenance,
                url: 'https://www.dianping.com/shop/different-provider-record',
              };
            }
          }
          return response;
        },
        webSearchFn: async (query, options) => {
          calls.supplemental.push({query, options});
          if (!multiSource) return { attempted: true, ok: false, results: [] };
          const topic = ['写字楼', '住宅', '学校', '地铁', '商场'].find(word => query.includes(word)) || '餐厅';
          return {attempted: true, ok: true, provider: 'offline-topic-search', results:
            Array.from({length: 4}, (_, index) => ({
              title: `成都清凤时代城${topic}官方资料${index}`,
              url: `https://example.org/${encodeURIComponent(topic)}/${index}`,
              snippet: `成都清凤时代城${topic}公开地址与运营信息，具体资料需读取正文核验。`,
            }))};
        },
        locationIntelligenceFn: async (query, options) => {
          calls.locate.push({ query, ...options });
          return {
            attempted: true,
            ok: !missingMap,
            provider: 'offline-location-fixture',
            results: missingMap ? [] : [{ ...MAP_SOURCE }],
            evidence: {
              schemaVersion: 'nanowork.location-intelligence/1',
              center: missingMap ? null : { lat: 30.54, lon: 104.06 },
              namedPoiCount: missingMap ? 0 : 1,
              isochroneRequired: false,
              isochroneComplete: false,
              externalCall: false,
            },
          };
        },
        tradeAreaFactsFn: async options => {
          calls.trade.push(options);
          if (amapMode) {
            const successful = amapMode === 'valid' || amapMode === 'unproven';
            const provenance = (endpoint) => ({ provider: 'amap', endpoint, fetchedAt: FETCHED_AT });
            return {
              schemaVersion: 'nanowork.trade-area-facts/1',
              ok: successful,
              provider: successful ? 'amap' : null,
              input: { addressText: options.addressText, city: options.city, categoryKeyword: options.categoryKeyword, radii: options.radii },
              amap: { configured: amapMode !== 'unconfigured', attempted: true, ok: successful },
              center: successful ? { value: { lng: 104.01, lat: 30.58, formattedAddress: '四川省成都市清凤时代城', matchedAddressText: options.addressText }, provenance: amapMode === 'unproven' ? null : provenance('/v3/geocode/geo') } : null,
              topCompetitors: successful ? { radius: 3000, matchedCategoryKeyword: true, value: [{ id: 'OFFLINE-BAKERY-1', name: '清凤时代城烘焙测试店', coords: { lng: 104.011, lat: 30.581 }, distance: 150, address: '清凤时代城1楼', type: '餐饮服务;糕饼店', cost: null, rating: null }], provenance: provenance('/v3/place/around') } : null,
              sources: [],
              missingCriticalFacts: successful ? [] : [{ field: 'center', reason: '本次未获取地图中心' }],
              fetchedAt: FETCHED_AT,
            };
          }
          return {
            schemaVersion: 'nanowork.trade-area-facts/1',
            ok: !missingMap,
            provider: 'offline-trade-area-fixture',
            input: {
              addressText: options.addressText,
              city: options.city,
              categoryKeyword: options.categoryKeyword,
              radii: options.radii,
            },
            sources: [],
            missingCriticalFacts: missingMap ? ['商圈中心坐标未获取'] : [],
            fetchedAt: FETCHED_AT,
          };
        },
        controlledWebFetchFn: async sources => {
          calls.controlled.push(structuredClone(sources));
          verifiedPage = controlledPage(sources[0], bodyMode);
          return {
            attempted: true,
            ok: true,
            provider: 'offline-controlled-web-fetch',
            results: multiSource ? sources.map(source => ({
              ...source,
              body: `${source.title}。本次公开原文记录该主体地址与运营信息，用于核对成都清凤时代城商圈的真实场所和客源线索。此处为离线回归测试正文，不能代表当地真实资料或客流规模，也不能把学校、办公、住宅存在性等同于实际到店消费。`,
              fetchedAt: FETCHED_AT,
            })) : [verifiedPage],
            evidence: {
              schemaVersion: 'nanowork.controlled-web-evidence/1',
              requested: sources.length,
              fetched: 1,
              failures: [],
              externalCall: false,
              ssrfProtected: true,
              redirectsRevalidated: true,
            },
          };
        },
        generateFn: async args => {
          calls.generate.push(args);
          const output = buildRestaurantOutputDeliverableFixture(102, task);
          output.decision_context.sources = (amapMode && calls.snapshot ? calls.snapshot.results : [...(missingMap ? [] : [MAP_SOURCE]), verifiedPage]).map(source => ({
            source: `${source.title}｜${source.url}`,
            period: '2026-09-09',
            fact: source === MAP_SOURCE
              ? '地图定位成都清凤时代城，站点距离和步行时长按路网记录核对。'
              : '成都清凤时代城烘焙门店受控正文提供菜单、营业状态和评价主题。',
          }));
          return {
            text: JSON.stringify(output),
            mode: 'api',
            model: 'deepseek/deepseek-v4-pro',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
        onResearchComplete: web => { calls.snapshot = structuredClone(web); },
      },
    ));
  } catch (error) {
    failure = error;
  }
  return { calls, result, failure };
}

test('任务126：规范中心、烘焙查询、3公里地图及360短摘要候选贯通正文核验', async () => {
  const { calls, result, failure } = await runProbe();
  assert.ifError(failure);
  assert.equal(calls.agentic.length, 1);
  assert.match(calls.agentic[0].searchQuery, /成都清凤时代城/u);
  assert.match(calls.agentic[0].searchQuery, /烘焙/u);
  assert.doesNotMatch(calls.agentic[0].searchQuery, /数字员工|老板(?:的)?任务|岗位职责|1楼|1-3公里/u);
  assert.equal(calls.search[0].tools[0].web_search.search_query, calls.agentic[0].searchQuery);
  assert.equal(calls.locate.length, 1);
  assert.equal(calls.locate[0].radiusMeters, 3000);
  assert.equal(calls.locate[0].requireIsochrones, false, '地铁站距离和步行分钟数不应强制生成四类等时圈');
  assert.match(calls.locate[0].query, /地铁站距离和步行分钟数/u);
  assert.equal(calls.trade.length, 1);
  assert.equal(calls.trade[0].addressText, '成都清凤时代城');
  assert.equal(calls.trade[0].city, '成都');
  assert.equal(calls.trade[0].categoryKeyword, '烘焙');
  assert.deepEqual(calls.trade[0].radii, [1000, 2000, 3000]);
  assert.equal(calls.trade[0].addressCandidates[0], '成都清凤时代城');
  assert.ok(calls.trade[0].addressCandidates.every(value => !/1楼|底商|周边|公里|竞品|勘察/u.test(value)));
  assert.equal(calls.controlled.length, 1);
  assert.equal(calls.controlled[0].length, 5);
  const sparse = calls.controlled[0].find(source => source.snippet === '');
  assert.ok(sparse, '真实360记录即使缺摘要也应进入受控读取');
  assert.equal(sparse.sourceProvenance.sourcePath, 'context.web_search_records');
  assert.equal(sparse.sourceProvenance.url, sparse.url);
  assert.equal(calls.generate.length, 1);
  assert.equal(result.web.sourceQuality.passed, true);
  assert.equal(result.web.sourceQuality.directRestaurantControlledCount, 1);
  assert.equal(result.web.sourceQuality.directRestaurantStructuredCount, 0);
  assert.equal(result.web.sourceQuality.locationAnchorCount, 1);
  assert.equal(result.employeeContract.valid, true);
});

test('任务126：OSM未命中但高德真实中心与餐饮POI成功时通过地图和来源质量门', async () => {
  const { calls, result, failure } = await runProbe({ missingMap: true, amapMode: 'valid' });
  assert.ifError(failure);
  assert.equal(calls.trade[0].requireIsochrones, false);
  assert.equal(calls.generate.length, 1);
  assert.equal(result.web.sourceQuality.passed, true);
  assert.equal(result.web.sourceQuality.directRestaurantStructuredCount, 1);
  const location = result.web.channels.find(channel => channel.kind === 'location_intelligence');
  assert.equal(location.ok, true);
  assert.equal(location.evidence.center.coordinateSystem, 'GCJ-02');
  assert.equal(location.evidence.isochroneComplete, false);
  assert.equal(new Set(location.results.map(source => source.url)).size, 2);
  assert.ok(location.results.every(source => !new URL(source.url).searchParams.has('key')));
  assert.match(location.results[1].snippet, /非步行路网距离/u);
  // 每家门店条目不再逐条重复“未获取”；接口字段口径只在中心条目说明一次。
  assert.doesNotMatch(location.results[1].snippet, /未获取/u);
  assert.match(location.results[0].snippet, /月销量、营业时间与步行时长不在本接口字段内/u);
  assert.deepEqual(result.web.tradeAreaFacts.missingCriticalFacts, [], '回归前提：地图来源达标且没有missingCriticalFacts');
  assert.equal(result.web.sourceQuality.passed, true);
  const system = calls.generate[0].system;
  assert.equal(Object.hasOwn(calls.generate[0], 'thinking'), false, '非Markdown模式维持原思考策略');
  assert.match(system, /【商圈事实边界·地图成功时同样适用】/u);
  assert.match(system, /禁止用POI数量乘自造的每小区户数、每栋人数等人工倍数估算人口/u);
  assert.match(system, /小区\/项目中心坐标不是具体候选铺门口/u);
  assert.match(system, /高德周边distance不是步行路网距离，固定半径不是等时圈/u);
  assert.match(system, /不得以其他门店地址里到地铁站的距离推算中心到地铁/u);
  assert.match(system, /分页返回75条不是全商圈/u);
  assert.match(system, /不能外推整体分布、商圈消费者偏好或需求强弱/u);
  assert.match(system, /不能冒充单品价格、菜单套餐价格或真实交易客单/u);
  assert.match(system, /未取得菜单、营业时间及经营形态时/u);
  assert.match(system, /机会统一写‘待验证的经营假说’/u);
  assert.match(system, /不能交给下游财务模型作为已知输入/u);
  assert.match(system, /历史网页.*必须跟随原始信息年份逐项标注/u);
  assert.match(system, /没有核验不附星期、节假日或晴雨天气/u);
  assert.match(system, /正文照常完整交付，不因此触发重新派活或另加失败结论/u);
  assert.equal(result.employeeContract.valid, true, '事实边界加强不能增加运行失败门');
});

test('已取得商圈事实的Markdown报告显式关闭深思，缺事实时保持原策略', async () => {
  const verified = await runProbe({ missingMap: true, amapMode: 'valid', outputMode: 'paihuo_markdown' });
  assert.ifError(verified.failure);
  assert.equal(verified.calls.generate[0].thinking, false);
  assert.equal(verified.result.employeeContract.deliveryStyle, 'paihuo_markdown');
  const missing = await runProbe({ missingMap: true, amapMode: 'failed', outputMode: 'paihuo_markdown', dataMode: 'demo' });
  assert.ifError(missing.failure);
  assert.ok(missing.calls.generate.length > 0);
  assert.equal(Object.hasOwn(missing.calls.generate[0], 'thinking'), false);
  assert.equal(verified.calls.generate[0].model, missing.calls.generate[0].model, '不改变岗位模型选择');
  assert.equal(verified.calls.generate[0].providerPolicy, missing.calls.generate[0].providerPolicy, '不改变供应商策略');
});

for (const amapMode of ['unconfigured', 'failed', 'unproven']) {
  test(`任务126：OSM未命中且高德${amapMode}不能伪造地图成功`, async () => {
    const { calls, failure } = await runProbe({ missingMap: true, amapMode });
    assert.equal(failure?.code, 'EMPLOYEE_PUBLIC_RESEARCH_INCOMPLETE');
    assert.equal(calls.generate.length, 0);
    assert.equal(calls.snapshot.sourceQuality.locationAnchorCount, 0);
    assert.equal(calls.snapshot.sourceQuality.directRestaurantStructuredCount, 0);
  });
}

test('任务126：高德POI成功不能冒充用户明确要求的真实路网等时圈', async () => {
  const { calls, failure } = await runProbe({ missingMap: true, amapMode: 'valid', task: { ...TASK, requirement: `${TASK.requirement}另需步行10分钟真实路网等时圈。` } });
  assert.equal(failure?.code, 'EMPLOYEE_PUBLIC_RESEARCH_INCOMPLETE');
  assert.equal(calls.generate.length, 0);
  assert.equal(calls.trade[0].requireIsochrones, true);
  const location = calls.snapshot.channels.find(channel => channel.kind === 'location_intelligence');
  assert.equal(location.ok, false);
  assert.equal(location.evidence.isochroneRequired, true);
  assert.match(location.note, /真实路网等时圈尚未取得/u);
});

for (const bodyMode of ['empty', 'unrelated_city']) {
  test(`任务126：360可信候选不能把${bodyMode === 'empty' ? '空正文' : '异地商户正文'}升级为直接餐饮证据`, async () => {
    const { calls, failure } = await runProbe({ bodyMode });
    assert.ok(failure, '缺少目标地点餐饮正文必须阻断生成');
    assert.equal(failure.code, 'EMPLOYEE_PUBLIC_RESEARCH_INCOMPLETE');
    assert.equal(calls.controlled.length, 1, '候选应先获准受控读取，再按实际正文判断');
    assert.equal(calls.generate.length, 0);
    assert.equal(calls.snapshot.sourceQuality.passed, false);
    assert.equal(calls.snapshot.sourceQuality.directRestaurantSourceCount, 0);
    assert.equal(calls.snapshot.sourceQuality.locationAnchorCount, 1, '地图锚点不能替代餐饮直接来源');
    if (bodyMode === 'unrelated_city') {
      assert.ok(calls.snapshot.sourceQuality.rejected.some(item => item.reason === 'not_relevant_to_location_business_task'));
    }
  });
}

test('任务126：篡改360 provenance绑定URL时不得放宽候选相关性门', async () => {
  const { calls, failure } = await runProbe({ tamperProvenance: true });
  assert.ok(failure);
  assert.equal(failure.code, 'EMPLOYEE_PUBLIC_RESEARCH_INCOMPLETE');
  assert.equal(calls.controlled.length, 0, 'URL绑定不符的无地点摘要候选必须在抓取前拒绝');
  assert.equal(calls.generate.length, 0);
  assert.equal(calls.snapshot.sourceQuality.passed, false);
  assert.equal(calls.snapshot.sourceQuality.directRestaurantSourceCount, 0);
  assert.ok(calls.snapshot.sourceQuality.rejected.some(item =>
    item.reason === 'not_relevant_to_location_business_task'
      && item.stage === 'before_controlled_fetch:agentic_web_research'));
});

test('任务126：缺地图但已有受控正文的演示生成必须优先遵守证据不足规则并保留原要求', async () => {
  const task = {
    ...TASK,
    requirement: `${TASK.requirement}至少列出8家竞品，并整理住宅户数、白领人数（示例：6000户、20000人）；每家给出距离和步行分钟数。`,
  };
  const { calls, failure } = await runProbe({ task, missingMap: true, dataMode: 'demo' });
  assert.ifError(failure);
  assert.equal(calls.controlled.length, 1, '确有目标地点的受控正文，缺口来自地图定位');
  assert.equal(calls.snapshot.sourceQuality.directRestaurantControlledCount, 1);
  assert.equal(calls.snapshot.sourceQuality.locationAnchorCount, 0);
  assert.equal(calls.snapshot.sourceQuality.passed, false, '演示生成不能把缺地图场景标为证据达标');
  assert.ok(calls.generate.length >= 1, '演示模式应将已取得事实交给模型生成有限简报');
  const { system, userMsg } = calls.generate[0];
  assert.match(system, /【本轮地点证据不足·优先于篇幅、数量与完整性要求】/u);
  assert.match(system, /查到几家就写几家/u);
  assert.match(system, /不得把未知店、假定品牌、非同品类商户、搜索线索或待确认门店凑入已核验竞品清单/u);
  assert.match(system, /住宅户数、白领人数，一律写‘未获取’/u);
  assert.match(system, /不得用模型记忆、行业经验、用户举例数值、猜测或粗估填表/u);
  assert.match(system, /没有坐标就不能用其他地标替代商圈中心或换算距离/u);
  assert.match(system, /不得为了满足完整性要求编造或猜测/u);
  assert.ok(userMsg.includes(task.requirement), '完整用户要求及其数量、人口示例应原样保留在业务输入区');
  assert.ok(userMsg.includes(task.title));
});

after(async () => {
  globalThis.fetch = originalFetch;
  await removeTempDirSafely(testRoot, { dbPath });
  assert.deepEqual(unexpectedNetworkCalls, [], '所有外部通道必须保持离线注入');
});


test('餐厅主检索成功仍补查客源网页，抓到餐厅正文后继续后续批次', async () => {
  const { calls, result, failure } = await runProbe({multiSource: true});
  assert.ifError(failure);
  // 岗位技能计划（点评/美团/高德/窄门）全部执行 + 六类客源公共查询补足，总数受 12 条硬上限保护。
  assert.ok(calls.supplemental.length >= 8 && calls.supplemental.length <= 14, `补充检索条数=${calls.supplemental.length}`);
  const supplementalQueries = calls.supplemental.map(call => call.query);
  assert.ok(supplementalQueries.some(query => /site:dianping\.com/u.test(query)), '点评技能查询必须真实执行');
  assert.ok(supplementalQueries.some(query => /高德地图/u.test(query)), '高德公开页面技能查询必须真实执行');
  for (const topic of ['写字楼', '社区 住宅', '学校', '地铁', '商场']) {
    assert.ok(supplementalQueries.some(query => query.includes(topic)), `${topic} 客源查询必须存在`);
  }
  assert.ok(calls.supplemental.every(call => call.options.allowBroadFallback === false));
  assert.ok(calls.controlled.length >= 2, '不能抓到第一家餐厅就退出');
  assert.ok(calls.controlled.flat().length <= 24);
  for (const topic of ['写字楼', '住宅', '学校', '地铁', '商场']) {
    assert.ok(calls.controlled.flat().some(source => source.title.includes(topic)), topic + '必须进入正文抓取');
    assert.ok(result.web.results.some(source => source.title.includes(topic) && source.body), topic + '必须进入最终可引用证据');
    assert.ok(JSON.stringify(calls.generate[0]).includes(topic), topic + '必须进入生成上下文');
  }
  assert.equal(result.web.sourceQuality.passed, true);
});
