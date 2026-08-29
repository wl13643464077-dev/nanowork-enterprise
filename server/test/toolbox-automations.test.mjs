import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

const DBP = path.join(
  os.tmpdir(),
  `nanowork-toolbox-automations-${process.pid}.db`,
);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* clean fixture */
  }
}
process.env.NANOWORK_DB = DBP;
process.env.NODE_ENV = "test";
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

const { initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { hashPassword } = await import("../src/util.js");
const {
  TOOLBOX_HOT_CHANNELS,
  buildToolboxAutomationRequest,
  claimDueToolboxAutomations,
  executeToolboxAutomationClaim,
  getToolboxAutomationConfig,
  getToolboxAutomationRun,
  reconcileToolboxAutomationRuns,
  saveToolboxAutomationConfig,
  toolboxAutomationDue,
  toolboxAutomationPeriodKey,
} = await import("../src/engines/toolbox-automations.js");
const { runScheduledJobs, recoverStaleAiWorkAcrossTenants } =
  await import("../src/engines/scheduler.js");
const toolboxRoutes = (await import("../src/routes/toolbox.js")).default;
const taskCenterRoutes = (await import("../src/routes/task-center.js")).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();

q.run(
  `INSERT INTO tenants(id,name,status,credits) VALUES(1,'自动化租户一','已开通',200000)
  ON CONFLICT(id) DO UPDATE SET status=excluded.status,credits=excluded.credits`,
);
q.run(
  `INSERT INTO tenants(id,name,status,credits) VALUES(2,'自动化租户二','已开通',200000)
  ON CONFLICT(id) DO UPDATE SET status=excluded.status,credits=excluded.credits`,
);
const userOneId = Number(
  q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES(?,?,?,?,?,?)`,
    "toolbox-auto-one",
    hashPassword("Secret123!"),
    "租户一老板",
    "boss",
    "启用",
    1,
  ).lastInsertRowid,
);
const userTwoId = Number(
  q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES(?,?,?,?,?,?)`,
    "toolbox-auto-two",
    hashPassword("Secret123!"),
    "租户二老板",
    "boss",
    "启用",
    2,
  ).lastInsertRowid,
);
const userOne = {
  id: userOneId,
  tenant_id: 1,
  name: "租户一老板",
  role: "boss",
};
const userTwo = {
  id: userTwoId,
  tenant_id: 2,
  name: "租户二老板",
  role: "boss",
};

const HOT_RESULT = `# 餐饮今日必发真实选题

## 今日内容安排

围绕餐饮行业在微博热搜、抖音热点和小红书热门受控正文中取得的公开证据，给出三个可发选题。每条必须写明热度证据、来源渠道、切入角度和可直接开工的brief。

1. 选题一：从当日真实门店准备切入，拍摄门头、出品和环境，发布前核验营业与当日可售。
2. 选题二：拍摄真实产品和食材细节，核验受控正文的消费讨论，不补造价格、库存和销量。
3. 选题三：记录顾客高频问题与门店回答，跟进真实咨询与到店，不把自然波动写成效果承诺。

## 素材与核验

- 只使用已授权的真实现场画面，人物出镜由负责人核验授权。
- 文案中的来源标题与完整URL保留在证据区，未读取的搜索卡片不作为事实。

## 执行责任表

| 负责人 | 时点 | 具体动作 | 可核验产出 |
|---|---|---|---|
| 运营负责人 | 今日10:00 | 核验当日可售和营业信息并登记 | 核验清单与现场截图 |
| 拍摄员工 | 今日14:00 | 拍摄门头、真实出品和环境画面 | 三组授权素材文件 |
| 审核主管 | 发布前 | 审核渠道文案并记录修改意见 | 审核记录与最终文案 |`;

