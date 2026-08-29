import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createProbeClient,
  parseArgs,
  renderCliSummary,
  renderMarkdown,
  runConfiguredProbe,
  selectRoutes,
  writeReports,
} from "../../scripts/run-full-api-probe.mjs";

test("CLI 支持 GET/WRITE、环境凭据和显式输出路径", () => {
  const get = parseArgs(
    [
      "--mode",
      "GET",
      "--base-url",
      "http://127.0.0.1:3107/",
      "--out-json",
      "artifacts/qa-get.json",
      "--out-md",
      "artifacts/qa-get.md",
    ],
    {
      NANOWORK_PROBE_USERNAME: "qa-user",
      NANOWORK_PROBE_PASSWORD: "qa-password",
    },
  );
  assert.equal(get.mode, "get");
  assert.equal(get.baseUrl, "http://127.0.0.1:3107");
  assert.equal(get.username, "qa-user");
  assert.equal(get.password, "qa-password");
  assert.match(get.outJson, /artifacts\/qa-get\.json$/u);

  const write = parseArgs([
    "--mode",
    "write",
    "--username",
    "qa-user",
    "--password",
    "qa-password",
    "--allow-write",
    "--isolated-marker",
    "isolated test clone",
  ]);
  assert.equal(write.mode, "write");
  assert.equal(write.allowWrite, true);
  assert.match(write.isolatedMarker, /isolated/u);
});

test("WRITE 模式缺少双重安全门时立即拒绝，不发任何请求", () => {
  assert.throws(
    () => parseArgs(["--mode", "write", "--username", "u", "--password", "p"]),
    /--allow-write/u,
  );
  assert.throws(
    () =>
      parseArgs([
        "--mode",
        "write",
        "--username",
        "u",
        "--password",
        "p",
        "--allow-write",
      ]),
    /--isolated-marker/u,
  );
  assert.throws(
    () =>
      parseArgs([
        "--mode",
        "write",
        "--username",
        "u",
        "--password",
        "p",
        "--allow-write",
        "--isolated-marker",
        "main production",
      ]),
    /isolated/u,
  );
  assert.throws(
    () =>
      parseArgs([
        "--mode",
        "get",
        "--username",
        "u",
        "--password",
        "p",
        "--base-url",
        "http://admin:secret@127.0.0.1:3107",
      ]),
    /不得包含账号或密码/u,
  );
  assert.throws(
    () =>
      parseArgs([
        "--mode",
        "get",
        "--username",
        "u",
        "--password",
        "p",
        "--base-url",
        "http://127.0.0.1:3107/?token=BASE_SECRET_123456",
      ]),
    /不得包含查询参数或片段/u,
  );
  assert.throws(
    () =>
      parseArgs([
        "--mode",
        "get",
        "--username",
        "u",
        "--password",
        "p",
        "--base-url",
        "http://127.0.0.1:3107/#secret",
      ]),
    /不得包含查询参数或片段/u,
  );
  assert.throws(
    () =>
      parseArgs([
        "--mode",
        "get",
        "--username",
        "u",
        "--password",
        "p",
        "--out-json",
        "artifacts/same-output",
        "--out-md",
        "artifacts/same-output",
      ]),
    /必须是不同文件/u,
  );
});

test("CLI 帮助优先推荐环境变量，不把密码参数示例放进命令行", async () => {
  const { usage } = await import("../../scripts/run-full-api-probe.mjs");
  const help = usage();
  assert.match(help, /NANOWORK_PROBE_PASSWORD/u);
  assert.doesNotMatch(help, /--password PASS/u);
  assert.match(help, /避免进入 shell history/u);
});

