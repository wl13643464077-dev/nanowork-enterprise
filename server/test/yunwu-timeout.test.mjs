import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NANOWORK_DB = ":memory:";
process.env.YUNWU_API_KEY = "test-only-yunwu-key";
process.env.YUNWU_BASE_URL = "https://yunwu.invalid/v1";
process.env.AI_INTERACTIVE_CHAT_TIMEOUT_MS = "85000";

const { initSchema, migrateV2 } = await import("../src/db.js");
initSchema();
migrateV2();
const yunwu = await import("../src/engines/yunwu.js");
const { generate } = await import("../src/engines/ai.js");

const completion = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: "测试返回" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

const streamCompletion = () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"测',
    '试"}}]}\n\ndata: {"choices":[{"delta":{"content":"返',
    '回"},"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
  ];
  return new Response(
    new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
};

test("yunwu chat 保持85秒交互默认，显式长任务超时可到900秒且不得超限", async () => {
  const nativeFetch = globalThis.fetch;
  const nativeSetTimeout = globalThis.setTimeout;
  const scheduledTimeouts = [];
  let responseFactory = completion;

  globalThis.fetch = async () => responseFactory();
  globalThis.setTimeout = (callback, timeout, ...args) => {
    scheduledTimeouts.push(timeout);
    return nativeSetTimeout(callback, timeout, ...args);
  };

  try {
    await yunwu.chat({
      role: "boss",
      messages: [{ role: "user", content: "默认超时" }],
    });
    assert.equal(scheduledTimeouts.pop(), 85000);

    await yunwu.chat({
      role: "boss",
      messages: [{ role: "user", content: "后台任务" }],
      timeoutMs: 300000,
    });
    assert.equal(scheduledTimeouts.pop(), 300000);

    await yunwu.chat({
      role: "boss",
      messages: [{ role: "user", content: "完整岗位长任务" }],
      timeoutMs: 900000,
    });
    assert.equal(scheduledTimeouts.pop(), 900000);

    await yunwu.chat({
      role: "boss",
      messages: [{ role: "user", content: "错误超限配置" }],
      timeoutMs: 1200000,
    });
    assert.equal(scheduledTimeouts.pop(), 900000);

    responseFactory = streamCompletion;
    const streamed = await yunwu.chatStream({
      role: "boss",
      messages: [{ role: "user", content: "流式后台任务" }],
      timeoutMs: 900000,
    });
    assert.equal(scheduledTimeouts.pop(), 900000);
    assert.equal(streamed.text, "测试返回");
    assert.equal(streamed.inputTokens, 3);
    assert.equal(streamed.outputTokens, 2);
    assert.equal(streamed.finishReason, "length");
  } finally {
    globalThis.fetch = nativeFetch;
    globalThis.setTimeout = nativeSetTimeout;
  }
});

test("yunwu 流式长任务继续遵循外部取消信号，不把客户端取消误报为超时", async () => {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        },
        { once: true },
      );
    });

  const controller = new AbortController();
  const request = yunwu.chatStream({
    role: "boss",
    messages: [{ role: "user", content: "取消专项" }],
    timeoutMs: 900000,
    signal: controller.signal,
  });
  controller.abort();
  try {
    await assert.rejects(request, (error) => error?.status === 499);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("yunwu 非流式有计费用量但正文为空时必须按供应商空输出失败并保留用量", async () => {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              reasoning_content: "不得进入业务结果或错误快照的供应商内部推理",
            },
            finish_reason: "length",
          },
        ],
        usage: { prompt_tokens: 75897, completion_tokens: 531 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  try {
    await assert.rejects(
      yunwu.chat({
        role: "boss",
        messages: [{ role: "user", content: "空正文专项" }],
        timeoutMs: 300000,
      }),
      (error) => {
        assert.equal(error?.code, "provider_empty_output");
        assert.equal(error?.status, 502);
        assert.deepEqual(error?.providerUsage, {
          inputTokens: 75897,
          outputTokens: 531,
        });
        assert.doesNotMatch(JSON.stringify(error), /供应商内部推理/u);
        return true;
      },
    );

    const result = await generate({
      kind: "empty-output-regression",
      system: "只输出业务正文",
      userMsg: "生成业务正文",
      fallback: () => "",
      role: "boss",
      providerPolicy: "yunwu_only",
      preferStream: false,
      timeoutMs: 300000,
    });
    assert.equal(result.mode, "template");
    assert.equal(result.text, "");
    assert.equal(result.providerFailure?.code, "provider_empty_output");
    assert.equal(result.providerFailure?.retryable, true);
    assert.deepEqual(result.usage, {
      inputTokens: 75897,
      outputTokens: 531,
    });
    assert.doesNotMatch(JSON.stringify(result), /供应商内部推理/u);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

function sseStream(chunks) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

test("yunwu 流式 usage 为 0 或缺 OpenAI 字段时，有正文仍按字数估算正向 token", async () => {
  const nativeFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.messages?.[0]?.content);
    if (body.messages?.[0]?.content === "零用量") {
      return sseStream([
        'data: {"choices":[{"delta":{"content":"配图方案"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":0}}\n\n',
      ]);
    }
    return sseStream([
      'data: {"choices":[{"delta":{"content":"封面方案"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"input_tokens":80,"output_tokens":40}}\n\n',
    ]);
  };
  try {
    const zeroUsage = await yunwu.chatStream({
      role: "boss",
      messages: [{ role: "user", content: "零用量" }],
    });
    assert.equal(zeroUsage.text, "配图方案");
    assert.equal(zeroUsage.inputTokens, 120);
    assert.equal(zeroUsage.outputTokens, Math.ceil("配图方案".length / 2));

    const aliased = await yunwu.chatStream({
      role: "boss",
      messages: [{ role: "user", content: "别名字段" }],
    });
    assert.equal(aliased.text, "封面方案");
    assert.equal(aliased.inputTokens, 80);
    assert.equal(aliased.outputTokens, 40);
    assert.deepEqual(calls, ["零用量", "别名字段"]);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
