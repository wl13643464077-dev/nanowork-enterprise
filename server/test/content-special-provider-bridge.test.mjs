import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONTENT_SPECIAL_PROVIDER_BRIDGE_SCHEMA,
  contentSpecialProviderAttemptIdentity,
  createContentSpecialProviderBridge,
  mergeContentSpecialProviderBillingEvidence,
} from "../src/engines/content-special-provider-bridge.js";
import { executeContentSpecialHandlerRuntime } from "../src/engines/content-special-handler-runtime.js";

function employeePackage(idx = 5) {
  return {
    identity: {
      idx,
      key: idx === 5 ? "media" : "cover",
      name: idx === 5 ? "多媒体师" : "封面师",
    },
    capabilities: [
      { name: "视觉策划", required: true, enabled: true, locked: true },
    ],
    workMethod: {
      input: {},
      execution: {},
      output: {},
      approval: {},
      handoff: {},
    },
    skills: {
      required: [{ title: "视觉生产" }],
      catalog: [{ title: "历史技能" }],
    },
    prompts: {
      systemPrompt: { template: "完整系统提示词" },
      soloPrompt: { template: "完整单派提示词" },
    },
    runtimeBindings: {
      models: { image: { credentials: "server_runtime_only" } },
    },
    workConfig: { factoryDefault: { imageModel: "gpt-image-2" } },
    jobProfile: { outputKeys: ["images"], boundaries: ["不得自动发布"] },
  };
}

function clock() {
  let tick = 0;
  return () =>
    new Date(`2026-08-01T10:00:${String(tick++).padStart(2, "0")}.000Z`);
}

function baseInput(overrides = {}) {
  return {
    tenantId: 7,
    userId: 17,
    runId: 49,
    employeeIdx: 5,
    employeePackage: employeePackage(5),
    imageModel: "gpt-image-2",
    request: {
      prompt: "生成餐饮经营信息图，不得编造价格与效果",
      image_mode: "ai",
      image_count: 2,
      platforms: ["小红书", "公众号"],
      size: "1024x1024",
    },
    ...overrides,
  };
}

function billingDependencies(overrides = {}) {
  const events = [];
  let holdSequence = 0;
  const dependencies = {
    now: clock(),
    estimateMaxCreditsFn(kind, model) {
      events.push(`estimate:${kind}:${model}`);
      return 75;
    },
    holdCreditsFn(input) {
      events.push(`hold:${input.kind}:${input.credits}`);
      return {
        holdId: ++holdSequence,
        logId: holdSequence + 100,
        tenantId: input.tenantId,
        userId: input.userId,
        kind: input.kind,
        model: input.model,
        credits: input.credits,
        balance: 10_000 - input.credits,
      };
    },
    settleHoldFn(hold, input) {
      events.push(`settle:${hold.holdId}:${input.credits}`);
      return { credits: input.credits, balance: 9_900, costYuan: 1 };
    },
    releaseHoldFn(hold) {
      events.push(`release:${hold.holdId}`);
      return { credits: 0, balance: 10_000, costYuan: 0 };
    },
    async persistProviderOutputFn(input) {
      events.push(`persist:${input.kind}`);
      return {
        persisted: true,
        artifactIds: [`artifact-${input.kind}-1`],
        targetType: "content_special_artifact",
        targetId: 501,
      };
    },
    ...overrides,
  };
  return { events, dependencies };
}

test("bridge强制要求租户、用户、run、employee、完整员工包、图片模型和请求", () => {
  const complete = baseInput();
  for (const field of [
    "tenantId",
    "userId",
    "runId",
    "employeePackage",
    "imageModel",
    "request",
  ]) {
    const invalid = { ...complete };
    delete invalid[field];
    assert.throws(() =>
      createContentSpecialProviderBridge(
        invalid,
        billingDependencies().dependencies,
      ),
    );
  }
  assert.throws(
    () =>
      createContentSpecialProviderBridge(
        {
          ...complete,
          employeePackage: { ...complete.employeePackage, prompts: undefined },
        },
        billingDependencies().dependencies,
      ),
    /完整员工包缺少.*prompts/u,
  );
  assert.throws(
    () =>
      createContentSpecialProviderBridge(
        {
          ...complete,
          employeePackage: employeePackage(6),
        },
        billingDependencies().dependencies,
      ),
    /employeeIdx不一致/u,
  );
  assert.throws(
    () =>
      createContentSpecialProviderBridge(
        {
          ...complete,
          request: {
            ...complete.request,
            apiKey: "sk-never-accept-this-secret",
          },
        },
        billingDependencies().dependencies,
      ),
    /不能携带API Key/u,
  );
  const missingPaihuoCount = { ...complete.request };
  delete missingPaihuoCount.image_count;
  assert.throws(
    () =>
      createContentSpecialProviderBridge(
        {
          ...complete,
          request: missingPaihuoCount,
        },
        billingDependencies().dependencies,
      ),
    /Paihuo Brief原字段image_count/u,
  );
});

