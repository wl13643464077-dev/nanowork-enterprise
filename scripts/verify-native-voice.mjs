#!/usr/bin/env node
// Inspect existing local media only. No provider calls, database access or media writes.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  resolveFfmpeg,
  resolveFfprobe,
} from "../server/src/engines/media-binaries.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sampleRate = 16000;
const windowSeconds = 10;
const threshold = 0.98;

export function nativeVoiceLayout(snapshot) {
  const durationSeconds = snapshot.durationSeconds ?? 30;
  if (![15, 30].includes(durationSeconds))
    throw new Error("回执时长必须为15或30秒");
  const segmentCount = durationSeconds / 15;
  if (snapshot.segmentCount !== segmentCount)
    throw new Error(
      `${durationSeconds}秒回执的 segmentCount 必须为 ${segmentCount}`,
    );
  const indices = Array.from({ length: segmentCount }, (_, index) => index + 1);
  return {
    durationSeconds,
    segmentCount,
    indices,
    expectedSegmentStartSeconds: indices.map((index) => (index - 1) * 15),
    sourceWindowsSeconds: indices.map(() => [1, 11]),
    finalWindowsSeconds: indices.map((index) => [
      1 + (index - 1) * 15,
      11 + (index - 1) * 15,
    ]),
  };
}

