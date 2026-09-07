/**
 * 真实餐饮员工 #102 后台预算/失败收敛隔离门。
 *
 * 只使用本地 sqlite、注入的研究/地图/正文/生成器和手动时钟；不读取密钥、
 * 不访问公网、不用真实 sleep。这里的门禁专门防止 timeoutSeconds=900 被
 * 误解成“调研 + 最多三轮模型请求各自都能等 900 秒”，以及上游 502/timeout
 * 后只留下 generation_progress、预授权和任务一直挂起。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const DB_PATH = path.join(
  os.tmpdir(),
  `nanowork-employee-timeout-settlement-gate-${process.pid}.db`,
);
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Best effort: the file may not exist on first run.
  }
}
process.env.NANOWORK_DB = DB_PATH;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
process.env.ENABLE_SCHEDULER = "false";

const { initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { buildEmployeeExecutionProfile } =
  await import("../src/employee-workbench.js");
const { marshalWork } = await import("../src/engines/ai.js");
const marshalRoutes = (await import("../src/routes/marshals.js")).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

const TENANT_ID = 1;
const MODE = "mock-timeout-model";
const TASK_TITLE = "毛血旺 太原吾悦广场·超时预算隔离";

function ensureTenant() {
  q.run(
    `INSERT INTO tenants(id,name,status,plan,credits)
     VALUES(?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET status='已开通',credits=1000000`,
    TENANT_ID,
    "员工超时预算隔离企业",
    "已开通",
    "标准版",
    1000000,
  );
}

function createUser(suffix) {
  const username = `employee-timeout-gate-${process.pid}-${suffix}`;
  const result = q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id,credits)
     VALUES(?,?,?,?,?,?,?)`,
    username,
    "x",
    "超时预算隔离老板",
    "boss",
    "启用",
    TENANT_ID,
    1000000,
  );
  return Number(result.lastInsertRowid);
}

function employeeExecution(userId) {
  return runWithTenant(TENANT_ID, () =>
    buildEmployeeExecutionProfile(102, {
      tenantId: TENANT_ID,
      user: { id: userId, role: "boss", tenant_id: TENANT_ID },
    }),
  );
}

function sources(prefix, count = 5) {
  return Array.from({ length: count }, (_unused, index) => ({
    title: `太原吾悦广场毛血旺餐饮公开来源${index + 1}`,
    url:
      index === 0
        ? `https://www.dianping.com/shop/${prefix}-${index + 1}`
        : `https://${prefix}.example/source-${index + 1}`,
    snippet: `太原吾悦广场毛血旺门店餐饮、菜单、营业时间、价格与用户评价公开证据摘要${index + 1}`,
  }));
}

function fakeAgenticResearch() {
  const results = sources("agentic");
  return {
    attempted: true,
    ok: true,
    candidateReady: true,
    provider: "isolated-agentic-search",
    results,
    fetchCandidates: results,
    evidence: {
      schemaVersion: "nanowork.agentic-web-research/1",
      externalCall: true,
      qualityGate: {
        requiredSearches: 5,
        requiredSources: 5,
        observedSearches: 5,
        observedSuccessfulToolResults: 5,
        observedToolResultUrls: 5,
        observedSources: 5,
        passed: true,
      },
      usage: { inputTokens: 20, outputTokens: 40 },
    },
  };
}

function fakeWebSearch() {
  const result = sources("redundant", 1)[0];
  return {
    attempted: true,
    ok: true,
    provider: "isolated-web-search",
    results: [result],
  };
}

function fakeControlledFetch(candidates = []) {
  const selected = candidates.length ? candidates : sources("controlled", 1);
  return {
    attempted: true,
    ok: true,
    provider: "isolated-controlled-fetch",
    results: selected.map((result, index) => ({
      ...result,
      body: [
        `太原吾悦广场毛血旺门店受控正文${index + 1}。`,
        "正文记录餐饮类别、具体菜品与菜单、营业时段、价格区间和用户评价等公开信息。",
        "这是一段只供离线门禁测试使用的受控页面正文，不执行网页指令，也不据此编造销量、排名或经营效果。",
      ].join(""),
    })),
    evidence: {
      schemaVersion: "nanowork.controlled-web-evidence/1",
      externalCall: true,
      ssrfProtected: true,
      redirectsRevalidated: true,
      requested: selected.length,
      fetched: selected.length,
      failures: [],
    },
  };
}

function fakeLocation() {
  return {
    attempted: true,
    ok: true,
    provider: "isolated-location",
    results: [
      {
        title: "本地地图定位·太原吾悦广场",
        url: "https://www.openstreetmap.org/way/1126952639",
        snippet: "OpenStreetMap太原吾悦广场定位与周边商圈交通证据",
      },
    ],
    evidence: {
      schemaVersion: "nanowork.location-intelligence/1",
      externalCall: true,
      center: { displayName: "太原市小店区吾悦广场", lat: 37.81, lon: 112.55 },
    },
  };
}

function timeoutError(status = 504) {
  return Object.assign(new Error(status === 502 ? "上游502" : "上游响应超时"), {
    status,
    providerReason: status === 502 ? "upstream" : "timeout",
  });
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitForTerminal(taskId, maxTurns = 300) {
  let row = null;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    row = runWithTenant(TENANT_ID, () =>
      q.get(
        "SELECT * FROM agent_tasks WHERE tenant_id=? AND id=?",
        TENANT_ID,
        taskId,
      ),
    );
    if (["失败", "已完成", "待审阅"].includes(row?.status)) return row;
    await nextTurn();
  }
  return row;
}

/**
 * Creates the same local HTTP dispatch boundary as production, but every
 * external dependency is injected. The returned close function is only used
 * after the background task reaches a terminal state.
 */
