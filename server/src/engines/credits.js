import { q, getConfig, setConfig, tenantOf, db, getTenant, runWithTenant, curTenant } from '../db.js';
import { textModelFor, routing } from './yunwu.js';
import { notify } from '../util.js';
import {
  AI_SALES_VIDEO_DURATION_SECONDS,
  AI_SALES_VIDEO_SEGMENT_COUNT,
  AI_SALES_VIDEO_SEGMENT_SECONDS,
} from './ai-sales-video.js';
import { publish } from './event-bus.js';

// 余额变动后推送（与前端顶栏 credits-updated 同语义）；发布失败绝不影响账务结果。
function publishCreditsUpdated(tenantId, balance, reason) {
  try {
    publish({
      tenantId,
      all: true,
      type: 'credits.updated',
      payload: { balance: Number(balance), reason },
    });
  } catch (error) {
    console.error('[credits] 实时事件发布失败:', error?.message || error);
  }
}

// ===== 积分计费引擎（PRD V2 §23）=====
// 定价基准（元）：文本按 元/百万token；图片按 元/张；视频按 元/条。1积分 = creditYuan 元。
// 扣减公式：credits = ceil( 成本(元) × marginMultiplier ÷ creditYuan )，模板模式扣0分。
//
// 毛利系数（唯一权威常量）。2026-09-03 老板决策：售价 = 中转站成本 × 2（1.5 → 2.0）。
// 价目表保留中转站 default 分组的真实成本口径，不在价目里叠加毛利；所有计价路径
// （文本 token、图片、视频、vision、embedding、TTS/语音、数字人、文生视频成片按成本换算、对账重算、
// 权益换算 estimateCreditEquivalents）都经 billing().marginMultiplier 读取本值，后台 billing 配置可覆盖。
export const CREDIT_MARGIN_FACTOR = 2.0;
export const DEFAULT_CREDIT_YUAN = 0.01;
// 调用前最低余额预检下限，用"供应商成本（元）"表达，积分数随毛利系数自动跟随：
// 1.5 时为 text 5 / image 120 / video 1200 分（历史写死值），2.0 时为 6 / 160 / 1600 分。
const MIN_BALANCE_COST_YUAN = { text: 0.03, image: 0.8, video: 8 };
const minBalanceFrom = (margin = CREDIT_MARGIN_FACTOR, creditYuan = DEFAULT_CREDIT_YUAN) => Object.fromEntries(
  Object.entries(MIN_BALANCE_COST_YUAN).map(([kind, yuan]) => [kind, Math.ceil((yuan * margin) / creditYuan)]),
);
const DEFAULT_BILLING = {
  creditYuan: DEFAULT_CREDIT_YUAN,        // 1积分 = 1分钱
  marginMultiplier: CREDIT_MARGIN_FACTOR, // 毛利系数：售价 = 中转站成本 × 2（2026-09-03 老板决策）
  text: {
    // 文本价目核验于 2026-09-03，来源：中转站公开价目 https://yunwu.ai/api/pricing（无需 Key）。
    // 该网关按 new-api 口径计价：输入 $/百万token = model_ratio × 2 × group_ratio，输出 = 输入 × completion_ratio；
    // 下列数字取 default 分组（group_ratio=1），按 ¥7.2/$ 折算（与 claude-opus-4-8 条目同一汇率口径）。
    // 若老板账号实际分组倍率 ≠ 1 或充值汇率 ≠ 7.2，请在后台 billing 配置覆盖，不要改这里。
    // gpt-5.5：model_ratio 2.5 / completion_ratio 6 → $5 / $30 → ¥36 / ¥216（旧值 30/60，输出侧少收 3.6 倍）
    'gpt-5.5': { in: 36, out: 216 },
    // gemini-3.1-flash-lite：0.125 / 6 → $0.25 / $1.5 → ¥1.8 / ¥10.8（旧值 2.5/7.5）。注意该模型不在 default 分组。
    'gemini-3.1-flash-lite': { in: 1.8, out: 10.8 },
    // deepseek-v4-flash：1.5 / 3 → $3 / $9 → ¥21.6 / ¥64.8（旧值 5/5，输入少收 4.3 倍、输出少收 13 倍）
    'deepseek-v4-flash': { in: 21.6, out: 64.8 },
    // AI-H4：Claude 备用通道模型必须有独立价目——官方 $5/$25 每百万 token 折算人民币约 36/180 元。
    // 此前缺条目落到 default 30/30，输出侧少收 6 倍（180 vs 30），备用通道一开就亏损。
    // 2026-09-03 复核：中转站 model_ratio 2.5 / completion_ratio 5 与本条一致，不改。
    'claude-opus-4-8': { in: 36, out: 180 },
    default: { in: 30, out: 30 },
  },
  image: {
    // gpt-image-2 核验于 2026-09-03（同上来源）：中转站按 token 计价 model_ratio 2.5 / completion_ratio 6
    // → 输出图像 token $30/百万；1024×1024 高质量（auto 默认档）≈ 4160 token ≈ $0.125 ≈ ¥0.90，
    // 与按次计价的 gpt-image-2-c $0.12 ≈ ¥0.86 互相印证。本地 generateImage 未传 quality，按 auto/高档取 ¥0.90。
    // 若中转站扣费日志证明实际走 medium 档（≈¥0.23），请在后台 billing.image 覆盖。旧值 0.5。
    'gpt-image-2': 0.9,
    default: 0.5,
  },
  video: {
    // MiniMax Paygo 价目核验于 2026-09-01：Hailuo 02 / 2.3 768P、10秒
    // $0.56，按当日 USD/CNY 6.7809 折算为 ¥3.7973，本地单段成本取 ¥3.80。
    // AI带货员会把30秒任务拆为3个10秒真实供应商任务。
    // 2026-09-03 复核：中转站 /api/pricing 对 Hailuo 只给 model_price $0.016/次且未标时长/分辩率倍率，
    // 单位不可靠，无法直接对比；保留 MiniMax 官方价作为成本上界，待老板从中转站扣费日志核出单段实扣后再调。
    'MiniMax-Hailuo-02': 3.8,
    'MiniMax-Hailuo-2.3': 3.8,
    'runninghub-avatar-15': 12,
    'runninghub-avatar-30': 12,
    'runninghub-avatar-60': 24,
    'heygen-avatar-15': 12,
    'heygen-avatar-30': 12,
    'heygen-avatar-60': 24,
    'kling-avatar-15': 16,
    'kling-avatar-30': 16,
    'kling-avatar-60': 32,
    'avatar-auto-15': 16,
    'avatar-auto-30': 16,
    'avatar-auto-60': 32,
    'kling-video': 14,
    'kling-omni-video': 20,
    'kling-avatar-image2video': 16,
    'kling-video-extend': 8,
    'kling-motion-control': 18,
    'kling-multi-elements': 18,
    'kling-effects': 16,
    'wan2.6-i2v': 12,
    'wan2.5-i2v-preview': 10,
    'happyhorse-1.0-t2v:floor': 8,
    'happyhorse-1.0-t2v:nitro': 10,
    'happyhorse-1.0-t2v:stable': 16,
    'happyhorse-1.0-t2v': 10,
    'happyhorse-1.0-i2v': 11,
    'happyhorse-1.0-r2v': 12,
    'happyhorse-1.0-video-edit': 11,
    'veo-3.0-fast-generate-001': 28,
    'veo-3.0-generate-001': 40,
    'veo-3.1-fast-generate-preview': 35,
    'veo-3.1-generate-preview': 60,
    default: 12,
  },
  tts: {
    // AI带货员独白配音（MiniMax speech-2.8-hd 经云雾 /minimax/v1/t2a_v2）。
    // 取云雾 /api/pricing 的按次口径：model_price $0.016/次 × ¥7.2/$ ≈ ¥0.115/次，向上取 ¥0.12/次（元/次）。
    // 未取 MiniMax 官方 ¥3.5/万字符口径：30 秒脚本≈120 字≈¥0.04，低于中转站按次实扣，会少收；按次价是成本上界。
    // 单位是“元/次调用”，不按字符；老板从云雾扣费日志核出实扣后可在后台 billing.tts 覆盖。
    'speech-2.8-hd': 0.12,
    default: 0.12,
  },
  minBalance: minBalanceFrom(),  // 调用前最低余额预检（积分），由 MIN_BALANCE_COST_YUAN × 毛利系数推导
};
export function billing() {
  const cfg = getConfig('billing', {}) || {};
  return {
    ...DEFAULT_BILLING,
    ...cfg,
    text: { ...DEFAULT_BILLING.text, ...(cfg.text || {}) },
    image: { ...DEFAULT_BILLING.image, ...(cfg.image || {}) },
    video: { ...DEFAULT_BILLING.video, ...(cfg.video || {}) },
    tts: { ...DEFAULT_BILLING.tts, ...(cfg.tts || {}) },
    minBalance: { ...DEFAULT_BILLING.minBalance, ...(cfg.minBalance || {}) },
  };
}

