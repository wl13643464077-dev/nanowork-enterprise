import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NANOWORK_DB = ':memory:';
process.env.NODE_ENV = 'test';
process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';
process.env.YUNWU_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
globalThis.fetch = async () => { throw new Error('结构卡单元测试禁止联网'); };
const { db, initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
const cards = await import('../src/engines/content-benchmark-cards.js');
const { buildContentHandlerRuntimeContext } = await import('../src/engines/content-handler-runtime-context.js');
const { invokeContentHandlerGenerate } = await import('../src/engines/content-handler-adapters.js');
initSchema(); migrateV2(); cards.ensureBenchmarkCardTable();
beforeEach(() => db.exec('DELETE FROM content_benchmark_cards; DELETE FROM kb_docs;'));
after(() => db.close());

export function sampleCard(overrides = {}) {
  return {
    platform: '小红书', hook_type: '悬念', opening_3s: '先提一个具体使用场景中的问题',
    structure: ['场景痛点', '方法对照', '行动建议'], emotion_trigger: '缓解选择焦虑',
    selling_point_presentation: '只呈现本店可核实的卖点', cta_type: '邀请评论需求',
    hashtags: ['场景体验'], duration_or_length: '约三百字', pacing_notes: '先问题后方法',
    reusable_pattern: '从场景问题起笔，再以对照说明选择方法，最后邀请读者补充需求。',
    risk_flags: ['二手来源'], source: { type: 'link', url: 'https://example.com/sample', fetchedAt: null },
    ...overrides,
  };
}
const insert = (tenantId = 81, employeeRunId = 101) => runWithTenant(tenantId, () => cards.insertBenchmarkCards({
  tenantId, employeeRunId, cards: [sampleCard()],
}))[0];

test('同一次拆解重复沉淀幂等；待核验卡不提前进入知识召回', () => {
  const first = insert();
  const second = insert();
  assert.equal(first.id, second.id);
  assert.equal(cards.listBenchmarkCards(81).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM kb_docs WHERE enabled=1').get().n, 0);
});
test('已确认才注入 few-shot，未知/裸卡不得冒充已确认', () => {
  const pending = insert();
  assert.equal(cards.contentBenchmarkFewShotBlock([pending, sampleCard()]), '');
  const verified = runWithTenant(81, () => cards.markBenchmarkCardVerified(pending.id, 1, { tenantId: 81 }));
  assert.match(cards.contentBenchmarkFewShotBlock([verified]), /老板已确认/u);
  assert.match(cards.contentBenchmarkFewShotBlock([verified]), /只复用/u);
  assert.equal(cards.contentBenchmarkFewShotBlock([verified], { platform: '抖音' }), '');
});
test('确认按显式租户写一次知识库，删除同步禁用；不能复活软删卡', () => {
  const row = insert(82);
  // 刻意在另一企业上下文中传显式 tenantId，验证所有写入使用同一租户。
  runWithTenant(81, () => cards.markBenchmarkCardVerified(row.id, 2, { tenantId: 82 }));
  runWithTenant(81, () => cards.markBenchmarkCardVerified(row.id, 2, { tenantId: 82 }));
  const docs = db.prepare('SELECT tenant_id,source_id,enabled FROM kb_docs').all();
  assert.equal(docs.length, 1);
  assert.equal(docs[0].tenant_id, 82);
  assert.equal(docs[0].source_id, row.id);
  assert.equal(docs[0].enabled, 1);
  cards.softDeleteBenchmarkCard(row.id, 2, { tenantId: 82 });
  assert.equal(db.prepare('SELECT enabled FROM kb_docs').get().enabled, 0);
  assert.equal(cards.markBenchmarkCardVerified(row.id, 2, { tenantId: 82 }), null);
  assert.equal(insert(82).id, row.id);
  assert.equal(cards.listBenchmarkCards(82).length, 0);
});
test('列表、详情、确认和删除都不越过企业边界', () => {
  const own = insert(81); const other = insert(82);
  assert.deepEqual(cards.listBenchmarkCards(81).map(item => item.id), [own.id]);
  assert.equal(cards.getBenchmarkCard(81, other.id), null);
  assert.equal(cards.markBenchmarkCardVerified(other.id, 1, { tenantId: 81 }), null);
  assert.equal(cards.softDeleteBenchmarkCard(other.id, 1, { tenantId: 81 }), null);
  assert.equal(cards.getBenchmarkCard(82, other.id).verified, 0);
});
test('知识库同步失败回滚确认状态，不显示虚假的已学习', () => {
  const row = insert();
  db.exec("CREATE TRIGGER fail_benchmark_kb BEFORE INSERT ON kb_docs BEGIN SELECT RAISE(ABORT, 'kb-write-failed'); END;");
  try {
    assert.throws(() => cards.markBenchmarkCardVerified(row.id, 1, { tenantId: 81 }), /kb-write-failed/u);
    assert.equal(cards.getBenchmarkCard(81, row.id).verified, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM kb_docs').get().n, 0);
  } finally { db.exec('DROP TRIGGER fail_benchmark_kb'); }
});
test('不能用 source.secondhand=false 将转载页标成原站；来源链接去除凭据', () => {
  assert.equal(cards.normalizeBenchmarkCard(sampleCard({ source: {
    type: 'link', url: 'https://example.com/sample', secondhand: false,
  } })).source.secondhand, true);
  assert.equal(cards.normalizeBenchmarkCard(sampleCard({ source: {
    type: 'link', url: 'https://user:password@example.com/sample',
  } })).source.url, null);
});
test('小数和无穷 limit 不触发 SQLite datatype mismatch', () => {
  insert();
  assert.equal(cards.listBenchmarkCards(81, { limit: 1.8 }).length, 1);
  assert.equal(cards.listBenchmarkCards(81, { limit: Infinity }).length, 1);
});
test('运行上下文只取已确认卡，并确实传入模型用户消息（不进入系统消息）', async () => {
  const pending = insert();
  const common = { mode: 'solo', tenantId: 81, actorId: 1, employeeIdx: 3, task: { direction: '写本店场景体验稿', platforms: ['小红书'] } };
  const deps = {
    loadTenant: async () => ({ id: 81, name: '测试门店' }),
    loadActor: async () => ({ id: 1, tenant_id: 81, role: 'boss' }),
    kbSearchFn: async () => ({ text: '', refs: [] }), storeFactsFn: () => ({}),
  };
  assert.equal((await buildContentHandlerRuntimeContext(common, deps)).context.benchmarkCards.length, 0);
  cards.markBenchmarkCardVerified(pending.id, 1, { tenantId: 81 });
  const built = await buildContentHandlerRuntimeContext(common, deps);
  assert.equal(built.context.benchmarkCards.length, 1);
  let actual;
  await invokeContentHandlerGenerate({ employeeIdx: 3, context: built.context,
    prompt: { system: '系统边界', user: '写作任务' }, generationArgs: {},
    generateFn: async args => { actual = args; return { text: 'ok' }; },
  });
  assert.match(actual.userMsg, /可借鉴的爆款结构/u);
  assert.match(actual.userMsg, /从场景问题起笔/u);
  assert.equal(actual.system, '系统边界');
});
