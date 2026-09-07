import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Select, Space, Tag, message } from 'antd';
import { api } from '../api/client';
import { Panel } from './Kit';

// 企业级模型路由（2026-09 宣讲会承诺：工作人员可自主分配适配不同需求的模型）。
// 只能在服务端白名单内选择；解析优先级 企业覆盖 > 平台全局 > 平台默认，由 GET /admin/model-routing 给出每项来源。

type CatalogItem = {
  id: string;
  label: string;
  tier?: string;
  note?: string;
  supported?: boolean;
  pricing?: { label: string; credits: number; unit: string };
  maxPerCall?: number;
};
type RoutingText = Record<string, string>;
type RoutingShape = { text?: RoutingText; image?: string; vision?: string; video?: string[]; videoDefault?: string };
type ProviderItem = { id: string; label: string; available: boolean };
type RoutingPayload = {
  providerId: string;
  effectiveProvider: string;
  providerOverride: string | null;
  defaultProvider: string;
  providers: ProviderItem[];
  effective: { text: RoutingText; image: string; vision: string; video: string[]; videoDefault: string };
  sources: {
    text: Record<string, string>;
    image: string;
    vision: string;
    videoDefault: string;
    hasTenantOverride: boolean;
  };
  override: RoutingShape | null;
  overrideUpdatedAt?: string | null;
  roles: { role: string; label: string }[];
  catalog: { text: CatalogItem[]; image: CatalogItem[]; vision: CatalogItem[]; video: CatalogItem[] };
};

// 每个岗位独立保存，店长与管理层不会相互覆盖。
export const TEXT_ROUTING_GROUPS: { key: string; label: string; roles: string[]; hint: string }[] = [
  { key: 'boss', label: '老板', roles: ['boss'], hint: '经营建议与决策' },
  { key: 'manager', label: '店长', roles: ['manager'], hint: '门店经营与日常安排' },
  { key: 'ops_director', label: '管理层', roles: ['ops_director'], hint: '运营分析与跨店管理' },
  { key: 'sales', label: '员工', roles: ['sales'], hint: '日常问答与文案' },
  { key: 'admin', label: '企业管理员', roles: ['admin'], hint: '企业管理工作' },
  { key: 'partner', label: '合伙人', roles: ['partner'], hint: '合作经营与分析' },
];

const SOURCE_LABEL: Record<string, string> = { tenant: '企业自定义', global: '平台全局', default: '平台默认' };
const SOURCE_COLOR: Record<string, string> = { tenant: 'blue', global: 'gold', default: 'default' };
const FALLBACK_PROVIDERS: ProviderItem[] = [
  { id: 'openlux', label: 'OpenLux', available: true },
  { id: '360', label: '360 智脑开放平台', available: true },
];

export function routingOptionLabel(item: CatalogItem) {
  const price = item.pricing?.label ? ` · ${item.pricing.label}` : '';
  return `${item.label}${price}`;
}

export function groupValue(text: RoutingText | undefined, roles: string[]) {
  if (!text) return undefined;
  const values = roles.map(r => text[r]).filter(Boolean);
  return values.length ? values[0] : undefined;
}

