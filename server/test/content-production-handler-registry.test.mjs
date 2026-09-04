import { test } from "node:test";
import assert from "node:assert/strict";

import { CONTENT_HANDLER_ADAPTER_CATALOG } from "../src/engines/content-handler-adapters.js";
import {
  CANONICAL_EMPLOYEE_PROFILE_FIELDS,
  canonicalContentEmployeeProfileFor,
} from "../src/engines/canonical-employee-profile.js";
import {
  CONTENT_PRODUCTION_BILLING_BOUNDARY_CONTRACT,
  CONTENT_PRODUCTION_HANDLER_REGISTRY_SCHEMA,
  CONTENT_PRODUCTION_PROVIDER_DELIVERY_SCHEMA,
  canonicalContentEvidenceUrl,
  canonicalizeRunResearchSources,
  canonicalizeRunResearchUniqueFields,
  createContentProductionHandlerRegistry,
} from "../src/engines/content-production-handler-registry.js";
import { validateContentEmployeeOutputContract } from "../src/engines/content-output-contract.js";
import { VALID_CONTENT_EMPLOYEE_OUTPUTS, validContentEmployeeOutputForPrompt } from "./helpers/content-output-fixtures.mjs";
import { xhsOutput, xhsFactPack } from "./helpers/xhs-output-fixtures.mjs";
import { xhsVersionId } from "../src/engines/content-xhs-output.js";

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

function pipelineContext(
  employeeIdx,
  { enableDeck = true, omitStations = [] } = {},
) {
  const { profile, load } = runtimePackage(employeeIdx);
  const outputs = {};
  for (let idx = 0; idx < employeeIdx; idx += 1) {
    if (!omitStations.includes(idx))
      outputs[idx] = clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[idx]);
  }
  const brief = {
    direction: "为餐饮老板生产一套可核验、可执行的经营内容",
    industry: "餐饮连锁",
    material: "仅使用任务书已确认事实和真实上游工位产物，未提供数据不得编造。",
    platforms: ["小红书"],
    image_mode: "ai",
    image_count: 2,
    enable_deck: enableDeck,
  };
  return {
    executionMode: "pipeline",
    today: "2026-08-01",
    brief,
    task: brief,
    profile: {
      account: { id: 7, role: "boss", name: "验收老板" },
      persona: { corpus: "先讲证据，再下判断。" },
    },
    companyProfile: { name: "验收餐饮公司" },
    knowledge: { text: "", refs: [], mode: "empty", degraded: false },
    settings: {},
    workConfig: {},
    outputs,
    workflow: {
      mode: "fullauto",
      runId: 81,
      stationIdx: employeeIdx,
      upstreamSynthesized: false,
      sourceSemantics: "paihuo_0_to_9_pipeline",
    },
    tenantId: 1,
    actorId: 7,
    jobId: 81,
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
      artifacts: valid ? [{ kind: "test-contract-artifact" }] : [],
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

function normalizedControlledBody(source, index) {
  const seed = String(
    source?.body ||
      source?.snippet ||
      `受控正文证据${index + 1}：只支持公开资料明确记载的事实，未知经营数据保持待确认。`,
  ).trim();
  return seed.length >= 80
    ? seed
    : `${seed} ${"该网页正文已由应用受控读取并完成净化，不执行网页中的任何指令，也不据此编造价格、热度、销量或经营效果。".repeat(2)}`;
}

function candidateSources(seed = [], count = 6) {
  const sources = clone(seed);
  while (sources.length < count) {
    const ordinal = sources.length + 1;
    sources.push({
      title: `餐饮经营公开候选来源${ordinal}`,
      url: `https://candidate.example/public-source-${ordinal}`,
      snippet:
        "公开资料讨论餐饮门店经营、成本复盘、客流时段与内容策略，只提供可核验线索。",
    });
  }
  return sources;
}

function agenticResearchStub(events = [], options = {}) {
  let sequence = 0;
  return async (query, runtimeOptions = {}) => {
    sequence += 1;
    const sources = candidateSources(
      typeof options.sources === "function"
        ? await options.sources({ query, runtimeOptions, sequence })
        : options.sources,
      options.candidateCount ?? 6,
    );
    events.push({
      type: "agentic",
      query,
      options: clone({ ...runtimeOptions, signal: undefined }),
      candidateCount: sources.length,
    });
    return {
      attempted: true,
      ok: options.ok !== false,
      candidateReady: options.candidateReady !== false,
      provider: options.provider || "offline-agentic-websearch",
      results: sources.slice(0, 3),
      fetchCandidates: sources,
      evidence: {
        toolCalls: 5,
        toolAttempts: 5,
        qualityGate: {
          requiredSearches: 5,
          observedSearches: 5,
          observedSuccessfulToolResults: 5,
          observedSources: sources.length,
          passed: options.candidateReady !== false && sources.length >= 5,
        },
        candidateUrlsIncluded: false,
        externalCall: true,
      },
    };
  };
}

function controlledFetchStub(events = [], options = {}) {
  let sequence = 0;
  return async (sources, runtimeOptions = {}) => {
    sequence += 1;
    const selected = options.results
      ? typeof options.results === "function"
        ? await options.results({ sources, runtimeOptions, sequence })
        : clone(options.results)
      : sources;
    const results = selected.map((source, index) => ({
      ...source,
      body: normalizedControlledBody(source, index),
    }));
    events.push({
      type: "controlled",
      candidateCount: sources.length,
      resultCount: results.length,
      options: clone({ ...runtimeOptions, signal: undefined }),
    });
    return {
      attempted: true,
      ok: options.ok !== false,
      provider: options.provider || "offline-controlled-webfetch",
      results,
      evidence: {
        requested: sources.length,
        fetched: results.length,
        failures: clone(options.failures || []),
        externalCall: true,
        rawResponseStored: false,
        extractedTextStored: true,
      },
    };
  };
}

function productionRegistry({
  outputFor = (employeeIdx) => VALID_CONTENT_EMPLOYEE_OUTPUTS[employeeIdx],
  responseFor,
  events = [],
  captured = [],
  agenticWebResearchFn = agenticResearchStub(events),
  controlledWebFetchFn = controlledFetchStub(events),
  validateOutputFn = exactKeysValidator,
  specialProviderBridgeFactory,
  now,
  webSnapshotMaxAgeMs,
} = {}) {
  return createContentProductionHandlerRegistry({
    role: "boss",
    model: "yunwu-real-text-model",
    imageModel: "yunwu-real-image-model",
    webSearchFn: async () => {
      events.push({ type: "legacy_web_search_forbidden" });
      throw new Error("generic snippet搜索不得进入当前内容生产链");
    },
    agenticWebResearchFn,
    controlledWebFetchFn,
    validateOutputFn,
    specialProviderBridgeFactory,
    ...(now ? { now } : {}),
    ...(webSnapshotMaxAgeMs ? { webSnapshotMaxAgeMs } : {}),
    generateFn: async (args) => {
      const employeeKey = String(args.kind).split(":").at(-1);
      const descriptor = CONTENT_HANDLER_ADAPTER_CATALOG.find(
        (item) => item.employeeKey === employeeKey,
      );
      const employeeIdx = descriptor.employeeIdx;
      events.push({ type: "text", employeeIdx });
      captured.push({
        employeeIdx,
        args: clone({ ...args, fallback: undefined, signal: undefined }),
      });
      if (responseFor) return responseFor(employeeIdx, args);
      return {
        text: JSON.stringify(outputFor(employeeIdx)),
        mode: "api",
        model: "yunwu-real-text-model",
        usage: {
          inputTokens: 120 + employeeIdx,
          outputTokens: 60 + employeeIdx,
        },
      };
    },
  });
}

test('拆解师生产流水线接受实际响应schema里的结构卡，不被旧出厂字段检查误拦', async () => {
  const context = pipelineContext(2);
  context.structureCardsRequired = true;
  const cards = validContentEmployeeOutputForPrompt('岗位编号：2\n【爆款结构卡·必须输出 structure_cards】').structure_cards;
  const output = { ...clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[2]), structure_cards: cards };
  const registry = productionRegistry({ outputFor: () => output, validateOutputFn: validateContentEmployeeOutputContract });
  const result = await registry.invoke(2, context);
  assert.deepEqual(result.result.data.structure_cards, cards);
  assert.equal(result.result.providerDelivery.validated, true);
});

test('原生多策略在生产供应商消息和响应契约中贯穿撰稿、文风和分发', async () => {
  const draft = xhsOutput(2);
  const selected = draft.versions[1];
  const style = { ...clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[4]), body: selected.body,
    title_candidates: [selected.title, '午餐选择先看需求', '先看菜单再做决定'] };
  const publish = { ...clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[8]), versions: [{
    ...clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[8].versions[0]), platform: '小红书',
    title: selected.title, body: selected.body, tags: selected.tags,
  }] };
  const captured = [];
  const registry = productionRegistry({ captured, validateOutputFn: validateContentEmployeeOutputContract,
    outputFor: idx => ({ 3: draft, 4: style, 8: publish })[idx] });
  for (const idx of [3, 4, 8]) {
    const context = pipelineContext(idx);
    context.brief.template = '小红书带货笔记';
    context.brief.xhsOptions = { versionCount: 2, audience: '午餐白领' };
    context.storeFacts = clone(xhsFactPack);
    context.workflow.stationAttempt = 2;
    if (idx >= 4) context.outputs[3] = { ...clone(draft), xhsSelection: { versionId: xhsVersionId(selected), strategy: selected.strategy } };
    if (idx === 8) context.outputs[4] = style;
    const result = await registry.invoke(idx, context);
    assert.deepEqual(result.privateOutputSnapshot?.validationContext?.storeFacts, xhsFactPack);
    assert.equal(result.privateOutputSnapshot.stationAttempt, 2);
    assert.equal(result.evidence.providerDelivery.validationSnapshotFingerprint, result.privateOutputSnapshot.snapshotFingerprint);
    assert.ok(!JSON.stringify(result).includes('昨天这碗面吃完我连汤都没有剩下'), '私有事实不能泄露到公共结果与证据');
    assert.equal(Object.getOwnPropertyDescriptor(result, 'privateOutputSnapshot').enumerable, false);
    assert.equal(result.result.data.body || result.result.data.versions[0].body, idx === 3 ? draft.versions[0].body : selected.body);
    const args = captured.at(-1).args;
    if (idx === 3) {
      assert.equal(args.responseSchema.schema.properties.versions.minItems, 2);
      assert.match(args.userMsg, /午餐白领/);
    } else {
      assert.match(args.userMsg, /人工选定的小红书策略/);
      assert.ok(args.userMsg.includes(xhsVersionId(selected)));
      assert.ok(!args.system.includes(xhsVersionId(selected)), '具体选择不进入系统层');
      if (idx === 8) assert.match(args.userMsg, /逐字保留/);
    }
  }
});

