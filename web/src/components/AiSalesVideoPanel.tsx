import { isPersonalApiUser, personalApiBillingLabel, PERSONAL_API_PRICING_NOTE } from './personalApiBilling.js';
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal, Space, Tag, message } from 'antd';
import NativeEmployeeChat, { type NativeGeneration, type NativeVideoDurationQuote } from './NativeEmployeeChat';
import NativeDeliverableDownloadButton from './NativeDeliverableDownloadButton';
import SpecialistTaskHistory, { type SpecialistHistoryRow } from './SpecialistTaskHistory';
import SalesVideoPublishKit from './SalesVideoPublishKit';
import { notifyCredits, api, getUser } from '../api/client';

export type ReferenceImage = { id: string; name: string; url: string; size: number };

export function salesVideoNativeModelLabel(result: any) {
  const model = String(result?.model || result?.salesVideo?.model || result?.plan?.model || '').trim();
  const segmentModels: string[] = result?.salesVideo?.segmentModels || [];
  if (/seedance/i.test(model))
    return segmentModels.some(item => /kling/i.test(item)) ? 'Seedance 2.5 与可灵 3.0' : 'Seedance 2.5';
  if (/kling/i.test(model)) return '可灵 3.0';
  const wanVersion = model.match(/wan[-_ ]?(\d+(?:\.\d+)?)/i)?.[1];
  return wanVersion ? `万相 ${wanVersion}` : model || '万相原生有声模型';
}
const SALES_VIDEO_RESULT_STORAGE_KEY = 'nanowork.content.aiSalesVideo.last';
const salesVideoStorageKey = () =>
  `${SALES_VIDEO_RESULT_STORAGE_KEY}:${getUser()?.tenant?.id || ''}:${getUser()?.id || ''}`;
const salesVideoDuration = (value: any): 15 | 30 =>
  Number(value?.salesVideo?.durationSeconds ?? value?.plan?.durationSeconds ?? value?.durationSeconds ?? 30) === 15
    ? 15
    : 30;

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
    // Keep the current header balance if this independent read fails.
  }
}

type SalesVideoStatus = 'processing' | 'success' | 'failed' | 'blocked';
const billingPending = (result: any) =>
  result?.salesVideo?.voiceMode === 'voiced' && result?.billing?.state !== 'settled';
const stageLabels: Record<string, string> = {
  preflight: '生成前检查',
  queued: '等待执行',
  script: '准备中文口播',
  voice: '配音与时长校验',
  video: '生成视频片段',
  compose: '合成与字幕校验',
  recovery: '复用原任务恢复',
  complete: '成片与结算完成',
};

const salesVideoStatus = (value: any): SalesVideoStatus => {
  const raw = String(value?.technicalStatus || value?.status || '').trim();
  if (['成功', 'success', 'completed', 'complete'].includes(raw)) return 'success';
  if (['失败', 'failed', 'error'].includes(raw)) return 'failed';
  if (['阻塞', 'blocked'].includes(raw)) return 'blocked';
  return 'processing';
};

const salesVideoResultSnapshot = (result: any) => {
  if (!result || !result.jobId) return null;
  return {
    jobId: Number(result.jobId),
    pollUrl: result.pollUrl || `/content/media-jobs/${Number(result.jobId)}`,
    status: result.status || 'processing',
    technicalStatus: result.technicalStatus || result.status || '处理中',
    reason: result.reason || result.error || '',
    error: result.error || '',
    workflow: result.workflow || 'ai_sales_video',
    durationSeconds: salesVideoDuration(result),
    providerCalls: Number(result.providerCalls || 0),
    billing: result.billing || null,
    businessStatus: result.businessStatus || result.reviewStatus || '',
    urlAvailable: result.urlAvailable === true,
  };
};

const persistSalesVideoResult = (result: any) => {
  const snapshot = salesVideoResultSnapshot(result);
  if (!snapshot) return;
  try {
    window.sessionStorage.setItem(salesVideoStorageKey(), JSON.stringify(snapshot));
  } catch {
    // 隐私模式或存储空间不足时，页面内状态仍然有效；不阻断任务。
  }
};

