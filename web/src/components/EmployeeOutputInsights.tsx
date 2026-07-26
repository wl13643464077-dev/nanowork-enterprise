import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Button, Col, Descriptions, Empty, Modal, Progress, Row, Select, Space, Spin, Table, Tag, Tooltip,
} from 'antd';
import { AuditOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, safeUrl } from '../api/client';
import { Panel } from './Kit';
import { Markdown } from './Markdown';

type Props = { start: string; end: string };

type Filters = {
  domain: 'all' | 'restaurant' | 'tool' | 'content';
  group: string;
  employee: string;
  source: 'all' | 'task' | 'tool' | 'content' | 'content_solo';
  status: string;
  dimension: 'domain' | 'group' | 'employee' | 'source' | 'status';
};

const initialFilters: Filters = {
  domain: 'all',
  group: '',
  employee: '',
  source: 'all',
  status: '',
  dimension: 'employee',
};

const statusColor: Record<string, string> = {
  已完成: 'green', 成功: 'green', 已采纳: 'green', 待审阅: 'gold', 执行中: 'processing', 生成中: 'processing', 失败: 'red', 已驳回: 'red',
};

function evidenceColor(kind: string) {
  if (kind.includes('结果') || kind.includes('产出')) return 'blue';
  return 'default';
}

function sourceColor(label: string) {
  if (label === '经营工具') return 'cyan';
  if (label === '内容生产仓' || label === '内容员工单独派活') return 'purple';
  return 'geekblue';
}

function jsonPreview(value: unknown) {
  if (value == null || value === '') return '-';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function auditSnapshotForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(auditSnapshotForDisplay);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/(?:^version$|version$|revision$)/iu.test(key))
    .map(([key, child]) => [key, auditSnapshotForDisplay(child)]));
}

