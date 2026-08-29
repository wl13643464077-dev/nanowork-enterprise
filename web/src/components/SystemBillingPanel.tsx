import React from 'react';
import { Alert, Button, Empty, Space, Table, Tag, Tooltip } from 'antd';
import { DatabaseOutlined } from '@ant-design/icons';
import { Panel } from './Kit';

type BillingAction = 'settle' | 'release';

interface SystemBillingPanelProps {
  billingLoading: boolean;
  billingReconciliation: any;
  canResolveBilling: boolean;
  loadBillingReconciliation: () => void;
  resolveBilling: (row: any, action: BillingAction) => void;
}

export function SystemBillingPanel({
  billingLoading,
  billingReconciliation,
  canResolveBilling,
  loadBillingReconciliation,
  resolveBilling,
}: SystemBillingPanelProps) {
  const rows = Array.isArray(billingReconciliation?.rows) ? billingReconciliation.rows : [];
  const total = Number(billingReconciliation?.summary?.total ?? rows.length) || 0;
  const activeRows = rows.filter((row: any) => row?.stillActive === true);
  const active = Number(billingReconciliation?.summary?.active ?? activeRows.length) || 0;
  const requiresAttention =
    Number(billingReconciliation?.summary?.requiresAttention ?? Math.max(0, total - active)) || 0;
  const activeHeldCredits =
    Number(
      billingReconciliation?.summary?.activeHeldCredits ??
        activeRows.reduce((sum: number, row: any) => sum + Number(row?.heldCredits || 0), 0),
    ) || 0;
  const attentionHeldCredits =
    Number(
      billingReconciliation?.summary?.attentionHeldCredits ??
        Math.max(0, Number(billingReconciliation?.summary?.heldCredits || 0) - activeHeldCredits),
    ) || 0;
  const alertType = requiresAttention > 0 ? 'warning' : active > 0 ? 'info' : 'success';
  const alertMessage =
    requiresAttention > 0
      ? `当前有 ${requiresAttention} 笔任务积分需要核对，共涉及 ${attentionHeldCredits} 积分。`
      : active > 0
        ? `当前有 ${active} 笔 AI 任务正在生成，临时预留 ${activeHeldCredits} 积分，无需人工处理。`
        : '当前没有需要处理的 AI 积分记录。';
  const alertDescription =
    requiresAttention > 0
      ? '只有业务主产物、共享语义契约、模型和真实 token 证据一致时才能结算；确认未通过交付门禁后才能退款。仍在正常生成的任务不会列为异常。'
      : active > 0
        ? '任务结束后，系统会按真实 token 自动结算并退回多余预留；质量门不通过则整笔释放。生成期间不会实际扣除这笔预留。'
        : '系统会自动核对任务产物、质量门和真实 token；只有异常终态才会进入人工对账。';
  return (
    <Panel
      title={
        <>
          <DatabaseOutlined style={{ color: 'var(--warn)' }} /> AI积分与用量
        </>
      }
      extra={
        <Button size="small" loading={billingLoading} onClick={loadBillingReconciliation}>
          刷新
        </Button>
      }
    >
      <Alert
        type={alertType}
        showIcon
        message={alertMessage}
        description={alertDescription}
        style={{ marginBottom: 14 }}
      />
      <Table
        size="small"
        rowKey="holdId"
        loading={billingLoading}
        dataSource={rows}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        columns={[
          {
            title: '预留额度',
            key: 'hold',
            width: 150,
            render: (_: any, row: any) => (
              <div>
                <div style={{ fontWeight: 700 }}>
                  #{row.holdId} · {row.heldCredits}积分
                </div>
                <div style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{row.feature || row.kind || '-'}</div>
              </div>
            ),
          },
          {
            title: '业务记录',
            key: 'business',
            ellipsis: true,
            render: (_: any, row: any) => (
              <div>
                <div>{row.business?.label || `${row.refType || '-'}#${row.refId || '-'}`}</div>
                <Space size={4} wrap>
                  <Tag>{row.business?.status || '-'}</Tag>
                  <Tag color={row.stillActive === true ? 'processing' : row.business?.deliveryValid ? 'green' : 'red'}>
                    {row.stillActive === true
                      ? '交付门禁待检测'
                      : row.business?.deliveryValid
                        ? '交付证据有效'
                        : '未通过交付门禁'}
                  </Tag>
                  {row.business?.usage?.valid && (
                    <Tag color="blue">
                      {row.business.usage.inputTokens}/{row.business.usage.outputTokens} tokens
                    </Tag>
                  )}
                </Space>
              </div>
            ),
          },
          {
            title: '系统判断',
            key: 'evidence',
            width: 240,
            render: (_: any, row: any) => {
              const detail = [...(row.integrityErrors || []), ...(row.business?.errors || [])].join('；');
              return (
                <Tooltip title={detail || row.blockedReason || ''}>
                  <span style={{ color: row.availableActions?.length ? 'var(--ui-text-2)' : 'var(--danger)' }}>
                    {row.stillActive === true
                      ? '任务正在生成，额度只是临时预留'
                      : row.availableActions?.includes('settle')
                        ? `可按 ${row.business?.model || '-'} 真实用量结算`
                        : row.availableActions?.includes('release')
                          ? '质量门未通过，可隔离产物并退款'
                          : row.blockedReason || '证据不足，暂不可处理'}
                  </span>
                </Tooltip>
              );
            },
          },
          {
            title: '操作',
            key: 'action',
            width: 190,
            render: (_: any, row: any) =>
              !canResolveBilling ? (
                <span style={{ color: 'var(--ui-muted)' }}>仅老板/管理员可处理</span>
              ) : (
                <Space>
                  {row.availableActions?.includes('settle') && (
                    <Button size="small" type="primary" onClick={() => resolveBilling(row, 'settle')}>
                      按证据结算
                    </Button>
                  )}
                  {row.availableActions?.includes('release') && (
                    <Button size="small" danger onClick={() => resolveBilling(row, 'release')}>
                      隔离并退款
                    </Button>
                  )}
                  {!row.availableActions?.length && row.stillActive === true && (
                    <Tag color="processing">生成中 · 无需处理</Tag>
                  )}
                  {!row.availableActions?.length && row.stillActive !== true && <Tag>已阻断</Tag>}
                </Space>
              ),
          },
        ]}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有需要处理的积分记录" /> }}
      />
    </Panel>
  );
}
