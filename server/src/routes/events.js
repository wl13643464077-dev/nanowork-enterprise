// ===== GET /api/events/stream：服务端事件推送（SSE）=====
//
// 协议：
// - Content-Type: text/event-stream；Cache-Control: no-cache, no-transform；X-Accel-Buffering: no
// - 连接建立后先发 `retry: 3000` 与一条 `event: ready`（含 lastEventId 与服务器时间）
// - 业务事件格式：`id: <单调序号>\nevent: <type>\ndata: <json>\n\n`，type 见 event-bus.EVENT_TYPES
// - 每 25s 发 `: ping` 注释保活（穿透 Caddy/浏览器空闲超时）
// - 支持 Last-Event-ID 头（浏览器 EventSource 自动携带）或 ?lastEventId= 查询参数：
//   重连时补发该租户环形缓冲（最近 200 条）中 id 更大且对当前用户可见的事件
// - 每用户最多 3 条并发连接，超出时关闭最旧的一条（event: replaced）
//
// 中间件：authMiddleware + tenantScope（+ tenantGate），绝不经过 guardFor AI 限流，
// 也不占用 ai-limits 并发租约——长连接不是 AI 生成请求。
import { Router } from "express";
import {
  registerSseConnection,
  replaySince,
  subscribe,
  unregisterSseConnection,
  visibleTo,
} from "../engines/event-bus.js";

const DEFAULT_PING_MS = 25_000;
// 仅测试环境允许缩短保活间隔（默认 25s），生产不读该变量以免误配成高频空写。
export const SSE_PING_INTERVAL_MS =
  process.env.NODE_ENV === "test" && Number(process.env.SSE_PING_INTERVAL_MS) > 0
    ? Number(process.env.SSE_PING_INTERVAL_MS)
    : DEFAULT_PING_MS;
export const SSE_MAX_CONNECTIONS_PER_USER = 3;
export const SSE_RETRY_MS = 3_000;

const router = Router();

function serializeEvent(event) {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({
    id: event.id,
    type: event.type,
    ts: event.ts,
    payload: event.payload,
  })}\n\n`;
}

function lastEventIdFrom(req) {
  const header = String(req.get("Last-Event-ID") || "").trim();
  const query = String(req.query?.lastEventId || "").trim();
  const raw = header || query;
  return /^\d{1,18}$/.test(raw) ? Number(raw) : null;
}

router.get("/stream", (req, res) => {
  const user = req.user;
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;
  const write = (chunk) => {
    if (closed || res.writableEnded || res.destroyed) return false;
    try {
      res.write(chunk);
      return true;
    } catch {
      return false;
    }
  };

  const handle = {
    userId: Number(user.id),
    openedAt: Date.now(),
    close(reason = "closed") {
      if (closed) return;
      closed = true;
      clearInterval(pingTimer);
      unsubscribe();
      unregisterSseConnection(user.id, handle);
      try {
        if (!res.writableEnded && !res.destroyed) {
          res.write(`event: ${reason}\ndata: {}\n\n`);
          res.end();
        }
      } catch {
        /* socket already gone */
      }
    },
  };

  const evicted = registerSseConnection(user.id, handle, {
    maxPerUser: SSE_MAX_CONNECTIONS_PER_USER,
  });
  for (const old of evicted) old.close("replaced");

  const unsubscribe = subscribe((event) => {
    if (!visibleTo(event, user)) return;
    write(serializeEvent(event));
  });

  const pingTimer = setInterval(() => {
    if (!write(": ping\n\n")) handle.close();
  }, SSE_PING_INTERVAL_MS);
  pingTimer.unref?.();

  write(`retry: ${SSE_RETRY_MS}\n\n`);
  const lastEventId = lastEventIdFrom(req);
  write(
    `event: ready\ndata: ${JSON.stringify({
      serverTime: new Date().toISOString(),
      lastEventId,
      pingIntervalMs: SSE_PING_INTERVAL_MS,
    })}\n\n`,
  );
  if (lastEventId !== null) {
    for (const event of replaySince(user.tenant_id, lastEventId)) {
      if (visibleTo(event, user)) write(serializeEvent(event));
    }
  }

  req.on("close", () => handle.close());
  res.on("error", () => handle.close());
});

export default router;
