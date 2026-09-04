import { Router } from 'express';
import { curTenant, q } from '../db.js';
import { logOp, requireRole, today, daysAgo } from '../util.js';
import { generate } from '../engines/ai.js';
import { textModelFor, yunwuAvailable } from '../engines/yunwu.js';
import { assertRealAiOutput } from '../engines/ai-delivery-status.js';
import {
  estimateCallCredits,
  holdCredits,
  precheckByRole,
  releaseHold,
  settleHold,
} from '../engines/credits.js';
import { executeHeldDelivery } from '../engines/two-phase-delivery.js';
import { storeScopeClause } from '../engines/access.js';
import { resolveWriteStoreId } from '../engines/store-scope.js';

// ===== 门店日常操作台：日清检查 / 沽清板 / 排班考勤 / AI 晨会 =====
// 定位：店长和员工每天开门要用的操作性功能（勾选留痕、真实台账），
// 与数字员工的「咨询建议」互补。全部数据按租户隔离。
// 多门店：读取带「当前门店」过滤（X-Store-Id / 员工绑定店，未传=全店不过滤）；
// 写入默认落到 X-Store-Id → 用户绑定店 → 租户默认店，单店客户零感知。

const r = Router();
const storeFilter = (user, column = 'store_id') => storeScopeClause(user, column);
const writeStoreId = (user, explicit = null) => resolveWriteStoreId(user, explicit);

// —— 日清清单模板（行业标准 SOP，v1 为固定模板）——
export const CHECKLIST_TEMPLATES = Object.freeze([
  {
    key: 'opening',
    name: '开店检查',
    period: '早班开门后 30 分钟内完成',
    items: [
      { key: 'power', label: '水电气开启正常，设备无异响' },
      { key: 'clean', label: '就餐区/后厨地面台面清洁到位' },
      { key: 'stock', label: '当日食材验收：数量与新鲜度核对' },
      { key: 'thaw', label: '解冻/预制品按规范放置并标注时间' },
      { key: 'pos', label: '收银/点单/外卖接单设备在线' },
      { key: 'staff', label: '当班人员到岗，仪容仪表合格' },
    ],
  },
  {
    key: 'morning_check',
    name: '晨检记录（食安）',
    period: '员工上岗前',
    items: [
      { key: 'health', label: '当班员工体温与健康状况无异常' },
      { key: 'wound', label: '手部无伤口，无腹泻/呕吐等症状' },
      { key: 'uniform', label: '工装帽口罩穿戴齐全' },
    ],
  },
  {
    key: 'disinfect',
    name: '消毒记录（食安）',
    period: '按时段执行',
    items: [
      { key: 'tableware', label: '餐具消毒完成（消毒柜/煮沸）并记录' },
      { key: 'surface', label: '操作台面/砧板/刀具分类消毒' },
      { key: 'dining', label: '就餐区桌椅消毒擦拭' },
    ],
  },
  {
    key: 'sample',
    name: '留样记录（食安）',
    period: '每餐次出品后',
    items: [
      { key: 'kept', label: '每餐次菜品留样 ≥125g，专柜冷藏' },
      { key: 'label', label: '留样标签：品名/时间/操作人齐全' },
      { key: 'clear', label: '超 48 小时留样已按规范处理' },
    ],
  },
  {
    key: 'handover',
    name: '交接班',
    period: '班次交替时',
    items: [
      { key: 'cash', label: '现金/收银对账清点无误' },
      { key: 'todo', label: '未完成事项与注意事项已交代' },
      { key: 'stock2', label: '剩余食材/沽清情况已同步' },
    ],
  },
  {
    key: 'closing',
    name: '闭店检查',
    period: '闭店前完成',
    items: [
      { key: 'gas', label: '燃气/电源关闭，冰箱冷柜正常' },
      { key: 'trash', label: '垃圾清运，地漏/下水无堵塞' },
      { key: 'food', label: '食材归位加盖，生熟分离' },
      { key: 'lock', label: '门窗上锁，监控/报警开启' },
      { key: 'cash2', label: '当日营收核对并记账' },
    ],
  },
]);

const CHECKLIST_BY_KEY = new Map(CHECKLIST_TEMPLATES.map(item => [item.key, item]));

