/**
 * 商圈结构化事实（resolveTradeAreaFacts）隔离测试：高德 mock fetch、OSM 证据注入，零外网。
 * 覆盖：事实结构与逐字段 provenance、缺字段进 missingCriticalFacts、高德失败/未配置回落 OSM、
 * 交付报告“数据来源与时效”补写、以及 marshalWork 只对选址岗位触发并把事实隔离进证据区。
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTempDbSafely } from "./helpers/temp-db.mjs";

const DB_PATH = path.join(os.tmpdir(), `nanowork-trade-area-facts-${process.pid}.db`);
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  fs.rmSync(file, { force: true });
}
process.env.NANOWORK_DB = DB_PATH;
process.env.NANOWORK_EMPLOYEE_OUTPUT_STYLE = "contract_json";
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
const originalAmapKey = process.env.AMAP_WEB_KEY;
process.env.AMAP_WEB_KEY = "";

const { initSchema, migrateV2, runWithTenant } = await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { buildEmployeeExecutionProfile } = await import("../src/employee-workbench.js");
const { marshalWork, TRADE_AREA_EMPLOYEE_IDX, isTradeAreaEmployee, tradeAreaCategoryKeyword } =
  await import("../src/engines/ai.js");
const {
  collectLocationIntelligence,
  ensureTradeAreaProvenanceSection,
  extractTradeAreaAddress,
  hasTradeAreaProvenanceSection,
  renderTradeAreaProvenanceMarkdown,
  resolveTradeAreaFacts,
  tradeAreaFactsPromptSummary,
} = await import("../src/engines/location-intelligence.js");
const { createAmapClient, createMemoryGeoPoiCache, resetAmapRuntimeState } =
  await import("../src/engines/amap.js");
const { restaurantEmployeeHardDeliveryDecision } =
  await import("../src/engines/restaurant-output-contract.js");

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

const TEST_KEY = "amap-trade-area-test-key-must-never-leak";
const NOW = () => new Date("2026-09-03T02:00:00Z");

function jsonResponse(body) {
  return { ok: true, status: 200, async json() { return body; } };
}

function restaurantPoi(index, { cost = null, rating = null, type = "餐饮服务;中餐厅;四川菜", typecode = "050102", name } = {}) {
  return {
    id: `B${String(index).padStart(4, "0")}`,
    name: name || `太原餐厅${index}`,
    type,
    typecode,
    address: `太原市小店区测试路${index}号`,
    location: `112.55${index % 10},37.81${index % 10}`,
    distance: String(80 * index),
    tel: [],
    biz_ext: { rating: rating == null ? [] : String(rating), cost: cost == null ? [] : String(cost) },
  };
}

const FACILITY_COUNTS = { "060100": 3, "120201": 12, "120300": 20, "150500": 2, "141200": 4, "090100": 1, "150700": 9 };

/** 一套完整的高德 mock：地理编码 + 三个半径的餐饮 POI + 配套类型。 */
function amapFixture({ withCost = true, geocodeStatus = "1", geocodeInfocode = "10000" } = {}) {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(url.searchParams.get("key"), TEST_KEY);
    if (url.pathname === "/v3/geocode/geo") {
      if (geocodeStatus !== "1") {
        return jsonResponse({ status: "0", info: "DAILY_QUERY_OVER_LIMIT", infocode: geocodeInfocode });
      }
      return jsonResponse({
        status: "1",
        infocode: "10000",
        geocodes: [
          {
            formatted_address: "山西省太原市小店区吾悦广场",
            province: "山西省",
            city: "太原市",
            district: "小店区",
            adcode: "140105",
            citycode: "0351",
            location: "112.550000,37.810000",
            level: "兴趣点",
          },
        ],
      });
    }
    if (url.pathname === "/v3/place/around") {
      const types = url.searchParams.get("types");
      const radius = Number(url.searchParams.get("radius"));
      if (types === "050000") {
        const total = radius === 500 ? 4 : radius === 1000 ? 9 : 14;
        const pois = Array.from({ length: total }, (_, i) => {
          const index = i + 1;
          if (index % 3 === 0) {
            return restaurantPoi(index, {
              type: "餐饮服务;中餐厅;火锅店",
              typecode: "050117",
              name: `太原火锅${index}`,
              cost: withCost ? 60 + index * 5 : null,
              rating: withCost ? 4 + (index % 10) / 10 : null,
            });
          }
          return restaurantPoi(index, { cost: withCost && index % 2 === 0 ? 30 + index * 4 : null });
        });
        return jsonResponse({ status: "1", infocode: "10000", count: String(total), pois });
      }
      const count = FACILITY_COUNTS[types] ?? 0;
      return jsonResponse({
        status: "1",
        infocode: "10000",
        count: String(count),
        pois: Array.from({ length: Math.min(count, 25) }, (_, i) => ({
          id: `F${types}${i}`,
          name: `${types}设施${i}`,
          type: "配套",
          typecode: types,
          location: "112.551,37.811",
          distance: String(100 + i),
        })),
      });
    }
    throw new Error(`unexpected amap URL ${url.pathname}`);
  };
  return { calls, fetchImpl };
}

