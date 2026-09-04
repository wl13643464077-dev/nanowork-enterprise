import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Row,
  Col,
  Table,
  Tag,
  Progress,
  Badge,
  Avatar,
  Tooltip,
  Segmented,
  Empty,
  Modal,
  Drawer,
  Button,
  Spin,
  Descriptions,
  Timeline,
  Space,
  message,
  Input,
  InputNumber,
  Alert,
  DatePicker,
  Dropdown,
} from 'antd';
import {
  DollarOutlined,
  UserAddOutlined,
  ClockCircleOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  HeartOutlined,
  RightOutlined,
  BulbOutlined,
  AlertOutlined,
  RobotOutlined,
  MessageOutlined,
  StarFilled,
  GiftOutlined,
  PlusOutlined,
  SettingOutlined,
  AppstoreOutlined,
  PayCircleOutlined,
  FundOutlined,
} from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { api, fmtMoney, getUser } from '../api/client';
import { onStoreChanged, storeHeaders } from '../api/store-context';
import { StatCard, Panel, StageTag, GradeTag, ErrorState } from '../components/Kit';
import DashboardInspectionCard from '../components/DashboardInspectionCard';
import { Chart, CHART_COLORS, baseGrid, axisStyle } from '../components/Charts';
import StreamingOutput from '../components/StreamingOutput';
import BossGlance from '../components/BossGlance';
import StaffDailyGuide from '../components/StaffDailyGuide';
import DashboardRoleHeader, {
  buildDashboardGuide,
  dashboardRoleView,
  DASHBOARD_ROLE_NAMES,
} from '../components/DashboardRoleHeader';
import { dashboardRankMeta } from '../components/DashboardRankingMeta';
import { dashboardFeishuPresentation } from '../components/statusPresentation.js';
import { useStreamingTask, type StreamStage } from '../hooks/useStreamingTask';

// 数字员工协同分析的阶段轴：与后端事件对齐，不编造中间态
const AI_ANALYSIS_STAGES: StreamStage[] = [
  { key: 'dispatch', label: '已派发给财务与数据部' },
  { key: 'generating', label: '协同分析中' },
  { key: 'done', label: '分析完成' },
];

const ACTIVITY_LABELS: Record<string, string> = {
  品鉴会: '主题试吃',
  封坛仪式: '新品发布',
  企业团购沙龙: '企业团餐洽谈',
  招商说明会: '合作说明会',
  会员日: '会员活动',
};

const interactiveRow = (onActivate: () => void) => ({
  onClick: onActivate,
  onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onActivate();
  },
  role: 'button' as const,
  tabIndex: 0,
  style: { cursor: 'pointer' },
});

