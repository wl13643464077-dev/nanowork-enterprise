import { hasStoredAiDelivery } from '../engines/stored-ai-delivery.js';
import { Router } from 'express';
import { curTenant, q } from '../db.js';
import { logOp, monthStart, notify, requireRole } from '../util.js';
import {
  EVOLUTION_MIN_SIGNALS,
  activeEvolutionNotes,
  buildEvolutionPrompt,
  collectEvolutionSignals,
  parseEvolutionProposal,
} from '../engines/employee-evolution.js';
import { userScopeClause } from '../engines/access.js';
import { restaurantBusinessProfile, restaurantAvatar } from '../catalog/business-profiles.js';
import { employeeTextModelFailoverPlan, generate } from '../engines/ai.js';
import { provider360Active, textModelFor, yunwuAvailable } from '../engines/yunwu.js';
import {
  aiFailurePayload,
  assertRealAiOutput,
  releaseFailedAiHold,
} from '../engines/ai-delivery-status.js';
import { refundHold,
  estimateCallCredits,
  holdCredits,
  precheck,
  precheckByRole,
  releaseHold,
  settleHold,
} from '../engines/credits.js';
import { executeHeldDelivery } from '../engines/two-phase-delivery.js';
import { aggregateSupplierCosts } from '../engines/provider-cost-receipts.js';
import { canonicalRestaurantEmployeeProfileFor } from '../engines/canonical-employee-profile.js';

const r = Router();
const ALLOWED_STATUS = new Set(['空闲', '执行中']);
const INTERNAL_PROFILE_ROLES = new Set(['boss', 'admin', 'platform_super']);
const CURRENT_DEPARTMENT_CODES = Object.freeze(Array.from(
  { length: 8 }, (_, index) => `M-${String(index + 1).padStart(2, '0')}`,
));
const CURRENT_DEPARTMENT_SQL = CURRENT_DEPARTMENT_CODES.map(() => '?').join(',');

