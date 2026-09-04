import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.NODE_ENV = 'test';
process.env.NANOWORK_DB = ':memory:';
process.env.JWT_SECRET = 'content-strategy-metrics-test-only';
process.env.ENABLE_SCHEDULER = 'false';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';
process.env.YUNWU_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
globalThis.fetch = async () => { throw new Error('策略统计测试禁止联网'); };

const { db, initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
const followup = await import('../src/engines/content-publish-followup.js');
initSchema();
migrateV2();
for (const id of [71, 72]) {
  db.prepare("INSERT INTO tenants(id,name,status,credits) VALUES(?,?,'已开通',1000)")
    .run(id, `策略统计企业${id}`);
}
beforeEach(() => {
  db.exec('DELETE FROM content_publish_metrics; DELETE FROM contents;');
});
after(() => db.close());

function content({ tenant = 71, employee = 3, strategies = ['痛点型'], snapshot } = {}) {
  return Number(db.prepare(`INSERT INTO contents(
    tenant_id,type,title,content_employee_idx,snapshot_json
  ) VALUES(?,'小红书带货文案','策略回填测试',?,?)`).run(
    tenant,
    employee,
    snapshot ?? JSON.stringify({ contract: { parsedOutput: { versions: strategies.map(strategy => ({ strategy })) } } }),
  ).lastInsertRowid);
}

function metric(contentId, { tenant = 71, views = 100, likes = null, saves = null,
  comments = null, channel = '小红书', daysAgo = 0 } = {}) {
  return Number(db.prepare(`INSERT INTO content_publish_metrics(
    tenant_id,content_id,views,likes,saves,comments,channel,created_by,created_at
  ) VALUES(?,?,?,?,?,?,?,1,datetime('now','localtime',?))`).run(
    tenant, contentId, views, likes, saves, comments, channel, `-${daysAgo} days`,
  ).lastInsertRowid);
}

function summary(options = {}, tenant = 71) {
  return runWithTenant(tenant, () => followup.contentStrategyMetricsSummary(tenant, { employeeIdx: 3, ...options }));
}

test('M5 发布回填提供真实策略统计导出，空库为空数组', () => {
  assert.equal(typeof followup.contentStrategyMetricsSummary, 'function');
  assert.deepEqual(summary(), []);
});

test('策略统计采用每篇内容同渠道最新快照，不能累计重复回填', () => {
  const id = content();
  metric(id, { views: 100, saves: 30, likes: 40 });
  metric(id, { views: 200, saves: 10, likes: 20, comments: 4 });
  const [result] = summary();
  assert.equal(result.strategy, '痛点型');
  assert.equal(result.contents, 1);
  assert.equal(result.avgSaveRate, 5);
  assert.equal(result.avgLikeRate, 10);
  assert.equal(result.avgCommentRate, 2);
  assert.equal(result.verification, 'manual_unverified');
});

test('缺失分子与零分母保留未知，实际零保留为零', () => {
  metric(content(), { views: 0, saves: 0, likes: 0 });
  let [result] = summary();
  assert.equal(result.avgSaveRate, null);
  assert.equal(result.avgLikeRate, null);
  metric(content(), { views: 100, saves: 0 });
  [result] = summary();
  assert.equal(result.avgSaveRate, 0);
  assert.equal(result.avgLikeRate, null);
  assert.equal(result.avgCommentRate, null);
});

test('不同内容按单篇率计算均值，不把数据量大的内容当多篇样本', () => {
  metric(content(), { views: 100, saves: 10 });
  metric(content(), { views: 1000, saves: 10 });
  const [result] = summary();
  assert.equal(result.contents, 2);
  assert.equal(result.avgSaveRate, 5.5);
});

test('企业与员工隔离，伪造跨企业关联不进入统计', () => {
  const own = content();
  metric(own, { saves: 5 });
  metric(content({ tenant: 72 }), { tenant: 72, saves: 90 });
  metric(content({ employee: 4 }), { saves: 80 });
  metric(own, { tenant: 72, saves: 99 });
  const [result] = summary();
  assert.equal(result.contents, 1);
  assert.equal(result.avgSaveRate, 5);
  assert.equal(summary({}, 72)[0].avgSaveRate, 90);
});

test('多版本尚未选择策略、缺失策略与损坏快照均不猜测归因', () => {
  metric(content({ strategies: ['痛点型', '场景型'] }), { saves: 70 });
  metric(content({ strategies: [] }), { saves: 70 });
  metric(content({ snapshot: '{broken' }), { saves: 70 });
  assert.deepEqual(summary(), []);
});

test('按渠道分组并只统计指定回填时间窗', () => {
  const id = content();
  metric(id, { channel: '小红书', saves: 5 });
  metric(id, { channel: '视频号', saves: 20 });
  metric(content(), { daysAgo: 31, saves: 90 });
  const result = summary();
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(row => row.avgSaveRate).sort((a, b) => a - b), [5, 20]);
  assert.equal(result.reduce((n, row) => n + row.contents, 0), 2);
});

test('无效员工筛选不能静默退化成全员查询', () => {
  for (const employeeIdx of [-1, 11, 'all', 1.5]) {
    assert.throws(() => summary({ employeeIdx }), /员工/);
  }
});
