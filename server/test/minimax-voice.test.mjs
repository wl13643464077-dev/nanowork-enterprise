import assert from "node:assert/strict";
import test from "node:test";

import {
  MiniMaxVoiceError,
  createMiniMaxVoiceClient,
  parseMiniMaxAudioUrl,
} from "../src/engines/minimax-voice.js";

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

test("声音克隆严格按样本上传→voice_clone执行，并保留真实调用证据", async () => {
  const calls = [];
  const client = createMiniMaxVoiceClient({
    apiKey: "test-key-do-not-log",
    baseUrl: "https://voice.test",
    randomUUID: () => "12345678-1234-1234-1234-123456789012",
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/minimax/v1/files")) {
        assert.equal(init.method, "POST");
        assert.ok(init.body instanceof FormData);
        assert.equal(init.body.get("purpose"), "voice_clone");
        assert.equal(init.body.get("file").type, "audio/mpeg");
        return response({ file: { file_id: "file-voice-1" } });
      }
      assert.deepEqual(JSON.parse(init.body), {
        file_id: "file-voice-1",
        voice_id: "boss123456781234",
      });
      return response({ base_resp: { status_code: 0 } });
    },
  });

  const result = await client.cloneVoice({
    audio: Buffer.from("voice-sample"),
    fileName: "老板录音.mp3",
    mimeType: "audio/mpeg",
    label: " 王 老板 ",
  });

  assert.equal(calls.length, 2);
  assert.equal(result.voice.id, "boss123456781234");
  assert.equal(result.voice.label, "🧬 王老板");
  assert.equal(result.providerAttempt.verifiedApiCallCount, 2);
  assert.equal(result.providerAttempt.usage.inputBytes, 12);
  assert.equal(result.providerAttempt.cost.amount, null);
  assert.ok(
    calls.every(
      ({ init }) => init.headers.Authorization === "Bearer test-key-do-not-log",
    ),
  );
});

test("声音克隆拒绝无凭据、坏音频与供应商短录音，错误不回显上游正文", async () => {
  let calls = 0;
  const noKey = createMiniMaxVoiceClient({
    apiKey: "",
    baseUrl: "https://voice.test",
    fetchFn: async () => {
      calls += 1;
      return response({});
    },
  });
  await assert.rejects(
    () =>
      noKey.cloneVoice({
        audio: Buffer.from("sample"),
        mimeType: "audio/mpeg",
      }),
    (error) => error.code === "PROVIDER_CREDENTIALS_MISSING",
  );
  assert.equal(calls, 0);

  const invalid = createMiniMaxVoiceClient({
    apiKey: "key",
    baseUrl: "https://voice.test",
    fetchFn: async () => response({}),
  });
  await assert.rejects(
    () => invalid.cloneVoice({ audio: "base64-is-not-accepted" }),
    (error) => error.code === "MINIMAX_AUDIO_INPUT_INVALID",
  );

  const short = createMiniMaxVoiceClient({
    apiKey: "secret-key",
    baseUrl: "https://voice.test",
    fetchFn: async (url) =>
      url.endsWith("/files")
        ? response({ file: { file_id: "file-1" } })
        : response({
            base_resp: {
              status_code: 1001,
              status_msg:
                "duration too short; secret-key; internal supplier detail",
            },
          }),
  });
  await assert.rejects(
    () =>
      short.cloneVoice({
        audio: Buffer.from("sample"),
        mimeType: "audio/mpeg",
      }),
    (error) => {
      assert.equal(error.code, "MINIMAX_VOICE_SAMPLE_TOO_SHORT");
      assert.doesNotMatch(error.message, /secret|supplier/iu);
      return true;
    },
  );

  const missingStatus = createMiniMaxVoiceClient({
    apiKey: "key",
    baseUrl: "https://voice.test",
    fetchFn: async (url) =>
      url.endsWith("/files")
        ? response({ file: { file_id: "file-1" } })
        : response({}),
  });
  await assert.rejects(
    () =>
      missingStatus.cloneVoice({
        audio: Buffer.from("sample"),
        mimeType: "audio/mpeg",
      }),
    (error) => error.code === "MINIMAX_VOICE_CLONE_FAILED",
  );
});

test("TTS提交黄金源参数并只接收安全公网HTTPS音频", async () => {
  let requestBody;
  const client = createMiniMaxVoiceClient({
    apiKey: "key",
    baseUrl: "https://voice.test",
    fetchFn: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return response({
        base_resp: { status_code: 0 },
        data: { audio: "https://cdn.example.com/audio/result.mp3" },
      });
    },
  });
  const result = await client.synthesize({
    text: "欢迎来到毛血旺门店",
    voiceId: "bossvoice_1",
  });
  assert.equal(requestBody.model, "speech-2.8-hd");
  assert.equal(requestBody.output_format, "url");
  assert.equal(requestBody.voice_setting.voice_id, "bossvoice_1");
  assert.equal(requestBody.audio_setting.sample_rate, 32_000);
  assert.equal(result.audioUrl, "https://cdn.example.com/audio/result.mp3");
  assert.equal(result.providerAttempt.usage.networkRequests, 1);

  for (const url of [
    "http://cdn.example.com/audio.mp3",
    "https://127.0.0.1/audio.mp3",
    "https://cdn.example.com/audio.mp3?access_token=secret",
    "https://cdn.example.com/audio.mp3#token=secret",
    "https://user:pass@cdn.example.com/audio.mp3",
    "https://cdn.example.com/%F0%80%80%80/audio.mp3",
  ]) {
    assert.throws(
      () => parseMiniMaxAudioUrl(url),
      (error) =>
        error instanceof MiniMaxVoiceError &&
        error.code === "MINIMAX_AUDIO_URL_UNSAFE",
      url,
    );
  }
});

test("声音请求即使上游忽略AbortSignal也会被本地取消边界收敛", async () => {
  const controller = new AbortController();
  const client = createMiniMaxVoiceClient({
    apiKey: "key",
    baseUrl: "https://voice.test",
    fetchFn: async () => new Promise(() => {}),
  });
  const pending = client.synthesize({
    text: "取消测试",
    voiceId: "bossvoice_1",
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(
    () => pending,
    (error) => error.code === "MINIMAX_VOICE_CANCELLED",
  );

  const bodyController = new AbortController();
  const hangingBody = createMiniMaxVoiceClient({
    apiKey: "key",
    baseUrl: "https://voice.test",
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => new Promise(() => {}),
    }),
  });
  const bodyPending = hangingBody.synthesize({
    text: "响应体取消测试",
    voiceId: "bossvoice_1",
    signal: bodyController.signal,
  });
  bodyController.abort();
  await assert.rejects(
    () => bodyPending,
    (error) => error.code === "MINIMAX_VOICE_CANCELLED",
  );
});