// 目录卡片用的能力/技能摘要：取自统一员工对象（构建期常量，O(1) 查表）。
// 能力名清洗 Markdown 记号后给前端直接展示；技能数为出厂技能目录数。
const plainCapabilityName = value => String(value ?? '').replace(/\*\*|__|[*`#]/gu, '').trim();
const CAPABILITY_SUMMARY_BY_IDX = new Map(Array.from({ length: 61 }, (_, index) => {
  const idx = 101 + index;
  try {
    const profile = canonicalRestaurantEmployeeProfileFor(idx);
    const names = (profile.capabilities || [])
      .map(capability => plainCapabilityName(capability.name))
      .filter(Boolean);
    return [idx, {
      capabilityCount: names.length,
      capabilityNames: names.slice(0, 4),
      skillCount: profile.skills?.catalog?.length ?? 0,
    }];
  } catch {
    return [idx, { capabilityCount: 0, capabilityNames: [], skillCount: 0 }];
  }
}));

function parseProfile(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toEmployee(row, canViewInternalProfile = false, viewerRole = null) {
  const profile = parseProfile(row.profile_json);
  const num = row.employee_idx - 100;
  const capabilitySummary = CAPABILITY_SUMMARY_BY_IDX.get(row.employee_idx) || {
    capabilityCount: 0,
    capabilityNames: [],
    skillCount: 0,
  };
  return {
    idx: row.employee_idx,
    avatar: restaurantAvatar(num),
    business: restaurantBusinessProfile(num, viewerRole),
    // 能力/技能数量对全员展示；能力名与内部档案同级，仅管理角色可见。
    capabilityCount: capabilitySummary.capabilityCount,
    skillCount: capabilitySummary.skillCount,
    capabilityNames: canViewInternalProfile ? capabilitySummary.capabilityNames : [],
    key: row.key,
    person: row.person,
    name: row.name,
    duty: row.duty,
    desc: row.description,
    group: row.group_name,
    emoji: row.emoji,
    color: profile.color || '',
    ...(canViewInternalProfile ? {
      inputs: Array.isArray(profile.inputs) ? profile.inputs : [],
      steps: Array.isArray(profile.steps) ? profile.steps : [],
      deliverables: Array.isArray(profile.deliverables) ? profile.deliverables : [],
    } : {}),
    intro: typeof profile.intro === 'string' ? profile.intro : '',
    status: row.runtime_status,
    currentTask: typeof row.current_task === 'string' ? row.current_task : '',
    monthTasks: Number(row.month_tasks) || 0,
    monthDone: Number(row.month_done) || 0,
    marshalId: row.marshal_id,
    specialistId: row.id,
    groupEmoji: row.group_emoji || '',
    extension: profile.extension === true,
    // 自我介绍周校验状态（ok/needs_review/never）：员工卡角标用，只追加不改既有字段。
    introCheckStatus: row.intro_check_status || 'never',
  };
}

function visibleEmployees(req) {
  const canViewInternalProfile = INTERNAL_PROFILE_ROLES.has(req.user?.role);
  const taskScope = userScopeClause(req.user, 't.created_by');
  return q.all(`SELECT s.*,
    CASE WHEN EXISTS(
      SELECT 1 FROM agent_tasks t
      WHERE t.tenant_id=? AND t.specialist_id=s.id
        AND t.status IN ('生成中','执行中')${taskScope.sql}
    ) THEN '执行中' ELSE '空闲' END runtime_status,
    (SELECT t.title FROM agent_tasks t WHERE t.tenant_id=? AND t.specialist_id=s.id AND t.status IN ('生成中','执行中')${taskScope.sql} ORDER BY t.id DESC LIMIT 1) current_task,
    (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id=? AND t.specialist_id=s.id AND t.created_at>=?${taskScope.sql}) month_tasks,
    (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id=? AND t.specialist_id=s.id AND t.created_at>=? AND t.status='已完成'${taskScope.sql}) month_done,
    (SELECT o.self_intro_check_status FROM tenant_specialist_overrides o WHERE o.tenant_id=? AND o.specialist_id=s.id) intro_check_status,
    m.sort group_sort,m.emoji group_emoji
    FROM specialists s
    JOIN marshals m ON m.id=s.marshal_id
    WHERE m.code IN (${CURRENT_DEPARTMENT_SQL})
      AND s.employee_idx BETWEEN 101 AND 161
    ORDER BY m.sort,s.sort,s.employee_idx`,
  curTenant(), ...taskScope.params,
  curTenant(), ...taskScope.params,
  curTenant(), monthStart(), ...taskScope.params,
  curTenant(), monthStart(), ...taskScope.params,
  curTenant(),
  ...CURRENT_DEPARTMENT_CODES)
    .map(row => toEmployee(row, canViewInternalProfile, req.user?.role || null));
}

function textFilter(employees, query) {
  if (!query) return employees;
  const needle = query.toLocaleLowerCase('zh-CN');
  return employees.filter(employee => [
    employee.idx, employee.key, employee.person, employee.name, employee.duty,
    employee.desc, employee.group, employee.intro,
  ].some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(needle)));
}

function filters(req, res) {
  const group = typeof req.query.group === 'string' ? req.query.group.trim() : '';
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  if (group.length > 80) {
    res.status(400).json({ error: '分部筛选条件不能超过80字' });
    return null;
  }
  if (query.length > 100) {
    res.status(400).json({ error: '搜索内容不能超过100字' });
    return null;
  }
  if (status && !ALLOWED_STATUS.has(status)) {
    res.status(400).json({ error: '状态筛选仅支持“空闲”或“执行中”' });
    return null;
  }
  return { group, query, status };
}

r.get('/', (req, res) => {
  const selected = filters(req, res);
  if (!selected) return;
  const all = visibleEmployees(req);
  const searched = textFilter(all, selected.query).filter(employee => !selected.status || employee.status === selected.status);
  const employees = searched.filter(employee => !selected.group || employee.group === selected.group);
  const groupMeta = new Map(all.map(employee => [employee.group, { emoji: employee.groupEmoji, color: employee.color }]));
  const groups = [...groupMeta.entries()].map(([name, meta]) => ({
    name,
    emoji: meta.emoji,
    color: meta.color,
    count: searched.filter(employee => employee.group === name).length,
  }));
  res.set('Cache-Control', 'private, no-store');
  res.json({
    total: employees.length,
    coreCount: employees.filter(employee => !employee.extension).length,
    extensionCount: employees.filter(employee => employee.extension).length,
    groups,
    employees: employees.map(({ groupEmoji: _groupEmoji, ...employee }) => employee),
  });
});

r.get('/:idx', (req, res) => {
  const identifier = String(req.params.idx || '').trim();
  if (!identifier || identifier.length > 100) return res.status(404).json({ error: '数字员工不存在' });
  const employee = visibleEmployees(req).find(item => String(item.idx) === identifier || item.key === identifier);
  if (!employee) return res.status(404).json({ error: '数字员工不存在' });
  const { groupEmoji: _groupEmoji, ...payload } = employee;
  res.set('Cache-Control', 'private, no-store');
  res.json(payload);
});

// ===== 老板一句话 → AI 匹配协同小队（AgentTeams 可视化数据源） =====
// 参考派活AI /experts/match：真实模型读花名册组队，返回队长/成员/各自任务
// 与依赖关系；本接口只做“选人导航”，不派活、不产生任务、不对外发布。
// fail-closed：模型不可用或输出不合法直接失败并全额退款，不用规则结果冒充 AI。
const TEAM_MATCH_MAX_TEXT = 300;
// 协同小队人数上限：选人、队长拆解、队长汇总三个接口与前端一键派活必须
// 用同一个数字。历史上选人提示词写 1-5、拆解/汇总 slice(0,5)，但模型按业务
// 需要选出 8 人时 normalizeMatchedTeam 并不截断，结果老板看到 8 人上阵、
// 队长只给 5 人派活，其余 3 人干站着。现在：选人阶段就按上限截断（保留队长），
// 后续每一步都以同一上限放行，谁被选进小队谁就一定有活干。
export const TEAM_MAX_MEMBERS = 8;
const TEAM_MATCH_MAX_PROVIDER_ATTEMPTS = 2;
const TEAM_MATCH_RETRY_DELAY_MS = 2500;
const TEAM_MATCH_RETRYABLE_FAILURES = new Set([
  'provider_rate_limited',
  'provider_empty_output',
]);

function teamMatchHasProviderSpendEvidence(output) {
  const inputTokens = Number(output?.usage?.inputTokens || 0);
  const outputTokens = Number(output?.usage?.outputTokens || 0);
  if (inputTokens > 0 || outputTokens > 0) return true;
  return (Array.isArray(output?.usage?.supplierCosts) ? output.usage.supplierCosts : [])
    .some(receipt => receipt?.status === 'known' && Number(receipt?.costYuanOverride) > 0);
}

export function shouldRetryTeamMatchOutput(
  output,
  attempt,
  maxAttempts = TEAM_MATCH_MAX_PROVIDER_ATTEMPTS,
) {
  if (output?.mode === 'api' || Number(attempt) >= Number(maxAttempts)) return false;
  if (output?.providerFailure?.retryable === false) return false;
  if (String(output?.text || '').trim() || teamMatchHasProviderSpendEvidence(output)) return false;
  return TEAM_MATCH_RETRYABLE_FAILURES.has(String(output?.providerFailure?.code || ''));
}

// 轻量文本通道对复杂 json_schema response_format 支持不稳（可能返回空正文），
// 改为提示词约定 JSON 结构 + 服务端剥围栏解析；normalizeMatchedTeam 仍做
// idx 白名单、队长唯一、依赖合法性把关，安全性不依赖模型自觉。
function parseTeamMatchJson(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;
  const unfenced = text.replace(/^```(?:json)?\s*/iu, '').replace(/```\s*$/u, '').trim();
  for (const candidate of [unfenced, text]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* try next candidate */
    }
  }
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(unfenced.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* fall through */
    }
  }
  return null;
}

function teamMatchRoster(employees) {
  return employees
    .map(item => `${item.idx}｜${item.person}｜${item.name}｜${item.group}｜${String(item.duty || item.desc || '').slice(0, 60)}`)
    .join('\n');
}

function normalizeMatchedTeam(parsed, employees) {
  const byIdx = new Map(employees.map(item => [Number(item.idx), item]));
  const rawMembers = Array.isArray(parsed?.members) ? parsed.members : [];
  const seen = new Set();
  const members = [];
  for (const raw of rawMembers) {
    const idx = Number(raw?.idx);
    const source = byIdx.get(idx);
    if (!source || seen.has(idx)) continue;
    seen.add(idx);
    members.push({
      idx,
      person: source.person,
      name: source.name,
      duty: source.duty || source.desc || '',
      group: source.group,
      color: source.color || '',
      avatar: source.avatar || null,
      status: source.status || '',
      typicalCredits: source.business?.cost?.typicalCredits ?? null,
      roleInTeam: raw.roleInTeam === '队长' ? '队长' : '成员',
      task: String(raw.task || '').slice(0, 200),
      why: String(raw.why || '').slice(0, 200),
      dependsOn: [...new Set((Array.isArray(raw.dependsOn) ? raw.dependsOn : [])
        .map(Number)
        .filter(value => Number.isSafeInteger(value) && value !== idx))],
    });
  }
  // 超出人数上限时截断：优先保住模型指定的队长，其余按模型给出的顺序保留。
  if (members.length > TEAM_MAX_MEMBERS) {
    const leadIndex = members.findIndex(item => item.roleInTeam === '队长');
    const lead = leadIndex >= 0 ? members.splice(leadIndex, 1)[0] : null;
    members.splice(lead ? TEAM_MAX_MEMBERS - 1 : TEAM_MAX_MEMBERS);
    if (lead) members.unshift(lead);
  }
  // 依赖只允许指向队内成员；恰好一名队长（模型多选/漏选时取第一名修正）。
  const memberIdxSet = new Set(members.map(item => item.idx));
  for (const member of members) {
    member.dependsOn = member.dependsOn.filter(value => memberIdxSet.has(value));
  }
  const leads = members.filter(item => item.roleInTeam === '队长');
  if (members.length && leads.length !== 1) {
    members.forEach((member, index) => {
      member.roleInTeam = index === 0 ? '队长' : '成员';
    });
  }
  return {
    teamName: String(parsed?.teamName || '经营协同小队').slice(0, 40),
    summary: String(parsed?.summary || '').slice(0, 300),
    members,
  };
}

// 一句话找人的核心（供 /match-team 路由与开店向导 routes/onboarding.js 共用）：
// 校验 → 占扣 → 真实模型读花名册组队 → 结算。成功返回 { team, billing }；
// 任何失败抛带 status 的 Error（预授权已释放），由调用方决定如何呈现。
export async function matchTeamByText(req, rawText) {
  const text = String(rawText || '').trim();
  if (!text) throw Object.assign(new Error('先用一句话说说要办什么事'), { status: 400 });
  if (text.length > TEAM_MATCH_MAX_TEXT) {
    throw Object.assign(new Error(`一句话最长${TEAM_MATCH_MAX_TEXT}字，请精简后再试`), { status: 400 });
  }
  if (!yunwuAvailable()) {
    throw Object.assign(
      new Error('真实 AI 通道未配置，无法读花名册挑人；不会用规则结果冒充 AI 匹配。'),
      { status: 503 },
    );
  }
  const employees = visibleEmployees(req);
  if (!employees.length) throw Object.assign(new Error('数字员工目录为空，无法匹配'), { status: 503 });
  const roster = teamMatchRoster(employees);
  // 选人是导航型轻任务：固定走轻量文本通道（响应快、限流余量大），
  // 不占用老板级模型的吞吐；派活后的正式任务仍按岗位模型路由执行。
  const model = textModelFor('sales');
  let hold = null;
  try {
    precheckByRole(req.user.id, 'text', req.user.role);
    hold = holdCredits({
      userId: req.user.id,
      feature: '一句话找人·协同小队匹配',
      kind: 'text',
      model,
      credits: estimateCallCredits({ model, outputTokens: 8000, texts: [text, roster] }),
      refType: null,
      refId: null,
    });
    // executeHeldDelivery 接管占扣的结算/释放；先置空外层引用避免 catch 里双重释放。
    const deliveryHold = hold;
    hold = null;
    const delivered = await executeHeldDelivery({
      hold: deliveryHold,
      refund: refundHold,
      hasDeliverable: () => hasStoredAiDelivery(deliveryHold),
      generate: async () => {
        // 上游瞬时限流时退避重试一次；两次都失败才按未交付退款。
        let output = null;
        let attempts = 0;
        for (let attempt = 1; attempt <= TEAM_MATCH_MAX_PROVIDER_ATTEMPTS; attempt += 1) {
          attempts = attempt;
          output = await generate({
          kind: 'employee-team-match',
          system: [
            '你是纳米Work行业版的派单调度台，负责把老板的一句话需求分派给最合适的餐饮数字员工协同小队。',
            '老板原话可能来自语音转写，存在同音错字或语气词；先按餐饮经营语境理解真实意图再选人。',
            '只能从下方花名册中选人（用花名册第一列的岗位编号 idx），不得虚构岗位或编号。',
            '规则：',
            `- 选 1-${TEAM_MAX_MEMBERS} 名员工组成协同小队（按这单活真正需要的岗位选，不凑数、不漏关键岗位），其中恰好 1 名「队长」负责统筹，其余为「成员」。`,
            '- 选进小队的每一个人都会被队长真实派活并各自产出，不要把只是"可能相关"的岗位拉进来。',
            '- 每名成员写清 task（TA 在这单活里的具体分工，20-60字）和 why（为什么选TA，尽量引用岗位职责）。',
            '- dependsOn 填该成员开工前依赖哪些成员的产出（岗位编号数组），没有依赖就留空数组。',
            '- teamName 用一句有业务感的小队名（≤16字）；summary 用一句话说清整单活的接力路线（≤80字）。',
            '- 需求与餐饮经营无关或过于模糊时，也要给出最接近的 1 名员工并在 summary 里说明假设。',
            '只输出一个 JSON 对象，不要输出任何解释或 Markdown 围栏，结构如下：',
            '{"teamName":"小队名","summary":"接力路线","members":[{"idx":101,"roleInTeam":"队长","task":"具体分工","why":"选TA的理由","dependsOn":[]}]}',
            '【花名册（idx｜姓名｜岗位｜分部｜职责）】',
            roster,
          ].join('\n'),
          userMsg: `老板原话：${text}`,
          fallback: () => '',
          // 轻量通道是思考型模型：61 人组合决策的思考量大，预算需覆盖
          // 思考+正文；给小了正文会被截空（provider_empty_output）。
          maxTokens: 8000,
          role: req.user.role,
          model,
          // 选人只需要一份短 JSON；关闭 360 DeepSeek 的思考输出，避免
          // 思考占满 max_tokens 后正文为空，让老板白等。
          thinking: false,
          providerPolicy: 'yunwu_only',
          signal: req.requestSignal,
          });
          // 有真实 token/成本回执时不重复付费请求；用户失败仍全额退款，
          // 已产生的供应商成本由平台承担。
          if (!shouldRetryTeamMatchOutput(output, attempt)) break;
          await new Promise(resolve => setTimeout(resolve, TEAM_MATCH_RETRY_DELAY_MS));
        }
        try {
          assertRealAiOutput(output, {
            label: '一句话找人',
            noDelivery: '本次不产生匹配结果，也不扣费',
          });
        } catch (error) {
          throw attachTeamMatchProviderFailure(error, output, attempts);
        }
        const parsed = parseTeamMatchJson(output.text);
        const team = normalizeMatchedTeam(parsed, employees);
        if (!team.members.length) {
          throw Object.assign(new Error('AI 未匹配到花名册内的员工，请换个说法再试'), { status: 422 });
        }
        return { team, output };
      },
      persist: generated => generated.team,
      settle: settleHold,
      release: releaseHold,
      settlement: generated => ({
        usage: generated.output.usage,
        model: generated.output.model,
        aiMode: generated.output.mode,
        note: '一句话找人：AI 读花名册完成协同小队匹配',
      }),
      requirePositiveApiUsage: true,
      releaseNote: '一句话找人未形成匹配结果，预授权全额退回',
    });
    try {
      logOp(req.user, '数字员工', '一句话找人', `team:${delivered.delivery.teamName}·${delivered.delivery.members.length}人`);
    } catch { /* 日志失败不影响业务返回 */ }
    return { team: delivered.delivery, billing: delivered.billing };
  } catch (error) {
    if (hold) {
      try {
        releaseHold(hold, '一句话找人未进入模型生成，预授权全额退回');
      } catch { /* 保留原始错误 */ }
      hold = null;
    }
    throw error;
  }
}

r.post('/match-team', async (req, res) => {
  try {
    const matched = await matchTeamByText(req, req.body?.text);
    res.set('Cache-Control', 'private, no-store');
    return res.json({
      ...matched,
      boundary: '本次只完成选人建议，未创建任务、未派活、未产生对外动作；派活在各员工工作台确认后才执行。',
    });
  } catch (error) {
    return res.status(error.status || 502).json(aiFailurePayload(error, {
      requestId: teamPlanRequestId(req),
      extra: {
        ...(error.providerFailure ? { providerFailure: error.providerFailure } : {}),
        ...(Number.isSafeInteger(Number(error.providerAttempts))
          ? { providerAttempts: Number(error.providerAttempts) }
          : {}),
      },
    }));
  }
});

// ===== 语音意图整理 =====
// 浏览器语音识别的中文常有同音错字/丢字/语气词。这里用轻量真实模型按
// 餐饮经营语境还原老板的真实意图，返回一句通顺准确的需求文本。
// 失败不阻塞（前端保留原文），成功才结算，真实计费。
r.post('/voice-intent', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: '没有收到语音转写内容' });
  if (text.length > 500) return res.status(400).json({ error: '语音转写内容过长，请分段说' });
  if (!yunwuAvailable()) {
    return res.status(503).json({ error: '真实 AI 通道未配置，无法整理语音意图' });
  }
  const model = textModelFor('sales');
  let hold = null;
  try {
    precheckByRole(req.user.id, 'text', req.user.role);
    hold = holdCredits({
      userId: req.user.id,
      feature: '语音派活·意图整理',
      kind: 'text',
      model,
      credits: estimateCallCredits({ model, outputTokens: 4000, texts: [text] }),
      refType: null,
      refId: null,
    });
    const deliveryHold = hold;
    hold = null;
    const delivered = await executeHeldDelivery({
      hold: deliveryHold,
      refund: refundHold,
      hasDeliverable: () => hasStoredAiDelivery(deliveryHold),
      generate: async () => {
        let output = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          output = await generate({
            kind: 'employee-voice-intent',
            system: [
              '你是餐饮企业老板的语音转写纠错员。老板刚用语音说了一句经营需求，浏览器转写可能有同音错字、丢字、断句错误和语气词。',
              '任务：按餐饮门店经营语境还原老板的真实意图，输出一句通顺、准确的需求。',
              '规则：',
              '- 保留老板的原意、关键数字、平台名和菜品名；同音错字按语境改正（如"外卖平分"→"外卖评分"、"毛利绿"→"毛利率"）。',
              '- 删掉"嗯、啊、那个、对吧"等语气词；把断碎的口语整理成一句完整的话。',
              '- 不添加老板没说的需求，不给建议，不解释。',
              '- 只输出整理后的那句话，不要任何前后缀。',
            ].join('\n'),
            userMsg: `语音转写原文：${text}`,
            fallback: () => '',
            maxTokens: 4000,
            role: req.user.role,
            model,
            providerPolicy: 'yunwu_only',
            signal: req.requestSignal,
          });
          const retryable =
            output?.mode !== 'api' &&
            ['provider_rate_limited', 'provider_empty_output'].includes(
              output?.providerFailure?.code,
            );
          if (!retryable || attempt === 2) break;
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        assertRealAiOutput(output, {
          label: '语音意图整理',
          noDelivery: '本次不修改你的输入，也不扣费',
        });
        const refined = String(output.text || '')
          .replace(/^```[a-z]*\s*/iu, '')
          .replace(/```\s*$/u, '')
          .replace(/^["'「『]+|["'」』]+$/gu, '')
          .trim();
        if (!refined || refined.length > 400) {
          throw Object.assign(new Error('整理结果无效，保留原文'), { status: 422 });
        }
        return { refined, output };
      },
      persist: generated => generated.refined,
      settle: settleHold,
      release: releaseHold,
      settlement: generated => ({
        usage: generated.output.usage,
        model: generated.output.model,
        aiMode: generated.output.mode,
        note: '语音派活：按语境整理老板意图',
      }),
      requirePositiveApiUsage: true,
      releaseNote: '语音意图整理未交付，预授权全额退回',
    });
    res.set('Cache-Control', 'private, no-store');
    return res.json({ text: delivered.delivery, billing: delivered.billing });
  } catch (error) {
    if (hold) {
      try {
        releaseHold(hold, '语音意图整理未进入模型生成，预授权全额退回');
      } catch { /* 保留原始错误 */ }
      hold = null;
    }
    return res.status(error.status || 502).json({
      error: String(error?.message || '语音意图整理失败').slice(0, 200),
      ...(error.billing ? { billing: error.billing } : {}),
    });
  }
});

// ===== 队长拆解派活（AgentTeams 第二步）=====
// 输入协同小队与深度档位，由 AI 队长把老板原话拆解成每名成员的任务指令
// 与输出要求；执行（创建任务）由前端按自动/半自动模式逐个走现有派活链路，
// 权限、计费、风控与工作台单派完全一致。本接口只做拆解，真实计费、fail-closed。
const TEAM_PLAN_DEPTHS = Object.freeze({
  simple: {
    label: '简单',
    outputRule: [
      '产出必须是老板一眼能懂的大白话：第一行给一句话结论，然后最多 5 条要点或行动清单，全文不超过 400 字。',
      '禁止专业术语、模型名词和长篇分析；老板只要判断和下一步动作。',
    ].join(''),
  },
  full: {
    label: '全面',
    outputRule: [
      '产出先用 3 句以内大白话讲清结论与建议（老板摘要），再给完整方案正文。',
      '专业词首次出现时用括号做一句话解释；行动项要有负责人和时间。',
    ].join(''),
  },
  pro: {
    label: '专业',
    outputRule: [
      '深度挖掘：必须逐项运用该岗位的全部能力（见成员能力清单），每项能力的运用在产出中要有对应小节与结论。',
      '开头仍要有老板摘要（3 句以内大白话），之后按能力逐层展开完整专业分析、数据依据与风险边界。',
    ].join(''),
  },
});

function teamPlanSchemaHint(members) {
  const indexes = members.map(member => Number(member.idx));
  return [
    `briefs 必须恰好返回 ${indexes.length} 条，idx 按此顺序逐一为：${indexes.join('、')}。`,
    '按下方 JSON 骨架填满每个空字符串；不得删除、合并、重复或改写任何 idx。',
    '只输出一个 JSON 对象，不要输出任何解释或 Markdown 围栏：',
    JSON.stringify({
      briefs: indexes.map(idx => ({
        idx,
        title: '',
        directive: '',
        deliverables: '',
      })),
    }),
  ].join('\n');
}

const CHINESE_MONTH_DAY = /(\d{1,2})月\s*(\d{1,2})(日|号)/gu;
const REQUEST_YEAR_ANCHOR = /年|(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/u;

// 老板只给了月日时，模型偶尔会擅自补一个年份。这里只删除同一月日
// 前由模型新增的 19xx/20xx 年；明确年份、相对年份和其他日期原样保留。
export function normalizeTeamPlanDateText(value, requestText) {
  const source = String(requestText || '');
  // 年份锚点可能与后面的月日被逗号或其他语句隔开。无法可靠判断归属时
  // 保守保留模型结果，避免删掉老板明确给出的年份。
  if (REQUEST_YEAR_ANCHOR.test(source)) return String(value || '');
  const yearless = new Set();
  for (const match of source.matchAll(CHINESE_MONTH_DAY)) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    if (!Number.isInteger(month) || month < 1 || month > 12
      || !Number.isInteger(day) || day < 1 || day > 31) continue;
    yearless.add(`${month}-${day}`);
  }
  let normalized = String(value || '');
  for (const key of yearless) {
    const [month, day] = key.split('-').map(Number);
    normalized = normalized.replace(
      new RegExp(`(?:19|20)\\d{2}年(\\s*0?${month}月\\s*0?${day}[日号])`, 'gu'),
      '$1',
    );
  }
  return normalized;
}

const TEAM_PLAN_MAX_PROVIDER_ATTEMPTS = 2;
const TEAM_PLAN_RETRY_DELAY_MS = 2500;
// 队长拆解比普通聊天长，不能继承生产环境为即时问答收紧的 20s 窗口。
// 两轮 60s + 2.5s 退避仍完整落在前端 150s 请求预算内。
export const TEAM_PLAN_PROVIDER_TIMEOUT_MS = 60_000;
const TEAM_PLAN_MODEL_FAILOVER_REASON = 'retryable_zero_usage_transport_failure';
const TEAM_PLAN_TRANSIENT_PROVIDER_FAILURES = new Set([
  'provider_upstream_error',
  'provider_timeout',
  'provider_rate_limited',
  'provider_empty_output',
]);

function teamPlanHasProviderSpendEvidence(output) {
  const inputTokens = Number(output?.usage?.inputTokens || 0);
  const outputTokens = Number(output?.usage?.outputTokens || 0);
  if (inputTokens > 0 || outputTokens > 0) return true;
  // pending 也代表上游调用已经留下费用身份但金额尚待核验。队长拆解
  // 此时不能再次请求，避免重复成本以及混合回执无法可靠汇总。
  return (Array.isArray(output?.usage?.supplierCosts) ? output.usage.supplierCosts : [])
    .some(receipt => receipt && typeof receipt === 'object');
}

export function shouldRetryTeamPlanOutput(
  output,
  attempt,
  maxAttempts = TEAM_PLAN_MAX_PROVIDER_ATTEMPTS,
) {
  if (output?.mode === 'api' || Number(attempt) >= Number(maxAttempts)) return false;
  if (output?.providerFailure?.retryable === false) return false;
  if (String(output?.text || '').trim() || teamPlanHasProviderSpendEvidence(output)) return false;
  return TEAM_PLAN_TRANSIENT_PROVIDER_FAILURES.has(
    String(output?.providerFailure?.code || ''),
  );
}

export function shouldFailoverTeamPlanModel(output) {
  if (!shouldRetryTeamPlanOutput(output, 1)) return false;
  const failure = output.providerFailure;
  const status = Number(failure.status);
  if (failure.code === 'provider_timeout') {
    return status === 504 && failure.timedOut === true;
  }
  if (failure.code === 'provider_upstream_error') {
    return (status === 500 || status === 502) && failure.timedOut !== true;
  }
  return false;
}

function waitForTeamPlanRetry(signal) {
  if (signal?.aborted) {
    return Promise.reject(Object.assign(new Error('队长拆解请求已取消'), {
      status: 499,
      code: 'AI_REQUEST_CANCELLED',
      retryable: true,
    }));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, TEAM_PLAN_RETRY_DELAY_MS);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('队长拆解请求已取消'), {
        status: 499,
        code: 'AI_REQUEST_CANCELLED',
        retryable: true,
      }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function publicTeamPlanProviderFailure(value) {
  if (!value || typeof value !== 'object') return null;
  const code = String(value.code || '').trim();
  if (!code) return null;
  const status = Number(value.status);
  return {
    code: code.slice(0, 80),
    status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : null,
    timedOut: value.timedOut === true,
    retryable: value.retryable === true,
    summary: String(value.summary || '上游服务未返回可交付结果').slice(0, 120),
  };
}

function attachTeamMatchProviderFailure(error, output, attempts) {
  const target = error instanceof Error ? error : new Error(String(error || '一句话找人失败'));
  const providerFailure = publicTeamPlanProviderFailure(output?.providerFailure);
  if (!providerFailure) return target;
  target.code = providerFailure.code;
  target.retryable = providerFailure.retryable;
  target.retryHint = teamMatchHasProviderSpendEvidence(output)
    ? `上游${providerFailure.summary}，本次已返回用量证据，系统未重复提交；请稍后在原需求重试。`
    : attempts > 1
      ? `上游${providerFailure.summary}，系统已自动尝试 ${attempts} 次但仍未取得产出，请稍后在原需求重试。`
      : `上游${providerFailure.summary}，请核对通道配置后在原需求重试。`;
  target.providerFailure = providerFailure;
  target.providerAttempts = Number(attempts) || 1;
  return target;
}

function attachTeamPlanProviderFailure(error, output, attempts) {
  const target = error instanceof Error ? error : new Error(String(error || '队长拆解失败'));
  const providerFailure = publicTeamPlanProviderFailure(output?.providerFailure);
  if (!providerFailure) return target;
  target.code = providerFailure.code;
  target.retryable = providerFailure.retryable;
  target.retryHint = teamPlanHasProviderSpendEvidence(output)
    ? `上游${providerFailure.summary}，本次已返回用量证据，系统未重复提交；请稍后在原任务重试。`
    : attempts > 1
      ? `上游${providerFailure.summary}，系统已自动尝试 ${attempts} 次但仍未取得产出，请稍后在原任务重试。`
      : `上游${providerFailure.summary}，请稍后在原任务重试。`;
  target.providerFailure = providerFailure;
  target.providerAttempts = attempts;
  return target;
}

function teamPlanRequestId(req) {
  const value = String(req.requestId || req.get?.('X-Request-Id') || '').trim();
  return /^[A-Za-z0-9._-]{1,100}$/.test(value) ? value : null;
}

function observeTeamPlanUsage(target, output) {
  const inputTokens = Number(output?.usage?.inputTokens);
  const outputTokens = Number(output?.usage?.outputTokens);
  if (Number.isSafeInteger(inputTokens) && inputTokens > 0) target.inputTokens += inputTokens;
  if (Number.isSafeInteger(outputTokens) && outputTokens > 0) target.outputTokens += outputTokens;
  if (Array.isArray(output?.usage?.supplierCosts)) {
    target.supplierCosts.push(...output.usage.supplierCosts.filter(value => (
      value && typeof value === 'object'
    )).slice(0, TEAM_PLAN_MAX_PROVIDER_ATTEMPTS));
  }
  return target;
}

function attachTeamPlanUsageEvidence(error, observed) {
  const target = error instanceof Error ? error : new Error(String(error || '队长拆解失败'));
  target.providerUsage = {
    inputTokens: observed.inputTokens,
    outputTokens: observed.outputTokens,
    ...(observed.supplierCosts.length ? { supplierCosts: [...observed.supplierCosts] } : {}),
  };
  return target;
}

function teamPlanStructureDiagnostic({ rawBriefs, members, acceptedIdx, output, req }) {
  const returnedIdx = rawBriefs
    .map(brief => Number(brief?.idx))
    .filter(Number.isSafeInteger)
    .slice(0, 10);
  const expectedSet = new Set(members.map(member => member.idx));
  const duplicateIdx = returnedIdx.filter((idx, index) => returnedIdx.indexOf(idx) !== index);
  return {
    rawBriefCount: rawBriefs.length,
    returnedIdx: [...new Set(returnedIdx)],
    missingIdx: members.map(member => member.idx).filter(idx => !acceptedIdx.has(idx)),
    emptyTitleIdx: rawBriefs
      .filter(brief => expectedSet.has(Number(brief?.idx)) && !String(brief?.title || '').trim())
      .map(brief => Number(brief.idx)).slice(0, 10),
    emptyDirectiveIdx: rawBriefs
      .filter(brief => expectedSet.has(Number(brief?.idx)) && !String(brief?.directive || '').trim())
      .map(brief => Number(brief.idx)).slice(0, 10),
    duplicateIdx: [...new Set(duplicateIdx)].slice(0, 10),
    unexpectedIdx: [...new Set(returnedIdx.filter(idx => !expectedSet.has(idx)))].slice(0, 10),
    requestId: teamPlanRequestId(req),
    model: String(output?.effectiveModel || output?.model || '').slice(0, 120) || null,
  };
}

function teamPlanFailureNote(error, phase, observed) {
  const cost = aggregateSupplierCosts(observed.supplierCosts);
  const costStatus = cost?.status || (observed.supplierCosts.length ? 'pending' : 'unknown');
  const structure = error?.teamPlanStructure;
  const structureText = structure
    ? [
        `raw=${structure.rawBriefCount}`,
        `returned=${structure.returnedIdx.join(',') || '-'}`,
        `missing=${structure.missingIdx.join(',') || '-'}`,
        `emptyTitle=${structure.emptyTitleIdx.join(',') || '-'}`,
        `emptyDirective=${structure.emptyDirectiveIdx.join(',') || '-'}`,
        `duplicate=${structure.duplicateIdx.join(',') || '-'}`,
        `unexpected=${structure.unexpectedIdx.join(',') || '-'}`,
        `rid=${structure.requestId || '-'}`,
        `model=${structure.model || '-'}`,
      ].join('|')
    : 'none';
  return [
    '队长拆解未形成完整结果，预授权全额退回',
    `phase=${String(phase || 'unknown').slice(0, 30)}`,
    `usage=${observed.inputTokens}/${observed.outputTokens}`,
    `supplierCost=${costStatus}`,
    `structure=${structureText}`,
  ].join('；');
}

r.post('/team-plan', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: '缺少老板原话，无法拆解' });
  if (text.length > TEAM_MATCH_MAX_TEXT) {
    return res.status(400).json({ error: `一句话最长${TEAM_MATCH_MAX_TEXT}字，请精简后再试` });
  }
  const depthKey = String(req.body?.depth || 'full');
  const depth = TEAM_PLAN_DEPTHS[depthKey];
  if (!depth) return res.status(400).json({ error: '输出标准仅支持：simple/full/pro' });
  if (!yunwuAvailable()) {
    return res.status(503).json({ error: '真实 AI 通道未配置，无法让队长拆解；不会用模板冒充拆解结果。' });
  }
  const employees = visibleEmployees(req);
  const byIdx = new Map(employees.map(item => [Number(item.idx), item]));
  const rawMembers = Array.isArray(req.body?.members) ? req.body.members : [];
  const members = [];
  const seen = new Set();
  for (const raw of rawMembers.slice(0, TEAM_MAX_MEMBERS)) {
    const idx = Number(raw?.idx);
    const source = byIdx.get(idx);
    if (!source || seen.has(idx)) continue;
    seen.add(idx);
    members.push({
      idx,
      person: source.person,
      name: source.name,
      duty: source.duty || source.desc || '',
      roleInTeam: raw?.roleInTeam === '队长' ? '队长' : '成员',
      task: String(raw?.task || '').slice(0, 200),
      dependsOn: [...new Set((Array.isArray(raw?.dependsOn) ? raw.dependsOn : [])
        .map(Number)
        .filter(value => Number.isSafeInteger(value) && value !== idx))],
      capabilityNames: (CAPABILITY_SUMMARY_BY_IDX.get(idx)?.capabilityNames?.length
        ? CAPABILITY_SUMMARY_BY_IDX.get(idx).capabilityNames
        : []),
      capabilityCount: CAPABILITY_SUMMARY_BY_IDX.get(idx)?.capabilityCount || 0,
    });
  }
  if (!members.length) return res.status(400).json({ error: '协同小队成员无效，请先重新「帮我选」' });
  const lead = members.find(item => item.roleInTeam === '队长') || members[0];
  const memberLines = members.map(member => {
    const deps = member.dependsOn.length
      ? `依赖成员:${member.dependsOn.map(idx => byIdx.get(idx)?.person || idx).join('、')}`
      : '无前置依赖';
    // 专业档把每名成员的完整能力清单交给队长，要求逐项用上。
    const capabilityLine = depthKey === 'pro' && member.capabilityCount
      ? `全部能力(${member.capabilityCount}项，逐项运用):${member.capabilityNames.join('、')}`
      : '';
    return [
      `${member.idx}｜${member.person}｜${member.name}｜小队分工:${member.task || '按岗位职责'}｜${deps}`,
      capabilityLine,
    ].filter(Boolean).join('\n  ');
  }).join('\n');
  const model = textModelFor('sales');
  const modelPlan = employeeTextModelFailoverPlan(model);
  // 每名成员的 directive 含四段+输出标准，专业档还要逐项点到能力；输出预算
  // 随人数放大，避免 8 人小队在 8000 tokens 处被截断后落成"漏拆成员"。
  const planOutputTokens = Math.min(16000, 5000 + members.length * 1400);
  let hold = null;
  try {
    for (const candidateModel of modelPlan.models) {
      precheck(req.user.id, 'text', candidateModel);
    }
    const estimatedCredits = Math.max(...modelPlan.models.map(candidateModel => (
      estimateCallCredits({
        model: candidateModel,
        outputTokens: planOutputTokens,
        texts: [text, memberLines],
      })
    )));
    hold = holdCredits({
      userId: req.user.id,
      feature: `协同小队·队长拆解派活（${depth.label}档）`,
      kind: 'text',
      model,
      // 只有零 token 瞬时故障允许第二次尝试，因此同一时刻最多只有
      // 一轮可结算用量；预授权取主备模型估价的较大值。
      credits: estimatedCredits,
      refType: null,
      refId: null,
    });
    const deliveryHold = hold;
    hold = null;
    const observedTeamPlanUsage = {
      inputTokens: 0,
      outputTokens: 0,
      supplierCosts: [],
    };
    const delivered = await executeHeldDelivery({
      hold: deliveryHold,
      refund: (held, options = {}) => {
        const cost = aggregateSupplierCosts(observedTeamPlanUsage.supplierCosts);
        return refundHold(held, {
          ...options,
          ...(cost?.status === 'known' ? {
            supplierCostYuan: cost.costYuanOverride,
            costSource: cost.costSource,
          } : {}),
        });
      },
      hasDeliverable: () => hasStoredAiDelivery(deliveryHold),
      generate: async () => {
        let output = null;
        let attempts = 0;
        let callModel = modelPlan.requestedModel;
        let modelFailover = null;
        for (let attempt = 1; attempt <= TEAM_PLAN_MAX_PROVIDER_ATTEMPTS; attempt += 1) {
          attempts = attempt;
          const generated = await generate({
            kind: 'employee-team-plan',
            system: [
              `你是协同小队队长「${lead.person}」（${lead.name}），负责把老板的一句话需求拆解派活给小队每一名成员（包括你自己）。`,
              `当前北京时间日期：${new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric' })}。`,
              '老板原话可能来自语音转写，存在同音错字或语气词；先按餐饮经营语境理解真实意图再拆解。',
              '拆解规则：',
              '- briefs 必须覆盖下方名单的每一名成员，一人一条，不得增删或虚构编号。',
              '- 小队默认并行开工：每人先完成不依赖他人的部分；前置成员结果尚未交付时，在 directive 中明确写“待衔接”及需要接入的具体产物，不得编造已经拿到前置结果。',
              '- 缺数据不停工：老板没给的门店数据（POS 客流、销量、库存、人数等），在 directive 里写明“先按以下假设出可用版本：……（标注〔可修正〕）”，让成员交付带假设的可用模板，并列出店长要补的数据；不得编造成真实数据，也不要因缺数据只交一份“请补充资料”。',
              '- title：这单活的任务标题（≤40字，业务口吻）。',
              '- 日期：老板只说月日、没有明确年份时，title、directive、deliverables 一律保留月日原样，禁止自行添加年份；明确给出的年份与相对日期按原要求处理，不得擅自改写。',
              '- directive：给该成员的完整任务指令，必须包含四部分：①要做什么（结合老板原话与该成员的小队分工）②与上下游怎么衔接（有依赖的写清楚拿谁的什么产出、给谁供料）③交付物是什么④【输出标准】一段。',
              `- 本次输出标准（${depth.label}档，逐字写进每名成员 directive 的【输出标准】里并按需细化到岗位）：${depth.outputRule}`,
              '- deliverables：用老板能懂的话一句话说明 TA 最终交出来什么。',
              teamPlanSchemaHint(members),
              '【小队名单（idx｜姓名｜岗位｜小队分工｜依赖）】',
              memberLines,
            ].join('\n'),
            userMsg: `老板原话：${text}`,
            fallback: () => '',
            maxTokens: planOutputTokens,
            role: req.user.role,
            model: callModel,
            // 拆解只需结构化业务正文。360 DeepSeek 默认思考会与正文共用
            // max_tokens；显式关闭后避免思考阶段耗尽时间却没有可交付 JSON。
            thinking: false,
            timeoutMs: TEAM_PLAN_PROVIDER_TIMEOUT_MS,
            // 360 已验证 DeepSeek V4 支持 OpenAI JSON Object mode；只在这条
            // 短结构拆解链启用。旧云雾通道继续依靠提示词与服务端完整性校验。
            responseFormat: provider360Active() && /deepseek/iu.test(callModel)
              ? { type: 'json_object' }
              : undefined,
            providerPolicy: 'yunwu_only',
            signal: req.requestSignal,
          });
          output = {
            ...generated,
            requestedModel: modelPlan.requestedModel,
            effectiveModel: generated?.mode === 'api' ? generated.model : callModel,
            modelFailover,
          };
          observeTeamPlanUsage(observedTeamPlanUsage, output);
          if (!shouldRetryTeamPlanOutput(output, attempt)) break;
          if (modelPlan.backupModel && shouldFailoverTeamPlanModel(output)) {
            modelFailover = {
              from: modelPlan.requestedModel,
              to: modelPlan.backupModel,
              reason: TEAM_PLAN_MODEL_FAILOVER_REASON,
              attempt: attempt + 1,
            };
            callModel = modelPlan.backupModel;
          }
          await waitForTeamPlanRetry(req.requestSignal);
        }
        try {
          assertRealAiOutput(output, {
            label: '队长拆解派活',
            noDelivery: '本次不产生拆解结果，也不扣费',
          });
        } catch (error) {
          throw attachTeamPlanUsageEvidence(
            attachTeamPlanProviderFailure(error, output, attempts),
            observedTeamPlanUsage,
          );
        }
        const parsed = parseTeamMatchJson(output.text);
        const rawBriefs = Array.isArray(parsed?.briefs) ? parsed.briefs : [];
        const briefByIdx = new Map();
        for (const raw of rawBriefs) {
          const idx = Number(raw?.idx);
          if (!seen.has(idx) || briefByIdx.has(idx)) continue;
          const directive = normalizeTeamPlanDateText(raw?.directive, text).trim();
          const title = normalizeTeamPlanDateText(raw?.title, text).trim().slice(0, 40);
          if (!directive || !title) continue;
          briefByIdx.set(idx, {
            idx,
            title,
            directive: directive.slice(0, 6000),
            deliverables: normalizeTeamPlanDateText(raw?.deliverables, text).trim().slice(0, 200),
          });
        }
        const missing = members.filter(member => !briefByIdx.has(member.idx));
        if (missing.length) {
          const structure = teamPlanStructureDiagnostic({
            rawBriefs,
            members,
            acceptedIdx: new Set(briefByIdx.keys()),
            output,
            req,
          });
          console.warn('[ai] employee-team-plan incomplete structure', JSON.stringify(structure));
          throw attachTeamPlanUsageEvidence(Object.assign(
            new Error(`队长拆解不完整，缺少成员：${missing.map(member => member.person).join('、')}，请重试`),
            {
              status: 422,
              code: 'TEAM_PLAN_INCOMPLETE',
              retryable: true,
              retryHint: '模型本轮漏拆了小队成员，未交付任何拆解并已退回预授权，可在原任务直接重试。',
              teamPlanStructure: structure,
            },
          ), observedTeamPlanUsage);
        }
        const briefs = members.map(member => ({
          ...briefByIdx.get(member.idx),
          person: member.person,
          name: member.name,
          roleInTeam: member.roleInTeam,
          dependsOn: member.dependsOn,
        }));
        return { briefs, output };
      },
      persist: generated => generated.briefs,
      settle: settleHold,
      release: releaseFailedAiHold,
      settlement: generated => ({
        usage: generated.output.usage,
        model: generated.output.effectiveModel || generated.output.model,
        aiMode: generated.output.mode,
        note: [
          `队长拆解派活：${depth.label}档，${members.length}名成员`,
          generated.output.modelFailover
            ? `模型接力 ${generated.output.modelFailover.from}→${generated.output.modelFailover.to}；reason=${TEAM_PLAN_MODEL_FAILOVER_REASON}`
            : '',
        ].filter(Boolean).join('；'),
      }),
      requirePositiveApiUsage: true,
      releaseNote: (error, phase) => teamPlanFailureNote(
        error,
        phase,
        observedTeamPlanUsage,
      ),
    });
    if (delivered.billing.state !== 'settled') {
      throw Object.assign(new Error('队长拆解已生成，但账务尚未完成结算，本次不交付可派发计划'), {
        status: 409,
        code: 'TEAM_PLAN_BILLING_NOT_SETTLED',
        retryable: false,
        billing: delivered.billing,
      });
    }
    try {
      logOp(req.user, '数字员工', '队长拆解派活', `${depth.label}档·${members.length}人`);
    } catch { /* 日志失败不影响业务返回 */ }
    res.set('Cache-Control', 'private, no-store');
    return res.json({
      plan: {
        depth: depthKey,
        depthLabel: depth.label,
        leadIdx: lead.idx,
        briefs: delivered.delivery,
      },
      billing: delivered.billing,
      boundary: '本次只完成队长拆解，尚未创建任何任务；派出后每名成员任务按其岗位现行标准计费执行。',
    });
  } catch (error) {
    if (hold) {
      try {
        releaseHold(hold, '队长拆解未进入模型生成，预授权全额退回');
      } catch { /* 保留原始错误 */ }
      hold = null;
    }
    const extra = {
      ...(error.providerFailure ? { providerFailure: error.providerFailure } : {}),
      ...(Number.isSafeInteger(Number(error.providerAttempts))
        ? { providerAttempts: Number(error.providerAttempts) }
        : {}),
    };
    return res.status(error.status || 502).json(aiFailurePayload(error, {
      requestId: teamPlanRequestId(req),
      extra,
    }));
  }
});

