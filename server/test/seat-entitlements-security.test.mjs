import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { removeTempDirSafely } from "./helpers/temp-db.mjs";

const fixtureDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "nanowork-seat-security-"),
);
const dbPath = path.join(fixtureDir, "isolated.db");
Object.assign(process.env, {
  NANOWORK_DB: dbPath,
  NODE_ENV: "test",
  SEED_DEMO: "false",
  ENABLE_SCHEDULER: "false",
  ENABLE_BACKGROUND_EMBEDDINGS: "false",
  NANOWORK_TEST_TEMPLATE_AI: "1",
  JWT_SECRET: "Seat-Security-Test#2026!isolated",
  REGISTER_IP_MAX_ATTEMPTS: "200",
  INVITATION_PREVIEW_IP_MAX_ATTEMPTS: "200",
  LOGIN_IP_MAX_FAILURES: "200",
  YUNWU_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  WXPAY_MCHID: "",
  ALIPAY_APPID: "",
});
const nativeFetch = globalThis.fetch;
const localOrigins = new Set();
const externalCalls = [];
globalThis.fetch = async (input, options) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (!localOrigins.has(url.origin)) {
    externalCalls.push(url.origin);
    throw new Error("Seat security test forbids external network calls");
  }
  return nativeFetch(input, options);
};
const { db, initSchema, migrateV2, DB_PATH } = await import("../src/db.js");
const { hashPassword } = await import("../src/util.js");
initSchema();
migrateV2();
assert.equal(DB_PATH, dbPath);
const { createApp } = await import("../src/app.js");
const password = "Seat-Fixture#2026";
const passwordHash = hashPassword(password);
let sequence = 0;
const nextName = () => `seat_account_${++sequence}`;
function addTenant(name, { limit = 5 } = {}) {
  return Number(
    db
      .prepare(
        `INSERT INTO tenants(name,status,credits,total_recharged,seat_limit)
    VALUES(?,'已开通',1000,0,?)`,
      )
      .run(name, limit).lastInsertRowid,
  );
}
function addUser(tenantId, role = "sales", status = "启用") {
  const username = nextName();
  const id = Number(
    db
      .prepare(
        `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES(?,?,?,?,?,?)`,
      )
      .run(username, passwordHash, username, role, status, tenantId)
      .lastInsertRowid,
  );
  return { id, username, tenantId, role };
}
const platformTenant = addTenant("席位平台");
const platformUser = addUser(platformTenant, "platform_super");
const server = createApp({
  serveStatic: false,
  autoRecoverAvatar: false,
  autoRecoverTextVideo: false,
  autoRecoverWechatDraft: false,
}).listen(0, "127.0.0.1");
try {
  await once(server, "listening");
} catch (error) {
  globalThis.fetch = nativeFetch;
  await removeTempDirSafely(fixtureDir, { dbPath });
  throw error;
}
const base = `http://127.0.0.1:${server.address().port}`;
localOrigins.add(base);
const workers = new Set();
after(async () => {
  await Promise.all([...workers].map(stopWorker));
  await new Promise((resolve) => server.close(resolve));
  globalThis.fetch = nativeFetch;
  await removeTempDirSafely(fixtureDir, { dbPath });
  assert.deepEqual(
    externalCalls,
    [],
    "席位申请、报价和确认不能调用真实支付渠道或模型",
  );
});
async function request(
  route,
  { cookie, method = "GET", body, origin = base } = {},
) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  // Express may return HTML for a route that does not exist (for example the
  // unsupported admin DELETE). It must still satisfy the denial assertions;
  // malformed responses from declared JSON APIs should remain test failures.
  const responseBody = response.headers
    .get("content-type")
    ?.includes("application/json")
    ? JSON.parse(raw)
    : { text: raw };
  return {
    status: response.status,
    body: responseBody,
    headers: response.headers,
  };
}
async function login(user) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: { username: user.username, password },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const cookies = result.headers.getSetCookie();
  assert.ok(cookies.some((value) => value.includes("HttpOnly")));
  return {
    ...user,
    cookie: cookies.map((value) => value.split(";")[0]).join("; "),
  };
}
const superSession = await login(platformUser);
const tenantRow = (tid) =>
  db.prepare("SELECT * FROM tenants WHERE id=?").get(tid);
const activeCount = (tid) =>
  db
    .prepare(
      "SELECT COUNT(*) n FROM users WHERE tenant_id=? AND status='启用' AND role!='platform_super'",
    )
    .get(tid).n;
