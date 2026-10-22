import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, Space, Spin, Tag, message } from 'antd';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import { Markdown } from './Markdown';
import NativeDeliverableDownloadButton from './NativeDeliverableDownloadButton';
import TaskFeedback from './TaskFeedback';
import './SpecialistTaskHistory.css';

export type SpecialistHistoryRow = {
  kind: 'media' | 'generated_content';
  id: number;
  title: string;
  inputSummary: string;
  status: string;
  createdAt?: string | null;
  active?: boolean;
  businessDecision?: 'pending' | 'adopted' | 'rejected';
};

type BusinessDecision = 'adopt' | 'reject';

type SpecialistTaskHistoryProps = {
  title: string;
  rows: SpecialistHistoryRow[];
  loading?: boolean;
  error?: string;
  onReload?: () => void | Promise<unknown>;
  onBusinessDecision?: (row: SpecialistHistoryRow, decision: BusinessDecision) => Promise<unknown>;
};

const statusColor = (value: string) => {
  const status = String(value || '').toLowerCase();
  if (/(失败|failed|error)/u.test(status)) return 'error';
  if (/(成功|完成|success|done|可使用)/u.test(status)) return 'success';
  if (/(阻塞|待对账|blocked)/u.test(status)) return 'warning';
  return 'processing';
};

const statusLabel = (value: string) => {
  const status = String(value || '').trim();
  if (['success', '成功', 'done', '已完成', '可使用'].includes(status)) return '已完成';
  if (['failed', '失败', 'error'].includes(status)) return '生成失败';
  if (['blocked', '阻塞'].includes(status)) return '暂时受阻';
  if (['running', 'processing', '处理中', '生成中'].includes(status)) return '生成中';
  return status || '状态待更新';
};

const formatTime = (value?: string | null) => {
  if (!value) return '时间未记录';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
};

const taskText = (value: unknown, fallback: string) => {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  return fallback;
};

export function XhsTaskFeedback({
  row,
  task,
  onTaskUpdated,
  onBusinessDecision,
}: {
  row: SpecialistHistoryRow;
  task: any;
  onTaskUpdated: (task: any) => void;
  onBusinessDecision: (row: SpecialistHistoryRow, decision: BusinessDecision) => Promise<unknown>;
}) {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState<BusinessDecision | null>(null);
  const [retryDecision, setRetryDecision] = useState<BusinessDecision | null>(null);
  const [retryMessage, setRetryMessage] = useState('');
  const pending = useRef(false);
  const requestKeys = useRef<Partial<Record<BusinessDecision, string>>>({});
  const feedback = task.feedback;
  const oldVersion = feedback?.currentVersion === false;
  const available = task.feedbackAvailability?.available === true && (!feedback || oldVersion);

  const recordFeedback = async (decision: BusinessDecision) => {
    if (!available || pending.current) return;
    pending.current = true;
    setSubmitting(decision);
    const expectedBusinessDecision = decision === 'adopt' ? 'adopted' : 'rejected';
    let businessSaved = row.businessDecision === expectedBusinessDecision || retryDecision === decision;
    requestKeys.current[decision] ||= crypto.randomUUID();
    try {
      if (!businessSaved) {
        await onBusinessDecision(row, decision);
        businessSaved = true;
      }
      // 业务采纳可能保存了当前页面的编辑稿，因此第二步前重新读取结果版本。
      const latest = await api.get(`/task-center/generated_content/${row.id}`, { silent: true });
      const response = await api.post(`/task-center/generated_content/${row.id}/feedback`, {
        decision,
        note: note.trim(),
        requestKey: requestKeys.current[decision],
        resultVersion: latest.resultVersion,
      });
      if (!response?.ok || !response?.task) throw new Error('经验记录回执不完整，请重试');
      onTaskUpdated(response.task);
      setRetryDecision(null);
      setRetryMessage('');
      message.success(decision === 'adopt' ? '已采纳，并记住这次经验' : '已记录不采纳，原结果仍保留');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '反馈未保存，请重试';
      if (businessSaved) {
        setRetryDecision(decision);
        setRetryMessage(`${decision === 'adopt' ? '采纳' : '不采纳'}状态已保存，但经验记录尚未完成：${errorMessage}`);
      } else {
        message.error(errorMessage);
      }
    } finally {
      pending.current = false;
      setSubmitting(null);
    }
  };

  if (!task.feedbackAvailability && !feedback) return null;
  return (
    <section className="task-center-feedback" aria-label="结果采纳">
      <h4>这份结果是否采用？</h4>
      <p>你的选择会同时保存到这条种草任务，并作为这位数字员工下次工作的经验。</p>
      {feedback && (
        <div className="task-center-feedback-record">
          <Tag color={!oldVersion && feedback.decision === 'adopt' ? 'green' : 'default'}>
            {oldVersion ? '旧版本反馈' : feedback.decision === 'adopt' ? '已采纳' : '已记录不采纳（原结果保留）'}
          </Tag>
          {feedback.note && <p>{feedback.note}</p>}
          {feedback.learningLabel && <p>{feedback.learningLabel}</p>}
        </div>
      )}
      {retryDecision && (
        <Alert
          type="warning"
          showIcon
          message={retryMessage}
          description="点击下面的重试只补记经验，不会重新生成图文，也不会重复扣费。"
          action={
            <Button loading={submitting === retryDecision} onClick={() => void recordFeedback(retryDecision)}>
              重试记录经验
            </Button>
          }
        />
      )}
      {available && !retryDecision && (
        <>
          <Input.TextArea
            aria-label="给小红书种草员的反馈"
            placeholder="可选：哪里满意，或下次希望怎么改？"
            maxLength={2000}
            showCount
            autoSize={{ minRows: 2, maxRows: 5 }}
            value={note}
            onChange={event => setNote(event.target.value)}
            disabled={Boolean(submitting)}
          />
          <Space wrap className="task-center-feedback-actions">
            <Button
              type="primary"
              loading={submitting === 'adopt'}
              disabled={Boolean(submitting)}
              onClick={() => void recordFeedback('adopt')}
            >
              采纳这份结果
            </Button>
            <Button
              loading={submitting === 'reject'}
              disabled={Boolean(submitting)}
              onClick={() => void recordFeedback('reject')}
            >
              不采纳，保留原结果
            </Button>
          </Space>
        </>
      )}
    </section>
  );
}

