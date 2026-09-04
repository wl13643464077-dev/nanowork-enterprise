// ===== 进程内事件总线（SSE 推送 + 收件箱实时投影）=====
//
// 已知限制（见建议清单 D6）：总线是单进程 EventEmitter + 内存环形缓冲，多实例
// 部署（PM2 cluster / 多容器）之间不共享事件：连到 A 实例的浏览器收不到 B 实例
// 写入的状态翻转。当前部署为单实例 + Caddy 反代，属可接受；扩到多实例前需要
// 把 publish() 换成 Redis Pub/Sub 或 SQLite 轮询投递，前端已有轮询兜底可保底。
//
// 设计原则：
// - 事件只是"刷新信号 + 最小上下文"，不承载业务真相；前端收到后仍从权威端点拉取。
// - publish 只允许在权威状态翻转点追加一行调用，绝不改状态机（D-037）。
// - 可见性在服务端过滤：boss/admin/platform_super 收全租户；其他人只收
//   userIds 含自己、roles 含自己角色或 all=true 的事件。
// - 支持 Last-Event-ID 重连补发：每租户保留最近 200 条。
import { EventEmitter } from "node:events";
import { onWrite, curTenant, q } from "../db.js";

export const EVENT_TYPES = Object.freeze([
  "task.status_changed",
  "approval.created",
  "approval.decided",
  "notification.created",
  "credits.updated",
  "inbox.changed",
]);
const EVENT_TYPE_SET = new Set(EVENT_TYPES);
const FULL_VISIBILITY_ROLES = new Set(["boss", "admin", "platform_super"]);
export const RING_BUFFER_LIMIT = 200;
const INBOX_DEBOUNCE_MS = 150;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let sequence = 0;
const ringByTenant = new Map(); // tenantId -> event[]