const BENCH_RESULT = `# 竞品盯梢周报

## 对标A(抖音)：新品 近7天公开动态

本次只使用受控读取成功的公开页面正文。对标A的新内容、新活动、产品、价格、口碑和经营动作均以原始标题与完整URL为证据；未查到的项写“本周未见公开动态”。

1. 变化清单：核对官方发布时间、内容主题和公开活动规则，不把搜索摘要当正文。
2. 机会空白：对照我方已核验产品与服务能力，只保留可执行差异。
3. 不建议跟随：不复制未核验低价、虚假限量、刷评或超出产能的活动。

## 我方跟进动作

- 店长对照菜单与当日可售记录，确认哪些差异可交付。
- 运营只使用授权素材制作测试内容，七天后按真实咨询和到店复盘。
- 负责人保存原始链接、截图、观察日期与结论变更记录。

## 执行责任表

| 负责人 | 时点 | 具体动作 | 可核验产出 |
|---|---|---|---|
| 竞品分析负责人 | 周一10:00 | 核验竞品来源链接并登记变化 | 来源台账与页面截图 |
| 门店负责人 | 周二12:00 | 核验我方产品与现场承接能力 | 差异核验清单 |
| 运营主管 | 周三18:00 | 审核渠道跟进文案并记录一周结果 | 行动记录与周复盘表 |`;

function injectedLocals({ failGenerate = false } = {}) {
  return {
    toolboxAiAvailable: () => true,
    employeeAgenticWebResearch: async () => ({
      attempted: true,
      ok: true,
      candidateReady: true,
      provider: "offline-agentic-search",
      fetchCandidates: Array.from({ length: 6 }, (_, index) => ({
        title: `公开验收来源${index + 1}`,
        url: `https://example.com/toolbox-auto-${index + 1}`,
        snippet: "菜单、活动、口碑与内容公开候选",
      })),
      evidence: {
        schemaVersion: "nanowork.agentic-web-research/1",
        externalCall: false,
      },
    }),
    employeeControlledWebFetch: async (candidates) => ({
      attempted: true,
      ok: true,
      provider: "offline-controlled-fetch",
      results: candidates.map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.snippet,
        body: `本条为离线测试的受控正文证据：${item.title}。正文包含菜单、产品、公开活动、页面日期、口碑主题与经营动作的验收描述，只用于验证工具链路，绝不代表真实外部网页或经营结果。`,
      })),
      evidence: {
        schemaVersion: "nanowork.controlled-web-evidence/1",
        externalCall: false,
        ssrfProtected: true,
      },
    }),
    toolboxGenerate: async ({ kind }) => {
      if (failGenerate) {
        throw Object.assign(new Error("离线模型故障"), {
          code: "OFFLINE_MODEL_FAILED",
        });
      }
      return {
        mode: "api",
        model: "gpt-5.5",
        text: String(kind).includes(":bench:") ? BENCH_RESULT : HOT_RESULT,
        usage: { inputTokens: 420, outputTokens: 260 },
      };
    },
  };
}

function appFor(user, locals = injectedLocals()) {
  const app = express();
  Object.assign(app.locals, locals);
  app.use(express.json({ limit: "64kb" }));
  app.use((req, _res, next) =>
    runWithTenant(user.tenant_id, () => {
      req.user = user;
      next();
    }),
  );
  app.use("/toolbox", toolboxRoutes);
  app.use("/task-center", taskCenterRoutes);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code,
    }),
  );
  return app;
}

