import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectLocationIntelligence,
  extractTradeAreaAddress,
  hasExplicitLocationIsochroneRequest,
  locationQueryCandidates,
  normalizeLocationIntent,
  parseLocationDistanceRange,
  resolveTradeAreaFacts,
  tradeAreaFactsPromptSummary,
} from "../src/engines/location-intelligence.js";

const TASK_126_TITLE = "清凤时代城商圈竞品与流量勘察";
const TASK_126_REQUIREMENT =
  "清凤时代城商圈竞品与流量勘察\n\n【补充材料】\n①要做什么：实地或线上（高德/大众点评/美团外卖）勘察成都清凤时代城1楼底商周边1-3公里商圈，识别同类烘焙/甜品竞品（含面包店、蛋糕店、私房烘焙）的位置、客单价、月销量（或评分/热卖指数）、形态（现烤/预包装/连锁/独立），同时梳理商圈的流量结构（住宅密度、写字楼数、地铁口距离、社区客群年龄段）。②上下游衔接：无前置依赖；需将竞品画像和流量结构整理成《商圈竞品与流量报告》，供101（赵先机）判断细分赛道机会、104（李选址）做选址评分、106（吴盈亏）做收入假设、146（范外卖）评估外卖配送半径。③交付物：《清凤时代城1公里/3公里烘焙竞品清单》+《商圈流量结构简报》（含点位照片或截图）。④【输出标准】产出先用3句以内大白话讲清结论与建议（老板摘要），再给完整方案正文。专业词首次出现时用括号做一句话解释（如‘客单价’指平均每位顾客花的钱）。行动项要有负责人和时间（如：钱商圈，9/12前完成实地补拍）。竞品清单需覆盖至少8家店，每家标注名称、距离、客单、销量（或热度）、形态、营业时间；流量结构需给出住宅户数估算、写字楼白领数量（如‘天府三街写字楼群约2万人’）、地铁站距离与步行分钟数。";
const TASK_126_TEXT = `${TASK_126_TITLE} ${TASK_126_REQUIREMENT}`;

test("长竞品明细不会截掉配套与来源，摘要保持合法JSON且不修改原始事实", () => {
  const facts = {
    provider: "amap",
    center: { value: { address: "酒仙桥" } },
    topCompetitors: { value: Array.from({ length: 10 }, (_, i) => ({ name: `餐厅${i}`, address: "长地址".repeat(600) })) },
    facilities: { radius: 1500, value: { 商场: 10, 写字楼: 15, 住宅区: 8, 学校: 3 }, provenance: { provider: "amap", fetchedAt: "2026-09-15T09:00:00Z" } },
    missingCriticalFacts: [{ field: "footfall", reason: "没有实测客流" }],
  };
  const original = JSON.stringify(facts);
  const summary = tradeAreaFactsPromptSummary(facts);
  const parsed = JSON.parse(summary);
  assert.deepEqual(parsed.facilities, facts.facilities);
  assert.deepEqual(parsed.missingCriticalFacts, facts.missingCriticalFacts);
  assert.ok(parsed.summaryOmissions.length);
  assert.ok(summary.length <= 6000);
  assert.equal(JSON.stringify(facts), original);
});

test("测试员任务127/128：口语化酒仙桥周围能进入地图查询，不推定未提供的城市", () => {
  for (const scope of ["周围", "周边", "附近"]) {
    const text = `我要在酒仙桥${scope}开一家川菜店，请帮我选址`;
    const intent = normalizeLocationIntent(text);
    assert.deepEqual(intent.centerCandidates, ["酒仙桥"]);
    assert.equal(intent.city, null);
    assert.equal(extractTradeAreaAddress(text).addressText, "酒仙桥");
  }
  assert.equal(normalizeLocationIntent("我想在北京三里屯附近开一家餐厅").center, "北京三里屯");
  assert.deepEqual(locationQueryCandidates("帮我分析周围的餐饮客流，给出方案"), []);
  assert.deepEqual(locationQueryCandidates("我要开一家川菜店，请帮我选址"), []);
});

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
  };
}