test("HTTP 客户端用运行时用户名密码登录，报告侧只传递脱敏会话元数据", async () => {
  const calls = [];
  const config = parseArgs([
    "--mode",
    "get",
    "--base-url",
    "http://probe.invalid",
    "--username",
    "qa-user",
    "--password",
    "qa-password",
  ]);
  const client = createProbeClient(config, async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/api/auth/login")) {
      return new Response(
        JSON.stringify({
          token: "secret-session-token",
          user: { role: "boss", tenant: { id: 7 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const session = await client.login();
  assert.deepEqual(session, {
    token: "secret-session-token",
    role: "boss",
    tenantId: 7,
  });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    username: "qa-user",
    password: "qa-password",
  });
  const response = await client.request({
    method: "GET",
    url: "http://probe.invalid/api/auth/me",
    token: session.token,
  });
  assert.equal(response.status, 200);
  assert.equal(
    calls[1].init.headers.authorization,
    "Bearer secret-session-token",
  );
});

test("模式筛选去重，GET 与 WRITE 不会串线", () => {
  const routes = [
    { method: "GET", path: "/api/a" },
    { method: "GET", path: "/api/a" },
    { method: "POST", path: "/api/a" },
    { method: "PUT", path: "/api/b" },
  ];
  assert.deepEqual(
    selectRoutes(routes, "get").map((row) => `${row.method} ${row.path}`),
    ["GET /api/a"],
  );
  assert.deepEqual(
    selectRoutes(routes, "write").map((row) => `${row.method} ${row.path}`),
    ["POST /api/a", "PUT /api/b"],
  );
});

test("WRITE CLI 复用探针库：每个写接口独立会话，外部动作不发送", async () => {
  let loginCount = 0;
  const calls = [];
  const config = parseArgs([
    "--mode",
    "write",
    "--username",
    "qa-user",
    "--password",
    "qa-password",
    "--allow-write",
    "--isolated-marker",
    "isolated cli test clone",
  ]);
  const report = await runConfiguredProbe(config, {
    routes: [
      { method: "POST", path: "/api/auth/logout" },
      { method: "POST", path: "/api/growth/leads" },
      { method: "POST", path: "/api/recharge/notify/wechat" },
    ],
    client: {
      login: async () => ({
        token: `token-${++loginCount}`,
        role: "boss",
        tenantId: 1,
      }),
      request: async ({ route, token }) => {
        calls.push({ route, token });
        if (route === "/api/auth/logout") {
          return {
            status: 200,
            contentType: "application/json",
            rawBody: '{"ok":true}',
          };
        }
        return {
          status: 400,
          contentType: "application/json",
          rawBody: '{"error":"客户姓名必填"}',
        };
      },
    },
  });

  assert.equal(loginCount, 2);
  assert.deepEqual(
    calls.map((call) => call.token),
    ["token-1", "token-2"],
  );
  assert.equal(report.summary.happyPathPass, 1);
  assert.equal(report.summary.negativeBoundaryPass, 1);
  assert.equal(report.summary.safetyNotExecuted, 1);
  assert.equal(report.summary.invalidHarness, 0);
  assert.equal(report.results[1].quality.happyPathPass, false);
  assert.equal(report.results[2].output, null);
  assert.equal(report.invocation.passwordRecorded, false);
  assert.doesNotMatch(JSON.stringify(report), /qa-password/u);
});

test("Markdown/CLI 分开边界与正向结果，并把失败限定为本轮接口探针", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "nanowork-probe-cli-test-"),
  );
  const config = {
    mode: "write",
    outJson: path.join(temporary, "report.json"),
    outMd: path.join(temporary, "report.md"),
  };
  const report = {
    schemaVersion: "nanowork.http-feature-probe.v2",
    summary: {
      total: 4,
      happyPathPass: 1,
      negativeBoundaryPass: 1,
      safetyNotExecuted: 0,
      unverified: 1,
      invalidHarness: 0,
      generatedAt: "2026-08-21T00:00:00.000Z",
      base: "http://127.0.0.1:3112",
      dbMarker: "isolated test clone",
    },
    results: [
      {
        id: "api:POST:/api/auth/logout",
        route: "/api/auth/logout",
        input: { method: "POST" },
        output: { status: 200 },
        quality: {
          verdict: "HAPPY_PATH_PASS",
          happyPathPass: true,
          reachedTargetHandler: true,
          coverageClass: "正向功能通过",
          score: 100,
        },
      },
      {
        id: "api:POST:/api/growth/leads",
        route: "/api/growth/leads",
        input: { method: "POST", body: {} },
        output: { status: 400, bodyPreview: "客户姓名必填" },
        quality: {
          verdict: "NEGATIVE_BOUNDARY_PASS",
          happyPathPass: false,
          reachedTargetHandler: true,
          coverageClass: "参数校验反例通过",
          score: 85,
        },
      },
      {
        id: "api:POST:/api/sys/notifications/read",
        route: "/api/sys/notifications/read",
        input: { method: "POST", intent: "validation_boundary", body: {} },
        output: { status: 200, bodyPreview: "JSON 对象；字段：ok" },
        quality: {
          verdict: "UNVERIFIED",
          happyPathPass: false,
          reachedTargetHandler: true,
          coverageClass: "尚未验证",
          score: 25,
        },
      },
      {
        id: "api:POST:/api/example",
        route: "/api/example",
        input: { method: "POST", intent: "happy_path", body: {} },
        output: { status: 503, bodyPreview: "错误：上游暂时不可用" },
        quality: {
          verdict: "PRODUCT_SERVER_FAILURE",
          happyPathPass: false,
          reachedTargetHandler: true,
          coverageClass: "产品失败",
          score: 0,
        },
      },
    ],
  };
  const markdown = renderMarkdown(report, config);
  assert.match(markdown, /正向功能通过：1/u);
  assert.match(
    markdown,
    /负向边界通过：1（只证明权限\/参数\/不存在资源边界，不计入正向通过）/u,
  );
  assert.match(markdown, /尚未验证：1/u);
  assert.match(markdown, /接口探针失败：1（仅指本轮 HTTP 接口探针）/u);
  assert.match(
    markdown,
    /只覆盖本轮 HTTP 接口探针；不代表完整业务流程、数字员工真实交付或外部供应商的全局状态/u,
  );
  assert.doesNotMatch(markdown, /产品失败/u);
  const negativeRow = markdown
    .split("\n")
    .find((line) => line.includes("api:POST:/api/growth/leads"));
  assert.match(negativeRow, /负向边界通过（不代表正向功能通过）/u);
  assert.match(negativeRow, /"happyPathPass":false/u);
  const unverifiedRow = markdown
    .split("\n")
    .find((line) => line.includes("api:POST:/api/sys/notifications/read"));
  assert.match(unverifiedRow, /尚未验证（2xx 未证明目标意图）/u);
  const failureRow = markdown
    .split("\n")
    .find((line) => line.includes("api:POST:/api/example"));
  assert.match(failureRow, /接口探针发现服务端失败/u);

  const getMarkdown = renderMarkdown(report, { ...config, mode: "get" });
  assert.match(getMarkdown, /接口探针失败：1（仅指本轮 HTTP 接口探针）/u);
  assert.match(
    getMarkdown,
    /不代表完整业务流程、数字员工真实交付或外部供应商的全局状态/u,
  );
  assert.doesNotMatch(getMarkdown, /产品失败/u);

  const cli = renderCliSummary(report, config);
  assert.match(cli, /probe_failures=1/u);
  assert.match(cli, /scope=current_http_probe_only/u);
  assert.match(
    cli,
    /excludes=business_flows,digital_employees,external_providers/u,
  );
  assert.doesNotMatch(cli, /product_failures=/u);

  writeReports(report, config);
  assert.deepEqual(JSON.parse(fs.readFileSync(config.outJson, "utf8")), report);
  assert.equal(fs.readFileSync(config.outMd, "utf8"), markdown);
});
