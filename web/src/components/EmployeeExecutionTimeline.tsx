import { useEffect, useState } from 'react';
import type { EmployeeExecutionProgress } from '../api/employeeWorkbenchTypes';
import './EmployeeExecutionTimeline.css';

type Props = {
  progress?: EmployeeExecutionProgress | null;
  title?: string;
  compact?: boolean;
  diagnostics?: boolean;
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

function elapsedSinceCurrentAttempt(progress?: EmployeeExecutionProgress | null, nowMs = Date.now()) {
  const steps = Array.isArray(progress?.steps) ? progress.steps : [];
  const attemptNumber = Number(progress?.attemptNumber);
  let startedAt = Number.NaN;
  if (Number.isInteger(attemptNumber) && attemptNumber >= 1) {
    startedAt = steps
      .filter(step => step.attemptNumber === attemptNumber && MODEL_RESPONSE_STAGES.has(step.stage))
      .map(step => Date.parse(step.at))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
  }
  if (!Number.isFinite(startedAt)) {
    startedAt = steps
      .map(step => Date.parse(step.at))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
  }
  if (!Number.isFinite(startedAt)) return '';
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  if (elapsedSeconds < 1) return '已用时不足 1 秒';
  if (elapsedSeconds < 60) return `已用时约 ${elapsedSeconds} 秒`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `已用时约 ${minutes} 分 ${seconds} 秒`;
}

const STAGE_LABELS: Record<string, string> = {
  boot: '正在准备任务',
  dataset: '正在读取资料',
  knowledge: '正在查找资料',
  search: '正在查找资料',
  location: '正在核对资料',
  fetch: '正在阅读资料',
  tool: '正在生成附件',
  generate: '正在生成内容',
  validate: '正在检查结果',
  repair: '正在完善内容',
  campaign_materials: '正在绘制活动物料图 · 可先浏览上方或稍后下载成图',
  persist: '正在保存结果',
  settle: '正在核对费用',
  done: '任务已完成',
  error: '执行已中断',
};

export function executionStageLabel(progress?: EmployeeExecutionProgress | null) {
  return STAGE_LABELS[String(progress?.currentStage || '')] || progress?.currentLabel || '正在等待任务进度';
}

export default function EmployeeExecutionTimeline({
  progress,
  title = '任务进度',
  compact = false,
  diagnostics = false,
}: Props) {
  const steps = Array.isArray(progress?.steps) ? progress.steps : [];
  const currentStage = String(progress?.currentStage || '');
  const currentLabel = executionStageLabel(progress);
  const running = !['done', 'error'].includes(currentStage);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    let cancelled = false;
    let timerId: number | undefined;
    const tick = () => {
      if (cancelled) return;
      setNowMs(Date.now());
      timerId = window.setTimeout(tick, 1000);
    };
    timerId = window.setTimeout(tick, 1000);
    return () => {
      cancelled = true;
      if (timerId !== undefined) window.clearTimeout(timerId);
    };
  }, [running]);
  const elapsedText = elapsedSinceCurrentAttempt(progress, nowMs);
  const receivedChars = normalizeReceivedChars(progress?.receivedChars);
  const attemptNumber = Number(progress?.attemptNumber);
  const diagnosticDetails = [
    Number.isInteger(attemptNumber) && attemptNumber > 0 ? `第 ${attemptNumber} 次生成` : '',
    receivedChars != null ? `已接收 ${receivedChars.toLocaleString('zh-CN')} 个响应字符` : '',
  ].filter(Boolean);
  const statusHint =
    currentStage === 'campaign_materials'
      ? elapsedText || '成图完成后会自动显示'
      : elapsedText
        ? `${elapsedText} · 可稍后回来查看结果`
        : '可稍后回来查看结果';

  return (
    <section className={`employee-execution${compact ? ' is-compact' : ''}`} aria-label={title}>
      <div className="employee-execution-current" role="status" aria-live="polite">
        <strong>{currentLabel}</strong>
        {running && <span>{statusHint}</span>}
      </div>
      {running && (
        <div className="employee-execution-track" role="progressbar" aria-label={currentLabel}>
          <i />
        </div>
      )}
      {(steps.length > 0 || diagnostics) && (
        <details className="employee-execution-details">
          <summary>查看详情</summary>
          {diagnostics && diagnosticDetails.length > 0 && <p>{diagnosticDetails.join(' · ')}</p>}
          <div className="employee-execution-steps">
            {steps.map((step, index) => {
              const meta = diagnostics ? stepMeta(step.stage, step.count, step.attemptNumber) : '';
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
            })}
          </div>
        </details>
      )}
    </section>
  );
}
