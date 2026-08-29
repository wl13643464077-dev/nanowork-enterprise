import {
  ArrowRightOutlined,
  FileSearchOutlined,
  LockOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Button, Drawer, Skeleton } from 'antd';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import './BusinessFlowTrace.css';

export type BusinessFlowSourceType = 'restaurant_task' | 'content_run' | 'manual_task' | 'advisor_message';

export interface BusinessFlowTraceProps {
  sourceType?: BusinessFlowSourceType | null;
  sourceId?: number | null;
  open: boolean;
  onClose: () => void;
}

type FlowNode = {
  id: string;
  kind: string;
  label: string;
  status: string;
  occurredAt: string | null;
  href: string | null;
};

type FlowLink = {
  from: string;
  to: string;
  relation: FlowRelation;
};

type BusinessFlow = {
  schemaVersion: 'nanowork.business-flow.v1';
  source: { type: BusinessFlowSourceType; id: number; label: string };
  status: { code: string; label: string; terminal: boolean };
  nextAction: { code: string; label: string; href: string | null };
  hasDownstream: boolean;
  emptyState: { code: 'no_downstream'; message: string } | null;
  nodes: FlowNode[];
  links: FlowLink[];
};

type ViewState =
  | { phase: 'idle' | 'loading'; data: null; message: '' }
  | { phase: 'success'; data: BusinessFlow; message: '' }
  | { phase: 'not_found' | 'forbidden' | 'error'; data: null; message: string };

type ResolvedViewState = Exclude<ViewState, { phase: 'idle' | 'loading' }> & { queryKey: string };

type FlowRelation =
  'produced' | 'billing' | 'reviewed_by' | 'archived_as' | 'converted_to' | 'decomposed_to' | 'submitted_as';

const SOURCE_TYPES = new Set<BusinessFlowSourceType>([
  'restaurant_task',
  'content_run',
  'manual_task',
  'advisor_message',
]);

const RELATION_LABELS: Record<FlowRelation, string> = {
  produced: '形成产出',
  billing: '进入账务',
  reviewed_by: '进入审阅',
  archived_as: '沉淀为素材',
  converted_to: '转为执行任务',
  decomposed_to: '拆解为下级任务',
  submitted_as: '提交执行结果',
};

const SOURCE_LABELS: Record<BusinessFlowSourceType, string> = {
  restaurant_task: '门店任务',
  content_run: '内容生产',
  manual_task: '管理任务',
  advisor_message: '总参谋会诊',
};

const NODE_KIND_LABELS: Record<string, string> = {
  restaurant_task: '门店任务',
  manual_task: '管理任务',
  content_run: '内容生产任务',
  content: '内容结果',
  review: '人工审阅',
  approval: '审阅节点',
  material: '素材沉淀',
  asset: '业务资产',
  billing: '积分账务',
  advisor_conversation: '会诊对话',
  advisor_message: '会诊结论',
  submission: '结果提交',
  management_source: '管理层来源',
};

const LINK_RELATIONS = new Set<FlowRelation>(Object.keys(RELATION_LABELS) as FlowRelation[]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value: unknown, maxLength = 160): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

const OPERATIONAL_STATUS_LABELS: Record<string, string> = {
  blocked_pending_privileged_review: '待老板或管理员复核',
  draft_pending_human_review: '待人工审阅',
  pending_human_review: '待人工审阅',
  pending_settlement: '待结算',
  pending_release: '待释放预授权',
  pending_reconciliation: '业务暂不可采用（待账务对账）',
  needs_review: '需人工复核',
  compliant: '符合要求',
  blocked: '需补齐业务条件',
  settled: '已结算',
  released: '已释放',
  clear: '无异常',
  pass: '已通过',
};

function publicStatusText(value: unknown, maxLength = 160): string {
  let result = safeText(value, maxLength);
  for (const [status, label] of Object.entries(OPERATIONAL_STATUS_LABELS).sort(
    ([left], [right]) => right.length - left.length,
  )) {
    result = result.replace(new RegExp(`\\b${status}\\b`, 'gu'), label);
  }
  return result;
}

function safeInternalHref(value: unknown): string | null {
  const href = safeText(value, 420);
  return href.startsWith('/') && !href.startsWith('//') ? href : null;
}

function normalizeNode(value: unknown): FlowNode | null {
  if (!isRecord(value)) return null;
  const id = safeText(value.id, 120);
  const kind = safeText(value.kind, 48);
  const label = safeText(value.label, 120);
  const status = publicStatusText(value.status, 64);
  if (!id || !kind || !label || !status) return null;
  return {
    id,
    kind,
    label,
    status,
    occurredAt: safeText(value.occurredAt, 48) || null,
    href: safeInternalHref(value.href),
  };
}

function normalizeLink(value: unknown, nodeIds: Set<string>): FlowLink | null {
  if (!isRecord(value)) return null;
  const from = safeText(value.from, 120);
  const to = safeText(value.to, 120);
  const relation = safeText(value.relation, 40) as FlowRelation;
  if (!nodeIds.has(from) || !nodeIds.has(to) || !LINK_RELATIONS.has(relation)) return null;
  return { from, to, relation };
}

