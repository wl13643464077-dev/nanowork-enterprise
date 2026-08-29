import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

import {
  assertForbiddenNoSideEffects,
  assertNoHeldCredits,
  assertSettledBillingReadback,
  businessEffectSnapshot,
  matrixSummary,
  ROLE_FLOW_MATRIX,
} from "../../scripts/lib/role-flow-matrix.mjs";
import { validContentEmployeeOutputForPrompt } from "./helpers/content-output-fixtures.mjs";

const TENANT_ID = 9701;
const DB_PATH = path.join(
  os.tmpdir(),
  `nanowork-role-flow-matrix-${process.pid}-${Date.now()}.db`,
);
const DB_FILES = [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`];
for (const target of DB_FILES) fs.rmSync(target, { force: true });

process.env.NANOWORK_DB = DB_PATH;
// 本文件覆盖的是JSON机器契约执行链（作为可切换回退保留）；
// 派活Markdown主链路的HTTP行为由 paihuo-dispatch-markdown.test.mjs 覆盖。
process.env.NANOWORK_EMPLOYEE_OUTPUT_STYLE = "contract_json";
process.env.NODE_ENV = "test";
process.env.SEED_DEMO = "false";
process.env.ENABLE_SCHEDULER = "false";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
process.env.JWT_SECRET = "Role-Flow-Matrix-Local-Only#2026";
process.env.YUNWU_API_KEY = "role-flow-loopback-stub-only";
process.env.OPENAI_API_KEY = " ";
process.env.ANTHROPIC_API_KEY = " ";
process.env.BOCHA_API_KEY = " ";
process.env.TAVILY_API_KEY = " ";
process.env.SERPER_API_KEY = " ";
process.env.AI_INTERACTIVE_CHAT_TIMEOUT_MS = "5000";
process.env.AI_INTERACTIVE_EMBED_TIMEOUT_MS = "1000";

const nativeFetch = globalThis.fetch.bind(globalThis);
const externalNetworkAttempts = [];
globalThis.fetch = async (input, init) => {
  const raw = String(
    typeof input === "string" || input instanceof URL
      ? input
      : input?.url || input,
  );
  const url = new URL(raw);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    externalNetworkAttempts.push(raw);
    throw new Error("role-flow matrix forbids external network access");
  }
  return nativeFetch(input, init);
};

const { db, initSchema, migrateV2, setConfig } = await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { buildRestaurantOutputDeliverableFixture } =
  await import("../src/engines/restaurant-output-contract.js");
const { createContentEmployeeWorkbenchRouter } =
  await import("../src/routes/content-employee-workbench.js");
const { createApp } = await import("../src/app.js");
const { signToken } = await import("../src/util.js");

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

const ALL_MODULES = [
  "dashboard",
  "growth",
  "content",
  "activities",
  "marshals",
  "advisor",
  "execution",
  "analysis",
  "assets",
  "system",
];

db.prepare(
  `INSERT INTO tenants(
  id,name,status,plan,modules,data_mode,credits,total_recharged
) VALUES(?,?, '已开通','旗舰版',?,'live',1000000,0)`,
).run(TENANT_ID, "三角色穿刺隔离企业", JSON.stringify(ALL_MODULES));

const insertUser = db.prepare(`INSERT INTO users(
  username,password_hash,name,role,status,tenant_id,modules,manager_id,auth_version
) VALUES(?, 'x', ?, ?, '启用', ?, ?, ?, 0)`);
const bossId = Number(
  insertUser.run(
    "role_flow_boss",
    "穿刺老板",
    "boss",
    TENANT_ID,
    JSON.stringify(ALL_MODULES),
    null,
  ).lastInsertRowid,
);
const opsId = Number(
  insertUser.run(
    "role_flow_ops",
    "穿刺运营总监",
    "ops_director",
    TENANT_ID,
    JSON.stringify(ALL_MODULES),
    bossId,
  ).lastInsertRowid,
);
const managerId = Number(
  insertUser.run(
    "role_flow_manager",
    "穿刺直属经理",
    "manager",
    TENANT_ID,
    JSON.stringify(ALL_MODULES),
    opsId,
  ).lastInsertRowid,
);
const staffId = Number(
  insertUser.run(
    "role_flow_staff",
    "穿刺普通员工",
    "sales",
    TENANT_ID,
    JSON.stringify(["content", "execution", "marshals"]),
    managerId,
  ).lastInsertRowid,
);
const restrictedStaffId = Number(
  insertUser.run(
    "role_flow_restricted",
    "未开内容模块员工",
    "sales",
    TENANT_ID,
    JSON.stringify(["execution"]),
    managerId,
  ).lastInsertRowid,
);

const users = {
  boss: { id: bossId, name: "穿刺老板", role: "boss", tenant_id: TENANT_ID },
  ops: {
    id: opsId,
    name: "穿刺运营总监",
    role: "ops_director",
    tenant_id: TENANT_ID,
  },
  manager: {
    id: managerId,
    name: "穿刺直属经理",
    role: "manager",
    tenant_id: TENANT_ID,
  },
  staff: {
    id: staffId,
    name: "穿刺普通员工",
    role: "sales",
    tenant_id: TENANT_ID,
  },
  restrictedStaff: {
    id: restrictedStaffId,
    name: "未开内容模块员工",
    role: "sales",
    tenant_id: TENANT_ID,
  },
};
const tokens = Object.fromEntries(
  Object.entries(users).map(([key, user]) => [
    key,
    signToken({ ...user, auth_version: 0 }),
  ]),
);

const ACTIVITY_PLAN = {
  theme: "门店真实经营复盘会",
  flow: [
    { time: "18:00", item: "签到并确认顾客联系授权" },
    { time: "18:20", item: "核验菜单、食安与过敏原提示" },
  ],
  materials: ["签到表", "过敏原提示卡", "真实成本记录表"],
  invites: "只联系已授权顾客，名单由负责人逐条复核",
  sop: ["核对场地容量", "确认菜单与食安", "记录真实到场和成交数据"],
  kpi: {
    邀约确认率: "按本企业真实邀约记录计算",
    报名到场率: "按签到记录计算",
    现场成交率: "按真实订单计算",
    加微率: "只统计已授权顾客",
    ROI: "按真实收入与成本计算",
  },
  budgetNote: "预算逐项由老板审批，未知成本保持待确认",
};

const TOOLBOX_RESULT = `# 今日必发真实交付

## 今日内容安排

门店锚点为太原万象城川味小馆，围绕工作日晚市到店准备三条内容，不新增优惠或库存事实。

1. 选题一：拍摄门头与晚市准备过程，发布前核验当天营业和接待能力。
2. 选题二：拍摄真实出品细节，用现场素材说明顾客可核验的信息。
3. 选题三：由员工回答一个高频问题，在朋友圈或视频号发布并记录真实咨询。

## 素材与审核

- 素材包括门头、出品过程和真实环境，人物画面必须取得授权。
- 负责人审核价格、可售、营业时间与渠道文案后再发布。
- 24小时后复盘曝光、咨询和到店反馈，不把自然波动写成确定效果。

## 执行责任表

| 负责人 | 时点 | 具体动作 | 可核验产出 |
| --- | --- | --- | --- |
| 运营负责人 | 今日10:00 | 核验当天可售信息并记录 | 核验清单与现场截图 |
| 拍摄员工 | 今日14:00 | 拍摄门头与真实出品画面 | 三组授权素材文件 |
| 审核主管 | 发布前 | 审核文案并记录修改意见 | 审核记录与最终文案 |`;

const providerCalls = [];
const providerApp = express();
providerApp.use(express.json({ limit: "4mb" }));
providerApp.post("/v1/embeddings", (req, res) => {
  providerCalls.push({ kind: "embedding", model: req.body?.model });
  res.json({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] });
});
providerApp.post("/v1/chat/completions", (req, res) => {
  const messages = JSON.stringify(req.body?.messages || []);
  const kind = req.body?.response_format
    ? "activity_plan"
    : messages.includes("经营工具「今日必发」")
      ? "toolbox"
      : messages.includes("活动复盘")
        ? "activity_review"
        : "advisor";
  providerCalls.push({
    kind,
    model: req.body?.model,
    structured: Boolean(req.body?.response_format),
  });
  const content =
    kind === "activity_plan"
      ? JSON.stringify(ACTIVITY_PLAN)
      : kind === "toolbox"
        ? TOOLBOX_RESULT
        : kind === "advisor"
          ? "【今日目标】完成门店经营数据核验 ｜【执行人】穿刺直属经理 ｜【截止】今日18:00 ｜【检查标准】形成可追溯核验清单\n结论：先核事实口径，再安排执行。"
          : "活动复盘结论：数据已按真实记录核对。下一场由运营负责人在活动前一天核验触达授权、菜单食安与预算，活动后24小时形成数据复盘表。";
  res.json({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 240, completion_tokens: 120 },
  });
});
const providerServer = providerApp.listen(0, "127.0.0.1");
const providerPort = await new Promise((resolve) => {
  providerServer.once("listening", () =>
    resolve(providerServer.address().port),
  );
});
setConfig("yunwu_base_url", `http://127.0.0.1:${providerPort}/v1`);

const contentJobs = [];
let contentJobCursor = 0;
const roleFlowResearchCandidates = Array.from({ length: 6 }, (_, index) => ({
  title: index === 0 ? "本机餐饮验收来源" : `本机业务验收来源${index + 1}`,
  url:
    index === 0
      ? "https://example.invalid/restaurant-evidence"
      : `https://source-${index + 1}.example/role-flow-evidence`,
  snippet: "本地离线受控研究候选，仅用于验证真实执行链结构。",
}));
const roleFlowAgenticResearch = async () => ({
  attempted: true,
  ok: true,
  candidateReady: true,
  provider: "role-flow-loopback-agentic-search",
  results: roleFlowResearchCandidates,
  fetchCandidates: roleFlowResearchCandidates,
  evidence: {
    schemaVersion: "nanowork.agentic-web-research/1",
    externalCall: true,
    toolAttempts: 6,
    toolCalls: 6,
    qualityGate: {
      observedSearches: 6,
      observedSuccessfulToolResults: 6,
      observedToolResultUrls: 6,
      passed: true,
    },
    candidateGate: {
      observedSearches: 6,
      observedSuccessfulToolResults: 6,
      observedToolResultUrls: 6,
      passed: true,
    },
  },
});
const roleFlowControlledFetch = async (candidates) => ({
  attempted: true,
  ok: true,
  provider: "role-flow-loopback-controlled-fetch",
  results: (Array.isArray(candidates) ? candidates : []).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.snippet,
    body: `本地受控正文证据：${item.title}仅用于离线角色穿刺，验证候选必须经过受控读取后才能进入模型；这段正文超过八十个汉字，不声称任何真实经营结果，也不包含外部命令、凭据、价格或未经核验的业务事实。`,
  })),
  evidence: {
    schemaVersion: "nanowork.controlled-web-evidence/1",
    externalCall: false,
    ssrfProtected: true,
    failures: [],
  },
});
const contentRouter = createContentEmployeeWorkbenchRouter({
  generateFn: async (args) => {
    const output = validContentEmployeeOutputForPrompt(args.userMsg);
    assert.ok(output, "content stub must resolve the employee output contract");
    return {
      text: JSON.stringify(output),
      mode: "api",
      model: "gpt-5.5",
      usage: { inputTokens: 180, outputTokens: 100 },
    };
  },
  agenticWebResearchFn: roleFlowAgenticResearch,
  controlledWebFetchFn: roleFlowControlledFetch,
  scheduleFn: (task) => {
    const job = Promise.resolve().then(task);
    contentJobs.push(job);
  },
  textModelForFn: () => "gpt-5.5",
});

