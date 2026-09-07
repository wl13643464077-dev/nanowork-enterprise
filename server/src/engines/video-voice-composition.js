const invalid = message => Object.assign(new Error(message), { code: 'AI_SALES_VIDEO_COMPOSER_AUDIO_INVALID', status: 502 });

// Frame handles create a dissolve around 15s without shifting the second
// clip, overlapping words, or moving the absolute subtitle timeline.
export const AI_SALES_NATIVE_TRANSITION = Object.freeze({
  type: 'dissolve', startSeconds: 14.8, endSeconds: 15.2,
  durationSeconds: 0.4, audioEdgeFadeSeconds: 0.04, timelinePreserved: true,
});

export function voiceSubtitleAss(cues, duration = 30) {
  if (!Array.isArray(cues) || !cues.length || cues.length > 120) throw invalid('有声成片缺少有效字幕');
  let previousEnd = 0;
  const time = value => {
    const cs = Math.round(value * 100);
    return `${Math.floor(cs / 360000)}:${String(Math.floor(cs % 360000 / 6000)).padStart(2, '0')}:${String(Math.floor(cs % 6000 / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
  };
  const lines = cues.map(cue => {
    const start = Number(cue.start), end = Number(cue.end);
    const text = String(cue.text || '').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < previousEnd || end <= start || end > duration
      || !text || text.length > 100 || Math.round(end * 100) <= Math.round(start * 100)) throw invalid('字幕时间轴重叠、越界或文本无效');
    previousEnd = end;
    // ASS is a control language. Treat every model-produced byte as plain text.
    const safe = text.replace(/\\/gu, '＼').replace(/\{/gu, '｛').replace(/\}/gu, '｝').replace(/[\r\n\u0000-\u001f]/gu, ' ');
    return `Dialogue: 0,${time(start)},${time(end)},Default,,0,0,0,,${safe}`;
  });
  return [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 1920', 'WrapStyle: 0',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Microsoft YaHei,54,&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,80,80,220,1',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...lines, '',
  ].join('\n');
}

export function voicedVideoFilter(segmentCount, { rasterCues = [], audioMode = 'external_tts', segmentDurationSeconds = 15 } = {}) {
  if (!['external_tts', 'provider_native'].includes(audioMode)) throw invalid('声音来源无效');
  const nativeAudio = audioMode === 'provider_native';
  if (![15, 30].includes(segmentDurationSeconds) || (segmentDurationSeconds === 30 && (!nativeAudio || segmentCount !== 1)))
    throw invalid('视频片段时长不正确');
  if (nativeAudio && ![1, 2].includes(segmentCount)) throw invalid('原生声音需要一或两段15秒视频');
  const transition = nativeAudio && segmentCount === 2;
  const filters = [], labels = [];
  for (let i = 0; i < segmentCount; i += 1) {
    const handles = transition ? (i === 0
      ? ',tpad=stop_mode=clone:stop_duration=0.2,trim=duration=15.2'
      : ',tpad=start_mode=clone:start_duration=0.2,trim=duration=15.2') : '';
    filters.push(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p,tpad=stop_mode=clone:stop_duration=0.35,trim=duration=${segmentDurationSeconds},setpts=PTS-STARTPTS${handles},settb=AVTB[v${i}]`);
    // Native Wan already contains speech and ambience; keep that soundtrack.
    // Legacy external TTS jobs continue to use their reviewed voice tracks.
    const edgeFade = transition ? (i === 0
      ? ',afade=t=out:st=14.96:d=0.04:curve=qsin'
      : ',afade=t=in:st=0:d=0.04:curve=qsin') : '';
    filters.push(`[${nativeAudio ? i : segmentCount + i}:a]aresample=48000,apad=whole_dur=${segmentDurationSeconds},atrim=duration=${segmentDurationSeconds},asetpts=PTS-STARTPTS${edgeFade}[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  }
  if (transition) {
    filters.push('[v0][v1]xfade=transition=fade:duration=0.4:offset=14.8,trim=duration=30,format=yuv420p[voiced]');
    filters.push('[a0][a1]concat=n=2:v=0:a=1[aout]');
  } else if (nativeAudio) {
    filters.push('[v0]null[voiced]', '[a0]anull[aout]');
  } else filters.push(`${labels.join('')}concat=n=${segmentCount}:v=1:a=1[voiced][aout]`);
  // Constant relative name inside the caller-owned temp dir: no path escaping
  // in filter syntax, and no user-controlled filter expressions.
  if (rasterCues.length) {
    for (const [index, cue] of rasterCues.entries()) {
      const start = Number(cue.start), end = Number(cue.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > segmentCount * segmentDurationSeconds)
        throw invalid('字幕时间轴越界');
      const input = index === 0 ? 'voiced' : `caption${index - 1}`;
      const output = index === rasterCues.length - 1 ? 'vout' : `caption${index}`;
      // 静态PNG由overlay重复最后一帧；时间只来自校验后的数字，无文本/路径拼接。
      filters.push(`[${input}][${segmentCount * (nativeAudio ? 1 : 2) + index}:v]overlay=0:0:eof_action=repeat:repeatlast=1:enable='gte(t,${start})*lt(t,${end})'[${output}]`);
    }
  } else {
    filters.push('[voiced]ass=filename=captions.ass[vout]');
  }
  return filters.join(';');
}

export async function assertAudibleTrack({ runner, ffmpegPath, filePath, cwd, durationSeconds, startSeconds = 0 }) {
  const result = await runner(ffmpegPath, [
    '-hide_banner', '-nostdin', '-v', 'info', '-protocol_whitelist', 'file,pipe',
    '-ss', String(startSeconds), '-i', filePath, '-t', String(durationSeconds),
    '-map', '0:a:0', '-vn', '-af', 'volumedetect', '-f', 'null', '-',
  ], { cwd });
  const match = String(result?.stderr || '').match(/max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/u);
  const peakDb = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(peakDb) || peakDb <= -60) throw invalid('音轨实测为静音或无法确认有效音量');
  return { peakDb, startSeconds, durationSeconds, method: 'ffmpeg-volumedetect' };
}

export function assertVoiceProbe(result, target = 15) {
  let probe;
  try { probe = JSON.parse(String(result?.stdout || '')); } catch { throw invalid('配音音轨探测结果无效'); }
  const audio = probe?.streams?.find(s => s.codec_type === 'audio');
  const duration = Number(audio?.duration || probe?.format?.duration);
  if (!audio || !Number.isFinite(duration) || Math.abs(duration - target) > 0.25) throw invalid('配音缺少音轨或实测时长不符合15秒');
  return { duration, hasAudio: true };
}
