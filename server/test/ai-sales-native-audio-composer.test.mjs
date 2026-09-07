import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { composeAiSalesVideo, assertAiSalesVoicedComposerReady, runAiSalesMediaCommand } from '../src/engines/video-composer.js';
import { voicedVideoFilter } from '../src/engines/video-voice-composition.js';

process.env.NANOWORK_DB = ':memory:';

test('原生音轨预检无需独立TTS的MP3编码器/变速滤镜', async () => {
  const options = { audioMode: 'provider_native', env: { PATH: '/mock' }, platform: 'linux', isExecutable: async () => true };
  const ready = await assertAiSalesVoicedComposerReady({ ...options, runner: async (_cmd, args) => ({ stdout: args.includes('-filters') ? 'ass V->V\nvolumedetect A->A\napad A->A\nxfade VV->V\nafade A->A' : 'libx264 encoder\naac encoder' }) });
  assert.equal(ready.subtitleRenderer, 'ass');
  const single = await assertAiSalesVoicedComposerReady({ ...options, durationSeconds: 15,
    runner: async (_cmd, args) => ({ stdout: args.includes('-filters') ? 'ass V->V\nvolumedetect A->A\napad A->A' : 'libx264 encoder\naac encoder' }) });
  assert.equal(single.subtitleRenderer, 'ass', '单段不需要视频/音频转场滤镜');
});

test('短叠化不挤占原音轨与字幕时间，历史外部TTS不增加转场', () => {
  const graph = voicedVideoFilter(2, { audioMode: 'provider_native', rasterCues: [{ start: 15, end: 16, text: '第二段' }] });
  assert.match(graph, /xfade=transition=fade:duration=0\.4:offset=14\.8/u);
  assert.match(graph, /start_mode=clone:start_duration=0\.2/u);
  assert.match(graph, /\[a0\]\[a1\]concat=n=2:v=0:a=1/u);
  assert.match(graph, /gte\(t,15\)\*lt\(t,16\)/u);
  assert.doesNotMatch(graph, /acrossfade|atempo/u);
  assert.doesNotMatch(voicedVideoFilter(2), /xfade|afade/u);
  const single = voicedVideoFilter(1, { audioMode: 'provider_native', rasterCues: [{ start: 1, end: 3, text: '单段字幕' }] });
  assert.doesNotMatch(single, /xfade|afade|concat|atempo/u);
  assert.match(single, /\[0:a\]/u);
  assert.match(single, /\[1:v\]overlay/u, '单段首张字幕PNG必须跟在唯一视频输入之后');
  assert.throws(() => voicedVideoFilter(1, { audioMode:'provider_native', rasterCues:[{start:14,end:16,text:'越界'}] }), /越界/u);
});

test('360的原生30秒单段保留完整音画与后半字幕，不新增转场或第二声音', () => {
  const graph = voicedVideoFilter(1, { audioMode: 'provider_native', segmentDurationSeconds: 30,
    rasterCues: [{ start: 22, end: 28, text: '欢迎到店尝尝' }] });
  assert.match(graph, /trim=duration=30/u);
  assert.match(graph, /apad=whole_dur=30,atrim=duration=30/u);
  assert.match(graph, /gte\(t,22\)\*lt\(t,28\)/u);
  assert.doesNotMatch(graph, /xfade|afade|concat|trim=duration=15/u);
  assert.throws(() => voicedVideoFilter(2, { audioMode: 'provider_native', segmentDurationSeconds: 30 }), /时长/u);
});

