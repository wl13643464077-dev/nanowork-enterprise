import { useMemo } from 'react';
import { Space, Table, Tag } from 'antd';
import { Panel } from './Kit';

/**
 * 运行就绪矩阵（8 通道）。
 *
 * 此前 pages/Admin.tsx 与 pages/System.tsx 各持一份近乎逐字相同的实现（各约 64 行），
 * diff 只差标题里一个图标 —— 两处改一处漏是必然。收口到这里。
 *
 * 语义边界（不可弱化）：这是本地只读状态，不会自动联网探测；
 * 「配置存在」不等于「已验证连接」，只有配置指纹匹配且有新鲜显式验证才显示已连接。
 */

export const READINESS_META: Record<
  string,
  { label: string; color: string; badge: 'success' | 'warning' | 'error' | 'default' }
> = {
  connected: { label: '最近验证通过', color: 'green', badge: 'success' },
  local_ready: { label: '本地能力可用', color: 'blue', badge: 'success' },
  configured_unverified: { label: '已配置·待验证', color: 'gold', badge: 'warning' },
  degraded: { label: '降级模式', color: 'orange', badge: 'warning' },
  blocked: { label: '条件未满足', color: 'red', badge: 'error' },
  manual_only: { label: '仅人工流程', color: 'default', badge: 'default' },
  disabled: { label: '当前已关闭', color: 'default', badge: 'default' },
  requires_input: { label: '等待实时输入', color: 'purple', badge: 'warning' },
};

const READINESS_VERIFICATION_LABEL: Record<string, string> = {
  passed: '验证有效',
  failed: '最近验证失败',
  stale: '验证已过期',
  never: '从未验证',
  not_applicable: '无需验证',
};

export const readinessMeta = (item: any) => {
  if (item?.verification === 'failed') return { label: '最近验证失败', color: 'red', badge: 'error' as const };
  if (item?.verification === 'stale') return { label: '验证已过期', color: 'orange', badge: 'warning' as const };
  return READINESS_META[item?.effective] || { label: '状态未上报', color: 'default', badge: 'default' as const };
};

export const readinessConfigLabel = (item: any) =>
  item?.configuration === 'not_required'
    ? '无需配置'
    : item?.configuration === 'ready'
      ? '配置完整'
      : item?.configuration === 'partial'
        ? '部分配置'
        : '配置不完整';

export const readinessVerificationLabel = (item: any) => READINESS_VERIFICATION_LABEL[item?.verification] || '未验证';

export const readinessTag = (item: any) => {
  const meta = readinessMeta(item);
  return <Tag color={meta.color}>{meta.label}</Tag>;
};

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
          width: 160,
          render: (_: unknown, row: any) => (
            <Space size={4} wrap>
              <Tag color={row.canExecute ? 'blue' : 'default'}>{row.canExecute ? '可执行' : '不可执行'}</Tag>
              <Tag color={row.canPerformExternalAction ? 'green' : 'default'}>
                {row.canPerformExternalAction ? '可外部动作' : '无外部动作'}
              </Tag>
            </Space>
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
      <Table size="small" rowKey="key" pagination={false} dataSource={channels} scroll={{ x: 900 }} columns={columns} />
    </Panel>
  );
}
