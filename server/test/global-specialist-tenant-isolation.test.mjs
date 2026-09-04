import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { removeTempDbSafely } from "./helpers/temp-db.mjs";

// Luna-only regression audit.  This test is deliberately local: it never
// starts a provider, opens the network, or charges a real account.  The
// specialist catalogue is global; only agent_tasks/contents/ledger rows are
// tenant-owned.  A non-default tenant catches accidental `s.tenant_id=t...`
// joins that silently erase the employee profile.
const DB_PATH = path.join(
  os.tmpdir(),
  `nanowork-global-specialist-tenant-${process.pid}.db`,
);
for (const suffix of ["", "-wal", "-shm"])
  fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
process.env.NANOWORK_DB = DB_PATH;
process.env.NODE_ENV = "test";
process.env.SEED_DEMO = "false";
process.env.ENABLE_SCHEDULER = "false";
process.env.YUNWU_API_KEY = " ";
process.env.OPENAI_API_KEY = " ";

const { db, initSchema, migrateV2, runWithTenant } =
  await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { listUnifiedTasks, getUnifiedTaskDetail } =
  await import("../src/engines/task-center.js");
const { loadContentDeliveryState } =
  await import("../src/engines/delivery-state.js");
const { inspectAiReconciliationHold } =
  await import("../src/engines/ai-reconciliation.js");
const { recoverStaleAgentTasks } = await import("../src/engines/scheduler.js");
const {
  buildRestaurantOutputDeliverableFixture,
  getRestaurantOutputContract,
  renderRestaurantOutputMarkdown,
  validateRestaurantEmployeeOutputContract,
} = await import("../src/engines/restaurant-output-contract.js");
const businessFlowRoutes = (await import("../src/routes/business-flow.js"))
  .default;

initSchema();
migrateV2();
ensureBaselineCatalogs();

// The credit module creates this table lazily on its first hold.  This audit
// does not invoke the credit engine (that would mutate a user wallet), so make
// the read-only ledger fixture explicitly and keep its schema identical.
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
    status TEXT DEFAULT 'held',
    ref_type TEXT,
    ref_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    settled_at TEXT
  );
