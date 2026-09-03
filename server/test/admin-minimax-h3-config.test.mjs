import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const nativeFetch = globalThis.fetch;
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const databasePath = path.join(
  os.tmpdir(),
  `nanowork-admin-minimax-h3-${process.pid}.db`,
);
for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`])
  fs.rmSync(file, { force: true });

process.env.NANOWORK_DB = databasePath;
process.env.NANOWORK_TEST_TEMPLATE_AI = "1";
process.env.ENABLE_SCHEDULER = "false";
process.env.YUNWU_API_KEY = "";
process.env.MINIMAX_API_KEY = "";
process.env.NANOWORK_MINIMAX_H3_ENABLED = "0";

const { getConfig, initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const { billing } = await import("../src/engines/credits.js");
const adminRoutes = (await import("../src/routes/admin.js")).default;

initSchema();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,credits)
  VALUES(1,'H3配置测试企业','已开通',10000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status`);
const bossId = Number(
  q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES('h3-config-boss','unused','H3配置负责人','boss','启用',1)`)
    .lastInsertRowid,
);
const boss = q.get(
  "SELECT id,name,username,role,tenant_id FROM users WHERE id=?",
  bossId,
);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) =>
    runWithTenant(1, () => {
      req.user = { ...boss, ip: "127.0.0.1" };
      next();
    }),
  );
  app.use("/admin", adminRoutes);
  return app;
}

async function withServer(fn) {
  const server = makeApp().listen(0, "127.0.0.1");
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function request(base, pathname, method = "GET", body) {
  const response = await nativeFetch(`${base}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, json: await response.json().catch(() => ({})) };
}

test("H3管理配置只暴露密钥存在性，并强制供应商与计价双核验", async () => {
  await withServer(async (base) => {
    let result = await request(base, "/admin/api-config");
    assert.equal(result.response.status, 200);
    assert.equal(result.json.h3.model, "MiniMax-H3");
    assert.equal(result.json.h3.readiness.apiKeyConfigured, false);
    assert.equal(result.json.h3.readiness.deploymentEnabled, false);
    assert.equal(result.json.h3.readiness.ready, false);
    assert.equal(result.json.h3.pricing.pricePer15s768p, 0);

    result = await request(base, "/admin/api-config", "PUT", {
      h3: {
        pricePer15s768p: 9.6,
        providerVerified: true,
        billingVerified: true,
        priceBasis: "测试价目依据",
      },
    });
    assert.equal(result.response.status, 409);
    assert.match(result.json.error, /MINIMAX_API_KEY/);
    assert.deepEqual(getConfig("minimax_h3_capability", {}), {});

    process.env.MINIMAX_API_KEY = "minimax-secret-must-never-leak";
    result = await request(base, "/admin/api-config", "PUT", {
      h3: {
        pricePer15s768p: 0,
        providerVerified: true,
        billingVerified: true,
        priceBasis: "测试价目依据",
      },
    });
    assert.equal(result.response.status, 409);
    assert.match(result.json.error, /大于0/);
    assert.deepEqual(getConfig("minimax_h3_capability", {}), {});

    result = await request(base, "/admin/api-config", "PUT", {
      h3: {
        pricePer15s768p: 9.6,
        providerVerified: true,
        billingVerified: true,
        priceBasis: "",
      },
    });
    assert.equal(result.response.status, 409);
    assert.match(result.json.error, /价格依据/);
    assert.deepEqual(getConfig("minimax_h3_capability", {}), {});

    result = await request(base, "/admin/api-config", "PUT", {
      h3: {
        pricePer15s768p: 9.6,
        providerVerified: true,
        billingVerified: true,
        priceBasis: "MiniMax 官方H3 768P价目与本期结算汇率",
        verifiedAt: "2000-01-01T00:00:00.000Z",
        verifiedBy: 999999,
      },
    });
    assert.equal(result.response.status, 200);
    assert.equal(
      result.json.h3.readiness.ready,
      false,
      "服务端总开关未开时不能伪装为可用",
    );
    assert.equal(result.json.h3.pricing.pricePer15s768p, 9.6);
    assert.equal(result.json.h3.pricing.thirtySecondCost, 19.2);
    assert.equal(billing().video["MiniMax-H3"], 9.6);

    const stored = getConfig("minimax_h3_capability", {});
    assert.equal(stored.providerVerified, true);
    assert.equal(stored.billingVerified, true);
    assert.equal(stored.verifiedBy, bossId, "核验人必须由服务端登录态写入");
    assert.notEqual(stored.verifiedAt, "2000-01-01T00:00:00.000Z");
    assert.equal(stored.priceBasis, "MiniMax 官方H3 768P价目与本期结算汇率");

    result = await request(base, "/admin/api-config", "PUT", {
      billing: {
        ...billing(),
        video: { ...billing().video, "MiniMax-H3": 10.2 },
      },
    });
    assert.equal(result.response.status, 409);
    assert.match(result.json.error, /同时提交 H3 核验信息/);
    assert.equal(billing().video["MiniMax-H3"], 9.6);

    process.env.NANOWORK_MINIMAX_H3_ENABLED = "1";
    result = await request(base, "/admin/api-config");
    assert.equal(result.response.status, 200);
    assert.equal(result.json.h3.readiness.ready, true);
    assert.equal(
      result.json.h3.capability.providerVerifiedAt,
      stored.providerVerifiedAt,
    );
    assert.equal(
      result.json.h3.capability.billingVerifiedAt,
      stored.billingVerifiedAt,
    );
    const serialized = JSON.stringify(result.json);
    assert.doesNotMatch(serialized, /minimax-secret-must-never-leak/);
    assert.equal(Object.hasOwn(result.json.h3, "apiKey"), false);
    assert.equal(Object.hasOwn(result.json.h3.readiness, "apiKey"), false);
  });
});

test("接口管理把联网分层与H3核验拆成独立面板且保留完整配置契约", () => {
  const admin = fs.readFileSync(
    path.join(repoRoot, "web/src/pages/Admin.tsx"),
    "utf8",
  );
  const searchPanel = fs.readFileSync(
    path.join(repoRoot, "web/src/components/AdminWebSearchPanel.tsx"),
    "utf8",
  );
  const h3Panel = fs.readFileSync(
    path.join(repoRoot, "web/src/components/AdminMiniMaxH3Panel.tsx"),
    "utf8",
  );

  assert.match(
    admin,
    /<AdminWebSearchPanel readiness=\{searchReadiness\} onRefresh=\{load\}/u,
  );
  assert.match(
    admin,
    /<AdminMiniMaxH3Panel config=\{cfg\.h3\} value=\{h3\} onChange=\{setH3\}/u,
  );
  assert.doesNotMatch(admin, /title="C · MiniMax H3 上线核验"/u);
  assert.match(searchPanel, /TinyFish 先完成搜索/u);
  assert.match(searchPanel, /\/admin\/web-search\/test/u);
  assert.match(h3Panel, /MINIMAX_API_KEY/u);
  assert.match(h3Panel, /providerVerified/u);
  assert.match(h3Panel, /billingVerified/u);
  assert.match(h3Panel, /pricePer15s768p/u);
  assert.match(h3Panel, /priceBasis/u);
});

after(() => {
  for (const file of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ])
    fs.rmSync(file, { force: true });
});
