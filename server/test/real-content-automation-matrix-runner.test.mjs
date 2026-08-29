import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTENT_AUTOMATION_EMPLOYEE_CASES,
  REAL_CONTENT_AUTOMATION_MATRIX_SCHEMA,
  assertIsolatedDatabasePaths,
  assertSafeAutomationOutputPath,
  buildContentAutomationJobs,
  evaluateAutomationEvidence,
  isOfficialYunwuBaseUrl,
  parseAutomationModes,
  parseContentEmployeeSelection,
  projectAutomationEvidence,
  sanitizeAutomationArtifact,
  summarizeAutomationResults,
} from "../../scripts/lib/real-content-automation-matrix.mjs";
import { CONTENT_TASK_TYPES_BY_EMPLOYEE } from "../src/engines/content-employee-workbench.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const RUNNER = path.join(
  ROOT,
  "scripts",
  "run-real-content-automation-matrix.mjs",
);

function immediateEvidence() {
  return {
    jobKey: "content:3:immediate",
    employee: { idx: 3, key: "draft", name: "撰稿人", taskType: "文案初稿" },
    mode: "immediate",
    rule: { id: 11, employeeIdx: 3, enabled: false, nextRunAt: null },
    run: {
      id: 21,
      trigger: "immediate",
      scheduledFor: null,
      status: "成功",
      contentId: 31,
      finishedAt: "2026-07-31 10:02:00",
      profileVersion: "content-3-r5",
      promptHash: "a".repeat(64),
      contract: { status: "valid", valid: true, artifactCount: 1 },
      billing: {
        state: "settled",
        holdId: 41,
        estimatedCredits: 80,
        chargedCredits: 18,
        heldCredits: 0,
        balance: 999982,
      },
    },
    provider: {
      mode: "api",
      model: "gpt-5.5",
      attemptCount: 1,
      inputTokens: 1234,
      outputTokens: 567,
    },
    profileSnapshot: {
      schemaVersion: "content-automation-snapshot.v1",
      profileVersion: "content-3-r5",
      promptHash: "a".repeat(64),
      identityIdx: 3,
      identityKey: "draft",
      capabilityCount: 5,
      requiredSkillCount: 1,
      historicalSkillCount: 5,
      hasWorkMethod: true,
      hasPrompts: true,
      hasWorkConfig: true,
      hasJobProfile: true,
      hasDispatch: true,
      hasProvenance: true,
      enterpriseWorkConfigApplied: true,
      promptTextStored: false,
      canonicalMatch: true,
      profileFingerprint: "d".repeat(64),
      canonicalProfileFingerprint: "d".repeat(64),
      capabilityFingerprint: "e".repeat(64),
      skillFingerprint: "f".repeat(64),
      capabilityIds: Array.from(
        { length: 5 },
        (_, index) =>
          `capability:v1:e003:c${String(index + 1).padStart(3, "0")}`,
      ),
      skillIds: [
        "factory-skill:v1:e003:s001",
        ...Array.from(
          { length: 5 },
          (_, index) =>
            `legacy-skill:v1:e003:s${String(index + 1).padStart(3, "0")}`,
        ),
      ],
      complete: true,
    },
    web: {
      required: false,
      attempted: false,
      verified: false,
      provider: null,
      resultCount: 0,
      sourceHosts: [],
      sourceUrlHashes: [],
      trustedSourceCount: 0,
      untrustedSourceHosts: [],
      providerTrusted: false,
    },
    contract: { valid: true, status: "valid", artifactCount: 1, errorCount: 0 },
    specialProvider: {
      expected: false,
      attemptCount: 0,
      expectedAttemptCount: 0,
      attempts: [],
      totalEstimatedCredits: 0,
      totalChargedCredits: 0,
      totalHeldCredits: 0,
      materialCount: 0,
    },
    persistence: {
      id: 31,
      status: "待审核",
      aiMode: "api",
      employeeIdx: 3,
      employeeKey: "draft",
      runMode: "automation_immediate",
      profileVersion: "content-3-r5",
      promptHash: "a".repeat(64),
      runProfileVersion: "content-3-r5",
      runPromptHash: "a".repeat(64),
      bodyChars: 600,
      bodySha256: "b".repeat(64),
      approvalCount: 1,
      pendingApprovalCount: 1,
      authenticatedReadbackMatches: true,
    },
    billingAuthority: {
      hold: {
        id: 41,
        logId: 51,
        tenantId: 801,
        userId: 91,
        status: "settled",
        feature: "内容自动化·文案初稿",
        kind: "text",
        model: "gpt-5.5",
        heldCredits: 80,
        settledCredits: 18,
        refType: "content_automation_run",
        refId: 21,
      },
      creditLog: {
        id: 51,
        tenantId: 801,
        userId: 91,
        feature: "内容自动化·文案初稿",
        kind: "text",
        aiMode: "api",
        model: "gpt-5.5",
        inputTokens: 1234,
        outputTokens: 567,
        credits: 18,
        costYuan: 0.12,
        balanceAfter: 999982,
      },
      holdCount: 1,
      creditLogCount: 1,
      fullBillingLogCount: 1,
      tenantId: 801,
      userId: 91,
      balanceBefore: 1000000,
      holdIdBefore: 40,
      creditLogIdBefore: 50,
      tenantBalance: 999982,
      ownHeldCount: 0,
      aggregate: {
        estimatedCredits: 80,
        chargedCredits: 18,
        heldCredits: 0,
        ledgerCount: 1,
      },
    },
    idempotency: {
      sameRunId: true,
      reused: true,
      runCount: 1,
      billingLogCountStable: true,
      billingLogCountComplete: true,
    },
    scheduler: null,
    recovery: null,
    externalEffects: {
      publishLogCount: 0,
      derivedAssetCount: 0,
      derivedKnowledgeCount: 0,
      externalPublishAllowed: false,
      published: false,
      tenantDelta: {
        approvals: 1,
        pendingApprovals: 1,
        publishLogs: 0,
        assets: 0,
        knowledge: 0,
        materials: 0,
      },
    },
    cleanup: {
      ruleDisabled: true,
      nextRunAt: null,
      usedDatabaseFallback: false,
    },
  };
}

