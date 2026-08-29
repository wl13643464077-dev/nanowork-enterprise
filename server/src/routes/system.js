import { Router } from "express";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  db,
  q,
  getConfig,
  setConfig,
  getTenantConfig,
  setTenantConfig,
  DB_PATH,
  backupDatabase,
  curTenant,
  getTenant,
  promptOverride,
  mergeMarshal,
} from "../db.js";
import { hashPassword, logOp, requireRole, notify } from "../util.js";
import { getTokenUsage, aiAvailable } from "../engines/ai.js";
import { getRules } from "../engines/risk.js";
import {
  backfillMissingEmbeddings,
  embedDoc,
  kbVectorReadiness,
} from "../engines/rag.js";
import {
  canAccessOwner,
  roleListAllows,
  scopedUserIds,
  userScopeClause,
} from "../engines/access.js";
import { decodeBase64File, MAX_FILE_BYTES } from "../engines/filehub.js";
import {
  archiveAndDelete,
  deleteList,
  deletionDenied,
  isBossLike,
  isManagerLike,
  restoreDeletedRecord,
  tableRows,
} from "../engines/deletion.js";
import { loadRestaurantCatalog } from "../catalog/restaurant.js";
import {
  contentOutputReviewAccess,
  decideContentOutput,
} from "../engines/restaurant-output-review.js";
import {
  loadContentAdoptionAvailability,
  loadContentDeliveryState,
  loadKbDocSupersession,
} from "../engines/delivery-state.js";
import {
  precheck,
  estimateCallCredits,
  holdCredits,
  settleHold,
  releaseHold,
} from "../engines/credits.js";
import {
  executeHeldDelivery,
  twoPhaseBillingSummary,
  withImmediateTransaction,
} from "../engines/two-phase-delivery.js";
import { sanitizeProviderError } from "../engines/provider-errors.js";
import {
  buildRuntimeReadiness,
  recordRuntimeReadinessCheck,
} from "../engines/runtime-readiness.js";
import {
  inspectAiReconciliationHold,
  listAiReconciliationHolds,
  resolveContentPipelineReconciliation,
  resolveContentSpecialProviderReconciliation,
} from "../engines/ai-reconciliation.js";
import {
  APPROVAL_ROUTING_POLICY_KEY,
  APPROVAL_ROUTING_SCHEMA,
  activityApprovalSubjectMatches,
  approvalAssigneeAccess,
  approvalWorkflowTransition,
  loadApprovalRoutingPolicy,
  normalizeApprovalRoutingPolicy,
} from "../engines/approval-routing-policy.js";
import * as yunwu from "../engines/yunwu.js";

const r = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_UPLOAD_ROOT = path.join(
  __dirname,
  "..",
  "..",
  "data",
  "uploads",
  "kb",
);
const KB_ROLE_SET = new Set([
  "boss",
  "ops_director",
  "admin",
  "sales",
  "partner",
]);
const USER_ROLE_SET = new Set([
  "boss",
  "ops_director",
  "manager",
  "admin",
  "sales",
  "partner",
]);
const USER_STATUS_SET = new Set(["启用", "停用"]);
const USER_MODULE_SET = new Set([
  "dashboard",
  "advisor",
  "marshals",
  "growth",
  "activities",
  "content",
  "execution",
  "analysis",
  "assets",
  "system",
]);
const TENANT_ADMIN_ROLES = new Set(["boss", "admin"]);
const RESTAURANT_CATALOG = loadRestaurantCatalog();
const RESTAURANT_DEPARTMENTS = RESTAURANT_CATALOG.groups.map(
  (group, index) => ({
    code: `M-${String(index + 1).padStart(2, "0")}`,
    name: group.name,
    employeeCount: group.members.length,
  }),
);

function requirePlatformOperator(req, res, next) {
  const allowed =
    req.user.role === "platform_super" ||
    (curTenant() === 1 && ["boss", "admin"].includes(req.user.role));
  if (!allowed)
    return res.status(403).json({ error: "整库备份仅平台总部运维人员可操作" });
  next();
}

function databaseBackupMeta(file) {
  const base = path
    .basename(DB_PATH, path.extname(DB_PATH))
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(file).match(
    new RegExp(`^${base}\\.backup\\.(\\d+)\\.sqlite$`),
  );
  return match ? { timestamp: Number(match[1]) } : null;
}

function normalizedUserModules(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > USER_MODULE_SET.size)
    throw Object.assign(new Error("模块权限格式不正确"), { status: 400 });
  const modules = [...new Set(value.map((item) => String(item).trim()))];
  if (modules.some((item) => !USER_MODULE_SET.has(item)))
    throw Object.assign(new Error("模块权限包含无效值"), { status: 400 });
  return modules.length ? JSON.stringify(modules) : null;
}

function normalizedUserName(value) {
  if (typeof value !== "string")
    throw Object.assign(new Error("姓名格式不正确"), { status: 400 });
  const name = value.trim();
  if (!name || name.length > 60)
    throw Object.assign(new Error("姓名长度必须为1到60字"), { status: 400 });
  return name;
}

function userDependencyCounts(tenantId, userId) {
  return {
    contents: Number(
      q.get(
        "SELECT COUNT(*) n FROM contents WHERE tenant_id=? AND creator_id=?",
        tenantId,
        userId,
      )?.n || 0,
    ),
    tasks: Number(
      q.get(
        "SELECT COUNT(*) n FROM tasks WHERE tenant_id=? AND assignee_id=?",
        tenantId,
        userId,
      )?.n || 0,
    ),
    approvals: Number(
      q.get(
        `SELECT COUNT(*) n FROM approvals
        WHERE tenant_id=? AND (submitter_id=? OR reviewer_id=?)`,
        tenantId,
        userId,
        userId,
      )?.n || 0,
    ),
    automationRules: Number(
      q.get(
        "SELECT COUNT(*) n FROM content_automation_rules WHERE tenant_id=? AND created_by=?",
        tenantId,
        userId,
      )?.n || 0,
    ),
    automationRuns: Number(
      q.get(
        `SELECT COUNT(*) n FROM content_automation_runs
        WHERE tenant_id=? AND (
          initiated_by=?
          OR rule_id IN (
            SELECT id FROM content_automation_rules WHERE tenant_id=? AND created_by=?
          )
        )`,
        tenantId,
        userId,
        tenantId,
        userId,
      )?.n || 0,
    ),
  };
}

function userDisableError(message, status) {
  return Object.assign(new Error(message), { status });
}

function validManagerId(raw, tid, targetId = null) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const managerId = Number(raw);
  if (
    !Number.isInteger(managerId) ||
    managerId <= 0 ||
    managerId === Number(targetId)
  ) {
    throw Object.assign(new Error("直属上级不正确"), { status: 400 });
  }
  const manager = q.get(
    `SELECT id FROM users WHERE tenant_id=? AND id=? AND role IN ('boss','ops_director','manager','admin')`,
    tid,
    managerId,
  );
  if (!manager)
    throw Object.assign(new Error("直属上级必须是当前企业的老板/经理/管理员"), {
      status: 400,
    });
  if (targetId) {
    const cycle = q.get(
      `WITH RECURSIVE managers(id,manager_id) AS (
      SELECT id,manager_id FROM users WHERE tenant_id=? AND id=?
      UNION ALL
      SELECT u.id,u.manager_id FROM users u JOIN managers m ON u.id=m.manager_id WHERE u.tenant_id=?
    ) SELECT id FROM managers WHERE id=? LIMIT 1`,
      tid,
      managerId,
      tid,
      Number(targetId),
    );
    if (cycle)
      throw Object.assign(new Error("直属上级关系不能形成循环"), {
        status: 400,
      });
  }
  return managerId;
}

function configuredKbCategories() {
  const categories = getTenantConfig("kb_categories", DEFAULT_KB_CATS);
  return Array.isArray(categories) && categories.length
    ? categories
    : DEFAULT_KB_CATS;
}

function normalizedKbRoleJson(value, label) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > KB_ROLE_SET.size)
    throw Object.assign(new Error(`${label}格式不正确`), { status: 400 });
  const roles = [...new Set(value.map((role) => String(role).trim()))];
  if (roles.some((role) => !KB_ROLE_SET.has(role)))
    throw Object.assign(new Error(`${label}包含无效角色`), { status: 400 });
  return roles.length ? JSON.stringify(roles) : null;
}

function normalizedKbText(value, label, max, { required = false } = {}) {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw Object.assign(new Error(`${label}必须是文本`), { status: 400 });
  const text = value.trim();
  if (required && !text)
    throw Object.assign(new Error(`${label}必填`), { status: 400 });
  if (text.length > max)
    throw Object.assign(new Error(`${label}最长${max}字`), { status: 400 });
  return text;
}

function normalizedKbCategory(value, { required = false } = {}) {
  const category = normalizedKbText(value, "知识分类", 60, { required });
  if (
    category !== undefined &&
    category &&
    !configuredKbCategories().includes(category)
  ) {
    throw Object.assign(new Error("请选择本企业已配置的知识库分类"), {
      status: 400,
    });
  }
  return category;
}

function parsePayload(v, fallback = {}) {
  if (!v) return fallback;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function planSummary(plan = {}) {
  const flow = Array.isArray(plan.flow) ? plan.flow.length : 0;
  const materials = Array.isArray(plan.materials) ? plan.materials.length : 0;
  const sop = Array.isArray(plan.sop) ? plan.sop.length : 0;
  return `流程${flow}项 / 物料${materials}项 / SOP${sop}项`;
}

function levelLabel(level) {
  return level === "boss"
    ? "老板终审"
    : level === "ops_director"
      ? "运营总监初审"
      : "审批";
}

function notifyRoleUsers(roles, type, title, body) {
  const list = roles.map(() => "?").join(",");
  const users = q.all(
    `SELECT id FROM users WHERE tenant_id=${curTenant()} AND role IN (${list})`,
    ...roles,
  );
  for (const u of users) notify(u.id, type, title, body);
}

function safeChecklist(raw) {
  const arr = parsePayload(raw, []);
  return Array.isArray(arr)
    ? arr.map((x, idx) =>
        typeof x === "object" && x
          ? x
          : { item: String(x || `事项${idx + 1}`), done: false },
      )
    : [];
}

function checklistItemLabel(item, idx = 0) {
  return String(
    item?.item || item?.title || item?.name || `待确认事项${idx + 1}`,
  );
}

function immediateTransaction(work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* transaction already closed */
    }
    throw error;
  }
}

function markApprovalDecision(approval, user, pass, reason) {
  const changed = q.run(
    `UPDATE approvals SET status=?,reviewer_id=?,reason=?,decided_at=datetime('now','localtime')
    WHERE tenant_id=? AND id=? AND status='待审核'`,
    pass ? "已通过" : "已驳回",
    user.id,
    reason || null,
    curTenant(),
    approval.id,
  );
  if (!changed.changes)
    throw Object.assign(new Error("该审批已被其他人处理，请刷新列表"), {
      status: 409,
    });
}

function blockedApprovalAvailability(reason, status = 403) {
  return {
    canPass: false,
    canReject: false,
    passBlockedReason: reason,
    rejectBlockedReason: reason,
    reviewBlockedReason: reason,
    passBlockedStatus: status,
    rejectBlockedStatus: status,
  };
}