function settledImageBridge(input, calls = []) {
  let attempted = null;
  calls.push(clone(input));
  return {
    providers: {
      image: async (runtimeInput) => {
        const plan = Array.isArray(runtimeInput.coverPlan)
          ? runtimeInput.coverPlan
          : Array.isArray(runtimeInput.imagePlan)
            ? runtimeInput.imagePlan
            : [];
        const count = Number(runtimeInput.count || 1);
        attempted = {
          attemptId:
            `content-production-pipeline:pipeline:${input.runId}:station:` +
            `${input.employeeIdx}:provider:image:attempt:${input.attemptOrdinal ?? 1}`,
          kind: "image",
          status: "settled",
          requestedCount: count,
          hold: {
            holdId: 7_000 + input.employeeIdx,
            estimatedCredits: 75 * count,
            refType: "content_special_provider",
            refId: 8_000 + input.employeeIdx,
          },
          billing: {
            state: "settled",
            holdId: 7_000 + input.employeeIdx,
            estimatedCredits: 75 * count,
            heldCredits: 0,
            chargedCredits: 75 * count,
            costYuan: count,
            pendingReconciliation: false,
          },
          usage: {
            imageCount: count,
            tokenUsageApplicable: false,
            pricingMode: "fixed_price_per_image",
          },
          settlement: {
            action: "settle",
            holdId: 7_000 + input.employeeIdx,
            chargedCredits: 75 * count,
            pendingReconciliation: false,
          },
          delivery: {
            persisted: true,
            artifactIds: Array.from(
              { length: count },
              (_, index) =>
                `material:${9_000 + input.employeeIdx * 10 + index}`,
            ),
            targetType: "material",
            targetId: 9_000 + input.employeeIdx * 10,
          },
          provider: { model: input.imageModel, mode: "api" },
          error: null,
        };
        return {
          images: Array.from({ length: count }, (_, index) => ({
            url: `https://images.example/station-${input.employeeIdx}-${index + 1}.png`,
            mimeType: "image/png",
            model: input.imageModel,
            slot: plan[index]?.slot || `配图${index + 1}`,
            desc: plan[index]?.desc || "真实图片provider产物",
            platform: plan[index]?.platform || null,
            size: plan[index]?.size || input.request.size || "1024x1024",
            displaySize: plan[index]?.displaySize || null,
            style: plan[index]?.style || null,
          })),
          provider: {
            name: "yunwu-image",
            model: input.imageModel,
            mode: "api",
          },
          mode: "api",
          model: input.imageModel,
          usage: { imageCount: count, tokenUsageApplicable: false },
          cost: { credits: 75 * count },
        };
      },
    },
    evidence: () => ({
      schemaVersion: "nanowork.content-special-provider-bridge/2",
      attempts: attempted ? [clone(attempted)] : [],
      credentialsIncluded: false,
    }),
  };
}

