import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(
  os.tmpdir(),
  `nanowork-public-source-quality-audit-${process.pid}.db`,
);
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best effort
  }
}
process.env.NANOWORK_DB = DB_PATH;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
process.env.ENABLE_SCHEDULER = "false";
process.env.SEED_DEMO = "false";

const { initSchema, migrateV2 } = await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { buildEmployeeExecutionProfile } =
  await import("../src/employee-workbench.js");
const { marshalWork } = await import("../src/engines/ai.js");
const {
  assessLocationBusinessSourceQuality,
  isDirectRestaurantSource,
  rankControlledFetchCandidates,
  sanitizePublicSources,
} = await import("../src/engines/public-source-quality.js");

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

const TASK = Object.freeze({
  title: "毛血旺 太原吾悦广场",
  type: "商圈画像",
  requirement: "围绕毛血旺 太原吾悦广场完成商圈画像与竞品核验。",
});

function profile(idx) {
  return buildEmployeeExecutionProfile(idx, {
    tenantId: 1,
    user: { id: 1, role: "boss", tenant_id: 1 },
  });
}

test("拒绝台账不应回显坏URL或查询凭据", () => {
  const result = sanitizePublicSources(
    [
      {
        title: "恶意标题 https://secret.example/path?token=abc&signature=xyz",
        url: "https://sites.google.com/view/bad-source",
        snippet: "假护照 WhatsApp 引流",
      },
    ],
    { locationBusinessTask: true },
  );

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 1);
  const serialized = JSON.stringify(result.rejected);
  assert.doesNotMatch(serialized, /https?:\/\//u);
  assert.doesNotMatch(serialized, /(?:token|signature)\s*[=:]/iu);
  assert.equal(result.rejected[0].host, "sites.google.com");
});

test("fragment 中的 access_token 也必须拒绝，普通来源只保留去 hash canonical URL", () => {
  const credential = sanitizePublicSources([
    {
      title: "带隐式令牌的来源",
      url: "https://example.com/maps#access_token=abc123",
      snippet: "不应进入来源快照。",
    },
  ]);
  assert.equal(credential.accepted.length, 0);
  assert.equal(credential.rejected[0].reason, "credential_bearing_url");
  assert.doesNotMatch(
    JSON.stringify(credential.rejected),
    /access_token|abc123/iu,
  );

  const canonical = sanitizePublicSources([
    {
      title: "普通公开来源",
      url: "https://example.com/maps#section-2",
      snippet: "普通公开正文。",
    },
  ]);
  assert.equal(canonical.accepted[0].url, "https://example.com/maps");
});

test("fragment 敏感键在前置参数、JSON和双重编码形态下都应拒绝", () => {
  for (const url of [
    "https://example.com/#foo=1&access_token=abc123",
    'https://example.com/#{"secret":"abc123"}',
    "https://example.com/#foo=1&%2561ccess_token%253Dabc123",
  ]) {
    const result = sanitizePublicSources([
      { title: "fragment", url, snippet: "x" },
    ]);
    assert.equal(result.accepted.length, 0, url);
    assert.equal(result.rejected[0].reason, "credential_bearing_url", url);
  }
});

test("query 参数名的编码与双重编码敏感键都必须拒绝", () => {
  for (const [url, expectedReason] of [
    ["https://example.com/?%61ccess_token=abc123", "credential_bearing_url"],
    ["https://example.com/?%2561ccess_token=abc123", "credential_bearing_url"],
    ["https://example.com/?%2574oken=abc123", "credential_bearing_url"],
    ["https://example.com/?%F0%80%80%80=abc123", "malformed_url_encoding"],
  ]) {
    const result = sanitizePublicSources([
      { title: "query fragment", url, snippet: "x" },
    ]);
    assert.equal(result.accepted.length, 0, url);
    assert.equal(result.rejected[0].reason, expectedReason, url);
  }
});

