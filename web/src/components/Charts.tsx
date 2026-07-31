import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import type { EChartsCoreOption, EChartsType } from 'echarts/core';
import { BarChart, FunnelChart, LineChart, PieChart, RadarChart } from 'echarts/charts';
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  RadarComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  FunnelChart,
  LineChart,
  PieChart,
  RadarChart,
  AriaComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  RadarComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer,
]);

function resolveTheme(value: any): any {
  if (typeof value === 'function') return (...args: any[]) => resolveTheme(value(...args));
  if (typeof value === 'string' && /^var\(--[\w-]+\)$/.test(value)) {
    return getComputedStyle(document.documentElement).getPropertyValue(value.slice(4, -1)).trim() || value;
  }
  if (Array.isArray(value)) return value.map(resolveTheme);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTheme(item)]));
  }
  return value;
}

export function Chart({
  option,
  height = 280,
  onClick,
}: {
  option: EChartsCoreOption;
  height?: number | string;
  onClick?: (p: any) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const [themeVersion, setThemeVersion] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    const onTheme = () => setThemeVersion(v => v + 1);
    window.addEventListener('nanowork-theme-change', onTheme);
    return () => {
      window.removeEventListener('nanowork-theme-change', onTheme);
      ro.disconnect();
      chart.dispose();
    };
  }, []);
  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.setOption(resolveTheme(option), true);
    chartRef.current.off('click');
    if (onClick) {
      chartRef.current.on('click', onClick);
    }
  }, [option, onClick, themeVersion]);
  return <div ref={ref} style={{ height, width: '100%' }} />;
}

// 分类调色板走 token（resolveTheme 会在 setOption 时解析成实际色值），
// 因此深浅主题自动各用一套，无需业务代码判断当前主题。
export const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
];

export const baseGrid = { left: 8, right: 16, top: 32, bottom: 8, containLabel: true };
export const axisStyle = {
  axisLine: { lineStyle: { color: 'var(--ui-border)' } },
  axisLabel: { color: 'var(--ui-muted)', fontSize: 12 },
  splitLine: { lineStyle: { color: 'var(--ui-surface-2)' } },
};

// 图表动效统一口径：与 --dur-slow / --ease-out 对齐，替代 echarts 默认 1000ms 线性进场。
// 用法：{ ...chartAnimation, series: [...] }
export const chartAnimation = {
  animationDuration: 320,
  animationEasing: 'cubicOut' as const,
  animationDelay: (idx: number) => idx * 18,
};
