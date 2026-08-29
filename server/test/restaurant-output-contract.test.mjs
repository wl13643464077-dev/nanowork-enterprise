import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(os.tmpdir(), `nanowork-restaurant-output-contract-${process.pid}.db`);
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DB_PATH;
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { loadRestaurantCatalog } = await import('../src/catalog/restaurant.js');
const {
  getRestaurantOutputContract,
  validateRestaurantEmployeeOutputContract,
  canonicalizeRestaurantEmployeeOutputCandidate,
  restaurantEmployeeHardDeliveryDecision,
  rewriteUnsafeRestaurantPlatformActions,
  validateRestaurantArithmeticExpressions,
  renderRestaurantOutputMarkdown,
} = await import('../src/engines/restaurant-output-contract.js');
const { initSchema, migrateV2 } = await import('../src/db.js');
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const { buildEmployeeWorkbench } = await import('../src/employee-workbench.js');
const { buildEmployeeExecutionProfile } = await import('../src/employee-workbench.js');
const { marshalWork, tplInvestment } = await import('../src/engines/ai.js');
const AI_SOURCE = fs.readFileSync(new URL('../src/engines/ai.js', import.meta.url), 'utf8');

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

after(() => {
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
});

function clone(value) {
  return structuredClone(value);
}

function firstDeliverableKey(contract) {
  return contract.deliverableKeys[0];
}

function pointExecutionEvidenceAtSource(fixture, source) {
  for (const item of Object.values(fixture?.input_audit || {})) {
    item.evidence_refs = [source];
  }
  for (const item of Object.values(fixture?.method_execution || {})) {
    item.evidence_refs = [source];
  }
  return fixture;
}

function collectObjectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    value.forEach(item => collectObjectKeys(item, keys));
    return keys;
  }
  if (!value || typeof value !== 'object') return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.push(key);
    collectObjectKeys(child, keys);
  }
  return keys;
}

function collectWorkProductItems(fixture) {
  return Object.values(fixture?.deliverables || {}).flatMap(deliverable => (
    (deliverable?.work_product?.sections || []).flatMap(section => section?.items || [])
  ));
}

test('101-161 每岗拥有唯一稳定的结构化机器输出契约和合法样本', () => {
  const catalog = loadRestaurantCatalog();
  const contracts = catalog.employees.map(employee => getRestaurantOutputContract(employee.idx));

  assert.equal(contracts.length, 61);
  assert.equal(new Set(contracts.map(item => item.contractId)).size, 61);
  assert.equal(new Set(contracts.map(item => item.primaryArtifact)).size, 61);
  assert.equal(new Set(contracts.map(item => JSON.stringify(item.schema))).size, 61);
  assert.equal(new Set(contracts.map(item => JSON.stringify(item.validFixture))).size, 61);

  for (const [offset, employee] of catalog.employees.entries()) {
    const contract = contracts[offset];
    assert.equal(contract.employeeIdx, employee.idx);
    assert.equal(contract.employeeKey, employee.key);
    assert.equal(contract.format, 'json_object');
    assert.match(contract.contractId, new RegExp(`:${employee.idx}:`, 'u'));
    assert.equal(contract.schema.type, 'object');
    assert.equal(contract.schema.additionalProperties, false);
    assert.equal(contract.providerSchema.type, 'object');
    assert.equal(contract.providerSchema.additionalProperties, false);
    const providerKeys = collectObjectKeys(contract.providerSchema);
    for (const unsupported of ['$schema', '$id', 'minLength', 'minItems', 'maxItems', 'const']) {
      assert.equal(providerKeys.includes(unsupported), false, `员工${employee.idx}供应商Schema不得包含${unsupported}`);
    }
    assert.ok(collectObjectKeys(contract.schema).includes('minItems'));
    assert.ok(collectObjectKeys(contract.schema).includes('minLength'));
    assert.deepEqual(contract.schema.required, Object.keys(contract.validFixture));
    assert.equal(contract.deliverableKeys.length, employee.deliverables.length);
    assert.deepEqual(
      contract.deliverableKeys.map(key => contract.validFixture.deliverables[key].deliverable_name),
      employee.deliverables,
    );
    assert.ok(contract.deliverableKeys.every(key => (
      Array.isArray(contract.validFixture.deliverables[key].evidence)
      && typeof contract.validFixture.deliverables[key].evidence[0] === 'object'
      && Array.isArray(contract.validFixture.deliverables[key].actions)
      && typeof contract.validFixture.deliverables[key].actions[0] === 'object'
      && Array.isArray(contract.validFixture.deliverables[key].acceptance_checks)
      && typeof contract.validFixture.deliverables[key].acceptance_checks[0] === 'object'
    )));

    const result = validateRestaurantEmployeeOutputContract(employee.idx, contract.validFixture);
    assert.equal(result.valid, true, `员工${employee.idx}合法样本应通过：${result.errors.join('；')}`);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].kind, contract.primaryArtifact);
    assert.equal(result.artifacts[0].employeeIdx, employee.idx);
  }
});

test('61岗均严格拒绝缺字段、null/空文本、错类型、未知字段、空数组和嵌套缺字段', () => {
  for (let idx = 101; idx <= 161; idx += 1) {
    const contract = getRestaurantOutputContract(idx);
    const deliverableKey = firstDeliverableKey(contract);
    const invalidFixtures = [];

    const missingField = clone(contract.validFixture);
    delete missingField.approval;
    invalidFixtures.push(['缺字段', missingField]);

    const nullText = clone(contract.validFixture);
    nullText.decision_context.problem = null;
    invalidFixtures.push(['null文本', nullText]);

    const emptyText = clone(contract.validFixture);
    emptyText.deliverables[deliverableKey].summary = '   ';
    invalidFixtures.push(['空文本', emptyText]);

    const wrongType = clone(contract.validFixture);
    wrongType.deliverables = [];
    invalidFixtures.push(['错类型', wrongType]);

    const unknownField = clone(contract.validFixture);
    unknownField.deliverables[deliverableKey].invented = '禁止静默接受';
    invalidFixtures.push(['未知字段', unknownField]);

    const emptyArray = clone(contract.validFixture);
    emptyArray.deliverables[deliverableKey].evidence = [];
    invalidFixtures.push(['空数组', emptyArray]);

    const nestedMissing = clone(contract.validFixture);
    delete nestedMissing.deliverables[deliverableKey].actions[0].owner;
    invalidFixtures.push(['嵌套缺字段', nestedMissing]);

    for (const [label, fixture] of invalidFixtures) {
      const result = validateRestaurantEmployeeOutputContract(idx, fixture);
      assert.equal(result.valid, false, `员工${idx}必须拒绝${label}`);
      assert.ok(result.errors.length > 0, `员工${idx}拒绝${label}时必须说明原因`);
      assert.deepEqual(result.artifacts, [], `员工${idx}拒绝${label}时不能生成合格产物`);
    }
  }
});

test('解析边界拒绝空输出、数组、null、非法JSON和错误岗位契约', () => {
  for (const raw of ['', '[]', 'null', '{"broken":', 42]) {
    const result = validateRestaurantEmployeeOutputContract(101, raw);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.deepEqual(result.artifacts, []);
  }

  const wrongRole = clone(getRestaurantOutputContract(102).validFixture);
  assert.equal(validateRestaurantEmployeeOutputContract(101, wrongRole).valid, false);
});

test('报告优先候选的百分比乘法与万/亿单位换算必须可复算', () => {
  const correct = '自上而下：530万×3000元×5%=7.95亿元；自下而上：20万×3%×1次/月×80元×12=576万元。';
  assert.deepEqual(validateRestaurantArithmeticExpressions(correct), []);

  const wrong = '自上而下：太原常住人口约530万，按人均年餐饮消费3000元，粤菜渗透率5%，可达79.5亿元；自下而上：商圈覆盖人口假设20万，渗透率3%，频次1次/月，客单80元，年需求5760万元。';
  const errors = validateRestaurantArithmeticExpressions(wrong);
  assert.equal(errors.length, 2);
  assert.equal(errors[0].kind, 'percentage_market_size');
  assert.equal(errors[1].kind, 'monthly_frequency_unit_conversion');
  assert.match(errors.map((item) => item.message).join('；'), /7.95亿元/u);
  assert.match(errors.map((item) => item.message).join('；'), /576万元/u);
  const compressedWrong = '覆盖人口20万×3%×12×80=5760万元。';
  const compressedErrors = validateRestaurantArithmeticExpressions(compressedWrong);
  assert.equal(compressedErrors.length, 1);
  assert.equal(compressedErrors[0].kind, 'monthly_frequency_unit_conversion');
  assert.match(compressedErrors[0].message, /576万元/u);
  const directErrors = validateRestaurantArithmeticExpressions(
    '530万×3000元×5%=79.5亿元；20万×3%×1次/月×80元×12=5760万元。',
  );
  assert.deepEqual(
    directErrors.map((item) => item.kind),
    ['percentage_market_size', 'monthly_frequency_unit_conversion'],
  );
});

