import test from 'node:test';
import assert from 'node:assert/strict';
import { measureNativeAudioLevel } from '../src/engines/native-audio-level.js';
import { voicedVideoFilter } from '../src/engines/video-voice-composition.js';

const measure = (rows, extra = {}) => measureNativeAudioLevel({
  paths: rows.map((_, i) => `/private/native-${i}.mp4`), ffmpegPath: '/bin/ffmpeg',
  cwd: '/private', durationSeconds: 15,
  runner: async (_file, args) => {
    assert.ok(!args.includes('-ac'), 'measure original channels without downmix gain');
    assert.ok(!args.includes('-ar'), 'measure original sample rate');
    const row = rows[Number(args[args.indexOf('-i') + 1].match(/-(\d+)\.mp4$/u)[1])];
    return { stderr: `ffmpeg log\n${JSON.stringify(row)}` };
  }, ...extra,
});

test('overloud native speech receives only constant attenuation', async () => {
  const result = await measure([{ input_i: '-6.14', input_tp: '0.48' }]);
  assert.equal(result.status, 'measured');
  assert.equal(result.gainDb, -9.86);
  assert.equal(result.audioSource, 'provider_native');
  const filter = voicedVideoFilter(1, { audioMode: 'provider_native', nativeAudioGainDb: result.gainDb });
  assert.match(filter, /volume=-9\.860dB/u);
  assert.doesNotMatch(filter, /atempo|asetrate|amix|loudnorm/u);
});

test('quiet native speech is not amplified or replaced', async () => {
  const result = await measure([{ input_i: '-23', input_tp: '-5' }]);
  assert.equal(result.gainDb, 0);
  assert.equal(result.applied, false);
  assert.doesNotMatch(voicedVideoFilter(1, { audioMode: 'provider_native' }), /volume=/u);
});

test('true peak headroom can require attenuation even with quiet average', async () => {
  const result = await measure([{ input_i: '-20', input_tp: '0.5' }]);
  assert.equal(result.gainDb, -2);
});

test('two clips use the same gain, retaining their original relation', async () => {
  const result = await measure([{ input_i: '-12', input_tp: '-2' }, { input_i: '-8', input_tp: '-1' }]);
  assert.equal(result.gainDb, -8);
  assert.equal(result.measurements.length, 2);
  const filter = voicedVideoFilter(2, { audioMode: 'provider_native', nativeAudioGainDb: result.gainDb });
  assert.equal(filter.match(/volume=-8\.000dB/gu).length, 2);
});

test('optional measurement failure preserves valid paid footage and original audio', async () => {
  for (const extra of [{ runner: async () => { throw new Error('missing optional filter'); } },
    { runner: async () => ({ stderr: 'unparseable' }) }]) {
    const result = await measure([{}], extra);
    assert.equal(result.status, 'measurement_unavailable');
    assert.equal(result.gainDb, 0);
    assert.equal(result.applied, false);
  }
  assert.equal((await measure([{ input_i: '-inf', input_tp: '-inf' }])).status, 'measurement_unavailable');
});

test('invalid gain cannot inject filters or amplify native output; TTS remains unaffected', () => {
  for (const nativeAudioGainDb of [1, -61, NaN, Infinity, '0;amix']) {
    assert.throws(() => voicedVideoFilter(1, { audioMode: 'provider_native', nativeAudioGainDb }));
  }
  assert.doesNotMatch(voicedVideoFilter(2, { audioMode: 'external_tts', nativeAudioGainDb: -10 }), /volume=/u);
});
