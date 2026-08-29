import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  downloadProviderVideoClip,
  waitForProviderVideo,
} from '../src/engines/video-provider-download.js';

const roots = [];

test('只下载HTTPS视频且按字节上限落入临时目录', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nanowork-video-download-'));
  roots.push(root);
  const output = await downloadProviderVideoClip({
    url: 'https://provider.example/video.mp4',
    outputDir: root,
    fetchImpl: async () => new Response(Buffer.from('video-bytes'), {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '11' },
    }),
  });
  assert.equal(await fsp.readFile(output.path, 'utf8'), 'video-bytes');
  assert.match(output.sha256, /^[a-f0-9]{64}$/u);
  await assert.rejects(
    downloadProviderVideoClip({ url: 'http://provider.example/a.mp4', outputDir: root }),
    /HTTPS/u,
  );
});

test('轮询只在真实URL或失败终态收敛', async () => {
  let calls = 0;
  const ready = await waitForProviderVideo({
    taskId: 'task-1',
    model: 'MiniMax-Hailuo-2.3-Fast',
    intervalMs: 1,
    sleep: async () => {},
    query: async () => {
      calls += 1;
      return calls === 2
        ? { status: 'Success', url: 'https://provider.example/final.mp4' }
        : { status: 'Processing', url: null };
    },
  });
  assert.equal(calls, 2);
  assert.equal(ready.url, 'https://provider.example/final.mp4');
});

after(async () => {
  for (const root of roots) await fsp.rm(root, { recursive: true, force: true });
});
