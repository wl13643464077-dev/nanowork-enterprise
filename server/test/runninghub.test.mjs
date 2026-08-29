import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRunningHubNodeInfoList,
  createRunningHubClient,
  parseRunningHubVideoUrl,
  RUNNINGHUB_DEFAULT_MODEL,
} from "../src/engines/runninghub.js";

const API_KEY = "server-only-runninghub-secret";
const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const AUDIO = Buffer.from("ID3-runninghub-audio-fixture");

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function successfulFetch({
  statuses = ["SUCCESS"],
  outputs = [
    { fileUrl: "https://cdn.example.com/result/voice.flac" },
    { fileUrl: "https://cdn.example.com/result/avatar-video.mp4" },
  ],
  createResponses = [{ code: 0, data: { taskId: "rh-task-001" } }],
  calls = [],
} = {}) {
  let uploadIndex = 0;
  let createIndex = 0;
  let statusIndex = 0;
  return async (url, options) => {
    const endpoint = new URL(String(url)).pathname;
    if (endpoint.endsWith("/upload")) {
      const form = options.body;
      const file = form.get("file");
      calls.push({
        endpoint,
        apiKey: form.get("apiKey"),
        fileType: form.get("fileType"),
        fileName: file.name,
        fileSize: file.size,
        contentType: file.type,
      });
      uploadIndex += 1;
      return json({
        code: 0,
        data: {
          fileName:
            uploadIndex === 1 ? "remote-portrait.png" : "remote-voice.mp3",
        },
      });
    }
    const body = JSON.parse(options.body);
    calls.push({ endpoint, body });
    if (endpoint.endsWith("/create")) {
      const response =
        createResponses[Math.min(createIndex, createResponses.length - 1)];
      createIndex += 1;
      return json(response);
    }
    if (endpoint.endsWith("/status")) {
      const status = statuses[Math.min(statusIndex, statuses.length - 1)];
      statusIndex += 1;
      return json({ code: 0, data: status });
    }
    if (endpoint.endsWith("/outputs")) return json({ code: 0, data: outputs });
    throw new Error(`unexpected fixture endpoint: ${endpoint}`);
  };
}

function fixtureClient(overrides = {}) {
  let clock = 0;
  const sleeps = [];
  const calls = overrides.calls || [];
  const fetchImpl =
    overrides.fetchImpl || successfulFetch({ ...overrides, calls });
  const client = createRunningHubClient({
    baseUrl: "https://runninghub.example.com",
    apiKey: API_KEY,
    workflowId: "workflow-1986",
    instanceType: "plus",
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    queueRetryDelayMs: 30,
    queueTimeoutMs: 300,
    pollIntervalMs: 10,
    pollTimeoutMs: 100,
    maxPollAttempts: 10,
    ...overrides.options,
  });
  return { client, calls, sleeps, clock: () => clock };
}

