/**
 * 高德 Web 服务适配器隔离测试：全部 mock fetch，零外网、不读取真实密钥。
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTempDbSafely } from "./helpers/temp-db.mjs";

const DB_PATH = path.join(os.tmpdir(), `nanowork-amap-${process.pid}.db`);
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  fs.rmSync(file, { force: true });
}
process.env.NANOWORK_DB = DB_PATH;
const originalEnv = {
  AMAP_WEB_KEY: process.env.AMAP_WEB_KEY,
  AMAP_BASE_URL: process.env.AMAP_BASE_URL,
};
process.env.AMAP_WEB_KEY = "";
process.env.AMAP_BASE_URL = "";

const {
  AMAP_RESTAURANT_TYPECODE,
  AMAP_UNCONFIGURED_REASON,
  AmapError,
  amapRuntimeState,
  classifyAmapInfocode,
  createAmapClient,
  createMemoryGeoPoiCache,
  createSqliteGeoPoiCache,
  geocode,
  normalizeAmapPoi,
  poiCacheKey,
  resetAmapRuntimeState,
  resetFetch,
  searchAround,
  setFetch,
  verifyAmapConnection,
} = await import("../src/engines/amap.js");

const TEST_KEY = "amap-unit-test-key-must-never-leak";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function okAround(pois, count = pois.length) {
  return jsonResponse({ status: "1", info: "OK", infocode: "10000", count: String(count), pois });
}

function poi(index, overrides = {}) {
  return {
    id: `B00${index}`,
    name: `餐厅${index}`,
    type: "餐饮服务;中餐厅;四川菜",
    typecode: "050102",
    address: `测试路${index}号`,
    location: `112.55${index},37.81${index}`,
    distance: String(100 * index),
    tel: [],
    biz_ext: { rating: [], cost: [] },
    ...overrides,
  };
}

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return { calls, fetchImpl };
}

beforeEach(() => {
  resetAmapRuntimeState();
  resetFetch();
  process.env.AMAP_WEB_KEY = "";
  process.env.AMAP_BASE_URL = "";
});

test("未配置密钥时所有调用返回 unavailable，且不触发任何 fetch、不抛错", async () => {
  let fetchCalls = 0;
  const client = createAmapClient({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not be called");
    },
    cache: false,
  });
  assert.equal(client.configured, false);
  const geo = await client.geocode("太原吾悦广场", "太原");
  assert.equal(geo.unavailable, true);
  assert.equal(geo.reason, AMAP_UNCONFIGURED_REASON);
  const around = await client.searchAround({ lng: 112.55, lat: 37.81 });
  assert.equal(around.unavailable, true);
  const text = await client.searchText({ keywords: "火锅", city: "太原" });
  assert.equal(text.unavailable, true);
  const district = await client.districtInfo("140100");
  assert.equal(district.unavailable, true);
  assert.equal(fetchCalls, 0);
  // 模块级入口同样不抛错
  const moduleGeo = await geocode("太原吾悦广场", "太原");
  assert.equal(moduleGeo.unavailable, true);
  const verify = await verifyAmapConnection({ fetchImpl: async () => { throw new Error("no"); } });
  assert.deepEqual({ ok: verify.ok, configured: verify.configured }, { ok: false, configured: false });
});

test("geocode 解析经纬度/adcode/格式化地址并带 provenance source；key 只出现在请求参数", async () => {
  process.env.AMAP_WEB_KEY = TEST_KEY;
  const { calls, fetchImpl } = recordingFetch((url) => {
    assert.equal(url.origin, "https://restapi.amap.com");
    assert.equal(url.pathname, "/v3/geocode/geo");
    assert.equal(url.searchParams.get("key"), TEST_KEY);
    assert.equal(url.searchParams.get("address"), "太原吾悦广场");
    assert.equal(url.searchParams.get("city"), "太原");
    return jsonResponse({
      status: "1",
      info: "OK",
      infocode: "10000",
      count: "1",
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
  });
  const client = createAmapClient({ fetchImpl, cache: false, now: () => new Date("2026-09-03T01:02:03Z") });
  assert.equal(client.configured, true);
  const result = await client.geocode("太原吾悦广场", "太原");
  assert.equal(calls.length, 1);
  assert.deepEqual(result.data, {
    lng: 112.55,
    lat: 37.81,
    adcode: "140105",
    citycode: "0351",
    formattedAddress: "山西省太原市小店区吾悦广场",
    province: "山西省",
    city: "太原市",
    district: "小店区",
    level: "兴趣点",
  });
  assert.equal(result.source.provider, "amap");
  assert.equal(result.source.endpoint, "/v3/geocode/geo");
  assert.equal(result.source.fetchedAt, "2026-09-03T01:02:03.000Z");
  assert.match(result.source.requestId, /^amap-/u);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TEST_KEY, "u"));
  assert.equal(amapRuntimeState().lastSuccessAt, "2026-09-03T01:02:03.000Z");

  const empty = createAmapClient({
    fetchImpl: async () => jsonResponse({ status: "1", info: "OK", infocode: "10000", count: "0", geocodes: [] }),
    cache: false,
  });
  const miss = await empty.geocode("不存在的地方", "太原");
  assert.equal(miss.data, null);
  assert.match(miss.note, /未匹配/u);
});

test("searchAround 统一 POI 结构：缺失 rating/cost 为 null 不编造；分页最多 3 页且以 count 收敛", async () => {
  process.env.AMAP_WEB_KEY = TEST_KEY;
  const pages = {
    1: Array.from({ length: 25 }, (_, i) => poi(i + 1)),
    2: Array.from({ length: 25 }, (_, i) => poi(i + 26, { biz_ext: { rating: "4.5", cost: "68.00" } })),
    3: Array.from({ length: 25 }, (_, i) => poi(i + 51)),
    4: Array.from({ length: 25 }, (_, i) => poi(i + 76)),
  };
  const { calls, fetchImpl } = recordingFetch((url) => {
    assert.equal(url.pathname, "/v3/place/around");
    assert.equal(url.searchParams.get("location"), "112.55,37.81");
    assert.equal(url.searchParams.get("radius"), "1000");
    assert.equal(url.searchParams.get("types"), AMAP_RESTAURANT_TYPECODE);
    assert.equal(url.searchParams.get("offset"), "25");
    assert.equal(url.searchParams.get("extensions"), "all");
    const page = Number(url.searchParams.get("page"));
    return okAround(pages[page] || [], 100);
  });
  const client = createAmapClient({ fetchImpl, cache: createMemoryGeoPoiCache() });
  const result = await client.searchAround({
    lng: 112.55,
    lat: 37.81,
    radius: 1000,
    types: AMAP_RESTAURANT_TYPECODE,
    pageSize: 99, // 超过上限应被压到 25
    pages: 10, // 超过上限应被压到 3
  });
  assert.equal(calls.length, 3, "分页上限 3 页");
  assert.equal(result.data.count, 100);
  assert.equal(result.data.returned, 75);
  assert.equal(result.data.truncated, true);
  assert.equal(result.data.requestCount, 3);
  assert.equal(result.source.cached, false);
  const first = result.data.pois[0];
  assert.deepEqual(first, {
    id: "B001",
    name: "餐厅1",
    type: "餐饮服务;中餐厅;四川菜",
    typecode: "050102",
    address: "测试路1号",
    location: "112.551,37.811",
    coords: { lng: 112.551, lat: 37.811 },
    distance: 100,
    tel: null,
    adcode: null,
    cityname: null,
    adname: null,
    biz_ext: { rating: null, cost: null },
  });
  const rated = result.data.pois.find((item) => item.id === "B0026");
  assert.deepEqual(rated.biz_ext, { rating: 4.5, cost: 68 });

  // 少于一页时停止分页
  const { calls: shortCalls, fetchImpl: shortFetch } = recordingFetch(() => okAround([poi(1), poi(2)], 2));
  const shortClient = createAmapClient({ fetchImpl: shortFetch, cache: false });
  const short = await shortClient.searchAround({ lng: 112.55, lat: 37.81 });
  assert.equal(shortCalls.length, 1);
  assert.equal(short.data.truncated, false);
  assert.equal(short.data.returned, 2);
});

test("同一 (坐标四舍五入3位, radius, types) 命中缓存不再请求高德；不同半径分开缓存", async () => {
  process.env.AMAP_WEB_KEY = TEST_KEY;
  const cache = createMemoryGeoPoiCache();
  const { calls, fetchImpl } = recordingFetch(() => okAround([poi(1)], 1));
  const client = createAmapClient({ fetchImpl, cache, now: () => new Date("2026-09-03T00:00:00Z") });
  const first = await client.searchAround({ lng: 112.5501, lat: 37.8104, radius: 500, types: "050000" });
  const second = await client.searchAround({ lng: 112.5504, lat: 37.8096, radius: 500, types: "050000" });
  assert.equal(calls.length, 1, "3 位四舍五入后相同坐标应命中缓存");
  assert.equal(first.source.cached, false);
  assert.equal(second.source.cached, true);
  assert.equal(second.source.fetchedAt, "2026-09-03T00:00:00.000Z", "缓存命中沿用原始抓取时间，不伪装成新抓取");
  assert.deepEqual(second.data, first.data);
  assert.equal(amapRuntimeState().cacheHits, 1);
  await client.searchAround({ lng: 112.55, lat: 37.81, radius: 1000, types: "050000" });
  assert.equal(calls.length, 2, "不同半径是不同缓存键");
  assert.equal(
    poiCacheKey({ kind: "around", lng: 112.5501, lat: 37.8104, radius: 500, types: "050000" }),
    poiCacheKey({ kind: "around", lng: 112.5504, lat: 37.8096, radius: 500, types: "050000" }),
  );

  // 24h 过期后重新抓取
  const later = createAmapClient({ fetchImpl, cache, now: () => new Date("2026-09-04T00:00:01Z") });
  const expiredHit = await cache.get(
    poiCacheKey({ kind: "around", lng: 112.55, lat: 37.81, radius: 500, types: "050000", pageSize: 25, pages: 3 }),
    Date.parse("2026-09-04T00:00:01Z"),
  );
  assert.equal(expiredHit, null);
  await later.searchAround({ lng: 112.55, lat: 37.81, radius: 500, types: "050000" });
  assert.equal(calls.length, 3);
});

test("SQLite geo_poi_cache 表按需创建为全局表并可读写/过期", async () => {
  const { initSchema, migrateV2, q } = await import("../src/db.js");
  initSchema();
  migrateV2();
  const cache = createSqliteGeoPoiCache();
  const key = poiCacheKey({ kind: "around", lng: 116.4, lat: 39.9, radius: 1000, types: "050000", pageSize: 25, pages: 3 });
  assert.equal(await cache.get(key), null);
  await cache.set(key, { payload: { pois: [{ name: "x" }], count: 1 }, fetchedAt: "2026-09-03T00:00:00.000Z", endpoint: "/v3/place/around" }, Date.parse("2026-09-03T00:00:00Z"));
  const table = q.get("SELECT name FROM sqlite_master WHERE type='table' AND name='geo_poi_cache'");
  assert.ok(table, "geo_poi_cache 表应存在");
  const columns = q.all("PRAGMA table_info('geo_poi_cache')").map((column) => column.name);
  assert.equal(columns.includes("tenant_id"), false, "POI 缓存是全局共享表，不带 tenant_id");
  const hit = await cache.get(key, Date.parse("2026-09-03T12:00:00Z"));
  assert.deepEqual(hit, { payload: { pois: [{ name: "x" }], count: 1 }, fetchedAt: "2026-09-03T00:00:00.000Z" });
  assert.equal(await cache.get(key, Date.parse("2026-09-04T00:00:01Z")), null, "24h 后过期");
  assert.equal(q.get("SELECT COUNT(*) n FROM geo_poi_cache").n, 0, "过期条目被清理");

  process.env.AMAP_WEB_KEY = TEST_KEY;
  const { calls, fetchImpl } = recordingFetch(() => okAround([poi(7)], 1));
  const client = createAmapClient({ fetchImpl });
  await client.searchAround({ lng: 116.4, lat: 39.9, radius: 800 });
  const again = await client.searchAround({ lng: 116.4, lat: 39.9, radius: 800 });
  assert.equal(calls.length, 1, "默认 sqlite 缓存生效");
  assert.equal(again.source.cached, true);
});

test("高德错误码映射：10003/10001 为 blocked 且运行时状态翻 blocked；10004 为 transient；HTTP/超时不抛裸错误", async () => {
  process.env.AMAP_WEB_KEY = TEST_KEY;
  assert.equal(classifyAmapInfocode("10003").category, "blocked");
  assert.equal(classifyAmapInfocode("10001").category, "blocked");
  assert.equal(classifyAmapInfocode("10004").category, "transient");
  assert.equal(classifyAmapInfocode("20000").category, "request");

  const quota = createAmapClient({
    fetchImpl: async () => jsonResponse({ status: "0", info: "DAILY_QUERY_OVER_LIMIT", infocode: "10003" }),
    cache: false,
  });
  await assert.rejects(
    () => quota.geocode("太原吾悦广场", "太原"),
    (error) => {
      assert.ok(error instanceof AmapError);
      assert.equal(error.blocked, true);
      assert.equal(error.quotaExceeded, true);
      assert.equal(error.infocode, "10003");
      assert.equal(error.code, "AMAP_BLOCKED");
      assert.match(error.message, /日配额/u);
      assert.doesNotMatch(error.message, new RegExp(TEST_KEY, "u"));
      return true;
    },
  );
  assert.equal(amapRuntimeState().blocked, true);
  assert.equal(amapRuntimeState().lastBlocked.infocode, "10003");

  const invalidKey = createAmapClient({
    fetchImpl: async () => jsonResponse({ status: "0", info: "INVALID_USER_KEY", infocode: "10001" }),
    cache: false,
  });
  await assert.rejects(() => invalidKey.searchAround({ lng: 1, lat: 1 }), (error) => error.blocked === true && error.infocode === "10001");

  const busy = createAmapClient({
    fetchImpl: async () => jsonResponse({ status: "0", info: "ACCESS_TOO_FREQUENT", infocode: "10004" }),
    cache: false,
  });
  await assert.rejects(() => busy.searchText({ keywords: "火锅", city: "太原" }), (error) => error.transient === true && error.blocked === false);

  const http = createAmapClient({ fetchImpl: async () => jsonResponse({}, 502), cache: false });
  await assert.rejects(() => http.geocode("x", "y"), (error) => error instanceof AmapError && /HTTP 502/u.test(error.message));

  const timeout = createAmapClient({
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
    timeoutMs: 1000,
    cache: false,
  });
  await assert.rejects(() => timeout.geocode("x", "y"), (error) => error instanceof AmapError && /超时/u.test(error.message));

  // 成功调用后 blocked 状态解除
  resetAmapRuntimeState();
  const recovered = createAmapClient({ fetchImpl: async () => okAround([poi(1)], 1), cache: false });
  await recovered.searchAround({ lng: 1, lat: 1 });
  assert.equal(amapRuntimeState().blocked, false);
});

test("verifyAmapConnection 输出可脱敏验收证据；模块级 setFetch 注入生效；AMAP_BASE_URL 仅接受 HTTPS", async () => {
  process.env.AMAP_WEB_KEY = TEST_KEY;
  process.env.AMAP_BASE_URL = "http://evil.example/";
  let seenOrigin = null;
  setFetch(async (input) => {
    seenOrigin = new URL(String(input)).origin;
    return jsonResponse({
      status: "1",
      infocode: "10000",
      geocodes: [{ location: "116.48,39.99", adcode: "110105", formatted_address: "北京市朝阳区阜通东大街6号" }],
    });
  });
  const ok = await verifyAmapConnection({ cache: false });
  assert.equal(seenOrigin, "https://restapi.amap.com", "非 HTTPS BaseURL 必须回退默认");
  assert.equal(ok.ok, true);
  assert.equal(ok.adcode, "110105");
  assert.equal(ok.endpoint, "/v3/geocode/geo");
  assert.doesNotMatch(JSON.stringify(ok), new RegExp(TEST_KEY, "u"));

  setFetch(async () => jsonResponse({ status: "0", info: "DAILY_QUERY_OVER_LIMIT", infocode: "10003" }));
  const blocked = await verifyAmapConnection({ cache: false });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.quotaExceeded, true);
  assert.equal(blocked.infocode, "10003");
  resetFetch();

  process.env.AMAP_BASE_URL = "https://amap-proxy.example";
  const { calls, fetchImpl } = recordingFetch(() => okAround([], 0));
  await searchAround({ lng: 1, lat: 2, fetchImpl, cache: false });
  assert.equal(calls[0].url.origin, "https://amap-proxy.example");
});

test("normalizeAmapPoi 把高德的空数组/空串字段统一为 null，无名称的 POI 丢弃", () => {
  assert.equal(normalizeAmapPoi({ name: [], location: "1,2" }), null);
  const normalized = normalizeAmapPoi({
    name: "测试店",
    type: [],
    typecode: "",
    address: [],
    location: [],
    distance: "abc",
    tel: "",
    biz_ext: { rating: "", cost: "abc" },
  });
  assert.deepEqual(normalized, {
    id: null,
    name: "测试店",
    type: null,
    typecode: null,
    address: null,
    location: null,
    coords: null,
    distance: null,
    tel: null,
    adcode: null,
    cityname: null,
    adname: null,
    biz_ext: { rating: null, cost: null },
  });
});

after(async () => {
  resetFetch();
  resetAmapRuntimeState();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await removeTempDbSafely(DB_PATH);
});