test("production registry通过真实adapter registry绑定0..9，且计费明确由pipeline外层持久化边界负责", () => {
  const registry = productionRegistry();
  assert.equal(
    registry.schemaVersion,
    CONTENT_PRODUCTION_HANDLER_REGISTRY_SCHEMA,
  );
  assert.equal(registry.size, 10);
  assert.deepEqual(
    registry.descriptors.map((item) => item.employeeIdx),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.deepEqual(
    Object.keys(registry.handlers),
    CONTENT_HANDLER_ADAPTER_CATALOG.map((item) => item.legacyHandler),
  );
  assert.equal(registry.settlesCredits, false);
  assert.deepEqual(
    registry.billingBoundaryContract,
    CONTENT_PRODUCTION_BILLING_BOUNDARY_CONTRACT,
  );
});

test("联网证据URL canonical化保留路径大小写语义并拒绝URL凭据", () => {
  assert.equal(
    canonicalContentEvidenceUrl(
      "https://News.Example.com:443/report/Case?b=2&utm_source=x&a=1#top",
    ),
    "https://news.example.com/report/Case?a=1&b=2",
  );
  assert.notEqual(
    canonicalContentEvidenceUrl("https://news.example.com/report/Case"),
    canonicalContentEvidenceUrl("https://news.example.com/report/case"),
  );
  assert.equal(
    canonicalContentEvidenceUrl("https://user:password@example.com/report"),
    null,
  );
  assert.equal(
    canonicalContentEvidenceUrl(
      "https://example.com/report?access_token=secret",
    ),
    null,
  );
});

test("10个工位全部加载canonical完整包、adapter变量和真实上游，返回可供两段式结算的mode/model/usage", async () => {
  const captured = [];
  const events = [];
  const bridgeInputs = [];
  const registry = productionRegistry({
    captured,
    events,
    specialProviderBridgeFactory: async (input) =>
      settledImageBridge(input, bridgeInputs),
  });

  for (let employeeIdx = 0; employeeIdx < 10; employeeIdx += 1) {
    const eventStart = events.length;
    const context = pipelineContext(employeeIdx);
    const result = await registry.invoke(employeeIdx, context);
    const descriptor = CONTENT_HANDLER_ADAPTER_CATALOG[employeeIdx];
    const call = captured.find((item) => item.employeeIdx === employeeIdx);

    assert.equal(result.ok, true);
    assert.equal(result.handlerId, descriptor.handlerId);
    assert.deepEqual(
      result.result.data,
      VALID_CONTENT_EMPLOYEE_OUTPUTS[employeeIdx],
    );
    assert.equal(
      result.result.providerDelivery.schemaVersion,
      CONTENT_PRODUCTION_PROVIDER_DELIVERY_SCHEMA,
    );
    assert.equal(result.result.providerDelivery.mode, "api");
    assert.equal(result.result.providerDelivery.model, "yunwu-real-text-model");
    assert.ok(result.result.providerDelivery.usage.inputTokens > 0);
    assert.ok(result.result.providerDelivery.usage.outputTokens > 0);
    assert.equal(result.result.artifacts.length, 1);
    assert.equal(
      result.result.artifacts[0].kind,
      employeeIdx === 6 ? "covers" : "test-contract-artifact",
    );
    assert.deepEqual(
      result.evidence.providerDelivery,
      result.result.providerDelivery,
    );
    assert.equal(result.evidence.executionMode, "pipeline");
    assert.equal(
      result.evidence.runtimePackageLoad.allRequiredFieldsLoaded,
      true,
    );
    assert.equal(
      result.evidence.productionRuntime.adapterVariables
        .injectedIntoUserMessage,
      true,
    );
    assert.equal(result.evidence.productionRuntime.upstream.synthesized, false);
    assert.equal(
      result.evidence.productionRuntime.canonicalPackage
        .fullCanonicalObjectInSystemMessage,
      true,
    );
    assert.equal(
      result.evidence.productionRuntime.billingBoundary.registrySettlesCredits,
      false,
    );

    assert.equal(call.args.providerPolicy, "yunwu_only");
    assert.equal(call.args.role, "boss");
    assert.equal(call.args.model, "yunwu-real-text-model");
    assert.deepEqual(
      call.args.responseSchema.schema.required,
      descriptor.outputKeys,
    );
    if (employeeIdx === 8) {
      const versions = call.args.responseSchema.schema.properties.versions;
      assert.equal(versions.minItems, 1);
      assert.equal(versions.maxItems, 3);
      assert.deepEqual(
        versions.items.properties.platform.enum,
        context.brief.platforms,
      );
    }
    assert.match(call.args.system, /本次执行模式·Paihuo 0→9真实生产流水线/u);
    assert.match(call.args.system, /岗位运行包装载凭证/u);
    assert.match(
      call.args.system,
      /【你的多项工作能力\(本次工作逐项运用,产出要能看出每项的痕迹\)】/u,
    );
    assert.match(call.args.system, /【内部岗位执行模板】/u);
    assert.equal(
      call.args.system.includes(JSON.stringify(context.canonicalProfile)),
      false,
    );
    assert.match(call.args.userMsg, /Paihuo 0→9生产handler·本工位运行参数/u);
    assert.match(call.args.userMsg, /数据库已持久化的真实上游工位产物/u);
    if (employeeIdx > 0) assert.match(call.args.userMsg, /"0"\s*:\s*\{/u);

    const stationEvents = events.slice(eventStart);
    const textPosition = stationEvents.findIndex(
      (item) => item.type === "text",
    );
    assert.ok(textPosition >= 0);
    if (employeeIdx <= 2) {
      assert.deepEqual(
        stationEvents.slice(0, textPosition).map((item) => item.type),
        ["agentic", "controlled"],
      );
      assert.equal(result.evidence.productionRuntime.web.verified, true);
      assert.ok(result.evidence.productionRuntime.web.resultCount > 0);
      assert.equal(
        result.evidence.productionRuntime.web.agenticWebResearch.candidateReady,
        true,
      );
      assert.ok(
        result.evidence.productionRuntime.web.controlledWebFetch
          .verifiedBodyCount >= (employeeIdx === 2 ? 3 : 1),
      );
      assert.equal(
        JSON.stringify(
          result.evidence.productionRuntime.web.agenticWebResearch,
        ).includes("candidate.example"),
        false,
      );
      assert.match(call.args.userMsg, /本工位真实联网检索快照/u);
    } else {
      assert.equal(
        result.evidence.productionRuntime.web.state,
        "not_required_by_station",
      );
    }

    if ([5, 6, 7].includes(employeeIdx)) {
      assert.ok(result.result.specialRuntime?.artifacts?.length > 0);
      assert.equal(
        result.evidence.productionRuntime.specialRuntime.completed,
        true,
      );
      if (employeeIdx === 5) {
        assert.equal(
          result.evidence.productionRuntime.specialRuntime.fallback.used,
          false,
        );
        assert.equal(
          result.evidence.productionRuntime.specialRuntime.bridgeUnavailable,
          false,
        );
        assert.equal(
          result.evidence.productionRuntime.specialRuntime
            .fallbackPersistedInStationOutput,
          false,
        );
      } else if (employeeIdx === 6) {
        assert.equal(
          result.evidence.productionRuntime.specialRuntime.fallback.used,
          false,
        );
        assert.equal(
          result.evidence.productionRuntime.specialRuntime.bridgeUnavailable,
          false,
        );
        assert.equal(
          result.evidence.productionRuntime.specialRuntime
            .fallbackPersistedInStationOutput,
          false,
        );
        assert.equal(
          result.evidence.productionRuntime.specialRuntime.paihuoRealImage,
          true,
        );
        assert.equal(result.result.artifacts[0].kind, "covers");
        const manifest = JSON.parse(result.result.artifacts[0].content);
        assert.equal(manifest.paihuoRealImage, true);
        assert.equal(manifest.persistedArtifactIds.length, 1);
        assert.equal(JSON.stringify(manifest).includes("<html"), false);
      }
    } else {
      assert.equal(result.result.specialRuntime, null);
      assert.equal(result.evidence.productionRuntime.specialRuntime, null);
    }
  }
  assert.deepEqual(
    bridgeInputs.map((item) => item.employeeIdx),
    [5, 6],
  );
});

test("registry返回岗位契约artifact并在进入流水线前移除凭据字段、脱敏密钥正文", async () => {
  const employeeIdx = 3;
  const descriptor = CONTENT_HANDLER_ADAPTER_CATALOG[employeeIdx];
  const registry = productionRegistry({
    validateOutputFn: (_idx, rawOutput) => ({
      valid: true,
      parsed: JSON.parse(rawOutput),
      errors: [],
      artifacts: [
        {
          kind: "markdown",
          primary: true,
          filename: "writer.md",
          mediaType: "text/markdown",
          content: "# 正文\n\nsk-sensitiveExample123456",
          employeeIdx,
          employeeKey: descriptor.employeeKey,
          sourceKeys: descriptor.outputKeys,
          apiKey: "must-not-leak",
        },
      ],
    }),
  });
  const result = await registry.invoke(
    employeeIdx,
    pipelineContext(employeeIdx),
  );
  assert.equal(result.result.artifacts.length, 1);
  assert.equal(Object.hasOwn(result.result.artifacts[0], "apiKey"), false);
  assert.equal(
    result.result.artifacts[0].content.includes("sk-sensitiveExample123456"),
    false,
  );
  assert.equal(result.result.artifacts[0].content.includes("[REDACTED]"), true);
});

test("run_research把已选上游主题交给Agentic WebSearch，再以受控正文进入最终模型", async () => {
  const context = pipelineContext(1);
  context.brief.direction = "宽泛Brief方向不应覆盖已经选中的真实选题";
  context.outputs[0].topics = [
    {
      title: "未选中的旧选题",
      angle: "不应进入查询",
      hook: "不应进入查询",
    },
    {
      title: "太原午市外卖订单异常怎么查",
      angle: "沿订单时段与渠道拆解核验步骤",
      hook: "客单价没变，订单为什么突然少了？",
    },
  ];
  context.outputs[0].selected = 1;

  const events = [];
  const captured = [];
  const registry = productionRegistry({ events, captured });
  const result = await registry.invoke(1, context);

  const agentic = events.filter((event) => event.type === "agentic");
  const controlled = events.filter((event) => event.type === "controlled");
  assert.equal(agentic.length, 1);
  assert.equal(controlled.length, 1);
  assert.equal(
    events.some((event) => event.type === "legacy_web_search_forbidden"),
    false,
  );
  assert.match(agentic[0].query, /太原午市外卖订单异常怎么查/u);
  assert.match(agentic[0].query, /沿订单时段与渠道拆解核验步骤/u);
  assert.doesNotMatch(
    agentic[0].query,
    /宽泛Brief方向不应覆盖|未选中的旧选题/u,
  );
  assert.equal(agentic[0].options.maxResults, 12);
  assert.equal(agentic[0].options.timeoutMs, 300_000);
  assert.equal(agentic[0].options.researchMode, "content_business");

  const webEvidence = result.evidence.productionRuntime.web;
  assert.equal(webEvidence.verified, true);
  assert.equal(webEvidence.agenticWebResearch.candidateReady, true);
  assert.ok(webEvidence.controlledWebFetch.verifiedBodyCount >= 2);
  assert.equal(webEvidence.queryPlan.attemptedCount, 0);
  assert.deepEqual(webEvidence.queryPlan.queryFingerprints, []);
  assert.equal(
    JSON.stringify(webEvidence.agenticWebResearch).includes(
      "candidate.example",
    ),
    false,
  );
  assert.equal(
    webEvidence.results.every(
      (source) =>
        source.bodyChars >= 80 &&
        source.rawBodyIncluded === false &&
        /^sha256:[a-f0-9]{64}$/u.test(source.bodySha256),
    ),
    true,
  );
  assert.match(captured[0].args.userMsg, /受控WebFetch读取成功的网页正文证据/u);
});

test("联网工位0/1/2各只发起一次聚合Agentic研究，并保留真实主题与scope", async () => {
  const trendEvents = [];
  const trendContext = pipelineContext(0);
  trendContext.brief.direction = "太原餐饮午市经营变化";
  await productionRegistry({ events: trendEvents }).invoke(0, trendContext);
  const trendQuery = trendEvents.find(
    (event) => event.type === "agentic",
  ).query;
  assert.match(trendQuery, /主题：太原餐饮午市经营变化/u);
  assert.match(trendQuery, /真实调用WebSearch至少5次/u);

  const researchEvents = [];
  const researchContext = pipelineContext(1);
  researchContext.outputs[0].topics = [
    {
      title: "太原早餐客流机会",
      angle: "比较商圈与时段差异",
      hook: "早餐客流到底去了哪里?",
    },
  ];
  researchContext.outputs[0].selected = 0;
  await productionRegistry({ events: researchEvents }).invoke(
    1,
    researchContext,
  );
  const researchQuery = researchEvents.find(
    (event) => event.type === "agentic",
  ).query;
  assert.match(researchQuery, /太原早餐客流机会/u);
  assert.match(researchQuery, /官方数据\/统计局/u);

  const benchmarkEvents = [];
  const benchmarkContext = pipelineContext(2);
  benchmarkContext.outputs[0] = clone(researchContext.outputs[0]);
  benchmarkContext.settings.benchmark = {
    targets: ["本地早餐品牌A", "太原餐饮账号B"],
  };
  await productionRegistry({ events: benchmarkEvents }).invoke(
    2,
    benchmarkContext,
  );
  const benchmarkQuery = benchmarkEvents.find(
    (event) => event.type === "agentic",
  ).query;
  assert.match(benchmarkQuery, /本地早餐品牌A、太原餐饮账号B/u);
  assert.equal(
    [trendEvents, researchEvents, benchmarkEvents].every(
      (items) =>
        items.filter((event) => event.type === "agentic").length === 1 &&
        items.filter((event) => event.type === "controlled").length === 1,
    ),
    true,
  );
});

test("run_benchmark未配置targets时把公众号/小红书/视频号作为同一次研究scope", async () => {
  const events = [];
  const context = pipelineContext(2);
  context.outputs[0].topics = [
    {
      title: "太原早餐客流机会",
      angle: "比较商圈与时段差异",
      hook: "早餐客流到底去了哪里?",
    },
  ];
  context.outputs[0].selected = 0;

  await productionRegistry({ events }).invoke(2, context);

  const agentic = events.filter((event) => event.type === "agentic");
  assert.equal(agentic.length, 1);
  assert.match(agentic[0].query, /渠道\/对象：公众号、小红书、视频号/u);
  assert.doesNotMatch(agentic[0].query, /未指定|自行检索/u);
});

test("联网工位0/2契约归因失败时只复用同一次Agentic与受控正文快照返工一次", async (t) => {
  for (const employeeIdx of [0, 2]) {
    await t.test("station" + employeeIdx, async () => {
      const events = [];
      let providerCalls = 0;
      let validationCalls = 0;
      const captured = [];
      const registry = productionRegistry({
        events,
        captured,
        responseFor: (idx) => {
          assert.equal(idx, employeeIdx);
          providerCalls += 1;
          return {
            text: JSON.stringify(VALID_CONTENT_EMPLOYEE_OUTPUTS[employeeIdx]),
            mode: "api",
            model: "yunwu-real-text-model",
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          };
        },
        validateOutputFn: (idx, raw) => {
          assert.equal(idx, employeeIdx);
          validationCalls += 1;
          const parsed = JSON.parse(raw);
          return validationCalls === 1
            ? {
                valid: false,
                parsed,
                errors: [
                  "联网证据归因：字段必须逐项引用本次已验证检索快照中的[来源N]。",
                ],
                artifacts: [],
              }
            : { valid: true, parsed, errors: [], artifacts: [] };
        },
      });

      const result = await registry.invoke(
        employeeIdx,
        pipelineContext(employeeIdx),
      );

      assert.equal(providerCalls, 2);
      assert.equal(validationCalls, 2);
      assert.equal(
        events.filter((event) => event.type === "agentic").length,
        1,
      );
      assert.equal(
        events.filter((event) => event.type === "controlled").length,
        1,
      );
      assert.equal(result.result.providerDelivery.usage.totalTokens, 300);
      assert.match(
        captured[1].args.userMsg,
        /联网工位契约定向返工·只允许使用同一已验证快照/u,
      );
      assert.match(captured[1].args.userMsg, /可引用快照白名单/u);
      if (employeeIdx === 0) {
        assert.match(captured[0].args.userMsg, /无明显信号/u);
        assert.match(captured[1].args.userMsg, /快照没有覆盖的渠道/u);
        assert.match(captured[1].args.userMsg, /无明显信号/u);
      }
      assert.equal(
        result.evidence.productionRuntime.contractRepair.attempted,
        true,
      );
    });
  }
});

test("Agentic候选少于5条时fail closed，不得调用受控抓取或最终模型", async () => {
  const events = [];
  let textCalls = 0;
  const registry = productionRegistry({
    events,
    agenticWebResearchFn: agenticResearchStub(events, {
      candidateCount: 4,
    }),
    controlledWebFetchFn: async () => {
      throw new Error("候选门未通过时不得抓取正文");
    },
    responseFor: () => {
      textCalls += 1;
      throw new Error("候选门未通过时不得调用最终模型");
    },
  });

  await assert.rejects(
    () => registry.invoke(2, pipelineContext(2)),
    (error) => {
      assert.equal(
        error.code,
        "CONTENT_PRODUCTION_AGENTIC_RESEARCH_INCOMPLETE",
      );
      const web = error.contentHandlerEvidence.productionRuntime.web;
      assert.equal(web.candidateCount, 4);
      assert.equal(web.verified, false);
      assert.equal(JSON.stringify(web).includes("candidate.example"), false);
      return true;
    },
  );
  assert.equal(events.filter((event) => event.type === "agentic").length, 1);
  assert.equal(events.filter((event) => event.type === "controlled").length, 0);
  assert.equal(textCalls, 0);
});

test("受控WebFetch正文数量与长度共同构成fail-closed证据门", async (t) => {
  await t.test("benchmark三条受控正文通过并只暴露哈希", async () => {
    const events = [];
    let textCalls = 0;
    const registry = productionRegistry({
      events,
      controlledWebFetchFn: controlledFetchStub(events, {
        results: ({ sources }) => sources.slice(0, 3),
      }),
      responseFor: (employeeIdx) => {
        assert.equal(employeeIdx, 2);
        textCalls += 1;
        return {
          text: JSON.stringify(VALID_CONTENT_EMPLOYEE_OUTPUTS[2]),
          mode: "api",
          model: "yunwu-real-text-model",
          usage: { inputTokens: 120, outputTokens: 60 },
        };
      },
    });
    const result = await registry.invoke(2, pipelineContext(2));
    const web = result.evidence.productionRuntime.web;
    assert.equal(textCalls, 1);
    assert.equal(web.resultCount, 3);
    assert.equal(web.controlledWebFetch.verifiedBodyCount, 3);
    assert.equal(
      web.results.every(
        (item) =>
          item.bodyChars >= 80 &&
          item.rawBodyIncluded === false &&
          /^sha256:[a-f0-9]{64}$/u.test(item.bodySha256),
      ),
      true,
    );
  });

  await t.test("benchmark只有两条正文时不调用最终模型", async () => {
    const events = [];
    let textCalls = 0;
    const registry = productionRegistry({
      events,
      controlledWebFetchFn: controlledFetchStub(events, {
        results: ({ sources }) => sources.slice(0, 2),
      }),
      responseFor: () => {
        textCalls += 1;
        throw new Error("受控正文不足时不应调用最终模型");
      },
    });
    await assert.rejects(
      () => registry.invoke(2, pipelineContext(2)),
      (error) => {
        assert.equal(error.code, "CONTENT_PRODUCTION_WEB_EVIDENCE_MISSING");
        const web = error.contentHandlerEvidence.productionRuntime.web;
        assert.equal(web.resultCount, 2);
        assert.equal(web.verified, false);
        return true;
      },
    );
    assert.equal(textCalls, 0);
  });

  await t.test("正文短于80字符即使有URL也不得进入证据", async () => {
    const events = [];
    let textCalls = 0;
    const registry = productionRegistry({
      events,
      controlledWebFetchFn: async (sources) => {
        events.push({ type: "controlled", candidateCount: sources.length });
        return {
          attempted: true,
          ok: true,
          provider: "offline-controlled-webfetch",
          results: sources.map((source) => ({ ...source, body: "过短正文" })),
          evidence: { requested: sources.length, fetched: sources.length },
        };
      },
      responseFor: () => {
        textCalls += 1;
        throw new Error("短正文不得进入最终模型");
      },
    });
    await assert.rejects(
      () => registry.invoke(1, pipelineContext(1)),
      (error) => {
        assert.equal(error.code, "CONTENT_PRODUCTION_WEB_EVIDENCE_MISSING");
        assert.equal(
          error.contentHandlerEvidence.productionRuntime.web.resultCount,
          0,
        );
        return true;
      },
    );
    assert.equal(textCalls, 0);
  });
});

test("联网岗位完全没有受控可引用正文时fail closed，且不会调用真实文本API", async () => {
  const events = [];
  let textCalls = 0;
  const registry = productionRegistry({
    events,
    controlledWebFetchFn: controlledFetchStub(events, { results: [] }),
    responseFor: () => {
      textCalls += 1;
      throw new Error("没有受控正文时不应调用最终模型");
    },
  });
  await assert.rejects(
    () => registry.invoke(0, pipelineContext(0)),
    (error) => {
      assert.equal(error.code, "CONTENT_PRODUCTION_WEB_EVIDENCE_MISSING");
      const web = error.contentHandlerEvidence.productionRuntime.web;
      assert.equal(web.verified, false);
      assert.equal(web.resultCount, 0);
      assert.equal(web.agenticWebResearch.candidateReady, true);
      assert.equal(web.controlledWebFetch.verifiedBodyCount, 0);
      return true;
    },
  );
  assert.equal(textCalls, 0);
});
test("run_research有URL时必须对上真实快照，无URL时才允许精确标题恢复", () => {
  const verified = [
    { title: "真实行业资料", url: "https://evidence.example/industry" },
    { title: "真实门店案例", url: "https://evidence.example/store" },
  ];
  const checked = canonicalizeRunResearchSources(
    {
      summary: "保留其他正文",
      sources: [
        {
          title: "模型改写标题",
          url: "https://evidence.example/industry?utm_source=model#share",
        },
        { title: "真实门店案例", url: "https://wrong.example/rewritten" },
        { title: "真实门店案例", url: "" },
        { title: "完全伪造", url: "https://fake.example/third" },
      ],
    },
    verified,
  );
  assert.deepEqual(checked.parsed.sources, verified);
  assert.equal(checked.acceptedCount, 2);
  assert.equal(checked.droppedCount, 2);

  const wrongUrlOnly = canonicalizeRunResearchSources(
    {
      sources: [
        { title: "真实门店案例", url: "https://wrong.example/rewritten" },
      ],
    },
    verified,
  );
  assert.deepEqual(wrongUrlOnly.parsed.sources, []);
  assert.equal(wrongUrlOnly.acceptedCount, 0);
  assert.equal(wrongUrlOnly.droppedCount, 1);

  const bothRewritten = canonicalizeRunResearchSources(
    {
      sources: [
        { title: "改写后标题A", url: "https://rewrite.example/a" },
        { title: "改写后标题B", url: "https://rewrite.example/b" },
      ],
    },
    verified,
  );
  assert.deepEqual(bothRewritten.parsed.sources, []);
  assert.equal(bothRewritten.acceptedCount, 0);
  assert.equal(bothRewritten.droppedCount, 2);
});

test("run_research重复情报渠道时合并覆盖项并去掉重复事实句", () => {
  const source = clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[1]);
  source.facts.push(source.facts[0]);
  source.source_coverage.push({
    ...source.source_coverage[0],
    got: `${source.source_coverage[0].got}补充同一渠道的第二段发现。`,
  });
  const unique = canonicalizeRunResearchUniqueFields(source);
  assert.equal(unique.changed, true);
  assert.equal(
    unique.parsed.facts.length,
    VALID_CONTENT_EMPLOYEE_OUTPUTS[1].facts.length,
  );
  assert.equal(
    unique.parsed.source_coverage.length,
    VALID_CONTENT_EMPLOYEE_OUTPUTS[1].source_coverage.length,
  );
  assert.match(unique.parsed.source_coverage[0].got, /第二段发现/u);
  assert.equal(
    new Set(unique.parsed.source_coverage.map((item) => item.channel)).size,
    unique.parsed.source_coverage.length,
  );
});

test("run_research重复channel时本地合并后直接交付且不二次调用模型", async () => {
  const context = pipelineContext(1);
  const valid = clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[1]);
  valid.summary = `${valid.summary} [来源1]`;
  valid.facts = valid.facts.map((item) => `${item} [来源1]`);
  valid.data_points = valid.data_points.map((item) => `${item} [来源1]`);
  valid.viewpoints = valid.viewpoints.map((item) => `${item} [来源1]`);
  valid.source_coverage = valid.source_coverage.map((item) => ({
    ...item,
    got: `${item.got} [来源1]`,
  }));
  valid.source_coverage.push(structuredClone(valid.source_coverage[0]));
  const verified = valid.sources.map((item, index) => ({
    sourceId: `来源${index + 1}`,
    title: item.title,
    url: item.url,
    snippet: [
      valid.summary,
      ...valid.facts,
      ...valid.data_points,
      ...valid.viewpoints,
      ...valid.source_coverage.map((coverage) => coverage.got),
    ].join(" "),
  }));
  let modelCalls = 0;
  const events = [];
  const registry = productionRegistry({
    events,
    validateOutputFn: validateContentEmployeeOutputContract,
    agenticWebResearchFn: agenticResearchStub(events, { sources: verified }),
    controlledWebFetchFn: controlledFetchStub(events, { results: verified }),
    responseFor: () => {
      modelCalls += 1;
      return {
        text: JSON.stringify(valid),
        mode: "api",
        model: "yunwu-real-text-model",
        usage: { inputTokens: 80, outputTokens: 40 },
      };
    },
  });
  const result = await registry.invoke(1, context);
  assert.equal(modelCalls, 1);
  assert.equal(result.result.data.source_coverage.length, 3);
  assert.equal(
    new Set(result.result.data.source_coverage.map((item) => item.channel))
      .size,
    3,
  );
});