export default function Dashboard() {
  const nav = useNavigate();
  const [summary, setSummary] = useState<any>({});
  const [trend, setTrend] = useState<any[]>([]);
  const [scopeMode, setScopeMode] = useState('all');
  const [scopeValue, setScopeValue] = useState<any>(dayjs());
  const [funnel, setFunnel] = useState<any>({ funnel: [] });
  const [channels, setChannels] = useState<any[]>([]);
  const [keyCustomers, setKeyCustomers] = useState<any[]>([]);
  const [briefing, setBriefing] = useState<any>(null);
  const [todos, setTodos] = useState<any>({});
  // 今日经营诊断（主动式）：无 analysis 模块权限或接口失败时整卡隐藏
  const [diagnosis, setDiagnosis] = useState<any[] | null>(null);
  // 每日经营日报（昨日涨跌→归因→建议）；empty 时隐藏
  const [digest, setDigest] = useState<any>(null);
  // 诊断卡当日关闭（Shopify 模式：可关闭并附反馈理由，次日自动恢复）
  const DIAG_DISMISS_KEY = 'nanowork_diag_dismiss_v1';
  const [diagDismissed, setDiagDismissed] = useState(() => {
    try {
      return (
        JSON.parse(localStorage.getItem(DIAG_DISMISS_KEY) || 'null')?.date === new Date().toLocaleDateString('sv-SE')
      );
    } catch {
      return false;
    }
  });
  const dismissDiagnosis = (reason: string) => {
    localStorage.setItem(DIAG_DISMISS_KEY, JSON.stringify({ date: new Date().toLocaleDateString('sv-SE'), reason }));
    setDiagDismissed(true);
    message.success('今日诊断已收起，明天会根据最新数据重新生成');
  };
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // 多门店：顶栏切换门店后整页重新拉数（store-changed 事件，与 credits-updated 同款）
  useEffect(() => onStoreChanged(() => setReloadKey(k => k + 1)), []);
  const [weekActs, setWeekActs] = useState<any[]>([]);
  const [marshals, setMarshals] = useState<any[]>([]);
  const [followOverview, setFollowOverview] = useState<any>({ summary: {}, daily: [], staff: [], recent: [] });
  const [employeeDetail, setEmployeeDetail] = useState<any>(null);
  const [employeeLoading, setEmployeeLoading] = useState(false);
  const [pointModalOpen, setPointModalOpen] = useState(false);
  const [pointDelta, setPointDelta] = useState<number | null>(20);
  const [pointReason, setPointReason] = useState('');
  const [awardModalOpen, setAwardModalOpen] = useState(false);
  const [awardComment, setAwardComment] = useState('');
  const [widgetPrefs, setWidgetPrefs] = useState<any>({
    available: [],
    selected: ['kpi', 'follow', 'trend', 'funnel', 'briefing', 'channels', 'customers', 'marshals', 'activities'],
    canEdit: false,
  });
  const [widgetOpen, setWidgetOpen] = useState(false);
  const [widgetSaving, setWidgetSaving] = useState(false);
  const scopeRequestRef = useRef(0);
  const currentUser = getUser();
  const role = currentUser?.role;
  const userModules: string[] = Array.isArray(currentUser?.modules) ? currentUser.modules : ['dashboard'];
  const hasModule = (module: string) => userModules.includes(module);
  const canViewGrowth = hasModule('growth');
  const canViewAnalysis = hasModule('analysis');
  const canViewActivities = hasModule('activities');
  const canViewMarshals = hasModule('marshals');
  const canViewSystem = hasModule('system');
  const canViewStoreData = canViewAnalysis && ['boss', 'ops_director', 'manager', 'admin'].includes(role || '');
  const { name: dashboardName, summary: dashboardSummary } = dashboardRoleView(role);
  const canViewManagementBriefing = ['boss', 'ops_director', 'manager', 'admin'].includes(role || '');
  const canEvaluateEmployees = ['boss', 'admin'].includes(role || '');
  const canViewEmployeeDetail = ['boss', 'ops_director', 'manager', 'admin'].includes(role || '');
  const scopeQuery = useMemo(() => {
    const v = scopeValue || dayjs();
    if (scopeMode === 'all') return 'mode=all';
    if (scopeMode === 'day') return `mode=day&date=${v.format('YYYY-MM-DD')}`;
    if (scopeMode === 'customMonth') return `mode=month&month=${v.format('YYYY-MM')}`;
    if (scopeMode === 'customQuarter') return `mode=quarter&quarter=${v.year()}-Q${Math.floor(v.month() / 3) + 1}`;
    return `period=${scopeMode}`;
  }, [scopeMode, scopeValue]);
  const scopePath = `?${scopeQuery}`;
  const allScopeLabel = ['boss', 'admin'].includes(role || '')
    ? '全部'
    : ['ops_director', 'manager'].includes(role || '')
      ? '团队'
      : '我的';
  const scopeLabel =
    scopeMode === 'all'
      ? summary.scope?.shortLabel || allScopeLabel
      : summary.scope?.shortLabel ||
        ({ week: '本周', month: '本月', quarter: '本季' } as Record<string, string>)[scopeMode] ||
        '当前范围';
  const scopeFullLabel = summary.scope?.label || (scopeMode === 'all' ? `${allScopeLabel}经营数据` : scopeLabel);
  const scopeRangeText = summary.scope?.rangeText || '';
  const loadFollowOverview = () => api.get(`/dashboard/follow-overview${scopePath}`).then(setFollowOverview);

  useEffect(() => {
    if (canViewGrowth) {
      api.get('/dashboard/funnel').then(setFunnel);
      api.get('/dashboard/key-customers').then(setKeyCustomers);
    }
    if (canViewManagementBriefing) api.get('/dashboard/briefing').then(setBriefing);
    api.get('/dashboard/todos').then(setTodos);
    if (canViewMarshals) api.get('/dashboard/marshal-shortcuts').then(setMarshals);
    api
      .get('/dashboard/widgets/preferences')
      .then(setWidgetPrefs)
      .catch(() => {});
    if (canViewAnalysis) {
      api
        .get('/analysis/insights')
        .then((d: any) => setDiagnosis(Array.isArray(d) ? d : []))
        .catch(() => setDiagnosis(null));
    }
    if (canViewManagementBriefing) {
      api
        .get('/dashboard/daily-digest')
        .then((d: any) => setDigest(d && !d.empty ? d : null))
        .catch(() => setDigest(null));
    }
  }, [canViewAnalysis, canViewGrowth, canViewManagementBriefing, canViewMarshals, reloadKey]);

  const dataMarshal = marshals.find((m: any) => m.code === 'M-07');
  useEffect(() => {
    const requestId = ++scopeRequestRef.current;
    let cancelled = false;
    const current = () => !cancelled && requestId === scopeRequestRef.current;
    queueMicrotask(() => {
      if (current()) setLoadError(false);
    });
    api
      .get(`/dashboard/summary${scopePath}`)
      .then(data => {
        if (current()) setSummary(data);
      })
      .catch(() => {
        if (current()) setLoadError(true);
      });
    if (canViewAnalysis) {
      api.get(`/dashboard/trend${scopePath}`).then((d: any) => {
        if (current()) setTrend(Array.isArray(d) ? d : d.rows || []);
      });
      api.get(`/dashboard/channels${scopePath}`).then((d: any) => {
        if (current()) setChannels(Array.isArray(d) ? d : d.rows || []);
      });
    }
    if (canViewActivities) {
      api.get(`/dashboard/week-activities${scopePath}`).then((d: any) => {
        if (current()) setWeekActs(Array.isArray(d) ? d : d.rows || []);
      });
    }
    if (canViewGrowth) {
      api.get(`/dashboard/follow-overview${scopePath}`).then(data => {
        if (current()) setFollowOverview(data);
      });
    }
    // 轮询带可见性门控：后台标签页不发请求，回到前台立即刷新一次
    const poll = () =>
      api
        .get(`/dashboard/summary${scopePath}`)
        .then(data => {
          if (current()) setSummary(data);
        })
        .catch(() => {});
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') poll();
    }, 30000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [canViewActivities, canViewAnalysis, canViewGrowth, reloadKey, scopePath]);

  const totalTodos =
    (todos.approvals || 0) +
    (todos.overdueLeads || 0) +
    (todos.silentPartners || 0) +
    (todos.actionableReviewTasks ?? todos.reviewTasks ?? 0) +
    (todos.contentEmployeeReviews || 0);

  // —— 多重交互：下钻/AI分析/客户档案 ——
  const [dayDetail, setDayDetail] = useState<any>(null); // 趋势某日来源明细
  const [channelDetail, setChannelDetail] = useState<any>(null); // 渠道明细
  const [custDetail, setCustDetail] = useState<any>(null); // 重点客户全档案
  const [custJourney, setCustJourney] = useState<any>(null); // 客户11节点生命周期
  const [custLoading, setCustLoading] = useState(false);
  // AI 分析弹窗：正文与进度由 useStreamingTask 持有，这里只管开关与标题
  const [ai, setAi] = useState<{ open: boolean; title: string; unconfigured?: boolean }>({
    open: false,
    title: '',
  });
  const stream = useStreamingTask();
  const lastAiRef = useRef<{ title: string; summary: string } | null>(null);
  const [feishu, setFeishu] = useState<any>(null);
  useEffect(() => {
    if (canViewActivities && canViewSystem) {
      api
        .get('/sys/feishu')
        .then(setFeishu)
        .catch(() => {});
    }
  }, [canViewActivities, canViewSystem]);
  const feishuStatus = dashboardFeishuPresentation(feishu);

  // 门店真数据 KPI（当月真实客单价/毛利率/经营利润率）：值为 null 时整卡不渲染；调用失败静默隐藏。
  // 用原生 fetch 而非 api.get：api 封装会对失败请求弹全局错误提示，这里必须完全静默。
  const [storeKpi, setStoreKpi] = useState<any>(null);
  useEffect(() => {
    if (!canViewStoreData) {
      return;
    }
    let cancelled = false;
    fetch(`/api/store-data/kpi?month=${dayjs().format('YYYY-MM')}`, {
      credentials: 'same-origin',
      headers: storeHeaders(),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!cancelled) setStoreKpi(d);
      })
      .catch(() => {
        if (!cancelled) setStoreKpi(null);
      });
    return () => {
      cancelled = true;
    };
  }, [canViewStoreData, reloadKey]);

  const openDayDetail = (date: string) => {
    setDayDetail({ loading: true, date });
    api
      .get(`/dashboard/day-detail?date=${date}`)
      .then(d => setDayDetail({ ...d, loading: false }))
      .catch(() => setDayDetail(null));
  };
  const openChannel = (channel: string) => {
    setChannelDetail({ loading: true, channel });
    api
      .get(`/growth/leads?source=${encodeURIComponent(channel)}&size=10`)
      .then(d => setChannelDetail({ channel, loading: false, ...d }))
      .catch(() => setChannelDetail(null));
  };
  const openCustomer = (id: number) => {
    setCustLoading(true);
    setCustDetail({ id });
    setCustJourney(null);
    api
      .get(`/growth/leads/${id}`)
      .then(d => setCustDetail(d))
      .catch(() => setCustDetail(null))
      .finally(() => setCustLoading(false));
    api
      .get(`/growth/leads/${id}/journey`)
      .then(setCustJourney)
      .catch(() => setCustJourney(null));
  };
  // AI分析由“财务与数据部”协同执行；稳定编号只作为内部任务容器，不对外展示旧角色名。
  // 走 SSE 流式：该端点后端早已支持 stream:true，此前用普通 POST 让老板干等到全文返回。
  const runAi = async (title: string, summary: string) => {
    if (!dataMarshal?.id) {
      setAi({ open: true, title, unconfigured: true });
      return;
    }
    setAi({ open: true, title });
    lastAiRef.current = { title, summary };
    await stream.run(`/marshals/${dataMarshal.id}/chat`, { message: summary }, { fallbackToPost: true });
  };
  const retryAi = () => {
    const last = lastAiRef.current;
    if (last) void runAi(last.title, last.summary);
  };

  // 新企业空数据 → 按角色给对应上手路径，避免员工被引导到无权限模块
  const isEmpty = Boolean(summary.scope || summary.timeScope) && Number(summary.businessRows ?? 0) === 0;
  const guide = buildDashboardGuide(role, userModules);
  const roleName = DASHBOARD_ROLE_NAMES;
  const fmtDate = (v?: string) => (v ? String(v).slice(0, 16) : '-');
  const openEmployee = async (id: number) => {
    if (!id) return;
    if (!canViewEmployeeDetail && Number(currentUser?.id) !== Number(id)) {
      message.info('员工端只展示竞赛榜，员工完整档案由老板/管理层查看');
      return;
    }
    setEmployeeLoading(true);
    setEmployeeDetail({ profile: { id } });
    try {
      const d = await api.get(`/dashboard/employees/${id}/detail${scopePath}`);
      setEmployeeDetail(d);
    } catch (e: any) {
      message.error(e?.message || '员工档案读取失败');
      setEmployeeDetail(null);
    } finally {
      setEmployeeLoading(false);
    }
  };
  const submitHonorPoints = async () => {
    const id = employeeDetail?.profile?.id;
    const delta = Math.max(-500, Math.min(500, Math.round(Number(pointDelta || 0))));
    if (!id || !delta) return message.warning('请填写要调控的积分，正数增加、负数扣减');
    await api.post(`/dashboard/employees/${id}/points`, { delta, reason: pointReason });
    message.success('荣誉积分已调控，排名会同步刷新');
    setPointModalOpen(false);
    setPointDelta(20);
    setPointReason('');
    await openEmployee(id);
    loadFollowOverview();
  };
  const submitEmployeeAward = async () => {
    const id = employeeDetail?.profile?.id;
    if (!id) return;
    await api.post(`/dashboard/employees/${id}/award`, { comment: awardComment });
    message.success('已评为月度优秀员工，并写入员工荣誉档案');
    setAwardModalOpen(false);
    setAwardComment('');
    await openEmployee(id);
    loadFollowOverview();
  };
  const topStaffScore = Math.max(1, ...(followOverview.staff || []).map((s: any) => Number(s.score || 0)));
  const showTeamRanking =
    followOverview.rankingScope === 'team' ||
    (!followOverview.rankingScope && ['boss', 'ops_director', 'manager', 'admin'].includes(role || ''));
  const widgetModules: Record<string, string> = {
    follow: 'growth',
    trend: 'analysis',
    funnel: 'growth',
    channels: 'analysis',
    customers: 'growth',
    marshals: 'marshals',
    activities: 'activities',
  };
  const shown = (key: string) =>
    (widgetPrefs.selected || []).includes(key) &&
    (key !== 'briefing' || canViewManagementBriefing) &&
    (!widgetModules[key] || hasModule(widgetModules[key]));
  const secondVisible = Math.max(1, ['trend', 'funnel', 'briefing'].filter(shown).length);
  const thirdVisible = Math.max(1, ['channels', 'customers', 'marshals'].filter(shown).length);
  const saveWidgets = async () => {
    if (!(widgetPrefs.selected || []).length) return message.warning(`${dashboardName}至少保留一个模块`);
    setWidgetSaving(true);
    try {
      const out = await api.put('/dashboard/widgets/preferences', { widgets: widgetPrefs.selected });
      setWidgetPrefs((p: any) => ({ ...p, selected: out.selected }));
      message.success(`${dashboardName}呈现内容已保存`);
      setWidgetOpen(false);
    } finally {
      setWidgetSaving(false);
    }
  };
  const renderScopePicker = () => {
    if (scopeMode === 'day') {
      return (
        <DatePicker
          allowClear={false}
          value={scopeValue}
          onChange={v => v && setScopeValue(v)}
          style={{ width: 150 }}
        />
      );
    }
    if (scopeMode === 'customMonth') {
      return (
        <DatePicker
          picker="month"
          allowClear={false}
          value={scopeValue}
          onChange={v => v && setScopeValue(v)}
          style={{ width: 150 }}
        />
      );
    }
    if (scopeMode === 'customQuarter') {
      return (
        <DatePicker
          picker="quarter"
          allowClear={false}
          value={scopeValue}
          onChange={v => v && setScopeValue(v)}
          style={{ width: 150 }}
        />
      );
    }
    return null;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <DashboardRoleHeader
        role={role}
        userName={currentUser?.name}
        summary={dashboardSummary}
        isEmpty={isEmpty}
        guide={guide}
        onNavigate={nav}
      />
      {/* 员工/店长层级是驾驶舱数据的填报责任人：登录第一屏给填报引导卡 */}
      {['sales', 'manager', 'ops_director'].includes(String(role)) && <StaffDailyGuide />}
      {/* 老板/管理层首屏锚点：4 个关键数 + 最要紧的事 + 堵着的待办，3 秒看完 */}
      {['boss', 'admin', 'ops_director', 'manager'].includes(String(role)) && !isEmpty && (
        <BossGlance
          summary={summary}
          todos={todos}
          diagnosis={diagnosis}
          scopeLabel={scopeLabel}
          canViewGrowth={canViewGrowth}
          canViewExecution={hasModule('execution')}
          onNavigate={nav}
        />
      )}
      {summary.timeScope?.hasHistoricalSamples && (
        <Alert
          type="info"
          showIcon
          message={
            summary.timeScope?.note ||
            `当前为 ${summary.timeScope.today} 实时口径：今日销售额为当天实时数据；下方图表/活动按已有历史记录展示（经营数据最近 ${summary.timeScope.latestOps || '-'}，活动最近 ${summary.timeScope.latestActivity || '-'}）。`
          }
          style={{ borderColor: 'var(--ui-border-strong)', background: 'var(--ui-surface-2)' }}
        />
      )}
      {loadError && (
        <ErrorState description="经营概览拉取失败，页面数字可能过期。" onRetry={() => setReloadKey(k => k + 1)} />
      )}
      {hasModule('analysis') && !diagDismissed && (digest || (diagnosis !== null && diagnosis.length > 0)) && (
        <Panel
          title={
            <>
              <AlertOutlined style={{ color: 'var(--warn)' }} /> 今日经营诊断
            </>
          }
          extra={
            <Space size={4}>
              <Button size="small" type="link" onClick={() => nav('/analysis')}>
                查看完整分析 <RightOutlined />
              </Button>
              <Dropdown
                menu={{
                  items: [
                    { key: '不准确', label: '收起：内容不准确' },
                    { key: '不重要', label: '收起：对我不重要' },
                    { key: '已处理', label: '收起：已经处理了' },
                  ],
                  onClick: ({ key }) => dismissDiagnosis(key),
                }}
              >
                <Button size="small" type="text" style={{ color: 'var(--ui-muted)' }}>
                  今日不再显示
                </Button>
              </Dropdown>
            </Space>
          }
        >
          {digest && (
            <div
              style={{
                marginBottom: diagnosis?.length ? 'var(--space-3)' : 0,
                padding: 'var(--space-3) var(--space-4)',
                background: 'var(--ui-surface-2)',
                border: '1px solid var(--ui-border)',
                borderRadius: 'var(--radius-md)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-1)',
              }}
            >
              <div style={{ fontWeight: 650, color: 'var(--ui-text)', fontSize: 'var(--font-3)' }}>
                {digest.headline}
                {digest.deltaPct !== null && digest.deltaPct !== undefined && (
                  <Tag style={{ marginLeft: 8 }} color={digest.deltaPct >= 0 ? 'green' : 'red'}>
                    {digest.deltaPct >= 0 ? '+' : ''}
                    {digest.deltaPct}%
                  </Tag>
                )}
              </div>
              <div style={{ color: 'var(--ui-text-2)', fontSize: 'var(--font-2)', lineHeight: 1.7 }}>
                <b>归因</b> · {digest.attribution}
              </div>
              <div style={{ color: 'var(--ui-text-2)', fontSize: 'var(--font-2)', lineHeight: 1.7 }}>
                <b>建议</b> · {digest.suggestion}
              </div>
              <div style={{ color: 'var(--ui-muted)', fontSize: 'var(--font-1)' }}>
                每日 08:00 同步推送到站内通知{'、'}已绑定的飞书群 · 口径：
                {digest.source === 'orders' ? '订单记录' : '手填日报'}
              </div>
            </div>
          )}
          {diagnosis !== null && diagnosis.length > 0 && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: 'var(--space-3)',
              }}
            >
              {diagnosis.slice(0, 3).map((item: any, index: number) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => nav(hasModule('advisor') ? '/advisor' : '/analysis')}
                  style={{
                    appearance: 'none',
                    textAlign: 'left',
                    font: 'inherit',
                    cursor: 'pointer',
                    background: 'var(--ui-surface-2)',
                    border: '1px solid var(--ui-border)',
                    borderRadius: 'var(--radius-md)',
                    padding: 'var(--space-3) var(--space-4)',
                    color: 'inherit',
                  }}
                  aria-label={`经营诊断：${item.issue}，${hasModule('advisor') ? '点击咨询数据员工' : '点击查看完整分析'}`}
                >
                  <Tag color="blue" style={{ marginBottom: 'var(--space-1)' }}>
                    {item.dimension}
                  </Tag>
                  <div style={{ fontWeight: 600, color: 'var(--ui-text)', fontSize: 'var(--font-2)', lineHeight: 1.6 }}>
                    {item.issue}
                  </div>
                  <div
                    style={{
                      color: 'var(--ui-muted)',
                      fontSize: 'var(--font-1)',
                      marginTop: 'var(--space-1)',
                      lineHeight: 1.7,
                    }}
                  >
                    {item.suggestion}
                  </div>
                  <div style={{ color: 'var(--ui-primary)', fontSize: 'var(--font-1)', marginTop: 'var(--space-2)' }}>
                    {hasModule('advisor') ? '问数据员工怎么做' : '查看完整分析'}{' '}
                    <RightOutlined style={{ fontSize: 10 }} />
                  </div>
                </button>
              ))}
            </div>
          )}
        </Panel>
      )}
      <DashboardInspectionCard />
      <Panel
        title="经营数据时间范围"
        extra={
          <Space size={8}>
            <Tag color="green">数据源：当前企业</Tag>
            <Tag color="blue">{scopeFullLabel}</Tag>
            {widgetPrefs.canEdit && (
              <Button size="small" icon={<SettingOutlined />} onClick={() => setWidgetOpen(true)}>
                自定义{dashboardName}
              </Button>
            )}
          </Space>
        }
      >
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}
        >
          <Space size={8} wrap>
            <Segmented
              size="small"
              value={scopeMode}
              onChange={v => setScopeMode(v as string)}
              options={[
                { label: '全部', value: 'all' },
                { label: '本周', value: 'week' },
                { label: '本月', value: 'month' },
                { label: '本季', value: 'quarter' },
                { label: '指定日', value: 'day' },
                { label: '指定月', value: 'customMonth' },
                { label: '指定季度', value: 'customQuarter' },
              ]}
            />
            {renderScopePicker()}
          </Space>
          <Space size={8} wrap>
            <Tag color="gold">{scopeRangeText || '当前周期'}</Tag>
            <Tag color="default">以当前查询结果和记录时间为准</Tag>
          </Space>
        </div>
      </Panel>
      {/* KPI 行 */}
      {shown('kpi') && (
        <Row gutter={[12, 12]}>
          <Col xs={12} md={8} xl={4}>
            <StatCard
              icon={<DollarOutlined />}
              color="var(--ui-accent)"
              label={`${scopeLabel}销售额`}
              value={fmtMoney(summary.todaySales)}
              trend={summary.salesWow}
              trendLabel={summary.scope?.compareLabel || '较上期'}
              onClick={hasModule('analysis') ? () => nav('/analysis') : undefined}
            />
          </Col>
          {canViewGrowth && (
            <>
              <Col xs={12} md={8} xl={4}>
                <StatCard
                  icon={<UserAddOutlined />}
                  color="var(--chart-2)"
                  label={`${scopeLabel}新增客户`}
                  value={summary.monthLeads ?? '-'}
                  trend={summary.leadsWow}
                  trendLabel={summary.scope?.compareLabel || '较上期'}
                  onClick={() => nav('/growth')}
                />
              </Col>
              <Col xs={12} md={8} xl={4}>
                <StatCard
                  icon={<ClockCircleOutlined />}
                  color="var(--chart-3)"
                  label="当前待跟进客户"
                  value={summary.pendingFollow ?? '-'}
                  suffix={summary.overdue ? `${summary.overdue}人超期` : ''}
                  onClick={() => nav('/growth')}
                />
              </Col>
            </>
          )}
          {hasModule('activities') && (
            <Col xs={12} md={8} xl={4}>
              <StatCard
                icon={<CalendarOutlined />}
                color="var(--warn)"
                label={`${scopeLabel}活动`}
                value={summary.runningActivities ?? '-'}
                suffix="场"
                onClick={() => nav('/activities')}
              />
            </Col>
          )}
          {hasModule('execution') && (
            <Col xs={12} md={8} xl={4}>
              <StatCard
                icon={<CheckCircleOutlined />}
                color="var(--ui-muted)"
                label={`${scopeLabel}任务完成率`}
                value={`${summary.taskRate ?? '-'}%`}
                onClick={() => nav('/execution')}
              />
            </Col>
          )}
          {summary.health && (
            <Col xs={12} md={8} xl={4}>
              <StatCard
                icon={<HeartOutlined />}
                color="var(--danger)"
                label="当前经营健康度"
                value={summary.health.level}
                suffix={`${summary.health.score}分`}
                onClick={hasModule('analysis') ? () => nav('/analysis') : undefined}
              />
            </Col>
          )}
          {/* 门店真数据卡：只在真实录入了订单明细/成本时出现，null 一律不渲染（不显示 '-' 冒充有数） */}
          {hasModule('analysis') && storeKpi?.avgTicket != null && (
            <Col xs={12} md={8} xl={4}>
              <StatCard
                icon={<PayCircleOutlined />}
                color="#0ea5a4"
                label="本月真实客单价"
                value={fmtMoney(storeKpi.avgTicket)}
                suffix="按订单明细"
                onClick={() => nav('/store-data')}
              />
            </Col>
          )}
          {hasModule('analysis') && storeKpi?.grossMargin != null && (
            <Col xs={12} md={8} xl={4}>
              <StatCard
                icon={<FundOutlined />}
                color="#7c5cd6"
                label="本月毛利率"
                value={`${storeKpi.grossMargin}%`}
                suffix="扣食材直接成本"
                onClick={() => nav('/store-data')}
              />
            </Col>
          )}
          {hasModule('analysis') && storeKpi?.operatingMargin != null && (
            <Col xs={12} md={8} xl={4}>
              <StatCard
                icon={<FundOutlined />}
                color="var(--chart-3)"
                label="本月经营利润率"
                value={`${storeKpi.operatingMargin}%`}
                suffix="扣全部登记成本"
                onClick={() => nav('/store-data')}
              />
            </Col>
          )}
        </Row>
      )}

      {shown('follow') && (
        <Panel
          title={
            <>
              <MessageOutlined style={{ color: 'var(--chart-2)' }} /> {scopeLabel}沟通跟进看板
            </>
          }
          extra={
            <Space size={8}>
              <Tag color="blue">已沟通客户 {followOverview.summary?.communicatedCustomers || 0}</Tag>
              <Tag color="green">沟通记录 {followOverview.summary?.followRecords || 0}</Tag>
              <Tag color="purple">跟进账号 {followOverview.summary?.activeStaff || 0}</Tag>
              <Link style={{ fontSize: 12 }} to="/growth">
                查看明细/导出 <RightOutlined />
              </Link>
            </Space>
          }
        >
          <Row gutter={[12, 12]}>
            <Col xs={24} lg={10}>
              <Chart
                height={210}
                option={{
                  tooltip: { trigger: 'axis' },
                  grid: baseGrid,
                  xAxis: {
                    type: 'category',
                    data: (followOverview.daily || []).map((x: any) => String(x.date).slice(5)),
                    ...axisStyle,
                    boundaryGap: false,
                  },
                  yAxis: { type: 'value', ...axisStyle },
                  series: [
                    {
                      name: '沟通记录',
                      type: 'bar',
                      barWidth: 12,
                      data: (followOverview.daily || []).map((x: any) => x.records),
                      itemStyle: { borderRadius: [5, 5, 0, 0], color: 'var(--chart-2)' },
                    },
                    {
                      name: '沟通客户',
                      type: 'line',
                      smooth: true,
                      data: (followOverview.daily || []).map((x: any) => x.customers),
                      lineStyle: { width: 2, color: 'var(--ui-accent)' },
                      itemStyle: { color: 'var(--ui-accent)' },
                    },
                  ],
                }}
              />
            </Col>
            <Col xs={24} lg={6}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ui-text)' }}>
                  {showTeamRanking ? '员工竞赛榜' : '我的工作表现'}
                </div>
                <Tooltip title="综合分 = 跟进、客户、线索、已验收终态任务、已人工采纳内容、成交与荣誉调控">
                  <Tag color="blue" style={{ margin: 0, fontSize: 10 }}>
                    评分透明
                  </Tag>
                </Tooltip>
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  maxHeight: 420,
                  overflowY: 'auto',
                  paddingRight: 2,
                }}
              >
                {(followOverview.staff || []).map((s: any, i: number) => {
                  const meta = showTeamRanking
                    ? dashboardRankMeta(Number(s.rank || i + 1))
                    : {
                        icon: <StarFilled />,
                        label: '个人表现',
                        color: 'var(--ui-accent)',
                        bg: 'var(--ui-surface-2)',
                        border: 'var(--ui-border)',
                      };
                  const canOpen = canViewEmployeeDetail || Number(currentUser?.id) === Number(s.user_id);
                  return (
                    <button
                      type="button"
                      key={s.user_id || s.name}
                      onClick={() => openEmployee(s.user_id)}
                      aria-label={`${canOpen ? '查看' : ''}${s.name || '员工'}${showTeamRanking ? '竞赛档案' : '个人表现'}，综合分 ${s.score || 0}`}
                      style={{
                        appearance: 'none',
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        font: 'inherit',
                        color: 'inherit',
                        cursor: canOpen ? 'pointer' : 'default',
                        border: `1px solid ${meta.border}`,
                        background: meta.bg,
                        borderRadius: 10,
                        padding: '8px 10px',
                        boxShadow: i < 3 ? '0 6px 16px rgba(43,109,239,.08)' : 'none',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 8,
                            display: 'grid',
                            placeItems: 'center',
                            color: meta.color,
                            background: 'rgba(255,255,255,.72)',
                            fontSize: 15,
                          }}
                        >
                          {meta.icon}
                        </div>
                        <Avatar
                          size={26}
                          src={s.avatar || undefined}
                          style={{ background: 'var(--ui-surface)', color: 'var(--ui-accent)', fontSize: 12 }}
                        >
                          {String(s.name || '?').slice(0, 1)}
                        </Avatar>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                            <span
                              style={{
                                color: 'var(--ui-text)',
                                fontWeight: 700,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {s.name}
                            </span>
                            {s.award_type && (
                              <Tag color="gold" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>
                                <GiftOutlined /> {s.award_type}
                              </Tag>
                            )}
                          </div>
                          <div style={{ fontSize: 10.5, color: '#6b7280' }}>
                            {meta.label} · {roleName[s.role] || s.role || '员工'} · {s.dept || '未设岗位'}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: 16, lineHeight: 1.1, fontWeight: 800, color: meta.color }}>
                            {s.score || 0}
                          </div>
                          <div style={{ fontSize: 10.5, color: '#64748b' }}>综合分</div>
                        </div>
                      </div>
                      <Progress
                        percent={Math.min(100, Math.round((Number(s.score || 0) / topStaffScore) * 100))}
                        showInfo={false}
                        size="small"
                        strokeColor={
                          i === 0 ? '#f59e0b' : i === 1 ? '#64748b' : i === 2 ? '#f97316' : 'var(--ui-accent)'
                        }
                        style={{ margin: '7px 0 3px' }}
                      />
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          fontSize: 10.5,
                          color: 'var(--ui-text-2)',
                        }}
                      >
                        <span>跟进 {s.follow_count || 0}次</span>
                        <span>客户 {s.customer_count || 0}人</span>
                        <span>已验收任务 {s.completed_tasks || 0}个</span>
                        <span>
                          荣誉 {Number(s.bonus_points || 0) >= 0 ? '+' : ''}
                          {s.bonus_points || 0}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
              {(followOverview.staff || []).length === 0 && (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`${scopeLabel}暂无跟进`} />
              )}
            </Col>
            <Col xs={24} lg={8}>
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={(followOverview.recent || []).slice(0, 5)}
                onRow={(r: any) => interactiveRow(() => openCustomer(r.id))}
                columns={[
                  {
                    title: '客户',
                    dataIndex: 'name',
                    width: 92,
                    render: (v: string, r: any) => (
                      <span style={{ color: 'var(--ui-accent)' }}>
                        {v} <GradeTag grade={r.grade} />
                      </span>
                    ),
                  },
                  { title: '最近跟进', dataIndex: 'follower_name', width: 86 },
                  {
                    title: '内容/下次动作',
                    key: 'memo',
                    render: (_: any, r: any) => (
                      <div>
                        <div
                          style={{
                            fontSize: 12,
                            color: 'var(--ui-text-2)',
                            maxWidth: 180,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {r.last_content || '-'}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--ui-muted)' }}>
                          {r.next_follow_at ? `${r.next_follow_at} ${r.next_action || ''}` : '未设置下次跟进'}
                        </div>
                      </div>
                    ),
                  },
                ]}
              />
            </Col>
          </Row>
        </Panel>
      )}

      {/* 第二行：趋势 + 漏斗 + AI简报 */}
      {['trend', 'funnel', 'briefing'].some(shown) && (
        <Row gutter={[12, 12]}>
          {shown('trend') && (
            <Col xs={24} lg={Math.floor(24 / secondVisible)}>
              <Panel
                title={
                  <>
                    {scopeLabel}销售趋势{' '}
                    <span style={{ fontSize: 11, color: 'var(--ui-muted)', fontWeight: 400 }}>
                      点击数据点看当日来源
                    </span>
                  </>
                }
                extra={
                  hasModule('marshals') ? (
                    <Space size={8}>
                      <Button
                        size="small"
                        type="primary"
                        ghost
                        icon={<RobotOutlined />}
                        onClick={() =>
                          runAi(
                            '销售趋势AI分析',
                            `请分析本门店${scopeLabel}（${scopeRangeText}）销售趋势并给出判断与动作：${JSON.stringify(trend.slice(-14).map(x => ({ 日期: x.date, 成交额: x.deal_amount, 单数: x.deals, 新线索: x.new_leads })))}`,
                          )
                        }
                      >
                        AI分析
                      </Button>
                    </Space>
                  ) : undefined
                }
              >
                <Chart
                  height={250}
                  onClick={(p: any) => {
                    const row = trend[p?.dataIndex];
                    if (row?.date) openDayDetail(row.date);
                  }}
                  option={{
                    tooltip: { trigger: 'axis', valueFormatter: (v: any) => fmtMoney(v) },
                    grid: baseGrid,
                    xAxis: {
                      type: 'category',
                      data: trend.map(x => x.date.slice(5)),
                      ...axisStyle,
                      boundaryGap: false,
                    },
                    yAxis: { type: 'value', ...axisStyle },
                    series: [
                      {
                        name: '成交金额',
                        type: 'line',
                        smooth: true,
                        symbol: 'circle',
                        symbolSize: 7,
                        data: trend.map(x => x.deal_amount),
                        lineStyle: { width: 2.5, color: 'var(--ui-accent)' },
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
                    ],
                  }}
                />
              </Panel>
            </Col>
          )}
          {shown('funnel') && (
            <Col xs={24} lg={Math.floor(24 / secondVisible)}>
              <Panel
                title="客户阶段漏斗"
                extra={
                  <Space size={8}>
                    {hasModule('marshals') && (
                      <Button
                        size="small"
                        type="primary"
                        ghost
                        icon={<RobotOutlined />}
                        onClick={() =>
                          runAi(
                            '客户漏斗AI分析',
                            `请诊断本门店当前线索漏斗的卡点，并结合${scopeLabel}（${scopeRangeText}）经营数据给出下一步动作：${JSON.stringify((funnel.funnel || []).map((x: any) => ({ 阶段: x.stage, 人数: x.count, 转化率: x.rate, 基准: x.baseline })))}，当前卡点提示：${funnel.bottleneck || '无'}`,
                          )
                        }
                      >
                        AI分析
                      </Button>
                    )}
                    <Link style={{ fontSize: 12 }} to="/growth">
                      查看明细 <RightOutlined />
                    </Link>
                  </Space>
                }
              >
                <Chart
                  height={250}
                  onClick={() => nav('/growth')}
                  option={{
                    tooltip: {
                      formatter: (p: any) =>
                        `${p.name}：${p.value} 人<br/>层间转化率 ${funnel.funnel?.[p.dataIndex]?.rate}%`,
                    },
                    series: [
                      {
                        type: 'funnel',
                        left: 10,
                        right: 110,
                        top: 8,
                        bottom: 8,
                        gap: 4,
                        minSize: '28%',
                        label: {
                          show: true,
                          position: 'right',
                          formatter: (p: any) => `${p.name}  ${p.value}`,
                          color: 'var(--ui-text-2)',
                          fontSize: 12,
                        },
                        itemStyle: { borderRadius: 4 },
                        color: [
                          'var(--ui-accent)',
                          'var(--ui-muted)',
                          'var(--chart-2)',
                          'var(--warn)',
                          'var(--danger)',
                        ],
                        data: (funnel.funnel || []).map((x: any) => ({ name: x.stage, value: x.count })),
                      },
                    ],
                  }}
                />
                {funnel.bottleneck && (
                  <div style={{ fontSize: 12, color: 'var(--danger)' }}>
                    <AlertOutlined /> 当前卡点：「{funnel.bottleneck}」环节低于基准
                  </div>
                )}
              </Panel>
            </Col>
          )}
          {shown('briefing') && (
            <Col xs={24} lg={Math.floor(24 / secondVisible)}>
              <Panel
                title={
                  <>
                    <BulbOutlined style={{ color: 'var(--ui-accent)' }} /> AI经营简报
                  </>
                }
                extra={
                  <Tag color="blue" style={{ fontSize: 11 }}>
                    {briefing?.theme}
                  </Tag>
                }
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 250, overflow: 'auto' }}>
                  {(briefing?.briefing || []).map((b: any, i: number) => {
                    const item = typeof b === 'string' ? { text: b } : b;
                    const content = (
                      <>
                        <Badge color={CHART_COLORS[i % CHART_COLORS.length]} />
                        <span>
                          {item.text}
                          {item.source && (
                            <Tag
                              style={{
                                fontSize: 10,
                                marginLeft: 6,
                                color: 'var(--ui-accent)',
                                background: 'var(--ui-surface-2)',
                                border: 'none',
                                lineHeight: '16px',
                              }}
                            >
                              来源:{item.source} ›
                            </Tag>
                          )}
                        </span>
                      </>
                    );
                    return (
                      <Tooltip
                        key={i}
                        title={item.source ? `数据来源：${item.source}（点击查看）` : undefined}
                        placement="left"
                      >
                        {item.link ? (
                          <button
                            type="button"
                            onClick={() => nav(item.link)}
                            aria-label={`${item.text}${item.source ? `，来源：${item.source}` : ''}`}
                            style={{
                              appearance: 'none',
                              width: '100%',
                              border: 0,
                              background: 'transparent',
                              display: 'flex',
                              gap: 8,
                              font: 'inherit',
                              textAlign: 'left',
                              fontSize: 12.5,
                              color: 'var(--ui-text-2)',
                              lineHeight: 1.7,
                              cursor: 'pointer',
                              borderRadius: 6,
                              padding: '2px 4px',
                            }}
                            onMouseEnter={e => {
                              e.currentTarget.style.background = 'var(--ui-surface-2)';
                            }}
                            onMouseLeave={e => {
                              e.currentTarget.style.background = 'transparent';
                            }}
                            onFocus={e => {
                              e.currentTarget.style.background = 'var(--ui-surface-2)';
                            }}
                            onBlur={e => {
                              e.currentTarget.style.background = 'transparent';
                            }}
                          >
                            {content}
                          </button>
                        ) : (
                          <div
                            style={{
                              display: 'flex',
                              gap: 8,
                              fontSize: 12.5,
                              color: 'var(--ui-text-2)',
                              lineHeight: 1.7,
                              borderRadius: 6,
                              padding: '2px 4px',
                            }}
                          >
                            {content}
                          </div>
                        )}
                      </Tooltip>
                    );
                  })}
                  {briefing?.bossItems?.length > 0 && (
                    <div
                      style={{
                        background: 'var(--ui-warning-surface)',
                        borderRadius: 8,
                        padding: '8px 10px',
                        fontSize: 12,
                        color: '#e0a253',
                      }}
                    >
                      <b>待负责人确认：</b>
                      {briefing.bossItems.slice(0, 2).map((x: string, i: number) => (
                        <div key={i}>· {x}</div>
                      ))}
                    </div>
                  )}
                </div>
              </Panel>
            </Col>
          )}
        </Row>
      )}

      {/* 第三行：渠道 + 重点客户 + 员工入口 */}
      {['channels', 'customers', 'marshals'].some(shown) && (
        <Row gutter={[12, 12]}>
          {shown('channels') && (
            <Col xs={24} lg={Math.floor(24 / thirdVisible)}>
              <Panel
                title={`${scopeLabel}渠道效果分析`}
                extra={
                  hasModule('analysis') ? (
                    <Link style={{ fontSize: 12 }} to="/analysis">
                      查看全部 <RightOutlined />
                    </Link>
                  ) : undefined
                }
              >
                <Table
                  size="small"
                  rowKey="channel"
                  pagination={false}
                  dataSource={channels.slice(0, 6)}
                  onRow={canViewGrowth ? (r: any) => interactiveRow(() => openChannel(r.channel)) : undefined}
                  columns={[
                    {
                      title: '渠道',
                      dataIndex: 'channel',
                      render: (v: string) => <span style={{ color: 'var(--ui-accent)' }}>{v}</span>,
                    },
                    { title: '线索数', dataIndex: 'leads', align: 'right' },
                    { title: '成交数', dataIndex: 'deals', align: 'right' },
                    {
                      title: '转化率',
                      dataIndex: 'rate',
                      align: 'right',
                      width: 120,
                      render: (v: number) => (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                          <Progress
                            percent={Math.min(v * 2, 100)}
                            showInfo={false}
                            size="small"
                            style={{ width: 56 }}
                            strokeColor="var(--ui-accent)"
                          />
                          <span style={{ fontSize: 12 }}>{v}%</span>
                        </div>
                      ),
                    },
                  ]}
                />
              </Panel>
            </Col>
          )}
          {shown('customers') && (
            <Col xs={24} lg={Math.floor(24 / thirdVisible)}>
              <Panel
                title="重点客户 TOP5"
                extra={
                  <Link style={{ fontSize: 12 }} to="/growth">
                    进入跟进 <RightOutlined />
                  </Link>
                }
              >
                <Table
                  size="small"
                  rowKey="id"
                  pagination={false}
                  dataSource={keyCustomers}
                  onRow={(r: any) => interactiveRow(() => openCustomer(r.id))}
                  columns={[
                    {
                      title: '客户',
                      dataIndex: 'name',
                      render: (v: string, r: any) => (
                        <>
                          <span style={{ fontWeight: 600 }}>{v}</span> <GradeTag grade={r.grade} />
                        </>
                      ),
                    },
                    { title: '阶段', dataIndex: 'stage', render: (v: string) => <StageTag stage={v} /> },
                    {
                      title: '成交概率',
                      dataIndex: 'score',
                      align: 'right',
                      render: (v: number) => (
                        <span style={{ color: v >= 70 ? 'var(--danger)' : 'var(--ui-text-2)', fontWeight: 600 }}>
                          {v}分
                        </span>
                      ),
                    },
                    { title: '负责人', dataIndex: 'owner', width: 70 },
                  ]}
                />
              </Panel>
            </Col>
          )}
          {shown('marshals') && (
            <Col xs={24} lg={Math.floor(24 / thirdVisible)}>
              <Panel
                title="数字员工分部快捷入口"
                extra={
                  <Link style={{ fontSize: 12 }} to="/employees">
                    61名餐饮员工 <RightOutlined />
                  </Link>
                }
              >
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(54px, 1fr))', gap: 8 }}>
                  {marshals.map(m => (
                    <Tooltip key={m.id} title={`${m.name}（今日已验收产出 ${m.today_outputs}）`}>
                      <button
                        type="button"
                        onClick={() => nav(`/employees?group=${encodeURIComponent(m.name)}`)}
                        aria-label={`进入${m.name}，今日已验收产出 ${m.today_outputs || 0}`}
                        style={{
                          appearance: 'none',
                          width: '100%',
                          border: 0,
                          padding: 0,
                          background: 'transparent',
                          textAlign: 'center',
                          cursor: 'pointer',
                          font: 'inherit',
                          color: 'inherit',
                        }}
                      >
                        <Badge count={m.today_outputs} size="small" offset={[-2, 2]}>
                          <Avatar
                            size={40}
                            src={m.avatar || undefined}
                            style={{ background: 'var(--ui-surface-2)', fontSize: 19 }}
                          >
                            {m.emoji}
                          </Avatar>
                        </Badge>
                        <div
                          style={{
                            fontSize: 10.5,
                            color: 'var(--ui-text-2)',
                            marginTop: 4,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {m.name}
                        </div>
                      </button>
                    </Tooltip>
                  ))}
                </div>
                <div
                  style={{ marginTop: 14, background: 'var(--ui-surface-2)', borderRadius: 8, padding: '10px 12px' }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ui-text)', marginBottom: 6 }}>
                    待办与进度 <Badge count={totalTodos} size="small" />
                  </div>
                  {[
                    ['待审批事项', todos.approvals, '/system?tab=approvals'],
                    ['超期未跟进', todos.overdueLeads, '/growth'],
                    ['沉默合伙人', todos.silentPartners, '/execution'],
                    ['待我人工验收任务', todos.actionableReviewTasks ?? todos.reviewTasks, '/execution#task-board'],
                    ['我的提交待人工验收', todos.mySubmittedWaitingReview, '/execution#task-board'],
                    [
                      '内容员工产出待处理 / 需策略确认',
                      todos.contentEmployeeReviews,
                      '/content#content-employee-task-center',
                    ],
                    ['建议负责人介入', todos.bossLeads, '/growth'],
                  ].map(([label, n, to]: any) => (
                    <button
                      type="button"
                      key={label}
                      onClick={() => nav(to)}
                      aria-label={`${label} ${n ?? 0}`}
                      style={{
                        appearance: 'none',
                        width: '100%',
                        border: 0,
                        background: 'transparent',
                        display: 'flex',
                        justifyContent: 'space-between',
                        font: 'inherit',
                        textAlign: 'left',
                        fontSize: 12,
                        color: 'var(--ui-text-2)',
                        padding: '3px 0',
                        cursor: 'pointer',
                      }}
                    >
                      <span>{label}</span>
                      <span style={{ color: n > 0 ? 'var(--danger)' : 'var(--ui-muted)', fontWeight: 600 }}>
                        {n ?? 0}
                      </span>
                    </button>
                  ))}
                </div>
              </Panel>
            </Col>
          )}
        </Row>
      )}

      {/* 活动概览 */}
      {shown('activities') && (
        <Panel
          title={`${scopeLabel}活动概览`}
          extra={
            <Space size={10}>
              <Tooltip
                title={
                  hasModule('system')
                    ? `${feishuStatus.description} 到“系统管理 → 配置与备份 → 飞书集成”处理。`
                    : `${feishuStatus.description} 飞书由老板或管理层统一配置。`
                }
              >
                {hasModule('system') ? (
                  <Link to="/system" aria-label={`${feishuStatus.label}，前往系统管理`}>
                    <Tag color={feishuStatus.color} style={{ cursor: 'pointer', fontSize: 11 }}>
                      {feishuStatus.label}
                    </Tag>
                  </Link>
                ) : (
                  <Tag color={feishuStatus.color} style={{ cursor: 'pointer', fontSize: 11 }}>
                    {feishuStatus.label}
                  </Tag>
                )}
              </Tooltip>
              <Link style={{ fontSize: 12 }} to="/activities">
                活动中心 <RightOutlined />
              </Link>
            </Space>
          }
        >
          {weekActs.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`${scopeLabel}暂无活动`} />
          ) : (
            <Row gutter={[12, 12]}>
              {weekActs.map(a => (
                <Col xs={24} sm={12} lg={6} key={a.id}>
                  <button
                    type="button"
                    onClick={() => nav('/activities')}
                    aria-label={`查看活动：${a.title}`}
                    style={{
                      appearance: 'none',
                      width: '100%',
                      border: '1px solid var(--ui-border)',
                      background: 'transparent',
                      borderRadius: 10,
                      padding: 14,
                      cursor: 'pointer',
                      textAlign: 'left',
                      font: 'inherit',
                      color: 'inherit',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Tag
                        color={
                          {
                            品鉴会: 'blue',
                            封坛仪式: 'purple',
                            企业团购沙龙: 'orange',
                            招商说明会: 'green',
                            会员日: 'cyan',
                          }[a.type] || 'blue'
                        }
                      >
                        {ACTIVITY_LABELS[a.type] || a.type}
                      </Tag>
                      <Badge
                        status={a.status === '报名中' ? 'processing' : 'default'}
                        text={<span style={{ fontSize: 12 }}>{a.status}</span>}
                      />
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 13.5, margin: '8px 0 4px', color: 'var(--ui-text)' }}>
                      {a.title}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--ui-muted)' }}>
                      {a.date} · {a.location}
                    </div>
                    <Progress
                      percent={a.target_join > 0 ? Math.min(Math.round((a.signed_up / a.target_join) * 100), 100) : 0}
                      size="small"
                      format={() => `${a.signed_up}/${a.target_join || 0}人`}
                      style={{ marginTop: 8 }}
                    />
                  </button>
                </Col>
              ))}
            </Row>
          )}
        </Panel>
      )}

      <Drawer
        title={
          <Space>
            <AppstoreOutlined />
            自定义{dashboardName}
          </Space>
        }
        width={440}
        open={widgetOpen}
        onClose={() => setWidgetOpen(false)}
        extra={
          <Button type="primary" loading={widgetSaving} onClick={saveWidgets}>
            保存
          </Button>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`老板或管理员可自由选择${dashboardName}呈现内容；关闭模块不会删除任何经营数据。`}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(widgetPrefs.available || []).map((item: any) => {
            const active = shown(item.key);
            return (
              <button
                type="button"
                key={item.key}
                aria-pressed={active}
                aria-label={`${active ? '隐藏' : '显示'}${item.label}`}
                onClick={() =>
                  setWidgetPrefs((p: any) => ({
                    ...p,
                    selected: active ? p.selected.filter((x: string) => x !== item.key) : [...p.selected, item.key],
                  }))
                }
                style={{
                  appearance: 'none',
                  width: '100%',
                  cursor: 'pointer',
                  border: `1px solid ${active ? 'var(--ui-accent)' : 'var(--ui-border)'}`,
                  background: active ? 'var(--ui-surface-2)' : 'var(--ui-surface)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  display: 'flex',
                  gap: 10,
                  alignItems: 'center',
                  textAlign: 'left',
                  font: 'inherit',
                  color: 'inherit',
                }}
              >
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 5,
                    display: 'grid',
                    placeItems: 'center',
                    background: active ? 'var(--ui-primary)' : 'var(--ui-border)',
                    color: 'var(--ui-on-primary)',
                  }}
                >
                  {active ? '✓' : ''}
                </div>
                <div>
                  <div style={{ fontWeight: 700 }}>{item.label}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', marginTop: 2 }}>{item.description}</div>
                </div>
              </button>
            );
          })}
        </div>
      </Drawer>

      {/* —— 趋势某日来源明细 —— */}
      <Modal
        open={!!dayDetail}
        footer={null}
        width={680}
        onCancel={() => setDayDetail(null)}
        title={`数据来源明细 · ${dayDetail?.date || ''}`}
      >
        {dayDetail?.loading ? (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <Spin />
          </div>
        ) : (
          dayDetail && (
            <>
              <Descriptions
                size="small"
                column={4}
                bordered
                style={{ marginBottom: 12 }}
                items={
                  [
                    { key: '1', label: '新增线索', children: dayDetail.ops?.new_leads ?? 0 },
                    { key: '2', label: '邀约', children: dayDetail.ops?.invited ?? 0 },
                    { key: '3', label: '到店', children: dayDetail.ops?.arrived ?? 0 },
                    { key: '4', label: '内容产出', children: dayDetail.contents ?? 0 },
                  ] as any
                }
              />
              <div style={{ fontWeight: 600, fontSize: 13, margin: '10px 0 6px' }}>当日订单（成交金额构成）</div>
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={dayDetail.orders || []}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当日无订单" /> }}
                columns={[
                  { title: '客户', dataIndex: 'customer', render: (v: string) => v || '-' },
                  { title: '产品', dataIndex: 'product' },
                  { title: '类型', dataIndex: 'type', width: 70, render: (v: string) => <Tag>{v}</Tag> },
                  { title: '渠道', dataIndex: 'channel', width: 90 },
                  { title: '金额', dataIndex: 'amount', align: 'right', render: (v: number) => <b>{fmtMoney(v)}</b> },
                ]}
              />
              {(dayDetail.newLeads || []).length > 0 && (
                <>
                  <div style={{ fontWeight: 600, fontSize: 13, margin: '12px 0 6px' }}>当日新增线索来源</div>
                  <Space size={[6, 6]} wrap>
                    {dayDetail.newLeads.map((l: any) => (
                      <Tag key={l.id} color="blue">
                        {l.name} · {l.source}
                      </Tag>
                    ))}
                  </Space>
                </>
              )}
            </>
          )
        )}
      </Modal>

      {/* —— 渠道明细下钻 —— */}
      <Modal
        open={!!channelDetail}
        footer={null}
        width={720}
        onCancel={() => setChannelDetail(null)}
        title={
          <Space>
            渠道明细 · {channelDetail?.channel}
            <Tag color="blue">{channelDetail?.total ?? 0} 条线索</Tag>
          </Space>
        }
      >
        {channelDetail?.loading ? (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <Spin />
          </div>
        ) : (
          <>
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={channelDetail?.rows || []}
              onRow={(r: any) =>
                interactiveRow(() => {
                  setChannelDetail(null);
                  openCustomer(r.id);
                })
              }
              columns={[
                {
                  title: '客户',
                  dataIndex: 'name',
                  render: (v: string, r: any) => (
                    <Space size={4}>
                      <span style={{ color: 'var(--ui-accent)' }}>{v}</span>
                      <GradeTag grade={r.grade} />
                    </Space>
                  ),
                },
                { title: '身份', dataIndex: 'identity_tag', width: 90 },
                { title: '阶段', dataIndex: 'stage', width: 80, render: (v: string) => <StageTag stage={v} /> },
                { title: '评分', dataIndex: 'score', width: 64, align: 'right', render: (v: number) => <b>{v}</b> },
                { title: '负责人', dataIndex: 'owner_name', width: 76 },
              ]}
            />
            <div style={{ textAlign: 'right', marginTop: 10 }}>
              <Button size="small" type="primary" ghost onClick={() => nav('/growth')}>
                到增长中心查看全部 ›
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* —— 员工竞赛档案 —— */}
      <Drawer
        open={!!employeeDetail}
        width={720}
        onClose={() => setEmployeeDetail(null)}
        title={
          employeeDetail?.profile?.name ? (
            <Space>
              <Avatar
                src={employeeDetail.profile.avatar || undefined}
                style={{ background: 'var(--ui-surface-2)', color: 'var(--ui-accent)' }}
              >
                {String(employeeDetail.profile.name || '?').slice(0, 1)}
              </Avatar>
              <span>{employeeDetail.profile.name}</span>
              <Tag color="blue">{roleName[employeeDetail.profile.role] || employeeDetail.profile.role}</Tag>
              {employeeDetail.score?.award_type && (
                <Tag color="gold">
                  <GiftOutlined /> {employeeDetail.score.award_type}
                </Tag>
              )}
            </Space>
          ) : (
            '员工竞赛档案'
          )
        }
        extra={
          canEvaluateEmployees && employeeDetail?.profile?.id ? (
            <Space>
              <Button size="small" icon={<PlusOutlined />} onClick={() => setPointModalOpen(true)}>
                调控荣誉积分
              </Button>
              <Button size="small" type="primary" ghost icon={<GiftOutlined />} onClick={() => setAwardModalOpen(true)}>
                评优秀员工
              </Button>
            </Space>
          ) : null
        }
      >
        {employeeLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin />
          </div>
        ) : (
          employeeDetail?.profile && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div
                style={{
                  background: 'linear-gradient(135deg,var(--ui-surface-2),var(--ui-warning-surface))',
                  border: '1px solid var(--ui-surface)',
                  borderRadius: 12,
                  padding: 14,
                }}
              >
                <Row gutter={[12, 12]} align="middle">
                  <Col flex="auto">
                    <div style={{ fontSize: 13, color: '#64748b' }}>
                      {employeeDetail.scope?.label || scopeLabel}竞赛排名
                    </div>
                    <Space size={10} wrap style={{ marginTop: 6 }}>
                      <Tag
                        color={employeeDetail.score?.rank === 1 ? 'gold' : 'blue'}
                        style={{ fontSize: 13, padding: '2px 10px' }}
                      >
                        第 {employeeDetail.score?.rank || '-'} 名
                      </Tag>
                      <span style={{ fontSize: 28, fontWeight: 800, color: 'var(--ui-accent)', lineHeight: 1 }}>
                        {employeeDetail.score?.score || 0}
                      </span>
                      <span style={{ color: '#64748b' }}>综合分</span>
                    </Space>
                  </Col>
                  <Col>
                    <Space size={6} wrap>
                      <Tag color="cyan">跟进 {employeeDetail.score?.follow_count || 0}次</Tag>
                      <Tag color="green">客户 {employeeDetail.score?.customer_count || 0}人</Tag>
                      <Tag color="orange">成交 {employeeDetail.score?.deal_count || 0}单</Tag>
                      <Tag color="purple">
                        荣誉 {Number(employeeDetail.score?.bonus_points || 0) >= 0 ? '+' : ''}
                        {employeeDetail.score?.bonus_points || 0}
                      </Tag>
                    </Space>
                  </Col>
                </Row>
              </div>
              <Descriptions
                size="small"
                column={2}
                bordered
                items={
                  [
                    { key: '1', label: '账号', children: employeeDetail.profile.username || '-' },
                    { key: '2', label: '岗位/部门', children: employeeDetail.profile.dept || '-' },
                    {
                      key: '3',
                      label: '角色',
                      children: roleName[employeeDetail.profile.role] || employeeDetail.profile.role || '-',
                    },
                    { key: '4', label: '手机号', children: employeeDetail.profile.phone || '-' },
                    { key: '5', label: '入职/开通时间', children: fmtDate(employeeDetail.profile.created_at) },
                    { key: '6', label: '最近登录', children: fmtDate(employeeDetail.profile.last_login_at) },
                    { key: '7', label: '已人工采纳内容', children: `${employeeDetail.score?.content_count || 0}条` },
                    { key: '8', label: '成交金额', children: fmtMoney(employeeDetail.score?.deal_amount || 0) },
                  ] as any
                }
              />
              <Panel
                title="评分过程与依据"
                extra={
                  <Tooltip title={employeeDetail.score?.score_formula}>
                    <Tag color="blue">查看公式</Tag>
                  </Tooltip>
                }
              >
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 8 }}>
                  {(employeeDetail.score?.score_detail || []).map((item: any) => (
                    <div
                      key={item.key}
                      style={{
                        border: '1px solid var(--ui-border)',
                        borderRadius: 8,
                        padding: '8px 10px',
                        background: 'var(--ui-surface)',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                        <span style={{ fontWeight: 700, color: 'var(--ui-text)' }}>{item.label}</span>
                        <span style={{ fontWeight: 800, color: Number(item.points) >= 0 ? '#16a34a' : '#ef4444' }}>
                          {Number(item.points) >= 0 ? '+' : ''}
                          {item.points}
                        </span>
                      </div>
                      <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 4 }}>
                        {item.value} · {item.rule}
                      </div>
                    </div>
                  ))}
                </div>
              </Panel>
              <Row gutter={[12, 12]}>
                <Col xs={24} md={12}>
                  <Panel title={`最近跟进（${(employeeDetail.recentFollows || []).length}）`}>
                    <Timeline
                      items={(employeeDetail.recentFollows || []).slice(0, 8).map((f: any) => ({
                        children: (
                          <div style={{ fontSize: 12.5 }}>
                            <b>{f.lead_name || '客户'}</b> <Tag style={{ marginLeft: 4 }}>{f.lead_stage || '-'}</Tag>
                            <div style={{ color: '#94a3b8', fontSize: 11 }}>{fmtDate(f.created_at)}</div>
                            <div style={{ color: 'var(--ui-text-2)', lineHeight: 1.6 }}>{f.content || '-'}</div>
                          </div>
                        ),
                      }))}
                    />
                    {(employeeDetail.recentFollows || []).length === 0 && (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无跟进记录" />
                    )}
                  </Panel>
                </Col>
                <Col xs={24} md={12}>
                  <Panel title={`任务与提交（${(employeeDetail.tasks || []).length}）`}>
                    <Table
                      size="small"
                      rowKey="id"
                      pagination={false}
                      dataSource={(employeeDetail.tasks || []).slice(0, 6)}
                      columns={[
                        { title: '任务', dataIndex: 'title', ellipsis: true },
                        { title: '状态', dataIndex: 'status', width: 74, render: (v: string) => <Tag>{v}</Tag> },
                        { title: '截止', dataIndex: 'due_at', width: 92, render: fmtDate },
                      ]}
                    />
                  </Panel>
                </Col>
              </Row>
              <Panel title="客户与内容证据">
                <Row gutter={[12, 12]}>
                  <Col xs={24} md={12}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>负责客户 TOP</div>
                    <Table
                      size="small"
                      rowKey="id"
                      pagination={false}
                      dataSource={(employeeDetail.ownedLeads || []).slice(0, 5)}
                      columns={[
                        {
                          title: '客户',
                          dataIndex: 'name',
                          ellipsis: true,
                          render: (v: string, r: any) => (
                            <Space size={4}>
                              <span>{v}</span>
                              <GradeTag grade={r.grade} />
                            </Space>
                          ),
                        },
                        { title: '阶段', dataIndex: 'stage', width: 78, render: (v: string) => <StageTag stage={v} /> },
                        { title: '分', dataIndex: 'score', width: 46, align: 'right' },
                      ]}
                    />
                  </Col>
                  <Col xs={24} md={12}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>内容产出</div>
                    <Table
                      size="small"
                      rowKey="id"
                      pagination={false}
                      dataSource={(employeeDetail.contents || []).slice(0, 5)}
                      columns={[
                        {
                          title: '内容',
                          dataIndex: 'title',
                          ellipsis: true,
                          render: (v: string, r: any) => v || r.type,
                        },
                        { title: '类型', dataIndex: 'type', width: 92, render: (v: string) => <Tag>{v}</Tag> },
                        { title: '状态', dataIndex: 'status', width: 70 },
                      ]}
                    />
                  </Col>
                </Row>
              </Panel>
              <Row gutter={[12, 12]}>
                <Col xs={24} md={12}>
                  <Panel title="荣誉积分调控记录">
                    {(employeeDetail.pointLogs || []).length === 0 ? (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无调控记录" />
                    ) : (
                      <Timeline
                        items={(employeeDetail.pointLogs || []).slice(0, 6).map((p: any) => ({
                          color: p.delta >= 0 ? 'green' : 'red',
                          children: (
                            <div style={{ fontSize: 12.5 }}>
                              <b>
                                {p.delta >= 0 ? '+' : ''}
                                {p.delta}分
                              </b>{' '}
                              · {p.reason}
                              <div style={{ color: '#94a3b8', fontSize: 11 }}>
                                {fmtDate(p.created_at)} · {p.operator_name || '系统'}
                              </div>
                            </div>
                          ),
                        }))}
                      />
                    )}
                  </Panel>
                </Col>
                <Col xs={24} md={12}>
                  <Panel title="评优记录">
                    {(employeeDetail.awards || []).length === 0 ? (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无评优记录" />
                    ) : (
                      <Timeline
                        items={(employeeDetail.awards || []).slice(0, 6).map((a: any) => ({
                          color: 'gold',
                          children: (
                            <div style={{ fontSize: 12.5 }}>
                              <b>
                                {a.period} · {a.award_type}
                              </b>
                              <Tag color="gold" style={{ marginLeft: 6 }}>
                                {a.score}分
                              </Tag>
                              <div style={{ color: 'var(--ui-text-2)' }}>{a.comment}</div>
                              <div style={{ color: '#94a3b8', fontSize: 11 }}>
                                {fmtDate(a.created_at)} · {a.operator_name || '系统'}
                              </div>
                            </div>
                          ),
                        }))}
                      />
                    )}
                  </Panel>
                </Col>
              </Row>
            </div>
          )
        )}
      </Drawer>

      <Modal
        open={pointModalOpen}
        title={`调控 ${employeeDetail?.profile?.name || '员工'} 的荣誉积分`}
        okText="确认调控"
        cancelText="取消"
        onOk={submitHonorPoints}
        onCancel={() => setPointModalOpen(false)}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <InputNumber
            min={-500}
            max={500}
            value={pointDelta}
            onChange={v => setPointDelta(Number(v) || 0)}
            style={{ width: '100%' }}
            addonAfter="分"
            placeholder="正数增加，负数扣减"
          />
          <Input.TextArea
            rows={3}
            value={pointReason}
            onChange={e => setPointReason(e.target.value)}
            placeholder="填写调控原因，例如：重点客户推进有结果 / 跟进记录缺失需扣减"
            maxLength={160}
            showCount
          />
        </Space>
      </Modal>

      <Modal
        open={awardModalOpen}
        title={`评选 ${employeeDetail?.profile?.name || '员工'} 为月度优秀员工`}
        okText="确认评优"
        cancelText="取消"
        onOk={submitEmployeeAward}
        onCancel={() => setAwardModalOpen(false)}
      >
        <Input.TextArea
          rows={4}
          value={awardComment}
          onChange={e => setAwardComment(e.target.value)}
          placeholder="填写评优理由，例如：本月综合分靠前，跟进闭环完整，客户转化和团队协作表现突出"
          maxLength={240}
          showCount
        />
      </Modal>

      {/* —— 重点客户全档案 Drawer —— */}
      <Drawer
        open={!!custDetail}
        width={520}
        onClose={() => setCustDetail(null)}
        title={
          custDetail?.name ? (
            <Space>
              {custDetail.name}
              <GradeTag grade={custDetail.grade} />
              <StageTag stage={custDetail.stage} />
            </Space>
          ) : (
            '客户档案'
          )
        }
      >
        {custLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin />
          </div>
        ) : (
          custDetail?.name && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Descriptions
                size="small"
                column={2}
                bordered
                items={
                  [
                    { key: '1', label: '身份', children: custDetail.identity_tag || '-' },
                    { key: '2', label: '预算', children: custDetail.budget_level || '-' },
                    { key: '3', label: '意向', children: custDetail.interest || '-' },
                    { key: '4', label: '来源', children: custDetail.source || '-' },
                    { key: '5', label: '公司', children: custDetail.company || '-' },
                    { key: '6', label: '区域', children: custDetail.region || '-' },
                    { key: '7', label: '电话', children: custDetail.phone || '-' },
                    { key: '8', label: '负责人', children: custDetail.owner_name || '-' },
                    { key: '9', label: '下次跟进', children: custDetail.next_follow_at || '-' },
                    { key: '10', label: '跟进动作', children: custDetail.next_action || '-' },
                    {
                      key: '11',
                      label: '累计跟进',
                      children: custDetail.follow_stats?.total
                        ? `${custDetail.follow_stats.total}次 / ${custDetail.follow_stats.user_count}个账号`
                        : '未跟进',
                    },
                    { key: '12', label: '最近跟进人', children: custDetail.follow_stats?.last_user || '-' },
                  ] as any
                }
              />
              {custJourney && (
                <Panel
                  title={`生命周期 · 当前「${custJourney.current}」（${(custJourney.journey || []).filter((j: any) => j.reached).length}/11节点 · ${custJourney.totalDays}天）`}
                >
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {(custJourney.journey || []).map((j: any) => (
                      <Tag
                        key={j.node}
                        color={j.node === custJourney.current ? 'blue' : j.reached ? 'green' : 'default'}
                        style={{ margin: 0, fontSize: 11, opacity: j.reached ? 1 : 0.55 }}
                        title={j.at ? `${j.at}${j.note ? ' · ' + j.note : ''}` : '未到达'}
                      >
                        {j.reached ? '✓' : '·'} {j.node}
                        {j.stayDays != null && j.stayDays > 0 && j.node !== custJourney.current
                          ? ` ${j.stayDays}d`
                          : ''}
                      </Tag>
                    ))}
                  </div>
                  {custJourney.nextHint && (
                    <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ui-accent)' }}>
                      💡 下一步：{custJourney.nextHint}
                    </div>
                  )}
                </Panel>
              )}
              <Panel title={`成交概率 ${custDetail.score} 分（可解释构成）`}>
                {Object.entries(custDetail.score_detail || {}).map(([k, v]: any) => (
                  <div
                    key={k}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 12.5,
                      padding: '3px 0',
                      color: 'var(--ui-text-2)',
                    }}
                  >
                    <span>{k}</span>
                    <b style={{ color: v >= 0 ? '#16a34a' : '#ef4444' }}>
                      {v >= 0 ? '+' : ''}
                      {v}
                    </b>
                  </div>
                ))}
              </Panel>
              {(custDetail.concerns || []).length > 0 && (
                <Panel title="顾虑">
                  <Space size={[6, 6]} wrap>
                    {custDetail.concerns.map((c: any, i: number) => (
                      <Tag key={i} color={c.resolved ? 'default' : 'orange'}>
                        {c.resolved ? '✓ ' : ''}
                        {c.text}
                      </Tag>
                    ))}
                  </Space>
                </Panel>
              )}
              <Panel title={`跟进记录（${(custDetail.follows || []).length}）`}>
                <Timeline
                  items={(custDetail.follows || []).slice(0, 8).map((f: any) => ({
                    children: (
                      <div style={{ fontSize: 12.5 }}>
                        <b>{f.user_name || '系统'}</b>{' '}
                        <span style={{ color: 'var(--ui-muted)', fontSize: 11 }}>
                          {(f.created_at || '').slice(5, 16)}
                        </span>
                        <div style={{ color: 'var(--ui-text-2)' }}>{f.content}</div>
                      </div>
                    ),
                  }))}
                />
              </Panel>
              <Button type="primary" block onClick={() => nav('/growth')}>
                到增长中心跟进此客户 ›
              </Button>
            </div>
          )
        )}
      </Drawer>

      {/* —— AI分析弹窗（调用财务与数据部） —— */}
      <Modal
        open={ai.open}
        footer={null}
        width={680}
        onCancel={() => {
          setAi({ open: false, title: '' });
          stream.reset();
        }}
        title={
          <Space>
            <RobotOutlined style={{ color: 'var(--ui-accent)' }} />
            {ai.title}
            <Tag color="blue">
              <Avatar
                size={16}
                src={dataMarshal?.avatar || undefined}
                style={{ background: 'var(--ui-surface-2)', fontSize: 9, marginRight: 4 }}
              >
                {dataMarshal?.emoji}
              </Avatar>
              {dataMarshal?.name || '财务与数据部'}
            </Tag>
          </Space>
        }
      >
        {ai.unconfigured ? (
          <Alert
            type="warning"
            showIcon
            message={`${dataMarshal?.name || '财务与数据部'}尚未完成配置`}
            description="请到系统管理检查数字员工目录初始化状态。"
          />
        ) : (
          <StreamingOutput
            running={stream.running}
            text={stream.text}
            stage={stream.stage}
            typing={stream.typing}
            error={stream.error}
            onRetry={retryAi}
            stages={AI_ANALYSIS_STAGES}
            emptyHint="分析结果将显示在这里"
          />
        )}
        {!stream.running && stream.text && (
          <Space style={{ marginTop: 'var(--space-3)' }}>
            <Button
              size="small"
              onClick={() => {
                navigator.clipboard?.writeText(stream.text);
                message.success('已复制');
              }}
            >
              复制
            </Button>
            <Button size="small" type="primary" ghost onClick={() => nav('/employees?group=财务与数据部')}>
              查看数据员工 ›
            </Button>
          </Space>
        )}
      </Modal>
    </div>
  );
}
