import test, { after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { removeTempDbSafely } from "./helpers/temp-db.mjs";

const dbPath = path.join(os.tmpdir(), `nanowork-event-bus-${process.pid}.db`);
await removeTempDbSafely(dbPath, { closeDb: false });
process.env.NANOWORK_DB = dbPath;
process.env.NODE_ENV = "test";
process.env.SEED_DEMO = "false";

const { initSchema, migrateV2, q, runWithTenant } = await import("../src/db.js");
const bus = await import("../src/engines/event-bus.js");
const { notify } = await import("../src/util.js");
initSchema();
migrateV2();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const boss = { id: 1, role: "boss", tenant_id: 1 };
const manager = { id: 2, role: "manager", tenant_id: 1 };
const sales = { id: 3, role: "sales", tenant_id: 1 };
const otherTenantBoss = { id: 9, role: "boss", tenant_id: 2 };

after(async () => {
  bus.resetEventBusForTests();
  await removeTempDbSafely(dbPath);
});

test("publish 校验类型与租户，返回单调递增 id 并进入环形缓冲", () => {
  bus.resetEventBusForTests();
  assert.throws(() => bus.publish({ tenantId: 1, type: "nope" }), /未知事件类型/u);
  assert.throws(() => bus.publish({ tenantId: 0, type: "inbox.changed" }), /有效租户/u);
  const first = bus.publish({ tenantId: 1, type: "inbox.changed", all: true });
  const second = bus.publish({
    tenantId: 1,
    type: "task.status_changed",
    userIds: [3, "3", 0, -1, "x"],
    roles: ["manager", "", null],
    payload: { kind: "manual", id: 7, status: "已完成" },
  });
  assert.equal(Number(second.id), Number(first.id) + 1);
  assert.deepEqual([...second.audience.userIds], [3]);
  assert.deepEqual([...second.audience.roles], ["manager"]);
  assert.equal(second.audience.all, false);
  assert.deepEqual(bus.EVENT_TYPES.slice().sort(), [
    "approval.created",
    "approval.decided",
    "credits.updated",
    "inbox.changed",
    "notification.created",
    "task.status_changed",
  ]);
});

test("可见性：boss/admin 收全租户，其他人只收 userIds/roles/all 命中的事件，跨租户不可见", () => {
  bus.resetEventBusForTests();
  const targeted = bus.publish({
    tenantId: 1,
    type: "task.status_changed",
    userIds: [3],
    payload: { kind: "manual", id: 1, status: "待执行" },
  });
  const roleScoped = bus.publish({
    tenantId: 1,
    type: "approval.created",
    roles: ["manager"],
    payload: { approvalId: 1 },
  });
  const everyone = bus.publish({ tenantId: 1, type: "inbox.changed", all: true });
  const privateOne = bus.publish({ tenantId: 1, type: "notification.created", userIds: [1] });

  assert.equal(bus.visibleTo(targeted, boss), true);
  assert.equal(bus.visibleTo(targeted, sales), true);
  assert.equal(bus.visibleTo(targeted, manager), false);
  assert.equal(bus.visibleTo(roleScoped, manager), true);
  assert.equal(bus.visibleTo(roleScoped, sales), false);
  assert.equal(bus.visibleTo(everyone, sales), true);
  assert.equal(bus.visibleTo(privateOne, sales), false);
  assert.equal(bus.visibleTo(privateOne, { id: 1, role: "sales", tenant_id: 1 }), true);
  assert.equal(bus.visibleTo(targeted, otherTenantBoss), false);
  assert.equal(bus.visibleTo(everyone, otherTenantBoss), false);
});

test("Last-Event-ID 补发：按租户只返回更大 id 的事件，缓冲上限 200 条", () => {
  bus.resetEventBusForTests();
  const ids = [];
  for (let index = 0; index < 205; index += 1) {
    ids.push(Number(bus.publish({ tenantId: 1, type: "inbox.changed", all: true, payload: { index } }).id));
  }
  bus.publish({ tenantId: 2, type: "inbox.changed", all: true });
  const replay = bus.replaySince(1, ids[ids.length - 3]);
  assert.deepEqual(replay.map((event) => Number(event.id)), ids.slice(-2));
  assert.equal(bus.replaySince(1, 0).length, bus.RING_BUFFER_LIMIT);
  assert.equal(bus.replaySince(1, 0)[0].payload.index, 5);
  assert.equal(bus.replaySince(2, 0).length, 1);
  assert.deepEqual(bus.replaySince(1, "abc"), []);
  assert.deepEqual(bus.replaySince(1, ids[ids.length - 1]), []);
});

test("subscribe 收到事件；监听器抛错不影响发布方", () => {
  bus.resetEventBusForTests();
  const received = [];
  const unsubscribe = bus.subscribe((event) => received.push(event.type));
  bus.subscribe(() => {
    throw new Error("listener boom");
  });
  const event = bus.publish({ tenantId: 1, type: "credits.updated", all: true, payload: { balance: 10 } });
  assert.ok(event.id);
  assert.deepEqual(received, ["credits.updated"]);
  unsubscribe();
  bus.publish({ tenantId: 1, type: "credits.updated", all: true });
  assert.equal(received.length, 1);
});

test("notify 落库即发布 notification.created，只对收件人可见", () => {
  bus.resetEventBusForTests();
  const received = [];
  bus.subscribe((event) => received.push(event));
  runWithTenant(1, () => notify(3, "task", "新任务派发", "请接单", "/tasks"));
  const event = received.find((entry) => entry.type === "notification.created");
  assert.ok(event, "notify 必须触发 notification.created");
  assert.equal(event.tenantId, 1);
  assert.deepEqual([...event.audience.userIds], [3]);
  assert.equal(event.payload.title, "新任务派发");
  assert.equal(event.payload.link, "/tasks");
  assert.equal(bus.visibleTo(event, sales), true);
  assert.equal(bus.visibleTo(event, manager), false);
  const stored = q.get("SELECT id FROM notifications WHERE user_id=3 ORDER BY id DESC LIMIT 1");
  assert.equal(event.payload.id, Number(stored.id));
});

test("隔离表写入经 q.run 观察后按租户去抖发出 inbox.changed；审批插入派生 approval.created", async () => {
  bus.resetEventBusForTests();
  const received = [];
  bus.subscribe((event) => received.push(event));
  runWithTenant(1, () => {
    q.run(
      `INSERT INTO approvals(target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,assigned_reviewer_id)
      VALUES('activity_plan',1,'活动策划待审','摘要','medium','[]','待审核',3,2)`,
    );
    q.run(
      `INSERT INTO tasks(title,detail,status,assignee_id,assigned_by) VALUES('待接单任务','','待执行',3,1)`,
    );
  });
  const created = received.find((event) => event.type === "approval.created");
  assert.ok(created, "INSERT INTO approvals 必须派生 approval.created");
  assert.equal(created.payload.title, "活动策划待审");
  assert.equal(created.payload.targetType, "activity_plan");
  assert.ok(created.audience.roles.includes("manager"));
  assert.ok(created.audience.userIds.includes(2));
  assert.equal(bus.visibleTo(created, sales), true, "提交人可见自己的审批已创建");
  assert.equal(received.filter((event) => event.type === "inbox.changed").length, 0, "去抖前不应立即发出");
  await sleep(260);
  const inboxChanged = received.filter((event) => event.type === "inbox.changed");
  assert.equal(inboxChanged.length, 1, "两次写入在去抖窗口内只合并为一条 inbox.changed");
  assert.equal(inboxChanged[0].tenantId, 1);
  assert.equal(inboxChanged[0].audience.all, true);

  // 非隔离表/无关表写入不产生刷新信号
  received.length = 0;
  runWithTenant(1, () => q.run("INSERT INTO op_logs(user_id,username,module,action,target,ip) VALUES(1,'x','m','a','t','ip')"));
  await sleep(220);
  assert.equal(received.filter((event) => event.type === "inbox.changed").length, 0);
});
