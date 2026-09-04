// media-binaries 统一可执行文件解析器的回归测试。
// 背景：launchd 启动的服务 PATH 只有 /usr/local/bin:/usr/bin:/bin，
// 解析器必须能兜底探测到 Homebrew 的 ffmpeg/ffprobe，并且失败时返回
// null（不抛异常），由调用方给出可操作的中文错误。
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

process.env.NANOWORK_TEST_TEMPLATE_AI = "1";

const {
  missingMediaBinaryMessage,
  resetMediaBinaryCache,
  resolveFfmpeg,
  resolveFfprobe,
} = await import("../src/engines/media-binaries.js");

const roots = [];

async function tempRoot(prefix) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

// 保存/恢复环境变量，避免用例之间以及对同进程其他测试互相污染。
function withEnv(overrides, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetMediaBinaryCache();
  try {
    return run();
  } finally {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetMediaBinaryCache();
  }
}

after(async () => {
  for (const root of roots) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("本机能解析出真实存在的 ffprobe/ffmpeg 绝对路径", () => {
  withEnv({ FFMPEG_PATH: undefined, FFPROBE_PATH: undefined }, () => {
    const ffprobe = resolveFfprobe();
    assert.ok(ffprobe, "本机已安装 ffprobe，解析器不应返回 null");
    assert.ok(path.isAbsolute(ffprobe), "解析结果必须是绝对路径");
    assert.ok(fs.existsSync(ffprobe), "解析出的 ffprobe 路径必须真实存在");

    const ffmpeg = resolveFfmpeg();
    assert.ok(ffmpeg, "本机已安装 ffmpeg，解析器不应返回 null");
    assert.ok(fs.existsSync(ffmpeg), "解析出的 ffmpeg 路径必须真实存在");
  });
});

test("FFPROBE_PATH 环境变量指向可执行文件时优先生效", async () => {
  const root = await tempRoot("nanowork-media-binaries-env-");
  const custom = path.join(root, "ffprobe");
  // 内容无所谓，解析器只校验"存在且可执行"，不真正运行它。
  await fsp.writeFile(custom, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  withEnv({ FFPROBE_PATH: custom }, () => {
    assert.equal(resolveFfprobe(), custom);
  });
});

test("环境变量指向不存在的路径且探测目录为空时返回 null 而不抛异常", async () => {
  const emptyDir = await tempRoot("nanowork-media-binaries-empty-");
  const resolved = resolveFfprobe({
    env: { FFPROBE_PATH: "/definitely/not/exists/ffprobe", PATH: "" },
    directories: [emptyDir],
  });
  assert.equal(resolved, null);

  // 连探测目录都没有时同样安静地返回 null。
  const resolvedNone = resolveFfmpeg({
    env: { FFMPEG_PATH: "/definitely/not/exists/ffmpeg" },
    directories: [],
  });
  assert.equal(resolvedNone, null);
});

test("解析失败的中文错误文案可操作", () => {
  assert.match(missingMediaBinaryMessage("ffprobe"), /brew install ffmpeg/u);
  assert.match(missingMediaBinaryMessage("ffprobe"), /FFPROBE_PATH/u);
  assert.match(missingMediaBinaryMessage("ffmpeg"), /FFMPEG_PATH/u);
});

test('Windows PATH支持exe且不选择cmd或bat，Unix路径语义独立验证', () => {
  const checked = [];
  const result = resolveFfmpeg({
    env: { PATH: 'C:\\Tools;C:\\FFmpeg\\bin' }, platform: 'win32',
    isExecutable: candidate => { checked.push(candidate); return candidate === 'C:\\FFmpeg\\bin\\ffmpeg.exe'; },
  });
  assert.equal(result, 'C:\\FFmpeg\\bin\\ffmpeg.exe');
  assert.ok(checked.every(p => !/\.(?:cmd|bat)$/iu.test(p)));
  assert.equal(resolveFfprobe({ env: { PATH: '/custom/bin:/usr/bin' }, platform: 'linux', isExecutable: candidate => candidate === '/custom/bin/ffprobe' }), '/custom/bin/ffprobe');
});

test("探测结果做进程内缓存：重设环境变量后需要显式重置缓存", async () => {
  const root = await tempRoot("nanowork-media-binaries-cache-");
  const custom = path.join(root, "ffprobe");
  await fsp.writeFile(custom, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  withEnv({ FFPROBE_PATH: undefined }, () => {
    const first = resolveFfprobe();
    // 缓存生效：中途改环境变量，未重置缓存前仍返回旧结果。
    process.env.FFPROBE_PATH = custom;
    assert.equal(resolveFfprobe(), first);
    resetMediaBinaryCache();
    assert.equal(resolveFfprobe(), custom);
    delete process.env.FFPROBE_PATH;
  });
});