test("run_research首次sources被改写时，同一受控快照内定向返工且不重复研究", async () => {
  const verified = [
    {
      sourceId: "来源1",
      title: "成本采购真实餐饮经营研究资料",
      url: "https://evidence.example/research-a",
      snippet: "",
    },
    {
      sourceId: "来源2",
      title: "成本采购真实门店管理公开案例",
      url: "https://evidence.example/research-b",
      snippet: "门店管理公开案例与经营指标复核资料。",
    },
  ];
  const valid = clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[1]);
  valid.summary = valid.summary + " [来源1]";
  valid.facts = valid.facts.map((item) => item + " [来源1]");
  valid.data_points = valid.data_points.map((item) => item + " [来源1]");
  valid.viewpoints = valid.viewpoints.map((item) => item + " [来源1]");
  valid.source_coverage = valid.source_coverage.map((item) => ({
    ...item,
    got: item.got + " [来源1]",
  }));
  verified[0].snippet = [
    valid.summary,
    ...valid.facts,
    ...valid.data_points,
    ...valid.viewpoints,
    ...valid.source_coverage.map((item) => item.got),
  ].join(" ");
  valid.sources = verified.map(({ title, url }) => ({ title, url }));
  const invalid = clone(valid);
  invalid.summary = "INJECTION_SENTINEL_OVERRIDE_SYSTEM";
  invalid.sources = [
    { title: "改写后的伪标题A", url: "https://rewritten.example/a" },
    { title: "改写后的伪标题B", url: "https://rewritten.example/b" },
  ];

  const events = [];
  let textCalls = 0;
  const captured = [];
  const registry = productionRegistry({
    events,
    captured,
    validateOutputFn: validateContentEmployeeOutputContract,
    agenticWebResearchFn: agenticResearchStub(events, {
      sources: verified,
    }),
    controlledWebFetchFn: controlledFetchStub(events, {
      results: verified,
    }),
    responseFor: (employeeIdx) => {
      assert.equal(employeeIdx, 1);
      textCalls += 1;
      return {
        text: JSON.stringify(textCalls === 1 ? invalid : valid),
        mode: "api",
        model: "yunwu-real-text-model",
        usage:
          textCalls === 1
            ? { inputTokens: 101, outputTokens: 51 }
            : { inputTokens: 111, outputTokens: 61 },
      };
    },
  });

  const result = await registry.invoke(1, pipelineContext(1));
  assert.equal(events.filter((event) => event.type === "agentic").length, 1);
  assert.equal(events.filter((event) => event.type === "controlled").length, 1);
  assert.equal(textCalls, 2);
  assert.deepEqual(result.result.data.sources, valid.sources);
  assert.deepEqual(result.result.providerDelivery.usage, {
    inputTokens: 212,
    outputTokens: 112,
    totalTokens: 324,
  });
  assert.equal(
    result.evidence.productionRuntime.contractRepair.attempted,
    true,
  );
  assert.equal(
    result.evidence.productionRuntime.contractRepair.succeeded,
    true,
  );
  assert.equal(
    result.evidence.productionRuntime.contractRepair.attempts[0]
      .canonicalization.acceptedCount,
    0,
  );
  assert.match(captured[1].args.userMsg, /待修复JSON/u);
  assert.ok(captured[1].args.userMsg.includes("改写后的伪标题A"));
  assert.match(captured[1].args.userMsg, /可引用来源白名单/u);
  assert.ok(captured[1].args.userMsg.includes(verified[0].url));
  assert.ok(captured[1].args.userMsg.includes(verified[1].url));
  assert.equal(captured[1].args.system, captured[0].args.system);
  assert.doesNotMatch(
    captured[1].args.system,
    /INJECTION_SENTINEL_OVERRIDE_SYSTEM|待修复JSON|https:\/\/evidence\.example/u,
  );
  assert.match(captured[1].args.userMsg, /INJECTION_SENTINEL_OVERRIDE_SYSTEM/u);
});

