import { Button, Skeleton } from 'antd';
import { ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import { Markdown } from './Markdown';
import { DEFAULT_STAGES, type StreamStage } from '../hooks/useStreamingTask';
import './StreamingOutput.css';

/**
 * AI 长任务输出区：阶段进度 + 逐段正文 + 骨架 + 错误重试。
 *
 * 替代此前各页面的 `<Spin tip="AI正在处理…">` —— 那种写法在 60-135 秒的请求里
 * 只给一个转圈，老板无法判断是在跑还是卡死。
 * 骨架形状与最终正文一致（DESIGN.md 要求「执行中显示与最终布局一致的骨架状态」）。
 */
export default function StreamingOutput({
  running,
  text,
  stage,
  typing,
  error,
  stages = DEFAULT_STAGES,
  onRetry,
  emptyHint = '结果将显示在这里',
  minHeight = 160,
}: {
  running: boolean;
  text: string;
  stage: number;
  typing: boolean;
  error?: string;
  stages?: StreamStage[];
  onRetry?: () => void;
  emptyHint?: string;
  minHeight?: number;
}) {
  const started = running || stage >= 0 || !!text || !!error;

  if (error) {
    return (
      <div className="stream-out stream-out--error" role="alert">
        <WarningOutlined className="stream-out-error-icon" />
        <div className="stream-out-error-body">
          <div className="stream-out-error-title">生成失败</div>
          <div className="stream-out-error-desc">{error}</div>
        </div>
        {onRetry && (
          <Button icon={<ReloadOutlined />} onClick={onRetry} size="small">
            重试
          </Button>
        )}
      </div>
    );
  }

  if (!started) {
    return (
      <div className="stream-out stream-out--idle" style={{ minHeight }}>
        {emptyHint}
      </div>
    );
  }

  return (
    <div className="stream-out">
      {/* 阶段轴：由真实事件驱动，不做假进度条 */}
      <ol className="stream-stages" aria-label="任务进度">
        {stages.map((s, i) => {
          const status = i < stage ? 'done' : i === stage ? 'active' : 'wait';
          return (
            <li key={s.key} className={`stream-stage stream-stage--${status}`} aria-current={status === 'active'}>
              <span className="stream-stage-dot" aria-hidden="true" />
              <span className="stream-stage-label">{s.label}</span>
            </li>
          );
        })}
      </ol>

      <div className="stream-out-body" style={{ minHeight }} aria-live="polite" aria-busy={running}>
        {text ? (
          <>
            <Markdown content={text} />
            {typing && (
              <span className="nw-typing" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            )}
          </>
        ) : (
          <Skeleton active paragraph={{ rows: 4, width: ['92%', '100%', '88%', '64%'] }} title={false} />
        )}
      </div>
    </div>
  );
}
