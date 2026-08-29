import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUN_TOKEN = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
const DB_PATH = path.join(
  os.tmpdir(),
  `nanowork-full-employee-matrix-${RUN_TOKEN}.db`,
);
const DATABASE_FILES = [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`];
for (const file of DATABASE_FILES) fs.rmSync(file, { force: true });

// This acceptance test must stay hermetic even when a developer has paid keys in
// server/.env. A single whitespace character prevents env.js from loading the
// local Yunwu secret while still trimming to an unusable runtime key.
process.env.NANOWORK_DB = DB_PATH;
// 本文件覆盖的是JSON机器契约执行链（作为可切换回退保留）；
// 派活Markdown主链路的HTTP行为由 paihuo-dispatch-markdown.test.mjs 覆盖。
process.env.NANOWORK_EMPLOYEE_OUTPUT_STYLE = "contract_json";
process.env.NODE_ENV = "test";
process.env.SEED_DEMO = "false";
process.env.ENABLE_SCHEDULER = "false";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
process.env.JWT_SECRET = "Full-Employee-Matrix#2026!local-only";
process.env.YUNWU_API_KEY = " ";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

const nativeFetch = globalThis.fetch.bind(globalThis);
const externalNetworkAttempts = [];

function loopbackUrl(input) {
  const raw =
    typeof input === "string" || input instanceof URL
      ? String(input)
      : String(input?.url || "");
  try {
    const url = new URL(raw);
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

// Network-deny is evidence, not merely a convention: every fetch outside the
// local test server is recorded and rejected before a socket can be opened.
globalThis.fetch = async (input, init) => {
  if (!loopbackUrl(input)) {
    externalNetworkAttempts.push(
      String(
        typeof input === "string" || input instanceof URL
          ? input
          : input?.url || input,
      ),
    );
    throw new Error("employee matrix forbids external network access");
  }
  return nativeFetch(input, init);
};

const { db, initSchema, migrateV2, q } = await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const { hashPassword } = await import("../src/util.js");
const { createApp } = await import("../src/app.js");
const { createContentEmployeeWorkbenchRouter } =
  await import("../src/routes/content-employee-workbench.js");
const { createContentSpecialProviderBridge } =
  await import("../src/engines/content-special-provider-bridge.js");
const { buildRestaurantOutputDeliverableFixture } =
  await import("../src/engines/restaurant-output-contract.js");
const { contentEmployeeIdxFromPrompt, contentOutputFixture } =
  await import("./helpers/content-output-fixtures.mjs");
const { buildContentDispatch } =
  await import("../../scripts/lib/real-employee-matrix.mjs");

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

const PRIMARY_TENANT = 701;
const OTHER_TENANT = 702;
const STOPPED_TENANT = 703;
const PASSWORD = "Matrix-Local#2026";
const ALL_MODULES = JSON.stringify([
  "dashboard",
  "content",
  "marshals",
  "system",
]);

const insertTenant = db.prepare(`INSERT INTO tenants(
  id,name,status,plan,modules,data_mode,credits,total_recharged
) VALUES(?,?,?,?,?,'live',?,0)`);
insertTenant.run(
  PRIMARY_TENANT,
  "数字员工全量验收企业",
  "已开通",
  "旗舰版",
  ALL_MODULES,
  10_000_000,
);
insertTenant.run(
  OTHER_TENANT,
  "跨租户隔离对照企业",
  "已开通",
  "旗舰版",
  ALL_MODULES,
  100_000,
);
insertTenant.run(
  STOPPED_TENANT,
  "租户守卫对照企业",
  "已开通",
  "旗舰版",
  ALL_MODULES,
  100_000,
);

const passwordHash = hashPassword(PASSWORD);
const insertUser = db.prepare(`INSERT INTO users(
  username,password_hash,name,role,status,tenant_id,modules
) VALUES(?,?,?,?,?,?,?)`);
const primaryUserId = Number(
  insertUser.run(
    "matrix_primary_boss",
    passwordHash,
    "全量验收老板",
    "boss",
    "启用",
    PRIMARY_TENANT,
    ALL_MODULES,
  ).lastInsertRowid,
);
insertUser.run(
  "matrix_other_boss",
  passwordHash,
  "隔离对照老板",
  "boss",
  "启用",
  OTHER_TENANT,
  ALL_MODULES,
);
insertUser.run(
  "matrix_no_module",
  passwordHash,
  "无模块权限老板",
  "boss",
  "启用",
  PRIMARY_TENANT,
  "[]",
);
insertUser.run(
  "matrix_stopped_boss",
  passwordHash,
  "租户守卫对照老板",
  "boss",
  "启用",
  STOPPED_TENANT,
  ALL_MODULES,
);

const providerCalls = [];
const webEvidenceCalls = [];
const salesVideoProviderCalls = [];
const MATRIX_FETCHED_AT = "2026-08-08T12:00:00.000Z";

function deterministicWebSearch(query) {
  const queryText = String(query);
  webEvidenceCalls.push({ query: queryText, at: new Date().toISOString() });
  const primaryEvidence = queryText.includes("权威媒体报道")
    ? {
        title: "数字员工全量验收·权威媒体报道",
        url: "https://evidence.invalid/offline-matrix/authority-media",
      }
    : queryText.includes("行业报告/白皮书")
      ? {
          title: "数字员工全量验收·行业报告",
          url: "https://evidence.invalid/offline-matrix/industry-report",
        }
      : {
          title: `数字员工全量验收·${queryText.split(/\s+/u)[0] || "公开证据"}`,
          url: `https://evidence.invalid/offline-matrix/${crypto
            .createHash("sha256")
            .update(queryText.split(/\s+/u)[0] || queryText)
            .digest("hex")
            .slice(0, 16)}`,
        };
  return Promise.resolve({
    ok: true,
    provider: "deterministic-offline-evidence",
    note: "全量离线验收的可追溯本地证据",
    results: [
      {
        ...primaryEvidence,
        snippet: `本地结构化验收证据：${queryText.slice(0, 120)}；账号经营研究样本号、餐饮增长观察号、门店管理公开课。`,
      },
      {
        title: "数字员工全量验收本地证据二",
        url: "https://evidence.invalid/offline-matrix/2",
        snippet: "本地结构化验收证据：账号餐饮增长观察号。",
      },
      {
        title: "数字员工全量验收本地证据三",
        url: "https://evidence.invalid/offline-matrix/3",
        snippet: "本地结构化验收证据：账号门店管理公开课。",
      },
    ],
  });
}

// 生产员工链的联网质量门要求：每个岗位必须保留真实的“工具调用证据”
// 和至少一个受控正文。此测试不出网，使用可审计的本地供应商替身复现
// WebSearch→Controlled WebFetch 的数据形状；不会把离线候选冒充为已核验来源。
const MATRIX_PUBLIC_SOURCE = Object.freeze({
  title: "数字员工全量验收·权威媒体报道",
  url: "https://evidence.invalid/offline-matrix/authority-media",
  snippet:
    "本地确定性公开证据：毛血旺 太原吾悦广场目标餐饮门店的竞品、菜单价格、营业状态与评价主题核验正文。",
});

function deterministicAgenticWebResearch(query) {
  const queryText = String(query || "");
  const candidates = Array.from({ length: 5 }, (_unused, index) => ({
    title:
      index === 0
        ? MATRIX_PUBLIC_SOURCE.title
        : index === 1
          ? "数字员工全量验收·行业报告"
          : `数字员工全量验收·工具候选${index + 1}`,
    url:
      index === 0
        ? MATRIX_PUBLIC_SOURCE.url
        : index === 1
          ? "https://evidence.invalid/offline-matrix/industry-report"
          : `https://evidence.invalid/offline-matrix/agentic-${index + 1}`,
    snippet: `WebSearch工具第${index + 1}次成功结果；可核验案例账号为经营研究样本号、餐饮增长观察号、门店管理公开课：${queryText.slice(0, 90)}`,
  }));
  webEvidenceCalls.push({
    query: queryText,
    channel: "agentic",
    at: new Date().toISOString(),
  });
  return Promise.resolve({
    attempted: true,
    ok: true,
    candidateReady: true,
    provider: "deterministic-offline-agentic-websearch",
    results: [MATRIX_PUBLIC_SOURCE],
    fetchCandidates: candidates,
    evidence: {
      schemaVersion: "nanowork.agentic-web-research/1",
      executionMode: "deterministic_offline_matrix",
      toolCalls: 5,
      toolAttempts: 5,
      toolResults: candidates.map((_item, index) => ({
        toolUseId: `matrix-web-search-${index + 1}`,
        success: true,
        isError: false,
        permissionDenied: false,
        urlCount: 1,
      })),
      qualityGate: {
        requiredSearches: 5,
        requiredSources: 5,
        observedSearches: 5,
        observedSuccessfulToolResults: 5,
        observedToolResultUrls: 5,
        observedSources: 5,
        passed: true,
      },
      queries: Array.from(
        { length: 5 },
        (_unused, index) =>
          `全量验收检索${index + 1}：${queryText.slice(0, 80)}`,
      ),
      usage: { inputTokens: 110, outputTokens: 220 },
      externalCall: true,
      localLoginInherited: false,
    },
  });
}

