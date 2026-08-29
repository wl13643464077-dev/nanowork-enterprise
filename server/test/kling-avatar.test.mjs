import assert from "node:assert/strict";
import { test } from "node:test";

import createKlingAvatarClient, {
  KLING_AVATAR_MODEL,
  KlingAvatarError,
  parseKlingPublicAssetUrl,
} from "../src/engines/kling-avatar.js";

const IMAGE = { publicUrl: "https://assets.example.com/avatar/portrait.jpg" };
const AUDIO = {
  publicUrl: "https://assets.example.com/avatar/voice.mp3?expires=123",
};

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}

test("Kling 缺云雾凭据时 ready=false，且在 URL 校验和 fetch 前失败", async () => {
  let fetchCalls = 0;
  const client = createKlingAvatarClient({
    apiKey: "",
    baseUrl: "https://yunwu.test/v1",
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("不应调用");
    },
  });

  assert.equal(client.ready(), false);
  assert.equal(client.providerName, "kling");
  assert.equal(client.requiresPublicAssetUrls, true);
  await assert.rejects(
    () => client.synthesize({ image: null, audio: null }),
    (error) =>
      error instanceof KlingAvatarError &&
      error.code === "PROVIDER_CREDENTIALS_MISSING" &&
      error.status === 503,
  );
  assert.equal(fetchCalls, 0);
});

test("Kling 通过 Yunwu Bearer 提交 image/sound_file/mode/prompt 并轮询真实成片", async () => {
  const calls = [];
  const progress = [];
  let statusCalls = 0;
  let clock = 0;
  const client = createKlingAvatarClient({
    apiKey: "yunwu-kling-test-key",
    baseUrl: "https://yunwu.test/v1",
    mode: "pro",
    pricing: { amount: 16.8, currency: "USD", source: "kling_price_v2" },
    pollIntervalMs: 4,
    pollTimeoutMs: 100,
    maxPollAttempts: 4,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (init.method === "POST") {
        return jsonResponse({ data: { task_id: "kling-task-123" } });
      }
      statusCalls += 1;
      return statusCalls === 1
        ? jsonResponse({ data: { task_status: "submitted" } })
        : jsonResponse({
            data: {
              task_status: "succeed",
              task_result: {
                videos: [
                  {
                    url: "https://video.example.com/kling/output.mp4?expires=456",
                  },
                ],
              },
            },
          });
    },
  });

  const result = await client.synthesize({
    image: IMAGE,
    audio: AUDIO,
    prompt: "  镜头\n稳定，人物自然说话  ",
    onProgress: (event) => progress.push(event),
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://yunwu.test/kling/v1/videos/avatar/image2video");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(
    new Headers(calls[0].init.headers).get("authorization"),
    "Bearer yunwu-kling-test-key",
  );
  assert.equal(
    new Headers(calls[0].init.headers).get("content-type"),
    "application/json",
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    image: IMAGE.publicUrl,
    sound_file: AUDIO.publicUrl,
    mode: "pro",
    prompt: "镜头 稳定，人物自然说话",
  });
  assert.equal(
    calls[1].url,
    "https://yunwu.test/kling/v1/videos/avatar/image2video/kling-task-123",
  );
  assert.equal(calls[1].init.method, "GET");

  assert.equal(result.taskId, "kling-task-123");
  assert.equal(
    result.videoUrl,
    "https://video.example.com/kling/output.mp4?expires=456",
  );
  assert.equal(result.provider.id, "kling");
  assert.equal(result.providerName, "kling");
  assert.equal(result.model, KLING_AVATAR_MODEL);
  assert.equal(result.usage.networkRequests, 3);
  assert.deepEqual(result.costEvidence, {
    amount: 16.8,
    currency: "CNY",
    estimated: true,
    providerReported: false,
    source: "kling_price_v2",
    pricingMode: "configured_estimate",
    networkRequests: 3,
  });
  assert.equal(result.cost, result.costEvidence);
  assert.ok(progress.some((event) => event.phase === "create"));
  assert.ok(progress.some((event) => event.phase === "accepted"));
  assert.ok(progress.some((event) => event.phase === "polling"));
});

test("Kling 严格要求 image.publicUrl/audio.publicUrl 为安全公网 HTTPS，拒绝后不发请求", async () => {
  const unsafeUrls = [
    "http://assets.example.com/avatar.jpg",
    "https://localhost/avatar.jpg",
    "https://127.0.0.1/avatar.jpg",
    "https://10.0.0.1/avatar.jpg",
    "https://[::1]/avatar.jpg",
    "https://user:pass@assets.example.com/avatar.jpg",
    "https://assets.example.com:444/avatar.jpg",
    "https://assets.example.com/avatar.jpg#secret",
    "https://assets.example.com/%F0%80%80%80/avatar.jpg",
  ];
  for (const url of unsafeUrls) {
    assert.throws(
      () => parseKlingPublicAssetUrl(url),
      (error) => error.code === "KLING_AVATAR_PUBLIC_URL_UNSAFE",
      url,
    );
  }

  let fetchCalls = 0;
  const client = createKlingAvatarClient({
    apiKey: "url-safety-key",
    baseUrl: "https://yunwu.test",
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("不应调用");
    },
  });
  for (const input of [
    { image: { bytes: Buffer.from("private") }, audio: AUDIO },
    { image: { publicUrl: "http://assets.example.com/image.jpg" }, audio: AUDIO },
    { image: IMAGE, audio: { publicUrl: "https://192.168.1.8/audio.mp3" } },
  ]) {
    await assert.rejects(
      () => client.synthesize(input),
      (error) => error.code === "KLING_AVATAR_PUBLIC_URL_UNSAFE",
    );
  }
  assert.equal(fetchCalls, 0);
});

