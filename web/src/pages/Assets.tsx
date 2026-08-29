import { useEffect, useState } from 'react';
import {
  Row,
  Col,
  Table,
  Tag,
  Badge,
  Progress,
  Select,
  Input,
  Collapse,
  Timeline,
  Empty,
  message,
  Modal,
  Drawer,
  Spin,
  Button,
  Form,
  InputNumber,
  Alert,
  Tooltip,
  Popconfirm,
} from 'antd';
import {
  DatabaseOutlined,
  PayCircleOutlined,
  PlusSquareOutlined,
  PlayCircleOutlined,
  FundOutlined,
  ThunderboltOutlined,
  FireOutlined,
  AlertOutlined,
  SyncOutlined,
  PieChartOutlined,
  UploadOutlined,
  DeleteOutlined,
  PlusOutlined,
  EditOutlined,
  DownloadOutlined,
  ApartmentOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { api, fmtMoney, fmtWan } from '../api/client';
import { loadXlsx } from '../utils/xlsx';
import { StatCard, Panel } from '../components/Kit';
import CustomerDrawer from '../components/CustomerDrawer';
import { Chart, CHART_COLORS, baseGrid, axisStyle } from '../components/Charts';

const CATEGORIES = ['内容资产', '知识资产', '客户资产', '数据资产', '品牌资产'];
const STATUSES = ['使用中', '闲置', '待归档', '已归档'];
const catTagColor: Record<string, string> = {
  内容资产: 'blue',
  知识资产: 'purple',
  客户资产: 'cyan',
  数据资产: 'orange',
  品牌资产: 'magenta',
};
const catChartColor: Record<string, string> = {
  内容资产: 'var(--ui-accent)',
  知识资产: 'var(--chart-3)',
  客户资产: 'var(--chart-2)',
  数据资产: 'var(--warn)',
  品牌资产: 'var(--danger)',
};
const statusColor: Record<string, string> = {
  使用中: 'var(--chart-2)',
  闲置: 'var(--warn)',
  待归档: 'var(--ui-muted)',
  已归档: 'var(--ui-muted)',
};
const actionColor: Record<string, string> = {
  创建: 'var(--ui-accent)',
  新增: 'var(--ui-accent)',
  入库: 'var(--ui-accent)',
  启用: 'var(--chart-2)',
  使用: 'var(--chart-2)',
  调用: 'var(--ui-muted)',
  更新: 'var(--chart-3)',
  闲置: 'var(--warn)',
  流转: 'var(--warn)',
  归档: 'var(--ui-muted)',
};
const buttonResetStyle = {
  appearance: 'none',
  border: 0,
  padding: 0,
  margin: 0,
  width: '100%',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'inherit',
} as const;

export default function Assets() {
  const [summary, setSummary] = useState<any>({});
  const [drill, setDrill] = useState<{ open: boolean; kind: string; data: any }>({ open: false, kind: '', data: null });
  const openDrill = (kind: string) => {
    setDrill({ open: true, kind, data: null });
    api
      .get(`/assets/drill/${kind}`)
      .then(d => setDrill({ open: true, kind, data: d }))
      .catch(() => {});
  };
  // 资产溯源抽屉（数据从哪来：源对象原文 + 流转时间线）
  const [trace, setTrace] = useState<{ open: boolean; data: any }>({ open: false, data: null });
  const [custId, setCustId] = useState<number | null>(null);
  const openTrace = (id: number) => {
    setTrace({ open: true, data: null });
    api
      .get(`/assets/${id}/trace`)
      .then(d => setTrace({ open: true, data: d }))
      .catch(() => setTrace({ open: false, data: null }));
  };
  const [categories, setCategories] = useState<any[]>([]);
  const [trend, setTrend] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [list, setList] = useState<any>({ total: 0, rows: [] });
  const [topUsed, setTopUsed] = useState<any[]>([]);
  const [warnings, setWarnings] = useState<any>(null);
  const [lifecycle, setLifecycle] = useState<any[]>([]);
  const [flows, setFlows] = useState<any[]>([]);
  const [sourceDetail, setSourceDetail] = useState<{ open: boolean; loading: boolean; data: any; title: string }>({
    open: false,
    loading: false,
    data: null,
    title: '',
  });
  const [importOpen, setImportOpen] = useState(false);
  const [importForm] = Form.useForm();
  // 单条新增 / 编辑
  const [assetModal, setAssetModal] = useState<{ open: boolean; id: number | null }>({ open: false, id: null });
  const [assetSaving, setAssetSaving] = useState(false);
  const [assetForm] = Form.useForm();
  const [exporting, setExporting] = useState(false);
  // 数据来源地图（每个资产口径的数据出处）
  const [sourceMap, setSourceMap] = useState<any>(null);
  const [sourceMapError, setSourceMapError] = useState('');
  // 清单筛选
  const [category, setCategory] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [kw, setKw] = useState('');
  const [page, setPage] = useState(1);

  const renderSourceCell = (v: any) => {
    if (v === null || v === undefined || v === '') return <span style={{ color: '#b6bdc9' }}>-</span>;
    const text = String(v);
    if (text.length > 80)
      return (
        <Tooltip title={text}>
          <span>{text.slice(0, 80)}…</span>
        </Tooltip>
      );
    return text;
  };

  const openVisualDetail = (kind: string, params: Record<string, any> = {}, fallbackTitle = '明细追溯') => {
    const qs = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    setSourceDetail({ open: true, loading: true, data: null, title: fallbackTitle });
    api
      .get(`/assets/visual-drill/${kind}${qs ? `?${qs}` : ''}`)
      .then(d => setSourceDetail({ open: true, loading: false, data: d, title: d.title || fallbackTitle }))
      .catch(e => {
        message.error(e?.message || '暂无明细可追溯');
        setSourceDetail({ open: false, loading: false, data: null, title: '' });
      });
  };

  useEffect(() => {
    api.get('/assets/summary').then(setSummary);
    api.get('/assets/categories').then(setCategories);
    api.get('/assets/value-trend').then(setTrend);
    api.get('/assets/health').then(setHealth);
    api.get('/assets/top-used').then(setTopUsed);
    api.get('/assets/warnings').then(setWarnings);
    api.get('/assets/lifecycle').then(setLifecycle);
    api.get('/assets/flows').then(setFlows);
  }, []);

  const loadList = () => {
    api
      .get(
        `/assets?category=${encodeURIComponent(category || '')}&status=${encodeURIComponent(status || '')}&kw=${encodeURIComponent(kw)}&page=${page}&size=10`,
      )
      .then(setList);
  };
  useEffect(loadList, [category, status, kw, page]);

  // 状态流转：操作后刷新列表及相关统计
  const changeStatus = (id: any, next: string) => {
    api.post(`/assets/${id}/status`, { status: next }).then(() => {
      message.success(`资产已流转为「${next}」`);
      loadList();
      api.get('/assets/summary').then(setSummary);
      api.get('/assets/lifecycle').then(setLifecycle);
      api.get('/assets/warnings').then(setWarnings);
      api.get('/assets/flows').then(setFlows);
    });
  };

  const refreshAssets = () => {
    api.get('/assets/summary').then(setSummary);
    api.get('/assets/categories').then(setCategories);
    api.get('/assets/value-trend').then(setTrend);
    api.get('/assets/health').then(setHealth);
    api.get('/assets/top-used').then(setTopUsed);
    api.get('/assets/warnings').then(setWarnings);
    api.get('/assets/lifecycle').then(setLifecycle);
    api.get('/assets/flows').then(setFlows);
    loadList();
  };
  const loadSourceMap = () => {
    setSourceMapError('');
    api
      .get('/assets/source-map')
      .then(setSourceMap)
      .catch((e: any) => setSourceMapError(e?.message || '来源地图加载失败'));
  };
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) loadSourceMap();
    });
    return () => {
      cancelled = true;
    };
    // Mount-only source map initialization; the retry path continues to use loadSourceMap directly.
  }, []);
  const openSourceSample = (card: any) => {
    setSourceDetail({ open: true, loading: true, data: null, title: card.title });
    api
      .get(`/assets/source-samples/${card.key}`)
      .then(d => setSourceDetail({ open: true, loading: false, data: d, title: d.title || card.title }))
      .catch((e: any) => {
        message.error(e?.message || '暂无来源样本');
        setSourceDetail({ open: false, loading: false, data: null, title: '' });
      });
  };

  const openAssetForm = (r?: any) => {
    assetForm.resetFields();
    if (r)
      assetForm.setFieldsValue({
        name: r.name,
        category: r.category,
        value: r.value ?? 0,
        status: r.status,
        owner: r.owner,
        url: r.url,
        note: r.note,
      });
    else assetForm.setFieldsValue({ category: '数据资产', status: '使用中', value: 0 });
    setAssetModal({ open: true, id: r?.id ?? null });
  };
  const submitAssetForm = async () => {
    const v = await assetForm.validateFields();
    setAssetSaving(true);
    try {
      const payload = { ...v, value: v.value ?? 0 };
      if (assetModal.id) {
        await api.put(`/assets/${assetModal.id}`, payload);
        message.success('资产已更新');
      } else {
        await api.post('/assets', payload);
        message.success('资产已登记，并写入流转动态');
      }
      setAssetModal({ open: false, id: null });
      refreshAssets();
    } finally {
      setAssetSaving(false);
    }
  };

  const SOURCE_LABEL: Record<string, string> = {
    content: '内容',
    media_job: '媒体',
    kb: '知识库',
    lead: '客户',
    order: '订单',
    daily_ops: '日报',
    activity: '活动',
    partner: '合伙人',
    task: '任务',
    manual_upload: '导入',
    manual: '手动',
  };
  const exportAssets = async () => {
    setExporting(true);
    try {
      const rows: any[] = [];
      let p = 1;
      for (;;) {
        const d = await api.get(
          `/assets?category=${encodeURIComponent(category || '')}&status=${encodeURIComponent(status || '')}&kw=${encodeURIComponent(kw)}&page=${p}&size=100`,
        );
        rows.push(...(d.rows || []));
        if (!(d.rows || []).length || rows.length >= (d.total || 0) || p >= 50) break;
        p += 1;
      }
      if (!rows.length) {
        message.warning('当前筛选条件下暂无资产可导出');
        return;
      }
      const exportRows = rows.map((r: any) => ({
        资产名称: r.name,
        分类: r.category,
        估值: Number(r.value) > 0 ? Number(r.value) : '未估值',
        状态: r.status,
        调用次数: r.use_count ?? 0,
        归属: r.owner || '',
        来源: SOURCE_LABEL[r.source_type] || r.source_type || '',
        链接: r.url || '',
        备注: r.note || '',
        登记时间: String(r.created_at || '').slice(0, 16),
        更新时间: String(r.updated_at || '').slice(0, 16),
      }));
      const XLSX = await loadXlsx();
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportRows), '资产台账');
      XLSX.writeFile(wb, `资产台账-${new Date().toISOString().slice(0, 10)}.xlsx`);
      message.success(`已导出 ${exportRows.length} 项资产`);
    } finally {
      setExporting(false);
    }
  };

  const deleteAsset = (r: any) => {
    api
      .del(`/assets/${r.id}`)
      .then(() => {
        message.success('资产已删除并进入回收站');
        if (trace.open && trace.data?.id === r.id) setTrace({ open: false, data: null });
        refreshAssets();
      })
      .catch(() => {});
  };

  const parseBatchAssets = (text: string) => {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);
    const rows = lines
      .map(line => {
        const parts = line.includes('\t') ? line.split('\t') : line.split(/[,，]/);
        return {
          name: parts[0]?.trim(),
          category: parts[1]?.trim(),
          value: parts[2]?.trim(),
          status: parts[3]?.trim(),
          owner: parts[4]?.trim(),
          note: parts.slice(5).join('，').trim(),
        };
      })
      .filter(r => r.name && !['资产名称', '名称', 'name'].includes(r.name));
    return rows;
  };

  const submitAssetImport = async () => {
    const v = await importForm.validateFields();
    const batchRows = parseBatchAssets(v.batchText);
    const rows = batchRows.length
      ? batchRows
      : [
          {
            name: v.name,
            category: v.category,
            value: v.value,
            status: v.status,
            owner: v.owner,
            url: v.url,
            note: v.note,
          },
        ];
    const ret = await api.post('/assets/import', { rows });
    message.success(
      `导入完成：成功 ${ret.created?.length || 0} 项${ret.errors?.length ? `，失败 ${ret.errors.length} 项` : ''}`,
    );
    setImportOpen(false);
    importForm.resetFields();
    refreshAssets();
  };

  const catTotal = categories.reduce((s, c) => s + (c.n || 0), 0);
  const score = health?.score ?? 0;
  const scoreColor = score >= 80 ? 'var(--chart-2)' : score >= 60 ? 'var(--warn)' : 'var(--danger)';
  const scoreLevel = score >= 80 ? '健康' : score >= 60 ? '良好' : '需关注';
  const maxUse = Math.max(...topUsed.map(t => t.use_count || 0), 1);
  const wCounts = warnings?.counts || {};
  const warnGroups = [
    {
      key: 'idle',
      label: '闲置超90天',
      tag: 'orange',
      color: 'var(--warn)',
      n: wCounts.idle ?? (warnings?.idle || []).length,
      rows: warnings?.idle || [],
    },
    {
      key: 'incomplete',
      label: '信息不完整',
      tag: 'red',
      color: 'var(--danger)',
      n: wCounts.incomplete ?? (warnings?.incomplete || []).length,
      rows: warnings?.incomplete || [],
    },
    {
      key: 'lowUse',
      label: '零调用',
      tag: 'default',
      color: 'var(--ui-muted)',
      n: wCounts.lowUse ?? (warnings?.lowUse || []).length,
      rows: warnings?.lowUse || [],
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* KPI 行（逐卡可点钻取） */}
      <Row gutter={[12, 12]}>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<DatabaseOutlined />}
            color="var(--ui-accent)"
            label="资产总数"
            value={summary.total ?? '-'}
            suffix="项"
            onClick={() => openDrill('total')}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<PayCircleOutlined />}
            color="var(--warn)"
            label="资产总价值"
            value={fmtWan(summary.totalValue || 0)}
            onClick={() => openDrill('value')}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<PlusSquareOutlined />}
            color="var(--chart-2)"
            label="本月新增资产"
            value={summary.monthNew ?? '-'}
            suffix="项"
            onClick={() => openDrill('month-new')}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<PlayCircleOutlined />}
            color="var(--chart-3)"
            label="使用中资产"
            value={summary.inUse ?? '-'}
            suffix={summary.total ? `占比 ${((summary.inUse / summary.total) * 100).toFixed(1)}%` : ''}
            onClick={() => openDrill('in-use')}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<FundOutlined />}
            color="var(--ui-muted)"
            label="资产使用率"
            value={`${summary.useRate ?? '-'}%`}
            onClick={() => openDrill('use-rate')}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<ThunderboltOutlined />}
            color="var(--danger)"
            label="调用次数"
            value={summary.calls ?? '-'}
            trend={summary.valueGrowth}
            trendLabel="价值增长"
            onClick={() => openDrill('calls')}
          />
        </Col>
      </Row>

      {/* 第二行：分类概览 + 价值趋势 + 健康度 */}
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={8}>
          <Panel
            title="资产分类概览"
            extra={<span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>共 {catTotal} 项</span>}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: '46%', flexShrink: 0 }}>
                <Chart
                  height={210}
                  onClick={(p: any) => {
                    setCategory(p.name);
                    setPage(1);
                    openVisualDetail('category', { category: p.name }, `${p.name}资产明细`);
                  }}
                  option={{
                    tooltip: { trigger: 'item', formatter: (p: any) => `${p.name}：${p.value} 项（${p.percent}%）` },
                    title: {
                      text: String(catTotal || '-'),
                      subtext: '资产总数',
                      left: 'center',
                      top: '36%',
                      textStyle: { fontSize: 22, fontWeight: 700, color: 'var(--ui-text)' },
                      subtextStyle: { fontSize: 11, color: 'var(--ui-muted)' },
                    },
                    series: [
                      {
                        type: 'pie',
                        radius: ['58%', '80%'],
                        avoidLabelOverlap: false,
                        label: { show: false },
                        itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 4 },
                        data: categories.map((c, i) => ({
                          name: c.category,
                          value: c.n,
                          itemStyle: { color: catChartColor[c.category] || CHART_COLORS[i % CHART_COLORS.length] },
                        })),
                      },
                    ],
                  }}
                />
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 9, minWidth: 0 }}>
                {categories.map((c, i) => (
                  <button
                    type="button"
                    key={c.category}
                    onClick={() => {
                      setCategory(c.category);
                      setPage(1);
                      openVisualDetail('category', { category: c.category }, `${c.category}资产明细`);
                    }}
                    style={{
                      ...buttonResetStyle,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        flexShrink: 0,
                        background: catChartColor[c.category] || CHART_COLORS[i % CHART_COLORS.length],
                      }}
                    />
                    <span
                      style={{
                        color: 'var(--ui-text-2)',
                        flex: 1,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {c.category}
                    </span>
                    <span style={{ color: 'var(--ui-text)', fontWeight: 600 }}>{c.n}</span>
                    <span style={{ color: 'var(--ui-muted)', width: 64, textAlign: 'right' }}>{fmtWan(c.v || 0)}</span>
                  </button>
                ))}
              </div>
            </div>
          </Panel>
        </Col>
        <Col xs={24} lg={8}>
          <Panel
            title="资产价值趋势"
            extra={
              <Tag color="blue" style={{ fontSize: 11 }}>
                近{trend.length || 0}周
              </Tag>
            }
          >
            <Chart
              height={210}
              onClick={(p: any) => {
                const row = trend[p.dataIndex];
                if (row?.week) openVisualDetail('value-trend', { date: row.week }, `${row.week}资产沉淀`);
              }}
              option={{
                tooltip: {
                  trigger: 'axis',
                  formatter: (ps: any) => {
                    let s = `${ps[0]?.axisValue || ''}<br/>`;
                    ps.forEach((p: any) => {
                      s += `${p.marker}${p.seriesName}：${p.seriesName === '资产价值' ? fmtWan(p.value) : `${p.value} 项`}<br/>`;
                    });
                    return s;
                  },
                },
                legend: { top: 0, itemWidth: 14, textStyle: { fontSize: 11, color: 'var(--ui-text-2)' } },
                grid: baseGrid,
                xAxis: { type: 'category', data: trend.map(x => x.week), ...axisStyle, boundaryGap: false },
                yAxis: [
                  {
                    type: 'value',
                    ...axisStyle,
                    axisLabel: {
                      color: 'var(--ui-muted)',
                      fontSize: 11,
                      formatter: (v: any) => (v >= 10000 ? `${(v / 10000).toFixed(0)}万` : v),
                    },
                  },
                  { type: 'value', ...axisStyle, splitLine: { show: false } },
                ],
                series: [
                  {
                    name: '资产价值',
                    type: 'line',
                    smooth: true,
                    symbol: 'none',
                    yAxisIndex: 0,
                    data: trend.map(x => x.value),
                    lineStyle: { width: 2.5, color: 'var(--ui-accent)' },
                    itemStyle: { color: 'var(--ui-accent)' },
                    areaStyle: {
                      color: {
                        type: 'linear',
                        x: 0,
                        y: 0,
                        x2: 0,
                        y2: 1,
                        colorStops: [
                          { offset: 0, color: 'rgba(43,109,239,.25)' },
                          { offset: 1, color: 'rgba(43,109,239,0)' },
                        ],
                      },
                    },
                  },
                  {
                    name: '资产数量',
                    type: 'line',
                    smooth: true,
                    symbol: 'circle',
                    symbolSize: 5,
                    yAxisIndex: 1,
                    data: trend.map(x => x.count),
                    lineStyle: { width: 2, color: 'var(--chart-2)' },
                    itemStyle: { color: 'var(--chart-2)' },
                  },
                ],
              }}
            />
          </Panel>
        </Col>
        <Col xs={24} lg={8}>
          <Panel
            title="资产健康度"
            extra={
              <Tag color={score >= 80 ? 'green' : score >= 60 ? 'orange' : 'red'} style={{ fontSize: 11 }}>
                {scoreLevel}
              </Tag>
            }
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '8px 4px' }}>
              <Progress
                type="dashboard"
                percent={score}
                size={150}
                strokeColor={scoreColor}
                strokeWidth={9}
                format={() => (
                  <div>
                    <div style={{ fontSize: 30, fontWeight: 700, color: 'var(--ui-text)' }}>
                      {health ? score : '-'}
                      <span style={{ fontSize: 14, fontWeight: 500 }}>分</span>
                    </div>
                    <div style={{ fontSize: 12, color: scoreColor, marginTop: 2 }}>{health ? scoreLevel : ''}</div>
                  </div>
                )}
              />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
                {(health?.subs || []).map((s: any, i: number) => (
                  <button
                    type="button"
                    key={s.name}
                    onClick={() => openVisualDetail('health', { part: s.name }, `${s.name}明细`)}
                    style={{ ...buttonResetStyle, cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                      <span style={{ color: 'var(--ui-text-2)' }}>{s.name}</span>
                      <span style={{ color: 'var(--ui-text)', fontWeight: 600 }}>{s.value}%</span>
                    </div>
                    <Progress
                      percent={s.value}
                      showInfo={false}
                      size="small"
                      strokeColor={CHART_COLORS[i % CHART_COLORS.length]}
                    />
                  </button>
                ))}
              </div>
            </div>
          </Panel>
        </Col>
      </Row>

      {/* 第三行：资产清单 + 右侧 TOP5/预警 */}
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={17}>
          <Panel
            title="资产清单"
            extra={
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Select
                  size="small"
                  placeholder="分类"
                  allowClear
                  style={{ width: 104 }}
                  value={category}
                  options={CATEGORIES.map(c => ({ value: c, label: c }))}
                  onChange={v => {
                    setCategory(v);
                    setPage(1);
                  }}
                />
                <Select
                  size="small"
                  placeholder="状态"
                  allowClear
                  style={{ width: 92 }}
                  value={status}
                  options={STATUSES.map(s => ({ value: s, label: s }))}
                  onChange={v => {
                    setStatus(v);
                    setPage(1);
                  }}
                />
                <Input.Search
                  size="small"
                  placeholder="搜索资产名称"
                  allowClear
                  style={{ width: 170 }}
                  onSearch={v => {
                    setKw(v.trim());
                    setPage(1);
                  }}
                />
                <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openAssetForm()}>
                  新增资产
                </Button>
                <Button
                  size="small"
                  icon={<UploadOutlined />}
                  onClick={() => {
                    importForm.setFieldsValue({ category: '数据资产', status: '使用中' });
                    setImportOpen(true);
                  }}
                >
                  导入资产
                </Button>
                <Button size="small" icon={<DownloadOutlined />} loading={exporting} onClick={exportAssets}>
                  导出 Excel
                </Button>
              </div>
            }
          >
            <Table
              size="small"
              rowKey="id"
              dataSource={list.rows || []}
              pagination={{
                current: page,
                pageSize: 10,
                total: list.total || 0,
                size: 'small',
                showSizeChanger: false,
                onChange: p => setPage(p),
                showTotal: t => `共 ${t} 项资产`,
              }}
              columns={[
                {
                  title: '资产名称',
                  dataIndex: 'name',
                  ellipsis: true,
                  render: (v: string) => <span style={{ fontWeight: 600, color: 'var(--ui-text)' }}>{v}</span>,
                },
                {
                  title: '分类',
                  dataIndex: 'category',
                  width: 90,
                  render: (v: string) => <Tag color={catTagColor[v] || 'default'}>{v}</Tag>,
                },
                {
                  title: '资产价值',
                  dataIndex: 'value',
                  align: 'right',
                  width: 100,
                  render: (v: number) =>
                    Number(v) > 0 ? (
                      <span style={{ fontWeight: 600 }}>{fmtMoney(v)}</span>
                    ) : (
                      <Tooltip title="估值为 0 表示尚未估值，不计入资产总值；可点「编辑」补充">
                        <Tag style={{ margin: 0, color: 'var(--ui-muted)' }}>未估值</Tag>
                      </Tooltip>
                    ),
                },
                {
                  title: '状态',
                  dataIndex: 'status',
                  width: 84,
                  render: (v: string) => (
                    <Badge
                      color={statusColor[v] || 'var(--ui-muted)'}
                      text={<span style={{ fontSize: 12 }}>{v}</span>}
                    />
                  ),
                },
                {
                  title: '来源',
                  dataIndex: 'source_type',
                  width: 96,
                  render: (v: string) => (
                    <Tag
                      color={
                        v === 'manual_upload'
                          ? 'gold'
                          : v === 'content' || v === 'media_job'
                            ? 'blue'
                            : v === 'kb'
                              ? 'purple'
                              : 'default'
                      }
                      style={{ margin: 0 }}
                    >
                      {(
                        {
                          content: '内容',
                          media_job: '媒体',
                          kb: '知识库',
                          lead: '客户',
                          manual_upload: '导入',
                          manual: '手动',
                        } as Record<string, string>
                      )[v] ||
                        v ||
                        '-'}
                    </Tag>
                  ),
                },
                {
                  title: '调用次数',
                  dataIndex: 'use_count',
                  align: 'right',
                  width: 80,
                  render: (v: number) => (
                    <span style={{ color: v > 0 ? 'var(--ui-text)' : 'var(--ui-muted)' }}>{v ?? 0}</span>
                  ),
                },
                { title: '归属', dataIndex: 'owner', width: 80 },
                {
                  title: '创建时间',
                  dataIndex: 'created_at',
                  width: 100,
                  render: (v: string) => (
                    <span style={{ color: 'var(--ui-muted)', fontSize: 12 }}>{String(v || '').slice(0, 10)}</span>
                  ),
                },
                {
                  title: '操作',
                  key: 'op',
                  width: 268,
                  render: (_: any, r: any) => (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Button size="small" onClick={() => openTrace(r.id)}>
                        追溯
                      </Button>
                      <Button size="small" icon={<EditOutlined />} onClick={() => openAssetForm(r)}>
                        编辑
                      </Button>
                      <Select
                        size="small"
                        value={r.status}
                        style={{ width: 96 }}
                        options={STATUSES.map(s => ({ value: s, label: s === r.status ? s : `转${s}` }))}
                        onChange={v => {
                          if (v !== r.status) changeStatus(r.id, v);
                        }}
                      />
                      <Popconfirm
                        title={`删除资产「${r.name}」？`}
                        description="删除后进入回收站，老板/管理员可恢复。"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => deleteAsset(r)}
                      >
                        <Button size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </div>
                  ),
                },
              ]}
            />
          </Panel>
        </Col>
        <Col xs={24} lg={7}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
            <Panel
              title={
                <>
                  <FireOutlined style={{ color: 'var(--warn)' }} /> 资产使用 TOP5
                </>
              }
              style={{ height: 'auto' }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {topUsed.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />}
                {topUsed.map((t, i) => (
                  <button
                    type="button"
                    key={t.id}
                    onClick={() => openTrace(t.id)}
                    style={{
                      ...buttonResetStyle,
                      padding: '5px 0',
                      borderBottom: i < topUsed.length - 1 ? '1px solid var(--ui-surface-2)' : 'none',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                      <span
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: 5,
                          flexShrink: 0,
                          textAlign: 'center',
                          lineHeight: '18px',
                          fontSize: 11,
                          fontWeight: 700,
                          color: i < 3 ? '#fff' : 'var(--ui-muted)',
                          background:
                            i < 3 ? ['var(--danger)', 'var(--warn)', 'var(--ui-muted)'][i] : 'var(--ui-border)',
                        }}
                      >
                        {i + 1}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          color: 'var(--ui-text)',
                          fontWeight: 600,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {t.name}
                      </span>
                      <span style={{ color: 'var(--ui-accent)', fontWeight: 600, flexShrink: 0 }}>
                        {t.use_count}
                        <span style={{ fontSize: 11, color: 'var(--ui-muted)', fontWeight: 400 }}>次</span>
                      </span>
                    </div>
                    <Progress
                      percent={Math.round(((t.use_count || 0) / maxUse) * 100)}
                      showInfo={false}
                      size="small"
                      strokeColor={CHART_COLORS[i % CHART_COLORS.length]}
                      style={{ margin: '2px 0 0 26px', width: 'calc(100% - 26px)' }}
                    />
                  </button>
                ))}
              </div>
            </Panel>
            <Panel
              title={
                <>
                  <AlertOutlined style={{ color: 'var(--danger)' }} /> 资产预警
                </>
              }
              extra={
                <Badge count={(wCounts.idle || 0) + (wCounts.incomplete || 0) + (wCounts.lowUse || 0)} size="small" />
              }
              style={{ flex: 1, height: 'auto' }}
              bodyStyle={{ paddingTop: 12 }}
            >
              <Collapse
                ghost
                size="small"
                style={{ margin: '0 -8px' }}
                items={warnGroups.map(g => ({
                  key: g.key,
                  label: (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Tag color={g.tag}>{g.label}</Tag>
                      <span style={{ fontWeight: 700, color: g.color }}>{g.n ?? 0}</span>
                    </div>
                  ),
                  children:
                    g.rows.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--ui-muted)' }}>暂无预警资产</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {g.rows.slice(0, 6).map((r: any) => (
                          <button
                            type="button"
                            key={r.id}
                            onClick={() => openTrace(r.id)}
                            style={{
                              ...buttonResetStyle,
                              display: 'flex',
                              justifyContent: 'space-between',
                              fontSize: 12,
                              cursor: 'pointer',
                            }}
                          >
                            <span
                              style={{
                                color: 'var(--ui-text-2)',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                flex: 1,
                              }}
                            >
                              {r.name}
                            </span>
                            <span style={{ color: 'var(--ui-muted)', flexShrink: 0 }}>{r.category}</span>
                          </button>
                        ))}
                        {g.rows.length > 6 && (
                          <div style={{ fontSize: 11, color: 'var(--ui-muted)' }}>等 {g.rows.length} 项</div>
                        )}
                      </div>
                    ),
                }))}
              />
            </Panel>
          </div>
        </Col>
      </Row>

      {/* 底部三卡：生命周期 + 价值分布 + 流转动态 */}
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={8}>
          <Panel
            title={
              <>
                <SyncOutlined style={{ color: 'var(--ui-accent)' }} /> 资产生命周期分布
              </>
            }
          >
            <Chart
              height={220}
              onClick={(p: any) => {
                const row = lifecycle[p.dataIndex];
                const statusName = p.name || row?.status;
                if (statusName) openVisualDetail('lifecycle', { status: statusName }, `${statusName}资产`);
              }}
              option={{
                tooltip: { formatter: (p: any) => `${p.name}：${p.value} 项` },
                grid: { left: 8, right: 40, top: 10, bottom: 8, containLabel: true },
                xAxis: {
                  type: 'value',
                  axisLine: { show: false },
                  axisLabel: { show: false },
                  splitLine: { show: false },
                },
                yAxis: {
                  type: 'category',
                  inverse: true,
                  data: lifecycle.map(x => x.status),
                  axisLine: { show: false },
                  axisTick: { show: false },
                  axisLabel: { color: 'var(--ui-text-2)', fontSize: 12 },
                },
                series: [
                  {
                    type: 'bar',
                    barWidth: 16,
                    label: {
                      show: true,
                      position: 'right',
                      color: 'var(--ui-text-2)',
                      fontSize: 11,
                      formatter: '{c} 项',
                    },
                    data: lifecycle.map((x, i) => ({
                      value: x.n,
                      itemStyle: {
                        color: statusColor[x.status] || CHART_COLORS[i % CHART_COLORS.length],
                        borderRadius: [0, 6, 6, 0],
                      },
                    })),
                  },
                ],
              }}
            />
          </Panel>
        </Col>
        <Col xs={24} lg={8}>
          <Panel
            title={
              <>
                <PieChartOutlined style={{ color: 'var(--chart-3)' }} /> 资产价值分布
              </>
            }
          >
            <Chart
              height={220}
              onClick={(p: any) => {
                const row = categories[p.dataIndex];
                const categoryName = p.name || row?.category;
                if (categoryName)
                  openVisualDetail('value-category', { category: categoryName }, `${categoryName}价值构成`);
              }}
              option={{
                tooltip: { trigger: 'axis', formatter: (ps: any) => `${ps[0]?.name}：${fmtWan(ps[0]?.value || 0)}` },
                grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
                xAxis: {
                  type: 'category',
                  data: categories.map(c => c.category),
                  ...axisStyle,
                  axisLabel: { color: 'var(--ui-muted)', fontSize: 10.5, interval: 0 },
                },
                yAxis: {
                  type: 'value',
                  ...axisStyle,
                  axisLabel: {
                    color: 'var(--ui-muted)',
                    fontSize: 11,
                    formatter: (v: any) => (v >= 10000 ? `${(v / 10000).toFixed(0)}万` : v),
                  },
                },
                series: [
                  {
                    type: 'bar',
                    barWidth: 26,
                    label: {
                      show: true,
                      position: 'top',
                      fontSize: 10,
                      color: 'var(--ui-muted)',
                      formatter: (p: any) => fmtWan(p.value),
                    },
                    data: categories.map((c, i) => ({
                      value: c.v,
                      itemStyle: {
                        color: catChartColor[c.category] || CHART_COLORS[i % CHART_COLORS.length],
                        borderRadius: [6, 6, 0, 0],
                      },
                    })),
                  },
                ],
              }}
            />
          </Panel>
        </Col>
        <Col xs={24} lg={8}>
          <Panel
            title={
              <>
                <ThunderboltOutlined style={{ color: 'var(--warn)' }} /> 资产流转动态
              </>
            }
            extra={<span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>最近 {flows.length} 条</span>}
          >
            <div style={{ maxHeight: 220, overflow: 'auto', paddingTop: 4 }}>
              {flows.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无流转记录" />
              ) : (
                <Timeline
                  items={flows.map(f => ({
                    key: f.id,
                    color: actionColor[f.action] || 'var(--ui-accent)',
                    children: (
                      <button
                        type="button"
                        disabled={!f.asset_id}
                        onClick={() => openTrace(f.asset_id)}
                        style={{ ...buttonResetStyle, fontSize: 12, cursor: f.asset_id ? 'pointer' : 'default' }}
                      >
                        <div style={{ marginBottom: 2 }}>
                          <Tag
                            color={actionColor[f.action] || 'var(--ui-accent)'}
                            style={{ fontSize: 11, lineHeight: '16px', marginRight: 6 }}
                          >
                            {f.action}
                          </Tag>
                          <span style={{ fontWeight: 600, color: 'var(--ui-text)' }}>{f.asset_name}</span>
                        </div>
                        {f.note && <div style={{ color: 'var(--ui-muted)', lineHeight: 1.6 }}>{f.note}</div>}
                        <div style={{ color: 'var(--ui-muted)', fontSize: 11, marginTop: 2 }}>
                          {String(f.created_at || '')
                            .replace('T', ' ')
                            .slice(0, 16)}
                        </div>
                      </button>
                    ),
                  }))}
                />
              )}
            </div>
          </Panel>
        </Col>
      </Row>

      {/* 数据来源地图：每个资产口径的数据出处，对抗“数字凭空而来”的质疑 */}
      <Panel
        title={
          <>
            <ApartmentOutlined style={{ color: 'var(--ui-accent)' }} /> 数据来源地图
          </>
        }
        extra={
          <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>
            展示每类资产背后的数据出处，点击卡片查看真实样本
          </span>
        }
      >
        {sourceMapError ? (
          <div style={{ textAlign: 'center', padding: '18px 0' }}>
            <div style={{ fontSize: 12.5, color: 'var(--danger)', marginBottom: 10 }}>
              来源地图加载失败：{sourceMapError}
            </div>
            <Button size="small" icon={<ReloadOutlined />} onClick={loadSourceMap}>
              重试
            </Button>
          </div>
        ) : !sourceMap ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin />
          </div>
        ) : (sourceMap.cards || []).length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无来源信息。数据来源地图会展示每个结论背后的数据出处。"
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10 }}>
              {(sourceMap.cards || []).map((c: any) => (
                <button
                  type="button"
                  key={c.key}
                  onClick={() => openSourceSample(c)}
                  style={{
                    ...buttonResetStyle,
                    border: '1px solid var(--ui-border)',
                    borderRadius: 10,
                    padding: '12px 14px',
                    cursor: 'pointer',
                    background: 'var(--ui-surface)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                    <b style={{ fontSize: 13, color: 'var(--ui-text)' }}>{c.title}</b>
                    <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--ui-accent)', whiteSpace: 'nowrap' }}>
                      {c.count ?? 0} <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--ui-muted)' }}>项</span>
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: 'var(--ui-muted)',
                      margin: '6px 0 4px',
                      fontFamily: 'Consolas,Menlo,monospace',
                    }}
                  >
                    {c.table}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ui-text-2)', lineHeight: 1.6 }}>来源：{c.source}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', lineHeight: 1.6, marginTop: 4 }}>
                    溯源链：{c.trace}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--ui-accent)', marginTop: 6 }}>查看来源样本 ›</div>
                </button>
              ))}
            </div>
            {(sourceMap.rules || []).length > 0 && (
              <div style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '8px 12px' }}>
                {(sourceMap.rules || []).map((rule: string, i: number) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--ui-text-2)', lineHeight: 1.8 }}>
                    · {rule}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Panel>

      {/* ===== 统计卡钻取 Modal ===== */}
      <Modal
        open={drill.open}
        width={780}
        footer={null}
        onCancel={() => setDrill({ open: false, kind: '', data: null })}
        title={drill.data?.title || '加载中…'}
      >
        {!drill.data ? (
          <div style={{ textAlign: 'center', padding: 28 }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="加载中…" />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {(drill.data.cats || []).length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 8 }}>
                {drill.data.cats.map((c: any) => (
                  <div
                    key={c.category}
                    style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '8px 12px' }}
                  >
                    <div style={{ fontSize: 11.5, color: 'var(--ui-muted)' }}>{c.category}</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ui-text)' }}>{c.n} 项</div>
                    <div style={{ fontSize: 11.5, color: 'var(--ui-accent)' }}>{fmtWan(c.v || 0)}</div>
                  </div>
                ))}
              </div>
            )}
            {(drill.data.sts || []).length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {drill.data.sts.map((s: any) => (
                  <Tag
                    key={s.status}
                    color={s.status === '使用中' ? 'green' : s.status === '闲置' ? 'orange' : 'default'}
                    style={{ fontSize: 12, padding: '2px 10px' }}
                  >
                    {s.status} {s.n}项
                  </Tag>
                ))}
              </div>
            )}
            {(drill.data.rows || []).length > 0 && (
              <Table
                size="small"
                rowKey="id"
                dataSource={drill.data.rows}
                pagination={{ pageSize: 8, size: 'small' }}
                onRow={(r: any) => ({ onClick: () => openTrace(r.id), style: { cursor: 'pointer' } })}
                columns={[
                  { title: '资产', dataIndex: 'name', ellipsis: true, render: (v: any) => <b>{v}</b> },
                  {
                    title: '类别',
                    dataIndex: 'category',
                    width: 90,
                    render: (v: any) => <Tag style={{ margin: 0 }}>{v}</Tag>,
                  },
                  { title: '估值', dataIndex: 'value', width: 90, align: 'right', render: (v: any) => fmtWan(v || 0) },
                  ...(drill.kind === 'month-new' || drill.kind === 'total'
                    ? [
                        {
                          title: '登记时间',
                          dataIndex: 'created_at',
                          width: 100,
                          render: (v: any) => (v || '').slice(5, 16),
                        },
                      ]
                    : []),
                  ...(drill.kind !== 'value'
                    ? [
                        {
                          title: '状态',
                          dataIndex: 'status',
                          width: 76,
                          render: (v: any) => (
                            <Tag color={v === '使用中' ? 'green' : 'default'} style={{ margin: 0 }}>
                              {v}
                            </Tag>
                          ),
                        },
                      ]
                    : []),
                  { title: '调用', dataIndex: 'use_count', width: 60, align: 'right', render: (v: any) => v ?? 0 },
                ]}
              />
            )}
            <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', lineHeight: 1.8 }}>
              {drill.data.note} 点击任意资产行可溯源（来源原文+流转时间线）。
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={sourceDetail.open}
        width={900}
        footer={null}
        onCancel={() => setSourceDetail({ open: false, loading: false, data: null, title: '' })}
        title={
          <span>
            {sourceDetail.title}{' '}
            <Tag color="blue" style={{ fontSize: 10.5 }}>
              明细 / 可追溯
            </Tag>
          </span>
        }
      >
        {sourceDetail.loading ? (
          <div style={{ textAlign: 'center', padding: 36 }}>
            <Spin />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {sourceDetail.data?.note && <Alert type="info" showIcon message={sourceDetail.data.note} />}
            <Table
              size="small"
              rowKey={(r: any, i?: number) => r.id || i}
              dataSource={sourceDetail.data?.rows || []}
              pagination={{ pageSize: 8, size: 'small' }}
              locale={{
                emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前权限范围暂无资产样本" />,
              }}
              onRow={(r: any) => ({
                onClick: () => (r.id || r.asset_id) && openTrace(r.id || r.asset_id),
                style: { cursor: r.id || r.asset_id ? 'pointer' : 'default' },
              })}
              columns={(sourceDetail.data?.columns || []).map((c: any) => ({
                ...c,
                ellipsis: true,
                render: (v: any) => (c.type === 'money' ? fmtMoney(v || 0) : renderSourceCell(v)),
              }))}
            />
            <div style={{ fontSize: 11.5, color: 'var(--ui-muted)' }}>
              点击任意资产行可继续打开单资产溯源，查看来源对象和流转时间线。
            </div>
          </div>
        )}
      </Modal>

      {/* ===== 资产溯源抽屉 ===== */}
      <Drawer
        open={trace.open}
        width={520}
        onClose={() => setTrace({ open: false, data: null })}
        title={trace.data ? <span>资产溯源 · {trace.data.name}</span> : '资产溯源'}
      >
        {!trace.data ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div
              style={{
                display: 'flex',
                gap: 14,
                flexWrap: 'wrap',
                fontSize: 12.5,
                background: 'var(--ui-surface-2)',
                borderRadius: 8,
                padding: '10px 12px',
              }}
            >
              <span>
                <Tag style={{ margin: 0 }}>{trace.data.category}</Tag>
              </span>
              <span>
                估值 <b style={{ color: 'var(--warn)' }}>{fmtWan(trace.data.value || 0)}</b>
              </span>
              <span>
                状态{' '}
                <Tag color={trace.data.status === '使用中' ? 'green' : 'default'} style={{ margin: 0 }}>
                  {trace.data.status}
                </Tag>
              </span>
              <span>
                调用 <b>{trace.data.use_count ?? 0}</b> 次
              </span>
              <span>登记 {(trace.data.created_at || '').slice(0, 16)}</span>
            </div>

            <Panel title={`来源：${trace.data.source.type}`}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ui-text)', marginBottom: 6 }}>
                {trace.data.source.label}
              </div>
              {trace.data.source.meta && (
                <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', marginBottom: 6 }}>
                  {trace.data.source.meta}
                </div>
              )}
              {trace.data.source.preview && (
                <div
                  style={{
                    whiteSpace: 'pre-wrap',
                    fontSize: 12,
                    lineHeight: 1.8,
                    maxHeight: 180,
                    overflow: 'auto',
                    background: 'var(--ui-surface-2)',
                    border: '1px solid var(--ui-border)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    color: 'var(--ui-text-2)',
                  }}
                >
                  {trace.data.source.preview}
                  {String(trace.data.source.preview).length >= 400 ? '…' : ''}
                </div>
              )}
              {trace.data.source.leadId && (
                <Button
                  size="small"
                  type="primary"
                  ghost
                  style={{ marginTop: 8 }}
                  onClick={() => setCustId(trace.data.source.leadId)}
                >
                  打开客户完整档案 ›
                </Button>
              )}
            </Panel>

            <Panel title={`流转时间线（${(trace.data.flows || []).length}）`}>
              {(trace.data.flows || []).length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--ui-muted)' }}>登记后暂无流转记录</div>
              ) : (
                <Timeline
                  items={trace.data.flows.map((f: any) => ({
                    children: (
                      <div style={{ fontSize: 12.5 }}>
                        <b>{f.action}</b>{' '}
                        <span style={{ color: 'var(--ui-muted)', fontSize: 11 }}>
                          {(f.created_at || '').slice(5, 16)}
                        </span>
                        {f.note && <div style={{ color: 'var(--ui-text-2)' }}>{f.note}</div>}
                      </div>
                    ),
                  }))}
                />
              )}
            </Panel>
            <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', lineHeight: 1.8 }}>{trace.data.note}</div>
          </div>
        )}
      </Drawer>

      <Modal
        open={importOpen}
        title="导入数据资产"
        okText="确认导入"
        width={720}
        onOk={submitAssetImport}
        onCancel={() => setImportOpen(false)}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="支持单条登记，也支持从 Excel 复制多行"
          description="批量粘贴列顺序：资产名称、分类、估值、状态、归属、来源备注。导入后会自动写入资产流转动态，并可在资产溯源中查看。"
        />
        <Form form={importForm} layout="vertical" initialValues={{ category: '数据资产', status: '使用中' }}>
          <Form.Item name="batchText" label="批量粘贴">
            <Input.TextArea
              rows={5}
              placeholder={
                '资产名称\t分类\t估值\t状态\t归属\t来源备注\n端午礼盒产品手册\t知识资产\t5000\t使用中\t市场部\t线下物料整理入库'
              }
            />
          </Form.Item>
          <div style={{ fontSize: 12, color: 'var(--ui-muted)', margin: '-4px 0 12px' }}>
            不填批量粘贴时，使用下方单条登记。
          </div>
          <Row gutter={10}>
            <Col span={12}>
              <Form.Item name="name" label="资产名称">
                <Input placeholder="例如：企业团餐沟通手册" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="category" label="分类">
                <Select options={CATEGORIES.map(c => ({ value: c, label: c }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="value" label="估值">
                <InputNumber min={0} precision={0} style={{ width: '100%' }} prefix="¥" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="status" label="状态">
                <Select options={STATUSES.map(s => ({ value: s, label: s }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="owner" label="归属">
                <Input placeholder="部门/人员" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="url" label="外部链接 / 文件位置">
            <Input placeholder="可选，便于领导审核追溯" />
          </Form.Item>
          <Form.Item name="note" label="来源备注">
            <Input.TextArea rows={3} maxLength={300} placeholder="说明这个资产从哪里来、谁整理、后续怎么用" />
          </Form.Item>
        </Form>
      </Modal>

      {/* ===== 资产新增 / 编辑 Modal ===== */}
      <Modal
        open={assetModal.open}
        title={assetModal.id ? '编辑资产' : '新增资产'}
        okText={assetModal.id ? '保存修改' : '登记资产'}
        confirmLoading={assetSaving}
        width={640}
        onOk={submitAssetForm}
        onCancel={() => setAssetModal({ open: false, id: null })}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="估值填 0 表示「未估值」，不计入资产总值；每次新增/编辑都会写入资产流转动态，可在溯源中追责。"
        />
        <Form form={assetForm} layout="vertical">
          <Row gutter={10}>
            <Col span={12}>
              <Form.Item
                name="name"
                label="资产名称"
                rules={[{ required: true, whitespace: true, message: '请填写资产名称' }]}
              >
                <Input maxLength={80} placeholder="例如：企业团餐沟通手册" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="category" label="分类" rules={[{ required: true, message: '请选择分类' }]}>
                <Select options={CATEGORIES.map(c => ({ value: c, label: c }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="value" label="估值（0=未估值）">
                <InputNumber min={0} precision={0} style={{ width: '100%' }} prefix="¥" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="status" label="状态" rules={[{ required: true, message: '请选择状态' }]}>
                <Select options={STATUSES.map(s => ({ value: s, label: s }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="owner" label="归属">
                <Input maxLength={40} placeholder="部门/人员" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="url" label="外部链接 / 文件位置">
            <Input maxLength={300} placeholder="可选，便于审核追溯" />
          </Form.Item>
          <Form.Item name="note" label="来源备注">
            <Input.TextArea rows={3} maxLength={300} placeholder="说明这个资产从哪里来、谁整理、后续怎么用" />
          </Form.Item>
        </Form>
      </Modal>

      <CustomerDrawer leadId={custId} open={!!custId} onClose={() => setCustId(null)} />
    </div>
  );
}
