// 数字员工「自我介绍」一致性校验（纯函数，不碰数据库、不调模型、零积分）。
//
// 老板担心的是员工用久了"记忆漂移"：老板叮嘱里混进别的岗位的活、采纳的心得
// 与岗位安全边界冲突、企业补充提示词膨胀到运行包塞不下、太久没人看过。
// 这些都能用 catalog 花名册 + 既有风控规则做确定性对照，结果可解释、可复现。
//
// 关于 mode:'llm' 的扩展位：本期刻意不实现模型校验。原因——老板要的是
// "确认无幻觉"，再让模型生成一段判断只会引入第二段需要校验的幻觉；而确定性
// 对照零成本、可回归测试、每条结论都能指到 catalog 的具体岗位。真要接模型，
// 必须走 credits.js 的 precheck/holdCredits/settleHold 两阶段计费，且只做
// "复述差异"而非"重写介绍"。

export const SELF_INTRO_MAX_CHARS = 1500;
// 与 employee-workbench.js updateEmployeePrompt 的 cleanText 上限一致。
export const ENTERPRISE_PROMPT_MAX_CHARS = 20000;
export const SELF_INTRO_CONFIRM_STALE_DAYS = 30;
export const INTRO_CHECK_STATUS = Object.freeze({
  OK: "ok",
  NEEDS_REVIEW: "needs_review",
  NEVER: "never",
});
export const INTRO_CHECK_MODES = Object.freeze(["deterministic", "llm"]);

const KEYWORD_MIN_CHARS = 4;
const KEYWORD_MAX_CHARS = 14;
// 太通用、几乎每个岗位交付物都会出现的词，不能当作"别人家的职责"证据。
const GENERIC_KEYWORDS = new Set([
  "决策建议",
  "数据缺口",
  "风险提示",
  "下一步建议",
  "执行计划",
  "行动计划",
  "检查清单",
  "改进建议",
  "数据来源",
  "证据来源",
  "质量标准",
  "关键假设",
  "验证计划",
  "复盘报告",
  "总结报告",
  "分析报告",
  "评估报告",
  "实施方案",
  "执行方案",
  "运营建议",
  "优化建议",
]);
const MAX_FINDINGS_PER_RULE = 6;

// 与岗位安全边界（不得对外发布 / 不得替老板做财务或监管决定 / 不得绕过质量门）直接冲突的表述。
export const BOUNDARY_CONFLICT_PATTERNS = Object.freeze([
  {
    code: "SKIP_APPROVAL",
    label: "绕过审批或人工确认",
    pattern: /(无需|不用|不必|跳过|绕过|免去)(老板|人工|管理层|门店)?(审批|审核|复核|确认)/u,
  },
  {
    code: "AUTO_EXTERNAL_ACTION",
    label: "自动对外发布或资金动作",
    pattern: /(自动|直接|自行)(对外)?(发布|推送到平台|付款|转账|打款|签约|下单|退款)/u,
  },
  {
    code: "IGNORE_GUARDRAIL",
    label: "忽略岗位手册或安全边界",
    pattern: /(忽略|无视|抛开|不管|不受)(安全边界|质量门|岗位手册|出厂手册|系统规则|风控)/u,
  },
  {
    code: "IDENTITY_SWAP",
    label: "改变身份或冒充其他岗位",
    pattern: /(你不再是|忘掉你的岗位|扮演其他岗位|同时兼任所有岗位|替代其他岗位)/u,
  },
]);

function text(value) {
  return String(value ?? "").trim();
}

