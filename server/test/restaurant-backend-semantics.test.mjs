import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';

const DBP = path.join(os.tmpdir(), `nanowork-restaurant-semantics-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant } = await import('../src/db.js');
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const { hashPassword } = await import('../src/util.js');
const growthRoutes = (await import('../src/routes/growth.js')).default;
const activityRoutes = (await import('../src/routes/activities.js')).default;
const analysisRoutes = (await import('../src/routes/analysis.js')).default;
const dataIntakeRoutes = (await import('../src/routes/dataintake.js')).default;
const executionRoutes = (await import('../src/routes/execution.js')).default;
const { scoreLead } = await import('../src/engines/scoring.js');
const { deriveSpecialistAssignments } = await import('../src/engines/specialist-matching.js');

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();
q.run(`INSERT INTO tenants(id,name,status,plan,credits) VALUES(1,'餐饮测试企业','已开通','标准版',100000)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,credits=excluded.credits`);
const bossId = Number(q.run(`INSERT INTO users(username,password_hash,name,role,dept,tenant_id)
  VALUES(?,?,?,?,?,1)`, 'restaurant_boss', hashPassword('test-password-123'), '测试店长', 'boss', '门店管理').lastInsertRowid);
const boss = { id: bossId, name: '测试店长', role: 'boss', tenant_id: 1 };

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => runWithTenant(1, () => { req.user = boss; next(); }));
  app.use('/growth', growthRoutes);
  app.use('/activities', activityRoutes);
  app.use('/analysis', analysisRoutes);
  app.use('/data-intake', dataIntakeRoutes);
  app.use('/execution', executionRoutes);
  return app;
}

async function withServer(fn) {
  const server = makeApp().listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function call(base, route, method = 'GET', body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

test('增长阶段写入真实餐饮订单字段，并把旧旅程值只作为读取兼容', async () => {
  const leadId = Number(q.run(`INSERT INTO leads(name,source,identity_tag,budget_level,stage,owner_id,tenant_id)
    VALUES(?,?,?,?,?,?,1)`, '顾客甲', '到店', '普通消费者', '中', '已到店', bossId).lastInsertRowid);

  await withServer(async base => {
    const first = await call(base, `/growth/leads/${leadId}/advance`, 'POST', {
      stage: '已成交', note: '顾客确认下单', deal_amount: 188,
    });
    assert.equal(first.status, 200);
    assert.equal(first.payload.warnings[0].code, 'ORDER_PRODUCT_UNCONFIRMED');
    const pendingOrder = q.get(`SELECT product,amount,type FROM orders WHERE tenant_id=1 AND lead_id=? ORDER BY id`, leadId);
    assert.deepEqual({ ...pendingOrder }, { product: '待确认商品/服务', amount: 188, type: '首次消费' });
    assert.doesNotMatch(JSON.stringify(pendingOrder), /青花清|酒道馆/);

    const repeat = await call(base, `/growth/leads/${leadId}/advance`, 'POST', {
      stage: '复购', note: '顾客确认再次购买套餐', deal_amount: 268, product: '双人晚餐套餐', order_type: '复购',
    });
    assert.equal(repeat.status, 200);
    assert.equal(q.get(`SELECT product FROM orders WHERE tenant_id=1 AND lead_id=? ORDER BY id DESC`, leadId).product, '双人晚餐套餐');

    const legacySource = await call(base, '/growth/leads', 'POST', { name: '历史来源顾客', source: '品鉴会' });
    assert.equal(legacySource.status, 200);
    assert.equal(legacySource.payload.source, '门店活动');

    const journeyLeadId = Number(q.run(`INSERT INTO leads(name,source,stage,owner_id,tenant_id) VALUES(?,?,?,?,1)`,
      '历史旅程顾客', '到店', '已到店', bossId).lastInsertRowid);
    for (const node of ['已到馆', '已品鉴', '已报价']) {
      q.run(`INSERT INTO lead_journey(lead_id,node,at,by,note,tenant_id) VALUES(?,?,datetime('now'),?,?,1)`, journeyLeadId, node, '历史系统', '兼容记录');
    }
    const journey = await call(base, `/growth/leads/${journeyLeadId}/journey`);
    assert.equal(journey.status, 200);
    assert.ok(journey.payload.journey.some(item => item.node === '已到店' && item.reached));
    assert.ok(journey.payload.journey.some(item => item.node === '已体验' && item.reached));
    assert.ok(journey.payload.journey.some(item => item.node === '已选品' && item.reached));
    assert.doesNotMatch(JSON.stringify(journey.payload.journey), /已到馆|已品鉴|已报价/);

    const objection = await call(base, `/growth/leads/${leadId}/objection`, 'POST', { text: '价格是否适合我的预算' });
    assert.equal(objection.status, 200);
    assert.match(objection.payload.suggestion, /负责人确认|门店负责人/);
    assert.doesNotMatch(objection.payload.suggestion, /多花不到|限时|就\d+个|留位|占名额/);

    const reply = await call(base, '/growth/suggest-reply', 'POST', { leadId, context: '想了解下个月门店活动' });
    assert.equal(reply.status, 200);
    assert.match(reply.payload.suggestions, /以门店回复为准|门店核实/);
    assert.doesNotMatch(reply.payload.suggestions, /就\d+个位置|留位|占个名额|比.*划算|关键是有面子/);
  });
});

test('活动新写入使用餐饮字段，复盘路由M-07且没有伪造企业基准', async () => {
  await withServer(async base => {
    const created = await call(base, '/activities', 'POST', { title: '社区晚餐体验活动', date: '2026-08-08' });
    assert.equal(created.status, 200);
    const activityId = created.payload.id;
    const row = q.get(`SELECT type,location,checklist FROM activities WHERE tenant_id=1 AND id=?`, activityId);
    assert.equal(row.type, '门店主题活动');
    assert.equal(row.location, '待确认');
    assert.match(row.checklist, /菜单、食材与餐具准备|食安与过敏原提示确认/);
    assert.doesNotMatch(row.checklist, /品鉴酒|酒道馆/);

    q.run(`UPDATE activities SET invited=20,signed_up=10,arrived=8,converted=3,revenue=1200,cost=0,satisfaction=4.5 WHERE tenant_id=1 AND id=?`, activityId);
    const review = await call(base, `/activities/${activityId}/review`, 'POST', { ok: ['顾客反馈已记录'] });
    assert.equal(review.status, 200);
    assert.equal(review.payload.aiMeta.divisionCode, 'M-07');
    assert.equal(review.payload.baselineStatus, 'unavailable');
    assert.equal(review.payload.rates.roi, null);
    assert.ok(review.payload.missingFields.length > 0);
    assert.doesNotMatch(JSON.stringify(review.payload), /M-09|限时权益|封坛|权益延期|行业基准/);

    const legacyType = await call(base, '/activities', 'POST', { title: '旧模板导入活动', date: '2026-08-09', type: '品鉴会' });
    assert.equal(legacyType.status, 200);
    assert.equal(q.get(`SELECT type FROM activities WHERE tenant_id=1 AND id=?`, legacyType.payload.id).type, '门店主题活动');
  });
});

test('毛利缺少真实成本时返回 unavailable 与缺失字段', async () => {
  await withServer(async base => {
    const margin = await call(base, '/analysis/drill/margin');
    assert.equal(margin.status, 200);
    assert.equal(margin.payload.status, 'unavailable');
    assert.equal(margin.payload.unavailable, true);
    assert.ok(margin.payload.missingFields.includes('菜品/商品销货成本'));
    assert.match(margin.payload.note, /不估填数值/u);
    assert.doesNotMatch(margin.payload.note, /演示值/u);
    assert.doesNotMatch(JSON.stringify(margin.payload), /48\.6|45%-55|封坛/);

    const overview = await call(base, '/analysis/overview');
    assert.equal(overview.status, 200);
    assert.equal(overview.payload.grossMargin, null);
    assert.equal(overview.payload.grossMarginStatus, 'unavailable');
    assert.ok(overview.payload.grossMarginMissingFields.length > 0);
  });
});

test('数据导入和执行前台餐饮化，旧值落库前归一', async () => {
  await withServer(async base => {
    const schema = await call(base, '/data-intake/schema');
    assert.equal(schema.status, 200);
    assert.equal(schema.payload.find(item => item.key === 'partners').label, '合作伙伴表');

    const committed = await call(base, '/data-intake/commit', 'POST', { batches: [
      { sheet: '历史客户阶段', target: 'leads', rows: [{ data: { name: '兼容客户', stage: '已到馆', source: '合伙人推荐' } }] },
      { sheet: '历史活动类型', target: 'activities', rows: [{ data: { title: '兼容活动', date: '2026-08-10', type: '品鉴会' } }] },
    ] });
    assert.equal(committed.status, 200);
    assert.equal(committed.payload.imported, 2);
    assert.deepEqual({ ...q.get(`SELECT stage,source FROM leads WHERE tenant_id=1 AND name='兼容客户'`) },
      { stage: '已到店', source: '合作伙伴推荐' });
    assert.equal(q.get(`SELECT type FROM activities WHERE tenant_id=1 AND title='兼容活动'`).type, '门店主题活动');

    const tiers = await call(base, '/execution/partners/tiers');
    assert.equal(tiers.status, 200);
    assert.doesNotMatch(JSON.stringify(tiers.payload), /品鉴官|回厂游|馆主|封坛|酒道馆/);
    const goals = await call(base, '/execution/goals-drill');
    assert.equal(goals.status, 200);
    assert.doesNotMatch(JSON.stringify(goals.payload.rules), /招商|回厂游|沙龙会|每增加1名.*100万/);
  });
});

test('评分兼容旧来源但前台使用餐饮来源，restaurant目录拒绝自动重匹配', () => {
  const baseLead = { identity_tag: '企业主', budget_level: '中', stage: '已到店', last_interact_at: null, concerns: '[]' };
  const canonical = scoreLead({ ...baseLead, source: '门店活动' });
  const legacy = scoreLead({ ...baseLead, source: '品鉴会' });
  assert.equal(canonical.detail['来源加权'], 5);
  assert.equal(legacy.detail['来源加权'], canonical.detail['来源加权']);

  assert.throws(
    () => deriveSpecialistAssignments({ code: 'M-01', name: '市场营销部', title: '餐饮数字员工' }, []),
    error => error?.status === 409 && error?.code === 'RESTAURANT_CATALOG_REMATCH_DISABLED',
  );
});

test('cleanup', () => {
  for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});
