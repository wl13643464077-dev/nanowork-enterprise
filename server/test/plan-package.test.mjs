// 年度套餐 / 计划模型（A4）+ 积分权益可视化（A3）
// 覆盖：默认套餐幂等种子、activate 写到期与赠分入账、顺延、席位 409、余额接口 plan 字段、
// 调度提醒幂等、estimateCreditEquivalents 假设可读。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { removeTempDbSafely } from './helpers/temp-db.mjs';

const DBP = path.join(os.tmpdir(), `nanowork-plan-package-${process.pid}.db`);
for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) fs.rmSync(f, { force: true });
process.env.NANOWORK_DB = DBP;
process.env.NODE_ENV = 'test';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.ENABLE_SCHEDULER = 'false';
for (const k of ['WXPAY_MCHID', 'WXPAY_SERIAL_NO', 'WXPAY_PRIVATE_KEY', 'WXPAY_APIV3_KEY', 'WXPAY_APPID',
  'ALIPAY_APPID', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY']) delete process.env[k];

const { initSchema, migrateV2, q, runWithTenant, getTenant, setConfig, DEFAULT_PLAN_PACKAGE } = await import('../src/db.js');
const {
  estimateCreditEquivalents, observedTextSample, billing,
  EQUIVALENT_TEXT_INPUT_TOKENS, EQUIVALENT_TEXT_OUTPUT_TOKENS, EQUIVALENT_OBSERVED_MIN_CALLS,
} = await import('../src/engines/credits.js');
const plan = await import('../src/engines/plan.js');
const rechargeRoutes = (await import('../src/routes/recharge.js')).default;
const { settlePaidOrder } = await import('../src/routes/recharge.js');
const platformRoutes = (await import('../src/routes/platform.js')).default;
const adminRoutes = (await import('../src/routes/admin.js')).default;
const { runScheduledJobs } = await import('../src/engines/scheduler.js');

initSchema();
migrateV2();

const tenantId = Number(q.run(`INSERT INTO tenants(name,status,plan,credits,total_recharged,seat_limit)
  VALUES('套餐测试餐饮','已开通','标准版',0,0,10)`).lastInsertRowid);
const bossId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES('plan_boss','x','套餐老板','boss','启用',?)`, tenantId).lastInsertRowid);
const adminId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES('plan_admin','x','套餐管理员','admin','启用',?)`, tenantId).lastInsertRowid);
const superId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES('plan_super','x','平台超管','platform_super','启用',1)`).lastInsertRowid);
const boss = { id: bossId, name: '套餐老板', role: 'boss', tenant_id: tenantId, ip: '127.0.0.1' };
const superUser = { id: superId, name: '平台超管', role: 'platform_super', tenant_id: 1, ip: '127.0.0.1' };

function makeApp(user, mount, routes) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => runWithTenant(user.tenant_id, () => { req.user = user; next(); }));
  app.use(mount, routes);
  return app;
}
async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  const port = await new Promise((resolve) => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); } finally { await new Promise((r) => server.close(r)); }
}
async function call(base, method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const planPkg = () => q.get('SELECT * FROM recharge_packages WHERE code = ?', DEFAULT_PLAN_PACKAGE.code);
const notifCount = (userId, like) => q.get(`SELECT COUNT(*) n FROM notifications WHERE tenant_id=? AND user_id=? AND title LIKE ?`, tenantId, userId, like)?.n || 0;

after(async () => { await removeTempDbSafely(DBP); });

test('默认年度套餐种子：字段齐全且重复迁移不重复插入', () => {
  const p = planPkg();
  assert.ok(p, '应存在默认年度套餐');
  assert.equal(p.name, '餐饮版年度套餐');
  assert.equal(p.kind, 'plan');
  assert.equal(Number(p.price_yuan), 9800);
  assert.equal(p.seat_limit, 5);
  assert.equal(p.valid_days, 365);
  assert.equal(p.bonus_credits, 60000);
  assert.equal(p.total_credits, 0, '不含积分：total_credits 为 0');
  assert.equal(p.enabled, 1);
  assert.deepEqual(JSON.parse(p.features).roles, ['boss', 'ops_director', 'sales']);
  migrateV2();
  migrateV2();
  assert.equal(q.get('SELECT COUNT(*) n FROM recharge_packages WHERE code = ?', DEFAULT_PLAN_PACKAGE.code).n, 1);
  // 旧积分包不受影响，仍为 credits 类型
  assert.equal(q.get(`SELECT COUNT(*) n FROM recharge_packages WHERE COALESCE(kind,'credits')='credits'`).n >= 5, true);
  for (const col of ['plan_code', 'plan_started_at', 'plan_expires_at', 'plan_status', 'seat_limit']) {
    assert.ok(q.all(`SELECT name FROM pragma_table_info('tenants')`).some(c => c.name === col), `tenants 缺列 ${col}`);
  }
});

test('平台 activate：写到期日/席位、赠送积分独立 bonus 入账；再次开通按原到期日顺延', async () => {
  const p = planPkg();
  const app = makeApp(superUser, '/api/platform', platformRoutes);
  await withServer(app, async (base) => {
    const bad = await call(base, 'POST', `/api/platform/tenants/${tenantId}/plan/activate`, { packageId: 999999 });
    assert.equal(bad.status, 400);
    const creditsPkg = q.get(`SELECT id FROM recharge_packages WHERE COALESCE(kind,'credits')='credits' LIMIT 1`);
    const wrongKind = await call(base, 'POST', `/api/platform/tenants/${tenantId}/plan/activate`, { packageId: creditsPkg.id });
    assert.equal(wrongKind.status, 400);
    assert.match(wrongKind.json.error, /年度套餐/);

    const first = await call(base, 'POST', `/api/platform/tenants/${tenantId}/plan/activate`, { packageId: p.id });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const today = plan.localDate();
    assert.equal(first.json.startedAt, today);
    assert.equal(first.json.expiresAt, plan.addDays(today, 365));
    assert.equal(first.json.rolledOver, false);
    assert.equal(first.json.bonusCredits, 60000);
    assert.equal(first.json.plan.status, 'active');
    assert.equal(first.json.plan.seatLimit, 5);
    assert.equal(first.json.plan.seatsUsed, 2, '老板+管理员=2 个启用账号');

    const t = getTenant(tenantId);
    assert.equal(t.plan_code, DEFAULT_PLAN_PACKAGE.code);
    assert.equal(t.plan_status, 'active');
    assert.equal(t.seat_limit, 5);
    assert.equal(t.plan, '餐饮版年度套餐', '旧 plan 文本标签同步为套餐名');
    assert.equal(t.credits, 60000);
    assert.equal(t.total_recharged, 60000);
    const bonusLog = q.get(`SELECT * FROM credit_logs WHERE tenant_id=? AND kind='bonus' ORDER BY id DESC LIMIT 1`, tenantId);
    assert.ok(bonusLog, '应有独立 bonus 流水');
    assert.equal(bonusLog.ai_mode, 'bonus');
    assert.equal(bonusLog.credits, -60000);
    assert.equal(bonusLog.feature, '套餐赠送积分');
    assert.match(bonusLog.note, /套餐赠送积分/);
    assert.equal(q.get(`SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=? AND kind='recharge'`, tenantId).n, 0, '不应产生购买积分流水');
    assert.ok(notifCount(bossId, '%已开通%') >= 1, '老板应收到开通通知');

    // 未到期再次开通 → 顺延 365 天、开始日不变、再送一次赠分
    const second = await call(base, 'POST', `/api/platform/tenants/${tenantId}/plan/activate`, { packageId: p.id });
    assert.equal(second.status, 200);
    assert.equal(second.json.rolledOver, true);
    assert.equal(second.json.startedAt, today);
    assert.equal(second.json.expiresAt, plan.addDays(today, 730));
    assert.equal(getTenant(tenantId).credits, 120000);
    assert.equal(q.get(`SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=? AND kind='bonus'`, tenantId).n, 2);
  });
});

test('已过期租户再次开通：从今天起算，不从旧到期日顺延', () => {
  const tid = Number(q.run(`INSERT INTO tenants(name,status,plan,credits,seat_limit,plan_code,plan_started_at,plan_expires_at,plan_status)
    VALUES('过期租户','已开通','标准版',0,5,?,'2024-01-01','2025-01-01','expired')`, DEFAULT_PLAN_PACKAGE.code).lastInsertRowid);
  q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES('expired_boss','x','老板','boss','启用',?)`, tid);
  const out = plan.activatePlanForTenant({ tenantId: tid, pkg: planPkg(), operatorUserId: superId });
  const today = plan.localDate();
  assert.equal(out.rolledOver, false);
  assert.equal(out.startedAt, today);
  assert.equal(out.expiresAt, plan.addDays(today, 365));
  assert.equal(getTenant(tid).plan_status, 'active');
});

