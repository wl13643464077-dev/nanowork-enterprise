import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  message,
} from 'antd';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { clearAuth, getUser } from '../api/client';
import {
  TrialHistory,
  TrialLeadDrawer,
  TrialStatus,
  formatTrialTime,
  trialCost,
  trialError,
  trialProviderLabel,
  trialRequest,
  trialTurnLimit,
  trialUsageState,
} from './TrialShared';
import type { TrialConversation, TrialEmployee, TrialLead, TrialProviderId } from './TrialShared';
import { trialEmployeeName } from './TrialEmployeePicker';
import TrialAnalyticsPanel from './TrialAnalyticsPanel';
import './Trial.css';

type TesterProviderState = {
  id: TrialProviderId;
  label: string;
  available: boolean;
  keyConfigured: boolean;
  keyMasked?: string;
};
type TesterProfile = {
  name: string;
  phone: string;
  status: string;
  keyConfigured?: boolean;
  keyMasked?: string;
  activeProvider?: TrialProviderId;
  providers?: Array<{
    id: string;
    label?: string;
    available?: boolean;
    configured?: boolean;
    keyConfigured?: boolean;
    maskedKey?: string;
    keyMasked?: string;
  }>;
};
type PersonalUsage = { knownCostCny: number; unverifiedCostCount: number };
type Invitation = {
  id: number;
  token: string;
  title: string;
  url: string;
  qrDataUrl: string;
  salesPhone: string;
  status: string;
  createdAt: string;
  provider?: string;
  turnLimit?: number;
  recipientNote?: string;
  autoApprove?: boolean;
  leadCount?: number;
};

const PROVIDER_GUIDES: Record<TrialProviderId, { home: string; docs: string; account?: string }> = {
  openlux: {
    home: 'https://api.openlux.ai/',
    docs: 'https://doc.openlux.ai/',
  },
  '360': {
    home: 'https://ai.360.com/open/zh/login',
    docs: 'https://ai.360.com/docs/quick-start',
    account: 'https://ai.360.com/open/zh/platform/keys',
  },
};

function providerId(value: unknown, fallback: TrialProviderId = '360'): TrialProviderId {
  return value === 'openlux' || value === '360' ? value : fallback;
}

export function testerProviderStates(
  value: TesterProfile['providers'],
  activeProvider: TrialProviderId,
  legacy: Pick<TesterProfile, 'keyConfigured' | 'keyMasked'> = {},
): TesterProviderState[] {
  const rows = Array.isArray(value)
    ? value
        .filter(item => item?.id === 'openlux' || item?.id === '360')
        .map(item => ({
          id: providerId(item.id),
          label: item.label || trialProviderLabel(item.id),
          available: item.available !== false,
          keyConfigured:
            item.configured ??
            item.keyConfigured ??
            (item.id === activeProvider ? Boolean(legacy.keyConfigured) : false),
          keyMasked: item.maskedKey || item.keyMasked || (item.id === activeProvider ? legacy.keyMasked : undefined),
        }))
    : [];
  if (!rows.some(item => item.id === activeProvider))
    rows.push({
      id: activeProvider,
      label: trialProviderLabel(activeProvider),
      available: true,
      keyConfigured: Boolean(legacy.keyConfigured),
      keyMasked: legacy.keyMasked,
    });
  return rows;
}

export function testerPortalTab(value: string | null): string {
  if (value === 'work') return 'history';
  return ['analytics', 'key', 'invitations', 'leads', 'history', 'guide', 'password'].includes(value || '')
    ? value!
    : 'analytics';
}