// ===== 队长收尾汇总（AgentTeams 第三步）=====
// 成员各自交付后，队长读取每个人的真实任务产出，给老板一份收口：
// 整体结论 + 各成员进度/要点 + 下一步行动计划 + 风险提醒。
// 只读真实任务与真实产出（未完成的如实标注，不编造）；真实计费、fail-closed。
const TEAM_SUMMARY_STATUS_LABEL = Object.freeze({
  已完成: '已完成',
  待审阅: '已交付（待人工确认）',
  生成中: '仍在执行',
  执行中: '仍在执行',
  失败: '执行失败',
  已驳回: '被驳回需返工',
});

export const TEAM_SUMMARY_PROVIDER_TIMEOUT_MS = 60_000;

function teamSummarySchemaHint(items) {
  return [
    '只输出一个 JSON 对象，不要输出任何解释或 Markdown 围栏：',
    JSON.stringify({
      summary: '',
      keyNumbers: [{ label: '', value: '', source: '' }],
      progress: items.map(item => ({ idx: item.idx, highlight: '' })),
      nextActions: [{ action: '', owner: '', timing: '' }],
      risks: '',
    }),
    `progress 必须恰好覆盖这 ${items.length} 名成员，idx 按此顺序逐一为：${items.map(item => item.idx).join('、')}，不得删除、合并、重复或改写。`,
  ].join('\n');
}

