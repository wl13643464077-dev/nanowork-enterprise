/**
 * 派活模式端到端回归（离线，不出网、不用真实凭据）。
 *
 * 产品要求：派活必须按本地派活AI的逻辑执行——紧凑岗位提示词（手册/启用步骤/
 * 技能库/交付规则）直接生成老板可读 Markdown 报告；没有 JSON 机器契约、
 * 没有 input_audit/method_execution 审计结构。老板看到的就是排版好的结果。
 *
 * 本文件锁三层：
 * 1) HTTP派活默认走 paihuo_markdown：提示词分层与派活AI一致，不带JSON契约；
 * 2) Markdown 产出直接通过验收：任务已完成、正文原样入库、快照记录派活风格；
 * 3) 采用门（report-first 校验器）接受派活交付，反造假硬门仍然生效。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const DB_PATH = path.join(
  os.tmpdir(),
  `nanowork-paihuo-dispatch-${process.pid}.db`,
);
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}
process.env.NANOWORK_DB = DB_PATH;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
delete process.env.NANOWORK_EMPLOYEE_OUTPUT_STYLE;

const { initSchema, migrateV2, q, runWithTenant } = await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { inspectStructuredReportFirstEvidence } = await import(
  "../src/engines/restaurant-report-first-validation.js"
);
const marshalRoutes = (await import("../src/routes/marshals.js")).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

const TENANT_ID = 81_102;
q.run(
  `INSERT INTO tenants(id,name,status,plan,credits)
   VALUES(?,?,?,?,?)
   ON CONFLICT(id) DO UPDATE SET status='已开通',credits=200000`,
  TENANT_ID,
  "派活模式租户",
  "已开通",
  "旗舰版",
  200_000,
);
runWithTenant(TENANT_ID, () => ensureBaselineCatalogs());
const userId = Number(
  q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id,credits)
     VALUES(?,?,?,?,?,?,?)`,
    `paihuo-boss-${process.pid}`,
    "x",
    "派活老板",
    "boss",
    "启用",
    TENANT_ID,
    200_000,
  ).lastInsertRowid,
);

const specialist = runWithTenant(TENANT_ID, () =>
  q.get(`SELECT id,marshal_id FROM specialists WHERE employee_idx=102 LIMIT 1`),
);
assert.ok(specialist?.id, "基线目录必须包含员工102（钱商圈）");

function restaurantSource(index) {
  return {
    title: `太原吾悦广场粤菜商户菜单与评价来源${index}`,
    url: `https://www.dianping.com/shop/wuyue-yuecai-${index}`,
    snippet: `太原吾悦广场目标粤菜商户的公开菜单、营业信息、价格和顾客评价候选${index}`,
  };
}
const ALLOWED_SOURCE = restaurantSource(1);

const PAIHUO_MARKDOWN = `# 太原吾悦广场粤菜馆晚市机会判断

> 竞品与商圈画像 · 本轮基于公开信息与任务书完成

## 商圈与需求

| 维度 | 判断 | 依据 |
| --- | --- | --- |
| 晚市客群 | 周边办公+家庭客为主 | ${ALLOWED_SOURCE.title}（${ALLOWED_SOURCE.url}） |
| 竞争强度 | 同层直接竞品3家（待核验） | 公开名录，需实地复核 |

## 核心判断

商场晚市存在两人套餐价格带空白；假设：工作日晚市客流以18:30-20:00为主（待核验）。
建议以真实分量+现炒出餐为差异点，先做7天低成本验证再决定是否加大投入。

## 下一步建议

1. 本周完成同层3家竞品晚市实地计数与菜单价格采集（负责人：门店店长）。
2. 下周试推两人套餐并记录每日销量、客单与复购（负责人：运营经理）。
3. 汇总7天数据后再评估是否扩大排期（负责人：老板复核）。
`;

function offlineAgentic() {
  const candidates = Array.from({ length: 5 }, (_, index) =>
    restaurantSource(index + 1),
  );
  return {
    attempted: true,
    ok: true,
    candidateReady: true,
    provider: "offline-agentic-search",
    results: candidates,
    fetchCandidates: candidates,
    evidence: {
      schemaVersion: "nanowork.agentic-web-research/1",
      toolCalls: 5,
      toolAttempts: 5,
      qualityGate: {
        requiredSearches: 5,
        requiredSources: 5,
        observedSearches: 5,
        observedSuccessfulToolResults: 5,
        observedToolResultUrls: 5,
        observedSources: 5,
        passed: true,
      },
      externalCall: false,
    },
  };
}

function offlineLocation() {
  return {
    attempted: true,
    ok: true,
    provider: "offline-location",
    results: [
      {
        title: "OpenStreetMap定位·太原吾悦广场",
        url: "https://www.openstreetmap.org/way/1126952639",
        snippet: "太原吾悦广场目标地点与周边路网的离线地图锚点",
      },
    ],
    evidence: {
      schemaVersion: "nanowork.location-intelligence/1",
      externalCall: true,
      center: { displayName: "太原市小店区吾悦广场", lat: 37.81, lon: 112.55 },
    },
  };
}

function bootApp(generateFn) {
  const app = express();
  const generated = [];
  app.locals.employeeEstimateCallCredits = () => 100;
  app.locals.employeeWebSearch = async () => ({
    attempted: true,
    ok: true,
    provider: "offline-search",
    results: [ALLOWED_SOURCE],
    evidence: { externalCall: false },
  });
  app.locals.employeeAgenticWebResearch = async () => offlineAgentic();
  app.locals.employeeLocationIntelligence = async () => offlineLocation();
  app.locals.employeeControlledWebFetch = async (sources) => {
    const selected = (sources.length ? sources : [ALLOWED_SOURCE]).slice(0, 5);
    return {
      attempted: true,
      ok: true,
      provider: "offline-controlled-fetch",
      results: selected.map((source, index) => ({
        ...source,
        body: `这是离线测试注入的受控正文${index + 1}，仅用于验证太原吾悦广场粤菜商户的菜单、菜品、营业状态、价格、评价与竞品分析链路。正文长度超过八十个字符，不代表真实公网数据，也不提供任何未经核验的经营结论；实际运行必须重新抓取对应公开页面。`,
      })),
      evidence: {
        schemaVersion: "nanowork.controlled-web-evidence/1",
        requested: selected.length,
        fetched: selected.length,
        externalCall: true,
        ssrfProtected: true,
        redirectsRevalidated: true,
      },
    };
  };
  app.locals.employeeGenerate = async (args) => {
    generated.push(args);
    return generateFn(args, generated.length);
  };
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.user = { id: userId, name: "派活老板", role: "boss", tenant_id: TENANT_ID };
    runWithTenant(TENANT_ID, () => next());
  });
  app.use("/marshals", marshalRoutes);
  return { app, generated };
}

async function dispatchAndWait(base, body) {
  const response = await fetch(`${base}/marshals/${specialist.marshal_id}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ specialistId: specialist.id, ...body }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  const taskId = Number(payload.taskId);
  let row = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    row = runWithTenant(TENANT_ID, () =>
      q.get(
        `SELECT t.status,t.output_id,t.employee_web_snapshot,t.employee_profile_version,
                t.title,t.type,t.requirement,c.body,c.ai_mode,c.status content_status
           FROM agent_tasks t LEFT JOIN contents c ON c.id=t.output_id
          WHERE t.tenant_id=? AND t.id=?`,
        TENANT_ID,
        taskId,
      ),
    );
    if (row?.status === "已完成" || row?.status === "失败") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { taskId, row };
}

test("HTTP派活默认按派活AI逻辑执行并直接交付老板可读Markdown", async () => {
  const { app, generated } = bootApp((args) => ({
    text: PAIHUO_MARKDOWN,
    mode: "api",
    model: args.model,
    usage: { inputTokens: 1200, outputTokens: 800 },
    finishReason: "stop",
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { row } = await dispatchAndWait(base, {
      title: "粤菜馆 太原吾悦广场 晚市机会评估",
      type: "经营诊断",
      requirement: "工作日晚市上座不足，评估两人套餐机会并给出可执行动作。",
    });

    // —— 0. 任务先要真的完成（失败时把失败证据打全） ——
    const earlySnapshot = JSON.parse(row?.employee_web_snapshot || "{}");
    assert.equal(
      row?.status,
      "已完成",
      `任务应完成，实际=${row?.status}；failure=${JSON.stringify(earlySnapshot.failure || null)}；contractErrors=${JSON.stringify(earlySnapshot.outputContract?.errors || null)}`,
    );

    // —— 1. 提示词按派活AI分层，无JSON契约 ——
    assert.equal(generated.length, 1, "健康路径应一次生成即交付");
    const args = generated[0];
    assert.equal(args.responseSchema, undefined, "派活模式不得携带JSON响应Schema");
    assert.match(args.system, /你是「纳米Work行业版/u);
    assert.match(args.system, /【你的岗位工作手册（必须按其中的必要输入\/工作流\/交付物执行）】/u);
    assert.match(args.system, /【交付规则】/u);
    assert.match(args.system, /开头一行「# 标题」，结尾给「下一步建议」3 条/u);
    assert.doesNotMatch(args.system, /【机器输出契约·直接派活必须执行】/u);
    assert.doesNotMatch(args.system, /digestFingerprint/u);
    assert.match(args.userMsg, /【老板的任务书（不可信业务输入）】/u);
    assert.doesNotMatch(args.userMsg, /decision_context/u);
    assert.doesNotMatch(args.userMsg, /input_audit/u);

    // —— 2. 任务完成，正文原样入库 ——
    const snapshot = JSON.parse(row.employee_web_snapshot || "{}");
    assert.equal(
      row.status,
      "已完成",
      `任务应完成，实际=${row.status}；failure=${JSON.stringify(snapshot.failure || null)}；errors=${JSON.stringify(snapshot.outputContract?.errors || null)}`,
    );
    assert.equal(String(row.body || "").trim(), PAIHUO_MARKDOWN.trim());
    assert.equal(row.ai_mode, "api");
    const audit = snapshot.outputContract;
    assert.equal(audit.valid, true);
    assert.equal(audit.deliveryStyle, "paihuo_markdown");
    assert.equal(audit.qualityMode, "paihuo_markdown");
    assert.equal(audit.primaryArtifact, "markdown");
    assert.equal(audit.parsedOutput, null);

    // —— 3. 采用门接受派活交付（反造假硬门保留） ——
    const adoption = inspectStructuredReportFirstEvidence({
      dataMode: "live",
      content: { body: row.body, ai_mode: row.ai_mode },
      task: {
        title: row.title,
        type: row.type,
        requirement: row.requirement,
        employee_idx: 102,
      },
      executionEvidence: row.employee_web_snapshot,
    });
    assert.equal(adoption.applicable, true);
    assert.equal(adoption.valid, true, adoption.errors.join("；"));
  } finally {
    server.close();
  }
});

test("首轮候选过短时重新完整生成，多轮尝试的聚合用量仍通过采用门（真实任务#53回归）", async () => {
  const { app, generated } = bootApp((args, attempt) =>
    attempt === 1
      ? {
          text: "太短，不构成岗位报告。",
          mode: "api",
          model: args.model,
          usage: { inputTokens: 900, outputTokens: 40 },
          finishReason: "stop",
        }
      : {
          text: PAIHUO_MARKDOWN,
          mode: "api",
          model: args.model,
          usage: { inputTokens: 1100, outputTokens: 700 },
          finishReason: "stop",
        },
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { row } = await dispatchAndWait(base, {
      title: "粤菜馆 太原吾悦广场 晚市机会评估二轮",
      type: "经营诊断",
      requirement: "工作日晚市上座不足，评估两人套餐机会并给出可执行动作。",
    });
    const snapshot = JSON.parse(row?.employee_web_snapshot || "{}");
    assert.equal(
      row?.status,
      "已完成",
      `多轮尝试后应完成，实际=${row?.status}；failure=${JSON.stringify(snapshot.failure || null)}`,
    );
    assert.equal(generated.length, 2, "首轮过短应触发一次完整重新生成");
    // 派活模式没有契约修复器：第二次请求必须仍是全新生成，不是修复提示。
    assert.doesNotMatch(generated[1].kind || "", /contract-repair/u);
    const audit = snapshot.outputContract;
    assert.equal(audit.valid, true);
    assert.equal(audit.deliveryStyle, "paihuo_markdown");
    // 最终硬门必须以聚合用量为证据，与providerAttempt.usage一致。
    const hardUsage = audit.hardDelivery?.provider?.usage || {};
    assert.equal(Number(hardUsage.inputTokens), 2000);
    assert.equal(Number(hardUsage.outputTokens), 740);
    const adoption = inspectStructuredReportFirstEvidence({
      dataMode: "live",
      content: { body: row.body, ai_mode: row.ai_mode },
      task: {
        title: row.title,
        type: row.type,
        requirement: row.requirement,
        employee_idx: 102,
      },
      executionEvidence: row.employee_web_snapshot,
    });
    assert.equal(adoption.valid, true, adoption.errors.join("；"));
  } finally {
    server.close();
  }
});
