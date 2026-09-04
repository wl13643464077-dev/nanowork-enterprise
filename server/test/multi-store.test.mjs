// 多门店（连锁）数据模型：迁移回填幂等、默认门店、X-Store-Id 权限矩阵、读取过滤、写入默认、
// manager 本店范围、总部对比、开店向导兼容。原则：不传头 = 全店，一切照旧。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const DB_PATH = path.join(os.tmpdir(), `nanowork-multi-store-${process.pid}-${Date.now()}.db`);
const DATABASE_FILES = [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`];
for (const file of DATABASE_FILES) fs.rmSync(file, { force: true });

process.env.NANOWORK_DB = DB_PATH;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'Multi-Store-Test#2026!server-owned';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
delete process.env.YUNWU_API_KEY;
delete process.env.ENABLE_BACKGROUND_EMBEDDINGS;

const { db, q, initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
const { authMiddleware, hashPassword, signToken } = await import('../src/util.js');
const { tenantScope } = await import('../src/app.js');
const { curStore, runWithStore, defaultStoreId } = await import('../src/engines/store-scope.js');
const { scopedUserIds, storeScopeClause } = await import('../src/engines/access.js');
const { inspectionSummary } = await import('../src/engines/store-inspections.js');
const { default: storeDataRoutes } = await import('../src/routes/store-data.js');
const { default: storeOpsRoutes } = await import('../src/routes/store-ops.js');
const { default: executionRoutes } = await import('../src/routes/execution.js');
const { default: dashboardRoutes } = await import('../src/routes/dashboard.js');
const { default: adminRoutes } = await import('../src/routes/admin.js');
const { default: authRoutes } = await import('../src/routes/auth.js');
const { default: onboardingRoutes } = await import('../src/routes/onboarding.js');

initSchema();
migrateV2();

// ===== 租户与账号 =====
const CHAIN = 21; // 连锁
const LEGACY = 22; // 有历史业务数据但从未建过门店的老租户
const FRESH = 23; // 空白新租户（开店向导）
const insertTenant = db.prepare(`INSERT INTO tenants(id,name,status,credits) VALUES(?,?,'已开通',100000)`);
insertTenant.run(CHAIN, '连锁测试企业');
insertTenant.run(LEGACY, '老单店企业');
insertTenant.run(FRESH, '空白新企业');

const passwordHash = hashPassword('Multi-Store#2026');
const insertUser = db.prepare(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id,manager_id) VALUES(?,?,?,?,'启用',?,?)`,
);
const uid = (username, name, role, tenantId, managerId = null) =>
  Number(insertUser.run(username, passwordHash, name, role, tenantId, managerId).lastInsertRowid);
const boss = uid('ms_boss', '连锁老板', 'boss', CHAIN);
const ops = uid('ms_ops', '门店运营', 'ops_director', CHAIN);
const managerA = uid('ms_mgr_a', 'A店店长', 'manager', CHAIN);
const managerB = uid('ms_mgr_b', 'B店店长', 'manager', CHAIN);
const salesA = uid('ms_sales_a', 'A店员工', 'sales', CHAIN);
const salesB = uid('ms_sales_b', 'B店员工', 'sales', CHAIN, managerA); // 汇报线在 A 店长，但人在 B 店
const salesHq = uid('ms_sales_hq', '总部员工', 'sales', CHAIN);
const legacyBoss = uid('ms_legacy_boss', '老单店老板', 'boss', LEGACY);
const freshBoss = uid('ms_fresh_boss', '新企业老板', 'boss', FRESH);

const tokenFor = (id, tenantId, role) =>
  signToken({ id, username: `ms-${id}`, name: `账号${id}`, tenant_id: tenantId, role, auth_version: 0 });
const tokens = {
  boss: tokenFor(boss, CHAIN, 'boss'),
  ops: tokenFor(ops, CHAIN, 'ops_director'),
  managerA: tokenFor(managerA, CHAIN, 'manager'),
  managerB: tokenFor(managerB, CHAIN, 'manager'),
  salesA: tokenFor(salesA, CHAIN, 'sales'),
  salesB: tokenFor(salesB, CHAIN, 'sales'),
  salesHq: tokenFor(salesHq, CHAIN, 'sales'),
  legacyBoss: tokenFor(legacyBoss, LEGACY, 'boss'),
  freshBoss: tokenFor(freshBoss, FRESH, 'boss'),
};

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/store-data', authMiddleware, tenantScope, storeDataRoutes);
app.use('/api/store-ops', authMiddleware, tenantScope, storeOpsRoutes);
app.use('/api/execution', authMiddleware, tenantScope, executionRoutes);
app.use('/api/dashboard', authMiddleware, tenantScope, dashboardRoutes);
app.use('/api/admin', authMiddleware, tenantScope, adminRoutes);
app.use('/api/onboarding', authMiddleware, tenantScope, onboardingRoutes);
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
const server = app.listen(0, '127.0.0.1');
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

