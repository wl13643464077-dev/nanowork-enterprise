import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONTENT_SPECIAL_HANDLER_ARTIFACT_SCHEMA,
  CONTENT_SPECIAL_HANDLER_KINDS,
  CONTENT_SPECIAL_HANDLER_RUNTIME_SCHEMA,
  executeContentSpecialHandlerRuntime,
} from "../src/engines/content-special-handler-runtime.js";

function clock() {
  let tick = 0;
  return () =>
    new Date(`2026-08-01T00:00:${String(tick++).padStart(2, "0")}.000Z`);
}

function baseInput(executionKind, providers, variables = {}) {
  return {
    executionKind,
    runId: 49,
    invocationId: "invocation-50",
    prompt: {
      system: "完整岗位说明",
      user: "生成本次可交付业务产物",
    },
    variables,
    providers,
    now: clock(),
  };
}

test("四类特殊handler runtime分支是固定公开契约", () => {
  assert.deepEqual(CONTENT_SPECIAL_HANDLER_KINDS, [
    "text_json",
    "media_generation_with_svg_fallback",
    "cover_generation_with_html_fallback",
    "html_generation",
  ]);
});

test("text_json只调用注入的文本provider并记录run、invocation、MIME、token与成本", async () => {
  const calls = [];
  const result = await executeContentSpecialHandlerRuntime(
    baseInput("text_json", {
      async text(input) {
        calls.push(input);
        return {
          data: { topics: [{ title: "真实选题" }] },
          provider: {
            name: "yunwu-compatible",
            model: "real-text-model",
            mode: "api",
          },
          usage: { inputTokens: 120, outputTokens: 45 },
          cost: { amount: 0.0125, currency: "usd", credits: 13 },
        };
      },
      image() {
        throw new Error("不应调用");
      },
    }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].runId, "49");
  assert.equal(calls[0].invocationId, "invocation-50");
  assert.equal(calls[0].purpose, "structured_json");
  assert.equal(result.ok, true);
  assert.equal(result.schemaVersion, CONTENT_SPECIAL_HANDLER_RUNTIME_SCHEMA);
  assert.equal(result.artifacts.length, 1);
  assert.equal(
    result.artifacts[0].schemaVersion,
    CONTENT_SPECIAL_HANDLER_ARTIFACT_SCHEMA,
  );
  assert.equal(result.artifacts[0].runId, "49");
  assert.equal(result.artifacts[0].invocationId, "invocation-50");
  assert.equal(result.artifacts[0].mimeType, "application/json");
  assert.match(
    result.artifacts[0].fileName,
    /content-49-invocation-50-1\.json$/u,
  );
  assert.deepEqual(result.artifacts[0].data, {
    topics: [{ title: "真实选题" }],
  });
  assert.equal(result.evidence.providerAttempts.length, 1);
  assert.deepEqual(result.evidence.usage, {
    inputTokens: 120,
    outputTokens: 45,
    totalTokens: 165,
  });
  assert.deepEqual(result.evidence.cost, {
    byCurrency: { USD: 0.0125 },
    credits: 13,
  });
  assert.equal(result.evidence.credentialsIncluded, false);
});

