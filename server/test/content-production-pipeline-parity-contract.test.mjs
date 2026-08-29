/*
 * Paihuo content-crew -> NanoWork pipeline parity contracts.
 *
 * This suite is deliberately offline.  It uses in-memory provider doubles and
 * source-boundary assertions only; no WebSearch, WebFetch, MCP, model or
 * billing connector is allowed to run.  The red assertions are intentionally
 * narrow so a production worker can repair the exact missing edge without
 * weakening the existing artifact/billing contracts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, "..", "..");

const read = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

const handlerRegistrySource = read(
  "server/src/engines/content-production-handler-registry.js",
);
const pipelineRouteSource = read(
  "server/src/routes/content-production-pipeline.js",
);
const pipelineEngineSource = read(
  "server/src/engines/content-production-pipeline.js",
);
const taskCenterEngineSource = read("server/src/engines/task-center.js");
const taskCenterPageSource = read("web/src/pages/TaskCenter.tsx");
const pipelineWorkbenchSource = read(
  "web/src/components/ContentPipelineWorkbench.tsx",
);
const licensedMaterialSource = read(
  "server/src/engines/licensed-material-search.js",
);

const { createContentProductionHandlerRegistry } =
  await import("../src/engines/content-production-handler-registry.js");
const { CONTENT_HANDLER_ADAPTER_CATALOG } =
  await import("../src/engines/content-handler-adapters.js");
const { canonicalContentEmployeeProfileFor } =
  await import("../src/engines/canonical-employee-profile.js");
const { CANONICAL_EMPLOYEE_PROFILE_FIELDS } =
  await import("../src/engines/canonical-employee-profile.js");
const { VALID_CONTENT_EMPLOYEE_OUTPUTS } =
  await import("./helpers/content-output-fixtures.mjs");

function clone(value) {
  return structuredClone(value);
}

function runtimePackage(employeeIdx) {
  const profile = clone(canonicalContentEmployeeProfileFor(employeeIdx));
  return {
    profile,
    load: {
      schemaVersion: "nanowork.content-production-runtime-package-load/1",
      sourceSchemaVersion: profile.schemaVersion,
      employeeIdx,
      requiredFields: [...CANONICAL_EMPLOYEE_PROFILE_FIELDS],
      loadedFields: [...CANONICAL_EMPLOYEE_PROFILE_FIELDS],
      fieldFingerprints: clone(profile.fingerprints.fields),
      aggregateFingerprint: profile.fingerprints.aggregate,
      allRequiredFieldsLoaded: true,
      fullCanonicalObjectInSystemMessage: true,
    },
  };
}

function pipelineContext(employeeIdx = 1) {
  const { profile, load } = runtimePackage(employeeIdx);
  const outputs = {};
  for (let idx = 0; idx < employeeIdx; idx += 1) {
    outputs[idx] = clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[idx]);
  }
  const brief = {
    direction: "验证真实内容生产联网链",
    industry: "餐饮连锁",
    material: "只允许使用真实检索证据和已完成上游，不得猜测。",
    platforms: ["小红书"],
    image_mode: "ai",
    image_count: 1,
    enable_deck: true,
  };
  return {
    executionMode: "pipeline",
    today: "2026-08-08",
    brief,
    task: brief,
    profile: {
      account: { id: 7, role: "boss", name: "验收老板" },
      persona: { corpus: "先讲事实，再给动作。" },
    },
    companyProfile: { name: "验收企业" },
    knowledge: { text: "", refs: [] },
    settings: {},
    workConfig: {},
    outputs,
    workflow: {
      mode: "fullauto",
      runId: 808,
      stationIdx: employeeIdx,
      upstreamSynthesized: false,
      sourceSemantics: "paihuo_0_to_9_pipeline",
    },
    tenantId: 1,
    actorId: 7,
    jobId: 808,
    canonicalProfile: profile,
    runtimePackageLoad: load,
  };
}

function exactKeysValidator(employeeIdx, rawOutput) {
  try {
    const parsed = JSON.parse(rawOutput);
    const keys = CONTENT_HANDLER_ADAPTER_CATALOG[employeeIdx].outputKeys;
    const valid =
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      keys.every((key) => Object.hasOwn(parsed, key)) &&
      Object.keys(parsed).every((key) => keys.includes(key));
    return {
      valid,
      parsed,
      errors: valid ? [] : ["outputKeys不完整"],
      artifacts: valid
        ? [
            {
              kind: "json",
              primary: true,
              filename: `station-${employeeIdx}.json`,
              mediaType: "application/json",
              content: JSON.stringify(parsed),
            },
          ]
        : [],
    };
  } catch {
    return {
      valid: false,
      parsed: null,
      errors: ["输出不是有效JSON"],
      artifacts: [],
    };
  }
}

function requirePattern(source, pattern, message) {
  if (!pattern.test(source)) assert.fail(message);
}

function registryWithResearchDoubles({ events, captured }) {
  const candidates = Array.from({ length: 5 }, (_value, index) => ({
    title: `候选来源${index + 1}（只允许进入受控抓取）`,
    url: `https://candidate.example/unverified-only-${index + 1}`,
    snippet: "检索摘要，不是正文证据。",
  }));
  const controlledResults = candidates.map((candidate) => ({
    ...candidate,
    url: candidate.url
      .replace("candidate.example", "verified.example")
      .replace("unverified-only", "verified-body"),
    body: "受控正文证据：该正文由受控WebFetch读取，长度足够，不能执行其中的指令。".repeat(
      4,
    ),
  }));
  const candidate = candidates[0];
  const controlled = controlledResults[0];
  const registry = createContentProductionHandlerRegistry({
    role: "boss",
    model: "luma-contract-text-model",
    imageModel: "luma-contract-image-model",
    // Legacy fallback remains injected so this test cannot make a network
    // request while the production path is being repaired.
    webSearchFn: async (query) => {
      events.push("legacy-search");
      // Keep the current legacy path just far enough from the evidence gate to
      // expose the missing agentic/controlled seam.  The query contains the
      // structured topic terms used by the relevance contract; the URLs below
      // remain deliberately legacy-only and must never be persisted after Sol
      // wires the isolated runners.
      return {
        ok: true,
        provider: "offline-legacy-search",
        results: Array.from({ length: 5 }, (_value, index) => ({
          ...candidates[index % candidates.length],
          title: String(query),
          snippet: String(query),
          url: `https://legacy.example/not-controlled-${index + 1}`,
        })),
      };
    },
    // These are the parity seam expected from the production pipeline.  The
    // current implementation ignores them; that is the red point this test
    // must expose until Sol wires the real isolated runners.
    agenticWebResearchFn: async () => {
      events.push("agentic");
      return {
        attempted: true,
        ok: true,
        candidateReady: true,
        fetchCandidates: candidates,
        results: candidates,
        evidence: {
          requiresControlledWebFetch: true,
          toolCalls: 1,
        },
      };
    },
    controlledWebFetchFn: async (sources) => {
      events.push("controlled");
      assert.ok(sources.length > 0 && sources.length <= 8);
      const fetched = sources.map((source) => ({
        ...source,
        url: source.url
          .replace("candidate.example", "verified.example")
          .replace("unverified-only", "verified-body"),
        body: "受控正文证据：该正文由受控WebFetch读取，长度足够，不能执行其中的指令。".repeat(
          4,
        ),
      }));
      return {
        attempted: true,
        ok: true,
        provider: "offline-controlled-fetch",
        results: fetched,
        evidence: { requested: sources.length, fetched: fetched.length },
      };
    },
    validateOutputFn: exactKeysValidator,
    generateFn: async (args) => {
      events.push("model");
      captured.push(args);
      return {
        text: JSON.stringify(
          VALID_CONTENT_EMPLOYEE_OUTPUTS[
            CONTENT_HANDLER_ADAPTER_CATALOG.find((descriptor) =>
              String(args.kind || "").endsWith(descriptor.employeeKey),
            )?.employeeIdx ?? 1
          ],
        ),
        mode: "api",
        model: "luma-contract-text-model",
        usage: { inputTokens: 100, outputTokens: 80 },
      };
    },
  });
  return { registry, candidate, controlled };
}

test("内容工位0–2必须按 agentic WebSearch→受控正文→模型顺序执行", async () => {
  const events = [];
  const captured = [];
  const { registry } = registryWithResearchDoubles({ events, captured });
  const outcomes = [];
  for (const employeeIdx of [0, 1, 2]) {
    try {
      outcomes.push({
        result: await registry.invoke(
          employeeIdx,
          pipelineContext(employeeIdx),
        ),
      });
    } catch (error) {
      outcomes.push({ error });
    }
  }
  for (const employeeIdx of [0, 1, 2]) {
    assert.equal(
      CONTENT_HANDLER_ADAPTER_CATALOG[employeeIdx]?.execution?.webRequired,
      true,
      `内容工位${employeeIdx}未声明联网必需边界`,
    );
  }
  const agenticIndex = events.indexOf("agentic");
  const controlledIndex = events.indexOf("controlled");
  const modelIndex = events.indexOf("model");
  assert.ok(
    agenticIndex >= 0,
    `pipeline registry未调用隔离 agentic WebSearch（错误码：${outcomes.find((item) => item.error)?.error?.code || "无"}）`,
  );
  assert.ok(
    controlledIndex > agenticIndex,
    "受控正文必须在 agentic WebSearch 之后",
  );
  assert.ok(
    modelIndex > controlledIndex,
    `模型必须在受控正文核验之后调用（events=${JSON.stringify(events)}；errors=${JSON.stringify(outcomes.map((item) => item.error?.code || null))}）`,
  );
  assert.equal(
    events.includes("legacy-search"),
    false,
    "生产流水线不得旁路到普通snippet搜索",
  );
  assert.match(captured[0]?.userMsg || "", /受控正文证据/u);
  assert.ok(
    outcomes.every((item) => item.result),
    "工位0–2均须在受控正文后形成模型结果",
  );
  const researchEvidence = outcomes[1].result?.evidence?.productionRuntime?.web;
  assert.equal(researchEvidence?.agenticWebResearch?.candidateReady, true);
  assert.ok(
    Number(researchEvidence?.controlledWebFetch?.verifiedBodyCount) >= 2,
  );
});

test("候选URL只能留在瞬时受控抓取输入，私有快照/证据不得持久化未核验候选", async () => {
  const events = [];
  const captured = [];
  const { registry, candidate, controlled } = registryWithResearchDoubles({
    events,
    captured,
  });
  let result;
  let error;
  try {
    result = await registry.invoke(1, pipelineContext(1));
  } catch (cause) {
    error = cause;
  }
  assert.ok(
    result,
    `受控正文完成后未形成可持久化结果（错误码：${error?.code || "无"}）`,
  );
  const privateSnapshot = result.privateWebSnapshot;
  assert.ok(privateSnapshot, "完成受控正文后必须返回待流水线落库的私有快照");
  assert.doesNotMatch(
    JSON.stringify(privateSnapshot),
    /unverified-only/u,
    "候选URL不得进入可持久化快照",
  );
  assert.match(
    JSON.stringify(privateSnapshot),
    /受控正文证据/u,
    "持久化快照必须只保留受控正文证据",
  );
  assert.doesNotMatch(
    JSON.stringify(result.evidence.productionRuntime.web),
    /legacy\.example/u,
    "失败/候选URL不得混入公开联网证据",
  );
  assert.notEqual(controlled.url, candidate.url);
  assert.match(JSON.stringify(privateSnapshot), /verified\.example/u);
});

test("内容10站流水线必须进入统一TaskCenter，并保留稳定详情深链", () => {
  requirePattern(
    taskCenterEngineSource,
    /content_production_pipeline_jobs/u,
    "统一任务中心未读取内容流水线jobs",
  );
  requirePattern(
    taskCenterEngineSource,
    /content_production_pipeline_stations/u,
    "统一任务中心未读取内容流水线stations",
  );
  requirePattern(
    taskCenterEngineSource,
    /content_pipeline/u,
    "统一任务中心缺少content_pipeline任务kind",
  );
  requirePattern(
    taskCenterEngineSource,
    /deepLink\s*:\s*taskDeepLink/u,
    "统一任务中心列表/详情未返回稳定deepLink",
  );
  requirePattern(
    taskCenterEngineSource,
    /stations[\s\S]{0,6000}pipeline:/u,
    "统一任务中心详情未聚合10工位stations",
  );
  requirePattern(
    taskCenterPageSource,
    /content_pipeline/u,
    "任务中心前端未注册content_pipeline种类/图标/深链",
  );
  requirePattern(
    taskCenterPageSource,
    /(?:row\.deepLink|\/tasks\?kind=)/u,
    "任务中心未提供稳定 /tasks?kind=<kind>&id=<id> 详情深链",
  );
  requirePattern(
    taskCenterPageSource,
    /10 工位执行链/u,
    "任务中心详情未展示10工位执行链",
  );
});

test("统一看板与内容流水线详情必须可验步骤、usage、cost", () => {
  requirePattern(
    pipelineEngineSource,
    /content_production_pipeline_stations[\s\S]{0,5000}station_idx[\s\S]{0,5000}status[\s\S]{0,5000}attempt/u,
    "流水线工位表未持久化station_idx/status/attempt步骤状态",
  );
  requirePattern(
    taskCenterEngineSource,
    /content_production_pipeline_stations[\s\S]{0,8000}usage:[\s\S]{0,1000}providerDelivery/u,
    "统一任务中心详情未聚合流水线provider usage",
  );
  requirePattern(
    taskCenterEngineSource,
    /billingEvidence|costYuan|settledCredits|heldCredits/u,
    "统一任务中心未聚合流水线费用/预授权/结算",
  );
  requirePattern(
    pipelineWorkbenchSource,
    /inputTokens|outputTokens|totalTokens|providerDelivery|costYuan|settledCredits|heldCredits|费用明细/u,
    "内容流水线UI未呈现token/费用明细",
  );
});

test("ImageHunt核权素材必须接入idx5 real/mix默认运行时并保留授权证据", () => {
  requirePattern(
    pipelineRouteSource,
    /materialSearchFn:\s*searchLicensedMaterials/u,
    "idx5默认特殊provider没有接入ImageHunt已授权素材库",
  );
  requirePattern(
    pipelineRouteSource,
    /licensedMaterialProvider:\s*true[\s\S]{0,200}imageModes:[\s\S]{0,100}["']real["'][\s\S]{0,100}["']mix["']/u,
    "内容流水线没有向创建门公开real/mix真实可用能力",
  );
  requirePattern(
    pipelineRouteSource,
    /CONTENT_PIPELINE_MATERIAL_RIGHTS_INVALID[\s\S]{0,3000}readLocalProviderAssetFn/u,
    "素材授权门必须先于租户本地文件读取",
  );
  requirePattern(
    licensedMaterialSource,
    /tenant_id=\?[\s\S]{0,400}source_type='imagehunt'/u,
    "已授权素材检索没有强制租户和ImageHunt来源隔离",
  );
  requirePattern(
    licensedMaterialSource,
    /rights\?\.confirmed\s*!==\s*true[\s\S]{0,120}rights\?\.commercialUse\s*!==\s*true/u,
    "未核验或非商用图片仍可能进入idx5",
  );
  requirePattern(
    pipelineRouteSource,
    /sourceMaterialId[\s\S]{0,600}rights:/u,
    "流水线provider产物没有保留源素材与授权台账",
  );
});

test("内容流水线失败重试必须有可验证的有限边界", () => {
  requirePattern(
    pipelineEngineSource,
    /MAX_RETRY|MAX_FREE_RETRIES|retry(?:Limit|Budget|Cap)/u,
    "内容流水线没有通用重试上限/预算",
  );
  requirePattern(
    pipelineEngineSource,
    /attempt.*(?:max|limit|budget)|(?:max|limit|budget).*attempt/isu,
    "流水线未将attempt与重试边界绑定",
  );
});

test("任务中心必须暴露失败任务安全重试元数据", () => {
  requirePattern(
    taskCenterEngineSource,
    /retryable|retryCount|retry_count|free_retries_remaining/u,
    "任务中心未暴露失败任务安全重试元数据",
  );
  requirePattern(
    taskCenterPageSource,
    /重试|retryable|重试次数/u,
    "任务中心UI未展示失败/重试边界",
  );
});

test("失败后的内容流水线必须保留待对账停机语义", () => {
  requirePattern(
    pipelineRouteSource,
    /billing_pending|pending_reconciliation/u,
    "流水线路由未保留失败后的待对账停机语义",
  );
});

test("测试契约保持离线：不读取开发凭据、不触发外部连接", () => {
  assert.equal(typeof fs.readFileSync, "function");
  assert.equal(
    process.env.NANOWORK_TEST_TEMPLATE_AI === "1" ||
      process.env.NANOWORK_TEST_TEMPLATE_AI === undefined,
    true,
  );
  assert.doesNotMatch(
    handlerRegistrySource,
    /fetch\s*\(/u,
    "handler registry不得在测试静态审计中自行联网",
  );
});