async function call(token, url, { method = 'GET', body, storeId } = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(storeId === undefined ? {} : { 'X-Store-Id': String(storeId) }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}

const T = (tenantId, fn) => runWithTenant(tenantId, fn);

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  for (const file of DATABASE_FILES) fs.rmSync(file, { force: true });
});

let storeA;
let storeB;

test('迁移：业务表全部带 store_id，stores/users 追加列，重建表唯一键含门店', () => {
  const cols = table => db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
  for (const table of [
    'orders', 'costs', 'tasks', 'store_inspections', 'store_checklist_marks', 'dish_soldout_marks',
    'shift_assignments', 'attendance_records', 'inventory_items', 'inventory_moves', 'delivery_daily',
    'daily_ops', 'store_reviews',
  ]) {
    assert.ok(cols(table).includes('store_id'), `${table} 缺 store_id`);
  }
  assert.ok(cols('users').includes('store_id'));
  for (const col of ['code', 'is_default', 'region', 'manager_user_id', 'status']) assert.ok(cols('stores').includes(col));
  const ddl = table => db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table).sql;
  assert.match(ddl('store_checklist_marks'), /UNIQUE\(tenant_id, store_id, date, checklist_key, item_key\)/);
  assert.match(ddl('delivery_daily'), /UNIQUE\(tenant_id, store_id, date, platform\)/);
  assert.match(ddl('inventory_items'), /UNIQUE\(tenant_id, store_id, name\)/);
});

test('迁移回填：有历史数据却无门店的老租户 → 建默认店并回填；再跑一次幂等；空白租户不建店', () => {
  // 模拟升级前的历史行（store_id 为空）
  db.prepare(`INSERT INTO orders(tenant_id,product,amount,type,created_at) VALUES(?,?,?,?,?)`).run(LEGACY, '老订单', 88, '到店', '2026-08-01 12:00:00');
  db.prepare(`INSERT INTO tasks(tenant_id,title,status,assignee_id) VALUES(?,?,?,?)`).run(LEGACY, '老任务', '待执行', legacyBoss);
  db.prepare(`INSERT INTO store_checklist_marks(tenant_id,date,checklist_key,item_key) VALUES(?,?,?,?)`).run(LEGACY, '2026-08-01', 'opening', 'power');
  db.prepare(`INSERT INTO delivery_daily(tenant_id,date,platform,orders,revenue) VALUES(?,?,?,?,?)`).run(LEGACY, '2026-08-01', '美团', 10, 500);
  db.prepare(`INSERT INTO inventory_items(tenant_id,name,unit,quantity,safe_line) VALUES(?,?,?,?,?)`).run(LEGACY, '大米', '袋', 3, 5);
  db.prepare(`INSERT INTO store_reviews(tenant_id,platform,rating,content) VALUES(?,?,?,?)`).run(LEGACY, '美团', 2, '太慢了');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM stores WHERE tenant_id=?`).get(LEGACY).n, 0);

  migrateV2();
  const stores = db.prepare(`SELECT * FROM stores WHERE tenant_id=?`).all(LEGACY);
  assert.equal(stores.length, 1, '老租户恰好一家默认店');
  assert.equal(stores[0].name, '老单店企业');
  assert.equal(Number(stores[0].is_default), 1);
  const legacyStore = stores[0].id;
  for (const table of ['orders', 'tasks', 'store_checklist_marks', 'delivery_daily', 'inventory_items', 'store_reviews']) {
    const row = db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE tenant_id=? AND store_id IS NULL`).get(LEGACY);
    assert.equal(row.n, 0, `${table} 仍有未回填行`);
    const all = db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE tenant_id=? AND store_id=?`).get(LEGACY, legacyStore);
    assert.ok(all.n >= 1, `${table} 应回填到默认店`);
  }

  migrateV2();
  migrateV2();
  const again = db.prepare(`SELECT id,is_default FROM stores WHERE tenant_id=?`).all(LEGACY).map(r => ({ ...r }));
  assert.deepEqual(again, [{ id: legacyStore, is_default: 1 }], '重复迁移不新增门店、默认店不变');

  // 空白租户：没有历史业务行，不预建门店（开店向导/首次写入时再定）
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM stores WHERE tenant_id=?`).get(FRESH).n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM stores WHERE tenant_id=?`).get(CHAIN).n, 0);
  // 其他租户的行不受影响：租户 21 此刻没有任何业务行
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM orders WHERE tenant_id=?`).get(CHAIN).n, 0);
});

