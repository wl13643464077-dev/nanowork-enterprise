import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 这是离线来源质量回归：所有联网、地图、受控抓取和模型均为本地注入，
// 不读取真实凭据、不产生付费请求。它专门复现 T1305 的“数量门通过但
// 来源混入假证件/翻译/营销 SEO 垃圾”问题。
const dbPath = path.join(
  os.tmpdir(),
  `nanowork-employee-102-source-quality-${process.pid}.db`,
);
for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best effort
  }
}
process.env.NANOWORK_DB = dbPath;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
process.env.ENABLE_SCHEDULER = "false";
process.env.SEED_DEMO = "false";

const { initSchema, migrateV2 } = await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { buildEmployeeExecutionProfile } =
  await import("../src/employee-workbench.js");
const { marshalWork } = await import("../src/engines/ai.js");
const { buildRestaurantOutputDeliverableFixture } =
  await import("../src/engines/restaurant-output-contract.js");

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

const TASK = Object.freeze({
  title: "毛血旺 太原吾悦广场",
  type: "商圈画像",
  requirement:
    "请围绕毛血旺 太原吾悦广场核验竞品与商圈画像，给出下一步可执行的业务结论。",
});

const MAP_SOURCE = Object.freeze({
  title: "OpenStreetMap定位·太原吾悦广场",
  url: "https://www.openstreetmap.org/way/7001",
  snippet: "地图定位目标商场与周边POI，并保留等时圈来源用于可达性核验。",
});
const DIRECT_SOURCE = Object.freeze({
  title: "毛血旺·太原吾悦广场商户页面",
  url: "https://www.dianping.com/shop/maoxuewang-wuyue",
  snippet: "与目标地点和餐饮对象直接相关的商户菜单、营业状态与评价页面。",
});
const STRUCTURED_RESTAURANT_SOURCE = Object.freeze({
  title: "OpenStreetMap周边餐饮·吾悦川菜馆",
  url: "https://www.openstreetmap.org/node/9593536015",
  snippet:
    "地图中心=太原吾悦广场；距中心直线约86米；类别=餐饮；cuisine=川菜。OSM公开数据可能不完整，营业状态与价格仍需交叉核验。",
  evidenceKind: "structured_location_restaurant_poi",
});
const BAD_SOURCES = Object.freeze([
  {
    title: "做个假斯洛伐克护照",
    url: "https://sites.google.com/view/hvqdjsccqenwboq/",
    snippet: "假证件、WhatsApp/Telegram 引流网页。",
  },
  {
    title: "太原吾悦广场怎么翻译",
    url: "https://fanyi.taobao.com/en/qinziyouwan_12355/detail-e382fe3df7d9b24ad9eefdfcbdb3392f.html",
    snippet: "翻译词典页，不是官方、地图、平台或商户证据。",
  },
  {
    title: "太原商家获客遇困境？GEO推广服务精准破局流量难题",
    url: "https://www.cnblogs.com/wlfg/p/19959505",
    snippet: "泛 GEO 服务商营销案例。",
  },
  {
    title: "太原江浙菜餐厅推荐榜",
    url: "https://www.cnblogs.com/hc6688/p/20385562",
    snippet: "与目标菜品和门店不直接相关的 SEO 榜单聚合文。",
  },
  {
    title: "沈阳大东区包包回收指南",
    url: "https://www.cnblogs.com/Y-s-xing/p/21009162",
    snippet: "异地、非餐饮、非商圈任务页面。",
  },
]);

const sourceLine = (source) => `${source.title}｜${source.url}`;

function employeeExecution() {
  return buildEmployeeExecutionProfile(102, {
    tenantId: 1,
    user: { id: 1, role: "boss", tenant_id: 1 },
  });
}

function qualityEvidence() {
  return {
    schemaVersion: "nanowork.agentic-web-research/1",
    executionMode: "offline_fixture",
    model: "qa-real-source-quality-model",
    toolCalls: 5,
    toolAttempts: 5,
    toolResults: Array.from({ length: 5 }, (_unused, index) => ({
      toolUseId: `source-quality-search-${index + 1}`,
      success: true,
      isError: false,
      permissionDenied: false,
      urlCount: BAD_SOURCES.length + 2,
    })),
    qualityGate: {
      requiredSearches: 5,
      requiredSources: 5,
      observedSearches: 5,
      observedSuccessfulToolResults: 5,
      observedToolResultUrls: BAD_SOURCES.length + 2,
      observedSources: BAD_SOURCES.length + 2,
      passed: true,
    },
    candidateGate: {
      requiredSearches: 5,
      requiredSuccessfulToolResults: 5,
      requiredToolResultUrls: 5,
      requiredCandidates: 5,
      observedSearches: 5,
      observedSuccessfulToolResults: 5,
      observedToolResultUrls: BAD_SOURCES.length + 2,
      observedCandidates: BAD_SOURCES.length + 2,
      passed: true,
      requiresControlledWebFetch: true,
    },
    queries: [
      "太原吾悦广场 地址 位置",
      "毛血旺 太原吾悦广场",
      "太原吾悦广场 餐饮 竞品",
      "太原吾悦广场 菜单 价格",
      "太原吾悦广场 营业状态 评价",
    ],
    facts: [],
    gaps: [],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 },
    costUsd: 0,
    externalCall: false,
    localLoginInherited: false,
  };
}

