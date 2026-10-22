import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Empty, Segmented, Select, Spin, Table, Tabs } from 'antd';
import { TrialStatus, trialCost, trialError, trialProviderLabel, trialRequest } from './TrialShared';

type AnalyticsAmount = { knownCostCny: number; unverifiedCostCount: number };
type AnalyticsSummary = AnalyticsAmount & {
  totalCustomers: number;
  pendingCustomers: number;
  approvedCustomers: number;
  rejectedCustomers: number;
  pausedCustomers: number;
  usedCustomers: number;
  unusedCustomers: number;
  exhaustedCustomers: number;
  successfulConversations: number;
  failedConversations: number;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  runningCalls: number;
  interestSelections: number;
  legacyRecordCount?: number;
};
type EmployeeAnalytics = AnalyticsAmount & {
  employeeId: string;
  name: string;
  group: string;
  domain: string;
  selectedCustomers: number;
  usedCustomers: number;
  successfulConversations: number;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
};
type AnalyticsData = {
  departments?: Array<
    AnalyticsAmount & {
      department: string;
      testerCount: number;
      approvedTesters: number;
      totalCustomers: number;
      usedCustomers: number;
      unusedCustomers: number;
      successfulConversations: number;
      totalCalls: number;
      failedCalls: number;
    }
  >;
  summary: AnalyticsSummary;
  period: { days: string | number; from?: string; to: string; timeZone: string };
  timeline: Array<
    AnalyticsAmount & {
      date: string;
      newCustomers: number;
      usedCustomers: number;
      successfulCalls: number;
      failedCalls: number;
    }
  >;
  employees: EmployeeAnalytics[];
  models: Array<
    AnalyticsAmount & {
      model: string;
      provider?: string;
      totalCalls: number;
      successfulCalls: number;
      failedCalls: number;
    }
  >;
  interests: Array<{
    employeeId: string;
    name: string;
    group: string;
    domain: string;
    selectedCustomers: number;
    usedCustomers: number;
  }>;
  statusDistribution: Array<{ status: string; count: number }>;
  definitions?: Record<string, string>;
};

export function trialAnalyticsPath(admin: boolean, days: string, ownerUserId?: number, department?: string) {
  const params = new URLSearchParams({ days, scope: 'customers' });
  if (admin && ownerUserId) params.set('ownerUserId', String(ownerUserId));
  if (admin && department !== undefined) params.set('department', department);
  return `/tester/${admin ? 'admin/' : ''}analytics?${params}`;
}
export function actuallyUsedEmployees<T extends { totalCalls: number; successfulConversations: number }>(rows: T[]) {
  return rows.filter(row => row.totalCalls > 0 || row.successfulConversations > 0);
}
const metric = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
function CostCell({ knownCostCny, unverifiedCostCount }: Partial<AnalyticsAmount>) {
  return (
    <>
      <span>{knownCostCny == null ? '待核实' : trialCost(knownCostCny)}</span>
      {!!unverifiedCostCount && <div className="trial-muted trial-small">另 {unverifiedCostCount} 次待核实</div>}
    </>
  );
}

