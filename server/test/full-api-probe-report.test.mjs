import test from "node:test";
import assert from "node:assert/strict";

import {
  apiRoutes,
  classifySurface,
} from "../../scripts/build-full-feature-inventory.mjs";
import {
  classifyProbeOutcome,
  resolveProbeFixture,
  runProbeBatch,
  summarizeProbeResponse,
} from "../../scripts/lib/full-api-probe.mjs";

test("API 清单严格按 createApp 的真实 mount 参数归属路由", () => {
  const routes = apiRoutes();
  const keys = new Set(routes.map((row) => `${row.method} ${row.path}`));

  assert.ok(keys.has("GET /api/avatar/meta"));
  assert.ok(keys.has("GET /api/avatar/jobs"));
  assert.ok(keys.has("GET /api/avatar/provider-assets/:token"));
  assert.ok(keys.has("GET /api/health"));
  assert.ok(keys.has("GET /api/public/calendar.ics"));
  assert.ok(keys.has("GET /api/public/feishu/oauth/callback"));
  assert.ok(keys.has("GET /api/content/crew"));
  assert.ok(keys.has("GET /api/content/pipelines"));
  assert.ok(keys.has("GET /api/content/pipeline-schedules"));
  assert.ok(keys.has("GET /api/content/media-jobs/:id"));
  assert.ok(keys.has("GET /api/employee-workbench/content/:idx"));
  assert.ok(keys.has("GET /api/employee-workbench/restaurant/:idx"));

  assert.equal(keys.has("GET /api/avatar/stats"), false);
  assert.equal(keys.has("GET /api/avatar/calendar-sync"), false);
  assert.equal(keys.has("GET /api/content/runs"), false);
  assert.equal(
    keys.has("GET /api/employee-workbench/content/restaurant/:idx"),
    false,
  );
});

test("API 清单不因后续 app.use 串线产生重复或伪造 mount", () => {
  const routes = apiRoutes();
  const keys = routes.map((row) => `${row.method} ${row.path}`);
  assert.equal(keys.length, new Set(keys).size);
  assert.equal(
    routes.some(
      (row) =>
        row.path.startsWith("/api/avatar/") &&
        row.sourceFile === "server/src/routes/activities.js",
    ),
    false,
  );
  assert.equal(
    routes.some(
      (row) =>
        row.path.startsWith("/api/employee-workbench/content/restaurant/") &&
        row.sourceFile === "server/src/routes/employee-workbench.js",
    ),
    false,
  );
});

test("GET 探针按接口契约填写钻取、来源、任务和业务流参数", () => {
  assert.equal(
    resolveProbeFixture({ method: "GET", path: "/api/marshals/drill/:kind" })
      .urlPath,
    "/api/marshals/drill/marshals?limit=20&page=1",
  );
  assert.equal(
    resolveProbeFixture({ method: "GET", path: "/api/execution/drill/:kind" })
      .urlPath,
    "/api/execution/drill/week-tasks?limit=20&page=1",
  );
  assert.equal(
    resolveProbeFixture({
      method: "GET",
      path: "/api/analysis/source-samples/:key",
    }).urlPath,
    "/api/analysis/source-samples/daily_ops?limit=20&page=1",
  );
  assert.equal(
    resolveProbeFixture({
      method: "GET",
      path: "/api/assets/visual-drill/:kind",
    }).urlPath,
    "/api/assets/visual-drill/top-used?limit=20&page=1",
  );
  assert.equal(
    resolveProbeFixture({
      method: "GET",
      path: "/api/analysis/visual-drill/:kind",
    }).urlPath,
    "/api/analysis/visual-drill/health?part=content&limit=20&page=1",
  );
  assert.equal(
    resolveProbeFixture({
      method: "GET",
      path: "/api/content/pipelines/:id/stations/:stationIdx/artifacts/:artifactId/preview",
    }).urlPath,
    "/api/content/pipelines/999999/stations/0/artifacts/999999/preview?limit=20&page=1",
  );
  assert.equal(
    resolveProbeFixture({
      method: "GET",
      path: "/api/employee-workbench/content/:idx/runs/:runId/artifacts/:artifactIndex",
    }).urlPath,
    "/api/employee-workbench/content/0/runs/999999/artifacts/0?limit=20&page=1",
  );
  assert.equal(
    resolveProbeFixture({
      method: "GET",
      path: "/api/files/artifacts/source/:sourceType/:sourceId",
    }).urlPath,
    "/api/files/artifacts/source/agent_task/999999?limit=20&page=1",
  );
  assert.equal(
    resolveProbeFixture({ method: "GET", path: "/api/public/calendar.ics" })
      .intent,
    "permission_boundary",
  );
  assert.equal(
    resolveProbeFixture({ method: "PUT", path: "/api/sys/approval-policy" })
      .intent,
    "permission_boundary",
  );
  for (const path of [
    "/api/growth/suggest-reply",
    "/api/content/daily-pack",
    "/api/sys/feishu/app-bot/bind",
  ]) {
    const fixture = resolveProbeFixture({ method: "POST", path });
    assert.equal(fixture.safetyBlocked, true, path);
    assert.equal(fixture.intent, "safety_not_executed", path);
  }
  assert.equal(
    resolveProbeFixture({ method: "GET", path: "/api/task-center/:kind/:id" })
      .urlPath,
    "/api/task-center/restaurant/999999?limit=20&page=1",
  );
  assert.equal(
    resolveProbeFixture({
      method: "GET",
      path: "/api/business-flow/:sourceType/:sourceId",
    }).urlPath,
    "/api/business-flow/restaurant_task/999999?limit=20&page=1",
  );
  assert.match(
    resolveProbeFixture({ method: "GET", path: "/api/dashboard/day-detail" })
      .urlPath,
    /^\/api\/dashboard\/day-detail\?date=\d{4}-\d{2}-\d{2}&limit=20&page=1$/u,
  );
});

