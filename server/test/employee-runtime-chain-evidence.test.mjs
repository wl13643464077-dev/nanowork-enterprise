import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const DB_PATH = path.join(
  os.tmpdir(),
  `nanowork-employee-runtime-chain-${process.pid}.db`,
);
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  fs.rmSync(file, { force: true });
}

process.env.NANOWORK_DB = DB_PATH;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.BOCHA_API_KEY = "";
process.env.TAVILY_API_KEY = "";
process.env.SERPER_API_KEY = "";
process.env.ENABLE_BACKGROUND_EMBEDDINGS = "false";
process.env.ENABLE_SCHEDULER = "false";
process.env.SEED_DEMO = "false";

const { initSchema, migrateV2, runWithTenant } =
  await import("../src/db.js");
const { ensureBaselineCatalogs } = await import("../src/baseline.js");
const {
  buildEmployeeExecutionProfile,
  updateEmployeePrompt,
} = await import("../src/employee-workbench.js");
const { marshalWork } = await import("../src/engines/ai.js");
const { collectLocationIntelligence } =
  await import("../src/engines/location-intelligence.js");
const { compileEmployeePublicResearchPlan } =
  await import("../src/engines/employee-public-research-plan.js");
const { buildRestaurantOutputDeliverableFixture } =
  await import("../src/engines/restaurant-output-contract.js");

initSchema();
migrateV2();
ensureBaselineCatalogs();
migrateV2();

after(() => {
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    fs.rmSync(file, { force: true });
  }
});

const manager = Object.freeze({
  id: 1,
  role: "boss",
  tenant_id: 1,
});
const marshal = Object.freeze({
  code: "M-01",
  name: "战略与开店筹备部",
  title: "内部调度容器",
  duty: "仅负责调度，不替代指定数字员工",
  skills: "",
  prompt: "",
  kb_deps: "",
});
const ISOCHRONE_MODES = Object.freeze([
  "walking",
  "cycling",
  "driving",
  "transit",
]);
const ISOCHRONE_MINUTES = Object.freeze([10, 20, 30]);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function assertCompleteEmployeeInputsLoaded(execution, idx) {
  const { workbench, snapshot, systemContext } = execution;
  const load = snapshot.runtimePackageLoad;
  assert.deepEqual(load.loadedFields, load.requiredFields);
  assert.equal(load.allRequiredFieldsLoaded, true);
  assert.equal(load.fullCanonicalObjectPersistedInSnapshot, true);
  assert.equal(load.promptTextIncludedInSystemMessage, true);
  assert.equal(load.workConfigIncludedInSystemMessage, true);
  assert.equal(load.jobProfileIncludedInSystemMessage, true);
  assert.equal(load.contractsIncludedInCanonicalObject, true);
  assert.equal(load.permissionsIncludedInCanonicalObject, true);
  for (const field of load.requiredFields) {
    assert.ok(
      Object.hasOwn(snapshot.canonicalProfile, field),
      `员工${idx}权威运行快照缺少输入域 ${field}`,
    );
    assert.match(
      String(load.fieldFingerprints[field] || ""),
      /^sha256:[a-f0-9]{64}$/u,
      `员工${idx}输入域 ${field} 没有可核验指纹`,
    );
  }

  assert.equal(load.capabilityCount, workbench.capabilities.length);
  for (const capability of workbench.capabilities) {
    assert.ok(systemContext.includes(capability.name));
    assert.ok(systemContext.includes(capability.description));
  }

  assert.ok(systemContext.includes(workbench.workMethod.manualMarkdown));
  for (const value of [
    ...workbench.workMethod.requiredInputs,
    ...workbench.workMethod.steps,
    ...workbench.workMethod.deliverables,
    ...workbench.workMethod.qualityGates,
    ...workbench.workMethod.safetyBoundaries,
  ]) {
    assert.ok(
      systemContext.includes(value),
      `员工${idx}完整岗位手册输入没有进入system：${value}`,
    );
  }

  assert.equal(load.enabledSkillCount, snapshot.skills.length);
  for (const skill of snapshot.skills) {
    assert.ok(systemContext.includes(skill.title));
    assert.ok(systemContext.includes(skill.detail));
    assert.ok(systemContext.includes(skill.source));
  }

  assert.ok(systemContext.includes(JSON.stringify(workbench.workConfig)));
  assert.ok(systemContext.includes(execution.outputContract.instruction));
  for (const requirement of Object.values(
    execution.outputContract.workProductRequirements,
  )) {
    assert.ok(systemContext.includes(requirement.deliverableName));
    for (const label of requirement.coverageLabels) {
      assert.ok(systemContext.includes(label));
    }
  }
  if (workbench.prompts.override) {
    assert.ok(systemContext.includes(workbench.prompts.override));
  }
  assert.equal(
    workbench.prompts.effectiveHash,
    sha256(workbench.prompts.effectiveTemplate),
  );
}