// ===== TTS（元/次）计价：AI带货员独白配音；hold 时按最多调用次数占扣，settle 按实际调用次数实扣 =====
export function ttsUnitCostYuan(model, b = billing()) {
  const table = b.tts || DEFAULT_BILLING.tts;
  const price = Number(table[model] ?? table.default);
  return Number.isFinite(price) && price > 0 ? price : Number(DEFAULT_BILLING.tts.default);
}
export function estimateTtsCredits({ model, calls = 1, b = billing() } = {}) {
  const count = Math.max(0, Math.ceil(Number(calls) || 0));
  if (!count) return 0;
  const yuan = ttsUnitCostYuan(model, b) * count;
  return Math.max(1, Math.ceil((yuan * b.marginMultiplier) / b.creditYuan));
}

// 积分池在租户层：企业内所有账号共享同一池（按 userId → tenant_id 解析）
export function balanceOf(userId) {
  const tid = tenantOf(userId);
  if (!tid) return 0;
  return q.get('SELECT credits FROM tenants WHERE id = ?', tid)?.credits ?? 0;
}
export function balanceOfTenant(tenantId) {
  return q.get('SELECT credits FROM tenants WHERE id = ?', tenantId)?.credits ?? 0;
}

// 单次调用积分上限估算（文本按最坏情况：输入4000 + 输出2000 tokens；图/视频按单价）
// 预检阈值 = max(全局下限, 该角色模型的单次上限估算)，杜绝"老板11分穿透5分阈值"类坏账
export function estimateMaxCredits(kind, model, b = billing()) {
  if (kind === 'text') {
    const p = b.text[model] || b.text.default;
    const yuan = (4000 * p.in + 2000 * p.out) / 1e6;
    return Math.ceil((yuan * b.marginMultiplier) / b.creditYuan);
  }
  const price = kind === 'image' ? (b.image[model] ?? b.image.default) : (b.video[model] ?? b.video.default);
  return Math.ceil((price * b.marginMultiplier) / b.creditYuan);
}

// ===== 积分权益可视化（A3）：从价目表反算"N 积分约等于多少产出"，销售话术必须与此同源 =====
// 典型文本任务口径：一次调用 = 输入 2k + 输出 1k token（员工日常问答/文案量级）。
// 视频口径：沿用 AI 带货员 30 秒成片 = 3 段 × 10 秒真实供应商任务（ai-sales-video.js 常量）。
export const EQUIVALENT_TEXT_INPUT_TOKENS = 2000;
export const EQUIVALENT_TEXT_OUTPUT_TOKENS = 1000;
// AI 带货员路由未配置时的默认视频模型（与 routes/content.js /ai-sales-video 的回退值一致）
export const EQUIVALENT_DEFAULT_VIDEO_MODEL = 'MiniMax-Hailuo-2.3';

// 默认换算模型：文本取员工级路由模型（日常调用量最大的角色），图片取路由默认图模型，
// 视频取 AI 带货员当前配置/默认模型。可通过 models 参数覆盖，便于测试与"按老板模型"对比。
export function defaultEquivalentModels() {
  const r = routing();
  const salesVideo = getConfig('ai_sales_video', {}) || {};
  return {
    text: r.text?.sales || r.text?.default || 'default',
    image: r.image || 'default',
    video: String(salesVideo.model || EQUIVALENT_DEFAULT_VIDEO_MODEL),
  };
}

// 真实流水口径（2026-09-03 老板要求"按中转站实际消耗换算"）：本租户已结算（ai_mode='api'）且有正 token 的
// 该模型文本调用达到 EQUIVALENT_OBSERVED_MIN_CALLS 条时，文本任务的 token 假设改用其均值（basis='observed'）；
// 样本不足回落到 2k+1k（basis='price_table'）。只统计 token 数与次数，不读正文/用户。
// 参照：2026-07-31 真实云验收 8 次成功调用（docs/升级迭代报告-2026-07/evidence-real-api-2026-07-31.json）
// 员工级 deepseek-v4-flash 3 次均值 ≈ 1310 in / 880 out，与 2k+1k 同量级；老板级 gpt-5.5 派活/岗位产出 3 次均值 ≈ 9545 in / 6200 out。
export const EQUIVALENT_OBSERVED_MIN_CALLS = 5;
export function observedTextSample(model, { tenantId = curTenant(), minCalls = EQUIVALENT_OBSERVED_MIN_CALLS } = {}) {
  const tid = Number(tenantId);
  const m = String(model || '').trim();
  if (!Number.isInteger(tid) || tid <= 0 || !m) return null;
  const row = q.get(`SELECT COUNT(*) calls, AVG(l.input_tokens) avg_in, AVG(l.output_tokens) avg_out,
      MIN(l.created_at) from_at, MAX(l.created_at) to_at
    FROM credit_logs l
    WHERE l.tenant_id = ? AND l.kind = 'text' AND l.ai_mode = 'api' AND l.model = ?
      AND (COALESCE(l.input_tokens,0) + COALESCE(l.output_tokens,0)) > 0`, tid, m);
  const calls = Number(row?.calls || 0);
  if (calls < Math.max(1, Number(minCalls) || 1)) return null;
  return {
    model: m,
    calls,
    avgTokens: { input: Math.round(Number(row.avg_in) || 0), output: Math.round(Number(row.avg_out) || 0) },
    from: row.from_at ? String(row.from_at).slice(0, 10) : null,
    to: row.to_at ? String(row.to_at).slice(0, 10) : null,
  };
}

