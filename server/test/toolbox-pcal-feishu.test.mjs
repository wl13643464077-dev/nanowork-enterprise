import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DB_PATH = path.join(
  os.tmpdir(),
  `nanowork-toolbox-pcal-feishu-${process.pid}.db`,
);
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
  } catch {
    /* fresh isolated database */
  }
}
process.env.NANOWORK_DB = DB_PATH;
process.env.NODE_ENV = "test";
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.FEISHU_APP_ID = "";
process.env.FEISHU_APP_SECRET = "";

const { initSchema, migrateV2, q, runWithTenant, setTenantConfig } =
  await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { hashPassword } = await import("../src/util.js");
const { textModelFor } = await import("../src/engines/yunwu.js");
const {
  TOOLBOX_PCAL_MAX_OUTPUT_TOKENS,
  TOOL_DEFINITIONS,
  generateToolboxRun,
  normalizePrivateCalendar,
} = await import("../src/engines/toolbox.js");
const {
  FEISHU_BITABLE_BATCH_SIZE,
  PRIVATE_CALENDAR_FIELDS,
  parseFeishuBitableUrl,
  syncFeishuBitableRows,
} = await import("../src/engines/feishu-bitable.js");
const { feishuConfig } = await import("../src/engines/feishu.js");
const { recoverStaleFeishuExports } =
  await import("../src/engines/scheduler.js");
const toolboxRoutes = (await import("../src/routes/toolbox.js")).default;

initSchema();
migrateV2();
ensureBaselineCatalogs();

q.run(
  `INSERT INTO tenants(id,name,status,credits) VALUES(2,'飞书隔离租户','已开通',100000)
  ON CONFLICT(id) DO UPDATE SET status=excluded.status,credits=excluded.credits`,
);
q.run("UPDATE tenants SET credits=100000 WHERE id=1");
const userOneId = Number(
  q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES(?,?,?,?,?,?)`,
    `pcal-feishu-one-${process.pid}`,
    hashPassword("Secret123!"),
    "私域日历租户一老板",
    "boss",
    "启用",
    1,
  ).lastInsertRowid,
);
const userTwoId = Number(
  q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES(?,?,?,?,?,?)`,
    `pcal-feishu-two-${process.pid}`,
    hashPassword("Secret123!"),
    "私域日历租户二老板",
    "boss",
    "启用",
    2,
  ).lastInsertRowid,
);
const userOne = {
  id: userOneId,
  name: "私域日历租户一老板",
  role: "boss",
  tenant_id: 1,
};
const userTwo = {
  id: userTwoId,
  name: "私域日历租户二老板",
  role: "boss",
  tenant_id: 2,
};