function normalizeFlow(value: unknown, expectedType: BusinessFlowSourceType, expectedId: number): BusinessFlow {
  if (!isRecord(value) || value.schemaVersion !== 'nanowork.business-flow.v1') {
    throw new Error('业务流数据格式不正确');
  }
  const source = value.source;
  const status = value.status;
  const nextAction = value.nextAction;
  if (!isRecord(source) || !isRecord(status) || !isRecord(nextAction)) {
    throw new Error('业务流数据不完整');
  }

  const sourceType = safeText(source.type, 40) as BusinessFlowSourceType;
  const sourceId = Number(source.id);
  const sourceLabel = safeText(source.label, 120);
  if (sourceType !== expectedType || sourceId !== expectedId || !sourceLabel) {
    throw new Error('业务流来源校验失败');
  }

  const nodes = Array.isArray(value.nodes)
    ? value.nodes.map(normalizeNode).filter((node): node is FlowNode => Boolean(node))
    : [];
  if (nodes.length === 0) throw new Error('业务流节点为空');
  const nodeIds = new Set(nodes.map(node => node.id));
  const links = Array.isArray(value.links)
    ? value.links.map(link => normalizeLink(link, nodeIds)).filter((link): link is FlowLink => Boolean(link))
    : [];

  const emptyState = isRecord(value.emptyState)
    ? {
        code: 'no_downstream' as const,
        message: safeText(value.emptyState.message, 180) || '当前记录还没有产生后续业务数据。',
      }
    : null;

  return {
    schemaVersion: 'nanowork.business-flow.v1',
    source: { type: sourceType, id: sourceId, label: sourceLabel },
    status: {
      code: safeText(status.code, 48),
      label: publicStatusText(status.label, 64) || '状态未知',
      terminal: status.terminal === true,
    },
    nextAction: {
      code: safeText(nextAction.code, 48),
      label: safeText(nextAction.label, 120) || '查看相关业务',
      href: safeInternalHref(nextAction.href),
    },
    hasDownstream: value.hasDownstream === true,
    emptyState,
    nodes,
    links,
  };
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'running' | 'neutral' {
  if (/失败|驳回|返工|未通过|异常|取消/.test(status)) return 'danger';
  if (/待审|待验收|待人工验收|待账务对账|待对账|待派活|待执行|待处理|待确认/.test(status)) return 'warning';
  if (/执行中|生成中|进行中|处理中/.test(status)) return 'running';
  if (/完成|通过|采纳|可使用|已发布|已结算|已归档/.test(status)) return 'success';
  return 'neutral';
}

function formatTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function ErrorState({ phase, message, onRetry }: { phase: ViewState['phase']; message: string; onRetry: () => void }) {
  const forbidden = phase === 'forbidden';
  const notFound = phase === 'not_found';
  const Icon = forbidden ? LockOutlined : notFound ? FileSearchOutlined : WarningOutlined;
  const title = forbidden ? '当前角色不能查看业务流' : notFound ? '没有找到这条业务流' : '业务流暂时加载失败';
  const detail = forbidden
    ? '请联系管理员确认岗位权限与所属组织范围。'
    : notFound
      ? '记录可能已删除，或不在当前账号的查看范围内。'
      : message || '网络或服务暂时不可用，请稍后再试。';

  return (
    <div className="bft-state" role="status">
      <span className="bft-state__icon" aria-hidden="true">
        <Icon />
      </span>
      <h3>{title}</h3>
      <p>{detail}</p>
      {!forbidden && (
        <Button icon={<ReloadOutlined />} onClick={onRetry}>
          重新加载
        </Button>
      )}
    </div>
  );
}

export default function BusinessFlowTrace({ sourceType, sourceId, open, onClose }: BusinessFlowTraceProps) {
  const [attempt, setAttempt] = useState(0);
  const [resolvedView, setResolvedView] = useState<ResolvedViewState | null>(null);
  const validSource = Boolean(
    sourceType && SOURCE_TYPES.has(sourceType) && Number.isSafeInteger(sourceId) && Number(sourceId) > 0,
  );
  const queryKey = `${sourceType || 'unknown'}:${sourceId || 0}:${attempt}`;

  useEffect(() => {
    if (!open || !validSource || !sourceType) return;

    const controller = new AbortController();
    const currentId = Number(sourceId);
    const currentQueryKey = queryKey;
    void api
      .get(`/business-flow/${sourceType}/${currentId}`, { signal: controller.signal, silent: true })
      .then(payload => {
        if (controller.signal.aborted) return;
        setResolvedView({
          queryKey: currentQueryKey,
          phase: 'success',
          data: normalizeFlow(payload, sourceType, currentId),
          message: '',
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : '未知错误';
        if (/当前角色无权|无权查看企业业务流|权限/.test(message)) {
          setResolvedView({ queryKey: currentQueryKey, phase: 'forbidden', data: null, message });
        } else if (/不存在|未找到|not found/i.test(message)) {
          setResolvedView({ queryKey: currentQueryKey, phase: 'not_found', data: null, message });
        } else {
          setResolvedView({ queryKey: currentQueryKey, phase: 'error', data: null, message });
        }
      });

    return () => controller.abort();
  }, [open, queryKey, sourceId, sourceType, validSource]);

  const view: ViewState = !open
    ? { phase: 'idle', data: null, message: '' }
    : !validSource
      ? { phase: 'error', data: null, message: '缺少有效的业务来源，暂时无法追踪。' }
      : resolvedView?.queryKey === queryKey
        ? resolvedView
        : { phase: 'loading', data: null, message: '' };

  const incomingRelations = new Map<string, FlowRelation[]>();
  if (view.phase === 'success') {
    view.data.links.forEach(link =>
      incomingRelations.set(link.to, [...(incomingRelations.get(link.to) || []), link.relation]),
    );
  }

  const retry = () => setAttempt(value => value + 1);
  const data = view.phase === 'success' ? view.data : null;

  return (
    <Drawer
      rootClassName="business-flow-drawer"
      open={open}
      onClose={onClose}
      width="min(560px, 100vw)"
      keyboard
      maskClosable
      title={
        <div className="bft-title" id="business-flow-trace-title">
          <span>业务流追踪</span>
          <small>{sourceType ? SOURCE_LABELS[sourceType] : '业务记录'}</small>
        </div>
      }
      styles={{ body: { padding: 0 } }}
    >
      <section className="bft-shell" aria-labelledby="business-flow-trace-title" aria-busy={view.phase === 'loading'}>
        <div className="bft-live" aria-live="polite" aria-atomic="true">
          {view.phase === 'loading' ? '正在加载业务流' : data ? `当前状态：${data.status.label}` : ''}
        </div>

        {view.phase === 'loading' && (
          <div className="bft-loading" role="status" aria-label="正在加载业务流">
            <Skeleton active title={{ width: '58%' }} paragraph={{ rows: 2 }} />
            {[0, 1, 2, 3].map(index => (
              <div className="bft-loading__node" key={index}>
                <Skeleton.Avatar active size="small" shape="circle" />
                <Skeleton active title={{ width: `${68 - index * 7}%` }} paragraph={{ rows: 1, width: '42%' }} />
              </div>
            ))}
          </div>
        )}

        {(view.phase === 'not_found' || view.phase === 'forbidden' || view.phase === 'error') && (
          <ErrorState phase={view.phase} message={view.message} onRetry={retry} />
        )}

        {data && (
          <>
            <header className="bft-summary">
              <div>
                <span className="bft-eyebrow">业务来源</span>
                <h2>{data.source.label}</h2>
              </div>
              <span className={`bft-status bft-status--${statusTone(data.status.label)}`}>
                <span aria-hidden="true" />
                {data.status.label}
              </span>
            </header>

            {!data.hasDownstream && data.emptyState && (
              <div className="bft-empty" role="note">
                <strong>尚未形成后续数据</strong>
                <span>{data.emptyState.message}</span>
              </div>
            )}

            <div className="bft-flow-heading">
              <div>
                <span className="bft-eyebrow">流程进度</span>
                <h3>从发起到结果</h3>
              </div>
              <span>{data.nodes.length} 个节点</span>
            </div>

            <ol className="bft-timeline" aria-label="业务流节点">
              {data.nodes.map((node, index) => {
                const relations = incomingRelations.get(node.id) || [];
                const relationText = relations.map(relation => RELATION_LABELS[relation]).join(' · ');
                const tone = statusTone(node.status);
                const time = formatTime(node.occurredAt);
                return (
                  <li className={`bft-node bft-node--${tone}`} key={node.id}>
                    <div className="bft-node__rail" aria-hidden="true">
                      <span>{index + 1}</span>
                    </div>
                    <div className="bft-node__content">
                      <span className="bft-relation">
                        {NODE_KIND_LABELS[node.kind] || '业务节点'}
                        {relationText ? ` · ${relationText}` : ''}
                      </span>
                      <div className="bft-node__row">
                        <strong>{node.label}</strong>
                        <span className={`bft-node__status bft-node__status--${tone}`}>{node.status}</span>
                      </div>
                      <div className="bft-node__meta">
                        {time && <time dateTime={node.occurredAt || undefined}>{time}</time>}
                        {node.href && (
                          <Link to={node.href} onClick={onClose} aria-label={`查看${node.label}`}>
                            查看
                            <ArrowRightOutlined aria-hidden="true" />
                          </Link>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>

            <aside className="bft-next" aria-label="下一步建议">
              <div>
                <span className="bft-eyebrow">下一步</span>
                <strong>{data.nextAction.label}</strong>
                <small>
                  {data.status.terminal ? '该流程已结束，可继续查看沉淀结果。' : '只读建议，不会自动执行任何操作。'}
                </small>
              </div>
              {data.nextAction.href && (
                <Link className="bft-next__link" to={data.nextAction.href} onClick={onClose}>
                  前往查看
                  <ArrowRightOutlined aria-hidden="true" />
                </Link>
              )}
            </aside>
          </>
        )}
      </section>
    </Drawer>
  );
}