function taskFor(idx) {
  return {
    title: `USER_ONLY_TASK_${idx} 太原吾悦广场毛血旺`,
    type: "分析",
    requirement:
      "核验当前商圈、竞品、菜单、价格和真实路网等时圈，只形成内部报告，不执行外部动作。",
  };
}

function directRestaurantSource(idx) {
  return {
    title: `大众点评·太原吾悦广场毛血旺门店${idx}`,
    url: `https://www.dianping.com/shop/runtime-chain-${idx}`,
    snippet:
      "太原吾悦广场毛血旺餐厅菜单、菜品、价格、营业状态、评价与外卖公开商户正文。",
  };
}

function agenticEvidence(idx) {
  const candidates = Array.from({ length: 5 }, (_unused, index) => ({
    title: `太原吾悦广场毛血旺公开候选${idx}-${index + 1}`,
    url: `https://agentic.test/runtime-chain/${idx}/${index + 1}`,
    snippet: `太原吾悦广场毛血旺餐厅菜单、价格、营业状态、评价与竞品公开候选${index + 1}`,
  }));
  return {
    attempted: true,
    ok: true,
    candidateReady: true,
    provider: "runtime-fixture-agentic-websearch",
    results: candidates,
    fetchCandidates: candidates,
    evidence: {
      schemaVersion: "nanowork.agentic-web-research/1",
      executionMode: "isolated_runtime_fixture",
      toolCalls: 5,
      toolAttempts: 5,
      toolResults: candidates.map((_candidate, index) => ({
        toolUseId: `runtime-search-${idx}-${index + 1}`,
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
      candidateGate: {
        requiredSearches: 5,
        requiredSuccessfulToolResults: 5,
        requiredToolResultUrls: 5,
        requiredCandidates: 5,
        observedSearches: 5,
        observedSuccessfulToolResults: 5,
        observedToolResultUrls: 5,
        observedCandidates: 5,
        passed: true,
        requiresControlledWebFetch: true,
      },
      queries: candidates.map((_candidate, index) =>
        `runtime-agentic-query-${idx}-${index + 1}`,
      ),
      facts: [],
      gaps: [],
      externalCall: true,
    },
  };
}

function mapFetchFixture(idx, calls) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ idx, url: url.toString(), hostname: url.hostname, init });
    if (url.hostname === "nominatim.openstreetmap.org") {
      return {
        ok: true,
        async json() {
          return [
            {
              osm_type: "way",
              osm_id: 8800 + idx,
              lat: "37.8714583",
              lon: "112.5131159",
              display_name: "太原吾悦广场，万柏林区，太原市，山西省",
              address: { city: "太原市", suburb: "万柏林区" },
            },
          ];
        },
      };
    }
    if (url.hostname.includes("overpass")) {
      return {
        ok: true,
        async json() {
          return {
            elements: [
              {
                type: "node",
                id: 8900 + idx,
                lat: 37.872,
                lon: 112.514,
                tags: {
                  name: `吾悦广场毛血旺竞品${idx}`,
                  amenity: "restaurant",
                  cuisine: "川菜",
                },
              },
            ],
          };
        },
      };
    }
    throw new Error(`地图夹具收到未授权provider：${url.hostname}`);
  };
}

