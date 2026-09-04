import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.NODE_ENV = 'test';
process.env.NANOWORK_DB = ':memory:';
process.env.YUNWU_API_KEY = '';
const voice = await import('../src/engines/ai-sales-video-voice.js');

test('配音固定15秒，短口播不能移动下一段起点', () => {
  for (const duration of [0.5, 2, 7.3, 14.9, 15, 15.6, 16.5]) {
    const fit = voice.decideVoiceTrackFit(duration);
    assert.equal(fit.providerDuration, 15);
    assert.ok(fit.tempo <= 1.1);
    assert.ok(fit.speechSeconds <= 15.001);
  }
  assert.equal(voice.decideVoiceTrackFit(16.51).action, 'condense');
});

test('字幕无重叠、无越界，SRT毫秒正确进位', () => {
  const cues = voice.buildAiSalesVideoSubtitleCues({
    script: { shots: [{ index: 1, voiceover: '来。看。尝。买。走。' }, { index: 2, voiceover: '再来。' }] },
    tracks: [{ index: 1, speechSeconds: 1 }, { index: 2, speechSeconds: 1 }],
  });
  for (let i = 0; i < cues.length; i += 1) {
    assert.ok(cues[i].start < cues[i].end);
    assert.ok(cues[i].end <= cues[i].shotIndex * 15);
    if (i) assert.ok(cues[i - 1].end <= cues[i].start);
  }
  const srt = voice.buildAiSalesVideoSrt([{ start: 59.9999, end: 60.1001, text: '测试' }]);
  assert.match(srt, /00:01:00,000 --> 00:01:00,100/u);
});

async function fixture(run, { durations = [8, 15.012, 9, 15.012], audioUrl = 'https://voice.example/output.mp3', condenseShot } = {}) {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nw-m4-voice-'));
  const events = [];
  let probeIndex = 0;
  const options = {
    workDir, script: { shots: [{ index: 1, voiceover: '第一段。' }, { index: 2, voiceover: '第二段。' }] },
    voiceClient: { synthesize: async () => { events.push('tts'); return { audioUrl }; } },
    onTtsCall: async () => { events.push('intent'); },
    fetchImpl: async () => { events.push('download'); return new Response('synthetic-audio', { headers: { 'content-type': 'audio/mpeg' } }); },
    runner: async (cmd, args) => {
      if (cmd.includes('ffprobe')) return { stdout: JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: durations[probeIndex++] } }) };
      await fsp.writeFile(args.at(-1), 'fitted-audio');
      return { code: 0 };
    },
    publishAsset: async () => { events.push('publish'); return 'https://public.example/api/assets/test'; },
    condenseShot,
  };
  try { await run(options, events); } finally { await fsp.rm(workDir, { recursive: true, force: true }); }
}

test('两段真实配音接口顺序为先持久标记再调用，返回实测元数据', async () => {
  await fixture(async (options, events) => {
    const result = await voice.synthesizeAiSalesVideoVoiceTracks(options);
    assert.equal(result.ttsCalls, 2);
    assert.deepEqual(events, ['intent', 'tts', 'download', 'publish', 'intent', 'tts', 'download', 'publish']);
    assert.deepEqual(result.tracks.map(t => t.providerDuration), [15, 15]);
  });
});

test('拒绝供应商内网音频URL，不调用下载器', async () => {
  await fixture(async (options, events) => {
    await assert.rejects(voice.synthesizeAiSalesVideoVoiceTracks(options), /公网|不安全/u);
    assert.equal(events.includes('download'), false);
  }, { audioUrl: 'https://127.0.0.1/private' });
});

test('处理后过短音轨不可冒充15秒成片音轨', async () => {
  await fixture(async (options, events) => {
    await assert.rejects(voice.synthesizeAiSalesVideoVoiceTracks(options), /时长|15/u);
    assert.equal(events.includes('publish'), false);
  }, { durations: [8, 3, 9, 15] });
});

test('一个任务最多精简一段，第二段超时不得再调用精简模型', async () => {
  let condenseCalls = 0;
  await fixture(async options => {
    await assert.rejects(voice.synthesizeAiSalesVideoVoiceTracks(options), /精简|上限/u);
    assert.equal(condenseCalls, 1);
  }, { durations: [18, 14, 15.012, 18], condenseShot: async ({ script }) => { condenseCalls += 1; return { script }; } });
});

test('持久化调用标记失败，不触发收费TTS', async () => {
  await fixture(async (options, events) => {
    await assert.rejects(voice.synthesizeAiSalesVideoVoiceTracks({ ...options, onTtsCall: async () => { throw new Error('ledger failed'); } }), /ledger failed/u);
    assert.deepEqual(events, []);
  });
});