`);

const TENANT_ID = 2901;
const USER_ID = 2901001;
const TASK_TITLE = "全局员工跨租户门禁回归";
const TASK_REQUIREMENT = "使用总部目录员工执行本地租户任务";
const tenant = {
  id: TENANT_ID,
  name: "全局员工隔离回归租户",
  status: "已开通",
  credits: 100_000,
};
const user = {
  id: USER_ID,
  name: "隔离回归老板",
  role: "boss",
  tenant_id: TENANT_ID,
};

db.prepare(
  `INSERT INTO tenants(id,name,status,plan,credits) VALUES(?,?,?,'旗舰版',?)`,
).run(tenant.id, tenant.name, tenant.status, tenant.credits);
db.prepare(
  `INSERT INTO users(id,username,password_hash,name,role,status,tenant_id)
   VALUES(?,?,?,'隔离回归老板','boss','启用',?)`,
).run(user.id, "global-specialist-tenant-boss", "x", user.tenant_id);

// ensureBaselineCatalogs writes the shared catalogue in tenant 1.  Keep that
// value intentionally: it is evidence that specialist rows are not tenant
// business data and must still be usable by tenant 2901.
const specialist = db
  .prepare(
    `SELECT s.id,s.marshal_id,s.employee_idx,s.name,s.key,s.tenant_id,m.name marshal_name
   FROM specialists s JOIN marshals m ON m.id=s.marshal_id
   WHERE s.employee_idx=155 LIMIT 1`,
  )
  .get();
assert.ok(specialist, "baseline global specialist 155 is required");
assert.equal(
  Number(specialist.tenant_id),
  1,
  "fixture must preserve the global catalogue tenant marker",
);
const employeeName = String(specialist.name);
const marshalName = String(specialist.marshal_name);

function deliveryFixture(title = TASK_TITLE, requirement = TASK_REQUIREMENT) {
  const parsed = buildRestaurantOutputDeliverableFixture(
    Number(specialist.employee_idx),
    {
      title,
      requirement,
    },
  );
  const contract = getRestaurantOutputContract(Number(specialist.employee_idx));
  const checked = validateRestaurantEmployeeOutputContract(
    Number(specialist.employee_idx),
    parsed,
    {
      task: { title, requirement },
    },
  );
  assert.equal(checked.valid, true, checked.errors?.join("\n"));
  const body = renderRestaurantOutputMarkdown(
    Number(specialist.employee_idx),
    parsed,
    {
      task: { title, requirement },
    },
  );
  const artifactSha = crypto
    .createHash("sha256")
    .update(checked.artifacts[0].content, "utf8")
    .digest("hex");
  return {
    body,
    evidence: {
      kind: "restaurant_employee_execution_evidence",
      web: { attempted: false, ok: true, results: [] },
      providerAttempt: {
        mode: "api",
        model: "luma-global-specialist-audit",
        usage: { inputTokens: 11, outputTokens: 17 },
      },
      outputContract: {
        valid: true,
        contractId: contract.contractId,
        schemaVersion: contract.schemaVersion,
        primaryArtifact: contract.primaryArtifact,
        parsedOutput: parsed,
        providerResponseSha256: artifactSha,
        renderedBodySha256: crypto
          .createHash("sha256")
          .update(body, "utf8")
          .digest("hex"),
        artifacts: [
          {
            primary: true,
            kind: contract.primaryArtifact,
            contractId: contract.contractId,
            schemaVersion: contract.schemaVersion,
            contentSha256: artifactSha,
          },
        ],
      },
      internalProfileLeakage: { detected: false, matches: [] },
    },
  };
}

function insertContent({
  title = TASK_TITLE,
  status = "可使用",
  createdAt = "2026-08-01 09:00:00",
} = {}) {
  const fixture = deliveryFixture(title);
  const id = Number(
    db
      .prepare(
        `INSERT INTO contents(
      tenant_id,type,title,body,status,ai_mode,creator_id,marshal_id,snapshot_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        TENANT_ID,
        "员工产出",
        title,
        fixture.body,
        status,
        "api",
        USER_ID,
        specialist.marshal_id,
        JSON.stringify({
          contract: { valid: true },
          internalProfileLeakage: { detected: false },
        }),
        createdAt,
      ).lastInsertRowid,
  );
  return { id, fixture };
}

