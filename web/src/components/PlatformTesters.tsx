import { useCallback, useEffect, useState } from 'react';
import { Alert, AutoComplete, Button, Input, Modal, Select, Space, Table, Tabs, Tag, message } from 'antd';
import {
  TrialLeadDrawer,
  TrialStatus,
  formatTrialTime,
  trialCost,
  trialError,
  trialProviderLabel,
  trialRequest,
  trialTurnLimit,
  trialUsageState,
} from '../pages/TrialShared';
import type { TrialLead } from '../pages/TrialShared';
import TrialAnalyticsPanel from '../pages/TrialAnalyticsPanel';
import '../pages/Trial.css';

type TesterApplication = {
  id: number;
  name: string;
  username: string;
  phone: string;
  department?: string;
  status: string;
  keyConfigured?: boolean;
  keyMasked?: string;
  activeProvider?: string;
  providers?: Array<{
    id: string;
    label?: string;
    configured?: boolean;
    keyConfigured?: boolean;
    maskedKey?: string;
    keyMasked?: string;
  }>;
  invitationCount?: number;
  leadCount?: number;
  usedTurns?: number;
  supplierCostCny?: number;
  unverifiedCostCount?: number;
  createdAt?: string;
};

function testerProviderRows(row: TesterApplication) {
  if (row.providers?.length) return row.providers;
  return [
    {
      id: row.activeProvider || '360',
      label: trialProviderLabel(row.activeProvider || '360'),
      configured: row.keyConfigured,
      maskedKey: row.keyMasked,
    },
  ];
}