function run(binary, args) {
  const result = spawnSync(binary, args, {
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    // Do not copy media metadata or arbitrary stderr into the public evidence report.
    throw new Error(
      `${path.basename(binary)} 本地核验失败（${result.error?.code || result.status}）`,
    );
  }
  return result.stdout;
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function localVideo(url) {
  if (typeof url !== "string" || /[?#]/u.test(url))
    throw new Error("媒体地址必须是无查询参数的本地上传路径");
  let decoded;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    throw new Error("媒体路径编码无效");
  }
  if (
    !/^\/uploads\/ai-sales-video\/[1-9]\d*\/[A-Za-z0-9_-]+\.mp4$/u.test(decoded)
  ) {
    throw new Error("媒体不在受管的本地带货视频目录");
  }
  const storage = await fsp.realpath(
    path.join(repo, "server/data/uploads/ai-sales-video"),
  );
  const file = await fsp.realpath(
    path.join(repo, "server/data", decoded.slice(1)),
  );
  const relative = path.relative(storage, file);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !(await fsp.stat(file)).isFile()
  ) {
    throw new Error("媒体路径越出受管视频目录或不是文件");
  }
  return file;
}

function probe(file, ffprobe) {
  const data = JSON.parse(
    run(ffprobe, [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-f",
      "mov",
      "-show_entries",
      "format=duration:stream=index,codec_type,codec_name,sample_rate,channels,duration,width,height",
      "-of",
      "json",
      file,
    ]).toString("utf8"),
  );
  const streams = Array.isArray(data.streams) ? data.streams : [];
  return {
    durationSeconds: Number(data.format?.duration) || null,
    video: streams
      .filter((stream) => stream.codec_type === "video")
      .map((stream) => ({
        codec: stream.codec_name,
        width: stream.width,
        height: stream.height,
      })),
    audio: streams
      .filter((stream) => stream.codec_type === "audio")
      .map((stream) => ({
        index: stream.index,
        codec: stream.codec_name,
        sampleRate: Number(stream.sample_rate),
        channels: stream.channels,
        durationSeconds: Number(stream.duration) || null,
      })),
  };
}

function pcm(file, startSeconds, ffmpeg) {
  return run(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-protocol_whitelist",
    "file,pipe",
    "-ss",
    String(startSeconds),
    "-f",
    "mov",
    "-i",
    file,
    "-t",
    String(windowSeconds),
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-c:a",
    "pcm_f32le",
    "-f",
    "f32le",
    "pipe:1",
  ]);
}

// Two-pass Pearson correlation; no alignment search, gain adjustment or numpy.
export function comparePcm(source, final) {
  if (
    source.length !== final.length ||
    source.length % 4 !== 0 ||
    source.length < 8
  ) {
    throw new Error("两个 PCM 窗口采样数不同或无效，不能比较");
  }
  const count = source.length / 4;
  let sourceSum = 0,
    finalSum = 0,
    sourcePower = 0,
    finalPower = 0,
    errorPower = 0;
  for (let i = 0; i < count; i += 1) {
    const a = source.readFloatLE(i * 4),
      b = final.readFloatLE(i * 4);
    if (!Number.isFinite(a) || !Number.isFinite(b))
      throw new Error("PCM 含有无效采样");
    sourceSum += a;
    finalSum += b;
    sourcePower += a * a;
    finalPower += b * b;
    errorPower += (a - b) ** 2;
  }
  const sourceMean = sourceSum / count,
    finalMean = finalSum / count;
  let covariance = 0,
    sourceVariance = 0,
    finalVariance = 0;
  for (let i = 0; i < count; i += 1) {
    const a = source.readFloatLE(i * 4) - sourceMean,
      b = final.readFloatLE(i * 4) - finalMean;
    covariance += a * b;
    sourceVariance += a * a;
    finalVariance += b * b;
  }
  if (sourceVariance === 0 || finalVariance === 0)
    throw new Error("PCM 窗口静音或恒定，无法证明原声保留");
  const correlation = covariance / Math.sqrt(sourceVariance * finalVariance);
  if (!Number.isFinite(correlation)) throw new Error("PCM 相关系数不可用");
  return {
    sampleCount: count,
    sameTimePcmCorrelation: correlation,
    sourceRmsDb: 10 * Math.log10(sourcePower / count),
    finalRmsDb: 10 * Math.log10(finalPower / count),
    rmsErrorVsSourceDb:
      errorPower === 0 ? null : 10 * Math.log10(errorPower / sourcePower),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "node scripts/verify-native-voice.mjs --case=retest|native-voice|duration15\n只读取已有媒体并写入对应 sales/原生声音核验.json；不联网、不生成、不改数据库。",
    );
    return;
  }
  const selectedCase =
    args.length === 1
      ? args[0].match(/^--case=(retest|native-voice|duration15)$/u)?.[1]
      : null;
  if (!selectedCase)
    throw new Error(
      "参数必须为 --case=retest、--case=native-voice 或 --case=duration15",
    );
  const directory = path.join(
    repo,
    "artifacts/native-chat-live-2026-09-06",
    selectedCase,
    "sales",
  );
  const input = path.join(directory, "06-最终结果.json");
  const output = path.join(directory, "原生声音核验.json");
  // A missing case must not create a directory or overwrite unrelated evidence.
  await fsp.access(input);
  const report = {
    verifiedAt: new Date().toISOString(),
    case: selectedCase,
    status: "failed",
    analysisOnly: true,
    providerCalls: 0,
    databaseAccess: false,
    mediaWrites: false,
    snapshotFile: path.relative(repo, input),
    snapshotSha256: await sha256(input),
    method: {
      format: "mono 16000 Hz PCM float32 little-endian",
      sampleRate,
      windowSeconds,
      correlation: "Pearson",
      passCondition: "sameTimePcmCorrelation > 0.98",
      alignmentSearch: false,
      expectedSegmentStartSeconds: [],
      sourceWindowsSeconds: [],
      finalWindowsSeconds: [],
    },
    limitation:
      "这里只核验文件身份、音轨和对应时长的固定窗口波形相关性，支持成片保留供应商原声的判断；不等于听感、普通话发音、说话人身份或逐字 ASR 验收通过，未进行人工听辨，也未核验整段音轨及衔接边界。字幕仍按脚本估时。",
    checks: [],
    media: [],
    comparisons: [],
    errors: [],
  };
  const check = (name, passed, observed) =>
    report.checks.push({ name, passed, observed });
  const inspected = [];
  try {
    const record = JSON.parse(await fsp.readFile(input, "utf8"));
    const snapshot = record.snapshot;
    if (!snapshot || typeof snapshot !== "object")
      throw new Error("缺少 snapshot 核验回执");
    const layout = nativeVoiceLayout(snapshot);
    const { durationSeconds, segmentCount, indices } = layout;
    report.durationSeconds = durationSeconds;
    report.segmentCount = segmentCount;
    report.method.expectedSegmentStartSeconds =
      layout.expectedSegmentStartSeconds;
    report.method.sourceWindowsSeconds = layout.sourceWindowsSeconds;
    report.method.finalWindowsSeconds = layout.finalWindowsSeconds;
    check("目标时长与回执段数一致", true, {
      durationSeconds,
      segmentCount: snapshot.segmentCount,
    });
    report.jobId = record.final?.id ?? record.row?.id ?? null;
    report.model = snapshot.model;
    report.audioMode = snapshot.audioMode;
    check(
      "snapshot.model 为 wan2.6-i2v",
      snapshot.model === "wan2.6-i2v",
      snapshot.model,
    );
    check(
      "snapshot.audioMode 为 provider_native",
      snapshot.audioMode === "provider_native",
      snapshot.audioMode,
    );
    check(
      "result.audioSource 为 provider_native",
      snapshot.result?.audioSource === "provider_native",
      snapshot.result?.audioSource ?? null,
    );
    check("voiceTracks 字段不存在", !Object.hasOwn(snapshot, "voiceTracks"), {
      fieldPresent: Object.hasOwn(snapshot, "voiceTracks"),
    });
    const events = Array.isArray(snapshot.paidExecution)
      ? snapshot.paidExecution
      : [];
    const videos = events.filter((event) => event.kind === "video");
    const ttsCount = events.filter((event) => event.kind === "tts").length;
    report.paidExecution = events.map((event) => ({
      kind: event.kind,
      model: event.model,
      index: event.index,
      status: event.status,
    }));
    check(
      `paidExecution 有记录、无 TTS、恰好${segmentCount}次视频调用`,
      Array.isArray(snapshot.paidExecution) &&
        videos.length === segmentCount &&
        ttsCount === 0,
      { videoCount: videos.length, ttsCount },
    );
    check(
      `${segmentCount}次视频调用均使用 wan2.6-i2v，段序为${indices.join("、")}`,
      videos.length === segmentCount &&
        videos.every((event) => event.model === "wan2.6-i2v") &&
        videos
          .map((event) => event.index)
          .sort()
          .join(",") === indices.join(","),
      videos.map((event) => ({ model: event.model, index: event.index })),
    );
    const partials = Array.isArray(snapshot.partialResults)
      ? [...snapshot.partialResults].sort((a, b) => a.index - b.index)
      : [];
    if (
      partials.length !== segmentCount ||
      partials.some((partial, index) => partial.index !== indices[index]) ||
      !snapshot.result
    ) {
      throw new Error(
        `须同时具备${segmentCount}段原片回执和完整成片 result，当前不能完成原声核验`,
      );
    }
    const ffmpeg = resolveFfmpeg(),
      ffprobe = resolveFfprobe();
    if (!ffmpeg || !ffprobe)
      throw new Error("缺少本地 ffmpeg/ffprobe，请安装或设置对应环境变量");
    report.tools = { ffmpeg, ffprobe };
    for (const [index, receipt] of [...partials, snapshot.result].entries()) {
      const label = index < segmentCount ? `原片第${index + 1}段` : "完整成片";
      const file = await localVideo(receipt.url);
      const hash = await sha256(file);
      const metadata = probe(file, ffprobe);
      inspected.push({ file, hash });
      const item = {
        label,
        file: path.relative(repo, file),
        sha256: hash,
        expectedSha256: receipt.sha256,
        bytes: (await fsp.stat(file)).size,
        ...metadata,
      };
      report.media.push(item);
      check(
        `${label} SHA-256 与回执一致`,
        /^[a-f0-9]{64}$/u.test(receipt.sha256 || "") && hash === receipt.sha256,
        { sha256: hash, expectedSha256: receipt.sha256 ?? null },
      );
      check(
        `${label} 有视频和音轨`,
        metadata.video.length > 0 && metadata.audio.length > 0,
        {
          videoCount: metadata.video.length,
          audioCount: metadata.audio.length,
        },
      );
      const nominalDuration = index < segmentCount ? 15 : durationSeconds;
      check(
        `${label} 时长与回执及${nominalDuration}秒目标相符`,
        Number.isFinite(receipt.durationSeconds) &&
          metadata.durationSeconds > 0 &&
          Math.abs(metadata.durationSeconds - receipt.durationSeconds) <=
            0.25 &&
          Math.abs(metadata.durationSeconds - nominalDuration) <= 0.25,
        {
          actualSeconds: metadata.durationSeconds,
          receiptSeconds: receipt.durationSeconds ?? null,
          toleranceSeconds: 0.25,
        },
      );
      if (index < segmentCount)
        check(
          `${label} 回执为 provider_native`,
          receipt.audioSource === "provider_native",
          receipt.audioSource ?? null,
        );
      if (Number.isFinite(receipt.bytes))
        check(`${label} 字节数与回执一致`, item.bytes === receipt.bytes, {
          actual: item.bytes,
          expected: receipt.bytes,
        });
    }
    for (let index = 0; index < segmentCount; index += 1) {
      const source = pcm(inspected[index].file, 1, ffmpeg);
      const final = pcm(inspected[segmentCount].file, 1 + 15 * index, ffmpeg);
      const metrics = comparePcm(source, final);
      const fullWindow = metrics.sampleCount === sampleRate * windowSeconds;
      report.comparisons.push({
        segment: index + 1,
        sourceWindowSeconds: [1, 11],
        finalWindowSeconds: [1 + 15 * index, 11 + 15 * index],
        ...metrics,
        passed: fullWindow && metrics.sameTimePcmCorrelation > threshold,
      });
      check(
        `第${index + 1}段固定窗口完整且相关系数 > ${threshold}`,
        fullWindow && metrics.sameTimePcmCorrelation > threshold,
        metrics,
      );
    }
  } catch (error) {
    report.errors.push(error.message);
  }
  for (const { file, hash } of inspected) {
    try {
      check(
        "核验期间媒体文件未变化",
        (await sha256(file)) === hash,
        path.relative(repo, file),
      );
    } catch {
      check("核验期间媒体文件未变化", false, path.relative(repo, file));
    }
  }
  check(
    "核验期间原始回执未变化",
    (await sha256(input)) === report.snapshotSha256,
    report.snapshotFile,
  );
  report.sameSourceEvidence =
    report.segmentCount > 0 &&
    report.comparisons.length === report.segmentCount &&
    report.comparisons.every((item) => item.passed);
  report.status =
    report.errors.length === 0 &&
    report.checks.every((item) => item.passed) &&
    report.sameSourceEvidence
      ? "passed"
      : "failed";
  await fsp.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        output,
        status: report.status,
        correlations: report.comparisons.map(
          (item) => item.sameTimePcmCorrelation,
        ),
        failedChecks: report.checks
          .filter((item) => !item.passed)
          .map((item) => item.name),
        errors: report.errors,
      },
      null,
      2,
    ),
  );
  if (report.status !== "passed") process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