test("地图来源不能冒充餐饮直接锚点，直接锚点必须来自受控正文", () => {
  const locationSource = {
    title: "OpenStreetMap周边餐饮·吾悦广场毛血旺",
    url: "https://www.openstreetmap.org/way/7001",
    snippet: "毛血旺菜单、营业评价与周边餐饮POI。",
  };
  const controlledDirectSource = {
    title: "毛血旺·太原吾悦广场商户页面",
    url: "https://merchant.example/wuyue-menu",
    body: "受控网页正文核验记录：毛血旺太原吾悦广场商户页面公开菜单、菜品价格、营业时间、堂食与外卖渠道、评价主题和门店状态；正文可回看，未核验字段保留未知与现场证伪动作。",
  };
  assert.equal(isDirectRestaurantSource(locationSource, TASK), false);
  assert.equal(isDirectRestaurantSource(controlledDirectSource, TASK), true);
  const quality = assessLocationBusinessSourceQuality({
    locationSources: [locationSource],
    controlledSources: [controlledDirectSource],
    task: TASK,
    required: true,
  });
  assert.equal(quality.locationAnchorCount, 1);
  assert.equal(quality.directRestaurantSourceCount, 1);
  assert.equal(quality.passed, true);
});

test("缺少受控正文的来源不能单独构成餐饮直接锚点", () => {
  const metadataOnly = {
    title: "毛血旺·太原吾悦广场商户页面",
    url: "https://merchant.example/wuyue-menu",
    snippet: "毛血旺太原吾悦广场菜单、营业评价与外卖页面。",
  };
  const quality = assessLocationBusinessSourceQuality({
    locationSources: [
      {
        title: "OpenStreetMap定位·太原吾悦广场",
        url: "https://www.openstreetmap.org/way/7001",
        snippet: "地点定位与真实路网可达性锚点。",
      },
    ],
    controlledSources: [metadataOnly],
    task: TASK,
    required: true,
  });
  assert.equal(isDirectRestaurantSource(metadataOnly, TASK), false);
  assert.equal(quality.directRestaurantSourceCount, 0);
  assert.equal(quality.passed, false);
});

test("已核验城市中心下的结构化餐饮POI可作直接锚点，普通地图摘要仍不可", () => {
  const center = {
    title: "OpenStreetMap定位·太原吾悦广场",
    url: "https://www.openstreetmap.org/way/1126952639",
    snippet: "地图核验位置：太原吾悦广场，万柏林区，太原市。",
  };
  const structuredRestaurant = {
    title: "OpenStreetMap周边餐饮·吾悦川菜馆",
    url: "https://www.openstreetmap.org/node/7101",
    snippet:
      "地图中心=太原吾悦广场，万柏林区，太原市；距中心直线约120米；类别=餐饮；cuisine=川菜。",
    evidenceKind: "structured_location_restaurant_poi",
  };
  const quality = assessLocationBusinessSourceQuality({
    locationSources: [center, structuredRestaurant],
    controlledSources: [],
    task: TASK,
    required: true,
  });
  assert.equal(quality.directRestaurantControlledCount, 0);
  assert.equal(quality.directRestaurantStructuredCount, 1);
  assert.equal(quality.directRestaurantSourceCount, 1);
  assert.equal(quality.passed, true);

  const metadataOnly = assessLocationBusinessSourceQuality({
    locationSources: [
      center,
      { ...structuredRestaurant, evidenceKind: undefined },
    ],
    controlledSources: [],
    task: TASK,
    required: true,
  });
  assert.equal(metadataOnly.directRestaurantSourceCount, 0);
  assert.equal(metadataOnly.passed, false);
});

test("Google Maps路径计入位置锚点，普通 Google Search 页面不计入", () => {
  const controlledDirectSource = {
    title: "毛血旺·太原吾悦广场商户页面",
    url: "https://merchant.example/wuyue-menu",
    body: "毛血旺太原吾悦广场菜单、营业状态、评价与外卖正文。",
  };
  const locationQuality = (url) =>
    assessLocationBusinessSourceQuality({
      locationSources: [{ title: "Google地图地点", url }],
      controlledSources: [controlledDirectSource],
      task: TASK,
      required: true,
    });
  assert.equal(
    locationQuality("https://www.google.com/maps/place/Taiyuan-Wuyue")
      .locationAnchorCount,
    1,
  );
  assert.equal(
    locationQuality("https://www.google.com/search?q=Taiyuan-Wuyue")
      .locationAnchorCount,
    0,
  );
});