test("动态 GET 使用已知合法样本时声明 happy_path，不冒充资源不存在反例", () => {
  const positiveRoutes = [
    "/api/dashboard/employees/:id/detail",
    "/api/marshals/drill/:kind",
    "/api/employees/:idx",
    "/api/employee-workbench/content/:idx/runs",
    "/api/employee-workbench/content/:idx/learning-runs",
    "/api/employee-workbench/content/:idx",
    "/api/employee-workbench/restaurant/:idx",
    "/api/employee-workbench/restaurant/:idx/tasks",
    "/api/employee-workbench/restaurant/:idx/learning-runs",
    "/api/execution/drill/:kind",
    "/api/analysis/source-samples/:key",
    "/api/analysis/visual-drill/:kind",
    "/api/analysis/drill/:kind",
    "/api/assets/source-samples/:key",
    "/api/assets/visual-drill/:kind",
    "/api/assets/drill/:kind",
    "/api/sys/approval-policy",
  ];

  for (const path of positiveRoutes) {
    assert.equal(
      resolveProbeFixture({ method: "GET", path }).intent,
      "happy_path",
      path,
    );
  }
  assert.equal(
    resolveProbeFixture({
      method: "GET",
      path: "/api/content/pipelines/:id",
    }).intent,
    "missing_resource",
  );
});

test("进修、备份、初始化、对账、删除和供应商连接测试在请求前阻断", () => {
  const safetyRoutes = [
    "/api/content/media-jobs/bulk-delete",
    "/api/employee-workbench/content/:idx/learn",
    "/api/employee-workbench/restaurant/:idx/learn",
    "/api/data-intake/reconcile",
    "/api/sys/kb/initialize",
    "/api/sys/backup",
    "/api/admin/api-config/test",
  ];

  for (const path of safetyRoutes) {
    const fixture = resolveProbeFixture({ method: "POST", path });
    assert.equal(fixture.safetyBlocked, true, path);
    assert.equal(fixture.intent, "safety_not_executed", path);
  }
});

test("写探针使用路由契约中的无效输入，不再给所有接口塞同一份伪反例", () => {
  assert.deepEqual(
    resolveProbeFixture({
      method: "POST",
      path: "/api/assets/import",
    }).body,
    { rows: [{}] },
  );
  assert.deepEqual(
    resolveProbeFixture({
      method: "POST",
      path: "/api/sys/marshal-naming/apply",
    }).body,
    { codes: ["__qa_invalid_department__"] },
  );
  assert.deepEqual(
    resolveProbeFixture({ method: "PUT", path: "/api/sys/feishu" }).body,
    { receiveIdType: "__qa_invalid_receive_id_type__" },
  );
  assert.deepEqual(
    resolveProbeFixture({
      method: "PUT",
      path: "/api/admin/api-config",
    }).body,
    { apiKey: "qa-probe-must-not-persist" },
  );
});

test("吊销会话、错误 kind 和不存在路由不能被记为边界通过", () => {
  const revoked = classifyProbeOutcome({
    method: "POST",
    route: "/api/growth/leads",
    intent: "validation_boundary",
    response: {
      status: 401,
      json: { error: "会话已退出或被吊销，请重新登录" },
    },
  });
  assert.equal(revoked.verdict, "AUTH_HARNESS_FAILURE");
  assert.equal(revoked.pass, false);
  assert.equal(revoked.reachedTargetHandler, false);

  const wrongKind = classifyProbeOutcome({
    method: "GET",
    route: "/api/marshals/drill/:kind",
    intent: "happy_path",
    response: { status: 400, json: { error: "未知钻取类型" } },
  });
  assert.equal(wrongKind.verdict, "FIXTURE_INVALID");
  assert.equal(wrongKind.pass, false);

  const absentRoute = classifyProbeOutcome({
    method: "GET",
    route: "/api/avatar/stats",
    intent: "happy_path",
    response: {
      status: 404,
      text: "<!doctype html><pre>Cannot GET /api/avatar/stats</pre>",
    },
  });
  assert.equal(absentRoute.verdict, "ROUTE_DISCOVERY_INVALID");
  assert.equal(absentRoute.pass, false);
});