function toDate(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  // SQLite datetime('now','localtime') 形如 "2026-09-03 09:00:00"，按本机本地时间解析。
  const normalized = String(value).trim().replace(" ", "T");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function daysBetween(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

function isAcknowledged(changedAt, verifiedAt) {
  const changed = toDate(changedAt);
  const verified = toDate(verifiedAt);
  if (!verified) return false;
  // 没有变更时间的内容（如 catalog 默认）视为已随最近一次确认一并看过。
  if (!changed) return true;
  return changed.getTime() <= verified.getTime();
}

function plain(value) {
  return text(value)
    .replace(/^提供[：:]\s*/u, "")
    .replace(/\*\*|__|[*`#]/gu, "")
    .replace(/[。；;]$/u, "");
}

export function extractDeliverableKeywords(deliverables = []) {
  const out = new Set();
  for (const raw of Array.isArray(deliverables) ? deliverables : []) {
    const cleaned = plain(raw);
    if (!cleaned) continue;
    // 连接词（与/和/及/或）也当分隔符：交付物常写成"A与B"，整句几乎不可能被原样引用，拆开才对得上。
    for (const token of cleaned.split(
      /[、，,。：:；;（）()［］\[\]「」《》〈〉/／\\|｜\s\-—·~～!！?？"'“”]+|与|和|及|或/u,
    )) {
      const word = token.trim();
      if (word.length < KEYWORD_MIN_CHARS || word.length > KEYWORD_MAX_CHARS)
        continue;
      if (!/[\u4e00-\u9fff]/u.test(word)) continue;
      if (GENERIC_KEYWORDS.has(word)) continue;
      out.add(word);
    }
  }
  return [...out];
}

function employeeCorpus(employee) {
  return [
    employee.name,
    employee.duty,
    employee.desc,
    employee.intro,
    ...(Array.isArray(employee.deliverables) ? employee.deliverables : []),
    ...(Array.isArray(employee.steps) ? employee.steps : []),
    ...(Array.isArray(employee.inputs) ? employee.inputs : []),
  ]
    .map(text)
    .filter(Boolean)
    .join("\n");
}

/**
 * 花名册索引：每位员工的人名、岗位名以及"只属于少数岗位"的交付物关键词。
 * 同一关键词若出现在 3 个以上岗位的交付物里，说明它是行业通用词，不用于判定。
 */
export function buildRosterIndex(roster = []) {
  const employees = (Array.isArray(roster) ? roster : [])
    .filter((item) => Number.isInteger(Number(item?.idx)))
    .map((item) => ({
      idx: Number(item.idx),
      person: text(item.person),
      name: text(item.name),
      duty: text(item.duty),
      keywords: extractDeliverableKeywords(item.deliverables),
      corpus: employeeCorpus(item),
    }));
  const owners = new Map();
  for (const employee of employees) {
    for (const keyword of employee.keywords) {
      if (!owners.has(keyword)) owners.set(keyword, new Set());
      owners.get(keyword).add(employee.idx);
    }
  }
  for (const employee of employees) {
    employee.distinctiveKeywords = employee.keywords.filter(
      (keyword) => (owners.get(keyword)?.size || 0) <= 2,
    );
  }
  return {
    employees,
    byIdx: new Map(employees.map((employee) => [employee.idx, employee])),
  };
}

function ruleForeignReferences({ selfIntro, employee, rosterIndex, acknowledged }) {
  const findings = [];
  const intro = text(selfIntro);
  if (!intro || !employee) return findings;
  const self = rosterIndex.byIdx.get(employee.idx);
  const ownCorpus = self?.corpus || employeeCorpus(employee);
  for (const other of rosterIndex.employees) {
    if (other.idx === employee.idx) continue;
    if (findings.length >= MAX_FINDINGS_PER_RULE) break;
    if (other.person && intro.includes(other.person)) {
      findings.push({
        rule: "a",
        code: "FOREIGN_PERSON",
        severity: "warn",
        acknowledged,
        message: `发现介绍中提到「${other.person}」，这是 ${other.idx} 号岗位「${other.name}」的员工，不是本岗位`,
        evidence: { idx: other.idx, term: other.person },
      });
      continue;
    }
    const hit = other.distinctiveKeywords.find(
      (keyword) => intro.includes(keyword) && !ownCorpus.includes(keyword),
    );
    if (hit) {
      findings.push({
        rule: "a",
        code: "FOREIGN_DELIVERABLE",
        severity: "warn",
        acknowledged,
        message: `发现介绍中提到「${hit}」，但这是 ${other.idx} 号岗位「${other.name}」的职责`,
        evidence: { idx: other.idx, term: hit },
      });
    }
  }
  return findings;
}

function boundaryConflicts(value, scanRisk) {
  const body = text(value);
  if (!body) return [];
  const conflicts = [];
  for (const item of BOUNDARY_CONFLICT_PATTERNS) {
    if (item.pattern.test(body)) conflicts.push({ code: item.code, label: item.label });
  }
  if (typeof scanRisk === "function") {
    try {
      const scanned = scanRisk(body);
      for (const hit of Array.isArray(scanned?.hits) ? scanned.hits : []) {
        conflicts.push({
          code: `RISK_${String(hit.code || "RULE")}`,
          label: String(hit.name || hit.code || "风控规则"),
        });
      }
    } catch {
      /* 风控规则不可用时只按内置边界词判定 */
    }
  }
  return conflicts;
}

function ruleSafetyConflicts({ selfIntro, selfIntroAcknowledged, evolutionNotes, verifiedAt, scanRisk }) {
  const findings = [];
  const introConflicts = boundaryConflicts(selfIntro, scanRisk);
  for (const conflict of introConflicts.slice(0, MAX_FINDINGS_PER_RULE)) {
    findings.push({
      rule: "b",
      code: `INTRO_${conflict.code}`,
      severity: "high",
      acknowledged: selfIntroAcknowledged,
      message: `老板叮嘱中出现「${conflict.label}」类表述，与岗位安全边界冲突`,
      evidence: { source: "self_intro", code: conflict.code },
    });
  }
  for (const note of Array.isArray(evolutionNotes) ? evolutionNotes : []) {
    if (findings.length >= MAX_FINDINGS_PER_RULE * 2) break;
    const body = [note?.note, note?.rationale].map(text).filter(Boolean).join("；");
    const conflicts = boundaryConflicts(body, scanRisk);
    if (!conflicts.length) continue;
    findings.push({
      rule: "b",
      code: `NOTE_${conflicts[0].code}`,
      severity: "high",
      acknowledged: isAcknowledged(note?.created_at || note?.createdAt, verifiedAt),
      message: `已采纳的实战心得「${text(note?.note).slice(0, 40)}」含有「${conflicts[0].label}」类表述，与岗位安全边界冲突`,
      evidence: { source: "evolution_note", noteId: note?.id ?? null, code: conflicts[0].code },
    });
  }
  return findings;
}

function rulePromptBudget({ enterprisePrompt, maxChars }) {
  const length = text(enterprisePrompt).length;
  if (length <= maxChars) return [];
  return [
    {
      rule: "c",
      code: "ENTERPRISE_PROMPT_TOO_LONG",
      severity: "warn",
      acknowledged: false,
      message: `企业补充提示词已有 ${length} 字，超出运行包上限 ${maxChars} 字，派活时会被截断或拒绝装载`,
      evidence: { length, maxChars },
    },
  ];
}

function ruleStaleConfirmation({ verifiedAt, now, hasCustomization, staleDays }) {
  const verified = toDate(verifiedAt);
  if (!verified) {
    if (!hasCustomization) return [];
    return [
      {
        rule: "d",
        code: "NEVER_CONFIRMED",
        severity: "info",
        acknowledged: false,
        message: "这位员工已有企业定制内容（老板叮嘱/实战心得/补充提示词），但老板从未确认过 TA 的自我介绍",
        evidence: { verifiedAt: null },
      },
    ];
  }
  const days = daysBetween(verified, now);
  if (days <= staleDays) return [];
  return [
    {
      rule: "d",
      code: "CONFIRMATION_STALE",
      severity: "info",
      acknowledged: false,
      message: `距上次老板确认已 ${days} 天（超过 ${staleDays} 天），建议重新看一眼 TA 的自我介绍`,
      evidence: { verifiedAt: verified.toISOString(), days, staleDays },
    },
  ];
}

/**
 * @param {object} input
 * @param {{idx:number, person?:string, name?:string, duty?:string, deliverables?:string[]}} input.employee 本岗位（catalog）
 * @param {Array} input.roster catalog 全员名单（含 deliverables）
 * @param {string|null} input.selfIntro 老板叮嘱正文
 * @param {string|null} input.selfIntroUpdatedAt
 * @param {Array<{id?:number,note:string,rationale?:string,created_at?:string}>} input.evolutionNotes 已采纳心得
 * @param {string|null} input.enterprisePrompt 企业补充提示词原文
 * @param {string|Date|null} input.verifiedAt 最近一次老板确认时间
 * @param {Date} input.now
 * @param {(text:string)=>{hits:Array}} [input.scanRisk] 复用 risk.js 的 scanText（可选）
 * @param {"deterministic"|"llm"} [input.mode]
 */
export function checkSelfIntro(input = {}) {
  const mode = input.mode || "deterministic";
  if (!INTRO_CHECK_MODES.includes(mode)) {
    throw Object.assign(new Error(`未知校验模式：${mode}`), { status: 400 });
  }
  if (mode === "llm") {
    // 扩展位：见文件头注释。接入前必须先设计两阶段计费与"只指出差异不重写"的输出契约。
    throw Object.assign(
      new Error("模型校验暂未启用：本期只提供零积分的确定性一致性检查"),
      { status: 501 },
    );
  }
  const now = toDate(input.now) || new Date();
  const employee = input.employee || null;
  const rosterIndex =
    input.rosterIndex && input.rosterIndex.byIdx
      ? input.rosterIndex
      : buildRosterIndex(input.roster || []);
  const selfIntro = text(input.selfIntro) || null;
  const evolutionNotes = Array.isArray(input.evolutionNotes) ? input.evolutionNotes : [];
  const enterprisePrompt = text(input.enterprisePrompt) || null;
  const verifiedAt = input.verifiedAt ?? null;
  const selfIntroAcknowledged = Boolean(selfIntro) && isAcknowledged(input.selfIntroUpdatedAt, verifiedAt);
  const staleDays = Number.isInteger(input.staleDays) ? input.staleDays : SELF_INTRO_CONFIRM_STALE_DAYS;
  const maxPromptChars = Number.isInteger(input.enterprisePromptMaxChars)
    ? input.enterprisePromptMaxChars
    : ENTERPRISE_PROMPT_MAX_CHARS;

  const findings = [
    ...ruleForeignReferences({
      selfIntro,
      employee,
      rosterIndex,
      acknowledged: selfIntroAcknowledged,
    }),
    ...ruleSafetyConflicts({
      selfIntro,
      selfIntroAcknowledged,
      evolutionNotes,
      verifiedAt,
      scanRisk: input.scanRisk,
    }),
    ...rulePromptBudget({ enterprisePrompt, maxChars: maxPromptChars }),
    ...ruleStaleConfirmation({
      verifiedAt,
      now,
      hasCustomization: Boolean(selfIntro || evolutionNotes.length || enterprisePrompt),
      staleDays,
    }),
  ];
  const active = findings.filter((item) => !item.acknowledged);
  const status = active.length ? INTRO_CHECK_STATUS.NEEDS_REVIEW : INTRO_CHECK_STATUS.OK;
  const note = active.length
    ? active
        .map((item) => item.message)
        .join("；")
        .slice(0, 600)
    : null;
  return {
    mode,
    status,
    note,
    findings,
    acknowledgedCount: findings.length - active.length,
    checkedAt: now.toISOString(),
    rules: {
      a: "老板叮嘱不得出现其他岗位的人名或专属交付物",
      b: "老板叮嘱与已采纳心得不得与岗位安全边界/风控规则冲突",
      c: `企业补充提示词不超过运行包上限 ${maxPromptChars} 字`,
      d: `距上次老板确认不超过 ${staleDays} 天`,
    },
  };
}
