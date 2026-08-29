import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const DB_PATH = path.join(
  os.tmpdir(),
  `nanowork-location-intelligence-${process.pid}.db`,
);
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}
process.env.NANOWORK_DB = DB_PATH;
// 本文件覆盖的是JSON机器契约执行链（作为可切换回退保留）；
// 派活Markdown主链路的HTTP行为由 paihuo-dispatch-markdown.test.mjs 覆盖。
process.env.NANOWORK_EMPLOYEE_OUTPUT_STYLE = "contract_json";
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.NANOWORK_HTTP_USER_AGENT =
  "NanoWorkEnterprise/1.0 (restaurant-location-intelligence)";

const { initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { buildEmployeeExecutionProfile } =
  await import("../src/employee-workbench.js");
const { marshalWork } = await import("../src/engines/ai.js");
const marshalRoutes = (await import("../src/routes/marshals.js")).default;
const { collectLocationIntelligence, locationQueryCandidates } =
  await import("../src/engines/location-intelligence.js");

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

after(() => {
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
});

const testMarshal = {
  code: "M-01",
  name: "市场与选址分部",
  title: "内部调度容器",
  duty: "仅负责调度",
  skills: "",
  prompt: "",
  kb_deps: "",
};

function clone(value) {
  return structuredClone(value);
}

function mapFetchFixture(calls) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.hostname === "nominatim.openstreetmap.org") {
      return {
        ok: true,
        async json() {
          return [
            {
              osm_type: "way",
              osm_id: 7001,
              lat: "37.810000",
              lon: "112.550000",
              display_name: "太原市小店区吾悦广场",
              address: { city: "太原市", suburb: "小店区" },
            },
          ];
        },
      };
    }
    if (url.hostname === "overpass-api.de") {
      return {
        ok: true,
        async json() {
          return {
            elements: [
              {
                type: "node",
                id: 7101,
                lat: 37.8104,
                lon: 112.5504,
                tags: {
                  name: "吾悦广场毛血旺店",
                  amenity: "restaurant",
                  cuisine: "火锅",
                },
              },
              {
                type: "way",
                id: 7102,
                center: { lat: 37.811, lon: 112.551 },
                tags: { name: "太原吾悦广场", shop: "mall" },
              },
              {
                type: "node",
                id: 7103,
                lat: 37.812,
                lon: 112.552,
                tags: { name: "吾悦公交站", highway: "bus_stop" },
              },
            ],
          };
        },
      };
    }
    throw new Error(`unexpected map URL: ${url}`);
  };
}

// 真实员工102/101的质量门要求四种交通方式、10/20/30分钟等时圈。
// 测试只注入确定性供应商，避免旧地图夹具因缺少路由响应而把测试变成公网依赖。
const ISOCHRONE_MODES = Object.freeze([
  "walking",
  "cycling",
  "driving",
  "transit",
]);
const ISOCHRONE_MINUTES = Object.freeze([10, 20, 30]);
const DIRECT_RESTAURANT_SOURCE = Object.freeze({
  title: "大众点评·毛血旺 太原吾悦广场商户页面",
  url: "https://www.dianping.com/shop/location-intelligence-maoxuewang",
  snippet:
    "太原吾悦广场毛血旺餐厅菜单、菜品、价格、营业状态、评价与外卖公开商户正文。",
  body: "受控商户正文核验记录：太原吾悦广场毛血旺餐厅菜单、菜品价格、营业时间、堂食与外卖渠道、评价主题和门店状态均可回看，未知字段保留证伪动作，不把推测写成事实；缺失项按核验日期标注并安排现场复核。",
});

function controlledSourceResults(sources = []) {
  const seen = new Set([DIRECT_RESTAURANT_SOURCE.url]);
  return [
    DIRECT_RESTAURANT_SOURCE,
    ...sources
      .filter((source) => source?.url && !seen.has(source.url))
      .map((source) => ({
        ...source,
        body: `受控网页正文：${source.title}对应页面正文已读取并净化；太原吾悦广场毛血旺餐饮菜单、营业、评价与价格信息仅作隔离验证，未知字段保留复核动作。`,
      })),
  ];
}

