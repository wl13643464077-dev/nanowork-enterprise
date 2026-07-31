import { useEffect, useState } from 'react';
import { Skeleton } from 'antd';
import './StreamingOutput.css';

/**
 * 非流式长任务的进度反馈。
 *
 * 用于结构化产出（返回多条结果对象、无法逐字增量）的端点，替代裸 `<Spin tip>`。
 * 与 StreamingOutput 共用阶段轴视觉，区别在于阶段推进由耗时预期驱动而非 SSE 事件。
 *
 * 诚实化约束：不显示百分比数字（那会是编造的）。阶段推进只表达「已进入这一步」，
 * 最后一个阶段一直停留到真实完成，绝不假装已完成。
 */
export default function TaskProgress({
  running,
  stages,
  /** 各阶段预期耗时（毫秒），长度需比 stages 少 1；最后一段无限等待 */
  timings,
  skeletonRows = 3,
  skeletonCards = 1,
}: {
  running: boolean;
  stages: string[];
  timings?: number[];
  skeletonRows?: number;
  skeletonCards?: number;
}) {
  // 不运行时不渲染内部组件；下次启动即全新挂载，阶段状态无需手动重置。
  if (!running) return null;
  return <Running stages={stages} timings={timings} rows={skeletonRows} cards={skeletonCards} />;
}

function Running({
  stages,
  timings,
  rows,
  cards,
}: {
  stages: string[];
  timings?: number[];
  rows: number;
  cards: number;
}) {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    const spans = timings ?? stages.slice(0, -1).map(() => 4000);
    const timers: number[] = [];
    let acc = 0;
    spans.forEach((span, i) => {
      acc += span;
      timers.push(window.setTimeout(() => setStage(prev => (prev < i + 1 ? i + 1 : prev)), acc));
    });
    return () => timers.forEach(t => window.clearTimeout(t));
  }, [stages, timings]);

  return (
    <div className="stream-out" aria-busy="true" aria-live="polite">
      <ol className="stream-stages" aria-label="任务进度">
        {stages.map((label, i) => {
          const status = i < stage ? 'done' : i === stage ? 'active' : 'wait';
          return (
            <li key={label} className={`stream-stage stream-stage--${status}`} aria-current={status === 'active'}>
              <span className="stream-stage-dot" aria-hidden="true" />
              <span className="stream-stage-label">{label}</span>
            </li>
          );
        })}
      </ol>
      {/* 骨架形状对齐最终结果卡片，避免内容到位时的布局跳变 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {Array.from({ length: cards }).map((_, i) => (
          <div key={i} className="stream-out-body" style={{ maxHeight: 'none' }}>
            <Skeleton active title={{ width: '42%' }} paragraph={{ rows }} />
          </div>
        ))}
      </div>
    </div>
  );
}