export function estimateCreditEquivalents(credits, {
  b = billing(),
  models = defaultEquivalentModels(),
  tenantId = curTenant(),
  observed = observedTextSample(models.text, { tenantId }),
} = {}) {
  const total = Math.max(0, Math.floor(Number(credits) || 0));
  const toCredits = (yuan) => Math.max(1, Math.ceil((yuan * b.marginMultiplier) / b.creditYuan));
  const round4 = (n) => Math.round(n * 10000) / 10000;
  const sample = observed && Number(observed.calls) > 0 ? observed : null;
  const basis = sample ? 'observed' : 'price_table';
  const textInputTokens = sample ? sample.avgTokens.input : EQUIVALENT_TEXT_INPUT_TOKENS;
  const textOutputTokens = sample ? sample.avgTokens.output : EQUIVALENT_TEXT_OUTPUT_TOKENS;
  const textPrice = b.text[models.text] || b.text.default;
  const textYuan = (textInputTokens * textPrice.in + textOutputTokens * textPrice.out) / 1e6;
  const imageYuan = b.image[models.image] ?? b.image.default;
  const segmentYuan = b.video[models.video] ?? b.video.default;
  const videoYuan = segmentYuan * AI_SALES_VIDEO_SEGMENT_COUNT;
  const unit = {
    textTaskCredits: toCredits(textYuan),
    imageCredits: toCredits(imageYuan),
    videoCredits: toCredits(videoYuan),
    // 每单位的供应商成本（元，价目表口径），供前端"≈ ¥X 成本"小字与销售对账
    textTaskCostYuan: round4(textYuan),
    imageCostYuan: round4(imageYuan),
    videoCostYuan: round4(videoYuan),
  };
  return {
    credits: total,
    images: Math.floor(total / unit.imageCredits),
    videos: Math.floor(total / unit.videoCredits),
    textTasks: Math.floor(total / unit.textTaskCredits),
    unit,
    // N 积分对应的理论供应商成本：credits × creditYuan ÷ marginMultiplier（系数 2.0 时 6 万积分 → ¥300）
    supplierCostYuan: Math.round((total * b.creditYuan) / b.marginMultiplier * 100) / 100,
    marginFactor: b.marginMultiplier,
    basis,
    observedSample: sample,
    models: { ...models },
    assumptions: {
      creditYuan: b.creditYuan,
      marginMultiplier: b.marginMultiplier,
      formula: 'credits = ceil(成本元 × marginMultiplier ÷ creditYuan)',
      // 面向老板/销售的口径文案，随系数常量变化，前端不得写死倍数
      marginLabel: `售价 = 中转站成本 × ${b.marginMultiplier}（1 积分 = ¥${b.creditYuan}）`,
      basis,
      text: {
        model: models.text,
        basis,
        inputTokens: textInputTokens,
        outputTokens: textOutputTokens,
        pricePerMillion: { in: textPrice.in, out: textPrice.out },
        costYuan: round4(textYuan),
        label: sample
          ? `一次典型文本任务 = 输入 ${textInputTokens} + 输出 ${textOutputTokens} token（${models.text}，本企业 ${sample.calls} 次真实调用均值）`
          : `一次典型文本任务 = 输入 ${textInputTokens} + 输出 ${textOutputTokens} token（${models.text}）`,
      },
      image: {
        model: models.image,
        costYuan: imageYuan,
        label: `一张图 = ${models.image} 单张成本 ¥${imageYuan}`,
      },
      video: {
        model: models.video,
        durationSeconds: AI_SALES_VIDEO_DURATION_SECONDS,
        segmentCount: AI_SALES_VIDEO_SEGMENT_COUNT,
        segmentSeconds: AI_SALES_VIDEO_SEGMENT_SECONDS,
        segmentCostYuan: segmentYuan,
        costYuan: Math.round(videoYuan * 100) / 100,
        label: `一条 ${AI_SALES_VIDEO_DURATION_SECONDS} 秒视频 = ${AI_SALES_VIDEO_SEGMENT_COUNT} 段 × ${AI_SALES_VIDEO_SEGMENT_SECONDS} 秒（${models.video}，每段 ¥${segmentYuan}）`,
      },
    },
  };
}

// ===== 租户月度 AI 积分预算（2026-09-02 宣讲会承诺；本轮租户级）=====
// 口径：本自然月（上海时区）内 credit_logs 里的"AI 消耗"流水 = 已结算实扣（api/template）+ 在途占扣（hold），
// 排除 recharge/bonus 等入账与管理调整流水（它们的 credits 为负或 ai_mode 非消耗）。
// 只拦 AI 消耗（precheck / holdCredits 的 text|image|video）；执行授权等安全动作不经此处，不受预算影响。
export const BUDGET_EXCEEDED_CODE = 'BUDGET_EXCEEDED';
export const DEFAULT_BUDGET_ALERT_RATIO = 0.8;
const aiConsumptionSql = (alias = '') => `${alias}credits > 0 AND COALESCE(${alias}ai_mode,'') NOT IN ('recharge','bonus')`;
const AI_CONSUMPTION_SQL = aiConsumptionSql();
const SHANGHAI_TZ = 'Asia/Shanghai';

function shanghaiParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(now)).map(p => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}
// 本自然月区间（上海时区）：[from, to) 与 credit_logs.created_at（本地 'YYYY-MM-DD HH:MM:SS'）字符串比较。
export function shanghaiMonthRange(now = new Date()) {
  const { year, month, day } = shanghaiParts(now);
  const pad = (n) => String(n).padStart(2, '0');
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    month: `${year}-${pad(month)}`,
    date: `${year}-${pad(month)}-${pad(day)}`,
    from: `${year}-${pad(month)}-01`,
    to: `${nextYear}-${pad(nextMonth)}-01`,
    daysInMonth,
    dayOfMonth: day,
  };
}

export function tenantMonthlyUsage(tenantId, now = new Date()) {
  const tid = Number(tenantId);
  const range = shanghaiMonthRange(now);
  const row = q.get(`SELECT
      COALESCE(SUM(CASE WHEN ai_mode = 'hold' THEN 0 ELSE credits END),0) settled,
      COALESCE(SUM(CASE WHEN ai_mode = 'hold' THEN credits ELSE 0 END),0) held,
      COUNT(*) calls
    FROM credit_logs
    WHERE tenant_id = ? AND ${AI_CONSUMPTION_SQL} AND created_at >= ? AND created_at < ?`,
  tid, range.from, range.to) || {};
  const settled = Number(row.settled || 0);
  const held = Number(row.held || 0);
  return { month: range.month, settled, held, used: settled + held, calls: Number(row.calls || 0), range };
}

export function budgetAlertRatioOf(tenant) {
  const ratio = Number(tenant?.budget_alert_ratio);
  return Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : DEFAULT_BUDGET_ALERT_RATIO;
}

// 预算摘要（/api/auth/me、/api/recharge/balance、后台预算面板共用）
// state：unlimited（未设预算）/ ok / alert（≥ 预警比例）/ exceeded（≥ 预算）
export function budgetSummary(tenantOrId, now = new Date()) {
  const t = typeof tenantOrId === 'object' && tenantOrId ? tenantOrId : getTenant(tenantOrId);
  if (!t) return null;
  const usage = tenantMonthlyUsage(t.id, now);
  const budget = t.monthly_credit_budget == null ? null : Math.max(0, Math.floor(Number(t.monthly_credit_budget) || 0));
  const alertRatio = budgetAlertRatioOf(t);
  const forecast = usage.range.dayOfMonth > 0
    ? Math.round((usage.used / usage.range.dayOfMonth) * usage.range.daysInMonth)
    : usage.used;
  const ratioUsed = budget ? usage.used / budget : null;
  let state = 'unlimited';
  if (budget != null) {
    if (budget === 0 || usage.used >= budget) state = 'exceeded';
    else if (ratioUsed >= alertRatio) state = 'alert';
    else state = 'ok';
  }
  return {
    month: usage.month,
    budget,
    alertRatio,
    used: usage.used,
    settled: usage.settled,
    held: usage.held,
    calls: usage.calls,
    remaining: budget == null ? null : Math.max(0, budget - usage.used),
    forecast,
    ratioUsed: ratioUsed == null ? null : Math.round(ratioUsed * 1000) / 1000,
    state,
    daysInMonth: usage.range.daysInMonth,
    dayOfMonth: usage.range.dayOfMonth,
  };
}

function budgetExceededError(summary, estimate) {
  const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');
  const err = new Error(
    `本月 AI 预算 ${fmt(summary.budget)} 积分已用 ${fmt(summary.used)}，本次约需 ${fmt(estimate)}；请老板在后台调整预算`,
  );
  return Object.assign(err, {
    status: 402,
    code: BUDGET_EXCEEDED_CODE,
    retryable: false,
    retryHint: '本月 AI 预算已用完，请老板到管理后台「积分管理」调高预算或等下月额度恢复。',
    budget: {
      month: summary.month, budget: summary.budget, used: summary.used, remaining: summary.remaining, estimate,
    },
  });
}

