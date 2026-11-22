// PRD v2.2 线上验收回归测试：覆盖 T1（望京地点识别/高德补定位/数值分档/口径）、
// T4（中文章节号假设表解析/活动预算注入/重算指令）、T5（产物形态表外说明≤3行与葛会员对照）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractTradeAreaAddress,
  normalizeLocationIntent,
  resolveTradeAreaFacts,
  tradeAreaFactsLocationEvidence,
} from "../src/engines/location-intelligence.js";
import { sanitizePublicSources } from "../src/engines/public-source-quality.js";
import {
  buildAssumptionChangeInstruction,
  extractReportAssumptions,
} from "../src/engines/report-assumptions.js";
import { classifyEmployeeIntent } from "../src/engines/employee-intent-router.js";
import {
  answerShapePromptLines,
  auditArtifactFormat,
  buildAnswerShapeAudit,
} from "../src/engines/employee-answer-shapes.js";
import { marketScanCoveragePromptLines } from "../src/engines/market-scan-research.js";

test("T1 回归：望京商圈与望京SOHO T1底商均解析出地点候选，太原吾悦广场保持正确，泛词不误判", () => {
  const q1 =
    "北京望京商圈餐饮的客单价是什么范围，有哪些代表的店，再具体看下火锅及火锅相似竞品";
  const q2 =
    "我们店在望京SOHO T1底商，做火锅，人均95元，帮我看看周边1.5公里内同类和替代竞品有哪些、各自价格带，我们的价格带有没有空位";
  const q3 = "广东菜 太原吾悦广场 我要看看周围有没有竞争对手 对手啥情况";

  const i1 = normalizeLocationIntent(q1);
  assert.equal(i1.city, "北京");
  assert.deepEqual(i1.centerCandidates, ["北京望京", "望京"]);
  assert.equal(extractTradeAreaAddress(q1)?.addressText, "北京望京");

  const i2 = normalizeLocationIntent(q2);
  assert.deepEqual(i2.centerCandidates, ["望京SOHO", "望京SOHO T1"]);
  assert.equal(i2.radiusMeters, 1500);
  assert.equal(extractTradeAreaAddress(q2)?.addressText, "望京SOHO");

  const i3 = normalizeLocationIntent(q3);
  assert.equal(i3.city, "太原");
  assert.deepEqual(i3.centerCandidates, ["太原吾悦广场", "吾悦广场"]);

  assert.deepEqual(normalizeLocationIntent("如何分析目标商圈客流").centerCandidates, []);

  // 口语裸地名（不带“北京/商圈”前后缀）与“帮我诊断+地标”同样应精准抽取
  const i4 = normalizeLocationIntent("望京现在什么消费水平？周边的火锅店多吗？价格怎么样？");
  assert.deepEqual(i4.centerCandidates, ["北京望京", "望京"]);
  const i5 = normalizeLocationIntent("帮我诊断望京SOHO T1底商餐饮竞争格局");
  assert.deepEqual(i5.centerCandidates, ["望京SOHO", "望京SOHO T1"]);
});

test("T1 回归：2字核心商圈名（望京）进入公开来源任务锚点，不误杀含望京的真实商户页", () => {
  const source = {
    title: "海底捞火锅（望京店）门店菜单与人均消费",
    url: "https://shop.example.com/wangjing-haidilao",
    snippet: "望京火锅推荐，人均128元，地址朝阳区望京街",
    body: "海底捞火锅望京店位于朝阳区望京街，主营川味火锅与番茄锅底，菜单包含毛肚、肥牛、虾滑，参考人均128元，堂食营业至次日凌晨，提供外卖与家庭聚餐包间服务。",
  };
  const checked = sanitizePublicSources([source], {
    locationBusinessTask: true,
    requireTaskRelevance: true,
    task: {
      title: "北京望京商圈餐饮的客单价是什么范围，有哪些代表的店，再具体看下火锅及火锅相似竞品",
      requirement: "",
    },
  });
  assert.equal(checked.accepted.length, 1);
});

