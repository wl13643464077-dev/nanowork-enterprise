import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Drawer, Empty, Input, Modal, Tag, Tooltip, message } from 'antd';
import { InboxOutlined, ReloadOutlined, RightOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { REALTIME_EVENTS, useRealtimeEvent } from '../hooks/useRealtimeEvents';
import './InboxDrawer.css';

/**
 * 统一"待我处理"收件箱（/api/inbox）。
 *
 * - 只展示当前用户现在就能处理的事项；每张卡的按钮直接调用后端下发的 actions，
 *   前端不判断"能不能批"，也不新造决策逻辑（D-037）。
 * - 计数来自 /api/inbox/count 的权威投影，收到 nanowork:inbox-changed 事件即刷新（D-046）；
 *   实时连接不可用时按 INBOX_COUNT_FALLBACK_MS 轮询兜底。
 */

export type InboxAction = {
  key: string;
  label: string;
  method: 'POST' | 'PUT' | 'DELETE' | 'GET';
  path: string;
  body?: Record<string, unknown>;
  requiresReason?: boolean;
  danger?: boolean;
};

export type InboxItem = {
  key: string;
  kind: string;
  kindLabel: string;
  id: number;
  title: string;
  subtitle: string;
  createdAt: string | null;
  dueAt: string | null;
  priority: 'high' | 'medium' | 'low';
  actions: InboxAction[];
  link: string | null;
};

export type InboxResponse = {
  items: InboxItem[];
  total: number;
  counts: Record<string, number>;
  kinds: { kind: string; label: string; count: number }[];
  lowRiskAdoptable: number;
};

export const INBOX_COUNT_FALLBACK_MS = 5 * 60 * 1000;
export const INBOX_COUNT_REALTIME_FALLBACK_MS = 15 * 60 * 1000;
export const INBOX_PRIORITY_LABEL: Record<InboxItem['priority'], string> = {
  high: '高风险',
  medium: '中',
  low: '低风险',
};
const PRIORITY_LABEL = INBOX_PRIORITY_LABEL;
const BATCH_ACTION_KEYS = new Set(['approve', 'adopt']);

function apiPath(path: string) {
  return path.startsWith('/api/') ? path.slice(4) : path;
}

// 移动端待办（components/mobile/MobileInbox）复用同一套动作执行与批量白名单，不另造决策逻辑
export async function runInboxAction(action: InboxAction, extra: Record<string, unknown> = {}) {
  const url = apiPath(action.path);
  const body = { ...(action.body || {}), ...extra };
  switch (action.method) {
    case 'PUT':
      return api.put(url, body, { silent: true });
    case 'DELETE':
      return api.del(url, { silent: true });
    case 'GET':
      return api.get(url, { silent: true });
    default:
      return api.post(url, body, { silent: true });
  }
}

export function isBatchAdoptable(item: InboxItem) {
  return item.priority === 'low' && item.actions.some(action => BATCH_ACTION_KEYS.has(action.key));
}

export function batchAdoptAction(item: InboxItem) {
  return item.actions.find(action => BATCH_ACTION_KEYS.has(action.key)) || null;
}

/**
 * 顶栏角标用：权威计数 + 事件驱动刷新 + 轮询兜底。
 */
export function useInboxCount(realtimeConnected: boolean) {
  const [count, setCount] = useState(0);
  const [lowRisk, setLowRisk] = useState(0);
  const refresh = useCallback(() => {
    api
      .get('/inbox/count', { silent: true })
      .then((data: { total?: number; lowRiskAdoptable?: number }) => {
        setCount(Number(data?.total) || 0);
        setLowRisk(Number(data?.lowRiskAdoptable) || 0);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    const interval = realtimeConnected ? INBOX_COUNT_REALTIME_FALLBACK_MS : INBOX_COUNT_FALLBACK_MS;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, interval);
    return () => window.clearInterval(timer);
  }, [realtimeConnected, refresh]);
  useRealtimeEvent(REALTIME_EVENTS.inboxChanged, refresh);
  useRealtimeEvent(REALTIME_EVENTS.taskStatus, refresh);
  return { count, lowRisk, refresh };
}

export function InboxTrigger({
  count,
  onClick,
  connected,
}: {
  count: number;
  onClick: () => void;
  connected: boolean;
}) {
  return (
    <Tooltip title={connected ? '待我处理（实时）' : '待我处理（轮询同步中）'}>
      <Badge count={count} size="small" overflowCount={99}>
        <button
          type="button"
          className={`os-icon-btn inbox-trigger ${connected ? 'inbox-trigger--live' : ''}`}
          aria-label={`打开待我处理，当前 ${count} 项`}
          onClick={onClick}
        >
          <InboxOutlined className="os-ic" />
        </button>
      </Badge>
    </Tooltip>
  );
}

export default function InboxDrawer({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const nav = useNavigate();
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeKind, setActiveKind] = useState('all');
  const [busyKey, setBusyKey] = useState('');
  const [batchRunning, setBatchRunning] = useState(false);
  const [reasonTarget, setReasonTarget] = useState<{ item: InboxItem; action: InboxAction } | null>(null);
  const [reason, setReason] = useState('');
  const requestSerial = useRef(0);

  const load = useCallback((background = false) => {
    const serial = ++requestSerial.current;
    if (!background) setLoading(true);
    api
      .get('/inbox?limit=200', { silent: true })
      .then((response: InboxResponse) => {
        if (serial !== requestSerial.current) return;
        setData(response);
      })
      .catch(() => {})
      .finally(() => {
        if (serial === requestSerial.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setTimeout(() => load(), 0);
    return () => window.clearTimeout(timer);
  }, [open, load]);
  useRealtimeEvent(REALTIME_EVENTS.inboxChanged, () => {
    if (open) load(true);
  });

  const grouped = useMemo(() => {
    const items = data?.items || [];
    const visible = activeKind === 'all' ? items : items.filter(item => item.kind === activeKind);
    const groups = new Map<string, { label: string; items: InboxItem[] }>();
    for (const item of visible) {
      const group = groups.get(item.kind) || { label: item.kindLabel, items: [] };
      group.items.push(item);
      groups.set(item.kind, group);
    }
    return [...groups.entries()];
  }, [data, activeKind]);
  const batchCandidates = useMemo(() => (data?.items || []).filter(isBatchAdoptable), [data]);

  const afterChange = () => {
    load(true);
    onChanged?.();
  };

  const execute = async (item: InboxItem, action: InboxAction, extra: Record<string, unknown> = {}) => {
    setBusyKey(`${item.key}:${action.key}`);
    try {
      await runInboxAction(action, extra);
      message.success(`${item.title}：${action.label}成功`);
      afterChange();
    } catch (error) {
      message.error(`${item.title}：${error instanceof Error ? error.message : `${action.label}失败`}`);
    } finally {
      setBusyKey('');
    }
  };

  const onAction = (item: InboxItem, action: InboxAction) => {
    if (action.requiresReason) {
      setReason('');
      setReasonTarget({ item, action });
      return;
    }
    void execute(item, action);
  };

  const submitReason = async () => {
    if (!reasonTarget) return;
    const text = reason.trim();
    if (!text) {
      message.warning('请填写理由');
      return;
    }
    const target = reasonTarget;
    setReasonTarget(null);
    await execute(target.item, target.action, { reason: text, opinion: text });
  };

  const adoptLowRisk = async () => {
    if (!batchCandidates.length) return;
    setBatchRunning(true);
    let ok = 0;
    for (const item of batchCandidates) {
      const action = item.actions.find(entry => BATCH_ACTION_KEYS.has(entry.key));
      if (!action) continue;
      try {
        await runInboxAction(action);
        ok += 1;
      } catch (error) {
        message.error(`${item.title}：${error instanceof Error ? error.message : '采纳失败'}`);
      }
    }
    setBatchRunning(false);
    if (ok) message.success(`已采纳 ${ok} 项低风险事项`);
    afterChange();
  };

  const openLink = (item: InboxItem) => {
    if (!item.link) return;
    onClose();
    nav(item.link);
  };

  const total = data?.total ?? 0;

  return (
    <Drawer
      className="inbox-drawer"
      rootClassName="inbox-drawer-root"
      width={520}
      open={open}
      onClose={onClose}
      title={
        <span className="inbox-title">
          <InboxOutlined /> 待我处理
          <Tag className="inbox-total">{total} 项</Tag>
        </span>
      }
      extra={
        <div className="inbox-extra">
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => load()}>
            刷新
          </Button>
          <Tooltip title="仅对低风险且带“通过/采纳”动作的事项逐条调用权威端点；失败会逐条提示">
            <Button
              size="small"
              type="primary"
              icon={<ThunderboltOutlined />}
              disabled={!batchCandidates.length}
              loading={batchRunning}
              onClick={() => void adoptLowRisk()}
            >
              全部采纳低风险（{batchCandidates.length}）
            </Button>
          </Tooltip>
        </div>
      }
    >
      <div className="inbox-filters" role="tablist" aria-label="按来源筛选">
        <button
          type="button"
          role="tab"
          aria-selected={activeKind === 'all'}
          className={`inbox-filter ${activeKind === 'all' ? 'inbox-filter--active' : ''}`}
          onClick={() => setActiveKind('all')}
        >
          全部 <span className="inbox-filter-count">{total}</span>
        </button>
        {(data?.kinds || [])
          .filter(kind => kind.count > 0)
          .map(kind => (
            <button
              key={kind.kind}
              type="button"
              role="tab"
              aria-selected={activeKind === kind.kind}
              className={`inbox-filter ${activeKind === kind.kind ? 'inbox-filter--active' : ''}`}
              onClick={() => setActiveKind(kind.kind)}
            >
              {kind.label} <span className="inbox-filter-count">{kind.count}</span>
            </button>
          ))}
      </div>

      {data && !grouped.length && (
        <Empty
          className="inbox-empty"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="没有需要你处理的事，去看看今天的经营诊断吧"
        >
          <Button
            type="link"
            onClick={() => {
              onClose();
              nav('/analysis');
            }}
          >
            打开经营洞察 →
          </Button>
        </Empty>
      )}

      {grouped.map(([kind, group]) => (
        <section key={kind} className="inbox-group" aria-label={group.label}>
          <div className="inbox-group-head">
            <span className="inbox-group-title">{group.label}</span>
            <Tag className="inbox-group-count">{group.items.length}</Tag>
          </div>
          {group.items.map(item => (
            <article key={item.key} className={`inbox-card inbox-card--${item.priority}`}>
              <div className="inbox-card-main">
                <div className="inbox-card-title-row">
                  <Tag className={`inbox-priority inbox-priority--${item.priority}`}>
                    {PRIORITY_LABEL[item.priority]}
                  </Tag>
                  <span className="inbox-card-title">{item.title}</span>
                </div>
                {item.subtitle && <div className="inbox-card-sub">{item.subtitle}</div>}
                <div className="inbox-card-meta">
                  {item.createdAt && <span>{String(item.createdAt).slice(5, 16)}</span>}
                  {item.dueAt && <span>截止 {String(item.dueAt).slice(5, 16)}</span>}
                </div>
              </div>
              <div className="inbox-card-actions">
                {item.actions.map(action => (
                  <Button
                    key={action.key}
                    size="small"
                    type={action.danger ? 'default' : 'primary'}
                    danger={action.danger}
                    loading={busyKey === `${item.key}:${action.key}`}
                    disabled={Boolean(busyKey) && busyKey !== `${item.key}:${action.key}`}
                    onClick={() => onAction(item, action)}
                  >
                    {action.label}
                  </Button>
                ))}
                {item.link && (
                  <Button size="small" type="text" icon={<RightOutlined />} onClick={() => openLink(item)}>
                    查看
                  </Button>
                )}
              </div>
            </article>
          ))}
        </section>
      ))}

      <Modal
        open={Boolean(reasonTarget)}
        title={reasonTarget ? `${reasonTarget.action.label}：${reasonTarget.item.title}` : ''}
        okText="确认"
        cancelText="取消"
        onCancel={() => setReasonTarget(null)}
        onOk={() => void submitReason()}
        destroyOnClose
      >
        <Input.TextArea
          value={reason}
          onChange={event => setReason(event.target.value)}
          placeholder="请填写理由（会记录到审核记录并通知提交人）"
          autoSize={{ minRows: 3, maxRows: 6 }}
          maxLength={1000}
          showCount
        />
      </Modal>
    </Drawer>
  );
}