function calendarFixture(month = "2026-08") {
  const [year, monthNumber] = month.split("-").map(Number);
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    days: Array.from({ length: dayCount }, (_, index) => {
      const day = index + 1;
      return {
        date: `${month}-${String(day).padStart(2, "0")}`,
        weekday: "模型星期将由服务端重算",
        festival: day === 1 ? "测试节点" : "",
        moment: `第${day}天朋友圈文案：围绕已核验的新菜单与会员回店场景，发布前由门店确认当日可售信息。`,
        group:
          day % 7 === 3
            ? `第${day}天社群话术：请群成员留言最关心的菜品信息。`
            : "",
      };
    }),
    tips: "本月以新菜单与老会员回店为主线，每周根据真实咨询、预订和到店数据复盘。",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function appFor(user, options = {}) {
  const app = express();
  Object.assign(app.locals, options);
  app.use(express.json({ limit: "64kb" }));
  app.use((req, _res, next) =>
    runWithTenant(user.tenant_id, () => {
      req.user = user;
      next();
    }),
  );
  app.use("/toolbox", toolboxRoutes);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  return app;
}

async function withServer(user, options, fn) {
  const server = appFor(user, options).listen(0, "127.0.0.1");
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function request(base, url, method = "GET", body) {
  const response = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json().catch(() => ({})) };
}

async function createPcalRun(base, title) {
  const queued = await request(base, "/toolbox/runs", "POST", {
    toolKey: "pcal",
    employeeIdx: 141,
    title,
    inputs: {
      month: "2026-08",
      channels: ["朋友圈", "社群"],
      focus: "新菜单上线与老会员回店",
    },
  });
  assert.equal(queued.response.status, 202, JSON.stringify(queued.body));
  const id = queued.body.run.id;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const detail = await request(base, `/toolbox/runs/${id}`);
    if (["done", "failed"].includes(detail.body?.run?.status)) {
      assert.equal(detail.body.run.status, "done", JSON.stringify(detail.body));
      assert.equal(detail.body.run.canUse, true, JSON.stringify(detail.body));
      return detail.body.run;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("私域日历后台任务超时");
}

const pcalProvider = {
  toolboxAiAvailable: () => true,
  toolboxGenerate: async () => ({
    mode: "api",
    model: textModelFor("boss"),
    text: JSON.stringify(calendarFixture()),
    usage: { inputTokens: 800, outputTokens: 3_200 },
  }),
};

test("私域日历真实模型输出必须是无缺日、无重复的整月结构", async () => {
  const normalized = normalizePrivateCalendar(calendarFixture(), "2026-08");
  assert.equal(normalized.days.length, 31);
  assert.equal(normalized.days[0].date, "2026-08-01");
  assert.equal(normalized.days[0].weekday, "周六");
  assert.equal(normalized.days[6].festival, "立秋");
  assert.equal(normalized.days[30].date, "2026-08-31");

  const missing = calendarFixture();
  missing.days.pop();
  assert.throws(
    () => normalizePrivateCalendar(missing, "2026-08"),
    /完整包含31天/u,
  );
  const duplicate = calendarFixture();
  duplicate.days[30].date = "2026-08-01";
  assert.throws(
    () => normalizePrivateCalendar(duplicate, "2026-08"),
    /非法或重复日期/u,
  );

  let captured;
  const generated = await generateToolboxRun(
    TOOL_DEFINITIONS.pcal,
    {
      month: "2026-08",
      channels: ["朋友圈", "社群"],
      focus: "新菜单上线与老会员回店",
    },
    {
      aiAvailableFn: () => true,
      generateFn: async (args) => {
        captured = args;
        return {
          mode: "api",
          model: "offline-yunwu-calendar-model",
          text: JSON.stringify(calendarFixture()),
          usage: { inputTokens: 100, outputTokens: 500 },
        };
      },
    },
  );
  assert.equal(captured.providerPolicy, "yunwu_only");
  assert.equal(captured.maxTokens, TOOLBOX_PCAL_MAX_OUTPUT_TOKENS);
  assert.equal(generated.provenance.structuredCalendar.days.length, 31);
  assert.match(generated.resultMd, /2026-08-31/u);
  assert.match(generated.resultMd, /朋友圈文案.*社群话术/u);
});

test("飞书多维表格链接严格校验，坏URL不回显token", () => {
  assert.equal(
    parseFeishuBitableUrl(
      "https://demo.feishu.cn/base/Bascn1234567890ABCDE?table=tbl123&view=vew456",
    ).appToken,
    "Bascn1234567890ABCDE",
  );
  assert.equal(
    parseFeishuBitableUrl(
      "https://demo.larksuite.com/wiki/Wikcn1234567890ABCDE",
    ).linkKind,
    "wiki",
  );
  const secret = "Bascn1234567890SUPERSECRET";
  for (const url of [
    `http://demo.feishu.cn/base/${secret}`,
    `https://evil.example/base/${secret}`,
    `https://demo.feishu.cn/base/${secret}?token=leak-me`,
    `https://user:pass@demo.feishu.cn/base/${secret}`,
  ]) {
    assert.throws(
      () => parseFeishuBitableUrl(url),
      (error) =>
        error.status === 400 &&
        !error.message.includes(secret) &&
        !error.message.includes("leak-me") &&
        !error.message.includes("pass"),
    );
  }
});

test("飞书引擎支持已有表/新建表与100条分批，全程离线注入", async () => {
  const calls = [];
  const fields = ["日期", "星期"];
  const records = Array.from({ length: 205 }, (_, index) => ({
    日期: `2026-01-${String((index % 31) + 1).padStart(2, "0")}`,
    星期: `第${index + 1}条`,
  }));
  const existingFetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/tables?")) {
      return jsonResponse({
        code: 0,
        data: { items: [{ name: "私域日历2026-01", table_id: "tblExisting" }] },
      });
    }
    return jsonResponse({ code: 0, data: {} });
  };
  const existing = await syncFeishuBitableRows({
    bitableUrl: "https://demo.feishu.cn/base/Bascn1234567890ABCDE",
    tableName: "私域日历2026-01",
    fields,
    records,
    tokenFn: async () => "tenant-token-not-returned",
    fetchFn: existingFetch,
  });
  assert.deepEqual(existing, {
    table: "私域日历2026-01",
    tableId: "tblExisting",
    created: false,
    synced: 205,
  });
  const batches = calls.filter((call) =>
    call.url.includes("records/batch_create"),
  );
  assert.equal(FEISHU_BITABLE_BATCH_SIZE, 100);
  assert.deepEqual(
    batches.map((call) => JSON.parse(call.init.body).records.length),
    [100, 100, 5],
  );
  assert.ok(
    calls.every(
      (call) =>
        call.init.headers?.Authorization === "Bearer tenant-token-not-returned",
    ),
  );

  const createCalls = [];
  const created = await syncFeishuBitableRows({
    bitableUrl: "https://demo.feishu.cn/base/Bascn1234567890ABCDE",
    tableName: "私域日历2026-02",
    fields: [...PRIVATE_CALENDAR_FIELDS],
    records: [
      Object.fromEntries(
        PRIVATE_CALENDAR_FIELDS.map((field) => [field, field]),
      ),
    ],
    tokenFn: async () => "tenant-token-not-returned",
    fetchFn: async (url, init = {}) => {
      createCalls.push({ url: String(url), init });
      if (String(url).includes("/tables?")) {
        return jsonResponse({ code: 0, data: { items: [] } });
      }
      if (
        String(url).endsWith("/tables") &&
        String(init.method).toUpperCase() === "POST"
      ) {
        return jsonResponse({ code: 0, data: { table_id: "tblCreated" } });
      }
      return jsonResponse({ code: 0, data: {} });
    },
  });
  assert.equal(created.created, true);
  assert.equal(created.tableId, "tblCreated");
  const createBody = JSON.parse(
    createCalls.find(
      (call) => call.url.endsWith("/tables") && call.init.method === "POST",
    ).init.body,
  );
  assert.deepEqual(
    createBody.table.fields.map((field) => field.field_name),
    [...PRIVATE_CALENDAR_FIELDS],
  );
});

