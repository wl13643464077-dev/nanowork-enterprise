import type { ReactNode } from 'react';
import { Card } from 'antd';
import {
  AppstoreOutlined,
  BarChartOutlined,
  CalendarOutlined,
  ClockCircleOutlined,
  DollarOutlined,
  ExperimentOutlined,
  InboxOutlined,
  RightOutlined,
  RiseOutlined,
  TeamOutlined,
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
  const briefing = briefQ.data?.briefing || [];
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
