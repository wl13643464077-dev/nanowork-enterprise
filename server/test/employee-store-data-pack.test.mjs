// PRD v2.2 FR-5：本企业自有数据包——按岗位取数、口径+周期、租户隔离、无数据不编造。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DBP = path.join(os.tmpdir(), `nanowork-store-data-pack-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) fs.rmSync(file, { force: true });
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = " ";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
process.env.ENABLE_SCHEDULER = "false";
process.env.SEED_DEMO = "false";

const { initSchema, migrateV2, q, runWithTenant } = await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { buildEmployeeStoreDataPack, dataNeedsForEmployee } = await import("../src/engines/employee-store-data-pack.js");
const { buildEmployeeExecutionProfile } = await import("../src/employee-workbench.js");
const { classifyEmployeeIntent } = await import("../src/engines/employee-intent-router.js");
const { buildAnswerShapeAudit } = await import("../src/engines/employee-answer-shapes.js");

initSchema();
migrateV2();
ensureBaselineCatalogs();
after(() => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

const NOW = new Date();
const day = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);

runWithTenant(1, () => {
  const store = Number(q.run("INSERT INTO stores(tenant_id,name,city,area,biz_type) VALUES(1,'罗二火锅望京店','北京','望京','火锅')").lastInsertRowid);
  q.run("INSERT INTO dishes(tenant_id,store_id,name,category,price,cost) VALUES(1,?,'鲜切牛肉','招牌',68,30)", store);
  q.run("INSERT INTO dishes(tenant_id,store_id,name,category,price,cost) VALUES(1,?,'番茄锅底','锅底',38,0)", store);
  q.run("INSERT INTO order_items(tenant_id,order_id,dish_name_snapshot,qty,unit_price,amount,created_at) VALUES(1,1,'鲜切牛肉',40,68,2720,?)", `${day(3)} 12:00:00`);
  q.run("INSERT INTO order_items(tenant_id,order_id,dish_name_snapshot,qty,unit_price,amount,created_at) VALUES(1,2,'番茄锅底',25,38,950,?)", `${day(4)} 12:00:00`);
  q.run("INSERT INTO store_daily_ops(tenant_id,store_id,date,revenue,orders,avg_ticket,delivery_revenue) VALUES(1,?,?,20000,200,100,4000)", store, day(2));
  q.run("INSERT INTO costs(tenant_id,store_id,date,category,amount) VALUES(1,?,?,'食材',7000)", store, day(2));
  q.run("INSERT INTO store_reviews(tenant_id,platform,rating,content,author,store_name,review_date,category) VALUES(1,'美团',1,'上菜太慢了 加我13812345678 http://x.example/a','张三','望京店',?,'出品速度')", day(5));
});

test("岗位数据需求：王菜单要菜品，昌本利要营业与成本，钱商圈只要门店档案", () => {
  assert.ok(dataNeedsForEmployee(108).includes("menu"));
  assert.ok(dataNeedsForEmployee(150).includes("costs"));
  assert.deepEqual(dataNeedsForEmployee(102), ["stores"]);
});

test("王菜单的数据包含本店菜品、毛利与近30天销量口径；缺成本卡的标“毛利未知”", () => {
  const pack = runWithTenant(1, () => buildEmployeeStoreDataPack(108, { tenantId: 1, now: NOW }));
  assert.deepEqual(pack.available.sort(), ["menu", "stores"]);
  assert.match(pack.text, /鲜切牛肉.*毛利率55\.9%.*近30天销量40/u);
  assert.match(pack.text, /番茄锅底.*毛利未知/u);
  assert.match(pack.text, /不可信业务数据/u);
  assert.ok(pack.text.length <= 3600);
  assert.ok(pack.ownFacts.includes("罗二火锅望京店"));
});

test("评价原文去掉手机号、链接和作者；成本按营业额算占比", () => {
  const reviews = runWithTenant(1, () => buildEmployeeStoreDataPack(143, { tenantId: 1, now: NOW }));
  assert.match(reviews.text, /差评归因：出品速度1条/u);
  assert.doesNotMatch(reviews.text, /13812345678|http:\/\/|张三/u);
  const finance = runWithTenant(1, () => buildEmployeeStoreDataPack(150, { tenantId: 1, now: NOW }));
  assert.match(finance.text, /食材｜7,000元｜占营业额35%/u);
  assert.ok(finance.missing.includes("delivery"));
  assert.match(finance.text, /未导入的数据.*外卖平台数据/u);
});

test("其他租户看不到本企业数据，只给导入提示，不编造", () => {
  const pack = runWithTenant(2, () => buildEmployeeStoreDataPack(108, { tenantId: 2, now: NOW }));
  assert.deepEqual(pack.available, []);
  assert.doesNotMatch(pack.text, /罗二/u);
  assert.match(pack.text, /数据接入/u);
});

test("派活带题型时自有数据进入提示词与快照；交付审计能识别本企业信息", () => {
  runWithTenant(1, () => {
    const intent = classifyEmployeeIntent({ employeeIdx: 108, title: "我们的菜单哪些菜该砍、哪些该提价" });
    const execution = buildEmployeeExecutionProfile(108, { outputMode: "paihuo_markdown", intent });
    assert.match(execution.systemContext, /本企业自有数据/u);
    assert.match(execution.systemContext, /鲜切牛肉/u);
    assert.deepEqual(execution.snapshot.storeData.available.sort(), ["menu", "stores"]);
    const plain = buildEmployeeExecutionProfile(108, { outputMode: "paihuo_markdown" });
    assert.doesNotMatch(plain.systemContext, /本企业自有数据/u, "未带题型的旧调用链不注入");
    const audit = buildAnswerShapeAudit("# 菜单诊断\n罗二火锅望京店的鲜切牛肉毛利最高。", intent, { ownFacts: execution.storeDataOwnFacts });
    assert.equal(audit.antiFormula.ok, true);
    assert.equal(audit.answerShape, "diagnose.store_issue");
  });
});
