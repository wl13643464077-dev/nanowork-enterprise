import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONTENT_HANDLER_ADAPTER_CATALOG,
  CONTENT_HANDLER_ADAPTER_SCHEMA,
  CONTENT_HANDLER_EVIDENCE_SCHEMA,
  PAIHUO_CONTENT_HANDLER_SOURCE_SHA256,
  createContentHandlerAdapterRegistry,
  invokeContentHandlerGenerate,
  sanitizeContentRuntimeErrorMessage,
} from "../src/engines/content-handler-adapters.js";

const EXPECTED_HANDLERS = Object.freeze([
  "run_trend",
  "run_research",
  "run_benchmark",
  "run_draft",
  "run_style",
  "run_media",
  "run_cover",
  "run_deck",
  "run_publish",
  "run_retro",
]);
const EXPECTED_SYMBOL_HASHES = Object.freeze([
  "82aa02ee0d17517ea39c4cd7f298af7ffb1a797cebdbcdc128949ab532fceb8d",
  "fc4386d800c5bb3f73af34b6ad0e399d85e47eaabf75e1c66faa701dc3726c22",
  "3b16edaa691855682cb6e7a0250d21e987ff9e98fc66ef0ef4f98ef18df7e4f6",
  "08abc2759a2de3497843b0f1d457e0b424f17291d748727e3f83f199e1db5046",
  "6ceb32a4729cd966929c9eaa0de8a89f56a1d802d3e2ce09029d1e3b5a78a02e",
  "d4b814c73e493d5a4607214ba9c81110ef596b3d9267388f341c324d1a718d10",
  "1a12df04375e97bb2173065ba8f0c3a319a88da4e4c6d10eb70a4d0ab69ccede",
  "aabdfcc15c3e87ba5290d57ead61c543bb0b5b06e48aa60c498eb44331e0461b",
  "bee3f2357ab1c7784416d0c7ee7512b3d52f27c9169db43bb535c7f34670fce6",
  "51b62ae6f57c0b19a599566fcb44e5263b1bb389788b93b81c4247d598740f4b",
]);

function pipelineContext() {
  return {
    today: "2026-08-01",
    brief: {
      direction: "餐饮老板如何用数字员工提升内容生产效率",
      industry: "餐饮连锁",
      platforms: ["小红书", "公众号"],
      image_mode: "mix",
      image_count: 5,
    },
    profile: {
      persona: {
        corpus: "我一直强调，先把事实讲清楚，再谈方法。",
        visual: "暖白底、黑色大字、克制的绿色强调色",
      },
    },
    outputs: {
      0: {
        selected: 1,
        topics: [
          { title: "未选择题", angle: "A", hook: "A" },
          {
            title: "数字员工不是聊天框",
            angle: "真实业务闭环",
            hook: "为什么多数数字员工只会聊天？",
          },
        ],
      },
      1: {
        summary: "三份官方材料与两份企业案例已经交叉核对",
        facts: ["事实A"],
      },
      2: { benchmarks: [{ title: "样本A" }], takeaways: ["结论A"] },
      3: {
        title_candidates: ["初稿标题"],
        selected_title: 0,
        body: "初稿正文",
        tags: ["数字员工", "餐饮经营"],
        image_plan: [
          { slot: "开头", desc: "数字员工工作流信息图" },
          { slot: "中段", desc: "门店经营闭环步骤图" },
          { slot: "结尾", desc: "老板复盘行动清单图" },
        ],
      },
      4: {
        title_candidates: ["风格化定稿标题"],
        selected_title: 0,
        body: "风格化定稿正文",
      },
    },
    settings: {
      trend: { channels: ["抖音热点", "小红书热门"] },
      research: { channels: ["官方数据/统计局", "行业报告/白皮书"] },
      benchmark: {
        targets: ["对标账号A", "对标账号B"],
        dimensions: ["开头", "结构", "评论"],
      },
    },
  };
}