function scheduledEvidence() {
  const evidence = structuredClone(immediateEvidence());
  evidence.jobKey = "content:9:scheduled";
  evidence.employee = {
    idx: 9,
    key: "retro",
    name: "复盘官",
    taskType: "复盘报告",
  };
  evidence.mode = "scheduled";
  evidence.rule.employeeIdx = 9;
  evidence.run.trigger = "scheduled";
  evidence.run.scheduledFor = "2026-07-31 10:00:00";
  evidence.persistence.employeeIdx = 9;
  evidence.persistence.employeeKey = "retro";
  evidence.persistence.runMode = "automation_scheduled";
  evidence.persistence.profileVersion = "content-9-r2";
  evidence.persistence.runProfileVersion = "content-9-r2";
  evidence.run.profileVersion = "content-9-r2";
  evidence.profileSnapshot.profileVersion = "content-9-r2";
  evidence.profileSnapshot.identityIdx = 9;
  evidence.profileSnapshot.identityKey = "retro";
  evidence.idempotency = null;
  evidence.scheduler = {
    firstClaimCount: 1,
    secondClaimCount: 0,
    scheduledFor: "2026-07-31 10:00:00",
    nextRunAtAfterClaim: "2026-08-01 10:00:00",
    runCountForScheduledFor: 1,
    idempotentReplay: true,
    billingLogCountStable: true,
    billingLogCountComplete: true,
  };
  evidence.recovery = {
    recoveredOnce: true,
    runStatus: "失败",
    billingState: "released",
    holdStatus: "settled",
    settledCredits: 0,
    balanceRestored: true,
    nextRunAtAdvanced: true,
    ownHeldCount: 0,
    ruleDisabled: true,
    scheduledFor: "2026-07-31 10:03:00",
  };
  return evidence;
}

