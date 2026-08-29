import crypto from "node:crypto";

const CATEGORY_ORDER = [
  "positive_pass",
  "negative_boundary",
  "harness_invalid",
  "historical_pass",
  "historical_failure",
  "product_failure",
  "safety_not_executed",
  "unverified",
];

const CATEGORY_META = Object.freeze({
  positive_pass: {
    label: "正向功能通过",
    meaning: "使用符合接口契约的输入完成正向执行。",
  },
  negative_boundary: {
    label: "负向边界通过",
    meaning:
      "权限拒绝、参数校验或资源不存在等反例符合预期；不计入正向功能通过。",
  },
  harness_invalid: {
    label: "测试器无效",
    meaning:
      "会话被测试器吊销、路由盘点错误或 fixture 不符合契约；不能用于判断产品。",
  },
  historical_pass: {
    label: "历史通过记录",
    meaning: "过往真实运行在当时口径下通过；不计入当前功能通过。",
  },
  historical_failure: {
    label: "历史失败记录",
    meaning: "数据库或旧验收矩阵中的过往失败；与本次接口请求的当前状态分开。",
  },
  product_failure: {
    label: "当前接口探针失败",
    meaning:
      "仅覆盖本轮有效接口探针：已触达目标处理器，但出现运输、服务端或业务契约失败。",
  },
  safety_not_executed: {
    label: "安全阻断·未执行",
    meaning: "外发、付款、付费供应商或不可逆操作本轮未发送；不计入已执行。",
  },
  unverified: {
    label: "尚未验证",
    meaning: "清单中已发现该入口，但本轮没有可用的语义证据。",
  },
});

const SOURCE_LABELS = Object.freeze({
  inventory: "修正后功能清单",
  get: "GET 语义探针",
  write: "隔离库写接口语义探针",
  web: "页面语义验收",
  employee: "数字员工历史矩阵",
  content: "内容自动化历史矩阵",
  businessFeature: "业务功能历史矩阵",
  outputQuality: "员工输出质量历史审计",
});

const HISTORICAL_SUBTYPE_LABELS = Object.freeze({
  historical_content_contract: "历史内容契约未通过",
  historical_provider_failure: "历史供应商调用失败",
  historical_billing_state: "历史账务尚未收口",
  historical_business_failure: "历史业务交付未完成",
});

const HISTORICAL_VERDICT_LABELS = Object.freeze({
  HISTORICAL_RECORD_ONLY: "历史记录，仅供复盘",
  FAIL_REAL_API: "历史岗位真实执行未通过",
  FAIL_REAL_CONTENT_AUTOMATION: "历史内容自动化执行未通过",
  BLOCKED_VIDEO: "历史岗位视频能力受阻",
});

