import crypto from "node:crypto";

const REVOKED_SESSION = /会话已退出或被吊销|session\s+(?:revoked|expired)/iu;
const INVALID_FIXTURE =
  /未知(?:可视化)?钻取类型|未知来源类型|请求内容格式错误|来源类型不正确|缺少日期|搜索词长度必须|URL格式无效/iu;
const ROUTE_NOT_FOUND = /Cannot\s+(?:GET|POST|PUT|PATCH|DELETE)\s+\/api\//iu;
const SECRET =
  /(?:\bsk-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*|["']?(?:access_token|refresh_token|token|authorization|api[_-]?key|client[_-]?secret|password|cookie)["']?\s*[:=]\s*["']?[^"'\s,;}\]]+["']?)/giu;
const NOT_READY =
  /(?:尚未配置|请先配置|配置未就绪|未就绪|not\s+(?:configured|ready)|missing\s+(?:api\s*)?(?:key|credential))/iu;
const VALIDATION_REJECTION =
  /(?:必填|不能为空|请填写|请选择|缺少|无效|格式|参数|仅支持|不支持|不允许|超长|最多|必须|不存在|invalid|required|must\s+be|not\s+found)/iu;
const PERMISSION_REJECTION =
  /(?:无权|权限|禁止|仅.+可|forbidden|permission|not\s+allowed)/iu;
const AUTH_REJECTION =
  /(?:账号|用户名|密码|登录|凭证|credential|unauthori[sz]ed)/iu;
const MISSING_RESOURCE = /(?:不存在|未找到|not\s+found|missing\s+resource)/iu;

const PATH_OVERRIDES = new Map([
  ["/api/marshals/drill/:kind", { kind: "marshals" }],
  ["/api/execution/drill/:kind", { kind: "week-tasks" }],
  ["/api/analysis/drill/:kind", { kind: "revenue" }],
  ["/api/assets/drill/:kind", { kind: "total" }],
  ["/api/analysis/visual-drill/:kind", { kind: "health" }],
  ["/api/assets/visual-drill/:kind", { kind: "top-used" }],
  ["/api/analysis/source-samples/:key", { key: "daily_ops" }],
  ["/api/assets/source-samples/:key", { key: "content" }],
  ["/api/task-center/:kind/:id", { kind: "restaurant", id: "999999" }],
  [
    "/api/business-flow/:sourceType/:sourceId",
    { sourceType: "restaurant_task", sourceId: "999999" },
  ],
  ["/api/dashboard/employees/:id/detail", { id: "1" }],
]);

const HAPPY_PATH_FIXTURES = new Set([
  "GET /api/dashboard/employees/:id/detail",
  "GET /api/marshals/drill/:kind",
  "GET /api/employees/:idx",
  "GET /api/employee-workbench/content/:idx/runs",
  "GET /api/employee-workbench/content/:idx/learning-runs",
  "GET /api/employee-workbench/content/:idx",
  "GET /api/employee-workbench/restaurant/:idx",
  "GET /api/employee-workbench/restaurant/:idx/tasks",
  "GET /api/employee-workbench/restaurant/:idx/learning-runs",
  "GET /api/execution/drill/:kind",
  "GET /api/analysis/source-samples/:key",
  "GET /api/analysis/visual-drill/:kind",
  "GET /api/analysis/drill/:kind",
  "GET /api/assets/source-samples/:key",
  "GET /api/assets/visual-drill/:kind",
  "GET /api/assets/drill/:kind",
  "GET /api/sys/approval-policy",
]);

const SAFETY_ONLY_FIXTURES = new Set([
  "POST /api/content/media-jobs/bulk-delete",
  "POST /api/employee-workbench/content/:idx/learn",
  "POST /api/employee-workbench/restaurant/:idx/learn",
  "POST /api/data-intake/reconcile",
  "POST /api/sys/kb/initialize",
  "POST /api/sys/backup",
  "POST /api/admin/api-config/test",
]);

const BODY_OVERRIDES = new Map([
  ["POST /api/assets/import", () => ({ rows: [{}] })],
  [
    "POST /api/sys/marshal-naming/apply",
    () => ({ codes: ["__qa_invalid_department__"] }),
  ],
  [
    "PUT /api/sys/feishu",
    () => ({ receiveIdType: "__qa_invalid_receive_id_type__" }),
  ],
  [
    "PUT /api/admin/api-config",
    () => ({ apiKey: "qa-probe-must-not-persist" }),
  ],
  ["POST /api/admin/api-config/test", () => ({})],
]);

const EXTERNAL_OR_COSTLY_WRITE =
  /(?:\/notify\/|\/recharge\/orders|\/confirm$|\/publish|\/send|\/dispatch|\/generate(?:-|\/|$)|\/retry$|\/run-now$|\/execute$|\/chat$|\/clone$|\/jobs$|\/sync|\/oauth|\/paid-media|\/import-material|\/upload$|\/recognize|\/transcrib|\/summari[sz]e|\/video|\/image)/iu;

function redact(value) {
  return String(value ?? "").replace(SECRET, "[REDACTED]");
}

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

function defaultParam(name, route) {
  if (name === "idx") return route.includes("/content/") ? "0" : "101";
  if (name === "stationIdx" || name === "artifactIndex") return "0";
  if (name === "id" || /Id$/u.test(name)) return "999999";
  if (name === "jti") return "qa-session-not-found";
  if (name === "sid") return "qa-session-not-found";
  if (name === "orderNo") return "QA-ORDER-NOT-FOUND";
  if (name === "kind") return "restaurant";
  if (name === "key") return "daily_ops";
  if (name === "sourceType") {
    return route.startsWith("/api/files/artifacts/source/")
      ? "agent_task"
      : "restaurant_task";
  }
  if (name === "sourceId") return "999999";
  if (name === "format") return "pdf";
  return "999999";
}

function routeNeedsExternalSafetyBlock(method, route) {
  if (SAFETY_ONLY_FIXTURES.has(`${method} ${route}`)) return true;
  if (method === "GET") {
    return (
      route === "/api/imagehunt/" ||
      route === "/api/imagehunt/thumb" ||
      route === "/api/public/feishu/oauth/callback"
    );
  }
  if (route === "/api/auth/logout" || route === "/api/auth/session")
    return false;
  if (
    [
      "/api/growth/suggest-reply",
      "/api/content/daily-pack",
      "/api/sys/feishu/app-bot/bind",
    ].includes(route)
  )
    return true;
  return EXTERNAL_OR_COSTLY_WRITE.test(route);
}

function unauthenticatedRoute(route) {
  return (
    route === "/api/auth/login" ||
    route === "/api/auth/register" ||
    route.startsWith("/api/recharge/notify/")
  );
}

function queryFor(method, route) {
  const query = new URLSearchParams();
  if (route === "/api/dashboard/day-detail") query.set("date", isoDate());
  if (route === "/api/public/calendar.ics")
    query.set("key", "qa-invalid-calendar-token");
  if (route === "/api/analysis/visual-drill/:kind")
    query.set("part", "content");
  if (method === "GET") {
    query.set("limit", "20");
    query.set("page", "1");
  }
  return query;
}

function intentFor(method, route, hasDynamicParam) {
  if (HAPPY_PATH_FIXTURES.has(`${method} ${route}`)) return "happy_path";
  if (route === "/api/auth/login") return "auth_rejection";
  if (route === "/api/auth/session" || route === "/api/auth/logout")
    return "happy_path";
  if (route === "/api/public/calendar.ics") return "permission_boundary";
  if (method === "PUT" && route === "/api/sys/approval-policy")
    return "permission_boundary";
  if (route.startsWith("/api/platform/")) return "permission_boundary";
  if (method === "GET" && hasDynamicParam) return "missing_resource";
  if (method === "GET") return "happy_path";
  return "validation_boundary";
}

function bodyFor(method, route) {
  if (method === "GET") return undefined;
  const override = BODY_OVERRIDES.get(`${method} ${route}`);
  if (override) return override();
  if (route === "/api/auth/login")
    return { username: "qa-invalid-user", password: "qa-invalid-password" };
  if (route === "/api/auth/register") return {};
  if (route === "/api/auth/session" || route === "/api/auth/logout") return {};
  return {
    __qa_boundary__: true,
    id: 999999,
    name: "",
    title: "",
    required: "",
  };
}

export function resolveProbeFixture({ method, path: route }) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const overrides = PATH_OVERRIDES.get(route) || {};
  const dynamicNames = [...route.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/gu)].map(
    (match) => match[1],
  );
  let urlPath = route;
  for (const name of dynamicNames) {
    const value = overrides[name] ?? defaultParam(name, route);
    urlPath = urlPath.replace(`:${name}`, encodeURIComponent(String(value)));
  }
  const query = queryFor(normalizedMethod, route);
  if ([...query].length) urlPath += `?${query.toString()}`;
  const safetyBlocked = routeNeedsExternalSafetyBlock(normalizedMethod, route);
  return {
    method: normalizedMethod,
    route,
    urlPath,
    body: bodyFor(normalizedMethod, route),
    authRequired: !unauthenticatedRoute(route),
    intent: safetyBlocked
      ? "safety_not_executed"
      : intentFor(normalizedMethod, route, dynamicNames.length > 0),
    safetyBlocked,
    safetyReason: safetyBlocked
      ? "该接口可能调用外部供应商、产生费用、发送消息或执行不可逆动作，本轮只登记不发送"
      : null,
  };
}

