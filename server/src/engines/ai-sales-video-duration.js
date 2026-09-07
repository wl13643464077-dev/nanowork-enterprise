// New requests default to one native 15-second clip. Callers reading historical
// records explicitly pass 30 as the fallback; never reinterpret an old quote.
export function resolveAiSalesVideoDuration(value, fallback = 15) {
  const duration = value === undefined || value === null ? fallback : value;
  if (![15, 30].includes(duration)) throw Object.assign(new Error('带货视频时长只支持15或30秒'), {
    status: 400, code: 'AI_SALES_VIDEO_DURATION_INVALID',
  });
  return duration;
}
