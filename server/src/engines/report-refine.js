// 报告多轮优化：老板拿到数字员工的报告后，针对“这一份报告”继续对话修改，
// 每一轮产生一个新版本（agent_task_revisions），原稿与历史版本原样保留，
// 版本可分别复制、导出 PDF/Word。真实计费、fail-closed：模型没有交付完整新版
// 就不落库、不扣费。
//
// 边界：修订不改变任务的采纳/审批状态，也不改写 contents 原文；修订稿是老板
// 亲自定稿的工作版本，导出文件按 agent_task_revision 来源单独生成。

import { curTenant, q } from "../db.js";
import { canAccessOwner } from "./access.js";
import { generate } from "./ai.js";
import { textModelFor, yunwuAvailable } from "./yunwu.js";
import {
  estimateCallCredits,
  holdCredits,
  precheckByRole,
  refundHold,
  releaseHold,
  settleHold,
} from "./credits.js";
import { executeHeldDelivery } from "./two-phase-delivery.js";
import { assertRealAiOutput } from "./ai-delivery-status.js";
import { scanText } from "./risk.js";
import { prepareRestaurantArtifactSource } from "./restaurant-output-export.js";
import { cleanReportBody } from "../../../shared/report-body.mjs";
import { buildAssumptionChangeInstruction, extractReportAssumptions } from "./report-assumptions.js";

export const REPORT_REFINE_MAX_INSTRUCTION = 1200;
export const REPORT_REFINE_MAX_VERSIONS = 30;
export const REPORT_REFINE_PROVIDER_TIMEOUT_MS = 120_000;
const CHANGE_SUMMARY_MARKER = "【本次修改摘要】";
const REFINABLE_TASK_STATUSES = new Set(["已完成", "待审阅", "草稿待处理", "草稿已接受"]);

// 老板常用的一句话修改意图，前端做成快捷按钮，服务端只当普通指令处理。
export const REPORT_REFINE_QUICK_INSTRUCTIONS = Object.freeze([
  { key: "shorter", label: "更简短", instruction: "把报告压缩到原来一半以内，只保留结论、关键数字和行动清单，删掉铺垫和重复解释。" },
  { key: "plain", label: "更口语", instruction: "把全文改成老板一眼能懂的大白话，专业词首次出现用括号一句话解释，不改任何数字与来源。" },
  { key: "actions", label: "加行动清单", instruction: "在报告末尾“下一步建议”里补一张行动清单表：事项｜负责人｜完成时限｜验收标准，每条都要能直接执行。" },
  { key: "compare", label: "改成对比表", instruction: "把正文中的竞品/方案对比部分改写成一张对比表，列出对比维度、各方数据与结论，数据只用报告里已有的。" },
  { key: "summary", label: "只要摘要", instruction: "只保留一段 5 句以内的老板摘要 + 3 条最重要的行动，其余全部删除。" },
  // PRD v2.2 FR-7.1 新增的快捷形态切换
  { key: "boss", label: "换成老板版", instruction: "改写成老板版：全文不超过 300 字，只写结论、关键数字和要老板拍板的 1–3 件事，不改任何数字与来源。" },
  { key: "manager", label: "换成店长执行版", instruction: "改写成店长执行版：按“今天/本周/本月”分组列出具体动作，每条写负责人、完成时限和验收标准，去掉分析过程，不改任何数字与来源。" },
  { key: "table", label: "换成表格", instruction: "把正文主要内容改写成 1–3 张表格（结论表、数据表、行动表），表外最多保留 3 行说明，数据只用报告里已有的。" },
]);

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

export function readableBody(rawBody, { title, requirement }) {
  const original = String(rawBody || "");
  if (!original.trim()) return "";
  const prepared = prepareRestaurantArtifactSource(original, { title, requirement });
  return cleanReportBody(String(prepared.body || "")).trim();
}

function loadTaskForUser(taskId, user) {
  const id = Number(taskId);
  if (!Number.isSafeInteger(id) || id <= 0) throw httpError(400, "任务编号无效");
  const tenantId = curTenant();
  const task = q.get(
    `SELECT t.id,t.title,t.requirement,t.status,t.created_by,t.output_id,t.specialist_id,
      t.employee_config_snapshot,t.created_at,
      c.body output_body,c.title output_title,
      s.name employee_name,s.person employee_person,s.duty employee_duty,s.employee_idx
     FROM agent_tasks t
     LEFT JOIN contents c ON c.tenant_id=t.tenant_id AND c.id=t.output_id
     LEFT JOIN specialists s ON s.id=t.specialist_id
     WHERE t.tenant_id=? AND t.id=?`,
    tenantId,
    id,
  );
  if (!task || !canAccessOwner(user, task.created_by)) {
    throw httpError(404, "任务不存在或无权查看");
  }
  return task;
}