function normalizeIds(list) {
  if (!Array.isArray(list)) return [];
  return [
    ...new Set(
      list
        .map((value) => Number(value))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ];
}

function normalizeRoles(list) {
  if (!Array.isArray(list)) return [];
  return [
    ...new Set(list.map((value) => String(value || "").trim()).filter(Boolean)),
  ];
}

function remember(event) {
  const ring = ringByTenant.get(event.tenantId) || [];
  ring.push(event);
  if (ring.length > RING_BUFFER_LIMIT) ring.splice(0, ring.length - RING_BUFFER_LIMIT);
  ringByTenant.set(event.tenantId, ring);
}

/**
 * 发布一条事件。返回已入环形缓冲的事件对象（含单调递增 id）。
 * 未知类型直接抛错：事件类型是前后端契约，不允许拼错后静默丢失。
 */
export function publish({
  tenantId = curTenant(),
  userIds = [],
  roles = [],
  all = false,
  type,
  payload = {},
} = {}) {
  if (!EVENT_TYPE_SET.has(type)) {
    throw new Error(`未知事件类型：${String(type)}（允许：${EVENT_TYPES.join(", ")}）`);
  }
  const tid = Number(tenantId);
  if (!Number.isSafeInteger(tid) || tid <= 0) {
    throw new Error(`事件缺少有效租户：${String(tenantId)}`);
  }
  sequence += 1;
  const event = Object.freeze({
    id: String(sequence),
    ts: new Date().toISOString(),
    tenantId: tid,
    type,
    audience: Object.freeze({
      userIds: Object.freeze(normalizeIds(userIds)),
      roles: Object.freeze(normalizeRoles(roles)),
      all: all === true,
    }),
    payload: payload && typeof payload === "object" ? { ...payload } : {},
  });
  remember(event);
  // 监听器异常不得反噬业务写入路径
  try {
    emitter.emit("event", event);
  } catch (error) {
    console.error("[event-bus] 监听器异常:", error?.message || error);
  }
  return event;
}

export function subscribe(listener) {
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}

/** 事件对某用户是否可见（租户 + 角色/用户白名单）。 */
export function visibleTo(event, user) {
  if (!event || !user) return false;
  if (Number(event.tenantId) !== Number(user.tenant_id || 1)) return false;
  if (FULL_VISIBILITY_ROLES.has(String(user.role || ""))) return true;
  if (event.audience.all) return true;
  if (event.audience.userIds.includes(Number(user.id))) return true;
  return event.audience.roles.includes(String(user.role || ""));
}

/** 重连补发：返回该租户 id 大于 lastEventId 的缓冲事件（按序）。 */
export function replaySince(tenantId, lastEventId) {
  const since = Number(lastEventId);
  if (!Number.isSafeInteger(since) || since < 0) return [];
  const ring = ringByTenant.get(Number(tenantId)) || [];
  return ring.filter((event) => Number(event.id) > since);
}

export function currentSequence() {
  return sequence;
}

// ===== SSE 连接登记（供 /api/sys/status 观测）=====
const connectionsByUser = new Map(); // userId -> Set<handle>
let connectionTotal = 0;

export function registerSseConnection(userId, handle, { maxPerUser = 3 } = {}) {
  const uid = Number(userId);
  const set = connectionsByUser.get(uid) || new Set();
  const evicted = [];
  while (set.size >= Math.max(1, maxPerUser)) {
    const oldest = set.values().next().value;
    set.delete(oldest);
    connectionTotal -= 1;
    evicted.push(oldest);
  }
  set.add(handle);
  connectionsByUser.set(uid, set);
  connectionTotal += 1;
  return evicted;
}

export function unregisterSseConnection(userId, handle) {
  const uid = Number(userId);
  const set = connectionsByUser.get(uid);
  if (!set || !set.has(handle)) return false;
  set.delete(handle);
  connectionTotal -= 1;
  if (!set.size) connectionsByUser.delete(uid);
  return true;
}

export function sseConnectionStats() {
  return { connections: connectionTotal, users: connectionsByUser.size };
}

// ===== 收件箱变更信号：从 q.run 写入观察派生 =====
// 审批/任务/产出的写入点散落在 8+ 个文件且有并行工程师在改（新增"草稿待处理"等状态）。
// 与其到处追加 publish，不如在唯一写入口 q.run 观察隔离表写入，按租户去抖后发一条
// inbox.changed（无业务负载，前端只据此重拉 /api/inbox/count）。显式 publish 仍在
// 权威翻转点提供带上下文的 task.status_changed / approval.decided。
const INBOX_TABLES = new Set([
  "approvals",
  "agent_tasks",
  "content_employee_runs",
  "tasks",
  "task_submissions",
  "activities",
]);
const sqlTableCache = new Map(); // sql -> { table, op } | null
const inboxTimers = new Map(); // tenantId -> timer

function writeTarget(sql) {
  if (sqlTableCache.has(sql)) return sqlTableCache.get(sql);
  const match = /^\s*(INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/i.exec(sql);
  const target = match
    ? { op: match[1].toUpperCase().startsWith("INSERT") ? "insert" : match[1].toUpperCase().startsWith("UPDATE") ? "update" : "delete", table: match[2].toLowerCase() }
    : null;
  if (sqlTableCache.size > 2000) sqlTableCache.clear();
  sqlTableCache.set(sql, target);
  return target;
}

export function scheduleInboxChanged(tenantId, { source = "db_write" } = {}) {
  const tid = Number(tenantId) || 1;
  if (inboxTimers.has(tid)) return;
  const timer = setTimeout(() => {
    inboxTimers.delete(tid);
    try {
      publish({ tenantId: tid, all: true, type: "inbox.changed", payload: { source } });
    } catch (error) {
      console.error("[event-bus] inbox.changed 发布失败:", error?.message || error);
    }
  }, INBOX_DEBOUNCE_MS);
  timer.unref?.();
  inboxTimers.set(tid, timer);
}

function approvalCreatedFromInsert(result, tenantId) {
  const id = Number(result?.lastInsertRowid);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  // 写入可能仍在事务中；查询同一连接可见。回滚的极端情况只会多发一条无害刷新信号。
  const row = q.get(
    `SELECT id,title,target_type,target_id,risk_level,status,approval_level,assigned_reviewer_id,submitter_id
    FROM approvals WHERE tenant_id=? AND id=?`,
    tenantId,
    id,
  );
  if (!row || row.status !== "待审核") return;
  publish({
    tenantId,
    roles: ["boss", "ops_director", "manager", "admin"],
    userIds: [row.assigned_reviewer_id, row.submitter_id].filter(Boolean),
    type: "approval.created",
    payload: {
      approvalId: row.id,
      title: row.title,
      targetType: row.target_type,
      targetId: row.target_id,
      riskLevel: row.risk_level,
      approvalLevel: row.approval_level,
    },
  });
}

onWrite((sql, result, tenantId) => {
  const target = writeTarget(sql);
  if (!target || !INBOX_TABLES.has(target.table)) return;
  if (target.table === "approvals" && target.op === "insert") {
    try {
      approvalCreatedFromInsert(result, tenantId);
    } catch (error) {
      console.error("[event-bus] approval.created 派生失败:", error?.message || error);
    }
  }
  scheduleInboxChanged(tenantId);
});

/** 测试专用：清空缓冲、序号与连接登记。 */
export function resetEventBusForTests() {
  sequence = 0;
  ringByTenant.clear();
  connectionsByUser.clear();
  connectionTotal = 0;
  for (const timer of inboxTimers.values()) clearTimeout(timer);
  inboxTimers.clear();
  emitter.removeAllListeners("event");
}
