import { Router } from 'express';
import crypto from 'node:crypto';
import { db, q, curTenant } from '../db.js';
import { logOp, today } from '../util.js';

// 餐饮真数据模型（审计报告 P0）：门店 / 菜品 / 订单明细 / 成本 + 真实经营 KPI。
// 全部读取走 q.scopedAll/scopedGet（BE-C2 读侧租户强制），写入依赖 INSERT 自动注入 tenant_id。
const r = Router();

const BIZ_TYPES = new Set(['快餐', '正餐', '茶饮', '火锅', '其他']);
const STORE_STATUSES = new Set(['营业中', '筹备中', '已关店']);
const DISH_STATUSES = new Set(['在售', '下架']);
const COST_CATEGORIES = new Set(['食材', '人力', '房租', '水电', '营销', '其他']);

const clean = (v, fallback = '') => String(v ?? fallback).trim();
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const isMonth = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
// 月份区间 [start, endExclusive)，用于 created_at/date 范围过滤
function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const endExclusive = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { start, endExclusive };
}

// ===== 门店 =====
r.get('/stores', (req, res) => {
  const { status, biz_type: bizType, kw } = req.query;
  let tail = '';
  const params = [];
  if (status) { tail += ' AND status = ?'; params.push(clean(status)); }
  if (bizType) { tail += ' AND biz_type = ?'; params.push(clean(bizType)); }
  if (kw) { tail += ' AND name LIKE ?'; params.push(`%${clean(kw)}%`); }
  tail += ' ORDER BY created_at DESC, id DESC';
  const rows = q.scopedAll('stores', tail.trim(), ...params).map(store => ({
    ...store,
    dish_count: q.scopedCount('dishes', 'AND store_id = ?', store.id),
    cost_count: q.scopedCount('costs', 'AND store_id = ?', store.id),
  }));
  res.json({ total: rows.length, rows });
});

function storePayloadError(body, { partial = false } = {}) {
  const name = clean(body?.name);
  if (!partial || body?.name !== undefined) {
    if (!name) return '请填写门店名称';
    if (name.length > 60) return '门店名称不能超过60个字符';
  }
  if (body?.biz_type !== undefined && body.biz_type !== null && body.biz_type !== '' && !BIZ_TYPES.has(clean(body.biz_type))) {
    return '业态仅支持：快餐/正餐/茶饮/火锅/其他';
  }
  if (body?.status !== undefined && body.status !== null && body.status !== '' && !STORE_STATUSES.has(clean(body.status))) {
    return '门店状态仅支持：营业中/筹备中/已关店';
  }
  if (body?.opened_at && !isDate(clean(body.opened_at))) return '开业日期格式应为 YYYY-MM-DD';
  return null;
}

r.post('/stores', (req, res) => {
  const problem = storePayloadError(req.body);
  if (problem) return res.status(400).json({ error: problem });
  const b = req.body || {};
  const ret = q.run(`INSERT INTO stores(name,code,address,city,area,biz_type,opened_at,status)
    VALUES(?,?,?,?,?,?,?,?)`,
    clean(b.name), clean(b.code) || null, clean(b.address) || null, clean(b.city) || null, clean(b.area) || null,
    BIZ_TYPES.has(clean(b.biz_type)) ? clean(b.biz_type) : '快餐',
    clean(b.opened_at) || null,
    STORE_STATUSES.has(clean(b.status)) ? clean(b.status) : '营业中');
  logOp(req.user, '经营数据', '新建门店', clean(b.name));
  res.status(201).json(q.scopedGet('stores', 'AND id = ?', ret.lastInsertRowid));
});

