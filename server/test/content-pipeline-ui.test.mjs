import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildPaihuoContentBrief } from "../../web/src/components/contentBriefForm.js";
import {
  CONTENT_PIPELINE_APPROVAL_PRESETS,
  contentPipelineActualReviewStations,
  contentPipelineCanConfigureApproval,
  contentPipelineCanReview,
  contentPipelineCanViewRuntimePackageEvidence,
  contentPipelineHasAdvanced,
  contentPipelineLocalDateTimeValue,
  contentPipelineProgressSnapshot,
  contentPipelinePublicationMetricsProgress,
  contentPipelineQueuedReceipt,
  contentPipelinePresetStations,
  contentPipelineWorkflowModeForPreset,
  contentPipelineRuntimePackageEvidence,
  contentPipelineStatusMeta,
  pipelineCandidates,
  pipelineFailureText,
  pipelineStationRows,
} from "../../web/src/components/contentPipelinePresentation.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("pipeline create reuses the exact 11-field Paihuo Brief projection", () => {
  const brief = buildPaihuoContentBrief({
    title: "老板IP新品上市内容",
    type: "产品软文",
    industry: "餐饮连锁",
    requirement: "仅使用已确认的产品与价格资料",
    platforms: ["小红书", "视频号"],
    imageMode: "mix",
    imageCount: 0,
    enableDeck: false,
  });
  assert.equal(Object.keys(brief).length, 11);
  assert.equal(brief.image_count, 0);
  assert.equal(brief.xhs_style, null);
  assert.equal(brief.dy_style, null);
});