function agenticEvidence(
  sources = [...BAD_SOURCES, MAP_SOURCE, DIRECT_SOURCE],
) {
  const response = {
    attempted: true,
    ok: true,
    candidateReady: true,
    provider: "offline-source-quality-fixture",
    results: sources,
    evidence: qualityEvidence(),
  };
  // 生产返回的候选句柄是同一调用栈内的不可枚举字段；离线夹具保持相同
  // 形状，确保测试的是 ai.js 的候选→受控抓取→prompt 链路。
  Object.defineProperty(response, "fetchCandidates", {
    value: sources,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return response;
}

function locationEvidence(includeDirect = true) {
  const results = [
    {
      title: "真实时间等时圈·驾车(driving)",
      url: "https://valhalla1.openstreetmap.de/isochrone?location=7001&mode=auto",
      snippet: "10/20/30分钟真实路网等时圈。",
    },
    MAP_SOURCE,
  ];
  if (includeDirect) results.push(DIRECT_SOURCE);
  return {
    attempted: true,
    ok: true,
    provider: "offline-location-fixture",
    results,
    evidence: {
      schemaVersion: "nanowork.location-intelligence/1",
      externalCall: false,
      center: { lat: 37.8714583, lon: 112.5131159 },
      namedPoiCount: 3,
      isochroneRequired: true,
      isochroneComplete: true,
      isochroneModes: ["walking", "cycling", "driving", "transit"],
    },
  };
}

function candidateOutput({
  includeBadSource = true,
  directSource = DIRECT_SOURCE,
} = {}) {
  const output = buildRestaurantOutputDeliverableFixture(102, TASK);
  const sources = [
    {
      source: sourceLine(MAP_SOURCE),
      period: "2026-08-08",
      fact: "公开地图定位目标商场和周边POI；等时圈用于可达性核验，营业和价格仍保留现场证伪动作。",
    },
    {
      source: sourceLine(directSource),
      period: "2026-08-08",
      fact:
        directSource.evidenceKind === "structured_location_restaurant_poi"
          ? "公开地图的结构化餐饮POI证明目标商场周边存在餐饮对象；菜单、价格、营业状态和评价仍列为待补证项。"
          : "公开商户页面与目标地点、餐饮对象直接相关，菜单、营业状态和评价逐项按核验日回看。",
    },
  ];
  if (includeBadSource) {
    sources.push({
      source: sourceLine(BAD_SOURCES[0]),
      period: "2026-08-08",
      fact: "该候选仅用于验证来源质量门，业务结论不得引用。",
    });
  }
  output.decision_context.sources = sources;
  return output;
}

function controlledFetch(sources, calls) {
  calls.push(sources.map((source) => source.url));
  return {
    attempted: true,
    ok: true,
    provider: "offline-controlled-web-fetch",
    results: sources.map((source) => ({
      ...source,
      body: `受控网页正文核验记录：${source.title}；菜单、菜品价格、营业时间、堂食与外卖渠道、评价主题和门店状态均保留可回看正文，未知字段保留证伪动作，不把推测写成事实。`,
    })),
    evidence: {
      schemaVersion: "nanowork.controlled-web-evidence/1",
      requested: sources.length,
      fetched: sources.length,
      failures: [],
      externalCall: false,
      ssrfProtected: true,
      redirectsRevalidated: true,
      responseBytesStored: false,
    },
  };
}

function genericCandidate(index) {
  return {
    title: `太原吾悦广场毛血旺餐饮公开候选${index}`,
    url: `https://candidate-${index}.example/source`,
    snippet: `太原吾悦广场毛血旺餐厅菜单、营业状态、评价与价格公开候选${index}。`,
  };
}

function agenticEvidenceForCandidates(sources) {
  return agenticEvidence(sources);
}

function directBody(source) {
  return `受控商户正文：${source.title}；太原吾悦广场毛血旺餐厅菜单、菜品价格、营业状态、评价与堂食外卖渠道已读取并净化，未知字段保留后续证伪动作。本段仅用于验证受控正文直接餐饮证据门槛。`;
}

function directCandidate(url, title = "目标商户正文") {
  return {
    title,
    url,
    snippet: "太原吾悦广场毛血旺餐厅菜单、营业状态、评价与价格公开商户候选。",
  };
}

function marshalQualityProbe({
  sources,
  controlledWebFetchFn,
  controlledCalls,
}) {
  return marshalWork(
    { code: "M-01", name: "战略与开店筹备部", duty: "仅负责调度", prompt: "" },
    TASK,
    "boss",
    {
      employeeExecution: employeeExecution(),
      requireAgenticResearch: true,
      agenticWebResearchFn: async () => agenticEvidenceForCandidates(sources),
      webSearchFn: async () => ({
        attempted: true,
        ok: false,
        provider: "offline-generic-search",
        results: [],
        note: "offline fixture",
      }),
      locationIntelligenceFn: async () => locationEvidence(false),
      controlledWebFetchFn: async (batch, options) =>
        controlledWebFetchFn(batch, options),
      generateFn: async () => ({
        text: JSON.stringify(candidateOutput()),
        mode: "api",
        model: "qa-real-source-quality-model",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      onResearchComplete: (web) => {
        const channel = web.channels.find(
          (item) => item.kind === "controlled_web_fetch",
        );
        if (channel?.evidence)
          controlledCalls.snapshot = structuredClone(channel.evidence);
      },
    },
  );
}

test(
  "T1305候选池回归：第13条后的Dianping/Seazen候选进入首批，Wikipedia不占位且找到正文即停",
  { concurrency: false },
  async () => {
    const early = Array.from({ length: 12 }, (_unused, index) =>
      genericCandidate(index + 1),
    );
    const dianping = directCandidate(
      "https://www.dianping.com/shop/after-thirteen-wuyue",
      "大众点评·毛血旺 太原吾悦广场商户正文",
    );
    const seazen = directCandidate(
      "https://www.seazen.com.cn/project/after-thirteen-wuyue",
      "吾悦广场·新城控股商场门店正文",
    );
    const wikipedia = {
      title: "Wikipedia 太原吾悦广场背景页",
      url: "https://zh.wikipedia.org/wiki/太原市",
      snippet: "百科背景页，不是目标餐饮商户或地图证据。",
    };
    const sources = [...early, dianping, seazen, wikipedia];
    const controlledCalls = [];
    const result = await marshalQualityProbe({
      sources,
      controlledCalls,
      controlledWebFetchFn: async (batch, options) => {
        controlledCalls.push(batch.map((source) => source.url));
        return {
          attempted: true,
          ok: true,
          provider: "offline-controlled-web-fetch",
          results: batch.map((source) => ({
            ...source,
            body:
              source.url === dianping.url || source.url === seazen.url
                ? directBody(source)
                : "短摘要",
          })),
          evidence: {
            schemaVersion: "nanowork.controlled-web-evidence/1",
            requested: batch.length,
            fetched: batch.length,
            failures: [],
            externalCall: false,
            ssrfProtected: true,
            redirectsRevalidated: true,
          },
        };
      },
    });

    assert.equal(
      controlledCalls.length,
      1,
      "首批命中目标餐饮正文后不得继续无意义抓取",
    );
    assert.equal(controlledCalls[0].length, 8);
    assert.ok(
      controlledCalls[0].includes(dianping.url),
      "第13条后的Dianping候选必须进入首批",
    );
    assert.ok(
      controlledCalls[0].includes(seazen.url),
      "第14条后的Seazen候选必须进入首批",
    );
    assert.ok(
      controlledCalls.every((batch) => !batch.includes(wikipedia.url)),
      "Wikipedia不得占用受控抓取配额",
    );
    const evidence = result.web.channels.find(
      (channel) => channel.kind === "controlled_web_fetch",
    ).evidence;
    assert.equal(evidence.requested, 8);
    assert.equal(evidence.fetched, 8);
    assert.equal(evidence.batchCount, 1);
    assert.equal(result.web.sourceQuality.directRestaurantSourceCount, 2);
    assert.ok(
      result.web.sourceQuality.rejected.some(
        (item) => item.host === "zh.wikipedia.org",
      ),
    );
    assert.doesNotMatch(JSON.stringify(result.web), /wikipedia\.org\/wiki/u);
  },
);

test(
  "T1305候选池回归：首批没有direct正文时继续第二批，找到后停止并汇总批次证据",
  { concurrency: false },
  async () => {
    const generic = Array.from({ length: 15 }, (_unused, index) =>
      genericCandidate(index + 1),
    );
    const secondBatchDirect = directCandidate(
      "https://merchant.example/after-second-batch",
      "太原吾悦广场毛血旺餐饮公开候选16",
    );
    const sources = [...generic, secondBatchDirect];
    const controlledCalls = [];
    const result = await marshalQualityProbe({
      sources,
      controlledCalls,
      controlledWebFetchFn: async (batch, options) => {
        controlledCalls.push(batch.map((source) => source.url));
        const isSecondBatch = controlledCalls.length === 2;
        return {
          attempted: true,
          ok: true,
          provider: "offline-controlled-web-fetch",
          results: isSecondBatch
            ? [{ ...secondBatchDirect, body: directBody(secondBatchDirect) }]
            : batch.map((source) => ({ ...source, body: "短摘要" })),
          evidence: {
            schemaVersion: "nanowork.controlled-web-evidence/1",
            requested: batch.length,
            fetched: isSecondBatch ? 1 : batch.length,
            failures: [],
            externalCall: false,
            ssrfProtected: true,
            redirectsRevalidated: true,
          },
        };
      },
    });

    assert.equal(controlledCalls.length, 2, "首批无direct正文必须继续第二批");
    assert.equal(controlledCalls[0].length, 8);
    assert.equal(controlledCalls[1].length, 8);
    assert.ok(!controlledCalls[0].includes(secondBatchDirect.url));
    assert.ok(controlledCalls[1].includes(secondBatchDirect.url));
    const evidence = result.web.channels.find(
      (channel) => channel.kind === "controlled_web_fetch",
    ).evidence;
    assert.equal(evidence.requested, 16);
    assert.equal(evidence.fetched, 9);
    assert.equal(evidence.batchCount, 2);
    assert.equal(result.web.sourceQuality.directRestaurantSourceCount, 1);
    assert.equal(result.web.sourceQuality.passed, true);
  },
);

test(
  "T1305来源质量回归：数量门PASS不能让诈骗/翻译/营销SEO来源进入受控抓取、prompt或allowedSources",
  { concurrency: false },
  async () => {
    const controlledCalls = [];
    const generationCalls = [];
    const result = await marshalWork(
      {
        code: "M-01",
        name: "战略与开店筹备部",
        duty: "仅负责调度",
        prompt: "",
      },
      TASK,
      "boss",
      {
        employeeExecution: employeeExecution(),
        requireAgenticResearch: true,
        agenticWebResearchFn: async () => agenticEvidence(),
        webSearchFn: async () => ({
          attempted: true,
          ok: false,
          provider: "offline-generic-search",
          results: [],
          note: "offline fixture",
        }),
        locationIntelligenceFn: async () => locationEvidence(true),
        controlledWebFetchFn: async (sources) =>
          controlledFetch(sources, controlledCalls),
        generateFn: async (args) => {
          generationCalls.push(args);
          return {
            text: JSON.stringify(candidateOutput()),
            mode: "api",
            model: "qa-real-source-quality-model",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    );

    // 当前 T1305 实现会在此断言失败：controlledCalls 和 prompt 仍含 BAD_SOURCES。
    assert.ok(controlledCalls.length, "候选来源必须先经过受控抓取链路");
    const badUrls = new Set(BAD_SOURCES.map((source) => source.url));
    assert.ok(
      controlledCalls.every((urls) => urls.every((url) => !badUrls.has(url))),
      "受控抓取前必须剔除诈骗、翻译、泛营销和明显 SEO 聚合来源",
    );
    assert.equal(generationCalls.length, 1, "双锚点充足时应只调用一次最终生成");
    assert.ok(generationCalls[0].userMsg.includes(MAP_SOURCE.url));
    assert.ok(generationCalls[0].userMsg.includes(DIRECT_SOURCE.url));
    for (const source of BAD_SOURCES) {
      assert.doesNotMatch(
        generationCalls[0].userMsg,
        new RegExp(source.url.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      );
    }
    assert.ok(
      result.web.results.some((source) => source.url === MAP_SOURCE.url),
    );
    assert.ok(
      result.web.results.some((source) => source.url === DIRECT_SOURCE.url),
    );
    for (const source of BAD_SOURCES) {
      assert.doesNotMatch(
        JSON.stringify(result.web),
        new RegExp(source.url.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      );
    }
    assert.ok(
      result.employeeContract.parsed.decision_context.sources.every(
        (item) => !badUrls.has(String(item.source).split("｜").at(-1)),
      ),
      "被剔除来源不得进入最终契约的allowedSources恢复路径",
    );
  },
);

test(
  "Overpass故障回归：Agentic候选门已通过且备用地图取得结构化餐饮POI时应继续生成并显式保留缺口",
  { concurrency: false },
  async () => {
    let controlledFetchCalled = false;
    const generationCalls = [];
    const agenticWithoutDeclaredSources = {
      attempted: true,
      ok: false,
      candidateReady: false,
      provider: "offline-agentic-candidate-fixture",
      results: [],
      evidence: qualityEvidence(),
    };
    Object.defineProperty(agenticWithoutDeclaredSources, "fetchCandidates", {
      value: [],
      enumerable: false,
      configurable: false,
      writable: false,
    });

    const result = await marshalWork(
      {
        code: "M-01",
        name: "战略与开店筹备部",
        duty: "仅负责调度",
        prompt: "",
      },
      TASK,
      "boss",
      {
        employeeExecution: employeeExecution(),
        requireAgenticResearch: true,
        agenticWebResearchFn: async () => agenticWithoutDeclaredSources,
        webSearchFn: async () => ({
          attempted: true,
          ok: false,
          provider: "offline-generic-search",
          results: [],
          note: "offline fixture",
        }),
        locationIntelligenceFn: async () => ({
          ...locationEvidence(false),
          results: [
            ...locationEvidence(false).results,
            STRUCTURED_RESTAURANT_SOURCE,
          ],
        }),
        controlledWebFetchFn: async () => {
          controlledFetchCalled = true;
          throw new Error("没有候选正文时不应调用受控抓取器");
        },
        generateFn: async (args) => {
          generationCalls.push(args);
          return {
            text: JSON.stringify(
              candidateOutput({
                includeBadSource: false,
                directSource: STRUCTURED_RESTAURANT_SOURCE,
              }),
            ),
            mode: "api",
            model: "qa-real-source-quality-model",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    );

    assert.equal(controlledFetchCalled, false);
    assert.equal(
      generationCalls.length,
      1,
      "结构化餐饮POI已形成直接锚点时必须进入最终生成",
    );
    assert.ok(
      generationCalls[0].userMsg.includes(STRUCTURED_RESTAURANT_SOURCE.url),
    );
    assert.equal(result.web.sourceQuality.passed, true);
    assert.equal(result.web.sourceQuality.directRestaurantSourceCount, 1);
    assert.equal(result.web.sourceQuality.directRestaurantStructuredCount, 1);
    assert.equal(result.web.sourceQuality.directRestaurantControlledCount, 0);
    assert.ok(
      result.employeeContract.parsed.decision_context.sources.some(
        (item) => item.source === sourceLine(STRUCTURED_RESTAURANT_SOURCE),
      ),
    );
  },
);

test(
  "T1305来源质量回归：缺少地点/餐饮双锚点必须在生成前fail closed，不得生成底稿",
  { concurrency: false },
  async () => {
    let generateCalled = false;
    let failure;
    try {
      await marshalWork(
        {
          code: "M-01",
          name: "战略与开店筹备部",
          duty: "仅负责调度",
          prompt: "",
        },
        TASK,
        "boss",
        {
          employeeExecution: employeeExecution(),
          requireAgenticResearch: true,
          // 只有地图/等时圈和垃圾来源，没有目标餐饮直接来源。
          agenticWebResearchFn: async () =>
            agenticEvidence([...BAD_SOURCES, MAP_SOURCE]),
          webSearchFn: async () => ({
            attempted: true,
            ok: false,
            provider: "offline-generic-search",
            results: [],
            note: "offline fixture",
          }),
          locationIntelligenceFn: async () => locationEvidence(false),
          controlledWebFetchFn: async (sources) => ({
            ...controlledFetch(sources, []),
            // 只返回地图正文，模拟剔除垃圾后仍无餐饮直接证据。
            results: sources
              .filter((source) => source.url === MAP_SOURCE.url)
              .map((source) => ({
                ...source,
                body: "受控地图正文：仅证明位置和可达性。",
              })),
          }),
          generateFn: async () => {
            generateCalled = true;
            return {
              text: JSON.stringify(
                candidateOutput({ includeBadSource: false }),
              ),
              mode: "api",
              model: "qa-real-source-quality-model",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        },
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "地点/餐饮双锚点不足必须抛出可审计失败");
    assert.equal(failure.code, "EMPLOYEE_PUBLIC_RESEARCH_INCOMPLETE");
    assert.equal(generateCalled, false, "来源不足时不得调用最终模型或模板底稿");
    assert.match(String(failure.message), /来源|地图|餐饮|地点|商圈/u);
  },
);

after(() => {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best effort
    }
  }
});
