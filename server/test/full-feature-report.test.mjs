import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildFullFeatureReport,
  renderFullFeatureMarkdown,
} from "../../scripts/lib/full-feature-report.mjs";
import {
  exportFullFeatureReport,
  parseArgs,
} from "../../scripts/export-full-feature-report.mjs";

function probeResult(id, verdict, status, overrides = {}) {
  const route = id.replace(/^api:[A-Z]+:/u, "");
  const method = id.split(":")[1];
  const quality = {
    verdict,
    pass: ["HAPPY_PATH_PASS", "NEGATIVE_BOUNDARY_PASS"].includes(verdict),
    happyPathPass: verdict === "HAPPY_PATH_PASS",
    reachedTargetHandler: ![
      "AUTH_HARNESS_FAILURE",
      "FIXTURE_INVALID",
      "ROUTE_DISCOVERY_INVALID",
    ].includes(verdict),
    score: verdict === "HAPPY_PATH_PASS" ? 100 : 0,
    ...overrides.quality,
  };
  return {
    id,
    route,
    input: {
      method,
      route,
      urlPath: route,
      intent:
        verdict === "NEGATIVE_BOUNDARY_PASS"
          ? "permission_boundary"
          : "happy_path",
      role: "boss",
      tenantId: 1,
      body: overrides.body,
    },
    output:
      verdict === "SAFETY_NOT_EXECUTED"
        ? null
        : {
            status,
            contentType: "application/json; charset=utf-8",
            bytes: 24,
            bodySha256: "a".repeat(64),
            jsonValid: true,
            shape: { kind: "object", keys: ["ok"] },
            bodyPreview: overrides.preview || "JSON 对象；字段：ok",
            historicalIssues: overrides.historicalIssues || [],
          },
    quality,
    startedAt: "2026-08-21T00:00:00.000Z",
    completedAt: "2026-08-21T00:00:01.000Z",
  };
}

function correctedFixtures() {
  const getResults = [
    probeResult("api:GET:/api/avatar/meta", "HAPPY_PATH_PASS", 200, {
      historicalIssues: [
        {
          category: "historical_content_contract",
          path: "$.rows[0].error",
          message: "历史任务#16内容格式错误",
          sourceDate: "2026-08-18T10:20:30.000Z",
          runId: 16,
        },
      ],
    }),
    probeResult(
      "api:GET:/api/platform/overview",
      "NEGATIVE_BOUNDARY_PASS",
      403,
    ),
    probeResult("api:GET:/api/content/crew", "PRODUCT_SERVER_FAILURE", 503),
  ];
  const writeResults = [
    probeResult("api:POST:/api/content/pipelines", "SAFETY_NOT_EXECUTED", 0),
    probeResult("api:POST:/api/auth/session", "HAPPY_PATH_PASS", 200, {
      body: { password: "must-not-leak", title: "x" },
    }),
  ];
  return {
    inventory: {
      schemaVersion: "nanowork.full-feature-inventory.v1",
      features: [
        {
          id: "api:GET:/api/avatar/meta",
          surface: "http_api",
          method: "GET",
          path: "/api/avatar/meta",
        },
        {
          id: "api:GET:/api/content/crew",
          surface: "http_api",
          method: "GET",
          path: "/api/content/crew",
        },
        {
          id: "api:GET:/api/content/pipelines",
          surface: "http_api",
          method: "GET",
          path: "/api/content/pipelines",
        },
        {
          id: "api:GET:/api/employee-workbench/content/:idx",
          surface: "http_api",
          method: "GET",
          path: "/api/employee-workbench/content/:idx",
        },
        {
          id: "api:GET:/api/platform/overview",
          surface: "http_api",
          method: "GET",
          path: "/api/platform/overview",
        },
        {
          id: "api:POST:/api/content/pipelines",
          surface: "http_api",
          method: "POST",
          path: "/api/content/pipelines",
        },
        {
          id: "api:POST:/api/auth/session",
          surface: "http_api",
          method: "POST",
          path: "/api/auth/session",
        },
        {
          id: "page:/tasks",
          surface: "web_route",
          method: "VIEW",
          path: "/tasks",
        },
        {
          id: "menu:/tasks",
          surface: "main_layout_menu",
          method: "VIEW",
          path: "/tasks",
          label: "任务中心",
        },
        {
          id: "inventory:unverified",
          surface: "unknown",
          method: "VIEW",
          path: "/not-tested",
        },
      ],
    },
    getReport: {
      schemaVersion: "nanowork.http-feature-probe.v2",
      results: getResults,
      summary: { total: getResults.length },
    },
    writeReport: {
      schemaVersion: "nanowork.http-feature-probe.v2",
      results: writeResults,
      summary: { total: writeResults.length },
    },
    webReport: {
      schemaVersion: "nanowork.web-route-report.v2",
      results: [
        {
          id: "web:/tasks",
          path: "/tasks",
          input: { path: "/tasks", role: "boss", action: "打开任务中心" },
          output: {
            status: 200,
            title: "任务中心",
            rendered: true,
            keyElements: ["列表", "刷新"],
          },
          quality: {
            verdict: "HAPPY_PATH_PASS",
            pass: true,
            happyPathPass: true,
            score: 100,
          },
        },
      ],
    },
    employeeReport: {
      schemaVersion: "nanowork.real-employee-matrix.v2",
      jobs: {
        "restaurant:101": {
          latest: {
            employeeId: "restaurant:101",
            employeeName: "餐饮市场机会研究",
            taskTitle: "比较两个商圈",
            pass: false,
            verdict: "FAIL_REAL_API",
            terminalStatus: "已完成",
            attemptId: "employee-attempt-101",
            finishedAt: "2026-08-19T09:30:00.000Z",
            unifiedGate: { pass: false, failedChecks: ["business_result"] },
          },
        },
      },
    },
    contentReport: {
      schemaVersion: "nanowork.real-content-automation-matrix.v2",
      results: [
        {
          jobKey: "content:0:immediate",
          pass: false,
          verdict: "FAIL_REAL_CONTENT_AUTOMATION",
          errors: ["历史运行没有停在预期边界"],
          finishedAt: "2026-08-20T08:00:00.000Z",
          evidence: {
            employee: { idx: 0, name: "趋势官", taskType: "趋势简报" },
            mode: "immediate",
            run: { id: 701 },
          },
        },
        {
          jobKey: "content:1:immediate",
          pass: true,
          verdict: "PASS_REAL_CONTENT_AUTOMATION",
          evidence: {
            employee: { idx: 1, name: "选题官", taskType: "选题" },
            mode: "immediate",
          },
        },
      ],
    },
  };
}

