import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  Progress,
  Radio,
  Select,
  Space,
  Spin,
  Tag,
  message,
} from 'antd';
import {
  CloudUploadOutlined,
  DownloadOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';

import { api, notifyCredits, safeUrl } from '../api/client';
import './TextVideoStudio.css';

type Asset = {
  id: number;
  name: string;
  kind: 'image' | 'clip';
  size: number;
  url: string;
};

type LicensedMaterial = {
  id: number;
  name: string;
  url: string;
  rights: {
    confirmed: boolean;
    commercialUse: boolean;
    license: string;
    attribution?: string | null;
  };
};

type TextVideoJob = {
  id: number;
  title: string;
  mode: 'images' | 'clips';
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: number;
  billing: {
    state: string;
    credits: number | null;
    balance?: number;
    label: string;
    costYuan?: number | null;
  };
  retryCount: number;
  freeRetriesRemaining: number;
  retryable: boolean;
  cancelable: boolean;
  businessUsable: boolean;
  outputUrl?: string | null;
  durationSeconds?: number | null;
  resultBytes?: number | null;
  error?: string | null;
  steps?: Array<{ phase: string; message: string; at: string }>;
  createdAt: string;
};

const ACTIVE = new Set(['queued', 'running']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CLIP_BYTES = 20 * 1024 * 1024;

function bytesLabel(value: number | null | undefined) {
  const bytes = Number(value || 0);
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusTag(job: TextVideoJob) {
  const config: Record<string, { color: string; label: string }> = {
    queued: { color: 'default', label: '排队中' },
    running: { color: 'processing', label: '成片中' },
    done: { color: 'success', label: '已成片' },
    failed: { color: 'error', label: '执行失败' },
    cancelled: { color: 'default', label: '已取消' },
  };
  const current = config[job.status] || { color: 'default', label: job.status };
  return <Tag color={current.color}>{current.label}</Tag>;
}

function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('本地文件读取失败'));
    reader.onload = () => {
      const encoded = String(reader.result || '').split(',', 2)[1];
      if (!encoded) reject(new Error('本地文件内容为空'));
      else resolve(encoded);
    };
    reader.readAsDataURL(file);
  });
}

