import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { checkServerHealth } = require("../src/health.cjs");

test("checks the same-origin /api/health endpoint and accepts an explicit healthy response", async () => {
  let requestedUrl;
  const result = await checkServerHealth("https://work.example.com", {
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      assert.equal(options.redirect, "error");
      return new Response(JSON.stringify({ ok: true, db: "up" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(requestedUrl, "https://work.example.com/api/health");
  assert.deepEqual(result, { ok: true, status: 200, message: "服务连接正常" });
});

test("rejects a health response that explicitly reports the database down", async () => {
  const result = await checkServerHealth("https://work.example.com", {
    fetchImpl: async () =>
      new Response(JSON.stringify({ ok: true, db: "down" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.message, "服务返回了无效的健康检查结果");
});

test("does not treat an arbitrary 2xx response as healthy", async () => {
  const result = await checkServerHealth("https://work.example.com", {
    fetchImpl: async () =>
      new Response("<html>proxy login</html>", { status: 200 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 200);
  assert.equal(result.message, "服务返回了无效的健康检查结果");
});

test("returns a human-readable failure without leaking a response body", async () => {
  const result = await checkServerHealth("https://work.example.com", {
    fetchImpl: async () =>
      new Response("SECRET INTERNAL BODY", {
        status: 503,
        headers: { "content-type": "text/plain" },
      }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.message, "服务暂时不可用（HTTP 503）");
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test("times out and reports an actionable connection failure", async () => {
  const result = await checkServerHealth("https://work.example.com", {
    timeoutMs: 10,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      }),
  });

  assert.deepEqual(result, {
    ok: false,
    status: null,
    message: "连接超时，请检查网络或服务器地址",
  });
});