r.put('/stores/:id', (req, res) => {
  const store = q.scopedGet('stores', 'AND id = ?', req.params.id);
  if (!store) return res.status(404).json({ error: '门店不存在或不属于当前企业' });
  const problem = storePayloadError({ ...store, ...req.body }, { partial: true });
  if (problem) return res.status(400).json({ error: problem });
  const b = req.body || {};
  const next = {
    name: b.name !== undefined ? clean(b.name) : store.name,
    code: b.code !== undefined ? (clean(b.code) || null) : store.code,
    address: b.address !== undefined ? (clean(b.address) || null) : store.address,
    city: b.city !== undefined ? (clean(b.city) || null) : store.city,
    area: b.area !== undefined ? (clean(b.area) || null) : store.area,
    biz_type: b.biz_type !== undefined && BIZ_TYPES.has(clean(b.biz_type)) ? clean(b.biz_type) : store.biz_type,
    opened_at: b.opened_at !== undefined ? (clean(b.opened_at) || null) : store.opened_at,
    status: b.status !== undefined && STORE_STATUSES.has(clean(b.status)) ? clean(b.status) : store.status,
  };
  q.run(`UPDATE stores SET name=?, code=?, address=?, city=?, area=?, biz_type=?, opened_at=?, status=?
    WHERE tenant_id = ? AND id = ?`,
    next.name, next.code, next.address, next.city, next.area, next.biz_type, next.opened_at, next.status,
    curTenant(), store.id);
  logOp(req.user, '经营数据', '更新门店', `store#${store.id} ${next.name}`);
  res.json(q.scopedGet('stores', 'AND id = ?', store.id));
});

r.delete('/stores/:id', (req, res) => {
  const store = q.scopedGet('stores', 'AND id = ?', req.params.id);
  if (!store) return res.status(404).json({ error: '门店不存在或不属于当前企业' });
  const dishCount = q.scopedCount('dishes', 'AND store_id = ?', store.id);
  const costCount = q.scopedCount('costs', 'AND store_id = ?', store.id);
  const orderCount = q.scopedCount('orders', 'AND store_id = ?', store.id);
  if (dishCount || costCount || orderCount) {
    return res.status(400).json({
      error: `该门店下还有 ${dishCount} 个菜品、${costCount} 条成本记录、${orderCount} 张订单，请先处理关联数据后再删除门店`,
    });
  }
  q.run('DELETE FROM stores WHERE tenant_id = ? AND id = ?', curTenant(), store.id);
  logOp(req.user, '经营数据', '删除门店', `store#${store.id} ${store.name}`);
  res.json({ ok: true });
});

// ===== 菜品 =====
r.get('/dishes', (req, res) => {
  const { store_id: storeId, category, status, kw } = req.query;
  let tail = '';
  const params = [];
  if (storeId) { tail += ' AND store_id = ?'; params.push(Number(storeId)); }
  if (category) { tail += ' AND category = ?'; params.push(clean(category)); }
  if (status) { tail += ' AND status = ?'; params.push(clean(status)); }
  if (kw) { tail += ' AND name LIKE ?'; params.push(`%${clean(kw)}%`); }
  tail += ' ORDER BY created_at DESC, id DESC';
  const rows = q.scopedAll('dishes', tail.trim(), ...params);
  const storeNames = new Map(q.scopedAll('stores', '').map(s => [s.id, s.name]));
  res.json({ total: rows.length, rows: rows.map(d => ({ ...d, store_name: storeNames.get(d.store_id) || '-' })) });
});

function dishPayloadError(body, store) {
  if (!store) return '所属门店不存在或不属于当前企业';
  const name = clean(body?.name);
  if (!name) return '请填写菜品名称';
  if (name.length > 60) return '菜品名称不能超过60个字符';
  if (body?.price !== undefined && (!Number.isFinite(Number(body.price)) || Number(body.price) < 0)) return '售价必须是不小于0的数字';
  if (body?.cost !== undefined && body.cost !== null && body.cost !== '' && (!Number.isFinite(Number(body.cost)) || Number(body.cost) < 0)) return '成本必须是不小于0的数字';
  if (body?.status !== undefined && body.status !== null && body.status !== '' && !DISH_STATUSES.has(clean(body.status))) return '菜品状态仅支持：在售/下架';
  return null;
}

r.post('/dishes', (req, res) => {
  const b = req.body || {};
  const store = q.scopedGet('stores', 'AND id = ?', Number(b.store_id) || 0);
  const problem = dishPayloadError(b, store);
  if (problem) return res.status(400).json({ error: problem });
  const ret = q.run(`INSERT INTO dishes(store_id,name,code,category,price,cost,unit,status)
    VALUES(?,?,?,?,?,?,?,?)`,
    store.id, clean(b.name), clean(b.code) || null, clean(b.category) || null,
    round2(num(b.price, 0)), round2(num(b.cost, 0)), clean(b.unit) || null,
    DISH_STATUSES.has(clean(b.status)) ? clean(b.status) : '在售');
  logOp(req.user, '经营数据', '新建菜品', `${store.name}/${clean(b.name)}`);
  res.status(201).json(q.scopedGet('dishes', 'AND id = ?', ret.lastInsertRowid));
});