function osmEvidenceFixture({ withIsochrones = true } = {}) {
  return {
    schemaVersion: "nanowork.location-intelligence/2",
    query: "太原吾悦广场",
    center: { displayName: "太原市小店区吾悦广场", lat: 37.81, lon: 112.55 },
    radiusMeters: 1500,
    namedPoiCount: 3,
    counts: { 餐饮: 1, 商业: 1, 交通: 1 },
    poiSource: "Overpass",
    isochroneRequired: true,
    isochroneComplete: withIsochrones,
    isochroneProvider: withIsochrones ? "mock-routing-provider" : null,
    isochroneSource: withIsochrones ? "https://valhalla1.openstreetmap.de/isochrone" : null,
    isochroneModes: ["walking", "cycling", "driving", "transit"],
    isochroneMinutes: [10, 20, 30],
    isochrones: withIsochrones
      ? ["walking", "cycling", "driving", "transit"].flatMap((mode) =>
          [10, 20, 30].map((minutes) => ({ mode, minutes, polygon: { type: "Polygon", coordinates: [[]] } })),
        )
      : [],
    isochroneError: withIsochrones ? null : "walking等时圈缺少10分钟边界",
    fetchedAt: "2026-09-03T01:59:00.000Z",
    externalCall: true,
  };
}

function assertProvenance(node, provider) {
  assert.ok(node, "事实节点缺失");
  assert.equal(node.provenance.provider, provider);
  assert.ok(node.provenance.endpoint, "provenance.endpoint 必填");
  assert.ok(node.provenance.fetchedAt, "provenance.fetchedAt 必填");
}

beforeEach(() => {
  resetAmapRuntimeState();
  process.env.AMAP_WEB_KEY = "";
});

test("extractTradeAreaAddress 只对可地理编码的场所返回地址与城市（城市 provenance=regex）", () => {
  const parsed = extractTradeAreaAddress(
    "毛血旺 太原吾悦广场 基于可追溯地图来源核验门店周边餐饮与商业分布；只生成内部交付，不执行外部动作。",
  );
  assert.equal(parsed.addressText, "太原吾悦广场");
  assert.equal(parsed.city, "太原");
  assert.equal(parsed.provenance.provider, "regex");
  assert.equal(extractTradeAreaAddress("帮我写一份下周的菜单工程分析"), null);
  assert.equal(extractTradeAreaAddress(""), null);
  assert.deepEqual([...TRADE_AREA_EMPLOYEE_IDX], [101, 102, 104]);
  assert.equal(isTradeAreaEmployee(104), true);
  assert.equal(isTradeAreaEmployee(103), false);
  assert.equal(tradeAreaCategoryKeyword("太原吾悦广场开一家火锅店"), "火锅");
  assert.equal(tradeAreaCategoryKeyword("太原吾悦广场选址"), null);
});