async function withServer(user, fn, locals) {
  const server = appFor(user, locals).listen(0, "127.0.0.1");
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function request(
  base,
  url,
  method = "GET",
  body,
  requestId = randomId(),
) {
  const response = await fetch(base + url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": requestId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json().catch(() => ({})) };
}

function randomId() {
  return `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function waitForTool(tenantId, runId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let row = null;
  while (Date.now() < deadline) {
    row = runWithTenant(tenantId, () =>
      q.get(
        `SELECT * FROM tool_runs WHERE tenant_id=? AND id=?`,
        tenantId,
        runId,
      ),
    );
    if (["done", "failed"].includes(row?.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`工具任务未收敛：${JSON.stringify(row)}`);
}

async function waitForAutomation(tenantId, runId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let row = null;
  while (Date.now() < deadline) {
    row = runWithTenant(tenantId, () => getToolboxAutomationRun(runId));
    if (["done", "failed"].includes(row?.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`工具自动化未收敛：${JSON.stringify(row)}`);
}

test("上海时区时窗、每日/每周claim key与三日guard对齐派活", () => {
  const hotConfig = {
    enabled: true,
    industry: "餐饮",
    channels: TOOLBOX_HOT_CHANNELS.slice(0, 4),
  };
  assert.equal(
    toolboxAutomationDue(
      "hot_daily",
      hotConfig,
      new Date("2026-08-09T23:00:00.000Z"),
    ),
    true,
  );
  assert.equal(
    toolboxAutomationDue(
      "hot_daily",
      hotConfig,
      new Date("2026-08-10T02:00:00.000Z"),
    ),
    false,
  );
  assert.equal(
    toolboxAutomationPeriodKey(
      "hot_daily",
      new Date("2026-08-09T23:00:00.000Z"),
    ),
    "hot_daily:2026-08-10",
  );
  const bench = { enabled: true, targets: [{ name: "对标A" }] };
  assert.equal(
    toolboxAutomationDue(
      "bench_weekly",
      bench,
      new Date("2026-08-10T01:00:00.000Z"),
    ),
    true,
  );
  assert.equal(
    toolboxAutomationDue(
      "bench_weekly",
      {
        ...bench,
        lastSuccessAt: "2026-08-09T00:00:00.000Z",
      },
      new Date("2026-08-10T02:00:00.000Z"),
    ),
    false,
  );
  assert.equal(
    toolboxAutomationPeriodKey(
      "bench_weekly",
      new Date("2026-08-10T02:00:00.000Z"),
    ),
    "bench_weekly:2026-08-10",
  );
});

test("租户配置严格归一，hot与bench构造现有真实工具请求", () => {
  runWithTenant(1, () => {
    const hot = saveToolboxAutomationConfig(
      "hot_daily",
      {
        enabled: true,
        industry: "餐饮连锁集团超长字段需要裁剪到二十字",
        channels: ["bad", ...TOOLBOX_HOT_CHANNELS],
      },
      userOne,
    );
    assert.equal(hot.industry.length <= 20, true);
    assert.equal(hot.channels.length, 10);
    assert.equal(hot.channels.includes("bad"), false);
    const hotRequest = buildToolboxAutomationRequest(
      "hot_daily",
      hot,
      new Date("2026-08-09T23:30:00.000Z"),
    );
    assert.equal(hotRequest.toolKey, "hot");
    assert.equal(hotRequest.employeeIdx, 141);
    assert.deepEqual(hotRequest.inputs.channels, hot.channels);

    const bench = saveToolboxAutomationConfig(
      "bench_weekly",
      {
        enabled: true,
        targets: [
          { name: "对标A", platform: "抖音", note: "新品" },
          { name: "", platform: "小红书", note: "丢弃" },
        ],
      },
      userOne,
    );
    assert.equal(bench.targets.length, 1);
    const benchRequest = buildToolboxAutomationRequest(
      "bench_weekly",
      bench,
      new Date("2026-08-10T02:00:00.000Z"),
    );
    assert.equal(benchRequest.toolKey, "bench");
    assert.equal(benchRequest.inputs.targets, "对标A(抖音)：新品");
  });
  runWithTenant(2, () => {
    assert.equal(getToolboxAutomationConfig("hot_daily").enabled, false);
    assert.equal(getToolboxAutomationConfig("bench_weekly").targets.length, 0);
  });
});

test("配置API返回上海时区计划并严格隔离租户", async () => {
  await withServer(userTwo, async (base) => {
    const initial = await request(base, "/toolbox/automations");
    assert.equal(initial.response.status, 200, JSON.stringify(initial.body));
    assert.equal(initial.body.timezone, "Asia/Shanghai");
    assert.deepEqual(
      initial.body.configs.map((item) => item.key),
      ["hot_daily", "bench_weekly"],
    );
    assert.match(initial.body.configs[0].schedule, /每日07:00–09:59/u);

    const saved = await request(
      base,
      "/toolbox/automations/bench_weekly",
      "PUT",
      {
        enabled: true,
        targets: [{ name: "租户二对标", platform: "抖音", note: "新品" }],
      },
    );
    assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.config.enabled, true);
    assert.equal(saved.body.config.targets[0].name, "租户二对标");
  });
  assert.equal(
    runWithTenant(1, () => getToolboxAutomationConfig("bench_weekly"))
      .targets[0].name,
    "对标A",
  );
});

test("Toolbox界面提供自动开关、配置和run-now真实端点", () => {
  const source = fs.readFileSync(
    new URL("../../web/src/pages/Toolbox.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /<Switch/u);
  assert.match(source, /\/toolbox\/automations\/\$\{key\}/u);
  assert.match(source, /\/toolbox\/automations\/\$\{key\}\/run-now/u);
  assert.match(source, /立即运行一次/u);
  assert.match(source, /失败会释放预授权/u);
});

test("手动run-now共用真实toolbox后台链，幂等回放、usage结算与TaskCenter深链完整", async () => {
  runWithTenant(1, () =>
    saveToolboxAutomationConfig(
      "hot_daily",
      {
        enabled: true,
        industry: "餐饮",
        channels: TOOLBOX_HOT_CHANNELS.slice(0, 3),
      },
      userOne,
    ),
  );
  await withServer(userOne, async (base) => {
    const requestId = "manual-hot-idempotency-0001";
    const queued = await request(
      base,
      "/toolbox/automations/hot_daily/run-now",
      "POST",
      {},
      requestId,
    );
    assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
    const automation = queued.body.automationRun;
    assert.equal(automation.status, "running");
    assert.ok(automation.toolRunId > 0);
    assert.equal(
      automation.deepLink,
      `/tasks?kind=tool&id=${automation.toolRunId}`,
    );
    const tool = await waitForTool(1, automation.toolRunId);
    assert.equal(tool.status, "done", JSON.stringify(tool));
    const provenance = JSON.parse(tool.provenance_json);
    assert.equal(provenance.mode, "api");
    assert.equal(provenance.billing.state, "settled");
    assert.ok(provenance.usage.inputTokens > 0);
    assert.ok(provenance.usage.outputTokens > 0);
    assert.equal(provenance.automation.id, automation.id);

    const completed = await waitForAutomation(1, automation.id);
    assert.equal(completed.status, "done");
    assert.ok(completed.notificationId > 0);
    assert.equal(completed.knowledgeId, null);
    assert.equal(
      q.get(
        `SELECT link FROM notifications WHERE tenant_id=1 AND id=?`,
        completed.notificationId,
      ).link,
      completed.deepLink,
    );

    const replay = await request(
      base,
      "/toolbox/automations/hot_daily/run-now",
      "POST",
      {},
      requestId,
    );
    assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.idempotent, true);
    assert.equal(replay.body.automationRun.id, automation.id);
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM toolbox_automation_runs
        WHERE tenant_id=1 AND claim_key=?`,
        automation.claimKey,
      ).n,
      1,
    );

    const detail = await request(
      base,
      `/task-center/tool/${automation.toolRunId}`,
    );
    assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.deepLink, completed.deepLink);
    assert.equal(detail.body.businessUsable, true);
  });
});

