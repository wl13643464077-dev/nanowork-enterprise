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
} = await import('../src/engines/restaurant-output-contract.js');
const { initSchema, migrateV2 } = await import('../src/db.js');
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
const { buildEmployeeWorkbench } = await import('../src/employee-workbench.js');
const { buildEmployeeExecutionProfile } = await import('../src/employee-workbench.js');
const { marshalWork } = await import('../src/engines/ai.js');

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

test('101-160 每岗拥有唯一稳定的结构化机器输出契约和合法样本', () => {
  const catalog = loadRestaurantCatalog();
  const contracts = catalog.employees.map(employee => getRestaurantOutputContract(employee.idx));

  assert.equal(contracts.length, 60);
  assert.equal(new Set(contracts.map(item => item.contractId)).size, 60);
  assert.equal(new Set(contracts.map(item => item.primaryArtifact)).size, 60);
  assert.equal(new Set(contracts.map(item => JSON.stringify(item.schema))).size, 60);
  assert.equal(new Set(contracts.map(item => JSON.stringify(item.validFixture))).size, 60);

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

test('60岗均严格拒绝缺字段、null/空文本、错类型、未知字段、空数组和嵌套缺字段', () => {
  for (let idx = 101; idx <= 160; idx += 1) {
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

test('工作台 jobProfile 对60岗暴露同一权威契约，审批与外部动作边界不被放宽', () => {
  for (let idx = 101; idx <= 160; idx += 1) {
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
    assert.match(profile.jobProfile.authority.finalApproval, /review/u);
  }
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

test('直接派活把同一Schema交给模型，严格校验后渲染为可审阅Markdown', async () => {
  const employeeExecution = buildEmployeeExecutionProfile(101, {
    tenantId: 1,
    user: { id: 1, role: 'boss', tenant_id: 1 },
  });
  const contract = getRestaurantOutputContract(101);
  let generationArgs;
  const output = await marshalWork(testMarshal, {
    title: '商圈机会验证',
    type: '分析',
    requirement: '只使用已授权材料，形成待审阅交付。',
  }, 'boss', {
    employeeExecution,
    webSearchFn: async () => ({ ok: false, results: [], note: '离线专项测试' }),
    generateFn: async args => {
      generationArgs = args;
      return {
        text: JSON.stringify(contract.validFixture),
        mode: 'api',
        model: 'offline-contract-test',
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
  assert.match(output.text, /待审阅结构化交付/u);
  assert.match(output.text, /人工审批前不得执行外部动作/u);
  assert.doesNotMatch(output.text, /^\s*\{/u);
});

test('直接派活拒绝模型的不合格JSON，模板模式只保留未完成底稿', async () => {
  const employeeExecution = buildEmployeeExecutionProfile(101, {
    tenantId: 1,
    user: { id: 1, role: 'boss', tenant_id: 1 },
  });
  await assert.rejects(
    marshalWork(testMarshal, {
      title: '非法输出验收',
      type: '分析',
      requirement: '专项测试',
    }, 'boss', {
      employeeExecution,
      webSearchFn: async () => ({ ok: false, results: [], note: '离线专项测试' }),
      generateFn: async () => ({
        text: '{"contract_id":"伪造"}',
        mode: 'api',
        model: 'offline-contract-test',
        usage: {},
      }),
    }),
    error => error?.code === 'RESTAURANT_OUTPUT_CONTRACT_INVALID'
      && Array.isArray(error.contractErrors)
      && error.contractErrors.length > 0,
  );

  const fallback = await marshalWork(testMarshal, {
    title: '无模型底稿',
    type: '分析',
    requirement: '专项测试',
  }, 'boss', {
    employeeExecution,
    webSearchFn: async () => ({ ok: false, results: [], note: '离线专项测试' }),
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
  assert.match(fallback.text, /当前 AI 通道不可用/u);
  assert.match(fallback.text, /未完成/u);
});