test("media mix先调用素材provider，再调用图片provider，并把两类来源保留为可追溯产物", async () => {
  const calls = [];
  const result = await executeContentSpecialHandlerRuntime(
    baseInput(
      "media_generation_with_svg_fallback",
      {
        async material(input) {
          calls.push({ kind: "material", input });
          return {
            assets: [
              {
                url: "https://assets.example/restaurant.webp",
                mimeType: "image/webp",
                slot: "首图",
              },
            ],
            provider: { name: "licensed-material-library", mode: "api" },
            cost: { credits: 2 },
          };
        },
        async image(input) {
          calls.push({ kind: "image", input });
          return {
            images: [
              {
                url: "https://images.example/1.png",
                mime: "image/png",
                desc: "工作流信息图",
              },
              { b64: "QUJD", mime: "image/png", desc: "老板复盘场景" },
            ],
            model: "image-model",
            mode: "api",
            usage: { inputTokens: 40, outputTokens: 8 },
            costUsd: 0.08,
          };
        },
        text() {
          throw new Error("有真实产物时不应进入SVG回退");
        },
      },
      { media_request: { mode: "mix", imageCount: 4 } },
    ),
  );

  assert.deepEqual(
    calls.map((call) => call.kind),
    ["material", "image"],
  );
  assert.equal(calls[0].input.count, 2);
  assert.equal(calls[1].input.count, 3);
  assert.equal(calls[1].input.materials.length, 1);
  assert.deepEqual(
    result.artifacts.map((artifact) => artifact.kind),
    ["material", "image", "image"],
  );
  assert.deepEqual(
    result.artifacts.map((artifact) => artifact.mimeType),
    ["image/webp", "image/png", "image/png"],
  );
  assert.ok(result.artifacts.every((artifact) => artifact.runId === "49"));
  assert.ok(
    result.artifacts.every(
      (artifact) => artifact.invocationId === "invocation-50",
    ),
  );
  assert.equal(result.evidence.fallback.used, false);
  assert.deepEqual(result.evidence.providerKindsCalled, ["material", "image"]);
  assert.deepEqual(result.evidence.cost, {
    byCurrency: { USD: 0.08 },
    credits: 2,
  });
});

test("station5自动数量严格取上游2-4个image_plan槽位并保留平台", async () => {
  let imageInput;
  const plan = [
    { slot: "首图", desc: "门店客流与新客机会信息图" },
    { slot: "中段", desc: "家庭消费场景与业态关系图" },
    { slot: "结尾", desc: "餐饮老板七日行动清单" },
  ];
  const result = await executeContentSpecialHandlerRuntime(
    baseInput(
      "media_generation_with_svg_fallback",
      {
        async image(input) {
          imageInput = input;
          return {
            images: input.imagePlan.map((item) => ({
              url: `https://images.example/${item.slot}.png`,
              slot: item.slot,
              desc: item.desc,
            })),
          };
        },
      },
      {
        media_request: {
          mode: "ai",
          imageCount: null,
          imageCountMode: "auto",
          platforms: ["小红书"],
          plan,
        },
      },
    ),
  );

  assert.equal(imageInput.count, 3);
  assert.deepEqual(imageInput.imagePlan, plan);
  assert.deepEqual(imageInput.platforms, ["小红书"]);
  assert.deepEqual(
    result.artifacts.map((item) => item.slot),
    ["首图", "中段", "结尾"],
  );
});

test("station5自动数量缺少2-4个上游槽位时在provider前fail closed", async () => {
  let imageCalls = 0;
  await assert.rejects(
    executeContentSpecialHandlerRuntime(
      baseInput(
        "media_generation_with_svg_fallback",
        {
          async image() {
            imageCalls += 1;
            return {
              images: [{ url: "https://images.example/must-not-run.png" }],
            };
          },
        },
        {
          media_request: {
            mode: "ai",
            imageCount: 0,
            platforms: ["小红书"],
            plan: [{ slot: "只有一张", desc: "不满足上游契约" }],
          },
        },
      ),
    ),
    (error) => {
      assert.equal(error.code, "CONTENT_SPECIAL_HANDLER_RUNTIME_FAILED");
      assert.equal(error.status, 422);
      assert.match(error.message, /image_plan.*2-4/u);
      return true;
    },
  );
  assert.equal(imageCalls, 0);
});

