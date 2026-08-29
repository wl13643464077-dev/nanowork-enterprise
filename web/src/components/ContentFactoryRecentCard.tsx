import {
  ClockCircleOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  SendOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import { Button, Popconfirm, Tag, Tooltip } from 'antd';
import type { CSSProperties } from 'react';
import {
  TYPE_META,
  canSubmitApproval,
  contentFlowBlockedReason,
  contentFlowReady,
  contentStatusColor,
  contentStatusLabel,
  contentTypeLabel,
  fmtTime,
} from '../data/contentFactoryConstants';
import './ContentFactoryCards.css';

type Props = {
  record: any;
  importing: boolean;
  onOpen: (record: any) => unknown;
  onImport: (record: any) => unknown;
  onSubmitApproval: (record: any) => unknown;
  onOpenPublish: (record: any) => unknown;
  onDelete: (record: any) => unknown;
};

export default function ContentFactoryRecentCard({
  record,
  importing,
  onOpen,
  onImport,
  onSubmitApproval,
  onOpenPublish,
  onDelete,
}: Props) {
  const meta = TYPE_META[record.type] || { icon: <FileTextOutlined />, color: 'var(--ui-accent)' };
  const pendingHighlight = record.status === '待审核';
  const flowReady = contentFlowReady(record);
  const blockedReason = flowReady ? '' : contentFlowBlockedReason(record);
  const title = record.title || record.topic || '未命名内容';
  const approvalActionLabel = record.delivery?.approvalActionLabel === '补建审阅单' ? '补建确认单' : '提交策略确认';

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`查看内容：${title}`}
      onClick={() => onOpen(record)}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onOpen(record);
      }}
      className="content-recent-card"
      data-pending={pendingHighlight || undefined}
    >
      <div className="content-recent-head">
        <div className="content-recent-icon" style={{ '--content-type-color': meta.color } as CSSProperties}>
          {meta.icon}
        </div>
        <div className="content-recent-copy">
          <div className="content-recent-title">{title}</div>
          <div className="content-recent-meta">
            {contentTypeLabel(record.type)}
            {record.creator ? ` · ${record.creator}` : ''}
          </div>
        </div>
      </div>
      <div className="content-recent-status">
        <Tag color={contentStatusColor(record)}>{contentStatusLabel(record)}</Tag>
        <span className="content-recent-time">
          <ClockCircleOutlined /> {fmtTime(record.created_at)}
        </span>
      </div>
      <div
        role="toolbar"
        aria-label="内容操作"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
        className="content-recent-actions"
      >
        <Tooltip title={blockedReason}>
          <span>
            <Button
              size="small"
              icon={<FolderOpenOutlined />}
              disabled={!flowReady}
              loading={importing}
              onClick={() => onImport(record)}
            >
              导入素材库
            </Button>
          </span>
        </Tooltip>
        {canSubmitApproval(record) && (
          <Tooltip title="该任务由显式策略要求确认">
            <span>
              <Button size="small" onClick={() => onSubmitApproval(record)}>
                {approvalActionLabel}
              </Button>
            </span>
          </Tooltip>
        )}
        <Tooltip title={blockedReason}>
          <span>
            <Button
              size="small"
              type="primary"
              ghost
              icon={<SendOutlined />}
              disabled={!flowReady}
              onClick={() => onOpenPublish(record)}
            >
              发布登记
            </Button>
          </span>
        </Tooltip>
        <Popconfirm
          title={`删除「${title === '未命名内容' ? '该内容' : title}」？`}
          description="删除后进入回收站，老板/管理员可恢复。"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => onDelete(record)}
        >
          <Button size="small" danger icon={<DeleteOutlined />}>
            删除
          </Button>
        </Popconfirm>
      </div>
    </div>
  );
}
