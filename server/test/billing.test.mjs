// 计费引擎测试（钱不能错）：扣减精确、事务一致、对账恒等、余额不足从源头拦截。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DBP = path.join(os.tmpdir(), `shanmei-bill-${process.pid}.db`);
for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;

const { db, qRaw, initSchema, migrateV2 } = await import('../src/db.js');
initSchema();
migrateV2();
const credits = await import('../src/engines/credits.js');

// 一家企业 + 其下一个员工（积分池在租户层，企业内账号共享）
const T = Number(qRaw.run("INSERT INTO tenants(name,status,credits) VALUES('计费企业','已开通',0)").lastInsertRowid);
const U = Number(qRaw.run("INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES('biz_u1','x','员工1','sales',?)", T).lastInsertRowid);
// 充值入账由平台超管发起（生产中始终带操作人 id）
const SUPER = Number(qRaw.run("INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES('plat_super','x','平台超管','platform_super',1)").lastInsertRowid);

test('入账：余额 / 累计充值 / 流水 三者一致', () => {
  const { balance } = credits.creditTenant({ tenantId: T, delta: 1000, userId: SUPER, feature: '测试充值' });
  assert.equal(balance, 1000);
  const t = db.prepare('SELECT credits,total_recharged FROM tenants WHERE id=?').get(T);
  assert.equal(t.credits, 1000);
  assert.equal(t.total_recharged, 1000, '累计充值应同步累加');
  const log = db.prepare('SELECT balance_after FROM credit_logs WHERE tenant_id=? ORDER BY id DESC LIMIT 1').get(T);
  assert.equal(log.balance_after, 1000, '流水快照余额应与实际一致');
});

test('扣减：按 token 精确计费，余额减少量 == 流水记账量', () => {
  const before = credits.balanceOfTenant(T);
  // deepseek-v4-flash 单价 in/out=5/5（元/百万token）；(1000*5+1000*5)/1e6=0.01元 ×1.5毛利 /0.01元每分 = 1.5 → 向上取整 2 分
  const r = credits.charge({ userId: U, feature: 'AI话术', kind: 'text', model: 'deepseek-v4-flash', usage: { inputTokens: 1000, outputTokens: 1000 }, aiMode: 'api' });
  assert.equal(r.credits, 2, '计费公式：ceil(成本×毛利/单价)');
  assert.equal(r.balance, before - 2, '余额应精确减少 2 分');
  const log = db.prepare('SELECT credits,balance_after FROM credit_logs WHERE tenant_id=? ORDER BY id DESC LIMIT 1').get(T);
  assert.equal(log.credits, 2);
  assert.equal(log.balance_after, before - 2);
});

test('模板模式（aiMode=template）零扣费，但保留审计流水', () => {
  const before = credits.balanceOfTenant(T);
  const r = credits.charge({ userId: U, feature: '模板套用', kind: 'text', model: 'deepseek-v4-flash', usage: { inputTokens: 9999, outputTokens: 9999 }, aiMode: 'template' });
  assert.equal(r.credits, 0, '模板模式不耗 token，不扣分');
  assert.equal(credits.balanceOfTenant(T), before, '余额不变');
});

test('对账恒等：期末余额 ≡ −Σ(流水)（账实相符，可向甲方证明）', () => {
  // 约定：流水 credits 字段 消耗记正、充值记负；初始 0 → 余额 = −Σcredits
  const sum = db.prepare('SELECT COALESCE(SUM(credits),0) s FROM credit_logs WHERE tenant_id=?').get(T).s;
  assert.equal(credits.balanceOfTenant(T), -sum);
});

test('预检：余额不足 → 402 拦截，从源头杜绝坏账（不发起外部调用）', () => {
  const poor = Number(qRaw.run("INSERT INTO tenants(name,status,credits) VALUES('余额不足企业','已开通',1)").lastInsertRowid);
  const pu = Number(qRaw.run("INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES('biz_poor','x','穷','boss',?)", poor).lastInsertRowid);
  assert.throws(
    () => credits.precheck(pu, 'text', 'gpt-5.5'),
    (e) => e.status === 402,
    '余额 1 分 < 老板级模型单次上限，应 402');
});

test('企业内账号共享同一积分池（按 userId→tenant 解析）', () => {
  const U2 = Number(qRaw.run("INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES('biz_u2','x','员工2','sales',?)", T).lastInsertRowid);
  assert.equal(credits.balanceOf(U2), credits.balanceOf(U), '同企业不同账号余额应一致');
});

test('老板按员工账号增加或扣减时，共享池与记账流水同步更新', () => {
  const before = credits.balanceOfTenant(T);
  const added = credits.adjust({ userId: U, delta: 500, operatorId: SUPER, note: '员工额度增加测试' });
  assert.equal(added.balance, before + 500);
  const reduced = credits.adjust({ userId: U, delta: -120, operatorId: SUPER, note: '员工额度扣减测试' });
  assert.equal(reduced.balance, before + 380);
  const logs = db.prepare(`SELECT credits,balance_after FROM credit_logs WHERE tenant_id=? AND user_id=? ORDER BY id DESC LIMIT 2`).all(T, U);
  assert.deepEqual(logs.map(x => x.credits), [120, -500]);
  assert.equal(logs[0].balance_after, before + 380);
});

test('不存在的账号不能借租户1默认值产生积分流水', () => {
  const before = credits.balanceOfTenant(1);
  assert.throws(() => credits.adjust({ userId: 999999, delta: 10, operatorId: SUPER }), error => error.status === 404);
  assert.equal(credits.balanceOfTenant(1), before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM credit_logs WHERE user_id=?').get(999999).n, 0);
});

test('cleanup', () => {
  for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
});