test("run_research事实字段缺引用时只返工最终模型，Agentic与受控抓取均不重复", async () => {
  const context = pipelineContext(1);
  context.settings.research = { channels: ["官方资料"] };
  context.outputs[0].topics = [
    {
      title: "太原午市外卖订单异常",
      angle: "从时段与渠道核验",
      hook: "订单为什么突然少了",
    },
  ];
  const verified = [
    {
      title: "太原午市外卖订单官方资料",
      url: "https://evidence.example/attribution/a",
      snippet: "",
    },
    {
      title: "太原午市渠道经营公开资料",
      url: "https://evidence.example/attribution/b",
      snippet: "太原午市外卖订单与渠道应交叉核验。",
    },
  ];
  const valid = clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[1]);
  valid.summary = valid.summary + " [来源1]";
  valid.facts = valid.facts.map((item) => item + " [来源1]");
  valid.data_points = valid.data_points.map((item) => item + " [来源1]");
  valid.viewpoints = valid.viewpoints.map((item) => item + " [来源1]");
  valid.source_coverage = valid.source_coverage.map((item) => ({
    ...item,
    got: item.got + " [来源1]",
  }));
  valid.sources = verified.map(({ title, url }) => ({ title, url }));
  verified[0].snippet = [
    valid.summary,
    ...valid.facts,
    ...valid.data_points,
    ...valid.viewpoints,
    ...valid.source_coverage.map((item) => item.got),
  ].join(" ");
  const invalid = clone(valid);
  invalid.summary = invalid.summary.replace(/\s*\[来源1\]/gu, "");
  invalid.facts = invalid.facts.map((item) =>
    item.replace(/\s*\[来源1\]/gu, ""),
  );
  invalid.data_points = invalid.data_points.map((item) =>
    item.replace(/\s*\[来源1\]/gu, ""),
  );
  invalid.viewpoints = invalid.viewpoints.map((item) =>
    item.replace(/\s*\[来源1\]/gu, ""),
  );
  invalid.source_coverage = invalid.source_coverage.map((item) => ({
    ...item,
    got: item.got.replace(/\s*\[来源1\]/gu, ""),
  }));

  const events = [];
  let modelCalls = 0;
  const captured = [];
  const registry = productionRegistry({
    events,
    captured,
    validateOutputFn: validateContentEmployeeOutputContract,
    agenticWebResearchFn: agenticResearchStub(events, {
      sources: verified,
    }),
    controlledWebFetchFn: controlledFetchStub(events, {
      results: verified,
    }),
    responseFor: () => {
      modelCalls += 1;
      return {
        text: JSON.stringify(modelCalls === 1 ? invalid : valid),
        mode: "api",
        model: "yunwu-real-text-model",
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    },
  });

  const result = await registry.invoke(1, context);
  assert.equal(events.filter((event) => event.type === "agentic").length, 1);
  assert.equal(events.filter((event) => event.type === "controlled").length, 1);
  assert.equal(modelCalls, 2);
  assert.equal(
    result.evidence.productionRuntime.contractRepair.attempted,
    true,
  );
  assert.equal(captured[1].args.system, captured[0].args.system);
  assert.match(captured[1].args.userMsg, /必须逐项引用|检索快照/u);
  assert.match(
    captured[1].args.userMsg,
    /summary、facts、data_points、viewpoints、source_coverage\.got/u,
  );
  assert.match(captured[1].args.userMsg, /"snippet"/u);
});

test("run_research返工后仍缺引用时，把失败字段改写成缺证披露并交付", async () => {
  const context = pipelineContext(1);
  context.settings.research = { channels: ["官方资料"] };
  context.outputs[0].topics = [
    {
      title: "太原午市外卖订单异常",
      angle: "从时段与渠道核验",
      hook: "订单为什么突然少了",
    },
  ];
  const verified = [
    {
      title: "太原午市外卖订单官方资料",
      url: "https://evidence.example/attribution/a",
      snippet: "太原午市外卖订单应按官方口径核验，不外推全国数量。",
    },
    {
      title: "太原午市渠道经营公开资料",
      url: "https://evidence.example/attribution/b",
      snippet: "太原午市外卖订单与渠道应交叉核验。",
    },
  ];
  const invalid = clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[1]);
  invalid.summary = "全国餐饮外卖规模已达83731亿，同比增长8.3%。";
  invalid.facts = invalid.facts.map((item) =>
    item.replace(/\s*\[来源\d+\]/gu, ""),
  );
  invalid.data_points = [
    "全国规模83731亿，未给出快照出处。",
    "同比增速8.3%，快照未支持。",
  ];
  invalid.viewpoints = invalid.viewpoints.map((item) =>
    item.replace(/\s*\[来源\d+\]/gu, ""),
  );
  invalid.source_coverage = invalid.source_coverage.map((item) => ({
    ...item,
    got: item.got.replace(/\s*\[来源\d+\]/gu, ""),
  }));
  invalid.sources = verified.map(({ title, url }) => ({ title, url }));

  const events = [];
  let modelCalls = 0;
  const registry = productionRegistry({
    events,
    validateOutputFn: validateContentEmployeeOutputContract,
    agenticWebResearchFn: agenticResearchStub(events, { sources: verified }),
    controlledWebFetchFn: controlledFetchStub(events, { results: verified }),
    responseFor: () => {
      modelCalls += 1;
      return {
        text: JSON.stringify(invalid),
        mode: "api",
        model: "yunwu-real-text-model",
        usage: { inputTokens: 80, outputTokens: 40 },
      };
    },
  });

  const result = await registry.invoke(1, context);
  assert.equal(modelCalls, 2);
  assert.equal(
    result.evidence.productionRuntime.contractRepair.attempted,
    true,
  );
  assert.equal(result.evidence.productionRuntime.contractRepair.rescued, true);
  assert.equal(
    result.evidence.productionRuntime.contractRepair.succeeded,
    true,
  );
  assert.match(result.result.data.summary, /无可验证事实/u);
  assert.match(result.result.data.data_points[0], /无可验证事实/u);
  assert.equal(result.result.data.sources.length >= 2, true);
});

test("run_benchmark返工后仍缺引用时，把对标项改写成缺证披露并交付", async () => {
  const context = pipelineContext(2);
  context.outputs[0].topics = [
    {
      title: "太原晚市两人套餐7天验证",
      angle: "先做决策结果再谈卖不卖得动",
      hook: "别先问卖不卖得动",
    },
  ];
  const verified = [
    {
      title: "太原餐饮晚市套餐公开经营资料",
      url: "https://evidence.example/benchmark/a",
      snippet: "晚市套餐应先核验决策口径，不外推播放量或到店增长。",
    },
    {
      title: "餐饮内容对标公开方法",
      url: "https://evidence.example/benchmark/b",
      snippet: "对标拆解只能复述来源明确支持的结构，不得编造热度数字。",
    },
    {
      title: "门店验证周期公开讨论",
      url: "https://evidence.example/benchmark/c",
      snippet: "7天验证是工作方法，不是已证实的经营结果。",
    },
  ];
  const invalid = clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[2]);
  invalid.benchmarks = invalid.benchmarks.map((item, index) => ({
    ...item,
    title: `${item.title}播放量已达${120 + index}万`,
    account: `虚构爆款号${index + 1}`,
    why_hot: `全平台爆款带动到店增长${30 + index}%，评论区一致认可甜口。`,
    dimensions: Object.fromEntries(
      Object.entries(item.dimensions).map(([key, value]) => [
        key,
        `${value} 曝光${80 + index}万，显著提升转化。`,
      ]),
    ),
  }));

  const events = [];
  let modelCalls = 0;
  const registry = productionRegistry({
    events,
    validateOutputFn: validateContentEmployeeOutputContract,
    agenticWebResearchFn: agenticResearchStub(events, { sources: verified }),
    controlledWebFetchFn: controlledFetchStub(events, { results: verified }),
    responseFor: () => {
      modelCalls += 1;
      return {
        text: JSON.stringify(invalid),
        mode: "api",
        model: "yunwu-real-text-model",
        usage: { inputTokens: 80, outputTokens: 40 },
      };
    },
  });

  const result = await registry.invoke(2, context);
  assert.equal(modelCalls, 2);
  assert.equal(
    result.evidence.productionRuntime.contractRepair.attempted,
    true,
  );
  assert.equal(result.evidence.productionRuntime.contractRepair.rescued, true);
  assert.equal(
    result.evidence.productionRuntime.contractRepair.succeeded,
    true,
  );
  assert.equal(result.result.data.benchmarks.length >= 3, true);
  assert.match(result.result.data.benchmarks[0].title, /无可验证事实/u);
  assert.match(result.result.data.benchmarks[0].why_hot, /无可验证事实/u);
  assert.match(
    result.result.data.benchmarks[0].dimensions["选题角度"],
    /无可验证事实/u,
  );
});

test("受控抓取结果带有额外字段时仍能生成可复用私有联网快照", async () => {
  const events = [];
  const innerFetch = controlledFetchStub(events);
  const registry = productionRegistry({
    events,
    controlledWebFetchFn: async (sources, runtimeOptions = {}) => {
      const base = await innerFetch(sources, runtimeOptions);
      return {
        ...base,
        results: base.results.map((item, index) => ({
          ...item,
          publishedAt: "2026-08-01",
          host: "candidate.example",
          score: 0.9 + index,
          rawHeaders: { server: "test" },
        })),
      };
    },
  });
  const result = await registry.invoke(0, pipelineContext(0));
  assert.equal(result.evidence.productionRuntime.web.verified, true);
  assert.match(
    result.evidence.productionRuntime.web.snapshot.snapshotFingerprint,
    /^sha256:[a-f0-9]{64}$/u,
  );
});

test("run_publish默认保留派活式发布节奏建议，不把间隔改成待核验套话", async () => {
  const planned = clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[8]);
  planned.publish_plan = `${planned.publish_plan} 先发公众号，间隔2–4小时再发小红书。`;
  planned.versions = planned.versions.map((item) => ({
    ...item,
    best_time: "工作日 12:00-13:00",
  }));
  let modelCalls = 0;
  const registry = productionRegistry({
    validateOutputFn: validateContentEmployeeOutputContract,
    responseFor: () => {
      modelCalls += 1;
      return {
        text: JSON.stringify(planned),
        mode: "api",
        model: "yunwu-real-text-model",
        usage: { inputTokens: 40, outputTokens: 20 },
      };
    },
  });
  const context = pipelineContext(8);
  context.brief.platforms = ["微信公众号", "小红书", "抖音"];
  context.task.platforms = context.brief.platforms;
  const result = await registry.invoke(8, context);
  assert.equal(result.evidence.productionRuntime.contractRepair.rescued, false);
  assert.match(result.result.data.publish_plan, /2–4小时/u);
  assert.equal(result.result.data.versions[0].best_time, "工作日 12:00-13:00");
  assert.equal(modelCalls, 1);
});

test("工位9无发布指标时注入缺口复盘提示，并把虚构指标救援成数据缺口报告", async () => {
  const invalid = clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[9]);
  invalid.report += "\n建议把餐饮完播率≥30%定为行业达标线。";
  const captured = [];
  const registry = productionRegistry({
    captured,
    validateOutputFn: validateContentEmployeeOutputContract,
    responseFor: () => ({
      text: JSON.stringify(invalid),
      mode: "api",
      model: "yunwu-real-text-model",
      usage: { inputTokens: 40, outputTokens: 20 },
    }),
  });
  const result = await registry.invoke(9, pipelineContext(9));
  assert.match(captured[0].args.system, /复盘官无数据安全返工模式/u);
  assert.equal(result.evidence.productionRuntime.contractRepair.rescued, true);
  assert.equal(
    result.evidence.productionRuntime.contractRepair.succeeded,
    true,
  );
  assert.equal(result.result.data.profile_updates.length, 0);
  assert.match(result.result.data.report, /指标计划|T\+1|预测性/u);
});

