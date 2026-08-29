import { DeleteOutlined, EyeOutlined, UndoOutlined } from '@ant-design/icons';
import { Alert, Button, Empty, Popconfirm, Select, Space, Table, Tag, Tooltip } from 'antd';

import { Panel } from './Kit';
import { ROLE_MAP } from './SystemPrimitives';
import './SystemGovernance.css';

export function SystemDeletionHistoryPanel({
  deletionStatus,
  deletionLoading,
  deletions,
  onStatusChange,
  onRefresh,
  onOpen,
  onRestore,
}: {
  deletionStatus: string;
  deletionLoading: boolean;
  deletions: any[];
  onStatusChange: (status: string) => void;
  onRefresh: () => void;
  onOpen: (row: any) => void;
  onRestore: (row: any) => void;
}) {
  return (
    <Panel
      title={
        <>
          <DeleteOutlined className="system-deletion-history__danger-icon" /> 删除留痕
        </>
      }
      extra={
        <Space size={8}>
          <Select
            size="small"
            value={deletionStatus}
            className="system-deletion-history__status-select"
            options={[
              { value: 'active', label: '未恢复' },
              { value: 'restored', label: '已恢复' },
              { value: '', label: '全部' },
            ]}
            onChange={onStatusChange}
          />
          <Button size="small" onClick={onRefresh} loading={deletionLoading}>
            刷新
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        className="system-deletion-history__alert"
        message="所有业务删除都会进入这里：保留删除人、角色、原因、原始数据快照和关联数据快照；仅老板/管理员可查看与恢复。"
      />
      <Table
        size="small"
        rowKey="id"
        loading={deletionLoading}
        dataSource={deletions}
        pagination={{ pageSize: 10, size: 'small', hideOnSinglePage: true }}
        columns={[
          {
            title: '删除对象',
            dataIndex: 'title',
            render: (value: string, row: any) => (
              <div>
                <button
                  type="button"
                  className="ui-link-button system-deletion-history__object-link"
                  onClick={() => onOpen(row)}
                >
                  {value || `${row.entity_type}#${row.entity_id}`}
                </button>
                <div className="system-deletion-history__summary">{row.summary || '-'}</div>
              </div>
            ),
          },
          {
            title: '模块',
            dataIndex: 'module',
            width: 100,
            render: (value: string) => <Tag className="system-deletion-history__module-tag">{value || '-'}</Tag>,
          },
          {
            title: '删除人',
            width: 122,
            render: (_: any, row: any) => (
              <span>
                {row.deleted_by_name || '-'}{' '}
                <Tag
                  color={ROLE_MAP[row.deleted_by_role]?.color || 'default'}
                  className="system-deletion-history__role-tag"
                >
                  {ROLE_MAP[row.deleted_by_role]?.label || row.deleted_by_role || '-'}
                </Tag>
              </span>
            ),
          },
          {
            title: '删除原因',
            dataIndex: 'reason',
            ellipsis: true,
            render: (value: string) => (
              <Tooltip title={value}>
                <span className="system-deletion-history__reason">{value || '-'}</span>
              </Tooltip>
            ),
          },
          {
            title: '删除时间',
            dataIndex: 'created_at',
            width: 150,
            render: (value: string) => <span className="system-deletion-history__time">{value}</span>,
          },
          {
            title: '状态',
            width: 112,
            render: (_: any, row: any) =>
              row.restored_at ? <Tag color="green">已恢复</Tag> : <Tag color="volcano">回收站</Tag>,
          },
          {
            title: '操作',
            width: 160,
            render: (_: any, row: any) => (
              <Space size={4}>
                <Button size="small" icon={<EyeOutlined />} onClick={() => onOpen(row)}>
                  详情
                </Button>
                <Popconfirm
                  title="确认恢复这条数据？"
                  description="会按原始快照恢复主数据和关联数据。"
                  okText="恢复"
                  cancelText="取消"
                  disabled={!!row.restored_at}
                  onConfirm={() => onRestore(row)}
                >
                  <Button size="small" type="primary" ghost icon={<UndoOutlined />} disabled={!!row.restored_at}>
                    恢复
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={deletionStatus === 'active' ? '暂无未恢复删除记录' : '暂无删除记录'}
            />
          ),
        }}
      />
    </Panel>
  );
}
