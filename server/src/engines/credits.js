import { q, getConfig, setConfig, tenantOf, db } from '../db.js';
import { textModelFor } from './yunwu.js';

// ===== 积分计费引擎（PRD V2 §23）=====
// 定价基准（元）：文本按 元/百万token；图片按 元/张；视频按 元/条。1积分 = creditYuan 元。
// 扣减公式：credits = ceil( 成本(元) × marginMultiplier ÷ creditYuan )，模板模式扣0分。
const DEFAULT_BILLING = {
  creditYuan: 0.01,        // 1积分 = 1分钱
  marginMultiplier: 1.5,   // 毛利系数（成本上浮50%）
  text: {
    'gpt-5.5': { in: 30, out: 60 },
    'gemini-3.1-flash-lite': { in: 2.5, out: 7.5 },
    'deepseek-v4-flash': { in: 5, out: 5 },
    // AI-H4：Claude 备用通道模型必须有独立价目——官方 $5/$25 每百万 token 折算人民币约 36/180 元。
    // 此前缺条目落到 default 30/30，输出侧少收 6 倍（180 vs 30），备用通道一开就亏损。
    'claude-opus-4-8': { in: 36, out: 180 },
    default: { in: 30, out: 30 },
  },
  image: { 'gpt-image-2': 0.5, default: 0.5 },
  video: {
    // MiniMax Paygo 价目核验于 2026-09-01：Hailuo 02 / 2.3 768P、10秒
    // $0.56，按当日 USD/CNY 6.7809 折算为 ¥3.7973，本地单段成本取 ¥3.80。
    // AI带货员会把30秒任务拆为3个10秒真实供应商任务。
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
  minBalance: { text: 5, image: 120, video: 1200 },  // 调用前最低余额预检（积分）
};
export function billing() {
  const cfg = getConfig('billing', {}) || {};
  return {
    ...DEFAULT_BILLING,
    ...cfg,
    text: { ...DEFAULT_BILLING.text, ...(cfg.text || {}) },
    image: { ...DEFAULT_BILLING.image, ...(cfg.image || {}) },
    video: { ...DEFAULT_BILLING.video, ...(cfg.video || {}) },
    minBalance: { ...DEFAULT_BILLING.minBalance, ...(cfg.minBalance || {}) },
  };
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

// 调用前预检：余额 < 单次上限估算 → 402拦截（不发起外部API调用，从源头杜绝坏账）
export function precheck(userId, kind, model) {
  const b = billing();
  const floor = b.minBalance[kind] ?? 5;
  const need = Math.max(floor, model ? estimateMaxCredits(kind, model, b) : floor);
  const bal = balanceOf(userId);
  if (bal < need) {
    const err = new Error(`积分余额不足：当前 ${bal} 分，本次${kind === 'text' ? '文本生成' : kind === 'image' ? '图片生成' : '视频生成'}预估最高需 ${need} 分。请联系管理员充值。`);
    err.status = 402;
    throw err;
  }
  return bal;
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
  return { credits, balance: after, costYuan: Math.round(yuan * 100) / 100 };
}

// 租户积分池入账/调整（充值确认、管理员补偿）：正数入账，负数扣减；统一记流水保证对账
export function creditTenant({ tenantId, delta, userId = null, feature, note = '', manageTransaction = true }) {
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
      tid, userId, feature || (amount >= 0 ? '积分充值' : '管理调整'), 'recharge', '', -amount, after, 'recharge', String(note || '').slice(0, 1000));
    if (manageTransaction) db.exec('COMMIT');
  } catch (e) {
    if (manageTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    }
    throw e;
  }
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

export function settleHold(hold, { usage = {}, model, aiMode = 'api', credits: fixedCredits, note = '' } = {}) {
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
    const yuan = aiMode === 'api' ? costYuan(row.kind, finalModel, usage, b) : 0;
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
