import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  AI_SALES_VIDEO_TARGET_DURATION_SECONDS,
  assertAiSalesVideoComposerReady,
  assertAiSalesVoicedComposerReady,
  composeAiSalesVideo,
} from '../src/engines/video-composer.js';

const tempRoots = [];

async function tempRoot(prefix) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function localClips(root, names = ['clip-a.mp4', 'clip-b.mp4']) {
  const paths = [];
  for (const name of names) {
    const filePath = path.join(root, name);
    await fsp.writeFile(filePath, crypto.randomBytes(32));
    paths.push(filePath);
  }
  return paths;
}

function probeJson(duration, { output = false } = {}) {
  return JSON.stringify({
    streams: [
      {
        codec_type: 'video',
        codec_name: output ? 'h264' : 'vp9',
        width: output ? 1080 : 720,
        height: output ? 1920 : 1280,
        duration: String(duration),
      },
      {
        codec_type: 'audio',
        codec_name: output ? 'aac' : 'opus',
        duration: String(duration),
      },
    ],
    format: { duration: String(duration) },
  });
}

test('LaunchAgent最小PATH会安全发现Homebrew二进制，显式配置仍优先', async () => {
  const checked = [];
  const ready = await assertAiSalesVideoComposerReady({
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    isExecutable: async candidate => {
      checked.push(candidate);
      return candidate === '/opt/homebrew/bin/ffmpeg'
        || candidate === '/usr/local/bin/ffprobe';
    },
  });
  assert.deepEqual(ready, {
    ffmpegPath: '/opt/homebrew/bin/ffmpeg',
    ffprobePath: '/usr/local/bin/ffprobe',
  });
  assert.equal(checked.every(candidate => path.isAbsolute(candidate)), true);

  const explicit = await assertAiSalesVideoComposerReady({
    platform: 'darwin',
    env: {
      PATH: '/untrusted/minimal-path',
      FFMPEG_PATH: '/configured/tools/ffmpeg',
      FFPROBE_PATH: '/configured/tools/ffprobe',
    },
    isExecutable: async candidate => candidate.startsWith('/configured/tools/'),
  });
  assert.deepEqual(explicit, {
    ffmpegPath: '/configured/tools/ffmpeg',
    ffprobePath: '/configured/tools/ffprobe',
  });
});

test('FFmpeg不存在时预检返回明确中文错误码', async () => {
  await assert.rejects(
    assertAiSalesVideoComposerReady({
      env: { PATH: '/empty/minimal-path' },
      isExecutable: async () => false,
    }),
    error => error.code === 'AI_SALES_VIDEO_COMPOSER_BINARY_MISSING'
      && error.binary === 'ffmpeg'
      && /缺少可执行的 ffmpeg/u.test(error.message),
  );
});

test('有声合成预检验证字幕/音量滤镜和编码器，能力缺失在收费前暴露', async () => {
  const options = { env: { PATH: '/mock' }, platform: 'linux', isExecutable: async () => true };
  const filters = 'ass V->V\nvolumedetect A->A\natempo A->A\napad A->A';
  const runner = async (_cmd, args) => ({ stdout: args.includes('-filters') ? filters : 'libx264 encoder\naac encoder\nlibmp3lame encoder' });
  const ready = await assertAiSalesVoicedComposerReady({ ...options, runner });
  assert.equal(ready.ffmpegPath, '/mock/ffmpeg');
  await assert.rejects(assertAiSalesVoicedComposerReady({ ...options, runner: async () => ({ stdout: 'atempo A->A' }) }), /ass/u);
  await assert.rejects(assertAiSalesVoicedComposerReady({ ...options, runner: async (_cmd, args) => ({ stdout: args.includes('-filters') ? filters : 'libx264 encoder\naac encoder' }) }), /libmp3lame/u);
});

test('有声模式拒绝缺失音轨与未提供的字幕，不能用静音垫轨过关', async () => {
  const root = await tempRoot('nw-voiced-composer-');
  const clips = await localClips(root);
  let encoded = false;
  const runner = async (cmd, args) => {
    if (cmd.includes('ffprobe')) {
      const payload = JSON.parse(probeJson(15));
      payload.streams = payload.streams.filter(s => s.codec_type !== 'audio');
      return { stdout: JSON.stringify(payload) };
    }
    encoded = true;
    await fsp.writeFile(args.at(-1), 'wrong');
    return { code: 0 };
  };
  await assert.rejects(composeAiSalesVideo({ tenantId: 2, segments: clips, outputRoot: root, requireAudio: true, runner }), /音轨|字幕/u);
  assert.equal(encoded, false);
});

test('预检后二进制被移除产生ENOENT时仍返回可操作错误', async () => {
  const root = await tempRoot('nanowork-video-composer-enoent-');
  const inputRoot = await tempRoot('nanowork-video-composer-enoent-input-');
  const clips = await localClips(inputRoot);
  const runner = async () => {
    const error = new Error('spawn ffprobe ENOENT');
    error.code = 'ENOENT';
    throw error;
  };
  await assert.rejects(
    composeAiSalesVideo({
      tenantId: 1,
      segments: clips,
      outputRoot: root,
      runner,
    }),
    error => error.code === 'AI_SALES_VIDEO_COMPOSER_BINARY_MISSING'
      && error.binary === 'ffprobe'
      && /配置 FFPROBE_PATH/u.test(error.message),
  );
});