const SECRET =
  /(?:\bsk-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*|["']?\b(?:access_token|refresh_token|session_token|token|authorization|api[_-]?key|client[_-]?secret|password|cookie)\b["']?\s*[:=]\s*["']?[^\s,;"'}]+)/giu;
const QUERY_SECRET =
  /([?&](?:access_token|refresh_token|session_token|token|key|code|state|sid|jti|api_key)=)[^&#\s]+/giu;
const SENSITIVE_FIELD_NAME =
  /(?:prompt|system[_-]?context|instruction|password|authorization|cookie|(?:access|refresh|session)?[_-]?token|api[_-]?key|client[_-]?secret)/iu;
const REVOKED = /会话已退出或被吊销|session\s+(?:revoked|expired)/iu;
const INVALID_FIXTURE =
  /未知(?:可视化)?钻取类型|未知来源类型|请求内容格式错误|来源类型不正确|缺少日期|搜索词长度必须|URL格式无效/iu;
const ROUTE_NOT_FOUND = /Cannot\s+(?:GET|POST|PUT|PATCH|DELETE)\s+\/api\//iu;

const VALID_PROBE_VERDICTS = new Set([
  "HAPPY_PATH_PASS",
  "NEGATIVE_BOUNDARY_PASS",
  "SAFETY_NOT_EXECUTED",
  "AUTH_HARNESS_FAILURE",
  "FIXTURE_INVALID",
  "ROUTE_DISCOVERY_INVALID",
  "TRANSPORT_FAILURE",
  "PRODUCT_SERVER_FAILURE",
  "PRODUCT_OR_FIXTURE_FAILURE",
  "UNVERIFIED",
]);

const REQUIRED_INVENTORY_SENTINELS = [
  "api:GET:/api/avatar/meta",
  "api:GET:/api/content/crew",
  "api:GET:/api/content/pipelines",
  "api:GET:/api/employee-workbench/content/:idx",
];

const PHANTOM_INVENTORY_SENTINELS = [
  "api:GET:/api/avatar/stats",
  "api:GET:/api/avatar/calendar-sync",
  "api:GET:/api/content/runs",
  "api:GET:/api/employee-workbench/content/restaurant/:idx",
];

function cleanText(value, limit = 320) {
  return String(value ?? "")
    .replace(SECRET, "[REDACTED]")
    .replace(QUERY_SECRET, "$1[REDACTED]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function historicalVerdictLabel(verdict) {
  const normalized = cleanText(verdict || "", 120);
  return HISTORICAL_VERDICT_LABELS[normalized] || "历史业务记录未通过";
}

function historicalSubtypeLabel(subtype) {
  const normalized = cleanText(subtype || "", 120);
  return HISTORICAL_SUBTYPE_LABELS[normalized] || "历史业务记录异常";
}

function inferredHistoricalRunId(issue, message) {
  const direct =
    issue?.runId ??
    issue?.run_id ??
    issue?.taskId ??
    issue?.task_id ??
    issue?.jobId ??
    issue?.job_id;
  if (direct != null && String(direct).trim()) return cleanText(direct, 120);
  const match = String(message || "").match(
    /(?:任务|运行|run|job)\s*#?\s*(\d+)/iu,
  );
  return match?.[1] ? cleanText(match[1], 120) : null;
}

function inferredHistoricalSourceDate(issue, message) {
  const direct =
    issue?.sourceDate ??
    issue?.source_date ??
    issue?.observedAt ??
    issue?.occurredAt ??
    issue?.createdAt ??
    issue?.updatedAt ??
    issue?.finishedAt ??
    issue?.completedAt;
  if (direct != null && String(direct).trim()) return cleanText(direct, 80);
  const match = String(message || "").match(
    /\b(20\d{2}-\d{2}-\d{2})(?:[T ][0-9:.+-Z]+)?/u,
  );
  return match?.[0] ? cleanText(match[0], 80) : null;
}

function sourceMeta(name, report, supplied = {}) {
  supplied = objectOrEmpty(supplied);
  return {
    name,
    label: SOURCE_LABELS[name] || name,
    path: supplied.path || null,
    bytes: numeric(supplied.bytes),
    sha256: supplied.sha256 || null,
    schemaVersion: report?.schemaVersion || null,
    generatedAt:
      report?.generatedAt ||
      report?.summary?.generatedAt ||
      report?.updatedAt ||
      report?.finishedAt ||
      null,
    status: "authoritative",
    evidenceScope: "current",
    family: name,
    reason: "输入结构与本次可复现报告契约一致。",
    invalidatedEntries: 0,
    diagnostics: {},
  };
}

function outputText(row) {
  const output = row?.output;
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    return [output.bodyPreview, output.error, output.message]
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function inspectLegacyProbe(report) {
  const rows = arrayOrEmpty(report?.features || report?.results);
  const diagnostics = {
    rowCount: rows.length,
    revokedSessionCount: 0,
    routeDiscoveryInvalidCount: 0,
    fixtureInvalidCount: 0,
    twoHundredButJsonInvalidCount: 0,
  };
  for (const row of rows) {
    const text = outputText(row);
    if (REVOKED.test(text)) diagnostics.revokedSessionCount += 1;
    if (ROUTE_NOT_FOUND.test(text)) diagnostics.routeDiscoveryInvalidCount += 1;
    if (INVALID_FIXTURE.test(text)) diagnostics.fixtureInvalidCount += 1;
    if (
      Number(row?.output?.status) >= 200 &&
      Number(row?.output?.status) < 300 &&
      row?.output?.jsonValid === false
    ) {
      diagnostics.twoHundredButJsonInvalidCount += 1;
    }
  }
  return diagnostics;
}

function validateInventory(report, supplied) {
  const meta = sourceMeta("inventory", report, supplied);
  const rows = arrayOrEmpty(report?.features);
  const orderedIds = rows.map((row) => String(row?.id || "")).filter(Boolean);
  const ids = new Set(orderedIds);
  const duplicateIds = [
    ...new Set(
      orderedIds.filter((id, index) => orderedIds.indexOf(id) !== index),
    ),
  ];
  const missing = REQUIRED_INVENTORY_SENTINELS.filter((id) => !ids.has(id));
  const phantoms = PHANTOM_INVENTORY_SENTINELS.filter((id) => ids.has(id));
  const schemaOk =
    report?.schemaVersion === "nanowork.full-feature-inventory.v1";
  meta.diagnostics = {
    featureCount: rows.length,
    missingRequiredRoutes: missing,
    phantomRoutes: phantoms,
    duplicateIds: duplicateIds.slice(0, 20),
  };
  if (
    !schemaOk ||
    !rows.length ||
    missing.length ||
    phantoms.length ||
    duplicateIds.length
  ) {
    meta.status = "superseded_invalid";
    meta.evidenceScope = "invalid";
    meta.invalidatedEntries = rows.length;
    meta.reason = [
      !schemaOk ? "不是 nanowork.full-feature-inventory.v1 修正清单" : "",
      !rows.length ? "没有功能入口" : "",
      missing.length ? `缺少 ${missing.length} 个真实路由` : "",
      phantoms.length ? `包含 ${phantoms.length} 个串 mount 伪路由` : "",
      duplicateIds.length ? `包含 ${duplicateIds.length} 个重复入口` : "",
    ]
      .filter(Boolean)
      .join("；");
  }
  return meta;
}

function validateProbe(name, report, supplied) {
  const meta = sourceMeta(name, report, supplied);
  const rows = arrayOrEmpty(report?.results);
  const diagnostics = inspectLegacyProbe(report);
  const ids = rows.map((row) => String(row?.id || "")).filter(Boolean);
  const duplicateIds = [
    ...new Set(ids.filter((id, index) => ids.indexOf(id) !== index)),
  ];
  const wrongMethodCount = rows.filter((row) => {
    const method = String(
      row?.input?.method || row?.method || "",
    ).toUpperCase();
    return name === "get" ? method !== "GET" : !method || method === "GET";
  }).length;
  const invalidSemanticRowCount = rows.filter((row) => {
    const verdict = String(row?.quality?.verdict || "");
    const hasIdentity = Boolean(
      row?.id && (row?.route || row?.input?.route || row?.input?.urlPath),
    );
    const hasRequiredOutput =
      verdict === "SAFETY_NOT_EXECUTED" ||
      (row?.output && typeof row.output === "object");
    return (
      !hasIdentity || !VALID_PROBE_VERDICTS.has(verdict) || !hasRequiredOutput
    );
  }).length;
  Object.assign(diagnostics, {
    duplicateIds: duplicateIds.slice(0, 20),
    wrongMethodCount,
    invalidSemanticRowCount,
  });
  meta.diagnostics = diagnostics;
  const schemaOk = report?.schemaVersion === "nanowork.http-feature-probe.v2";
  const rowShapeOk =
    rows.length > 0 &&
    !duplicateIds.length &&
    wrongMethodCount === 0 &&
    invalidSemanticRowCount === 0;
  if (!schemaOk || !rowShapeOk) {
    meta.status = "superseded_invalid";
    meta.evidenceScope = "invalid";
    meta.invalidatedEntries = diagnostics.rowCount;
    const reasons = ["不是 nanowork.http-feature-probe.v2 可复现语义报告"];
    if (diagnostics.revokedSessionCount)
      reasons.push(
        `含 ${diagnostics.revokedSessionCount} 个被测试器吊销的会话响应`,
      );
    if (diagnostics.routeDiscoveryInvalidCount)
      reasons.push(`含 ${diagnostics.routeDiscoveryInvalidCount} 个不存在路由`);
    if (diagnostics.fixtureInvalidCount)
      reasons.push(`含 ${diagnostics.fixtureInvalidCount} 个无效 fixture`);
    if (duplicateIds.length)
      reasons.push(`含 ${duplicateIds.length} 个重复入口`);
    if (wrongMethodCount) reasons.push(`含 ${wrongMethodCount} 个方法分组错误`);
    if (invalidSemanticRowCount)
      reasons.push(`含 ${invalidSemanticRowCount} 个语义字段不完整的条目`);
    meta.reason = reasons.join("；");
  }
  return meta;
}

function validateWeb(report, supplied) {
  const meta = sourceMeta("web", report, supplied);
  const rows = arrayOrEmpty(report?.results || report?.routes);
  const semanticRows = rows.filter((row) =>
    VALID_PROBE_VERDICTS.has(String(row?.quality?.verdict || "")),
  );
  const shellRows = rows.filter(
    (row) => row?.quality?.verdict === "PASS_PAGE_ROUTE",
  );
  const uniqueBodies = new Set(
    shellRows.map((row) => `${row?.output?.bytes}:${row?.output?.title}`),
  );
  const invalidSemanticRowCount = rows.filter((row) => {
    const verdict = String(row?.quality?.verdict || "");
    const hasIdentity = Boolean(
      row?.id && (row?.path || row?.input?.path || row?.input?.urlPath),
    );
    const hasRequiredOutput =
      verdict === "SAFETY_NOT_EXECUTED" ||
      (row?.output && typeof row.output === "object");
    const renderedWhenPassing =
      verdict !== "HAPPY_PATH_PASS" ||
      row?.output?.rendered === true ||
      row?.output?.renderedPage === true;
    return (
      !hasIdentity ||
      !VALID_PROBE_VERDICTS.has(verdict) ||
      !hasRequiredOutput ||
      !renderedWhenPassing
    );
  }).length;
  meta.diagnostics = {
    rowCount: rows.length,
    semanticRowCount: semanticRows.length,
    shellOnlyRowCount: shellRows.length,
    uniqueShellCount: uniqueBodies.size,
    hasRootFalseCount: shellRows.filter((row) => row?.output?.hasRoot === false)
      .length,
    invalidSemanticRowCount,
  };
  const schemaOk = report?.schemaVersion === "nanowork.web-route-report.v2";
  if (
    !schemaOk ||
    !rows.length ||
    semanticRows.length !== rows.length ||
    invalidSemanticRowCount
  ) {
    meta.status = "superseded_invalid";
    meta.evidenceScope = "invalid";
    meta.invalidatedEntries = rows.length;
    meta.reason = shellRows.length
      ? `仅校验 SPA HTML 壳（${shellRows.length} 条），未证明页面渲染、权限和业务交互`
      : "缺少 web-route-report.v2 页面语义证据";
  }
  return meta;
}

function employeeLatestRows(report) {
  return Object.values(objectOrEmpty(report?.jobs)).map((entry) =>
    objectOrEmpty(
      entry?.latest || arrayOrEmpty(entry?.attempts).at(-1) || entry,
    ),
  );
}

function hasLegacyJsonFalseNegative(row) {
  const errors = [
    ...arrayOrEmpty(row?.semanticErrors),
    ...arrayOrEmpty(row?.contractErrors),
    ...arrayOrEmpty(row?.failureReasons),
  ];
  return errors.some((error) =>
    /输出必须是JSON对象|包含单个JSON对象的字符串/iu.test(String(error)),
  );
}

function employeeInputRecordedFalse(row) {
  return arrayOrEmpty(row?.unifiedGate?.checks).some(
    (check) =>
      check?.id === "input_output_execution_cost" &&
      check?.evidence?.inputRecorded === false,
  );
}

function inspectEmployeeHistorical(report) {
  const rows = employeeLatestRows(report);
  const diagnostics = {
    rowCount: rows.length,
    completed: rows.filter((row) => row?.terminalStatus === "已完成").length,
    usable: rows.filter((row) => row?.outputStatus === "可使用").length,
    contractValid: rows.filter((row) => row?.contractValid === true).length,
    jsonFalseNegative: rows.filter(hasLegacyJsonFalseNegative).length,
    hashFalse: rows.filter((row) => row?.artifactHashValid === false).length,
    inputRecordedFalse: rows.filter(employeeInputRecordedFalse).length,
  };
  const contradictoryFalseNegatives = rows.filter(
    (row) =>
      hasLegacyJsonFalseNegative(row) &&
      (row?.terminalStatus === "已完成" ||
        row?.outputStatus === "可使用" ||
        row?.contractValid === true),
  ).length;
  const systemicThreshold = Math.max(10, Math.ceil(rows.length * 0.5));
  diagnostics.contradictoryFalseNegatives = contradictoryFalseNegatives;
  diagnostics.systemicReportFirstFalseNegative =
    rows.length >= 10 &&
    diagnostics.jsonFalseNegative >= systemicThreshold &&
    diagnostics.hashFalse >= systemicThreshold &&
    diagnostics.inputRecordedFalse >= systemicThreshold &&
    contradictoryFalseNegatives >=
      Math.ceil(diagnostics.jsonFalseNegative * 0.75);
  return diagnostics;
}

function validateHistorical(name, report, supplied, expectedSchema) {
  const meta = sourceMeta(name, report, supplied);
  const employeeDiagnostics =
    name === "employee" ? inspectEmployeeHistorical(report) : null;
  const rowCount =
    employeeDiagnostics?.rowCount ?? arrayOrEmpty(report?.results).length;
  meta.diagnostics = employeeDiagnostics || {
    rowCount,
    evidenceEpoch: "pre_upgrade",
  };
  meta.status = "historical_evidence";
  meta.evidenceScope = "historical";
  meta.reason =
    name === "content"
      ? "升级前口径的内容自动化历史证据；仅用于复盘，失败不代表当前请求或当前产品状态。"
      : "该矩阵是历史真实运行证据；失败与当前接口状态分开展示。";
  if (!report || report.schemaVersion !== expectedSchema || rowCount === 0) {
    meta.status = "superseded_invalid";
    meta.evidenceScope = "invalid";
    meta.invalidatedEntries = rowCount;
    meta.reason =
      report?.schemaVersion !== expectedSchema
        ? `缺少期望的 ${expectedSchema} 证据`
        : `${SOURCE_LABELS[name] || name}没有可验收条目`;
  } else if (
    name === "employee" &&
    employeeDiagnostics.systemicReportFirstFalseNegative
  ) {
    meta.status = "superseded_invalid";
    meta.evidenceScope = "invalid";
    meta.invalidatedEntries = rowCount;
    meta.reason =
      `升级前矩阵存在系统性 report-first 测试器假阴性：` +
      `${employeeDiagnostics.jsonFalseNegative} 条被同一 JSON 解析门误判，` +
      `同时有 ${employeeDiagnostics.completed} 条已完成、${employeeDiagnostics.usable} 条可使用、` +
      `${employeeDiagnostics.contractValid} 条契约有效；整源作废，不能作为 0/${rowCount} 的产品结论。`;
  }
  return meta;
}

function validIsoTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function businessFeatureRows(report) {
  return Object.entries(objectOrEmpty(report?.jobs)).map(([key, value]) => ({
    key,
    row: objectOrEmpty(
      value?.latest || arrayOrEmpty(value?.attempts).at(-1) || value,
    ),
  }));
}

function validateBusinessFeature(report, supplied) {
  const meta = sourceMeta("businessFeature", report, supplied);
  meta.family = "business_function";
  const rows = businessFeatureRows(report);
  const passed = rows.filter(({ row }) => row?.pass === true).length;
  const failed = rows.filter(({ row }) => row?.pass !== true).length;
  const summary = objectOrEmpty(report?.summary);
  const asOf = validIsoTimestamp(
    report?.updatedAt || report?.createdAt || report?.generatedAt,
  );
  const duplicateKeys = rows
    .map(({ row, key }) => cleanText(row?.featureKey || key, 180))
    .filter((key, index, values) => values.indexOf(key) !== index);
  const invalidRows = rows.filter(
    ({ key, row }) =>
      !key ||
      !row?.featureKey ||
      typeof row?.pass !== "boolean" ||
      ![
        "PASS_REAL_API",
        "FAIL_REAL_API",
        "PASS_PERMISSION_BOUNDARY",
        "FAIL_PERMISSION_BOUNDARY",
      ].includes(String(row?.verdict || "")),
  ).length;
  const summaryMatches =
    Number(summary.total) === rows.length &&
    Number(summary.passed) === passed &&
    Number(summary.failed) === failed &&
    passed + failed === rows.length;
  const safetyPass = report?.finalSafetyAudit?.pass === true;
  const isolated =
    report?.runtimeEvidence?.loopbackService === true &&
    report?.runtimeEvidence?.dedicatedDatabase === true;
  const noExternalPublish = report?.evidencePolicy?.externalPublish === false;
  meta.generatedAt = asOf;
  meta.status = "historical_evidence";
  meta.evidenceScope = "historical";
  meta.reason = `${String(asOf || "日期未记录").slice(0, 10)} 真实云 API 隔离矩阵快照；只反映当时代码和专用隔离库，不作为当前通过或失败结论。`;
  meta.diagnostics = {
    rowCount: rows.length,
    passed,
    failed,
    realApiTotal: numeric(summary?.realApi?.total),
    realApiPassed: numeric(summary?.realApi?.passed),
    realApiFailed: numeric(summary?.realApi?.failed),
    permissionBoundaryTotal: numeric(summary?.permissionBoundaries?.total),
    permissionBoundaryPassed: numeric(summary?.permissionBoundaries?.passed),
    permissionBoundaryFailed: numeric(summary?.permissionBoundaries?.failed),
    l1Passed: numeric(summary?.levels?.l1Passed),
    l1Failed: numeric(summary?.levels?.l1Failed),
    l2Passed: numeric(summary?.levels?.l2Passed),
    l2Failed: numeric(summary?.levels?.l2Failed),
    summaryMatches,
    invalidRows,
    duplicateKeys: [...new Set(duplicateKeys)].slice(0, 20),
    finalSafetyAuditPass: safetyPass,
    isolatedRuntime: isolated,
    externalPublishDisabled: noExternalPublish,
  };
  if (!report) {
    meta.status = "missing_invalid";
    meta.evidenceScope = "invalid";
    meta.reason = "未提供业务功能矩阵，不得生成业务功能通过结论。";
  } else if (
    report.schemaVersion !== "nanowork.real-feature-matrix.v8" ||
    !asOf ||
    !rows.length ||
    invalidRows ||
    duplicateKeys.length ||
    !summaryMatches ||
    !safetyPass ||
    !isolated ||
    !noExternalPublish
  ) {
    meta.status = "superseded_invalid";
    meta.evidenceScope = "invalid";
    meta.invalidatedEntries = rows.length;
    const reasons = [];
    if (report.schemaVersion !== "nanowork.real-feature-matrix.v8")
      reasons.push("不是 real-feature-matrix.v8");
    if (!asOf) reasons.push("缺少可验证的来源日期");
    if (!rows.length) reasons.push("没有业务功能条目");
    if (invalidRows) reasons.push(`含 ${invalidRows} 条结构不完整记录`);
    if (duplicateKeys.length)
      reasons.push(`含 ${duplicateKeys.length} 个重复功能 key`);
    if (!summaryMatches) reasons.push("汇总与条目不一致");
    if (!safetyPass) reasons.push("最终安全审计未通过");
    if (!isolated) reasons.push("未证明 loopback 和专用隔离库");
    if (!noExternalPublish) reasons.push("未证明对外发布关闭");
    meta.reason = reasons.join("；") || "业务功能矩阵不符合证据契约。";
  }
  return meta;
}

function outputQualityRows(report) {
  return arrayOrEmpty(report?.employees);
}

function qualityEmployeeIdentity(row) {
  const employee = objectOrEmpty(row?.employee);
  const domain = cleanText(employee.domain || "unknown", 40);
  const idx = numeric(employee.idx);
  const key = cleanText(employee.key || "", 140);
  return idx == null && !key ? null : `${domain}:${idx == null ? key : idx}`;
}

function compactMatrixReference(supplied, report) {
  const reference = objectOrEmpty(objectOrEmpty(supplied).referencedMatrix);
  const declaredFromReport = cleanText(
    report?.source?.matrixSha256 || "",
    80,
  ).toLowerCase();
  const declaredFileFromReport = cleanText(
    report?.source?.matrixFile || "",
    500,
  );
  const declaredSha256 = cleanText(
    reference.declaredSha256 || declaredFromReport,
    80,
  ).toLowerCase();
  const actualSha256 = cleanText(
    reference.actualSha256 || "",
    80,
  ).toLowerCase();
  return {
    status: cleanText(reference.status || "not_checked", 80),
    reasonCode: cleanText(reference.reasonCode || "", 100) || null,
    declaredFile:
      cleanText(reference.declaredFile || declaredFileFromReport, 500) || null,
    resolvedPath: cleanText(reference.resolvedPath || "", 500) || null,
    exists: reference.exists === true,
    bytes: numeric(reference.bytes),
    declaredSha256: declaredSha256 || null,
    actualSha256: actualSha256 || null,
    hashMatches: reference.hashMatches === true,
    fileMatchesReport:
      Boolean(declaredFileFromReport) &&
      cleanText(reference.declaredFile || "", 500) === declaredFileFromReport,
    hashMatchesReport:
      Boolean(declaredFromReport) &&
      declaredSha256 === declaredFromReport &&
      actualSha256 === declaredFromReport,
  };
}

function validateOutputQuality(report, supplied, index) {
  const name = `outputQuality:${index + 1}`;
  const meta = sourceMeta(name, report, supplied);
  meta.family = "output_quality";
  meta.label = `员工输出质量历史审计 #${index + 1}`;
  const rows = outputQualityRows(report);
  const summary = objectOrEmpty(report?.summary);
  const coverage = objectOrEmpty(report?.coverage);
  const identities = rows.map(qualityEmployeeIdentity).filter(Boolean);
  const duplicateEmployees = identities.filter(
    (identity, rowIndex) => identities.indexOf(identity) !== rowIndex,
  );
  const invalidRows = rows.filter((row) => {
    const identity = qualityEmployeeIdentity(row);
    const verdict = String(row?.verdict || "");
    return (
      !identity ||
      !verdict ||
      !Array.isArray(row?.failedChecks) ||
      !Array.isArray(row?.checks)
    );
  }).length;
  const qualityPassed = rows.filter(qualityRowPass).length;
  const qualityFailed = rows.length - qualityPassed;
  const qualityCountSummaryMatches =
    Number(summary.qualityPassed) === qualityPassed &&
    Number(summary.qualityFailed) === qualityFailed &&
    qualityPassed + qualityFailed === rows.length;
  const auditedCoverageMatches =
    Number(coverage.auditedCapabilityOutputs) === rows.length;
  const summaryMatches = qualityCountSummaryMatches && auditedCoverageMatches;
  const generatedAt = validIsoTimestamp(report?.generatedAt);
  const strictPolicy =
    report?.evidencePolicy?.databaseAccess === "sqlite_read_only_query_only" &&
    Number(report?.evidencePolicy?.externalApiCalls) === 0 &&
    report?.evidencePolicy?.rawOutputIncluded === false &&
    report?.evidencePolicy?.internalProfileIncluded === false &&
    report?.evidencePolicy?.requiresStrictProviderBillingEvidence === true;
  const matrixHashValid = /^[a-f0-9]{64}$/iu.test(
    String(report?.source?.matrixSha256 || ""),
  );
  const referencedMatrix = compactMatrixReference(supplied, report);
  const matrixReferenceVerified =
    referencedMatrix.status === "verified" &&
    referencedMatrix.exists &&
    referencedMatrix.hashMatches &&
    referencedMatrix.fileMatchesReport &&
    referencedMatrix.hashMatchesReport;
  const checkRows = arrayOrEmpty(summary?.checks);
  meta.generatedAt = generatedAt;
  meta.status = "historical_evidence";
  meta.evidenceScope = "historical";
  meta.reason =
    "有效 v3 质量审计快照；仅代表该次已审计产物，不代表当前全体员工。";
  meta.diagnostics = {
    rowCount: rows.length,
    expectedEmployees: numeric(coverage.expectedEmployees),
    matrixJobs: numeric(coverage.matrixJobs),
    matrixPassed: numeric(coverage.matrixPassed),
    auditedCapabilityOutputs: numeric(coverage.auditedCapabilityOutputs),
    qualityPassed,
    qualityFailed,
    businessProductionPassed: numeric(summary.businessProductionPassed),
    operationalBlocked: numeric(summary.operationalBlocked),
    overallStatus: cleanText(summary.overallStatus || "", 120) || null,
    contractIdentityFailureCount: rows.filter((row) =>
      arrayOrEmpty(row?.failedChecks).includes("CONTRACT_IDENTITY"),
    ).length,
    placeholderFailureCount:
      numeric(
        checkRows.find((row) => row?.code === "REAL_OUTPUT_NOT_PLACEHOLDER")
          ?.failed,
      ) || 0,
    qualityCountSummaryMatches,
    auditedCoverageMatches,
    summaryMatches,
    invalidRows,
    duplicateEmployees: [...new Set(duplicateEmployees)].slice(0, 20),
    strictPolicy,
    matrixHashValid,
    matrixReferenceVerified,
    referencedMatrix,
    selectedForConclusion: false,
  };
  if (!report) {
    meta.status = "missing_invalid";
    meta.evidenceScope = "invalid";
    meta.reason = "未提供员工输出质量审计，不得生成质量通过结论。";
  } else if (
    report.schemaVersion !== "nanowork.employee-output-quality-audit.v3" ||
    !generatedAt ||
    !rows.length ||
    invalidRows ||
    duplicateEmployees.length ||
    !summaryMatches ||
    !strictPolicy ||
    !matrixHashValid ||
    !matrixReferenceVerified
  ) {
    meta.status = "superseded_invalid";
    meta.evidenceScope = "invalid";
    meta.invalidatedEntries = rows.length;
    const reasons = [];
    if (report.schemaVersion !== "nanowork.employee-output-quality-audit.v3") {
      reasons.push(
        "旧 v1 口径已被 v3 的真实 API、结算、运营阻断和 report-first 复验取代",
      );
    }
    if (!generatedAt) reasons.push("缺少可验证的生成时间");
    if (!rows.length) reasons.push("没有员工审计条目");
    if (invalidRows) reasons.push(`含 ${invalidRows} 条语义字段不完整的记录`);
    if (duplicateEmployees.length)
      reasons.push(`含 ${duplicateEmployees.length} 个重复员工`);
    if (!qualityCountSummaryMatches)
      reasons.push("质量通过/失败汇总与员工条目不一致");
    if (!auditedCoverageMatches)
      reasons.push("缺少或不匹配 v3 auditedCapabilityOutputs 覆盖证据");
    if (!strictPolicy) reasons.push("缺少 v3 严格供应商/结算/脱敏证据策略");
    if (!matrixHashValid) reasons.push("缺少有效的来源矩阵 SHA-256");
    if (!matrixReferenceVerified) {
      if (referencedMatrix.status === "unsafe_path") {
        reasons.push("source.matrixFile 路径不安全，已拒绝读取");
      } else if (referencedMatrix.status === "missing") {
        reasons.push("引用矩阵不存在，无法复现该质量审计");
      } else if (referencedMatrix.status === "hash_mismatch") {
        reasons.push(
          `source.matrixSha256 与引用矩阵实算 SHA-256 不匹配（声明 ${referencedMatrix.declaredSha256 || "-"}；实算 ${referencedMatrix.actualSha256 || "-"}）`,
        );
      } else if (referencedMatrix.status === "declared_hash_invalid") {
        reasons.push("source.matrixSha256 不是有效的 64 位 SHA-256");
      } else if (referencedMatrix.status === "unreadable") {
        reasons.push("引用矩阵不可读取，无法复现该质量审计");
      } else if (referencedMatrix.status === "invalid_reference") {
        reasons.push("缺少有效的 source.matrixFile 引用");
      } else if (
        !referencedMatrix.fileMatchesReport ||
        !referencedMatrix.hashMatchesReport
      ) {
        reasons.push("引用矩阵校验元数据与质量报告 source 声明不一致");
      } else {
        reasons.push("未提供可复现的引用矩阵读取与实算哈希校验");
      }
    }
    if (meta.diagnostics.contractIdentityFailureCount) {
      reasons.push(
        `含 ${meta.diagnostics.contractIdentityFailureCount} 条契约身份失败，旧 report-first 口径不可作为当前结论`,
      );
    }
    meta.reason = reasons.join("；") || "员工输出质量证据不符合当前契约。";
  }
  return meta;
}

function selectLatestQualitySource(sources) {
  const valid = sources
    .filter((source) => source.status === "historical_evidence")
    .sort((left, right) => {
      const timeDifference =
        Date.parse(right.generatedAt) - Date.parse(left.generatedAt);
      if (timeDifference) return timeDifference;
      return String(right.sha256 || right.path || right.name).localeCompare(
        String(left.sha256 || left.path || left.name),
      );
    });
  const selected = valid[0] || null;
  for (const source of valid) {
    source.diagnostics.selectedForConclusion = source === selected;
    if (source !== selected) {
      source.reason =
        "有效 v3 历史审计，但已有生成时间更新的 v3 证据；仅留档，不覆盖首页结论。";
    }
  }
  return selected;
}

function categoryFromProbe(row) {
  const verdict = String(row?.quality?.verdict || "");
  if (verdict === "HAPPY_PATH_PASS") return "positive_pass";
  if (verdict === "NEGATIVE_BOUNDARY_PASS") return "negative_boundary";
  if (
    [
      "AUTH_HARNESS_FAILURE",
      "FIXTURE_INVALID",
      "ROUTE_DISCOVERY_INVALID",
    ].includes(verdict)
  )
    return "harness_invalid";
  if (verdict === "SAFETY_NOT_EXECUTED") return "safety_not_executed";
  if (verdict === "UNVERIFIED") return "unverified";
  return "product_failure";
}

function compactShape(shape) {
  if (!shape || typeof shape !== "object") return null;
  return {
    kind: cleanText(shape.kind, 40) || null,
    count: numeric(shape.count),
    keys: arrayOrEmpty(shape.keys)
      .map((key) => cleanText(key, 80))
      .filter((key) => key && !SENSITIVE_FIELD_NAME.test(key))
      .slice(0, 30),
  };
}

function compactProbeItem(row, source) {
  const input = objectOrEmpty(row?.input);
  const output = objectOrEmpty(row?.output);
  const quality = objectOrEmpty(row?.quality);
  const body = input.body && typeof input.body === "object" ? input.body : null;
  return {
    id: cleanText(
      row?.id || `api:${input.method || ""}:${row?.route || ""}`,
      240,
    ),
    source,
    scope: "current",
    category: categoryFromProbe(row),
    title:
      `${cleanText(input.method || "HTTP", 16)} ${cleanText(row?.route || input.route || input.urlPath || "", 220)}`.trim(),
    input: {
      method: cleanText(input.method || "", 16) || null,
      route: cleanText(row?.route || input.route || "", 240) || null,
      urlPath: cleanText(input.urlPath || "", 320) || null,
      intent: cleanText(input.intent || "", 80) || null,
      role: cleanText(input.role || "", 80) || null,
      tenantId: numeric(input.tenantId),
      bodyFields: body
        ? Object.keys(body)
            .map((key) => cleanText(key, 80))
            .filter((key) => key && !SENSITIVE_FIELD_NAME.test(key))
            .slice(0, 40)
        : [],
      bodyBytes: body ? Buffer.byteLength(JSON.stringify(body)) : 0,
    },
    output: row?.output
      ? {
          status: numeric(output.status),
          contentType: cleanText(output.contentType || "", 120) || null,
          bytes: numeric(output.bytes),
          bodySha256: cleanText(output.bodySha256 || "", 80) || null,
          jsonValid:
            typeof output.jsonValid === "boolean" ? output.jsonValid : null,
          shape: compactShape(output.shape),
          preview: cleanText(output.bodyPreview || "", 280) || null,
        }
      : null,
    quality: {
      verdict: cleanText(quality.verdict || "", 100),
      pass: quality.pass === true,
      happyPathPass: quality.happyPathPass === true,
      reachedTargetHandler: quality.reachedTargetHandler === true,
      score: numeric(quality.score),
      authRecoveryCount: numeric(quality.authRecoveryCount),
    },
    timing: {
      startedAt: row?.startedAt || null,
      completedAt: row?.completedAt || null,
    },
  };
}

function compactWebItem(row, inventoryRow = null) {
  const input = objectOrEmpty(row?.input);
  const output = objectOrEmpty(row?.output);
  const quality = objectOrEmpty(row?.quality);
  const verdict = String(quality.verdict || "");
  const category = categoryFromProbe(row);
  const path = cleanText(row?.path || input.path || input.urlPath || "", 240);
  return {
    id: inventoryRow?.id || cleanText(row?.id || `web:${path}`, 260),
    source: "web",
    scope: "current",
    category,
    title: inventoryRow?.label
      ? cleanText(inventoryRow.label, 120)
      : `页面 ${path}`,
    input: {
      path,
      role: cleanText(input.role || "", 80) || null,
      action: cleanText(input.action || "打开页面并验证关键交互", 180),
    },
    output: {
      status: numeric(output.status),
      title: cleanText(output.title || "", 160) || null,
      rendered: output.rendered === true || output.renderedPage === true,
      keyElements: arrayOrEmpty(output.keyElements)
        .map((item) => cleanText(item, 120))
        .slice(0, 20),
      preview:
        cleanText(output.bodyPreview || output.summary || "", 280) || null,
    },
    quality: {
      verdict: cleanText(verdict, 100),
      pass: quality.pass === true,
      happyPathPass: quality.happyPathPass === true,
      score: numeric(quality.score),
    },
  };
}

function compactEmployeeItem(key, entry) {
  const latest = objectOrEmpty(
    entry?.latest || arrayOrEmpty(entry?.attempts).at(-1) || entry,
  );
  const pass = latest.pass === true || latest.unifiedGate?.pass === true;
  const failedChecks = arrayOrEmpty(latest.unifiedGate?.failedChecks).map(
    (item) => cleanText(item, 100),
  );
  const businessReason =
    arrayOrEmpty(latest.semanticErrors)[0] ||
    arrayOrEmpty(latest.failureReasons)[0] ||
    historicalVerdictLabel(latest.verdict);
  const runId =
    latest.runId ??
    latest.attemptId ??
    latest.invocationId ??
    latest.businessId ??
    null;
  return {
    id: `employee:${key}`,
    source: "employee",
    scope: "historical",
    category: pass ? "historical_pass" : "historical_failure",
    title: cleanText(latest.employeeName || latest.taskTitle || key, 180),
    input: {
      employeeId: cleanText(latest.employeeId || key, 120),
      employeeName: cleanText(latest.employeeName || "", 120) || null,
      task:
        cleanText(latest.taskTitle || latest.acceptanceDemand || "", 300) ||
        null,
      profileVersion: cleanText(latest.profileVersion || "", 160) || null,
    },
    output: {
      terminalStatus:
        cleanText(
          latest.terminalStatus || latest.generationStatus || "",
          100,
        ) || null,
      outputStatus: cleanText(latest.outputStatus || "", 100) || null,
      businessFlowStatus:
        cleanText(latest.businessFlowStatus || "", 100) || null,
      artifactCount: numeric(latest.artifactCount),
      resultChars: numeric(latest.resultChars),
      runId: runId == null ? null : cleanText(runId, 120),
    },
    quality: {
      verdict: cleanText(latest.verdict || "", 100),
      businessReason: cleanText(businessReason, 260),
      pass,
      failedChecks,
      semanticErrors: arrayOrEmpty(latest.semanticErrors)
        .map((item) => cleanText(item, 220))
        .slice(0, 8),
      provider:
        cleanText(latest.providerModel || latest.model || "", 120) || null,
      inputTokens: numeric(latest.inputTokens || latest.providerInputTokens),
      outputTokens: numeric(latest.outputTokens || latest.providerOutputTokens),
      chargedCredits: numeric(latest.chargedCredits),
      chargedCostYuan: numeric(latest.chargedCostYuan),
    },
    timing: {
      startedAt: latest.startedAt || null,
      completedAt: latest.finishedAt || null,
    },
  };
}

function compactContentItem(row) {
  const evidence = objectOrEmpty(row?.evidence);
  const employee = objectOrEmpty(evidence.employee);
  const run = objectOrEmpty(evidence.run);
  const provider = objectOrEmpty(evidence.provider);
  const pass = row?.pass === true;
  const businessReason =
    arrayOrEmpty(row?.errors)[0] || historicalVerdictLabel(row?.verdict);
  return {
    id: `content-matrix:${cleanText(row?.jobKey || "unknown", 180)}`,
    source: "content",
    scope: "historical",
    category: pass ? "historical_pass" : "historical_failure",
    title: `${cleanText(employee.name || "内容员工", 100)}·${cleanText(employee.taskType || evidence.mode || row?.jobKey || "", 140)}`,
    input: {
      jobKey: cleanText(row?.jobKey || "", 180),
      employeeIdx: numeric(employee.idx),
      mode: cleanText(evidence.mode || "", 80) || null,
      trigger: cleanText(run.trigger || "", 80) || null,
    },
    output: {
      runId: numeric(run.id),
      status: cleanText(run.status || "", 100) || null,
      contentId: numeric(run.contentId),
      contractValid:
        typeof run.contract?.valid === "boolean" ? run.contract.valid : null,
      billingState: cleanText(run.billing?.state || "", 100) || null,
      sourceDate:
        cleanText(row?.finishedAt || row?.startedAt || "", 80) || null,
    },
    quality: {
      verdict: cleanText(row?.verdict || "", 120),
      businessReason: cleanText(businessReason, 260),
      pass,
      errors: arrayOrEmpty(row?.errors)
        .map((item) => cleanText(item, 260))
        .slice(0, 10),
      provider: cleanText(provider.model || provider.mode || "", 120) || null,
      inputTokens: numeric(provider.inputTokens),
      outputTokens: numeric(provider.outputTokens),
      chargedCredits: numeric(run.billing?.chargedCredits),
    },
    timing: {
      startedAt: row?.startedAt || null,
      completedAt: row?.finishedAt || null,
    },
  };
}

function compactBusinessFeatureItem(key, entry) {
  const row = objectOrEmpty(
    entry?.latest || arrayOrEmpty(entry?.attempts).at(-1) || entry,
  );
  const pass = row?.pass === true;
  const reason =
    arrayOrEmpty(row?.failureReasons)[0] ||
    arrayOrEmpty(row?.l1FailureReasons)[0] ||
    arrayOrEmpty(row?.l2FailureReasons)[0] ||
    arrayOrEmpty(row?.semanticErrors)[0] ||
    historicalVerdictLabel(row?.verdict);
  const runId = row?.attemptId ?? row?.runId ?? row?.businessId ?? null;
  return {
    id: `business-feature:${cleanText(row?.featureKey || key, 180)}`,
    source: "businessFeature",
    scope: "historical",
    category: pass ? "historical_pass" : "historical_failure",
    title: cleanText(row?.featureTitle || row?.featureKey || key, 180),
    input: {
      featureKey: cleanText(row?.featureKey || key, 180),
      category: cleanText(row?.category || "", 80) || null,
      role: cleanText(row?.role || "", 80) || null,
      method: cleanText(row?.method || "", 20) || null,
      endpoint:
        cleanText(row?.endpoint || row?.endpointTemplate || "", 260) || null,
    },
    output: {
      terminalStatus: cleanText(row?.terminalStatus || "", 100) || null,
      httpStatus: numeric(row?.httpStatus),
      resultChars: numeric(row?.resultChars),
      resultHash: cleanText(row?.resultHash || "", 80) || null,
      model: cleanText(row?.model || "", 120) || null,
      inputTokens: numeric(row?.inputTokens),
      outputTokens: numeric(row?.outputTokens),
      chargedCredits: numeric(row?.chargedCredits),
      costYuan: numeric(row?.costYuan),
      runId: runId == null ? null : cleanText(runId, 120),
      sourceDate:
        cleanText(row?.finishedAt || row?.startedAt || "", 80) || null,
    },
    quality: {
      verdict: cleanText(row?.verdict || "", 100),
      businessReason: cleanText(reason, 300),
      pass,
      l1Pass: row?.l1Pass === true,
      l2Pass: row?.l2Pass === true,
      contractValid:
        typeof row?.contractValid === "boolean" ? row.contractValid : null,
      persistent: typeof row?.persistent === "boolean" ? row.persistent : null,
      failureReasons: arrayOrEmpty(row?.failureReasons)
        .map((item) => cleanText(item, 240))
        .slice(0, 8),
      semanticErrors: arrayOrEmpty(row?.semanticErrors)
        .map((item) => cleanText(item, 240))
        .slice(0, 8),
    },
    timing: {
      startedAt: row?.startedAt || null,
      completedAt: row?.finishedAt || null,
    },
  };
}

function qualityRowPass(row) {
  const verdict = String(row?.verdict || "");
  const declaredPass =
    row?.capabilityPass === true ||
    [
      "PASS_QUALITY",
      "PASS_CAPABILITY",
      "PASS_CAPABILITY_OPERATIONALLY_BLOCKED",
    ].includes(verdict);
  return declaredPass && arrayOrEmpty(row?.failedChecks).length === 0;
}

function compactOutputQualityItem(row, report, sourceMetaEntry) {
  const employee = objectOrEmpty(row?.employee);
  const identity = qualityEmployeeIdentity(row) || stableHash(row).slice(0, 16);
  const pass = qualityRowPass(row);
  const failedChecks = arrayOrEmpty(row?.failedChecks)
    .map((item) => cleanText(item, 100))
    .slice(0, 12);
  const checks = arrayOrEmpty(row?.checks)
    .map((check) => ({
      code: cleanText(check?.code || "", 100),
      label: cleanText(check?.label || "", 120),
      status: cleanText(check?.status || "", 40),
    }))
    .slice(0, 16);
  const reason = pass
    ? row?.operationalBlocked === true
      ? "质量能力通过，但业务生产条件被阻断"
      : "历史质量能力审计通过"
    : failedChecks.length
      ? `历史质量审计未通过：${failedChecks.join("、")}`
      : "历史质量审计未通过";
  return {
    id: `output-quality:${identity}`,
    source: "employeeOutputQuality",
    sourceEvidence: sourceMetaEntry.name,
    scope: "historical",
    category: pass ? "historical_pass" : "historical_failure",
    title: cleanText(employee.name || employee.key || identity, 180),
    input: {
      domain: cleanText(employee.domain || "", 60) || null,
      employeeIdx: numeric(employee.idx),
      employeeKey: cleanText(employee.key || "", 160) || null,
      sourceMatrix: cleanText(report?.source?.matrixFile || "", 240) || null,
      sourceMatrixSha256:
        cleanText(report?.source?.matrixSha256 || "", 80) || null,
    },
    output: {
      capabilityPass: row?.capabilityPass === true,
      businessProductionPass: row?.businessProductionPass === true,
      operationalBlocked: row?.operationalBlocked === true,
      operationalReady: row?.operationalReady === true,
      sourceDate: sourceMetaEntry.generatedAt,
      runId:
        (numeric(employee.idx) ?? cleanText(employee.key || "", 120)) || null,
    },
    quality: {
      verdict: cleanText(row?.verdict || "", 120),
      businessReason: cleanText(reason, 300),
      pass,
      failedChecks,
      checks,
    },
  };
}

function businessFunctionConclusion(meta, report) {
  if (meta.status !== "historical_evidence") {
    return {
      scope: "invalid",
      status: meta.status,
      asOf: meta.generatedAt || null,
      conclusionCode:
        meta.status === "missing_invalid"
          ? "MISSING_EVIDENCE"
          : "INVALID_SUPERSEDED_EVIDENCE",
      total: 0,
      passed: 0,
      failed: 0,
      realApiPassed: 0,
      realApiTotal: 0,
      permissionBoundaryPassed: 0,
      permissionBoundaryTotal: 0,
      rerunRequired: true,
      rerunReason: meta.reason,
    };
  }
  const summary = objectOrEmpty(report?.summary);
  const date = String(meta.generatedAt || "").slice(0, 10) || "未记录日期";
  const failed = Number(summary.failed) || 0;
  return {
    scope: "historical",
    status: meta.status,
    asOf: meta.generatedAt,
    conclusionCode:
      failed > 0
        ? "HISTORICAL_PARTIAL_FAILURES_REQUIRE_RERUN"
        : "HISTORICAL_PASS_REQUIRES_RERUN",
    total: Number(summary.total) || 0,
    passed: Number(summary.passed) || 0,
    failed,
    realApiPassed: Number(summary?.realApi?.passed) || 0,
    realApiTotal: Number(summary?.realApi?.total) || 0,
    permissionBoundaryPassed:
      Number(summary?.permissionBoundaries?.passed) || 0,
    permissionBoundaryTotal: Number(summary?.permissionBoundaries?.total) || 0,
    rerunRequired: true,
    rerunReason: `证据为 ${date} 的历史隔离矩阵，需在当前代码与专用隔离库上重跑后才能形成当前结论。`,
  };
}

function outputQualityConclusion(sources, selectedSource, reports) {
  const invalidSources = sources.filter(
    (source) => source.status === "superseded_invalid",
  );
  if (!selectedSource) {
    const missing = sources.find(
      (source) => source.status === "missing_invalid",
    );
    return {
      scope: "invalid",
      status: missing ? "missing_invalid" : "superseded_invalid",
      conclusionCode: missing
        ? "MISSING_EVIDENCE"
        : "INVALID_SUPERSEDED_EVIDENCE",
      latestEvidenceAt: null,
      selectedSource: null,
      distinctAuditedEmployees: 0,
      qualityPassed: 0,
      qualityFailed: 0,
      businessProductionPassed: 0,
      operationalBlocked: 0,
      validHistoricalSources: 0,
      supersededInvalidSources: invalidSources.length,
      rerunRequired: true,
      rerunReason:
        missing?.reason ||
        "所有输出质量证据均已作废，需使用当前 v3 审计器重跑。",
    };
  }
  const selectedIndex = sources.indexOf(selectedSource);
  const selectedReport = reports[selectedIndex];
  const rows = outputQualityRows(selectedReport);
  const summary = objectOrEmpty(selectedReport?.summary);
  return {
    scope: "historical",
    status: "historical_evidence",
    conclusionCode: "HISTORICAL_PARTIAL_OUTPUT_QUALITY_REQUIRES_RERUN",
    latestEvidenceAt: selectedSource.generatedAt,
    selectedSource: {
      name: selectedSource.name,
      path: selectedSource.path,
      sha256: selectedSource.sha256,
      schemaVersion: selectedSource.schemaVersion,
    },
    distinctAuditedEmployees: new Set(
      rows.map(qualityEmployeeIdentity).filter(Boolean),
    ).size,
    qualityPassed: Number(summary.qualityPassed) || 0,
    qualityFailed: Number(summary.qualityFailed) || 0,
    businessProductionPassed: Number(summary.businessProductionPassed) || 0,
    operationalBlocked: Number(summary.operationalBlocked) || 0,
    validHistoricalSources: sources.filter(
      (source) => source.status === "historical_evidence",
    ).length,
    supersededInvalidSources: invalidSources.length,
    rerunRequired: true,
    rerunReason: `首页只采用最新有效 v3 历史审计（${String(selectedSource.generatedAt || "").slice(0, 10)}）；当前全量员工与业务生产就绪状态仍需重跑。`,
  };
}

function collectHistoricalFindings(probeItems, probeRows) {
  const grouped = new Map();
  probeRows.forEach((row, index) => {
    const issues = arrayOrEmpty(row?.output?.historicalIssues);
    for (const issue of issues) {
      const message = cleanText(issue?.message || "", 300);
      if (!message) continue;
      const subtype = cleanText(
        issue?.category || "historical_business_failure",
        100,
      );
      const businessLabel = historicalSubtypeLabel(subtype);
      const sourceDate = inferredHistoricalSourceDate(issue, message);
      const runId = inferredHistoricalRunId(issue, message);
      const key = `${subtype}:${message}:${sourceDate || "unknown-date"}:${runId || "unknown-run"}`;
      const observedId = probeItems[index]?.id || cleanText(row?.id || "", 200);
      const existing = grouped.get(key) || {
        id: `history:${stableHash(key).slice(0, 16)}`,
        source: "api_response_history",
        scope: "historical",
        category: "historical_failure",
        title: businessLabel,
        input: { observedIn: [], occurrences: 0 },
        output: {
          subtype,
          businessReason: `${businessLabel}：${message}`,
          message,
          sourceDate,
          runId,
          sourcePath: cleanText(issue?.path || "", 240) || null,
        },
        quality: {
          verdict: "HISTORICAL_RECORD_ONLY",
          businessReason: `${businessLabel}：${message}`,
          pass: false,
          currentRequestFailed: false,
        },
      };
      existing.input.occurrences += 1;
      if (
        observedId &&
        existing.input.observedIn.length < 30 &&
        !existing.input.observedIn.includes(observedId)
      ) {
        existing.input.observedIn.push(observedId);
      }
      grouped.set(key, existing);
    }
  });
  return [...grouped.values()];
}

function sourceInvalidItem(meta) {
  return {
    id: `invalid-source:${meta.name}`,
    source: meta.name,
    scope: "current",
    category: "harness_invalid",
    title: `${meta.label || meta.name}已作废`,
    input: {
      path: meta.path,
      schemaVersion: meta.schemaVersion,
    },
    output: {
      invalidatedEntries: meta.invalidatedEntries,
      diagnostics: meta.diagnostics,
    },
    quality: {
      verdict: "SUPERSEDED_INVALID_SOURCE",
      pass: false,
      reason: meta.reason,
    },
  };
}

function supersededArtifactItem(entry, index) {
  const object =
    typeof entry === "string" ? { path: entry } : objectOrEmpty(entry);
  return {
    id: `superseded-artifact:${index + 1}`,
    source: "superseded_artifact",
    scope: "current",
    category: "harness_invalid",
    title: "旧污染报告已作废",
    input: { path: cleanText(object.path || object.name || "", 500) || null },
    output: {
      replacement: cleanText(object.replacement || "本次可复现语义报告", 300),
    },
    quality: {
      verdict: "SUPERSEDED_ARTIFACT",
      pass: false,
      reason: cleanText(
        object.reason || "旧报告将认证失效、无效 fixture 或 SPA 壳误计为通过。",
        320,
      ),
    },
  };
}

function webRowsByPath(report) {
  const map = new Map();
  for (const row of arrayOrEmpty(report?.results || report?.routes)) {
    const path = String(
      row?.path || row?.input?.path || row?.input?.urlPath || "",
    ).split("?", 1)[0];
    if (!path) continue;
    const rows = map.get(path) || [];
    rows.push(row);
    map.set(path, rows);
  }
  return map;
}

function inventoryFallbackItem(row) {
  return {
    id: cleanText(row?.id || "inventory:unknown", 260),
    source: "inventory",
    scope: "current",
    category: "unverified",
    title: cleanText(row?.label || row?.path || row?.id || "未命名入口", 220),
    input: {
      method: cleanText(row?.method || "", 30) || null,
      path: cleanText(row?.path || "", 260) || null,
      requirement: cleanText(row?.input || "", 260) || null,
    },
    output: {
      expected: cleanText(row?.output || "", 260) || null,
    },
    quality: {
      verdict: "UNVERIFIED",
      pass: false,
      reason: "当前有效证据源中没有匹配该入口的语义执行记录。",
    },
  };
}

function summarizeCategories(items) {
  const counts = Object.fromEntries(CATEGORY_ORDER.map((key) => [key, 0]));
  for (const item of items)
    counts[item.category] = (counts[item.category] || 0) + 1;
  return counts;
}

function compactFailureReasons(items, category) {
  const groups = new Map();
  for (const item of items.filter((row) => row.category === category)) {
    const output = objectOrEmpty(item?.output);
    const quality = objectOrEmpty(item?.quality);
    const baseReason =
      category === "historical_failure"
        ? quality.businessReason ||
          output.businessReason ||
          arrayOrEmpty(quality.errors)[0] ||
          arrayOrEmpty(quality.semanticErrors)[0] ||
          output.message ||
          quality.reason ||
          historicalVerdictLabel(quality.verdict)
        : quality.reason ||
          arrayOrEmpty(quality.errors)[0] ||
          arrayOrEmpty(quality.semanticErrors)[0] ||
          output.preview ||
          quality.verdict ||
          "未说明原因";
    const context = [];
    if (category === "historical_failure") {
      const sourceDate =
        output.sourceDate ||
        item?.timing?.completedAt ||
        item?.timing?.startedAt ||
        null;
      const runId = output.runId ?? item?.input?.runId ?? null;
      context.push(
        `来源日期：${sourceDate ? cleanText(sourceDate, 80).slice(0, 10) : "未记录"}`,
      );
      context.push(
        `runId：${runId == null || runId === "" ? "未记录" : cleanText(runId, 120)}`,
      );
    }
    const reason = cleanText(
      `${baseReason || "历史业务记录未通过"}${context.length ? `（${context.join("；")}）` : ""}`,
      420,
    );
    const current = groups.get(reason) || { reason, count: 0, sampleIds: [] };
    current.count += 1;
    if (current.sampleIds.length < 8) current.sampleIds.push(item.id);
    groups.set(reason, current);
  }
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || a.reason.localeCompare(b.reason, "zh-CN"),
  );
}

function categoryLabel(category) {
  return CATEGORY_META[category]?.label || category;
}

function tableCell(value, limit = 260) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? null);
  return cleanText(text, limit).replace(/\|/gu, "\\|");
}

function itemInputSummary(item) {
  const input = objectOrEmpty(item?.input);
  return Object.entries(input)
    .filter(
      ([, value]) =>
        value != null &&
        value !== "" &&
        (!Array.isArray(value) || value.length),
    )
    .map(
      ([key, value]) =>
        `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`,
    )
    .join("；");
}

function itemOutputSummary(item) {
  const output = objectOrEmpty(item?.output);
  return Object.entries(output)
    .filter(
      ([key]) =>
        !(item?.category === "historical_failure" && key === "subtype"),
    )
    .filter(
      ([, value]) =>
        value != null &&
        value !== "" &&
        (!Array.isArray(value) || value.length),
    )
    .map(
      ([key, value]) =>
        `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`,
    )
    .join("；");
}

function sourceStatusLabel(status) {
  if (status === "authoritative") return "可用·当前证据";
  if (status === "historical_evidence") return "可用·历史证据";
  if (status === "missing_invalid") return "未提供·不得下结论";
  return "已作废·不得计入验收";
}

function buildLegacyHarnessIncident(sourceByName) {
  const currentProbeNames = ["get", "write"];
  const currentProbeSources = currentProbeNames.map(
    (name) => sourceByName[name],
  );
  const inventorySource = sourceByName.inventory;
  const currentSourcesReady =
    currentProbeSources.every((source) => source?.status === "authoritative") &&
    inventorySource?.status === "authoritative";
  const currentDiagnostics = currentProbeSources
    .filter((source) => source?.status === "authoritative")
    .map((source) => objectOrEmpty(source.diagnostics));
  const revokedSessionTermHits = currentDiagnostics.reduce(
    (total, diagnostics) =>
      total + Number(diagnostics.revokedSessionCount || 0),
    0,
  );
  const invalidFixtureTermHits = currentDiagnostics.reduce(
    (total, diagnostics) =>
      total + Number(diagnostics.fixtureInvalidCount || 0),
    0,
  );
  const routeNotFoundTermHits = currentDiagnostics.reduce(
    (total, diagnostics) =>
      total + Number(diagnostics.routeDiscoveryInvalidCount || 0),
    0,
  );
  const termHitCount =
    revokedSessionTermHits + invalidFixtureTermHits + routeNotFoundTermHits;
  const phantomRouteCount =
    inventorySource?.status === "authoritative"
      ? arrayOrEmpty(inventorySource.diagnostics?.phantomRoutes).length
      : 0;
  const missingRequiredRouteCount =
    inventorySource?.status === "authoritative"
      ? arrayOrEmpty(inventorySource.diagnostics?.missingRequiredRoutes).length
      : 0;
  return {
    scope: "historical_harness_root_cause",
    causes: [
      {
        code: "LOGOUT_TOKEN_REUSE",
        legacyAffectedCount: 140,
        legacyTriggerFeatureIndex: 4,
        legacyVerdict: "BOUNDARY_OK",
        symptom: "合法 401 被误算为边界通过",
        cause:
          "旧 WRITE 报告在 features 索引 4 执行 logout 后复用同一 token，造成后续 140 条合法 401 均被旧 verdict=BOUNDARY_OK 误算为边界通过。",
        fix: "新 WRITE 探针为每个写接口建立独立会话，logout 不再污染后续用例，并且 401 不再冒充正向通过。",
      },
      {
        code: "GENERIC_DYNAMIC_FIXTURE",
        legacyAffectedCount: 10,
        legacyExamples: ["overview", "agent_task"],
        symptom: "未知钻取类型、未知来源类型、请求内容格式错误",
        cause:
          "旧 GET/WRITE 测试器给动态 path 和 body 塞入同一份 generic fixture，有 10 条请求本身不符合路由契约（包含 overview、agent_task）。",
        fix: "新探针按路由契约逐项绑定合法动态参数和专用 body fixture，无效输入只能进入边界或未验证分类。",
      },
      {
        code: "CROSS_MOUNT_ROUTE_DISCOVERY",
        legacyAffectedCount: 45,
        legacyMissedCountAtLeast: 117,
        symptom: "伪路由与真实路由缺失",
        cause:
          "旧清单扫描把不同 app.use mount 串联，生成 45 个伪路由，同时漏掉至少 117 个真实路由。",
        fix: "新清单按 createApp 的实际 mount 参数与平衡语法边界解析，并对重复、伪路由和必需路由做硬校验。",
      },
    ],
    currentProbePollution: {
      currentSourcesReady,
      termHitCount,
      revokedSessionTermHits,
      invalidFixtureTermHits,
      routeNotFoundTermHits,
      phantomRouteCount,
      missingRequiredRouteCount,
      clean:
        currentSourcesReady &&
        termHitCount === 0 &&
        phantomRouteCount === 0 &&
        missingRequiredRouteCount === 0,
    },
  };
}

export function buildFullFeatureReport({
  inventory,
  getReport,
  writeReport,
  webReport,
  employeeReport,
  contentReport,
  businessFeatureReport,
  outputQualityReports = [],
  sourceFiles = {},
  supersededArtifacts = [],
  generatedAt = new Date().toISOString(),
  projectUrl = "http://127.0.0.1:3107/",
  title = "NanoWork 用户版全功能验收报告",
} = {}) {
  const normalizedQualityReports = arrayOrEmpty(outputQualityReports);
  const baseSources = [
    validateInventory(inventory, sourceFiles.inventory),
    validateProbe("get", getReport, sourceFiles.get),
    validateProbe("write", writeReport, sourceFiles.write),
    validateWeb(webReport, sourceFiles.web),
    validateHistorical(
      "employee",
      employeeReport,
      sourceFiles.employee,
      "nanowork.real-employee-matrix.v2",
    ),
    validateHistorical(
      "content",
      contentReport,
      sourceFiles.content,
      "nanowork.real-content-automation-matrix.v2",
    ),
  ];
  const businessFeatureSource = validateBusinessFeature(
    businessFeatureReport,
    sourceFiles.businessFeature,
  );
  const outputQualitySources = normalizedQualityReports.length
    ? normalizedQualityReports.map((report, index) =>
        validateOutputQuality(
          report,
          arrayOrEmpty(sourceFiles.outputQuality)[index],
          index,
        ),
      )
    : [validateOutputQuality(null, null, 0)];
  const selectedOutputQualitySource =
    selectLatestQualitySource(outputQualitySources);
  const sources = [
    ...baseSources,
    businessFeatureSource,
    ...outputQualitySources,
  ];
  const sourceByName = Object.fromEntries(
    sources.map((source) => [source.name, source]),
  );
  const items = [];
  const coveredInventoryIds = new Set();

  for (const meta of sources.filter(
    (source) => source.status === "superseded_invalid",
  )) {
    items.push(sourceInvalidItem(meta));
  }

  for (const [name, report] of [
    ["get", getReport],
    ["write", writeReport],
  ]) {
    if (sourceByName[name].status !== "authoritative") continue;
    const rows = arrayOrEmpty(report?.results);
    const compact = rows.map((row) => compactProbeItem(row, name));
    compact.forEach((item) => {
      items.push(item);
      coveredInventoryIds.add(item.id);
    });
    items.push(...collectHistoricalFindings(compact, rows));
  }

  if (sourceByName.web.status === "authoritative") {
    const rowsByPath = webRowsByPath(webReport);
    const usedRows = new Set();
    if (sourceByName.inventory.status === "authoritative") {
      for (const inventoryRow of arrayOrEmpty(inventory?.features).filter(
        (row) => ["web_route", "main_layout_menu"].includes(row?.surface),
      )) {
        const route = rowsByPath.get(String(inventoryRow.path || ""))?.[0];
        if (!route) continue;
        const item = compactWebItem(route, inventoryRow);
        items.push(item);
        usedRows.add(route);
        coveredInventoryIds.add(item.id);
      }
    }
    // Keep role variants and semantic page checks that are not represented by
    // a static page/menu row.  The JSON report must not silently discard them.
    for (const row of arrayOrEmpty(webReport?.results)) {
      if (!usedRows.has(row)) items.push(compactWebItem(row));
    }
  }

  if (sourceByName.employee.status === "historical_evidence") {
    for (const [key, entry] of Object.entries(
      objectOrEmpty(employeeReport?.jobs),
    )) {
      const item = compactEmployeeItem(key, entry);
      items.push(item);
      coveredInventoryIds.add(item.id);
    }
  }

  if (sourceByName.content.status === "historical_evidence") {
    for (const row of arrayOrEmpty(contentReport?.results))
      items.push(compactContentItem(row));
  }

  if (businessFeatureSource.status === "historical_evidence") {
    for (const [key, entry] of Object.entries(
      objectOrEmpty(businessFeatureReport?.jobs),
    )) {
      items.push(compactBusinessFeatureItem(key, entry));
    }
  }

  if (selectedOutputQualitySource) {
    const selectedIndex = outputQualitySources.indexOf(
      selectedOutputQualitySource,
    );
    const selectedReport = normalizedQualityReports[selectedIndex];
    for (const row of outputQualityRows(selectedReport)) {
      items.push(
        compactOutputQualityItem(
          row,
          selectedReport,
          selectedOutputQualitySource,
        ),
      );
    }
  }

  if (sourceByName.inventory.status === "authoritative") {
    for (const row of arrayOrEmpty(inventory?.features)) {
      if (coveredInventoryIds.has(row?.id)) continue;
      // Browser-walk evidence can be authoritative in the inventory only when
      // it records an explicit PASS.  Route/menu HTML shells are handled by the
      // versioned web report above and never promoted here.
      if (row?.surface === "browser_walk" && row?.status === "PASS") {
        items.push({
          id: cleanText(row.id, 260),
          source: "inventory_browser",
          scope: "current",
          category: "positive_pass",
          title: cleanText(row.path || row.id, 220),
          input: { action: cleanText(row.input || "浏览器真实操作", 260) },
          output: { summary: cleanText(row.output || "页面交互通过", 260) },
          quality: {
            verdict: cleanText(row.verdict || "BROWSER_PASS", 100),
            pass: true,
            scope: "browser_smoke",
          },
        });
        coveredInventoryIds.add(row.id);
      } else {
        items.push(inventoryFallbackItem(row));
      }
    }
  }

  supersededArtifacts.forEach((entry, index) =>
    items.push(supersededArtifactItem(entry, index)),
  );

  const categories = summarizeCategories(items);
  const sourceInvalidCount = sources.filter(
    (source) => source.status === "superseded_invalid",
  ).length;
  const missingSourceCount = sources.filter(
    (source) => source.status === "missing_invalid",
  ).length;
  const domainConclusions = {
    businessFunction: businessFunctionConclusion(
      businessFeatureSource,
      businessFeatureReport,
    ),
    employeeOutputQuality: outputQualityConclusion(
      outputQualitySources,
      selectedOutputQualitySource,
      normalizedQualityReports,
    ),
  };
  const scope = {
    statement:
      "本报告的“当前接口探针”结论仅覆盖本轮有效接口探针（GET、WRITE 与页面语义探针）；历史业务功能矩阵、员工输出质量和未执行的外部副作用分开报告，不得相互覆盖。",
    currentInterfaceProbe: {
      evidenceSources: ["get", "write", "web"],
      failureCategoryKey: "product_failure",
      failureSummaryKey: "currentInterfaceProbeFailure",
      excludes:
        "不代表全部业务流程、全体员工产出、已阻断外部动作或外部供应商的全局状态。",
    },
  };
  const legacyHarnessIncident = buildLegacyHarnessIncident(sourceByName);
  const reportCore = {
    schemaVersion: "nanowork.user-full-feature-report.v4",
    generatedAt,
    title: cleanText(title, 220),
    projectUrl: cleanText(projectUrl, 500),
    scope,
    policy: {
      onlyPositivePassCountsAsFunctionalSuccess: true,
      negativeBoundaryIsNotPositivePass: true,
      safetyBlockedIsNotExecuted: true,
      historicalFailureIsNotCurrentRequestFailure: true,
      historicalPassIsNotCurrentFunctionalPass: true,
      invalidHarnessIsNotProductFailure: true,
      interfaceProbeFailureIsLimitedToCurrentProbeScope: true,
      rawBodiesExcluded: true,
      secretsRedacted: true,
    },
    summary: {
      inventoryFeatureCount:
        sourceByName.inventory.status === "authoritative"
          ? arrayOrEmpty(inventory?.features).length
          : 0,
      evidenceItemCount: items.length,
      categories,
      positiveFunctionalPass: categories.positive_pass,
      currentInterfaceProbeFailure: categories.product_failure,
      historicalRecordCount: categories.historical_failure,
      historicalPassCount: categories.historical_pass,
      invalidSourceCount: sourceInvalidCount,
      missingSourceCount,
      supersededArtifactCount: supersededArtifacts.length,
      hasInvalidEvidence:
        sourceInvalidCount > 0 ||
        missingSourceCount > 0 ||
        supersededArtifacts.length > 0,
    },
    categoryDefinitions: CATEGORY_ORDER.map((key) => ({
      key,
      ...CATEGORY_META[key],
    })),
    sources,
    domainConclusions,
    legacyHarnessIncident,
    supersededArtifacts: supersededArtifacts.map((entry) => {
      const object =
        typeof entry === "string" ? { path: entry } : objectOrEmpty(entry);
      return {
        path: cleanText(object.path || object.name || "", 500),
        reason: cleanText(object.reason || "旧报告口径已作废。", 320),
        replacement: cleanText(object.replacement || "本次报告", 320),
        status: "INVALID_SUPERSEDED",
      };
    }),
    issueGroups: {
      harnessInvalid: compactFailureReasons(items, "harness_invalid"),
      interfaceProbeFailure: compactFailureReasons(items, "product_failure"),
      historicalFailure: compactFailureReasons(items, "historical_failure"),
    },
    items,
  };
  return {
    ...reportCore,
    reportId: stableHash({
      policy: reportCore.policy,
      sources: sources.map(
        ({
          name,
          family,
          sha256,
          schemaVersion,
          status,
          evidenceScope,
          generatedAt,
          invalidatedEntries,
          diagnostics,
        }) => ({
          name,
          family,
          sha256,
          schemaVersion,
          status,
          evidenceScope,
          generatedAt,
          invalidatedEntries,
          selectedForConclusion: diagnostics?.selectedForConclusion === true,
          referencedMatrix: diagnostics?.referencedMatrix || null,
        }),
      ),
      scope,
      domainConclusions,
      legacyHarnessIncident,
      supersededArtifacts: reportCore.supersededArtifacts,
      items,
    }),
  };
}

export function renderFullFeatureMarkdown(report) {
  const lines = [];
  lines.push(`# ${report.title}`);
  lines.push("");
  lines.push(`- 项目地址：[${report.projectUrl}](${report.projectUrl})`);
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 可复现报告 ID：\`${report.reportId}\``);
  lines.push(`- 当前有效清单入口：${report.summary.inventoryFeatureCount}`);
  lines.push("");

  if (report.summary.hasInvalidEvidence) {
    lines.push("> [!CAUTION]");
    lines.push(
      "> **旧污染报告已作废（INVALID / SUPERSEDED）。** 被吊销会话、串 mount 伪路由、无效 fixture 或 SPA HTML 壳不再计为功能通过。下方“测试器无效”与“证据源”列出具体范围。",
    );
    lines.push("");
  }

  lines.push("## 一眼看结果");
  lines.push("");
  lines.push(
    "只有“正向功能通过”代表当前功能成功。负向边界、安全阻断、历史通过/失败和测试器无效均不计入当前正向通过。",
  );
  lines.push(
    `> **全局范围：** ${report.scope?.statement || "仅覆盖本轮有效接口探针。"}`,
  );
  lines.push("");
  lines.push(
    `- **当前接口探针失败：${report.summary.currentInterfaceProbeFailure || 0} 项**（仅覆盖本轮有效接口探针）`,
  );
  lines.push(
    `- 历史失败记录：${report.summary.historicalRecordCount || 0} 项（仅供复盘，不计入当前故障）`,
  );
  lines.push("");
  lines.push("| 分类 | 数量 | 含义 |");
  lines.push("|---|---:|---|");
  for (const key of CATEGORY_ORDER) {
    lines.push(
      `| ${CATEGORY_META[key].label} | ${report.summary.categories[key] || 0} | ${CATEGORY_META[key].meaning} |`,
    );
  }
  lines.push("");

  const legacyIncident = objectOrEmpty(report.legacyHarnessIncident);
  const legacyCauses = arrayOrEmpty(legacyIncident.causes);
  const currentPollution = objectOrEmpty(legacyIncident.currentProbePollution);
  lines.push("## 旧报告为何出现这些错误");
  lines.push("");
  for (const [index, cause] of legacyCauses.entries()) {
    lines.push(
      `${index + 1}. **${tableCell(cause.symptom || cause.code, 180)}**：${tableCell(cause.cause, 420)} **修复：**${tableCell(cause.fix, 420)}`,
    );
  }
  lines.push("");
  if (currentPollution.currentSourcesReady) {
    lines.push(
      `- 修复后新探针污染词命中：**${currentPollution.termHitCount || 0}**；伪路由：**${currentPollution.phantomRouteCount || 0}**；必需路由缺失：**${currentPollution.missingRequiredRouteCount || 0}**。`,
    );
  } else {
    lines.push("- 当前修正探针或路由清单证据不完整，无法确认污染词是否归零。");
  }
  lines.push("");

  const business = objectOrEmpty(report.domainConclusions?.businessFunction);
  lines.push("## 业务功能报告结论");
  lines.push("");
  if (business.status === "historical_evidence") {
    lines.push(
      `- 证据状态：**可用的历史隔离矩阵**（${tableCell(business.asOf || "日期未记录", 80)}），不是当前重跑。`,
    );
    lines.push(
      `- 历史总结论：**${business.passed}/${business.total}** 通过，${business.failed} 失败。`,
    );
    lines.push(
      `- 其中真实 API 业务交付：**${business.realApiPassed}/${business.realApiTotal}**；权限边界：**${business.permissionBoundaryPassed}/${business.permissionBoundaryTotal}**。`,
    );
  } else {
    lines.push(`- 证据状态：**无效或缺失**；不展示业务功能通过数。`);
  }
  lines.push(`- 当前判定：**需重跑**。${business.rerunReason || ""}`);
  lines.push("");

  const outputQuality = objectOrEmpty(
    report.domainConclusions?.employeeOutputQuality,
  );
  lines.push("## 员工输出质量报告结论");
  lines.push("");
  if (outputQuality.status === "historical_evidence") {
    lines.push(
      `- 证据状态：**最新有效 v3 历史审计**（${tableCell(outputQuality.latestEvidenceAt || "日期未记录", 80)}），只统计该份审计，不与较旧快照叠加。`,
    );
    lines.push(
      `- 实际审计覆盖：**${outputQuality.distinctAuditedEmployees} 人**；质量能力通过 **${outputQuality.qualityPassed}**，失败 **${outputQuality.qualityFailed}**。`,
    );
    lines.push(
      `- 业务生产通过：**${outputQuality.businessProductionPassed}/${outputQuality.distinctAuditedEmployees}**；运营条件阻断：**${outputQuality.operationalBlocked}**。`,
    );
  } else {
    lines.push("- 证据状态：**无效或缺失**；不展示员工输出质量通过数。");
  }
  lines.push(
    `- 无效/作废证据源：${outputQuality.supersededInvalidSources || 0} 份；旧口径、缺失文件或哈希不一致${outputQuality.status === "historical_evidence" ? "均不得覆盖最新有效 v3 结论" : "均不得生成质量通过结论"}。`,
  );
  lines.push(`- 当前判定：**需重跑**。${outputQuality.rerunReason || ""}`);
  lines.push("");

  lines.push("## 证据源是否可用");
  lines.push("");
  lines.push(
    "| 证据源 | 状态 | 证据日期 | Schema | SHA-256 | 无效条目 | 说明 |",
  );
  lines.push("|---|---|---|---|---|---:|---|");
  for (const source of report.sources) {
    lines.push(
      `| ${tableCell(source.label || source.name, 80)} | ${sourceStatusLabel(source.status)} | ${tableCell(source.generatedAt || "-", 80)} | ${tableCell(source.schemaVersion || "-", 100)} | ${tableCell(source.sha256 || "-", 80)} | ${source.invalidatedEntries || 0} | ${tableCell(source.reason, 360)} |`,
    );
  }
  lines.push("");

  if (arrayOrEmpty(report.supersededArtifacts).length) {
    lines.push("## 已作废的旧报告");
    lines.push("");
    for (const artifact of report.supersededArtifacts) {
      lines.push(
        `- **INVALID / SUPERSEDED** · \`${artifact.path}\`：${artifact.reason}`,
      );
    }
    lines.push("");
  }

  for (const [category, heading] of [
    ["harness_invalid", "测试器无效（先修测试，不得归因产品）"],
    ["product_failure", "当前接口探针失败（仅覆盖本轮有效接口探针）"],
    ["historical_failure", "历史失败（不代表当前请求失败）"],
  ]) {
    const groups = compactFailureReasons(report.items, category);
    if (!groups.length) continue;
    lines.push(`## ${heading}`);
    lines.push("");
    lines.push("| 数量 | 原因 | 样例编号 |");
    lines.push("|---:|---|---|");
    for (const group of groups) {
      lines.push(
        `| ${group.count} | ${tableCell(group.reason, 360)} | ${tableCell(group.sampleIds.join("、"), 360)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## 需要关注的逐项记录");
  lines.push("");
  lines.push(
    "详细 JSON 保留全部语义化条目；本表只展示测试器无效、当前接口探针失败和尚未验证，避免把大量正向/反例/历史明细堆到用户报告。这里的失败仅覆盖本轮有效接口探针；不嵌入 raw body、提示词、密钥、Cookie 或完整私有材料。",
  );
  lines.push("");
  lines.push("| # | 分类 | 入口 | 输入摘要 | 输出摘要 | 质量结论 |");
  lines.push("|---:|---|---|---|---|---|");
  const attentionItems = report.items.filter((item) =>
    ["harness_invalid", "product_failure", "unverified"].includes(
      item.category,
    ),
  );
  attentionItems.forEach((item, index) => {
    const quality = objectOrEmpty(item.quality);
    const qualityText =
      item.category === "historical_failure"
        ? compactFailureReasons([item], "historical_failure")[0]?.reason ||
          "历史记录，仅供复盘"
        : [
            quality.verdict,
            quality.reason,
            arrayOrEmpty(quality.errors)[0],
            arrayOrEmpty(quality.semanticErrors)[0],
          ]
            .filter(Boolean)
            .join("；");
    lines.push(
      `| ${index + 1} | ${categoryLabel(item.category)} | ${tableCell(item.title || item.id, 220)} | ${tableCell(itemInputSummary(item), 360)} | ${tableCell(itemOutputSummary(item), 360)} | ${tableCell(qualityText || (quality.pass ? "PASS" : "未通过"), 360)} |`,
    );
  });
  if (!attentionItems.length) {
    lines.push(
      "| - | - | 无需要关注的逐项记录 | - | - | 详细通过证据见 JSON |",
    );
  }
  lines.push("");
  lines.push("## 口径声明");
  lines.push("");
  lines.push("- 负向边界通过不等于正向业务可用。");
  lines.push("- 安全阻断不等于已执行，也不等于失败。");
  lines.push("- 历史失败是旧运行的真实记录，不覆盖本次有效探针的当前结果。");
  lines.push(
    "- 当前接口探针失败仅覆盖本轮有效接口探针，不是对所有业务流程、员工产出或外部供应商能力的全局判定。",
  );
  lines.push(
    "- 历史通过同样不等于当前通过；首页业务功能和输出质量必须显式标注证据日期与重跑要求。",
  );
  lines.push("- 测试器无效必须重跑；在重跑前对产品不作通过或失败结论。");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export { CATEGORY_META, CATEGORY_ORDER, cleanText, inspectLegacyProbe };