type AiSalesVideoPanelProps = {
  open: boolean;
  embedded?: boolean;
  canDispatch?: boolean;
  onOpenChange: (open: boolean) => void;
  initialJobId?: number | null;
  refImgs: ReferenceImage[];
  setRefImgs: Dispatch<SetStateAction<ReferenceImage[]>>;
  onPickRef: (files: FileList | null) => void | Promise<void>;
  loadMaterials: () => void | Promise<unknown>;
  loadSummary: () => void | Promise<unknown>;
  loadMediaJobs: (kind: string, options?: { silent?: boolean }) => void | Promise<unknown>;
  onTaskSubmitted: () => void;
  /** 样片库“照这个风格做一条”：预填任务目标；key 变化即重新预填 */
  presetBrief?: { key: number; text: string } | null;
};

/**
 * AI 带货员的完整任务面板：上传、提交、后台轮询、会话恢复和结果验收提示均在这里闭环。
 * 新任务使用服务端对话与租户附件，旧任务保留原有恢复入口。
 */
export default function AiSalesVideoPanel({
  open,
  embedded = false,
  canDispatch = true,
  onOpenChange,
  initialJobId = null,
  loadMaterials,
  loadSummary,
  loadMediaJobs,
  onTaskSubmitted,
  presetBrief = null,
}: AiSalesVideoPanelProps) {
  const personalBilling = isPersonalApiUser(getUser());
  const [recovering, setRecovering] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [polling, setPolling] = useState(false);
  const [videoOptions, setVideoOptions] = useState<any>(null);
  const [durationSeconds, setDurationSeconds] = useState<15 | 30>(15);
  const [optionsError, setOptionsError] = useState('');
  const [previewErrorUrl, setPreviewErrorUrl] = useState('');
  const [historyJobs, setHistoryJobs] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const loadSalesVideoHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const rows = await api.get('/content/media-jobs?kind=video', { silent: true });
      setHistoryJobs(
        (Array.isArray(rows) ? rows : []).filter(
          item =>
            Number(item?.content_employee_idx) === 10 ||
            item?.content_employee_key === 'commerce_video' ||
            item?.salesVideo,
        ),
      );
      setHistoryError('');
    } catch {
      setHistoryError('带货视频历史暂时没有载入，当前生成和下载不受影响。');
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadSalesVideoHistory();
    });
    return () => {
      cancelled = true;
    };
  }, [loadSalesVideoHistory, open, result?.jobId, result?.status, result?.technicalStatus]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api
      .get('/content/ai-sales-video/options', { silent: true })
      .then(options => {
        if (!cancelled) {
          setVideoOptions(options);
          setOptionsError('');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVideoOptions(null);
          setOptionsError('配置检查失败，请关闭后重新打开；尚未发起生成。');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const pollTimerRef = useRef<number | null>(null);
  const pollJobRef = useRef<number | null>(null);
  const pollUrlRef = useRef('');
  const pollAttemptsRef = useRef(0);
  const pollingActiveRef = useRef(false);
  const panelOpenRef = useRef(open);
  const pollEpochRef = useRef(0);

  const clearPolling = useCallback(() => {
    pollEpochRef.current += 1;
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollJobRef.current = null;
    pollUrlRef.current = '';
    pollAttemptsRef.current = 0;
    pollingActiveRef.current = false;
    setPolling(false);
  }, []);

  const applyPollResult = useCallback((current: any, jobId: number, pollUrl: string) => {
    const normalized = salesVideoStatus(current);
    const merged = {
      ...(current || {}),
      jobId,
      pollUrl,
      status: normalized,
      technicalStatus: current?.technicalStatus || current?.status || '处理中',
      reason: current?.reason || current?.error || '',
    };
    setResult(previous => {
      const next = { ...(Number(previous?.jobId) === jobId ? previous : {}), ...merged };
      persistSalesVideoResult(next);
      return next;
    });
    // billing.balance belongs to this historical ledger entry, not the current wallet.
    return normalized;
  }, []);

  const startPolling = useCallback(
    (pollUrl: string, jobId: number) => {
      if (!panelOpenRef.current) return;
      const safeJobId = Number(jobId);
      const safePollUrl = String(pollUrl || '').trim() || `/content/media-jobs/${safeJobId}`;
      if (!Number.isSafeInteger(safeJobId) || safeJobId < 1) return;
      if (pollJobRef.current === safeJobId && pollUrlRef.current === safePollUrl && pollingActiveRef.current) {
        return;
      }
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      const epoch = ++pollEpochRef.current;
      pollJobRef.current = safeJobId;
      pollUrlRef.current = safePollUrl;
      pollAttemptsRef.current = 0;
      pollingActiveRef.current = true;
      setPolling(true);

      const tick = async () => {
        if (
          !panelOpenRef.current ||
          pollEpochRef.current !== epoch ||
          pollJobRef.current !== safeJobId ||
          pollUrlRef.current !== safePollUrl
        )
          return;
        pollAttemptsRef.current += 1;
        try {
          const current = await api.get(safePollUrl, { silent: true });
          if (
            !panelOpenRef.current ||
            pollEpochRef.current !== epoch ||
            pollJobRef.current !== safeJobId ||
            pollUrlRef.current !== safePollUrl
          )
            return;
          const status = applyPollResult(current, safeJobId, safePollUrl);
          if (status !== 'processing') {
            clearPolling();
            void refreshCurrentCredits();
            if (status === 'success') {
              if (billingPending(current)) message.warning('视频已生成，费用待核对；已有结果保留，可查看任务详情');
              else message.success('视频已生成，可预览、下载或打包；未自动发布');
              await Promise.all([loadMaterials(), loadSummary(), loadMediaJobs('video', { silent: true })]);
            } else if (status === 'failed') {
              message.error(
                `${isPersonalApiUser(getUser()) && /积分|预授权|未扣费/.test(current?.error || current?.reason || '') ? 'AI带货员成片失败，原任务记录已保留' : current?.error || current?.reason || 'AI带货员成片失败'}；${
                  isPersonalApiUser(getUser())
                    ? personalApiBillingLabel(current?.billing)
                    : current?.billing?.state === 'released'
                      ? '预授权已退回'
                      : '积分待对账'
                }`,
              );
            } else {
              message.warning(current?.reason || current?.error || 'AI带货员任务暂时阻塞，请查看开通原因');
            }
            return;
          }
        } catch {
          // 网络抖动时继续轮询；任务仍由服务端执行，不重复提交。
        }
        if (
          !panelOpenRef.current ||
          pollEpochRef.current !== epoch ||
          pollJobRef.current !== safeJobId ||
          pollUrlRef.current !== safePollUrl
        )
          return;
        if (pollAttemptsRef.current >= 180) {
          clearPolling();
          message.warning('任务仍在后台生成，页面停止轮询；可点击“刷新任务结果”继续查看，不会重复提交');
          return;
        }
        const delay = pollAttemptsRef.current <= 10 ? 3000 : 5000;
        pollTimerRef.current = window.setTimeout(() => {
          pollTimerRef.current = null;
          void tick();
        }, delay);
      };
      void tick();
    },
    [applyPollResult, clearPolling, loadMaterials, loadMediaJobs, loadSummary],
  );

  const refreshResult = useCallback(async () => {
    const current = result;
    const jobId = Number(current?.jobId);
    const pollUrl = String(current?.pollUrl || (jobId ? `/content/media-jobs/${jobId}` : '')).trim();
    if (!Number.isSafeInteger(jobId) || jobId < 1 || !pollUrl) {
      message.info('当前没有可刷新的带货任务');
      return;
    }
    try {
      const latest = await api.get(pollUrl, { silent: true });
      const status = applyPollResult(latest, jobId, pollUrl);
      if (status !== 'processing') void refreshCurrentCredits();
      if (status === 'processing') {
        startPolling(pollUrl, jobId);
        message.info('任务仍在后台生成，已继续轮询');
      } else if (status === 'success') {
        clearPolling();
        if (billingPending(latest)) message.warning('视频已生成，费用待核对；已有结果保留，可查看任务详情');
        else message.success('视频已生成，可预览、下载或打包；未自动发布');
      } else if (status === 'failed') {
        clearPolling();
        message.error(`${latest?.error || latest?.reason || 'AI带货员成片失败'}；请查看账务状态`);
      } else {
        clearPolling();
        message.warning(latest?.reason || latest?.error || '任务暂时阻塞，请查看开通原因');
      }
    } catch {
      message.error('任务结果刷新失败，请稍后重试');
    }
  }, [applyPollResult, clearPolling, result, startPolling]);

  useEffect(() => {
    panelOpenRef.current = open;
    return () => {
      panelOpenRef.current = false;
      clearPolling();
    };
  }, [clearPolling, open]);

  useEffect(() => {
    if (!open) return;
    let jobId = Number(initialJobId);
    if (!Number.isSafeInteger(jobId) || jobId < 1) {
      try {
        const raw = window.sessionStorage.getItem(salesVideoStorageKey());
        jobId = Number(raw ? JSON.parse(raw)?.jobId : null);
      } catch {
        return;
      }
    }
    if (!Number.isSafeInteger(jobId) || jobId < 1) return;
    let cancelled = false;
    const epoch = pollEpochRef.current;
    const pollUrl = `/content/media-jobs/${jobId}`;
    // Reauthorize when the user opens this panel. Hidden instances do not
    // restore or poll a previous task, and closing does not cancel server work.
    void api
      .get(pollUrl, { silent: true })
      .then(latest => {
        if (cancelled || pollEpochRef.current !== epoch) return;
        const status = applyPollResult(latest, jobId, pollUrl);
        if (status === 'processing') startPolling(pollUrl, jobId);
      })
      .catch(() => {
        if (cancelled) return;
        if (initialJobId) message.error('带货任务详情加载失败，请稍后重试');
        else {
          try {
            window.sessionStorage.removeItem(salesVideoStorageKey());
          } catch {
            /* storage may be disabled */
          }
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applyPollResult, initialJobId, open, startPolling]);

  const openGeneratedJob = useCallback(
    (generation: NativeGeneration, source?: 'restore' | 'confirmation') => {
      if (generation.kind !== 'video' || !Number.isSafeInteger(generation.jobId)) return;
      if (source === 'restore' && initialJobId && Number(initialJobId) !== generation.jobId) return;
      const jobId = generation.jobId;
      const pollUrl = `/content/media-jobs/${jobId}`;
      applyPollResult(
        { status: 'processing', workflow: 'ai_sales_video', ...(source === 'confirmation' ? { durationSeconds } : {}) },
        jobId,
        pollUrl,
      );
      startPolling(pollUrl, jobId);
      onTaskSubmitted();
    },
    [applyPollResult, startPolling, onTaskSubmitted, initialJobId, durationSeconds],
  );

  const recoverExistingProviderTasks = useCallback(async () => {
    const jobId = Number(result?.jobId);
    if (!Number.isSafeInteger(jobId) || jobId < 1 || result?.recovery?.available !== true) {
      message.info('当前任务没有可复用的完整供应商视频片段');
      return;
    }
    const runRecovery = async () => {
      setRecovering(true);
      try {
        const response = await api.post(
          `/content/media-jobs/${jobId}/recover-ai-sales-video`,
          { confirmCharge: true },
          { silent: true },
        );
        const pollUrl = String(response?.pollUrl || `/content/media-jobs/${jobId}`);
        applyPollResult(response, jobId, pollUrl);
        startPolling(pollUrl, jobId);
        message.success('已开始复用原供应商任务恢复成片；不会重复生成视频');
      } catch (error: any) {
        message.error(error?.message || '旧任务恢复启动失败，请稍后重试');
        throw error;
      } finally {
        setRecovering(false);
      }
    };
    if (result?.recovery?.requiresBillingConfirmation) {
      const credits = Number(
        result?.recovery?.estimatedCredits || result?.billing?.estimatedCredits || result?.billing?.heldCredits || 0,
      );
      Modal.confirm({
        title: `确认恢复这条${salesVideoDuration(result)}秒成片？`,
        content: isPersonalApiUser(getUser())
          ? '本次只复用原供应商任务，不会重新生成。原调用费用仍以你的供应商账户账单为准。'
          : `原任务预授权已经退回。本次只复用原供应商任务，不会重新生成；恢复成功后按原授权${credits > 0 ? `最多${credits}积分` : '上限'}结算。`,
        okText: isPersonalApiUser(getUser()) ? '确认恢复' : '确认恢复并预授权',
        cancelText: '暂不恢复',
        onOk: runRecovery,
      });
      return;
    }
    await runRecovery();
  }, [applyPollResult, result, startPolling]);

  const currentStatus = salesVideoStatus(result);
  const voicedResult = result?.salesVideo || (result?.plan?.voiceMode === 'voiced' ? result.plan : null);
  const nativeAudioResult = voicedResult?.audioMode === 'provider_native';
  const resultDurationSeconds = salesVideoDuration(result);
  // The server authorizes preview independently from business approval. Do not
  // use private snapshot URLs to reconstruct a result it has not exposed.
  const previewUrl = [result?.previewUrl, result?.url].find(
    (url): url is string => typeof url === 'string' && url.startsWith('/uploads/'),
  );
  const durationQuotes: NativeVideoDurationQuote[] | null = Array.isArray(videoOptions?.durationOptions)
    ? videoOptions.durationOptions
        .filter(
          (option: any) => option && (Number(option.durationSeconds) === 15 || Number(option.durationSeconds) === 30),
        )
        .map((option: any) => ({
          durationSeconds: Number(option.durationSeconds) as 15 | 30,
          segmentCount: Number(option.segmentCount || (Number(option.durationSeconds) === 30 ? 2 : 1)),
          estimatedMaxCredits:
            option.estimatedMaxCredits != null && Number.isFinite(Number(option.estimatedMaxCredits))
              ? Number(option.estimatedMaxCredits)
              : undefined,
        }))
    : videoOptions?.estimatedMaxCredits != null && Number.isFinite(Number(videoOptions.estimatedMaxCredits))
      ? [
          {
            durationSeconds: (Number(videoOptions.durationSeconds ?? 15) === 30 ? 30 : 15) as 15 | 30,
            segmentCount: Number(videoOptions.durationSeconds ?? 15) === 30 ? 2 : 1,
            estimatedMaxCredits: Number(videoOptions.estimatedMaxCredits),
          },
        ]
      : null;
  const quote15 = durationQuotes?.find(item => item.durationSeconds === 15) || null;
  const quote30 = durationQuotes?.find(item => item.durationSeconds === 30) || null;
  const selectedQuote =
    videoOptions?.durationOptions?.find((option: any) => option.durationSeconds === durationSeconds) ||
    (Number(videoOptions?.durationSeconds ?? 15) === durationSeconds ? videoOptions : null);
  const partialResults =
    currentStatus !== 'success' && Array.isArray(voicedResult?.partialResults)
      ? voicedResult.partialResults.filter(
          (clip: any) =>
            [1, 2].includes(Number(clip.index)) &&
            typeof clip.url === 'string' &&
            clip.url.startsWith('/uploads/ai-sales-video/'),
        )
      : [];
  const awaitingBilling = currentStatus === 'success' && billingPending(result);
  const resultFirst = Boolean(result && (previewUrl || partialResults.length || result.downloadUrl));
  const historyRows: SpecialistHistoryRow[] = historyJobs.map(item => ({
    kind: 'media',
    id: Number(item.id),
    title: String(item.prompt || `带货视频任务 #${item.id}`),
    inputSummary: String(item.prompt || '未记录视频主题'),
    status: String(item.technicalStatus || item.status || '处理中'),
    createdAt: item.created_at || item.createdAt || null,
    active: Number(item.id) === Number(result?.jobId),
  }));
  const resultAlert = result && (
    <Alert
      type={
        awaitingBilling
          ? 'warning'
          : currentStatus === 'failed'
            ? 'error'
            : currentStatus === 'blocked'
              ? 'warning'
              : currentStatus === 'success'
                ? 'success'
                : 'info'
      }
      showIcon
      message={
        awaitingBilling
          ? '视频已生成，费用待核对'
          : currentStatus === 'success'
            ? '视频已生成，未自动发布'
            : currentStatus === 'failed'
              ? 'AI带货员成片失败'
              : currentStatus === 'blocked'
                ? '生成前检查未通过，尚未生成视频'
                : 'AI带货员已接单，后台生成中'
      }
      description={
        <div>
          {result.jobId && (
            <p>
              任务 #{result.jobId} · 目标时长{resultDurationSeconds}秒
            </p>
          )}
          <p>
            {(personalBilling && /积分|预授权|未扣费/.test(result.reason || '')
              ? '成片尚未完成，原任务记录已保留；上游费用以供应商账单为准。'
              : result.reason) ||
              (currentStatus === 'success'
                ? '先播放核对口播与字幕，再选择采纳或不采纳。'
                : currentStatus === 'failed'
                  ? personalBilling
                    ? '本次未形成可交付成片，上游费用以供应商账单为准。'
                    : result.billing?.state === 'released'
                      ? '本次未形成可交付成片，预授权已退回。'
                      : '本次未形成可交付成片，积分状态待对账。'
                  : '可关闭窗口，任务会继续在后台执行。')}
          </p>
          {voicedResult ? (
            <div>
              {currentStatus === 'processing' && (
                <div className="employee-execution-current" role="status">
                  <span>
                    {nativeAudioResult && voicedResult.stage === 'video'
                      ? '正在生成声音与画面'
                      : stageLabels[voicedResult.stage] || '正在等待任务进度'}
                  </span>
                </div>
              )}
              <details>
                <summary>查看详情</summary>
                <p>当前阶段：{stageLabels[voicedResult.stage] || '等待检查'}</p>
                {nativeAudioResult ? (
                  <>
                    <p>
                      声音由{salesVideoNativeModelLabel(result)}随画面生成；字幕按脚本时段排列，尚未做逐字语音对齐。
                    </p>
                    {voicedResult?.fallbackNotice && <p>{voicedResult.fallbackNotice}（按可灵实际价格计费）。</p>}
                  </>
                ) : (
                  <p>
                    历史任务音色：
                    {videoOptions?.voices?.find((voice: any) => voice.id === voicedResult.voiceId)?.label ||
                      voicedResult.voiceId ||
                      '未记录'}
                  </p>
                )}
                {getUser()?.role === 'platform_super' && (
                  <p>
                    已发起调用：文本 {voicedResult.calls?.text || 0} 次 · 配音 {voicedResult.calls?.tts || 0} 次 · 视频{' '}
                    {voicedResult.calls?.video || 0} 次
                  </p>
                )}
                <p>
                  音轨检查：{voicedResult.audioVerified ? '已检测到声音' : '尚未通过'}；字幕烧录：
                  {voicedResult.subtitlesBurnedIn ? '已核验' : '尚未核验'}。
                </p>
              </details>
              <p>
                账务：
                {personalBilling
                  ? personalApiBillingLabel(result.billing)
                  : result.billing?.state === 'settled'
                    ? `已结算 ${result.billing.chargedCredits ?? result.credits ?? 0} 积分`
                    : result.billing?.state === 'released'
                      ? '预授权已退回'
                      : result.billing?.state === 'not_held'
                        ? '未占扣'
                        : `预授权 ${result.billing?.heldCredits ?? result.billing?.estimatedCredits ?? 0} 积分${result.billing?.pendingReconciliation ? '，待对账' : ''}`}
              </p>
              {(voicedResult.script?.hook_3s || voicedResult.script?.cta) && (
                <p>
                  {voicedResult.script.hook_3s ? `前3秒钩子：${voicedResult.script.hook_3s}` : ''}
                  {voicedResult.script.hook_3s && voicedResult.script.cta ? ' · ' : ''}
                  {voicedResult.script.cta ? `行动邀请：${voicedResult.script.cta}` : ''}
                </p>
              )}
              {Array.isArray(voicedResult.scriptWarnings) && voicedResult.scriptWarnings.length > 0 && (
                <Alert
                  type={
                    voicedResult.scriptWarnings.some((line: string) => /红线|必改/u.test(line)) ? 'error' : 'warning'
                  }
                  showIcon
                  message={
                    voicedResult.scriptWarnings.some((line: string) => /红线|必改/u.test(line))
                      ? '发布前必改：口播命中平台红线'
                      : '发布前建议调整口播'
                  }
                  description={
                    <ul className="ai-sales-video-script-warnings" aria-label="口播发布前提醒">
                      {voicedResult.scriptWarnings.map((line: string) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  }
                />
              )}
              {!!voicedResult.script?.shots?.length && (
                <details>
                  <summary>查看中文口播稿</summary>
                  {voicedResult.script.shots.map((shot: any) => (
                    <p key={shot.index}>
                      {shot.start}–{shot.end}秒：{shot.voiceover}
                    </p>
                  ))}
                </details>
              )}
            </div>
          ) : (
            Array.isArray(result.plan?.segments) && (
              <details>
                <summary>查看详情</summary>
                <p>已规划 {result.plan.segments.length} 个镜头片段。</p>
                {getUser()?.role === 'platform_super' && <p>实际外部调用 {result.providerCalls || 0} 次。</p>}
              </details>
            )
          )}
          <Space wrap size={8}>
            {Number.isSafeInteger(Number(result.jobId)) && Number(result.jobId) > 0 && (
              <Button type="primary" size="small" href={`/tasks?kind=media&id=${result.jobId}`}>
                查看输入输出 · 采纳或不采纳
              </Button>
            )}
            <Button size="small" loading={polling} onClick={() => void refreshResult()}>
              刷新任务结果
            </Button>
            {result?.recovery?.available === true && (!voicedResult || videoOptions?.canRecover) && (
              <Button
                size="small"
                type="primary"
                loading={recovering}
                style={{ whiteSpace: 'normal', height: 'auto' }}
                onClick={() => void recoverExistingProviderTasks()}
              >
                复用原任务恢复成片（不重复生成）
              </Button>
            )}
            {currentStatus === 'processing' && <Tag color="processing">正在生成，可稍后查看</Tag>}
            {currentStatus === 'success' && (
              <Tag color="gold">{awaitingBilling ? '费用待核对，尚未业务验收' : '尚未业务验收'}</Tag>
            )}
            {currentStatus === 'failed' && (
              <Tag color={result.billing?.state === 'released' ? 'green' : 'orange'}>
                {personalBilling
                  ? personalApiBillingLabel(result.billing)
                  : result.billing?.state === 'released'
                    ? '预授权已退回'
                    : '积分待对账'}
              </Tag>
            )}
          </Space>
        </div>
      }
    />
  );

  const taskContent = (
    <>
      {videoOptions?.ready === true && (
        <section className="native-employee-video-compare" aria-label="视频时长与成本对比">
          <div className="native-employee-video-compare__header">
            <span className="native-employee-video-compare__title">视频时长与成本参考（默认推荐 15 秒试拍）</span>
            <Tag color={durationSeconds === 30 ? 'orange' : 'green'}>
              当前已选：{durationSeconds === 30 ? '30 秒（两段 · 高成本）' : '15 秒（推荐试拍）'}
            </Tag>
          </div>
          <div className="native-employee-video-compare__grid">
            <div
              className={`native-employee-video-compare__item${durationSeconds === 15 ? ' native-employee-video-compare__item--active' : ''}`}
            >
              <span className="native-employee-chat__duration-title">
                <span>15 秒（推荐试拍 · 更省成本）</span>
                <span className="native-employee-chat__duration-badge native-employee-chat__duration-badge--ok">
                  推荐
                </span>
              </span>
              <span className="native-employee-chat__duration-cost">
                {personalBilling
                  ? '一段完整口播 · 按个人 API 供应商账单计费'
                  : quote15?.estimatedMaxCredits != null
                    ? `参考预占 ${quote15.estimatedMaxCredits} 积分（≈ ¥${(quote15.estimatedMaxCredits * 0.01).toFixed(2)}）`
                    : '暂未提供 15 秒报价'}
              </span>
            </div>
            <div
              className={`native-employee-video-compare__item native-employee-video-compare__item--warn${durationSeconds === 30 ? ' native-employee-video-compare__item--active' : ''}`}
            >
              <span className="native-employee-chat__duration-title">
                <span>30 秒（完整口播 · 费用翻倍）</span>
                <span className="native-employee-chat__duration-badge native-employee-chat__duration-badge--warn">
                  费用翻倍
                </span>
              </span>
              <span className="native-employee-chat__duration-cost">
                {personalBilling
                  ? '两段视频拼接 · 上游费用约翻倍'
                  : quote30?.estimatedMaxCredits != null
                    ? `参考预占 ${quote30.estimatedMaxCredits} 积分（≈ ¥${(quote30.estimatedMaxCredits * 0.01).toFixed(2)}）`
                    : '暂未提供 30 秒报价'}
              </span>
            </div>
          </div>
          <p className="native-employee-video-compare__tip">
            日常高频测款建议优先使用小红书图文，成本约为视频的 1/10；确认生成前仍可在下方切换时长并审定口播脚本。
          </p>
        </section>
      )}
      <NativeEmployeeChat
        open={open}
        employeeIdx={10}
        canDispatch={canDispatch}
        generating={Boolean(result && currentStatus === 'processing')}
        onGeneration={openGeneratedJob}
        onVideoDurationChange={setDurationSeconds}
        videoDurationOptions={durationQuotes}
        mediaReady={videoOptions?.ready === true && selectedQuote != null}
        mediaQuote={
          personalBilling
            ? `${durationSeconds}秒视频。${PERSONAL_API_PRICING_NOTE}`
            : selectedQuote?.estimatedMaxCredits != null
              ? `${durationSeconds}秒视频参考预占 ${selectedQuote.estimatedMaxCredits} 积分（≈ ¥${(selectedQuote.estimatedMaxCredits * 0.01).toFixed(2)}）。按上游实际扣费结算，多退少补；余额不足时保留成片，补足余额后核对费用。`
              : undefined
        }
        initialText={presetBrief}
        resultFirst={resultFirst}
      >
        {(optionsError || (videoOptions && !videoOptions.ready)) && (
          <Alert
            type="warning"
            showIcon
            message={optionsError || '视频生成服务暂不可用，仍可先讨论脚本。'}
            description={videoOptions?.blockers?.map((reason: string) => (
              <p key={reason}>{reason}</p>
            ))}
          />
        )}
        {result && (
          <section
            className={`native-employee-result${resultFirst ? ' native-employee-result--first' : ''}`}
            aria-label="带货视频结果"
          >
            <header className="native-employee-result__header">
              <h3>视频结果</h3>
              <Space wrap>
                {previewUrl && (
                  <Button href={previewUrl} download>
                    下载视频
                  </Button>
                )}
                <NativeDeliverableDownloadButton
                  url={result.downloadUrl}
                  name={result.downloadName}
                  label="一键下载 ZIP"
                />
              </Space>
            </header>
            {previewUrl && (
              // The server-authorized video already contains its rendered subtitles.
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                aria-label="带货视频预览"
                controls
                playsInline
                preload="metadata"
                src={previewUrl}
                onError={() => setPreviewErrorUrl(previewUrl)}
                onLoadedData={() => setPreviewErrorUrl('')}
              />
            )}
            {previewUrl && voicedResult?.script && <SalesVideoPublishKit script={voicedResult.script} />}
            {previewUrl && previewErrorUrl === previewUrl && (
              <Alert type="warning" showIcon message="视频暂未加载，请刷新结果，或点击上方“下载视频”后播放。" />
            )}
            {!!partialResults.length && (
              <section className="native-employee-partials" aria-label="已取回的原始片段">
                {partialResults.map((clip: any) => (
                  <article key={`${clip.index}:${clip.url}`}>
                    <h4>已取回第{Number(clip.index)}段原始视频，完整成片尚未完成</h4>
                    {/* Provider source clips have no local caption sidecar. */}
                    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                    <video controls preload="metadata" src={clip.url} />
                    <p>
                      {Number.isFinite(Number(clip.durationSeconds)) && Number(clip.durationSeconds) > 0
                        ? `实际片长 ${Number(clip.durationSeconds)} 秒。`
                        : '这是原始片段。'}
                      {clip.subtitlesBurnedIn === false ? '此片段尚未添加本地字幕。' : ''}{' '}
                      未完成部分不会自动重新付费生成，费用仍按原任务记录核对。
                    </p>
                    <Button href={clip.url} download>
                      下载第{Number(clip.index)}段原片
                    </Button>
                  </article>
                ))}
              </section>
            )}
            {resultAlert}
          </section>
        )}
        <SpecialistTaskHistory
          title="带货视频生成历史"
          rows={historyRows}
          loading={historyLoading}
          error={historyError}
          onReload={loadSalesVideoHistory}
        />
      </NativeEmployeeChat>
    </>
  );

  return (
    <>
      {!embedded && result?.jobId && (
        <Alert
          style={{ marginBottom: 16 }}
          type={
            awaitingBilling
              ? 'warning'
              : currentStatus === 'failed'
                ? 'error'
                : currentStatus === 'blocked'
                  ? 'warning'
                  : currentStatus === 'success'
                    ? 'success'
                    : 'info'
          }
          showIcon
          message={
            awaitingBilling
              ? 'AI带货员：已成片，账务待核验'
              : currentStatus === 'success'
                ? 'AI带货员：技术成片已完成'
                : currentStatus === 'failed'
                  ? 'AI带货员：成片任务失败'
                  : currentStatus === 'blocked'
                    ? 'AI带货员：成片能力待开通'
                    : 'AI带货员：任务正在后台生成'
          }
          description={
            <Space wrap size={8}>
              <span>
                任务 #{result.jobId} ·{' '}
                {awaitingBilling
                  ? '费用待核对，已有结果保留'
                  : currentStatus === 'success'
                    ? '可预览和下载，未自动发布'
                    : result.reason || result.error || '可关闭窗口，后台会继续执行'}
              </span>
              <Button size="small" onClick={() => onOpenChange(true)}>
                查看任务结果
              </Button>
              <Button size="small" loading={polling} onClick={() => void refreshResult()}>
                刷新任务结果
              </Button>
            </Space>
          }
        />
      )}

      {embedded ? (
        <section className="ewb-native-skill" aria-label="带货视频技能">
          {taskContent}
        </section>
      ) : (
        <Modal open={open} title="AI带货员" width={880} footer={null} onCancel={() => onOpenChange(false)}>
          {taskContent}
        </Modal>
      )}
    </>
  );
}
