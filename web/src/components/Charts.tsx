import { useEffect, useMemo, useRef, useState } from 'react';
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

// CSS 变量解析缓存。
// getComputedStyle 会触发强制样式计算；此前每个 var() 都单独调一次，
// 17 个图表 × 每个 option 5-10 个 var 引用 = 每轮渲染近百次 reflow 触发点。
// 同一主题下变量值不变，因此按变量名缓存，主题切换时整体失效。
let cssVarCache = new Map<string, string>();
export function invalidateChartThemeCache() {
  cssVarCache = new Map();
}

function cssVar(name: string): string {
  const hit = cssVarCache.get(name);
  if (hit !== undefined) return hit;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssVarCache.set(name, value);
  return value;
}

function resolveTheme(value: any): any {
  if (typeof value === 'function') return (...args: any[]) => resolveTheme(value(...args));
  if (typeof value === 'string' && /^var\(--[\w-]+\)$/.test(value)) {
    return cssVar(value.slice(4, -1)) || value;
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
  ariaLabel = '数据图表',
}: {
  option: EChartsCoreOption;
  height?: number | string;
  onClick?: (p: any) => void;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const [themeVersion, setThemeVersion] = useState(0);
  // 内容指纹：多数页面未对 option 做 useMemo（6 个用图页面里 4 个 useMemo 为 0），
  // option 每次渲染都是新引用，会触发 setOption(notMerge=true) 全量重建 + 深度递归解析。
  // 可序列化 option 按内容比对；含函数或循环引用时回退到 option 引用更新（与此前行为一致）。
  const fingerprint = useMemo(() => {
    try {
      let hasFn = false;
      const json = JSON.stringify(option, (_k, v) => {
        if (typeof v === 'function') {
          hasFn = true;
          return undefined;
        }
        return v;
      });
      return hasFn ? null : json;
    } catch {
      return null;
    }
  }, [option]);
  const lastAppliedStampRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    // React StrictMode 会在开发环境重建 effect；新实例必须重新 setOption。
    lastAppliedStampRef.current = null;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    const onTheme = () => {
      invalidateChartThemeCache(); // 主题切换：变量值全变，缓存必须整体作废
      setThemeVersion(v => v + 1);
    };
    window.addEventListener('nanowork-theme-change', onTheme);
    return () => {
      window.removeEventListener('nanowork-theme-change', onTheme);
      ro.disconnect();
      chart.dispose();
      if (chartRef.current === chart) chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (fingerprint !== null) {
      const stamp = `${themeVersion}:${fingerprint}`;
      if (stamp === lastAppliedStampRef.current) return;
      lastAppliedStampRef.current = stamp;
    } else {
      // 函数 formatter 与不可序列化 option 无法可靠生成内容指纹：
      // 此分支依赖 option 引用与 themeVersion，每次引用变化都按原行为更新。
      lastAppliedStampRef.current = null;
    }
    chart.setOption(resolveTheme(option), true);
  }, [fingerprint, option, themeVersion]);

  // 点击回调单独绑定：换 handler 不该触发整图重建
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.off('click');
    if (onClick) chart.on('click', onClick);
  }, [onClick]);

  return <div ref={ref} role="img" aria-label={ariaLabel} style={{ height, width: '100%' }} />;
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
