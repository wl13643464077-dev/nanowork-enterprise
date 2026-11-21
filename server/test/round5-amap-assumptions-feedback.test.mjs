// PRD v2.2 第五轮：FR-4.3 高德每单预算与告警 / FR-4.2 人均回填 / FR-7.1 假设面板 / FR-7.3 反馈学习。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DBP = path.join(os.tmpdir(), `nanowork-round5-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) fs.rmSync(file, { force: true });
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = " ";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
process.env.ENABLE_SCHEDULER = "false";
process.env.SEED_DEMO = "false";

const { initSchema, migrateV2, q, runWithTenant } = await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const amap = await import("../src/engines/amap.js");
const { amapAlertMessage, deliverAmapAlert } = await import("../src/engines/amap-alerts.js");
const { backfillCompetitorPricesFromWeb, assessMarketScanCoverage } = await import("../src/engines/market-scan-research.js");
const { extractReportAssumptions, buildAssumptionChangeInstruction } = await import("../src/engines/report-assumptions.js");
const { REPORT_REFINE_QUICK_INSTRUCTIONS, buildReportRefinePrompt } = await import("../src/engines/report-refine.js");
const { suggestPreferenceFromFeedback, feedbackReasonKeys } = await import("../src/engines/feedback-preference-suggest.js");
const { saveSlotPreferences, getSlotPreferences, outputPrefsPromptLine } = await import("../src/engines/employee-dispatch-followups.js");
const { buildEmployeeExecutionProfile } = await import("../src/employee-workbench.js");
const { classifyEmployeeIntent } = await import("../src/engines/employee-intent-router.js");

initSchema();
migrateV2();
ensureBaselineCatalogs();
after(() => {
  amap.setAmapAlertHandler(null);
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

const noPacer = { wait: async () => {} };
function okFetch() {
  return async () => ({ ok: true, json: async () => ({ status: "1", infocode: "10000", geocodes: [{ location: "116.48,39.99", adcode: "110105" }] }) });
}
function failFetch(infocode) {
  return async () => ({ ok: true, json: async () => ({ status: "0", infocode, info: "INVALID_USER_KEY" }) });
}

test("FR-4.3 每单高德请求预算：用完后抛 budget 错误，不计入最近错误", async () => {
  amap.resetAmapRuntimeState();
  const client = amap.createAmapClient({ apiKey: "k", fetchImpl: okFetch(), requestPacer: noPacer, requestBudget: 2 });
  await client.geocode("望京SOHO", "北京");
  await client.geocode("望京SOHO T2", "北京");
  await assert.rejects(() => client.geocode("望京SOHO T3", "北京"), (error) => error.category === "budget" && /预算已用完/u.test(error.message));
  assert.deepEqual(client.requestBudget(), { limit: 2, used: 2 });
  assert.equal(amap.amapRecentErrors().length, 0);

  const unlimited = amap.createAmapClient({ apiKey: "k", fetchImpl: okFetch(), requestPacer: noPacer });
  for (let i = 0; i < 4; i += 1) await unlimited.geocode(`地址${i}`, "北京");
  assert.equal(unlimited.requestBudget().limit, null);
});

test("FR-4.3 预算配置：默认 25，可用环境变量调整，接近日配额时收紧", () => {
  amap.resetAmapRuntimeState();
  assert.equal(amap.amapTaskRequestBudget({}), 25);
  assert.equal(amap.amapTaskRequestBudget({ AMAP_TASK_REQUEST_BUDGET: "40" }), 40);
  assert.equal(amap.amapTaskRequestBudget({ AMAP_TASK_REQUEST_BUDGET: "1" }), 5);
  assert.equal(amap.amapTaskRequestBudget({ AMAP_DAILY_QUOTA: "1" }), 25, "今天还没调用，不算接近配额");
});

test("FR-4.3 凭证/配额错误触发告警，30 分钟内同一 infocode 只告警一次", async () => {
  amap.resetAmapRuntimeState();
  amap.resetAmapAlertState();
  const events = [];
  amap.setAmapAlertHandler((event) => events.push(event));
  const client = amap.createAmapClient({ apiKey: "bad", fetchImpl: failFetch("10001"), requestPacer: noPacer });
  await assert.rejects(() => client.geocode("望京", "北京"));
  await assert.rejects(() => client.geocode("望京", "北京"));
  const credential = events.filter((event) => event.kind === "credential");
  assert.equal(credential.length, 1);
  assert.equal(credential[0].infocode, "10001");
  assert.match(credential[0].explanation, /key不正确/u);

  const quotaClient = amap.createAmapClient({ apiKey: "k", fetchImpl: failFetch("10003"), requestPacer: noPacer });
  await assert.rejects(() => quotaClient.geocode("望京", "北京"));
  assert.ok(events.some((event) => event.kind === "quota"));
  amap.setAmapAlertHandler(null);
});

test("FR-4.3 告警投递：站内信发给平台超管和总部老板/管理员，同时推飞书", async () => {
  const insertUser = (username, role, tenant) =>
    q.run(
      "INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES(?,?,?,?,?)",
      username, "x", username, role, tenant,
    ).lastInsertRowid;
  const boss = Number(insertUser("hq-boss-r5", "boss", 1));
  const other = Number(insertUser("other-boss-r5", "boss", 2));
  const pushed = [];
  const result = await deliverAmapAlert(
    { kind: "credential", infocode: "10001", explanation: "key不正确或已过期" },
    { pushFeishu: async (msg, tid) => { pushed.push({ msg, tid }); return { ok: true }; } },
  );
  assert.ok(result.notified >= 1);
  const rows = q.all("SELECT user_id,title FROM notifications WHERE title LIKE '高德%'");
  assert.ok(rows.some((row) => Number(row.user_id) === boss));
  assert.ok(!rows.some((row) => Number(row.user_id) === other), "其他租户老板不收平台高德告警");
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].tid, 1);
  assert.match(amapAlertMessage({ kind: "near_quota", count: 4100, quota: 5000 }).body, /4100/u);
});