test("受控候选排序优先直接餐饮权威来源且保持同源配额稳定", () => {
  const ranked = rankControlledFetchCandidates(
    [
      {
        title: "泛搜索候选",
        url: "https://search.example/result-1",
        snippet: "毛血旺太原吾悦广场餐饮菜单营业评价页面。",
      },
      {
        title: "点评商户页",
        url: "https://www.dianping.com/shop/wuyue-maoxuewang",
        snippet: "毛血旺太原吾悦广场具体商户菜单、营业时间、价格与用户评价。",
      },
      {
        title: "点评商户页2",
        url: "https://www.dianping.com/shop/wuyue-maoxuewang-2",
        snippet: "毛血旺太原吾悦广场具体商户菜单、营业时间、价格与用户评价。",
      },
      {
        title: "点评商户页3",
        url: "https://www.dianping.com/shop/wuyue-maoxuewang-3",
        snippet: "毛血旺太原吾悦广场具体商户菜单、营业时间、价格与用户评价。",
      },
    ],
    { task: TASK },
  );
  assert.equal(ranked[0].url, "https://www.dianping.com/shop/wuyue-maoxuewang");
  assert.equal(
    ranked.filter(
      (source) => new URL(source.url).hostname === "www.dianping.com",
    ).length,
    3,
    "排序层保留溢出候选，但前两条应优先满足每主机配额",
  );
  assert.equal(ranked[2].url, "https://search.example/result-1");
  assert.equal(
    ranked.at(-1).url,
    "https://www.dianping.com/shop/wuyue-maoxuewang-3",
  );
});