export default function TesterPortal({ embedded = false }: { embedded?: boolean } = {}) {
  const nav = useNavigate();
  const loc = useLocation();
  const tab = testerPortalTab(new URLSearchParams(loc.search).get('tab'));
  const setTab = (next: string) => {
    const search = new URLSearchParams(loc.search);
    search.set('tab', testerPortalTab(next));
    nav({ pathname: loc.pathname, search: search.toString() }, { replace: true });
  };
  const Root = embedded ? 'section' : 'main';
  const [profile, setProfile] = useState<TesterProfile | null>(null);
  const [activeProvider, setActiveProvider] = useState<TrialProviderId>('360');
  const [providers, setProviders] = useState<TesterProviderState[]>([]);
  const [trialEmployees, setTrialEmployees] = useState<TrialEmployee[]>([]);
  const [conversations, setConversations] = useState<TrialConversation[]>([]);
  const [personalUsage, setPersonalUsage] = useState<PersonalUsage | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [leads, setLeads] = useState<TrialLead[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [leadId, setLeadId] = useState<number | null>(null);
  const [analyticsRefresh, setAnalyticsRefresh] = useState(0);
  const [keyForm] = Form.useForm();
  const [passwordForm] = Form.useForm();
  const [invitationForm] = Form.useForm();
  const load = useCallback(async () => {
    setError('');
    try {
      const result = await trialRequest('/tester/me');
      const nextProfile: TesterProfile = result.profile || result.tester || result;
      const nextProvider = providerId(result.activeProvider || nextProfile.activeProvider);
      setProfile(nextProfile);
      setActiveProvider(nextProvider);
      setProviders(testerProviderStates(result.providers || nextProfile.providers, nextProvider, nextProfile));
      setTrialEmployees(result.trialEmployees || []);
      const [history, links, customers, analytics] = await Promise.all([
        trialRequest('/tester/conversations'),
        trialRequest('/tester/invitations'),
        trialRequest('/tester/leads'),
        trialRequest('/tester/analytics?days=all&scope=customers'),
      ]);
      setConversations(Array.isArray(history) ? history : history.conversations || []);
      setInvitations(Array.isArray(links) ? links : links.invitations || []);
      setLeads(Array.isArray(customers) ? customers : customers.leads || []);
      setPersonalUsage(analytics.personalSummary || null);
      setAnalyticsRefresh(value => value + 1);
    } catch (error) {
      setError(trialError(error));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void load();
    });
    return () => cancelAnimationFrame(frame);
  }, [load]);

  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError('');
    try {
      await action();
    } catch (error) {
      setError(trialError(error));
    } finally {
      setBusy('');
    }
  };
  const reviewLead = (lead: TrialLead, status: string) =>
    run(`lead-${lead.id}`, async () => {
      await trialRequest(`/tester/leads/${lead.id}`, { method: 'PATCH', body: { status } });
      message.success('客户状态已更新');
      await load();
    });
  const active = profile?.status === 'approved';
  const activeProviderState =
    providers.find(item => item.id === activeProvider) ||
    testerProviderStates(undefined, activeProvider, profile || {})[0];
  const activeProviderLabel = activeProviderState.label || trialProviderLabel(activeProvider);
  const activeKeyConfigured = activeProviderState.keyConfigured;
  const providerGuide = PROVIDER_GUIDES[activeProvider];

  const selectProvider = (value: string | number) => {
    const nextProvider = providerId(value, activeProvider);
    if (nextProvider === activeProvider) return;
    void run('provider', async () => {
      await trialRequest('/tester/provider', { method: 'PUT', body: { provider: nextProvider } });
      keyForm.resetFields();
      message.success(`已切换到${trialProviderLabel(nextProvider)}`);
      await load();
    });
  };

  return (
    <Root className={`trial-shell tester-shell${embedded ? ' tester-shell--embedded' : ''}`} aria-label="测试员后台">
      {!embedded && (
        <header className="trial-header">
          <Link to="/tester" className="trial-brand">
            纳米 Work <span>测试员后台</span>
          </Link>
          <Space wrap>
            <Link to="/">返回产品首页</Link>
            <span>{profile?.name || getUser()?.name}</span>
            <Button
              onClick={() => {
                clearAuth();
                nav('/login');
              }}
            >
              退出登录
            </Button>
          </Space>
        </header>
      )}
      <section className="tester-intro">
        <div>
          {!embedded && <h1>测试员后台</h1>}
          <p className="tester-intro-description">管理个人 API 账户、邀请客户，跟进体验使用情况。</p>
          <p className="trial-muted">
            本人账号 · {profile ? `当前使用 ${activeProviderLabel}` : '正在读取供应商'} · 客户体验次数由你设置
          </p>
        </div>
        <Space wrap>
          <Button type="primary" onClick={() => nav('/employees')}>
            去数字员工
          </Button>
          <Button onClick={() => void load()} loading={loading}>
            刷新记录
          </Button>
        </Space>
      </section>
      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          className="trial-notice"
          action={
            <Button size="small" onClick={() => void load()}>
              重新加载
            </Button>
          }
        />
      )}
      {loading && !profile ? (
        <Spin />
      ) : (
        <>
          {profile && !active && (
            <Alert
              type="warning"
              showIcon
              className="trial-notice"
              message="账号当前不可使用"
              description="请联系平台管理员审核或恢复账号。暂停期间，关联的客户体验也不可发起新请求。"
            />
          )}
          {profile && !activeKeyConfigured && (
            <Alert
              type="info"
              showIcon
              className="trial-notice"
              message={`先绑定你的${activeProviderLabel}个人 API Key`}
              description={`本人测试和新生成的客户邀请将使用${activeProviderLabel}，费用直接由你的供应商账户承担。纳米 Work 不重复扣减平台余额。`}
              action={<Button onClick={() => setTab('key')}>去设置</Button>}
            />
          )}
          <Tabs
            activeKey={tab}
            onChange={setTab}
            items={[
              {
                key: 'analytics',
                label: '客户看板',
                children: (
                  <section className="trial-panel">
                    <TrialAnalyticsPanel refreshKey={analyticsRefresh} />
                  </section>
                ),
              },
              {
                key: 'key',
                label: '供应商与个人 Key',
                children: (
                  <section className="trial-panel tester-narrow">
                    <h2>个人 API 账户</h2>
                    <p className="trial-muted">
                      当前先主用 360 智脑。请在 360 官方平台申请并填写个人
                      Key，再去数字员工派活。新任务和新生成的体验二维码使用当前供应商；已分享的二维码继续使用创建时绑定的供应商。
                    </p>
                    <Segmented
                      block
                      aria-label="选择测试供应商"
                      value={activeProvider}
                      disabled={busy === 'provider'}
                      onChange={selectProvider}
                      options={providers.map(provider => ({
                        value: provider.id,
                        label: `${provider.label}${provider.keyConfigured ? ' · 已绑定' : ''}`,
                        disabled: !provider.available,
                      }))}
                    />
                    <Space wrap style={{ marginTop: 14, marginBottom: 8 }}>
                      {providers.map(provider => (
                        <Tag key={provider.id} color={provider.keyConfigured ? 'green' : undefined}>
                          {provider.label}：{provider.keyConfigured ? provider.keyMasked || '已配置' : '未配置'}
                        </Tag>
                      ))}
                    </Space>
                    {!activeProviderState.available && (
                      <Alert
                        type="warning"
                        showIcon
                        className="trial-notice"
                        message={`${activeProviderLabel}当前不可用，请选择其他供应商`}
                      />
                    )}
                    <h2>连接你的{activeProviderLabel}账户</h2>
                    <p>
                      前往{' '}
                      <a href={providerGuide.home} target="_blank" rel="noreferrer">
                        {activeProviderLabel}
                      </a>{' '}
                      注册并申请 API Key。接入说明：
                      <a href={providerGuide.docs} target="_blank" rel="noreferrer">
                        官方文档
                      </a>
                      。
                    </p>
                    {providerGuide.account && (
                      <p>
                        <a href={providerGuide.account} target="_blank" rel="noreferrer">
                          创建 / 管理 API Key
                        </a>
                      </p>
                    )}
                    <Alert
                      type="info"
                      showIcon
                      message={`费用直接记在你的${activeProviderLabel}账户`}
                      description={`本人使用和新生成的客户邀请都使用你的${activeProviderLabel}个人 Key。平台不向测试员重复扣算力余额，请在供应商账户中核对余额与账单。`}
                    />
                    <p>
                      当前状态：
                      {activeKeyConfigured ? (
                        <>
                          <TrialStatus status="active" /> <code>{activeProviderState.keyMasked || 'Key 已保存'}</code>
                        </>
                      ) : (
                        '尚未绑定'
                      )}
                    </p>
                    <Form
                      form={keyForm}
                      layout="vertical"
                      onFinish={values =>
                        void run('key', async () => {
                          await trialRequest('/tester/key', {
                            method: 'PUT',
                            body: { provider: activeProvider, apiKey: values.apiKey.trim() },
                          });
                          keyForm.resetFields();
                          message.success(`${activeProviderLabel}个人 Key 已保存`);
                          await load();
                        })
                      }
                    >
                      <Form.Item
                        name="apiKey"
                        label={
                          activeKeyConfigured ? `更换${activeProviderLabel} API Key` : `${activeProviderLabel} API Key`
                        }
                        rules={[{ required: true, message: '请粘贴完整 API Key' }]}
                      >
                        <Input.Password autoComplete="off" placeholder={`粘贴从${activeProviderLabel}获取的完整 Key`} />
                      </Form.Item>
                      <Space>
                        <Button
                          type="primary"
                          htmlType="submit"
                          loading={busy === 'key'}
                          disabled={!active || !activeProviderState.available}
                        >
                          保存 Key
                        </Button>
                        {activeKeyConfigured && (
                          <Button
                            danger
                            disabled={!!busy}
                            onClick={() =>
                              Modal.confirm({
                                title: `解除${activeProviderLabel}个人 Key？`,
                                content: `解除后，使用${activeProviderLabel}的本人对话和客户邀请将无法继续生成内容。`,
                                onOk: () =>
                                  run('key-delete', async () => {
                                    await trialRequest('/tester/key', {
                                      method: 'DELETE',
                                      body: { provider: activeProvider },
                                    });
                                    await load();
                                  }),
                              })
                            }
                          >
                            解除绑定
                          </Button>
                        )}
                      </Space>
                    </Form>
                  </section>
                ),
              },
              {
                key: 'invitations',
                label: '体验二维码',
                children: (
                  <>
                    <section className="trial-panel">
                      <h2>邀请客户体验</h2>
                      <div className="trial-invite-scenarios" aria-label="客户扫码可选场景">
                        {trialEmployees.map(employee => (
                          <span key={employee.id}>{trialEmployeeName(employee)}</span>
                        ))}
                      </div>
                      <p className="trial-muted">
                        新二维码固定使用当前选择的{activeProviderLabel}个人
                        Key。之后切换供应商不会改变已经分享的二维码。
                        客户扫码填写资料后即可在以上五个场景中选择（新码默认自动开通，可在「更多设置」改为人工同意）。这五位都按正式岗位完整能力执行。每位客户独立获得你设置的次数，五个员工共用总次数，切换员工不增加次数。
                      </p>
                      <p className="trial-muted trial-small">
                        扫码页这五个岗位与正式工作台同一套能力：选址含调研和竞品核验，店长和巡店出完整报告，小红书和带货按完整岗位方案交付。没有照片或素材时，先给完整文案与制作清单，不假装图片或视频已经生成。
                      </p>
                      <Form
                        form={invitationForm}
                        initialValues={{ salesPhone: profile?.phone, turnLimit: 2, autoApprove: true }}
                        layout="vertical"
                        className="trial-invite-form"
                        onFinish={values =>
                          void run('invite', async () => {
                            await trialRequest('/tester/invitations', { method: 'POST', body: values });
                            message.success('体验二维码已生成，复制链接或下载二维码发给客户即可');
                            invitationForm.resetFields(['recipientNote']);
                            await load();
                          })
                        }
                      >
                        <Space.Compact block className="trial-invite-quick">
                          <Form.Item name="recipientNote" noStyle>
                            <Input placeholder="发给谁？例如 张总·火锅店（选填，方便你和平台追踪）" maxLength={40} />
                          </Form.Item>
                          <Button
                            htmlType="submit"
                            type="primary"
                            loading={busy === 'invite'}
                            disabled={!active || !activeKeyConfigured || !activeProviderState.available}
                          >
                            一键生成体验码
                          </Button>
                        </Space.Compact>
                        <Collapse
                          ghost
                          size="small"
                          items={[
                            {
                              key: 'more',
                              label: '更多设置（销售手机号、体验次数、开通方式）',
                              forceRender: true,
                              children: (
                                <>
                                  <Form.Item name="title" label="邀请名称">
                                    <Input placeholder="默认：纳米Work · 餐饮数字员工体验" maxLength={60} />
                                  </Form.Item>
                                  <Form.Item
                                    name="salesPhone"
                                    label="销售手机号"
                                    rules={[
                                      { required: true },
                                      { pattern: /^1\d{10}$/, message: '请输入 11 位手机号' },
                                    ]}
                                  >
                                    <Input inputMode="tel" maxLength={11} />
                                  </Form.Item>
                                  <Form.Item
                                    name="turnLimit"
                                    label="每位客户体验次数"
                                    rules={[
                                      { required: true, message: '请设置每位客户的体验次数' },
                                      { type: 'number', min: 1, max: 100, message: '请输入 1 至 100 次' },
                                      {
                                        validator: (_, value) =>
                                          value == null || Number.isInteger(value)
                                            ? Promise.resolve()
                                            : Promise.reject(new Error('请输入整数次数')),
                                      },
                                    ]}
                                  >
                                    <InputNumber min={1} max={100} precision={0} addonAfter="次" />
                                  </Form.Item>
                                  <Form.Item name="autoApprove" valuePropName="checked">
                                    <Checkbox>
                                      客户扫码填写资料后自动开通（取消后需你在「客户与使用记录」逐个同意）
                                    </Checkbox>
                                  </Form.Item>
                                </>
                              ),
                            },
                          ]}
                        />
                      </Form>
                      <p className="trial-muted trial-small">
                        每次成功回复计 1 次，失败不计次。默认 2 次，可设 1 至 100
                        次；创建后次数固定，需要其他次数请新建二维码。已有客户的额度不会因换码或再次申请而重置。
                      </p>
                    </section>
                    <div className="trial-invitations">
                      {invitations.length ? (
                        invitations.map(item => (
                          <article className="trial-panel" key={item.id}>
                            <div className="trial-section-title">
                              <h3>{item.title || '数字员工体验'}</h3>
                              <TrialStatus status={item.status} />
                            </div>
                            <img
                              className="trial-qr"
                              src={item.qrDataUrl}
                              alt={`${item.title || '数字员工体验'}邀请二维码`}
                            />
                            {item.recipientNote && <p>发给：{item.recipientNote}</p>}
                            <p>
                              <Tag color={item.autoApprove ? 'green' : 'orange'}>
                                {item.autoApprove ? '扫码即开通' : '需你逐个同意'}
                              </Tag>
                              已有 {item.leadCount ?? 0} 位客户
                            </p>
                            <p>销售手机号：{item.salesPhone}</p>
                            <p>体验供应商：{trialProviderLabel(item.provider || '360')}</p>
                            <p>每位客户：{trialTurnLimit(item.turnLimit)} 次成功体验（五个员工共用）</p>
                            <Space wrap>
                              <Button
                                onClick={() =>
                                  navigator.clipboard
                                    .writeText(item.url)
                                    .then(() => message.success('体验链接已复制'))
                                    .catch(() => message.error('复制失败'))
                                }
                              >
                                复制链接
                              </Button>
                              <Button href={item.qrDataUrl} download={`纳米Work体验二维码-${item.id}.png`}>
                                下载二维码
                              </Button>
                              <Button href={item.url} target="_blank" rel="noreferrer">
                                预览 H5
                              </Button>
                              {['active', 'approved'].includes(item.status) && (
                                <Button
                                  danger
                                  onClick={() =>
                                    Modal.confirm({
                                      title: '停用这个体验二维码？',
                                      content: '已分享的链接将停止接受新体验。',
                                      onOk: () =>
                                        run(`invite-${item.id}`, async () => {
                                          await trialRequest(`/tester/invitations/${item.id}`, { method: 'DELETE' });
                                          await load();
                                        }),
                                    })
                                  }
                                >
                                  停用
                                </Button>
                              )}
                            </Space>
                          </article>
                        ))
                      ) : (
                        <Empty description="绑定 Key 后生成第一个体验二维码" />
                      )}
                    </div>
                  </>
                ),
              },
              {
                key: 'leads',
                label: `客户与使用记录（${leads.length}）`,
                children: (
                  <section className="trial-panel">
                    <h2>邀请来的客户</h2>
                    <Table
                      rowKey="id"
                      dataSource={leads}
                      scroll={{ x: 950 }}
                      pagination={{ pageSize: 10 }}
                      columns={[
                        {
                          title: '客户',
                          dataIndex: 'name',
                          render: (_, row) => (
                            <>
                              <strong>{row.name}</strong>
                              <div>{row.phone}</div>
                              <div className="trial-muted">{row.storeName}</div>
                              {row.recipientNote && (
                                <div className="trial-muted">来自：发给 {row.recipientNote} 的体验码</div>
                              )}
                              {row.autoApproved && <Tag color="green">扫码自动开通</Tag>}
                            </>
                          ),
                        },
                        { title: '来源', dataIndex: 'invitationTitle' },
                        { title: '供应商', dataIndex: 'provider', render: value => trialProviderLabel(value || '360') },
                        {
                          title: '状态',
                          dataIndex: 'status',
                          render: status => <TrialStatus status={status} />,
                          filters: [
                            { text: '待审核', value: 'pending' },
                            { text: '已开通', value: 'approved' },
                            { text: '未通过', value: 'rejected' },
                            { text: '已暂停', value: 'paused' },
                          ],
                          onFilter: (value, row) => row.status === value,
                        },
                        {
                          title: '已使用',
                          dataIndex: 'usedTurns',
                          render: (value, row) => `${value || 0} / ${trialTurnLimit(row.turnLimit)} 次`,
                          filters: [
                            { text: '尚未使用', value: 'unused' },
                            { text: '使用中', value: 'active' },
                            { text: '已用完', value: 'exhausted' },
                          ],
                          onFilter: (value, row) => trialUsageState(row) === value,
                        },
                        { title: '最近使用', dataIndex: 'lastUsedAt', render: formatTrialTime },
                        {
                          title: '操作',
                          render: (_, row) => (
                            <Space wrap>
                              <Button size="small" onClick={() => setLeadId(row.id)}>
                                输入与结果
                              </Button>
                              {row.status !== 'approved' && (
                                <Button
                                  type="primary"
                                  size="small"
                                  loading={busy === `lead-${row.id}`}
                                  onClick={() => void reviewLead(row, 'approved')}
                                >
                                  {row.status === 'paused' ? '恢复' : '同意体验'}
                                </Button>
                              )}
                              {row.status === 'pending' && (
                                <Button size="small" onClick={() => void reviewLead(row, 'rejected')}>
                                  拒绝
                                </Button>
                              )}
                              {row.status === 'approved' && (
                                <Button size="small" danger onClick={() => void reviewLead(row, 'paused')}>
                                  暂停
                                </Button>
                              )}
                            </Space>
                          ),
                        },
                      ]}
                    />
                  </section>
                ),
              },
              {
                key: 'history',
                label: '历史文字测试',
                children: (
                  <section className="trial-panel">
                    <div className="trial-section-title">
                      <h2>历史文字测试</h2>
                      <span className="trial-muted">
                        本人历史已核实成本 {trialCost(personalUsage?.knownCostCny)}
                        {personalUsage?.unverifiedCostCount ? ` · ${personalUsage.unverifiedCostCount} 次待核实` : ''}
                      </span>
                    </div>
                    <p className="trial-muted">
                      这里仅查看旧版文字测试的最近 100
                      条输入与结果。新任务请到「餐饮数字员工」派活，正式业务记录统一在「任务中心」查看。
                    </p>
                    <Space wrap className="tester-history-links">
                      <Button onClick={() => nav('/employees')}>去数字员工</Button>
                      <Button onClick={() => nav('/tasks')}>查看任务中心</Button>
                    </Space>
                    <TrialHistory conversations={conversations} showCost />
                  </section>
                ),
              },
              {
                key: 'guide',
                label: '使用指南',
                children: (
                  <section className="trial-panel tester-narrow">
                    <h2>从申请到邀请客户</h2>
                    <ol className="trial-guide">
                      <li>
                        <strong>申请测试员账号。</strong>填写本人姓名、手机号，设置登录账号和密码。平台审核通过后登录。
                      </li>
                      <li>
                        <strong>开通个人 API 账户。</strong>当前先主用 360 智脑，到 360 官方平台创建 API
                        Key，并确认账户有可用额度。
                      </li>
                      <li>
                        <strong>绑定 Key。</strong>粘贴当前供应商的个人
                        Key，然后点击「去数字员工」发起任务。两家供应商的 Key 分开保存，切换时不会互相覆盖。
                      </li>
                      <li>
                        <strong>选择数字员工。</strong>
                        在完整产品的「餐饮数字员工」中按部门或需求搜索岗位并派活，任务结果到「任务中心」查看。「历史文字测试」仅保留旧记录。客户扫码的
                        H5 提供五个满血岗位。
                      </li>
                      <li>
                        <strong>一键生成体验码。</strong>
                        到「体验二维码」，填一下「发给谁」（选填），点「一键生成体验码」，复制链接或下载二维码发给客户。
                        销售手机号、每位客户次数（默认 2 次）和开通方式都有默认值，需要时在「更多设置」里改。
                        客户扫码可选选址、超级店长、巡店、小红书种草、AI 带货五个满血场景，调用使用此二维码绑定的个人
                        Key。
                      </li>
                      <li>
                        <strong>客户扫码即用。</strong>
                        新生成的体验码默认扫码填写资料后自动开通，不用逐个点同意；每位客户的姓名、手机号、来自哪个体验码、发给谁都会记录在「客户与使用记录」。
                        想人工把关时，在「更多设置」取消自动开通。每位客户独立获得设定的额度，五个场景共用总次数，每次成功回复计
                        1 次，失败不计次。
                      </li>
                      <li>
                        <strong>查看使用与成本。</strong>
                        记录中能看到手机号、供应商、使用次数、具体输入输出及可核实成本。供应商直接向你的个人账户计费，平台不重复扣余额。未返回确切成本时显示「待供应商核实」，最终以对应供应商账单为准。
                      </li>
                      <li>
                        <strong>看客户体验效果。</strong>
                        「客户看板」可按时间查看已用、未用、额度已用完的客户，以及实际使用的功能和模型。「客户关注的功能」分开记录主动选过和成功用过的岗位，选岗不扣次数。
                      </li>
                      <li>
                        <strong>停止体验。</strong>
                        你可暂停客户或停用二维码；平台管理员可随时暂停整个测试员账号及关联客户体验。测试员不能创建子账号。
                      </li>
                    </ol>
                  </section>
                ),
              },
              {
                key: 'password',
                label: '修改密码',
                children: (
                  <section className="trial-panel tester-narrow">
                    <h2>修改本人登录密码</h2>
                    <p className="trial-muted">修改成功后需重新登录。</p>
                    <Form
                      form={passwordForm}
                      layout="vertical"
                      onFinish={values =>
                        void run('password', async () => {
                          await trialRequest('/tester/password', {
                            method: 'POST',
                            body: { currentPassword: values.currentPassword, password: values.password },
                          });
                          passwordForm.resetFields();
                          clearAuth();
                          message.success('密码已修改，请重新登录');
                          nav('/login?login=1');
                        })
                      }
                    >
                      <Form.Item
                        name="currentPassword"
                        label="当前密码"
                        rules={[{ required: true, message: '请输入当前密码' }]}
                      >
                        <Input.Password autoComplete="current-password" />
                      </Form.Item>
                      <Form.Item
                        name="password"
                        label="新密码"
                        rules={[
                          { required: true, message: '请输入新密码' },
                          { min: 8, message: '密码至少 8 位' },
                        ]}
                      >
                        <Input.Password autoComplete="new-password" maxLength={128} />
                      </Form.Item>
                      <Form.Item
                        name="confirmPassword"
                        label="再次输入新密码"
                        dependencies={['password']}
                        rules={[
                          { required: true, message: '请再次输入新密码' },
                          ({ getFieldValue }) => ({
                            validator: (_, value) =>
                              !value || getFieldValue('password') === value
                                ? Promise.resolve()
                                : Promise.reject(new Error('两次密码不一致')),
                          }),
                        ]}
                      >
                        <Input.Password autoComplete="new-password" maxLength={128} />
                      </Form.Item>
                      <Button type="primary" htmlType="submit" loading={busy === 'password'}>
                        保存新密码
                      </Button>
                    </Form>
                  </section>
                ),
              },
            ]}
          />
        </>
      )}
      <TrialLeadDrawer id={leadId} onClose={() => setLeadId(null)} />
    </Root>
  );
}