r.put('/dishes/:id', (req, res) => {
  const dish = q.scopedGet('dishes', 'AND id = ?', req.params.id);
  if (!dish) return res.status(404).json({ error: '菜品不存在或不属于当前企业' });
  const b = req.body || {};
  const store = b.store_id !== undefined
    ? q.scopedGet('stores', 'AND id = ?', Number(b.store_id) || 0)
    : q.scopedGet('stores', 'AND id = ?', dish.store_id);
  const problem = dishPayloadError({ ...dish, ...b }, store);
  if (problem) return res.status(400).json({ error: problem });
  const next = {
    store_id: store.id,
    name: b.name !== undefined ? clean(b.name) : dish.name,
    code: b.code !== undefined ? (clean(b.code) || null) : dish.code,
    category: b.category !== undefined ? (clean(b.category) || null) : dish.category,
    price: b.price !== undefined ? round2(num(b.price, 0)) : dish.price,
    cost: b.cost !== undefined ? round2(num(b.cost, 0)) : dish.cost,
    unit: b.unit !== undefined ? (clean(b.unit) || null) : dish.unit,
    status: b.status !== undefined && DISH_STATUSES.has(clean(b.status)) ? clean(b.status) : dish.status,
  };
  q.run(`UPDATE dishes SET store_id=?, name=?, code=?, category=?, price=?, cost=?, unit=?, status=?,
      updated_at = datetime('now','localtime')
    WHERE tenant_id = ? AND id = ?`,
    next.store_id, next.name, next.code, next.category, next.price, next.cost, next.unit, next.status,
    curTenant(), dish.id);
  logOp(req.user, '经营数据', '更新菜品', `dish#${dish.id} ${next.name}`);
  res.json(q.scopedGet('dishes', 'AND id = ?', dish.id));
});

r.post('/dishes/:id/status', (req, res) => {
  const dish = q.scopedGet('dishes', 'AND id = ?', req.params.id);
  if (!dish) return res.status(404).json({ error: '菜品不存在或不属于当前企业' });
  const status = clean(req.body?.status);
  if (!DISH_STATUSES.has(status)) return res.status(400).json({ error: '菜品状态仅支持：在售/下架' });
  q.run(`UPDATE dishes SET status = ?, updated_at = datetime('now','localtime') WHERE tenant_id = ? AND id = ?`,
    status, curTenant(), dish.id);
  logOp(req.user, '经营数据', '菜品状态流转', `dish#${dish.id} → ${status}`);
  res.json({ ok: true, status });
});

// ===== 成本 =====
r.get('/costs', (req, res) => {
  const { month, store_id: storeId, category } = req.query;
  let tail = '';
  const params = [];
  if (month) {
    if (!isMonth(clean(month))) return res.status(400).json({ error: '月份格式应为 YYYY-MM' });
    const { start, endExclusive } = monthRange(clean(month));
    tail += ' AND date >= ? AND date < ?';
    params.push(start, endExclusive);
  }
  if (storeId) { tail += ' AND store_id = ?'; params.push(Number(storeId)); }
  if (category) { tail += ' AND category = ?'; params.push(clean(category)); }
  tail += ' ORDER BY date DESC, id DESC';
  const rows = q.scopedAll('costs', tail.trim(), ...params);
  const storeNames = new Map(q.scopedAll('stores', '').map(s => [s.id, s.name]));
  res.json({
    total: rows.length,
    sum: round2(rows.reduce((s, c) => s + Number(c.amount || 0), 0)),
    rows: rows.map(c => ({ ...c, store_name: storeNames.get(c.store_id) || '-' })),
  });
});

