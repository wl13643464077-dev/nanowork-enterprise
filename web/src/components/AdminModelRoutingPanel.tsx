import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
type RoutingPayload = {
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

// 面向老板的三档分组：老板 / 管理层 / 员工。存储仍按服务端 DEFAULT_ROUTING 的逐角色键。
export const TEXT_ROUTING_GROUPS: { key: string; label: string; roles: string[]; hint: string }[] = [
  { key: 'boss', label: '老板', roles: ['boss'], hint: '老板参谋、经营诊断等决策类任务' },
  {
    key: 'manager',
    label: '管理层',
    roles: ['ops_director', 'manager', 'admin'],
    hint: '运营总监 / 门店经理 / 系统管理员',
  },
  { key: 'staff', label: '员工', roles: ['sales', 'partner'], hint: '门店员工 / 合伙人日常问答与文案' },
];

const SOURCE_LABEL: Record<string, string> = { tenant: '企业自定义', global: '平台全局', default: '平台默认' };
const SOURCE_COLOR: Record<string, string> = { tenant: 'blue', global: 'gold', default: 'default' };

export function routingOptionLabel(item: CatalogItem) {
  const price = item.pricing?.label ? ` · ${item.pricing.label}` : '';
  return `${item.label}${price}`;
}

export function groupValue(text: RoutingText | undefined, roles: string[]) {
  if (!text) return undefined;
  const values = roles.map(r => text[r]).filter(Boolean);
  return values.length ? values[0] : undefined;
}

// platformConfig：同页签下方的平台级配置区（Admin.tsx 的 ApiConfig），由本面板托管渲染，
// 让 Admin.tsx 的挂载保持一行、不再增长。
export function AdminModelRoutingPanel({ platformConfig }: { platformConfig?: ReactNode } = {}) {
  const [data, setData] = useState<RoutingPayload | null>(null);
  const [draft, setDraft] = useState<RoutingShape>({});
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');

  const load = () =>
    api
      .get('/admin/model-routing', { silent: true })
      .then((d: RoutingPayload) => {
        setData(d);
        setDraft(d.override || {});
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
          <Alert type="warning" showIcon message="企业模型路由暂不可用" description={loadError} />
        </div>
        {platformConfig}
      </>
    );
  if (!data)
    return (
      <>
        <div className="admin-panel-hint">加载中…</div>
        {platformConfig}
      </>
    );

  const dirty = JSON.stringify(draft) !== JSON.stringify(data.override || {});
  const effective = data.effective;
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
      .put('/admin/model-routing', { routing: draft })
      .then((d: RoutingPayload) => {
        message.success('企业模型路由已保存，立即生效');
        setData(d);
        setDraft(d.override || {});
      })
      .finally(() => setSaving(false));
  };
  const reset = () => {
    setSaving(true);
    api
      .put('/admin/model-routing', { reset: true })
      .then((d: RoutingPayload) => {
        message.success('已恢复平台默认路由');
        setData(d);
        setDraft({});
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
          title="企业模型路由（本企业）"
          extra={
            <Space size={8} wrap>
              <Button size="small" onClick={reset} disabled={saving || !data.sources.hasTenantOverride}>
                恢复平台默认
              </Button>
              <Button size="small" type="primary" loading={saving} disabled={!dirty} onClick={save}>
                保存路由
              </Button>
            </Space>
          }
        >
          <Alert
            type={data.sources.hasTenantOverride ? 'info' : 'success'}
            showIcon
            className="admin-routing-summary"
            message={
              data.sources.hasTenantOverride
                ? `当前生效来源：企业自定义 ${overrideCount} 项，其余沿用平台配置${
                    data.overrideUpdatedAt ? `（最近修改 ${String(data.overrideUpdatedAt).slice(0, 16)}）` : ''
                  }`
                : '当前生效来源：平台配置（本企业未自定义）'
            }
            description="按岗位给不同任务分配模型：决策类用旗舰模型，日常文案用经济模型可明显降低积分消耗。下拉项标注的积分为按价目表折算的参考值，实际按 token 用量结算。"
          />
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
            可选模型由平台白名单统一维护（含定位说明与参考价目），企业不能填写清单外的模型名；平台总部修改全局路由不会覆盖本企业已保存的自定义项。
          </div>
        </Panel>
      </div>
      {platformConfig}
    </>
  );
}