test("FR-4.2 高德缺人均时用公开网页同名店回填，标 B 档参考，并计入价格档", () => {
  const facts = {
    amap: { ok: true },
    topCompetitors: {
      value: [
        { name: "老街毛血旺(吾悦店)", cost: null },
        { name: "渝味毛血旺", cost: "" },
        { name: "有价店火锅", cost: "128" },
        { name: "查不到的店", cost: null },
      ],
    },
  };
  const web = [{ url: "https://a.test/1", title: "吾悦广场毛血旺", snippet: "老街毛血旺人均68；渝味毛血旺人均45" }];
  const { facts: next, filled } = backfillCompetitorPricesFromWeb(facts, web);
  assert.equal(filled, 2);
  assert.equal(next.topCompetitors.value[0].costFromWeb.value, 68);
  assert.equal(next.topCompetitors.value[0].costFromWeb.sourceTier, "B");
  assert.equal(next.topCompetitors.value[2].costFromWeb, undefined);
  assert.equal(next.topCompetitors.value[3].costFromWeb, undefined);
  assert.equal(facts.topCompetitors.value[0].costFromWeb, undefined, "不修改原对象");
  const coverage = assessMarketScanCoverage({ webSources: [], tradeAreaFacts: next });
  assert.equal(coverage.priceBands, 3);
  assert.equal(backfillCompetitorPricesFromWeb(facts, []).filled, 0);
});

const PLAN_MD = [
  "# 周末拉新活动方案",
  "## 方案一句话",
  "周末双人套餐拉新。",
  "## 预算与物料",
  "总预算 8000元：抖音 4000元，物料 2000元。",
  "## 可改的假设",
  "| 参数 | 默认值 | 改了会影响什么 |",
  "|---|---|---|",
  "| 活动预算 | 8000元 | 预算拆分、物料数量 |",
  "| 转化率 | 3%（参考） | 预计到店人数 |",
  "| 商圈半径 | 1.5km | 投放范围 |",
  "| 客单价 | — | 无 |",
  "## 数据来源与时效",
  "无",
].join("\n");

