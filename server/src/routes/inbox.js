// ===== 统一"待我处理"收件箱（只聚合可操作事项，不是只读通知）=====
//
// 口径（D-037/D-046）：
// - 每一项都是当前用户"现在就能点一下处理"的权威行；actions 直接映射到既有决策端点
//   （审批 decide / 产出 review / 人工任务 review·接单），收件箱本身不新造任何决策逻辑。
// - 可见性与可决性完全复用各来源自己的判定（approvalDecisionAvailability、
//   contentOutputReviewAccess、canReviewManualTask 等），保证与各页面口径一致。
// - 一线员工只看到分派给自己的任务；管理层看到范围内可审事项；boss/admin 全租户。
import { Router } from "express";
import { q, curTenant } from "../db.js";
import {
  canAccessOwner,
  canReviewManualTask,
  isManagerRole,
  userScopeClause,
} from "../engines/access.js";
import {
  approvalDecisionAvailability,
  approvalVisibilityClause,
} from "./system.js";
import { contentOutputReviewAccess } from "../engines/restaurant-output-review.js";
import {
  loadContentAdoptionAvailability,
  loadContentEmployeeRunAuthority,
} from "../engines/delivery-state.js";
import {
  contentEmployeeRunReviewAccess,
  EMPLOYEE_MANAGEMENT_REVIEW_ROLES,
} from "../engines/content-approval-policy.js";

export const INBOX_KINDS = Object.freeze([
  "approval",
  "activity_approval",
  "employee_output",
  "content_run_review",
  "manual_review",
  "manual_todo",
]);
export const INBOX_KIND_LABELS = Object.freeze({
  approval: "审批中心待决",
  activity_approval: "活动策划待审批",
  employee_output: "数字员工产出待审阅",
  content_run_review: "内容员工产出待审阅",
  manual_review: "人工任务待验收",
  manual_todo: "分派给我的任务",
});
const APPROVAL_ROLES = new Set(["boss", "ops_director", "manager", "admin"]);
const EMPLOYEE_REVIEW_ROLES = new Set(EMPLOYEE_MANAGEMENT_REVIEW_ROLES);
// 与并行工程师的"未达标草稿"状态兼容：出现该状态即纳入产出待处理
const RESTAURANT_PENDING_STATUSES = ["待审阅", "草稿待处理"];
const SOURCE_LIMIT = 200;
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

const router = Router();

function cleanText(value, max = 160) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
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

function riskPriority(level) {
  const value = String(level || "").toLowerCase();
  if (value === "high") return "high";
  if (value === "medium") return "medium";
  return "low";
}

function manualPriority(value) {
  if (value === "高") return "high";
  if (value === "低") return "low";
  return "medium";
}

function item({
  kind,
  id,
  title,
  subtitle = "",
  createdAt = null,
  dueAt = null,
  priority = "medium",
  actions = [],
  link = null,
  meta = {},
}) {
  return {
    key: `${kind}:${id}`,
    kind,
    kindLabel: INBOX_KIND_LABELS[kind],
    id: Number(id),
    title: cleanText(title, 120) || `${INBOX_KIND_LABELS[kind]} #${id}`,
    subtitle: cleanText(subtitle, 200),
    createdAt,
    dueAt,
    priority: PRIORITY_RANK[priority] === undefined ? "medium" : priority,
    actions,
    link,
    ...meta,
  };
}

function restaurantTaskLink(task) {
  const employeeIdx = Number(task?.employee_idx);
  if (Number.isSafeInteger(employeeIdx) && employeeIdx >= 0)
    return `/employees?employee=${employeeIdx}&task=${Number(task.id)}`;
  return `/tasks?kind=restaurant&id=${Number(task.id)}`;
}

