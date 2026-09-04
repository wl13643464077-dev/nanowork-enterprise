import { db, q, curTenant, getTenant, getTenantConfig, DEFAULT_PLAN_PACKAGE } from '../db.js';
import { creditTenant } from './credits.js';
import { notify } from '../util.js';

// ===== 年度套餐 / 计划模型（A4）=====
// 招商会定价：9800 元/年，含 5 个用户端账号，不含积分，本次套餐额外赠送 6 万积分。
// 本模块负责：套餐生效（含未到期顺延）、赠送积分独立入账、席位校验、套餐摘要、每日到期/低余额提醒。
// 【待老板决策】到期后的行为：本次只提醒、不锁功能（不拦 AI 调用、不禁登录），见 runDailyPlanAndBalanceCheck。

export const PLAN_STATUS = Object.freeze({ NONE: 'none', ACTIVE: 'active', EXPIRING: 'expiring', EXPIRED: 'expired' });
export const PLAN_EXPIRING_DAYS = 30;
export const PLAN_REMINDER_THRESHOLDS = Object.freeze([30, 7, 1]);
export const LOW_BALANCE_CONFIG_KEY = 'low_balance_alert_credits';
export const DEFAULT_LOW_BALANCE_CREDITS = 5000;
const LOW_BALANCE_REMIND_INTERVAL_MS = 24 * 3600 * 1000;

