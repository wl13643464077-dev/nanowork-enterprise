import { Router } from "express";
import { db, q, curTenant, mergeMarshal, runWithTenant } from "../db.js";
import { logOp, notify, pct, monthStart, today } from "../util.js";
import {
  EMPLOYEE_TASK_WALL_CLOCK_LIMIT_MS,
  EMPLOYEE_PROVIDER_CALL_BUDGET,
  EMPLOYEE_PROVIDER_FIXED_PROMPT_CHAR_RESERVE,
  EMPLOYEE_REPAIR_CONTEXT_CHAR_LIMIT,
  employeeTextModelFailoverPlan,
  employeeOutputTokenBudget,
  marshalWork,
  marshalChat,
  tenantDataMode,
} from "../engines/ai.js";
import { restaurantEmployeeHardDeliveryDecision } from "../engines/restaurant-output-contract.js";
import {
  applyRiskControl,
  applyChatRiskControl,
  createApproval,
} from "../engines/risk.js";
import { recordKbCitations } from "../engines/rag.js";
import {
  precheck,
  precheckByRole,
  estimateCallCredits,
  holdCredits,
  settleHold,
  releaseHold,
} from "../engines/credits.js";
import { textModelFor } from "../engines/yunwu.js";
import {
  directivesFor,
  skillByKey,
  skillsForClient,
} from "../engines/skills.js";
import { FILE_SKILLS } from "../engines/skillrun.js";
import {
  attachmentRefsForStorage,
  rehydrateMessageHistory,
  resolveRequestedAttachments,
} from "../engines/filehub.js";
import { canAccessOwner, storeScopeClause, userScopeClause } from "../engines/access.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import {
  buildEmployeeExecutionProfile,
  EMPLOYEE_TASK_TYPES,
  resolveMinimalEmployeeDispatchInput,
} from "../employee-workbench.js";
import { validateCanonicalEmployeeProfile } from "../engines/canonical-employee-profile.js";
import {
  executeHeldDelivery,
  withImmediateTransaction,
} from "../engines/two-phase-delivery.js";
import {
  autoAdoptContentOutput,
  decideContentOutput,
} from "../engines/restaurant-output-review.js";
import {
  BUSINESS_DELIVERY_LABELS,
  createAgentTaskSupersession,
  loadAgentTaskSupersession,
  loadContentAdoptionAvailability,
} from "../engines/delivery-state.js";
import {
  resolveContentApprovalPolicy,
  resolveEmployeeReviewAccess,
} from "../engines/content-approval-policy.js";
import {
  loadApprovalRoutingPolicy,
  resolveApprovalRoute,
  resolveEmployeeOutputPolicy,
} from "../engines/approval-routing-policy.js";
import {
  internalProfileLeakageNotice,
  normalizeInternalProfileLeakage,
  projectInternalProfileOutput,
} from "../engines/internal-profile-leakage.js";
import {
  createEmployeeGenerationProgressHeartbeat,
  EMPLOYEE_GENERATION_PROGRESS_KIND,
  generationProgressFromSnapshot,
} from "../engines/employee-generation-progress.js";
import {
  INSPECTION_EMPLOYEE_IDX,
  inspectionSummary,
  recordInspectionFromTask,
} from "../engines/store-inspections.js";
import { publish } from "../engines/event-bus.js";
import {
  AGENT_TASK_DRAFT_STATUS,
  CONTENT_DRAFT_STATUS,
  buildDraftContractReport,
  classifyEmployeeDraftDisposition,
  humanizeContractFailures,
  resolveContractTier,
} from "../engines/contract-tiers.js";

const r = Router();
const TASK_TYPES = new Set(EMPLOYEE_TASK_TYPES);
const MAX_MESSAGE_CHARS = 20000;
const MAX_INLINE_IMAGE_CHARS = 11_200_000;
// 后台任务返回 HTTP 后仍必须占用并发租约；预授权、供应商调用和租约超时
// 共用 ai.js 的单一调用预算，避免三处独立常量发生漂移。
const CURRENT_DEPARTMENT_CODES = Object.freeze(
  Array.from(
    { length: 8 },
    (_, index) => `M-${String(index + 1).padStart(2, "0")}`,
  ),
);
const CURRENT_DEPARTMENT_CODE_SET = new Set(CURRENT_DEPARTMENT_CODES);
const CURRENT_DEPARTMENT_SQL = CURRENT_DEPARTMENT_CODES.map(() => "?").join(
  ",",
);
const CORE_DEPARTMENT_CODES = Object.freeze(["M-01", "M-02", "M-06"]);
const INTERNAL_PROFILE_ROLES = new Set(["boss", "admin", "platform_super"]);
const EMPLOYEE_QUALITY_REWORK_CODE =
  /QUALITY|CONTRACT|LEAK|UNADOPTABLE|UNSAFE/iu;
const PUBLIC_DEPARTMENT_FIELDS = Object.freeze([
  "id",
  "code",
  "name",
  "title",
  "emoji",
  "avatar",
  "online",
  "total_tasks",
  "done_tasks",
  "collab_tasks",
  "month_outputs",
  "rate",
]);
const PUBLIC_SPECIALIST_FIELDS = Object.freeze([
  "id",
  "marshal_id",
  "employee_idx",
  "key",
  "name",
  "status",
  "last_task",
]);
const PUBLIC_TASK_FIELDS = Object.freeze([
  "id",
  "marshal_id",
  "specialist_id",
  "title",
  "type",
  "requirement",
  "status",
  "is_collab",
  "collab_marshals",
  "due_at",
  "output_id",
  "created_by",
  "created_at",
  "marshal_code",
  "marshal_name",
  "marshal_emoji",
  "marshal_avatar",
  "marshal_online",
  "output_body",
  "risk_level",
  "risk_flags",
  "output_status",
]);

function activeDepartment(base) {
  if (!base || !CURRENT_DEPARTMENT_CODE_SET.has(base.code)) return null;
  const merged = mergeMarshal({ ...base });
  return Number(merged.online) === 1 ? merged : null;
}

function activeDepartments(rows) {
  return rows.map(activeDepartment).filter(Boolean);
}

function activeDepartmentById(id) {
  return activeDepartment(
    q.get(
      `SELECT * FROM marshals WHERE id=? AND code IN (${CURRENT_DEPARTMENT_SQL})`,
      id,
      ...CURRENT_DEPARTMENT_CODES,
    ),
  );
}

function digitalEmployee(row) {
  if (!row) return row;
  const idx = Number(row.employee_idx);
  // 101-160 是 restaurant.json 的权威员工，旧租户覆盖不得改写身份、职责或上下线状态。
  if (Number.isInteger(idx) && idx >= 101 && idx <= 161)
    return { ...row, active: 1 };
  return null;
}

function mergeJoinedMarshal(row, nameKey = "marshal_name") {
  if (!row?.marshal_code) return row;
  const merged = activeDepartment({
    code: row.marshal_code,
    name: row[nameKey],
    emoji: row.marshal_emoji,
    avatar: row.marshal_avatar,
    online: row.marshal_online,
  });
  if (!merged) return null;
  return {
    ...row,
    [nameKey]: merged.name,
    marshal_emoji: merged.emoji,
    marshal_avatar: merged.avatar,
  };
}

function restaurantReviewRoles(approvalMode, riskLevel) {
  return resolveEmployeeReviewAccess({ approvalMode, riskLevel }).allowedRoles;
}

// 任务终态翻转后的实时推送（P2-7）：读取权威状态再发，不猜；发布失败不影响交付。
function publishRestaurantTaskStatusChanged(
  tenantId,
  taskId,
  { userId = null, employeeIdx = null, title = "", status = null } = {},
) {
  try {
    const row = q.get(
      `SELECT id,status,title,created_by,output_id FROM agent_tasks WHERE tenant_id=? AND id=?`,
      tenantId,
      taskId,
    );
    if (!row) return;
    const finalStatus = status || row.status;
    publish({
      tenantId,
      userIds: [row.created_by, userId].filter(Boolean),
      roles: finalStatus === "待审阅" ? ["ops_director", "manager"] : [],
      type: "task.status_changed",
      payload: {
        kind: "restaurant",
        id: Number(row.id),
        status: finalStatus,
        title: row.title || title || "",
        employeeIdx: Number.isInteger(Number(employeeIdx)) ? Number(employeeIdx) : null,
        outputId: Number(row.output_id) || null,
      },
    });
  } catch (error) {
    console.error(
      `[marshal] 任务#${taskId}实时事件发布失败:`,
      error?.message || error,
    );
  }
}

function notifyRestaurantTaskReady({
  creatorId,
  employeeName,
  taskTitle,
  taskLink,
  billingText,
  approvalMode,
  riskLevel,
  dataMode,
  autoAdopted = false,
}) {
  if (autoAdopted) {
    const normalizedRiskLevel = String(riskLevel || "")
      .trim()
      .toLowerCase();
    const policyLabel = dataMode === "demo" ? "演示策略" : "企业规则";
    const body =
      normalizedRiskLevel === "high"
        ? `高风险内部报告已生成，已按${policyLabel}自动采用（${billingText}）；现在可在内部查看，外发、付款及其他不可逆动作仍需老板执行授权。`
        : `${
            normalizedRiskLevel === "medium"
              ? "中风险内部产出"
              : normalizedRiskLevel === "low"
                ? "低风险内部产出"
                : "内部产出"
          }已按${policyLabel}自动采用（${billingText}）；现在可直接查看和使用，未执行任何对外动作。`;
    notify(
      creatorId,
      "marshal",
      `${employeeName}已完成「${taskTitle}」`,
      body,
      taskLink,
    );
    return;
  }
  const roles = restaurantReviewRoles(approvalMode, riskLevel);
  const reviewers = q
    .all(
      `SELECT id,role FROM users
    WHERE tenant_id=? AND role IN (${roles.map(() => "?").join(",")})
      AND COALESCE(status,'启用') != '停用'`,
      curTenant(),
      ...roles,
    )
    // 审批模式只决定“哪些角色可审”；人员层级继续决定“可审谁的任务”。
    // 不在创建人管理链上的同级经理不得收到标题和任务链接。
    .filter((reviewer) => canAccessOwner(reviewer, creatorId));
  const reviewerIds = new Set(reviewers.map((row) => Number(row.id)));
  for (const reviewer of reviewers) {
    notify(
      reviewer.id,
      "marshal",
      `${employeeName}交付「${taskTitle}」待您审阅`,
      `合格产出已进入待人工审阅（${billingText}）；请根据任务快照规定的审阅方式处理。`,
      taskLink,
    );
  }
  if (!reviewerIds.has(Number(creatorId))) {
    const reviewerLabel =
      roles.length === 1 && roles[0] === "boss"
        ? "老板"
        : "老板、运营总监、直属经理或管理员";
    notify(
      creatorId,
      "marshal",
      `${employeeName}已完成「${taskTitle}」`,
      `产出已提交${reviewerLabel}审阅（${billingText}）；您可查看任务进度，审阅结果由有权限的负责人处理。`,
      taskLink,
    );
  }
}

function validDateTime(value) {
  if (!value) return null;
  const input = String(value).trim();
  const match = input.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  const zonedMatch = input.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/,
  );
  const parts = match || zonedMatch;
  if (!parts) return null;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = parts;
  const values = [year, month, day, hour, minute, second].map(Number);
  const [y, m, d, h, min, sec] = values;
  const probe = new Date(Date.UTC(y, m - 1, d, h, min, sec));
  if (
    y < 1900 ||
    y > 2999 ||
    h > 23 ||
    min > 59 ||
    sec > 59 ||
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  )
    return null;
  if (zonedMatch) {
    const timestamp = Date.parse(input);
    if (!Number.isFinite(timestamp)) return null;
    // Explicit-offset ISO values represent an instant. Store one fixed-width UTC
    // SQLite datetime so sorting and date functions do not depend on the input offset.
    return new Date(timestamp).toISOString().slice(0, 19).replace("T", " ");
  }
  return `${year}-${month}-${day}${match[4] ? ` ${hour}:${minute}:${second}` : ""}`;
}

function validatedTaskImage(image, imageName) {
  if (image == null || image === "") return null;
  if (typeof image !== "string")
    throw Object.assign(new Error("图片必须使用受支持的data URL"), {
      status: 400,
    });
  const match = image.match(
    /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/u,
  );
  if (!match)
    throw Object.assign(new Error("图片格式不支持，仅接受PNG、JPEG或WebP"), {
      status: 400,
    });
  if (image.length > MAX_INLINE_IMAGE_CHARS)
    throw Object.assign(new Error("图片超过8MB，请压缩后重试"), {
      status: 413,
    });
  const name =
    typeof imageName === "string" && imageName.trim()
      ? imageName.trim().slice(0, 160)
      : `岗位证据.${match[1] === "jpeg" || match[1] === "jpg" ? "jpg" : match[1]}`;
  return {
    dataUrl: image,
    metadata: {
      name,
      mime: `image/${match[1] === "jpg" ? "jpeg" : match[1]}`,
      bytes: Math.floor((match[2].replace(/=+$/u, "").length * 3) / 4),
      sha256: crypto.createHash("sha256").update(match[2]).digest("hex"),
      persistedRawImage: false,
    },
  };
}