test("派活内容10岗逐岗绑定旧symbol、精确源SHA与可执行适配器身份", () => {
  assert.equal(
    PAIHUO_CONTENT_HANDLER_SOURCE_SHA256,
    "9663481bfb2a709209281c1eb356783f9d5b4047dc54124cfa27f3e4986237dc",
  );
  assert.equal(CONTENT_HANDLER_ADAPTER_CATALOG.length, 10);
  assert.deepEqual(
    CONTENT_HANDLER_ADAPTER_CATALOG.map((item) => item.legacyHandler),
    EXPECTED_HANDLERS,
  );
  assert.deepEqual(
    CONTENT_HANDLER_ADAPTER_CATALOG.map(
      (item) => item.sourceReference.symbolSha256,
    ),
    EXPECTED_SYMBOL_HASHES,
  );
  for (const [idx, descriptor] of CONTENT_HANDLER_ADAPTER_CATALOG.entries()) {
    assert.equal(descriptor.schemaVersion, CONTENT_HANDLER_ADAPTER_SCHEMA);
    assert.equal(descriptor.employeeIdx, idx);
    assert.equal(descriptor.sourceReference.project, "派活AI");
    assert.equal(descriptor.sourceReference.path, "app/skills/registry.py");
    assert.equal(
      descriptor.sourceReference.fileSha256,
      PAIHUO_CONTENT_HANDLER_SOURCE_SHA256,
    );
    assert.equal(descriptor.sourceReference.symbol, descriptor.legacyHandler);
    assert.match(descriptor.sourceReference.symbolSha256, /^[a-f0-9]{64}$/u);
    assert.ok(
      descriptor.sourceReference.lineEnd >=
        descriptor.sourceReference.lineStart,
    );
    assert.ok(descriptor.sourceReference.dependencies.length > 0);
    assert.equal(descriptor.currentAdapter, "content-handler-adapters.invoke");
    assert.equal(descriptor.provenance, "reimplemented_verified");
    assert.equal(descriptor.bindingStatus, "bound_callable");
    assert.notEqual(descriptor.bindingStatus, "declared_unbound");
    assert.equal(
      descriptor.promptContract.messageMode,
      "system_user_separated",
    );
    assert.equal(descriptor.execution.credentialPolicy, "server_runtime_only");
  }
});

test("10个handler逐一真实进入compile与invoke回调，并把handler ID写入证据", async () => {
  const compileCalls = [];
  const invokeCalls = [];
  let tick = 0;
  const registry = createContentHandlerAdapterRegistry({
    async compile(input) {
      compileCalls.push(input);
      return {
        system: `system:${input.employeeKey}:完整岗位能力与技能`,
        user: `user:${JSON.stringify(input.variables)}`,
        research: input.execution?.webRequired ? "research" : "",
        sensitive: ["完整岗位能力与技能"],
      };
    },
    async invoke(input) {
      invokeCalls.push(input);
      return {
        data: { employeeIdx: input.employeeIdx, handlerId: input.handlerId },
        tokens: input.employeeIdx + 10,
      };
    },
    now() {
      const value = new Date(
        `2026-08-01T00:00:${String(tick).padStart(2, "0")}.000Z`,
      );
      tick += 1;
      return value;
    },
  });

  assert.equal(registry.schemaVersion, CONTENT_HANDLER_ADAPTER_SCHEMA);
  assert.equal(registry.size, 10);
  assert.deepEqual(Object.keys(registry.handlers), EXPECTED_HANDLERS);
  for (const descriptor of CONTENT_HANDLER_ADAPTER_CATALOG) {
    assert.equal(
      typeof registry.handlers[descriptor.legacyHandler],
      "function",
    );
    const output =
      await registry.handlers[descriptor.legacyHandler](pipelineContext());
    assert.equal(output.ok, true);
    assert.equal(
      output.handlerId,
      `content-handler-adapter:${descriptor.legacyHandler}`,
    );
    assert.equal(output.result.data.handlerId, output.handlerId);
    assert.equal(
      output.evidence.schemaVersion,
      CONTENT_HANDLER_EVIDENCE_SCHEMA,
    );
    assert.equal(output.evidence.handlerId, output.handlerId);
    assert.equal(output.evidence.legacyHandler, descriptor.legacyHandler);
    assert.equal(
      output.evidence.currentAdapter,
      "content-handler-adapters.invoke",
    );
    assert.equal(output.evidence.bindingStatus, "bound_callable");
    assert.equal(output.evidence.provenance, "reimplemented_verified");
    assert.equal(output.evidence.completed, true);
    assert.equal(output.evidence.prompt.messageMode, "system_user_separated");
    assert.equal(output.evidence.prompt.promptTextIncluded, false);
    assert.equal(output.evidence.input.rawInputIncluded, false);
    assert.equal(output.evidence.credentialsIncluded, false);
  }

  assert.equal(compileCalls.length, 10);
  assert.equal(invokeCalls.length, 10);
  for (let idx = 0; idx < 10; idx += 1) {
    assert.equal(compileCalls[idx].employeeIdx, idx);
    assert.equal(invokeCalls[idx].employeeIdx, idx);
    assert.match(invokeCalls[idx].prompt.system, /^system:/u);
    assert.match(invokeCalls[idx].prompt.user, /^user:/u);
    assert.notEqual(
      invokeCalls[idx].prompt.system,
      invokeCalls[idx].prompt.user,
    );
    assert.equal(invokeCalls[idx].execution.webRequired, idx <= 2);
    assert.equal(
      invokeCalls[idx].execution.webCadence,
      idx <= 2
        ? "once_per_task_then_reused_for_retries"
        : "not_required_by_legacy_handler",
    );
    assert.equal(
      invokeCalls[idx].execution.legacyWebCadence,
      idx <= 2 ? "every_handler_call" : "not_required_by_legacy_handler",
    );
  }
});