test('门店管理：第一家门店自动默认；code/region/负责人/默认可读写；/auth/me 带 storeId 与 tenant.stores', async () => {
  const a = await call(tokens.boss, '/api/store-data/stores', {
    method: 'POST',
    body: { name: '春熙路店', code: 'CD01', region: '成都', biz_type: '正餐', manager_user_id: managerA },
  });
  assert.equal(a.status, 201, JSON.stringify(a.payload));
  assert.equal(Number(a.payload.is_default), 1, '第一家门店自动成为默认店');
  assert.equal(a.payload.code, 'CD01');
  assert.equal(a.payload.region, '成都');
  assert.equal(a.payload.manager_user_id, managerA);
  storeA = a.payload.id;

  const b = await call(tokens.boss, '/api/store-data/stores', {
    method: 'POST',
    body: { name: '天府广场店', code: 'CD02', region: '成都', biz_type: '正餐' },
  });
  assert.equal(b.status, 201);
  assert.equal(Number(b.payload.is_default), 0);
  storeB = b.payload.id;

  const badManager = await call(tokens.boss, `/api/store-data/stores/${storeB}`, {
    method: 'PUT',
    body: { manager_user_id: legacyBoss },
  });
  assert.equal(badManager.status, 400, '负责人必须是本企业账号');

  const list = await call(tokens.boss, '/api/store-data/stores');
  assert.equal(list.payload.total, 2);
  assert.equal(list.payload.rows[0].id, storeA, '默认店排在最前');
  assert.equal(list.payload.rows[0].manager_name, 'A店店长');

  // 切换默认店：B 设为默认后 A 自动取消；默认店不能直接取消
  const setDefault = await call(tokens.boss, `/api/store-data/stores/${storeB}`, { method: 'PUT', body: { is_default: 1 } });
  assert.equal(setDefault.status, 200);
  assert.equal(Number(setDefault.payload.is_default), 1);
  assert.equal(db.prepare(`SELECT is_default FROM stores WHERE id=?`).get(storeA).is_default, 0);
  const cannotUnset = await call(tokens.boss, `/api/store-data/stores/${storeB}`, { method: 'PUT', body: { is_default: 0 } });
  assert.equal(cannotUnset.status, 400);
  await call(tokens.boss, `/api/store-data/stores/${storeA}`, { method: 'PUT', body: { is_default: true } });
  assert.equal(db.prepare(`SELECT is_default FROM stores WHERE id=?`).get(storeA).is_default, 1);
  const cannotDelete = await call(tokens.boss, `/api/store-data/stores/${storeA}`, { method: 'DELETE' });
  assert.equal(cannotDelete.status, 400, '默认门店不能删除');

  // 管理后台：给账号绑门店（storeId），非法门店 400
  for (const [id, storeId] of [[managerA, storeA], [managerB, storeB], [salesA, storeA], [salesB, storeB]]) {
    const put = await call(tokens.boss, `/api/admin/users/${id}`, { method: 'PUT', body: { storeId } });
    assert.equal(put.status, 200, JSON.stringify(put.payload));
  }
  const badStore = await call(tokens.boss, `/api/admin/users/${salesHq}`, { method: 'PUT', body: { storeId: 99999 } });
  assert.equal(badStore.status, 400);
  const users = await call(tokens.boss, '/api/admin/users');
  const mgrRow = users.payload.find(u => u.id === managerA);
  assert.equal(mgrRow.store_id, storeA);
  assert.equal(mgrRow.store_name, '春熙路店');
  const cannotDeleteBound = await call(tokens.boss, `/api/store-data/stores/${storeB}`, { method: 'DELETE' });
  assert.equal(cannotDeleteBound.status, 400, '有账号归属的门店不能删除');

  const me = await call(tokens.managerA, '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.payload.storeId, storeA);
  assert.deepEqual(
    me.payload.tenant.stores.map(s => [s.id, s.name, s.code, s.isDefault]),
    [[storeA, '春熙路店', 'CD01', true], [storeB, '天府广场店', 'CD02', false]],
  );
  const hq = await call(tokens.boss, '/api/auth/me');
  assert.equal(hq.payload.storeId, null, '总部账号 storeId=null');
});

test('X-Store-Id 权限矩阵：总部任意店；店长/员工仅本店（越权 403）；未绑店员工不受限；非法头 400', async () => {
  const ok = await call(tokens.boss, '/api/store-ops/checklists/today', { storeId: storeB });
  assert.equal(ok.status, 200);
  assert.equal((await call(tokens.ops, '/api/store-ops/checklists/today', { storeId: storeB })).status, 200);
  assert.equal((await call(tokens.managerA, '/api/store-ops/checklists/today', { storeId: storeA })).status, 200);
  const cross = await call(tokens.managerA, '/api/store-ops/checklists/today', { storeId: storeB });
  assert.equal(cross.status, 403);
  assert.match(cross.payload.error, /无权|不存在/);
  assert.equal((await call(tokens.salesA, '/api/store-ops/checklists/today', { storeId: storeB })).status, 403);
  assert.equal((await call(tokens.salesHq, '/api/store-ops/checklists/today', { storeId: storeB })).status, 200);
  // 别家企业的门店：即使老板也 403（不泄露存在性差异）
  const legacyStore = db.prepare(`SELECT id FROM stores WHERE tenant_id=?`).get(LEGACY).id;
  assert.equal((await call(tokens.boss, '/api/store-ops/checklists/today', { storeId: legacyStore })).status, 403);
  assert.equal((await call(tokens.boss, '/api/store-ops/checklists/today', { storeId: 'abc' })).status, 400);
  assert.equal((await call(tokens.boss, '/api/store-ops/checklists/today', { storeId: 0 })).status, 400);
});

test('写入默认：入参 > X-Store-Id > 用户绑定店 > 租户默认店；重建表的唯一键按门店生效', async () => {
  // 成本：老板带头写 → 头指定店；A 店员工不带头 → 本店；总部员工不带头 → 默认店(A)
  const byHeader = await call(tokens.boss, '/api/store-data/costs', {
    method: 'POST', storeId: storeB, body: { date: '2026-08-10', category: '食材', amount: 300 },
  });
  assert.equal(byHeader.status, 201, JSON.stringify(byHeader.payload));
  assert.equal(byHeader.payload.store_id, storeB);
  const explicitWins = await call(tokens.boss, '/api/store-data/costs', {
    method: 'POST', storeId: storeB, body: { store_id: storeA, date: '2026-08-11', category: '人力', amount: 200 },
  });
  assert.equal(explicitWins.payload.store_id, storeA, '入参 store_id 优先于请求头');
  const hqDefault = await call(tokens.salesHq, '/api/store-data/costs', {
    method: 'POST', body: { date: '2026-08-12', category: '房租', amount: 100 },
  });
  assert.equal(hqDefault.status, 403, '一线员工本就无权登记成本（现状不变）');

  // 日清：A 店员工与 B 店员工同日勾同一项互不冲突（旧唯一键会 UNIQUE 冲突）
  const markA = await call(tokens.salesA, '/api/store-ops/checklists/opening/toggle', { method: 'POST', body: { itemKey: 'power', done: true } });
  assert.equal(markA.status, 200, JSON.stringify(markA.payload));
  assert.equal(markA.payload.storeId, storeA);
  const markB = await call(tokens.salesB, '/api/store-ops/checklists/opening/toggle', { method: 'POST', body: { itemKey: 'power', done: true } });
  assert.equal(markB.status, 200, JSON.stringify(markB.payload));
  assert.equal(markB.payload.storeId, storeB);
  const todayA = await call(tokens.salesA, '/api/store-ops/checklists/today');
  const todayB = await call(tokens.salesB, '/api/store-ops/checklists/today');
  assert.equal(todayA.payload.done, 1, 'A 店员工只看到本店 1 项');
  assert.equal(todayB.payload.done, 1);
  const openingA = todayA.payload.checklists.find(c => c.key === 'opening').items.find(i => i.key === 'power');
  assert.equal(openingA.doneBy, 'A店员工', 'A 店看到的是本店员工勾的');
  // 近 7 天完成率按"勾选记录"计数：总部不传头=两店合计 2 条（现状口径），传头/绑定店=1 条
  const hqSummary = await call(tokens.boss, '/api/store-ops/checklists/summary');
  assert.equal(hqSummary.payload.days[0].done, 2, '总部不传头=全店合计');
  const hqBSummary = await call(tokens.boss, '/api/store-ops/checklists/summary', { storeId: storeB });
  assert.equal(hqBSummary.payload.days[0].done, 1);
  const salesASummary = await call(tokens.salesA, '/api/store-ops/checklists/summary');
  assert.equal(salesASummary.payload.days[0].done, 1);
  const hqB = await call(tokens.boss, '/api/store-ops/checklists/today', { storeId: storeB });
  assert.equal(hqB.payload.done, 1);
  const openingB = hqB.payload.checklists.find(c => c.key === 'opening').items.find(i => i.key === 'power');
  assert.equal(openingB.doneBy, 'B店员工');

  // 外卖日报：两店同日同平台各一条；同店重复提交走 UPSERT
  const dA = await call(tokens.boss, '/api/store-ops/delivery-daily', { method: 'POST', storeId: storeA, body: { platform: '美团', date: '2026-08-20', orders: 10, revenue: 500 } });
  const dB = await call(tokens.boss, '/api/store-ops/delivery-daily', { method: 'POST', storeId: storeB, body: { platform: '美团', date: '2026-08-20', orders: 20, revenue: 900 } });
  const dA2 = await call(tokens.boss, '/api/store-ops/delivery-daily', { method: 'POST', storeId: storeA, body: { platform: '美团', date: '2026-08-20', orders: 12, revenue: 600 } });
  assert.equal(dA.status, 200); assert.equal(dB.status, 200); assert.equal(dA2.status, 200);
  const dd = db.prepare(`SELECT store_id, orders FROM delivery_daily WHERE tenant_id=? AND date='2026-08-20' ORDER BY store_id`).all(CHAIN).map(r => ({ ...r }));
  assert.deepEqual(dd, [{ store_id: storeA, orders: 12 }, { store_id: storeB, orders: 20 }]);

  // 库存：两店可各有一份「大米」
  const invA = await call(tokens.salesA, '/api/store-ops/inventory', { method: 'POST', body: { name: '大米', unit: '袋', quantity: 2, safeLine: 5 } });
  const invB = await call(tokens.salesB, '/api/store-ops/inventory', { method: 'POST', body: { name: '大米', unit: '袋', quantity: 9, safeLine: 5 } });
  assert.equal(invA.status, 200, JSON.stringify(invA.payload));
  assert.equal(invB.status, 200, JSON.stringify(invB.payload));
  const dupA = await call(tokens.salesA, '/api/store-ops/inventory', { method: 'POST', body: { name: '大米', unit: '袋' } });
  assert.equal(dupA.status, 409, '同店同名仍判重');
  const invListA = await call(tokens.salesA, '/api/store-ops/inventory');
  assert.equal(invListA.payload.items.length, 1);
  assert.equal(invListA.payload.lowCount, 1);
  const invListAll = await call(tokens.boss, '/api/store-ops/inventory');
  assert.equal(invListAll.payload.items.length, 2, '总部全店');

  // 人工任务：老板不带头派给 B 店员工 → 归 B 店（执行人绑定店）；A 店店长派给本店员工 → A 店
  const taskToB = await call(tokens.boss, '/api/execution/tasks', { method: 'POST', body: { title: 'B店盘点', assignee_id: salesB } });
  assert.equal(taskToB.status, 200, JSON.stringify(taskToB.payload));
  assert.equal(db.prepare(`SELECT store_id FROM tasks WHERE id=?`).get(taskToB.payload.id).store_id, storeB);
  const taskToA = await call(tokens.managerA, '/api/execution/tasks', { method: 'POST', body: { title: 'A店晨检', assignee_id: salesA } });
  assert.equal(taskToA.status, 200, JSON.stringify(taskToA.payload));
  assert.equal(db.prepare(`SELECT store_id FROM tasks WHERE id=?`).get(taskToA.payload.id).store_id, storeA);
  const taskHq = await call(tokens.boss, '/api/execution/tasks', { method: 'POST', body: { title: '总部周会', assignee_id: salesHq } });
  assert.equal(db.prepare(`SELECT store_id FROM tasks WHERE id=?`).get(taskHq.payload.id).store_id, storeA, '总部→默认店');
  // 总部切到 B 店视角给 A 店员工派活：任务仍归执行人的 A 店（否则员工看不见自己的任务）
  const crossView = await call(tokens.boss, '/api/execution/tasks', { method: 'POST', storeId: storeB, body: { title: '跨店派活', assignee_id: salesA } });
  assert.equal(db.prepare(`SELECT store_id FROM tasks WHERE id=?`).get(crossView.payload.id).store_id, storeA, '执行人绑定店优先于 X-Store-Id');
  const hqInB = await call(tokens.boss, '/api/execution/tasks', { method: 'POST', storeId: storeB, body: { title: 'B店视角给总部员工', assignee_id: salesHq } });
  assert.equal(db.prepare(`SELECT store_id FROM tasks WHERE id=?`).get(hqInB.payload.id).store_id, storeB, '执行人未绑店时才用 X-Store-Id');
  const taskBadStore = await call(tokens.boss, '/api/execution/tasks', { method: 'POST', body: { title: '坏门店', storeId: 99999 } });
  assert.equal(taskBadStore.status, 400);
});

test('manager 本店范围：绑定门店的店长看到本店全体（含非汇报线员工），看不到别店（含自己汇报线上的人）', async () => {
  // salesB 的 manager_id 指向 managerA，但人在 B 店：按新规则 managerA 看不到、managerB 看得到
  const idsA = T(CHAIN, () => scopedUserIds({ id: managerA, role: 'manager', store_id: storeA }));
  assert.ok(idsA.includes(salesA), 'A 店长包含 A 店员工');
  assert.ok(idsA.includes(managerA));
  // 汇报线下级仍在范围内（并集，不收窄现有可见性）
  assert.ok(idsA.includes(salesB), 'manager_id 树仍保留');
  const idsB = T(CHAIN, () => scopedUserIds({ id: managerB, role: 'manager', store_id: storeB }));
  assert.ok(idsB.includes(salesB) && !idsB.includes(salesA));
  // 未绑定门店的 manager：只剩 manager_id 树（旧行为）
  const idsUnbound = T(CHAIN, () => scopedUserIds({ id: managerB, role: 'manager', store_id: null }));
  assert.deepEqual(idsUnbound, [managerB]);

  const listA = await call(tokens.managerA, '/api/execution/tasks');
  const titlesA = listA.payload.map(t => t.title);
  assert.ok(titlesA.includes('A店晨检'));
  assert.ok(!titlesA.includes('总部周会'), '总部员工不在 A 店人员范围内，即使任务落在默认店 A');
  assert.ok(!titlesA.includes('B店盘点'), '汇报线下级的任务落在 B 店 → 被 A 店长的门店过滤挡住');
  const listB = await call(tokens.managerB, '/api/execution/tasks');
  const titlesB = listB.payload.map(t => t.title);
  assert.ok(titlesB.includes('B店盘点'));
  assert.ok(!titlesB.includes('A店晨检'), 'B 店长看不到 A 店任务');
  // 老板全量；老板带头只看该店
  const bossAll = await call(tokens.boss, '/api/execution/tasks');
  assert.ok(['A店晨检', 'B店盘点', '总部周会'].every(t => bossAll.payload.some(x => x.title === t)));
  const bossB = await call(tokens.boss, '/api/execution/tasks', { storeId: storeB });
  assert.deepEqual(bossB.payload.map(t => t.title).sort(), ['B店盘点', 'B店视角给总部员工']);
});

test('读取过滤：不传头 = 与现状完全一致（全店合计）；传头只看该店（店长绑定店等价于常驻头）', async () => {
  // 订单：A 店 2 单（100+200），B 店 1 单（1000），另有 1 张未归属订单（300）
  const ins = db.prepare(`INSERT INTO orders(tenant_id,product,amount,type,created_at,store_id) VALUES(?,?,?,?,?,?)`);
  const todayStr = new Date().toLocaleDateString('sv-SE');
  ins.run(CHAIN, 'A单1', 100, '到店', `${todayStr} 10:00:00`, storeA);
  ins.run(CHAIN, 'A单2', 200, '到店', `${todayStr} 11:00:00`, storeA);
  ins.run(CHAIN, 'B单1', 1000, '外卖', `${todayStr} 12:00:00`, storeB);
  ins.run(CHAIN, '未归属', 300, '到店', `${todayStr} 13:00:00`, null);

  const all = await call(tokens.boss, '/api/dashboard/summary?period=month');
  assert.equal(all.status, 200, JSON.stringify(all.payload));
  assert.equal(all.payload.rangeSales, 1600, '不传头：全部订单（含未归属）');
  assert.equal(all.payload.revenueSource, 'orders');
  const onlyA = await call(tokens.boss, '/api/dashboard/summary?period=month', { storeId: storeA });
  assert.equal(onlyA.payload.rangeSales, 300);
  const onlyB = await call(tokens.boss, '/api/dashboard/summary?period=month', { storeId: storeB });
  assert.equal(onlyB.payload.rangeSales, 1000);
  const legacyAll = await call(tokens.boss, '/api/dashboard/summary');
  assert.equal(legacyAll.payload.todaySales, 1600, '无 period 的旧口径同样不受影响');
  const legacyB = await call(tokens.boss, '/api/dashboard/summary', { storeId: storeB });
  assert.equal(legacyB.payload.todaySales, 1000);

  const trendAll = await call(tokens.boss, '/api/dashboard/trend?period=month');
  const trendB = await call(tokens.boss, '/api/dashboard/trend?period=month', { storeId: storeB });
  const sum = rows => rows.reduce((s, r) => s + Number(r.deal_amount || 0), 0);
  assert.equal(sum(trendAll.payload.rows), 1600);
  assert.equal(sum(trendB.payload.rows), 1000);

  // 店长绑定店：不传头就只看本店（等价常驻 X-Store-Id）——用任务数验证（订单口径仍叠加既有的客户归属范围）
  const mgrBSummary = await call(tokens.managerB, '/api/dashboard/summary?period=month');
  assert.equal(mgrBSummary.status, 200);
  assert.equal(mgrBSummary.payload.taskRate, 0);
  const mgrBTasks = await call(tokens.managerB, '/api/execution/tasks');
  assert.deepEqual(mgrBTasks.payload.map(t => t.title), ['B店盘点']);

  // 门店 KPI 跟随上下文
  const month = todayStr.slice(0, 7);
  const kpiAll = await call(tokens.boss, `/api/store-data/kpi?month=${month}`);
  const kpiB = await call(tokens.boss, `/api/store-data/kpi?month=${month}`, { storeId: storeB });
  assert.equal(kpiAll.payload.monthRevenue, 1600);
  assert.equal(kpiB.payload.monthRevenue, 1000);
  assert.equal(kpiB.payload.storeId, storeB);

  // 成本列表 / 门店列表按上下文过滤；店长只看本店
  const costsA = await call(tokens.boss, `/api/store-data/costs?month=2026-08`, { storeId: storeA });
  assert.ok(costsA.payload.rows.every(r => r.store_id === storeA));
  const storesMgrA = await call(tokens.managerA, '/api/store-data/stores');
  assert.deepEqual(storesMgrA.payload.rows.map(s => s.id), [storeA]);

  // 巡店归档：按 store_id 过滤（store_name 匹配门店名/编码）
  db.prepare(`INSERT INTO agent_tasks(tenant_id,marshal_id,title,status,created_by) VALUES(?,?,?,?,?)`).run(CHAIN, 1, '巡店A', '已完成', boss);
  const taskAId = db.prepare(`SELECT id FROM agent_tasks WHERE tenant_id=? AND title='巡店A'`).get(CHAIN).id;
  db.prepare(`INSERT INTO agent_tasks(tenant_id,marshal_id,title,status,created_by) VALUES(?,?,?,?,?)`).run(CHAIN, 1, '巡店B', '已完成', boss);
  const taskBId = db.prepare(`SELECT id FROM agent_tasks WHERE tenant_id=? AND title='巡店B'`).get(CHAIN).id;
  const insInsp = db.prepare(`INSERT INTO store_inspections(tenant_id,task_id,store_name,score,store_id) VALUES(?,?,?,?,?)`);
  insInsp.run(CHAIN, taskAId, '春熙路店', 90, storeA);
  insInsp.run(CHAIN, taskBId, '天府广场店', 70, storeB);
  const summaryAll = T(CHAIN, () => inspectionSummary(CHAIN, { months: 3 }));
  assert.equal(summaryAll.totals.inspections, 2);
  const summaryB = T(CHAIN, () => runWithStore(storeB, () => {
    const scope = storeScopeClause({ id: boss, role: 'boss' }, 'i.store_id');
    assert.equal(curStore(), storeB);
    return inspectionSummary(CHAIN, { months: 3, scopeSql: scope.sql, scopeParams: scope.params });
  }));
  assert.equal(summaryB.totals.inspections, 1);
  assert.equal(summaryB.byStore[0].store, '天府广场店');
});

test('总部对比 compare：每店营收/订单/客单价/成本率/差评/巡店 + 环比；无数据为 null；店长 403', async () => {
  const todayStr = new Date().toLocaleDateString('sv-SE');
  db.prepare(`INSERT INTO store_reviews(tenant_id,platform,rating,content,review_date,store_id) VALUES(?,?,?,?,?,?)`).run(CHAIN, '美团', 1, 'B店差评', todayStr, storeB);
  db.prepare(`INSERT INTO costs(tenant_id,store_id,date,category,amount) VALUES(?,?,?,?,?)`).run(CHAIN, storeB, todayStr, '食材', 250);
  const orderB = db.prepare(`SELECT id FROM orders WHERE tenant_id=? AND product='B单1'`).get(CHAIN).id;
  db.prepare(`INSERT INTO order_items(tenant_id,order_id,dish_name_snapshot,qty,unit_price,amount) VALUES(?,?,?,?,?,?)`).run(CHAIN, orderB, '招牌菜', 2, 500, 1000);

  const denied = await call(tokens.managerA, `/api/store-data/compare?from=${todayStr}&to=${todayStr}`);
  assert.equal(denied.status, 403);
  const badRange = await call(tokens.boss, `/api/store-data/compare?from=2026-09-02&to=2026-09-01`);
  assert.equal(badRange.status, 400);

  const res = await call(tokens.boss, `/api/store-data/compare?from=${todayStr}&to=${todayStr}`);
  assert.equal(res.status, 200, JSON.stringify(res.payload));
  assert.equal(res.payload.from, todayStr);
  assert.equal(res.payload.spanDays, 1);
  const rowA = res.payload.rows.find(r => r.storeId === storeA);
  const rowB = res.payload.rows.find(r => r.storeId === storeB);
  assert.equal(rowA.revenue, 300);
  assert.equal(rowA.orders, 2);
  assert.equal(rowA.avgTicket, null, 'A 店无明细 → 客单价 null');
  assert.equal(rowA.costRate, null, 'A 店当日无成本 → null');
  assert.equal(rowA.badReviews, 0);
  assert.equal(rowA.inspectionScore, 90);
  assert.equal(rowA.isDefault, true);
  assert.equal(rowB.revenue, 1000);
  assert.equal(rowB.orders, 1);
  assert.equal(rowB.avgTicket, 1000);
  assert.equal(rowB.totalCost, 250);
  assert.equal(rowB.costRate, 25);
  assert.equal(rowB.badReviews, 1);
  assert.equal(rowB.inspectionScore, 70);
  assert.equal(rowB.prev.revenue, null, '前一区间无订单 → null');
  assert.equal(rowB.prev.revenueChangePct, null, '基数为 null 不编造环比');
  assert.deepEqual(res.payload.unassigned, { orders: 1, revenue: 300 }, '未归属订单单列');

  // 有前期数据时给出环比
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE');
  db.prepare(`INSERT INTO orders(tenant_id,product,amount,type,created_at,store_id) VALUES(?,?,?,?,?,?)`).run(CHAIN, 'B昨日', 500, '到店', `${yesterday} 12:00:00`, storeB);
  const withPrev = await call(tokens.ops, `/api/store-data/compare?from=${todayStr}&to=${todayStr}`);
  const rowB2 = withPrev.payload.rows.find(r => r.storeId === storeB);
  assert.equal(rowB2.prev.revenue, 500);
  assert.equal(rowB2.prev.revenueChangePct, 100);
  assert.equal(rowB2.prev.ordersChangePct, 0);
});

test('单店零感知：空白租户首次写入才懒创建默认店（企业名）；开店向导落的门店即默认店（批次 A 兼容）', async () => {
  // 空白租户此刻没有门店；直接完成开店向导 → 唯一门店 = 默认店
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM stores WHERE tenant_id=?`).get(FRESH).n, 0);
  const done = await call(tokens.freshBoss, '/api/onboarding/complete', {
    method: 'POST',
    body: {
      answers: {
        storeName: '小李面馆', bizType: '快餐', city: '成都', district: '高新区', seats: 20,
        customerGroups: ['周边白领'], avgTicket: 25, dineInRatio: 60, signatureDishes: ['牛肉面'],
        goal: '营收', goalTarget: '月营收 10 万', painPoint: '中午人手不够。',
      },
    },
  });
  assert.equal(done.status, 200, JSON.stringify(done.payload));
  assert.equal(done.payload.store.created, true);
  const freshStores = db.prepare(`SELECT id,name,is_default FROM stores WHERE tenant_id=?`).all(FRESH);
  assert.equal(freshStores.length, 1);
  assert.equal(freshStores[0].name, '小李面馆');
  assert.equal(Number(freshStores[0].is_default), 1, '向导落的第一家门店即默认店');
  assert.equal(T(FRESH, () => defaultStoreId(FRESH)), freshStores[0].id);

  // 该单店客户随后打卡/日清：全部落到唯一门店，且 /auth/me 只有 1 家店（前端不显示切换器）
  const mark = await call(tokens.freshBoss, '/api/store-ops/checklists/closing/toggle', { method: 'POST', body: { itemKey: 'gas', done: true } });
  assert.equal(mark.payload.storeId, freshStores[0].id);
  const me = await call(tokens.freshBoss, '/api/auth/me');
  assert.equal(me.payload.tenant.stores.length, 1);

  // 另一种顺序：老租户先用系统（懒建占位默认店=企业名），再跑向导 → 向导改写占位店而不是多出第二家
  const legacyMark = await call(tokens.legacyBoss, '/api/store-ops/checklists/closing/toggle', { method: 'POST', body: { itemKey: 'gas', done: true } });
  assert.equal(legacyMark.status, 200);
  const legacyStore = db.prepare(`SELECT id,name FROM stores WHERE tenant_id=?`).get(LEGACY);
  assert.equal(legacyStore.name, '老单店企业');
  const legacyDone = await call(tokens.legacyBoss, '/api/onboarding/complete', {
    method: 'POST',
    body: {
      answers: {
        storeName: '老王饭店', bizType: '正餐', city: '成都', district: '锦江区', seats: 60,
        customerGroups: ['家庭顾客'], avgTicket: 80, dineInRatio: 90, signatureDishes: ['回锅肉'],
        goal: '营收', goalTarget: '翻台', painPoint: '晚市空。',
      },
    },
  });
  assert.equal(legacyDone.status, 200, JSON.stringify(legacyDone.payload));
  const legacyStores = db.prepare(`SELECT id,name,is_default FROM stores WHERE tenant_id=?`).all(LEGACY);
  assert.equal(legacyStores.length, 1, '占位默认店被向导改写，不新增第二家');
  assert.equal(legacyStores[0].id, legacyStore.id);
  assert.equal(legacyStores[0].name, '老王饭店');
  assert.equal(Number(legacyStores[0].is_default), 1);
});