test('真实FFmpeg验证360单段30秒原音轨与后半字幕可交付', { timeout: 120000 }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nw-360-native30-'));
  try {
    const binaries = await assertAiSalesVoicedComposerReady({ audioMode: 'provider_native' });
    const clip = path.join(root, 'original30.mp4');
    await runAiSalesMediaCommand(binaries.ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=180x320:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-pix_fmt', 'yuv420p', clip], { cwd: root });
    const output = await composeAiSalesVideo({ ...binaries, tenantId: 184, segments: [clip], outputRoot: path.join(root, 'output'),
      audioMode: 'provider_native', requireAudio: true, targetDurationSeconds: 30, subtitleRenderer: 'raster_png',
      subtitleCues: [{ start: 20, end: 28, text: '欢迎到店品尝' }] });
    assert.ok(Math.abs(output.durationSeconds - 30) <= 0.25);
    assert.equal(output.audioSource, 'provider_native'); assert.equal(output.transition, undefined);
    assert.deepEqual(output.audioVerification.map(check => check.startSeconds), [0, 15]);
    const frame = path.join(root, 'caption.rgb');
    await runAiSalesMediaCommand(binaries.ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', '22', '-i', output.path,
      '-vf', 'crop=920:140:80:1530', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', frame], { cwd: root });
    const pixels = await fsp.readFile(frame);
    let bright = 0;
    for (let i = 0; i < pixels.length; i += 3) if (pixels[i] > 200 && pixels[i + 1] > 200 && pixels[i + 2] > 200) bright++;
    assert.ok(bright > 100, '第22秒仍有视频和字幕，不能截成15秒');
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('真实FFmpeg保留两段供应商原声并烧录中文字幕，拒绝静音片段', { timeout: 180000 }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nw-native-audio-'));
  const binaries = await assertAiSalesVoicedComposerReady({ audioMode: 'provider_native' });
  const run = args => runAiSalesMediaCommand(binaries.ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], { cwd: root });
  try {
    const clips = [path.join(root, 'a.mp4'), path.join(root, 'b.mp4')];
    for (let i = 0; i < clips.length; i++) {
      await run(['-f', 'lavfi', '-i', `color=c=${i ? 'blue' : 'red'}:s=270x480:r=30`, '-f', 'lavfi', '-i', `sine=frequency=${i ? 880 : 440}:sample_rate=48000`, '-t', '15', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-pix_fmt', 'yuv420p', clips[i]]);
    }
    const options = { ...binaries, tenantId: 183, segments: clips, outputRoot: path.join(root, 'output'), audioMode: 'provider_native', requireAudio: true, subtitleRenderer: 'raster_png', subtitleCues: [{ start: 0.3, end: 7, text: '今天这一口，香气刚刚好' }, { start: 15.3, end: 23, text: '菜品来自用户提供的参考图' }] };
    const output = await composeAiSalesVideo(options);
    assert.equal(output.audioSource, 'provider_native');
    assert.equal(output.subtitleTiming, 'script_estimated');
    assert.equal(output.audioVerified, true);
    assert.equal(output.subtitlesBurnedIn, true);
    assert.equal(output.subtitleCount, 2);
    assert.ok(Math.abs(output.durationSeconds - 30) < 0.25);
    assert.deepEqual(output.transition, { type: 'dissolve', startSeconds: 14.8, endSeconds: 15.2, durationSeconds: 0.4, audioEdgeFadeSeconds: 0.04, timelinePreserved: true });
    const colors = [];
    for (const start of [14.7, 14.9, 15, 15.1, 15.3]) {
      const destination = path.join(root, `boundary-${start}.rgb`);
      await run(['-ss', String(start), '-i', output.path, '-vf', 'crop=100:100:100:100', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', destination]);
      const pixels = await fsp.readFile(destination);
      colors.push([0, 1, 2].map(channel => { let total = 0; for (let i = channel; i < pixels.length; i += 3) total += pixels[i]; return total / (pixels.length / 3); }));
    }
    assert.ok(colors[0][0] > 200 && colors[0][2] < 10, '14.7秒仍是原第一段');
    assert.ok(colors[4][2] > 200 && colors[4][0] < 10, '15.3秒已是原第二段');
    assert.ok(colors[2][0] > 70 && colors[2][2] > 70, '15秒中心应是两画面混合，不能黑屏或硬切');
    for (let i = 1; i < colors.length; i++) assert.ok(colors[i][0] < colors[i-1][0] && colors[i][2] > colors[i-1][2], '过渡颜色应渐变');
    const boundaryAudio = path.join(root, 'boundary-audio.pcm');
    await run(['-ss', '14.94', '-i', output.path, '-t', '0.12', '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', boundaryAudio]);
    const boundarySamples = await fsp.readFile(boundaryAudio);
    for (let offset = 0; offset + 960 <= boundarySamples.length; offset += 960) {
      let power = 0; for (let i = offset; i < offset + 960; i += 2) power += boundarySamples.readInt16LE(i) ** 2;
      assert.ok(Math.sqrt(power / 480) > 40, '边界每10ms仍应有原声，不能插入静音段');
    }
    // Zero crossings distinguish the original first/second segment tones.
    for (const [start, expected] of [[2, 440], [17, 880]]) {
      const destination = path.join(root, `audio-${start}.pcm`);
      await run(['-ss', String(start), '-i', output.path, '-t', '1', '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', destination]);
      const samples = await fsp.readFile(destination);
      let crossings = 0;
      for (let i = 2; i < samples.length; i += 2) if (samples.readInt16LE(i - 2) <= 0 && samples.readInt16LE(i) > 0) crossings++;
      assert.ok(Math.abs(crossings - expected) < 6, `原声音调应保留：${crossings}/${expected}`);
    }
    for (const start of [1, 16, 29]) {
      const destination = path.join(root, `frame-${start}.rgb`);
      await run(['-ss', String(start), '-i', output.path, '-vf', 'crop=920:140:80:1530', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', destination]);
      const pixels = await fsp.readFile(destination);
      let bright = 0;
      for (let i = 0; i < pixels.length; i += 3) if (pixels[i] > 200 && pixels[i+1] > 200 && pixels[i+2] > 200) bright++;
      assert.ok(start === 29 ? bright === 0 : bright > 100, `字幕在${start}秒按时出现/消失：${bright}`);
    }
    const silent = path.join(root, 'silent.mp4');
    await run(['-i', clips[0], '-af', 'volume=0', '-c:v', 'copy', silent]);
    await assert.rejects(composeAiSalesVideo({ ...options, segments: [silent, clips[1]] }), /静音/u);
    await assert.rejects(composeAiSalesVideo({ ...options, voiceTracks: clips }), /不叠加/u);

    const one = await composeAiSalesVideo({ ...options, segments:[clips[0]], targetDurationSeconds:15,
      subtitleCues:[options.subtitleCues[0]], outputRoot:path.join(root,'single') });
    assert.ok(Math.abs(one.durationSeconds - 15) < 0.25);
    assert.equal(one.audioSource, 'provider_native');
    assert.equal(one.audioVerified, true);
    assert.equal(one.audioVerification.length, 1);
    assert.equal(one.audioVerification[0].startSeconds, 0);
    assert.equal(one.transition, undefined);
    assert.equal(one.subtitleCount, 1);
    const destination = path.join(root, 'single-voice.pcm');
    await run(['-ss','2','-i',one.path,'-t','1','-map','0:a:0','-ac','1','-ar','48000','-f','s16le',destination]);
    const samples = await fsp.readFile(destination);
    let crossings = 0;
    for (let i=2;i<samples.length;i+=2) if(samples.readInt16LE(i-2)<=0 && samples.readInt16LE(i)>0) crossings++;
    assert.ok(Math.abs(crossings-440)<6, '单段成片保留原声而不叠加配音');
    const frame = path.join(root, 'single-caption.rgb');
    await run(['-ss','1','-i',one.path,'-vf','crop=920:140:80:1530','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo',frame]);
    const pixels = await fsp.readFile(frame);
    let bright = 0;
    for(let i=0;i<pixels.length;i+=3) if(pixels[i]>200 && pixels[i+1]>200 && pixels[i+2]>200) bright++;
    assert.ok(bright>100, '单段字幕必须真的烧录到成片');
    // 30秒目标允许单段（万相3.0一次生成30秒）；一段15秒素材必须按实测时长拒绝，而不是结构错误。
    await assert.rejects(composeAiSalesVideo({ ...options, segments:[clips[0]] }), /实测时长不符合30秒/u);
    await assert.rejects(composeAiSalesVideo({ ...options, targetDurationSeconds:15 }), /所选15或30秒/u);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});
