import { DeleteOutlined, UndoOutlined } from '@ant-design/icons';
import { Alert, Button, Drawer, Popconfirm, Space, Tag } from 'antd';
import { ROLE_MAP } from './SystemPrimitives';
import './SystemGovernance.css';

type SystemDeletionDrawerProps = {
  deletionView: any;
  onClose: () => void;
  onRestore: (deletion: any) => void;
};

export function SystemDeletionDrawer({ deletionView, onClose, onRestore }: SystemDeletionDrawerProps) {
  return (
    <Drawer
      open={!!deletionView}
      width={680}
      onClose={onClose}
      title={
        deletionView ? (
          <Space>
            <DeleteOutlined className="system-deletion-drawer__danger-icon" />
            删除留痕 · {deletionView.title}
            <Tag>{deletionView.module}</Tag>
          </Space>
        ) : (
          ''
        )
      }
      extra={
        deletionView &&
        !deletionView.restored_at && (
          <Popconfirm
            title="确认恢复这条数据？"
            description="会按原始快照恢复主数据和关联数据。"
            okText="恢复"
            cancelText="取消"
            onConfirm={() => onRestore(deletionView)}
          >
            <Button type="primary" ghost icon={<UndoOutlined />}>
              恢复数据
            </Button>
          </Popconfirm>
        )
      }
    >
      {deletionView && (
        <div className="system-deletion-drawer__content">
          <Alert
            type={deletionView.restored_at ? 'success' : 'warning'}
            showIcon
            message={
              deletionView.restored_at
                ? `已由 ${deletionView.restored_by_name || '-'} 恢复：${deletionView.restored_at}`
                : '该数据当前在回收站，业务页面不可见。'
            }
          />
          <div className="system-deletion-drawer__meta-grid">
            {[
              [
                '删除人',
                `${deletionView.deleted_by_name || '-'}（${ROLE_MAP[deletionView.deleted_by_role]?.label || deletionView.deleted_by_role || '-'}）`,
              ],
              ['删除时间', deletionView.created_at || '-'],
              [
                '所需权限',
                deletionView.required_role === 'boss'
                  ? '老板/管理员'
                  : deletionView.required_role === 'manager'
                    ? '管理层'
                    : '本人',
              ],
            ].map(([key, value]) => (
              <div key={key} className="system-deletion-drawer__meta-card">
                <div className="system-deletion-drawer__meta-label">{key}</div>
                <div className="system-deletion-drawer__meta-value">{value}</div>
              </div>
            ))}
          </div>
          <div>
            <div className="system-deletion-drawer__section-title">删除原因</div>
            <div className="system-deletion-drawer__reason">{deletionView.reason || '-'}</div>
          </div>
          <div>
            <div className="system-deletion-drawer__section-title">主数据快照</div>
            <pre className="system-deletion-drawer__snapshot">
              {JSON.stringify(deletionView.snapshot?.row || {}, null, 2)}
            </pre>
          </div>
          <div>
            <div className="system-deletion-drawer__section-title">关联数据快照</div>
            <Space wrap>
              {Object.entries(deletionView.child_snapshot || {}).map(([table, rows]: any) => (
                <Tag key={table} color={Array.isArray(rows) && rows.length ? 'blue' : 'default'}>
                  {table}：{Array.isArray(rows) ? rows.length : 0} 条
                </Tag>
              ))}
            </Space>
            <pre className="system-deletion-drawer__snapshot system-deletion-drawer__snapshot--related">
              {JSON.stringify(deletionView.child_snapshot || {}, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </Drawer>
  );
}
