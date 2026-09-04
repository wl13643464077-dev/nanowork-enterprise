import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { validContentEmployeeOutput } from './helpers/content-output-fixtures.mjs';

Object.assign(process.env, {
  NANOWORK_TEST_TEMPLATE_AI: '1', NODE_ENV: 'test', NANOWORK_DB: ':memory:',
  ENABLE_SCHEDULER: 'false', ENABLE_BACKGROUND_EMBEDDINGS: 'false',
  YUNWU_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
});
globalThis.fetch = async () => { throw new Error('复盘证据单元测试禁止联网'); };
const { db, initSchema, migrateV2, runWithTenant } = await import('../src/db.js');
const { loadContentRetrospectiveEvidence } = await import('../src/engines/content-publish-followup.js');
const { validateContentEmployeeOutputContract } = await import('../src/engines/content-output-contract.js');
initSchema();
migrateV2();
assert.equal(db.prepare('PRAGMA database_list').get().file, '');
beforeEach(() => {
  migrateV2();
  db.exec('DELETE FROM content_publish_metrics; DELETE FROM content_publish_logs; DELETE FROM contents;');
});
after(() => db.close());

function content() {
  return Number(db.prepare("INSERT INTO contents(tenant_id,type,title,status,content_employee_idx) VALUES(81,'小红书','复盘边界验收','已发布',3)").run().lastInsertRowid);
}
function metric(id, { views = null, saves = null, orders = null, strategy = '痛点型', channel = '小红书', employeeIdx = 3 } = {}) {
  return Number(db.prepare(`INSERT INTO content_publish_metrics(tenant_id,content_id,views,saves,orders,channel,attribution_json,created_by)
    VALUES(81,?,?,?,?,?,?,1)`).run(id, views, saves, orders, channel, JSON.stringify({
    schema: 'nanowork.content-publish-attribution/1', source: 'legacy_single', strategy, employeeIdx,
  })).lastInsertRowid);
}
function evidence(id, allowCompanyComparison = true) {
  return runWithTenant(81, () => loadContentRetrospectiveEvidence({ id }, { tenantId: 81, allowCompanyComparison }));
}
function output(number) {
  const result = validContentEmployeeOutput(9);
  result.profile_updates = [];
  result.next_draft_changes = [
    { target: 'title', change: '下一稿标题只讲一个具体场景，发布后继续核对相同统计口径。', evidence: `人工回填数值为${number}，需要继续核对口径。` },
    { target: 'cover', change: '封面减少不必要的装饰，明确标注本次观察的具体对象。', evidence: `目前仅记录${number}，不据此认定封面效果。` },
  ];
  return result;
}

test('迁移为旧发布与回填增加可空归因，重复执行不改写历史数值', () => {
  const id = content();
  db.exec('ALTER TABLE content_publish_logs DROP COLUMN attribution_json; ALTER TABLE content_publish_metrics DROP COLUMN attribution_json;');
  const logId = Number(db.prepare("INSERT INTO content_publish_logs(tenant_id,content_id,channel,created_by,idempotency_key) VALUES(81,?,'小红书',1,'legacy-migration-fixture')").run(id).lastInsertRowid);
  db.prepare('INSERT INTO content_publish_metrics(tenant_id,content_id,views,created_by) VALUES(81,?,123,1)').run(id);
  migrateV2();
  migrateV2();
  assert.equal(db.prepare('SELECT attribution_json FROM content_publish_logs WHERE id=?').get(logId).attribution_json, null);
  const row = db.prepare('SELECT views,attribution_json FROM content_publish_metrics WHERE content_id=?').get(id);
  assert.equal(row.views, 123);
  assert.equal(row.attribution_json, null);
});

test('只有浏览量或订单数的真实回填也满足至少一项指标；未知率不能转成零', () => {
  for (const values of [{ views: 1000 }, { orders: 7 }]) {
    const id = content();
    metric(id, values);
    const frozen = evidence(id);
    const result = validateContentEmployeeOutputContract(9, output(values.views ?? values.orders), {
      enforceRequiredInputs: true, retroMetrics: frozen,
    });
    assert.equal(result.valid, true, result.errors.join(';'));
    assert.deepEqual(frozen.metrics[0].rates, { likes: null, saves: null, comments: null });
    assert.equal(frozen.canCompare, false);
  }
});

test('没有数值、未发布、跨企业与只有未来记录均不能形成复盘证据', () => {
  const id = content();
  metric(id);
  assert.throws(() => evidence(id), /至少一项数值/);
  db.prepare('UPDATE content_publish_metrics SET views=100,created_at=datetime(\'now\',\'localtime\',\'+1 day\') WHERE content_id=?').run(id);
  assert.throws(() => evidence(id), /至少一项数值/);
  db.prepare("UPDATE contents SET status='草稿' WHERE id=?").run(id);
  assert.throws(() => evidence(id), /没有发布记录/);
  assert.throws(() => runWithTenant(82, () => loadContentRetrospectiveEvidence({ id }, { tenantId: 82 })), /不属于本企业/);
});

test('策略对照须同渠道每组至少三篇有效率；普通员工没有企业对照数据', () => {
  const id = content();
  metric(id, { views: 100, saves: 5 });
  for (let n = 0; n < 2; n++) metric(content(), { views: 100, saves: 5 });
  for (let n = 0; n < 3; n++) metric(content(), { views: 100, strategy: '场景型' });
  assert.equal(evidence(id).canCompare, false, '只有分母的三篇不是三篇有效收藏率');
  for (let n = 0; n < 3; n++) metric(content(), { views: 100, saves: 7, strategy: '场景型', channel: '视频号' });
  assert.equal(evidence(id).canCompare, false, '跨渠道不可拼成对照组');
  for (let n = 0; n < 3; n++) metric(content(), { views: 100, saves: 7, strategy: '场景型' });
  const frozen = evidence(id);
  assert.equal(frozen.canCompare, true);
  assert.equal(frozen.comparisonStats.length, 2);
  assert.equal(frozen.instructionAuthority, false);
  assert.equal(frozen.verification, 'manual_unverified');
  assert.deepEqual(evidence(id, false).comparisonStats, []);
  db.prepare('UPDATE contents SET content_employee_idx=4 WHERE id=?').run(id);
  assert.equal(evidence(id).canCompare, true, '发布冻结的员工归属不能被当前内容元数据改写');
});

test('改法混入虚构数字、借任务书数字洗白、数据不足却判赢家均被拒绝', () => {
  const id = content();
  metric(id, { views: 1000, saves: 50 });
  const frozen = evidence(id);
  assert.equal(validateContentEmployeeOutputContract(9, output(1000), { retroMetrics: frozen }).valid, true);
  const forged = output(1000);
  forged.next_draft_changes[0].evidence = '回填浏览量1000，同时实现了987654次成交。';
  let result = validateContentEmployeeOutputContract(9, forged, { retroMetrics: frozen, requirement: '实际成交987654' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(';'), /未获效果数据支持的数字/);
  const winning = output(1000);
  winning.winning_strategy = { strategy: '痛点型', reason: '目前样本过少，不能根据单篇表现判定真实胜出。' };
  result = validateContentEmployeeOutputContract(9, winning, { retroMetrics: frozen });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(';'), /不得判定胜出/);
});