function supersededContentProjection(contentId) {
  const id = Number(contentId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const delivery = loadContentDeliveryState(id, {
    tenantId: curTenant(),
    requireFlowStatus: false,
    requireBilling: false,
  });
  if (delivery.code !== "DELIVERY_SUPERSEDED") return null;
  return {
    deliveryState: delivery.code,
    bodyAvailability: "superseded",
    businessUsable: false,
    supersededBy: delivery.supersededBy || null,
  };
}

function lockedApprovalWorkflow(approval) {
  let transition;
  try {
    transition = approvalWorkflowTransition(approval?.approval_policy_snapshot);
  } catch (error) {
    if (error?.code === "APPROVAL_WORKFLOW_SNAPSHOT_INVALID") {
      throw Object.assign(
        new Error("审批规则快照已损坏，已阻断处理并保留原状态"),
        {
          status: 409,
          code: "APPROVAL_WORKFLOW_SNAPSHOT_INVALID",
        },
      );
    }
    throw error;
  }
  if (transition.kind === "legacy") return transition;
  const current = transition.current;
  if (
    current.level !== approval.approval_level ||
    Number(current.assignedReviewerId || 0) !==
      Number(approval.assigned_reviewer_id || 0)
  ) {
    throw Object.assign(
      new Error("审批规则快照与当前审批单不一致，已阻断处理"),
      {
        status: 409,
        code: "APPROVAL_WORKFLOW_SNAPSHOT_MISMATCH",
      },
    );
  }
  return transition;
}

function approvalDecisionAvailability(approval, user = null) {
  const pending = approval?.status === "待审核";
  if (!pending) {
    return {
      canPass: false,
      canReject: false,
      passBlockedReason: "该审批已经处理",
      rejectBlockedReason: "该审批已经处理",
      passBlockedStatus: 409,
      rejectBlockedStatus: 409,
    };
  }
  try {
    lockedApprovalWorkflow(approval);
  } catch (error) {
    return blockedApprovalAvailability(error.message, error.status || 409);
  }
  const assignee = approvalAssigneeAccess(approval, user);
  if (!assignee.allowed)
    return blockedApprovalAvailability(assignee.reason, 403);
  if (approval.target_type !== "content") {
    if (user?.role === "manager") {
      const reason = "直属经理只能处理有权限的员工产出审批";
      return {
        canPass: false,
        canReject: false,
        passBlockedReason: reason,
        rejectBlockedReason: reason,
        reviewBlockedReason: reason,
        passBlockedStatus: 403,
        rejectBlockedStatus: 403,
      };
    }
    if (approval.approval_level === "boss" && user?.role !== "boss") {
      const reason = "该事项配置为老板审核，必须由老板处理";
      return {
        canPass: false,
        canReject: false,
        passBlockedReason: reason,
        rejectBlockedReason: reason,
        reviewBlockedReason: reason,
        passBlockedStatus: 403,
        rejectBlockedStatus: 403,
      };
    }
    if (approval.risk_level === "high" && user?.role !== "boss") {
      const reason = "高风险事项需老板终审";
      return {
        canPass: false,
        canReject: false,
        passBlockedReason: reason,
        rejectBlockedReason: reason,
        reviewBlockedReason: reason,
        passBlockedStatus: 403,
        rejectBlockedStatus: 403,
      };
    }
    return { canPass: true, canReject: true, passBlockedReason: "" };
  }
  const content = q.get(
    `SELECT id,risk_level,creator_id FROM contents
    WHERE tenant_id=? AND id=?`,
    curTenant(),
    approval.target_id,
  );
  if (!content) {
    return {
      canPass: false,
      canReject: false,
      passBlockedReason: "待人工审阅内容不存在，无法处理",
      rejectBlockedReason: "待人工审阅内容不存在，无法处理",
      reviewBlockedReason: "待人工审阅内容不存在，无法处理",
      passBlockedStatus: 404,
      rejectBlockedStatus: 404,
    };
  }
  const task = content
    ? q.get(
        `SELECT * FROM agent_tasks
      WHERE tenant_id=? AND output_id=? ORDER BY id DESC LIMIT 1`,
        curTenant(),
        content.id,
      )
    : null;
  const access = contentOutputReviewAccess(user, task, approval, content);
  if (!access.allowed) {
    return {
      canPass: false,
      canReject: false,
      passBlockedReason: access.reason,
      rejectBlockedReason: access.reason,
      reviewBlockedReason: access.reason,
      passBlockedStatus: 403,
      rejectBlockedStatus: 403,
    };
  }
  const adoption = loadContentAdoptionAvailability(content.id, {
    tenantId: curTenant(),
  });
  if (adoption.state?.code === "DELIVERY_SUPERSEDED") {
    const reason = `${adoption.state.reason}；旧版审批仅保留审计，不能再采纳或驳回`;
    return {
      ...blockedApprovalAvailability(reason, 409),
      reviewStatus: "已由安全修订版取代",
      deliveryState: adoption.state.code,
      bodyAvailability: "superseded",
      businessUsable: false,
      supersededBy: adoption.state.supersededBy || null,
    };
  }
  if (
    ["DELIVERY_BILLING_MISSING", "DELIVERY_BILLING_UNSETTLED"].includes(
      adoption.state?.code,
    )
  ) {
    const reason = `${adoption.reason}；当前不进入人工审阅，请先完成账务对账`;
    if (adoption.canReject) {
      const qualityReason =
        adoption.state?.contract?.reason ||
        adoption.state?.provenance?.reason ||
        adoption.reason;
      return {
        canPass: false,
        canReject: true,
        passBlockedReason: qualityReason,
        rejectBlockedReason: "",
        reviewBlockedReason: "",
        reviewStatus: "质检未通过",
        passBlockedStatus: 409,
      };
    }
    return {
      canPass: false,
      canReject: false,
      passBlockedReason: reason,
      rejectBlockedReason: reason,
      reviewBlockedReason: reason,
      reviewStatus: "待账务对账",
      passBlockedStatus: 409,
      rejectBlockedStatus: 409,
    };
  }
  if (!adoption.canAdopt) {
    return {
      canPass: false,
      canReject: true,
      passBlockedReason: `${adoption.reason}；可以驳回并要求修复后重新派活`,
      reviewBlockedReason: "",
      passBlockedStatus: 409,
    };
  }
  return { canPass: true, canReject: true, passBlockedReason: "" };
}

function approvalVisibilityClause(user) {
  const ids = scopedUserIds(user);
  if (ids === null) return { sql: "", params: [] };
  if (!ids.length)
    return { sql: " AND a.target_type <> 'content'", params: [] };
  const placeholders = ids.map(() => "?").join(",");
  return {
    sql: ` AND (a.target_type <> 'content' OR COALESCE(
      (SELECT task.created_by FROM agent_tasks task
        WHERE task.tenant_id=a.tenant_id AND task.output_id=a.target_id
        ORDER BY task.id DESC LIMIT 1),
      (SELECT content.creator_id FROM contents content
        WHERE content.tenant_id=a.tenant_id AND content.id=a.target_id)
    ) IN (${placeholders}))`,
    params: ids,
  };
}

function approvalDecisionBlock(availability, pass) {
  const allowed = pass ? availability.canPass : availability.canReject;
  if (allowed) return null;
  return {
    status:
      Number(
        pass
          ? availability.passBlockedStatus
          : availability.rejectBlockedStatus,
      ) || 403,
    reason: pass
      ? availability.passBlockedReason ||
        availability.reviewBlockedReason ||
        "当前状态暂不能通过"
      : availability.rejectBlockedReason ||
        availability.reviewBlockedReason ||
        "当前状态暂不能驳回",
    code: availability.deliveryState || null,
    supersededBy: availability.supersededBy || null,
  };
}

function recordAiReconciliationOutcome(item, action, settled, actor, reason) {
  const reconciledAt = new Date().toISOString();
  if (item.refType === "content_employee_run" && Number(item.refId) > 0) {
    const run = q.get(
      `SELECT snapshot_json FROM content_employee_runs
      WHERE tenant_id=? AND id=?`,
      curTenant(),
      item.refId,
    );
    if (!run) return;
    const snapshot = parsePayload(run.snapshot_json, {});
    snapshot.billing = {
      state: action === "settle" ? "settled" : "released",
      holdId: item.holdId,
      heldCredits: 0,
      chargedCredits: Number(settled.credits || 0),
      credits: Number(settled.credits || 0),
      balance: settled.balance,
      model: action === "settle" ? item.business.model : null,
      reconciledAt,
      reconciledBy: { id: actor.id, name: actor.name, role: actor.role },
      note: reason,
    };
    if (action === "release") {
      snapshot.contractValid = false;
      snapshot.reconciliation = {
        action: "quality_quarantine_and_release",
        reason,
        reconciledAt,
      };
      q.run(
        `UPDATE materials SET source_type='content_employee_run_quality_quarantine',
          note=CASE WHEN COALESCE(note,'')='' THEN ? ELSE note || '；' || ? END
        WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?`,
        `运行#${item.refId}对账确认没有通过交付门禁的产物，素材只读隔离`,
        `运行#${item.refId}对账确认没有通过交付门禁的产物，素材只读隔离`,
        curTenant(),
        item.refId,
      );
      const linkedContents = q.all(
        `SELECT id FROM contents
        WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?`,
        curTenant(),
        item.refId,
      );
      for (const content of linkedContents) {
        q.run(
          `UPDATE contents SET status='已驳回' WHERE tenant_id=? AND id=?`,
          curTenant(),
          content.id,
        );
        q.run(
          `UPDATE biz_assets SET status='已归档',updated_at=datetime('now','localtime')
          WHERE tenant_id=? AND source_type='content' AND source_id=?`,
          curTenant(),
          content.id,
        );
        q.run(
          `UPDATE kb_docs SET enabled=0,updated_at=datetime('now','localtime')
          WHERE tenant_id=? AND source_type='content' AND source_id=?`,
          curTenant(),
          content.id,
        );
      }
    }
    q.run(
      `UPDATE content_employee_runs SET status=CASE WHEN ?='release' THEN '失败' ELSE status END,
        snapshot_json=?,updated_at=datetime('now','localtime')
      WHERE tenant_id=? AND id=?`,
      action,
      JSON.stringify(snapshot),
      curTenant(),
      item.refId,
    );
    return;
  }
  if (item.refType === "agent_task" && Number(item.refId) > 0) {
    const task = q.get(
      `SELECT output_id,employee_web_snapshot FROM agent_tasks
      WHERE tenant_id=? AND id=?`,
      curTenant(),
      item.refId,
    );
    if (!task) return;
    const evidence = parsePayload(task.employee_web_snapshot, {});
    evidence.billing = {
      state: action === "settle" ? "settled" : "released",
      holdId: item.holdId,
      heldCredits: 0,
      chargedCredits: Number(settled.credits || 0),
      balance: settled.balance,
      model: action === "settle" ? item.business.model : null,
      reconciledAt,
      reconciledBy: { id: actor.id, name: actor.name, role: actor.role },
      note: reason,
    };
    q.run(
      `UPDATE agent_tasks SET status=CASE WHEN ?='release' THEN '失败' ELSE status END,
        employee_web_snapshot=? WHERE tenant_id=? AND id=?`,
      action,
      JSON.stringify(evidence),
      curTenant(),
      item.refId,
    );
    if (action === "release" && Number(task.output_id) > 0) {
      q.run(
        `UPDATE contents SET status='已驳回' WHERE tenant_id=? AND id=?`,
        curTenant(),
        task.output_id,
      );
      q.run(
        `UPDATE approvals SET status='已驳回',reviewer_id=?,reason=?,decided_at=datetime('now','localtime')
        WHERE tenant_id=? AND target_type='content' AND target_id=? AND status='待审核'`,
        actor.id,
        `账务对账确认产物业务暂不可采用：${reason}`.slice(0, 500),
        curTenant(),
        task.output_id,
      );
      q.run(
        `UPDATE biz_assets SET status='已归档',updated_at=datetime('now','localtime')
        WHERE tenant_id=? AND source_type='content' AND source_id=?`,
        curTenant(),
        task.output_id,
      );
      q.run(
        `UPDATE kb_docs SET enabled=0,updated_at=datetime('now','localtime')
        WHERE tenant_id=? AND source_type='content' AND source_id=?`,
        curTenant(),
        task.output_id,
      );
    }
  }
}

// ===== AI 预授权对账中心 =====
// 只允许依据已落库的业务主产物、运行时质量门、供应商模型与真实 token
// 做两种确定性处理：有效交付按证据结算；无效/无交付全额释放。未知业务
// 类型、重复 hold、缺流水或仍在正常执行窗口内的记录一律阻断，不靠人猜。
r.get(
  "/billing/reconciliation",
  requireRole("boss", "ops_director", "admin", "platform_super"),
  (req, res) => {
    const result = listAiReconciliationHolds({
      tenantId: curTenant(),
      limit: req.query.limit,
    });
    res.json({
      ...result,
      canResolve: ["boss", "admin", "platform_super"].includes(req.user.role),
    });
  },
);

r.post(
  "/billing/reconciliation/:id/resolve",
  requireRole("boss", "admin", "platform_super"),
  (req, res) => {
    const action = String(req.body?.action || "").trim();
    const reason = String(req.body?.reason || "").trim();
    const suppliedHash = String(req.body?.evidenceHash || "").trim();
    if (!["settle", "release"].includes(action)) {
      return res
        .status(400)
        .json({
          error:
            "对账动作必须明确选择按证据结算，或确认没有通过交付门禁的产物并退款",
        });
    }
    if (reason.length < 6 || reason.length > 300) {
      return res.status(400).json({ error: "请填写6到300字的对账依据" });
    }
    const item = inspectAiReconciliationHold({
      tenantId: curTenant(),
      holdId: req.params.id,
    });
    if (!item) return res.status(404).json({ error: "待对账预授权不存在" });
    if (
      !/^[a-f0-9]{64}$/u.test(suppliedHash) ||
      suppliedHash !== item.evidenceHash
    ) {
      return res
        .status(409)
        .json({
          error: "对账证据已变化，请刷新后重新核对，系统未执行扣费或退款",
        });
    }
    if (!item.availableActions.includes(action)) {
      return res
        .status(409)
        .json({ error: item.blockedReason || "当前证据不允许执行该对账动作" });
    }
    try {
      const pipelineReconciliation =
        item.refType === "content_production_pipeline_station";
      const specialProviderReconciliation =
        item.refType === "content_special_provider";
      const atomicReconciliation =
        pipelineReconciliation || specialProviderReconciliation;
      const hold = { holdId: item.holdId };
      const settled = atomicReconciliation
        ? pipelineReconciliation
          ? resolveContentPipelineReconciliation({
              tenantId: curTenant(),
              holdId: item.holdId,
              action,
              evidenceHash: suppliedHash,
              actor: req.user,
              reason,
            })
          : resolveContentSpecialProviderReconciliation({
              tenantId: curTenant(),
              holdId: item.holdId,
              action,
              evidenceHash: suppliedHash,
              actor: req.user,
              reason,
            })
        : action === "settle"
          ? settleHold(hold, {
              usage: {
                inputTokens: item.business.usage.inputTokens,
                outputTokens: item.business.usage.outputTokens,
              },
              model: item.business.model,
              aiMode: "api",
              note: `管理员依据持久化交付证据完成对账：${reason}`,
            })
          : releaseHold(
              hold,
              `管理员确认未形成可采纳交付并完成退款：${reason}`,
            );
      if (!settled) {
        return res
          .status(409)
          .json({ error: "该预授权已由其他请求处理，请刷新对账列表" });
      }
      if (!atomicReconciliation) {
        recordAiReconciliationOutcome(item, action, settled, req.user, reason);
      }
      logOp(
        req.user,
        "AI账务对账",
        action === "settle" ? "按证据结算" : "确认没有通过交付门禁的产物并退款",
        `hold#${item.holdId} / ${item.refType || "-"}#${item.refId || "-"} / ${reason}`,
      );
      return res.json({
        message:
          action === "settle"
            ? `已按真实模型与 token 证据结算 ${settled.credits} 积分`
            : `已确认没有通过交付门禁的产物，退回预授权 ${item.heldCredits} 积分`,
        action,
        holdId: item.holdId,
        credits: settled.credits,
        balance: settled.balance,
      });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message });
    }
  },
);

function approvalReviewerCandidates() {
  return q.all(
    `SELECT id,name,role,dept FROM users
    WHERE tenant_id=? AND status='启用' AND role IN ('ops_director','manager','admin')
    ORDER BY CASE role WHEN 'ops_director' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,name,id`,
    curTenant(),
  );
}

