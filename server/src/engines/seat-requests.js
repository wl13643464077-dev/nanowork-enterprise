import { randomBytes } from 'node:crypto';
import { db, q, getTenant } from '../db.js';
import { primaryUserIdFor, seatSummary } from './plan.js';

const failure = (message, status = 400, code = 'SEAT_REQUEST_INVALID') => Object.assign(new Error(message), { status, code });
const stamp = () => new Date().toISOString();
function integer(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw failure(`${label}必须是 1 到 ${max} 之间的整数`);
  return value;
}
function text(value, label, max = 1000) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw failure(`${label}须为不超过 ${max} 字的文本`);
  return value.trim();
}
function input(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key)))
    throw failure('请求包含不支持的字段');
  return body;
}
function transaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try { const outcome = action(); db.exec('COMMIT'); return outcome; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function manager(actor, scope) {
  const user = q.get('SELECT id,name,username,role,status,tenant_id FROM users WHERE id=?', actor?.id);
  if (!user || user.status !== '启用') throw failure('账号已停用或不存在', 403, 'SEAT_REQUEST_FORBIDDEN');
  if (scope === 'platform') {
    if (user.role !== 'platform_super') throw failure('仅平台超级管理员可处理席位申请', 403, 'SEAT_REQUEST_FORBIDDEN');
  } else if (!['boss', 'admin'].includes(user.role) || getTenant(user.tenant_id)?.status !== '已开通') {
    throw failure('仅已开通企业的老板或管理员可查看席位申请', 403, 'SEAT_REQUEST_FORBIDDEN');
  }
  return user;
}
function primary(actor, tenantId) {
  const user = manager(actor, 'tenant');
  if (Number(user.tenant_id) !== Number(tenantId) || user.role !== 'boss' || primaryUserIdFor(tenantId) !== user.id)
    throw failure('只有企业主账号可以提交或取消席位申请', 403, 'PRIMARY_ACCOUNT_REQUIRED');
  return user;
}
function audit(user, tenantId, action, detail) {
  // 审计必须与权益变更同事务；不能吞掉写入错误或在提交后造成假失败。
  q.run('INSERT INTO op_logs(user_id,username,module,action,target,ip,tenant_id) VALUES(?,?,?,?,?,?,?)',
    user.id, user.name || user.username, '账号席位', action, JSON.stringify(detail), null, tenantId);
}
function findRequest(id, tenantId = null) {
  const row = q.get('SELECT * FROM seat_requests WHERE id=?', Number(id));
  if (!row || (tenantId != null && Number(row.tenant_id) !== Number(tenantId))) throw failure('席位申请不存在', 404);
  return row;
}
function presentation(row) {
  const order = row.order_id == null ? null : q.get('SELECT order_no,status FROM recharge_orders WHERE id=?', row.order_id);
  return {
    id: row.id, tenantId: row.tenant_id, tenantName: getTenant(row.tenant_id)?.name || '',
    requestedBy: row.requested_by, requestedByName: q.get('SELECT name FROM users WHERE id=?', row.requested_by)?.name || '',
    additionalSeats: row.additional_seats, reason: row.reason, status: row.status,
    amountFen: row.amount_fen ?? null, quoteNote: row.quote_note, quotedBy: row.quoted_by, quotedAt: row.quoted_at,
    orderId: row.order_id ?? null, orderNo: order?.order_no ?? null, orderStatus: order?.status ?? null,
    paymentReference: row.payment_reference, appliedAt: row.applied_at, closedAt: row.closed_at,
    closeReason: row.close_reason, createdAt: row.created_at,
  };
}
function result(row, actorId) { return { request: presentation(row), summary: seatSummary(row.tenant_id, actorId) }; }

export function listSeatRequests(actor, scope, { tenantId } = {}) {
  const user = manager(actor, scope);
  let tid = user.tenant_id;
  if (scope === 'platform') {
    tid = tenantId == null || tenantId === '' ? null : integer(Number(tenantId), '企业编号');
    if (tid != null && !getTenant(tid)) throw failure('企业不存在', 404);
  } else if (tenantId != null && Number(tenantId) !== Number(tid)) throw failure('不可查看其他企业申请', 403, 'SEAT_REQUEST_FORBIDDEN');
  const rows = tid == null ? q.all('SELECT * FROM seat_requests ORDER BY id DESC LIMIT 200')
    : q.all('SELECT * FROM seat_requests WHERE tenant_id=? ORDER BY id DESC LIMIT 200', tid);
  return { items: rows.map(presentation), summary: tid == null ? null : seatSummary(tid, user.id) };
}

export function createSeatRequest(actor, body) {
  input(body, ['additionalSeats', 'reason']);
  const quantity = integer(body.additionalSeats, '新增副账号数', 1000);
  const reason = text(body.reason, '申请说明');
  return transaction(() => {
    const user = manager(actor, 'tenant'); primary(user, user.tenant_id);
    const tenant = getTenant(user.tenant_id);
    if (tenant.seat_limit == null) throw failure('本企业历史额度不限，无需申请增额', 409);
    if (q.get("SELECT id FROM seat_requests WHERE tenant_id=? AND status IN ('requested','quoted')", user.tenant_id))
      throw failure('已有待处理的席位申请，请先完成或取消', 409, 'SEAT_REQUEST_ALREADY_OPEN');
    const id = Number(q.run(`INSERT INTO seat_requests(tenant_id,requested_by,additional_seats,reason,status,created_at)
      VALUES(?,?,?,?,'requested',?)`, user.tenant_id, user.id, quantity, reason, stamp()).lastInsertRowid);
    audit(user, user.tenant_id, '申请副账号增额', { requestId: id, additionalSeats: quantity });
    return result(findRequest(id), user.id);
  });
}

export function quoteSeatRequest(actor, id, body) {
  input(body, ['amountFen', 'note']);
  // 金额由人工报价，单位为分；上限仅为安全账务范围，不代表单价。
  const amount = integer(body.amountFen, '报价总金额（分）', 1_000_000_000);
  const note = text(body.note, '报价说明');
  return transaction(() => {
    const user = manager(actor, 'platform'); const row = findRequest(id);
    if (row.status !== 'requested') throw failure('只有待报价申请可报价；已报价数量和金额不可修改', 409);
    if (getTenant(row.tenant_id)?.status !== '已开通') throw failure('企业未开通或已停用', 409);
    const orderNo = `S${Date.now()}${randomBytes(6).toString('hex').toUpperCase()}`;
    const orderId = Number(q.run(`INSERT INTO recharge_orders(order_no,tenant_id,package_id,package_name,price_yuan,credits,status,created_by,pay_method)
      VALUES(?,?,NULL,?,?,0,'待支付',?,'线下席位增额')`, orderNo, row.tenant_id,
    `新增 ${row.additional_seats} 个副账号`, amount / 100, row.requested_by).lastInsertRowid);
    q.run("UPDATE seat_requests SET status='quoted',amount_fen=?,quote_note=?,quoted_by=?,quoted_at=?,order_id=? WHERE id=?",
      amount, note, user.id, stamp(), orderId, row.id);
    audit(user, row.tenant_id, '席位增额报价', { requestId: row.id, orderId, amountFen: amount, additionalSeats: row.additional_seats });
    return result(findRequest(row.id), user.id);
  });
}

function closeRequest(actor, id, scope, reason) {
  return transaction(() => {
    const user = manager(actor, scope);
    const row = findRequest(id, scope === 'platform' ? null : user.tenant_id);
    if (scope !== 'platform') primary(user, row.tenant_id);
    const status = scope === 'platform' ? 'rejected' : 'cancelled';
    if (row.status === status) return result(row, user.id);
    if (!['requested', 'quoted'].includes(row.status)) throw failure('申请已结束，不能再次取消或拒绝', 409);
    if (row.order_id != null) {
      const order = q.get('SELECT * FROM recharge_orders WHERE id=?', row.order_id);
      if (!order || order.tenant_id !== row.tenant_id || order.status !== '待支付') throw failure('关联订单状态异常，请先核对账务', 409);
      q.run("UPDATE recharge_orders SET status='已取消' WHERE id=? AND status='待支付'", row.order_id);
    }
    q.run('UPDATE seat_requests SET status=?,closed_at=?,closed_by=?,close_reason=? WHERE id=?', status, stamp(), user.id, reason, row.id);
    audit(user, row.tenant_id, status === 'rejected' ? '拒绝席位增额' : '取消席位增额', { requestId: row.id, reason });
    return result(findRequest(row.id), user.id);
  });
}
export function cancelSeatRequest(actor, id) { return closeRequest(actor, id, 'tenant', ''); }
export function rejectSeatRequest(actor, id, body = {}) {
  input(body, ['reason']); return closeRequest(actor, id, 'platform', text(body.reason, '拒绝说明'));
}
export function seatRequestForOrder(orderId) { return q.get('SELECT * FROM seat_requests WHERE order_id=?', Number(orderId)) || null; }
export function orderWithSeatMetadata(order) {
  const request = seatRequestForOrder(order.id);
  const pkg = order.package_id == null ? null : q.get('SELECT kind FROM recharge_packages WHERE id=?', order.package_id);
  let frozenKind = null;
  try {
    const snapshot = JSON.parse(order.package_snapshot_json || 'null');
    if (snapshot?.version === 1 && ['credits', 'plan'].includes(snapshot.kind)) frozenKind = snapshot.kind;
  } catch { /* 损坏快照由入账边界拒绝，列表不因此中断 */ }
  return { ...order, kind: request ? 'seat_addon' : frozenKind || pkg?.kind || 'credits',
    seatRequestId: request?.id ?? null, additionalSeats: request?.additional_seats ?? null,
    amountFen: request?.amount_fen ?? Math.round(Number(order.price_yuan) * 100) };
}
export function cancelSeatRequestForOrder(actor, orderId) {
  const row = seatRequestForOrder(orderId);
  if (!row) throw failure('席位订单不存在', 404);
  return cancelSeatRequest(actor, row.id);
}
export function confirmSeatRequestPayment(actor, orderId, body) {
  input(body, ['paymentReference']);
  const paymentReference = text(body.paymentReference, '收款凭据', 200);
  if (!paymentReference) throw failure('确认到账必须填写实际收款凭据', 400, 'PAYMENT_REFERENCE_REQUIRED');
  return transaction(() => {
    const user = manager(actor, 'platform'); const row = seatRequestForOrder(orderId);
    if (!row) throw failure('席位订单不存在', 404);
    const order = q.get('SELECT * FROM recharge_orders WHERE id=?', row.order_id);
    if (!order || order.tenant_id !== row.tenant_id || order.package_id != null || Number(order.credits) !== 0
      || !Number.isSafeInteger(row.amount_fen) || row.amount_fen <= 0
      || Math.round(Number(order.price_yuan) * 100) !== row.amount_fen || order.pay_channel)
      throw failure('席位订单冻结信息不一致，不能确认到账', 409, 'SEAT_ORDER_MISMATCH');
    if (row.status === 'applied' && order.status === '已支付') return {
      ok: true, duplicated: true, seatRequest: presentation(row), seatSummary: seatSummary(row.tenant_id),
      balance: Number(getTenant(row.tenant_id)?.credits || 0), plan: null,
    };
    if (row.status !== 'quoted' || order.status !== '待支付') throw failure('申请或订单已结束，不能确认到账', 409);
    const tenant = getTenant(row.tenant_id);
    if (!tenant || tenant.status !== '已开通') throw failure('企业未开通或已停用', 409);
    const nextLimit = Number(tenant.seat_limit) + row.additional_seats;
    if (tenant.seat_limit == null || !Number.isSafeInteger(nextLimit) || nextLimit <= 0) throw failure('企业席位额度异常，请核对', 409);
    q.run('UPDATE tenants SET seat_limit=? WHERE id=?', nextLimit, row.tenant_id);
    q.run("UPDATE recharge_orders SET status='已支付',confirmed_by=?,paid_at=? WHERE id=? AND status='待支付'", user.id, stamp(), row.order_id);
    q.run("UPDATE seat_requests SET status='applied',payment_reference=?,confirmed_by=?,applied_at=? WHERE id=? AND status='quoted'",
      paymentReference, user.id, stamp(), row.id);
    audit(user, row.tenant_id, '确认席位增额到账', { requestId: row.id, orderId: row.order_id, additionalSeats: row.additional_seats, amountFen: row.amount_fen, paymentReference });
    return { ok: true, duplicated: false, seatRequest: presentation(findRequest(row.id)), seatSummary: seatSummary(row.tenant_id), balance: Number(tenant.credits || 0), plan: null };
  });
}

export function assignPrimaryAccount(actor, tenantId, body) {
  input(body, ['userId']); const userId = integer(body.userId, '主账号编号');
  return transaction(() => {
    const user = manager(actor, 'platform'); const tid = Number(tenantId);
    if (!getTenant(tid)) throw failure('企业不存在', 404);
    const target = q.get("SELECT id FROM users WHERE id=? AND tenant_id=? AND role='boss' AND status='启用'", userId, tid);
    if (!target) throw failure('主账号必须是本企业启用中的老板账号');
    const previous = getTenant(tid).primary_user_id;
    if (previous !== target.id) {
      q.run('UPDATE tenants SET primary_user_id=? WHERE id=?', target.id, tid);
      audit(user, tid, '确认企业主账号', { previousUserId: previous, userId: target.id });
    }
    return { ok: true, summary: seatSummary(tid, user.id) };
  });
}