test("真实图片provider严格按hold→供应商→业务持久化→settle执行并可注入special runtime", async () => {
  const providerIdempotencyKeys = [];
  const providerPrompts = [];
  const { events, dependencies } = billingDependencies({
    async generateImageFn(input) {
      events.push(`generate:${input.model}:${input.size}`);
      providerIdempotencyKeys.push(input.idempotencyKey);
      providerPrompts.push(input.prompt);
      assert.match(input.prompt, /完整内容员工包/u);
      assert.match(input.prompt, /视觉策划/u);
      assert.match(input.prompt, /完整单派提示词/u);
      return {
        model: input.model,
        url: `https://images.example/${events.filter((item) => item.startsWith("generate:")).length}.png`,
      };
    },
  });
  const bridge = createContentSpecialProviderBridge(baseInput(), dependencies);
  const runtime = await executeContentSpecialHandlerRuntime({
    executionKind: "media_generation_with_svg_fallback",
    runId: 49,
    invocationId: "handler-49",
    prompt: { system: "完整岗位", user: "生成图片" },
    variables: {
      media_request: {
        mode: "ai",
        imageCount: 2,
        platforms: ["小红书", "公众号"],
        plan: [
          { slot: "首图机会点", desc: "门店新客流与餐饮机会信息图" },
          { slot: "结尾行动项", desc: "餐饮老板七日动作清单" },
        ],
      },
    },
    providers: bridge.providers,
    now: clock(),
  });

  assert.deepEqual(events, [
    "estimate:image:gpt-image-2",
    "hold:image:150",
    "generate:gpt-image-2:1024x1024",
    "generate:gpt-image-2:1024x1024",
    "persist:image",
    "settle:1:150",
  ]);
  assert.equal(runtime.artifacts.length, 2);
  assert.ok(runtime.artifacts.every((item) => item.kind === "image"));
  assert.deepEqual(providerIdempotencyKeys, [
    "content-special-provider:pipeline:49:station:5:provider:image:attempt:1:image:1",
    "content-special-provider:pipeline:49:station:5:provider:image:attempt:1:image:2",
  ]);
  assert.equal(new Set(providerPrompts).size, 2);
  assert.match(providerPrompts[0], /首图机会点/u);
  assert.match(providerPrompts[0], /门店新客流/u);
  assert.doesNotMatch(providerPrompts[0], /结尾行动项/u);
  assert.match(providerPrompts[1], /结尾行动项/u);
  assert.match(providerPrompts[1], /七日动作清单/u);
  const evidence = bridge.evidence();
  assert.equal(evidence.schemaVersion, CONTENT_SPECIAL_PROVIDER_BRIDGE_SCHEMA);
  assert.equal(evidence.employeePackage.fullPackageInjected, true);
  assert.equal(evidence.employeePackage.capabilityCount, 1);
  assert.match(evidence.employeePackage.fingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(evidence.request.rawPromptIncluded, false);
  assert.equal(evidence.attempts[0].status, "settled");
  assert.equal(evidence.attempts[0].billing.chargedCredits, 150);
  assert.deepEqual(evidence.attempts[0].hold, {
    holdId: 1,
    estimatedCredits: 150,
    refType: "content_special_provider",
    refId: contentSpecialProviderAttemptIdentity({
      runId: 49,
      employeeIdx: 5,
      kind: "image",
    }).refId,
  });
  assert.equal(
    evidence.attempts[0].attemptId,
    "content-special-provider:pipeline:49:station:5:provider:image:attempt:1",
  );
  assert.deepEqual(evidence.attempts[0].usage, {
    inputTokens: 0,
    outputTokens: 0,
    imageCount: 2,
    tokenUsageApplicable: false,
    pricingMode: "fixed_price_per_image",
  });
  assert.deepEqual(evidence.attempts[0].settlement, {
    action: "settle",
    holdId: 1,
    chargedCredits: 150,
    pendingReconciliation: false,
  });
  assert.deepEqual(evidence.attempts[0].delivery.artifactIds, [
    "artifact-image-1",
  ]);
  assert.equal(evidence.attempts[0].imageSlots.length, 2);
  assert.ok(
    evidence.attempts[0].imageSlots.every(
      (item) =>
        /^sha256:[a-f0-9]{64}$/u.test(item.slotFingerprint) &&
        /^sha256:[a-f0-9]{64}$/u.test(item.providerPromptSha256) &&
        item.rawPromptIncluded === false,
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(evidence),
    /首图机会点|门店新客流|结尾行动项|七日动作清单/u,
  );
  assert.equal(evidence.credentialsIncluded, false);
});

test("idx6封面bridge按平台逐图传递竖版/横版尺寸，持久化与hold/settle证据完整", async () => {
  const generated = [];
  const { events, dependencies } = billingDependencies({
    async generateImageFn(input) {
      generated.push({
        size: input.size,
        prompt: input.prompt,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        model: input.model,
        url: `https://images.example/cover-${generated.length}.png`,
        mimeType: "image/png",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  });
  const bridge = createContentSpecialProviderBridge(
    baseInput({
      employeeIdx: 6,
      employeePackage: employeePackage(6),
      request: {
        prompt: "按Paihuo run_cover生成真实中文封面位图",
        image_mode: "ai",
        image_count: 2,
        platforms: ["小红书", "公众号"],
      },
    }),
    dependencies,
  );
  const runtime = await executeContentSpecialHandlerRuntime({
    executionKind: "cover_generation_with_html_fallback",
    runId: 49,
    invocationId: "cover-handler-49",
    prompt: { system: "封面师完整岗位", user: "生成封面" },
    variables: {
      cover_request: {
        mode: "image",
        platforms: ["小红书", "公众号"],
        plan: [
          {
            slot: "小红书封面",
            desc: "中文大字竖版封面",
            platform: "小红书",
            size: "1024x1536",
            displaySize: "1080×1440(3:4 竖版)",
            style: "AI封面",
          },
          {
            slot: "公众号封面",
            desc: "中文大字横版头图",
            platform: "公众号",
            size: "1536x1024",
            displaySize: "900×383(2.35:1 头图)",
            style: "AI封面",
          },
        ],
      },
    },
    providers: bridge.providers,
    now: clock(),
  });

  assert.deepEqual(
    generated.map((item) => item.size),
    ["1024x1536", "1536x1024"],
  );
  assert.match(generated[0].prompt, /小红书封面/u);
  assert.match(generated[1].prompt, /公众号封面/u);
  assert.notEqual(generated[0].idempotencyKey, generated[1].idempotencyKey);
  assert.deepEqual(events, [
    "estimate:image:gpt-image-2",
    "hold:image:150",
    "persist:image",
    "settle:1:150",
  ]);
  assert.equal(runtime.evidence.paihuoRealImage, true);
  assert.equal(runtime.artifacts.length, 2);
  assert.deepEqual(
    runtime.artifacts.map((item) => item.platform),
    ["小红书", "公众号"],
  );
  const attempt = bridge.evidence().attempts[0];
  assert.equal(attempt.hold.holdId, 1);
  assert.equal(attempt.billing.state, "settled");
  assert.equal(attempt.billing.chargedCredits, 150);
  assert.equal(attempt.settlement.action, "settle");
  assert.equal(attempt.provider.model, "gpt-image-2");
  assert.equal(attempt.usage.imageCount, 2);
  assert.deepEqual(
    attempt.imageSlots.map((item) => ({
      source: item.source,
      platform: item.platform,
      requestedSize: item.requestedSize,
    })),
    [
      {
        source: "cover_platform_plan",
        platform: "小红书",
        requestedSize: "1024x1536",
      },
      {
        source: "cover_platform_plan",
        platform: "公众号",
        requestedSize: "1536x1024",
      },
    ],
  );
});

test("带租约attempt必须先校验claim并即时关联hold，之后才允许调用外部provider", async () => {
  const { events, dependencies } = billingDependencies({
    async resolveProviderAttemptFn() {
      events.push("attempt:resolve");
      return null;
    },
    async claimProviderAttemptFn() {
      events.push("attempt:claim");
      return { state: "claimed", leaseToken: "lease-before-provider" };
    },
    async validateProviderClaimFn(identity) {
      events.push("attempt:validate");
      assert.equal(identity.leaseToken, "lease-before-provider");
    },
    async associateProviderHoldFn(input) {
      events.push(`attempt:associate:${input.hold.holdId}`);
      assert.equal(input.leaseToken, "lease-before-provider");
    },
    async generateImageFn() {
      events.push("generate:external");
      return { model: "gpt-image-2", url: "https://images.example/leased.png" };
    },
    async persistProviderOutputFn(input) {
      events.push("persist:image");
      assert.equal(input.attempt.leaseToken, "lease-before-provider");
      return {
        persisted: true,
        artifactIds: ["material:leased"],
        targetType: "material",
        targetId: 1,
      };
    },
    async finalizeProviderAttemptFn(input) {
      events.push(`attempt:finalize:${input.status}`);
      assert.equal(input.leaseToken, "lease-before-provider");
    },
  });
  const input = baseInput();
  input.request = { ...input.request, image_count: 1 };
  await createContentSpecialProviderBridge(input, dependencies).providers.image(
    { count: 1, purpose: "content_images" },
  );

  assert.deepEqual(events, [
    "estimate:image:gpt-image-2",
    "attempt:resolve",
    "attempt:claim",
    "attempt:validate",
    "hold:image:75",
    "attempt:associate:1",
    "generate:external",
    "persist:image",
    "settle:1:75",
    "attempt:finalize:settled",
  ]);
});

test("文本与专项provider账务统一汇总，全部结算计入总实扣，任一待对账则整体停门", () => {
  const textBilling = {
    state: "settled",
    holdId: 10,
    estimatedCredits: 20,
    chargedCredits: 12,
    heldCredits: 0,
    balance: 900,
    costYuan: 0.12,
  };
  const settled = mergeContentSpecialProviderBillingEvidence(
    textBilling,
    [
      {
        attemptId:
          "content-automation:pipeline:1:station:5:provider:image:attempt:1",
        kind: "image",
        status: "settled",
        hold: { holdId: 11, refType: "content_special_provider", refId: 111 },
        billing: {
          state: "settled",
          estimatedCredits: 75,
          chargedCredits: 75,
          heldCredits: 0,
          balance: 925,
          costYuan: 0.75,
        },
        delivery: { persisted: true, artifactIds: ["material:1"] },
      },
    ],
    { primaryComponent: "automationText" },
  );
  assert.equal(settled.state, "settled");
  assert.equal(settled.estimatedCredits, 95);
  assert.equal(settled.chargedCredits, 87);
  assert.equal(settled.balance, 900, "文本最后结算，其balance才是运行最终余额");
  assert.equal(settled.components.automationText.holdId, 10);
  assert.equal(settled.components.specialProviders[0].holdId, 11);

  const pending = mergeContentSpecialProviderBillingEvidence(textBilling, [
    {
      attemptId:
        "content-automation:pipeline:2:station:5:provider:image:attempt:1",
      kind: "image",
      status: "pending_reconciliation",
      hold: { holdId: 12, refType: "content_special_provider", refId: 112 },
      billing: {
        state: "pending_reconciliation",
        estimatedCredits: 75,
        chargedCredits: null,
        heldCredits: 75,
        pendingReconciliation: true,
      },
      delivery: { persisted: true, artifactIds: ["material:2"] },
    },
  ]);
  assert.equal(pending.state, "pending_reconciliation");
  assert.equal(pending.chargedCredits, null);
  assert.equal(pending.heldCredits, 75);

  const released = mergeContentSpecialProviderBillingEvidence(textBilling, [
    {
      attemptId:
        "content-automation:pipeline:3:station:6:provider:image:attempt:1",
      kind: "image",
      status: "released",
      hold: { holdId: 13, refType: "content_special_provider", refId: 113 },
      billing: {
        state: "released",
        estimatedCredits: 150,
        chargedCredits: 0,
        heldCredits: 0,
        pendingReconciliation: false,
      },
    },
  ]);
  assert.equal(released.state, "settled");
  assert.equal(released.pendingReconciliation, false);
  assert.equal(released.chargedCredits, 12);
});

test("工位5图片供应商失败或空结果时先释放hold，AI配图fail closed不进SVG回退", async () => {
  const secret = "sk-provider-failure-secret-123456";
  const { events, dependencies } = billingDependencies({
    async generateImageFn(input) {
      events.push("generate:empty");
      assert.doesNotMatch(input.prompt, /不得进入凭空生图/u);
      return { model: "gpt-image-2", url: null, b64: null, error: secret };
    },
  });
  const bridge = createContentSpecialProviderBridge(
    baseInput({
      request: {
        prompt: `封面生成 ${secret}`,
        image_mode: "ai",
        image_count: 1,
        platforms: ["小红书"],
        xhs_style: "不得进入凭空生图",
        dy_style: "不得进入凭空生图",
        size: "1024x1024",
      },
    }),
    dependencies,
  );
  let runtimeError = null;
  try {
    await executeContentSpecialHandlerRuntime({
      executionKind: "media_generation_with_svg_fallback",
      runId: 49,
      invocationId: "cover-49",
      prompt: { system: "封面师", user: "生成封面" },
      variables: {
        media_request: {
          mode: "ai",
          imageCount: 1,
          platforms: ["小红书"],
          plan: [{ slot: "首图", desc: "餐饮经营主题信息图" }],
        },
      },
      providers: {
        ...bridge.providers,
        async text() {
          events.push("text:fallback");
          return {
            data: {
              images: [
                {
                  slot: "首图",
                  desc: "餐饮经营主题信息图",
                  svg: "<svg><text>安全回退配图</text></svg>",
                },
              ],
            },
            model: "text-fallback",
            usage: { inputTokens: 10, outputTokens: 20 },
          };
        },
      },
      now: clock(),
    });
  } catch (error) {
    runtimeError = error;
  }

  // AI配图必须真图：图片供应商空结果时整体失败退款，不调用文本SVG回退。
  assert.ok(runtimeError, "AI配图空结果必须fail closed");
  assert.equal(runtimeError.code, "CONTENT_SPECIAL_HANDLER_RUNTIME_FAILED");
  assert.match(runtimeError.message, /不会用SVG示意图冒充配图/u);
  assert.equal(runtimeError.evidence.fallback.used, false);
  assert.equal(runtimeError.evidence.paihuoRealImage, false);
  assert.deepEqual(events, [
    "estimate:image:gpt-image-2",
    "hold:image:75",
    "generate:empty",
    "release:1",
  ]);
  const evidence = bridge.evidence();
  assert.equal(evidence.attempts[0].status, "released");
  assert.equal(evidence.attempts[0].billing.chargedCredits, 0);
  assert.equal(evidence.attempts[0].delivery, null);
  assert.equal(evidence.request.imageCount, 1);
  assert.equal(evidence.request.imageCountMode, "explicit");
  assert.deepEqual(evidence.request.excludedLegacyStyleFields, [
    "xhs_style",
    "dy_style",
  ]);
  assert.equal(evidence.attempts[0].requestedCount, 1);
  assert.equal(evidence.attempts[0].settlement.action, "release");
  assert.doesNotMatch(
    JSON.stringify({ error: runtimeError.evidence, evidence }),
    /provider-failure-secret/u,
  );
  assert.doesNotMatch(
    JSON.stringify({ error: runtimeError.evidence, evidence }),
    /不得进入凭空生图/u,
  );
});

test("Paihuo image_count为null时保留auto语义，不采用运行时默认4张", async () => {
  let generated = 0;
  const { events, dependencies } = billingDependencies({
    async generateImageFn(input) {
      generated += 1;
      events.push(`generate:auto:${generated}`);
      assert.doesNotMatch(input.prompt, /运行时小红书风格|运行时抖音风格/u);
      return {
        model: "gpt-image-2",
        url: `https://images.example/auto-${generated}.png`,
      };
    },
  });
  const bridge = createContentSpecialProviderBridge(
    baseInput({
      request: {
        prompt: "自动数量图片测试",
        image_mode: "ai",
        image_count: null,
        platforms: ["小红书", "公众号"],
        size: "1024x1024",
      },
    }),
    dependencies,
  );
  const response = await bridge.providers.image({
    count: 4,
    purpose: "content_images",
    variables: {
      xhs_style: "运行时小红书风格",
      nested: { dy_style: "运行时抖音风格" },
      media_request: {
        plan: [
          { slot: "首图", desc: "新客流机会图" },
          { slot: "中段", desc: "消费场景关系图" },
          { slot: "结尾", desc: "七日行动图" },
        ],
      },
    },
  });
  assert.equal(response.images.length, 3);
  assert.equal(generated, 3);
  assert.deepEqual(events, [
    "estimate:image:gpt-image-2",
    "hold:image:225",
    "generate:auto:1",
    "generate:auto:2",
    "generate:auto:3",
    "persist:image",
    "settle:1:225",
  ]);
  const evidence = bridge.evidence();
  assert.equal(evidence.request.imageCountMode, "auto");
  assert.equal(evidence.request.imageCount, null);
  assert.equal(evidence.attempts[0].requestedCount, 3);
});

test("仅小红书且未显式指定尺寸时选供应商竖版安全尺寸，显式尺寸和其他平台保持兼容", async () => {
  async function observedSize(platforms, explicitSize) {
    let size;
    const { dependencies } = billingDependencies({
      async generateImageFn(input) {
        size = input.size;
        return { model: "gpt-image-2", url: "https://images.example/size.png" };
      },
    });
    const request = {
      prompt: "平台尺寸语义验收",
      image_mode: "ai",
      image_count: 1,
      platforms,
    };
    if (explicitSize) request.size = explicitSize;
    const bridge = createContentSpecialProviderBridge(
      baseInput({ request }),
      dependencies,
    );
    await bridge.providers.image({ count: 1, purpose: "platform_covers" });
    return { size, evidence: bridge.evidence() };
  }

  const xhs = await observedSize(["小红书"]);
  assert.equal(xhs.size, "1024x1536");
  assert.equal(xhs.evidence.request.sizeSource, "platform_default");

  const explicit = await observedSize(["小红书"], "1024x1024");
  assert.equal(explicit.size, "1024x1024");
  assert.equal(explicit.evidence.request.sizeSource, "explicit");

  const other = await observedSize(["公众号"]);
  assert.equal(other.size, "1024x1024");
  assert.equal(other.evidence.request.sizeSource, "generic_default");
});

test("业务持久化失败时全额释放，不允许settle，也不返回可交付provider结果", async () => {
  const { events, dependencies } = billingDependencies({
    async generateImageFn() {
      events.push("generate:ok");
      return {
        model: "gpt-image-2",
        url: "https://images.example/persist-fail.png",
      };
    },
    async persistProviderOutputFn() {
      events.push("persist:fail");
      throw new Error("injected persistence failure");
    },
  });
  const bridge = createContentSpecialProviderBridge(
    baseInput({
      request: {
        prompt: "持久化失败测试",
        image_mode: "ai",
        image_count: 1,
        platforms: [],
        size: "1024x1024",
      },
    }),
    dependencies,
  );
  await assert.rejects(
    bridge.providers.image({ count: 1, purpose: "content_images" }),
    (error) => {
      assert.equal(error.deliveryPhase, "persist");
      assert.equal(error.billing.state, "released");
      assert.equal(
        error.contentSpecialProviderBridgeEvidence.attempts[0].status,
        "released",
      );
      return true;
    },
  );
  assert.deepEqual(events, [
    "estimate:image:gpt-image-2",
    "hold:image:75",
    "generate:ok",
    "persist:fail",
    "release:1",
  ]);
});

test("素材provider也独立预授权，只有素材持久化成功才结算", async () => {
  const { events, dependencies } = billingDependencies({
    async materialSearchFn(input) {
      events.push(`material:${input.count}`);
      assert.equal(input.employeePackage.capabilities.length, 1);
      return {
        assets: [
          { url: "https://licensed.example/a.webp", mimeType: "image/webp" },
          { url: "https://licensed.example/b.webp", mimeType: "image/webp" },
        ],
        provider: {
          name: "licensed-library",
          model: "licensed-search",
          mode: "api",
        },
        cost: { credits: 40 },
      };
    },
    async generateImageFn() {
      throw new Error("素材provider测试不应调用图片生成");
    },
  });
  const bridge = createContentSpecialProviderBridge(baseInput(), dependencies);
  const response = await bridge.providers.material({
    count: 2,
    purpose: "licensed_material_search",
  });
  assert.equal(response.assets.length, 2);
  assert.equal(response.provider.name, "licensed-library");
  assert.equal(response.bridge.billing.state, "settled");
  assert.equal(response.bridge.billing.chargedCredits, 40);
  assert.deepEqual(events, [
    "estimate:image:gpt-image-2",
    "hold:image:150",
    "material:2",
    "persist:material",
    "settle:1:40",
  ]);
});

test("预授权失败时不暗调供应商API", async () => {
  let generated = 0;
  const { events, dependencies } = billingDependencies({
    holdCreditsFn() {
      events.push("hold:denied");
      throw Object.assign(new Error("积分不足"), { status: 402 });
    },
    async generateImageFn() {
      generated += 1;
      return { url: "https://images.example/should-not-exist.png" };
    },
  });
  const bridge = createContentSpecialProviderBridge(baseInput(), dependencies);
  await assert.rejects(bridge.providers.image({ count: 1 }), /积分不足/u);
  assert.equal(generated, 0);
  assert.deepEqual(events, ["estimate:image:gpt-image-2", "hold:denied"]);
  assert.equal(bridge.evidence().attempts[0].status, "not_held");
});

test("pipeline+station+kind形成稳定且互不共用的attemptId/refId", () => {
  const image5a = contentSpecialProviderAttemptIdentity({
    namespace: "content-production-pipeline",
    runId: 49,
    employeeIdx: 5,
    kind: "image",
  });
  const image5b = contentSpecialProviderAttemptIdentity({
    namespace: "content-production-pipeline",
    runId: 49,
    employeeIdx: 5,
    kind: "image",
  });
  const material5 = contentSpecialProviderAttemptIdentity({
    namespace: "content-production-pipeline",
    runId: 49,
    employeeIdx: 5,
    kind: "material",
  });
  const image6 = contentSpecialProviderAttemptIdentity({
    namespace: "content-production-pipeline",
    runId: 49,
    employeeIdx: 6,
    kind: "image",
  });
  assert.deepEqual(image5a, image5b);
  assert.match(
    image5a.attemptId,
    /pipeline:49:station:5:provider:image:attempt:1$/u,
  );
  assert.equal(new Set([image5a.refId, material5.refId, image6.refId]).size, 3);
  assert.ok(
    [image5a, material5, image6].every((item) =>
      Number.isSafeInteger(item.refId),
    ),
  );
});

test("已持久化并结算的稳定attempt在新bridge恢复时直接回放，不重复hold、API、INSERT或settle", async () => {
  const { events, dependencies } = billingDependencies();
  let stored = null;
  const ledger = {
    async resolveProviderAttemptFn(identity) {
      events.push("attempt:resolve");
      if (!stored) return null;
      assert.equal(identity.attemptId, stored.identity.attemptId);
      assert.equal(
        identity.requestFingerprint,
        stored.identity.requestFingerprint,
      );
      return {
        state: "replay",
        output: structuredClone(stored.output),
        delivery: structuredClone(stored.delivery),
        billing: structuredClone(stored.billing),
        hold: structuredClone(stored.hold),
      };
    },
    async claimProviderAttemptFn(identity) {
      events.push("attempt:claim");
      stored = { identity: structuredClone(identity) };
      return { state: "claimed" };
    },
    async finalizeProviderAttemptFn(input) {
      events.push(`attempt:finalize:${input.status}`);
      stored.billing = structuredClone(input.billing);
      stored.delivery = structuredClone(input.delivery || stored.delivery);
      stored.hold = structuredClone(input.hold);
    },
    async persistProviderOutputFn(input) {
      events.push("persist:image");
      stored.output = structuredClone(input.output);
      stored.delivery = {
        persisted: true,
        artifactIds: ["material:8801"],
        targetType: "material",
        targetId: 8801,
      };
      stored.hold = structuredClone(input.hold);
      return structuredClone(stored.delivery);
    },
  };
  const injected = {
    ...dependencies,
    ...ledger,
    async generateImageFn(input) {
      events.push(`generate:${input.idempotencyKey}`);
      return {
        model: input.model,
        url: "https://images.example/idempotent.png",
      };
    },
  };
  const input = baseInput({
    attemptNamespace: "content-production-pipeline",
    request: {
      prompt: "幂等恢复测试",
      image_mode: "ai",
      image_count: 1,
      platforms: ["小红书"],
      size: "1024x1024",
    },
  });
  const firstBridge = createContentSpecialProviderBridge(input, injected);
  const first = await firstBridge.providers.image({
    count: 1,
    purpose: "content_images",
  });
  const secondBridge = createContentSpecialProviderBridge(input, injected);
  const replayed = await secondBridge.providers.image({
    count: 1,
    purpose: "content_images",
  });

  assert.equal(first.bridge.replayed, false);
  assert.equal(replayed.bridge.replayed, true);
  assert.equal(replayed.bridge.attemptId, first.bridge.attemptId);
  assert.equal(events.filter((item) => item.startsWith("hold:")).length, 1);
  assert.equal(events.filter((item) => item.startsWith("generate:")).length, 1);
  assert.equal(events.filter((item) => item === "persist:image").length, 1);
  assert.equal(events.filter((item) => item.startsWith("settle:")).length, 1);
  assert.equal(secondBridge.evidence().attempts[0].replayed, true);
  assert.equal(secondBridge.evidence().attempts[0].billing.state, "settled");
});

test("特殊provider结算失败的持久化attempt回放仍保持pending_reconciliation且不二次调用", async () => {
  const { events, dependencies } = billingDependencies({
    settleHoldFn() {
      events.push("settle:failed");
      throw new Error("injected settle failure");
    },
  });
  let stored = null;
  const hooks = {
    async resolveProviderAttemptFn(identity) {
      if (!stored) return null;
      assert.equal(identity.attemptId, stored.identity.attemptId);
      return { state: "replay", ...structuredClone(stored) };
    },
    async claimProviderAttemptFn(identity) {
      stored = { identity: structuredClone(identity) };
      return { state: "claimed" };
    },
    async persistProviderOutputFn(input) {
      events.push("persist:image");
      stored.output = structuredClone(input.output);
      stored.delivery = {
        persisted: true,
        artifactIds: ["material:9901"],
        targetType: "material",
        targetId: 9901,
      };
      stored.hold = structuredClone(input.hold);
      return structuredClone(stored.delivery);
    },
    async finalizeProviderAttemptFn(input) {
      stored.billing = structuredClone(input.billing);
      stored.delivery = structuredClone(input.delivery || stored.delivery);
      stored.hold = structuredClone(input.hold);
    },
  };
  const injected = {
    ...dependencies,
    ...hooks,
    async generateImageFn() {
      events.push("generate:once");
      return {
        model: "gpt-image-2",
        url: "https://images.example/pending.png",
      };
    },
  };
  const input = baseInput({
    attemptNamespace: "content-production-pipeline",
    request: {
      prompt: "待对账恢复测试",
      image_mode: "ai",
      image_count: 1,
      platforms: [],
      size: "1024x1024",
    },
  });
  const first = await createContentSpecialProviderBridge(
    input,
    injected,
  ).providers.image({ count: 1, purpose: "content_images" });
  const second = await createContentSpecialProviderBridge(
    input,
    injected,
  ).providers.image({ count: 1, purpose: "content_images" });
  assert.equal(first.bridge.billing.state, "pending_reconciliation");
  assert.equal(second.bridge.billing.state, "pending_reconciliation");
  assert.equal(second.bridge.replayed, true);
  assert.equal(events.filter((item) => item === "generate:once").length, 1);
  assert.equal(events.filter((item) => item.startsWith("hold:")).length, 1);
});
