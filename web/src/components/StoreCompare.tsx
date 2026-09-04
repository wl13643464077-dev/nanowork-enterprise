import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, DatePicker, Empty, Segmented, Space, Table, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { api, fmtMoney } from '../api/client';
import { Chart, CHART_COLORS, axisStyle, baseGrid, chartAnimation } from './Charts';
import { Panel } from './Kit';
import './StoreCompare.css';

// 总部门店对比（连锁）：GET /store-data/compare?from=&to= → 每店营收/订单/客单价/成本率/差评/巡店 + 环比。
// 无数据的指标服务端给 null，这里显示「—」，绝不补 0 或估算。

type CompareRow = {
  storeId: number;
  name: string;
  code: string | null;
  region: string | null;
  status: string;
  isDefault: boolean;
  revenue: number | null;
  orders: number;
  avgTicket: number | null;
  totalCost: number | null;
  costRate: number | null;
  badReviews: number;
  inspectionScore: number | null;
  inspections: number;
  prev: { revenue: number | null; orders: number; revenueChangePct: number | null; ordersChangePct: number | null };
};
type CompareResponse = {
  from: string;
  to: string;
  spanDays: number;
  prevRange: { from: string; to: string };
  rows: CompareRow[];
  unassigned: { orders: number; revenue: number | null };
  note: string;
};

const METRICS = [
  { key: 'revenue', label: '营收', unit: '¥' },
  { key: 'orders', label: '订单数', unit: '' },
  { key: 'avgTicket', label: '客单价', unit: '¥' },
  { key: 'costRate', label: '成本率', unit: '%' },
  { key: 'badReviews', label: '差评数', unit: '' },
  { key: 'inspectionScore', label: '巡店得分', unit: '' },
] as const;
type MetricKey = (typeof METRICS)[number]['key'];

const dash = <span className="store-compare-null">—</span>;
const money = (v: number | null) => (v == null ? dash : <b>{fmtMoney(v)}</b>);
const pctText = (v: number | null) => (v == null ? dash : `${v}%`);
const changeTag = (v: number | null, invert = false) => {
  if (v == null) return dash;
  const up = v > 0;
  const good = invert ? !up : up;
  return (
    <Tag className={`store-compare-change ${good ? 'is-good' : v === 0 ? '' : 'is-bad'}`}>
      {up ? '+' : ''}
      {v}%
    </Tag>
  );
};