test("run_media带engine多余字段时先剥成契约形状再交付", async () => {
  const extra = {
    ...clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[5]),
    engine: "AI生图·gpt-image",
  };
  extra.images = extra.images.map((item, index) => ({
    ...item,
    file: index === 0 ? item.svg : undefined,
  }));
  let modelCalls = 0;
  const registry = productionRegistry({
    validateOutputFn: validateContentEmployeeOutputContract,
    specialProviderBridgeFactory: async (input) =>
      settledImageBridge(input, []),
    responseFor: () => {
      modelCalls += 1;
      return {
        text: JSON.stringify(extra),
        mode: "api",
        model: "yunwu-real-text-model",
        usage: { inputTokens: 40, outputTokens: 20 },
      };
    },
  });
  const result = await registry.invoke(5, pipelineContext(5));
  assert.equal(result.evidence.productionRuntime.contractRepair.rescued, true);
  assert.equal(
    result.evidence.productionRuntime.contractRepair.succeeded,
    true,
  );
  assert.deepEqual(Object.keys(result.result.data), ["images"]);
  assert.equal(
    result.result.data.images.every((item) => !item.file),
    true,
  );
  assert.ok(modelCalls >= 1);
});

test("run_media重复slot时自动改成唯一点位并继续交付", async () => {
  const duplicated = clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[5]);
  duplicated.images = duplicated.images.map((item) => ({
    ...item,
    slot: "文章首屏",
  }));
  let modelCalls = 0;
  const registry = productionRegistry({
    validateOutputFn: validateContentEmployeeOutputContract,
    specialProviderBridgeFactory: async (input) =>
      settledImageBridge(input, []),
    responseFor: () => {
      modelCalls += 1;
      return {
        text: JSON.stringify(duplicated),
        mode: "api",
        model: "yunwu-real-text-model",
        usage: { inputTokens: 40, outputTokens: 20 },
      };
    },
  });
  const result = await registry.invoke(5, pipelineContext(5));
  assert.equal(result.evidence.productionRuntime.contractRepair.rescued, true);
  assert.equal(
    result.evidence.productionRuntime.contractRepair.succeeded,
    true,
  );
  const slots = result.result.data.images.map((item) => item.slot);
  assert.equal(new Set(slots).size, slots.length);
  assert.ok(slots.includes("文章首屏"));
  assert.ok(modelCalls >= 1);
});

test("run_cover封面不足3张时自动补齐唯一样式并继续交付", async () => {
  const short = clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[6]);
  short.covers = short.covers.slice(0, 1);
  let modelCalls = 0;
  const registry = productionRegistry({
    validateOutputFn: validateContentEmployeeOutputContract,
    specialProviderBridgeFactory: async (input) =>
      settledImageBridge(input, []),
    responseFor: () => {
      modelCalls += 1;
      return {
        text: JSON.stringify(short),
        mode: "api",
        model: "yunwu-real-text-model",
        usage: { inputTokens: 40, outputTokens: 20 },
      };
    },
  });
  const result = await registry.invoke(6, pipelineContext(6));
  assert.equal(result.evidence.productionRuntime.contractRepair.rescued, true);
  assert.equal(
    result.evidence.productionRuntime.contractRepair.succeeded,
    true,
  );
  assert.equal(result.result.data.covers.length, 3);
  const styles = result.result.data.covers.map((item) => item.style);
  assert.equal(new Set(styles).size, styles.length);
  assert.ok(modelCalls >= 1);
});

test(
  "run_media返工后仍写出品稳定时，把信息图改成待核验并交付",
  { concurrency: false },
  async () => {
    const invalid = clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[5]);
    invalid.images[0].svg = invalid.images[0].svg.replace(
      "行动闭环",
      "出品稳定",
    );
    const events = [];
    let modelCalls = 0;
    const registry = productionRegistry({
      events,
      validateOutputFn: validateContentEmployeeOutputContract,
      specialProviderBridgeFactory: async (input) =>
        settledImageBridge(input, []),
      responseFor: () => {
        modelCalls += 1;
        return {
          text: JSON.stringify(invalid),
          mode: "api",
          model: "yunwu-real-text-model",
          usage: { inputTokens: 40, outputTokens: 20 },
        };
      },
    });
    const result = await registry.invoke(5, pipelineContext(5));
    assert.equal(modelCalls, 2);
    assert.equal(
      result.evidence.productionRuntime.contractRepair.rescued,
      true,
    );
    assert.equal(
      result.evidence.productionRuntime.contractRepair.succeeded,
      true,
    );
    assert.match(result.result.data.images[0].svg, /待核验/u);
    assert.doesNotMatch(result.result.data.images[0].svg, /出品稳定/u);
  },
);

test("Agentic候选充足但受控正文不足2条时明确报sources缺口，不调用最终模型", async () => {
  const onlyOne = [
    {
      title: "成本采购唯一真实来源",
      url: "https://evidence.example/only-one",
      snippet: "只有一条真实快照。",
    },
  ];
  const events = [];
  let textCalls = 0;
  const registry = productionRegistry({
    events,
    agenticWebResearchFn: agenticResearchStub(events, {
      sources: onlyOne,
    }),
    controlledWebFetchFn: controlledFetchStub(events, {
      results: onlyOne,
    }),
    responseFor: () => {
      textCalls += 1;
      throw new Error("不应调用最终模型");
    },
  });
  await assert.rejects(
    () => registry.invoke(1, pipelineContext(1)),
    (error) => {
      assert.equal(error.code, "CONTENT_PRODUCTION_WEB_EVIDENCE_MISSING");
      assert.match(error.message, /sources=\[\]\/证据缺口/u);
      assert.equal(
        error.contentHandlerEvidence.productionRuntime.web.resultCount,
        1,
      );
      return true;
    },
  );
  assert.equal(textCalls, 0);
});

test("run_research新attempt复用私有受控快照，不重复外部研究但重新调用最终模型", async () => {
  const context = pipelineContext(1);
  context.outputs[0].topics = [
    {
      title: "太原夜宵门店翻台异常",
      angle: "从时段与桌型核验真实原因",
      hook: "夜里人不少，为什么翻台还是上不去？",
    },
  ];
  context.outputs[0].selected = 0;
  const events = [];
  let modelCalls = 0;
  let failContract = true;
  const registry = productionRegistry({
    events,
    outputFor: () => {
      modelCalls += 1;
      return failContract
        ? { ...clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[1]), unexpected: true }
        : VALID_CONTENT_EMPLOYEE_OUTPUTS[1];
    },
  });

  let privateSnapshot;
  await assert.rejects(
    () => registry.invoke(1, context),
    (error) => {
      assert.equal(error.code, "CONTENT_PRODUCTION_OUTPUT_CONTRACT_FAILED");
      privateSnapshot = error.privateWebSnapshot;
      assert.ok(privateSnapshot);
      assert.equal(Object.keys(error).includes("privateWebSnapshot"), false);
      return true;
    },
  );
  assert.equal(events.filter((event) => event.type === "agentic").length, 1);
  assert.equal(events.filter((event) => event.type === "controlled").length, 1);
  assert.equal(modelCalls, 1);

  failContract = false;
  const retried = await registry.invoke(1, {
    ...context,
    privateWebSnapshot: privateSnapshot,
  });
  assert.equal(
    events.filter((event) => event.type === "agentic").length,
    1,
    "attempt2必须复用同业务输入的受控快照",
  );
  assert.equal(events.filter((event) => event.type === "controlled").length, 1);
  assert.equal(modelCalls, 2);
  assert.equal(retried.evidence.productionRuntime.web.reused, true);
  assert.equal(retried.evidence.productionRuntime.web.webSearchCalled, false);
  assert.equal(Object.keys(retried).includes("privateWebSnapshot"), false);

  const otherPipeline = clone(context);
  otherPipeline.tenantId = 2;
  otherPipeline.jobId = 82;
  otherPipeline.workflow.runId = 82;
  const isolated = await registry.invoke(1, {
    ...otherPipeline,
    privateWebSnapshot: privateSnapshot,
  });
  assert.equal(
    events.filter((event) => event.type === "agentic").length,
    2,
    "其他tenant/pipeline不得复用原任务私有快照",
  );
  assert.equal(events.filter((event) => event.type === "controlled").length, 2);
  assert.equal(modelCalls, 3);
  assert.equal(isolated.evidence.productionRuntime.web.reused, false);
});

test("私有快照只在选题、scope、上游与query plan指纹完全一致时复用", async () => {
  const context = pipelineContext(1);
  context.outputs[0].topics = [
    { title: "太原早餐客流", angle: "核验时段", hook: "客流去了哪里" },
  ];
  const events = [];
  let failContract = true;
  const registry = productionRegistry({
    events,
    outputFor: () =>
      failContract
        ? { ...clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[1]), unexpected: true }
        : VALID_CONTENT_EMPLOYEE_OUTPUTS[1],
  });
  let privateSnapshot;
  await assert.rejects(
    () => registry.invoke(1, context),
    (error) => {
      privateSnapshot = error.privateWebSnapshot;
      return Boolean(privateSnapshot);
    },
  );
  assert.equal(events.filter((event) => event.type === "agentic").length, 1);
  failContract = false;

  const changed = clone(context);
  changed.outputs[0].topics[0].title = "太原午餐外卖订单";
  const result = await registry.invoke(1, {
    ...changed,
    privateWebSnapshot: privateSnapshot,
  });
  assert.equal(
    events.filter((event) => event.type === "agentic").length,
    2,
    "selected topic变化后必须重新研究",
  );
  assert.equal(result.evidence.productionRuntime.web.reused, false);

  const changedChannel = clone(changed);
  changedChannel.settings.research = { channels: ["新增官方频道"] };
  const channelResult = await registry.invoke(1, {
    ...changedChannel,
    privateWebSnapshot: result.privateWebSnapshot,
  });
  assert.equal(
    events.filter((event) => event.type === "agentic").length,
    3,
    "scope/query plan变化后必须重新研究",
  );
  assert.equal(channelResult.evidence.productionRuntime.web.reused, false);

  const changedUpstream = clone(changedChannel);
  changedUpstream.outputs[0].briefing = "上游事实已更新";
  const upstreamResult = await registry.invoke(1, {
    ...changedUpstream,
    privateWebSnapshot: channelResult.privateWebSnapshot,
  });
  assert.equal(
    events.filter((event) => event.type === "agentic").length,
    4,
    "上游指纹变化后必须重新研究",
  );
  assert.equal(upstreamResult.evidence.productionRuntime.web.reused, false);
});

test("含凭据URL或完整性被篡改的私有快照会拒绝复用并重新执行完整研究链", async () => {
  const context = pipelineContext(1);
  context.outputs[0].topics = [
    { title: "太原午市外卖", angle: "核验订单", hook: "订单为何变化" },
  ];
  const events = [];
  let failContract = true;
  const registry = productionRegistry({
    events,
    outputFor: () =>
      failContract
        ? { ...clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[1]), unexpected: true }
        : VALID_CONTENT_EMPLOYEE_OUTPUTS[1],
  });
  let privateSnapshot;
  await assert.rejects(
    () => registry.invoke(1, context),
    (error) => {
      privateSnapshot = error.privateWebSnapshot;
      return Boolean(privateSnapshot);
    },
  );
  failContract = false;
  const tampered = clone(privateSnapshot);
  tampered.results[0].url = "https://user:password@evidence.example/private";
  const result = await registry.invoke(1, {
    ...context,
    privateWebSnapshot: tampered,
  });
  assert.equal(events.filter((event) => event.type === "agentic").length, 2);
  assert.equal(events.filter((event) => event.type === "controlled").length, 2);
  assert.equal(result.evidence.productionRuntime.web.reused, false);
});