function insertTask({
  title = TASK_TITLE,
  status = "待审阅",
  outputId = null,
  createdAt = "2026-08-01 09:00:00",
  fixture = null,
} = {}) {
  const evidence = fixture || deliveryFixture(title);
  return Number(
    db
      .prepare(
        `INSERT INTO agent_tasks(
    tenant_id,marshal_id,specialist_id,title,type,requirement,status,output_id,created_by,
    employee_profile_version,employee_web_snapshot,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        TENANT_ID,
        specialist.marshal_id,
        specialist.id,
        title,
        "常规",
        TASK_REQUIREMENT,
        status,
        outputId,
        USER_ID,
        "global-specialist-profile-v1",
        JSON.stringify(evidence.evidence || evidence),
        createdAt,
      ).lastInsertRowid,
  );
}

function settleTaskLedger(taskId) {
  const feature = `员工任务·${marshalName}`;
  const logId = Number(
    db
      .prepare(
        `INSERT INTO credit_logs(
    tenant_id,user_id,feature,kind,model,ai_mode,input_tokens,output_tokens,cost_yuan,credits,balance_after,created_at
  ) VALUES(?,?,?,?,?,'api',?,?,?,?,?,datetime('now','localtime'))`,
      )
      .run(
        TENANT_ID,
        USER_ID,
        feature,
        "text",
        "luma-global-specialist-audit",
        11,
        17,
        0.01,
        3,
        tenant.credits - 3,
      ).lastInsertRowid,
  );
  const holdId = Number(
    db
      .prepare(
        `INSERT INTO credit_holds(
    tenant_id,user_id,log_id,feature,kind,model,held_credits,settled_credits,status,ref_type,ref_id,created_at,settled_at
  ) VALUES(?,?,?,?,?,?,?,?,'settled','agent_task',?,datetime('now','localtime'),datetime('now','localtime'))`,
      )
      .run(
        TENANT_ID,
        USER_ID,
        logId,
        feature,
        "text",
        "luma-global-specialist-audit",
        5,
        3,
        taskId,
      ).lastInsertRowid,
  );
  return holdId;
}

const listedTaskId = insertTask({
  title: "任务中心全局员工任务",
  status: "待审阅",
});
const output = insertContent({ title: TASK_TITLE, status: "可使用" });
const businessTaskId = insertTask({
  title: TASK_TITLE,
  status: "待审阅",
  outputId: output.id,
  fixture: output.fixture,
});
settleTaskLedger(businessTaskId);
db.prepare(
  `INSERT INTO approvals(
  tenant_id,target_type,target_id,title,summary,status,submitter_id,created_at,decided_at
) VALUES(?,?,?,?,?,'已通过',?,datetime('now','localtime'),datetime('now','localtime'))`,
).run(
  TENANT_ID,
  "content",
  output.id,
  "全局员工门禁验收",
  "本地回归验收",
  USER_ID,
);

const staleOutput = insertContent({
  title: "超时恢复全局员工任务",
  status: "待审核",
  createdAt: "2000-01-01 00:00:00",
});
const staleTaskId = insertTask({
  title: "超时恢复全局员工任务",
  status: "生成中",
  outputId: staleOutput.id,
  createdAt: "2000-01-01 00:00:00",
  fixture: staleOutput.fixture,
});
db.prepare(
  `INSERT INTO approvals(
  tenant_id,target_type,target_id,title,summary,status,submitter_id,created_at
) VALUES(?,?,?,?,?,'待审核',?,datetime('now','localtime'))`,
).run(
  TENANT_ID,
  "content",
  staleOutput.id,
  "超时恢复待审阅",
  "等待恢复链路处理",
  USER_ID,
);

function appForBusinessFlow() {
  const app = express();
  app.use((req, _res, next) =>
    runWithTenant(TENANT_ID, () => {
      req.user = user;
      next();
    }),
  );
  app.use("/business-flow", businessFlowRoutes);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  return app;
}

async function withHttpServer(app, fn) {
  const server = app.listen(0, "127.0.0.1");
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("非总部租户任务中心仍能按全局 specialist id 显示员工，且详情保持租户边界", () => {
  runWithTenant(TENANT_ID, () => {
    const list = listUnifiedTasks(user, { kind: "restaurant", pageSize: 100 });
    const row = list.items.find((item) => item.id === listedTaskId);
    assert.ok(row, "tenant task must be visible to its owner");
    assert.equal(
      row.employee,
      employeeName,
      "global employee join must not be keyed by task tenant",
    );

    const detail = getUnifiedTaskDetail(user, "restaurant", listedTaskId);
    assert.equal(
      detail.employee,
      employeeName,
      "restaurant detail must retain global employee name",
    );

    // A task from another tenant must never enter this list or detail endpoint.
    const foreignTaskId = Number(
      db
        .prepare(
          `INSERT INTO agent_tasks(
      tenant_id,marshal_id,specialist_id,title,type,requirement,status,created_by,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          TENANT_ID + 1,
          specialist.marshal_id,
          specialist.id,
          "跨租户不应出现",
          "常规",
          TASK_REQUIREMENT,
          "执行中",
          USER_ID,
          "2026-08-01 09:00:00",
        ).lastInsertRowid,
    );
    assert.equal(
      listUnifiedTasks(user, { kind: "restaurant", pageSize: 100 }).items.some(
        (item) => item.id === foreignTaskId,
      ),
      false,
    );
    assert.throws(
      () => getUnifiedTaskDetail(user, "restaurant", foreignTaskId),
      /不存在|无权/u,
    );
  });
});

