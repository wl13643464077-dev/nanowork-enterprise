import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AutoComplete,
  Button,
  DatePicker,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Segmented,
  Space,
  Spin,
  Steps,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  CalendarOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  PictureOutlined,
  ReloadOutlined,
  SendOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { api, safeUrl } from '../api/client';
import './ContentPublishAssistant.css';

export type PublishAssistantTab = 'schedule' | 'pack' | 'metrics' | 'timeline';

type PublishPack = {
  versionId?: string;
  strategy?: string;
  coverText?: string;
  imagePlan?: Array<{ slot: string; desc: string }>;
  platform: string | null;
  title: string | null;
  body: string | null;
  hashtags: string[];
  firstComment: string | null;
  images: { id: number; name: string | null; type: string | null; url: string }[];
  bestTime: string | null;
  checklist: string[];
  note: string | null;
  copyText: string;
};

type PublishPackResponse = {
  contentId: number;
  title: string;
  source: 'distributor' | 'content' | 'xhs_selected';
  schedule: { scheduledAt: string | null; channel: string | null };
  packs: PublishPack[];
  disclaimer: string;
};

type FollowupStep = {
  day: number;
  dueAt: string | null;
  status: 'waiting_publish' | 'pending' | 'due' | 'notified' | 'stopped';
  notifiedAt: string | null;
};

type AssistantState = {
  contentId: number;
  title: string;
  status: string;
  schedule: { scheduledAt: string | null; channel: string | null; remindedAt: string | null };
  publishedAt: string | null;
  publishLogs: {
    id: number;
    channel: string;
    views: number;
    leads: number;
    createdByName: string | null;
    createdAt: string;
  }[];
  metrics: {
    id: number;
    attribution?: { versionId: string | null; strategy: string | null; source: string };
    channel: string | null;
    views: number | null;
    likes: number | null;
    saves: number | null;
    comments: number | null;
    orders: number | null;
    screenshotFileId: number | null;
    note: string;
    createdByName: string | null;
    createdAt: string;
  }[];
  metricsFilled: boolean;
  followupTimeline: FollowupStep[];
};

type ContentPublishAssistantProps = {
  open: boolean;
  contentId: number | null;
  initialTab?: PublishAssistantTab;
  onClose: () => void;
  /** “我已发布，去登记”：交给宿主打开既有的发布登记弹窗 */
  onOpenPublishLog?: (contentId: number) => void;
  onOpenRetrospective?: (contentId: number) => void;
};

export const PUBLISH_PLATFORM_OPTIONS = [
  '小红书',
  '抖音',
  '视频号',
  '公众号',
  '朋友圈',
  '社群',
  '大众点评',
  '美团',
].map(value => ({ value }));

const TAB_KEYS: PublishAssistantTab[] = ['schedule', 'pack', 'metrics', 'timeline'];
const METRIC_FIELDS: { key: 'views' | 'likes' | 'saves' | 'comments' | 'orders'; label: string }[] = [
  { key: 'views', label: '浏览' },
  { key: 'likes', label: '点赞' },
  { key: 'saves', label: '收藏' },
  { key: 'comments', label: '评论' },
  { key: 'orders', label: '订单' },
];

function formatTime(value: string | null | undefined) {
  if (!value) return '';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : String(value);
}

function fileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function stepStatus(step: FollowupStep, filled: boolean): 'wait' | 'process' | 'finish' | 'error' {
  if (step.status === 'notified') return 'finish';
  if (step.status === 'stopped') return filled ? 'finish' : 'wait';
  if (step.status === 'due') return 'process';
  return 'wait';
}

function stepDescription(step: FollowupStep, filled: boolean) {
  const due = step.dueAt ? `到期 ${formatTime(step.dueAt)}` : '发布登记后开始计时';
  if (step.status === 'notified') return `${due}；已于 ${formatTime(step.notifiedAt)} 提醒回填`;
  if (step.status === 'stopped') return filled ? '数据已回填，停止催复盘' : due;
  if (step.status === 'due') return `${due}；将在下一次每日 10:00 提醒`;
  return due;
}