test("FR-7.1 解析“可改的假设”表格，生成结构化重算指令（只认表里的参数）", () => {
  const assumptions = extractReportAssumptions(PLAN_MD);
  assert.deepEqual(assumptions.map((item) => item.label), ["活动预算", "转化率", "商圈半径"]);
  assert.equal(assumptions[0].value, "8000元");
  assert.equal(assumptions[0].unit, "元");
  assert.equal(assumptions[1].source_tier, "B");
  assert.equal(assumptions[2].unit, "km");
  assert.ok(assumptions.every((item) => item.editable));
  assert.deepEqual(extractReportAssumptions("# 没有假设段\n正文"), []);

  const built = buildAssumptionChangeInstruction(assumptions, [
    { key: assumptions[0].key, value: "5000元" },
    { key: assumptions[2].key, value: "1.5km" },
    { key: "不存在", value: "999" },
  ]);
  assert.equal(built.applied.length, 1);
  assert.match(built.instruction, /活动预算：8000元 → 5000元/u);
  assert.match(built.instruction, /不重新检索/u);
  assert.ok(built.instruction.length <= 1200);
  assert.equal(buildAssumptionChangeInstruction(assumptions, []).instruction, "");

  const prompt = buildReportRefinePrompt({
    task: { title: "周末活动", requirement: "", employee_person: "店小满" },
    baseMarkdown: PLAN_MD,
    baseVersion: 0,
    history: [],
    instruction: built.instruction,
  });
  assert.match(prompt.userMsg, /按新假设重算/u);
  assert.match(prompt.system, /逐字保留/u);
});

test("FR-7.1 快捷形态切换新增老板版/店长执行版/表格", () => {
  const keys = REPORT_REFINE_QUICK_INSTRUCTIONS.map((item) => item.key);
  for (const key of ["shorter", "plain", "actions", "compare", "summary", "boss", "manager", "table"]) assert.ok(keys.includes(key), key);
  assert.match(REPORT_REFINE_QUICK_INSTRUCTIONS.find((item) => item.key === "boss").instruction, /300 字/u);
});

test("FR-7.3 连续两次同类原因才提示存为默认设置；已保存的不再提示", () => {
  assert.deepEqual(feedbackReasonKeys("太长了，看不完"), ["too_long"]);
  assert.equal(suggestPreferenceFromFeedback(["太长了"]), null, "只有一次不提示");
  assert.equal(suggestPreferenceFromFeedback(["太长了", "不要英文"]), null);
  const suggestion = suggestPreferenceFromFeedback(["还是太啰嗦", "太长了"]);
  assert.equal(suggestion.key, "too_long");
  assert.match(suggestion.message, /要不要存为默认设置/u);
  assert.equal(suggestPreferenceFromFeedback(["还是太啰嗦", "太长了"], { savedPrefs: [suggestion.preference] }), null);
});

test("FR-7.3 老板确认后的固定要求进入带题型派活的提示词，可删除", () => {
  runWithTenant(1, () => saveSlotPreferences({ addOutputPref: "全文用中文，专业词不夹英文缩写" }));
  runWithTenant(1, () => saveSlotPreferences({ addOutputPref: "全文用中文，专业词不夹英文缩写" }));
  const prefs = runWithTenant(1, () => getSlotPreferences());
  assert.deepEqual(prefs.outputPrefs, ["全文用中文，专业词不夹英文缩写"]);
  assert.match(outputPrefsPromptLine(prefs), /老板固定要求/u);
  const intent = runWithTenant(1, () => classifyEmployeeIntent({ employeeIdx: 116, title: "帮我策划一下国庆活动怎么做" }));
  const profile = runWithTenant(1, () => buildEmployeeExecutionProfile(116, { intent, outputMode: "paihuo_markdown" }));
  assert.match(JSON.stringify(profile), /全文用中文，专业词不夹英文缩写/u);
  const legacy = runWithTenant(1, () => buildEmployeeExecutionProfile(116, { outputMode: "paihuo_markdown" }));
  assert.doesNotMatch(JSON.stringify(legacy), /老板固定要求/u);
  runWithTenant(1, () => saveSlotPreferences({ outputPrefs: [] }));
  assert.deepEqual(runWithTenant(1, () => getSlotPreferences()).outputPrefs, []);
});