test("业务流与交付门禁使用全局员工档案，不把非总部任务误判为契约失败", async () => {
  const app = appForBusinessFlow();
  await withHttpServer(app, async (base) => {
    const response = await fetch(
      `${base}/business-flow/restaurant_task/${businessTaskId}`,
    );
    assert.equal(response.status, 200);
    const flow = await response.json();
    assert.equal(
      flow.status.code,
      "approved",
      "settled, approved output should not fail employee contract",
    );
  });

  runWithTenant(TENANT_ID, () => {
    const state = loadContentDeliveryState(output.id, {
      tenantId: TENANT_ID,
      requireBilling: true,
    });
    assert.equal(
      state.eligible,
      true,
      "delivery gate must recover employee_idx from global catalogue",
    );
    assert.equal(state.code, "DELIVERY_USABLE");
  });
});

test("对账证据能核验全局员工，超时恢复不会因错误租户连接把有效产出标失败", () => {
  const holdId = db
    .prepare(
      `SELECT id FROM credit_holds WHERE tenant_id=? AND ref_type='agent_task' AND ref_id=? ORDER BY id DESC LIMIT 1`,
    )
    .get(TENANT_ID, businessTaskId)?.id;
  assert.ok(holdId);
  // Business-flow/delivery-state above intentionally exercised a settled
  // ledger.  Re-open the same isolated fixture for the read-only reconciliation
  // inspector; no wallet mutation or provider call is made by this test.
  db.prepare(
    `UPDATE credit_holds SET status='held',settled_credits=NULL,settled_at=NULL WHERE id=?`,
  ).run(holdId);
  const inspection = inspectAiReconciliationHold({
    tenantId: TENANT_ID,
    holdId,
  });
  assert.ok(inspection);
  assert.equal(
    inspection.business.deliveryValid,
    true,
    `settled employee task must be reconcilable: ${JSON.stringify(inspection.business)}`,
  );
  assert.equal(
    inspection.availableActions.includes("settle"),
    true,
    `settle should be available: ${JSON.stringify({ availableActions: inspection.availableActions, integrityErrors: inspection.integrityErrors, stillActive: inspection.stillActive, business: inspection.business })}`,
  );

  runWithTenant(TENANT_ID, () => {
    const recovered = recoverStaleAgentTasks(new Date(), 1);
    assert.ok(
      recovered.some((item) => Number(item.taskId) === staleTaskId),
      "stale task must be examined",
    );
    const row = db
      .prepare("SELECT status FROM agent_tasks WHERE tenant_id=? AND id=?")
      .get(TENANT_ID, staleTaskId);
    assert.equal(
      row.status,
      "待审阅",
      "valid stale output should resume to review instead of failing",
    );
  });
});

test("生产 SQL 不得把 global specialists 再按任务 tenant_id 连接；agent_tasks 仍必须先按 tenant_id 过滤", () => {
  const files = [
    "../src/engines/task-center.js",
    "../src/routes/business-flow.js",
    "../src/engines/ai-reconciliation.js",
    "../src/engines/delivery-state.js",
    "../src/engines/scheduler.js",
  ];
  for (const relative of files) {
    const source = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), relative),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /JOIN specialists s ON[^\n]*s\.tenant_id\s*=\s*t\.tenant_id/u,
      `${relative} must join specialists by global id only`,
    );
  }
  const taskCenter = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/engines/task-center.js",
    ),
    "utf8",
  );
  assert.match(
    taskCenter,
    // The production projection now includes adoption evidence joins between
    // FROM and WHERE. Keep this bounded to the same SQL statement without
    // coupling the security assertion to a brittle column-count limit.
    /FROM agent_tasks t[\s\S]{0,700}WHERE t\.tenant_id=\?/u,
    "agent_tasks must retain the tenant predicate",
  );
});

after(async () => {
  await removeTempDbSafely(DB_PATH);
});
