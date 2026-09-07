import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

process.env.NANOWORK_DB = ":memory:";
process.env.YUNWU_API_KEY = "";
const { renderPlainSubtitleOverlayPng } =
  await import("../src/engines/text-video.js");
const { resolveFfmpeg } = await import("../src/engines/media-binaries.js");
const execFileAsync = promisify(execFile);
const WIDTH = 1080;
const HEIGHT = 1920;

async function pixelsFor(text) {
  const directory = await fsp.mkdtemp(
    path.join(os.tmpdir(), "nw-subtitle-legibility-"),
  );
  const destination = path.join(directory, "subtitle.png");
  try {
    await renderPlainSubtitleOverlayPng({ text, destination });
    const { stdout } = await execFileAsync(
      resolveFfmpeg(),
      [
        "-v",
        "error",
        "-i",
        destination,
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgba",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 20_000 },
    );
    assert.equal(stdout.length, WIDTH * HEIGHT * 4);
    return stdout;
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

function ink(
  pixels,
  { left = 0, top = 0, width = WIDTH, height = HEIGHT } = {},
) {
  let white = 0,
    dark = 0,
    opaque = 0;
  for (let y = top; y < top + height; y++) {
    for (let x = left; x < left + width; x++) {
      const i = (y * WIDTH + x) * 4;
      if (pixels[i + 3] <= 160) continue;
      opaque++;
      if (pixels[i] > 230 && pixels[i + 1] > 230 && pixels[i + 2] > 230)
        white++;
      if (pixels[i] < 70 && pixels[i + 1] < 70 && pixels[i + 2] < 70) dark++;
    }
  }
  return { white, dark, opaque, whiteShare: white / (white + dark) };
}

test("中文字幕逐字保留完整白色笔画与细黑边，描边不能吃掉字心", async () => {
  const text = "锅边咕嘟冒泡。";
  const pixels = await pixelsFor(text);
  // Full-width Chinese glyphs at 62 px occupy independent cells. Inspect each
  // of the six actual characters, not a total bright-pixel count that could be
  // satisfied by punctuation or one remaining white stroke.
  const left = (WIDTH - [...text].length * 62) / 2;
  for (const [index, character] of [...text].slice(0, 6).entries()) {
    const measured = ink(pixels, {
      left: left + index * 62,
      top: 1560,
      width: 62,
      height: 110,
    });
    assert.ok(
      measured.white > 800,
      `${character}需要连续可读的白色笔画：${JSON.stringify(measured)}`,
    );
    assert.ok(
      measured.dark > 150,
      `${character}仍需要黑色边缘保证复杂背景下的对比`,
    );
    assert.ok(
      measured.whiteShare > 0.55,
      `${character}不能以黑色描边为主体：${JSON.stringify(measured)}`,
    );
  }
  assert.equal(
    ink(pixels, { top: 0, height: 1400 }).opaque,
    0,
    "不增加背景色块或上移遮挡画面",
  );
  assert.equal(
    ink(pixels, { top: 1710, height: 210 }).opaque,
    0,
    "字幕保留底部安全距离",
  );
});

test("两行完整中文字幕都以白色笔画为主体，第二行不得丢失", async () => {
  const first = "附近聚餐想吃热辣鲜香的火锅";
  const second = "今天和朋友一起到店慢慢选择";
  assert.equal([...first].length, 13);
  assert.equal([...second].length, 13);
  const pixels = await pixelsFor(first + second);
  for (const [index, top] of [1478, 1564].entries()) {
    const measured = ink(pixels, { top, height: 82 });
    assert.ok(
      measured.white > 9000,
      `第${index + 1}行文字未完整绘制：${JSON.stringify(measured)}`,
    );
    assert.ok(measured.dark > 1000, `第${index + 1}行缺少可见黑边`);
    assert.ok(
      measured.whiteShare > 0.55,
      `第${index + 1}行描边过重：${JSON.stringify(measured)}`,
    );
  }
});
