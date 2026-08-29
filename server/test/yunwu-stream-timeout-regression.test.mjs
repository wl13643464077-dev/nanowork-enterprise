/**
 * 隔离回归探针：不读取真实凭据、不访问公网。
 *
 * T1315 的 provider ledger 是两轮 gpt-5.5 SSE 调用、0 token、两轮
 * provider_timeout。第一条 RED 用例覆盖同一条传输链的另一个高风险边界：
 * 流已经持续收到分片时，yunwu.chatStream 仍由一次性的总超时计时器终止，
 * 没有“有数据即续租”的 idle/total 双时钟。第二条 GREEN 用例固定 T1315
 * 的首 token 前超时语义，防止以后把这种传输失败误报成 API 候选或计费结果。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NANOWORK_DB = ":memory:";
process.env.YUNWU_API_KEY = "isolated-stream-timeout-test-key";
process.env.YUNWU_BASE_URL = "https://yunwu.invalid/v1";

const { initSchema, migrateV2 } = await import("../src/db.js");
initSchema();
migrateV2();
const yunwu = await import("../src/engines/yunwu.js");

const encoder = new TextEncoder();

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function streamResponse({ firstDelayMs = 0, intervalMs = 0, chunks = [], signal } = {}) {
  let interval = null;
  let firstTimer = null;
  let aborted = false;
  let index = 0;
  const body = new ReadableStream({
    start(controller) {
      const abort = () => {
        aborted = true;
        if (firstTimer) clearTimeout(firstTimer);
        if (interval) clearInterval(interval);
        firstTimer = null;
        interval = null;
        controller.error(Object.assign(new Error("mock provider aborted"), { name: "AbortError" }));
      };
      signal?.addEventListener("abort", abort, { once: true });
      const emit = () => {
        if (aborted) return;
        if (index >= chunks.length) {
          if (interval) clearInterval(interval);
          interval = null;
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[index++]));
      };
      firstTimer = setTimeout(() => {
        firstTimer = null;
        emit();
        if (index < chunks.length) {
          interval = setInterval(emit, intervalMs);
        }
      }, firstDelayMs);
    },
    cancel() {
      if (firstTimer) clearTimeout(firstTimer);
      if (interval) clearInterval(interval);
      firstTimer = null;
      interval = null;
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test(
  "回归：持续有SSE分片也不应被一次性总超时误杀",
  { concurrency: false },
  async () => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) =>
      streamResponse({
        // yunwu 的最小显式超时是500ms；每100ms都有分片，整体略超500ms。
        // 这模拟长思考/长JSON正文而非完全静默的连接。
        intervalMs: 100,
        chunks: [
          sse({ choices: [{ delta: { content: "持" } }] }),
          sse({ choices: [{ delta: { content: "续" } }] }),
          sse({ choices: [{ delta: { content: "流" } }] }),
          sse({ choices: [{ delta: { content: "式" } }] }),
          sse({ choices: [{ delta: { content: "中" } }] }),
          sse({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 4, completion_tokens: 5 },
          }),
          "data: [DONE]\n\n",
        ],
        signal: options?.signal,
      });

    try {
      // RED 期望：只要每个分片都在 idle 窗口内，就应聚合完整正文；
      // 现状 timedSignal 只设置一次500ms总计时器，因此这里会抛504。
      const result = await yunwu.chatStream({
        role: "boss",
        model: "gpt-5.5",
        messages: [{ role: "user", content: "长流式正文" }],
        timeoutMs: 500,
      });
      assert.equal(result.text, "持续流式中");
      assert.equal(result.inputTokens, 4);
      assert.equal(result.outputTokens, 5);
    } finally {
      globalThis.fetch = nativeFetch;
    }
  },
);

test(
  "首包窗口：供应商在首包窗口内一个字节都不回时应提前收口，不等满整段超时",
  { concurrency: false },
  async () => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) =>
      streamResponse({
        // 首包远晚于首包窗口，但仍早于整段超时：真实故障里供应商就是这样
        // 把单轮上限整段吃满（preview 库 #51/#48 各干等约1000秒）。
        firstDelayMs: 2500,
        chunks: [
          sse({
            choices: [{ delta: { content: "迟到" } }],
            usage: { prompt_tokens: 4, completion_tokens: 1 },
          }),
          "data: [DONE]\n\n",
        ],
        signal: options?.signal,
      });

    const startedAt = Date.now();
    try {
      await assert.rejects(
        yunwu.chatStream({
          role: "boss",
          model: "gpt-5.5",
          messages: [{ role: "user", content: "首包窗口内完全静默" }],
          timeoutMs: 6000,
          firstByteTimeoutMs: 600,
        }),
        (error) => error?.status === 504,
      );
    } finally {
      globalThis.fetch = nativeFetch;
    }
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed < 2000,
      `应在首包窗口后立即失败，实际等待${elapsed}ms（整段超时6000ms）`,
    );
  },
);

test(
  "首包窗口：首包到达后必须续租回整段超时，长生成不得被首包窗口误杀",
  { concurrency: false },
  async () => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) =>
      streamResponse({
        // 首包在窗口内到达，随后整体生成时长远超首包窗口。
        firstDelayMs: 200,
        intervalMs: 300,
        chunks: [
          sse({ choices: [{ delta: { content: "长" } }] }),
          sse({ choices: [{ delta: { content: "正" } }] }),
          sse({ choices: [{ delta: { content: "文" } }] }),
          sse({ choices: [{ delta: { content: "生" } }] }),
          sse({ choices: [{ delta: { content: "成" } }] }),
          sse({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 4, completion_tokens: 5 },
          }),
          "data: [DONE]\n\n",
        ],
        signal: options?.signal,
      });

    const startedAt = Date.now();
    try {
      const result = await yunwu.chatStream({
        role: "boss",
        model: "gpt-5.5",
        messages: [{ role: "user", content: "首包很快但正文很长" }],
        timeoutMs: 6000,
        firstByteTimeoutMs: 600,
      });
      assert.equal(result.text, "长正文生成");
      assert.equal(result.outputTokens, 5);
    } finally {
      globalThis.fetch = nativeFetch;
    }
    assert.ok(
      Date.now() - startedAt > 600,
      "本用例必须真的跨过首包窗口，否则证明不了续租行为",
    );
  },
);

test(
  "回归：首token前连接静默到截止时必须是504且不产生usage/delta",
  { concurrency: false },
  async () => {
    const nativeFetch = globalThis.fetch;
    const deltas = [];
    globalThis.fetch = async (_url, options) =>
      streamResponse({
        // 首token晚于500ms：对应 T1315 的 receivedChars=0、provider_timeout。
        firstDelayMs: 700,
        chunks: [
          sse({
            choices: [{ delta: { content: "迟到" } }],
            usage: { prompt_tokens: 4, completion_tokens: 1 },
          }),
          "data: [DONE]\n\n",
        ],
        signal: options?.signal,
      });

    try {
      await assert.rejects(
        yunwu.chatStream({
          role: "boss",
          model: "gpt-5.5",
          messages: [{ role: "user", content: "首token延迟" }],
          timeoutMs: 500,
          onDelta: (delta) => deltas.push(delta),
        }),
        (error) => error?.status === 504,
      );
      assert.deepEqual(deltas, []);
    } finally {
      globalThis.fetch = nativeFetch;
    }
  },
);