function businessFeatureFixture() {
  return {
    schemaVersion: "nanowork.real-feature-matrix.v8",
    createdAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T13:00:00.000Z",
    evidencePolicy: {
      externalPublish: false,
      scopeClaim: "仅声称2条安全功能矩阵",
    },
    runtimeEvidence: {
      loopbackService: true,
      dedicatedDatabase: true,
    },
    finalSafetyAudit: {
      pass: true,
      active: [],
      held: [],
      feishuNotified: 0,
      checkedAt: "2026-08-20T13:00:00.000Z",
    },
    summary: {
      total: 2,
      passed: 1,
      failed: 1,
      running: 0,
      realApi: { total: 1, passed: 0, failed: 1 },
      permissionBoundaries: { total: 1, passed: 1, failed: 0 },
      levels: { l1Passed: 1, l1Failed: 1, l2Passed: 2, l2Failed: 0 },
    },
    jobs: {
      "toolbox:hot": {
        latest: {
          featureKey: "toolbox:hot",
          featureTitle: "热门内容改写",
          category: "toolbox",
          role: "boss",
          endpoint: "/api/toolbox/hot",
          pass: false,
          verdict: "FAIL_REAL_API",
          l1Pass: false,
          l2Pass: true,
          terminalStatus: "失败",
          failureReasons: ["历史供应商返回内容格式错误"],
          startedAt: "2026-08-20T12:10:00.000Z",
          finishedAt: "2026-08-20T12:11:00.000Z",
          attemptId: "business-attempt-1",
        },
      },
      "marshal-chat:employee:forbidden": {
        latest: {
          featureKey: "marshal-chat:employee:forbidden",
          featureTitle: "员工权限边界",
          category: "marshal_chat",
          role: "employee",
          endpoint: "/api/marshals/chat",
          pass: true,
          verdict: "PASS_PERMISSION_BOUNDARY",
          l1Pass: true,
          l2Pass: true,
          terminalStatus: "已拒绝",
          startedAt: "2026-08-20T12:12:00.000Z",
          finishedAt: "2026-08-20T12:12:01.000Z",
          attemptId: "business-attempt-2",
        },
      },
    },
  };
}