export function HistoryItem({
  row,
  onBusinessDecision,
}: {
  row: SpecialistHistoryRow;
  onBusinessDecision?: SpecialistTaskHistoryProps['onBusinessDecision'];
}) {
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(Boolean(row.active));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadDetail = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      const next = await api.get(`/task-center/${row.kind}/${row.id}`, { silent: true });
      if (mounted.current) setDetail(next);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : '任务详情暂时没有载入，请重试。');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [loading, row.id, row.kind]);

  useEffect(() => {
    if (!open || detail || loading) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadDetail();
    });
    return () => {
      cancelled = true;
    };
  }, [detail, loadDetail, loading, open]);

  const media = Array.isArray(detail?.media) ? detail.media : [];
  return (
    <details
      className="specialist-task-history__item"
      open={open}
      onToggle={event => {
        const nextOpen = event.currentTarget.open;
        setOpen(nextOpen);
        if (nextOpen && !detail && !loading) void loadDetail();
      }}
    >
      <summary aria-label={`展开任务 #${row.id} 的输入与结果`}>
        <span className="specialist-task-history__summary-main">
          <strong>{row.title || `任务 #${row.id}`}</strong>
          <span>{row.inputSummary || '未记录输入主题'}</span>
        </span>
        <span className="specialist-task-history__summary-meta">
          <Tag color={statusColor(row.status)}>{statusLabel(row.status)}</Tag>
          <span>{formatTime(row.createdAt)}</span>
          <span>#{row.id}</span>
        </span>
      </summary>
      <div className="specialist-task-history__body">
        {loading && <Spin size="small" tip="正在加载输入和结果" />}
        {error && (
          <Alert
            type="warning"
            showIcon
            message={error}
            action={
              <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadDetail()}>
                重试
              </Button>
            }
          />
        )}
        {detail && (
          <>
            <section>
              <h4>本次输入</h4>
              <Markdown content={taskText(detail.inputDisplay ?? detail.input, row.inputSummary || '暂无输入说明')} />
            </section>
            <section>
              <div className="specialist-task-history__result-head">
                <h4>生成结果</h4>
                <NativeDeliverableDownloadButton url={detail.downloadUrl} name={detail.downloadName} />
              </div>
              {detail.report?.markdown || detail.output ? (
                <Markdown content={taskText(detail.report?.markdown || detail.output, '')} />
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={detail.error || detail.resultUnavailableReason || '本次没有形成可交付结果'}
                />
              )}
            </section>
            {!!media.length && (
              <div className="specialist-task-history__media" aria-label="历史任务媒体结果">
                {media.map((item: any, index: number) => {
                  const url = String(item.url || '');
                  return (
                    <figure key={item.id || item.url || index}>
                      {item.kind === 'video' && url && (
                        // 服务端只返回当前租户有权预览的媒体地址。
                        // eslint-disable-next-line jsx-a11y/media-has-caption
                        <video controls playsInline preload="metadata" src={url} />
                      )}
                      {item.kind === 'image' && url && <img src={url} alt={item.label || `生成图片 ${index + 1}`} />}
                      {item.kind === 'audio' && url && (
                        // 历史音频任务没有独立字幕轨文件。
                        // eslint-disable-next-line jsx-a11y/media-has-caption
                        <audio controls preload="metadata" src={url} />
                      )}
                      <figcaption>{item.label || '生成文件'}</figcaption>
                      {url && (
                        <Button icon={<DownloadOutlined />} href={item.downloadUrl || url} download>
                          下载
                        </Button>
                      )}
                    </figure>
                  );
                })}
              </div>
            )}
            {row.kind === 'generated_content' && onBusinessDecision ? (
              <XhsTaskFeedback
                row={row}
                task={detail}
                onTaskUpdated={setDetail}
                onBusinessDecision={onBusinessDecision}
              />
            ) : (
              <TaskFeedback task={detail} onUpdated={setDetail} />
            )}
          </>
        )}
      </div>
    </details>
  );
}

