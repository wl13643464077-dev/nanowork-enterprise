import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { q, curTenant, modulesFor } from "../db.js";
import { userScopeClause } from "./access.js";
import { generationProgressFromSnapshot } from "./employee-generation-progress.js";
import {
  BUSINESS_DELIVERY_LABELS,
  loadAgentTaskSupersession,
} from "./delivery-state.js";
import { augmentMediaJob } from "../routes/media-review.js";

export const TASK_CENTER_KINDS = Object.freeze([
  "manual",
  "restaurant",
  "content",
  "content_pipeline",
  "skill_learning",
  "advisor",
  "avatar",
  "text_video",
  "wechat",
  "media",
  "automation",
  "tool",
]);
const KINDS = new Set(TASK_CENTER_KINDS);

const TASK_CENTER_PUBLIC_ERRORS = Object.freeze({
  INVALID_TASK_KIND: Object.freeze({
    status: 400,
    error: "不支持的任务来源，请从 allowedKinds 中选择",
    code: "INVALID_TASK_KIND",
  }),
  INVALID_TASK_ID: Object.freeze({
    status: 400,
    error: "任务编号不正确，必须是大于 0 的整数",
    code: "INVALID_TASK_ID",
  }),
  TASK_NOT_ACCESSIBLE: Object.freeze({
    status: 404,
    error: "任务不存在或无权查看",
    code: "TASK_NOT_ACCESSIBLE",
  }),
});
const SOURCE_SCAN_LIMIT = 501;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASK_CENTER_ARTIFACT_DIR = process.env.NANOWORK_ARTIFACT_DIR
  ? path.resolve(process.env.NANOWORK_ARTIFACT_DIR)
  : path.join(__dirname, "..", "..", "data", "uploads", "artifacts");

const WORKFLOWS = {
  manual: ["等待开始", "执行任务", "人工验收", "交付完成"],
  restaurant: ["任务受理", "员工生成", "账务确认", "结果采用", "交付完成"],
  content: ["任务受理", "内容生成", "账务确认", "结果采用", "交付完成"],
  content_pipeline: [
    "趋势",
    "情报",
    "拆解",
    "撰稿",
    "文风",
    "多媒体",
    "封面",
    "演绎",
    "分发",
    "复盘",
    "完成",
  ],
  skill_learning: [
    "任务受理",
    "隔离 WebSearch",
    "受控 WebFetch",
    "技能生成与入库",
    "完成",
  ],
  advisor: [
    "会诊提问",
    "公开检索与知识召回",
    "参谋生成",
    "账务确认",
    "结果回流",
  ],
  avatar: [
    "任务受理",
    "素材校验",
    "上传 RunningHub",
    "工作流合成",
    "成片回收",
    "账务确认",
    "交付完成",
  ],
  text_video: [
    "任务受理",
    "口播整理",
    "逐句真实TTS",
    "字幕与画面合成",
    "MP4编码校验",
    "租户文件落库",
    "账务确认",
    "交付完成",
  ],
  wechat: [
    "任务受理",
    "正文图上传",
    "封面素材上传",
    "提交微信草稿箱",
    "Marker 对账",
    "账务结算",
    "草稿完成",
  ],
  media: ["任务受理", "媒体生成", "账务确认", "交付完成"],
  automation: ["规则触发", "自动执行", "账务确认", "结果采用", "交付完成"],
  tool: [
    "任务受理",
    "公开检索",
    "受控取证",
    "工具生成",
    "账务确认",
    "交付完成",
  ],
};

function tableExists(name) {
  return Boolean(
    q.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name),
  );
}

function tableHasColumn(name, column) {
  if (!/^[a-z0-9_]+$/iu.test(name) || !/^[a-z0-9_]+$/iu.test(column)) {
    return false;
  }
  return q
    .all(`PRAGMA table_info(${name})`)
    .some((item) => String(item.name) === column);
}

function parseObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function restaurantResearchEvidence(snapshot) {
  const parsed = parseObject(snapshot);
  const web =
    parsed.kind === "restaurant_employee_execution_evidence"
      ? parseObject(parsed.web)
      : Object.keys(parseObject(parsed.web)).length
        ? parseObject(parsed.web)
        : parsed;
  const plan = parseObject(web.skillResearchPlan);
  const quality = parseObject(web.sourceQuality);
  if (!Array.isArray(plan.lanes) && !Object.keys(quality).length) return null;
  return {
    skillResearchPlan: Array.isArray(plan.lanes)
      ? {
          schemaVersion: cleanText(plan.schemaVersion, 100),
          employeeIdx: Number(plan.employeeIdx || 0) || null,
          mode: cleanText(plan.mode, 80),
          skillCount: Number(plan.skillCount || 0),
          lanes: plan.lanes.slice(0, 10).map((lane) => ({
            key: cleanText(lane?.key, 80),
            label: cleanText(lane?.label, 100),
            sourceSkillTitles: Array.isArray(lane?.sourceSkillTitles)
              ? lane.sourceSkillTitles
                  .slice(0, 4)
                  .map((title) => cleanText(title, 80))
              : [],
          })),
        }
      : null,
    sourceQuality: Object.keys(quality).length
      ? {
          passed: quality.passed === true,
          locationAnchorCount: Number(quality.locationAnchorCount || 0),
          directRestaurantSourceCount: Number(
            quality.directRestaurantSourceCount || 0,
          ),
          directRestaurantControlledCount: Number(
            quality.directRestaurantControlledCount || 0,
          ),
          directRestaurantStructuredCount: Number(
            quality.directRestaurantStructuredCount || 0,
          ),
          acceptedCount: Number(quality.acceptedCount || 0),
          rejectedCount: Number(quality.rejectedCount || 0),
        }
      : null,
  };
}

function learningProgressSnapshot(value) {
  let rows = [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) rows = parsed;
  } catch {
    /* corrupted progress is ignored in the public projection */
  }
  const latest = rows.at(-1) || {};
  const phaseIndex =
    {
      research: 2,
      webfetch: 3,
      generate: 4,
      persist: 4,
      done: 5,
      failed: 4,
    }[latest.phase] || 1;
  return {
    stepIndex: phaseIndex,
    stepTotal: 5,
    stepLabel: cleanText(latest.message, 80) || null,
  };
}

function toolProgressSnapshot(value) {
  let rows = [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) rows = parsed;
  } catch {
    /* corrupted progress is ignored in the public projection */
  }
  const latest = rows.length ? rows[rows.length - 1] : {};
  const phaseIndex =
    {
      queued: 1,
      websearch: 2,
      controlled_web_fetch: 3,
      provider: 4,
      provider_retry: 4,
      completed: 6,
      quality_failed: 5,
      failed: 5,
    }[latest.phase] || 1;
  return {
    stepIndex: phaseIndex,
    stepTotal: 6,
    stepLabel: cleanText(latest.message, 80) || null,
  };
}

function wechatProgressSnapshot(row) {
  const attempt = parseObject(row?.provider_attempt_json);
  const index =
    {
      processing: attempt.phase === "uploading" ? 2 : 1,
      submitting: attempt.markerChecked === true ? 5 : 4,
      submitted: 6,
      done: 7,
      blocked: 4,
      failed: attempt.phase === "draft_add" ? 4 : 2,
    }[row?.status] || 1;
  const label = {
    processing:
      attempt.phase === "uploading"
        ? "正在上传租户内素材"
        : "正在校验已结算内容",
    submitting:
      attempt.markerChecked === true
        ? "提交结果不确定，只读对账中"
        : "正在提交微信草稿箱",
    submitted: "草稿已送达，正在结算",
    done: "草稿已进入微信后台",
    blocked: "投递已阻断",
    failed: "投递未交付",
  }[row?.status];
  return { stepIndex: index, stepTotal: 7, stepLabel: label };
}

function avatarProgressSnapshot(value) {
  let rows = [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) rows = parsed;
  } catch {
    /* corrupted progress is ignored in the public projection */
  }
  const latest = rows.at(-1) || {};
  const phaseIndex =
    {
      queued: 1,
      validate_assets: 2,
      prepare_audio: 2,
      upload_image: 3,
      upload_audio: 3,
      create: 4,
      queue_wait: 4,
      accepted: 4,
      polling: 4,
      download: 5,
      persist: 5,
      settle: 6,
      done: 7,
    }[latest.phase] || 1;
  return {
    stepIndex: phaseIndex,
    stepTotal: 7,
    stepLabel: cleanText(latest.message, 80) || null,
  };
}

function textVideoProgressSnapshot(value) {
  let rows = [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) rows = parsed;
  } catch {
    /* corrupted progress is ignored in the public projection */
  }
  const latest = rows.at(-1) || {};
  const phaseIndex =
    {
      queued: 1,
      script: 2,
      tts: 3,
      compose: 4,
      finalize: 5,
      persist: 6,
      settle: 7,
      done: 8,
    }[latest.phase] || 1;
  return {
    stepIndex: phaseIndex,
    stepTotal: 8,
    stepLabel: cleanText(latest.message, 80) || null,
  };
}

function cleanText(value, max = 120) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function taskDeepLink(kind, id) {
  return `/tasks?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(String(id))}`;
}

function replacementRestaurantDeepLink(supersededBy) {
  const employeeIdx = Number(supersededBy?.employeeIdx);
  const taskId = Number(supersededBy?.taskId);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) return null;
  return Number.isSafeInteger(employeeIdx) && employeeIdx >= 0
    ? `/employees?employee=${encodeURIComponent(String(employeeIdx))}&task=${encodeURIComponent(String(taskId))}`
    : taskDeepLink("restaurant", taskId);
}

function supersededRestaurantProjection(supersededBy) {
  const replacementDeepLink = replacementRestaurantDeepLink(supersededBy);
  return {
    status: "已取代",
    displayStatus: BUSINESS_DELIVERY_LABELS.superseded,
    state: "superseded",
    deliveryState: "DELIVERY_SUPERSEDED",
    presentationKey: "superseded",
    currentStep: BUSINESS_DELIVERY_LABELS.superseded,
    progress: 100,
    executionProgress: null,
    businessUsable: false,
    reviewReady: false,
    hasOutput: false,
    supersededBy,
    replacementDeepLink,
    ...(replacementDeepLink ? { deepLink: replacementDeepLink } : {}),
  };
}

function employeeConversationDeepLink(kind, row, id) {
  if (kind === "content_pipeline") {
    return `/content?pipelineId=${encodeURIComponent(String(id))}`;
  }
  const employeeIdx = Number(row?.employee_idx);
  if (!Number.isSafeInteger(employeeIdx) || employeeIdx < 0) return null;
  if (kind === "restaurant") {
    return `/employees?employee=${encodeURIComponent(String(employeeIdx))}&task=${encodeURIComponent(String(id))}`;
  }
  if (kind === "content") {
    return `/content?employee=${encodeURIComponent(String(employeeIdx))}&runId=${encodeURIComponent(String(id))}`;
  }
  return null;
}

const REPORT_FIELD_LABELS = Object.freeze({
  report: "交付报告",
  title: "标题",
  summary: "摘要",
  conclusion: "结论",
  conclusions: "结论",
  recommendation: "建议",
  recommendations: "建议",
  action: "行动建议",
  actions: "行动建议",
  findings: "关键发现",
  insights: "洞察",
  evidence: "依据",
  sources: "来源",
  content: "正文",
  body: "正文",
  text: "正文",
  result: "结果",
  deliverables: "交付物",
  work_product: "工作成果",
  sections: "报告章节",
  items: "明细",
  metrics: "指标",
  risks: "风险",
  next_steps: "下一步",
});

function reportFieldLabel(value) {
  const key = String(value || "");
  return (
    REPORT_FIELD_LABELS[key] ||
    key
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase())
  );
}

function scalarReportText(value) {
  if (value == null || value === "") return "";
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value).trim();
}

