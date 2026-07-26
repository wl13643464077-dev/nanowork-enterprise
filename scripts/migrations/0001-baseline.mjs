// 0001-baseline：把「migrate.mjs 接管之前」的存量结构标记为基线。
// 现状：全量建表与历史增量由 server/src/db.js 的 initSchema()+migrateV2() 在启动时幂等执行，
// 本迁移不重复建表，只做一次结构自检——确认核心表存在，证明该库确实是本项目的库。
// 自 0002 起，新的结构变更应写成独立迁移文件，避免继续扩大 migrateV2()。

const CORE_TABLES = ['users', 'tenants', 'leads', 'daily_ops', 'credit_logs', 'sys_config'];

/** @param {import('node:sqlite').DatabaseSync} db */
export function up(db) {
  const have = new Set(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name)
  );
  const missing = CORE_TABLES.filter(t => !have.has(t));
  if (missing.length) {
    throw new Error(`基线校验失败，缺核心表：${missing.join('、')}。请先启动一次 server 完成 initSchema，再执行迁移`);
  }
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function down() {
  // 基线标记本身无结构变更，down 仅移除记录（由运行器完成），无需操作
}