function pickDefined(source, keys) {
  return Object.fromEntries(
    keys
      .filter((key) => source?.[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
}

function departmentForClient(department, user) {
  if (INTERNAL_PROFILE_ROLES.has(user?.role)) return department;
  return pickDefined(department, PUBLIC_DEPARTMENT_FIELDS);
}

function specialistForClient(specialist, user) {
  if (INTERNAL_PROFILE_ROLES.has(user?.role)) return specialist;
  return pickDefined(specialist, PUBLIC_SPECIALIST_FIELDS);
}

function internalProfileRedaction() {
  return {
    internalProfile: true,
    reason:
      "完整能力、技能、提示词、工作方式、工作配置、岗位档案与内部来源仅老板、管理员和平台超管可查看。",
  };
}

function executionSnapshot(task, user = null) {
  if (
    !task?.employee_profile_version ||
    !INTERNAL_PROFILE_ROLES.has(user?.role)
  )
    return null;
  const parse = (value, label) => {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`任务${task.id}的${label}执行快照损坏，拒绝静默降级`);
    }
  };
  const parseOptional = (value, label) => {
    if (value == null || value === "") return null;
    return parse(value, label);
  };
  const executionEvidence = parseOptional(
    task.employee_web_snapshot,
    "执行证据",
  );
  const wrappedEvidence =
    executionEvidence?.kind === "restaurant_employee_execution_evidence"
      ? executionEvidence
      : null;
  const temporaryProgress =
    task.status === "生成中"
      ? generationProgressFromSnapshot(executionEvidence)
      : null;
  const canonicalProfileRaw = parseOptional(
    task.employee_canonical_snapshot,
    "统一员工对象",
  );
  const canonicalProfile = canonicalProfileRaw
    ? validateCanonicalEmployeeProfile(canonicalProfileRaw)
    : null;
  return {
    profileVersion: task.employee_profile_version,
    promptHash: task.employee_prompt_hash,
    capabilities: parse(task.employee_capabilities_snapshot, "能力"),
    config: parse(task.employee_config_snapshot, "工作配置"),
    skills: parse(task.employee_skills_snapshot, "技能"),
    canonicalProfile,
    canonicalProfileFingerprint:
      canonicalProfile?.fingerprints?.aggregate || null,
    canonicalSnapshotStatus: canonicalProfile
      ? "verified"
      : "legacy_split_only",
    inputEvidence: parseOptional(task.employee_input_snapshot, "输入证据"),
    webEvidence: wrappedEvidence
      ? wrappedEvidence.web
      : temporaryProgress
        ? executionEvidence?.web || null
        : executionEvidence,
    outputContract: wrappedEvidence?.outputContract || null,
    providerAttempt: wrappedEvidence?.providerAttempt || null,
    failure: wrappedEvidence?.failure || null,
    internalProfileLeakage: normalizeInternalProfileLeakage(
      wrappedEvidence?.internalProfileLeakage,
    ),
  };
}

function taskInternalProfileLeakage(task) {
  if (!task?.employee_web_snapshot) return null;
  try {
    const evidence = JSON.parse(task.employee_web_snapshot);
    return normalizeInternalProfileLeakage(
      evidence?.kind === "restaurant_employee_execution_evidence"
        ? evidence.internalProfileLeakage
        : null,
    );
  } catch {
    return null;
  }
}

function employeeFailureDisposition(error) {
  const providerAttempts = Array.isArray(error?.providerAttempts)
    ? error.providerAttempts
    : [];
  const providerBudget =
    error?.providerBudget && typeof error.providerBudget === "object"
      ? error.providerBudget
      : null;
  const requestedModel =
    error?.providerRequestedModel ||
    providerBudget?.requestedModel ||
    providerAttempts[0]?.requestedModel ||
    null;
  const effectiveModel =
    error?.providerEffectiveModel ||
    providerBudget?.effectiveModel ||
    [...providerAttempts].reverse().find(Boolean)?.effectiveModel ||
    error?.providerModel ||
    null;
  const modelFailover =
    error?.providerModelFailover || providerBudget?.modelFailover || null;
  const lastProviderFailure =
    [...providerAttempts]
      .reverse()
      .map((attempt) => attempt?.failure)
      .find(Boolean) || null;
  const contractErrors = Array.isArray(error?.contractErrors)
    ? error.contractErrors.map(String).filter(Boolean).slice(0, 20)
    : [];
  const code = String(error?.code || "EMPLOYEE_GENERATION_FAILED").slice(
    0,
    100,
  );
  const qualityRework =
    contractErrors.length > 0 ||
    error?.internalProfileLeakage?.detected === true ||
    EMPLOYEE_QUALITY_REWORK_CODE.test(code);
  const status = Number(error?.status);
  const retryable =
    typeof error?.retryable === "boolean"
      ? error.retryable
      : typeof lastProviderFailure?.retryable === "boolean"
        ? lastProviderFailure.retryable
        : qualityRework
          ? true
          : [400, 401, 402, 403, 404, 409, 413, 422].includes(status)
            ? false
            : true;
  const phase = String(
    error?.deliveryPhase || (qualityRework ? "quality" : "generate"),
  ).slice(0, 40);
  const hasApiCandidate = providerAttempts.some(
    (attempt) => attempt?.apiObtained === true || attempt?.mode === "api",
  );
  const contractSkipped = qualityRework
    ? null
    : phase === "persist"
      ? "delivery_persist_failed"
      : hasApiCandidate
        ? "execution_exception"
        : "no_api_candidate";
  return {
    category: qualityRework ? "quality_rework" : "execution_exception",
    presentationKey: qualityRework ? "rework_required" : "execution_failed",
    qualityRework,
    retryable,
    phase,
    code,
    contractErrors,
    contractSkipped,
    providerAttempts,
    providerBudget,
    requestedModel,
    effectiveModel,
    modelFailover,
  };
}

function taskFailureSummary(task) {
  if (!task?.employee_web_snapshot) return null;
  try {
    const evidence = JSON.parse(task.employee_web_snapshot);
    if (
      evidence?.kind !== "restaurant_employee_execution_evidence" ||
      !evidence.failure
    )
      return null;
    return {
      code: String(evidence.failure.code || "EMPLOYEE_GENERATION_FAILED").slice(
        0,
        100,
      ),
      retryable: evidence.failure.retryable !== false,
      message: String(
        evidence.failure.message || "生成失败，请补充或调整输入后重试",
      ).slice(0, 300),
      category: String(evidence.failure.category || "").slice(0, 40) || null,
      presentationKey:
        String(evidence.failure.presentationKey || "").slice(0, 40) || null,
      phase: String(evidence.failure.phase || "").slice(0, 40) || null,
    };
  } catch {
    return null;
  }
}

function taskFailedQualityGate(task) {
  if (!task?.employee_web_snapshot) return false;
  try {
    const evidence = JSON.parse(task.employee_web_snapshot);
    const failureCode = String(
      evidence?.failure?.code || evidence?.outputContract?.blocked || "",
    );
    if (evidence?.failure?.category === "quality_rework") return true;
    if (evidence?.failure?.category === "execution_exception") return false;
    return (
      evidence?.outputContract?.valid === false ||
      evidence?.internalProfileLeakage?.detected === true ||
      EMPLOYEE_QUALITY_REWORK_CODE.test(failureCode)
    );
  } catch {
    return false;
  }
}

function publicTaskWithExecution(task, user) {
  const supersededBy = task?.id
    ? loadAgentTaskSupersession(task.id, { tenantId: curTenant() })
    : null;
  // 旧正文仍留在数据库中作为不可变审计证据，但普通任务/状态接口不是审计
  // 出口。建立安全修订关系后，这些接口只返回替代指针，不能继续下发旧正文。
  const projectedTask = supersededBy ? { ...task } : task;
  if (supersededBy) {
    delete projectedTask.output_body;
    // employee_web_snapshot 的 outputContract 可能携带完整 parsedOutput；它与
    // output_body 一样不能从普通详情旁路取回。
    delete projectedTask.employee_web_snapshot;
  }
  const generationProgress =
    task?.status === "生成中"
      ? generationProgressFromSnapshot(task.employee_web_snapshot)
      : null;
  if (INTERNAL_PROFILE_ROLES.has(user?.role)) {
    const failure = taskFailureSummary(task);
    return {
      ...projectedTask,
      executionSnapshot: supersededBy ? null : executionSnapshot(task, user),
      ...(supersededBy
        ? {
            deliveryState: "DELIVERY_SUPERSEDED",
            supersededBy,
          }
        : {}),
      ...(generationProgress ? { generationProgress } : {}),
      ...(failure ? { failure } : {}),
    };
  }
  const leakage = taskInternalProfileLeakage(task);
  const failure = taskFailureSummary(task);
  const publicTask = pickDefined(projectedTask, PUBLIC_TASK_FIELDS);
  // 质检失败的任务没有形成业务产物。不要因为存在泄露审计记录，反而给
  // 普通员工投影出一段“结果已进入复核”的伪正文；否则前端会把失败任务
  // 误判成已有可查看产物。只有数据库确实关联了产物时才做正文脱敏。
  if (
    publicTask.output_id != null &&
    typeof publicTask.output_body === "string"
  ) {
    publicTask.output_body = projectInternalProfileOutput(
      publicTask.output_body,
      leakage,
      user,
    );
  }
  return {
    ...publicTask,
    ...(supersededBy
      ? {
          deliveryState: "DELIVERY_SUPERSEDED",
          supersededBy,
        }
      : {}),
    internalProfileApplied: Boolean(task?.employee_profile_version),
    internalProfileRedacted: Boolean(task?.employee_profile_version),
    ...(generationProgress ? { generationProgress } : {}),
    ...(leakage ? { internalProfileLeakage: leakage } : {}),
    ...(failure ? { failure } : {}),
  };
}

function employeeTaskBilling(taskId) {
  const hold = q.get(
    `SELECT h.id,h.log_id,h.status,h.held_credits,h.settled_credits,
      l.id ledger_id,l.credits ledger_credits,l.cost_yuan
    FROM credit_holds h
    LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
    WHERE h.tenant_id=${curTenant()} AND h.ref_type='agent_task' AND h.ref_id=?
    ORDER BY h.id DESC LIMIT 1`,
    taskId,
  );
  if (!hold) {
    return {
      state: "missing",
      label: "未发现本次任务的积分账务记录",
      credits: null,
      costYuan: null,
      authoritative: false,
    };
  }
  const heldCredits = Number(hold.held_credits);
  const settledCredits =
    hold.settled_credits == null ? null : Number(hold.settled_credits);
  const ledgerCredits =
    hold.ledger_credits == null ? null : Number(hold.ledger_credits);
  const ledgerLinked =
    Number(hold.ledger_id) > 0 &&
    Number(hold.ledger_id) === Number(hold.log_id);
  const base = {
    heldCredits: Number.isFinite(heldCredits) ? heldCredits : null,
    settledCredits: Number.isFinite(settledCredits) ? settledCredits : null,
    costYuan: hold.cost_yuan == null ? null : Number(hold.cost_yuan),
    authoritative: true,
  };
  if (hold.status === "held") {
    return {
      ...base,
      state: "held",
      credits: base.heldCredits,
      label: `已预授权 ${base.heldCredits ?? "—"} 积分，任务终结后才会结算`,
    };
  }
  if (
    hold.status === "settled" &&
    settledCredits === 0 &&
    ledgerLinked &&
    ledgerCredits === 0
  ) {
    return {
      ...base,
      state: "released",
      credits: 0,
      label: `任务失败，${base.heldCredits ?? 0} 积分预授权已全额退回，实扣 0 积分`,
    };
  }
  if (
    hold.status === "settled" &&
    settledCredits != null &&
    settledCredits > 0 &&
    ledgerLinked &&
    ledgerCredits === settledCredits
  ) {
    return {
      ...base,
      state: "settled",
      credits: settledCredits,
      label: `已结算 ${settledCredits} 积分`,
    };
  }
  return {
    ...base,
    state: "pending_reconciliation",
    credits: settledCredits ?? base.heldCredits,
    label: "积分账务待对账，对账前不可用于业务",
    authoritative: false,
  };
}

function employeeContractAudit(out) {
  if (!out?.employeeContract) return null;
  const primaryArtifact = (out.employeeContract.artifacts || []).find(
    (artifact) => artifact?.primary === true,
  );
  return {
    valid: out.employeeContract.valid === true,
    requestedModel:
      out.employeeContract.requestedModel || out.requestedModel || null,
    effectiveModel:
      out.employeeContract.effectiveModel ||
      out.effectiveModel ||
      out.model ||
      null,
    modelFailover:
      out.employeeContract.modelFailover || out.modelFailover || null,
    skipped: out.employeeContract.skipped || null,
    blocked: out.employeeContract.blocked || null,
    contractId: out.employeeContract.contractId || null,
    schemaVersion: out.employeeContract.schemaVersion || null,
    primaryArtifact: out.employeeContract.primaryArtifact || null,
    qualityMode: out.employeeContract.qualityMode || "strict",
    ...(out.employeeContract.contractTier
      ? { contractTier: out.employeeContract.contractTier }
      : {}),
    ...(out.employeeContract.deliveryStyle
      ? { deliveryStyle: out.employeeContract.deliveryStyle }
      : {}),
    reportFirstMarkdown: out.employeeContract.reportFirstMarkdown === true,
    structuredReportFirst:
      out.employeeContract.structuredReportFirst === true,
    hardDelivery: out.employeeContract.hardDelivery || out.hardDelivery || null,
    warnings: Array.isArray(out.employeeContract.warnings)
      ? out.employeeContract.warnings.map(String).filter(Boolean).slice(0, 50)
      : [],
    repair: out.employeeContract.repair || null,
    generationRetry: out.employeeContract.generationRetry || null,
    providerAttempts: Array.isArray(out.employeeContract.providerAttempts)
      ? out.employeeContract.providerAttempts
      : [],
    providerBudget: out.employeeContract.providerBudget || null,
    parsedOutput: out.employeeContract.parsed || null,
    providerResponseSha256:
      typeof primaryArtifact?.content === "string"
        ? crypto
            .createHash("sha256")
            .update(primaryArtifact.content)
            .digest("hex")
        : null,
    renderedBodySha256:
      typeof out.text === "string"
        ? crypto.createHash("sha256").update(out.text).digest("hex")
        : null,
    artifacts: (out.employeeContract.artifacts || []).map((artifact) => ({
      kind: artifact.kind,
      primary: artifact.primary === true,
      filename: artifact.filename,
      mediaType: artifact.mediaType,
      employeeIdx: artifact.employeeIdx,
      employeeKey: artifact.employeeKey,
      contractId: artifact.contractId,
      schemaVersion: artifact.schemaVersion,
      contentSha256:
        typeof artifact.content === "string"
          ? crypto.createHash("sha256").update(artifact.content).digest("hex")
          : null,
    })),
  };
}

// ===== P0-1 失败不交白卷：把失败错误 / 超时前留底的完整候选折成“未达标草稿”输出 =====
// 只有非安全类失败才有草稿；安全类（外发/付费/不可逆、内部档案、平台伪造）返回 null，
// 调用方继续走原失败释放路径。正文原样保留，不做任何改写（反造假哈希链）。
function employeeDraftFromFailure(error, { lastObservedCandidate, contractTier }) {
  if (error?.draft && error.draft.text) {
    return { ...error.draft, source: "marshal_work_failure" };
  }
  if (error?.draftBlockedBy === "safety") return null;
  const timeout =
    error?.code === "EMPLOYEE_TASK_TIMEOUT" || error?.status === 504;
  if (!timeout) return null;
  if (!lastObservedCandidate?.text) {
    // 墙钟耗尽前没有任何一轮完整正文：失败证据记下“无正文”，便于区分空白超时与草稿超时
    if (error && typeof error === "object" && error.draftBlockedBy == null) {
      error.draftBlockedBy = "no_text";
    }
    return null;
  }
  const disposition = classifyEmployeeDraftDisposition({
    contractErrors: lastObservedCandidate.contractErrors || [],
    hardDeliveryErrors: lastObservedCandidate.hardDelivery?.errors || [],
    text: lastObservedCandidate.text,
    mode: "api",
    usage: lastObservedCandidate.usage,
    complete: lastObservedCandidate.complete !== false,
    failReason: "timeout",
  });
  if (!disposition.eligible) {
    if (error && typeof error === "object" && error.draftBlockedBy == null) {
      error.draftBlockedBy = disposition.blockedBy;
    }
    return null;
  }
  return {
    text: String(lastObservedCandidate.text || ""),
    model: lastObservedCandidate.model || null,
    requestedModel: lastObservedCandidate.requestedModel || null,
    effectiveModel: lastObservedCandidate.model || null,
    modelFailover: null,
    usage: lastObservedCandidate.usage,
    finishReason: lastObservedCandidate.finishReason ?? null,
    contractErrors: lastObservedCandidate.contractErrors || [],
    warnings: lastObservedCandidate.warnings || [],
    deliveryStyle: lastObservedCandidate.deliveryStyle || null,
    parsed: lastObservedCandidate.parsed || null,
    hardDelivery: lastObservedCandidate.hardDelivery || null,
    contractTier: lastObservedCandidate.contractTier || contractTier || null,
    attempts: Number(lastObservedCandidate.candidateAttempts || 0),
    transportFailures: Number(lastObservedCandidate.transportFailures || 0),
    stoppedReason: "task_wall_clock_exhausted",
    disposition,
    source: "timeout_last_candidate",
  };
}

function employeeDraftOutput(draft, error, { web, kb, reviewDatasetImport }) {
  const report = buildDraftContractReport({
    disposition: draft.disposition,
    contractTier: draft.contractTier,
    attempts: draft.attempts,
    transportFailures: draft.transportFailures,
    stoppedReason: draft.stoppedReason,
    deliveryStyle: draft.deliveryStyle,
    requestedModel: draft.requestedModel,
    effectiveModel: draft.effectiveModel || draft.model,
    contractErrors: draft.contractErrors,
  });
  return {
    text: draft.text,
    mode: "api",
    model: draft.model,
    usage: draft.usage,
    finishReason: draft.finishReason,
    requestedModel: draft.requestedModel,
    effectiveModel: draft.effectiveModel || draft.model,
    modelFailover: draft.modelFailover || null,
    hardDelivery: draft.hardDelivery,
    internalProfileLeakage: error?.internalProfileLeakage || null,
    web: error?.web || web || null,
    kb: error?.kb || kb || null,
    ...(error?.reviewDatasetImport || reviewDatasetImport
      ? { reviewDatasetImport: error?.reviewDatasetImport || reviewDatasetImport }
      : {}),
    employeeDraft: {
      failReason: draft.disposition?.failReason || "contract",
      acceptable: draft.disposition?.acceptable === true,
      source: draft.source,
      failureCode: String(error?.code || "EMPLOYEE_DRAFT_FALLBACK").slice(0, 100),
      failureMessage: String(error?.message || "").slice(0, 300),
      report,
    },
    employeeContract: {
      valid: false,
      draft: true,
      blocked: null,
      contractTier: draft.contractTier,
      requestedModel: draft.requestedModel,
      effectiveModel: draft.effectiveModel || draft.model,
      modelFailover: draft.modelFailover || null,
      errors: [...(draft.contractErrors || [])],
      warnings: [...(draft.warnings || [])],
      repair: error?.contractRepair || null,
      generationRetry: error?.providerRetry || null,
      providerAttempts: Array.isArray(error?.providerAttempts)
        ? error.providerAttempts
        : [],
      providerBudget: error?.providerBudget || null,
      parsed: draft.parsed || null,
      qualityMode: draft.deliveryStyle === "paihuo_markdown" ? "paihuo_markdown" : "strict",
      ...(draft.deliveryStyle ? { deliveryStyle: draft.deliveryStyle } : {}),
      reportFirstMarkdown: draft.deliveryStyle === "paihuo_markdown",
      structuredReportFirst: false,
      hardDelivery: draft.hardDelivery,
      artifacts: [],
    },
  };
}

// —— 巡店看板（#161 巡店督导归档统计）——
// 老板/管理员/运营总监看企业全量；其他角色只看自己派活产生的巡店记录（与任务可见性同口径）。
r.get("/inspections/summary", (req, res) => {
  const scope = userScopeClause(req.user, "t.created_by");
  // 多门店：当前门店生效时只看本店巡店归档（未传头=全部，结果与现状一致）
  const storeScope = storeScopeClause(req.user, "i.store_id");
  const months = Math.min(12, Math.max(1, Number(req.query.months) || 3));
  res.set("Cache-Control", "private, no-store");
  res.json(
    inspectionSummary(curTenant(), {
      months,
      scopeSql: `${scope.sql}${storeScope.sql}`,
      scopeParams: [...scope.params, ...storeScope.params],
    }),
  );
});

r.get("/overview", (req, res) => {
  const taskScope = userScopeClause(req.user, "created_by");
  const departments = activeDepartments(
    q.all(
      `SELECT * FROM marshals WHERE code IN (${CURRENT_DEPARTMENT_SQL}) ORDER BY sort`,
      ...CURRENT_DEPARTMENT_CODES,
    ),
  );
  const marshals = departments.length;
  const departmentIds = departments.map((department) => department.id);
  const departmentScope = departmentIds.length
    ? ` AND marshal_id IN (${departmentIds.map(() => "?").join(",")})`
    : " AND 1=0";
  const specialists = departments.reduce(
    (total, department) =>
      total +
      q
        .all(
          "SELECT id,employee_idx,name,duty FROM specialists WHERE marshal_id=? AND employee_idx BETWEEN 101 AND 161",
          department.id,
        )
        .map(digitalEmployee)
        .filter((employee) => employee?.active !== 0).length,
    0,
  );
  const collab =
    q.get(
      `SELECT COUNT(*) n FROM agent_tasks WHERE tenant_id = ${curTenant()} AND is_collab = 1 AND status IN ('生成中','待审阅')${departmentScope}${taskScope.sql}`,
      ...departmentIds,
      ...taskScope.params,
    )?.n || 0;
  const monthOut =
    q.get(
      `SELECT COUNT(*) n FROM agent_tasks WHERE tenant_id = ${curTenant()} AND created_at >= ?${departmentScope}${taskScope.sql}`,
      monthStart(),
      ...departmentIds,
      ...taskScope.params,
    )?.n || 0;
  const done =
    q.get(
      `SELECT COUNT(*) n FROM agent_tasks WHERE tenant_id = ${curTenant()} AND created_at >= ? AND status = '已完成'${departmentScope}${taskScope.sql}`,
      monthStart(),
      ...departmentIds,
      ...taskScope.params,
    )?.n || 0;
  res.json({
    marshals,
    specialists,
    core: CORE_DEPARTMENT_CODES.length,
    collab,
    monthTasks: monthOut,
    monthOutputs: done,
    avgRate: pct(done, monthOut || 1),
  });
});

// ===== 顶部统计卡钻取（六张卡逐卡可点，全部可溯源到明细）=====
r.get("/drill/:kind", (req, res) => {
  const kind = req.params.kind;
  const taskScope = userScopeClause(req.user, "t.created_by");
  if (kind === "marshals") {
    const rows = q.all(
      `SELECT m.code, m.name, m.title, m.emoji, m.avatar, m.online, m.duty,
      (SELECT COUNT(*) FROM specialists s WHERE s.marshal_id = m.id AND s.employee_idx BETWEEN 101 AND 161) specialists,
      (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id AND t.status = '生成中'${taskScope.sql}) running
      FROM marshals m WHERE m.code IN (${CURRENT_DEPARTMENT_SQL}) ORDER BY m.sort`,
      ...taskScope.params,
      ...CURRENT_DEPARTMENT_CODES,
    );
    return res.json({
      title: "餐饮数字员工编制总览",
      rows: activeDepartments(rows),
    });
  }
  if (kind === "specialists") {
    const rows = q
      .all(
        `SELECT s.id,s.employee_idx,s.key,s.person,s.name,s.duty,m.code marshal_code,m.name marshal,m.emoji,m.avatar,m.online marshal_online,m.sort,
      CASE WHEN EXISTS(SELECT 1 FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.specialist_id=s.id AND t.status='生成中'${taskScope.sql})
        THEN '执行中' ELSE '空闲' END status
      FROM specialists s JOIN marshals m ON m.id=s.marshal_id
      WHERE m.code IN (${CURRENT_DEPARTMENT_SQL}) AND s.employee_idx BETWEEN 101 AND 161 ORDER BY m.sort,s.employee_idx`,
        ...taskScope.params,
        ...CURRENT_DEPARTMENT_CODES,
      )
      .map((row) => {
        const specialist = digitalEmployee(row);
        const department = activeDepartment({
          code: row.marshal_code,
          name: row.marshal,
          emoji: row.emoji,
          avatar: row.avatar,
          online: row.marshal_online,
        });
        return department && specialist && specialist.active !== 0
          ? {
              ...specialist,
              marshal: department.name,
              emoji: department.emoji,
              avatar: department.avatar,
            }
          : null;
      })
      .filter(Boolean);
    return res.json({ title: "数字员工编制明细（按分部分组）", rows });
  }
  if (kind === "core") {
    const rows = q.all(
      `SELECT m.code, m.name, m.title, m.emoji, m.avatar, m.duty,
      m.online,
      (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id AND t.created_at >= ?${taskScope.sql}) month_tasks
      FROM marshals m WHERE m.code IN (${CORE_DEPARTMENT_CODES.map(() => "?").join(",")}) ORDER BY m.sort`,
      monthStart(),
      ...taskScope.params,
      ...CORE_DEPARTMENT_CODES,
    );
    return res.json({
      title: "核心分部协作链",
      rows: activeDepartments(rows),
      note: "核心协作链用于缩短经营任务的决策与执行路径；所有结论仍需结合当前门店真实数据并由负责人确认。",
    });
  }
  if (kind === "collab") {
    const rows = q
      .all(
        `SELECT t.id, t.title, t.type, t.status, t.collab_marshals, t.created_at,
      m.code marshal_code,m.name marshal_name,m.emoji marshal_emoji,m.avatar marshal_avatar,m.online marshal_online
      FROM agent_tasks t JOIN marshals m ON m.id = t.marshal_id WHERE t.tenant_id = ${curTenant()} AND t.is_collab = 1 AND t.status IN ('生成中','待审阅')${taskScope.sql} ORDER BY t.created_at DESC LIMIT 50`,
        ...taskScope.params,
      )
      .map((row) => {
        const merged = mergeJoinedMarshal(row);
        return merged
          ? {
              ...merged,
              marshal: merged.marshal_name,
              emoji: merged.marshal_emoji,
              avatar: merged.marshal_avatar,
            }
          : null;
      })
      .filter(Boolean);
    return res.json({ title: "进行中协同任务", rows });
  }
  if (kind === "outputs") {
    const rows = q
      .all(
        `SELECT t.id, t.title, t.type, t.status, t.created_at,
      m.code marshal_code,m.name marshal_name,m.emoji marshal_emoji,m.avatar marshal_avatar,m.online marshal_online
      FROM agent_tasks t JOIN marshals m ON m.id = t.marshal_id WHERE t.tenant_id = ${curTenant()} AND t.created_at >= ? AND t.status='已完成'${taskScope.sql} ORDER BY t.created_at DESC LIMIT 80`,
        monthStart(),
        ...taskScope.params,
      )
      .map((row) => {
        const merged = mergeJoinedMarshal(row);
        return merged
          ? {
              ...merged,
              marshal: merged.marshal_name,
              emoji: merged.marshal_emoji,
              avatar: merged.marshal_avatar,
            }
          : null;
      })
      .filter(Boolean);
    return res.json({ title: "本月任务产出明细", rows });
  }
  if (kind === "tasks") {
    const rows = q
      .all(
        `SELECT t.id, t.title, t.type, t.status, t.created_at,
      s.employee_idx, s.name employee_name,
      m.code marshal_code,m.name marshal_name,m.emoji marshal_emoji,m.avatar marshal_avatar,m.online marshal_online,
      EXISTS(
        SELECT 1 FROM approvals a
        WHERE a.tenant_id=t.tenant_id
          AND a.target_type='content'
          AND a.target_id=t.output_id
          AND a.status='已通过'
      ) human_adopted
      FROM agent_tasks t
      JOIN specialists s ON s.id = t.specialist_id AND s.employee_idx BETWEEN 101 AND 161
      JOIN marshals m ON m.id = t.marshal_id AND m.id = s.marshal_id
      WHERE t.tenant_id = ${curTenant()}${taskScope.sql}
      ORDER BY t.id DESC LIMIT 80`,
        ...taskScope.params,
      )
      .map((row) => {
        const merged = mergeJoinedMarshal(row);
        return merged
          ? {
              ...merged,
              employeeIdx: Number(merged.employee_idx),
              marshal: merged.marshal_name,
              emoji: merged.marshal_emoji,
              avatar: merged.marshal_avatar,
              adoptionKind:
                merged.status === "已完成"
                  ? Number(merged.human_adopted) === 1
                    ? "human"
                    : "auto"
                  : null,
              displayStatus:
                merged.status === "已完成"
                  ? Number(merged.human_adopted) === 1
                    ? BUSINESS_DELIVERY_LABELS.adopted
                    : RESTAURANT_AUTO_ADOPTED_LABEL
                  : null,
            }
          : null;
      })
      .filter(Boolean);
    return res.json({ title: "最新数字员工任务动态", rows });
  }
  if (kind === "rate") {
    const rows = q.all(
      `SELECT m.code, m.name, m.emoji, m.avatar,
      (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id AND t.created_at >= ?${taskScope.sql}) total,
      (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id AND t.created_at >= ? AND t.status = '已完成'${taskScope.sql}) done,
      (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id AND t.status = '待审阅'${taskScope.sql}) pending
      FROM marshals m WHERE m.code IN (${CURRENT_DEPARTMENT_SQL}) ORDER BY m.sort`,
      monthStart(),
      ...taskScope.params,
      monthStart(),
      ...taskScope.params,
      ...taskScope.params,
      ...CURRENT_DEPARTMENT_CODES,
    );
    return res.json({
      title: "各分部完成率（本月）",
      rows: activeDepartments(rows).map((x) => ({
        ...x,
        rate: pct(x.done, x.total || 1),
      })),
    });
  }
  res.status(400).json({ error: "未知钻取类型" });
});

r.get("/", (req, res) => {
  const taskScope = userScopeClause(req.user, "t.created_by");
  const rows = q.all(
    `SELECT m.*,
    (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id${taskScope.sql}) total_tasks,
    (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id AND t.status = '已完成'${taskScope.sql}) done_tasks,
    (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id AND t.is_collab = 1 AND t.status IN ('生成中','待审阅')${taskScope.sql}) collab_tasks,
    (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id AND t.created_at >= ? AND t.status='已完成'${taskScope.sql}) month_outputs
    FROM marshals m WHERE m.code IN (${CURRENT_DEPARTMENT_SQL}) ORDER BY m.sort`,
    ...taskScope.params,
    ...taskScope.params,
    ...taskScope.params,
    monthStart(),
    ...taskScope.params,
    ...CURRENT_DEPARTMENT_CODES,
  );
  res.json(
    activeDepartments(rows).map((m) =>
      departmentForClient(
        {
          ...m,
          rate: pct(m.done_tasks, m.total_tasks || 1),
        },
        req.user,
      ),
    ),
  );
});

r.get("/:id", (req, res) => {
  const m = activeDepartmentById(req.params.id);
  if (!m) return res.status(404).json({ error: "分部不存在或未启用" });
  const taskScope = userScopeClause(req.user, "t.created_by");
  const contentScope = userScopeClause(req.user, "c.creator_id");
  const specialists = q
    .all(
      `SELECT s.id,s.marshal_id,s.employee_idx,s.key,s.person,s.name,s.duty,
    CASE WHEN EXISTS(SELECT 1 FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.specialist_id=s.id AND t.status='生成中'${taskScope.sql})
      THEN '执行中' ELSE '空闲' END status,
    (SELECT t.title FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.specialist_id=s.id${taskScope.sql} ORDER BY t.created_at DESC LIMIT 1) last_task
    FROM specialists s WHERE s.marshal_id=? AND s.employee_idx BETWEEN 101 AND 161`,
      ...taskScope.params,
      ...taskScope.params,
      req.params.id,
    )
    .map(digitalEmployee)
    .filter((specialist) => specialist?.active !== 0)
    .map((specialist) => specialistForClient(specialist, req.user));
  const tasks = q
    .all(
      `SELECT t.* FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.marshal_id=?${taskScope.sql}
    ORDER BY t.created_at DESC LIMIT 15`,
      req.params.id,
      ...taskScope.params,
    )
    .map((task) => publicTaskWithExecution(task, req.user));
  const outputs = q.all(
    `SELECT c.id,c.type,c.title,c.status,c.created_at FROM contents c
    WHERE c.tenant_id=${curTenant()} AND c.marshal_id=?${contentScope.sql} ORDER BY c.created_at DESC LIMIT 8`,
    req.params.id,
    ...contentScope.params,
  );
  const stats = {
    todayTasks:
      q.get(
        `SELECT COUNT(*) n FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.marshal_id=?
      AND date(t.created_at)=date('now','localtime')${taskScope.sql}`,
        req.params.id,
        ...taskScope.params,
      )?.n || 0,
    rate: pct(
      q.get(
        `SELECT COUNT(*) n FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.marshal_id=? AND t.status='已完成'${taskScope.sql}`,
        req.params.id,
        ...taskScope.params,
      )?.n || 0,
      q.get(
        `SELECT COUNT(*) n FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.marshal_id=?${taskScope.sql}`,
        req.params.id,
        ...taskScope.params,
      )?.n || 1,
    ),
    collab:
      q.get(
        `SELECT COUNT(*) n FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.marshal_id=?
      AND t.is_collab=1 AND t.status IN ('生成中','待审阅')${taskScope.sql}`,
        req.params.id,
        ...taskScope.params,
      )?.n || 0,
    monthOutputs:
      q.get(
        `SELECT COUNT(*) n FROM agent_tasks t WHERE t.tenant_id=${curTenant()} AND t.marshal_id=?
      AND t.created_at>=? AND t.status='已完成'${taskScope.sql}`,
        req.params.id,
        monthStart(),
        ...taskScope.params,
      )?.n || 0,
  };
  res.json({
    ...departmentForClient(m, req.user),
    specialists,
    tasks,
    outputs,
    stats,
  });
});

// 派发任务（FR-MAR-02）：异步化——立即返回任务ID，后台AI生成，前端轮询流程状态
// 流程可视化状态机：已派发 → 生成中 → 待审阅 → 已完成/已驳回（失败可重试）
export async function dispatchMarshalTask(req, res) {
  let hold = null; // 两段式记账占扣句柄：派发前占扣，后台生成成功结算实扣、失败全额退回
  let taskId = null;
  try {
    const m = activeDepartmentById(req.params.id);
    if (!m) return res.status(404).json({ error: "分部不存在或未启用" });
    let dispatchPayload;
    try {
      dispatchPayload = resolveMinimalEmployeeDispatchInput(req.body || {});
    } catch (inputError) {
      return res
        .status(400)
        .json({ error: inputError?.message || "请输入本次要解决的问题" });
    }
    const {
      title,
      type,
      requirement,
      dueAt,
      specialistId,
      collabMarshals,
      image,
      imageName,
    } = dispatchPayload;
    const taskTitle = typeof title === "string" ? title.trim() : "";
    const taskRequirement =
      requirement == null
        ? ""
        : typeof requirement === "string"
          ? requirement.trim()
          : null;
    const taskType = type == null || type === "" ? "常规" : String(type).trim();
    const dueDate = dueAt == null || dueAt === "" ? null : validDateTime(dueAt);
    if (!taskTitle) return res.status(400).json({ error: "任务标题必填" });
    if (taskTitle.length > 100)
      return res.status(400).json({ error: "任务标题不能超过100字" });
    if (taskRequirement == null || taskRequirement.length > 8000)
      return res.status(400).json({ error: "任务要求必须是8000字以内的文本" });
    if (!TASK_TYPES.has(taskType))
      return res.status(400).json({ error: "任务类型不正确" });
    if (dueAt && !dueDate)
      return res.status(400).json({ error: "截止时间不正确" });
    const taskImage = validatedTaskImage(image, imageName);
    const files = resolveRequestedAttachments(
      dispatchPayload.fileIds,
      req.user,
      6,
    );
    const attachmentRefs = attachmentRefsForStorage(files);
    const specialist =
      specialistId == null || specialistId === "" ? null : Number(specialistId);
    const selectedSpecialist =
      specialist == null || !Number.isInteger(specialist)
        ? null
        : digitalEmployee(
            q.get(
              "SELECT id,marshal_id,employee_idx,key,person,name,duty FROM specialists WHERE id = ? AND marshal_id = ? AND employee_idx BETWEEN 101 AND 161",
              specialist,
              m.id,
            ),
          );
    if (
      specialist != null &&
      (!Number.isInteger(specialist) ||
        !selectedSpecialist ||
        selectedSpecialist.active === 0)
    ) {
      return res
        .status(400)
        .json({ error: "指定数字员工不属于当前分部或未启用" });
    }
    // 派活默认走本地派活AI的执行逻辑：紧凑岗位提示词 + 直接输出老板可读
    // Markdown 报告。设 NANOWORK_EMPLOYEE_OUTPUT_STYLE=contract_json 可退回
    // 旧的JSON机器契约链路。
    const employeeExecution = selectedSpecialist
      ? buildEmployeeExecutionProfile(selectedSpecialist.employee_idx, {
          outputMode:
            String(
              process.env.NANOWORK_EMPLOYEE_OUTPUT_STYLE || "",
            ).trim() === "contract_json"
              ? undefined
              : "paihuo_markdown",
        })
      : null;
    // 评价数据文件名和本地URL可能自带顾客姓名、手机号或订单标识。143号
    // 岗位仍以本轮已授权FileHub对象执行，但任务输入快照只存去标识化引用。
    const storedAttachmentRefs =
      employeeExecution?.workbench?.identity?.idx === 143
        ? attachmentRefs.map((file, index) => ({
            ...(file.id ? { id: file.id } : {}),
            name: `评价数据附件${index + 1}${file.ext ? `.${file.ext}` : ""}`,
            ...(file.ext ? { ext: file.ext } : {}),
            readable: file.readable !== false,
            contentSha256: file.contentSha256,
          }))
        : attachmentRefs;
    if (collabMarshals != null && !Array.isArray(collabMarshals))
      return res.status(400).json({ error: "协同分部格式不正确" });
    const collaborators = [
      ...new Set(
        (collabMarshals || [])
          .map((code) => String(code).trim())
          .filter(Boolean),
      ),
    ];
    if (collaborators.length > 7)
      return res.status(400).json({ error: "协同分部不能超过7个" });
    if (collaborators.length) {
      if (collaborators.includes(m.code))
        return res.status(400).json({ error: "协同分部不能与牵头分部重复" });
      const selected = activeDepartments(
        q.all(
          `SELECT * FROM marshals WHERE code IN (${collaborators.map(() => "?").join(",")})`,
          ...collaborators,
        ),
      );
      const validCodes = new Set(selected.map((row) => row.code));
      if (validCodes.size !== collaborators.length)
        return res
          .status(400)
          .json({ error: "协同分部不存在、已下线或不在当前8分部目录中" });
    }
    // 两段式记账：派发即按实际任务内容占扣（BE-C1 估算口径），异步生成不再出现"成功漏收费/失败仍收费"
    const employeeConfig = employeeExecution?.workbench?.workConfig || {};
    const estimateCreditsFn =
      req.app?.locals?.employeeEstimateCallCredits || estimateCallCredits;
    const holdModel = taskImage
      ? employeeConfig.visionModel ||
        employeeConfig.textModel ||
        textModelFor(req.user.role)
      : employeeConfig.textModel || textModelFor(req.user.role);
    // 餐饮岗位的备用模型只会在首选模型发生受控的零 Token 传输故障后
    // 启用。预授权必须在任何供应商调用前覆盖主备模型的较高价格；hold
    // 本身仍记录 requested primary，最终 credit_logs 则由 settleHold 写入
    // actual final model，二者共同形成可审计的模型切换证据。
    const holdModelPlan = employeeExecution
      ? employeeTextModelFailoverPlan(holdModel)
      : {
          version: 1,
          requestedModel: holdModel,
          models: [holdModel],
          backupModel: null,
        };
    for (const model of holdModelPlan.models) {
      precheck(req.user.id, "text", model);
    }
    const perAttemptOutputTokens = employeeOutputTokenBudget(
      employeeConfig.outputLength,
    );
    const perAttemptTexts = [
      taskTitle,
      taskRequirement,
      employeeExecution?.systemContext ||
        (selectedSpecialist
          ? `${selectedSpecialist.name}：${selectedSpecialist.duty}`
          : ""),
      taskImage ? "附带一张视觉证据，按多模态输入计入预授权" : "",
      ...files.map((file) =>
        file.readable && file.content
          ? `统一文件中心附件·${file.name}\n${file.content}`
          : `统一文件中心附件·${file.name}（未提取到可读正文，只记录文件证据）`,
      ),
    ];
    const responseSchemaReserve = employeeExecution?.responseSchema
      ? JSON.stringify(employeeExecution.responseSchema)
      : "";
    const fixedPromptReserve = "岗位固定提示开销".padEnd(
      EMPLOYEE_PROVIDER_FIXED_PROMPT_CHAR_RESERVE *
        EMPLOYEE_PROVIDER_CALL_BUDGET,
      "预",
    );
    // 两次定向修复都会把上一份API正文带回供应商。按代码中的截断硬上限
    // 全额预留，而不是用一小段说明文字代替真实上下文，避免实扣超过hold。
    const repairContextReserve = "岗位修复上下文".padEnd(
      EMPLOYEE_REPAIR_CONTEXT_CHAR_LIMIT * (EMPLOYEE_PROVIDER_CALL_BUDGET - 1),
      "预",
    );
    const estimateInput = {
      outputTokens: perAttemptOutputTokens * EMPLOYEE_PROVIDER_CALL_BUDGET,
      texts: [
        ...perAttemptTexts,
        responseSchemaReserve,
        ...perAttemptTexts,
        responseSchemaReserve,
        ...perAttemptTexts,
        responseSchemaReserve,
        fixedPromptReserve,
        repairContextReserve,
      ],
    };
    const modelEstimates = holdModelPlan.models.map((model) => ({
      model,
      credits: estimateCreditsFn({ ...estimateInput, model }),
    }));
    const estimatedCredits = Math.max(
      ...modelEstimates.map((estimate) => Number(estimate.credits) || 0),
    );
    if (
      employeeConfig.maxCost != null &&
      estimatedCredits > Number(employeeConfig.maxCost)
    ) {
      throw Object.assign(
        new Error(
          `本次预估需${estimatedCredits}积分，超过该员工配置的单次积分上限${employeeConfig.maxCost}分；请缩短任务或由管理员调整上限`,
        ),
        { status: 400 },
      );
    }
    // 企业中央策略在派活时锁定，在途任务不随后续配置变化。
    // auto 下单纯 high 内部文本仍自动采用；外发、真实付费和不可逆
    // 动作的老板执行授权由领域动作入口另行强制。
    // 按分部/岗位例外在此刻解析为最终模式并写入快照（员工例外 > 分部例外 > 企业默认），
    // 下游审阅链只读 employeeOutput.mode，不再感知例外规则。
    const lockedApprovalRoutingPolicy = resolveEmployeeOutputPolicy(
      loadApprovalRoutingPolicy(curTenant()),
      {
        departmentCode: m.code,
        employeeIdx: selectedSpecialist?.employee_idx ?? null,
      },
    );
    // 先生成稳定业务 ID，再让 hold 在自己的原子事务里直接绑定该任务。
    // 即使进程恰好在两步之间退出，也只会留下无扣费的“生成中”任务，
    // 启动恢复会把它标失败；不会留下无法关联、永久冻结的积分。
    const taskResult = q.run(
      `INSERT INTO agent_tasks(
      marshal_id,specialist_id,title,type,requirement,status,is_collab,collab_marshals,due_at,created_by,
      employee_profile_version,employee_prompt_hash,employee_capabilities_snapshot,employee_config_snapshot,employee_skills_snapshot,
      employee_canonical_snapshot,employee_input_snapshot,approval_routing_policy_snapshot
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      m.id,
      specialist,
      taskTitle,
      taskType,
      taskRequirement,
      "生成中",
      collaborators.length ? 1 : 0,
      collaborators.join(","),
      dueDate,
      req.user.id,
      employeeExecution?.snapshot.profileVersion || null,
      employeeExecution?.snapshot.promptHash || null,
      employeeExecution
        ? JSON.stringify(employeeExecution.snapshot.capabilities)
        : null,
      employeeExecution
        ? JSON.stringify(employeeExecution.snapshot.config)
        : null,
      employeeExecution
        ? JSON.stringify(employeeExecution.snapshot.skills)
        : null,
      employeeExecution
        ? JSON.stringify(employeeExecution.snapshot.canonicalProfile)
        : null,
      taskImage || storedAttachmentRefs.length
        ? JSON.stringify({
            ...(taskImage?.metadata || {}),
            attachments: storedAttachmentRefs,
          })
        : null,
      JSON.stringify(lockedApprovalRoutingPolicy),
    );
    taskId = Number(taskResult.lastInsertRowid);
    try {
      hold = holdCredits({
        userId: req.user.id,
        feature: `员工任务·${m.name}`,
        kind: "text",
        model: holdModel,
        credits: estimatedCredits,
        refType: "agent_task",
        refId: taskId,
      });
    } catch (holdError) {
      q.run(
        `DELETE FROM agent_tasks
        WHERE tenant_id=? AND id=? AND status='生成中' AND output_id IS NULL`,
        curTenant(),
        taskId,
      );
      taskId = null;
      throw holdError;
    }
    const releaseAiLease =
      req.aiGuard?.defer?.(EMPLOYEE_TASK_WALL_CLOCK_LIMIT_MS + 60_000) ||
      (() => {});

    // 立即返回，AI生成转后台执行——用户可继续做其他工作
    res.json({
      taskId,
      status: "生成中",
      async: true,
      msg: "任务已派发，数字员工正在生成；可在统一任务中心查看执行步骤、进度、结果和费用",
      snapshot: employeeExecution
        ? {
            ...(INTERNAL_PROFILE_ROLES.has(req.user?.role)
              ? {
                  profileVersion: employeeExecution.snapshot.profileVersion,
                  promptHash: employeeExecution.snapshot.promptHash,
                  capabilityCount:
                    employeeExecution.snapshot.capabilities.length,
                  configVersion: employeeExecution.workbench.workConfig.version,
                }
              : {
                  redacted: internalProfileRedaction(),
                }),
            inputEvidence:
              taskImage || storedAttachmentRefs.length
                ? {
                    ...(taskImage?.metadata || {}),
                    attachments: storedAttachmentRefs,
                  }
                : null,
          }
        : null,
      ...(employeeExecution && INTERNAL_PROFILE_ROLES.has(req.user?.role)
        ? { executionSnapshot: employeeExecution.snapshot }
        : {}),
    });

    const userId = req.user.id,
      userRole = req.user.role,
      userName = req.user.name,
      tenantId = curTenant();
    const dataMode = tenantDataMode(tenantId);
    const employeeWebSearch = req.app?.locals?.employeeWebSearch;
    const employeeLocationIntelligence =
      req.app?.locals?.employeeLocationIntelligence;
    const employeeAgenticWebResearch =
      req.app?.locals?.employeeAgenticWebResearch;
    const employeeControlledWebFetch =
      req.app?.locals?.employeeControlledWebFetch;
    const employeeReviewDatasetImport =
      req.app?.locals?.employeeReviewDatasetImport;
    const employeeGenerate = req.app?.locals?.employeeGenerate;
    let employeeResearchWeb = null;
    let employeeReviewDatasetEvidence = null;
    // P0-1：契约档位在派活时按锁定模型与租户数据模式确定，并留底每一轮完整候选，
    // 任务墙钟超时时才能落“未达标草稿”而不是空白。
    const lockedContractTier = employeeExecution
      ? resolveContractTier({
          model: holdModel,
          dataMode,
          employeeIdx: employeeExecution.workbench?.identity?.idx,
        })
      : null;
    let lastObservedCandidate = null;
    const generationProgressHeartbeat = employeeExecution
      ? createEmployeeGenerationProgressHeartbeat({
          write: (snapshot) => {
            try {
              const result = q.run(
                `UPDATE agent_tasks SET employee_web_snapshot=?
                WHERE tenant_id=? AND id=? AND status='生成中' AND output_id IS NULL`,
                JSON.stringify({
                  ...snapshot,
                  ...(employeeResearchWeb ? { web: employeeResearchWeb } : {}),
                  ...(employeeReviewDatasetEvidence
                    ? {
                        reviewDatasetImport: employeeReviewDatasetEvidence,
                      }
                    : {}),
                }),
                tenantId,
                taskId,
              );
              return Number(result?.changes || 0) > 0;
            } catch {
              // 进度是非权威的可观测性提示；写入失败不能中断真实供应商生成。
              return false;
            }
          },
        })
      : null;
    setImmediate(() =>
      runWithTenant(tenantId, async () => {
        const taskAbortController = new AbortController();
        let taskDeadlineTimer = null;
        try {
          try {
            const delivered = await executeHeldDelivery({
              hold,
              generate: async () => {
                const taskDeadline = new Promise((_, reject) => {
                  taskDeadlineTimer = setTimeout(() => {
                    taskAbortController.abort();
                    reject(
                      Object.assign(
                        new Error(
                          "数字员工真实执行超过任务总时限，已终止调用并释放预授权",
                        ),
                        {
                          code: "EMPLOYEE_TASK_TIMEOUT",
                          status: 504,
                          retryable: true,
                          providerMode: null,
                          providerModel: null,
                          providerUsage: null,
                          web: employeeResearchWeb,
                          reviewDatasetImport: employeeReviewDatasetEvidence,
                        },
                      ),
                    );
                  }, EMPLOYEE_TASK_WALL_CLOCK_LIMIT_MS);
                  taskDeadlineTimer.unref?.();
                });
                let out;
                try {
                  out = await Promise.race([
                  marshalWork(
                    m,
                    {
                      title: taskTitle,
                      type: taskType,
                      requirement: taskRequirement,
                      // 截止时间不能只存数据库。岗位执行时也必须拿到同一时间约束，
                      // 否则输出中的排期与老板派活时设置的期限可能互相矛盾。
                      dueAt: dueDate,
                    },
                    userRole,
                    {
                      employeeExecution,
                      contractTier: lockedContractTier || undefined,
                      onCandidateObserved: (candidate) => {
                        lastObservedCandidate = candidate;
                      },
                      image: taskImage?.dataUrl || null,
                      attachments: files,
                      webSearchFn: employeeWebSearch,
                      locationIntelligenceFn: employeeLocationIntelligence,
                      agenticWebResearchFn: employeeAgenticWebResearch,
                      controlledWebFetchFn: employeeControlledWebFetch,
                      reviewDatasetImportFn: employeeReviewDatasetImport,
                      tenantId,
                      dataMode,
                      // HTTP 员工派活必须走完整公开调研链；测试或内部纯函数调用
                      // 若不经过此入口，不能冒充已经通过这道生产门。
                      requireAgenticResearch: Boolean(employeeExecution),
                      generateFn: employeeGenerate,
                      signal: taskAbortController.signal,
                      onReviewDatasetImportComplete: (importEvidence) => {
                        employeeReviewDatasetEvidence = importEvidence || null;
                        try {
                          q.run(
                            `UPDATE agent_tasks SET employee_web_snapshot=?
                          WHERE tenant_id=? AND id=? AND status='生成中' AND output_id IS NULL`,
                            JSON.stringify({
                              kind: EMPLOYEE_GENERATION_PROGRESS_KIND,
                              progress:
                                generationProgressHeartbeat?.snapshot?.() ||
                                null,
                              web: employeeResearchWeb,
                              reviewDatasetImport:
                                employeeReviewDatasetEvidence,
                              recordedAt: new Date().toISOString(),
                            }),
                            tenantId,
                            taskId,
                          );
                        } catch {
                          // 最终成功/失败收敛仍会落同一份脱敏证据。
                        }
                      },
                      onResearchComplete: (webEvidence) => {
                        employeeResearchWeb = webEvidence || null;
                        try {
                          q.run(
                            `UPDATE agent_tasks SET employee_web_snapshot=?
                          WHERE tenant_id=? AND id=? AND status='生成中' AND output_id IS NULL`,
                            JSON.stringify({
                              kind: EMPLOYEE_GENERATION_PROGRESS_KIND,
                              progress:
                                generationProgressHeartbeat?.snapshot?.() ||
                                null,
                              web: employeeResearchWeb,
                              ...(employeeReviewDatasetEvidence
                                ? {
                                    reviewDatasetImport:
                                      employeeReviewDatasetEvidence,
                                  }
                                : {}),
                              recordedAt: new Date().toISOString(),
                            }),
                            tenantId,
                            taskId,
                          );
                        } catch {
                          // 研究证据写入是可观测性增强；业务质量门仍由marshalWork执行。
                        }
                      },
                      onGenerationProgress:
                        generationProgressHeartbeat || undefined,
                      onExecutionProgress: (stage, details) =>
                        generationProgressHeartbeat?.stage?.(stage, details),
                    },
                  ),
                  taskDeadline,
                ]);
                } catch (generationError) {
                  // P0-1 失败不交白卷：非安全类契约失败或任务墙钟超时，只要拿到过
                  // 一轮完整正文且有真实用量，就转成“未达标草稿”交付；安全类失败与
                  // 无正文/无用量的失败原样抛出，继续走 executeHeldDelivery 的释放路径。
                  const draft = employeeExecution
                    ? employeeDraftFromFailure(generationError, {
                        lastObservedCandidate,
                        contractTier: lockedContractTier,
                      })
                    : null;
                  if (!draft) throw generationError;
                  out = employeeDraftOutput(draft, generationError, {
                    web: employeeResearchWeb,
                    kb: null,
                    reviewDatasetImport: employeeReviewDatasetEvidence,
                  });
                }
                if (taskDeadlineTimer) {
                  clearTimeout(taskDeadlineTimer);
                  taskDeadlineTimer = null;
                }
                if (out?.employeeDraft) {
                  // 草稿不过最终硬门与契约门（它本来就没通过），直接进入落库与结算。
                  return out;
                }
                if (out?.mode !== "api") {
                  throw Object.assign(
                    new Error(
                      "真实 AI 通道未形成可验收业务结果；模板底稿已阻断，本次任务失败并全额释放预授权",
                    ),
                    {
                      code: "EMPLOYEE_TEMPLATE_ONLY",
                      status: 503,
                      // 模板底稿不是真实模型正文：没有可留底的草稿
                      draftBlockedBy: "not_api",
                      providerMode: out?.mode || null,
                      providerModel: out?.model || null,
                      providerUsage: out?.usage || null,
                      providerRetry:
                        out?.employeeContract?.generationRetry || null,
                      providerAttempts:
                        out?.employeeContract?.providerAttempts || [],
                      providerBudget:
                        out?.employeeContract?.providerBudget || null,
                      web: out?.web || null,
                    },
                  );
                }
                const hardDelivery = restaurantEmployeeHardDeliveryDecision({
                  text: out?.text,
                  mode: out?.mode,
                  model: out?.model,
                  usage: out?.usage,
                  internalProfileLeakage: out?.internalProfileLeakage,
                  task: {
                    title: taskTitle,
                    type: taskType,
                    requirement: taskRequirement,
                  },
                  allowedSources: out?.web?.results || [],
                });
                if (!hardDelivery.valid) {
                  throw Object.assign(
                    new Error(
                      `数字员工最终交付硬门未通过：${hardDelivery.errors.join("；")}`,
                    ),
                    {
                      code: "RESTAURANT_OUTPUT_HARD_GATE_FAILED",
                      status: 422,
                      hardDelivery,
                      providerMode: out?.mode || null,
                      providerModel: out?.model || null,
                      providerUsage: out?.usage || null,
                      web: out?.web || null,
                    },
                  );
                }
                out.hardDelivery = hardDelivery;
                if (
                  employeeExecution &&
                  out?.employeeContract?.valid !== true &&
                  !(
                    dataMode === "demo" &&
                    out?.mode === "api" &&
                    String(out?.text || "").trim() &&
                    out?.internalProfileLeakage?.detected !== true
                  )
                ) {
                  throw Object.assign(
                    new Error(
                      "数字员工输出未通过岗位质检；本次未形成可用业务结果，已进入失败收敛并释放预授权",
                    ),
                    {
                      code: "RESTAURANT_OUTPUT_QUALITY_FAILED",
                      status: 422,
                      contractErrors: out?.employeeContract?.blocked
                        ? [out.employeeContract.blocked]
                        : [],
                      contractRepair: out?.employeeContract?.repair || null,
                      providerRetry:
                        out?.employeeContract?.generationRetry || null,
                      providerAttempts:
                        out?.employeeContract?.providerAttempts || [],
                      providerBudget:
                        out?.employeeContract?.providerBudget || null,
                      internalProfileLeakage:
                        out?.internalProfileLeakage || null,
                      providerMode: out?.mode || null,
                      providerModel: out?.model || null,
                      providerUsage: out?.usage || null,
                      web: out?.web || null,
                    },
                  );
                }
                return out;
              },
              persist: (out) => {
                generationProgressHeartbeat?.stage?.("persist", {
                  status: "active",
                });
                return withImmediateTransaction(db, () => {
                  const risk = applyRiskControl({
                    type: taskType,
                    title: taskTitle,
                    body: out.text,
                  });
                  if (out.employeeDraft) {
                    // P0-1：未达标草稿。正文原样入库、不进审批、不自动采用、不导出正式产物；
                    // agent_tasks 置“草稿待处理”，失败原因与机器校验报告随任务落库。
                    const draftContent = q.run(
                      `INSERT INTO contents(type,title,body,topic,status,risk_flags,risk_level,ai_mode,creator_id,marshal_id,snapshot_json)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
                      "员工产出",
                      `${m.name}：${taskTitle}`,
                      out.text,
                      taskTitle,
                      CONTENT_DRAFT_STATUS,
                      JSON.stringify(risk.hits),
                      risk.level,
                      out.mode,
                      userId,
                      m.id,
                      JSON.stringify({
                        schemaVersion: "restaurant-employee-draft.v1",
                        employeeDraft: out.employeeDraft,
                        contract: {
                          status: "draft",
                          valid: false,
                          errors: (out.employeeContract?.errors || []).slice(0, 20),
                        },
                      }),
                    );
                    const draftContentId = Number(draftContent.lastInsertRowid);
                    recordKbCitations({
                      targetType: "content",
                      targetId: draftContentId,
                      kb: out.kb,
                    });
                    const draftEvidence = {
                      kind: "restaurant_employee_execution_evidence",
                      generationProgress:
                        generationProgressHeartbeat?.snapshot?.() || null,
                      web: out.web || null,
                      ...(out.reviewDatasetImport
                        ? { reviewDatasetImport: out.reviewDatasetImport }
                        : {}),
                      outputContract: {
                        ...employeeContractAudit(out),
                        draft: true,
                        errors: (out.employeeContract?.errors || []).slice(0, 40),
                      },
                      providerAttempt: {
                        mode: out.mode || null,
                        model: out.model || null,
                        requestedModel: out.requestedModel || out.model || null,
                        effectiveModel: out.effectiveModel || out.model || null,
                        modelFailover: out.modelFailover || null,
                        usage: {
                          inputTokens: Number(out.usage?.inputTokens || 0),
                          outputTokens: Number(out.usage?.outputTokens || 0),
                        },
                      },
                      internalProfileLeakage: out.internalProfileLeakage || null,
                      draft: out.employeeDraft,
                      failure: {
                        code: out.employeeDraft.failureCode,
                        category: "quality_rework",
                        presentationKey: "draft_pending",
                        phase: out.employeeDraft.failReason === "timeout" ? "timeout" : "quality",
                        retryable: true,
                        message: out.employeeDraft.failureMessage,
                      },
                    };
                    q.run(
                      `UPDATE agent_tasks
              SET status = ?, output_id = ?, employee_web_snapshot = ?, contract_tier = ?, fail_reason = ?, contract_report = ?
              WHERE id = ?`,
                      AGENT_TASK_DRAFT_STATUS,
                      draftContentId,
                      JSON.stringify(draftEvidence),
                      out.employeeDraft.report?.contractTier || lockedContractTier,
                      out.employeeDraft.failReason,
                      JSON.stringify(out.employeeDraft.report),
                      taskId,
                    );
                    return {
                      contentId: draftContentId,
                      risk,
                      approvalMode: "draft_pending",
                      requiresReview: false,
                      autoAdopt: false,
                      draft: true,
                      approvalReason: "quality_gate_failed_draft_kept",
                    };
                  }
                  const configuredApproval =
                    employeeExecution?.workbench?.workConfig?.approvalMode ||
                    "auto_draft";
                  const approvalPolicy = resolveContentApprovalPolicy(
                    configuredApproval,
                    risk,
                  );
                  const approvalRoute = resolveApprovalRoute({
                    targetType: "content",
                    riskLevel: risk.level,
                    requestedLevel: approvalPolicy.approvalLevel,
                    actorRole: userRole,
                    actorUserId: userId,
                    policy: lockedApprovalRoutingPolicy,
                  });
                  const demoInternalAutoAdopt =
                    dataMode === "demo" &&
                    risk.level !== "high" &&
                    approvalRoute.executionAuthorizationRequired !== true;
                  const effectiveApprovalRoute = demoInternalAutoAdopt
                    ? {
                        ...approvalRoute,
                        requiresReview: false,
                        autoAdopt: true,
                        reason: "demo_internal_report_auto_adopt",
                      }
                    : approvalRoute;
                  const requiresReview =
                    effectiveApprovalRoute.requiresReview !== false;
                  // 免审结果先以草稿/生成中落业务主产物，待真实用量完成结算后再由
                  // 权威自动采纳命令收敛为“可使用/已完成”；不能在积分仍悬挂时提前可用。
                  const contentResult = q.run(
                    `INSERT INTO contents(type,title,body,topic,status,risk_flags,risk_level,ai_mode,creator_id,marshal_id)
              VALUES(?,?,?,?,?,?,?,?,?,?)`,
                    "员工产出",
                    `${m.name}：${taskTitle}`,
                    out.text,
                    taskTitle,
                    requiresReview ? "待审核" : "草稿",
                    JSON.stringify(risk.hits),
                    risk.level,
                    out.mode,
                    userId,
                    m.id,
                  );
                  const contentId = Number(contentResult.lastInsertRowid);
                  if (out.internalProfileLeakage?.detected) {
                    q.run(
                      `UPDATE contents SET snapshot_json=? WHERE tenant_id=? AND id=?`,
                      JSON.stringify({
                        schemaVersion: "restaurant-employee-output-security.v1",
                        internalProfileLeakage: out.internalProfileLeakage,
                      }),
                      curTenant(),
                      contentId,
                    );
                  }
                  recordKbCitations({
                    targetType: "content",
                    targetId: contentId,
                    kb: out.kb,
                  }); // AI-C2 引用溯源
                  const executionEvidence = employeeExecution
                    ? {
                        kind: "restaurant_employee_execution_evidence",
                        generationProgress:
                          generationProgressHeartbeat?.snapshot?.() || null,
                        web: out.web || null,
                        ...(out.reviewDatasetImport
                          ? {
                              reviewDatasetImport: out.reviewDatasetImport,
                            }
                          : {}),
                        outputContract: employeeContractAudit(out),
                        // 结算失败时，管理员只能依据本次已经落库的供应商证据对账。
                        // 不保存模型与真实用量会让 hold 永久只能“看见”，无法安全结算。
                        providerAttempt: {
                          mode: out.mode || null,
                          model: out.model || null,
                          requestedModel:
                            out.requestedModel ||
                            out.employeeContract?.requestedModel ||
                            out.model ||
                            null,
                          effectiveModel:
                            out.effectiveModel ||
                            out.employeeContract?.effectiveModel ||
                            out.model ||
                            null,
                          modelFailover:
                            out.modelFailover ||
                            out.employeeContract?.modelFailover ||
                            null,
                          usage: {
                            inputTokens: Number(out.usage?.inputTokens || 0),
                            outputTokens: Number(out.usage?.outputTokens || 0),
                          },
                        },
                        internalProfileLeakage:
                          out.internalProfileLeakage || null,
                      }
                    : out.web || null;
                  q.run(
                    `UPDATE agent_tasks
              SET status = ?, output_id = ?, employee_web_snapshot = ?, contract_tier = ?
              WHERE id = ?`,
                    requiresReview ? "待审阅" : "生成中",
                    contentId,
                    JSON.stringify(executionEvidence),
                    out.employeeContract?.contractTier || lockedContractTier,
                    taskId,
                  );
                  // 巡店督导（#161）：解析产出末尾的 nanowork-inspection 归档块并写入巡店统计；
                  // 解析失败只记日志，不影响任务交付，也不伪造巡店数据。
                  if (
                    employeeExecution?.workbench?.identity?.idx ===
                    INSPECTION_EMPLOYEE_IDX
                  ) {
                    const inspection = recordInspectionFromTask({
                      tenantId: curTenant(),
                      taskId,
                      contentId,
                      userId,
                      userName:
                        q.get("SELECT name FROM users WHERE id=?", userId)
                          ?.name || "",
                      text: out.text,
                    });
                    if (!inspection.recorded) {
                      console.warn(
                        `[inspection] 任务${taskId}未归档：${inspection.reason}`,
                      );
                    }
                  }
                  if (requiresReview) {
                    createApproval({
                      targetType: "content",
                      targetId: contentId,
                      title: `${m.name}：${taskTitle}`,
                      summary: out.internalProfileLeakage?.detected
                        ? internalProfileLeakageNotice()
                        : out.text,
                      riskLevel: risk.level,
                      rulesHit: [
                        ...approvalPolicy.rulesHit,
                        "employee_output_review",
                        ...(out.internalProfileLeakage?.detected
                          ? ["employee_internal_profile_leakage"]
                          : []),
                        `employee_approval:${configuredApproval}`,
                        `owner_policy:${approvalRoute.mode}`,
                      ],
                      submitterId: userId,
                      approvalLevel: approvalRoute.firstStep.level,
                      assignedReviewerId:
                        approvalRoute.firstStep.assignedReviewerId,
                      approvalPolicySnapshot: approvalRoute.snapshot,
                    });
                  }
                  return {
                    contentId,
                    risk,
                    approvalMode: configuredApproval,
                    requiresReview,
                    autoAdopt: effectiveApprovalRoute.autoAdopt === true,
                    approvalReason: effectiveApprovalRoute.reason,
                  };
                });
              },
              settle: settleHold,
              release: releaseHold,
              settlement: (out) => {
                const inputTokens = Number(out.usage?.inputTokens);
                const outputTokens = Number(out.usage?.outputTokens);
                if (
                  out.mode === "api" &&
                  (!Number.isFinite(inputTokens) ||
                    !Number.isFinite(outputTokens) ||
                    inputTokens < 0 ||
                    outputTokens < 0 ||
                    inputTokens + outputTokens <= 0)
                ) {
                  throw Object.assign(
                    new Error(
                      `员工任务#${taskId}真实API产出缺少可核验用量，已保留占扣并转待账务对账`,
                    ),
                    {
                      code: "EMPLOYEE_PROVIDER_USAGE_MISSING",
                      retryable: false,
                    },
                  );
                }
                const actualModel =
                  out.effectiveModel ||
                  out.employeeContract?.effectiveModel ||
                  out.model;
                const actualCredits = estimateCallCredits({
                  model: actualModel,
                  texts: [],
                  outputTokens,
                  overheadTokens: inputTokens,
                });
                if (actualCredits > Number(hold.credits || 0)) {
                  throw Object.assign(
                    new Error(
                      `员工任务#${taskId}实际用量超过预授权上限，已保留占扣并转待账务对账`,
                    ),
                    { code: "EMPLOYEE_HOLD_UNDERESTIMATED" },
                  );
                }
                return {
                  usage: out.usage,
                  model: actualModel,
                  aiMode: out.mode,
                  note: `员工任务#${taskId}产出、审批与任务状态已原子落库`,
                };
              },
              releaseNote: `员工任务#${taskId}生成或业务落库失败，预授权全额退回`,
            });
            const billingText =
              delivered.billing.state === "settled"
                ? `消耗${delivered.billing.chargedCredits}积分`
                : "积分结算待账务对账";
            if (delivered.delivery.draft) {
              // 未达标草稿：不自动采用、不进审批；通知老板去处理（重新派活或就用这份草稿）。
              const draftLink = selectedSpecialist
                ? `/employees?employee=${selectedSpecialist.employee_idx}&task=${taskId}`
                : "/employees";
              publishRestaurantTaskStatusChanged(tenantId, taskId, {
                userId,
                employeeIdx: selectedSpecialist?.employee_idx,
                title: taskTitle,
                status: AGENT_TASK_DRAFT_STATUS,
              });
              try {
                notify(
                  userId,
                  "marshal",
                  `${m.name}任务「${taskTitle}」已保留未达标草稿`,
                  `${delivered.output?.employeeDraft?.failReason === "timeout" ? "执行超时" : "质量门未通过"}，已保留草稿待你处理（${billingText}）`,
                  draftLink,
                );
              } catch (notificationError) {
                console.error(
                  `[marshal] 任务#${taskId}草稿已保留，但通知发送失败:`,
                  notificationError?.message || notificationError,
                );
              }
              try {
                logOp(
                  { id: userId, name: userName },
                  "餐饮数字员工",
                  "派发任务",
                  `${m.name}:${taskTitle}`,
                );
              } catch {
                /* task result is already durable */
              }
              return;
            }
            let autoAdoption = null;
            if (delivered.delivery.autoAdopt) {
              if (delivered.billing.state === "settled") {
                autoAdoption = autoAdoptContentOutput({
                  outputId: delivered.delivery.contentId,
                  taskId,
                  tenantId,
                  policyReason: delivered.delivery.approvalReason,
                  actorRole: userRole,
                  actorUserId: userId,
                });
              } else {
                // 产物与真实调用证据已保留，但账务没有终态时不能自动变成可用，
                // 也不能伪造一张需要人审内容的审批单。
                q.run(
                  `UPDATE agent_tasks SET status='失败'
                  WHERE tenant_id=? AND id=? AND status='生成中'`,
                  tenantId,
                  taskId,
                );
              }
            }
            const taskLink = selectedSpecialist
              ? `/employees?employee=${selectedSpecialist.employee_idx}&task=${taskId}`
              : "/employees";
            publishRestaurantTaskStatusChanged(tenantId, taskId, {
              userId,
              employeeIdx: selectedSpecialist?.employee_idx,
              title: taskTitle,
            });
            try {
              notifyRestaurantTaskReady({
                creatorId: userId,
                employeeName: selectedSpecialist?.name || m.name,
                taskTitle,
                taskLink,
                billingText,
                approvalMode: delivered.delivery.approvalMode,
                riskLevel: delivered.delivery.risk?.level,
                dataMode,
                autoAdopted: autoAdoption?.autoAdopted === true,
              });
            } catch (notificationError) {
              console.error(
                `[marshal] 任务#${taskId}已交付，但结果通知发送失败:`,
                notificationError?.message || notificationError,
              );
            }
          } catch (e) {
            // executeHeldDelivery 已负责释放预授权；这里只记录业务失败状态，避免二次退款。
            generationProgressHeartbeat?.stage?.("error", {
              status: "error",
            });
            const failureDisposition = employeeFailureDisposition(e);
            let persistedEvidence = null;
            let persistedWeb = null;
            let persistedProgress = null;
            let persistedReviewDataset = null;
            try {
              const rawEvidence = q.get(
                `SELECT employee_web_snapshot FROM agent_tasks WHERE tenant_id=? AND id=?`,
                tenantId,
                taskId,
              )?.employee_web_snapshot;
              const parsedEvidence = rawEvidence
                ? JSON.parse(rawEvidence)
                : null;
              if (
                parsedEvidence?.kind ===
                "restaurant_employee_execution_evidence"
              ) {
                persistedEvidence = parsedEvidence;
              }
              persistedWeb = parsedEvidence?.web || null;
              persistedReviewDataset =
                parsedEvidence?.reviewDatasetImport || null;
              persistedProgress =
                generationProgressFromSnapshot(parsedEvidence);
            } catch {
              // 损坏的旧观测字段不影响失败收敛；下方仍会保存本次可用证据。
            }
            const failureEvidence = employeeExecution
              ? {
                  ...(persistedEvidence || {}),
                  kind: "restaurant_employee_execution_evidence",
                  web:
                    e.web ||
                    persistedEvidence?.web ||
                    persistedWeb ||
                    employeeResearchWeb ||
                    null,
                  ...(e.reviewDatasetImport ||
                  persistedEvidence?.reviewDatasetImport ||
                  persistedReviewDataset ||
                  employeeReviewDatasetEvidence
                    ? {
                        reviewDatasetImport:
                          e.reviewDatasetImport ||
                          persistedEvidence?.reviewDatasetImport ||
                          persistedReviewDataset ||
                          employeeReviewDatasetEvidence,
                      }
                    : {}),
                  generationProgress: persistedProgress || null,
                  outputContract: persistedEvidence?.outputContract || {
                    // 只有已取得候选且契约/泄漏质检失败才是 contract invalid。
                    // 超时、通道、持久化等执行异常没有合法候选，必须保持未验证语义。
                    valid: failureDisposition.qualityRework ? false : null,
                    requestedModel: failureDisposition.requestedModel,
                    effectiveModel: failureDisposition.effectiveModel,
                    modelFailover: failureDisposition.modelFailover,
                    skipped: failureDisposition.contractSkipped,
                    blocked: failureDisposition.qualityRework
                      ? failureDisposition.code
                      : null,
                    errors: failureDisposition.qualityRework
                      ? failureDisposition.contractErrors.length
                        ? failureDisposition.contractErrors
                        : [String(e.message || "岗位质检失败").slice(0, 300)]
                      : [],
                    repair: e.contractRepair || null,
                    generationRetry: e.providerRetry || null,
                    providerAttempts: failureDisposition.providerAttempts,
                    providerBudget: failureDisposition.providerBudget,
                    contractId:
                      employeeExecution.outputContract?.contractId || null,
                    schemaVersion:
                      employeeExecution.outputContract?.schemaVersion || null,
                    primaryArtifact:
                      employeeExecution.outputContract?.primaryArtifact || null,
                    artifacts: [],
                  },
                  internalProfileLeakage:
                    persistedEvidence?.internalProfileLeakage ||
                    e.internalProfileLeakage ||
                    null,
                  providerAttempt: persistedEvidence?.providerAttempt || {
                    mode: e.providerMode || null,
                    model:
                      e.providerModel || failureDisposition.effectiveModel,
                    requestedModel: failureDisposition.requestedModel,
                    effectiveModel: failureDisposition.effectiveModel,
                    modelFailover: failureDisposition.modelFailover,
                    usage: {
                      inputTokens: Number(e.providerUsage?.inputTokens || 0),
                      outputTokens: Number(e.providerUsage?.outputTokens || 0),
                    },
                  },
                  failure: {
                    code: failureDisposition.code,
                    category: failureDisposition.category,
                    presentationKey: failureDisposition.presentationKey,
                    phase: failureDisposition.phase,
                    retryable: failureDisposition.retryable,
                    message: String(e.message || "生成失败").slice(0, 300),
                    // P0-1：为什么没有保留“未达标草稿”（safety / no_text / not_api /
                    // no_deliverable / no_usage / incomplete）；无候选的执行异常为 null。
                    draftBlockedBy:
                      typeof e.draftBlockedBy === "string" ? e.draftBlockedBy : null,
                  },
                }
              : null;
            q.run(
              `UPDATE agent_tasks SET status = '失败', employee_web_snapshot=? WHERE id = ?`,
              failureEvidence ? JSON.stringify(failureEvidence) : null,
              taskId,
            );
            publishRestaurantTaskStatusChanged(tenantId, taskId, {
              userId,
              employeeIdx: selectedSpecialist?.employee_idx,
              title: taskTitle,
              status: "失败",
            });
            const billingText =
              e.billing?.state === "released"
                ? "预扣积分已退回"
                : "预授权状态待人工对账";
            const taskLink = selectedSpecialist
              ? `/employees?employee=${selectedSpecialist.employee_idx}&task=${taskId}`
              : "/employees";
            notify(
              userId,
              "marshal",
              `${m.name}任务「${taskTitle}」生成失败`,
              `${String(e.message).slice(0, 100)}（${billingText}）`,
              taskLink,
            );
          }
          try {
            logOp(
              { id: userId, name: userName },
              "餐饮数字员工",
              "派发任务",
              `${m.name}:${taskTitle}`,
            );
          } catch {
            /* task result is already durable */
          }
        } finally {
          if (taskDeadlineTimer) clearTimeout(taskDeadlineTimer);
          taskAbortController.abort();
          releaseAiLease();
        }
      }),
    );
  } catch (e) {
    // 派发在响应前失败（含占扣后建任务失败）：全额退回占扣；已进入后台的 hold 由后台结算，不会走到这里
    if (hold && !res.headersSent) {
      try {
        releaseHold(
          hold,
          `任务派发失败（${String(e?.message || "").slice(0, 60)}），预授权全额退回`,
        );
      } catch {
        /* 释放失败留待人工对账 */
      }
    }
    if (taskId && !res.headersSent) {
      q.run(
        `UPDATE agent_tasks SET status='失败'
        WHERE tenant_id=? AND id=? AND status='生成中' AND output_id IS NULL`,
        curTenant(),
        taskId,
      );
      publishRestaurantTaskStatusChanged(curTenant(), taskId, { userId: req.user?.id });
    }
    res.status(e.status || 500).json({ error: e.message });
  }
}