const HISTORICAL_STATUS =
  /^(?:失败|已失败|已驳回|质检未通过|失败需(?:返工|处理).*)$/iu;
const HISTORICAL_FIELD =
  /^(?:error|errors|lastError|failure|failureReason|failure_reason|blockedReason|status|displayStatus|lastStatus|note|message|reason|action|target|body)$/u;

function issueCategory(text) {
  if (
    /输出契约校验未通过|未通过岗位JSON契约|field_structure|CONTENT_PRODUCTION_OUTPUT_CONTRACT_FAILED|内容格式错误|字段.+(?:缺失|未知字段|类型错误|数量错误|长度错误|唯一性错误)/iu.test(
      text,
    )
  ) {
    return "historical_content_contract";
  }
  if (
    /provider_(?:timeout|upstream_error)|供应商.+(?:超时|失败)|云雾.+(?:超时|失败|Unsupported model type|token鉴权错误)|HTTP\s*50[234]/iu.test(
      text,
    )
  ) {
    return "historical_provider_failure";
  }
  if (
    /待账务对账|结算失败|仍预授权|预授权已退回|(?:未交付|失败).{0,100}(?:预授权|占扣).{0,100}(?:退回|释放)|全额退回/iu.test(
      text,
    )
  ) {
    return "historical_billing_state";
  }
  if (
    HISTORICAL_STATUS.test(text) ||
    /执行失败|运行失败|未交付|被阻断|只返回模板|未取得可引用证据/iu.test(text)
  ) {
    return "historical_business_failure";
  }
  return null;
}

