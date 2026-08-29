// 数字员工自动进化引擎（移植 Warp 自我改进 agent 模式）。
// 闭环：老板验收反馈（采纳/驳回+理由，零新增采集摩擦）→ 改进器 AI 对比
// 「员工怎么做的 vs 老板怎么反应的」→ 提炼最小聚焦的「实战心得」提案（1-3 条）
// → 人工审批采纳 → 下次派活自动注入。心得是文件化知识（写原则+为什么），
// 不是死规则；提案永远人审后才生效，防错误反馈污染员工行为。
import { curTenant, q } from '../db.js';

export const EVOLUTION_SIGNAL_DAYS = 30;
export const EVOLUTION_SIGNAL_LIMIT = 40;
export const EVOLUTION_NOTE_INJECT_LIMIT = 8;
export const EVOLUTION_MIN_SIGNALS = 3;

// 采集进化信号：该员工近 N 天已定案任务 + 对应验收记录（approvals.reason 是核心养料）
export function collectEvolutionSignals(specialistId, {
  days = EVOLUTION_SIGNAL_DAYS,
  limit = EVOLUTION_SIGNAL_LIMIT,
} = {}) {
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
    Number(specialistId),
    `-${Math.max(1, Math.trunc(Number(days) || EVOLUTION_SIGNAL_DAYS))} days`,
    Math.max(1, Math.trunc(Number(limit) || EVOLUTION_SIGNAL_LIMIT)),
  );
  const signals = rows.map(row => ({
    taskId: row.id,
    title: String(row.title || '').slice(0, 80),
    type: String(row.type || '').slice(0, 20),
    requirement: String(row.requirement || '').slice(0, 200),
    outcome: row.status,
    reason: String(row.approval_reason || '').slice(0, 300) || null,
    decidedAt: row.decided_at || row.created_at,
  }));
  const rejected = signals.filter(item => item.outcome === '已驳回');
  return {
    signals,
    stats: {
      total: signals.length,
      adopted: signals.filter(item => item.outcome === '已完成').length,
      rejected: rejected.length,
      rejectReasons: rejected.filter(item => item.reason).map(item => item.reason).slice(0, 12),
      windowDays: days,
    },
  };
}

// 已生效心得（派活注入用，渐进披露：只注入最新 N 条）
export function activeEvolutionNotes(specialistId, {
  limit = EVOLUTION_NOTE_INJECT_LIMIT,
  tenantId = null,
} = {}) {
  return q.all(
    `SELECT id, note, rationale, evidence, created_at FROM employee_evolution_notes
     WHERE tenant_id = ? AND specialist_id = ? AND status = 'active'
     ORDER BY id DESC LIMIT ?`,
    tenantId ?? curTenant(),
    Number(specialistId),
    Math.max(1, Math.trunc(Number(limit) || EVOLUTION_NOTE_INJECT_LIMIT)),
  );
}

// 派活 prompt 的心得注入块（两种派活模式共用同一措辞）
export function evolutionNotesPromptLines(notes = []) {
  if (!notes.length) return [];
  return [
    '【实战心得·从老板验收反馈进化而来（必须遵守，违背这些心得的产出曾被驳回）】',
    ...notes.map(item =>
      `- ${item.note}${item.rationale ? `（为什么：${item.rationale}）` : ''}`),
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