export function AdminModelRoutingPanel() {
  const [data, setData] = useState<RoutingPayload | null>(null);
  const [draft, setDraft] = useState<RoutingShape>({});
  const [previewProvider, setPreviewProvider] = useState('');
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [loadError, setLoadError] = useState('');

  const load = (provider?: string) =>
    api
      .get(`/admin/model-routing${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`, { silent: true })
      .then((d: RoutingPayload) => {
        setData(d);
        setDraft(d.override || {});
        setPreviewProvider(d.providerId || provider || d.effectiveProvider || d.defaultProvider || 'openlux');
        setLoadError('');
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : '加载失败'));
  useEffect(() => {
    load();
  }, []);

  const options = useMemo(() => {
    const toOptions = (items: CatalogItem[] = []) =>
      items.map(item => ({
        value: item.id,
        label: routingOptionLabel(item),
        title: item.note || '',
        disabled: item.supported === false,
      }));
    return {
      text: toOptions(data?.catalog.text),
      image: toOptions(data?.catalog.image),
      vision: toOptions(data?.catalog.vision),
      video: toOptions(data?.catalog.video),
    };
  }, [data]);

  if (loadError)
    return (
      <>
        <div className="admin-routing-wrap">
          <Alert type="warning" showIcon message="企业模型设置暂不可用" description={loadError} />
        </div>
      </>
    );
  if (!data)
    return (
      <>
        <div className="admin-panel-hint">加载中…</div>
      </>
    );

  const dirty =
    JSON.stringify(draft) !== JSON.stringify(data.override || {}) || previewProvider !== data.effectiveProvider;
  const effective = data.effective;
  const providers = data.providers?.length ? data.providers : FALLBACK_PROVIDERS;
  const providerLabel = (id?: string | null) => providers.find(item => item.id === id)?.label || id || '未配置';
  const currentText = (roles: string[]) => groupValue(draft.text, roles) ?? effective.text[roles[0]];
  const setGroup = (roles: string[], value?: string) =>
    setDraft(prev => {
      const text: RoutingText = { ...(prev.text || {}) };
      for (const role of roles) {
        if (value) text[role] = value;
        else delete text[role];
      }
      return { ...prev, text };
    });
  const setField = (key: 'image' | 'vision' | 'videoDefault', value?: string) =>
    setDraft(prev => {
      const next = { ...prev };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });

  const save = () => {
    setSaving(true);
    api
      .put('/admin/model-routing', { provider: previewProvider, routing: draft })
      .then((d: RoutingPayload) => {
        message.success('企业模型设置已保存，立即生效');
        setData(d);
        setDraft(d.override || {});
        setPreviewProvider(d.providerId || d.effectiveProvider || previewProvider);
      })
      .finally(() => setSaving(false));
  };
  const reset = () => {
    setSaving(true);
    api
      .put('/admin/model-routing', { reset: true })
      .then((d: RoutingPayload) => {
        message.success('已恢复平台推荐设置');
        setData(d);
        setDraft({});
        setPreviewProvider(d.providerId || d.effectiveProvider || d.defaultProvider || 'openlux');
      })
      .finally(() => setSaving(false));
  };

  const overrideCount =
    Object.keys(data.override?.text || {}).length +
    ['image', 'vision', 'videoDefault'].filter(k => (data.override as any)?.[k]).length;
  const sourceTag = (source: string) => (
    <Tag color={SOURCE_COLOR[source] || 'default'} className="admin-routing-source-tag">
      {SOURCE_LABEL[source] || source}
    </Tag>
  );

  return (
    <>
      <div className="admin-routing-wrap">
        <Panel
          title="企业模型设置（本企业）"
          extra={
            <Space size={8} wrap>
              <Button
                size="small"
                onClick={reset}
                disabled={saving || (!data.sources.hasTenantOverride && !data.providerOverride)}
              >
                恢复平台默认
              </Button>
              <Button size="small" type="primary" loading={saving} disabled={!dirty} onClick={save}>
                保存设置
              </Button>
            </Space>
          }
        >
          <Alert
            type={
              previewProvider !== data.effectiveProvider
                ? 'warning'
                : data.sources.hasTenantOverride
                  ? 'info'
                  : 'success'
            }
            showIcon
            className="admin-routing-summary"
            message={
              previewProvider !== data.effectiveProvider
                ? `正在预览 ${providerLabel(previewProvider)}，企业当前仍使用 ${providerLabel(data.effectiveProvider)}`
                : data.sources.hasTenantOverride || data.providerOverride
                  ? `当前生效来源：企业自定义 ${overrideCount} 项，其余沿用平台配置${
                      data.overrideUpdatedAt ? `（最近修改 ${String(data.overrideUpdatedAt).slice(0, 16)}）` : ''
                    }`
                  : '当前生效来源：平台配置（本企业未自定义）'
            }
            description={
              previewProvider !== data.effectiveProvider
                ? '切换仅用于预览该家的可用模型；点击“保存设置”后才会切换企业的实际调用通道。'
                : '分别选择老板、店长、管理层和员工使用的模型。用户定价统一按360基准价×2，与本企业选择哪家供应商无关。'
            }
          />
          <div className="admin-routing-row">
            <div className="admin-routing-label">
              <span>AI 供应商</span>
              <span className="admin-routing-hint">仅显示平台已配置的通道，不会向企业下发 Key</span>
            </div>
            <div className="admin-routing-control">
              <Select
                className="admin-routing-select"
                value={previewProvider}
                loading={switching}
                options={providers.map(item => ({
                  value: item.id,
                  label: `${item.label}${item.id === data.defaultProvider ? '（平台默认）' : ''}`,
                  disabled: item.available === false,
                }))}
                onChange={(provider: string) => {
                  setSwitching(true);
                  void load(provider).finally(() => setSwitching(false));
                }}
                aria-label="AI 供应商"
              />
              <Tag color={providers.find(item => item.id === previewProvider)?.available === false ? 'red' : 'green'}>
                {providers.find(item => item.id === previewProvider)?.available === false ? '平台未就绪' : '平台已配置'}
              </Tag>
            </div>
          </div>
          <div className="admin-routing-grid">
            {TEXT_ROUTING_GROUPS.map(group => (
              <div key={group.key} className="admin-routing-row">
                <div className="admin-routing-label">
                  <span>文本 · {group.label}</span>
                  <span className="admin-routing-hint">{group.hint}</span>
                </div>
                <div className="admin-routing-control">
                  <Select
                    className="admin-routing-select"
                    value={currentText(group.roles)}
                    options={options.text}
                    onChange={(v: string) => setGroup(group.roles, v)}
                    aria-label={`文本模型 · ${group.label}`}
                  />
                  {sourceTag(data.sources.text[group.roles[0]])}
                </div>
              </div>
            ))}
            <div className="admin-routing-row">
              <div className="admin-routing-label">
                <span>图片生成</span>
                <span className="admin-routing-hint">海报 / 菜品图</span>
              </div>
              <div className="admin-routing-control">
                <Select
                  className="admin-routing-select"
                  value={draft.image ?? effective.image}
                  options={options.image}
                  onChange={(v: string) => setField('image', v)}
                  aria-label="图片生成模型"
                />
                {sourceTag(data.sources.image)}
              </div>
            </div>
            <div className="admin-routing-row">
              <div className="admin-routing-label">
                <span>识图理解</span>
                <span className="admin-routing-hint">员工对话发图、票据识别</span>
              </div>
              <div className="admin-routing-control">
                <Select
                  className="admin-routing-select"
                  value={draft.vision ?? effective.vision}
                  options={options.vision}
                  onChange={(v: string) => setField('vision', v)}
                  aria-label="识图模型"
                />
                {sourceTag(data.sources.vision)}
              </div>
            </div>
            <div className="admin-routing-row">
              <div className="admin-routing-label">
                <span>视频默认模型</span>
                <span className="admin-routing-hint">内容生产仓生成视频时的默认选项</span>
              </div>
              <div className="admin-routing-control">
                <Select
                  className="admin-routing-select"
                  value={draft.videoDefault ?? effective.videoDefault}
                  options={options.video}
                  onChange={(v: string) => setField('videoDefault', v)}
                  aria-label="视频默认模型"
                />
                {sourceTag(data.sources.videoDefault)}
              </div>
            </div>
          </div>
          <div className="admin-search-security-note">
            设置仅对本企业生效；其他企业不受影响。企业只能选择平台已开放的供应商和模型，接口密钥始终由平台统一维护。
          </div>
        </Panel>
      </div>
    </>
  );
}