test("station5显式数量保持显式值，不被image_plan长度改写", async () => {
  let imageInput;
  const plan = [
    { slot: "首图", desc: "主题信息图" },
    { slot: "中段", desc: "过程信息图" },
  ];
  await executeContentSpecialHandlerRuntime(
    baseInput(
      "media_generation_with_svg_fallback",
      {
        async image(input) {
          imageInput = input;
          return { images: [{ url: "https://images.example/explicit.png" }] };
        },
      },
      {
        media_request: {
          mode: "ai",
          imageCount: 1,
          platforms: ["公众号"],
          plan,
        },
      },
    ),
  );
  assert.equal(imageInput.count, 1);
  assert.deepEqual(imageInput.imagePlan, [plan[0]]);
});

test("真实素材与混合模式缺授权素材时fail closed，不改用AI冒充", async () => {
  for (const mode of ["real", "mix"]) {
    let imageCalls = 0;
    let textCalls = 0;
    await assert.rejects(
      executeContentSpecialHandlerRuntime(
        baseInput(
          "media_generation_with_svg_fallback",
          {
            async material() {
              return {
                assets: [],
                provider: { name: "licensed-material-library", mode: "api" },
              };
            },
            async image() {
              imageCalls += 1;
              return {
                images: [
                  { url: "https://images.example/must-not-be-used.png" },
                ],
              };
            },
            async text() {
              textCalls += 1;
              return { data: { images: [{ svg: "<svg></svg>" }] } };
            },
          },
          { media_request: { mode, imageCount: 2 } },
        ),
      ),
      (error) => {
        assert.equal(error.code, "CONTENT_SPECIAL_HANDLER_RUNTIME_FAILED");
        assert.equal(error.status, 422);
        assert.match(error.message, /已授权素材/u);
        return true;
      },
    );
    assert.equal(
      imageCalls,
      0,
      `${mode}不得在授权素材缺失时调用AI图片provider`,
    );
    assert.equal(textCalls, 0, `${mode}不得把SVG回退冒充真实素材`);
  }
});

test("混合模式AI图片供应失败时保留真实素材证据但不冒充完成", async () => {
  let fallbackCalls = 0;
  await assert.rejects(
    executeContentSpecialHandlerRuntime(
      baseInput(
        "media_generation_with_svg_fallback",
        {
          async material() {
            return {
              assets: [
                {
                  url: "https://assets.example/licensed.webp",
                  mimeType: "image/webp",
                },
              ],
              provider: { name: "licensed-material-library", mode: "api" },
            };
          },
          async image() {
            throw new Error("image upstream unavailable");
          },
          async text() {
            fallbackCalls += 1;
            return { data: { images: [{ svg: "<svg></svg>" }] } };
          },
        },
        { media_request: { mode: "mix", imageCount: 2 } },
      ),
    ),
    (error) => {
      assert.equal(error.code, "CONTENT_SPECIAL_HANDLER_RUNTIME_FAILED");
      assert.equal(error.status, 422);
      assert.match(error.message, /混合模式.*AI图片/u);
      assert.equal(error.evidence.artifactCount, 1);
      assert.equal(error.evidence.artifacts[0].kind, "material");
      return true;
    },
  );
  assert.equal(fallbackCalls, 0);
});

test("media AI配图时图像provider失败则fail closed，不走SVG回退，失败证据不泄露密钥", async () => {
  const secret = "sk-SHOULD_NOT_LEAK_123456789";
  let textCalls = 0;
  await assert.rejects(
    () =>
      executeContentSpecialHandlerRuntime(
        baseInput(
          "media_generation_with_svg_fallback",
          {
            async image() {
              throw new Error(
                `upstream ${secret} Authorization: Bearer ${secret}`,
              );
            },
            async text() {
              textCalls += 1;
              return {
                data: {
                  images: [
                    {
                      slot: "正文配图",
                      desc: "任务闭环图",
                      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>任务闭环</text></svg>',
                    },
                  ],
                },
                model: "text-fallback-model",
                usage: { inputTokens: 22, outputTokens: 18 },
              };
            },
          },
          {
            media_request: { mode: "ai", imageCount: 1 },
            authorization: `Bearer ${secret}`,
          },
        ),
      ),
    (error) => {
      assert.equal(error.code, "CONTENT_SPECIAL_HANDLER_RUNTIME_FAILED");
      assert.equal(error.status, 502);
      assert.match(error.message, /不会用SVG示意图冒充配图/u);
      const visible = JSON.stringify(error);
      assert.doesNotMatch(visible, /SHOULD_NOT_LEAK/u);
      assert.match(visible, /image内容供应商暂时不可用/u);
      return true;
    },
  );
  assert.equal(textCalls, 0);
});