test("高德可用：事实结构完整、逐字段 provenance=amap、分布与 Top10 同品类、配套计数、等时圈补充自 OSM", async () => {
  process.env.AMAP_WEB_KEY = TEST_KEY;
  const { calls, fetchImpl } = amapFixture({ withCost: true });
  const client = createAmapClient({ fetchImpl, cache: createMemoryGeoPoiCache(), now: NOW });
  let osmFallbackCalls = 0;
  const facts = await resolveTradeAreaFacts({
    addressText: "太原吾悦广场",
    city: "太原",
    categoryKeyword: "火锅",
    amapClient: client,
    osmFallback: async () => {
      osmFallbackCalls += 1;
      return osmEvidenceFixture();
    },
    now: NOW,
  });

  assert.equal(facts.schemaVersion, "nanowork.trade-area-facts/1");
  assert.equal(facts.ok, true);
  assert.equal(facts.provider, "amap");
  assert.deepEqual(facts.input.radii, [500, 1000, 1500]);
  assert.equal(facts.amap.configured, true);
  assert.equal(facts.amap.ok, true);
  assert.equal(facts.amap.blocked, false);
  assert.equal(osmFallbackCalls, 1, "等时圈补充复用同一 OSM 结果，只取一次");

  assertProvenance(facts.center, "amap");
  assert.equal(facts.center.provenance.endpoint, "/v3/geocode/geo");
  assert.deepEqual(
    { lng: facts.center.value.lng, lat: facts.center.value.lat, adcode: facts.center.value.adcode },
    { lng: 112.55, lat: 37.81, adcode: "140105" },
  );

  assert.equal(facts.competitors.byRadius.length, 3);
  assert.deepEqual(facts.competitors.byRadius.map((item) => item.radius), [500, 1000, 1500]);
  assert.deepEqual(facts.competitors.byRadius.map((item) => item.value.count), [4, 9, 14]);
  for (const item of facts.competitors.byRadius) {
    assertProvenance(item, "amap");
    assert.equal(item.provenance.endpoint, "/v3/place/around");
    assert.ok(item.value.byCategory["中餐厅"] > 0, "按品类（type 第二段）分布");
    assert.equal(item.value.truncated, false);
  }
  assert.equal(facts.competitors.byRadius[2].value.sameCategoryCount, 4, "1500米内火锅店 4 家");

  assertProvenance(facts.topCompetitors, "amap");
  assert.equal(facts.topCompetitors.radius, 1500);
  assert.equal(facts.topCompetitors.matchedCategoryKeyword, true);
  assert.equal(facts.topCompetitors.value.length, 4);
  assert.ok(facts.topCompetitors.value.every((item) => /火锅/u.test(item.name)));
  assert.deepEqual(Object.keys(facts.topCompetitors.value[0]).sort(), ["address", "cost", "distance", "name", "rating", "type"]);
  const distances = facts.topCompetitors.value.map((item) => item.distance);
  assert.deepEqual(distances, [...distances].sort((a, b) => a - b), "按距离升序");

  assertProvenance(facts.priceDistribution, "amap");
  assert.ok(facts.priceDistribution.value.sampleSize >= 4);
  assert.ok(facts.priceDistribution.value.median > 0);
  assert.ok(Object.keys(facts.priceDistribution.value.buckets).includes("60-100元"));
  assertProvenance(facts.ratingDistribution, "amap");
  assert.equal(facts.ratingDistribution.value.sampleSize, 4);

  assertProvenance(facts.facilities, "amap");
  assert.equal(facts.facilities.radius, 1000);
  assert.deepEqual(facts.facilities.value, { 商场: 3, 写字楼: 12, 住宅区: 20, 地铁站: 2, 学校: 4, 医院: 1, 公交站: 9 });

  assertProvenance(facts.isochrones, "osm");
  assert.deepEqual(facts.isochrones.value.modes, ["walking", "cycling", "driving", "transit"]);
  assert.equal(facts.isochrones.value.zones.length, 12);

  assert.deepEqual(facts.missingCriticalFacts, [], "高德字段齐全时不应有缺失项");
  assert.ok(facts.sources.some((source) => source.provider === "amap" && source.endpoint === "/v3/geocode/geo"));
  assert.ok(facts.sources.some((source) => source.provider === "osm"));
  assert.equal(calls.filter((url) => url.pathname === "/v3/geocode/geo").length, 1);
  assert.equal(calls.filter((url) => url.pathname === "/v3/place/around" && url.searchParams.get("types") === "050000").length, 3);
  assert.equal(calls.filter((url) => url.pathname === "/v3/place/around" && url.searchParams.get("types") !== "050000").length, 7);
  assert.doesNotMatch(JSON.stringify(facts), new RegExp(TEST_KEY, "u"), "事实快照不得泄露密钥");

  const summary = tradeAreaFactsPromptSummary(facts);
  assert.ok(summary.length <= 6000 + 8);
  assert.match(summary, /"provider":"amap"/u);
  assert.doesNotMatch(summary, /"attempts"/u);
});

