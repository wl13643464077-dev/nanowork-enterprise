import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

// Luna-only, local contract audit.  This file deliberately never starts the
// provider runtime, performs a network request, or charges a real account.
// It is the task-centre acceptance contract for the current Boss/platform_super
// test policy; production code is intentionally not changed by this audit.
const dbPath = path.join(
  os.tmpdir(),
  `nanowork-task-center-policy-${process.pid}.db`,
);
for (const suffix of ["", "-wal", "-shm"])
  fs.rmSync(`${dbPath}${suffix}`, { force: true });
process.env.NANOWORK_DB = dbPath;

const { db, initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const taskCenterRoutes = (await import("../src/routes/task-center.js")).default;

initSchema();
migrateV2();

const TENANT_ID = 901;
const BOSS_ID = 901001;
const SUPER_ID = 901003;
const STAFF_ID = 901002;
const boss = {
  id: BOSS_ID,
  name: "任务中心验收老板",
  role: "boss",
  tenant_id: TENANT_ID,
};
const platformSuper = {
  id: SUPER_ID,
  name: "任务中心验收平台超管",
  role: "platform_super",
  tenant_id: TENANT_ID,
};
const staff = {
  id: STAFF_ID,
  name: "任务中心验收员工",
  role: "staff",
  tenant_id: TENANT_ID,
};

db.prepare(
  `INSERT OR REPLACE INTO tenants(id,name,status,credits) VALUES(?,?,?,?)`,
).run(TENANT_ID, "任务中心策略审计租户", "启用", 1_000_000);
for (const user of [boss, platformSuper, staff]) {
  db.prepare(
    `INSERT OR REPLACE INTO users(
    id,username,password_hash,name,role,status,tenant_id
  ) VALUES(?,?,?,?,?,'启用',?)`,
  ).run(
    user.id,
    `task-center-policy-${user.id}`,
    "x",
    user.name,
    user.role,
    TENANT_ID,
  );
}

// migrateV2 intentionally permits a clean database without credit_holds.  A
// real task-centre run has the table, so this audit creates the same minimal
// two-phase ledger schema without invoking credit code or a provider.
db.exec(`
  CREATE TABLE IF NOT EXISTS credit_holds(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER,
    log_id INTEGER NOT NULL,
    feature TEXT,
    kind TEXT,
    model TEXT,
    held_credits INTEGER NOT NULL,
    settled_credits INTEGER,
    status TEXT,
    ref_type TEXT,
    ref_id INTEGER,
    created_at TEXT,
    settled_at TEXT
  );
`);

q.run(
  `INSERT OR IGNORE INTO marshals(id,code,name,title) VALUES(90101,'TASK-POLICY-M','策略审计元帅','策略审计')`,
);
// specialists are global catalogue rows.  Deliberately omit tenant_id here:
// the task's tenant must not make the employee JOIN disappear.
q.run(
  `INSERT OR IGNORE INTO specialists(id,marshal_id,name,employee_idx) VALUES(90102,90101,'餐饮策略员工',155)`,
);

const AUTO_ROUTING = {
  schemaVersion: "nanowork.approval-workflow-snapshot/1",
  policySchemaVersion: "nanowork.approval-routing-policy/2",
  targetType: "content",
  policyMode: "auto",
  policyReason: "auto_internal_output",
  reason: "auto_internal_output",
  requiresReview: false,
  autoAdopt: true,
  decisionKind: "auto_adopt",
  steps: [],
  currentStep: 0,
};
const EXPLICIT_ROUTING = {
  ...AUTO_ROUTING,
  policyMode: "manager",
  policyReason: "owner_configured_manager",
  reason: "owner_configured_manager",
  requiresReview: true,
  autoAdopt: false,
  decisionKind: "content_review",
  steps: [{ index: 0, level: "ops_director", assignedReviewerId: null }],
};
const EXECUTION_AUTH_ROUTING = {
  ...AUTO_ROUTING,
  requiresReview: true,
  autoAdopt: false,
  decisionKind: "execution_authorization",
  executionAuthorizationRequired: true,
  steps: [{ index: 0, level: "boss", assignedReviewerId: null }],
};
const SELF_AUTHORIZED_ROUTING = {
  ...EXPLICIT_ROUTING,
  requiresReview: false,
  autoAdopt: true,
  decisionKind: "review_self_authorized",
  actorAuthorizationSatisfied: true,
  contentReviewAuthorizationSatisfied: true,
  steps: [],
};
const HISTORICAL_ROUTING = {
  schemaVersion: "nanowork.approval-workflow-snapshot/1",
  policySchemaVersion: "nanowork.approval-routing-policy/1",
  targetType: "content",
  policyMode: "employee_setting",
  policyReason: "locked_employee_setting",
  reason: "locked_employee_setting",
  requiresReview: true,
  autoAdopt: false,
  steps: [{ index: 0, level: "boss", assignedReviewerId: null }],
  currentStep: 0,
  safeguards: {
    highRiskOwnerReview: true,
    externalActionOwnerReview: true,
    paidActionOwnerReview: true,
  },
};

function lockedPolicy(
  mode,
  schemaVersion = "nanowork.approval-routing-policy/2",
) {
  return {
    schemaVersion,
    employeeOutput: { mode, reviewerUserId: null },
    activityPlan: {
      mode: "two_step",
      reviewerUserId: null,
      ownerAmountThreshold: 10_000,
    },
    activityChecklist: { mode: "two_step", reviewerUserId: null },
    safeguards:
      schemaVersion === "nanowork.approval-routing-policy/1"
        ? {
            highRiskOwnerReview: true,
            externalActionOwnerReview: true,
            paidActionOwnerReview: true,
          }
        : {
            internalOutputReviewControlledByPolicy: true,
            externalActionOwnerAuthorization: true,
            paidActionOwnerAuthorization: true,
            irreversibleActionOwnerAuthorization: true,
          },
    configuredBy: { id: BOSS_ID, role: "boss" },
    updatedAt: "2026-08-08T09:00:00.000Z",
  };
}

const AUTO_POLICY = lockedPolicy("auto");
const MANAGER_POLICY = lockedPolicy("manager");
const RISK_POLICY = lockedPolicy("risk_based");
const HISTORICAL_POLICY = lockedPolicy(
  "employee_setting",
  "nanowork.approval-routing-policy/1",
);

function contentRun({
  title,
  status,
  body,
  routing,
  reviewDecision = null,
  createdAt = "2026-08-08 10:00:00",
}) {
  const result = q.run(
    `INSERT INTO content_employee_runs(
    tenant_id,employee_idx,employee_key,employee_name,employee_group,title,type,requirement,
    status,result_md,profile_version,prompt_hash,snapshot_json,created_by,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    TENANT_ID,
    3,
    "content-policy",
    "内容策略员工",
    "内容",
    title,
    "报告",
    "执行任务",
    status,
    body,
    "v1",
    "policy-hash",
    JSON.stringify({
      approvalRouting: routing,
      ...(reviewDecision ? { review: { decision: reviewDecision } } : {}),
    }),
    BOSS_ID,
    createdAt,
    createdAt,
  );
  return Number(result.lastInsertRowid);
}

function insertOutput(body, title = body.slice(0, 24)) {
  return Number(
    q.run(
      `INSERT INTO contents(tenant_id,type,title,body,status,creator_id,created_at)
    VALUES(?,?,?,?,?,?,datetime('now','localtime'))`,
      TENANT_ID,
      "报告",
      title,
      body,
      "可使用",
      BOSS_ID,
    ).lastInsertRowid,
  );
}

function restaurantTask({
  title,
  status,
  body,
  policy,
  routing = null,
  createdAt = "2026-08-08 10:00:00",
}) {
  const outputId = body ? insertOutput(body, title) : null;
  const result = q.run(
    `INSERT INTO agent_tasks(
    tenant_id,marshal_id,specialist_id,title,requirement,status,output_id,created_by,
    created_at,employee_web_snapshot,approval_routing_policy_snapshot
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    TENANT_ID,
    90101,
    90102,
    title,
    "执行任务",
    status,
    outputId,
    BOSS_ID,
    createdAt,
    JSON.stringify({
      providerAttempt: { mode: "api" },
      ...(routing ? { approvalRouting: routing } : {}),
    }),
    JSON.stringify(policy),
  );
  return Number(result.lastInsertRowid);
}

function restaurantOutputId(taskId) {
  return Number(
    q.get(
      "SELECT output_id FROM agent_tasks WHERE tenant_id=? AND id=?",
      TENANT_ID,
      taskId,
    )?.output_id || 0,
  );
}

function insertRestaurantApproval(taskId, { status, routing }) {
  const outputId = restaurantOutputId(taskId);
  assert.ok(outputId > 0, `restaurant task ${taskId} must have an output`);
  q.run(
    `INSERT INTO approvals(
      tenant_id,target_type,target_id,title,summary,risk_level,rules_hit,status,
      submitter_id,reviewer_id,approval_level,approval_policy_snapshot,decided_at
    ) VALUES(?,'content',?,'任务中心策略审阅','真实岗位结果','none','[]',?,?,?,?,?,?)`,
    TENANT_ID,
    outputId,
    status,
    BOSS_ID,
    status === "已通过" ? BOSS_ID : null,
    routing.steps?.[0]?.level || "ops_director",
    JSON.stringify(routing),
    status === "已通过" ? "2026-08-08 10:10:00" : null,
  );
  const stored = q.get(
    `SELECT status,approval_policy_snapshot FROM approvals
    WHERE tenant_id=? AND target_type='content' AND target_id=? ORDER BY id DESC LIMIT 1`,
    TENANT_ID,
    outputId,
  );
  assert.equal(
    stored?.status,
    status,
    "approval fixture must be tenant scoped",
  );
  assert.equal(
    stored?.approval_policy_snapshot,
    JSON.stringify(routing),
    "approval fixture must preserve the workflow snapshot",
  );
}

function insertLedger(
  refType,
  refId,
  {
    status,
    held = 0,
    settled = null,
    ledgerCredits = settled ?? held,
    cost = 0,
  },
) {
  const log = q.run(
    `INSERT INTO credit_logs(
    tenant_id,user_id,feature,kind,model,cost_yuan,credits,balance_after,ai_mode,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    TENANT_ID,
    BOSS_ID,
    "任务中心策略审计",
    "text",
    "luna-audit",
    cost,
    ledgerCredits,
    100000,
    "api",
    new Date().toISOString(),
  ).lastInsertRowid;
  q.run(
    `INSERT INTO credit_holds(
    tenant_id,user_id,log_id,feature,kind,model,held_credits,settled_credits,status,ref_type,ref_id,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    TENANT_ID,
    BOSS_ID,
    log,
    "任务中心策略审计",
    "text",
    "luna-audit",
    held,
    settled,
    status,
    refType,
    refId,
    new Date().toISOString(),
  );
}

const manualId = Number(
  q.run(
    `INSERT INTO tasks(
  tenant_id,title,detail,status,assignee_id,created_at,done_at
) VALUES(901,'策略审计人工任务','已完成的人工结果','已完成',?,? ,?)`,
    BOSS_ID,
    new Date().toISOString(),
    new Date().toISOString(),
  ).lastInsertRowid,
);

const autoRestaurantId = restaurantTask({
  title: "当前 auto 餐饮任务",
  status: "已完成",
  body: "当前 auto 结果",
  policy: AUTO_POLICY,
});
insertLedger("agent_task", autoRestaurantId, {
  status: "settled",
  held: 40,
  settled: 5,
  ledgerCredits: 5,
  cost: 0.03,
});

const historicalRestaurantId = restaurantTask({
  title: "历史旧策略餐饮任务",
  status: "待审阅",
  body: "历史待审结果",
  policy: HISTORICAL_POLICY,
  createdAt: "2026-07-01 10:00:00",
});
insertRestaurantApproval(historicalRestaurantId, {
  status: "待审核",
  routing: HISTORICAL_ROUTING,
});
insertLedger("agent_task", historicalRestaurantId, {
  status: "settled",
  held: 18,
  settled: 2,
  ledgerCredits: 2,
  cost: 0.01,
});

const heldFailedRestaurantId = restaurantTask({
  title: "失败但仍占扣的餐饮任务",
  status: "失败",
  body: "",
  policy: AUTO_POLICY,
});
insertLedger("agent_task", heldFailedRestaurantId, {
  status: "held",
  held: 12,
  settled: null,
  ledgerCredits: 12,
});

const humanRestaurantId = restaurantTask({
  title: "负责人策略人工采纳餐饮任务",
  status: "已完成",
  body: "负责人已人工采纳的结果",
  policy: MANAGER_POLICY,
});
insertRestaurantApproval(humanRestaurantId, {
  status: "已通过",
  routing: EXPLICIT_ROUTING,
});
insertLedger("agent_task", humanRestaurantId, {
  status: "settled",
  held: 35,
  settled: 4,
  ledgerCredits: 4,
  cost: 0.03,
});

const unresolvedRiskRestaurantId = restaurantTask({
  title: "按风险分流但缺少本次决策证据的餐饮任务",
  status: "已完成",
  body: "只有锁定风险策略、没有本次路由决策的结果",
  policy: RISK_POLICY,
});
insertLedger("agent_task", unresolvedRiskRestaurantId, {
  status: "settled",
  held: 32,
  settled: 4,
  ledgerCredits: 4,
  cost: 0.03,
});

const resolvedRiskAutoRestaurantId = restaurantTask({
  title: "按风险分流且本次自动采用的餐饮任务",
  status: "已完成",
  body: "锁定 risk_based 策略，本次路由明确自动采用",
  policy: RISK_POLICY,
  routing: AUTO_ROUTING,
});
insertLedger("agent_task", resolvedRiskAutoRestaurantId, {
  status: "settled",
  held: 31,
  settled: 4,
  ledgerCredits: 4,
  cost: 0.03,
});

const resolvedRiskHumanRestaurantId = restaurantTask({
  title: "按风险分流且本次人工采纳的餐饮任务",
  status: "已完成",
  body: "锁定 risk_based 策略，本次路由进入负责人审阅并通过",
  policy: RISK_POLICY,
});
insertRestaurantApproval(resolvedRiskHumanRestaurantId, {
  status: "已通过",
  routing: EXPLICIT_ROUTING,
});
insertLedger("agent_task", resolvedRiskHumanRestaurantId, {
  status: "settled",
  held: 33,
  settled: 4,
  ledgerCredits: 4,
  cost: 0.03,
});

const autoContentId = contentRun({
  title: "当前 auto 内容任务",
  status: "已完成",
  body: "当前 auto 内容结果",
  routing: AUTO_ROUTING,
  reviewDecision: "auto_adopt",
});
insertLedger("content_employee_run", autoContentId, {
  status: "settled",
  held: 25,
  settled: 3,
  ledgerCredits: 3,
  cost: 0.02,
});

const executionPendingContentId = contentRun({
  title: "auto 策略但本次等待执行授权",
  status: "已完成",
  body: "内部产出完成，但本次动作需要老板执行授权",
  routing: EXECUTION_AUTH_ROUTING,
});
insertLedger("content_employee_run", executionPendingContentId, {
  status: "settled",
  held: 24,
  settled: 3,
  ledgerCredits: 3,
  cost: 0.02,
});

const selfAuthorizedContentId = contentRun({
  title: "负责人策略由授权人本次确认",
  status: "已完成",
  body: "由具备权限的发起人明确确认并采纳",
  routing: SELF_AUTHORIZED_ROUTING,
});
insertLedger("content_employee_run", selfAuthorizedContentId, {
  status: "settled",
  held: 26,
  settled: 3,
  ledgerCredits: 3,
  cost: 0.02,
});

const explicitContentId = contentRun({
  title: "当前显式策略内容任务",
  status: "待审阅",
  body: "当前显式策略结果",
  routing: EXPLICIT_ROUTING,
});
insertLedger("content_employee_run", explicitContentId, {
  status: "settled",
  held: 30,
  settled: 4,
  ledgerCredits: 4,
  cost: 0.025,
});

const historicalContentId = contentRun({
  title: "历史旧策略内容任务",
  status: "待审阅",
  body: "历史旧策略结果",
  routing: HISTORICAL_ROUTING,
  createdAt: "2026-07-01 11:00:00",
});
insertLedger("content_employee_run", historicalContentId, {
  status: "settled",
  held: 20,
  settled: 2,
  ledgerCredits: 2,
  cost: 0.012,
});

const pendingContentId = contentRun({
  title: "待对账内容任务",
  status: "已完成",
  body: "账务尚未对平的结果",
  routing: AUTO_ROUTING,
  reviewDecision: "auto_adopt",
});
insertLedger("content_employee_run", pendingContentId, {
  status: "settled",
  held: 22,
  settled: 5,
  ledgerCredits: 7,
  cost: 0.04,
});

const mediaId = Number(
  q.run(
    `INSERT INTO media_jobs(
  tenant_id,user_id,kind,prompt,status,url,content_employee_name,created_at
) VALUES(901,?,'video','策略审计媒体','成功','https://example.invalid/audit.mp4','AI带货员',datetime('now','localtime'))`,
    BOSS_ID,
  ).lastInsertRowid,
);
insertLedger("media_job", mediaId, {
  status: "settled",
  held: 15,
  settled: 10,
  ledgerCredits: 10,
  cost: 0.08,
});

const ruleId = Number(
  q.run(
    `INSERT INTO content_automation_rules(
  tenant_id,name,enabled,employee_idx,topic,requirement,brief_json,content_type,content_count,
  frequency,run_time,approval_mode,created_by,created_at,updated_at
) VALUES(901,'策略审计自动化',1,3,'策略主题','自动执行','{}','报告',1,'daily','09:00','auto',?,datetime('now','localtime'),datetime('now','localtime'))`,
    BOSS_ID,
  ).lastInsertRowid,
);
const automationContentId = insertOutput(
  "当前自动化按锁定 auto 路由自动采用的结果",
  "策略审计自动化结果",
);
q.run(
  `UPDATE contents SET snapshot_json=?,content_employee_name='内容策略员工'
  WHERE tenant_id=? AND id=?`,
  JSON.stringify({ approvalRouting: AUTO_ROUTING }),
  TENANT_ID,
  automationContentId,
);
const automationId = Number(
  q.run(
    `INSERT INTO content_automation_runs(
  tenant_id,rule_id,trigger,claim_key,status,initiated_by,snapshot_json,started_at,finished_at,content_id
) VALUES(901,?,'immediate','policy-audit-claim','成功',?,?,datetime('now','localtime'),datetime('now','localtime'),?)`,
    ruleId,
    BOSS_ID,
    JSON.stringify({ approvalRouting: AUTO_ROUTING }),
    automationContentId,
  ).lastInsertRowid,
);
insertLedger("content_automation_run", automationId, {
  status: "settled",
  held: 8,
  settled: 1,
  ledgerCredits: 1,
  cost: 0.006,
});

const failedToolId = Number(
  q.run(
    `INSERT INTO tool_runs(
  tenant_id,tool_key,tool_title,title,status,employee_idx,employee_name,specialist_id,created_by,
  input_json,input_summary,result_md,assumptions_json,evidence_json,provenance_json,created_at,updated_at
) VALUES(901,'hot','策略工具','失败退款工具','failed',155,'餐饮策略员工',90102,?,
  '{}','失败工具输入','执行失败','[]','[]','{}',datetime('now','localtime'),datetime('now','localtime'))`,
    BOSS_ID,
  ).lastInsertRowid,
);
insertLedger("tool_run", failedToolId, {
  status: "settled",
  held: 13,
  settled: 0,
  ledgerCredits: 0,
  cost: 0,
});

function appFor(user) {
  const app = express();
  app.use((req, _res, next) =>
    runWithTenant(TENANT_ID, () => {
      req.user = user;
      next();
    }),
  );
  app.use("/task-center", taskCenterRoutes);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0, "127.0.0.1");
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function get(base, url) {
  const response = await fetch(`${base}${url}`);
  return { status: response.status, body: await response.json() };
}

function assertPolicyContext(value, expectedKind) {
  assert.ok(
    value && typeof value === "object",
    "policyContext must be present",
  );
  assert.ok(
    [
      "none",
      "auto_policy",
      "risk_based_policy",
      "historical_policy",
      "explicit_policy",
      "unknown_policy",
    ].includes(value.kind),
  );
  assert.equal(typeof value.historical, "boolean");
  assert.equal(typeof value.label, "string");
  assert.doesNotMatch(value.label, /\[object Object\]|直接采用/u);
  if (expectedKind) assert.equal(value.kind, expectedKind);
  if (value.kind === "historical_policy") {
    assert.equal(value.historical, true);
    assert.match(value.label, /历史记录|旧策略/u);
  }
  if (value.kind === "explicit_policy") assert.equal(value.historical, false);
  if (value.kind === "none") assert.equal(value.historical, false);
}

function assertAdoptionContext(value, expectedKind) {
  assert.ok(
    value && typeof value === "object",
    "adoptionContext must be present",
  );
  assert.ok(
    [
      "not_applicable",
      "not_adopted",
      "pending_review",
      "execution_authorization_pending",
      "automatic",
      "human",
      "rejected",
      "unknown",
    ].includes(value.kind),
  );
  assert.equal(typeof value.adopted, "boolean");
  assert.equal(typeof value.terminal, "boolean");
  assert.equal(typeof value.label, "string");
  if (expectedKind) assert.equal(value.kind, expectedKind);
}

test("Boss/platform_super 当前 auto 内部任务在统一任务中心无审批增量，且行/详情均可采用", async () => {
  for (const actor of [boss, platformSuper]) {
    await withServer(actor, async (base) => {
      const before = Number(
        q.get(
          "SELECT COUNT(*) count FROM approvals WHERE tenant_id=?",
          TENANT_ID,
        )?.count || 0,
      );
      const list = await get(base, "/task-center?pageSize=100");
      assert.equal(list.status, 200);
      const rows = list.body.items.filter((row) =>
        [
          `restaurant:${autoRestaurantId}`,
          `content:${autoContentId}`,
          `automation:${automationId}`,
        ].includes(row.sourceKey),
      );
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.equal(row.state, "done", row.sourceKey);
        assert.equal(row.businessUsable, true, row.sourceKey);
        if (row.kind === "restaurant") {
          assert.equal(
            row.employee,
            "餐饮策略员工",
            "global specialists must join by specialist id, not task tenant_id",
          );
        }
        assertPolicyContext(row.policyContext, "auto_policy");
        assertAdoptionContext(row.adoptionContext, "automatic");
        assert.equal(row.adoptionKind, "automatic");
        assert.equal(row.displayStatus, "已自动采用（可用于业务）");
        const detail = await get(base, `/task-center/${row.kind}/${row.id}`);
        assert.equal(detail.status, 200, row.sourceKey);
        assert.equal(detail.body.businessUsable, true, row.sourceKey);
        if (row.kind === "restaurant") {
          assert.equal(
            detail.body.employee,
            "餐饮策略员工",
            "restaurant detail must join the global specialist by id",
          );
        }
        assertPolicyContext(detail.body.policyContext, "auto_policy");
        assertAdoptionContext(detail.body.adoptionContext, "automatic");
        assert.equal(detail.body.adoptionKind, "automatic");
        assert.equal(detail.body.displayStatus, "已自动采用（可用于业务）");
      }
      const after = Number(
        q.get(
          "SELECT COUNT(*) count FROM approvals WHERE tenant_id=?",
          TENANT_ID,
        )?.count || 0,
      );
      assert.equal(
        after - before,
        0,
        "Boss auto internal read must not create approval rows",
      );
    });
  }
});

test("餐饮生产快照按 employeeOutput.mode 展示策略，实际采用优先审批证据且不猜 risk_based", async () => {
  await withServer(boss, async (base) => {
    const list = await get(base, "/task-center?kind=restaurant&pageSize=100");
    assert.equal(list.status, 200);
    const byId = Object.fromEntries(
      list.body.items.map((row) => [Number(row.id), row]),
    );

    const auto = byId[autoRestaurantId];
    assertPolicyContext(auto.policyContext, "auto_policy");
    assert.equal(auto.policyContext.mode, "auto");
    assert.match(auto.policyContext.label, /质量与账务门后自动采用/u);
    assertAdoptionContext(auto.adoptionContext, "automatic");

    const human = byId[humanRestaurantId];
    assertPolicyContext(human.policyContext, "explicit_policy");
    assert.equal(human.policyContext.mode, "manager");
    assert.equal(
      human.adoptionContext?.kind,
      "human",
      JSON.stringify(human, null, 2),
    );
    assert.equal(human.adoptionKind, "human");
    assert.equal(human.displayStatus, "已人工采纳（可用于业务）");
    assert.equal(human.businessUsable, true);

    const unresolvedRisk = byId[unresolvedRiskRestaurantId];
    assertPolicyContext(unresolvedRisk.policyContext, "risk_based_policy");
    assert.equal(unresolvedRisk.policyContext.mode, "risk_based");
    assertAdoptionContext(unresolvedRisk.adoptionContext, "unknown");
    assert.equal(unresolvedRisk.displayStatus, "已完成（采用方式待核验）");
    assert.equal(
      unresolvedRisk.businessUsable,
      false,
      "risk_based without a locked decision or approval must not be guessed as automatic",
    );

    const resolvedRiskAuto = byId[resolvedRiskAutoRestaurantId];
    assertPolicyContext(resolvedRiskAuto.policyContext, "risk_based_policy");
    assert.equal(resolvedRiskAuto.policyContext.mode, "risk_based");
    assert.equal(resolvedRiskAuto.policyContext.source, "locked_policy");
    assert.equal(
      resolvedRiskAuto.policyContext.decisionKind,
      null,
      "the resolved run decision belongs to adoptionContext, not policyContext",
    );
    assertAdoptionContext(resolvedRiskAuto.adoptionContext, "automatic");
    assert.equal(resolvedRiskAuto.adoptionContext.decisionKind, "auto_adopt");
    assert.equal(resolvedRiskAuto.displayStatus, "已自动采用（可用于业务）");
    assert.equal(resolvedRiskAuto.businessUsable, true);

    const resolvedRiskHuman = byId[resolvedRiskHumanRestaurantId];
    assertPolicyContext(resolvedRiskHuman.policyContext, "risk_based_policy");
    assert.equal(resolvedRiskHuman.policyContext.mode, "risk_based");
    assert.equal(resolvedRiskHuman.policyContext.source, "locked_policy");
    assertAdoptionContext(resolvedRiskHuman.adoptionContext, "human");
    assert.equal(resolvedRiskHuman.adoptionContext.source, "approval_record");
    assert.equal(resolvedRiskHuman.displayStatus, "已人工采纳（可用于业务）");
    assert.equal(resolvedRiskHuman.businessUsable, true);

    const historical = byId[historicalRestaurantId];
    assertPolicyContext(historical.policyContext, "historical_policy");
    assert.equal(historical.policyContext.mode, "employee_setting");
    assertAdoptionContext(historical.adoptionContext, "pending_review");
    assert.equal(historical.displayStatus, "待人工审阅");

    for (const id of [
      autoRestaurantId,
      humanRestaurantId,
      unresolvedRiskRestaurantId,
      resolvedRiskAutoRestaurantId,
      resolvedRiskHumanRestaurantId,
      historicalRestaurantId,
    ]) {
      const detail = await get(base, `/task-center/restaurant/${id}`);
      assert.equal(detail.status, 200);
      assert.deepEqual(detail.body.policyContext, byId[id].policyContext);
      assert.deepEqual(detail.body.adoptionContext, byId[id].adoptionContext);
      assert.equal(detail.body.displayStatus, byId[id].displayStatus);
    }
  });
});

test("旧 v1/岗位策略待审记录明确标注历史，当前显式策略不能冒充历史", async () => {
  await withServer(boss, async (base) => {
    const list = await get(base, "/task-center?kind=content&pageSize=100");
    assert.equal(list.status, 200);
    const byId = Object.fromEntries(
      list.body.items.map((row) => [row.id, row]),
    );
    assertPolicyContext(
      byId[historicalContentId]?.policyContext,
      "historical_policy",
    );
    assertAdoptionContext(
      byId[historicalContentId]?.adoptionContext,
      "pending_review",
    );
    assertPolicyContext(
      byId[explicitContentId]?.policyContext,
      "explicit_policy",
    );
    assertAdoptionContext(
      byId[explicitContentId]?.adoptionContext,
      "pending_review",
    );
    assert.equal(byId[historicalContentId].state, "review");
    assert.equal(byId[explicitContentId].state, "review");
    assert.equal(
      byId[historicalContentId].reviewReady,
      false,
      "historical old-policy rows must not offer a current review action",
    );
    assert.equal(
      byId[explicitContentId].reviewReady,
      true,
      "current explicit policy rows remain review-ready",
    );
    const historicalDetail = await get(
      base,
      `/task-center/content/${historicalContentId}`,
    );
    const explicitDetail = await get(
      base,
      `/task-center/content/${explicitContentId}`,
    );
    assert.equal(historicalDetail.status, 200);
    assert.equal(explicitDetail.status, 200);
    assertPolicyContext(
      historicalDetail.body.policyContext,
      "historical_policy",
    );
    assertPolicyContext(explicitDetail.body.policyContext, "explicit_policy");
    assert.equal(historicalDetail.body.reviewReady, false);
    assert.equal(explicitDetail.body.reviewReady, true);
  });
});

test("本次锁定路由优先决定采用结果：执行授权不冒充自动采用，自授权明确标为人工", async () => {
  await withServer(boss, async (base) => {
    const list = await get(base, "/task-center?kind=content&pageSize=100");
    assert.equal(list.status, 200);
    const byId = Object.fromEntries(
      list.body.items.map((row) => [Number(row.id), row]),
    );

    const executionPending = byId[executionPendingContentId];
    assertPolicyContext(executionPending.policyContext, "auto_policy");
    assertAdoptionContext(
      executionPending.adoptionContext,
      "execution_authorization_pending",
    );
    assert.equal(executionPending.displayStatus, "待老板执行授权");
    assert.equal(executionPending.businessUsable, false);

    const selfAuthorized = byId[selfAuthorizedContentId];
    assertPolicyContext(selfAuthorized.policyContext, "explicit_policy");
    assertAdoptionContext(selfAuthorized.adoptionContext, "human");
    assert.equal(
      selfAuthorized.displayStatus,
      "已由授权人确认并采纳（可用于业务）",
    );
    assert.equal(selfAuthorized.businessUsable, true);

    for (const id of [executionPendingContentId, selfAuthorizedContentId]) {
      const detail = await get(base, `/task-center/content/${id}`);
      assert.equal(detail.status, 200);
      assert.deepEqual(detail.body.policyContext, byId[id].policyContext);
      assert.deepEqual(detail.body.adoptionContext, byId[id].adoptionContext);
      assert.equal(detail.body.displayStatus, byId[id].displayStatus);
    }
  });
});

test("六类任务都给出可回看的详情与稳定深链；员工范围仍受收口", async () => {
  await withServer(boss, async (base) => {
    const list = await get(base, "/task-center?pageSize=100");
    assert.equal(list.status, 200);
    const kinds = new Set(list.body.items.map((row) => row.kind));
    assert.deepEqual(
      kinds,
      new Set([
        "manual",
        "restaurant",
        "content",
        "media",
        "automation",
        "tool",
      ]),
    );
    for (const row of list.body.items) {
      assert.equal(typeof row.deepLink, "string", `${row.sourceKey}: deepLink`);
      assert.equal(
        row.deepLink,
        `/tasks?kind=${row.kind}&id=${row.id}`,
        `${row.sourceKey}: stable deepLink`,
      );
      const detail = await get(base, `/task-center/${row.kind}/${row.id}`);
      assert.equal(detail.status, 200, `${row.sourceKey}: detail`);
      assert.equal(
        typeof detail.body.input,
        "string",
        `${row.sourceKey}: input`,
      );
      assert.equal(
        typeof detail.body.output,
        "string",
        `${row.sourceKey}: output`,
      );
      assert.equal(
        typeof detail.body.deepLink,
        "string",
        `${row.sourceKey}: detail deepLink`,
      );
      assert.equal(
        detail.body.deepLink,
        `/tasks?kind=${row.kind}&id=${row.id}`,
        `${row.sourceKey}: detail stable deepLink`,
      );
      assert.equal(detail.body.sourceKey, row.sourceKey);
      assertPolicyContext(detail.body.policyContext);
      assertAdoptionContext(detail.body.adoptionContext);
      assert.equal(detail.body.adoptionKind, detail.body.adoptionContext.kind);
      assert.equal(typeof detail.body.displayStatus, "string");
      assert.ok(
        detail.body.stepIndex >= 1 &&
          detail.body.stepTotal >= detail.body.stepIndex,
      );
    }
  });
  await withServer(staff, async (base) => {
    const list = await get(base, "/task-center?pageSize=100");
    assert.equal(list.status, 200);
    assert.equal(
      list.body.items.length,
      0,
      "non-owner cannot read Boss-created tasks",
    );
  });
});

test("失败退款和 held/pending 对账在任务中心不被伪装成可用结果", async () => {
  await withServer(boss, async (base) => {
    const list = await get(base, "/task-center?pageSize=100");
    assert.equal(list.status, 200);
    const byKey = Object.fromEntries(
      list.body.items.map((row) => [row.sourceKey, row]),
    );
    assert.equal(byKey[`tool:${failedToolId}`]?.billing.state, "released");
    assert.equal(byKey[`tool:${failedToolId}`]?.businessUsable, false);
    assert.equal(
      byKey[`restaurant:${heldFailedRestaurantId}`]?.billing.state,
      "held",
    );
    assert.equal(
      byKey[`restaurant:${heldFailedRestaurantId}`]?.businessUsable,
      false,
    );
    assert.match(
      byKey[`restaurant:${heldFailedRestaurantId}`]?.billing.label || "",
      /退款|对账/u,
      "failed task with an outstanding hold must be visibly marked for refund/reconciliation",
    );
    assert.equal(
      byKey[`content:${pendingContentId}`]?.billing.state,
      "pending_reconciliation",
    );
    assert.equal(byKey[`content:${pendingContentId}`]?.state, "blocked");
    assert.equal(byKey[`content:${pendingContentId}`]?.businessUsable, false);
    const pendingDetail = await get(
      base,
      `/task-center/content/${pendingContentId}`,
    );
    assert.equal(pendingDetail.status, 200);
    assert.equal(pendingDetail.body.billing.state, "pending_reconciliation");
    assert.equal(pendingDetail.body.businessUsable, false);
  });
});

test("任务中心前端分开消费 policyContext 与 adoptionContext，不从 raw status 猜采用结果", () => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const source = fs.readFileSync(
    path.join(root, "web/src/pages/TaskCenter.tsx"),
    "utf8",
  );
  assert.match(
    source,
    /policyContext/u,
    "row and detail must render policy context",
  );
  assert.match(
    source,
    /adoptionContext/u,
    "row and detail must render the actual adoption context separately",
  );
  assert.match(
    source,
    /displayStatus/u,
    "task status must use the server canonical auto/manual projection",
  );
  assert.match(
    source,
    /deepLink/u,
    "task center must render a stable deep link",
  );
  assert.match(
    source,
    /URLSearchParams|window\.location\.search/u,
    "task center must parse /tasks?kind=...&id=... and open the same drawer",
  );
  assert.match(
    source,
    /历史记录|旧策略/u,
    "legacy review must be visibly marked as history/old policy",
  );
  assert.doesNotMatch(
    source,
    /row\.status\s*===\s*['"]待审阅['"]/u,
    "current review wording may not be inferred directly from raw status",
  );
  assert.doesNotMatch(
    source,
    /return row\?\.status\s*\|\|/u,
    "completed adoption wording may not fall back to the raw task status",
  );
  assert.doesNotMatch(
    source,
    /普通内部结果直接采用/u,
    "auto policy wording must retain the quality and billing gates",
  );
});

after(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  for (const suffix of ["", "-wal", "-shm"])
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
});