const userRow = (id) => db.prepare("SELECT * FROM users WHERE id=?").get(id);
const requestRow = (id) =>
  db.prepare("SELECT * FROM seat_requests WHERE id=?").get(id);
const ledgerCount = (tid) =>
  db.prepare("SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=?").get(tid).n;
function assertDenied(result) {
  assert.ok(
    result.status >= 400 && result.status < 500,
    JSON.stringify(result.body),
  );
}
async function bindPrimary(tenantId, userId, session = superSession) {
  return request(`/api/platform/tenants/${tenantId}/primary-account`, {
    cookie: session.cookie,
    method: "POST",
    body: { userId },
  });
}
async function enterprise({ subsidiaries = 0, name = "席位验收企业" } = {}) {
  const tenantId = addTenant(name);
  const main = await login(addUser(tenantId, "boss"));
  assert.equal((await bindPrimary(tenantId, main.id)).status, 200);
  assert.equal(tenantRow(tenantId).primary_user_id, main.id);
  const subs = [];
  for (let i = 0; i < subsidiaries; i++)
    subs.push(await login(addUser(tenantId, i === 0 ? "admin" : "sales")));
  return { tenantId, main, subs };
}
const accountBody = (extra = {}) => ({
  username: nextName(),
  name: "副账号",
  password,
  role: "sales",
  ...extra,
});
async function invitation(main) {
  const result = await request("/api/admin/invitations", {
    cookie: main.cookie,
    method: "POST",
    body: { type: "existing_tenant", role: "sales", maxUses: 1 },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}
async function applySeats(main, additionalSeats = 2) {
  const result = await request("/api/admin/seat-requests", {
    cookie: main.cookie,
    method: "POST",
    body: { additionalSeats, reason: "隔离测试申请，无真实费用" },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const row = db
    .prepare(
      "SELECT * FROM seat_requests WHERE tenant_id=? ORDER BY id DESC LIMIT 1",
    )
    .get(main.tenantId);
  assert.ok(row);
  assert.equal(row.additional_seats, additionalSeats);
  assert.equal(row.status, "requested");
  assert.equal(result.body.request.id, row.id);
  assert.equal(result.body.summary.primaryAccount.id, main.id);
  assert.equal(result.body.summary.includedPrimarySeats, 1);
  assert.equal(result.body.summary.includedSubSeats, 4);
  return row;
}
async function quoteSeats(id, amountFen = 12345) {
  const result = await request(`/api/platform/seat-requests/${id}/quote`, {
    cookie: superSession.cookie,
    method: "POST",
    body: { amountFen, note: "仅测试报价，不代表产品价格" },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const row = requestRow(id);
  assert.equal(row.status, "quoted");
  assert.equal(row.amount_fen, amountFen);
  assert.ok(row.order_id);
  assert.equal(result.body.request.orderId, row.order_id);
  assert.equal(result.body.request.amountFen, amountFen);
  return row;
}

test("旧唯一老板可迁移为主账号，多老板不猜测；只有平台能确认本企业主账号", async () => {
  const soleTid = addTenant("唯一老板旧企业");
  const sole = addUser(soleTid, "boss");
  addUser(soleTid, "admin");
  const ambiguousTid = addTenant("多老板旧企业");
  const first = await login(addUser(ambiguousTid, "boss"));
  addUser(ambiguousTid, "boss");
  migrateV2();
  assert.equal(tenantRow(soleTid).primary_user_id, sole.id);
  assert.equal(tenantRow(ambiguousTid).primary_user_id, null);
  assertDenied(await bindPrimary(ambiguousTid, first.id, first));
  assertDenied(await bindPrimary(ambiguousTid, sole.id));
  assert.equal((await bindPrimary(ambiguousTid, first.id)).status, 200);
  assert.equal(tenantRow(ambiguousTid).primary_user_id, first.id);
});

test("新企业创建者直接成为唯一主账号，邀请其他老板或管理员不会变更主账号", async () => {
  const made = await request("/api/platform/invitations", {
    cookie: superSession.cookie,
    method: "POST",
    body: { type: "new_tenant", role: "boss", maxUses: 1 },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const username = nextName();
  const signed = await request("/api/auth/register", {
    method: "POST",
    body: {
      inviteCode: made.body.code,
      username,
      password,
      contactName: "主账号",
      company: "新主账号企业",
      primary_user_id: platformUser.id,
    },
  });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  const main = db.prepare("SELECT * FROM users WHERE username=?").get(username);
  assert.equal(tenantRow(main.tenant_id).primary_user_id, main.id);
  assert.equal(tenantRow(main.tenant_id).seat_limit, 5);
  assert.equal(tenantRow(main.tenant_id).credits, 0);
  const session = await login(main);
  const extraBoss = await request("/api/admin/invitations", {
    cookie: session.cookie,
    method: "POST",
    body: { type: "existing_tenant", role: "boss" },
  });
  assert.equal(extraBoss.status, 201);
  assert.equal(
    (
      await request("/api/auth/register", {
        method: "POST",
        body: {
          inviteCode: extraBoss.body.code,
          username: nextName(),
          password,
          contactName: "副老板",
        },
      })
    ).status,
    200,
  );
  assert.equal(tenantRow(main.tenant_id).primary_user_id, main.id);
});

test("副管理员不能重置主账号密码、停用、改角色/模块或把自己冒充主账号", async () => {
  const e = await enterprise({ subsidiaries: 1 });
  const subordinate = e.subs[0];
  const before = { ...userRow(e.main.id) };
  for (const prefix of ["/api/admin/users", "/api/sys/users"]) {
    for (const body of [
      { password: "Attacker-Password#2026" },
      { status: "停用" },
      { role: "sales" },
      { modules: [] },
      { name: "连带篡改", password: "Attacker-Password#2026", modules: [] },
    ])
      assertDenied(
        await request(`${prefix}/${e.main.id}`, {
          cookie: subordinate.cookie,
          method: "PUT",
          body,
        }),
      );
    assertDenied(
      await request(`${prefix}/${e.main.id}`, {
        cookie: subordinate.cookie,
        method: "DELETE",
      }),
    );
  }
  assert.deepEqual({ ...userRow(e.main.id) }, before);
  assertDenied(await bindPrimary(e.tenantId, subordinate.id, subordinate));
  assert.equal(tenantRow(e.tenantId).primary_user_id, e.main.id);
  const created = await request("/api/admin/users", {
    cookie: subordinate.cookie,
    method: "POST",
    body: accountBody({
      primary_user_id: subordinate.id,
      isPrimary: true,
      role: "boss",
    }),
  });
  if (created.status === 200) assert.notEqual(created.body.id, e.main.id);
  else assertDenied(created);
  assert.equal(tenantRow(e.tenantId).primary_user_id, e.main.id);
});

test("一主四副满额时两个建号、邀请兑换与两个重新启用入口都返回席位不足", async () => {
  const e = await enterprise({ subsidiaries: 4 });
  const disabled = addUser(e.tenantId, "sales", "停用");
  const invite = await invitation(e.main);
  for (const prefix of ["/api/admin/users", "/api/sys/users"]) {
    const created = await request(prefix, {
      cookie: e.main.cookie,
      method: "POST",
      body: accountBody(),
    });
    assert.equal(created.status, 409, JSON.stringify(created.body));
    const enabled = await request(`${prefix}/${disabled.id}`, {
      cookie: e.main.cookie,
      method: "PUT",
      body: { status: "启用" },
    });
    assert.equal(enabled.status, 409, JSON.stringify(enabled.body));
    assert.equal(userRow(disabled.id).status, "停用");
    const harmless = await request(`${prefix}/${e.subs[1].id}`, {
      cookie: e.main.cookie,
      method: "PUT",
      body: { status: "启用", name: "已有启用账号可编辑" },
    });
    assert.equal(harmless.status, 200, JSON.stringify(harmless.body));
  }
  const join = await request("/api/auth/register", {
    method: "POST",
    body: {
      inviteCode: invite.code,
      username: nextName(),
      password,
      contactName: "超额邀请",
    },
  });
  assert.equal(join.status, 409, JSON.stringify(join.body));
  assert.equal(
    db
      .prepare("SELECT used_count FROM invitations WHERE id=?")
      .get(invite.invitation.id).used_count,
    0,
  );
  assert.equal(activeCount(e.tenantId), 5);
});

test("停用释放副席位后可补一人，恢复旧账号仍要检查额度且不会删除历史账号", async () => {
  const e = await enterprise({ subsidiaries: 4 });
  const former = e.subs[1];
  assert.equal(
    (
      await request(`/api/sys/users/${former.id}`, {
        cookie: e.main.cookie,
        method: "DELETE",
      })
    ).status,
    200,
  );
  assert.equal(userRow(former.id).status, "停用");
  assert.equal(
    (
      await request("/api/admin/users", {
        cookie: e.main.cookie,
        method: "POST",
        body: accountBody(),
      })
    ).status,
    200,
  );
  for (const prefix of ["/api/admin/users", "/api/sys/users"]) {
    assert.equal(
      (
        await request(`${prefix}/${former.id}`, {
          cookie: e.main.cookie,
          method: "PUT",
          body: { status: "启用" },
        })
      ).status,
      409,
    );
  }
  assert.equal(activeCount(e.tenantId), 5);
  assert.equal(userRow(former.id).status, "停用");
});

test("只有主账号申请取消，副老板管理员仅能读本企业，其他角色和跨企业操作拒绝", async () => {
  const a = await enterprise({ subsidiaries: 1 });
  const b = await enterprise();
  const deputyBoss = await login(addUser(a.tenantId, "boss"));
  const member = await login(addUser(a.tenantId, "sales"));
  const pending = await applySeats(a.main);
  for (const session of [a.subs[0], deputyBoss]) {
    assert.equal(
      (await request("/api/admin/seat-requests", { cookie: session.cookie }))
        .status,
      200,
    );
    assertDenied(
      await request("/api/admin/seat-requests", {
        cookie: session.cookie,
        method: "POST",
        body: { additionalSeats: 2 },
      }),
    );
    assertDenied(
      await request(`/api/admin/seat-requests/${pending.id}/cancel`, {
        cookie: session.cookie,
        method: "POST",
        body: {},
      }),
    );
  }
  assertDenied(
    await request("/api/admin/seat-requests", { cookie: member.cookie }),
  );
  assertDenied(
    await request(`/api/admin/seat-requests/${pending.id}/cancel`, {
      cookie: b.main.cookie,
      method: "POST",
      body: {},
    }),
  );
  for (const session of [a.main, a.subs[0], deputyBoss, member]) {
    assertDenied(
      await request(`/api/platform/seat-requests/${pending.id}/quote`, {
        cookie: session.cookie,
        method: "POST",
        body: { amountFen: 1 },
      }),
    );
  }
  const list = await request(
    `/api/admin/seat-requests?tenantId=${b.tenantId}`,
    { cookie: a.main.cookie },
  );
  assert.equal(list.status, 403);
  const ownList = await request("/api/admin/seat-requests", {
    cookie: a.main.cookie,
  });
  assert.deepEqual(
    ownList.body.items.map((item) => item.id),
    [pending.id],
  );
  assert.ok(ownList.body.items.every((item) => item.tenantId === a.tenantId));
  assert.equal(ownList.body.summary.canRequestAdditionalSeats, true);
  assert.equal(ownList.body.summary.subSeatLimit, 4);
  assert.equal(
    (
      await request(`/api/admin/seat-requests/${pending.id}/cancel`, {
        cookie: a.main.cookie,
        method: "POST",
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(requestRow(pending.id).status, "cancelled");
  assert.equal(tenantRow(a.tenantId).seat_limit, 5);
});

test("申请与未定价不扩容，正整数报价生成冻结零积分订单，客户端不能自行标记已付款", async () => {
  const e = await enterprise();
  for (const additionalSeats of [0, -1, 1.5, 1001]) {
    assertDenied(
      await request("/api/admin/seat-requests", {
        cookie: e.main.cookie,
        method: "POST",
        body: { additionalSeats },
      }),
    );
  }
  const applied = await applySeats(e.main, 3);
  assert.equal(tenantRow(e.tenantId).seat_limit, 5);
  assert.equal(applied.order_id, null);
  for (const amountFen of [undefined, 0, -1, 1.5]) {
    assertDenied(
      await request(`/api/platform/seat-requests/${applied.id}/quote`, {
        cookie: superSession.cookie,
        method: "POST",
        body: { amountFen },
      }),
    );
  }
  assert.equal(requestRow(applied.id).status, "requested");
  const quoted = await quoteSeats(applied.id, 12345);
  const order = db
    .prepare("SELECT * FROM recharge_orders WHERE id=?")
    .get(quoted.order_id);
  assert.equal(order.tenant_id, e.tenantId);
  assert.equal(order.package_id, null);
  assert.equal(order.credits, 0);
  assert.equal(order.price_yuan, 123.45);
  assert.equal(order.status, "待支付");
  assert.equal(tenantRow(e.tenantId).seat_limit, 5);
  assertDenied(
    await request(`/api/platform/seat-requests/${quoted.id}/quote`, {
      cookie: superSession.cookie,
      method: "POST",
      body: { amountFen: 1 },
    }),
  );
  for (const body of [
    {},
    { paymentReference: "" },
    { paid: true, amountFen: 12345 },
  ]) {
    assertDenied(
      await request(`/api/platform/recharge-orders/${order.id}/confirm`, {
        cookie: superSession.cookie,
        method: "POST",
        body,
      }),
    );
  }
  assertDenied(
    await request(`/api/platform/recharge-orders/${order.id}/confirm`, {
      cookie: e.main.cookie,
      method: "POST",
      body: { paymentReference: "TEST-FAKE-SELF-CONFIRM" },
    }),
  );
  assert.equal(requestRow(quoted.id).status, "quoted");
  assert.equal(tenantRow(e.tenantId).seat_limit, 5);
  assert.equal(ledgerCount(e.tenantId), 0);
});

test("平台付款确认一次增加副席位，重放不会重复开通，也不发积分或改变主账号", async () => {
  const e = await enterprise({ subsidiaries: 4 });
  const quoted = await quoteSeats((await applySeats(e.main, 2)).id);
  const before = tenantRow(e.tenantId);
  assertDenied(
    await request(`/api/platform/recharge-orders/${quoted.order_id}/confirm`, {
      cookie: superSession.cookie,
      method: "POST",
      body: {
        paymentReference: "BANK-TEST",
        additionalSeats: 1000,
        credits: 10000,
      },
    }),
  );
  assert.equal(tenantRow(e.tenantId).seat_limit, 5);
  const confirm = () =>
    request(`/api/platform/recharge-orders/${quoted.order_id}/confirm`, {
      cookie: superSession.cookie,
      method: "POST",
      body: { paymentReference: "BANK-TEST-CONFIRM-ONLY" },
    });
  const results = await Promise.all([confirm(), confirm()]);
  assert.ok(
    results.every((result) => result.status === 200),
    JSON.stringify(results),
  );
  assert.deepEqual(results.map((result) => result.body.duplicated).sort(), [
    false,
    true,
  ]);
  assert.equal(requestRow(quoted.id).status, "applied");
  assert.equal(tenantRow(e.tenantId).seat_limit, 7);
  assert.equal(tenantRow(e.tenantId).primary_user_id, e.main.id);
  assert.equal(tenantRow(e.tenantId).credits, before.credits);
  assert.equal(tenantRow(e.tenantId).total_recharged, before.total_recharged);
  assert.equal(ledgerCount(e.tenantId), 0);
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await request("/api/sys/users", {
          cookie: e.main.cookie,
          method: "POST",
          body: accountBody(),
        })
      ).status,
      200,
    );
  assert.equal(
    (
      await request("/api/admin/users", {
        cookie: e.main.cookie,
        method: "POST",
        body: accountBody(),
      })
    ).status,
    409,
  );
  assert.equal(activeCount(e.tenantId), 7);
});

test("取消和驳回同时关闭席位订单；旧充值取消及支付回调不能绕过主账号和线下确认", async () => {
  const e = await enterprise({ subsidiaries: 1 });
  const other = await enterprise();
  const quoted = await quoteSeats((await applySeats(e.main)).id);
  const order = db
    .prepare("SELECT * FROM recharge_orders WHERE id=?")
    .get(quoted.order_id);
  const { settlePaidOrder } = await import("../src/routes/recharge.js");
  assert.throws(
    () =>
      settlePaidOrder({
        orderNo: order.order_no,
        channelName: "测试伪造在线回调",
        paidFen: quoted.amount_fen,
      }),
    (error) => error.status === 409 && error.code === "SEAT_ORDER_OFFLINE_ONLY",
  );
  const poll = await request(`/api/recharge/orders/${order.order_no}/status`, {
    cookie: e.main.cookie,
  });
  assert.equal(poll.status, 200);
  assert.equal(poll.body.status, "待支付");
  assert.equal(tenantRow(e.tenantId).seat_limit, 5);
  assertDenied(
    await request(`/api/recharge/orders/${order.id}/cancel`, {
      cookie: e.subs[0].cookie,
      method: "POST",
    }),
  );
  assert.equal(
    (
      await request(`/api/recharge/orders/${order.id}/cancel`, {
        cookie: other.main.cookie,
        method: "POST",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(`/api/recharge/orders/${order.id}/cancel`, {
        cookie: e.main.cookie,
        method: "POST",
      })
    ).status,
    200,
  );
  assert.equal(requestRow(quoted.id).status, "cancelled");
  assert.equal(
    db.prepare("SELECT status FROM recharge_orders WHERE id=?").get(order.id)
      .status,
    "已取消",
  );
  assertDenied(
    await request(`/api/platform/recharge-orders/${order.id}/confirm`, {
      cookie: superSession.cookie,
      method: "POST",
      body: { paymentReference: "AFTER-CANCEL" },
    }),
  );
  const second = await quoteSeats((await applySeats(e.main, 3)).id);
  assert.equal(
    (
      await request(`/api/platform/seat-requests/${second.id}/reject`, {
        cookie: superSession.cookie,
        method: "POST",
        body: { reason: "测试拒绝申请" },
      })
    ).status,
    200,
  );
  assert.equal(requestRow(second.id).status, "rejected");
  assert.equal(
    db
      .prepare("SELECT status FROM recharge_orders WHERE id=?")
      .get(second.order_id).status,
    "已取消",
  );
  assertDenied(
    await request(`/api/platform/recharge-orders/${second.order_id}/confirm`, {
      cookie: superSession.cookie,
      method: "POST",
      body: { paymentReference: "AFTER-REJECT" },
    }),
  );
  assert.equal(tenantRow(e.tenantId).seat_limit, 5);
  assert.equal(ledgerCount(e.tenantId), 0);
});

test("旧修改额度/审核/套餐入口不能越过付费申请；续费和迁移保留已付增额及旧权益", async () => {
  const e = await enterprise();
  for (const action of ["update", "approve"]) {
    const result = await request(
      `/api/platform/tenants/${e.tenantId}/${action}`,
      { cookie: superSession.cookie, method: "POST", body: { seatLimit: 100 } },
    );
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(tenantRow(e.tenantId).seat_limit, 5);
  }
  const packageId = Number(
    db
      .prepare(
        `INSERT INTO recharge_packages(code,name,kind,price_yuan,base_credits,bonus_credits,total_credits,seat_limit,valid_days,enabled)
    VALUES(?,'测试历史大席位套餐','plan',1,0,0,0,100,365,1)`,
      )
      .run(nextName()).lastInsertRowid,
  );
  const activation = await request(
    `/api/platform/tenants/${e.tenantId}/plan/activate`,
    { cookie: superSession.cookie, method: "POST", body: { packageId, requestKey: 'seat-plan-legacy-purchase' } },
  );
  assert.equal(activation.status, 200, JSON.stringify(activation.body));
  assert.equal(
    tenantRow(e.tenantId).seat_limit,
    5,
    "旧套餐的 seat_limit 不能直接增容",
  );
  const quoted = await quoteSeats((await applySeats(e.main, 2)).id);
  assert.equal(
    (
      await request(
        `/api/platform/recharge-orders/${quoted.order_id}/confirm`,
        {
          cookie: superSession.cookie,
          method: "POST",
          body: { paymentReference: "TEST-EXTRA-BEFORE-RENEWAL" },
        },
      )
    ).status,
    200,
  );
  db.prepare("UPDATE recharge_packages SET seat_limit=5 WHERE id=?").run(
    packageId,
  );
  const renewal = await request("/api/recharge/orders", {
    cookie: e.main.cookie,
    method: "POST",
    body: { packageId },
  });
  assert.equal(renewal.status, 200, JSON.stringify(renewal.body));
  assert.equal(
    (
      await request(
        `/api/platform/recharge-orders/${renewal.body.id}/confirm`,
        { cookie: superSession.cookie, method: "POST", body: {} },
      )
    ).status,
    200,
  );
  assert.equal(
    tenantRow(e.tenantId).seat_limit,
    7,
    "续费不能覆盖已经付款的额外副账号",
  );
  const legacy = addTenant("保留历史九席权益", { limit: 9 });
  addUser(legacy, "boss");
  const originalOne = tenantRow(1).seat_limit;
  db.prepare("UPDATE tenants SET seat_limit=5 WHERE id=1").run();
  try {
    migrateV2();
    assert.equal(tenantRow(1).seat_limit, 5, "迁移不得重新把租户1改为999席");
    assert.equal(tenantRow(legacy).seat_limit, 9);
    assert.equal(tenantRow(e.tenantId).seat_limit, 7);
  } finally {
    db.prepare("UPDATE tenants SET seat_limit=? WHERE id=1").run(originalOne);
  }
  const summary = (
    await request("/api/admin/seat-requests", { cookie: e.main.cookie })
  ).body.summary;
  assert.equal(summary.purchasedExtraSeats, 2);
  assert.equal(summary.legacyExtraSeats, 0);
  assert.equal(summary.subSeatLimit, 6);
});

test("主副标识不随业务角色混淆；停用副账号同步关闭自动任务并撤销旧登录会话", async () => {
  const e = await enterprise({ subsidiaries: 1 });
  const subBoss = await login(addUser(e.tenantId, "boss"));
  for (const route of ["/api/admin/users", "/api/sys/users"]) {
    const result = await request(route, { cookie: e.main.cookie });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const users = Array.isArray(result.body) ? result.body : result.body.users;
    assert.equal(
      users.find((user) => user.id === e.main.id).accountType,
      "primary",
    );
    assert.equal(
      users.find((user) => user.id === subBoss.id).accountType,
      "sub",
    );
    assert.equal(
      users.filter((user) => user.accountType === "primary").length,
      1,
    );
  }
  const ruleId = Number(
    db
      .prepare(
        `INSERT INTO content_automation_rules(tenant_id,name,employee_idx,topic,content_type,frequency,run_time,next_run_at,created_by)
    VALUES(?,'隔离测试自动任务',0,'测试主题','图文','daily','09:00','2099-01-01 09:00:00',?)`,
      )
      .run(e.tenantId, subBoss.id).lastInsertRowid,
  );
  const oldVersion = userRow(subBoss.id).auth_version;
  const disabled = await request(`/api/admin/users/${subBoss.id}`, {
    cookie: e.main.cookie,
    method: "PUT",
    body: { status: "停用" },
  });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  assert.equal(disabled.body.historyPreserved, true);
  assert.equal(disabled.body.disabledAutomationRules, 1);
  assert.equal(userRow(subBoss.id).auth_version, oldVersion + 1);
  assert.deepEqual(
    {
      ...db
        .prepare(
          "SELECT enabled,next_run_at,created_by FROM content_automation_rules WHERE id=?",
        )
        .get(ruleId),
    },
    { enabled: 0, next_run_at: null, created_by: subBoss.id },
  );
  assert.equal(
    (await request("/api/admin/seat-requests", { cookie: subBoss.cookie }))
      .status,
    401,
  );
  for (const prefix of ["/api/admin/users", "/api/sys/users"]) {
    assertDenied(
      await request(`${prefix}/${e.main.id}`, {
        cookie: e.main.cookie,
        method: "PUT",
        body: { role: "sales" },
      }),
    );
    assertDenied(
      await request(`${prefix}/${e.main.id}`, {
        cookie: e.main.cookie,
        method: "PUT",
        body: { status: "停用" },
      }),
    );
  }
  assert.equal(tenantRow(e.tenantId).primary_user_id, e.main.id);
  assert.equal(userRow(e.main.id).status, "启用");
});

test("停用企业及被降权平台会话不能确认席位付款，冻结订单金额损坏时不部分扩容", async () => {
  const e = await enterprise();
  const quoted = await quoteSeats((await applySeats(e.main)).id);
  const confirm = (cookie) =>
    request(`/api/platform/recharge-orders/${quoted.order_id}/confirm`, {
      cookie,
      method: "POST",
      body: { paymentReference: "TEST-BOUNDARY" },
    });
  db.prepare("UPDATE tenants SET status='已停用' WHERE id=?").run(e.tenantId);
  assertDenied(await confirm(superSession.cookie));
  db.prepare("UPDATE tenants SET status='已开通' WHERE id=?").run(e.tenantId);
  const temporarySuper = await login(addUser(platformTenant, "platform_super"));
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(temporarySuper.id);
  assertDenied(await confirm(temporarySuper.cookie));
  db.prepare("UPDATE recharge_orders SET price_yuan=0.01 WHERE id=?").run(
    quoted.order_id,
  );
  assertDenied(await confirm(superSession.cookie));
  assert.equal(tenantRow(e.tenantId).seat_limit, 5);
  assert.equal(requestRow(quoted.id).status, "quoted");
  assert.equal(
    db
      .prepare("SELECT status FROM recharge_orders WHERE id=?")
      .get(quoted.order_id).status,
    "待支付",
  );
  assert.equal(ledgerCount(e.tenantId), 0);
});

async function stopWorker(worker) {
  if (worker.exitCode !== null || worker.signalCode !== null) {
    workers.delete(worker);
    return;
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => worker.kill("SIGKILL"), 2000);
    worker.once("exit", () => {
      clearTimeout(timer);
      workers.delete(worker);
      resolve();
    });
    if (worker.connected) worker.send({ type: "stop" });
    else worker.kill("SIGTERM");
  });
}

async function startWorker() {
  const script = path.join(fixtureDir, "http-worker.mjs");
  if (!fs.existsSync(script))
    fs.writeFileSync(
      script,
      `
    import { createApp } from ${JSON.stringify(new URL("../src/app.js", import.meta.url).href)};
    import { db, DB_PATH } from ${JSON.stringify(new URL("../src/db.js", import.meta.url).href)};
    if (DB_PATH !== process.env.NANOWORK_DB) throw new Error('Worker database isolation failed');
    globalThis.fetch = async () => { process.send?.({type:'external'}); throw new Error('No external network in seat race'); };
    const server = createApp({serveStatic:false,autoRecoverAvatar:false,autoRecoverTextVideo:false,autoRecoverWechatDraft:false}).listen(0,'127.0.0.1');
    server.prependListener('request', () => process.send?.({type:'incoming'}));
    server.on('listening', () => process.send?.({type:'ready',port:server.address().port,pid:process.pid}));
    const stop = () => server.close(() => { db.close(); process.exit(0); });
    process.on('message', message => { if (message?.type === 'stop') stop(); });
    process.on('SIGTERM', stop);
  `,
    );
  const worker = fork(script, {
    env: { ...process.env },
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  workers.add(worker);
  let output = "";
  for (const stream of [worker.stdout, worker.stderr])
    stream.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-4000);
    });
  worker.on("message", (message) => {
    if (message?.type === "external")
      externalCalls.push(`worker:${worker.pid}`);
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Seat worker startup timed out: ${output}`)),
      20000,
    );
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Seat worker exited ${code}: ${output}`));
    });
    worker.on("message", (message) => {
      if (message?.type === "ready") {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
  worker.origin = `http://127.0.0.1:${ready.port}`;
  localOrigins.add(worker.origin);
  assert.equal(ready.pid, worker.pid);
  return worker;
}

test(
  "四个独立服务进程竞争同一SQLite最后副席位：建号、恢复与邀请码兑换只允许一项成功",
  { timeout: 60000 },
  async () => {
    const e = await enterprise({ subsidiaries: 3 });
    const disabled = addUser(e.tenantId, "sales", "停用");
    const invite = await invitation(e.main);
    const joinedUsername = nextName();
    const processes = await Promise.all(
      Array.from({ length: 4 }, () => startWorker()),
    );
    assert.equal(new Set(processes.map((worker) => worker.pid)).size, 4);
    assert.ok(processes.every((worker) => worker.pid !== process.pid));
    const incoming = processes.map(
      (worker) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error("Worker did not receive concurrent HTTP request"),
              ),
            5000,
          );
          const receive = (message) => {
            if (message?.type === "incoming") {
              clearTimeout(timer);
              worker.off("message", receive);
              resolve();
            }
          };
          worker.on("message", receive);
        }),
    );
    let inTransaction = false;
    let pending;
    try {
      // This parent connection holds the shared write lock until all four *other*
      // processes enter their HTTP handlers. Stale pre-transaction seat checks
      // would all see the free seat; checks inside BEGIN IMMEDIATE serialize.
      db.exec("BEGIN IMMEDIATE");
      inTransaction = true;
      pending = Promise.all([
        request("/api/admin/users", {
          origin: processes[0].origin,
          cookie: e.main.cookie,
          method: "POST",
          body: accountBody(),
        }),
        request("/api/sys/users", {
          origin: processes[1].origin,
          cookie: e.main.cookie,
          method: "POST",
          body: accountBody(),
        }),
        request(`/api/admin/users/${disabled.id}`, {
          origin: processes[2].origin,
          cookie: e.main.cookie,
          method: "PUT",
          body: { status: "启用" },
        }),
        request("/api/auth/register", {
          origin: processes[3].origin,
          method: "POST",
          body: {
            inviteCode: invite.code,
            username: joinedUsername,
            password,
            contactName: "跨进程邀请",
          },
        }),
      ]);
      await Promise.all(incoming);
      await new Promise((resolve) => setTimeout(resolve, 100));
      db.exec("COMMIT");
      inTransaction = false;
      const results = await pending;
      assert.deepEqual(
        results.map((result) => result.status).sort(),
        [200, 409, 409, 409],
        JSON.stringify(results),
      );
      assert.equal(activeCount(e.tenantId), 5);
      assert.equal(
        db
          .prepare("SELECT used_count FROM invitations WHERE id=?")
          .get(invite.invitation.id).used_count,
        results[3].status === 200 ? 1 : 0,
      );
      assert.equal(
        Boolean(
          db
            .prepare("SELECT id FROM users WHERE username=?")
            .get(joinedUsername),
        ),
        results[3].status === 200,
      );
      assert.equal(
        userRow(disabled.id).status,
        results[2].status === 200 ? "启用" : "停用",
      );
      assert.equal(tenantRow(e.tenantId).primary_user_id, e.main.id);
    } finally {
      if (inTransaction) db.exec("ROLLBACK");
      if (pending) await pending.catch(() => {});
      await Promise.all(processes.map(stopWorker));
    }
  },
);
