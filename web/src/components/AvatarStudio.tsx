import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Input, Progress, Segmented, Select, Space, Tag, message } from 'antd';
import {
  AudioOutlined,
  CloseCircleOutlined,
  CloudUploadOutlined,
  ReloadOutlined,
  RetweetOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { api, notifyCredits, safeUrl } from '../api/client';
import './AvatarStudio.css';

type AvatarAsset = {
  id: number;
  name: string;
  kind: 'image' | 'audio';
  mime: string;
  size: number;
  url: string;
};

type AvatarJob = {
  id: number;
  title: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  billingStatus: string;
  billing?: { state?: string; label?: string; credits?: number; balance?: number; costYuan?: number };
  progress: number;
  durationSeconds: number;
  inputMode?: 'audio' | 'script';
  requestedEngine?: 'auto' | 'runninghub' | 'heygen' | 'kling';
  provider?: 'runninghub' | 'heygen' | 'kling' | null;
  voiceId?: string | null;
  steps?: Array<{ phase: string; message: string; at: string }>;
  outputUrl?: string | null;
  businessUsable?: boolean;
  error?: string | null;
  retryable?: boolean;
  cancelable?: boolean;
  retryCount?: number;
  freeRetriesRemaining?: number;
  cost?: { amount?: number; currency?: string; source?: string } | null;
  usage?: { networkRequests?: number } | null;
};

type ClonedVoice = {
  id: number;
  label: string;
  voiceId?: string | null;
  usable: boolean;
  status: string;
  billing?: { label?: string; balance?: number };
};

type AvatarVoiceOption = {
  voiceId: string;
  label: string;
  usable: boolean;
  cloned?: boolean;
};

type AvatarEngine = {
  key: 'auto' | 'runninghub' | 'heygen' | 'kling';
  label: string;
  ready: boolean;
};

type AvatarMeta = {
  engines: AvatarEngine[];
  activeEngine?: string | null;
  ttsReady?: boolean;
  systemVoices?: AvatarVoiceOption[];
};

const activeStatus = new Set(['queued', 'running']);
const scriptLimits: Record<number, number> = { 15: 120, 30: 240, 60: 480 };

function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.onload = () => {
      const encoded = String(reader.result || '');
      const comma = encoded.indexOf(',');
      resolve(comma >= 0 ? encoded.slice(comma + 1) : encoded);
    };
    reader.readAsDataURL(file);
  });
}

function statusMeta(job: AvatarJob) {
  if (job.status === 'done' && job.businessUsable) return { color: 'success', text: '成片可用' };
  if (job.status === 'failed') return { color: 'error', text: '执行失败' };
  if (job.status === 'cancelled') return { color: 'default', text: '已取消' };
  if (job.status === 'running') return { color: 'processing', text: '合成中' };
  return { color: 'warning', text: '排队中' };
}