test("飞书供应商失败仅返回固定脱敏错误", async () => {
  const providerSecret = "provider-secret-response-body";
  await assert.rejects(
    syncFeishuBitableRows({
      bitableUrl: "https://demo.feishu.cn/base/Bascn1234567890ABCDE",
      tableName: "私域日历2026-08",
      fields: ["日期"],
      records: [{ 日期: "2026-08-01" }],
      tokenFn: async () => "tenant-secret-token",
      fetchFn: async () =>
        jsonResponse({ code: 999, msg: providerSecret }, 200),
    }),
    (error) =>
      error.code === "FEISHU_BITABLE_PROVIDER_FAILED" &&
      !error.message.includes(providerSecret) &&
      !error.message.includes("tenant-secret-token") &&
      !error.message.includes("Bascn1234567890ABCDE"),
  );
});

test("部署级飞书凭据只兼容总部租户，不能隐式借给其他企业", () => {
  const previousId = process.env.FEISHU_APP_ID;
  const previousSecret = process.env.FEISHU_APP_SECRET;
  process.env.FEISHU_APP_ID = "headquarters-app";
  process.env.FEISHU_APP_SECRET = "headquarters-secret";
  try {
    setTenantConfig(
      "feishu",
      { bitableUrl: "https://demo.feishu.cn/base/TenantTwo" },
      2,
    );
    assert.equal(feishuConfig(1).appId, "headquarters-app");
    assert.equal(feishuConfig(1).appSecret, "headquarters-secret");
    assert.equal(feishuConfig(2).appId, "");
    assert.equal(feishuConfig(2).appSecret, "");
  } finally {
    process.env.FEISHU_APP_ID = previousId || "";
    process.env.FEISHU_APP_SECRET = previousSecret || "";
  }
});