function attachTeamSummaryProviderFailure(error, output, attempts) {
  const target = error instanceof Error ? error : new Error(String(error || '队长汇总失败'));
  const providerFailure = publicTeamPlanProviderFailure(output?.providerFailure);
  if (!providerFailure) return target;
  target.code = providerFailure.code;
  target.retryable = providerFailure.retryable;
  target.retryHint = teamPlanHasProviderSpendEvidence(output)
    ? `上游${providerFailure.summary}，本次已返回用量证据，系统未重复提交；请稍后在原任务重试。`
    : attempts > 1
      ? `上游${providerFailure.summary}，系统已自动尝试 ${attempts} 次但仍未取得汇总，请稍后在原任务重试。`
      : `上游${providerFailure.summary}，请稍后在原任务重试。`;
  target.providerFailure = providerFailure;
  target.providerAttempts = Number(attempts) || 1;
  return target;
}

function teamSummaryFailureNote(error, phase, observed) {
  const cost = aggregateSupplierCosts(observed.supplierCosts);
  const costStatus = cost?.status || (observed.supplierCosts.length ? 'pending' : 'unknown');
  return [
    '队长汇总未形成有效结果，预授权全额退回',
    `phase=${String(phase || 'unknown').slice(0, 30)}`,
    `usage=${observed.inputTokens}/${observed.outputTokens}`,
    `supplierCost=${costStatus}`,
    `code=${String(error?.code || error?.name || 'failed').slice(0, 80)}`,
  ].join('；');
}