function assertConfiguredApprovalReviewers(policy) {
  const candidates = new Map(
    approvalReviewerCandidates().map((user) => [Number(user.id), user]),
  );
  const checks = [
    [
      "employeeOutput",
      policy.employeeOutput,
      new Set(["ops_director", "manager", "admin"]),
    ],
    ["activityPlan", policy.activityPlan, new Set(["ops_director", "admin"])],
    [
      "activityChecklist",
      policy.activityChecklist,
      new Set(["ops_director", "admin"]),
    ],
  ];
  for (const [key, route, roles] of checks) {
    if (!route.reviewerUserId) continue;
    const user = candidates.get(Number(route.reviewerUserId));
    if (!user || !roles.has(user.role)) {
      throw Object.assign(
        new Error(`${key}指定审批人不在当前企业的可用负责人范围内`),
        {
          status: 400,
          code: "APPROVAL_REVIEWER_INVALID",
        },
      );
    }
  }
}

// 企业审批规则：管理层、老板和管理员可查看，只有平台超级管理员能修改。
// 规则只影响之后创建的审批；在途审批继续使用自身不可变快照，避免
// “改配置后偷换审批人”。platform_super 仍在当前租户上下文中操作，
// 不从请求体接受任意 tenant_id，避免跨租户配置越权。
r.get(
  "/approval-policy",
  requireRole("boss", "ops_director", "manager", "admin", "platform_super"),
  (req, res) => {
    const canEdit = req.user.role === "platform_super";
    res.json({
      policy: loadApprovalRoutingPolicy(curTenant()),
      canEdit,
      reviewerCandidates: canEdit ? approvalReviewerCandidates() : [],
      immutableSafeguards: [
        "高风险事项始终由老板终审",
        "对外发布始终需要人工授权",
        "付费动作始终需要人工授权",
      ],
    });
  },
);

r.put("/approval-policy", requireRole("platform_super"), (req, res) => {
  try {
    const updatedAt = new Date().toISOString();
    const requestedPolicy = req.body?.policy ?? req.body;
    // API writes always emit v2. v1 is accepted by the read path/snapshot
    // parser only; an old client cannot accidentally persist a legacy mode.
    const policyInput =
      requestedPolicy &&
      typeof requestedPolicy === "object" &&
      !Array.isArray(requestedPolicy)
        ? { ...requestedPolicy, schemaVersion: APPROVAL_ROUTING_SCHEMA }
        : requestedPolicy;
    const policy = normalizeApprovalRoutingPolicy(policyInput, {
      configuredBy: {
        id: req.user.id,
        name: req.user.name,
        role: req.user.role,
      },
      updatedAt,
    });
    assertConfiguredApprovalReviewers(policy);
    setTenantConfig(APPROVAL_ROUTING_POLICY_KEY, policy);
    logOp(
      req.user,
      "审批中心",
      "更新企业审批规则",
      `规则版本=${policy.schemaVersion}`,
    );
    return res.json({
      ok: true,
      policy,
      message: "审批规则已保存；新任务按新规则流转，在途任务继续使用原规则快照",
    });
  } catch (error) {
    return res
      .status(error.status || 400)
      .json({ error: error.message, code: error.code });
  }
});

// ===== 审批中心（CTRL-04 横切）=====
r.get(
  "/approvals",
  requireRole("boss", "ops_director", "manager", "admin"),
  (req, res) => {
    const { status = "待审核" } = req.query;
    const visibility = approvalVisibilityClause(req.user);
    const requestedLimit = Number(req.query.limit);
    const requestedOffset = Number(req.query.offset);
    const limit =
      Number.isSafeInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(100, requestedLimit)
        : 50;
    const offset =
      Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
        ? requestedOffset
        : 0;
    const total = Number(
      q.get(
        `SELECT COUNT(*) n FROM approvals a
    WHERE a.tenant_id=? AND a.status=?${visibility.sql}`,
        curTenant(),
        status,
        ...visibility.params,
      )?.n || 0,
    );
    const rows = q
      .all(
        `SELECT a.*, u.name submitter, ru.name reviewer, au.name assigned_reviewer FROM approvals a
    LEFT JOIN users u ON u.id = a.submitter_id LEFT JOIN users ru ON ru.id = a.reviewer_id
    LEFT JOIN users au ON au.id = a.assigned_reviewer_id AND au.tenant_id=a.tenant_id
    WHERE a.tenant_id=? AND a.status=?${visibility.sql}
    ORDER BY a.created_at DESC,a.id DESC LIMIT ? OFFSET ?`,
        curTenant(),
        status,
        ...visibility.params,
        limit,
        offset,
      )
      .map((row) => {
        const availability = approvalDecisionAvailability(row, req.user);
        const superseded =
          availability.deliveryState === "DELIVERY_SUPERSEDED";
        return {
          ...row,
          ...(superseded
            ? {
                summary: "",
                payload: null,
                rules_hit: "[]",
                bodyAvailability: "superseded",
                businessUsable: false,
                auditRetention:
                  "旧版审批仅保留审计；业务处理请打开安全修订任务",
              }
            : {}),
          ...availability,
        };
      });
    res.setHeader("X-Total-Count", String(total));
    res.setHeader("Access-Control-Expose-Headers", "X-Total-Count");
    if (String(req.query.meta || "") === "1") {
      return res.json({
        rows,
        total,
        limit,
        offset,
        hasMore: offset + rows.length < total,
      });
    }
    return res.json(rows);
  },
);
r.post(
  "/approvals/:id/decide",
  requireRole("boss", "ops_director", "manager", "admin"),
  (req, res) => {
    const a = q.get(
      `SELECT * FROM approvals WHERE tenant_id = ${curTenant()} AND id = ?`,
      req.params.id,
    );
    if (!a) return res.status(404).json({ error: "审批不存在" });
    const { pass, reason } = req.body || {};
    if (typeof pass !== "boolean")
      return res
        .status(400)
        .json({ error: "人工审阅结果必须明确选择通过或驳回" });
    const availability = approvalDecisionAvailability(a, req.user);
    const blocked = approvalDecisionBlock(availability, pass);
    // 内容产出的权威审阅引擎还负责“同一决策重放”幂等以及脏状态自检。
    // 已处理内容仍交给它判定；待审行则严格复用 GET 返回的可用性。
    if (blocked && (a.target_type !== "content" || a.status === "待审核")) {
      return res.status(blocked.status).json({
        error: blocked.reason,
        ...(blocked.code ? { code: blocked.code } : {}),
        ...(blocked.supersededBy
          ? { supersededBy: blocked.supersededBy }
          : {}),
      });
    }
    if (a.target_type === "content") {
      try {
        const result = decideContentOutput({
          outputId: a.target_id,
          approvalId: a.id,
          actor: req.user,
          decision: pass ? "adopt" : "reject",
          reason,
        });
        if (!result.alreadyReviewed)
          logOp(req.user, "审批中心", pass ? "审批通过" : "审批驳回", a.title);
        return res.json(result);
      } catch (error) {
        return res.status(error.status || 500).json({
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.supersededBy
            ? { supersededBy: error.supersededBy }
            : {}),
        });
      }
    }
    if (!pass && !reason)
      return res.status(400).json({ error: "驳回必须填写理由" });
    if (a.target_type === "activity_checklist") {
      const payload = parsePayload(a.payload, {});
      const act = q.get(
        `SELECT * FROM activities WHERE tenant_id=${curTenant()} AND id=?`,
        a.target_id,
      );
      if (!act) return res.status(404).json({ error: "活动不存在" });
      const checklist = safeChecklist(act.checklist);
      const idx = Number(payload.checklistIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= checklist.length)
        return res.status(400).json({ error: "待确认事项不存在" });
      const item = { ...checklist[idx] };
      const label = checklistItemLabel(item, idx);
      if (payload.item && String(payload.item) !== label)
        return res
          .status(409)
          .json({ error: "待确认事项已被修改或调整顺序，请重新提交审批" });

      if (!pass) {
        item.done = false;
        item.approvalStatus = "已驳回";
        item.rejectedBy = {
          id: req.user.id,
          name: req.user.name,
          role: req.user.role,
        };
        item.rejectedAt = new Date().toISOString();
        item.rejectReason = reason || "";
        checklist[idx] = item;
        immediateTransaction(() => {
          markApprovalDecision(a, req.user, pass, reason);
          q.run(
            "UPDATE activities SET checklist = ? WHERE tenant_id=? AND id = ?",
            JSON.stringify(checklist),
            curTenant(),
            act.id,
          );
          if (a.submitter_id)
            notify(
              a.submitter_id,
              "活动审批",
              `待确认事项被驳回：${act.title}`,
              `事项：${label}；驳回人：${req.user.name}；原因：${reason || "-"}`,
            );
          notifyRoleUsers(
            ["boss", "ops_director", "admin"],
            "活动审批",
            `待确认事项已驳回：${act.title}`,
            `${label}；${req.user.name} 驳回：${reason || "-"}`,
          );
        });
        const tid = curTenant();
        setImmediate(() =>
          import("../engines/feishu.js")
            .then(({ pushFeishuToManagers }) =>
              pushFeishuToManagers(
                {
                  title: "待确认事项审批驳回",
                  lines: [
                    `**${act.title}**`,
                    `事项：${label}`,
                    `审批节点：${levelLabel(a.approval_level)}`,
                    `处理人：${req.user.name}`,
                    `驳回理由：${reason || "-"}`,
                  ],
                  url: requestBaseUrl(req) + "/system",
                },
                tid,
              ),
            )
            .catch(() => {}),
        );
        logOp(
          req.user,
          "审批中心",
          "待确认事项驳回",
          `${act.title} / ${label}`,
        );
        return res.json({
          ok: true,
          message: "已驳回，提交人可调整后重新提交",
        });
      }

      const workflow = lockedApprovalWorkflow(a);
      const nextStep =
        req.user.role === "boss"
          ? null
          : workflow.kind === "configured"
            ? workflow.next
            : a.approval_level === "ops_director"
              ? { level: "boss", assignedReviewerId: null }
              : null;
      if (nextStep) {
        const nextPayload = {
          ...payload,
          item: label,
          opsReviewer: {
            id: req.user.id,
            name: req.user.name,
            role: req.user.role,
          },
        };
        const next = immediateTransaction(() => {
          markApprovalDecision(a, req.user, pass, reason);
          const inserted = q.run(
            `INSERT INTO approvals(
          target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,payload,
          approval_level,parent_id,assigned_reviewer_id,approval_policy_snapshot
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            "activity_checklist",
            act.id,
            `待确认事项老板终审：${act.title} / ${label}`,
            `运营总监初审已通过；事项：${label}；通过老板终审后自动标记完成并同步管理层。`,
            "high",
            JSON.stringify(["ACTIVITY_CHECKLIST_FINAL_REVIEW"]),
            "待审核",
            a.submitter_id || req.user.id,
            JSON.stringify(nextPayload),
            nextStep.level,
            a.id,
            nextStep.assignedReviewerId,
            workflow.nextSnapshot
              ? JSON.stringify(workflow.nextSnapshot)
              : null,
          );
          item.approvalStatus = "总审中";
          item.opsApprovedBy = {
            id: req.user.id,
            name: req.user.name,
            role: req.user.role,
          };
          item.opsApprovedAt = new Date().toISOString();
          item.approvalId = inserted.lastInsertRowid;
          checklist[idx] = item;
          q.run(
            "UPDATE activities SET checklist = ? WHERE tenant_id=? AND id = ?",
            JSON.stringify(checklist),
            curTenant(),
            act.id,
          );
          notifyRoleUsers(
            ["boss"],
            "活动审批",
            `待确认事项待老板终审：${act.title}`,
            `${req.user.name} 已通过初审；事项：${label}`,
          );
          return inserted;
        });
        const tid = curTenant();
        setImmediate(() =>
          import("../engines/feishu.js")
            .then(({ pushFeishuToManagers }) =>
              pushFeishuToManagers(
                {
                  title: "待确认事项待老板终审",
                  lines: [
                    `**${act.title}**`,
                    `事项：${label}`,
                    `初审人：${req.user.name}`,
                    "老板终审通过后，系统会自动标记完成并同步给管理层。",
                  ],
                  url: requestBaseUrl(req) + "/system",
                },
                tid,
              ),
            )
            .catch(() => {}),
        );
        logOp(
          req.user,
          "审批中心",
          "待确认事项初审通过",
          `${act.title} / ${label}`,
        );
        return res.json({
          ok: true,
          nextApprovalId: next.lastInsertRowid,
          message: "初审已通过，已转老板终审",
        });
      }

      item.done = true;
      item.approvalStatus = "已通过";
      item.approvedBy = {
        id: req.user.id,
        name: req.user.name,
        role: req.user.role,
      };
      item.approvedAt = new Date().toISOString();
      item.completedAt = item.approvedAt;
      checklist[idx] = item;
      const ownerAuthorizedExternalSync = req.user.role === "boss";
      immediateTransaction(() => {
        markApprovalDecision(a, req.user, pass, reason);
        q.run(
          "UPDATE activities SET checklist = ? WHERE tenant_id=? AND id = ?",
          JSON.stringify(checklist),
          curTenant(),
          act.id,
        );
        if (a.submitter_id)
          notify(
            a.submitter_id,
            "活动审批",
            `待确认事项审批通过：${act.title}`,
            `事项「${label}」已自动标记完成。`,
          );
        notifyRoleUsers(
          ["boss", "ops_director", "admin"],
          "活动审批",
          `待确认事项审批通过：${act.title}`,
          `事项「${label}」已完成；审批人：${req.user.name}。`,
        );
      });
      if (ownerAuthorizedExternalSync) {
        const tid = curTenant();
        setImmediate(() =>
          import("../engines/feishu.js")
            .then(({ pushFeishuToManagers }) =>
              pushFeishuToManagers(
                {
                  title: "待确认事项审批通过",
                  lines: [
                    `**${act.title}**`,
                    `事项：${label}`,
                    `审批人：${req.user.name}`,
                    "结果：已自动标记完成，并同步给管理层。",
                  ],
                  url: requestBaseUrl(req) + "/activities",
                },
                tid,
              ),
            )
            .catch(() => {}),
        );
      }
      logOp(
        req.user,
        "审批中心",
        "待确认事项审批通过",
        `${act.title} / ${label}`,
      );
      return res.json({
        ok: true,
        externalSync: ownerAuthorizedExternalSync ? "queued" : "not_authorized",
        message: ownerAuthorizedExternalSync
          ? "终审已通过，事项已完成并同步管理层提醒"
          : "负责人审批已通过，事项已完成；未执行外部消息同步",
      });
    }
    if (a.target_type === "activity_plan") {
      const payload = parsePayload(a.payload, {});
      const act = q.get(
        `SELECT * FROM activities WHERE tenant_id=${curTenant()} AND id=?`,
        a.target_id,
      );
      if (!act) return res.status(404).json({ error: "活动不存在" });
      if (
        (a.approval_policy_snapshot && !payload.activitySnapshot) ||
        (payload.activitySnapshot &&
          !activityApprovalSubjectMatches(payload.activitySnapshot, act))
      ) {
        return res.status(409).json({
          error:
            "活动预算、日期、地点或目标在提交后已改变，旧审批已失效；请按当前数据重新提交",
          code: "ACTIVITY_APPROVAL_SUBJECT_CHANGED",
        });
      }
      const currentPlan = parsePayload(act.plan, {});
      const plan = payload.plan || currentPlan;
      if (
        payload.plan &&
        JSON.stringify(payload.plan) !== JSON.stringify(currentPlan)
      ) {
        return res
          .status(409)
          .json({
            error: "活动方案在提交审批后已被修改，请重新提交，系统未批准旧稿",
          });
      }
      if (!pass) {
        immediateTransaction(() => {
          markApprovalDecision(a, req.user, pass, reason);
          q.run(
            `UPDATE activities SET plan_status='已驳回',plan_approval_id=? WHERE tenant_id=? AND id=?`,
            a.id,
            curTenant(),
            act.id,
          );
          if (a.submitter_id)
            notify(
              a.submitter_id,
              "活动审批",
              `活动策划被驳回：${act.title}`,
              reason || "请修改后重新提交",
            );
          notifyRoleUsers(
            ["boss", "ops_director", "admin"],
            "活动审批",
            `活动策划已驳回：${act.title}`,
            `${req.user.name} 驳回：${reason || "-"}`,
          );
        });
        const tid = curTenant();
        setImmediate(() =>
          import("../engines/feishu.js")
            .then(({ pushFeishuToManagers }) =>
              pushFeishuToManagers(
                {
                  title: "活动策划审批驳回",
                  lines: [
                    `**${act.title}**`,
                    `审批节点：${levelLabel(a.approval_level)}`,
                    `处理人：${req.user.name}`,
                    `驳回理由：${reason || "-"}`,
                  ],
                  url: requestBaseUrl(req) + "/system",
                },
                tid,
              ),
            )
            .catch(() => {}),
        );
        logOp(req.user, "审批中心", "活动策划驳回", a.title);
        return res.json({
          ok: true,
          message: "已驳回，提交人可修改后重新提交",
        });
      }
      const workflow = lockedApprovalWorkflow(a);
      const nextStep =
        req.user.role === "boss"
          ? null
          : workflow.kind === "configured"
            ? workflow.next
            : a.approval_level === "ops_director"
              ? { level: "boss", assignedReviewerId: null }
              : null;
      if (nextStep) {
        const next = immediateTransaction(() => {
          markApprovalDecision(a, req.user, pass, reason);
          const inserted = q.run(
            `INSERT INTO approvals(
          target_type,target_id,title,summary,risk_level,rules_hit,status,submitter_id,payload,
          approval_level,parent_id,assigned_reviewer_id,approval_policy_snapshot
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            "activity_plan",
            act.id,
            `活动策划老板终审：${act.title}`,
            `运营总监初审已通过；${planSummary(plan)}`,
            "high",
            JSON.stringify(["ACTIVITY_PLAN_FINAL_REVIEW"]),
            "待审核",
            a.submitter_id || req.user.id,
            JSON.stringify(payload),
            nextStep.level,
            a.id,
            nextStep.assignedReviewerId,
            workflow.nextSnapshot
              ? JSON.stringify(workflow.nextSnapshot)
              : null,
          );
          q.run(
            `UPDATE activities SET plan_status='总审中',plan_approval_id=? WHERE tenant_id=? AND id=?`,
            inserted.lastInsertRowid,
            curTenant(),
            act.id,
          );
          notifyRoleUsers(
            ["boss"],
            "活动审批",
            `活动策划待老板终审：${act.title}`,
            `${req.user.name} 已通过初审，等待老板终审。${planSummary(plan)}`,
          );
          return inserted;
        });
        const tid = curTenant();
        setImmediate(() =>
          import("../engines/feishu.js")
            .then(({ pushFeishuToManagers }) =>
              pushFeishuToManagers(
                {
                  title: "活动策划待老板终审",
                  lines: [
                    `**${act.title}**`,
                    `初审人：${req.user.name}`,
                    `日期：${act.date || "-"} ｜ 地点：${act.location || "-"}`,
                    `方案摘要：${planSummary(plan)}`,
                    "老板终审通过后，系统会自动创建/更新飞书日历并推送给管理层。",
                  ],
                  url: requestBaseUrl(req) + "/system",
                },
                tid,
              ),
            )
            .catch(() => {}),
        );
        logOp(req.user, "审批中心", "活动策划初审通过", a.title);
        return res.json({
          ok: true,
          nextApprovalId: next.lastInsertRowid,
          message: "初审已通过，已转老板终审",
        });
      }
      const ownerAuthorizedExternalSync = req.user.role === "boss";
      immediateTransaction(() => {
        markApprovalDecision(a, req.user, pass, reason);
        q.run(
          `UPDATE activities SET plan=?,plan_status='已通过',plan_approved_at=datetime('now','localtime'),plan_approval_id=?,
        status=CASE WHEN status='策划中' THEN '筹备中' ELSE status END WHERE tenant_id=? AND id=?`,
          JSON.stringify(plan),
          a.id,
          curTenant(),
          act.id,
        );
        notifyRoleUsers(
          ["boss", "ops_director", "admin"],
          "活动审批",
          `活动策划审批通过：${act.title}`,
          ownerAuthorizedExternalSync
            ? "老板已授权，正在同步飞书日历并推送给管理层。"
            : "内部方案已通过；本次没有老板外部授权，未同步飞书日历。",
        );
      });
      const updated = q.get(
        `SELECT * FROM activities WHERE tenant_id=${curTenant()} AND id=?`,
        act.id,
      );
      if (ownerAuthorizedExternalSync) {
        const tid = curTenant();
        const actor = {
          id: req.user.id,
          name: req.user.name,
          role: req.user.role,
        };
        setImmediate(() =>
          import("../engines/feishu.js")
            .then(({ syncActivityLifecycleToFeishu }) =>
              syncActivityLifecycleToFeishu(updated, {
                tid,
                actor,
                action: "approved",
                url: requestBaseUrl(req) + "/activities",
              }),
            )
            .catch(() => {}),
        );
      }
      logOp(
        req.user,
        "审批中心",
        ownerAuthorizedExternalSync
          ? "活动策划终审通过并同步日历"
          : "活动策划负责人审批通过（未外部同步）",
        a.title,
      );
      return res.json({
        ok: true,
        externalSync: ownerAuthorizedExternalSync ? "queued" : "not_authorized",
        message: ownerAuthorizedExternalSync
          ? "终审已通过，已开始同步飞书日历和管理层提醒"
          : "负责人审批已通过，方案已进入筹备；未执行飞书日历同步",
      });
    }
    immediateTransaction(() => markApprovalDecision(a, req.user, pass, reason));
    logOp(req.user, "审批中心", pass ? "审批通过" : "审批驳回", a.title);
    res.json({ ok: true });
  },
);