test('方法执行记录不能用输出截断或未执行占位文案冒充七步结果', () => {
  const contract = getRestaurantOutputContract(102);
  const invalid = clone(contract.validFixture);
  const methodKey = contract.methodKeys[1];
  invalid.method_execution[methodKey].status = 'blocked';
  invalid.method_execution[methodKey].actual_execution = '本轮输出被截断，该步骤未执行。';
  const result = validateRestaurantEmployeeOutputContract(102, invalid, {
    qualityMode: 'advisory',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('；'), /未执行、输出截断或重新派活/u);
});

test('生产派活把内容质检降为可见建议，但结构与伪造来源仍保持硬阻断', () => {
  const contract = getRestaurantOutputContract(102);
  const qualityOnly = clone(contract.validFixture);
  qualityOnly.quality_review.overall_status = 'needs_review';
  qualityOnly.deliverables[contract.deliverableKeys[0]].work_product.sections[0]
    .items[0].evidence_ref = '商圈现场观察记录（引用名待规范）';

  const strict = validateRestaurantEmployeeOutputContract(102, qualityOnly);
  assert.equal(strict.valid, false);
  assert.match(strict.errors.join('；'), /岗位质量门/u);

  const advisory = validateRestaurantEmployeeOutputContract(102, qualityOnly, {
    qualityMode: 'advisory',
  });
  assert.equal(advisory.valid, true, advisory.errors.join('；'));
  assert.equal(advisory.qualityMode, 'advisory');
  assert.match(advisory.warnings.join('；'), /岗位质量门/u);
  assert.match(advisory.warnings.join('；'), /evidence_ref/u);
  assert.equal(advisory.artifacts.length, 1, '有真实可解析结果时必须保留主产物');

  const forged = clone(contract.validFixture);
  forged.decision_context.sources[0].source = '伪造来源｜https://unverified.example/fake';
  const blocked = validateRestaurantEmployeeOutputContract(102, forged, {
    qualityMode: 'advisory',
    requireWebSources: true,
    allowedSources: [{ title: '真实商户页', url: 'https://verified.example/store' }],
  });
  assert.equal(blocked.valid, false);
  assert.match(blocked.errors.join('；'), /不在本次联网证据快照|不是本次已验证联网来源/u);
});

test('演示模式调研快照缺失可交付诚实缺口报告，但仍拒绝自造URL', () => {
  const contract = getRestaurantOutputContract(102);
  const honest = clone(contract.validFixture);
  const accepted = validateRestaurantEmployeeOutputContract(102, honest, {
    qualityMode: 'advisory',
    requireWebSources: true,
    allowResearchWarning: true,
    allowedSources: [],
  });
  assert.equal(accepted.valid, true, accepted.errors.join('；'));

  const forged = clone(contract.validFixture);
  forged.decision_context.sources[0].source = '伪造官网｜https://unverified.example/fake';
  const blocked = validateRestaurantEmployeeOutputContract(102, forged, {
    qualityMode: 'advisory',
    requireWebSources: true,
    allowResearchWarning: true,
    allowedSources: [],
  });
  assert.equal(blocked.valid, false);
  assert.match(blocked.errors.join('；'), /无已验证联网快照|禁止补造来源/u);
});

test('联网岗位只接受允许来源快照中的原始标题与完整URL，旧无联网夹具仍兼容', () => {
  const contract = getRestaurantOutputContract(101);
  const sourceTitle = 'Agentic来源101-1';
  const sourceUrl = 'https://agentic.test/101/1';
  const taskContext = {
    allowedSources: [{ title: sourceTitle, url: sourceUrl }],
    requireWebSources: true,
  };

  const legal = clone(contract.validFixture);
  legal.decision_context.sources[0].source = `${sourceTitle}｜${sourceUrl}`;
  pointExecutionEvidenceAtSource(legal, legal.decision_context.sources[0].source);
  const legalResult = validateRestaurantEmployeeOutputContract(101, legal, taskContext);
  assert.equal(legalResult.valid, true, legalResult.errors.join('；'));

  const changedTitle = clone(legal);
  changedTitle.decision_context.sources[0].source = `改写后的来源标题｜${sourceUrl}`;
  const changedTitleResult = validateRestaurantEmployeeOutputContract(101, changedTitle, taskContext);
  assert.equal(changedTitleResult.valid, false);
  assert.match(changedTitleResult.errors.join('；'), /原始标题|完整URL/u);

  const inventedUrl = clone(legal);
  inventedUrl.decision_context.sources[0].source = `${sourceTitle}｜https://agentic.test/101/fabricated`;
  const inventedUrlResult = validateRestaurantEmployeeOutputContract(101, inventedUrl, taskContext);
  assert.equal(inventedUrlResult.valid, false);
  assert.match(inventedUrlResult.errors.join('；'), /不在本次联网证据快照|原始标题/u);

  const legacyResult = validateRestaurantEmployeeOutputContract(101, contract.validFixture);
  assert.equal(legacyResult.valid, true, legacyResult.errors.join('；'));
});

test('餐饮候选canonicalize不变异输入、不改正文，只把明确未闭环的verified降为gap', () => {
  const contract = getRestaurantOutputContract(101);
  const candidate = clone(contract.validFixture);
  const target = collectWorkProductItems(candidate)[0];
  const unresolvedResult = '待补证：当前缺少一项已授权原料记录，需由门店负责人核验后再闭环。';
  target.result = unresolvedResult;
  target.status = 'verified';
  const before = clone(candidate);
  const raw = JSON.stringify(candidate, null, 2);

  const result = canonicalizeRestaurantEmployeeOutputCandidate(101, raw);

  assert.deepEqual(candidate, before, 'canonicalize不得修改调用方持有的对象');
  assert.equal(result.changed, true);
  assert.equal(result.parseError, null);
  assert.equal(result.parsed.deliverables[contract.deliverableKeys[0]]
    .work_product.sections[0].items[0].result, unresolvedResult,
  'canonicalize不得改写正文事实或补写字段');
  const expected = clone(candidate);
  collectWorkProductItems(expected)[0].status = 'gap';
  assert.deepEqual(result.parsed, expected, '除状态降级外不得改动候选结构');
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].from, 'verified');
  assert.equal(result.changes[0].to, 'gap');
  assert.equal(result.changes[0].reason, 'result_explicitly_unresolved');
  assert.equal(validateRestaurantEmployeeOutputContract(101, raw).valid, false);
  assert.equal(validateRestaurantEmployeeOutputContract(101, result.text).valid, true,
    '单一verified/正文矛盾经保守降级后应通过最终契约');
});

test('餐饮候选canonicalize保持gap、assumption和真正verified，不发生状态升格', () => {
  const candidate = clone(getRestaurantOutputContract(101).validFixture);
  const items = collectWorkProductItems(candidate);
  items[0].status = 'gap';
  items[0].result = '待核验：当前缺少一项授权原料记录，门店负责人需补证后再判断。';
  items[1].status = 'assumption';
  items[1].result = '基于本次任务材料的统一月结口径作出假设，后续由门店负责人按记录复核。';
  items[2].status = 'verified';
  items[2].result = '依据门店A本次任务材料，已记录营业额100000元、订单2000单及统计期间，并给出可复核判断。';

  const before = clone(candidate);
  const result = canonicalizeRestaurantEmployeeOutputCandidate(101, JSON.stringify(candidate));

  assert.equal(result.changed, false);
  assert.deepEqual(result.parsed, before);
  assert.deepEqual(
    collectWorkProductItems(result.parsed).slice(0, 3).map(item => item.status),
    ['gap', 'assumption', 'verified'],
  );
  assert.equal(result.changes.length, 0);
});