r.post('/team-summary', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: '缺少老板原话，无法汇总' });
  const rawItems = Array.isArray(req.body?.items) ? req.body.items.slice(0, TEAM_MAX_MEMBERS) : [];
  if (!rawItems.length) return res.status(400).json({ error: '还没有派出的任务，先让队长拆解并派活' });
  const employees = visibleEmployees(req);
  const byIdx = new Map(employees.map(item => [Number(item.idx), item]));
  const taskScope = userScopeClause(req.user, 't.created_by');
  const items = [];
  for (const raw of rawItems) {
    const idx = Number(raw?.idx);
    const taskId = Number(raw?.taskId);
    const source = byIdx.get(idx);
    if (!source || !Number.isSafeInteger(taskId) || taskId <= 0) continue;
    const task = q.get(
      `SELECT t.id, t.title, t.status, t.output_id outputId
       FROM agent_tasks t
       WHERE t.tenant_id=? AND t.id=?${taskScope.sql}`,
      curTenant(),
      taskId,
      ...taskScope.params,
    );
    if (!task) continue;
    let body = '';
    if (task.outputId) {
      const output = q.get(
        'SELECT title, body FROM contents WHERE tenant_id=? AND id=?',
        curTenant(),
        task.outputId,
      );
      body = String(output?.body || '').trim();
    }
    items.push({
      idx,
      person: source.person,
      name: source.name,
      taskId,
      taskTitle: String(task.title || ''),
      status: task.status,
      statusLabel: TEAM_SUMMARY_STATUS_LABEL[task.status] || task.status,
      hasOutput: Boolean(body),
      body,
    });
  }
  if (!items.length) return res.status(404).json({ error: '没有找到可汇总的任务（任务不存在或无权查看）' });
  const delivered_items = items.filter(item => item.hasOutput);
  if (!delivered_items.length) {
    return res.status(409).json({
      error: `成员任务都还没有产出（${items.map(item => `${item.person}:${item.statusLabel}`).join('、')}），等任一成员交付后再让队长汇总`,
      progress: items.map(({ body: _body, ...rest }) => rest),
    });
  }
  if (!yunwuAvailable()) {
    return res.status(503).json({ error: '真实 AI 通道未配置，无法生成队长汇总' });
  }
  const outputsBlock = items.map(item => [
    `【成员 idx=${item.idx}】${item.person}（${item.name}）任务#${item.taskId}「${item.taskTitle}」状态：${item.statusLabel}`,
    item.hasOutput ? `产出全文（截录）：\n${item.body.slice(0, 2600)}` : '（尚无产出，如实标注，不得编造）',
  ].join('\n')).join('\n\n---\n\n');
  const model = textModelFor('sales');
  let hold = null;
  try {
    precheckByRole(req.user.id, 'text', req.user.role);
    hold = holdCredits({
      userId: req.user.id,
      feature: '协同小队·队长收尾汇总',
      kind: 'text',
      model,
      credits: estimateCallCredits({ model, outputTokens: 10000, texts: [text, outputsBlock] }),
      refType: null,
      refId: null,
    });
    const deliveryHold = hold;
    hold = null;
    const observedTeamSummaryUsage = {
      inputTokens: 0,
      outputTokens: 0,
      supplierCosts: [],
    };
    const delivered = await executeHeldDelivery({
      hold: deliveryHold,
      refund: (held, options = {}) => {
        const cost = aggregateSupplierCosts(observedTeamSummaryUsage.supplierCosts);
        return refundHold(held, {
          ...options,
          ...(cost?.status === 'known' ? {
            supplierCostYuan: cost.costYuanOverride,
            costSource: cost.costSource,
          } : {}),
        });
      },
      hasDeliverable: () => hasStoredAiDelivery(deliveryHold),
      generate: async () => {
        let output = null;
        let attempts = 0;
        for (let attempt = 1; attempt <= TEAM_PLAN_MAX_PROVIDER_ATTEMPTS; attempt += 1) {
          attempts = attempt;
          const generated = await generate({
            kind: 'employee-team-summary',
            system: [
              '你是协同小队队长，成员们已经交付了各自的任务产出。现在向老板做一份详实的收尾汇报——老板要能凭这份汇报直接做决策。',
              '铁律：所有结论、数字和清单都必须摘自下方真实产出原文；产出里没有的数字绝不编造，没有量化数据就写"产出未给出量化数据"。未交付成员如实标注状态。',
              teamSummarySchemaHint(items),
              '- summary 写4-8句：说明这单活办到什么程度、各成员交付了什么、合起来解决什么问题、离目标还差什么；尽量引用产出中的具体数据或清单项。',
              '- keyNumbers 提取 3-8 个老板最关心的数字（钱、时间、数量、目标值）；每个都标注出处成员。产出确实没有数字时给空数组，不许硬凑。',
              '- progress 每人的 highlight 用2-3句说明实际交付；未交付成员写当前状态与影响，不许写空话。',
              '- nextActions 给 4-8 条，按轻重排序，必须落到人和时间，能量化的写量化标准。',
              '- risks 写最需要老板注意的1-2个风险，说明触发条件与后果；确实没有则给空字符串。',
              `【老板原话】${text}`,
              '【成员任务与产出】',
              outputsBlock,
            ].join('\n'),
            userMsg: '请输出详实的收尾汇报 JSON。',
            fallback: () => '',
            maxTokens: 10000,
            role: req.user.role,
            model,
            thinking: false,
            timeoutMs: TEAM_SUMMARY_PROVIDER_TIMEOUT_MS,
            responseFormat: provider360Active() && /deepseek/iu.test(model)
              ? { type: 'json_object' }
              : undefined,
            providerPolicy: 'yunwu_only',
            signal: req.requestSignal,
          });
          output = generated;
          observeTeamPlanUsage(observedTeamSummaryUsage, output);
          if (!shouldRetryTeamPlanOutput(output, attempt)) break;
          await waitForTeamPlanRetry(req.requestSignal);
        }
        try {
          assertRealAiOutput(output, {
            label: '队长收尾汇总',
            noDelivery: '本次不产生汇总，也不扣费',
          });
        } catch (error) {
          throw attachTeamPlanUsageEvidence(
            attachTeamSummaryProviderFailure(error, output, attempts),
            observedTeamSummaryUsage,
          );
        }
        const parsed = parseTeamMatchJson(output.text);
        const summary = String(parsed?.summary || '').trim();
        if (!summary) {
          throw attachTeamPlanUsageEvidence(
            Object.assign(new Error('队长没有给出有效汇总，请重试'), {
              status: 422,
              code: 'TEAM_SUMMARY_INVALID',
              retryable: true,
            }),
            observedTeamSummaryUsage,
          );
        }
        // 汇总不许糊弄：有交付产出时，正文至少要有实质篇幅（不足视为无效交付）
        if (summary.length < 60) {
          throw attachTeamPlanUsageEvidence(
            Object.assign(new Error('队长汇总过于简略（不足60字），已拒收，请重试'), {
              status: 422,
              code: 'TEAM_SUMMARY_TOO_SHORT',
              retryable: true,
            }),
            observedTeamSummaryUsage,
          );
        }
        const highlightByIdx = new Map(
          (Array.isArray(parsed?.progress) ? parsed.progress : [])
            .map(row => [Number(row?.idx), String(row?.highlight || '').trim()])
            .filter(([idx, highlight]) => Number.isSafeInteger(idx) && highlight),
        );
        const keyNumbers = (Array.isArray(parsed?.keyNumbers) ? parsed.keyNumbers : [])
          .map(row => ({
            label: String(row?.label || '').trim().slice(0, 30),
            value: String(row?.value || '').trim().slice(0, 60),
            source: String(row?.source || '').trim().slice(0, 30),
          }))
          .filter(row => row.label && row.value)
          .slice(0, 8);
        const nextActions = (Array.isArray(parsed?.nextActions) ? parsed.nextActions : [])
          .map(row => ({
            action: String(row?.action || '').trim().slice(0, 300),
            owner: String(row?.owner || '').trim().slice(0, 40),
            timing: String(row?.timing || '').trim().slice(0, 40),
          }))
          .filter(row => row.action)
          .slice(0, 10);
        return {
          result: {
            summary: summary.slice(0, 1600),
            keyNumbers,
            progress: items.map(item => ({
              idx: item.idx,
              person: item.person,
              name: item.name,
              taskId: item.taskId,
              status: item.status,
              statusLabel: item.statusLabel,
              hasOutput: item.hasOutput,
              highlight: (
                highlightByIdx.get(item.idx) ||
                (item.hasOutput ? '已交付，详见任务产出' : `当前${item.statusLabel}`)
              ).slice(0, 400),
            })),
            nextActions,
            risks: String(parsed?.risks || '').trim().slice(0, 500),
            summarizedAt: new Date().toISOString(),
          },
          output,
        };
      },
      persist: generated => generated.result,
      settle: settleHold,
      release: releaseHold,
      settlement: generated => ({
        usage: generated.output.usage,
        model: generated.output.model,
        aiMode: generated.output.mode,
        note: `队长收尾汇总：${delivered_items.length}/${items.length} 名成员已交付`,
      }),
      requirePositiveApiUsage: true,
      releaseNote: (error, phase) => teamSummaryFailureNote(
        error,
        phase,
        observedTeamSummaryUsage,
      ),
    });
    try {
      logOp(req.user, '数字员工', '队长收尾汇总', `${delivered_items.length}/${items.length}人已交付`);
    } catch { /* 日志失败不影响业务返回 */ }
    res.set('Cache-Control', 'private, no-store');
    return res.json({
      teamSummary: delivered.delivery,
      billing: delivered.billing,
      boundary: '汇总只读取已存在的真实任务产出；未交付成员如实标注，不代替执行。',
    });
  } catch (error) {
    if (hold) {
      try {
        releaseHold(hold, '队长汇总未进入模型生成，预授权全额退回');
      } catch { /* 保留原始错误 */ }
      hold = null;
    }
    const extra = {
      ...(error.providerFailure ? { providerFailure: error.providerFailure } : {}),
      ...(Number.isSafeInteger(Number(error.providerAttempts))
        ? { providerAttempts: Number(error.providerAttempts) }
        : {}),
    };
    return res.status(error.status || 502).json(aiFailurePayload(error, {
      requestId: teamPlanRequestId(req),
      extra,
    }));
  }
});