// 日期统一按"本地日历日"（YYYY-MM-DD）处理：套餐按天生效/到期，不引入时分秒歧义。
export function localDate(now = new Date()) {
  return new Date(now).toLocaleDateString('sv-SE');
}
export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + Number(days || 0));
  return d.toLocaleDateString('sv-SE');
}
export function daysBetween(fromDate, toDate) {
  const a = Date.parse(`${fromDate}T00:00:00`);
  const b = Date.parse(`${toDate}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}
function localStamp(now = new Date()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 依据到期日推导状态（不依赖库里缓存的 plan_status，保证接口口径实时正确）
export function derivePlanStatus(tenant, today = localDate()) {
  if (!tenant?.plan_code || !tenant?.plan_expires_at) return { status: PLAN_STATUS.NONE, daysLeft: null };
  const daysLeft = daysBetween(today, String(tenant.plan_expires_at).slice(0, 10));
  if (daysLeft == null) return { status: PLAN_STATUS.NONE, daysLeft: null };
  if (daysLeft < 0) return { status: PLAN_STATUS.EXPIRED, daysLeft };
  if (daysLeft <= PLAN_EXPIRING_DAYS) return { status: PLAN_STATUS.EXPIRING, daysLeft };
  return { status: PLAN_STATUS.ACTIVE, daysLeft };
}

export function packageByCode(code) {
  return q.get('SELECT * FROM recharge_packages WHERE code = ?', String(code || '')) || null;
}
export function defaultPlanPackage() {
  return packageByCode(DEFAULT_PLAN_PACKAGE.code);
}

// ===== 席位（账号数）=====
// 只统计"启用中"的用户端账号；停用账号不占席位；平台超管账号不计入也不受限。
export function seatUsage(tenantId = curTenant()) {
  const tid = Number(tenantId);
  const t = getTenant(tid);
  const limit = t?.seat_limit == null ? null : Number(t.seat_limit);
  const used = q.get(
    `SELECT COUNT(*) n FROM users WHERE tenant_id = ? AND status = '启用' AND role != 'platform_super'`,
    tid,
  )?.n || 0;
  return { limit, used };
}
export function assertSeatAvailable(tenantId = curTenant()) {
  const { limit, used } = seatUsage(tenantId);
  if (limit != null && used >= limit) {
    throw Object.assign(
      new Error(`当前套餐含 ${limit} 个账号，已用 ${used} 个；停用旧账号或联系升级`),
      { status: 409, code: 'SEAT_LIMIT_REACHED', seatLimit: limit, seatsUsed: used },
    );
  }
  return { limit, used };
}

// ===== 套餐摘要（/api/recharge/balance、/api/auth/me 共用）=====
export function planSummary(tenantOrId, today = localDate()) {
  const t = typeof tenantOrId === 'object' && tenantOrId ? tenantOrId : getTenant(tenantOrId);
  if (!t) return null;
  const pkg = t.plan_code ? packageByCode(t.plan_code) : null;
  const { status, daysLeft } = derivePlanStatus(t, today);
  const seats = seatUsage(t.id);
  return {
    code: t.plan_code || null,
    name: pkg?.name || (t.plan_code ? t.plan_code : (t.plan || null)),
    seatLimit: seats.limit,
    seatsUsed: seats.used,
    startedAt: t.plan_started_at || null,
    expiresAt: t.plan_expires_at || null,
    status,
    daysLeft,
    bonusCredits: pkg?.bonus_credits ?? null,
    validDays: pkg?.valid_days ?? null,
  };
}

function billingUserFor(tenantId, preferred) {
  if (preferred != null && q.get('SELECT id FROM users WHERE id = ?', preferred)) return Number(preferred);
  // credit_logs.user_id NOT NULL：无操作人（如支付回调）时归属到本企业老板/管理员，绝不借用他家账号
  const row = q.get(`SELECT id FROM users WHERE tenant_id = ?
    ORDER BY CASE role WHEN 'boss' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, id LIMIT 1`, tenantId);
  return row?.id ?? null;
}

// ===== 套餐生效 =====
// 未到期的套餐再次购买 → 从当前到期日顺延 valid_days（保留原开始日）；已到期/从未开通 → 从今天起算。
// 赠送积分作为独立 bonus 流水入账（kind/ai_mode='bonus'），与购买积分（recharge）区分。
// manageTransaction=false 时由调用方（支付入账/人工确认）在同一事务内调用，保证订单状态与套餐同成同败。
export function activatePlanForTenant({
  tenantId, pkg, operatorUserId = null, orderNo = '', source = 'manual', now = new Date(), manageTransaction = true,
}) {
  const tid = Number(tenantId);
  if (!pkg || pkg.kind !== 'plan') throw Object.assign(new Error('该套餐不是年度套餐，不能开通'), { status: 400 });
  const validDays = Number(pkg.valid_days);
  if (!Number.isInteger(validDays) || validDays <= 0) throw Object.assign(new Error('套餐有效期（valid_days）无效'), { status: 400 });
  const t = getTenant(tid);
  if (!t) throw Object.assign(new Error('租户不存在'), { status: 404 });
  const today = localDate(now);
  const current = derivePlanStatus(t, today);
  const rolledOver = current.status === PLAN_STATUS.ACTIVE || current.status === PLAN_STATUS.EXPIRING;
  const startedAt = rolledOver ? (t.plan_started_at || today) : today;
  const expiresAt = rolledOver ? addDays(String(t.plan_expires_at).slice(0, 10), validDays) : addDays(today, validDays);
  const bonus = Math.max(0, Math.floor(Number(pkg.bonus_credits) || 0));
  const seatLimit = pkg.seat_limit == null ? null : Number(pkg.seat_limit);

  if (manageTransaction) db.exec('BEGIN IMMEDIATE');
  let bonusResult = null;
  try {
    q.run(`UPDATE tenants SET plan_code=?, plan=?, plan_started_at=?, plan_expires_at=?, plan_status='active'
      ${seatLimit != null ? ', seat_limit=?' : ''} WHERE id=?`,
    pkg.code || `pkg-${pkg.id}`, pkg.name, startedAt, expiresAt, ...(seatLimit != null ? [seatLimit] : []), tid);
    if (bonus > 0) {
      const userId = billingUserFor(tid, operatorUserId);
      if (!userId) throw Object.assign(new Error('租户没有可用于赠送积分归属的账号'), { status: 409 });
      bonusResult = creditTenant({
        tenantId: tid, delta: bonus, userId, feature: '套餐赠送积分', kind: 'bonus', aiMode: 'bonus',
        note: `套餐赠送积分：${pkg.name}${orderNo ? `（订单 ${orderNo}）` : ''}${source === 'manual' ? '，线下签约手工开通' : ''}`,
        manageTransaction: false,
      });
    }
    if (manageTransaction) db.exec('COMMIT');
  } catch (e) {
    if (manageTransaction) { try { db.exec('ROLLBACK'); } catch { /* no active transaction */ } }
    throw e;
  }
  return {
    tenantId: tid, code: pkg.code, name: pkg.name, startedAt, expiresAt, rolledOver,
    seatLimit, bonusCredits: bonus, balance: bonusResult?.balance ?? getTenant(tid)?.credits ?? 0,
  };
}

// 支付成功 / 人工确认到账的共用入口：订单对应套餐为 plan 时生效套餐（在调用方事务内执行）
export function applyPlanForPaidOrderInTransaction(order, { operatorUserId = null, now = new Date() } = {}) {
  if (!order?.package_id) return null;
  const pkg = q.get('SELECT * FROM recharge_packages WHERE id = ?', order.package_id);
  if (!pkg || pkg.kind !== 'plan') return null;
  return activatePlanForTenant({
    tenantId: order.tenant_id, pkg, operatorUserId: operatorUserId ?? order.created_by, orderNo: order.order_no,
    source: 'order', now, manageTransaction: false,
  });
}

// ===== 每日 09:00 检查（scheduler 以 runOnce('daily-plan-and-balance-check:<日期>') 幂等调用）=====
function claimOnce(tenantId, jobKey, now) {
  return q.run('INSERT OR IGNORE INTO scheduled_runs(tenant_id,job_key,ran_at) VALUES(?,?,?)', tenantId, jobKey, localStamp(now)).changes > 0;
}
function recipients(tenantId, roles) {
  return q.all(`SELECT id FROM users WHERE tenant_id = ? AND status = '启用' AND role IN (${roles.map(() => '?').join(',')}) ORDER BY id`, tenantId, ...roles);
}

export function lowBalanceThreshold(tenantId = curTenant()) {
  const v = Number(getTenantConfig(LOW_BALANCE_CONFIG_KEY, DEFAULT_LOW_BALANCE_CREDITS, tenantId));
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_LOW_BALANCE_CREDITS;
}

export function runDailyPlanAndBalanceCheck({ tenantId = curTenant(), now = new Date() } = {}) {
  const tid = Number(tenantId);
  const t = getTenant(tid);
  const result = { tenantId: tid, planStatus: PLAN_STATUS.NONE, daysLeft: null, reminded: null, expired: false, lowBalanceAlerted: false, threshold: null };
  if (!t) return result;
  const today = localDate(now);

  // ① 套餐到期提醒 / 到期置状态。到期后只提醒、不锁功能（待老板决策项）。
  if (t.plan_code && t.plan_expires_at) {
    const { status, daysLeft } = derivePlanStatus(t, today);
    result.planStatus = status;
    result.daysLeft = daysLeft;
    if (t.plan_status !== status) q.run('UPDATE tenants SET plan_status=? WHERE id=?', status, tid);
    const pkgName = packageByCode(t.plan_code)?.name || t.plan || '年度套餐';
    const expiresAt = String(t.plan_expires_at).slice(0, 10);
    if (status === PLAN_STATUS.EXPIRED) {
      if (claimOnce(tid, `plan-expired:${expiresAt}`, now)) {
        result.expired = true;
        for (const u of recipients(tid, ['boss', 'admin'])) {
          notify(u.id, 'plan', `「${pkgName}」已于 ${expiresAt} 到期`,
            '套餐已到期，为不影响门店经营，系统暂未锁定功能；请尽快联系客户经理续费。', '/recharge');
        }
      }
    } else if (status === PLAN_STATUS.EXPIRING) {
      // 30/7/1 天各提醒一次；同一天命中多个阈值只发最紧的那一条，其余阈值同时标记为已提醒。
      const due = PLAN_REMINDER_THRESHOLDS.filter(th => daysLeft <= th);
      const tightest = due.length ? Math.min(...due) : null;
      if (tightest != null && claimOnce(tid, `plan-expiry-reminder:${tightest}d:${expiresAt}`, now)) {
        for (const th of due) if (th !== tightest) claimOnce(tid, `plan-expiry-reminder:${th}d:${expiresAt}`, now);
        result.reminded = tightest;
        const when = daysLeft === 0 ? '今天' : `${daysLeft} 天后（${expiresAt}）`;
        for (const u of recipients(tid, ['boss', 'admin'])) {
          notify(u.id, 'plan', `「${pkgName}」将于${when}到期`,
            `套餐到期后将影响新账号开通与续费权益，请提前联系客户经理续费。`, '/recharge');
        }
      }
    }
  }

  // ② 积分低于阈值（sys_config low_balance_alert_credits，默认 5000）且 24h 内未提醒过 → 通知老板
  const threshold = lowBalanceThreshold(tid);
  result.threshold = threshold;
  const balance = Number(t.credits || 0);
  if (balance < threshold) {
    const cutoff = localStamp(new Date(new Date(now).getTime() - LOW_BALANCE_REMIND_INTERVAL_MS));
    const recent = q.get(`SELECT 1 FROM scheduled_runs WHERE tenant_id = ? AND job_key LIKE 'low-balance-alert:%' AND ran_at > ? LIMIT 1`, tid, cutoff);
    if (!recent && claimOnce(tid, `low-balance-alert:${localStamp(now)}`, now)) {
      result.lowBalanceAlerted = true;
      for (const u of recipients(tid, ['boss'])) {
        notify(u.id, 'credits', `企业积分余额不足：当前 ${balance.toLocaleString()} 分`,
          `已低于提醒阈值 ${threshold.toLocaleString()} 分，AI 员工可能因余额不足暂停出活，请及时充值。`, '/recharge');
      }
    }
  }
  return result;
}
