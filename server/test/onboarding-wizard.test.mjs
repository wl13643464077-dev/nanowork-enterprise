// 开店向导（租户级 5 问初始配置）：状态读取、部分保存、complete 落地（门店 upsert、
// 知识库入库、状态翻转、非 boss 403）、skip、租户隔离，以及 /auth/me 带回 onboardingStatus。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const DB_PATH = path.join(os.tmpdir(), `nanowork-onboarding-wizard-${process.pid}.db`);
const DATABASE_FILES = [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`];
for (const file of DATABASE_FILES) fs.rmSync(file, { force: true });

process.env.NANOWORK_DB = DB_PATH;
process.env.JWT_SECRET = 'Onboarding-Wizard-Test#2026!server-owned';
// 不配置任何 AI 通道：推荐必须走目录默认三人组，complete 不得因此失败。
delete process.env.YUNWU_API_KEY;
delete process.env.ENABLE_BACKGROUND_EMBEDDINGS;

const { db, initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
const { authMiddleware, hashPassword, signToken } = await import('../src/util.js');
const { default: onboardingRoutes, ONBOARDING_STEPS, GOALS } = await import('../src/routes/onboarding.js');
const { default: authRoutes } = await import('../src/routes/auth.js');

initSchema();
migrateV2();

const insertTenant = db.prepare(`INSERT INTO tenants(id,name,status) VALUES(?,?,'已开通')`);
insertTenant.run(911, '向导测试企业一');
insertTenant.run(912, '向导测试企业二');

const passwordHash = hashPassword('Wizard-Test#2026');
const insertUser = db.prepare(`
  INSERT INTO users(username,password_hash,name,role,status,tenant_id)
  VALUES(?,?,?,?,'启用',?)
`);
const bossOneId = Number(insertUser.run('wizard_boss_one', passwordHash, '企业一老板', 'boss', 911).lastInsertRowid);
const staffOneId = Number(insertUser.run('wizard_staff_one', passwordHash, '企业一店长', 'manager', 911).lastInsertRowid);
const bossTwoId = Number(insertUser.run('wizard_boss_two', passwordHash, '企业二老板', 'boss', 912).lastInsertRowid);

const insertFile = db.prepare(`
  INSERT INTO uploaded_files(user_id,name,stored_name,ext,mime,size,purpose,file_url,tenant_id)
  VALUES(?,?,?,?,?,?,?,?,?)
`);
const ownFileId = Number(insertFile.run(bossOneId, '春季菜单.xlsx', 'menu-1.xlsx', 'xlsx', 'application/vnd.ms-excel', 1024, 'onboarding', '/uploads/files/911/menu-1.xlsx', 911).lastInsertRowid);
const foreignFileId = Number(insertFile.run(bossTwoId, '别家菜单.xlsx', 'menu-2.xlsx', 'xlsx', 'application/vnd.ms-excel', 1024, 'onboarding', '/uploads/files/912/menu-2.xlsx', 912).lastInsertRowid);

function tokenFor(id, tenantId, role) {
  return signToken({ id, username: `wizard-${id}`, name: `测试账号${id}`, tenant_id: tenantId, role, auth_version: 0 });
}
const tokens = {
  bossOne: tokenFor(bossOneId, 911, 'boss'),
  staffOne: tokenFor(staffOneId, 911, 'manager'),
  bossTwo: tokenFor(bossTwoId, 912, 'boss'),
};

const app = express();
app.use(express.json());
const scope = (req, _res, next) => runWithTenant(req.user.tenant_id, () => next());
app.use('/api/onboarding', authMiddleware, scope, onboardingRoutes);
app.use('/api/auth', authRoutes);
const server = app.listen(0, '127.0.0.1');
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

async function request(token, url, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

const FULL_ANSWERS = {
  storeName: '老王牛肉面（万达店）',
  bizType: '快餐',
  city: '成都',
  district: '万达广场 3 楼',
  seats: 40,
  customerGroups: ['周边白领', '学生'],
  avgTicket: 28,
  dineInRatio: 70,
  signatureDishes: ['红烧牛肉面', '酸辣粉', '卤蛋'],
  menuFileIds: [ownFileId],
  goal: '出餐效率',
  goalTarget: '中午高峰出餐 8 分钟内',
  painPoint: '中午高峰出餐太慢，客人等不及就走了。',
};

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  for (const file of DATABASE_FILES) fs.rmSync(file, { force: true });
});

test('开店向导：状态、草稿、落地、跳过与租户隔离', async t => {
  await t.test('题目由服务端下发，五步固定且不含技术词', () => {
    assert.equal(ONBOARDING_STEPS.length, 5);
    assert.deepEqual(ONBOARDING_STEPS.map(step => step.key), ['store', 'customers', 'menu', 'goal', 'pain']);
    for (const step of ONBOARDING_STEPS) {
      assert.doesNotMatch(`${step.title}${step.hint}`, /API|JSON|SQL|向量|租户|数据库/u);
    }
    assert.ok(GOALS.includes('营收') && GOALS.includes('成本'));
  });

  await t.test('新企业默认 pending，登录态与 /auth/me 都带 onboardingStatus', async () => {
    const state = await request(tokens.bossOne, '/api/onboarding/state');
    assert.equal(state.status, 200);
    assert.equal(state.payload.status, 'pending');
    assert.equal(state.payload.canEdit, true);
    assert.deepEqual(state.payload.answers, {});
    assert.equal(state.payload.steps.length, 5);
    assert.equal(state.payload.progress.nextStep, 'store');

    const me = await request(tokens.bossOne, '/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.payload.tenant.onboardingStatus, 'pending');
    assert.equal(me.payload.tenant.id, 911);

    const staffState = await request(tokens.staffOne, '/api/onboarding/state');
    assert.equal(staffState.status, 200);
    assert.equal(staffState.payload.canEdit, false);
  });

  await t.test('部分保存：多次调用累积答案，状态转为 in_progress，非法值 400', async () => {
    const first = await request(tokens.bossOne, '/api/onboarding/answers', {
      method: 'PUT',
      body: { answers: { storeName: '  老王牛肉面（万达店） ', bizType: '快餐', city: '成都', seats: 40 } },
    });
    assert.equal(first.status, 200);
    assert.equal(first.payload.status, 'in_progress');
    assert.equal(first.payload.answers.storeName, '老王牛肉面（万达店）');
    assert.deepEqual(first.payload.progress.answeredSteps, ['store']);
    assert.equal(first.payload.progress.nextStep, 'customers');

    const second = await request(tokens.bossOne, '/api/onboarding/answers', {
      method: 'PUT',
      body: { answers: { customerGroups: ['周边白领'], avgTicket: 28 } },
    });
    assert.equal(second.status, 200);
    assert.equal(second.payload.answers.storeName, '老王牛肉面（万达店）', '先前答案不能丢');
    assert.deepEqual(second.payload.progress.answeredSteps, ['store', 'customers']);

    const badBiz = await request(tokens.bossOne, '/api/onboarding/answers', {
      method: 'PUT',
      body: { answers: { bizType: '夜总会' } },
    });
    assert.equal(badBiz.status, 400);
    assert.equal(badBiz.payload.field, 'bizType');

    const tooLong = await request(tokens.bossOne, '/api/onboarding/answers', {
      method: 'PUT',
      body: { answers: { painPoint: '啊'.repeat(201) } },
    });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.payload.error, /200/u);

    const foreignFile = await request(tokens.bossOne, '/api/onboarding/answers', {
      method: 'PUT',
      body: { answers: { menuFileIds: [foreignFileId] } },
    });
    assert.equal(foreignFile.status, 400, '别家企业的文件不能被引用');

    const me = await request(tokens.bossOne, '/api/auth/me');
    assert.equal(me.payload.tenant.onboardingStatus, 'in_progress');
  });

  await t.test('非 boss/admin 只能读，不能写', async () => {
    for (const [url, method] of [
      ['/api/onboarding/answers', 'PUT'],
      ['/api/onboarding/complete', 'POST'],
      ['/api/onboarding/skip', 'POST'],
    ]) {
      const denied = await request(tokens.staffOne, url, { method, body: { answers: { city: '成都' } } });
      assert.equal(denied.status, 403, `${method} ${url} 应 403`);
    }
  });

  await t.test('答案不全时 complete 返回 400 并列出缺项，不落任何数据', async () => {
    const result = await request(tokens.bossOne, '/api/onboarding/complete', { method: 'POST', body: {} });
    assert.equal(result.status, 400);
    assert.ok(Array.isArray(result.payload.missing) && result.payload.missing.length > 0);
    assert.ok(result.payload.missing.some(item => item.name === 'signatureDishes'));
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM stores WHERE tenant_id=911`).get().n, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM kb_docs WHERE tenant_id=911`).get().n, 0);
  });

  let firstCompletion;
  await t.test('complete：门店入库、知识档案入库、状态翻转、推荐 3 位员工', async () => {
    const result = await request(tokens.bossOne, '/api/onboarding/complete', {
      method: 'POST',
      body: { answers: FULL_ANSWERS },
    });
    assert.equal(result.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.status, 'completed');
    firstCompletion = result.payload;

    // 门店
    const stores = db.prepare(`SELECT * FROM stores WHERE tenant_id=911`).all();
    assert.equal(stores.length, 1);
    assert.equal(stores[0].name, FULL_ANSWERS.storeName);
    assert.equal(stores[0].city, '成都');
    assert.equal(stores[0].area, '万达广场 3 楼');
    assert.equal(stores[0].biz_type, '快餐');
    assert.equal(result.payload.store.id, stores[0].id);
    assert.equal(result.payload.store.created, true);

    // 知识库文档（结构化 Markdown，含菜单附件引用）
    const docs = db.prepare(`SELECT * FROM kb_docs WHERE tenant_id=911`).all();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].category, '企业档案');
    assert.equal(docs[0].enabled, 1);
    assert.equal(docs[0].id, result.payload.kbDoc.id);
    assert.match(docs[0].title, /企业基础档案/u);
    for (const fragment of ['## 品牌与门店', '## 客群与客单价', '## 招牌与菜单', '## 经营目标', '## 当前最头疼的事', '红烧牛肉面', '春季菜单.xlsx', '出餐效率', '中午高峰出餐太慢']) {
      assert.ok(docs[0].body.includes(fragment), `知识正文应包含「${fragment}」`);
    }
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM biz_assets WHERE tenant_id=911 AND source_type='kb' AND source_id=?`).get(docs[0].id).n, 1);

    // 向量化未开启/未配置时如实返回，不影响完成
    assert.equal(result.payload.vectorization.accepted, false);
    assert.ok(['disabled', 'billing_hold_failed', 'stale_document'].includes(result.payload.vectorization.reason));

    // 推荐：AI 不可用 → 目录默认三人组，每张卡带预填任务与派活所需 idx
    assert.equal(result.payload.recommendation.source, 'catalog_default');
    assert.equal(result.payload.recommendation.members.length, 3);
    assert.ok(result.payload.recommendation.matchText.includes('出餐效率'));
    for (const member of result.payload.recommendation.members) {
      assert.ok(Number.isInteger(member.idx) && member.idx >= 101 && member.idx <= 161);
      assert.ok(member.person && member.name && member.task);
      assert.ok(member.task.includes('中午高峰出餐太慢'), '预填任务应带上老板的痛点');
    }
    assert.equal(result.payload.recommendation.members[0].idx, 134, '出餐效率的队长应是后厨工位与出餐控制');

    // 状态与时间
    const tenant = db.prepare(`SELECT onboarding_status,onboarding_answers,onboarding_completed_at FROM tenants WHERE id=911`).get();
    assert.equal(tenant.onboarding_status, 'completed');
    assert.ok(tenant.onboarding_completed_at);
    const stored = JSON.parse(tenant.onboarding_answers);
    assert.equal(stored.answers.storeName, FULL_ANSWERS.storeName);
    assert.equal(stored.completion.storeId, stores[0].id);
    assert.equal(stored.completion.kbDocId, docs[0].id);
    const me = await request(tokens.bossOne, '/api/auth/me');
    assert.equal(me.payload.tenant.onboardingStatus, 'completed');

    // 操作日志
    const log = db.prepare(`SELECT * FROM op_logs WHERE tenant_id=911 AND module='开店向导' AND action='完成开店向导'`).get();
    assert.ok(log, '完成向导应记 op_logs');

    // 完成后 state 也能拿到落地结果
    const state = await request(tokens.bossOne, '/api/onboarding/state');
    assert.equal(state.payload.status, 'completed');
    assert.equal(state.payload.completion.kbDocId, docs[0].id);
  });

  await t.test('再次 complete 只更新同一门店与同一知识，不产生重复记录', async () => {
    const result = await request(tokens.bossOne, '/api/onboarding/complete', {
      method: 'POST',
      body: { answers: { district: '万达广场 4 楼', goal: '成本' } },
    });
    assert.equal(result.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.store.id, firstCompletion.store.id);
    assert.equal(result.payload.store.created, false);
    assert.equal(result.payload.kbDoc.id, firstCompletion.kbDoc.id);
    assert.equal(result.payload.kbDoc.created, false);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM stores WHERE tenant_id=911`).get().n, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM kb_docs WHERE tenant_id=911`).get().n, 1);
    const doc = db.prepare(`SELECT area FROM stores WHERE tenant_id=911`).get();
    assert.equal(doc.area, '万达广场 4 楼');
    assert.equal(db.prepare(`SELECT version FROM kb_docs WHERE id=?`).get(firstCompletion.kbDoc.id).version, 2);
    assert.equal(result.payload.recommendation.members[0].idx, 111, '目标改成成本后默认推荐随之变化');
  });

  await t.test('已完成的企业不能再 skip', async () => {
    const result = await request(tokens.bossOne, '/api/onboarding/skip', { method: 'POST' });
    assert.equal(result.status, 400);
  });

  await t.test('租户隔离：另一企业读不到，也不受影响；skip 只作用于自己', async () => {
    const other = await request(tokens.bossTwo, '/api/onboarding/state');
    assert.equal(other.status, 200);
    assert.equal(other.payload.status, 'pending');
    assert.deepEqual(other.payload.answers, {});
    assert.equal(other.payload.completion, null);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM stores WHERE tenant_id=912`).get().n, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM kb_docs WHERE tenant_id=912`).get().n, 0);

    const skipped = await request(tokens.bossTwo, '/api/onboarding/skip', { method: 'POST' });
    assert.equal(skipped.status, 200);
    assert.equal(skipped.payload.status, 'skipped');
    assert.equal(db.prepare(`SELECT onboarding_status FROM tenants WHERE id=912`).get().onboarding_status, 'skipped');
    assert.equal(db.prepare(`SELECT onboarding_status FROM tenants WHERE id=911`).get().onboarding_status, 'completed');
    const me = await request(tokens.bossTwo, '/api/auth/me');
    assert.equal(me.payload.tenant.onboardingStatus, 'skipped');

    // 跳过后再填答案会回到 in_progress（老板可从系统管理重新进入）
    const resumed = await request(tokens.bossTwo, '/api/onboarding/answers', {
      method: 'PUT',
      body: { answers: { storeName: '企业二的店' } },
    });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.payload.status, 'in_progress');
  });
});
