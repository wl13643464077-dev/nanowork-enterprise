import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Popconfirm, Skeleton, Space, Statistic, Tag, message } from 'antd';
import { HeartOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import { Panel } from './Kit';
import './SystemKbHealthCard.css';

// P0-2 知识库健康小卡：文档总数 / 已向量化 / 待回填 / 24h 问题向量化失败 / 最近回填。
// needsAttention 时同一份口径会点亮侧栏「系统管理」红点（MainLayout 监听 KB_HEALTH_UPDATED_EVENT）。

export const KB_HEALTH_UPDATED_EVENT = 'kb-health-updated';

export type KbHealth = {
  enabledDocs: number;
  vectorizedDocs: number;
  pendingBackfill: number;
  percent?: number;
  activeJobs?: number;
  reconciliationJobs?: number;
  backgroundEnabled?: boolean;
  providerConfigured?: boolean;
  canBackfill?: boolean;
  queryEmbedFailures24h: number;
  zeroVectorHits24h?: number;
  lastQueryEmbedFailureAt?: string | null;
  lastBackfillAt?: string | null;
  lastBackfill?: { source?: string; accepted?: number; rejected?: number; missingBefore?: number } | null;
  needsAttention: boolean;
  state?: string;
  message?: string;
  nextStep?: string;
};

export function broadcastKbHealth(health: KbHealth | null) {
  window.dispatchEvent(new CustomEvent(KB_HEALTH_UPDATED_EVENT, { detail: health }));
}

function formatTime(value?: string | null) {
  if (!value) return '尚未回填';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}

type Props = {
  canBackfill: boolean;
};

export default function SystemKbHealthCard({ canBackfill }: Props) {
  const [health, setHealth] = useState<KbHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [backfilling, setBackfilling] = useState(false);

  const load = useCallback(async (silent = true) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const data = (await api.get('/sys/kb/health', { silent: true })) as KbHealth;
      setHealth(data);
      broadcastKbHealth(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '知识库健康读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(false), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const backfill = async () => {
    setBackfilling(true);
    try {
      const result = (await api.post('/sys/kb/backfill', {})) as { message?: string; health?: KbHealth };
      if (result?.health) {
        setHealth(result.health);
        broadcastKbHealth(result.health);
      } else {
        await load();
      }
      // 202 已排队 / 200 无需处理，都是正常业务结果
      if (result?.message) message.info(result.message);
    } catch {
      // api 客户端已提示服务端错误（开关未启用 / 向量服务未配置）
      await load();
    } finally {
      setBackfilling(false);
    }
  };

  const alertType = health ? (health.needsAttention ? 'warning' : 'success') : 'info';
  const backfillDisabled = !health || health.pendingBackfill <= 0 || health.canBackfill === false;

  return (
    <Panel
      title={
        <>
          <HeartOutlined
            className={health?.needsAttention ? 'kb-health-card__icon is-warn' : 'kb-health-card__icon is-ok'}
          />{' '}
          知识库健康
          {health?.needsAttention && (
            <Tag color="orange" className="kb-health-card__tag">
              需处理
            </Tag>
          )}
        </>
      }
      extra={
        <Space size={8}>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load(false)}>
            刷新
          </Button>
          {canBackfill && (
            <Popconfirm
              title="立即回填全部待处理知识？"
              description="会调用真实向量服务并按实际持久化数量结算积分；单次最多 20 条，其余由每日 04:00 自动扫描继续。"
              okText="立即回填"
              cancelText="取消"
              disabled={backfillDisabled}
              onConfirm={() => void backfill()}
            >
              <Button
                size="small"
                type="primary"
                icon={<ThunderboltOutlined />}
                loading={backfilling}
                disabled={backfillDisabled}
                title={
                  health && health.pendingBackfill <= 0
                    ? '当前没有需要回填的知识'
                    : health?.canBackfill === false
                      ? health?.nextStep || '当前不能回填'
                      : undefined
                }
              >
                立即回填
              </Button>
            </Popconfirm>
          )}
        </Space>
      }
    >
      {loading && !health ? (
        <Skeleton active paragraph={{ rows: 2 }} />
      ) : error && !health ? (
        <Alert type="error" showIcon message="知识库健康读取失败" description={error} />
      ) : health ? (
        <div className="kb-health-card">
          <div className="kb-health-card__stats">
            <Statistic title="已启用知识" value={health.enabledDocs} suffix="条" />
            <Statistic title="已生成语义向量" value={health.vectorizedDocs} suffix="条" />
            <Statistic
              title="待回填"
              value={health.pendingBackfill}
              suffix="条"
              className={health.pendingBackfill > 0 ? 'kb-health-card__stat is-warn' : 'kb-health-card__stat'}
            />
            <Statistic
              title="24 小时内问题向量化失败"
              value={health.queryEmbedFailures24h}
              suffix="次"
              className={health.queryEmbedFailures24h > 0 ? 'kb-health-card__stat is-warn' : 'kb-health-card__stat'}
            />
          </div>
          <Alert
            type={alertType}
            showIcon
            message={health.nextStep || health.message || '知识库语义检索状态正常。'}
            description={
              <span className="kb-health-card__meta">
                最近回填：{formatTime(health.lastBackfillAt)}
                {health.lastBackfill?.source
                  ? `（${health.lastBackfill.source === 'scheduler' ? '每日自动' : '手动'}）`
                  : ''}
                {typeof health.activeJobs === 'number' && health.activeJobs > 0
                  ? ` · ${health.activeJobs} 个向量任务正在处理`
                  : ''}
                {typeof health.reconciliationJobs === 'number' && health.reconciliationJobs > 0
                  ? ` · ${health.reconciliationJobs} 个向量任务待账务对账`
                  : ''}
                {health.lastQueryEmbedFailureAt ? ` · 最近一次失败 ${formatTime(health.lastQueryEmbedFailureAt)}` : ''}
              </span>
            }
          />
        </div>
      ) : null}
    </Panel>
  );
}