export default function PlatformTesters() {
  const [applications, setApplications] = useState<TesterApplication[]>([]);
  const [leads, setLeads] = useState<TrialLead[]>([]);
  const [invitations, setInvitations] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailId, setDetailId] = useState<number | null>(null);
  const [busy, setBusy] = useState('');
  const [analyticsRefresh, setAnalyticsRefresh] = useState(0);
  const [department, setDepartment] = useState<string>();
  const [editing, setEditing] = useState<TesterApplication | null>(null);
  const [draftDepartment, setDraftDepartment] = useState('');
  const departmentNames = [...new Set(applications.map(row => row.department || ''))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN'),
  );
  const matchesDepartment = (id: number) =>
    department === undefined || applications.some(row => row.id === id && (row.department || '') === department);
  const filteredApplications = applications.filter(row => matchesDepartment(row.id));
  const filteredLeads = leads.filter(row => matchesDepartment(row.ownerUserId));
  const filteredInvitations = invitations.filter(row => matchesDepartment(row.ownerUserId));
  const ownerDepartment = (id: number) => applications.find(row => row.id === id)?.department || '未分类';
  const saveDepartment = async () => {
    if (!editing) return;
    setBusy(`department-${editing.id}`);
    try {
      await trialRequest(`/tester/admin/applications/${editing.id}/department`, {
        method: 'PATCH',
        body: { department: draftDepartment },
      });
      setEditing(null);
      message.success('部门分类已更新');
      await load();
    } catch (error) {
      setError(trialError(error));
    } finally {
      setBusy('');
    }
  };
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [people, customers, links] = await Promise.all([
        trialRequest('/tester/admin/applications'),
        trialRequest('/tester/admin/leads'),
        trialRequest('/tester/admin/invitations'),
      ]);
      setApplications(Array.isArray(people) ? people : people.applications || []);
      setLeads(Array.isArray(customers) ? customers : customers.leads || []);
      setInvitations(Array.isArray(links) ? links : links.invitations || []);
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
  const update = async (kind: 'applications' | 'leads', id: number, status: string) => {
    setBusy(`${kind}-${id}`);
    try {
      await trialRequest(`/tester/admin/${kind}/${id}`, { method: 'PATCH', body: { status } });
      message.success('状态已更新');
      await load();
    } catch (error) {
      setError(trialError(error));
    } finally {
      setBusy('');
    }
  };
  return (
    <section className="trial-panel" style={{ marginTop: 18 }}>
      <div className="trial-section-title">
        <div>
          <h2>测试员与客户体验</h2>
          <p className="trial-muted">
            测试员选择 OpenLux 或 360 智脑并使用自己的个人
            Key，不能开子账号。暂停测试员后，其本人及关联客户均无法继续发起生成。
          </p>
        </div>
        <Button loading={loading} onClick={() => void load()}>
          刷新
        </Button>
      </div>
      {error && <Alert type="error" message={error} className="trial-notice" />}
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          aria-label="按部门或团队筛选"
          placeholder="全部部门／团队"
          value={department}
          onChange={setDepartment}
          options={departmentNames.map(name => ({ value: name, label: name || '未分类' }))}
          style={{ minWidth: 240 }}
        />
        <span className="trial-muted">
          当前分类 {filteredApplications.length} 位测试员 · {filteredLeads.length} 位客户
        </span>
      </Space>
      <Tabs
        items={[
          {
            key: 'analytics',
            label: '销售与客户看板',
            children: (
              <TrialAnalyticsPanel
                admin
                testers={filteredApplications}
                department={department}
                refreshKey={analyticsRefresh}
              />
            ),
          },
          {
            key: 'testers',
            label: `测试员（${filteredApplications.length}）`,
            children: (
              <Table
                rowKey="id"
                loading={loading}
                dataSource={filteredApplications}
                scroll={{ x: 1100 }}
                columns={[
                  {
                    title: '姓名 / 账号',
                    render: (_, row) => (
                      <>
                        <strong>{row.name}</strong>
                        <div>{row.username}</div>
                      </>
                    ),
                  },
                  { title: '手机号', dataIndex: 'phone' },
                  { title: '部门／团队', dataIndex: 'department', render: value => value || '未分类' },
                  { title: '状态', dataIndex: 'status', render: status => <TrialStatus status={status} /> },
                  {
                    title: '当前供应商',
                    render: (_, row) => trialProviderLabel(row.activeProvider || '360'),
                  },
                  {
                    title: '个人 Key',
                    render: (_, row) => (
                      <Space direction="vertical" size={2}>
                        {testerProviderRows(row).map(provider => {
                          const configured = provider.configured ?? provider.keyConfigured ?? false;
                          return (
                            <span key={provider.id}>
                              <Tag>{trialProviderLabel(provider.id, provider.label)}</Tag>
                              {configured ? provider.maskedKey || provider.keyMasked || '已配置' : '未配置'}
                            </span>
                          );
                        })}
                      </Space>
                    ),
                  },
                  {
                    title: '邀请 / 客户',
                    render: (_, row) =>
                      `${row.invitationCount ?? invitations.filter(item => item.ownerUserId === row.id).length} / ${row.leadCount ?? leads.filter(item => item.ownerUserId === row.id).length}`,
                  },
                  {
                    title: '供应商成本',
                    render: (_, row) => (
                      <>
                        {trialCost(row.supplierCostCny)}
                        {row.unverifiedCostCount ? (
                          <div className="trial-muted">另 {row.unverifiedCostCount} 笔待核实</div>
                        ) : null}
                      </>
                    ),
                  },
                  { title: '申请时间', dataIndex: 'createdAt', render: formatTrialTime },
                  {
                    title: '操作',
                    render: (_, row) => (
                      <Space wrap>
                        <Button
                          size="small"
                          onClick={() => {
                            setEditing(row);
                            setDraftDepartment(row.department || '');
                          }}
                        >
                          调整部门
                        </Button>
                        {row.status !== 'approved' && (
                          <Button
                            size="small"
                            type="primary"
                            loading={busy === `applications-${row.id}`}
                            onClick={() => void update('applications', row.id, 'approved')}
                          >
                            {row.status === 'paused' ? '恢复' : '批准'}
                          </Button>
                        )}
                        {row.status === 'pending' && (
                          <Button size="small" onClick={() => void update('applications', row.id, 'rejected')}>
                            拒绝
                          </Button>
                        )}
                        {row.status === 'approved' && (
                          <Button
                            danger
                            size="small"
                            onClick={() =>
                              Modal.confirm({
                                title: `暂停测试员 ${row.name}？`,
                                content: '该账号和其关联客户将无法继续发起新生成；已有记录保留。',
                                onOk: () => update('applications', row.id, 'paused'),
                              })
                            }
                          >
                            立即叫停
                          </Button>
                        )}
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'customers',
            label: `客户使用情况（${filteredLeads.length}）`,
            children: (
              <Table
                rowKey="id"
                loading={loading}
                dataSource={filteredLeads}
                scroll={{ x: 1050 }}
                columns={[
                  {
                    title: '客户',
                    render: (_, row) => (
                      <>
                        <strong>{row.name}</strong>
                        <div>{row.phone}</div>
                        <div className="trial-muted">{row.storeName}</div>
                      </>
                    ),
                  },
                  {
                    title: '邀请销售',
                    render: (_, row) => (
                      <>
                        {row.testerName || row.ownerName}
                        <div>{row.salesPhone}</div>
                      </>
                    ),
                  },
                  {
                    title: '体验入口 / 发给谁',
                    render: (_, row) => (
                      <>
                        {row.invitationTitle}
                        {row.recipientNote && <div className="trial-muted">发给 {row.recipientNote}</div>}
                        {row.autoApproved && <Tag color="green">扫码自动开通</Tag>}
                      </>
                    ),
                  },
                  { title: '归属部门', render: (_, row) => ownerDepartment(row.ownerUserId) },
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
                    title: '已用次数',
                    render: (_, row) => `${row.usedTurns || 0} / ${trialTurnLimit(row.turnLimit)} 次`,
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
                        <Button size="small" onClick={() => setDetailId(row.id)}>
                          使用详情
                        </Button>
                        {row.status !== 'approved' && (
                          <Button
                            size="small"
                            type="primary"
                            loading={busy === `leads-${row.id}`}
                            onClick={() => void update('leads', row.id, 'approved')}
                          >
                            {row.status === 'paused' ? '恢复' : '同意'}
                          </Button>
                        )}
                        {row.status === 'pending' && (
                          <Button size="small" onClick={() => void update('leads', row.id, 'rejected')}>
                            拒绝
                          </Button>
                        )}
                        {row.status === 'approved' && (
                          <Button size="small" danger onClick={() => void update('leads', row.id, 'paused')}>
                            暂停
                          </Button>
                        )}
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'links',
            label: '全部邀请二维码',
            children: (
              <Table
                rowKey="id"
                dataSource={filteredInvitations}
                scroll={{ x: 700 }}
                columns={[
                  { title: '邀请名称', dataIndex: 'title' },
                  { title: '发给谁', dataIndex: 'recipientNote', render: value => value || '—' },
                  { title: '测试员', dataIndex: 'ownerName' },
                  { title: '扫码客户', dataIndex: 'leadCount', render: value => `${value ?? 0} 位` },
                  {
                    title: '开通方式',
                    dataIndex: 'autoApprove',
                    render: value => <Tag color={value ? 'green' : 'orange'}>{value ? '扫码即开通' : '人工同意'}</Tag>,
                  },
                  { title: '归属部门', render: (_, row) => ownerDepartment(row.ownerUserId) },
                  { title: '销售手机号', dataIndex: 'salesPhone' },
                  { title: '供应商', dataIndex: 'provider', render: value => trialProviderLabel(value || '360') },
                  { title: '每位客户额度', render: (_, row) => `${trialTurnLimit(row.turnLimit)} 次` },
                  { title: '状态', dataIndex: 'status', render: status => <TrialStatus status={status} /> },
                  { title: '创建时间', dataIndex: 'createdAt', render: formatTrialTime },
                  {
                    title: '预览',
                    render: (_, row) => (
                      <Button href={row.url} target="_blank" rel="noreferrer" size="small">
                        查看 H5
                      </Button>
                    ),
                  },
                ]}
              />
            ),
          },
        ]}
      />
      <TrialLeadDrawer id={detailId} admin onClose={() => setDetailId(null)} />
      <Modal
        title={`调整部门／团队${editing ? ` · ${editing.name}` : ''}`}
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={() => void saveDepartment()}
        confirmLoading={!!editing && busy === `department-${editing.id}`}
        okText="保存分类"
        cancelText="取消"
      >
        <p>选择已有部门或填写统一名称。留空归入“未分类”；历史统计按当前部门重新归集，不更改权限、Key 或体验额度。</p>
        <AutoComplete
          value={draftDepartment}
          onChange={setDraftDepartment}
          style={{ width: '100%' }}
          options={departmentNames.filter(Boolean).map(value => ({ value }))}
        >
          <Input aria-label="所属部门或团队" maxLength={40} placeholder="例如：成都销售一部" />
        </AutoComplete>
      </Modal>
    </section>
  );
}
