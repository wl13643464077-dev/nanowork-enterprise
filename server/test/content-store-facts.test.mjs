// 门店事实包（Store Fact Pack）：空库 / 有门店+菜品+评价 / 多店选择 / 租户隔离 / facts_used 校验，
// 以及三条内容链路（内容员工 runtime context + handler prompt、AI 带货员 grounding、内容仓 generateContent）
// 的「prompt 含事实块」断言。原则：只给真实台账，缺事实写「未获取」，绝不让缺事实导致生成失败。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { validContentEmployeeOutput } from './helpers/content-output-fixtures.mjs';

const DB_PATH = path.join(os.tmpdir(), `nanowork-content-store-facts-${process.pid}-${Date.now()}.db`);
const DATABASE_FILES = [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`];
for (const file of DATABASE_FILES) fs.rmSync(file, { force: true });

process.env.NANOWORK_DB = DB_PATH;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'Store-Facts-Test#2026!server-owned';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
delete process.env.YUNWU_API_KEY;
delete process.env.YUNWU_BASE_URL;
delete process.env.ENABLE_BACKGROUND_EMBEDDINGS;

const { db, q, initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
const { runWithStore, defaultStoreId } = await import('../src/engines/store-scope.js');
const {
  STORE_FACT_EMPTY_PROMPT,
  STORE_FACT_INTERNAL_EVIDENCE,
  STORE_FACT_KINDS,
  STORE_FACT_REQUIRED_LABELS,
  STORE_FACT_SOURCES,
  buildContentStoreFactPack,
  storeFactPackPromptBlock,
  validateFactsUsed,
} = await import('../src/engines/content-store-facts.js');
const {
  CONTENT_STORE_FACT_INTERNAL_QUOTE,
  CONTENT_STORE_FACT_UNKNOWN_ID,
  CONTENT_STORE_FACT_UNREGISTERED,
  validateContentEmployeeOutputContract,
  validateStoreFactClosure,
} = await import('../src/engines/content-output-contract.js');
const { buildContentHandlerRuntimeContext } = await import('../src/engines/content-handler-runtime-context.js');
const { invokeContentHandlerGenerate } = await import('../src/engines/content-handler-adapters.js');
const { generateContent } = await import('../src/engines/ai.js');
const contentRoutes = (await import('../src/routes/content.js')).default;

initSchema();
migrateV2();

// ===== 租户与基础数据 =====
const EMPTY = 31; // 空库：没有门店/菜品/评价
const FULL = 32; // 完整：两家门店 + 菜品 + 订单明细 + 评价 + 企业档案 + 向导答案
const OTHER = 33; // 另一租户：隔离验证
const insertTenant = db.prepare(`INSERT INTO tenants(id,name,status,credits) VALUES(?,?,'已开通',100000)`);
insertTenant.run(EMPTY, '空白新企业');
insertTenant.run(FULL, '三石牛腩');
insertTenant.run(OTHER, '隔壁老王面馆');

const today = new Date().toISOString().slice(0, 10);
const storeA = Number(db.prepare(
  `INSERT INTO stores(tenant_id,name,code,address,city,area,biz_type,is_default,status)
   VALUES(?,?,?,?,?,?,?,1,'营业中')`,
).run(FULL, '三石牛腩·春熙路店', 'CX', '成都市锦江区春熙路 88 号 3 楼', '成都', '春熙路商圈', '正餐').lastInsertRowid);
const storeB = Number(db.prepare(
  `INSERT INTO stores(tenant_id,name,code,address,city,biz_type,is_default,status)
   VALUES(?,?,?,?,?,?,0,'营业中')`,
).run(FULL, '三石牛腩·万达店', 'WD', '成都市金牛区万达广场 2 楼', '成都', '正餐').lastInsertRowid);
const otherStore = Number(db.prepare(
  `INSERT INTO stores(tenant_id,name,is_default,biz_type,status) VALUES(?,?,1,'快餐','营业中')`,
).run(OTHER, '老王面馆总店').lastInsertRowid);

const insertDish = db.prepare(
  `INSERT INTO dishes(tenant_id,store_id,name,category,price,status) VALUES(?,?,?,?,?,?)`,
);
const dish = (storeId, name, category, price, status = '在售') =>
  Number(insertDish.run(FULL, storeId, name, category, price, status).lastInsertRowid);
const dishTomato = dish(storeA, '番茄牛腩锅', '锅物', 68);
const dishGoose = dish(storeA, '招牌烧鹅', '烧腊', 98);
const dishRibs = dish(storeA, '蒜香排骨', '热菜', 58);
const dishTofu = dish(storeA, '麻婆豆腐', '热菜', 28);
const dishRice = dish(storeA, '米饭', '主食', 3);
const dishTea = dish(storeA, '柠檬茶', '饮品', 15);
const dishSoup = dish(storeA, '例汤', '汤羹', 12);
dish(storeA, '已下架的椰子鸡', '锅物', 128, '下架');
dish(storeA, '免费小菜', '小吃', 0);
const dishB = dish(storeB, '万达店限定卤味拼盘', '卤味', 45);
db.prepare(`INSERT INTO dishes(tenant_id,store_id,name,category,price,status) VALUES(?,?,?,?,?,?)`)
  .run(OTHER, otherStore, '老王牛肉面', '面食', 22, '在售');

// 订单明细：招牌烧鹅与蒜香排骨销量最高（决定招牌菜顺序）
const insertItem = db.prepare(
  `INSERT INTO order_items(tenant_id,order_id,dish_id,dish_name_snapshot,qty,unit_price,amount) VALUES(?,?,?,?,?,?,?)`,
);
insertItem.run(FULL, 1, dishGoose, '招牌烧鹅', 50, 98, 4900);
insertItem.run(FULL, 2, dishRibs, '蒜香排骨', 30, 58, 1740);
insertItem.run(FULL, 3, dishTofu, '麻婆豆腐', 12, 28, 336);

// 评价：5 条好评（含高频词）+ 1 条差评
const insertReview = db.prepare(
  `INSERT INTO store_reviews(tenant_id,platform,rating,content,store_name,review_date,status,store_id)
   VALUES(?,?,?,?,?,?,'已回复',?)`,
);
const reviewIds = [
  insertReview.run(FULL, '美团', 5, '番茄牛腩锅分量足，上菜快，两个人吃得很满足，下次还来。', '春熙路店', today, storeA).lastInsertRowid,
  insertReview.run(FULL, '大众点评', 5, '烧鹅皮脆肉嫩，分量足，服务好。', '春熙路店', today, storeA).lastInsertRowid,
  insertReview.run(FULL, '美团', 4, '上菜快，分量足，环境干净。', '春熙路店', today, null).lastInsertRowid,
  insertReview.run(FULL, '抖音', 4, '性价比高，排骨入味。', '春熙路店', today, storeA).lastInsertRowid,
  insertReview.run(FULL, '美团', 5, '上菜快，味道好。', '春熙路店', today, storeA).lastInsertRowid,
  insertReview.run(FULL, '美团', 2, '等位太久了，差评。', '春熙路店', today, storeA).lastInsertRowid,
].map(Number);

// 企业档案（知识库）
const kbDocId = Number(db.prepare(
  `INSERT INTO kb_docs(tenant_id,category,title,body,enabled) VALUES(?,?,?,?,1)`,
).run(FULL, '企业档案', '三石牛腩企业基础档案', `三石牛腩创立于成都，主打现熬番茄牛腩锅。${'品牌坚持每日现熬汤底。'.repeat(30)}`).lastInsertRowid);
db.prepare(`INSERT INTO kb_docs(tenant_id,category,title,body,enabled) VALUES(?,?,?,?,1)`)
  .run(FULL, '话术案例', '不该进 brand_note 的话术', '这是话术案例，不属于企业档案/品牌资料/门店资料。');

// 开店向导答案（批次 A）
db.prepare(`UPDATE tenants SET onboarding_answers=? WHERE id=?`).run(JSON.stringify({
  version: 1,
  answers: {
    storeName: '三石牛腩（春熙路店）',
    bizType: '正餐',
    city: '成都',
    district: '春熙路',
    seats: 42,
    customerGroups: ['周边白领', '家庭顾客'],
    avgTicket: 58,
    signatureDishes: ['番茄牛腩锅', '招牌烧鹅'],
    goal: '复购',
    goalTarget: '月复购率从 20% 做到 30%',
    painPoint: '工作日晚市太冷清，周末又排队排到客人流失。',
  },
}), FULL);

const bossId = Number(db.prepare(
  `INSERT INTO users(username,password_hash,name,role,dept,status,tenant_id) VALUES(?,?,?,?,?,'启用',?)`,
).run('store-facts-boss', 'x', '牛腩老板', 'boss', '内容部', FULL).lastInsertRowid);

const T = (tenantId, fn) => runWithTenant(tenantId, fn);

after(() => {
  db.close();
  for (const file of DATABASE_FILES) fs.rmSync(file, { force: true });
});

const ALL_MISSING = Object.values(STORE_FACT_REQUIRED_LABELS);

test('空库：facts 为空、missing 全列、prompt 块为「尚未录入」文案，不会懒创建门店', () => {
  const pack = T(EMPTY, () => buildContentStoreFactPack(EMPTY));
  assert.deepEqual(pack.facts, []);
  assert.deepEqual(pack.missing, ALL_MISSING);
  assert.equal(pack.storeId, null);
  assert.equal(pack.storeName, null);
  assert.equal(pack.multiStore, false);
  assert.ok(Number.isFinite(Date.parse(pack.generatedAt)));
  assert.equal(storeFactPackPromptBlock(pack), STORE_FACT_EMPTY_PROMPT);
  assert.equal(storeFactPackPromptBlock(null), STORE_FACT_EMPTY_PROMPT);
  assert.equal(q.get('SELECT COUNT(*) n FROM stores WHERE tenant_id=?', EMPTY).n, 0, '事实包不得懒创建门店');
  assert.equal(defaultStoreId(EMPTY, { create: false }), null);
});

test('完整门店：事实结构、价格格式、招牌菜优先级、评价内部证据、rating_summary、向导补充、知识库 brand_note', () => {
  const pack = T(FULL, () => buildContentStoreFactPack(FULL));
  assert.equal(pack.storeId, storeA, '未指定门店时取租户默认店');
  assert.equal(pack.storeName, '三石牛腩·春熙路店');
  assert.equal(pack.multiStore, true);
  assert.equal(pack.storeCount, 2);

  const idPattern = new RegExp(`^fact:(${STORE_FACT_SOURCES.join('|')}):`, 'u');
  for (const fact of pack.facts) {
    assert.match(fact.id, idPattern, `fact id 形如 fact:<source>:<id>：${fact.id}`);
    assert.ok(STORE_FACT_KINDS.includes(fact.kind), `未知 kind：${fact.kind}`);
    assert.ok(STORE_FACT_SOURCES.includes(fact.source));
    assert.ok(typeof fact.claim === 'string' && fact.claim.length > 0);
    assert.ok(Object.hasOwn(fact, 'value') && Object.hasOwn(fact, 'sourceId') && Object.hasOwn(fact, 'freshness'));
  }
  assert.equal(new Set(pack.facts.map(fact => fact.id)).size, pack.facts.length, 'fact id 唯一');

  // 门店档案
  const byKind = kind => pack.facts.filter(fact => fact.kind === kind);
  assert.equal(byKind('store_name')[0].claim, '门店名称「三石牛腩·春熙路店」');
  assert.equal(byKind('store_name')[0].id, `fact:stores:${storeA}:store_name`);
  assert.equal(byKind('address')[0].value, '成都市锦江区春熙路 88 号 3 楼');
  assert.equal(byKind('address')[0].source, 'stores');
  assert.equal(byKind('city')[0].value, '成都');
  assert.equal(byKind('area')[0].value, '春熙路商圈');
  assert.equal(byKind('category')[0].value, '正餐');

  // 菜品：价格格式与 content-output-contract 的 normalizedConcreteValue 对齐（cny:68.00）
  const tomato = pack.facts.find(fact => fact.id === `fact:dishes:${dishTomato}`);
  assert.ok(tomato, '番茄牛腩锅应进入事实包');
  assert.equal(tomato.value, 'cny:68.00');
  assert.match(tomato.claim, /「番茄牛腩锅」售价 ¥68\.00/u);
  assert.match(tomato.claim, /分类：锅物/u);
  assert.equal(tomato.source, 'dishes');
  assert.equal(tomato.sourceId, dishTomato);
  assert.equal(tomato.freshness, today);
  assert.equal(pack.facts.some(fact => /已下架的椰子鸡/u.test(fact.claim)), false, '下架菜不进事实包');
  assert.equal(pack.facts.some(fact => /免费小菜/u.test(fact.claim)), false, '非招牌且无价格的菜不进事实包');
  assert.equal(pack.facts.some(fact => /万达店限定/u.test(fact.claim)), false, '其他门店的菜不进当前门店事实包');

  // 招牌菜优先级：订单销量 Top 优先（烧鹅 50 份 > 排骨 30 份 > 豆腐 12 份），其后按菜品表顺序
  const signatures = byKind('signature_dish');
  assert.deepEqual(
    signatures.slice(0, 3).map(fact => fact.sourceId),
    [dishGoose, dishRibs, dishTofu],
  );
  assert.match(signatures[0].claim, /^招牌菜「招牌烧鹅」售价 ¥98\.00/u);
  assert.match(signatures[0].claim, /订单明细累计销量 50 份/u);
  assert.equal(signatures.length, 5);
  assert.ok(byKind('dish_price').some(fact => fact.sourceId === dishTea || fact.sourceId === dishSoup || fact.sourceId === dishRice));

  // 评价：原句只做内部证据；rating_summary 可对外
  const quotes = byKind('review_quote');
  assert.equal(quotes.length, 5, '只取 rating>=4 的评价');
  for (const quote of quotes) {
    assert.equal(quote.usage, STORE_FACT_INTERNAL_EVIDENCE);
    assert.equal(quote.source, 'store_reviews');
    assert.ok(reviewIds.includes(quote.sourceId));
    assert.ok(quote.value.length <= 60);
  }
  assert.equal(quotes.some(quote => /等位太久/u.test(quote.claim)), false);
  const summary = byKind('rating_summary')[0];
  assert.ok(summary, '应给出 rating_summary');
  assert.equal(summary.usage, undefined, 'rating_summary 可对外引用');
  assert.equal(summary.id, 'fact:store_reviews:summary');
  assert.match(summary.claim, /^近 30 天 6 条评价，平均 4\.2 分，高频词：/u);
  assert.match(summary.claim, /分量足/u);
  assert.match(summary.claim, /上菜快/u);
  assert.equal(summary.value.count, 6);
  assert.equal(summary.value.avgRating, 4.17);

  // 开店向导补充：门店表没有人均/座位列 → 来自 onboarding；招牌菜已由菜品表提供则不重复；目标/头疼事为内部证据
  const ticket = byKind('avg_ticket')[0];
  assert.equal(ticket.source, 'onboarding');
  assert.equal(ticket.value, 'cny:58.00');
  assert.equal(ticket.sourceId, FULL);
  assert.equal(byKind('seats')[0].value, 42);
  assert.equal(pack.facts.filter(fact => fact.kind === 'signature_dish' && fact.source === 'onboarding').length, 0);
  const notes = byKind('brand_note');
  const groups = notes.find(note => /主要客群/u.test(note.claim));
  assert.ok(groups && groups.usage === undefined);
  assert.match(groups.claim, /周边白领、家庭顾客/u);
  const pain = notes.find(note => /最头疼/u.test(note.claim));
  assert.equal(pain.usage, STORE_FACT_INTERNAL_EVIDENCE);
  assert.equal(notes.find(note => /经营目标/u.test(note.claim)).usage, STORE_FACT_INTERNAL_EVIDENCE);

  // 知识库 brand_note：只取企业档案/品牌资料/门店资料，标题 + 前 200 字
  const kbNote = pack.facts.find(fact => fact.id === `fact:kb_docs:${kbDocId}`);
  assert.ok(kbNote);
  assert.equal(kbNote.kind, 'brand_note');
  assert.match(kbNote.claim, /^企业档案「三石牛腩企业基础档案」：三石牛腩创立于成都/u);
  assert.ok(kbNote.value.length <= 200);
  assert.equal(pack.facts.some(fact => /话术案例/u.test(fact.claim)), false);

  // 缺失项：只剩营业时间
  assert.deepEqual(pack.missing, ['营业时间']);
});

test('dishNames 点名优先、includeReviews=false、limit 上限', () => {
  const named = T(FULL, () => buildContentStoreFactPack(FULL, { dishNames: ['番茄牛腩锅', '柠檬茶'] }));
  const signatures = named.facts.filter(fact => fact.kind === 'signature_dish');
  assert.deepEqual(signatures.slice(0, 2).map(fact => fact.sourceId), [dishTomato, dishTea]);
  assert.equal(signatures[2].sourceId, dishGoose, '点名之后才按销量排序');

  const quiet = T(FULL, () => buildContentStoreFactPack(FULL, { includeReviews: false }));
  assert.equal(quiet.facts.some(fact => fact.kind === 'review_quote'), false);
  assert.ok(quiet.facts.some(fact => fact.kind === 'rating_summary'));

  const small = T(FULL, () => buildContentStoreFactPack(FULL, { limit: 6 }));
  assert.equal(small.facts.length, 6);
  assert.equal(small.facts.some(fact => fact.usage === STORE_FACT_INTERNAL_EVIDENCE), false, '裁剪时先裁内部证据');
  assert.ok(small.missing.includes('顾客评价') || small.facts.some(fact => fact.kind === 'rating_summary'));
});

test('多门店：storeId → curStore() → 默认店，storeName 随门店变化', () => {
  const explicit = T(FULL, () => buildContentStoreFactPack(FULL, { storeId: storeB }));
  assert.equal(explicit.storeId, storeB);
  assert.equal(explicit.storeName, '三石牛腩·万达店');
  assert.ok(explicit.facts.some(fact => fact.id === `fact:dishes:${dishB}`));
  assert.equal(
    explicit.facts.some(fact => fact.source === 'dishes' && /番茄牛腩锅|招牌烧鹅/u.test(fact.claim)),
    false,
    'B 店不带 A 店菜品（企业档案里的品牌介绍是租户级，允许出现）',
  );
  const areaB = explicit.facts.find(fact => fact.kind === 'area');
  assert.equal(areaB?.source, 'onboarding', 'B 店没填商圈时由开店向导答案补充');
  assert.equal(explicit.facts.some(fact => fact.kind === 'area' && fact.source === 'stores'), false);

  const viaContext = T(FULL, () => runWithStore(storeB, () => buildContentStoreFactPack(FULL)));
  assert.equal(viaContext.storeId, storeB);

  const overriding = T(FULL, () => runWithStore(storeB, () => buildContentStoreFactPack(FULL, { storeId: storeA })));
  assert.equal(overriding.storeId, storeA, '入参 storeId 优先于当前门店上下文');

  const fallback = T(FULL, () => buildContentStoreFactPack(FULL));
  assert.equal(fallback.storeId, storeA, '无上下文时取 is_default=1 的门店');

  // B 店的评价：只有归属 B 店或未归属（NULL）的评价才计入
  const reviewSummary = explicit.facts.find(fact => fact.kind === 'rating_summary');
  assert.equal(reviewSummary.value.count, 1, 'B 店只看到未归属门店的 1 条评价');
});

test('租户隔离：另一租户拿不到本租户门店/菜品/评价/档案，指定他人门店 id 也不会泄露', () => {
  const other = T(OTHER, () => buildContentStoreFactPack(OTHER));
  assert.equal(other.storeId, otherStore);
  assert.ok(other.facts.some(fact => /老王牛肉面/u.test(fact.claim)));
  const serialized = JSON.stringify(other);
  assert.doesNotMatch(serialized, /番茄牛腩|三石|春熙路|分量足|周边白领/u);

  const stolen = T(OTHER, () => buildContentStoreFactPack(OTHER, { storeId: storeA }));
  assert.equal(stolen.storeId, null, '不属于本租户的 storeId 不得解析成门店');
  assert.doesNotMatch(JSON.stringify(stolen), /番茄牛腩|三石|春熙路/u);

  const crossContext = T(OTHER, () => runWithStore(storeA, () => buildContentStoreFactPack(OTHER)));
  assert.equal(crossContext.storeId, otherStore, '上下文门店不属于本租户时回落到本租户默认店');

  // 显式传错租户 id 也拿不到 FULL 的数据
  assert.doesNotMatch(JSON.stringify(T(FULL, () => buildContentStoreFactPack(OTHER))), /番茄牛腩/u);
});

test('prompt 块：标题、fact id 行、来源、内部证据标记、未获取清单、facts_used 规则、maxFacts 与 video 口播规则', () => {
  const pack = T(FULL, () => buildContentStoreFactPack(FULL, { dishNames: ['番茄牛腩锅'] }));
  const block = storeFactPackPromptBlock(pack);
  const lines = block.split('\n');
  assert.equal(lines[0], '【门店真实事实（只能引用，不得改数、不得编造）】');
  assert.match(lines[1], /^门店：三石牛腩·春熙路店（门店编号 \d+，连锁多店中的当前门店）$/u);
  assert.ok(block.includes(`- [fact:dishes:${dishTomato}] 招牌菜「番茄牛腩锅」售价 ¥68.00（分类：锅物）（来源：菜品表）`));
  assert.ok(block.includes(`- [fact:stores:${storeA}:address] 门店地址：成都市锦江区春熙路 88 号 3 楼（来源：门店档案）`));
  assert.ok(block.includes('【未获取】营业时间——如需提及必须写"待补充"'));
  assert.match(block, /引用事实时在 facts_used 中登记 fact id/u);
  assert.match(block, /标注「内部证据」的条目只能用于把握方向与选题，不得写入对外正文或口播/u, '共享规则句（content/video 都有）');
  assert.ok(block.includes('（来源：评价中心）'));
  assert.doesNotMatch(block, /口播与字幕中读出的价格、地址、菜名必须与上述事实逐字一致/u, 'content 受众不带 video 独有的口播逐字规则');
  assert.doesNotMatch(block, /以门店公示为准/u, 'content 受众不带 video 独有的未获取项口播话术');
  const factLines = block.split('\n').filter(line => line.startsWith('- [fact:'));
  assert.equal(factLines.length, 16, '默认最多 16 条事实');
  assert.ok(factLines.every(line => !line.includes('内部证据·不得对外原句引用：')), '默认 16 条以内先给可对外事实，内部证据排最后');

  const full = storeFactPackPromptBlock(pack, { maxFacts: 40 });
  assert.match(full, /- \[fact:store_reviews:\d+\] 内部证据·不得对外原句引用：顾客评价（美团 5★）：「番茄牛腩锅分量足/u);
  assert.match(full, /- \[fact:onboarding:\d+:painPoint\] 内部证据·不得对外原句引用：老板最头疼的事/u);

  const capped = storeFactPackPromptBlock(pack, { maxFacts: 3 });
  const cappedLines = capped.split('\n').filter(line => line.startsWith('- [fact:'));
  assert.equal(cappedLines.length, 3);
  assert.ok(cappedLines.every(line => !line.includes('内部证据·不得对外原句引用：')), '裁剪时先裁内部证据');

  const video = storeFactPackPromptBlock(pack, { audience: 'video' });
  assert.match(video, /标注「内部证据」的条目只能用于把握方向与选题，不得写入对外正文或口播/u, '共享规则句 video 也有');
  assert.match(video, /口播与字幕中读出的价格、地址、菜名必须与上述事实逐字一致；未获取项在口播中只能说"以门店公示为准"/u);
  assert.equal(video.split('\n').filter(line => /^口播与字幕中读出的价格/u.test(line)).length, 1, 'video 独有规则句只追加一行');
  assert.equal(video.split('\n').slice(0, -1).join('\n'), block, 'video 与 content 只差最后追加的一行独有规则');
});

test('validateFactsUsed：正例、未知 id、内部证据不得引用、min 下限、非数组', () => {
  const pack = T(FULL, () => buildContentStoreFactPack(FULL));
  const quote = pack.facts.find(fact => fact.kind === 'review_quote');
  const ok = validateFactsUsed([
    { claim: '番茄牛腩锅 68 元', factId: `fact:dishes:${dishTomato}` },
    { claim: '地址在春熙路', factId: `fact:stores:${storeA}:address` },
    { claim: '重复登记应去重', factId: `fact:dishes:${dishTomato}` },
  ], pack, { min: 2 });
  assert.equal(ok.ok, true, ok.errors.join('；'));
  assert.deepEqual(ok.used.map(entry => entry.factId), [`fact:dishes:${dishTomato}`, `fact:stores:${storeA}:address`]);
  assert.equal(ok.used[0].kind, 'signature_dish');
  assert.equal(ok.used[0].source, 'dishes');

  const unknown = validateFactsUsed([{ claim: '编的', factId: 'fact:dishes:999999' }], pack);
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors[0], /不在门店事实包中/u);

  const internal = validateFactsUsed([{ claim: '顾客说分量足', factId: quote.id }], pack);
  assert.equal(internal.ok, false);
  assert.match(internal.errors[0], /内部证据.*不得对外引用原句/u);

  const short = validateFactsUsed([], pack, { min: 1 });
  assert.equal(short.ok, false);
  assert.match(short.errors[0], /至少需登记 1 条/u);
  assert.equal(validateFactsUsed(null, pack).ok, true, '未登记且 min=0 视为通过');
  assert.equal(validateFactsUsed('not-array', pack).ok, false);
  assert.match(validateFactsUsed([{ claim: '缺 id' }], pack).errors[0], /factId 缺失/u);
  assert.match(validateFactsUsed([{ factId: `fact:dishes:${dishTomato}` }], pack).errors[0], /claim 缺失/u);
});

test('契约 advisory：撰稿人 idx 3 引用事实未登记 → 警告不阻断；登记正确 → 无警告；未知 id / 原句引用内部证据 → 对应警告码', () => {
  const pack = T(FULL, () => buildContentStoreFactPack(FULL, { dishNames: ['番茄牛腩锅'] }));
  const base = structuredClone(validContentEmployeeOutput(3));
  const withFact = {
    ...base,
    body: `${base.body}\n\n## 门店信息\n\n本店招牌菜「番茄牛腩锅」售价 ¥68.00，门店地址：成都市锦江区春熙路 88 号 3 楼。`,
  };

  const unregistered = validateContentEmployeeOutputContract(3, JSON.stringify(withFact), {
    title: '番茄牛腩锅上新',
    requirement: '写一篇小红书带货文案。',
    storeFacts: pack,
  });
  assert.equal(unregistered.valid, true, unregistered.errors.join('；'));
  assert.ok(Array.isArray(unregistered.warnings));
  const codes = unregistered.warnings.map(item => item.code);
  assert.ok(codes.includes(CONTENT_STORE_FACT_UNREGISTERED), JSON.stringify(unregistered.warnings));
  assert.deepEqual(
    [...unregistered.storeFactClosure.unregistered].sort(),
    [`fact:dishes:${dishTomato}`, `fact:stores:${storeA}:address`].sort(),
  );
  assert.equal(unregistered.storeFactClosure.factsUsedPresent, false);

  const registered = validateContentEmployeeOutputContract(3, JSON.stringify({
    ...withFact,
    facts_used: [
      { claim: '番茄牛腩锅售价 ¥68.00', factId: `fact:dishes:${dishTomato}` },
      { claim: '门店地址春熙路 88 号 3 楼', factId: `fact:stores:${storeA}:address` },
    ],
  }), { title: '番茄牛腩锅上新', requirement: '写一篇小红书带货文案。', storeFacts: pack });
  assert.equal(registered.valid, true, registered.errors.join('；'), 'facts_used 在 idx 3 不算未知字段');
  assert.deepEqual(registered.warnings, []);
  assert.equal(registered.storeFactClosure.ok, true);
  assert.equal(registered.storeFactClosure.used.length, 2);
  assert.ok(registered.artifacts.length === 1);

  const unknownId = validateContentEmployeeOutputContract(3, JSON.stringify({
    ...withFact,
    facts_used: [
      { claim: '番茄牛腩锅售价 ¥68.00', factId: `fact:dishes:${dishTomato}` },
      { claim: '门店地址春熙路 88 号 3 楼', factId: `fact:stores:${storeA}:address` },
      { claim: '编造的事实', factId: 'fact:dishes:424242' },
    ],
  }), { storeFacts: pack });
  assert.equal(unknownId.valid, true, '本轮 advisory 不阻断');
  assert.deepEqual(unknownId.warnings.map(item => item.code), [CONTENT_STORE_FACT_UNKNOWN_ID]);

  const quote = pack.facts.find(fact => fact.kind === 'review_quote');
  const leaked = validateContentEmployeeOutputContract(3, JSON.stringify({
    ...base,
    body: `${base.body}\n\n## 顾客怎么说\n\n有顾客留言：${quote.value}`,
    facts_used: [{ claim: '顾客原话', factId: quote.id }],
  }), { storeFacts: pack });
  assert.equal(leaked.valid, true);
  const leakedCodes = leaked.warnings.map(item => item.code);
  assert.equal(leakedCodes.filter(code => code === CONTENT_STORE_FACT_INTERNAL_QUOTE).length, 2, '登记内部证据 + 正文原句各一条');

  const minShort = validateStoreFactClosure(base, pack, { min: 1 });
  assert.equal(minShort.ok, false);
  assert.deepEqual(minShort.warnings.map(item => item.code), [CONTENT_STORE_FACT_UNREGISTERED]);

  // 没有事实包上下文：不产生任何门店事实告警，也不改变既有契约行为
  const plain = validateContentEmployeeOutputContract(3, JSON.stringify(base), { title: '普通任务' });
  assert.equal(plain.valid, true);
  assert.deepEqual(plain.warnings, []);
  assert.equal(plain.storeFactClosure, undefined);
  // 非闭环工位（文风师 idx 4）出现 facts_used 仍是未知字段（硬错误）
  const stylist = validateContentEmployeeOutputContract(4, JSON.stringify({
    ...validContentEmployeeOutput(4),
    facts_used: [],
  }), { storeFacts: pack });
  assert.equal(stylist.valid, false);
  assert.match(stylist.errors.join('\n'), /未知字段：facts_used/u);
});

