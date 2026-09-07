import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.NANOWORK_TEST_TEMPLATE_AI = '1';
process.env.NODE_ENV = 'test';
process.env.NANOWORK_DB = ':memory:';
process.env.YUNWU_API_KEY = '';
const { composeAiSalesVideo, assertAiSalesVoicedComposerReady, runAiSalesMediaCommand: runner } = await import('../src/engines/video-composer.js');
const { synthesizeAiSalesVideoVoiceTracks, buildAiSalesVideoSubtitleCues } = await import('../src/engines/ai-sales-video-voice.js');
const { voiceSubtitleAss, assertAudibleTrack } = await import('../src/engines/video-voice-composition.js');

test('真实FFmpeg：PNG中文字幕兼容无ASS环境，形成有声30秒1080p成片并拒绝静音/短片', { timeout: 180_000 }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nw-m4-real-media-'));
  const tools = await assertAiSalesVoicedComposerReady({ audioMode: 'external_tts', durationSeconds: 30 });
  const run = args => runner(tools.ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], { cwd: root });
  const probe = filePath => runner(tools.ffprobePath, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath], { cwd: root }).then(r => JSON.parse(r.stdout));
  try {
    const clips = [path.join(root, 'clip-a.mp4'), path.join(root, 'clip-b.mp4')];
    const raw = [path.join(root, 'raw-a.mp3'), path.join(root, 'raw-b.mp3')];
    for (let i = 0; i < 2; i += 1) {
      await run(['-f', 'lavfi', '-i', `color=c=${i ? '0x303050' : '0x203040'}:s=270x480:r=30`, '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '15', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-pix_fmt', 'yuv420p', clips[i]]);
      await run(['-f', 'lavfi', '-i', `sine=frequency=${i ? 660 : 440}:sample_rate=32000`, '-t', i ? '12' : '16.2', '-c:a', 'libmp3lame', raw[i]]);
    }
    const bytes = await Promise.all(raw.map(p => fsp.readFile(p)));
    let calls = 0, downloads = 0;
    const script = { shots: [{ index: 1, voiceover: '今天不知道吃什么？先看看门店的真实菜品。' }, { index: 2, voiceover: '按自己的口味慢慢选。想了解详情，可以到店咨询。' }] };
    const voice = await synthesizeAiSalesVideoVoiceTracks({
      ...tools, runner, workDir: root, script,
      voiceClient: { synthesize: async () => { calls += 1; return { audioUrl: `https://voice.example/${calls}.mp3` }; } },
      fetchImpl: async () => new Response(bytes[downloads++], { headers: { 'content-type': 'audio/mpeg' } }),
      publishAsset: async () => 'https://assets.example/test-only',
    });
    assert.equal(calls, 2);
    assert.ok(voice.tracks[0].tempo > 1 && voice.tracks[0].tempo <= 1.1);
    assert.equal(voice.tracks[1].tempo, 1);
    assert.ok(voice.tracks.every(t => Math.abs(t.durationSeconds - 15) < 0.25));
    const cues = buildAiSalesVideoSubtitleCues({ script, tracks: voice.tracks, durationSeconds: 30 });
    assert.equal(cues.find(cue => cue.shotIndex === 2).start, 15);
    const output = await composeAiSalesVideo({
      tenantId: 183, segments: clips, voiceTracks: voice.tracks.map(t => t.localPath), subtitleCues: cues,
      audioMode: 'external_tts', targetDurationSeconds: 30,
      requireAudio: true, outputRoot: path.join(root, 'output'), ...tools,
      subtitleRenderer: 'raster_png',
    });
    const measured = await probe(output.absolutePath);
    assert.ok(Math.abs(Number(measured.format.duration) - 30) < 0.25);
    assert.equal(measured.streams.find(s => s.codec_type === 'video').width, 1080);
    assert.equal(measured.streams.find(s => s.codec_type === 'video').height, 1920);
    assert.equal(measured.streams.find(s => s.codec_type === 'video').codec_name, 'h264');
    assert.equal(measured.streams.find(s => s.codec_type === 'audio').codec_name, 'aac');
    assert.equal(output.audioVerification.length, 2);
    assert.ok(output.audioVerification.every(r => r.peakDb > -60));
    assert.equal(output.subtitlesBurnedIn, true);
    assert.equal(output.subtitleRenderer, 'raster_png');
    assert.equal(output.subtitleCount, cues.length);
    const digest = crypto.createHash('sha256').update(await fsp.readFile(output.absolutePath)).digest('hex');
    assert.equal(digest, output.sha256);

    // Inspect the encoded pixels: a solid background cannot create the bright
    // subtitle pixels in this crop. This is not merely a command-argument test.
    const pixelsPath = path.join(root, 'caption-pixels.rgb');
    await run(['-ss', '0.5', '-i', output.absolutePath, '-vf', 'crop=920:140:80:1530', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', pixelsPath]);
    const pixels = await fsp.readFile(pixelsPath);
    let bright = 0, darkOutline = 0;
    for (let i = 0; i < pixels.length; i += 3) {
      if (pixels[i] > 200 && pixels[i + 1] > 200 && pixels[i + 2] > 200) bright += 1;
      if (pixels[i] < 24 && pixels[i + 1] < 24 && pixels[i + 2] < 24) darkOutline += 1;
    }
    assert.ok(bright > 100, `字幕区域应存在真实亮字像素，实际 ${bright}`);
    // Both solid synthetic backgrounds are above this dark threshold. These
    // pixels are the encoded outline, so a black-filled glyph with tiny white
    // remnants cannot pass merely by exceeding 100 bright pixels.
    assert.ok(darkOutline > 50, '烧录成片应保留黑边以便在复杂画面上阅读');
    assert.ok(bright / (bright + darkOutline) > 0.55, '烧录成片的白色笔画应多于黑色描边，不能形成黑心字');
    const secondPixelsPath = path.join(root, 'second-caption-pixels.rgb');
    await run(['-ss', '15.5', '-i', output.absolutePath, '-vf', 'crop=920:140:80:1530', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', secondPixelsPath]);
    const secondPixels = await fsp.readFile(secondPixelsPath);
    let secondBright = 0, secondDarkOutline = 0;
    for (let i = 0; i < secondPixels.length; i += 3) {
      if (secondPixels[i] > 200 && secondPixels[i + 1] > 200 && secondPixels[i + 2] > 200) secondBright += 1;
      if (secondPixels[i] < 24 && secondPixels[i + 1] < 24 && secondPixels[i + 2] < 24) secondDarkOutline += 1;
    }
    assert.ok(secondBright > 100, '第二段字幕必须按时间轴实际出现');
    assert.ok(secondDarkOutline > 50);
    assert.ok(secondBright / (secondBright + secondDarkOutline) > 0.55, '第二段字幕同样保留完整白色字心');
    assert.ok(cues.at(-1).end < 28, '用实测短配音验证字幕结束后不残留');
    const tailPixelsPath = path.join(root, 'after-caption-pixels.rgb');
    await run(['-ss', '29', '-i', output.absolutePath, '-vf', 'crop=920:140:80:1530', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', tailPixelsPath]);
    const tailPixels = await fsp.readFile(tailPixelsPath);
    let tailBright = 0;
    for (let i = 0; i < tailPixels.length; i += 3) if (tailPixels[i] > 200 && tailPixels[i + 1] > 200 && tailPixels[i + 2] > 200) tailBright += 1;
    assert.equal(tailBright, 0, '字幕结束后PNG不应继续覆盖画面');

    const silent = path.join(root, 'silent.wav');
    await run(['-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', '15', silent]);
    await assert.rejects(assertAudibleTrack({ runner, ffmpegPath: tools.ffmpegPath, filePath: silent, cwd: root, durationSeconds: 15 }), /静音/u);
    const missingAudio = path.join(root, 'no-audio.mp4');
    await run(['-i', clips[0], '-an', '-c:v', 'copy', missingAudio]);
    const options = { tenantId: 183, outputRoot: path.join(root, 'rejected'), voiceTracks: voice.tracks.map(t => t.localPath), subtitleCues: cues, audioMode: 'external_tts', targetDurationSeconds: 30, requireAudio: true, ...tools };
    await assert.rejects(composeAiSalesVideo({ ...options, segments: [missingAudio, clips[1]] }), /缺少音轨/u);
    const short = path.join(root, 'short.mp4');
    await run(['-i', clips[0], '-t', '10', '-c', 'copy', short]);
    await assert.rejects(composeAiSalesVideo({ ...options, segments: [short, clips[1]] }), /时长/u);
    assert.equal(await fsp.access(path.join(root, 'rejected')).then(() => true, () => false), false);

    // Optional evidence directory is explicitly supplied by the test command;
    // never persist random tests/media into the application's live upload root.
    if (process.env.NANOWORK_M4_MEDIA_EVIDENCE_DIR) {
      const evidence = path.resolve(process.env.NANOWORK_M4_MEDIA_EVIDENCE_DIR);
      const workspace = path.resolve(import.meta.dirname, '../../artifacts/cursor-handoff-2026-09-04');
      assert.ok(evidence.startsWith(`${workspace}${path.sep}`));
      await fsp.mkdir(evidence, { recursive: true });
      await fsp.copyFile(output.absolutePath, path.join(evidence, 'synthetic-voiced-30s.mp4'));
      await run(['-ss', '0.5', '-i', output.absolutePath, '-frames:v', '1', path.join(evidence, 'subtitle-frame.png')]);
      await fsp.writeFile(path.join(evidence, 'verification.json'), JSON.stringify({
        checkedAt: new Date().toISOString(), syntheticOnly: true, externalCalls: 0, paidCalls: 0,
        voiceDurations: voice.tracks.map(t => ({ measuredSeconds: t.measuredSeconds, tempo: t.tempo, durationSeconds: t.durationSeconds })),
        sha256: digest, durationSeconds: Number(measured.format.duration), width: 1080, height: 1920,
        audioVerification: output.audioVerification, subtitleCount: cues.length, subtitleRenderer: output.subtitleRenderer,
        brightSubtitlePixels: bright, secondBrightSubtitlePixels: secondBright, afterSubtitleBrightPixels: tailBright,
        rejectedSilentAudio: true, rejectedMissingProviderAudio: true, rejectedShortProviderClip: true,
      }, null, 2));
    }
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('字幕控制字符只能作为文字，不可注入ASS样式/绘图或换行', () => {
  const ass = voiceSubtitleAss([{ start: 0, end: 1, text: '{\\p1}m 0 0\\N' }]);
  assert.ok(!ass.includes('{\\p1}'));
  assert.ok(ass.includes('｛＼p1｝m 0 0＼N'));
  assert.throws(() => voiceSubtitleAss([{ start: 29, end: 31, text: '越界' }]), /越界/u);
  assert.throws(() => voiceSubtitleAss([{ start: 0, end: 2, text: '一' }, { start: 1, end: 3, text: '二' }]), /重叠/u);
});