test('工作台 jobProfile 对61岗暴露同一权威契约，审批与外部动作边界不被放宽', () => {
  for (let idx = 101; idx <= 161; idx += 1) {
    const contract = getRestaurantOutputContract(idx);
    const profile = buildEmployeeWorkbench(idx, {
      tenantId: 1,
      user: { id: 1, role: 'boss', tenant_id: 1 },
    });

    assert.deepEqual(profile.jobProfile.outputContract, contract);
    assert.deepEqual(profile.jobProfile.outputSchema, contract.schema);
    assert.equal(profile.jobProfile.primaryArtifact, contract.primaryArtifact);
    assert.deepEqual(profile.jobProfile.validOutputFixture, contract.validFixture);
    assert.equal(profile.jobProfile.authority.mayPublishExternally, false);
    assert.equal(profile.jobProfile.authority.mayCommitFinancialOrRegulatoryDecision, false);
    assert.equal(profile.jobProfile.authority.finalApproval, 'auto');
    assert.equal(contract.schemaVersion, 'restaurant-role-output/4');
    assert.equal(contract.validFixture.approval.status, 'routed_by_task_policy');
    assert.equal(contract.validFixture.approval.external_action_allowed, false);
    assert.equal(contract.validFixture.approval.financial_or_regulatory_commitment_allowed, false);
  }
});

test('101-161契约ID与schema均为v4，默认渲染不落待人工审阅或授权放行', () => {
  const catalog = loadRestaurantCatalog();
  for (const employee of catalog.employees) {
    const contract = getRestaurantOutputContract(employee.idx);
    assert.equal(contract.schemaVersion, 'restaurant-role-output/4');
    assert.match(contract.contractId, new RegExp(`:${employee.idx}:.*:v4$`, 'u'));
    assert.equal(contract.validFixture.contract_id, contract.contractId);
    assert.equal(contract.validFixture.approval.status, 'routed_by_task_policy');
    assert.equal(contract.validFixture.approval.external_action_allowed, false);
    assert.equal(contract.validFixture.approval.financial_or_regulatory_commitment_allowed, false);

    const rendered = renderRestaurantOutputMarkdown(employee.idx, contract.validFixture);
    assert.doesNotMatch(rendered, /待人工审阅结构化交付/u);
    assert.doesNotMatch(rendered, /draft_pending_human_review/u);
    assert.match(rendered, /外部动作授权字段[\s\S]*否/u);
  }
});

test('餐饮repair清单与招商底稿不把内部产出送默认人工审核，外发/付费/不可逆仍锁老板授权', () => {
  const checklistStart = AI_SOURCE.indexOf('function restaurantSemanticRepairChecklist(');
  const checklistEnd = AI_SOURCE.indexOf('// 兼容入口：仅要注入文本的调用方', checklistStart);
  assert.ok(checklistStart >= 0 && checklistEnd > checklistStart, '缺少餐饮repair清单实现');
  const checklist = AI_SOURCE.slice(checklistStart, checklistEnd);
  assert.match(checklist, /approval 表示任务策略路由与执行授权边界，不是默认内容审核/u);
  assert.match(checklist, /approval\.status固定为routed_by_task_policy/u);
  assert.match(checklist, /两个allowed布尔值固定为false/u);
  assert.match(checklist, /未经老板执行授权不得外发、真实付费或执行不可逆动作/u);
  assert.doesNotMatch(checklist, /待人工审阅结构化交付|draft_pending_human_review|人工审批前不得执行外部动作/u);

  const investmentStart = AI_SOURCE.indexOf('export function tplInvestment(');
  const investmentEnd = AI_SOURCE.indexOf('export function tplRepurchase(', investmentStart);
  assert.ok(investmentStart >= 0 && investmentEnd > investmentStart, '缺少招商底稿模板');
  const investmentSource = AI_SOURCE.slice(investmentStart, investmentEnd);
  assert.match(investmentSource, /内部草稿不进入默认内容审核/u);
  assert.match(investmentSource, /如需外发，必须先取得老板执行授权/u);
  assert.match(investmentSource, /收益类数字一律不得由AI填充/u);
  assert.doesNotMatch(investmentSource, /待人工审阅结构化交付|draft_pending_human_review/u);

  const investment = tplInvestment('QA合作说明会');
  assert.match(investment, /内部草稿不进入默认内容审核/u);
  assert.match(investment, /外发前须取得老板执行授权/u);
  assert.match(investment, /如需外发，必须先取得老板执行授权/u);
  assert.match(investment, /收益类数字一律不得由AI填充/u);
  assert.doesNotMatch(investment, /待人工审阅结构化交付|draft_pending_human_review/u);
});

const testMarshal = {
  code: 'M-01',
  name: '市场与选址分部',
  title: '内部调度容器',
  duty: '仅负责调度',
  skills: '',
  prompt: '',
  kb_deps: '',
};

function offlineLocationEvidence() {
  return {
    attempted: true,
    ok: true,
    provider: 'offline-map-fixture',
    results: [{
      title: '离线地图来源',
      url: 'https://www.openstreetmap.org/way/7101',
      snippet: '隔离测试位置证据，不代表真实门店定位。',
    }],
    evidence: {
      externalCall: false,
      qaOnly: true,
      center: { lat: 37.81, lon: 112.55 },
    },
  };
}

const OFFLINE_RESTAURANT_SOURCE = Object.freeze({
  title: '大众点评·毛血旺 太原吾悦广场商户正文',
  url: 'https://www.dianping.com/shop/maoxuewang-wuyue-offline-contract',
  snippet: '太原吾悦广场毛血旺餐厅菜单、菜品、价格、营业状态、评价与外卖公开商户正文。',
});

function offlineRestaurantSearch() {
  return {
    attempted: true,
    ok: true,
    provider: 'offline-public-restaurant-search',
    results: [OFFLINE_RESTAURANT_SOURCE],
  };
}

function offlineRestaurantFetch(sources = []) {
  const source = sources[0] || OFFLINE_RESTAURANT_SOURCE;
  return {
    attempted: true,
    ok: true,
    provider: 'offline-controlled-restaurant-fetch',
    results: [{
      ...source,
      body: '受控网页正文：太原吾悦广场毛血旺餐厅菜单、菜品、价格、营业状态、评价、外卖与竞品正文已读取并净化，仅用于隔离契约验证；未知字段保留复核动作，不构成外部执行授权或真实市场结论。',
    }],
    evidence: {
      schemaVersion: 'nanowork.controlled-web-evidence/1',
      requested: sources.length,
      fetched: 1,
      failures: [],
      externalCall: false,
      ssrfProtected: true,
      redirectsRevalidated: true,
      responseBytesStored: false,
    },
  };
}

