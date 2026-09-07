import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Col, Input, InputNumber, Row, Select, Table, Tabs, Tag, message } from 'antd';
import { api, getUser } from '../api/client';
import { Panel } from './Kit';
import { RuntimeReadinessMatrix, readinessMeta } from './RuntimeReadiness';
import { AdminWebSearchPanel } from './AdminWebSearchPanel';
import { AdminMiniMaxH3Panel } from './AdminMiniMaxH3Panel';
import { AdminAmapPanel } from './AdminAmapPanel';
import '../pages/Admin.css';

const MONO = 'SFMono-Regular, Consolas, Menlo, monospace';
type ProviderSummary = { id: string; label: string; available: boolean };
const FALLBACK_PROVIDERS: ProviderSummary[] = [
  { id: 'openlux', label: 'OpenLux', available: true },
  { id: '360', label: '360 智脑开放平台', available: true },
];

// 平台入口的界面边界；服务端仍独立校验真实会话角色。
export default function PlatformApiConfig() {
  if (getUser()?.role !== 'platform_super') return null;
  return <ApiConfigEditor />;
}

function FieldRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
      <div style={{ width: 96, fontSize: 12.5, color: 'var(--ui-text-2)', flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}
const chip = (label: string, val: React.ReactNode) => (
  <div
    key={label}
    style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}
  >
    <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ui-text)' }}>{val ?? 0}</div>
    <div style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{label}</div>
  </div>
);

