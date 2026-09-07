import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { removeTempDirSafely } from "./helpers/temp-db.mjs";

// Exercise the real middleware and cookie session against a fresh database only.
const fixtureDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "nanowork-invitation-security-"),
);
const dbPath = path.join(fixtureDir, "isolated.db");
Object.assign(process.env, {
  NANOWORK_DB: dbPath,
  NODE_ENV: "test",
  SEED_DEMO: "false",
  ENABLE_SCHEDULER: "false",
  ENABLE_BACKGROUND_EMBEDDINGS: "false",
  NANOWORK_TEST_TEMPLATE_AI: "1",
  JWT_SECRET: "Invitation-Security-Test#2026!isolated",
  REGISTER_IP_MAX_ATTEMPTS: "200",
  INVITATION_PREVIEW_IP_MAX_ATTEMPTS: "200",
  LOGIN_IP_MAX_FAILURES: "200",
  YUNWU_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
});
const nativeFetch = globalThis.fetch;
let base = "";
const externalCalls = [];
globalThis.fetch = async (input, options) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (!base || url.origin !== base) {
    externalCalls.push(url.origin);
    throw new Error("Invitation test forbids external network calls");
  }
  return nativeFetch(input, options);
};

const { db, initSchema, migrateV2, DB_PATH } = await import("../src/db.js");
const { hashPassword } = await import("../src/util.js");
initSchema();
migrateV2();
assert.equal(DB_PATH, dbPath);
const { createApp } = await import("../src/app.js");

const password = "Invite-Fixture#2026";
const passwordHash = hashPassword(password);
const roles = ["boss", "admin", "manager", "ops_director", "sales", "partner"];
const tenants = { platform: 901, a: 902, b: 903 };
for (const [name, id] of Object.entries(tenants)) {
  db.prepare(
    `INSERT INTO tenants(id,name,status,credits,total_recharged,seat_limit)
    VALUES(?,?,'已开通',10000,0,50)`,
  ).run(id, `邀请验收-${name}`);
}
function addUser(username, role, tenantId) {
  const id = Number(
    db
      .prepare(
        `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES(?,?,?,?,'启用',?)`,
      )
      .run(username, passwordHash, username, role, tenantId).lastInsertRowid,
  );
  return { id, username, role, tenantId };
}
const superUser = addUser("inv_platform", "platform_super", tenants.platform);
const actorsA = Object.fromEntries(
  roles.map((role) => [role, addUser(`inv_a_${role}`, role, tenants.a)]),
);
const bossB = addUser("inv_b_boss", "boss", tenants.b);
const storeA = Number(
  db
    .prepare("INSERT INTO stores(tenant_id,name) VALUES(?,?)")
    .run(tenants.a, "A门店").lastInsertRowid,
);
const storeB = Number(
  db
    .prepare("INSERT INTO stores(tenant_id,name) VALUES(?,?)")
    .run(tenants.b, "B门店").lastInsertRowid,
);
const app = createApp({
  serveStatic: false,
  autoRecoverAvatar: false,
  autoRecoverTextVideo: false,
  autoRecoverWechatDraft: false,
});
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
}).catch(async (error) => {
  globalThis.fetch = nativeFetch;
  await removeTempDirSafely(fixtureDir, { dbPath });
  throw error;
});
base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  globalThis.fetch = nativeFetch;
  await removeTempDirSafely(fixtureDir, { dbPath });
  assert.deepEqual(externalCalls, [], "邀请码管理与注册不能触发供应商调用");
});