function isochroneProvider(request = {}) {
  const modes = request.modes || ISOCHRONE_MODES;
  const minutes = request.minutes || ISOCHRONE_MINUTES;
  return {
    provider: "runtime-fixture-valhalla",
    source: "https://valhalla1.openstreetmap.de/isochrone",
    externalCall: true,
    isochrones: modes.flatMap((mode, modeIndex) =>
      minutes.map((minutesValue, minuteIndex) => {
        const delta = 0.001 + (modeIndex + minuteIndex) * 0.0001;
        return {
          mode,
          minutes: minutesValue,
          provider: "runtime-fixture-valhalla",
          source: `https://valhalla1.openstreetmap.de/isochrone/${mode}/${minutesValue}`,
          polygon: {
            type: "Polygon",
            coordinates: [
              [
                [112.513 - delta, 37.871 - delta],
                [112.513 + delta, 37.871 - delta],
                [112.513 + delta, 37.871 + delta],
                [112.513 - delta, 37.871 + delta],
                [112.513 - delta, 37.871 - delta],
              ],
            ],
          },
        };
      }),
    ),
  };
}

function validProviderOutput(idx, task, directSource) {
  const fixture = structuredClone(
    buildRestaurantOutputDeliverableFixture(idx, task),
  );
  fixture.decision_context.problem = `${task.title}：${fixture.decision_context.problem}`;
  fixture.decision_context.sources[0].source =
    `${directSource.title}｜${directSource.url}`;
  for (const item of Object.values(fixture.input_audit || {})) {
    item.evidence_refs = [fixture.decision_context.sources[0].source];
  }
  for (const item of Object.values(fixture.method_execution || {})) {
    item.evidence_refs = [fixture.decision_context.sources[0].source];
  }
  return fixture;
}