// ===== 知识库（KB-01~04）=====
function kbSupersessionProjection(doc) {
  const supersededBy = loadKbDocSupersession(doc, {
    tenantId: curTenant(),
  });
  return supersededBy
    ? {
        deliveryState: "DELIVERY_SUPERSEDED",
        bodyAvailability: "superseded",
        businessUsable: false,
        supersededBy,
      }
    : null;
}

function projectKbDoc(doc) {
  const superseded = kbSupersessionProjection(doc);
  if (!superseded) return doc;
  return {
    ...doc,
    // 旧正文和原文件路径仅保留在底层审计存储；普通
    // KB 列表不是审计出口，不能成为取代后的读取/下载旁路。
    body: "",
    file_path: null,
    enabled: 0,
    ...superseded,
    auditRetention: "旧版仅保留审计；业务使用请打开安全修订任务",
  };
}

function sendSupersededKbError(res, projection) {
  return res.status(409).json({
    error: `该知识来自已被安全修订任务 #${projection.supersededBy?.taskId} 取代的旧报告，不能重新启用、修改或删除`,
    code: "DELIVERY_SUPERSEDED",
    supersededBy: projection.supersededBy || null,
  });
}

r.get("/kb", (req, res) => {
  const { category } = req.query;
  let where = "";
  const params = [];
  if (category) {
    where = "AND category = ?";
    params.push(category);
  }
  let rows = q.scopedAll(
    "kb_docs",
    `${where} ORDER BY category, ref_count DESC`,
    ...params,
  ); // 作用域包装自动追加 tenant_id 过滤（BE-C2）
  // 查看权限（FR-SYS-09）：visible_roles 为空=全员可见；老板/管理员/总监（管理者）全见
  if (!["boss", "admin", "ops_director"].includes(req.user.role)) {
    rows = rows.filter((d) => {
      return roleListAllows(d.visible_roles, req.user.role);
    });
  }
  res.json(rows.map(projectKbDoc));
});

// 知识库分类管理（每家企业自定义自己的分类体系；未改则用平台推荐默认）
const DEFAULT_KB_CATS = [
  "品牌资料",
  "招商政策",
  "产品资料",
  "话术案例",
  "客户画像",
  "数据规范",
  "员工产出",
];

function kbVectorReadinessPayload() {
  const vector = kbVectorReadiness();
  const providerConfigured = aiAvailable();
  if (vector.state === "needs_backfill" && !providerConfigured) {
    return {
      ...vector,
      state: "provider_unavailable",
      message: `AI 向量服务未配置，${vector.missingDocs} 条知识尚不能生成语义向量`,
      providerConfigured,
      canBackfill: false,
    };
  }
  return {
    ...vector,
    providerConfigured,
    canBackfill: vector.canBackfill && providerConfigured,
  };
}