test('本地片段安全标准化并合成30秒竖屏H264/AAC，返回受保护URL与哈希', async () => {
  const root = await tempRoot('nanowork-video-composer-success-');
  const inputRoot = await tempRoot('nanowork-video-composer-input-');
  const clips = await localClips(inputRoot);
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.ok(Array.isArray(args));
    assert.equal(options?.shell, undefined, '注入runner不得启用shell');
    if (String(command).includes('ffprobe')) {
      const isOutput = String(args.at(-1)).includes(`${path.sep}composed.mp4`);
      return { stdout: probeJson(isOutput ? 30 : 15, { output: isOutput }) };
    }
    assert.equal(String(command).includes('ffmpeg'), true);
    await fsp.writeFile(args.at(-1), Buffer.from('fake-h264-aac-mp4'));
    return { code: 0, stdout: '', stderr: '' };
  };

  const result = await composeAiSalesVideo({
    tenantId: 42,
    segments: clips,
    outputRoot: root,
    ffmpegPath: '/mock/ffmpeg',
    ffprobePath: '/mock/ffprobe',
    runner,
  });

  assert.equal(result.tenantId, 42);
  assert.equal(result.duration, AI_SALES_VIDEO_TARGET_DURATION_SECONDS);
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
  assert.equal(result.videoCodec, 'h264');
  assert.equal(result.audioCodec, 'aac');
  assert.equal(result.segmentCount, 2);
  assert.equal(result.url, `/uploads/ai-sales-video/42/${path.basename(result.path)}`);
  assert.match(result.url, /^\/uploads\/ai-sales-video\/42\/sales-video-[a-f0-9]{36}\.mp4$/u);
  assert.equal(result.absolutePath, result.path);
  assert.equal(result.sha256, crypto.createHash('sha256').update('fake-h264-aac-mp4').digest('hex'));
  assert.equal((await fsp.stat(result.path)).isFile(), true);
  assert.equal(await fsp.readdir(root).then(entries => entries.length), 1);
  const ffmpegCall = calls.find(call => String(call.command).includes('ffmpeg'));
  assert.ok(ffmpegCall);
  assert.equal(ffmpegCall.args.includes(';'), false, 'ffmpeg参数必须是独立数组项');
  assert.ok(ffmpegCall.args.includes('-filter_complex'));
  assert.ok(ffmpegCall.args.includes('-c:v'));
  assert.ok(ffmpegCall.args.includes('h264'));
  assert.ok(ffmpegCall.args.includes('-c:a'));
  assert.ok(ffmpegCall.args.includes('aac'));
});

test('拒绝URL、相对路径、数量越界与shell注入式伪路径', async () => {
  const root = await tempRoot('nanowork-video-composer-input-validation-');
  const clips = await localClips(root);
  const runner = async () => ({ stdout: probeJson(15, { output: true }), code: 0 });
  await assert.rejects(
    composeAiSalesVideo({ tenantId: 1, outputRoot: root, segments: ['https://example.com/a.mp4', ...clips.slice(1)], runner }),
    error => error.code === 'AI_SALES_VIDEO_COMPOSER_INVALID' && /本地路径/u.test(error.message),
  );
  await assert.rejects(
    composeAiSalesVideo({ tenantId: 1, outputRoot: root, segments: [clips[0]], runner }),
    /2或3个/u,
  );
  await assert.rejects(
    composeAiSalesVideo({
      tenantId: 1,
      outputRoot: root,
      segments: [
        ...clips,
        await fsp.writeFile(path.join(root, 'clip-c.mp4'), 'third').then(() => path.join(root, 'clip-c.mp4')),
        await fsp.writeFile(path.join(root, 'clip-d.mp4'), 'fourth').then(() => path.join(root, 'clip-d.mp4')),
      ],
      runner,
    }),
    /2或3个/u,
  );
  const malicious = path.join(root, 'clip;touch SHOULD_NOT_EXIST.mp4');
  await fsp.writeFile(malicious, 'local clip');
  const safeCalls = [];
  const safeRunner = async (command, args) => {
    safeCalls.push({ command, args });
    if (String(command).includes('ffprobe')) {
      const isOutput = String(args.at(-1)).includes(`${path.sep}composed.mp4`);
      return { stdout: probeJson(isOutput ? 30 : 15, { output: isOutput }) };
    }
    await fsp.writeFile(args.at(-1), 'safe-output');
    return { code: 0 };
  };
  const result = await composeAiSalesVideo({
    tenantId: 7,
    outputRoot: root,
    segments: [malicious, clips[1]],
    ffmpegPath: '/mock/ffmpeg',
    ffprobePath: '/mock/ffprobe',
    runner: safeRunner,
  });
  assert.equal(result.segmentCount, 2);
  assert.equal(await fsp.access(path.join(root, 'SHOULD_NOT_EXIST')).then(() => true, () => false), false);
  assert.ok(safeCalls.some(call => call.args.includes(malicious)));
});

test('ffmpeg失败时清理临时目录与未提交输出，不留下半成品', async () => {
  const root = await tempRoot('nanowork-video-composer-failure-');
  const inputRoot = await tempRoot('nanowork-video-composer-failure-input-');
  const clips = await localClips(inputRoot);
  const runner = async (command, args) => {
    if (String(command).includes('ffprobe')) return { stdout: probeJson(15) };
    await fsp.writeFile(args.at(-1), 'partial-output');
    const error = new Error('mock ffmpeg failed');
    error.code = 'MOCK_FFMPEG_FAILED';
    throw error;
  };
  await assert.rejects(
    composeAiSalesVideo({
      tenantId: 99,
      segments: clips,
      outputRoot: root,
      ffmpegPath: '/mock/ffmpeg',
      ffprobePath: '/mock/ffprobe',
      runner,
    }),
    error => error.code === 'AI_SALES_VIDEO_COMPOSER_COMMAND_FAILED',
  );
  assert.equal(await fsp.access(path.join(root, '99')).then(() => true, () => false), false);
  assert.equal((await fsp.readdir(root)).length, 0);
});

after(async () => {
  for (const root of tempRoots) await fsp.rm(root, { recursive: true, force: true });
});
