// 多租户隔离测试（命脉）：证明 A 企业的数据 B 企业绝对看不到、改不到。
// 用独立临时库运行，不碰生产数据。零第三方依赖（Node 内置 node:test）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DBP = path.join(os.tmpdir(), `shanmei-iso-${process.pid}.db`);
for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;

const { db, q, qRaw, curTenant, runWithTenant, initSchema, migrateV2 } = await import('../src/db.js');
initSchema();
migrateV2();

// 两家互不相关的企业
const A = Number(qRaw.run("INSERT INTO tenants(name,status) VALUES('甲企业','已开通')").lastInsertRowid);
const B = Number(qRaw.run("INSERT INTO tenants(name,status) VALUES('乙企业','已开通')").lastInsertRowid);

test('写入侧：隔离表 INSERT 自动注入当前租户 tenant_id（开发者忘写也不会串户）', () => {
  runWithTenant(A, () => q.run("INSERT INTO leads(name) VALUES('客户甲')"));
  runWithTenant(B, () => q.run("INSERT INTO leads(name) VALUES('客户乙')"));
  const ta = db.prepare('SELECT tenant_id FROM leads WHERE name=?').get('客户甲').tenant_id;
  const tb = db.prepare('SELECT tenant_id FROM leads WHERE name=?').get('客户乙').tenant_id;
  assert.equal(ta, A, '客户甲应落在甲企业');
  assert.equal(tb, B, '客户乙应落在乙企业');
});

test('读取侧：标准 tenant_id 过滤下，甲企业绝对看不到乙企业客户（跨租户零泄露）', () => {
  const seenByA = runWithTenant(A, () => q.all(`SELECT name FROM leads WHERE tenant_id = ${curTenant()}`).map(r => r.name));
  assert.ok(seenByA.includes('客户甲'), '甲企业应看到自己的客户');
  assert.ok(!seenByA.includes('客户乙'), '泄露！甲企业看到了乙企业的客户');
  assert.equal(seenByA.length, 1);
});

test('curTenant：无上下文默认总部(1)，runWithTenant 正确切换且支持嵌套恢复', () => {
  assert.equal(curTenant(), 1, '请求外无上下文应回落总部 1');
  runWithTenant(A, () => {
    assert.equal(curTenant(), A);
    runWithTenant(B, () => assert.equal(curTenant(), B));
    assert.equal(curTenant(), A, '内层退出后应恢复外层租户');
  });
  assert.equal(curTenant(), 1);
});

test('多张隔离表（kb_docs/contents）一视同仁，各自隔离', () => {
  runWithTenant(A, () => q.run("INSERT INTO kb_docs(title,body,category) VALUES('甲手册','x','品牌资料')"));
  runWithTenant(B, () => q.run("INSERT INTO kb_docs(title,body,category) VALUES('乙手册','y','品牌资料')"));
  runWithTenant(A, () => q.run("INSERT INTO contents(type,title,body) VALUES('朋友圈','甲文案','...')"));
  const kbA = runWithTenant(A, () => q.all(`SELECT title FROM kb_docs WHERE tenant_id = ${curTenant()}`).map(r => r.title));
  const contentB = runWithTenant(B, () => q.all(`SELECT title FROM contents WHERE tenant_id = ${curTenant()}`).map(r => r.title));
  assert.deepEqual(kbA, ['甲手册'], '甲企业知识库只应有甲手册');
  assert.deepEqual(contentB, [], '乙企业不该看到甲企业的文案');
});

test('显式 tenant_id 不被二次注入（平台超管跨租户写场景）', () => {
  // 上下文是 A，但显式写入 B —— 注入逻辑应识别已带 tenant_id 而不覆盖
  runWithTenant(A, () => q.run('INSERT INTO leads(name,tenant_id) VALUES(?,?)', '显式归乙', B));
  const t = db.prepare('SELECT tenant_id FROM leads WHERE name=?').get('显式归乙').tenant_id;
  assert.equal(t, B, '显式指定的 tenant_id 应被尊重');
});

test('全局表（recharge_packages 非隔离）不被注入 tenant_id（否则全局表会报错/污染）', () => {
  // 该表无 tenant_id 列；若注入逻辑误伤，会抛 "no such column: tenant_id"
  assert.doesNotThrow(() => runWithTenant(A, () =>
    q.run("INSERT INTO recharge_packages(name,price_yuan,base_credits,total_credits) VALUES('测试套餐',100,10000,10000)")));
});

// ===== BE-C2 读侧作用域包装：q.scopedAll / scopedGet / scopedCount =====

test('scopedAll：不写任何 WHERE 也自动只回当前租户数据（读侧数据层强制）', () => {
  const seenByA = runWithTenant(A, () => q.scopedAll('leads').map(r => r.name));
  assert.ok(seenByA.includes('客户甲'));
  assert.ok(!seenByA.includes('客户乙'), '泄露！scopedAll 让甲企业看到了乙企业客户');
  const seenByB = runWithTenant(B, () => q.scopedAll('leads').map(r => r.name));
  assert.ok(!seenByB.includes('客户甲'), '泄露！scopedAll 让乙企业看到了甲企业客户');
});

