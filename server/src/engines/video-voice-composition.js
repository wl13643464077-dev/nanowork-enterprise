const invalid = message => Object.assign(new Error(message), { code: 'AI_SALES_VIDEO_COMPOSER_AUDIO_INVALID', status: 502 });

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

export function voicedVideoFilter(segmentCount) {
  const filters = [], labels = [];
  for (let i = 0; i < segmentCount; i += 1) {
    filters.push(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p,tpad=stop_mode=clone:stop_duration=0.35,trim=duration=15,setpts=PTS-STARTPTS[v${i}]`);
    // Use the exact reviewed TTS tracks, not arbitrary vendor background speech.
    filters.push(`[${segmentCount + i}:a]aresample=48000,apad=whole_dur=15,atrim=duration=15,asetpts=PTS-STARTPTS[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  }
  filters.push(`${labels.join('')}concat=n=${segmentCount}:v=1:a=1[voiced][aout]`);
  // Constant relative name inside the caller-owned temp dir: no path escaping
  // in filter syntax, and no user-controlled filter expressions.
  filters.push('[voiced]ass=filename=captions.ass[vout]');
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
