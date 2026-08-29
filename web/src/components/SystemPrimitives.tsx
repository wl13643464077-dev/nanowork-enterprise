import React from 'react';

export const ROLE_MAP: Record<string, { label: string; color: string }> = {
  boss: { label: '老板', color: 'gold' },
  ops_director: { label: '运营总监', color: 'blue' },
  sales: { label: '销售', color: 'green' },
  admin: { label: '管理员', color: 'purple' },
  partner: { label: '合伙人', color: 'cyan' },
};

export const RISK_TAG: Record<string, { color: string; label: string }> = {
  high: { color: 'red', label: '高风险' },
  medium: { color: 'orange', label: '中风险' },
  low: { color: 'default', label: '低风险' },
};

export const approvalStatusLabel = (status: string) => (status === '待审核' ? '待人工审阅' : status);

const RULE_NAMES: Record<string, string> = {
  PRICE_PROMISE: '价格/返利承诺',
  INVEST_RETURN: '招商收益描述',
  ABS_WORD: '广告法绝对化用语',
  HEALTH_CLAIM: '医疗保健功效暗示',
  CONTRACT: '合同/政策口径',
};

export const KB_CATS = ['品牌资料', '招商政策', '产品资料', '话术案例', '客户画像', '数据规范', '员工产出'];

export const MT_LABELS: Record<string, string> = {
  leads: '新增线索(人)',
  conversionRate: '成交转化率(%)',
  repurchaseRate: '复购率(%)',
  partnerActive: '合伙人活跃(%)',
  contentPerDay: '日均内容(条)',
};

export const AB_LABELS: Record<string, string> = {
  inviteSign: '邀约→报名(%)',
  signArrive: '报名→到场(%)',
  arriveDeal: '到场→成交(%)',
  referral: '转介绍率(%)',
  roi: 'ROI基准(倍)',
};

export const HW_LABELS: Record<string, string> = {
  leads: '线索增长',
  conversion: '转化效率',
  repurchase: '复购健康',
  partner: '合伙人活跃',
  content: '内容生产',
};

export const fmtUptime = (min: number) => {
  const m = Math.max(0, Math.round(min || 0));
  if (m >= 1440) return `${Math.floor(m / 1440)}天${Math.floor((m % 1440) / 60)}小时`;
  if (m >= 60) return `${Math.floor(m / 60)}小时${m % 60}分`;
  return `${m}分钟`;
};

export const fmtKBSize = (kb: number) => (kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb || 0)} KB`);

export const parseRules = (s: string): string[] => {
  try {
    const arr = JSON.parse(s || '[]');
    return (Array.isArray(arr) ? arr : []).map((x: any) =>
      typeof x === 'string' ? RULE_NAMES[x] || x : x?.name || x?.code || '',
    );
  } catch {
    return s ? [s] : [];
  }
};

export const parseJson = (s: any, fallback: any = {}) => {
  if (!s) return fallback;
  if (typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

export const parseJsonArray = (value: any): any[] => {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
};

export const approvalListResult = (payload: any): { rows: any[]; total: number } => {
  if (Array.isArray(payload)) return { rows: payload, total: payload.length };
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const total = Number(payload?.total);
  return { rows, total: Number.isFinite(total) && total >= 0 ? total : rows.length };
};

export const displayValue = (value: any): string => {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join('、');
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => `${key}：${displayValue(item)}`)
      .filter(item => !item.endsWith('：'))
      .join('；');
  }
  return String(value);
};

export const displayList = (value: any): any[] =>
  Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value];

export const barColor = (p: number) => (p >= 80 ? 'var(--danger)' : p >= 60 ? 'var(--warn)' : 'var(--ui-accent)');

export const interactiveSurfaceStyle = {
  appearance: 'none',
  border: 0,
  padding: 0,
  margin: 0,
  width: '100%',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  textAlign: 'inherit',
} as const;

export function MiniStat({
  icon,
  color,
  label,
  value,
  span,
}: {
  icon: React.ReactNode;
  color: string;
  label: string;
  value: React.ReactNode;
  span?: boolean;
}) {
  return (
    <div
      style={{
        background: 'var(--ui-surface-2)',
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        gridColumn: span ? '1 / -1' : undefined,
      }}
    >
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 8,
          background: `color-mix(in srgb, ${color} 10%, transparent)`,
          color,
          fontSize: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--ui-text)', whiteSpace: 'nowrap' }}>{value}</div>
        <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', whiteSpace: 'nowrap' }}>{label}</div>
      </div>
    </div>
  );
}
