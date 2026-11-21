// PRD v2.2 FR-4.1 / 4.4 / 4.5 / 4.6：行情快查证据编排的纯函数单测。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessMarketScanCoverage,
  buildMarketScanQueries,
  classifySourceTier,
  extractStoreEntities,
  isMarketScanIntent,
  marketScanCoveragePromptLines,
  mergeMarketScanQueries,
  priceBandOf,
} from "../src/engines/market-scan-research.js";
import {
  allowAggregationLeadsForTask,
  sanitizePublicSources,
} from "../src/engines/public-source-quality.js";
import { classifyEmployeeIntent } from "../src/engines/employee-intent-router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("FR-4.1 望京原题：扇出 6–10 条短查询，含必吃榜/人均/相似品类/新开", () => {
  const intent = classifyEmployeeIntent({
    employeeIdx: 102,
    title: "北京望京商圈餐饮的客单价是什么范围，有哪些代表的店，再具体看下火锅及火锅相似竞品",
  });
  assert.ok(isMarketScanIntent(intent));
  const queries = buildMarketScanQueries({ entities: intent.entities, center: "望京SOHO", year: 2026 });
  assert.ok(queries.length >= 6 && queries.length <= 10, queries.join(" / "));
  assert.ok(queries.includes("望京 人均 餐厅"));
  assert.ok(queries.includes("望京 火锅 推荐"));
  assert.ok(queries.includes("望京 必吃 榜"));
  assert.ok(queries.some((query) => /新开 火锅 2026/u.test(query)));
  assert.ok(queries.some((query) => /望京SOHO 餐饮/u.test(query)));
  for (const query of queries) assert.ok(query.length <= 24, `短查询：${query}`);

  const round2 = buildMarketScanQueries({ entities: intent.entities, center: "望京SOHO", round: 2 });
  assert.ok(round2.length > 0 && round2.length <= 8);
  assert.ok(round2.every((query) => !queries.includes(query)), "二轮必须换角度");

  const merged = mergeMarketScanQueries(queries, ["望京 火锅 site:dianping.com 菜单 人均 评价", queries[0]]);
  assert.equal(merged[0], queries[0]);
  assert.equal(new Set(merged).size, merged.length);
  assert.ok(merged.length <= 18);
});

test("快查规则题、方案题不走市场扫描", () => {
  assert.equal(isMarketScanIntent({ type: "lookup", answer_shape: "lookup.quick_fact" }), false);
  assert.equal(isMarketScanIntent({ type: "plan", answer_shape: "plan.action_plan" }), false);
  assert.equal(isMarketScanIntent(null), false);
  assert.deepEqual(buildMarketScanQueries({ entities: {} }), []);
});

test("FR-4.1 从来源抽店铺实体：店名+分店去重，带人均，过滤泛词", () => {
  const entities = extractStoreEntities([
    { title: "望京火锅必吃榜", url: "https://a.test/1", snippet: "海底捞火锅（望京店）人均128；巴奴毛肚火锅人均150；推荐火锅" },
    { title: "望京美食", url: "https://a.test/2", snippet: "海底捞火锅（望京店）营业到凌晨；朝鲜族烤肉 人均90" },
  ]);
  const names = entities.map((item) => `${item.name}${item.branch || ""}`);
  assert.ok(names.includes("海底捞火锅望京店"));
  assert.ok(names.includes("巴奴毛肚火锅"));
  assert.equal(names.filter((name) => name === "海底捞火锅望京店").length, 1);
  assert.ok(!names.includes("推荐火锅"));
  assert.equal(entities.find((item) => item.name === "海底捞火锅").price, 128);
});