r.get("/kb/categories", (req, res) => {
  res.json(getTenantConfig("kb_categories", DEFAULT_KB_CATS));
});
r.post("/kb/categories", requireRole("boss", "admin"), (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== "string" || !name.trim())
    return res.status(400).json({ error: "分类名必填" });
  const cats = getTenantConfig("kb_categories", DEFAULT_KB_CATS); // 首次自定义从平台默认起步，不会丢掉默认分类
  const n = String(name).trim();
  if (n.length > 60) return res.status(400).json({ error: "分类名最长60字" });
  if (!Array.isArray(cats) || cats.length >= 50)
    return res.status(400).json({ error: "知识库分类最多50个" });
  if (cats.includes(n)) return res.status(400).json({ error: "分类已存在" });
  cats.splice(Math.max(0, cats.indexOf("员工产出")), 0, n); // 插在员工产出前
  setTenantConfig("kb_categories", cats);
  logOp(req.user, "系统管理", "新增知识库分类", n);
  res.json(cats);
});
r.post("/kb", requireRole("boss", "ops_director", "admin"), (req, res) => {
  let category;
  let title;
  let body;
  try {
    category = normalizedKbCategory(req.body?.category, { required: true });
    title = normalizedKbText(req.body?.title, "知识标题", 200, {
      required: true,
    });
    body = normalizedKbText(req.body?.body, "知识内容", 60000, {
      required: true,
    });
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  let result;
  try {
    db.exec("BEGIN IMMEDIATE");
    result = q.run(
      "INSERT INTO kb_docs(category,title,body) VALUES(?,?,?)",
      category,
      title,
      body,
    );
    q.run(
      "INSERT INTO biz_assets(name,category,value,status,owner,source_type,source_id,creator_id,note) VALUES(?,?,?,?,?,?,?,?,?)",
      title,
      "知识资产",
      5000,
      "使用中",
      "知识库",
      "kb",
      result.lastInsertRowid,
      req.user.id,
      `知识库手动新增：${req.user.name || "管理员"}录入「${category}」`,
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    return res.status(500).json({ error: "知识入库失败，本次未保存任何数据" });
  }
  embedDoc(result.lastInsertRowid, title, body);
  logOp(req.user, "系统管理", "新增知识库", title);
  res.json({ id: result.lastInsertRowid });
});
r.put("/kb/:id", requireRole("boss", "ops_director", "admin"), (req, res) => {
  // 租户隔离：先确认该文档属于本企业，杜绝凭外部 id 改到别家知识库（跨租户写）
  const own = q.get(
    `SELECT * FROM kb_docs WHERE tenant_id = ${curTenant()} AND id=?`,
    req.params.id,
  );
  if (!own) return res.status(404).json({ error: "知识库文档不存在" });
  const superseded = kbSupersessionProjection(own);
  if (superseded) return sendSupersededKbError(res, superseded);
  let title;
  let body;
  let category;
  let visibleRoles;
  let callableRoles;
  try {
    title = normalizedKbText(req.body?.title, "知识标题", 200, {
      required: true,
    });
    body = normalizedKbText(req.body?.body, "知识内容", 60000, {
      required: true,
    });
    category = normalizedKbCategory(req.body?.category, { required: true });
    visibleRoles = normalizedKbRoleJson(req.body?.visible_roles, "可见权限");
    callableRoles = normalizedKbRoleJson(
      req.body?.callable_roles,
      "AI调用权限",
    );
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  if (
    req.body?.enabled !== undefined &&
    typeof req.body.enabled !== "boolean" &&
    ![0, 1].includes(req.body.enabled)
  ) {
    return res.status(400).json({ error: "启用状态格式不正确" });
  }
  const sets = [];
  const values = [];
  const add = (sql, value) => {
    sets.push(sql);
    values.push(value);
  };
  if (visibleRoles !== undefined) add("visible_roles=?", visibleRoles);
  if (callableRoles !== undefined) add("callable_roles=?", callableRoles);
  if (category !== undefined) add("category=?", category);
  if (title !== undefined) add("title=?", title);
  if (body !== undefined) add("body=?", body);
  if (req.body?.enabled !== undefined)
    add("enabled=?", req.body.enabled ? 1 : 0);
  if (title !== undefined || body !== undefined)
    sets.push(`version=version+1`, `updated_at=datetime('now','localtime')`);
  if (sets.length) {
    try {
      db.exec("BEGIN IMMEDIATE");
      q.run(
        `UPDATE kb_docs SET ${sets.join(",")} WHERE tenant_id=? AND id=?`,
        ...values,
        curTenant(),
        req.params.id,
      );
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* no active transaction */
      }
      return res.status(500).json({ error: "知识更新失败，本次修改已撤销" });
    }
  }
  const updated = q.get(
    `SELECT * FROM kb_docs WHERE tenant_id = ${curTenant()} AND id=?`,
    req.params.id,
  );
  if (title !== undefined || body !== undefined)
    embedDoc(updated.id, updated.title, updated.body);
  res.json(updated);
});

function kbAssetRows(doc) {
  return q.all(
    `SELECT DISTINCT a.* FROM biz_assets a WHERE a.tenant_id=? AND (
      (a.source_type='kb' AND a.source_id=?)
      OR (a.source_type='uploaded_file' AND EXISTS (
        SELECT 1 FROM uploaded_files f WHERE f.tenant_id=a.tenant_id AND f.id=a.source_id AND f.file_url=?
      ))
      OR (a.source_type='artifact' AND EXISTS (
        SELECT 1 FROM generated_artifacts g WHERE g.tenant_id=a.tenant_id AND g.id=a.source_id AND (g.kb_doc_id=? OR g.file_url=?)
      ))
    ) ORDER BY a.id`,
    curTenant(),
    doc.id,
    doc.file_path,
    doc.id,
    doc.file_path,
  );
}

function kbDeletePolicy(req, doc) {
  const asset = kbAssetRows(doc).at(-1);
  const creatorId = asset?.creator_id || null;
  const critical =
    Number(doc.enabled || 0) === 1 ||
    Number(doc.ref_count || 0) > 0 ||
    doc.category === "员工产出";
  if (critical)
    return {
      allowed: isBossLike(req.user),
      requiredRole: "boss",
      reason: "已启用/已被引用的知识库会影响AI回答，需老板/管理员删除",
    };
  if (isBossLike(req.user))
    return {
      allowed: true,
      requiredRole: "boss",
      reason: "老板/管理员删除知识库",
    };
  if (
    isManagerLike(req.user) &&
    (!creatorId || canAccessOwner(req.user, creatorId))
  ) {
    return {
      allowed: true,
      requiredRole: "manager",
      reason: "管理层删除待启用知识库",
    };
  }
  const ownPending = creatorId && Number(creatorId) === Number(req.user.id);
  return {
    allowed: ownPending,
    requiredRole: ownPending ? "self" : "manager",
    reason: ownPending
      ? "本人撤回待启用上传资料"
      : "该知识库不属于本人，需管理层处理",
  };
}

r.delete("/kb/:id", (req, res) => {
  const d = q.get(
    `SELECT * FROM kb_docs WHERE tenant_id = ${curTenant()} AND id=?`,
    req.params.id,
  );
  if (!d) return res.status(404).json({ error: "知识库文档不存在" });
  const superseded = kbSupersessionProjection(d);
  if (superseded) return sendSupersededKbError(res, superseded);
  const policy = kbDeletePolicy(req, d);
  if (!policy.allowed)
    return deletionDenied(res, policy.requiredRole, policy.reason);
  const assetRows = kbAssetRows(d);
  const assetIds = assetRows.map((x) => x.id);
  const chunkRows = q.all(
    `SELECT kc.* FROM kb_chunks kc
    JOIN kb_docs kd ON kd.id=kc.doc_id
    WHERE kd.tenant_id=? AND kd.id=? ORDER BY kc.id`,
    curTenant(),
    d.id,
  );
  const children = {
    kb_chunks: chunkRows,
    biz_assets: assetRows,
    asset_flows: assetIds.length
      ? q.all(
          `SELECT * FROM asset_flows WHERE tenant_id=? AND asset_id IN (${assetIds.map(() => "?").join(",")})`,
          curTenant(),
          ...assetIds,
        )
      : [],
  };
  const archiveId = archiveAndDelete(
    req,
    {
      entityType: "kb_doc",
      entityId: d.id,
      table: "kb_docs",
      row: d,
      children,
      module: "系统管理",
      title: d.title,
      summary: `${d.category || "-"}；启用=${d.enabled ? "是" : "否"}；引用${d.ref_count || 0}次${d.file_name ? `；附件=${d.file_name}` : ""}`,
      requiredRole: policy.requiredRole,
      reason: req.body?.reason || policy.reason,
    },
    () => {
      if (assetIds.length) {
        q.run(
          `DELETE FROM asset_flows WHERE tenant_id=? AND asset_id IN (${assetIds.map(() => "?").join(",")})`,
          curTenant(),
          ...assetIds,
        );
        q.run(
          `DELETE FROM biz_assets WHERE tenant_id=? AND id IN (${assetIds.map(() => "?").join(",")})`,
          curTenant(),
          ...assetIds,
        );
      }
      q.run(
        `UPDATE generated_artifacts SET kb_doc_id=NULL,status='可用',updated_at=datetime('now','localtime')
      WHERE tenant_id=? AND kb_doc_id=?`,
        curTenant(),
        d.id,
      );
      q.run(
        `DELETE FROM kb_chunks WHERE doc_id IN (
      SELECT id FROM kb_docs WHERE tenant_id=? AND id=?
    )`,
        curTenant(),
        d.id,
      );
      deleteList("kb_docs", "id=?", d.id);
    },
  );
  logOp(
    req.user,
    "系统管理",
    "删除知识库入回收站",
    `${d.title} / archive#${archiveId}`,
  );
  res.json({
    ok: true,
    archiveId,
    message: "已删除并进入回收站，老板/管理员可恢复",
  });
});
// ===== 知识库文件上传（FR-SYS-08：文档/图片，自动提取内容；图片走AI识图）=====
r.post("/kb/upload", async (req, res) => {
  // 全员可上传：员工/合伙人上传自动「待启用」，管理员审核后进入AI引用
  let storedPath = "";
  let persisted = false;
  let keepStoredFile = false;
  let retryMode = "";
  let billing = null;
  let fileUrl = "";
  try {
    if (
      typeof req.body?.name !== "string" ||
      typeof req.body?.b64 !== "string"
    ) {
      return res.status(400).json({ error: "文件名与文件内容必须是文本" });
    }
    const name = req.body.name.trim();
    const category =
      typeof req.body?.category === "string"
        ? req.body.category.trim()
        : "品牌资料";
    const b64 = req.body.b64;
    if (!name || !b64)
      return res.status(400).json({ error: "文件名与文件内容必填" });
    if (name.length > 200)
      return res.status(400).json({ error: "文件名最长200字" });
    const categories = getTenantConfig("kb_categories", DEFAULT_KB_CATS);
    if (!category || category.length > 60 || !categories.includes(category))
      return res.status(400).json({ error: "请选择本企业已配置的知识库分类" });
    const ext = String(name.split(".").pop() || "").toLowerCase();
    const { extractText, IMAGE_EXTS, ALLOWED_EXTS } =
      await import("../engines/extract.js");
    if (!ALLOWED_EXTS.includes(ext))
      return res
        .status(400)
        .json({
          error: `不支持的格式 .${ext}（支持：docx/xlsx/pdf/txt/md/csv/json/png/jpg/webp）`,
        });
    const buf = decodeBase64File(b64, MAX_FILE_BYTES);
    const normalizeRoles = (value, label) => {
      if (value === undefined || value === null) return null;
      if (!Array.isArray(value) || value.length > KB_ROLE_SET.size)
        throw Object.assign(new Error(`${label}格式不正确`), { status: 400 });
      const roles = [...new Set(value.map((role) => String(role).trim()))];
      if (roles.some((role) => !KB_ROLE_SET.has(role)))
        throw Object.assign(new Error(`${label}包含无效角色`), { status: 400 });
      return roles.length ? JSON.stringify(roles) : null;
    };
    // 先完成所有会拒绝请求的字段校验，再写磁盘，避免无效请求留下孤儿文件。
    const vr = normalizeRoles(req.body.visibleRoles, "可见权限");
    const cr = normalizeRoles(req.body.callableRoles, "AI调用权限");
    const isImage = IMAGE_EXTS.includes(ext);
    const isManager = ["boss", "ops_director", "admin"].includes(req.user.role);
    const title = name.replace(/\.[^.]+$/, "");
    // 租户独立目录 + 强随机文件名，避免同名同毫秒上传互相覆盖。
    const dir = path.join(KB_UPLOAD_ROOT, String(curTenant()));
    fs.mkdirSync(dir, { recursive: true });
    const safeName =
      path
        .basename(name)
        .replace(/[^\w.\u4e00-\u9fa5-]/g, "_")
        .slice(0, 140) || `upload.${ext}`;
    const safe = `${Date.now()}-${crypto.randomBytes(5).toString("hex")}-${safeName}`;
    storedPath = path.join(dir, safe);
    fs.writeFileSync(storedPath, buf, { flag: "wx" });
    fileUrl = `/uploads/kb/${curTenant()}/${encodeURIComponent(safe)}`;
    // 图片原文件一旦通过校验即作为可重试底稿保留；AI 或数据库失败不能让用户重新上传。
    keepStoredFile = isImage;

    let body = "";
    let extractMode = "";
    let extractionReady = false;
    const persistArchive = ({ archiveBody, archiveMode, ready }) =>
      withImmediateTransaction(db, () => {
        const enabled = isManager && ready ? 1 : 0; // 无可读正文时不得进入AI引用
        const result = q.run(
          "INSERT INTO kb_docs(category,title,body,enabled,file_path,file_type,file_name,visible_roles,callable_roles) VALUES(?,?,?,?,?,?,?,?,?)",
          category,
          title,
          archiveBody,
          enabled,
          fileUrl,
          ext,
          name,
          vr,
          cr,
        );
        q.run(
          "INSERT INTO biz_assets(name,category,value,status,owner,source_type,source_id,creator_id,url,note) VALUES(?,?,?,?,?,?,?,?,?,?)",
          title,
          "知识资产",
          5000,
          "使用中",
          "知识库",
          "kb",
          result.lastInsertRowid,
          req.user.id,
          fileUrl,
          `知识库文件上传：${name}；提取方式=${archiveMode}；上传人=${req.user.name || "-"}`,
        );
        return {
          id: Number(result.lastInsertRowid),
          enabled,
          body: archiveBody,
          extractMode: archiveMode,
        };
      });

    let archive;
    if (isImage) {
      const visionSystem =
        "你是餐饮企业知识库管理员。请把这张图片转写为可供AI引用的知识条目：①一句话说明图片是什么 ②逐条提取图中的关键信息（文字、数据、流程、菜品、价格表等，尽量完整）③适用场景 ④需要负责人核验的内容。不得补写图片中不存在的数据，直接输出内容。";
      const visionUserText = `文件名：${name}，知识分类：${category}。请提取图片内容。`;
      let hold = null;
      try {
        if (!yunwu.yunwuAvailable()) {
          throw Object.assign(new Error("识图通道未配置"), {
            status: 503,
            billingState: "not_started",
          });
        }
        const holdModel = yunwu.routing().vision;
        precheck(req.user.id, "text", holdModel);
        hold = holdCredits({
          userId: req.user.id,
          feature: "知识库·图片识别入库",
          kind: "text",
          model: holdModel,
          credits: estimateCallCredits({
            kind: "text",
            model: holdModel,
            texts: [visionSystem, visionUserText],
            outputTokens: 1200,
            // 视觉 token 与 base64 字符数并非一一对应；按原图体积保守占额并设上限。
            overheadTokens: Math.min(
              100000,
              Math.max(6000, Math.ceil(buf.length / 2)),
            ),
          }),
          refType: "kb_upload_vision",
          note: `知识库图片「${name}」在供应商调用前预授权；知识文档与资产未原子落库则全额退回。`,
        });
        const activeHold = hold;
        hold = null;
        const delivered = await executeHeldDelivery({
          hold: activeHold,
          generate: () =>
            yunwu.chat({
              model: holdModel,
              system: visionSystem,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: visionUserText },
                    {
                      type: "image_url",
                      image_url: {
                        url: `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${b64}`,
                      },
                    },
                  ],
                },
              ],
              maxTokens: 1200,
            }),
          persist: (out) => {
            const extracted = String(out.text || "").trim();
            if (!extracted) throw new Error("识图服务未返回可用正文");
            return persistArchive({
              archiveBody: `【图片附件】${name}\n${extracted}`,
              archiveMode: `AI识图（${out.model}）`,
              ready: true,
            });
          },
          settle: settleHold,
          release: releaseHold,
          settlement: (out) => ({
            usage: {
              inputTokens: out.inputTokens,
              outputTokens: out.outputTokens,
            },
            model: out.model,
            aiMode: "api",
            note: "知识库图片正文与知识资产已原子落库",
          }),
          requirePositiveApiUsage: true,
          releaseNote: "知识库图片识别或业务落库失败，预授权全额退回",
        });
        archive = delivered.delivery;
        billing = delivered.billing;
        body = archive.body;
        extractionReady = true;
        extractMode = archive.extractMode;
        persisted = true;
      } catch (error) {
        if (hold) {
          try {
            const released = releaseHold(
              hold,
              "知识库图片未进入供应商生成，预授权全额退回",
            );
            billing = twoPhaseBillingSummary({
              state: "released",
              hold,
              settled: released,
              note: "本次未调用供应商，预授权已全额退回。",
            });
          } catch (releaseError) {
            billing = twoPhaseBillingSummary({
              state: "pending_reconciliation",
              hold,
              error: releaseError,
              note: "本次未调用供应商，但预授权释放异常，已保留待人工对账。",
            });
          }
          hold = null;
        } else if (error.billing) {
          billing = error.billing;
        } else {
          billing = twoPhaseBillingSummary({
            state: "not_started",
            hold: null,
            error,
            note: "识图未启动或尚未形成占额，不会产生实扣。",
          });
        }
        body = "";
        extractMode = "图片已存档·识图待重试";
        retryMode = extractMode;
        extractionReady = false;
        // 上游识别或正式落库失败后，以独立事务保留“待重试”档案。
        // 这笔档案不是可交付识图产物，因此无论落库成功与否都不得触发结算。
        archive = persistArchive({
          archiveBody: "",
          archiveMode: extractMode,
          ready: false,
        });
        persisted = true;
      }
    } else {
      const text = extractText(buf, ext);
      if (text && text.trim()) {
        body = text.trim();
        extractionReady = true;
        extractMode = "自动提取正文";
      } else {
        body = "";
        extractMode = "仅存档（未识别正文）";
      }
      archive = persistArchive({
        archiveBody: body,
        archiveMode: extractMode,
        ready: extractionReady,
      });
      persisted = true;
    }

    if (extractionReady) {
      try {
        embedDoc(archive.id, title, body);
      } catch {
        /* 文档已入库，向量可稍后重建 */
      }
    }
    if (!isManager) {
      const mgrs = q.all(
        `SELECT id FROM users WHERE tenant_id = ${curTenant()} AND role IN ('boss','ops_director','admin')`,
      );
      for (const u of mgrs)
        notify(
          u.id,
          "知识库",
          `员工上传知识待审：${title}`,
          `${req.user.name} 上传「${name}」到「${category}」，启用后才会被AI引用`,
        );
    }
    logOp(req.user, "系统管理", "上传知识库文件", `${name}（${extractMode}）`);
    res.json({
      id: archive.id,
      title,
      body,
      fileUrl,
      fileType: ext,
      extractMode,
      enabled: archive.enabled,
      billing,
    });
  } catch (e) {
    if (storedPath && !persisted && !keepStoredFile) {
      try {
        fs.rmSync(storedPath, { force: true });
      } catch {
        /* best-effort orphan cleanup */
      }
    }
    const error = retryMode ? `${retryMode}：${e.message}` : e.message;
    res.status(e.status || 500).json({
      error,
      ...(retryMode
        ? {
            extractMode: retryMode,
            fileUrl,
            billing: e.billing || billing,
          }
        : {}),
    });
  }
});