test("未成功受控的候选URL不能进入失败快照，且无direct不得调用最终模型", async () => {
  const employeeExecution = profile(102);
  const candidateUrls = Array.from(
    { length: 10 },
    (_, index) => `https://unverified.example/source-${index + 1}`,
  );
  let generateCalled = false;
  let failure;
  try {
    await marshalWork(
      { code: "M-01", name: "调度容器", duty: "调度", prompt: "" },
      TASK,
      "boss",
      {
        employeeExecution,
        requireAgenticResearch: true,
        agenticWebResearchFn: async () => ({
          attempted: true,
          ok: true,
          candidateReady: true,
          provider: "isolated-agentic",
          results: candidateUrls.map((url, index) => ({
            title: `未受控候选${index + 1}`,
            url,
            snippet: "毛血旺太原吾悦广场餐厅菜单营业评价候选，尚未读取正文。",
          })),
          fetchCandidates: candidateUrls.map((url, index) => ({
            title: `未受控候选${index + 1}`,
            url,
            snippet: "毛血旺太原吾悦广场餐厅菜单营业评价候选，尚未读取正文。",
          })),
          evidence: { qualityGate: { passed: true }, facts: [] },
        }),
        webSearchFn: async () => ({
          attempted: true,
          ok: false,
          provider: "isolated-search",
          results: [],
        }),
        locationIntelligenceFn: async () => ({
          attempted: true,
          ok: true,
          provider: "isolated-location",
          results: [
            {
              title: "OpenStreetMap定位·太原吾悦广场",
              url: "https://www.openstreetmap.org/way/7001",
              snippet: "地点定位与真实路网可达性锚点。",
            },
          ],
          evidence: { isochroneComplete: true, isochrones: [] },
        }),
        controlledWebFetchFn: async (sources) => ({
          attempted: true,
          ok: false,
          provider: "isolated-controlled",
          results: [],
          evidence: {
            requested: sources.length,
            fetched: 0,
            failures: sources.map((source) => ({
              host: new URL(source.url).hostname,
              code: "CONTROLLED_WEB_BODY_EMPTY",
              url: source.url,
              detail: "仅用于验证聚合器必须脱敏失败字段",
            })),
            externalCall: true,
            ssrfProtected: true,
            redirectsRevalidated: true,
          },
        }),
        generateFn: async () => {
          generateCalled = true;
          return { text: "{}", mode: "api", model: "isolated", usage: {} };
        },
      },
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.code, "EMPLOYEE_PUBLIC_RESEARCH_INCOMPLETE");
  assert.equal(generateCalled, false);
  assert.ok(failure.web);
  const serializedWeb = JSON.stringify(failure.web);
  assert.doesNotMatch(serializedWeb, /https?:\/\/unverified\.example/iu);
  assert.doesNotMatch(serializedWeb, /\/source-\d+/u);
  assert.match(serializedWeb, /"host":"unverified\.example"/u);
  assert.ok(
    failure.web.channels
      .find((channel) => channel.kind === "controlled_web_fetch")
      ?.evidence?.failures.every((item) =>
        Object.keys(item).every((key) =>
          ["host", "code", "batch"].includes(key),
        ),
      ),
  );
});

test("地点任务受控抓取每批不超过8、总候选不超过24，并在首个合格direct正文后停止", async () => {
  const employeeExecution = profile(102);
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    title: `候选商户${index + 1}·毛血旺太原吾悦广场`,
    url: `https://candidate-${index + 1}.example/menu`,
    snippet: "毛血旺太原吾悦广场餐厅菜单营业评价候选，尚未读取正文。",
  }));
  const batchCalls = [];
  let failure;
  try {
    await marshalWork(
      { code: "M-01", name: "调度容器", duty: "调度", prompt: "" },
      TASK,
      "boss",
      {
        employeeExecution,
        requireAgenticResearch: true,
        agenticWebResearchFn: async () => ({
          attempted: true,
          ok: true,
          candidateReady: true,
          provider: "isolated-agentic",
          results: candidates,
          fetchCandidates: candidates,
          evidence: { qualityGate: { passed: true }, facts: [] },
        }),
        webSearchFn: async () => ({
          attempted: true,
          ok: false,
          provider: "isolated-search",
          results: [],
        }),
        locationIntelligenceFn: async () => ({
          attempted: true,
          ok: true,
          provider: "isolated-location",
          results: [
            {
              title: "OpenStreetMap定位·太原吾悦广场",
              url: "https://www.openstreetmap.org/way/7001",
              snippet: "地点定位与真实路网可达性锚点。",
            },
          ],
          evidence: { isochroneComplete: true, isochrones: [] },
        }),
        controlledWebFetchFn: async (sources) => {
          batchCalls.push(sources.map((source) => source.url));
          const direct = batchCalls.length === 2;
          return {
            attempted: true,
            ok: true,
            provider: "isolated-controlled",
            results: sources.map((source, index) => ({
              ...source,
              body:
                direct && index === 0
                  ? "受控网页正文核验记录：毛血旺太原吾悦广场商户页面公开菜单、菜品价格、营业时间、堂食与外卖渠道、评价主题和门店状态均可回看，未知字段保留证伪动作，不把推测写成事实；缺失项按核验日期标注并安排现场复核。"
                  : "短正文",
            })),
            evidence: {
              requested: sources.length,
              fetched: sources.length,
              failures: [],
              externalCall: true,
              ssrfProtected: true,
              redirectsRevalidated: true,
            },
          };
        },
        generateFn: async () => ({
          text: "{}",
          mode: "api",
          model: "isolated",
          usage: {},
        }),
      },
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.code, "RESTAURANT_OUTPUT_CONTRACT_INVALID");
  assert.equal(batchCalls.length, 2);
  assert.ok(batchCalls.every((batch) => batch.length <= 8));
  assert.ok(batchCalls.flat().length <= 24);
  assert.ok(failure.web?.sourceQuality?.directRestaurantSourceCount >= 1);
  assert.equal(
    failure.web?.channels?.find(
      (channel) => channel.kind === "controlled_web_fetch",
    )?.evidence?.batchCount,
    2,
  );
});

test("101/102/104 的 location_intelligence 运行绑定一致且非地点岗位不误绑", () => {
  for (const idx of [101, 102, 104]) {
    const bindings =
      profile(idx).workbench.runtimeBindings.currentRuntimeBindings;
    assert.deepEqual(
      bindings.apis.find((item) => item.id === "location_intelligence"),
      {
        id: "location_intelligence",
        binding: "employeeLocationIntelligence",
        invocation: "every_dispatch",
        credentialPolicy: "server_runtime_only",
        provenance: "current_runtime_reimplementation",
      },
      `employee ${idx} API binding`,
    );
    assert.deepEqual(
      bindings.tools.find((item) => item.id === "location_intelligence"),
      {
        id: "location_intelligence",
        binding: "employeeLocationIntelligence",
        required: true,
      },
      `employee ${idx} tool binding`,
    );
    assert.deepEqual(
      bindings.connectors.find((item) => item.kind === "location_intelligence"),
      {
        kind: "location_intelligence",
        status: "required_at_dispatch",
        handler: "employeeLocationIntelligence",
      },
      `employee ${idx} connector binding`,
    );
  }
  const nonLocationBindings =
    profile(103).workbench.runtimeBindings.currentRuntimeBindings;
  assert.equal(
    nonLocationBindings.tools.some(
      (item) => item.id === "location_intelligence",
    ),
    false,
  );
  assert.equal(
    nonLocationBindings.apis.some(
      (item) => item.id === "location_intelligence",
    ),
    false,
  );
});