r.post("/:id/tasks", dispatchMarshalTask);

const RESTAURANT_AUTO_ADOPTED_LABEL = "已自动采用（可用于业务）";

function restaurantTaskProgress(status, adoptionKind = null) {
  switch (status) {
    case "生成中":
      return {
        flow: ["已派发", "AI生成中", "质量与账务门禁", "交付完成"],
        stepIndex: 1,
        failed: false,
        nextAction: "等待数字员工生成报告并完成质量与账务门禁",
      };
    case "待审阅":
      return {
        flow: [
          "已派发",
          "AI生成完成",
          BUSINESS_DELIVERY_LABELS.reviewPending,
          BUSINESS_DELIVERY_LABELS.adopted,
        ],
        stepIndex: 2,
        failed: false,
        nextAction: "由老板或有审阅权限的管理人员人工采纳，或给出明确返工意见",
      };
    case "待账务对账":
      return {
        flow: [
          "已派发",
          "AI生成完成",
          BUSINESS_DELIVERY_LABELS.businessBlocked,
          "完成对账后进入交付",
        ],
        stepIndex: 2,
        failed: false,
        canReview: false,
        nextAction: "完成账务对账后再按任务锁定策略进入自动采用或人工审阅",
      };
    case "已完成":
      if (adoptionKind === "human") {
        return {
          flow: [
            "已派发",
            "AI生成完成",
            "人工审阅已通过",
            BUSINESS_DELIVERY_LABELS.adopted,
          ],
          stepIndex: 3,
          failed: false,
          nextAction: "可在内容资产或业务流中继续查看已人工采纳的产物",
        };
      }
      return {
        flow: [
          "已派发",
          "AI生成完成",
          "质量与账务门禁已通过",
          RESTAURANT_AUTO_ADOPTED_LABEL,
        ],
        stepIndex: 3,
        failed: false,
        nextAction:
          "可在员工对话、任务中心或交付文件中继续查看已自动采用的内部产物",
      };
    case "已驳回":
      return {
        flow: ["已派发", "AI生成完成", BUSINESS_DELIVERY_LABELS.reviewRejected],
        stepIndex: 2,
        failed: false,
        nextAction: "根据驳回意见补充材料后重新派活",
      };
    case "失败":
      return {
        flow: ["已派发", BUSINESS_DELIVERY_LABELS.executionFailed],
        stepIndex: 1,
        failed: true,
        nextAction: "先查看失败原因，再检查输入、额度和模型通道后重新派活",
      };
    case "质检失败":
      return {
        flow: ["已派发", "AI生成完成", BUSINESS_DELIVERY_LABELS.qualityFailed],
        stepIndex: 2,
        failed: true,
        nextAction: "查看岗位质检错误，补充或修正材料后重新派活",
      };
    case "已取代":
      return {
        flow: ["已派发", "原报告已留档", BUSINESS_DELIVERY_LABELS.superseded],
        stepIndex: 2,
        failed: false,
        nextAction: "查看并使用安全修订任务的报告与交付文件",
      };
    case AGENT_TASK_DRAFT_STATUS:
      return {
        flow: [
          "已派发",
          "AI生成完成",
          "质量门未通过（已保留草稿）",
          "待老板处理",
        ],
        stepIndex: 2,
        failed: false,
        draftFlow: true,
        nextAction:
          "先看未通过的检查，再选择“带原要求重新派活”或“就用这份草稿”",
      };
    case "草稿已接受":
      return {
        flow: [
          "已派发",
          "AI生成完成",
          "质量门未通过（已保留草稿）",
          BUSINESS_DELIVERY_LABELS.draftAccepted,
        ],
        stepIndex: 3,
        failed: false,
        draftFlow: true,
        nextAction: "该稿仅作内部参考；需要正式采用请重新派活生成合格版本",
      };
    default:
      return {
        flow: ["已派发", status || "待处理"],
        stepIndex: 1,
        failed: false,
        nextAction: "刷新任务状态或联系管理员检查执行记录",
      };
  }
}

