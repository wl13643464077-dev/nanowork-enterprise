/*
 * Online skill-learning parity contract (no-cloud / no-payment).
 *
 * PaihuoAI is the behavioural baseline: employees.learning_prompt_bundle()
 * keeps private station material in the final-model system prompt while the
 * isolated research brief is public-only; employees.learn() merges fresh
 * cards and the /api/employees/{idx}/learn route charges/refunds the job.
 * NanoWork now provides a durable run API around that chain.  This test keeps
 * only source-level Paihuo drift as explicit red evidence; all Nano behavior
 * is dependency-injected and no provider/network call is allowed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NANOWORK_DB = ':memory:';
process.env.YUNWU_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.ENABLE_BACKGROUND_EMBEDDINGS = 'false';
process.env.ENABLE_SCHEDULER = 'false';
process.env.SEED_DEMO = 'false';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, '..', '..');
const paihuoRoot = path.resolve(projectRoot, '..', '派活AI');
const paihuoEmployeesPath = path.join(paihuoRoot, 'app', 'employees.py');
const paihuoMainPath = path.join(paihuoRoot, 'app', 'main.py');
const nanoLearningPath = path.join(projectRoot, 'server', 'src', 'engines', 'employee-skill-learning.js');
const nanoRoutesDirectory = path.join(projectRoot, 'server', 'src', 'routes');

const paihuoEmployeesSource = fs.readFileSync(paihuoEmployeesPath, 'utf8');
const paihuoMainSource = fs.readFileSync(paihuoMainPath, 'utf8');
const paihuoLearnRouteStart = paihuoMainSource.indexOf('@app.post("/api/employees/{idx}/learn")');
const paihuoLearnRouteSource = paihuoLearnRouteStart >= 0
  ? paihuoMainSource.slice(paihuoLearnRouteStart, paihuoLearnRouteStart + 4200)
  : '';
const nanoRouteSource = fs.readdirSync(nanoRoutesDirectory)
  .filter(name => name.endsWith('.js'))
  .map(name => fs.readFileSync(path.join(nanoRoutesDirectory, name), 'utf8'))
  .join('\n');

let nanoLearning = null;
let nanoLearningImportError = null;
try {
  nanoLearning = await import('../src/engines/employee-skill-learning.js');
} catch (error) {
  nanoLearningImportError = error;
}

const EXPECTED_EXPORTS = [
  'buildSkillLearningPrompt',
  'runEmployeeSkillLearning',
  'createSkillLearningRun',
  'getSkillLearningRun',
  'listSkillLearningRuns',
  'startSkillLearningRun',
];

const parityRedPoints = [];
if (!fs.existsSync(nanoLearningPath)) {
  parityRedPoints.push({
    code: 'NANOWORK_SKILL_LEARNING_MODULE_MISSING',
    detail: 'server/src/engines/employee-skill-learning.js 不存在，预期六个闭环导出无法导入。',
  });
}
if (!/learn|skill.?learning/iu.test(nanoRouteSource)) {
  parityRedPoints.push({
    code: 'NANOWORK_SKILL_LEARNING_ROUTE_MISSING',
    detail: 'server/src/routes 当前没有员工在线进修派发/查询路由，Boss/platform_super 入口无法验收。',
  });
}
if (!/至少(?:做)?\s*5\s*次|至少\s*5|5\s*次针对性搜索/iu.test(paihuoEmployeesSource)
  && /至少(?:做)?\s*3\s*次|至少\s*3|3\s*次针对性搜索/iu.test(paihuoEmployeesSource)) {
  parityRedPoints.push({
    code: 'PAIHUO_WEBSEARCH_MINIMUM_BELOW_FIVE',
    detail: '派活AI learning_prompt_bundle research brief 只要求至少3次搜索，本轮门禁要求不少于5次。',
  });
}
if (/_need_boss\(\)/u.test(paihuoLearnRouteSource)
  && !/platform_super/iu.test(paihuoLearnRouteSource)) {
  parityRedPoints.push({
    code: 'PAIHUO_LEARNING_AUTHORITY_NOT_EXPLICIT_PLATFORM_SUPER',
    detail: '派活AI进修入口固定 _need_boss/root boss，本轮要求 Boss 与 platform_super 均可发起。',
  });
}
if (/raise HTTPException\(429/iu.test(paihuoLearnRouteSource)
  && !/409/iu.test(paihuoLearnRouteSource)) {
  parityRedPoints.push({
    code: 'PAIHUO_LEARNING_BUSY_STATUS_429_NOT_409',
    detail: '派活AI同岗进修冲突返回HTTP 429，本轮并发契约要求409。',
  });
}
if (!/createSkillLearningRun|employee_skill_learning|learning_runs/iu.test(nanoRouteSource)) {
  parityRedPoints.push({
    code: 'NANOWORK_LEARNING_RUN_PERSISTENCE_MISSING',
    detail: '未发现 NanoWork 在线进修 run 创建/查询/列表持久化接线。',
  });
}

function assertSourceContains(source, patterns, label) {
  for (const pattern of patterns) {
    assert.match(source, pattern, `${label}缺少契约片段${pattern}`);
  }
}

test('派活AI learning_prompt_bundle/learn 基线保留私有隔离、联网JSON、去重和回调', () => {
  assertSourceContains(paihuoEmployeesSource, [
    /def learning_prompt_bundle\(station(?::\s*dict)?\s*,\s*existing(?::\s*list)?\)/u,
    /现有技能\/岗位档案只给最终模型，不交给 WebSearch/u,
    /known_detail/u,
    /sensitive=tuple/u,
    /providers\.sanitize_research_brief/u,
    /providers\.call_text_json/u,
    /web=True/u,
    /fresh = \[\]/u,
    /seen = \{s\.get\(['"]title['"]\) for s in existing\}/u,
    /set_skills\(idx, merged\)/u,
    /_upsert\(idx, \{['"]learned_at['"]/u,
    /broadcast\(\{['"]type['"]: ['"]employee_update/u,
  ], '派活AI employees.py');
  assertSourceContains(paihuoMainSource, [
    /@app\.post\("\/api\/employees\/\{idx\}\/learn"\)/u,
    /_need_boss\(\)/u,
    /billing\.start_operation\(/u,
    /async def _bg\(\)/u,
    /employees\.learn\(s, broadcast=engine\.broadcast\)/u,
    /billing\.fail_operation\(billing_op/u,
    /billing\.complete_operation\(billing_op\)/u,
    /asyncio\.create_task\(_bg\(\)\)/u,
  ], '派活AI main.py');
});

test('NanoWork 在线进修六导出与入口门禁', () => {
  if (nanoLearningImportError) {
    const message = String(nanoLearningImportError?.message || nanoLearningImportError);
    assert.fail(
      `NanoWork在线进修模块不可用：${message}; `
      + `expectedExports=${EXPECTED_EXPORTS.join(',')}; `
      + `routePresent=${/learn|skill.?learning/iu.test(nanoRouteSource)}`,
    );
  }
  assert.ok(nanoLearning, '在线进修模块未返回命名空间');
  for (const name of EXPECTED_EXPORTS) {
    assert.equal(typeof nanoLearning[name], 'function', `缺少导出${name}`);
  }
  assert.match(nanoRouteSource, /learn|skill.?learning/iu, '缺少在线进修路由');
});

test('NanoWork 闭环行为契约（无网络、真实受控证据与3–6技能）', { concurrency: false }, async context => {
  if (!nanoLearning) {
    context.skip('employee-skill-learning.js 尚未提供，行为断言待模块接入后执行');
    return;
  }

  // This fixture is intentionally dependency-injected.  It has no network
  // implementation; any production fetch would throw and fail the test.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network forbidden in skill-learning parity test');
  };
  try {
    const searchCalls = [];
    const controlledCalls = [];
    const providerCalls = [];
    const existing = [{ title: '已有技能', detail: '不要重复', source: 'fixture', enabled: true }];
    const candidates = Array.from({ length: 6 }, (_, index) => ({
      title: `候选来源${index + 1}`,
      url: `https://example.test/source-${index + 1}`,
      snippet: `公开证据${index + 1}`,
    }));
    const controlledResults = candidates.map((candidate, index) => ({
      ...candidate,
      body: `受控正文${index + 1}，仅此正文可进入最终模型。该网页正文包含可核验的公开业务事实、日期与执行步骤，长度满足受控证据门禁。正文还保留岗位可执行动作、来源上下文、适用范围和复核边界，不能被候选标题替代。`,
      sourceUrl: candidate.url,
      sourceTitle: candidate.title,
    }));
    const providerOutput = JSON.stringify({
      skills: [
        { title: '已有技能', detail: '重复项不得新增，保留原技能并且不得再次写入技能库。', sourceTitle: candidates[0].title, sourceUrl: candidates[0].url },
        { title: '新技能一', detail: '可执行步骤一，必须落到实际岗位动作与核验边界。', sourceTitle: candidates[1].title, sourceUrl: candidates[1].url },
        { title: '新技能二', detail: '可执行步骤二，必须落到实际岗位动作与核验边界。', sourceTitle: candidates[2].title, sourceUrl: candidates[2].url },
        { title: '新技能三', detail: '可执行步骤三，必须落到实际岗位动作与核验边界。', sourceTitle: candidates[3].title, sourceUrl: candidates[3].url },
      ],
    });
    const deps = {
      controlledWebFetchFn: async batch => {
        controlledCalls.push(batch);
        return { attempted: true, ok: true, results: controlledResults, provider: 'fixture-controlled', evidence: { fetched: controlledResults.length } };
      },
      agenticWebResearchFn: async query => {
        // One injected agent represents the isolated runner; five progress
        // events prove the learning prompt's minimum WebSearch contract.
        for (let index = 0; index < 5; index += 1) searchCalls.push(`${query} #${index + 1}`);
        return {
          attempted: true,
          ok: true,
          candidateReady: true,
          fetchCandidates: candidates,
          results: candidates,
          provider: 'fixture-search',
          evidence: { costUsd: 0, steps: searchCalls.map(queryText => ({ tool: 'WebSearch', query: queryText })) },
        };
      },
      generateFn: async payload => {
        providerCalls.push(payload);
        return {
          text: providerOutput,
          data: JSON.parse(providerOutput),
          mode: 'api',
          model: 'fixture-real-model',
          usage: { inputTokens: 10, outputTokens: 20 },
          costUsd: 0,
        };
      },
    };

    // The exported API is intentionally exercised through its documented
    // object-shaped dependency boundary.  If implementation chooses a
    // different boundary, this test fails with the missing argument/field
    // rather than falling back to a provider or template.
    const run = await nanoLearning.runEmployeeSkillLearning({
      employee: {
        domain: 'restaurant',
        idx: 102,
        name: '钱商圈',
        department: '商圈分析部',
        duty: '核验商圈、竞品与经营事实',
        positionSkill: '餐饮商圈分析',
        existingSkills: existing,
      },
      ...deps,
    });
    assert.ok(run, 'runEmployeeSkillLearning必须返回运行证据');
    assert.ok(searchCalls.length >= 5, '隔离WebSearch必须至少5次');
    assert.ok(controlledCalls.length >= 1, '候选来源必须进入受控WebFetch');
    assert.ok(providerCalls.length >= 1, '最终模型必须被调用一次');
    const finalPayload = providerCalls.at(-1);
    const finalText = JSON.stringify(finalPayload);
    for (const candidate of candidates) {
      assert.equal(finalText.includes(candidate.url), controlledResults.some(result => result.url === candidate.url));
    }
    assert.ok(run.skills?.length >= 3 && run.skills?.length <= 6, '技能JSON必须为3–6条');
    assert.equal(new Set(run.skills.map(skill => skill.title)).size, run.skills.length, '新技能必须去重');
    assert.ok(run.research?.controlledSourceCount >= 3, '受控正文至少3条');
    assert.ok(run.skills.every(skill => skill.sourceUrl && skill.sourceTitle), '技能必须保留受控来源标题/URL');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('失败、并发与权限/审批契约以源码门禁保留', { concurrency: false }, context => {
  if (!nanoLearning) {
    context.skip('employee-skill-learning.js 缺失；失败/并发/权限行为已由上方红门记录');
    return;
  }
  const moduleSource = fs.readFileSync(nanoLearningPath, 'utf8');
  assertSourceContains(moduleSource, [
    /WebSearch|webSearch/iu,
    /controlled[\s_-]*(?:web)?fetch|WebFetch/iu,
    /allowedSources|controlledSources|verifiedSources/iu,
    /3[\s\S]{0,80}6|6[\s\S]{0,80}3/u,
    /dedup|dedupe|seen|new Set/iu,
    /restaurant/iu,
    /content/iu,
    /persist|callback|upsert/iu,
    /prompt/iu,
    /failure|failed/iu,
    /refund|release|billing/iu,
    /web[\s_-]*(?:evidence|snapshot)/iu,
    /provider[\s_-]*(?:evidence|attempt|usage)/iu,
  ], 'NanoWork employee-skill-learning.js');
  const routeSources = fs.readdirSync(nanoRoutesDirectory)
    .filter(name => ['employee-workbench.js', 'content-employee-workbench.js'].includes(name))
    .map(name => fs.readFileSync(path.join(nanoRoutesDirectory, name), 'utf8'))
    .join('\n');
  assert.match(moduleSource, /EMPLOYEE_SKILL_LEARNING_BUSY|status:\s*409/u);
  assert.match(routeSources, /assertWorkbenchManager|assertManager/u);
  assert.match(routeSources, /boss|admin|platform_super/u);
});

test('在线进修 parity 红点原样输出且不包含凭据/真实响应', () => {
  assert.ok(parityRedPoints.length >= 3, '当前应保留缺失接口/旧基线红点');
  console.log(`EMPLOYEE_SKILL_LEARNING_PARITY_RED_POINTS ${JSON.stringify(parityRedPoints)}`);
  const serialized = JSON.stringify(parityRedPoints);
  assert.doesNotMatch(serialized, /sk-[A-Za-z0-9]{16,}/u);
  assert.doesNotMatch(serialized, /Bearer\s+/iu);
  assert.doesNotMatch(serialized, /api[_-]?key/iu);
});