r.get('/checklists/today', (req, res) => {
  const date = today();
  const sf = storeFilter(req.user);
  const marks = q.all(
    `SELECT checklist_key, item_key, done_by_name, created_at
     FROM store_checklist_marks WHERE tenant_id=? AND date=?${sf.sql}`,
    curTenant(),
    date,
    ...sf.params,
  );
  const markMap = new Map(marks.map(mark => [`${mark.checklist_key}:${mark.item_key}`, mark]));
  const checklists = CHECKLIST_TEMPLATES.map(template => {
    const items = template.items.map(item => {
      const mark = markMap.get(`${template.key}:${item.key}`);
      return {
        ...item,
        done: Boolean(mark),
        doneBy: mark?.done_by_name || null,
        doneAt: mark?.created_at || null,
      };
    });
    const doneCount = items.filter(item => item.done).length;
    return { key: template.key, name: template.name, period: template.period, items, doneCount, total: items.length };
  });
  const total = checklists.reduce((sum, list) => sum + list.total, 0);
  const done = checklists.reduce((sum, list) => sum + list.doneCount, 0);
  res.set('Cache-Control', 'private, no-store');
  res.json({ date, checklists, total, done });
});

r.post('/checklists/:key/toggle', (req, res) => {
  const template = CHECKLIST_BY_KEY.get(String(req.params.key));
  if (!template) return res.status(404).json({ error: '清单不存在' });
  const itemKey = String(req.body?.itemKey || '');
  if (!template.items.some(item => item.key === itemKey)) {
    return res.status(400).json({ error: '检查项不存在' });
  }
  const date = today();
  const storeId = writeStoreId(req.user);
  const existing = q.get(
    `SELECT id, done_by_name FROM store_checklist_marks WHERE tenant_id=? AND date=? AND checklist_key=? AND item_key=? AND store_id IS ?`,
    curTenant(),
    date,
    template.key,
    itemKey,
    storeId,
  );
  // 多端同用（前厅平板+店长手机）时盲翻会互相打架：前端带目标态 done 则幂等落地，
  // 目标态与现状一致直接 no-op；不带 done 保留老的取反行为（兼容旧客户端）。
  const target = typeof req.body?.done === 'boolean' ? req.body.done : !existing;
  if (target === Boolean(existing)) {
    return res.json({ ok: true, done: Boolean(existing), doneBy: existing?.done_by_name || null, unchanged: true });
  }
  if (!target) {
    q.run('DELETE FROM store_checklist_marks WHERE tenant_id=? AND id=?', curTenant(), existing.id);
    return res.json({ ok: true, done: false });
  }
  q.run(
    `INSERT INTO store_checklist_marks(tenant_id,date,checklist_key,item_key,done_by,done_by_name,store_id)
     VALUES(?,?,?,?,?,?,?)`,
    curTenant(),
    date,
    template.key,
    itemKey,
    req.user.id,
    req.user.name,
    storeId,
  );
  res.json({ ok: true, done: true, doneBy: req.user.name, storeId });
});

// 近 7 天完成率（驾驶舱/店长视图用）；daysAgo(6)+今天 = 恰好 7 个自然日
r.get('/checklists/summary', (req, res) => {
  const totalItems = CHECKLIST_TEMPLATES.reduce((sum, template) => sum + template.items.length, 0);
  const sf = storeFilter(req.user);
  const rows = q.all(
    `SELECT date, COUNT(*) done FROM store_checklist_marks
     WHERE tenant_id=? AND date >= ?${sf.sql} GROUP BY date ORDER BY date DESC`,
    curTenant(),
    daysAgo(6),
    ...sf.params,
  );
  res.set('Cache-Control', 'private, no-store');
  res.json({
    totalItems,
    days: rows.map(row => ({ date: row.date, done: Number(row.done), rate: Math.round((Number(row.done) / totalItems) * 100) })),
  });
});

// —— 今日沽清板 ——
r.get('/soldout/today', (req, res) => {
  const date = today();
  const sf = storeFilter(req.user, 'd.store_id');
  const dishes = q.all(
    `SELECT d.id, d.name, d.category, d.price,
      (SELECT m.soldout FROM dish_soldout_marks m
       WHERE m.tenant_id=? AND m.date=? AND m.dish_id=d.id
       ORDER BY m.id DESC LIMIT 1) soldout,
      (SELECT m.marked_by_name FROM dish_soldout_marks m
       WHERE m.tenant_id=? AND m.date=? AND m.dish_id=d.id
       ORDER BY m.id DESC LIMIT 1) markedBy
     FROM dishes d WHERE d.tenant_id=? AND (d.status IS NULL OR d.status != '下架')${sf.sql}
     ORDER BY d.category, d.name`,
    curTenant(),
    date,
    curTenant(),
    date,
    curTenant(),
    ...sf.params,
  );
  // 备货预警（行业 SOP：高频沽清 SKU 要进行动清单）：近 7 天收盘态为沽清 ≥3 天的菜品。
  // 标记表是 append-only，必须取「每菜每天最后一条」判定当日状态，
  // 否则上午沽清下午恢复的日子也会被误计为沽清日；已下架菜不进预警。
  const frequentSoldout = q.all(
    `SELECT d.name, COUNT(*) days FROM (
       SELECT dish_id, date, MAX(id) mid FROM dish_soldout_marks
       WHERE tenant_id=? AND date >= ? GROUP BY dish_id, date
     ) lastm
     JOIN dish_soldout_marks m ON m.id = lastm.mid AND m.soldout = 1
     JOIN dishes d ON d.id = lastm.dish_id
     WHERE (d.status IS NULL OR d.status != '下架')${sf.sql}
     GROUP BY lastm.dish_id HAVING days >= 3
     ORDER BY days DESC LIMIT 6`,
    curTenant(),
    daysAgo(6),
    ...sf.params,
  );
  res.set('Cache-Control', 'private, no-store');
  res.json({
    date,
    dishes: dishes.map(dish => ({ ...dish, soldout: Number(dish.soldout) === 1 })),
    soldoutCount: dishes.filter(dish => Number(dish.soldout) === 1).length,
    frequentSoldout: frequentSoldout.map(row => ({ name: row.name, days: Number(row.days) })),
  });
});

