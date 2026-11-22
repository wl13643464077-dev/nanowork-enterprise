import type { ReactNode } from 'react';
import { Card } from 'antd';
import {
  AppstoreOutlined,
  ArrowRightOutlined,
  BarChartOutlined,
  CalendarOutlined,
  ClockCircleOutlined,
  DollarOutlined,
  ExperimentOutlined,
  InboxOutlined,
  RightOutlined,
  RiseOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { fmtMoney } from '../../api/client';
import { useQuery, QueryStatus } from '../../hooks/useQuery';
import type { DashboardSummary, DashboardBriefing } from '../../api/types';
import { mobilePath, toMobilePath } from './mobileRoutes';
import './mobile.css';

// 首页：经营数据 + 待我处理入口 + 核心工作台 + 经营简报。
// 「客户」「内容」不再占底部 Tab，作为首页二级入口保留可达。

const CORE_WORKSPACES = [
  {
    key: 'employees',
    mod: 'marshals',
    roles: ['boss', 'ops_director', 'manager', 'sales'],
    title: '餐饮数字员工',
    description: '查看岗位数字员工并派活',
    path: '/employees',
    icon: <AppstoreOutlined />,
    tone: 1,
  },
  {
    key: 'execution',
    mod: 'execution',
    roles: ['boss', 'ops_director', 'manager', 'sales', 'partner', 'admin'],
    title: '任务看板',
    description: '接收、完成并提交本人或团队任务',
    path: '/execution',
    icon: <ClockCircleOutlined />,
    tone: 4,
  },
  {
    key: 'toolbox',
    mod: 'content',
    roles: ['boss', 'ops_director', 'manager', 'sales'],
    title: '经营工具箱',
    description: '按经营场景调用实战工具',
    path: '/toolbox',
    icon: <ToolOutlined />,
    tone: 2,
  },
  {
    key: 'content',
    mod: 'content',
    roles: ['boss', 'ops_director', 'manager', 'sales'],
    title: '内容生产仓',
    description: '进入选题、生产与内容管理',
    path: '/content',
    icon: <ExperimentOutlined />,
    tone: 8,
  },
  {
    key: 'analysis',
    mod: 'analysis',
    roles: ['boss', 'ops_director', 'manager'],
    title: '经营分析',
    description: '查看门店数据与经营洞察',
    path: '/analysis',
    icon: <BarChartOutlined />,
    tone: 3,
  },
];

// 测试员体验正式业务页面；内容生产不能被映射成手机端的已采纳素材列表。
const TESTER_PRODUCT_WORKSPACES = [
  ...CORE_WORKSPACES,
  {
    key: 'advisor',
    mod: 'advisor',
    title: '老板参谋',
    description: '讨论经营问题与行动建议',
    path: '/advisor',
    icon: <TeamOutlined />,
    tone: 1,
  },
  {
    key: 'tasks',
    mod: 'execution',
    title: '任务中心',
    description: '查看输入输出、进度与历史成果',
    path: '/tasks',
    icon: <InboxOutlined />,
    tone: 4,
  },
  {
    key: 'store-ops',
    mod: 'dashboard',
    title: '门店日常',
    description: '查看日常经营与门店工作',
    path: '/store-ops',
    icon: <AppstoreOutlined />,
    tone: 1,
  },
  {
    key: 'reviews',
    mod: 'dashboard',
    title: '评价中心',
    description: '处理门店评价与回复',
    path: '/reviews',
    icon: <TeamOutlined />,
    tone: 2,
  },
  {
    key: 'growth',
    mod: 'growth',
    title: '会员增长',
    description: '客户经营与增长跟进',
    path: '/growth',
    icon: <RiseOutlined />,
    tone: 2,
  },
  {
    key: 'activities',
    mod: 'activities',
    title: '营销活动',
    description: '策划与管理门店活动',
    path: '/activities',
    icon: <CalendarOutlined />,
    tone: 3,
  },
  {
    key: 'assets',
    mod: 'assets',
    title: '知识资产',
    description: '管理自己的经营知识与资料',
    path: '/assets',
    icon: <AppstoreOutlined />,
    tone: 8,
  },
  {
    key: 'agents',
    mod: 'marshals',
    title: '我的智能体',
    description: '查看已授权的智能体工作区',
    path: '/agents',
    icon: <ExperimentOutlined />,
    tone: 8,
  },
];

export function testerMobileWorkspaces(mods: string[]) {
  return TESTER_PRODUCT_WORKSPACES.filter(item => mods.includes(item.mod));
}

export function hasMobileHomeAccess(mods: string[], role: string) {
  return (
    mods.includes('dashboard') || CORE_WORKSPACES.some(item => mods.includes(item.mod) && item.roles.includes(role))
  );
}

function Stat({
  icon,
  tone,
  label,
  value,
  suffix,
}: {
  icon: ReactNode;
  tone: number;
  label: string;
  value: ReactNode;
  suffix?: string;
}) {
  return (
    <div className="m-stat" data-tone={tone}>
      <div className="m-stat-icon">{icon}</div>
      <div>
        <div className="m-stat-label">{label}</div>
        <div className="m-stat-value">
          {value}
          {suffix && <small>{suffix}</small>}
        </div>
      </div>
    </div>
  );
}

type DashboardSummaryExt = DashboardSummary & {
  overdue?: number;
  salesWow?: number;
  health?: { score?: number; level?: string } | null;
};

type PulseSignal = {
  level: 'danger' | 'warn' | 'info' | 'ok';
  text: string;
  employeeIdx?: number;
};

export default function MobileHome({
  nav,
  user,
  mods,
  inboxCount,
}: {
  nav: (path: string) => void;
  user: any;
  mods: string[];
  inboxCount: number;
}) {
  const role = String(user.role || '');
  const isTester = user.accountType === 'tester';
  const hasDashboard = mods.includes('dashboard');
  const canDispatch = mods.includes('marshals');
  const canViewManagementBriefing = hasDashboard && ['boss', 'ops_director', 'manager', 'admin'].includes(role);
  const workspaces = isTester
    ? testerMobileWorkspaces(mods)
    : CORE_WORKSPACES.filter(item => mods.includes(item.mod) && item.roles.includes(role));
  const summaryQ = useQuery<DashboardSummary>('/dashboard/summary', [], { enabled: hasDashboard });
  const briefQ = useQuery<DashboardBriefing>('/dashboard/briefing', [], {
    enabled: canViewManagementBriefing,
    isEmpty: d => !d?.briefing?.length,
  });
  const s = summaryQ.data;
  if (hasDashboard && !s && !isTester) return <QueryStatus q={summaryQ} height={200} />;
  const summary = hasDashboard && s && typeof s.todaySales === 'number' ? (s as DashboardSummaryExt) : null;
  const briefing = briefQ.data?.briefing || [];
  const overdue = Number(summary?.overdue || 0);
  const pendingFollow = Number(summary?.pendingFollow || 0);
  const salesWow = typeof summary?.salesWow === 'number' ? summary.salesWow : null;
  const healthScore = typeof summary?.health?.score === 'number' ? summary.health.score : null;
  const firstBriefText = briefing.length
    ? typeof briefing[0] === 'string'
      ? briefing[0]
      : briefing[0]?.text || ''
    : '';
  const pulseSignals: PulseSignal[] = [];
  if (overdue > 0) {
    pulseSignals.push({
      level: 'danger',
      text: `有 ${overdue} 位客户跟进已超期，建议立即唤醒防止流失`,
      employeeIdx: 144,
    });
  }
  if (salesWow !== null && salesWow <= -10) {
    pulseSignals.push({
      level: 'warn',
      text: `今日销售较昨日波动 ${salesWow}%，建议速查客流原因并策划引流`,
      employeeIdx: 160,
    });
  }
  if (inboxCount > 0 && pulseSignals.length < 2) {
    pulseSignals.push({
      level: 'warn',
      text: `当前有 ${inboxCount} 项待审阅/审批事项等你拍板`,
    });
  }
  if (firstBriefText && pulseSignals.length < 2) {
    pulseSignals.push({ level: 'info', text: firstBriefText });
  }
  if (!pulseSignals.length && summary) {
    pulseSignals.push(
      pendingFollow > 0
        ? {
            level: 'info',
            text: `今日有 ${pendingFollow} 位待跟进客户，可直派数字员工生成跟进话术与唤醒方案`,
            employeeIdx: 144,
          }
        : {
            level: 'ok',
            text: `今日销售 ${fmtMoney(summary.todaySales)}，进行中活动 ${summary.runningActivities ?? 0} 场，经营态势平稳`,
          },
    );
  }
  const hasUrgentSignal = overdue > 0 || inboxCount > 0 || (salesWow !== null && salesWow <= -10);
  const showPulseCard = Boolean(summary || briefing.length > 0 || inboxCount > 0);
  const suggestedEmployeeIdx = pulseSignals.find(item => item.employeeIdx)?.employeeIdx;
  const secondary = [
    mods.includes('growth') && { key: 'customers', title: '客户', desc: '跟进记录、AI 话术', icon: <TeamOutlined /> },
    mods.includes('content') && {
      key: 'content',
      title: '内容',
      desc: '已采纳素材，复制发圈',
      icon: <ExperimentOutlined />,
    },
  ].filter(Boolean) as { key: 'customers' | 'content'; title: string; desc: string; icon: ReactNode }[];

  return (
    <div className="m-stack">
      {showPulseCard && (
        <section className={`m-pulse-card${hasUrgentSignal ? ' is-urgent' : ''}`} aria-label="今日经营速报">
          <div className="m-pulse-head">
            <span className="m-pulse-title">
              <ThunderboltOutlined aria-hidden="true" />
              <strong>今日经营速报</strong>
            </span>
            <span className={`m-pulse-badge${hasUrgentSignal ? ' is-warn' : ' is-ok'}`}>
              {hasUrgentSignal ? '需优先关注' : healthScore !== null ? `健康分 ${healthScore}` : '态势平稳'}
            </span>
          </div>
          {summary && (
            <div className="m-pulse-metrics">
              <div className="m-pulse-metric">
                <small>今日营收</small>
                <strong>{fmtMoney(summary.todaySales)}</strong>
              </div>
              <div className="m-pulse-metric">
                <small>{overdue > 0 ? '超期未跟进' : '待跟进客户'}</small>
                <strong className={overdue > 0 ? 'is-danger' : undefined}>
                  {overdue > 0 ? `${overdue} 人` : `${pendingFollow} 人`}
                </strong>
              </div>
              <div className="m-pulse-metric">
                <small>待拍板事项</small>
                <strong className={inboxCount > 0 ? 'is-warn' : undefined}>{inboxCount} 件</strong>
              </div>
            </div>
          )}
          {pulseSignals.length > 0 && (
            <ul className="m-pulse-signals">
              {pulseSignals.slice(0, 2).map((signal, index) => (
                <li key={index} className={`m-pulse-signal is-${signal.level}`}>
                  <span className="m-pulse-dot" aria-hidden="true" />
                  <span>{signal.text}</span>
                </li>
              ))}
            </ul>
          )}
          {canDispatch ? (
            <button
              type="button"
              className="m-pulse-cta"
              onClick={() =>
                nav(mobilePath('dispatch', suggestedEmployeeIdx ? { employee: suggestedEmployeeIdx } : {}))
              }
            >
              <span>直派数字员工处理</span>
              <ArrowRightOutlined aria-hidden="true" />
            </button>
          ) : inboxCount > 0 ? (
            <button type="button" className="m-pulse-cta" onClick={() => nav(mobilePath('inbox'))}>
              <span>立即处理待办事项</span>
              <ArrowRightOutlined aria-hidden="true" />
            </button>
          ) : null}
        </section>
      )}
      <button type="button" className="m-inbox-entry" onClick={() => nav(mobilePath('inbox'))}>
        <InboxOutlined className="m-stat-icon" data-tone={1} />
        <div className="m-row-main">
          <strong>{inboxCount > 0 ? `待我处理 ${inboxCount} 件` : '待我处理'}</strong>
          <small>{inboxCount > 0 ? '审阅、采纳、审批都在这里一步办完' : '现在没有要你拍板的事'}</small>
        </div>
        <span className="m-inbox-entry-count">{inboxCount > 0 ? inboxCount : <RightOutlined />}</span>
      </button>
      {s && (
        <div className="m-stat-grid">
          <Stat icon={<DollarOutlined />} tone={1} label="今日销售" value={fmtMoney(s.todaySales)} />
          <Stat icon={<RiseOutlined />} tone={2} label="本月新客" value={s.monthLeads ?? 0} suffix="人" />
          <Stat icon={<ClockCircleOutlined />} tone={4} label="待跟进" value={s.pendingFollow ?? 0} suffix="人" />
          <Stat icon={<CalendarOutlined />} tone={3} label="进行活动" value={s.runningActivities ?? 0} suffix="场" />
        </div>
      )}
      {secondary.length > 0 && (
        <div className="m-stat-grid">
          {secondary.map(item => (
            <button
              key={item.key}
              type="button"
              className="m-row-button"
              aria-label={`进入${item.title}`}
              onClick={() => nav(mobilePath(item.key))}
            >
              <span className="m-stat-icon" data-tone={item.key === 'customers' ? 2 : 8}>
                {item.icon}
              </span>
              <span className="m-row-main">
                <span className="m-row-title">{item.title}</span>
                <span className="m-row-sub">{item.desc}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {workspaces.length > 0 && (
        <Card size="small" title={isTester ? '产品工作台' : '核心工作台'} className="m-card-plain">
          <div className="m-workspace-grid">
            {workspaces.map(item => (
              <button
                key={item.key}
                type="button"
                className="m-workspace-item"
                data-tone={item.tone}
                onClick={() => nav(isTester ? item.path : toMobilePath(item.path) || item.path)}
                aria-label={`进入${item.title}`}
              >
                <span className="m-workspace-item-head">
                  {item.icon}
                  <strong>{item.title}</strong>
                </span>
                <span className="m-workspace-item-desc">{item.description}</span>
              </button>
            ))}
          </div>
        </Card>
      )}
      {canViewManagementBriefing && (
        <Card size="small" title="今日经营简报" className="m-card-plain">
          {briefing.length ? (
            briefing.map((b, i) => (
              <div key={i} className="m-brief-line">
                • {typeof b === 'string' ? b : b.text}
              </div>
            ))
          ) : (
            <QueryStatus q={briefQ} emptyText="暂无简报" height={80} />
          )}
        </Card>
      )}
    </div>
  );
}
