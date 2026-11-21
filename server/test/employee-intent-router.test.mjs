// PRD v2.2 FR-1 题型路由：金标题、题库回归、实体抽取、按题型的联网策略。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  allowedIntentsForEmployee,
  classifyEmployeeIntent,
  intentRequiresPublicResearch,
  normalizeIntentType,
} from "../src/engines/employee-intent-router.js";

const GOLDEN = [
  ["G1", 102, "北京望京商圈餐饮的客单价是什么范围，有哪些代表的店，再具体看下火锅及火锅相似竞品", "lookup"],
  ["G2", 102, "我们店在望京SOHO，人均95，周边火锅竞争有多激烈，我们的价格带有没有空位", "diagnose"],
  ["G3", 101, "成都高新区做一家人均60的社区小火锅有没有机会", "lookup"],
  ["G4", 108, "我们的菜单哪些菜该砍、哪些该提价", "diagnose"],
  ["G5", 108, "帮我设计一套秋冬季菜单结构，主打牛肉火锅", "plan"],
  ["G6", 160, "下周末想做个家庭套餐活动，预算8000", "plan"],
  ["G7", 144, "最近复购率掉了，帮我看看问题出在哪", "diagnose"],
  ["G8", 144, "给我写一套储值会员的门店话术", "produce"],
  ["G9", 161, "今天巡店发现迎宾漏项、冷藏标签不清，整理评分和整改", "produce"],
  ["G10", 137, "根据这份服务员手册出20道考题", "produce"],
  ["G12", 102, "帮我出一份望京开店完整商圈报告给合伙人看", "full_report"],
  ["G13", 161, "我们有 8 家店，按连锁食安新规帮我做门店每日、区域每周、总部每月三张表", "produce"],
  ["G14", 146, "美团店铺分最近掉了，帮我按新规则逐项自查", "diagnose"],
  ["G15", 136, "想用小时工补工作日晚市，帮我合规排班并算成本", "plan"],
];

test("金标题集全部判对（PRD 第 9 节 ≥90%，这里要求 100%）", () => {
  for (const [id, idx, text, want] of GOLDEN) {
    const intent = classifyEmployeeIntent({ employeeIdx: idx, title: text });
    assert.equal(intent.type, want, `${id}：${text} → ${intent.type}（${intent.reason}）`);
  }
});

test("望京原题判为行情快查并抽出商圈、品类与相似品类", () => {
  const intent = classifyEmployeeIntent({ employeeIdx: 102, title: GOLDEN[0][2] });
  assert.equal(intent.answer_shape, "lookup.market_scan");
  assert.equal(intent.entities.city, "北京");
  assert.equal(intent.entities.area, "望京");
  assert.equal(intent.entities.category, "火锅");
  assert.ok(intent.entities.related_categories.includes("烤肉"));
  assert.deepEqual(intent.missing_business_params, [], "快查不追问");
});

test("老板提问题库 171 条示例问法的判题准确率 ≥90%", () => {
  const bank = JSON.parse(fs.readFileSync(new URL("../catalog/employee-question-templates.json", import.meta.url), "utf8"));
  assert.ok(bank.items.length >= 171);
  let correct = 0;
  for (const item of bank.items) {
    const idx = typeof item.employee === "number" ? item.employee : null;
    const intent = classifyEmployeeIntent({ employeeIdx: idx, title: item.example_filled });
    if (intent.type === normalizeIntentType(item.type)) correct += 1;
  }
  assert.ok(correct / bank.items.length >= 0.9, `准确率 ${correct}/${bank.items.length}`);
});

test("老板手动改题型（升级为完整报告）优先于规则", () => {
  const intent = classifyEmployeeIntent({ employeeIdx: 102, title: GOLDEN[0][2], requestedType: "report" });
  assert.equal(intent.type, "full_report");
  assert.equal(intent.source, "user_selected");
});

test("方案题缺业务参数时给出带默认值的假设，不追问可检索事实", () => {
  const intent = classifyEmployeeIntent({ employeeIdx: 160, title: "帮我策划一个活动方案" });
  assert.equal(intent.type, "plan");
  const keys = intent.missing_business_params.map((item) => item.key);
  assert.ok(keys.includes("budget"));
  assert.ok(intent.missing_business_params.every((item) => item.default));
});

test("岗位题型白名单：每位餐饮员工至少 3 种，且不含协同", () => {
  for (let idx = 101; idx <= 161; idx += 1) {
    const allowed = allowedIntentsForEmployee(idx);
    assert.ok(allowed.length >= 3, `员工${idx}`);
    assert.ok(!allowed.includes("team"));
  }
});

test("FR-4 按题型放宽联网：快查/完整报告必须核验，方案/产物尽力而为，诊断有附件时以自有数据为准", () => {
  assert.equal(intentRequiresPublicResearch({ type: "lookup" }), true);
  assert.equal(intentRequiresPublicResearch({ type: "full_report" }), true);
  assert.equal(intentRequiresPublicResearch({ type: "plan" }), false);
  assert.equal(intentRequiresPublicResearch({ type: "produce" }), false);
  assert.equal(intentRequiresPublicResearch({ type: "diagnose" }, { attachmentCount: 0 }), true);
  assert.equal(intentRequiresPublicResearch({ type: "diagnose" }, { attachmentCount: 2 }), false);
});

test("实测回归：升级前真实交付里的老板原题", () => {
  const q50 = classifyEmployeeIntent({ employeeIdx: 102, title: "广东菜 太原吾悦广场 我要看看周围有没有竞争对手 对手啥情况" });
  assert.equal(q50.answer_shape, "lookup.market_scan");
  assert.equal(q50.entities.area, "吾悦广场");
  assert.equal(q50.entities.city, "太原");
  assert.equal(q50.entities.category, "粤菜");
  const q85 = classifyEmployeeIntent({ employeeIdx: 102, title: "帮我看看目标门店3公里商圈有哪些竞品、空白在哪" });
  assert.notEqual(q85.entities.area, "公里");
  const q68 = classifyEmployeeIntent({ employeeIdx: 144, title: "帮我重做会员分层和沉睡顾客唤回方案" });
  assert.equal(q68.type, "plan");
});
