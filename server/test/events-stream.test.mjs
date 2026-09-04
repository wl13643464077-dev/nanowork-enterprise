import test, { after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { removeTempDbSafely } from "./helpers/temp-db.mjs";

const dbPath = path.join(os.tmpdir(), `nanowork-events-stream-${process.pid}.db`);
await removeTempDbSafely(dbPath, { closeDb: false });
process.env.NANOWORK_DB = dbPath;
process.env.NODE_ENV = "test";
process.env.SEED_DEMO = "false";
process.env.JWT_SECRET = "Events-Stream-Test#2026!9xQ";
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.SSE_PING_INTERVAL_MS = "150";

const { db, initSchema, migrateV2 } = await import("../src/db.js");
const { hashPassword } = await import("../src/util.js");
const { createApp } = await import("../src/app.js");
const { createAiGuard, createAiConcurrencyPool } = await import("../src/ai-limits.js");
const bus = await import("../src/engines/event-bus.js");
const { SSE_PING_INTERVAL_MS, SSE_MAX_CONNECTIONS_PER_USER } = await import("../src/routes/events.js");

initSchema();
migrateV2();

const password = "Events-Test#2026";
const passwordHash = hashPassword(password);
db.prepare("INSERT INTO tenants(id,name,status,modules,credits) VALUES(?,?,?,?,?)").run(
  201, "事件流企业", "已开通", JSON.stringify(["content", "execution", "marshals"]), 5000,
);
db.prepare("INSERT INTO tenants(id,name,status,modules,credits) VALUES(?,?,?,?,?)").run(
  202, "隔离企业", "已开通", JSON.stringify(["content", "execution"]), 5000,
);
const insertUser = db.prepare(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id,modules,manager_id) VALUES(?,?,?,?,?,?,?,?)`,
);
const bossId = Number(insertUser.run("ev_boss", passwordHash, "老板", "boss", "启用", 201, JSON.stringify(["content", "execution", "marshals"]), null).lastInsertRowid);
const managerId = Number(insertUser.run("ev_manager", passwordHash, "经理", "manager", "启用", 201, JSON.stringify(["content", "execution"]), bossId).lastInsertRowid);
const salesId = Number(insertUser.run("ev_sales", passwordHash, "员工", "sales", "启用", 201, JSON.stringify(["execution"]), managerId).lastInsertRowid);
insertUser.run("ev_other", passwordHash, "别家老板", "boss", "启用", 202, JSON.stringify(["content", "execution"]), null);

const aiPool = createAiConcurrencyPool(2);
const app = createApp({
  serveStatic: false,
  aiGuardFor: createAiGuard({ ratePerMinute: 50, burst: 50, concurrencyPool: aiPool }),
  autoRecoverAvatar: false,
  autoRecoverTextVideo: false,
  autoRecoverWechatDraft: false,
});
const server = app.listen(0, "127.0.0.1");
const port = await new Promise((resolve) => server.once("listening", () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

const openStreams = new Set();
after(async () => {
  for (const stream of openStreams) stream.close();
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

function parseFrames(buffer) {
  const frames = [];
  let rest = buffer;
  let idx;
  while ((idx = rest.indexOf("\n\n")) >= 0) {
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const frame = { comments: [], fields: {} };
    for (const line of block.split("\n")) {
      if (!line) continue;
      if (line.startsWith(":")) {
        frame.comments.push(line.slice(1).trim());
        continue;
      }
      const sep = line.indexOf(":");
      const field = sep >= 0 ? line.slice(0, sep) : line;
      const value = sep >= 0 ? line.slice(sep + 1).replace(/^ /, "") : "";
      frame.fields[field] = frame.fields[field] ? `${frame.fields[field]}\n${value}` : value;
    }
    if (frame.fields.data) {
      try {
        frame.json = JSON.parse(frame.fields.data);
      } catch {
        frame.json = null;
      }
    }
    frames.push(frame);
  }
  return { frames, rest };
}

async function openStream(token, { lastEventId = null } = {}) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events/stream`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "text/event-stream",
      ...(lastEventId !== null ? { "Last-Event-ID": String(lastEventId) } : {}),
    },
    signal: controller.signal,
  });
  const stream = {
    response,
    frames: [],
    ended: false,
    close() {
      controller.abort();
      openStreams.delete(stream);
    },
    async waitFor(predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = stream.frames.find(predicate);
        if (hit) return hit;
        if (stream.ended) throw new Error("stream ended before expected frame");
        if (Date.now() > deadline) {
          throw new Error(`等待事件超时；已收到：${JSON.stringify(stream.frames.map((f) => f.fields.event || f.comments))}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
  openStreams.add(stream);
  if (response.ok && response.body) {
    (async () => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseFrames(buffer);
          buffer = parsed.rest;
          stream.frames.push(...parsed.frames);
        }
      } catch {
        /* aborted */
      } finally {
        stream.ended = true;
      }
    })();
  }
  return stream;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("匿名请求 401；登录后建立 text/event-stream 长连接并先收到 ready 与保活 ping", async () => {
  const anonymous = await fetch(`${base}/api/events/stream`);
  assert.equal(anonymous.status, 401);
  await anonymous.body?.cancel();

  const token = await login("ev_boss");
  const stream = await openStream(token);
  assert.equal(stream.response.status, 200);
  assert.match(stream.response.headers.get("content-type") || "", /^text\/event-stream/u);
  assert.match(stream.response.headers.get("cache-control") || "", /no-cache/u);
  assert.equal(stream.response.headers.get("x-accel-buffering"), "no");
  const ready = await stream.waitFor((frame) => frame.fields.event === "ready");
  assert.equal(ready.json.pingIntervalMs, SSE_PING_INTERVAL_MS);
  assert.ok(stream.frames.some((frame) => frame.fields.retry === "3000"));
  await stream.waitFor((frame) => frame.comments.includes("ping"), 2000);
  assert.equal(bus.sseConnectionStats().connections, 1);
  stream.close();
  await sleep(50);
  assert.equal(bus.sseConnectionStats().connections, 0);
});

test("按租户与可见性过滤：boss 收全租户，sales 只收指向自己的事件，跨租户不可见", async () => {
  const bossToken = await login("ev_boss");
  const salesToken = await login("ev_sales");
  const otherToken = await login("ev_other");
  const bossStream = await openStream(bossToken);
  const salesStream = await openStream(salesToken);
  const otherStream = await openStream(otherToken);
  await Promise.all([bossStream, salesStream, otherStream].map((s) => s.waitFor((f) => f.fields.event === "ready")));

  const roleEvent = bus.publish({
    tenantId: 201,
    type: "approval.created",
    roles: ["manager"],
    payload: { approvalId: 1, title: "经理才看得到" },
  });
  const salesEvent = bus.publish({
    tenantId: 201,
    type: "task.status_changed",
    userIds: [salesId],
    payload: { kind: "manual", id: 1, status: "待执行", title: "派给员工" },
  });

  const bossRole = await bossStream.waitFor((f) => f.fields.id === roleEvent.id);
  assert.equal(bossRole.fields.event, "approval.created");
  assert.equal(bossRole.json.payload.title, "经理才看得到");
  await bossStream.waitFor((f) => f.fields.id === salesEvent.id);
  const salesFrame = await salesStream.waitFor((f) => f.fields.id === salesEvent.id);
  assert.equal(salesFrame.json.type, "task.status_changed");
  assert.equal(salesFrame.json.payload.status, "待执行");
  await sleep(150);
  assert.equal(salesStream.frames.some((f) => f.fields.id === roleEvent.id), false, "sales 不得收到经理角色事件");
  assert.equal(otherStream.frames.some((f) => f.fields.id && ["approval.created", "task.status_changed"].includes(f.fields.event)), false, "别家租户不得收到任何事件");
  bossStream.close();
  salesStream.close();
  otherStream.close();
});

test("Last-Event-ID 重连补发缓冲中更大 id 且可见的事件", async () => {
  const token = await login("ev_boss");
  const first = bus.publish({ tenantId: 201, type: "inbox.changed", all: true, payload: { n: 1 } });
  const second = bus.publish({ tenantId: 201, type: "credits.updated", all: true, payload: { balance: 4000 } });
  const third = bus.publish({ tenantId: 201, type: "notification.created", userIds: [salesId], payload: { title: "只给员工" } });
  bus.publish({ tenantId: 202, type: "inbox.changed", all: true, payload: { n: 99 } });

  const stream = await openStream(token, { lastEventId: first.id });
  const ready = await stream.waitFor((f) => f.fields.event === "ready");
  assert.equal(ready.json.lastEventId, Number(first.id));
  await stream.waitFor((f) => f.fields.id === third.id);
  const replayed = stream.frames.filter((f) => f.fields.id).map((f) => f.fields.id);
  assert.deepEqual(replayed, [second.id, third.id]);
  stream.close();

  const salesStream = await openStream(await login("ev_sales"), { lastEventId: first.id });
  await salesStream.waitFor((f) => f.fields.id === third.id);
  assert.deepEqual(
    salesStream.frames.filter((f) => f.fields.id).map((f) => f.fields.id),
    [second.id, third.id],
    "all=true 与 userIds 命中的事件都补发；不可见的不补",
  );
  salesStream.close();
});

test("每用户最多 3 条连接，超出时最旧连接收到 replaced 并被关闭", async () => {
  const token = await login("ev_manager");
  const streams = [];
  for (let index = 0; index < SSE_MAX_CONNECTIONS_PER_USER; index += 1) {
    const stream = await openStream(token);
    await stream.waitFor((f) => f.fields.event === "ready");
    streams.push(stream);
  }
  assert.equal(bus.sseConnectionStats().connections, SSE_MAX_CONNECTIONS_PER_USER);
  const extra = await openStream(token);
  await extra.waitFor((f) => f.fields.event === "ready");
  await streams[0].waitFor((f) => f.fields.event === "replaced");
  await sleep(50);
  assert.equal(streams[0].ended, true, "最旧连接必须被服务端结束");
  assert.equal(bus.sseConnectionStats().connections, SSE_MAX_CONNECTIONS_PER_USER);
  for (const stream of [...streams.slice(1), extra]) stream.close();
  await sleep(50);
  assert.equal(bus.sseConnectionStats().connections, 0);
});

test("SSE 长连接不占用 ai-limits 并发租约：连接期间 AI 生成请求仍能进入路由", async () => {
  const token = await login("ev_boss");
  const before = aiPool.stats();
  const streams = [await openStream(token), await openStream(token)];
  await Promise.all(streams.map((s) => s.waitFor((f) => f.fields.event === "ready")));
  assert.deepEqual(aiPool.stats(), before, "打开 SSE 后并发计数不得变化");
  const generate = await fetch(`${base}/api/content/generate`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(generate.status, 400, "并发槽位未被 SSE 占用，请求应到达业务路由的参数校验");
  await generate.body?.cancel();
  assert.equal(aiPool.stats().inFlight, 0);
  for (const stream of streams) stream.close();
});

test("人工任务状态翻转与站内通知通过真实端点触发推送；/api/sys/status 暴露连接数", async () => {
  const bossToken = await login("ev_boss");
  const salesToken = await login("ev_sales");
  const bossStream = await openStream(bossToken);
  const salesStream = await openStream(salesToken);
  await Promise.all([bossStream, salesStream].map((s) => s.waitFor((f) => f.fields.event === "ready")));

  const created = await fetch(`${base}/api/execution/tasks`, {
    method: "POST",
    headers: { authorization: `Bearer ${bossToken}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "巡店整改跟进", assignee_id: salesId }),
  });
  const task = await created.json();
  assert.equal(created.status, 200, JSON.stringify(task));

  const statusFrame = await salesStream.waitFor(
    (f) => f.fields.event === "task.status_changed" && f.json?.payload?.id === Number(task.id),
  );
  assert.equal(statusFrame.json.payload.kind, "manual");
  assert.equal(statusFrame.json.payload.status, "待执行");
  const notification = await salesStream.waitFor((f) => f.fields.event === "notification.created");
  assert.equal(notification.json.payload.title, "新任务派发");
  const inboxChanged = await salesStream.waitFor((f) => f.fields.event === "inbox.changed", 2000);
  assert.equal(inboxChanged.json.type, "inbox.changed");
  await bossStream.waitFor((f) => f.fields.event === "task.status_changed" && f.json?.payload?.id === Number(task.id));

  const started = await fetch(`${base}/api/execution/tasks/${task.id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${salesToken}`, "content-type": "application/json" },
    body: JSON.stringify({ status: "进行中" }),
  });
  assert.equal(started.status, 200);
  await started.body?.cancel();
  const running = await bossStream.waitFor(
    (f) => f.fields.event === "task.status_changed" && f.json?.payload?.id === Number(task.id) && f.json.payload.status === "进行中",
  );
  assert.equal(running.json.payload.kind, "manual");

  const status = await fetch(`${base}/api/sys/status`, { headers: { authorization: `Bearer ${bossToken}` } });
  const statusBody = await status.json();
  assert.equal(status.status, 200, JSON.stringify(statusBody));
  assert.equal(statusBody.realtime.connections, 2);
  assert.equal(statusBody.realtime.users, 2);
  bossStream.close();
  salesStream.close();
});