// ① 审批中心待决（含 ④ 活动策划审批与 ② 数字员工产出的正式审批单）
function loadApprovals(user, tenantId) {
  if (!APPROVAL_ROLES.has(user.role)) return [];
  const visibility = approvalVisibilityClause(user);
  const rows = q.all(
    `SELECT a.*, u.name submitter FROM approvals a
    LEFT JOIN users u ON u.id=a.submitter_id
    WHERE a.tenant_id=? AND a.status='待审核'${visibility.sql}
    ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    tenantId,
    ...visibility.params,
    SOURCE_LIMIT,
  );
  const items = [];
  for (const row of rows) {
    const availability = approvalDecisionAvailability(row, user);
    if (!availability.canPass && !availability.canReject) continue;
    const isContent = row.target_type === "content";
    const isActivity = String(row.target_type || "").startsWith("activity");
    const kind = isContent
      ? "employee_output"
      : isActivity
        ? "activity_approval"
        : "approval";
    const task = isContent
      ? q.get(
          `SELECT t.id,s.employee_idx FROM agent_tasks t
          LEFT JOIN specialists s ON s.id=t.specialist_id
          WHERE t.tenant_id=? AND t.output_id=? ORDER BY t.id DESC LIMIT 1`,
          tenantId,
          row.target_id,
        )
      : null;
    const actions = [];
    if (availability.canPass) {
      actions.push({
        key: isContent ? "adopt" : "approve",
        label: isContent ? "采纳" : "通过",
        method: "POST",
        path: `/api/sys/approvals/${row.id}/decide`,
        body: { pass: true },
      });
    }
    if (availability.canReject) {
      actions.push({
        key: "reject",
        label: "驳回",
        method: "POST",
        path: `/api/sys/approvals/${row.id}/decide`,
        body: { pass: false },
        requiresReason: true,
        danger: true,
      });
    }
    items.push(
      item({
        kind,
        id: row.id,
        title: row.title,
        subtitle: [
          row.submitter ? `提交人：${row.submitter}` : "",
          availability.reviewStatus || "",
          availability.passBlockedReason && !availability.canPass
            ? `暂不能通过：${availability.passBlockedReason}`
            : "",
        ]
          .filter(Boolean)
          .join(" · "),
        createdAt: row.created_at,
        priority: riskPriority(row.risk_level),
        actions,
        link: isContent && task
          ? restaurantTaskLink(task)
          : isActivity
            ? "/activities"
            : "/system?tab=approvals",
        meta: {
          source: "approval",
          approvalId: Number(row.id),
          targetType: row.target_type,
          targetId: Number(row.target_id) || null,
          riskLevel: row.risk_level || null,
        },
      }),
    );
  }
  return items;
}

// 契约分级（并行批次）给 agent_tasks 加的列；老库尚未迁移时安全降级
let agentTaskContractReportColumn = null;
function hasAgentTaskContractReport() {
  if (agentTaskContractReportColumn === null) {
    agentTaskContractReportColumn = q
      .all("PRAGMA table_info(agent_tasks)")
      .some((column) => column.name === "contract_report");
  }
  return agentTaskContractReportColumn;
}

// "就用这份草稿"是老板/管理员的决定（见 marshals.js accept-draft）；含来源类硬错的草稿不可接受
function draftActions(user, row) {
  if (!["boss", "admin"].includes(user.role)) return { actions: [], acceptable: false };
  const report = parseObject(row.contract_report);
  if (report.acceptable !== true) return { actions: [], acceptable: false };
  return {
    acceptable: true,
    actions: [
      {
        key: "accept_draft",
        label: "就用这份草稿",
        method: "POST",
        path: `/api/marshals/tasks/${row.id}/accept-draft`,
        body: {},
      },
    ],
  };
}

// ② 餐饮数字员工产出待审阅/草稿待处理（没有挂待审核审批单的历史/新状态行）
function loadRestaurantOutputs(user, tenantId) {
  if (!EMPLOYEE_REVIEW_ROLES.has(user.role)) return [];
  const scope = userScopeClause(user, "t.created_by");
  const placeholders = RESTAURANT_PENDING_STATUSES.map(() => "?").join(",");
  const contractReportColumn = hasAgentTaskContractReport()
    ? "t.contract_report,"
    : "NULL contract_report,";
  const rows = q.all(
    `SELECT t.id,t.title,t.status,t.created_at,t.due_at,t.output_id,t.created_by,
      t.approval_routing_policy_snapshot,${contractReportColumn}s.employee_idx,
      c.title content_title,c.risk_level,c.status content_status,c.creator_id
    FROM agent_tasks t
    LEFT JOIN specialists s ON s.id=t.specialist_id
    LEFT JOIN contents c ON c.tenant_id=t.tenant_id AND c.id=t.output_id
    WHERE t.tenant_id=? AND t.status IN (${placeholders}) AND t.output_id IS NOT NULL${scope.sql}
      AND NOT EXISTS (
        SELECT 1 FROM approvals a
        WHERE a.tenant_id=t.tenant_id AND a.target_type='content'
          AND a.target_id=t.output_id AND a.status='待审核'
      )
    ORDER BY t.id DESC LIMIT ?`,
    tenantId,
    ...RESTAURANT_PENDING_STATUSES,
    ...scope.params,
    SOURCE_LIMIT,
  );
  const items = [];
  for (const row of rows) {
    if (!canAccessOwner(user, row.created_by)) continue;
    if (row.status === "草稿待处理") {
      const draft = draftActions(user, row);
      items.push(
        item({
          kind: "employee_output",
          id: row.id,
          title: row.title || row.content_title,
          subtitle: draft.acceptable
            ? "质检未达标草稿：可作为内部参考稿接受，或带原要求重新派活"
            : "质检未达标草稿含未核验来源，不能直接采用；请带原要求重新派活",
          createdAt: row.created_at,
          dueAt: row.due_at,
          // 草稿不是合格产出：固定为中优先级，且动作 key 不在批量采纳白名单内
          priority: "medium",
          actions: draft.actions,
          link: restaurantTaskLink(row),
          meta: {
            source: "agent_task",
            taskStatus: row.status,
            outputId: Number(row.output_id),
            riskLevel: row.risk_level || null,
            draftAcceptable: draft.acceptable,
          },
        }),
      );
      continue;
    }
    const latestApproval = q.get(
      `SELECT * FROM approvals WHERE tenant_id=? AND target_type='content' AND target_id=?
      ORDER BY id DESC LIMIT 1`,
      tenantId,
      row.output_id,
    );
    const access = contentOutputReviewAccess(
      user,
      row,
      latestApproval,
      { id: row.output_id, creator_id: row.creator_id, risk_level: row.risk_level },
    );
    if (!access.allowed) continue;
    const adoption = loadContentAdoptionAvailability(row.output_id, { tenantId });
    if (!adoption.canAdopt && !adoption.canReject) continue;
    const actions = [];
    if (adoption.canAdopt) {
      actions.push({
        key: "adopt",
        label: "采纳",
        method: "POST",
        path: `/api/marshals/outputs/${row.output_id}/review`,
        body: { decision: "adopt" },
      });
    }
    if (adoption.canReject) {
      actions.push({
        key: "reject",
        label: "驳回",
        method: "POST",
        path: `/api/marshals/outputs/${row.output_id}/review`,
        body: { decision: "reject" },
        requiresReason: true,
        danger: true,
      });
    }
    items.push(
      item({
        kind: "employee_output",
        id: row.id,
        title: row.title || row.content_title,
        subtitle: row.status === "草稿待处理"
          ? "质检未达标草稿，等待处理"
          : adoption.canAdopt
            ? "合格产出等待人工采纳"
            : `暂不能采纳：${adoption.reason}`,
        createdAt: row.created_at,
        dueAt: row.due_at,
        priority: riskPriority(row.risk_level),
        actions,
        link: restaurantTaskLink(row),
        meta: {
          source: "agent_task",
          taskStatus: row.status,
          outputId: Number(row.output_id),
          riskLevel: row.risk_level || null,
        },
      }),
    );
  }
  return items;
}

function contentRunReviewerAllowed(user, snapshot) {
  const routing = parseObject(snapshot.approvalRouting);
  const steps = Array.isArray(routing.steps) ? routing.steps : [];
  const current = steps[Number(routing.currentStep) || 0] || steps[0] || null;
  if (routing.requiresReview === true && current) {
    if (current.level === "boss") return user.role === "boss";
    if (current.assignedReviewerId) {
      return (
        ["boss", "admin", "platform_super"].includes(user.role) ||
        Number(user.id) === Number(current.assignedReviewerId)
      );
    }
  }
  return contentEmployeeRunReviewAccess(user, snapshot).allowed;
}

// ② 内容员工 run 待审阅（canReview 口径：角色 + 锁定审阅人 + 账务/产物权威可审）
function loadContentRuns(user, tenantId) {
  if (!EMPLOYEE_REVIEW_ROLES.has(user.role)) return [];
  const scope = userScopeClause(user, "r.created_by");
  const rows = q.all(
    `SELECT r.id,r.title,r.status,r.employee_idx,r.employee_name,r.created_at,r.due_at,
      r.created_by,r.snapshot_json
    FROM content_employee_runs r
    WHERE r.tenant_id=? AND r.status='待审阅'${scope.sql}
    ORDER BY r.id DESC LIMIT ?`,
    tenantId,
    ...scope.params,
    SOURCE_LIMIT,
  );
  const items = [];
  for (const row of rows) {
    const snapshot = parseObject(row.snapshot_json);
    if (!contentRunReviewerAllowed(user, snapshot)) continue;
    const authority = loadContentEmployeeRunAuthority(row.id, { tenantId });
    if (authority.reviewable !== true) continue;
    const base = `/api/employee-workbench/content/${Number(row.employee_idx)}/runs/${row.id}/review`;
    items.push(
      item({
        kind: "content_run_review",
        id: row.id,
        title: row.title,
        subtitle: `${row.employee_name || "内容员工"} · 合格产出等待人工采纳`,
        createdAt: row.created_at,
        dueAt: row.due_at,
        priority: riskPriority(snapshot?.risk?.level || snapshot?.riskLevel),
        actions: [
          { key: "adopt", label: "采纳", method: "POST", path: base, body: { decision: "adopt" } },
          {
            key: "reject",
            label: "驳回",
            method: "POST",
            path: base,
            body: { decision: "reject" },
            requiresReason: true,
            danger: true,
          },
        ],
        link: `/content?employee=${Number(row.employee_idx)}&runId=${row.id}`,
        meta: {
          source: "content_employee_run",
          employeeIdx: Number(row.employee_idx),
          employeeName: row.employee_name || null,
        },
      }),
    );
  }
  return items;
}

// ③ 人工任务待验收（管理层，范围内且职责分离）
function loadManualReviews(user, tenantId) {
  if (!isManagerRole(user)) return [];
  const scope = userScopeClause(user, "t.assignee_id");
  const rows = q.all(
    `SELECT t.id,t.title,t.status,t.priority,t.assignee_id,t.created_at,t.due_at,u.name assignee
    FROM tasks t LEFT JOIN users u ON u.tenant_id=t.tenant_id AND u.id=t.assignee_id
    WHERE t.tenant_id=? AND t.status='待审核'${scope.sql}
      AND EXISTS (
        SELECT 1 FROM task_submissions s
        WHERE s.tenant_id=t.tenant_id AND s.task_id=t.id AND s.result='待审核'
      )
    ORDER BY t.id DESC LIMIT ?`,
    tenantId,
    ...scope.params,
    SOURCE_LIMIT,
  );
  return rows
    .filter((row) => canReviewManualTask(user, row))
    .map((row) =>
      item({
        kind: "manual_review",
        id: row.id,
        title: row.title,
        subtitle: `${row.assignee || "未分配"} 已提交，等待人工验收`,
        createdAt: row.created_at,
        dueAt: row.due_at,
        priority: manualPriority(row.priority),
        actions: [
          {
            key: "approve",
            label: "验收通过",
            method: "POST",
            path: `/api/execution/tasks/${row.id}/review`,
            body: { pass: true },
          },
          {
            key: "reject",
            label: "退回返工",
            method: "POST",
            path: `/api/execution/tasks/${row.id}/review`,
            body: { pass: false },
            requiresReason: true,
            danger: true,
          },
        ],
        link: `/tasks?kind=manual&id=${row.id}`,
        meta: { source: "task", assigneeId: Number(row.assignee_id) || null },
      }),
    );
}

// ⑤ 分派给我的任务：待接单 + 验收退回需返工
function loadMyManualTasks(user, tenantId) {
  const rows = q.all(
    `SELECT t.id,t.title,t.status,t.priority,t.created_at,t.due_at,t.assigned_by,
      (SELECT s.result FROM task_submissions s
        WHERE s.tenant_id=t.tenant_id AND s.task_id=t.id ORDER BY s.id DESC LIMIT 1) last_result,
      (SELECT s.review_reason FROM task_submissions s
        WHERE s.tenant_id=t.tenant_id AND s.task_id=t.id ORDER BY s.id DESC LIMIT 1) last_reason
    FROM tasks t
    WHERE t.tenant_id=? AND t.assignee_id=? AND t.status IN ('待执行','进行中')
    ORDER BY CASE t.priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END, t.due_at, t.id DESC
    LIMIT ?`,
    tenantId,
    user.id,
    SOURCE_LIMIT,
  );
  const items = [];
  for (const row of rows) {
    if (row.status === "待执行") {
      items.push(
        item({
          kind: "manual_todo",
          id: row.id,
          title: row.title,
          subtitle: "新任务等待接单",
          createdAt: row.created_at,
          dueAt: row.due_at,
          priority: manualPriority(row.priority),
          actions: [
            {
              key: "start",
              label: "接单开始",
              method: "PUT",
              path: `/api/execution/tasks/${row.id}`,
              body: { status: "进行中" },
            },
          ],
          link: `/tasks?kind=manual&id=${row.id}`,
          meta: { source: "task", taskStatus: row.status },
        }),
      );
      continue;
    }
    if (row.status === "进行中" && row.last_result === "驳回") {
      items.push(
        item({
          kind: "manual_todo",
          id: row.id,
          title: row.title,
          subtitle: `验收退回，需返工后重新提交${row.last_reason ? `：${row.last_reason}` : ""}`,
          createdAt: row.created_at,
          dueAt: row.due_at,
          priority: manualPriority(row.priority),
          actions: [],
          link: `/tasks?kind=manual&id=${row.id}`,
          meta: { source: "task", taskStatus: row.status, rework: true },
        }),
      );
    }
  }
  return items;
}

export function loadInbox(user, { kind = "", limit = 50 } = {}) {
  const tenantId = curTenant();
  const requestedKind = cleanText(kind, 40);
  const all = [
    ...loadApprovals(user, tenantId),
    ...loadRestaurantOutputs(user, tenantId),
    ...loadContentRuns(user, tenantId),
    ...loadManualReviews(user, tenantId),
    ...loadMyManualTasks(user, tenantId),
  ];
  const counts = Object.fromEntries(INBOX_KINDS.map((name) => [name, 0]));
  for (const entry of all) counts[entry.kind] += 1;
  const matched = (
    requestedKind && requestedKind !== "all"
      ? all.filter((entry) => entry.kind === requestedKind)
      : all
  ).sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      String(b.createdAt || "").localeCompare(String(a.createdAt || "")) ||
      b.id - a.id,
  );
  const size = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
  return {
    items: matched.slice(0, size),
    total: all.length,
    matched: matched.length,
    counts,
    kinds: INBOX_KINDS.map((name) => ({
      kind: name,
      label: INBOX_KIND_LABELS[name],
      count: counts[name],
    })),
    lowRiskAdoptable: all.filter(
      (entry) =>
        entry.priority === "low" &&
        entry.actions.some((action) => ["approve", "adopt"].includes(action.key)),
    ).length,
  };
}

router.get("/", (req, res) => {
  if (
    req.query.kind &&
    req.query.kind !== "all" &&
    !INBOX_KINDS.includes(String(req.query.kind))
  ) {
    return res.status(400).json({
      error: "不支持的收件箱分类",
      code: "INVALID_INBOX_KIND",
      allowedKinds: [...INBOX_KINDS],
    });
  }
  return res.json(loadInbox(req.user, { kind: req.query.kind, limit: req.query.limit }));
});

router.get("/count", (req, res) => {
  const inbox = loadInbox(req.user, { limit: 1 });
  res.json({
    total: inbox.total,
    counts: inbox.counts,
    lowRiskAdoptable: inbox.lowRiskAdoptable,
  });
});

export default router;