function isBudgetExempt(userId) {
  if (userId == null) return false;
  const row = q.get('SELECT role FROM users WHERE id = ?', userId);
  return row?.role === 'platform_super';
}

function claimBudgetAlertOnce(tid, key) {
  return q.run('INSERT OR IGNORE INTO scheduled_runs(tenant_id,job_key) VALUES(?,?)', tid, key).changes > 0;
}

// 达到预警比例 → 当天首次触发时给本企业老板发一条站内通知（scheduled_runs 幂等，同 plan.js 口径）。
// 通知失败绝不影响计费主流程。
export function maybeSendBudgetAlert(tenantId, summary = budgetSummary(tenantId)) {
  if (!summary || summary.budget == null || (summary.state !== 'alert' && summary.state !== 'exceeded')) return false;
  const tid = Number(tenantId);
  const range = shanghaiMonthRange();
  const key = `credit-budget-alert:${range.date}`;
  try {
    if (!claimBudgetAlertOnce(tid, key)) return false;
    const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');
    const percent = Math.round((summary.ratioUsed || 0) * 100);
    const title = summary.state === 'exceeded'
      ? `本月 AI 预算 ${fmt(summary.budget)} 积分已用完`
      : `本月 AI 预算已用 ${percent}%`;
    const body = summary.state === 'exceeded'
      ? `本月已消耗 ${fmt(summary.used)} 积分，AI 员工将暂停新任务；请到管理后台「积分管理」调整预算或等下月恢复。`
      : `本月已消耗 ${fmt(summary.used)} / ${fmt(summary.budget)} 积分（预警线 ${Math.round(summary.alertRatio * 100)}%），按当前速度月底约需 ${fmt(summary.forecast)} 积分。`;
    runWithTenant(tid, () => {
      for (const u of q.all(`SELECT id FROM users WHERE tenant_id = ? AND status = '启用' AND role = 'boss' ORDER BY id`, tid)) {
        notify(u.id, 'credits', title, body, '/admin');
      }
    });
    return true;
  } catch (e) {
    console.warn('[credits] 预算预警通知发送失败：', e?.message || e);
    return false;
  }
}

// 预算门：已用（已结算 + 在途）+ 本次预估 > 预算 → 402 BUDGET_EXCEEDED；未设预算/平台超管直接放行。
// 达到预警线（含已超）时顺带触发当天首次预警通知。请在事务外调用：通知与幂等占位不应随业务回滚。
export function assertWithinBudget({ tenantId, userId = null, estimate = 0, now = new Date() }) {
  const t = getTenant(tenantId);
  if (!t || t.monthly_credit_budget == null) return null;
  if (isBudgetExempt(userId)) return null;
  const summary = budgetSummary(t, now);
  maybeSendBudgetAlert(t.id, summary);
  const need = Math.max(0, Math.ceil(Number(estimate) || 0));
  if (summary.used + need > summary.budget) throw budgetExceededError(summary, need);
  return summary;
}

// ===== 按人月度配额（预留）：只读取与统计，precheck 记录 quotaState 不拦截 =====
// 按人强制拦截为后续版本，见建议清单 B1。
export function getUserMonthlyUsage(userId, now = new Date()) {
  const uid = Number(userId);
  const u = q.get('SELECT id, tenant_id, monthly_credit_quota FROM users WHERE id = ?', uid);
  if (!u) return null;
  const range = shanghaiMonthRange(now);
  const row = q.get(`SELECT COALESCE(SUM(credits),0) used, COUNT(*) calls FROM credit_logs
    WHERE tenant_id = ? AND user_id = ? AND ${AI_CONSUMPTION_SQL} AND created_at >= ? AND created_at < ?`,
  u.tenant_id, uid, range.from, range.to) || {};
  const quota = u.monthly_credit_quota == null ? null : Math.max(0, Math.floor(Number(u.monthly_credit_quota) || 0));
  const used = Number(row.used || 0);
  return {
    userId: uid,
    month: range.month,
    quota,
    used,
    calls: Number(row.calls || 0),
    remaining: quota == null ? null : Math.max(0, quota - used),
    quotaState: quota != null && used >= quota ? 'exceeded' : 'within',
  };
}