async function request(route, { cookie, method = "GET", body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      origin: base,
      "sec-fetch-site": "same-origin",
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
    headers: response.headers,
  };
}
async function login(actor) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: { username: actor.username, password },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const setCookies = result.headers.getSetCookie();
  assert.ok(setCookies.some((value) => /HttpOnly/u.test(value)));
  return {
    cookie: setCookies.map((value) => value.split(";")[0]).join("; "),
    user: result.body.user,
  };
}
const sessions = {
  super: await login(superUser),
  b: await login(bossB),
};
for (const role of roles) sessions[role] = await login(actorsA[role]);
let accountSequence = 0;
const nextUsername = () => `inv_join_${++accountSequence}`;
const account = (extra = {}) => ({
  contactName: "邀请加入者",
  username: nextUsername(),
  password,
  ...extra,
});
const register = (code, extra = {}) =>
  request("/api/auth/register", {
    method: "POST",
    body: account({ inviteCode: code, ...extra }),
  });
const preview = (code) =>
  request("/api/auth/invitations/preview", { method: "POST", body: { code } });
function counts() {
  return {
    users: db.prepare("SELECT COUNT(*) n FROM users").get().n,
    tenants: db.prepare("SELECT COUNT(*) n FROM tenants").get().n,
    credits: db.prepare("SELECT SUM(credits) n FROM tenants").get().n,
    ledger: db.prepare("SELECT COUNT(*) n FROM credit_logs").get().n,
  };
}
function assertInvalid(result) {
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.code, "INVITATION_INVALID");
}
function assertSafePublic(value, secret = "") {
  const serialized = JSON.stringify(value);
  if (secret)
    assert.ok(!serialized.includes(secret), "列表/预览不可返回邀请码原文");
  function walk(item) {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      assert.ok(
        ![
          "code",
          "codeHash",
          "code_hash",
          "token",
          "tokenHash",
          "token_hash",
        ].includes(key),
        `不应公开 ${key}`,
      );
      walk(child);
    }
  }
  walk(value);
}
async function issue(session = sessions.admin, body = {}) {
  const path =
    session === sessions.super
      ? "/api/platform/invitations"
      : "/api/admin/invitations";
  const result = await request(path, {
    cookie: session.cookie,
    method: "POST",
    body: { type: "existing_tenant", role: "sales", maxUses: 1, ...body },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  assert.equal(typeof result.body.code, "string");
  assert.ok(result.body.code.length >= 20, "邀请码应包含足够随机性");
  assert.ok(Number.isSafeInteger(result.body.invitation.id));
  assertSafePublic(result.body.invitation);
  return result.body;
}

test("完整登录Cookie链只允许超管或本企业老板管理员管理邀请码，普通角色和匿名均被拒绝", async () => {
  const invite = await issue();
  for (const route of ["/api/platform/invitations", "/api/admin/invitations"]) {
    assert.equal((await request(route)).status, 401);
    assert.equal(
      (
        await request(route, {
          method: "POST",
          body: { type: "existing_tenant" },
        })
      ).status,
      401,
    );
  }
  for (const role of ["manager", "ops_director", "sales", "partner"]) {
    for (const route of [
      "/api/admin/invitations",
      "/api/platform/invitations",
    ]) {
      for (const options of [
        {},
        { method: "POST", body: { type: "existing_tenant", role: "sales" } },
        { method: "POST", suffix: `/${invite.invitation.id}/revoke`, body: {} },
      ]) {
        assert.equal(
          (
            await request(`${route}${options.suffix || ""}`, {
              ...options,
              cookie: sessions[role].cookie,
            })
          ).status,
          403,
          `${role}: ${route}`,
        );
      }
    }
  }
  for (const role of ["boss", "admin"]) {
    const own = await request("/api/admin/invitations", {
      cookie: sessions[role].cookie,
    });
    assert.equal(own.status, 200);
    assert.ok(Array.isArray(own.body.items));
    assert.ok(Array.isArray(own.body.roles));
    assertSafePublic(own.body, invite.code);
    assert.equal(
      (
        await request("/api/platform/invitations", {
          cookie: sessions[role].cookie,
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await request("/api/platform/invitations", {
        cookie: sessions.super.cookie,
      })
    ).status,
    200,
  );
});

test("企业发码、列表和撤码固定本租户，不能创建新企业、超管角色或跨企业门店", async () => {
  const a = await issue(sessions.boss);
  const b = await issue(sessions.b, { storeId: storeB });
  const before = counts();
  for (const body of [
    { type: "existing_tenant", tenantId: tenants.b, role: "sales" },
    { type: "new_tenant" },
    { type: "existing_tenant", role: "platform_super" },
    { type: "existing_tenant", role: "sales", storeId: storeB },
  ]) {
    const result = await request("/api/admin/invitations", {
      cookie: sessions.admin.cookie,
      method: "POST",
      body,
    });
    assert.ok([400, 403].includes(result.status), JSON.stringify(result.body));
  }
  const own = await request(`/api/admin/invitations?tenantId=${tenants.b}`, {
    cookie: sessions.admin.cookie,
  });
  assert.equal(own.status, 200);
  assert.ok(own.body.items.some((item) => item.id === a.invitation.id));
  assert.ok(!own.body.items.some((item) => item.id === b.invitation.id));
  assertSafePublic(own.body, b.code);
  const crossRevoke = await request(
    `/api/admin/invitations/${b.invitation.id}/revoke`,
    {
      cookie: sessions.admin.cookie,
      method: "POST",
      body: { tenantId: tenants.b },
    },
  );
  assert.ok([403, 404].includes(crossRevoke.status));
  assert.equal((await preview(b.code)).body.valid, true);
  assert.deepEqual(counts(), before);
  assert.equal(
    (
      await request(`/api/admin/invitations/${a.invitation.id}/revoke`, {
        cookie: sessions.admin.cookie,
        method: "POST",
        body: {},
      })
    ).status,
    200,
  );
  assertInvalid(await preview(a.code));
});

test("平台可选择目标企业及六种企业角色，参数边界拒绝不合法次数、角色和日期", async () => {
  for (const role of roles) {
    const invite = await issue(sessions.super, {
      tenantId: tenants.b,
      role,
      maxUses: 50,
    });
    const checked = await preview(invite.code);
    assert.equal(checked.status, 200);
    assert.equal(checked.body.valid, true);
    assert.equal(checked.body.type, "existing_tenant");
    assert.equal(checked.body.tenantName, "邀请验收-b");
    assert.equal(typeof checked.body.roleLabel, "string");
    assertSafePublic(checked.body, invite.code);
    const remaining = Date.parse(checked.body.expiresAt) - Date.now();
    assert.ok(remaining > 6.9 * 86400_000 && remaining <= 7.1 * 86400_000);
  }
  for (const extra of [
    { role: "platform_super" },
    { role: "unknown" },
    { maxUses: 0 },
    { maxUses: 51 },
    { maxUses: 1.5 },
    { expiresAt: "not-a-date" },
    { expiresAt: "2000-01-01T00:00:00Z" },
    { tenantId: 999999 },
    { storeId: storeA },
  ]) {
    const result = await request("/api/platform/invitations", {
      cookie: sessions.super.cookie,
      method: "POST",
      body: {
        type: "existing_tenant",
        tenantId: tenants.b,
        role: "sales",
        ...extra,
      },
    });
    assert.ok(
      result.status >= 400 && result.status < 500,
      JSON.stringify(result.body),
    );
  }
});

test("企业邀请码无company也可立即加入，实际登录身份只取邀请码且无法取得平台接口权限", async () => {
  const invite = await issue(sessions.admin, {
    role: "manager",
    storeId: storeA,
  });
  const username = nextUsername();
  const before = counts();
  const result = await register(invite.code, {
    username,
    role: "platform_super",
    tenantId: tenants.b,
    tenant_id: tenants.b,
    storeId: storeB,
    store_id: storeB,
    credits: 900000,
    modules: ["platform"],
    status: "已开通",
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.canLogin, true);
  const session = await login({ username });
  assert.equal(session.user.role, "manager");
  assert.equal(session.user.tenant.id, tenants.a);
  const me = await request("/api/auth/me", { cookie: session.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.body.storeId, storeA);
  const stored = db
    .prepare("SELECT * FROM users WHERE username=?")
    .get(username);
  assert.equal(stored.role, "manager");
  assert.equal(stored.tenant_id, tenants.a);
  assert.equal(stored.store_id, storeA);
  assert.notEqual(stored.password_hash, password);
  for (const route of [
    "/api/admin/api-config",
    "/api/platform/invitations",
    "/api/admin/invitations",
  ]) {
    assert.equal(
      (await request(route, { cookie: session.cookie })).status,
      403,
      route,
    );
  }
  assert.deepEqual(counts(), { ...before, users: before.users + 1 });
  assertInvalid(await preview(invite.code));
});

test("新企业邀请码固定老板，立即开通5席位且不赠积分、不生成付费套餐或充值记录", async () => {
  const invite = await issue(sessions.super, {
    type: "new_tenant",
    role: "boss",
  });
  const username = nextUsername();
  const before = counts();
  const result = await register(invite.code, {
    username,
    company: "邀请码新企业",
    role: "platform_super",
    tenantId: tenants.a,
    tenant_id: tenants.a,
    credits: 999999,
    grantCredits: 999999,
    seatLimit: 9999,
    plan: "旗舰版",
    plan_code: "paid",
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.canLogin, true);
  const session = await login({ username });
  assert.equal(session.user.role, "boss");
  assert.equal(session.user.tenant.status, "已开通");
  assert.notEqual(session.user.tenant.id, tenants.a);
  const tenant = db
    .prepare("SELECT * FROM tenants WHERE id=?")
    .get(session.user.tenant.id);
  assert.equal(tenant.credits, 0);
  assert.equal(tenant.total_recharged, 0);
  assert.equal(tenant.seat_limit, 5);
  assert.equal(tenant.plan_status, "none");
  assert.equal(tenant.plan_code, null);
  assert.equal(tenant.plan_started_at, null);
  assert.equal(tenant.plan_expires_at, null);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM recharge_orders WHERE tenant_id=?")
      .get(tenant.id).n,
    0,
  );
  assert.equal(
    (await request("/api/admin/api-config", { cookie: session.cookie })).status,
    403,
  );
  assert.deepEqual(counts(), {
    ...before,
    users: before.users + 1,
    tenants: before.tenants + 1,
  });
});

test("无效邀请码不会降级成普通企业申请，无邀请码的原申请仍为待审核零积分", async () => {
  for (const invalid of [
    "not-a-valid-invitation",
    "x".repeat(500),
    { code: "not-a-string" },
  ]) {
    const before = counts();
    assertInvalid(await register(invalid, { company: "不得创建的新企业" }));
    assert.deepEqual(counts(), before);
  }
  const username = nextUsername();
  const result = await request("/api/auth/register", {
    method: "POST",
    body: account({
      username,
      company: "原普通申请企业",
      role: "platform_super",
      credits: 999999,
    }),
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.notEqual(result.body.canLogin, true);
  const stored = db
    .prepare("SELECT * FROM users WHERE username=?")
    .get(username);
  assert.equal(stored.role, "boss");
  const tenant = db
    .prepare("SELECT * FROM tenants WHERE id=?")
    .get(stored.tenant_id);
  assert.equal(tenant.status, "待审核");
  assert.equal(tenant.credits, 0);
});

test("撤销邀请码拒绝注册且不新增用户或企业", async () => {
  const invite = await issue();
  assert.equal(
    (
      await request(`/api/admin/invitations/${invite.invitation.id}/revoke`, {
        cookie: sessions.admin.cookie,
        method: "POST",
        body: {},
      })
    ).status,
    200,
  );
  const before = counts();
  assertInvalid(await preview(invite.code));
  assertInvalid(await register(invite.code, { company: "撤销码不得降级注册" }));
  assert.deepEqual(counts(), before);
});

test("邀请码过期与次数耗尽均在预览和注册中失效，次数严格按成功账户计入", async () => {
  const expired = await issue();
  db.prepare("UPDATE invitations SET expires_at=? WHERE id=?").run(
    "2000-01-01T00:00:00.000Z",
    expired.invitation.id,
  );
  const beforeExpired = counts();
  assertInvalid(await preview(expired.code));
  assertInvalid(await register(expired.code));
  assert.deepEqual(counts(), beforeExpired);
  assert.equal(
    db
      .prepare("SELECT used_count FROM invitations WHERE id=?")
      .get(expired.invitation.id).used_count,
    0,
  );
  const twice = await issue(sessions.admin, { maxUses: 2 });
  assert.equal((await register(twice.code)).status, 200);
  assert.equal((await preview(twice.code)).body.valid, true);
  assert.equal((await register(twice.code)).status, 200);
  assertInvalid(await preview(twice.code));
  const exhaustedCounts = counts();
  assertInvalid(await register(twice.code));
  assert.deepEqual(counts(), exhaustedCounts);
  assert.equal(
    db
      .prepare("SELECT used_count FROM invitations WHERE id=?")
      .get(twice.invitation.id).used_count,
    2,
  );
});

test("单次邀请码并发兑换只有一个账号成功；重复用户名失败不消耗可用次数", async () => {
  const invite = await issue();
  const before = counts();
  const names = [nextUsername(), nextUsername()];
  const results = await Promise.all(
    names.map((username) => register(invite.code, { username })),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
  assertInvalid(results.find((result) => result.status === 400));
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM users WHERE username IN (?,?)")
      .get(...names).n,
    1,
  );
  assert.deepEqual(counts(), { ...before, users: before.users + 1 });
  const duplicateInvite = await issue();
  const duplicate = await register(duplicateInvite.code, {
    username: actorsA.sales.username,
  });
  assert.equal(duplicate.status, 400);
  assert.equal((await preview(duplicateInvite.code)).body.valid, true);
  const accepted = await register(duplicateInvite.code);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assertInvalid(await preview(duplicateInvite.code));
});

test("发码者降权或停用、目标企业停用后，尚未用过的邀请码立即失效", async () => {
  for (const mutation of [
    "role",
    "issuer_status",
    "tenant_status",
    "issuer_tenant",
  ]) {
    const issuer = addUser(`inv_temporary_${mutation}`, "admin", tenants.a);
    const session = await login(issuer);
    const invite = await issue(session);
    const before = counts();
    if (mutation === "role")
      db.prepare("UPDATE users SET role='sales' WHERE id=?").run(issuer.id);
    if (mutation === "issuer_status")
      db.prepare("UPDATE users SET status='停用' WHERE id=?").run(issuer.id);
    if (mutation === "tenant_status")
      db.prepare("UPDATE tenants SET status='已停用' WHERE id=?").run(
        tenants.a,
      );
    if (mutation === "issuer_tenant")
      db.prepare("UPDATE users SET tenant_id=? WHERE id=?").run(
        tenants.b,
        issuer.id,
      );
    try {
      assertInvalid(await preview(invite.code));
      assertInvalid(
        await register(invite.code, { company: "失效码不能另建企业" }),
      );
      assert.deepEqual(counts(), before);
      const management = await request("/api/admin/invitations", {
        cookie: session.cookie,
      });
      if (mutation === "issuer_tenant") {
        assert.equal(management.status, 200);
        assert.ok(
          !management.body.items.some(
            (item) => item.id === invite.invitation.id,
          ),
        );
      } else assert.ok([401, 403].includes(management.status));
    } finally {
      db.prepare("UPDATE tenants SET status='已开通' WHERE id=?").run(
        tenants.a,
      );
    }
  }
});

test("平台发码者失去超管权限后，其新企业码不能继续开通企业", async () => {
  const invite = await issue(sessions.super, {
    type: "new_tenant",
    role: "boss",
  });
  const before = counts();
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(superUser.id);
  try {
    assertInvalid(await preview(invite.code));
    assertInvalid(await register(invite.code, { company: "失去授权不得开通" }));
    assert.deepEqual(counts(), before);
    assert.equal(
      (
        await request("/api/platform/invitations", {
          cookie: sessions.super.cookie,
        })
      ).status,
      403,
    );
  } finally {
    db.prepare("UPDATE users SET role='platform_super' WHERE id=?").run(
      superUser.id,
    );
  }
});

test("席位满时注册整体回滚且不消耗邀请码，扩容后仍能用原码加入", async () => {
  const tenantId = Number(
    db
      .prepare(
        "INSERT INTO tenants(name,status,credits,seat_limit) VALUES(?,'已开通',0,1)",
      )
      .run("席位原子性企业").lastInsertRowid,
  );
  addUser("inv_seat_owner", "boss", tenantId);
  const invite = await issue(sessions.super, { tenantId });
  const before = counts();
  const rejected = await register(invite.code);
  assert.ok(
    rejected.status >= 400 && rejected.status < 500,
    JSON.stringify(rejected.body),
  );
  assert.equal(
    db
      .prepare("SELECT used_count FROM invitations WHERE id=?")
      .get(invite.invitation.id).used_count,
    0,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM invitation_events WHERE invitation_id=? AND event='redeemed'",
      )
      .get(invite.invitation.id).n,
    0,
  );
  assert.deepEqual(counts(), before);
  db.prepare("UPDATE tenants SET seat_limit=2 WHERE id=?").run(tenantId);
  const accepted = await register(invite.code);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(
    db
      .prepare("SELECT used_count FROM invitations WHERE id=?")
      .get(invite.invitation.id).used_count,
    1,
  );
});

test("原始邀请码只在创建响应出现，数据库仅保存SHA256和掩码，列表预览及审计不泄露原码或hash", async () => {
  const invite = await issue();
  const row = db
    .prepare("SELECT * FROM invitations WHERE id=?")
    .get(invite.invitation.id);
  assert.equal(
    row.code_hash,
    createHash("sha256").update(invite.code).digest("hex"),
  );
  assert.match(row.code_hash, /^[a-f0-9]{64}$/u);
  assert.notEqual(row.code_masked, invite.code);
  for (const route of ["/api/admin/invitations", "/api/platform/invitations"]) {
    const list = await request(route, {
      cookie: route.includes("/platform/")
        ? sessions.super.cookie
        : sessions.admin.cookie,
    });
    assert.equal(list.status, 200);
    assertSafePublic(list.body, invite.code);
    assert.ok(!JSON.stringify(list.body).includes(row.code_hash));
  }
  const checked = await preview(invite.code);
  assertSafePublic(checked.body, invite.code);
  assert.ok(!JSON.stringify(checked.body).includes(row.code_hash));
  assert.equal((await register(invite.code)).status, 200);
  for (const table of [
    "invitations",
    "invitation_events",
    "op_logs",
    "login_logs",
    "notifications",
  ]) {
    const serialized = JSON.stringify(
      db.prepare(`SELECT * FROM ${table}`).all(),
    );
    assert.ok(
      !serialized.includes(invite.code),
      `${table} 不应持久化邀请码原文`,
    );
    if (table !== "invitations")
      assert.ok(
        !serialized.includes(row.code_hash),
        `${table} 不应记入邀请码hash`,
      );
  }
  assert.deepEqual(
    db
      .prepare(
        "SELECT event FROM invitation_events WHERE invitation_id=? ORDER BY id",
      )
      .all(invite.invitation.id)
      .map((event) => event.event),
    ["created", "redeemed"],
  );
});