test("逐岗输入映射保留派活上游结构、媒体特殊类型与人工审批边界", async () => {
  const compiled = new Map();
  const registry = createContentHandlerAdapterRegistry({
    compile(input) {
      compiled.set(input.employeeKey, input.variables);
      return {
        system: `system:${input.employeeKey}`,
        user: `user:${input.employeeKey}`,
      };
    },
    invoke: async (input) => ({ data: { kind: input.execution.kind } }),
  });
  for (let idx = 0; idx < 10; idx += 1)
    await registry.invoke(idx, pipelineContext());

  assert.deepEqual(compiled.get("trend"), {
    today: "2026-08-01",
    channels: "抖音热点、小红书热门",
  });
  assert.match(compiled.get("research").topic, /数字员工不是聊天框/u);
  assert.equal(
    compiled.get("research").channels,
    "官方数据/统计局、行业报告/白皮书",
  );
  assert.equal(
    compiled.get("benchmark").summary,
    "三份官方材料与两份企业案例已经交叉核对",
  );
  assert.equal(compiled.get("benchmark").targets, "- 对标账号A\n- 对标账号B");
  assert.equal(compiled.get("benchmark").dimensions, "开头、结构、评论");
  assert.match(compiled.get("draft").research, /三份官方材料/u);
  assert.match(compiled.get("draft").benchmark, /样本A/u);
  assert.equal(compiled.get("style").title, "风格化定稿标题");
  assert.equal(compiled.get("style").draft_body, "初稿正文");
  assert.match(compiled.get("style").corpus, /先把事实讲清楚/u);
  assert.equal(compiled.get("media").media_request.mode, "mix");
  assert.equal(compiled.get("media").media_request.imageCount, 5);
  assert.match(compiled.get("media").plan, /数字员工工作流信息图/u);
  assert.match(compiled.get("media").platform_specs, /小红书/u);
  assert.match(compiled.get("cover").visual, /暖白底/u);
  assert.deepEqual(compiled.get("cover").cover_request.platforms, [
    "小红书",
    "公众号",
  ]);
  assert.equal(compiled.get("cover").cover_request.mode, "image");
  assert.equal(compiled.get("cover").cover_request.providerRequired, true);
  assert.equal(compiled.get("cover").cover_request.paihuoRealImageClaim, true);
  assert.deepEqual(
    compiled.get("cover").cover_request.plan.map((item) => ({
      platform: item.platform,
      size: item.size,
      displaySize: item.displaySize,
    })),
    [
      {
        platform: "小红书",
        size: "1024x1536",
        displaySize: "1080×1440(3:4 竖版)",
      },
      {
        platform: "公众号",
        size: "1536x1024",
        displaySize: "900×383(2.35:1 头图)",
      },
    ],
  );
  assert.ok(
    compiled
      .get("cover")
      .cover_request.plan.every((item) => /HTML、SVG/u.test(item.desc)),
  );
  assert.equal(compiled.get("deck").deck_request.artifact, "standalone_html");
  assert.equal(
    compiled.get("publish").publish_request.externalActionAllowed,
    false,
  );
  assert.deepEqual(compiled.get("publish").tags, ["数字员工", "餐饮经营"]);
  assert.equal(compiled.get("retro").body, "风格化定稿正文");

  const executionKinds = CONTENT_HANDLER_ADAPTER_CATALOG.map(
    (item) => item.execution.kind,
  );
  assert.deepEqual(executionKinds.slice(5, 8), [
    "media_generation_with_svg_fallback",
    "cover_generation_with_html_fallback",
    "html_generation",
  ]);
  assert.deepEqual(
    CONTENT_HANDLER_ADAPTER_CATALOG.map((item) => item.approvalBoundary.code),
    [
      "pick",
      "auto",
      "auto",
      "review",
      "auto",
      "pick",
      "pick",
      "auto",
      "force",
      "auto",
    ],
  );
  assert.equal(
    CONTENT_HANDLER_ADAPTER_CATALOG[8].approvalBoundary.forcedFinalReview,
    true,
  );
  assert.equal(
    CONTENT_HANDLER_ADAPTER_CATALOG[8].approvalBoundary.externalActionAllowed,
    false,
  );
});