test("bench成功后事务化写知识与通知，重复tick不重复沉淀", async () => {
  await withServer(userOne, async (base) => {
    const queued = await request(
      base,
      "/toolbox/automations/bench_weekly/run-now",
      "POST",
      {},
      "manual-bench-idempotency-0001",
    );
    assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
    const automation = queued.body.automationRun;
    const tool = await waitForTool(1, automation.toolRunId);
    assert.equal(tool.status, "done", JSON.stringify(tool));
    runWithTenant(1, () => reconcileToolboxAutomationRuns(new Date()));
    runWithTenant(1, () => reconcileToolboxAutomationRuns(new Date()));
    const completed = runWithTenant(1, () =>
      getToolboxAutomationRun(automation.id),
    );
    assert.equal(completed.status, "done");
    assert.ok(completed.knowledgeId > 0);
    assert.ok(completed.notificationId > 0);
    const knowledge = q.get(
      `SELECT * FROM kb_docs WHERE tenant_id=1 AND id=?`,
      completed.knowledgeId,
    );
    assert.equal(knowledge.source_type, "toolbox_automation");
    assert.equal(knowledge.source_id, automation.id);
    assert.match(knowledge.body, /竞品盯梢周报/u);
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM kb_docs
        WHERE tenant_id=1 AND source_type='toolbox_automation' AND source_id=?`,
        automation.id,
      ).n,
      1,
    );
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM notifications
        WHERE tenant_id=1 AND id=?`,
        completed.notificationId,
      ).n,
      1,
    );
  });
});