test("高德未提供人均/评分时不编造：写“高德未提供”并进入 missingCriticalFacts", async () => {
  process.env.AMAP_WEB_KEY = TEST_KEY;
  const { fetchImpl } = amapFixture({ withCost: false });
  const facts = await resolveTradeAreaFacts({
    addressText: "太原吾悦广场",
    city: "太原",
    amapClient: createAmapClient({ fetchImpl, cache: false, now: NOW }),
    osmEvidence: osmEvidenceFixture({ withIsochrones: false }),
    now: NOW,
  });
  assert.equal(facts.provider, "amap");
  assert.equal(facts.priceDistribution.value, null);
  assert.match(facts.priceDistribution.note, /高德未提供人均/u);
  assert.equal(facts.ratingDistribution.value, null);
  assert.equal(facts.isochrones, null);
  const fields = facts.missingCriticalFacts.map((item) => item.field);
  assert.deepEqual(fields.sort(), ["isochrones", "priceDistribution", "ratingDistribution"]);
  assert.match(facts.missingCriticalFacts.find((item) => item.field === "isochrones").reason, /walking等时圈缺少10分钟边界/u);
  assert.equal(facts.topCompetitors.matchedCategoryKeyword, false, "无品类关键词时 Top10 取全部餐饮");
  assert.equal(facts.topCompetitors.value.length, 10);
});

test("高德未配置：不发起任何高德请求，回落 OSM 证据，provider=osm 且缺失项写明原因", async () => {
  let fetchCalls = 0;
  const facts = await resolveTradeAreaFacts({
    addressText: "太原吾悦广场",
    city: "太原",
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not call amap");
    },
    cache: false,
    osmEvidence: osmEvidenceFixture(),
    now: NOW,
  });
  assert.equal(fetchCalls, 0);
  assert.equal(facts.ok, true);
  assert.equal(facts.provider, "osm");
  assert.equal(facts.amap.configured, false);
  assert.equal(facts.amap.attempted, false);
  assert.match(facts.amap.error.message, /AMAP_WEB_KEY 未配置/u);
  assertProvenance(facts.center, "osm");
  assert.equal(facts.center.value.formattedAddress, "太原市小店区吾悦广场");
  assert.equal(facts.competitors.byRadius[0].radius, 1500);
  assert.equal(facts.competitors.byRadius[0].value.count, 1);
  assert.equal(facts.competitors.byRadius[0].provenance.provider, "osm");
  assert.match(facts.competitors.byRadius[0].provenance.endpoint, /overpass/u);
  assert.equal(facts.facilities.value["商场"], 1);
  assert.equal(facts.facilities.value["公交/地铁站"], 1);
  assertProvenance(facts.isochrones, "osm");
  const missing = Object.fromEntries(facts.missingCriticalFacts.map((item) => [item.field, item.reason]));
  assert.match(missing.priceDistribution, /高德地图未配置/u);
  assert.match(missing.priceDistribution, /未获取/u);
  assert.match(missing.ratingDistribution, /OSM 不提供评分/u);
  assert.match(missing.topCompetitors, /竞品名录未获取/u);
  assert.match(missing["competitors.byCategory"], /品类细分/u);
  assert.equal(facts.priceDistribution, null);
});

