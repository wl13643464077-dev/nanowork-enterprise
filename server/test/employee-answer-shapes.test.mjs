// PRD v2.2 FR-3 答题形态与反公式化校验。
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEmployeeIntent } from "../src/engines/employee-intent-router.js";
import {
  antiFormulaIssues,
  answerShapePromptLines,
  headingJaccard,
  marketScanCoverage,
} from "../src/engines/employee-answer-shapes.js";

test("快查形态提示词含分档表、相似竞品、口径说明，且不含 URL", () => {
  const intent = classifyEmployeeIntent({ employeeIdx: 102, title: "北京望京商圈餐饮的客单价是什么范围，有哪些代表的店，再具体看下火锅及火锅相似竞品" });
  const text = answerShapePromptLines(intent).join("\n");
  assert.match(text, /行情快查/);
  assert.match(text, /价格分档表/);
  assert.match(text, /相似竞品/);
  assert.match(text, /口径说明/);
  assert.match(text, /不少于 15 家/);
  assert.match(text, /商圈：望京/);
  assert.doesNotMatch(text, /https?:\/\//);
});

test("方案形态带可改的假设与默认值；产物形态不附方法说明", () => {
  const plan = answerShapePromptLines(classifyEmployeeIntent({ employeeIdx: 160, title: "下周末想做个家庭套餐活动" })).join("\n");
  assert.match(plan, /可改的假设/);
  assert.match(plan, /预算=/);
  const produce = answerShapePromptLines(classifyEmployeeIntent({ employeeIdx: 144, title: "给我写一套储值会员的门店话术" })).join("\n");
  assert.match(produce, /直接给成品/);
  assert.match(produce, /不附方法说明/);
});

test("完整报告只提示精选交付物，不套短形态", () => {
  const text = answerShapePromptLines(classifyEmployeeIntent({ employeeIdx: 102, title: "帮我出一份望京开店完整商圈报告给合伙人看" })).join("\n");
  assert.match(text, /1–3 份/);
  assert.doesNotMatch(text, /本次答题形态/);
});

test("反公式化：过程术语、过程章节、缺本企业信息都会被标出", () => {
  const bad = "# 报告\n## 输入核查\n方法覆盖 5/5，contract 已满足。";
  const issues = antiFormulaIssues(bad, { ownFacts: ["罗二火锅"] }).issues.map((item) => item.code);
  assert.deepEqual(issues.sort(), ["no_own_facts", "process_sections", "process_terms"]);
  const good = "# 望京火锅行情\n罗二火锅人均95元，处在主力档。";
  assert.equal(antiFormulaIssues(good, { ownFacts: ["罗二火锅"] }).ok, true);
});

test("一级标题相似度与行情覆盖度可计算", () => {
  assert.equal(headingJaccard("# A\n## B", "# A\n## B"), 1);
  assert.equal(headingJaccard("# A\n## B", "# C\n## D"), 0);
  const table = ["| 档次 | 人均 | 代表店 |", "|---|---|---|",
    ...Array.from({ length: 16 }, (_, i) => `| 中档 | ${80 + i}-${120 + i}元 | 店${i} |`)].join("\n");
  const coverage = marketScanCoverage(table);
  assert.equal(coverage.storeRows, 16);
  assert.ok(coverage.priceBands >= 3);
  assert.equal(coverage.meetsAreaTarget, true);
});

test("实测回归：升级前“证据/动作/验收”重复骨架与“待核验”刷屏会被审计出来", () => {
  const sections = ["商圈边界", "竞品矩阵", "餐段热表"].map((name) => `## ${name}\n### 证据\n待核验\n### 动作\n待核验\n### 验收\n待核验`);
  const md = `# 竞品与商圈画像\n${sections.join("\n")}\n待核验 待核验`;
  const result = antiFormulaIssues(md);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "repeated_skeleton"));
  assert.ok(result.issues.some((issue) => issue.code === "unverified_flood"));
  assert.equal(antiFormulaIssues("## 结论\n望京火锅主力 90–130 元。\n## 价格分档表\n| 档 | 人均 |").ok, true);
});