r.post('/soldout/:dishId/toggle', (req, res) => {
  const dishId = Number(req.params.dishId);
  const dish = q.get('SELECT id, name, status, store_id FROM dishes WHERE tenant_id=? AND id=?', curTenant(), dishId);
  if (!dish) return res.status(404).json({ error: '菜品不存在' });
  if (dish.status === '下架') return res.status(400).json({ error: '菜品已下架，无需标记沽清' });
  const date = today();
  const last = q.get(
    `SELECT soldout FROM dish_soldout_marks WHERE tenant_id=? AND date=? AND dish_id=?
     ORDER BY id DESC LIMIT 1`,
    curTenant(),
    date,
    dishId,
  );
  const current = Number(last?.soldout) === 1 ? 1 : 0;
  // 带目标态则幂等落地（多端同用不互翻）；与现状一致直接 no-op，不追加日志行
  const next = typeof req.body?.soldout === 'boolean' ? (req.body.soldout ? 1 : 0) : (current === 1 ? 0 : 1);
  if (next === current) {
    return res.json({ ok: true, soldout: next === 1, unchanged: true });
  }
  q.run(
    `INSERT INTO dish_soldout_marks(tenant_id,date,dish_id,soldout,marked_by,marked_by_name,store_id)
     VALUES(?,?,?,?,?,?,?)`,
    curTenant(),
    date,
    dishId,
    next,
    req.user.id,
    req.user.name,
    dish.store_id ?? writeStoreId(req.user),
  );
  logOp(req.user, '门店日常', next ? '标记沽清' : '恢复供应', dish.name);
  res.json({ ok: true, soldout: next === 1 });
});

// —— 排班（班次模板为常量；店长/管理角色可排，全员可看）——
export const SHIFT_TEMPLATES = Object.freeze([
  { key: 'morning', label: '早班', time: '09:00-17:00', color: '#2f6bda' },
  { key: 'middle', label: '中班', time: '11:00-19:00', color: '#0f9f89' },
  { key: 'evening', label: '晚班', time: '15:00-23:00', color: '#7a5bd8' },
  { key: 'full', label: '全班', time: '09:00-21:00', color: '#d97f2b' },
  { key: 'off', label: '休', time: '休息', color: '#8a919a' },
]);
const SHIFT_KEYS = new Set(SHIFT_TEMPLATES.map(item => item.key));
const SCHEDULER_ROLES = new Set(['boss', 'admin', 'ops_director', 'manager']);

function weekDates(startDate) {
  const base = /^\d{4}-\d{2}-\d{2}$/u.test(String(startDate || '')) ? new Date(`${startDate}T00:00:00`) : new Date();
  // 归一到周一
  const day = base.getDay() || 7;
  base.setDate(base.getDate() - day + 1);
  return Array.from({ length: 7 }, (_, index) => {
    const d = new Date(base);
    d.setDate(base.getDate() + index);
    // 必须用本地时区取日期：toISOString 是 UTC，会让晚间（UTC+8 的 0-8 点前一天）排班整体错一天
    return d.toLocaleDateString('sv-SE');
  });
}