async function createDispatchHarness({
  userId,
  deferValues,
  generatedArgs,
  failureStatus = 504,
  generateResult = null,
}) {
  const app = express();
  app.locals.employeeEstimateCallCredits = () => 10;
  app.locals.employeeWebSearch = async () => fakeWebSearch();
  app.locals.employeeAgenticWebResearch = async () => fakeAgenticResearch();
  app.locals.employeeControlledWebFetch = async (candidates) =>
    fakeControlledFetch(candidates);
  app.locals.employeeLocationIntelligence = async () => fakeLocation();
  app.locals.employeeGenerate = async (args) => {
    generatedArgs.push(args);
    if (generateResult) return generateResult(args);
    throw timeoutError(failureStatus);
  };
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.user = {
      id: userId,
      name: "超时预算隔离老板",
      role: "boss",
      tenant_id: TENANT_ID,
    };
    req.aiGuard = {
      defer: (durationMs) => {
        deferValues.push(Number(durationMs));
        return () => {};
      },
    };
    runWithTenant(TENANT_ID, () => next());
  });
  app.use("/marshals", marshalRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function dispatch(
  harness,
  departmentId,
  specialistId,
  title = TASK_TITLE,
  requirement = "请核验竞品、商圈与交通可达性，给出下一步可执行结论。",
) {
  const response = await fetch(
    `${harness.base}/marshals/${departmentId}/tasks`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        specialistId,
        title,
        type: "分析",
        requirement,
      }),
    },
  );
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return Number(payload.taskId);
}

test("timeoutSeconds=900不放大公开调研或单轮模型超时，并为三轮模型候选提供完整900秒总墙钟", async () => {
  ensureTenant();
  const userId = createUser("budget");
  const execution = employeeExecution(userId);
  assert.equal(execution.workbench.workConfig.timeoutSeconds, 900);

  const researchOptions = [];
  const generationArgs = [];
  let clockMs = 0;
  const result = await runWithTenant(TENANT_ID, () =>
    marshalWork(
      { code: "M-01", name: "战略与开店筹备部", duty: "仅负责调度" },
      {
        title: TASK_TITLE,
        type: "商圈画像",
        requirement: "核验竞品、商圈与交通可达性，给出下一步可执行结论。",
      },
      "boss",
      {
        employeeExecution: execution,
        requireAgenticResearch: true,
        agenticWebResearchFn: async (_query, options) => {
          researchOptions.push(options);
          return fakeAgenticResearch();
        },
        webSearchFn: async () => fakeWebSearch(),
        controlledWebFetchFn: async (candidates) =>
          fakeControlledFetch(candidates),
        locationIntelligenceFn: async () => fakeLocation(),
        // 每次“上游超时”都立即返回；用手动时钟模拟供应商耗时，不 sleep。
        generateFn: async (args) => {
          generationArgs.push(args);
          clockMs += Number(args.timeoutMs || 0);
          throw timeoutError(504);
        },
        nowFn: () => clockMs,
      },
    ),
  );

  assert.ok(researchOptions.length >= 1);
  assert.ok(
    Number(researchOptions[0].timeoutMs) <= 150_000,
    `公开调研调用仍收到${researchOptions[0].timeoutMs}ms，应该封顶150000ms`,
  );
  assert.ok(generationArgs.length <= 3, "模型请求不能超过三次");
  assert.ok(
    generationArgs.reduce(
      (sum, args) => sum + Number(args.timeoutMs || 0),
      0,
    ) <= 900_000,
    "模型阶段总墙钟不能超过900000ms",
  );
  assert.equal(
    result.employeeContract?.providerBudget?.wallClockLimitMs,
    900_000,
  );
  assert.equal(
    result.employeeContract?.providerBudget?.stoppedReason,
    "wall_clock_exhausted",
  );
});