// ===== 数字员工自动进化（Warp 自我改进模式落地）=====
// 反馈来源：老板对该员工任务的验收记录（采纳/驳回+理由）——在工作发生处采集，零新增摩擦。
// 改进器：真实 AI 对比产出与反馈，提炼最多 3 条「实战心得」（原则+为什么+证据）。
// 人在环：提案必须人工采纳后才写入心得库；下次派活自动注入已生效心得。
const EVOLUTION_ROLES = ['boss', 'admin', 'ops_director'];

function evolutionSpecialist(specialistId) {
  return q.get(
    'SELECT s.id, s.name, s.duty, s.person FROM specialists s WHERE s.id = ?',
    Number(specialistId),
  );
}

r.get('/evolution/:specialistId', requireRole(...EVOLUTION_ROLES), (req, res) => {
  const specialist = evolutionSpecialist(req.params.specialistId);
  if (!specialist) return res.status(404).json({ error: '数字员工不存在' });
  const { stats } = collectEvolutionSignals(specialist.id);
  const notes = q.all(
    `SELECT id, note, rationale, evidence, status, created_at, retired_at
     FROM employee_evolution_notes WHERE tenant_id=? AND domain='restaurant' AND specialist_id=?
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id DESC LIMIT 40`,
    curTenant(),
    specialist.id,
  );
  const proposals = q.all(
    `SELECT id, summary, proposal_json, status, created_at, decided_at
     FROM employee_evolution_proposals WHERE tenant_id=? AND domain='restaurant' AND specialist_id=?
     ORDER BY id DESC LIMIT 10`,
    curTenant(),
    specialist.id,
  ).map(row => ({
    id: row.id,
    summary: row.summary,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    proposal: (() => {
      try { return JSON.parse(row.proposal_json); } catch { return null; }
    })(),
  }));
  res.set('Cache-Control', 'private, no-store');
  res.json({
    specialist: { id: specialist.id, name: specialist.name, duty: specialist.duty, person: specialist.person },
    stats,
    minSignals: EVOLUTION_MIN_SIGNALS,
    notes,
    proposals,
  });
});

