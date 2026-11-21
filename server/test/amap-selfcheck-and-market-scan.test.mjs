// PRD v2.2 FR-4.2 / FR-4.3：高德 QPS 节流、当日用量、三步自检；行情快查取 30 家并补相似品类。
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.NANOWORK_DB = path.join(os.tmpdir(), `nanowork-amap-selfcheck-${process.pid}.db`);
const TEST_KEY = "amap-selfcheck-test-key-never-leak";

const amap = await import("../src/engines/amap.js");
const { resolveTradeAreaFacts, collectLocationIntelligence } = await import("../src/engines/location-intelligence.js");

function json(body) {
  return { ok: true, status: 200, async json() { return body; } };
}

function poi(i, { name, type = "餐饮服务;中餐厅;火锅店", cost = 80 + i, rating = 4.2 } = {}) {
  return {
    id: `P${name || "x"}${i}`,
    name: name ? `${name}${i}` : `望京火锅${i}`,
    type,
    typecode: "050117",
    address: `望京街${i}号`,
    location: `116.48${String(i).padStart(2, "0")},39.99${String(i).padStart(2, "0")}`,
    distance: String(50 * i),
    biz_ext: { cost: String(cost), rating: String(rating) },
  };
}

function fixture({ fail = null } = {}) {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname + "?" + (url.searchParams.get("keywords") || ""));
    if (fail) return json({ status: "0", infocode: fail, info: "INVALID_USER_KEY" });
    if (url.pathname === "/v3/geocode/geo") {
      return json({ status: "1", infocode: "10000", geocodes: [{ location: "116.480700,39.996500", adcode: "110105", formatted_address: "北京市朝阳区望京SOHO", city: "北京市", district: "朝阳区", level: "兴趣点" }] });
    }
    if (url.pathname === "/v3/place/around" || url.pathname === "/v3/place/text") {
      const keywords = url.searchParams.get("keywords") || "";
      const types = url.searchParams.get("types") || "";
      if (types && types !== "050000") return json({ status: "1", infocode: "10000", count: "0", pois: [] });
      if (keywords === "烤肉" || keywords === "串串") {
        const pois = Array.from({ length: 8 }, (_, i) => poi(i + 1, { name: `${keywords}店`, type: `餐饮服务;${keywords}` }));
        return json({ status: "1", infocode: "10000", count: String(pois.length), pois });
      }
      const page = Number(url.searchParams.get("page") || 1);
      const total = 40;
      const pois = Array.from({ length: 25 }, (_, i) => poi((page - 1) * 25 + i + 1)).filter((_, i) => (page - 1) * 25 + i < total);
      return json({ status: "1", infocode: "10000", count: String(total), pois });
    }
    return json({ status: "1", infocode: "10000", count: "0", pois: [] });
  };
  return { fetchImpl, calls };
}

test("QPS 节流：默认 3 QPS（约 334ms 一次），AMAP_QPS 可配置并有上下限", () => {
  assert.equal(amap.amapConfiguredQps({}), 3);
  assert.equal(amap.amapRequestIntervalMs({}), 334);
  assert.equal(amap.amapRequestIntervalMs({ AMAP_QPS: "5" }), 200);
  assert.equal(amap.amapConfiguredQps({ AMAP_QPS: "100" }), 20);
  assert.equal(amap.amapConfiguredQps({ AMAP_QPS: "abc" }), 3);
  assert.equal(amap.AMAP_REQUEST_INTERVAL_MS, 1100, "旧常量保留兼容");
});

test("三步自检全部通过时返回逐步耗时、条数与带人均条数，且不泄露 Key", async () => {
  process.env.AMAP_WEB_KEY = TEST_KEY;
  amap.resetAmapRuntimeState();
  const { fetchImpl } = fixture();
  const result = await amap.runAmapSelfCheck({ fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((step) => step.name), ["地理编码·望京SOHO", "周边搜索·1000米餐饮", "关键字搜索·望京 火锅"]);
  assert.ok(result.steps[1].returned > 0 && result.steps[1].withCost > 0);
  assert.ok(result.usage.count >= 3);
  assert.equal(amap.amapDailyUsage({ AMAP_DAILY_QUOTA: "3" }).nearQuota, true);
  assert.ok(!JSON.stringify(result).includes(TEST_KEY));
});

test("Key 无效时自检给出 infocode 与说明，并记入最近错误", async () => {
  process.env.AMAP_WEB_KEY = TEST_KEY;
  amap.resetAmapRuntimeState();
  const { fetchImpl } = fixture({ fail: "10001" });
  const result = await amap.runAmapSelfCheck({ fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.steps[0].infocode, "10001");
  const recent = amap.amapRecentErrors();
  assert.ok(recent.length >= 1 && recent.length <= 20);
  assert.equal(recent[0].infocode, "10001");
  assert.ok(recent[0].explanation);
  assert.ok(!JSON.stringify(recent).includes(TEST_KEY));
});

test("未配置 Key 时自检直接说明原因，不发请求", async () => {
  process.env.AMAP_WEB_KEY = "";
  const { fetchImpl, calls } = fixture();
  const result = await amap.runAmapSelfCheck({ fetchImpl });
  assert.equal(result.configured, false);
  assert.equal(calls.length, 0);
});

test("行情快查：取 30 家（最近 5 家必留），并补相似品类竞品进入可引用证据", async () => {
  process.env.AMAP_WEB_KEY = TEST_KEY;
  const { fetchImpl } = fixture();
  const client = amap.createAmapClient({ fetchImpl, cache: false });
  const base = { addressText: "望京SOHO", city: "北京", categoryKeyword: "火锅", amapClient: client };
  const legacy = await resolveTradeAreaFacts(base);
  assert.equal(legacy.topCompetitors.value.length, 10, "未指定时保持 10 家");
  assert.equal(legacy.relatedCompetitors, undefined);
  const facts = await resolveTradeAreaFacts({ ...base, topN: 30, relatedCategories: ["烤肉", "串串"] });
  assert.equal(facts.topCompetitors.value.length, 30);
  const nearestFive = [...legacy.topCompetitors.value].slice(0, 5).map((item) => item.name);
  assert.deepEqual(facts.topCompetitors.value.slice(0, 5).map((item) => item.name), nearestFive);
  assert.deepEqual(facts.relatedCompetitors.categories.map((group) => group.category), ["烤肉", "串串"]);
  assert.ok(facts.relatedCompetitors.categories.every((group) => group.value.length > 0 && group.value.length <= 6));
});
