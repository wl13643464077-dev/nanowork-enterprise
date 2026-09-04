import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { assertPrivateArtifact } from "../src/engines/private-artifact.js";

const dbPath = path.join(
  os.tmpdir(),
  `nanowork-text-video-runtime-${process.pid}.db`,
);
for (const suffix of ["", "-wal", "-shm"]) {
  fs.rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.NANOWORK_DB = dbPath;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

const { initSchema, migrateV2, q, runWithTenant } =
  await import("../src/db.js");
const {
  createTextVideoJobService,
  createTextVideoRenderer,
  listTextVideoLicensedMaterials,
  prepareTextVideoScript,
  saveTextVideoAsset,
  splitTextVideoSentences,
  TextVideoError,
} = await import("../src/engines/text-video.js");

const roots = [];
let tenantId;
let user;

async function tempRoot(prefix) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function jpegBytes() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from("JFIF\0fixture-image"),
  ]);
}

function mp3Bytes() {
  return Buffer.concat([Buffer.from("ID3"), Buffer.alloc(128, 7)]);
}

function mp4Bytes(label = "fixture-video") {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftyp"),
    Buffer.from("isom"),
    Buffer.from(label),
    Buffer.alloc(48, 3),
  ]);
}

function wavBytes(durationSeconds = 0.45) {
  const sampleRate = 16_000;
  const sampleCount = Math.ceil(sampleRate * durationSeconds);
  const dataBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

function localMediaBinary(name, configured) {
  const candidates = [
    configured,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    name,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["-version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

const localFfmpeg = localMediaBinary(
  "ffmpeg",
  process.env.TEXT_VIDEO_FFMPEG_PATH,
);
const localFfprobe = localMediaBinary(
  "ffprobe",
  process.env.TEXT_VIDEO_FFPROBE_PATH,
);
const localFfmpegFilters = localFfmpeg
  ? spawnSync(localFfmpeg, ["-hide_banner", "-filters"], {
      encoding: "utf8",
      timeout: 10_000,
    }).stdout || ""
  : "";
const localNeedsRasterFallback =
  Boolean(localFfmpeg && localFfprobe) &&
  /(?:^|\s)overlay(?:\s|$)/mu.test(localFfmpegFilters) &&
  !/(?:^|\s)drawtext(?:\s|$)/mu.test(localFfmpegFilters);

function audioProbe(duration = 2.4) {
  return JSON.stringify({
    streams: [
      { codec_type: "audio", codec_name: "mp3", duration: String(duration) },
    ],
    format: { duration: String(duration) },
  });
}

function videoProbe({ duration = 12, output = false } = {}) {
  return JSON.stringify({
    streams: [
      {
        codec_type: "video",
        codec_name: output ? "h264" : "vp9",
        width: output ? 1080 : 720,
        height: output ? 1920 : 1280,
        duration: String(duration),
      },
      {
        codec_type: "audio",
        codec_name: output ? "aac" : "opus",
        duration: String(duration),
      },
    ],
    format: { duration: String(duration) },
  });
}

before(() => {
  initSchema();
  migrateV2();
  const suffix = crypto.randomBytes(6).toString("hex");
  const tenant = q.run(
    `INSERT INTO tenants(name,status,plan,credits,total_recharged)
    VALUES(?,'已开通','旗舰版',100000,100000)`,
    `成片测试租户-${suffix}`,
  );
  tenantId = Number(tenant.lastInsertRowid);
  const created = q.run(
    `INSERT INTO users(username,password_hash,name,role,status,tenant_id)
    VALUES(?,?,'成片测试老板','boss','启用',?)`,
    `text-video-${suffix}`,
    "unused",
    tenantId,
  );
  user = {
    id: Number(created.lastInsertRowid),
    tenant_id: tenantId,
    role: "boss",
  };
});

test("口播分句严格保持6至26字且不使用占位文本", () => {
  const script =
    "很多老板以为拍视频必须先买昂贵设备。其实先把真实菜品、顾客场景和一句核心信息讲清楚，就能开始验证内容方向。今天先拍一道菜，明天再看真实数据。";
  const sentences = splitTextVideoSentences(script);
  assert.ok(sentences.length >= 3);
  for (const sentence of sentences) {
    const length = Array.from(sentence).length;
    assert.ok(length >= 6 && length <= 26, `${sentence}=${length}`);
    assert.doesNotMatch(sentence, /占位|模板|稍后补充/u);
  }
  assert.equal(
    sentences.join("").replace(/[，,]/gu, ""),
    script.replace(/\s+/gu, "").replace(/[，,]/gu, ""),
  );
});

test("超长正文没有真实模型时失败关闭，API模式与正token证据齐全才采用压缩稿", async () => {
  const body = "这是一段需要忠实压缩的经营正文。".repeat(40);
  await assert.rejects(
    prepareTextVideoScript({ title: "长正文", body }),
    (error) =>
      error instanceof TextVideoError &&
      error.code === "TEXT_VIDEO_COMPRESSION_UNAVAILABLE",
  );
  await assert.rejects(
    prepareTextVideoScript({
      title: "长正文",
      body,
      compressFn: async () => ({
        mode: "template",
        text: "模板草稿".repeat(30),
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    }),
    (error) => error.code === "TEXT_VIDEO_COMPRESSION_INVALID",
  );
  const compressed = await prepareTextVideoScript({
    title: "长正文",
    body,
    compressFn: async () => ({
      mode: "api",
      model: "real-model",
      text: "先看真实经营问题，不要急着堆设备。把门店最有代表性的产品、顾客场景和核心信息整理清楚，再用连续内容验证。每次发布后记录完播、咨询和到店变化，用数据决定下一条怎么改。这样投入可控，团队也能持续复用经验。",
      usage: { inputTokens: 880, outputTokens: 118 },
    }),
  });
  assert.equal(compressed.compression.mode, "api");
  assert.equal(compressed.compression.usage.inputTokens, 880);
  assert.match(compressed.script, /真实经营问题/u);
});

test("FFmpeg缺少drawtext但具备overlay时启用内置中文PNG字幕回退", async () => {
  const runner = async (_command, args) => {
    if (args.includes("-filters")) {
      return {
        code: 0,
        stdout: " scale crop concat amix aresample apad zoompan overlay ",
      };
    }
    if (args.includes("-encoders")) {
      return { code: 0, stdout: " libx264 aac " };
    }
    return { code: 0, stdout: "ffmpeg version fixture" };
  };
  const renderer = createTextVideoRenderer({
    runner,
    ffmpegPath: "/mock/ffmpeg",
    ffprobePath: "/mock/ffprobe",
    ttsFn: async () => null,
  });
  assert.equal(
    await renderer.preflight({
      tenantId: 1,
      body: "这条正文不需要压缩，服务器可以使用内置中文字体和透明PNG图层完成字幕。",
    }),
    true,
  );
});

test("FFmpeg同时缺少drawtext与overlay时仍在供应商调用前失败关闭", async () => {
  const runner = async (_command, args) => {
    if (args.includes("-filters")) {
      return {
        code: 0,
        stdout: " scale crop concat amix aresample apad zoompan ",
      };
    }
    if (args.includes("-encoders")) {
      return { code: 0, stdout: " libx264 aac " };
    }
    return { code: 0, stdout: "ffmpeg version fixture" };
  };
  const renderer = createTextVideoRenderer({
    runner,
    ffmpegPath: "/mock/ffmpeg",
    ffprobePath: "/mock/ffprobe",
    ttsFn: async () => null,
  });
  await assert.rejects(
    renderer.preflight({
      tenantId: 1,
      body: "这条正文用来验证服务器无法生成任何可用字幕时必须及时阻断。",
    }),
    (error) =>
      error instanceof TextVideoError &&
      error.code === "TEXT_VIDEO_FFMPEG_CAPABILITY_MISSING" &&
      /drawtext或overlay/u.test(error.message),
  );
});

test("无云渲染会真实生成中文PNG图层并通过FFmpeg overlay合成", async () => {
  const outputRoot = await tempRoot("nanowork-text-video-raster-");
  const ffmpegCalls = [];
  const overlayHashes = new Set();
  const runner = async (command, args) => {
    if (args.includes("-version")) {
      return { code: 0, stdout: "ffmpeg version fixture" };
    }
    if (args.includes("-filters")) {
      return {
        code: 0,
        stdout: " scale crop concat amix aresample apad zoompan overlay ",
      };
    }
    if (args.includes("-encoders")) {
      return { code: 0, stdout: " libx264 aac " };
    }
    if (String(command).includes("ffprobe")) {
      const target = String(args.at(-1));
      return {
        code: 0,
        stdout: target.endsWith("final.mp4")
          ? videoProbe({ duration: 7.2, output: true })
          : audioProbe(1.6),
      };
    }
    ffmpegCalls.push(args);
    const overlayPath = args.find((arg) =>
      /text-overlay-\d+\.png$/u.test(String(arg)),
    );
    if (overlayPath) {
      const png = await fsp.readFile(overlayPath);
      assert.equal(
        png
          .subarray(0, 8)
          .equals(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          ),
        true,
      );
      assert.equal(png.readUInt32BE(16), 1080);
      assert.equal(png.readUInt32BE(20), 1920);
      assertPrivateArtifact(overlayPath);
      overlayHashes.add(crypto.createHash("sha256").update(png).digest("hex"));
    }
    await fsp.writeFile(args.at(-1), mp4Bytes("raster-overlay-render"));
    return { code: 0, stdout: "", stderr: "" };
  };
  const renderer = createTextVideoRenderer({
    outputRoot,
    ffmpegPath: "/mock/ffmpeg",
    ffprobePath: "/mock/ffprobe",
    runner,
    ttsFn: async ({ text }) => ({
      bytes: mp3Bytes(),
      providerAttempt: {
        provider: "offline-test-double",
        model: "offline-test-voice",
        mode: "api",
        usage: {
          networkRequests: 1,
          inputCharacters: Array.from(text).length,
        },
      },
    }),
  });
  const result = await renderer.render({
    tenantId: 77,
    jobId: 8,
    title: "龘字内置中文字幕验证",
    body: "这次不依赖云端字幕服务，标题和逐句中文都由内置字体形成真实透明图层。随后交给FFmpeg叠加到竖版画面，最终产物仍然需要通过编码与媒体探测。",
    mode: "images",
    allowSolidBackground: true,
    bgm: "none",
  });
  assert.equal(result.evidence.render.textOverlayMode, "raster_png");
  assert.equal(
    result.evidence.render.subtitleFontSource,
    "bundled_noto_sans_sc_outlines",
  );
  assert.equal(overlayHashes.size, result.sentences.length);
  assert.ok(
    ffmpegCalls.some((args) =>
      args.some((arg) => String(arg).includes("overlay=0:0:format=auto")),
    ),
  );
  assert.equal(
    ffmpegCalls.some((args) =>
      args.some((arg) => String(arg).includes("drawtext=")),
    ),
    false,
  );
});

test(
  "本机缺少drawtext时用真实FFmpeg完成中文字幕竖版MP4烟测",
  { skip: !localNeedsRasterFallback, timeout: 90_000 },
  async () => {
    const outputRoot = await tempRoot("nanowork-text-video-local-ffmpeg-");
    const renderer = createTextVideoRenderer({
      outputRoot,
      ffmpegPath: localFfmpeg,
      ffprobePath: localFfprobe,
      ttsFn: async ({ text }) => ({
        bytes: wavBytes(),
        providerAttempt: {
          provider: "offline-local-smoke",
          model: "pcm-silence-fixture",
          mode: "api",
          usage: {
            networkRequests: 1,
            inputCharacters: Array.from(text).length,
          },
        },
      }),
    });
    assert.equal(
      await renderer.preflight({
        tenantId: 88,
        body: "这是本机真实媒体工具的中文字幕回退烟测正文。",
      }),
      true,
    );
    const result = await renderer.render({
      tenantId: 88,
      jobId: 9,
      title: "真实中文字幕",
      body: "这是本机真实编码烟测。中文标题与字幕先生成透明图层。然后由FFmpeg完成竖版画面和音轨合成。",
      mode: "images",
      allowSolidBackground: true,
      bgm: "none",
    });
    const stat = await fsp.stat(result.absolutePath);
    assert.ok(stat.size > 10_000);
    assert.equal(result.probe.width, 1080);
    assert.equal(result.probe.height, 1920);
    assert.equal(result.probe.videoCodec, "h264");
    assert.equal(result.probe.audioCodec, "aac");
    assert.equal(result.evidence.render.textOverlayMode, "raster_png");
  },
);

test("图片模式逐句真实TTS并用FFmpeg产出1080x1920 H264/AAC MP4", async () => {
  const outputRoot = await tempRoot("nanowork-text-video-render-");
  const inputRoot = await tempRoot("nanowork-text-video-image-");
  const image = path.join(inputRoot, "dish.jpg");
  await fsp.writeFile(image, jpegBytes());
  const calls = [];
  let bgmHeader = null;
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (String(command).includes("ffprobe")) {
      const target = String(args.at(-1));
      return {
        code: 0,
        stdout: target.endsWith("final.mp4")
          ? videoProbe({ duration: 9.6, output: true })
          : audioProbe(2.1),
      };
    }
    const loopIndex = args.indexOf("-stream_loop");
    if (loopIndex >= 0) {
      const bgmInput = args[loopIndex + 3];
      bgmHeader = (await fsp.readFile(bgmInput))
        .subarray(0, 12)
        .toString("ascii");
    }
    await fsp.writeFile(args.at(-1), mp4Bytes(path.basename(args.at(-1))));
    return { code: 0, stdout: "", stderr: "" };
  };
  const ttsCalls = [];
  const renderer = createTextVideoRenderer({
    outputRoot,
    ffmpegPath: "/mock/ffmpeg",
    ffprobePath: "/mock/ffprobe",
    runner,
    mediaPreflightFn: async () => true,
    ttsFn: async ({ text }) => {
      ttsCalls.push(text);
      return {
        bytes: mp3Bytes(),
        providerAttempt: {
          provider: "yunwu-minimax",
          model: "speech-2.8-hd",
          mode: "api",
          usage: {
            networkRequests: 1,
            inputCharacters: Array.from(text).length,
          },
        },
      };
    },
  });
  const steps = [];
  const result = await renderer.render({
    tenantId: 42,
    jobId: 9,
    title: "招牌菜的真实故事",
    body: "很多人第一次进店，会先问这道招牌菜为什么值得点。答案不在夸张口号，而在每天看得见的选料、火候和出品。把这些真实细节讲清楚，顾客自然知道自己为什么来。",
    mode: "images",
    imagePaths: [{ path: image }],
    voiceId: "presenter_female",
    bgm: "warm",
    onStep: (step) => steps.push(step),
  });
  assert.equal(ttsCalls.length, result.sentences.length);
  assert.ok(ttsCalls.length >= 3);
  assert.equal(result.probe.width, 1080);
  assert.equal(result.probe.height, 1920);
  assert.equal(result.probe.videoCodec, "h264");
  assert.equal(result.probe.audioCodec, "aac");
  assert.equal(result.evidence.realDelivery, true);
  assert.equal(result.evidence.template, false);
  assert.equal(result.evidence.render.kenBurns, true);
  assert.equal(result.evidence.tts.networkRequests, result.sentences.length);
  assert.equal((await fsp.stat(result.absolutePath)).isFile(), true);
  const ffmpegCalls = calls.filter((call) =>
    String(call.command).includes("ffmpeg"),
  );
  assert.equal(ffmpegCalls.length, result.sentences.length + 1);
  assert.ok(ffmpegCalls.some((call) => call.args.includes("libx264")));
  assert.ok(ffmpegCalls.some((call) => call.args.includes("aac")));
  assert.ok(
    ffmpegCalls.some((call) =>
      call.args.some((arg) => String(arg).includes("zoompan=")),
    ),
  );
  assert.ok(ffmpegCalls.at(-1).args.includes("-stream_loop"));
  assert.ok(
    ffmpegCalls.at(-1).args.some((arg) => String(arg).endsWith("bgm-warm.wav")),
  );
  assert.equal(
    result.evidence.render.bgmSource,
    "server_generated_pcm_chord_loop",
  );
  assert.equal(bgmHeader?.slice(0, 4), "RIFF");
  assert.equal(bgmHeader?.slice(8, 12), "WAVE");
  assert.ok(steps.some((step) => step.phase === "tts"));
  assert.ok(steps.some((step) => step.phase === "finalize"));
});

test("无图片默认失败；只有显式允许纯色背景才继续，clips模式必须使用真实租户片段", async () => {
  const outputRoot = await tempRoot("nanowork-text-video-modes-");
  const inputRoot = await tempRoot("nanowork-text-video-clips-");
  const clip = path.join(inputRoot, "store.mp4");
  await fsp.writeFile(clip, mp4Bytes("tenant-clip"));
  const runner = async (command, args) => {
    if (String(command).includes("ffprobe")) {
      const target = String(args.at(-1));
      if (target === clip)
        return { code: 0, stdout: videoProbe({ duration: 18 }) };
      if (target.endsWith("final.mp4")) {
        return { code: 0, stdout: videoProbe({ duration: 8, output: true }) };
      }
      return { code: 0, stdout: audioProbe(2) };
    }
    await fsp.writeFile(args.at(-1), mp4Bytes("rendered"));
    return { code: 0 };
  };
  const renderer = createTextVideoRenderer({
    outputRoot,
    ffmpegPath: "/mock/ffmpeg",
    ffprobePath: "/mock/ffprobe",
    runner,
    mediaPreflightFn: async () => true,
    ttsFn: async ({ text }) => ({
      bytes: mp3Bytes(),
      providerAttempt: {
        mode: "api",
        provider: "yunwu-minimax",
        model: "speech-2.8-hd",
        usage: { networkRequests: 1, inputCharacters: Array.from(text).length },
      },
    }),
  });
  const body =
    "今天不靠夸张滤镜，只把门店里真实发生的备料、出锅和服务过程讲给你听。看得见的细节，比空泛口号更有说服力。";
  await assert.rejects(
    renderer.render({ tenantId: 1, jobId: 1, body, mode: "images" }),
    (error) => error.code === "TEXT_VIDEO_IMAGES_REQUIRED",
  );
  const solid = await renderer.render({
    tenantId: 1,
    jobId: 2,
    title: "真实经营",
    body,
    mode: "images",
    allowSolidBackground: true,
    bgm: "none",
  });
  assert.equal(solid.evidence.solidBackgroundExplicit, true);
  const clips = await renderer.render({
    tenantId: 1,
    jobId: 3,
    title: "门店混剪",
    body,
    mode: "clips",
    clipPaths: [{ path: clip }],
  });
  assert.equal(clips.evidence.mode, "clips");
  assert.equal(clips.evidence.clipCount, 1);
  assert.equal(clips.evidence.render.kenBurns, false);
});

function successfulRenderFactory(root, state) {
  return async ({ tenantId, jobId, body }) => {
    if (state.failNext) {
      state.failNext = false;
      throw Object.assign(new Error("injected render failure"), {
        code: "TEXT_VIDEO_MEDIA_COMMAND_FAILED",
        status: 502,
      });
    }
    const directory = path.join(root, String(tenantId));
    await fsp.mkdir(directory, { recursive: true });
    const fileName = `job-${jobId}-${crypto.randomBytes(5).toString("hex")}.mp4`;
    const absolutePath = path.join(directory, fileName);
    const bytes = mp4Bytes(`job-${jobId}`);
    await fsp.writeFile(absolutePath, bytes);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    return {
      script: body,
      sentences: [body],
      absolutePath,
      fileName,
      fileUrl: `/uploads/files/${tenantId}/text-video-output/${fileName}`,
      mimeType: "video/mp4",
      byteSize: bytes.length,
      sha256,
      probe: {
        duration: 12,
        width: 1080,
        height: 1920,
        videoCodec: "h264",
        audioCodec: "aac",
      },
      evidence: {
        schemaVersion: "nanowork.text-video-render-evidence/1",
        realDelivery: true,
        template: false,
        sentenceCount: 1,
        usage: {
          networkRequests: 1,
          inputTokens: 0,
          outputTokens: 0,
          ttsCharacters: Array.from(body).length,
          ffmpegSegments: 1,
        },
        cost: {
          amount: 12,
          currency: "CNY",
          pricingMode: "configured_verified_output_flat_rate",
        },
      },
    };
  };
}

async function waitUntil(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`${label}未在预期时间内发生`);
}

test("后台任务两阶段预授权：产物先落库再结算；失败全退且有限免费重试", async () => {
  const root = await tempRoot("nanowork-text-video-service-");
  const state = { failNext: false };
  const renderer = {
    preflight: async () => true,
    render: successfulRenderFactory(root, state),
  };
  const service = createTextVideoJobService({ renderer, concurrency: 1 });
  const body =
    "这是一条真实成片任务，它会先完成配音与编码证据，再把MP4写入租户文件库，最后才结算预授权积分。";
  const created = await runWithTenant(tenantId, () =>
    service.createJob({
      user,
      title: "两阶段交付测试",
      body,
      mode: "images",
      allowSolidBackground: true,
    }),
  );
  assert.equal(created.status, "queued");
  assert.equal(created.billing.state, "held");
  const done = await service.runJob(created.id, tenantId);
  assert.equal(done.status, "done");
  assert.equal(done.billing.state, "settled");
  assert.equal(done.businessUsable, true);
  assert.match(done.outputUrl, /^\/uploads\/files\//u);
  const stored = q.get(
    "SELECT * FROM uploaded_files WHERE tenant_id=? AND id=?",
    tenantId,
    q.get(
      "SELECT output_file_id FROM text_video_jobs WHERE tenant_id=? AND id=?",
      tenantId,
      created.id,
    ).output_file_id,
  );
  assert.ok(stored);
  assert.equal(stored.purpose, "text-video-output");

  state.failNext = true;
  const failedCreated = await runWithTenant(tenantId, () =>
    service.createJob({
      user,
      title: "失败退款测试",
      body,
      mode: "images",
      allowSolidBackground: true,
    }),
  );
  const failed = await service.runJob(failedCreated.id, tenantId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.billing.state, "released");
  assert.equal(failed.outputUrl, null);
  assert.equal(failed.retryable, true);
  const retried = await runWithTenant(tenantId, () =>
    service.retryJob(user, failed.id),
  );
  assert.equal(retried.status, "queued");
  assert.equal(retried.billing.state, "not_required");
  assert.equal(retried.retryCount, 1);
  const retryDone = await service.runJob(retried.id, tenantId);
  assert.equal(retryDone.status, "done");
  assert.equal(retryDone.billing.state, "not_required");
  assert.equal(retryDone.businessUsable, true);
});

test("ImageHunt素材必须是本租户已落地图片且商用授权证据完整", async () => {
  const root = await tempRoot("nanowork-text-video-material-");
  const uploaded = await runWithTenant(tenantId, () =>
    saveTextVideoAsset({
      user,
      kind: "image",
      name: "licensed-dish.jpg",
      mime: "image/jpeg",
      b64: jpegBytes().toString("base64"),
    }),
  );
  q.run(
    "UPDATE uploaded_files SET purpose='imagehunt' WHERE tenant_id=? AND id=?",
    tenantId,
    uploaded.id,
  );
  const artifact = {
    schemaVersion: "nanowork.imagehunt-material/1",
    fileId: uploaded.id,
    fileUrl: uploaded.url,
    mimeType: "image/jpeg",
    rights: {
      confirmed: true,
      commercialUse: true,
      license: "测试租户自有拍摄授权",
      confirmedBy: user.id,
    },
  };
  const inserted = await runWithTenant(tenantId, () =>
    q.run(
      `INSERT INTO materials(name,type,url,source_type,creator_id,artifact_snapshot_json)
       VALUES(?, '图片', ?, 'imagehunt', ?, ?)`,
      "已核权门店实拍",
      uploaded.url,
      user.id,
      JSON.stringify(artifact),
    ),
  );
  const materialId = Number(inserted.lastInsertRowid);
  const listed = await runWithTenant(tenantId, () =>
    listTextVideoLicensedMaterials(user),
  );
  assert.ok(listed.some((item) => item.id === materialId));

  let resolvedImages = [];
  const successful = successfulRenderFactory(root, { failNext: false });
  const service = createTextVideoJobService({
    renderer: {
      preflight: async () => true,
      render: async (input) => {
        resolvedImages = input.imagePaths;
        return successful(input);
      },
    },
  });
  const created = await runWithTenant(tenantId, () =>
    service.createJob({
      user,
      title: "已授权素材成片",
      body: "这条成片只使用本租户已落地的门店实拍图片，并且在合成前再次核验商用授权、文件完整性与租户边界。",
      materialIds: [materialId],
    }),
  );
  const done = await service.runJob(created.id, tenantId);
  assert.equal(done.status, "done");
  assert.equal(resolvedImages.length, 1);
  assert.equal(resolvedImages[0].materialId, materialId);
  assert.equal(resolvedImages[0].rights.commercialUse, true);

  const invalidMaterial = await runWithTenant(tenantId, () =>
    q.run(
      `INSERT INTO materials(name,type,url,source_type,creator_id,artifact_snapshot_json)
       VALUES(?, '图片', ?, 'imagehunt', ?, ?)`,
      "未核权门店实拍",
      uploaded.url,
      user.id,
      JSON.stringify({ ...artifact, rights: { confirmed: false } }),
    ),
  );
  const invalidMaterialId = Number(invalidMaterial.lastInsertRowid);
  await assert.rejects(
    runWithTenant(tenantId, () =>
      service.createJob({
        user,
        title: "未授权素材应阻断",
        body: "一旦图片的商用授权证据被撤销或损坏，新的成片任务必须在预授权和任何供应商调用之前停止。",
        materialIds: [invalidMaterialId],
      }),
    ),
    (error) => error.code === "TEXT_VIDEO_MATERIAL_RIGHTS_INVALID",
  );
});

test("取消排队任务即时全退；重启恢复中断running任务也全退并可免费重试", async () => {
  const root = await tempRoot("nanowork-text-video-cancel-");
  const renderer = {
    preflight: async () => true,
    render: successfulRenderFactory(root, { failNext: false }),
  };
  const service = createTextVideoJobService({ renderer, concurrency: 1 });
  const body =
    "排队任务被取消时不能继续调用配音或媒体工具，预授权必须立刻全额退回并保持不可交付状态。";
  const created = await runWithTenant(tenantId, () =>
    service.createJob({
      user,
      title: "取消退款测试",
      body,
      allowSolidBackground: true,
    }),
  );
  const cancelled = await runWithTenant(tenantId, () =>
    service.cancelJob(user, created.id),
  );
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.billing.state, "released");

  const interrupted = await runWithTenant(tenantId, () =>
    service.createJob({
      user,
      title: "重启恢复测试",
      body,
      allowSolidBackground: true,
    }),
  );
  q.run(
    "UPDATE text_video_jobs SET status='running',started_at=datetime('now','-1 hour') WHERE tenant_id=? AND id=?",
    tenantId,
    interrupted.id,
  );
  const report = service.recoverTenant(tenantId);
  assert.ok(
    report.some(
      (entry) =>
        entry.id === interrupted.id && entry.action === "released_interrupted",
    ),
  );
  const recovered = await runWithTenant(tenantId, () =>
    service.getJob(user, interrupted.id),
  );
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.billing.state, "released");
  assert.equal(recovered.retryable, true);
});

test("并发渲染严格不超过配置槽位，其余真实保持queued等待", async () => {
  const root = await tempRoot("nanowork-text-video-concurrency-");
  const successful = successfulRenderFactory(root, { failNext: false });
  const releases = [];
  let rendering = 0;
  let peak = 0;
  const renderer = {
    preflight: async () => true,
    render: async (input) => {
      rendering += 1;
      peak = Math.max(peak, rendering);
      await new Promise((resolve) => releases.push(resolve));
      try {
        return await successful(input);
      } finally {
        rendering -= 1;
      }
    },
  };
  const service = createTextVideoJobService({ renderer, concurrency: 2 });
  const jobs = [];
  for (let index = 0; index < 3; index += 1) {
    jobs.push(
      await runWithTenant(tenantId, () =>
        service.createJob({
          user,
          title: `并发槽位测试${index + 1}`,
          body: `第${index + 1}条真实成片任务用于验证本机最多只有两个渲染槽位同时执行，其余任务必须排队。`,
          allowSolidBackground: true,
        }),
      ),
    );
  }
  const running = jobs.map((job) => service.runJob(job.id, tenantId));
  await waitUntil(
    () => releases.length === 2 && service.waitingCount() === 1,
    "并发两槽位加一等待队列",
  );
  assert.equal(service.activeCount(), 2);
  assert.equal(peak, 2);
  releases.shift()();
  await waitUntil(() => releases.length === 2, "等待任务进入空闲槽位");
  for (const release of releases.splice(0)) release();
  const completed = await Promise.all(running);
  assert.equal(
    completed.every((job) => job.status === "done"),
    true,
  );
  assert.equal(peak, 2);
});

test("硬超时不信任渲染器的AbortSignal配合，超时后立即失败全退", async () => {
  const renderer = {
    preflight: async () => true,
    render: async () => new Promise(() => {}),
  };
  const service = createTextVideoJobService({
    renderer,
    concurrency: 1,
    hardTimeoutMs: 1_000,
  });
  const created = await runWithTenant(tenantId, () =>
    service.createJob({
      user,
      title: "强制硬超时测试",
      body: "即使注入的异常渲染器完全忽略取消信号，后台任务也必须在硬时限到达后停止等待并退回全部预授权。",
      allowSolidBackground: true,
    }),
  );
  const started = Date.now();
  const failed = await service.runJob(created.id, tenantId);
  const elapsed = Date.now() - started;
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "TEXT_VIDEO_HARD_TIMEOUT");
  assert.equal(failed.billing.state, "released");
  assert.ok(elapsed >= 900 && elapsed < 2_500, `elapsed=${elapsed}`);
  assert.equal(service.activeCount(), 0);
});

after(async () => {
  for (const root of roots) {
    await fsp.rm(root, { recursive: true, force: true });
  }
  if (tenantId) {
    const rows = q.all(
      "SELECT file_path FROM uploaded_files WHERE tenant_id=?",
      tenantId,
    );
    for (const row of rows) {
      await fsp.rm(row.file_path, { force: true }).catch(() => {});
    }
    for (const table of [
      "credit_holds",
      "credit_logs",
      "text_video_jobs",
      "uploaded_files",
      "users",
      "tenants",
    ]) {
      try {
        q.run(`DELETE FROM ${table} WHERE tenant_id=?`, tenantId);
      } catch {
        // credit_holds may not exist in a freshly initialized test database.
      }
    }
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
});
