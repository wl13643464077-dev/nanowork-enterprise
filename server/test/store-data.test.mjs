import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-store-data-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;
process.env.NODE_ENV = 'test';

const { db, initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { hashPassword } = await import('../src/util.js');
const storeDataRoutes = (await import('../src/routes/store-data.js')).default;

initSchema();
migrateV2();

q.run(`INSERT INTO tenants(id,name,status) VALUES(2,'门店数据租户二','已开通')
  ON CONFLICT(id) DO UPDATE SET status=excluded.status`);
const bossOneId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'store-boss-1', hashPassword('Secret123!'), '租户一老板', 'boss', '启用', 1).lastInsertRowid);
const bossTwoId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,?,?)`, 'store-boss-2', hashPassword('Secret123!'), '租户二老板', 'boss', '启用', 2).lastInsertRowid);
const userOne = { id: bossOneId, name: '租户一老板', role: 'boss', tenant_id: 1 };
const userTwo = { id: bossTwoId, name: '租户二老板', role: 'boss', tenant_id: 2 };

function appFor(user) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => {
    req.user = user;
    next();
  }));
  app.use('/store-data', storeDataRoutes);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  return app;
}

async function withServer(user, fn) {
  const server = appFor(user).listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function request(base, url, method = 'GET', body) {
  const response = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json().catch(() => ({})) };
}

let storeOneId;   // 租户一门店
let storeTwoId;   // 租户二门店
let dishAId;      // 租户一菜品A
let dishBId;      // 租户一菜品B

test('KPI 无任何数据时全部返回 null，不编造指标', async () => {
  await withServer(userOne, async base => {
    const { response, body } = await request(base, '/store-data/kpi?month=2026-07');
    assert.equal(response.status, 200);
    assert.equal(body.avgTicket, null);
    assert.equal(body.grossMargin, null);
    assert.equal(body.breakEven, null);
    assert.equal(body.monthRevenue, null);
    assert.equal(body.monthCost, null);
    assert.deepEqual(body.dishTop, []);
  });
});

test('门店 CRUD：创建/更新/校验/删除守卫', async () => {
  await withServer(userOne, async base => {
    const bad = await request(base, '/store-data/stores', 'POST', { name: '', biz_type: '正餐' });
    assert.equal(bad.response.status, 400);
    assert.match(bad.body.error, /门店名称/);

    const badType = await request(base, '/store-data/stores', 'POST', { name: '类型错误店', biz_type: '烧烤' });
    assert.equal(badType.response.status, 400);
    assert.match(badType.body.error, /业态/);

    const created = await request(base, '/store-data/stores', 'POST', {
      name: '长风街旗舰店', code: 'S001', city: '太原', area: '小店区', biz_type: '正餐', opened_at: '2025-10-01',
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.name, '长风街旗舰店');
    assert.equal(created.body.status, '营业中');
    assert.equal(created.body.tenant_id, 1);
    storeOneId = created.body.id;

    const updated = await request(base, `/store-data/stores/${storeOneId}`, 'PUT', { status: '筹备中', address: '长风街1号' });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.status, '筹备中');
    assert.equal(updated.body.address, '长风街1号');
    await request(base, `/store-data/stores/${storeOneId}`, 'PUT', { status: '营业中' });

    const list = await request(base, '/store-data/stores');
    assert.equal(list.response.status, 200);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.rows[0].dish_count, 0);
  });
});

test('菜品 CRUD：门店归属校验、筛选与上下架', async () => {
  await withServer(userOne, async base => {
    const orphan = await request(base, '/store-data/dishes', 'POST', { store_id: 9999, name: '无主菜' });
    assert.equal(orphan.response.status, 400);
    assert.match(orphan.body.error, /门店不存在/);

    const a = await request(base, '/store-data/dishes', 'POST', {
      store_id: storeOneId, name: '酸汤鱼', category: '招牌菜', price: 88, cost: 30, unit: '份',
    });
    assert.equal(a.response.status, 201);
    assert.equal(a.body.status, '在售');
    dishAId = a.body.id;

    const b = await request(base, '/store-data/dishes', 'POST', {
      store_id: storeOneId, name: '柠檬茶', category: '饮品', price: 12, cost: 3, unit: '杯',
    });
    assert.equal(b.response.status, 201);
    dishBId = b.body.id;

    const badPrice = await request(base, '/store-data/dishes', 'POST', { store_id: storeOneId, name: '负价菜', price: -1 });
    assert.equal(badPrice.response.status, 400);
    assert.match(badPrice.body.error, /售价/);

    const updated = await request(base, `/store-data/dishes/${dishAId}`, 'PUT', { price: 98, cost: 35 });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.price, 98);

    const off = await request(base, `/store-data/dishes/${dishBId}/status`, 'POST', { status: '下架' });
    assert.equal(off.response.status, 200);
    const filtered = await request(base, `/store-data/dishes?store_id=${storeOneId}&status=下架`);
    assert.equal(filtered.body.total, 1);
    assert.equal(filtered.body.rows[0].name, '柠檬茶');
    assert.equal(filtered.body.rows[0].store_name, '长风街旗舰店');
    await request(base, `/store-data/dishes/${dishBId}/status`, 'POST', { status: '在售' });

    const byCategory = await request(base, '/store-data/dishes?category=招牌菜');
    assert.equal(byCategory.body.total, 1);
    assert.equal(byCategory.body.rows[0].name, '酸汤鱼');
  });
});

test('成本 CRUD：类别/日期/金额校验与按月按店筛选', async () => {
  await withServer(userOne, async base => {
    const badCat = await request(base, '/store-data/costs', 'POST', { store_id: storeOneId, date: '2026-07-05', category: '装修', amount: 100 });
    assert.equal(badCat.response.status, 400);
    assert.match(badCat.body.error, /成本类别/);

    const badAmount = await request(base, '/store-data/costs', 'POST', { store_id: storeOneId, date: '2026-07-05', category: '食材', amount: 0 });
    assert.equal(badAmount.response.status, 400);
    assert.match(badAmount.body.error, /金额/);

    const c1 = await request(base, '/store-data/costs', 'POST', { store_id: storeOneId, date: '2026-07-05', category: '食材', amount: 60, note: '当日采购' });
    assert.equal(c1.response.status, 201);
    const c2 = await request(base, '/store-data/costs', 'POST', { store_id: storeOneId, date: '2026-07-12', category: '人力', amount: 40 });
    assert.equal(c2.response.status, 201);
    const other = await request(base, '/store-data/costs', 'POST', { store_id: storeOneId, date: '2026-06-20', category: '房租', amount: 999 });
    assert.equal(other.response.status, 201);

    const july = await request(base, '/store-data/costs?month=2026-07');
    assert.equal(july.body.total, 2);
    assert.equal(july.body.sum, 100);

    const del = await request(base, `/store-data/costs/${other.body.id}`, 'DELETE');
    assert.equal(del.response.status, 200);
    const june = await request(base, '/store-data/costs?month=2026-06');
    assert.equal(june.body.total, 0);
  });
});

test('订单明细：校验订单归属、批量登记与读取', async () => {
  const orderOne = Number(runWithTenant(1, () => q.run(
    `INSERT INTO orders(lead_id,product,amount,type,created_at) VALUES(NULL,'到店消费',110,'到店','2026-07-06 12:00:00')`,
  ).lastInsertRowid));
  const orderTwo = Number(runWithTenant(1, () => q.run(
    `INSERT INTO orders(lead_id,product,amount,type,created_at) VALUES(NULL,'到店消费',88,'到店','2026-07-08 18:30:00')`,
  ).lastInsertRowid));
  const orderNoItems = Number(runWithTenant(1, () => q.run(
    `INSERT INTO orders(lead_id,product,amount,type,created_at) VALUES(NULL,'外卖',30,'外卖','2026-07-09 11:00:00')`,
  ).lastInsertRowid));
  assert.ok(orderNoItems > 0);

  await withServer(userOne, async base => {
    const missing = await request(base, '/store-data/orders/999999/items', 'POST', { items: [{ dish_id: dishAId, qty: 1 }] });
    assert.equal(missing.response.status, 404);
    assert.match(missing.body.error, /订单不存在/);

    const badQty = await request(base, `/store-data/orders/${orderOne}/items`, 'POST', { items: [{ dish_id: dishAId, qty: 0 }] });
    assert.equal(badQty.response.status, 400);
    assert.match(badQty.body.error, /数量/);

    // 订单一：酸汤鱼98×1 + 柠檬茶12×1 = 110
    const first = await request(base, `/store-data/orders/${orderOne}/items`, 'POST', {
      items: [
        { dish_id: dishAId, qty: 1 },
        { dish_id: dishBId, qty: 1, unit_price: 12 },
      ],
    });
    assert.equal(first.response.status, 201);
    assert.equal(first.body.created.length, 2);
    assert.equal(first.body.sum, 110);
    assert.equal(first.body.created[0].dish_name_snapshot, '酸汤鱼');

    // 订单二：酸汤鱼98×1 − 优惠10 = 88
    const second = await request(base, `/store-data/orders/${orderTwo}/items`, 'POST', {
      items: [{ dish_id: dishAId, qty: 1, discount: 10 }],
    });
    assert.equal(second.response.status, 201);
    assert.equal(second.body.sum, 88);

    const read = await request(base, `/store-data/orders/${orderOne}/items`);
    assert.equal(read.response.status, 200);
    assert.equal(read.body.total, 2);
    assert.equal(read.body.sum, 110);
  });
});

test('KPI 计算：真实客单价 / 菜品TOP / 毛利率 / 盈亏平衡与月营收成本', async () => {
  await withServer(userOne, async base => {
    const { response, body } = await request(base, '/store-data/kpi?month=2026-07');
    assert.equal(response.status, 200);
    // 3 张订单头合计 110+88+30=228；其中 2 单有明细（110+88=198）
    assert.equal(body.monthRevenue, 228);
    assert.equal(body.avgTicket, 99);          // 198 / 2
    assert.equal(body.monthCost, 100);         // 60 + 40（六月房租已删）
    assert.equal(body.grossMargin, 56.1);      // (228-100)/228 = 56.1%
    assert.equal(body.breakEven, 228);         // 228/100 = 228%
    assert.equal(body.dishTop[0].name, '酸汤鱼');
    assert.equal(body.dishTop[0].qty, 2);
    assert.equal(body.dishTop[0].amount, 186); // 98 + 88
    assert.equal(body.dishTop.length, 2);

    const badMonth = await request(base, '/store-data/kpi?month=2026-13');
    assert.equal(badMonth.response.status, 400);
  });

  // 只有营收、无成本的月份：毛利率/盈亏平衡必须为 null（不编造）
  runWithTenant(1, () => q.run(
    `INSERT INTO orders(lead_id,product,amount,type,created_at) VALUES(NULL,'到店消费',500,'到店','2026-08-01 12:00:00')`,
  ));
  await withServer(userOne, async base => {
    const { body } = await request(base, '/store-data/kpi?month=2026-08');
    assert.equal(body.monthRevenue, 500);
    assert.equal(body.avgTicket, null);
    assert.equal(body.monthCost, null);
    assert.equal(body.grossMargin, null);
    assert.equal(body.breakEven, null);
  });
});

test('跨租户隔离：租户二读不到租户一的门店/菜品/成本/订单明细', async () => {
  await withServer(userTwo, async base => {
    const stores = await request(base, '/store-data/stores');
    assert.equal(stores.body.total, 0);

    const dishes = await request(base, '/store-data/dishes');
    assert.equal(dishes.body.total, 0);

    const costs = await request(base, '/store-data/costs?month=2026-07');
    assert.equal(costs.body.total, 0);

    // 直接按 id 访问租户一资源 → 404，不泄露存在性
    const storeHit = await request(base, `/store-data/stores/${storeOneId}`, 'PUT', { name: '越权改名' });
    assert.equal(storeHit.response.status, 404);
    const dishHit = await request(base, `/store-data/dishes/${dishAId}/status`, 'POST', { status: '下架' });
    assert.equal(dishHit.response.status, 404);

    // 租户二给租户一的订单挂明细必须被拒绝
    const orderOneId = q.get(`SELECT id FROM orders WHERE tenant_id=1 ORDER BY id LIMIT 1`)?.id;
    const cross = await request(base, `/store-data/orders/${orderOneId}/items`, 'POST', {
      items: [{ dish_name_snapshot: '越权菜', qty: 1, unit_price: 1 }],
    });
    assert.equal(cross.response.status, 404);

    // 租户二 KPI 不受租户一数据影响
    const kpi = await request(base, '/store-data/kpi?month=2026-07');
    assert.equal(kpi.body.monthRevenue, null);
    assert.equal(kpi.body.avgTicket, null);

    // 建自己的门店后互不可见
    const own = await request(base, '/store-data/stores', 'POST', { name: '租户二门店', biz_type: '茶饮' });
    assert.equal(own.response.status, 201);
    storeTwoId = own.body.id;
    assert.equal(db.prepare('SELECT tenant_id FROM stores WHERE id=?').get(storeTwoId).tenant_id, 2);
  });
  await withServer(userOne, async base => {
    const list = await request(base, '/store-data/stores');
    assert.ok(!list.body.rows.some(s => s.id === storeTwoId), '租户一不应看到租户二门店');
    // 租户一菜品仍是在售（租户二越权下架被拒绝）
    assert.equal(db.prepare('SELECT status FROM dishes WHERE id=?').get(dishAId).status, '在售');
  });
});

test('门店删除守卫：有关联菜品/成本时禁止删除，清理后可删', async () => {
  await withServer(userOne, async base => {
    const denied = await request(base, `/store-data/stores/${storeOneId}`, 'DELETE');
    assert.equal(denied.response.status, 400);
    assert.match(denied.body.error, /先处理关联数据/);

    // 空门店可直接删除
    const empty = await request(base, '/store-data/stores', 'POST', { name: '待关空店', biz_type: '快餐' });
    const removed = await request(base, `/store-data/stores/${empty.body.id}`, 'DELETE');
    assert.equal(removed.response.status, 200);
    assert.equal(removed.body.ok, true);
  });
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});