test("T1 回归：高德 geocode 过粗时用 POI 文本搜索补定位，且数值价格分档严格归入正确区间（36元/42元→30-60元）", async () => {
  const fakeClient = {
    configured: true,
    async geocode() {
      return {
        data: {
          lng: 116.44,
          lat: 39.92,
          city: "北京市",
          district: "朝阳区",
          level: "区县",
          formattedAddress: "北京市朝阳区",
        },
        source: { provider: "amap", endpoint: "/v3/geocode/geo", fetchedAt: "2026-11-21T10:00:00Z" },
      };
    },
    async searchText({ keywords }) {
      return {
        data: {
          count: 1,
          returned: 1,
          requestCount: 1,
          pois: [
            {
              id: "B0001",
              name: keywords,
              address: "北京市朝阳区望京街",
              cityname: "北京市",
              adname: "朝阳区",
              coords: { lng: 116.473, lat: 39.996 },
            },
          ],
        },
        source: { provider: "amap", endpoint: "/v3/place/text", fetchedAt: "2026-11-21T10:00:01Z" },
      };
    },
    async searchAround({ radius, types }) {
      if (types !== "050000") {
        return {
          data: { count: 10, returned: 0, requestCount: 1, pois: [] },
          source: { provider: "amap", endpoint: "/v3/place/around", fetchedAt: "2026-11-21T10:00:02Z" },
        };
      }
      return {
        data: {
          count: 68,
          returned: 4,
          requestCount: 1,
          pois: [
            { id: "1", name: "瑞幸咖啡", type: "餐饮服务;咖啡厅;咖啡厅", distance: 24, coords: { lng: 116.473, lat: 39.996 }, biz_ext: { cost: "13", rating: "4.5" } },
            { id: "2", name: "肯德基", type: "餐饮服务;快餐厅;肯德基", distance: 205, coords: { lng: 116.474, lat: 39.997 }, biz_ext: { cost: "36", rating: "4.6" } },
            { id: "3", name: "星巴克", type: "餐饮服务;咖啡厅;星巴克咖啡", distance: 19, coords: { lng: 116.473, lat: 39.996 }, biz_ext: { cost: "42", rating: "4.7" } },
            { id: "4", name: "尚意西餐厅", type: "餐饮服务;外国餐厅;西餐厅", distance: 185, coords: { lng: 116.475, lat: 39.998 }, biz_ext: { cost: "91", rating: "4.8" } },
          ],
        },
        source: { provider: "amap", endpoint: "/v3/place/around", fetchedAt: "2026-11-21T10:00:02Z" },
      };
    },
  };

  const facts = await resolveTradeAreaFacts({
    addressText: "北京望京",
    addressCandidates: ["北京望京", "望京"],
    city: "北京",
    radii: [1500],
    amapClient: fakeClient,
  });

  assert.equal(facts.ok, true);
  assert.equal(facts.provider, "amap");
  assert.equal(facts.center.provenance.endpoint, "/v3/place/text");
  const bands = facts.priceDistribution.bandExamples;
  assert.deepEqual(bands["≤30元"].map((item) => item.name), ["瑞幸咖啡"]);
  assert.deepEqual(
    bands["30-60元"].map((item) => `${item.name}:${item.cost}`),
    ["星巴克:42", "肯德基:36"],
  );
  assert.deepEqual(bands["60-100元"].map((item) => item.name), ["尚意西餐厅"]);

  const evidence = tradeAreaFactsLocationEvidence(facts);
  assert.ok(evidence && evidence.ok === true);
});

test("T1 回归：覆盖度不足提示明确要求去重店数一致且禁混自有品牌资料", () => {
  const lines = marketScanCoveragePromptLines({
    stores: 10,
    priceBands: 3,
    sources: 5,
    amapAvailable: true,
    thresholds: { stores: 15, priceBands: 3, sources: 8 },
    shortfalls: ["stores", "sources"],
    passed: false,
  }).join("\n");
  assert.match(lines, /严格等于下文去重清单里的实际店数/u);
  assert.match(lines, /不得把本企业品牌资料\/自家门店算作周边竞品/u);
});

const SAMPLE_554_MD = [
  "# 家庭火锅局活动策划方案",
  "## 四、预算与物料（总预算 3000 元）",
  "| 项目 | 金额（元） | 说明 |",
  "|---|---|---|",
  "| 儿童玩具/小礼品（40 份） | 500 | 按每天 20 套 ×2 天计算 |",
  "| **合计** | **约 2540 元** | 不到 3000 元，留缓冲 |",
  "## 七、可改的假设",
  "| 参数 | 默认值 | 改了会影响什么 |",
  "|---|---|---|",
  "| 每日限量 | 20 套 | 数量上调→需同步增加备货和人力 |",
  "| 套餐定价 | 288 元/套（待确认） | 定价上浮→利润空间大但吸引力下降 |",
  "| 储值转化率 | 20%（行业经验区间） | 转化率高→成本上升但锁客效果好 |",
  "| 企微加粉率 | 30%（行业经验区间） | 加粉率高→私域复购基础好 |",
  "| 活动天数 | 2 天（周六+周日） | 延长至 3 天→需增加赠品数量和预算 |",
  "| 门店桌数 | 10-15 桌（假设） | 桌数多→可适当上调限量 |",
].join("\n");