// 资料缺口检测（FR-SYS-04 降级提示）
r.get("/kb/gaps", (req, res) => {
  const cats = DEFAULT_KB_CATS.filter((c) => c !== "员工产出");
  res.json(
    cats
      .map((c) => ({
        category: c,
        docs:
          q.get(
            `SELECT COUNT(*) n FROM kb_docs WHERE tenant_id = ${curTenant()} AND category=? AND enabled=1`,
            c,
          )?.n || 0,
      }))
      .filter((x) => x.docs === 0)
      .map((x) => ({
        ...x,
        hint: `上传「${x.category}」资料可解锁该领域AI精准模式，当前为通用模板模式`,
      })),
  );
});

const KB_INIT_DOCS = (tenant) => [
  {
    category: "品牌资料",
    title: "企业与品牌基础档案（系统初始化）",
    body: `# 企业与品牌基础档案\n\n- 企业名称：${tenant?.name || "待补充"}\n- 联系人：${tenant?.contact_name || "待补充"}\n- 当前套餐：${tenant?.plan || "标准版"}\n- 品牌主张：待企业负责人确认\n- 门店定位：待企业负责人确认\n\n## 待企业补充\n- 品牌故事、门店类型、核心菜品、目标客群、服务范围、创始人表达风格、禁用表述。`,
  },
  {
    category: "招商政策",
    title: "门店合作与渠道政策录入框架（系统初始化）",
    body: "# 门店合作与渠道政策\n\n## 必填信息\n- 适用合作：企业团餐、外卖平台、供应商、联名活动、加盟或连锁合作（按实际业务勾选）。\n- 合作条件、服务范围、双方职责、价格审批、结算方式、退出机制。\n- 折扣、返利、收益、区域授权等数字必须来自已生效的书面文件。\n\n## 风控边界\n未经审批不得承诺收益、保本、固定效果或独家权益，不得用口头表述替代正式合同。",
  },
  {
    category: "产品资料",
    title: "产品与服务资料录入框架（系统初始化）",
    body: "# 菜单与服务资料\n\n请按每项补充：菜品或套餐名称、规格、主要食材、过敏原、适用场景、真实卖点、标准话术、可搭配方案、可售时段和禁用表述。\n\n价格、库存、食安与营养信息不得由通用模板推测，引用时以门店当日记录和负责人确认为准。",
  },
  {
    category: "话术案例",
    title: "销售沟通与跟进SOP（系统初始化）",
    body: "# 顾客沟通与跟进SOP\n\n1. 首次沟通：先确认用餐人数、时间、口味、预算和过敏信息，不急于承诺。\n2. 预约到店：给出可核验的营业时间、位置和预订方式。\n3. 异议处理：先确认真实顾虑，再提供基于菜单与门店政策的选择。\n4. 用餐后跟进：征得同意后收集反馈，登记改进项；不编造顾客证言。\n5. 所有价格、优惠、库存和对外话术须人工确认后发送。",
  },
  {
    category: "客户画像",
    title: "客户画像字段与分层口径（系统初始化）",
    body: "# 客户画像与分层\n\n## 核心字段\n姓名、联系方式、公司/行业、身份标签、来源渠道、意向产品、预算等级、当前阶段、关键顾虑、决策人、下一步动作、负责人。\n\n## 分层原则\n- A类：需求明确、决策链清楚、近期有行动窗口。\n- B类：有需求但时间或条件未成熟。\n- C类：信息不足或长期培育。\n\n敏感个人信息仅按权限查看，不直接写入公开知识条目。",
  },
  {
    category: "数据规范",
    title: "经营数据口径与录入规范（系统初始化）",
    body: "# 经营数据口径\n\n- 新增线索：本周期首次进入系统且有合法来源的有效顾客或企业客户。\n- 邀约：已发出明确时间、地点或预约方式的邀请。\n- 到店/到场：顾客实际完成线下到店或线上活动参与。\n- 成交：已形成有效订单或确认回款。\n- 复购：历史成交顾客再次下单。\n- 活跃会员：周期内有到店、下单、反馈或经同意的互动记录。\n\n所有数据应有负责人、时间和来源；禁止重复累计，不得用内容产出推断真实成交。",
  },
  {
    category: "员工产出",
    title: "餐饮数字员工能力与调用地图（系统初始化）",
    body: `# 餐饮数字员工能力地图\n\n${RESTAURANT_DEPARTMENTS.map((item) => `${item.code} ${item.name}：${item.employeeCount} 位数字员工`).join("；")}。\n\n当前权威目录共 8 个分部、60 名餐饮数字员工。提问或派活时请说明门店现状、目标、约束、可核验输入和期望交付格式；食安、价格、财务、隐私与外部动作必须由负责人复核。`,
  },
];

r.get("/kb/readiness", (req, res) => {
  const docs = q.all(
    `SELECT category,COUNT(*) total,SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) enabled
    FROM kb_docs WHERE tenant_id=? GROUP BY category`,
    curTenant(),
  );
  const byCat = new Map(docs.map((x) => [x.category, x]));
  const categories = DEFAULT_KB_CATS.map((category) => {
    const row = byCat.get(category) || { total: 0, enabled: 0 };
    return {
      category,
      total: Number(row.total || 0),
      enabled: Number(row.enabled || 0),
      ready: Number(row.enabled || 0) > 0,
      hint:
        Number(row.enabled || 0) > 0
          ? "已可供AI调用"
          : `请上传或录入「${category}」，也可先执行初始化`,
    };
  });
  const ready = categories.filter((x) => x.ready).length;
  res.json({
    ready,
    total: categories.length,
    percent: Math.round((ready / categories.length) * 100),
    initialized: ready === categories.length,
    categories,
    vector: kbVectorReadinessPayload(),
  });
});

r.post("/kb/vector/backfill", requireRole("boss", "admin"), (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({
      error: "回填会调用真实向量服务并按实际持久化数量计费，请明确确认后再执行",
    });
  }
  const limit = req.body?.limit === undefined ? 10 : Number(req.body.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    return res.status(400).json({ error: "单次回填数量必须是1到20之间的整数" });
  }
  const before = kbVectorReadinessPayload();
  if (!before.backgroundEnabled) {
    return res.status(409).json({
      error:
        "后台向量化开关未启用；请先配置 ENABLE_BACKGROUND_EMBEDDINGS=true 并重启服务",
      vector: before,
    });
  }
  if (!before.providerConfigured) {
    return res.status(409).json({
      error: "AI 向量服务未配置，不能开始回填",
      vector: before,
    });
  }
  const result = backfillMissingEmbeddings({ userId: req.user.id, limit });
  const vector = kbVectorReadinessPayload();
  if (result.accepted > 0) {
    logOp(
      req.user,
      "系统管理",
      "回填知识库向量",
      `已排队${result.accepted}条；拒绝${result.rejected}条`,
    );
  }
  const payload = {
    ok: result.rejected === 0,
    ...result,
    vector,
    message:
      result.accepted > 0
        ? `已排队 ${result.accepted} 条知识，向量完成后自动按实际持久化数量结算`
        : "当前没有可回填的知识；运行中或待对账任务不会重复排队",
  };
  if (result.accepted === 0 && result.rejected > 0) {
    return res.status(409).json({
      ...payload,
      error: "没有向量任务成功入队，请检查积分余额和后台队列状态",
    });
  }
  return res.status(result.accepted > 0 ? 202 : 200).json(payload);
});

r.post(
  "/kb/initialize",
  requireRole("boss", "ops_director", "admin"),
  (req, res) => {
    const tenant = getTenant(curTenant()) || {};
    const docs = KB_INIT_DOCS(tenant);
    const created = [];
    const skipped = [];
    for (const doc of docs) {
      const existed = q.get(
        `SELECT id FROM kb_docs WHERE tenant_id=? AND title=?`,
        curTenant(),
        doc.title,
      );
      if (existed) {
        skipped.push(doc.title);
        continue;
      }
      const out = q.run(
        `INSERT INTO kb_docs(category,title,body,enabled) VALUES(?,?,?,1)`,
        doc.category,
        doc.title,
        doc.body,
      );
      embedDoc(out.lastInsertRowid, doc.title, doc.body);
      q.run(
        `INSERT INTO biz_assets(name,category,value,status,owner,source_type,source_id,creator_id,note)
      VALUES(?,?,?,?,?,?,?,?,?)`,
        doc.title,
        "知识资产",
        1000,
        "使用中",
        "知识库初始化",
        "kb",
        out.lastInsertRowid,
        req.user.id,
        "系统初始化基础知识，企业可继续编辑完善",
      );
      created.push({
        id: out.lastInsertRowid,
        category: doc.category,
        title: doc.title,
      });
    }
    logOp(
      req.user,
      "系统管理",
      "初始化知识库",
      `新增${created.length}条，保留${skipped.length}条已有资料`,
    );
    res.json({
      ok: true,
      created,
      skipped,
      message: `知识库初始化完成：新增${created.length}条，已有${skipped.length}条未覆盖`,
    });
  },
);

// 保留既有 API 路径以兼容管理页，但允许写入的名称只来自权威餐饮目录。
const DEPARTMENT_NAMING = RESTAURANT_DEPARTMENTS.map((item) => [
  item.code,
  item.name,
  item.name,
  `权威餐饮目录分部，共 ${item.employeeCount} 位数字员工`,
]);

r.get("/marshal-naming", (req, res) => {
  const current = new Map(
    q
      .all(
        `SELECT * FROM marshals WHERE online=1 AND code IN (${RESTAURANT_DEPARTMENTS.map(() => "?").join(",")}) ORDER BY sort`,
        ...RESTAURANT_DEPARTMENTS.map((item) => item.code),
      )
      .map((m) => {
        const merged = mergeMarshal(m);
        return [m.code, merged.name];
      }),
  );
  res.json(
    DEPARTMENT_NAMING.map(([code, original, recommended, reason]) => ({
      code,
      original,
      current: current.get(code) || original,
      recommended,
      reason,
      changed: (current.get(code) || original) === recommended,
    })),
  );
});

r.post("/marshal-naming/apply", requireRole("boss", "admin"), (req, res) => {
  const validCodes = new Set(DEPARTMENT_NAMING.map((item) => item[0]));
  const requested =
    Array.isArray(req.body?.codes) && req.body.codes.length
      ? req.body.codes.map(String)
      : [...validCodes];
  if (requested.some((code) => !validCodes.has(code)))
    return res
      .status(400)
      .json({ error: "只能同步当前餐饮数字员工目录中的8个分部" });
  const selected = new Set(requested);
  const applied = [];
  for (const [code, , recommended] of DEPARTMENT_NAMING) {
    if (!selected.has(code)) continue;
    q.run(
      `INSERT INTO tenant_marshal_overrides(tenant_id,marshal_code,name,updated_at) VALUES(?,?,?,datetime('now','localtime'))
      ON CONFLICT(tenant_id,marshal_code) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at`,
      curTenant(),
      code,
      recommended,
    );
    applied.push({ code, name: recommended });
  }
  logOp(
    req.user,
    "系统管理",
    "同步餐饮分部命名",
    applied.map((x) => `${x.code}:${x.name}`).join("、"),
  );
  res.json({ ok: true, applied });
});

r.get(
  "/marshal-prompts/status",
  requireRole("boss", "admin", "platform_super"),
  (req, res) => {
    res.json(
      q
        .all("SELECT code,name,prompt,synced_at FROM marshals ORDER BY sort")
        .map((m) => {
          const merged = mergeMarshal(m);
          return {
            code: m.code,
            name: merged.name,
            length: String(merged.prompt || "").length,
            ready: String(merged.prompt || "").length > 1200,
            syncedAt: m.synced_at,
          };
        }),
    );
  },
);