export default function StoreCompare({ storeCount }: { storeCount: number }) {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(29, 'day'), dayjs()]);
  const [metric, setMetric] = useState<MetricKey>('revenue');
  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    const qs = new URLSearchParams({ from: range[0].format('YYYY-MM-DD'), to: range[1].format('YYYY-MM-DD') });
    api
      .get(`/store-data/compare?${qs}`, { silent: true })
      .then((d: CompareResponse) => setData(d))
      .catch((e: any) => setError(e?.message || '门店对比加载失败'))
      .finally(() => setLoading(false));
  }, [range]);

  useEffect(() => {
    if (storeCount <= 1) return undefined;
    const frame = requestAnimationFrame(load);
    return () => cancelAnimationFrame(frame);
  }, [load, storeCount]);

  const chartOption = useMemo(() => {
    const rows = data?.rows || [];
    const meta = METRICS.find(m => m.key === metric)!;
    return {
      ...chartAnimation,
      color: CHART_COLORS,
      grid: { ...baseGrid, left: 12 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: unknown) =>
          v == null ? '无数据' : `${meta.unit === '¥' ? '¥' : ''}${v}${meta.unit === '%' ? '%' : ''}`,
      },
      xAxis: { type: 'category', data: rows.map(r => r.name), ...axisStyle },
      yAxis: { type: 'value', ...axisStyle },
      series: [
        {
          type: 'bar',
          name: meta.label,
          barMaxWidth: 42,
          data: rows.map(r => r[metric] ?? null),
          itemStyle: { borderRadius: [6, 6, 0, 0] },
          label: {
            show: true,
            position: 'top',
            color: 'var(--ui-text-2)',
            formatter: (p: any) => (p.value == null ? '—' : String(p.value)),
          },
        },
      ],
    };
  }, [data, metric]);

  if (storeCount <= 1) {
    return (
      <Panel title="门店对比">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span className="store-compare-empty">
              只有一家门店时无需切换或对比。在「门店」页签新增第二家门店后，这里会按门店并排展示营收、客单价、成本率、差评与巡店得分。
            </span>
          }
        />
      </Panel>
    );
  }

  return (
    <Panel
      title="门店对比"
      extra={
        <Space size={8} wrap>
          <DatePicker.RangePicker
            size="small"
            allowClear={false}
            value={range}
            onChange={v => v && v[0] && v[1] && setRange([v[0], v[1]])}
            disabledDate={d => d.isAfter(dayjs(), 'day')}
          />
          <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading}>
            刷新
          </Button>
        </Space>
      }
    >
      {error && <Alert type="error" showIcon className="store-compare-alert" message={error} />}
      {data && (
        <div className="store-compare-meta">
          <span>
            区间 {data.from} 至 {data.to}（{data.spanDays} 天），环比对象 {data.prevRange.from} 至 {data.prevRange.to}
          </span>
          {data.unassigned.orders > 0 && (
            <Tag className="store-compare-unassigned">
              另有 {data.unassigned.orders} 张订单未归属门店（{fmtMoney(data.unassigned.revenue || 0)}），未计入任何一家
            </Tag>
          )}
        </div>
      )}
      <div className="store-compare-chart-head">
        <Segmented
          size="small"
          value={metric}
          onChange={v => setMetric(v as MetricKey)}
          options={METRICS.map(m => ({ value: m.key, label: m.label }))}
        />
      </div>
      <Chart option={chartOption} height={240} ariaLabel="各门店指标对比柱状图" />
      <Table<CompareRow>
        size="small"
        rowKey="storeId"
        loading={loading}
        dataSource={data?.rows || []}
        pagination={false}
        className="store-compare-table"
        columns={[
          {
            title: '门店',
            dataIndex: 'name',
            ellipsis: true,
            render: (v: string, r) => (
              <span className="store-compare-name">
                {v}
                {r.isDefault && <Tag className="store-compare-default">默认</Tag>}
                {r.code && <span className="store-compare-code">{r.code}</span>}
              </span>
            ),
          },
          { title: '区域', dataIndex: 'region', width: 90, render: (v: string | null) => v || dash },
          { title: '营收', dataIndex: 'revenue', width: 120, align: 'right', render: money },
          {
            title: '营收环比',
            key: 'revWow',
            width: 100,
            align: 'right',
            render: (_, r) => changeTag(r.prev.revenueChangePct),
          },
          { title: '订单', dataIndex: 'orders', width: 70, align: 'right' },
          {
            title: '订单环比',
            key: 'ordWow',
            width: 100,
            align: 'right',
            render: (_, r) => changeTag(r.prev.ordersChangePct),
          },
          { title: '客单价', dataIndex: 'avgTicket', width: 100, align: 'right', render: money },
          { title: '成本率', dataIndex: 'costRate', width: 84, align: 'right', render: pctText },
          {
            title: '差评',
            dataIndex: 'badReviews',
            width: 70,
            align: 'right',
            render: (v: number) => (v > 0 ? <span className="store-compare-bad">{v}</span> : v),
          },
          {
            title: '巡店得分',
            dataIndex: 'inspectionScore',
            width: 100,
            align: 'right',
            render: (v: number | null, r) => (v == null ? dash : `${v}（${r.inspections} 次）`),
          },
        ]}
      />
      {data?.note && <div className="store-compare-note">{data.note}</div>}
    </Panel>
  );
}
