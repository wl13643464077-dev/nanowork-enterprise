import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, Segmented, Space, Tag, Tooltip, message } from 'antd';
import { CopyOutlined, EditOutlined, HistoryOutlined, SendOutlined } from '@ant-design/icons';
import { api, type ApiRequestError } from '../api/client';
import { Markdown } from './Markdown';
import TaskDocumentDownloads from './TaskDocumentDownloads';
import './ReportRefinePanel.css';

// 报告多轮优化：老板拿到报告后，针对这一份继续提修改意见，每一轮生成一个
// 独立版本；原稿与任务采纳状态不变，每个版本都能复制、导出 PDF/Word。

type Revision = {
  id: number;
  version: number;
  baseRevisionId: number | null;
  instruction: string;
  changeSummary: string;
  model: string | null;
  risk: { level: string; flags: string[] };
  createdAt: string;
  generateUrl: string;
  markdown: string;
};

type RefineState = {
  task: { id: number; title: string; status: string; employee: { idx: number | null; person: string; name: string } };
  original: { version: 0; markdown: string; generateUrl: string };
  revisions: Revision[];
  latestVersion: number;
  availability: { available: boolean; reason: string | null };
  quickInstructions: { key: string; label: string; instruction: string }[];
  boundary: string;
};

function errorText(error: unknown, fallback: string) {
  const err = error as ApiRequestError;
  const hint = typeof (err as any)?.retryHint === 'string' ? (err as any).retryHint : '';
  return `${err?.message || fallback}${hint ? `（${hint}）` : ''}`;
}

