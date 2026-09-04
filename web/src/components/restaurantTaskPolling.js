export const RESTAURANT_TASK_POLL_INTERVAL_MS = 5_000;
// SSE 实时推送在线时的兜底轮询间隔；断连后组件自动回到 RESTAURANT_TASK_POLL_INTERVAL_MS
export const RESTAURANT_TASK_REALTIME_POLL_INTERVAL_MS = 20_000;
export const RESTAURANT_TASK_POLL_MAX_DELAY_MS = 30_000;

function safeFailureCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 1;
  return Math.min(99, Math.trunc(count));
}

/**
 * Failed status reads use bounded exponential backoff. This only controls the
 * next read; it never changes the task's authoritative business status.
 */
export function restaurantTaskPollRetryDelay(consecutiveFailures) {
  const failureCount = safeFailureCount(consecutiveFailures);
  const multiplier = 2 ** Math.min(failureCount - 1, 8);
  return Math.min(RESTAURANT_TASK_POLL_MAX_DELAY_MS, RESTAURANT_TASK_POLL_INTERVAL_MS * multiplier);
}

/**
 * Returns a presentation-only warning. Deliberately accepts no raw error so a
 * provider URL, credential or internal response can never be echoed into UI.
 */
export function buildRestaurantTaskPollWarning(consecutiveFailures) {
  const failureCount = safeFailureCount(consecutiveFailures);
  const retryDelayMs = restaurantTaskPollRetryDelay(failureCount);
  const retrySeconds = Math.ceil(retryDelayMs / 1_000);
  return {
    kind: 'transport_warning',
    terminal: false,
    consecutiveFailures: failureCount,
    retryDelayMs,
    retrySeconds,
    title: '进度同步暂时中断',
    detail: `页面暂时保留上次确认的“生成中”状态；本次同步失败不代表任务失败。系统将在 ${retrySeconds} 秒后自动重试，恢复连接后会刷新服务端的权威状态。`,
  };
}