test("拆解师未配置targets时传空值，不把说明占位符当成真实搜索渠道", async () => {
  const context = pipelineContext();
  delete context.settings.benchmark.targets;
  let variables = null;
  const registry = createContentHandlerAdapterRegistry({
    compile(input) {
      if (input.employeeKey === "benchmark") variables = input.variables;
      return { system: "system", user: "user" };
    },
    invoke: async () => ({ data: {} }),
  });

  await registry.invoke(2, context);

  assert.equal(variables.targets, "");
  assert.doesNotMatch(JSON.stringify(variables), /未指定|自行检索/u);
});

test("media适配保留Paihuo自动数量与显式数量，不再把null或0改成4", async () => {
  const compiled = [];
  const registry = createContentHandlerAdapterRegistry({
    compile(input) {
      compiled.push(input.variables.media_request);
      return { system: "system:media", user: "user:media" };
    },
    invoke: async () => ({ data: { ok: true } }),
  });

  for (const imageCount of [null, 0, 12]) {
    const context = pipelineContext();
    context.brief.image_count = imageCount;
    await registry.invoke("run_media", context);
  }

  assert.deepEqual(
    compiled.map((item) => item.imageCount),
    [null, 0, 12],
  );
  assert.deepEqual(
    compiled.map((item) => item.imageCountMode),
    ["auto", "auto", "explicit"],
  );
  assert.ok(compiled.every((item) => item.plan.length === 3));
  assert.ok(
    compiled.every(
      (item) =>
        item.platforms[0] === "小红书" && item.platforms[1] === "公众号",
    ),
  );
});

test("media单独派活在真实文本产出前不伪造配图计划，pipeline仍严格使用上游image_plan", async () => {
  const compiled = [];
  const registry = createContentHandlerAdapterRegistry({
    compile(input) {
      compiled.push(input.variables.media_request);
      return { system: "system:media", user: "user:media" };
    },
    invoke: async () => ({ data: { ok: true } }),
  });

  const solo = pipelineContext();
  solo.executionMode = "solo";
  solo.outputs = {};
  solo.brief.image_count = null;
  await registry.invoke("run_media", solo);

  const pipeline = pipelineContext();
  pipeline.executionMode = "pipeline";
  pipeline.brief.image_count = 0;
  await registry.invoke("run_media", pipeline);

  assert.deepEqual(compiled[0].plan, []);
  assert.equal(compiled[0].planSource, "await_validated_solo_images");
  assert.equal(compiled[0].imageCountMode, "auto");
  assert.equal(
    JSON.stringify(compiled[0]).includes("与主题相关的信息图"),
    false,
  );
  assert.deepEqual(compiled[1].plan, pipeline.outputs[3].image_plan);
  assert.equal(compiled[1].planSource, "upstream_image_plan");
  assert.equal(compiled[1].imageCountMode, "auto");
});