function deterministicIsochroneProvider(request = {}) {
  const modes =
    Array.isArray(request.modes) && request.modes.length
      ? request.modes
      : ISOCHRONE_MODES;
  const minutes =
    Array.isArray(request.minutes) && request.minutes.length
      ? request.minutes
      : ISOCHRONE_MINUTES;
  return {
    provider: "mock-routing-provider",
    source: "https://valhalla1.openstreetmap.de/isochrone",
    isochrones: modes.flatMap((mode, modeIndex) =>
      minutes.map((value, minuteIndex) => {
        const delta = 0.001 + (modeIndex + minuteIndex) * 0.0001;
        return {
          mode,
          minutes: Number(value),
          polygon: {
            type: "Polygon",
            coordinates: [
              [
                [112.55 - delta, 37.81 - delta],
                [112.55 + delta, 37.81 - delta],
                [112.55 + delta, 37.81 + delta],
                [112.55 - delta, 37.81 + delta],
                [112.55 - delta, 37.81 - delta],
              ],
            ],
          },
          provider: "mock-routing-provider",
          source: `https://valhalla1.openstreetmap.de/isochrone/${mode}/${value}`,
        };
      }),
    ),
  };
}

function taskFor(idx) {
  return {
    title: "毛血旺 太原吾悦广场",
    type: idx === 102 ? "商圈画像" : "分析",
    requirement:
      "基于可追溯地图来源核验门店周边餐饮与商业分布；只生成内部交付，不执行外部动作。",
  };
}

function pointExecutionEvidenceAtSource(fixture, source) {
  for (const item of Object.values(fixture.input_audit || {})) {
    item.evidence_refs = [source];
  }
  for (const item of Object.values(fixture.method_execution || {})) {
    item.evidence_refs = [source];
  }
}

test("一句输入自动提取地点，并以mock Nominatim/Overpass生成可追溯地图证据", async () => {
  const calls = [];
  const value = "毛血旺 太原吾悦广场";
  assert.ok(locationQueryCandidates(value).includes("太原吾悦广场"));
  assert.equal(
    locationQueryCandidates("太原毛血旺 吾悦广场")[0],
    "太原吾悦广场",
    "城市+菜品+商场必须先重组成城市+商场，不得先把菜品当地名",
  );

  const result = await collectLocationIntelligence(value, {
    fetchImpl: mapFetchFixture(calls),
    timeoutMs: 100,
  });

  assert.equal(result.attempted, true);
  assert.equal(result.ok, true);
  assert.equal(result.provider, "OpenStreetMap Nominatim + Overpass");
  assert.equal(result.evidence.query, "太原吾悦广场");
  assert.deepEqual(result.evidence.center, {
    displayName: "太原市小店区吾悦广场",
    lat: 37.81,
    lon: 112.55,
  });
  assert.equal(result.evidence.namedPoiCount, 3);
  assert.equal(result.evidence.externalCall, true);
  assert.ok(
    result.results.some(
      (item) => item.url === "https://www.openstreetmap.org/way/7001",
    ),
  );
  assert.ok(
    result.results.some((item) => item.title.includes("吾悦广场毛血旺店")),
  );
  const restaurantPoi = result.results.find((item) =>
    item.title.includes("吾悦广场毛血旺店"),
  );
  assert.equal(
    restaurantPoi.evidenceKind,
    "structured_location_restaurant_poi",
  );
  assert.match(restaurantPoi.snippet, /地图中心=太原市小店区吾悦广场/u);
  assert.equal(
    calls.length,
    2,
    "地图证据必须经过一次Nominatim和一次Overpass mock",
  );
  assert.equal(calls[0].url.hostname, "nominatim.openstreetmap.org");
  assert.equal(calls[0].url.searchParams.get("q"), "太原吾悦广场");
  assert.equal(calls[1].url.hostname, "overpass-api.de");
  assert.match(
    calls[1].url.searchParams.get("data"),
    /around:1500,37\.81,112\.55/u,
  );
  assert.equal(
    calls[0].init.headers["User-Agent"],
    "NanoWorkEnterprise/1.0 (restaurant-location-intelligence)",
  );
});