r.get('/shifts/week', (req, res) => {
  const dates = weekDates(req.query.start);
  // 多门店：当前门店生效时只排本店员工（含未绑定门店的总部人员，便于跨店支援）
  const sf = storeFilter(req.user);
  const staffStoreSql = sf.sql ? ' AND (store_id = ? OR store_id IS NULL)' : '';
  const staff = q.all(
    `SELECT id, name, role, dept, store_id FROM users
     WHERE tenant_id=? AND status='启用' AND role IN ('sales','manager','ops_director')${staffStoreSql}
     ORDER BY CASE role WHEN 'ops_director' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, id`,
    curTenant(),
    ...sf.params,
  );
  const assignments = q.all(
    `SELECT user_id, date, shift_key, store_id FROM shift_assignments
     WHERE tenant_id=? AND date BETWEEN ? AND ?${sf.sql}`,
    curTenant(),
    dates[0],
    dates[6],
    ...sf.params,
  );
  const attendance = q.all(
    `SELECT user_id, date, clock_in, clock_out FROM attendance_records
     WHERE tenant_id=? AND date BETWEEN ? AND ?${sf.sql}`,
    curTenant(),
    dates[0],
    dates[6],
    ...sf.params,
  );
  res.set('Cache-Control', 'private, no-store');
  res.json({
    dates,
    templates: SHIFT_TEMPLATES,
    canSchedule: SCHEDULER_ROLES.has(req.user.role),
    staff,
    assignments,
    attendance,
  });
});

r.put('/shifts/assign', (req, res) => {
  if (!SCHEDULER_ROLES.has(req.user.role)) return res.status(403).json({ error: '仅店长及以上可以排班' });
  const userId = Number(req.body?.userId);
  const date = String(req.body?.date || '');
  const shiftKey = String(req.body?.shiftKey || '');
  if (!Number.isSafeInteger(userId) || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    return res.status(400).json({ error: '排班参数不正确' });
  }
  const staff = q.get("SELECT id, name, store_id FROM users WHERE tenant_id=? AND id=? AND status='启用'", curTenant(), userId);
  if (!staff) return res.status(404).json({ error: '员工不存在或已停用' });
  if (shiftKey === '') {
    q.run('DELETE FROM shift_assignments WHERE tenant_id=? AND user_id=? AND date=?', curTenant(), userId, date);
    return res.json({ ok: true, cleared: true });
  }
  if (!SHIFT_KEYS.has(shiftKey)) return res.status(400).json({ error: '班次不存在' });
  // 排班归属：被排员工的绑定店 → 当前门店上下文 → 排班人的绑定店 → 默认店
  const shiftStoreId = resolveWriteStoreId(req.user, null, { preferUser: staff });
  q.run(
    `INSERT INTO shift_assignments(tenant_id,user_id,date,shift_key,assigned_by,store_id)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(tenant_id,user_id,date) DO UPDATE SET shift_key=excluded.shift_key, assigned_by=excluded.assigned_by, store_id=excluded.store_id`,
    curTenant(),
    userId,
    date,
    shiftKey,
    req.user.id,
    shiftStoreId,
  );
  res.json({ ok: true, storeId: shiftStoreId });
});

// —— 考勤：一键上下班打卡 ——
r.post('/attendance/clock', (req, res) => {
  const direction = String(req.body?.direction || '');
  if (!['in', 'out'].includes(direction)) return res.status(400).json({ error: '打卡方向不正确' });
  const date = today();
  const now = new Date().toTimeString().slice(0, 8);
  const existing = q.get(
    'SELECT * FROM attendance_records WHERE tenant_id=? AND user_id=? AND date=?',
    curTenant(),
    req.user.id,
    date,
  );
  if (direction === 'in') {
    if (existing?.clock_in) return res.status(409).json({ error: `今天 ${existing.clock_in} 已打过上班卡` });
    q.run(
      `INSERT INTO attendance_records(tenant_id,user_id,date,clock_in,store_id) VALUES(?,?,?,?,?)
       ON CONFLICT(tenant_id,user_id,date) DO UPDATE SET clock_in=excluded.clock_in, store_id=COALESCE(attendance_records.store_id, excluded.store_id)`,
      curTenant(),
      req.user.id,
      date,
      now,
      writeStoreId(req.user),
    );
  } else {
    if (!existing?.clock_in) return res.status(409).json({ error: '还没打上班卡' });
    // 考勤是工时依据：下班卡以第一次为准，不允许无感覆盖
    if (existing?.clock_out) return res.status(409).json({ error: `今天 ${existing.clock_out} 已打过下班卡` });
    q.run(
      'UPDATE attendance_records SET clock_out=? WHERE tenant_id=? AND user_id=? AND date=?',
      now,
      curTenant(),
      req.user.id,
      date,
    );
  }
  logOp(req.user, '门店日常', direction === 'in' ? '上班打卡' : '下班打卡', now);
  res.json({ ok: true, time: now });
});

r.get('/attendance/mine', (req, res) => {
  const rows = q.all(
    `SELECT date, clock_in, clock_out FROM attendance_records
     WHERE tenant_id=? AND user_id=? AND date >= ? ORDER BY date DESC`,
    curTenant(),
    req.user.id,
    daysAgo(14),
  );
  const todayRow = rows.find(row => row.date === today()) || null;
  res.set('Cache-Control', 'private, no-store');
  res.json({ today: todayRow, records: rows });
});