test('支付成功入账（settlePaidOrder）对套餐订单：credits=0 不记购买流水、生效套餐并入账赠分；重复回调幂等', () => {
  const tid = Number(q.run(`INSERT INTO tenants(name,status,plan,credits,seat_limit) VALUES('扫码开通餐饮','已开通','标准版',0,5)`).lastInsertRowid);
  const uid = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES('pay_plan_boss','x','老板','boss','启用',?)`, tid).lastInsertRowid);
  const p = planPkg();
  q.run(`INSERT INTO recharge_orders(order_no,tenant_id,package_id,package_name,price_yuan,credits,status,created_by)
    VALUES('RPLAN1',?,?,?,?,?,'待支付',?)`, tid, p.id, p.name, p.price_yuan, p.total_credits, uid);
  const r1 = settlePaidOrder({ orderNo: 'RPLAN1', channelName: '微信支付', tradeNo: 'T1', paidFen: 980000 });
  assert.equal(r1.duplicated, false);
  assert.equal(r1.plan.expiresAt, plan.addDays(plan.localDate(), 365));
  assert.equal(r1.balance, 60000);
  const t = getTenant(tid);
  assert.equal(t.plan_code, DEFAULT_PLAN_PACKAGE.code);
  assert.equal(t.credits, 60000);
  assert.equal(q.get(`SELECT status FROM recharge_orders WHERE order_no='RPLAN1'`).status, '已支付');
  assert.equal(q.get(`SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=? AND kind='recharge'`, tid).n, 0);
  assert.equal(q.get(`SELECT COUNT(*) n FROM credit_logs WHERE tenant_id=? AND kind='bonus'`, tid).n, 1);
  const r2 = settlePaidOrder({ orderNo: 'RPLAN1', channelName: '微信支付', tradeNo: 'T1', paidFen: 980000 });
  assert.equal(r2.duplicated, true);
  assert.equal(getTenant(tid).credits, 60000, '重复回调不得二次入账/二次顺延');
  assert.equal(getTenant(tid).plan_expires_at, t.plan_expires_at);
});

test('平台人工确认到账对套餐订单同样生效套餐', async () => {
  const tid = Number(q.run(`INSERT INTO tenants(name,status,plan,credits,seat_limit) VALUES('对公转账餐饮','已开通','标准版',100,5)`).lastInsertRowid);
  const uid = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES('bank_boss','x','老板','boss','启用',?)`, tid).lastInsertRowid);
  const p = planPkg();
  const oid = Number(q.run(`INSERT INTO recharge_orders(order_no,tenant_id,package_id,package_name,price_yuan,credits,status,created_by)
    VALUES('RPLAN2',?,?,?,?,?,'待支付',?)`, tid, p.id, p.name, p.price_yuan, p.total_credits, uid).lastInsertRowid);
  await withServer(makeApp(superUser, '/api/platform', platformRoutes), async (base) => {
    const r = await call(base, 'POST', `/api/platform/recharge-orders/${oid}/confirm`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.balance, 60100);
    assert.equal(r.json.plan.seatLimit, 5);
    const again = await call(base, 'POST', `/api/platform/recharge-orders/${oid}/confirm`, {});
    assert.equal(again.status, 400);
  });
  assert.equal(getTenant(tid).plan_status, 'active');
  assert.equal(getTenant(tid).credits, 60100);
});