function listRevisionRows(taskId) {
  return q.all(
    `SELECT id,task_id,version,base_revision_id,instruction,body,change_summary,model,
      risk_level,risk_flags,created_by,created_at
     FROM agent_task_revisions WHERE tenant_id=? AND task_id=? ORDER BY version ASC`,
    curTenant(),
    Number(taskId),
  );
}

function publicRevision(row, { includeBody = true } = {}) {
  let riskFlags = [];
  try {
    riskFlags = JSON.parse(row.risk_flags || "[]");
  } catch {
    riskFlags = [];
  }
  return {
    id: Number(row.id),
    version: Number(row.version),
    baseRevisionId: row.base_revision_id == null ? null : Number(row.base_revision_id),
    instruction: String(row.instruction || ""),
    changeSummary: String(row.change_summary || ""),
    model: row.model || null,
    risk: { level: row.risk_level || "none", flags: Array.isArray(riskFlags) ? riskFlags : [] },
    createdAt: row.created_at,
    downloadSource: { sourceType: "agent_task_revision", sourceId: Number(row.id) },
    generateUrl: `/api/files/artifacts/source/agent_task_revision/${Number(row.id)}`,
    ...(includeBody ? { markdown: String(row.body || "") } : {}),
  };
}

function refineAvailability(task, baseMarkdown, revisionCount) {
  if (!REFINABLE_TASK_STATUSES.has(String(task.status || ""))) {
    return { available: false, reason: "任务还没有交付报告，等员工完成后再来优化" };
  }
  if (!baseMarkdown) return { available: false, reason: "这份任务没有可读的报告正文" };
  if (revisionCount >= REPORT_REFINE_MAX_VERSIONS) {
    return { available: false, reason: `这份报告已优化 ${REPORT_REFINE_MAX_VERSIONS} 版，请带着定稿版本重新派活` };
  }
  if (!yunwuAvailable()) return { available: false, reason: "真实 AI 通道未配置，无法继续优化" };
  return { available: true, reason: null };
}

export function getReportRefineState(user, taskId) {
  const task = loadTaskForUser(taskId, user);
  const baseMarkdown = readableBody(task.output_body, {
    title: task.output_title || task.title,
    requirement: task.requirement,
  });
  const revisions = listRevisionRows(task.id).map((row) => publicRevision(row));
  const availability = refineAvailability(task, baseMarkdown, revisions.length);
  // FR-7.1：最新版本里的“可改的假设”表格（兼容中文章节号与任务书给定预算）→ 前端可编辑卡片。
  const assumptions = extractReportAssumptions(
    revisions.length ? revisions.at(-1).markdown : baseMarkdown,
    { requirement: revisions.length ? "" : task.requirement },
  );
  return {
    task: {
      id: Number(task.id),
      title: String(task.title || ""),
      status: String(task.status || ""),
      employee: {
        idx: Number(task.employee_idx) || null,
        person: task.employee_person || "",
        name: task.employee_name || "数字员工",
      },
    },
    original: {
      version: 0,
      markdown: baseMarkdown,
      generateUrl: `/api/files/artifacts/source/agent_task/${Number(task.id)}`,
    },
    revisions,
    latestVersion: revisions.length ? revisions.at(-1).version : 0,
    availability,
    quickInstructions: REPORT_REFINE_QUICK_INSTRUCTIONS,
    assumptions,
    boundary: "每一轮优化都保留为独立版本；原稿与任务采纳状态不变，修订稿由你定稿后可单独导出 PDF/Word。",
  };
}