test("适配层剔除调用上下文凭证，证据与结果均不回显密钥", async () => {
  const secret = "sk-THIS_SHOULD_NEVER_LEAK_123456789";
  let compileInput;
  let invokeInput;
  const registry = createContentHandlerAdapterRegistry({
    compile(input) {
      compileInput = input;
      return {
        system: `私有岗位说明 ${JSON.stringify(input.context)}`,
        user: `业务输入 ${JSON.stringify(input.variables)}`,
      };
    },
    invoke: async (input) => {
      invokeInput = input;
      return {
        echoedContext: input.context,
        echoedPrompt: input.prompt,
        tokens: 3,
      };
    },
  });
  const context = pipelineContext();
  context.apiKey = secret;
  context.brief.authorization = `Bearer ${secret}`;
  context.brief.material = `错误粘贴的凭证：${secret}`;
  context.profile.password = "plain-password";
  context.profile.nested = { access_token: secret, safe: "可用业务材料" };

  const output = await registry.invoke("run_trend", context);
  const allVisible = JSON.stringify({ compileInput, invokeInput, output });
  assert.doesNotMatch(allVisible, /THIS_SHOULD_NEVER_LEAK/u);
  assert.doesNotMatch(allVisible, /plain-password/u);
  assert.doesNotMatch(allVisible, /access_token/u);
  assert.match(allVisible, /\[REDACTED\]/u);
  assert.match(allVisible, /可用业务材料/u);
  assert.equal(output.evidence.credentialsAccepted, false);
  assert.equal(output.evidence.credentialsIncluded, false);
  assert.equal(output.evidence.credentialPolicy, "server_runtime_only");
});

test("compile不能把system/user折叠成单消息或返回空层", async () => {
  const registry = createContentHandlerAdapterRegistry({
    compile: async () => ({ user: "只有user" }),
    invoke: async () => ({ data: {} }),
  });
  await assert.rejects(
    registry.invoke("run_trend", pipelineContext()),
    (error) => {
      assert.match(error.message, /必须保持非空system\/user分层/u);
      assert.equal(error.contentHandlerEvidence.completed, false);
      assert.equal(
        error.contentHandlerEvidence.failure.phase,
        "compile_prompt",
      );
      assert.equal(error.contentHandlerEvidence.prompt.systemSha256, null);
      assert.equal(
        error.contentHandlerEvidence.failure.rawMessageIncluded,
        false,
      );
      return true;
    },
  );
});

test("输入映射失败也留下脱敏证据，原始供应商密钥不会进入抛出错误", async () => {
  const registry = createContentHandlerAdapterRegistry({
    compile: async () => ({ system: "system", user: "user" }),
    invoke: async () => ({ data: {} }),
    resolveSettings: async () => {
      throw new Error(
        "settings api_key=sk-  MAPPING_SECRET_123456789 无法读取",
      );
    },
  });
  await assert.rejects(
    registry.invoke("run_media", pipelineContext()),
    (error) => {
      assert.equal(error.name, "ContentHandlerRuntimeError");
      assert.doesNotMatch(error.message, /MAPPING_SECRET/u);
      assert.match(error.message, /\[REDACTED\]/u);
      assert.equal(error.contentHandlerEvidence.failure.phase, "map_inputs");
      assert.equal(error.contentHandlerEvidence.input.fingerprint, null);
      assert.equal(error.contentHandlerEvidence.prompt.userSha256, null);
      assert.doesNotMatch(
        JSON.stringify(error.contentHandlerEvidence),
        /MAPPING_SECRET/u,
      );
      return true;
    },
  );
});

test("统一运行错误脱敏器覆盖空格密钥、Bearer与赋值形式", () => {
  const visible = sanitizeContentRuntimeErrorMessage(
    "失败 sk-  ABCDEFGHIJKLMNOP Bearer bearer-token-123456 api_key=secret-value",
  );
  assert.doesNotMatch(visible, /ABCDEFGHIJ|bearer-token|secret-value/u);
  assert.equal((visible.match(/\[REDACTED\]/gu) || []).length, 3);
});