test("高德日配额超限（10003）：amap.blocked=true，自动回落 OSM，不抛错", async () => {
  process.env.AMAP_WEB_KEY = TEST_KEY;
  const { calls, fetchImpl } = amapFixture({ geocodeStatus: "0", geocodeInfocode: "10003" });
  const facts = await resolveTradeAreaFacts({
    addressText: "太原吾悦广场",
    city: "太原",
    amapClient: createAmapClient({ fetchImpl, cache: false, now: NOW }),
    osmFallback: async () => osmEvidenceFixture(),
    now: NOW,
  });
  assert.equal(calls.length, 1, "地理编码失败后不再继续周边搜索");
  assert.equal(facts.provider, "osm");
  assert.equal(facts.amap.attempted, true);
  assert.equal(facts.amap.ok, false);
  assert.equal(facts.amap.blocked, true);
  assert.equal(facts.amap.error.infocode, "10003");
  assert.equal(facts.amap.error.quotaExceeded, true);
  assert.match(facts.missingCriticalFacts.find((item) => item.field === "priceDistribution").reason, /高德未命中或调用失败/u);
  assert.doesNotMatch(JSON.stringify(facts), new RegExp(TEST_KEY, "u"));
});

test("高德与 OSM 均不可用：ok=false，全部关键事实进入 missingCriticalFacts 并说明原因", async () => {
  const facts = await resolveTradeAreaFacts({
    addressText: "太原吾悦广场",
    city: "太原",
    fetchImpl: async () => { throw new Error("no network"); },
    cache: false,
    osmFallback: async () => { throw new Error("overpass down"); },
    now: NOW,
  });
  assert.equal(facts.ok, false);
  assert.equal(facts.provider, null);
  assert.equal(facts.center, null);
  const fields = facts.missingCriticalFacts.map((item) => item.field).sort();
  assert.deepEqual(fields, ["center", "competitors", "facilities", "isochrones", "priceDistribution", "ratingDistribution", "topCompetitors"]);
  assert.ok(facts.missingCriticalFacts.every((item) => item.reason.length > 0));
  assert.ok(facts.attempts.some((item) => item.step === "osm_fallback" && item.ok === false));

  const noAddress = await resolveTradeAreaFacts({ addressText: "", now: NOW });
  assert.equal(noAddress.ok, false);
  assert.match(noAddress.missingCriticalFacts[0].reason, /未识别到可地理编码的地址/u);
});

