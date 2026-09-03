import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const panel = fs.readFileSync(
  path.join(root, "web/src/components/ContentPipelineSchedulesPanel.tsx"),
  "utf8",
);
const workbench = fs.readFileSync(
  path.join(root, "web/src/components/ContentPipelineWorkbench.tsx"),
  "utf8",
);

test("内容流水线工作台提供计划CRUD、立即运行与三种北京时间频率", () => {
  for (const endpoint of ["/content/pipeline-schedules", "/run-now"]) {
    assert.match(panel, new RegExp(endpoint.replaceAll("/", "\\/")));
  }
  for (const kind of ["daily", "weekly", "interval"]) {
    assert.match(panel, new RegExp(`value: '${kind}'`));
  }
  assert.match(panel, /buildPaihuoContentBrief\(values\)/u);
  assert.match(panel, /paidMediaAuthorized/u);
  assert.match(panel, /approvalPreset: 'internal_auto'/u);
  assert.match(panel, /contentPipelineWorkflowModeForPreset\(values.approvalPreset\)/u);
  assert.match(panel, /workflowMode: 'fullauto'/u);
  assert.match(panel, /\{ mode: 'internal_auto' as const \}/u);
  assert.match(panel, /onOpenPipeline\(pipelineId\)/u);
  assert.match(panel, /余额不足会暂停计划且不会创建 API 任务/u);
  assert.match(workbench, /<ContentPipelineSchedulesPanel/u);
  assert.match(workbench, /定时运行完整团队/u);
});

test("定时流水线默认素材优先，仅严格real模式受素材通道门禁", () => {
  assert.match(panel, /imageMode: \(task\.image_mode \|\| 'mix'\)/u);
  assert.match(panel, /imageMode: 'mix'/u);
  assert.match(panel, /仅已授权真实素材（不足即停）/u);
  assert.match(panel, /已授权真实素材优先，不足由 GPT Image 2 补齐/u);
  assert.match(panel, /String\(values\.imageMode\) === 'real'/u);
  assert.doesNotMatch(panel, /\['real', 'mix'\]\.includes\(String\(values\.imageMode\)\)/u);
  assert.doesNotMatch(panel, /value: 'mix'[\s\S]{0,180}disabled: !realMaterialProviderAvailable/u);
  assert.match(panel, /素材优先模式仍可选，未取得授权素材时由 GPT Image 2 生成/u);
});

test("定时计划卡片显示中文策略与权威状态，不暴露原始状态码", () => {
  assert.match(panel, /function scheduleApprovalMeta\(schedule/u);
  assert.match(panel, /全自动 · 不停审/u);
  assert.match(panel, /工作方式：\{scheduleWorkflowLabel\(schedule\)\}/u);
  assert.match(panel, /\{approvalMeta\.label\}/u);
  assert.match(panel, /\{lastStatus\.label\}/u);

  for (const [status, label] of [
    ["pipeline_created", "已创建流水线"],
    ["running", "运行中"],
    ["awaiting_approval", "等待停站确认"],
    ["awaiting_media_authorization", "等待付费素材授权"],
    ["awaiting_metrics", "等待真实发布指标"],
    ["billing_pending", "待账务确认"],
    ["completed", "已完成"],
    ["deferred", "已顺延"],
    ["failed", "开工失败"],
  ]) {
    assert.match(
      panel,
      new RegExp(`${status}:[^\\n]+${label}`, "u"),
      `${status} 必须映射为中文状态`,
    );
  }

  assert.doesNotMatch(
    panel,
    /<Tag color="purple">\{String\(schedule\.workflow\?\.mode/u,
  );
  assert.doesNotMatch(panel, /<dd>\{schedule\.lastStatus/u);
});
