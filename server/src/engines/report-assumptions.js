// PRD v2.2 FR-7.1：假设面板与一键重算。
// 员工交付（Markdown）末尾的“## 可改的假设”表格（参数｜默认值｜改了会影响什么）解析成
// assumptions[]，前端渲染成可编辑小卡片；老板改值后生成结构化“按新假设重算”指令交给
// report-refine 引擎：不重新检索，只重算受影响的数字并改写，作为新版本保存，原稿保留。
// 纯函数，无 I/O。

export const ASSUMPTIONS_MAX = 10;
const VALUE_MAX = 40;

const SECTION_PREFIX =
  "(?:(?:第)?[\\d一二三四五六七八九十百]+(?:[.、．)）:：\\s]+|章\\s*|部分\\s*)|[（(][\\d一二三四五六七八九十]+[）)]\\s*)?";
const HEADING_RE = new RegExp(
  `^(?:#{1,4}\\s*|\\*\\*\\s*)${SECTION_PREFIX}(?:可改的假设|可调整的假设|关键假设|假设与参数|假设参数|核心假设)`,
  "u",
);
const UNIT_RE = /(万元|元\/人|元|万|%|km|公里|米|m|天|周|个月|月|家|单|桌|人|次|份|小时|h)\s*$/iu;

const BUDGET_PATTERNS = [
  /(?:总预算|活动预算|推广预算|营销预算|预算上限|预算金额)\s*(?:为|约|约为|[:：=])?\s*[¥￥]?\s*([\d,，]+(?:\.\d+)?)\s*(万元|万|元)/iu,
  /预算\s*[:：=]\s*(?:约)?\s*[¥￥]?\s*([\d,，]+(?:\.\d+)?)\s*(万元|万|元)/iu,
  /预算(?:控制在|不超过|上限|约|为|是)?\s*[¥￥]?\s*([\d,，]+(?:\.\d+)?)\s*(万元|万|元)/iu,
];

function extractExplicitBudgetFromText(text) {
  const source = String(text || "");
  if (!source.trim()) return null;
  for (const pattern of BUDGET_PATTERNS) {
    const match = source.match(pattern);
    if (!match) continue;
    const rawNum = String(match[1] || "").replace(/[,，]/gu, "");
    const amount = Number(rawNum);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const unit = match[2] === "万" ? "万元" : match[2];
    return {
      value: `${rawNum}${unit}`,
      unit,
    };
  }
  return null;
}

function clean(value, max = VALUE_MAX) {
  return String(value ?? "")
    .replace(/\*\*|__|`/gu, "")
    .replace(/<[^>]*>/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/u.test(cell.replace(/\s/gu, "")));
}

function tierOf(text) {
  if (/\(推测\)|（推测）/u.test(text)) return "C";
  if (/\(参考\)|（参考）/u.test(text)) return "B";
  if (/老板|自家|你给|已提供/u.test(text)) return "A";
  return "assumption";
}

function slug(label, index) {
  const base = clean(label, 24).replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/gu, "");
  return base || `assumption_${index + 1}`;
}

/**
 * 从报告 Markdown 解析“可改的假设”表格（兼容中文章节编号如“## 七、可改的假设”）。
 * 若报告或派单要求中给出了明确的活动预算但假设表漏列，自动补入可编辑的“活动预算”项。
 * 既没有假设表也没有明确预算时返回 []。
 */
export function extractReportAssumptions(markdown, { requirement = "" } = {}) {
  const rawMarkdown = String(markdown || "");
  const lines = rawMarkdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => HEADING_RE.test(line.trim()));
  const items = [];
  const seen = new Set();
  if (start !== -1) {
    const section = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^#{1,4}\s/u.test(lines[i].trim())) break;
      section.push(lines[i]);
    }
    const tableLines = section.filter((line) => /^\s*\|.*\|\s*$/u.test(line));
    if (tableLines.length >= 2) {
      const header = splitRow(tableLines[0]);
      const find = (re, fallback) => {
        const index = header.findIndex((cell) => re.test(cell));
        return index === -1 ? fallback : index;
      };
      const labelCol = find(/参数|假设|项目|名称/u, 0);
      const valueCol = find(/默认|取值|当前|数值|值/u, 1);
      const impactCol = find(/影响|说明|用途/u, 2);
      for (const line of tableLines.slice(1)) {
        const cells = splitRow(line);
        if (isSeparatorRow(cells)) continue;
        const label = clean(cells[labelCol], 24);
        const rawValue = cells[valueCol] ?? "";
        const value = clean(rawValue);
        if (!label || !value || /^[-—–]+$/u.test(value)) continue;
        const key = slug(label, items.length);
        if (seen.has(key)) continue;
        seen.add(key);
        const unit = value.match(UNIT_RE)?.[1] || null;
        items.push({
          key,
          label,
          value,
          unit,
          impact: clean(cells[impactCol] ?? "", 80) || null,
          source_tier: tierOf(rawValue),
          editable: true,
        });
        if (items.length >= ASSUMPTIONS_MAX) break;
      }
    }
  }
  const hasBudgetItem = items.some((item) => /预算/u.test(item.label));
  if (!hasBudgetItem) {
    // 优先认正文里的最新总预算（重算后的新版可能已改过），正文没有再回退任务书/追问里老板确认的预算。
    const explicitBudget =
      extractExplicitBudgetFromText(rawMarkdown) ||
      extractExplicitBudgetFromText(requirement);
    if (explicitBudget) {
      items.unshift({
        key: "活动预算",
        label: "活动预算",
        value: explicitBudget.value,
        unit: explicitBudget.unit,
        impact: "总预算调整后，同步重算各预算分项、合计金额及受影响的物料/赠品数量",
        source_tier: "A",
        editable: true,
      });
      if (items.length > ASSUMPTIONS_MAX) items.length = ASSUMPTIONS_MAX;
    }
  }
  return items;
}

/**
 * 老板改了哪些假设 → 结构化重算指令。只接受报告里真实存在的 key；值不变的忽略。
 * @returns {{instruction: string, applied: {key,label,from,to}[]}}
 */
export function buildAssumptionChangeInstruction(assumptions = [], changes = []) {
  const byKey = new Map((Array.isArray(assumptions) ? assumptions : []).map((item) => [item.key, item]));
  const applied = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    const item = byKey.get(String(change?.key || ""));
    if (!item) continue;
    const to = clean(change?.value).replace(/[\r\n|]/gu, " ");
    if (!to || to === item.value) continue;
    if (applied.some((entry) => entry.key === item.key)) continue;
    applied.push({ key: item.key, label: item.label, from: item.value, to });
  }
  if (!applied.length) return { instruction: "", applied };
  const hasBudgetChange = applied.some((entry) => /预算/u.test(entry.label));
  const instruction = [
    `【按新假设重算】${applied.map((entry) => `${entry.label}：${entry.from} → ${entry.to}`).join("；")}。`,
    "不重新检索、不新增任何外部事实；只重算和改写受这些假设影响的数字、拆分、清单与结论（例如预算分项、合计、物料/赠品数量、目标测算、回本/ROI），无关段落逐字保留。",
    hasBudgetChange
      ? "必须逐项核对预算拆分表及标题中的总预算数字，确保各分项金额相加严格等于合计且不超过新预算，并同步调整受影响的赠品/物料份数。"
      : "",
    "同步更新文末“## 可改的假设”表格里的对应取值（若原表缺少该行则补入该行并填新值）；在【本次修改摘要】里逐条列出变化前后的关键数字与数量。",
  ]
    .filter(Boolean)
    .join("");
  return { instruction: instruction.slice(0, 1200), applied };
}