test('scopedGet：按 id 直查他租户记录返回 undefined（IDOR 防线）', () => {
  const leadB = db.prepare('SELECT id FROM leads WHERE name=?').get('客户乙');
  const hitOwn = runWithTenant(B, () => q.scopedGet('leads', 'AND id = ?', leadB.id));
  const hitCross = runWithTenant(A, () => q.scopedGet('leads', 'AND id = ?', leadB.id));
  assert.equal(hitOwn?.name, '客户乙', '本租户按 id 应查得到');
  assert.equal(hitCross, undefined, '跨租户按 id 直查必须查不到');
});

test('scopedCount / 条件与排序 tail：AND 条件正常生效且仍限定本租户', () => {
  runWithTenant(A, () => q.run("INSERT INTO leads(name,stage) VALUES('甲成交客户','已成交')"));
  runWithTenant(B, () => q.run("INSERT INTO leads(name,stage) VALUES('乙成交客户','已成交')"));
  assert.equal(runWithTenant(A, () => q.scopedCount('leads', 'AND stage = ?', '已成交')), 1);
  const ordered = runWithTenant(A, () => q.scopedAll('leads', 'ORDER BY id DESC LIMIT 1'));
  assert.equal(ordered.length, 1);
  assert.equal(ordered[0].name, '甲成交客户');
});

test('scoped 系列拒绝危险用法：非隔离表 / 非法 tail 前缀 / 顶层裸 OR 一律抛错', () => {
  assert.throws(() => q.scopedAll('users'), /隔离/, 'users 是全局表，不允许走 scoped 入口');
  assert.throws(() => q.scopedAll('leads; DROP TABLE leads'), /隔离/, '表名必须在隔离集白名单内');
  assert.throws(() => q.scopedAll('leads', 'WHERE 1=1'), /AND\/ORDER BY/, 'tail 不许自带 WHERE');
  assert.throws(() => q.scopedAll('leads', 'OR 1=1'), /AND\/ORDER BY/, 'tail 不许以 OR 开头');
  assert.throws(() => q.scopedAll('leads', 'AND stage = ? OR 1=1'), /裸 OR/, '顶层裸 OR 会击穿隔离');
  // 括号内 OR 是合法组合条件，不应误伤
  assert.doesNotThrow(() => runWithTenant(A, () => q.scopedAll('leads', "AND (stage = '新线索' OR stage = '已成交')")));
});

// ===== BE-C2 写侧兜底：injectTenantInsert 无法注入时抛错，绝不静默落总部租户 =====

test('INSERT..SELECT 进隔离表且未显式带 tenant_id：抛错而非静默落 DEFAULT 1', () => {
  assert.throws(
    () => runWithTenant(A, () => q.run("INSERT INTO leads(name) SELECT name || '-复制' FROM leads")),
    /无法自动注入 tenant_id.*INSERT\.\.SELECT/s,
    'INSERT..SELECT 无 VALUES，注入器必须拒绝而不是放行');
});

test('无列名清单的隔离表 INSERT（裸 VALUES / INSERT..SELECT）：抛错兜底', () => {
  assert.throws(
    () => runWithTenant(A, () => q.run('INSERT INTO leads SELECT * FROM leads')),
    /无法自动注入 tenant_id/, '无列名清单无法核验 tenant_id，必须拒绝');
});

test('显式带 tenant_id 列的 INSERT..SELECT 合法放行（正确的多租户复制写法）', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM leads WHERE tenant_id=?').get(A).n;
  assert.doesNotThrow(() => runWithTenant(A, () =>
    q.run(`INSERT INTO leads(name,tenant_id) SELECT name || '-归档', tenant_id FROM leads WHERE tenant_id = ?`, A)));
  const after = db.prepare('SELECT COUNT(*) n FROM leads WHERE tenant_id=?').get(A).n;
  assert.equal(after, before * 2, '显式 tenant_id 的 INSERT..SELECT 应正常执行且只复制本租户');
});

test('qRaw.run 保留为平台级逃生门：INSERT..SELECT 不受兜底拦截', () => {
  assert.doesNotThrow(() => qRaw.run(
    `INSERT INTO leads(name,tenant_id) SELECT '平台迁移-' || id, tenant_id FROM leads WHERE name = '客户甲'`));
});

// ===== BE-M2 复合索引：存在性 + EXPLAIN QUERY PLAN 命中 =====

test('四个租户复合索引已建立且被查询计划命中', () => {
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map(r => r.name);
  for (const name of ['idx_leads_tenant_stage', 'idx_contents_tenant_created', 'idx_agent_tasks_tenant', 'idx_credit_logs_tenant_created']) {
    assert.ok(idx.includes(name), `缺少索引 ${name}`);
  }
  const plan = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(r => r.detail).join(' | ');
  assert.match(plan(`SELECT COUNT(*) FROM leads WHERE tenant_id=1 AND stage='新线索'`), /idx_leads_tenant_stage/);
  assert.match(plan(`SELECT * FROM contents WHERE tenant_id=1 AND created_at>='2026-01-01'`), /idx_contents_tenant_created/);
  assert.match(plan(`SELECT * FROM agent_tasks WHERE tenant_id=1 AND marshal_id=3`), /idx_agent_tasks_tenant/);
  assert.match(plan(`SELECT * FROM credit_logs WHERE tenant_id=1 AND created_at>='2026-01-01'`), /idx_credit_logs_tenant_created/);
});

test('cleanup', () => {
  for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
});