test("模型失败必须fail closed并全额释放预授权，不写知识/通知", async () => {
  const before = q.get(`SELECT credits FROM tenants WHERE id=1`).credits;
  await withServer(
    userOne,
    async (base) => {
      const queued = await request(
        base,
        "/toolbox/automations/hot_daily/run-now",
        "POST",
        {},
        "manual-hot-model-failure-0001",
      );
      assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
      const automation = queued.body.automationRun;
      const tool = await waitForTool(1, automation.toolRunId);
      assert.equal(tool.status, "failed");
      const billing = JSON.parse(tool.provenance_json).billing;
      assert.equal(billing.state, "released");
      runWithTenant(1, () => reconcileToolboxAutomationRuns(new Date()));
      const failed = runWithTenant(1, () =>
        getToolboxAutomationRun(automation.id),
      );
      assert.equal(failed.status, "failed");
      assert.equal(failed.knowledgeId, null);
      assert.equal(failed.notificationId, null);
      assert.equal(
        q.get(
          `SELECT COUNT(*) n FROM credit_holds
          WHERE tenant_id=1 AND ref_type='tool_run' AND ref_id=? AND status='held'`,
          automation.toolRunId,
        ).n,
        0,
      );
    },
    injectedLocals({ failGenerate: true }),
  );
  assert.equal(q.get(`SELECT credits FROM tenants WHERE id=1`).credits, before);
});

test("受控来源不足在模型前fail closed并全额释放预授权", async () => {
  const before = q.get(`SELECT credits FROM tenants WHERE id=1`).credits;
  let modelCalls = 0;
  const locals = injectedLocals();
  locals.employeeControlledWebFetch = async () => ({
    attempted: true,
    ok: true,
    results: [],
    evidence: { failures: [] },
  });
  locals.toolboxGenerate = async () => {
    modelCalls += 1;
    throw new Error("来源不足时不应调用模型");
  };
  await withServer(
    userOne,
    async (base) => {
      const queued = await request(
        base,
        "/toolbox/automations/hot_daily/run-now",
        "POST",
        {},
        "manual-hot-insufficient-sources-0001",
      );
      assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
      const automation = queued.body.automationRun;
      const tool = await waitForTool(1, automation.toolRunId);
      assert.equal(tool.status, "failed");
      const provenance = JSON.parse(tool.provenance_json);
      assert.equal(provenance.billing.state, "released");
      assert.equal(provenance.publicResearch.acceptedCount, 0);
      assert.equal(modelCalls, 0);
      runWithTenant(1, () => reconcileToolboxAutomationRuns(new Date()));
      const failed = runWithTenant(1, () =>
        getToolboxAutomationRun(automation.id),
      );
      assert.equal(failed.status, "failed");
      assert.equal(failed.knowledgeId, null);
      assert.equal(failed.notificationId, null);
    },
    locals,
  );
  assert.equal(q.get(`SELECT credits FROM tenants WHERE id=1`).credits, before);
});