function restaurantTaskFromPrompt(args, employeeIdx) {
  const prompt = String(args.userMsg || "");
  return {
    title: prompt.match(/^\s*任务：(.+)$/mu)?.[1]?.trim() || "三角色业务穿刺",
    type: prompt.match(/^\s*类型：(.+)$/mu)?.[1]?.trim() || "执行方案",
    requirement:
      prompt
        .match(
          /【原任务要求·不得改题】\n([\s\S]*?)(?=\n\n【本次可用材料证据·事实边界】)/u,
        )?.[1]
        ?.trim() || `数字员工 #${employeeIdx} 离线验收要求`,
  };
}

const app = createApp({
  serveStatic: false,
  contentEmployeeWorkbenchRouter: contentRouter,
  aiGuardFor: () => (req, _res, next) => {
    req.aiGuard = { defer: () => () => {} };
    next();
  },
  appLocals: {
    employeeEstimateCallCredits: () => 200,
    employeeWebSearch: async (query) => ({
      ok: true,
      provider: "role-flow-loopback-search",
      results: [
        {
          title: "本机餐饮验收来源",
          url: "https://example.invalid/restaurant-evidence",
          snippet: String(query).slice(0, 120),
        },
      ],
    }),
    // 餐饮岗位 101-108 的真实执行绑定要求 agentic research + 受控正文核验。
    // 这里使用本地、可复用的证据快照夹具，不让正向闭环因缺少新研究链而退回模板失败。
    employeeAgenticWebResearch: roleFlowAgenticResearch,
    employeeControlledWebFetch: roleFlowControlledFetch,
    employeeGenerate: async (args) => {
      const employeeIdx = Number(
        args.responseSchema?.schema?.properties?.role?.properties?.employee_idx
          ?.enum?.[0],
      );
      const task = restaurantTaskFromPrompt(args, employeeIdx);
      const output = buildRestaurantOutputDeliverableFixture(employeeIdx, task);
      // 新联网链要求 decision_context.sources 逐字复用本轮受控快照的标题与 URL；
      // 把本地证据快照写入正向夹具，验证“检索→生成→契约”完整链路。
      if (
        output?.decision_context &&
        Array.isArray(output.decision_context.sources)
      ) {
        output.decision_context.sources = [
          {
            source:
              "本机餐饮验收来源｜https://example.invalid/restaurant-evidence",
            period: "2026-08-08",
            fact: "本地受控正文证据仅用于离线角色穿刺，未声称真实经营结果。",
          },
        ];
      }
      return {
        text: JSON.stringify(output),
        mode: "api",
        model: args.model || "gpt-5.5",
        usage: { inputTokens: 220, outputTokens: 120 },
      };
    },
  },
});
const appServer = app.listen(0, "127.0.0.1");
const appPort = await new Promise((resolve) => {
  appServer.once("listening", () => resolve(appServer.address().port));
});
const BASE_URL = `http://127.0.0.1:${appPort}`;