test("权限反例与正向功能通过分开统计", () => {
  const outcome = classifyProbeOutcome({
    method: "GET",
    route: "/api/platform/overview",
    intent: "permission_boundary",
    response: { status: 403, json: { error: "无权限执行此操作" } },
  });
  assert.equal(outcome.verdict, "NEGATIVE_BOUNDARY_PASS");
  assert.equal(outcome.pass, true);
  assert.equal(outcome.happyPathPass, false);
  assert.equal(outcome.coverageClass, "权限反例通过");
});

test("非 happy_path 意图收到无拒绝语义的 2xx 只能标记尚未验证", () => {
  for (const intent of [
    "permission_boundary",
    "missing_resource",
    "validation_boundary",
  ]) {
    const outcome = classifyProbeOutcome({
      method: intent === "missing_resource" ? "GET" : "POST",
      route: "/api/example/:id",
      intent,
      response: { status: 200, json: { ok: true, rows: [] } },
    });
    assert.equal(outcome.verdict, "UNVERIFIED", intent);
    assert.equal(outcome.pass, false, intent);
    assert.equal(outcome.happyPathPass, false, intent);
    assert.equal(outcome.coverageClass, "尚未验证", intent);
  }
});

test("2xx 业务语义按契约区分反例、外部未执行和产品失败", () => {
  const validation = classifyProbeOutcome({
    method: "POST",
    route: "/api/assets/import",
    intent: "validation_boundary",
    response: {
      status: 200,
      json: {
        ok: true,
        created: [],
        errors: [{ row: 1, reason: "缺少资产名称" }],
      },
    },
  });
  assert.equal(validation.verdict, "NEGATIVE_BOUNDARY_PASS");
  assert.equal(validation.pass, true);
  assert.equal(validation.happyPathPass, false);

  const readiness = classifyProbeOutcome({
    method: "POST",
    route: "/api/admin/api-config/test",
    intent: "happy_path",
    response: {
      status: 200,
      json: { ok: false, error: "尚未配置 API Key" },
    },
  });
  assert.equal(readiness.verdict, "SAFETY_NOT_EXECUTED");
  assert.equal(readiness.pass, false);
  assert.equal(readiness.happyPathPass, false);
  assert.equal(readiness.reachedTargetHandler, true);

  const businessFailure = classifyProbeOutcome({
    method: "POST",
    route: "/api/example",
    intent: "happy_path",
    response: {
      status: 200,
      json: { success: false, message: "业务产物生成失败" },
    },
  });
  assert.equal(businessFailure.verdict, "PRODUCT_OR_FIXTURE_FAILURE");
  assert.equal(businessFailure.coverageClass, "产品失败");
  assert.equal(businessFailure.happyPathPass, false);
});

test("正常 2xx message 显示为成功消息，只有 error 或失败态才标记错误", () => {
  const success = summarizeProbeResponse({
    status: 200,
    contentType: "application/json",
    rawBody: JSON.stringify({
      ok: true,
      message: "知识库初始化完成",
    }),
  });
  assert.equal(success.bodyPreview, "消息：知识库初始化完成");

  const error = summarizeProbeResponse({
    status: 200,
    contentType: "application/json",
    rawBody: JSON.stringify({
      ok: false,
      message: "连接检查未通过",
    }),
  });
  assert.equal(error.bodyPreview, "错误：连接检查未通过");

  const httpError = summarizeProbeResponse({
    status: 422,
    contentType: "application/json",
    rawBody: JSON.stringify({ message: "参数校验未通过" }),
  });
  assert.equal(httpError.bodyPreview, "错误：参数校验未通过");

  const outcome = classifyProbeOutcome({
    method: "POST",
    route: "/api/example",
    intent: "happy_path",
    response: { status: 200, json: { ok: true, message: "处理完成" } },
  });
  assert.equal(outcome.verdict, "HAPPY_PATH_PASS");
  assert.equal(outcome.happyPathPass, true);
});

