// 数字员工「自我介绍」：老板一眼看到"这个员工现在认为自己是谁、会什么、为我们公司记住了什么"，
// 并能随时矫正（老板叮嘱）。四段全部由服务端拼装成结构化字段：
//   ① 我是谁（catalog）②我能为你做什么（catalog deliverables）
//   ③ 我为贵公司记住了什么（企业补充提示词摘要 / 已采纳心得 / 启用技能数，只读汇总）
//   ④ 老板叮嘱（tenant_specialist_overrides.self_intro，可编辑，派活时注入 system prompt）
// 每周一 09:00 由 scheduler 跑 employee-intro-check.js 的确定性校验，命中即提醒老板确认。
import { curTenant, q } from "../db.js";
import { loadRestaurantCatalog } from "../catalog/restaurant.js";
import { canonicalRestaurantEmployeeProfileFor } from "./canonical-employee-profile.js";
import { activeEvolutionNotes } from "./employee-evolution.js";
import { scanText } from "./risk.js";
import { logOp, notify } from "../util.js";
import {
  buildEmployeeWorkbench,
  ownerSelfIntroRow,
} from "../employee-workbench.js";
import {
  INTRO_CHECK_STATUS,
  SELF_INTRO_MAX_CHARS,
  buildRosterIndex,
  checkSelfIntro,
} from "./employee-intro-check.js";

export const SELF_INTRO_DOMAINS = Object.freeze(["restaurant", "content"]);
export const SELF_INTRO_MANAGER_ROLES = new Set(["boss", "admin", "platform_super"]);
export const SELF_INTRO_SOURCES = Object.freeze({
  CATALOG: "catalog",
  AI_GENERATED: "ai_generated",
  OWNER_EDITED: "owner_edited",
});
const DELIVERABLE_MIN = 3;
const DELIVERABLE_MAX = 5;
const NOTE_LIMIT = 20;

const RESTAURANT_CATALOG = loadRestaurantCatalog();
const ROSTER_INDEX = buildRosterIndex(RESTAURANT_CATALOG.employees);

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

export function assertSelfIntroDomain(domain) {
  const value = String(domain || "").trim();
  if (!SELF_INTRO_DOMAINS.includes(value)) {
    throw httpError("domain 仅支持 restaurant 或 content", 404);
  }
  if (value !== "restaurant") {
    // 内容团队员工没有 specialist_id / 进化心得链路，本期自我介绍页只覆盖餐饮数字员工。
    throw httpError("内容团队员工的自我介绍页尚未开放，本期只覆盖餐饮数字员工", 501);
  }
  return value;
}

function catalogEmployee(idx) {
  const employeeIdx = Number(idx);
  const employee = RESTAURANT_CATALOG.employees.find((item) => item.idx === employeeIdx);
  if (!Number.isInteger(employeeIdx) || !employee) {
    throw httpError("餐饮数字员工不存在", 404);
  }
  return employee;
}

function specialistFor(employee) {
  const row = q.get(
    "SELECT id, name FROM specialists WHERE employee_idx=?",
    employee.idx,
  );
  if (!row) throw httpError(`员工${employee.idx}未同步到运行目录`, 409);
  return row;
}

function enterprisePromptFor(idx, tenantId) {
  return (
    q.get(
      "SELECT prompt_override FROM employee_workbench_configs WHERE tenant_id=? AND employee_idx=?",
      tenantId,
      Number(idx),
    )?.prompt_override || null
  );
}