test('直接派活把同一Schema交给模型，严格校验后渲染为可审阅Markdown', async () => {
  const employeeExecution = buildEmployeeExecutionProfile(101, {
    tenantId: 1,
    user: { id: 1, role: 'boss', tenant_id: 1 },
  });
  const contract = getRestaurantOutputContract(101);
  let generationArgs;
  const output = await marshalWork(testMarshal, {
    title: '毛血旺 太原吾悦广场商圈机会验证',
    type: '分析',
    requirement: '围绕毛血旺 太原吾悦广场，只使用已授权材料，形成待审阅交付。',
  }, 'boss', {
    employeeExecution,
    webSearchFn: async () => offlineRestaurantSearch(),
    controlledWebFetchFn: async sources => offlineRestaurantFetch(sources),
    locationIntelligenceFn: async () => offlineLocationEvidence(),
    generateFn: async args => {
      generationArgs = args;
      // 引擎已加严：产出必须明确指向本次任务标题，夹具同步带上标题
      const fixture = structuredClone(contract.validFixture);
      if (fixture?.decision_context && typeof fixture.decision_context.problem === 'string') {
        fixture.decision_context.problem = `毛血旺 太原吾悦广场商圈机会验证：${fixture.decision_context.problem}`;
      }
      fixture.decision_context.sources[0].source = '离线地图来源｜https://www.openstreetmap.org/way/7101';
      pointExecutionEvidenceAtSource(fixture, fixture.decision_context.sources[0].source);
      return {
        text: JSON.stringify(fixture),
        mode: 'api',
        model: 'qa-real-contract-model',
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    },
  });

  assert.deepEqual(generationArgs.responseSchema, employeeExecution.responseSchema);
  assert.deepEqual(generationArgs.responseSchema.schema, contract.providerSchema);
  assert.match(generationArgs.system, new RegExp(contract.contractId, 'u'));
  assert.equal(output.employeeContract.valid, true);
  assert.equal(output.employeeContract.contractId, contract.contractId);
  assert.equal(output.employeeContract.artifacts.length, 1);
  assert.match(output.text, /## 决策建议与置信度/u);
  assert.match(output.text, /岗位完整正文/u);
  assert.match(output.text, /## 下一步/u);
  assert.match(output.text, /外部动作授权字段[\s\S]*否/u);
  assert.doesNotMatch(output.text, /待人工审阅结构化交付/u);
  assert.doesNotMatch(output.text, /draft_pending_human_review/u);
  assert.doesNotMatch(output.text, /^\s*\{/u);
});

test('演示派活已有真实结构化结果时不再因内容质检整单失败，并保留可见告警', async () => {
  const employeeExecution = buildEmployeeExecutionProfile(102, {
    tenantId: 1,
    user: { id: 1, role: 'boss', tenant_id: 1 },
  });
  const contract = getRestaurantOutputContract(102);
  const task = {
    title: '毛血旺 太原吾悦广场质检告警交付验证',
    type: '分析',
    requirement: '真实结果照常交付，内容完善项作为提示展示。',
  };
  const fixture = clone(contract.validFixture);
  fixture.decision_context.problem = `${task.title}：${fixture.decision_context.problem}`;
  fixture.decision_context.sources[0].source = '离线地图来源｜https://www.openstreetmap.org/way/7101';
  pointExecutionEvidenceAtSource(fixture, fixture.decision_context.sources[0].source);
  fixture.deliverables[contract.deliverableKeys[0]].actions[0].owner = '负责人';

  const output = await marshalWork(testMarshal, task, 'boss', {
    employeeExecution,
    dataMode: 'demo',
    webSearchFn: async () => offlineRestaurantSearch(),
    controlledWebFetchFn: async sources => offlineRestaurantFetch(sources),
    locationIntelligenceFn: async () => offlineLocationEvidence(),
    generateFn: async () => ({
      text: JSON.stringify(fixture),
      mode: 'api',
      model: 'qa-real-advisory-quality-model',
      usage: { inputTokens: 12, outputTokens: 24 },
    }),
  });

  assert.equal(output.mode, 'api');
  assert.equal(output.employeeContract.valid, true);
  assert.equal(output.employeeContract.qualityMode, 'advisory');
  assert.match(output.employeeContract.warnings.join('；'), /owner/u);
  assert.equal(output.employeeContract.artifacts.length, 1);
  assert.match(output.text, /## 决策建议与置信度/u);
});

test('餐饮demo纯Markdown不得绕过v4岗位审计，live同样要求结构化JSON', async () => {
  const employeeExecution = buildEmployeeExecutionProfile(102, {
    tenantId: 1,
    user: { id: 1, role: 'boss', tenant_id: 1 },
  });
  const task = {
    title: '太原吾悦广场商圈内部分析报告',
    type: '分析',
    requirement: '形成企业内部报告，证据缺口明确列为待核验，不执行外发、付款或不可逆动作。',
  };
  const markdown = [
    '# 太原吾悦广场商圈内部分析报告',
    '',
    '## 核心判断',
    '本轮已完成内部分析框架；当前未取得充分公开证据的结论全部保留为待核验项。',
    '',
    '## 建议',
    '由商圈研究员补齐门店与客流证据后，再由负责人决定下一步。',
  ].join('\n');
  const common = {
    employeeExecution,
    webSearchFn: async () => offlineRestaurantSearch(),
    controlledWebFetchFn: async sources => offlineRestaurantFetch(sources),
    locationIntelligenceFn: async () => offlineLocationEvidence(),
    generateFn: async () => ({
      text: markdown,
      mode: 'api',
      model: 'qa-real-markdown-report-model',
      usage: { inputTokens: 31, outputTokens: 47 },
    }),
  };

  await assert.rejects(
    marshalWork(testMarshal, task, 'boss', {
      ...common,
      dataMode: 'demo',
    }),
    error => {
      assert.equal(error?.code, 'RESTAURANT_OUTPUT_CONTRACT_INVALID');
      assert.match(String(error?.message || ''), /完整v4结构化|纯Markdown/u);
      return true;
    },
  );

  await assert.rejects(
    marshalWork(testMarshal, task, 'boss', {
      ...common,
      dataMode: 'live',
    }),
    error => error?.code === 'RESTAURANT_OUTPUT_CONTRACT_INVALID',
  );
});

test('餐饮demo截断JSON不得冒充Markdown，必须修复为完整岗位结构后才采用', async () => {
  const employeeExecution = buildEmployeeExecutionProfile(102, {
    tenantId: 1,
    user: { id: 1, role: 'boss', tenant_id: 1 },
  });
  const contract = getRestaurantOutputContract(102);
  const task = {
    title: '太原吾悦广场商圈截断结构修复验收',
    type: '分析',
    requirement: '完整交付全部岗位报告，任何被截断的结构化候选都不得采用。',
  };
  const fixture = clone(contract.validFixture);
  fixture.decision_context.problem = `${task.title}：${fixture.decision_context.problem}`;
  fixture.decision_context.sources[0].source =
    '离线地图来源｜https://www.openstreetmap.org/way/7101';
  pointExecutionEvidenceAtSource(fixture, fixture.decision_context.sources[0].source);
  const truncated = [
    '{',
    `"contract_id":${JSON.stringify(contract.contractId)},`,
    `"schema_version":${JSON.stringify(contract.schemaVersion)},`,
    '"employee_idx":102,',
    `"decision_context":{"problem":${JSON.stringify(task.title)},`,
    '"sources":[{"source":"离线地图来源｜https://www.openstreetmap.org/way/7101",',
    '"note":"模型输出在这个字符串中途被max_tokens截断',
  ].join('');
  const calls = [];

  const output = await marshalWork(testMarshal, task, 'boss', {
    employeeExecution,
    dataMode: 'demo',
    webSearchFn: async () => offlineRestaurantSearch(),
    controlledWebFetchFn: async sources => offlineRestaurantFetch(sources),
    locationIntelligenceFn: async () => offlineLocationEvidence(),
    generateFn: async args => {
      calls.push(args);
      if (calls.length === 1) {
        return {
          text: truncated,
          mode: 'api',
          model: 'deepseek-v4-flash',
          usage: { inputTokens: 9132, outputTokens: 14001 },
          finishReason: 'length',
        };
      }
      return {
        text: JSON.stringify(fixture),
        mode: 'api',
        model: 'deepseek-v4-flash',
        usage: { inputTokens: 12044, outputTokens: 6137 },
        finishReason: 'stop',
      };
    },
  });

  assert.equal(calls.length, 2, '截断JSON必须进入已有repair调用，不能首轮报告优先采用');
  assert.match(calls[1].kind, /contract-repair/u);
  assert.match(calls[1].userMsg, /待修复首轮输出/u);
  assert.match(calls[1].userMsg, /被max_tokens截断/u);
  assert.equal(output.mode, 'api');
  assert.equal(output.employeeContract.valid, true);
  assert.equal(output.employeeContract.reportFirstMarkdown, false);
  assert.equal(output.employeeContract.qualityMode, 'advisory');
  assert.equal(output.employeeContract.repair.attempted, true);
  assert.equal(output.employeeContract.repair.succeeded, true);
  assert.equal(output.employeeContract.providerAttempts.length, 2);
  assert.deepEqual(
    output.employeeContract.providerAttempts.map(attempt => ({
      phase: attempt.phase,
      contractValid: attempt.contractValid,
      finishReason: attempt.finishReason,
    })),
    [
      { phase: 'acquire', contractValid: false, finishReason: 'length' },
      { phase: 'repair', contractValid: true, finishReason: 'stop' },
    ],
  );
  assert.equal(output.employeeContract.parsed.contract_id, contract.contractId);
  assert.match(output.text, /岗位完整正文/u);
  assert.deepEqual(output.usage, {
    inputTokens: 21176,
    outputTokens: 20138,
  });
});

test('#44回归：v4 JSON候选只进入JSON定向修复，不混入Markdown报告门', async () => {
  const employeeExecution = buildEmployeeExecutionProfile(101, {
    tenantId: 1,
    user: { id: 1, role: 'boss', tenant_id: 1 },
  });
  const contract = getRestaurantOutputContract(101);
  const task = {
    title: '太原吾悦广场粤菜市场机会修复链验收',
    type: '执行方案',
    requirement: '保留全部4项输入、7步方法和5项交付，只修正实时契约错误。',
  };
  const source = `${OFFLINE_RESTAURANT_SOURCE.title}｜${OFFLINE_RESTAURANT_SOURCE.url}`;
  const valid = clone(contract.validFixture);
  valid.decision_context.problem = `${task.title}：${valid.decision_context.problem}`;
  valid.decision_context.sources[0].source = source;
  pointExecutionEvidenceAtSource(valid, source);

  const invalid = clone(valid);
  const inputKeys = contract.inputKeys;
  const methodKeys = contract.methodKeys;
  invalid.input_audit[inputKeys[0]].evidence_refs = ['[来源1]'];
  invalid.input_audit[inputKeys[1]].verification.action = '后续处理该项输入';
  invalid.method_execution[methodKeys[0]].evidence_refs = ['[来源1]'];
  invalid.method_execution[methodKeys.at(-1)].next_action = '后续持续关注';

  const calls = [];
  const output = await marshalWork(testMarshal, task, 'boss', {
    employeeExecution,
    dataMode: 'demo',
    webSearchFn: async () => offlineRestaurantSearch(),
    controlledWebFetchFn: async sources => offlineRestaurantFetch(sources),
    locationIntelligenceFn: async () => offlineLocationEvidence(),
    generateFn: async args => {
      calls.push(args);
      return {
        text: JSON.stringify(calls.length === 1 ? invalid : valid),
        mode: 'api',
        model: 'deepseek-v4-flash',
        usage: { inputTokens: 12000, outputTokens: 8000 },
        finishReason: 'stop',
      };
    },
  });

  assert.equal(calls.length, 2);
  const firstErrors = output.employeeContract.providerAttempts[0].contractErrors.join('\n');
  assert.doesNotMatch(firstErrors, /Markdown|报告所需的标题|标题与分节/u);
  const repairPrompt = calls[1].userMsg;
  assert.match(repairPrompt, /evidence_refs[\s\S]*decision_context\.sources/u);
  assert.match(repairPrompt, /verification\.action[\s\S]*(?:调取|核验|采集)/u);
  assert.match(repairPrompt, /next_action[\s\S]*(?:核验|补采|测算|对比|复核)/u);
  assert.doesNotMatch(repairPrompt, /Markdown报告|Markdown标题|报告所需的标题/u);
  assert.match(repairPrompt, /最终响应必须从“\{”开始/u);
  assert.equal(output.employeeContract.valid, true);
  assert.equal(output.employeeContract.reportFirstMarkdown, false);

  const markdownCalls = [];
  const repairedMarkdown = await marshalWork(testMarshal, task, 'boss', {
    employeeExecution,
    dataMode: 'demo',
    webSearchFn: async () => offlineRestaurantSearch(),
    controlledWebFetchFn: async sources => offlineRestaurantFetch(sources),
    locationIntelligenceFn: async () => offlineLocationEvidence(),
    generateFn: async args => {
      markdownCalls.push(args);
      return {
        text: markdownCalls.length === 1
          ? '# 未完整的临时片段\n只有一个标题，不具备可交付报告结构。'
          : JSON.stringify(valid),
        mode: 'api',
        model: 'deepseek-v4-flash',
        usage: { inputTokens: 8000, outputTokens: 5000 },
        finishReason: 'stop',
      };
    },
  });
  assert.equal(markdownCalls.length, 2);
  assert.doesNotMatch(
    markdownCalls[1].userMsg,
    /Markdown报告|Markdown标题|报告所需的标题|标题与分节/u,
  );
  assert.match(markdownCalls[1].userMsg, /最终响应必须从“\{”开始/u);
  assert.equal(repairedMarkdown.employeeContract.valid, true);
  assert.equal(repairedMarkdown.employeeContract.reportFirstMarkdown, false);
});

test('demo#47同型：两份完整候选后的length截断不覆盖最新安全规范化报告', async () => {
  const employeeExecution = buildEmployeeExecutionProfile(101, {
    tenantId: 1,
    user: { id: 1, role: 'boss', tenant_id: 1 },
  });
  const contract = getRestaurantOutputContract(101);
  const task = {
    title: '太原吾悦广场粤菜机会demo报告优先验收',
    type: '分析',
    requirement: '仅生成企业内部报告，不执行外发、付款或不可逆动作。',
  };
  const source = `${OFFLINE_RESTAURANT_SOURCE.title}｜${OFFLINE_RESTAURANT_SOURCE.url}`;
  const firstComplete = clone(contract.validFixture);
  firstComplete.decision_context.problem = `${task.title}：第一份完整候选。`;
  firstComplete.decision_context.sources[0].source = source;
  pointExecutionEvidenceAtSource(firstComplete, source);
  // 引用空数组在严格契约中仍会报错，demo仅将它降为报告告警；
  // 4/7/5结构、所有work_product正文和真实API证据都完整。
  firstComplete.input_audit[contract.inputKeys[0]].evidence_refs = [];

  const latestComplete = clone(firstComplete);
  latestComplete.decision_context.problem = `${task.title}：第二份完整安全候选。`;
  const input = latestComplete.input_audit[contract.inputKeys[0]];
  input.evidence_refs = ['[来源1]'];
  input.verification.action = '核验数据';
  const method = latestComplete.method_execution[contract.methodKeys[0]];
  method.actual_execution = '已读取本轮来源并完成第一步业务分析，形成初步判断。';
  method.evidence_refs = ['[任务要求]'];
  method.next_action = '继续核验';
  const partialMethod = latestComplete.method_execution[contract.methodKeys[1]];
  partialMethod.status = 'partial';
  partialMethod.missing = '待补';
  const deliverable = latestComplete.deliverables[contract.deliverableKeys[0]];
  deliverable.summary = '第二份候选';
  deliverable.actions[0].action = '后续处理';
  deliverable.actions[0].owner = '负责';
  deliverable.actions[0].success_metric = '完成';
  const canonicalizedItem = deliverable.work_product.sections[0].items[0];
  canonicalizedItem.label = '机会定义·本轮分析项';
  canonicalizedItem.result =
    '第二份完整候选已交付可读业务分析；当前缺少样本字段，待负责岗位补采后核验。';
  canonicalizedItem.evidence_ref = '[来源1]';
  canonicalizedItem.status = 'verified';

  let calls = 0;
  const output = await marshalWork(testMarshal, task, 'boss', {
    employeeExecution,
    dataMode: 'demo',
    webSearchFn: async () => offlineRestaurantSearch(),
    controlledWebFetchFn: async sources => offlineRestaurantFetch(sources),
    locationIntelligenceFn: async () => offlineLocationEvidence(),
    generateFn: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          text: JSON.stringify(firstComplete),
          mode: 'api',
          model: 'deepseek-v4-flash',
          usage: { inputTokens: 6000, outputTokens: 2000 },
          finishReason: 'stop',
        };
      }
      if (calls === 2) {
        return {
          text: JSON.stringify(latestComplete),
          mode: 'api',
          model: 'deepseek-v4-flash',
          usage: { inputTokens: 16001, outputTokens: 7102 },
          finishReason: 'stop',
        };
      }
      return {
        text: '{"contract_id":"urn:nanowork:restaurant-output:101:',
        mode: 'api',
        model: 'deepseek-v4-flash',
        usage: { inputTokens: 19001, outputTokens: 20001 },
        finishReason: 'length',
      };
    },
  });

  assert.equal(calls, 3, '三正Token候选预算用尽后应回看第二份完整候选');
  assert.equal(output.mode, 'api');
  assert.equal(output.employeeContract.valid, true);
  assert.equal(output.employeeContract.qualityMode, 'report_first');
  assert.equal(output.employeeContract.reportFirstMarkdown, true);
  assert.equal(output.employeeContract.structuredReportFirst, true);
  assert.equal(output.employeeContract.parsed, null);
  assert.equal(output.employeeContract.hardDelivery.valid, true);
  const warnings = output.employeeContract.warnings.join('\n');
  assert.match(warnings, /evidence_refs|未回指本次来源/u);
  assert.match(warnings, /verification|next_action/u);
  assert.match(warnings, /summary|action|success_metric/u);
  assert.match(warnings, /标为partial|未完成项|阻断/u);
  assert.match(output.text, /第二份完整候选已交付可读业务分析/u);
  assert.doesNotMatch(output.text, /第一份完整候选/u);
  assert.match(output.text, /## 决策建议与置信度/u);
  assert.doesNotMatch(output.text, /^\s*\{/u);
  assert.deepEqual(output.usage, { inputTokens: 41002, outputTokens: 29103 });
  assert.equal(output.employeeContract.providerAttempts[0].contractValid, false);
  assert.equal(output.employeeContract.providerAttempts[1].contractValid, false);
  assert.equal(output.employeeContract.providerAttempts[1].finishReason, 'stop');
  assert.equal(output.employeeContract.providerAttempts[1].canonicalization.changed, true);
  assert.ok(
    output.employeeContract.providerAttempts[1].canonicalization.changes.some(
      change => change.reason === 'result_explicitly_unresolved',
    ),
  );
  assert.equal(output.employeeContract.providerAttempts[2].finishReason, 'length');
  assert.equal(output.employeeContract.providerAttempts[2].contractValid, false);
});

test('demo结构候选仍含未验证来源或未回指证据时不得报告优先放行', async () => {
  const employeeExecution = buildEmployeeExecutionProfile(101, {
    tenantId: 1,
    user: { id: 1, role: 'boss', tenant_id: 1 },
  });
  const contract = getRestaurantOutputContract(101);
  const task = {
    title: '太原吾悦广场未验证来源阻断验收',
    type: '分析',
    requirement: '仅生成内部报告。',
  };
  const candidate = clone(contract.validFixture);
  candidate.decision_context.problem = `${task.title}：${candidate.decision_context.problem}`;
  candidate.decision_context.sources[0].source =
    '伪造来源｜https://unverified.example/fake';
  pointExecutionEvidenceAtSource(candidate, '[来源1]');
  let calls = 0;

  await assert.rejects(
    marshalWork(testMarshal, task, 'boss', {
      employeeExecution,
      dataMode: 'demo',
      webSearchFn: async () => offlineRestaurantSearch(),
      controlledWebFetchFn: async sources => offlineRestaurantFetch(sources),
      locationIntelligenceFn: async () => offlineLocationEvidence(),
      generateFn: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            text: JSON.stringify(candidate),
            mode: 'api',
            model: 'deepseek-v4-flash',
            usage: { inputTokens: 15001, outputTokens: 7001 },
            finishReason: 'stop',
          };
        }
        throw Object.assign(new Error('供应商服务暂时异常'), {
          code: 'provider_upstream_error',
          status: 502,
          retryable: true,
        });
      },
    }),
    error => error?.code === 'RESTAURANT_OUTPUT_CONTRACT_INVALID'
      && /URL|来源|evidence_ref/u.test((error.contractErrors || []).join('\n')),
  );
});

test('demo后续length截断候选不得覆盖前一份完整安全结构候选', async () => {
  const employeeExecution = buildEmployeeExecutionProfile(101, {
    tenantId: 1,
    user: { id: 1, role: 'boss', tenant_id: 1 },
  });
  const contract = getRestaurantOutputContract(101);
  const task = {
    title: '太原吾悦广场完整候选保留验收',
    type: '分析',
    requirement: '仅生成内部报告。',
  };
  const complete = clone(contract.validFixture);
  complete.decision_context.problem = `${task.title}：${complete.decision_context.problem}`;
  // 硬门允许的非URL来源错误：最终仍必须拒绝，但失败证据应指向
  // 这份完整候选，不得被后续的length半截JSON覆盖。
  complete.decision_context.sources[0].source = '未验证的公开平台来源';
  pointExecutionEvidenceAtSource(complete, '[来源1]');
  let calls = 0;

  await assert.rejects(
    marshalWork(testMarshal, task, 'boss', {
      employeeExecution,
      dataMode: 'demo',
      webSearchFn: async () => offlineRestaurantSearch(),
      controlledWebFetchFn: async sources => offlineRestaurantFetch(sources),
      locationIntelligenceFn: async () => offlineLocationEvidence(),
      generateFn: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            text: '{"contract_id":',
            mode: 'api',
            model: 'deepseek-v4-flash',
            usage: { inputTokens: 5000, outputTokens: 1800 },
            finishReason: 'stop',
          };
        }
        if (calls === 2) {
          return {
            text: JSON.stringify(complete),
            mode: 'api',
            model: 'deepseek-v4-flash',
            usage: { inputTokens: 17001, outputTokens: 8301 },
            finishReason: 'stop',
          };
        }
        return {
          text: '{"contract_id":"urn:nanowork:restaurant-output:101:',
          mode: 'api',
          model: 'deepseek-v4-flash',
          usage: { inputTokens: 19001, outputTokens: 20001 },
          finishReason: 'length',
        };
      },
    }),
    error => {
      assert.equal(error?.code, 'RESTAURANT_OUTPUT_CONTRACT_INVALID');
      const errors = (error.contractErrors || []).join('\n');
      assert.match(errors, /来源|source|evidence_ref/u);
      assert.doesNotMatch(errors, /输出不是有效JSON/u);
      assert.equal(error.providerAttempts?.length, 3);
      assert.equal(error.providerAttempts?.[1]?.finishReason, 'stop');
      assert.equal(error.providerAttempts?.[2]?.finishReason, 'length');
      return true;
    },
  );
});