async function api(actor, route, { method = "GET", body } = {}) {
  const response = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${tokens[actor]}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

async function drainContentJobs() {
  while (contentJobCursor < contentJobs.length) {
    const job = contentJobs[contentJobCursor];
    contentJobCursor += 1;
    await job;
  }
}

async function waitForRow(sql, params, predicate, label, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = db.prepare(sql).get(...params);
    if (row && predicate(row)) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} did not reach the expected state`);
}

function count(sql, ...params) {
  return Number(db.prepare(sql).get(...params)?.count || 0);
}

function deniedSnapshot(label, before, result, allowedStatuses = [403]) {
  assertForbiddenNoSideEffects({
    label,
    responseStatus: result.status,
    before,
    after: businessEffectSnapshot(db, TENANT_ID),
    allowedStatuses,
  });
}

const scenarioResults = [];
function pass(module, scenario, evidence) {
  scenarioResults.push({
    module,
    scenario,
    evidence,
    ok: true,
    externalNetworkAttempts: 0,
  });
}

test("三角色业务穿刺矩阵定义覆盖五个核心业务域", () => {
  assert.deepEqual(
    ROLE_FLOW_MATRIX.map((item) => item.id),
    [
      "restaurant_employee",
      "content_employee",
      "activities",
      "toolbox",
      "advisor",
    ],
  );
  assert.ok(ROLE_FLOW_MATRIX.every((item) => item.positiveActors.length));
  assert.ok(
    ROLE_FLOW_MATRIX.every((item) =>
      item.terminalEvidence.includes("credit_holds"),
    ),
  );
  const restaurant = ROLE_FLOW_MATRIX.find(
    (item) => item.id === "restaurant_employee",
  );
  assert.ok(
    restaurant.actionPermissions.dispatch.allowedActors.includes("sales"),
  );
  assert.ok(
    restaurant.actionPermissions.dispatch.allowedActors.includes("manager"),
  );
  assert.deepEqual(restaurant.actionPermissions.review.forbiddenActors, [
    "sales",
  ]);
  assert.equal(restaurant.forbiddenActors.includes("sales"), false);
  const content = ROLE_FLOW_MATRIX.find(
    (item) => item.id === "content_employee",
  );
  assert.deepEqual(content.actionPermissions.dispatch.allowedActors, [
    "sales",
    "manager",
    "ops_director",
    "boss",
  ]);
  assert.deepEqual(content.actionPermissions.review.forbiddenActors, ["sales"]);
  assert.equal(content.forbiddenActors.includes("sales"), false);
  const acceptanceSource = fs.readFileSync(
    new URL("../../scripts/accept-role-flow-matrix.mjs", import.meta.url),
    "utf8",
  );
  assert.match(acceptanceSource, /PASS_OFFLINE_ROLE_FLOW_MATRIX/u);
  assert.match(acceptanceSource, /realCloudValidated=false/u);
  assert.doesNotMatch(acceptanceSource, /PASS_ROLE_FLOW_MATRIX/u);
});

test("403 零副作用快照能识别插入、更新、删除和租户余额变化", () => {
  const before = businessEffectSnapshot(db, TENANT_ID);
  assert.ok(Array.isArray(before.tasks.rows));
  assert.ok(Array.isArray(before.activities.rows));
  assert.ok(Array.isArray(before.notifications.rows));
  assert.ok(Array.isArray(before.op_logs.rows));

  for (const [label, mutate] of [
    ["insert", (snapshot) => snapshot.tasks.rows.push({ id: 999_001 })],
    [
      "update",
      (snapshot) => {
        snapshot.tenant = {
          ...snapshot.tenant,
          credits: Number(snapshot.tenant.credits) - 1,
        };
      },
    ],
  ]) {
    const afterSnapshot = structuredClone(before);
    mutate(afterSnapshot);
    assert.throws(
      () =>
        assertForbiddenNoSideEffects({
          label,
          responseStatus: 403,
          before,
          after: afterSnapshot,
        }),
      /changed business state/u,
    );
  }
  const deleteBefore = structuredClone(before);
  deleteBefore.tasks.rows.push({ id: 999_002 });
  const deleteAfter = structuredClone(deleteBefore);
  deleteAfter.tasks.rows.pop();
  assert.throws(
    () =>
      assertForbiddenNoSideEffects({
        label: "delete",
        responseStatus: 403,
        before: deleteBefore,
        after: deleteAfter,
      }),
    /changed business state/u,
  );
});

test("老板、管理层、普通员工离线穿刺：正向闭环可回读，403 全部零副作用", async () => {
  // 1) 餐饮数字员工：默认 auto 下管理层派活直接完成，普通员工仍不能越权改写结果；
  // 内部质量与账务门通过后自动沉淀知识/资产，不再制造“请老板审批自己”的节点。
  const restaurantDispatch = await api(
    "manager",
    "/api/employee-workbench/restaurant/106/dispatch",
    {
      method: "POST",
      body: {
        title: "数字员工三角色穿刺·采纳",
        type: "执行方案",
        requirement:
          "基于已提供的门店事实形成可核验方案；缺失事实必须列待补项，不得编造。",
      },
    },
  );
  assert.equal(
    restaurantDispatch.status,
    200,
    JSON.stringify(restaurantDispatch.payload),
  );
  const restaurantTaskId = Number(restaurantDispatch.payload.taskId);
  const restaurantTask = await waitForRow(
    "SELECT * FROM agent_tasks WHERE tenant_id=? AND id=?",
    [TENANT_ID, restaurantTaskId],
    (row) => row.status !== "生成中",
    "restaurant employee task",
  );
  assert.equal(restaurantTask.status, "已完成");
  assert.ok(Number(restaurantTask.output_id) > 0);
  const restaurantOutput = db
    .prepare("SELECT * FROM contents WHERE tenant_id=? AND id=?")
    .get(TENANT_ID, restaurantTask.output_id);
  assert.equal(restaurantOutput.status, "可使用");
  assert.equal(
    count(
      "SELECT COUNT(*) count FROM approvals WHERE tenant_id=? AND target_type='content' AND target_id=? AND status='待审核'",
      TENANT_ID,
      restaurantOutput.id,
    ),
    0,
  );
  assertSettledBillingReadback(
    db,
    TENANT_ID,
    "agent_task",
    restaurantTaskId,
    "restaurant employee generation",
  );

  const beforeRestaurantDenied = businessEffectSnapshot(db, TENANT_ID);
  const restaurantDenied = await api(
    "staff",
    `/api/marshals/outputs/${restaurantOutput.id}/review`,
    { method: "POST", body: { decision: "adopt", reason: "普通员工不应审阅" } },
  );
  deniedSnapshot(
    "restaurant employee staff review",
    beforeRestaurantDenied,
    restaurantDenied,
  );
  pass(
    "restaurant_employee",
    "staff_403_zero_side_effects",
    "review denied before mutation",
  );

  const restaurantKnowledge = db
    .prepare(
      "SELECT id,enabled FROM kb_docs WHERE tenant_id=? AND source_type='content' AND source_id=? ORDER BY id DESC LIMIT 1",
    )
    .get(TENANT_ID, restaurantOutput.id);
  const restaurantAsset = db
    .prepare(
      "SELECT id,status FROM biz_assets WHERE tenant_id=? AND source_type='content' AND source_id=? ORDER BY id DESC LIMIT 1",
    )
    .get(TENANT_ID, restaurantOutput.id);
  assert.ok(restaurantKnowledge?.id > 0);
  assert.equal(restaurantKnowledge.enabled, 1);
  assert.ok(restaurantAsset?.id > 0);
  assert.equal(restaurantAsset.status, "使用中");
  assert.equal(
    db
      .prepare("SELECT enabled FROM kb_docs WHERE tenant_id=? AND id=?")
      .get(TENANT_ID, restaurantKnowledge.id).enabled,
    1,
  );
  assert.equal(
    db
      .prepare("SELECT status FROM biz_assets WHERE tenant_id=? AND id=?")
      .get(TENANT_ID, restaurantAsset.id).status,
    "使用中",
  );
  pass(
    "restaurant_employee",
    "manager_dispatch_auto_adopt",
    `task#${restaurantTaskId}`,
  );

  // 同域第二条任务也遵循 Boss 测试期 auto：即使文案写着“等待审阅”，
  // 岗位偏好不能把内部结果重新降级为人工审批；外发动作仍另有授权门。
  const restaurantRejectDispatch = await api(
    "staff",
    "/api/employee-workbench/restaurant/106/dispatch",
    {
      method: "POST",
      body: {
        title: "数字员工三角色穿刺·驳回",
        type: "执行方案",
        requirement: "形成一份等待老板人工审阅的方案。",
      },
    },
  );
  assert.equal(restaurantRejectDispatch.status, 200);
  const rejectTaskId = Number(restaurantRejectDispatch.payload.taskId);
  const rejectTask = await waitForRow(
    "SELECT * FROM agent_tasks WHERE tenant_id=? AND id=?",
    [TENANT_ID, rejectTaskId],
    (row) => row.status !== "生成中",
    "restaurant reject task",
  );
  assert.equal(rejectTask.status, "已完成");
  assert.ok(Number(rejectTask.output_id) > 0);
  const rejectOutput = db
    .prepare("SELECT status FROM contents WHERE tenant_id=? AND id=?")
    .get(TENANT_ID, rejectTask.output_id);
  assert.equal(rejectOutput.status, "可使用");
  assert.equal(
    count(
      "SELECT COUNT(*) count FROM approvals WHERE tenant_id=? AND target_type='content' AND target_id=?",
      TENANT_ID,
      rejectTask.output_id,
    ),
    0,
  );
  pass(
    "restaurant_employee",
    "staff_dispatch_auto_adopt",
    `task#${rejectTaskId}`,
  );

  // 2) Paihuo 内容员工：普通员工可派活但不能改写已自动采用的内部结果；
  // 合法契约、正 token 与账务门通过后直接形成内容/素材，不创建人工审批单。
  const contentDispatch = await api(
    "staff",
    "/api/employee-workbench/content/8/dispatch",
    {
      method: "POST",
      body: {
        title: "分发官三角色业务穿刺",
        type: "平台发布包",
        requirement:
          "形成经过人工审阅后可继续登记发布的平台适配稿；不得执行外部发布。",
      },
    },
  );
  assert.equal(
    contentDispatch.status,
    200,
    JSON.stringify(contentDispatch.payload),
  );
  await drainContentJobs();
  const contentRunId = Number(contentDispatch.payload.runId);
  const contentRun = db
    .prepare("SELECT * FROM content_employee_runs WHERE tenant_id=? AND id=?")
    .get(TENANT_ID, contentRunId);
  assert.equal(contentRun.status, "已完成");
  assert.equal(JSON.parse(contentRun.snapshot_json).contractValid, true);
  assert.equal(
    JSON.parse(contentRun.snapshot_json).review?.decision,
    "auto_adopt",
  );
  assertSettledBillingReadback(
    db,
    TENANT_ID,
    "content_employee_run",
    contentRunId,
    "content employee generation",
  );

  const beforeContentDenied = businessEffectSnapshot(db, TENANT_ID);
  const contentDenied = await api(
    "staff",
    `/api/employee-workbench/content/8/runs/${contentRunId}/review`,
    {
      method: "POST",
      body: { decision: "adopt", opinion: "普通员工不应自审" },
    },
  );
  deniedSnapshot(
    "content employee self review",
    beforeContentDenied,
    contentDenied,
  );
  pass(
    "content_employee",
    "staff_403_zero_side_effects",
    "self-review denied before mutation",
  );

  // Boss/platform_super auto-adoption deliberately persists a material only;
  // publishable contents (and their approvals/assets) are created only after
  // an explicitly configured human adoption route.  Verify the canonical
  // material instead of expecting a content row that the policy forbids.
  const autoMaterial = db
    .prepare(
      "SELECT id,type,url,source_type,source_id,body_snapshot,artifact_snapshot_json FROM materials WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=? ORDER BY id DESC LIMIT 1",
    )
    .get(TENANT_ID, contentRunId);
  assert.ok(Number(autoMaterial?.id) > 0);
  assert.equal(autoMaterial.source_type, "content_employee_run");
  assert.equal(Number(autoMaterial.source_id), contentRunId);
  assert.ok(String(autoMaterial.body_snapshot || "").length > 0);
  assert.ok(String(autoMaterial.artifact_snapshot_json || "").length > 0);
  assert.equal(
    count(
      "SELECT COUNT(*) count FROM contents WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?",
      TENANT_ID,
      contentRunId,
    ),
    0,
  );
  assert.equal(
    count(
      "SELECT COUNT(*) count FROM approvals WHERE tenant_id=? AND target_type='content' AND target_id IN (SELECT id FROM contents WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?)",
      TENANT_ID,
      TENANT_ID,
      contentRunId,
    ),
    0,
  );
  assert.equal(
    count(
      "SELECT COUNT(*) count FROM materials WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?",
      TENANT_ID,
      contentRunId,
    ),
    1,
  );
  pass("content_employee", "staff_dispatch_auto_adopt", `run#${contentRunId}`);

  const contentRejectDispatch = await api(
    "staff",
    "/api/employee-workbench/content/8/dispatch",
    {
      method: "POST",
      body: {
        title: "分发官三角色驳回穿刺",
        type: "平台发布包",
        requirement: "形成一份等待老板审阅的平台发布包，不执行外部发布。",
      },
    },
  );
  assert.equal(contentRejectDispatch.status, 200);
  await drainContentJobs();
  const contentRejectRunId = Number(contentRejectDispatch.payload.runId);
  const contentRejectRun = db
    .prepare(
      "SELECT status,snapshot_json FROM content_employee_runs WHERE tenant_id=? AND id=?",
    )
    .get(TENANT_ID, contentRejectRunId);
  assert.equal(contentRejectRun.status, "已完成");
  assert.equal(
    JSON.parse(contentRejectRun.snapshot_json).review?.decision,
    "auto_adopt",
  );
  const contentRejectMaterial = db
    .prepare(
      "SELECT id,source_type,source_id FROM materials WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=? ORDER BY id DESC LIMIT 1",
    )
    .get(TENANT_ID, contentRejectRunId);
  assert.ok(Number(contentRejectMaterial?.id) > 0);
  assert.equal(contentRejectMaterial.source_type, "content_employee_run");
  assert.equal(Number(contentRejectMaterial.source_id), contentRejectRunId);
  assert.equal(
    count(
      "SELECT COUNT(*) count FROM contents WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?",
      TENANT_ID,
      contentRejectRunId,
    ),
    0,
  );
  assert.equal(
    count(
      "SELECT COUNT(*) count FROM approvals WHERE tenant_id=? AND target_type='content' AND target_id IN (SELECT id FROM contents WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?)",
      TENANT_ID,
      TENANT_ID,
      contentRejectRunId,
    ),
    0,
  );
  pass(
    "content_employee",
    "staff_dispatch_auto_adopt",
    `run#${contentRejectRunId}`,
  );

  // 3) 活动中心：经理建活动并生成草稿，运营初审、老板终审；复盘最终进入知识库。
  const activityCreated = await api("manager", "/api/activities", {
    method: "POST",
    body: {
      title: "三角色真实活动穿刺",
      type: "门店主题活动",
      date: "2026-09-18",
      target_join: 20,
      target_deal: 3,
      budget: 3000,
    },
  });
  assert.equal(
    activityCreated.status,
    200,
    JSON.stringify(activityCreated.payload),
  );
  const activityId = Number(activityCreated.payload.id);
  const activityPlan = await api(
    "manager",
    `/api/activities/${activityId}/plan`,
    {
      method: "POST",
      body: {
        goal: "验证真实到场与经营复盘流程",
        audience: "已授权触达的顾客",
        budget: "3000元内，逐项审批",
      },
    },
  );
  assert.equal(activityPlan.status, 200, JSON.stringify(activityPlan.payload));
  assert.equal(activityPlan.payload.billing.state, "settled");
  assertSettledBillingReadback(
    db,
    TENANT_ID,
    "activity",
    activityId,
    "activity plan generation",
  );

  const beforeActivityDenied = businessEffectSnapshot(db, TENANT_ID);
  const activityDenied = await api(
    "staff",
    `/api/activities/${activityId}/assignments`,
    {
      method: "POST",
      body: { assignments: [{ title: "越权任务", assigneeId: staffId }] },
    },
  );
  deniedSnapshot(
    "activity staff assignment",
    beforeActivityDenied,
    activityDenied,
  );
  pass(
    "activities",
    "staff_403_zero_side_effects",
    "assignment denied before mutation",
  );

  const planSubmitted = await api(
    "manager",
    `/api/activities/${activityId}/plan/submit`,
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(
    planSubmitted.status,
    200,
    JSON.stringify(planSubmitted.payload),
  );
  const opsApprovalId = Number(planSubmitted.payload.approvalId);
  const opsApproved = await api(
    "ops",
    `/api/sys/approvals/${opsApprovalId}/decide`,
    {
      method: "POST",
      body: { pass: true, reason: "运营已核验容量、食安、授权与预算。" },
    },
  );
  assert.equal(opsApproved.status, 200, JSON.stringify(opsApproved.payload));
  const bossApprovalId = Number(opsApproved.payload.nextApprovalId);
  const bossApproved = await api(
    "boss",
    `/api/sys/approvals/${bossApprovalId}/decide`,
    {
      method: "POST",
      body: { pass: true, reason: "老板终审通过，按真实数据执行。" },
    },
  );
  assert.equal(bossApproved.status, 200, JSON.stringify(bossApproved.payload));
  const approvedActivity = db
    .prepare("SELECT * FROM activities WHERE tenant_id=? AND id=?")
    .get(TENANT_ID, activityId);
  assert.equal(approvedActivity.plan_status, "已通过");
  assert.equal(
    count(
      "SELECT COUNT(*) count FROM approvals WHERE tenant_id=? AND target_type='activity_plan' AND target_id=? AND status='已通过'",
      TENANT_ID,
      activityId,
    ),
    2,
  );

  const activityUpdated = await api(
    "manager",
    `/api/activities/${activityId}`,
    {
      method: "PUT",
      body: {
        status: "已结束",
        invited: 20,
        signed_up: 12,
        arrived: 9,
        converted: 2,
        revenue: 1800,
        cost: 600,
        satisfaction: 4.5,
      },
    },
  );
  assert.equal(
    activityUpdated.status,
    200,
    JSON.stringify(activityUpdated.payload),
  );
  const activityReview = await api(
    "manager",
    `/api/activities/${activityId}/review`,
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(
    activityReview.status,
    200,
    JSON.stringify(activityReview.payload),
  );
  assert.equal(activityReview.payload.billing.state, "settled");
  assert.ok(Number(activityReview.payload.kbSync?.id) > 0);
  assertSettledBillingReadback(
    db,
    TENANT_ID,
    "activity_review",
    activityId,
    "activity review generation",
  );
  assert.equal(
    db
      .prepare("SELECT status FROM activities WHERE tenant_id=? AND id=?")
      .get(TENANT_ID, activityId).status,
    "已复盘",
  );
  assert.equal(
    db
      .prepare("SELECT enabled FROM kb_docs WHERE tenant_id=? AND id=?")
      .get(TENANT_ID, activityReview.payload.kbSync.id).enabled,
    1,
  );
  pass(
    "activities",
    "manager_plan_ops_review_boss_approve_kb",
    `activity#${activityId}`,
  );

  // 4) 工具箱：有内容模块的普通员工可运行；未开模块的同角色账号被 403 且零副作用。
  const beforeToolboxDenied = businessEffectSnapshot(db, TENANT_ID);
  const toolboxDenied = await api("restrictedStaff", "/api/toolbox/runs", {
    method: "POST",
    body: {
      toolKey: "hot",
      employeeIdx: 141,
      title: "不应创建的工具运行",
      inputs: {
        store: "太原万象城川味小馆",
        channels: ["朋友圈", "视频号"],
        focus: "工作日晚市到店",
      },
    },
  });
  deniedSnapshot("toolbox module guard", beforeToolboxDenied, toolboxDenied);
  pass(
    "toolbox",
    "staff_module_403_zero_side_effects",
    "run denied before mutation",
  );

  const toolboxRun = await api("staff", "/api/toolbox/runs", {
    method: "POST",
    body: {
      toolKey: "hot",
      employeeIdx: 141,
      title: "三角色今日必发穿刺",
      inputs: {
        store: "太原万象城川味小馆",
        channels: ["朋友圈", "视频号"],
        focus: "提升工作日晚市到店，不做虚假限量",
      },
    },
  });
  assert.equal(toolboxRun.status, 202, JSON.stringify(toolboxRun.payload));
  assert.equal(toolboxRun.payload.queued, true);
  assert.equal(toolboxRun.payload.run.status, "running");
  assert.equal(toolboxRun.payload.run.canUse, false);
  assert.equal(toolboxRun.payload.billing.state, "held");
  const toolRunId = Number(toolboxRun.payload.run.id);
  await waitForRow(
    "SELECT status FROM tool_runs WHERE tenant_id=? AND id=?",
    [TENANT_ID, toolRunId],
    (row) => row.status === "done",
    "toolbox background run",
  );
  assertSettledBillingReadback(
    db,
    TENANT_ID,
    "tool_run",
    toolRunId,
    "toolbox generation",
  );
  const toolboxReadback = await api("staff", `/api/toolbox/runs/${toolRunId}`);
  assert.equal(toolboxReadback.status, 200);
  assert.equal(toolboxReadback.payload.run.verified, true);
  assert.equal(toolboxReadback.payload.run.canUse, true);
  assert.equal(toolboxReadback.payload.run.provenance.billing.state, "settled");
  assert.equal(
    count(
      "SELECT COUNT(*) count FROM tool_run_events WHERE tenant_id=? AND run_id=? AND status='done'",
      TENANT_ID,
      toolRunId,
    ),
    1,
  );
  pass("toolbox", "staff_run_and_readback", `toolRun#${toolRunId}`);

  // 5) 老板参谋：管理层完成会诊并转为真实任务；普通员工无模块权限时 403 且零副作用。
  const beforeAdvisorDenied = businessEffectSnapshot(db, TENANT_ID);
  const advisorDenied = await api("staff", "/api/advisor/chat", {
    method: "POST",
    body: { question: "不应创建的员工会诊", stream: false },
  });
  deniedSnapshot("advisor module guard", beforeAdvisorDenied, advisorDenied);
  pass(
    "advisor",
    "staff_module_403_zero_side_effects",
    "chat denied before mutation",
  );

  const advisorChat = await api("ops", "/api/advisor/chat", {
    method: "POST",
    body: {
      question: "请诊断本周门店经营数据核验应该如何落成任务。",
      diagType: "经营诊断",
      stream: false,
    },
  });
  assert.equal(advisorChat.status, 200, JSON.stringify(advisorChat.payload));
  assert.equal(advisorChat.payload.billing.state, "settled");
  const assistantMessageId = Number(advisorChat.payload.assistantMessageId);
  assert.ok(assistantMessageId > 0);
  assertSettledBillingReadback(
    db,
    TENANT_ID,
    "ai_message",
    assistantMessageId,
    "advisor generation",
  );
  const advisorTask = await api(
    "ops",
    `/api/advisor/messages/${assistantMessageId}/to-tasks`,
    {
      method: "POST",
      body: {},
    },
  );
  assert.equal(advisorTask.status, 200, JSON.stringify(advisorTask.payload));
  assert.equal(advisorTask.payload.created.length, 1);
  const advisorTaskId = Number(advisorTask.payload.created[0].id);
  const storedAdvisorTask = db
    .prepare("SELECT * FROM tasks WHERE tenant_id=? AND id=?")
    .get(TENANT_ID, advisorTaskId);
  assert.equal(storedAdvisorTask.status, "待执行");
  assert.equal(storedAdvisorTask.source, "会诊");
  assert.equal(Number(storedAdvisorTask.source_ref_id), assistantMessageId);
  pass("advisor", "ops_chat_to_real_task", `task#${advisorTaskId}`);

  assertNoHeldCredits(db, TENANT_ID, "three-role penetration matrix");
  assert.equal(
    externalNetworkAttempts.length,
    0,
    JSON.stringify(externalNetworkAttempts),
  );
  assert.ok(
    providerCalls.some(
      (call) => call.kind === "activity_plan" && call.structured,
    ),
  );
  assert.ok(providerCalls.some((call) => call.kind === "activity_review"));
  assert.ok(providerCalls.some((call) => call.kind === "toolbox"));
  assert.ok(providerCalls.some((call) => call.kind === "advisor"));

  const summary = matrixSummary(scenarioResults);
  assert.equal(summary.failed, 0);
  assert.equal(summary.passed, 12);
  assert.deepEqual(summary.modules.sort(), [
    "activities",
    "advisor",
    "content_employee",
    "restaurant_employee",
    "toolbox",
  ]);
});

after(async () => {
  globalThis.fetch = nativeFetch;
  await new Promise((resolve) => appServer.close(resolve));
  await new Promise((resolve) => providerServer.close(resolve));
  try {
    db.close();
  } catch {
    /* already closed */
  }
  for (const target of DB_FILES) fs.rmSync(target, { force: true });
});