function outputQualityFixture({
  generatedAt,
  schemaVersion = "nanowork.employee-output-quality-audit.v3",
  employeeIdx = 101,
  passed = true,
  sourceName = "matrix.json",
  matrixSha256 = "c".repeat(64),
} = {}) {
  return {
    schemaVersion,
    generatedAt,
    evidencePolicy: {
      databaseAccess: "sqlite_read_only_query_only",
      externalApiCalls: 0,
      rawOutputIncluded: false,
      internalProfileIncluded: false,
      requiresStrictProviderBillingEvidence: schemaVersion.endsWith(".v3"),
    },
    source: {
      matrixFile: sourceName,
      matrixSha256,
      databaseFile: "isolated.db",
    },
    coverage: {
      expectedEmployees: 1,
      matrixJobs: 1,
      matrixPassed: passed ? 1 : 0,
      auditedCapabilityOutputs: 1,
      matrixComplete: false,
    },
    summary: {
      overallStatus: passed ? "PASS_PARTIAL" : "FAIL_QUALITY",
      capabilityPassed: passed ? 1 : 0,
      businessProductionPassed: passed ? 1 : 0,
      operationalBlocked: 0,
      qualityPassed: passed ? 1 : 0,
      qualityFailed: passed ? 0 : 1,
      checks: [
        {
          code: "BODY_INTEGRITY",
          label: "正文非空与长度",
          passed: passed ? 1 : 0,
          failed: passed ? 0 : 1,
        },
      ],
    },
    employees: [
      {
        employee: {
          domain: "restaurant",
          idx: employeeIdx,
          key: `restaurant-${employeeIdx}`,
          name: `员工${employeeIdx}`,
        },
        capabilityPass: passed,
        businessProductionPass: passed,
        operationalBlocked: false,
        verdict: passed ? "PASS_QUALITY" : "FAIL_QUALITY",
        failedChecks: passed ? [] : ["BODY_INTEGRITY"],
        checks: [
          {
            code: "BODY_INTEGRITY",
            label: "正文非空与长度",
            status: passed ? "PASS" : "FAIL",
            detail: passed ? "通过" : "不通过",
            evidence: {
              rawBody: "不得进入总报告",
              prompt: "系统提示词不得泄露",
              password: "quality-secret",
            },
          },
        ],
      },
    ],
  };
}

function verifiedQualitySourceMeta({
  file,
  bytes,
  sha256,
  matrixFile,
  matrixSha256,
}) {
  return {
    path: file,
    bytes,
    sha256,
    referencedMatrix: {
      status: "verified",
      declaredFile: matrixFile,
      resolvedPath: `/evidence/${matrixFile}`,
      exists: true,
      bytes: 42,
      declaredSha256: matrixSha256,
      actualSha256: matrixSha256,
      hashMatches: true,
    },
  };
}

test("用户版报告把正向、反例、历史失败、当前接口探针失败和安全未执行分开", () => {
  const fixtures = correctedFixtures();
  const report = buildFullFeatureReport({
    ...fixtures,
    generatedAt: "2026-08-21T08:00:00.000Z",
  });
  assert.equal(report.summary.categories.positive_pass, 4);
  assert.equal(report.summary.categories.historical_pass, 1);
  assert.equal(report.summary.categories.negative_boundary, 1);
  assert.equal(report.summary.categories.historical_failure, 3);
  assert.equal(report.summary.categories.product_failure, 1);
  assert.equal(report.summary.categories.safety_not_executed, 1);
  assert.equal(report.summary.categories.harness_invalid, 0);
  assert.equal(report.summary.categories.unverified, 3);
  assert.equal(report.summary.positiveFunctionalPass, 4);
  assert.equal(report.summary.currentInterfaceProbeFailure, 1);
  assert.equal(Object.hasOwn(report.summary, "currentProductFailure"), false);
  assert.equal(Object.hasOwn(report.issueGroups, "productFailure"), false);
  assert.equal(report.issueGroups.interfaceProbeFailure.length, 1);
  assert.equal(report.schemaVersion, "nanowork.user-full-feature-report.v4");
  assert.match(report.scope.statement, /仅覆盖本轮有效接口探针/u);
  assert.equal(
    report.legacyHarnessIncident.currentProbePollution.termHitCount,
    0,
  );
  assert.equal(report.legacyHarnessIncident.currentProbePollution.clean, true);
  assert.deepEqual(
    report.legacyHarnessIncident.causes.map((item) => item.legacyAffectedCount),
    [140, 10, 45],
  );
  assert.equal(
    report.legacyHarnessIncident.causes[0].legacyTriggerFeatureIndex,
    4,
  );
  assert.equal(
    report.legacyHarnessIncident.causes[0].legacyVerdict,
    "BOUNDARY_OK",
  );
  assert.deepEqual(report.legacyHarnessIncident.causes[1].legacyExamples, [
    "overview",
    "agent_task",
  ]);
  assert.equal(
    report.categoryDefinitions.find((item) => item.key === "product_failure")
      .label,
    "当前接口探针失败",
  );
  assert.equal(report.policy.negativeBoundaryIsNotPositivePass, true);
  assert.ok(
    report.items.some(
      (item) => item.quality?.verdict === "HISTORICAL_RECORD_ONLY",
    ),
  );
});