test('餐饮最终硬门独立于岗位契约状态阻断伪URL、越权动作、假模型与零Token', () => {
  const base = {
    text: '# 真实内部报告\n仅形成内部判断，后续由负责人核验。',
    mode: 'api',
    model: 'qa-real-delivery-model',
    usage: { inputTokens: 11, outputTokens: 19 },
    internalProfileLeakage: { detected: false },
    task: { title: '内部报告', type: '分析', requirement: '只形成内部报告。' },
    allowedSources: [],
  };
  assert.equal(restaurantEmployeeHardDeliveryDecision(base).valid, true);

  const governed = restaurantEmployeeHardDeliveryDecision({
    ...base,
    text: '# 报告\n当前不执行任何外部动作；不自动发布；不因单一指标自动调价；不把模型结果当作自动调价指令，均须由负责人另行确认。',
  });
  assert.equal(governed.valid, true);

  const forged = restaurantEmployeeHardDeliveryDecision({
    ...base,
    text: '# 报告\n根据伪造官网 https://unverified.example/fake 已得到结论。',
  });
  assert.equal(forged.valid, false);
  assert.match(forged.errors.join('；'), /未在本次输入|禁止补造/u);

  const external = restaurantEmployeeHardDeliveryDecision({
    ...base,
    text: '# 报告\n内容已经发布并自动投放，无需老板授权。',
  });
  assert.equal(external.valid, false);
  assert.match(external.errors.join('；'), /外发|付款|不可逆|授权/u);

  const blockedModel = restaurantEmployeeHardDeliveryDecision({
    ...base,
    model: 'demo-model',
  });
  assert.equal(blockedModel.valid, false);
  assert.match(blockedModel.errors.join('；'), /模型身份/u);

  const zeroTokens = restaurantEmployeeHardDeliveryDecision({
    ...base,
    usage: { inputTokens: 0, outputTokens: 19 },
  });
  assert.equal(zeroTokens.valid, false);
  assert.match(zeroTokens.errors.join('；'), /Token/u);
});

