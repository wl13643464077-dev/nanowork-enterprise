import assert from "node:assert/strict";
import { test } from "node:test";

import createHeyGenAvatarClient, {
  HEYGEN_AVATAR_MODEL,
  HeyGenAvatarError,
} from "../src/engines/heygen-avatar.js";

const IMAGE = {
  bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01]),
  fileName: "portrait.jpg",
  mimeType: "image/jpeg",
};
const AUDIO = {
  bytes: Buffer.from("RIFF-avatar-audio"),
  fileName: "voice.wav",
  mimeType: "audio/wav",
};

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}

test("HeyGen 缺凭据时 ready=false，且在任何素材解析或 fetch 前失败", async () => {
  let fetchCalls = 0;
  const client = createHeyGenAvatarClient({
    apiKey: "",
    baseUrl: "https://api.heygen.test",
    uploadBaseUrl: "https://upload.heygen.test",
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("不应调用");
    },
  });

  assert.equal(client.ready(), false);
  assert.equal(client.providerName, "heygen");
  assert.equal(client.requiresPublicAssetUrls, false);
  await assert.rejects(
    () => client.synthesize({ image: null, audio: null }),
    (error) =>
      error instanceof HeyGenAvatarError &&
      error.code === "PROVIDER_CREDENTIALS_MISSING" &&
      error.status === 503,
  );
  assert.equal(fetchCalls, 0);
});

test("HeyGen 以原始字节上传照片和音频、启用 Avatar IV 并有界轮询成片", async () => {
  const calls = [];
  const progress = [];
  let statusCalls = 0;
  let clock = 0;
  const client = createHeyGenAvatarClient({
    apiKey: "heygen-test-key",
    baseUrl: "https://api.heygen.test",
    uploadBaseUrl: "https://upload.heygen.test",
    pricing: { amount: 12.5, currency: "USD", source: "avatar_price_v1" },
    pollIntervalMs: 5,
    pollTimeoutMs: 100,
    maxPollAttempts: 4,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/talking_photo") {
        return jsonResponse({ data: { talking_photo_id: "photo-123" } });
      }
      if (parsed.pathname === "/v1/asset") {
        return jsonResponse({ data: { id: "audio-456" } });
      }
      if (parsed.pathname === "/v2/video/generate") {
        return jsonResponse({ data: { video_id: "video-789" } });
      }
      if (parsed.pathname === "/v1/video_status.get") {
        statusCalls += 1;
        return statusCalls === 1
          ? jsonResponse({ data: { status: "processing" } })
          : jsonResponse({
              data: {
                status: "completed",
                video_url: "https://cdn.heygen.test/output/avatar.mp4?Expires=123",
              },
            });
      }
      throw new Error(`unexpected mock path ${parsed.pathname}`);
    },
  });

  assert.equal(client.ready(), true);
  const result = await client.synthesize({
    image: IMAGE,
    audio: AUDIO,
    prompt: "音频驱动时无需把口播稿发给 HeyGen",
    onProgress: (event) => progress.push(event),
  });

  assert.equal(calls.length, 5);
  assert.equal(statusCalls, 2);
  assert.equal(calls[0].url, "https://upload.heygen.test/v1/talking_photo");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.body, IMAGE.bytes);
  assert.equal(new Headers(calls[0].init.headers).get("x-api-key"), "heygen-test-key");
  assert.equal(new Headers(calls[0].init.headers).get("content-type"), "image/jpeg");
  assert.equal(calls[1].url, "https://upload.heygen.test/v1/asset");
  assert.deepEqual(calls[1].init.body, AUDIO.bytes);
  assert.equal(new Headers(calls[1].init.headers).get("content-type"), "audio/wav");

  const generate = JSON.parse(calls[2].init.body);
  assert.deepEqual(generate.video_inputs, [
    {
      character: { type: "talking_photo", talking_photo_id: "photo-123" },
      voice: { type: "audio", audio_asset_id: "audio-456" },
    },
  ]);
  assert.deepEqual(generate.dimension, { width: 720, height: 1280 });
  assert.equal(generate.use_avatar_iv_model, true);
  assert.equal(calls[3].init.method, "GET");
  assert.equal(new URL(calls[3].url).searchParams.get("video_id"), "video-789");

  assert.equal(result.taskId, "video-789");
  assert.equal(
    result.videoUrl,
    "https://cdn.heygen.test/output/avatar.mp4?Expires=123",
  );
  assert.equal(result.provider.id, "heygen");
  assert.equal(result.providerName, "heygen");
  assert.equal(result.model, HEYGEN_AVATAR_MODEL);
  assert.equal(result.usage.networkRequests, 5);
  assert.deepEqual(result.costEvidence, {
    amount: 12.5,
    currency: "CNY",
    estimated: true,
    providerReported: false,
    source: "avatar_price_v1",
    pricingMode: "configured_estimate",
    networkRequests: 5,
  });
  assert.equal(result.cost, result.costEvidence);
  assert.ok(progress.some((event) => event.phase === "upload_image"));
  assert.ok(progress.some((event) => event.phase === "upload_audio"));
  assert.ok(progress.some((event) => event.phase === "create"));
  assert.ok(progress.some((event) => event.phase === "polling"));
});