export default function AvatarStudio() {
  const [assets, setAssets] = useState<AvatarAsset[]>([]);
  const [jobs, setJobs] = useState<AvatarJob[]>([]);
  const [voices, setVoices] = useState<ClonedVoice[]>([]);
  const [meta, setMeta] = useState<AvatarMeta>({ engines: [], systemVoices: [] });
  const [imageFileId, setImageFileId] = useState<number>();
  const [audioFileId, setAudioFileId] = useState<number>();
  const [durationSeconds, setDurationSeconds] = useState(30);
  const [engine, setEngine] = useState<'auto' | 'runninghub' | 'heygen' | 'kling'>('auto');
  const [inputMode, setInputMode] = useState<'audio' | 'script'>('audio');
  const [script, setScript] = useState('');
  const [voiceId, setVoiceId] = useState('male-qn-qingse');
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('老板数字人口播');
  const [voiceLabel, setVoiceLabel] = useState('我的声音');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState<'image' | 'audio' | ''>('');
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [assetData, jobData, voiceData, metaData] = await Promise.all([
        api.get('/avatar/assets', { silent: true }),
        api.get('/avatar/jobs?limit=20', { silent: true }),
        api.get('/avatar/voices', { silent: true }),
        api.get('/avatar/meta', { silent: true }),
      ]);
      if (!mounted.current) return;
      const nextAssets = Array.isArray(assetData?.items) ? assetData.items : [];
      setAssets(nextAssets);
      setJobs(Array.isArray(jobData?.items) ? jobData.items : []);
      setVoices(Array.isArray(voiceData?.items) ? voiceData.items : []);
      setMeta({
        engines: Array.isArray(metaData?.engines) ? metaData.engines : [],
        activeEngine: metaData?.activeEngine || null,
        ttsReady: Boolean(metaData?.ttsReady),
        systemVoices: Array.isArray(metaData?.systemVoices) ? metaData.systemVoices : [],
      });
      setEngine(current => {
        const engines = Array.isArray(metaData?.engines) ? metaData.engines : [];
        if (engines.some((item: AvatarEngine) => item.key === current && item.ready)) return current;
        return engines.find((item: AvatarEngine) => item.ready)?.key || current;
      });
      setImageFileId(current => current || nextAssets.find((item: AvatarAsset) => item.kind === 'image')?.id);
      setAudioFileId(current => current || nextAssets.find((item: AvatarAsset) => item.kind === 'audio')?.id);
      setError('');
    } catch (requestError) {
      if (!quiet && mounted.current) setError((requestError as Error).message);
    } finally {
      if (!quiet && mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const initial = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(initial);
      mounted.current = false;
    };
  }, [load]);

  const hasActive = jobs.some(job => activeStatus.has(job.status));
  useEffect(() => {
    if (!hasActive) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [hasActive, load]);

  const images = useMemo(() => assets.filter(item => item.kind === 'image'), [assets]);
  const audios = useMemo(() => assets.filter(item => item.kind === 'audio'), [assets]);
  const voiceOptions = useMemo(
    () => [
      ...(meta.systemVoices || []).filter(item => item.usable),
      ...voices
        .filter(item => item.usable && item.voiceId)
        .map(item => ({
          voiceId: String(item.voiceId),
          label: item.label,
          usable: true,
          cloned: true,
        })),
    ],
    [meta.systemVoices, voices],
  );

  const upload = async (kind: 'image' | 'audio', file?: File) => {
    if (!file) return;
    const maxBytes = kind === 'image' ? 8 * 1024 * 1024 : 25 * 1024 * 1024;
    if (file.size <= 0 || file.size > maxBytes) {
      message.error(`${kind === 'image' ? '图片' : '音频'}大小不符合要求`);
      return;
    }
    setUploading(kind);
    try {
      const response = await api.post('/avatar/assets', {
        kind,
        name: file.name,
        mime: file.type,
        b64: await fileBase64(file),
      });
      const asset = response?.asset as AvatarAsset;
      if (kind === 'image') setImageFileId(asset.id);
      else setAudioFileId(asset.id);
      message.success(`${kind === 'image' ? '人物图片' : '口播音频'}已进入租户素材库`);
      await load(true);
    } catch (uploadError) {
      message.error((uploadError as Error).message);
    } finally {
      setUploading('');
    }
  };

  const submit = async () => {
    if (!imageFileId) {
      message.error('请先选择人物图片');
      return;
    }
    if (inputMode === 'audio' && !audioFileId) {
      message.error('请选择一段原声音频');
      return;
    }
    if (inputMode === 'script' && (!script.trim() || !voiceId)) {
      message.error('请填写口播稿并选择音色');
      return;
    }
    setSubmitting(true);
    try {
      const response = await api.post('/avatar/jobs', {
        title,
        imageFileId,
        audioFileId: inputMode === 'audio' ? audioFileId : null,
        durationSeconds,
        engine,
        script: inputMode === 'script' ? script.trim() : '',
        voiceId: inputMode === 'script' ? voiceId : null,
        prompt,
      });
      notifyCredits(response?.billing?.balance);
      message.success('数字人工单已进入后台，页面会持续轮询');
      await load(true);
    } catch (submitError) {
      message.error((submitError as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (job: AvatarJob) => {
    try {
      const response = await api.post(`/avatar/jobs/${job.id}/cancel`);
      notifyCredits(response?.billing?.balance);
      message.success(response?.billing?.state === 'released' ? '任务已取消，预授权已全额退回' : '任务已取消');
      await load(true);
    } catch (cancelError) {
      message.error((cancelError as Error).message);
    }
  };

  const retry = async (job: AvatarJob) => {
    try {
      const response = await api.post(`/avatar/jobs/${job.id}/retry`);
      notifyCredits(response?.billing?.balance);
      message.success('免费重试已排队，不会重复扣费');
      await load(true);
    } catch (retryError) {
      message.error((retryError as Error).message);
    }
  };

  const clone = async () => {
    if (!audioFileId) {
      message.error('请先选择一段 MP3 或 WAV 声音样本');
      return;
    }
    setCloning(true);
    try {
      const response = await api.post('/avatar/voices/clone', {
        audioFileId,
        label: voiceLabel,
      });
      notifyCredits(response?.billing?.balance);
      message.success('声音克隆完成，已持久化到本企业声音列表');
      await load(true);
    } catch (cloneError) {
      message.error((cloneError as Error).message);
      await load(true);
    } finally {
      setCloning(false);
    }
  };

  return (
    <section className="avatar-studio" aria-label="数字人摄影棚">
      <div className="avatar-studio__heading">
        <div>
          <span className="avatar-studio__eyebrow">PAIHUO AVATAR · MULTI-ENGINE</span>
          <h2>数字人摄影棚</h2>
          <p>RunningHub、HeyGen 与可灵真实引擎；可上传原声，也可用系统或克隆音色把口播稿先转成音频。</p>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => load()}>
          刷新摄影棚
        </Button>
      </div>

      {error && <Alert type="error" showIcon message="摄影棚加载失败" description={error} />}

      <div className="avatar-studio__compose">
        <div className="avatar-studio__assets">
          <Card size="small" title="1. 人物图片" extra={<Tag>{images.length} 张</Tag>}>
            <Select
              value={imageFileId}
              placeholder="选择本企业人物图片"
              options={images.map(item => ({
                value: item.id,
                label: `${item.name} · ${(item.size / 1024).toFixed(0)} KB`,
              }))}
              onChange={setImageFileId}
            />
            <label className="avatar-studio__upload" htmlFor="avatar-image-upload">
              <CloudUploadOutlined />
              {uploading === 'image' ? '上传中…' : '上传 JPEG / PNG / WebP'}
              <input
                id="avatar-image-upload"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={Boolean(uploading)}
                onChange={event => {
                  void upload('image', event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            </label>
          </Card>

          <Card size="small" title="2. 原声音频（可选）" extra={<Tag>{audios.length} 条</Tag>}>
            <Select
              value={audioFileId}
              placeholder="选择本企业口播音频"
              options={audios.map(item => ({
                value: item.id,
                label: `${item.name} · ${(item.size / 1024).toFixed(0)} KB`,
              }))}
              onChange={setAudioFileId}
            />
            <label className="avatar-studio__upload" htmlFor="avatar-audio-upload">
              <AudioOutlined />
              {uploading === 'audio' ? '上传中…' : '上传 MP3 / WAV / M4A'}
              <input
                id="avatar-audio-upload"
                type="file"
                accept="audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a"
                disabled={Boolean(uploading)}
                onChange={event => {
                  void upload('audio', event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            </label>
          </Card>
        </div>

        <div className="avatar-studio__settings">
          <div className="avatar-studio__field">
            <span>数字人引擎</span>
            <Select
              value={engine}
              options={meta.engines.map(item => ({
                value: item.key,
                label: item.ready ? item.label : `${item.label}（未配置）`,
                disabled: !item.ready,
              }))}
              onChange={setEngine}
            />
          </div>
          <div className="avatar-studio__field">
            <span>工单名称</span>
            <Input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} />
          </div>
          <div className="avatar-studio__field">
            <span>计费时长档</span>
            <Segmented
              block
              value={durationSeconds}
              options={[15, 30, 60].map(value => ({ label: `${value} 秒`, value }))}
              onChange={value => setDurationSeconds(Number(value))}
            />
          </div>
          <div className="avatar-studio__field">
            <span>口播来源</span>
            <Segmented
              block
              value={inputMode}
              options={[
                { label: '上传原声', value: 'audio' },
                { label: '稿件 + 音色', value: 'script', disabled: !meta.ttsReady },
              ]}
              onChange={value => setInputMode(value as 'audio' | 'script')}
            />
          </div>
          {inputMode === 'script' && (
            <>
              <div className="avatar-studio__field">
                <span>口播稿</span>
                <Input.TextArea
                  value={script}
                  rows={5}
                  maxLength={scriptLimits[durationSeconds]}
                  showCount
                  placeholder="输入真人可直接念出的口播稿"
                  onChange={event => setScript(event.target.value)}
                />
              </div>
              <div className="avatar-studio__field">
                <span>系统 / 克隆音色</span>
                <Select
                  value={voiceId}
                  options={voiceOptions.map(item => ({
                    value: item.voiceId,
                    label: `${item.cloned ? '克隆 · ' : ''}${item.label}`,
                  }))}
                  onChange={setVoiceId}
                />
              </div>
            </>
          )}
          <div className="avatar-studio__field">
            <span>动作提示（可选）</span>
            <Input
              value={prompt}
              maxLength={200}
              placeholder="例如：自然微笑，轻微手势，正视镜头"
              onChange={event => setPrompt(event.target.value)}
            />
          </div>
          <Alert
            type="info"
            showIcon
            message="提交前预授权，失败或取消全退"
            description="音频会由服务端硬截到所选时长；显式选择不可用时会直接失败，只有自动模式才会按可用引擎安全回退。"
          />
          <Button
            type="primary"
            size="large"
            icon={<VideoCameraOutlined />}
            loading={submitting}
            disabled={
              !imageFileId ||
              !meta.engines.some(item => item.key === engine && item.ready) ||
              (inputMode === 'audio' ? !audioFileId : !script.trim() || !voiceId)
            }
            onClick={() => void submit()}
          >
            创建真实数字人工单
          </Button>
        </div>
      </div>

      <div className="avatar-studio__voice-clone">
        <div>
          <strong>声音克隆</strong>
          <span>从当前租户 MP3/WAV 样本上传 MiniMax；标签自动去空格并截 12 字。</span>
        </div>
        <Input value={voiceLabel} maxLength={24} onChange={event => setVoiceLabel(event.target.value)} />
        <Button icon={<AudioOutlined />} loading={cloning} disabled={!audioFileId} onClick={() => void clone()}>
          克隆当前声音
        </Button>
        <div className="avatar-studio__voices">
          {voices
            .filter(item => item.usable)
            .map(item => (
              <Tag color="purple" key={item.id}>
                {item.label}
              </Tag>
            ))}
        </div>
      </div>

      <div className="avatar-studio__jobs">
        <div className="avatar-studio__jobs-head">
          <strong>最近数字人工单</strong>
          <span>{hasActive ? '后台轮询中 · 每 3 秒更新' : '暂无执行中工单'}</span>
        </div>
        {!jobs.length ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="上传两类素材后创建第一条工单" />
        ) : (
          jobs.map(job => {
            const meta = statusMeta(job);
            const lastStep = job.steps?.[Math.max(0, (job.steps?.length || 1) - 1)];
            return (
              <article className="avatar-studio__job" key={job.id}>
                <div className="avatar-studio__job-main">
                  <div>
                    <Tag color={meta.color}>{meta.text}</Tag>
                    <strong>{job.title}</strong>
                    <small>
                      #{job.id} · {job.durationSeconds} 秒 · 请求 {job.requestedEngine || 'auto'}
                      {job.provider ? ` → ${job.provider}` : ''}
                    </small>
                  </div>
                  <Progress
                    percent={job.status === 'done' ? 100 : Number(job.progress || 0)}
                    status={job.status === 'failed' ? 'exception' : undefined}
                    size="small"
                  />
                  <p>{lastStep?.message || job.error || '等待任务进度'}</p>
                </div>
                <div className="avatar-studio__job-billing">
                  <span>{job.billing?.label || '费用状态待确认'}</span>
                  {job.cost?.amount ? <span>供应商成本 ¥{Number(job.cost.amount).toFixed(2)}</span> : null}
                  {job.usage?.networkRequests ? <span>{job.usage.networkRequests} 次真实请求</span> : null}
                  {job.error && <Alert type="error" showIcon message={job.error} />}
                </div>
                <Space wrap>
                  {job.cancelable && (
                    <Button danger size="small" icon={<CloseCircleOutlined />} onClick={() => void cancel(job)}>
                      取消并退款
                    </Button>
                  )}
                  {job.retryable && (
                    <Button size="small" icon={<RetweetOutlined />} onClick={() => void retry(job)}>
                      免费重试（余 {job.freeRetriesRemaining}）
                    </Button>
                  )}
                  <Button size="small" href={job.id ? `/tasks?kind=avatar&id=${job.id}` : undefined}>
                    稳定任务链接
                  </Button>
                </Space>
                {job.businessUsable && job.outputUrl && (
                  // eslint-disable-next-line jsx-a11y/media-has-caption -- provider output currently has no verified caption track
                  <video controls preload="metadata" src={safeUrl(job.outputUrl)} />
                )}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