test('餐饮最终硬门阻断伪造平台身份、规避平台规则与未经授权真实上架，否定和授权语境不误杀', () => {
  const base = {
    text: '# 真实内部报告\n仅形成内部判断，后续由负责人核验。',
    mode: 'api',
    model: 'qa-real-delivery-model',
    usage: { inputTokens: 11, outputTokens: 19 },
    internalProfileLeakage: { detected: false },
    task: {
      title: '内部市场报告',
      type: '分析',
      requirement: '只形成内部报告，不外发、不付费、不执行不可逆动作。',
    },
    allowedSources: [],
  };

  for (const text of [
    '若平台不允许改品类，则用“广式蒸点专营”伪ID开展外卖暗测。',
    '建议绕过平台品类规则，使用虚假商户身份开店。',
    '验证方法：在美团或饿了么真实上架粤式套餐，观察30天自然订单。',
  ]) {
    const unsafe = restaurantEmployeeHardDeliveryDecision({ ...base, text });
    assert.equal(unsafe.valid, false, text);
    assert.match(
      unsafe.errors.join('；'),
      /伪造|虚假身份|规避平台规则|真实上架|授权/u,
      text,
    );
  }

  for (const text of [
    '禁止使用伪ID，不得绕过平台规则；本报告只登记合规数据缺口。',
    '若平台不允许改品类，则不得使用伪ID，也不得真实上架暗测。',
    '未经平台书面许可和老板执行授权，不得在美团或饿了么真实上架。',
    '仅核验平台上架规则；经平台书面许可与老板执行授权后，才可另行上架。',
    '取得平台书面许可与老板执行授权后，在美团或饿了么真实上架测试。',
  ]) {
    const governed = restaurantEmployeeHardDeliveryDecision({ ...base, text });
    assert.equal(governed.valid, true, text);
  }
});