export default function ReportRefinePanel({
  taskId,
  onRevisionCreated,
}: {
  taskId: number;
  onRevisionCreated?: (revision: Revision) => void;
}) {
  const [state, setState] = useState<RefineState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [instruction, setInstruction] = useState('');
  const [sending, setSending] = useState(false);
  const [activeVersion, setActiveVersion] = useState<number>(0);
  const [sendError, setSendError] = useState('');
  const sendingRef = useRef(false);
  const mountedTaskRef = useRef(taskId);

  const load = useCallback(async () => {
    try {
      const payload = (await api.get(`/task-center/restaurant/${taskId}/refine`, { silent: true })) as RefineState;
      if (mountedTaskRef.current !== taskId) return;
      setState(payload);
      setLoadError('');
      setActiveVersion(payload.latestVersion || 0);
    } catch (error) {
      if (mountedTaskRef.current !== taskId) return;
      setLoadError(errorText(error, '读取报告优化状态失败'));
    }
  }, [taskId]);

  // 父级以 taskId 作 key 挂载本组件：切换任务即整体重建，状态自然归零，
  // 这里只负责拉取当前任务的优化状态。
  useEffect(() => {
    mountedTaskRef.current = taskId;
    const initial = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(initial);
      mountedTaskRef.current = -1;
    };
  }, [taskId, load]);

  const versions = useMemo(() => {
    if (!state) return [];
    return [
      { version: 0, label: '原稿', markdown: state.original.markdown, generateUrl: state.original.generateUrl, instruction: '', changeSummary: '', risk: null as Revision['risk'] | null },
      ...state.revisions.map(revision => ({
        version: revision.version,
        label: `第${revision.version}版`,
        markdown: revision.markdown,
        generateUrl: revision.generateUrl,
        instruction: revision.instruction,
        changeSummary: revision.changeSummary,
        risk: revision.risk,
      })),
    ];
  }, [state]);
  const active = versions.find(item => item.version === activeVersion) || versions[versions.length - 1] || null;

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sendingRef.current || !state) return;
    if (!state.availability.available) {
      message.warning(state.availability.reason || '当前不能优化这份报告');
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setSendError('');
    try {
      const payload = await api.post(
        `/task-center/restaurant/${taskId}/refine`,
        { instruction: trimmed },
        { silent: true },
      );
      const revision = payload?.revision as Revision | undefined;
      if (!revision?.markdown) throw new Error('上游没有返回新版报告，本次未扣费');
      if (mountedTaskRef.current !== taskId) return;
      setState(current =>
        current
          ? { ...current, revisions: [...current.revisions, revision], latestVersion: revision.version }
          : current,
      );
      setActiveVersion(revision.version);
      setInstruction('');
      const billingState = String(payload?.billing?.state || '');
      message.success(
        `第${revision.version}版已生成${billingState === 'settled' && payload?.billing?.chargedCredits != null ? `（消耗 ${payload.billing.chargedCredits} 积分）` : ''}`,
      );
      onRevisionCreated?.(revision);
    } catch (error) {
      if (mountedTaskRef.current !== taskId) return;
      setSendError(errorText(error, '本轮优化失败，未扣费'));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  if (loadError) {
    return (
      <section className="report-refine" aria-label="报告多轮优化">
        <Alert type="warning" showIcon message="暂时无法加载报告优化" description={loadError} />
      </section>
    );
  }
  if (!state) return null;
  if (!state.original.markdown && !state.revisions.length) return null;

  const employeeLabel = state.task.employee.person
    ? `${state.task.employee.person}（${state.task.employee.name}）`
    : state.task.employee.name;

  return (
    <section className="report-refine" aria-label="报告多轮对话优化">
      <header className="report-refine__head">
        <div>
          <h3>
            <EditOutlined /> 继续和 {employeeLabel} 优化这份报告
          </h3>
          <p>
            直接说要怎么改：更短、更口语、展开某一部分、改成对比表、加行动清单……每一轮都会保留为独立版本，
            原稿不变，改到满意的版本可单独导出 PDF/Word。
          </p>
        </div>
        {versions.length > 1 && (
          <Segmented
            size="small"
            value={activeVersion}
            onChange={value => setActiveVersion(Number(value))}
            options={versions.map(item => ({ label: item.label, value: item.version }))}
            aria-label="切换报告版本"
          />
        )}
      </header>

      {!state.availability.available && (
        <Alert type="info" showIcon message={state.availability.reason || '当前不能优化这份报告'} />
      )}

      {state.availability.available && (
        <div className="report-refine__composer">
          <Space size={[6, 6]} wrap>
            {state.quickInstructions.map(item => (
              <Tooltip key={item.key} title={item.instruction}>
                <Button size="small" disabled={sending} onClick={() => void send(item.instruction)}>
                  {item.label}
                </Button>
              </Tooltip>
            ))}
          </Space>
          <div className="report-refine__input">
            <Input.TextArea
              value={instruction}
              onChange={event => setInstruction(event.target.value)}
              placeholder={
                sending
                  ? `${state.task.employee.person || '员工'}正在改这份报告，通常 30~90 秒…`
                  : '例：把第二部分竞品对比展开成 3 家逐项对比，并把结论写成老板能直接拍板的一句话'
              }
              autoSize={{ minRows: 2, maxRows: 5 }}
              maxLength={1200}
              disabled={sending}
              onPressEnter={event => {
                if (event.metaKey || event.ctrlKey) void send(instruction);
              }}
            />
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={sending}
              disabled={!instruction.trim()}
              onClick={() => void send(instruction)}
            >
              {sending ? '正在出新版' : `出第${state.latestVersion + 1}版`}
            </Button>
          </div>
          <small>Ctrl/⌘ + Enter 发送 · 每轮按真实用量计费，模型没交出完整新版则不扣费</small>
        </div>
      )}

      {sendError && <Alert type="error" showIcon message="本轮优化未完成" description={sendError} />}

      {active && (
        <article className="report-refine__version" data-version={active.version}>
          <header>
            <div className="report-refine__version-meta">
              <Tag color={active.version === 0 ? 'default' : 'blue'}>{active.label}</Tag>
              {active.instruction && (
                <span className="report-refine__instruction">
                  <HistoryOutlined /> 修改要求：{active.instruction}
                </span>
              )}
              {active.risk && active.risk.level !== 'none' && (
                <Tag color={active.risk.level === 'high' ? 'red' : 'orange'}>
                  含敏感表述（{active.risk.flags.join('、') || active.risk.level}），对外使用前请人工复核
                </Tag>
              )}
            </div>
            <div className="report-refine__version-actions">
              <TaskDocumentDownloads
                key={`${taskId}:${active.version}`}
                availability={{ canGenerate: true, generateUrl: active.generateUrl }}
              />
              <Button
                size="small"
                icon={<CopyOutlined aria-hidden />}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(active.markdown);
                    message.success(`${active.label}正文已复制`);
                  } catch {
                    message.error('复制失败，请选择正文手动复制');
                  }
                }}
              >
                复制此版
              </Button>
            </div>
          </header>
          {active.changeSummary && (
            <p className="report-refine__change-summary">本轮改动：{active.changeSummary}</p>
          )}
          {active.version === 0 ? (
            <details className="report-refine__original">
              <summary>展开原稿正文（与上方结果正文相同）</summary>
              <Markdown content={active.markdown} />
            </details>
          ) : (
            <Markdown content={active.markdown} />
          )}
        </article>
      )}

      {state.revisions.length > 0 && (
        <details className="report-refine__history">
          <summary>
            <HistoryOutlined /> 历次修改要求（{state.revisions.length} 轮）
          </summary>
          <ol>
            {state.revisions.map(revision => (
              <li key={revision.id}>
                <button type="button" onClick={() => setActiveVersion(revision.version)}>
                  第{revision.version}版
                </button>
                <span>{revision.instruction}</span>
                {revision.changeSummary && <em>{revision.changeSummary}</em>}
              </li>
            ))}
          </ol>
        </details>
      )}
      <p className="report-refine__boundary">{state.boundary}</p>
    </section>
  );
}
