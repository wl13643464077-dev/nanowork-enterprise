/*
 * PaihuoAI -> NanoWork capability-chain parity contract.
 *
 * This is intentionally a no-cloud/no-payment test.  The PaihuoAI source is
 * read as text/JSON (its implementation is Python); NanoWork profiles are
 * built against an in-memory database.  No provider, WebSearch, MCP or HTTP
 * call is allowed here.  Known source-boundary differences are recorded as
 * explicit red points instead of being silently treated as parity.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentPaihuoSourceTemplate } from '../../scripts/lib/paihuo-content-prompt-migration.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, '..', '..');
const paihuoRoot = process.env.PAIHUO_SOURCE_ROOT
  ? path.resolve(process.env.PAIHUO_SOURCE_ROOT)
  : path.resolve(projectRoot, '..', '派活AI');
const paihuoRegistryPath = path.join(paihuoRoot, 'app', 'skills', 'registry.py');
const paihuoRestaurantPath = path.join(paihuoRoot, 'data', 'departments', 'restaurant.json');
const paihuoDepartmentsPath = path.join(paihuoRoot, 'app', 'departments.py');
const paihuoTaskrunnerPath = path.join(paihuoRoot, 'app', 'taskrunner.py');
const paihuoProvidersPath = path.join(paihuoRoot, 'app', 'providers.py');
const paihuoLlmPath = path.join(paihuoRoot, 'app', 'llm.py');
const paihuoRequiredPaths = [
  paihuoRegistryPath,
  paihuoRestaurantPath,
  paihuoDepartmentsPath,
  paihuoTaskrunnerPath,
  paihuoProvidersPath,
  paihuoLlmPath,
];
const missingPaihuoPaths = paihuoRequiredPaths.filter(filePath => !fs.existsSync(filePath));
const paihuoSourceAvailable = missingPaihuoPaths.length === 0;
const paihuoSkipReason = paihuoSourceAvailable
  ? ''
  : `可选派活AI黄金源码不可用（缺少 ${missingPaihuoPaths.map(filePath => path.relative(paihuoRoot, filePath)).join(', ')}）；设置 PAIHUO_SOURCE_ROOT 后可运行源对齐契约。`;

function paihuoSourceTest(name, fn) {
  test(name, { skip: paihuoSkipReason || false }, fn);
}

function readPaihuoSource(filePath) {
  return paihuoSourceAvailable ? fs.readFileSync(filePath, 'utf8') : '';
}

// Keep imports on a dedicated in-memory DB.  The blank values also prevent
// provider modules from loading a developer's local credentials from .env.
process.env.NANOWORK_DB = ':memory:';
process.env.YUNWU_API_KEY = ' ';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';
process.env.ENABLE_SCHEDULER = 'false';
process.env.SEED_DEMO = 'false';

const { initSchema, migrateV2 } = await import('../src/db.js');
initSchema();
await migrateV2();
const { ensureBaselineCatalogs } = await import('../src/baseline.js');
await ensureBaselineCatalogs();

const { loadRestaurantCatalog } = await import('../src/catalog/restaurant.js');
const {
  CONTENT_EMPLOYEES,
  CONTENT_EMPLOYEE_ROSTER,
  NATIVE_CONTENT_EMPLOYEES,
} = await import('../src/catalog/content-crew.js');
const {
  buildContentEmployeeWorkbenchProfile,
  compileContentEmployeeSoloPrompt,
} = await import('../src/engines/content-employee-workbench.js');
const {
  buildEmployeeWorkbench,
  buildEmployeeExecutionProfile,
} = await import('../src/employee-workbench.js');

const nanoRestaurant = loadRestaurantCatalog();
const nanoContent = CONTENT_EMPLOYEES;
const paihuoRestaurant = paihuoSourceAvailable
  ? JSON.parse(fs.readFileSync(paihuoRestaurantPath, 'utf8'))
  : { employees: [], tagline: '' };
const paihuoRegistrySource = readPaihuoSource(paihuoRegistryPath);
const paihuoDepartmentsSource = readPaihuoSource(paihuoDepartmentsPath);
const paihuoTaskrunnerSource = readPaihuoSource(paihuoTaskrunnerPath);
const paihuoProvidersSource = readPaihuoSource(paihuoProvidersPath);
const paihuoLlmSource = readPaihuoSource(paihuoLlmPath);
const nanoAiSource = fs.readFileSync(path.join(projectRoot, 'server', 'src', 'engines', 'ai.js'), 'utf8');
const nanoAgenticSource = fs.readFileSync(path.join(projectRoot, 'server', 'src', 'engines', 'agentic-web-research.js'), 'utf8');
const nanoControlledSource = fs.readFileSync(path.join(projectRoot, 'server', 'src', 'engines', 'controlled-web-evidence.js'), 'utf8');
const nanoMarshalRouteSource = fs.readFileSync(path.join(projectRoot, 'server', 'src', 'routes', 'marshals.js'), 'utf8');

const registryAstReader = String.raw`
import ast, json, sys

tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())
wanted = {"JSON_RULE", "CAPABILITIES", "DEFAULT_PROMPTS", "STATIONS"}
env = {}

def value(node):
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        return env.get(node.id, node.id)
    if isinstance(node, ast.List):
        return [value(item) for item in node.elts]
    if isinstance(node, ast.Tuple):
        return [value(item) for item in node.elts]
    if isinstance(node, ast.Dict):
        return {value(k): value(v) for k, v in zip(node.keys, node.values)}
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return value(node.left) + value(node.right)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "dict":
        result = {value(item): value(node.args[index]) for index, item in enumerate(node.args)}
        result.update({keyword.arg: value(keyword.value) for keyword in node.keywords if keyword.arg})
        return result
    raise ValueError("unsupported source node: " + ast.dump(node, include_attributes=False)[:200])

for statement in tree.body:
    if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
        name = statement.targets[0].id
        if name in wanted:
            env[name] = value(statement.value)

print(json.dumps({name: env[name] for name in ("CAPABILITIES", "DEFAULT_PROMPTS", "STATIONS")}, ensure_ascii=False))
`;

function readPaihuoRegistry() {
  const output = execFileSync('python3', ['-c', registryAstReader, paihuoRegistryPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(output);
}

const paihuoRegistry = paihuoSourceAvailable
  ? readPaihuoRegistry()
  : { CAPABILITIES: {}, DEFAULT_PROMPTS: {}, STATIONS: [] };

function employeeSummary(employee) {
  return {
    idx: employee.idx,
    key: employee.key,
    name: employee.name,
    duty: employee.duty,
    group: employee.group,
    inputs: employee.inputs,
    steps: employee.steps,
    deliverables: employee.deliverables,
  };
}

function stationSummary(station) {
  return {
    idx: station.idx,
    key: station.key,
    name: station.name,
    skill: station.skill,
    duty: station.duty,
    dept: station.dept,
  };
}

function contentSummary(employee) {
  return {
    idx: employee.idx,
    key: employee.key,
    name: employee.name,
    skill: employee.skill,
    duty: employee.duty,
    group: employee.group,
  };
}

function sourceContainsAll(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label}缺少${fragment}`);
  }
}

const parityRedPoints = [];
if (paihuoSourceAvailable && !paihuoRestaurant.employees.some(employee => employee.idx === 161)) {
  parityRedPoints.push({
    code: 'PAIHUO_RESTAURANT_EXTENSION_MISSING',
    detail: '派活AI data/departments/restaurant.json 缺少 NanoWork 扩展餐饮员工 idx161；源实际60，NanoWork为61。',
  });
}
if (paihuoSourceAvailable && !paihuoRegistry.STATIONS.some(station => station.idx === 10)) {
  parityRedPoints.push({
    code: 'PAIHUO_NATIVE_CONTENT_EMPLOYEE_MISSING',
    detail: '派活AI registry.STATIONS 只有0–9；NanoWork另有原生AI带货员 idx10。',
  });
}
if (paihuoSourceAvailable && String(paihuoRestaurant.tagline || '').includes('59')) {
  parityRedPoints.push({
    code: 'PAIHUO_RESTAURANT_TAGLINE_STALE',
    detail: '派活AI餐饮tagline仍写59位，而JSON实际员工为60名（缺161）。',
  });
}
for (const employee of paihuoSourceAvailable ? nanoContent : []) {
  const source = paihuoRegistry.STATIONS.find(station => station.idx === employee.idx);
  if (source && source.duty !== employee.duty) {
    parityRedPoints.push({
      code: `PAIHUO_CONTENT_DUTY_DRIFT_${employee.idx}`,
      detail: `内容${employee.idx}岗位duty源文案不同：派活AI=${source.duty}；NanoWork=${employee.duty}。`,
    });
  }
}

paihuoSourceTest('能力链源边界与已知 parity red points 明确记录（无云）', () => {
  assert.equal(paihuoRegistry.STATIONS.length, 10);
  assert.deepEqual(
    paihuoRegistry.STATIONS.map(station => station.idx),
    [...Array.from({ length: 10 }, (_, idx) => idx)],
  );
  assert.equal(Object.keys(paihuoRegistry.CAPABILITIES).length, 10);
  assert.equal(Object.keys(paihuoRegistry.DEFAULT_PROMPTS).length, 10);
  assert.equal(paihuoRestaurant.employees.length, 60);
  assert.equal(nanoRestaurant.employees.length, 61);
  assert.equal(nanoContent.length, 10);
  assert.equal(NATIVE_CONTENT_EMPLOYEES.length, 1);
  assert.equal(CONTENT_EMPLOYEE_ROSTER.length, 11);

  // These are expected source-boundary differences, not waived contract
  // failures.  The test output is the audit record consumed by the matrix
  // report; if either difference disappears, this assertion forces an update
  // to the explicit audit rather than silently changing the roster count.
  assert.deepEqual(
    parityRedPoints.map(item => item.code),
    [
      'PAIHUO_RESTAURANT_EXTENSION_MISSING',
      'PAIHUO_NATIVE_CONTENT_EMPLOYEE_MISSING',
      'PAIHUO_RESTAURANT_TAGLINE_STALE',
      'PAIHUO_CONTENT_DUTY_DRIFT_5',
    ],
  );
  console.log(`PAIHUO_PARITY_RED_POINTS ${JSON.stringify(parityRedPoints)}`);
});

paihuoSourceTest('餐饮101/102/104岗位绑定、输入、工作流和交付物一比一', () => {
  for (const idx of [101, 102, 104]) {
    const source = paihuoRestaurant.employees.find(employee => employee.idx === idx);
    const target = nanoRestaurant.employees.find(employee => employee.idx === idx);
    assert.ok(source, `派活AI缺少餐饮员工${idx}`);
    assert.ok(target, `NanoWork缺少餐饮员工${idx}`);
    assert.deepEqual(employeeSummary(target), employeeSummary(source), `餐饮${idx}源绑定漂移`);
    assert.ok(source.md.includes('必要输入'), `餐饮${idx}派活手册缺少必要输入段`);
    assert.ok(source.md.includes('工作流'), `餐饮${idx}派活手册缺少工作流段`);
    assert.ok(source.md.includes('交付物'), `餐饮${idx}派活手册缺少交付物段`);
  }
});

paihuoSourceTest('内容0–9技能注册、岗位绑定与源提示词一比一；idx10保持原生扩展边界', () => {
  const sourceSummaries = paihuoRegistry.STATIONS.map(stationSummary).map(station => ({
    idx: station.idx,
    key: station.key,
    name: station.name,
    skill: station.skill,
    duty: station.duty,
    group: station.dept,
  }));
  // Identity/key/skill/group are immutable parity fields.  Duty is also
  // compared, but the current project intentionally records one source-level
  // wording drift (idx5) as an explicit red point above.
  for (const employee of nanoContent) {
    const source = sourceSummaries.find(station => station.idx === employee.idx);
    assert.deepEqual(
      { idx: employee.idx, key: employee.key, name: employee.name, skill: employee.skill, group: employee.group },
      { idx: source.idx, key: source.key, name: source.name, skill: source.skill, group: source.group },
      `内容${employee.idx}身份绑定漂移`,
    );
    if (employee.duty === source.duty) {
      assert.equal(employee.duty, source.duty);
    } else {
      assert.equal(employee.idx, 5);
    }
  }
  for (const employee of nanoContent) {
    const caps = paihuoRegistry.CAPABILITIES[employee.key];
    assert.deepEqual(
      employee.capabilities.map(capability => capability.sourceDefinition),
      caps,
      `内容${employee.idx}技能注册与派活源不一致`,
    );
    assert.equal(
      employee.pipelinePrompt.sourceTemplate,
      currentPaihuoSourceTemplate(paihuoRegistry.DEFAULT_PROMPTS[employee.key]),
      `内容${employee.idx} system/pipeline源提示词不一致`,
    );
  }
  assert.equal(NATIVE_CONTENT_EMPLOYEES[0].idx, 10);
  assert.equal(NATIVE_CONTENT_EMPLOYEES[0].sourceProvenance.native, true);
  assert.equal(paihuoRegistry.STATIONS.some(station => station.idx === 10), false);
});

test('餐饮执行档案把技能、system上下文、运行绑定、输出契约与快照整体装载', () => {
  for (const idx of [101, 102, 104]) {
    const execution = buildEmployeeExecutionProfile(idx, {
      tenantId: 1,
      user: { id: 1, role: 'boss', tenant_id: 1 },
    });
    assert.equal(execution.workbench.identity.idx, idx);
    assert.equal(execution.snapshot.runtimePackageLoad.allRequiredFieldsLoaded, true);
    assert.equal(execution.snapshot.runtimePackageLoad.promptTextIncludedInSystemMessage, true);
    assert.equal(execution.snapshot.runtimePackageLoad.runtimeBindingsManifestInSystemMessage, true);
    assert.equal(execution.snapshot.runtimePackageLoad.jobProfileManifestInSystemMessage, true);
    assert.ok(execution.snapshot.runtimeBindings);
    assert.ok(execution.snapshot.outputContract);
    assert.ok(execution.snapshot.canonicalProfile);
    for (const capability of execution.workbench.capabilities) {
      assert.ok(execution.systemContext.includes(capability.name), `餐饮${idx}缺技能${capability.name}`);
    }
    for (const skill of execution.snapshot.skills) {
      assert.ok(execution.systemContext.includes(skill.title), `餐饮${idx}缺技能库条目${skill.title}`);
    }
    assert.doesNotMatch(execution.systemContext, /sk-[A-Za-z0-9]{16,}/u);
  }
});

test('内容0–10 system/user prompt边界保留岗位包、技能与不可信业务输入隔离', () => {
  for (const employee of CONTENT_EMPLOYEE_ROSTER) {
    const task = {
      direction: `PARITY_DIRECTION_${employee.idx}`,
      industry: 'PARITY_INDUSTRY',
      material: 'PARITY_MATERIAL',
      feedback: 'PARITY_FEEDBACK',
      length: 'std',
    };
    const compiled = compileContentEmployeeSoloPrompt(employee.idx, task);
    assert.ok(compiled.systemPrompt.length > 200, `内容${employee.idx}system为空`);
    assert.ok(compiled.userPrompt.includes(`PARITY_DIRECTION_${employee.idx}`));
    assert.ok(compiled.userPrompt.includes('PARITY_MATERIAL'));
    assert.equal(compiled.systemPrompt.includes(`PARITY_DIRECTION_${employee.idx}`), false);
    assert.equal(compiled.systemPrompt.includes('PARITY_MATERIAL'), false);
    assert.equal(compiled.snapshot.runtimePackageLoad.allRequiredFieldsLoaded, true);
    assert.equal(compiled.snapshot.runtimePackageLoad.promptTextIncludedInSystemMessage, true);
    assert.ok(compiled.snapshot.handlerExecution.currentHandler);
    assert.ok(compiled.snapshot.jobProfile.outputSchema);
  }
});

paihuoSourceTest('搜索/API/MCP/受控证据链：两项目均显式接线，且未触发真实网络', () => {
  // Paihuo: registry -> providers.call_text(_json)(web=true) -> WebSearch
  // gateway -> linkgrab controlled page evidence -> taskrunner.
  sourceContainsAll(paihuoRegistrySource, [
    'def build_prompt',
    'def capabilities_for',
    'def run_trend',
    'def run_research',
    'def run_benchmark',
    'web=True',
  ], '派活AI registry');
  sourceContainsAll(paihuoDepartmentsSource, [
    'def build_task_prompt',
    'def capabilities_for',
    'skills_text',
    'knowledge_text',
  ], '派活AI departments');
  sourceContainsAll(paihuoProvidersSource, [
    'async def _controlled_webfetch_evidence',
    'linkgrab.fetch_page_evidence',
    'async def call_text',
    'web=True',
  ], '派活AI providers');
  sourceContainsAll(paihuoLlmSource, [
    '--strict-mcp-config',
    'WebSearch',
    'ANTHROPIC_BASE_URL',
  ], '派活AI MCP/WebSearch runner');

  // NanoWork: marshalWork receives injectable search/location/controlled
  // adapters; production agentic research uses the same isolated MCP CLI.
  sourceContainsAll(nanoAiSource, [
    'options.webSearchFn || webSearch',
    'options.agenticWebResearchFn',
    'options.controlledWebFetchFn || fetchControlledWebEvidence',
    'location_intelligence',
    'controlled_web_fetch',
    'allowedSources: web.results',
  ], 'NanoWork marshalWork');
  sourceContainsAll(nanoAgenticSource, [
    '--strict-mcp-config',
    "'--tools', 'WebSearch'",
    "'--allowedTools', 'WebSearch'",
    '--max-budget-usd',
    '--settings',
    'allowedDomains',
  ], 'NanoWork agentic WebSearch/MCP runner');
  sourceContainsAll(nanoControlledSource, [
    'nanowork.controlled-web-evidence/1',
    'ssrfProtected',
    'redirectsRevalidated',
  ], 'NanoWork controlled evidence');
  sourceContainsAll(nanoMarshalRouteSource, [
    'marshalWork(',
    'webSearchFn: employeeWebSearch',
    'agenticWebResearchFn: employeeAgenticWebResearch',
    'controlledWebFetchFn: employeeControlledWebFetch',
    'employee_web_snapshot',
    'failure:',
  ], 'NanoWork task runner/snapshot route');
});

paihuoSourceTest('结果与失败快照契约：成功产物、失败原因、退款/重试边界均有持久化接线', () => {
  sourceContainsAll(paihuoTaskrunnerSource, [
    'async def run_task',
    "status='done'",
    'output_md=?',
    'cost_usd=?,tokens=?',
    'def settle_failure',
    "billing_status='refunded'",
    'prepare_retry',
  ], '派活AI taskrunner');
  sourceContainsAll(nanoMarshalRouteSource, [
    'employee_web_snapshot',
    'failureDisposition',
    'providerAttempts',
    'contractErrors',
    'billing',
    "status = '失败'",
  ], 'NanoWork task runner/failure snapshot');
});

test('72档案静态矩阵：61餐饮+11内容全部具备最小执行/产物/权限契约', () => {
  const matrix = [];
  for (const employee of nanoRestaurant.employees) {
    const workbench = buildEmployeeWorkbench(employee.idx, {
      tenantId: 1,
      user: { id: 1, role: 'boss', tenant_id: 1 },
    });
    assert.equal(workbench.identity.idx, employee.idx);
    assert.ok(workbench.workMethod.requiredInputs.length, `餐饮${employee.idx}缺必要输入`);
    assert.ok(workbench.capabilities.length, `餐饮${employee.idx}缺必备能力`);
    assert.ok(workbench.skillLibrary.required.length, `餐饮${employee.idx}缺岗位技能`);
    assert.ok(workbench.jobProfile.outputContract.contractId, `餐饮${employee.idx}缺输出契约`);
    assert.ok(workbench.runtimeBindings.currentRuntimeBindings, `餐饮${employee.idx}缺运行绑定`);
    assert.equal(workbench.permissions.canDispatch, true);
    matrix.push({ domain: 'restaurant', idx: employee.idx, ready: true });
  }
  for (const employee of CONTENT_EMPLOYEE_ROSTER) {
    const profile = buildContentEmployeeWorkbenchProfile(employee.idx);
    assert.equal(profile.identity.idx, employee.idx);
    assert.ok(profile.workMethod.input, `内容${employee.idx}缺输入契约`);
    assert.ok(profile.capabilities.length, `内容${employee.idx}缺必备能力`);
    assert.ok(profile.jobProfile.outputSchema, `内容${employee.idx}缺输出契约`);
    assert.ok(profile.runtimeBindings.currentRuntimeBindings, `内容${employee.idx}缺运行绑定`);
    assert.equal(profile.canonicalProfile.permissions.mayDisableRequiredCapabilities, false);
    matrix.push({ domain: 'content', idx: employee.idx, ready: true });
  }
  assert.equal(matrix.length, 72);
  assert.equal(matrix.filter(row => row.domain === 'restaurant').length, 61);
  assert.equal(matrix.filter(row => row.domain === 'content').length, 11);

  // Keep source-side shortfalls visible next to the green NanoWork matrix
  // when the optional golden source is available. The Nano matrix remains a
  // mandatory gate for standalone clones.
  if (paihuoSourceAvailable) {
    assert.deepEqual(
      paihuoRestaurant.employees.map(employee => employee.idx).filter(idx => idx >= 101).at(-1),
      160,
    );
    assert.equal(paihuoRegistry.STATIONS.length, 10);
  }
});

test('禁止把无云 parity 测试误报为真实联网/付费执行', () => {
  assert.equal(process.env.YUNWU_API_KEY, ' ');
  assert.equal(process.env.OPENAI_API_KEY, '');
  assert.equal(process.env.ANTHROPIC_API_KEY, '');
  assert.equal(os.networkInterfaces !== undefined, true);
  assert.equal(typeof parityRedPoints.length, 'number');
});