// —— 库存台账：当前量/安全线/变动留痕/订货建议 ——
r.get('/inventory', (req, res) => {
  const sf = storeFilter(req.user);
  const items = q.all(
    `SELECT * FROM inventory_items WHERE tenant_id=?${sf.sql} ORDER BY
      CASE WHEN quantity < safe_line THEN 0 ELSE 1 END, category, name`,
    curTenant(),
    ...sf.params,
  );
  res.set('Cache-Control', 'private, no-store');
  res.json({
    items,
    lowCount: items.filter(item => Number(item.quantity) < Number(item.safe_line)).length,
  });
});

r.post('/inventory', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 60) return res.status(400).json({ error: '请填写 60 字以内的物料名称' });
  const unit = String(req.body?.unit || '份').slice(0, 10);
  const category = String(req.body?.category || '').slice(0, 30) || null;
  const quantity = Math.max(0, Number(req.body?.quantity) || 0);
  const safeLine = Math.max(0, Number(req.body?.safeLine) || 0);
  const storeId = writeStoreId(req.user, req.body?.storeId);
  // 同名判重按门店：连锁各店可各有一份「大米」台账；历史无门店行（store_id NULL）仍全租户判重
  const exists = q.get(
    'SELECT id FROM inventory_items WHERE tenant_id=? AND name=? AND (store_id IS ? OR store_id IS NULL)',
    curTenant(),
    name,
    storeId,
  );
  if (exists) return res.status(409).json({ error: '同名物料已存在，请直接调整数量' });
  const created = q.run(
    `INSERT INTO inventory_items(tenant_id,name,category,unit,quantity,safe_line,updated_by_name,store_id)
     VALUES(?,?,?,?,?,?,?,?)`,
    curTenant(),
    name,
    category,
    unit,
    quantity,
    safeLine,
    req.user.name,
    storeId,
  );
  if (quantity > 0) {
    q.run(
      `INSERT INTO inventory_moves(tenant_id,item_id,delta,reason,moved_by,moved_by_name,store_id)
       VALUES(?,?,?,?,?,?,?)`,
      curTenant(),
      Number(created.lastInsertRowid),
      quantity,
      '入库',
      req.user.id,
      req.user.name,
      storeId,
    );
  }
  logOp(req.user, '门店日常', '新建库存物料', name);
  res.json({ ok: true, id: Number(created.lastInsertRowid) });
});

r.post('/inventory/:id/move', (req, res) => {
  const item = q.get('SELECT * FROM inventory_items WHERE tenant_id=? AND id=?', curTenant(), Number(req.params.id));
  if (!item) return res.status(404).json({ error: '物料不存在' });
  const reason = String(req.body?.reason || '');
  if (!['入库', '出库', '盘点修正'].includes(reason)) return res.status(400).json({ error: '变动类型不正确' });
  const rawValue = Number(req.body?.value);
  if (!Number.isFinite(rawValue)) return res.status(400).json({ error: '数量必须是数字' });
  let nextQuantity;
  let delta;
  if (reason === '盘点修正') {
    nextQuantity = Math.max(0, rawValue);
    delta = nextQuantity - Number(item.quantity);
  } else {
    const amount = Math.abs(rawValue);
    if (!amount) return res.status(400).json({ error: '数量不能为 0' });
    delta = reason === '入库' ? amount : -amount;
    nextQuantity = Number(item.quantity) + delta;
    if (nextQuantity < 0) return res.status(400).json({ error: `出库超过当前库存（现有 ${item.quantity}${item.unit}）` });
  }
  q.run(
    `UPDATE inventory_items SET quantity=?, updated_at=datetime('now','localtime'), updated_by_name=?
     WHERE tenant_id=? AND id=?`,
    nextQuantity,
    req.user.name,
    curTenant(),
    item.id,
  );
  q.run(
    `INSERT INTO inventory_moves(tenant_id,item_id,delta,reason,note,moved_by,moved_by_name,store_id)
     VALUES(?,?,?,?,?,?,?,?)`,
    curTenant(),
    item.id,
    delta,
    reason,
    String(req.body?.note || '').slice(0, 100) || null,
    req.user.id,
    req.user.name,
    item.store_id ?? null,
  );
  logOp(req.user, '门店日常', `库存${reason}`, `${item.name} ${delta > 0 ? '+' : ''}${delta}${item.unit}`);
  res.json({ ok: true, quantity: nextQuantity });
});