export default function EmployeeOutputInsights({ start, end }: Props) {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const rangeKey = `${start}\u0000${end}`;
  const [pagination, setPagination] = useState({ rangeKey, page: 1 });
  const page = pagination.rangeKey === rangeKey ? pagination.page : 1;
  const setPage = (nextPage: number) => setPagination({ rangeKey, page: nextPage });
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [detail, setDetail] = useState<{ open: boolean; loading: boolean; data: any; context: any }>({ open: false, loading: false, data: null, context: null });
  const requestRef = useRef(0);
  const detailRequestRef = useRef(0);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      start, end, domain: filters.domain, source: filters.source, dimension: filters.dimension,
      page: String(page), pageSize: '20',
    });
    if (filters.group) params.set('group', filters.group);
    if (filters.employee) params.set('employee', filters.employee);
    if (filters.status) params.set('status', filters.status);
    return params.toString();
  }, [start, end, filters, page]);

  const requestKey = `${query}\u0000${refreshNonce}`;
  const [result, setResult] = useState<{ key: string; data: any; error: string } | null>(null);
  const currentResult = result?.key === requestKey ? result : null;
  const data = currentResult?.data ?? null;
  const error = currentResult?.error ?? '';
  const loading = !currentResult;
  const load = () => setRefreshNonce(value => value + 1);

  useEffect(() => {
    const requestId = ++requestRef.current;
    api.get(`/analysis/employee-outputs?${query}`)
      .then(value => {
        if (requestRef.current === requestId) setResult({ key: requestKey, data: value, error: '' });
      })
      .catch(() => {
        if (requestRef.current === requestId) {
          setResult({ key: requestKey, data: null, error: '经营洞察加载失败，请检查服务后重试。' });
        }
      });
  }, [query, requestKey]);

  useEffect(() => () => {
    requestRef.current += 1;
    detailRequestRef.current += 1;
  }, []);

  const update = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setPage(1);
    setFilters(prev => ({ ...prev, [key]: value }));
  };

  const openDetail = (row: any) => {
    const labelFor = (items: any[], value: string, fallback: string) => items.find(item => String(item.value) === String(value))?.label || fallback;
    const context = {
      range: `${data?.range?.start || start} 至 ${data?.range?.end || end}`,
      store: data?.dataset?.store?.name || '当前门店',
      domain: filters.domain === 'all'
        ? '全部能力域'
        : labelFor(data?.options?.domains || [], filters.domain, filters.domain),
      recordDomain: row.abilityDomainLabel || '-',
      group: filters.group || '全部分部',
      employee: labelFor(data?.options?.employees || [], filters.employee, filters.employee ? filters.employee : '全部员工'),
      source: labelFor(data?.options?.sources || [], filters.source, filters.source === 'all' ? '全部来源' : filters.source),
      status: filters.status || '全部状态',
      calculation: data?.calculation,
    };
    const detailRequestId = ++detailRequestRef.current;
    setDetail({ open: true, loading: true, data: null, context });
    api.get(`/analysis/employee-outputs/drill/${row.source}/${row.id}`)
      .then(value => {
        if (detailRequestRef.current === detailRequestId) setDetail({ open: true, loading: false, data: value, context });
      })
      .catch(() => {
        if (detailRequestRef.current === detailRequestId) setDetail({ open: false, loading: false, data: null, context: null });
      });
  };

  const applyPivot = (row: any) => {
    const dimension = filters.dimension;
    if (dimension === 'domain') {
      const domainByLabel: Record<string, Filters['domain']> = {
        餐饮数字员工: 'restaurant', 餐饮经营工具: 'tool', Paihuo内容生产部: 'content',
      };
      update('domain', domainByLabel[row.label] || 'all');
    }
    else if (dimension === 'group') update('group', row.label);
    else if (dimension === 'source') {
      const sourceByLabel: Record<string, Filters['source']> = {
        数字员工任务: 'task', 经营工具: 'tool', 内容生产仓: 'content', 内容员工单独派活: 'content_solo',
      };
      update('source', sourceByLabel[row.label] || 'all');
    }
    else if (dimension === 'status') update('status', row.label);
    else {
      const value = String(row.label || '').split(' · ')[0];
      update('employee', value);
    }
  };

  const summary = data?.summary || {};
  const hasData = Boolean(data) && !error;
  const options = data?.options || { domains: [], groups: [], employees: [], statuses: [], sources: [] };
  const summaryCards = [
    { label: '运行记录', value: hasData ? summary.total || 0 : '—', color: 'var(--ui-accent)' },
    { label: '已有产出', value: hasData ? summary.withOutput || 0 : '—', color: '#2563eb' },
    { label: '完成 / 采纳', value: hasData ? summary.completed || 0 : '—', color: '#16a34a' },
    { label: '待处理', value: hasData ? summary.pending || 0 : '—', color: '#d97706' },
    { label: '失败 / 驳回', value: hasData ? summary.failed || 0 : '—', color: '#dc2626' },
  ];

  return (
    <Panel
      title={<Space size={8}><AuditOutlined style={{ color: 'var(--ui-accent)' }} />数字员工产出透视</Space>}
      extra={<Space size={6} wrap>
        <Tag color={data?.dataset?.isDemoEnvironment ? 'orange' : data ? 'blue' : 'default'}>{data?.dataset?.kind || '数据待加载'}</Tag>
        <Tag>{start} 至 {end}</Tag>
        <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
      </Space>}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="产出可追溯，经营成效需核验"
        description={data?.dataset?.disclaimer || '这里展示系统留痕，不把内容生成数量等同于营业额或转化提升。'}
      />
      {error && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error}
        action={<Button size="small" onClick={load}>重试</Button>} />}

      <Row gutter={[8, 8]} style={{ marginBottom: 12 }}>
        {summaryCards.map(card => (
          <Col xs={12} sm={8} lg={4} key={card.label}>
            <div style={{ border: '1px solid var(--ui-border)', borderRadius: 8, padding: '10px 12px', background: 'var(--ui-surface-2)' }}>
              <div style={{ fontSize: 11.5, color: 'var(--ui-muted)' }}>{card.label}</div>
              <div style={{ color: card.color, fontWeight: 750, fontSize: 20, marginTop: 2 }}>{card.value}</div>
            </div>
          </Col>
        ))}
      </Row>

      <Space wrap size={[8, 8]} style={{ marginBottom: 12 }}>
        <Tooltip title="门店数据由当前登录企业的租户边界固定，不能跨店查看">
          <Select value={data?.dataset?.store?.name || '当前门店'} disabled style={{ width: 170 }}
            options={[{ value: data?.dataset?.store?.name || '当前门店', label: `门店 · ${data?.dataset?.store?.name || '当前门店'}` }]} />
        </Tooltip>
        <Select value={filters.domain} style={{ width: 170 }}
          options={[{ value: 'all', label: '全部能力域' }, ...(options.domains || [])]}
          onChange={value => update('domain', value)} />
        <Select allowClear placeholder="全部分部" value={filters.group || undefined} style={{ width: 150 }}
          options={(options.groups || []).map((value: string) => ({ value, label: value }))}
          onChange={value => update('group', value || '')} />
        <Select allowClear showSearch optionFilterProp="label" placeholder="全部员工" value={filters.employee || undefined} style={{ width: 190 }}
          options={options.employees || []}
          onChange={value => update('employee', value || '')} />
        <Select value={filters.source} style={{ width: 130 }}
          options={[{ value: 'all', label: '全部来源' }, ...(options.sources || [])]}
          onChange={value => update('source', value)} />
        <Select allowClear placeholder="全部状态" value={filters.status || undefined} style={{ width: 130 }}
          options={(options.statuses || []).map((value: string) => ({ value, label: value }))}
          onChange={value => update('status', value || '')} />
        <span style={{ fontSize: 12, color: 'var(--ui-muted)', marginLeft: 4 }}>透视维度</span>
        <Select value={filters.dimension} style={{ width: 130 }}
          options={[
            { value: 'employee', label: '按员工' }, { value: 'domain', label: '按能力域' }, { value: 'group', label: '按分部' },
            { value: 'source', label: '按来源' }, { value: 'status', label: '按状态' },
          ]}
          onChange={value => update('dimension', value)} />
        {(filters.domain !== 'all' || filters.group || filters.employee || filters.source !== 'all' || filters.status) && (
          <Button size="small" onClick={() => { setPage(1); setFilters(prev => ({ ...initialFilters, dimension: prev.dimension })); }}>清空筛选</Button>
        )}
      </Space>

      <Spin spinning={loading}>
        {error && !loading ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次查询未取得数据，请重试后再判断经营情况" />
        ) : <Row gutter={[12, 12]}>
          <Col xs={24} xl={9}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ui-text-2)', marginBottom: 6 }}>透视汇总 · 点击行可继续筛选</div>
            <Table size="small" rowKey="key" dataSource={data?.pivot || []} pagination={false}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前范围暂无运行记录" /> }}
              onRow={row => ({ onClick: () => applyPivot(row), style: { cursor: 'pointer' } })}
              columns={[
                { title: '维度', dataIndex: 'label', ellipsis: true },
                { title: '记录', dataIndex: 'total', width: 58, align: 'right' as const },
                { title: '产出率', dataIndex: 'outputRate', width: 116, render: (value: number) => <Progress percent={value || 0} size="small" /> },
              ]} />
          </Col>
          <Col xs={24} xl={15}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ui-text-2)', marginBottom: 6 }}>运行明细 · 点击查看输入、结果与来源</div>
            <Table size="small" rowKey="ref" dataSource={data?.rows || []}
              scroll={{ x: 860 }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选暂无运行记录" /> }}
              onRow={row => ({ onClick: () => openDetail(row), style: { cursor: 'pointer' } })}
              pagination={{
                current: data?.pagination?.page || page,
                pageSize: data?.pagination?.pageSize || 20,
                total: data?.pagination?.total || 0,
                showSizeChanger: false,
                size: 'small',
                onChange: setPage,
              }}
              columns={[
                { title: '时间', dataIndex: 'createdAt', width: 126, render: (value: string) => String(value || '').slice(0, 16) },
                { title: '来源', dataIndex: 'sourceLabel', width: 108, render: (value: string) => <Tag color={sourceColor(value)}>{value}</Tag> },
                { title: '能力域', dataIndex: 'abilityDomainLabel', width: 124, ellipsis: true },
                { title: '员工', dataIndex: 'employee', width: 140, ellipsis: true, render: (value: string, row: any) => <Tooltip title={row.group}>{row.employeeIdx != null ? `${row.employeeIdx} · ` : ''}{value}</Tooltip> },
                { title: '任务 / 工具', dataIndex: 'title', ellipsis: true },
                { title: '状态', dataIndex: 'status', width: 82, render: (value: string) => <Tag color={statusColor[value] || 'default'}>{value}</Tag> },
                { title: '证据', dataIndex: 'evidenceKind', width: 105, render: (value: string, row: any) => <Tooltip title={row.evidenceLabel}><Tag color={evidenceColor(value)}>{value}</Tag></Tooltip> },
              ]} />
          </Col>
        </Row>}
      </Spin>

      <Modal open={detail.open} width={880} footer={null}
        onCancel={() => {
          detailRequestRef.current += 1;
          setDetail({ open: false, loading: false, data: null, context: null });
        }}
        title={<Space><span>运行记录穿透</span><Tag color="blue">{detail.data?.evidenceKind || '加载中'}</Tag></Space>}
      >
        {detail.loading ? <div style={{ padding: 42, textAlign: 'center' }}><Spin /></div> : detail.data ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Alert type="warning" showIcon message={detail.data.disclaimer} />
            <Panel title="本次穿刺的筛选快照与计算口径">
              <Descriptions size="small" bordered column={{ xs: 1, sm: 2 }}>
                <Descriptions.Item label="日期范围">{detail.context?.range}</Descriptions.Item>
                <Descriptions.Item label="门店">{detail.context?.store}</Descriptions.Item>
                <Descriptions.Item label="能力域">{detail.context?.domain}</Descriptions.Item>
                <Descriptions.Item label="本记录能力域">{detail.context?.recordDomain}</Descriptions.Item>
                <Descriptions.Item label="分部">{detail.context?.group}</Descriptions.Item>
                <Descriptions.Item label="员工">{detail.context?.employee}</Descriptions.Item>
                <Descriptions.Item label="来源 / 状态">{detail.context?.source} / {detail.context?.status}</Descriptions.Item>
              </Descriptions>
              <div style={{ marginTop: 8, color: 'var(--ui-text-2)', fontSize: 12, lineHeight: 1.7 }}>
                统计单位：{detail.context?.calculation?.unit || '一条持久化运行记录'}；
                产出率：{detail.context?.calculation?.outputRate || '已有产出的记录数 ÷ 当前筛选后的运行记录数'}。
                {detail.context?.calculation?.effectBoundary || '本透视不做营业额、利润、订单或顾客转化归因。'}
              </div>
            </Panel>
            <Descriptions size="small" bordered column={{ xs: 1, sm: 2 }}>
              <Descriptions.Item label="来源">{detail.data.sourceLabel}</Descriptions.Item>
              <Descriptions.Item label="状态"><Tag color={statusColor[detail.data.record?.status] || 'default'}>{detail.data.record?.status}</Tag></Descriptions.Item>
              <Descriptions.Item label="分部">{detail.data.record?.group || '-'}</Descriptions.Item>
              <Descriptions.Item label="数字员工">{detail.data.record?.employeeIdx != null ? `${detail.data.record.employeeIdx} · ` : ''}{detail.data.record?.employee || '-'}</Descriptions.Item>
              <Descriptions.Item label="运行人">{detail.data.record?.operator || '-'}</Descriptions.Item>
              <Descriptions.Item label="运行时间">{detail.data.record?.createdAt || '-'}</Descriptions.Item>
              <Descriptions.Item label="标题" span={2}>{detail.data.record?.title || '-'}</Descriptions.Item>
            </Descriptions>
            {(detail.data.record?.requirement || detail.data.record?.inputSummary || detail.data.record?.inputs) && (
              <Panel title="输入与要求">
                {detail.data.record?.requirement || detail.data.record?.inputSummary ? (
                  <div style={{ whiteSpace: 'pre-wrap', color: 'var(--ui-text-2)', lineHeight: 1.7 }}>{detail.data.record.requirement || detail.data.record.inputSummary}</div>
                ) : null}
                {detail.data.record?.inputs && Object.keys(detail.data.record.inputs).length > 0 && (
                  <pre style={{ margin: '10px 0 0', padding: 10, borderRadius: 8, background: 'var(--ui-surface-2)', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{jsonPreview(detail.data.record.inputs)}</pre>
                )}
              </Panel>
            )}
            <Panel title="运行产出">
              {detail.data.output?.body ? <Markdown content={detail.data.output.body} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未形成可查看的产出" />}
              {detail.data.output?.artifactUrl && safeUrl(detail.data.output.artifactUrl) !== '#' && (
                <Button type="link" style={{ paddingInline: 0 }} href={safeUrl(detail.data.output.artifactUrl)} target="_blank" rel="noreferrer">
                  查看媒体产出证据
                </Button>
              )}
            </Panel>
            {detail.data.output && (detail.data.output.assumptions || detail.data.output.evidence || detail.data.output.provenance) && (
              <Panel title="假设、证据与来源">
                <pre style={{ margin: 0, padding: 10, borderRadius: 8, background: 'var(--ui-surface-2)', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{jsonPreview({
                  assumptions: detail.data.output.assumptions,
                  evidence: detail.data.output.evidence,
                  provenance: detail.data.output.provenance,
                })}</pre>
              </Panel>
            )}
            {detail.data.execution?.snapshot && (
              <Panel title="完整执行快照">
                <Descriptions size="small" bordered column={{ xs: 1, sm: 2 }} style={{ marginBottom: 10 }}>
                  <Descriptions.Item label="岗位档案快照">{detail.data.execution.profileVersion ? '已保存' : '未记录'}</Descriptions.Item>
                  <Descriptions.Item label="提示词哈希">{detail.data.execution.promptHash || '-'}</Descriptions.Item>
                </Descriptions>
                <pre style={{ margin: 0, padding: 10, borderRadius: 8, background: 'var(--ui-surface-2)', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                  {jsonPreview(auditSnapshotForDisplay(detail.data.execution.snapshot))}
                </pre>
              </Panel>
            )}
          </div>
        ) : <Empty description="记录不可用" />}
      </Modal>
    </Panel>
  );
}
