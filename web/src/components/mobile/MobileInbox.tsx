import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Input, Modal, Skeleton, Tag, message } from 'antd';
import { ReloadOutlined, RightOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { api } from '../../api/client';
import { REALTIME_EVENTS, useRealtimeEvent } from '../../hooks/useRealtimeEvents';
import {
  INBOX_PRIORITY_LABEL,
  batchAdoptAction,
  isBatchAdoptable,
  runInboxAction,
  type InboxAction,
  type InboxItem,
  type InboxResponse,
} from '../InboxDrawer';
import { mobilePath, toMobilePath } from './mobileRoutes';
import './mobile.css';

// 待办 Tab：直接复用统一收件箱 GET /api/inbox。每张卡内联后端下发的 actions，
// 成功即移除卡片并 toast；顶部按来源 chips 筛选；「全部采纳低风险」保留并二次确认。

// 请求序号放在模块级：页面同时只挂一个待办 Tab，用于丢弃迟到的旧响应
let inboxRequestSerial = 0;

export default function MobileInbox({ nav, onChanged }: { nav: (path: string) => void; onChanged?: () => void }) {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [activeKind, setActiveKind] = useState('all');
  const [busyKey, setBusyKey] = useState('');
  const [batchRunning, setBatchRunning] = useState(false);
  const [reasonTarget, setReasonTarget] = useState<{ item: InboxItem; action: InboxAction } | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback((background = false) => {
    const ticket = ++inboxRequestSerial;
    if (background) setRefreshing(true);
    api
      .get('/inbox?limit=200', { silent: true })
      .then((response: InboxResponse) => {
        if (ticket !== inboxRequestSerial) return;
        setData(response);
        setError('');
      })
      .catch((err: Error) => {
        if (ticket === inboxRequestSerial && !background) setError(err.message || '待办加载失败');
      })
      .finally(() => {
        if (ticket !== inboxRequestSerial) return;
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useRealtimeEvent(REALTIME_EVENTS.inboxChanged, () => load(true));
  useRealtimeEvent(REALTIME_EVENTS.taskStatus, () => load(true));

  const items = useMemo(() => data?.items || [], [data]);
  const visible = useMemo(
    () => (activeKind === 'all' ? items : items.filter(item => item.kind === activeKind)),
    [items, activeKind],
  );
  const grouped = useMemo(() => {
    const groups = new Map<string, { label: string; items: InboxItem[] }>();
    for (const item of visible) {
      const group = groups.get(item.kind) || { label: item.kindLabel, items: [] };
      group.items.push(item);
      groups.set(item.kind, group);
    }
    return [...groups.entries()];
  }, [visible]);
  const batchCandidates = useMemo(() => items.filter(isBatchAdoptable), [items]);
  const total = data?.total ?? items.length;

  const removeItem = (key: string) => {
    setData(previous => {
      if (!previous) return previous;
      const nextItems = previous.items.filter(item => item.key !== key);
      return { ...previous, items: nextItems, total: Math.max(0, (previous.total || nextItems.length + 1) - 1) };
    });
  };
  const afterChange = () => {
    load(true);
    onChanged?.();
  };

  const execute = async (item: InboxItem, action: InboxAction, extra: Record<string, unknown> = {}) => {
    setBusyKey(`${item.key}:${action.key}`);
    try {
      await runInboxAction(action, extra);
      removeItem(item.key);
      message.success(`${action.label}成功：${item.title}`);
      afterChange();
    } catch (err) {
      message.error(`${item.title}：${err instanceof Error ? err.message : `${action.label}失败`}`);
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
      const action = batchAdoptAction(item);
      if (!action) continue;
      try {
        await runInboxAction(action);
        removeItem(item.key);
        ok += 1;
      } catch (err) {
        message.error(`${item.title}：${err instanceof Error ? err.message : '采纳失败'}`);
      }
    }
    setBatchRunning(false);
    if (ok) message.success(`已采纳 ${ok} 项低风险事项`);
    afterChange();
  };
  const confirmBatch = () => {
    Modal.confirm({
      title: `一次采纳 ${batchCandidates.length} 项低风险事项？`,
      content: '只对低风险且带“通过/采纳”动作的事项逐条调用权威端点；失败会逐条提示，不会跳过人工审阅规则。',
      okText: '确认采纳',
      cancelText: '再看看',
      onOk: () => void adoptLowRisk(),
    });
  };

  const openLink = (item: InboxItem) => {
    const target = toMobilePath(item.link);
    if (target) nav(target);
  };

  return (
    <div className="m-stack">
      <div className="m-inbox-head">
        <strong>待我处理 {total > 0 ? `${total} 件` : ''}</strong>
        <div className="m-actions-row">
          <Button size="small" icon={<ReloadOutlined />} loading={refreshing} onClick={() => load(true)}>
            刷新
          </Button>
          {batchCandidates.length > 0 && (
            <Button
              size="small"
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={batchRunning}
              onClick={() => confirmBatch()}
            >
              全部采纳低风险（{batchCandidates.length}）
            </Button>
          )}
        </div>
      </div>
      {data && data.kinds?.some(kind => kind.count > 0) && (
        <div className="m-chips" role="tablist" aria-label="按来源筛选">
          <button
            type="button"
            role="tab"
            aria-selected={activeKind === 'all'}
            className={`m-chip${activeKind === 'all' ? ' m-chip--active' : ''}`}
            onClick={() => setActiveKind('all')}
          >
            全部<span className="m-chip-count">{total}</span>
          </button>
          {data.kinds
            .filter(kind => kind.count > 0)
            .map(kind => (
              <button
                key={kind.kind}
                type="button"
                role="tab"
                aria-selected={activeKind === kind.kind}
                className={`m-chip${activeKind === kind.kind ? ' m-chip--active' : ''}`}
                onClick={() => setActiveKind(kind.kind)}
              >
                {kind.label}
                <span className="m-chip-count">{kind.count}</span>
              </button>
            ))}
        </div>
      )}
      {loading && !data ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : error && !data ? (
        <Alert
          type="error"
          showIcon
          message="待办加载失败"
          description={error}
          action={<Button onClick={() => load()}>重试</Button>}
        />
      ) : !grouped.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有需要你处理的事，去看看任务进展吧">
          <Button type="link" onClick={() => nav(mobilePath('tasks'))}>
            看任务 →
          </Button>
        </Empty>
      ) : (
        grouped.map(([kind, group]) => (
          <section key={kind} aria-label={group.label}>
            <div className="m-inbox-kind">
              {group.label} · {group.items.length}
            </div>
            <div className="m-stack">
              {group.items.map(item => (
                <article key={item.key} className={`m-inbox-card m-inbox-card--${item.priority}`}>
                  <div className="m-inbox-card-title">
                    <Tag color={item.priority === 'high' ? 'red' : item.priority === 'low' ? 'green' : 'orange'}>
                      {INBOX_PRIORITY_LABEL[item.priority]}
                    </Tag>
                    <span>{item.title}</span>
                  </div>
                  {item.subtitle && <div className="m-inbox-card-sub">{item.subtitle}</div>}
                  <div className="m-inbox-card-meta">
                    {item.createdAt && <span>{String(item.createdAt).replace('T', ' ').slice(5, 16)}</span>}
                    {item.dueAt && <span>截止 {String(item.dueAt).replace('T', ' ').slice(5, 16)}</span>}
                  </div>
                  <div className="m-inbox-card-actions">
                    {item.actions.map(action => (
                      <Button
                        key={action.key}
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
                      <Button type="text" icon={<RightOutlined />} onClick={() => openLink(item)}>
                        查看
                      </Button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))
      )}
      <Modal
        open={Boolean(reasonTarget)}
        title={reasonTarget ? `${reasonTarget.action.label}：${reasonTarget.item.title}` : ''}
        okText="确认"
        cancelText="取消"
        onCancel={() => setReasonTarget(null)}
        onOk={() => void submitReason()}
        destroyOnHidden
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
    </div>
  );
}
