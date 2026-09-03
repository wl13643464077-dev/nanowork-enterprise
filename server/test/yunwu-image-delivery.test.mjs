import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

const originalEnv = {
  NANOWORK_TEST_TEMPLATE_AI: process.env.NANOWORK_TEST_TEMPLATE_AI,
  NANOWORK_IMAGE_RATE_LIMIT_RETRY_MS:
    process.env.NANOWORK_IMAGE_RATE_LIMIT_RETRY_MS,
  YUNWU_API_KEY: process.env.YUNWU_API_KEY,
  YUNWU_BASE_URL: process.env.YUNWU_BASE_URL,
};

// CI 不提供本地 .env。本测试显式固定假凭据、假地址并直接注入 fetch，
// 从而既不会读取开发机配置，也不可能误发真实供应商请求。
process.env.NANOWORK_TEST_TEMPLATE_AI = "1";
process.env.YUNWU_API_KEY = "test-only-yunwu-image-key";
process.env.YUNWU_BASE_URL = "https://yunwu-image.test/v1";

const { generateImage } = await import("../src/engines/yunwu.js");

function restoreEnv(key) {
  if (originalEnv[key] === undefined) delete process.env[key];
  else process.env[key] = originalEnv[key];
}

afterEach(() => {
  restoreEnv("NANOWORK_IMAGE_RATE_LIMIT_RETRY_MS");
});

after(() => {
  Object.keys(originalEnv).forEach(restoreEnv);
});

test("generateImage把逐图幂等键发给云雾并保留真实图片token用量", async () => {
  let captured;
  const fetchFn = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(
      JSON.stringify({
        data: [{ b64_json: "aW1hZ2UtYnl0ZXM=", mime_type: "image/png" }],
        usage: { input_tokens: 17, output_tokens: 29, total_tokens: 46 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  const result = await generateImage({
    prompt: "太原餐饮首图",
    size: "1024x1536",
    model: "gpt-image-2",
    idempotencyKey: "content-pipeline:1:station:5:image:1",
    fetchFn,
  });

  assert.equal(captured.url, "https://yunwu-image.test/v1/images/generations");
  assert.equal(
    new Headers(captured.options.headers).get("authorization"),
    "Bearer test-only-yunwu-image-key",
  );
  assert.equal(
    new Headers(captured.options.headers).get("idempotency-key"),
    "content-pipeline:1:station:5:image:1",
  );
  assert.deepEqual(JSON.parse(captured.options.body), {
    model: "gpt-image-2",
    prompt: "太原餐饮首图",
    n: 1,
    size: "1024x1536",
  });
  assert.equal(result.b64, "aW1hZ2UtYnl0ZXM=");
  assert.equal(result.mimeType, "image/png");
  assert.deepEqual(result.usage, {
    inputTokens: 17,
    outputTokens: 29,
    totalTokens: 46,
  });
});

test("generateImage在网络请求前拒绝无法安全传递的幂等键", async () => {
  let called = false;
  const fetchFn = async () => {
    called = true;
    throw new Error("不应调用");
  };
  await assert.rejects(
    () =>
      generateImage({
        prompt: "图片",
        model: "gpt-image-2",
        idempotencyKey: "bad key\nInjected: true",
        fetchFn,
      }),
    /幂等键格式无效/u,
  );
  assert.equal(called, false);
});

test("generateImage遇到限流会退避重试并在后续成功时交付图片", async () => {
  process.env.NANOWORK_IMAGE_RATE_LIMIT_RETRY_MS = "1";
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          error: { message: "Rate limit exceeded" },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response(
      JSON.stringify({
        data: [{ b64_json: "cmV0cnktb2s=", mime_type: "image/png" }],
        usage: { input_tokens: 9, output_tokens: 11, total_tokens: 20 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  const result = await generateImage({
    prompt: "晚市两人套餐配图",
    model: "gpt-image-2",
    idempotencyKey: "content-pipeline:18:station:5:image:1",
    fetchFn,
  });

  assert.equal(calls, 2);
  assert.equal(result.b64, "cmV0cnktb2s=");
  assert.deepEqual(result.usage, {
    inputTokens: 9,
    outputTokens: 11,
    totalTokens: 20,
  });
});