// ===== 提示词模板（PROMPT-01~03 / FR-MAR-06）=====
r.get(
  "/prompts",
  requireRole("boss", "admin", "platform_super"),
  (req, res) => {
    // 全局基线 + 本企业覆盖合并展示
    res.json(
      q.all("SELECT * FROM prompts ORDER BY code").map((p) => {
        const ov = promptOverride(p.code);
        return ov
          ? {
              ...p,
              role_card: ov.role_card ?? p.role_card,
              output_rule: ov.output_rule ?? p.output_rule,
              style: ov.style ?? p.style,
              _overridden: 1,
            }
          : p;
      }),
    );
  },
);
r.put(
  "/prompts/:id",
  requireRole("boss", "admin", "platform_super"),
  (req, res) => {
    // 老板升级=本企业全员即时生效
    const { role_card, output_rule, style } = req.body || {};
    const base = q.get("SELECT code FROM prompts WHERE id = ?", req.params.id);
    if (!base) return res.status(404).json({ error: "提示词不存在" });
    const tid = curTenant();
    const ov =
      q.get(
        "SELECT * FROM tenant_prompt_overrides WHERE tenant_id=? AND code=?",
        tid,
        base.code,
      ) || {};
    q.run(
      `INSERT INTO tenant_prompt_overrides(tenant_id,code,role_card,output_rule,style,updated_at)
    VALUES(?,?,?,?,?,datetime('now','localtime'))
    ON CONFLICT(tenant_id,code) DO UPDATE SET role_card=excluded.role_card,output_rule=excluded.output_rule,style=excluded.style,updated_at=excluded.updated_at`,
      tid,
      base.code,
      role_card ?? ov.role_card ?? null,
      output_rule ?? ov.output_rule ?? null,
      style ?? ov.style ?? null,
    );
    logOp(req.user, "系统管理", "更新提示词(本企业)", base.code);
    const fresh = q.get("SELECT * FROM prompts WHERE id = ?", req.params.id);
    const merged = fresh
      ? {
          ...fresh,
          role_card: role_card ?? fresh.role_card,
          output_rule: output_rule ?? fresh.output_rule,
          style: style ?? fresh.style,
          _overridden: 1,
        }
      : { ok: true, code: base.code };
    res.json(merged);
  },
);

// ===== 用户管理 =====
// 企业账号管理（仅本租户；含席位配额）
r.get("/users", requireRole("boss", "ops_director", "admin"), (req, res) => {
  const tid = curTenant();
  const t = getTenant(tid) || {};
  const used =
    q.get("SELECT COUNT(*) n FROM users WHERE tenant_id = ?", tid)?.n || 0;
  const scope = userScopeClause(req.user, "id");
  res.json({
    seatLimit: t.seat_limit ?? 5,
    seatUsed: used,
    users: q.all(
      `SELECT id,username,name,role,dept,phone,status,modules,manager_id,last_login_at,created_at
      FROM users WHERE tenant_id = ? AND role != 'platform_super'${scope.sql} ORDER BY id`,
      tid,
      ...scope.params,
    ),
  });
});
r.post("/users", requireRole("admin", "boss"), (req, res) => {
  const { username, password, name, role, dept, phone, modules, manager_id } =
    req.body || {};
  if (!username || !password || !name)
    return res.status(400).json({ error: "用户名/密码/姓名必填" });
  const account = String(username).trim();
  if (!/^[a-zA-Z0-9_.@-]{3,64}$/.test(account))
    return res
      .status(400)
      .json({ error: "用户名须为3到64位字母、数字或 . _ @ -" });
  if (
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 128
  )
    return res.status(400).json({ error: "初始密码须为8到128位" });
  const userRole = role || "sales";
  if (!USER_ROLE_SET.has(userRole))
    return res.status(400).json({ error: "账号角色无效" });
  const tid = curTenant();
  const t = getTenant(tid) || {};
  const used =
    q.get("SELECT COUNT(*) n FROM users WHERE tenant_id = ?", tid)?.n || 0;
  if (used >= (t.seat_limit ?? 5))
    return res
      .status(400)
      .json({
        error: `账号数已达企业上限（${t.seat_limit ?? 5}个），如需扩容请联系平台`,
      });
  let displayName;
  let managerId;
  let normalizedModules;
  try {
    displayName = normalizedUserName(name);
    managerId = validManagerId(manager_id, tid) ?? null;
    normalizedModules = normalizedUserModules(modules);
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  try {
    const result = q.run(
      "INSERT INTO users(username,password_hash,name,role,dept,phone,modules,tenant_id,manager_id) VALUES(?,?,?,?,?,?,?,?,?)",
      account,
      hashPassword(password),
      displayName,
      userRole,
      String(dept || "")
        .trim()
        .slice(0, 80),
      String(phone || "")
        .trim()
        .slice(0, 40),
      normalizedModules ?? null,
      tid,
      managerId,
    );
    logOp(req.user, "系统管理", "新增账号", account);
    res.json({ id: result.lastInsertRowid });
  } catch (error) {
    const duplicate = String(error?.message || "").includes(
      "UNIQUE constraint failed: users.username",
    );
    res
      .status(400)
      .json({
        error: duplicate ? "用户名已存在" : error?.message || "新增账号失败",
      });
  }
});
r.put("/users/:id", requireRole("admin", "boss"), (req, res) => {
  const tid = curTenant();
  const target = q.get(
    "SELECT id, role FROM users WHERE id = ? AND tenant_id = ?",
    req.params.id,
    tid,
  );
  if (!target)
    return res.status(404).json({ error: "账号不存在或不属于本企业" });
  if (target.role === "platform_super")
    return res.status(403).json({ error: "不可修改平台账号" });
  const { name, role, dept, status, password, modules, manager_id } =
    req.body || {};
  if (role !== undefined && !USER_ROLE_SET.has(role))
    return res.status(400).json({ error: "账号角色无效" });
  if (status !== undefined && !USER_STATUS_SET.has(status))
    return res.status(400).json({ error: "账号状态无效" });
  if (
    Number(req.params.id) === Number(req.user.id) &&
    (role !== undefined || status === "停用")
  ) {
    return res
      .status(400)
      .json({ error: "不能修改当前登录账号的角色或停用状态" });
  }
  if (status === "停用") {
    return res.status(400).json({
      error:
        "请使用“停用账号”操作；系统会在同一事务中保留历史归属并停用该账号创建的内容自动任务",
    });
  }
  if (
    password !== undefined &&
    password !== "" &&
    (typeof password !== "string" ||
      password.length < 8 ||
      password.length > 128)
  ) {
    return res.status(400).json({ error: "重置密码须为8到128位" });
  }
  let displayName;
  let normalizedModules;
  let managerId;
  try {
    if (name !== undefined) displayName = normalizedUserName(name);
    normalizedModules = normalizedUserModules(modules);
    managerId = validManagerId(manager_id, tid, req.params.id);
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  const updates = [];
  const values = [];
  const add = (field, value) => {
    updates.push(`${field}=?`);
    values.push(value);
  };
  if (name !== undefined) add("name", displayName);
  if (role !== undefined) add("role", role);
  if (dept !== undefined)
    add(
      "dept",
      String(dept || "")
        .trim()
        .slice(0, 80),
    );
  if (status !== undefined) add("status", status);
  if (modules !== undefined) add("modules", normalizedModules);
  if (manager_id !== undefined) add("manager_id", managerId);
  if (password) {
    add("password_hash", hashPassword(password));
    updates.push("auth_version=COALESCE(auth_version,0)+1");
  }
  if (updates.length)
    q.run(
      `UPDATE users SET ${updates.join(",")} WHERE id=? AND tenant_id=?`,
      ...values,
      req.params.id,
      tid,
    );
  logOp(req.user, "系统管理", "修改账号", `user#${req.params.id}`);
  res.json({ ok: true });
});
// 停用账号（软删除）：保留用户主键与全部历史归属，同时关闭其仍启用的内容自动任务。
r.delete("/users/:id", requireRole("admin", "boss"), (req, res) => {
  const tid = curTenant();
  const targetId = Number(req.params.id);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: "账号编号无效" });
  }

  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    const target = q.get(
      "SELECT id,name,role,status,auth_version FROM users WHERE id=? AND tenant_id=?",
      targetId,
      tid,
    );
    if (!target) throw userDisableError("账号不存在或不属于本企业", 404);
    if (Number(target.id) === Number(req.user.id)) {
      throw userDisableError("不能停用当前登录账号", 400);
    }
    if (target.role === "platform_super") {
      throw userDisableError("不可停用平台超级管理员", 403);
    }
    if (target.status === "启用" && TENANT_ADMIN_ROLES.has(target.role)) {
      const enabledAdmins = Number(
        q.get(
          `SELECT COUNT(*) n FROM users
          WHERE tenant_id=? AND status='启用' AND role IN ('boss','admin')`,
          tid,
        )?.n || 0,
      );
      if (enabledAdmins <= 1) {
        throw userDisableError(
          "不能停用企业最后一个启用的老板/管理员账号",
          409,
        );
      }
    }

    const alreadyDisabled = target.status === "停用";
    const dependencyCounts = userDependencyCounts(tid, targetId);
    if (!alreadyDisabled) {
      q.run(
        `UPDATE users
        SET status='停用',auth_version=COALESCE(auth_version,0)+1
        WHERE tenant_id=? AND id=? AND status!='停用'`,
        tid,
        targetId,
      );
    }
    const automationUpdate = q.run(
      `UPDATE content_automation_rules
      SET enabled=0,next_run_at=NULL,updated_at=datetime('now','localtime')
      WHERE tenant_id=? AND created_by=? AND enabled=1`,
      tid,
      targetId,
    );
    const disabledAutomationRules = Number(automationUpdate.changes || 0);
    db.exec("COMMIT");
    inTransaction = false;

    logOp(
      req.user,
      "系统管理",
      "停用账号",
      `user#${targetId}:${target.name || ""};alreadyDisabled=${alreadyDisabled};disabledAutomationRules=${disabledAutomationRules};历史归属保留`,
    );
    return res.json({
      ok: true,
      userId: targetId,
      status: "停用",
      alreadyDisabled,
      dependencyCounts,
      disabledAutomationRules,
      historyPreserved: true,
      message: alreadyDisabled
        ? "账号已经停用；用户ID、历史内容、任务、审批和自动化运行记录均保留。"
        : "账号已停用；用户ID与历史归属均保留，仍启用的内容自动任务已同步停用。",
    });
  } catch (error) {
    if (inTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* no active transaction */
      }
    }
    return res.status(error.status || 500).json({
      error: error.status
        ? error.message
        : "停用账号失败，账号与自动任务均未更改",
    });
  }
});

// ===== 日志 =====
r.get("/logs", requireRole("boss", "ops_director", "admin"), (req, res) => {
  res.json(
    q.all(
      `SELECT * FROM op_logs WHERE tenant_id = ${curTenant()} ORDER BY created_at DESC LIMIT 50`,
    ),
  );
});
r.get(
  "/login-logs",
  requireRole("boss", "ops_director", "admin"),
  (req, res) => {
    res.json(
      q.all(
        "SELECT * FROM login_logs WHERE tenant_id=? ORDER BY created_at DESC LIMIT 50",
        curTenant(),
      ),
    );
  },
);

// ===== 删除留痕 / 回收站 =====
r.get("/deletions", requireRole("boss", "admin"), (req, res) => {
  const { entityType, status } = req.query;
  let where = `WHERE tenant_id = ${curTenant()}`;
  const params = [];
  if (entityType) {
    where += " AND entity_type = ?";
    params.push(entityType);
  }
  if (status === "restored") where += " AND restored_at IS NOT NULL";
  else if (status === "active") where += " AND restored_at IS NULL";
  const rows = q.all(
    `SELECT id,entity_type,entity_id,module,title,summary,required_role,reason,deleted_by_name,deleted_by_role,restored_by_name,restored_at,created_at
    FROM deleted_records ${where} ORDER BY id DESC LIMIT 200`,
    ...params,
  );
  res.json(rows);
});

r.get("/deletions/:id", requireRole("boss", "admin"), (req, res) => {
  const row = q.get(
    `SELECT * FROM deleted_records WHERE tenant_id = ${curTenant()} AND id=?`,
    req.params.id,
  );
  if (!row) return res.status(404).json({ error: "删除记录不存在" });
  res.json({
    ...row,
    snapshot: parsePayload(row.snapshot, {}),
    child_snapshot: parsePayload(row.child_snapshot, {}),
  });
});