/**
 * 发布助手抽屉：排期 → 一键复制发布包 → 人工去平台发布 → 发布登记 → T+1/3/7 回填数据。
 * 全程不做任何自动发布，只提醒和整理；数据为人工录入、平台未核验。
 */
export default function ContentPublishAssistant({
  open,
  contentId,
  initialTab = 'schedule',
  onClose,
  onOpenPublishLog,
  onOpenRetrospective,
}: ContentPublishAssistantProps) {
  const [tab, setTab] = useState<PublishAssistantTab>(initialTab);
  const [state, setState] = useState<AssistantState | null>(null);
  const [stateError, setStateError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pack, setPack] = useState<PublishPackResponse | null>(null);
  const [packError, setPackError] = useState('');
  const [packLoading, setPackLoading] = useState(false);
  const [platformIndex, setPlatformIndex] = useState(0);
  const [fallbackText, setFallbackText] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [screenshot, setScreenshot] = useState<{ id: number; name: string } | null>(null);
  const fallbackRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [scheduleForm] = Form.useForm<{ scheduledAt: Dayjs | null; channel: string }>();
  const [metricsForm] = Form.useForm<Record<string, number | string | undefined>>();

  const loadState = useCallback(async () => {
    if (!contentId) return;
    setLoading(true);
    setStateError('');
    try {
      const response = (await api.get(`/content/${contentId}/publish-assistant`, { silent: true })) as AssistantState;
      setState(response);
      scheduleForm.setFieldsValue({
        scheduledAt: response.schedule.scheduledAt ? dayjs(response.schedule.scheduledAt) : null,
        channel: response.schedule.channel || '',
      });
      const latestLog = response.publishLogs[response.publishLogs.length - 1];
      metricsForm.setFieldsValue({ channel: response.schedule.channel || latestLog?.channel || '' });
    } catch (e: any) {
      setState(null);
      setStateError(e?.message || '发布助手加载失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }, [contentId, scheduleForm, metricsForm]);

  const loadPack = useCallback(async () => {
    if (!contentId) return;
    setPackLoading(true);
    setPackError('');
    try {
      const response = (await api.get(`/content/${contentId}/publish-pack`, { silent: true })) as PublishPackResponse;
      setPack(response);
      setPlatformIndex(0);
    } catch (e: any) {
      setPack(null);
      setPackError(e?.message || '发布包加载失败');
    } finally {
      setPackLoading(false);
    }
  }, [contentId]);

  useEffect(() => {
    if (!open || !contentId) return undefined;
    const timer = window.setTimeout(() => {
      setTab(initialTab);
      setFallbackText('');
      setScreenshot(null);
      void loadState();
      void loadPack();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, contentId, initialTab, loadState, loadPack]);

  const currentPack = useMemo(() => pack?.packs[platformIndex] || pack?.packs[0] || null, [pack, platformIndex]);

  const copyToClipboard = async (text: string, label: string) => {
    if (!text) {
      message.warning('没有可复制的内容');
      return;
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      message.success(`${label}已复制，去平台粘贴即可`);
    } catch {
      setFallbackText(text);
      message.warning('自动复制不可用，已为你选中文本，请按 Ctrl+C 复制');
      window.setTimeout(() => {
        const node = fallbackRef.current?.resizableTextArea?.textArea as HTMLTextAreaElement | undefined;
        node?.focus();
        node?.select();
      }, 0);
    }
  };

  const saveSchedule = async () => {
    if (!contentId) return;
    const values = await scheduleForm.validateFields();
    if (!values.scheduledAt) {
      message.warning('请选择计划发布时间');
      return;
    }
    setSaving(true);
    try {
      await api.put(`/content/${contentId}/schedule`, {
        scheduledAt: values.scheduledAt.toDate().toISOString(),
        channel: values.channel,
      });
      message.success('排期已保存；到点会站内提醒你去发，系统不会代发');
      await loadState();
    } finally {
      setSaving(false);
    }
  };

  const clearSchedule = async () => {
    if (!contentId) return;
    setSaving(true);
    try {
      await api.put(`/content/${contentId}/schedule`, { scheduledAt: null });
      message.success('已取消排期');
      scheduleForm.setFieldsValue({ scheduledAt: null });
      await loadState();
    } finally {
      setSaving(false);
    }
  };

  const pickScreenshot = async (selected: FileList | null) => {
    const file = selected?.[0];
    if (!file) return;
    if (!/^image\//u.test(file.type)) {
      message.warning('数据截图必须是图片');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      message.warning('截图超过 8MB，请压缩后再传');
      return;
    }
    setUploading(true);
    try {
      const b64 = await fileAsBase64(file);
      const result = await api.post('/files/upload', {
        name: file.name,
        mime: file.type,
        b64,
        purpose: 'publish_metrics',
        recognize: false,
      });
      const id = Number(result?.file?.id);
      if (!Number.isInteger(id) || id <= 0) throw new Error('上传结果缺少文件编号');
      setScreenshot({ id, name: file.name });
      message.success('截图已上传（不识图、不扣积分）');
    } catch (e: any) {
      message.error(`截图上传失败：${e?.message || '请重试'}`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const submitMetrics = async () => {
    if (!contentId) return;
    const values = await metricsForm.validateFields();
    const payload: Record<string, unknown> = {};
    for (const field of METRIC_FIELDS) {
      const raw = values[field.key];
      if (raw === undefined || raw === null || raw === '') continue;
      payload[field.key] = Number(raw);
    }
    if (typeof values.channel === 'string' && values.channel.trim()) payload.channel = values.channel.trim();
    if (typeof values.note === 'string' && values.note.trim()) payload.note = values.note.trim();
    if (screenshot) payload.screenshotFileId = screenshot.id;
    if (!Object.keys(payload).some(key => METRIC_FIELDS.some(field => field.key === key)) && !screenshot) {
      message.warning('请至少填写一项平台数据或上传一张数据截图');
      return;
    }
    setSaving(true);
    try {
      await api.post(`/content/${contentId}/metrics`, payload);
      message.success('数据已回填；已通知老板可派复盘官分析（不会自动扣费）');
      metricsForm.resetFields(METRIC_FIELDS.map(field => field.key));
      metricsForm.setFieldsValue({ note: '' });
      setScreenshot(null);
      await loadState();
      setTab('timeline');
    } finally {
      setSaving(false);
    }
  };

  const openPublishLog = () => {
    if (!contentId) return;
    if (onOpenPublishLog) onOpenPublishLog(contentId);
    else message.info('请在内容列表点击“发布登记”');
  };

  const scheduleTab = (
    <div className="content-publish-assistant__section">
      <Alert
        showIcon
        type="info"
        className="content-publish-assistant__alert"
        message="排期只用于到点提醒"
        description="到了计划时间，系统会给内容负责人发一条站内通知“该发到 xx 了，点此复制文案”，由人手动去平台发布。不会代发、不会操作账号。"
      />
      <Form form={scheduleForm} layout="vertical" className="content-publish-assistant__form">
        <Form.Item name="scheduledAt" label="计划发布时间" rules={[{ required: true, message: '请选择计划发布时间' }]}>
          <DatePicker
            showTime={{ format: 'HH:mm', minuteStep: 5 }}
            format="YYYY-MM-DD HH:mm"
            disabledDate={current => current.isBefore(dayjs().startOf('day'))}
            className="content-publish-assistant__control"
          />
        </Form.Item>
        <Form.Item
          name="channel"
          label="目标平台"
          rules={[
            { required: true, message: '请填写目标平台' },
            { max: 40, message: '平台名称不超过 40 个字' },
          ]}
        >
          <AutoComplete
            options={PUBLISH_PLATFORM_OPTIONS}
            placeholder="小红书 / 抖音 / 朋友圈…"
            filterOption={(input, option) => String(option?.value || '').includes(input)}
            className="content-publish-assistant__control"
          />
        </Form.Item>
        <Space wrap>
          <Button type="primary" icon={<CalendarOutlined />} loading={saving} onClick={() => void saveSchedule()}>
            保存排期
          </Button>
          {state?.schedule.scheduledAt && (
            <Button loading={saving} onClick={() => void clearSchedule()}>
              取消排期
            </Button>
          )}
        </Space>
      </Form>
      {state?.schedule.scheduledAt && (
        <Typography.Paragraph className="content-publish-assistant__hint">
          当前排期：{formatTime(state.schedule.scheduledAt)} · {state.schedule.channel}
          {state.schedule.remindedAt ? `；已于 ${formatTime(state.schedule.remindedAt)} 提醒` : '；到点提醒一次'}
        </Typography.Paragraph>
      )}
    </div>
  );

  const packTab = (
    <div className="content-publish-assistant__section">
      {packLoading ? (
        <div className="content-publish-assistant__loading">
          <Spin />
        </div>
      ) : packError ? (
        <Alert
          showIcon
          type="warning"
          className="content-publish-assistant__alert"
          message="发布包暂不可复制"
          description={packError}
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadPack()}>
              重试
            </Button>
          }
        />
      ) : !pack || !currentPack ? (
        <Empty description="没有可整理的发布包" />
      ) : (
        <>
          <div className="content-publish-assistant__pack-head">
            <Tag>
              {pack.source === 'xhs_selected'
                ? `已选小红书${currentPack.strategy || ''}版本`
                : pack.source === 'distributor'
                  ? '来自分发官产物'
                  : '由正文整理'}
            </Tag>
            {pack.packs.length > 1 && (
              <Segmented
                size="small"
                value={platformIndex}
                onChange={value => setPlatformIndex(Number(value))}
                options={pack.packs.map((item, index) => ({
                  label: item.platform || `版本${index + 1}`,
                  value: index,
                }))}
              />
            )}
            {pack.packs.length === 1 && currentPack.platform && <Tag color="blue">{currentPack.platform}</Tag>}
          </div>
          <dl className="content-publish-assistant__pack">
            <dt>标题</dt>
            <dd>{currentPack.title || <span className="is-null">null（未提供）</span>}</dd>
            {currentPack.coverText && (
              <>
                <dt>封面文案</dt>
                <dd>
                  {currentPack.coverText}
                  <Button size="small" onClick={() => void copyToClipboard(currentPack.coverText || '', '封面文案')}>
                    复制封面文案
                  </Button>
                </dd>
              </>
            )}
            <dt>正文</dt>
            <dd className="content-publish-assistant__body">
              {currentPack.body || <span className="is-null">null（未提供）</span>}
            </dd>
            <dt>话题标签</dt>
            <dd>
              {currentPack.hashtags.length ? (
                <div className="content-publish-assistant__tags">
                  {currentPack.hashtags.map(tag => (
                    <Tag key={tag}>#{tag}</Tag>
                  ))}
                </div>
              ) : (
                <span className="is-null">无</span>
              )}
            </dd>
            <dt>首评</dt>
            <dd>
              {currentPack.firstComment || <span className="is-null">null（未提供，需人工补）</span>}
              {currentPack.firstComment && (
                <Button size="small" onClick={() => void copyToClipboard(currentPack.firstComment || '', '首评')}>
                  复制首评
                </Button>
              )}
            </dd>
            <dt>配图</dt>
            <dd>
              {currentPack.images.length ? (
                <div className="content-publish-assistant__images">
                  {currentPack.images.map(image => (
                    <a key={image.id} href={safeUrl(image.url)} target="_blank" rel="noreferrer">
                      <img src={safeUrl(image.url)} alt={image.name || `配图${image.id}`} />
                    </a>
                  ))}
                </div>
              ) : (
                <span className="is-null">
                  <PictureOutlined /> 无已引用素材图
                </span>
              )}
            </dd>
            {currentPack.bestTime && (
              <>
                <dt>建议时间</dt>
                <dd>{currentPack.bestTime}</dd>
              </>
            )}
            {!!currentPack.imagePlan?.length && (
              <>
                <dt>配图计划（不是已生成图片）</dt>
                <dd>
                  {currentPack.imagePlan.map(item => (
                    <div key={item.slot}>
                      {item.slot}：{item.desc}
                    </div>
                  ))}
                </dd>
              </>
            )}
            {currentPack.checklist.length > 0 && (
              <>
                <dt>后台清单</dt>
                <dd>
                  <ul className="content-publish-assistant__checklist">
                    {currentPack.checklist.map(item => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {currentPack.note && (
              <>
                <dt>注意</dt>
                <dd>{currentPack.note}</dd>
              </>
            )}
          </dl>
          <Space wrap className="content-publish-assistant__actions">
            <Button
              type="primary"
              icon={<CopyOutlined />}
              onClick={() => void copyToClipboard(currentPack.copyText, '发布包')}
            >
              一键复制发布包
            </Button>
            <Button icon={<CopyOutlined />} onClick={() => void copyToClipboard(currentPack.body || '', '正文')}>
              只复制正文
            </Button>
            <Button icon={<SendOutlined />} onClick={openPublishLog}>
              我已发布，去登记
            </Button>
          </Space>
          {fallbackText && (
            <Input.TextArea
              ref={fallbackRef}
              readOnly
              value={fallbackText}
              autoSize={{ minRows: 4, maxRows: 12 }}
              className="content-publish-assistant__fallback"
              onFocus={event => event.currentTarget.select()}
            />
          )}
          <Typography.Paragraph className="content-publish-assistant__hint">{pack.disclaimer}</Typography.Paragraph>
        </>
      )}
    </div>
  );

  const metricsTab = (
    <div className="content-publish-assistant__section">
      {state && !state.publishLogs.length ? (
        <Alert
          showIcon
          type="warning"
          className="content-publish-assistant__alert"
          message="还没有发布登记"
          description="先把这条内容在平台发出去并做发布登记，再回来回填浏览/点赞/收藏等数据。"
          action={
            <Button size="small" icon={<SendOutlined />} onClick={openPublishLog}>
              去登记
            </Button>
          }
        />
      ) : (
        <Alert
          showIcon
          type="info"
          className="content-publish-assistant__alert"
          message="人工回填，平台未核验"
          description="数据来自你在平台后台看到的数字；回填后会通知老板“可派复盘官分析”，不会自动扣积分跑复盘。"
        />
      )}
      <Form form={metricsForm} layout="vertical" className="content-publish-assistant__form">
        <div className="content-publish-assistant__metric-grid">
          {METRIC_FIELDS.map(field => (
            <Form.Item key={field.key} name={field.key} label={field.label}>
              <InputNumber
                min={0}
                precision={0}
                step={1}
                className="content-publish-assistant__control"
                placeholder="未知留空"
              />
            </Form.Item>
          ))}
        </div>
        <Form.Item name="channel" label="数据来源平台">
          <AutoComplete
            options={PUBLISH_PLATFORM_OPTIONS}
            placeholder="默认取发布登记的渠道"
            className="content-publish-assistant__control"
          />
        </Form.Item>
        <Form.Item name="note" label="备注">
          <Input.TextArea
            maxLength={500}
            showCount
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder="例如：截图取自小红书创作中心 09-05 10:00"
          />
        </Form.Item>
        <div className="content-publish-assistant__screenshot">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="content-publish-assistant__file"
            aria-label="上传数据截图"
            onChange={event => void pickScreenshot(event.target.files)}
          />
          <Button icon={<PictureOutlined />} loading={uploading} onClick={() => fileInputRef.current?.click()}>
            {screenshot ? '更换数据截图' : '上传数据截图（可选）'}
          </Button>
          {screenshot && (
            <Tag closable onClose={() => setScreenshot(null)}>
              {screenshot.name}
            </Tag>
          )}
        </div>
        <Button
          type="primary"
          icon={<CheckCircleOutlined />}
          loading={saving}
          disabled={Boolean(state && !state.publishLogs.length)}
          onClick={() => void submitMetrics()}
        >
          提交回填
        </Button>
      </Form>
      {state && state.metrics.length > 0 && (
        <div className="content-publish-assistant__history">
          <Typography.Text strong>已回填记录</Typography.Text>
          {onOpenRetrospective && (
            <Button onClick={() => contentId && onOpenRetrospective(contentId)}>带这些数据交给复盘官</Button>
          )}
          <Typography.Paragraph type="secondary">
            打开只预填任务，不会自动调用模型；版本未知的历史记录不会补猜归属。
          </Typography.Paragraph>
          <ul>
            {state.metrics.map(item => (
              <li key={item.id}>
                <span>{formatTime(item.createdAt)}</span>
                <span>
                  {item.channel || '渠道未知'} · {item.attribution?.strategy || '策略未知'} ·{' '}
                  {item.attribution?.versionId || '版本未知'}
                </span>
                <span>
                  {METRIC_FIELDS.filter(field => item[field.key] !== null)
                    .map(field => `${field.label} ${item[field.key]}`)
                    .join(' · ') || '仅截图'}
                </span>
                <span className="content-publish-assistant__muted">
                  {item.createdByName || '同事'}
                  {item.screenshotFileId ? ' · 有截图' : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );

  const timelineTab = (
    <div className="content-publish-assistant__section">
      {state ? (
        <>
          <Steps
            direction="vertical"
            size="small"
            className="content-publish-assistant__steps"
            items={[
              {
                title: '发布登记',
                status: state.publishedAt ? 'finish' : 'process',
                description: state.publishedAt
                  ? `${formatTime(state.publishedAt)} · ${state.publishLogs[0]?.channel || ''}${
                      state.publishLogs[0]?.createdByName ? ` · ${state.publishLogs[0].createdByName}` : ''
                    }`
                  : '发布后点“我已发布，去登记”，T+1/3/7 从登记时间开始计',
              },
              ...state.followupTimeline.map(step => ({
                title: `T+${step.day} 催回填`,
                status: stepStatus(step, state.metricsFilled),
                description: stepDescription(step, state.metricsFilled),
              })),
              {
                title: '数据回填 → 可派复盘官',
                status: state.metricsFilled ? 'finish' : 'wait',
                description: state.metricsFilled
                  ? `已回填 ${state.metrics.length} 次；需要复盘时手动派复盘官，不自动扣费`
                  : '三次提醒都未回填则停止催复盘',
              },
            ]}
          />
          {!state.publishLogs.length && (
            <Button icon={<SendOutlined />} onClick={openPublishLog}>
              我已发布，去登记
            </Button>
          )}
        </>
      ) : (
        <Empty description="暂无状态" />
      )}
    </div>
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={640}
      className="content-publish-assistant"
      title={
        <span className="content-publish-assistant__title">
          <SendOutlined /> 发布助手
          <small>{state?.title ? `《${state.title}》` : '排期 · 复制发布包 · 登记 · 回填'}</small>
        </span>
      }
      extra={
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void loadState()}>
          刷新
        </Button>
      }
    >
      <Alert
        showIcon
        type="warning"
        className="content-publish-assistant__alert"
        message="自动分发已暂停，全部由人手动发布"
        description="为避免被平台判定违规，系统只做排期提醒、整理发布包和催回填数据，不会替你发布或读取账号。"
      />
      {stateError && (
        <Alert
          showIcon
          type="error"
          className="content-publish-assistant__alert"
          message={stateError}
          action={
            <Button size="small" onClick={() => void loadState()}>
              重试
            </Button>
          }
        />
      )}
      {loading && !state ? (
        <div className="content-publish-assistant__loading">
          <Spin />
        </div>
      ) : (
        <Tabs
          activeKey={tab}
          onChange={key =>
            setTab(TAB_KEYS.includes(key as PublishAssistantTab) ? (key as PublishAssistantTab) : 'schedule')
          }
          items={[
            { key: 'schedule', label: '排期', children: scheduleTab },
            { key: 'pack', label: '发布包', children: packTab },
            { key: 'metrics', label: '数据回填', children: metricsTab },
            { key: 'timeline', label: 'T+1/3/7', children: timelineTab },
          ]}
        />
      )}
    </Drawer>
  );
}
