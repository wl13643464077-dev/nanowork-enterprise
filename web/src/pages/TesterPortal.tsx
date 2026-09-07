import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Form, Input, Modal, Segmented, Space, Spin, Table, Tabs, Tag, message } from 'antd';
import { Link, useNavigate } from 'react-router-dom';
import { clearAuth, getUser } from '../api/client';
import {
  TrialHistory,
  TrialLeadDrawer,
  TrialStatus,
  formatTrialTime,
  newTrialRequestId,
  trialCost,
  trialError,
  trialProviderLabel,
  trialRequest,
} from './TrialShared';
import type { TrialConversation, TrialEmployee, TrialLead, TrialProviderId } from './TrialShared';
import TrialEmployeePicker, { TrialEmployeeGuide } from './TrialEmployeePicker';
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
};

const PROVIDER_GUIDES: Record<TrialProviderId, { home: string; docs: string; account?: string }> = {
  openlux: {
    home: 'https://api.openlux.ai/',
    docs: 'https://doc.openlux.ai/',
  },
  '360': {
    home: 'https://ai.360.com/open/zh/login',
    docs: 'https://ai.360.com/docs/413292017e0',
    account: 'https://ai.360.com/open/zh/platform/account/keys',
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

export default function TesterPortal() {
  const nav = useNavigate();
  const [profile, setProfile] = useState<TesterProfile | null>(null);
  const [activeProvider, setActiveProvider] = useState<TrialProviderId>('360');
  const [providers, setProviders] = useState<TesterProviderState[]>([]);
  const [employees, setEmployees] = useState<TrialEmployee[]>([]);
  const [conversations, setConversations] = useState<TrialConversation[]>([]);
  const [personalUsage, setPersonalUsage] = useState<PersonalUsage | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [leads, setLeads] = useState<TrialLead[]>([]);
  const [tab, setTab] = useState('work');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [employeeId, setEmployeeId] = useState<string>();
  const [draft, setDraft] = useState('');
  const [leadId, setLeadId] = useState<number | null>(null);
  const [analyticsRefresh, setAnalyticsRefresh] = useState(0);
  const [keyForm] = Form.useForm();
  const [passwordForm] = Form.useForm();
  const [invitationForm] = Form.useForm();
  const retry = useRef<{ employeeId: string; message: string; requestId: string } | null>(null);
  const sending = useRef(false);
  const load = useCallback(async () => {
    setError('');
    try {
      const result = await trialRequest('/tester/me');
      const nextProfile: TesterProfile = result.profile || result.tester || result;
      const nextProvider = providerId(result.activeProvider || nextProfile.activeProvider);
      setProfile(nextProfile);
      setActiveProvider(nextProvider);
      setProviders(testerProviderStates(result.providers || nextProfile.providers, nextProvider, nextProfile));
      setEmployees(result.employees || []);
      setEmployeeId(current => current || result.employees?.[0]?.id);
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
  const send = async () => {
    const text = draft.trim();
    if (!text || !employeeId || sending.current) return;
    sending.current = true;
    if (retry.current?.message !== text || retry.current?.employeeId !== employeeId)
      retry.current = { employeeId, message: text, requestId: newTrialRequestId() };
    await run('chat', async () => {
      try {
        await trialRequest('/tester/chat', { method: 'POST', body: retry.current });
        setDraft('');
        retry.current = null;
      } finally {
        const [history, analytics] = await Promise.allSettled([
          trialRequest('/tester/conversations'),
          trialRequest('/tester/analytics?days=all&scope=customers'),
        ]);
        if (history.status === 'fulfilled')
          setConversations(Array.isArray(history.value) ? history.value : history.value.conversations || []);
        setPersonalUsage(analytics.status === 'fulfilled' ? analytics.value.personalSummary || null : null);
        if (history.status === 'rejected' || analytics.status === 'rejected')
          message.warning('记录或费用暂未刷新，稍后点击「刷新记录」查看。');
      }
    });
    sending.current = false;
  };
  const reviewLead = (lead: TrialLead, status: string) =>
    run(`lead-${lead.id}`, async () => {
      await trialRequest(`/tester/leads/${lead.id}`, { method: 'PATCH', body: { status } });
      message.success('客户状态已更新');
      await load();
    });
  const active = profile?.status === 'approved';
  const selected = employees.find(item => item.id === employeeId);
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
    <main className="trial-shell tester-shell">
      <header className="trial-header">
        <Link to="/tester" className="trial-brand">
          纳米 Work <span>测试员工作台</span>
        </Link>
        <Space wrap>
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
      <section className="tester-intro">
        <div>
          <span className="trial-eyebrow">一句话，把活交给数字员工</span>
          <h1>自己体验，也邀请客户试试</h1>
          <p className="trial-muted">
            本人账号 · {profile ? `当前使用 ${activeProviderLabel}` : '正在读取供应商'} · 客户最多体验 2 次问答
          </p>
        </div>
        <Button onClick={() => void load()} loading={loading}>
          刷新记录
        </Button>
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
                key: 'work',
                label: '数字员工',
                children: (
                  <div className="tester-work-grid">
                    <section className="trial-panel">
                      <h2>选择一位员工</h2>
                      <TrialEmployeePicker
                        employees={employees}
                        value={employeeId}
                        onChange={setEmployeeId}
                        disabled={busy === 'chat'}
                      />
                      <TrialEmployeeGuide employee={selected} onExample={setDraft} disabled={busy === 'chat'} />
                      <div className="trial-field-label" id="tester-message-label">
                        你想完成什么？
                      </div>
                      <Input.TextArea
                        id="tester-message"
                        aria-labelledby="tester-message-label"
                        value={draft}
                        onChange={event => setDraft(event.target.value)}
                        autoSize={{ minRows: 5, maxRows: 12 }}
                        maxLength={6000}
                        placeholder="说说你的门店、主题和想要的结果"
                        disabled={busy === 'chat'}
                      />
                      <Button
                        className="trial-send"
                        block
                        type="primary"
                        size="large"
                        onClick={() => void send()}
                        loading={busy === 'chat'}
                        disabled={!active || !activeKeyConfigured || !draft.trim() || !employeeId}
                      >
                        交给数字员工
                      </Button>
                      <p className="trial-muted trial-small">
                        全部数字员工均可进行文字体验；AI
                        带货员与小红书种草员提供脚本和图文方案，图片、视频文件在企业产品中生成。
                      </p>
                    </section>
                    <section className="trial-panel">
                      <div className="trial-section-title">
                        <h2>我的输入与结果</h2>
                        <span className="trial-muted">
                          本人累计已核实成本 {trialCost(personalUsage?.knownCostCny)}
                          {personalUsage?.unverifiedCostCount ? ` · ${personalUsage.unverifiedCostCount} 次待核实` : ''}
                        </span>
                      </div>
                      <p className="trial-muted trial-small">
                        下方展示最近 100 条本人记录，客户使用记录在客户看板中查看。
                      </p>
                      {busy === 'chat' && (
                        <Alert
                          type="info"
                          showIcon
                          message="数字员工正在工作，请稍等。结果会保留在这里。"
                          className="trial-notice"
                        />
                      )}
                      <TrialHistory conversations={conversations} showCost />
                    </section>
                  </div>
                ),
              },
              {
                key: 'key',
                label: '供应商与个人 Key',
                children: (
                  <section className="trial-panel tester-narrow">
                    <h2>先选择供应商</h2>
                    <p className="trial-muted">
                      本人新对话和新生成的体验二维码使用当前供应商。已经生成的二维码继续使用创建时绑定的供应商。
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
                      <p className="trial-muted">
                        新二维码固定使用当前选择的{activeProviderLabel}个人
                        Key。之后切换供应商不会改变已经分享的二维码。
                        客户扫码填写资料，经你或平台审核通过后，可体验两次问答。
                      </p>
                      <Form
                        form={invitationForm}
                        initialValues={{ salesPhone: profile?.phone }}
                        layout="inline"
                        className="trial-invite-form"
                        onFinish={values =>
                          void run('invite', async () => {
                            await trialRequest('/tester/invitations', { method: 'POST', body: values });
                            message.success('体验二维码已生成');
                            await load();
                          })
                        }
                      >
                        <Form.Item name="title" label="邀请名称">
                          <Input placeholder="例如 张三·餐饮老板体验" maxLength={60} />
                        </Form.Item>
                        <Form.Item
                          name="salesPhone"
                          label="销售手机号"
                          rules={[{ required: true }, { pattern: /^1\d{10}$/, message: '请输入 11 位手机号' }]}
                        >
                          <Input inputMode="tel" maxLength={11} />
                        </Form.Item>
                        <Button
                          htmlType="submit"
                          type="primary"
                          loading={busy === 'invite'}
                          disabled={!active || !activeKeyConfigured || !activeProviderState.available}
                        >
                          生成体验二维码
                        </Button>
                      </Form>
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
                            <p>销售手机号：{item.salesPhone}</p>
                            <p>体验供应商：{trialProviderLabel(item.provider || '360')}</p>
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
                          render: value => `${value || 0} / 2 次`,
                          filters: [
                            { text: '尚未使用', value: 0 },
                            { text: '已用 1 次', value: 1 },
                            { text: '已用完 2 次', value: 2 },
                          ],
                          onFilter: (value, row) => row.usedTurns === value,
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
                        <strong>选择供应商。</strong>在「供应商与个人 Key」选择 OpenLux 或 360
                        智脑，再到对应官方平台创建 API Key，并确认账户有可用额度。
                      </li>
                      <li>
                        <strong>绑定 Key。</strong>粘贴当前供应商的个人
                        Key，然后在「数字员工」发一句需求验证。两家供应商的 Key 分开保存，切换时不会互相覆盖。
                      </li>
                      <li>
                        <strong>选择数字员工。</strong>
                        全部岗位可按部门或需求搜索，每位员工都带一句话示例。本体验提供文字建议，带货和小红书岗位交付脚本与图文方案。
                      </li>
                      <li>
                        <strong>生成二维码。</strong>
                        到「体验二维码」，填写销售手机号和邀请名称，下载图片或复制链接发给客户。
                      </li>
                      <li>
                        <strong>同意客户体验。</strong>
                        客户扫码填写手机号等资料后，在「客户与使用记录」点「同意体验」。每位客户最多获得两次成功问答，失败可重试。
                      </li>
                      <li>
                        <strong>查看使用与成本。</strong>
                        记录中能看到手机号、供应商、使用次数、具体输入输出及可核实成本。供应商直接向你的个人账户计费，平台不重复扣余额。未返回确切成本时显示「待供应商核实」，最终以对应供应商账单为准。
                      </li>
                      <li>
                        <strong>看客户体验效果。</strong>
                        「客户看板」可按时间查看已用、未用、两次已用完的客户，以及实际使用的功能和模型。「客户关注的功能」分开记录主动选过和成功用过的岗位，选岗不扣次数。
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
    </main>
  );
}
