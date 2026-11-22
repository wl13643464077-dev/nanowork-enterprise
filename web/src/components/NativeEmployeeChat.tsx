import { isPersonalApiUser, personalApiBillingLabel, PERSONAL_API_PRICING_NOTE } from './personalApiBilling.js';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Input, Modal, Select, Space, Spin, message } from 'antd';
import { api, getUser, notifyCredits } from '../api/client';
import { Markdown } from './Markdown';
import { UnifiedFilePicker, type UploadedFileRef } from './UnifiedFilePicker';
import './NativeEmployeeChat.css';

export type NativeChatOptions = {
  durationSeconds?: 15 | 30;
  imageCount: number;
  style: string;
  coverLayout: string;
  includeDiner: boolean;
};
export type NativeGeneration = { kind: 'video' | 'xhs'; jobId: number; pollUrl: string; planVersion?: number };
type NativePlan = {
  version: number;
  ready: boolean;
  summary?: string;
  options?: Partial<NativeChatOptions>;
  warnings?: string[];
  script?: { shots?: Array<{ index: number; voiceover: string; visualPrompt?: string; visual?: string }> };
  output?: { title: string; body: string; tags?: string[]; firstComment?: string };
};
type NativeSession = {
  id: number;
  employeeIdx: number;
  status: string;
  files?: UploadedFileRef[];
  options?: Partial<NativeChatOptions>;
  messages: Array<{
    id: string | number;
    role: string;
    content: string;
    fileIds?: number[];
    status?: string;
    billing?: { balance?: number; state?: string; note?: string; chargedCredits?: number };
  }>;
  currentPlan?: NativePlan | null;
  generation?: NativeGeneration | null;
  error?: string | null;
};
export type NativeImageOptions = {
  available: boolean;
  reason?: string | null;
  creditsPerImage: number;
  imageCounts?: number[];
  styles?: Array<{ id: string; label: string }>;
  coverLayouts?: Array<{ id: string; label: string }>;
};
export type NativeVideoDurationQuote = {
  durationSeconds: 15 | 30;
  segmentCount?: number;
  estimatedMaxCredits?: number;
};
const formatYuanFromCredits = (credits: number) => `≈ ¥${(credits * 0.01).toFixed(2)}`;
const defaults: NativeChatOptions = { imageCount: 6, style: 'seed', coverLayout: 'photo', includeDiner: false };
const optionsOf = (options?: Partial<NativeChatOptions>): NativeChatOptions => ({ ...defaults, ...options });
const initialOptions = (employeeIdx: 10 | 11) => optionsOf(employeeIdx === 10 ? { durationSeconds: 15 } : undefined);
const isWorking = (status?: string) => ['thinking', 'generating'].includes(status || '');
async function refreshCurrentCredits() {
  const owner = getUser();
  try {
    const current = await api.get('/auth/me', { silent: true });
    const active = getUser();
    if (
      active?.id === owner?.id &&
      active?.tenant?.id === owner?.tenant?.id &&
      current?.id === owner?.id &&
      current?.tenant?.id === owner?.tenant?.id &&
      typeof current.credits === 'number' &&
      Number.isFinite(current.credits)
    )
      notifyCredits(current.credits);
  } catch {
    // An old message's settlement balance must never replace the current wallet.
  }
}
const examples = {
  10: [
    {
      text: '用这几张门头和菜品照，做一条下班聚餐主题的15秒视频，脚本你来写，配中文声音和字幕。',
      options: { durationSeconds: 15 },
    },
    {
      text: '我想吸引周末带家人吃饭的客人。根据门头和招牌菜照片写15秒口播稿，先给我看方案。',
      options: { durationSeconds: 15 },
    },
    {
      text: '这次想介绍一道新品，用我拍的照片做15秒带货视频，口播自然一点，不要夸张承诺。',
      options: { durationSeconds: 15 },
    },
  ],
  11: [
    {
      text: '给我们门店做6图种草，封面用四宫格，正文自然一点。',
      options: { imageCount: 6, style: 'seed', coverLayout: 'collage4' },
    },
    {
      text: '用门头和菜品照片做9张点单攻略，封面用大字标题，文案你来写，不要编造口感。',
      options: { imageCount: 9, style: 'guide', coverLayout: 'headline' },
    },
    {
      text: '做一组12张的朋友聚餐探店图文，突出菜品食欲感，先给我看文案和每张图的安排。',
      options: { imageCount: 12, style: 'visit', coverLayout: 'photo' },
    },
  ],
} satisfies Record<10 | 11, Array<{ text: string; options?: Partial<NativeChatOptions> }>>;

