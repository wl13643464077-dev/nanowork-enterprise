import React, { useEffect, useRef, useState } from 'react';
import { Button, Card, Skeleton, Tag } from 'antd';
import { ArrowUpOutlined, ArrowDownOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons';

// 数字滚动：KPI 数值变化时从旧值缓动到新值（尊重 prefers-reduced-motion）
export function AnimatedNumber({ value, duration = 700 }: { value: number; duration?: number }) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    if (!Number.isFinite(value)) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      fromRef.current = value;
      setDisplay(value);
      return;
    }
    const from = fromRef.current;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (value - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{display.toLocaleString()}</>;
}

// KPI 统计卡（对照UI：左icon色块 + 数值 + 环比chip）
export function StatCard({ icon, color, label, value, suffix, trend, trendLabel, onClick }: {
  icon: React.ReactNode; color: string; label: string; value: React.ReactNode;
  suffix?: string; trend?: number | null; trendLabel?: string; onClick?: () => void;
}) {
  return (
    <Card size="small" hoverable={!!onClick} onClick={onClick}
      styles={{ body: { padding: '14px 16px' } }} style={{ borderRadius: 10, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `color-mix(in srgb, ${color} 10%, transparent)`, color, fontSize: 18, flexShrink: 0,
        }}>{icon}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ color: 'var(--ui-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{label}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 21, fontWeight: 700, color: 'var(--ui-text)', whiteSpace: 'nowrap' }}>{typeof value === 'number' ? <AnimatedNumber value={value} /> : value}</span>
            {suffix && <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>{suffix}</span>}
            {trend !== undefined && trend !== null && (
              <span style={{ fontSize: 11, color: trend >= 0 ? '#16a34a' : '#ef4444', whiteSpace: 'nowrap' }}>
                {trend >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {Math.abs(trend)}%{trendLabel ? ` ${trendLabel}` : ''}
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

export function Panel({ title, extra, children, style, bodyStyle }: {
  title?: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode;
  style?: React.CSSProperties; bodyStyle?: React.CSSProperties;
}) {
  return (
    <Card size="small" style={{ borderRadius: 10, height: '100%', ...style }}
      styles={{ body: { padding: 16, ...bodyStyle } }}>
      {(title || extra) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px 12px', marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ui-text)', flexShrink: 0, whiteSpace: 'nowrap' }}>{title}</div>
          <div style={{ flex: extra ? '1 1 240px' : undefined, minWidth: 0, maxWidth: '100%', overflowX: 'auto', textAlign: 'right' }}>{extra}</div>
        </div>
      )}
      {children}
    </Card>
  );
}

// 页面内容区骨架：切换 lazy 路由时保留布局外壳，只在内容区显示与最终布局近似的骨架
export function PageSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', padding: 'var(--space-1)' }} aria-busy="true" aria-label="页面加载中">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-3)' }}>
        {[0, 1, 2, 3].map(i => (
          <Card key={i} size="small" style={{ borderRadius: 'var(--radius-md)' }}>
            <Skeleton active title={false} paragraph={{ rows: 2, width: ['60%', '90%'] }} />
          </Card>
        ))}
      </div>
      <Card size="small" style={{ borderRadius: 'var(--radius-md)' }}>
        <Skeleton active paragraph={{ rows: 6 }} />
      </Card>
    </div>
  );
}

// 整页/区块级错误态：静默失败的替代品——明确告知失败并提供重试入口
export function ErrorState({ description, onRetry }: { description?: string; onRetry: () => void }) {
  return (
    <Card size="small" style={{ borderRadius: 'var(--radius-md)', borderColor: 'var(--danger)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <WarningOutlined style={{ color: 'var(--danger)', fontSize: 'var(--font-5)' }} />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 600, color: 'var(--ui-text)', fontSize: 'var(--font-3)' }}>数据加载失败</div>
          <div style={{ color: 'var(--ui-muted)', fontSize: 'var(--font-1)', marginTop: 2 }}>{description || '网络或服务暂时不可用，请重试；若持续失败请联系平台服务人员。'}</div>
        </div>
        <Button icon={<ReloadOutlined />} onClick={onRetry}>重新加载</Button>
      </div>
    </Card>
  );
}

export const gradeColor: Record<string, string> = { A: 'red', B: 'orange', C: 'default' };
export const stageColor: Record<string, string> = {
  '新线索': 'blue', '已沟通': 'cyan', '已邀约': 'purple', '已到店': 'orange',
  '已成交': 'green', '复购': 'magenta', '已流失': 'default',
};
export const StageTag = ({ stage }: { stage: string }) => <Tag color={stageColor[stage] || 'default'}>{stage}</Tag>;
export const GradeTag = ({ grade }: { grade: string }) => <Tag color={gradeColor[grade] || 'default'}>{grade}级</Tag>;