// 台账物理删除只留给管理层（普通员工可改数量但不能销毁盘点历史）
r.delete('/inventory/:id', requireRole('boss', 'admin', 'ops_director', 'manager'), (req, res) => {
  const item = q.get('SELECT id,name FROM inventory_items WHERE tenant_id=? AND id=?', curTenant(), Number(req.params.id));
  if (!item) return res.status(404).json({ error: '物料不存在' });
  q.run('DELETE FROM inventory_items WHERE tenant_id=? AND id=?', curTenant(), item.id);
  q.run('DELETE FROM inventory_moves WHERE tenant_id=? AND item_id=?', curTenant(), item.id);
  logOp(req.user, '门店日常', '删除库存物料', item.name);
  res.json({ ok: true });
});

// 订货建议：低于安全线的物料按缺口生成清单（纯事实计算，不调用 AI）
r.get('/inventory/reorder', (req, res) => {
  const sf = storeFilter(req.user);
  const items = q.all(
    `SELECT name, category, unit, quantity, safe_line FROM inventory_items
     WHERE tenant_id=? AND quantity < safe_line${sf.sql} ORDER BY category, name`,
    curTenant(),
    ...sf.params,
  );
  res.set('Cache-Control', 'private, no-store');
  res.json({
    items: items.map(item => ({
      ...item,
      gap: Math.max(0, Number(item.safe_line) - Number(item.quantity)),
    })),
  });
});

// —— 外卖日报：按平台按天手录，看板汇总 ——
const DELIVERY_PLATFORMS = new Set(['美团', '饿了么', '其他']);

r.post('/delivery-daily', (req, res) => {
  const platform = String(req.body?.platform || '');
  if (!DELIVERY_PLATFORMS.has(platform)) return res.status(400).json({ error: '平台仅支持：美团/饿了么/其他' });
  // 日期传了但格式不对必须报错：静默回退到今天会把补录的昨日数据覆盖到今天（UPSERT）
  const rawDate = String(req.body?.date || '').trim();
  if (rawDate && !/^\d{4}-\d{2}-\d{2}$/u.test(rawDate)) {
    return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD，例如 2026-08-27' });
  }
  const date = rawDate || today();
  const orders = Math.max(0, Math.trunc(Number(req.body?.orders) || 0));
  const revenue = Math.max(0, Number(req.body?.revenue) || 0);
  const rating = req.body?.rating != null && req.body?.rating !== '' ? Math.min(5, Math.max(0, Number(req.body.rating))) : null;
  const avgPrepMinutes =
    req.body?.avgPrepMinutes != null && req.body?.avgPrepMinutes !== ''
      ? Math.max(0, Number(req.body.avgPrepMinutes))
      : null;
  const badReviews = Math.max(0, Math.trunc(Number(req.body?.badReviews) || 0));
  const storeId = writeStoreId(req.user, req.body?.storeId);
  if (!storeId) return res.status(400).json({ error: '所属门店不存在或不属于当前企业' });
  // 唯一键已是「租户+门店+日期+平台」：连锁各店同日同平台各记一条
  q.run(
    `INSERT INTO delivery_daily(tenant_id,date,platform,orders,revenue,rating,avg_prep_minutes,bad_reviews,recorded_by,store_id)
     VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id,store_id,date,platform) DO UPDATE SET
       orders=excluded.orders, revenue=excluded.revenue, rating=excluded.rating,
       avg_prep_minutes=excluded.avg_prep_minutes, bad_reviews=excluded.bad_reviews,
       recorded_by=excluded.recorded_by, updated_at=datetime('now','localtime')`,
    curTenant(),
    date,
    platform,
    orders,
    revenue,
    rating,
    avgPrepMinutes,
    badReviews,
    req.user.id,
    storeId,
  );
  logOp(req.user, '门店日常', '外卖日报', `${date} ${platform} ${orders}单/¥${revenue}`);
  res.json({ ok: true, date, platform, storeId });
});

r.get('/delivery-daily', (req, res) => {
  const sf = storeFilter(req.user);
  const rows = q.all(
    `SELECT * FROM delivery_daily WHERE tenant_id=? AND date >= ?${sf.sql} ORDER BY date DESC, platform`,
    curTenant(),
    daysAgo(30),
    ...sf.params,
  );
  const last7 = rows.filter(row => row.date >= daysAgo(6)); // 含今天恰好 7 个自然日
  const sum = list => ({
    orders: list.reduce((total, row) => total + Number(row.orders), 0),
    revenue: Math.round(list.reduce((total, row) => total + Number(row.revenue), 0)),
    badReviews: list.reduce((total, row) => total + Number(row.bad_reviews), 0),
    ratings: list.filter(row => row.rating != null),
  });
  const week = sum(last7);
  res.set('Cache-Control', 'private, no-store');
  res.json({
    rows,
    summary: {
      weekOrders: week.orders,
      weekRevenue: week.revenue,
      weekBadReviews: week.badReviews,
      weekAvgRating: week.ratings.length
        ? Number((week.ratings.reduce((total, row) => total + Number(row.rating), 0) / week.ratings.length).toFixed(2))
        : null,
    },
  });
});