export default function NativeEmployeeChat({
  open,
  employeeIdx,
  canDispatch = true,
  generating = false,
  onGeneration,
  imageOptions,
  mediaReady = true,
  mediaQuote,
  videoDurationOptions,
  onVideoDurationChange,
  initialText,
  resultFirst = false,
  children,
}: {
  open: boolean;
  employeeIdx: 10 | 11;
  canDispatch?: boolean;
  generating?: boolean;
  onGeneration: (generation: NativeGeneration, source: 'restore' | 'confirmation') => void;
  imageOptions?: NativeImageOptions | null;
  mediaReady?: boolean;
  mediaQuote?: string;
  videoDurationOptions?: NativeVideoDurationQuote[] | null;
  onVideoDurationChange?: (durationSeconds: 15 | 30) => void;
  initialText?: { key: number; text: string } | null;
  resultFirst?: boolean;
  children?: ReactNode;
}) {
  const owner = getUser();
  const personalBilling = isPersonalApiUser(owner);
  const ownerKey = `${owner?.tenant?.id || ''}:${owner?.id || ''}:${employeeIdx}`;
  const [composerOwner, setComposerOwner] = useState(ownerKey);
  const [storedSession, setSession] = useState<(NativeSession & { ownerKey: string }) | null>(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<UploadedFileRef[]>([]);
  const [options, setOptions] = useState<NativeChatOptions>(() => initialOptions(employeeIdx));
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [loadVersion, setLoadVersion] = useState(0);
  const sessionRef = useRef<number | null>(null);
  const epochRef = useRef(0);
  const busyRef = useRef(false);
  const confirmModalOpenRef = useRef(false);
  const messageRequest = useRef<{ signature: string; key: string } | null>(null);
  const pendingDraft = useRef<{ text: string; content: string; fileIds: number[]; previousCount: number } | null>(null);
  const confirmationRequest = useRef<{ signature: string; key: string } | null>(null);
  const seenGeneration = useRef('');
  const seenPlan = useRef('');
  const generationHandler = useRef(onGeneration);
  const previousOwner = useRef(ownerKey);
  const session = storedSession?.ownerKey === ownerKey ? storedSession : null;
  const employeeName = employeeIdx === 10 ? 'AI带货员' : 'AI小红书种草员';

  useEffect(() => {
    generationHandler.current = onGeneration;
  }, [onGeneration]);
  const receive = useCallback(
    (next: NativeSession, source: 'restore' | 'confirmation' = 'restore') => {
      if (!next?.id || Number(next.employeeIdx) !== employeeIdx || !Array.isArray(next.messages)) {
        throw new Error('对话回执不完整，请刷新后重试。');
      }
      sessionRef.current = next.id;
      setSession({ ...next, ownerKey });
      const sent = pendingDraft.current;
      const lastReply = [...next.messages].reverse().find(item => item.role === 'assistant');
      if (next.status === 'failed' && lastReply?.billing?.state === 'released') messageRequest.current = null;
      const lastUser = [...next.messages].reverse().find(item => item.role === 'user');
      if (
        sent &&
        ['ready', 'draft'].includes(next.status) &&
        next.messages.length > sent.previousCount &&
        next.messages[next.messages.length - 1]?.role === 'assistant' &&
        lastUser?.content === sent.content
      ) {
        setText(current => (current === sent.text ? '' : current));
        setFiles(current =>
          JSON.stringify(current.map(file => file.id)) === JSON.stringify(sent.fileIds) ? [] : current,
        );
        pendingDraft.current = null;
      }
      const planKey = `${next.id}:${JSON.stringify(next.options || next.currentPlan?.options || {})}`;
      // Creating an empty session must not overwrite the draft's selected options.
      const restoreOptions = next.messages.length > 0 || next.currentPlan || next.generation || !busyRef.current;
      if (restoreOptions && seenPlan.current !== planKey) {
        const restored = optionsOf(next.options || next.currentPlan?.options);
        if (employeeIdx === 10 && restored.durationSeconds == null) {
          // Historical conversations predate this choice and used two 15-second clips.
          restored.durationSeconds = next.messages.length || next.currentPlan || next.generation ? 30 : 15;
        }
        setOptions(restored);
      }
      seenPlan.current = planKey;
      const generation = next.generation;
      if (generation?.jobId && generation.pollUrl) {
        const key = `${generation.kind}:${generation.jobId}`;
        if (seenGeneration.current !== key) {
          seenGeneration.current = key;
          generationHandler.current(generation, source);
        }
      }
    },
    [employeeIdx, ownerKey],
  );

  const refresh = useCallback(
    async (epoch = epochRef.current) => {
      const id = sessionRef.current;
      if (!id) return;
      const response = await api.get(`/content/native-chat/sessions/${id}`, { silent: true });
      if (epoch !== epochRef.current || sessionRef.current !== id) return;
      receive(response.session);
    },
    [receive],
  );

  useEffect(() => {
    const epoch = ++epochRef.current;
    if (!open) return;
    queueMicrotask(() => {
      if (epoch !== epochRef.current) return;
      setLoading(true);
      setError('');
      setSending(false);
      setConfirming(false);
      setRechecking(false);
      busyRef.current = false;
      confirmModalOpenRef.current = false;
      if (previousOwner.current !== ownerKey) {
        previousOwner.current = ownerKey;
        setComposerOwner(ownerKey);
        sessionRef.current = null;
        messageRequest.current = null;
        pendingDraft.current = null;
        confirmationRequest.current = null;
        seenGeneration.current = '';
        seenPlan.current = '';
        setSession(null);
        setText('');
        setFiles([]);
        setOptions(initialOptions(employeeIdx));
        setError('');
      }
    });
    void api
      .get(`/content/native-chat/sessions?employeeIdx=${employeeIdx}`, { silent: true })
      .then(async response => {
        if (epoch !== epochRef.current) return;
        if (!Array.isArray(response.sessions)) throw new Error('对话列表未能读取，请刷新重试。');
        const latest = response.sessions.find((item: any) => Number(item.employeeIdx) === employeeIdx);
        if (!latest) {
          setSession(null);
          sessionRef.current = null;
          return;
        }
        sessionRef.current = latest.id;
        await refresh(epoch);
      })
      .catch((failure: Error) => {
        if (epoch === epochRef.current) setError(failure.message || '对话暂未载入，请刷新重试。');
      })
      .finally(() => {
        if (epoch === epochRef.current) setLoading(false);
      });
    return () => {
      confirmModalOpenRef.current = false;
      epochRef.current += 1;
    };
  }, [open, ownerKey, employeeIdx, refresh, loadVersion]);

  useEffect(() => {
    if (!open || !initialText?.text) return;
    queueMicrotask(() => setText(initialText.text));
  }, [open, initialText?.key, initialText?.text]);

  useEffect(() => {
    if (!open || !session?.id || !isWorking(session.status)) return;
    const epoch = epochRef.current;
    const timer = window.setInterval(() => {
      void refresh(epoch).catch(() => {
        if (epoch === epochRef.current) setError('进度暂未取得，正在继续查询；不会重复提交。');
      });
    }, 4000);
    return () => window.clearInterval(timer);
  }, [open, session?.id, session?.status, refresh]);

  const durationSeconds = options.durationSeconds === 30 ? 30 : 15;
  useEffect(() => {
    if (open && employeeIdx === 10) onVideoDurationChange?.(durationSeconds);
  }, [open, employeeIdx, durationSeconds, onVideoDurationChange]);

  const working = sending || confirming || rechecking || uploading || generating || isWorking(session?.status);
  const blocked =
    !canDispatch ||
    composerOwner !== ownerKey ||
    loading ||
    working ||
    (storedSession != null && storedSession.ownerKey !== ownerKey) ||
    session?.status === 'billing_pending';
  const send = async () => {
    if (blocked || busyRef.current || (!text.trim() && !files.length && !optionsChanged)) return;
    const epoch = epochRef.current;
    const draftText = text;
    busyRef.current = true;
    setSending(true);
    setError('');
    try {
      let id = sessionRef.current;
      if (!id) {
        const created = await api.post('/content/native-chat/sessions', { employeeIdx }, { silent: true });
        if (epoch !== epochRef.current) return;
        receive(created.session);
        id = created.session.id;
      }
      const content =
        draftText.trim() ||
        (optionsChanged
          ? employeeIdx === 10
            ? `请把视频方案调整为 ${durationSeconds} 秒${durationSeconds === 30 ? '（两段）' : '（一段）'}，脚本你来写。`
            : `请把方案调整为 ${options.imageCount} 张图，风格：${imageOptions?.styles?.find(item => item.id === options.style)?.label || options.style}，封面：${imageOptions?.coverLayouts?.find(item => item.id === options.coverLayout)?.label || options.coverLayout}，${options.includeDiner ? '加入' : '不加入'} AI 成年女性用餐场景。`
          : '请根据这些照片帮我整理方案。');
      const body = {
        message: content,
        // Omission retains the conversation's photos while discussing a revision.
        fileIds: files.length ? files.map(file => file.id) : undefined,
        options: employeeIdx === 10 ? { durationSeconds } : options,
      };
      const signature = JSON.stringify({ id, ...body });
      if (messageRequest.current?.signature !== signature) {
        messageRequest.current = { signature, key: crypto.randomUUID() };
        pendingDraft.current = {
          text: draftText,
          content,
          fileIds: body.fileIds || [],
          previousCount: session?.messages.length || 0,
        };
      }
      const response = await api.post(
        `/content/native-chat/sessions/${id}/messages`,
        { ...body, requestKey: messageRequest.current.key },
        { silent: true },
      );
      if (epoch !== epochRef.current) return;
      receive(response.session);
      void refreshCurrentCredits();
      if (response.session.error) setError(response.session.error);
    } catch (failure) {
      if (epoch !== epochRef.current) return;
      setError(failure instanceof Error ? failure.message : '消息未能确认，输入已保留。');
      // 查询已保存的消息，不因客户端超时自动再发一次付费请求。
      try {
        await refresh(epoch);
      } catch {
        /* 原始错误与用户输入保持可见。 */
      }
    } finally {
      if (epoch === epochRef.current) {
        busyRef.current = false;
        setSending(false);
      }
    }
  };
  const plan = session?.currentPlan;
  const planDurationSeconds = plan?.options?.durationSeconds === 15 ? 15 : 30;
  const optionsChanged =
    !!plan &&
    (employeeIdx === 10
      ? durationSeconds !== planDurationSeconds
      : JSON.stringify(optionsOf(plan.options)) !== JSON.stringify(options));
  const hasUnsentChanges = Boolean(text.trim() || files.length || optionsChanged);
  const alreadyConfirmed =
    !!session?.generation &&
    (session.generation.planVersion == null || session.generation.planVersion === plan?.version);
  const confirmationReady = !!plan?.ready && !alreadyConfirmed && !blocked && !hasUnsentChanges && mediaReady;
  const canRecheck =
    employeeIdx === 10 &&
    !!plan &&
    !plan.ready &&
    !!(plan.summary || plan.script?.shots?.length || plan.output) &&
    !alreadyConfirmed &&
    !['thinking', 'generating', 'billing_pending'].includes(session?.status || '');
  const confirm = async () => {
    if (!confirmationReady || busyRef.current || !session || !plan) return;
    const epoch = epochRef.current;
    busyRef.current = true;
    setConfirming(true);
    setError('');
    const signature = `${session.id}:${plan.version}`;
    if (confirmationRequest.current?.signature !== signature)
      confirmationRequest.current = { signature, key: crypto.randomUUID() };
    try {
      const response = await api.post(
        `/content/native-chat/sessions/${session.id}/confirm`,
        { planVersion: plan.version, requestKey: confirmationRequest.current.key },
        { silent: true },
      );
      if (epoch !== epochRef.current) return;
      receive({ ...response.session, generation: response.generation || response.session?.generation }, 'confirmation');
      void refreshCurrentCredits();
    } catch (failure) {
      if (epoch !== epochRef.current) return;
      setError(failure instanceof Error ? failure.message : '生成确认未能完成，请刷新对话核对。');
      try {
        await refresh(epoch);
      } catch {
        /* 保留错误，不自动重复确认。 */
      }
    } finally {
      if (epoch === epochRef.current) {
        busyRef.current = false;
        setConfirming(false);
      }
    }
  };
  const quote15 = videoDurationOptions?.find(item => item.durationSeconds === 15) || null;
  const quote30 = videoDurationOptions?.find(item => item.durationSeconds === 30) || null;
  const credits15 =
    quote15?.estimatedMaxCredits != null && Number.isFinite(quote15.estimatedMaxCredits)
      ? quote15.estimatedMaxCredits
      : null;
  const credits30 =
    quote30?.estimatedMaxCredits != null && Number.isFinite(quote30.estimatedMaxCredits)
      ? quote30.estimatedMaxCredits
      : null;
  const planVideoCredits = planDurationSeconds === 30 ? credits30 : credits15;
  const requestConfirm = () => {
    if (!confirmationReady || busyRef.current || !session || !plan) return;
    if (employeeIdx === 10 && typeof Modal.confirm === 'function') {
      if (confirmModalOpenRef.current) return;
      confirmModalOpenRef.current = true;
      Modal.confirm({
        title: `确认生成 ${planDurationSeconds} 秒带货视频？`,
        width: 520,
        okText: personalBilling
          ? `确认生成 ${planDurationSeconds} 秒视频`
          : planVideoCredits != null
            ? `确认预占 ${planVideoCredits} 积分并生成`
            : `确认生成 ${planDurationSeconds} 秒视频`,
        cancelText: '再改改脚本',
        content: (
          <div className="native-employee-chat__confirm-modal">
            <div className="native-employee-chat__confirm-summary">
              <strong>
                所选时长：
                {planDurationSeconds === 30
                  ? '30 秒（完整口播 · 费用翻倍 · 两段）'
                  : '15 秒（推荐试拍 · 更省成本 · 一段）'}
              </strong>
              <span>
                {personalBilling
                  ? PERSONAL_API_PRICING_NOTE
                  : planVideoCredits != null
                    ? `预计最高预占 ${planVideoCredits} 积分（${formatYuanFromCredits(planVideoCredits)}），按上游实际扣费结算，多退少补。`
                    : mediaQuote || '按上游实际扣费结算，多退少补。'}
              </span>
            </div>
            <div className="native-employee-chat__confirm-compare">
              <div
                className={`native-employee-chat__confirm-tier${planDurationSeconds === 15 ? ' native-employee-chat__confirm-tier--current' : ''}`}
              >
                <span>15 秒（推荐试拍 · 更省成本）</span>
                <span>
                  {personalBilling
                    ? '单段生成 · 按供应商账单计费'
                    : credits15 != null
                      ? `最高预占 ${credits15} 积分（${formatYuanFromCredits(credits15)}）`
                      : '单段试拍，成本更低'}
                </span>
              </div>
              <div
                className={`native-employee-chat__confirm-tier${planDurationSeconds === 30 ? ' native-employee-chat__confirm-tier--current' : ''}`}
              >
                <span>30 秒（完整口播 · 费用翻倍）</span>
                <span>
                  {personalBilling
                    ? '两段生成 · 上游费用约翻倍'
                    : credits30 != null
                      ? `最高预占 ${credits30} 积分（${formatYuanFromCredits(credits30)}）`
                      : '两段拼接，费用约翻倍'}
                </span>
              </div>
            </div>
            <p className="native-employee-chat__confirm-tip">
              省钱建议：日常高频测款建议优先使用小红书图文，成本约为视频的 1/10。
            </p>
          </div>
        ),
        onOk: async () => {
          confirmModalOpenRef.current = false;
          await confirm();
        },
        onCancel: () => {
          confirmModalOpenRef.current = false;
        },
      });
      return;
    }
    void confirm();
  };
  const recheck = async () => {
    if (!canRecheck || blocked || busyRef.current || !session || !plan) return;
    const epoch = epochRef.current;
    busyRef.current = true;
    setRechecking(true);
    setError('');
    try {
      const response = await api.post(
        `/content/native-chat/sessions/${session.id}/revalidate`,
        { planVersion: plan.version },
        { silent: true },
      );
      if (epoch !== epochRef.current) return;
      receive(response.session);
    } catch (failure) {
      if (epoch === epochRef.current)
        setError(failure instanceof Error ? failure.message : '方案检查未完成，原稿仍然保留。');
    } finally {
      if (epoch === epochRef.current) {
        busyRef.current = false;
        setRechecking(false);
      }
    }
  };
  const restart = () => {
    if (working || busyRef.current) return;
    confirmModalOpenRef.current = false;
    epochRef.current += 1;
    sessionRef.current = null;
    messageRequest.current = null;
    pendingDraft.current = null;
    confirmationRequest.current = null;
    seenGeneration.current = '';
    seenPlan.current = '';
    setSession(null);
    setText('');
    setFiles([]);
    setOptions(initialOptions(employeeIdx));
    setError('');
  };
  const readOnly = !canDispatch;
  const usageExampleContent = (
    <>
      <p>
        一句话主题，加几张门头和菜品实拍就能开始。
        {employeeIdx === 10 ? '脚本由员工来写，你看过后确认。' : '文案和配图方案由员工来做，你看过后确认。'}
      </p>
      {examples[employeeIdx].map(example => (
        <Button
          key={example.text}
          type="text"
          disabled={blocked}
          onClick={() => {
            setText(example.text);
            if ('options' in example) setOptions(current => ({ ...current, ...example.options }));
          }}
        >
          {example.text}
        </Button>
      ))}
      <small>点示例只填入草稿，添加照片后再发送。</small>
    </>
  );
  return (
    <section className="native-employee-chat" aria-label={`${employeeName}对话`}>
      <header className="native-employee-chat__header">
        <div>
          <h3>和{employeeName}聊聊</h3>
          <p>发来文字和真实照片，先讨论方案，确认后再生成{employeeIdx === 10 ? '视频' : '配图'}。</p>
        </div>
        <Space>
          <Button href="/tasks">全部历史 · 任务中心</Button>
          <Button type="text" disabled={working || loading} onClick={restart}>
            新对话
          </Button>
        </Space>
      </header>
      {resultFirst && children}
      {loading && (
        <div className="native-employee-chat__progress" role="status">
          <Spin size="small" />
          正在载入对话
        </div>
      )}
      {!loading &&
        (!session?.messages.length ? (
          <section className="native-employee-chat__examples" aria-label="使用示例">
            <h4>一句话使用我</h4>
            {usageExampleContent}
          </section>
        ) : (
          <details className="native-employee-chat__examples-disclosure">
            <summary>一句话使用我</summary>
            <div className="native-employee-chat__examples" aria-label="使用示例">
              {usageExampleContent}
            </div>
          </details>
        ))}
      <div className="native-employee-chat__messages" aria-live="polite">
        {(session?.messages || []).map(item => (
          <article
            className={`native-employee-chat__message native-employee-chat__message--${item.role === 'user' ? 'user' : 'assistant'}`}
            key={item.id}
          >
            <header>
              <strong>{item.role === 'user' ? '你' : employeeName}</strong>
            </header>
            {item.role === 'user' ? (
              <p className="native-employee-chat__user-text">{item.content}</p>
            ) : item.status === 'failed' ? (
              <Alert
                type="warning"
                showIcon
                message={
                  personalBilling && /积分|预授权|未扣费/.test(item.content || '')
                    ? '本轮未能取得回复，原输入已保留；上游费用以供应商账单为准。'
                    : item.content || '本轮未能取得回复，原输入已保留。'
                }
              />
            ) : (
              <Markdown content={item.content} />
            )}
            {!!item.fileIds?.length && (
              <div className="native-employee-chat__attachments">
                {item.fileIds.map(id => {
                  const file = session?.files?.find(value => value.id === id);
                  return (
                    <figure key={id}>
                      {file?.file_url?.startsWith('/uploads/') && <img src={file.file_url} alt={file.name} />}
                      <figcaption>{file?.name || '已上传照片'}</figcaption>
                    </figure>
                  );
                })}
              </div>
            )}
            {item.billing && (
              <p className="native-employee-chat__hint">
                {personalBilling
                  ? personalApiBillingLabel(item.billing)
                  : item.billing.state === 'settled'
                    ? `本轮对话 ${item.billing.chargedCredits ?? '已结算'}${item.billing.chargedCredits != null ? ' 积分' : ''}`
                    : item.billing.note || '本轮对话费用待核对'}
              </p>
            )}
          </article>
        ))}
      </div>
      {(sending || session?.status === 'thinking') && (
        <div className="native-employee-chat__progress" role="status">
          <Spin size="small" />
          正在阅读你的要求和照片，整理方案
        </div>
      )}
      {plan && (plan.ready || plan.summary || plan.script?.shots?.length || plan.output) && (
        <section className="native-employee-chat__plan" aria-label="待确认方案">
          <h4>{employeeIdx === 10 ? '这次的口播与镜头方案' : '这次的图文方案'}</h4>
          {employeeIdx === 10 && (
            <p className="native-employee-chat__hint">
              本方案 {planDurationSeconds} 秒（{planDurationSeconds === 30 ? '两段' : '一段'}）。
            </p>
          )}
          {plan.summary && <Markdown content={plan.summary} />}
          {plan.script?.shots?.map(shot => (
            <div key={shot.index}>
              <h4>第 {shot.index} 段</h4>
              <p className="native-employee-chat__user-text">{shot.voiceover}</p>
              {(shot.visual || shot.visualPrompt) && (
                <p className="native-employee-chat__hint">画面：{shot.visual || shot.visualPrompt}</p>
              )}
            </div>
          ))}
          {plan.output && (
            <Markdown
              content={`### ${plan.output.title}\n\n${plan.output.body}\n\n${(plan.output.tags || []).map(tag => `#${tag.replace(/^#+/, '')}`).join(' ')}\n\n${plan.output.firstComment ? `**首评：** ${plan.output.firstComment}` : ''}`}
            />
          )}
          {!!plan.warnings?.length && (
            <Alert
              type="info"
              showIcon
              message="发布前请核对"
              description={
                <ul>
                  {plan.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              }
            />
          )}
          {employeeIdx === 11 && imageOptions && Number.isFinite(imageOptions.creditsPerImage) && (
            <p className="native-employee-chat__hint">
              {personalBilling ? (
                `本方案 ${plan.options?.imageCount || 6} 张图。${PERSONAL_API_PRICING_NOTE}`
              ) : (
                <>
                  本方案 {plan.options?.imageCount || 6} 张图，预计{' '}
                  {imageOptions.creditsPerImage * (plan.options?.imageCount || 6)} 积分；按每张实际调用结算。
                </>
              )}
            </p>
          )}
          {mediaQuote && <p className="native-employee-chat__hint">{mediaQuote}</p>}
          {employeeIdx === 10 && !alreadyConfirmed && (
            <Alert
              type="warning"
              showIcon
              message="视频渲染成本显著高于图文，请先审定脚本再确认生成"
              description={
                personalBilling
                  ? `单条视频按所选时长（当前 ${planDurationSeconds} 秒）由个人 API 供应商账户计费；如仅需日常测款或高频种草，建议优先使用「AI小红书种草员」图文出片。`
                  : `单条视频按所选时长（当前 ${planDurationSeconds} 秒）计费，费用显著高于图文；如仅需日常测款或高频种草，建议优先使用「AI小红书种草员」图文出片。`
              }
            />
          )}
          {hasUnsentChanges && !alreadyConfirmed && (
            <Alert
              type="info"
              showIcon
              message="确认按钮已暂停：你有尚未发送的调整"
              description="检测到输入框、照片或时长/参数有未同步修改，请先发送给员工更新方案，更新完成后即可确认生成。"
              action={
                <Button size="small" type="primary" loading={sending} disabled={blocked} onClick={() => void send()}>
                  一键更新方案
                </Button>
              }
            />
          )}
          <Button type="primary" loading={confirming} disabled={!confirmationReady} onClick={requestConfirm}>
            {alreadyConfirmed
              ? '此方案已确认生成'
              : employeeIdx === 10
                ? `确认脚本，生成 ${planDurationSeconds} 秒视频`
                : `确认方案，生成 ${plan.options?.imageCount || 6} 张图`}
          </Button>
        </section>
      )}
      {!resultFirst && children}
      {error && (
        <Alert
          type="warning"
          showIcon
          message={error}
          description="输入和已有成果会保留。可刷新核对对话后，再继续发送或确认。"
          action={
            <Button
              size="small"
              onClick={() => {
                if (!sessionRef.current) setLoadVersion(value => value + 1);
                else
                  void refresh()
                    .then(() => setError(''))
                    .catch((failure: Error) => message.error(failure.message));
              }}
            >
              刷新对话
            </Button>
          }
        />
      )}
      {session?.status === 'billing_pending' && (
        <Alert type="warning" showIcon message="本轮对话费用待核对，已有消息已保留" />
      )}
      {session?.status === 'failed' && (
        <p className="native-employee-chat__hint">
          本轮未能完成，原消息和照片已保留。核对上方费用说明后，可以修改消息再发送。
        </p>
      )}
      <div className="native-employee-chat__composer">
        {employeeIdx === 10 && (
          <div className="native-employee-chat__duration">
            <div className="native-employee-chat__duration-cards" role="group" aria-label="选择视频时长">
              <button
                type="button"
                disabled={blocked}
                aria-pressed={durationSeconds === 15}
                className={`native-employee-chat__duration-card${durationSeconds === 15 ? ' native-employee-chat__duration-card--active' : ''}`}
                onClick={() => setOptions(current => ({ ...current, durationSeconds: 15 }))}
              >
                <span className="native-employee-chat__duration-title">
                  <span>15 秒（推荐试拍 · 更省成本）</span>
                  <span className="native-employee-chat__duration-badge native-employee-chat__duration-badge--ok">
                    推荐
                  </span>
                </span>
                <span className="native-employee-chat__duration-cost">
                  {personalBilling
                    ? '单段生成 · 按个人 API 供应商账单计费'
                    : credits15 != null
                      ? `参考预占 ${credits15} 积分（${formatYuanFromCredits(credits15)}）`
                      : '一段完整口播 · 成本更低'}
                </span>
                <span className="native-employee-chat__duration-desc">适合新品试拍、高频测款与日常引流</span>
              </button>
              <button
                type="button"
                disabled={blocked}
                aria-pressed={durationSeconds === 30}
                className={`native-employee-chat__duration-card native-employee-chat__duration-card--warn${durationSeconds === 30 ? ' native-employee-chat__duration-card--active' : ''}`}
                onClick={() => setOptions(current => ({ ...current, durationSeconds: 30 }))}
              >
                <span className="native-employee-chat__duration-title">
                  <span>30 秒（完整口播 · 费用翻倍）</span>
                  <span className="native-employee-chat__duration-badge native-employee-chat__duration-badge--warn">
                    高成本
                  </span>
                </span>
                <span className="native-employee-chat__duration-cost">
                  {personalBilling
                    ? '两段拼接 · 上游费用约翻倍'
                    : credits30 != null
                      ? `参考预占 ${credits30} 积分（${formatYuanFromCredits(credits30)}）`
                      : '两段视频拼接 · 费用约翻倍'}
                </span>
                <span className="native-employee-chat__duration-desc">适合重点大促主推，分段声音音色可能略有差异</span>
              </button>
            </div>
            <Checkbox
              aria-label="生成30秒（两段）"
              checked={durationSeconds === 30}
              disabled={blocked}
              onChange={event =>
                setOptions(current => ({ ...current, durationSeconds: event.target.checked ? 30 : 15 }))
              }
            >
              生成30秒（两段）
            </Checkbox>
            <p className="native-employee-chat__hint">
              默认15秒一段；日常高频测款建议优先使用小红书图文，成本约为视频的 1/10。
            </p>
          </div>
        )}
        {employeeIdx === 11 && (
          <div className="native-employee-chat__options">
            <span className="native-employee-chat__option">
              图片
              <Select
                aria-label="图片数量"
                value={options.imageCount}
                disabled={blocked}
                options={(imageOptions?.imageCounts || [6, 9, 12]).map(value => ({ value, label: `${value} 张` }))}
                onChange={imageCount => setOptions(current => ({ ...current, imageCount }))}
              />
            </span>
            <span className="native-employee-chat__option">
              风格
              <Select
                aria-label="内容风格"
                value={options.style}
                disabled={blocked}
                options={
                  imageOptions?.styles?.map(item => ({ value: item.id, label: item.label })) || [
                    { value: 'seed', label: '种草推荐' },
                  ]
                }
                onChange={style => setOptions(current => ({ ...current, style }))}
              />
            </span>
            <span className="native-employee-chat__option">
              封面
              <Select
                aria-label="封面形式"
                value={options.coverLayout}
                disabled={blocked}
                options={
                  imageOptions?.coverLayouts?.map(item => ({ value: item.id, label: item.label })) || [
                    { value: 'photo', label: '食欲封面' },
                  ]
                }
                onChange={coverLayout => setOptions(current => ({ ...current, coverLayout }))}
              />
            </span>
            <Checkbox
              checked={options.includeDiner}
              disabled={blocked}
              onChange={event => setOptions(current => ({ ...current, includeDiner: event.target.checked }))}
            >
              加入 AI 成年女性用餐场景
            </Checkbox>
          </div>
        )}
        <Input.TextArea
          aria-label="发给数字员工的消息"
          placeholder={
            employeeIdx === 10
              ? `例如：这是我的门头和招牌菜，帮我做一条${durationSeconds}秒视频，先给我看口播稿。`
              : '例如：这是望京门店的门头和招牌菜，想做一组有食欲的小红书种草图文。'
          }
          value={composerOwner === ownerKey ? text : ''}
          onChange={event => setText(event.target.value)}
          autoSize={{ minRows: 3, maxRows: 9 }}
          maxLength={32000}
          disabled={blocked}
        />
        <UnifiedFilePicker
          files={composerOwner === ownerKey ? files : []}
          onChange={setFiles}
          imagesOnly
          recognize={false}
          dropEnabled
          disabled={blocked}
          purpose={employeeIdx === 10 ? 'ai_sales_video' : 'ai_xhs_note'}
          label="添加照片"
          onUploadingChange={setUploading}
        />
        <div className="native-employee-chat__actions">
          <p className="native-employee-chat__hint">
            {employeeIdx === 11
              ? 'AI 图片是创意制作；品牌、菜品与活动以你确认的信息为准。'
              : '中文声音与画面一起生成，字幕按脚本估时；成片后请播放检查。'}
            <br />
            {personalBilling
              ? `${PERSONAL_API_PRICING_NOTE}确认前不会生成媒体。`
              : '对话按实际用量结算，确认前不会生成媒体。'}
          </p>
          <Space wrap>
            {canRecheck && (
              <Button type="text" loading={rechecking} disabled={blocked} onClick={() => void recheck()}>
                重新检查方案
              </Button>
            )}
            <Button
              type="primary"
              loading={sending}
              disabled={blocked || (!text.trim() && !files.length && !optionsChanged)}
              onClick={() => void send()}
            >
              发送
            </Button>
          </Space>
        </div>
        {canRecheck && (
          <p className="native-employee-chat__hint">重新检查只使用已保存的方案，不重复生成，也不新增费用。</p>
        )}
        {readOnly && <p className="native-employee-chat__hint">当前账号可查看记录，没有派活权限。</p>}
      </div>
    </section>
  );
}
