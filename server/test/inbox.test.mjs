import test, { after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { removeTempDbSafely } from "./helpers/temp-db.mjs";

const dbPath = path.join(os.tmpdir(), `nanowork-inbox-${process.pid}.db`);
await removeTempDbSafely(dbPath, { closeDb: false });
process.env.NANOWORK_DB = dbPath;
process.env.NODE_ENV = "test";
process.env.SEED_DEMO = "false";
process.env.JWT_SECRET = "Inbox-Test#2026!9xQ-secret";
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

const { db, initSchema, migrateV2 } = await import("../src/db.js");
const { hashPassword } = await import("../src/util.js");
const { createApp } = await import("../src/app.js");
const { INBOX_KINDS } = await import("../src/routes/inbox.js");
const bus = await import("../src/engines/event-bus.js");

initSchema();
migrateV2();

const password = "Inbox-Test#2026";
const passwordHash = hashPassword(password);
const modules = JSON.stringify(["content", "execution", "marshals", "system", "activities"]);
db.prepare("INSERT INTO tenants(id,name,status,modules,credits) VALUES(?,?,?,?,?)").run(301, "收件箱企业", "已开通", modules, 5000);
db.prepare("INSERT INTO tenants(id,name,status,modules,credits) VALUES(?,?,?,?,?)").run(302, "隔离企业", "已开通", modules, 5000);
const insertUser = db.prepare(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id,modules,manager_id) VALUES(?,?,?,?,?,?,?,?)`,
);
const bossId = Number(insertUser.run("ib_boss", passwordHash, "老板", "boss", "启用", 301, modules, null).lastInsertRowid);
const managerId = Number(insertUser.run("ib_manager", passwordHash, "经理", "manager", "启用", 301, modules, bossId).lastInsertRowid);
const salesId = Number(insertUser.run("ib_sales", passwordHash, "一线员工", "sales", "启用", 301, modules, managerId).lastInsertRowid);
const strangerId = Number(insertUser.run("ib_stranger", passwordHash, "别组员工", "sales", "启用", 301, modules, bossId).lastInsertRowid);
insertUser.run("ib_other_boss", passwordHash, "别家老板", "boss", "启用", 302, modules, null);
const otherSalesId = Number(insertUser.run("ib_other_sales", passwordHash, "别家员工", "sales", "启用", 302, modules, null).lastInsertRowid);

const insertApproval = db.prepare(
  `INSERT INTO approvals(tenant_id,target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,datetime('now','localtime'))`,
);
const lowRiskApprovalId = Number(insertApproval.run(301, "risk", 11, "低风险外发文案", "摘要", "low", "[]", "待审核", salesId).lastInsertRowid);
const activityApprovalId = Number(insertApproval.run(301, "activity_plan", 1, "周年庆活动策划", "预算 3000", "medium", "[]", "待审核", salesId).lastInsertRowid);
insertApproval.run(301, "risk", 12, "已处理的审批不该出现", "摘要", "low", "[]", "已通过", salesId);
const otherTenantApprovalId = Number(insertApproval.run(302, "risk", 13, "别家的审批", "摘要", "low", "[]", "待审核", otherSalesId).lastInsertRowid);
db.prepare(
  `INSERT INTO activities(tenant_id,title,type,status,date,budget,owner_id,plan,plan_status,checklist)
  VALUES(301,'周年庆活动策划','会员日','策划中','2026-10-01',3000,?,'{}','待审批','[]')`,
).run(salesId);

const insertTask = db.prepare(
  `INSERT INTO tasks(tenant_id,title,detail,type,status,priority,assignee_id,assigned_by,created_at)
  VALUES(?,?,?,?,?,?,?,?,datetime('now','localtime'))`,
);
const todoTaskId = Number(insertTask.run(301, "门店巡检整改", "三项整改", "其他", "待执行", "高", salesId, bossId).lastInsertRowid);
insertTask.run(301, "别组同事的任务", "", "其他", "待执行", "中", strangerId, bossId);
insertTask.run(301, "已完成任务不出现", "", "其他", "已完成", "中", salesId, bossId);
insertTask.run(302, "别家企业任务", "", "其他", "待执行", "中", otherSalesId, null);

// 餐饮员工产出：待审阅但没有任何账务记录（待账务对账）——不是"现在能处理"的事项，必须被排除
db.prepare("INSERT INTO marshals(code,name,title) VALUES('INBOX-M','运营元帅','运营')").run();
const marshalId = Number(db.prepare("SELECT id FROM marshals WHERE code='INBOX-M'").get().id);
const blockedContentId = Number(
  db.prepare(
    `INSERT INTO contents(tenant_id,type,title,body,status,creator_id,risk_level,marshal_id,created_at)
    VALUES(301,'报告','待对账的餐饮产出','正文','待审核',?,'low',?,datetime('now','localtime'))`,
  ).run(salesId, marshalId).lastInsertRowid,
);
db.prepare(
  `INSERT INTO agent_tasks(tenant_id,marshal_id,title,requirement,status,output_id,created_by,created_at)
  VALUES(301,?,'待对账的餐饮产出','分析','待审阅',?,?,datetime('now','localtime'))`,
).run(marshalId, blockedContentId, salesId);
// 契约分级批次的"草稿待处理"：可接受草稿 → 老板/管理员有"就用这份草稿"动作；不可接受草稿 → 只能重新派活
const draftContentId = Number(
  db.prepare(
    `INSERT INTO contents(tenant_id,type,title,body,status,creator_id,risk_level,marshal_id,created_at)
    VALUES(301,'报告','未达标草稿（可接受）','正文','草稿',?,'low',?,datetime('now','localtime'))`,
  ).run(salesId, marshalId).lastInsertRowid,
);
const acceptableDraftTaskId = Number(
  db.prepare(
    `INSERT INTO agent_tasks(tenant_id,marshal_id,title,requirement,status,output_id,created_by,contract_report,created_at)
    VALUES(301,?,'未达标草稿（可接受）','分析','草稿待处理',?,?,?,datetime('now','localtime'))`,
  ).run(marshalId, draftContentId, salesId, JSON.stringify({ acceptable: true, errors: ["缺少结论"] })).lastInsertRowid,
);
const rejectedDraftTaskId = Number(
  db.prepare(
    `INSERT INTO agent_tasks(tenant_id,marshal_id,title,requirement,status,output_id,created_by,contract_report,created_at)
    VALUES(301,?,'未达标草稿（来源硬错）','分析','草稿待处理',?,?,?,datetime('now','localtime'))`,
  ).run(marshalId, draftContentId, salesId, JSON.stringify({ acceptable: false, errors: ["补造来源"] })).lastInsertRowid,
);

const app = createApp({
  serveStatic: false,
  aiGuardOptions: { ratePerMinute: 50, burst: 50, maxConcurrent: 4 },
  autoRecoverAvatar: false,
  autoRecoverTextVideo: false,
  autoRecoverWechatDraft: false,
});
const server = app.listen(0, "127.0.0.1");
const port = await new Promise((resolve) => server.once("listening", () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  bus.resetEventBusForTests();
  await removeTempDbSafely(dbPath);
});

async function login(username) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload.token;
}

async function call(token, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function runAction(token, action, extra = {}) {
  return call(token, action.method, action.path, { ...(action.body || {}), ...extra });
}

const tokens = {};
test.before(async () => {
  for (const name of ["ib_boss", "ib_manager", "ib_sales", "ib_stranger", "ib_other_boss", "ib_other_sales"]) {
    tokens[name] = await login(name);
  }
});

test("老板收件箱聚合审批中心与活动策划待决，统一结构且 actions 指向真实决策端点", async () => {
  const { status, body } = await call(tokens.ib_boss, "GET", "/api/inbox");
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(Object.keys(body.counts).sort(), [...INBOX_KINDS].sort());
  assert.equal(body.kinds.length, INBOX_KINDS.length);

  const approval = body.items.find((entry) => entry.kind === "approval");
  assert.ok(approval, "老板必须看到低风险通用审批");
  assert.equal(approval.id, lowRiskApprovalId);
  assert.equal(approval.key, `approval:${lowRiskApprovalId}`);
  assert.equal(approval.priority, "low");
  assert.match(approval.subtitle, /提交人：一线员工/u);
  for (const field of ["kind", "id", "title", "subtitle", "createdAt", "dueAt", "priority", "actions", "link"]) {
    assert.ok(Object.hasOwn(approval, field), `缺少字段 ${field}`);
  }
  const approve = approval.actions.find((action) => action.key === "approve");
  const reject = approval.actions.find((action) => action.key === "reject");
  assert.deepEqual(
    { method: approve.method, path: approve.path, body: approve.body },
    { method: "POST", path: `/api/sys/approvals/${lowRiskApprovalId}/decide`, body: { pass: true } },
  );
  assert.equal(reject.requiresReason, true);
  assert.equal(reject.danger, true);
  assert.equal(approval.link, "/system?tab=approvals");

  const activity = body.items.find((entry) => entry.kind === "activity_approval");
  assert.ok(activity, "活动策划审批单归入 activity_approval 分组");
  assert.equal(activity.id, activityApprovalId);
  assert.equal(activity.priority, "medium");
  assert.equal(activity.link, "/activities");

  assert.equal(body.items.some((entry) => entry.title === "已处理的审批不该出现"), false);
  assert.equal(body.items.some((entry) => entry.title === "别家的审批"), false, "租户隔离");
  assert.equal(body.items.some((entry) => entry.kind === "manual_todo"), false, "老板不是任务负责人，不出现待接单");
  // 无任何预授权记录的待审阅产出：交付门禁判定"不能采纳、只能驳回清理"，
  // 收件箱必须原样呈现该判定（只给驳回动作），不得自造一个"采纳"按钮。
  const blocked = body.items.find((entry) => entry.kind === "employee_output" && entry.outputId === blockedContentId);
  assert.ok(blocked, "餐饮产出待处理进入收件箱");
  assert.deepEqual(blocked.actions.map((action) => action.key), ["reject"]);
  assert.equal(blocked.actions[0].path, `/api/marshals/outputs/${blockedContentId}/review`);
  assert.deepEqual(blocked.actions[0].body, { decision: "reject" });
  assert.match(blocked.subtitle, /暂不能采纳/u);

  // 草稿待处理：与契约分级批次兼容，动作直指 accept-draft，且不进入低风险批量采纳
  const acceptableDraft = body.items.find((entry) => entry.key === `employee_output:${acceptableDraftTaskId}`);
  assert.ok(acceptableDraft, "可接受草稿进入收件箱");
  assert.equal(acceptableDraft.kind, "employee_output");
  assert.equal(acceptableDraft.priority, "medium");
  assert.deepEqual(acceptableDraft.actions, [
    {
      key: "accept_draft",
      label: "就用这份草稿",
      method: "POST",
      path: `/api/marshals/tasks/${acceptableDraftTaskId}/accept-draft`,
      body: {},
    },
  ]);
  const rejectedDraft = body.items.find((entry) => entry.key === `employee_output:${rejectedDraftTaskId}`);
  assert.ok(rejectedDraft, "含来源硬错的草稿仍列出以便重新派活");
  assert.deepEqual(rejectedDraft.actions, []);
  assert.match(rejectedDraft.subtitle, /重新派活/u);

  assert.equal(body.counts.approval, 1);
  assert.equal(body.counts.activity_approval, 1);
  assert.equal(body.counts.employee_output, 3);
  assert.equal(body.lowRiskAdoptable, 1, "只有带 approve/adopt 动作的低风险项可批量采纳；仅能驳回或草稿接受的不计入");
  // 高优先级排前：medium 的活动审批在 low 的通用审批之前
  assert.ok(body.items.indexOf(activity) < body.items.indexOf(approval));
});

test("一线员工只看到分派给自己的任务；经理看不到无权处理的通用审批；count 与列表一致", async () => {
  const sales = await call(tokens.ib_sales, "GET", "/api/inbox");
  assert.equal(sales.status, 200);
  assert.deepEqual(
    sales.body.items.map((entry) => [entry.kind, entry.id]),
    [["manual_todo", todoTaskId]],
  );
  const todo = sales.body.items[0];
  assert.equal(todo.priority, "high");
  assert.deepEqual(todo.actions.map((action) => action.key), ["start"]);
  assert.deepEqual(todo.actions[0], {
    key: "start",
    label: "接单开始",
    method: "PUT",
    path: `/api/execution/tasks/${todoTaskId}`,
    body: { status: "进行中" },
  });
  assert.equal(todo.link, `/tasks?kind=manual&id=${todoTaskId}`);
  const salesCount = await call(tokens.ib_sales, "GET", "/api/inbox/count");
  assert.equal(salesCount.body.total, 1);
  assert.equal(salesCount.body.counts.manual_todo, 1);

  const stranger = await call(tokens.ib_stranger, "GET", "/api/inbox");
  assert.deepEqual(stranger.body.items.map((entry) => entry.title), ["别组同事的任务"]);

  const manager = await call(tokens.ib_manager, "GET", "/api/inbox");
  assert.equal(manager.status, 200);
  assert.equal(manager.body.items.some((entry) => entry.kind === "approval"), false, "直属经理不能处理通用审批，不应出现");
  assert.equal(manager.body.counts.manual_review, 0);

  const filtered = await call(tokens.ib_boss, "GET", "/api/inbox?kind=activity_approval&limit=1");
  assert.equal(filtered.body.items.length, 1);
  assert.equal(filtered.body.items[0].kind, "activity_approval");
  assert.equal(filtered.body.total, 5, "total 仍是全部可处理事项数");
  assert.equal(filtered.body.matched, 1);
  const invalid = await call(tokens.ib_boss, "GET", "/api/inbox?kind=nope");
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "INVALID_INBOX_KIND");
});

test("执行 actions 走真实端点：接单→提交→经理验收→审批通过，每一步后事项从收件箱消失并发出 inbox.changed", async () => {
  const received = [];
  const unsubscribe = bus.subscribe((event) => received.push(event));

  const before = await call(tokens.ib_sales, "GET", "/api/inbox");
  const start = before.body.items[0].actions[0];
  const started = await runAction(tokens.ib_sales, start);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const afterStart = await call(tokens.ib_sales, "GET", "/api/inbox");
  assert.equal(afterStart.body.items.length, 0, "接单后待接单事项消失");

  const submitted = await call(tokens.ib_sales, "POST", `/api/execution/tasks/${todoTaskId}/submit`, {
    content: "三项整改已完成，附现场照片说明",
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

  const managerInbox = await call(tokens.ib_manager, "GET", "/api/inbox");
  const review = managerInbox.body.items.find((entry) => entry.kind === "manual_review");
  assert.ok(review, "员工提交后直属经理收到待验收");
  assert.equal(review.id, todoTaskId);
  assert.match(review.subtitle, /一线员工 已提交/u);
  const approve = review.actions.find((action) => action.key === "approve");
  assert.equal(approve.path, `/api/execution/tasks/${todoTaskId}/review`);
  assert.deepEqual(approve.body, { pass: true });
  const rejectAction = review.actions.find((action) => action.key === "reject");
  assert.equal(rejectAction.requiresReason, true);

  const salesDuringReview = await call(tokens.ib_sales, "GET", "/api/inbox/count");
  assert.equal(salesDuringReview.body.total, 0, "待验收期间员工无可处理事项");
  const strangerCount = await call(tokens.ib_stranger, "GET", "/api/inbox/count");
  assert.equal(strangerCount.body.counts.manual_review, 0, "一线员工不是验收人");

  const reviewed = await runAction(tokens.ib_manager, approve);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  const managerAfter = await call(tokens.ib_manager, "GET", "/api/inbox");
  assert.equal(managerAfter.body.items.some((entry) => entry.kind === "manual_review"), false);

  const bossBefore = await call(tokens.ib_boss, "GET", "/api/inbox");
  const approval = bossBefore.body.items.find((entry) => entry.kind === "approval");
  const decided = await runAction(tokens.ib_boss, approval.actions.find((action) => action.key === "approve"));
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  const bossAfter = await call(tokens.ib_boss, "GET", "/api/inbox");
  assert.equal(bossAfter.body.items.some((entry) => entry.kind === "approval"), false, "已通过审批从收件箱消失");
  assert.equal(bossAfter.body.counts.approval, 0);
  assert.equal(bossAfter.body.total, bossBefore.body.total - 1);
  assert.equal(
    db.prepare("SELECT status FROM approvals WHERE id=?").get(lowRiskApprovalId).status,
    "已通过",
    "收件箱动作确实经由权威端点改变了状态",
  );

  await new Promise((resolve) => setTimeout(resolve, 260));
  unsubscribe();
  const types = new Set(received.filter((event) => event.tenantId === 301).map((event) => event.type));
  assert.ok(types.has("task.status_changed"), "人工任务翻转推送");
  assert.ok(types.has("approval.decided"), "审批决定推送");
  assert.ok(types.has("inbox.changed"), "任何来源变化都发出 inbox.changed");
  const decidedEvent = received.find((event) => event.type === "approval.decided");
  assert.equal(decidedEvent.payload.approvalId, lowRiskApprovalId);
  assert.equal(decidedEvent.payload.status, "已通过");
});

test("租户隔离：别家老板只看到自己企业的事项，别家员工看不到任何东西", async () => {
  const otherBoss = await call(tokens.ib_other_boss, "GET", "/api/inbox");
  assert.deepEqual(
    otherBoss.body.items.map((entry) => [entry.kind, entry.id]),
    [["approval", otherTenantApprovalId]],
  );
  assert.equal(otherBoss.body.total, 1);
  const otherSales = await call(tokens.ib_other_sales, "GET", "/api/inbox");
  assert.deepEqual(otherSales.body.items.map((entry) => entry.title), ["别家企业任务"]);
  assert.equal(otherSales.body.items.some((entry) => entry.title === "门店巡检整改"), false);
  const anonymous = await fetch(`${base}/api/inbox/count`);
  assert.equal(anonymous.status, 401);
  await anonymous.body?.cancel();
});