test("cover默认逐平台调用真实图片provider，交付可预览位图且不调用HTML", async () => {
  let imageCalls = 0;
  let textCalls = 0;
  const calls = [];
  const result = await executeContentSpecialHandlerRuntime(
    baseInput(
      "cover_generation_with_html_fallback",
      {
        async image(input) {
          imageCalls += 1;
          calls.push(input);
          return {
            images: input.coverPlan.map((item, index) => ({
              url: `https://images.example/cover-${index + 1}.png`,
              mimeType: "image/png",
              model: "gpt-image-2",
              ...item,
            })),
            provider: {
              name: "yunwu-compatible",
              model: "gpt-image-2",
              mode: "api",
            },
            model: "gpt-image-2",
            mode: "api",
            usage: { imageCount: 2, tokenUsageApplicable: false },
            cost: { credits: 150 },
          };
        },
        async text() {
          textCalls += 1;
          throw new Error("默认真实封面不得调用HTML provider");
        },
      },
      {
        cover_request: {
          mode: "image",
          platforms: ["小红书", "公众号"],
          plan: [
            {
              slot: "小红书封面",
              desc: "竖版中文大字封面",
              platform: "小红书",
              size: "1024x1536",
              displaySize: "1080×1440(3:4 竖版)",
            },
            {
              slot: "公众号封面",
              desc: "横版中文大字头图",
              platform: "公众号",
              size: "1536x1024",
              displaySize: "900×383(2.35:1 头图)",
            },
          ],
        },
      },
    ),
  );

  assert.equal(result.artifacts.length, 2);
  assert.ok(result.artifacts.every((artifact) => artifact.kind === "image"));
  assert.ok(
    result.artifacts.every((artifact) => artifact.mimeType === "image/png"),
  );
  assert.ok(
    result.artifacts.every(
      (artifact) =>
        artifact.fallback.used === false &&
        artifact.paihuoRealImage === true &&
        /^https:\/\//u.test(artifact.url),
    ),
  );
  assert.deepEqual(
    result.artifacts.map((artifact) => artifact.platform),
    ["小红书", "公众号"],
  );
  assert.deepEqual(
    result.artifacts.map((artifact) => artifact.size),
    ["1024x1536", "1536x1024"],
  );
  assert.equal(imageCalls, 1);
  assert.equal(textCalls, 0);
  assert.equal(calls[0].purpose, "platform_covers");
  assert.equal(calls[0].count, 2);
  assert.equal(result.evidence.fallback.from, null);
  assert.equal(result.evidence.fallback.to, null);
  assert.equal(result.evidence.deliveryClaim, "paihuo_real_image");
  assert.equal(result.evidence.paihuoRealImage, true);
  assert.deepEqual(result.evidence.providerKindsCalled, ["image"]);
  assert.equal(result.evidence.cost.credits, 150);
});

test("cover只有显式mode=html时保留兼容交付，证据明确不是Paihuo真实生图", async () => {
  let imageCalls = 0;
  const result = await executeContentSpecialHandlerRuntime(
    baseInput(
      "cover_generation_with_html_fallback",
      {
        async image() {
          imageCalls += 1;
          throw new Error("显式HTML兼容模式不应调用图片provider");
        },
        async text() {
          return {
            data: {
              covers: [
                {
                  platform: "小红书",
                  html: "<!doctype html><html><body>小红书兼容封面</body></html>",
                },
              ],
            },
            provider: { name: "text-provider", model: "html-model" },
            usage: { inputTokens: 30, outputTokens: 50 },
          };
        },
      },
      { cover_request: { mode: "html", platforms: ["小红书"] } },
    ),
  );

  assert.equal(imageCalls, 0);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].kind, "html");
  assert.equal(result.artifacts[0].paihuoRealImage, false);
  assert.equal(result.evidence.deliveryClaim, "legacy_html_compatibility");
  assert.equal(result.evidence.paihuoRealImage, false);
  assert.deepEqual(result.evidence.providerKindsCalled, ["text"]);
});