test('接入①：内容员工 runtime context 带 storeFacts，handler user prompt 含事实块', async () => {
  const built = await buildContentHandlerRuntimeContext({
    mode: 'solo',
    tenantId: FULL,
    actorId: bossId,
    employeeIdx: 3,
    task: { direction: '写一篇番茄牛腩锅的小红书带货文案', platforms: ['小红书'] },
    dishNames: ['番茄牛腩锅'],
  }, {
    kbSearchFn: async () => ({ text: '', refs: [], degraded: false, mode: 'empty' }),
  });
  assert.equal(built.context.storeFacts.storeId, storeA);
  assert.equal(built.context.storeFacts.storeName, '三石牛腩·春熙路店');
  assert.ok(built.context.storeFacts.facts.some(fact => fact.id === `fact:dishes:${dishTomato}`));
  assert.equal(built.snapshot.storeFacts.storeId, storeA);
  assert.ok(built.snapshot.storeFacts.factCount > 0);
  assert.equal(built.snapshot.storeFacts.rawFactsIncluded, false);
  assert.match(built.snapshot.storeFacts.fingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(built.snapshot.storeFacts.missing, ['营业时间']);
  assert.doesNotMatch(JSON.stringify(built.snapshot), /售价 ¥68\.00/u, '快照不含事实正文');

  let received;
  await invokeContentHandlerGenerate({
    employeeIdx: 3,
    prompt: { system: '撰稿人岗位说明', user: '老板任务书：番茄牛腩锅上新', research: '', sensitive: [] },
    generationArgs: { kind: 'content-employee-workbench', system: 'x', userMsg: 'y', model: 'real-model' },
    generateFn: async args => {
      received = args;
      return { text: JSON.stringify(validContentEmployeeOutput(3)), mode: 'api', model: 'real-model', usage: { inputTokens: 20, outputTokens: 10 } };
    },
    context: structuredClone(built.context),
  });
  assert.match(received.userMsg, /^老板任务书：番茄牛腩锅上新/u);
  assert.match(received.userMsg, /【门店真实事实（只能引用，不得改数、不得编造）】/u);
  assert.ok(received.userMsg.includes(`- [fact:dishes:${dishTomato}] 招牌菜「番茄牛腩锅」售价 ¥68.00`));
  assert.match(received.userMsg, /【未获取】营业时间/u);
  assert.match(received.userMsg, /"storeFacts": \{/u);
  assert.match(received.userMsg, /"factCount": \d+/u);
  assert.equal((received.userMsg.match(/售价 ¥68\.00/gu) || []).length, 1, '事实正文只出现一次（JSON 里只留摘要）');

  // 空库租户：runtime context 不失败，prompt 只写「尚未录入」
  const emptyBoss = Number(db.prepare(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id) VALUES(?,?,?,?,'启用',?)`,
  ).run('store-facts-empty-boss', 'x', '空库老板', 'boss', EMPTY).lastInsertRowid);
  const emptyBuilt = await buildContentHandlerRuntimeContext({
    mode: 'solo', tenantId: EMPTY, actorId: emptyBoss, employeeIdx: 3, task: { direction: '写文案' },
  }, { kbSearchFn: async () => ({ text: '', refs: [], degraded: false, mode: 'empty' }) });
  assert.deepEqual(emptyBuilt.context.storeFacts.facts, []);
  let emptyReceived;
  await invokeContentHandlerGenerate({
    employeeIdx: 3,
    prompt: { system: 's', user: 'u', research: '', sensitive: [] },
    generationArgs: { kind: 'content-employee-workbench', system: 'x', userMsg: 'y' },
    generateFn: async args => {
      emptyReceived = args;
      return { text: '{}', mode: 'api', model: 'm', usage: { inputTokens: 1, outputTokens: 1 } };
    },
    context: structuredClone(emptyBuilt.context),
  });
  assert.ok(emptyReceived.userMsg.includes(STORE_FACT_EMPTY_PROMPT));
});

test('接入②：AI 带货员 grounding 带 storeFacts，供应商 prompt 含事实块（video 口播规则）', async () => {
  const submitCalls = [];
  const runtime = {
    intervalMs: 1,
    timeoutMs: 100,
    kbSearch: async () => ({ text: '企业已确认知识：番茄牛腩锅现熬汤底。', refs: [{ id: 1, category: '产品资料', title: '菜品档案', sim: 0.9 }], degraded: false, mode: 'semantic' }),
    submitSegment: async ({ prompt, model }) => {
      submitCalls.push(prompt);
      return { taskId: `store-facts-task-${submitCalls.length}`, model };
    },
    querySegment: async ({ taskId }) => ({ url: `https://provider.invalid/${taskId}.mp4`, status: 'success' }),
    downloadSegment: async ({ index }) => ({ path: `/tmp/store-facts-segment-${index}.mp4`, sha256: String(index).repeat(64), bytes: 1024 }),
    compose: async () => ({
      url: '/uploads/ai-sales-video/32/store-facts.mp4',
      durationSeconds: 30, width: 1080, height: 1920, videoCodec: 'h264', audioCodec: 'aac', segmentCount: 3, sha256: 'f'.repeat(64),
    }),
  };
  const user = { id: bossId, name: '牛腩老板', role: 'boss', tenant_id: FULL };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.locals.aiSalesVideoRuntime = runtime;
  app.use((req, _res, next) => runWithTenant(FULL, () => {
    req.user = user;
    next();
  }));
  app.use('/content', contentRoutes);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/content/ai-sales-video`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        brief: '用招牌菜番茄牛腩锅做一支突出到店体验的30秒视频',
        referenceImages: ['data:image/png;base64,YWJj'],
        dishNames: ['番茄牛腩锅'],
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 202, JSON.stringify(body));
    assert.equal(body.status, 'processing');
    const deadline = Date.now() + 3000;
    let row;
    while (Date.now() < deadline) {
      row = q.get('SELECT * FROM media_jobs WHERE tenant_id=? AND id=?', FULL, body.jobId);
      if (row?.status === '成功') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(row?.status, '成功', row?.error || '任务未成功');
    assert.equal(submitCalls.length, 3);
    for (const prompt of submitCalls) {
      assert.match(prompt, /【门店真实事实（只能引用，不得改数、不得编造）】/u);
      assert.ok(prompt.includes(`- [fact:dishes:${dishTomato}] 招牌菜「番茄牛腩锅」售价 ¥68.00`));
      assert.match(prompt, /口播与字幕中读出的价格、地址、菜名必须与上述事实逐字一致/u);
      assert.match(prompt, /企业已确认知识/u, '既有知识库召回仍在');
      assert.doesNotMatch(prompt, /最头疼|等位太久/u, '内部证据与差评不进供应商 prompt');
    }
    const snapshot = JSON.parse(row.snapshot_json);
    assert.equal(snapshot.grounding.storeFacts.storeId, storeA);
    assert.ok(snapshot.grounding.storeFacts.factCount > 0);
    assert.ok(snapshot.grounding.storeFacts.factIds.includes(`fact:dishes:${dishTomato}`));
    assert.deepEqual(snapshot.grounding.storeFacts.missing, ['营业时间']);
    assert.equal(snapshot.grounding.knowledgeBase.tenantScoped, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('接入③：内容仓 generateContent 的 system prompt 紧随品牌信息注入事实块；空库只写「尚未录入」', async () => {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
      res.setHeader('content-type', 'application/json');
      if (!req.url.includes('/chat/completions')) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not mocked' }));
        return;
      }
      res.end(JSON.stringify({
        choices: [{ message: { content: '【朋友圈文案】番茄牛腩锅上新，售价待门店核验。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 200, completion_tokens: 40 },
      }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  process.env.YUNWU_API_KEY = 'test-store-facts-key';
  process.env.YUNWU_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  try {
    const out = await T(FULL, () => generateContent({
      type: '朋友圈文案',
      topic: '番茄牛腩锅上新',
      count: 2,
      requirement: '突出招牌菜',
      brand: '三石牛腩，现熬汤底',
      role: 'boss',
    }));
    assert.equal(out.mode, 'api');
    assert.equal(out.storeFacts.storeId, storeA);
    assert.ok(out.storeFacts.factIds.includes(`fact:dishes:${dishTomato}`));
    const chat = requests.find(request => request.url.includes('/chat/completions'));
    assert.ok(chat, '应发起一次文本生成');
    const system = chat.body.messages.find(message => message.role === 'system')?.content || '';
    const brandAt = system.indexOf('用户提供的门店品牌信息：三石牛腩');
    const factsAt = system.indexOf('【门店真实事实（只能引用，不得改数、不得编造）】');
    assert.ok(brandAt >= 0 && factsAt > brandAt, '事实块紧随品牌信息之后');
    assert.ok(system.includes(`- [fact:dishes:${dishTomato}] 招牌菜「番茄牛腩锅」售价 ¥68.00`));
    assert.match(system, /【未获取】营业时间——如需提及必须写"待补充"/u);
    assert.match(system, /引用事实时在 facts_used 中登记 fact id/u);

    requests.length = 0;
    const empty = await T(EMPTY, () => generateContent({ type: '朋友圈文案', topic: '开业', count: 1, role: 'boss' }));
    assert.equal(empty.mode, 'api', '缺事实不得导致生成失败');
    assert.equal(empty.storeFacts.factCount, 0);
    const emptySystem = requests.find(request => request.url.includes('/chat/completions'))
      .body.messages.find(message => message.role === 'system').content;
    assert.ok(emptySystem.includes(STORE_FACT_EMPTY_PROMPT));
    assert.doesNotMatch(emptySystem, /番茄牛腩/u, '空库租户不得看到他人事实');
  } finally {
    delete process.env.YUNWU_API_KEY;
    delete process.env.YUNWU_BASE_URL;
    await new Promise(resolve => upstream.close(resolve));
  }
});
