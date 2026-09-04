// 数字员工自动进化引擎（移植 Warp 自我改进 agent 模式）。
// 闭环：老板验收反馈（采纳/驳回+理由，零新增采集摩擦）→ 改进器 AI 对比
// 「员工怎么做的 vs 老板怎么反应的」→ 提炼最小聚焦的「实战心得」提案（1-3 条）
// → 人工审批采纳 → 下次派活自动注入。心得是文件化知识（写原则+为什么），
// 不是死规则；提案永远人审后才生效，防错误反馈污染员工行为。
//
// 两个员工域共用同一张心得/提案表，靠 domain 列区分：
//   restaurant：specialist_id = specialists.id，信号来自 agent_tasks + approvals(target_type='content')
//   content   ：specialist_id = 内容员工 idx(0-10)，信号来自 content_employee_runs 的审阅结论、
//               经 contents 关联的 approvals，以及 content_publish_metrics 的分策略效果
import { curTenant, q } from '../db.js';
import { contentStrategyMetricsSummary } from './content-publish-followup.js';
import {
  EVOLUTION_DOMAINS,
  RETRO_CHANGE_TARGET_EMPLOYEE,
  RETRO_CHANGE_TARGET_LABELS,
  evolutionNotesPromptLines,
  sanitizeEvolutionNotesForPrompt,
} from './employee-evolution-prompt.js';

export {
  EVOLUTION_DOMAINS,
  RETRO_CHANGE_TARGET_EMPLOYEE,
  RETRO_CHANGE_TARGET_LABELS,
  evolutionNotesPromptLines,
  sanitizeEvolutionNotesForPrompt,
};

export const EVOLUTION_SIGNAL_DAYS = 30;
export const EVOLUTION_SIGNAL_LIMIT = 40;
export const EVOLUTION_NOTE_INJECT_LIMIT = 8;
export const EVOLUTION_MIN_SIGNALS = 3;
const RETRO_ADOPT_NOTE_PREFIX = 'retro_adopt';

function positiveDays(days) {
  return Math.max(1, Math.trunc(Number(days) || EVOLUTION_SIGNAL_DAYS));
}

function positiveLimit(limit, fallback) {
  return Math.max(1, Math.trunc(Number(limit) || fallback));
}

/**
 * 进化目标归一化：
 *   数字 / 数字字符串             → { domain:'restaurant', id: specialistId }
 *   { domain:'content', employeeIdx } → { domain:'content', id: employeeIdx }
 *   { domain:'restaurant', specialistId } → restaurant
 */
export function resolveEvolutionTarget(input) {
  if (input && typeof input === 'object') {
    const domain = EVOLUTION_DOMAINS.includes(input.domain) ? input.domain : 'restaurant';
    const raw = domain === 'content'
      ? input.employeeIdx ?? input.id
      : input.specialistId ?? input.id;
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 0) {
      throw Object.assign(new Error('进化目标员工编号无效'), { status: 400 });
    }
    if (domain === 'content' && id > 10) {
      throw Object.assign(new Error('内容员工编号必须在0-10之间'), { status: 400 });
    }
    return { domain, id };
  }
  const id = Number(input);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error('进化目标员工编号无效'), { status: 400 });
  }
  return { domain: 'restaurant', id };
}

function restaurantSignals(target, { days, limit }) {
  const rows = q.all(
    `SELECT t.id, t.title, t.type, t.requirement, t.status, t.created_at,
       a.status approval_status, a.reason approval_reason, a.decided_at
     FROM agent_tasks t
     LEFT JOIN approvals a
       ON a.tenant_id = t.tenant_id AND a.target_type = 'content' AND a.target_id = t.output_id
     WHERE t.tenant_id = ? AND t.specialist_id = ? AND t.status IN ('已完成','已驳回')
       AND t.created_at >= datetime('now','localtime',?)
     ORDER BY t.id DESC LIMIT ?`,
    curTenant(),
    target.id,
    `-${positiveDays(days)} days`,
    positiveLimit(limit, EVOLUTION_SIGNAL_LIMIT),
  );
  return rows.map(row => ({
    taskId: row.id,
    title: String(row.title || '').slice(0, 80),
    type: String(row.type || '').slice(0, 20),
    requirement: String(row.requirement || '').slice(0, 200),
    outcome: row.status,
    reason: String(row.approval_reason || '').slice(0, 300) || null,
    decidedAt: row.decided_at || row.created_at,
  }));
}