test("onResearchComplete 在101/102/104契约失败时仍带完整地图、受控正文与质量快照", async () => {
  for (const idx of [101, 102, 104]) {
    const employeeExecution = profile(idx);
    const candidate = {
      title: "毛血旺·太原吾悦广场商户页面",
      url: "https://merchant.example/wuyue-menu",
      snippet: "毛血旺太原吾悦广场餐厅菜单营业评价。",
    };
    const location = {
      title: "OpenStreetMap定位·太原吾悦广场",
      url: "https://www.openstreetmap.org/way/7001",
      snippet: "地点定位与真实路网可达性锚点。",
    };
    const callbackSnapshots = [];
    const invalidFixture = structuredClone(
      employeeExecution.outputContract.validFixture,
    );
    invalidFixture.decision_context.problem = `${TASK.title}：${invalidFixture.decision_context.problem}`;
    invalidFixture.decision_context.sources = [
      {
        source: `${candidate.title}｜${candidate.url}`,
        period: "2026-08-08",
        fact: "受控网页正文支持菜单、营业与评价核验。",
      },
    ];
    let error;
    try {
      await marshalWork(
        { code: "M-01", name: "调度容器", duty: "调度", prompt: "" },
        TASK,
        "boss",
        {
          employeeExecution,
          requireAgenticResearch: true,
          agenticWebResearchFn: async () => ({
            attempted: true,
            ok: true,
            candidateReady: true,
            provider: "isolated-agentic",
            results: [candidate],
            fetchCandidates: [candidate],
            evidence: {
              qualityGate: { passed: true },
              facts: [],
              externalCall: false,
            },
          }),
          webSearchFn: async () => ({
            attempted: true,
            ok: false,
            provider: "isolated-search",
            results: [],
          }),
          locationIntelligenceFn: async () => ({
            attempted: true,
            ok: true,
            provider: "isolated-location",
            results: [location],
            evidence: {
              isochroneComplete: true,
              isochrones: [
                {
                  mode: "walking",
                  minutes: 10,
                  provider: "isolated-routing",
                  source: "https://valhalla1.openstreetmap.de/isochrone",
                  polygon: { type: "Polygon", coordinates: [] },
                },
              ],
            },
          }),
          controlledWebFetchFn: async (sources) => ({
            attempted: true,
            ok: true,
            provider: "isolated-controlled",
            results: sources.map((source) => ({
              ...source,
              body: "受控网页正文核验记录：毛血旺太原吾悦广场商户页面公开菜单、菜品价格、营业时间、堂食与外卖渠道、评价主题和门店状态；正文可回看，未核验字段保留未知与现场证伪动作。",
            })),
            evidence: {
              fetched: sources.length,
              failures: [],
              ssrfProtected: true,
            },
          }),
          generateFn: async () => ({
            text: JSON.stringify({ contract_id: "invalid-contract" }),
            mode: "api",
            model: "isolated-model",
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
          onResearchComplete: (web) => callbackSnapshots.push(web),
        },
      );
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, `employee ${idx} should fail invalid contract`);
    assert.equal(
      error.code,
      "RESTAURANT_OUTPUT_CONTRACT_INVALID",
      `employee ${idx}`,
    );
    assert.equal(callbackSnapshots.length, 1, `employee ${idx} callback count`);
    const web = callbackSnapshots[0];
    assert.ok(web, `employee ${idx} callback snapshot`);
    assert.ok(
      web.channels.some((channel) => channel.kind === "location_intelligence"),
    );
    assert.ok(
      web.channels.some((channel) => channel.kind === "controlled_web_fetch"),
    );
    assert.equal(web.sourceQuality.required, true);
    assert.equal(web.sourceQuality.passed, true);
    assert.ok(web.sourceQuality.locationAnchorCount >= 1);
    assert.equal(web.sourceQuality.directRestaurantSourceCount, 1);
    assert.deepEqual(
      error.web,
      web,
      `employee ${idx} thrown error must retain same snapshot`,
    );
  }
});

after(() => {
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best effort
    }
  }
});