test("地理编码必须拒绝异地同名候选，不得将太原商圈落到杭州", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.hostname === "nominatim.openstreetmap.org") {
      return {
        ok: true,
        async json() {
          return [
            {
              osm_type: "node",
              osm_id: 1,
              lat: "30.255995",
              lon: "120.168743",
              display_name: "王文昭大学士府，上城区，杭州市，浙江省",
              address: { city: "杭州市" },
            },
            {
              osm_type: "way",
              osm_id: 1126952639,
              lat: "37.8714583",
              lon: "112.5131159",
              display_name: "太原吾悦广场，万柏林区，太原市，山西省",
              address: { city: "太原市", suburb: "万柏林区" },
            },
          ];
        },
      };
    }
    if (url.hostname === "overpass-api.de") {
      return {
        ok: true,
        async json() {
          return { elements: [] };
        },
      };
    }
    throw new Error(`unexpected map URL: ${url}`);
  };
  const result = await collectLocationIntelligence("太原毛血旺 吾悦广场", {
    fetchImpl,
    timeoutMs: 100,
  });
  assert.equal(result.evidence.query, "太原吾悦广场");
  assert.match(result.evidence.center.displayName, /太原吾悦广场/u);
  assert.doesNotMatch(result.evidence.center.displayName, /杭州/u);
  assert.equal(calls[0].url.searchParams.get("q"), "太原吾悦广场");
});

test("Overpass不可用时备用Nominatim必须用OSM类别语义取得餐饮POI", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.hostname.includes("overpass")) {
      return {
        ok: false,
        status: 503,
        async json() {
          return {};
        },
      };
    }
    if (url.hostname !== "nominatim.openstreetmap.org") {
      throw new Error(`unexpected URL: ${url}`);
    }
    const query = url.searchParams.get("q");
    if (query === "太原吾悦广场") {
      return {
        ok: true,
        async json() {
          return [
            {
              osm_type: "way",
              osm_id: 1126952639,
              lat: "37.8714583",
              lon: "112.5131159",
              display_name: "太原吾悦广场, 万柏林区, 太原市, 山西省, 中国",
              address: { city: "太原市", suburb: "万柏林区" },
            },
          ];
        },
      };
    }
    if (query === "restaurant") {
      return {
        ok: true,
        async json() {
          return [
            {
              osm_type: "node",
              osm_id: 9593536015,
              lat: "37.872000",
              lon: "112.514000",
              name: "吾悦川菜馆",
              display_name: "吾悦川菜馆, 万柏林区, 太原市",
              category: "amenity",
              type: "restaurant",
            },
          ];
        },
      };
    }
    return {
      ok: true,
      async json() {
        return [];
      },
    };
  };

  const result = await collectLocationIntelligence("太原毛血旺 吾悦广场", {
    fetchImpl,
    timeoutMs: 100,
    nominatimFallbackDelayMs: 0,
  });
  const restaurant = result.results.find(
    (item) => item.evidenceKind === "structured_location_restaurant_poi",
  );
  assert.ok(restaurant, "备用链必须把结构化餐饮POI交给质量门");
  assert.match(restaurant.title, /吾悦川菜馆/u);
  assert.match(restaurant.snippet, /地图中心=太原吾悦广场/u);
  assert.ok(
    calls.some(
      (call) =>
        call.url.hostname === "nominatim.openstreetmap.org" &&
        call.url.searchParams.get("q") === "restaurant",
    ),
  );
  assert.ok(
    !calls.some((call) => call.url.searchParams.get("q") === "餐厅"),
    "Nominatim类别备用链不得再使用无结果的中文类别词",
  );
});

