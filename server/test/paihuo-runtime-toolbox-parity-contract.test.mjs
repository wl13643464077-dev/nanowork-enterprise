/*
 * PaihuoAI -> NanoWork content-runtime + toolbox parity contract.
 *
 * This test is deliberately no-cloud/no-payment.  The PaihuoAI Python source
 * and registry are read at test time; NanoWork's handlers are exercised only
 * with an injected in-memory generator.  Any missing production capability is
 * kept as an explicit red gate (rather than being converted to a fake pass).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Never let this audit inherit a developer credential or a background worker.
process.env.NANOWORK_DB = ':memory:';
process.env.YUNWU_API_KEY = ' ';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';
process.env.ENABLE_SCHEDULER = 'false';
process.env.SEED_DEMO = 'false';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, '..', '..');
const paihuoRoot = process.env.PAIHUO_SOURCE_ROOT
  ? path.resolve(process.env.PAIHUO_SOURCE_ROOT)
  : path.resolve(projectRoot, '..', '派活AI');
const paihuoRequiredPaths = [
  'app/skills/registry.py',
  'app/main.py',
  'app/providers.py',
  'app/llm.py',
].map(relativePath => path.join(paihuoRoot, relativePath));
const missingPaihuoPaths = paihuoRequiredPaths.filter(filePath => !fs.existsSync(filePath));
const paihuoSourceAvailable = missingPaihuoPaths.length === 0;
const paihuoSkipReason = paihuoSourceAvailable
  ? ''
  : `可选派活AI黄金源码不可用（缺少 ${missingPaihuoPaths.map(filePath => path.relative(paihuoRoot, filePath)).join(', ')}）；设置 PAIHUO_SOURCE_ROOT 后可运行源对齐契约。`;

function paihuoSourceTest(name, fn) {
  test(name, { skip: paihuoSkipReason || false }, fn);
}

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function readPaihuo(relativePath) {
  return paihuoSourceAvailable
    ? fs.readFileSync(path.join(paihuoRoot, relativePath), 'utf8')
    : '';
}

const paihuoRegistrySource = readPaihuo('app/skills/registry.py');
const paihuoMainSource = readPaihuo('app/main.py');
const paihuoProvidersSource = readPaihuo('app/providers.py');
const paihuoLlmSource = readPaihuo('app/llm.py');
const nanoAdapterSource = read('server/src/engines/content-handler-adapters.js');
const nanoPipelineSource = read('server/src/engines/content-production-pipeline.js');
const nanoPipelineRouteSource = read('server/src/routes/content-production-pipeline.js');
const nanoToolboxEngineSource = read('server/src/engines/toolbox.js');
const nanoToolboxRunnerSource = read('server/src/engines/toolbox-job-runner.js');
const nanoToolboxRouteSource = read('server/src/routes/toolbox.js');
const nanoTaskCenterSource = read('server/src/engines/task-center.js');
const nanoTaskCenterRouteSource = read('server/src/routes/task-center.js');

const {
  CONTENT_HANDLER_ADAPTER_CATALOG,
  invokeContentHandlerGenerate,
} = await import('../src/engines/content-handler-adapters.js');
const {
  TOOL_DEFINITIONS,
  TOOL_KEYS,
} = await import('../src/engines/toolbox.js');
const { TASK_CENTER_KINDS } = await import('../src/engines/task-center.js');

function topLevelPythonFunction(source, name) {
  const startMatch = source.match(new RegExp(`^async?\\s+def\\s+${name}\\s*\\(`, 'mu'))
    || source.match(new RegExp(`^def\\s+${name}\\s*\\(`, 'mu'));
  if (!startMatch || startMatch.index === undefined) return '';
  const start = startMatch.index;
  const next = source.slice(start + startMatch[0].length).search(/^((async\s+)?def|class)\s+/mu);
  return next < 0 ? source.slice(start) : source.slice(start, start + startMatch[0].length + next);
}

function stationRowsFromSource(source) {
  return [...source.matchAll(/dict\(idx=(\d+),\s*key="([^"]+)"[\s\S]*?run=(run_[a-z_]+)/gu)]
    .map(match => ({ idx: Number(match[1]), key: match[2], run: match[3] }));
}

function mappingSummary(descriptor) {
  return {
    idx: descriptor.employeeIdx,
    key: descriptor.employeeKey,
    legacyHandler: descriptor.legacyHandler,
    executionKind: descriptor.execution.kind,
    webRequired: descriptor.execution.webRequired,
    externalActionAllowed: descriptor.execution.externalActionAllowed,
    upstream: descriptor.inputContract.upstream,
  };
}

const paihuoStations = stationRowsFromSource(paihuoRegistrySource);
const paihuoStationByKey = new Map(paihuoStations.map(row => [row.key, row]));

const EXPECTED_HANDLERS = [
  { idx: 0, key: 'trend', legacyHandler: 'run_trend', executionKind: 'text_json', webRequired: true, upstream: [] },
  { idx: 1, key: 'research', legacyHandler: 'run_research', executionKind: 'text_json', webRequired: true, upstream: ['outputs[0].topics', 'outputs[0].selected'] },
  { idx: 2, key: 'benchmark', legacyHandler: 'run_benchmark', executionKind: 'text_json', webRequired: true, upstream: ['outputs[0].topics', 'outputs[0].selected', 'outputs[1].summary'] },
  { idx: 3, key: 'draft', legacyHandler: 'run_draft', executionKind: 'text_json', webRequired: false, upstream: ['outputs[0].topics', 'outputs[0].selected', 'outputs[1]', 'outputs[2]'] },
  { idx: 4, key: 'style', legacyHandler: 'run_style', executionKind: 'text_json', webRequired: false, upstream: ['outputs[3].body', 'outputs[3].title_candidates', 'outputs[4].body', 'profile.persona.corpus'] },
  { idx: 5, key: 'media', legacyHandler: 'run_media', executionKind: 'media_generation_with_svg_fallback', webRequired: false, upstream: ['outputs[3].image_plan', 'outputs[3].body', 'outputs[4].body', 'brief.image_mode', 'brief.image_count'] },
  { idx: 6, key: 'cover', legacyHandler: 'run_cover', executionKind: 'cover_generation_with_html_fallback', webRequired: false, upstream: ['outputs[3].title_candidates', 'outputs[3].body', 'outputs[4].title_candidates', 'outputs[4].body', 'profile.persona.visual'] },
  { idx: 7, key: 'deck', legacyHandler: 'run_deck', executionKind: 'html_generation', webRequired: false, upstream: ['outputs[3].title_candidates', 'outputs[3].body', 'outputs[4].title_candidates', 'outputs[4].body'] },
  { idx: 8, key: 'publish', legacyHandler: 'run_publish', executionKind: 'platform_publish_package', webRequired: false, upstream: ['outputs[3].title_candidates', 'outputs[3].body', 'outputs[3].tags', 'outputs[4].title_candidates', 'outputs[4].body'] },
  { idx: 9, key: 'retro', legacyHandler: 'run_retro', executionKind: 'performance_retro', webRequired: false, upstream: ['outputs[3].title_candidates', 'outputs[3].body', 'outputs[4].title_candidates', 'outputs[4].body'] },
];

const EXPECTED_VARIABLE_NAMES = {
  trend: ['today', 'channels'],
  research: ['topic', 'channels'],
  benchmark: ['topic', 'summary', 'targets', 'dimensions'],
  draft: ['topic', 'research', 'benchmark'],
  style: ['title', 'draft_body', 'corpus'],
  media: ['title', 'plan', 'body', 'platform_specs', 'media_request'],
  cover: ['title', 'visual', 'platform_specs', 'cover_request'],
  deck: ['title', 'body', 'deck_request'],
  publish: ['title', 'tags', 'body', 'platform_specs', 'publish_request'],
  retro: ['title', 'body'],
};

paihuoSourceTest('派活AI registry 动态暴露10工位 run_*，且0–2真实联网、3–9有明确运行边界', () => {
  assert.equal(paihuoStations.length, 10, '派活AI registry.STATIONS 必须保持10工位');
  assert.deepEqual(paihuoStations.map(row => row.idx), [...Array(10).keys()]);
  assert.deepEqual(
    paihuoStations.map(row => row.key),
    EXPECTED_HANDLERS.map(row => row.key),
  );
  for (const expected of EXPECTED_HANDLERS) {
    const block = topLevelPythonFunction(paihuoRegistrySource, expected.legacyHandler);
    assert.ok(block, `派活AI缺少${expected.legacyHandler}`);
    assert.ok(block.includes('_call_bundle_json'), `${expected.legacyHandler}未接统一PromptBundle模型调用`);
    if (expected.webRequired) {
      assert.match(block, /web\s*=\s*True/u, `${expected.legacyHandler}必须真实开启web=True`);
    } else {
      assert.doesNotMatch(block, /web\s*=\s*True/u, `${expected.legacyHandler}不应隐式开启联网工位`);
    }
  }
  // Publishing remains a package/approval boundary, never an automatic side effect.
  const publishStation = paihuoStationByKey.get('publish');
  assert.ok(publishStation && paihuoRegistrySource.includes('approval=APPROVAL_FORCE'), '分发官必须保留发布终审边界');
  console.log(`PAIHUO_RUNTIME_STATIONS ${JSON.stringify(paihuoStations)}`);
});

paihuoSourceTest('Nano handler 映射与派活AI 10工位一致，并锁定外部动作边界', () => {
  assert.deepEqual(
    CONTENT_HANDLER_ADAPTER_CATALOG.map(mappingSummary),
    EXPECTED_HANDLERS.map(row => ({
      idx: row.idx,
      key: row.key,
      legacyHandler: row.legacyHandler,
      executionKind: row.executionKind,
      webRequired: row.webRequired,
      externalActionAllowed: false,
      upstream: row.upstream,
    })),
  );
  assert.equal(CONTENT_HANDLER_ADAPTER_CATALOG.length, 10);
  for (const descriptor of CONTENT_HANDLER_ADAPTER_CATALOG) {
    const source = paihuoStationByKey.get(descriptor.employeeKey);
    assert.deepEqual(
      { idx: source?.idx, key: source?.key, run: source?.run },
      { idx: descriptor.employeeIdx, key: descriptor.employeeKey, run: descriptor.legacyHandler },
      `${descriptor.employeeKey}源工位绑定漂移`,
    );
    assert.equal(descriptor.approvalBoundary.externalActionAllowed, false);
  }
  assert.match(nanoAdapterSource, /externalActionAllowed:\s*false/u);
  assert.match(nanoAdapterSource, /messageMode:\s*['"]system_user_separated['"]/u);
});

test('每工位上下游参数真实进入 injected runtime（无网络、无供应商）', async () => {
  const calls = [];
  const context = {
    executionMode: 'pipeline',
    today: '2026-08-08',
    brief: {
      direction: '源动态输入标记 TOPIC_DIRECTION',
      material: 'BUSINESS_MATERIAL',
      industry: '餐饮',
      platforms: ['小红书'],
      image_mode: 'mix',
      image_count: 2,
    },
    outputs: {
      0: { topics: [{ title: 'UPSTREAM_TOPIC', angle: 'ANGLE', hook: 'HOOK' }], selected: 0 },
      1: { summary: 'UPSTREAM_RESEARCH_SUMMARY' },
      2: { summary: 'UPSTREAM_BENCHMARK_SUMMARY', dimensions: ['DIM'] },
      3: { body: 'UPSTREAM_DRAFT_BODY', title_candidates: ['DRAFT_TITLE'], tags: ['#tag'], image_plan: [{ slot: 'IMG_SLOT', desc: 'IMG_DESC' }] },
      4: { body: 'UPSTREAM_STYLE_BODY', title_candidates: ['STYLE_TITLE'], selected_title: 0 },
    },
    profile: { persona: { corpus: 'PERSONA_CORPUS', visual: 'PERSONA_VISUAL' } },
  };
  for (const expected of EXPECTED_HANDLERS) {
    const result = await invokeContentHandlerGenerate({
      employeeIdx: expected.idx,
      prompt: { system: 'STATIC_SYSTEM', user: 'STATIC_USER', research: 'STATIC_RESEARCH' },
      generationArgs: { model: 'no-provider-test-model' },
      context,
      generateFn: async args => {
        calls.push({ idx: expected.idx, ...args });
        return { text: '{}', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.evidence.input.variableNames,
      EXPECTED_VARIABLE_NAMES[expected.key],
      `${expected.key}变量映射不完整`,
    );
    const call = calls.at(-1);
    assert.ok(call.userMsg.includes('【派活handler运行参数'), `${expected.key}未把运行变量进入user消息`);
    assert.ok(call.system.includes('STATIC_SYSTEM'), `${expected.key}system/user边界被破坏`);
  }
  assert.equal(calls.length, 10);
  assert.ok(calls.find(call => call.idx === 1).userMsg.includes('UPSTREAM_TOPIC'));
  assert.ok(calls.find(call => call.idx === 2).userMsg.includes('UPSTREAM_RESEARCH_SUMMARY'));
  assert.ok(calls.find(call => call.idx === 3).userMsg.includes('UPSTREAM_BENCHMARK_SUMMARY'));
  assert.ok(calls.find(call => call.idx === 5).userMsg.includes('IMG_SLOT'));
  assert.ok(calls.find(call => call.idx === 6).userMsg.includes('PERSONA_VISUAL'));
  assert.ok(calls.find(call => call.idx === 8).userMsg.includes('#tag'));
});

paihuoSourceTest('0–2联网链必须是 WebSearch 候选 + 应用受控正文，3–9执行模型或本地渲染/动作边界', () => {
  assert.match(paihuoProvidersSource, /_controlled_webfetch_evidence/u);
  assert.match(paihuoProvidersSource, /linkgrab\.fetch_page_evidence/u);
  assert.match(paihuoProvidersSource, /call_text_json[\s\S]*web/u);
  assert.match(paihuoLlmSource, /WebSearch/u);
  assert.match(paihuoLlmSource, /--strict-mcp-config/u);
  assert.match(paihuoLlmSource, /--tools[\s\S]*WebSearch/u);
  assert.match(nanoPipelineSource, /content_production_pipeline_private_web_snapshots/u);
  assert.match(nanoPipelineSource, /verifiedPersistedWebEvidence/u);
  assert.match(nanoPipelineSource, /researchSourcesMatchPersistedEvidence/u);
  assert.match(nanoPipelineRouteSource, /CONTENT_PIPELINE_PROVIDER/u);

  const media = topLevelPythonFunction(paihuoRegistrySource, 'run_media');
  const cover = topLevelPythonFunction(paihuoRegistrySource, 'run_cover');
  const deck = topLevelPythonFunction(paihuoRegistrySource, 'run_deck');
  assert.match(media, /imagehunt\.hunt_for_job/u);
  assert.match(media, /providers\.call_image/u);
  assert.match(media, /_save_file/u);
  assert.match(media, /回退/u);
  assert.match(cover, /providers\.call_image/u);
  assert.match(cover, /_save_file/u);
  assert.match(cover, /HTML|html/u);
  assert.match(deck, /_save_file/u);
  for (const descriptor of CONTENT_HANDLER_ADAPTER_CATALOG.slice(3)) {
    assert.equal(descriptor.execution.externalActionAllowed, false, `${descriptor.employeeKey}越过外部动作边界`);
  }
});

paihuoSourceTest('工具箱五类动态 parity：绑定、后台任务、产物、供应商账务与失败退款证据', () => {
  const paihuoToolKinds = [...(paihuoMainSource.match(/TOOL_KINDS\s*=\s*\{([\s\S]*?)\}/u)?.[1] || '').matchAll(/"([a-z]+)"\s*:/gu)]
    .map(match => match[1]);
  const paihuoRefundKinds = [...(paihuoMainSource.match(/TOOL_REFUND\s*=\s*\{([\s\S]*?)\}/u)?.[1] || '').matchAll(/"([a-z]+)"\s*:/gu)]
    .map(match => match[1]);
  const paihuoTimeoutKinds = [...(paihuoMainSource.match(/TOOL_TIMEOUTS\s*=\s*\{([\s\S]*?)\}/u)?.[1] || '').matchAll(/"([a-z]+)"\s*:/gu)]
    .map(match => match[1]);
  assert.deepEqual(paihuoToolKinds, ['hot', 'pcal', 'warm', 'leads', 'bench']);
  assert.deepEqual(paihuoRefundKinds, paihuoToolKinds);
  assert.deepEqual(paihuoTimeoutKinds, paihuoToolKinds);
  for (const key of paihuoToolKinds) {
    assert.ok(Object.hasOwn(TOOL_DEFINITIONS, key), `Nano缺工具箱${key}定义`);
    assert.ok(Number.isInteger(TOOL_DEFINITIONS[key].employeeIdx), `${key}缺真实员工绑定`);
  }
  assert.ok(paihuoToolKinds.every(key => TOOL_KEYS.includes(key)));
  for (const fragment of ['_run_tool', '_persist_tool_result', '_tool_worker', '_tool_enqueue', '_fail_tool_job', 'refund_amount_if_claimed']) {
    assert.ok(paihuoMainSource.includes(fragment), `派活AI工具箱缺少${fragment}运行边界`);
  }
  for (const fragment of ['tool_runs', 'tool_run_events', 'holdCredits', 'settleHold', 'releaseHold', 'provenance', 'usage', 'attempts']) {
    assert.ok(nanoToolboxRouteSource.includes(fragment), `Nano工具箱缺少${fragment}审计/账务链`);
  }
  assert.match(nanoToolboxEngineSource, /TOOL_DEFINITIONS/u);
  assert.match(nanoToolboxEngineSource, /generateToolboxRun/u);
  assert.match(nanoToolboxRunnerSource, /enqueueToolboxRun/u);
  assert.match(nanoToolboxRouteSource, /enqueueToolboxRun/u);
  // The toolbox records the boundary as a Chinese safety section in the
  // engine (rather than a per-run JSON `externalActionAllowed` field).
  assert.match(nanoToolboxEngineSource, /不会自动发布内容/u);
});

paihuoSourceTest('Paihuo 工具成本/token 丢弃作为上游差异留痕，Nano 不得跟随退化', () => {
  const redPoints = [];
  if (/r\.pop\(['"]cost_usd['"],\s*None\)/u.test(paihuoMainSource)
    || /r\.pop\(['"]tokens['"],\s*None\)/u.test(paihuoMainSource)) {
    redPoints.push({
      code: 'PAIHUO_TOOL_PROVIDER_USAGE_DROPPED',
      detail: '派活AI _tool_worker 在持久化前移除了 cost_usd/tokens，工具真实供应商成本无法逐任务留痕。',
    });
  }
  if (!/content_production_pipeline_jobs/u.test(nanoTaskCenterSource)
    || !/content_production_pipeline_stations/u.test(nanoTaskCenterSource)) {
    redPoints.push({
      code: 'NANOWORK_PIPELINE_NOT_IN_UNIFIED_TASK_CENTER',
      detail: 'Nano TaskCenter 当前直接收录 tool_runs/content_employee_runs 等来源，但未扫描 content_production_pipeline_jobs/stations；内容流水线不能在统一任务中心按pipeline来源呈现。',
    });
  }
  console.log(`PAIHUO_RUNTIME_TOOLBOX_PARITY_RED_POINTS ${JSON.stringify(redPoints)}`);
  assert.deepEqual(
    redPoints.map(item => item.code),
    ['PAIHUO_TOOL_PROVIDER_USAGE_DROPPED'],
    '派活AI黄金源的已知成本证据缺口必须显式留痕；若上游修复应同步更新审计基线',
  );
  assert.match(nanoToolboxRouteSource, /usage/u);
  assert.match(nanoToolboxRouteSource, /attempts/u);
  assert.match(nanoTaskCenterSource, /providerAttempt/u);
  assert.match(nanoTaskCenterSource, /publicResearch/u);
});

test('工具箱与统一 TaskCenter 的已接入来源可语义追溯（无云）', () => {
  assert.ok(Array.isArray(TASK_CENTER_KINDS));
  assert.equal(new Set(TASK_CENTER_KINDS).size, TASK_CENTER_KINDS.length);
  assert.ok(TASK_CENTER_KINDS.includes('tool'));
  assert.match(nanoTaskCenterSource, /FROM tool_runs/u);
  assert.match(nanoTaskCenterRouteSource, /listUnifiedTasks/u);
  assert.match(nanoTaskCenterRouteSource, /getUnifiedTaskDetail/u);
  assert.match(nanoToolboxRouteSource, /INSERT INTO tool_runs/u);
  assert.match(
    nanoToolboxRouteSource,
    /INSERT(?: OR (?:REPLACE|IGNORE))? INTO tool_run_events/u,
  );
});