test("“数据来源与时效”一节：按 provider 诚实措辞、未获取项逐条标注、幂等追加且通过硬交付门", async () => {
  process.env.AMAP_WEB_KEY = TEST_KEY;
  const { fetchImpl } = amapFixture({ withCost: false });
  const amapFacts = await resolveTradeAreaFacts({
    addressText: "太原吾悦广场",
    city: "太原",
    amapClient: createAmapClient({ fetchImpl, cache: false, now: NOW }),
    osmEvidence: osmEvidenceFixture(),
    now: NOW,
  });
  const amapSection = renderTradeAreaProvenanceMarkdown(amapFacts);
  assert.match(amapSection, /^## 数据来源与时效/mu);
  assert.match(amapSection, /高德地图 Web 服务 API（\/v3\/geocode\/geo）/u);
  assert.match(amapSection, /2026-09-03 02:00:00Z/u);
  assert.match(amapSection, /人均消费分布 \| — \| — \| 未获取：高德未提供人均/u);
  assert.match(amapSection, /由高德地图 Web 服务 API 实时抓取/u);
  assert.match(amapSection, /高德通道状态：已调用成功/u);

  process.env.AMAP_WEB_KEY = "";
  const osmFacts = await resolveTradeAreaFacts({
    addressText: "太原吾悦广场",
    city: "太原",
    fetchImpl: async () => { throw new Error("no"); },
    cache: false,
    osmEvidence: osmEvidenceFixture(),
    now: NOW,
  });
  const osmSection = renderTradeAreaProvenanceMarkdown(osmFacts);
  assert.match(osmSection, /本报告未接入高德实时数据/u);
  assert.match(osmSection, /仅供参考/u);
  assert.match(osmSection, /高德通道状态：未配置/u);
  assert.match(osmSection, /OpenStreetMap/u);

  const report = "# 太原吾悦广场商圈画像\n\n正文……\n\n## 下一步建议\n1. a\n2. b\n3. c\n";
  assert.equal(hasTradeAreaProvenanceSection(report), false);
  const appended = ensureTradeAreaProvenanceSection(report, osmFacts);
  assert.equal(hasTradeAreaProvenanceSection(appended), true);
  assert.match(appended, /## 下一步建议[\s\S]*## 数据来源与时效/u);
  assert.equal(ensureTradeAreaProvenanceSection(appended, osmFacts), appended, "已有章节不重复追加");
  assert.equal(ensureTradeAreaProvenanceSection("# 已含\n\n### 数据来源与时效\n表", osmFacts), "# 已含\n\n### 数据来源与时效\n表");

  // 追加的章节不得触发“无来源快照却断言公开事实”“补造URL”等硬交付门
  for (const section of [amapSection, osmSection]) {
    const decision = restaurantEmployeeHardDeliveryDecision({
      text: `# 报告\n\n${"正文".repeat(120)}\n\n${section}`,
      mode: "api",
      model: "yunwu-trade-area-test-model",
      usage: { inputTokens: 10, outputTokens: 20 },
      task: { title: "毛血旺 太原吾悦广场" },
      allowedSources: [],
    });
    assert.deepEqual(decision.errors, [], "数据来源与时效章节不得被硬交付门拒绝");
  }
});

// ---------------------------------------------------------------------------
// marshalWork 接线
// ---------------------------------------------------------------------------

const testMarshal = {
  code: "M-01",
  name: "市场与选址分部",
  title: "内部调度容器",
  duty: "仅负责调度",
  skills: "",
  prompt: "",
  kb_deps: "",
};
const DIRECT_RESTAURANT_SOURCE = Object.freeze({
  title: "大众点评·毛血旺 太原吾悦广场商户页面",
  url: "https://www.dianping.com/shop/trade-area-facts-maoxuewang",
  snippet: "太原吾悦广场毛血旺餐厅菜单、菜品、价格、营业状态、评价与外卖公开商户正文。",
  body: "受控商户正文核验记录：太原吾悦广场毛血旺餐厅菜单、菜品价格、营业时间、堂食与外卖渠道、评价主题和门店状态均可回看，未知字段保留证伪动作，不把推测写成事实；缺失项按核验日期标注并安排现场复核。",
});

function mapFetchFixture(calls) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.hostname === "nominatim.openstreetmap.org") {
      return jsonResponse([
        {
          osm_type: "way",
          osm_id: 7001,
          lat: "37.810000",
          lon: "112.550000",
          display_name: "太原市小店区吾悦广场",
          address: { city: "太原市", suburb: "小店区" },
        },
      ]);
    }
    if (url.hostname === "overpass-api.de") {
      return jsonResponse({
        elements: [
          { type: "node", id: 7101, lat: 37.8104, lon: 112.5504, tags: { name: "吾悦广场毛血旺店", amenity: "restaurant" } },
          { type: "way", id: 7102, center: { lat: 37.811, lon: 112.551 }, tags: { name: "太原吾悦广场", shop: "mall" } },
        ],
      });
    }
    throw new Error(`unexpected map URL: ${url}`);
  };
}

function deterministicIsochroneProvider(request = {}) {
  const modes = request.modes?.length ? request.modes : ["walking", "cycling", "driving", "transit"];
  const minutes = request.minutes?.length ? request.minutes : [10, 20, 30];
  return {
    provider: "mock-routing-provider",
    source: "https://valhalla1.openstreetmap.de/isochrone",
    isochrones: modes.flatMap((mode) =>
      minutes.map((value) => ({
        mode,
        minutes: Number(value),
        polygon: { type: "Polygon", coordinates: [[[112.549, 37.809], [112.551, 37.809], [112.551, 37.811], [112.549, 37.811], [112.549, 37.809]]] },
        provider: "mock-routing-provider",
        source: `https://valhalla1.openstreetmap.de/isochrone/${mode}/${value}`,
      })),
    ),
  };
}

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