test("html_generation把注入文本provider的独立HTML保存为带关联ID的文件产物", async () => {
  const result = await executeContentSpecialHandlerRuntime(
    baseInput("html_generation", {
      async text() {
        return {
          html: "<!doctype html><html><body><main>内容发布卡片</main></body></html>",
          providerName: "deck-provider",
          model: "real-html-model",
          usage: { prompt_tokens: 70, completion_tokens: 110 },
          credits: 9,
        };
      },
    }),
  );

  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].kind, "html");
  assert.equal(result.artifacts[0].mimeType, "text/html");
  assert.match(result.artifacts[0].content, /<main>内容发布卡片<\/main>/u);
  assert.match(
    result.artifacts[0].fileName,
    /content-49-invocation-50-1\.html$/u,
  );
  assert.equal(result.evidence.usage.totalTokens, 180);
  assert.equal(result.evidence.cost.credits, 9);
});

test("cover图片provider失败时按派活回退HTML封面卡，不把回退标成真图", async () => {
  const secret = "sk-TOTAL_FAILURE_SECRET_123456";
  let imageCalls = 0;
  let textCalls = 0;
  const result = await executeContentSpecialHandlerRuntime(
    baseInput(
      "cover_generation_with_html_fallback",
      {
        async image() {
          imageCalls += 1;
          const error = new Error(`invalid api_key=${secret}`);
          error.billing = {
            state: "released",
            holdId: 701,
            estimatedCredits: 75,
            heldCredits: 0,
            chargedCredits: 0,
            pendingReconciliation: false,
          };
          throw error;
        },
        async text() {
          textCalls += 1;
          return {
            data: {
              covers: [
                {
                  platform: "小红书",
                  html: "<!doctype html><html><body>小红书回退封面</body></html>",
                },
              ],
            },
            provider: { name: "text-provider", model: "html-model" },
            usage: { inputTokens: 30, outputTokens: 50 },
          };
        },
      },
      {
        cover_request: {
          mode: "image",
          platforms: ["小红书"],
          plan: [
            {
              slot: "小红书封面",
              desc: "真实中文封面",
              platform: "小红书",
              size: "1024x1536",
            },
          ],
        },
      },
    ),
  );
  assert.equal(imageCalls, 1);
  assert.equal(textCalls, 1);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].kind, "html");
  assert.equal(result.artifacts[0].paihuoRealImage, false);
  assert.equal(result.evidence.fallback.used, true);
  assert.equal(result.evidence.fallback.to, "text_provider_html");
  assert.equal(result.evidence.deliveryClaim, "legacy_html_compatibility");
  assert.equal(result.evidence.paihuoRealImage, false);
  assert.equal(result.evidence.providerAttempts[0].billing.state, "released");
  const visible = JSON.stringify(result);
  assert.doesNotMatch(visible, /TOTAL_FAILURE_SECRET/u);
  assert.doesNotMatch(visible, /invalid api_key/u);
});

test("runtime不含网络与文件系统默认实现，缺少注入provider时明确失败", async () => {
  await assert.rejects(
    executeContentSpecialHandlerRuntime(baseInput("html_generation", {})),
    (error) => {
      assert.equal(error.name, "ContentSpecialHandlerRuntimeError");
      assert.deepEqual(error.evidence.providerKindsCalled, []);
      assert.equal(error.evidence.artifactCount, 0);
      return true;
    },
  );
});