test("RunningHub 完整顺序为图片上传→音频上传→建任务→轮询→取成片", async () => {
  const calls = [];
  const progress = [];
  const { client, sleeps } = fixtureClient({
    calls,
    statuses: ["QUEUED", "SUCCESS"],
    options: {
      pricing: { amount: 1.25, currency: "cny", source: "admin" },
    },
  });

  const result = await client.synthesize({
    image: { bytes: IMAGE, fileName: "portrait.png", mimeType: "image/png" },
    audio: { bytes: AUDIO, fileName: "voice.mp3", mimeType: "audio/mpeg" },
    onProgress: (event) => progress.push(event),
  });

  assert.deepEqual(
    calls.map((call) => call.endpoint),
    [
      "/task/openapi/upload",
      "/task/openapi/upload",
      "/task/openapi/create",
      "/task/openapi/status",
      "/task/openapi/status",
      "/task/openapi/outputs",
    ],
  );
  assert.deepEqual(
    calls
      .slice(0, 2)
      .map((call) => [
        call.apiKey,
        call.fileType,
        call.fileName,
        call.fileSize,
      ]),
    [
      [API_KEY, "image", "portrait.png", IMAGE.length],
      [API_KEY, "audio", "voice.mp3", AUDIO.length],
    ],
  );
  assert.deepEqual(calls[2].body, {
    apiKey: API_KEY,
    workflowId: "workflow-1986",
    nodeInfoList: [
      { nodeId: "472", fieldName: "image", fieldValue: "remote-portrait.png" },
      { nodeId: "474", fieldName: "audio", fieldValue: "remote-voice.mp3" },
      { nodeId: "484", fieldName: "audio", fieldValue: "remote-voice.mp3" },
    ],
    instanceType: "plus",
  });
  assert.deepEqual(sleeps, [10, 10]);
  assert.equal(result.taskId, "rh-task-001");
  assert.equal(
    result.videoUrl,
    "https://cdn.example.com/result/avatar-video.mp4",
  );
  assert.equal(result.provider.id, "runninghub");
  assert.equal(result.model, RUNNINGHUB_DEFAULT_MODEL);
  assert.deepEqual(result.usage, {
    networkRequests: 6,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    tokenUsageApplicable: false,
  });
  assert.deepEqual(result.costEvidence, {
    amount: 1.25,
    currency: "CNY",
    estimated: true,
    providerReported: false,
    source: "admin",
    pricingMode: "configured_estimate",
    networkRequests: 6,
  });
  assert.ok(progress.some((event) => event.phase === "polling"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(API_KEY, "u"));
});

test("QUEUE_MAXED 按有界间隔重试，且用量记录所有真实请求", async () => {
  const calls = [];
  const { client, sleeps } = fixtureClient({
    calls,
    createResponses: [
      { code: 500, msg: "QUEUE_MAXED" },
      { code: 500, data: { reason: "QUEUE_MAXED" } },
      { code: 0, data: { taskId: "rh-after-queue" } },
    ],
    options: { maxQueueRetries: 2 },
  });

  const result = await client.synth({ image: IMAGE, audio: AUDIO });
  assert.equal(result.taskId, "rh-after-queue");
  assert.deepEqual(sleeps, [30, 30, 10]);
  assert.equal(
    calls.filter((call) => call.endpoint.endsWith("/create")).length,
    3,
  );
  assert.equal(result.usage.networkRequests, 7);
  assert.equal(result.costEvidence.networkRequests, 7);
});

test("QUEUE_MAXED 超出重试上限后脱敏收敛", async () => {
  const secret = "upstream-secret-in-queue-json";
  const { client, calls } = fixtureClient({
    createResponses: [{ code: 500, msg: `QUEUE_MAXED ${secret} ${API_KEY}` }],
    options: { maxQueueRetries: 1 },
  });
  await assert.rejects(
    () => client.synthesize({ image: IMAGE, audio: AUDIO }),
    (error) => {
      assert.equal(error.code, "RUNNINGHUB_QUEUE_MAXED");
      assert.equal(error.status, 503);
      assert.doesNotMatch(String(error), new RegExp(secret, "u"));
      assert.doesNotMatch(String(error), new RegExp(API_KEY, "u"));
      return true;
    },
  );
  assert.equal(
    calls.filter((call) => call.endpoint.endsWith("/create")).length,
    2,
  );
});

test("RunningHub 上游上传与工作流失败不反射供应商 JSON 或凭据", async (t) => {
  const supplierSecret = "INTERNAL-SUPPLIER-ERROR-DO-NOT-REFLECT";
  await t.test("上传失败", async () => {
    let count = 0;
    const { client } = fixtureClient({
      fetchImpl: async () => {
        count += 1;
        return json({
          code: 500,
          msg: `${supplierSecret} apiKey=${API_KEY}`,
        });
      },
    });
    await assert.rejects(
      () => client.synthesize({ image: IMAGE, audio: AUDIO }),
      (error) => {
        assert.equal(error.code, "RUNNINGHUB_UPLOAD_FAILED");
        assert.doesNotMatch(String(error), new RegExp(supplierSecret, "u"));
        assert.doesNotMatch(JSON.stringify(error), new RegExp(API_KEY, "u"));
        return true;
      },
    );
    assert.equal(count, 1);
  });

  await t.test("工作流 FAILED", async () => {
    const { client } = fixtureClient({ statuses: ["FAILED"] });
    await assert.rejects(
      () => client.synthesize({ image: IMAGE, audio: AUDIO }),
      (error) => {
        assert.equal(error.code, "RUNNINGHUB_WORKFLOW_FAILED");
        assert.doesNotMatch(JSON.stringify(error), new RegExp(API_KEY, "u"));
        return true;
      },
    );
  });

  await t.test("传输异常", async () => {
    const { client } = fixtureClient({
      fetchImpl: async () => {
        throw new Error(`${supplierSecret} Bearer ${API_KEY}`);
      },
    });
    await assert.rejects(
      () => client.synthesize({ image: IMAGE, audio: AUDIO }),
      (error) => {
        assert.equal(error.code, "RUNNINGHUB_UPSTREAM_FAILED");
        assert.doesNotMatch(String(error), new RegExp(supplierSecret, "u"));
        assert.doesNotMatch(String(error), new RegExp(API_KEY, "u"));
        return true;
      },
    );
  });
});

test("RunningHub 轮询在超时边界内停止，不请求 outputs", async () => {
  const calls = [];
  const { client, clock } = fixtureClient({
    calls,
    statuses: ["RUNNING"],
    options: {
      pollIntervalMs: 10,
      pollTimeoutMs: 25,
      maxPollAttempts: 10,
    },
  });
  await assert.rejects(
    () => client.synthesize({ image: IMAGE, audio: AUDIO }),
    (error) => error.code === "RUNNINGHUB_TIMEOUT" && error.status === 504,
  );
  assert.equal(clock(), 25);
  assert.equal(
    calls.filter((call) => call.endpoint.endsWith("/status")).length,
    2,
  );
  assert.equal(
    calls.filter((call) => call.endpoint.endsWith("/outputs")).length,
    0,
  );
});

test("AbortSignal 可在轮询等待期间立即取消", async () => {
  const controller = new AbortController();
  const calls = [];
  let clock = 0;
  const client = createRunningHubClient({
    baseUrl: "https://runninghub.example.com",
    apiKey: API_KEY,
    fetchImpl: successfulFetch({ calls }),
    sleep: async (ms) => {
      clock += ms;
      controller.abort();
    },
    now: () => clock,
    pollIntervalMs: 10,
    pollTimeoutMs: 100,
  });
  await assert.rejects(
    () =>
      client.synthesize({
        image: IMAGE,
        audio: AUDIO,
        signal: controller.signal,
      }),
    (error) => error.code === "RUNNINGHUB_CANCELLED" && error.status === 499,
  );
  assert.equal(
    calls.filter((call) => call.endpoint.endsWith("/status")).length,
    0,
  );
});

test("AbortSignal 也能中断忽略 signal 的上游 fetch", async () => {
  const controller = new AbortController();
  let requests = 0;
  const client = createRunningHubClient({
    baseUrl: "https://runninghub.example.com",
    apiKey: API_KEY,
    fetchImpl: async () => {
      requests += 1;
      controller.abort();
      return new Promise(() => {});
    },
  });
  await assert.rejects(
    () =>
      client.synthesize({
        image: IMAGE,
        audio: AUDIO,
        signal: controller.signal,
      }),
    (error) => error.code === "RUNNINGHUB_CANCELLED" && error.status === 499,
  );
  assert.equal(requests, 1);
});

test("RunningHub 成片 URL 只接受无凭据的安全公网 HTTPS 视频", async (t) => {
  assert.equal(
    parseRunningHubVideoUrl("https://cdn.example.com/a/video.mp4?download=1")
      .href,
    "https://cdn.example.com/a/video.mp4?download=1",
  );
  const unsafe = [
    "http://cdn.example.com/video.mp4",
    "https://user:pass@cdn.example.com/video.mp4",
    "https://cdn.example.com/video.mp4?access_token=secret",
    "https://cdn.example.com/video.mp4?%2574oken=secret",
    "https://cdn.example.com/video.mp4#download",
    "https://127.0.0.1/video.mp4",
    "https://service.internal/video.mp4",
    "https://cdn.example.com/%F0%80%80%80/video.mp4",
    `https://cdn.example.com/video.mp4?download=${API_KEY}`,
  ];

  for (const url of unsafe) {
    await t.test(url.replace(API_KEY, "[credential]"), async () => {
      const { client } = fixtureClient({ outputs: [{ fileUrl: url }] });
      await assert.rejects(
        () => client.synthesize({ image: IMAGE, audio: AUDIO }),
        (error) => {
          assert.equal(error.code, "RUNNINGHUB_OUTPUT_UNSAFE");
          assert.doesNotMatch(JSON.stringify(error), new RegExp(API_KEY, "u"));
          return true;
        },
      );
    });
  }
});

test("RunningHub 没有视频输出时 fail-closed，不会误取音频", async () => {
  const { client } = fixtureClient({
    outputs: [
      { fileUrl: "https://cdn.example.com/result/audio.flac" },
      { fileUrl: "https://cdn.example.com/result/readme.txt" },
    ],
  });
  await assert.rejects(
    () => client.synthesize({ image: IMAGE, audio: AUDIO }),
    (error) => error.code === "RUNNINGHUB_OUTPUT_MISSING",
  );
});

test("RunningHub 无服务端凭据时在任何网络请求前 fail-closed", async () => {
  let called = false;
  const client = createRunningHubClient({
    baseUrl: "https://runninghub.example.com",
    apiKey: "",
    fetchImpl: async () => {
      called = true;
      throw new Error("must not call network");
    },
  });
  assert.equal(client.ready(), false);
  await assert.rejects(
    () => client.synthesize({ image: IMAGE, audio: AUDIO }),
    (error) =>
      error.code === "PROVIDER_CREDENTIALS_MISSING" && error.status === 503,
  );
  assert.equal(called, false);
});

test("默认 nodeInfoList 一比一保留 RunningHub 真实工作流节点", () => {
  assert.deepEqual(
    buildRunningHubNodeInfoList({
      imageFileName: "portrait-uploaded.png",
      audioFileName: "voice-uploaded.mp3",
    }),
    [
      {
        nodeId: "472",
        fieldName: "image",
        fieldValue: "portrait-uploaded.png",
      },
      {
        nodeId: "474",
        fieldName: "audio",
        fieldValue: "voice-uploaded.mp3",
      },
      {
        nodeId: "484",
        fieldName: "audio",
        fieldValue: "voice-uploaded.mp3",
      },
    ],
  );
});
