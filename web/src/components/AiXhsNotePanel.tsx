import { isPersonalApiUser, personalApiBillingLabel, PERSONAL_API_PRICING_NOTE } from './personalApiBilling.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Form, Input, Modal, Space, Tag, Typography, message } from 'antd';
import { CopyOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, notifyCredits, getUser } from '../api/client';
import type { UploadedFileRef } from './UnifiedFilePicker';
import NativeEmployeeChat, { type NativeGeneration, type NativeImageOptions } from './NativeEmployeeChat';
import NativeDeliverableDownloadButton from './NativeDeliverableDownloadButton';
import SpecialistTaskHistory, { type SpecialistHistoryRow } from './SpecialistTaskHistory';
import './AiXhsNotePanel.css';

type NoteOutput = {
  title: string;
  titleOptions?: string[];
  sellingPoints?: string[];
  body: string;
  tags: string[];
  firstComment: string;
  imagePlan: Array<{ fileId: number; caption: string }>;
  warnings?: string[];
  compliance?: {
    level: 'none' | 'warn' | 'block';
    blocked: boolean;
    hits: Array<{ group: string; label: string; severity: 'block' | 'warn'; words: string[]; suggestion: string }>;
  };
};
type NoteBilling = {
  state?: string;
  chargedCredits?: number;
  heldCredits?: number;
  balance?: number;
  note?: string;
};
type NoteImage = {
  id: string;
  role?: string;
  label: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  url?: string;
  fileId?: number;
  mediaJobId?: number;
  error?: string;
  warning?: string | null;
  originalUrl?: string | null;
  canRetry?: boolean;
  canRecover?: boolean;
  aiGenerated?: boolean;
  billing?: NoteBilling | null;
};
type NoteImageOptions = NativeImageOptions & {
  imageModel: string;
  imageCount: number;
  creditsPerImage: number;
  imageTotalCredits: number;
  textBilling: 'actual_usage';
  available: boolean;
  reason?: string | null;
};
type NoteJob = {
  id: number;
  status: 'running' | 'success' | 'failed';
  title?: string;
  brandName?: string;
  brief?: string;
  includeDiner?: boolean;
  generateImages?: boolean;
  canRetry?: boolean;
  downloadUrl?: string;
  downloadName?: string;
  imageCount?: number;
  output?: NoteOutput | null;
  files?: UploadedFileRef[];
  fileIds?: number[];
  error?: string;
  decision?: 'pending' | 'adopted' | 'rejected';
  createdAt?: string;
  billing?: NoteBilling | null;
  imageGeneration?: {
    model?: string;
    status: 'pending' | 'running' | 'success' | 'partial' | 'failed' | 'disabled';
    items: NoteImage[];
    completedCount?: number;
    failedCount?: number;
  } | null;
};

const isJobRunning = (job: NoteJob) =>
  job.status === 'running' || ['pending', 'running'].includes(job.imageGeneration?.status || '');
const tagText = (tags?: string[]) => (tags || []).map(tag => `#${String(tag).replace(/^#+/, '')}`).join(' ');
const noteText = (output: NoteOutput) =>
  `${output.title}\n\n${output.body}\n\n${tagText(output.tags)}\n\n评论区首评：\n${output.firstComment}`;
const imageBillingText = (billing?: NoteBilling | null, personal = false) => {
  if (personal) return personalApiBillingLabel(billing || {});
  if (!billing) return '';
  if (billing.state === 'settled')
    return billing.chargedCredits != null ? `本图费用：${billing.chargedCredits} 积分` : '本图费用已结算，金额未返回';
  if (billing.state === 'released') return '本图预授权已退回';
  if (billing.state === 'held')
    return billing.heldCredits != null ? `本图预授权：${billing.heldCredits} 积分` : '本图已预授权，待结算';
  return billing.note || '本图费用待核对';
};