r.post('/costs', (req, res) => {
  const b = req.body || {};
  const store = q.scopedGet('stores', 'AND id = ?', Number(b.store_id) || 0);
  if (!store) return res.status(400).json({ error: '所属门店不存在或不属于当前企业' });
  const date = clean(b.date);
  if (!isDate(date)) return res.status(400).json({ error: '成本日期格式应为 YYYY-MM-DD' });
  const category = clean(b.category);
  if (!COST_CATEGORIES.has(category)) return res.status(400).json({ error: '成本类别仅支持：食材/人力/房租/水电/营销/其他' });
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: '成本金额必须是大于0的数字' });
  const ret = q.run('INSERT INTO costs(store_id,date,category,amount,note) VALUES(?,?,?,?,?)',
    store.id, date, category, round2(amount), clean(b.note) || null);
  logOp(req.user, '经营数据', '登记成本', `${store.name}/${date}/${category} ¥${round2(amount)}`);
  res.status(201).json(q.scopedGet('costs', 'AND id = ?', ret.lastInsertRowid));
});

r.delete('/costs/:id', (req, res) => {
  const cost = q.scopedGet('costs', 'AND id = ?', req.params.id);
  if (!cost) return res.status(404).json({ error: '成本记录不存在或不属于当前企业' });
  q.run('DELETE FROM costs WHERE tenant_id = ? AND id = ?', curTenant(), cost.id);
  logOp(req.user, '经营数据', '删除成本', `cost#${cost.id} ${cost.date}/${cost.category}`);
  res.json({ ok: true });
});

// ===== 订单明细（orders 为订单头，向后兼容）=====
r.get('/orders/:orderId/items', (req, res) => {
  const order = q.scopedGet('orders', 'AND id = ?', Number(req.params.orderId) || 0);
  if (!order) return res.status(404).json({ error: '订单不存在或不属于当前企业' });
  const rows = q.scopedAll('order_items', 'AND order_id = ? ORDER BY id', order.id);
  res.json({ total: rows.length, sum: round2(rows.reduce((s, x) => s + Number(x.amount || 0), 0)), rows });
});