test("餐饮101/102自动调用地图，其他岗位即使同句地点也不误调；来源进入prompt和执行快照", async () => {
  const mapCalls = [];
  const mapFetchCalls = [];
  const webCalls = [];
  const generationCalls = [];
  const mapFetch = mapFetchFixture(mapFetchCalls);

  for (const idx of [101, 102, 103]) {
    const employeeExecution = buildEmployeeExecutionProfile(idx, {
      tenantId: 1,
      user: { id: 1, role: "boss", tenant_id: 1 },
    });
    const task = taskFor(idx);
    const contract = employeeExecution.outputContract;
    const fixture = clone(contract.validFixture);
    fixture.decision_context.problem = `${task.title}：${fixture.decision_context.problem}`;
    // marshalWork 对联网员工启用来源白名单；该模拟模型逐字回指本轮
    // 受控核验的目标商户/平台正文来源。
    fixture.decision_context.sources[0].source = `${DIRECT_RESTAURANT_SOURCE.title}｜${DIRECT_RESTAURANT_SOURCE.url}`;
    pointExecutionEvidenceAtSource(
      fixture,
      fixture.decision_context.sources[0].source,
    );

    const output = await marshalWork(testMarshal, task, "boss", {
      employeeExecution,
      webSearchFn: async (query) => {
        webCalls.push({ idx, query });
        return {
          attempted: true,
          ok: true,
          provider: "mock-search",
          results: [
            {
              title: "毛血旺 太原吾悦广场公开商户补充",
              url: "https://search.test/restaurant-context",
              snippet:
                "太原吾悦广场毛血旺餐厅菜单、价格、营业状态、评价与外卖公开商户补充，仍需以地图来源交叉核验。",
            },
          ],
          note: null,
        };
      },
      controlledWebFetchFn: async (sources) => ({
        attempted: true,
        ok: true,
        provider: "mock-controlled-web-evidence",
        results: controlledSourceResults(sources),
        evidence: {
          schemaVersion: "nanowork.controlled-web-evidence/1",
          requested: sources.length,
          fetched: sources.length + 1,
          failures: [],
          externalCall: true,
          ssrfProtected: true,
          redirectsRevalidated: true,
          responseBytesStored: false,
        },
      }),
      locationIntelligenceFn: async (value, options = {}) => {
        mapCalls.push({ idx, value, options });
        return collectLocationIntelligence(value, {
          ...options,
          isochroneProvider: deterministicIsochroneProvider,
          fetchImpl: mapFetch,
          timeoutMs: 100,
        });
      },
      generateFn: async (args) => {
        generationCalls.push({ idx, args });
        return {
          text: JSON.stringify(fixture),
          mode: "api",
          model: "yunwu-location-test-model",
          usage: { inputTokens: 13, outputTokens: 29 },
        };
      },
    });

    assert.equal(
      output.employeeContract.valid,
      true,
      `员工${idx}应能完成隔离契约校验`,
    );
    const serializedWeb = JSON.stringify(output.web);
    const generation = generationCalls.at(-1);
    assert.match(
      generation.args.userMsg,
      /https:\/\/search\.test\/restaurant-context/u,
    );
    assert.match(serializedWeb, /https:\/\/search\.test\/restaurant-context/u);
    if ([101, 102].includes(idx)) {
      assert.match(
        generation.args.userMsg,
        /https:\/\/www\.openstreetmap\.org\/way\/7001/u,
      );
      assert.match(generation.args.userMsg, /OpenStreetMap定位·太原吾悦广场/u);
      assert.match(
        serializedWeb,
        /https:\/\/www\.openstreetmap\.org\/way\/7001/u,
      );
    } else {
      assert.doesNotMatch(
        generation.args.userMsg,
        /https:\/\/www\.openstreetmap\.org\/way\/7001/u,
      );
      assert.doesNotMatch(
        serializedWeb,
        /https:\/\/www\.openstreetmap\.org\/way\/7001/u,
      );
    }
  }

  assert.deepEqual(
    mapCalls.map((call) => call.idx),
    [101, 102],
  );
  const expectedLocationQuery = `${taskFor(101).title} ${taskFor(101).requirement}`;
  assert.deepEqual(
    mapCalls.map((call) => call.value),
    [expectedLocationQuery, expectedLocationQuery],
  );
  assert.equal(
    mapFetchCalls.length,
    4,
    "仅101/102各做一轮Nominatim+Overpass；其他岗位不得触发地图客户端",
  );
  const locationWebCalls = webCalls.filter((call) =>
    [101, 102].includes(call.idx),
  );
  assert.ok(
    locationWebCalls.filter((call) => call.idx === 101).length >= 4,
    "101必须按自己的地点/选址技能计划取证",
  );
  assert.ok(
    locationWebCalls.filter((call) => call.idx === 102).length >= 5,
    "102必须按自己的高德/平台/窄门/等时圈技能计划取证",
  );
  assert.equal(
    webCalls.filter((call) => call.idx === 103).length,
    1,
    "非地点岗位仍只执行原有通用检索",
  );
  assert.ok(
    locationWebCalls.every((call) => call.query.length <= 120),
    "地点通用检索query不得过长",
  );
  assert.ok(
    locationWebCalls.some((call) =>
      /官方\s+商场\s+餐饮\s+品牌\s+门店列表/u.test(call.query),
    ),
  );
  assert.ok(
    locationWebCalls.some(
      (call) => call.idx === 102 && /site:dianping\.com/u.test(call.query),
    ),
  );
  assert.ok(
    locationWebCalls.some(
      (call) => call.idx === 102 && /site:meituan\.com/u.test(call.query),
    ),
  );
  assert.ok(
    locationWebCalls.some(
      (call) => call.idx === 102 && /site:canyandata\.com/u.test(call.query),
    ),
  );
  assert.ok(
    locationWebCalls.some(
      (call) => call.idx === 102 && /高德地图\s+扫街榜/u.test(call.query),
    ),
  );
});