test("无真实provider时不检索、不占扣、不交付降级底稿", async () => {
  const before = q.get(`SELECT credits FROM tenants WHERE id=1`).credits;
  let researchCalls = 0;
  let modelCalls = 0;
  const locals = injectedLocals();
  locals.toolboxAiAvailable = () => false;
  locals.employeeAgenticWebResearch = async () => {
    researchCalls += 1;
    throw new Error("无provider时不应检索");
  };
  locals.toolboxGenerate = async () => {
    modelCalls += 1;
    throw new Error("无provider时不应调用模型");
  };
  await withServer(
    userOne,
    async (base) => {
      const queued = await request(
        base,
        "/toolbox/automations/hot_daily/run-now",
        "POST",
        {},
        "manual-hot-no-provider-0001",
      );
      assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
      const automation = queued.body.automationRun;
      const tool = await waitForTool(1, automation.toolRunId);
      assert.equal(tool.status, "failed");
      const provenance = JSON.parse(tool.provenance_json);
      assert.notEqual(provenance.mode, "api");
      assert.equal(provenance.billing.state, "not_applicable");
      assert.equal(tool.result_md, "");
      assert.equal(researchCalls, 0);
      assert.equal(modelCalls, 0);
      assert.equal(
        q.get(
          `SELECT COUNT(*) n FROM credit_holds
          WHERE tenant_id=1 AND ref_type='tool_run' AND ref_id=?`,
          automation.toolRunId,
        ).n,
        0,
      );
      runWithTenant(1, () => reconcileToolboxAutomationRuns(new Date()));
      assert.equal(
        runWithTenant(1, () => getToolboxAutomationRun(automation.id)).status,
        "failed",
      );
    },
    locals,
  );
  assert.equal(q.get(`SELECT credits FROM tenants WHERE id=1`).credits, before);
});

test("失败工具的hold待对账时保留claim，权威释放后才允许失败收口", () => {
  runWithTenant(1, () => {
    const toolRunId = Number(
      q.run(
        `INSERT INTO tool_runs(
          tool_key,tool_title,title,status,employee_idx,employee_name,created_by,
          input_json,input_summary,result_md,provenance_json,error_json,execution_state
        ) VALUES('hot','今日必发','待对账自动化','failed',141,'云营销',?,
          '{}','待对账测试','',?,?,'failed')`,
        userOneId,
        JSON.stringify({
          mode: "api",
          persisted: true,
          contract: { valid: false },
          billing: { state: "pending_reconciliation" },
        }),
        JSON.stringify({ code: "OFFLINE_FAILED", message: "离线失败" }),
      ).lastInsertRowid,
    );
    const automationId = Number(
      q.run(
        `INSERT INTO toolbox_automation_runs(
          automation_key,trigger,claim_key,status,created_by,tool_run_id,
          config_snapshot_json,request_json,started_at
        ) VALUES('hot_daily','manual',?,'running',?,?,'{}','{}',?)`,
        `manual:hot_daily:pending-reconciliation-${Date.now()}`,
        userOneId,
        toolRunId,
        new Date().toISOString(),
      ).lastInsertRowid,
    );

    assert.deepEqual(reconcileToolboxAutomationRuns(new Date()), []);
    assert.equal(getToolboxAutomationRun(automationId).status, "running");

    q.run(
      `UPDATE tool_runs SET provenance_json=? WHERE tenant_id=1 AND id=?`,
      JSON.stringify({
        mode: "api",
        persisted: true,
        contract: { valid: false },
        billing: { state: "released" },
      }),
      toolRunId,
    );
    const outcomes = reconcileToolboxAutomationRuns(new Date());
    assert.equal(outcomes.length, 1);
    assert.equal(getToolboxAutomationRun(automationId).status, "failed");
  });
});