r.post("/deletions/:id/restore", requireRole("boss", "admin"), (req, res) => {
  const row = q.get(
    `SELECT * FROM deleted_records WHERE tenant_id = ${curTenant()} AND id=?`,
    req.params.id,
  );
  if (!row) return res.status(404).json({ error: "删除记录不存在" });
  try {
    const out = restoreDeletedRecord(row, req.user);
    logOp(
      req.user,
      "系统管理",
      "恢复删除数据",
      `${row.entity_type}#${row.entity_id} / archive#${row.id}`,
    );
    res.json({ ok: true, ...out, message: "已从回收站恢复" });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ===== 系统状态 =====
r.get(
  "/runtime-readiness",
  requireRole("boss", "ops_director", "admin", "platform_super"),
  (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(buildRuntimeReadiness({ tenantId: curTenant() }));
  },
);

r.get(
  "/status",
  requireRole("boss", "ops_director", "admin", "platform_super"),
  (req, res) => {
    const dbSize = fs.existsSync(DB_PATH)
      ? Math.round(fs.statSync(DB_PATH).size / 1024)
      : 0;
    const mem = process.memoryUsage();
    const cpu = Math.max(
      0,
      Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100)),
    );
    const memory = Math.max(
      0,
      Math.min(100, Math.round((1 - os.freemem() / os.totalmem()) * 100)),
    );
    const canViewAiDetail = ["boss", "admin", "platform_super"].includes(
      req.user.role,
    );
    const healthStatus =
      memory >= 90 || cpu >= 95
        ? "danger"
        : memory >= 80 || cpu >= 80
          ? "warning"
          : "success";
    const healthLabel =
      healthStatus === "danger"
        ? "高负载"
        : healthStatus === "warning"
          ? "需关注"
          : "运行正常";
    const healthReason =
      healthStatus === "danger"
        ? "CPU或内存已进入高风险区间，请尽快检查服务负载"
        : healthStatus === "warning"
          ? "CPU或内存偏高，建议关注后续波动"
          : "核心资源处于安全区间";
    const usage = getTokenUsage();
    const readiness = buildRuntimeReadiness({ tenantId: curTenant() });
    res.json({
      users:
        q.get(`SELECT COUNT(*) n FROM users WHERE tenant_id = ${curTenant()}`)
          ?.n || 0,
      online:
        q.get(
          `SELECT COUNT(DISTINCT username) n FROM login_logs
      WHERE tenant_id=? AND success=1 AND created_at >= datetime('now','-8 hour','localtime')`,
          curTenant(),
        )?.n || 0,
      leads:
        q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()}`)
          ?.n || 0,
      contents:
        q.get(
          `SELECT COUNT(*) n FROM contents WHERE tenant_id = ${curTenant()}`,
        )?.n || 0,
      dbSizeKB: dbSize,
      cpu,
      memory,
      heapMB: Math.round(mem.heapUsed / 1048576),
      uptimeMin: Math.round(process.uptime() / 60),
      healthStatus,
      healthLabel,
      healthReason,
      readiness,
      ai: {
        available: aiAvailable(),
        readiness: readiness.channels.find((item) => item.key === "ai"),
        canViewDetail: canViewAiDetail,
        model: canViewAiDetail
          ? process.env.AI_MODEL || "claude-opus-4-8"
          : null,
        usage: canViewAiDetail ? usage : null,
      },
    });
  },
);

// ===== 业务系数配置（FR-SYS-07）=====
r.get("/config", requireRole("boss", "ops_director", "admin"), (req, res) => {
  // 业务系数读「本租户覆盖 → 平台默认」，让每家企业看到/调整自己的经营参数（千客千面）
  res.json({
    year_revenue_target: getTenantConfig("year_revenue_target", 6000000),
    month_revenue_target: getTenantConfig("month_revenue_target", 500000),
    personal_month_target: getTenantConfig("personal_month_target", 200000),
    avg_deal_amount: getTenantConfig("avg_deal_amount", 120),
    month_targets: getTenantConfig("month_targets", {}),
    funnel_baseline: getTenantConfig("funnel_baseline", {}),
    activity_baseline: getTenantConfig("activity_baseline", {}),
    health_weights: getTenantConfig("health_weights", {}),
    risk_rules: getRules(),
  });
});
// 平台级配置键（影响计费/模型/密钥/全平台）——企业后台不可改，杜绝任一租户老板篡改全平台计费或盗改API密钥
const PLATFORM_ONLY_CFG = [
  "billing",
  "model_routing",
  "yunwu_api_key",
  "yunwu_base_url",
  "embed_model",
  "security",
];
// 业务系数键——按租户存（每家企业自定义，互不影响；未设回退平台默认）
const TENANT_CFG_KEYS = new Set([
  "score_weights",
  "health_weights",
  "month_targets",
  "funnel_baseline",
  "activity_baseline",
  "month_revenue_target",
  "year_revenue_target",
  "personal_month_target",
  "avg_deal_amount",
]);
r.put("/config", requireRole("boss", "admin"), (req, res) => {
  const body = req.body || {};
  const blocked = Object.keys(body).filter((k) =>
    PLATFORM_ONLY_CFG.includes(k),
  );
  if (blocked.length)
    return res
      .status(403)
      .json({ error: `平台级配置（${blocked.join("、")}）仅平台方可修改` });
  const unknown = Object.keys(body).filter((k) => !TENANT_CFG_KEYS.has(k));
  if (unknown.length)
    return res
      .status(400)
      .json({ error: `不支持的配置项：${unknown.join("、")}` });
  for (const [k, v] of Object.entries(body)) setTenantConfig(k, v);
  logOp(req.user, "系统管理", "修改配置", Object.keys(body).join(","));
  res.json({ ok: true });
});

// ===== 备份（FR-SYS-06）=====
r.post("/backup", requirePlatformOperator, (req, res) => {
  try {
    const dir = path.dirname(DB_PATH);
    const file = `${path.basename(DB_PATH, path.extname(DB_PATH))}.backup.${Date.now()}.sqlite`;
    const dest = backupDatabase(path.join(dir, file));
    const backups = fs
      .readdirSync(dir)
      .filter((name) => databaseBackupMeta(name))
      .sort()
      .reverse();
    for (const expired of backups.slice(10))
      fs.rmSync(path.join(dir, expired), { force: true });
    logOp(req.user, "系统管理", "数据备份", file);
    res.json({
      file,
      sizeKB: Math.round(fs.statSync(dest).size / 1024),
      integrity: "ok",
    });
  } catch (error) {
    res.status(500).json({ error: `备份失败：${error.message}` });
  }
});
r.get("/backups", requirePlatformOperator, (req, res) => {
  const dir = path.dirname(DB_PATH);
  const files = fs
    .readdirSync(dir)
    .filter((f) => databaseBackupMeta(f))
    .map((f) => ({
      file: f,
      sizeKB: Math.round(fs.statSync(path.join(dir, f)).size / 1024),
      at: new Date(databaseBackupMeta(f).timestamp).toLocaleString("zh-CN"),
    }))
    .sort((a, b) => b.file.localeCompare(a.file))
    .slice(0, 10);
  res.json(files);
});

function requestBaseUrl(req) {
  const configured =
    process.env.FEISHU_PUBLIC_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.APP_PUBLIC_URL ||
    "";
  if (process.env.NODE_ENV === "production" && !configured)
    throw new Error(
      "生产环境必须配置 FEISHU_PUBLIC_BASE_URL，不能使用请求头推导回调地址",
    );
  const xfProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const xfHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const proto = xfProto || req.protocol || "http";
  const host = xfHost || req.get("host");
  const value = (configured || `${proto}://${host}`).replace(/\/+$/, "");
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("飞书公网回调地址格式不正确");
  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:")
    throw new Error("生产环境飞书公网回调地址必须使用 HTTPS");
  return parsed.toString().replace(/\/+$/, "");
}

// ===== 飞书集成（应用机器人单人推送 / 活动日历同步）=====
r.get(
  "/feishu",
  requireRole("boss", "ops_director", "admin"),
  async (req, res) => {
    const { feishuConfig, appReady, appBotReady, feishuManagerSummary } =
      await import("../engines/feishu.js");
    const cfg = feishuConfig();
    const managers = feishuManagerSummary();
    const readiness = buildRuntimeReadiness({
      tenantId: curTenant(),
    }).channels.find((item) => item.key === "feishu");
    res.json({
      enabled: cfg.enabled,
      mode: "app",
      receiverName: cfg.receiverName,
      receiveIdType: cfg.receiveIdType,
      receiveId: cfg.receiveId ? cfg.receiveId.slice(0, 8) + "****" : "",
      appReady: appReady(),
      appBotReady: appBotReady(),
      appId: cfg.appId ? cfg.appId.slice(0, 8) + "****" : "",
      calendarReady: !!cfg.calendarId,
      managerReceiverCount: managers.count,
      managerCalendarCount: managers.calendarCount,
      managerReceivers: managers.recipients,
      readiness,
    });
  },
);
r.get("/feishu/me", async (req, res) => {
  try {
    const { appReady: ready, feishuUserSummary } =
      await import("../engines/feishu.js");
    res.json({
      appReady: ready(),
      ...feishuUserSummary(req.user.id, curTenant()),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
r.post("/feishu/oauth/start", async (req, res) => {
  try {
    const { createOAuthBinding } = await import("../engines/feishu.js");
    const baseUrl = requestBaseUrl(req);
    const out = await createOAuthBinding({
      tid: curTenant(),
      user: req.user,
      baseUrl,
    });
    logOp(
      req.user,
      "系统管理",
      "发起飞书扫码绑定",
      out.localMode ? "localhost" : "public",
    );
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
r.get("/feishu/oauth/status", async (req, res) => {
  try {
    const { oauthBindingStatus } = await import("../engines/feishu.js");
    res.json(oauthBindingStatus(req.query.state, curTenant(), req.user.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
r.put("/feishu", requireRole("boss", "ops_director", "admin"), (req, res) => {
  const { enabled, appId, appSecret, receiveId, receiveIdType, receiverName } =
    req.body || {};
  const cur = getTenantConfig("feishu", {}) || {}; // 飞书配置按租户存：每家企业自己的应用机器人/凭据/接收人
  const next = {
    ...cur,
    enabled: enabled ?? cur.enabled ?? false,
    mode: "app",
    webhook: "",
    chatId: "",
    chatName: "",
    appId:
      appId !== undefined && !String(appId).includes("****")
        ? String(appId).trim()
        : cur.appId || "",
    appSecret:
      appSecret !== undefined && appSecret !== ""
        ? String(appSecret).trim()
        : cur.appSecret || "",
    receiveId:
      receiveId !== undefined && !String(receiveId).includes("****")
        ? String(receiveId).trim()
        : cur.receiveId || "",
    receiveIdType: receiveIdType || cur.receiveIdType || "open_id",
    receiverName:
      receiverName !== undefined
        ? String(receiverName).trim()
        : cur.receiverName || "",
  };
  const allowLegacyDeploymentCredential = Number(curTenant()) === 1;
  const effectiveAppId =
    next.appId ||
    (allowLegacyDeploymentCredential ? process.env.FEISHU_APP_ID : "") ||
    "";
  const effectiveAppSecret =
    next.appSecret ||
    (allowLegacyDeploymentCredential ? process.env.FEISHU_APP_SECRET : "") ||
    "";
  if (
    next.enabled &&
    (!effectiveAppId || !effectiveAppSecret || !next.receiveId)
  )
    return res
      .status(400)
      .json({
        error: "启用飞书应用机器人前，请填写 App ID、App Secret 和接收人 ID",
      });
  if (!["open_id", "user_id", "union_id", "email"].includes(next.receiveIdType))
    return res
      .status(400)
      .json({
        error: "接收人 ID 类型仅支持 open_id / user_id / union_id / email",
      });
  setTenantConfig("feishu", next);
  logOp(
    req.user,
    "系统管理",
    "配置飞书应用机器人",
    next.enabled ? "启用" : "保存",
  );
  res.json({ ok: true });
});
r.post(
  "/feishu/app-bot/bind",
  requireRole("boss", "ops_director", "admin"),
  async (req, res) => {
    try {
      const { bindAppBotTarget } = await import("../engines/feishu.js");
      const target = await bindAppBotTarget(
        req.body || {},
        curTenant(),
        req.user,
      );
      logOp(
        req.user,
        "系统管理",
        "绑定飞书应用机器人",
        `${target.receiveIdType}:${target.receiverName || target.receiveId}`,
      );
      res.json({ ok: true, ...target });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  },
);
// 旧版群绑定接口保留兼容，但不再读取群列表或绑定群。
r.get(
  "/feishu/qr",
  requireRole("boss", "ops_director", "admin"),
  async (req, res) => {
    const { bindQr, appReady } = await import("../engines/feishu.js");
    const out = await bindQr();
    res.json({ ...out, appReady: appReady(), appBotOnly: true });
  },
);
// 群绑定接口（/feishu/chats、/feishu/bind、/feishu/autobind）已随 V3 应用机器人单人绑定下线；
// 前端从未调用，2026-07 升级中删除废弃桩，避免死接口误导集成方。
r.post(
  "/feishu/test",
  requireRole("boss", "ops_director", "admin"),
  async (req, res) => {
    const tenantId = curTenant();
    try {
      const { pushFeishuToManagers } = await import("../engines/feishu.js");
      const out = await pushFeishuToManagers({
        title: "纳米Work行业版 · 管理层连接测试",
        lines: [
          "✅ 飞书应用机器人已接通",
          `操作人：${req.user.name}`,
          "后续活动创建/状态变更会同步推送给已绑定的老板与管理层，并自动写入飞书日历提醒",
        ],
      });
      if (out.skipped || !out.ok) {
        const message =
          out.reason ||
          out.error ||
          (out.skipped
            ? "请先配置并启用飞书应用机器人"
            : "飞书服务暂时不可用，请稍后重试");
        recordRuntimeReadinessCheck("feishu", {
          tenantId,
          outcome: "failed",
          checkedBy: req.user.id,
          error: message,
          evidence: {
            sent: Number(out.sent) || 0,
            total: Number(out.total) || 0,
          },
        });
        return res.status(out.skipped ? 400 : 502).json({
          error: message,
          readiness: buildRuntimeReadiness({ tenantId }).channels.find(
            (item) => item.key === "feishu",
          ),
        });
      }
      recordRuntimeReadinessCheck("feishu", {
        tenantId,
        outcome: "passed",
        checkedBy: req.user.id,
        evidence: {
          sent: Number(out.sent) || 0,
          total: Number(out.total) || 0,
        },
      });
      res.json({
        ok: true,
        sent: out.sent,
        total: out.total,
        readiness: buildRuntimeReadiness({ tenantId }).channels.find(
          (item) => item.key === "feishu",
        ),
      });
    } catch (error) {
      const safe = sanitizeProviderError(error, { service: "飞书服务" });
      recordRuntimeReadinessCheck("feishu", {
        tenantId,
        outcome: "failed",
        checkedBy: req.user.id,
        error: safe.message,
      });
      res.status(502).json({
        error: safe.message,
        readiness: buildRuntimeReadiness({ tenantId }).channels.find(
          (item) => item.key === "feishu",
        ),
      });
    }
  },
);
// ===== 通知 =====
r.get("/notifications", (req, res) => {
  const size = Math.min(
    100,
    Math.max(1, Number.parseInt(req.query.size, 10) || 20),
  );
  res.json(
    q.all(
      `SELECT * FROM notifications
    WHERE tenant_id=? AND user_id=? ORDER BY id DESC LIMIT ?`,
      curTenant(),
      req.user.id,
      size,
    ),
  );
});
r.post("/notifications/:id/read", (req, res) => {
  q.run(
    "UPDATE notifications SET read=1 WHERE tenant_id=? AND id=? AND user_id=?",
    curTenant(),
    req.params.id,
    req.user.id,
  );
  res.json({ ok: true });
});
r.post("/notifications/read", (req, res) => {
  q.run(
    "UPDATE notifications SET read=1 WHERE tenant_id=? AND user_id=?",
    curTenant(),
    req.user.id,
  );
  res.json({ ok: true });
});

export default r;