test("HeyGen 照片槽位满时只列一次、只清理上限内旧组并只重试上传一次", async () => {
  const calls = [];
  let uploadAttempts = 0;
  const client = createHeyGenAvatarClient({
    apiKey: "heygen-cleanup-key",
    baseUrl: "https://api.heygen.test",
    uploadBaseUrl: "https://upload.heygen.test",
    cleanupGroupLimit: 2,
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      calls.push({ pathname: parsed.pathname, search: parsed.search, method: init.method });
      if (parsed.pathname === "/v1/talking_photo") {
        uploadAttempts += 1;
        return jsonResponse(
          { code: 401028, message: "photo avatar group limit exceeded" },
          { ok: false, status: 400 },
        );
      }
      if (parsed.pathname === "/v2/avatar_group.list") {
        return jsonResponse({
          data: {
            avatar_group_list: [
              { id: "group-1" },
              { id: "group-2" },
              { id: "group-3" },
              { id: "group-4" },
            ],
          },
        });
      }
      if (parsed.pathname.startsWith("/v2/photo_avatar/")) {
        return jsonResponse({ code: 101 }, { ok: false, status: 404 });
      }
      if (parsed.pathname.startsWith("/v2/avatar_group/")) {
        return jsonResponse({ code: 100 });
      }
      throw new Error(`unexpected mock path ${parsed.pathname}`);
    },
  });

  await assert.rejects(
    () => client.synthesize({ image: IMAGE, audio: AUDIO }),
    (error) => error.code === "HEYGEN_PHOTO_SLOTS_FULL",
  );

  assert.equal(uploadAttempts, 2);
  assert.equal(
    calls.filter((call) => call.pathname === "/v2/avatar_group.list").length,
    1,
  );
  assert.equal(
    calls.filter((call) => call.pathname.startsWith("/v2/photo_avatar/")).length,
    2,
  );
  assert.equal(
    calls.filter((call) => call.pathname.startsWith("/v2/avatar_group/")).length,
    2,
  );
  assert.equal(calls.some((call) => call.pathname.includes("group-3")), false);
  assert.equal(calls.some((call) => call.pathname === "/v1/asset"), false);
  assert.equal(calls.length, 7);
});

test("HeyGen 轮询由最大次数收敛，供应商失败文案和密钥不会外泄", async () => {
  const secret = "heygen-sensitive-key-987";
  let calls = 0;
  const client = createHeyGenAvatarClient({
    apiKey: secret,
    baseUrl: "https://api.heygen.test",
    uploadBaseUrl: "https://upload.heygen.test",
    pollIntervalMs: 1,
    pollTimeoutMs: 1_000,
    maxPollAttempts: 2,
    sleep: async () => {},
    now: () => 0,
    fetchImpl: async (url) => {
      calls += 1;
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/v1/talking_photo") {
        return jsonResponse({ data: { id: "photo" } });
      }
      if (pathname === "/v1/asset") {
        return jsonResponse({ data: { asset_id: "audio" } });
      }
      if (pathname === "/v2/video/generate") {
        return jsonResponse({ data: { video_id: "task" } });
      }
      return jsonResponse({
        data: {
          status: "provider-private-state",
          message: `Bearer ${secret} https://private.example/${secret}`,
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
  assert.equal(caught?.code, "HEYGEN_TIMEOUT");
  assert.equal(caught?.status, 504);
  assert.equal(calls, 5);
  assert.doesNotMatch(`${caught?.message} ${JSON.stringify(caught)}`, /sensitive-key|Bearer|private\.example/u);
});

test("HeyGen 请求截止时间可终止忽略 signal 的 fetch，外部 Abort 也立即生效", async () => {
  const deadlineClient = createHeyGenAvatarClient({
    apiKey: "deadline-key",
    baseUrl: "https://api.heygen.test",
    uploadBaseUrl: "https://upload.heygen.test",
    requestTimeoutMs: 5,
    fetchImpl: async () => new Promise(() => {}),
  });
  const keepAlive = setTimeout(() => {}, 200);
  try {
    await assert.rejects(
      () => deadlineClient.synthesize({ image: IMAGE, audio: AUDIO }),
      (error) =>
        error.code === "HEYGEN_REQUEST_TIMEOUT" && error.status === 504,
    );
  } finally {
    clearTimeout(keepAlive);
  }

  const controller = new AbortController();
  const abortClient = createHeyGenAvatarClient({
    apiKey: "abort-key",
    baseUrl: "https://api.heygen.test",
    uploadBaseUrl: "https://upload.heygen.test",
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
    (error) => error.code === "HEYGEN_CANCELLED" && error.status === 499,
  );
});

test("HeyGen 响应体挂起也受同一请求截止时间约束", async () => {
  const client = createHeyGenAvatarClient({
    apiKey: "body-timeout-key",
    baseUrl: "https://api.heygen.test",
    uploadBaseUrl: "https://upload.heygen.test",
    requestTimeoutMs: 5,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => new Promise(() => {}),
    }),
  });
  const keepAlive = setTimeout(() => {}, 200);
  try {
    await assert.rejects(
      () => client.synthesize({ image: IMAGE, audio: AUDIO }),
      (error) => error.code === "HEYGEN_REQUEST_TIMEOUT",
    );
  } finally {
    clearTimeout(keepAlive);
  }
});