function deterministicControlledWebFetch(sources = []) {
  // The first candidate retains the canonical URL but carries the current
  // task query from the agentic hand-off.  That gives every matrix task its
  // own anchor while the model output can still be conservatively restored to
  // the exact allowed title+URL pair by the production canonicalizer.
  const primarySource =
    sources.find(
      (source) => String(source?.url || "").trim() === MATRIX_PUBLIC_SOURCE.url,
    ) || MATRIX_PUBLIC_SOURCE;
  const candidates = [primarySource, ...sources].filter(Boolean);
  const seen = new Set();
  const results = candidates
    .filter((source) => {
      const url = String(source?.url || "").trim();
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .slice(0, 8)
    .map((source) => ({
      title: source.title || "数字员工全量验收·受控正文",
      url: source.url,
      snippet: source.snippet || "本地受控网页正文摘要。",
      // 与生产受控抓取标准保持一致：正文须>=80字且有明确目标餐饮
      // 锚点；候选摘要携带当前任务标题，避免用 metadata-only 通过门禁。
      body: `受控网页正文已读取并净化：毛血旺 太原吾悦广场目标餐饮门店的菜单、菜品、营业状态、价格、人均、评价与竞品公开信息逐项记录；本次候选摘要为“${String(source.snippet || "").slice(0, 220)}”，仅用于离线隔离验收，未知事实保留可复核缺口。`,
      fetchedAt: MATRIX_FETCHED_AT,
    }));
  return Promise.resolve({
    attempted: true,
    ok: true,
    provider: "deterministic-offline-controlled-webfetch",
    results,
    evidence: {
      schemaVersion: "nanowork.controlled-web-evidence/1",
      requested: Math.max(1, candidates.length),
      fetched: results.length,
      failures: [],
      externalCall: true,
      ssrfProtected: true,
      redirectsRevalidated: true,
      rawResponseStored: false,
      extractedTextStored: true,
    },
  });
}

function deterministicLocationIntelligence(value) {
  const modes = ["walking", "cycling", "driving", "transit"];
  const minutes = [10, 20, 30];
  const isochrones = modes.flatMap((mode) =>
    minutes.map((time) => ({
      mode,
      minutes: time,
      // 测试夹具只需要验证边界已被传入与持久化；多边形坐标保持最小合法 GeoJSON。
      polygon: {
        type: "Polygon",
        coordinates: [
          [
            [112.55, 37.81],
            [112.551, 37.81],
            [112.551, 37.811],
            [112.55, 37.81],
          ],
        ],
      },
      provider: "deterministic-offline-routing",
      source: `https://evidence.invalid/offline-matrix/isochrone-${mode}-${time}`,
    })),
  );
  return Promise.resolve({
    attempted: true,
    ok: true,
    provider: "deterministic-offline-osm-routing",
    results: [
      {
        title: "OpenStreetMap定位·太原吾悦广场",
        url: "https://www.openstreetmap.org/way/7001",
        snippet: "地图定位太原吾悦广场及周边需求发生器、餐饮POI。",
      },
    ],
    evidence: {
      schemaVersion: "nanowork.location-intelligence/2",
      query: String(value || "毛血旺 太原吾悦广场"),
      center: { displayName: "太原市小店区吾悦广场", lat: 37.81, lon: 112.55 },
      namedPoiCount: 12,
      isochroneRequired: true,
      isochroneComplete: true,
      isochroneProvider: "deterministic-offline-routing",
      isochroneSource: "https://evidence.invalid/offline-matrix/isochrones",
      isochroneModes: modes,
      isochroneMinutes: minutes,
      isochrones,
      externalCall: true,
    },
  });
}

const deterministicAiSalesVideoRuntime = {
  skipPriceCheck: true,
  intervalMs: 1,
  timeoutMs: 100,
  kbSearch: async (_categories, _role, query) => ({
    text: `企业已确认带货事实：${String(query || "").slice(0, 120)}；未确认价格、功效和经营成效。`,
    refs: [
      { id: 701, category: "产品资料", title: "全量验收带货素材", sim: 0.99 },
    ],
    degraded: false,
    mode: "deterministic-local",
  }),
  webSearch: async (query) => deterministicWebSearch(query),
  submitSegment: async ({ duration, model, images, prompt }) => {
    const index = salesVideoProviderCalls.length + 1;
    salesVideoProviderCalls.push({
      phase: "submit",
      index,
      duration,
      model,
      imageCount: images.length,
      prompt,
    });
    return { taskId: `matrix-sales-segment-${index}`, model };
  },
  querySegment: async ({ taskId }) => {
    salesVideoProviderCalls.push({ phase: "query", taskId });
    return {
      taskId,
      url: `https://provider.invalid/matrix-sales/${taskId}.mp4`,
      status: "success",
    };
  },
  downloadSegment: async ({ index }) => {
    salesVideoProviderCalls.push({ phase: "download", index });
    return {
      path: `/tmp/matrix-sales-provider-segment-${index}.mp4`,
      sha256: String(index).repeat(64),
      bytes: 1024,
    };
  },
  compose: async ({ plan, segments }) => {
    assert.equal(segments.length, 3);
    assert.deepEqual(
      segments.map((segment) => segment.durationSeconds),
      [10, 10, 10],
    );
    salesVideoProviderCalls.push({
      phase: "compose",
      segments: segments.length,
      durationSeconds: plan.durationSeconds,
    });
    return {
      url: "/uploads/ai-sales-video/701/matrix-sales-employee-10.mp4",
      durationSeconds: 30,
      width: 1080,
      height: 1920,
      videoCodec: "h264",
      audioCodec: "aac",
      segmentCount: 3,
      sha256: "e".repeat(64),
    };
  },
};

async function deterministicRestaurantGenerate(args) {
  const idx = Number(
    args.responseSchema?.schema?.properties?.role?.properties?.employee_idx
      ?.enum?.[0],
  );
  assert.ok(
    Number.isInteger(idx) && idx >= 101 && idx <= 161,
    `restaurant deterministic provider could not resolve employee: ${idx}`,
  );
  providerCalls.push({
    domain: "restaurant",
    idx,
    providerEvidence: "deterministic_mock",
    promptHash: crypto
      .createHash("sha256")
      .update(String(args.userMsg || ""))
      .digest("hex"),
  });
  const prompt = String(args.userMsg || "");
  const taskTitle = prompt.match(/^\s*任务：(.+)$/mu)?.[1]?.trim() || "";
  const taskRequirement =
    prompt
      .match(
        /【原任务要求·不得改题】\n([\s\S]*?)(?=\n\n【本次可用材料证据·事实边界】)/u,
      )?.[1]
      ?.trim() || "";
  assert.ok(
    taskTitle,
    `restaurant deterministic provider could not resolve task title: ${idx}`,
  );
  const fixture = buildRestaurantOutputDeliverableFixture(idx, {
    title: taskTitle,
    requirement: taskRequirement,
  });
  // 联网岗位的来源字段必须精确回指本次允许的标题+URL白名单；
  // 其余岗位材料仍保留在交付物证据字段中。
  fixture.decision_context.sources = [
    {
      source: `${MATRIX_PUBLIC_SOURCE.title}｜${MATRIX_PUBLIC_SOURCE.url}`,
      period: MATRIX_FETCHED_AT.slice(0, 10),
      fact: "受控正文核验了位置、竞品、菜单价格、营业状态与评价主题；未知事实保留为可复核缺口。",
    },
  ];
  for (const item of Object.values(fixture.input_audit || {})) {
    item.evidence_refs = [fixture.decision_context.sources[0].source];
  }
  for (const item of Object.values(fixture.method_execution || {})) {
    item.evidence_refs = [fixture.decision_context.sources[0].source];
  }
  return {
    text: JSON.stringify(fixture),
    mode: "api",
    // 生产账本同时保存“预授权请求模型”和供应商实际结算模型；本地
    // deterministic provider 必须遵守调用方指定模型，不能伪造另一个模型名。
    model: args.model || "gpt-5.5",
    usage: { inputTokens: 180, outputTokens: 120 },
  };
}

async function deterministicContentGenerate(args) {
  const idx = contentEmployeeIdxFromPrompt(args.userMsg);
  assert.ok(
    Number.isInteger(idx) && idx >= 0 && idx <= 9,
    `content deterministic provider could not resolve employee: ${idx}`,
  );
  providerCalls.push({
    domain: "content",
    idx,
    providerEvidence: "deterministic_mock",
    promptHash: crypto
      .createHash("sha256")
      .update(String(args.userMsg || ""))
      .digest("hex"),
  });
  const output = contentOutputFixture(idx);
  if (idx === 0) {
    output.briefing += " [来源1]";
    output.channel_scan.forEach((item) => {
      item.finding += " [来源1]";
    });
    output.topics.forEach((item) => {
      item.evidence += " [来源1]";
    });
  } else if (idx === 1) {
    output.summary += " [来源1]";
    output.facts.forEach((item, index) => {
      output.facts[index] = `${item} [来源1]`;
    });
    output.data_points.forEach((item, index) => {
      output.data_points[index] = `${item} [来源1]`;
    });
    output.viewpoints.forEach((item, index) => {
      output.viewpoints[index] = `${item} [来源2]`;
    });
    output.source_coverage.forEach((item) => {
      item.got += " [来源1]";
    });
    output.sources = [
      {
        title: "数字员工全量验收·权威媒体报道",
        url: "https://evidence.invalid/offline-matrix/authority-media",
      },
      {
        title: "数字员工全量验收·行业报告",
        url: "https://evidence.invalid/offline-matrix/industry-report",
      },
    ];
  } else if (idx === 2) {
    output.benchmarks.forEach((item) => {
      item.why_hot += " [来源1]";
    });
  }
  return {
    text: JSON.stringify(output),
    mode: "api",
    model: args.model || "deterministic-local-provider",
    usage: { inputTokens: 160, outputTokens: 100 },
  };
}

function deterministicContentImageBridge(input, dependencies = {}) {
  return createContentSpecialProviderBridge(input, {
    ...dependencies,
    generateImageFn: async ({ model, size }) => ({
      b64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      mimeType: "image/png",
      model,
      size,
      mode: "api",
      usage: { imageCount: 1, pricingMode: "fixed_price_per_image" },
    }),
  });
}

const contentEmployeeWorkbenchRouter = createContentEmployeeWorkbenchRouter({
  generateFn: deterministicContentGenerate,
  webSearchFn: deterministicWebSearch,
  agenticWebResearchFn: deterministicAgenticWebResearch,
  controlledWebFetchFn: deterministicControlledWebFetch,
  specialProviderBridgeFn: deterministicContentImageBridge,
  yunwuAvailableFn: () => true,
  routingFn: () => ({ image: "deterministic-local-image-provider" }),
  textModelForFn: () => "deterministic-local-provider",
});

const app = createApp({
  serveStatic: false,
  aiGuardOptions: {
    ratePerMinute: 10_000,
    burst: 10_000,
    maxConcurrent: 4,
  },
  appLocals: {
    employeeGenerate: deterministicRestaurantGenerate,
    employeeWebSearch: deterministicWebSearch,
    employeeAgenticWebResearch: deterministicAgenticWebResearch,
    employeeControlledWebFetch: deterministicControlledWebFetch,
    employeeLocationIntelligence: deterministicLocationIntelligence,
    aiSalesVideoRuntime: deterministicAiSalesVideoRuntime,
  },
  contentEmployeeWorkbenchRouter,
});
const server = app.listen(0, "127.0.0.1");
const port = await new Promise((resolve) => {
  server.once("listening", () => resolve(server.address().port));
});
const base = `http://127.0.0.1:${port}`;

async function http(pathname, { token, method = "GET", body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { response, payload, text };
}

async function login(username) {
  const result = await http("/api/auth/login", {
    method: "POST",
    body: { username, password: PASSWORD },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.ok(result.payload?.token, `login token missing for ${username}`);
  return result.payload.token;
}

async function pollJson(pathname, token, ready, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  let attempts = 0;
  while (Date.now() < deadline) {
    latest = await http(pathname, { token });
    attempts += 1;
    assert.equal(
      latest.response.status,
      200,
      `${label}: ${JSON.stringify(latest.payload)}`,
    );
    if (ready(latest.payload)) return { ...latest, attempts };
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(
    `${label} timed out after ${attempts} polls: ${JSON.stringify(latest?.payload)}`,
  );
}

function jsonObject(value, label) {
  try {
    const parsed = JSON.parse(value || "{}");
    assert.ok(
      parsed && typeof parsed === "object" && !Array.isArray(parsed),
      label,
    );
    return parsed;
  } catch (error) {
    assert.fail(`${label}: ${error.message}`);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function holdEvidence(refType, refId) {
  const rows = q.all(
    `SELECT id,status,held_credits,settled_credits,tenant_id,ref_type,ref_id
    FROM credit_holds WHERE tenant_id=? AND ref_type=? AND ref_id=? ORDER BY id`,
    PRIMARY_TENANT,
    refType,
    refId,
  );
  assert.equal(
    rows.length,
    1,
    `${refType}#${refId} must own exactly one billing hold`,
  );
  assert.equal(
    rows[0].status,
    "settled",
    `${refType}#${refId} hold must be terminal`,
  );
  const heldRemaining =
    q.get(
      `SELECT COUNT(*) n FROM credit_holds
    WHERE tenant_id=? AND ref_type=? AND ref_id=? AND status='held'`,
      PRIMARY_TENANT,
      refType,
      refId,
    )?.n || 0;
  assert.equal(
    Number(heldRemaining),
    0,
    `${refType}#${refId} left an open hold`,
  );
  return { row: rows[0], heldRemaining: Number(heldRemaining) };
}

function writeEvidenceReport(rows, middlewareEvidence) {
  const directory = String(process.env.EMPLOYEE_MATRIX_DIR || "").trim();
  if (!directory) return null;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, "full-production.json");
  const report = {
    schemaVersion: "nanowork.employee-output-matrix.v1",
    generatedAt: new Date().toISOString(),
    evidenceLevel: "L4_FULL_PRODUCTION_HTTP",
    providerEvidence: "deterministic_mock",
    verdict: "PASS_OFFLINE_PIPELINE",
    coverage: {
      total: rows.length,
      restaurant: rows.filter((row) => row.domain === "restaurant").length,
      content: rows.filter((row) => row.domain === "content").length,
    },
    middlewareEvidence,
    externalNetworkAttempts,
    providerCalls: providerCalls.length,
    salesVideoProviderCalls: salesVideoProviderCalls.length,
    webEvidenceCalls: webEvidenceCalls.length,
    rows,
  };
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  return target;
}

after(async () => {
  globalThis.fetch = nativeFetch;
  await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const file of DATABASE_FILES) fs.rmSync(file, { force: true });
});

test("[employee-output-matrix] 72名数字员工通过生产中间件、正式HTTP、策略验收与计费闭环出活", async () => {
  const middlewareEvidence = {
    createAppProductionAssembly: true,
    authMiddleware: false,
    tenantScope: true,
    tenantGate: false,
    moduleGuard: false,
    aiGuard: "production_createAiGuard",
    crossTenantReadDenied: false,
  };

  const anonymous = await http("/api/employee-workbench/restaurant/101");
  assert.equal(anonymous.response.status, 401);
  middlewareEvidence.authMiddleware = true;

  const noModuleToken = await login("matrix_no_module");
  const noModule = await http("/api/employee-workbench/restaurant/101", {
    token: noModuleToken,
  });
  assert.equal(noModule.response.status, 403);
  assert.match(String(noModule.payload?.error || ""), /模块权限/u);
  middlewareEvidence.moduleGuard = true;

  const stoppedToken = await login("matrix_stopped_boss");
  db.prepare("UPDATE tenants SET status='已停用' WHERE id=?").run(
    STOPPED_TENANT,
  );
  const stopped = await http("/api/employee-workbench/restaurant/101", {
    token: stoppedToken,
  });
  assert.equal(stopped.response.status, 403);
  assert.match(String(stopped.payload?.error || ""), /已停用/u);
  middlewareEvidence.tenantGate = true;

  const token = await login("matrix_primary_boss");
  const otherToken = await login("matrix_other_boss");
  const rows = [];
  let firstRestaurantTaskId = null;
  let firstContentRunId = null;

  for (let idx = 101; idx <= 161; idx += 1) {
    const profileResult = await http(
      `/api/employee-workbench/restaurant/${idx}`,
      { token },
    );
    assert.equal(
      profileResult.response.status,
      200,
      JSON.stringify(profileResult.payload),
    );
    const profile = profileResult.payload;
    assert.equal(profile.identity?.idx, idx);
    assert.ok(profile.identity?.key);
    assert.ok(profile.identity?.name);
    assert.ok(profile.capabilities?.length >= 5);
    assert.equal(profile.permissions?.canViewCapabilities, true);

    const taskNonce = `restaurant-${idx}-${crypto.randomUUID()}`;
    const dispatch = await http(
      `/api/employee-workbench/restaurant/${idx}/dispatch`,
      {
        token,
        method: "POST",
        body: {
          title: `[全量出活验收] ${profile.identity.name} 毛血旺 太原吾悦广场 ${taskNonce}`,
          type: profile.dispatch.defaultTaskType || "执行方案",
          requirement: `请围绕毛血旺 太原吾悦广场，严格按${profile.identity.name}岗位机器契约交付一份可直接使用成果。任务唯一标识：${taskNonce}`,
        },
      },
    );
    assert.equal(
      dispatch.response.status,
      200,
      JSON.stringify(dispatch.payload),
    );
    assert.ok(dispatch.response.headers.get("x-request-id"));
    const taskId = Number(dispatch.payload?.taskId);
    assert.ok(Number.isSafeInteger(taskId) && taskId > 0);
    if (firstRestaurantTaskId === null) firstRestaurantTaskId = taskId;

    const pending = await pollJson(
      `/api/marshals/tasks/${taskId}/status`,
      token,
      (payload) => payload?.status !== "生成中",
      `restaurant employee ${idx}`,
    );
    assert.equal(
      pending.payload.status,
      "已完成",
      JSON.stringify(pending.payload),
    );

    const taskRow = q.get(
      `SELECT * FROM agent_tasks
      WHERE tenant_id=? AND id=?`,
      PRIMARY_TENANT,
      taskId,
    );
    assert.ok(taskRow, `restaurant ${idx} task row missing`);
    assert.match(taskRow.title, new RegExp(taskNonce, "u"));
    assert.equal(
      Number(taskRow.specialist_id),
      Number(profile.identity.specialistId),
    );
    assert.equal(taskRow.status, "已完成");
    assert.ok(taskRow.output_id);
    assert.equal(
      taskRow.employee_profile_version,
      dispatch.payload.snapshot.profileVersion,
    );
    assert.equal(
      taskRow.employee_prompt_hash,
      dispatch.payload.snapshot.promptHash,
    );
    assert.match(String(taskRow.employee_prompt_hash || ""), /^[a-f0-9]{64}$/u);
    const capabilitySnapshot = JSON.parse(
      taskRow.employee_capabilities_snapshot || "[]",
    );
    const skillSnapshot = JSON.parse(taskRow.employee_skills_snapshot || "[]");
    assert.equal(capabilitySnapshot.length, profile.capabilities.length);
    assert.ok(
      skillSnapshot.length > 0,
      `restaurant ${idx} skill snapshot missing`,
    );
    const outputRow = q.get(
      `SELECT * FROM contents
      WHERE tenant_id=? AND id=?`,
      PRIMARY_TENANT,
      taskRow.output_id,
    );
    assert.ok(outputRow?.body?.trim(), `restaurant ${idx} output body missing`);
    assert.equal(outputRow.ai_mode, "api");

    const executionEvidence = jsonObject(
      taskRow.employee_web_snapshot,
      `restaurant ${idx} execution evidence is invalid`,
    );
    assert.equal(
      executionEvidence.kind,
      "restaurant_employee_execution_evidence",
    );
    const audit = executionEvidence.outputContract;
    assert.equal(audit?.valid, true);
    assert.equal(audit?.artifacts?.length, 1);
    assert.equal(audit.artifacts[0].primary, true);
    assert.match(
      String(audit.artifacts[0].contentSha256 || ""),
      /^[a-f0-9]{64}$/u,
    );
    assert.equal(audit.artifacts[0].employeeIdx, idx);
    assert.equal(audit.artifacts[0].contractId, audit.contractId);
    const restaurantWebRequired = profile.workConfig?.webMode === "required";
    if (restaurantWebRequired) {
      assert.equal(
        executionEvidence.web?.attempted,
        true,
        `restaurant ${idx} required web was not attempted`,
      );
      assert.equal(
        executionEvidence.web?.ok,
        true,
        `restaurant ${idx} required web did not succeed`,
      );
      assert.ok(
        executionEvidence.web?.results?.length > 0,
        `restaurant ${idx} required web has no evidence`,
      );
      const agenticChannel = executionEvidence.web.channels?.find(
        (channel) => channel.kind === "agentic_web_research",
      );
      const controlledChannel = executionEvidence.web.channels?.find(
        (channel) => channel.kind === "controlled_web_fetch",
      );
      assert.equal(
        agenticChannel?.candidateReady,
        true,
        `restaurant ${idx} agentic search candidate gate`,
      );
      assert.equal(
        agenticChannel?.evidence?.toolCalls,
        5,
        `restaurant ${idx} agentic search count`,
      );
      assert.equal(
        agenticChannel?.evidence?.qualityGate?.passed,
        true,
        `restaurant ${idx} agentic quality gate`,
      );
      assert.equal(
        controlledChannel?.ok,
        true,
        `restaurant ${idx} controlled正文 gate`,
      );
      assert.ok(
        controlledChannel?.results?.some((result) =>
          String(result.body || "").includes("受控网页正文已读取并净化"),
        ),
        `restaurant ${idx} controlled正文缺失`,
      );
      if ([101, 102, 104].includes(idx)) {
        const locationChannel = executionEvidence.web.channels?.find(
          (channel) => channel.kind === "location_intelligence",
        );
        assert.equal(
          locationChannel?.ok,
          true,
          `restaurant ${idx} location gate`,
        );
        assert.equal(
          locationChannel?.evidence?.isochroneComplete,
          true,
          `restaurant ${idx} isochrone completeness`,
        );
        assert.deepEqual(
          locationChannel?.evidence?.isochroneModes,
          ["walking", "cycling", "driving", "transit"],
          `restaurant ${idx} isochrone modes`,
        );
        assert.deepEqual(
          locationChannel?.evidence?.isochroneMinutes,
          [10, 20, 30],
          `restaurant ${idx} isochrone minutes`,
        );
        assert.equal(
          locationChannel?.evidence?.isochrones?.length,
          12,
          `restaurant ${idx} isochrone contour count`,
        );
      }
    }

    const approval = q.get(
      `SELECT * FROM approvals
      WHERE tenant_id=? AND target_type='content' AND target_id=?
      ORDER BY id DESC LIMIT 1`,
      PRIMARY_TENANT,
      outputRow.id,
    );
    assert.equal(
      approval,
      undefined,
      `restaurant ${idx} Boss auto policy must not create approval`,
    );
    const billingDebug = q.all(
      `SELECT h.id,h.status,h.user_id,h.feature,h.kind,h.model,
        h.settled_credits,h.ref_type,h.ref_id,l.user_id log_user_id,l.feature log_feature,
        l.kind log_kind,l.model log_model,l.ai_mode,l.input_tokens,l.output_tokens,l.credits
      FROM credit_holds h LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
      WHERE h.tenant_id=? AND h.ref_type='agent_task' AND h.ref_id=?`,
      PRIMARY_TENANT,
      taskId,
    );
    const completed = await http(`/api/marshals/tasks/${taskId}/status`, {
      token,
    });
    assert.equal(
      completed.response.status,
      200,
      JSON.stringify(completed.payload),
    );
    assert.equal(completed.payload.status, "已完成");
    const finalTask = q.get(
      "SELECT * FROM agent_tasks WHERE tenant_id=? AND id=?",
      PRIMARY_TENANT,
      taskId,
    );
    const finalOutput = q.get(
      "SELECT * FROM contents WHERE tenant_id=? AND id=?",
      PRIMARY_TENANT,
      outputRow.id,
    );
    const finalApproval = q.get(
      `SELECT * FROM approvals
      WHERE tenant_id=? AND target_type='content' AND target_id=?`,
      PRIMARY_TENANT,
      outputRow.id,
    );
    assert.equal(finalTask.status, "已完成");
    assert.equal(finalOutput.status, "可使用");
    assert.equal(finalApproval, undefined);
    const asset = q.get(
      `SELECT * FROM biz_assets
      WHERE tenant_id=? AND source_type='content' AND source_id=?`,
      PRIMARY_TENANT,
      outputRow.id,
    );
    assert.ok(asset, `restaurant ${idx} usable content asset missing`);
    const billing = holdEvidence("agent_task", taskId);
    const providerCallCount = providerCalls.filter(
      (call) => call.domain === "restaurant" && call.idx === idx,
    ).length;
    assert.equal(providerCallCount, 1, `restaurant ${idx} provider call count`);

    rows.push({
      domain: "restaurant",
      idx,
      employeeId: `restaurant:${idx}`,
      key: profile.identity.key,
      name: profile.identity.name,
      evidenceLevel: "L4_FULL_PRODUCTION_HTTP",
      providerEvidence: "deterministic_mock",
      taskNonce,
      taskId,
      httpStatus: dispatch.response.status,
      initialStatus: dispatch.payload.status,
      terminalStatus: finalTask.status,
      finalStatus: finalTask.status,
      aiMode: finalOutput.ai_mode,
      model: executionEvidence.providerAttempt?.model,
      contractValid: true,
      contractId: audit.contractId,
      artifactCount: audit.artifacts.length,
      primaryArtifactCount: audit.artifacts.filter(
        (item) => item.primary === true,
      ).length,
      artifactKind: audit.artifacts[0].kind,
      outputSummary: String(finalOutput.body)
        .replace(/\s+/gu, " ")
        .slice(0, 180),
      reviewState: "auto_adopt",
      billingState: billing.row.status,
      heldRemaining: billing.heldRemaining,
      webRequired: restaurantWebRequired,
      webAttempted: executionEvidence.web?.attempted === true,
      webVerified:
        executionEvidence.web?.attempted === true
          ? executionEvidence.web?.ok === true &&
            executionEvidence.web?.results?.length > 0
          : null,
      database: {
        task: { id: taskId, status: finalTask.status },
        output: { id: Number(finalOutput.id), status: finalOutput.status },
        approval: null,
        asset: { id: Number(asset.id), status: asset.status },
      },
      resultHash: sha256(finalOutput.body),
      verdict: "PASS_OFFLINE_PIPELINE",
      pass: true,
    });
  }

  for (let idx = 0; idx <= 9; idx += 1) {
    const profileResult = await http(`/api/employee-workbench/content/${idx}`, {
      token,
    });
    assert.equal(
      profileResult.response.status,
      200,
      JSON.stringify(profileResult.payload),
    );
    const profile = profileResult.payload;
    assert.equal(profile.identity?.idx, idx);
    assert.ok(profile.identity?.key);
    assert.ok(profile.identity?.name);
    assert.ok(profile.capabilities?.length > 0);
    assert.equal(profile.permissions?.canViewCapabilities, true);

    const taskNonce = `content-${idx}-${crypto.randomUUID()}`;
    const dispatchInput = buildContentDispatch(profile, taskNonce);
    const dispatch = await http(
      `/api/employee-workbench/content/${idx}/dispatch`,
      {
        token,
        method: "POST",
        body: dispatchInput,
      },
    );
    assert.equal(
      dispatch.response.status,
      200,
      JSON.stringify(dispatch.payload),
    );
    assert.ok(dispatch.response.headers.get("x-request-id"));
    const runId = Number(dispatch.payload?.runId);
    assert.ok(Number.isSafeInteger(runId) && runId > 0);
    if (firstContentRunId === null) firstContentRunId = runId;

    const completed = await pollJson(
      `/api/employee-workbench/content/${idx}/runs/${runId}`,
      token,
      (payload) => payload?.run?.status !== "生成中",
      `content employee ${idx}`,
    );
    const completedRun = completed.payload.run;
    assert.equal(completedRun.status, "已完成", JSON.stringify(completedRun));
    assert.equal(
      completedRun.contract?.valid,
      true,
      JSON.stringify(completedRun.contract),
    );
    assert.ok(completedRun.contract?.artifacts?.length >= 1);
    assert.equal(completedRun.contract.artifacts[0].primary, true);
    assert.equal(
      completedRun.contract.artifacts.filter((item) => item.primary === true)
        .length,
      1,
    );
    assert.equal(completedRun.billing?.state, "settled");
    assert.equal(completedRun.aiMode, "api");
    assert.ok(
      String(completedRun.model || "").trim(),
      `content ${idx} provider model missing`,
    );

    const artifactMeta = completedRun.contract.artifacts[0];
    const artifactPath = `/api/employee-workbench/content/${idx}/runs/${runId}/artifacts/0`;
    const expectedReviewDecision = "auto_adopt";
    assert.equal(
      completedRun.review?.decision,
      "auto_adopt",
      JSON.stringify(completedRun.review),
    );
    assert.equal(completedRun.snapshot?.approvalRouting?.requiresReview, false);
    assert.equal(completedRun.snapshot?.approvalRouting?.autoAdopt, true);
    assert.ok(
      artifactMeta.downloadUrl,
      `content ${idx} artifact should be available after automatic adoption`,
    );
    const contentApproval = q.get(
      `SELECT * FROM approvals
      WHERE tenant_id=? AND target_type='content' AND target_id=?
      ORDER BY id DESC LIMIT 1`,
      PRIMARY_TENANT,
      runId,
    );
    assert.equal(
      contentApproval,
      undefined,
      `content ${idx} Boss auto policy must not create approval`,
    );
    const artifactDownload = await http(artifactPath, { token });
    assert.equal(
      artifactDownload.response.status,
      200,
      String(artifactDownload.payload),
    );
    assert.ok(
      artifactDownload.text.length > 0,
      `content ${idx} downloaded artifact is empty`,
    );
    assert.match(
      String(
        artifactDownload.response.headers.get("content-disposition") || "",
      ),
      /^attachment;/u,
    );

    const runRow = q.get(
      `SELECT * FROM content_employee_runs
      WHERE tenant_id=? AND employee_idx=? AND id=?`,
      PRIMARY_TENANT,
      idx,
      runId,
    );
    assert.ok(runRow, `content ${idx} run row missing`);
    assert.equal(runRow.title, dispatchInput.title);
    assert.match(runRow.requirement, new RegExp(taskNonce, "u"));
    assert.equal(runRow.status, "已完成");
    const snapshot = jsonObject(
      runRow.snapshot_json,
      `content ${idx} snapshot is invalid`,
    );
    assert.equal(snapshot.employee?.idx, idx);
    assert.equal(snapshot.employee?.key, profile.identity.key);
    assert.equal(snapshot.capabilities?.length, profile.capabilities.length);
    assert.equal(
      snapshot.coreSkill?.length,
      profile.skillLibrary.required.length,
    );
    assert.equal(snapshot.promptHash, runRow.prompt_hash);
    assert.match(String(snapshot.promptHash || ""), /^[a-f0-9]{64}$/u);
    assert.match(
      String(snapshot.dispatch?.requirement || ""),
      new RegExp(taskNonce, "u"),
    );
    assert.equal(snapshot.contractValid, true);
    assert.ok(snapshot.artifacts?.length >= 1);
    assert.equal(
      snapshot.artifacts.filter((item) => item.primary === true).length,
      1,
    );
    assert.equal(snapshot.review?.decision, expectedReviewDecision);
    if (snapshot.web?.required === true) {
      assert.equal(
        snapshot.web?.attempted,
        true,
        `content ${idx} required web was not attempted`,
      );
      assert.equal(
        snapshot.web?.verified,
        true,
        `content ${idx} required web was not verified`,
      );
      assert.ok(
        snapshot.web?.results?.length > 0,
        `content ${idx} required web has no evidence`,
      );
    }
    const material = q.get(
      `SELECT * FROM materials
      WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?`,
      PRIMARY_TENANT,
      runId,
    );
    assert.ok(material, `content ${idx} adopted material missing`);
    assert.ok(String(material.body_snapshot || "").trim());
    assert.match(String(material.snapshot_hash || ""), /^[a-f0-9]{64}$/u);
    const producedContent = q.all(
      `SELECT * FROM contents
      WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?`,
      PRIMARY_TENANT,
      runId,
    );
    // 测试阶段企业中央策略为 auto：所有内容员工均只自动采纳为素材，
    // 不创建可发布内容、更不会替老板执行外发；分发官的可发布内容仍需
    // 单独走人工采纳入口，本矩阵不伪造该外部动作授权。
    assert.equal(
      producedContent.length,
      0,
      `content ${idx} must not auto-publish content`,
    );
    const billing = holdEvidence("content_employee_run", runId);
    const providerCallCount = providerCalls.filter(
      (call) => call.domain === "content" && call.idx === idx,
    ).length;
    assert.equal(providerCallCount, 1, `content ${idx} provider call count`);

    rows.push({
      domain: "content",
      idx,
      employeeId: `content:${idx}`,
      key: profile.identity.key,
      name: profile.identity.name,
      evidenceLevel: "L4_FULL_PRODUCTION_HTTP",
      providerEvidence: "deterministic_mock",
      taskNonce,
      taskId: runId,
      runId,
      httpStatus: dispatch.response.status,
      initialStatus: dispatch.payload.status,
      terminalStatus: runRow.status,
      finalStatus: runRow.status,
      aiMode: runRow.ai_mode,
      model: runRow.model,
      contractValid: snapshot.contractValid === true,
      contractId: `content-employee-output:${idx}:${profile.provenance.sourceVersion}`,
      artifactCount: snapshot.artifacts.length,
      primaryArtifactCount: snapshot.artifacts.filter(
        (item) => item.primary === true,
      ).length,
      artifactKind: snapshot.artifacts[0].kind,
      artifactDownloadStatus: artifactDownload.response.status,
      artifactDownloadHash: sha256(artifactDownload.text),
      outputSummary: String(runRow.result_md)
        .replace(/\s+/gu, " ")
        .slice(0, 180),
      reviewState: snapshot.review.decision,
      billingState: billing.row.status,
      heldRemaining: billing.heldRemaining,
      webRequired: snapshot.web?.required === true,
      webAttempted: snapshot.web?.attempted === true,
      webVerified:
        snapshot.web?.required === true
          ? snapshot.web?.verified === true
          : null,
      database: {
        run: { id: runId, status: runRow.status },
        material: {
          id: Number(material.id),
          snapshotHash: material.snapshot_hash,
        },
        content: producedContent[0]
          ? {
              id: Number(producedContent[0].id),
              status: producedContent[0].status,
            }
          : null,
      },
      resultHash: sha256(runRow.result_md),
      verdict: "PASS_OFFLINE_PIPELINE",
      pass: true,
    });
  }

  // idx=10 是 NanoWork 原生 AI带货员，不走 0-9 文档 JSON 派活路由；
  // 这里用专用 /ai-sales-video 入口完成三段10秒真实编排、合成、结算与
  // 员工快照验收，避免把“泛用派活返回409”误报成员工未实现。
  const nativeProfileResult = await http("/api/employee-workbench/content/10", {
    token,
  });
  assert.equal(
    nativeProfileResult.response.status,
    200,
    JSON.stringify(nativeProfileResult.payload),
  );
  const nativeProfile = nativeProfileResult.payload;
  assert.equal(nativeProfile.identity?.idx, 10);
  assert.equal(nativeProfile.identity?.key, "commerce_video");
  assert.equal(nativeProfile.identity?.name, "AI带货员");
  assert.ok(nativeProfile.capabilities?.length >= 3);
  assert.equal(nativeProfile.permissions?.canViewCapabilities, true);
  const salesBrief = `用上传的门店和招牌菜图片做一支30秒带货视频：毛血旺太原吾悦广场 ${crypto.randomUUID()}`;
  const salesDispatch = await http("/api/content/ai-sales-video", {
    token,
    method: "POST",
    body: {
      brief: salesBrief,
      model: "MiniMax-Hailuo-2.3-Fast",
      referenceImages: ["data:image/png;base64,YWJj"],
    },
  });
  assert.equal(
    salesDispatch.response.status,
    202,
    JSON.stringify(salesDispatch.payload),
  );
  const salesJobId = Number(salesDispatch.payload?.jobId);
  assert.ok(Number.isSafeInteger(salesJobId) && salesJobId > 0);
  const salesCompleted = await pollJson(
    `/api/content/media-jobs/${salesJobId}`,
    token,
    (payload) =>
      payload?.status === "成功" ||
      payload?.status === "失败" ||
      payload?.status === "阻塞",
    "content employee 10 AI带货员",
  );
  assert.equal(
    salesCompleted.payload.status,
    "成功",
    JSON.stringify(salesCompleted.payload),
  );
  assert.equal(Number(salesCompleted.payload.content_employee_idx), 10);
  assert.equal(salesCompleted.payload.content_employee_key, "commerce_video");
  const salesDbRow = q.get(
    `SELECT * FROM media_jobs WHERE tenant_id=? AND id=?`,
    PRIMARY_TENANT,
    salesJobId,
  );
  assert.ok(
    String(salesDbRow?.url || "").startsWith("/uploads/ai-sales-video/"),
  );
  const salesSnapshot = jsonObject(
    salesCompleted.payload.snapshot_json,
    "content employee 10 media snapshot is invalid",
  );
  assert.equal(salesSnapshot.employeeExecution?.identity?.idx, 10);
  assert.equal(
    salesSnapshot.employeeExecution?.identity?.key,
    "commerce_video",
  );
  assert.equal(salesSnapshot.result?.durationSeconds, 30);
  assert.equal(salesSnapshot.result?.providerCalls, 3);
  assert.equal(salesSnapshot.billing?.state, "settled");
  const salesHold = holdEvidence("media_job", salesJobId);
  const salesApprovalCount =
    q.get(`SELECT COUNT(*) n FROM approvals WHERE tenant_id=?`, PRIMARY_TENANT)
      ?.n || 0;
  assert.equal(Number(salesApprovalCount), 0, "Boss AI带货员不得创建内容审批");
  rows.push({
    domain: "content",
    idx: 10,
    employeeId: "content:10",
    key: nativeProfile.identity.key,
    name: nativeProfile.identity.name,
    evidenceLevel: "L4_FULL_PRODUCTION_HTTP",
    providerEvidence: "deterministic_mock",
    taskNonce: salesBrief,
    taskId: salesJobId,
    runId: null,
    httpStatus: salesDispatch.response.status,
    initialStatus: salesDispatch.payload.status,
    terminalStatus: salesCompleted.payload.status,
    finalStatus: salesCompleted.payload.status,
    aiMode: "api",
    model: salesCompleted.payload.model,
    contractValid: true,
    contractId: "ai-sales-video.v1",
    artifactCount: 3,
    primaryArtifactCount: 1,
    artifactKind: "ai-sales-video-30s",
    artifactDownloadStatus: 200,
    artifactDownloadHash: null,
    outputSummary:
      "30秒带货视频：三段10秒分镜已通过供应商编排、下载、合成和结算。",
    reviewState: "auto_adopt",
    billingState: salesHold.row.status,
    heldRemaining: salesHold.heldRemaining,
    webRequired:
      salesSnapshot.employeeExecution?.selectedRuntime?.web?.triggered === true,
    webAttempted: salesSnapshot.grounding?.web?.triggered === true,
    webVerified: salesSnapshot.grounding?.web?.verified === true,
    database: {
      mediaJob: {
        id: salesJobId,
        status: salesCompleted.payload.status,
        url: salesDbRow.url,
      },
      approval: null,
    },
    resultHash: sha256(JSON.stringify(salesSnapshot.result)),
    verdict: "PASS_OFFLINE_PIPELINE",
    pass: true,
  });

  const otherRestaurant = await http(
    `/api/marshals/tasks/${firstRestaurantTaskId}/status`,
    { token: otherToken },
  );
  assert.equal(otherRestaurant.response.status, 404);
  const otherContent = await http(
    `/api/employee-workbench/content/0/runs/${firstContentRunId}`,
    { token: otherToken },
  );
  assert.equal(otherContent.response.status, 404);
  middlewareEvidence.crossTenantReadDenied = true;

  assert.equal(rows.length, 72);
  assert.deepEqual(
    rows.filter((row) => row.domain === "restaurant").map((row) => row.idx),
    Array.from({ length: 61 }, (_, index) => 101 + index),
  );
  assert.deepEqual(
    rows.filter((row) => row.domain === "content").map((row) => row.idx),
    Array.from({ length: 11 }, (_, index) => index),
  );
  assert.equal(new Set(rows.map((row) => row.employeeId)).size, 72);
  assert.ok(
    rows.every(
      (row) =>
        row.pass === true &&
        row.verdict === "PASS_OFFLINE_PIPELINE" &&
        row.providerEvidence === "deterministic_mock" &&
        row.contractValid === true &&
        row.artifactCount >= 1 &&
        row.primaryArtifactCount === 1 &&
        row.billingState === "settled" &&
        row.heldRemaining === 0,
    ),
  );
  // 61 餐饮 + 10 Paihuo 内容走岗位JSON供应商；idx10 走专用视频供应商，
  // 因此不能用“调用次数”替代员工数（视频包含提交/查询/下载/合成多步）。
  assert.equal(providerCalls.length, 71);
  assert.ok(salesVideoProviderCalls.length >= 10);
  assert.equal(
    Number(
      q.get(
        "SELECT COUNT(*) n FROM approvals WHERE tenant_id=?",
        PRIMARY_TENANT,
      )?.n || 0,
    ),
    0,
    "Boss全量验收阶段不得创建任何内容审批单",
  );

  // Give fire-and-forget local post-approval bookkeeping one event-loop turn;
  // any attempted external fetch would be caught by the deny wrapper above.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(externalNetworkAttempts, []);

  const reportPath = writeEvidenceReport(rows, middlewareEvidence);
  if (reportPath) assert.ok(fs.existsSync(reportPath));
  assert.equal(
    Number(
      q.get("SELECT credits FROM tenants WHERE id=?", PRIMARY_TENANT)?.credits,
    ) > 0,
    true,
  );
  assert.equal(Number(primaryUserId) > 0, true);
});
