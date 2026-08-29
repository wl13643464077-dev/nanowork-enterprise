/*
 * PaihuoAI toolbox runtime acceptance for NanoWork.
 *
 * This is an offline/source-level acceptance gate.  It deliberately does not
 * call a provider, the network, or the PaihuoAI application.  PaihuoAI is the
 * read-only golden source; any missing NanoWork runtime capability is emitted
 * as a machine-readable red point instead of being replaced by a template.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

process.env.NANOWORK_DB = ":memory:";
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
process.env.ENABLE_SCHEDULER = "false";
process.env.SEED_DEMO = "false";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, "..", "..");
const paihuoRoot = path.resolve(projectRoot, "..", "派活AI");

function readNano(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function readPaihuo(relativePath) {
  return fs.readFileSync(path.join(paihuoRoot, relativePath), "utf8");
}

const paihuoMain = readPaihuo("app/main.py");
const paihuoProviders = readPaihuo("app/providers.py");
const nanoToolbox = readNano("server/src/engines/toolbox.js");
const nanoToolboxRoute = readNano("server/src/routes/toolbox.js");
const nanoDb = readNano("server/src/db.js");
const nanoTaskCenter = readNano("server/src/engines/task-center.js");
const nanoTaskCenterRoute = readNano("server/src/routes/task-center.js");
const nanoToolboxUi = readNano("web/src/pages/Toolbox.tsx");
const { TOOL_DEFINITIONS, collectToolboxPublicResearch, generateToolboxRun } =
  await import("../src/engines/toolbox.js");

function blockBetween(source, startPattern, endPattern) {
  const start = source.search(startPattern);
  if (start < 0) return "";
  const tail = source.slice(start);
  const end = tail.search(endPattern);
  return end < 0 ? tail : tail.slice(0, end);
}

function toolTableDefinition(source) {
  return blockBetween(
    source,
    /CREATE TABLE IF NOT EXISTS tool_runs\s*\(/u,
    /\n\s*\);/u,
  );
}

function parsePaihuoMapping(name) {
  const match = paihuoMain.match(
    new RegExp(`${name}\\s*=\\s*\\{([\\s\\S]*?)\\}`, "u"),
  );
  return [...(match?.[1] || "").matchAll(/['"]([a-z]+)['"]\s*:/gu)].map(
    (item) => item[1],
  );
}

test("Paihuo 母版五类工具具备真实模型、联网受控正文、后台与退款边界（离线黄金断言）", () => {
  assert.deepEqual(parsePaihuoMapping("TOOL_KINDS"), [
    "hot",
    "pcal",
    "warm",
    "leads",
    "bench",
  ]);
  assert.deepEqual(parsePaihuoMapping("TOOL_REFUND"), [
    "hot",
    "pcal",
    "warm",
    "leads",
    "bench",
  ]);
  assert.deepEqual(parsePaihuoMapping("TOOL_TIMEOUTS"), [
    "hot",
    "pcal",
    "warm",
    "leads",
    "bench",
  ]);
  for (const fragment of [
    "_tool_enqueue",
    "_tool_worker",
    "_persist_tool_result",
    "_fail_tool_job",
    "refund_amount_if_claimed",
    "progress",
    "retry",
  ]) {
    assert.ok(
      paihuoMain.includes(fragment),
      `PaihuoAI 缺少 ${fragment} 运行边界`,
    );
  }
  assert.match(paihuoProviders, /_controlled_webfetch_evidence/u);
  assert.match(paihuoProviders, /linkgrab\.fetch_page_evidence/u);
});

test("Nano hot/warm/leads/bench 真实 agentic→controlled 研究链（注入离线夹具）", async () => {
  const calls = [];
  const agentic = async (query, options) => {
    calls.push({ type: "agentic", query, options });
    return {
      attempted: true,
      ok: true,
      candidateReady: true,
      provider: "offline-agentic-fixture",
      fetchCandidates: Array.from({ length: 5 }, (_, index) => ({
        title: `餐饮受控来源${index + 1}`,
        url: `https://www.dianping.com/shop/offline-toolbox-${index + 1}`,
        snippet: "菜单、营业、价格、评价与门店正文候选",
      })),
      evidence: { externalCall: false, toolCalls: 1 },
    };
  };
  const controlled = async (candidates, options) => {
    calls.push({ type: "controlled", candidates, options });
    return {
      attempted: true,
      ok: true,
      provider: "offline-controlled-fixture",
      results: candidates.map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.snippet,
        body: `${item.title}受控网页正文：菜单、菜品、营业时间、价格、人均、评价、外卖与门店状态；本段仅为离线验收证据，不代表真实经营事实。仅用于证明候选URL已经完成controlled正文读取。`,
      })),
      evidence: { externalCall: false, ssrfProtected: true },
    };
  };
  for (const key of ["hot", "warm", "leads", "bench"]) {
    const result = await collectToolboxPublicResearch(
      TOOL_DEFINITIONS[key],
      {
        store: "测试门店",
        channels: ["朋友圈"],
        focus: "测试重点",
        positioning: "测试定位",
        goal: "测试目标",
        city: "太原",
        product: "火锅",
        targets: "测试竞品",
        period: "近7天",
      },
      { agenticWebResearchFn: agentic, controlledWebFetchFn: controlled },
    );
    assert.equal(result.required, true, key);
    assert.equal(result.snapshot.status, "verified", key);
    assert.ok(result.sources.length >= 3, key);
    assert.ok(
      result.evidence.every((item) => item.bodyVerified === true),
      key,
    );
  }
  assert.equal(calls.filter((item) => item.type === "agentic").length, 4);
  assert.equal(calls.filter((item) => item.type === "controlled").length, 4);
  assert.ok(
    calls.every((item) => item.options?.externalCall !== true),
    "夹具不得触发外网",
  );
});

test("Nano pcal 使用真实模型策略且不接受模板（离线 provider 注入）", async () => {
  let captured;
  const result = await generateToolboxRun(
    TOOL_DEFINITIONS.pcal,
    { month: "2026-08", channels: ["朋友圈"], focus: "测试日历" },
    {
      aiAvailableFn: () => true,
      generateFn: async (args) => {
        captured = args;
        return {
          mode: "api",
          model: "offline-yunwu-test-model",
          text: JSON.stringify({
            days: Array.from({ length: 31 }, (_, index) => ({
              date: `2026-08-${String(index + 1).padStart(2, "0")}`,
              weekday: "由服务端重算",
              festival: "",
              moment: `第${index + 1}天朋友圈测试文案，发布前核验。`,
              group: "",
            })),
            tips: "本月按真实咨询与到店数据复盘。",
          }),
          usage: { inputTokens: 11, outputTokens: 7 },
        };
      },
    },
  );
  assert.equal(captured.providerPolicy, "yunwu_only");
  assert.equal(result.provenance.mode, "api");
  assert.equal(result.provenance.completionState, "completed");
  assert.notEqual(result.resultMd, "");
  assert.equal(result.provenance.usage.inputTokens, 11);
  assert.equal(result.provenance.usage.outputTokens, 7);
  assert.equal(result.provenance.attempts[0].reason, "accepted");
  assert.equal(result.provenance.structuredCalendar.days.length, 31);
  assert.match(result.resultMd, /2026-08-31/u);
});

test("Nano 工具箱按 Paihuo 母版运行验收：缺口保留为红测，不用 Markdown/模板冒充", () => {
  const redPoints = [];
  const addRed = (code, detail) => redPoints.push({ code, detail });
  const toolboxRuntime = `${nanoToolbox}\n${nanoToolboxRoute}`;
  const runBlock = blockBetween(
    nanoToolbox,
    /export async function generateToolboxRun\s*\(/u,
    /export function generateToolboxDraft\s*\(/u,
  );
  const toolTable = toolTableDefinition(nanoDb);
  const researchHook =
    /agenticWebResearch|WebSearch|fetchControlledWebEvidence|controlledWebEvidence|controlled-web-evidence/u;
  const researchManifest =
    /(?:RESEARCH_TOOL_KEYS|WEB_RESEARCH_TOOL_KEYS|AGENTIC_TOOL_KEYS|TOOLBOX_WEB_REQUIRED_KEYS|webRequired|researchMode|controlledMode)/u;

  // Paihuo's hot/warm/leads/bench are real research jobs.  A shared hook is
  // not enough: the four Nano tool definitions must opt into the contract.
  for (const key of ["hot", "warm", "leads", "bench"]) {
    const keyBlock = blockBetween(
      nanoToolbox,
      new RegExp(`\\b${key}:\\s*Object\\.freeze\\(\\{`, "u"),
      /\n\s*\}\),?/u,
    );
    const keyedResearch =
      researchManifest.test(keyBlock) ||
      new RegExp(
        `(?:RESEARCH_TOOL_KEYS|WEB_RESEARCH_TOOL_KEYS|AGENTIC_TOOL_KEYS|TOOLBOX_WEB_REQUIRED_KEYS)[\\s\\S]{0,800}['"]${key}['"]`,
        "u",
      ).test(nanoToolbox);
    if (!researchHook.test(toolboxRuntime) || !keyedResearch) {
      addRed(
        `NANOWORK_${key.toUpperCase()}_AGENTIC_CONTROLLED_MISSING`,
        `${key} 未绑定 WebSearch/agentic 候选→受控正文链；当前只能走本地模板或通用文本模型。`,
      );
    }
  }

  // pcal must use a real Yunwu model and the toolbox provider policy must be
  // fail-closed.  Keep both checks here so a future refactor cannot silently
  // reintroduce a fallback-chain/template provider.
  if (
    !/providerPolicy\s*:\s*['"]yunwu_only['"]/u.test(runBlock) &&
    !/providerPolicy\s*:\s*['"]yunwu_only['"]/u.test(nanoToolboxRoute)
  ) {
    addRed(
      "NANOWORK_PCAL_REAL_MODEL_POLICY_MISSING",
      "pcal 未以 providerPolicy=yunwu_only 强制真实模型；无法证明不是 fallback/template。",
    );
  }
  if (
    !/TOOLBOX_PROVIDER_NO_DELIVERY|不会返回模板底稿|template_only/u.test(
      runBlock,
    ) ||
    !/yunwu_only/u.test(toolboxRuntime)
  ) {
    addRed(
      "NANOWORK_TOOLBOX_YUNWU_ONLY_TEMPLATE_FALLBACK",
      "工具箱 generateToolboxRun 仍把模板作为供应商失败后的可接受路径；yunwu_only 失败应闭环为失败并退款。",
    );
  }

  // shot/remix are media jobs in the golden runtime.  Returning shotTemplate /
  // remixTemplate Markdown is not an image/video artifact and must not pass.
  const mediaArtifactHook =
    /generateImage|generateVideo|media_jobs|mediaJob|imagehunt|mimeType|artifactUrl|binaryArtifact/u;
  if (
    /shot:\s*shotTemplate/u.test(nanoToolbox) ||
    !mediaArtifactHook.test(toolboxRuntime)
  ) {
    addRed(
      "NANOWORK_SHOT_MARKDOWN_INSTEAD_OF_MEDIA",
      "shot 仍映射 shotTemplate Markdown，未调用图片生成/媒体产物 handler。",
    );
  }
  if (
    /remix:\s*remixTemplate/u.test(nanoToolbox) ||
    !mediaArtifactHook.test(toolboxRuntime)
  ) {
    addRed(
      "NANOWORK_MEDIA_MARKDOWN_INSTEAD_OF_ARTIFACT",
      "remix 仍映射 remixTemplate Markdown，未保存可预览的真实视频/媒体产物。",
    );
  }

  // The route currently executes inside the HTTP request.  Paihuo's queue
  // contract requires persisted progress, timeout recovery and a free retry.
  const requiredStatuses = ["queued", "running", "retrying", "done", "failed"];
  if (
    !requiredStatuses.every((status) =>
      new RegExp(`['"]${status}['"]`, "u").test(toolTable),
    )
  ) {
    addRed(
      "NANOWORK_TOOLBOX_BACKGROUND_STATUS_MISSING",
      "tool_runs 仅有 running/done/failed，缺 queued/retrying 等后台恢复状态。",
    );
  }
  if (!/(progress|current_step|step_index|steps_json)/u.test(toolTable)) {
    addRed(
      "NANOWORK_TOOLBOX_PROGRESS_NOT_PERSISTED",
      "tool_runs/tool_run_events 未持久化 progress/step，TaskCenter 无法显示后台执行到哪一步。",
    );
  }
  const hasBackgroundWorker =
    /(?:enqueueToolbox|toolboxQueue|setImmediate|setTimeout|jobRunner|workerLoop)/u.test(
      nanoToolboxRoute,
    );
  if (
    !hasBackgroundWorker ||
    /await\s+generateToolboxRun\s*\(/u.test(nanoToolboxRoute)
  ) {
    addRed(
      "NANOWORK_TOOLBOX_NOT_BACKGROUND_EXECUTED",
      "POST /toolbox/runs 直接 await generateToolboxRun，没有 Paihuo 式后台队列/worker。",
    );
  }
  if (
    !/(?:recoverToolbox|resumeToolbox|restartToolbox|heartbeat|timeout_recovery|last_heartbeat)/u.test(
      `${nanoToolboxRoute}\n${nanoDb}`,
    )
  ) {
    addRed(
      "NANOWORK_TOOLBOX_TIMEOUT_RECOVERY_MISSING",
      "未找到超时任务恢复/心跳/重启接口；running 记录可能永久挂起。",
    );
  }
  if (
    !/(?:r\.post\(\s*['"]\/runs\/:id\/retry|retryToolboxRun|freeRetry|retryRun)/u.test(
      `${nanoToolboxRoute}\n${nanoDb}`,
    )
  ) {
    addRed(
      "NANOWORK_TOOLBOX_FREE_RETRY_MISSING",
      "未提供失败任务的免费 retry endpoint/计数；当前只能重新 POST 并可能再次预授权。",
    );
  }

  // Existing Nano billing is a green baseline: usage and credit/cost evidence
  // are already carried through the two-phase hold/settle/release path.
  assert.match(nanoToolboxRoute, /estimateCallCredits/u);
  assert.match(nanoToolboxRoute, /holdCredits/u);
  assert.match(nanoToolboxRoute, /settleHold/u);
  assert.match(nanoToolboxRoute, /releaseHold/u);
  assert.match(nanoToolboxRoute, /provenance/u);
  assert.match(nanoToolboxRoute, /usage/u);
  assert.match(nanoTaskCenter, /FROM tool_runs/u);
  assert.match(nanoTaskCenter, /taskDeepLink/u);
  assert.match(nanoTaskCenterRoute, /getUnifiedTaskDetail/u);

  // TaskCenter can project a tool task, but Toolbox currently has no link to
  // `/tasks?kind=tool&id=...`; expose that missing hand-off separately.
  if (!/task-center|deepLink|\/tasks\?kind=tool/u.test(nanoToolboxRoute)) {
    addRed(
      "NANOWORK_TOOLBOX_TASK_CENTER_API_DEEPLINK_MISSING",
      "工具箱运行响应未返回 TaskCenter 深链，前端无法从运行结果一键跳转任务看板。",
    );
  }
  if (!/task-center|deepLink|\/tasks\?kind=tool/u.test(nanoToolboxUi)) {
    addRed(
      "NANOWORK_TOOLBOX_TASK_CENTER_UI_DEEPLINK_MISSING",
      "Toolbox.tsx 最近运行/结果抽屉没有 TaskCenter 深链入口。",
    );
  }

  console.log(
    `PAIHUO_TOOLBOX_RUNTIME_ACCEPTANCE_RED_POINTS ${JSON.stringify(redPoints)}`,
  );
  if (redPoints.length > 0) {
    assert.fail(
      `Nano 工具箱仍有 ${redPoints.length} 个 Paihuo 运行时红点；详见控制台 JSON`,
    );
  }
  assert.deepEqual(redPoints, []);
});
