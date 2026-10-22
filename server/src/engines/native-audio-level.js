// Measure the provider's original channels. Downmixing stereo before measuring
// can add gain and incorrectly imply the original soundtrack was clipping.
export async function measureNativeAudioLevel({ paths, ffmpegPath, runner, cwd, durationSeconds }) {
  const targetLufs = -16, maxTruePeakDb = -1.5;
  const measurements = [];
  try {
    for (const [index, file] of paths.entries()) {
      const result = await runner(ffmpegPath, [
        '-hide_banner', '-nostdin', '-v', 'info', '-protocol_whitelist', 'file,pipe',
        '-i', file, '-t', String(durationSeconds), '-map', '0:a:0', '-vn',
        '-af', `loudnorm=I=${targetLufs}:TP=${maxTruePeakDb}:LRA=11:print_format=json`,
        '-f', 'null', '-',
      ], { cwd });
      const json = String(result?.stderr || '').match(/\{\s*"input_i"\s*:[\s\S]*?\}/u)?.[0];
      const data = JSON.parse(json || '{}');
      const integratedLufs = Number(data.input_i), truePeakDb = Number(data.input_tp);
      if (!Number.isFinite(integratedLufs) || !Number.isFinite(truePeakDb)) throw new Error('invalid measurement');
      measurements.push({ index: index + 1, integratedLufs, truePeakDb });
    }
    if (!measurements.length) throw new Error('no source');
    // A single constant attenuation preserves voice, timing, dynamics and the
    // original relation between clips. Never amplify a quiet provider track.
    const gainDb = Math.max(-60, Math.min(0, ...measurements.flatMap(item => [
      targetLufs - item.integratedLufs, maxTruePeakDb - item.truePeakDb,
    ])));
    return { status: 'measured', method: 'ffmpeg-ebur128-measurement-constant-attenuation',
      gainDb: Math.round(gainDb * 1000) / 1000, applied: gainDb < 0,
      targetLufs, maxTruePeakDb, measurements, audioSource: 'provider_native' };
  } catch {
    // Optional refinement must not discard an otherwise valid, audible paid
    // video. Its existing audible-track verification still runs independently.
    return { status: 'measurement_unavailable', gainDb: 0, applied: false,
      targetLufs, maxTruePeakDb, measurements, audioSource: 'provider_native' };
  }
}