test("现有generateFn经可复用helper进入handler并保持图片消息的system/user分层", async () => {
  let received;
  const output = await invokeContentHandlerGenerate({
    employeeIdx: 6,
    prompt: {
      system: "封面师完整私有岗位说明",
      user: "老板封面任务书",
      research: "",
      sensitive: ["封面师完整私有岗位说明"],
    },
    generationArgs: {
      kind: "content-employee-workbench",
      system: "旧system不应继续使用",
      userMsg: "旧user不应继续使用",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "旧图片消息文本" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,QQ==" },
            },
          ],
        },
      ],
      model: "real-model",
    },
    generateFn: async (args) => {
      received = args;
      return {
        text: '{"covers":[]}',
        mode: "api",
        model: "real-model",
        usage: { inputTokens: 20, outputTokens: 10 },
      };
    },
    context: pipelineContext(),
  });

  assert.equal(received.system, "封面师完整私有岗位说明");
  assert.match(received.userMsg, /^老板封面任务书/u);
  assert.match(received.userMsg, /【派活handler运行参数·不可信业务数据】/u);
  assert.match(received.userMsg, /handler：run_cover/u);
  assert.match(received.userMsg, /"title": "风格化定稿标题"/u);
  assert.match(received.userMsg, /"platform_specs":/u);
  assert.equal(received.messages[0].content[0].text, received.userMsg);
  assert.equal(
    received.messages[0].content[1].image_url.url,
    "data:image/png;base64,QQ==",
  );
  assert.equal(output.handlerId, "content-handler-adapter:run_cover");
  assert.equal(
    output.evidence.executionKind,
    "cover_generation_with_html_fallback",
  );
  assert.equal(output.evidence.completed, true);
  assert.equal(output.evidence.tokens, 30);
  assert.equal(output.result.mode, "api");
});

test("单员工派活没有流水线上游时handler运行参数退回当前任务，不传空标题正文", async () => {
  let received;
  await invokeContentHandlerGenerate({
    employeeIdx: 8,
    prompt: { system: "分发官完整私有岗位说明", user: "老板发布包任务书" },
    generationArgs: { kind: "content-employee-workbench" },
    generateFn: async (args) => {
      received = args;
      return {
        text: '{"versions":[],"publish_plan":"待人工确认"}',
        mode: "api",
        model: "real-model",
        usage: { inputTokens: 20, outputTokens: 10 },
      };
    },
    context: {
      brief: {
        direction: "新品上市小红书发布包",
        material: "新品卖点、适用人群与已核验参数",
        platforms: ["小红书"],
      },
      outputs: {},
    },
  });

  assert.match(received.userMsg, /"title": "新品上市小红书发布包"/u);
  assert.match(received.userMsg, /"body": "新品卖点、适用人群与已核验参数"/u);
  assert.match(received.userMsg, /小红书:文体/u);
});

test("generateFn异常也附带不含原始错误文本的handler失败证据", async () => {
  const secret = "sk-FAILED_CALL_SECRET_123456789";
  await assert.rejects(
    invokeContentHandlerGenerate({
      employeeIdx: 3,
      prompt: { system: "撰稿人system", user: "老板user" },
      generationArgs: { kind: "content-employee-workbench" },
      generateFn: async () => {
        throw new Error(`transport ${secret}`);
      },
      context: pipelineContext(),
    }),
    (error) => {
      assert.doesNotMatch(error.message, /FAILED_CALL_SECRET/u);
      assert.match(error.message, /\[REDACTED\]/u);
      assert.equal(
        error.contentHandlerEvidence.handlerId,
        "content-handler-adapter:run_draft",
      );
      assert.equal(error.contentHandlerEvidence.completed, false);
      assert.equal(
        error.contentHandlerEvidence.failure.phase,
        "invoke_runtime",
      );
      assert.equal(
        error.contentHandlerEvidence.failure.rawMessageIncluded,
        false,
      );
      assert.match(
        error.contentHandlerEvidence.failure.messageSha256,
        /^sha256:[a-f0-9]{64}$/u,
      );
      assert.doesNotMatch(
        JSON.stringify(error.contentHandlerEvidence),
        /FAILED_CALL_SECRET/u,
      );
      return true;
    },
  );
});