test("契约失败时仍把地图web证据挂到错误对象，供执行快照落库", async () => {
  const mapCalls = [];
  const employeeExecution = buildEmployeeExecutionProfile(101, {
    tenantId: 1,
    user: { id: 1, role: "boss", tenant_id: 1 },
  });
  const task = taskFor(101);
  let failure;
  try {
    await marshalWork(testMarshal, task, "boss", {
      employeeExecution,
      webSearchFn: async () => ({
        attempted: true,
        ok: true,
        provider: "mock-search",
        results: [
          {
            title: "毛血旺 太原吾悦广场公开商户补充",
            url: "https://search.test/restaurant-context",
            snippet:
              "太原吾悦广场毛血旺餐厅菜单、价格、营业状态、评价与外卖公开商户补充。",
          },
        ],
      }),
      controlledWebFetchFn: async (sources) => ({
        attempted: true,
        ok: true,
        provider: "mock-controlled-web-evidence",
        results: controlledSourceResults(sources),
        evidence: {
          schemaVersion: "nanowork.controlled-web-evidence/1",
          requested: sources.length,
          fetched: sources.length + 1,
          failures: [],
          externalCall: true,
          ssrfProtected: true,
          redirectsRevalidated: true,
          responseBytesStored: false,
        },
      }),
      locationIntelligenceFn: async (value, options = {}) => {
        mapCalls.push(value);
        return collectLocationIntelligence(value, {
          ...options,
          isochroneProvider: deterministicIsochroneProvider,
          fetchImpl: mapFetchFixture([]),
          timeoutMs: 100,
        });
      },
      generateFn: async () => ({
        text: '{"contract_id":"invalid-location-contract"}',
        mode: "api",
        model: "yunwu-location-test-model",
        usage: { inputTokens: 19, outputTokens: 7 },
      }),
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure, "非法契约候选必须失败，不得模板化掩盖契约错误");
  assert.equal(failure.code, "RESTAURANT_OUTPUT_CONTRACT_INVALID");
  assert.deepEqual(mapCalls, [`${task.title} ${task.requirement}`]);
  assert.ok(failure.web, "契约失败仍须保留web证据");
  assert.match(
    JSON.stringify(failure.web),
    /https:\/\/www\.openstreetmap\.org\/way\/7001/u,
  );
  assert.match(JSON.stringify(failure.web), /OpenStreetMap定位·太原吾悦广场/u);
  assert.match(
    JSON.stringify(failure.web),
    /https:\/\/search\.test\/restaurant-context/u,
  );
});

test("后台派活契约失败仍将地图来源写入agent_tasks.employee_web_snapshot", async () => {
  const tenantId = 1;
  const username = `location-intelligence-boss-${process.pid}`;
  q.run(
    `INSERT INTO tenants(id,name,status,plan,credits)
     VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status='已开通',credits=100000`,
    tenantId,
    "地图测试餐饮企业",
    "已开通",
    "标准版",
    100000,
  );
  const userId = Number(
    q.run(
      `INSERT INTO users(username,password_hash,name,role,status,tenant_id,credits)
     VALUES(?,?,?,?,?,?,?)`,
      username,
      "x",
      "地图测试老板",
      "boss",
      "启用",
      tenantId,
      100000,
    ).lastInsertRowid,
  );

  const mapFetchCalls = [];
  const app = express();
  app.locals.employeeEstimateCallCredits = () => 1;
  app.locals.employeeWebSearch = async () => ({
    attempted: true,
    ok: true,
    provider: "mock-search",
    results: [
      {
        title: "毛血旺 太原吾悦广场公开商户补充",
        url: "https://search.test/restaurant-context",
        snippet:
          "太原吾悦广场毛血旺餐厅菜单、价格、营业状态、评价与外卖公开商户补充。",
      },
    ],
  });
  app.locals.employeeAgenticWebResearch = async () => ({
    attempted: true,
    ok: true,
    provider: "mock-agentic-claude",
    results: Array.from({ length: 5 }, (_unused, index) => ({
      title: `太原吾悦广场毛血旺餐厅隔离来源${index + 1}`,
      url: `https://agentic.test/location-${index + 1}`,
      snippet: `太原吾悦广场毛血旺餐厅菜单、价格、营业状态与评价隔离公开来源-${index + 1}`,
      publishedAt: "2026-08-08",
    })),
    evidence: {
      schemaVersion: "nanowork.agentic-web-research/1",
      executionMode: "isolated_claude_cli",
      toolCalls: 5,
      toolAttempts: 5,
      toolResults: Array.from({ length: 5 }, (_unused, index) => ({
        toolUseId: `后台-web-search-${index + 1}`,
        success: true,
        isError: false,
        permissionDenied: false,
        urlCount: 1,
      })),
      qualityGate: {
        requiredSearches: 5,
        requiredSources: 5,
        observedSearches: 5,
        observedSuccessfulToolResults: 5,
        observedToolResultUrls: 5,
        observedSources: 5,
        passed: true,
      },
      queries: Array.from(
        { length: 5 },
        (_unused, index) => `后台隔离查询-${index + 1}`,
      ),
      facts: [
        {
          claim: "隔离测试公开事实",
          sourceUrls: ["https://agentic.test/location-1"],
        },
      ],
      gaps: [],
      usage: { inputTokens: 101, outputTokens: 202, cacheReadInputTokens: 3 },
      costUsd: 0.17,
      externalCall: true,
      localLoginInherited: false,
    },
  });
  app.locals.employeeControlledWebFetch = async (sources) => ({
    attempted: true,
    ok: true,
    provider: "mock-controlled-web-evidence",
    results: [
      {
        ...DIRECT_RESTAURANT_SOURCE,
        body: "后台受控网页正文完整段落：太原吾悦广场毛血旺餐厅商户正文包含菜单、价格、营业时间、评价与外卖渠道信息，仅作隔离岗位核验，不能作为真实业务采纳依据；缺失项按核验日期标注并安排现场复核。",
      },
      ...sources.map((source) => ({
        ...source,
        body: `后台受控网页正文补充段落：${source.title}页面正文已读取并净化，太原吾悦广场毛血旺菜单、价格、营业状态和评价仅作隔离验证；未知字段保留现场复核动作。`,
      })),
    ],
    evidence: {
      schemaVersion: "nanowork.controlled-web-evidence/1",
      requested: sources.length,
      fetched: sources.length + 1,
      failures: [],
      externalCall: true,
      ssrfProtected: true,
      redirectsRevalidated: true,
      responseBytesStored: false,
    },
  });
  app.locals.employeeLocationIntelligence = async (value, options = {}) =>
    collectLocationIntelligence(value, {
      ...options,
      isochroneProvider: deterministicIsochroneProvider,
      fetchImpl: mapFetchFixture(mapFetchCalls),
      timeoutMs: 100,
    });
  app.locals.employeeGenerate = async () => ({
    text: '{"contract_id":"invalid-location-contract"}',
    mode: "api",
    model: "offline-location-route-test",
    usage: { inputTokens: 19, outputTokens: 7 },
  });
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.user = {
      id: userId,
      name: "地图测试老板",
      role: "boss",
      tenant_id: tenantId,
    };
    runWithTenant(tenantId, () => next());
  });
  app.use("/marshals", marshalRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let taskId;
  try {
    const response = await fetch(`${base}/marshals/1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        specialistId: 1,
        title: "毛血旺 太原吾悦广场",
        type: "分析",
        requirement: "基于地图来源完成隔离验证，不执行外部动作。",
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.async, true);
    taskId = Number(payload.taskId);
    assert.ok(taskId > 0);

    let row = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      row = runWithTenant(tenantId, () =>
        q.get(
          "SELECT status,employee_web_snapshot FROM agent_tasks WHERE tenant_id=? AND id=?",
          tenantId,
          taskId,
        ),
      );
      if (row?.status === "失败") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(row?.status, "失败");
    const snapshot = JSON.parse(row.employee_web_snapshot);
    assert.equal(snapshot.kind, "restaurant_employee_execution_evidence");
    assert.equal(snapshot.failure.code, "RESTAURANT_OUTPUT_CONTRACT_INVALID");
    assert.match(
      JSON.stringify(snapshot.web),
      /https:\/\/www\.openstreetmap\.org\/way\/7001/u,
    );
    assert.match(
      JSON.stringify(snapshot.web),
      /OpenStreetMap定位·太原吾悦广场/u,
    );
    assert.match(
      JSON.stringify(snapshot.web),
      /https:\/\/search\.test\/restaurant-context/u,
    );
    assert.match(
      JSON.stringify(snapshot.web),
      /https:\/\/agentic\.test\/location-1/u,
    );
    assert.match(JSON.stringify(snapshot.web), /后台受控网页正文完整段落/u);
    assert.deepEqual(
      snapshot.web.channels.map((channel) => channel.kind),
      [
        "controlled_web_fetch",
        "agentic_web_research",
        "web_search",
        "location_intelligence",
      ],
    );
    assert.equal(snapshot.web.channels[1].evidence.qualityGate.passed, true);
    assert.equal(snapshot.web.channels[1].evidence.toolAttempts, 5);
    assert.equal(snapshot.web.channels[1].evidence.toolCalls, 5);
    assert.equal(snapshot.web.channels[1].evidence.toolResults.length, 5);
    assert.equal(
      snapshot.web.channels[0].evidence.fetched,
      snapshot.web.channels[0].evidence.requested + 1,
    );
    assert.equal(mapFetchCalls.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (taskId) {
      runWithTenant(tenantId, () =>
        q.run(
          "DELETE FROM agent_tasks WHERE tenant_id=? AND id=?",
          tenantId,
          taskId,
        ),
      );
    }
    runWithTenant(tenantId, () =>
      q.run("DELETE FROM users WHERE id=?", userId),
    );
  }
});