test("Kling prompt 最多发送 200 个 Unicode 字符且空 prompt 不进入请求体", async () => {
  const bodies = [];
  let taskNumber = 0;
  const client = createKlingAvatarClient({
    apiKey: "prompt-key",
    baseUrl: "https://yunwu.test",
    pollIntervalMs: 1,
    pollTimeoutMs: 100,
    sleep: async () => {},
    now: () => 0,
    fetchImpl: async (_url, init) => {
      if (init.method === "POST") {
        bodies.push(JSON.parse(init.body));
        taskNumber += 1;
        return jsonResponse({ data: { task_id: `task-${taskNumber}` } });
      }
      return jsonResponse({
        data: {
          task_status: "succeed",
          task_result: {
            videos: [{ url: `https://video.example.com/${taskNumber}.mp4` }],
          },
        },
      });
    },
  });

  await client.synthesize({ image: IMAGE, audio: AUDIO, prompt: "人".repeat(260) });
  await client.synthesize({ image: IMAGE, audio: AUDIO, prompt: " \n " });
  assert.equal(Array.from(bodies[0].prompt).length, 200);
  assert.equal("prompt" in bodies[1], false);
});

test("Kling 轮询按最大次数收敛，供应商私有报错与密钥被固定安全错误替代", async () => {
  const secret = "yunwu-sensitive-key-654";
  let calls = 0;
  const client = createKlingAvatarClient({
    apiKey: secret,
    baseUrl: "https://yunwu.test",
    pollIntervalMs: 1,
    pollTimeoutMs: 1_000,
    maxPollAttempts: 2,
    sleep: async () => {},
    now: () => 0,
    fetchImpl: async (_url, init) => {
      calls += 1;
      if (init.method === "POST") {
        return jsonResponse({ data: { task_id: "bounded-task" } });
      }
      return jsonResponse({
        data: {
          task_status: "provider-private-state",
          task_status_msg: `Bearer ${secret} https://private.example/${secret}`,
        },
      });
    },
  });

  let caught;
  try {
    await client.synthesize({ image: IMAGE, audio: AUDIO });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.code, "KLING_AVATAR_TIMEOUT");
  assert.equal(caught?.status, 504);
  assert.equal(calls, 3);
  assert.doesNotMatch(`${caught?.message} ${JSON.stringify(caught)}`, /sensitive-key|Bearer|private\.example/u);
});

test("Kling 成功状态必须含安全公网视频 URL", async () => {
  for (const candidate of [
    null,
    "http://video.example.com/output.mp4",
    "https://127.0.0.1/output.mp4",
  ]) {
    const client = createKlingAvatarClient({
      apiKey: "output-key",
      baseUrl: "https://yunwu.test",
      pollIntervalMs: 1,
      pollTimeoutMs: 100,
      sleep: async () => {},
      now: () => 0,
      fetchImpl: async (_url, init) =>
        init.method === "POST"
          ? jsonResponse({ data: { task_id: "task" } })
          : jsonResponse({
              data: {
                task_status: "succeed",
                task_result: { videos: [{ url: candidate }] },
              },
            }),
    });
    await assert.rejects(
      () => client.synthesize({ image: IMAGE, audio: AUDIO }),
      (error) =>
        error.code ===
        (candidate
          ? "KLING_AVATAR_OUTPUT_UNSAFE"
          : "KLING_AVATAR_OUTPUT_MISSING"),
    );
  }
});

test("Kling 请求截止时间和外部 Abort 均可终止忽略 signal 的 fetch/响应体", async () => {
  const timeoutClient = createKlingAvatarClient({
    apiKey: "timeout-key",
    baseUrl: "https://yunwu.test",
    requestTimeoutMs: 5,
    fetchImpl: async () => new Promise(() => {}),
  });
  const keepAlive = setTimeout(() => {}, 300);
  try {
    await assert.rejects(
      () => timeoutClient.synthesize({ image: IMAGE, audio: AUDIO }),
      (error) =>
        error.code === "KLING_AVATAR_REQUEST_TIMEOUT" && error.status === 504,
    );

    const bodyTimeoutClient = createKlingAvatarClient({
      apiKey: "body-timeout-key",
      baseUrl: "https://yunwu.test",
      requestTimeoutMs: 5,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => new Promise(() => {}),
      }),
    });
    await assert.rejects(
      () => bodyTimeoutClient.synthesize({ image: IMAGE, audio: AUDIO }),
      (error) => error.code === "KLING_AVATAR_REQUEST_TIMEOUT",
    );
  } finally {
    clearTimeout(keepAlive);
  }

  const controller = new AbortController();
  const abortClient = createKlingAvatarClient({
    apiKey: "abort-key",
    baseUrl: "https://yunwu.test",
    requestTimeoutMs: 60_000,
    fetchImpl: async () => new Promise(() => {}),
  });
  const pending = abortClient.synthesize({
    image: IMAGE,
    audio: AUDIO,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(
    () => pending,
    (error) =>
      error.code === "KLING_AVATAR_CANCELLED" && error.status === 499,
  );
});