test("业务功能与员工输出质量作为显式历史证据，旧口径不覆盖新证据", () => {
  const fixtures = correctedFixtures();
  const olderPass = outputQualityFixture({
    generatedAt: "2026-08-01T00:00:00.000Z",
    passed: true,
    sourceName: "older-v3.json",
  });
  const newerFailure = outputQualityFixture({
    generatedAt: "2026-08-01T01:00:00.000Z",
    passed: false,
    sourceName: "newer-v3.json",
  });
  const obsoleteClaim = outputQualityFixture({
    generatedAt: "2026-08-01T02:00:00.000Z",
    schemaVersion: "nanowork.employee-output-quality-audit.v1",
    passed: true,
    sourceName: "obsolete-v1.json",
  });
  const report = buildFullFeatureReport({
    ...fixtures,
    businessFeatureReport: businessFeatureFixture(),
    outputQualityReports: [olderPass, newerFailure, obsoleteClaim],
    sourceFiles: {
      businessFeature: {
        path: "/evidence/real-feature.json",
        bytes: 123,
        sha256: "a".repeat(64),
      },
      outputQuality: [
        verifiedQualitySourceMeta({
          file: "/evidence/older-v3.json",
          bytes: 101,
          sha256: "1".repeat(64),
          matrixFile: olderPass.source.matrixFile,
          matrixSha256: olderPass.source.matrixSha256,
        }),
        verifiedQualitySourceMeta({
          file: "/evidence/newer-v3.json",
          bytes: 102,
          sha256: "2".repeat(64),
          matrixFile: newerFailure.source.matrixFile,
          matrixSha256: newerFailure.source.matrixSha256,
        }),
        verifiedQualitySourceMeta({
          file: "/evidence/obsolete-v1.json",
          bytes: 103,
          sha256: "3".repeat(64),
          matrixFile: obsoleteClaim.source.matrixFile,
          matrixSha256: obsoleteClaim.source.matrixSha256,
        }),
      ],
    },
    generatedAt: "2026-08-21T08:00:00.000Z",
  });

  assert.deepEqual(report.domainConclusions.businessFunction, {
    scope: "historical",
    status: "historical_evidence",
    asOf: "2026-08-20T13:00:00.000Z",
    conclusionCode: "HISTORICAL_PARTIAL_FAILURES_REQUIRE_RERUN",
    total: 2,
    passed: 1,
    failed: 1,
    realApiPassed: 0,
    realApiTotal: 1,
    permissionBoundaryPassed: 1,
    permissionBoundaryTotal: 1,
    rerunRequired: true,
    rerunReason:
      "证据为 2026-08-20 的历史隔离矩阵，需在当前代码与专用隔离库上重跑后才能形成当前结论。",
  });
  assert.equal(
    report.domainConclusions.employeeOutputQuality.scope,
    "historical",
  );
  assert.equal(
    report.domainConclusions.employeeOutputQuality.status,
    "historical_evidence",
  );
  assert.equal(
    report.domainConclusions.employeeOutputQuality.distinctAuditedEmployees,
    1,
  );
  assert.equal(report.domainConclusions.employeeOutputQuality.qualityPassed, 0);
  assert.equal(report.domainConclusions.employeeOutputQuality.qualityFailed, 1);
  assert.equal(
    report.domainConclusions.employeeOutputQuality.latestEvidenceAt,
    "2026-08-01T01:00:00.000Z",
  );
  assert.equal(
    report.domainConclusions.employeeOutputQuality.supersededInvalidSources,
    1,
  );
  assert.equal(
    report.sources.find((source) => source.name === "businessFeature")
      .evidenceScope,
    "historical",
  );
  assert.equal(
    report.sources.filter(
      (source) =>
        source.family === "output_quality" &&
        source.status === "historical_evidence",
    ).length,
    2,
  );
  assert.equal(
    report.sources.filter(
      (source) =>
        source.family === "output_quality" &&
        source.status === "superseded_invalid",
    ).length,
    1,
  );
  assert.equal(
    report.items.filter(
      (item) =>
        item.source === "businessFeature" &&
        item.category === "historical_pass",
    ).length,
    1,
  );
  assert.equal(
    report.items.filter(
      (item) =>
        item.source === "businessFeature" &&
        item.category === "historical_failure",
    ).length,
    1,
  );
  assert.equal(
    report.items.filter((item) => item.source === "employeeOutputQuality")
      .length,
    1,
  );

  const serialized = JSON.stringify(report);
  const markdown = renderFullFeatureMarkdown(report);
  assert.doesNotMatch(
    serialized,
    /不得进入总报告|系统提示词不得泄露|quality-secret|rawBody|prompt/u,
  );
  assert.match(markdown, /## 业务功能报告结论/u);
  assert.match(markdown, /## 员工输出质量报告结论/u);
  assert.match(markdown, /历史隔离矩阵/u);
  assert.match(markdown, /无效\/作废证据源：1 份/u);
});

test("业务功能或输出质量证据缺失时不会生成当前通过结论", () => {
  const report = buildFullFeatureReport({
    ...correctedFixtures(),
    generatedAt: "2026-08-21T08:00:00.000Z",
  });
  assert.equal(
    report.domainConclusions.businessFunction.status,
    "missing_invalid",
  );
  assert.equal(report.domainConclusions.businessFunction.scope, "invalid");
  assert.equal(report.domainConclusions.businessFunction.passed, 0);
  assert.equal(
    report.domainConclusions.employeeOutputQuality.status,
    "missing_invalid",
  );
  assert.equal(report.domainConclusions.employeeOutputQuality.scope, "invalid");
  assert.equal(report.domainConclusions.employeeOutputQuality.qualityPassed, 0);
});

test("用户版历史问题使用中文原因、来源日期和 runId，且不计入当前故障", () => {
  const fixtures = correctedFixtures();
  const report = buildFullFeatureReport({
    ...fixtures,
    generatedAt: "2026-08-21T08:00:00.000Z",
  });
  const reasons = report.issueGroups.historicalFailure.map(
    (group) => group.reason,
  );
  assert.equal(
    reasons.some((reason) => reason.includes("HISTORICAL_RECORD_ONLY")),
    false,
  );
  assert.ok(
    reasons.some(
      (reason) =>
        reason.includes("历史内容契约未通过") &&
        reason.includes("来源日期：2026-08-18") &&
        reason.includes("runId：16"),
    ),
  );
  assert.ok(
    reasons.some(
      (reason) =>
        reason.includes("历史岗位真实执行未通过") &&
        reason.includes("来源日期：2026-08-19") &&
        reason.includes("runId：employee-attempt-101"),
    ),
  );
  assert.ok(
    reasons.some(
      (reason) =>
        reason.includes("历史运行没有停在预期边界") &&
        reason.includes("来源日期：2026-08-20") &&
        reason.includes("runId：701"),
    ),
  );
  assert.equal(report.summary.currentInterfaceProbeFailure, 1);
  assert.equal(report.summary.historicalRecordCount, 3);
  const markdown = renderFullFeatureMarkdown(report);
  assert.doesNotMatch(markdown, /HISTORICAL_RECORD_ONLY/u);
  assert.match(markdown, /当前接口探针失败：1 项/u);
  assert.match(markdown, /仅覆盖本轮有效接口探针/u);
  assert.doesNotMatch(markdown, /当前产品失败/u);
  assert.match(markdown, /## 旧报告为何出现这些错误/u);
  assert.match(markdown, /logout 后复用同一 token/u);
  assert.match(markdown, /features 索引 4/u);
  assert.match(markdown, /BOUNDARY_OK/u);
  assert.match(markdown, /140 条合法 401/u);
  assert.match(markdown, /10 条/u);
  assert.match(markdown, /overview、agent_task/u);
  assert.match(markdown, /未知钻取类型、未知来源类型、请求内容格式错误/u);
  assert.match(markdown, /串 mount/u);
  assert.match(markdown, /45 个伪路由/u);
  assert.match(markdown, /至少 117 个真实路由/u);
  assert.match(markdown, /新探针污染词命中：\*\*0\*\*/u);
  assert.match(markdown, /历史失败记录：3 项（仅供复盘，不计入当前故障）/u);
});

test("旧会话污染、串 mount 清单和 SPA 壳报告被醒目标记作废", () => {
  const fixtures = correctedFixtures();
  fixtures.inventory.features.push({
    id: "api:GET:/api/avatar/stats",
    surface: "http_api",
    method: "GET",
    path: "/api/avatar/stats",
  });
  fixtures.getReport = {
    schemaVersion: "nanowork.all-get-api-functional-report.v1",
    features: [
      {
        id: "api:GET:/api/marshals/drill/:kind",
        output: { status: 400, bodyPreview: '{"error":"未知钻取类型"}' },
        quality: { verdict: "EXPECTED_BOUNDARY" },
      },
    ],
  };
  fixtures.writeReport = {
    schemaVersion: "nanowork.all-write-boundary-report.v1",
    features: [
      {
        id: "api:POST:/api/growth/leads",
        output: {
          status: 401,
          bodyPreview: '{"error":"会话已退出或被吊销，请重新登录"}',
        },
        quality: { verdict: "BOUNDARY_OK", score: 100 },
      },
    ],
  };
  fixtures.webReport = {
    schemaVersion: "nanowork.web-route-report.v1",
    routes: [
      {
        path: "/tasks",
        output: { status: 200, bytes: 1600, title: "NanoWork", hasRoot: false },
        quality: { verdict: "PASS_PAGE_ROUTE" },
      },
    ],
  };
  const report = buildFullFeatureReport({
    ...fixtures,
    supersededArtifacts: ["/tmp/old-full-report.md"],
    generatedAt: "2026-08-21T08:00:00.000Z",
  });
  assert.equal(report.summary.hasInvalidEvidence, true);
  assert.equal(report.summary.invalidSourceCount, 4);
  assert.equal(report.summary.categories.harness_invalid, 5);
  assert.equal(report.summary.categories.negative_boundary, 0);
  assert.equal(report.summary.categories.product_failure, 0);
  assert.equal(
    report.items.some((item) => item.id === "api:POST:/api/growth/leads"),
    false,
  );
  assert.equal(
    report.sources.find((source) => source.name === "write").diagnostics
      .revokedSessionCount,
    1,
  );
  assert.equal(
    report.sources.find((source) => source.name === "inventory").status,
    "superseded_invalid",
  );
  const markdown = renderFullFeatureMarkdown(report);
  assert.match(markdown, /INVALID \/ SUPERSEDED/u);
  assert.match(markdown, /旧污染报告已作废/u);
  assert.match(markdown, /会话/u);
});

test("旧 employee v2 的系统性 report-first 假阴性整源作废", () => {
  const fixtures = correctedFixtures();
  fixtures.employeeReport.jobs = Object.fromEntries(
    Array.from({ length: 72 }, (_, index) => {
      const falseNegative = index < 59;
      return [
        `restaurant:${index + 101}`,
        {
          latest: {
            employeeId: `restaurant:${index + 101}`,
            employeeName: `员工${index + 1}`,
            terminalStatus: index < 57 ? "已完成" : "失败",
            outputStatus: index < 57 ? "可使用" : null,
            contractValid: index < 58,
            artifactHashValid: falseNegative ? false : true,
            semanticErrors: falseNegative
              ? ["输出必须是JSON对象或包含单个JSON对象的字符串。"]
              : [],
            unifiedGate: {
              checks: [
                {
                  id: "input_output_execution_cost",
                  evidence: { inputRecorded: !falseNegative },
                },
              ],
            },
            pass: false,
            verdict: "FAIL_REAL_API",
          },
        },
      ];
    }),
  );
  const report = buildFullFeatureReport({
    ...fixtures,
    generatedAt: "2026-08-21T08:00:00.000Z",
  });
  const employeeSource = report.sources.find(
    (source) => source.name === "employee",
  );
  assert.equal(employeeSource.status, "superseded_invalid");
  assert.deepEqual(
    Object.fromEntries(
      [
        "completed",
        "usable",
        "contractValid",
        "jsonFalseNegative",
        "hashFalse",
        "inputRecordedFalse",
      ].map((key) => [key, employeeSource.diagnostics[key]]),
    ),
    {
      completed: 57,
      usable: 57,
      contractValid: 58,
      jsonFalseNegative: 59,
      hashFalse: 59,
      inputRecordedFalse: 59,
    },
  );
  assert.equal(
    employeeSource.diagnostics.systemicReportFirstFalseNegative,
    true,
  );
  assert.equal(
    report.items.some((item) => item.id.startsWith("employee:restaurant:")),
    false,
  );
  assert.ok(report.items.some((item) => item.id === "invalid-source:employee"));
  assert.match(employeeSource.reason, /不能作为 0\/72 的产品结论/u);
  assert.match(
    report.sources.find((source) => source.name === "content").reason,
    /升级前口径/u,
  );
});

test("报告不携带 raw body、密码或巨量正文", () => {
  const fixtures = correctedFixtures();
  fixtures.getReport.results[0].output.rawBody = `sk-secret-value ${"X".repeat(100_000)}`;
  fixtures.getReport.results[0].output.json = {
    password: "top-secret",
    rows: ["X".repeat(100_000)],
  };
  fixtures.getReport.results[0].output.bodyPreview =
    '{"password":"preview-secret","token":"preview-token"}';
  fixtures.getReport.results[0].output.shape.keys.push(
    "prompt",
    "access_token",
  );
  const report = buildFullFeatureReport({
    ...fixtures,
    generatedAt: "2026-08-21T08:00:00.000Z",
  });
  const serialized = JSON.stringify(report);
  const markdown = renderFullFeatureMarkdown(report);
  assert.doesNotMatch(
    serialized,
    /rawBody|top-secret|sk-secret-value|preview-secret|preview-token|"prompt"|access_token/u,
  );
  assert.doesNotMatch(
    markdown,
    /rawBody|top-secret|sk-secret-value|preview-secret|preview-token/u,
  );
  assert.ok(markdown.length < 80_000);
});

test("页面同路径的角色边界证据不会在合并时丢失", () => {
  const fixtures = correctedFixtures();
  fixtures.webReport.results.push({
    id: "web:/tasks:viewer",
    path: "/tasks",
    input: { path: "/tasks", role: "viewer", action: "验证只读角色权限" },
    output: { status: 403, rendered: false, keyElements: [] },
    quality: {
      verdict: "NEGATIVE_BOUNDARY_PASS",
      pass: true,
      happyPathPass: false,
      score: 90,
    },
  });
  const report = buildFullFeatureReport({
    ...fixtures,
    generatedAt: "2026-08-21T08:00:00.000Z",
  });
  assert.equal(report.summary.categories.negative_boundary, 2);
  assert.equal(report.items.filter((item) => item.source === "web").length, 3);
  assert.ok(report.items.some((item) => item.id === "web:/tasks:viewer"));
});

test("UNVERIFIED 探针结果保留整源有效并归入尚未验证", () => {
  const fixtures = correctedFixtures();
  fixtures.getReport.results.push(
    probeResult("api:GET:/api/content/pipelines", "UNVERIFIED", 200, {
      quality: { pass: false, happyPathPass: false, score: 0 },
      preview: "请求成功但未取得契约正向证据",
    }),
  );
  const report = buildFullFeatureReport({
    ...fixtures,
    generatedAt: "2026-08-21T08:00:00.000Z",
  });
  assert.equal(
    report.sources.find((source) => source.name === "get").status,
    "authoritative",
  );
  assert.equal(
    report.items.find((item) => item.id === "api:GET:/api/content/pipelines")
      .category,
    "unverified",
  );
  assert.equal(report.summary.currentInterfaceProbeFailure, 1);
});

test("导出器要求显式业务功能和可重复输出质量输入", () => {
  const baseArgs = [
    "--inventory",
    "inventory.json",
    "--get",
    "get.json",
    "--write",
    "write.json",
    "--web",
    "web.json",
    "--employee",
    "employee.json",
    "--content",
    "content.json",
    "--json-out",
    "report.json",
    "--md-out",
    "report.md",
  ];
  assert.throws(
    () => parseArgs(baseArgs),
    /必须提供 --feature（或 --business-feature）/u,
  );
  assert.throws(
    () => parseArgs([...baseArgs, "--feature", "business.json"]),
    /至少需要一个 --output-quality/u,
  );
  const parsed = parseArgs([
    ...baseArgs,
    "--feature",
    "business.json",
    "--output-quality",
    "older-quality.json",
    "--output-quality",
    "newer-quality.json",
  ]);
  assert.equal(parsed.files.businessFeature, path.resolve("business.json"));
  assert.deepEqual(parsed.outputQualityFiles, [
    path.resolve("older-quality.json"),
    path.resolve("newer-quality.json"),
  ]);
});

test("导出器用显式八类证据可重复生成同一 reportId 的 Markdown 和语义 JSON", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nanowork-full-report-"),
  );
  const fixtures = correctedFixtures();
  const businessFeatureReport = businessFeatureFixture();
  const matrixFile = path.join(directory, "matrix.json");
  const matrixBody = JSON.stringify({ schemaVersion: "matrix.v1", jobs: [] });
  const matrixSha256 = crypto
    .createHash("sha256")
    .update(matrixBody)
    .digest("hex");
  const outputQualityReport = outputQualityFixture({
    generatedAt: "2026-08-01T01:00:00.000Z",
    passed: true,
    sourceName: path.basename(matrixFile),
    matrixSha256,
  });
  const files = {};
  for (const [name, value] of Object.entries({
    inventory: fixtures.inventory,
    get: fixtures.getReport,
    write: fixtures.writeReport,
    web: fixtures.webReport,
    employee: fixtures.employeeReport,
    content: fixtures.contentReport,
    businessFeature: businessFeatureReport,
  })) {
    files[name] = path.join(directory, `${name}.json`);
    fs.writeFileSync(files[name], JSON.stringify(value));
  }
  fs.writeFileSync(matrixFile, matrixBody);
  const outputQualityFiles = [path.join(directory, "output-quality.json")];
  fs.writeFileSync(outputQualityFiles[0], JSON.stringify(outputQualityReport));
  const options = {
    files,
    outputQualityFiles,
    jsonOut: path.join(directory, "report.json"),
    mdOut: path.join(directory, "report.md"),
    superseded: [path.join(directory, "old-report.md")],
    projectUrl: "http://127.0.0.1:3107/",
    title: "测试报告",
    generatedAt: "2026-08-21T08:00:00.000Z",
  };
  const first = exportFullFeatureReport(options);
  const second = exportFullFeatureReport(options);
  assert.equal(first.report.reportId, second.report.reportId);
  assert.equal(
    JSON.parse(fs.readFileSync(options.jsonOut, "utf8")).reportId,
    first.report.reportId,
  );
  assert.match(fs.readFileSync(options.mdOut, "utf8"), /# 测试报告/u);
  assert.match(fs.readFileSync(options.mdOut, "utf8"), /业务功能报告结论/u);
  assert.match(fs.readFileSync(options.mdOut, "utf8"), /员工输出质量报告结论/u);
  assert.equal(fs.statSync(options.jsonOut).mode & 0o777, 0o600);
  assert.equal(fs.statSync(options.mdOut).mode & 0o777, 0o600);
});

test("输出质量引用矩阵必须存在且实算哈希一致，并拒绝路径穿越", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nanowork-quality-reference-"),
  );
  const fixtures = correctedFixtures();
  const files = {};
  for (const [name, value] of Object.entries({
    inventory: fixtures.inventory,
    get: fixtures.getReport,
    write: fixtures.writeReport,
    web: fixtures.webReport,
    employee: fixtures.employeeReport,
    content: fixtures.contentReport,
    businessFeature: businessFeatureFixture(),
  })) {
    files[name] = path.join(directory, `${name}.json`);
    fs.writeFileSync(files[name], JSON.stringify(value));
  }

  const validMatrixBody = JSON.stringify({ kind: "valid-matrix" });
  const validMatrixSha256 = crypto
    .createHash("sha256")
    .update(validMatrixBody)
    .digest("hex");
  fs.writeFileSync(path.join(directory, "valid-matrix.json"), validMatrixBody);

  const tamperedMatrixBody = JSON.stringify({ kind: "tampered-matrix" });
  const tamperedActualSha256 = crypto
    .createHash("sha256")
    .update(tamperedMatrixBody)
    .digest("hex");
  fs.writeFileSync(
    path.join(directory, "tampered-matrix.json"),
    tamperedMatrixBody,
  );

  const outsideMatrixFile = `${directory}-outside-matrix.json`;
  const outsideMatrixBody = "outside-secret-content-must-not-be-read";
  const outsideMatrixSha256 = crypto
    .createHash("sha256")
    .update(outsideMatrixBody)
    .digest("hex");
  fs.writeFileSync(outsideMatrixFile, outsideMatrixBody);
  const unsafeMatrixReference = `../${path.basename(outsideMatrixFile)}`;

  const qualityInputs = [
    {
      file: "valid-quality.json",
      report: outputQualityFixture({
        generatedAt: "2026-08-01T00:00:00.000Z",
        employeeIdx: 101,
        sourceName: "valid-matrix.json",
        matrixSha256: validMatrixSha256,
      }),
    },
    {
      file: "tampered-quality.json",
      report: outputQualityFixture({
        generatedAt: "2026-08-01T03:00:00.000Z",
        employeeIdx: 102,
        sourceName: "tampered-matrix.json",
        matrixSha256: "d".repeat(64),
      }),
    },
    {
      file: "missing-quality.json",
      report: outputQualityFixture({
        generatedAt: "2026-08-01T04:00:00.000Z",
        employeeIdx: 103,
        sourceName: "missing-matrix.json",
        matrixSha256: "e".repeat(64),
      }),
    },
    {
      file: "unsafe-quality.json",
      report: outputQualityFixture({
        generatedAt: "2026-08-01T05:00:00.000Z",
        employeeIdx: 104,
        sourceName: unsafeMatrixReference,
        matrixSha256: outsideMatrixSha256,
      }),
    },
    {
      file: "external-absolute-quality.json",
      report: outputQualityFixture({
        generatedAt: "2026-08-01T06:00:00.000Z",
        employeeIdx: 105,
        sourceName: outsideMatrixFile,
        matrixSha256: outsideMatrixSha256,
      }),
    },
  ];
  const outputQualityFiles = qualityInputs.map(({ file, report }) => {
    const qualityFile = path.join(directory, file);
    fs.writeFileSync(qualityFile, JSON.stringify(report));
    return qualityFile;
  });

  const options = {
    files,
    outputQualityFiles,
    jsonOut: path.join(directory, "report.json"),
    mdOut: path.join(directory, "report.md"),
    superseded: [],
    generatedAt: "2026-08-21T08:00:00.000Z",
  };
  const { report, markdown } = exportFullFeatureReport(options);
  const qualitySources = report.sources.filter(
    (source) => source.family === "output_quality",
  );
  const [valid, tampered, missing, unsafe, externalAbsolute] = qualitySources;

  assert.equal(valid.status, "historical_evidence");
  assert.equal(valid.diagnostics.referencedMatrix.status, "verified");
  assert.equal(valid.diagnostics.referencedMatrix.hashMatches, true);
  assert.equal(
    report.domainConclusions.employeeOutputQuality.selectedSource.name,
    valid.name,
  );
  assert.equal(
    report.domainConclusions.employeeOutputQuality.distinctAuditedEmployees,
    1,
  );

  assert.equal(tampered.status, "superseded_invalid");
  assert.equal(tampered.diagnostics.referencedMatrix.status, "hash_mismatch");
  assert.equal(
    tampered.diagnostics.referencedMatrix.actualSha256,
    tamperedActualSha256,
  );
  assert.match(tampered.reason, /实算 SHA-256 不匹配/u);

  assert.equal(missing.status, "superseded_invalid");
  assert.equal(missing.diagnostics.referencedMatrix.status, "missing");
  assert.match(missing.reason, /引用矩阵不存在/u);

  assert.equal(unsafe.status, "superseded_invalid");
  assert.equal(unsafe.diagnostics.referencedMatrix.status, "unsafe_path");
  assert.equal(unsafe.diagnostics.referencedMatrix.resolvedPath, null);
  assert.match(unsafe.reason, /路径不安全/u);
  assert.equal(externalAbsolute.status, "superseded_invalid");
  assert.equal(
    externalAbsolute.diagnostics.referencedMatrix.status,
    "unsafe_path",
  );
  assert.equal(
    externalAbsolute.diagnostics.referencedMatrix.resolvedPath,
    null,
  );
  assert.match(markdown, /实算 SHA-256 不匹配/u);
  assert.match(markdown, /引用矩阵不存在/u);
  assert.match(markdown, /路径不安全/u);
  assert.doesNotMatch(JSON.stringify(report), /outside-secret-content/u);

  fs.writeFileSync(
    path.join(directory, "tampered-matrix.json"),
    JSON.stringify({ kind: "tampered-again" }),
  );
  const afterSecondTamper = exportFullFeatureReport(options).report;
  assert.notEqual(afterSecondTamper.reportId, report.reportId);
});