test("T4 回归：历史 #554 中文编号“七、可改的假设”完整解析 6 项并自动置顶注入 3000 元活动预算", () => {
  const items = extractReportAssumptions(SAMPLE_554_MD, {
    requirement: "帮我策划一下下周末的家庭套餐活动怎么做\n\n【老板补充】预算：3000元；目标：拉新客",
  });
  assert.equal(items.length, 7);
  assert.equal(items[0].label, "活动预算");
  assert.equal(items[0].value, "3000元");
  assert.equal(items[0].source_tier, "A");
  assert.deepEqual(
    items.slice(1).map((item) => item.label),
    ["每日限量", "套餐定价", "储值转化率", "企微加粉率", "活动天数", "门店桌数"],
  );

  const built = buildAssumptionChangeInstruction(items, [{ key: items[0].key, value: "1500元" }]);
  assert.equal(built.applied.length, 1);
  assert.match(built.instruction, /活动预算：3000元 → 1500元/u);
  assert.match(built.instruction, /预算拆分表/u);
  assert.match(built.instruction, /相加严格等于合计且不超过新预算/u);

  // 新版本已经更新为 1500 元后，不再回退旧的 3000 元
  const v1Md = SAMPLE_554_MD.replace("总预算 3000 元", "总预算 1500 元").replace(
    "| 每日限量 |",
    "| 活动预算 | 1500元 | 预算分项与合计 |\n| 每日限量 |",
  );
  const v1Items = extractReportAssumptions(v1Md);
  assert.equal(v1Items.find((item) => item.label === "活动预算")?.value, "1500元");
});

test("T5 回归：王菜单判为产物且不拼长报告假设/结论要求，审计能检出超3行说明，葛会员 T6 保持方案形态", () => {
  const t5Intent = classifyEmployeeIntent({
    employeeIdx: 108,
    title: "帮我精简一下菜单，重做价格梯度和套餐",
  });
  assert.equal(t5Intent.type, "produce");
  assert.equal(t5Intent.answer_shape, "produce.artifact");
  const t5Prompt = answerShapePromptLines(t5Intent).join("\n");
  assert.match(t5Prompt, /严格不超过 3 行/u);
  assert.doesNotMatch(t5Prompt, /先给结论，再给依据/u);
  assert.doesNotMatch(t5Prompt, /表头固定为：参数｜默认值/u);

  // 对照葛会员 T6：保留方案形态与“可改的假设”
  const t6Intent = classifyEmployeeIntent({
    employeeIdx: 144,
    title: "帮我重做会员分层和沉睡顾客唤回方案",
  });
  assert.equal(t6Intent.type, "plan");
  const t6Prompt = answerShapePromptLines(t6Intent).join("\n");
  assert.match(t6Prompt, /可改的假设/u);
  assert.match(t6Prompt, /执行清单/u);

  // 回归 #552 超长产物：应判不通过
  const bloated552 = [
    "# 菜单精简与套餐重做方案",
    "**先给结论**：现有100款砍到55款。",
    "> 前提说明：缺少近30天销量，以下为示例。",
    "从收银系统导出近30天销量。",
    "原则：每个品类放锚点款。",
    "| 套餐 | 售价 | 内容 |",
    "|---|---|---|",
    "| 二人餐 | 198元 | 锅底+荤素 |",
    "## 五、验证指标与复盘",
    "观察30天复盘。",
    "## 下一步建议",
    "1. 先导数据。",
    "## 可改的假设",
    "| 参数 | 默认值 | 影响 |",
    "|---|---|---|",
    "| SKU | 100款 | 精简数 |",
  ].join("\n");
  const badAudit = buildAnswerShapeAudit(bloated552, t5Intent);
  assert.equal(badAudit.artifact.passed, false);
  assert.equal(badAudit.artifact.exceedsNoteLines, true);
  assert.ok(badAudit.artifact.forbiddenSections.length >= 2);

  // 达标产物：可复制菜单/价格梯度/套餐表 + 表外说明 ≤ 3 行（含示例口径）
  const crispArtifact = [
    "# 【店名】精简菜单、价格梯度与套餐表",
    "> 口径说明：缺少近30天真实销量与食材成本，以下菜品与定价均为示例模板，落地前请替换【】并按自家成本校准。",
    "## 精简菜单与价格梯度表",
    "| 品类 | 档位角色 | 菜品示例（可替换） | 建议定价 |",
    "|---|---|---|---|",
    "| 锅底 | 锚点款 | 【精品全红锅】 | 48元 |",
    "| 锅底 | 主推款 | 【牛油麻辣锅】 | 38元 |",
    "| 荤菜 | 主推利润 | 【鲜毛肚/嫩牛肉】 | 38-58元 |",
    "## 三档套餐表",
    "| 套餐 | 售价 | 单点合计 | 折扣 | 搭配结构 |",
    "|---|---|---|---|---|",
    "| 二人餐 | 198元 | 224元 | 88折 | 锅底1+荤3+素2+小吃1+主食1 |",
    "| 3-4人餐 | 328元 | 386元 | 85折 | 大锅底1+荤5+素3+小吃2+主食1 |",
    "| 全家餐 | 428元 | 512元 | 84折 | 鸳鸯锅1+荤6+素4+小吃3+主食2 |",
    "使用说明：先按自家收银30天销量保留前55款SKU，再直接套用上方价格梯度与三档套餐上线。",
  ].join("\n");
  const goodAudit = auditArtifactFormat(crispArtifact);
  assert.equal(goodAudit.passed, true);
  assert.equal(goodAudit.noteLineCount, 2);
  assert.equal(goodAudit.tableBlocks, 2);
});