export default function TextVideoStudio() {
  const [searchParams] = useSearchParams();
  const [form] = Form.useForm();
  const mode = Form.useWatch('mode', form) || 'images';
  const imageFileRef = useRef<HTMLInputElement>(null);
  const clipFileRef = useRef<HTMLInputElement>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [materials, setMaterials] = useState<LicensedMaterial[]>([]);
  const [jobs, setJobs] = useState<TextVideoJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState<'image' | 'clip' | ''>('');
  const [error, setError] = useState('');
  const [actingId, setActingId] = useState<number | null>(null);
  const requestedJobId = useMemo(() => {
    const value = Number(searchParams.get('jobId'));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }, [searchParams]);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      setError('');
      try {
        const [assetResponse, materialResponse, jobResponse, requestedJobResponse] = await Promise.all([
          api.get('/text-video/assets', { silent: true }),
          api.get('/text-video/materials?limit=100', { silent: true }),
          api.get('/text-video/jobs?limit=50', { silent: true }),
          requestedJobId
            ? api.get(`/text-video/jobs/${requestedJobId}`, { silent: true }).catch(() => null)
            : Promise.resolve(null),
        ]);
        setAssets(Array.isArray(assetResponse?.assets) ? assetResponse.assets : []);
        setMaterials(Array.isArray(materialResponse?.materials) ? materialResponse.materials : []);
        const listed = Array.isArray(jobResponse?.jobs) ? (jobResponse.jobs as TextVideoJob[]) : [];
        const requested = requestedJobResponse?.job as TextVideoJob | undefined;
        setJobs(requested ? [requested, ...listed.filter(job => job.id !== requested.id)] : listed);
      } catch (requestError) {
        if (!quiet) setError(requestError instanceof Error ? requestError.message : '成片工作台加载失败');
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [requestedJobId],
  );

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const hasActiveJobs = jobs.some(job => ACTIVE.has(job.status));
  useEffect(() => {
    if (!hasActiveJobs) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs, load]);

  const images = useMemo(() => assets.filter(asset => asset.kind === 'image'), [assets]);
  const clips = useMemo(() => assets.filter(asset => asset.kind === 'clip'), [assets]);

  useEffect(() => {
    if (!requestedJobId || !jobs.some(job => job.id === requestedJobId)) return;
    const timer = window.setTimeout(() => {
      document.getElementById(`text-video-job-${requestedJobId}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [jobs, requestedJobId]);

  const upload = async (kind: 'image' | 'clip', selected: FileList | null) => {
    const file = selected?.[0];
    if (!file) return;
    const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
    const clipTypes = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
    const allowed = kind === 'image' ? imageTypes : clipTypes;
    const maximum = kind === 'image' ? MAX_IMAGE_BYTES : MAX_CLIP_BYTES;
    if (!allowed.has(file.type) || file.size <= 0 || file.size > maximum) {
      message.error(
        kind === 'image' ? '图片仅支持 JPEG、PNG、WebP，且不超过 8MB' : '片段仅支持 MP4、MOV、WebM，且不超过 20MB',
      );
      return;
    }
    setUploading(kind);
    try {
      const response = await api.post('/text-video/assets', {
        kind,
        name: file.name,
        mime: file.type,
        b64: await fileBase64(file),
      });
      const asset = response.asset as Asset;
      setAssets(current => [asset, ...current.filter(item => item.id !== asset.id)]);
      const field = kind === 'image' ? 'imageFileIds' : 'clipFileIds';
      const selectedIds = Array.isArray(form.getFieldValue(field)) ? form.getFieldValue(field) : [];
      form.setFieldValue(field, [...new Set([...selectedIds, asset.id])]);
      message.success(kind === 'image' ? '图片已进入租户成片素材库' : '视频片段已进入租户成片素材库');
    } catch (uploadError) {
      message.error(uploadError instanceof Error ? uploadError.message : '素材上传失败');
    } finally {
      setUploading('');
      if (imageFileRef.current) imageFileRef.current.value = '';
      if (clipFileRef.current) clipFileRef.current.value = '';
    }
  };

  const createJob = async () => {
    const values = await form.validateFields();
    setCreating(true);
    try {
      const response = await api.post('/text-video/jobs', values);
      const job = response.job as TextVideoJob;
      setJobs(current => [job, ...current.filter(item => item.id !== job.id)]);
      notifyCredits(job.billing?.balance);
      message.info(response.message || '真实成片任务已进入后台流水线');
    } catch (createError) {
      message.error(createError instanceof Error ? createError.message : '成片任务创建失败');
    } finally {
      setCreating(false);
    }
  };

  const cancel = async (job: TextVideoJob) => {
    setActingId(job.id);
    try {
      const response = await api.post(`/text-video/jobs/${job.id}/cancel`, {});
      setJobs(current => current.map(item => (item.id === job.id ? response.job : item)));
      notifyCredits(response.job?.billing?.balance);
      message.success(response.message || '任务已取消，预授权已退回');
    } finally {
      setActingId(null);
    }
  };

  const retry = async (job: TextVideoJob) => {
    setActingId(job.id);
    try {
      const response = await api.post(`/text-video/jobs/${job.id}/retry`, {});
      setJobs(current => current.map(item => (item.id === job.id ? response.job : item)));
      message.info(response.message || '免费重试已排队');
    } finally {
      setActingId(null);
    }
  };

  return (
    <section className="text-video-studio">
      <header className="text-video-studio__hero">
        <div className="text-video-studio__mark">
          <VideoCameraOutlined />
        </div>
        <div>
          <Tag color="gold">真实成片流水线</Tag>
          <h2>图文 / 素材一键成片</h2>
          <p>正文经必要的真实模型压缩后，逐句调用 TTS，并把租户图片或视频片段合成为 1080×1920 H264/AAC MP4。</p>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      </header>

      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        message="不会用模板或假视频补位"
        description="无真实 TTS、FFmpeg、可用素材或长文压缩模型时任务直接停止并退款。只有你显式勾选纯色背景，系统才允许无图片成片。"
      />

      {error && <Alert type="error" showIcon message="工作台加载失败" description={error} />}

      <div className="text-video-studio__grid">
        <Card className="text-video-studio__composer" bordered={false}>
          <Form
            form={form}
            layout="vertical"
            initialValues={{
              mode: 'images',
              bgm: 'warm',
              voiceId: 'presenter_female',
              imageFileIds: [],
              materialIds: [],
              clipFileIds: [],
              allowSolidBackground: false,
            }}
          >
            <Form.Item
              name="title"
              label="顶部标题"
              rules={[{ required: true, message: '请填写成片标题' }, { max: 120 }]}
            >
              <Input placeholder="例：一道招牌菜，为什么值得专程来吃" />
            </Form.Item>
            <Form.Item
              name="body"
              label="正文 / 口播内容"
              rules={[
                { required: true, message: '请填写正文' },
                { min: 20, message: '正文至少20字' },
                { max: 12000, message: '正文最多12000字' },
              ]}
              extra="320字以内直接分句；更长正文必须经过真实模型压缩，模型不可用时不会本地截断冒充。"
            >
              <Input.TextArea
                rows={8}
                showCount
                maxLength={12000}
                placeholder="粘贴已经核实的门店内容、产品故事或口播正文"
              />
            </Form.Item>
            <Form.Item name="mode" label="画面方式">
              <Radio.Group optionType="button" buttonStyle="solid">
                <Radio.Button value="images">图片运镜</Radio.Button>
                <Radio.Button value="clips">素材混剪</Radio.Button>
              </Radio.Group>
            </Form.Item>

            {mode === 'images' ? (
              <>
                <Form.Item name="imageFileIds" label="本租户上传图片">
                  <Select
                    mode="multiple"
                    allowClear
                    optionFilterProp="label"
                    placeholder={images.length ? '选择一张或多张真实图片' : '暂无图片，可先上传'}
                    options={images.map(asset => ({
                      value: asset.id,
                      label: `#${asset.id} · ${asset.name} · ${bytesLabel(asset.size)}`,
                    }))}
                  />
                </Form.Item>
                <Form.Item name="materialIds" label="ImageHunt 已授权素材">
                  <Select
                    mode="multiple"
                    allowClear
                    optionFilterProp="label"
                    placeholder={materials.length ? '选择已确认商业使用权的素材' : '暂无已授权素材'}
                    options={materials.map(material => ({
                      value: material.id,
                      label: `#${material.id} · ${material.name} · ${material.rights.license}`,
                    }))}
                  />
                </Form.Item>
                <Space wrap className="text-video-studio__asset-actions">
                  <input
                    ref={imageFileRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    hidden
                    onChange={event => void upload('image', event.target.files)}
                  />
                  <Button
                    icon={<CloudUploadOutlined />}
                    loading={uploading === 'image'}
                    onClick={() => imageFileRef.current?.click()}
                  >
                    上传租户图片
                  </Button>
                  <Button icon={<SearchOutlined />} href="/toolbox?tool=imagehunt" target="_blank">
                    去 ImageHunt 搜图并核权
                  </Button>
                  <Form.Item name="allowSolidBackground" valuePropName="checked" noStyle>
                    <Checkbox>我明确允许没有图片时使用纯色背景</Checkbox>
                  </Form.Item>
                </Space>
              </>
            ) : (
              <>
                <Form.Item
                  name="clipFileIds"
                  label="本租户视频片段"
                  rules={[{ required: true, type: 'array', min: 1, message: '至少选择一个视频片段' }]}
                >
                  <Select
                    mode="multiple"
                    allowClear
                    optionFilterProp="label"
                    maxCount={12}
                    placeholder={clips.length ? '选择1至12段租户素材' : '暂无片段，可先上传'}
                    options={clips.map(asset => ({
                      value: asset.id,
                      label: `#${asset.id} · ${asset.name} · ${bytesLabel(asset.size)}`,
                    }))}
                  />
                </Form.Item>
                <input
                  ref={clipFileRef}
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm"
                  hidden
                  onChange={event => void upload('clip', event.target.files)}
                />
                <Button
                  icon={<CloudUploadOutlined />}
                  loading={uploading === 'clip'}
                  onClick={() => clipFileRef.current?.click()}
                >
                  上传租户视频片段
                </Button>
              </>
            )}

            <div className="text-video-studio__settings">
              <Form.Item name="voiceId" label="真实配音声音">
                <Input placeholder="presenter_female 或本租户已结算克隆声音ID" />
              </Form.Item>
              <Form.Item name="bgm" label="配乐">
                <Select
                  options={[
                    { value: 'warm', label: '温暖 · 免版权合成配乐' },
                    { value: 'up', label: '轻快 · 免版权合成配乐' },
                    { value: 'calm', label: '沉稳 · 免版权合成配乐' },
                    { value: 'none', label: '不配乐' },
                  ]}
                />
              </Form.Item>
            </div>
            <Button
              type="primary"
              size="large"
              block
              icon={<PlayCircleOutlined />}
              loading={creating}
              onClick={() => void createJob()}
            >
              预授权并开始真实成片
            </Button>
          </Form>
        </Card>

        <aside className="text-video-studio__contract">
          <span>交付契约</span>
          <strong>1080 × 1920</strong>
          <ul>
            <li>H264 视频 + AAC 音频</li>
            <li>6–26 字逐屏字幕</li>
            <li>标题 + Ken Burns 运镜</li>
            <li>产物落库后才结算</li>
            <li>失败 / 取消全额退回预授权</li>
          </ul>
        </aside>
      </div>

      <section className="text-video-studio__jobs">
        <div className="text-video-studio__jobs-head">
          <div>
            <span>真实任务记录</span>
            <h3>成片队列与交付</h3>
          </div>
          {hasActiveJobs && (
            <Tag icon={<LoadingOutlined />} color="processing">
              每2.5秒同步
            </Tag>
          )}
        </div>
        {loading && !jobs.length ? (
          <div className="text-video-studio__loading">
            <Spin />
          </div>
        ) : !jobs.length ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有成片任务" />
        ) : (
          <div className="text-video-studio__job-list">
            {jobs.map(job => {
              const latest = job.steps?.length ? job.steps[job.steps.length - 1] : undefined;
              return (
                <article
                  id={`text-video-job-${job.id}`}
                  className={`text-video-studio__job${requestedJobId === job.id ? ' text-video-studio__job--target' : ''}`}
                  key={job.id}
                >
                  <div className="text-video-studio__job-title">
                    <span>#{job.id}</span>
                    <h4>{job.title}</h4>
                    {statusTag(job)}
                    {requestedJobId === job.id && <Tag color="blue">深链定位</Tag>}
                  </div>
                  <Progress
                    percent={job.progress || 0}
                    showInfo={false}
                    status={job.status === 'failed' ? 'exception' : job.status === 'done' ? 'success' : 'active'}
                  />
                  <p>{latest?.message || (job.status === 'queued' ? '等待本机渲染槽位' : '暂无步骤记录')}</p>
                  {job.error && <Alert type="error" showIcon message={job.error} />}
                  <dl>
                    <div>
                      <dt>模式</dt>
                      <dd>{job.mode === 'clips' ? '租户素材混剪' : '图片运镜'}</dd>
                    </div>
                    <div>
                      <dt>账务</dt>
                      <dd>{job.billing?.label || '—'}</dd>
                    </div>
                    <div>
                      <dt>成片</dt>
                      <dd>
                        {job.businessUsable
                          ? `${Math.round(job.durationSeconds || 0)}秒 · ${bytesLabel(job.resultBytes)}`
                          : '尚未形成可用交付'}
                      </dd>
                    </div>
                    <div>
                      <dt>免费重试</dt>
                      <dd>剩余 {job.freeRetriesRemaining} 次</dd>
                    </div>
                  </dl>
                  <Space wrap>
                    {job.cancelable && (
                      <Button
                        danger
                        icon={<PauseCircleOutlined />}
                        loading={actingId === job.id}
                        onClick={() => void cancel(job)}
                      >
                        取消并退款
                      </Button>
                    )}
                    {job.retryable && (
                      <Button icon={<ReloadOutlined />} loading={actingId === job.id} onClick={() => void retry(job)}>
                        免费重试
                      </Button>
                    )}
                    {job.businessUsable && job.outputUrl && (
                      <Button type="primary" icon={<DownloadOutlined />} href={safeUrl(job.outputUrl)} download>
                        下载MP4
                      </Button>
                    )}
                    <Button href={`/tasks?kind=text_video&id=${job.id}`}>任务中心详情</Button>
                  </Space>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </section>
  );
}
