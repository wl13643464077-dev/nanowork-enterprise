// 驾驶舱首屏「今日一眼」与下方 KPI 行共用的展示口径。
// 放在独立文件里，保证 BossGlance 与 Dashboard 两处对「趋势」「最要紧的一件事」的判断完全一致。

export type DashboardTrendTone = 'up' | 'down' | 'flat' | 'none';

export type DashboardTrend = {
  tone: DashboardTrendTone;
  /** 直接可渲染的文案；tone === 'none' 时为空串 */
  text: string;
  /** 悬停补充说明（对比口径） */
  hint: string;
};

/**
 * 统一的环比展示规则：
 * - 非数值：不展示；
 * - 0：中性「持平」，不带箭头、不带红绿。后端在对比期无数据时同样返回 0，
 *   所以「全部」范围（noBaseline，此前没有可比同期）明确写「— 无同期可比」；
 * - 其余：↑ / ↓ + 绝对值百分比。
 */
export function describeDashboardTrend(
  value: unknown,
  options: { compareLabel?: string; noBaseline?: boolean } = {},
): DashboardTrend {
  const compareLabel = options.compareLabel || '较上期';
  if (typeof value !== 'number' || !Number.isFinite(value)) return { tone: 'none', text: '', hint: '' };
  if (value === 0) {
    return options.noBaseline
      ? { tone: 'flat', text: '— 无同期可比', hint: '当前范围已包含全部数据，此前没有可对比的同期' }
      : { tone: 'flat', text: '持平', hint: `${compareLabel}持平，或对比期暂无数据` };
  }
  return {
    tone: value > 0 ? 'up' : 'down',
    text: `${value > 0 ? '↑' : '↓'} ${Math.abs(value)}%`,
    hint: compareLabel,
  };
}

export type DashboardDiagnosisItem = { id?: string | number; dimension?: string; issue?: string; suggestion?: string };

/** 首屏「最要紧的一件事」取诊断列表第一条（需有 issue 文案） */
export function pickGlanceIssue<T extends DashboardDiagnosisItem>(diagnosis: T[] | null | undefined): T | null {
  const top = diagnosis?.[0];
  return top?.issue ? top : null;
}

/** 两条诊断是否为同一条：有 id 比 id，否则比「维度 + 问题标题」 */
export function isSameDiagnosis(
  a: DashboardDiagnosisItem | null | undefined,
  b: DashboardDiagnosisItem | null | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.id != null && b.id != null) return String(a.id) === String(b.id);
  const key = (item: DashboardDiagnosisItem) => `${item.dimension || ''}|${(item.issue || '').trim()}`;
  return key(a) === key(b);
}
