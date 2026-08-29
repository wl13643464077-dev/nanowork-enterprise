import { useMemo } from 'react';
import { Space, Table, Tag } from 'antd';
import { Panel } from './Kit';
import {
  READINESS_STATUS_META,
  runtimeReadinessConfigLabel,
  runtimeReadinessMeta,
  runtimeReadinessVerificationLabel,
} from './statusPresentation.js';

/**
 * 运行就绪矩阵（8 通道）。
 *
 * 此前 pages/Admin.tsx 与 pages/System.tsx 各持一份近乎逐字相同的实现（各约 64 行），
 * diff 只差标题里一个图标 —— 两处改一处漏是必然。收口到这里。
 *
 * 语义边界（不可弱化）：这是本地只读状态，不会自动联网探测；
 * 「配置存在」不等于「已验证连接」，只有配置指纹匹配且有新鲜显式验证才显示已连接。
 */

export const READINESS_META = READINESS_STATUS_META as Record<
  string,
  { label: string; color: string; badge: 'success' | 'warning' | 'error' | 'default' }
>;

export const readinessMeta = (item: any) => runtimeReadinessMeta(item) as (typeof READINESS_META)[string];

export const readinessConfigLabel = (item: any) => runtimeReadinessConfigLabel(item);

export const readinessVerificationLabel = (item: any) => runtimeReadinessVerificationLabel(item);

export const readinessTag = (item: any) => {
  const meta = readinessMeta(item);
  return <Tag color={meta.color}>{meta.label}</Tag>;
};

export const readinessCapabilityTags = (item: any) => [
  {
    key: 'local_draft',
    enabled: item?.canGenerateLocalDraft === true,
    label: item?.canGenerateLocalDraft === true ? '能生成本地底稿' : '不提供本地底稿',
    color: 'blue',
  },
  {
    key: 'human_review',
    enabled: item?.canDeliverForHumanReview === true,
    label: item?.canDeliverForHumanReview === true ? '能交付人工审阅' : '尚不能交付人工审阅',
    color: 'gold',
  },
  {
    key: 'external_action',
    enabled: item?.canPerformExternalAction === true,
    label: item?.canPerformExternalAction === true ? '能执行外部动作' : '不执行外部动作',
    color: 'green',
  },
];

export function RuntimeReadinessMatrix({ matrix, title }: { matrix: any; title?: React.ReactNode }) {
  const channels = Array.isArray(matrix?.channels) ? matrix.channels : [];
  // columns 记忆化：此前内联字面量导致每次渲染重建全部 render 闭包，antd 内部 diff 失效
  const columns = useMemo(
    () =>
      [
        {
          title: '能力',
          dataIndex: 'label',
          width: 150,
          render: (value: string, row: any) => (
            <div>
              <b>{value}</b>
              <div style={{ fontSize: 'var(--font-1)', color: 'var(--ui-muted)' }}>{row.description}</div>
            </div>
          ),
        },
        { title: '实际状态', width: 120, render: (_: unknown, row: any) => readinessTag(row) },
        {
          title: '配置 / 验证',
          width: 140,
          render: (_: unknown, row: any) => (
            <span style={{ fontSize: 'var(--font-1)' }}>
              {readinessConfigLabel(row)} · {readinessVerificationLabel(row)}
            </span>
          ),
        },
        {
          title: '执行边界',
          width: 320,
          render: (_: unknown, row: any) => (
            <div>
              <Space size={4} wrap>
                {readinessCapabilityTags(row).map(capability => (
                  <Tag key={capability.key} color={capability.enabled ? capability.color : 'default'}>
                    {capability.label}
                  </Tag>
                ))}
              </Space>
              <div style={{ marginTop: 4, fontSize: 'var(--font-1)', color: 'var(--ui-text-2)' }}>
                {row.capabilitySummary || '三维能力状态未上报，按不可交付处理'}
              </div>
            </div>
          ),
        },
        {
          title: '缺口 / 下一步',
          render: (_: unknown, row: any) => (
            <div style={{ fontSize: 'var(--font-1)', color: 'var(--ui-text-2)' }}>
              {row.missing?.length ? `缺：${row.missing.join('、')}。` : ''}
              {row.nextAction}
            </div>
          ),
        },
      ] as any,
    [],
  );

  if (!channels.length) return null;
  return (
    <Panel
      title={title || '运行就绪矩阵'}
      extra={
        <span style={{ fontSize: 'var(--font-1)', color: 'var(--ui-muted)' }}>只读本地状态，不会自动联网探测</span>
      }
    >
      <Table
        size="small"
        rowKey="key"
        pagination={false}
        dataSource={channels}
        scroll={{ x: 1080 }}
        columns={columns}
      />
    </Panel>
  );
}