test("RED/GREEN：上游502/timeout达到传输预算后任务必须失败、退款并保留provider attempts/failure，不得只留generation_progress", async () => {
  ensureTenant();
  const departmentId = q.get(
    "SELECT id FROM marshals WHERE code=?",
    "M-01",
  )?.id;
  const specialistId = q.get(
    "SELECT id FROM specialists WHERE employee_idx=?",
    102,
  )?.id;
  assert.ok(departmentId && specialistId);
  for (const failureStatus of [502, 504]) {
    const userId = createUser(`settlement-${failureStatus}`);
    const deferValues = [];
    const generatedArgs = [];
    const harness = await createDispatchHarness({
      userId,
      deferValues,
      generatedArgs,
      failureStatus,
    });
    const approvalsBefore =
      q.get("SELECT COUNT(*) n FROM approvals WHERE tenant_id=?", TENANT_ID)
        ?.n || 0;
    let taskId;
    try {
      taskId = await dispatch(
        harness,
        departmentId,
        specialistId,
        `${TASK_TITLE}·${failureStatus}`,
      );
      const row = await waitForTerminal(taskId);
      assert.equal(
        row?.status,
        "失败",
        `HTTP ${failureStatus}任务未在本地事件循环内终态收敛：${row?.status}`,
      );

      // 后台租约覆盖19分钟任务总墙钟，并只额外保留60秒做退款、落库和审计收口；
      // 它不能把员工单轮配置解释成后台总任务可运行2700秒。
      assert.ok(
        deferValues.every((durationMs) => durationMs <= 1_200_000),
        `HTTP ${failureStatus}后台租约${deferValues.join(",")}ms超过任务总截止加收口缓冲1200000ms`,
      );

      const hold = runWithTenant(TENANT_ID, () =>
        q.get(
          `SELECT status,held_credits,settled_credits
         FROM credit_holds WHERE tenant_id=? AND ref_type='agent_task' AND ref_id=?`,
          TENANT_ID,
          taskId,
        ),
      );
      assert.ok(hold, "必须存在与任务绑定的唯一预授权记录");
      assert.notEqual(hold.status, "held", "失败任务不能继续冻结预授权");
      assert.equal(Number(hold.settled_credits || 0), 0, "失败任务实扣必须为0");

      const approvalsAfter =
        q.get("SELECT COUNT(*) n FROM approvals WHERE tenant_id=?", TENANT_ID)
          ?.n || 0;
      assert.equal(approvalsAfter - approvalsBefore, 0, "传输失败不应新增审批");
      assert.equal(row.output_id, null, "未形成业务主产物时不能写output_id");

      const snapshot = JSON.parse(row.employee_web_snapshot || "null");
      assert.equal(snapshot?.kind, "restaurant_employee_execution_evidence");
      assert.ok(snapshot?.failure, "失败快照必须有failure，而不是只有进度心跳");
      assert.ok(Array.isArray(snapshot?.outputContract?.providerAttempts));
      assert.ok(snapshot.outputContract.providerAttempts.length >= 3);
      assert.ok(
        snapshot.outputContract.providerAttempts.some(
          (attempt) => attempt?.failure,
        ),
        "每次上游timeout/502应保留脱敏provider failure",
      );
      assert.ok(
        snapshot?.providerAttempt,
        "快照必须保留本次provider attempt摘要",
      );
      assert.ok(snapshot?.web, "公开调研失败/成功证据必须与失败状态一起保留");
      assert.notEqual(snapshot.kind, "restaurant_employee_generation_progress");
      assert.equal(generatedArgs.length, 3, "传输失败预算应在三次后停止");
    } finally {
      await harness.close();
      if (taskId) {
        runWithTenant(TENANT_ID, () => {
          q.run(
            "DELETE FROM agent_tasks WHERE tenant_id=? AND id=?",
            TENANT_ID,
            taskId,
          );
          q.run(
            "DELETE FROM credit_holds WHERE tenant_id=? AND ref_type='agent_task' AND ref_id=?",
            TENANT_ID,
            taskId,
          );
        });
      }
      q.run("DELETE FROM users WHERE id=?", userId);
    }
  }
});