test("任务126自然长句提取清凤时代城、1-3公里与地铁POI，不把地铁当中心或等时圈", () => {
  const intent = normalizeLocationIntent(TASK_126_TEXT);
  assert.equal(intent.city, "成都");
  assert.equal(intent.center, "成都清凤时代城");
  assert.deepEqual(intent.centerCandidates, ["成都清凤时代城", "清凤时代城"]);
  assert.deepEqual(intent.radiusRangeMeters, { min: 1000, max: 3000 });
  assert.deepEqual(intent.radiiMeters, [1000, 2000, 3000]);
  assert.equal(intent.radiusMeters, 3000);
  assert.deepEqual(intent.requestedFacilities, ["地铁站"]);
  assert.equal(intent.explicitIsochroneRequested, false);
  assert.ok(!intent.centerCandidates.includes("成都地铁站"));

  const parsed = extractTradeAreaAddress(TASK_126_TEXT);
  assert.equal(parsed.addressText, "成都清凤时代城");
  assert.deepEqual(parsed.radiiMeters, [1000, 2000, 3000]);
  assert.equal(parsed.explicitIsochroneRequested, false);
});

test("已有命名中心时只保留同实体别名，次要道路与示例地点不得成为回退", () => {
  const candidates = locationQueryCandidates(
    "成都地铁站、成都天府三街、成都清风时代城1楼底商周边1-3公里商圈、地铁站",
  );
  assert.deepEqual(candidates, ["成都清风时代城", "清风时代城"]);
  assert.ok(!candidates.includes("成都天府三街"));
  assert.ok(!candidates.includes("成都地铁站"));
  assert.deepEqual(locationQueryCandidates("成都地铁站"), []);
  assert.equal(extractTradeAreaAddress("太原吾悦广场").addressText, "太原吾悦广场");
});

test("任务126主中心未命中时必须失败，不能落到输出示例“天府三街”", async () => {
  const geocodeQueries = [];
  const result = await collectLocationIntelligence(TASK_126_TEXT, {
    timeoutMs: 100,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, "nominatim.openstreetmap.org");
      const query = url.searchParams.get("q");
      geocodeQueries.push(query);
      if (query?.includes("天府三街")) {
        return jsonResponse([
          {
            osm_type: "node",
            osm_id: 12609,
            lat: "30.5492412",
            lon: "104.0459526",
            display_name: "天府三街，成都市，四川省",
            address: { city: "成都市" },
          },
        ]);
      }
      return jsonResponse([]);
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.evidence.candidates, [
    "成都清凤时代城",
    "清凤时代城",
  ]);
  assert.deepEqual(geocodeQueries, ["成都清凤时代城", "清凤时代城"]);
  assert.ok(!geocodeQueries.some((query) => /天府三街|专业词|括号/u.test(query)));
});

test("距离解析只读明确米/公里，地铁站距离或步行分钟数不伪造等时圈", () => {
  assert.deepEqual(parseLocationDistanceRange("周边1-3公里商圈"), {
    explicit: true,
    minMeters: 1000,
    maxMeters: 3000,
    radiiMeters: [1000, 2000, 3000],
    matchedText: "1-3公里",
  });
  assert.deepEqual(parseLocationDistanceRange("方圆300-800米"), {
    explicit: true,
    minMeters: 300,
    maxMeters: 800,
    radiiMeters: [300, 800],
    matchedText: "300-800米",
  });
  assert.deepEqual(parseLocationDistanceRange("交付1公里/3公里竞品清单")?.radiiMeters, [
    1000,
    2000,
    3000,
  ]);
  assert.equal(parseLocationDistanceRange("步行15分钟"), null);
  assert.equal(hasExplicitLocationIsochroneRequest("地铁站距离与步行分钟数"), false);
  assert.equal(hasExplicitLocationIsochroneRequest("步行15分钟可达圈"), true);
  assert.equal(hasExplicitLocationIsochroneRequest("20分钟地铁可达范围"), true);
});