function plainText(value) {
  return String(value ?? "")
    .replace(/^提供[：:]\s*/u, "")
    .replace(/\*\*|__|[*`#]/gu, "")
    .replace(/[。；;]$/u, "")
    .trim();
}

function localDateTimeSql(offset = null) {
  return offset
    ? q.get("SELECT datetime('now','localtime',?) value", offset)?.value
    : q.get("SELECT datetime('now','localtime') value")?.value;
}

function daysSince(value) {
  if (!value) return null;
  const parsed = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 86_400_000));
}

function upsertOverride(tenantId, specialistId, patch) {
  // name 列 NOT NULL，但写空串即可让 mergeSpecialist 的 `ov.name || base.name` 继续回落 catalog，
  // 不会像旧的改名功能那样把目录名钉死在租户覆盖行上。
  const columns = Object.keys(patch);
  if (!columns.length) return;
  q.run(
    `INSERT INTO tenant_specialist_overrides(tenant_id,specialist_id,name,${columns.join(",")})
     VALUES(?,?,'',${columns.map(() => "?").join(",")})
     ON CONFLICT(tenant_id,specialist_id) DO UPDATE SET
       ${columns.map((column) => `${column}=excluded.${column}`).join(",")},
       updated_at=datetime('now','localtime')`,
    tenantId,
    Number(specialistId),
    ...columns.map((column) => patch[column]),
  );
}

function checkView(row) {
  const status = row?.self_intro_check_status || INTRO_CHECK_STATUS.NEVER;
  return {
    status,
    note: row?.self_intro_check_note || null,
    verifiedAt: row?.self_intro_verified_at || null,
    verifiedDaysAgo: daysSince(row?.self_intro_verified_at),
    mode: "deterministic",
    llmAvailable: false,
  };
}

/**
 * 读取四段自我介绍 + 校验状态。所有登录用户可读；第③段企业补充提示词原文只给管理层。
 */
export function buildEmployeeSelfIntro(idx, { tenantId = curTenant(), user = null } = {}) {
  const employee = catalogEmployee(idx);
  const specialist = specialistFor(employee);
  const canonical = canonicalRestaurantEmployeeProfileFor(employee.idx);
  const manager = SELF_INTRO_MANAGER_ROLES.has(user?.role);
  const row = ownerSelfIntroRow(specialist.id, tenantId);
  const enterprisePrompt = enterprisePromptFor(employee.idx, tenantId);
  const notes = activeEvolutionNotes(specialist.id, { tenantId, limit: NOTE_LIMIT });
  // 技能数来自工作台（与员工目录卡片一致，数量本身对全员展示）；不返回工作台其他面板。
  const workbench = buildEmployeeWorkbench(employee.idx, { tenantId, user, taskLimit: 1 });
  const deliverables = (canonical.workMethod.deliverables || [])
    .map(plainText)
    .filter(Boolean);
  const coreDeliverables = deliverables.slice(
    0,
    Math.max(DELIVERABLE_MIN, Math.min(DELIVERABLE_MAX, deliverables.length)),
  );
  const ownerNotes = String(row?.self_intro || "").trim() || null;
  return {
    domain: "restaurant",
    idx: employee.idx,
    specialistId: specialist.id,
    whoAmI: {
      person: canonical.identity.person,
      name: canonical.identity.name,
      duty: canonical.identity.duty,
      positioning: canonical.identity.intro || employee.intro || "",
      department: canonical.identity.department.name,
      departmentEmoji: canonical.identity.department.emoji,
      color: canonical.identity.color || employee.color || "",
      emoji: canonical.identity.emoji || employee.emoji || "",
      source: "server/catalog/restaurant.json",
    },
    whatICanDo: {
      deliverables: coreDeliverables,
      totalDeliverables: deliverables.length,
      source: "catalog.deliverables",
    },
    whatIRemember: {
      enterprisePrompt: {
        present: Boolean(enterprisePrompt),
        chars: enterprisePrompt ? enterprisePrompt.length : 0,
        text: manager ? enterprisePrompt : null,
        redacted: !manager,
        boundary: manager
          ? null
          : "企业补充提示词原文仅老板、管理员和平台超管可查看；此处只给字数。",
      },
      evolutionNotes: notes.map((note) => ({
        id: note.id,
        note: note.note,
        rationale: note.rationale || null,
        createdAt: note.created_at,
      })),
      enabledSkillCount: workbench.skillLibrary.enabled.length,
      learnedSkillCount: workbench.skillLibrary.learned.filter(
        (skill) => skill.origin !== "legacy_learned",
      ).length,
      source: "override + evolution + skills（只读汇总）",
    },
    ownerNotes: {
      text: ownerNotes,
      source: row?.self_intro_source || SELF_INTRO_SOURCES.CATALOG,
      updatedAt: row?.self_intro_updated_at || null,
      maxChars: SELF_INTRO_MAX_CHARS,
      injected: Boolean(ownerNotes),
      fallback: ownerNotes ? null : canonical.identity.intro || employee.intro || "",
    },
    check: checkView(row),
    permissions: {
      canEdit: manager,
      canVerify: manager,
      canViewEnterprisePrompt: manager,
    },
  };
}

export function updateEmployeeSelfIntro(idx, rawText, user, { tenantId = curTenant() } = {}) {
  if (!SELF_INTRO_MANAGER_ROLES.has(user?.role)) {
    throw httpError("仅老板或管理员可修改数字员工的老板叮嘱", 403);
  }
  if (rawText != null && typeof rawText !== "string") {
    throw httpError("老板叮嘱必须是文本", 400);
  }
  const text = String(rawText ?? "").trim();
  if (text.length > SELF_INTRO_MAX_CHARS) {
    throw httpError(`老板叮嘱不能超过${SELF_INTRO_MAX_CHARS}字`, 400);
  }
  const employee = catalogEmployee(idx);
  const specialist = specialistFor(employee);
  upsertOverride(tenantId, specialist.id, {
    self_intro: text || null,
    self_intro_source: text ? SELF_INTRO_SOURCES.OWNER_EDITED : SELF_INTRO_SOURCES.CATALOG,
    self_intro_updated_at: localDateTimeSql(),
  });
  logOp(
    user,
    "数字员工",
    text ? "更新老板叮嘱" : "清空老板叮嘱",
    `${employee.person}#${employee.idx}`,
  );
  return buildEmployeeSelfIntro(employee.idx, { tenantId, user });
}

/**
 * 跑一次确定性校验并落库 check_status / check_note。调度器与手动按钮共用。
 */
export function verifyEmployeeSelfIntro(idx, { tenantId = curTenant(), now = new Date(), mode = "deterministic" } = {}) {
  const employee = catalogEmployee(idx);
  const specialist = specialistFor(employee);
  const row = ownerSelfIntroRow(specialist.id, tenantId);
  const notes = activeEvolutionNotes(specialist.id, { tenantId, limit: 50 });
  const result = checkSelfIntro({
    mode,
    employee,
    rosterIndex: ROSTER_INDEX,
    selfIntro: row?.self_intro || null,
    selfIntroUpdatedAt: row?.self_intro_updated_at || null,
    evolutionNotes: notes,
    enterprisePrompt: enterprisePromptFor(employee.idx, tenantId),
    verifiedAt: row?.self_intro_verified_at || null,
    now,
    scanRisk: scanText,
  });
  upsertOverride(tenantId, specialist.id, {
    self_intro_check_status: result.status,
    self_intro_check_note: result.note,
  });
  return {
    idx: employee.idx,
    specialistId: specialist.id,
    person: employee.person,
    name: employee.name,
    ...result,
  };
}

export function confirmEmployeeSelfIntro(idx, user, { tenantId = curTenant() } = {}) {
  if (!SELF_INTRO_MANAGER_ROLES.has(user?.role)) {
    throw httpError("仅老板或管理员可确认数字员工的自我介绍", 403);
  }
  const employee = catalogEmployee(idx);
  const specialist = specialistFor(employee);
  upsertOverride(tenantId, specialist.id, {
    self_intro_verified_at: localDateTimeSql(),
    self_intro_check_status: INTRO_CHECK_STATUS.OK,
    self_intro_check_note: null,
  });
  logOp(user, "数字员工", "确认自我介绍无误", `${employee.person}#${employee.idx}`);
  return buildEmployeeSelfIntro(employee.idx, { tenantId, user });
}

/**
 * 每周校验对象：本租户有老板叮嘱 / 有企业补充提示词 / 有已采纳心得的员工（没定制过的员工与 catalog 完全一致，不用查）。
 */
export function candidateIntroCheckEmployees(tenantId = curTenant()) {
  const rows = q.all(
    `SELECT DISTINCT s.employee_idx idx
     FROM specialists s
     WHERE s.employee_idx BETWEEN 101 AND 161 AND (
       EXISTS(SELECT 1 FROM tenant_specialist_overrides o
              WHERE o.tenant_id=? AND o.specialist_id=s.id AND COALESCE(o.self_intro,'')<>'')
       OR EXISTS(SELECT 1 FROM employee_workbench_configs c
              WHERE c.tenant_id=? AND c.employee_idx=s.employee_idx AND COALESCE(c.prompt_override,'')<>'')
       OR EXISTS(SELECT 1 FROM employee_evolution_notes n
              WHERE n.tenant_id=? AND n.specialist_id=s.id AND n.status='active')
     )
     ORDER BY s.employee_idx`,
    tenantId,
    tenantId,
    tenantId,
  );
  return rows.map((row) => Number(row.idx));
}

/**
 * 周任务：逐员工校验，命中 needs_review 的汇总成一条站内通知发给 boss/admin（不逐人刷屏）。
 */
export function runWeeklyEmployeeIntroCheck({ tenantId = curTenant(), now = new Date(), notifyFn = notify } = {}) {
  const flagged = [];
  let checked = 0;
  for (const idx of candidateIntroCheckEmployees(tenantId)) {
    try {
      const result = verifyEmployeeSelfIntro(idx, { tenantId, now });
      checked += 1;
      if (result.status === INTRO_CHECK_STATUS.NEEDS_REVIEW) flagged.push(result);
    } catch {
      /* 单个员工校验失败不影响其他员工 */
    }
  }
  let notified = 0;
  if (flagged.length) {
    const recipients = q.all(
      "SELECT id FROM users WHERE tenant_id=? AND role IN ('boss','admin') AND status='启用'",
      tenantId,
    );
    const names = flagged
      .slice(0, 5)
      .map((item) => `${item.person}（${item.name}）`)
      .join("、");
    const link =
      flagged.length === 1
        ? `/employees/restaurant/${flagged[0].idx}/intro`
        : "/employees?introCheck=needs_review";
    for (const recipient of recipients) {
      try {
        notifyFn(
          recipient.id,
          "employee-intro-check",
          `本周有 ${flagged.length} 位数字员工的自我介绍需要你确认`,
          `${names}${flagged.length > 5 ? " 等" : ""}：${flagged[0].note || "请打开员工页查看校验说明"}`.slice(0, 500),
          link,
        );
        notified += 1;
      } catch {
        /* 通知失败不影响校验结果落库 */
      }
    }
  }
  return {
    tenantId,
    checked,
    needsReview: flagged.length,
    flaggedIdx: flagged.map((item) => item.idx),
    notified,
  };
}