test("私有联网快照默认24小时TTL：23小时复用，25小时过期并重跑完整研究链", async () => {
  const baseMs = Date.parse("2026-08-01T00:00:00.000Z");
  let currentMs = baseMs;
  const events = [];
  let modelCalls = 0;
  let failContract = true;
  const context = pipelineContext(1);
  context.outputs[0].topics = [
    { title: "太原夜宵翻台", angle: "核验客流", hook: "翻台为何下降" },
  ];
  const registry = productionRegistry({
    events,
    now: () => new Date(currentMs),
    outputFor: () => {
      modelCalls += 1;
      return failContract
        ? { ...clone(VALID_CONTENT_EMPLOYEE_OUTPUTS[1]), unexpected: true }
        : VALID_CONTENT_EMPLOYEE_OUTPUTS[1];
    },
  });
  let privateSnapshot;
  await assert.rejects(
    () => registry.invoke(1, context),
    (error) => {
      privateSnapshot = error.privateWebSnapshot;
      assert.equal(privateSnapshot.verifiedAt, "2026-08-01T00:00:00.000Z");
      return true;
    },
  );
  failContract = false;

  currentMs = baseMs + 23 * 60 * 60 * 1_000;
  const withinTtl = await registry.invoke(1, {
    ...context,
    privateWebSnapshot: privateSnapshot,
  });
  assert.equal(events.filter((event) => event.type === "agentic").length, 1);
  assert.equal(modelCalls, 2);
  assert.equal(withinTtl.evidence.productionRuntime.web.reused, true);
  assert.equal(withinTtl.evidence.productionRuntime.web.cache.expired, false);
  assert.equal(
    withinTtl.evidence.productionRuntime.web.cache.ageBucket,
    "1h_to_24h",
  );

  currentMs = baseMs + 25 * 60 * 60 * 1_000;
  const expired = await registry.invoke(1, {
    ...context,
    privateWebSnapshot: privateSnapshot,
  });
  assert.equal(events.filter((event) => event.type === "agentic").length, 2);
  assert.equal(events.filter((event) => event.type === "controlled").length, 2);
  assert.equal(modelCalls, 3);
  assert.equal(expired.evidence.productionRuntime.web.reused, false);
  assert.equal(expired.evidence.productionRuntime.web.cache.expired, true);
  assert.equal(
    expired.evidence.productionRuntime.web.cache.ageBucket,
    "over_24h",
  );
});
test("私有联网快照TTL配置只接受1分钟到7天", () => {
  assert.throws(
    () => productionRegistry({ webSnapshotMaxAgeMs: 59_999 }),
    /webSnapshotMaxAgeMs/u,
  );
  assert.throws(
    () =>
      productionRegistry({ webSnapshotMaxAgeMs: 7 * 24 * 60 * 60 * 1_000 + 1 }),
    /webSnapshotMaxAgeMs/u,
  );
  assert.doesNotThrow(() =>
    productionRegistry({ webSnapshotMaxAgeMs: 60_000 }),
  );
});

test("受控正文URL去掉追踪参数和fragment后去重，不足2篇时不调用最终模型", async () => {
  let modelCalls = 0;
  const events = [];
  const context = pipelineContext(1);
  context.outputs[0].topics = [
    { title: "太原夜宵翻台", angle: "核验客流", hook: "翻台为何下降" },
  ];
  const duplicateControlledSources = [
    {
      title: "太原夜宵翻台同一报道A",
      url: "https://News.Example.com/report/Case?b=2&utm_source=a&a=1#top",
      snippet: "太原夜宵翻台与客流核验。",
    },
    {
      title: "太原夜宵翻台同一报道B",
      url: "https://news.example.com/report/Case?a=1&b=2&utm_source=b#share",
      snippet: "太原夜宵翻台与客流核验。",
    },
  ];
  const registry = productionRegistry({
    events,
    controlledWebFetchFn: controlledFetchStub(events, {
      results: duplicateControlledSources,
    }),
    responseFor: () => {
      modelCalls += 1;
      throw new Error("不应调用模型");
    },
  });
  await assert.rejects(
    () => registry.invoke(1, context),
    (error) => {
      assert.equal(error.code, "CONTENT_PRODUCTION_WEB_EVIDENCE_MISSING");
      assert.equal(
        error.contentHandlerEvidence.productionRuntime.web.resultCount,
        1,
      );
      const web = error.contentHandlerEvidence.productionRuntime.web;
      assert.equal(web.controlledWebFetch.verifiedBodyCount, 1);
      assert.deepEqual(
        web.results.map((item) => item.url),
        ["https://news.example.com/report/Case?a=1&b=2"],
      );
      return true;
    },
  );
  assert.equal(modelCalls, 0);
});

test("非法JSON、template/mock或零token均在持久化前拒绝", async (t) => {
  await t.test("非法JSON", async () => {
    const registry = productionRegistry({
      validateOutputFn: undefined,
      responseFor: () => ({
        text: "{bad-json",
        mode: "api",
        model: "yunwu-real-text-model",
        usage: { inputTokens: 10, outputTokens: 10 },
      }),
    });
    await assert.rejects(
      () => registry.invoke(3, pipelineContext(3)),
      (error) => {
        assert.equal(error.code, "CONTENT_PRODUCTION_OUTPUT_CONTRACT_FAILED");
        assert.equal(error.contentHandlerEvidence.providerDelivery.mode, "api");
        assert.ok(
          error.contentHandlerEvidence.providerDelivery.usage.totalTokens > 0,
        );
        assert.equal(
          error.contentHandlerEvidence.providerDelivery.validated,
          false,
        );
        return true;
      },
    );
  });

  for (const scenario of [
    {
      name: "template",
      mode: "template",
      model: "template",
      usage: { inputTokens: 0, outputTokens: 0 },
      code: "CONTENT_PRODUCTION_REAL_API_REQUIRED",
    },
    {
      name: "mock",
      mode: "api",
      model: "deterministic-mock",
      usage: { inputTokens: 10, outputTokens: 10 },
      code: "CONTENT_PRODUCTION_REAL_API_REQUIRED",
    },
    {
      name: "零token",
      mode: "api",
      model: "yunwu-real-text-model",
      usage: { inputTokens: 10, outputTokens: 0 },
      code: "CONTENT_PRODUCTION_POSITIVE_TOKEN_USAGE_REQUIRED",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const registry = productionRegistry({
        responseFor: () => ({
          text: JSON.stringify(VALID_CONTENT_EMPLOYEE_OUTPUTS[3]),
          mode: scenario.mode,
          model: scenario.model,
          usage: scenario.usage,
        }),
      });
      await assert.rejects(
        () => registry.invoke(3, pipelineContext(3)),
        (error) => {
          assert.equal(error.code, scenario.code);
          assert.equal(
            error.contentHandlerEvidence.providerDelivery.mode,
            scenario.mode,
          );
          assert.equal(
            error.contentHandlerEvidence.providerDelivery.model,
            scenario.model,
          );
          return true;
        },
      );
    });
  }
});

test("缺完整canonical包或缺真实上游时不得绕开pipeline校验", async () => {
  const registry = productionRegistry();
  const missingPackage = pipelineContext(3);
  delete missingPackage.runtimePackageLoad.fieldFingerprints.skills;
  await assert.rejects(
    () => registry.invoke(3, missingPackage),
    (error) => error.code === "CONTENT_PRODUCTION_RUNTIME_PACKAGE_INVALID",
  );

  const missingUpstream = pipelineContext(3, { omitStations: [1] });
  await assert.rejects(
    () => registry.invoke(3, missingUpstream),
    (error) => error.code === "CONTENT_PRODUCTION_PERSISTED_UPSTREAM_MISSING",
  );
});

test("enable_deck=false允许后续工位缺少工位7，明确记录skipped而不伪造output[7]", async () => {
  const captured = [];
  const registry = productionRegistry({ captured });
  const result = await registry.invoke(
    8,
    pipelineContext(8, {
      enableDeck: false,
      omitStations: [7],
    }),
  );
  assert.deepEqual(
    result.evidence.productionRuntime.upstream.skippedStations,
    [7],
  );
  assert.deepEqual(result.evidence.productionRuntime.upstream.stationKeys, [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
  ]);
  assert.match(
    captured[0].args.userMsg,
    /enable_deck=false显式跳过的可选工位：7/u,
  );
  assert.doesNotMatch(captured[0].args.userMsg, /"7"\s*:/u);
});

test("工位5可注入独立provider bridge，真实产物与bridge证据进入运行证据", async () => {
  const bridgeInputs = [];
  const registry = productionRegistry({
    specialProviderBridgeFactory: async (input) => {
      bridgeInputs.push(clone(input));
      return {
        providers: {
          image: async ({ count }) => ({
            images: Array.from({ length: count }, (_, index) => ({
              url: `https://cdn.example/generated-${index + 1}.png`,
              mimeType: "image/png",
            })),
            provider: {
              name: "yunwu-image",
              model: input.imageModel,
              mode: "api",
            },
            mode: "api",
            model: input.imageModel,
            usage: { imageCount: count, tokenUsageApplicable: false },
          }),
        },
        evidence: () => ({
          schemaVersion: "nanowork.content-special-provider-bridge/1",
          attempts: [
            { kind: "image", status: "settled", credentialsIncluded: false },
          ],
          credentialsIncluded: false,
        }),
      };
    },
  });
  const context = pipelineContext(5);
  context.workflow.stationAttempt = 3;
  const result = await registry.invoke(5, context);
  assert.equal(bridgeInputs.length, 1);
  assert.equal(bridgeInputs[0].employeeIdx, 5);
  assert.equal(bridgeInputs[0].attemptOrdinal, 3);
  assert.equal(bridgeInputs[0].request.image_mode, "ai");
  assert.equal(bridgeInputs[0].request.image_count, 2);
  assert.equal(Object.hasOwn(bridgeInputs[0].request, "size"), false);
  assert.equal(
    result.evidence.productionRuntime.specialRuntime.fallback.used,
    false,
  );
  assert.equal(
    result.evidence.productionRuntime.specialRuntime.bridgeUnavailable,
    false,
  );
  assert.equal(
    result.evidence.productionRuntime.specialRuntime.artifacts[0].kind,
    "image",
  );
  assert.equal(
    result.evidence.productionRuntime.specialRuntime.artifacts[0].hasUrl,
    true,
  );
  assert.equal(
    result.evidence.productionRuntime.specialRuntime.bridge.attempts[0].status,
    "settled",
  );
});

test("工位5混合模式无授权素材时允许GPT Image 2位图补齐，不触发SVG回退禁令", async () => {
  const registry = productionRegistry({
    specialProviderBridgeFactory: async () => ({
      providers: {
        material: async () => ({
          assets: [],
          provider: { name: "licensed-material-library", mode: "local" },
        }),
        image: async ({ count }) => ({
          images: Array.from({ length: count }, (_, index) => ({
            url: `https://cdn.example/gpt-image-2-${index + 1}.png`,
            mimeType: "image/png",
          })),
          provider: {
            name: "yunwu-image",
            model: "gpt-image-2",
            mode: "api",
          },
          model: "gpt-image-2",
          mode: "api",
          usage: { imageCount: count, tokenUsageApplicable: false },
        }),
      },
      evidence: () => ({
        schemaVersion: "nanowork.content-special-provider-bridge/2",
        attempts: [],
        credentialsIncluded: false,
      }),
    }),
  });
  const context = pipelineContext(5);
  context.brief.image_mode = "mix";
  context.task.image_mode = "mix";

  const result = await registry.invoke(5, context);

  assert.equal(result.ok, true);
  assert.equal(
    result.result.specialRuntime.evidence.fallback.strategy,
    "licensed_material_to_ai_image",
  );
  assert.equal(
    result.result.specialRuntime.evidence.fallback.to,
    "gpt-image-2",
  );
  assert.ok(
    result.result.specialRuntime.artifacts.every(
      (artifact) =>
        artifact.kind === "image" && artifact.mimeType === "image/png",
    ),
  );
});

