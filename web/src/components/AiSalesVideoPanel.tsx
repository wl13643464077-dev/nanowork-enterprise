import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Form, Input, Modal, Select, Space, Tag, message } from 'antd';
import { CloudUploadOutlined } from '@ant-design/icons';
import { notifyCredits, api } from '../api/client';

export type ReferenceImage = { id: string; name: string; url: string; size: number };

export const SALES_VIDEO_DEFAULT_MODEL = 'MiniMax-Hailuo-2.3';
const SALES_VIDEO_RESULT_STORAGE_KEY = 'nanowork.content.aiSalesVideo.last';

type SalesVideoStatus = 'processing' | 'success' | 'failed' | 'blocked';

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
    durationSeconds: Number(result.durationSeconds || 30),
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
    window.sessionStorage.setItem(SALES_VIDEO_RESULT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // 隐私模式或存储空间不足时，页面内状态仍然有效；不阻断任务。
  }
};

type AiSalesVideoPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialJobId?: number | null;
  refImgs: ReferenceImage[];
  setRefImgs: Dispatch<SetStateAction<ReferenceImage[]>>;
  onPickRef: (files: FileList | null) => void | Promise<void>;
  loadMaterials: () => void | Promise<unknown>;
  loadSummary: () => void | Promise<unknown>;
  loadMediaJobs: (kind: string, options?: { silent?: boolean }) => void | Promise<unknown>;
  onTaskSubmitted: () => void;
};

/**
 * AI 带货员的完整任务面板：上传、提交、后台轮询、会话恢复和结果验收提示均在这里闭环。
 * 参考图仍由 ContentFactory 持有，因为通用媒体创作也复用同一组图片。
 */