// ===== 用量报表（后台 GET /api/admin/credits/usage）=====
// 基于 credit_logs 的 AI 消耗流水（含在途 hold）聚合；recharge/bonus 入账与管理调整一律排除。
// groupBy：day 按日 / user 按发起账号 / model 按模型 / feature 按功能全名 / employee 按"功能·对象"里的对象（数字员工名等）。
export const USAGE_GROUP_BY = Object.freeze(['day', 'employee', 'user', 'model', 'feature']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function usageReport({ tenantId, from, to, groupBy = 'day', now = new Date(), limit = 200 } = {}) {
  const tid = Number(tenantId);
  if (!Number.isInteger(tid) || tid <= 0) throw Object.assign(new Error('租户不正确'), { status: 400 });
  const key = USAGE_GROUP_BY.includes(groupBy) ? groupBy : null;
  if (!key) throw Object.assign(new Error(`groupBy 只支持 ${USAGE_GROUP_BY.join('|')}`), { status: 400 });
  const range = shanghaiMonthRange(now);
  const fromDate = DATE_RE.test(String(from || '')) ? String(from) : range.from;
  const monthEnd = `${range.month}-${String(range.daysInMonth).padStart(2, '0')}`;
  const toDate = DATE_RE.test(String(to || '')) ? String(to) : monthEnd;
  if (fromDate > toDate) throw Object.assign(new Error('开始日期不能晚于结束日期'), { status: 400 });
  const groupExpr = {
    day: 'date(l.created_at)',
    user: 'l.user_id',
    model: "COALESCE(NULLIF(l.model,''),'（未记录）')",
    feature: "COALESCE(NULLIF(l.feature,''),'（未记录）')",
    employee: "CASE WHEN instr(COALESCE(l.feature,''),'·') > 0 THEN substr(l.feature, instr(l.feature,'·') + 1) ELSE COALESCE(NULLIF(l.feature,''),'（未记录）') END",
  }[key];
  // 显式写 l.tenant_id（不藏进变量），让 scripts/check-isolation.mjs 能静态确认隔离
  const where = `${aiConsumptionSql('l.')} AND date(l.created_at) >= ? AND date(l.created_at) <= ?`;
  const params = [tid, fromDate, toDate];
  const cy = billing().creditYuan;
  const rows = q.all(`SELECT ${groupExpr} g,
      COUNT(*) n,
      COALESCE(SUM(l.credits),0) credits,
      COALESCE(SUM(CASE WHEN l.ai_mode = 'hold' THEN l.credits ELSE 0 END),0) held_credits,
      COALESCE(SUM(l.input_tokens),0) input_tokens,
      COALESCE(SUM(l.output_tokens),0) output_tokens,
      COALESCE(SUM(l.cost_yuan),0) cost_yuan
      ${key === 'user' ? ', (SELECT u.name FROM users u WHERE u.id = l.user_id) user_name' : ''}
    FROM credit_logs l WHERE l.tenant_id = ? AND ${where}
    GROUP BY g ORDER BY ${key === 'day' ? 'g ASC' : 'credits DESC'} LIMIT ?`, ...params, Math.max(1, Math.min(1000, Number(limit) || 200)));
  const total = q.get(`SELECT COUNT(*) n, COALESCE(SUM(l.credits),0) credits,
      COALESCE(SUM(CASE WHEN l.ai_mode = 'hold' THEN l.credits ELSE 0 END),0) held_credits,
      COALESCE(SUM(l.input_tokens),0) input_tokens, COALESCE(SUM(l.output_tokens),0) output_tokens,
      COALESCE(SUM(l.cost_yuan),0) cost_yuan
    FROM credit_logs l WHERE l.tenant_id = ? AND ${where}`, ...params) || {};
  const shape = (r) => ({
    key: r.g == null ? '' : String(r.g),
    label: key === 'user' ? (r.user_name || `账号#${r.g}`) : (r.g == null ? '' : String(r.g)),
    calls: Number(r.n || 0),
    credits: Number(r.credits || 0),
    heldCredits: Number(r.held_credits || 0),
    inputTokens: Number(r.input_tokens || 0),
    outputTokens: Number(r.output_tokens || 0),
    tokens: Number(r.input_tokens || 0) + Number(r.output_tokens || 0),
    costYuan: Math.round(Number(r.cost_yuan || 0) * 10000) / 10000,
    spendYuan: Math.round(Number(r.credits || 0) * cy * 100) / 100,
  });
  return {
    from: fromDate,
    to: toDate,
    groupBy: key,
    rows: rows.map(shape),
    total: shape({ ...total, g: 'total' }),
    budget: budgetSummary(tid, now),
  };
}

// 调用前预检：余额 < 单次上限估算 → 402拦截（不发起外部API调用，从源头杜绝坏账）
// 返回值保持为余额数字（兼容既有调用方）；需要预算/配额明细请用 precheckDetailed。
export function precheck(userId, kind, model) {
  return precheckDetailed(userId, kind, model).balance;
}
export function precheckDetailed(userId, kind, model) {
  const b = billing();
  const floor = b.minBalance[kind] ?? 5;
  const need = Math.max(floor, model ? estimateMaxCredits(kind, model, b) : floor);
  const bal = balanceOf(userId);
  if (bal < need) {
    const err = new Error(`积分余额不足：当前 ${bal} 分，本次${kind === 'text' ? '文本生成' : kind === 'image' ? '图片生成' : '视频生成'}预估最高需 ${need} 分。请联系管理员充值。`);
    err.status = 402;
    throw err;
  }
  const tid = tenantOf(userId);
  const budget = tid ? assertWithinBudget({ tenantId: tid, userId, estimate: model ? estimateMaxCredits(kind, model, b) : 0 }) : null;
  // 按人配额：只记录状态供前端提示，不拦截（B1 后续版本）
  const quota = getUserMonthlyUsage(userId);
  return { balance: bal, budget, quotaState: quota?.quotaState ?? 'within', quota };
}

// 文本类预检的便捷封装：按发起者角色路由模型后做单次上限估算
export function precheckByRole(userId, kind, role) {
  return precheck(userId, kind, kind === 'text' ? textModelFor(role) : undefined);
}

function costYuan(kind, model, usage, b = billing()) {
  if (kind === 'text') {
    const p = b.text[model] || b.text.default;
    return ((usage.inputTokens || 0) * p.in + (usage.outputTokens || 0) * p.out) / 1e6;
  }
  if (kind === 'image') return b.image[model] ?? b.image.default;
  if (kind === 'video') return b.video[model] ?? b.video.default;
  return 0;
}

// 实扣 + 流水（aiMode='template' 时记0分流水，保留审计）
// 原子扣减：余额条件与扣减放在同一条 UPDATE 中，避免并发请求把企业积分池扣成负数。
export function charge({ userId, feature, kind, model, usage = {}, aiMode = 'api', note = '', manageTransaction = true }) {
  const b = billing();
  const tid = tenantOf(userId);
  if (!tid) throw Object.assign(new Error('计费账号不存在'), { status: 404 });
  const yuan = aiMode === 'api' ? costYuan(kind, model, usage, b) : 0;
  const credits = aiMode === 'api' ? Math.ceil((yuan * b.marginMultiplier) / b.creditYuan) : 0;
  if (manageTransaction) db.exec('BEGIN IMMEDIATE');
  let after;
  try {
    const changed = q.run('UPDATE tenants SET credits = credits - ? WHERE id = ? AND credits >= ?', credits, tid, credits);
    if (!changed.changes) {
      const balance = balanceOfTenant(tid);
      throw Object.assign(new Error(`积分余额不足：当前 ${balance} 分，本次实际需 ${credits} 分。请联系管理员充值。`), { status: 402 });
    }
    after = q.get('SELECT credits FROM tenants WHERE id = ?', tid)?.credits ?? 0;
    q.run(`INSERT INTO credit_logs(tenant_id,user_id,feature,kind,model,input_tokens,output_tokens,cost_yuan,credits,balance_after,ai_mode,note)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      tid, userId, feature, kind, model || '', usage.inputTokens || 0, usage.outputTokens || 0,
      Math.round(yuan * 10000) / 10000, credits, after, aiMode, note);
    if (manageTransaction) db.exec('COMMIT');
  } catch (e) {
    if (manageTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    }
    throw e;
  }
  publishCreditsUpdated(tid, after, 'charge');
  return { credits, balance: after, costYuan: Math.round(yuan * 100) / 100 };
}

// 租户积分池入账/调整（充值确认、管理员补偿）：正数入账，负数扣减；统一记流水保证对账
// kind/aiMode 默认 'recharge'（购买积分）；套餐赠送积分传 'bonus'，流水上与购买积分区分开。
export function creditTenant({ tenantId, delta, userId = null, feature, note = '', manageTransaction = true, kind = 'recharge', aiMode = 'recharge' }) {
  const tid = Number(tenantId);
  const amount = Number(delta);
  if (!Number.isInteger(tid) || tid <= 0 || !q.get('SELECT id FROM tenants WHERE id=?', tid)) {
    throw Object.assign(new Error('租户不存在'), { status: 404 });
  }
  if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000_000) {
    throw Object.assign(new Error('积分变动必须是绝对值不超过10亿的非零整数'), { status: 400 });
  }
  if (manageTransaction) db.exec('BEGIN IMMEDIATE');
  let after;
  try {
    q.run('UPDATE tenants SET credits = credits + ? WHERE id = ?', amount, tid);
    if (amount > 0) q.run('UPDATE tenants SET total_recharged = COALESCE(total_recharged,0) + ? WHERE id = ?', amount, tid);
    after = q.get('SELECT credits FROM tenants WHERE id = ?', tid)?.credits ?? 0;
    if (after < 0) throw Object.assign(new Error('积分余额不足，不能扣成负数'), { status: 409 });
    q.run(`INSERT INTO credit_logs(tenant_id,user_id,feature,kind,model,credits,balance_after,ai_mode,note)
           VALUES(?,?,?,?,?,?,?,?,?)`,
      tid, userId, feature || (amount >= 0 ? '积分充值' : '管理调整'), kind, '', -amount, after, aiMode, String(note || '').slice(0, 1000));
    if (manageTransaction) db.exec('COMMIT');
  } catch (e) {
    if (manageTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    }
    throw e;
  }
  publishCreditsUpdated(tid, after, amount >= 0 ? 'credit' : 'debit');
  return { balance: after };
}

// ===== 两段式记账：预授权占扣 → 结算多退少补（审计 BE-C1/BE-H1/BE-H2 + AI-C1）=====
// 设计：发起 AI 调用/提交异步任务前，按"实际将要发送的内容"估算保守上限并原子占扣（hold），
// 占扣即从租户池扣减并记一条流水（ai_mode='hold'），保证任意时刻 Σ流水 ≡ 余额变动 恒等；
// 调用返回后按真实用量结算：把"同一条"流水改写为实扣金额并退回差额（估算偏低时补扣），对账口径不重复。
let holdTableReady = false;
function ensureHoldTable() {
  if (holdTableReady) return;
  db.exec(`
  CREATE TABLE IF NOT EXISTS credit_holds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER,
    log_id INTEGER NOT NULL,        -- 对应 credit_logs 行：占扣与结算复用同一行，避免流水重复计入消耗
    feature TEXT, kind TEXT, model TEXT,
    held_credits INTEGER NOT NULL,
    settled_credits INTEGER,
    status TEXT DEFAULT 'held',     -- held=占扣中 / settled=已结算（含全额退回）
    ref_type TEXT, ref_id INTEGER,  -- 业务关联（如 media_job）：异步任务成功回填/失败退分用
    created_at TEXT DEFAULT (datetime('now','localtime')),
    settled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_credit_holds_ref ON credit_holds(ref_type, ref_id, status);
  `);
  holdTableReady = true;
}

// 保守估算口径：中文≈1字≈1token 取上界（宁可多占后退，绝不少占坏账）；
// overheadTokens 覆盖路由侧看不到的系统提示词+知识库(≈3000字)+实时数据摘要等固定注入。
const HOLD_OVERHEAD_TOKENS = 6000;
const HOLD_OUTPUT_TOKENS = 4000;
const textLen = (t) => {
  if (typeof t === 'string') return t.length;
  if (Array.isArray(t)) return t.reduce((n, block) => n + (typeof block?.text === 'string' ? block.text.length : 0), 0);
  return t == null ? 0 : String(t).length;
};

// BE-C1/AI-C1：按"实际将要发送的 messages+system"估算单次调用积分上限，
// 替代固定 4000in/2000out 的失真口径（大上下文会诊可达 3万+ token，固定口径低估近10倍→坏账）。
export function estimateCallCredits({ kind = 'text', model, texts = [], outputTokens = HOLD_OUTPUT_TOKENS, overheadTokens = HOLD_OVERHEAD_TOKENS, b = billing() }) {
  if (kind !== 'text') return estimateMaxCredits(kind, model, b);
  const chars = (Array.isArray(texts) ? texts : [texts]).reduce((n, t) => n + textLen(t), 0);
  const inputTokens = overheadTokens + chars;
  const p = b.text[model] || b.text.default;
  const yuan = (inputTokens * p.in + outputTokens * p.out) / 1e6;
  return Math.max(1, Math.ceil((yuan * b.marginMultiplier) / b.creditYuan));
}

const EMPLOYEE_TRANSPORT_FAILOVER_REASON = 'retryable_zero_usage_transport_failure';

function normalizedModel(value) {
  return String(value || '').trim().toLowerCase();
}

function sameEmployeeFailover(value, expected) {
  if (!value || typeof value !== 'object' || !expected) return false;
  return normalizedModel(value.from) === expected.from
    && normalizedModel(value.to) === expected.to
    && String(value.reason || '') === EMPLOYEE_TRANSPORT_FAILOVER_REASON
    && Number(value.attempt) === expected.attempt;
}

function legalEmployeeFailoverTrigger(failure) {
  if (!failure || typeof failure !== 'object') return false;
  const code = String(failure.code || '');
  const status = Number(failure.status);
  // 必须使用规范化后彼此一致的机器码与HTTP状态，不能用诸如
  // provider_request_failed + 502 的拼接证据骗过账务门。
  if (code === 'provider_timeout') {
    return status === 504 && failure.timedOut === true;
  }
  if (code === 'provider_upstream_error') {
    return (status === 502 || status === 500) && failure.timedOut !== true;
  }
  return false;
}

/**
 * 餐饮员工允许 hold(requested primary) 与 ledger(actual final) 模型不同的
 * 唯一权威门。相同模型沿用历史账务语义；不同模型则必须由持久化执行快照
 * 完整证明“主模型 acquire 阶段始终零 Token、零响应字符，最后一轮出现规范化的
 * timeout/504或upstream/502 → 下一轮固定切到备用模型 → 备用模型真实正
 * Token 成功”，并且供应商汇总用量与积分流水相等。
 * 契约失败、正 Token 响应、鉴权/限流/请求错误或任意二次换模均不能通过。
 */
export function employeeModelSettlementBindingValid({
  holdModel,
  ledgerModel,
  executionEvidence,
  ledgerUsage = {},
} = {}) {
  const requested = normalizedModel(holdModel);
  const actual = normalizedModel(ledgerModel);
  if (!requested || !actual) return false;
  if (requested === actual) return true;

  const snapshot = executionEvidence && typeof executionEvidence === 'object'
    ? executionEvidence
    : null;
  const contract = snapshot?.outputContract && typeof snapshot.outputContract === 'object'
    ? snapshot.outputContract
    : null;
  const provider = snapshot?.providerAttempt && typeof snapshot.providerAttempt === 'object'
    ? snapshot.providerAttempt
    : null;
  const budget = contract?.providerBudget && typeof contract.providerBudget === 'object'
    ? contract.providerBudget
    : null;
  const attempts = Array.isArray(contract?.providerAttempts)
    ? contract.providerAttempts
    : [];
  const transition = contract?.modelFailover && typeof contract.modelFailover === 'object'
    ? contract.modelFailover
    : null;
  const transitionAttempt = Number(transition?.attempt);
  const expectedFailover = {
    from: requested,
    to: actual,
    attempt: transitionAttempt,
  };
  if (
    contract?.valid !== true
    || normalizedModel(contract.requestedModel) !== requested
    || normalizedModel(contract.effectiveModel) !== actual
    || !Number.isSafeInteger(transitionAttempt)
    || transitionAttempt < 2
    || !sameEmployeeFailover(transition, expectedFailover)
    || normalizedModel(provider?.requestedModel) !== requested
    || normalizedModel(provider?.effectiveModel) !== actual
    || normalizedModel(provider?.model) !== actual
    || String(provider?.mode || '').trim().toLowerCase() !== 'api'
    || !sameEmployeeFailover(provider?.modelFailover, expectedFailover)
    || normalizedModel(budget?.requestedModel) !== requested
    || normalizedModel(budget?.effectiveModel) !== actual
    || !sameEmployeeFailover(budget?.modelFailover, expectedFailover)
    || attempts.length < transitionAttempt
  ) {
    return false;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let positiveActualApiAttempt = false;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index] || {};
    const number = Number(attempt.number);
    const attemptModel = normalizedModel(attempt.model);
    const effectiveModel = normalizedModel(attempt.effectiveModel);
    const usageInput = Number(attempt.usage?.inputTokens);
    const usageOutput = Number(attempt.usage?.outputTokens);
    if (
      number !== index + 1
      || normalizedModel(attempt.requestedModel) !== requested
      || !Number.isFinite(usageInput)
      || !Number.isFinite(usageOutput)
      || usageInput < 0
      || usageOutput < 0
      || attemptModel !== effectiveModel
    ) {
      return false;
    }
    inputTokens += usageInput;
    outputTokens += usageOutput;

    if (number < transitionAttempt) {
      if (
        effectiveModel !== requested
        || attempt.modelFailover != null
        || String(attempt.phase || '') !== 'acquire'
        || String(attempt.budgetClass || '') !== 'transport'
        || attempt.apiObtained === true
        || Number(attempt.receivedChars) !== 0
        || usageInput + usageOutput !== 0
        || attempt.failure?.retryable !== true
      ) {
        return false;
      }
      // 更早的503/429等可重试零Token传输尝试并不会触发切换，运行时仍可
      // 继续用首选模型；只有紧邻transition的最后一轮必须是规范的
      // timeout/504或upstream/502，且它才是切换授权事实。
      if (
        number === transitionAttempt - 1
        && !legalEmployeeFailoverTrigger(attempt.failure)
      ) {
        return false;
      }
      continue;
    }

    if (
      effectiveModel !== actual
      || !sameEmployeeFailover(attempt.modelFailover, expectedFailover)
    ) {
      return false;
    }
    if (
      String(attempt.mode || '').trim().toLowerCase() === 'api'
      && usageInput + usageOutput > 0
    ) {
      positiveActualApiAttempt = true;
    }
  }

  const ledgerInput = Number(ledgerUsage.inputTokens);
  const ledgerOutput = Number(ledgerUsage.outputTokens);
  return positiveActualApiAttempt
    && inputTokens === ledgerInput
    && outputTokens === ledgerOutput
    && Number(provider.usage?.inputTokens) === ledgerInput
    && Number(provider.usage?.outputTokens) === ledgerOutput
    && ledgerInput > 0
    && ledgerOutput > 0;
}

// 占扣（两段式第一段）：条件更新原子扣减，并发多路同时占扣不会把积分池扣成负数（不超卖）。
// 余额不足 → 402（此刻尚未开流、尚未发起外部调用，从源头杜绝"答案已交付却收不到钱"）。
export function holdCredits({
  userId,
  tenantId = null,
  feature,
  kind = 'text',
  model = '',
  credits,
  note = '',
  refType = null,
  refId = null,
}) {
  ensureHoldTable();
  const userTenantId = userId == null ? null : tenantOf(userId);
  const explicitTenantId = Number(tenantId);
  if (userId != null && !userTenantId) {
    throw Object.assign(new Error('计费账号不存在'), { status: 404 });
  }
  if (
    userTenantId
    && Number.isSafeInteger(explicitTenantId)
    && explicitTenantId > 0
    && explicitTenantId !== userTenantId
  ) {
    throw Object.assign(new Error('计费账号与目标租户不一致'), { status: 403 });
  }
  const tid = userTenantId || (
    Number.isSafeInteger(explicitTenantId)
    && explicitTenantId > 0
    && q.get('SELECT id FROM tenants WHERE id=?', explicitTenantId)
      ? explicitTenantId
      : null
  );
  if (!tid) throw Object.assign(new Error('计费账号不存在'), { status: 404 });
  // 存量 credit_logs.user_id 为 NOT NULL。系统后台任务没有直接请求人时，
  // 使用本租户老板/管理员作为审计归属，绝不借用其他租户账号。
  const billingUserId = userId ?? q.get(`SELECT id FROM users
    WHERE tenant_id=? AND status='启用'
    ORDER BY CASE role WHEN 'boss' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, id
    LIMIT 1`, tid)?.id;
  if (!billingUserId) {
    throw Object.assign(new Error('租户没有可用于后台计费归属的启用账号'), { status: 409 });
  }
  const amount = Math.max(1, Math.ceil(Number(credits) || 0));
  // 租户月度预算门（只拦 AI 消耗；未设预算/平台超管放行）。放在事务外：预警通知与幂等占位不随占扣回滚。
  if (kind === 'text' || kind === 'image' || kind === 'video') {
    assertWithinBudget({ tenantId: tid, userId: userId ?? billingUserId, estimate: amount });
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const changed = q.run('UPDATE tenants SET credits = credits - ? WHERE id = ? AND credits >= ?', amount, tid, amount);
    if (!changed.changes) {
      const balance = balanceOfTenant(tid);
      throw Object.assign(new Error(`积分余额不足：当前 ${balance} 分，本次按实际内容预估最高需 ${amount} 分。请联系管理员充值。`), { status: 402 });
    }
    const after = q.get('SELECT credits FROM tenants WHERE id = ?', tid)?.credits ?? 0;
    const logR = q.run(`INSERT INTO credit_logs(tenant_id,user_id,feature,kind,model,input_tokens,output_tokens,cost_yuan,credits,balance_after,ai_mode,note)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      tid, billingUserId, feature, kind, model || '', 0, 0, 0, amount, after, 'hold', note || '预授权占扣，结算时多退少补');
    const holdR = q.run(`INSERT INTO credit_holds(tenant_id,user_id,log_id,feature,kind,model,held_credits,ref_type,ref_id)
           VALUES(?,?,?,?,?,?,?,?,?)`, tid, billingUserId, logR.lastInsertRowid, feature, kind, model || '', amount, refType, refId);
    db.exec('COMMIT');
    publishCreditsUpdated(tid, after, 'hold');
    return { holdId: holdR.lastInsertRowid, logId: logR.lastInsertRowid, tenantId: tid, userId: billingUserId, feature, kind, model: model || '', credits: amount, balance: after };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
}

// 结算（两段式第二段）：按真实用量改写占扣流水，实扣不得超过已授权额度。
// - aiMode='template' → 全额退回（保留 0 分流水审计）
// - 真实 API 文本无有效 token 证据 → 失败关闭，hold 保持 held 待查，不得落成“实扣0分”
// - credits 显式传入时按传入值实扣（视频按提交时报价结算，防止结算窗口内价格变动）
// - 实扣 > 占扣（估算偏低）→ 失败关闭：hold 保持 held，由业务层转待对账，不追加未授权扣款
// - 幂等：同一笔占扣只能结算一次，重复结算/释放返回 null 不动账
function holdIntegrityMismatch(field) {
  return Object.assign(
    new Error(`预授权占扣完整性校验失败：${field} 与数据库权威记录不一致`),
    { status: 409, code: 'CREDIT_HOLD_INTEGRITY_MISMATCH' },
  );
}

function holdExceeded() {
  return Object.assign(
    new Error('实际结算金额超过预授权额度，未追加扣款，已保留占扣待账务对账'),
    { status: 409, code: 'BILLING_HOLD_EXCEEDED', retryable: false },
  );
}

function billingUsageMissing() {
  return Object.assign(
    new Error('真实 API 文本交付缺少可结算的有效 token 用量，未完成结算，已保留预授权待核对'),
    { status: 409, code: 'BILLING_USAGE_MISSING', retryable: false },
  );
}

function assertPositiveApiTextUsage(row, { usage, aiMode, fixedCredits }) {
  if (String(row?.kind || '') !== 'text' || aiMode !== 'api' || fixedCredits != null) return;
  const source = usage && typeof usage === 'object' ? usage : null;
  const hasInput = source
    && Object.prototype.hasOwnProperty.call(source, 'inputTokens')
    && source.inputTokens !== null
    && source.inputTokens !== '';
  const hasOutput = source
    && Object.prototype.hasOwnProperty.call(source, 'outputTokens')
    && source.outputTokens !== null
    && source.outputTokens !== '';
  const inputTokens = Number(source?.inputTokens);
  const outputTokens = Number(source?.outputTokens);
  if (!hasInput || !hasOutput
    || !Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)
    || inputTokens < 0 || outputTokens < 0
    || inputTokens + outputTokens <= 0) {
    throw billingUsageMissing();
  }
}

function assertSuppliedHoldMatches(row, supplied) {
  const numericFields = [
    ['tenantId', 'tenant_id'],
    ['logId', 'log_id'],
    ['userId', 'user_id'],
    ['credits', 'held_credits'],
  ];
  for (const [inputKey, rowKey] of numericFields) {
    if (!Object.prototype.hasOwnProperty.call(supplied, inputKey)) continue;
    const inputValue = supplied[inputKey];
    const rowValue = row[rowKey];
    if (inputValue == null && rowValue == null) continue;
    if (Number(inputValue) !== Number(rowValue)) throw holdIntegrityMismatch(inputKey);
  }
  if (
    Object.prototype.hasOwnProperty.call(supplied, 'kind')
    && String(supplied.kind ?? '') !== String(row.kind ?? '')
  ) {
    throw holdIntegrityMismatch('kind');
  }
}

export function settleHold(hold, { usage = {}, model, aiMode = 'api', credits: fixedCredits, costYuanOverride, note = '' } = {}) {
  if (!hold?.holdId) return null;
  ensureHoldTable();
  const b = billing();
  db.exec('BEGIN IMMEDIATE');
  try {
    // 只把 holdId 当作定位键；租户、流水、占扣金额和计费种类都从事务内
    // 重新读取。调用方对象可能来自旧异步闭包，绝不能成为跨租户记账依据。
    const row = q.get('SELECT * FROM credit_holds WHERE id=?', Number(hold.holdId));
    if (!row || row.status !== 'held') {
      db.exec('COMMIT');
      return null; // 不存在或已经终结：保持历史幂等语义
    }
    assertSuppliedHoldMatches(row, hold);
    const log = q.get(
      'SELECT id,tenant_id FROM credit_logs WHERE tenant_id=? AND id=?',
      row.tenant_id,
      row.log_id,
    );
    if (!log) throw holdIntegrityMismatch('logId');
    if (!q.get('SELECT id FROM tenants WHERE id=?', row.tenant_id)) {
      throw holdIntegrityMismatch('tenantId');
    }

    assertPositiveApiTextUsage(row, { usage, aiMode, fixedCredits });

    const finalModel = model || row.model || '';
    let yuan = aiMode === 'api' ? costYuan(row.kind, finalModel, usage, b) : 0;
    if (costYuanOverride !== undefined) {
      // Internal composite-video settlement only. Keep the ledger's CNY cost
      // consistent with the exact authorized customer credits, not one clip's price.
      const job = row.ref_type === 'media_job' ? q.get('SELECT snapshot_json FROM media_jobs WHERE tenant_id=? AND id=?', row.tenant_id, row.ref_id) : null;
      let snapshot;
      try { snapshot = JSON.parse(job?.snapshot_json || '{}'); } catch { snapshot = {}; }
      const amount = Number(costYuanOverride);
      if (row.kind !== 'video' || snapshot.voiceMode !== 'voiced' || snapshot.workflow !== 'ai_sales_video'
        || aiMode !== 'api' || typeof costYuanOverride !== 'number' || !Number.isFinite(amount) || amount < 0
        || !Number.isSafeInteger(fixedCredits) || fixedCredits !== Math.ceil(amount * b.marginMultiplier / b.creditYuan)) {
        throw Object.assign(new Error('组合媒体结算成本与授权积分不一致'), { status: 409, code: 'BILLING_COMPOSITE_COST_INVALID' });
      }
      yuan = amount;
    }
    const actual = fixedCredits != null
      ? Math.max(0, Math.ceil(Number(fixedCredits) || 0))
      : aiMode === 'api' ? Math.ceil((yuan * b.marginMultiplier) / b.creditYuan) : 0;
    if (actual > Number(row.held_credits)) throw holdExceeded();
    const claimed = q.run(`UPDATE credit_holds
      SET status='settled',settled_credits=?,settled_at=datetime('now','localtime')
      WHERE tenant_id=? AND id=? AND status='held'`,
    actual, row.tenant_id, row.id);
    if (!claimed.changes) {
      db.exec('COMMIT');
      return null;
    }
    const tenantUpdated = q.run(
      'UPDATE tenants SET credits=credits+? WHERE id=?',
      Number(row.held_credits) - actual,
      row.tenant_id,
    );
    if (tenantUpdated.changes !== 1) throw holdIntegrityMismatch('tenantId');
    const after = q.get('SELECT credits FROM tenants WHERE id=?', row.tenant_id)?.credits ?? 0;
    const logUpdated = q.run(`UPDATE credit_logs
      SET credits=?,model=?,input_tokens=?,output_tokens=?,cost_yuan=?,balance_after=?,ai_mode=?,note=?
      WHERE tenant_id=? AND id=?`,
      actual, finalModel, usage.inputTokens || 0, usage.outputTokens || 0, Math.round(yuan * 10000) / 10000, after, aiMode,
      `${note ? `${note}；` : ''}预授权${row.held_credits}分→实扣${actual}分`,
      row.tenant_id, row.log_id);
    if (logUpdated.changes !== 1) throw holdIntegrityMismatch('logId');
    db.exec('COMMIT');
    publishCreditsUpdated(row.tenant_id, after, actual === 0 ? 'release' : 'settle');
    return { credits: actual, balance: after, costYuan: Math.round(yuan * 100) / 100 };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw e;
  }
}

// 释放占扣（调用失败/上游任务失败，未交付任何产出）：全额退回，保留 0 分流水审计
export function releaseHold(hold, note = '调用失败，预授权全额退回') {
  return settleHold(hold, { credits: 0, aiMode: 'api', note });
}

/**
 * 在调用方已经开启的写事务中，按业务引用释放全部仍处于 held 的预授权。
 * 用于“驳回任务 + 退款”必须同成同败的状态迁移，避免先写已驳回、进程随后
 * 崩溃而把积分永久冻结。该函数不会自行 BEGIN/COMMIT。
 */
export function releaseHeldCreditsByRefInCurrentTransaction({
  tenantId,
  refType,
  refId,
  note = '业务终止，预授权全额退回',
} = {}) {
  const tid = Number(tenantId);
  const rid = Number(refId);
  const type = String(refType || '').trim();
  if (!Number.isInteger(tid) || tid <= 0 || !Number.isInteger(rid) || rid <= 0 || !type) {
    throw Object.assign(new Error('预授权业务引用不正确'), { status: 400 });
  }
  ensureHoldTable();
  const rows = q.all(`SELECT * FROM credit_holds
    WHERE tenant_id=? AND ref_type=? AND ref_id=? AND status='held'
    ORDER BY id`, tid, type, rid);
  let balance = Number(q.get('SELECT credits FROM tenants WHERE id=?', tid)?.credits || 0);
  let releasedCredits = 0;
  const holdIds = [];
  for (const row of rows) {
    const log = q.get(`SELECT id FROM credit_logs
      WHERE tenant_id=? AND id=?`, tid, row.log_id);
    if (!log) throw holdIntegrityMismatch('logId');
    const claimed = q.run(`UPDATE credit_holds
      SET status='settled',settled_credits=0,settled_at=datetime('now','localtime')
      WHERE tenant_id=? AND id=? AND status='held'`, tid, row.id);
    if (!claimed.changes) continue;
    const tenantUpdated = q.run(
      'UPDATE tenants SET credits=credits+? WHERE id=?',
      Number(row.held_credits || 0),
      tid,
    );
    if (tenantUpdated.changes !== 1) throw holdIntegrityMismatch('tenantId');
    balance = Number(q.get('SELECT credits FROM tenants WHERE id=?', tid)?.credits || 0);
    const finalNote = `${String(note || '').slice(0, 500)}；预授权${Number(row.held_credits || 0)}分→实扣0分`;
    const logUpdated = q.run(`UPDATE credit_logs
      SET credits=0,input_tokens=0,output_tokens=0,cost_yuan=0,balance_after=?,
        ai_mode='api',note=?
      WHERE tenant_id=? AND id=?`,
    balance, finalNote, tid, row.log_id);
    if (logUpdated.changes !== 1) throw holdIntegrityMismatch('logId');
    releasedCredits += Number(row.held_credits || 0);
    holdIds.push(Number(row.id));
  }
  return {
    releasedCount: holdIds.length,
    releasedCredits,
    holdIds,
    credits: 0,
    balance,
    costYuan: 0,
  };
}

// 按业务关联找回占扣中的 hold（异步视频任务成功回填/失败退分用）
export function findHoldByRef(refType, refId, tenantId = null) {
  ensureHoldTable();
  const row = tenantId == null
    ? q.get(`SELECT * FROM credit_holds WHERE ref_type=? AND ref_id=? AND status='held' ORDER BY id DESC LIMIT 1`, refType, refId)
    : q.get(`SELECT * FROM credit_holds WHERE ref_type=? AND ref_id=? AND tenant_id=? AND status='held' ORDER BY id DESC LIMIT 1`, refType, refId, tenantId);
  if (!row) return null;
  return { holdId: row.id, logId: row.log_id, tenantId: row.tenant_id, userId: row.user_id, feature: row.feature, kind: row.kind, model: row.model, credits: row.held_credits, balance: null };
}

// 兼容旧签名：管理员按用户调整 → 实际作用于其租户池
export function adjust({ userId, delta, operatorId, note, manageTransaction = true }) {
  const tid = tenantOf(userId);
  if (!tid) throw Object.assign(new Error('用户不存在'), { status: 404 });
  return creditTenant({ tenantId: tid, delta, userId, feature: delta >= 0 ? '管理员充值' : '管理员扣减', note: `${note || ''} (操作人#${operatorId})`, manageTransaction });
}