test("pipeline station presentation covers 0→9 without inventing missing statuses", () => {
  const rows = pipelineStationRows(
    {
      stations: [
        {
          stationIdx: 0,
          employeeKey: "trend",
          status: "completed",
          output: { topics: [{ title: "真实候选" }] },
        },
        {
          stationIdx: 1,
          employeeKey: "research",
          status: "failed",
          failure: { message: "检索通道超时" },
        },
      ],
    },
    [
      { order: 0, key: "trend", name: "趋势官" },
      { order: 1, key: "research", name: "情报员" },
    ],
  );
  assert.equal(rows.length, 10);
  assert.deepEqual(
    rows.map((row) => row.stationIdx),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.equal(rows[0].statusMeta.label, "已完成");
  assert.equal(rows[1].failureText, "检索通道超时");
  assert.equal(rows[2].status, "missing");
  assert.equal(rows[2].statusMeta.label, "状态未返回");
  assert.notEqual(rows[2].statusMeta.label, "待执行");
});

test("真实检索来源门禁失败显示可执行人话，未知错误保留脱敏原文", () => {
  const contractFailure = pipelineFailureText({
    code: "CONTENT_PRODUCTION_OUTPUT_CONTRACT_FAILED",
    message:
      "run_research输出未通过岗位JSON契约：联网证据归因：字段“sources[0]”不是本次已验证检索快照的子集。",
  });
  assert.match(contractFailure, /真实检索\/来源门禁已拦截/u);
  assert.match(contractFailure, /可重试当前工位/u);
  assert.match(contractFailure, /不会把补造或无法核验的来源当作业务结果/u);
  assert.doesNotMatch(contractFailure, /JSON契约/u);

  const missingEvidence = pipelineFailureText({
    code: "CONTENT_PRODUCTION_WEB_EVIDENCE_MISSING",
    message: "web evidence missing",
  });
  assert.match(missingEvidence, /没有取得可验证的联网证据/u);
  assert.match(missingEvidence, /不会把伪造来源当作业务结果/u);

  assert.equal(
    pipelineFailureText({
      code: "UNKNOWN",
      message: "Bearer secret-token-value 调用失败",
    }),
    "[REDACTED] 调用失败",
  );
});

test("pipeline status labels keep unknown backend states visible instead of mapping them to success", () => {
  assert.equal(contentPipelineStatusMeta("running").label, "运行中");
  assert.equal(contentPipelineStatusMeta("awaiting_approval").label, "待审阅");
  assert.equal(
    contentPipelineStatusMeta("awaiting_metrics").label,
    "等待发布指标",
  );
  assert.equal(
    contentPipelineStatusMeta("awaiting_media_authorization").label,
    "等待老板授权付费配图",
  );
  assert.equal(
    contentPipelineStatusMeta("billing_pending").label,
    "待账务确认",
  );
  assert.equal(contentPipelineStatusMeta("skipped").label, "已跳过");
  assert.equal(
    contentPipelineStatusMeta("provider_paused").label,
    "provider_paused",
  );
  assert.equal(contentPipelineStatusMeta("").label, "状态未返回");
});

test("queued receipt is strict and progress requires an authoritative status, version, or attempt change", () => {
  assert.equal(contentPipelineQueuedReceipt({ queued: true }), true);
  assert.equal(contentPipelineQueuedReceipt({ data: { queued: true } }), true);
  assert.equal(contentPipelineQueuedReceipt({ queued: "true" }), false);
  assert.equal(
    contentPipelineQueuedReceipt({ pipeline: { status: "running" } }),
    false,
  );

  const failed = {
    id: 49,
    status: "failed",
    version: 7,
    updatedAt: "2026-08-01T01:00:00.000Z",
    stations: [
      { stationIdx: 0, attempt: 1 },
      { stationIdx: 1, attempt: 2 },
    ],
  };
  const baseline = contentPipelineProgressSnapshot(failed);
  assert.deepEqual(baseline, {
    pipelineId: 49,
    status: "failed",
    version: "7",
    attempts: "0:1|1:2",
  });
  assert.equal(contentPipelineHasAdvanced(baseline, { ...failed }), false);
  assert.equal(
    contentPipelineHasAdvanced(baseline, { ...failed, status: "running" }),
    true,
  );
  assert.equal(
    contentPipelineHasAdvanced(baseline, { ...failed, version: 8 }),
    true,
  );
  assert.equal(
    contentPipelineHasAdvanced(baseline, {
      ...failed,
      stations: [
        { stationIdx: 0, attempt: 1 },
        { stationIdx: 1, attempt: 3 },
      ],
    }),
    true,
  );
  assert.equal(
    contentPipelineHasAdvanced(baseline, { ...failed, id: 50, version: 8 }),
    false,
  );
});

test("publication metrics UI projects multi-platform progress and remains compatible with one-platform history", () => {
  assert.deepEqual(
    contentPipelinePublicationMetricsProgress({
      task: { platforms: ["小红书", "视频号"] },
      workflow: {
        publicationMetrics: {
          entries: [{ publication: { platform: "小红书" } }],
          submittedPlatforms: ["小红书"],
        },
      },
    }),
    {
      requiredPlatforms: ["小红书", "视频号"],
      submittedPlatforms: ["小红书"],
      missingPlatforms: ["视频号"],
      complete: false,
      verificationStatus: "manual_unverified",
    },
  );

  assert.deepEqual(
    contentPipelinePublicationMetricsProgress({
      task: { platforms: ["公众号"] },
      workflow: {
        publicationMetrics: { publication: { platform: "公众号" } },
      },
    }),
    {
      requiredPlatforms: ["公众号"],
      submittedPlatforms: ["公众号"],
      missingPlatforms: [],
      complete: true,
      verificationStatus: "manual_unverified",
    },
  );
});

test("datetime-local default preserves the local wall clock instead of slicing a UTC ISO value", () => {
  const source = new Date(2026, 7, 2, 9, 7, 42, 321);
  const localValue = contentPipelineLocalDateTimeValue(source);
  assert.equal(localValue, "2026-08-02T09:07");
  assert.equal(
    new Date(localValue).getTime(),
    new Date(2026, 7, 2, 9, 7).getTime(),
  );
  assert.equal(contentPipelineLocalDateTimeValue("not-a-date"), "");
});

test("pick stations expose only persisted candidates and approval roles follow the locked boundary", () => {
  const station = {
    stationIdx: 0,
    status: "awaiting_approval",
    output: { topics: [{ title: "候选A" }, { title: "候选B" }] },
  };
  assert.deepEqual(
    pipelineCandidates(station).map((item) => item.candidateIndex),
    [0, 1],
  );
  assert.equal(contentPipelineCanReview("manager", "pick"), true);
  assert.equal(contentPipelineCanReview("sales", "pick"), false);
  assert.equal(contentPipelineCanReview("manager", "force"), false);
  assert.equal(contentPipelineCanReview("boss", "force"), true);
  assert.equal(contentPipelineCanReview("platform_super", "force"), true);
});

test("approval policy presets are exact and only privileged creators can configure them", () => {
  assert.deepEqual(
    CONTENT_PIPELINE_APPROVAL_PRESETS.map((item) => item.value),
    ["internal_auto", "efficient", "key", "custom"],
  );
  assert.deepEqual(contentPipelinePresetStations("efficient"), [8]);
  assert.deepEqual(contentPipelinePresetStations("key"), [0, 3, 5, 6, 8]);
  assert.deepEqual(contentPipelinePresetStations("internal_auto"), []);
  assert.equal(
    contentPipelineWorkflowModeForPreset("internal_auto"),
    "fullauto",
  );
  assert.equal(contentPipelineWorkflowModeForPreset("efficient"), "autopilot");
  assert.equal(contentPipelineWorkflowModeForPreset("key"), "copilot");
  assert.equal(contentPipelineWorkflowModeForPreset("custom"), "copilot");
  assert.deepEqual(
    contentPipelinePresetStations("custom", [9, 3, 3, -1, 10, 0]),
    [0, 3, 9],
  );
  for (const role of ["boss", "admin", "platform_super"]) {
    assert.equal(contentPipelineCanConfigureApproval(role), true);
  }
  for (const role of ["ops_director", "manager", "sales", "employee", ""]) {
    assert.equal(contentPipelineCanConfigureApproval(role), false);
  }
});

test("runtime package evidence is an allowlisted projection of persisted station evidence", () => {
  const evidence = contentPipelineRuntimePackageEvidence({
    handlerId: "configured-handler-must-not-be-treated-as-executed",
    contextSnapshot: {
      runtimePackageLoad: {
        profileVersion: "canonical-content-000-a1b2c3",
        capabilityCount: 5,
        requiredSkillCount: 1,
        historicalSkillCount: 7,
        apiBindingCount: 2,
        toolBindingCount: 3,
        connectorBindingCount: 4,
      },
      promptTemplate: "不得被投影",
    },
    handlerEvidence: {
      handlerId: "content.trend.production-handler",
      runtimePackageLoad: {
        aggregateFingerprint: "sha256:employee-package",
        allRequiredFieldsLoaded: true,
        sourcePromptFingerprint: "sha256:source-prompt",
      },
      providerDelivery: {
        model: "yunwu-real-model",
      },
      prompt: {
        template: "不得被投影",
      },
      apiKey: "sk-this-must-never-be-projected",
    },
  });

  assert.deepEqual(evidence, {
    profileVersion: "canonical-content-000-a1b2c3",
    aggregateFingerprint: "sha256:employee-package",
    allRequiredFieldsLoaded: true,
    capabilityCount: 5,
    requiredSkillCount: 1,
    historicalSkillCount: 7,
    apiBindingCount: 2,
    toolBindingCount: 3,
    connectorBindingCount: 4,
    handlerId: "content.trend.production-handler",
    model: "yunwu-real-model",
    sourcePromptFingerprint: "sha256:source-prompt",
  });
  assert.deepEqual(Object.keys(evidence), [
    "profileVersion",
    "aggregateFingerprint",
    "allRequiredFieldsLoaded",
    "capabilityCount",
    "requiredSkillCount",
    "historicalSkillCount",
    "apiBindingCount",
    "toolBindingCount",
    "connectorBindingCount",
    "handlerId",
    "model",
    "sourcePromptFingerprint",
  ]);
});

test("runtime package evidence never guesses missing fields and is hidden from non-privileged roles", () => {
  const missing = contentPipelineRuntimePackageEvidence({
    handlerId: "configured-only",
    contextSnapshot: { runtimePackageLoad: { capabilityCount: "5" } },
  });
  assert.ok(Object.values(missing).every((value) => value === null));

  for (const role of ["boss", "admin", "platform_super"]) {
    assert.equal(contentPipelineCanViewRuntimePackageEvidence(role), true);
  }
  for (const role of ["ops_director", "manager", "sales", "employee", ""]) {
    assert.equal(contentPipelineCanViewRuntimePackageEvidence(role), false);
  }
});

test("pipeline detail reports only the actual persisted review stations", () => {
  assert.deepEqual(
    contentPipelineActualReviewStations({
      workflow: {
        mode: "fullauto",
        approvalPolicy: { mode: "custom", reviewStations: [8, 0, 8, 5] },
      },
    }),
    [0, 5, 8],
  );
  assert.deepEqual(
    contentPipelineActualReviewStations({
      workflow: {
        mode: "manual",
        approvalPolicy: { mode: "custom", reviewStations: [] },
      },
    }),
    [],
  );
  assert.equal(
    contentPipelineActualReviewStations({ workflow: { mode: "manual" } }),
    null,
  );
});

test("ContentFactory pipeline UI calls every lifecycle endpoint and never exposes external publish", () => {
  const factory = read("web/src/pages/ContentFactory.tsx");
  const workbench = read("web/src/components/ContentPipelineWorkbench.tsx");
  assert.match(factory, /<ContentPipelineWorkbench/u);
  assert.match(factory, /完整团队流水线/u);
  assert.match(workbench, /api\.post\('\/content\/pipelines'/u);
  assert.match(workbench, /api\.get\('\/content\/pipelines'/u);
  assert.match(workbench, /`\/content\/pipelines\/\$\{pipelineId\}`/u);
  assert.match(workbench, /`\/content\/pipelines\/\$\{pipelineId\}\/review`/u);
  assert.match(workbench, /`\/content\/pipelines\/\$\{pipelineId\}\/metrics`/u);
  assert.match(workbench, /action: 'approve'/u);
  assert.match(workbench, /action: 'reject'/u);
  assert.match(
    workbench,
    /`\/content\/pipelines\/\$\{pipelineId\}\/\$\{action\}`/u,
  );
  for (const action of ["retry", "recover", "resume"]) {
    assert.match(workbench, new RegExp(`runLifecycleAction\\('${action}'\\)`));
  }
  assert.match(workbench, /const approvalPolicy =/u);
  assert.match(workbench, /approvalPolicy,/u);
  assert.match(workbench, /mode: 'custom'/u);
  assert.match(workbench, /configuredByRole: role/u);
  assert.match(workbench, /实际停审工位/u);
  assert.match(workbench, /仅内部流转，不会自动对外发布/u);
  assert.doesNotMatch(workbench, /external[_-]?publish|\/发布/u);
});

test("老板创建流水线可明确勾选付费媒体上限，未勾选则工位5等待授权后再恢复", () => {
  const workbench = read("web/src/components/ContentPipelineWorkbench.tsx");
  const types = read("web/src/api/contentPipelineTypes.ts");
  assert.match(types, /paidMediaAuthorized: boolean/u);
  assert.match(types, /paidMediaAuthorization\?:/u);
  assert.match(workbench, /name="paidMediaAuthorized"/u);
  assert.match(workbench, /付费媒体授权/u);
  assert.match(workbench, /最大费用上限/u);
  assert.match(workbench, /正文配图最多/u);
  assert.match(workbench, /封面最多/u);
  assert.match(
    workbench,
    /\/content\/pipelines\/paid-media-estimate\?imageCount=/u,
  );
  assert.match(
    workbench,
    /`\/content\/pipelines\/\$\{pipelineId\}\/paid-media-authorization`/u,
  );
  assert.match(workbench, /authorized: true/u);
  assert.match(
    workbench,
    /activePipeline\.status === 'awaiting_media_authorization'/u,
  );
  assert.match(workbench, /工位5等待老板授权/u);
  assert.match(workbench, /const canReauthorizeFailedMedia =/u);
  assert.match(
    workbench,
    /\[5, 6\]\.includes\(Number\(failedStation\?\.stationIdx\)\)/u,
  );
  assert.match(workbench, /重新授权配图\+封面上限/u);
  assert.match(workbench, /已授权素材[\s\S]{0,80}GPT Image 2/u);
});

test("station9等待指标时UI只提供真实数据回传，不提供普通审批绕过", () => {
  const workbench = read("web/src/components/ContentPipelineWorkbench.tsx");
  const types = read("web/src/api/contentPipelineTypes.ts");
  assert.match(workbench, /activePipeline\.status === 'awaiting_metrics'/u);
  assert.match(workbench, /回传真实发布数据/u);
  assert.match(workbench, /至少填写一项平台返回的真实数值指标/u);
  assert.match(workbench, /没有数据就先不生成复盘/u);
  assert.match(workbench, /已提交平台/u);
  assert.match(workbench, /缺失平台/u);
  assert.match(workbench, /人工录入 · 未经平台自动核验/u);
  assert.match(workbench, /contentPipelineLocalDateTimeValue\(new Date\(\)\)/u);
  assert.match(workbench, /按本机时区/u);
  assert.match(workbench, /待真实指标 · 当前不是最终复盘/u);
  assert.match(
    workbench,
    /publishedAt: new Date\(values\.publishedAt\)\.toISOString\(\)/u,
  );
  assert.doesNotMatch(workbench, /toISOString\(\)\.slice\(0, 16\)/u);
  assert.match(types, /'awaiting_metrics'/u);
});

test("内容仓右侧待审队列可发现流水线并深链聚焦对应任务", () => {
  const factory = read("web/src/pages/ContentFactory.tsx");
  assert.match(
    factory,
    /api\s*\.get\('\/content\/pipelines\/pending-reviews'\)/u,
  );
  assert.match(factory, /pipelinePendingReviews\.map\(review =>/u);
  assert.match(factory, /data-pipeline-review-id=\{review\.pipelineId\}/u);
  assert.match(
    factory,
    /流水线 #\{review\.pipelineId\} · 工位\{review\.stationIdx\}·\{review\.stationName\}/u,
  );
  assert.match(factory, /创建人：\{review\.creator\?\.name/u);
  assert.match(factory, /边界：/u);
  assert.match(factory, /review\.canReview \? '可审阅' : '只可查看'/u);
  assert.match(factory, /initialPipelineId=\{pipelineFocusId\}/u);
  assert.match(factory, /searchParams\.get\('pipelineId'\)/u);
});

test("pipeline UI exposes saved station artifact preview/download without injecting HTML", () => {
  const workbench = read("web/src/components/ContentPipelineWorkbench.tsx");
  const types = read("web/src/api/contentPipelineTypes.ts");
  assert.match(types, /export type ContentPipelineArtifact/u);
  assert.match(types, /finalUsable: boolean/u);
  assert.match(types, /previewUrl: string/u);
  assert.match(types, /downloadUrl: string/u);
  assert.match(workbench, /查看主产物/u);
  assert.match(workbench, /下载/u);
  assert.match(workbench, /已保存 · 待对账，不可业务采用/u);
  assert.match(workbench, /initialPipelineId\?: number \| null/u);
  assert.doesNotMatch(workbench, /dangerouslySetInnerHTML/u);
  assert.doesNotMatch(workbench, /srcDoc=/u);
});

test("pipeline UI renders provider image assets for media station and publish package", () => {
  const workbench = read("web/src/components/ContentPipelineWorkbench.tsx");
  const types = read("web/src/api/contentPipelineTypes.ts");
  const styles = read("web/src/components/ContentPipelineWorkbench.css");
  assert.match(types, /export type ContentPipelineProviderAsset/u);
  assert.match(types, /providerAssets\?: ContentPipelineProviderAsset\[\]/u);
  assert.match(workbench, /providerAssets\.map\(asset =>/u);
  assert.match(workbench, /真实图片产物/u);
  assert.match(workbench, /可点开查看原图或直接下载/u);
  assert.match(workbench, /已投影到发布包/u);
  assert.match(workbench, /asset\.previewUrl/u);
  assert.match(workbench, /asset\.downloadUrl/u);
  assert.match(workbench, /alt=\{asset\.filename/u);
  assert.match(styles, /\.cpw-provider-assets/u);
  assert.match(styles, /object-fit:\s*contain/u);
  assert.doesNotMatch(workbench, /dangerouslySetInnerHTML/u);
});

test("queued retry, resume and approval use a separate local receipt until authoritative progress changes", () => {
  const workbench = read("web/src/components/ContentPipelineWorkbench.tsx");

  assert.match(workbench, /const QUEUED_POLL_INTERVAL_MS = 2_000/u);
  assert.match(workbench, /const QUEUED_POLL_TIMEOUT_MS = 60_000/u);
  assert.match(workbench, /type QueuedTransition = \{/u);
  assert.match(workbench, /phase: 'polling' \| 'timed_out'/u);
  assert.match(
    workbench,
    /if \(contentPipelineQueuedReceipt\(payload\)\) \{\s*beginQueuedTransition\(pipelineId, action, pipeline \|\| beforeAction\);/u,
  );
  assert.match(
    workbench,
    /request\.action === 'approve' && contentPipelineQueuedReceipt\(payload\)[\s\S]*beginQueuedTransition\(pipelineId, 'approve', pipeline \|\| beforeAction\)/u,
  );
  assert.match(
    workbench,
    /contentPipelineHasAdvanced\(transition\.baseline, pipeline\)/u,
  );
  assert.match(
    workbench,
    /window\.setInterval\(\(\) => void poll\(\), QUEUED_POLL_INTERVAL_MS\)/u,
  );
  assert.match(workbench, /服务端在 60 秒内未返回新版本、新尝试次数或新状态/u);
  assert.match(workbench, /等待权威进度已超时/u);
  assert.match(
    workbench,
    /onClick=\{\(\) => void refreshQueuedTransition\(\)\}/u,
  );
  assert.match(workbench, /不会把旧失败快照当成新结果/u);
  assert.match(workbench, /!queuedForActive && activePipeline\.failure/u);
  assert.match(workbench, /!queuedForActive && station\.failureText/u);
});

test("失败工位只在红色Alert展示详细原因，重试入口遵守工位服务端边界", () => {
  const workbench = read("web/src/components/ContentPipelineWorkbench.tsx");

  assert.match(workbench, /if \(station\.status === 'failed'\) return '';/u);
  assert.match(workbench, /function stationManualRetryAllowed/u);
  assert.match(
    workbench,
    /const canRetryFailedStation =[\s\S]{0,260}activePipeline\?\.status === 'failed'[\s\S]{0,120}stationManualRetryAllowed\(failedStation\)/u,
  );
  assert.match(workbench, /\{canRetryFailedStation && \(/u);
  assert.match(
    workbench,
    /const canRetryStation =[\s\S]{0,240}station\.status === 'failed'[\s\S]{0,120}manualRetryAllowed/u,
  );
  assert.match(workbench, /description=\{stationRetryHint \|\| undefined\}/u);
  assert.match(
    workbench,
    /canRetryStation \? \([\s\S]{0,500}onClick=\{\(\) => void runLifecycleAction\('retry'\)\}[\s\S]{0,120}重试本工位/u,
  );
  assert.match(workbench, /当前账号没有失败工位重试权限/u);
  assert.match(workbench, /可手动重试·不限次数/u);
  assert.match(workbench, /station\.retry\?\.remaining == null/u);
  assert.match(workbench, /剩余 \$\{Math\.floor\(remaining\)\} 次/u);
});

test("内容流水线只把真实位图素材计入图片交付", () => {
  const workbench = read("web/src/components/ContentPipelineWorkbench.tsx");

  assert.match(workbench, /function isDeliverableBitmapProviderAsset/u);
  assert.match(
    workbench,
    /NON_BITMAP_ASSET[^\n]+image\\\/svg[^\n]+占位[^\n]+示意图/u,
  );
  assert.match(
    workbench,
    /station\.providerAssets\.filter\(isDeliverableBitmapProviderAsset\)/u,
  );
  assert.match(
    workbench,
    /if \(!isDeliverableBitmapProviderAsset\(asset\)\) continue;/u,
  );
  assert.match(workbench, /SVG、HTML 卡片和占位图不会展示或计入交付/u);
});

test("mix默认优先已授权真实素材并由GPT Image 2补齐，real仍严格阻断", () => {
  const workbench = read("web/src/components/ContentPipelineWorkbench.tsx");

  assert.match(
    workbench,
    /value: 'real', label: '仅已授权真实素材（不足即停）'/u,
  );
  assert.match(
    workbench,
    /value: 'mix', label: '已授权真实素材优先，不足由 GPT Image 2 补齐'/u,
  );
  assert.match(
    workbench,
    /IMAGE_MODE_OPTIONS\.map\(option =>[\s\S]{0,120}option\.value !== 'real'[\s\S]{0,180}disabled: !realMaterialProviderAvailable/u,
  );
  assert.match(workbench, /String\(values\.imageMode \|\| ''\) === 'real'/u);
  assert.doesNotMatch(
    workbench,
    /\['real', 'mix'\]\.includes\(String\(values\.imageMode/u,
  );
  assert.match(workbench, /imageMode: 'mix'/u);
  assert.match(
    workbench,
    /fallback\?\.strategy === 'licensed_material_to_ai_image'/u,
  );
  assert.match(workbench, /已授权真实素材不足，剩余配图已由 GPT Image 2 补齐/u);
});

test("可交付图片按授权素材和AI生成分开标注，不把位图冒充实拍", () => {
  const workbench = read("web/src/components/ContentPipelineWorkbench.tsx");

  assert.match(workbench, /function isLicensedMaterialAsset/u);
  assert.match(workbench, /asset\.rights\?\.confirmed === true/u);
  assert.match(workbench, /asset\.rights\?\.commercialUse === true/u);
  assert.match(workbench, /已授权真实素材/u);
  assert.match(workbench, /asset\.kind === 'image'/u);
  assert.match(workbench, /AI 生成 · \$\{model\}/u);
  assert.match(workbench, /providerAssetSourceMeta\(asset\)/u);
  assert.match(workbench, /张可交付图片/u);
  assert.doesNotMatch(workbench, /张真图|封面真图|可交付真图|实拍/u);
});

test("老板自定义审批UI锁定角色、中文岗位、内部流转与真实素材能力边界", () => {
  const workbench = read("web/src/components/ContentPipelineWorkbench.tsx");
  const types = read("web/src/api/contentPipelineTypes.ts");

  assert.match(workbench, /contentPipelineCanConfigureApproval\(role\)/u);
  assert.match(workbench, /老板 \/ 管理员 \/ 平台超管可配置/u);
  assert.match(workbench, /const canViewApprovalPolicy = canManage/u);
  assert.match(workbench, /\{canViewApprovalPolicy && \(/u);
  for (const name of [
    "趋势官",
    "情报员",
    "拆解师",
    "撰稿人",
    "文风师",
    "多媒体师",
    "封面师",
    "演绎师",
    "分发官",
    "复盘官",
  ]) {
    assert.match(workbench, new RegExp(name, "u"));
  }

  assert.match(workbench, /const approvalPolicy =/u);
  assert.match(workbench, /approvalPolicy,/u);
  assert.match(workbench, /mode: 'custom'/u);
  assert.match(workbench, /reviewStations,/u);
  assert.match(workbench, /configuredByRole: role/u);
  assert.match(workbench, /仅内部流转，不会自动对外发布/u);

  assert.match(workbench, /realMaterialProviderAvailable/u);
  assert.match(workbench, /disabled: !realMaterialProviderAvailable/u);
  assert.match(workbench, /isProviderCapability/u);
  assert.match(workbench, /REAL_MATERIAL_PROVIDER_UNAVAILABLE/u);
  assert.match(workbench, /values\.imageMode/u);
  assert.match(types, /verified\?: boolean/u);
  assert.match(types, /status\?: string/u);
});

test("流水线工位运行包证据仅向老板级角色展示且不暴露提示词正文或凭据", () => {
  const workbench = read("web/src/components/ContentPipelineWorkbench.tsx");
  const presentation = read(
    "web/src/components/contentPipelinePresentation.js",
  );
  const types = read("web/src/api/contentPipelineTypes.ts");
  const css = read("web/src/components/ContentPipelineWorkbench.css");

  assert.match(
    workbench,
    /contentPipelineCanViewRuntimePackageEvidence\(role\)/u,
  );
  assert.match(workbench, /\{canViewRuntimePackageEvidence && \(/u);
  assert.match(workbench, /完整员工运行包已装载/u);
  assert.match(workbench, /11 字段完整装载/u);
  for (const label of [
    "岗位档案版本",
    "统一包总指纹",
    "完整能力",
    "出厂必备技能",
    "历史技能",
    "API 绑定",
    "Tool 绑定",
    "Connector 绑定",
    "实际 Handler",
    "实际模型",
    "源提示词指纹",
  ]) {
    assert.match(workbench, new RegExp(label, "u"));
  }
  assert.match(workbench, /证据未返回/u);
  assert.match(workbench, /不展示提示词正文、API Key、Token\s*或配置正文/u);
  assert.match(
    presentation,
    /\['boss', 'admin', 'platform_super'\]\.includes\(text\(role\)\)/u,
  );
  assert.match(presentation, /firstEvidenceCount/u);
  assert.match(types, /ContentPipelineRuntimePackageLoadEvidence/u);
  assert.match(types, /handlerEvidence\?: ContentPipelineHandlerEvidence/u);
  assert.match(types, /contextSnapshot\?: ContentPipelineContextSnapshot/u);
  assert.match(css, /\.cpw-runtime-evidence/u);
});

test("内容团队公开入口是一句话对话，内部默认自动接力并以安全Markdown报告交付", () => {
  const workbench = read("web/src/components/ContentPipelineWorkbench.tsx");
  const styles = read("web/src/components/ContentPipelineWorkbench.css");

  assert.match(workbench, /给完整内容团队发消息/u);
  assert.match(workbench, /你只需发一句话/u);
  assert.match(workbench, /className="cpw-composer-settings"/u);
  assert.match(workbench, /更多要求 \/ 后台设置/u);
  assert.match(
    workbench,
    /contentPipelineWorkflowModeForPreset\(values.approvalPreset\)/u,
  );
  assert.match(workbench, /workflowMode: 'fullauto'/u);
  assert.match(workbench, /approvalPreset: 'internal_auto'/u);
  assert.match(workbench, /\{ mode: 'internal_auto' as const \}/u);
  assert.match(
    workbench,
    /<Markdown content=\{pipelineTaskMarkdown\(activePipeline\)\} \/>/u,
  );
  assert.match(workbench, /<ContentEmployeeResult/u);
  assert.match(workbench, /kicker="排版成稿"/u);
  assert.match(workbench, /<ArtifactActions/u);
  assert.match(workbench, /sourceType="content_pipeline"/u);
  assert.match(workbench, /<details className="cpw-phase-events"/u);
  assert.match(workbench, /点击展开或收起/u);
  assert.match(workbench, /visiblePhaseEvents\.map\(event =>/u);
  assert.match(workbench, /className="cpw-station-fold"/u);
  assert.match(workbench, /给老板看的结果/u);
  assert.match(workbench, /过程与费用/u);
  assert.match(workbench, /CONTENT_PRODUCTION_WEB_NOT_REQUIRED/u);
  assert.match(workbench, /联网已回传/u);
  assert.match(styles, /\.cpw-boss-brief/u);
  assert.match(styles, /\.cpw-station-fold/u);
  assert.match(workbench, /cpw-assistant-report[\s\S]*cpw-artifact/u);
  assert.doesNotMatch(workbench, /<pre>\{safeOutput\(/u);
  assert.doesNotMatch(
    workbench,
    /<pre>[\s\S]*JSON\.stringify\(station\.output/u,
  );
  assert.match(styles, /\.cpw-message-row/u);
  assert.match(styles, /\.cpw-chat-composer/u);
  assert.match(styles, /\.cpw-assistant-report/u);
  assert.match(styles, /\.cpw-phase-events > summary/u);
});

test("老板可切换简洁/标准/专业三档视图，简洁档只保留交付物与高清图", () => {
  const workbench = read("web/src/components/ContentPipelineWorkbench.tsx");
  const styles = read("web/src/components/ContentPipelineWorkbench.css");

  assert.match(workbench, /'simple' \| 'standard' \| 'pro'/u);
  assert.match(workbench, /nw-content-pipeline-view-mode/u);
  for (const label of ["简洁", "标准", "专业"]) {
    assert.match(workbench, new RegExp(label, "u"));
  }
  assert.match(workbench, /<Segmented/u);
  assert.match(workbench, /高清配图与封面/u);
  assert.match(workbench, /cpw-boss-gallery/u);
  assert.match(workbench, /cpw-boss-packs/u);
  assert.match(workbench, /复制文案/u);
  // 简洁档隐藏过程：工位列表只保留需要老板处理的状态。
  assert.match(
    workbench,
    /viewMode === 'simple'[\s\S]{0,120}STATION_ATTENTION_STATUSES\.has/u,
  );
  // 过程与费用和内部主产物只在专业档展示；真实图片在标准档也必须直接可见。
  assert.match(
    workbench,
    /viewMode === 'pro' &&\s*\n?\s*\(visiblePhaseEvents/u,
  );
  assert.match(workbench, /viewMode === 'pro' && primaryArtifact/u);
  assert.match(workbench, /\{providerAssets\.length > 0 && \(/u);
  assert.doesNotMatch(workbench, /viewMode === 'pro' && providerAssets\.length > 0/u);
  assert.match(workbench, /BOSS_OPEN_STATIONS = new Set\(\[4, 5, 6, 8, 9\]\)/u);
  assert.match(styles, /\.cpw-view-switch/u);
  assert.match(styles, /\.cpw-boss-gallery-grid/u);
  assert.match(styles, /\.cpw-boss-packs/u);
});

test("internal_auto运行页不误写人工审阅，产物标签按权威availability显示", () => {
  const workbench = read("web/src/components/ContentPipelineWorkbench.tsx");
  const route = read("server/src/routes/content-production-pipeline.js");

  assert.match(
    workbench,
    /const isInternalAuto = activePipeline\?\.workflow\?\.approvalPolicy\?\.mode === 'internal_auto'/u,
  );
  assert.match(workbench, /isInternalAuto[\s\S]{0,220}当前任务不设停审工位/u);
  assert.doesNotMatch(workbench, /进度与审阅状态/u);
  assert.doesNotMatch(workbench, /待审阅工位必须由有权限的人明确处理/u);

  for (const [availability, label] of [
    ["awaiting_approval", "等待停站确认"],
    ["awaiting_metrics", "待真实指标"],
    ["billing_pending", "待对账"],
    ["remote_reference", "远程引用"],
    ["failed", "生成失败"],
    ["cancelled", "已取消"],
  ]) {
    assert.match(
      workbench,
      new RegExp(`${availability}:[^\\n]+${label}`, "u"),
      `${availability} 必须有独立中文标签`,
    );
  }
  assert.match(workbench, /已完成 · 可预览下载/u);
  assert.doesNotMatch(workbench, /已保存 · 待审阅|>可用于业务</u);
  assert.match(route, /内部自动接力、未设置停审工位/u);
  assert.doesNotMatch(route, /逐岗产物落库、人工审批/u);
});