test('餐饮平台不合规建议可确定性改写为授权沙盒或纯线下验证并留下字段级审计', () => {
  const raw = {
    decision_context: {
      problem: '只形成内部报告。',
    },
    deliverables: {
      validation: {
        result:
          '外卖暗测：在美团/饿了么上架套餐；若平台不允许改品类，则用“广式蒸点专营”伪ID。',
        governed:
          '禁止使用伪ID，不得绕过平台规则；未经授权不得真实上架。',
      },
    },
  };
  const rewritten = rewriteUnsafeRestaurantPlatformActions(raw);
  assert.equal(rewritten.changed, true);
  assert.equal(rewritten.parseError, null);
  assert.ok(rewritten.changes.length >= 2);
  assert.ok(
    rewritten.changes.every(
      (change) =>
        change.reason === 'unsafe_platform_action_rewritten' &&
        change.path === '$.deliverables.validation.result',
    ),
  );
  assert.match(
    rewritten.parsed.deliverables.validation.result,
    /平台提供的合规测试工具或沙盒|纯线下意向页或问卷/u,
  );
  assert.doesNotMatch(
    rewritten.parsed.deliverables.validation.result,
    /伪ID|绕过平台|规避平台/u,
  );
  assert.equal(
    rewritten.parsed.deliverables.validation.governed,
    raw.deliverables.validation.governed,
  );
  const postRewrite = restaurantEmployeeHardDeliveryDecision({
    text: rewritten.text,
    mode: 'api',
    model: 'qa-real-delivery-model',
    usage: { inputTokens: 11, outputTokens: 19 },
    task: { title: '内部报告', requirement: '只形成内部报告。' },
  });
  assert.equal(postRewrite.valid, true, postRewrite.errors.join('\n'));
});

test('餐饮预订/锁位/改价等不可逆动作可改写为内部验证而非整单无产出', () => {
  const rewritten = rewriteUnsafeRestaurantPlatformActions({
    decision_context: { problem: '只形成内部报告。' },
    deliverables: {
      validation: {
        result: '系统已自动订座、锁位并动态调价，随后收取定金。',
      },
    },
  });
  assert.equal(rewritten.changed, true);
  assert.match(rewritten.parsed.deliverables.validation.result, /平台提供的合规测试工具或沙盒|纯线下意向页或问卷/u);
  const decision = restaurantEmployeeHardDeliveryDecision({
    text: rewritten.text,
    mode: 'api',
    model: 'qa-real-delivery-model',
    usage: { inputTokens: 11, outputTokens: 19 },
    task: { title: '内部报告', requirement: '只形成内部报告。' },
  });
  assert.equal(decision.valid, true, decision.errors.join('\n'));
});

test('live派活保持岗位深层质检严格失败', async () => {
  const employeeExecution = buildEmployeeExecutionProfile(102, {
    tenantId: 1,
    user: { id: 1, role: 'boss', tenant_id: 1 },
  });
  const contract = getRestaurantOutputContract(102);
  const task = {
    title: '毛血旺 太原吾悦广场live质检验收',
    type: '分析',
    requirement: 'live环境必须保持完整岗位契约。',
  };
  const fixture = clone(contract.validFixture);
  fixture.decision_context.problem = `${task.title}：${fixture.decision_context.problem}`;
  fixture.decision_context.sources[0].source = '离线地图来源｜https://www.openstreetmap.org/way/7101';
  pointExecutionEvidenceAtSource(fixture, fixture.decision_context.sources[0].source);
  fixture.deliverables[contract.deliverableKeys[0]].actions[0].owner = '负责人';

  await assert.rejects(
    marshalWork(testMarshal, task, 'boss', {
      employeeExecution,
      dataMode: 'live',
      webSearchFn: async () => offlineRestaurantSearch(),
      controlledWebFetchFn: async sources => offlineRestaurantFetch(sources),
      locationIntelligenceFn: async () => offlineLocationEvidence(),
      generateFn: async () => ({
        text: JSON.stringify(fixture),
        mode: 'api',
        model: 'qa-real-live-quality-model',
        usage: { inputTokens: 12, outputTokens: 24 },
      }),
    }),
    error => error?.code === 'RESTAURANT_OUTPUT_CONTRACT_INVALID'
      && /owner/u.test((error.contractErrors || []).join('；')),
  );
});

test('餐饮demo公开研究工具未通过覆盖门时记录warning并继续真实模型报告', async () => {
  const employeeExecution = buildEmployeeExecutionProfile(102, {
    tenantId: 1,
    user: { id: 1, role: 'boss', tenant_id: 1 },
  });
  const contract = getRestaurantOutputContract(102);
  const task = {
    title: '毛血旺 太原吾悦广场demo研究超时报告',
    type: '分析',
    requirement: '研究工具覆盖不足时保留警告，不声称已执行外部动作。',
  };
  const fixture = clone(contract.validFixture);
  fixture.decision_context.problem = `${task.title}：${fixture.decision_context.problem}`;
  fixture.decision_context.sources[0].source =
    `${OFFLINE_RESTAURANT_SOURCE.title}｜${OFFLINE_RESTAURANT_SOURCE.url}`;
  pointExecutionEvidenceAtSource(fixture, fixture.decision_context.sources[0].source);

  const output = await marshalWork(testMarshal, task, 'boss', {
    employeeExecution,
    dataMode: 'demo',
    requireAgenticResearch: true,
    agenticWebResearchFn: async () => ({
      attempted: true,
      ok: false,
      candidateReady: false,
      provider: 'offline-timeout-provider',
      results: [],
      fetchCandidates: [],
      note: '离线注入的Agentic WebSearch超时',
      evidence: { externalCall: false, timeout: true, toolCalls: 1 },
    }),
    webSearchFn: async () => offlineRestaurantSearch(),
    controlledWebFetchFn: async sources => offlineRestaurantFetch(sources),
    locationIntelligenceFn: async () => offlineLocationEvidence(),
    generateFn: async () => ({
      text: JSON.stringify(fixture),
      mode: 'api',
      model: 'qa-real-research-warning-model',
      usage: { inputTokens: 18, outputTokens: 36 },
    }),
  });

  assert.equal(output.mode, 'api');
  assert.equal(output.employeeContract.valid, true);
  assert.equal(output.employeeContract.dataMode, 'demo');
  assert.match(output.employeeContract.warnings.join('；'), /公开调研覆盖不足|WebSearch超时/u);
  assert.match(output.text, /岗位完整正文/u);
});

