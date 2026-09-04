import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, Modal, Progress, Skeleton, Steps, Tag, message } from 'antd';
import {
  ArrowLeftOutlined,
  CheckOutlined,
  CloseOutlined,
  DownloadOutlined,
  FilePdfOutlined,
  FileWordOutlined,
  RedoOutlined,
  ReloadOutlined,
  RightOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { api, safeUrl } from '../../api/client';
import type { EmployeeRuntimeTask } from '../../api/employeeWorkbenchTypes';
import { REALTIME_EVENTS, useRealtimeEvent } from '../../hooks/useRealtimeEvents';
import EmployeeDraftCard from '../EmployeeDraftCard';
import EmployeeAvatar from '../EmployeeAvatar';
import { Markdown } from '../Markdown';
import {
  RESTAURANT_TASK_POLL_INTERVAL_MS,
  RESTAURANT_TASK_REALTIME_POLL_INTERVAL_MS,
  buildRestaurantTaskPollWarning,
} from '../restaurantTaskPolling';
import { restaurantOutputPresentation } from '../restaurantOutputPresentation';
import {
  deptToneIndex,
  employeeDisplayName,
  findEmployeeBySpecialist,
  loadEmployeeCatalog,
  type MobileEmployee,
  type MobileEmployeeCatalog,
} from './employeeCatalog';
import { writeDispatchPrefill } from './MobileDispatch';
import {
  mobilePath,
  readRecentDispatches,
  recallCurrentTask,
  rememberCurrentTask,
  type MobileTaskRef,
} from './mobileRoutes';
import './mobile.css';

// 任务 Tab：GET /task-center 统一清单（运行中置顶）+ 全屏详情。
// 餐饮任务详情走 GET /marshals/tasks/:id/status（与工作台同一状态映射：flow/stepIndex/draft/reviewReady），
// SSE 在线时事件驱动刷新、20s 轮询兜底，离线 5s 轮询；其他类型走 GET /task-center/:kind/:id。

const LIST_POLL_MS = 20_000;
const LIST_POLL_REALTIME_MS = 60_000;

const FILTERS = [
  { label: '全部', value: 'all' },
  { label: '执行中', value: 'running' },
  { label: '待处理', value: 'review' },
  { label: '已完成', value: 'done' },
  { label: '异常', value: 'failed' },
];

const STATE_COLOR: Record<string, string> = {
  running: 'processing',
  review: 'warning',
  blocked: 'error',
  rework: 'warning',
  failed: 'error',
  done: 'success',
  pending: 'default',
};

const RUN_STATUS_COLOR: Record<string, string> = {
  生成中: 'processing',
  待派活: 'default',
  待人工审阅: 'gold',
  '业务暂不可采用（待账务对账）': 'orange',
  '已自动采用（可用于业务）': 'green',
  '已人工采纳（可用于业务）': 'green',
  '失败需处理（执行异常）': 'red',
  '失败需返工（质检未通过）': 'red',
  '失败需返工（人工审阅未通过）': 'red',
  '未达标草稿（待老板处理）': 'orange',
  '已接受草稿（内部参考，未通过质量门）': 'orange',
};

type RestaurantTask = EmployeeRuntimeTask & {
  specialist_id?: number;
  marshal_name?: string;
  reviewBlockedReason?: string | null;
  supersededBy?: { taskId?: number } | null;
  output_id?: number | null;
};

type Deliverable = { id: number; format: string; label?: string; fileName?: string; downloadUrl: string };

function refFromParams(params: URLSearchParams): MobileTaskRef | null {
  const task = params.get('task');
  if (task && /^\d+$/u.test(task)) return { kind: 'restaurant', id: Number(task) };
  const kind = params.get('kind') || '';
  const id = Number(params.get('id'));
  if (/^[a-z_]+$/u.test(kind) && Number.isSafeInteger(id) && id > 0) return { kind, id };
  return null;
}

function detailPath(ref: MobileTaskRef) {
  return ref.kind === 'restaurant'
    ? mobilePath('tasks', { task: ref.id })
    : mobilePath('tasks', { kind: ref.kind, id: ref.id });
}

function shortTime(value?: string | null) {
  return String(value || '')
    .replace('T', ' ')
    .slice(5, 16);
}

function isRunning(status: unknown) {
  return String(status || '') === '生成中';
}

export default function MobileTasks({
  nav,
  params,
  mods,
  user,
  realtimeConnected,
}: {
  nav: (path: string) => void;
  params: URLSearchParams;
  mods: string[];
  user: any;
  realtimeConnected: boolean;
}) {
  const ref = refFromParams(params);
  if (ref) {
    if (ref.kind === 'restaurant' && mods.includes('marshals')) {
      return (
        <RestaurantTaskDetail
          key={ref.id}
          taskId={ref.id}
          nav={nav}
          user={user}
          realtimeConnected={realtimeConnected}
        />
      );
    }
    return (
      <GenericTaskDetail key={`${ref.kind}:${ref.id}`} taskRef={ref} nav={nav} realtimeConnected={realtimeConnected} />
    );
  }
  return <TaskList nav={nav} mods={mods} realtimeConnected={realtimeConnected} />;
}

function TaskList({
  nav,
  mods,
  realtimeConnected,
}: {
  nav: (path: string) => void;
  mods: string[];
  realtimeConnected: boolean;
}) {
  const hasCenter = mods.includes('execution');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(hasCenter);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [resume, setResume] = useState<MobileTaskRef | null>(() => recallCurrentTask());
  const recent = useMemo(() => readRecentDispatches(), []);
  const serial = useRef(0);

  const load = useCallback(
    (background = false) => {
      if (!hasCenter) return;
      const current = ++serial.current;
      if (!background) setLoading(true);
      else setRefreshing(true);
      const query = new URLSearchParams({ page: '1', pageSize: '40' });
      if (filter !== 'all') query.set('state', filter);
      api
        .get(`/task-center?${query}`, { silent: true })
        .then(response => {
          if (current !== serial.current) return;
          setData(response);
          setError('');
        })
        .catch((err: Error) => {
          // 后台轮询失败不覆盖已有列表，只在首次加载失败时显示错误态
          if (current === serial.current && !background) setError(err.message || '任务清单加载失败');
        })
        .finally(() => {
          if (current !== serial.current) return;
          setLoading(false);
          setRefreshing(false);
        });
    },
    [filter, hasCenter],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    if (!hasCenter) return undefined;
    const timer = window.setInterval(
      () => {
        if (document.visibilityState === 'visible') load(true);
      },
      realtimeConnected ? LIST_POLL_REALTIME_MS : LIST_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [hasCenter, load, realtimeConnected]);
  useRealtimeEvent(REALTIME_EVENTS.taskStatus, () => load(true));

  const items: any[] = useMemo(() => {
    const rows: any[] = Array.isArray(data?.items) ? data.items : [];
    // 运行中置顶（服务端已按时间倒序，这里稳定分区）
    return [...rows.filter(row => row.state === 'running'), ...rows.filter(row => row.state !== 'running')];
  }, [data]);
  const summary = data?.summary || {};
  const open = (row: any) => {
    const target: MobileTaskRef = { kind: String(row.kind), id: Number(row.id) };
    rememberCurrentTask(target);
    nav(detailPath(target));
  };

  return (
    <div className="m-stack">
      <div className="m-section-head">
        <div>
          <h2>任务</h2>
          <p>
            {hasCenter
              ? `执行中 ${summary.running || 0} · 待处理 ${summary.review || 0} · 异常 ${(summary.failed || 0) + (summary.blocked || 0)}`
              : '刚派出的任务在这里跟进'}
            {' · '}
            <span className={`m-live${realtimeConnected ? ' m-live--on' : ''}`}>
              {realtimeConnected ? '实时' : '轮询同步'}
            </span>
          </p>
        </div>
        {hasCenter && (
          <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => load(true)} aria-label="刷新任务清单">
            刷新
          </Button>
        )}
      </div>
      {resume && (
        <div className="m-inbox-entry">
          <span className="m-row-main">
            <strong>继续看刚才的任务</strong>
            <small>
              {resume.kind === 'restaurant' ? '数字员工任务' : '任务'} #{resume.id}
            </small>
          </span>
          <Button type="primary" size="small" onClick={() => nav(detailPath(resume))}>
            打开
          </Button>
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined />}
            aria-label="不再提示"
            onClick={() => {
              rememberCurrentTask(null);
              setResume(null);
            }}
          />
        </div>
      )}
      {!hasCenter ? (
        <>
          <Alert
            type="info"
            showIcon
            message="完整任务清单需要开通「经营执行」模块"
            description="这里先列出你本次登录后刚派出的任务；也可以在电脑版任务中心查看全部。"
          />
          {recent.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有派出任务">
              <Button type="primary" onClick={() => nav(mobilePath('dispatch'))}>
                去派活
              </Button>
            </Empty>
          ) : (
            <div className="m-task-list">
              {recent.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className="m-row-button"
                  onClick={() => open({ kind: 'restaurant', id: item.id })}
                >
                  <span className="m-row-main">
                    <span className="m-row-title">{item.title || `任务 #${item.id}`}</span>
                    <span className="m-row-sub">
                      {item.employee} · {shortTime(item.at)}
                    </span>
                  </span>
                  <RightOutlined className="m-row-arrow" />
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="m-chips" role="tablist" aria-label="按状态筛选">
            {FILTERS.map(option => (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={filter === option.value}
                className={`m-chip${filter === option.value ? ' m-chip--active' : ''}`}
                onClick={() => setFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {loading && !data ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : error ? (
            <Alert
              type="error"
              showIcon
              message="任务清单加载失败"
              description={error}
              action={<Button onClick={() => load()}>重试</Button>}
            />
          ) : items.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选下暂无任务">
              {mods.includes('marshals') && (
                <Button type="primary" onClick={() => nav(mobilePath('dispatch'))}>
                  去给数字员工派个活
                </Button>
              )}
            </Empty>
          ) : (
            <div className="m-task-list" aria-live="polite">
              {items.map(row => (
                <button key={row.sourceKey} type="button" className="m-row-button" onClick={() => open(row)}>
                  <span className="m-row-main">
                    <span className="m-row-title">
                      <Tag color={STATE_COLOR[row.state] || 'default'}>
                        {row.displayStatus || row.adoptionContext?.label || '状态待确认'}
                      </Tag>
                      {row.title}
                    </span>
                    <span className="m-row-sub">
                      {row.employee} · {row.category} · {row.currentStep}（{row.stepIndex}/{row.stepTotal}）
                    </span>
                    {row.state === 'running' && (
                      <Progress
                        className="m-task-progress"
                        percent={Number(row.progress) || 0}
                        size="small"
                        showInfo={false}
                      />
                    )}
                    <span className="m-task-meta">
                      <span>{shortTime(row.createdAt)}</span>
                      {row.billing?.label && <span>{row.billing.label}</span>}
                    </span>
                  </span>
                  <RightOutlined className="m-row-arrow" />
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DetailHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="m-page-head">
      <button type="button" className="m-page-back" aria-label="返回任务列表" onClick={onBack}>
        <ArrowLeftOutlined />
      </button>
      <h2>{title}</h2>
    </div>
  );
}

function RestaurantTaskDetail({
  taskId,
  nav,
  user,
  realtimeConnected,
}: {
  taskId: number;
  nav: (path: string) => void;
  user: any;
  realtimeConnected: boolean;
}) {
  const [task, setTask] = useState<RestaurantTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [pollWarning, setPollWarning] = useState<ReturnType<typeof buildRestaurantTaskPollWarning> | null>(null);
  const [catalog, setCatalog] = useState<MobileEmployeeCatalog | null>(null);
  const [deliverables, setDeliverables] = useState<Deliverable[]>([]);
  const [exporting, setExporting] = useState('');
  const [reviewing, setReviewing] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const serial = useRef(0);

  useEffect(() => {
    rememberCurrentTask({ kind: 'restaurant', id: taskId });
  }, [taskId]);

  const load = useCallback(
    async (background = false) => {
      const current = ++serial.current;
      if (background) setRefreshing(true);
      try {
        const next = (await api.get(`/marshals/tasks/${taskId}/status`, { silent: true })) as RestaurantTask;
        if (current !== serial.current) return;
        setTask(next);
        setError('');
        setPollWarning(null);
      } catch (err: any) {
        if (current !== serial.current) return;
        if (!background) setError(err?.message || '任务状态读取失败');
        throw err;
      } finally {
        if (current === serial.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [taskId],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      load().catch(() => {});
    }, 0);
    loadEmployeeCatalog()
      .then(setCatalog)
      .catch(() => {});
    return () => window.clearTimeout(timer);
  }, [load]);

  // 生成中：SSE 在线 20s 兜底轮询、离线 5s；本任务的 task.status_changed 推送到达即刻拉取；失败指数退避且不改状态
  const running = isRunning(task?.status);
  useEffect(() => {
    if (!running) return undefined;
    const intervalMs = realtimeConnected ? RESTAURANT_TASK_REALTIME_POLL_INTERVAL_MS : RESTAURANT_TASK_POLL_INTERVAL_MS;
    let cancelled = false;
    let inFlight = false;
    let failures = 0;
    let timer: number | undefined;
    const schedule = (delay: number) => {
      if (cancelled) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void pull(), delay);
    };
    const pull = async () => {
      if (cancelled || inFlight) return;
      if (document.visibilityState !== 'visible') {
        schedule(intervalMs);
        return;
      }
      inFlight = true;
      try {
        const next = (await api.get(`/marshals/tasks/${taskId}/status`, { silent: true })) as RestaurantTask;
        if (cancelled) return;
        failures = 0;
        setPollWarning(null);
        setTask(next);
        if (isRunning(next.status)) schedule(intervalMs);
      } catch {
        if (cancelled) return;
        failures += 1;
        const warning = buildRestaurantTaskPollWarning(failures);
        setPollWarning(warning);
        schedule(warning.retryDelayMs);
      } finally {
        inFlight = false;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !inFlight) schedule(0);
    };
    const onRealtime = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; id?: number }>).detail;
      if (detail?.kind === 'restaurant' && Number(detail.id) === taskId && !inFlight) schedule(0);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(REALTIME_EVENTS.taskStatus, onRealtime);
    schedule(intervalMs);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(REALTIME_EVENTS.taskStatus, onRealtime);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [running, realtimeConnected, taskId]);

  // 已有报告且不是草稿：列出已生成的交付文件（不自动生成，导出按钮按需生成）
  const outputBody = String(task?.output_body || '');
  const hasReport = Boolean(outputBody.trim()) && !task?.draft;
  useEffect(() => {
    if (!hasReport) return undefined;
    let active = true;
    api
      .get(`/files/artifacts/source/agent_task/${taskId}`, { silent: true })
      .then(payload => {
        if (active) setDeliverables(Array.isArray(payload?.deliverables) ? payload.deliverables : []);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [hasReport, taskId]);

  const employee: MobileEmployee | null = useMemo(
    () => findEmployeeBySpecialist(catalog, task?.specialist_id),
    [catalog, task?.specialist_id],
  );
  const report = useMemo(
    () =>
      hasReport
        ? restaurantOutputPresentation(outputBody, { title: task?.title, requirement: task?.requirement })
        : null,
    [hasReport, outputBody, task?.title, task?.requirement],
  );
  const flow: string[] = Array.isArray(task?.flow) && task.flow.length ? task.flow : ['已派发', '生成中'];
  const stepIndex = Math.max(0, Math.min(Number(task?.stepIndex ?? 0), flow.length - 1));
  const draft = task?.draft || null;
  const displayStatus = String(task?.displayStatus || task?.status || '状态待确认');
  const canReview =
    task?.reviewReady === true &&
    Number(task?.output_id) > 0 &&
    ['boss', 'ops_director', 'manager', 'admin'].includes(String(user?.role || ''));
  const terminal = Boolean(task) && !running;
  const canRedispatch = terminal && !task?.supersededBy;

  const redispatch = () => {
    if (!task) return;
    const idx = Number(employee?.idx);
    if (!Number.isSafeInteger(idx) || idx <= 0) {
      message.info('没找到这位员工的岗位，请在派活里重新选人');
      nav(mobilePath('dispatch'));
      return;
    }
    writeDispatchPrefill({
      idx,
      question: String(task.title || ''),
      requirement: String(task.requirement || ''),
      type: task.type ? String(task.type) : undefined,
      fromTaskId: taskId,
    });
    nav(mobilePath('dispatch', { employee: idx }));
  };

  const review = async (decision: 'adopt' | 'reject', reason = '') => {
    if (!task?.output_id) return;
    setReviewing(decision);
    try {
      await api.post(`/marshals/outputs/${task.output_id}/review`, { decision, reason });
      message.success(decision === 'adopt' ? '已采纳，可用于业务' : '已驳回，提交人会收到通知');
      setRejectOpen(false);
      setRejectReason('');
      await load(true).catch(() => {});
    } catch {
      // api 客户端已提示服务端错误
    } finally {
      setReviewing('');
    }
  };

  const exportAs = async (format: 'pdf' | 'docx') => {
    setExporting(format);
    try {
      const payload = await api.post('/files/artifacts/source', {
        sourceType: 'agent_task',
        sourceId: taskId,
        formats: [format],
      });
      const list: Deliverable[] = Array.isArray(payload?.deliverables) ? payload.deliverables : [];
      const target = list.find(item => item.format === format) || list[0];
      if (!target?.downloadUrl) {
        message.warning('文件已生成但未返回下载地址，请稍后在交付文件里刷新');
        return;
      }
      setDeliverables(current => {
        const rest = current.filter(item => item.id !== target.id);
        return [...rest, target];
      });
      message.success(`${format === 'pdf' ? 'PDF' : 'Word'} 已生成`);
      window.open(safeUrl(target.downloadUrl), '_blank', 'noopener');
    } catch {
      // api 客户端已提示服务端错误（例如报告未通过质量门不可导出）
    } finally {
      setExporting('');
    }
  };

  const back = () => nav(mobilePath('tasks'));

  return (
    <div className={`m-stack${task ? ' m-has-action-bar' : ''}`}>
      <DetailHead title={task?.title || `任务 #${taskId}`} onBack={back} />
      {loading && !task ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : error && !task ? (
        <Alert
          type="error"
          showIcon
          message="任务状态读取失败"
          description={error}
          action={
            <Button onClick={() => void load().catch(() => {})} loading={refreshing}>
              重试
            </Button>
          }
        />
      ) : task ? (
        <>
          <div className="m-card">
            <div className="m-dispatch-emp">
              {employee ? (
                <EmployeeAvatar
                  idx={employee.idx}
                  name={employeeDisplayName(employee)}
                  color={`var(--chart-${deptToneIndex(catalog, employee.group) + 1})`}
                  size={44}
                />
              ) : null}
              <div className="m-row-main">
                <strong>{employee ? employeeDisplayName(employee) : task.marshal_name || '数字员工'}</strong>
                <span>
                  {employee?.name || employee?.duty || ''}
                  {task.type ? ` · ${task.type}` : ''} · {shortTime(task.createdAt || task.created_at)} · #{taskId}
                </span>
              </div>
              <Tag color={RUN_STATUS_COLOR[displayStatus] || (task.failed ? 'red' : 'default')}>{displayStatus}</Tag>
            </div>
            <Steps
              className="m-steps"
              direction="vertical"
              size="small"
              current={stepIndex}
              status={task.failed ? 'error' : running ? 'process' : stepIndex >= flow.length - 1 ? 'finish' : 'process'}
              items={flow.map(label => ({ title: label }))}
            />
            {running && (
              <div className="m-running-note" role="status" aria-live="polite">
                <span>
                  数字员工正在生成
                  {task.generationProgress?.currentLabel ? `：${task.generationProgress.currentLabel}` : '…'}
                </span>
                <span className="m-muted">
                  {realtimeConnected
                    ? '完成后会实时推送到这里'
                    : `每 ${RESTAURANT_TASK_POLL_INTERVAL_MS / 1000} 秒自动刷新`}
                  ；切到其他 Tab 也不会丢，完成后有站内通知。
                </span>
              </div>
            )}
            {pollWarning && running && (
              <Alert
                type="warning"
                showIcon
                className="m-block-gap"
                message={pollWarning.title}
                description={pollWarning.detail}
              />
            )}
            {!running && task.nextAction && <p className="m-text-2 m-block-gap">下一步：{task.nextAction}</p>}
            {task.failure?.message && !draft && (
              <Alert
                type="error"
                showIcon
                className="m-block-gap"
                message="执行异常"
                description={task.failure.message}
              />
            )}
          </div>

          {draft && (
            <div className="m-draft">
              <EmployeeDraftCard
                taskId={taskId}
                draft={draft}
                body={outputBody}
                onRedispatch={canRedispatch ? redispatch : undefined}
                onAccepted={() => void load(true).catch(() => {})}
              />
            </div>
          )}

          {report && (
            <section className="m-card m-report" aria-label="岗位交付报告">
              <div className="m-report-eyebrow">
                <span>老板速览</span>
                <small>先看结论、证据、风险与行动</small>
              </div>
              <Markdown content={report.overviewMarkdown} />
              {report.deliverablesMarkdown && (
                <details className="m-fold">
                  <summary>
                    <span>{report.structured ? '岗位完整成果' : '完整报告'}</span>
                    <small>{report.structured ? `${report.deliverableCount} 项交付` : '全部分析与来源'}</small>
                  </summary>
                  <div className="m-fold-body">
                    <Markdown content={report.deliverablesMarkdown} />
                  </div>
                </details>
              )}
              {report.structured && report.inputMethodMarkdown && (
                <details className="m-fold">
                  <summary>
                    <span>输入与方法执行记录</span>
                  </summary>
                  <div className="m-fold-body">
                    <Markdown content={report.inputMethodMarkdown} />
                  </div>
                </details>
              )}
              {report.structured && report.governanceMarkdown && (
                <details className="m-fold">
                  <summary>
                    <span>质量与授权记录</span>
                  </summary>
                  <div className="m-fold-body">
                    <Markdown content={report.governanceMarkdown} />
                  </div>
                </details>
              )}
              {deliverables.length > 0 && (
                <div className="m-deliverables">
                  {deliverables.map(item => (
                    <Button
                      key={item.id}
                      size="small"
                      icon={<DownloadOutlined />}
                      href={safeUrl(item.downloadUrl)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {item.label || item.format?.toUpperCase() || item.fileName || '文件'}
                    </Button>
                  ))}
                </div>
              )}
            </section>
          )}

          {!running && !report && !draft && (
            <div className="m-card">
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={task.reviewBlockedReason || task.failure?.message || '本次没有生成业务产物'}
              />
            </div>
          )}

          <details className="m-fold">
            <summary>
              <span>任务输入</span>
            </summary>
            <div className="m-fold-body">
              <dl className="m-task-facts">
                <dt>目标</dt>
                <dd>{task.title || '—'}</dd>
                {task.requirement && (
                  <>
                    <dt>补充要求</dt>
                    <dd>{task.requirement}</dd>
                  </>
                )}
                {task.billing?.label && (
                  <>
                    <dt>费用</dt>
                    <dd>{task.billing.label}</dd>
                  </>
                )}
                {task.reviewBlockedReason && !canReview && (
                  <>
                    <dt>审阅</dt>
                    <dd>{task.reviewBlockedReason}</dd>
                  </>
                )}
              </dl>
            </div>
          </details>

          <div className="m-action-bar">
            {canReview ? (
              <>
                <Button
                  type="primary"
                  icon={<CheckOutlined />}
                  loading={reviewing === 'adopt'}
                  disabled={Boolean(reviewing) && reviewing !== 'adopt'}
                  onClick={() => void review('adopt')}
                >
                  采纳
                </Button>
                <Button
                  danger
                  icon={<StopOutlined />}
                  disabled={Boolean(reviewing)}
                  onClick={() => {
                    setRejectReason('');
                    setRejectOpen(true);
                  }}
                >
                  驳回
                </Button>
              </>
            ) : running ? (
              <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void load(true).catch(() => {})}>
                刷新进度
              </Button>
            ) : (
              <>
                {canRedispatch && (
                  <Button type={hasReport ? 'default' : 'primary'} icon={<RedoOutlined />} onClick={redispatch}>
                    带原要求重新派活
                  </Button>
                )}
                {hasReport && (
                  <>
                    <Button
                      icon={<FilePdfOutlined />}
                      loading={exporting === 'pdf'}
                      disabled={Boolean(exporting)}
                      onClick={() => void exportAs('pdf')}
                    >
                      PDF
                    </Button>
                    <Button
                      icon={<FileWordOutlined />}
                      loading={exporting === 'docx'}
                      disabled={Boolean(exporting)}
                      onClick={() => void exportAs('docx')}
                    >
                      Word
                    </Button>
                  </>
                )}
              </>
            )}
          </div>
          <Modal
            open={rejectOpen}
            title="驳回这份产出"
            okText="确认驳回"
            cancelText="取消"
            okButtonProps={{ danger: true, loading: reviewing === 'reject' }}
            onCancel={() => setRejectOpen(false)}
            onOk={() => {
              const text = rejectReason.trim();
              if (!text) {
                message.warning('请写一句驳回理由，提交人才知道怎么改');
                return;
              }
              void review('reject', text);
            }}
            destroyOnHidden
          >
            <Input.TextArea
              value={rejectReason}
              onChange={event => setRejectReason(event.target.value)}
              placeholder="哪里不合要求、要怎么改（会记录并通知提交人）"
              autoSize={{ minRows: 3, maxRows: 6 }}
              maxLength={1000}
              showCount
            />
          </Modal>
        </>
      ) : null}
    </div>
  );
}

function GenericTaskDetail({
  taskRef,
  nav,
  realtimeConnected,
}: {
  taskRef: MobileTaskRef;
  nav: (path: string) => void;
  realtimeConnected: boolean;
}) {
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const serial = useRef(0);

  useEffect(() => {
    rememberCurrentTask({ kind: taskRef.kind, id: taskRef.id });
  }, [taskRef.kind, taskRef.id]);

  const load = useCallback(
    (background = false) => {
      const current = ++serial.current;
      if (!background) setLoading(true);
      api
        .get(`/task-center/${taskRef.kind}/${taskRef.id}`, { silent: true })
        .then(data => {
          if (current !== serial.current) return;
          setDetail(data);
          setError('');
        })
        .catch((err: Error) => {
          if (current === serial.current && !background) setError(err.message || '任务详情加载失败');
        })
        .finally(() => {
          if (current === serial.current) setLoading(false);
        });
    },
    [taskRef.id, taskRef.kind],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const running = String(detail?.state || '') === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(
      () => {
        if (document.visibilityState === 'visible') load(true);
      },
      realtimeConnected ? 15_000 : 5_000,
    );
    return () => window.clearInterval(timer);
  }, [load, realtimeConnected, running]);
  useRealtimeEvent<{ kind?: string; id?: number }>(REALTIME_EVENTS.taskStatus, event => {
    if (String(event?.kind || '') === taskRef.kind && Number(event?.id) === taskRef.id) load(true);
  });

  const back = () => nav(mobilePath('tasks'));
  const stepTotal = Math.max(1, Number(detail?.stepTotal) || 1);
  const stepIndex = Math.max(0, Math.min(Number(detail?.stepIndex) || 0, stepTotal));

  return (
    <div className="m-stack">
      <DetailHead title={detail?.title || `任务 #${taskRef.id}`} onBack={back} />
      {loading && !detail ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : error && !detail ? (
        <Alert
          type="error"
          showIcon
          message="任务详情加载失败"
          description={error}
          action={<Button onClick={() => load()}>重试</Button>}
        />
      ) : detail ? (
        <>
          <div className="m-card">
            <div className="m-row-title">
              <Tag color={STATE_COLOR[detail.state] || 'default'}>
                {detail.displayStatus || detail.adoptionContext?.label || '状态待确认'}
              </Tag>
              <span className="m-muted">
                {detail.employee} · {detail.category}
              </span>
            </div>
            <dl className="m-task-facts m-block-gap">
              <dt>当前步骤</dt>
              <dd>
                {detail.currentStep}（{stepIndex}/{stepTotal}）
              </dd>
              <dt>费用</dt>
              <dd>{detail.billing?.label || '—'}</dd>
              {detail.createdAt && (
                <>
                  <dt>发起时间</dt>
                  <dd>{shortTime(detail.createdAt)}</dd>
                </>
              )}
            </dl>
            {running && (
              <Progress
                className="m-task-progress"
                percent={Number(detail.progress) || 0}
                size="small"
                showInfo={false}
              />
            )}
            {detail.error && (
              <Alert type="error" showIcon className="m-block-gap" message="执行异常" description={detail.error} />
            )}
          </div>
          {detail.kind === 'restaurant' && detail.draft && (
            <div className="m-draft">
              <EmployeeDraftCard
                taskId={Number(detail.id)}
                draft={detail.draft}
                body={detail.report?.markdown || detail.output || ''}
                bodyOpen
                onAccepted={() => load(true)}
              />
            </div>
          )}
          {detail.report?.markdown && !detail.draft ? (
            <section className="m-card m-report" aria-label="执行结果">
              <div className="m-report-eyebrow">
                <span>执行结果</span>
              </div>
              <Markdown content={detail.report.markdown} />
            </section>
          ) : detail.output && !detail.draft ? (
            <div className="m-card">
              {/^(https?:\/\/|\/)/u.test(String(detail.output)) ? (
                <a href={safeUrl(detail.output)} target="_blank" rel="noreferrer">
                  打开媒体结果
                </a>
              ) : (
                <pre className="m-fold-body">{detail.output}</pre>
              )}
            </div>
          ) : !running && !detail.draft ? (
            <div className="m-card">
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={detail.resultUnavailableReason || '结果尚未生成'}
              />
            </div>
          ) : null}
          {Array.isArray(detail.deliverables) && detail.deliverables.length > 0 && (
            <div className="m-card">
              <div className="m-card-title">交付文件</div>
              <div className="m-deliverables">
                {detail.deliverables.map((artifact: any) => (
                  <Button
                    key={artifact.id}
                    size="small"
                    icon={<DownloadOutlined />}
                    href={safeUrl(artifact.downloadUrl)}
                    target="_blank"
                    rel="noreferrer"
                    disabled={artifact.downloadAvailable === false}
                  >
                    {artifact.label || artifact.format?.toUpperCase() || '文件'}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <details className="m-fold">
            <summary>
              <span>任务输入</span>
            </summary>
            <div className="m-fold-body">
              <pre>{detail.input || '暂无输入说明'}</pre>
            </div>
          </details>
          {detail.deepLink && (
            <Button block onClick={() => nav(detail.deepLink)}>
              在电脑版任务中心查看完整详情
            </Button>
          )}
        </>
      ) : null}
    </div>
  );
}