export default function AiXhsNotePanel({
  open,
  embedded = false,
  canDispatch = true,
  onOpenChange,
}: {
  open: boolean;
  embedded?: boolean;
  canDispatch?: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const personalBilling = isPersonalApiUser(getUser());
  const [loading, setLoading] = useState(false);
  const [retryingImages, setRetryingImages] = useState(false);
  const [recoveringImages, setRecoveringImages] = useState(false);
  const [jobs, setJobs] = useState<NoteJob[]>([]);
  const [job, setJob] = useState<NoteJob | null>(null);
  const [draft, setDraft] = useState<NoteOutput | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [error, setError] = useState('');
  const [copyFallback, setCopyFallback] = useState('');
  const [imageOptions, setImageOptions] = useState<NoteImageOptions | null>(null);
  const [imageOptionsError, setImageOptionsError] = useState('');
  const [optionsRefreshSerial, setOptionsRefreshSerial] = useState(0);
  const [jobsRefreshSerial, setJobsRefreshSerial] = useState(0);
  const retryingImagesRef = useRef(false);
  const recoveringImagesRef = useRef(false);
  const imageMutationEpoch = useRef(0);
  const selectedId = useRef<number | null>(null);
  const draftSourceId = useRef<number | null>(null);
  const jobId = job?.id;
  const jobStatus = job?.status;
  const imageStatus = job?.imageGeneration?.status;
  const imageQuoteReady =
    imageOptions?.available === true &&
    Number.isFinite(imageOptions.creditsPerImage) &&
    Number.isFinite(imageOptions.imageTotalCredits);
  const retryBlocked = job?.canRetry === false;

  const receiveJob = useCallback((next: NoteJob, resetDraft = true) => {
    selectedId.current = next.id;
    setJob(next);
    if (resetDraft) {
      setDraft(next.output || null);
      setTagInput(tagText(next.output?.tags));
      draftSourceId.current = next.output ? next.id : null;
    }
    setJobs(current => [next, ...current.filter(item => item.id !== next.id)]);
    if (next.billing?.balance != null) notifyCredits(next.billing.balance);
  }, []);

  useEffect(() => {
    const epoch = ++imageMutationEpoch.current;
    if (open)
      queueMicrotask(() => {
        if (imageMutationEpoch.current !== epoch) return;
        recoveringImagesRef.current = false;
        retryingImagesRef.current = false;
        setRecoveringImages(false);
        setRetryingImages(false);
      });
    return () => {
      imageMutationEpoch.current += 1;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setImageOptions(null);
      setImageOptionsError('');
    });
    void api
      .get('/content/ai-xhs-note/options', { silent: true })
      .then((next: NoteImageOptions) => {
        if (!cancelled) setImageOptions(next);
      })
      .catch(() => {
        if (!cancelled) setImageOptionsError('配图价格暂未读取，仍可讨论文案；确认出图前请刷新价格。');
      });
    return () => {
      cancelled = true;
    };
  }, [open, optionsRefreshSerial]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const initialSelection = selectedId.current;
    queueMicrotask(() => {
      if (!cancelled) setLoading(true);
    });
    void api
      .get('/content/ai-xhs-note/jobs', { silent: true })
      .then((data: NoteJob[] | { jobs: NoteJob[] }) => {
        if (cancelled || selectedId.current !== initialSelection) return;
        const rows = Array.isArray(data) ? data : data.jobs || [];
        setJobs(rows);
        const next = rows.find(item => item.id === selectedId.current) || rows.find(isJobRunning) || rows[0];
        if (next) receiveJob(next, next.id !== draftSourceId.current || next.status !== 'success');
        else {
          selectedId.current = null;
          draftSourceId.current = null;
          setJob(null);
          setDraft(null);
          setTagInput('');
        }
        setError('');
      })
      .catch(() => {
        if (!cancelled) setError('小红书生成历史暂时没有载入，当前对话和已有结果不受影响。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [jobsRefreshSerial, open, receiveJob]);

  useEffect(() => {
    if (!open || !jobId || (jobStatus !== 'running' && !['pending', 'running'].includes(imageStatus || ''))) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = (await api.get(`/content/ai-xhs-note/jobs/${jobId}`, { silent: true })) as NoteJob;
        if (cancelled || selectedId.current !== jobId) return;
        receiveJob(next, next.id !== draftSourceId.current);
        setError('');
        if (!isJobRunning(next)) return;
      } catch {
        if (cancelled) return;
        setError('暂时未能取得最新进度，正在继续查询；已有任务不会重复提交。');
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 4000);
    };
    timer = window.setTimeout(() => void poll(), 2000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, jobId, jobStatus, imageStatus, receiveJob]);

  const openGeneratedJob = useCallback(
    (generation: NativeGeneration) => {
      if (generation.kind !== 'xhs' || !Number.isSafeInteger(generation.jobId)) return;
      const id = generation.jobId;
      selectedId.current = id;
      void api
        .get(`/content/ai-xhs-note/jobs/${id}`, { silent: true })
        .then((next: NoteJob) => {
          if (selectedId.current === id) receiveJob(next);
        })
        .catch(() => setError('图文任务已提交，结果暂未取得；可到任务中心刷新查看。'));
    },
    [receiveJob],
  );

  const retryFailedImages = async () => {
    if (!open || !job || !canDispatch || retryingImagesRef.current || recoveringImagesRef.current || isJobRunning(job))
      return;
    const imageIds = (job.imageGeneration?.items || [])
      .filter(item => item.status === 'failed' && item.canRetry === true)
      .map(item => item.id);
    if (!imageIds.length) return;
    retryingImagesRef.current = true;
    setRetryingImages(true);
    const epoch = imageMutationEpoch.current;
    const id = job.id;
    try {
      const next = (await api.post(
        `/content/ai-xhs-note/jobs/${job.id}/retry-images`,
        { imageIds },
        { silent: true },
      )) as NoteJob;
      if (epoch !== imageMutationEpoch.current || selectedId.current !== id) return;
      receiveJob(next, false);
      setError('');
      message.success('已开始补齐失败配图，已有文案和成功图片保持不变。');
    } catch (err: any) {
      if (epoch === imageMutationEpoch.current && selectedId.current === id)
        setError(err?.message || '配图重试未能确认，请先刷新任务查看，不要重复提交。');
    } finally {
      if (epoch === imageMutationEpoch.current) {
        retryingImagesRef.current = false;
        setRetryingImages(false);
      }
    }
  };

  const recoverImages = async () => {
    if (
      !open ||
      !job ||
      !canDispatch ||
      loading ||
      recoveringImagesRef.current ||
      retryingImagesRef.current ||
      isJobRunning(job)
    )
      return;
    const imageIds = (job.imageGeneration?.items || []).filter(item => item.canRecover === true).map(item => item.id);
    if (!imageIds.length) return;
    const epoch = imageMutationEpoch.current;
    const id = job.id;
    recoveringImagesRef.current = true;
    setRecoveringImages(true);
    try {
      const next = (await api.post(
        `/content/ai-xhs-note/jobs/${id}/recover-images`,
        { imageIds },
        { silent: true },
      )) as NoteJob;
      if (epoch !== imageMutationEpoch.current || selectedId.current !== id) return;
      if (next.id !== id) throw new Error('取回回执未能核对，请刷新任务查看。');
      receiveJob(next, false);
      setError('');
      message.success('已提交取回请求，已有文案与图片会保留。');
    } catch (failure) {
      if (epoch === imageMutationEpoch.current && selectedId.current === id)
        setError(failure instanceof Error ? failure.message : '原图片暂未取回，请刷新任务核对。');
    } finally {
      if (epoch === imageMutationEpoch.current) {
        recoveringImagesRef.current = false;
        setRecoveringImages(false);
      }
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      message.success('已复制');
    } catch {
      setCopyFallback(value);
    }
  };

  const downloadText = () => {
    if (!draft) return;
    const url = URL.createObjectURL(new Blob([noteText(draft)], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(job?.brandName || '小红书').replace(/[\\/:*?"<>|]/g, '_')}-图文发布包.txt`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const updateDraft = (key: keyof Pick<NoteOutput, 'title' | 'body' | 'firstComment'>, value: string) =>
    setDraft(current => (current ? { ...current, [key]: value } : current));
  const saveXhsBusinessDecision = useCallback(
    async (row: SpecialistHistoryRow, decision: 'adopt' | 'reject') => {
      const isCurrent = Number(row.id) === Number(job?.id);
      const next = (await api.post(
        `/content/ai-xhs-note/jobs/${row.id}/decision`,
        {
          decision: decision === 'adopt' ? 'adopted' : 'rejected',
          ...(isCurrent && draft ? { output: draft } : {}),
        },
        { silent: true },
      )) as NoteJob;
      setJobs(current => [next, ...current.filter(item => item.id !== next.id)]);
      if (selectedId.current === next.id) {
        setJob(next);
        setDraft(next.output || null);
        setTagInput(tagText(next.output?.tags));
        draftSourceId.current = next.output ? next.id : null;
      }
      if (next.billing?.balance != null) notifyCredits(next.billing.balance);
      return next;
    },
    [draft, job?.id],
  );
  const resultFiles = job?.files || [];
  const generatedImages = job?.imageGeneration?.items || [];
  const retryableImages = generatedImages.filter(item => item.status === 'failed' && item.canRetry === true);
  const recoverableImages = generatedImages.filter(item => item.canRecover === true);
  const historyRows: SpecialistHistoryRow[] = jobs.map(item => ({
    kind: 'generated_content',
    id: Number(item.id),
    title: String(item.output?.title || item.title || `${item.brandName || '小红书'}种草任务`),
    inputSummary: [item.brandName, item.brief].filter(Boolean).join(' · ') || '未记录种草主题',
    status: String(item.status || 'running'),
    createdAt: item.createdAt || null,
    active: Number(item.id) === Number(job?.id),
    businessDecision: item.decision || 'pending',
  }));

  const content = (
    <>
      <div className="ai-xhs-note-panel">
        <NativeEmployeeChat
          open={open}
          employeeIdx={11}
          canDispatch={canDispatch}
          generating={loading || retryingImages || recoveringImages || jobs.some(isJobRunning)}
          onGeneration={openGeneratedJob}
          imageOptions={imageOptions}
          mediaReady={imageQuoteReady}
        >
          {(imageOptionsError || (imageOptions && !imageOptions.available)) && (
            <Alert
              type="warning"
              showIcon
              message={imageOptionsError || imageOptions?.reason || '配图服务暂不可用，仍可讨论文案。'}
              action={
                <Button size="small" onClick={() => setOptionsRefreshSerial(value => value + 1)}>
                  刷新配图价格
                </Button>
              }
            />
          )}
          {draft && (
            <section className="ai-xhs-note-result" aria-label="小红书图文发布包">
              <header>
                <div>
                  <Typography.Title level={5}>图文发布包</Typography.Title>
                  <span>
                    这是已确认方案的生成结果。可以打包下载、复制文案；需要改方案时继续在上面对话。此处手动修改供复制下载，任务中心保留已保存的原稿。
                  </span>
                </div>
                <Space wrap>
                  <NativeDeliverableDownloadButton url={job?.downloadUrl} name={job?.downloadName} />
                  <Button icon={<CopyOutlined />} onClick={() => void copy(noteText(draft))}>
                    整体复制
                  </Button>
                  <Button icon={<DownloadOutlined />} onClick={downloadText}>
                    保存文案
                  </Button>
                </Space>
              </header>
              {!!generatedImages.length && (
                <section aria-label="AI生成配图">
                  <p className="ai-xhs-note-billing">
                    AI 创意配图{personalBilling ? ` · ${PERSONAL_API_PRICING_NOTE}` : ''}
                  </p>
                  <div className="ai-xhs-note-images">
                    {generatedImages.map((image, index) => {
                      const url =
                        image.status === 'success' && image.url?.startsWith('/uploads/') ? image.url : undefined;
                      return (
                        <figure key={image.id}>
                          {url ? (
                            <img src={url} alt={image.label || `AI配图 ${index + 1}`} />
                          ) : (
                            <div className="ai-xhs-note-image-placeholder" role="status">
                              {image.status === 'failed'
                                ? '这张配图未完成'
                                : image.status === 'success'
                                  ? '图片地址暂未返回'
                                  : image.status === 'running'
                                    ? '正在生成配图'
                                    : '等待生成'}
                            </div>
                          )}
                          <figcaption>
                            <strong>
                              {image.label || ['封面', '菜品特写', '用餐氛围'][index] || `配图 ${index + 1}`}
                            </strong>
                            {url && (
                              <p>
                                <a href={url} download target="_blank" rel="noreferrer">
                                  下载这张图
                                </a>
                              </p>
                            )}
                            {image.warning && <p>{image.warning}</p>}
                            {image.status === 'failed' && (
                              <p>
                                {(personalBilling && /积分|预授权|未扣费/.test(image.error || '')
                                  ? '这张图片尚未完成，已有内容保留；上游费用以供应商账单为准。'
                                  : image.error) ||
                                  (image.canRetry
                                    ? '可单独重试，已有结果会保留。'
                                    : '请先核对这张图的费用与任务记录。')}
                              </p>
                            )}
                            {image.status === 'failed' && image.canRetry === false && (
                              <p>
                                {image.canRecover
                                  ? '可取回已生成的原结果，无需重新生成。'
                                  : '暂不可重试，请先核对这张图的任务与费用。'}
                              </p>
                            )}
                            {!!imageBillingText(image.billing, personalBilling) && (
                              <p>{imageBillingText(image.billing, personalBilling)}</p>
                            )}
                          </figcaption>
                        </figure>
                      );
                    })}
                  </div>
                  {job?.includeDiner && <p className="ai-xhs-note-billing">用餐人物为 AI 创意形象，不代表真实顾客。</p>}
                  {!!retryableImages.length && (
                    <Button
                      icon={<ReloadOutlined />}
                      loading={retryingImages}
                      disabled={!canDispatch || recoveringImages || !!(job && isJobRunning(job))}
                      onClick={() => void retryFailedImages()}
                    >
                      只重试失败的 {retryableImages.length} 张图
                    </Button>
                  )}
                  {!!recoverableImages.length && (
                    <div>
                      <Button
                        icon={<ReloadOutlined />}
                        loading={recoveringImages}
                        disabled={!canDispatch || loading || retryingImages || !!(job && isJobRunning(job))}
                        onClick={() => void recoverImages()}
                      >
                        取回已生成图片
                      </Button>
                      <p className="ai-xhs-note-billing">
                        {personalBilling
                          ? `复用原任务，不重新生成；已有文案和成功图片保留，上游费用以原供应商账单为准。`
                          : '复用原任务，不重新生成；沿用原预授权核对结算，已有文案和成功图片会保留。'}
                      </p>
                    </div>
                  )}
                </section>
              )}
              {draft.compliance && draft.compliance.hits.length > 0 && (
                <Alert
                  type={draft.compliance.blocked ? 'error' : 'warning'}
                  showIcon
                  message={
                    draft.compliance.blocked
                      ? '发布前必改：命中平台红线词（限流/广告法风险）'
                      : '建议调整：有平台软风险表述'
                  }
                  description={
                    <ul className="ai-xhs-note-compliance">
                      {draft.compliance.hits.map(hit => (
                        <li key={hit.group}>
                          <strong>{hit.severity === 'block' ? '必改' : '建议'} · {hit.label}</strong>：
                          {hit.words.map(word => (
                            <Tag key={word} color={hit.severity === 'block' ? 'red' : 'orange'}>
                              {word}
                            </Tag>
                          ))}
                          <span>{hit.suggestion}</span>
                        </li>
                      ))}
                    </ul>
                  }
                />
              )}
              {(!!draft.titleOptions?.length || !!draft.sellingPoints?.length) && (
                <section className="ai-xhs-note-commercial" aria-label="备选标题与卖点">
                  {!!draft.titleOptions?.length && (
                    <div>
                      <span className="ai-xhs-note-field-label">备选标题（点一下替换）</span>
                      <div className="ai-xhs-note-title-options">
                        {draft.titleOptions.map(option => (
                          <Button key={option} size="small" onClick={() => updateDraft('title', option)}>
                            {option}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                  {!!draft.sellingPoints?.length && (
                    <div>
                      <span className="ai-xhs-note-field-label">本篇卖点（来自你确认的事实，可复用到其他平台）</span>
                      <ul className="ai-xhs-note-selling-points">
                        {draft.sellingPoints.map(point => (
                          <li key={point}>{point}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              )}
              {!!draft.warnings?.length && (
                <Alert
                  type="info"
                  showIcon
                  message="结果已生成，有优化建议"
                  description={
                    <ul>
                      {draft.warnings.map((warning, i) => (
                        <li key={i}>{warning}</li>
                      ))}
                    </ul>
                  }
                />
              )}
              {job?.billing && (
                <p className="ai-xhs-note-billing">
                  {personalBilling
                    ? personalApiBillingLabel(job.billing)
                    : job.billing.state === 'settled'
                      ? `文案费用${job.billing.chargedCredits != null ? `：${job.billing.chargedCredits} 积分` : '已结算'}`
                      : job.billing.note || '文案已保留，费用待核对。'}
                </p>
              )}
              <Form layout="vertical">
                {(
                  [
                    ['title', '标题', 1],
                    ['body', '正文', 7],
                    ['firstComment', '评论区首评', 2],
                  ] as const
                ).map(([key, label, minRows]) => (
                  <Form.Item
                    key={key}
                    label={
                      <span className="ai-xhs-note-field-label">
                        {label}
                        <Button
                          type="text"
                          size="small"
                          aria-label={`复制${label}`}
                          icon={<CopyOutlined />}
                          onClick={() => void copy(draft[key])}
                        >
                          复制
                        </Button>
                      </span>
                    }
                  >
                    <Input.TextArea
                      aria-label={label}
                      value={draft[key]}
                      onChange={event => updateDraft(key, event.target.value)}
                      autoSize={{ minRows, maxRows: 24 }}
                    />
                  </Form.Item>
                ))}
                <Form.Item
                  label={
                    <span className="ai-xhs-note-field-label">
                      话题标签
                      <Button
                        type="text"
                        size="small"
                        aria-label="复制标签"
                        icon={<CopyOutlined />}
                        onClick={() => void copy(tagText(draft.tags))}
                      >
                        复制
                      </Button>
                    </span>
                  }
                >
                  <Input
                    aria-label="标签"
                    value={tagInput}
                    onChange={event => {
                      setTagInput(event.target.value);
                      setDraft(current =>
                        current ? { ...current, tags: event.target.value.split(/[\s#]+/).filter(Boolean) } : current,
                      );
                    }}
                  />
                </Form.Item>
              </Form>
              {(!!draft.imagePlan?.length || !!job?.imageGeneration) && (
                <details className="ai-xhs-note-details">
                  <summary>查看原始照片与生成记录</summary>
                  {job?.imageGeneration?.model && (
                    <p>
                      配图模型：{job.imageGeneration.model} · 任务 #{job.id}
                    </p>
                  )}
                  {generatedImages.map(image =>
                    image.originalUrl?.startsWith('/uploads/') && image.originalUrl !== image.url ? (
                      <p key={image.id}>
                        <a href={image.originalUrl} download target="_blank" rel="noreferrer">
                          下载{image.label}的 Image2 原图
                        </a>
                      </p>
                    ) : null,
                  )}
                  <p>以下是上传原图与配图建议，供核对菜品、门店和品牌事实。</p>
                  <div className="ai-xhs-note-images" aria-label="配图顺序">
                    {(draft.imagePlan || []).map((plan, index) => {
                      const file = resultFiles.find(item => item.id === Number(plan.fileId));
                      const url = file?.file_url?.startsWith('/uploads/') ? file.file_url : undefined;
                      return (
                        <figure key={`${plan.fileId}-${index}`}>
                          {url && <img src={url} alt={file?.name || `配图 ${index + 1}`} />}
                          <figcaption>
                            <strong>
                              第 {index + 1} 张{index === 0 ? ' · 封面' : ''}
                            </strong>
                            <p>{plan.caption}</p>
                            {url ? (
                              <a href={url} download={file?.name} target="_blank" rel="noreferrer">
                                保存原图
                              </a>
                            ) : (
                              <span>{file?.name || `已上传照片 #${plan.fileId}`}</span>
                            )}
                          </figcaption>
                        </figure>
                      );
                    })}
                  </div>
                </details>
              )}
              <Space wrap>
                <Tag color={job?.decision === 'adopted' ? 'green' : job?.decision === 'rejected' ? 'default' : 'blue'}>
                  {job?.decision === 'adopted' ? '已采纳' : job?.decision === 'rejected' ? '未采纳' : '待你选择'}
                </Tag>
                <span className="ai-xhs-note-billing">在下方生成历史中展开本条，可直接采纳或不采纳。</span>
              </Space>
            </section>
          )}
          {error && <Alert type="warning" showIcon message={error} />}
          {retryBlocked && (
            <Alert
              type="warning"
              showIcon
              message="这条任务费用待核对，请先核对费用后重试。"
              description="已生成的文案仍可查看和复制。可到任务中心核对原任务与费用。"
            />
          )}
          {job && isJobRunning(job) && (
            <Alert
              type="info"
              showIcon
              message={job.status === 'running' ? '正在根据照片生成文案' : '文案已生成，正在制作配图'}
              description="已有结果可先查看和复制。关闭窗口后任务继续执行，稍后打开即可查看。"
            />
          )}
          {job?.status === 'failed' && (
            <Alert
              type="error"
              showIcon
              message="本次图文未能完整生成"
              description={job.error || '请检查任务记录后重试。'}
            />
          )}
          <SpecialistTaskHistory
            title="小红书图文生成历史"
            rows={historyRows}
            loading={loading}
            onReload={() => setJobsRefreshSerial(value => value + 1)}
            onBusinessDecision={saveXhsBusinessDecision}
          />
        </NativeEmployeeChat>
      </div>
      <Modal title="请选择下方文字并复制" open={!!copyFallback} footer={null} onCancel={() => setCopyFallback('')}>
        <Input.TextArea
          value={copyFallback}
          readOnly
          autoSize={{ minRows: 8, maxRows: 24 }}
          onFocus={event => event.target.select()}
        />
      </Modal>
    </>
  );
  return embedded ? (
    <section className="ewb-native-skill" aria-label="小红书种草技能">
      {content}
    </section>
  ) : (
    <Modal open={open} onCancel={() => onOpenChange(false)} footer={null} width={880} title="AI小红书种草员">
      {content}
    </Modal>
  );
}