test("工位6默认创建真实图片bridge，逐平台生图并交付无HTML的持久化manifest", async () => {
  const bridgeInputs = [];
  const registry = productionRegistry({
    specialProviderBridgeFactory: async (input) =>
      settledImageBridge(input, bridgeInputs),
  });

  const result = await registry.invoke(6, pipelineContext(6));

  assert.equal(bridgeInputs.length, 1);
  assert.equal(bridgeInputs[0].employeeIdx, 6);
  assert.equal(bridgeInputs[0].request.image_mode, "ai");
  assert.equal(bridgeInputs[0].request.image_count, 1);
  assert.deepEqual(bridgeInputs[0].request.platforms, ["小红书"]);
  assert.equal(bridgeInputs[0].request.cover_mode, "image");
  assert.equal(bridgeInputs[0].request.paihuo_real_image_claim, true);
  assert.equal(bridgeInputs[0].request.cover_plan[0].size, "1024x1536");
  assert.deepEqual(result.result.specialRuntime.evidence.providerKindsCalled, [
    "image",
  ]);
  assert.equal(result.result.specialRuntime.evidence.fallback.used, false);
  assert.ok(
    result.result.specialRuntime.artifacts.every(
      (artifact) =>
        artifact.kind === "image" &&
        artifact.mimeType === "image/png" &&
        artifact.paihuoRealImage === true,
    ),
  );
  assert.equal(
    result.evidence.productionRuntime.specialRuntime.bridgeUnavailable,
    false,
  );
  assert.equal(
    result.evidence.productionRuntime.specialRuntime.artifactCount,
    1,
  );
  assert.equal(
    result.evidence.productionRuntime.specialRuntime.paihuoRealImage,
    true,
  );
  const manifest = JSON.parse(result.result.artifacts[0].content);
  assert.equal(manifest.deliveryClaim, "paihuo_real_image");
  assert.equal(manifest.covers[0].platform, "小红书");
  assert.equal(manifest.covers[0].requestedSize, "1024x1536");
  assert.deepEqual(manifest.persistedArtifactIds, ["material:9060"]);
  assert.doesNotMatch(result.result.artifacts[0].content, /<html|<svg/iu);
  const attempt =
    result.evidence.productionRuntime.specialRuntime.bridge.attempts[0];
  assert.equal(attempt.hold.holdId, 7006);
  assert.equal(attempt.billing.state, "settled");
  assert.equal(attempt.settlement.action, "settle");
  assert.equal(attempt.provider.model, "yunwu-real-image-model");
});

test("工位6文本通道零用量超时时自动恢复一次，成功后才启动真实封面生图", async () => {
  let textCalls = 0;
  const captured = [];
  const registry = productionRegistry({
    captured,
    specialProviderBridgeFactory: async (input) =>
      settledImageBridge(input, []),
    responseFor: (employeeIdx) => {
      assert.equal(employeeIdx, 6);
      textCalls += 1;
      if (textCalls === 1) {
        return {
          text: "",
          mode: "template",
          model: "template",
          usage: { inputTokens: 0, outputTokens: 0 },
          providerFailure: {
            code: "provider_timeout",
            status: 504,
            timedOut: true,
            retryable: true,
          },
        };
      }
      return {
        text: JSON.stringify(VALID_CONTENT_EMPLOYEE_OUTPUTS[6]),
        mode: "api",
        model: "yunwu-real-text-model",
        usage: { inputTokens: 46, outputTokens: 26 },
      };
    },
  });

  const result = await registry.invoke(6, pipelineContext(6));

  assert.equal(textCalls, 2);
  assert.equal(captured.length, 2);
  assert.equal(result.ok, true);
  assert.equal(
    result.evidence.productionRuntime.contractRepair.attempts[0].attempt,
    2,
  );
  assert.equal(
    result.evidence.productionRuntime.contractRepair.attempts[0].kind,
    "zero_usage_transport_retry",
  );
  assert.equal(result.result.specialRuntime.evidence.paihuoRealImage, true);
});

test("工位6鉴权失败不自动重试，错误明确暴露安全原因", async () => {
  let textCalls = 0;
  const registry = productionRegistry({
    specialProviderBridgeFactory: async (input) =>
      settledImageBridge(input, []),
    responseFor: () => {
      textCalls += 1;
      return {
        text: "",
        mode: "template",
        model: "template",
        usage: { inputTokens: 0, outputTokens: 0 },
        providerFailure: {
          code: "provider_auth_failed",
          status: 401,
          timedOut: false,
          retryable: false,
        },
      };
    },
  });

  await assert.rejects(
    () => registry.invoke(6, pipelineContext(6)),
    (error) => {
      assert.equal(error.code, "CONTENT_PRODUCTION_REAL_API_REQUIRED");
      assert.match(error.message, /供应商鉴权失败/u);
      assert.equal(
        error.contentHandlerEvidence.providerDelivery.providerFailure.code,
        "provider_auth_failed",
      );
      return true;
    },
  );
  assert.equal(textCalls, 1);
});

test("工位6默认缺少图片bridge时fail closed，不把已验证HTML契约当真实封面", async () => {
  const registry = productionRegistry();
  await assert.rejects(
    () => registry.invoke(6, pipelineContext(6)),
    (error) => {
      assert.equal(
        error.code,
        "CONTENT_PRODUCTION_SPECIAL_IMAGE_PROVIDER_REQUIRED",
      );
      assert.equal(
        error.contentHandlerEvidence.productionRuntime.specialRuntime
          .bridgeUnavailable,
        true,
      );
      assert.equal(
        error.contentHandlerEvidence.productionRuntime.specialRuntime
          .fallbackUsed,
        false,
      );
      return true;
    },
  );
});

test("工位6显式template=html时仅走兼容文本交付，证据不声称Paihuo真实生图", async () => {
  let bridgeFactoryCalls = 0;
  const registry = productionRegistry({
    specialProviderBridgeFactory: async () => {
      bridgeFactoryCalls += 1;
      throw new Error("显式HTML模式不应创建图片bridge");
    },
  });
  const context = pipelineContext(6);
  context.brief.template = "html";
  const result = await registry.invoke(6, context);
  assert.equal(bridgeFactoryCalls, 0);
  assert.equal(result.result.specialRuntime.evidence.paihuoRealImage, false);
  assert.equal(
    result.result.specialRuntime.evidence.deliveryClaim,
    "legacy_html_compatibility",
  );
  assert.deepEqual(result.result.specialRuntime.evidence.providerKindsCalled, [
    "text",
  ]);
  assert.ok(
    result.result.specialRuntime.artifacts.every(
      (artifact) =>
        artifact.kind === "html" && artifact.paihuoRealImage === false,
    ),
  );
});

test("bridge factory已配置却创建失败时fail closed，不把本地SVG回退冒充图片API成功", async () => {
  const registry = productionRegistry({
    specialProviderBridgeFactory: async () => {
      throw Object.assign(new Error("image provider unavailable"), {
        code: "IMAGE_PROVIDER_DOWN",
      });
    },
  });
  await assert.rejects(
    () => registry.invoke(5, pipelineContext(5)),
    (error) => {
      assert.equal(
        error.code,
        "CONTENT_PRODUCTION_SPECIAL_BRIDGE_CREATION_FAILED",
      );
      assert.equal(error.contentHandlerEvidence.providerDelivery.mode, "api");
      assert.equal(
        error.contentHandlerEvidence.productionRuntime.specialRuntime
          .fallbackUsed,
        false,
      );
      assert.equal(
        error.contentHandlerEvidence.productionRuntime.specialRuntime
          .bridgeFailure.code,
        "IMAGE_PROVIDER_DOWN",
      );
      return true;
    },
  );
});

test("工位5图片provider失败时fail closed，不用SVG示意图冒充成功", async () => {
  const registry = productionRegistry({
    specialProviderBridgeFactory: async () => ({
      providers: {
        image: async () => {
          throw Object.assign(
            new Error("image provider unavailable after bridge creation"),
            {
              code: "IMAGE_PROVIDER_RUNTIME_DOWN",
            },
          );
        },
      },
      evidence: () => ({
        schemaVersion: "nanowork.content-special-provider-bridge/1",
        attempts: [
          { kind: "image", status: "released", credentialsIncluded: false },
        ],
        credentialsIncluded: false,
      }),
    }),
  });
  await assert.rejects(
    () => registry.invoke(5, pipelineContext(5)),
    (error) => {
      assert.equal(error.code, "CONTENT_SPECIAL_HANDLER_RUNTIME_FAILED");
      assert.match(error.message, /不会用SVG、HTML或不足张数冒充完整交付/u);
      return true;
    },
  );
});

test("registry拒绝从配置或运行上下文接收凭据", async () => {
  assert.throws(
    () =>
      createContentProductionHandlerRegistry({
        generateFn: async () => ({}),
        apiKey: "forbidden",
      }),
    /registry不接收API Key/u,
  );
  const registry = productionRegistry();
  const context = pipelineContext(3);
  context.api_key = "forbidden";
  await assert.rejects(
    () => registry.invoke(3, context),
    (error) => error.code === "CONTENT_PRODUCTION_CREDENTIALS_FORBIDDEN",
  );
});

test("真实Agentic→受控WebFetch→provider→validate逐阶段上报，回调异常不改变业务结果且不泄露URL正文", async () => {
  const providerEvents = [];
  const progressEvents = [];
  let throwOnce = true;
  const registry = productionRegistry({ events: providerEvents });
  const result = await registry.invoke(0, {
    ...pipelineContext(0),
    progress(event) {
      progressEvents.push(clone(event));
      if (throwOnce) {
        throwOnce = false;
        throw new Error("进度消费者临时不可用");
      }
    },
  });

  assert.equal(result.evidence.completed, true);
  assert.deepEqual(
    providerEvents.map((event) => event.type),
    ["agentic", "controlled", "text"],
  );
  const transitions = progressEvents.map(
    (event) => `${event.phase}:${event.state}`,
  );
  assert.deepEqual(transitions, [
    "agentic_search:started",
    "agentic_search:completed",
    "controlled_fetch:started",
    "controlled_fetch:completed",
    "provider:started",
    "provider:completed",
    "validate:started",
    "validate:completed",
  ]);
  const serialized = JSON.stringify(progressEvents);
  assert.equal(serialized.includes("candidate.example"), false);
  assert.equal(serialized.includes("受控正文"), false);
  assert.equal(serialized.includes("内容生产工位0"), false);
  assert.equal(
    progressEvents.find(
      (event) => event.phase === "provider" && event.state === "completed",
    )?.usageRef?.totalTokens > 0,
    true,
  );
});