// 内容员工：content_employee_runs 已定案记录 + 工作台审阅意见 + 经 contents 关联的审批理由
function contentRunSignals(target, { days, limit }) {
  const rows = q.all(
    `SELECT r.id, r.title, r.type, r.requirement, r.status, r.created_at,
       json_extract(r.snapshot_json,'$.review.opinion') review_opinion,
       json_extract(r.snapshot_json,'$.review.decision') review_decision,
       json_extract(r.snapshot_json,'$.review.reviewedAt') reviewed_at,
       (SELECT a.status FROM approvals a
          JOIN contents c ON c.tenant_id = a.tenant_id AND c.id = a.target_id
        WHERE a.tenant_id = r.tenant_id AND a.target_type = 'content'
          AND c.source_type = 'content_employee_run' AND c.source_id = r.id
        ORDER BY a.id DESC LIMIT 1) approval_status,
       (SELECT a.reason FROM approvals a
          JOIN contents c ON c.tenant_id = a.tenant_id AND c.id = a.target_id
        WHERE a.tenant_id = r.tenant_id AND a.target_type = 'content'
          AND c.source_type = 'content_employee_run' AND c.source_id = r.id
        ORDER BY a.id DESC LIMIT 1) approval_reason
     FROM content_employee_runs r
     WHERE r.tenant_id = ? AND r.employee_idx = ? AND r.status IN ('已完成','已驳回')
       AND r.created_at >= datetime('now','localtime',?)
     ORDER BY r.id DESC LIMIT ?`,
    curTenant(),
    target.id,
    `-${positiveDays(days)} days`,
    positiveLimit(limit, EVOLUTION_SIGNAL_LIMIT),
  );
  return rows.map(row => {
    const opinion = String(row.review_opinion || '').trim();
    const approvalReason = String(row.approval_reason || '').trim();
    const reason = [opinion, approvalReason && approvalReason !== opinion ? approvalReason : '']
      .filter(Boolean)
      .join('；')
      .slice(0, 300);
    return {
      taskId: row.id,
      title: String(row.title || '').slice(0, 80),
      type: String(row.type || '').slice(0, 20),
      requirement: String(row.requirement || '').slice(0, 200),
      outcome: row.status,
      reason: reason || null,
      decidedAt: row.reviewed_at || row.created_at,
      source: 'content_employee_run',
      approvalStatus: row.approval_status || null,
      autoAdopted: row.review_decision === 'auto_adopt',
    };
  });
}

// 采集进化信号：该员工近 N 天已定案任务 + 对应验收记录（approvals.reason 是核心养料）。
// 内容域额外附带 stats.strategyStats：哪种撰稿策略的收藏率/点赞率更高（来自发布回填）。
export function collectEvolutionSignals(targetInput, {
  days = EVOLUTION_SIGNAL_DAYS,
  limit = EVOLUTION_SIGNAL_LIMIT,
} = {}) {
  const target = resolveEvolutionTarget(targetInput);
  const signals = target.domain === 'content'
    ? contentRunSignals(target, { days, limit })
    : restaurantSignals(target, { days, limit });
  const rejected = signals.filter(item => item.outcome === '已驳回');
  const stats = {
    domain: target.domain,
    total: signals.length,
    adopted: signals.filter(item => item.outcome === '已完成').length,
    rejected: rejected.length,
    rejectReasons: rejected.filter(item => item.reason).map(item => item.reason).slice(0, 12),
    windowDays: positiveDays(days),
  };
  if (target.domain === 'content') {
    let strategyStats = [];
    try {
      strategyStats = contentStrategyMetricsSummary(curTenant(), {
        days: positiveDays(days),
        employeeIdx: target.id,
      });
    } catch {
      strategyStats = [];
    }
    stats.strategyStats = strategyStats;
    stats.metricContents = strategyStats.reduce((sum, item) => sum + Number(item.contents || 0), 0);
  }
  return { signals, stats };
}

// 已生效心得（派活注入用，渐进披露：只注入最新 N 条）
export function activeEvolutionNotes(targetInput, {
  limit = EVOLUTION_NOTE_INJECT_LIMIT,
  tenantId = null,
} = {}) {
  const target = resolveEvolutionTarget(targetInput);
  return q.all(
    `SELECT id, note, rationale, evidence, created_at FROM employee_evolution_notes
     WHERE tenant_id = ? AND domain = ? AND specialist_id = ? AND status = 'active'
     ORDER BY id DESC LIMIT ?`,
    tenantId ?? curTenant(),
    target.domain,
    target.id,
    positiveLimit(limit, EVOLUTION_NOTE_INJECT_LIMIT),
  );
}

