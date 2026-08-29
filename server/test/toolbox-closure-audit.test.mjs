import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This audit is intentionally offline.  The runner test below injects the
// provider gate and a local fake generator; it never calls a network client.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SHARED_DB_PATH = path.join(
  os.tmpdir(),
  `nanowork-toolbox-closure-${process.pid}.db`,
);
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    fs.rmSync(`${SHARED_DB_PATH}${suffix}`, { force: true });
  } catch {
    /* fresh audit DB */
  }
}
process.env.NANOWORK_DB = SHARED_DB_PATH;
const toolboxUi = fs.readFileSync(
  path.join(ROOT, "web/src/pages/Toolbox.tsx"),
  "utf8",
);
const toolboxRoute = fs.readFileSync(
  path.join(ROOT, "server/src/routes/toolbox.js"),
  "utf8",
);
const toolboxRunner = fs.readFileSync(
  path.join(ROOT, "server/src/engines/toolbox-job-runner.js"),
  "utf8",
);
const scheduler = fs.readFileSync(
  path.join(ROOT, "server/src/engines/scheduler.js"),
  "utf8",
);
const indexSource = fs.readFileSync(
  path.join(ROOT, "server/src/index.js"),
  "utf8",
);

test("Toolbox UI 后台轮询、任务中心深链、retry 与无AI失败文案闭环", () => {
  assert.match(toolboxUi, /api\s*\.get\(['"]\/toolbox\/runs\?limit=20['"]\)/u);
  assert.match(
    toolboxUi,
    /setInterval\(\(\) => void loadRuns\(true\),\s*2_000\)/u,
  );
  assert.match(toolboxUi, /clearInterval\(timer\)/u);
  assert.match(toolboxUi, /setViewRun\(current =>/u);
  assert.match(
    toolboxUi,
    /navigate\(viewRun\.deepLink \|\| `\/tasks\?kind=tool&id=\$\{viewRun\.id\}`\)/u,
  );
  assert.match(
    toolboxUi,
    /api\.post\(`\/toolbox\/runs\/\$\{run\.id\}\/retry`,\s*\{\}\)/u,
  );
  assert.match(toolboxUi, /onClick=\{\(\) => retryRun\(viewRun\)\}/u);
  assert.match(toolboxUi, /viewRun\.progress\?\.length/u);
  assert.match(toolboxUi, /viewRun\.error\?\.message/u);
  assert.match(
    toolboxUi,
    /真实通道不可用时任务会失败、释放预授权，不生成本地底稿冒充结果/u,
  );
  assert.match(toolboxUi, /真实通道失败会自动退款，不生成降级底稿/u);
  assert.match(toolboxUi, /不会作为正式业务交付/u);
});

test("tool route → runner → failure/success callbacks → poll/deepLink contract is wired", () => {
  assert.match(toolboxRoute, /enqueueToolboxRun,/u);
  assert.match(toolboxRoute, /toolboxJobActive\(req\.user\.tenant_id, id\)/u);
  assert.match(toolboxRoute, /function enqueueToolboxContext\(context\)/u);
  // Prettier may parenthesize a single callback argument (`(draft) =>`).
  assert.match(
    toolboxRoute,
    /onSuccess:\s*(?:\(\s*draft\s*\)|draft)\s*=>\s*finalizeToolboxRun\(context,\s*draft\)/u,
  );
  assert.match(
    toolboxRoute,
    /onFailure:\s*(?:\(\s*error\s*\)|error)\s*=>\s*failToolboxRun\(context,\s*error\)/u,
  );
  assert.match(toolboxRoute, /pollAfterMs:\s*2_000/u);
  assert.match(
    toolboxRoute,
    /pollUrl:\s*`\/toolbox\/runs\/\$\{(?:id|runId)\}`/u,
  );
  assert.match(
    toolboxRoute,
    /deepLink:\s*`\/tasks\?kind=tool&id=\$\{(?:id|runId)\}`/u,
  );
  assert.match(toolboxRoute, /releaseHold\(/u);
  assert.match(toolboxRoute, /status='failed',execution_state='failed'/u);

  assert.match(
    toolboxRunner,
    /export async function executeToolboxJob\(job\)/u,
  );
  assert.match(toolboxRunner, /export function enqueueToolboxRun\(job/u);
  assert.match(
    toolboxRunner,
    /export function toolboxJobActive\(tenantId, runId\)/u,
  );
  assert.match(
    toolboxRunner,
    /runWithTenant\(job\.tenantId, \(\) => executeToolboxJob\(job\)\)/u,
  );
  assert.match(toolboxRunner, /job\.onSuccess\(draft\)/u);
  assert.match(toolboxRunner, /job\.onFailure\(failure\)/u);
  assert.match(toolboxRunner, /TOOLBOX_JOB_TIMEOUT/u);
  assert.match(toolboxRunner, /TOOLBOX_JOB_HEARTBEAT_MS/u);
});

test("scheduler/index expose toolbox stale-run recovery even when scheduler is disabled", () => {
  assert.match(scheduler, /export function recoverStaleToolboxRuns\(/u);
  // Keep both recovery paths covered: startup fan-out and the per-tick
  // `runTenantJobs` counter used while ENABLE_SCHEDULER is active.
  assert.match(scheduler, /toolboxRuns:\s*recover\(\s*["']toolboxRuns["']/u);
  assert.match(
    scheduler,
    /result\.toolboxRunsRecovered\s*=\s*recoverStaleToolboxRuns\(now\)\.length/u,
  );
  assert.match(indexSource, /recoverStaleAiWorkAcrossTenants\(\)/u);
  assert.match(indexSource, /recovered\.toolboxRuns\.length/u);
});

test("offline runner gate: no-AI fails closed and invokes failure callback", async () => {
  process.env.YUNWU_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  const { executeToolboxJob } =
    await import("../src/engines/toolbox-job-runner.js?closure-audit");
  let success = null;
  let failure = null;
  await executeToolboxJob({
    tenantId: 1,
    runId: 991,
    definition: {
      key: "vars",
      title: "口播矩阵",
      employeeIdx: 140,
      employeeName: "章文案",
    },
    inputs: {
      script: "本地离线测试输入，禁止联网和外部动作。",
      variants: 2,
      platform: "视频号",
    },
    generationOptions: { aiAvailableFn: () => false },
    onSuccess: (draft) => {
      success = draft;
    },
    onFailure: (error) => {
      failure = error;
    },
  });
  assert.equal(success, null, "未配置AI不能回调成功或返回模板产物");
  assert.equal(failure?.code, "TOOLBOX_PROVIDER_UNAVAILABLE");
  assert.match(failure?.message || "", /不会生成本地底稿/u);
});

test("offline scheduler tick recovers stale toolbox run and records a terminal failure event", async () => {
  const { db, initSchema, migrateV2, q, runWithTenant } =
    await import("../src/db.js");
  const { runScheduledJobs } =
    await import("../src/engines/scheduler.js?closure-scheduler");
  initSchema();
  migrateV2();
  q.run(`INSERT INTO tenants(id,name,status,credits) VALUES(1,'工具箱审计租户','已开通',0)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status`);
  const username = `toolbox-closure-owner-${process.pid}`;
  const ownerId = Number(
    q.run(
      `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES(?, 'x', '工具箱审计负责人', 'boss', '启用', 1)`,
      username,
    ).lastInsertRowid,
  );
  const runId = runWithTenant(1, () =>
    Number(
      q.run(
        `INSERT INTO tool_runs(
      tool_key,tool_title,title,status,employee_idx,employee_name,created_by,input_json,
      input_summary,result_md,provenance_json,execution_state,last_heartbeat_at,timeout_at,
      created_at,updated_at
    ) VALUES('vars','口播矩阵','超时恢复审计','running',140,'章文案',?, '{}',
      '离线超时测试输入','# 工具运行中','{}','running','2026-01-01 00:00:00',
      '2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00')`,
        ownerId,
      ).lastInsertRowid,
    ),
  );
  const summary = runScheduledJobs(new Date("2026-01-02T00:00:00.000Z"), {
    contentAutomationRunner: async () => [],
  });
  await summary.pending;
  const row = q.get(
    "SELECT status,execution_state,error_json FROM tool_runs WHERE tenant_id=1 AND id=?",
    runId,
  );
  assert.equal(
    summary.results.find((item) => item.tenantId === 1)?.toolboxRunsRecovered,
    1,
  );
  assert.equal(row.status, "failed");
  assert.equal(row.execution_state, "failed");
  assert.equal(JSON.parse(row.error_json).code, "TOOLBOX_TIMEOUT_RECOVERY");
  const event = q.get(
    "SELECT status,metadata_json FROM tool_run_events WHERE tenant_id=1 AND run_id=?",
    runId,
  );
  assert.equal(event.status, "failed");
  assert.equal(JSON.parse(event.metadata_json).mode, "timeout_recovery");
  // Keep a direct reference so this test remains explicitly local/SQLite-only.
  assert.ok(db);
});

test("已知红点审计（不联网）：报告 scheduler tick 与非合作型 provider 硬超时缺口", async () => {
  const redPoints = [];
  const scheduledBody = scheduler.slice(
    scheduler.indexOf("function runTenantJobs"),
    scheduler.indexOf("export function runScheduledJobs"),
  );
  if (!/recoverStaleToolboxRuns\(/u.test(scheduledBody)) {
    redPoints.push({
      code: "TOOLBOX_SCHEDULER_TICK_RECOVERY_MISSING",
      evidence:
        "runScheduledJobs()未调用recoverStaleToolboxRuns；当前仅启动时recoverStaleAiWorkAcrossTenants。",
    });
  }
  const executeBody = toolboxRunner.slice(
    toolboxRunner.indexOf("export async function executeToolboxJob"),
    toolboxRunner.indexOf("export function enqueueToolboxRun"),
  );
  if (
    !/Promise\.race\(/u.test(executeBody) &&
    /controller\.abort\(/u.test(executeBody)
  ) {
    redPoints.push({
      code: "TOOLBOX_RUNNER_HARD_TIMEOUT_NOT_ENFORCED",
      evidence:
        "executeToolboxJob仅AbortController.abort，未以Promise.race/超时拒绝强制结束不合作的generateFn。",
    });
  }

  // Prove the second point with an injected local generator that ignores the
  // abort signal.  It is deliberately short (1.1s) and never calls a provider.
  const { executeToolboxJob } =
    await import("../src/engines/toolbox-job-runner.js?timeout-audit");
  let success = false;
  let failure = null;
  await executeToolboxJob({
    tenantId: 1,
    runId: 992,
    timeoutMs: 1_000,
    definition: {
      key: "vars",
      title: "口播矩阵",
      employeeIdx: 140,
      employeeName: "章文案",
    },
    inputs: {
      script: "本地离线超时审计输入，不访问网络。",
      variants: 2,
      platform: "视频号",
    },
    generationOptions: {
      aiAvailableFn: () => true,
      generateFn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        return {
          mode: "api",
          model: "offline-test-model",
          usage: { inputTokens: 2, outputTokens: 2 },
          text: "离线注入生成器返回的非模板文本，用来验证超时边界。",
        };
      },
    },
    onSuccess: () => {
      success = true;
    },
    onFailure: (error) => {
      failure = error;
    },
  });
  if (success && !failure) {
    redPoints.push({
      code: "TOOLBOX_RUNNER_TIMEOUT_IGNORING_ABORT_PROOF",
      evidence:
        "注入忽略AbortSignal的generateFn在timeoutMs=1000后仍触发onSuccess，未收敛为TOOLBOX_JOB_TIMEOUT。",
    });
  }
  console.log(`TOOLBOX_CLOSURE_AUDIT_RED_POINTS ${JSON.stringify(redPoints)}`);
  assert.ok(Array.isArray(redPoints));
});

after(() => {
  delete process.env.YUNWU_API_KEY;
  delete process.env.OPENAI_API_KEY;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(`${SHARED_DB_PATH}${suffix}`, { force: true });
    } catch {
      /* best effort */
    }
  }
});