test('席位限制：启用账号达上限时建用户返回 409 可读信息；停用账号不占席位；平台超管不受限', async () => {
  // 当前租户 seat_limit=5，已启用 2（老板+管理员）
  await withServer(makeApp(boss, '/api/admin', adminRoutes), async (base) => {
    for (const i of [1, 2, 3]) {
      const r = await call(base, 'POST', '/api/admin/users', { username: `seat_u${i}`, password: 'password123', name: `员工${i}` });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    const over = await call(base, 'POST', '/api/admin/users', { username: 'seat_u4', password: 'password123', name: '员工4' });
    assert.equal(over.status, 409);
    assert.equal(over.json.error, '当前套餐含 5 个账号，已用 5 个；停用旧账号或联系升级');
    assert.equal(over.json.code, 'SEAT_LIMIT_REACHED');
    // 停用一个后可再建
    q.run(`UPDATE users SET status='停用' WHERE username='seat_u3'`);
    const freed = await call(base, 'POST', '/api/admin/users', { username: 'seat_u4', password: 'password123', name: '员工4' });
    assert.equal(freed.status, 200, JSON.stringify(freed.json));
  });
  // 平台超管账号不计席位
  q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES('seat_super2','x','超管2','platform_super','启用',?)`, tenantId);
  assert.deepEqual(plan.seatUsage(tenantId), { limit: 5, used: 5 });
  // seat_limit 为空 = 不限
  const unlimited = Number(q.run(`INSERT INTO tenants(name,status,plan,credits,seat_limit) VALUES('不限席位','已开通','旗舰版',0,NULL)`).lastInsertRowid);
  assert.deepEqual(plan.assertSeatAvailable(unlimited), { limit: null, used: 0 });
});

test('GET /api/recharge/balance 返回 plan 摘要；/packages 带 kind/features；/equivalents 登录即可读', async () => {
  await withServer(makeApp(boss, '/api/recharge', rechargeRoutes), async (base) => {
    const bal = await call(base, 'GET', '/api/recharge/balance');
    assert.equal(bal.status, 200);
    assert.equal(bal.json.planLabel, '餐饮版年度套餐');
    const p = bal.json.plan;
    assert.equal(p.code, DEFAULT_PLAN_PACKAGE.code);
    assert.equal(p.name, '餐饮版年度套餐');
    assert.equal(p.seatLimit, 5);
    assert.equal(p.seatsUsed, 5);
    assert.equal(p.startedAt, plan.localDate());
    assert.equal(p.expiresAt, plan.addDays(plan.localDate(), 730));
    assert.equal(p.status, 'active');
    assert.equal(p.daysLeft, 730);

    const pkgs = await call(base, 'GET', '/api/recharge/packages');
    const annual = pkgs.json.find(x => x.code === DEFAULT_PLAN_PACKAGE.code);
    assert.equal(annual.kind, 'plan');
    assert.deepEqual(annual.features.roles, ['boss', 'ops_director', 'sales']);
    assert.ok(pkgs.json.every(x => ['plan', 'credits'].includes(x.kind)));

    const eq = await call(base, 'GET', '/api/recharge/equivalents?credits=60000');
    assert.equal(eq.status, 200);
    assert.equal(eq.json.credits, 60000);
    assert.ok(eq.json.images > 0 && eq.json.videos > 0 && eq.json.textTasks > 0);
    // 本租户没有真实文本流水 → 价目表口径（2k+1k），人民币字段透传
    assert.equal(eq.json.basis, 'price_table');
    assert.equal(eq.json.observedSample, null);
    assert.ok(eq.json.assumptions.text.label.includes('2000'));
    const b = billing();
    assert.equal(eq.json.marginFactor, b.marginMultiplier);
    assert.equal(eq.json.supplierCostYuan, Math.round(60000 * b.creditYuan / b.marginMultiplier * 100) / 100);
    assert.ok(eq.json.unit.imageCostYuan > 0 && eq.json.unit.videoCostYuan > 0 && eq.json.unit.textTaskCostYuan > 0);
  });
  // 员工角色也能读 equivalents（登录即可），但不能读 balance
  const sales = { id: adminId, name: 'x', role: 'sales', tenant_id: tenantId };
  await withServer(makeApp(sales, '/api/recharge', rechargeRoutes), async (base) => {
    assert.equal((await call(base, 'GET', '/api/recharge/equivalents?credits=100')).status, 200);
    assert.equal((await call(base, 'GET', '/api/recharge/balance')).status, 403);
  });
});

test('estimateCreditEquivalents：从价目表反算，假设可读，不写死 800/44/66000', () => {
  const b = billing();
  const out = estimateCreditEquivalents(60000);
  const imageCredits = Math.ceil((b.image[out.models.image] ?? b.image.default) * b.marginMultiplier / b.creditYuan);
  const segment = b.video[out.models.video] ?? b.video.default;
  const videoCredits = Math.ceil(segment * 3 * b.marginMultiplier / b.creditYuan);
  const tp = b.text[out.models.text] || b.text.default;
  const textCredits = Math.max(1, Math.ceil(((EQUIVALENT_TEXT_INPUT_TOKENS * tp.in + EQUIVALENT_TEXT_OUTPUT_TOKENS * tp.out) / 1e6) * b.marginMultiplier / b.creditYuan));
  assert.equal(out.unit.imageCredits, imageCredits);
  assert.equal(out.unit.videoCredits, videoCredits);
  assert.equal(out.unit.textTaskCredits, textCredits);
  assert.equal(out.images, Math.floor(60000 / imageCredits));
  assert.equal(out.videos, Math.floor(60000 / videoCredits));
  assert.equal(out.textTasks, Math.floor(60000 / textCredits));
  assert.equal(out.assumptions.text.inputTokens, 2000);
  assert.equal(out.assumptions.text.outputTokens, 1000);
  assert.equal(out.assumptions.video.segmentCount, 3);
  assert.equal(out.assumptions.video.segmentSeconds, 10);
  assert.equal(out.assumptions.video.durationSeconds, 30);
  assert.equal(out.assumptions.marginMultiplier, b.marginMultiplier);
  assert.match(out.assumptions.formula, /marginMultiplier/);
  // 人民币口径：单位成本 = 价目表成本；总供应商成本 = 积分面值 ÷ 毛利系数（6 万积分 → ¥400）
  const textYuan = (EQUIVALENT_TEXT_INPUT_TOKENS * tp.in + EQUIVALENT_TEXT_OUTPUT_TOKENS * tp.out) / 1e6;
  assert.equal(out.unit.textTaskCostYuan, Math.round(textYuan * 10000) / 10000);
  assert.equal(out.unit.imageCostYuan, b.image[out.models.image] ?? b.image.default);
  assert.equal(out.unit.videoCostYuan, Math.round(segment * 3 * 10000) / 10000);
  assert.equal(out.supplierCostYuan, Math.round(60000 * b.creditYuan / b.marginMultiplier * 100) / 100);
  assert.equal(out.marginFactor, b.marginMultiplier);
  assert.equal(out.basis, 'price_table');
  assert.equal(out.assumptions.basis, 'price_table');
  assert.equal(out.observedSample, null);
  // 每单位积分 × 单价 ≥ 成本 × 毛利（ceil 只会向上）
  assert.ok(out.unit.textTaskCredits * b.creditYuan >= textYuan * b.marginMultiplier);
  assert.ok(out.unit.imageCredits * b.creditYuan >= out.unit.imageCostYuan * b.marginMultiplier);
  // 价目表变化 → 结果跟着变（证明不是写死的）
  const cheaper = estimateCreditEquivalents(60000, { b: { ...b, image: { ...b.image, [out.models.image]: 0.25 } } });
  assert.equal(cheaper.unit.imageCredits, Math.ceil(0.25 * b.marginMultiplier / b.creditYuan));
  assert.equal(cheaper.images, Math.floor(60000 / cheaper.unit.imageCredits));
  assert.equal(cheaper.unit.imageCostYuan, 0.25);
  assert.ok(cheaper.images > out.images);
  assert.equal(estimateCreditEquivalents(0).images, 0);
  assert.equal(estimateCreditEquivalents(0).supplierCostYuan, 0);
  assert.equal(estimateCreditEquivalents(-5).credits, 0);
});

test('estimateCreditEquivalents：本企业真实文本流水 ≥ 阈值时 basis=observed，token 假设改用真实均值；不足阈值仍走价目表', () => {
  const b = billing();
  const tid = Number(q.run(`INSERT INTO tenants(name,status,plan,credits,seat_limit) VALUES('真实流水餐饮','已开通','标准版',0,5)`).lastInsertRowid);
  const uid = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES('obs_staff','x','员工','sales','启用',?)`, tid).lastInsertRowid);
  const model = estimateCreditEquivalents(60000, { tenantId: tid }).models.text;
  const insert = (inTok, outTok, aiMode = 'api', kind = 'text', m = model) => q.run(
    `INSERT INTO credit_logs(tenant_id,user_id,feature,kind,model,input_tokens,output_tokens,cost_yuan,credits,balance_after,ai_mode)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`, tid, uid, '员工任务·测试', kind, m, inTok, outTok, 0, 1, 0, aiMode);
  // 阈值 - 1 条真实调用 + 干扰行（hold 未结算 / 0 token 释放 / 图片 / 其他模型）→ 不够样本，仍是价目表口径
  for (let i = 0; i < EQUIVALENT_OBSERVED_MIN_CALLS - 1; i++) insert(1000, 500);
  insert(9000, 9000, 'hold');
  insert(0, 0);
  insert(9000, 9000, 'api', 'image');
  insert(9000, 9000, 'api', 'text', 'some-other-model');
  assert.equal(observedTextSample(model, { tenantId: tid }), null);
  const before = estimateCreditEquivalents(60000, { tenantId: tid });
  assert.equal(before.basis, 'price_table');
  assert.equal(before.assumptions.text.inputTokens, EQUIVALENT_TEXT_INPUT_TOKENS);
  // 补到阈值 → observed；均值只算 ai_mode=api、kind=text、同模型、正 token 的行
  insert(3000, 1500);
  const sample = observedTextSample(model, { tenantId: tid });
  assert.equal(sample.calls, EQUIVALENT_OBSERVED_MIN_CALLS);
  const expectIn = Math.round((1000 * (EQUIVALENT_OBSERVED_MIN_CALLS - 1) + 3000) / EQUIVALENT_OBSERVED_MIN_CALLS);
  const expectOut = Math.round((500 * (EQUIVALENT_OBSERVED_MIN_CALLS - 1) + 1500) / EQUIVALENT_OBSERVED_MIN_CALLS);
  assert.deepEqual(sample.avgTokens, { input: expectIn, output: expectOut });
  const after = estimateCreditEquivalents(60000, { tenantId: tid });
  assert.equal(after.basis, 'observed');
  assert.equal(after.assumptions.text.basis, 'observed');
  assert.equal(after.observedSample.calls, EQUIVALENT_OBSERVED_MIN_CALLS);
  assert.equal(after.assumptions.text.inputTokens, expectIn);
  assert.equal(after.assumptions.text.outputTokens, expectOut);
  assert.match(after.assumptions.text.label, /真实调用均值/);
  const tp = b.text[model] || b.text.default;
  const yuan = (expectIn * tp.in + expectOut * tp.out) / 1e6;
  assert.equal(after.unit.textTaskCostYuan, Math.round(yuan * 10000) / 10000);
  assert.equal(after.unit.textTaskCredits, Math.max(1, Math.ceil(yuan * b.marginMultiplier / b.creditYuan)));
  assert.equal(after.textTasks, Math.floor(60000 / after.unit.textTaskCredits));
  // 图/视频不受文本样本影响；其他租户看不到这家的样本
  assert.equal(after.unit.imageCredits, before.unit.imageCredits);
  assert.equal(after.unit.videoCredits, before.unit.videoCredits);
  assert.equal(estimateCreditEquivalents(60000, { tenantId }).basis, 'price_table');
  // 显式 observed: null 可强制价目表口径（销售话术对齐用）
  assert.equal(estimateCreditEquivalents(60000, { tenantId: tid, observed: null }).basis, 'price_table');
});