r.post('/evolution/:specialistId/propose', requireRole(...EVOLUTION_ROLES), async (req, res) => {
  const specialist = evolutionSpecialist(req.params.specialistId);
  if (!specialist) return res.status(404).json({ error: '数字员工不存在' });
  if (!yunwuAvailable()) return res.status(503).json({ error: '真实 AI 通道未配置，无法生成进化提案' });
  const { signals, stats } = collectEvolutionSignals(specialist.id);
  if (stats.total < EVOLUTION_MIN_SIGNALS) {
    return res.status(400).json({
      error: `近30天验收记录仅 ${stats.total} 条（至少需要 ${EVOLUTION_MIN_SIGNALS} 条），先多派几单活并完成验收再进化`,
    });
  }
  const pendingProposal = q.get(
    `SELECT id FROM employee_evolution_proposals WHERE tenant_id=? AND domain='restaurant' AND specialist_id=? AND status='待审核'`,
    curTenant(),
    specialist.id,
  );
  if (pendingProposal) {
    return res.status(409).json({ error: '已有一份进化提案待审批，请先处理（采纳或驳回）再生成新提案' });
  }
  const existingNotes = activeEvolutionNotes(specialist.id, { limit: 20 });
  const prompt = buildEvolutionPrompt({
    employeeName: specialist.name,
    signals,
    stats,
    existingNotes,
  });
  const model = textModelFor('sales');
  let hold = null;
  try {
    precheckByRole(req.user.id, 'text', req.user.role);
    hold = holdCredits({
      userId: req.user.id,
      feature: '数字员工·进化提案',
      kind: 'text',
      model,
      credits: estimateCallCredits({ model, outputTokens: 6000, texts: [prompt] }),
      refType: 'specialist',
      refId: specialist.id,
    });
    const deliveryHold = hold;
    hold = null;
    const delivered = await executeHeldDelivery({
      hold: deliveryHold,
      refund: refundHold,
      hasDeliverable: () => hasStoredAiDelivery(deliveryHold),
      generate: async () => {
        let output = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          output = await generate({
            kind: 'employee-evolution-proposal',
            system: prompt,
            userMsg: '请输出这轮进化提案的 JSON。',
            fallback: () => '',
            maxTokens: 6000,
            role: req.user.role,
            model,
            providerPolicy: 'yunwu_only',
            signal: req.requestSignal,
          });
          const retryable =
            output?.mode !== 'api' &&
            ['provider_rate_limited', 'provider_empty_output'].includes(output?.providerFailure?.code);
          if (!retryable || attempt === 2) break;
          await new Promise(resolve => setTimeout(resolve, 2500));
        }
        assertRealAiOutput(output, { label: '进化提案', noDelivery: '本次不生成提案，也不扣费' });
        const proposal = parseEvolutionProposal(output.text);
        return { proposal, output };
      },
      persist: generated => {
        const created = q.run(
          `INSERT INTO employee_evolution_proposals(tenant_id,specialist_id,summary,proposal_json,signals_json,status,created_by)
           VALUES(?,?,?,?,?,'待审核',?)`,
          curTenant(),
          specialist.id,
          generated.proposal.summary
            || (generated.proposal.verdict === 'insufficient' ? '反馈样本不足，暂无可靠心得' : '进化提案'),
          JSON.stringify(generated.proposal),
          JSON.stringify(stats),
          req.user.id,
        );
        return { id: Number(created.lastInsertRowid), ...generated.proposal };
      },
      settle: settleHold,
      release: releaseHold,
      settlement: generated => ({
        usage: generated.output.usage,
        model: generated.output.model,
        aiMode: generated.output.mode,
        note: `进化提案：${specialist.name}（样本${stats.total}条）`,
      }),
      requirePositiveApiUsage: true,
      releaseNote: '进化提案未交付，预授权全额退回',
    });
    logOp(req.user, '数字员工', '生成进化提案', `${specialist.name}#${delivered.delivery.id}`);
    res.set('Cache-Control', 'private, no-store');
    return res.json({
      proposal: delivered.delivery,
      billing: delivered.billing,
      boundary: '提案尚未生效；采纳后才会写入员工心得并影响后续派活。',
    });
  } catch (error) {
    if (hold) {
      try {
        releaseHold(hold, '进化提案未进入模型生成，预授权全额退回');
      } catch { /* 保留原始错误 */ }
      hold = null;
    }
    return res.status(error.status || 502).json({
      error: String(error?.message || '进化提案生成失败').slice(0, 300),
      ...(error.billing ? { billing: error.billing } : {}),
    });
  }
});