test(
  "101/102运行链实际消费API工具、技能计划与岗位system；高德仅为公开页面技能而非官方API",
  { concurrency: false },
  async () => {
    const evidence = [];

    for (const idx of [101, 102]) {
      const privateOverride = `INTERNAL_SYSTEM_ONLY_${idx}_不要进入用户消息或联网查询`;
      runWithTenant(1, () =>
        updateEmployeePrompt(idx, privateOverride, manager),
      );
      const execution = runWithTenant(1, () =>
        buildEmployeeExecutionProfile(idx, {
          tenantId: 1,
          user: manager,
        }),
      );
      const task = taskFor(idx);
      const expectedPlan = compileEmployeePublicResearchPlan(execution, task);
      const currentBindings =
        execution.workbench.runtimeBindings.currentRuntimeBindings;

      assertCompleteEmployeeInputsLoaded(execution, idx);

      assert.equal(execution.promptHash, sha256(execution.systemContext));
      assert.equal(execution.snapshot.promptHash, execution.promptHash);
      assert.equal(
        execution.snapshot.runtimePackageLoad
          .runtimeBindingsManifestInSystemMessage,
        true,
      );
      assert.equal(
        execution.snapshot.runtimePackageLoad.apiBindingCount,
        currentBindings.apis.length,
      );
      assert.equal(
        execution.snapshot.runtimePackageLoad.toolBindingCount,
        currentBindings.tools.length,
      );
      for (const [id, binding] of [
        ["web_research", "employeeAgenticWebResearch"],
        ["controlled_page_evidence", "employeeControlledWebFetch"],
        ["location_intelligence", "employeeLocationIntelligence"],
      ]) {
        assert.ok(
          currentBindings.apis.some(
            (api) => api.id === id && api.binding === binding,
          ),
          `员工${idx}缺少运行API ${id}`,
        );
        assert.ok(
          execution.systemContext.includes(
            `"id":"${id}","binding":"${binding}"`,
          ),
          `员工${idx}的运行API ${id}没有进入system绑定清单`,
        );
      }
      assert.ok(
        currentBindings.tools.some(
          (tool) =>
            tool.id === "agentic_web_search" && tool.required === true,
        ),
      );
      assert.ok(
        currentBindings.tools.some(
          (tool) =>
            tool.id === "controlled_page_evidence" &&
            tool.required === true,
        ),
      );
      assert.ok(
        currentBindings.tools.some(
          (tool) =>
            tool.id === "location_intelligence" && tool.required === true,
        ),
      );

      const claimedRuntimeIds = [
        ...currentBindings.apis.map((item) => item.id),
        ...currentBindings.tools.map((item) => item.id),
      ];
      assert.equal(
        claimedRuntimeIds.some((id) => /amap|gaode|高德/iu.test(id)),
        false,
        "当前运行绑定没有高德官方API，不得把高德公开页面技能写成API能力",
      );
      assert.deepEqual(expectedPlan.apiClaims, []);
      if (idx === 102) {
        const amapLane = expectedPlan.lanes.find(
          (lane) => lane.key === "amap",
        );
        assert.ok(amapLane, "员工102的高德公开页面技能必须进入取证计划");
        assert.deepEqual(amapLane.sourceSkillIds, [
          "legacy-skill:v1:e102:s001",
        ]);
        assert.match(amapLane.query, /高德地图\s+扫街榜\s+门店/u);
      } else {
        assert.equal(
          expectedPlan.lanes.some((lane) => lane.key === "amap"),
          false,
          "员工101没有高德技能，不应借用102的取证车道",
        );
      }

      const mapCalls = [];
      const agenticCalls = [];
      const controlledCalls = [];
      const genericCalls = [];
      const generationCalls = [];
      const directSource = directRestaurantSource(idx);
      const result = await runWithTenant(1, () =>
        marshalWork(marshal, task, "boss", {
          employeeExecution: execution,
          requireAgenticResearch: true,
          agenticWebResearchFn: async (query, options = {}) => {
            agenticCalls.push({ query, options });
            return agenticEvidence(idx);
          },
          webSearchFn: async (query, options = {}) => {
            genericCalls.push({ query, options });
            return {
              attempted: true,
              ok: true,
              provider: "runtime-fixture-public-page-search",
              results: [directSource],
              evidence: { externalCall: true },
            };
          },
          controlledWebFetchFn: async (sources, options = {}) => {
            controlledCalls.push({ sources, options });
            return {
              attempted: true,
              ok: true,
              provider: "runtime-fixture-controlled-page-evidence",
              results: [
                {
                  ...directSource,
                  body: `受控网页正文${idx}：太原吾悦广场毛血旺菜单、价格、营业状态和评价已从公开商户页面抽取；未知字段保留复核动作。`,
                },
                ...sources
                  .filter((source) => source.url !== directSource.url)
                  .map((source) => ({
                    ...source,
                    body: `受控网页正文${idx}：${source.title}已读取并净化，仅作为本轮公开证据。`,
                  })),
              ],
              evidence: {
                schemaVersion: "nanowork.controlled-web-evidence/1",
                requested: sources.length,
                fetched: sources.length,
                failures: [],
                externalCall: true,
                ssrfProtected: true,
                redirectsRevalidated: true,
              },
            };
          },
          locationIntelligenceFn: async (query, options = {}) =>
            collectLocationIntelligence(query, {
              ...options,
              timeoutMs: 100,
              fetchImpl: mapFetchFixture(idx, mapCalls),
              isochroneProvider,
            }),
          generateFn: async (args) => {
            generationCalls.push(args);
            return {
              text: JSON.stringify(
                validProviderOutput(idx, task, directSource),
              ),
              mode: "api",
              model: `runtime-chain-model-${idx}`,
              usage: { inputTokens: 101, outputTokens: 202 },
            };
          },
        }),
      );

      assert.equal(result.employeeContract.valid, true);
      assert.equal(agenticCalls.length, 1);
      assert.equal(controlledCalls.length, 1);
      assert.equal(generationCalls.length, 1);
      assert.ok(genericCalls.length >= 1);
      assert.deepEqual(result.web.skillResearchPlan, expectedPlan);
      assert.equal(
        result.web.skillResearchPlan.skillCount,
        execution.snapshot.skills.length,
      );
      assert.ok(
        result.web.skillResearchPlan.lanes
          .flatMap((lane) => lane.sourceSkillIds)
          .every((skillId) =>
            execution.snapshot.skills.some((skill) => skill.id === skillId),
          ),
        `员工${idx}取证计划只能引用本次快照技能`,
      );

      const agenticChannel = result.web.channels.find(
        (channel) => channel.kind === "agentic_web_research",
      );
      const controlledChannel = result.web.channels.find(
        (channel) => channel.kind === "controlled_web_fetch",
      );
      const locationChannel = result.web.channels.find(
        (channel) => channel.kind === "location_intelligence",
      );
      assert.equal(
        agenticChannel.provider,
        "runtime-fixture-agentic-websearch",
      );
      assert.equal(agenticChannel.evidence.toolCalls, 5);
      assert.equal(
        controlledChannel.provider,
        "runtime-fixture-controlled-page-evidence",
      );
      assert.equal(controlledChannel.evidence.ssrfProtected, true);
      assert.equal(
        locationChannel.provider,
        "OpenStreetMap Nominatim + Overpass + runtime-fixture-valhalla",
      );
      assert.equal(locationChannel.evidence.isochroneComplete, true);
      assert.equal(locationChannel.evidence.isochrones.length, 12);
      assert.deepEqual(
        mapCalls.map((call) => call.hostname),
        ["nominatim.openstreetmap.org", "overpass-api.de"],
      );
      assert.ok(
        mapCalls.every((call) => !/amap|gaode/iu.test(call.hostname)),
        "高德公开页面技能不得偷偷改写地点provider",
      );

      assert.match(
        agenticCalls[0].query,
        /不得伪称调用了未配置的官方API/u,
      );
      for (const lane of expectedPlan.lanes) {
        assert.match(agenticCalls[0].query, new RegExp(lane.label, "u"));
      }
      assert.doesNotMatch(
        agenticCalls[0].query,
        new RegExp(privateOverride, "u"),
      );
      assert.doesNotMatch(
        agenticCalls[0].query,
        /评分基于导航\/搜索\/到店\/收藏等真实行为/u,
        "技能详情只用于服务端编译车道，不得泄漏到公开搜索query",
      );
      if (idx === 102) {
        assert.ok(
          genericCalls.some((call) => /高德地图\s+扫街榜/u.test(call.query)),
          "102的高德公开页面技能必须实际驱动一条公开检索",
        );
      } else {
        assert.equal(
          genericCalls.some((call) => /高德地图\s+扫街榜/u.test(call.query)),
          false,
        );
      }

      const generation = generationCalls[0];
      const requiredSkill = execution.workbench.skillLibrary.required[0];
      assert.ok(generation.system.includes(execution.systemContext));
      assert.match(generation.system, new RegExp(privateOverride, "u"));
      assert.match(generation.system, new RegExp(requiredSkill.title, "u"));
      assert.match(generation.system, /完整岗位手册·必须执行/u);
      assert.match(generation.system, /当前运行绑定清单·已脱敏/u);
      assert.match(generation.userMsg, new RegExp(task.title, "u"));
      assert.match(generation.userMsg, /【受控网页正文】/u);
      assert.match(generation.userMsg, /OpenStreetMap定位/u);
      assert.doesNotMatch(
        generation.userMsg,
        new RegExp(privateOverride, "u"),
      );
      assert.doesNotMatch(
        generation.userMsg,
        new RegExp(requiredSkill.title, "u"),
      );
      assert.doesNotMatch(
        generation.userMsg,
        /派活统一权威员工对象|完整岗位手册·必须执行|技能库·本次启用/u,
      );
      assert.doesNotMatch(generation.system, new RegExp(task.title, "u"));

      evidence.push({
        idx,
        promptHash: execution.promptHash,
        skillCount: execution.snapshot.skills.length,
        planLanes: result.web.skillResearchPlan.lanes.map((lane) => lane.key),
        providers: result.web.channels.map((channel) => ({
          kind: channel.kind,
          provider: channel.provider,
        })),
        mapHosts: mapCalls.map((call) => call.hostname),
      });
    }

    assert.notEqual(evidence[0].promptHash, evidence[1].promptHash);
    assert.deepEqual(evidence[1].planLanes.includes("amap"), true);
    assert.deepEqual(evidence[0].planLanes.includes("amap"), false);
    console.log(`EMPLOYEE_RUNTIME_CHAIN_EVIDENCE ${JSON.stringify(evidence)}`);
  },
);
