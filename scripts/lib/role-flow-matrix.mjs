import assert from "node:assert/strict";

export const ROLE_FLOW_MATRIX = Object.freeze([
  Object.freeze({
    id: "restaurant_employee",
    label: "餐饮数字员工",
    positiveActors: ["sales", "manager", "ops_director", "boss"],
    forbiddenActors: [],
    actionPermissions: Object.freeze({
      dispatch: Object.freeze({
        allowedActors: ["sales", "manager", "ops_director", "boss"],
        requiredModule: "marshals",
      }),
      review: Object.freeze({
        allowedActors: ["manager", "ops_director", "boss"],
        forbiddenActors: ["sales"],
        policy: "locked_dispatch_approval_mode",
      }),
    }),
    terminalEvidence: [
      "agent_tasks",
      "contents",
      "approvals",
      "kb_docs",
      "biz_assets",
      "credit_holds",
    ],
  }),
  Object.freeze({
    id: "content_employee",
    label: "Paihuo 内容员工",
    positiveActors: ["sales", "manager", "ops_director", "boss"],
    forbiddenActors: [],
    actionPermissions: Object.freeze({
      dispatch: Object.freeze({
        allowedActors: ["sales", "manager", "ops_director", "boss"],
        requiredModule: "content",
      }),
      review: Object.freeze({
        allowedActors: ["boss", "ops_director", "manager"],
        forbiddenActors: ["sales"],
        policy: "locked_dispatch_approval_mode",
      }),
    }),
    terminalEvidence: [
      "content_employee_runs",
      "materials",
      "contents",
      "approvals",
      "biz_assets",
      "credit_holds",
    ],
  }),
  Object.freeze({
    id: "activities",
    label: "活动中心",
    positiveActors: ["manager", "ops_director", "boss"],
    forbiddenActors: ["sales"],
    terminalEvidence: [
      "activities",
      "tasks",
      "approvals",
      "kb_docs",
      "credit_holds",
    ],
  }),
  Object.freeze({
    id: "toolbox",
    label: "经营工具箱",
    positiveActors: ["sales"],
    forbiddenActors: ["sales_without_content_module"],
    terminalEvidence: ["tool_runs", "tool_run_events", "credit_holds"],
  }),
  Object.freeze({
    id: "advisor",
    label: "老板参谋",
    positiveActors: ["manager", "ops_director", "boss"],
    forbiddenActors: ["actor_without_advisor_module"],
    terminalEvidence: [
      "ai_conversations",
      "ai_messages",
      "tasks",
      "credit_holds",
    ],
  }),
]);

export const REJECTION_EFFECT_TABLES = Object.freeze([
  "credit_holds",
  "credit_logs",
  "agent_tasks",
  "content_employee_runs",
  "tool_runs",
  "tool_run_events",
  "ai_conversations",
  "ai_messages",
  "contents",
  "approvals",
  "materials",
  "biz_assets",
  "kb_docs",
  "tasks",
  "activities",
  "notifications",
  "op_logs",
]);

function tableExists(db, table) {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table),
  );
}

function hasTenantColumn(db, table) {
  return db
    .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
    .all()
    .some((column) => column.name === "tenant_id");
}

export function businessEffectSnapshot(
  db,
  tenantId,
  tables = REJECTION_EFFECT_TABLES,
) {
  const output = {};
  for (const table of tables) {
    if (!tableExists(db, table)) {
      output[table] = { exists: false, rows: [] };
      continue;
    }
    const scoped = hasTenantColumn(db, table);
    output[table] = {
      exists: true,
      rows: db
        .prepare(
          `SELECT * FROM ${table}${scoped ? " WHERE tenant_id=?" : ""} ORDER BY rowid`,
        )
        .all(...(scoped ? [tenantId] : [])),
    };
  }
  output.tenant = tableExists(db, "tenants")
    ? db.prepare("SELECT * FROM tenants WHERE id=?").get(tenantId) || null
    : null;
  return output;
}

export function assertForbiddenNoSideEffects({
  label,
  responseStatus,
  before,
  after,
  allowedStatuses = [403],
}) {
  assert.ok(
    allowedStatuses.includes(responseStatus),
    `${label}: expected ${allowedStatuses.join("/")} but got ${responseStatus}`,
  );
  assert.deepEqual(
    after,
    before,
    `${label}: rejected request changed business state`,
  );
}

export function assertNoHeldCredits(db, tenantId, label = "business flow") {
  const held = Number(
    db
      .prepare(
        "SELECT COUNT(*) count FROM credit_holds WHERE tenant_id=? AND status='held'",
      )
      .get(tenantId).count || 0,
  );
  assert.equal(held, 0, `${label}: dangling credit hold detected`);
}

export function readbackSettledHold(db, tenantId, refType, refId) {
  return (
    db
      .prepare(
        `SELECT id,status,held_credits,settled_credits,ref_type,ref_id,model
    FROM credit_holds
    WHERE tenant_id=? AND ref_type=? AND ref_id=?
    ORDER BY id DESC LIMIT 1`,
      )
      .get(tenantId, refType, refId) || null
  );
}

export function assertSettledBillingReadback(
  db,
  tenantId,
  refType,
  refId,
  label,
) {
  const hold = readbackSettledHold(db, tenantId, refType, refId);
  assert.ok(hold, `${label}: linked hold not found`);
  assert.equal(hold.status, "settled", `${label}: hold is not settled`);
  assert.ok(
    Number(hold.settled_credits) > 0,
    `${label}: charged credits must be positive`,
  );
  return hold;
}

export function matrixSummary(results) {
  const passed = results.filter((item) => item.ok).length;
  return {
    scenarios: results.length,
    passed,
    failed: results.length - passed,
    modules: [...new Set(results.map((item) => item.module))],
    externalNetworkAttempts: results.reduce(
      (total, item) => total + Number(item.externalNetworkAttempts || 0),
      0,
    ),
    results,
  };
}