function structuredReportMarkdown(value, depth = 2) {
  if (value == null) return "";
  if (!Array.isArray(value) && typeof value !== "object") {
    return scalarReportText(value);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item, index) => {
        if (item != null && typeof item === "object") {
          const nested = structuredReportMarkdown(item, Math.min(5, depth + 1));
          return nested ? `#### 明细 ${index + 1}\n\n${nested}` : "";
        }
        const text = scalarReportText(item);
        return text ? `- ${text}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return Object.entries(value)
    .slice(0, 100)
    .map(([key, item]) => {
      if (item == null || item === "") return "";
      const label = reportFieldLabel(key);
      if (Array.isArray(item) || typeof item === "object") {
        const nested = structuredReportMarkdown(item, Math.min(5, depth + 1));
        return nested
          ? `${"#".repeat(Math.min(5, depth))} ${label}\n\n${nested}`
          : "";
      }
      const text = scalarReportText(item);
      return text ? `**${label}：** ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function readableReportMarkdown(value, title) {
  const text = String(value || "").trim();
  if (!text) return "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const preferred = [
    parsed?.markdown,
    parsed?.result_md,
    parsed?.report,
    parsed?.body,
    parsed?.content,
    parsed?.text,
  ].find((candidate) => typeof candidate === "string" && candidate.trim());
  if (preferred) {
    const report = String(preferred).trim();
    return /^#\s/u.test(report) ? report : `# ${title}\n\n${report}`;
  }
  const report = structuredReportMarkdown(parsed);
  return report ? `# ${title}\n\n${report}`.slice(0, 120_000) : "";
}

function sourceArtifactFileReady(artifact) {
  const tenantDir = path.resolve(TASK_CENTER_ARTIFACT_DIR, String(curTenant()));
  const fileName = String(artifact?.file_name || "");
  if (!fileName || fileName !== path.basename(fileName)) return false;
  const resolved = path.resolve(tenantDir, fileName);
  if (!resolved.startsWith(`${tenantDir}${path.sep}`)) return false;
  try {
    const stat = fs.lstatSync(resolved);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function sourceDeliverables(user, sourceType, sourceId, sourceBody) {
  if (!tableExists("generated_artifacts")) return [];
  if (
    sourceType === "agent_task" &&
    loadAgentTaskSupersession(sourceId, { tenantId: curTenant() })
  )
    return [];
  const body = String(sourceBody || "").trim();
  if (!body) return [];
  const sourceHash = createHash("sha256").update(body).digest("hex");
  const scope = userScopeClause(user, "a.user_id");
  return q
    .all(
      `SELECT a.id,a.title,a.format,a.file_name,a.status,a.metadata,a.created_at,a.updated_at
      FROM generated_artifacts a
      WHERE a.tenant_id=? AND a.source_type=? AND a.source_id=?${scope.sql}
      ORDER BY a.id DESC LIMIT 20`,
      curTenant(),
      sourceType,
      Number(sourceId),
      ...scope.params,
    )
    .filter((artifact) => {
      const metadata = parseObject(artifact.metadata);
      return (
        metadata.sourceHash === sourceHash && sourceArtifactFileReady(artifact)
      );
    })
    .map((artifact) => {
      const format = cleanText(artifact.format, 20).toLowerCase();
      return {
        id: Number(artifact.id),
        title: cleanText(artifact.title, 120),
        format,
        label:
          { pdf: "PDF", docx: "Word", xlsx: "Excel", pptx: "PPT" }[format] ||
          format.toUpperCase(),
        fileName: cleanText(artifact.file_name, 200),
        status: cleanText(artifact.status, 40) || "可用",
        downloadAvailable: true,
        downloadUrl: `/api/files/artifacts/${Number(artifact.id)}/download`,
        createdAt: artifact.created_at,
        updatedAt: artifact.updated_at,
      };
    });
}

const CONTENT_ADOPTION_KINDS = new Set(["restaurant", "content", "automation"]);

function isApprovalWorkflowSnapshot(value) {
  const route = parseObject(value);
  return Boolean(
    route.policyMode ||
    route.targetType ||
    typeof route.requiresReview === "boolean" ||
    typeof route.autoAdopt === "boolean" ||
    Array.isArray(route.steps),
  );
}

function isApprovalRoutingPolicy(value) {
  const policy = parseObject(value);
  return Boolean(
    Object.keys(parseObject(policy.employeeOutput)).length ||
    typeof policy.employeeOutput === "string",
  );
}

function firstRoutingCandidate(candidates, predicate) {
  for (const [source, candidate] of candidates) {
    const parsed = parseObject(candidate);
    if (Object.keys(parsed).length && predicate(parsed)) {
      return { value: parsed, source };
    }
  }
  return { value: {}, source: "missing" };
}

function approvalRoutingEvidence(
  approvalSnapshot,
  snapshot,
  approvalWorkflowSnapshot = null,
) {
  const direct = parseObject(approvalSnapshot);
  const source = parseObject(snapshot);
  const workflow = firstRoutingCandidate(
    [
      ["approval_record", approvalWorkflowSnapshot],
      ["execution_snapshot", source.approvalRouting],
      ["execution_snapshot", source.approvalRoute],
      ["execution_snapshot", source.approvalRoutingSnapshot],
      ["execution_snapshot", source.approval_routing_policy_snapshot],
      ["approval_snapshot", direct],
    ],
    isApprovalWorkflowSnapshot,
  );
  const policy = firstRoutingCandidate(
    [
      ["locked_policy", direct],
      ["execution_snapshot", source.approvalRoutingPolicy],
      ["execution_snapshot", source.approval_routing_policy_snapshot],
    ],
    isApprovalRoutingPolicy,
  );
  const employeeOutput = parseObject(policy.value.employeeOutput);
  const policyMode = cleanText(
    employeeOutput.mode ||
      (typeof policy.value.employeeOutput === "string"
        ? policy.value.employeeOutput
        : ""),
    40,
  );
  const workflowMode = cleanText(
    workflow.value.policyMode || workflow.value.mode,
    40,
  );
  // The locked tenant policy and the route resolved for this one run answer
  // different questions.  Keep the policy authoritative for policyContext;
  // adoptionContext consumes the resolved workflow below.  Falling back to
  // the workflow is only for historical rows that predate locked policies.
  const mode = policyMode || workflowMode;
  const schema = cleanText(
    policy.value.schemaVersion ||
      workflow.value.policySchemaVersion ||
      workflow.value.schemaVersion,
    100,
  );
  const workflowSteps = Array.isArray(workflow.value.steps)
    ? workflow.value.steps
    : [];
  const workflowRequiresReview =
    typeof workflow.value.requiresReview === "boolean"
      ? workflow.value.requiresReview
      : workflowSteps.length
        ? true
        : workflowMode === "auto"
          ? false
          : ["manager", "boss"].includes(workflowMode)
            ? true
            : null;
  const policyRequiresReview =
    policyMode === "auto"
      ? false
      : ["manager", "boss"].includes(policyMode)
        ? true
        : null;
  return {
    workflow: workflow.value,
    workflowSource: workflow.source,
    policy: policy.value,
    policySource: policy.source,
    mode: mode || null,
    policyMode: policyMode || null,
    workflowMode: workflowMode || null,
    schema: schema || null,
    requiresReview:
      policy.source !== "missing"
        ? policyRequiresReview
        : workflowRequiresReview,
    workflowRequiresReview,
  };
}

function policyContextFor(kind, status, routing) {
  if (!["restaurant", "content", "automation"].includes(kind)) {
    return {
      kind: "none",
      historical: false,
      mode: null,
      requiresReview: null,
      decisionKind: null,
      source: "not_applicable",
      label: "当前任务不使用内容采用策略",
    };
  }
  const route = routing.workflow;
  const schema = String(routing.schema || "");
  const mode = String(routing.mode || "");
  const requiresReview = routing.requiresReview;
  const decisionKind =
    routing.policySource === "missing"
      ? cleanText(route.decisionKind, 60) || null
      : null;
  const policySource =
    routing.policySource !== "missing"
      ? routing.policySource
      : routing.workflowSource;
  const legacy =
    schema === "nanowork.approval-routing-policy/1" ||
    mode === "employee_setting" ||
    (routing.policySource === "missing" &&
      route.safeguards?.highRiskOwnerReview === true &&
      !route.decisionKind);
  if (legacy) {
    return {
      kind: "historical_policy",
      historical: true,
      mode: mode || null,
      requiresReview,
      decisionKind,
      source: policySource,
      label:
        rawState(status) === "review"
          ? "历史记录 · 旧策略待处理"
          : "历史记录 · 沿用旧岗位采用策略",
    };
  }
  if (mode === "auto") {
    return {
      kind: "auto_policy",
      historical: false,
      mode,
      requiresReview,
      decisionKind,
      source: policySource,
      label: "当前策略 · 普通内部结果通过质量与账务门后自动采用",
    };
  }
  if (mode === "risk_based") {
    return {
      kind: "risk_based_policy",
      historical: false,
      mode,
      requiresReview,
      decisionKind,
      source: policySource,
      label: "当前策略 · 按风险分流（本次结果以锁定路由为准）",
    };
  }
  if (["manager", "boss"].includes(mode) || requiresReview === true) {
    const label =
      mode === "boss"
        ? "当前显式策略 · 老板人工确认"
        : mode === "manager"
          ? "当前显式策略 · 负责人人工确认"
          : "当前显式策略 · 结果人工确认";
    return {
      kind: "explicit_policy",
      historical: false,
      mode: mode || null,
      requiresReview,
      decisionKind,
      source: policySource,
      label,
    };
  }
  // A historical row may only retain the resolved authorization route.  It
  // is still useful context, but must not override a locked employeeOutput
  // policy when that policy exists.
  if (
    route.executionAuthorizationRequired === true ||
    decisionKind === "execution_authorization"
  ) {
    return {
      kind: "explicit_policy",
      historical: false,
      mode: mode || null,
      requiresReview,
      decisionKind,
      source: routing.workflowSource,
      label: "当前策略 · 外发、付费或不可逆动作执行授权",
    };
  }
  if (rawState(status) === "review") {
    return {
      kind: "historical_policy",
      historical: true,
      mode: null,
      requiresReview: null,
      decisionKind: null,
      source: "missing",
      label: "历史记录 · 未保存当前策略快照",
    };
  }
  return {
    kind: "unknown_policy",
    historical: false,
    mode: mode || null,
    requiresReview,
    decisionKind,
    source: policySource,
    label: "当前记录未保存可核验的采用策略快照",
  };
}

function adoptionContextFor(kind, status, snapshot, routing, evidence = {}) {
  if (!CONTENT_ADOPTION_KINDS.has(kind)) {
    return {
      kind: "not_applicable",
      adopted: false,
      terminal: false,
      source: "not_applicable",
      label: "当前任务不使用内容采用结果",
    };
  }
  const source = parseObject(snapshot);
  const review = parseObject(source.review);
  const decision = cleanText(review.decision, 40).toLowerCase();
  const approvalStatus = cleanText(evidence.approvalStatus, 40);
  const contentStatus = cleanText(evidence.contentStatus, 40);
  const workflow = routing.workflow;
  const decisionKind = cleanText(workflow.decisionKind, 60);
  const raw = rawState(status);

  if (
    decision === "reject" ||
    approvalStatus === "已驳回" ||
    contentStatus === "已驳回" ||
    raw === "rework"
  ) {
    return {
      kind: "rejected",
      adopted: false,
      terminal: true,
      source:
        decision === "reject"
          ? "run_decision"
          : approvalStatus === "已驳回"
            ? "approval_record"
            : contentStatus === "已驳回"
              ? "content_record"
              : "task_state",
      decisionKind: decision || decisionKind || null,
      label: "失败需返工（人工审阅未通过）",
    };
  }
  if (decision === "adopt" || approvalStatus === "已通过") {
    return {
      kind: "human",
      adopted: true,
      terminal: true,
      source: decision === "adopt" ? "run_decision" : "approval_record",
      decisionKind: decision || decisionKind || "human_approval",
      label: "已人工采纳（可用于业务）",
    };
  }
  if (decision === "auto_adopt") {
    return {
      kind: "automatic",
      adopted: true,
      terminal: true,
      source: "run_decision",
      decisionKind: decision,
      label: "已自动采用（可用于业务）",
    };
  }
  if (
    !["failed", "rework", "blocked"].includes(raw) &&
    (approvalStatus === "待审核" ||
      contentStatus === "待审核" ||
      raw === "review" ||
      (routing.workflowSource !== "missing" &&
        routing.workflowRequiresReview === true))
  ) {
    const executionAuthorization =
      workflow.executionAuthorizationRequired === true ||
      decisionKind === "execution_authorization";
    return {
      kind: executionAuthorization
        ? "execution_authorization_pending"
        : "pending_review",
      adopted: false,
      terminal: false,
      source:
        approvalStatus === "待审核"
          ? "approval_record"
          : contentStatus === "待审核"
            ? "content_record"
            : routing.workflowSource,
      decisionKind: decisionKind || null,
      label: executionAuthorization ? "待老板执行授权" : "待人工审阅",
    };
  }
  if (raw === "done") {
    if (
      ["review_self_authorized", "execution_self_authorized"].includes(
        decisionKind,
      )
    ) {
      return {
        kind: "human",
        adopted: true,
        terminal: true,
        source: routing.workflowSource,
        decisionKind,
        label: "已由授权人确认并采纳（可用于业务）",
      };
    }
    const workflowAutoAdopted =
      workflow.autoAdopt === true &&
      routing.workflowRequiresReview !== true &&
      !["execution_authorization", "content_review"].includes(decisionKind);
    const lockedAutoPolicy =
      routing.mode === "auto" &&
      routing.workflowSource === "missing" &&
      approvalStatus !== "已通过";
    if (workflowAutoAdopted || lockedAutoPolicy) {
      return {
        kind: "automatic",
        adopted: true,
        terminal: true,
        source: workflowAutoAdopted
          ? routing.workflowSource
          : routing.policySource,
        decisionKind: decisionKind || (lockedAutoPolicy ? "auto_policy" : null),
        label: "已自动采用（可用于业务）",
      };
    }
    return {
      kind: "unknown",
      adopted: false,
      terminal: true,
      source: "insufficient_evidence",
      decisionKind: decisionKind || null,
      label: "已完成（采用方式待核验）",
    };
  }
  return {
    kind: "not_adopted",
    adopted: false,
    terminal: false,
    source: "task_state",
    decisionKind: decisionKind || null,
    label: "尚未形成可采用结果",
  };
}

function stateWithAdoption(state, adoptionContext) {
  if (state === "blocked") return state;
  if (
    ["pending_review", "execution_authorization_pending"].includes(
      adoptionContext.kind,
    )
  ) {
    return "review";
  }
  if (adoptionContext.kind === "rejected") return "rework";
  return state;
}

function displayStatusFor(status, state, adoptionContext) {
  if (state === "blocked") return "业务暂不可采用（待账务对账）";
  if (
    adoptionContext.kind !== "not_applicable" &&
    adoptionContext.kind !== "not_adopted"
  ) {
    return adoptionContext.label;
  }
  if (state === "failed") return "失败需处理（执行异常）";
  if (state === "rework") return "失败需返工（人工审阅未通过）";
  if (state === "review") return "待人工审阅";
  return cleanText(status, 80) || "状态待确认";
}

function elapsed(start, end) {
  const started = Date.parse(String(start || "").replace(" ", "T"));
  const finished = Date.parse(String(end || "").replace(" ", "T"));
  if (!Number.isFinite(started)) return null;
  return Math.max(
    0,
    (Number.isFinite(finished) ? finished : Date.now()) - started,
  );
}

function loadBillingContext() {
  if (!tableExists("credit_holds"))
    return { available: false, hasLogs: false, byRef: new Map() };
  const hasLogs = tableExists("credit_logs");
  const rows = q.all(
    `SELECT h.id,h.log_id,h.status,h.held_credits,h.settled_credits,h.ref_type,h.ref_id,
      ${hasLogs ? "l.id ledger_id,l.credits ledger_credits,l.cost_yuan" : "NULL ledger_id,NULL ledger_credits,NULL cost_yuan"}
    FROM credit_holds h
    ${hasLogs ? "LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id" : ""}
    WHERE h.tenant_id=? AND NOT EXISTS (
      SELECT 1 FROM credit_holds newer
      WHERE newer.tenant_id=h.tenant_id AND newer.ref_type=h.ref_type
        AND newer.ref_id=h.ref_id AND newer.id>h.id
    ) ORDER BY h.id DESC`,
    curTenant(),
  );
  const byRef = new Map();
  for (const row of rows) {
    const key = `${row.ref_type}:${row.ref_id}`;
    if (!byRef.has(key)) byRef.set(key, row);
  }
  return { available: true, hasLogs, byRef };
}

function billingFor(refType, refId, { billable = true, context = null } = {}) {
  if (!billable)
    return {
      state: "not_required",
      credits: 0,
      costYuan: 0,
      label: "无需计费",
      authoritative: true,
      ledger: { source: "not_applicable", holdId: null, logId: null },
    };
  const available = context ? context.available : tableExists("credit_holds");
  if (!available)
    return {
      state: "unavailable",
      credits: null,
      costYuan: null,
      label: "账务表未初始化",
      authoritative: false,
      ledger: { source: "credit_holds_unavailable", holdId: null, logId: null },
    };
  const hasLogs = context ? context.hasLogs : tableExists("credit_logs");
  const hold = context?.byRef
    ? context.byRef.get(`${refType}:${refId}`)
    : q.get(
        `SELECT h.id,h.log_id,h.status,h.held_credits,h.settled_credits,
      ${hasLogs ? "l.id ledger_id,l.credits ledger_credits,l.cost_yuan" : "NULL ledger_id,NULL ledger_credits,NULL cost_yuan"}
    FROM credit_holds h
    ${hasLogs ? "LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id" : ""}
    WHERE h.tenant_id=? AND h.ref_type=? AND h.ref_id=? ORDER BY h.id DESC LIMIT 1`,
        curTenant(),
        refType,
        refId,
      );
  if (!hold)
    return {
      state: "missing",
      credits: null,
      costYuan: null,
      label: "未发现账务记录",
      authoritative: false,
      ledger: { source: "credit_holds", holdId: null, logId: null },
    };
  const heldCredits = Number(hold.held_credits);
  const settledCredits =
    hold.settled_credits == null ? null : Number(hold.settled_credits);
  const ledgerCredits =
    hold.ledger_credits == null ? null : Number(hold.ledger_credits);
  const base = {
    costYuan: hold.cost_yuan == null ? null : Number(hold.cost_yuan),
    ledger: {
      source: "credit_holds+credit_logs",
      holdId: Number(hold.id),
      logId: Number(hold.log_id) || null,
      status: hold.status,
      heldCredits,
      settledCredits,
      ledgerCredits,
    },
  };
  if (hold.status === "held")
    return {
      ...base,
      state: "held",
      credits: Number.isFinite(heldCredits) ? heldCredits : null,
      label: `已预授权 ${Number.isFinite(heldCredits) ? heldCredits : "—"} 积分`,
      authoritative: true,
    };
  const ledgerLinked =
    Number(hold.ledger_id) > 0 &&
    Number(hold.ledger_id) === Number(hold.log_id);
  if (
    hold.status === "settled" &&
    settledCredits === 0 &&
    ledgerLinked &&
    ledgerCredits === 0
  )
    return {
      ...base,
      state: "released",
      credits: 0,
      label: "预授权已退回",
      authoritative: true,
    };
  if (
    hold.status === "settled" &&
    settledCredits != null &&
    settledCredits > 0 &&
    ledgerLinked &&
    ledgerCredits === settledCredits
  )
    return {
      ...base,
      state: "settled",
      credits: settledCredits,
      label: `已结算 ${settledCredits} 积分`,
      authoritative: true,
    };
  return {
    ...base,
    state: "pending_reconciliation",
    credits:
      settledCredits ?? (Number.isFinite(heldCredits) ? heldCredits : null),
    label: "待账务对账",
    authoritative: false,
  };
}

function avatarBilling(row, context = null) {
  if (row.billing_status === "included") {
    return {
      state: "not_required",
      credits: 0,
      costYuan: Number(parseObject(row.cost_json)?.amount || 0),
      label: "免费重试已包含，不重复扣费",
      authoritative: true,
      ledger: {
        source: "avatar_free_retry",
        holdId: null,
        logId: null,
      },
    };
  }
  const base = billingFor("avatar_job", row.id, { context });
  if (row.billing_status !== "pending_reconciliation") return base;
  return {
    ...base,
    state: "pending_reconciliation",
    label: "数字人工单待账务对账",
    authoritative: false,
  };
}

function textVideoBilling(row, context = null) {
  if (row.billing_status === "included") {
    return {
      state: "not_required",
      credits: 0,
      costYuan: Number(parseObject(row.cost_json)?.amount || 0),
      label: "免费重试已包含，不重复扣费",
      authoritative: true,
      ledger: {
        source: "text_video_free_retry",
        holdId: null,
        logId: null,
      },
    };
  }
  const base = billingFor("text_video_job", row.id, { context });
  if (row.billing_status !== "pending_reconciliation") return base;
  return {
    ...base,
    state: "pending_reconciliation",
    label: "成片任务待账务对账",
    authoritative: false,
  };
}

function rawState(status) {
  const value = String(status || "").toLowerCase();
  if (
    /pending_reconciliation|billing_pending|待账务对账|待对账|blocked|阻断|暂不可/.test(
      value,
    )
  )
    return "blocked";
  if (/rework|返工|已驳回/.test(value)) return "rework";
  if (/paused|已暂停/.test(value)) return "pending";
  if (/待执行|pending|queued|排队|未开始/.test(value)) return "pending";
  if (
    /awaiting_approval|awaiting_metrics|awaiting_media_authorization|待审阅|待审核|待验收|review/.test(
      value,
    )
  )
    return "review";
  if (/失败|failed|error|中断|cancelled|canceled|已取消/.test(value))
    return "failed";
  if (/已完成|成功|done|completed|settled/.test(value)) return "done";
  return "running";
}

function projectedState(status, billing) {
  const raw = rawState(status);
  if (["failed", "pending", "rework"].includes(raw)) return raw;
  if (
    ["unavailable", "missing", "pending_reconciliation"].includes(
      billing.state,
    ) &&
    ["review", "done"].includes(raw)
  )
    return "blocked";
  if (billing.state === "held" && raw === "done") return "blocked";
  return raw;
}

function billingForStatus(billing, status) {
  if (rawState(status) !== "failed" || billing.state !== "held") return billing;
  return {
    ...billing,
    authoritative: false,
    label: `失败任务待退款或对账 · 仍占用 ${billing.credits ?? "—"} 积分`,
  };
}

function snapshotStep(snapshot, total) {
  const source = parseObject(snapshot);
  const candidates = [
    source.progress,
    source.workflow,
    source.execution,
    source,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const rawIndex = Number(candidate.stepIndex ?? candidate.currentStep);
    const rawTotal = Number(candidate.stepTotal ?? candidate.totalSteps);
    if (Number.isSafeInteger(rawIndex) && rawIndex >= 0) {
      const candidateTotal =
        Number.isSafeInteger(rawTotal) && rawTotal > 0 ? rawTotal : total;
      const oneBased = rawIndex === 0 ? 1 : rawIndex;
      return {
        index: Math.min(candidateTotal, Math.max(1, oneBased)),
        total: candidateTotal,
        label:
          cleanText(
            candidate.stepLabel ??
              candidate.currentStepLabel ??
              candidate.label,
            60,
          ) || null,
      };
    }
  }
  return null;
}

function workflowStep(kind, status, state, billing, snapshot) {
  const steps = WORKFLOWS[kind] || WORKFLOWS.manual;
  const stored = snapshotStep(snapshot, steps.length);
  let index;
  if (state === "pending") index = 1;
  else if (state === "done") index = steps.length;
  else if (state === "review") index = Math.max(2, steps.length - 1);
  else if (
    state === "blocked" &&
    ["held", "unavailable", "missing", "pending_reconciliation"].includes(
      billing.state,
    )
  )
    index = Math.min(3, steps.length);
  else index = stored?.index || 2;
  let label = stored?.label || steps[index - 1];
  if (state === "rework") label = "按验收意见返工";
  if (state === "failed") label = "执行中断";
  if (
    state === "blocked" &&
    ["held", "unavailable", "missing", "pending_reconciliation"].includes(
      billing.state,
    )
  )
    label = billing.label;
  if (kind === "restaurant") {
    const generation = generationProgressFromSnapshot(snapshot);
    if (generation)
      label =
        generation.currentLabel ||
        (generation.phase === "repair"
          ? `第 ${generation.attemptNumber} 轮质量修复`
          : `第 ${generation.attemptNumber} 轮生成 · 已接收 ${generation.receivedChars} 个响应字符（非质检阈值）`);
  }
  if (kind === "content") {
    const generation = generationProgressFromSnapshot(snapshot);
    if (generation?.currentLabel) label = generation.currentLabel;
  }
  const progress =
    steps.length <= 1
      ? 100
      : Math.round(((index - 1) / (steps.length - 1)) * 100);
  return {
    currentStep: label,
    stepIndex: index,
    stepTotal: steps.length,
    progress,
  };
}

function project(input, billingContext) {
  const businessUsableOverride = input.businessUsableOverride;
  const publicInput = { ...input };
  delete publicInput.businessUsableOverride;
  delete publicInput.approvalWorkflowSnapshot;
  delete publicInput.adoptionEvidence;
  const billing = billingForStatus(
    input.billingOverride ||
      billingFor(input.billingRefType, input.id, {
        billable: input.billable !== false,
        context: billingContext,
      }),
    input.status,
  );
  const baseState = projectedState(input.status, billing);
  const routing = approvalRoutingEvidence(
    input.approvalSnapshot,
    input.snapshot,
    input.approvalWorkflowSnapshot,
  );
  const policyContext = policyContextFor(input.kind, input.status, routing);
  const adoptionContext = adoptionContextFor(
    input.kind,
    input.status,
    input.snapshot,
    routing,
    input.adoptionEvidence,
  );
  const state = stateWithAdoption(baseState, adoptionContext);
  const step = workflowStep(
    input.kind,
    input.status,
    state,
    billing,
    input.snapshot,
  );
  const raw = rawState(input.status);
  const billingReady = ["settled", "not_required"].includes(billing.state);
  const contentAdoptionApplies = CONTENT_ADOPTION_KINDS.has(input.kind);
  const adoptionAllowsBusinessUse =
    !contentAdoptionApplies || adoptionContext.adopted === true;
  return {
    ...publicInput,
    sourceKey: `${input.kind}:${input.id}`,
    deepLink: taskDeepLink(input.kind, input.id),
    policyContext,
    adoptionKind: adoptionContext.kind,
    adoptionContext,
    displayStatus: displayStatusFor(input.status, state, adoptionContext),
    executionProgress: generationProgressFromSnapshot(input.snapshot),
    state,
    ...step,
    elapsedMs:
      ["done", "failed"].includes(state) && !input.finishedAt
        ? null
        : elapsed(input.createdAt, input.finishedAt),
    billing,
    businessUsable:
      typeof businessUsableOverride === "boolean"
        ? businessUsableOverride &&
          raw === "done" &&
          billingReady &&
          adoptionAllowsBusinessUse &&
          input.hasOutput !== false
        : raw === "done" &&
          billingReady &&
          adoptionAllowsBusinessUse &&
          input.hasOutput !== false,
    reviewReady:
      state === "review" &&
      !policyContext.historical &&
      billingReady &&
      input.hasOutput !== false,
  };
}

const PIPELINE_EMPLOYEES = Object.freeze([
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
]);

function pipelineBilling(pipelineId) {
  if (!tableExists("credit_holds"))
    return billingFor("content_production_pipeline_station", -1);
  const hasLogs = tableExists("credit_logs");
  const tenantId = curTenant();
  const start = Number(pipelineId) * 10 + 1;
  const end = start + 9;
  const stationRows = q
    .all(
      `SELECT h.id,h.log_id,h.status,h.held_credits,h.settled_credits,
      h.ref_type,h.ref_id,
      ${hasLogs ? "l.id ledger_id,l.credits ledger_credits,l.cost_yuan" : "NULL ledger_id,NULL ledger_credits,NULL cost_yuan"}
    FROM credit_holds h
    ${hasLogs ? "LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id" : ""}
    WHERE h.tenant_id=? AND h.ref_type='content_production_pipeline_station'
      AND h.ref_id BETWEEN ? AND ? ORDER BY h.id`,
      tenantId,
      start,
      end,
    )
    .map((row) => ({ ...row, component: "stationText" }));

  const attemptGroups = new Map();
  if (tableExists("content_pipeline_special_provider_attempts")) {
    const joined = q.all(
      `SELECT a.id attempt_row_id,a.attempt_id,a.station_idx,
        a.status attempt_status,a.billing_ref_type,a.billing_ref_id,
        a.hold_id expected_hold_id,
        h.id,h.log_id,h.status,h.held_credits,h.settled_credits,
        h.ref_type,h.ref_id,
        ${hasLogs ? "l.id ledger_id,l.credits ledger_credits,l.cost_yuan" : "NULL ledger_id,NULL ledger_credits,NULL cost_yuan"}
      FROM content_pipeline_special_provider_attempts a
      LEFT JOIN credit_holds h
        ON h.tenant_id=a.tenant_id AND (
          h.id=a.hold_id OR
          (h.ref_type=a.billing_ref_type AND h.ref_id=a.billing_ref_id)
        )
      ${hasLogs ? "LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id" : ""}
      WHERE a.tenant_id=? AND a.pipeline_id=?
      ORDER BY a.id,h.id`,
      tenantId,
      Number(pipelineId),
    );
    for (const row of joined) {
      let group = attemptGroups.get(Number(row.attempt_row_id));
      if (!group) {
        group = {
          id: Number(row.attempt_row_id),
          attemptId: cleanText(row.attempt_id, 180),
          stationIdx: Number(row.station_idx),
          status: String(row.attempt_status || ""),
          refType: String(row.billing_ref_type || ""),
          refId: Number(row.billing_ref_id),
          expectedHoldId:
            row.expected_hold_id == null ? null : Number(row.expected_hold_id),
          holds: [],
        };
        attemptGroups.set(group.id, group);
      }
      if (row.id != null) {
        group.holds.push({
          id: Number(row.id),
          log_id: row.log_id,
          status: row.status,
          held_credits: row.held_credits,
          settled_credits: row.settled_credits,
          ref_type: row.ref_type,
          ref_id: row.ref_id,
          ledger_id: row.ledger_id,
          ledger_credits: row.ledger_credits,
          cost_yuan: row.cost_yuan,
          component: "specialProvider",
          attemptId: group.attemptId,
          stationIdx: group.stationIdx,
        });
      }
    }
  }

  // A provider ref is stable across idempotent retries, so one attempt may
  // legitimately expose older released holds plus its current hold. Count each
  // authoritative ledger row once, but validate attempt state only against the
  // explicit current hold (or the newest ref hold in the pre-hold_id crash
  // window).
  const holdRowsById = new Map(stationRows.map((row) => [Number(row.id), row]));
  const invalidReasons = [];
  const pendingAttemptIds = [];
  for (const attempt of attemptGroups.values()) {
    for (const hold of attempt.holds) {
      if (!holdRowsById.has(hold.id)) holdRowsById.set(hold.id, hold);
      if (
        String(hold.ref_type || "") !== attempt.refType ||
        Number(hold.ref_id) !== attempt.refId
      ) {
        invalidReasons.push(`provider_ref_mismatch:${attempt.id}`);
      }
    }
    const currentHold =
      attempt.expectedHoldId == null
        ? attempt.holds.at(-1) || null
        : attempt.holds.find((hold) => hold.id === attempt.expectedHoldId) ||
          null;
    if (attempt.expectedHoldId != null && !currentHold) {
      invalidReasons.push(`provider_hold_missing:${attempt.id}`);
    }
    if (["persisted", "pending_reconciliation"].includes(attempt.status)) {
      invalidReasons.push(`provider_${attempt.status}:${attempt.id}`);
      pendingAttemptIds.push(attempt.attemptId);
    } else if (attempt.status === "settled") {
      if (!currentHold || currentHold.status !== "settled") {
        invalidReasons.push(`provider_settlement_mismatch:${attempt.id}`);
      }
    } else if (["released", "failed"].includes(attempt.status)) {
      if (
        currentHold &&
        (currentHold.status !== "settled" ||
          Number(currentHold.settled_credits || 0) !== 0)
      ) {
        invalidReasons.push(`provider_terminal_billing_mismatch:${attempt.id}`);
      }
    } else if (attempt.status === "claimed") {
      if (currentHold && currentHold.status !== "held") {
        invalidReasons.push(`provider_claim_billing_mismatch:${attempt.id}`);
      }
    } else {
      invalidReasons.push(`provider_status_invalid:${attempt.id}`);
    }
  }

  const rows = [...holdRowsById.values()];
  for (const row of rows) {
    if (row.status === "held") {
      if (row.settled_credits != null) {
        invalidReasons.push(`held_has_settlement:${row.id}`);
      }
      continue;
    }
    if (
      row.status !== "settled" ||
      row.settled_credits == null ||
      Number(row.ledger_id) !== Number(row.log_id) ||
      Number(row.ledger_credits) !== Number(row.settled_credits)
    ) {
      invalidReasons.push(`hold_ledger_invalid:${row.id}`);
    }
  }

  const held = rows.filter((row) => row.status === "held");
  const settledCredits = rows.reduce(
    (sum, row) => sum + Number(row.settled_credits || 0),
    0,
  );
  const heldCredits = held.reduce(
    (sum, row) => sum + Number(row.held_credits || 0),
    0,
  );
  const costYuan = rows.reduce(
    (sum, row) => sum + Number(row.cost_yuan || 0),
    0,
  );
  const specialProviderHolds = rows.filter(
    (row) => row.component === "specialProvider",
  );
  const ledger = {
    source: "content_pipeline_station+special_provider_holds",
    holdIds: rows.map((row) => Number(row.id)),
    logIds: rows.map((row) => Number(row.log_id)).filter(Boolean),
    stationHoldCount: rows.length - specialProviderHolds.length,
    specialProviderHoldCount: specialProviderHolds.length,
    specialProviderAttemptCount: attemptGroups.size,
    specialProviderAttemptIds: [...attemptGroups.values()]
      .map((attempt) => attempt.attemptId)
      .filter(Boolean),
    pendingAttemptIds: [...new Set(pendingAttemptIds.filter(Boolean))],
    reconciliationReasons: [...new Set(invalidReasons)],
  };
  if (!rows.length && !invalidReasons.length)
    return {
      state: "not_required",
      credits: 0,
      costYuan: 0,
      label: "尚未进入付费工位",
      authoritative: true,
      ledger,
    };
  if (invalidReasons.length)
    return {
      state: "pending_reconciliation",
      credits: settledCredits + heldCredits,
      costYuan,
      label: "流水线文本与专项 Provider 账务待对账",
      authoritative: false,
      ledger,
    };
  if (held.length)
    return {
      state: "held",
      credits: settledCredits + heldCredits,
      costYuan,
      label: `流水线文本与专项 Provider 已结算 ${settledCredits} 积分，仍预授权 ${heldCredits} 积分`,
      authoritative: true,
      ledger,
    };
  return {
    state: "settled",
    credits: settledCredits,
    costYuan,
    label: `流水线文本与专项 Provider 累计结算 ${settledCredits} 积分`,
    authoritative: true,
    ledger,
  };
}

function loadSources(user) {
  const tenant = curTenant();
  const billingContext = loadBillingContext();
  const sourceFlags = [];
  const scoped = (column) => userScopeClause(user, column);
  const withLimit = (rows) => {
    sourceFlags.push(rows.length >= SOURCE_SCAN_LIMIT);
    return rows.slice(0, SOURCE_SCAN_LIMIT - 1);
  };
  const manualScope = scoped("t.assignee_id");
  const manual = withLimit(
    q.all(
      `SELECT t.id,t.title,t.status,t.created_at,t.done_at,t.due_at,
      COALESCE(u.name,'未分配') employee
    FROM tasks t LEFT JOIN users u ON u.tenant_id=t.tenant_id AND u.id=t.assignee_id
    WHERE t.tenant_id=?${manualScope.sql} ORDER BY t.id DESC LIMIT ?`,
      curTenant(),
      ...manualScope.params,
      SOURCE_SCAN_LIMIT,
    ),
  ).map((row) =>
    project(
      {
        id: row.id,
        kind: "manual",
        category: "人工任务",
        title: row.title,
        employee: row.employee,
        status: row.status,
        createdAt: row.created_at,
        finishedAt: row.done_at,
        dueAt: row.due_at,
        billingRefType: "task",
        billable: false,
        hasOutput: row.status === "已完成",
      },
      billingContext,
    ),
  );

  const agentScope = scoped("t.created_by");
  const restaurant = withLimit(
    q.all(
      `SELECT t.id,t.title,t.status,t.created_at,t.due_at,t.output_id,
      t.employee_web_snapshot snapshot,t.approval_routing_policy_snapshot approval_snapshot,
      c.status adoption_content_status,ap.status adoption_approval_status,
      ap.approval_policy_snapshot adoption_workflow_snapshot,
      COALESCE(s.name,m.name,'餐饮数字员工') employee
    FROM agent_tasks t
    LEFT JOIN specialists s ON s.id=t.specialist_id
    LEFT JOIN marshals m ON m.id=t.marshal_id
    LEFT JOIN contents c ON c.tenant_id=t.tenant_id AND c.id=t.output_id
    LEFT JOIN approvals ap ON ap.tenant_id=t.tenant_id AND ap.id=(
      SELECT MAX(a2.id) FROM approvals a2
      WHERE a2.tenant_id=t.tenant_id AND a2.target_type='content' AND a2.target_id=t.output_id
    )
    WHERE t.tenant_id=?${agentScope.sql} ORDER BY t.id DESC LIMIT ?`,
      tenant,
      ...agentScope.params,
      SOURCE_SCAN_LIMIT,
    ),
  ).map((row) => {
    const projected = project(
      {
        id: row.id,
        kind: "restaurant",
        category: "餐饮员工",
        title: row.title,
        employee: row.employee,
        status: row.status,
        createdAt: row.created_at,
        dueAt: row.due_at,
        snapshot: row.snapshot,
        approvalSnapshot: row.approval_snapshot,
        approvalWorkflowSnapshot: row.adoption_workflow_snapshot,
        adoptionEvidence: {
          approvalStatus: row.adoption_approval_status,
          contentStatus: row.adoption_content_status,
        },
        hasOutput: Boolean(row.output_id),
        billingRefType: "agent_task",
      },
      billingContext,
    );
    const supersededBy = loadAgentTaskSupersession(row.id, {
      tenantId: tenant,
    });
    return supersededBy
      ? { ...projected, ...supersededRestaurantProjection(supersededBy) }
      : projected;
  });

  const contentScope = scoped("r.created_by");
  const content = withLimit(
    q.all(
      `SELECT r.id,r.title,r.status,r.employee_name,r.created_at,r.updated_at,r.due_at,
      r.snapshot_json snapshot,CASE WHEN COALESCE(r.result_md,'')<>'' THEN 1 ELSE 0 END has_output
    FROM content_employee_runs r WHERE r.tenant_id=?${contentScope.sql}
    ORDER BY r.id DESC LIMIT ?`,
      tenant,
      ...contentScope.params,
      SOURCE_SCAN_LIMIT,
    ),
  ).map((row) =>
    project(
      {
        id: row.id,
        kind: "content",
        category: "内容员工",
        title: row.title,
        employee: row.employee_name,
        status: row.status,
        createdAt: row.created_at,
        snapshot: row.snapshot,
        finishedAt: ["done", "failed"].includes(rawState(row.status))
          ? row.updated_at
          : null,
        dueAt: row.due_at,
        hasOutput: Boolean(row.has_output),
        billingRefType: "content_employee_run",
      },
      billingContext,
    ),
  );

  const pipelineScope = scoped("p.created_by");
  const pipelines = tableExists("content_production_pipeline_jobs")
    ? withLimit(
        q.all(
          `SELECT p.id,p.title,p.status,p.current_station,p.pending_station,p.created_at,p.updated_at,
        p.failure_json,CASE WHEN EXISTS(
          SELECT 1 FROM content_production_pipeline_artifacts a
          WHERE a.tenant_id=p.tenant_id AND a.pipeline_id=p.id
        ) THEN 1 ELSE 0 END has_output
      FROM content_production_pipeline_jobs p
      WHERE p.tenant_id=?${pipelineScope.sql} ORDER BY p.id DESC LIMIT ?`,
          tenant,
          ...pipelineScope.params,
          SOURCE_SCAN_LIMIT,
        ),
      ).map((row) => {
        const station = Math.min(
          9,
          Math.max(0, Number(row.pending_station ?? row.current_station ?? 0)),
        );
        return project(
          {
            id: row.id,
            kind: "content_pipeline",
            category: "内容团队流水线",
            title: row.title,
            employee: `内容团队 · ${PIPELINE_EMPLOYEES[station]}`,
            status: row.status,
            createdAt: row.created_at,
            finishedAt: [
              "completed",
              "failed",
              "rejected",
              "cancelled",
            ].includes(row.status)
              ? row.updated_at
              : null,
            snapshot: {
              stepIndex: Math.min(10, station + 1),
              stepTotal: 11,
              stepLabel: `${PIPELINE_EMPLOYEES[station]} · 工位${station}`,
            },
            hasOutput: Boolean(row.has_output),
            billingOverride: pipelineBilling(row.id),
          },
          billingContext,
        );
      })
    : [];

  const learningScope = scoped("r.created_by");
  const skillLearning = tableExists("employee_skill_learning_runs")
    ? withLimit(
        q.all(
          `SELECT r.id,r.domain,r.employee_idx,r.employee_name,r.status,r.progress_json,
        r.skills_added,r.result_json,r.error_json,r.created_at,r.updated_at,r.completed_at
      FROM employee_skill_learning_runs r
      WHERE r.tenant_id=?${learningScope.sql} ORDER BY r.id DESC LIMIT ?`,
          tenant,
          ...learningScope.params,
          SOURCE_SCAN_LIMIT,
        ),
      ).map((row) =>
        project(
          {
            id: row.id,
            kind: "skill_learning",
            category: "员工全网进修",
            title: `${row.employee_name}全网进修`,
            employee: row.employee_name,
            status: row.status,
            createdAt: row.created_at,
            finishedAt: row.completed_at,
            snapshot: learningProgressSnapshot(row.progress_json),
            hasOutput: row.status === "completed" && Boolean(row.result_json),
            billingRefType: "employee_skill_learning_run",
          },
          billingContext,
        ),
      )
    : [];

  const advisorScope = scoped("c.user_id");
  const advisor =
    tableExists("ai_conversations") && tableExists("ai_messages")
      ? withLimit(
          q.all(
            `SELECT m.id,m.content,m.created_at,c.id conversation_id,c.title,c.updated_at
          FROM ai_messages m
          JOIN ai_conversations c
            ON c.tenant_id=m.tenant_id AND c.id=m.conversation_id
          WHERE m.tenant_id=? AND m.role='assistant'${advisorScope.sql}
          ORDER BY m.id DESC LIMIT ?`,
            tenant,
            ...advisorScope.params,
            SOURCE_SCAN_LIMIT,
          ),
        ).map((row) =>
          project(
            {
              id: row.id,
              kind: "advisor",
              category: "老板参谋会诊",
              title: cleanText(row.title, 100) || `会诊消息 #${row.id}`,
              employee: "老板参谋",
              status: "done",
              createdAt: row.created_at,
              finishedAt: row.created_at,
              snapshot: {
                stepIndex: 5,
                stepTotal: 5,
                stepLabel: "会诊结果已回流",
                conversationId: Number(row.conversation_id),
              },
              hasOutput: Boolean(cleanText(row.content, 1)),
              billingRefType: "ai_message",
            },
            billingContext,
          ),
        )
      : [];

  const avatarScope = scoped("j.created_by");
  const avatar = tableExists("avatar_jobs")
    ? withLimit(
        q.all(
          `SELECT j.*,
          CASE WHEN j.output_file_id IS NOT NULL
            AND COALESCE(j.result_url,'')<>''
            AND COALESCE(j.result_sha256,'')<>''
            AND EXISTS(
              SELECT 1 FROM uploaded_files f
              WHERE f.tenant_id=j.tenant_id AND f.id=j.output_file_id
                AND f.file_url=j.result_url AND f.size=j.result_bytes
                AND f.purpose='avatar-output'
            ) THEN 1 ELSE 0 END has_output
        FROM avatar_jobs j
        WHERE j.tenant_id=?${avatarScope.sql} ORDER BY j.id DESC LIMIT ?`,
          tenant,
          ...avatarScope.params,
          SOURCE_SCAN_LIMIT,
        ),
      ).map((row) =>
        project(
          {
            id: row.id,
            kind: "avatar",
            category: "数字人摄影棚",
            title: row.title,
            employee: `数字人摄影棚 · ${row.provider_name || row.engine_requested || "auto"}`,
            status: row.status,
            createdAt: row.created_at,
            finishedAt: row.completed_at,
            snapshot: avatarProgressSnapshot(row.steps_json),
            hasOutput: Boolean(row.has_output),
            billingRefType: "avatar_job",
            billingOverride: avatarBilling(row, billingContext),
          },
          billingContext,
        ),
      )
    : [];

  const textVideoScope = scoped("j.created_by");
  const textVideo = tableExists("text_video_jobs")
    ? withLimit(
        q.all(
          `SELECT j.*,
          CASE WHEN j.output_file_id IS NOT NULL
            AND COALESCE(j.result_url,'')<>''
            AND COALESCE(j.result_sha256,'')<>''
            AND EXISTS(
              SELECT 1 FROM uploaded_files f
              WHERE f.tenant_id=j.tenant_id AND f.id=j.output_file_id
                AND f.file_url=j.result_url AND f.size=j.result_bytes
                AND f.purpose='text-video-output'
            ) THEN 1 ELSE 0 END has_output
        FROM text_video_jobs j
        WHERE j.tenant_id=?${textVideoScope.sql} ORDER BY j.id DESC LIMIT ?`,
          tenant,
          ...textVideoScope.params,
          SOURCE_SCAN_LIMIT,
        ),
      ).map((row) =>
        project(
          {
            id: row.id,
            kind: "text_video",
            category: "图文素材成片",
            title: row.title,
            employee: "视频工厂 · 真实TTS/FFmpeg",
            status: row.status,
            createdAt: row.created_at,
            finishedAt: row.completed_at,
            snapshot: textVideoProgressSnapshot(row.steps_json),
            hasOutput: Boolean(row.has_output),
            billingRefType: "text_video_job",
            billingOverride: textVideoBilling(row, billingContext),
          },
          billingContext,
        ),
      )
    : [];

  const wechatScope = scoped("d.created_by");
  const wechat = tableExists("wechat_draft_deliveries")
    ? withLimit(
        q.all(
          `SELECT d.* FROM wechat_draft_deliveries d
          WHERE d.tenant_id=?${wechatScope.sql} ORDER BY d.id DESC LIMIT ?`,
          tenant,
          ...wechatScope.params,
          SOURCE_SCAN_LIMIT,
        ),
      ).map((row) =>
        project(
          {
            id: row.id,
            kind: "wechat",
            category: "微信公众号草稿",
            title: row.title,
            employee: "内容团队 · 公众号投递",
            status: row.status,
            createdAt: row.created_at,
            finishedAt: row.completed_at,
            snapshot: wechatProgressSnapshot(row),
            hasOutput:
              row.status === "done" &&
              Boolean(cleanText(row.provider_media_id, 1)),
            billingRefType: "wechat_draft_delivery",
          },
          billingContext,
        ),
      )
    : [];

  const mediaScope = scoped("j.user_id");
  const media = withLimit(
    q.all(
      `SELECT j.*,j.snapshot_json snapshot
    FROM media_jobs j WHERE j.tenant_id=?${mediaScope.sql} ORDER BY j.id DESC LIMIT ?`,
      tenant,
      ...mediaScope.params,
      SOURCE_SCAN_LIMIT,
    ),
  ).map((row) => {
    const authority = augmentMediaJob(row, user);
    return project(
      {
        id: row.id,
        kind: "media",
        category: row.kind === "video" ? "AI 带货视频" : "AI 媒体",
        title: cleanText(row.prompt, 100) || `${row.kind || "媒体"}生成任务`,
        employee: row.content_employee_name || "AI 带货员",
        status: row.status,
        createdAt: row.created_at,
        snapshot: row.snapshot,
        hasOutput: Boolean(row.url),
        businessUsableOverride: authority.businessUsable === true,
        billingRefType: "media_job",
      },
      billingContext,
    );
  });

  const automationScope = scoped("COALESCE(r.initiated_by,a.created_by)");
  const automation = withLimit(
    q.all(
      `SELECT r.id,a.name title,r.status,r.started_at,r.finished_at,r.snapshot_json snapshot,
      COALESCE(o.content_employee_name,c.employee_name) employee_name,
      COALESCE(o.status,'') adoption_content_status,
      ap.status adoption_approval_status,
      ap.approval_policy_snapshot adoption_workflow_snapshot,
      CASE WHEN r.content_id IS NOT NULL THEN 1 ELSE 0 END has_output
    FROM content_automation_runs r
    JOIN content_automation_rules a ON a.tenant_id=r.tenant_id AND a.id=r.rule_id
    LEFT JOIN contents o ON o.tenant_id=r.tenant_id AND o.id=r.content_id
    LEFT JOIN content_employee_runs c ON c.tenant_id=r.tenant_id AND c.id=r.content_id
    LEFT JOIN approvals ap ON ap.tenant_id=r.tenant_id AND ap.id=(
      SELECT MAX(a2.id) FROM approvals a2
      WHERE a2.tenant_id=r.tenant_id AND a2.target_type='content' AND a2.target_id=r.content_id
    )
    WHERE r.tenant_id=?${automationScope.sql} ORDER BY r.id DESC LIMIT ?`,
      tenant,
      ...automationScope.params,
      SOURCE_SCAN_LIMIT,
    ),
  ).map((row) =>
    project(
      {
        id: row.id,
        kind: "automation",
        category: "自动化",
        title: row.title,
        employee: row.employee_name || "内容自动化",
        status: row.status,
        createdAt: row.started_at,
        finishedAt: row.finished_at,
        snapshot: row.snapshot,
        approvalWorkflowSnapshot: row.adoption_workflow_snapshot,
        adoptionEvidence: {
          approvalStatus: row.adoption_approval_status,
          contentStatus: row.adoption_content_status,
        },
        hasOutput: Boolean(row.has_output),
        billingRefType: "content_automation_run",
      },
      billingContext,
    ),
  );

  const toolScope = scoped("r.created_by");
  const tool = withLimit(
    q.all(
      `SELECT r.id,r.title,r.status,r.employee_name,r.created_at,r.updated_at,
      r.provenance_json,r.progress_json,r.error_json,r.retry_count,
      CASE WHEN COALESCE(r.result_md,'')<>'' THEN 1 ELSE 0 END has_output
    FROM tool_runs r WHERE r.tenant_id=?${toolScope.sql} ORDER BY r.id DESC LIMIT ?`,
      tenant,
      ...toolScope.params,
      SOURCE_SCAN_LIMIT,
    ),
  ).map((row) =>
    project(
      {
        id: row.id,
        kind: "tool",
        category: "经营工具",
        title: row.title,
        employee: row.employee_name,
        status: row.status,
        createdAt: row.created_at,
        snapshot: {
          ...parseObject(row.provenance_json),
          ...toolProgressSnapshot(row.progress_json),
        },
        finishedAt: row.status === "running" ? null : row.updated_at,
        hasOutput: Boolean(row.has_output),
        billingRefType: "tool_run",
      },
      billingContext,
    ),
  );
  return {
    items: [
      ...manual,
      ...restaurant,
      ...content,
      ...pipelines,
      ...skillLearning,
      ...advisor,
      ...avatar,
      ...textVideo,
      ...wechat,
      ...media,
      ...automation,
      ...tool,
    ],
    truncated: sourceFlags.some(Boolean),
  };
}

export function listUnifiedTasks(user, options = {}) {
  const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(options.pageSize ?? options.limit, 10) || 40),
  );
  const requestedState = cleanText(options.state, 30);
  const kind = cleanText(options.kind, 30);
  const search = cleanText(options.search, 100).toLowerCase();
  const source = loadSources(user);
  const matched = source.items
    .filter(
      (row) =>
        (!requestedState ||
          requestedState === "all" ||
          row.state === requestedState) &&
        (!kind || kind === "all" || row.kind === kind) &&
        (!search ||
          `${row.title} ${row.employee} ${row.category}`
            .toLowerCase()
            .includes(search)),
    )
    .sort(
      (a, b) =>
        String(b.createdAt).localeCompare(String(a.createdAt)) || b.id - a.id,
    );
  const offset = (page - 1) * pageSize;
  const items = matched
    .slice(offset, offset + pageSize)
    .map(
      ({
        snapshot,
        approvalSnapshot,
        billingRefType,
        billingOverride,
        billable,
        hasOutput,
        ...row
      }) => row,
    );
  const count = (state) => matched.filter((row) => row.state === state).length;
  return {
    items,
    summary: {
      scope: "filtered_scan_window",
      total: matched.length,
      pending: count("pending"),
      running: count("running"),
      review: count("review"),
      blocked: count("blocked"),
      rework: count("rework"),
      failed: count("failed"),
      done: count("done"),
      superseded: count("superseded"),
      heldCredits: matched.reduce(
        (sum, row) =>
          sum +
          (row.billing.state === "held" ? Number(row.billing.credits || 0) : 0),
        0,
      ),
    },
    window: {
      page,
      pageSize,
      returned: items.length,
      matched: matched.length,
      scanned: source.items.length,
      sourceLimitPerKind: SOURCE_SCAN_LIMIT - 1,
      truncated: source.truncated,
      hasMore: offset + items.length < matched.length,
    },
  };
}

function taskCenterDomainError(code) {
  const publicError = TASK_CENTER_PUBLIC_ERRORS[code];
  if (!publicError) throw new Error("unknown task-center domain error code");
  return Object.assign(new Error(publicError.error), {
    status: publicError.status,
    code,
  });
}

export function taskCenterPublicErrorResponse(error) {
  const publicError = TASK_CENTER_PUBLIC_ERRORS[error?.code];
  if (!publicError || Number(error?.status) !== publicError.status) return null;
  const { status: _status, ...body } = publicError;
  return error.code === "INVALID_TASK_KIND"
    ? { ...body, allowedKinds: [...TASK_CENTER_KINDS] }
    : body;
}

function assertKind(kind) {
  if (!KINDS.has(kind)) throw taskCenterDomainError("INVALID_TASK_KIND");
}

function scopedOne(user, sql, params, scopeColumn) {
  const scope = userScopeClause(user, scopeColumn);
  return q.get(`${sql}${scope.sql}`, ...params, ...scope.params);
}

export function getUnifiedTaskDetail(user, kind, rawId) {
  assertKind(kind);
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw taskCenterDomainError("INVALID_TASK_ID");
  const tenant = curTenant();
  const effectiveModules = new Set(modulesFor(user));
  let row;
  let detail;
  let supersededBy = null;
  let mediaAuthority = null;
  let avatarArtifactReady = false;
  let textVideoArtifactReady = false;
  if (kind === "manual") {
    row = scopedOne(
      user,
      `SELECT t.*,COALESCE(u.name,'未分配') employee,
      (SELECT s.content FROM task_submissions s WHERE s.tenant_id=t.tenant_id AND s.task_id=t.id ORDER BY s.id DESC LIMIT 1) output
      FROM tasks t LEFT JOIN users u ON u.tenant_id=t.tenant_id AND u.id=t.assignee_id
      WHERE t.tenant_id=? AND t.id=?`,
      [tenant, id],
      "t.assignee_id",
    );
    if (row)
      detail = {
        input: row.detail || "未填写任务说明",
        output: row.output || "",
        dueAt: row.due_at,
      };
  } else if (kind === "restaurant") {
    row = scopedOne(
      user,
      `SELECT t.*,s.employee_idx,COALESCE(s.name,m.name,'餐饮数字员工') employee,
      c.body output,c.status adoption_content_status,
      ap.status adoption_approval_status,
      ap.approval_policy_snapshot adoption_workflow_snapshot
      FROM agent_tasks t LEFT JOIN specialists s ON s.id=t.specialist_id
      LEFT JOIN marshals m ON m.id=t.marshal_id
      LEFT JOIN contents c ON c.tenant_id=t.tenant_id AND c.id=t.output_id
      LEFT JOIN approvals ap ON ap.tenant_id=t.tenant_id AND ap.id=(
        SELECT MAX(a2.id) FROM approvals a2
        WHERE a2.tenant_id=t.tenant_id AND a2.target_type='content' AND a2.target_id=t.output_id
      )
      WHERE t.tenant_id=? AND t.id=?`,
      [tenant, id],
      "t.created_by",
    );
    if (row) {
      supersededBy = loadAgentTaskSupersession(row.id, { tenantId: tenant });
      detail = {
        input: row.requirement || "未填写任务要求",
        output: supersededBy ? "" : row.output || "",
        dueAt: row.due_at,
      };
    }
  } else if (kind === "content") {
    row = scopedOne(
      user,
      `SELECT r.*,r.employee_name employee FROM content_employee_runs r
      WHERE r.tenant_id=? AND r.id=?`,
      [tenant, id],
      "r.created_by",
    );
    if (row)
      detail = {
        input: row.requirement || "未填写任务要求",
        output: row.result_md || "",
        dueAt: row.due_at,
      };
  } else if (kind === "content_pipeline") {
    row = scopedOne(
      user,
      `SELECT p.*,'内容团队流水线' employee
      FROM content_production_pipeline_jobs p
      WHERE p.tenant_id=? AND p.id=?`,
      [tenant, id],
      "p.created_by",
    );
    if (row) {
      const phaseEventsByStation = new Map();
      if (tableExists("content_production_pipeline_phase_events")) {
        for (const event of q.all(
          `SELECT id,station_idx,station_attempt,phase,state,detail_json,
          usage_ref_json,occurred_at
          FROM content_production_pipeline_phase_events
          WHERE tenant_id=? AND pipeline_id=? ORDER BY id`,
          tenant,
          id,
        )) {
          const stationIdx = Number(event.station_idx);
          const rows = phaseEventsByStation.get(stationIdx) || [];
          rows.push({
            schemaVersion: "nanowork.content-production-phase-event/1",
            id: Number(event.id),
            stationIdx,
            attempt: Number(event.station_attempt),
            phase: cleanText(event.phase, 80),
            state: cleanText(event.state, 80),
            detail: parseObject(event.detail_json),
            usageRef: Object.keys(parseObject(event.usage_ref_json)).length
              ? parseObject(event.usage_ref_json)
              : null,
            occurredAt: event.occurred_at,
          });
          phaseEventsByStation.set(stationIdx, rows);
        }
      }
      const stations = q
        .all(
          `SELECT station_idx,employee_key,handler_id,status,attempt,
          output_json,handler_evidence_json,billing_evidence_json,failure_json,started_at,completed_at
        FROM content_production_pipeline_stations
        WHERE tenant_id=? AND pipeline_id=? ORDER BY station_idx`,
          tenant,
          id,
        )
        .map((station) => ({
          stationIdx: Number(station.station_idx),
          employeeName:
            PIPELINE_EMPLOYEES[Number(station.station_idx)] ||
            station.employee_key,
          employeeKey: station.employee_key,
          handlerId: station.handler_id,
          status: station.status,
          attempt: Number(station.attempt || 0),
          usage:
            parseObject(station.handler_evidence_json)?.providerDelivery
              ?.usage ||
            parseObject(station.handler_evidence_json)?.productionRuntime
              ?.providerDelivery?.usage ||
            null,
          billing: parseObject(station.billing_evidence_json),
          phaseEvents:
            phaseEventsByStation.get(Number(station.station_idx)) || [],
          failure: parseObject(station.failure_json),
          startedAt: station.started_at,
          completedAt: station.completed_at,
        }));
      const artifactAttemptAware = tableHasColumn(
        "content_production_pipeline_artifacts",
        "station_attempt",
      );
      const pipelineArtifactAccessAvailable = effectiveModules.has("content");
      const artifacts = (
        artifactAttemptAware
          ? q.all(
              `SELECT a.id,a.station_idx,a.station_attempt,a.kind,a.is_primary,a.filename,
              a.media_type,a.byte_size,a.content_sha256,a.created_at,s.status station_status
            FROM content_production_pipeline_artifacts a
            JOIN content_production_pipeline_stations s
              ON s.tenant_id=a.tenant_id AND s.pipeline_id=a.pipeline_id
             AND s.station_idx=a.station_idx AND s.attempt=a.station_attempt
            WHERE a.tenant_id=? AND a.pipeline_id=?
            ORDER BY a.station_idx,a.artifact_index`,
              tenant,
              id,
            )
          : []
      ).map((artifact) => ({
        id: Number(artifact.id),
        stationIdx: Number(artifact.station_idx),
        stationAttempt: Number(artifact.station_attempt),
        kind: artifact.kind,
        primary: artifact.is_primary === 1,
        filename: artifact.filename,
        mediaType: artifact.media_type,
        byteSize: Number(artifact.byte_size || 0),
        sha256: artifact.content_sha256,
        createdAt: artifact.created_at,
        finalUsable: artifact.station_status === "completed",
        previewAvailable: pipelineArtifactAccessAvailable,
        downloadAvailable: pipelineArtifactAccessAvailable,
        unavailableReason: pipelineArtifactAccessAvailable
          ? null
          : "当前账号未开通内容模块，不能预览或下载工位产物",
        previewUrl: `/api/content/pipelines/${id}/stations/${Number(artifact.station_idx)}/artifacts/${Number(artifact.id)}/preview`,
        downloadUrl: `/api/content/pipelines/${id}/stations/${Number(artifact.station_idx)}/artifacts/${Number(artifact.id)}/download`,
      }));
      const finalAsset = q.get(
        `SELECT id,name,category,status,url,note,created_at,updated_at
        FROM biz_assets
        WHERE tenant_id=? AND source_type='content_pipeline' AND source_id=?
        ORDER BY id LIMIT 1`,
        tenant,
        id,
      );
      const knowledgeDoc = q.get(
        `SELECT id,category,title,enabled,updated_at
        FROM kb_docs
        WHERE tenant_id=? AND source_type='content_pipeline' AND source_id=?
        ORDER BY id LIMIT 1`,
        tenant,
        id,
      );
      const sinkNote = parseObject(finalAsset?.note);
      const knowledgeSink = {
        status:
          finalAsset && knowledgeDoc
            ? "completed"
            : finalAsset || knowledgeDoc
              ? "partial"
              : row.status === "completed"
                ? "pending"
                : "not_ready",
        sourceType: "content_pipeline",
        sourceId: id,
        assetId: finalAsset ? Number(finalAsset.id) : null,
        kbDocId: knowledgeDoc ? Number(knowledgeDoc.id) : null,
        finalArtifactFingerprint:
          cleanText(sinkNote.finalArtifactFingerprint, 100) || null,
        stationSummaryFingerprint:
          cleanText(sinkNote.stationSummaryFingerprint, 100) || null,
        publicationMetricsFingerprint:
          cleanText(sinkNote.publicationMetricsFingerprint, 100) || null,
        completedAt:
          cleanText(sinkNote.completedAt, 80) ||
          finalAsset?.created_at ||
          knowledgeDoc?.updated_at ||
          null,
        pipelineDeepLink: `/content?pipelineId=${id}`,
        assetDeepLink: finalAsset ? "/assets" : null,
      };
      const finalOutput =
        q.get(
          `SELECT output_json FROM content_production_pipeline_stations
        WHERE tenant_id=? AND pipeline_id=? AND status='completed'
        ORDER BY station_idx DESC LIMIT 1`,
          tenant,
          id,
        )?.output_json || "";
      const station = Math.min(
        9,
        Math.max(0, Number(row.pending_station ?? row.current_station ?? 0)),
      );
      const currentPhaseEvent = (phaseEventsByStation.get(station) || []).at(
        -1,
      );
      const phaseLabel =
        {
          claim: "领取工位",
          context: "装载真实上游",
          agentic_search: "隔离 WebSearch",
          controlled_fetch: "受控 WebFetch",
          provider: "调用 Provider",
          validate: "岗位契约校验",
          persist: "产物入库",
          settle: "账务结算",
          failure: "失败留痕",
          retry: "重试排队",
          recover: "中断恢复",
        }[currentPhaseEvent?.phase] || null;
      row._snapshot = {
        stepIndex: Math.min(10, station + 1),
        stepTotal: 11,
        stepLabel: phaseLabel
          ? `${PIPELINE_EMPLOYEES[station]} · ${phaseLabel}`
          : `${PIPELINE_EMPLOYEES[station]} · 工位${station}`,
      };
      row._billingOverride = pipelineBilling(id);
      detail = {
        input: JSON.stringify(parseObject(row.task_json), null, 2),
        output: finalOutput,
        error: cleanText(parseObject(row.failure_json)?.message, 300),
        pipeline: {
          status: row.status,
          currentStation: Number(row.current_station || 0),
          pendingStation:
            row.pending_station == null ? null : Number(row.pending_station),
          stations,
          artifacts,
          knowledgeSink,
          pipelineDeepLink: `/content?pipelineId=${id}`,
        },
      };
    }
  } else if (kind === "skill_learning") {
    row = scopedOne(
      user,
      `SELECT r.*,r.employee_name employee,
        (r.employee_name || '全网进修') title
      FROM employee_skill_learning_runs r
      WHERE r.tenant_id=? AND r.id=?`,
      [tenant, id],
      "r.created_by",
    );
    if (row) {
      const result = parseObject(row.result_json);
      const research = parseObject(row.research_json);
      row._snapshot = learningProgressSnapshot(row.progress_json);
      detail = {
        input: `为${row.employee_name}检索岗位最新方法论、平台规则和可执行工具玩法`,
        output:
          row.status === "completed" ? JSON.stringify(result, null, 2) : "",
        error: cleanText(parseObject(row.error_json)?.message, 300),
        learning: {
          domain: row.domain,
          employeeIdx: Number(row.employee_idx),
          skillsBefore: Number(row.skills_before || 0),
          skillsAdded: Number(row.skills_added || 0),
          skillsTotal:
            row.skills_total == null ? null : Number(row.skills_total),
          controlledSourceCount: Number(research.controlledSourceCount || 0),
          webCostUsd:
            row.web_cost_usd == null ? null : Number(row.web_cost_usd),
          providerAttempt: parseObject(row.provider_attempt_json),
          progress: (() => {
            try {
              return JSON.parse(row.progress_json || "[]");
            } catch {
              return [];
            }
          })(),
        },
      };
    }
  } else if (kind === "advisor") {
    row = scopedOne(
      user,
      `SELECT m.*,c.title,c.user_id,c.id conversation_id,c.updated_at,
      '老板参谋' employee,'done' status,
      (SELECT u.content FROM ai_messages u
       WHERE u.tenant_id=m.tenant_id AND u.conversation_id=m.conversation_id
         AND u.role='user' AND u.id<m.id
       ORDER BY u.id DESC LIMIT 1) input
      FROM ai_messages m
      JOIN ai_conversations c
        ON c.tenant_id=m.tenant_id AND c.id=m.conversation_id
      WHERE m.tenant_id=? AND m.id=? AND m.role='assistant'`,
      [tenant, id],
      "c.user_id",
    );
    if (row) {
      const convertedTasks = q.all(
        `SELECT id,title,status,assignee_id,created_at
        FROM tasks
        WHERE tenant_id=? AND source_ref_type='advisor_message' AND source_ref_id=?
        ORDER BY id`,
        tenant,
        id,
      );
      row._snapshot = {
        stepIndex: 5,
        stepTotal: 5,
        stepLabel: "会诊结果已回流",
        conversationId: Number(row.conversation_id),
      };
      detail = {
        input: row.input || "未保存本轮会诊提问",
        output: row.content || "",
        advisor: {
          conversationId: Number(row.conversation_id),
          messageId: id,
          sourceDeepLink: `/advisor?conversationId=${encodeURIComponent(String(row.conversation_id))}`,
          convertedTasks: convertedTasks.map((task) => ({
            id: Number(task.id),
            title: task.title,
            status: task.status,
            assigneeId:
              task.assignee_id == null ? null : Number(task.assignee_id),
            createdAt: task.created_at,
            deepLink: `/tasks?kind=manual&id=${encodeURIComponent(String(task.id))}`,
          })),
        },
      };
    }
  } else if (kind === "avatar") {
    row = scopedOne(
      user,
      `SELECT j.*,'数字人摄影棚 · ' || COALESCE(j.provider_name,j.engine_requested,'auto') employee,
      CASE WHEN j.output_file_id IS NOT NULL
        AND COALESCE(j.result_url,'')<>''
        AND COALESCE(j.result_sha256,'')<>''
        AND EXISTS(
          SELECT 1 FROM uploaded_files f
          WHERE f.tenant_id=j.tenant_id AND f.id=j.output_file_id
            AND f.file_url=j.result_url AND f.size=j.result_bytes
            AND f.purpose='avatar-output'
        ) THEN 1 ELSE 0 END artifact_ready
      FROM avatar_jobs j WHERE j.tenant_id=? AND j.id=?`,
      [tenant, id],
      "j.created_by",
    );
    if (row) {
      avatarArtifactReady = Boolean(row.artifact_ready);
      row._snapshot = avatarProgressSnapshot(row.steps_json);
      row._billingOverride = avatarBilling(row);
      const steps = (() => {
        try {
          const parsed = JSON.parse(row.steps_json || "[]");
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();
      detail = {
        input: JSON.stringify(
          {
            imageFileId: Number(row.image_file_id),
            audioFileId:
              row.audio_file_id == null ? null : Number(row.audio_file_id),
            inputMode: row.input_mode || "audio",
            script: row.input_mode === "script" ? row.script || "" : null,
            voiceId: row.input_mode === "script" ? row.voice_id || null : null,
            prompt: row.prompt || "",
            requestedEngine: row.engine_requested || "auto",
            durationSeconds: Number(row.duration_seconds),
          },
          null,
          2,
        ),
        output: "",
        error: cleanText(row.error_message, 300),
        avatar: {
          durationSeconds: Number(row.duration_seconds),
          imageFileId: Number(row.image_file_id),
          audioFileId:
            row.audio_file_id == null ? null : Number(row.audio_file_id),
          inputMode: row.input_mode || "audio",
          requestedEngine: row.engine_requested || "auto",
          voiceId: row.input_mode === "script" ? row.voice_id || null : null,
          provider: row.provider_name || null,
          providerTaskId: row.provider_task_id || null,
          providerResult: parseObject(row.provider_result_json),
          ttsAttempt: parseObject(row.tts_attempt_json),
          usage: parseObject(row.usage_json),
          cost: parseObject(row.cost_json),
          retryCount: Number(row.retry_count || 0),
          freeRetriesRemaining: Math.max(0, 3 - Number(row.retry_count || 0)),
          billingStatus: row.billing_status,
          artifactReady: avatarArtifactReady,
          artifact: avatarArtifactReady
            ? {
                fileId: Number(row.output_file_id),
                url: row.result_url,
                sha256: row.result_sha256,
                bytes: Number(row.result_bytes || 0),
              }
            : null,
          progress: steps,
        },
      };
    }
  } else if (kind === "text_video") {
    row = scopedOne(
      user,
      `SELECT j.*,'视频工厂 · 真实TTS/FFmpeg' employee,
      CASE WHEN j.output_file_id IS NOT NULL
        AND COALESCE(j.result_url,'')<>''
        AND COALESCE(j.result_sha256,'')<>''
        AND EXISTS(
          SELECT 1 FROM uploaded_files f
          WHERE f.tenant_id=j.tenant_id AND f.id=j.output_file_id
            AND f.file_url=j.result_url AND f.size=j.result_bytes
            AND f.purpose='text-video-output'
        ) THEN 1 ELSE 0 END artifact_ready
      FROM text_video_jobs j WHERE j.tenant_id=? AND j.id=?`,
      [tenant, id],
      "j.created_by",
    );
    if (row) {
      textVideoArtifactReady = Boolean(row.artifact_ready);
      row._snapshot = textVideoProgressSnapshot(row.steps_json);
      row._billingOverride = textVideoBilling(row);
      const steps = (() => {
        try {
          const parsed = JSON.parse(row.steps_json || "[]");
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();
      const params = parseObject(row.params_json);
      detail = {
        input: JSON.stringify(
          {
            mode: row.mode,
            body: row.body,
            imageFileIds: params.imageFileIds || [],
            materialIds: params.materialIds || [],
            clipFileIds: params.clipFileIds || [],
            allowSolidBackground: params.allowSolidBackground === true,
            voiceId: params.voiceId || null,
            bgm: params.bgm || null,
          },
          null,
          2,
        ),
        output: "",
        error: cleanText(row.error_message, 300),
        textVideo: {
          mode: row.mode,
          script: row.status === "done" ? row.script || "" : "",
          durationSeconds:
            row.duration_seconds == null ? null : Number(row.duration_seconds),
          usage: parseObject(row.usage_json),
          cost: parseObject(row.cost_json),
          renderEvidence: parseObject(row.render_evidence_json),
          retryCount: Number(row.retry_count || 0),
          freeRetriesRemaining: Math.max(0, 3 - Number(row.retry_count || 0)),
          billingStatus: row.billing_status,
          artifactReady: textVideoArtifactReady,
          artifact: textVideoArtifactReady
            ? {
                fileId: Number(row.output_file_id),
                url: row.result_url,
                sha256: row.result_sha256,
                bytes: Number(row.result_bytes || 0),
              }
            : null,
          progress: steps,
          studioDeepLink: `/toolbox?studio=text-video&jobId=${encodeURIComponent(String(id))}`,
        },
      };
    }
  } else if (kind === "wechat") {
    row = scopedOne(
      user,
      `SELECT d.*,'内容团队 · 公众号投递' employee
      FROM wechat_draft_deliveries d
      WHERE d.tenant_id=? AND d.id=?`,
      [tenant, id],
      "d.created_by",
    );
    if (row) {
      const attempt = parseObject(row.provider_attempt_json);
      const ageMs = Math.max(
        0,
        Date.now() -
          (Date.parse(row.updated_at || row.created_at || "") || Date.now()),
      );
      row._snapshot = wechatProgressSnapshot(row);
      detail = {
        input: JSON.stringify(
          {
            sourceType: row.source_type,
            sourceId: Number(row.source_id),
            coverFileId:
              row.cover_file_id == null ? null : Number(row.cover_file_id),
            imageFileIds: (() => {
              try {
                const parsed = JSON.parse(row.image_file_ids_json || "[]");
                return Array.isArray(parsed) ? parsed.map(Number) : [];
              } catch {
                return [];
              }
            })(),
          },
          null,
          2,
        ),
        output: row.status === "done" ? row.provider_media_id || "" : "",
        error: cleanText(row.error_message, 300),
        wechat: {
          sourceType: row.source_type,
          sourceId: Number(row.source_id),
          sourceDeepLink:
            row.source_type === "pipeline"
              ? `/content?pipelineId=${row.source_id}`
              : `/content?contentId=${row.source_id}`,
          studioDeepLink: `/content?wechatDeliveryId=${id}#wechat-drafts`,
          billingStatus: row.billing_status,
          providerAttempt: {
            phase: cleanText(attempt.phase, 40) || null,
            attemptedAt: cleanText(attempt.attemptedAt, 80) || null,
            reconciledAt: cleanText(attempt.reconciledAt, 80) || null,
            imageCount:
              attempt.imageCount == null ? null : Number(attempt.imageCount),
            coverUploaded: attempt.coverUploaded === true,
            markerChecked: attempt.markerChecked === true,
            outcome: cleanText(attempt.outcome, 80) || null,
          },
          needsReconciliation: ["submitting", "submitted"].includes(row.status),
          canConfirmNotDelivered:
            row.status === "submitting" &&
            row.billing_status === "held" &&
            ageMs >= 5 * 60 * 1000,
          confirmWaitSeconds:
            row.status === "submitting"
              ? Math.max(0, Math.ceil((5 * 60 * 1000 - ageMs) / 1000))
              : 0,
          mediaId: row.status === "done" ? row.provider_media_id || "" : "",
        },
      };
    }
  } else if (kind === "media") {
    row = scopedOne(
      user,
      `SELECT j.*,COALESCE(j.content_employee_name,'AI 带货员') employee FROM media_jobs j
      WHERE j.tenant_id=? AND j.id=?`,
      [tenant, id],
      "j.user_id",
    );
    if (row) {
      mediaAuthority = augmentMediaJob(row, user);
      detail = {
        input: row.prompt || "未填写媒体要求",
        output: "",
        error: cleanText(row.error, 300),
      };
    }
  } else if (kind === "automation") {
    row = scopedOne(
      user,
      `SELECT r.*,a.name title,a.topic,a.requirement,
      COALESCE(o.content_employee_name,c.employee_name,'内容自动化') employee,
      COALESCE(o.body,c.result_md,'') output,
      COALESCE(o.status,'') adoption_content_status,
      ap.status adoption_approval_status,
      ap.approval_policy_snapshot adoption_workflow_snapshot
      FROM content_automation_runs r JOIN content_automation_rules a ON a.tenant_id=r.tenant_id AND a.id=r.rule_id
      LEFT JOIN contents o ON o.tenant_id=r.tenant_id AND o.id=r.content_id
      LEFT JOIN content_employee_runs c ON c.tenant_id=r.tenant_id AND c.id=r.content_id
      LEFT JOIN approvals ap ON ap.tenant_id=r.tenant_id AND ap.id=(
        SELECT MAX(a2.id) FROM approvals a2
        WHERE a2.tenant_id=r.tenant_id AND a2.target_type='content' AND a2.target_id=r.content_id
      )
      WHERE r.tenant_id=? AND r.id=?`,
      [tenant, id],
      "COALESCE(r.initiated_by,a.created_by)",
    );
    if (row)
      detail = {
        input:
          [row.topic, row.requirement].filter(Boolean).join("\n") ||
          "按自动化规则执行",
        output: row.output || "",
        error: cleanText(row.error, 300),
      };
  } else {
    row = scopedOne(
      user,
      `SELECT r.* FROM tool_runs r WHERE r.tenant_id=? AND r.id=?`,
      [tenant, id],
      "r.created_by",
    );
    if (row) {
      const progress = (() => {
        try {
          const parsed = JSON.parse(row.progress_json || "[]");
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();
      row._snapshot = {
        ...parseObject(row.provenance_json),
        ...toolProgressSnapshot(progress),
      };
      detail = {
        input: row.input_summary || "未填写工具输入",
        output: row.status === "done" ? row.result_md || "" : "",
        error: cleanText(parseObject(row.error_json)?.message, 300),
        tool: {
          progress,
          retryCount: Number(row.retry_count || 0),
          publicResearch:
            parseObject(row.provenance_json)?.publicResearch || null,
          providerAttempt:
            parseObject(row.provenance_json)?.providerAttempt ||
            parseObject(row.provenance_json)?.attempts ||
            null,
        },
      };
    }
  }
  if (!row) throw taskCenterDomainError("TASK_NOT_ACCESSIBLE");
  const billingRefType = {
    manual: "task",
    restaurant: "agent_task",
    content: "content_employee_run",
    content_pipeline: "content_production_pipeline_station",
    skill_learning: "employee_skill_learning_run",
    advisor: "ai_message",
    avatar: "avatar_job",
    text_video: "text_video_job",
    wechat: "wechat_draft_delivery",
    media: "media_job",
    automation: "content_automation_run",
    tool: "tool_run",
  }[kind];
  const billing = billingForStatus(
    row._billingOverride ||
      billingFor(billingRefType, id, { billable: kind !== "manual" }),
    row.status,
  );
  const status = row.status;
  const snapshot =
    row._snapshot ||
    row.employee_web_snapshot ||
    row.snapshot_json ||
    row.provenance_json;
  const routing = approvalRoutingEvidence(
    row.approval_routing_policy_snapshot,
    snapshot,
    row.adoption_workflow_snapshot,
  );
  const policyContext = policyContextFor(kind, status, routing);
  const adoptionContext = adoptionContextFor(kind, status, snapshot, routing, {
    approvalStatus: row.adoption_approval_status,
    contentStatus: row.adoption_content_status,
  });
  const state = stateWithAdoption(
    projectedState(status, billing),
    adoptionContext,
  );
  const mediaBusinessUsable =
    kind === "media" && mediaAuthority?.businessUsable === true;
  if (kind === "media") {
    detail.output = mediaBusinessUsable
      ? String(mediaAuthority?.url || "")
      : "";
    detail.resultUnavailableReason = mediaBusinessUsable
      ? ""
      : `${cleanText(mediaAuthority?.reviewStatus || mediaAuthority?.canImportReason || "媒体结果暂不可用", 180)}；费用状态：${billing.label}`;
  }
  const avatarBusinessUsable =
    kind === "avatar" &&
    rawState(status) === "done" &&
    ["settled", "not_required"].includes(billing.state) &&
    avatarArtifactReady;
  if (kind === "avatar") {
    detail.output = avatarBusinessUsable ? String(row.result_url || "") : "";
    detail.resultUnavailableReason = avatarBusinessUsable
      ? ""
      : `数字人成片只有在真实文件落库且账务结算后可用；当前费用状态：${billing.label}`;
  }
  const textVideoBusinessUsable =
    kind === "text_video" &&
    rawState(status) === "done" &&
    ["settled", "not_required"].includes(billing.state) &&
    textVideoArtifactReady;
  if (kind === "text_video") {
    detail.output = textVideoBusinessUsable ? String(row.result_url || "") : "";
    detail.resultUnavailableReason = textVideoBusinessUsable
      ? ""
      : `成片只有在真实MP4落库并完成账务结算后可用；当前费用状态：${billing.label}`;
  }
  const outputPresent = Boolean(String(detail.output || "").trim());
  const billingReady = ["settled", "not_required"].includes(billing.state);
  const category = {
    manual: "人工任务",
    restaurant: "餐饮员工",
    content: "内容员工",
    content_pipeline: "内容团队流水线",
    skill_learning: "员工全网进修",
    advisor: "老板参谋会诊",
    avatar: "数字人摄影棚",
    text_video: "图文素材成片",
    wechat: "微信公众号草稿",
    media: "AI 媒体",
    automation: "自动化",
    tool: "经营工具",
  }[kind];
  const finishedAt =
    row.done_at ||
    row.finished_at ||
    row.completed_at ||
    row.updated_at ||
    null;
  const title = row.title || cleanText(row.prompt, 100) || `${kind} #${id}`;
  const conversationDeepLink = supersededBy
    ? replacementRestaurantDeepLink(supersededBy)
    : employeeConversationDeepLink(kind, row, id);
  const conversationModule =
    kind === "restaurant"
      ? "marshals"
      : ["content", "content_pipeline"].includes(kind)
        ? "content"
        : null;
  const conversationAvailable = Boolean(
    conversationDeepLink &&
    (!conversationModule || effectiveModules.has(conversationModule)),
  );
  const conversationAvailability = {
    available: conversationAvailable,
    requiredModule: conversationModule,
    reason: conversationDeepLink
      ? conversationAvailable
        ? null
        : `当前账号未开通${conversationModule === "marshals" ? "餐饮数字员工" : "内容"}模块`
      : "当前任务没有可打开的数字员工对话",
  };
  const reportMarkdown = ["restaurant", "content", "content_pipeline"].includes(
    kind,
  )
    ? readableReportMarkdown(detail.output, title)
    : "";
  const deliverables =
    kind === "restaurant"
      ? sourceDeliverables(user, "agent_task", id, detail.output)
      : kind === "content"
        ? sourceDeliverables(user, "content_employee_run", id, detail.output)
        : [];
  const deliverableAvailability = deliverables.length
    ? {
        status: "ready",
        message: `已生成 ${deliverables.length} 份可下载交付文件`,
      }
    : reportMarkdown && conversationDeepLink
      ? {
          status: "employee_conversation",
          message: "交付文件可在数字员工对话中自动生成并下载",
        }
      : {
          status: "not_ready",
          message: "报告正文生成后将提供交付文件",
        };
  const result = {
    sourceKey: `${kind}:${id}`,
    deepLink: taskDeepLink(kind, id),
    conversationDeepLink,
    conversationAvailability,
    kind,
    category,
    id,
    title,
    employee: row.employee || "未分配",
    status,
    displayStatus: displayStatusFor(status, state, adoptionContext),
    state,
    ...workflowStep(kind, status, state, billing, snapshot),
    executionProgress: generationProgressFromSnapshot(snapshot),
    researchEvidence:
      kind === "restaurant" ? restaurantResearchEvidence(snapshot) : null,
    policyContext,
    adoptionKind: adoptionContext.kind,
    adoptionContext,
    createdAt: row.created_at || row.started_at,
    finishedAt,
    elapsedMs:
      ["done", "failed"].includes(state) && !finishedAt
        ? null
        : elapsed(row.created_at || row.started_at, finishedAt),
    billing,
    businessUsable:
      kind === "media"
        ? mediaBusinessUsable && outputPresent
        : kind === "avatar"
          ? avatarBusinessUsable && outputPresent
          : kind === "text_video"
            ? textVideoBusinessUsable && outputPresent
            : rawState(status) === "done" &&
              billingReady &&
              (!CONTENT_ADOPTION_KINDS.has(kind) ||
                adoptionContext.adopted === true) &&
              outputPresent,
    reviewReady:
      state === "review" &&
      !policyContext.historical &&
      billingReady &&
      outputPresent,
    report: reportMarkdown
      ? {
          title,
          format: "markdown",
          markdown: reportMarkdown,
        }
      : null,
    deliverables,
    deliverableAvailability,
    ...detail,
  };
  if (!supersededBy) return result;
  const unavailableReason = `旧任务已由安全修订任务 #${supersededBy.taskId} 取代，请使用修订版报告与交付文件`;
  return {
    ...result,
    ...supersededRestaurantProjection(supersededBy),
    conversationDeepLink,
    conversationAvailability: {
      available: Boolean(conversationDeepLink && effectiveModules.has("marshals")),
      requiredModule: "marshals",
      reason: conversationDeepLink && effectiveModules.has("marshals")
        ? null
        : "当前账号未开通餐饮数字员工模块",
    },
    researchEvidence: null,
    policyContext: {
      historical: true,
      source: "agent_task_supersession",
      label: BUSINESS_DELIVERY_LABELS.superseded,
    },
    adoptionKind: "superseded",
    adoptionContext: {
      kind: "superseded",
      adopted: false,
      terminal: true,
      source: "agent_task_supersession",
      decisionKind: "supersession",
      label: BUSINESS_DELIVERY_LABELS.superseded,
    },
    report: null,
    deliverables: [],
    deliverableAvailability: {
      status: "superseded",
      message: unavailableReason,
    },
    output: "",
    resultUnavailableReason: unavailableReason,
  };
}
