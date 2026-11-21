// PRD v2.2 FR-9：演示话术与样例结果。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DBP = path.join(os.tmpdir(), `nanowork-demo-scripts-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) fs.rmSync(file, { force: true });
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = " ";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
process.env.ENABLE_SCHEDULER = "false";
process.env.SEED_DEMO = "false";

const { initSchema, migrateV2, q, runWithTenant } = await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { demoScriptCatalog, demoScriptsView, fillDemoScript, getDemoSample, saveDemoSampleFromTask, DEMO_DEFAULTS } =
  await import("../src/engines/employee-demo-scripts.js");

initSchema();
migrateV2();
ensureBaselineCatalogs();
after(() => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

test("A1–A8 每位 2 条演示话术，带 A 级编号与题型", () => {
  const { items } = demoScriptCatalog();
  assert.equal(items.length, 16);
  const codes = [...new Set(items.map((item) => item.tierCode))];
  assert.deepEqual(codes, ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"]);
  for (const code of codes) assert.equal(items.filter((item) => item.tierCode === code).length, 2);
  assert.equal(items[0].person, "钱商圈");
  assert.ok(items.find((item) => item.id === "emp108-q1").requiresData, "菜品销量毛利需要数据");
  assert.ok(!items.find((item) => item.id === "emp102-q1").requiresData);
});

test("只填店名/城市/商圈/品类即可一键派：其余槽位用题库示例兜底，没有残留花括号", () => {
  const view = demoScriptsView({ 店名: "老王牛肉面", 城市: "成都", 商圈: "春熙路", 品类: "牛肉面" });
  const scan = view.items.find((item) => item.id === "emp102-q1");
  assert.match(scan.filled, /成都春熙路商圈/u);
  assert.match(scan.filled, /牛肉面及牛肉面相似竞品/u);
  for (const item of view.items) assert.deepEqual(item.unfilledSlots, [], `${item.id}: ${item.filled}`);
  const defaults = demoScriptsView({});
  assert.match(defaults.items[0].filled, new RegExp(`${DEMO_DEFAULTS.城市}${DEMO_DEFAULTS.商圈}`, "u"));
  const { items, slotDictionary } = demoScriptCatalog();
  assert.match(fillDemoScript(items[0], { 城市: "  " }, slotDictionary).filled, /北京/u);
});

test("样例只能从同一员工、已交付的真实任务保存；读取时明确标“样例”与日期，按租户隔离", () => {
  const specialist = q.get("SELECT id,marshal_id FROM specialists WHERE employee_idx=102 LIMIT 1");
  assert.ok(specialist, "需要 102 号员工的 specialist 记录");
  const other = q.get("SELECT id,marshal_id FROM specialists WHERE employee_idx=160 LIMIT 1");
  const body = "# 望京火锅行情\n\n一句话结论：望京火锅主力价位 90–130 元。\n\n| 档次 | 人均 |\n|---|---|\n| 中档 | 90–130元 |";
  const content = q.run(
    "INSERT INTO contents(tenant_id,type,title,body,status) VALUES(?,?,?,?,?)",
    1, "作战计划", "望京火锅行情", body, "已发布",
  ).lastInsertRowid;
  const makeTask = (spec, status) =>
    Number(q.run(
      "INSERT INTO agent_tasks(tenant_id,marshal_id,specialist_id,title,requirement,status,output_id) VALUES(?,?,?,?,?,?,?)",
      1, spec.marshal_id, spec.id, "望京火锅行情", "北京望京商圈火锅", status, content,
    ).lastInsertRowid);
  const done = makeTask(specialist, "已完成");
  const running = makeTask(specialist, "生成中");
  const wrongEmployee = other ? makeTask(other, "已完成") : null;

  runWithTenant(1, () => {
    assert.throws(() => saveDemoSampleFromTask("emp102-q1", running, { id: 1 }), /已交付/u);
    if (wrongEmployee) assert.throws(() => saveDemoSampleFromTask("emp102-q1", wrongEmployee, { id: 1 }), /不是钱商圈做的/u);
    assert.throws(() => saveDemoSampleFromTask("不存在", done, { id: 1 }), /不存在/u);
    const saved = saveDemoSampleFromTask("emp102-q1", done, { id: 1 });
    assert.match(saved.label, /^样例 · \d{4}-\d{2}-\d{2} 实跑结果（非本次实时生成）$/u);
    assert.match(saved.markdown, /主力价位/u);
    const view = demoScriptsView({});
    assert.equal(view.items.find((item) => item.id === "emp102-q1").sample.taskId, done);
    assert.equal(view.items.find((item) => item.id === "emp102-q2").sample, null);
  });
  runWithTenant(2, () => {
    assert.throws(() => getDemoSample("emp102-q1"), /还没有样例/u);
  });
});
