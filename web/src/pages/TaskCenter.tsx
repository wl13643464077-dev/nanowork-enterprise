import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Input,
  Modal,
  Pagination,
  Progress,
  Segmented,
  Skeleton,
  Spin,
  Tag,
  message,
} from 'antd';
import {
  ApartmentOutlined,
  CheckSquareOutlined,
  BookOutlined,
  ClockCircleOutlined,
  DownloadOutlined,
  EyeOutlined,
  FileTextOutlined,
  MessageOutlined,
  ReloadOutlined,
  RightOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  VideoCameraOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { api } from '../api/client';
import { REALTIME_EVENTS, useRealtimeEvent, useRealtimeEvents } from '../hooks/useRealtimeEvents';
import AvatarStudio from '../components/AvatarStudio';
import EmployeeDraftCard from '../components/EmployeeDraftCard';
import EmployeeExecutionTimeline from '../components/EmployeeExecutionTimeline';
import EmployeeResearchPlan from '../components/EmployeeResearchPlan';
import { Markdown } from '../components/Markdown';
import './TaskCenter.css';

const FILTERS = [
  { label: '全部', value: 'all' },
  { label: '待执行', value: 'pending' },
  { label: '执行中', value: 'running' },
  { label: '策略待处理', value: 'review' },
  { label: '受阻', value: 'blocked' },
  { label: '返工', value: 'rework' },
  { label: '异常', value: 'failed' },
  { label: '已完成', value: 'done' },
];
const statusColor: Record<string, string> = {
  running: 'processing',
  review: 'warning',
  blocked: 'error',
  rework: 'warning',
  failed: 'error',
  done: 'success',
  pending: 'default',
};
const kindIcon: Record<string, JSX.Element> = {
  manual: <CheckSquareOutlined />,
  restaurant: <RobotOutlined />,
  content: <FileTextOutlined />,
  content_pipeline: <ApartmentOutlined />,
  skill_learning: <BookOutlined />,
  advisor: <MessageOutlined />,
  avatar: <VideoCameraOutlined />,
  text_video: <VideoCameraOutlined />,
  wechat: <MessageOutlined />,
  media: <VideoCameraOutlined />,
  automation: <ThunderboltOutlined />,
  tool: <ToolOutlined />,
};
const taskKinds = new Set([
  'manual',
  'restaurant',
  'content',
  'content_pipeline',
  'skill_learning',
  'advisor',
  'avatar',
  'text_video',
  'wechat',
  'media',
  'automation',
  'tool',
]);
const pipelinePhaseLabels: Record<string, string> = {
  claim: '领取工位',
  context: '装载真实上游',
  agentic_search: '隔离 WebSearch',
  controlled_fetch: '受控 WebFetch',
  provider: '调用 Provider',
  validate: '岗位契约校验',
  persist: '产物入库',
  settle: '账务结算',
  failure: '失败留痕',
  retry: '重试排队',
  recover: '中断恢复',
};

const DETAIL_RUNNING_REFRESH_MS = 2_000;
// 有 SSE 实时推送（task.status_changed）时，运行中详情的轮询只作兜底，放宽到 15s；断连自动回到 2s
const DETAIL_RUNNING_REALTIME_REFRESH_MS = 15_000;
const DETAIL_ATTENTION_REFRESH_MS = 12_000;

function detailRefreshInterval(detail: any, realtime = false): number | null {
  if (!detail) return null;
  if (String(detail.state || '') === 'running')
    return realtime ? DETAIL_RUNNING_REALTIME_REFRESH_MS : DETAIL_RUNNING_REFRESH_MS;
  const attentionStates = [detail.state, detail.status, detail.billing?.state].map(value =>
    String(value || '').toLowerCase(),
  );
  return attentionStates.some(value => ['failed', 'blocked', 'pending_reconciliation'].includes(value))
    ? DETAIL_ATTENTION_REFRESH_MS
    : null;
}

function taskRefFromSourceKey(sourceKey: string) {
  const match = /^([a-z_]+):(\d+)$/u.exec(String(sourceKey || ''));
  if (!match) return null;
  const [, kind, rawId] = match;
  const id = Number(rawId);
  return taskKinds.has(kind) && Number.isSafeInteger(id) && id > 0 ? { kind, id } : null;
}

function isFailedTask(detail: any) {
  const state = String(detail?.state || '').toLowerCase();
  const status = String(detail?.status || '').toLowerCase();
  return state === 'failed' || status === 'failed' || status === '失败';
}

// 证据事实表：把证据对象的一级标量字段渲染成人能读的事实行（常见字段中文化），
// 完整原始 JSON 收进「查看原始证据」折叠区——老板先看人话，审计仍可穿透。
const EVIDENCE_LABELS: Record<string, string> = {
  status: '状态',
  state: '状态',
  model: '模型',
  provider: '供应商',
  mode: '模式',
  credits: '积分',
  chargedCredits: '实扣积分',
  estimatedCredits: '预估积分',
  costYuan: '费用（元）',
  webCostUsd: '联网费用（美元）',
  durationMs: '耗时（毫秒）',
  skillsAdded: '新增技能数',
  title: '标题',
  fileName: '文件名',
  url: '链接',
  videoUrl: '视频链接',
  audioUrl: '音频链接',
  coverUrl: '封面链接',
  createdAt: '创建时间',
  completedAt: '完成时间',
  deliveredAt: '送达时间',
  marker: '核对标识',
  draftId: '草稿编号',
  mediaId: '素材编号',
  count: '数量',
  reason: '原因',
  note: '说明',
  message: '说明',
};

function evidenceFactValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

function EvidenceFacts({ data, rawLabel = '查看原始证据（审计用）' }: { data: any; rawLabel?: string }) {
  if (!data || typeof data !== 'object') return null;
  const scalarEntries = Object.entries(data).filter(
    ([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value),
  );
  return (
    <div className="task-center-evidence">
      {scalarEntries.length > 0 && (
        <dl className="task-center-evidence-facts">
          {scalarEntries.slice(0, 12).map(([key, value]) => (
            <div key={key}>
              <dt>{EVIDENCE_LABELS[key] || key}</dt>
              <dd>{evidenceFactValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      <details className="task-center-evidence-raw">
        <summary>{rawLabel}</summary>
        <pre>{JSON.stringify(data, null, 2)}</pre>
      </details>
    </div>
  );
}

function taskStatusLabel(row: any) {
  return row?.displayStatus || row?.adoptionContext?.label || '状态待确认';
}

function policyColor(kind?: string) {
  if (kind === 'historical_policy' || kind === 'unknown_policy') return 'default';
  if (kind === 'explicit_policy') return 'warning';
  if (kind === 'risk_based_policy') return 'gold';
  if (kind === 'auto_policy') return 'blue';
  return 'default';
}

function duration(ms: number | null) {
  if (ms == null) return '—';
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

export default function TaskCenter() {
  const nav = useNavigate();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [detailKey, setDetailKey] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailRefreshing, setDetailRefreshing] = useState(false);
  const [pipelineLifecycleMutation, setPipelineLifecycleMutation] = useState('');
  const [wechatMutation, setWechatMutation] = useState('');

  const load = useCallback(
    (background = false) => {
      if (!background) setLoading(true);
      setError('');
      const query = new URLSearchParams({ page: String(page), pageSize: '40' });
      if (filter !== 'all') query.set('state', filter);
      if (search) query.set('search', search);
      api
        .get(`/task-center?${query}`, { silent: true })
        .then(setData)
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false));
    },
    [filter, page, search],
  );

  const openDetailByRef = useCallback((kind: string, id: number, sourceKey = `${kind}:${id}`, background = false) => {
    setDetailKey(sourceKey);
    if (!background) {
      setDetail(null);
      setDetailError('');
      setDetailLoading(true);
    }
    api
      .get(`/task-center/${kind}/${id}`, { silent: true })
      .then(setDetail)
      .catch((e: Error) => {
        if (!background) setDetailError(e.message);
      })
      .finally(() => {
        if (!background) setDetailLoading(false);
      });
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => load(), 0);
    return () => window.clearTimeout(initial);
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const kind = query.get('kind') || '';
    const id = Number(query.get('id'));
    if (!taskKinds.has(kind) || !Number.isSafeInteger(id) || id <= 0) return undefined;
    const initial = window.setTimeout(() => openDetailByRef(kind, id), 0);
    return () => window.clearTimeout(initial);
  }, [openDetailByRef]);
  const { connected: realtimeConnected } = useRealtimeEvents();
  useEffect(() => {
    const refreshInterval = detailRefreshInterval(detail, realtimeConnected);
    if (
      !detailKey ||
      !refreshInterval ||
      !taskKinds.has(String(detail?.kind || '')) ||
      !Number.isSafeInteger(Number(detail?.id))
    ) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        openDetailByRef(detail.kind, Number(detail.id), detail.sourceKey, true);
      }
    }, refreshInterval);
    return () => window.clearInterval(timer);
  }, [detail, detailKey, openDetailByRef, realtimeConnected]);
  // 事件驱动刷新：任务状态翻转推送到达即刷新对应行与打开中的详情，不等轮询
  useRealtimeEvent<{ kind?: string; id?: number }>(REALTIME_EVENTS.taskStatus, event => {
    load(true);
    const ref =
      detail && taskKinds.has(String(detail.kind || '')) && Number.isSafeInteger(Number(detail.id))
        ? { kind: String(detail.kind), id: Number(detail.id) }
        : taskRefFromSourceKey(detailKey);
    if (ref && ref.kind === String(event?.kind || '') && ref.id === Number(event?.id)) {
      openDetailByRef(ref.kind, ref.id, `${ref.kind}:${ref.id}`, true);
    }
  });

  const refreshCurrentDetail = useCallback(async () => {
    const ref =
      detail && taskKinds.has(String(detail.kind || '')) && Number.isSafeInteger(Number(detail.id))
        ? { kind: String(detail.kind), id: Number(detail.id) }
        : taskRefFromSourceKey(detailKey);
    if (!ref) return;
    setDetailRefreshing(true);
    setDetailError('');
    try {
      const latest = await api.get(`/task-center/${ref.kind}/${ref.id}`, { silent: true });
      setDetail(latest);
      load(true);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : '任务状态刷新失败');
    } finally {
      setDetailRefreshing(false);
    }
  }, [detail, detailKey, load]);

  const openDetail = (row: any) => {
    window.history.replaceState(null, '', row.deepLink || `/tasks?kind=${row.kind}&id=${row.id}`);
    openDetailByRef(row.kind, row.id, row.sourceKey);
  };
  const runPipelineLifecycleAction = async (action: 'pause' | 'resume' | 'cancel') => {
    if (detail?.kind !== 'content_pipeline' || !Number.isSafeInteger(Number(detail.id))) return;
    setPipelineLifecycleMutation(action);
    try {
      await api.post(`/content/pipelines/${detail.id}/${action}`, {});
      message.success(action === 'pause' ? '流水线已暂停' : action === 'resume' ? '流水线已继续' : '流水线已取消');
      openDetailByRef('content_pipeline', Number(detail.id), detail.sourceKey);
      load(true);
    } catch {
      // API客户端已展示服务端错误。
    } finally {
      setPipelineLifecycleMutation('');
    }
  };
  const confirmPipelineCancel = () => {
    Modal.confirm({
      title: '确认取消这条内容流水线？',
      content: '未交付hold会先释放；已交付产物、已结算历史和phase事件保留。',
      okText: '确认取消',
      cancelText: '保留任务',
      okButtonProps: { danger: true },
      onOk: () => runPipelineLifecycleAction('cancel'),
    });
  };
  const reconcileWechat = async () => {
    if (detail?.kind !== 'wechat' || !Number.isSafeInteger(Number(detail.id))) return;
    setWechatMutation('reconcile');
    try {
      await api.post(`/wechat-draft/deliveries/${detail.id}/reconcile`, {});
      message.success('已按隐藏 Marker 核对微信草稿箱');
      openDetailByRef('wechat', Number(detail.id), detail.sourceKey);
      load(true);
    } catch {
      // API 客户端已展示服务端的安全错误。
    } finally {
      setWechatMutation('');
    }
  };
  const confirmWechatNotDelivered = () => {
    if (detail?.kind !== 'wechat') return;
    let confirmation = '';
    Modal.confirm({
      title: '确认微信草稿箱里没有这篇内容？',
      content: (
        <div>
          <p>
            系统会在退回预授权前再做一次只读 Marker 核对。请完整输入文章标题：
            <strong>{detail.title}</strong>
          </p>
          <Input
            onChange={event => {
              confirmation = event.target.value;
            }}
            placeholder="完整输入文章标题"
          />
        </div>
      ),
      okText: '确认未送达并退回预授权',
      cancelText: '继续保留对账',
      okButtonProps: { danger: true },
      async onOk() {
        setWechatMutation('confirm');
        try {
          await api.post(`/wechat-draft/deliveries/${detail.id}/confirm-not-delivered`, {
            confirmedNoDraft: true,
            titleConfirmation: confirmation,
          });
          message.success('已确认未送达，本次预授权已全额退回');
          openDetailByRef('wechat', Number(detail.id), detail.sourceKey);
          load(true);
        } finally {
          setWechatMutation('');
        }
      },
    });
  };
  const closeDetail = () => {
    window.history.replaceState(null, '', '/tasks');
    setDetailKey('');
    setDetail(null);
    setDetailError('');
    setDetailRefreshing(false);
  };
  const items = data?.items || [];
  const s = data?.summary || {};
  const windowInfo = data?.window || {};
  const metric = [
    ['当前窗口', s.total || 0],
    ['待执行', s.pending || 0],
    ['执行中', s.running || 0],
    ['策略待处理', s.review || 0],
    ['受阻 / 异常', (s.blocked || 0) + (s.failed || 0)],
  ];

  return (
    <main className="task-center-page">
      <header className="task-center-head">
        <div>
          <h1>任务中心</h1>
          <p>
            数字员工、数字人摄影棚、全网进修、老板参谋会诊、10
            工位内容团队、公众号草稿、工具、媒体与自动化的一张真实执行清单 · 每 15 秒自动刷新
          </p>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => load()} loading={loading}>
          刷新
        </Button>
      </header>
      {loading && !data ? (
        <section className="task-center-state">
          <Skeleton active paragraph={{ rows: 7 }} />
        </section>
      ) : error ? (
        <Alert
          type="error"
          showIcon
          message="任务中心加载失败"
          description={error}
          action={<Button onClick={() => load()}>重试</Button>}
        />
      ) : (
        <>
          <section className="task-center-metrics" aria-label="当前查询窗口任务汇总">
            {metric.map(([label, value]) => (
              <div key={String(label)}>
                <small>{label}</small>
                <strong>{value}</strong>
              </div>
            ))}
            <div>
              <small>预授权占用</small>
              <strong>
                {s.heldCredits || 0}
                <em>积分</em>
              </strong>
            </div>
          </section>
          <section className="task-center-toolbar">
            <div className="task-center-filters">
              <Segmented
                options={FILTERS}
                value={filter}
                onChange={value => {
                  setFilter(String(value));
                  setPage(1);
                }}
              />
              <Input.Search
                value={searchDraft}
                allowClear
                placeholder="搜索员工或任务"
                onChange={e => setSearchDraft(e.target.value)}
                onSearch={value => {
                  setSearch(value.trim());
                  setPage(1);
                }}
              />
            </div>
            <span>
              {windowInfo.truncated
                ? `扫描窗口已达上限（每类 ${windowInfo.sourceLimitPerKind} 条）`
                : `已扫描 ${windowInfo.scanned || 0} 条`}{' '}
              · 当前返回 {items.length} 条
            </span>
          </section>
          <section className="task-center-board" aria-live="polite">
            <div className="task-center-board__head">
              <span>员工 / 来源</span>
              <span>任务与当前步骤</span>
              <span>状态 / 进度</span>
              <span>耗时 / 费用</span>
              <span>详情</span>
            </div>
            {!items.length ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选下暂无任务">
                <Button type="primary" onClick={() => nav('/employees')}>
                  去给数字员工派个活
                </Button>
              </Empty>
            ) : (
              items.map((row: any) => (
                <article
                  className="task-center-row"
                  key={row.sourceKey}
                  // The row is a keyboard-accessible composite card; keep the semantic article for screen-reader grouping.
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role
                  role="button"
                  tabIndex={0}
                  onClick={() => openDetail(row)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      openDetail(row);
                    }
                  }}
                >
                  <div className="task-center-owner">
                    <strong>{row.employee}</strong>
                    <Tag icon={kindIcon[row.kind]}>{row.category}</Tag>
                  </div>
                  <div className="task-center-task">
                    <strong title={row.title}>{row.title}</strong>
                    <span>
                      {row.currentStep} · {row.stepIndex}/{row.stepTotal}
                    </span>
                  </div>
                  <div className="task-center-progress">
                    <Tag color={statusColor[row.state]}>
                      {taskStatusLabel(row)}
                      {row.state === 'blocked' ? ' · 受阻' : ''}
                    </Tag>
                    {row.policyContext?.kind && row.policyContext.kind !== 'none' && (
                      <Tag color={policyColor(row.policyContext.kind)}>{row.policyContext.label}</Tag>
                    )}
                    <Progress
                      percent={row.progress}
                      size="small"
                      showInfo={false}
                      status={row.state === 'failed' ? 'exception' : undefined}
                    />
                  </div>
                  <div className="task-center-cost">
                    <span>
                      <ClockCircleOutlined /> {duration(row.elapsedMs)}
                    </span>
                    <span>
                      <WalletOutlined /> {row.billing.label}
                      {row.billing.costYuan != null && row.billing.costYuan > 0
                        ? ` · ¥${row.billing.costYuan.toFixed(4)}`
                        : ''}
                    </span>
                  </div>
                  <Button
                    type="text"
                    size="small"
                    onClick={e => {
                      e.stopPropagation();
                      openDetail(row);
                    }}
                    aria-label={`查看${row.title}详情`}
                  >
                    查看 <RightOutlined />
                  </Button>
                </article>
              ))
            )}
          </section>
          {windowInfo.matched > windowInfo.pageSize && (
            <Pagination
              className="task-center-pagination"
              current={page}
              pageSize={windowInfo.pageSize}
              total={windowInfo.matched}
              showSizeChanger={false}
              onChange={setPage}
            />
          )}
        </>
      )}
      <AvatarStudio />

      <Drawer
        className="task-center-drawer"
        title="任务详情"
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={detailRefreshing}
            disabled={!detailKey}
            onClick={() => void refreshCurrentDetail()}
          >
            刷新任务状态
          </Button>
        }
        width="min(640px, 100vw)"
        open={Boolean(detailKey)}
        onClose={closeDetail}
        destroyOnHidden
      >
        {detailLoading ? (
          <div className="task-center-detail-state">
            <Spin />
          </div>
        ) : detailError ? (
          <Alert type="error" showIcon message="详情加载失败" description={detailError} />
        ) : (
          detail && (
            <div className="task-center-detail">
              <div className="task-center-detail__title">
                <Tag icon={kindIcon[detail.kind]}>{detail.category}</Tag>
                <h2>{detail.title}</h2>
                <p>
                  {detail.employee} · {taskStatusLabel(detail)}
                </p>
                {detail.deepLink && (
                  <Button type="link" size="small" href={detail.deepLink}>
                    打开稳定任务链接
                  </Button>
                )}
                {detail.conversationDeepLink && (
                  <Button
                    type="primary"
                    size="small"
                    href={detail.conversationAvailability?.available ? detail.conversationDeepLink : undefined}
                    disabled={detail.conversationAvailability?.available === false}
                    title={detail.conversationAvailability?.reason || undefined}
                  >
                    回到数字员工对话
                  </Button>
                )}
              </div>
              {detail.kind === 'content_pipeline' && isFailedTask(detail) && detail.pipeline?.pipelineDeepLink && (
                <Alert
                  className="task-center-detail__recovery"
                  type="error"
                  showIcon
                  message="内容流水线有失败工位"
                  description="这是已保存的失败状态；前往内容生产仓查看错误原因，并由你决定是否重试。系统不会自动触发付费重跑。"
                  action={
                    <Button type="primary" href={detail.pipeline.pipelineDeepLink}>
                      前往重试失败工位
                    </Button>
                  }
                />
              )}
              {detail.kind === 'media' && isFailedTask(detail) && (
                <Alert
                  className="task-center-detail__recovery"
                  type="error"
                  showIcon
                  message="AI带货员任务需要重新处理"
                  description="这是旧失败任务的历史快照，不会自动变成成功。请返回AI带货员检查素材、目标和模型配置，再由你人工重新提交；此处不会自动付费重跑。"
                  action={
                    <Button
                      type="primary"
                      href={`/content?tab=media&mediaJobId=${encodeURIComponent(String(detail.id))}`}
                    >
                      返回AI带货员重新处理
                    </Button>
                  }
                />
              )}
              <dl className="task-center-detail__facts">
                <div>
                  <dt>当前步骤</dt>
                  <dd>
                    {detail.currentStep}（{detail.stepIndex}/{detail.stepTotal}）
                  </dd>
                </div>
                <div>
                  <dt>执行耗时</dt>
                  <dd>{duration(detail.elapsedMs)}</dd>
                </div>
                <div>
                  <dt>费用状态</dt>
                  <dd>{detail.billing.label}</dd>
                </div>
                <div>
                  <dt>权威账本</dt>
                  <dd>
                    {detail.billing.authoritative
                      ? `已核验 · Hold #${detail.billing.ledger.holdId || '—'} / Log #${detail.billing.ledger.logId || '—'}`
                      : '暂无完整权威账本证据'}
                  </dd>
                </div>
                <div>
                  <dt>结果可用性</dt>
                  <dd>
                    {detail.businessUsable
                      ? detail.adoptionContext?.adopted
                        ? detail.adoptionContext.label
                        : '业务可采用'
                      : detail.policyContext?.historical
                        ? '历史记录 · 旧策略仅供回看'
                        : taskStatusLabel(detail)}
                  </dd>
                </div>
                <div>
                  <dt>实际采用结果</dt>
                  <dd>{detail.adoptionContext?.label || '采用结果待核验'}</dd>
                </div>
                <div>
                  <dt>采用 / 授权策略</dt>
                  <dd>{detail.policyContext?.label || '当前策略状态待确认'}</dd>
                </div>
              </dl>
              {detail.executionProgress && (
                <EmployeeExecutionTimeline progress={detail.executionProgress} title="数字员工实时执行链" />
              )}
              <EmployeeResearchPlan evidence={detail.researchEvidence} />
              {detail.kind === 'restaurant' && detail.draft && (
                <EmployeeDraftCard
                  taskId={Number(detail.id)}
                  draft={detail.draft}
                  body={detail.report?.markdown || detail.output || ''}
                  bodyOpen
                  onRedispatch={
                    detail.conversationDeepLink && detail.conversationAvailability?.available !== false
                      ? () =>
                          nav(
                            `${detail.conversationDeepLink}${detail.conversationDeepLink.includes('?') ? '&' : '?'}redispatch=1`,
                          )
                      : undefined
                  }
                  onAccepted={() => {
                    openDetailByRef('restaurant', Number(detail.id), detail.sourceKey, true);
                    load(true);
                  }}
                />
              )}
              <section>
                <h3>任务输入</h3>
                <pre>{detail.input || '暂无输入说明'}</pre>
              </section>
              <section>
                <h3>执行结果</h3>
                {detail.kind === 'restaurant' && detail.draft ? (
                  <Alert
                    type="warning"
                    showIcon
                    message={
                      detail.draft.state === 'pending' ? '未达标草稿正文见上方草稿卡' : '已接受草稿正文见上方草稿卡'
                    }
                    description="该结果未通过质量门，不会自动进入业务可用状态，也不会生成正式导出文件。"
                  />
                ) : detail.report?.markdown ? (
                  <Markdown content={detail.report.markdown} />
                ) : detail.output ? (
                  /^(https?:\/\/|\/)/.test(detail.output) ? (
                    <a href={detail.output} target="_blank" rel="noreferrer">
                      打开媒体结果
                    </a>
                  ) : (
                    <pre>{detail.output}</pre>
                  )
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={detail.resultUnavailableReason || '结果尚未生成'}
                  />
                )}
              </section>
              {['restaurant', 'content'].includes(String(detail.kind || '')) && (
                <section className="task-center-pipeline-chain" aria-label="交付文件">
                  <header>
                    <h3>交付文件</h3>
                    {detail.conversationDeepLink && (
                      <Button
                        size="small"
                        type="link"
                        href={detail.conversationAvailability?.available ? detail.conversationDeepLink : undefined}
                        disabled={detail.conversationAvailability?.available === false}
                        title={detail.conversationAvailability?.reason || undefined}
                      >
                        在员工对话中查看全部
                      </Button>
                    )}
                  </header>
                  {(detail.deliverables || []).length ? (
                    (detail.deliverables || []).map((artifact: any) => (
                      <article key={artifact.id}>
                        <header>
                          <span>
                            <FileTextOutlined aria-hidden="true" />{' '}
                            <strong>{artifact.fileName || artifact.title}</strong>
                          </span>
                          <Tag color="blue">{artifact.label || artifact.format?.toUpperCase()}</Tag>
                        </header>
                        <p>
                          <Button
                            size="small"
                            type="primary"
                            icon={<DownloadOutlined />}
                            href={artifact.downloadUrl}
                            target="_blank"
                            rel="noreferrer"
                            disabled={artifact.downloadAvailable === false}
                          >
                            下载{artifact.label || '文件'}
                          </Button>
                        </p>
                      </article>
                    ))
                  ) : (
                    <Alert
                      type="info"
                      showIcon
                      message={detail.deliverableAvailability?.message || '交付文件尚未生成'}
                      action={
                        detail.conversationDeepLink ? (
                          <Button
                            size="small"
                            href={detail.conversationAvailability?.available ? detail.conversationDeepLink : undefined}
                            disabled={detail.conversationAvailability?.available === false}
                            title={detail.conversationAvailability?.reason || undefined}
                          >
                            打开员工对话
                          </Button>
                        ) : undefined
                      }
                    />
                  )}
                </section>
              )}
              {detail.kind === 'content_pipeline' && detail.pipeline && (
                <section className="task-center-pipeline-chain">
                  <header>
                    <h3>10 工位执行链</h3>
                    <div>
                      {detail.status === 'running' && (
                        <Button
                          size="small"
                          loading={pipelineLifecycleMutation === 'pause'}
                          onClick={() => void runPipelineLifecycleAction('pause')}
                        >
                          暂停
                        </Button>
                      )}
                      {detail.status === 'paused' && (
                        <Button
                          size="small"
                          type="primary"
                          loading={pipelineLifecycleMutation === 'resume'}
                          onClick={() => void runPipelineLifecycleAction('resume')}
                        >
                          继续
                        </Button>
                      )}
                      {['running', 'paused', 'awaiting_approval', 'failed', 'billing_pending'].includes(
                        String(detail.status || ''),
                      ) && (
                        <Button
                          size="small"
                          danger
                          loading={pipelineLifecycleMutation === 'cancel'}
                          onClick={confirmPipelineCancel}
                        >
                          取消
                        </Button>
                      )}
                      {detail.pipeline.pipelineDeepLink && (
                        <Button size="small" type="link" href={detail.pipeline.pipelineDeepLink}>
                          打开内容生产仓
                        </Button>
                      )}
                    </div>
                  </header>
                  {(detail.pipeline.stations || []).map((station: any) => (
                    <article key={station.stationIdx}>
                      <header>
                        <strong>
                          工位 {station.stationIdx} · {station.employeeName}
                        </strong>
                        <Tag>{station.status}</Tag>
                      </header>
                      {(station.phaseEvents || []).length > 0 ? (
                        <ol>
                          {station.phaseEvents.map((event: any) => (
                            <li key={event.id}>
                              <span>
                                <strong>{pipelinePhaseLabels[event.phase] || event.phase}</strong>
                                <small>
                                  Attempt {event.attempt} · {event.occurredAt || '时间未返回'}
                                </small>
                              </span>
                              <Tag
                                color={
                                  event.state === 'failed'
                                    ? 'red'
                                    : event.state === 'started'
                                      ? 'processing'
                                      : undefined
                                }
                              >
                                {event.state}
                              </Tag>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <small>该工位尚无持久化 phase event。</small>
                      )}
                    </article>
                  ))}
                  <section className="task-center-pipeline-chain" aria-label="工位交付文件">
                    <header>
                      <h3>工位交付文件</h3>
                      <Tag>{(detail.pipeline.artifacts || []).length} 份</Tag>
                    </header>
                    {(detail.pipeline.artifacts || []).length ? (
                      (detail.pipeline.artifacts || []).map((artifact: any) => (
                        <article key={artifact.id}>
                          <header>
                            <span>
                              <FileTextOutlined aria-hidden="true" /> <strong>{artifact.filename}</strong>
                            </span>
                            <Tag color={artifact.primary ? 'blue' : undefined}>
                              工位 {artifact.stationIdx}·{artifact.kind}
                            </Tag>
                          </header>
                          <p>
                            {artifact.previewAvailable && artifact.previewUrl && (
                              <Button
                                size="small"
                                icon={<EyeOutlined />}
                                href={artifact.previewUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                预览
                              </Button>
                            )}
                            {artifact.downloadAvailable && artifact.downloadUrl && (
                              <Button
                                size="small"
                                type="primary"
                                icon={<DownloadOutlined />}
                                href={artifact.downloadUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                下载
                              </Button>
                            )}
                            {!artifact.previewAvailable && !artifact.downloadAvailable && (
                              <Tag>{artifact.unavailableReason || '当前账号不可访问该产物'}</Tag>
                            )}
                          </p>
                        </article>
                      ))
                    ) : (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="工位完成后将在这里显示可预览、可下载的交付文件"
                      />
                    )}
                  </section>
                  <details>
                    <summary>知识沉淀与追溯</summary>
                    {detail.pipeline.knowledgeSink ? (
                      <dl className="task-center-detail__facts">
                        <div>
                          <dt>沉淀状态</dt>
                          <dd>{detail.pipeline.knowledgeSink.status || '待生成'}</dd>
                        </div>
                        <div>
                          <dt>最终资产</dt>
                          <dd>
                            {detail.pipeline.knowledgeSink.assetDeepLink ? (
                              <Button size="small" type="link" href={detail.pipeline.knowledgeSink.assetDeepLink}>
                                打开内容资产
                              </Button>
                            ) : (
                              '尚未入库'
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>知识文档</dt>
                          <dd>
                            {detail.pipeline.knowledgeSink.kbDocId
                              ? `#${detail.pipeline.knowledgeSink.kbDocId}`
                              : '尚未入库'}
                          </dd>
                        </div>
                        <div>
                          <dt>完成时间</dt>
                          <dd>{detail.pipeline.knowledgeSink.completedAt || '尚未完成'}</dd>
                        </div>
                      </dl>
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未生成知识沉淀记录" />
                    )}
                  </details>
                </section>
              )}
              {detail.kind === 'skill_learning' && detail.learning && (
                <section>
                  <h3>进修证据与费用</h3>
                  <EvidenceFacts data={detail.learning} />
                </section>
              )}
              {detail.kind === 'advisor' && detail.advisor && (
                <section>
                  <h3>会诊回流</h3>
                  <p>
                    <Button type="link" href={detail.advisor.sourceDeepLink}>
                      打开原会诊
                    </Button>
                  </p>
                  {(detail.advisor.convertedTasks || []).length ? (
                    <ul className="task-center-converted-list">
                      {(detail.advisor.convertedTasks || []).map((task: any, index: number) => (
                        <li key={index}>
                          {task.title || task.name || `任务 #${task.id ?? index + 1}`}
                          {task.status ? `（${task.status}）` : ''}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次会诊没有转出任务" />
                  )}
                </section>
              )}
              {detail.kind === 'avatar' && detail.avatar && (
                <section>
                  <h3>数字人真实链路与成片证据</h3>
                  <EvidenceFacts data={detail.avatar} />
                </section>
              )}
              {detail.kind === 'text_video' && detail.textVideo && (
                <section>
                  <h3>真实TTS / FFmpeg成片证据</h3>
                  <p>
                    <Button type="link" href={detail.textVideo.studioDeepLink}>
                      打开成片工作台
                    </Button>
                  </p>
                  <EvidenceFacts data={detail.textVideo} />
                </section>
              )}
              {detail.kind === 'wechat' && detail.wechat && (
                <section>
                  <h3>微信公众号草稿投递证据</h3>
                  <p>
                    <Button type="link" href={detail.wechat.studioDeepLink}>
                      打开内容生产仓投递台
                    </Button>
                    <Button type="link" href={detail.wechat.sourceDeepLink}>
                      打开来源产物
                    </Button>
                  </p>
                  {detail.wechat.needsReconciliation && (
                    <p>
                      <Button loading={wechatMutation === 'reconcile'} onClick={() => void reconcileWechat()}>
                        按 Marker 核对草稿箱
                      </Button>
                      {detail.wechat.canConfirmNotDelivered && (
                        <Button danger loading={wechatMutation === 'confirm'} onClick={confirmWechatNotDelivered}>
                          我已人工确认未送达
                        </Button>
                      )}
                    </p>
                  )}
                  {!detail.wechat.canConfirmNotDelivered && detail.wechat.confirmWaitSeconds > 0 && (
                    <Alert
                      type="warning"
                      showIcon
                      message={`投递结果仍可能在处理，${detail.wechat.confirmWaitSeconds} 秒后才可人工解锁`}
                    />
                  )}
                  <EvidenceFacts data={detail.wechat} />
                </section>
              )}
              {detail.error && <Alert type="error" showIcon message="执行异常" description={detail.error} />}
            </div>
          )
        )}
      </Drawer>
    </main>
  );
}