test("FR-4.4 覆盖度：高德+网页合并去重；不达标给出“本次只找到 N 家”要求；高德不可用写明来源", () => {
  assert.equal(priceBandOf(45), "≤50");
  assert.equal(priceBandOf(128), "101–150");
  assert.equal(priceBandOf(null), null);
  const tradeAreaFacts = {
    amap: { ok: true },
    topCompetitors: { value: [{ name: "海底捞火锅(望京店)", cost: "128" }, { name: "小龙坎火锅", cost: "95" }] },
    relatedCompetitors: { categories: [{ category: "烤肉", value: [{ name: "姜虎东烤肉", cost: "160" }] }] },
  };
  const coverage = assessMarketScanCoverage({
    webSources: [{ url: "https://a.test/1", title: "x", snippet: "巴奴毛肚火锅人均150" }],
    tradeAreaFacts,
  });
  assert.equal(coverage.amapStores, 3);
  assert.equal(coverage.stores, 4);
  assert.equal(coverage.priceBands, 3);
  assert.equal(coverage.passed, false);
  assert.ok(coverage.shortfalls.includes("stores"));
  const lines = marketScanCoveragePromptLines(coverage).join("\n");
  assert.match(lines, /本次只找到 N 家/u);
  assert.match(lines, /不要用“待核验”/u);

  const offline = assessMarketScanCoverage({ webSources: [], tradeAreaFacts: { amap: { ok: false } } });
  assert.equal(offline.amapAvailable, false);
  assert.match(marketScanCoveragePromptLines(offline).join("\n"), /本次地图数据不可用，店铺信息来自公开网页/u);

  const many = Array.from({ length: 16 }, (_, index) => ({ name: `测试${index}号火锅`, cost: [40, 90, 140][index % 3] }));
  const passing = assessMarketScanCoverage({
    webSources: Array.from({ length: 8 }, (_, index) => ({ url: `https://a.test/${index}`, title: "t" })),
    tradeAreaFacts: { amap: { ok: true }, topCompetitors: { value: many } },
  });
  assert.equal(passing.passed, true);
  assert.deepEqual(marketScanCoveragePromptLines(passing), []);
});

test("FR-4.5 来源档位：官方/高德=A，平台/榜单/团购=B，过期或无法归类=C", () => {
  const now = new Date("2026-11-20T00:00:00Z");
  assert.equal(classifySourceTier({ kind: "amap" }, { now }).tier, "A");
  assert.equal(classifySourceTier({ kind: "own_data" }, { now }).tier, "A");
  assert.equal(classifySourceTier({ url: "https://www.haidilao.com/stores", title: "海底捞官网 门店查询" }, { now }).tier, "A");
  assert.equal(classifySourceTier({ url: "https://www.dianping.com/shop/1", title: "某火锅" }, { now }).tier, "B");
  assert.equal(classifySourceTier({ url: "https://blog.test/a", title: "望京火锅必吃榜TOP10" }, { now }).tier, "B");
  assert.equal(classifySourceTier({ url: "https://blog.test/b", title: "某店探访", snippet: "2024年3月 发布" }, { now }).tier, "C");
  assert.equal(classifySourceTier({ url: "https://blog.test/c", title: "随便一页" }, { now }).tier, "C");
});

test("FR-4.1 榜单/聚合页：普通任务仍剔除，市场扫描任务降级保留；回收类与诈骗页始终剔除", () => {
  const rank = { title: "望京餐厅推荐榜 top10", url: "https://rank.test/wangjing", snippet: "望京火锅餐厅推荐榜，人均与门店" };
  const recycle = { title: "美食排行榜 包包回收指南", url: "https://rank.test/recycle", snippet: "餐厅推荐榜 包包回收" };
  const fraud = { title: "望京火锅", url: "https://rank.test/x", snippet: "加whatsapp领券" };
  const normalTask = { title: "望京 火锅", requirement: "" };
  const plain = sanitizePublicSources([rank], { locationBusinessTask: true, task: normalTask });
  assert.equal(plain.accepted.length, 0);
  assert.equal(plain.rejected[0].reason, "seo_ranking_or_unrelated_aggregation");

  const scanTask = allowAggregationLeadsForTask({ title: "望京 火锅", requirement: "" });
  const scan = sanitizePublicSources([rank, recycle, fraud], { locationBusinessTask: true, task: scanTask });
  assert.deepEqual(scan.accepted.map((item) => item.url), ["https://rank.test/wangjing"]);
  assert.equal(scan.rejected.length, 2);
  assert.ok(!Object.prototype.propertyIsEnumerable.call(scanTask, "aggregationLeads"), "不在任务对象上留可序列化字段");
  assert.equal(JSON.stringify(scanTask), JSON.stringify({ title: "望京 火锅", requirement: "" }));
});

test("FR-4.6 合规红线：市场扫描模块不调用美团/点评端内接口，不含抓取工具", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "engines", "market-scan-research.js"), "utf8");
  const code = source.replace(/^\s*\/\/.*$/gmu, "");
  assert.doesNotMatch(code, /fetch\(|axios|puppeteer|playwright|i\.meituan|m\.dianping|mapi\.dianping|apimobile/iu);
  assert.match(source, /不调用、不模拟美团\/点评 App 端内接口/u);
});