// —— AI 晨会助手：读昨日真实经营数据生成晨会要点（真实计费，fail-closed）——
r.post('/morning-brief', async (req, res) => {
  if (!yunwuAvailable()) return res.status(503).json({ error: '真实 AI 通道未配置，无法生成晨会要点' });
  const yesterday = daysAgo(1);
  // 多门店：当前门店生效时晨会只读本店事实（未传头=全店，与现状一致）
  const sf = storeFilter(req.user);
  const sfDish = storeFilter(req.user, 'd.store_id');
  const sfShift = storeFilter(req.user, 's.store_id');
  const ops = q.get(`SELECT * FROM daily_ops WHERE tenant_id=? AND date=?${sf.sql}`, curTenant(), yesterday, ...sf.params) || {};
  const orderStats = q.get(
    `SELECT COUNT(*) n, COALESCE(SUM(amount),0) amount FROM orders
     WHERE tenant_id=? AND date(created_at)=?${sf.sql}`,
    curTenant(),
    yesterday,
    ...sf.params,
  ) || { n: 0, amount: 0 };
  const badReviews = q.get(
    `SELECT COUNT(*) n FROM store_reviews WHERE tenant_id=? AND rating <= 3 AND status='待回复'${sf.sql}`,
    curTenant(),
    ...sf.params,
  )?.n || 0;
  // 以「昨日最后一条标记」为准：中途恢复供应的菜不算沽清（与看板口径一致）
  const soldoutYesterday = q.all(
    `SELECT d.name FROM (
       SELECT dish_id, MAX(id) mid FROM dish_soldout_marks
       WHERE tenant_id=? AND date=? GROUP BY dish_id
     ) lastm
     JOIN dish_soldout_marks m ON m.id = lastm.mid AND m.soldout = 1
     JOIN dishes d ON d.id = lastm.dish_id WHERE 1=1${sfDish.sql} LIMIT 10`,
    curTenant(),
    yesterday,
    ...sfDish.params,
  ).map(row => row.name);
  const todayShifts = q.all(
    `SELECT u.name, s.shift_key FROM shift_assignments s JOIN users u ON u.id=s.user_id
     WHERE s.tenant_id=? AND s.date=?${sfShift.sql}`,
    curTenant(),
    today(),
    ...sfShift.params,
  );
  const shiftLabel = new Map(SHIFT_TEMPLATES.map(item => [item.key, item.label]));
  // ===== 业务串联：晨会是各台账的收口点，把库存/高频沽清/日清/被点名菜一并交给 AI =====
  const lowInventory = q.all(
    `SELECT name, quantity, safe_line, unit FROM inventory_items
     WHERE tenant_id=? AND quantity < safe_line${sf.sql} ORDER BY (safe_line - quantity) DESC LIMIT 8`,
    curTenant(),
    ...sf.params,
  );
  const frequentSoldout = q.all(
    `SELECT d.name, COUNT(*) days FROM (
       SELECT dish_id, date, MAX(id) mid FROM dish_soldout_marks
       WHERE tenant_id=? AND date >= ? GROUP BY dish_id, date
     ) lastm
     JOIN dish_soldout_marks m ON m.id = lastm.mid AND m.soldout = 1
     JOIN dishes d ON d.id = lastm.dish_id
     WHERE (d.status IS NULL OR d.status != '下架')${sfDish.sql}
     GROUP BY lastm.dish_id HAVING days >= 3 ORDER BY days DESC LIMIT 5`,
    curTenant(),
    daysAgo(6),
    ...sfDish.params,
  );
  const checklistTotalItems = CHECKLIST_TEMPLATES.reduce((sum, template) => sum + template.items.length, 0);
  const checklistDoneYesterday = q.get(
    `SELECT COUNT(*) n FROM store_checklist_marks WHERE tenant_id=? AND date=?${sf.sql}`,
    curTenant(),
    yesterday,
    ...sf.params,
  )?.n || 0;
  const mentionedDishes = (() => {
    const dishes = q.all(
      `SELECT name FROM dishes WHERE tenant_id=? AND (status IS NULL OR status != '下架')${sf.sql}`,
      curTenant(),
      ...sf.params,
    );
    if (!dishes.length) return [];
    const badBodies = q.all(
      `SELECT content FROM store_reviews WHERE tenant_id=? AND rating<=3 AND created_at >= datetime('now','localtime','-7 days') LIMIT 200`,
      curTenant(),
    );
    return dishes
      .map(dish => ({ name: dish.name, count: badBodies.filter(row => String(row.content || '').includes(dish.name)).length }))
      .filter(item => item.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  })();
  const factsBlock = [
    `昨日（${yesterday}）经营事实：`,
    `- 订单 ${orderStats.n} 单，营收 ¥${Math.round(Number(orderStats.amount))}`,
    `- 日报：新增线索 ${ops.new_leads || 0}，邀约 ${ops.invited || 0}，到店 ${ops.arrived || 0}，内容发布 ${ops.content_count || 0}`,
    `- 待回复差评（当前累计）：${badReviews} 条`,
    mentionedDishes.length
      ? `- 近7天差评点名的菜品：${mentionedDishes.map(item => `${item.name}(${item.count}次)`).join('、')}（优先复盘出品）`
      : '',
    soldoutYesterday.length ? `- 昨日沽清菜品：${soldoutYesterday.join('、')}` : '- 昨日无沽清记录',
    frequentSoldout.length
      ? `- 近7天高频沽清（≥3天）：${frequentSoldout.map(row => `${row.name}(${row.days}天)`).join('、')}（备货量要上调）`
      : '',
    lowInventory.length
      ? `- 库存低于安全线：${lowInventory.map(item => `${item.name}(现${item.quantity}${item.unit}/线${item.safe_line}${item.unit})`).join('、')}（今天要订货）`
      : '- 库存都在安全线以上',
    `- 昨日日清完成：${checklistDoneYesterday}/${checklistTotalItems} 项${checklistDoneYesterday < checklistTotalItems ? '（有漏检，今天补上）' : ''}`,
    todayShifts.length
      ? `- 今日排班：${todayShifts.map(row => `${row.name}(${shiftLabel.get(row.shift_key) || row.shift_key})`).join('、')}`
      : '- 今日暂无排班记录',
  ].filter(Boolean).join('\n');
  const model = textModelFor('sales');
  let hold = null;
  try {
    precheckByRole(req.user.id, 'text', req.user.role);
    hold = holdCredits({
      userId: req.user.id,
      feature: '门店日常·AI 晨会要点',
      kind: 'text',
      model,
      credits: estimateCallCredits({ model, outputTokens: 4000, texts: [factsBlock] }),
      refType: null,
      refId: null,
    });
    const deliveryHold = hold;
    hold = null;
    const delivered = await executeHeldDelivery({
      hold: deliveryHold,
      generate: async () => {
        let output = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          output = await generate({
            kind: 'store-morning-brief',
            system: [
              '你是餐饮门店的值班店长助理，根据昨日真实经营事实生成今天的晨会要点。',
              '只依据给出的事实，不得编造数字；某项没有数据就跳过或如实说明。',
              '输出格式（纯文本，不要 Markdown 记号）：',
              '【昨日战报】2-3 句：营收/订单/亮点或问题',
              '【今日重点】3-4 条：今天最该抓的事（结合差评、沽清、排班情况）',
              '【提醒】1-2 条：食安/服务的当日提醒',
              '全文不超过 300 字，口语化，店长念出来就能开会。',
              factsBlock,
            ].join('\n'),
            userMsg: '请生成今天的晨会要点。',
            fallback: () => '',
            maxTokens: 4000,
            role: req.user.role,
            model,
            providerPolicy: 'yunwu_only',
            signal: req.requestSignal,
          });
          const retryable =
            output?.mode !== 'api' &&
            ['provider_rate_limited', 'provider_empty_output'].includes(output?.providerFailure?.code);
          if (!retryable || attempt === 2) break;
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        assertRealAiOutput(output, { label: 'AI 晨会要点', noDelivery: '本次不生成晨会要点，也不扣费' });
        const text = String(output.text || '').trim();
        if (text.length < 40) {
          throw Object.assign(new Error('晨会要点过于简略，已拒收，请重试'), { status: 422 });
        }
        return { text, output };
      },
      persist: generated => generated.text,
      settle: settleHold,
      release: releaseHold,
      settlement: generated => ({
        usage: generated.output.usage,
        model: generated.output.model,
        aiMode: generated.output.mode,
        note: 'AI 晨会要点：按昨日真实经营数据生成',
      }),
      requirePositiveApiUsage: true,
      releaseNote: '晨会要点未交付，预授权全额退回',
    });
    logOp(req.user, '门店日常', 'AI 晨会要点', yesterday);
    res.set('Cache-Control', 'private, no-store');
    return res.json({ brief: delivered.delivery, facts: factsBlock, billing: delivered.billing });
  } catch (error) {
    if (hold) {
      try {
        releaseHold(hold, '晨会要点未进入模型生成，预授权全额退回');
      } catch { /* 保留原始错误 */ }
      hold = null;
    }
    return res.status(error.status || 502).json({
      error: String(error?.message || 'AI 晨会要点生成失败').slice(0, 200),
      ...(error.billing ? { billing: error.billing } : {}),
    });
  }
});

export default r;