test("飞书分批部分成功后按日期幂等续写，不重复追加已落地记录", async () => {
  const remote = new Map();
  let createCalls = 0;
  let failSecondCreate = true;
  const records = Array.from({ length: 205 }, (_, index) => ({
    日期: `row-${String(index + 1).padStart(3, "0")}`,
    星期: `第${index + 1}条`,
  }));
  const fetchFn = async (url, init = {}) => {
    const href = String(url);
    if (href.includes("/tables?")) {
      return jsonResponse({
        code: 0,
        data: { items: [{ name: "幂等续写", table_id: "tblRetry" }] },
      });
    }
    if (href.includes("/records?") && !href.includes("batch_")) {
      return jsonResponse({
        code: 0,
        data: {
          items: [...remote.entries()].map(([key, value]) => ({
            record_id: value.recordId,
            fields: { ...value.fields, 日期: key },
          })),
          has_more: false,
        },
      });
    }
    if (href.includes("/records/batch_update")) {
      const body = JSON.parse(String(init.body || "{}"));
      for (const item of body.records || []) {
        const key = String(item.fields?.日期 || "");
        remote.set(key, { recordId: item.record_id, fields: item.fields });
      }
      return jsonResponse({ code: 0, data: {} });
    }
    if (href.includes("/records/batch_create")) {
      createCalls += 1;
      if (failSecondCreate && createCalls === 2) {
        return jsonResponse({ code: 105, msg: "partial failure" });
      }
      const body = JSON.parse(String(init.body || "{}"));
      for (const item of body.records || []) {
        const key = String(item.fields?.日期 || "");
        remote.set(key, {
          recordId: `rec-${key}`,
          fields: item.fields,
        });
      }
      return jsonResponse({ code: 0, data: {} });
    }
    return jsonResponse({ code: 0, data: {} });
  };

  await assert.rejects(
    syncFeishuBitableRows({
      bitableUrl: "https://demo.feishu.cn/base/Bascn1234567890ABCDE",
      tableName: "幂等续写",
      fields: ["日期", "星期"],
      records,
      idempotencyField: "日期",
      tokenFn: async () => "tenant-token",
      fetchFn,
    }),
    (error) => error.code === "FEISHU_BITABLE_PROVIDER_FAILED",
  );
  assert.equal(remote.size, 100, "第一批已在外部落地");

  failSecondCreate = false;
  const retried = await syncFeishuBitableRows({
    bitableUrl: "https://demo.feishu.cn/base/Bascn1234567890ABCDE",
    tableName: "幂等续写",
    fields: ["日期", "星期"],
    records,
    idempotencyField: "日期",
    tokenFn: async () => "tenant-token",
    fetchFn,
  });
  assert.equal(retried.synced, 205);
  assert.equal(remote.size, 205, "重试只能补齐缺失记录，不能重复追加前100条");
});

