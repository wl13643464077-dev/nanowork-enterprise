import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Collapse, Empty, Input, Modal, Select, Space, Spin, Tag, message } from 'antd';
import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
} from '@ant-design/icons';

import { api } from '../api/client';
import { UnifiedFilePicker, type UploadedFileRef } from './UnifiedFilePicker';
import './WechatDraftStudio.css';

type Source = {
  sourceType: 'content' | 'pipeline';
  sourceId: number;
  title: string;
  createdAt?: string;
  sourceDeepLink?: string;
  autoImageCount?: number;
  autoCoverAvailable?: boolean;
};

type WechatTheme = {
  key: string;
  name: string;
  emoji: string;
  color: string;
};

const statusMeta: Record<string, { label: string; color: string }> = {
  processing: { label: '正在准备素材', color: 'processing' },
  submitting: { label: '提交待对账', color: 'warning' },
  submitted: { label: '已送达待结算', color: 'processing' },
  done: { label: '已进入草稿箱', color: 'success' },
  blocked: { label: '已阻断', color: 'error' },
  failed: { label: '未送达', color: 'error' },
};

export default function WechatDraftStudio() {
  const [config, setConfig] = useState<any>(null);
  const [themes, setThemes] = useState<WechatTheme[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const [testing, setTesting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [mutation, setMutation] = useState('');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [sourceKey, setSourceKey] = useState('');
  const [author, setAuthor] = useState('');
  const [theme, setTheme] = useState('orange');
  const [coverFiles, setCoverFiles] = useState<UploadedFileRef[]>([]);
  const [imageFiles, setImageFiles] = useState<UploadedFileRef[]>([]);

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    try {
      const [configResult, themeResult, sourceResult, deliveryResult] = await Promise.all([
        api.get('/wechat-draft/config', { silent: true }),
        api.get('/wechat-draft/themes', { silent: true }),
        api.get('/wechat-draft/sources?limit=50', { silent: true }),
        api.get('/wechat-draft/deliveries?limit=30', { silent: true }),
      ]);
      setConfig(configResult.config || {});
      const nextThemes = Array.isArray(themeResult.themes) ? themeResult.themes : [];
      setThemes(nextThemes);
      setTheme(current =>
        nextThemes.some((item: WechatTheme) => item.key === current) ? current : themeResult.default || 'orange',
      );
      setSources(sourceResult.sources || []);
      setDeliveries(deliveryResult.deliveries || []);
    } catch (error: any) {
      if (!background) message.error(error?.message || '公众号投递台加载失败');
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 8000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    const deliveryId = Number(new URLSearchParams(window.location.search).get('wechatDeliveryId'));
    if (!Number.isSafeInteger(deliveryId) || deliveryId <= 0) return;
    const timer = window.setTimeout(() => {
      document.getElementById('wechat-drafts')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
    return () => window.clearTimeout(timer);
  }, []);

  const selected = useMemo(
    () => sources.find(source => `${source.sourceType}:${source.sourceId}` === sourceKey) || null,
    [sourceKey, sources],
  );
  const themesByKey = useMemo(() => new Map(themes.map(item => [item.key, item])), [themes]);

  const saveConfig = async () => {
    if (!appId.trim() && !appSecret.trim()) {
      message.warning('请输入需要更新的 AppID 或 AppSecret');
      return;
    }
    setSavingConfig(true);
    try {
      const result = await api.put('/wechat-draft/config', { appId, appSecret });
      setConfig(result.config || {});
      setAppId('');
      setAppSecret('');
      message.success('公众号凭据已保密保存，页面不会回显');
    } finally {
      setSavingConfig(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      await api.post('/wechat-draft/config/test', {});
      message.success('微信官方 API 连接成功');
    } finally {
      setTesting(false);
    }
  };

  const submit = async () => {
    if (!selected) {
      message.warning('请先选择一份已结算可用内容');
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.post('/wechat-draft/deliveries', {
        sourceType: selected.sourceType,
        sourceId: selected.sourceId,
        coverFileId: coverFiles[0]?.id || null,
        imageFileIds: imageFiles.map(file => file.id),
        author,
        theme,
      });
      message.success(result.created ? '投递已发起，可在任务中心持续查看' : '已命中同一幂等投递，不会重复扣费或重发');
      await load(true);
    } finally {
      setSubmitting(false);
    }
  };

  const reconcile = async (delivery: any) => {
    setMutation(`reconcile:${delivery.id}`);
    try {
      await api.post(`/wechat-draft/deliveries/${delivery.id}/reconcile`, {});
      message.success('已按隐藏 Marker 完成草稿箱核对');
      await load(true);
    } finally {
      setMutation('');
    }
  };

  const confirmNotDelivered = (delivery: any) => {
    let confirmation = '';
    Modal.confirm({
      title: '确认草稿未送达？',
      content: (
        <div>
          <p>请先登录微信公众号后台人工查看草稿箱。系统退回预授权前还会再做一次只读 Marker 核对。</p>
          <p>
            请完整输入：<strong>{delivery.title}</strong>
          </p>
          <Input
            onChange={event => {
              confirmation = event.target.value;
            }}
          />
        </div>
      ),
      okText: '确认未送达并退分',
      cancelText: '保留对账',
      okButtonProps: { danger: true },
      async onOk() {
        setMutation(`confirm:${delivery.id}`);
        try {
          await api.post(`/wechat-draft/deliveries/${delivery.id}/confirm-not-delivered`, {
            confirmedNoDraft: true,
            titleConfirmation: confirmation,
          });
          message.success('已确认未送达并全额退回预授权');
          await load(true);
        } finally {
          setMutation('');
        }
      },
    });
  };

  return (
    <section id="wechat-drafts" className="wechat-draft-studio">
      <header className="wechat-draft-studio__hero">
        <div>
          <span className="wechat-draft-studio__eyebrow">PAIHUO PARITY · OFFICIAL WECHAT API</span>
          <h2>微信公众号草稿投递</h2>
          <p>只在你显式点击后，把已结算可用的内容产物或分发官发布包送入草稿箱；群发仍由人工在微信后台确认。</p>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      </header>

      <Collapse
        className="wechat-draft-studio__config"
        items={[
          {
            key: 'config',
            label: (
              <Space>
                <SettingOutlined />
                微信官方 API 连接
                <Tag color={config?.configured ? 'success' : 'warning'}>{config?.configured ? '已配置' : '待配置'}</Tag>
              </Space>
            ),
            children: (
              <div className="wechat-draft-studio__config-form">
                <Alert
                  type="info"
                  showIcon
                  message="凭据仅保存在当前企业配置中，接口和页面都不回显 AppID / AppSecret"
                />
                <Input
                  value={appId}
                  onChange={event => setAppId(event.target.value)}
                  placeholder="AppID（已配置时可留空）"
                />
                <Input.Password
                  value={appSecret}
                  onChange={event => setAppSecret(event.target.value)}
                  placeholder="AppSecret（已配置时可留空）"
                  autoComplete="new-password"
                />
                <Space wrap>
                  <Button type="primary" loading={savingConfig} onClick={() => void saveConfig()}>
                    保密保存
                  </Button>
                  <Button loading={testing} disabled={!config?.configured} onClick={() => void testConnection()}>
                    测试官方 API
                  </Button>
                </Space>
              </div>
            ),
          },
        ]}
      />

      {loading && !config ? (
        <div className="wechat-draft-studio__loading">
          <Spin />
        </div>
      ) : (
        <div className="wechat-draft-studio__grid">
          <Card title="1. 选择已结算产物" bordered={false}>
            <Select
              showSearch
              value={sourceKey || undefined}
              placeholder="选择内容产物 / 分发官发布包"
              optionFilterProp="label"
              options={sources.map(source => ({
                value: `${source.sourceType}:${source.sourceId}`,
                label: `${source.sourceType === 'pipeline' ? '流水线发布包' : '内容产物'} #${source.sourceId} · ${source.title}`,
              }))}
              onChange={setSourceKey}
            />
            {!sources.length && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无通过交付门禁且已结算的内容" />
            )}
            {selected?.sourceType === 'pipeline' &&
              ((selected.autoImageCount || 0) > 0 || selected.autoCoverAvailable) && (
                <Alert
                  type="success"
                  showIcon
                  message={`已自动携带工位 5 正文图 ${selected.autoImageCount || 0} 张${
                    selected.autoCoverAvailable ? '，并使用工位 6 封面' : '；如无工位 6 封面，将以工位 5 首图兜底'
                  }`}
                />
              )}
            <span className="wechat-draft-studio__field-label">正文排版主题</span>
            <Select
              value={theme}
              aria-label="正文排版主题"
              options={themes.map(item => ({
                value: item.key,
                label: `${item.emoji} ${item.name}`,
              }))}
              onChange={setTheme}
            />
            <Input
              value={author}
              maxLength={8}
              onChange={event => setAuthor(event.target.value)}
              placeholder="作者名（可选，最多8字）"
            />
          </Card>

          <Card title="2. 选择租户内图片" bordered={false}>
            <span className="wechat-draft-studio__field-label">
              封面（可选，不选则按工位 6 → 正文首图 → 标题封面兜底）
            </span>
            <UnifiedFilePicker
              files={coverFiles}
              onChange={setCoverFiles}
              purpose="wechat-cover"
              maxFiles={1}
              multiple={false}
              compact
              label="上传 PNG/JPEG 封面"
            />
            <span className="wechat-draft-studio__field-label">正文图（可选，最多8张）</span>
            <UnifiedFilePicker
              files={imageFiles}
              onChange={setImageFiles}
              purpose="wechat-content-image"
              maxFiles={8}
              compact
              label="上传 PNG/JPEG 正文图"
            />
          </Card>

          <Card className="wechat-draft-studio__submit" bordered={false}>
            <SafetyCertificateOutlined />
            <div>
              <strong>显式人工触发</strong>
              <p>提交前失败全额退回预授权；提交超时则冻结重发，只按隐藏 Marker 核对。</p>
            </div>
            <Button
              type="primary"
              size="large"
              icon={<CloudUploadOutlined />}
              loading={submitting}
              disabled={!config?.configured || !selected}
              onClick={() => void submit()}
            >
              创建微信草稿
            </Button>
          </Card>
        </div>
      )}

      <div className="wechat-draft-studio__deliveries">
        <h3>最近投递</h3>
        {!deliveries.length ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未发起公众号草稿投递" />
        ) : (
          deliveries.map(delivery => {
            const meta = statusMeta[delivery.status] || { label: delivery.status, color: 'default' };
            return (
              <article key={delivery.id} className="wechat-draft-studio__delivery">
                <div>
                  <strong>{delivery.title}</strong>
                  <span>
                    {delivery.sourceType} #{delivery.sourceId} ·{' '}
                    {themesByKey.get(delivery.theme)?.name || delivery.theme || '橙心暖阳'} · {delivery.billing?.label}
                  </span>
                  {delivery.error && <small>{delivery.error}</small>}
                </div>
                <Space wrap>
                  <Tag color={meta.color}>{meta.label}</Tag>
                  {delivery.status === 'done' && <CheckCircleOutlined className="wechat-draft-studio__done" />}
                  {delivery.needsReconciliation && (
                    <Button
                      size="small"
                      loading={mutation === `reconcile:${delivery.id}`}
                      onClick={() => void reconcile(delivery)}
                    >
                      Marker 对账
                    </Button>
                  )}
                  {delivery.canConfirmNotDelivered && (
                    <Button
                      danger
                      size="small"
                      loading={mutation === `confirm:${delivery.id}`}
                      onClick={() => confirmNotDelivered(delivery)}
                    >
                      确认未送达
                    </Button>
                  )}
                  <Button size="small" href={delivery.deepLink}>
                    任务详情
                  </Button>
                </Space>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