export function buildReportRefinePrompt({ task, baseMarkdown, baseVersion, history, instruction }) {
  const employee = `${task.employee_person || ""}${task.employee_name ? `（${task.employee_name}）` : ""}`.trim() || "数字员工";
  const system = [
    `你是餐饮数字员工 ${employee}${task.employee_duty ? `，岗位职责：${String(task.employee_duty).slice(0, 120)}` : ""}。老板正在就你刚交付的这份报告提出修改意见，你要在现稿基础上出一版新的完整报告。`,
    "修改规则：",
    "1. 只改老板本轮要求改的部分；没提到的段落、数字、来源、日期、表格逐字保留，不得顺手润色或删减。",
    "2. 不得新增任何原报告里没有、老板本轮也没有提供的事实性数字（价格、距离、人数、销量、评分等）。确需补充而没有依据时，写“待现场核实”并归入报告末尾的“## 待补数据与现场核实清单”。",
    "3. 原报告末尾如有“## 数据来源与时效”段落，必须原样保留在新版末尾，不改一字。",
    "4. 老板要求压缩/口语化/展开某部分/改成表格/加行动清单/换语气等，都按要求执行；要求“展开”时只能基于已有事实展开分析与建议，不能编造新事实。",
    "5. 输出完整的新版报告 Markdown（不是差异、不是只写改动段），保留一级标题结构；不要写“好的/已按要求修改”等对话开场白。",
    `6. 报告正文写完后，另起一行输出 “${CHANGE_SUMMARY_MARKER}”，后面用 1-3 句话说明本轮改了什么、哪些要求因缺依据没有照做（如有）。`,
  ].join("\n");
  const historyBlock = history.length
    ? [
        "【历次修改要求（按时间顺序，已在现稿中体现）】",
        ...history.map((item) => `第${item.version}版：${item.instruction}`),
      ].join("\n")
    : "";
  const userMsg = [
    `【原任务】${String(task.title || "").slice(0, 200)}`,
    task.requirement ? `【老板原始要求】${String(task.requirement).slice(0, 2000)}` : "",
    historyBlock,
    `【现稿·第${baseVersion}版全文】`,
    baseMarkdown,
    "",
    `【老板本轮修改要求】${instruction}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { system, userMsg };
}

export function parseRefinedReport(rawText) {
  const text = String(rawText || "")
    .replace(/^```(?:markdown|md)?\s*/iu, "")
    .replace(/```\s*$/u, "")
    .trim();
  if (!text) return null;
  const markerIndex = text.lastIndexOf(CHANGE_SUMMARY_MARKER);
  let markdown = text;
  let changeSummary = "";
  if (markerIndex >= 0) {
    markdown = text.slice(0, markerIndex).replace(/\n-{3,}\s*$/u, "").trim();
    changeSummary = text.slice(markerIndex + CHANGE_SUMMARY_MARKER.length).replace(/^[:：\s]+/u, "").trim().slice(0, 600);
  }
  markdown = cleanReportBody(markdown).trim();
  if (markdown.length < 40) return null;
  return { markdown, changeSummary };
}

export async function refineReport(user, taskId, body = {}, { signal } = {}) {
  let instruction = String(body?.instruction || "").trim();
  const assumptionChanges = Array.isArray(body?.assumptionChanges) ? body.assumptionChanges.slice(0, 20) : null;
  if (!instruction && !assumptionChanges?.length) throw httpError(400, "先说说这份报告要怎么改");
  if (instruction.length > REPORT_REFINE_MAX_INSTRUCTION) {
    throw httpError(400, `修改要求最长 ${REPORT_REFINE_MAX_INSTRUCTION} 字，请精简后再试`);
  }
  const task = loadTaskForUser(taskId, user);
  const revisionRows = listRevisionRows(task.id);
  const originalMarkdown = readableBody(task.output_body, {
    title: task.output_title || task.title,
    requirement: task.requirement,
  });
  const availability = refineAvailability(task, originalMarkdown, revisionRows.length);
  if (!availability.available) throw httpError(409, availability.reason, { code: "REPORT_REFINE_UNAVAILABLE" });

  const requestedBase = body?.baseRevisionId == null ? null : Number(body.baseRevisionId);
  const baseRow = requestedBase
    ? revisionRows.find((row) => Number(row.id) === requestedBase)
    : revisionRows.at(-1) || null;
  if (requestedBase && !baseRow) throw httpError(404, "要修改的版本不存在");
  const baseMarkdown = baseRow ? String(baseRow.body || "") : originalMarkdown;
  const baseVersion = baseRow ? Number(baseRow.version) : 0;
  // FR-7.1：老板在假设卡片上改了值 → 生成结构化重算指令（不重新检索）。
  if (assumptionChanges?.length) {
    const built = buildAssumptionChangeInstruction(
      extractReportAssumptions(baseMarkdown, { requirement: baseRow ? "" : task.requirement }),
      assumptionChanges,
    );
    if (!built.applied.length) throw httpError(400, "没有识别到改动的假设，请修改卡片上的数值后再重算");
    instruction = instruction
      ? `${built.instruction}\n补充要求：${instruction}`.slice(0, REPORT_REFINE_MAX_INSTRUCTION)
      : built.instruction;
  }
  const history = revisionRows
    .filter((row) => !baseRow || Number(row.version) <= Number(baseRow.version))
    .slice(-6)
    .map((row) => ({ version: Number(row.version), instruction: String(row.instruction || "").slice(0, 300) }));
  const { system, userMsg } = buildReportRefinePrompt({ task, baseMarkdown, baseVersion, history, instruction });
  const model = textModelFor(user.role);
  // 新版长度≈现稿长度（中文约 1.3 字/token）+ 改动余量；上限保护成本。
  const outputTokens = Math.min(16000, Math.max(3000, Math.ceil(baseMarkdown.length / 1.3) + 2500));
  const tenantId = curTenant();
  let hold = null;
  try {
    precheckByRole(user.id, "text", user.role);
    hold = holdCredits({
      userId: user.id,
      feature: `报告多轮优化·任务#${task.id}`,
      kind: "text",
      model,
      credits: estimateCallCredits({ model, outputTokens, texts: [system, userMsg] }),
      refType: "agent_task_revision",
      refId: null,
    });
    const deliveryHold = hold;
    hold = null;
    const delivered = await executeHeldDelivery({
      hold: deliveryHold,
      refund: refundHold,
      hasDeliverable: () =>
        Boolean(
          q.get(
            "SELECT id FROM agent_task_revisions WHERE tenant_id=? AND hold_id=?",
            tenantId,
            deliveryHold.holdId,
          ),
        ),
      generate: async () => {
        const output = await generate({
          kind: "employee-report-refine",
          system,
          userMsg,
          fallback: () => "",
          maxTokens: outputTokens,
          role: user.role,
          model,
          thinking: false,
          timeoutMs: REPORT_REFINE_PROVIDER_TIMEOUT_MS,
          providerPolicy: "yunwu_only",
          signal,
        });
        assertRealAiOutput(output, {
          label: "报告优化",
          noDelivery: "本次不产生新版本，也不扣费",
        });
        const parsed = parseRefinedReport(output.text);
        if (!parsed) {
          throw httpError(422, "模型没有交付完整的新版报告，本次不落库、不扣费，请换个说法再试", {
            code: "REPORT_REFINE_INVALID_OUTPUT",
            retryable: true,
          });
        }
        return { ...parsed, output };
      },
      persist: (generated) => {
        const risk = scanText(generated.markdown);
        const nextVersion = (Number(q.get(
          "SELECT MAX(version) v FROM agent_task_revisions WHERE tenant_id=? AND task_id=?",
          tenantId,
          task.id,
        )?.v) || 0) + 1;
        const inserted = q.run(
          `INSERT INTO agent_task_revisions(
            task_id,version,base_revision_id,instruction,body,change_summary,model,hold_id,
            risk_level,risk_flags,created_by
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          task.id,
          nextVersion,
          baseRow ? Number(baseRow.id) : null,
          instruction,
          generated.markdown,
          generated.changeSummary || null,
          generated.output.model || model,
          deliveryHold.holdId,
          risk.level,
          JSON.stringify(risk.hits.map((hit) => hit.code)),
          user.id,
        );
        const row = q.get(
          `SELECT id,task_id,version,base_revision_id,instruction,body,change_summary,model,
            risk_level,risk_flags,created_by,created_at
           FROM agent_task_revisions WHERE tenant_id=? AND id=?`,
          tenantId,
          inserted.lastInsertRowid,
        );
        return publicRevision(row);
      },
      settle: settleHold,
      release: releaseHold,
      settlement: (generated) => ({
        usage: generated.output.usage,
        model: generated.output.model,
        aiMode: generated.output.mode,
        note: `报告多轮优化：任务#${task.id} 第${baseVersion}版→新版`,
      }),
      requirePositiveApiUsage: true,
      releaseNote: "报告优化未形成新版本，预授权全额退回",
    });
    return {
      revision: delivered.delivery,
      billing: delivered.billing,
      boundary: "新版本已保存为独立修订稿；原稿与任务采纳状态不变。",
    };
  } catch (error) {
    if (hold) {
      try {
        releaseHold(hold, "报告优化未进入模型生成，预授权全额退回");
      } catch {
        /* keep original error */
      }
      hold = null;
    }
    throw error;
  }
}

/** files.js 交付文件来源：修订稿按 agent_task_revision 单独生成 PDF/Word。 */
export function loadRevisionArtifactSource(revisionId) {
  const id = Number(revisionId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = q.get(
    `SELECT r.id,r.version,r.body,r.created_at,r.task_id,t.title task_title,t.created_by,
      c.title output_title
     FROM agent_task_revisions r
     JOIN agent_tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
     LEFT JOIN contents c ON c.tenant_id=t.tenant_id AND c.id=t.output_id
     WHERE r.tenant_id=? AND r.id=?`,
    curTenant(),
    id,
  );
  if (!row) return null;
  const baseTitle = String(row.output_title || row.task_title || "餐饮数字员工报告").trim().slice(0, 80);
  return {
    id,
    ownerId: Number(row.created_by),
    title: `${baseTitle}·第${Number(row.version)}版`,
    body: String(row.body || ""),
    status: "修订稿",
    draft: false,
    updatedAt: row.created_at || null,
    taskId: Number(row.task_id),
  };
}