test('每日检查：30/7/1 天各提醒一次、到期置 expired 并通知；低余额 24h 内只提醒一次', () => {
  const tid = Number(q.run(`INSERT INTO tenants(name,status,plan,credits,seat_limit,plan_code,plan_started_at,plan_expires_at,plan_status)
    VALUES('到期提醒餐饮','已开通','餐饮版年度套餐',100,5,?,'2026-01-01','2026-12-31','active')`, DEFAULT_PLAN_PACKAGE.code).lastInsertRowid);
  const bid = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES('remind_boss','x','老板','boss','启用',?)`, tid).lastInsertRowid);
  const aid = Number(q.run(`INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES('remind_admin','x','管理员','admin','启用',?)`, tid).lastInsertRowid);
  const count = (uid, like) => q.get(`SELECT COUNT(*) n FROM notifications WHERE tenant_id=? AND user_id=? AND title LIKE ?`, tid, uid, like)?.n || 0;
  const run = (iso) => runWithTenant(tid, () => plan.runDailyPlanAndBalanceCheck({ tenantId: tid, now: new Date(iso) }));

  // 距到期 60 天：不提醒；余额 100 < 5000 → 低余额提醒一次
  let r = run('2026-11-01T09:00:00');
  assert.equal(r.planStatus, 'active');
  assert.equal(r.reminded, null);
  assert.equal(r.lowBalanceAlerted, true);
  assert.equal(count(bid, '%余额不足%'), 1);
  // 同日 12 小时后再跑：24h 内不重复
  r = run('2026-11-01T21:00:00');
  assert.equal(r.lowBalanceAlerted, false);
  assert.equal(count(bid, '%余额不足%'), 1);
  // 阈值可配：把阈值调到 50，余额 100 就不再提醒
  setConfig(plan.LOW_BALANCE_CONFIG_KEY, 50);
  r = run('2026-11-03T09:00:00');
  assert.equal(r.threshold, 50);
  assert.equal(r.lowBalanceAlerted, false);
  setConfig(plan.LOW_BALANCE_CONFIG_KEY, 5000);

  // 距到期 30 天 → 30 天提醒一次；次日不重复
  r = run('2026-12-01T09:00:00');
  assert.equal(r.planStatus, 'expiring');
  assert.equal(r.daysLeft, 30);
  assert.equal(r.reminded, 30);
  assert.equal(count(bid, '%将于%到期%'), 1);
  assert.equal(count(aid, '%将于%到期%'), 1, '管理员也收到');
  assert.equal(getTenant(tid).plan_status, 'expiring');
  r = run('2026-12-02T09:00:00');
  assert.equal(r.reminded, null);
  // 7 天
  r = run('2026-12-24T09:00:00');
  assert.equal(r.reminded, 7);
  assert.equal(count(bid, '%将于%到期%'), 2);
  // 1 天 / 当天：只提醒一次
  r = run('2026-12-30T09:00:00');
  assert.equal(r.reminded, 1);
  r = run('2026-12-31T09:00:00');
  assert.equal(r.reminded, null);
  assert.equal(count(bid, '%将于%到期%'), 3);
  // 到期次日 → expired + 一次通知；之后不重复；不锁功能（状态仍是已开通）
  r = run('2027-01-01T09:00:00');
  assert.equal(r.planStatus, 'expired');
  assert.equal(r.expired, true);
  assert.equal(getTenant(tid).plan_status, 'expired');
  assert.equal(getTenant(tid).status, '已开通');
  assert.equal(count(bid, '%已于%到期%'), 1);
  r = run('2027-01-02T09:00:00');
  assert.equal(r.expired, false);
  assert.equal(count(bid, '%已于%到期%'), 1);
  // 摘要口径实时：daysLeft 为负、status=expired
  const s = plan.planSummary(tid, '2027-01-05');
  assert.equal(s.status, 'expired');
  assert.equal(s.daysLeft, -5);
});

test('scheduler 09:00 挂载 daily_plan_and_balance_check 且 runOnce 幂等', async () => {
  const before = q.get(`SELECT COUNT(*) n FROM scheduled_runs WHERE job_key LIKE 'daily_plan_and_balance_check:%'`).n;
  const at9 = new Date('2026-09-10T01:00:00Z'); // 上海 09:00
  const first = runScheduledJobs(at9, { contentAutomationRunner: async () => null });
  await first.pending;
  const mine = first.results.find(x => x.tenantId === tenantId);
  assert.equal(mine.dailyPlanAndBalanceCheck, true);
  const after9 = q.get(`SELECT COUNT(*) n FROM scheduled_runs WHERE job_key LIKE 'daily_plan_and_balance_check:%'`).n;
  assert.ok(after9 > before);
  const second = runScheduledJobs(at9, { contentAutomationRunner: async () => null });
  await second.pending;
  assert.equal(second.results.find(x => x.tenantId === tenantId).dailyPlanAndBalanceCheck, false, '同日重复 tick 不再执行');
  const at10 = new Date('2026-09-10T02:00:00Z');
  const third = runScheduledJobs(at10, { contentAutomationRunner: async () => null });
  await third.pending;
  assert.equal(third.results.find(x => x.tenantId === tenantId).dailyPlanAndBalanceCheck, undefined, '非 09:00 不触发');
});

test('平台套餐 CRUD 支持 kind/seat_limit/valid_days/bonus_credits/is_active', async () => {
  await withServer(makeApp(superUser, '/api/platform', platformRoutes), async (base) => {
    const bad = await call(base, 'POST', '/api/platform/packages', { name: '缺字段年包', price_yuan: 100, kind: 'plan' });
    assert.equal(bad.status, 400);
    const created = await call(base, 'POST', '/api/platform/packages', {
      name: '试用月包', price_yuan: 980, kind: 'plan', seat_limit: 2, valid_days: 30, bonus_credits: 5000, is_active: false, sort_order: 3, code: 'trial_monthly',
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const row = q.get('SELECT * FROM recharge_packages WHERE id = ?', created.json.id);
    assert.equal(row.kind, 'plan');
    assert.equal(row.seat_limit, 2);
    assert.equal(row.valid_days, 30);
    assert.equal(row.bonus_credits, 5000);
    assert.equal(row.total_credits, 0);
    assert.equal(row.enabled, 0);
    assert.equal(row.sort, 3);
    const dup = await call(base, 'POST', '/api/platform/packages', { name: '重复编码', price_yuan: 1, kind: 'credits', code: 'trial_monthly' });
    assert.equal(dup.status, 409);
    const updated = await call(base, 'PUT', `/api/platform/packages/${row.id}`, { seat_limit: 3, enabled: true });
    assert.equal(updated.status, 200);
    const row2 = q.get('SELECT * FROM recharge_packages WHERE id = ?', row.id);
    assert.equal(row2.seat_limit, 3);
    assert.equal(row2.enabled, 1);
    assert.equal(row2.valid_days, 30, '未传字段保持原值');
    // 积分包沿用旧口径：到账 = 价格×100 + 赠送
    const cp = await call(base, 'POST', '/api/platform/packages', { name: '小积分包', price_yuan: 50, bonus_credits: 500 });
    const crow = q.get('SELECT * FROM recharge_packages WHERE id = ?', cp.json.id);
    assert.equal(crow.kind, 'credits');
    assert.equal(crow.total_credits, 5500);
    const list = await call(base, 'GET', '/api/platform/packages');
    const found = list.json.find(x => x.id === row.id);
    assert.equal(found.is_active, 1);
    assert.equal(found.sort_order, 3);
  });
});
