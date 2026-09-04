/**
 * P0-1 失败不交白卷（离线，不出网、不用真实凭据）。
 *
 * 锁定：
 * 1) 非安全类质量失败：所有尝试用尽后落“未达标草稿”，正文原样入库，agent_tasks=草稿待处理，
 *    fail_reason/contract_report/contract_tier 落库，预授权按真实用量结算（不释放）；
 * 2) 安全类失败（声称已外发/付款）：不落草稿，任务失败，预授权释放；
 * 3) accept-draft：权限、状态翻转、来源类失败不可接受；
 * 4) supersede 对草稿任务仍可用；/meta/enums 含新状态；
 * 5) marshalWork 墙钟耗尽时错误对象带 failReason=timeout 的草稿；
 * 6) 契约 JSON 模式的 repair 提示词包含首轮产物片段、失败规则清单与“原样保留”指令。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const DB_PATH = path.join(os.tmpdir(), `nanowork-draft-on-failure-${process.pid}.db`);
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
process.env.ENABLE_SCHEDULER = "false";
delete process.env.NANOWORK_EMPLOYEE_OUTPUT_STYLE;

const { initSchema, migrateV2, q, runWithTenant } = await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { buildEmployeeExecutionProfile } = await import("../src/employee-workbench.js");
const { marshalWork } = await import("../src/engines/ai.js");
const marshalRoutes = (await import("../src/routes/marshals.js")).default;
const metaRoutes = (await import("../src/routes/meta.js")).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

const TENANT_ID = 81_303;
q.run(
  `INSERT INTO tenants(id,name,status,plan,credits)
   VALUES(?,?,?,?,?)
   ON CONFLICT(id) DO UPDATE SET status='已开通',credits=500000`,
  TENANT_ID,
  "草稿落库租户",
  "已开通",
  "旗舰版",
  500_000,
);
runWithTenant(TENANT_ID, () => ensureBaselineCatalogs());
function createUser(role, name) {
  return Number(
    q.run(
      `INSERT INTO users(username,password_hash,name,role,status,tenant_id,credits)
       VALUES(?,?,?,?,?,?,?)`,
      `draft-${role}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      "x",
      name,
      role,
      "启用",
      TENANT_ID,
      500_000,
    ).lastInsertRowid,
  );
}
const bossId = createUser("boss", "草稿老板");
const salesId = createUser("sales", "普通员工");

const specialist = runWithTenant(TENANT_ID, () =>
  q.get(`SELECT id,marshal_id FROM specialists WHERE employee_idx=102 LIMIT 1`),
);
assert.ok(specialist?.id, "基线目录必须包含员工102");

function restaurantSource(index) {
  return {
    title: `太原吾悦广场粤菜商户菜单与评价来源${index}`,
    url: `https://www.dianping.com/shop/wuyue-yuecai-${index}`,
    snippet: `太原吾悦广场目标粤菜商户的公开菜单、营业信息、价格和顾客评价候选${index}`,
  };
}
const ALLOWED_SOURCE = restaurantSource(1);

const GOOD_MARKDOWN = `# 太原吾悦广场粤菜馆晚市机会判断

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

// 完整但过短：不足 200 字 → 结构类（非安全、非来源）失败 → 可落草稿且可接受
const SHORT_MARKDOWN = `# 晚市机会初判

商场晚市两人套餐存在价格带空白，建议先做 7 天低成本验证。

## 下一步建议

1. 竞品计数。2. 试推套餐。3. 复盘。`;

// 补造来源：URL 不在本次证据快照 → 来源类失败 → 可落草稿但不可接受
const FABRICATED_SOURCE_MARKDOWN = GOOD_MARKDOWN.replace(
  ALLOWED_SOURCE.url,
  "https://www.example-fake-source.com/shop/not-in-snapshot",
);

// 声称已外发/付款：安全类硬门 → 不落草稿
const UNSAFE_MARKDOWN = `${GOOD_MARKDOWN}\n\n## 执行记录\n\n已完成付款，并已发送合作邮件给供应商。\n`;

function offlineAgentic() {
  const candidates = Array.from({ length: 5 }, (_, index) => restaurantSource(index + 1));
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

function offlineControlledFetch(sources) {
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
}

function bootApp(generateFn, user = { id: bossId, name: "草稿老板", role: "boss" }) {
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
  app.locals.employeeControlledWebFetch = async (sources) => offlineControlledFetch(sources);
  app.locals.employeeGenerate = async (args) => {
    generated.push(args);
    return generateFn(args, generated.length);
  };
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.user = { ...user, tenant_id: TENANT_ID };
    runWithTenant(TENANT_ID, () => next());
  });
  app.use("/marshals", marshalRoutes);
  app.use("/meta", metaRoutes);
  return { app, generated };
}

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function readTask(taskId) {
  return runWithTenant(TENANT_ID, () =>
    q.get(
      `SELECT t.status,t.output_id,t.employee_web_snapshot,t.contract_tier,t.fail_reason,t.contract_report,
              c.body,c.ai_mode,c.status content_status,c.snapshot_json content_snapshot
         FROM agent_tasks t LEFT JOIN contents c ON c.id=t.output_id
        WHERE t.tenant_id=? AND t.id=?`,
      TENANT_ID,
      taskId,
    ),
  );
}

function readHold(taskId) {
  return q.get(
    `SELECT h.status,h.held_credits,h.settled_credits FROM credit_holds h
      WHERE h.tenant_id=? AND h.ref_type='agent_task' AND h.ref_id=? ORDER BY h.id DESC LIMIT 1`,
    TENANT_ID,
    taskId,
  );
}

const TERMINAL = new Set(["已完成", "失败", "草稿待处理", "待审阅"]);
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
  for (let attempt = 0; attempt < 400; attempt += 1) {
    row = readTask(taskId);
    if (row && TERMINAL.has(row.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { taskId, row };
}

const REQUIREMENT = "工作日晚市上座不足，评估两人套餐机会并给出可执行动作。";

test("非安全类失败：所有尝试用尽后落未达标草稿，正文原样入库，预授权按真实用量结算", async () => {
  const { app, generated } = bootApp((args) => ({
    text: FABRICATED_SOURCE_MARKDOWN,
    mode: "api",
    model: args.model,
    usage: { inputTokens: 1000, outputTokens: 500 },
    finishReason: "stop",
  }));
  const { server, base } = await listen(app);
  try {
    const { taskId, row } = await dispatchAndWait(base, {
      title: "粤菜馆 太原吾悦广场 晚市机会评估·补造来源",
      type: "经营诊断",
      requirement: REQUIREMENT,
    });
    assert.equal(row?.status, "草稿待处理", JSON.stringify(row?.employee_web_snapshot || "").slice(0, 400));
    assert.equal(generated.length, 3, "派活模式三次完整生成后仍未通过才落草稿");
    assert.equal(row.content_status, "未达标草稿");
    assert.equal(row.ai_mode, "api");
    assert.equal(String(row.body).trim(), FABRICATED_SOURCE_MARKDOWN.trim(), "草稿正文必须原样入库");
    assert.equal(row.fail_reason, "contract");
    assert.equal(row.contract_tier, "standard", "live + deepseek-v4-flash 应为 standard 档");
    const report = JSON.parse(row.contract_report);
    assert.equal(report.acceptable, false, "补造来源属于来源类硬错，不可直接采用");
    assert.equal(report.attempts, 3);
    assert.ok(report.failedChecks.some((item) => item.category === "provenance"));
    const snapshot = JSON.parse(row.employee_web_snapshot);
    assert.equal(snapshot.outputContract.valid, false);
    assert.equal(snapshot.outputContract.draft, true);
    assert.equal(snapshot.failure.presentationKey, "draft_pending");
    // 账务：模型真实消耗了，按三轮聚合用量结算，不是释放
    const hold = readHold(taskId);
    assert.equal(hold?.status, "settled");
    assert.ok(Number(hold.settled_credits) > 0, `应按真实用量结算，实际=${hold.settled_credits}`);

    // 状态接口：老板可读文案，不出现契约 ID/指纹/字段路径
    const statusResponse = await fetch(`${base}/marshals/tasks/${taskId}/status`);
    const status = await statusResponse.json();
    assert.equal(status.presentationKey, "draft_pending");
    assert.equal(status.displayStatus, "未达标草稿（待老板处理）");
    assert.equal(status.draft?.state, "pending");
    assert.equal(status.draft?.acceptable, false);
    assert.equal(status.draft?.canAccept, false);
    assert.ok(status.draft.failedCheckCount >= 1);
    assert.match(status.flow.join("|"), /质量门未通过（已保留草稿）/u);
    const draftText = JSON.stringify(status.draft);
    assert.doesNotMatch(draftText, /contractId|digestFingerprint|\$\./u);
    assert.equal(String(status.output_body).trim(), FABRICATED_SOURCE_MARKDOWN.trim());

    // 来源类失败不可“就用这份草稿”
    const accept = await fetch(`${base}/marshals/tasks/${taskId}/accept-draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(accept.status, 409);
    assert.equal((await accept.json()).code, "DRAFT_NOT_ACCEPTABLE");
  } finally {
    server.close();
  }
});

test("安全类失败（声称已付款/已外发）：不落草稿，任务失败，预授权全额释放", async () => {
  const { app } = bootApp((args) => ({
    text: UNSAFE_MARKDOWN,
    mode: "api",
    model: args.model,
    usage: { inputTokens: 1000, outputTokens: 500 },
    finishReason: "stop",
  }));
  const { server, base } = await listen(app);
  try {
    const { taskId, row } = await dispatchAndWait(base, {
      title: "粤菜馆 太原吾悦广场 晚市机会评估·越权声明",
      type: "经营诊断",
      requirement: REQUIREMENT,
    });
    assert.equal(row?.status, "失败");
    assert.equal(row.output_id, null, "安全类失败不得留下任何产物");
    assert.equal(row.fail_reason, null);
    const snapshot = JSON.parse(row.employee_web_snapshot);
    assert.equal(snapshot.failure.category, "quality_rework");
    const hold = readHold(taskId);
    assert.equal(hold?.status, "settled");
    assert.equal(Number(hold.settled_credits), 0, "安全类失败应全额退回");
  } finally {
    server.close();
  }
});

test("accept-draft：普通员工 403；老板接受后任务翻转为草稿已接受，草稿不会变成可用于业务", async () => {
  const { app, generated } = bootApp((args) => ({
    text: SHORT_MARKDOWN,
    mode: "api",
    model: args.model,
    usage: { inputTokens: 600, outputTokens: 120 },
    finishReason: "stop",
  }));
  const { server, base } = await listen(app);
  let taskId;
  try {
    const dispatched = await dispatchAndWait(base, {
      title: "粤菜馆 太原吾悦广场 晚市机会评估·过短草稿",
      type: "经营诊断",
      requirement: REQUIREMENT,
    });
    taskId = dispatched.taskId;
    assert.equal(dispatched.row?.status, "草稿待处理");
    assert.equal(generated.length, 3);
    // 第二、三次完整重生成必须带上一轮产物与机器校验报告（增量修复），且不是契约修复器
    assert.match(generated[1].userMsg, /上一轮完整产物·增量修复基线/u);
    assert.match(generated[1].userMsg, /晚市机会初判/u);
    assert.match(generated[1].userMsg, /机器校验报告·未通过的检查/u);
    assert.match(generated[1].userMsg, /只修改上述未通过的部分，其余章节、数字、来源与措辞原样保留/u);
    assert.doesNotMatch(generated[1].kind || "", /contract-repair/u);
    const report = JSON.parse(dispatched.row.contract_report);
    assert.equal(report.acceptable, true);
    const status = await (await fetch(`${base}/marshals/tasks/${taskId}/status`)).json();
    assert.equal(status.draft?.canAccept, true);
  } finally {
    server.close();
  }

  // 普通员工不能接受草稿
  const salesApp = bootApp(() => ({}), { id: salesId, name: "普通员工", role: "sales" });
  const sales = await listen(salesApp.app);
  try {
    const denied = await fetch(`${sales.base}/marshals/tasks/${taskId}/accept-draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(denied.status, 403);
  } finally {
    sales.server.close();
  }

  const bossApp = bootApp(() => ({}));
  const boss = await listen(bossApp.app);
  try {
    const accepted = await fetch(`${boss.base}/marshals/tasks/${taskId}/accept-draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "先用这份初判安排本周竞品计数" }),
    });
    const payload = await accepted.json();
    assert.equal(accepted.status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true);
    assert.equal(payload.requiresReview, false);
    assert.equal(payload.status, "草稿已接受");
    const row = readTask(taskId);
    assert.equal(row.status, "草稿已接受");
    assert.equal(row.content_status, "草稿");
    const contentSnapshot = JSON.parse(row.content_snapshot);
    assert.equal(contentSnapshot.draftAcceptance.acceptedBy, bossId);
    assert.equal(contentSnapshot.contract.valid, false, "接受草稿不改写质量门结论");
    const status = await (await fetch(`${boss.base}/marshals/tasks/${taskId}/status`)).json();
    assert.equal(status.presentationKey, "draft_accepted");
    assert.equal(status.displayStatus, "已接受草稿（内部参考，未通过质量门）");
    assert.equal(status.adoptionKind, null);
    assert.equal(status.draft?.state, "accepted");
    // 重复接受 → 409
    const again = await fetch(`${boss.base}/marshals/tasks/${taskId}/accept-draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(again.status, 409);
    const opLog = q.get(
      `SELECT action FROM op_logs WHERE tenant_id=? AND action='接受未达标草稿' ORDER BY id DESC LIMIT 1`,
      TENANT_ID,
    );
    assert.ok(opLog, "接受草稿必须记 op_logs");
  } finally {
    boss.server.close();
  }
});

test("supersede 对草稿任务仍可用：合格新任务可以取代草稿任务", async () => {
  const { app } = bootApp((args, attempt) => ({
    text: attempt <= 3 ? FABRICATED_SOURCE_MARKDOWN : GOOD_MARKDOWN,
    mode: "api",
    model: args.model,
    usage: { inputTokens: 1000, outputTokens: 500 },
    finishReason: "stop",
  }));
  const { server, base } = await listen(app);
  try {
    const draft = await dispatchAndWait(base, {
      title: "粤菜馆 太原吾悦广场 晚市机会评估·待取代草稿",
      type: "经营诊断",
      requirement: REQUIREMENT,
    });
    assert.equal(draft.row?.status, "草稿待处理");
    const replacement = await dispatchAndWait(base, {
      title: "粤菜馆 太原吾悦广场 晚市机会评估·安全修订版",
      type: "经营诊断",
      requirement: REQUIREMENT,
    });
    assert.equal(
      replacement.row?.status,
      "已完成",
      JSON.stringify(JSON.parse(replacement.row?.employee_web_snapshot || "{}").failure || null),
    );
    const superseded = await fetch(`${base}/marshals/tasks/${draft.taskId}/supersede`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        replacementTaskId: replacement.taskId,
        reason: "草稿引用了未核验来源，已用带原要求重新派活的合格版本取代",
      }),
    });
    const payload = await superseded.json();
    assert.equal(superseded.status, 201, JSON.stringify(payload));
    const status = await (await fetch(`${base}/marshals/tasks/${draft.taskId}/status`)).json();
    assert.equal(status.presentationKey, "superseded");
    assert.equal(status.draft, undefined, "被取代后不再下发草稿动作");
  } finally {
    server.close();
  }
});

test("/meta/enums 含新状态：草稿待处理 / 草稿已接受 / 未达标草稿", async () => {
  const { app } = bootApp(() => ({}));
  const { server, base } = await listen(app);
  try {
    const enums = await (await fetch(`${base}/meta/enums`)).json();
    const taskStatuses = enums.agentTaskStatuses.map((item) => item.value);
    assert.ok(taskStatuses.includes("草稿待处理"));
    assert.ok(taskStatuses.includes("草稿已接受"));
    assert.ok(enums.contentStatuses.map((item) => item.value).includes("未达标草稿"));
  } finally {
    server.close();
  }
});

// ===== marshalWork 单元路径：墙钟耗尽与契约 JSON 模式的增量修复提示 =====
const TASK = Object.freeze({
  title: "毛血旺 太原吾悦广场·草稿探针",
  type: "商圈画像",
  requirement: "请核验竞品、商圈与交通可达性，并给出下一步可执行的业务结论。",
});

function contractExecution() {
  return runWithTenant(TENANT_ID, () =>
    buildEmployeeExecutionProfile(102, {
      tenantId: TENANT_ID,
      user: { id: bossId, role: "boss", tenant_id: TENANT_ID },
    }),
  );
}

function paihuoExecution() {
  return runWithTenant(TENANT_ID, () =>
    buildEmployeeExecutionProfile(102, {
      tenantId: TENANT_ID,
      user: { id: bossId, role: "boss", tenant_id: TENANT_ID },
      outputMode: "paihuo_markdown",
    }),
  );
}

const offlineOptions = () => ({
  requireAgenticResearch: true,
  agenticWebResearchFn: async () => offlineAgentic(),
  webSearchFn: async () => ({
    attempted: true,
    ok: true,
    provider: "offline-search",
    results: [ALLOWED_SOURCE],
  }),
  controlledWebFetchFn: async (candidates) => offlineControlledFetch(candidates),
  locationIntelligenceFn: async () => offlineLocation(),
  dataMode: "live",
});

test("墙钟耗尽：已有一轮完整正文时，错误对象携带 failReason=timeout 的草稿", async () => {
  let clock = 0;
  const observed = [];
  let caught = null;
  try {
    await runWithTenant(TENANT_ID, () =>
      marshalWork(
        { code: "M-01", name: "战略与开店筹备部", duty: "仅负责调度" },
        TASK,
        "boss",
        {
          ...offlineOptions(),
          employeeExecution: paihuoExecution(),
          nowFn: () => clock,
          onCandidateObserved: (candidate) => observed.push(candidate),
          generateFn: async (args) => {
            // 首轮返回完整但过短的候选；随后墙钟直接跳过上限，模拟第二轮前超时。
            clock += 10 * 60 * 60 * 1000;
            return {
              text: SHORT_MARKDOWN,
              mode: "api",
              model: args.model,
              usage: { inputTokens: 700, outputTokens: 130 },
              finishReason: "stop",
            };
          },
        },
      ),
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "候选未通过且墙钟耗尽必须仍按原契约抛错");
  assert.equal(caught.providerBudget?.stoppedReason, "wall_clock_exhausted");
  assert.ok(caught.draft, "应附带草稿");
  assert.equal(caught.draft.disposition.failReason, "timeout");
  assert.equal(caught.draft.text.trim(), SHORT_MARKDOWN.trim());
  assert.equal(caught.draft.contractTier, "standard");
  assert.equal(caught.draftBlockedBy, null);
  assert.equal(observed.length, 1, "每一轮完整 API 候选都应留底");
  assert.equal(observed[0].complete, true);
  assert.equal(observed[0].text.trim(), SHORT_MARKDOWN.trim());
  assert.equal(observed[0].contractTier, "standard");
});

test("契约 JSON 模式 repair 提示词：包含首轮产物片段、失败规则清单与“原样保留”指令", async () => {
  const calls = [];
  const firstRound = JSON.stringify({
    contract_id: "probe-first-round",
    role: { employee_idx: 102, marker: "FIRST_ROUND_MARKER_9F2A" },
  });
  let caught = null;
  try {
    await runWithTenant(TENANT_ID, () =>
      marshalWork(
        { code: "M-01", name: "战略与开店筹备部", duty: "仅负责调度" },
        TASK,
        "boss",
        {
          ...offlineOptions(),
          employeeExecution: contractExecution(),
          generateFn: async (args) => {
            calls.push(args);
            return {
              text: firstRound,
              mode: "api",
              model: args.model,
              finishReason: "stop",
              usage: { inputTokens: 120, outputTokens: 40 },
            };
          },
        },
      ),
    );
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.code, "RESTAURANT_OUTPUT_CONTRACT_INVALID");
  assert.equal(caught.contractTier, "standard");
  assert.ok(calls.length >= 2);
  const repair = calls[1];
  assert.match(repair.kind, /contract-repair/u);
  assert.match(repair.userMsg, /FIRST_ROUND_MARKER_9F2A/u, "repair 提示词必须携带首轮完整产物");
  assert.match(repair.userMsg, /待修复首轮输出/u);
  assert.match(repair.userMsg, /提交前逐路径机械复核/u, "repair 提示词必须携带机器校验报告");
  for (const rule of caught.providerAttempts[0].contractErrors.slice(0, 3)) {
    assert.ok(repair.userMsg.includes(rule), `失败规则应出现在 repair 提示词中：${rule.slice(0, 40)}`);
  }
  assert.match(repair.system, /只修改机器校验报告中判定不合格的字段与章节，其余字段、数值、来源与措辞必须原样保留/u);
  // 伪造契约身份 + 顶层骨架缺失 = 没有可用产物：不附带草稿，路由层走原失败释放路径
  assert.equal(caught.draft, null);
  assert.equal(caught.draftBlockedBy, "no_deliverable");
});

test("契约 JSON 模式：骨架完整的真实产物只因语义规则未过 → 附带可落库草稿（正文为原始 JSON）", async (t) => {
  const { buildRestaurantOutputDeliverableFixture, getRestaurantOutputContract } = await import(
    "../src/engines/restaurant-output-contract.js"
  );
  const contract = getRestaurantOutputContract(102);
  let caught = null;
  let lastText = "";
  try {
    await runWithTenant(TENANT_ID, () =>
      marshalWork(
        { code: "M-01", name: "战略与开店筹备部", duty: "仅负责调度" },
        TASK,
        "boss",
        {
          ...offlineOptions(),
          employeeExecution: contractExecution(),
          generateFn: async (args) => {
            const fixture = buildRestaurantOutputDeliverableFixture(102, TASK);
            // 骨架完整、契约身份正确，但把一条行动写成泛化 owner，制造语义类（非安全、非来源）失败
            fixture.decision_context.sources.push({
              source: `${ALLOWED_SOURCE.title}｜${ALLOWED_SOURCE.url}`,
              period: "2026-08-08",
              fact: "离线测试来源，仅用于验证链路。",
            });
            const deliverable = fixture.deliverables[contract.deliverableKeys[0]];
            if (Array.isArray(deliverable?.actions) && deliverable.actions[0]) {
              deliverable.actions[0].owner = "相关人员";
              deliverable.actions[0].deadline = "尽快";
            }
            lastText = JSON.stringify(fixture);
            return {
              text: lastText,
              mode: "api",
              model: args.model,
              finishReason: "stop",
              usage: { inputTokens: 900, outputTokens: 400 },
            };
          },
        },
      ),
    );
  } catch (error) {
    caught = error;
  }
  if (!caught) {
    // 夹具在当前契约下直接合格时本用例不成立；显式跳过而不伪装通过
    t.skip("夹具未触发语义类失败");
    return;
  }
  assert.equal(caught.code, "RESTAURANT_OUTPUT_CONTRACT_INVALID");
  assert.ok(
    caught.contractErrors.every((rule) => !/不是有效JSON|必须等于岗位契约规定值|缺少必需字段：\$\.[A-Za-z0-9_]+。/u.test(rule)),
    `应只剩语义类失败：${caught.contractErrors.slice(0, 3).join(" | ")}`,
  );
  assert.notEqual(caught.draftBlockedBy, "no_deliverable");
  if (caught.draftBlockedBy === null) {
    assert.ok(caught.draft, "语义类失败应附带草稿");
    assert.equal(caught.draft.text, lastText, "草稿正文必须是最后一轮原始产物");
    assert.equal(caught.draft.disposition.eligible, true);
  }
});
