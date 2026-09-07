import { db, q, curTenant, getTenant, getTenantConfig, DEFAULT_PLAN_PACKAGE } from '../db.js';
import { creditTenant } from './credits.js';
import { yuanToFen } from './payment.js';
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
export function primaryAccountFor(tenantId = curTenant()) {
  const tenant = getTenant(Number(tenantId));
  if (!tenant) return null;
  if (tenant.primary_user_id != null) return q.get(`SELECT id,username,name,role,status FROM users
    WHERE id=? AND tenant_id=? AND role!='platform_super'`, tenant.primary_user_id, tenant.id) || null;
  // 与迁移相同的唯一性规则，只读兼容迁移后导入的旧企业；绝不选择多个老板中的某一个。
  const candidates = q.all(`SELECT id,username,name,role,status FROM users
    WHERE tenant_id=? AND role='boss' AND status='启用' LIMIT 2`, tenant.id);
  return candidates.length === 1 ? candidates[0] : null;
}
export function primaryUserIdFor(tenantId = curTenant()) {
  return primaryAccountFor(tenantId)?.id ?? null;
}
export function seatSummary(tenantId = curTenant(), userId = null) {
  const tid = Number(tenantId);
  const tenant = getTenant(tid);
  if (!tenant) return null;
  const primaryAccount = primaryAccountFor(tid);
  const seats = seatUsage(tid);
  const primaryEnabled = primaryAccount?.status === '启用';
  const purchasedExtraSeats = Number(q.get(`SELECT COALESCE(SUM(additional_seats),0) n
    FROM seat_requests WHERE tenant_id=? AND status='applied'`, tid)?.n || 0);
  const subSeatLimit = seats.limit == null ? null : Math.max(0, seats.limit - 1);
  const subSeatsUsed = Math.max(0, seats.used - (primaryEnabled ? 1 : 0));
  return {
    primaryAccount, primaryAssignmentRequired: !primaryAccount,
    includedPrimarySeats: 1, includedSubSeats: 4, purchasedExtraSeats,
    legacyExtraSeats: seats.limit == null ? null : Math.max(0, seats.limit - 5 - purchasedExtraSeats),
    seatLimit: seats.limit, seatsUsed: seats.used, subSeatLimit, subSeatsUsed,
    availableSubSeats: subSeatLimit == null ? null : Math.max(0, subSeatLimit - subSeatsUsed),
    canRequestAdditionalSeats: tenant.status === '已开通' && primaryEnabled && primaryAccount?.role === 'boss'
      && Number(primaryAccount.id) === Number(userId) && seats.limit != null,
  };
}
export function assertSeatAvailable(tenantId = curTenant(), { userId = null } = {}) {
  const { limit, used } = seatUsage(tenantId);
  const summary = seatSummary(tenantId);
  // 主位始终保留；停用主账号或尚未确认主账号，均不能多开一个免费副账号。
  if (userId != null && Number(userId) === Number(summary?.primaryAccount?.id)) return { limit, used };
  if (summary?.subSeatLimit != null && summary.subSeatsUsed >= summary.subSeatLimit) {
    throw Object.assign(
      new Error(`当前可用副账号 ${summary.subSeatLimit} 个，已用 ${summary.subSeatsUsed} 个；可停用旧副账号，或由主账号申请增额并在付款确认后开通`),
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
    seats: seatSummary(t.id),
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
  const seatLimit = t.seat_limit == null ? null : Number(t.seat_limit);

  if (manageTransaction) db.exec('BEGIN IMMEDIATE');
  let bonusResult = null;
  try {
    // 套餐只管理有效期和积分；新企业基础 5 席已在注册时设置，续费不得抹去已付增额或历史权益。
    q.run(`UPDATE tenants SET plan_code=?, plan=?, plan_started_at=?, plan_expires_at=?, plan_status='active' WHERE id=?`,
    pkg.code || `pkg-${pkg.id}`, pkg.name, startedAt, expiresAt, tid);
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

// 新订单在创建时冻结购买条件；旧订单没有快照时沿用原有记录，不追溯改账。
export function snapshotPackageForOrder(pkg) {
  const kind = pkg?.kind || 'credits';
  const priceFen = yuanToFen(pkg?.price_yuan);
  const fields = ['base_credits', 'bonus_credits', 'total_credits'];
  if (!['credits', 'plan'].includes(kind) || fields.some(key => !Number.isSafeInteger(pkg[key]) || pkg[key] < 0 || pkg[key] > 1_000_000_000)) {
    throw Object.assign(new Error('套餐积分配置无效，请联系平台核对'), { status: 400 });
  }
  if ((kind === 'credits' && (pkg.base_credits !== priceFen || pkg.total_credits !== pkg.base_credits + pkg.bonus_credits))
    || (kind === 'plan' && pkg.total_credits !== pkg.base_credits)) {
    throw Object.assign(new Error('套餐价格与购买积分不一致；1元对应100购买积分，赠送须单独列明'), { status: 400 });
  }
  if (kind === 'plan' && (!Number.isInteger(pkg.valid_days) || pkg.valid_days < 1 || pkg.valid_days > 3650)) {
    throw Object.assign(new Error('套餐有效期无效'), { status: 400 });
  }
  return { version: 1, id: pkg.id, code: pkg.code ?? null, name: pkg.name, kind,
    price_yuan: priceFen / 100, base_credits: pkg.base_credits, bonus_credits: pkg.bonus_credits,
    total_credits: pkg.total_credits, valid_days: pkg.valid_days ?? null, seat_limit: pkg.seat_limit ?? null };
}

export function packageForPaidOrder(order) {
  if (order?.package_snapshot_json != null) {
    let pkg;
    try {
      pkg = JSON.parse(order.package_snapshot_json);
      if (pkg?.version !== 1) throw new Error('version');
      snapshotPackageForOrder(pkg);
      if (pkg.id !== order.package_id || pkg.name !== order.package_name
        || yuanToFen(pkg.price_yuan) !== yuanToFen(order.price_yuan) || pkg.total_credits !== order.credits) throw new Error('mismatch');
    } catch {
      throw Object.assign(new Error('订单购买快照不完整或与订单不符，请平台核对'), { status: 409 });
    }
    return pkg;
  }
  return order?.package_id ? q.get('SELECT * FROM recharge_packages WHERE id = ?', order.package_id) : null;
}

export function creditPaidOrderInTransaction(order, { operatorUserId = null } = {}) {
  yuanToFen(order.price_yuan);
  const pkg = packageForPaidOrder(order);
  const declaredBonus = order.package_snapshot_json != null && pkg?.kind === 'credits' ? pkg.bonus_credits : 0;
  const purchasedCredits = Number(order.credits) - declaredBonus;
  if (!Number.isSafeInteger(purchasedCredits) || purchasedCredits < 0) {
    throw Object.assign(new Error('订单购买积分无效，请平台核对'), { status: 409 });
  }
  const userId = operatorUserId ?? order.created_by;
  let balance = getTenant(order.tenant_id)?.credits ?? 0;
  if (purchasedCredits > 0) {
    balance = creditTenant({ tenantId: order.tenant_id, delta: purchasedCredits, userId,
      feature: `充值到账·${order.package_name}`, note: `订单 ${order.order_no}`, manageTransaction: false }).balance;
  }
  if (declaredBonus > 0) {
    balance = creditTenant({ tenantId: order.tenant_id, delta: declaredBonus, userId, kind: 'bonus', aiMode: 'bonus',
      feature: '充值赠送积分', note: `订单 ${order.order_no}（已列明赠送积分）`, manageTransaction: false }).balance;
  }
  return { balance };
}

// 支付成功 / 人工确认到账的共用入口：按冻结套餐生效（在调用方事务内执行）
export function applyPlanForPaidOrderInTransaction(order, { operatorUserId = null, now = new Date() } = {}) {
  if (!order?.package_id) return null;
  const pkg = packageForPaidOrder(order);
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