test("内容自动化矩阵定义覆盖0-9号完整员工且任务类型与服务端白名单一致", () => {
  assert.equal(
    REAL_CONTENT_AUTOMATION_MATRIX_SCHEMA,
    "nanowork.real-content-automation-matrix.v2",
  );
  assert.equal(CONTENT_AUTOMATION_EMPLOYEE_CASES.length, 10);
  assert.deepEqual(
    CONTENT_AUTOMATION_EMPLOYEE_CASES.map((item) => item.idx),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.equal(
    new Set(CONTENT_AUTOMATION_EMPLOYEE_CASES.map((item) => item.key)).size,
    10,
  );
  for (const employee of CONTENT_AUTOMATION_EMPLOYEE_CASES) {
    assert.ok(
      CONTENT_TASK_TYPES_BY_EMPLOYEE[employee.idx].includes(employee.taskType),
    );
    assert.match(employee.requirement, /不发布|禁止.*外发/u);
    assert.ok(employee.requirement.length >= 80);
  }
  const jobs = buildContentAutomationJobs();
  assert.equal(jobs.length, 20);
  assert.equal(new Set(jobs.map((item) => item.key)).size, 20);
  assert.equal(jobs.filter((item) => item.mode === "immediate").length, 10);
  assert.equal(jobs.filter((item) => item.mode === "scheduled").length, 10);
});

test("员工和模式参数支持范围、去重、稳定排序并拒绝越界值", () => {
  assert.deepEqual(parseContentEmployeeSelection("0-3,3,9"), [0, 1, 2, 3, 9]);
  assert.deepEqual(
    parseContentEmployeeSelection("all"),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.deepEqual(parseAutomationModes("scheduled,immediate,scheduled"), [
    "immediate",
    "scheduled",
  ]);
  assert.throws(() => parseContentEmployeeSelection("9-3"), /倒序/u);
  assert.throws(() => parseContentEmployeeSelection("10"), /0-9/u);
  assert.throws(() => parseAutomationModes("manual"), /模式无效/u);
});

test("隔离数据库路径门禁拒绝源库与工作库同路径", () => {
  const result = assertIsolatedDatabasePaths("/tmp/source.db", "/tmp/work.db");
  assert.equal(result.source, "/tmp/source.db");
  assert.equal(result.work, "/tmp/work.db");
  assert.throws(
    () =>
      assertIsolatedDatabasePaths("/tmp/source.db", "/tmp/../tmp/source.db"),
    /同一路径/u,
  );
});

test("证据输出路径在任何写入前拒绝覆盖源库、软链接别名和隔离库", () => {
  const directory = fs.mkdtempSync(
    path.join(process.env.TMPDIR || "/tmp", "nanowork-output-guard-"),
  );
  try {
    const source = path.join(directory, "source.db");
    const isolated = path.join(directory, "isolated.db");
    const alias = path.join(directory, "source-alias.json");
    const valid = path.join(directory, "evidence.json");
    fs.writeFileSync(source, "source-db-sentinel");
    fs.writeFileSync(isolated, "isolated-db-sentinel");
    fs.symlinkSync(source, alias);
    const sourceBefore = fs.readFileSync(source, "utf8");

    assert.throws(
      () =>
        assertSafeAutomationOutputPath({
          sourceDb: source,
          outputPath: source,
        }),
      /\.json|源数据库/u,
    );
    assert.throws(
      () =>
        assertSafeAutomationOutputPath({ sourceDb: source, outputPath: alias }),
      /源数据库/u,
    );
    assert.throws(
      () =>
        assertSafeAutomationOutputPath({
          sourceDb: source,
          outputPath: path.join(directory, ".", "isolated.db"),
          isolatedDb: isolated,
        }),
      /\.json|隔离数据库/u,
    );
    assert.throws(
      () =>
        assertSafeAutomationOutputPath({
          sourceDb: source,
          outputPath: directory,
        }),
      /\.json|目录/u,
    );
    const safe = assertSafeAutomationOutputPath({
      sourceDb: source,
      outputPath: valid,
      isolatedDb: isolated,
    });
    assert.equal(
      safe.output,
      path.join(fs.realpathSync.native(directory), "evidence.json"),
    );
    assert.equal(fs.readFileSync(source, "utf8"), sourceBefore);
    assert.equal(
      fs
        .readdirSync(directory)
        .some((name) => name.includes("content-automation-real")),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("立即运行证据必须同时通过真实API、幂等、持久化、审批、计费与无发布门禁", () => {
  const valid = evaluateAutomationEvidence(immediateEvidence());
  assert.equal(valid.pass, true, valid.errors.join("\n"));

  const invalid = immediateEvidence();
  invalid.provider.mode = "template";
  invalid.provider.model = "fallback-template";
  invalid.idempotency.runCount = 2;
  invalid.persistence.authenticatedReadbackMatches = false;
  invalid.persistence.pendingApprovalCount = 2;
  invalid.profileSnapshot.complete = false;
  invalid.billingAuthority.creditLog.outputTokens = 566;
  invalid.billingAuthority.tenantBalance = 999981;
  invalid.billingAuthority.ownHeldCount = 1;
  invalid.externalEffects.publishLogCount = 1;
  invalid.externalEffects.derivedAssetCount = 1;
  invalid.cleanup.ruleDisabled = false;
  const failed = evaluateAutomationEvidence(invalid);
  assert.equal(failed.pass, false);
  assert.match(failed.errors.join("\n"), /真实API/u);
  assert.match(failed.errors.join("\n"), /重复运行/u);
  assert.match(failed.errors.join("\n"), /详情接口/u);
  assert.match(failed.errors.join("\n"), /完整岗位快照/u);
  assert.match(failed.errors.join("\n"), /待审/u);
  assert.match(failed.errors.join("\n"), /token/u);
  assert.match(failed.errors.join("\n"), /余额/u);
  assert.match(failed.errors.join("\n"), /held/u);
  assert.match(failed.errors.join("\n"), /发布/u);
  assert.match(failed.errors.join("\n"), /资产/u);
  assert.match(failed.errors.join("\n"), /停用/u);
});

test("多媒体/封面岗必须额外证明真实图片provider、独立账单与素材入库", () => {
  const evidence = immediateEvidence();
  evidence.jobKey = "content:5:immediate";
  evidence.employee = {
    idx: 5,
    key: "media",
    name: "多媒体师",
    taskType: "多媒体素材方案",
  };
  evidence.rule.employeeIdx = 5;
  evidence.persistence.employeeIdx = 5;
  evidence.persistence.employeeKey = "media";
  evidence.profileSnapshot.identityIdx = 5;
  evidence.profileSnapshot.identityKey = "media";
  evidence.run.billing.estimatedCredits = 105;
  evidence.run.billing.chargedCredits = 43;
  evidence.run.billing.balance = 999957;
  evidence.billingAuthority.creditLog.balanceAfter = 999957;
  evidence.billingAuthority.tenantBalance = 999957;
  evidence.billingAuthority.fullBillingLogCount = 2;
  evidence.billingAuthority.aggregate = {
    estimatedCredits: 105,
    chargedCredits: 43,
    heldCredits: 0,
    ledgerCount: 2,
  };
  evidence.specialProvider = {
    expected: true,
    attemptCount: 1,
    expectedAttemptCount: 1,
    totalEstimatedCredits: 25,
    totalChargedCredits: 25,
    totalHeldCredits: 0,
    materialCount: 1,
    attempts: [
      {
        attemptId:
          "content-automation:pipeline:21:station:5:provider:image:attempt:1",
        kind: "image",
        status: "settled",
        requestFingerprint: `sha256:${"1".repeat(64)}`,
        namespaceStable: true,
        billingRefType: "content_special_provider",
        billingRefId: 7001,
        hold: {
          id: 61,
          logId: 62,
          status: "settled",
          heldCredits: 25,
          settledCredits: 25,
        },
        creditLog: {
          id: 62,
          aiMode: "api",
          kind: "image",
          model: "gpt-image-2",
          credits: 25,
          balanceAfter: 999975,
        },
        holdCount: 1,
        creditLogCount: 1,
        delivery: { persisted: true, artifactCount: 1, materialCount: 1 },
        materials: [
          {
            id: 71,
            sourceType: "content_special_provider",
            sourceId: 21,
            creatorId: 91,
            snapshotHash: "2".repeat(64),
            schemaVersion: "nanowork.content-special-provider-artifact/2",
            attemptIdMatches: true,
            billingRefMatches: true,
            credentialsIncluded: false,
            binaryInMetadata: false,
          },
        ],
      },
    ],
  };
  evidence.externalEffects.tenantDelta.materials = 1;

  const passed = evaluateAutomationEvidence(evidence);
  assert.equal(passed.pass, true, passed.errors.join("\n"));

  const missingMaterial = structuredClone(evidence);
  missingMaterial.specialProvider.attempts[0].materials = [];
  missingMaterial.specialProvider.attempts[0].delivery.materialCount = 0;
  assert.equal(evaluateAutomationEvidence(missingMaterial).pass, false);
});

test("定时运行证据必须包含到期单次认领、重放不重扣、nextRunAt与恢复退款", () => {
  const valid = evaluateAutomationEvidence(scheduledEvidence());
  assert.equal(valid.pass, true, valid.errors.join("\n"));

  const invalid = scheduledEvidence();
  invalid.scheduler.secondClaimCount = 1;
  invalid.scheduler.runCountForScheduledFor = 2;
  invalid.scheduler.billingLogCountStable = false;
  invalid.scheduler.nextRunAtAfterClaim = invalid.scheduler.scheduledFor;
  invalid.recovery.billingState = "pending_reconciliation";
  invalid.recovery.holdStatus = "held";
  invalid.recovery.balanceRestored = false;
  invalid.recovery.ruleDisabled = false;
  const failed = evaluateAutomationEvidence(invalid);
  assert.equal(failed.pass, false);
  const errors = failed.errors.join("\n");
  assert.match(errors, /重复认领/u);
  assert.match(errors, /重复计费/u);
  assert.match(errors, /nextRunAt/u);
  assert.match(errors, /全额退回/u);
  assert.match(errors, /规则未停用/u);
});

test("趋势、情报和拆解岗必须有可核验联网证据，其他岗不得冒充已联网", () => {
  for (const idx of [0, 1, 2]) {
    const evidence = immediateEvidence();
    evidence.employee = {
      idx,
      key: CONTENT_AUTOMATION_EMPLOYEE_CASES[idx].key,
      name: CONTENT_AUTOMATION_EMPLOYEE_CASES[idx].name,
      taskType: CONTENT_AUTOMATION_EMPLOYEE_CASES[idx].taskType,
    };
    evidence.rule.employeeIdx = idx;
    evidence.persistence.employeeIdx = idx;
    evidence.persistence.employeeKey = evidence.employee.key;
    evidence.profileSnapshot.identityIdx = idx;
    evidence.profileSnapshot.identityKey = evidence.employee.key;
    evidence.web = {
      required: true,
      attempted: true,
      verified: true,
      provider: "博查",
      resultCount: 2,
      sourceHosts: ["samr.gov.cn", "stats.gov.cn"],
      sourceUrlHashes: ["c".repeat(64), "d".repeat(64)],
      trustedSourceCount: 2,
      untrustedSourceHosts: [],
      providerTrusted: true,
    };
    assert.equal(
      evaluateAutomationEvidence(evidence).pass,
      true,
      `content:${idx}`,
    );

    const missing = structuredClone(evidence);
    missing.web.verified = false;
    missing.web.resultCount = 0;
    missing.web.sourceHosts = [];
    missing.web.sourceUrlHashes = [];
    missing.web.trustedSourceCount = 0;
    const failed = evaluateAutomationEvidence(missing);
    assert.equal(failed.pass, false);
    assert.match(failed.errors.join("\n"), /联网/u);
  }

  const nonWeb = immediateEvidence();
  nonWeb.web.attempted = true;
  nonWeb.web.verified = true;
  nonWeb.web.provider = "fallback";
  nonWeb.web.resultCount = 1;
  nonWeb.web.sourceHosts = ["example.test"];
  nonWeb.web.sourceUrlHashes = ["c".repeat(64)];
  const failed = evaluateAutomationEvidence(nonWeb);
  assert.equal(failed.pass, false);
  assert.match(failed.errors.join("\n"), /不强制联网/u);

  for (const forgedWeb of [
    {
      provider: "手填provider",
      sourceHosts: ["samr.gov.cn"],
      trustedSourceCount: 1,
      untrustedSourceHosts: [],
      providerTrusted: false,
    },
    {
      provider: "博查",
      sourceHosts: ["example.test"],
      trustedSourceCount: 0,
      untrustedSourceHosts: ["example.test"],
      providerTrusted: true,
    },
  ]) {
    const forged = immediateEvidence();
    forged.employee = { ...CONTENT_AUTOMATION_EMPLOYEE_CASES[0] };
    forged.rule.employeeIdx = 0;
    forged.persistence.employeeIdx = 0;
    forged.persistence.employeeKey = "trend";
    forged.profileSnapshot.identityIdx = 0;
    forged.profileSnapshot.identityKey = "trend";
    forged.web = {
      required: true,
      attempted: true,
      verified: true,
      resultCount: 1,
      sourceUrlHashes: ["c".repeat(64)],
      ...forgedWeb,
    };
    const result = evaluateAutomationEvidence(forged);
    assert.equal(result.pass, false);
    assert.match(result.errors.join("\n"), /可信|联网/u);
  }
});

test("待审边界必须有恰好1张待审单，且审阅前资产/知识/发布的租户级delta全为0", () => {
  const valid = evaluateAutomationEvidence(immediateEvidence());
  assert.equal(valid.pass, true, valid.errors.join("\n"));

  for (const mutation of [
    (row) => {
      row.persistence.pendingApprovalCount = 2;
      row.externalEffects.tenantDelta.pendingApprovals = 2;
    },
    (row) => {
      row.externalEffects.tenantDelta.assets = 1;
    },
    (row) => {
      row.externalEffects.tenantDelta.knowledge = 1;
    },
    (row) => {
      row.externalEffects.tenantDelta.publishLogs = 1;
    },
  ]) {
    const forged = immediateEvidence();
    mutation(forged);
    const result = evaluateAutomationEvidence(forged);
    assert.equal(result.pass, false);
    assert.match(result.errors.join("\n"), /待审|资产|知识|发布/u);
  }
});

test("账务证据必须是tenant+user+唯一hold/log精确关联且余额恒等", () => {
  const valid = evaluateAutomationEvidence(immediateEvidence());
  assert.equal(valid.pass, true, valid.errors.join("\n"));
  for (const mutation of [
    (row) => {
      row.billingAuthority.hold.tenantId = 999;
    },
    (row) => {
      row.billingAuthority.creditLog.userId = 999;
    },
    (row) => {
      row.billingAuthority.hold.logId = 999;
    },
    (row) => {
      row.billingAuthority.creditLog.kind = "image";
    },
    (row) => {
      row.billingAuthority.tenantBalance += 1;
    },
    (row) => {
      row.billingAuthority.hold.id = row.billingAuthority.holdIdBefore;
    },
    (row) => {
      row.billingAuthority.creditLog.id =
        row.billingAuthority.creditLogIdBefore;
    },
  ]) {
    const forged = immediateEvidence();
    mutation(forged);
    const result = evaluateAutomationEvidence(forged);
    assert.equal(result.pass, false);
    assert.match(result.errors.join("\n"), /账务|租户|用户|余额|流水|预授权/u);
  }
});

test("证据投影只保存正文长度和哈希，不保存全量正文或内部提示词", () => {
  const body = "这是一段只用于单元测试的生成正文".repeat(20);
  const evidence = projectAutomationEvidence({
    job: {
      key: "content:3:immediate",
      mode: "immediate",
      employee: CONTENT_AUTOMATION_EMPLOYEE_CASES[3],
    },
    rule: { id: 1, employee_idx: 3, enabled: 0, next_run_at: null },
    publicRun: {
      id: 2,
      trigger: "immediate",
      status: "成功",
      contentId: 3,
      finishedAt: "2026-07-31 10:00:00",
      contract: { valid: true, artifacts: [] },
      billing: { state: "settled", holdId: 4 },
    },
    content: {
      id: 3,
      body,
      status: "待审核",
      ai_mode: "api",
      content_employee_idx: 3,
      content_employee_key: "draft",
      content_run_mode: "automation_immediate",
      profile_version: "content-3-r1",
      prompt_hash: "c".repeat(64),
    },
    contentReadback: { id: 3, body },
    runSnapshot: {
      schemaVersion: "content-automation-snapshot.v1",
      profileVersion: "content-3-r1",
      promptHash: "c".repeat(64),
      identity: { idx: 3, key: "draft" },
      capabilities: [{ name: "撰稿" }],
      workMethod: { execution: { webRequired: false } },
      skillLibrary: {
        required: [{ title: "出厂技能" }],
        historical: [{ title: "历史技能" }],
      },
      prompts: { systemPrompt: "不得落证据" },
      workConfig: { factoryDefault: {} },
      jobProfile: { roleKey: "draft" },
      dispatch: { form: [] },
      provenance: { noSilentFallback: true },
      enterpriseOverlay: {
        workConfig: { outputLength: "std" },
        promptTextStored: false,
      },
      web: {
        required: false,
        attempted: false,
        verified: false,
        provider: null,
        results: [],
      },
      providerAttempt: {
        mode: "api",
        model: "gpt-5.5",
        attemptCount: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      contract: {
        valid: true,
        status: "valid",
        errors: [],
        artifacts: [],
        parsedOutput: { secretBody: body },
      },
      automation: { externalPublishAllowed: false },
      systemPrompt: "不得写入投影的完整提示词",
    },
    hold: {
      id: 4,
      log_id: 5,
      status: "settled",
      held_credits: 10,
      settled_credits: 1,
      ref_type: "content_automation_run",
      ref_id: 2,
    },
    creditLog: {
      id: 5,
      ai_mode: "api",
      model: "gpt-5.5",
      input_tokens: 1,
      output_tokens: 1,
      credits: 1,
      balance_after: 99,
    },
    approvalCount: 1,
    pendingApprovalCount: 1,
    holdCount: 1,
    creditLogCount: 1,
    tenantBalance: 99,
    derivedAssetCount: 0,
    derivedKnowledgeCount: 0,
    publishLogCount: 0,
    cleanup: { ruleDisabled: true, nextRunAt: null },
  });
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(body), false);
  assert.equal(serialized.includes("不得写入投影的完整提示词"), false);
  assert.equal(evidence.persistence.bodyChars, body.length);
  assert.match(evidence.persistence.bodySha256, /^[a-f0-9]{64}$/u);
});

test("证据脱敏器删除密钥、JWT、cookie、credential和原始body", () => {
  const fakeProviderKey = ["sk", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
  const fakeJwt = `${"eyJhbGciOiJIUzI1NiJ9"}.${"eyJzdWIiOiIxMjM0NTY3ODkwIn0"}.signature_value`;
  const safe = sanitizeAutomationArtifact({
    password: "never-store",
    nested: {
      apiKey: "never-store",
      accessToken: "never-store",
      jwt: fakeJwt,
      cookie: "session=never-store",
      credential: "never-store",
      responseBody: `authorization: Bearer ${fakeJwt}`,
      note: `provider key ${fakeProviderKey}`,
      error: `Authorization: Bearer ${fakeJwt}; cookie=session-secret`,
      inputTokens: 123,
      outputTokens: 45,
      apiKeyPersisted: false,
      credentialsPersisted: false,
      ok: true,
    },
  });
  assert.equal(Object.hasOwn(safe, "password"), false);
  assert.equal(Object.hasOwn(safe.nested, "apiKey"), false);
  assert.equal(Object.hasOwn(safe.nested, "accessToken"), false);
  assert.equal(Object.hasOwn(safe.nested, "jwt"), false);
  assert.equal(Object.hasOwn(safe.nested, "cookie"), false);
  assert.equal(Object.hasOwn(safe.nested, "credential"), false);
  assert.equal(Object.hasOwn(safe.nested, "responseBody"), false);
  assert.equal(safe.nested.note, "provider key [REDACTED]");
  assert.equal(safe.nested.error.includes(fakeJwt), false);
  assert.equal(safe.nested.error.includes("session-secret"), false);
  assert.equal(safe.nested.inputTokens, 123);
  assert.equal(safe.nested.outputTokens, 45);
  assert.equal(safe.nested.apiKeyPersisted, false);
  assert.equal(safe.nested.credentialsPersisted, false);
  assert.equal(safe.nested.ok, true);
});

test("真实云基址只接受yunwu.ai官方HTTPS /v1域名", () => {
  assert.equal(isOfficialYunwuBaseUrl("https://yunwu.ai/v1"), true);
  assert.equal(isOfficialYunwuBaseUrl("https://api.yunwu.ai/v1"), true);
  assert.equal(isOfficialYunwuBaseUrl("https://api.yunwu.ai/v1/"), true);
  assert.equal(isOfficialYunwuBaseUrl("http://yunwu.ai/v1"), false);
  assert.equal(
    isOfficialYunwuBaseUrl("https://yunwu.ai.example.com/v1"),
    false,
  );
  assert.equal(isOfficialYunwuBaseUrl("https://127.0.0.1/v1"), false);
  assert.equal(isOfficialYunwuBaseUrl("https://user:pass@yunwu.ai/v1"), false);
  assert.equal(isOfficialYunwuBaseUrl("https://yunwu.ai/v1?token=x"), false);
});

test("汇总按立即/定时分开计数且token不重复", () => {
  const rows = [
    { pass: true, evidence: immediateEvidence() },
    { pass: false, evidence: scheduledEvidence() },
  ];
  const summary = summarizeAutomationResults(rows);
  assert.deepEqual(summary, {
    total: 2,
    passed: 1,
    failed: 1,
    tokens: { input: 2468, output: 1134 },
    byMode: {
      immediate: { total: 1, passed: 1 },
      scheduled: { total: 1, passed: 0 },
    },
  });
});

test("真实运行器源码强制只读克隆、动态隔离库导入、真调度认领、恢复与最终停用", () => {
  const source = fs.readFileSync(RUNNER, "utf8");
  assert.match(source, /new DatabaseSync\(sourcePath, \{ readOnly: true \}\)/u);
  assert.match(source, /VACUUM INTO/u);
  const dbPathSwitch = source.indexOf("process.env.NANOWORK_DB = isolatedDb");
  const dbDynamicImport = source.search(
    /await import\(["']\.\.\/server\/src\/db\.js["']\)/u,
  );
  assert.ok(
    dbPathSwitch >= 0 && dbDynamicImport >= 0 && dbPathSwitch < dbDynamicImport,
  );
  assert.match(source, /claimDueContentAutomationRules\(now\)/u);
  assert.match(source, /secondClaims/u);
  assert.match(source, /recoverStaleContentAutomationRuns\(now, 30\)/u);
  assert.match(source, /billingCountBeforeReplay/u);
  assert.match(source, /nextRunAtAfterClaim/u);
  assert.match(source, /body: \{ enabled: false \}/u);
  assert.match(source, /content_publish_logs/u);
  assert.match(source, /function finalSafetyAudit\(\)/u);
  assert.match(source, /isOfficialYunwuBaseUrl/u);
  assert.match(source, /withTotalTimeout/u);
  assert.match(source, /recoverOwnedRunsAndHolds/u);
  assert.match(source, /temporaryClonePreserved/u);
  assert.match(source, /temporaryCloneContainsSensitiveTenantData/u);
  assert.match(source, /cloneMayContainSensitiveConfiguration/u);
  assert.match(source, /databaseFileSetFingerprint/u);
  assert.match(source, /sourceFingerprintBefore/u);
  assert.match(source, /sourceFingerprintAfter/u);
  assert.match(source, /sourceUnchanged/u);
  assert.match(source, /REAL_CONTENT_AUTOMATION_ISOLATED_V1/u);
  assert.match(source, /requestImmediateRun/u);
  assert.match(source, /claim_key=\?/u);
  assert.match(source, /crypto\.randomUUID\(\).*\.tmp/u);
  assert.match(source, /flag: "wx"/u);
  assert.match(source, /0o600/u);
  assert.match(source, /SIGINT/u);
  assert.match(source, /SIGTERM/u);
  assert.match(source, /duplicateScheduledCycleCount/u);
  assert.match(source, /activeRunCount/u);
  assert.doesNotMatch(source, /employeeIdx:\s*3[,\n]/u);
  assert.doesNotMatch(source, /\/publish-log/u);
});

test("--help只输出用法，不需密码、不打开数据库且不调用外部API", () => {
  const child = spawnSync(process.execPath, [RUNNER, "--help"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH || "" },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /0-9号员工/u);
  assert.match(child.stdout, /scheduled 由真实调度认领/u);
  assert.equal(child.stderr, "");
});
