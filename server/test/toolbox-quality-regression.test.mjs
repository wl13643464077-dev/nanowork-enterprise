import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { toolboxResultQuality } from "../src/engines/toolbox-quality.js";

const acceptanceRoot = "/Users/wanglei/Desktop/nanowork-manual-acceptance-2026-08-21/real-business-runs/toolbox-outputs";

// 该用例回放桌面验收目录里的真实产物；产物被清理后跳过（不是产品回归），
// 质量门禁本身的行为由下方合成用例持续覆盖。
test("工具箱真实表格交付不会因选题/责任表版式被误拦截", { skip: !fs.existsSync(acceptanceRoot) }, () => {
  const cases = [
    ["hot", "tool-6-hot.md", { store: "太原吾悦广场粤菜馆", channels: ["朋友圈"], focus: "周末家庭客不足" }],
    ["bench", "tool-8-bench.md", { targets: "太原吾悦广场内同品类粤菜门店" }],
    ["warm", "tool-9-warm.md", { positioning: "太原吾悦广场粤菜馆，家庭+办公客，客单60-100元" }],
    ["leads", "tool-10-leads.md", { city: "太原吾悦广场", product: "粤菜家庭聚餐与办公午餐，客单60–100元" }],
  ];
  for (const [key, file, inputs] of cases) {
    const body = fs.readFileSync(`${acceptanceRoot}/${file}`, "utf8");
    const result = toolboxResultQuality(key, inputs, body, { strictActions: true });
    assert.deepEqual(result, { valid: true, errors: [] }, key);
  }
});

test("工具箱产品匹配容忍中文标点/数字范围差异但不放过无关产物", () => {
  const body = "# 线索雷达\n\n## 规则\n\n太原吾悦广场粤菜家庭聚餐与办公午餐，客单60–100元。公开页面只记录需求信号，不抓取个人联系方式；每条事实保留来源、日期、核验状态和下一步，无法核实的字段写未知。\n\n## 执行责任表\n\n|负责人|时点|动作|产出|\n|---|---|---|---|\n|运营专员|明日10:00|搜索公开信号并汇总数据|线索记录表|\n|店长|本周|核验来源链接与评价|核验清单|\n|运营主管|下周|跟进有效咨询并记录|跟进台账|";
  const accepted = toolboxResultQuality("leads", { city: "太原吾悦广场", product: "粤菜家庭聚餐与办公午餐，客单60-100元" }, body, { strictActions: true });
  assert.equal(accepted.valid, true);
  const rejected = toolboxResultQuality("leads", { city: "太原吾悦广场", product: "粤菜家庭聚餐与办公午餐，客单60-100元" }, body.replaceAll("太原吾悦广场", "石家庄其他商圈"), { strictActions: true });
  assert.equal(rejected.valid, false);
  assert.ok(rejected.errors.includes("产物未落到指定城市/商圈"));
});