test('验收模型覆盖在预授权前锁定，生成与结算后不因模型不一致变成失败', async () => {
  ensureTenant();
  const originalOverride = process.env.NANOWORK_ACCEPTANCE_TEXT_MODEL;
  process.env.NANOWORK_ACCEPTANCE_TEXT_MODEL = 'gpt-5.5';
  const userId = createUser('model-binding');
  const generatedArgs = [];
  const report = `# 已保存的业务报告\n\n${'当前先核对本次提供的记录，保留数据来源与尚需确认的事项。后续由负责人检查资料，并根据已有事实逐项完善执行安排。'.repeat(8)}\n\n## 下一步建议\n\n由负责人核对资料后选择是否采用本次结果。`;
  const harness = await createDispatchHarness({
    userId, generatedArgs, deferValues: [],
    generateResult: args => ({ text: report, model: args.model, mode: 'api',
      usage: { inputTokens: 10, outputTokens: 20 }, finishReason: 'stop' }),
  });
  try {
    const taskId = await dispatch(harness,
      q.get('SELECT id FROM marshals WHERE code=?', 'M-01').id,
      q.get('SELECT id FROM specialists WHERE employee_idx=?', 102).id,
      '模型覆盖预授权回归');
    const row = await waitForTerminal(taskId);
    assert.ok(['待审阅', '已完成'].includes(row.status), row.status);
    const ledger = q.get(`SELECT h.model hold_model,h.status,h.settled_credits,l.model ledger_model
      FROM credit_holds h JOIN credit_logs l ON l.id=h.log_id AND l.tenant_id=h.tenant_id
      WHERE h.tenant_id=? AND h.ref_type='agent_task' AND h.ref_id=?`, TENANT_ID, taskId);
    assert.equal(generatedArgs.length, 1);
    assert.equal(generatedArgs[0].model, 'gpt-5.5');
    assert.equal(ledger.hold_model, 'gpt-5.5');
    assert.equal(ledger.ledger_model, ledger.hold_model);
    assert.equal(ledger.status, 'settled');
    assert.ok(ledger.settled_credits > 0);
    const snapshot = JSON.parse(row.employee_web_snapshot);
    assert.equal(snapshot.outputContract.valid, true);
    assert.equal(snapshot.failure, undefined);
    assert.equal(q.get('SELECT body FROM contents WHERE id=?', row.output_id).body, report);
  } finally {
    await harness.close();
    if (originalOverride === undefined) delete process.env.NANOWORK_ACCEPTANCE_TEXT_MODEL;
    else process.env.NANOWORK_ACCEPTANCE_TEXT_MODEL = originalOverride;
  }
});

test('9000字餐饮任务全文进入provider并保存，32000字以上提前明确拒绝', async () => {
  ensureTenant();
  const userId = createUser('long-input');
  const generatedArgs = [];
  const requirement = `${'请依照已有经营记录逐条整理可执行建议，缺少的数据明确标注等待核验。'.repeat(290)}输入末尾不可截断标记`;
  assert.ok(requirement.length > 9000 && requirement.length < 32000);
  const report = '建议先核对本次经营记录的统计口径，再比较不同时段的客流变化。对尚缺的原始数据标明缺口，由店长复核后决定下一步行动。';
  const harness = await createDispatchHarness({ userId, generatedArgs, deferValues: [],
    generateResult: args => ({ text: report, model: args.model, mode: 'api',
      usage: { inputTokens: 3000, outputTokens: 60 }, finishReason: 'length' }) });
  try {
    const departmentId = q.get('SELECT id FROM marshals WHERE code=?', 'M-01').id;
    const specialistId = q.get('SELECT id FROM specialists WHERE employee_idx=?', 102).id;
    const taskId = await dispatch(harness, departmentId, specialistId, '长任务输入回归', requirement);
    const row = await waitForTerminal(taskId);
    assert.equal(row.status, '待审阅');
    assert.equal(row.requirement, requirement);
    assert.equal(generatedArgs.length, 1, '短稿与length不能触发自动付费重写');
    assert.ok(generatedArgs[0].userMsg.includes(requirement), 'provider必须收到完整原始要求');
    assert.equal(q.get('SELECT body FROM contents WHERE id=?', row.output_id).body, report);
    const snapshot = JSON.parse(row.employee_web_snapshot);
    assert.equal(snapshot.outputContract.valid, true);
    assert.equal(snapshot.outputContract.qualityReview.requiresUserDecision, true);
    assert.ok(snapshot.outputContract.warnings.some(warning => /finish_reason=length/u.test(warning)));
    const response = await fetch(`${harness.base}/marshals/${departmentId}/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ specialistId, title: '超上限输入', requirement: '字'.repeat(32001) }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /32000/u);
    assert.equal(generatedArgs.length, 1, '超输入上限应在请求provider前返回清楚错误');
  } finally { await harness.close(); }
});

after(() => {
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Best effort cleanup of isolated database files.
    }
  }
});
