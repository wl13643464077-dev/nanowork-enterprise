// 多门店批量导入模板：模板生成含门店下拉、导入门店解析、匹配失败标记、按店幂等覆盖、store_daily_ops 写入与隔离。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import ExcelJS from 'exceljs';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const DBP = path.join(os.tmpdir(), `nanowork-data-intake-templates-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) fs.rmSync(file, { force: true });
process.env.NANOWORK_DB = DBP;
process.env.NODE_ENV = 'test';
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
delete process.env.ENABLE_BACKGROUND_EMBEDDINGS;

const { db, q, qRaw, initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
const { runWithStore } = await import('../src/engines/store-scope.js');
const dataIntakeRoutes = (await import('../src/routes/dataintake.js')).default;
const dashboardRoutes = (await import('../src/routes/dashboard.js')).default;

initSchema();
migrateV2();

const CHAIN = Number(qRaw.run("INSERT INTO tenants(name,status,credits) VALUES('连锁模板企业','已开通',1000)").lastInsertRowid);
const OTHER = Number(qRaw.run("INSERT INTO tenants(name,status,credits) VALUES('隔壁企业','已开通',1000)").lastInsertRowid);
const insertUser = (username, name, role, tenantId, storeId = null) => Number(qRaw.run(
  `INSERT INTO users(username,password_hash,name,role,status,tenant_id,store_id) VALUES(?,?,?,?,'启用',?,?)`,
  username, 'x', name, role, tenantId, storeId,
).lastInsertRowid);
const bossId = insertUser('tpl_boss', '连锁老板', 'boss', CHAIN);
const salesId = insertUser('tpl_sales', '一线员工', 'sales', CHAIN);
const staffA = insertUser('tpl_staff_a', '张三', 'sales', CHAIN);
insertUser('tpl_dup_1', '重名员工', 'sales', CHAIN);
insertUser('tpl_dup_2', '重名员工', 'sales', CHAIN);
const otherBossId = insertUser('tpl_other_boss', '隔壁老板', 'boss', OTHER);

const storeWanda = Number(qRaw.run(`INSERT INTO stores(tenant_id,name,code,biz_type,status,is_default) VALUES(?,?,?,'快餐','营业中',1)`, CHAIN, '万达店', 'WD001').lastInsertRowid);
const storeLonghu = Number(qRaw.run(`INSERT INTO stores(tenant_id,name,code,biz_type,status,is_default) VALUES(?,?,?,'快餐','营业中',0)`, CHAIN, '龙湖店', 'LH002').lastInsertRowid);
qRaw.run(`INSERT INTO stores(tenant_id,name,code,biz_type,status,is_default) VALUES(?,?,?,'快餐','营业中',1)`, OTHER, '隔壁总店', null);

const users = {
  boss: { id: bossId, name: '连锁老板', username: 'tpl_boss', role: 'boss', tenant_id: CHAIN },
  sales: { id: salesId, name: '一线员工', username: 'tpl_sales', role: 'sales', tenant_id: CHAIN },
  otherBoss: { id: otherBossId, name: '隔壁老板', username: 'tpl_other_boss', role: 'boss', tenant_id: OTHER },
};

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use((req, _res, next) => {
  const who = String(req.get('X-Test-User') || 'boss');
  const user = users[who] || users.boss;
  const storeHeader = req.get('X-Store-Id');
  runWithTenant(user.tenant_id, () => {
    req.user = { ...user, ip: '127.0.0.1' };
    if (storeHeader) return runWithStore(Number(storeHeader), () => next());
    return next();
  });
});
app.use('/data-intake', dataIntakeRoutes);
app.use('/dashboard', dashboardRoutes);
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
const server = app.listen(0, '127.0.0.1');
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

async function call(url, { method = 'GET', body, user = 'boss', headers = {} } = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Test-User': user, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, payload, headers: response.headers };
}

let importSeq = 0;
const key = () => `tpl-import-${process.pid}-${++importSeq}`;

test('模板清单覆盖六类，模板 xlsx 含填写说明、示例行、门店下拉与枚举下拉', async () => {
  const list = await call('/data-intake/templates');
  assert.equal(list.status, 200);
  const keys = list.payload.templates.map(item => item.key);
  for (const expected of ['stores', 'dishes', 'store_daily', 'costs', 'staff_stores', 'reviews']) assert.ok(keys.includes(expected), expected);
  assert.deepEqual(list.payload.stores.map(store => store.name), ['万达店', '龙湖店']);
  const daily = list.payload.templates.find(item => item.key === 'store_daily');
  assert.equal(daily.columns.find(column => column.key === 'store_name').options, 'stores');
  assert.ok(daily.columns.find(column => column.key === 'date').required);

  const file = await call('/data-intake/templates/store_daily.xlsx');
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-type'), /spreadsheetml/);
  assert.match(file.headers.get('content-disposition'), /filename\*=UTF-8''/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.payload);
  const names = wb.worksheets.map(ws => ws.name);
  assert.ok(names.includes('填写说明'));
  assert.ok(names.includes('每日营业汇总'));
  assert.ok(names.includes('门店列表'));
  const data = wb.getWorksheet('每日营业汇总');
  assert.deepEqual(data.getRow(1).values.slice(1), ['门店名称', '日期', '营收', '订单数', '客单价', '外卖营收', '外卖占比', '退款', '备注']);
  assert.equal(data.getRow(2).getCell(1).value, '万达店');
  const validation = data.getCell('A2').dataValidation;
  assert.equal(validation.type, 'list');
  assert.match(validation.formulae[0], /万达店,龙湖店/);
  const hidden = wb.getWorksheet('门店列表');
  assert.equal(hidden.state, 'veryHidden');
  assert.deepEqual([hidden.getCell('A2').value, hidden.getCell('A3').value], ['万达店', '龙湖店']);

  const costs = await call('/data-intake/templates/costs.xlsx');
  const costWb = new ExcelJS.Workbook();
  await costWb.xlsx.load(costs.payload);
  const costSheet = costWb.getWorksheet('成本按店按月');
  assert.match(costSheet.getCell('C2').dataValidation.formulae[0], /食材,人力,房租,水电,营销,其他/);

  const missing = await call('/data-intake/templates/nope.xlsx');
  assert.equal(missing.status, 404);
  const denied = await call('/data-intake/templates', { user: 'sales' });
  assert.equal(denied.status, 403);
});

test('预览按门店名称/编码解析 store_id；匹配不到标红不落默认店；模板说明页与示例行不当数据', async () => {
  const preview = await call('/data-intake/preview', {
    method: 'POST',
    body: {
      sheets: [
        { name: '填写说明', rows: [['列名', '是否必填', '填写要求'], ['门店名称', '选填', '从下拉选择']] },
        { name: '门店列表', rows: [['门店名称'], ['万达店'], ['龙湖店']] },
        {
          name: '每日营业汇总',
          rows: [
            ['门店名称', '日期', '营收', '订单数', '客单价', '外卖营收', '外卖占比', '退款', '备注'],
            ['万达店', '2026-09-01', 8650, 312, '', 3120, '', 86, '周一'],
            ['LH002', '2026-09-01', 6420, 240, '', 2900, '', 0, ''],
            ['春熙路店', '2026-09-01', 5000, 200, '', '', '', '', ''],
            ['', '2026-09-02', 7000, 250, '', '', '', '', ''],
            ['万达店', '2026-09-03', '', 100, '', '', '', '', ''],
          ],
        },
      ],
    },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.payload));
  assert.equal(preview.payload.batches.length, 1, '说明页与门店列表不应成为数据批次');
  const batch = preview.payload.batches[0];
  assert.equal(batch.target, 'store_daily');
  const [wanda, longhu, unknown, blank, noRevenue] = batch.rows;
  assert.equal(wanda.valid, false, '模板示例行原样上传不能当真实数据');
  assert.equal(wanda.sample, true);
  assert.equal(longhu.valid, true);
  assert.equal(longhu.store.id, storeLonghu, '门店编码也能解析');
  assert.equal(longhu.store.name, 'LH002');
  assert.equal(unknown.valid, false);
  assert.equal(unknown.store.unresolved, true);
  assert.match(unknown.error, /春熙路店.*未匹配/);
  assert.equal(blank.valid, true);
  assert.equal(blank.store.defaulted, true);
  assert.equal(blank.store.id, storeWanda);
  assert.equal(noRevenue.valid, false);
  assert.match(noRevenue.error, /营收/);
  assert.deepEqual(batch.stores.unmatched, [{ name: '春熙路店', rows: 1 }]);
  assert.equal(batch.stores.defaultStoreName, '万达店');

  // 改为默认店：storeOverrides 让未匹配门店归到默认店，且行上明确标 defaulted
  const overridden = await call('/data-intake/preview', {
    method: 'POST',
    body: {
      storeOverrides: { 春熙路店: 'default' },
      sheets: [{ name: 'S', rows: [['门店名称', '日期', '营收'], ['春熙路店', '2026-09-01', 5000]] }],
    },
  });
  assert.equal(overridden.payload.batches[0].rows[0].valid, true);
  assert.equal(overridden.payload.batches[0].rows[0].store.id, storeWanda);
  assert.equal(overridden.payload.batches[0].rows[0].store.defaulted, true);

  // 新建门店：预览里的「新建门店」选项
  const created = await call('/data-intake/stores', { method: 'POST', body: { names: ['春熙路店', '万达店'] } });
  assert.equal(created.status, 200);
  assert.equal(created.payload.created.length, 1);
  assert.equal(created.payload.existing[0].id, storeWanda);
  const again = await call('/data-intake/preview', {
    method: 'POST',
    body: { sheets: [{ name: 'S', rows: [['门店名称', '日期', '营收'], ['春熙路店', '2026-09-01', 5000]] }] },
  });
  assert.equal(again.payload.batches[0].rows[0].valid, true);
  assert.equal(again.payload.batches[0].rows[0].store.id, created.payload.created[0].id);
});

test('按店按日汇总写入 store_daily_ops：同店同日重复导入覆盖、不同店不冲突、未匹配门店行被跳过', async () => {
  const first = await call('/data-intake/commit', {
    method: 'POST',
    body: {
      idempotencyKey: key(),
      batches: [{
        sheet: '每日营业汇总', target: 'store_daily',
        rows: [
          { rowNumber: 2, data: { store_name: '万达店', date: '2026-08-01', revenue: 8000, orders: 320, delivery_revenue: 2000 } },
          { rowNumber: 3, data: { store_name: '龙湖店', date: '2026-08-01', revenue: 6000, orders: 200 } },
          { rowNumber: 4, data: { store_name: '不存在的店', date: '2026-08-01', revenue: 1 } },
        ],
      }],
    },
  });
  assert.equal(first.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.imported, 2);
  assert.equal(first.payload.results[0].skipped, 1);
  assert.match(first.payload.results[0].errors[0].error, /不存在的店.*未匹配/);
  const wanda = q.get('SELECT * FROM store_daily_ops WHERE tenant_id=? AND store_id=? AND date=?', CHAIN, storeWanda, '2026-08-01');
  assert.equal(wanda.revenue, 8000);
  assert.equal(wanda.orders, 320);
  assert.equal(wanda.avg_ticket, 25);
  assert.equal(wanda.delivery_ratio, 0.25);
  assert.equal(wanda.source, 'excel_import');
  assert.equal(q.get('SELECT COUNT(*) n FROM store_daily_ops WHERE tenant_id=?', CHAIN).n, 2);

  const second = await call('/data-intake/commit', {
    method: 'POST',
    body: {
      idempotencyKey: key(),
      batches: [{
        sheet: '每日营业汇总', target: 'store_daily',
        rows: [{ rowNumber: 2, data: { store_name: 'WD001', date: '2026-08-01', revenue: 8800, orders: 330, delivery_ratio: 30 } }],
      }],
    },
  });
  assert.equal(second.payload.imported, 1);
  assert.equal(second.payload.results[0].items[0].action, '更新');
  assert.equal(q.get('SELECT COUNT(*) n FROM store_daily_ops WHERE tenant_id=? AND store_id=?', CHAIN, storeWanda).n, 1, '同店同日只保留一条');
  const updated = q.get('SELECT * FROM store_daily_ops WHERE tenant_id=? AND store_id=? AND date=?', CHAIN, storeWanda, '2026-08-01');
  assert.equal(updated.revenue, 8800);
  assert.equal(updated.delivery_ratio, 0.3, '百分数 30 归一化为 0.3');

  // 未填订单数/退款保持 NULL，不静默落 0
  await call('/data-intake/commit', {
    method: 'POST',
    body: {
      idempotencyKey: key(),
      batches: [{ sheet: 'S', target: 'store_daily', rows: [{ data: { store_name: '龙湖店', date: '2026-08-02', revenue: 100 } }] }],
    },
  });
  const sparse = q.get('SELECT orders,avg_ticket,refunds FROM store_daily_ops WHERE tenant_id=? AND store_id=? AND date=?', CHAIN, storeLonghu, '2026-08-02');
  assert.equal(sparse.orders, null);
  assert.equal(sparse.avg_ticket, null);
  assert.equal(sparse.refunds, null);

  // 租户隔离：隔壁企业看不到、也匹配不到本企业门店
  const other = await call('/data-intake/commit', {
    method: 'POST', user: 'otherBoss',
    body: {
      idempotencyKey: key(),
      batches: [{ sheet: 'S', target: 'store_daily', rows: [{ data: { store_name: '万达店', date: '2026-08-01', revenue: 1 } }] }],
    },
  });
  assert.equal(other.payload.imported, 0);
  assert.match(other.payload.results[0].errors[0].error, /万达店.*未匹配/);
  assert.equal(q.get('SELECT COUNT(*) n FROM store_daily_ops WHERE tenant_id=?', OTHER).n, 0);
  const history = await call('/data-intake/history', { user: 'otherBoss' });
  assert.equal(history.payload.length, 0);
});

test('驾驶舱门店过滤在 store_daily_ops 有数据时优先读它（无订单时），全店视角合计各店', async () => {
  const wandaView = await call('/dashboard/summary?mode=month&month=2026-08', { headers: { 'X-Store-Id': String(storeWanda) } });
  assert.equal(wandaView.status, 200, JSON.stringify(wandaView.payload));
  assert.equal(wandaView.payload.revenueSource, 'store_daily_ops');
  assert.equal(wandaView.payload.rangeSales, 8800);
  const longhuView = await call('/dashboard/summary?mode=month&month=2026-08', { headers: { 'X-Store-Id': String(storeLonghu) } });
  assert.equal(longhuView.payload.rangeSales, 6100);
  const allView = await call('/dashboard/summary?mode=month&month=2026-08');
  assert.equal(allView.payload.revenueSource, 'store_daily_ops');
  assert.equal(allView.payload.rangeSales, 14900);
  const otherView = await call('/dashboard/summary?mode=month&month=2026-08', { user: 'otherBoss' });
  assert.notEqual(otherView.payload.revenueSource, 'store_daily_ops', '隔壁企业不受本企业日结影响');
});

test('菜品/成本/评价/员工归属：按店幂等覆盖与匹配规则', async () => {
  const dishes = await call('/data-intake/commit', {
    method: 'POST',
    body: {
      idempotencyKey: key(),
      batches: [{
        sheet: '菜品', target: 'dishes',
        rows: [
          { data: { store_name: '万达店', name: '招牌牛肉面', price: 28, cost: 9.5, unit: '碗' } },
          { data: { store_name: '龙湖店', name: '招牌牛肉面', price: 26 } },
          { data: { store_name: '万达店', name: '招牌牛肉面', price: 30, status: '停售' } },
        ],
      }],
    },
  });
  assert.equal(dishes.payload.imported, 3);
  const wandaDishes = q.all('SELECT name,price,status FROM dishes WHERE tenant_id=? AND store_id=?', CHAIN, storeWanda);
  assert.equal(wandaDishes.length, 1, '同店同名菜品覆盖');
  assert.equal(wandaDishes[0].price, 30);
  assert.equal(wandaDishes[0].status, '下架', '状态别名归一');
  assert.equal(q.get('SELECT price FROM dishes WHERE tenant_id=? AND store_id=?', CHAIN, storeLonghu).price, 26);

  const costs = await call('/data-intake/commit', {
    method: 'POST',
    body: {
      idempotencyKey: key(),
      batches: [{
        sheet: '成本', target: 'costs',
        rows: [
          { data: { store_name: '万达店', month: '2026-08', category: '人工', amount: 52000 } },
          { data: { store_name: '万达店', month: '2026-08', category: '人力', amount: 53000 } },
          { data: { store_name: '万达店', month: '2026-08', category: '不存在类别', amount: 1 } },
          { data: { store_name: '万达店', category: '食材', amount: 1 } },
        ],
      }],
    },
  });
  assert.equal(costs.payload.imported, 2);
  assert.equal(costs.payload.results[0].skipped, 2);
  const monthly = q.all('SELECT date,category,amount,note FROM costs WHERE tenant_id=? AND store_id=?', CHAIN, storeWanda);
  assert.equal(monthly.length, 1, '同店同月同类别覆盖');
  assert.deepEqual({ ...monthly[0] }, { date: '2026-08-01', category: '人力', amount: 53000, note: '按店按月汇总导入' });

  const reviews = await call('/data-intake/commit', {
    method: 'POST',
    body: {
      idempotencyKey: key(),
      batches: [{
        sheet: '评价', target: 'reviews',
        rows: [
          { data: { store_name: '龙湖店', platform: '饿了么', rating: 2, content: '等了快一个小时才送到', author: '小王', review_date: '2026-08-31' } },
          { data: { store_name: '龙湖店', platform: '饿了么', rating: 2, content: '等了快一个小时才送到', review_date: '2026-08-31' } },
          { data: { store_name: '龙湖店', platform: '美团', rating: 9, content: '评分越界' } },
        ],
      }],
    },
  });
  assert.equal(reviews.payload.imported, 2);
  assert.equal(reviews.payload.results[0].skipped, 1);
  const reviewRows = q.all('SELECT store_id,store_name,category,rating FROM store_reviews WHERE tenant_id=?', CHAIN);
  assert.equal(reviewRows.length, 1, '同平台同日同内容去重');
  assert.equal(reviewRows[0].store_id, storeLonghu);
  assert.equal(reviewRows[0].store_name, '龙湖店');
  assert.equal(reviewRows[0].category, '出餐慢', '差评按评价中心同一套规则自动归因');

  const staff = await call('/data-intake/commit', {
    method: 'POST',
    body: {
      idempotencyKey: key(),
      batches: [{
        sheet: '员工归属', target: 'staff_stores',
        rows: [
          { data: { account: 'tpl_staff_a', store_name: '龙湖店' } },
          { data: { name: '重名员工', store_name: '龙湖店' } },
          { data: { name: '张三' } },
          { data: { account: 'nobody', store_name: '万达店' } },
        ],
      }],
    },
  });
  assert.equal(staff.payload.imported, 1);
  assert.equal(staff.payload.results[0].skipped, 3);
  const errors = staff.payload.results[0].errors.map(item => item.error).join('|');
  assert.match(errors, /重名/);
  assert.match(errors, /缺少[：:]?门店名称/);
  assert.match(errors, /未找到登录账号/);
  assert.equal(q.get('SELECT store_id FROM users WHERE id=?', staffA).store_id, storeLonghu);
  const item = staff.payload.results[0].items[0];
  assert.equal(item.action, '更新');
  const historyRows = await call('/data-intake/history?limit=200');
  const staffItem = historyRows.payload.find(row => row.id === item.id);
  assert.equal(staffItem.data.store_name, '龙湖店');
  assert.equal(staffItem.data.account, 'tpl_staff_a');
  assert.equal(Object.keys(staffItem.data).includes('password_hash'), false);
  const reverted = await call(`/data-intake/items/${item.id}`, { method: 'DELETE' });
  assert.equal(reverted.payload.action, 'reverted');
  assert.equal(q.get('SELECT store_id FROM users WHERE id=?', staffA).store_id, null, '撤回后恢复原归属');
});

test('门店清单导入：同名/同编码更新，首家门店成默认店；订单表可带门店名称', async () => {
  const stores = await call('/data-intake/commit', {
    method: 'POST',
    body: {
      idempotencyKey: key(),
      batches: [{
        sheet: '门店清单', target: 'stores',
        rows: [
          { data: { name: '万达店', city: '成都', biz_type: '面馆' } },
          { data: { name: '高新店', code: 'GX003', city: '成都', status: '筹备' } },
        ],
      }],
    },
  });
  assert.equal(stores.payload.imported, 2);
  assert.equal(stores.payload.results[0].items[0].action, '更新');
  assert.equal(stores.payload.results[0].items[1].action, '新增');
  const wanda = q.get('SELECT city,biz_type,is_default FROM stores WHERE tenant_id=? AND id=?', CHAIN, storeWanda);
  assert.deepEqual({ ...wanda }, { city: '成都', biz_type: '快餐', is_default: 1 });
  const gaoxin = q.get("SELECT status,is_default FROM stores WHERE tenant_id=? AND code='GX003'", CHAIN);
  assert.deepEqual({ ...gaoxin }, { status: '筹备中', is_default: 0 });

  const fresh = Number(qRaw.run("INSERT INTO tenants(name,status,credits) VALUES('空白企业','已开通',10)").lastInsertRowid);
  const freshBoss = insertUser('tpl_fresh_boss', '空白老板', 'boss', fresh);
  users.freshBoss = { id: freshBoss, name: '空白老板', username: 'tpl_fresh_boss', role: 'boss', tenant_id: fresh };
  const firstStore = await call('/data-intake/commit', {
    method: 'POST', user: 'freshBoss',
    body: { idempotencyKey: key(), batches: [{ sheet: 'S', target: 'stores', rows: [{ data: { name: '第一家店' } }] }] },
  });
  assert.equal(firstStore.payload.imported, 1);
  assert.equal(q.get('SELECT is_default FROM stores WHERE tenant_id=?', fresh).is_default, 1);

  const orders = await call('/data-intake/commit', {
    method: 'POST',
    body: {
      idempotencyKey: key(),
      batches: [{ sheet: '订单', target: 'orders', rows: [{ data: { customer: '门店订单客户', amount: 88, store_name: '龙湖店' } }] }],
    },
  });
  assert.equal(orders.payload.imported, 1);
  assert.equal(q.get('SELECT store_id FROM orders WHERE tenant_id=? AND id=?', CHAIN, orders.payload.results[0].items[0].recordId).store_id, storeLonghu);
});

test('开店向导菜单 Excel → 菜品草稿预览（服务端解析、不落库）', async () => {
  const { saveUploadedFile } = await import('../src/engines/filehub.js');
  const { menuDraftFromFileIds } = await import('../src/routes/dataintake.js');
  const wb = new ExcelJS.Workbook();
  const notes = wb.addWorksheet('填写说明');
  notes.addRow(['列名', '说明']);
  const ws = wb.addWorksheet('菜单');
  ws.addRow(['菜品名称', '售价', '分类']);
  ws.addRow(['招牌牛肉面', 28, '主食']);
  ws.addRow(['凉拌黄瓜', 8, '小菜']);
  ws.addRow(['无价菜', '', '小菜']);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const saved = runWithTenant(CHAIN, () => saveUploadedFile({
    name: '菜单.xlsx', b64: buffer.toString('base64'), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    purpose: 'onboarding', userId: bossId,
  }));
  try {
    const dishesBefore = q.get('SELECT COUNT(*) n FROM dishes WHERE tenant_id=?', CHAIN).n;
    const draft = await runWithTenant(CHAIN, () => menuDraftFromFileIds([saved.row.id], users.boss));
    assert.equal(draft.status, 'ready');
    assert.equal(draft.dishes, 2);
    assert.equal(draft.pendingRows, 1);
    assert.equal(draft.batches.length, 1, '说明页不进草稿');
    assert.equal(draft.batches[0].target, 'dishes');
    assert.equal(draft.batches[0].rows[0].data.name, '招牌牛肉面');
    assert.equal(draft.batches[0].rows[0].store.defaulted, true);
    assert.equal(q.get('SELECT COUNT(*) n FROM dishes WHERE tenant_id=?', CHAIN).n, dishesBefore, '草稿不落库');
  } finally {
    fs.rmSync(saved.row.file_path, { force: true });
  }
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  try { db.close(); } catch { /* already closed */ }
  await removeTempDbSafely(DBP, { closeDb: false });
});
