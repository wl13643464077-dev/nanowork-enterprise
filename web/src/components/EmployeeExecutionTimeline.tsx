import type { EmployeeExecutionProgress } from '../api/employeeWorkbenchTypes';
import './EmployeeExecutionTimeline.css';

type Props = {
  progress?: EmployeeExecutionProgress | null;
  title?: string;
  compact?: boolean;
};

const ICONS: Record<string, string> = {
  boot: '●',
  knowledge: '▣',
  search: '⌕',
  location: '⌖',
  fetch: '↗',
  typing: '✎',
  gate: '✓',
  retry: '↻',
  tool: '⚙',
  persist: '↓',
  billing: '¥',
  done: '✓',
  error: '!',
};

const MODEL_RESPONSE_STAGES = new Set(['generate', 'repair']);

function formatTime(value?: string) {
  if (!value) return '';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '';
  return parsed.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function stepMeta(stage: string, count?: number, attemptNumber?: number) {
  const parts: string[] = [];
  if (attemptNumber) parts.push(`第 ${attemptNumber} 轮`);
  if (count != null) {
    const unit =
      stage === 'fetch' ? '条正文' : stage === 'search' ? '个候选' : stage === 'location' ? '项地点证据' : '项';
    parts.push(`${count} ${unit}`);
  }
  return parts.join(' · ');
}

function normalizeReceivedChars(value: unknown) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : null;
}

function elapsedSinceCurrentAttempt(progress?: EmployeeExecutionProgress | null) {
  const attemptNumber = Number(progress?.attemptNumber);
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) return '';
  const startedAt = (Array.isArray(progress?.steps) ? progress.steps : [])
    .filter(step => step.attemptNumber === attemptNumber && MODEL_RESPONSE_STAGES.has(step.stage))
    .map(step => Date.parse(step.at))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0];
  if (!Number.isFinite(startedAt)) return '';
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (elapsedSeconds < 1) return '已用时不足 1 秒';
  if (elapsedSeconds < 60) return `已用时约 ${elapsedSeconds} 秒`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `已用时约 ${minutes} 分 ${seconds} 秒`;
}

export default function EmployeeExecutionTimeline({ progress, title = '实时执行过程', compact = false }: Props) {
  const steps = Array.isArray(progress?.steps) ? progress.steps : [];
  const percent = Math.max(0, Math.min(100, Number(progress?.percent) || (steps.length ? 10 : 4)));
  const currentLabel = progress?.currentLabel || '数字员工已接单，正在建立安全执行环境';
  const receivedChars = normalizeReceivedChars(progress?.receivedChars);
  const currentStage = String(progress?.currentStage || '');
  const isModelResponseStage =
    MODEL_RESPONSE_STAGES.has(currentStage) || (Boolean(progress) && !currentStage && receivedChars != null);
  const waitingForFirstCharacter = receivedChars === 0 && isModelResponseStage;
  const isReceivingResponse = receivedChars != null && receivedChars > 0;
  const visibleCurrentLabel = waitingForFirstCharacter
    ? '模型正在推理，等待首字返回'
    : isReceivingResponse && isModelResponseStage
      ? '模型正在实时返回岗位交付'
      : currentLabel;
  const attemptNumber = Number(progress?.attemptNumber);
  const attemptLabel =
    Number.isInteger(attemptNumber) && attemptNumber > 0
      ? `第 ${attemptNumber} 次${progress?.phase === 'repair' ? '定向修复' : '生成'}`
      : '';
  const elapsedLabel = elapsedSinceCurrentAttempt(progress);
  const activityLabel = formatTime(progress?.lastActivityAt);
  const progressDetails = [
    attemptLabel,
    waitingForFirstCharacter ? `当前阶段：${currentLabel}` : '',
    isReceivingResponse ? `已接收约 ${receivedChars.toLocaleString('zh-CN')} 个响应字符（流式进度，不是质检阈值）` : '',
    elapsedLabel || (activityLabel ? `最近活动 ${activityLabel}` : ''),
  ].filter(Boolean);

  return (
    <section className={`employee-execution${compact ? ' is-compact' : ''}`} aria-label={title}>
      <header className="employee-execution-head">
        <div>
          <span className="employee-execution-kicker">LIVE · 真实运行记录</span>
          <strong>{title}</strong>
        </div>
        <span className="employee-execution-percent">{percent}%</span>
      </header>
      <div
        className="employee-execution-track"
        role="progressbar"
        aria-label={visibleCurrentLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <i style={{ width: `${percent}%` }} />
      </div>
      <div className="employee-execution-current">
        <span className="employee-execution-pulse" aria-hidden="true" />
        <span>{visibleCurrentLabel}</span>
        {progressDetails.length > 0 && <small>{progressDetails.join(' · ')}</small>}
      </div>
      <div className="employee-execution-steps">
        {steps.length ? (
          steps.map((step, index) => {
            const meta = stepMeta(step.stage, step.count, step.attemptNumber);
            return (
              <div className={`employee-execution-step is-${step.status}`} key={`${step.stage}-${step.at}-${index}`}>
                <span className="employee-execution-icon" aria-hidden="true">
                  {ICONS[step.kind] || '•'}
                </span>
                <span className="employee-execution-copy">
                  <strong>{step.label}</strong>
                  {meta && <small>{meta}</small>}
                </span>
                <time>{formatTime(step.at)}</time>
              </div>
            );
          })
        ) : (
          <div className="employee-execution-step is-active">
            <span className="employee-execution-icon" aria-hidden="true">
              ●
            </span>
            <span className="employee-execution-copy">
              <strong>{currentLabel}</strong>
            </span>
            <time>{formatTime(progress?.lastActivityAt)}</time>
          </div>
        )}
      </div>
      <footer>只展示经过脱敏的阶段事实；搜索词、原始候选网址、提示词和私有材料不会出现在运行日志中。</footer>
    </section>
  );
}