// 内容员工派活/流水线注入用：读表失败（如极早期库缺表）时返回空数组，不影响派活
export function activeContentEvolutionNotes(employeeIdx, { tenantId = null, limit } = {}) {
  try {
    return activeEvolutionNotes({ domain: 'content', employeeIdx }, { tenantId, limit });
  } catch {
    return [];
  }
}

function strategyStatsLines(stats) {
  const items = Array.isArray(stats?.strategyStats) ? stats.strategyStats : [];
  if (!items.length) return [];
  return [
    '',
    `【发布效果按策略汇总（来自发布后人工回填，平台未核验；近 ${stats.windowDays} 天）】`,
    ...items.map(item => {
      const rates = [
        item.avgSaveRate != null ? `收藏率均值 ${item.avgSaveRate}%` : '',
        item.avgLikeRate != null ? `点赞率均值 ${item.avgLikeRate}%` : '',
        item.avgCommentRate != null ? `评论率均值 ${item.avgCommentRate}%` : '',
      ].filter(Boolean).join('、');
      return `- 策略「${item.strategy}」：${item.contents} 篇已回填${rates ? `；${rates}` : '；缺少浏览量分母，无法算率'}`;
    }),
    '样本少于 3 篇的策略只记现象，不据此立心得。',
  ];
}

// 改进器 prompt（Warp 原则内嵌：写原则不写规则/解释为什么/最小编辑/过滤错误反馈）
export function buildEvolutionPrompt({ employeeName, signals, stats, existingNotes }) {
  const signalLines = signals.map(item => [
    `任务#${item.taskId}「${item.title}」（${item.type || '通用'}）`,
    `  要求：${item.requirement || '（未填）'}`,
    `  结果：${item.outcome}${item.reason ? `；老板理由：${item.reason}` : ''}`,
  ].join('\n'));
  const noteLines = existingNotes.length
    ? existingNotes.map(item => `- [id:${item.id}] ${item.note}${item.rationale ? `（为什么：${item.rationale}）` : ''}`)
    : ['（暂无已生效心得）'];
  return [
    `你是数字员工「${employeeName}」的进化教练。下面是这名员工近 ${stats.windowDays} 天任务的老板验收记录。`,
    '你的任务：对比员工的产出结果与老板的反馈，提炼出最小而聚焦的改进——最多 3 条「实战心得」。',
    '',
    '铁律（自我改进方法论）：',
    '- 写原则，不写死规则：像指导一个聪明人，不是给计算机编程；「注意口语化、别堆专业术语」优于罗列禁词表。',
    '- 每条心得必须带「为什么」：解释背后的原因，让员工下次能举一反三，而不是机械执行。',
    '- 最小编辑：只提炼反复出现或影响最大的反馈信号；单次偶发的意见不立心得。',
    '- 反馈可能是错的：情绪化、互相矛盾、与行业常识明显冲突的反馈要过滤，不照单全收。',
    '- 已有心得覆盖的问题不要重复立条；若某条已有心得被反馈证明有害或过时，提议退役它。',
    `- 反馈样本不足以支撑可靠心得时（有效驳回理由过少），如实输出 verdict="insufficient"，不要硬编。`,
    '',
    `【近期验收记录（共 ${stats.total} 条：采纳 ${stats.adopted} / 驳回 ${stats.rejected}）】`,
    ...signalLines,
    ...strategyStatsLines(stats),
    '',
    '【已生效心得（可提议退役，引用 id）】',
    ...noteLines,
    '',
    '只输出一个 JSON 对象，不要任何解释或 Markdown 代码块记号，结构：',
    '{"verdict":"ok"或"insufficient","summary":"一句话概括这轮进化的主题","additions":[{"note":"心得原则（30字内的祈使句）","rationale":"为什么（40字内）","evidence":"来自哪些反馈（简述）"}],"retireNoteIds":[要退役的已有心得id]}',
    'additions 最多 3 条；verdict=insufficient 时 additions 必须为空数组。',
  ].join('\n');
}