r.post('/evolution/proposals/:proposalId/decide', requireRole(...EVOLUTION_ROLES), (req, res) => {
  const decision = String(req.body?.decision || '');
  if (!['adopt', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision 仅支持 adopt/reject' });
  const proposal = q.get(
    `SELECT * FROM employee_evolution_proposals WHERE tenant_id=? AND domain='restaurant' AND id=?`,
    curTenant(),
    Number(req.params.proposalId),
  );
  if (!proposal) return res.status(404).json({ error: '进化提案不存在' });
  if (proposal.status !== '待审核') return res.status(409).json({ error: `该提案已${proposal.status}，不能重复处理` });
  let parsed = null;
  try { parsed = JSON.parse(proposal.proposal_json); } catch { parsed = null; }
  let adoptedNotes = 0;
  let retiredNotes = 0;
  if (decision === 'adopt' && parsed) {
    for (const item of Array.isArray(parsed.additions) ? parsed.additions : []) {
      if (!String(item?.note || '').trim()) continue;
      q.run(
        `INSERT INTO employee_evolution_notes(tenant_id,specialist_id,note,rationale,evidence,status,proposal_id)
         VALUES(?,?,?,?,?,'active',?)`,
        curTenant(),
        proposal.specialist_id,
        String(item.note).slice(0, 120),
        String(item.rationale || '').slice(0, 160) || null,
        String(item.evidence || '').slice(0, 200) || null,
        proposal.id,
      );
      adoptedNotes += 1;
    }
    for (const noteId of Array.isArray(parsed.retireNoteIds) ? parsed.retireNoteIds : []) {
      const updated = q.run(
        `UPDATE employee_evolution_notes SET status='retired', retired_at=datetime('now','localtime')
         WHERE tenant_id=? AND domain='restaurant' AND specialist_id=? AND id=? AND status='active'`,
        curTenant(),
        proposal.specialist_id,
        Number(noteId),
      );
      retiredNotes += Number(updated.changes) || 0;
    }
  }
  q.run(
    `UPDATE employee_evolution_proposals SET status=?, decided_by=?, decided_at=datetime('now','localtime')
     WHERE tenant_id=? AND id=?`,
    decision === 'adopt' ? '已采纳' : '已驳回',
    req.user.id,
    curTenant(),
    proposal.id,
  );
  const specialist = evolutionSpecialist(proposal.specialist_id);
  if (decision === 'adopt' && proposal.created_by && proposal.created_by !== req.user.id) {
    try {
      notify(
        proposal.created_by,
        'employee-evolution',
        `「${specialist?.name || '数字员工'}」的进化提案已被采纳`,
        `${adoptedNotes} 条新心得已生效${retiredNotes ? `，${retiredNotes} 条旧心得退役` : ''}；下次派活自动运用。`,
        '/employees',
      );
    } catch { /* 通知失败不影响业务 */ }
  }
  logOp(req.user, '数字员工', decision === 'adopt' ? '采纳进化提案' : '驳回进化提案', `#${proposal.id}`);
  res.json({ ok: true, decision, adoptedNotes, retiredNotes });
});

r.put('/evolution/notes/:noteId/retire', requireRole(...EVOLUTION_ROLES), (req, res) => {
  const updated = q.run(
    `UPDATE employee_evolution_notes SET status='retired', retired_at=datetime('now','localtime')
     WHERE tenant_id=? AND domain='restaurant' AND id=? AND status='active'`,
    curTenant(),
    Number(req.params.noteId),
  );
  if (!Number(updated.changes)) return res.status(404).json({ error: '心得不存在或已退役' });
  logOp(req.user, '数字员工', '退役实战心得', `#${req.params.noteId}`);
  res.json({ ok: true });
});

export default r;