export default function AiSalesVideoPanel({
  open,
  onOpenChange,
  initialJobId = null,
  refImgs,
  setRefImgs,
  onPickRef,
  loadMaterials,
  loadSummary,
  loadMediaJobs,
  onTaskSubmitted,
}: AiSalesVideoPanelProps) {
  const [submitting, setSubmitting] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [polling, setPolling] = useState(false);
  const [form] = Form.useForm();
  const pollTimerRef = useRef<number | null>(null);
  const pollJobRef = useRef<number | null>(null);
  const pollUrlRef = useRef('');
  const pollAttemptsRef = useRef(0);
  const pollingActiveRef = useRef(false);
  const restoredResultRef = useRef(false);

  const clearPolling = useCallback(() => {
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
      const next = { ...(previous || {}), ...merged };
      persistSalesVideoResult(next);
      return next;
    });
    if (current?.billing?.balance !== undefined && current?.billing?.balance !== null) {
      notifyCredits(current.billing.balance);
    }
    return normalized;
  }, []);

  const startPolling = useCallback(
    (pollUrl: string, jobId: number) => {
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
      pollJobRef.current = safeJobId;
      pollUrlRef.current = safePollUrl;
      pollAttemptsRef.current = 0;
      pollingActiveRef.current = true;
      setPolling(true);

      const tick = async () => {
        if (pollJobRef.current !== safeJobId || pollUrlRef.current !== safePollUrl) return;
        pollAttemptsRef.current += 1;
        try {
          const current = await api.get(safePollUrl, { silent: true });
          const status = applyPollResult(current, safeJobId, safePollUrl);
          if (status !== 'processing') {
            clearPolling();
            if (status === 'success') {
              message.success('技术成片已完成，待管理层媒体验收/导入素材库；未自动发布');
              await Promise.all([loadMaterials(), loadSummary(), loadMediaJobs('video', { silent: true })]);
            } else if (status === 'failed') {
              message.error(
                `${current?.error || current?.reason || 'AI带货员成片失败'}；${
                  current?.billing?.state === 'released' ? '预授权已退回' : '积分待对账'
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
        if (pollJobRef.current !== safeJobId || pollUrlRef.current !== safePollUrl) return;
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
      if (status === 'processing') {
        startPolling(pollUrl, jobId);
        message.info('任务仍在后台生成，已继续轮询');
      } else if (status === 'success') {
        clearPolling();
        message.success('技术成片已完成，待管理层媒体验收/导入素材库；未自动发布');
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
    if (restoredResultRef.current) return;
    restoredResultRef.current = true;
    if (initialJobId) return;
    let saved: any = null;
    try {
      const raw = window.sessionStorage.getItem(SALES_VIDEO_RESULT_STORAGE_KEY);
      saved = raw ? JSON.parse(raw) : null;
    } catch {
      return;
    }
    if (!saved?.jobId) return;
    queueMicrotask(() => {
      setResult(saved);
      if (salesVideoStatus(saved) === 'processing' && saved.pollUrl) {
        startPolling(saved.pollUrl, Number(saved.jobId));
      }
    });
  }, [initialJobId, startPolling]);

  useEffect(() => {
    const jobId = Number(initialJobId);
    if (!open || !Number.isSafeInteger(jobId) || jobId < 1) return undefined;
    let cancelled = false;
    const pollUrl = `/content/media-jobs/${jobId}`;
    void api
      .get(pollUrl, { silent: true })
      .then((latest: any) => {
        if (cancelled) return;
        const status = applyPollResult(latest, jobId, pollUrl);
        if (status === 'processing') startPolling(pollUrl, jobId);
      })
      .catch(() => {
        if (!cancelled) message.error('带货任务详情加载失败，请稍后重试');
      });
    return () => {
      cancelled = true;
    };
  }, [applyPollResult, initialJobId, open, startPolling]);

  useEffect(() => () => clearPolling(), [clearPolling]);

  const submit = async () => {
    try {
      if (pollJobRef.current !== null || (result && salesVideoStatus(result) === 'processing')) {
        message.info('已有一条带货任务正在后台生成，请查看任务结果；系统不会重复提交');
        return;
      }
      const values = await form.validateFields();
      if (!refImgs.length) {
        message.error('请至少上传一张人物、菜品/商品或门店图片');
        return;
      }
      setSubmitting(true);
      setResult(null);
      const response = await api.post('/content/ai-sales-video', {
        brief: values.brief,
        model: values.model || SALES_VIDEO_DEFAULT_MODEL,
        referenceImages: refImgs.map(image => image.url),
      });
      const jobId = Number(response?.jobId);
      const pollUrl = String(response?.pollUrl || (jobId ? `/content/media-jobs/${jobId}` : '')).trim();
      const normalizedStatus = salesVideoStatus(response);
      const nextResult = {
        ...response,
        ...(jobId ? { jobId } : {}),
        ...(pollUrl ? { pollUrl } : {}),
        status: normalizedStatus,
        technicalStatus:
          response?.technicalStatus ||
          (normalizedStatus === 'success' ? '成功' : normalizedStatus === 'blocked' ? '阻塞' : '处理中'),
      };
      setResult(nextResult);
      persistSalesVideoResult(nextResult);
      onTaskSubmitted();
      void loadMaterials();
      if (normalizedStatus === 'blocked') {
        message.info('30秒脚本与分镜已建立；视频供应商待开通或待付费授权');
      } else if (normalizedStatus === 'processing' && jobId && pollUrl) {
        startPolling(pollUrl, jobId);
        message.success('AI带货员已接单，任务在后台生成；可关闭窗口后再查看结果');
      } else {
        message.success('AI带货员任务已返回，请查看任务结果');
      }
    } catch (error: any) {
      if (error?.errorFields) return;
      message.error(error?.message || 'AI带货员派活失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

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
        if (response?.billing?.balance !== undefined) notifyCredits(response.billing.balance);
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
        title: '确认恢复这条30秒成片？',
        content: `原任务预授权已经退回。本次只复用原供应商任务，不会重新生成；恢复成功后按原授权${credits > 0 ? `最多${credits}积分` : '上限'}结算。`,
        okText: '确认恢复并预授权',
        cancelText: '暂不恢复',
        onOk: runRecovery,
      });
      return;
    }
    await runRecovery();
  }, [applyPollResult, result, startPolling]);

  const currentStatus = salesVideoStatus(result);
  const resultAlert = result && (
    <Alert
      type={
        currentStatus === 'failed'
          ? 'error'
          : currentStatus === 'blocked'
            ? 'warning'
            : currentStatus === 'success'
              ? 'success'
              : 'info'
      }
      showIcon
      message={
        currentStatus === 'success'
          ? '技术成片已完成，待管理层媒体验收/导入素材库；未自动发布'
          : currentStatus === 'failed'
            ? 'AI带货员成片失败'
            : currentStatus === 'blocked'
              ? '脚本与分镜已建立，成片能力待开通'
              : 'AI带货员已接单，后台生成中'
      }
      description={
        <div>
          {result.jobId && <p>任务 #{result.jobId} · 目标时长30秒</p>}
          <p>
            {result.reason ||
              (currentStatus === 'success'
                ? '成片只进入管理层媒体验收区，不会自动发布。'
                : currentStatus === 'failed'
                  ? result.billing?.state === 'released'
                    ? '本次未形成可交付成片，预授权已退回。'
                    : '本次未形成可交付成片，积分状态待对账。'
                  : '可关闭窗口，任务会继续在后台执行。')}
          </p>
          {Array.isArray(result.plan?.segments) && (
            <p>
              已规划 {result.plan.segments.length} 个镜头片段；实际外部调用 {result.providerCalls || 0} 次。
            </p>
          )}
          <Space wrap size={8}>
            <Button size="small" loading={polling} onClick={() => void refreshResult()}>
              刷新任务结果
            </Button>
            {result?.recovery?.available === true && (
              <Button
                size="small"
                type="primary"
                loading={recovering}
                onClick={() => void recoverExistingProviderTasks()}
              >
                复用原任务恢复成片（不重复生成）
              </Button>
            )}
            {currentStatus === 'processing' && <Tag color="processing">后台轮询中，不会重复提交</Tag>}
            {currentStatus === 'success' && <Tag color="gold">待管理层验收 / 导入素材库</Tag>}
            {currentStatus === 'failed' && (
              <Tag color={result.billing?.state === 'released' ? 'green' : 'orange'}>
                {result.billing?.state === 'released' ? '预授权已退回' : '积分待对账'}
              </Tag>
            )}
          </Space>
        </div>
      }
    />
  );

  return (
    <>
      {result?.jobId && (
        <Alert
          style={{ marginBottom: 16 }}
          type={
            currentStatus === 'failed'
              ? 'error'
              : currentStatus === 'blocked'
                ? 'warning'
                : currentStatus === 'success'
                  ? 'success'
                  : 'info'
          }
          showIcon
          message={
            currentStatus === 'success'
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
                {currentStatus === 'success'
                  ? '待管理层媒体验收/导入素材库，未自动发布'
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

      <Modal
        open={open}
        title="AI带货员 · 30秒带货视频"
        width={720}
        okText="开始工作"
        cancelText="关闭"
        confirmLoading={submitting}
        okButtonProps={{ disabled: Boolean(result && currentStatus === 'processing') }}
        onOk={submit}
        onCancel={() => onOpenChange(false)}
      >
        <Alert
          type="info"
          showIcon
          message="你只管说要卖什么，其余交给数字员工"
          description="上传人物、菜品/商品或门店图片，再写一句目标。AI带货员会自动完成事实整理、30秒口播、分镜、字幕和视频任务；缺少付费授权时会停在待开通，不会伪造视频。"
          style={{ marginBottom: 16 }}
        />
        <Form form={form} layout="vertical" initialValues={{ model: SALES_VIDEO_DEFAULT_MODEL }}>
          <Form.Item
            name="brief"
            label="这次要卖什么？"
            rules={[
              { required: true, message: '请用一句话告诉AI带货员这次要解决什么' },
              { min: 4, message: '再多说一点目标或卖点，至少4个字' },
              { max: 2000, message: '任务目标最多2000字' },
            ]}
          >
            <Input.TextArea
              rows={4}
              showCount
              maxLength={2000}
              placeholder="例如：用这组招牌菜和门头照片，做一条30秒视频，吸引附近家庭周末到店"
            />
          </Form.Item>
          <Form.Item label="真实图片（至少1张，最多6张）" required>
            <label className="content-reference-upload" htmlFor="ai-sales-reference-images">
              <CloudUploadOutlined />
              <span>{refImgs.length ? `继续添加（已选${refImgs.length}张）` : '上传人物、菜品/商品或门店图片'}</span>
              <input
                id="ai-sales-reference-images"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                onChange={event => {
                  void onPickRef(event.target.files);
                  event.currentTarget.value = '';
                }}
              />
            </label>
            {refImgs.length > 0 && (
              <div className="content-reference-grid" aria-label="AI带货员参考图片">
                {refImgs.map((image, index) => (
                  <figure key={image.id}>
                    <img src={image.url} alt={image.name} />
                    <figcaption>
                      {index === 0 ? '主画面 · ' : ''}
                      {image.name}
                    </figcaption>
                    <button
                      type="button"
                      aria-label={`移除${image.name}`}
                      onClick={() => setRefImgs(current => current.filter(item => item.id !== image.id))}
                    >
                      ×
                    </button>
                  </figure>
                ))}
              </div>
            )}
          </Form.Item>
          <Form.Item name="model" label="视频模型">
            <Select
              options={[
                { value: 'MiniMax-Hailuo-2.3', label: 'Hailuo 2.3 · 质量优先' },
                { value: 'MiniMax-H3', label: 'MiniMax H3 · 最新多模态（需官方API密钥与后台双核验）' },
              ]}
            />
          </Form.Item>
        </Form>
        {resultAlert}
      </Modal>
    </>
  );
}
