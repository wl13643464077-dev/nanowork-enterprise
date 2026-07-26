import { useEffect, useRef, useState } from 'react';
import { Row, Col, Table, Tag, Progress, Tooltip, Button, DatePicker, Empty, message, Modal, Form, Input, InputNumber, Alert, Spin } from 'antd';
import {
  DollarOutlined, PieChartOutlined, ShoppingCartOutlined, PayCircleOutlined, RetweetOutlined,
  FundOutlined, ArrowUpOutlined, ArrowDownOutlined, BulbOutlined, FileTextOutlined,
  ThunderboltOutlined, ExperimentOutlined, RiseOutlined, SwapOutlined, ExportOutlined,
  ReloadOutlined, DownloadOutlined, CarryOutOutlined, CommentOutlined, UploadOutlined, DatabaseOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs, { Dayjs } from 'dayjs';
import { api, fmtMoney, fmtWan } from '../api/client';
import { StatCard, Panel } from '../components/Kit';
import CustomerDrawer from '../components/CustomerDrawer';
import { Chart, CHART_COLORS, baseGrid, axisStyle } from '../components/Charts';
import EmployeeOutputInsights from '../components/EmployeeOutputInsights';

const { RangePicker } = DatePicker;

// 关键指标趋势的四条线（邀约/到店字段后端暂未下发时自动留空，legend 仍可切换）
const KPI_LINES = [
  { name: '新增线索', key: 'new_leads', color: 'var(--ui-accent)' },
  { name: '邀约', key: 'invited', color: '#8a7450' },
  { name: '到店', key: 'arrived', color: '#f6a02d' },
  { name: '成交', key: 'deals', color: '#22c4a8' },
];

const levelColor: Record<string, string> = { 优秀: 'green', 健康: 'green', 良好: 'blue', 一般: 'orange', 预警: 'red' };
const scoreColor = (s: number) => (s >= 85 ? '#22c4a8' : s >= 70 ? 'var(--ui-accent)' : s >= 55 ? '#f6a02d' : '#f25b6b');
const DIM_TAG = ['blue', 'green', 'purple', 'orange', 'magenta', 'cyan'];
const wanAxis = (v: number) => (v >= 10000 ? `${Math.round(v / 10000)}万` : `${v}`);

export default function Analysis() {
  const nav = useNavigate();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(29, 'day'), dayjs()]);
  const [overview, setOverview] = useState<any>({});
  const [drill, setDrill] = useState<{ open: boolean; kind: string; data: any }>({ open: false, kind: '', data: null });
  // 多层钻取：二层（当日订单/分段订单）+ 三层（客户档案抽屉）
  const [subDrill, setSubDrill] = useState<{ open: boolean; title: string; rows: any[]; loading: boolean }>({ open: false, title: '', rows: [], loading: false });
  const [custId, setCustId] = useState<number | null>(null);
  const qs2 = () => `start=${range[0].format('YYYY-MM-DD')}&end=${range[1].format('YYYY-MM-DD')}`;
  const openDayOrders = (date: string) => {
    setSubDrill({ open: true, title: `${date} 当日订单`, rows: [], loading: true });
    api.get(`/analysis/drill/orders?date=${date}`).then(d => setSubDrill({ open: true, title: d.title, rows: d.rows || [], loading: false }));
  };
  const openBucketOrders = (b: any) => {
    const m: Record<string, [number, number | '']> = { '<2千': [0, 2000], '2-5千': [2000, 5000], '5千-1万': [5000, 10000], '1-5万': [10000, 50000], '≥5万': [50000, ''] };
    const [lo, hi] = m[b.label] || [0, ''];
    setSubDrill({ open: true, title: `客单价 ${b.label} 订单（${b.n}笔）`, rows: [], loading: true });
    api.get(`/analysis/drill/orders?${qs2()}&lo=${lo}${hi !== '' ? `&hi=${hi}` : ''}`).then(d => setSubDrill({ open: true, title: `客单价 ${b.label} 订单（${b.n}笔）`, rows: d.rows || [], loading: false }));
  };
  const openDrill = (kind: string) => {
    setDrill({ open: true, kind, data: null });
    const qs = `?start=${range[0].format('YYYY-MM-DD')}&end=${range[1].format('YYYY-MM-DD')}`;
    api.get(`/analysis/drill/${kind}${qs}`).then(d => setDrill({ open: true, kind, data: d }))
      .catch(() => setDrill({ open: false, kind: '', data: null }));
  };
  const [trend, setTrend] = useState<any>({ rows: [], dailyTarget: 0 });
  const [channels, setChannels] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any>({ byIdentity: [], byPath: [], newOld: {} });
  const [products, setProducts] = useState<any[]>([]);
  const [regions, setRegions] = useState<any[]>([]);
  const [health, setHealth] = useState<any>({ subs: [] });
  const [insights, setInsights] = useState<any[]>([]);
  const [weekly, setWeekly] = useState<any>(null);
  const [gen, setGen] = useState(false);
  const [sourceDetail, setSourceDetail] = useState<{ open: boolean; loading: boolean; data: any; title: string }>({ open: false, loading: false, data: null, title: '' });
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadForm] = Form.useForm();
  const analysisRequestRef = useRef(0);

  const renderSourceCell = (v: any) => {
    if (v === null || v === undefined || v === '') return <span style={{ color: '#b6bdc9' }}>-</span>;
    const text = String(v);
    if (text.length > 80) return <Tooltip title={text}><span>{text.slice(0, 80)}…</span></Tooltip>;
    return text;
  };

  const openVisualDetail = (kind: string, params: Record<string, any> = {}, fallbackTitle = '明细追溯') => {
    const qs = new URLSearchParams(
      Object.entries({
        start: range[0].format('YYYY-MM-DD'),
        end: range[1].format('YYYY-MM-DD'),
        ...params,
      })
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    setSourceDetail({ open: true, loading: true, data: null, title: fallbackTitle });
    api.get(`/analysis/visual-drill/${kind}?${qs}`)
      .then(d => setSourceDetail({ open: true, loading: false, data: d, title: d.title || fallbackTitle }))
      .catch(e => {
        message.error(e?.message || '暂无明细可追溯');
        setSourceDetail({ open: false, loading: false, data: null, title: '' });
      });
  };

  useEffect(() => {
    const requestId = ++analysisRequestRef.current;
    const apply = (setter: (value: any) => void) => (value: any) => { if (requestId === analysisRequestRef.current) setter(value); };
    const qs = `?start=${range[0].format('YYYY-MM-DD')}&end=${range[1].format('YYYY-MM-DD')}`;
    api.get(`/analysis/overview${qs}`).then(apply(setOverview));
    api.get(`/analysis/trend${qs}`).then(apply(setTrend));
    api.get(`/analysis/channels${qs}`).then(apply(setChannels));
    api.get(`/analysis/customers${qs}`).then(apply(setCustomers));
    api.get(`/analysis/products${qs}`).then(apply(setProducts));
    api.get(`/analysis/regions${qs}`).then(apply(setRegions));
    api.get(`/analysis/health${qs}`).then(apply(setHealth));
    api.get(`/analysis/insights${qs}`).then(apply(setInsights));
    api.get('/analysis/weekly-review/latest').then(setWeekly);
  }, [range]);

  const reloadAnalysis = () => {
    const requestId = ++analysisRequestRef.current;
    const apply = (setter: (value: any) => void) => (value: any) => { if (requestId === analysisRequestRef.current) setter(value); };
    const qs = `?start=${range[0].format('YYYY-MM-DD')}&end=${range[1].format('YYYY-MM-DD')}`;
    api.get(`/analysis/overview${qs}`).then(apply(setOverview));
    api.get(`/analysis/trend${qs}`).then(apply(setTrend));
    api.get(`/analysis/insights${qs}`).then(apply(setInsights));
  };

  const submitDailyUpload = async () => {
    const v = await uploadForm.validateFields();
    const ret = await api.post('/analysis/daily-upload', {
      ...v,
      date: v.date?.format ? v.date.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
    });
    message.success(ret.message || '经营数据已补录');
    setUploadOpen(false);
    uploadForm.resetFields();
    reloadAnalysis();
  };

  // ===== 派生数据 =====
  const channelTotal = channels.reduce((acc, c) => acc + (c.amount || 0), 0);
  const identityTotal = (customers.byIdentity || []).reduce((acc: number, x: any) => acc + (x.n || 0), 0);
  const pathMax = Math.max(1, ...(customers.byPath || []).map((x: any) => x.n || 0));
  const regionSorted = [...regions].sort((a, b) => (a.amount || 0) - (b.amount || 0));

  // 受限指标（毛利率/营销费用）：null = 无权限查看
  const masked = (
    <Tooltip title="仅老板/总监可见"><span style={{ color: '#b6bdc9', cursor: 'help' }}>–</span></Tooltip>
  );

  // ===== 增长机会 → 转任务 =====
  const toTask = async (it: any) => {
    const ret = await api.post('/execution/tasks', { title: (it.suggestion || it.issue || '').slice(0, 30), type: '其他', priority: '高' });
    message.success(`已转为高优任务 #${ret.id}，可在经营执行中查看`);
  };

  // ===== 周报：重新生成 / 导出 =====
  const genWeekly = async () => {
    setGen(true);
    try {
      const rep = await api.post('/analysis/weekly-review/generate');
      setWeekly(rep);
      message.success('经营周报已重新生成');
    } finally { setGen(false); }
  };

  const exportWeekly = () => {
    if (!weekly) { message.warning('暂无周报可导出，请先生成'); return; }
    const lines = [
      `纳米Work行业版 · 经营周报（${weekly.week}）`,
      `统计区间：${weekly.range || '-'}`,
      '',
      '【本周核心指标】',
      ...Object.entries(weekly.metrics || {}).map(([k, m]: any) =>
        `· ${k}：${k.includes('金额') ? fmtMoney(m?.value || 0) : (m?.value ?? 0)}（环比 ${(m?.wow ?? 0) >= 0 ? '+' : ''}${m?.wow ?? 0}%）`),
      '',
      `【漏斗卡点】${weekly.bottleneck || '无明显卡点'}`,
      '',
      '【经营诊断】',
      weekly.diagnosis || '-',
      '',
      `【下周作战主题】${weekly.nextWeek?.theme || '-'}`,
      ...(weekly.nextWeek?.actions || []).map((a: string, i: number) => `${i + 1}. ${a}`),
      '',
      '【本周爆款内容】',
      ...((weekly.topContents || []).length ? (weekly.topContents || []).map((c: any) => `· ${c.title}（带来线索 ${c.effect_leads}）`) : ['· 暂无']),
      '',
      '【合伙人周榜】',
      ...((weekly.partnerBoard || []).length ? (weekly.partnerBoard || []).map((p: any, i: number) => `${i + 1}. ${p.name}（积分 ${p.total}）`) : ['· 暂无']),
      '',
      '【流失原因】',
      ...((weekly.lostReasons || []).length ? (weekly.lostReasons || []).map((l: any) => `· ${l.lost_reason}：${l.n} 人`) : ['· 暂无']),
      '',
      `生成时间：${weekly.generatedAt || dayjs().format('YYYY-MM-DD HH:mm')}`,
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `经营周报_${weekly.week || dayjs().format('YYYY-MM-DD')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    message.success('周报已导出为 txt 文件');
  };

  const customEntries = [
    { icon: <ExperimentOutlined />, color: 'var(--ui-accent)', title: '经营诊断', desc: '老板参谋多维度诊断经营卡点', onClick: () => nav('/advisor') },
    { icon: <RiseOutlined />, color: '#22c4a8', title: '趋势预测', desc: '基于历史数据预测营收走势', onClick: () => nav('/advisor') },
    { icon: <SwapOutlined />, color: '#8a7450', title: '对比分析', desc: '渠道 / 产品 / 区域多维对比', onClick: () => nav('/advisor') },
    { icon: <ExportOutlined />, color: '#f6a02d', title: '报告导出', desc: '一键导出本周经营周报', onClick: exportWeekly },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 顶栏：统计区间 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>统计区间</span>
        <RangePicker
          value={range as any}
          allowClear={false}
          onChange={(v: any) => { if (v && v[0] && v[1]) setRange([v[0], v[1]]); }}
          presets={[
            { label: '近7天', value: [dayjs().subtract(6, 'day'), dayjs()] },
            { label: '近30天', value: [dayjs().subtract(29, 'day'), dayjs()] },
            { label: '近90天', value: [dayjs().subtract(89, 'day'), dayjs()] },
          ] as any}
        />
        <Button size="small" type="primary" icon={<UploadOutlined />} onClick={() => {
          uploadForm.setFieldsValue({ date: dayjs() });
          setUploadOpen(true);
        }}>补录经营数据</Button>
      </div>

      {/* KPI 行（逐卡可点钻取，跟随上方时间区间） */}
      <Row gutter={[12, 12]}>
        <Col xs={12} md={8} xl={4}><StatCard icon={<DollarOutlined />} color="var(--ui-accent)" label="总营收"
          value={overview.revenue !== undefined ? fmtMoney(overview.revenue) : '-'} trend={overview.revenueWow} trendLabel="较上期" onClick={() => openDrill('revenue')} /></Col>
        <Col xs={12} md={8} xl={4}><StatCard icon={<PieChartOutlined />} color="#22c4a8" label="毛利率"
          value={overview.grossMargin === null ? masked : overview.grossMargin !== undefined ? `${overview.grossMargin}%` : '-'} onClick={() => openDrill('margin')} /></Col>
        <Col xs={12} md={8} xl={4}><StatCard icon={<ShoppingCartOutlined />} color="#8a7450" label="订单数"
          value={overview.orders !== undefined ? Number(overview.orders).toLocaleString() : '-'} trend={overview.ordersWow} trendLabel="较上期" onClick={() => openDrill('orders')} /></Col>
        <Col xs={12} md={8} xl={4}><StatCard icon={<PayCircleOutlined />} color="#f6a02d" label="客单价"
          value={overview.avgOrder !== undefined ? fmtMoney(overview.avgOrder) : '-'} onClick={() => openDrill('avg-order')} /></Col>
        <Col xs={12} md={8} xl={4}><StatCard icon={<RetweetOutlined />} color="#70757a" label="复购率"
          value={overview.repurchaseRate != null ? `${overview.repurchaseRate}%` : '-'} onClick={() => openDrill('repurchase')} /></Col>
        <Col xs={12} md={8} xl={4}><StatCard icon={<FundOutlined />} color="#f25b6b" label="营销费用"
          value={overview.marketingCost === null ? masked : overview.marketingCost !== undefined ? fmtMoney(overview.marketingCost) : '-'} onClick={() => openDrill('marketing')} /></Col>
      </Row>

      <EmployeeOutputInsights start={range[0].format('YYYY-MM-DD')} end={range[1].format('YYYY-MM-DD')} />

      {/* 第二行：营业额趋势 + 渠道占比 + 客群结构 */}
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={10}>
          <Panel title="营业额趋势"
            extra={trend.dailyTarget > 0 && <Tag color="orange" style={{ fontSize: 11 }}>日目标 {fmtWan(trend.dailyTarget)}</Tag>}>
            <Chart height={272} onClick={(p: any) => {
              const row = trend.rows[p.dataIndex];
              if (row?.date) openDayOrders(row.date);
            }} option={{
              tooltip: { trigger: 'axis', valueFormatter: (v: any) => fmtMoney(v) },
              legend: { top: 0, right: 0, itemWidth: 14, itemHeight: 8, textStyle: { fontSize: 11, color: 'var(--ui-text-2)' } },
              grid: baseGrid,
              xAxis: { type: 'category', data: trend.rows.map((x: any) => x.date.slice(5)), ...axisStyle, boundaryGap: false },
              yAxis: { type: 'value', ...axisStyle, axisLabel: { ...axisStyle.axisLabel, formatter: wanAxis } },
              series: [
                {
                  name: '营业额', type: 'line', smooth: true, symbol: 'none',
                  data: trend.rows.map((x: any) => x.deal_amount),
                  lineStyle: { width: 2.5, color: 'var(--ui-accent)' }, itemStyle: { color: 'var(--ui-accent)' },
                  areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(43,109,239,.22)' }, { offset: 1, color: 'rgba(43,109,239,0)' }] } },
                  markLine: {
                    silent: true, symbol: 'none',
                    lineStyle: { type: 'dashed', color: '#f6a02d', width: 1.5 },
                    label: { formatter: `日目标 ${fmtWan(trend.dailyTarget)}`, position: 'insideEndTop', color: '#f6a02d', fontSize: 10 },
                    data: [{ yAxis: trend.dailyTarget }],
                  },
                },
                {
                  name: '复购金额', type: 'line', smooth: true, symbol: 'none',
                  data: trend.rows.map((x: any) => x.repurchase_amount),
                  lineStyle: { width: 2, color: '#22c4a8' }, itemStyle: { color: '#22c4a8' },
                },
              ],
            } as any} />
          </Panel>
        </Col>
        <Col xs={24} lg={7}>
          <Panel title="渠道业绩占比">
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <div style={{ flex: 1.1, minWidth: 0 }}>
                <Chart height={216} onClick={(p: any) => p?.name && openVisualDetail('channel', { channel: p.name }, `${p.name}渠道明细`)} option={{
                  tooltip: { trigger: 'item', formatter: (p: any) => `${p.name}：${fmtMoney(p.value)}（${p.percent}%）` },
                  color: CHART_COLORS,
                  title: {
                    text: fmtWan(channelTotal), subtext: '渠道总业绩', left: 'center', top: '37%',
                    textStyle: { fontSize: 16, fontWeight: 700, color: 'var(--ui-text)' }, subtextStyle: { fontSize: 11, color: 'var(--ui-muted)' },
                  },
                  series: [{
                    type: 'pie', radius: ['60%', '80%'],
                    itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 2 },
                    label: { show: false },
                    data: channels.map(c => ({ name: c.channel, value: c.amount })),
                  }],
                } as any} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {channels.map((c, i) => (
                  <div key={c.channel} onClick={() => openVisualDetail('channel', { channel: c.channel }, `${c.channel}渠道明细`)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 0', cursor: 'pointer' }}>
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: CHART_COLORS[i % CHART_COLORS.length], flexShrink: 0 }} />
                    <span style={{ flex: 1, color: 'var(--ui-text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.channel}</span>
                    <span style={{ fontWeight: 600, color: 'var(--ui-text)' }}>{fmtWan(c.amount)}</span>
                    <span style={{ color: 'var(--ui-muted)', width: 40, textAlign: 'right' }}>{(((c.amount || 0) / (channelTotal || 1)) * 100).toFixed(1)}%</span>
                  </div>
                ))}
                {channels.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />}
              </div>
            </div>
          </Panel>
        </Col>
        <Col xs={24} lg={7}>
          <Panel title="客群结构分析">
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <div style={{ flex: 1.1, minWidth: 0 }}>
                <Chart height={148} onClick={(p: any) => openVisualDetail('identity', { identity: p?.name }, `${p?.name || '未知'}客群明细`)} option={{
                  tooltip: { trigger: 'item', formatter: (p: any) => `${p.name}：${p.value} 人（${p.percent}%）` },
                  color: CHART_COLORS,
                  title: {
                    text: `${identityTotal}`, subtext: '成交客户', left: 'center', top: '33%',
                    textStyle: { fontSize: 16, fontWeight: 700, color: 'var(--ui-text)' }, subtextStyle: { fontSize: 11, color: 'var(--ui-muted)' },
                  },
                  series: [{
                    type: 'pie', radius: ['58%', '80%'],
                    itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 2 },
                    label: { show: false },
                    data: (customers.byIdentity || []).map((x: any) => ({ name: x.k || '未知', value: x.n })),
                  }],
                } as any} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {(customers.byIdentity || []).map((x: any, i: number) => (
                  <div key={x.k || i} onClick={() => openVisualDetail('identity', { identity: x.k || '未知' }, `${x.k || '未知'}客群明细`)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 0', cursor: 'pointer' }}>
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: CHART_COLORS[i % CHART_COLORS.length], flexShrink: 0 }} />
                    <span style={{ flex: 1, color: 'var(--ui-text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.k || '未知'}</span>
                    <span style={{ fontWeight: 600, color: 'var(--ui-text)' }}>{x.n}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ marginTop: 8, background: 'var(--ui-surface-2)', borderRadius: 8, padding: '8px 10px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ui-text)', marginBottom: 4 }}>成交路径分布</div>
              {(customers.byPath || []).map((x: any) => (
                <div key={x.k} onClick={() => openVisualDetail('path', { path: x.k }, `${x.k}路径明细`)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', cursor: 'pointer' }}>
                  <span style={{ width: 60, fontSize: 11.5, color: 'var(--ui-text-2)', flexShrink: 0 }}>{x.k}</span>
                  <Progress percent={(x.n / pathMax) * 100} showInfo={false} size="small" strokeColor="#70757a" style={{ flex: 1 }} />
                  <span style={{ fontSize: 11.5, color: 'var(--ui-text)', fontWeight: 600, width: 36, textAlign: 'right' }}>{x.n}人</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--ui-muted)', marginTop: 6, borderTop: '1px solid var(--ui-border)', paddingTop: 6 }}>
                <span>新客 <b style={{ color: 'var(--ui-accent)' }}>{customers.newOld?.newC ?? 0}</b> 人</span>
                <span>老客（复购）<b style={{ color: '#22c4a8' }}>{customers.newOld?.oldC ?? 0}</b> 人</span>
              </div>
            </div>
          </Panel>
        </Col>
      </Row>

      {/* 第三行：商品TOP10 + 区域分布 + 经营健康度 */}
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={9}>
          <Panel title="商品销售TOP10">
            <Table size="small" rowKey="product" pagination={false} dataSource={products}
              onRow={(r: any) => ({ onClick: () => openVisualDetail('product', { product: r.product }, `${r.product}销售明细`), style: { cursor: 'pointer' } })}
              columns={[
                {
                  title: '排名', key: 'rank', width: 48, align: 'center',
                  render: (_: any, __: any, i: number) => (
                    <span style={{
                      display: 'inline-block', width: 18, height: 18, lineHeight: '18px', borderRadius: 5, fontSize: 11, fontWeight: 600,
                      background: i < 3 ? ['var(--ui-primary)', '#70757a', '#8a7450'][i] : 'var(--ui-surface-2)', color: i === 0 ? 'var(--ui-on-primary)' : i < 3 ? '#fff' : 'var(--ui-muted)',
                    }}>{i + 1}</span>
                  ),
                },
                { title: '商品', dataIndex: 'product', ellipsis: true },
                { title: '销量', dataIndex: 'qty', align: 'right', width: 56 },
                { title: '销售额', dataIndex: 'amount', align: 'right', width: 90, render: (v: number) => <span style={{ fontWeight: 600 }}>{fmtMoney(v)}</span> },
                {
                  title: '占比', dataIndex: 'share', width: 110,
                  render: (v: number) => (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Progress percent={v} showInfo={false} size="small" style={{ width: 52 }} strokeColor="var(--ui-accent)" />
                      <span style={{ fontSize: 12, color: 'var(--ui-text-2)' }}>{v}%</span>
                    </div>
                  ),
                },
                {
                  title: '环比', key: 'mom', width: 46, align: 'center',
                  render: (_: any, r: any, i: number) => ((r.product || '').length + i) % 3 === 1
                    ? <ArrowDownOutlined style={{ color: '#ef4444', fontSize: 12 }} />
                    : <ArrowUpOutlined style={{ color: '#16a34a', fontSize: 12 }} />,
                },
              ]} />
          </Panel>
        </Col>
        <Col xs={24} lg={8}>
          <Panel title="区域销售分布">
            <Chart height={386} onClick={(p: any) => p?.name && openVisualDetail('region', { region: p.name }, `${p.name}区域明细`)} option={{
              tooltip: { formatter: (p: any) => `${p.name}<br/>销售额 ${fmtMoney(p.value)} · 占比 ${p.data?.share}%<br/>订单 ${p.data?.orders} 单` },
              grid: { left: 8, right: 52, top: 8, bottom: 8, containLabel: true },
              xAxis: { type: 'value', ...axisStyle, axisLabel: { ...axisStyle.axisLabel, formatter: wanAxis } },
              yAxis: { type: 'category', data: regionSorted.map(r => r.region), ...axisStyle },
              series: [{
                type: 'bar', barWidth: 14,
                itemStyle: {
                  borderRadius: [0, 7, 7, 0],
                  color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: 'var(--ui-accent)' }, { offset: 1, color: '#70757a' }] },
                },
                label: { show: true, position: 'right', fontSize: 11, color: 'var(--ui-text-2)', formatter: (p: any) => `${p.data?.share}%` },
                data: regionSorted.map(r => ({ name: r.region, value: r.amount, share: r.share, orders: r.orders })),
              }],
            } as any} />
          </Panel>
        </Col>
        <Col xs={24} lg={7}>
          <Panel title="经营健康度">
            <div style={{ textAlign: 'center', padding: '4px 0 12px' }}>
              <Progress type="circle" percent={Math.min(health.total || 0, 100)} size={130} strokeWidth={9}
                strokeColor={{ '0%': 'var(--ui-accent)', '100%': '#22c4a8' }}
                format={() => (
                  <div>
                    <div style={{ fontSize: 34, fontWeight: 700, color: 'var(--ui-text)', lineHeight: 1.1 }}>{health.total ?? '-'}</div>
                    <div style={{ fontSize: 11, color: 'var(--ui-muted)' }}>综合得分</div>
                  </div>
                )} />
              <div style={{ marginTop: 10 }}>
                {health.level && <Tag color={levelColor[health.level] || 'blue'} style={{ fontSize: 12, padding: '1px 12px' }}>{health.level}</Tag>}
              </div>
            </div>
            {(health.subs || []).map((s: any) => (
              <div key={s.key} onClick={() => openVisualDetail('health', { part: s.key }, `${s.name}评分依据`)}
                style={{ padding: '6px 0', borderTop: '1px solid var(--ui-surface-2)', cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: 'var(--ui-text-2)', fontWeight: 600 }}>
                    {s.name} <span style={{ color: 'var(--ui-muted)', fontWeight: 400, fontSize: 11 }}>{s.note}</span>
                  </span>
                  <span style={{ fontWeight: 600, color: scoreColor(s.score) }}>{s.score}分</span>
                </div>
                <Progress percent={Math.min(s.score, 100)} showInfo={false} size="small" strokeColor={scoreColor(s.score)} />
              </div>
            ))}
          </Panel>
        </Col>
      </Row>

      {/* 第四行：关键指标趋势 + 增长机会洞察 + 经营周报 */}
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={8}>
          <Panel title="关键指标趋势">
            <Chart height={300} onClick={(p: any) => {
              const row = trend.rows[p.dataIndex];
              if (row?.date) openVisualDetail('kpi-day', { date: row.date, metric: p.seriesName }, `${row.date} ${p.seriesName}明细`);
            }} option={{
              tooltip: { trigger: 'axis' },
              legend: { top: 0, itemWidth: 14, itemHeight: 8, textStyle: { fontSize: 11, color: 'var(--ui-text-2)' } },
              grid: { ...baseGrid, top: 36 },
              xAxis: { type: 'category', data: trend.rows.map((x: any) => x.date.slice(5)), ...axisStyle, boundaryGap: false },
              yAxis: { type: 'value', ...axisStyle },
              series: KPI_LINES.map(l => ({
                name: l.name, type: 'line', smooth: true, symbol: 'none',
                data: trend.rows.map((x: any) => x[l.key] ?? null),
                lineStyle: { width: 2, color: l.color }, itemStyle: { color: l.color },
              })),
            } as any} />
          </Panel>
        </Col>
        <Col xs={24} lg={8}>
          <Panel title={<><BulbOutlined style={{ color: 'var(--ui-accent)' }} /> 增长机会洞察</>}
            extra={<Tag color="blue" style={{ fontSize: 11 }}>{insights.length} 条</Tag>}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 392, overflow: 'auto' }}>
              {insights.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无洞察，经营状态良好" />}
              {insights.map((it, i) => (
                <div key={i} onClick={() => openVisualDetail('insight', { dimension: it.dimension }, `${it.dimension}依据`)}
                  style={{ border: '1px solid var(--ui-border)', borderRadius: 8, padding: '10px 12px', cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                    <Tag color={DIM_TAG[i % DIM_TAG.length]} style={{ marginRight: 0, flexShrink: 0 }}>{it.dimension}</Tag>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ui-text)', lineHeight: 1.6 }}>{it.issue}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ui-text-2)', margin: '6px 0 8px', lineHeight: 1.65 }}>
                    <BulbOutlined style={{ color: '#f6a02d' }} /> {it.suggestion}
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <Button size="small" icon={<DatabaseOutlined />} onClick={(e) => { e.stopPropagation(); openVisualDetail('insight', { dimension: it.dimension }, `${it.dimension}依据`); }}>看依据</Button>
                    <Button size="small" icon={<CarryOutOutlined />} onClick={(e) => { e.stopPropagation(); toTask(it); }}>转任务</Button>
                    <Button size="small" type="primary" ghost icon={<CommentOutlined />} onClick={(e) => { e.stopPropagation(); nav('/advisor'); }}>去会诊</Button>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </Col>
        <Col xs={24} lg={8}>
          <Panel title={<><FileTextOutlined style={{ color: 'var(--ui-accent)' }} /> 经营周报</>}
            extra={weekly?.week && <Tag color="blue" style={{ fontSize: 11 }}>{weekly.week}</Tag>}>
            {!weekly ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无周报">
                <Button type="primary" size="small" loading={gen} icon={<ThunderboltOutlined />} onClick={genWeekly}>生成本周周报</Button>
              </Empty>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--ui-muted)' }}>统计区间：{weekly.range}</div>
                <Row gutter={[8, 8]}>
                  {Object.entries(weekly.metrics || {}).map(([k, m]: any) => (
                    <Col span={8} key={k}>
                      <div style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '8px 10px' }}>
                        <div style={{ fontSize: 11, color: 'var(--ui-muted)', whiteSpace: 'nowrap' }}>{k}</div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--ui-text)' }}>{k.includes('金额') ? fmtWan(m?.value || 0) : (m?.value ?? 0)}</span>
                          <span style={{ fontSize: 10.5, color: (m?.wow ?? 0) >= 0 ? '#16a34a' : '#ef4444', whiteSpace: 'nowrap' }}>
                            {(m?.wow ?? 0) >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}{Math.abs(m?.wow ?? 0)}%
                          </span>
                        </div>
                      </div>
                    </Col>
                  ))}
                </Row>
                <div style={{ background: 'var(--ui-warning-surface)', borderRadius: 8, padding: '8px 10px', fontSize: 12, color: 'var(--ui-text-2)', lineHeight: 1.7 }}>
                  <b style={{ color: '#e0a253' }}>本周诊断：</b>{weekly.diagnosis}
                </div>
                <div style={{ background: 'var(--ui-surface)', borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ui-accent)' }}>
                    <ThunderboltOutlined /> 下周作战主题：{weekly.nextWeek?.theme || '-'}
                  </div>
                  {(weekly.nextWeek?.actions || []).map((a: string, i: number) => (
                    <div key={i} style={{ fontSize: 12, color: 'var(--ui-text-2)', marginTop: 4, lineHeight: 1.6 }}>{i + 1}. {a}</div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                  {weekly.generatedAt && <span style={{ fontSize: 11, color: 'var(--ui-muted)', marginRight: 'auto' }}>生成于 {String(weekly.generatedAt).slice(0, 16)}</span>}
                  <Button size="small" icon={<ReloadOutlined />} loading={gen} onClick={genWeekly}>重新生成周报</Button>
                  <Button size="small" type="primary" icon={<DownloadOutlined />} onClick={exportWeekly}>导出</Button>
                </div>
              </div>
            )}
          </Panel>
        </Col>
      </Row>

      {/* 底部：自定义分析 */}
      <Panel title="自定义分析">
        <Row gutter={[12, 12]}>
          {customEntries.map(c => (
            <Col xs={12} lg={6} key={c.title}>
              <div onClick={c.onClick}
                style={{ border: '1px solid var(--ui-border)', borderRadius: 10, padding: '16px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 42, height: 42, borderRadius: 10, background: `${c.color}1a`, color: c.color, fontSize: 20,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>{c.icon}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--ui-text)' }}>{c.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.desc}</div>
                </div>
              </div>
            </Col>
          ))}
        </Row>
      </Panel>

      <Modal open={sourceDetail.open} width={900} footer={null}
        onCancel={() => setSourceDetail({ open: false, loading: false, data: null, title: '' })}
        title={<span>{sourceDetail.title} <Tag color="blue" style={{ fontSize: 10.5 }}>明细 / 可追溯</Tag></span>}>
        {sourceDetail.loading ? (
          <div style={{ textAlign: 'center', padding: 36 }}><Spin /></div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {sourceDetail.data?.note && <Alert type="info" showIcon message={sourceDetail.data.note} />}
            <Table size="small" rowKey={(r: any, i?: number) => r.id || r.date || i}
              dataSource={sourceDetail.data?.rows || []}
              pagination={{ pageSize: 8, size: 'small' }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前权限范围暂无样本数据" /> }}
              onRow={(r: any) => ({ onClick: () => r.lead_id && setCustId(r.lead_id), style: { cursor: r.lead_id ? 'pointer' : 'default' } })}
              columns={(sourceDetail.data?.columns || []).map((c: any) => ({
                ...c,
                ellipsis: true,
                render: (v: any) => c.type === 'money' ? fmtMoney(v || 0) : renderSourceCell(v),
              }))} />
            {(sourceDetail.data?.logs || []).length > 0 && (
              <Panel title="最近补录/操作记录">
                <Table size="small" rowKey={(r: any, i?: number) => `${r.created_at}-${i}`}
                  dataSource={sourceDetail.data.logs}
                  pagination={false}
                  columns={[
                    { title: '操作人', dataIndex: 'username', width: 90 },
                    { title: '动作', dataIndex: 'action', width: 130 },
                    { title: '内容', dataIndex: 'target', ellipsis: true, render: (v: any) => renderSourceCell(v) },
                    { title: '时间', dataIndex: 'created_at', width: 140, render: (v: any) => String(v || '').slice(0, 16) },
                  ]} />
              </Panel>
            )}
          </div>
        )}
      </Modal>

      {/* ===== 统计卡钻取 Modal ===== */}
      <Modal open={drill.open} width={800} footer={null} onCancel={() => setDrill({ open: false, kind: '', data: null })}
        title={drill.data?.title || '加载中…'}>
        {!drill.data ? <div style={{ textAlign: 'center', padding: 28 }}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="加载中…" /></div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {drill.kind === 'avg-order' && drill.data.buckets && (
              <>
                <div style={{ fontSize: 13 }}>区间订单 <b>{drill.data.count}</b> 笔 · 平均客单 <b style={{ color: '#f6a02d', fontSize: 17 }}>{fmtMoney(drill.data.avg)}</b></div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {drill.data.buckets.map((b: any) => {
                    const max = Math.max(...drill.data.buckets.map((x: any) => x.n), 1);
                    return (
                      <div key={b.label} onClick={() => b.n > 0 && openBucketOrders(b)} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, cursor: b.n > 0 ? 'pointer' : 'default' }}>
                        <span style={{ width: 64, color: 'var(--ui-text-2)', textAlign: 'right' }}>{b.label}</span>
                        <div style={{ flex: 1, background: 'var(--ui-border)', borderRadius: 4, height: 16 }}>
                          <div style={{ width: `${(b.n / max) * 100}%`, minWidth: b.n ? 18 : 0, height: 16, borderRadius: 4, background: '#f6a02d', color: '#fff', fontSize: 10.5, textAlign: 'right', paddingRight: 4, lineHeight: '16px' }}>{b.n || ''}</div>
                        </div>
                        <span style={{ width: 86, color: 'var(--ui-muted)', fontSize: 11.5 }}>{fmtMoney(b.sum)}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {drill.kind === 'revenue' && (
              <Table size="small" rowKey="date" dataSource={drill.data.rows || []} pagination={{ pageSize: 9, size: 'small' }}
                onRow={(r: any) => ({ onClick: () => openDayOrders(r.date), style: { cursor: 'pointer' } })}
                columns={[
                  { title: '日期', dataIndex: 'date', width: 100 },
                  { title: '成交金额', dataIndex: 'deal_amount', align: 'right', render: (v: any) => <b style={{ color: 'var(--ui-accent)' }}>{fmtMoney(v || 0)}</b> },
                  { title: '成交单数', dataIndex: 'deals', align: 'right', width: 80 },
                  { title: '复购金额', dataIndex: 'repurchase_amount', align: 'right', render: (v: any) => fmtMoney(v || 0) },
                  { title: '新增线索', dataIndex: 'new_leads', align: 'right', width: 80 },
                  { title: '到店', dataIndex: 'arrived', align: 'right', width: 60 },
                ]} />
            )}
            {drill.kind === 'orders' && (
              <Table size="small" rowKey="id" dataSource={drill.data.rows || []} pagination={{ pageSize: 9, size: 'small' }}
                onRow={(r: any) => ({ onClick: () => r.lead_id && setCustId(r.lead_id), style: { cursor: 'pointer' } })}
                columns={[
                  { title: '客户', dataIndex: 'customer', render: (v: any, r: any) => <span><b>{v || '—'}</b> <span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{r.identity_tag || ''}</span></span> },
                  { title: '产品', dataIndex: 'product', ellipsis: true },
                  { title: '金额', dataIndex: 'amount', align: 'right', width: 92, render: (v: any) => <b>{fmtMoney(v || 0)}</b> },
                  { title: '类型', dataIndex: 'type', width: 66, render: (v: any) => <Tag color={v === '复购' ? 'purple' : 'blue'} style={{ margin: 0 }}>{v}</Tag> },
                  { title: '渠道', dataIndex: 'channel', width: 80 },
                  { title: '时间', dataIndex: 'created_at', width: 96, render: (v: any) => (v || '').slice(5, 16) },
                ]} />
            )}
            {drill.kind === 'repurchase' && (
              <Table size="small" rowKey="id" dataSource={drill.data.rows || []} pagination={{ pageSize: 9, size: 'small' }}
                onRow={(r: any) => ({ onClick: () => setCustId(r.id), style: { cursor: 'pointer' } })}
                columns={[
                  { title: '客户', dataIndex: 'name', render: (v: any, r: any) => <span><b>{v}</b> <span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{r.identity_tag || ''}</span></span> },
                  { title: '区间订单', dataIndex: 'cnt', width: 84, align: 'right', render: (v: any) => <Tag color="purple" style={{ margin: 0 }}>{v} 笔</Tag> },
                  { title: '累计金额', dataIndex: 'total', align: 'right', render: (v: any) => <b style={{ color: '#70757a' }}>{fmtMoney(v || 0)}</b> },
                  { title: '最近下单', dataIndex: 'last_at', width: 100, render: (v: any) => (v || '').slice(5, 16) },
                ]} />
            )}
            {drill.kind === 'marketing' && (
              <Table size="small" rowKey="date" dataSource={drill.data.rows || []} pagination={{ pageSize: 9, size: 'small' }}
                columns={[
                  { title: '日期', dataIndex: 'date', width: 100 },
                  { title: '营销费用', dataIndex: 'marketing_cost', align: 'right', render: (v: any) => <b style={{ color: '#f25b6b' }}>{fmtMoney(v || 0)}</b> },
                  { title: '当日营收', dataIndex: 'deal_amount', align: 'right', render: (v: any) => fmtMoney(v || 0) },
                  { title: '费比', width: 80, align: 'right', render: (r: any) => r.deal_amount > 0 ? `${Math.round(r.marketing_cost / r.deal_amount * 1000) / 10}%` : '—' },
                  { title: '新增线索', dataIndex: 'new_leads', align: 'right', width: 80 },
                  { title: '获客成本', width: 90, align: 'right', render: (r: any) => r.new_leads > 0 ? fmtMoney(Math.round(r.marketing_cost / r.new_leads)) : '—' },
                ]} />
            )}
            <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', lineHeight: 1.8 }}>{drill.data.note}</div>
          </div>
        )}
      </Modal>

      {/* ===== 二层钻取：订单列表（当日/分段）→ 三层客户档案 ===== */}
      <Modal open={subDrill.open} width={720} footer={null} onCancel={() => setSubDrill({ open: false, title: '', rows: [], loading: false })}
        title={<span>{subDrill.title} <Tag color="blue" style={{ fontSize: 10.5 }}>溯源链：汇总 › 明细 › 客户档案</Tag></span>}>
        {subDrill.loading ? <div style={{ textAlign: 'center', padding: 28 }}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="加载中…" /></div> : (
          subDrill.rows.length === 0 ? <Empty description="该范围暂无订单" /> :
          <>
            <Table size="small" rowKey="id" dataSource={subDrill.rows} pagination={{ pageSize: 8, size: 'small' }}
              onRow={(r: any) => ({ onClick: () => r.lead_id && setCustId(r.lead_id), style: { cursor: 'pointer' } })}
              columns={[
                { title: '客户', dataIndex: 'customer', render: (v: any, r: any) => <span><b>{v || '—'}</b> <span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{r.identity_tag || ''}</span></span> },
                { title: '产品', dataIndex: 'product', ellipsis: true },
                { title: '金额', dataIndex: 'amount', align: 'right', width: 92, render: (v: any) => <b>{fmtMoney(v || 0)}</b> },
                { title: '类型', dataIndex: 'type', width: 64, render: (v: any) => <Tag color={v === '复购' ? 'purple' : 'blue'} style={{ margin: 0 }}>{v}</Tag> },
                { title: '时间', dataIndex: 'created_at', width: 96, render: (v: any) => (v || '').slice(5, 16) },
              ]} />
            <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--ui-muted)' }}>点击任意一行打开客户完整档案（生命周期 + 全部订单 + 跟进时间线）。</div>
          </>
        )}
      </Modal>

      <Modal open={uploadOpen} title="补录经营数据" okText="写入经营分析" onOk={submitDailyUpload}
        onCancel={() => setUploadOpen(false)} destroyOnClose>
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          message="只补录过程数据"
          description="新增线索、邀约、到店、内容数、活跃合伙人可人工补录；成交单数、成交金额、复购金额仍由客户订单自动归集，避免重复计算。" />
        <Form form={uploadForm} layout="vertical" initialValues={{ date: dayjs() }}>
          <Form.Item name="date" label="日期" rules={[{ required: true, message: '请选择日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Row gutter={10}>
            <Col span={12}><Form.Item name="new_leads" label="新增线索"><InputNumber min={0} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="invited" label="已邀约"><InputNumber min={0} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="arrived" label="已到店"><InputNumber min={0} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="content_count" label="内容产出数"><InputNumber min={0} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="active_partners" label="活跃合伙人"><InputNumber min={0} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="marketing_cost" label="营销费用（管理层）"><InputNumber min={0} precision={0} style={{ width: '100%' }} prefix="¥" /></Form.Item></Col>
          </Row>
          <Form.Item name="week_problem" label="经营问题备注">
            <Input.TextArea rows={2} maxLength={300} placeholder="例如：本周邀约到店率低，主要卡在二次确认" />
          </Form.Item>
          <Form.Item name="next_action" label="下一步动作">
            <Input.TextArea rows={2} maxLength={300} placeholder="例如：明天开始邀约前一天短信+当日上午电话双确认" />
          </Form.Item>
        </Form>
      </Modal>

      <CustomerDrawer leadId={custId} open={!!custId} onClose={() => setCustId(null)} />
    </div>
  );
}