export default function TrialAnalyticsPanel({
  admin = false,
  testers = [],
  refreshKey = 0,
  department,
}: {
  admin?: boolean;
  testers?: Array<{ id: number; name: string; phone: string }>;
  refreshKey?: number;
  department?: string;
}) {
  const [days, setDays] = useState('30');
  const [dimension, setDimension] = useState(admin ? 'departments' : 'functions');
  const [ownerUserId, setOwnerUserId] = useState<number>();
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const selectedOwnerUserId = testers.some(tester => tester.id === ownerUserId) ? ownerUserId : undefined;
  const path = trialAnalyticsPath(admin, days, selectedOwnerUserId, department);
  const retry = useCallback(() => setReload(value => value + 1), []);
  useEffect(() => {
    let active = true;
    const frame = requestAnimationFrame(() => {
      setBusy(true);
      setError('');
      setData(null);
      trialRequest<AnalyticsData>(path)
        .then(result => {
          if (active) setData(result);
        })
        .catch(error => {
          if (active) setError(trialError(error));
        })
        .finally(() => {
          if (active) setBusy(false);
        });
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
    };
  }, [path, refreshKey, reload]);
  const summary = data?.summary;
  const usedShare = summary?.totalCustomers ? Math.round((summary.usedCustomers / summary.totalCustomers) * 100) : 0;
  return (
    <div className="trial-analytics">
      <div className="trial-section-title">
        <div>
          <h2>{admin ? '销售邀请与客户体验看板' : '我的客户体验看板'}</h2>
          <p className="trial-muted">
            看客户是否开始体验、实际用了哪些员工和模型。仅统计客户，测试员本人的记录与成本单独保留。
          </p>
        </div>
        <Button loading={busy} onClick={retry}>
          刷新看板
        </Button>
      </div>
      <div className="trial-analytics-filters">
        <Segmented
          aria-label="看板时间范围"
          value={days}
          onChange={value => setDays(String(value))}
          options={[
            { label: '近 7 天', value: '7' },
            { label: '近 30 天', value: '30' },
            { label: '近 90 天', value: '90' },
            { label: '全部', value: 'all' },
          ]}
        />
        {admin && (
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            aria-label="按销售筛选看板"
            placeholder="全部销售 / 测试员"
            value={selectedOwnerUserId}
            onChange={setOwnerUserId}
            options={testers.map(tester => ({ value: tester.id, label: `${tester.name} · ${tester.phone}` }))}
            style={{ minWidth: 240 }}
          />
        )}
      </div>
      {error && (
        <Alert
          type="error"
          message={error}
          action={
            <Button size="small" onClick={retry}>
              重试
            </Button>
          }
        />
      )}
      {busy && (
        <div className="trial-analytics-loading">
          <Spin />
        </div>
      )}
      {!busy && summary && data && (
        <>
          <div className="trial-analytics-metrics">
            {[
              ['本期申请客户', metric(summary.totalCustomers), '按申请时间统计'],
              ['其中已体验', metric(summary.usedCustomers), '至少收到一次成功回复'],
              ['其中尚未体验', metric(summary.unusedCustomers), '包括待审核和未开聊客户'],
              ['期间成功问答', metric(summary.successfulConversations), '实际交付成功次数'],
              ['待审核客户', metric(summary.pendingCustomers), '所选申请客户当前状态'],
              [
                '已核实供应商成本',
                trialCost(summary.knownCostCny),
                summary.unverifiedCostCount
                  ? `另 ${summary.unverifiedCostCount} 次调用待核实`
                  : '客户体验由邀请人的个人 Key 付费',
              ],
            ].map(([label, value, note]) => (
              <div className="trial-metric" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>{note}</small>
              </div>
            ))}
          </div>
          <div className="trial-analytics-overview">
            <section className="trial-analytics-block">
              <h3>有多少客户开始体验？</h3>
              {summary.totalCustomers ? (
                <>
                  <div
                    className="trial-usage-bar"
                    role="img"
                    aria-label={`已体验 ${summary.usedCustomers} 人，未体验 ${summary.unusedCustomers} 人`}
                  >
                    <span style={{ width: `${Math.min(100, Math.max(0, usedShare))}%` }} />
                  </div>
                  <div className="trial-usage-legend">
                    <span>
                      已体验 {summary.usedCustomers} 人 · {usedShare}%
                    </span>
                    <span>未体验 {summary.unusedCustomers} 人</span>
                  </div>
                  <p className="trial-muted trial-small">其中体验额度已用完：{metric(summary.exhaustedCustomers)} 人</p>
                </>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个时间范围还没有客户申请" />
              )}
              <div className="trial-status-counts">
                {(data.statusDistribution || []).map(item => (
                  <span key={item.status}>
                    <TrialStatus status={item.status} />
                    {item.count} 人
                  </span>
                ))}
              </div>
            </section>
            <section className="trial-analytics-block">
              <h3>客户调用情况</h3>
              <dl className="trial-call-counts">
                <div>
                  <dt>{summary.legacyRecordCount ? '调用与历史记录' : '供应商调用'}</dt>
                  <dd>{metric(summary.totalCalls)}</dd>
                </div>
                <div>
                  <dt>成功</dt>
                  <dd>{metric(summary.successfulCalls)}</dd>
                </div>
                <div>
                  <dt>失败</dt>
                  <dd>{metric(summary.failedCalls)}</dd>
                </div>
                <div>
                  <dt>处理中</dt>
                  <dd>{metric(summary.runningCalls)}</dd>
                </div>
              </dl>
              <p className="trial-muted trial-small">
                一次问答可能发生重试，所以调用次数可能多于成功问答数。失败的调用费用也保留在账目中。
                {!!summary.legacyRecordCount &&
                  `其中 ${summary.legacyRecordCount} 条为历史留存记录，缺失的重试次数不作推算。`}
              </p>
            </section>
          </div>
          <Tabs
            activeKey={dimension}
            onChange={setDimension}
            items={[
              ...(admin
                ? [
                    {
                      key: 'departments',
                      label: '部门效果',
                      children: (
                        <>
                          <p className="trial-muted">
                            按测试员当前部门归集。已体验率是客户成功体验比例，不代表付费成交率；通过上方部门与销售筛选，继续查看功能和模型。
                          </p>
                          <Table
                            rowKey="department"
                            dataSource={data.departments || []}
                            pagination={{ pageSize: 10 }}
                            scroll={{ x: 1000 }}
                            columns={[
                              { title: '部门／团队', dataIndex: 'department', render: value => value || '未分类' },
                              {
                                title: '测试员 / 已开通',
                                render: (_, row) => `${row.testerCount} / ${row.approvedTesters}`,
                              },
                              {
                                title: '申请客户',
                                dataIndex: 'totalCustomers',
                                sorter: (a, b) => a.totalCustomers - b.totalCustomers,
                              },
                              {
                                title: '已体验 / 未体验',
                                render: (_, row) => `${row.usedCustomers} / ${row.unusedCustomers}`,
                              },
                              {
                                title: '已体验率',
                                render: (_, row) =>
                                  row.totalCustomers
                                    ? `${Math.round((row.usedCustomers / row.totalCustomers) * 100)}%`
                                    : '—',
                              },
                              { title: '成功问答', dataIndex: 'successfulConversations' },
                              { title: '调用 / 失败', render: (_, row) => `${row.totalCalls} / ${row.failedCalls}` },
                              { title: '已核实成本', render: (_, row) => <CostCell {...row} /> },
                            ]}
                          />
                        </>
                      ),
                    },
                  ]
                : []),
              {
                key: 'functions',
                label: '实际使用的功能',
                children: (
                  <Table
                    rowKey="employeeId"
                    dataSource={actuallyUsedEmployees(data.employees || [])}
                    pagination={{ pageSize: 8 }}
                    scroll={{ x: 760 }}
                    locale={{ emptyText: '还没有客户调用数字员工' }}
                    columns={[
                      {
                        title: '数字员工 / 功能',
                        render: (_, row) => (
                          <>
                            <strong>{row.name}</strong>
                            <div className="trial-muted trial-small">{row.group}</div>
                          </>
                        ),
                      },
                      {
                        title: '成功使用客户',
                        dataIndex: 'usedCustomers',
                        render: value => `${metric(value)} 人`,
                        sorter: (a, b) => a.usedCustomers - b.usedCustomers,
                      },
                      {
                        title: '成功问答',
                        dataIndex: 'successfulConversations',
                        sorter: (a, b) => a.successfulConversations - b.successfulConversations,
                      },
                      { title: '调用 / 失败', render: (_, row) => `${row.totalCalls} / ${row.failedCalls}` },
                      { title: '已核实成本', render: (_, row) => <CostCell {...row} /> },
                    ]}
                  />
                ),
              },
              {
                key: 'models',
                label: '实际使用的模型',
                children: (
                  <Table
                    rowKey="model"
                    dataSource={data.models || []}
                    pagination={{ pageSize: 8 }}
                    scroll={{ x: 650 }}
                    locale={{ emptyText: '还没有模型调用记录' }}
                    columns={[
                      { title: '供应商', dataIndex: 'provider', render: value => trialProviderLabel(value || '360') },
                      { title: '模型', dataIndex: 'model', render: value => value || '未记录模型' },
                      { title: '调用次数', dataIndex: 'totalCalls', sorter: (a, b) => a.totalCalls - b.totalCalls },
                      { title: '成功', dataIndex: 'successfulCalls' },
                      { title: '失败', dataIndex: 'failedCalls' },
                      { title: '已核实成本', render: (_, row) => <CostCell {...row} /> },
                    ]}
                  />
                ),
              },
              {
                key: 'interests',
                label: '客户关注的功能',
                children: (
                  <>
                    <Alert
                      type="info"
                      className="trial-notice"
                      showIcon
                      message="关注依据是客户主动选择过的岗位，以及实际成功使用的岗位；不是购买意向预测。"
                      description="同一客户多次选择同一岗位只计 1 人。选择岗位不会消耗体验次数。"
                    />
                    <Table
                      rowKey="employeeId"
                      dataSource={data.interests || []}
                      pagination={{ pageSize: 8 }}
                      locale={{ emptyText: '还没有客户选岗或使用记录' }}
                      columns={[
                        {
                          title: '数字员工 / 功能',
                          render: (_, row) => (
                            <>
                              {row.name}
                              <div className="trial-muted trial-small">{row.group}</div>
                            </>
                          ),
                        },
                        {
                          title: '主动选择过',
                          dataIndex: 'selectedCustomers',
                          render: value => `${metric(value)} 人`,
                          sorter: (a, b) => a.selectedCustomers - b.selectedCustomers,
                        },
                        {
                          title: '实际成功用过',
                          dataIndex: 'usedCustomers',
                          render: value => `${metric(value)} 人`,
                          sorter: (a, b) => a.usedCustomers - b.usedCustomers,
                        },
                      ]}
                    />
                  </>
                ),
              },
              {
                key: 'daily',
                label: '每天的使用情况',
                children: (
                  <Table
                    rowKey="date"
                    dataSource={data.timeline || []}
                    pagination={{ pageSize: 10 }}
                    scroll={{ x: 760 }}
                    locale={{ emptyText: '这个时间范围没有客户活动记录' }}
                    columns={[
                      { title: '日期（北京时间）', dataIndex: 'date' },
                      { title: '申请客户', dataIndex: 'newCustomers' },
                      { title: '使用客户', dataIndex: 'usedCustomers' },
                      { title: '成功 / 失败调用', render: (_, row) => `${row.successfulCalls} / ${row.failedCalls}` },
                      { title: '已核实成本', render: (_, row) => <CostCell {...row} /> },
                    ]}
                  />
                ),
              },
            ]}
          />
          <p className="trial-muted trial-small">
            统计口径：客户数量和审核状态按所选时间内申请的客户计算；选岗、问答、模型调用和费用按事件发生时间计算，可能包含此前申请的客户。金额仅包含供应商已核实部分，待核实调用不视为免费。
          </p>
        </>
      )}
    </div>
  );
}
