import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DBP = path.join(os.tmpdir(), `nanowork-demo-sample-seed-${process.pid}-${Date.now()}.db`);
for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { initSchema, migrateV2, q, db } = await import('../src/db.js');
const { seedSalesDemoDataset, DEMO_BRAND_NAME } = await import('../src/engines/demo-sample-seed.js');
const { inspectionSummary } = await import('../src/engines/store-inspections.js');

initSchema();
migrateV2();

function createTenant(name) {
  const res = q.run(
    `INSERT INTO tenants(name, contact_name, status, plan, data_mode) VALUES(?, '演示联系人', '已开通', '旗舰版', 'demo')`,
    name,
  );
  return Number(res.lastInsertRowid);
}

function countAllForTenant(tid) {
  const count = (table) =>
    q.get(`SELECT COUNT(*) n FROM ${table} WHERE tenant_id = ?`, tid)?.n || 0;
  return {
    stores: count('stores'),
    dishes: count('dishes'),
    dailyOps: count('daily_ops'),
    storeDailyOps: count('store_daily_ops'),
    orders: count('orders'),
    orderItems: count('order_items'),
    costs: count('costs'),
    reviews: count('store_reviews'),
    agentTasks: count('agent_tasks'),
    inspections: count('store_inspections'),
    rectifications: count('store_inspection_rectifications'),
  };
}

const tenantA = createTenant('销售演示企业A');
const tenantB = createTenant('独立测试企业B');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});

test('安全护栏：缺省、非法或不存在的 tenantId 一律拒绝执行', () => {
  assert.throws(() => seedSalesDemoDataset(), /安全护栏/);
  assert.throws(() => seedSalesDemoDataset({ tenantId: 0 }), /安全护栏/);
  assert.throws(() => seedSalesDemoDataset({ tenantId: -5 }), /安全护栏/);
  assert.throws(() => seedSalesDemoDataset({ tenantId: 'abc' }), /安全护栏/);
  assert.throws(() => seedSalesDemoDataset({ tenantId: 999999 }), /不存在/);
});

test('dryRun 预览准确返回计划条目且对数据库零写入', () => {
  const preview = seedSalesDemoDataset({ tenantId: tenantA, dryRun: true });
  assert.equal(preview.tenantId, tenantA);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.stores.created, 3);
  assert.equal(preview.dishes.created, 12);
  assert.equal(preview.dailyOps.created, 14);
  assert.equal(preview.storeDailyOps.created, 42);
  assert.equal(preview.orders.created, 84);
  assert.equal(preview.orderItems.created, 252);
  assert.equal(preview.reviews.created, 12);
  assert.equal(preview.inspections.created, 2);
  assert.equal(preview.rectifications.created, 3);

  const afterPreview = countAllForTenant(tenantA);
  for (const [key, val] of Object.entries(afterPreview)) {
    assert.equal(val, 0, `dryRun 后 ${key} 必须仍为 0`);
  }
});