async function runEmployee(idx, { amapClient } = {}) {
  const employeeExecution = buildEmployeeExecutionProfile(idx, {
    tenantId: 1,
    user: { id: 1, role: "boss", tenant_id: 1 },
  });
  const task = {
    title: "毛血旺 太原吾悦广场",
    type: idx === 102 ? "商圈画像" : "分析",
    requirement: "基于可追溯地图来源核验门店周边餐饮与商业分布；只生成内部交付，不执行外部动作。",
  };
  const fixture = structuredClone(employeeExecution.outputContract.validFixture);
  fixture.decision_context.problem = `${task.title}：${fixture.decision_context.problem}`;
  fixture.decision_context.sources[0].source = `${DIRECT_RESTAURANT_SOURCE.title}｜${DIRECT_RESTAURANT_SOURCE.url}`;
  for (const item of Object.values(fixture.input_audit || {})) item.evidence_refs = [fixture.decision_context.sources[0].source];
  for (const item of Object.values(fixture.method_execution || {})) item.evidence_refs = [fixture.decision_context.sources[0].source];
  const mapFetchCalls = [];
  const generationCalls = [];
  const output = await runWithTenant(1, () =>
    marshalWork(testMarshal, task, "boss", {
      employeeExecution,
      ...(amapClient ? { amapClient } : {}),
      webSearchFn: async () => ({
        attempted: true,
        ok: true,
        provider: "mock-search",
        results: [
          {
            title: "毛血旺 太原吾悦广场公开商户补充",
            url: "https://search.test/restaurant-context",
            snippet: "太原吾悦广场毛血旺餐厅菜单、价格、营业状态、评价与外卖公开商户补充，仍需以地图来源交叉核验。",
          },
        ],
        note: null,
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
      locationIntelligenceFn: async (value, options = {}) =>
        collectLocationIntelligence(value, {
          ...options,
          isochroneProvider: deterministicIsochroneProvider,
          fetchImpl: mapFetchFixture(mapFetchCalls),
          timeoutMs: 100,
        }),
      generateFn: async (args) => {
        generationCalls.push(args);
        return {
          text: JSON.stringify(fixture),
          mode: "api",
          model: "yunwu-trade-area-test-model",
          usage: { inputTokens: 13, outputTokens: 29 },
        };
      },
    }),
  );
  return { output, generationCalls, mapFetchCalls };
}

test("marshalWork：选址岗位 102 用注入高德客户端产出事实，隔离进证据区，system 追加引用规则，报告含数据来源一节", async () => {
  process.env.AMAP_WEB_KEY = TEST_KEY;
  const { calls, fetchImpl } = amapFixture({ withCost: true });
  const amapClient = createAmapClient({ fetchImpl, cache: createMemoryGeoPoiCache(), now: NOW });
  const { output, generationCalls, mapFetchCalls } = await runEmployee(102, { amapClient });

  assert.equal(output.employeeContract.valid, true);
  assert.equal(mapFetchCalls.length, 2, "OSM 链仍只做一次 Nominatim + 一次 Overpass");
  assert.ok(calls.length >= 11, "高德：1 次地理编码 + 3 个半径 + 7 类配套");
  const facts = output.web.tradeAreaFacts;
  assert.ok(facts, "web 快照必须带 tradeAreaFacts 供落库");
  assert.equal(facts.provider, "amap");
  assert.equal(facts.input.addressText, "太原吾悦广场");
  assert.equal(facts.input.city, "太原");
  assert.equal(facts.input.categoryKeyword, "毛血旺");
  assert.equal(facts.isochrones.provenance.provider, "osm", "等时圈复用同一在途 OSM 结果");

  const generation = generationCalls.at(-1);
  assert.match(generation.system, /【商圈数据引用规则】/u);
  assert.match(generation.system, /标注来源（高德\/OSM\/公开检索）与抓取时间/u);
  assert.match(generation.system, /明确写“未获取”/u);
  assert.match(generation.userMsg, /《《《参考资料·商圈结构化事实（高德\/OSM）·开始》》》/u);
  assert.match(generation.userMsg, /"provider":"amap"/u);
  assert.match(generation.userMsg, /《《《参考资料·商圈结构化事实（高德\/OSM）·结束》》》/u);
  assert.doesNotMatch(generation.userMsg, new RegExp(TEST_KEY, "u"));
  assert.doesNotMatch(generation.system, new RegExp(TEST_KEY, "u"));

  // 证据区携带系统渲染的“数据来源与时效”段落并要求原样附上；正文本身不被系统改写
  assert.match(generation.userMsg, /【数据来源与时效·系统按本次真实调用生成，必须原样附在报告末尾/u);
  assert.match(generation.userMsg, /## 数据来源与时效[\s\S]*高德地图 Web 服务 API（\/v3\/geocode\/geo）/u);
  assert.match(generation.system, /报告末尾必须原样附上证据区提供的「## 数据来源与时效」段落/u);
  const provenance = output.employeeContract.tradeAreaProvenance;
  assert.equal(provenance.provider, "amap");
  assert.equal(provenance.amapConfigured, true);
  assert.equal(provenance.sectionPresent, false, "mock 模型未附章节 → 记录缺失");
  assert.match(provenance.markdown, /^## 数据来源与时效/u);
  assert.ok(output.employeeContract.warnings.some((item) => /缺少「数据来源与时效」/u.test(item)));
  assert.equal(output.employeeContract.artifacts.length, 1, "不得新增制品或改写主制品");
  assert.doesNotMatch(output.text, /## 数据来源与时效/u, "正文必须与供应商响应一致，系统不改写");
  assert.doesNotMatch(JSON.stringify(output.web), new RegExp(TEST_KEY, "u"));
});

test("marshalWork：高德未配置时 101 仍产出 OSM 回落事实并如实标注“未接入高德实时数据”；103 完全不触发", async () => {
  process.env.AMAP_WEB_KEY = "";
  const { output, generationCalls } = await runEmployee(101);
  const facts = output.web.tradeAreaFacts;
  assert.ok(facts);
  assert.equal(facts.provider, "osm");
  assert.equal(facts.amap.configured, false);
  assert.ok(facts.missingCriticalFacts.some((item) => item.field === "priceDistribution"));
  assert.match(generationCalls.at(-1).system, /【商圈数据引用规则】/u);
  assert.match(generationCalls.at(-1).userMsg, /"provider":"osm"/u);
  assert.match(generationCalls.at(-1).userMsg, /本报告未接入高德实时数据/u);
  assert.match(generationCalls.at(-1).userMsg, /高德通道状态：未配置/u);
  assert.equal(output.employeeContract.tradeAreaProvenance.provider, "osm");
  assert.equal(output.employeeContract.tradeAreaProvenance.amapConfigured, false);
  assert.match(output.employeeContract.tradeAreaProvenance.markdown, /本报告未接入高德实时数据/u);

  const other = await runEmployee(103);
  assert.equal(other.output.web.tradeAreaFacts, undefined, "非选址岗位不得触发商圈事实");
  assert.doesNotMatch(other.generationCalls.at(-1).system, /商圈数据引用规则/u);
  assert.doesNotMatch(other.generationCalls.at(-1).userMsg, /数据来源与时效/u);
  assert.equal(other.output.employeeContract.tradeAreaProvenance, undefined);
});

after(async () => {
  resetAmapRuntimeState();
  if (originalAmapKey === undefined) delete process.env.AMAP_WEB_KEY;
  else process.env.AMAP_WEB_KEY = originalAmapKey;
  await removeTempDbSafely(DB_PATH);
});
