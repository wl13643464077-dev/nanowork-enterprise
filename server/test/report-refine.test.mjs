import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import express from "express";

process.env.NANOWORK_TEST_TEMPLATE_AI = "1";
const DBP = path.join(os.tmpdir(), `nw-report-refine-${process.pid}-${Date.now()}.db`);
process.env.NANOWORK_DB = DBP;

const { db, q, initSchema, migrateV2, runWithTenant, setConfig } = await import("../src/db.js");
const { default: taskCenterRouter } = await import("../src/routes/task-center.js");
const { default: filesRouter } = await import("../src/routes/files.js");
const { parseRefinedReport, buildReportRefinePrompt } = await import("../src/engines/report-refine.js");

initSchema();
migrateV2();

q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'报告优化验收企业','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET credits=excluded.credits`);
const bossId = Number(q.run(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
   VALUES('refine-boss','x','优化老板','boss','启用',1)`,
).lastInsertRowid);
const strangerId = Number(q.run(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
   VALUES('refine-stranger','x','别家店长','store_manager','启用',1)`,
).lastInsertRowid);
const marshalId = Number(q.run(
  `INSERT INTO marshals(code,name,title,emoji,online,sort) VALUES('M-01','战略与开店筹备部','元帅','🧭',1,1)`,
).lastInsertRowid);
const specialistId = Number(q.run(
  `INSERT INTO specialists(marshal_id,name,duty,employee_idx,key,person,emoji,description,profile_json,group_name,sort)
   VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  marshalId, "商圈与竞品洞察", "盯竞品价格产品口碑变化", 102, "compete", "钱商圈", "🧑‍💼", "盯竞品", JSON.stringify({}), "战略与开店筹备部", 2,
).lastInsertRowid);

const ORIGINAL = [
  "# 太原吾悦广场毛血旺商圈竞品分析",
  "",
  "## 老板摘要",
  "已定位中心并核验同品类商户 3 家；人均 45-68 元。",
  "",
  "## 竞品明细",
  "| 门店 | 人均 | 距中心 |",
  "| --- | --- | --- |",
  "| 老码头火锅 | 68 元 | 320 米 |",
  "| 巴蜀毛血旺 | 45 元 | 510 米 |",
  "",
  "## 下一步建议",
  "先做工作日午市客流观察。",
  "",
  "## 数据来源与时效",
  "| 项目 | 来源 | 抓取时间 | 状态 |",
  "| --- | --- | --- | --- |",
  "| 商圈中心定位 | 高德地图 Web 服务 API | 2026-09-10 | 已获取 |",
].join("\n");

const contentId = Number(q.run(
  `INSERT INTO contents(type,title,body,status,creator_id,marshal_id) VALUES('报告','商圈竞品分析',?,'可使用',?,?)`,
  ORIGINAL, bossId, marshalId,
).lastInsertRowid);
const taskId = Number(q.run(
  `INSERT INTO agent_tasks(marshal_id,specialist_id,title,type,requirement,status,output_id,created_by)
   VALUES(?,?,?,?,?,?,?,?)`,
  marshalId, specialistId, "太原吾悦广场毛血旺商圈竞品分析", "常规", "分析3公里内同品类竞品", "已完成", contentId, bossId,
).lastInsertRowid);
const runningTaskId = Number(q.run(
  `INSERT INTO agent_tasks(marshal_id,specialist_id,title,type,requirement,status,created_by)
   VALUES(?,?,?,?,?,?,?)`,
  marshalId, specialistId, "还在跑的任务", "常规", "x", "生成中", bossId,
).lastInsertRowid);

function makeApp(userId = bossId, role = "boss") {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    runWithTenant(1, () => {
      req.user = { id: userId, name: "u", role, tenant_id: 1 };
      req.requestId = "refine-test";
      next();
    });
  });
  app.use("/api/task-center", taskCenterRouter);
  app.use("/api/files", filesRouter);
  return app;
}

async function withServer(fn, ...appArgs) {
  const server = makeApp(...appArgs).listen(0, "127.0.0.1");
  const port = await new Promise((resolve) => server.once("listening", () => resolve(server.address().port)));
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

after(() => {
  try { db.close(); } catch { /* closed */ }
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
});

test("前端契约：任务中心餐饮报告下挂多轮优化面板，面板只调 refine 接口并按版本导出", () => {
  const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "src");
  const taskCenter = fs.readFileSync(path.join(webRoot, "pages", "TaskCenter.tsx"), "utf8");
  const panel = fs.readFileSync(path.join(webRoot, "components", "ReportRefinePanel.tsx"), "utf8");
  const downloads = fs.readFileSync(path.join(webRoot, "components", "TaskDocumentDownloads.tsx"), "utf8");
  assert.match(taskCenter, /import ReportRefinePanel from '\.\.\/components\/ReportRefinePanel'/u);
  assert.match(taskCenter, /detail\.kind === 'restaurant' &&\s*!detail\.draft &&\s*detail\.state !== 'running'/u, "只有已交付的餐饮报告才能继续优化");
  assert.match(taskCenter, /<ReportRefinePanel key=\{`refine:\$\{detail\.id\}`\} taskId=\{Number\(detail\.id\)\} \/>/u);
  assert.match(panel, /api\.get\(`\/task-center\/restaurant\/\$\{taskId\}\/refine`/u);
  assert.match(panel, /api\.post\(\s*`\/task-center\/restaurant\/\$\{taskId\}\/refine`/u);
  assert.match(panel, /quickInstructions\.map/u, "快捷修改意图来自服务端");
  assert.match(panel, /generateUrl: active\.generateUrl/u, "每个版本按自己的来源导出文件");
  assert.match(panel, /没交出完整新版则不扣费/u);
  assert.match(downloads, /agent_task_revision/u, "下载组件放行修订稿来源");
});

test("解析新版报告：剥围栏、分离修改摘要、过短正文判无效", () => {
  const parsed = parseRefinedReport("```markdown\n# 标题\n\n这是足够长的正文内容，用来验证解析器能正确切分修改摘要与正文部分，并保留 Markdown 结构。\n\n---\n【本次修改摘要】压缩了摘要，删掉了铺垫。\n```");
  assert.equal(parsed.changeSummary, "压缩了摘要，删掉了铺垫。");
  assert.match(parsed.markdown, /^# 标题/u);
  assert.doesNotMatch(parsed.markdown, /本次修改摘要/u);
  assert.equal(parseRefinedReport("好的"), null);
  assert.equal(parseRefinedReport(""), null);
});

test("提示词：只改要求部分、不新增事实、保留数据来源段、历史修改要求进入上下文", () => {
  const { system, userMsg } = buildReportRefinePrompt({
    task: { title: "任务A", requirement: "要求B", employee_person: "钱商圈", employee_name: "商圈与竞品洞察", employee_duty: "盯竞品" },
    baseMarkdown: "# 现稿",
    baseVersion: 2,
    history: [{ version: 1, instruction: "更简短" }, { version: 2, instruction: "加行动清单" }],
    instruction: "改成对比表",
  });
  assert.match(system, /只改老板本轮要求改的部分/u);
  assert.match(system, /不得新增任何原报告里没有/u);
  assert.match(system, /数据来源与时效.*原样保留/u);
  assert.match(system, /【本次修改摘要】/u);
  assert.match(userMsg, /第1版：更简短/u);
  assert.match(userMsg, /第2版：加行动清单/u);
  assert.match(userMsg, /【现稿·第2版全文】/u);
  assert.match(userMsg, /【老板本轮修改要求】改成对比表/u);
});

test("优化状态：原稿可读、快捷指令齐全、生成中任务不可优化、外人 404", async () => {
  await withServer(async (base) => {
    const state = await (await fetch(`${base}/api/task-center/restaurant/${taskId}/refine`)).json();
    assert.equal(state.task.id, taskId);
    assert.equal(state.task.employee.person, "钱商圈");
    assert.match(state.original.markdown, /老板摘要/u);
    assert.equal(state.revisions.length, 0);
    assert.equal(state.latestVersion, 0);
    assert.ok(state.quickInstructions.length >= 4);
    assert.equal(state.availability.available, false, "未配置真实 AI 通道时不可优化");
    assert.match(state.availability.reason, /真实 AI 通道未配置/u);

    const running = await (await fetch(`${base}/api/task-center/restaurant/${runningTaskId}/refine`)).json();
    assert.equal(running.availability.available, false);
    assert.match(running.availability.reason, /还没有交付报告/u);
  });
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/task-center/restaurant/${taskId}/refine`);
    assert.equal(response.status, 404);
  }, strangerId, "store_manager");
});

test("多轮优化：每轮生成独立版本、真实结算、历史版本保留、修订稿可导出", async () => {
  const nativeFetch = globalThis.fetch;
  const providerBodies = [];
  process.env.AI360_API_KEY = "test-refine-360-key";
  setConfig("ai_provider_default", "360");
  let scenario = "ok";
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith("https://api.360.cn/")) return nativeFetch(url, options);
    const body = JSON.parse(options.body);
    providerBodies.push(body);
    if (scenario === "chatty") {
      return new Response(JSON.stringify({
        id: "refine-chatty",
        choices: [{ message: { content: "好的，已按要求修改。" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 500, completion_tokens: 10, amount: "0.001" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const userText = String(body.messages.at(-1).content);
    const round = /第1版全文/u.test(userText) ? 2 : 1;
    const markdown = round === 1
      ? "# 太原吾悦广场毛血旺商圈竞品分析\n\n## 老板摘要\n已核验同品类商户 3 家，人均 45-68 元，建议先看午市客流。\n\n## 竞品明细\n| 门店 | 人均 | 距中心 |\n| --- | --- | --- |\n| 老码头火锅 | 68 元 | 320 米 |\n| 巴蜀毛血旺 | 45 元 | 510 米 |\n\n## 下一步建议\n先做工作日午市客流观察。\n\n## 数据来源与时效\n| 项目 | 来源 | 抓取时间 | 状态 |\n| --- | --- | --- | --- |\n| 商圈中心定位 | 高德地图 Web 服务 API | 2026-09-10 | 已获取 |"
      : "# 太原吾悦广场毛血旺商圈竞品分析\n\n## 老板摘要\n已核验同品类商户 3 家，人均 45-68 元。\n\n## 下一步建议\n| 事项 | 负责人 | 时限 | 验收 |\n| --- | --- | --- | --- |\n| 午市客流观察 | 店长 | 3 天内 | 记录表 |\n\n## 数据来源与时效\n| 项目 | 来源 | 抓取时间 | 状态 |\n| --- | --- | --- | --- |\n| 商圈中心定位 | 高德地图 Web 服务 API | 2026-09-10 | 已获取 |";
    return new Response(JSON.stringify({
      id: `refine-${round}`,
      choices: [{ message: { content: `${markdown}\n\n【本次修改摘要】第${round}轮：按要求调整。` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 900, completion_tokens: 400, amount: "0.006" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await withServer(async (base) => {
      const balanceBefore = q.get("SELECT credits FROM tenants WHERE id=1").credits;
      const first = await postJson(`${base}/api/task-center/restaurant/${taskId}/refine`, { instruction: "更简短，摘要压到两句" });
      assert.equal(first.response.status, 200, JSON.stringify(first.payload));
      assert.equal(first.payload.revision.version, 1);
      assert.equal(first.payload.revision.baseRevisionId, null);
      assert.match(first.payload.revision.markdown, /^# 太原吾悦广场/u);
      assert.doesNotMatch(first.payload.revision.markdown, /本次修改摘要/u);
      assert.equal(first.payload.revision.changeSummary, "第1轮：按要求调整。");
      assert.equal(first.payload.billing.state, "settled");
      assert.ok(first.payload.billing.chargedCredits > 0);
      const firstSystem = String(providerBodies.at(-1).messages[0].content);
      assert.match(firstSystem, /钱商圈/u);
      assert.match(String(providerBodies.at(-1).messages.at(-1).content), /【现稿·第0版全文】/u);
      assert.deepEqual(providerBodies.at(-1).thinking, { type: "disabled" });

      const second = await postJson(`${base}/api/task-center/restaurant/${taskId}/refine`, { instruction: "加行动清单" });
      assert.equal(second.response.status, 200, JSON.stringify(second.payload));
      assert.equal(second.payload.revision.version, 2);
      assert.equal(second.payload.revision.baseRevisionId, first.payload.revision.id);
      assert.match(String(providerBodies.at(-1).messages.at(-1).content), /第1版：更简短，摘要压到两句/u, "历史修改要求进入上下文");
      assert.match(String(providerBodies.at(-1).messages.at(-1).content), /【现稿·第1版全文】/u, "默认基于最新版本继续改");

      const state = await (await fetch(`${base}/api/task-center/restaurant/${taskId}/refine`)).json();
      assert.equal(state.revisions.length, 2);
      assert.equal(state.latestVersion, 2);
      assert.match(state.original.markdown, /老板摘要/u, "原稿原样保留");
      assert.equal(q.get("SELECT status FROM agent_tasks WHERE id=?", taskId).status, "已完成", "任务采纳状态不变");
      assert.equal(q.get("SELECT body FROM contents WHERE id=?", contentId).body, ORIGINAL, "contents 原文不改写");

      // 修订稿导出 PDF/Word 走 agent_task_revision 来源
      const exported = await postJson(`${base}/api/files/artifacts/source/agent_task_revision/${second.payload.revision.id}`, { formats: ["docx"] });
      assert.equal(exported.response.status, 200, JSON.stringify(exported.payload));
      const docx = exported.payload.deliverables.find((item) => item.format === "docx");
      assert.ok(docx?.downloadUrl);
      assert.equal(docx.draft, false);
      assert.match(exported.payload.source?.title || docx.title, /第2版/u);

      // 模型只回了一句聊天话：不落库、不扣费
      const chargedSoFar = balanceBefore - q.get("SELECT credits FROM tenants WHERE id=1").credits;
      assert.ok(chargedSoFar > 0);
      scenario = "chatty";
      const failed = await postJson(`${base}/api/task-center/restaurant/${taskId}/refine`, { instruction: "再短一点" });
      assert.equal(failed.response.status, 422, JSON.stringify(failed.payload));
      assert.equal(failed.payload.code, "REPORT_REFINE_INVALID_OUTPUT");
      assert.equal(failed.payload.billing.state, "released");
      assert.equal(q.get("SELECT COUNT(*) n FROM agent_task_revisions WHERE task_id=?", taskId).n, 2);
      assert.equal(balanceBefore - q.get("SELECT credits FROM tenants WHERE id=1").credits, chargedSoFar, "失败轮不扣费");

      const empty = await postJson(`${base}/api/task-center/restaurant/${taskId}/refine`, { instruction: "   " });
      assert.equal(empty.response.status, 400);
    });
    await withServer(async (base) => {
      const denied = await postJson(`${base}/api/task-center/restaurant/${taskId}/refine`, { instruction: "改一下" });
      assert.equal(denied.response.status, 404, "外人不能优化别人的报告");
    }, strangerId, "store_manager");
  } finally {
    globalThis.fetch = nativeFetch;
    delete process.env.AI360_API_KEY;
    q.run("DELETE FROM sys_config WHERE key='ai_provider_default'");
  }
});