test('首次注入完整点亮驾驶舱/菜品/评价/巡店数据，且使用脱敏示范品牌', () => {
  const first = seedSalesDemoDataset({ tenantId: tenantA, actorUserId: 101, dryRun: false });
  assert.equal(first.tenantId, tenantA);
  assert.equal(first.dryRun, false);
  assert.equal(first.stores.created, 3);
  assert.equal(first.dishes.created, 12);
  assert.equal(first.dailyOps.created, 14);
  assert.equal(first.orders.created, 84);
  assert.equal(first.reviews.created, 12);
  assert.equal(first.inspections.created, 2);

  const counts = countAllForTenant(tenantA);
  assert.equal(counts.stores, 3);
  assert.equal(counts.dishes, 12);
  assert.equal(counts.dailyOps, 14);
  assert.equal(counts.storeDailyOps, 42);
  assert.equal(counts.orders, 84);
  assert.equal(counts.orderItems, 252);
  assert.equal(counts.costs, 9);
  assert.equal(counts.reviews, 12);
  assert.equal(counts.inspections, 2);
  assert.equal(counts.rectifications, 3);

  // 验证脱敏品牌与 3 家门店名
  const stores = q.all('SELECT name, code, is_default FROM stores WHERE tenant_id = ? ORDER BY code', tenantA);
  assert.deepEqual(
    stores.map((s) => s.name),
    [`${DEMO_BRAND_NAME}·望京店`, `${DEMO_BRAND_NAME}·国贸店`, `${DEMO_BRAND_NAME}·三里屯店`],
  );
  assert.equal(stores.filter((s) => s.is_default === 1).length, 1);

  // 验证菜品 TOP10 聚合可立即可出 10 道以上菜品
  const dishTop = q.all(
    `SELECT oi.dish_id, oi.dish_name_snapshot name, SUM(oi.qty) qty, SUM(oi.amount) amount
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id AND o.tenant_id = oi.tenant_id
     WHERE oi.tenant_id = ?
     GROUP BY oi.dish_id, oi.dish_name_snapshot
     ORDER BY qty DESC LIMIT 10`,
    tenantA,
  );
  assert.equal(dishTop.length, 10);
  assert.ok(dishTop[0].qty > 0 && dishTop[0].amount > 0);

  // 验证多平台评价含好评与带归因的待回复差评
  const badPending = q.get(
    `SELECT COUNT(*) n FROM store_reviews WHERE tenant_id = ? AND rating <= 3 AND status = '待回复' AND category IS NOT NULL`,
    tenantA,
  );
  assert.ok(badPending.n >= 3, '应有待回复且已归因的示范差评供派活演示');

  // 验证 #161 查巡巡 巡店统计立即可查
  const inspSum = inspectionSummary(tenantA, { months: 3 });
  assert.equal(inspSum.totals.inspections, 2);
  assert.ok(inspSum.totals.highIssues >= 2);
});

test('二次重复执行 100% 幂等：零新增、零翻倍', () => {
  const before = countAllForTenant(tenantA);
  const second = seedSalesDemoDataset({ tenantId: tenantA, actorUserId: 101, dryRun: false });

  assert.equal(second.stores.created, 0);
  assert.equal(second.stores.skipped, 3);
  assert.equal(second.dishes.created, 0);
  assert.equal(second.dishes.skipped, 12);
  assert.equal(second.dailyOps.created, 0);
  assert.equal(second.dailyOps.skipped, 14);
  assert.equal(second.orders.created, 0);
  assert.equal(second.orders.skipped, 84);
  assert.equal(second.reviews.created, 0);
  assert.equal(second.reviews.skipped, 12);
  assert.equal(second.inspections.created, 0);
  assert.equal(second.inspections.skipped, 2);
  assert.equal(second.rectifications.created, 0);
  assert.equal(second.rectifications.skipped, 3);

  const afterCounts = countAllForTenant(tenantA);
  assert.deepEqual(afterCounts, before);
});

test('严格多租户隔离：租户 A 注入绝不影响租户 B，租户 B 可独立注入', () => {
  const beforeB = countAllForTenant(tenantB);
  for (const [key, val] of Object.entries(beforeB)) {
    assert.equal(val, 0, `租户 A 预置后，租户 B 的 ${key} 必须为 0`);
  }

  const resB = seedSalesDemoDataset({ tenantId: tenantB, dryRun: false });
  assert.equal(resB.stores.created, 3);
  assert.equal(resB.dishes.created, 12);
  assert.equal(resB.inspections.created, 2);

  // 确认租户 A 数据量未被扰动
  const countsA = countAllForTenant(tenantA);
  assert.equal(countsA.stores, 3);
  assert.equal(countsA.dishes, 12);
  assert.equal(countsA.orders, 84);
  assert.equal(countsA.inspections, 2);
});

test('CLI 脚本支持 --help 与 --dry-run 预览执行', () => {
  const scriptPath = fileURLToPath(new URL('../scripts/seed-sales-demo-data.mjs', import.meta.url));
  const helpOut = execFileSync(process.execPath, [scriptPath, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, NANOWORK_DB: DBP },
  });
  assert.match(helpOut, /--tenant-id/);
  assert.match(helpOut, /--dry-run/);

  const dryOut = execFileSync(
    process.execPath,
    [scriptPath, '--tenant-id', String(tenantA), '--dry-run'],
    {
      encoding: 'utf8',
      env: { ...process.env, NANOWORK_DB: DBP },
    },
  );
  assert.match(dryOut, /DRY-RUN 预览/);
  assert.match(dryOut, /"dryRun": true/);
});
