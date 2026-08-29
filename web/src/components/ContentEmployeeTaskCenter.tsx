import { Alert, Button, Empty, Pagination, Select, Skeleton, Tag } from 'antd';
import { ClockCircleOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type {
  ContentEmployeeQueueResponse,
  ContentEmployeePublicRunStatus,
  ContentEmployeeRunStatus,
  EmployeeRunPresentationKey,
  EmployeeWorkbenchRun,
} from '../api/employeeWorkbenchTypes';
import './ContentEmployeeTaskCenter.css';

const PAGE_SIZE = 30;

const STATUS_META: Record<ContentEmployeeRunStatus, { label: string; color: string }> = {
  生成中: { label: '生成中', color: 'processing' },
  待审阅: { label: '待人工审阅', color: 'gold' },
  已完成: { label: '已完成（可用于业务）', color: 'green' },
  已驳回: { label: '失败需返工', color: 'orange' },
  失败: { label: '失败需处理（执行异常）', color: 'red' },
};

const FILTER_STATUS_META: Record<ContentEmployeePublicRunStatus, { label: string; color: string }> = {
  ...STATUS_META,
  失败: { label: '全部失败（返工或处理）', color: 'red' },
  待账务对账: { label: '业务暂不可采用（待账务对账）', color: 'orange' },
};
const PRESENTATION_META: Record<EmployeeRunPresentationKey, { label: string; color: string }> = {
  generating: { label: '生成中', color: 'processing' },
  review_pending: { label: '待人工审阅', color: 'gold' },
  adopted: { label: '已完成（可用于业务）', color: 'green' },
  business_blocked: { label: '业务暂不可采用（待账务对账）', color: 'orange' },
  rework_required: { label: '失败需返工', color: 'red' },
  execution_failed: { label: '失败需处理（执行异常）', color: 'red' },
  historical: { label: '历史失败（后续已修复）', color: 'blue' },
};

const PRESENTATION_ACTION_LABEL: Record<EmployeeRunPresentationKey, string> = {
  generating: '查看实时进度',
  review_pending: '打开结果并处理',
  adopted: '打开完整结果与费用',
  business_blocked: '查看对账状态与处理建议',
  rework_required: '查看返工原因与处理建议',
  execution_failed: '查看执行错误与处理建议',
  historical: '查看历史失败与修复记录',
};

function runStatusMeta(run: EmployeeWorkbenchRun) {
  const displayStatus = String(run.displayStatus || '').trim();
  const presentation = PRESENTATION_META[run.presentationKey as EmployeeRunPresentationKey];
  if (presentation) return { ...presentation, label: displayStatus || presentation.label };
  if (run.remediated === true) return PRESENTATION_META.historical;
  if (displayStatus.includes('待账务对账')) return FILTER_STATUS_META['待账务对账'];
  if (displayStatus.includes('质检') || displayStatus.includes('失败')) {
    return { label: displayStatus, color: 'red' };
  }
  if (displayStatus.includes('待人工') || displayStatus.includes('可验收')) {
    return { label: displayStatus, color: 'gold' };
  }
  if (displayStatus) return { ...STATUS_META[run.status], label: displayStatus };
  return STATUS_META[run.status] || { label: run.status, color: 'default' };
}

export function contentEmployeeRunActionLabel(run: EmployeeWorkbenchRun) {
  const presentationKey = run.remediated === true ? 'historical' : String(run.presentationKey || '');
  if (Object.prototype.hasOwnProperty.call(PRESENTATION_ACTION_LABEL, presentationKey)) {
    return PRESENTATION_ACTION_LABEL[presentationKey as EmployeeRunPresentationKey];
  }
  if (run.status === '生成中') return PRESENTATION_ACTION_LABEL.generating;
  if (run.status === '待审阅') return PRESENTATION_ACTION_LABEL.review_pending;
  if (run.status === '已完成') return PRESENTATION_ACTION_LABEL.adopted;
  if (run.status === '已驳回') return PRESENTATION_ACTION_LABEL.rework_required;
  if (run.status === '失败') return PRESENTATION_ACTION_LABEL.execution_failed;
  return '打开任务详情';
}

type Props = {
  refreshToken?: number;
  onOpenRun: (run: EmployeeWorkbenchRun) => void;
  onData?: (data: ContentEmployeeQueueResponse | null) => void;
};

function formatTime(value?: string) {
  if (!value) return '时间未记录';
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export default function ContentEmployeeTaskCenter({ refreshToken = 0, onOpenRun, onData }: Props) {
  const [status, setStatus] = useState<ContentEmployeePublicRunStatus | ''>('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ContentEmployeeQueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadSerial, setReloadSerial] = useState(0);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError('');
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
      });
      if (status) params.set('status', status);
      api
        .get(`/employee-workbench/content/runs?${params.toString()}`)
        .then(raw => {
          if (cancelled) return;
          const next = raw as ContentEmployeeQueueResponse;
          const maxPage = Math.max(1, Math.ceil(next.total / PAGE_SIZE));
          if (page > maxPage) {
            setPage(maxPage);
            return;
          }
          setData(next);
          onData?.(next);
        })
        .catch((requestError: any) => {
          if (cancelled) return;
          setData(null);
          onData?.(null);
          setError(requestError?.message || '内容数字员工任务读取失败');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [onData, page, refreshToken, reloadSerial, status]);

  useEffect(() => {
    if (!data?.statusCounts?.['生成中']) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setReloadSerial(value => value + 1);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [data?.statusCounts]);

  const statusOptions = useMemo(
    () => [
      { value: '', label: `全部任务${data ? `（${data.visibleTotal}）` : ''}` },
      ...Object.entries(FILTER_STATUS_META).map(([value, meta]) => ({
        value,
        label: `${meta.label}${data ? `（${data.statusCounts[value as ContentEmployeePublicRunStatus] || 0}）` : ''}`,
      })),
    ],
    [data],
  );

  return (
    <section
      id="content-employee-task-center"
      className="content-employee-task-center"
      aria-labelledby="content-task-center-title"
    >
      <header className="content-task-center-head">
        <div>
          <span>11 名内容员工 · 真实运行记录</span>
          <h2 id="content-task-center-title">内容数字员工任务中心</h2>
          <p>
            {data?.scope.label || '按当前账号权限读取任务'}
            ；这里汇总生成中、已完成、策略要求人工确认、业务暂不可采用和失败任务。失败待处理统计只包含当前仍需查因或返工的任务；已被后续可用结果修复的旧失败只作历史复盘。
          </p>
        </div>
        <div className="content-task-center-actions">
          <Select
            aria-label="筛选内容员工任务状态"
            value={status}
            options={statusOptions}
            onChange={value => {
              setStatus(value as ContentEmployeePublicRunStatus | '');
              setPage(1);
            }}
          />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => setReloadSerial(value => value + 1)}>
            刷新
          </Button>
        </div>
      </header>

      {data && (
        <dl className="content-task-center-summary" aria-label="内容员工任务状态统计">
          {(
            Object.entries(PRESENTATION_META) as Array<
              [EmployeeRunPresentationKey, (typeof PRESENTATION_META)[EmployeeRunPresentationKey]]
            >
          ).map(([key, meta]) => (
            <div key={key} data-status={key}>
              <dt>{meta.label}</dt>
              <dd>{data.presentationCounts?.[key] || 0}</dd>
            </div>
          ))}
        </dl>
      )}

      {error ? (
        <Alert
          type="error"
          showIcon
          message="内容数字员工任务中心加载失败"
          description={error}
          action={<Button onClick={() => setReloadSerial(value => value + 1)}>重新加载</Button>}
        />
      ) : loading && !data ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : !data?.runs.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前范围内没有符合条件的内容员工任务" />
      ) : (
        <div className="content-task-center-list" aria-busy={loading}>
          {data.runs.map(run => {
            const meta = runStatusMeta(run);
            return (
              <button type="button" key={run.id} onClick={() => onOpenRun(run)}>
                <span className="content-task-center-employee">
                  <b>#{String(run.employeeIdx).padStart(2, '0')}</b>
                  <span>
                    <strong>{run.employeeName || `内容员工 ${run.employeeIdx}`}</strong>
                    <small>{run.employeeGroup || '内容生产部'}</small>
                  </span>
                </span>
                <span className="content-task-center-task">
                  <strong>{run.title || `任务 #${run.id}`}</strong>
                  <small>
                    {run.type || '岗位交付'} · 运行 #{run.id}
                  </small>
                  {run.remediated && run.remediatedByRunId && (
                    <em>后续权威运行 #{run.remediatedByRunId} 已采纳，本条仅保留原失败原因供复盘。</em>
                  )}
                  {run.resultPreview && <em>{run.resultPreview}</em>}
                </span>
                <span className="content-task-center-state">
                  <Tag color={meta.color}>{meta.label}</Tag>
                  <small>
                    <ClockCircleOutlined /> {formatTime(run.updatedAt || run.createdAt)}
                  </small>
                  <b>{contentEmployeeRunActionLabel(run)}</b>
                </span>
                <RightOutlined className="content-task-center-open" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}

      {data && data.total > PAGE_SIZE && (
        <Pagination
          size="small"
          current={page}
          pageSize={PAGE_SIZE}
          total={data.total}
          showSizeChanger={false}
          onChange={setPage}
          showTotal={total => `当前筛选共 ${total} 条`}
        />
      )}

      {data && !data.scope.canViewInternalProfile && (
        <p className="content-task-center-boundary">
          当前账号只显示有权查看的任务、进度和业务结果；能力、技能、提示词、配置及岗位档案仅老板或管理员可查看。
        </p>
      )}
    </section>
  );
}