r.post('/orders/:orderId/items', (req, res) => {
  const order = q.scopedGet('orders', 'AND id = ?', Number(req.params.orderId) || 0);
  if (!order) return res.status(404).json({ error: '订单不存在或不属于当前企业' });
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items || !items.length) return res.status(400).json({ error: '请至少提供一条订单明细' });
  if (items.length > 200) return res.status(400).json({ error: '单次最多登记200条明细' });
  const idempotencyKey = clean(
    req.body?.idempotencyKey || req.get('Idempotency-Key'),
  ).toLowerCase();
  if (!/^[a-z0-9_-]{8,100}$/.test(idempotencyKey)) {
    return res.status(400).json({ error: '请提供8到100位的订单明细幂等键' });
  }
  const requestedStoreId = req.body?.store_id == null || req.body.store_id === ''
    ? null
    : Number(req.body.store_id);
  const requestedStore = requestedStoreId == null
    ? null
    : q.scopedGet('stores', 'AND id = ?', requestedStoreId);
  if (requestedStoreId != null
    && (!Number.isInteger(requestedStoreId) || requestedStoreId <= 0 || !requestedStore)) {
    return res.status(400).json({ error: '订单所属门店不存在或不属于当前企业' });
  }

  // 先整体校验再写入：任何一条不合法都不落库，避免半截明细污染客单价口径
  const prepared = [];
  const dishStoreIds = new Set();
  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    const rowNo = i + 1;
    let dish = null;
    if (item.dish_id !== undefined && item.dish_id !== null && item.dish_id !== '') {
      dish = q.scopedGet('dishes', 'AND id = ?', Number(item.dish_id) || 0);
      if (!dish) return res.status(400).json({ error: `第${rowNo}条明细的菜品不存在或不属于当前企业` });
      dishStoreIds.add(Number(dish.store_id));
    }
    const name = clean(item.dish_name_snapshot) || dish?.name || '';
    if (!name) return res.status(400).json({ error: `第${rowNo}条明细缺少菜品名称（dish_name_snapshot 或有效 dish_id）` });
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: `第${rowNo}条明细的数量必须是大于0的整数` });
    const unitPrice = item.unit_price !== undefined && item.unit_price !== null && item.unit_price !== ''
      ? Number(item.unit_price)
      : (dish ? Number(dish.price) : NaN);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) return res.status(400).json({ error: `第${rowNo}条明细缺少有效单价` });
    const discount = item.discount === undefined || item.discount === null || item.discount === '' ? 0 : Number(item.discount);
    if (!Number.isFinite(discount) || discount < 0) return res.status(400).json({ error: `第${rowNo}条明细的优惠金额必须是不小于0的数字` });
    if (discount > qty * unitPrice) return res.status(400).json({ error: `第${rowNo}条明细的优惠不能超过明细小计` });
    prepared.push({
      dish_id: dish?.id ?? null,
      name,
      qty,
      unitPrice: round2(unitPrice),
      discount: round2(discount),
      amount: round2(qty * unitPrice - discount),
    });
  }
  if (dishStoreIds.size > 1) {
    return res.status(400).json({ error: '同一张订单的菜品必须来自同一门店' });
  }
  const dishStoreId = dishStoreIds.size ? [...dishStoreIds][0] : null;
  const targetStoreId = Number(order.store_id || requestedStoreId || dishStoreId || 0);
  if (!targetStoreId) {
    return res.status(400).json({ error: '无法确定订单所属门店，请提供 store_id 或选择门店菜品' });
  }
  if ((order.store_id && Number(order.store_id) !== targetStoreId)
    || (requestedStoreId && requestedStoreId !== targetStoreId)
    || (dishStoreId && dishStoreId !== targetStoreId)) {
    return res.status(409).json({ error: '订单、指定门店与菜品所属门店不一致' });
  }

  const requestHash = crypto.createHash('sha256').update(JSON.stringify({
    storeId: targetStoreId,
    items: prepared,
  })).digest('hex');
  const existing = q.get(`SELECT request_hash,response FROM order_item_commits
    WHERE tenant_id=? AND order_id=? AND idempotency_key=?`,
  curTenant(), order.id, idempotencyKey);
  if (existing?.request_hash && existing.request_hash !== requestHash) {
    return res.status(409).json({ error: '相同幂等键对应了不同订单明细，请生成新的幂等键' });
  }
  if (existing?.response) {
    return res.json({ ...JSON.parse(existing.response), replayed: true });
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const claimed = q.run(`INSERT OR IGNORE INTO order_item_commits(
      order_id,user_id,idempotency_key,request_hash
    ) VALUES(?,?,?,?)`, order.id, req.user.id, idempotencyKey, requestHash);
    if (!claimed.changes) {
      const raced = q.get(`SELECT request_hash,response FROM order_item_commits
        WHERE tenant_id=? AND order_id=? AND idempotency_key=?`,
      curTenant(), order.id, idempotencyKey);
      if (raced?.request_hash !== requestHash) {
        throw Object.assign(new Error('相同幂等键对应了不同订单明细，请生成新的幂等键'), { status: 409 });
      }
      if (!raced?.response) {
        throw Object.assign(new Error('相同订单明细请求正在处理，请稍后重试'), { status: 409 });
      }
      db.exec('COMMIT');
      return res.json({ ...JSON.parse(raced.response), replayed: true });
    }
    q.run(`UPDATE orders SET store_id=?
      WHERE tenant_id=? AND id=? AND (store_id IS NULL OR store_id=?)`,
    targetStoreId, curTenant(), order.id, targetStoreId);
    const created = prepared.map(item => {
      const ret = q.run(`INSERT INTO order_items(order_id,dish_id,dish_name_snapshot,qty,unit_price,amount,discount)
        VALUES(?,?,?,?,?,?,?)`,
        order.id, item.dish_id, item.name, item.qty, item.unitPrice, item.amount, item.discount);
      return q.scopedGet('order_items', 'AND id = ?', ret.lastInsertRowid);
    });
    const payload = {
      ok: true,
      created,
      storeId: targetStoreId,
      sum: round2(created.reduce((sum, item) => sum + Number(item.amount || 0), 0)),
    };
    logOp(req.user, '经营数据', '登记订单明细', `order#${order.id} 门店#${targetStoreId} 共${created.length}条`);
    q.run(`UPDATE order_item_commits SET response=?
      WHERE tenant_id=? AND order_id=? AND idempotency_key=?`,
    JSON.stringify(payload), curTenant(), order.id, idempotencyKey);
    db.exec('COMMIT');
    res.status(201).json(payload);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ===== 真实经营 KPI（无数据的指标一律 null，绝不编造）=====
r.get('/kpi', (req, res) => {
  const month = clean(req.query.month) || today().slice(0, 7);
  if (!isMonth(month)) return res.status(400).json({ error: '月份格式应为 YYYY-MM' });
  const storeId = req.query.store_id == null || req.query.store_id === ''
    ? null
    : Number(req.query.store_id);
  if (storeId != null
    && (!Number.isInteger(storeId) || storeId <= 0
      || !q.scopedGet('stores', 'AND id = ?', storeId))) {
    return res.status(400).json({ error: '门店不存在或不属于当前企业' });
  }
  const { start, endExclusive } = monthRange(month);
  const T = curTenant();
  const orderStoreSql = storeId == null ? '' : ' AND store_id = ?';
  const orderParams = storeId == null ? [] : [storeId];
  const joinedOrderStoreSql = storeId == null ? '' : ' AND o.store_id = ?';
  const costStoreSql = storeId == null ? '' : ' AND store_id = ?';

  // 营收：订单头口径（orders 是当前唯一真实营收事实表）
  const revenue = q.get(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) a FROM orders
    WHERE tenant_id = ? AND created_at >= ? AND created_at < ?${orderStoreSql}`,
  T, start, endExclusive, ...orderParams);
  const monthRevenue = revenue?.n > 0 ? round2(revenue.a) : null;

  // 真实客单价：只统计有明细的订单，SUM(明细金额)/COUNT(DISTINCT 订单)
  const ticket = q.get(`SELECT COUNT(DISTINCT oi.order_id) orders, COALESCE(SUM(oi.amount),0) amt
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id AND o.tenant_id = oi.tenant_id
    WHERE oi.tenant_id = ? AND o.created_at >= ? AND o.created_at < ?${joinedOrderStoreSql}`,
  T, start, endExclusive, ...orderParams);
  const avgTicket = ticket?.orders > 0 ? round2(ticket.amt / ticket.orders) : null;

  // 菜品销量 TOP10：按 order_items 聚合（无明细时为空数组）
  const dishTop = q.all(`SELECT oi.dish_id, oi.dish_name_snapshot name,
      SUM(oi.qty) qty, COALESCE(SUM(oi.amount),0) amount
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id AND o.tenant_id = oi.tenant_id
    WHERE oi.tenant_id = ? AND o.created_at >= ? AND o.created_at < ?${joinedOrderStoreSql}
    GROUP BY oi.dish_id, oi.dish_name_snapshot
    ORDER BY qty DESC, amount DESC LIMIT 10`, T, start, endExclusive, ...orderParams)
    .map(x => ({ ...x, amount: round2(x.amount) }));

  // 成本按类别拆分：毛利只扣直接食材成本；全部登记成本另算经营利润率。
  const costs = q.all(`SELECT category,COUNT(*) n,COALESCE(SUM(amount),0) a FROM costs
    WHERE tenant_id = ? AND date >= ? AND date < ?${costStoreSql}
    GROUP BY category`, T, start, endExclusive, ...orderParams);
  const monthCost = costs.length
    ? round2(costs.reduce((sum, row) => sum + Number(row.a || 0), 0))
    : null;
  const directFoodRow = costs.find(row => row.category === '食材');
  const directFoodCost = directFoodRow ? round2(directFoodRow.a) : null;

  const grossMargin = monthRevenue !== null && monthRevenue > 0 && directFoodCost !== null
    ? Math.round(((monthRevenue - directFoodCost) / monthRevenue) * 1000) / 10
    : null;
  const operatingMargin = monthRevenue !== null && monthRevenue > 0 && monthCost !== null
    ? Math.round(((monthRevenue - monthCost) / monthRevenue) * 1000) / 10
    : null;
  const breakEven = monthRevenue !== null && monthCost !== null && monthCost > 0
    ? Math.round((monthRevenue / monthCost) * 1000) / 10
    : null;

  res.json({
    month,
    storeId,
    avgTicket,
    dishTop,
    grossMargin,
    operatingMargin,
    breakEven,
    monthRevenue,
    monthCost,
    directFoodCost,
    costBreakdown: Object.fromEntries(costs.map(row => [row.category, round2(row.a)])),
    note: '真实口径：客单价=有明细订单的明细金额合计÷订单数；毛利率=（订单营收−食材直接成本）÷营收；经营利润率=（订单营收−全部登记成本）÷营收；无对应数据的指标返回 null，不做估算。',
  });
});

export default r;