test("余额不足在任何外部调用前失败并暂停配置", async () => {
  q.run(`UPDATE tenants SET credits=0 WHERE id=1`);
  let researchCalls = 0;
  const locals = injectedLocals();
  locals.employeeAgenticWebResearch = async () => {
    researchCalls += 1;
    throw new Error("不应进入外部链");
  };
  await withServer(
    userOne,
    async (base) => {
      const failed = await request(
        base,
        "/toolbox/automations/hot_daily/run-now",
        "POST",
        {},
        "manual-hot-no-balance-0001",
      );
      assert.equal(failed.response.status, 402, JSON.stringify(failed.body));
      assert.equal(failed.body.automationRun.status, "failed");
      assert.equal(failed.body.automationRun.toolRunId, null);
      assert.equal(researchCalls, 0);
      assert.equal(
        runWithTenant(1, () => getToolboxAutomationConfig("hot_daily")).enabled,
        false,
      );
    },
    locals,
  );
  q.run(`UPDATE tenants SET credits=200000 WHERE id=1`);
});

test("scheduler tick在时窗内只领取一个确定claim，跨租户不串行", async () => {
  runWithTenant(1, () =>
    saveToolboxAutomationConfig(
      "hot_daily",
      {
        enabled: false,
        industry: "餐饮",
        channels: TOOLBOX_HOT_CHANNELS.slice(0, 4),
      },
      userOne,
    ),
  );
  runWithTenant(2, () =>
    saveToolboxAutomationConfig(
      "hot_daily",
      {
        enabled: true,
        industry: "茶饮",
        channels: TOOLBOX_HOT_CHANNELS.slice(0, 4),
      },
      userTwo,
    ),
  );
  const now = new Date("2026-08-09T23:15:00.000Z");
  const claimedTenants = [];
  const runner = async (claim) => {
    claimedTenants.push({
      tenantId: Number(q.get("SELECT 1 x").x && 2),
      id: claim.id,
    });
    return claim;
  };
  const first = runScheduledJobs(now, { toolboxAutomationRunner: runner });
  const firstOutcomes = await first.pending;
  assert.equal(
    firstOutcomes.some((item) => item.status === "rejected"),
    false,
  );
  const second = runScheduledJobs(now, { toolboxAutomationRunner: runner });
  await second.pending;
  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM toolbox_automation_runs
      WHERE tenant_id=2 AND claim_key='hot_daily:2026-08-10'`,
    ).n,
    1,
  );
  assert.equal(claimedTenants.length, 1);
  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM toolbox_automation_runs
      WHERE tenant_id=1 AND claim_key='hot_daily:2026-08-10'`,
    ).n,
    0,
  );
});

test("启动恢复不调用网络：超时未入队claim收口为失败并可在时窗重领", () => {
  runWithTenant(2, () => {
    q.run(
      `UPDATE toolbox_automation_runs SET status='enqueuing',tool_run_id=NULL,
        updated_at='2026-08-09T22:00:00.000Z'
      WHERE tenant_id=2 AND claim_key='hot_daily:2026-08-10'`,
    );
  });
  const recovered = recoverStaleAiWorkAcrossTenants(
    new Date("2026-08-09T23:20:00.000Z"),
  );
  const tenant = recovered.find((item) => item.tenantId === 2);
  assert.equal(tenant.toolboxAutomations.length, 1);
  const failed = runWithTenant(2, () =>
    q.get(
      `SELECT * FROM toolbox_automation_runs
      WHERE tenant_id=2 AND claim_key='hot_daily:2026-08-10'`,
    ),
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.tool_run_id, null);
  // 无任何 provider 注入或 HTTP 调用，恢复只修复本地状态。
  assert.equal(
    q.get(
      `SELECT COUNT(*) n FROM tool_runs WHERE tenant_id=2 AND title LIKE '每日自动%'`,
    ).n,
    0,
  );
});

test.after(() => {
  try {
    fs.rmSync(DBP, { force: true });
    fs.rmSync(`${DBP}-wal`, { force: true });
    fs.rmSync(`${DBP}-shm`, { force: true });
  } catch {
    /* best effort */
  }
});