// 历史默认折叠：对话区的最新结果才是主角，历史只在老板想翻的时候展开，
// 且一次只显示最近几条，避免页面被几十条记录拉得很长。
const HISTORY_PAGE_SIZE = 5;

export default function SpecialistTaskHistory({
  title,
  rows,
  loading = false,
  error = '',
  onReload,
  onBusinessDecision,
}: SpecialistTaskHistoryProps) {
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(HISTORY_PAGE_SIZE);
  const visibleRows = rows.slice(0, visibleCount);
  const hiddenCount = Math.max(0, rows.length - visibleRows.length);
  return (
    <section className="specialist-task-history" aria-label={title}>
      <header>
        <div>
          <h3>
            {title}
            {rows.length > 0 && <span className="specialist-task-history__count">（{rows.length} 条）</span>}
          </h3>
          <p>
            {expanded
              ? '每次输入和结果都保留在这里。展开单条即可查看、下载，并选择采纳或不采纳。'
              : '历史记录已收起，不影响上方最新结果；需要回看或采纳旧记录时再展开。'}
          </p>
        </div>
        <div className="specialist-task-history__actions">
          <Button
            size="small"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded(value => !value);
              setVisibleCount(HISTORY_PAGE_SIZE);
            }}
          >
            {expanded ? '收起历史' : '展开历史'}
          </Button>
          {expanded && onReload && (
            <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void onReload()}>
              刷新历史
            </Button>
          )}
        </div>
      </header>
      {expanded && error && <Alert type="warning" showIcon message={error} />}
      {expanded &&
        (!rows.length && !loading ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有生成记录" />
        ) : (
          <div className="specialist-task-history__list">
            {visibleRows.map(row => (
              <HistoryItem key={`${row.kind}:${row.id}`} row={row} onBusinessDecision={onBusinessDecision} />
            ))}
            {hiddenCount > 0 && (
              <Button block size="small" onClick={() => setVisibleCount(value => value + HISTORY_PAGE_SIZE)}>
                显示更早的 {hiddenCount} 条
              </Button>
            )}
          </div>
        ))}
    </section>
  );
}