// 安全修订采用只追加关系：不改写旧任务/正文/文件，只让旧产物退出业务
// 使用面。服务层会在同一事务内完成替代关系、知识禁用和资产归档。
r.post("/tasks/:taskId/supersede", (req, res) => {
  try {
    const supersession = createAgentTaskSupersession({
      tenantId: curTenant(),
      supersededTaskId: req.params.taskId,
      replacementTaskId: req.body?.replacementTaskId,
      reason: req.body?.reason,
      actor: req.user,
    });
    if (supersession.created) {
      logOp(
        req.user,
        "餐饮数字员工",
        "安全修订取代旧任务",
        `task#${req.params.taskId} -> task#${supersession.taskId}`,
      );
    }
    return res.status(supersession.created ? 201 : 200).json({
      supersession,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
});

// P0-1“就用这份草稿”：老板/管理员把未达标草稿接受为内部参考稿。
// - 不放松质量门：草稿不会变成“已自动采用/可用于业务”，也不沉淀知识库、不导出正式产物；
// - 含来源类硬错（补造来源）的草稿不可接受，只能带原要求重新派活；
// - 按任务锁定的审批策略：要求审阅则进审批队列（contents=待审核/agent_tasks=待审阅），
//   否则任务转为终态“草稿已接受”；两条路径都记 op_logs 与审批快照。
r.post("/tasks/:taskId/accept-draft", (req, res) => {
  if (!["boss", "admin"].includes(req.user?.role)) {
    return res.status(403).json({ error: "只有老板或管理员可以决定就用这份草稿" });
  }
  const taskId = Number(req.params.taskId);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    return res.status(400).json({ error: "任务编号无效" });
  }
  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  const tenantId = curTenant();
  try {
    const result = withImmediateTransaction(db, () => {
      const task = q.get(
        `SELECT t.*, s.employee_idx FROM agent_tasks t
         LEFT JOIN specialists s ON s.id=t.specialist_id
         WHERE t.tenant_id=? AND t.id=?`,
        tenantId,
        taskId,
      );
      if (!task || !canAccessOwner(req.user, task.created_by)) {
        throw Object.assign(new Error("任务不存在或无权处理"), { status: 404 });
      }
      if (task.status !== AGENT_TASK_DRAFT_STATUS || !Number(task.output_id)) {
        throw Object.assign(
          new Error("当前任务没有待处理的未达标草稿"),
          { status: 409, code: "DRAFT_NOT_PENDING" },
        );
      }
      if (loadAgentTaskSupersession(taskId, { tenantId })) {
        throw Object.assign(
          new Error("该任务已由安全修订任务取代，草稿不能再被接受"),
          { status: 409, code: "DRAFT_SUPERSEDED" },
        );
      }
      const content = q.get(
        `SELECT * FROM contents WHERE tenant_id=? AND id=?`,
        tenantId,
        task.output_id,
      );
      if (!content || content.status !== CONTENT_DRAFT_STATUS) {
        throw Object.assign(
          new Error("草稿产物不存在或状态已变化"),
          { status: 409, code: "DRAFT_CONTENT_MISMATCH" },
        );
      }
      let report = null;
      try {
        report = task.contract_report ? JSON.parse(task.contract_report) : null;
      } catch {
        report = null;
      }
      if (report?.acceptable !== true) {
        throw Object.assign(
          new Error("草稿引用了本次未核验的来源，不能直接采用；请带原要求重新派活"),
          { status: 409, code: "DRAFT_NOT_ACCEPTABLE" },
        );
      }
      let configuredApproval = "auto_draft";
      try {
        const config = task.employee_config_snapshot
          ? JSON.parse(task.employee_config_snapshot)
          : null;
        if (typeof config?.approvalMode === "string" && config.approvalMode) {
          configuredApproval = config.approvalMode;
        }
      } catch {
        /* 配置快照损坏时按默认策略处理 */
      }
      let riskHits = [];
      try {
        riskHits = JSON.parse(content.risk_flags || "[]");
      } catch {
        riskHits = [];
      }
      const risk = {
        level: content.risk_level || "none",
        hits: Array.isArray(riskHits) ? riskHits : [],
        needsApproval: (content.risk_level || "none") !== "none",
      };
      const approvalPolicy = resolveContentApprovalPolicy(configuredApproval, risk);
      let lockedPolicy = null;
      try {
        lockedPolicy = task.approval_routing_policy_snapshot
          ? JSON.parse(task.approval_routing_policy_snapshot)
          : null;
      } catch {
        lockedPolicy = null;
      }
      const approvalRoute = resolveApprovalRoute({
        targetType: "content",
        riskLevel: risk.level,
        requestedLevel: approvalPolicy.approvalLevel,
        actorRole: req.user.role,
        actorUserId: req.user.id,
        policy: lockedPolicy || loadApprovalRoutingPolicy(tenantId),
      });
      // 风控词命中在任何档位都是硬门：有风控命中的草稿一律进人工审阅。
      const requiresReview =
        approvalRoute.requiresReview !== false || risk.level !== "none";
      const acceptedAt = new Date().toISOString();
      const acceptance = {
        acceptedAt,
        acceptedBy: req.user.id,
        acceptedByName: req.user.name || null,
        acceptedByRole: req.user.role,
        reason: reason || null,
        requiresReview,
        contractTier: report?.contractTier || task.contract_tier || null,
        failReason: task.fail_reason || report?.failReason || "contract",
        failedChecks: report?.failedChecks || [],
        approvalRouting: approvalRoute.snapshot || null,
        note: "老板接受未达标草稿为内部参考稿；未通过质量门，不得自动采用、不沉淀知识库、不导出正式产物。",
      };
      let contentSnapshot = {};
      try {
        contentSnapshot = content.snapshot_json ? JSON.parse(content.snapshot_json) : {};
      } catch {
        contentSnapshot = {};
      }
      const nextContentStatus = requiresReview ? "待审核" : "草稿";
      const nextTaskStatus = requiresReview ? "待审阅" : "草稿已接受";
      q.run(
        `UPDATE contents SET status=?, snapshot_json=? WHERE tenant_id=? AND id=?`,
        nextContentStatus,
        JSON.stringify({ ...contentSnapshot, draftAcceptance: acceptance }),
        tenantId,
        content.id,
      );
      let evidence = null;
      try {
        evidence = task.employee_web_snapshot ? JSON.parse(task.employee_web_snapshot) : null;
      } catch {
        evidence = null;
      }
      if (evidence && typeof evidence === "object") {
        evidence.draftAcceptance = acceptance;
        if (evidence.outputContract && typeof evidence.outputContract === "object") {
          evidence.outputContract.draftAccepted = true;
        }
        if (evidence.failure && typeof evidence.failure === "object") {
          evidence.failure.presentationKey = "draft_accepted";
        }
      }
      q.run(
        `UPDATE agent_tasks SET status=?, employee_web_snapshot=? WHERE tenant_id=? AND id=?`,
        nextTaskStatus,
        evidence ? JSON.stringify(evidence) : task.employee_web_snapshot,
        tenantId,
        taskId,
      );
      let approvalId = null;
      if (requiresReview) {
        const approval = createApproval({
          targetType: "content",
          targetId: content.id,
          title: content.title,
          summary: content.body,
          riskLevel: risk.level,
          rulesHit: [
            ...(approvalPolicy.rulesHit || []),
            "employee_output_review",
            "employee_draft_accepted",
            `employee_approval:${configuredApproval}`,
            `owner_policy:${approvalRoute.mode}`,
          ],
          submitterId: req.user.id,
          approvalLevel: approvalRoute.firstStep?.level,
          assignedReviewerId: approvalRoute.firstStep?.assignedReviewerId,
          approvalPolicySnapshot: approvalRoute.snapshot,
        });
        approvalId = Number(approval) || null;
      }
      return {
        taskId,
        contentId: Number(content.id),
        requiresReview,
        approvalId,
        status: nextTaskStatus,
        contentStatus: nextContentStatus,
        displayStatus: requiresReview
          ? BUSINESS_DELIVERY_LABELS.reviewPending
          : BUSINESS_DELIVERY_LABELS.draftAccepted,
        acceptance,
      };
    });
    logOp(
      req.user,
      "餐饮数字员工",
      "接受未达标草稿",
      `task#${taskId} -> content#${result.contentId}${result.requiresReview ? "（进人工审阅）" : "（内部参考稿）"}`,
    );
    publishRestaurantTaskStatusChanged(tenantId, taskId, {
      userId: req.user.id,
      status: result.status,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
});

// 任务状态轮询（流程可视化）
r.get("/tasks/:taskId/status", (req, res) => {
  const raw = q.get(
    `SELECT t.*, m.code marshal_code,m.name marshal_name, m.emoji marshal_emoji, m.avatar marshal_avatar,m.online marshal_online, c.body output_body, c.ai_mode, c.risk_level, c.risk_flags, c.status output_status, c.snapshot_json output_snapshot_json,
      EXISTS(
        SELECT 1 FROM approvals a
        WHERE a.tenant_id=t.tenant_id
          AND a.target_type='content'
          AND a.target_id=t.output_id
          AND a.status='已通过'
      ) human_adopted
    FROM agent_tasks t JOIN marshals m ON m.id = t.marshal_id
    LEFT JOIN contents c ON c.id=t.output_id AND c.tenant_id=t.tenant_id
    WHERE t.tenant_id=${curTenant()} AND t.id=?`,
    req.params.taskId,
  );
  const t = mergeJoinedMarshal(raw);
  if (!t || !canAccessOwner(req.user, t.created_by))
    return res.status(404).json({ error: "任务不存在或无权查看" });
  const publicTask = publicTaskWithExecution(t, req.user);
  // 产物快照只用于草稿判定，不对外下发
  delete publicTask.output_snapshot_json;
  delete publicTask.contract_report;
  const supersededBy = publicTask.supersededBy || null;
  const billing = employeeTaskBilling(Number(t.id));
  const billingGate =
    ["待审阅", "已完成"].includes(String(t.status || "")) && Number(t.output_id)
      ? loadContentAdoptionAvailability(Number(t.output_id), {
          tenantId: curTenant(),
        })
      : null;
  const pendingReconciliation = [
    "DELIVERY_BILLING_MISSING",
    "DELIVERY_BILLING_UNSETTLED",
  ].includes(billingGate?.state?.code);
  const qualityFailed = t.status === "失败" && taskFailedQualityGate(t);
  // P0-1：未达标草稿（待处理 / 已被老板接受为内部参考稿）
  const draftInfo = employeeTaskDraftInfo(t, req.user);
  const draftPending = !supersededBy && draftInfo?.state === "pending";
  const draftAccepted = !supersededBy && draftInfo?.state === "accepted";
  const adoptionKind =
    t.status === "已完成" && !draftAccepted
      ? Number(t.human_adopted) === 1
        ? "human"
        : "auto"
      : null;
  const displayStatus = supersededBy
    ? BUSINESS_DELIVERY_LABELS.superseded
    : pendingReconciliation
    ? BUSINESS_DELIVERY_LABELS.businessBlocked
    : draftPending
      ? BUSINESS_DELIVERY_LABELS.draftPending
      : draftAccepted
        ? BUSINESS_DELIVERY_LABELS.draftAccepted
    : t.status === "待审阅"
      ? BUSINESS_DELIVERY_LABELS.reviewPending
      : t.status === "已完成"
        ? adoptionKind === "human"
          ? BUSINESS_DELIVERY_LABELS.adopted
          : RESTAURANT_AUTO_ADOPTED_LABEL
        : t.status === "已驳回"
          ? BUSINESS_DELIVERY_LABELS.reviewRejected
          : t.status === "失败"
            ? qualityFailed
              ? BUSINESS_DELIVERY_LABELS.qualityFailed
              : BUSINESS_DELIVERY_LABELS.executionFailed
            : t.status;
  const presentationKey = supersededBy
    ? "superseded"
    : pendingReconciliation
    ? "business_blocked"
    : draftPending
      ? "draft_pending"
      : draftAccepted
        ? "draft_accepted"
    : t.status === "待审阅"
      ? "review_pending"
      : t.status === "已完成"
        ? "adopted"
        : t.status === "已驳回" || qualityFailed
          ? "rework_required"
          : t.status === "失败"
            ? "execution_failed"
            : "generating";
  res.json({
    ...publicTask,
    deliveryState: supersededBy
      ? "DELIVERY_SUPERSEDED"
      : publicTask.deliveryState || null,
    presentationKey,
    adoptionKind,
    reworkRequired: presentationKey === "rework_required",
    displayStatus,
    ...(draftInfo && !supersededBy ? { draft: draftInfo } : {}),
    reviewReady:
      !supersededBy && t.status === "待审阅" && !pendingReconciliation,
    reviewBlockedReason:
      supersededBy
        ? `旧任务已由安全修订任务 #${supersededBy.taskId} 取代，不可继续审阅或用于业务`
        : t.status === "待审阅" && !pendingReconciliation
        ? null
        : pendingReconciliation
          ? "账务尚未完成权威确认，当前业务暂不可采用，也不能进入人工审阅"
          : t.status === "生成中"
            ? "任务仍在生成，尚未形成可验收产物"
            : qualityFailed
              ? "产物未通过岗位质检，需要修正材料后返工"
              : t.status === "失败"
                ? "执行过程发生异常，需要先检查失败原因"
                : t.status === "已驳回"
                  ? "本次产出已驳回，不能在原任务继续审阅；请按驳回意见补充材料后重新派活"
                  : "当前任务状态没有可执行的人工审阅动作",
    billing,
    billingState: pendingReconciliation
      ? billingGate?.state?.billing?.state || "pending_reconciliation"
      : billing.state,
    ...restaurantTaskProgress(
      supersededBy
        ? "已取代"
        : pendingReconciliation
        ? "待账务对账"
        : draftAccepted
          ? "草稿已接受"
        : qualityFailed
          ? "质检失败"
          : t.status,
      adoptionKind,
    ),
  });
});

// P0-1：未达标草稿的老板可读信息。failedChecks 只含人话（不出现契约 ID/指纹/字段路径）。
function employeeTaskDraftInfo(task, user) {
  if (!task?.output_id) return null;
  let report = null;
  try {
    report = task.contract_report ? JSON.parse(task.contract_report) : null;
  } catch {
    report = null;
  }
  let acceptance = null;
  try {
    const snapshot = task.output_snapshot_json
      ? JSON.parse(task.output_snapshot_json)
      : null;
    acceptance = snapshot?.draftAcceptance || null;
  } catch {
    acceptance = null;
  }
  const pending = task.status === AGENT_TASK_DRAFT_STATUS;
  if (!pending && !acceptance) return null;
  const failedChecks = Array.isArray(report?.failedChecks) && report.failedChecks.length
    ? report.failedChecks
    : humanizeContractFailures(report?.failedRules || []);
  const acceptable = report?.acceptable === true;
  return {
    state: pending ? "pending" : "accepted",
    failReason: task.fail_reason || report?.failReason || "contract",
    failReasonLabel:
      (task.fail_reason || report?.failReason) === "timeout"
        ? "执行超时，已保留最后一轮完整正文"
        : "质量门未通过，已保留最后一轮完整正文",
    attempts: Number(report?.attempts || 0),
    failedChecks,
    failedCheckCount: failedChecks.reduce(
      (sum, item) => sum + Number(item?.count || 1),
      0,
    ),
    acceptable,
    canAccept: pending && acceptable && ["boss", "admin"].includes(user?.role),
    acceptBlockedReason: pending
      ? acceptable
        ? ["boss", "admin"].includes(user?.role)
          ? null
          : "只有老板或管理员可以决定就用这份草稿"
        : "草稿引用了本次未核验的来源，不能直接采用；请带原要求重新派活"
      : null,
    ...(acceptance
      ? {
          acceptedAt: acceptance.acceptedAt || null,
          acceptedByName: acceptance.acceptedByName || null,
          requiresReview: acceptance.requiresReview === true,
        }
      : {}),
  };
}

// 数字员工对话：会话持久化（左栏历史）+ 技能注入（右栏加载 20 办公技能库）+ 多模态
// 技能库见 engines/skills.js；前端拿结构化清单（key/name/分类/图标/描述）渲染勾选
r.get("/skills/common", (req, res) => {
  if (!INTERNAL_PROFILE_ROLES.has(req.user?.role)) {
    return res.status(403).json({
      error: "岗位技能库仅老板、管理员和平台超管可查看",
      canViewSkills: false,
    });
  }
  return res.json(skillsForClient());
});

// 脚本技能：数字员工出 Markdown → 渲染成真实 Office 文件（可下载）
const SKILL_UPLOAD_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "data",
  "uploads",
  "skills",
);
function fileSkillGuide(format, label, message) {
  const demand = `需求：${message}`;
  if (format === "pptx") {
    return `请调用已加载的 PPT 演示技能，为以下需求输出可直接渲染成 PowerPoint 的 Markdown 源稿。
硬性规则：
1. 严格按用户要求的页数输出；用户要求5页就只能输出5页。
2. 每页之间必须用单独一行 --- 分隔。
3. 每页只允许一个 # 标题，标题下最多4条 - 要点；每条要点不超过24个汉字。
4. 不要输出“今日目标/具体动作/执行人/截止时间/检查标准”等过程说明。
5. 不要输出讲述逻辑、备注、内部解释；只输出观众能看到的PPT正文。
6. 表格最多4行3列；除非必要，优先用短要点。
${demand}`;
  }
  if (format === "docx") {
    return `请调用已加载的 Word 文档撰写技能，为以下需求输出可直接渲染成 Word 的 Markdown 正文。
硬性规则：
1. 只输出最终文档正文，不要输出备注、解释、写作过程或“我将为你”。
2. 用 # 作为文档标题；用 ## / ### 组织章节。
3. 正式文档必须包含：摘要、正文章节、行动/清单或表格、结论。
4. 表格使用标准 Markdown 表格；每张表不超过6列。
5. 语气要像可交付给老板/团队的正式文件，不要闲聊。
${demand}`;
  }
  if (format === "xlsx") {
    return `请调用已加载的 Excel 表格技能，为以下需求输出可直接渲染成 Excel 的 Markdown 表格源稿。
硬性规则：
1. 只输出表格、字段说明和公式，不要输出备注、解释、写作过程或“我将为你”。
2. 至少输出1张标准 Markdown 表格，第一行必须是字段名。
3. 字段要可落地录入；涉及计算时给出 Excel/WPS 可用公式。
4. 每张表不超过8列、12行；需要多表时用 ## 标出工作表名称。
5. 不要用空泛建议替代表格结果。
${demand}`;
  }
  if (format === "pdf") {
    return `请调用已加载的 PDF 报告技能，为以下需求输出可直接排版成正式PDF的 Markdown 正文。
硬性规则：
1. 只输出最终报告正文，不要输出解释、写作过程或占位废话。
2. 用 # / ## / ### 组织标题层级，正文短段落，关键结论使用清单或表格。
3. 至少包含：摘要、关键判断、数据/事实依据、执行建议、风险边界、结论。
4. 所有事实必须优先引用用户上传资料与知识库，不得臆造数据。
5. 语言适合直接提交给老板、客户或团队。
${demand}`;
  }
  return `请调用已加载的 ${label} 技能，为以下需求输出可直接排版成【${label}】文件的 Markdown 正文。只输出正文，不要额外解释。
${demand}`;
}
r.post("/:id/skill-file", async (req, res) => {
  try {
    const m = activeDepartmentById(req.params.id);
    if (!m) return res.status(404).json({ error: "分部不存在或未启用" });
    const { message, format, fileIds } = req.body || {};
    const fsk = FILE_SKILLS[format];
    if (!fsk) return res.status(400).json({ error: "不支持的文件类型" });
    const demand = typeof message === "string" ? message.trim() : "";
    if (!demand) return res.status(400).json({ error: "请描述要生成的内容" });
    if (demand.length > MAX_MESSAGE_CHARS)
      return res.status(400).json({ error: "生成要求不能超过20000字" });
    precheckByRole(req.user.id, "text", req.user.role);
    const files = resolveRequestedAttachments(fileIds, req.user, 6);
    const guide = fileSkillGuide(format, fsk.label, demand);
    // 两段式记账（BE-C1）：按实际要发送的指令+附件内容占扣，生成完成后结算多退少补
    const holdModel = textModelFor(req.user.role);
    const hold = holdCredits({
      userId: req.user.id,
      feature: `生成${fsk.label}·${m.name}`,
      kind: "text",
      model: holdModel,
      credits: estimateCallCredits({
        model: holdModel,
        texts: [
          guide,
          ...files.map((a) => String(a.content || "").slice(0, 5000)),
        ],
      }),
    });
    const tenantId = curTenant();
    const delivered = await executeHeldDelivery({
      hold,
      generate: async () => {
        const out = await marshalChat(m, {
          message: guide,
          originalMessage: demand,
          history: [],
          role: req.user.role,
          skills: [format],
          attachments: files,
          signal: req.requestSignal,
        });
        const buf = await fsk.fn(out.text, demand.slice(0, 30));
        return { out, buf };
      },
      persist: ({ out, buf }) => {
        const tenantDir = path.join(SKILL_UPLOAD_DIR, String(tenantId));
        fs.mkdirSync(tenantDir, { recursive: true });
        const fname = `${fsk.label}_${Date.now()}_${crypto.randomBytes(5).toString("hex")}.${fsk.ext}`;
        const filePath = path.join(tenantDir, fname);
        const fileUrl = `/uploads/skills/${tenantId}/${encodeURIComponent(fname)}`;
        try {
          fs.writeFileSync(filePath, buf, { flag: "wx" });
          return withImmediateTransaction(db, () => {
            const artifact = q.run(
              `INSERT INTO generated_artifacts(user_id,source_type,source_id,title,format,content,file_url,file_name,metadata)
              VALUES(?,?,?,?,?,?,?,?,?)`,
              req.user.id,
              "marshal_skill",
              m.id,
              demand.slice(0, 100),
              format,
              out.text,
              fileUrl,
              fname,
              JSON.stringify({
                size: buf.length,
                marshalCode: m.code,
                marshalName: m.name,
              }),
            );
            logOp(req.user, "餐饮数字员工", `生成${fsk.label}`, m.name);
            return {
              fileUrl,
              fileName: fname,
              size: buf.length,
              artifactId: Number(artifact.lastInsertRowid),
              filePath,
            };
          });
        } catch (error) {
          try {
            fs.rmSync(filePath, { force: true });
          } catch {
            /* best-effort cleanup */
          }
          throw error;
        }
      },
      settle: settleHold,
      release: releaseHold,
      settlement: ({ out }) => ({
        usage: out.usage,
        model: out.model,
        aiMode: out.mode,
        note: `${fsk.label}文件与制品记录已完整落库`,
      }),
      requirePositiveApiUsage: true,
      releaseNote: `${fsk.label}生成、渲染或制品落库失败，预授权全额退回`,
    });
    res.json({
      reply: delivered.output.out.text,
      fileUrl: delivered.delivery.fileUrl,
      fileName: delivered.delivery.fileName,
      size: delivered.delivery.size,
      artifactId: delivered.delivery.artifactId,
      billing: delivered.billing,
    });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      ...(e.billing ? { billing: e.billing } : {}),
    });
  }
});

r.get("/:id/chats", (req, res) => {
  if (!activeDepartmentById(req.params.id))
    return res.status(404).json({ error: "分部不存在或未启用" });
  res.json(
    q.all(
      `SELECT s.*, (SELECT COUNT(*) FROM marshal_chat_msgs mm WHERE mm.tenant_id=s.tenant_id AND mm.session_id=s.id) msg_count
    FROM marshal_chat_sessions s WHERE s.tenant_id = ? AND s.marshal_id = ? AND s.user_id = ?
    ORDER BY COALESCE(s.pinned,0) DESC,COALESCE(s.updated_at,s.created_at) DESC LIMIT 30`,
      curTenant(),
      req.params.id,
      req.user.id,
    ),
  );
});
r.get("/chats/:sid/messages", (req, res) => {
  const sess = q.get(
    "SELECT * FROM marshal_chat_sessions WHERE tenant_id=? AND id = ? AND user_id = ?",
    curTenant(),
    req.params.sid,
    req.user.id,
  );
  if (!sess || !activeDepartmentById(sess.marshal_id))
    return res.status(404).json({ error: "会话不存在" });
  res.json(
    q.all(
      "SELECT id, role, content, image, attachments_json, artifact_id, created_at FROM marshal_chat_msgs WHERE tenant_id=? AND session_id = ? ORDER BY id",
      curTenant(),
      req.params.sid,
    ),
  );
});

r.put("/chats/:sid", (req, res) => {
  const sess = q.get(
    "SELECT * FROM marshal_chat_sessions WHERE tenant_id=? AND id=? AND user_id=?",
    curTenant(),
    req.params.sid,
    req.user.id,
  );
  if (!sess || !activeDepartmentById(sess.marshal_id))
    return res.status(404).json({ error: "会话不存在" });
  const { title, pinned, memory } = req.body || {};
  if (title !== undefined)
    q.run(
      `UPDATE marshal_chat_sessions SET title=?,updated_at=datetime('now','localtime') WHERE id=?`,
      String(title).trim().slice(0, 60) || sess.title,
      sess.id,
    );
  if (pinned !== undefined)
    q.run(
      `UPDATE marshal_chat_sessions SET pinned=?,updated_at=datetime('now','localtime') WHERE id=?`,
      pinned ? 1 : 0,
      sess.id,
    );
  if (memory !== undefined)
    q.run(
      `UPDATE marshal_chat_sessions SET memory=?,updated_at=datetime('now','localtime') WHERE id=?`,
      String(memory).slice(0, 8000),
      sess.id,
    );
  res.json(
    q.get(
      `SELECT * FROM marshal_chat_sessions WHERE tenant_id=? AND id=?`,
      curTenant(),
      sess.id,
    ),
  );
});

r.post("/chats/:sid/memory", (req, res) => {
  const sess = q.get(
    "SELECT * FROM marshal_chat_sessions WHERE tenant_id=? AND id=? AND user_id=?",
    curTenant(),
    req.params.sid,
    req.user.id,
  );
  if (!sess || !activeDepartmentById(sess.marshal_id))
    return res.status(404).json({ error: "会话不存在" });
  const content = String(req.body?.content || "").trim();
  if (!content) return res.status(400).json({ error: "记忆内容不能为空" });
  const out = q.run(
    `INSERT INTO conversation_memories(user_id,scope,session_id,title,content,tags) VALUES(?,?,?,?,?,?)`,
    req.user.id,
    "marshal",
    sess.id,
    String(req.body?.title || sess.title || "数字员工会话记忆").slice(0, 80),
    content.slice(0, 6000),
    JSON.stringify(req.body?.tags || []),
  );
  const combined = [sess.memory, content]
    .filter(Boolean)
    .join("\n---\n")
    .slice(-8000);
  q.run(
    `UPDATE marshal_chat_sessions SET memory=?,updated_at=datetime('now','localtime') WHERE id=?`,
    combined,
    sess.id,
  );
  res.json({ id: out.lastInsertRowid, memory: combined });
});

r.post("/:id/chat", async (req, res) => {
  let hold = null; // 两段式记账占扣句柄：开流前占扣，流结束后结算多退少补，失败全额退回
  let holdManaged = false;
  try {
    const m = activeDepartmentById(req.params.id);
    if (!m) return res.status(404).json({ error: "分部不存在或未启用" });
    const { message, image, sessionId, skills, fileIds } = req.body || {};
    const chatText =
      message == null
        ? ""
        : typeof message === "string"
          ? message.trim()
          : null;
    if (chatText == null)
      return res.status(400).json({ error: "消息必须是文本" });
    if (chatText.length > MAX_MESSAGE_CHARS)
      return res.status(400).json({ error: "消息不能超过20000字" });
    if (image != null && typeof image !== "string")
      return res.status(400).json({ error: "图片格式不支持" });
    if (image && !/^data:image\/(png|jpe?g|webp);base64,/.test(image))
      return res.status(400).json({ error: "图片格式不支持" });
    if (image && image.length > MAX_INLINE_IMAGE_CHARS)
      return res.status(413).json({ error: "图片超过8MB，请压缩后重试" });
    if (skills != null && !Array.isArray(skills))
      return res.status(400).json({ error: "技能参数格式不正确" });
    const safeSkills = [
      ...new Set(
        (skills || []).map((item) => String(item).trim()).filter(Boolean),
      ),
    ].slice(0, 20);
    if (safeSkills.some((key) => !skillByKey(key)))
      return res.status(400).json({ error: "技能参数中包含未知技能" });
    const files = resolveRequestedAttachments(fileIds, req.user, 6);
    if (!chatText && !image && !files.length)
      return res.status(400).json({ error: "消息或附件不能为空" });
    precheckByRole(req.user.id, "text", req.user.role);

    // 会话持久化：无 sessionId 则新建
    let sid = Number(sessionId || 0);
    if (sessionId && (!Number.isInteger(sid) || sid <= 0))
      return res.status(400).json({ error: "会话标识不正确" });
    if (sid) {
      const existing = q.get(
        `SELECT id FROM marshal_chat_sessions WHERE tenant_id=? AND id=? AND user_id=? AND marshal_id=?`,
        curTenant(),
        sid,
        req.user.id,
        m.id,
      );
      if (!existing) return res.status(404).json({ error: "会话不存在" });
    }
    if (!sid) {
      const r0 = q.run(
        "INSERT INTO marshal_chat_sessions(marshal_id,user_id,title) VALUES(?,?,?)",
        m.id,
        req.user.id,
        (chatText || files[0]?.name || "图片分析").slice(0, 24),
      );
      sid = r0.lastInsertRowid;
    }
    const storedImage = image && image.length <= 400000 ? image : null;
    q.run(
      "INSERT INTO marshal_chat_msgs(session_id,role,content,image,attachments_json) VALUES(?,?,?,?,?)",
      sid,
      "user",
      chatText,
      storedImage,
      files.length ? JSON.stringify(attachmentRefsForStorage(files)) : null,
    );

    // 技能注入：选中的技能转为输出指令（来自 20 办公技能库）
    const finalMsg = chatText + directivesFor(safeSkills);
    const hist = rehydrateMessageHistory(
      q
        .all(
          `SELECT role,content,attachments_json FROM marshal_chat_msgs WHERE tenant_id=? AND session_id=?
      AND id < (SELECT MAX(id) FROM marshal_chat_msgs WHERE tenant_id=? AND session_id=?) ORDER BY id DESC LIMIT 12`,
          curTenant(),
          sid,
          curTenant(),
          sid,
        )
        .reverse(),
      req.user,
    );
    const sess =
      q.get(
        `SELECT memory,summary FROM marshal_chat_sessions WHERE tenant_id=? AND id=?`,
        curTenant(),
        sid,
      ) || {};
    const sharedMemory = q
      .all(
        `SELECT content FROM conversation_memories WHERE tenant_id=? AND user_id=? AND scope='marshal' AND (session_id=? OR session_id IS NULL) AND pinned=1 ORDER BY id DESC LIMIT 8`,
        curTenant(),
        req.user.id,
        sid,
      )
      .map((x) => x.content)
      .reverse()
      .join("\n");
    const memoryText = [sess.summary, sess.memory, sharedMemory]
      .filter(Boolean)
      .join("\n");
    // 两段式记账（BE-C1/BE-H2）：开流前按"实际将要发送"的消息+历史+记忆+附件占扣保守上限，
    // 余额不足在交付任何内容前 402；结算在流结束后按真实用量多退少补。发图时预留识图 token 余量。
    const holdModel = textModelFor(req.user.role);
    hold = holdCredits({
      userId: req.user.id,
      feature: `员工对话·${m.name}`,
      kind: "text",
      model: holdModel,
      credits: estimateCallCredits({
        model: holdModel,
        overheadTokens: image ? 8000 : undefined,
        texts: [
          finalMsg,
          ...hist.map((h) => h.content),
          memoryText.slice(0, 5000),
          ...files.map((a) => String(a.content || "").slice(0, 5000)),
        ],
      }),
    });

    // SSE 在完整业务产物落库前不向客户端泄露模型正文。这样即使助手消息、风控或引用
    // 落库失败，本次仍属于“未交付”，可以安全释放预授权。
    const useStream = req.body?.stream === true;
    let sendEvent = null;
    if (useStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      sendEvent = (obj) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
    }
    holdManaged = true;
    const delivered = await executeHeldDelivery({
      hold,
      generate: () =>
        marshalChat(m, {
          message: finalMsg || "",
          originalMessage: chatText,
          history: hist,
          role: req.user.role,
          image,
          skills: safeSkills,
          attachments: files,
          memory: memoryText,
          signal: req.requestSignal,
        }),
      persist: (out) =>
        withImmediateTransaction(db, () => {
          const msg = q.run(
            "INSERT INTO marshal_chat_msgs(session_id,role,content) VALUES(?,?,?)",
            sid,
            "assistant",
            out.text,
          );
          // AI-H1：员工对话输出与内容生产仓同口径过风控（标记+进审批）；AI-C2：引用的知识文档落库可溯源
          const risk = applyChatRiskControl({
            targetType: "marshal_chat_msg",
            targetId: msg.lastInsertRowid,
            title: `员工对话输出：${m.name}`,
            text: out.text,
            submitterId: req.user.id,
          });
          recordKbCitations({
            targetType: "marshal_chat_msg",
            targetId: msg.lastInsertRowid,
            kb: out.kb,
          });
          const latest = q
            .all(
              `SELECT role,content FROM marshal_chat_msgs WHERE tenant_id=? AND session_id=? ORDER BY id DESC LIMIT 8`,
              curTenant(),
              sid,
            )
            .reverse();
          const summary = latest
            .map(
              (x) =>
                `${x.role === "user" ? "用户" : "数字员工"}：${String(
                  x.content || "",
                )
                  .replace(/\s+/g, " ")
                  .slice(0, 220)}`,
            )
            .join("\n")
            .slice(0, 3500);
          q.run(
            `UPDATE marshal_chat_sessions SET summary=?,updated_at=datetime('now','localtime') WHERE id=?`,
            summary,
            sid,
          );
          logOp(req.user, "餐饮数字员工", "员工对话", m.name);
          return {
            assistantMessageId: Number(msg.lastInsertRowid),
            risk,
          };
        }),
      settle: settleHold,
      release: releaseHold,
      settlement: (out) => ({
        usage: out.usage,
        model: out.model,
        aiMode: out.mode,
        note: `员工对话会话#${sid}助手消息、风控、引用与摘要已原子落库`,
      }),
      requirePositiveApiUsage: true,
      releaseNote: `员工对话会话#${sid}生成或业务落库失败，预授权全额退回`,
    });
    const payload = {
      sessionId: sid,
      assistantMessageId: delivered.delivery.assistantMessageId,
      reply: delivered.output.text,
      mode: delivered.output.mode,
      model: delivered.output.model,
      billing: delivered.billing,
      risk: delivered.delivery.risk,
      kb: delivered.output.kb,
    };
    if (sendEvent) {
      sendEvent({ reset: true });
      sendEvent({ delta: delivered.output.text });
      sendEvent({ done: true, ...payload });
      res.end();
    } else res.json(payload);
  } catch (e) {
    // executeHeldDelivery 接管后由统一执行器释放；接管前异常才在这里补偿。
    if (hold && !holdManaged) {
      try {
        releaseHold(
          hold,
          `员工对话未开始（${String(e?.message || "").slice(0, 60)}），预授权全额退回`,
        );
      } catch {
        /* 释放失败留待人工对账 */
      }
    }
    if (req.requestSignal?.aborted) {
      if (res.headersSent && !res.writableEnded) res.end();
      return;
    }
    if (res.headersSent) {
      // SSE 已开始：错误以事件下发再关流
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: e.message,
            requestId: req.requestId,
            ...(e.billing ? { billing: e.billing } : {}),
          })}\n\n`,
        );
        res.end();
      }
      return;
    }
    res.status(e.status || 500).json({
      error: e.message,
      requestId: req.requestId,
      ...(e.billing ? { billing: e.billing } : {}),
    });
  }
});

// 产出审阅（FR-MAR-05）
r.post("/outputs/:outputId/review", (req, res) => {
  const { decision, reason } = req.body || {};
  const c = q.get(
    `SELECT * FROM contents WHERE tenant_id = ${curTenant()} AND id = ?`,
    req.params.outputId,
  );
  if (!c || !activeDepartmentById(c.marshal_id))
    return res.status(404).json({ error: "产出不存在或无权审阅" });
  try {
    const result = decideContentOutput({
      outputId: c.id,
      actor: req.user,
      decision,
      reason,
    });
    if (!result.alreadyReviewed) {
      logOp(
        req.user,
        "餐饮数字员工",
        decision === "adopt" ? "采纳产出" : "驳回产出",
        `content#${c.id}`,
      );
    }
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

r.get("/collab/tasks", (req, res) => {
  const scope = userScopeClause(req.user, "t.created_by");
  res.json(
    q
      .all(
        `SELECT t.*,m.code marshal_code,m.name marshal_name,m.emoji marshal_emoji,m.avatar marshal_avatar,m.online marshal_online FROM agent_tasks t JOIN marshals m ON m.id = t.marshal_id
    WHERE t.tenant_id = ${curTenant()} AND t.is_collab = 1${scope.sql} ORDER BY t.created_at DESC LIMIT 10`,
        ...scope.params,
      )
      .map((row) => mergeJoinedMarshal(row))
      .filter(Boolean)
      .map((task) => publicTaskWithExecution(task, req.user)),
  );
});

export default r;