// ===== ⑤ 接口管理 =====
function ApiConfigEditor() {
  const [cfg, setCfg] = useState<any>(null);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [h3, setH3] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [rt, setRt] = useState<any>(null);
  const [bl, setBl] = useState<any>(null);
  const [loadError, setLoadError] = useState('');
  const load = ({ provider, initializeDraft = false }: { provider?: string; initializeDraft?: boolean } = {}) =>
    api
      .get(`/admin/api-config${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`)
      .then((d: any) => {
        setCfg(d);
        setSelectedProvider(d.selectedProvider || d.channel?.providerId || provider || d.defaultProvider || 'openlux');
        setLoadError('');
        // 状态刷新不能覆盖用户尚未保存的供应商、模型或计费编辑。
        if (!initializeDraft) return;
        setRt(d.routing || {});
        setBl(d.billing || {});
        setH3({
          pricePer15s768p: Number(d.h3?.pricing?.pricePer15s768p || 0),
          providerVerified: d.h3?.capability?.providerVerified === true,
          billingVerified: d.h3?.capability?.billingVerified === true,
          priceBasis: d.h3?.capability?.priceBasis || '',
        });
      })
      .catch((error: Error) => setLoadError(error.message || '配置读取失败'));
  useEffect(() => {
    void load({ initializeDraft: true });
  }, []);

  const testConn = () => {
    setTesting(true);
    setTestResult(null);
    api
      .post('/admin/api-config/test', { provider: selectedProvider })
      .then((result: any) => {
        setTestResult(result);
        return load({ provider: selectedProvider });
      })
      .finally(() => setTesting(false));
  };
  const save = () => {
    setSaving(true);
    api
      .put('/admin/api-config', {
        provider: selectedProvider,
        routing: rt,
        billing: { ...bl, marginMultiplier: 2 },
        ...(selectedProvider === '360' ? {} : { h3 }),
      })
      .then(() => {
        message.success('接口配置已保存，立即生效');
        return load({ provider: selectedProvider, initializeDraft: true });
      })
      .finally(() => setSaving(false));
  };
  const makeDefault = () => {
    setSettingDefault(true);
    api
      .put('/admin/api-config', { provider: selectedProvider, defaultProvider: selectedProvider })
      .then(() => {
        message.success('已设为平台默认供应商');
        return load({ provider: selectedProvider });
      })
      .finally(() => setSettingDefault(false));
  };

  if (loadError && !cfg)
    return (
      <Alert
        type="error"
        showIcon
        message="平台配置读取失败"
        description={loadError}
        action={
          <Button
            onClick={() => {
              void load({ initializeDraft: true });
            }}
          >
            重试
          </Button>
        }
      />
    );

  if (!cfg || !rt || !bl || !h3)
    return <div style={{ padding: 60, textAlign: 'center', color: 'var(--ui-muted)' }}>加载中…</div>;

  const setTextModel = (role: string, v: string) => setRt({ ...rt, text: { ...rt.text, [role]: v } });
  const setTextPrice = (model: string, field: 'in' | 'out', v: any) =>
    setBl({ ...bl, text: { ...bl.text, [model]: { ...bl.text[model], [field]: v ?? 0 } } });
  const setImagePrice = (model: string, v: any) => setBl({ ...bl, image: { ...bl.image, [model]: v ?? 0 } });
  const setVideoPrice = (model: string, v: any) => setBl({ ...bl, video: { ...bl.video, [model]: v ?? 0 } });
  const setMin = (k: string, v: any) => setBl({ ...bl, minBalance: { ...bl.minBalance, [k]: v ?? 0 } });
  const usage = cfg.usage || {};
  const providers: ProviderSummary[] = cfg.providers?.length ? cfg.providers : FALLBACK_PROVIDERS;
  const defaultProvider = cfg.defaultProvider || 'openlux';
  const is360 = selectedProvider === '360';
  const channelOf = (key: string) => cfg.readiness?.channels?.find((item: any) => item.key === key);
  const aiReadiness =
    cfg.channel?.readiness ||
    channelOf('ai') ||
    ({ effective: cfg.channel?.available ? 'configured_unverified' : 'degraded' } as any);
  const aiState = readinessMeta(aiReadiness);
  const searchReadiness = channelOf('web_search') || ({ effective: 'degraded', details: {} } as any);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {loadError && <Alert type="warning" message="状态刷新失败，编辑内容已保留" description={loadError} />}
      <Panel
        title="AI 供应商"
        extra={
          selectedProvider === defaultProvider ? (
            <Tag color="blue">平台默认</Tag>
          ) : (
            <Button size="small" loading={settingDefault} onClick={makeDefault}>
              设为平台默认
            </Button>
          )
        }
      >
        <Tabs
          activeKey={selectedProvider}
          onChange={provider => {
            setSwitching(true);
            setTestResult(null);
            void load({ provider, initializeDraft: true }).finally(() => setSwitching(false));
          }}
          items={providers.map(provider => ({
            key: provider.id,
            label: (
              <span>
                {provider.label} {provider.id === defaultProvider && <Tag color="blue">默认</Tag>}
                <Badge
                  status={provider.available ? 'success' : 'default'}
                  text={provider.available ? '已配置' : '未配置'}
                />
              </span>
            ),
          }))}
        />
        <div style={{ color: 'var(--ui-muted)', fontSize: 12 }}>
          {switching
            ? '正在读取该家的密钥状态和模型设置…'
            : '两家的 Key、模型和连接验证独立管理。切换页签只查看和编辑该家；修改平台默认需单独点击“设为平台默认”。'}
        </div>
      </Panel>
      <Row gutter={[12, 12]}>
        {/* A. 通道 */}
        <Col xs={24} lg={10}>
          <Panel
            title="A · AI通道"
            extra={<Badge status={aiState.badge} text={<span style={{ fontSize: 12 }}>{aiState.label}</span>} />}
          >
            <FieldRow label="服务商">
              <span style={{ fontWeight: 600, color: 'var(--ui-text)' }}>{cfg.channel.provider}</span>
            </FieldRow>
            <FieldRow label="Base URL">
              <Input value={cfg.channel.baseUrl} readOnly style={{ fontFamily: MONO, fontSize: 12.5 }} />
            </FieldRow>
            <FieldRow label="API Key">
              <Input
                value={cfg.channel.key}
                readOnly
                suffix={
                  <Tag
                    color={
                      cfg.channel.keySource === 'environment'
                        ? 'green'
                        : cfg.channel.keySource === 'legacy_db'
                          ? 'orange'
                          : 'default'
                    }
                  >
                    {cfg.channel.keySource === 'environment'
                      ? '环境变量'
                      : cfg.channel.keySource === 'legacy_db'
                        ? '旧配置兼容'
                        : '未配置'}
                  </Tag>
                }
                style={{ fontFamily: MONO, fontSize: 12.5 }}
              />
            </FieldRow>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
              <Button size="small" loading={testing} disabled={switching} onClick={testConn}>
                测试已保存的连接
              </Button>
              {testResult && (
                <Tag color={testResult.ok ? 'green' : 'red'} style={{ margin: 0 }}>
                  {testResult.ok ? `✓ 连接通过（目录返回${testResult.models}个模型）` : `✗ ${testResult.error}`}
                </Tag>
              )}
            </div>
            {testResult?.ok && testResult.modelChecks?.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                {testResult.modelChecks.map((item: { kind: string; label: string; model: string; listed: boolean }) => (
                  <Tag key={item.kind}>
                    {item.label} · {item.model} · {item.listed ? '目录已展示' : '目录未展示（仍可直接请求）'}
                  </Tag>
                ))}
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  目录展示与生成调用相互独立。Image2
                  会按配置的模型名直接请求；是否可用以生成接口实际返回为准。本次仅检查连接，不产生生成费用。
                </div>
                {testResult.imageAvailability && (
                  <Alert
                    style={{ marginTop: 8 }}
                    type={testResult.imageAvailability.verdict === 'configured_listed' ? 'info' : 'warning'}
                    showIcon
                    message={
                      testResult.imageAvailability.verdict === 'no_image_models'
                        ? '图片模型未在目录展示'
                        : testResult.imageAvailability.verdict === 'other_image_models_only'
                          ? '当前图片模型未在目录展示'
                          : '图片模型已在目录展示'
                    }
                    description={`${testResult.imageAvailability.message}。模型目录只用于连接参考，不代表生成能力或账号权限结论。Image2 当前仍需以真实生成验收结果为准。`}
                  />
                )}
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--ui-muted)', marginBottom: 10 }}>
              API Key 仅从服务端独立环境变量 <code>{is360 ? 'AI360_API_KEY' : 'OPENLUX_API_KEY'}</code>{' '}
              读取，不在数据库保存新明文。
              {cfg.channel.keySource === 'legacy_db' ? ' 当前正在兼容读取旧数据库配置，请尽快迁移到环境变量。' : ''}
              每家 Base URL
              由平台固定，避免密钥发往错误地址。配置存在不代表通道已连接，最近显式测试通过后才会显示验证有效。
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
              {chip('文本调用', usage.calls)}
              {chip('生图', usage.images)}
              {chip('生视频', usage.videos)}
              {chip('输入tokens', (usage.input ?? 0).toLocaleString())}
              {chip('输出tokens', (usage.output ?? 0).toLocaleString())}
              {chip('失败', usage.errors)}
            </div>
          </Panel>
        </Col>

        {/* B. 模型路由 */}
        <Col xs={24} lg={14}>
          <Panel title="B · 分层模型路由">
            {[
              ['boss', '老板'],
              ['ops_director', '管理层'],
              ['manager', '店长'],
              ['admin', '企业管理员'],
              ['partner', '合伙人'],
              ['sales', '员工'],
            ].map(([k, label]) => (
              <FieldRow key={k} label={<>文本 · {label}</>}>
                <Input
                  value={rt.text?.[k]}
                  onChange={e => setTextModel(k, e.target.value)}
                  style={{ fontFamily: MONO, fontSize: 12.5 }}
                />
              </FieldRow>
            ))}
            <FieldRow label="图片模型">
              <Input
                value={rt.image}
                onChange={e => setRt({ ...rt, image: e.target.value })}
                style={{ fontFamily: MONO, fontSize: 12.5 }}
              />
            </FieldRow>
            <FieldRow label="视频模型清单">
              <Select
                mode="tags"
                value={rt.video || []}
                style={{ width: '100%' }}
                onChange={(v: string[]) =>
                  setRt({ ...rt, video: v, videoDefault: v.includes(rt.videoDefault) ? rt.videoDefault : v[0] })
                }
                tokenSeparators={[',', '，']}
                placeholder="输入模型名后回车添加"
              />
            </FieldRow>
            <FieldRow label="默认视频模型">
              <Select
                value={rt.videoDefault}
                style={{ width: '100%' }}
                options={(rt.video || []).map((m: string) => ({ value: m, label: m }))}
                onChange={(v: string) => setRt({ ...rt, videoDefault: v })}
              />
            </FieldRow>
            <div
              style={{
                background: 'var(--ui-warning-surface)',
                borderRadius: 8,
                padding: '8px 10px',
                fontSize: 12,
                color: '#e0a253',
              }}
            >
              配置平台支持的视频模型。企业只能从已启用的清单中选择。
            </div>
          </Panel>
        </Col>

        <Col xs={24}>
          <AdminWebSearchPanel readiness={searchReadiness} onRefresh={load} />
        </Col>

        {!is360 && <AdminMiniMaxH3Panel config={cfg.h3} value={h3} onChange={setH3} />}
        <AdminAmapPanel readiness={channelOf('amap')} onRefresh={load} />
      </Row>

      <RuntimeReadinessMatrix matrix={cfg.readiness} />

      {/* D. 统一用户定价 */}
      <Panel title="统一用户定价">
        <Alert
          type="info"
          showIcon
          message="所有普通客户统一按360基准价 × 2 扣减算力余额"
          description={`${cfg.channel.provider}的实际扣费回执只用于记录平台采购成本、利润和对账，不会改变用户价格。最终生成失败时，用户本次扣款全额退回。`}
        />
      </Panel>
      <Panel
        title="D · 360统一基准价与预占"
        extra={
          <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>
            扣减积分 = 向上取整（360基准价¥ × 2 ÷ 积分单价）
          </span>
        }
      >
        <Row gutter={[12, 12]} style={{ marginBottom: 14 }}>
          <Col xs={12} md={5}>
            <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>积分单价（元/积分）</div>
            <InputNumber
              value={bl.creditYuan}
              min={0.0001}
              step={0.001}
              style={{ width: '100%' }}
              onChange={v => setBl({ ...bl, creditYuan: v ?? 0.01 })}
            />
          </Col>
          <Col xs={12} md={5}>
            <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>统一售价倍数</div>
            <InputNumber value={2} disabled min={1} step={0.1} style={{ width: '100%' }} />
          </Col>
          {[
            ['text', '文本'],
            ['image', '图片'],
            ['video', '视频'],
          ].map(([k, label]) => (
            <Col xs={8} md={4} key={k}>
              <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>最低余额 · {label}（分）</div>
              <InputNumber value={bl.minBalance?.[k]} min={0} style={{ width: '100%' }} onChange={v => setMin(k, v)} />
            </Col>
          ))}
        </Row>
        <p style={{ fontSize: 12, color: 'var(--ui-muted)' }}>
          下方是统一的360模型基准价，用于任务前预占和用户价格计算。选择 OpenLux 或 360 都使用这一套用户定价。
        </p>
        <Row gutter={[12, 12]}>
          <Col xs={24} lg={10}>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ui-text)', marginBottom: 8 }}>
              文本模型基准价（¥/百万token）
            </div>
            <Table
              size="small"
              rowKey="model"
              pagination={false}
              dataSource={Object.keys(bl.text || {}).map(m => ({ model: m }))}
              columns={
                [
                  {
                    title: '模型',
                    dataIndex: 'model',
                    render: (v: string) => (
                      <span style={{ fontFamily: MONO, fontSize: 12 }}>{v === 'default' ? 'default（兜底）' : v}</span>
                    ),
                  },
                  {
                    title: '输入¥',
                    key: 'in',
                    width: 100,
                    render: (_: any, r: any) => (
                      <InputNumber
                        size="small"
                        min={0}
                        step={0.5}
                        value={bl.text[r.model]?.in}
                        onChange={v => setTextPrice(r.model, 'in', v)}
                        style={{ width: '100%' }}
                      />
                    ),
                  },
                  {
                    title: '输出¥',
                    key: 'out',
                    width: 100,
                    render: (_: any, r: any) => (
                      <InputNumber
                        size="small"
                        min={0}
                        step={0.5}
                        value={bl.text[r.model]?.out}
                        onChange={v => setTextPrice(r.model, 'out', v)}
                        style={{ width: '100%' }}
                      />
                    ),
                  },
                ] as any
              }
            />
          </Col>
          <Col xs={24} lg={7}>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ui-text)', marginBottom: 8 }}>
              图片模型基准价（¥/张）
            </div>
            <Table
              size="small"
              rowKey="model"
              pagination={false}
              dataSource={Object.keys(bl.image || {}).map(m => ({ model: m }))}
              columns={
                [
                  {
                    title: '模型',
                    dataIndex: 'model',
                    render: (v: string) => (
                      <span style={{ fontFamily: MONO, fontSize: 12 }}>{v === 'default' ? 'default（兜底）' : v}</span>
                    ),
                  },
                  {
                    title: '单价¥',
                    key: 'p',
                    width: 110,
                    render: (_: any, r: any) => (
                      <InputNumber
                        size="small"
                        min={0}
                        step={0.1}
                        value={bl.image[r.model]}
                        onChange={v => setImagePrice(r.model, v)}
                        style={{ width: '100%' }}
                      />
                    ),
                  },
                ] as any
              }
            />
          </Col>
          <Col xs={24} lg={7}>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ui-text)', marginBottom: 8 }}>
              视频模型基准价（¥/15秒）
            </div>
            <Table
              size="small"
              rowKey="model"
              pagination={false}
              dataSource={Object.keys(bl.video || {}).map(m => ({ model: m }))}
              columns={
                [
                  {
                    title: '模型',
                    dataIndex: 'model',
                    render: (v: string) => (
                      <span style={{ fontFamily: MONO, fontSize: 12 }}>{v === 'default' ? 'default（兜底）' : v}</span>
                    ),
                  },
                  {
                    title: '单价¥',
                    key: 'p',
                    width: 110,
                    render: (_: any, r: any) => (
                      <InputNumber
                        size="small"
                        min={0}
                        step={1}
                        value={bl.video[r.model]}
                        onChange={v => setVideoPrice(r.model, v)}
                        style={{ width: '100%' }}
                      />
                    ),
                  },
                ] as any
              }
            />
          </Col>
        </Row>
      </Panel>

      <div style={{ textAlign: 'right' }}>
        <Button type="primary" size="large" loading={saving} disabled={switching} onClick={save}>
          保存{cfg.channel.provider}配置
        </Button>
      </div>
    </div>
  );
}