function collectHistoricalIssues(value, { limit = 20 } = {}) {
  const issues = [];
  const seen = new Set();
  const visit = (node, path = "$", field = "", parent = null) => {
    if (issues.length >= limit || node == null) return;
    if (typeof node === "string") {
      if (!HISTORICAL_FIELD.test(field)) return;
      const category = issueCategory(node);
      if (!category) return;
      const isStructuredFailureField =
        /^(?:error|errors|lastError|failure|failureReason|failure_reason|blockedReason)$/u.test(
          field,
        );
      const isFailureContainer = /(?:^|\.)(?:failure|errors?)(?:\.|\[|$)/u.test(
        path,
      );
      const isEventField =
        /^(?:status|displayStatus|lastStatus|note|message|reason|action|target|body)$/u.test(
          field,
        );
      if (!isStructuredFailureField && !isFailureContainer && !isEventField)
        return;
      if (
        field === "note" &&
        !/(?:logs?|runs?|pipelines?)(?:\.|\[)|billing(?:Evidence)?\.note|provenance\.billing\.note/iu.test(
          path,
        )
      )
        return;
      if (
        field === "message" &&
        !isFailureContainer &&
        !/progress\[\d+\]\.message$/u.test(path)
      )
        return;
      if (
        field === "reason" &&
        !isFailureContainer &&
        !/reconciliation\.reason$/u.test(path)
      )
        return;
      if (
        /^(?:action|target|body)$/u.test(field) &&
        !/(?:logs?|notifications?)(?:\.|\[)/iu.test(path)
      )
        return;
      const message = redact(node).replace(/\s+/gu, " ").trim().slice(0, 240);
      const key = `${category}:${message}`;
      if (!seen.has(key)) {
        seen.add(key);
        const observedAt =
          parent && typeof parent === "object"
            ? parent.createdAt ||
              parent.created_at ||
              parent.updatedAt ||
              parent.updated_at ||
              parent.finishedAt ||
              parent.completedAt ||
              null
            : null;
        const runId =
          parent && typeof parent === "object"
            ? (parent.runId ??
              parent.run_id ??
              parent.taskId ??
              parent.task_id ??
              parent.id ??
              null)
            : null;
        issues.push({ category, path, message, observedAt, runId });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) =>
        visit(item, `${path}[${index}]`, field, parent),
      );
      return;
    }
    if (typeof node === "object") {
      for (const [key, child] of Object.entries(node))
        visit(child, `${path}.${key}`, key, node);
    }
  };
  visit(value);
  return issues;
}

function jsonShape(value) {
  if (Array.isArray(value)) return { kind: "array", count: value.length };
  if (value && typeof value === "object")
    return { kind: "object", keys: Object.keys(value).slice(0, 30) };
  return { kind: value === null ? "null" : typeof value };
}

function messageText(value) {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return redact(value).replace(/\s+/gu, " ").trim();
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return messageText(value.message || value.error || value.reason || "");
  }
  return "";
}

function payloadHasFailureState(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return false;
  if (payload.error != null && payload.error !== "") return true;
  if (
    payload.ok === false ||
    payload.success === false ||
    payload.failed === true
  )
    return true;
  const status = String(payload.status || payload.state || "")
    .trim()
    .toLowerCase();
  return new Set([
    "failed",
    "failure",
    "error",
    "rejected",
    "blocked",
    "not_ready",
    "not-ready",
    "失败",
    "已失败",
    "已驳回",
    "被阻断",
    "未就绪",
  ]).has(status);
}

function payloadFailureMessage(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return "";
  return (
    messageText(payload.error) ||
    (payloadHasFailureState(payload)
      ? messageText(
          payload.message || payload.reason || payload.status || payload.state,
        )
      : "")
  );
}

export function summarizeProbeResponse({
  status,
  contentType = "",
  rawBody = "",
}) {
  const body = String(rawBody ?? "");
  let json;
  let jsonValid = false;
  try {
    json = JSON.parse(body);
    jsonValid = true;
  } catch {
    json = undefined;
  }
  const bytes = Buffer.byteLength(body);
  const shape = jsonValid ? jsonShape(json) : { kind: "text" };
  const objectPayload =
    jsonValid && json && typeof json === "object" && !Array.isArray(json)
      ? json
      : null;
  const httpFailure = Number(status) >= 400;
  const topLevelError = (
    payloadFailureMessage(objectPayload) ||
    (httpFailure ? messageText(objectPayload?.message) : "")
  ).slice(0, 280);
  const topLevelMessage =
    objectPayload && !httpFailure && !payloadHasFailureState(objectPayload)
      ? messageText(objectPayload.message).slice(0, 280)
      : "";
  const bodyPreview = topLevelError
    ? `错误：${topLevelError}`
    : topLevelMessage
      ? `消息：${topLevelMessage}`
      : jsonValid
        ? shape.kind === "array"
          ? `JSON 数组，共 ${shape.count} 项`
          : shape.kind === "object"
            ? `JSON 对象；字段：${shape.keys.join("、") || "（空）"}`
            : `JSON ${shape.kind}`
        : redact(body)
            .replace(/<[^>]+>/gu, " ")
            .replace(/\s+/gu, " ")
            .trim()
            .slice(0, 240);
  return {
    status: Number(status) || 0,
    contentType: String(contentType || ""),
    bytes,
    bodySha256: crypto.createHash("sha256").update(body).digest("hex"),
    jsonValid,
    json,
    shape,
    bodyPreview,
    historicalIssues:
      jsonValid && Number(status) >= 200 && Number(status) < 300
        ? collectHistoricalIssues(json)
        : [],
  };
}

function responseMessage(response) {
  if (response?.json && typeof response.json === "object") {
    return (
      payloadFailureMessage(response.json) || messageText(response.json.message)
    );
  }
  return String(response?.text || response?.bodyPreview || "");
}

function negativeBoundary(base, coverageClass, score = 85) {
  return {
    ...base,
    verdict: "NEGATIVE_BOUNDARY_PASS",
    pass: true,
    reachedTargetHandler: true,
    coverageClass,
    score,
  };
}

function twoXxValidationBoundary(route, payload) {
  if (
    route === "/api/assets/import" &&
    Array.isArray(payload?.errors) &&
    payload.errors.length > 0 &&
    Array.isArray(payload?.created) &&
    payload.created.length === 0
  ) {
    return true;
  }
  return false;
}

export function classifyProbeOutcome({ method, route, intent, response }) {
  const status = Number(response?.status) || 0;
  const message = responseMessage(response);
  const base = {
    pass: false,
    happyPathPass: false,
    reachedTargetHandler: false,
    coverageClass: "未执行（测试器无效）",
    score: 0,
  };
  if (intent === "safety_not_executed") {
    return {
      ...base,
      verdict: "SAFETY_NOT_EXECUTED",
      coverageClass: "外部副作用安全阻断",
      score: 75,
    };
  }
  if (!status)
    return { ...base, verdict: "TRANSPORT_FAILURE", coverageClass: "产品失败" };
  if (REVOKED_SESSION.test(message))
    return { ...base, verdict: "AUTH_HARNESS_FAILURE" };
  if (ROUTE_NOT_FOUND.test(message))
    return { ...base, verdict: "ROUTE_DISCOVERY_INVALID" };
  if (INVALID_FIXTURE.test(message))
    return { ...base, verdict: "FIXTURE_INVALID" };
  if (status >= 500)
    return {
      ...base,
      verdict: "PRODUCT_SERVER_FAILURE",
      coverageClass: "产品失败",
    };
  if (status >= 200 && status < 300) {
    const payload =
      response?.json && typeof response.json === "object"
        ? response.json
        : null;
    const failureState = payloadHasFailureState(payload);
    if (failureState && NOT_READY.test(message)) {
      return {
        ...base,
        verdict: "SAFETY_NOT_EXECUTED",
        reachedTargetHandler: true,
        coverageClass: "外部依赖未就绪（未执行）",
        score: 75,
      };
    }
    if (
      intent === "validation_boundary" &&
      (twoXxValidationBoundary(route, payload) ||
        (failureState && VALIDATION_REJECTION.test(message)))
    ) {
      return negativeBoundary(base, "参数校验反例通过");
    }
    if (
      intent === "permission_boundary" &&
      failureState &&
      PERMISSION_REJECTION.test(message)
    ) {
      return negativeBoundary(base, "权限反例通过", 90);
    }
    if (
      intent === "missing_resource" &&
      failureState &&
      MISSING_RESOURCE.test(message)
    ) {
      return negativeBoundary(base, "资源不存在反例通过");
    }
    if (
      intent === "auth_rejection" &&
      failureState &&
      AUTH_REJECTION.test(message)
    ) {
      return negativeBoundary(base, "权限反例通过", 90);
    }
    if (failureState) {
      return {
        ...base,
        verdict: "PRODUCT_OR_FIXTURE_FAILURE",
        reachedTargetHandler: true,
        coverageClass: "产品失败",
      };
    }
    if (intent !== "happy_path") {
      return {
        ...base,
        verdict: "UNVERIFIED",
        reachedTargetHandler: true,
        coverageClass: "尚未验证",
        score: 25,
      };
    }
    return {
      ...base,
      verdict: "HAPPY_PATH_PASS",
      pass: true,
      happyPathPass: true,
      reachedTargetHandler: true,
      coverageClass: "正向功能通过",
      score: 100,
    };
  }
  if (intent === "auth_rejection" && status === 401) {
    return negativeBoundary(base, "权限反例通过", 90);
  }
  if (intent === "permission_boundary" && status === 403) {
    return negativeBoundary(base, "权限反例通过", 90);
  }
  if (intent === "missing_resource" && status === 404) {
    return negativeBoundary(base, "资源不存在反例通过");
  }
  if (
    intent === "validation_boundary" &&
    [400, 404, 409, 422].includes(status)
  ) {
    return negativeBoundary(base, "参数校验反例通过");
  }
  return {
    ...base,
    verdict: "PRODUCT_OR_FIXTURE_FAILURE",
    reachedTargetHandler: status !== 401,
    coverageClass: "产品失败",
  };
}

function responseForClassification(summary) {
  return {
    status: summary.status,
    json: summary.jsonValid ? summary.json : undefined,
    text: summary.jsonValid ? "" : summary.bodyPreview,
    bodyPreview: summary.bodyPreview,
  };
}

export async function runProbeBatch({
  mode,
  routes,
  baseUrl,
  login,
  request,
  allowWriteProbes = false,
  isolatedDbMarker = "",
}) {
  if (
    mode === "write" &&
    (!allowWriteProbes || !/isolated/iu.test(isolatedDbMarker))
  ) {
    throw new Error("写接口探针只能在显式 isolated 数据库副本运行");
  }
  const results = [];
  let sharedSession = null;
  for (const row of routes) {
    const fixture = resolveProbeFixture(row);
    const startedAt = new Date().toISOString();
    if (fixture.safetyBlocked) {
      const quality = classifyProbeOutcome({
        ...row,
        route: row.path,
        intent: fixture.intent,
        response: null,
      });
      results.push({
        id: `api:${row.method}:${row.path}`,
        route: row.path,
        input: { ...fixture, body: fixture.body || null },
        output: null,
        quality,
        startedAt,
        completedAt: new Date().toISOString(),
      });
      continue;
    }
    let session = null;
    if (fixture.authRequired) {
      if (mode === "write") session = await login();
      else {
        sharedSession ||= await login();
        session = sharedSession;
      }
    }
    const invoke = async (activeSession) =>
      request({
        method: row.method,
        route: row.path,
        url: `${String(baseUrl).replace(/\/$/u, "")}${fixture.urlPath}`,
        urlPath: fixture.urlPath,
        body: fixture.body,
        token: activeSession?.token || null,
      });
    let rawResponse = await invoke(session);
    let summary = summarizeProbeResponse({
      status: rawResponse?.status,
      contentType: rawResponse?.contentType,
      rawBody: rawResponse?.rawBody,
    });
    let authRecoveryCount = 0;
    if (
      fixture.authRequired &&
      REVOKED_SESSION.test(
        responseMessage(responseForClassification(summary)),
      ) &&
      row.path !== "/api/auth/logout"
    ) {
      session = await login();
      if (mode !== "write") sharedSession = session;
      rawResponse = await invoke(session);
      summary = summarizeProbeResponse({
        status: rawResponse?.status,
        contentType: rawResponse?.contentType,
        rawBody: rawResponse?.rawBody,
      });
      authRecoveryCount = 1;
    }
    const quality = classifyProbeOutcome({
      method: row.method,
      route: row.path,
      intent: fixture.intent,
      response: responseForClassification(summary),
    });
    results.push({
      id: `api:${row.method}:${row.path}`,
      route: row.path,
      input: {
        method: row.method,
        urlPath: fixture.urlPath,
        intent: fixture.intent,
        role: session?.role || null,
        tenantId: session?.tenantId || null,
        body: fixture.body || null,
      },
      output: {
        status: summary.status,
        contentType: summary.contentType,
        bytes: summary.bytes,
        bodySha256: summary.bodySha256,
        jsonValid: summary.jsonValid,
        shape: summary.shape,
        bodyPreview: summary.bodyPreview,
        historicalIssues: summary.historicalIssues,
      },
      quality: { ...quality, authRecoveryCount },
      startedAt,
      completedAt: new Date().toISOString(),
    });
  }
  const counts = {};
  for (const row of results)
    counts[row.quality.verdict] = (counts[row.quality.verdict] || 0) + 1;
  const invalidHarness = results.filter((row) =>
    [
      "AUTH_HARNESS_FAILURE",
      "FIXTURE_INVALID",
      "ROUTE_DISCOVERY_INVALID",
    ].includes(row.quality.verdict),
  ).length;
  return {
    schemaVersion: "nanowork.http-feature-probe.v2",
    summary: {
      total: results.length,
      counts,
      happyPathPass: results.filter((row) => row.quality.happyPathPass).length,
      negativeBoundaryPass: results.filter(
        (row) => row.quality.verdict === "NEGATIVE_BOUNDARY_PASS",
      ).length,
      safetyNotExecuted: results.filter(
        (row) => row.quality.verdict === "SAFETY_NOT_EXECUTED",
      ).length,
      unverified: results.filter((row) => row.quality.verdict === "UNVERIFIED")
        .length,
      invalidHarness,
      generatedAt: new Date().toISOString(),
      base: baseUrl,
      dbMarker: isolatedDbMarker || null,
    },
    results,
  };
}

export function probeEvidenceStatus(result) {
  if (!result?.quality) return "UNVERIFIED";
  if (result.quality.happyPathPass) return "HAPPY_PATH_PASS";
  if (result.quality.verdict === "NEGATIVE_BOUNDARY_PASS")
    return "NEGATIVE_BOUNDARY_PASS";
  if (result.quality.verdict === "SAFETY_NOT_EXECUTED")
    return "SAFETY_NOT_EXECUTED";
  if (result.quality.verdict === "UNVERIFIED") return "UNVERIFIED";
  if (
    [
      "AUTH_HARNESS_FAILURE",
      "FIXTURE_INVALID",
      "ROUTE_DISCOVERY_INVALID",
    ].includes(result.quality.verdict)
  )
    return "HARNESS_INVALID";
  return "PRODUCT_FAILURE";
}
