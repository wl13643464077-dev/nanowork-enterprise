#!/usr/bin/env node
// 纳米Work行业版 · R-01 销售演示脱敏样例数据预置工具
//
// 用法：
//   node server/scripts/seed-sales-demo-data.mjs --tenant-id <id> [--dry-run] [--actor-user-id <uid>]
//
// 安全护栏：
//   - 必须显式指定 --tenant-id <正整数>，绝不对未知生产租户自动执行
//   - 100% 幂等：重复执行按固定编号/唯一键去重，不会翻倍或覆盖已有业务记录
//   - 使用中性脱敏示范品牌「味尚小馆」（望京店/国贸店/三里屯店），无真实客户隐私

import { initSchema, migrateV2 } from '../src/db.js';
import { seedSalesDemoDataset } from '../src/engines/demo-sample-seed.js';

function printHelp() {
  console.log(`用法：node server/scripts/seed-sales-demo-data.mjs --tenant-id <id> [选项]

说明：
  为指定演示租户幂等预置脱敏样例数据（3 家门店、12 道菜品、近 14 天经营日报与订单明细、
  12 条多平台评价、2 条 #161 查巡巡 示范巡店与整改台账），立刻点亮驾驶舱、经营洞察、
  菜品 TOP10、评价中心与巡店督导卡。

选项：
  --tenant-id <id>         必填。目标租户 ID（必须为已存在的正整数租户）
  --actor-user-id <uid>    可选。操作人用户 ID（记录在示范评价/巡店任务上）
  --dry-run                仅预览将新增/跳过的条目数，对数据库零写入
  -h, --help               显示本帮助信息

示例：
  node server/scripts/seed-sales-demo-data.mjs --tenant-id 2 --dry-run
  node server/scripts/seed-sales-demo-data.mjs --tenant-id 2`);
}

function usageError(msg) {
  console.error(`[seed-sales-demo-data] ${msg}`);
  console.error('使用 --help 查看完整用法。');
  process.exit(2);
}

const args = process.argv.slice(2);
let tenantIdRaw = '';
let actorUserIdRaw = '';
let dryRun = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  const next = () => {
    const val = args[++i];
    if (val == null) usageError(`${arg} 需要参数值`);
    return val;
  };
  if (arg === '-h' || arg === '--help') {
    printHelp();
    process.exit(0);
  } else if (arg === '--tenant-id') {
    tenantIdRaw = next();
  } else if (arg.startsWith('--tenant-id=')) {
    tenantIdRaw = arg.slice('--tenant-id='.length);
  } else if (arg === '--actor-user-id') {
    actorUserIdRaw = next();
  } else if (arg.startsWith('--actor-user-id=')) {
    actorUserIdRaw = arg.slice('--actor-user-id='.length);
  } else if (arg === '--dry-run') {
    dryRun = true;
  } else {
    usageError(`未知参数：${arg}`);
  }
}

if (!tenantIdRaw) {
  usageError('必须显式指定 --tenant-id <id>（安全护栏：禁止缺省写入未知租户）');
}

const tenantId = Number(tenantIdRaw);
if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
  usageError(`--tenant-id 必须为正整数，当前收到：${tenantIdRaw}`);
}

let actorUserId = null;
if (actorUserIdRaw) {
  actorUserId = Number(actorUserIdRaw);
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
    usageError(`--actor-user-id 必须为正整数，当前收到：${actorUserIdRaw}`);
  }
}

try {
  initSchema();
  migrateV2();
  const result = seedSalesDemoDataset({ tenantId, actorUserId, dryRun });
  const modeLabel = dryRun ? 'DRY-RUN 预览（未写入数据库）' : '已写入完成';
  console.log(`\n=== 销售演示脱敏样例数据预置 · ${modeLabel} ===`);
  console.log(`目标租户：#${result.tenantId}（${result.tenantName}）`);
  const rows = [
    ['示范门店 stores', result.stores],
    ['示范菜品 dishes', result.dishes],
    ['经营日报 daily_ops', result.dailyOps],
    ['分店日结 store_daily_ops', result.storeDailyOps],
    ['示范订单 orders', result.orders],
    ['订单明细 order_items', result.orderItems],
    ['成本台账 costs', result.costs],
    ['多平台评价 store_reviews', result.reviews],
    ['巡店记录 store_inspections', result.inspections],
    ['整改台账 rectifications', result.rectifications],
  ];
  for (const [label, c] of rows) {
    console.log(
      `  - ${label.padEnd(28)} ${dryRun ? '计划新增' : '新增'} ${String(c.created).padStart(3)} / 已存在跳过 ${String(c.skipped).padStart(3)}（共 ${c.total}）`,
    );
  }
  console.log('\nJSON 汇总：');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`[seed-sales-demo-data] 执行失败：${error.message}`);
  process.exit(1);
}