// 解析并校验改进器输出（fail-closed：解析不出合法结构直接抛错，不落半成品）
export function parseEvolutionProposal(rawText) {
  const text = String(rawText || '').trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/```\s*$/u, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw Object.assign(new Error('进化提案输出不是合法 JSON'), { status: 422 });
  }
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw Object.assign(new Error('进化提案 JSON 解析失败'), { status: 422 });
  }
  const verdict = parsed?.verdict === 'insufficient' ? 'insufficient' : 'ok';
  const additions = (Array.isArray(parsed?.additions) ? parsed.additions : [])
    .map(item => ({
      note: String(item?.note || '').trim().slice(0, 120),
      rationale: String(item?.rationale || '').trim().slice(0, 160),
      evidence: String(item?.evidence || '').trim().slice(0, 200),
    }))
    .filter(item => item.note.length >= 4)
    .slice(0, 3);
  const retireNoteIds = (Array.isArray(parsed?.retireNoteIds) ? parsed.retireNoteIds : [])
    .map(Number)
    .filter(Number.isSafeInteger)
    .slice(0, 5);
  if (verdict === 'ok' && !additions.length && !retireNoteIds.length) {
    throw Object.assign(new Error('进化提案没有给出任何有效心得或退役建议'), { status: 422 });
  }
  return {
    verdict,
    summary: String(parsed?.summary || '').trim().slice(0, 120),
    additions: verdict === 'insufficient' ? [] : additions,
    retireNoteIds: verdict === 'insufficient' ? [] : retireNoteIds,
  };
}

// ===== 复盘 → 心得：老板在工作台勾选复盘官 next_draft_changes 后直接写成 active 心得 =====

export function retroAdoptionEvidenceKey(runId, index) {
  return `${RETRO_ADOPT_NOTE_PREFIX}:run#${Number(runId)}:change[${Number(index)}]`;
}

/**
 * 把复盘官 next_draft_changes 中被勾选的条目写入目标员工的心得库。
 * 老板勾选即人审确认，因此直接 active（不再走提案）。幂等：同一 run 同一条目只写一次。
 * @returns {{ adopted: Array, skipped: Array }}
 */
export function adoptRetrospectiveDraftChanges({
  tenantId,
  runId,
  contentId = null,
  changes,
  indexes,
}) {
  const tid = Number(tenantId) || curTenant();
  const list = Array.isArray(changes) ? changes : [];
  const adopted = [];
  const skipped = [];
  const seen = new Set();
  for (const rawIndex of Array.isArray(indexes) ? indexes : []) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= list.length || seen.has(index)) {
      skipped.push({ index: rawIndex, reason: 'invalid_index' });
      continue;
    }
    seen.add(index);
    const change = list[index];
    const target = String(change?.target || '');
    const employeeIdx = RETRO_CHANGE_TARGET_EMPLOYEE[target];
    if (employeeIdx === undefined) {
      skipped.push({ index, reason: 'unknown_target' });
      continue;
    }
    const evidenceKey = retroAdoptionEvidenceKey(runId, index);
    const existing = q.get(
      `SELECT id, status FROM employee_evolution_notes
       WHERE tenant_id = ? AND domain = 'content' AND specialist_id = ? AND evidence = ?
       ORDER BY id DESC LIMIT 1`,
      tid,
      employeeIdx,
      evidenceKey,
    );
    if (existing) {
      adopted.push({
        index,
        target,
        employeeIdx,
        noteId: Number(existing.id),
        created: false,
        status: existing.status,
      });
      continue;
    }
    const note = `${RETRO_CHANGE_TARGET_LABELS[target] || target}：${String(change?.change || '').trim()}`.slice(0, 260);
    const rationale = [
      String(change?.evidence || '').trim(),
      contentId ? `（内容#${Number(contentId)}人工回填，平台未核验）` : '',
    ].filter(Boolean).join('').slice(0, 260) || null;
    const inserted = q.run(
      `INSERT INTO employee_evolution_notes(tenant_id,domain,specialist_id,note,rationale,evidence,status,proposal_id)
       VALUES(?,'content',?,?,?,?,'active',NULL)`,
      tid,
      employeeIdx,
      note,
      rationale,
      evidenceKey,
    );
    adopted.push({
      index,
      target,
      employeeIdx,
      noteId: Number(inserted.lastInsertRowid),
      created: true,
      status: 'active',
    });
  }
  return { adopted, skipped };
}
