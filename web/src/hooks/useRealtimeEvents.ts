import { useEffect, useRef, useSyncExternalStore } from 'react';
import { notifyCredits } from '../api/client';

/**
 * 服务端事件流（SSE）单例客户端。
 *
 * - 单个 EventSource('/api/events/stream')，同源 HttpOnly Cookie 会话鉴权；
 *   多个组件共用一条连接，页面隐藏时保持连接（服务端 25s ping 保活）。
 * - 断线后指数退避重连（1s → 2s → … → 30s 上限）；浏览器重连时自动带 Last-Event-ID，
 *   服务端按租户环形缓冲补发漏掉的事件。
 * - 事件统一转发为 window 自定义事件（沿用 credits-updated 的用法）：
 *     nanowork:task-status      detail = { kind, id, status, title, employeeIdx, ... }
 *     nanowork:inbox-changed    detail = { source }
 *     nanowork:notification     detail = { id, type, title, link }
 *     nanowork:approval         detail = { approvalId, status?, ... }（created/decided 都走这里）
 *     credits-updated           detail = { balance }（直接复用现有事件名）
 * - 暴露 connected 状态：连接失败时各处轮询自动恢复原有频率（降级兜底）。
 */

export const REALTIME_EVENTS = {
  taskStatus: 'nanowork:task-status',
  inboxChanged: 'nanowork:inbox-changed',
  notification: 'nanowork:notification',
  approval: 'nanowork:approval',
  connection: 'nanowork:realtime-connection',
} as const;

type ServerEvent = {
  id: string;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
};

const STREAM_URL = '/api/events/stream';
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const SERVER_EVENT_TYPES = [
  'task.status_changed',
  'approval.created',
  'approval.decided',
  'notification.created',
  'credits.updated',
  'inbox.changed',
] as const;

let source: EventSource | null = null;
let consumers = 0;
let connected = false;
let reconnectTimer = 0;
let reconnectAttempt = 0;
let stopped = true;
const listeners = new Set<(value: boolean) => void>();

function setConnected(value: boolean) {
  if (connected === value) return;
  connected = value;
  for (const listener of listeners) listener(value);
  window.dispatchEvent(new CustomEvent(REALTIME_EVENTS.connection, { detail: { connected: value } }));
}

function dispatch(name: string, detail: unknown) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function parseServerEvent(data: string): ServerEvent | null {
  try {
    const parsed = JSON.parse(data) as ServerEvent;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function handleServerEvent(raw: MessageEvent<string>) {
  const event = parseServerEvent(raw.data);
  if (!event) return;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  switch (event.type) {
    case 'task.status_changed':
      dispatch(REALTIME_EVENTS.taskStatus, payload);
      break;
    case 'inbox.changed':
      dispatch(REALTIME_EVENTS.inboxChanged, payload);
      break;
    case 'notification.created':
      dispatch(REALTIME_EVENTS.notification, payload);
      break;
    case 'approval.created':
    case 'approval.decided':
      dispatch(REALTIME_EVENTS.approval, { ...payload, event: event.type });
      dispatch(REALTIME_EVENTS.inboxChanged, { source: event.type });
      break;
    case 'credits.updated': {
      const balance = Number((payload as { balance?: unknown }).balance);
      if (Number.isFinite(balance)) notifyCredits(balance);
      break;
    }
    default:
      break;
  }
}

function teardownSource() {
  if (!source) return;
  source.close();
  source = null;
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempt, 5));
  reconnectAttempt += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    connect();
  }, delay);
}

function connect() {
  if (stopped || source || typeof EventSource === 'undefined') return;
  // 浏览器 EventSource 自带 Last-Event-ID 重连；这里只负责在其放弃（readyState CLOSED）后重建。
  const next = new EventSource(STREAM_URL, { withCredentials: true });
  source = next;
  next.addEventListener('ready', () => {
    reconnectAttempt = 0;
    setConnected(true);
  });
  for (const type of SERVER_EVENT_TYPES) {
    next.addEventListener(type, handleServerEvent as EventListener);
  }
  next.addEventListener('replaced', () => {
    // 同一账号第 4 个标签页把本连接顶掉：不再自动重连，避免互相踢来踢去；轮询兜底仍在。
    stopped = true;
    teardownSource();
    setConnected(false);
  });
  next.onerror = () => {
    setConnected(false);
    if (next.readyState === EventSource.CLOSED) {
      teardownSource();
      scheduleReconnect();
    }
  };
}

function start() {
  stopped = false;
  connect();
}

function stop() {
  stopped = true;
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = 0;
  }
  teardownSource();
  setConnected(false);
}

/** 当前是否已建立实时连接（非 hook 场景使用）。 */
export function realtimeConnected() {
  return connected;
}

function getConnected() {
  return connected;
}

function subscribeConnection(onChange: () => void) {
  const listener = () => onChange();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 挂载一次即可（MainLayout）；其他组件可重复调用只读 connected，不会多开连接。
 */
export function useRealtimeEvents(options: { enabled?: boolean } = {}) {
  const enabled = options.enabled !== false;
  // 连接状态是模块级外部状态：用 useSyncExternalStore 订阅，避免在 effect 里同步 setState
  const isConnected = useSyncExternalStore(subscribeConnection, getConnected, getConnected);

  useEffect(() => {
    if (!enabled) return undefined;
    consumers += 1;
    if (consumers === 1) start();
    return () => {
      consumers -= 1;
      if (consumers === 0) stop();
    };
  }, [enabled]);

  return { connected: isConnected };
}

/**
 * 订阅某一类实时事件的便捷 hook：handler 变化不会重建监听器。
 */
export function useRealtimeEvent<T = Record<string, unknown>>(
  name: (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS],
  handler: (detail: T) => void,
) {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  useEffect(() => {
    const listener = (event: Event) => handlerRef.current((event as CustomEvent<T>).detail);
    window.addEventListener(name, listener);
    return () => window.removeEventListener(name, listener);
  }, [name]);
}