test('真实API候选先记raw契约错误再canonicalize，单一状态矛盾无需repair且usage不丢', async () => {
  const employeeExecution = buildEmployeeExecutionProfile(101, {
    tenantId: 1,
    user: { id: 1, role: 'boss', tenant_id: 1 },
  });
  const contract = getRestaurantOutputContract(101);
  const task = {
    title: '毛血旺 太原吾悦广场餐饮契约状态收敛回归',
    type: '分析',
    requirement: '围绕毛血旺 太原吾悦广场只验证单一已明确未闭环状态，不执行外部动作。',
  };
  const candidate = clone(contract.validFixture);
  candidate.decision_context.problem = `${task.title}：${candidate.decision_context.problem}`;
  candidate.decision_context.sources[0].source = '离线地图来源｜https://www.openstreetmap.org/way/7101';
  pointExecutionEvidenceAtSource(candidate, candidate.decision_context.sources[0].source);
  const target = collectWorkProductItems(candidate)[0];
  const unresolvedResult = '待补证：当前缺少一项已授权原料记录，需由门店负责人核验后再闭环。';
  target.result = unresolvedResult;
  target.status = 'verified';
  const raw = JSON.stringify(candidate);
  const providerUsage = { inputTokens: 17, outputTokens: 23 };
  let providerCalls = 0;

  const output = await marshalWork(testMarshal, task, 'boss', {
    employeeExecution,
    webSearchFn: async () => offlineRestaurantSearch(),
    controlledWebFetchFn: async sources => offlineRestaurantFetch(sources),
    locationIntelligenceFn: async () => offlineLocationEvidence(),
    generateFn: async () => {
      providerCalls += 1;
      return {
        text: raw,
        mode: 'api',
        model: 'qa-real-contract-canonicalization-model',
        usage: providerUsage,
      };
    },
  });

  assert.equal(providerCalls, 1, 'canonicalization通过后不得额外消耗repair调用');
  assert.equal(output.mode, 'api');
  assert.equal(output.employeeContract.valid, true);
  assert.deepEqual(output.usage, providerUsage, '候选usage必须保留在最终结果');
  assert.equal(output.employeeContract.providerAttempts.length, 1);
  const attempt = output.employeeContract.providerAttempts[0];
  assert.equal(attempt.phase, 'acquire');
  assert.equal(attempt.rawContractValid, false);
  assert.ok(attempt.rawContractErrors.length > 0);
  assert.equal(attempt.contractValid, true);
  assert.deepEqual(attempt.usage, providerUsage);
  assert.equal(attempt.canonicalization.changed, true);
  assert.equal(attempt.canonicalization.rawContractValid, false);
  assert.equal(attempt.canonicalization.contractValidAfterCanonicalization, true);
  assert.equal(attempt.canonicalization.changes.length, 1);
  assert.equal(output.employeeContract.parsed.deliverables[contract.deliverableKeys[0]]
    .work_product.sections[0].items[0].status, 'gap');
  assert.equal(output.employeeContract.parsed.deliverables[contract.deliverableKeys[0]]
    .work_product.sections[0].items[0].result, unresolvedResult,
  '最终正文只能保留供应商原文，canonicalize不得改写事实');
});

test('直接派活拒绝模型的不合格JSON，模板模式只保留未完成底稿', async () => {
  const employeeExecution = buildEmployeeExecutionProfile(101, {
    tenantId: 1,
    user: { id: 1, role: 'boss', tenant_id: 1 },
  });
  await assert.rejects(
    marshalWork(testMarshal, {
      title: '毛血旺 太原吾悦广场非法输出验收',
      type: '分析',
      requirement: '围绕毛血旺 太原吾悦广场执行专项测试。',
    }, 'boss', {
      employeeExecution,
      webSearchFn: async () => offlineRestaurantSearch(),
      controlledWebFetchFn: async sources => offlineRestaurantFetch(sources),
      locationIntelligenceFn: async () => offlineLocationEvidence(),
      generateFn: async () => ({
        text: '{"contract_id":"伪造"}',
        mode: 'api',
        model: 'qa-real-contract-model',
        usage: {},
      }),
    }),
    error => error?.code === 'RESTAURANT_OUTPUT_CONTRACT_INVALID'
      && Array.isArray(error.contractErrors)
      && error.contractErrors.length > 0,
  );

  const fallback = await marshalWork(testMarshal, {
    title: '毛血旺 太原吾悦广场无模型底稿',
    type: '分析',
    requirement: '围绕毛血旺 太原吾悦广场执行专项测试。',
  }, 'boss', {
    employeeExecution,
    webSearchFn: async () => offlineRestaurantSearch(),
    controlledWebFetchFn: async sources => offlineRestaurantFetch(sources),
    locationIntelligenceFn: async () => offlineLocationEvidence(),
    generateFn: async args => ({
      text: args.fallback(),
      mode: 'template',
      model: null,
      usage: {},
    }),
  });
  assert.equal(fallback.employeeContract.valid, false);
  assert.equal(fallback.employeeContract.skipped, 'template_mode');
  assert.deepEqual(fallback.employeeContract.artifacts, []);
  assert.equal(fallback.text, '', '供应商不可用时不得返回看似业务交付的模板底稿');
  assert.equal(fallback.transparentFallback, true);
});

// ===== 2026-08-07 重建：以下两条覆盖第九轮丢失版本中有名可查的运行时不变量 =====
// （原 2000+ 行版本因误操作丢失；被测引擎完好。此处按原测试名重建等价断言，
//   夹具为新写，覆盖同一批拒绝语义：占位、凑数、空泛、脱靶。）

test('61岗供应商response_schema为严格模式且携带可自证验收语义', () => {
  const catalog = loadRestaurantCatalog();
  for (const employee of catalog.employees) {
    const contract = getRestaurantOutputContract(employee.idx);
    const provider = contract.providerSchema;
    assert.equal(provider.type, 'object', `员工${employee.idx} providerSchema 根必须是 object`);
    assert.equal(provider.additionalProperties, false, `员工${employee.idx} 必须禁止未知字段`);
    assert.ok(Array.isArray(provider.required) && provider.required.length > 0,
      `员工${employee.idx} 必须声明必填字段`);
    // 契约指令必须解释状态与验收语义，让模型产出可自证
    assert.ok(contract.instruction.length > 100, `员工${employee.idx} 契约指令必须完整`);
    assert.match(contract.instruction, /(机器输出契约|JSON)/u);
    assert.ok(contract.contractId && contract.primaryArtifact,
      `员工${employee.idx} 契约ID与主产物不能为空`);
  }
});

test('61岗运行时统一拒绝占位文本、重复凑数与脱离本次任务的产出', () => {
  const catalog = loadRestaurantCatalog();
  const sampled = catalog.employees.filter(employee => [101, 117, 141, 161].includes(employee.idx));
  for (const employee of sampled) {
    const contract = getRestaurantOutputContract(employee.idx);
    const title = '专项验证任务';
    // 1) 占位文本：把合法夹具的一个文本字段污染为“待填写”
    const placeholderFixture = structuredClone(contract.validFixture);
    const json = JSON.stringify(placeholderFixture).replace(/"([^"]{14,}?)"/u, '"待填写：请替换为实际内容"');
    const placeholderResult = validateRestaurantEmployeeOutputContract(
      employee.idx, json, { title },
    );
    assert.equal(placeholderResult.valid, false, `员工${employee.idx} 必须拒绝占位文本`);
    // 2) 脱靶：problem 未提及本次任务标题
    const offTopic = structuredClone(contract.validFixture);
    const offTopicResult = validateRestaurantEmployeeOutputContract(
      employee.idx, JSON.stringify(offTopic), { title: '一个绝不出现在夹具里的任务标题XYZQ' },
    );
    assert.equal(offTopicResult.valid, false, `员工${employee.idx} 必须拒绝与本次任务无关的产出`);
  }
});

test('161 巡店督导契约要求 nanowork-inspection 归档且岗位手册包含评分与整改语义', () => {
  const contract = getRestaurantOutputContract(161);
  assert.equal(contract.employeeIdx, 161);
  const catalog = loadRestaurantCatalog();
  const supervisor = catalog.employees.find(employee => employee.idx === 161);
  assert.equal(supervisor.person, '查巡巡');
  assert.match(supervisor.md, /nanowork-inspection/u);
  assert.match(supervisor.md, /subScores/u);
  assert.match(supervisor.md, /整改/u);
  assert.ok(supervisor.safetyBoundaries.some(item => item.includes('不做处罚')),
    '督导安全边界必须声明不做人事处罚决定');
});