test("崩溃遗留的飞书 syncing 锁会安全关闭并允许幂等人工重试", () => {
  const runId = 9_000_000 + process.pid;
  q.run(
    `INSERT INTO tool_run_feishu_exports(
      tenant_id,run_id,status,table_name,created_by,updated_at
    ) VALUES(?,?,'syncing',?,?,?)`,
    1,
    runId,
    "私域日历2026-08",
    userOneId,
    "2026-08-08 00:00:00",
  );
  const recovered = runWithTenant(1, () =>
    recoverStaleFeishuExports(new Date("2026-08-08T08:30:00.000Z")),
  );
  assert.equal(recovered.length, 1);
  const row = q.get(
    `SELECT status,error_json FROM tool_run_feishu_exports
    WHERE tenant_id=1 AND run_id=?`,
    runId,
  );
  assert.equal(row.status, "failed");
  const error = JSON.parse(row.error_json);
  assert.equal(error.code, "FEISHU_EXPORT_STALE");
  assert.equal(JSON.stringify(error).includes("https://"), false);
  assert.equal(JSON.stringify(error).includes("token"), false);
});

test("POST /toolbox/runs/:id/feishu 租户隔离、幂等、失败可重试且不额外扣积分", async () => {
  const goodUrl = "https://demo.feishu.cn/base/Bascn1234567890ABCDE";
  setTenantConfig("feishu", { bitableUrl: goodUrl }, 1);
  let providerMode = "success";
  let externalCalls = 0;
  const feishuFetch = async (url) => {
    externalCalls += 1;
    if (String(url).includes("/tables?")) {
      return jsonResponse({
        code: 0,
        data: {
          items: [{ name: "私域日历2026-08", table_id: "tblPrivateCalendar" }],
        },
      });
    }
    if (providerMode === "fail") {
      return jsonResponse({ code: 40123, msg: "provider-secret-leak" });
    }
    return jsonResponse({ code: 0, data: {} });
  };
  const options = {
    ...pcalProvider,
    toolboxFeishuToken: async ({ tenantId }) => {
      assert.equal(tenantId, 1);
      return "tenant-one-token";
    },
    toolboxFeishuFetch: feishuFetch,
  };

  let successfulRun;
  let retryRun;
  let credentialsRun;
  let badUrlRun;
  await withServer(userOne, options, async (base) => {
    successfulRun = await createPcalRun(base, "私域日历飞书幂等测试");
    assert.equal(successfulRun.provenance.structuredCalendar.days.length, 31);
    const logsBefore = Number(
      q.get("SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=1").n,
    );
    const first = await request(
      base,
      `/toolbox/runs/${successfulRun.id}/feishu`,
      "POST",
      {},
    );
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.idempotent, false);
    assert.equal(first.body.feishuExport.status, "done");
    assert.equal(first.body.feishuExport.synced, 31);
    assert.equal(
      JSON.stringify(first.body).includes("tenant-one-token"),
      false,
    );
    assert.equal(
      JSON.stringify(first.body).includes("Bascn1234567890ABCDE"),
      false,
    );
    const callsAfterFirst = externalCalls;

    const second = await request(
      base,
      `/toolbox/runs/${successfulRun.id}/feishu`,
      "POST",
      {},
    );
    assert.equal(second.response.status, 200);
    assert.equal(second.body.idempotent, true);
    assert.equal(externalCalls, callsAfterFirst, "幂等命中不得再请求飞书");
    const logsAfter = Number(
      q.get("SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=1").n,
    );
    assert.equal(logsAfter, logsBefore, "飞书导出不得新增积分扣款");

    retryRun = await createPcalRun(base, "私域日历飞书失败重试测试");
    providerMode = "fail";
    const failed = await request(
      base,
      `/toolbox/runs/${retryRun.id}/feishu`,
      "POST",
      {},
    );
    assert.equal(failed.response.status, 502);
    assert.equal(failed.body.feishuExport.status, "failed");
    assert.equal(
      JSON.stringify(failed.body).includes("provider-secret-leak"),
      false,
    );
    providerMode = "success";
    const retried = await request(
      base,
      `/toolbox/runs/${retryRun.id}/feishu`,
      "POST",
      {},
    );
    assert.equal(retried.response.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.feishuExport.status, "done");
    assert.equal(retried.body.feishuExport.attemptCount, 2);

    credentialsRun = await createPcalRun(base, "私域日历飞书凭据测试");
    badUrlRun = await createPcalRun(base, "私域日历飞书坏链接测试");
  });

  await withServer(userTwo, {}, async (base) => {
    const cross = await request(
      base,
      `/toolbox/runs/${successfulRun.id}/feishu`,
      "POST",
      {},
    );
    assert.equal(cross.response.status, 404);
    assert.equal(
      q.get(
        "SELECT COUNT(*) n FROM tool_run_feishu_exports WHERE tenant_id=2 AND run_id=?",
        successfulRun.id,
      ).n,
      0,
    );
  });

  setTenantConfig("feishu", { bitableUrl: goodUrl }, 1);
  await withServer(userOne, pcalProvider, async (base) => {
    const credentials = await request(
      base,
      `/toolbox/runs/${credentialsRun.id}/feishu`,
      "POST",
      {},
    );
    assert.equal(credentials.response.status, 400);
    assert.equal(credentials.body.code, "FEISHU_CREDENTIALS_NOT_CONFIGURED");
    assert.equal(credentials.body.feishuExport.status, "failed");
    assert.equal(JSON.stringify(credentials.body).includes("Secret"), false);
  });

  const badToken = "Bascn1234567890BADSECRET";
  setTenantConfig(
    "feishu",
    { bitableUrl: `https://evil.example/base/${badToken}?token=leak-me` },
    1,
  );
  await withServer(userOne, options, async (base) => {
    const bad = await request(
      base,
      `/toolbox/runs/${badUrlRun.id}/feishu`,
      "POST",
      {},
    );
    assert.equal(bad.response.status, 400);
    assert.equal(JSON.stringify(bad.body).includes(badToken), false);
    assert.equal(JSON.stringify(bad.body).includes("leak-me"), false);
  });
});