test("地图采用显式3公里最大范围并保留地铁站POI，未显式要求时不调等时圈", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname === "nominatim.openstreetmap.org") {
      assert.equal(url.searchParams.get("q"), "成都清凤时代城");
      return jsonResponse([
        {
          osm_type: "way",
          osm_id: 12601,
          lat: "30.552",
          lon: "104.066",
          display_name: "清凤时代城，成都市，四川省",
          address: { city: "成都市" },
        },
      ]);
    }
    if (url.hostname.includes("overpass")) {
      const query = url.searchParams.get("data");
      assert.match(query, /around:3000,30\.552,104\.066/u);
      assert.match(query, /\[railway=station\]\[station~"subway\|light_rail"\]/u);
      return jsonResponse({
        elements: [
          {
            type: "node",
            id: 12602,
            lat: 30.553,
            lon: 104.067,
            tags: {
              name: "天府三街地铁站",
              railway: "station",
              station: "subway",
            },
          },
          {
            type: "node",
            id: 12603,
            lat: 30.554,
            lon: 104.068,
            tags: { name: "清凤面包店", amenity: "restaurant" },
          },
        ],
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const result = await collectLocationIntelligence(TASK_126_TEXT, {
    fetchImpl,
    timeoutMs: 100,
  });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.query, "成都清凤时代城");
  assert.equal(result.evidence.radiusMeters, 3000);
  assert.deepEqual(result.evidence.requestedFacilities, ["地铁站"]);
  assert.equal(result.evidence.isochroneRequired, false);
  assert.equal(result.evidence.isochrones.length, 0);
  assert.match(result.results[0].snippet, /周边3000米/u);
  assert.match(result.results[1].title, /交通·天府三街地铁站/u);
  assert.equal(calls.length, 2);
});

test("高德只在正常响应但首候选无匹配时尝试下一个具体地标", async () => {
  const geocodeCalls = [];
  const source = {
    provider: "amap",
    endpoint: "/v3/geocode/geo",
    fetchedAt: "2026-09-09T00:00:00.000Z",
  };
  const amapClient = {
    configured: true,
    async geocode(address) {
      geocodeCalls.push(address);
      if (geocodeCalls.length === 1)
        return { data: null, source, note: "高德未匹配到该地址" };
      return {
        data: {
          lng: 104.066,
          lat: 30.552,
          adcode: "510107",
          formattedAddress: "四川省成都市武侯区清凤时代城",
          province: "四川省",
          city: "成都市",
          district: "武侯区",
          level: "兴趣点",
        },
        source,
      };
    },
    async searchAround() {
      return {
        data: {
          pois: [],
          count: 0,
          returned: 0,
          truncated: false,
          requestCount: 1,
        },
        source: { ...source, endpoint: "/v3/place/around" },
      };
    },
  };

  const facts = await resolveTradeAreaFacts({
    addressText: "成都清凤时代城",
    addressCandidates: ["成都清凤时代城", "清凤时代城"],
    city: "成都",
    radii: [1000, 2000, 3000],
    amapClient,
  });
  assert.deepEqual(geocodeCalls, ["成都清凤时代城", "清凤时代城"]);
  assert.equal(facts.amap.ok, true);
  assert.equal(facts.amap.requestCount, 12);
  assert.equal(facts.center.value.matchedAddressText, "清凤时代城");
  assert.deepEqual(
    facts.attempts
      .filter((attempt) => attempt.step === "amap_geocode")
      .map((attempt) => ({ candidate: attempt.candidate, ok: attempt.ok })),
    [
      { candidate: "成都清凤时代城", ok: false },
      { candidate: "清凤时代城", ok: true },
    ],
  );
});