test("报告先解析完整 JSON 再生成紧凑摘要，并把历史失败与当前接口状态分离", () => {
  const raw = JSON.stringify({
    ok: true,
    rows: Array.from({ length: 60 }, (_, id) => ({
      id,
      ...(id === 3
        ? {
            failure: {
              message:
                "历史运行#16未交付：field_structure：字段 report 存在缺失、未知字段、类型、数量或长度错误",
            },
          }
        : { note: `正常记录${id}` }),
    })),
  });
  const summary = summarizeProbeResponse({
    status: 200,
    contentType: "application/json; charset=utf-8",
    rawBody: raw,
  });
  assert.equal(summary.jsonValid, true);
  assert.equal(summary.shape.kind, "object");
  assert.ok(summary.bytes > 600);
  assert.equal(summary.historicalIssues.length, 1);
  assert.equal(
    summary.historicalIssues[0].category,
    "historical_content_contract",
  );
  assert.doesNotMatch(summary.bodyPreview, /field_structure|rows":\[/u);
  assert.ok(summary.bodyPreview.length < 300);
  assert.equal("rawBody" in summary, false);
});

test("历史故障提取只读取失败状态和错误证据，不把岗位说明、提示词或正常结算当故障", () => {
  const summary = summarizeProbeResponse({
    status: 200,
    contentType: "application/json",
    rawBody: JSON.stringify({
      rows: [
        {
          status: "已完成",
          instruction: "输出必须服从岗位契约；失败时列待核验项。",
          description: "按真实 token 预授权，成功后结算。",
          note: "按实际 token 用量两阶段结算；未交付时全额退回。",
          file_name: "岗位输出契约_已完成.pdf",
        },
        {
          status: "失败",
          failure: { message: "输出契约校验未通过：字段 report 缺失" },
          billing: { note: "本次未交付，预授权已全额退回。" },
        },
      ],
      readiness: {
        conditions: ["必须进入生成链并服从输出契约"],
      },
    }),
  });

  assert.deepEqual(
    summary.historicalIssues.map((item) => item.message),
    [
      "失败",
      "输出契约校验未通过：字段 report 缺失",
      "本次未交付，预授权已全额退回。",
    ],
  );
  assert.equal(
    summary.historicalIssues.some((item) =>
      /岗位说明|失败时|成功后结算|两阶段结算|file_name/u.test(item.message),
    ),
    false,
  );
});

test("响应摘要会脱敏通用 token 与 authorization 键值", () => {
  const summary = summarizeProbeResponse({
    status: 400,
    contentType: "application/json",
    rawBody: JSON.stringify({
      error:
        "upstream echoed token: SESSION_SECRET_123456 and authorization: BasicSecret_987654",
    }),
  });
  assert.doesNotMatch(
    summary.bodyPreview,
    /SESSION_SECRET_123456|BasicSecret_987654/u,
  );
  assert.match(summary.bodyPreview, /\[REDACTED\]/u);
});

test("写探针每项使用独立会话，logout 不会污染后续功能", async () => {
  let loginCount = 0;
  const calls = [];
  const output = await runProbeBatch({
    mode: "write",
    routes: [
      { method: "POST", path: "/api/auth/logout" },
      { method: "POST", path: "/api/growth/leads" },
    ],
    baseUrl: "http://probe.invalid",
    login: async () => ({
      token: `token-${++loginCount}`,
      role: "boss",
      tenantId: 1,
    }),
    request: async ({ route, token }) => {
      calls.push({ route, token });
      if (route === "/api/auth/logout")
        return {
          status: 200,
          rawBody: '{"ok":true}',
          contentType: "application/json",
        };
      return {
        status: 400,
        rawBody: '{"error":"客户姓名必填"}',
        contentType: "application/json",
      };
    },
    allowWriteProbes: true,
    isolatedDbMarker: "isolated clone",
  });
  assert.equal(loginCount, 2);
  assert.deepEqual(
    calls.map((item) => item.token),
    ["token-1", "token-2"],
  );
  assert.equal(output.results[0].quality.verdict, "HAPPY_PATH_PASS");
  assert.equal(output.results[1].quality.verdict, "NEGATIVE_BOUNDARY_PASS");
  assert.equal(output.summary.counts.AUTH_HARNESS_FAILURE || 0, 0);
});

test("静态清单不会把历史失败员工或功能矩阵冒充成正向通过", () => {
  assert.equal(
    classifySurface(
      { id: "employee:restaurant:101", path: "" },
      {
        evidenceType: "real_employee_matrix",
        pass: false,
        verdict: "FAIL_REAL_API",
      },
      null,
    ),
    "历史执行失败",
  );
  assert.equal(
    classifySurface(
      { id: "feature:content", path: "/content" },
      { evidenceType: "real_feature_matrix", pass: true, verdict: "PASS" },
      null,
    ),
    "正向功能通过",
  );
});