test("私域日历只编辑moment/group，版本化保存且飞书导出使用最新编辑版本", async () => {
  const goodUrl = "https://demo.feishu.cn/base/Bascn1234567890ABCDE";
  setTenantConfig("feishu", { bitableUrl: goodUrl }, 1);
  const writtenRows = [];
  const options = {
    ...pcalProvider,
    toolboxFeishuToken: async () => "tenant-one-token",
    toolboxFeishuFetch: async (url, init = {}) => {
      if (String(url).includes("/tables?")) {
        return jsonResponse({
          code: 0,
          data: {
            items: [{ name: "私域日历2026-08", table_id: "tblEdited" }],
          },
        });
      }
      if (String(url).includes("/records/batch_create")) {
        const body = JSON.parse(String(init.body || "{}"));
        writtenRows.push(...(body.records || []));
      }
      return jsonResponse({ code: 0, data: {} });
    },
  };

  let runId;
  await withServer(userOne, options, async (base) => {
    const run = await createPcalRun(base, "私域日历编辑版本测试");
    runId = run.id;
    assert.equal(run.pcalEditVersion, 0);
    assert.equal(run.pcalCalendar.days.length, 31);
    const originalMoment = run.provenance.structuredCalendar.days[0].moment;
    const logsBefore = Number(
      q.get("SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=1").n,
    );

    const immutable = await request(
      base,
      `/toolbox/runs/${run.id}/pcal`,
      "PUT",
      {
        expectedVersion: 0,
        days: [
          {
            date: "2026-08-01",
            weekday: "周一",
            moment: "不得修改星期",
          },
        ],
      },
    );
    assert.equal(immutable.response.status, 400);

    const controlCharacter = await request(
      base,
      `/toolbox/runs/${run.id}/pcal`,
      "PUT",
      {
        expectedVersion: 0,
        days: [{ date: "2026-08-01", moment: "正常文案\u0000隐藏内容" }],
      },
    );
    assert.equal(controlCharacter.response.status, 400);
    assert.match(controlCharacter.body.error, /控制字符/u);

    const firstEdit = await request(
      base,
      `/toolbox/runs/${run.id}/pcal`,
      "PUT",
      {
        expectedVersion: 0,
        days: [
          {
            date: "2026-08-01",
            moment: "编辑版朋友圈：今晚发布前核验新菜单、价格与库存。",
            group: "编辑版社群：请回复想了解的菜品，门店确认后再答复。",
          },
        ],
      },
    );
    assert.equal(
      firstEdit.response.status,
      200,
      JSON.stringify(firstEdit.body),
    );
    assert.equal(firstEdit.body.run.pcalEditVersion, 1);
    assert.match(
      firstEdit.body.run.pcalCalendar.days[0].moment,
      /编辑版朋友圈/u,
    );
    assert.equal(
      firstEdit.body.run.provenance.structuredCalendar.days[0].moment,
      originalMoment,
      "人工编辑不得覆盖原始模型provenance",
    );
    assert.equal(
      Number(q.get("SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=1").n),
      logsBefore,
      "编辑不得联网或新增积分记录",
    );

    const stale = await request(base, `/toolbox/runs/${run.id}/pcal`, "PUT", {
      expectedVersion: 0,
      days: [{ date: "2026-08-02", moment: "过期会话" }],
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.code, "PCAL_EDIT_VERSION_CONFLICT");

    const exported = await request(
      base,
      `/toolbox/runs/${run.id}/feishu`,
      "POST",
      {},
    );
    assert.equal(exported.response.status, 200, JSON.stringify(exported.body));
    assert.equal(exported.body.feishuExport.calendarVersion, 1);
    assert.equal(exported.body.feishuExport.exportVersion, 1);
    assert.equal(exported.body.feishuExport.outdated, false);
    assert.match(JSON.stringify(writtenRows), /编辑版朋友圈/u);

    const secondEdit = await request(
      base,
      `/toolbox/runs/${run.id}/pcal`,
      "PUT",
      {
        expectedVersion: 1,
        days: [
          {
            date: "2026-08-02",
            moment: "第二版朋友圈：根据真实咨询更新表达。",
          },
        ],
      },
    );
    assert.equal(secondEdit.response.status, 200);
    assert.equal(secondEdit.body.run.pcalEditVersion, 2);
    assert.equal(secondEdit.body.run.feishuExport.outdated, true);

    const reExported = await request(
      base,
      `/toolbox/runs/${run.id}/feishu`,
      "POST",
      {},
    );
    assert.equal(
      reExported.response.status,
      200,
      JSON.stringify(reExported.body),
    );
    assert.equal(reExported.body.idempotent, false);
    assert.equal(reExported.body.feishuExport.calendarVersion, 2);
    assert.equal(reExported.body.feishuExport.exportVersion, 2);
    assert.equal(reExported.body.feishuExport.outdated, false);
  });

  await withServer(userTwo, {}, async (base) => {
    const crossTenant = await request(
      base,
      `/toolbox/runs/${runId}/pcal`,
      "PUT",
      {
        expectedVersion: 0,
        days: [{ date: "2026-08-01", moment: "越权修改" }],
      },
    );
    assert.equal(crossTenant.response.status, 404);
  });
});

test("工具箱UI仅对可用私域日历提供飞书导出、幂等与重试状态", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "web/src/pages/Toolbox.tsx"),
    "utf8",
  );
  assert.match(source, /viewRun\.toolKey === 'pcal' && viewRun\.canUse/u);
  assert.match(
    source,
    /api\.post\(`\/toolbox\/runs\/\$\{run\.id\}\/feishu`,\s*\{\}\)/u,
  );
  assert.match(source, /同步到飞书多维表格/u);
  assert.match(source, /重试同步飞书多维表格/u);
  assert.match(source, /重复点击不会重复写入/u);
  assert.match(source, /未产生额外积分扣款/u);
  assert.match(source, /编辑朋友圈\/社群话术/u);
  assert.match(source, /日历已更新，重新同步飞书/u);
  assert.match(source, /api\.put\(`\/toolbox\/runs\/\$\{run\.id\}\/pcal`/u);
});
