import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Drawer, Progress, Tag, Tour, message, type TourProps } from 'antd';
import {
  AppstoreOutlined,
  BarChartOutlined,
  CheckCircleFilled,
  CheckOutlined,
  CompassOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  PlayCircleOutlined,
  RocketOutlined,
  ScheduleOutlined,
  SettingOutlined,
  ShopOutlined,
  TeamOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';
import { api } from '../api/client';
import './RoleOnboarding.css';

type OnboardingTrack = 'owner' | 'manager' | 'partner' | 'staff' | 'admin';

type OnboardingTask = {
  id: string;
  title: string;
  description: string;
  path: string;
  module: string;
  icon: ReactNode;
  action: string;
};

type OnboardingState = {
  currentVersion?: number;
  completedVersion?: number;
  completedRole?: string | null;
  completedAt?: string | null;
  outcome?: 'completed' | 'dismissed' | null;
  complete?: boolean;
};

type Props = {
  user: any;
  modules: string[];
  navigate: (path: string) => void;
  manualOpenNonce?: number;
  compact?: boolean;
  suspended?: boolean;
};

const FALLBACK_VERSION = 1;

const TRACK_COPY: Record<
  OnboardingTrack,
  { tag: string; title: string; subtitle: string; flow: string[]; accent: string }
> = {
  owner: {
    tag: '老板上手路线',
    title: '用 3 分钟跑通第一轮经营闭环',
    subtitle: '先看经营事实，再把问题交给合适的数字员工，最后回到任务中心验收结果。',
    flow: ['看经营', '派活', '验收', '复盘'],
    accent: '经营决策',
  },
  manager: {
    tag: '管理层上手路线',
    title: '用 3 分钟跑通第一轮协同闭环',
    subtitle: '先看团队异常和待办，再分派动作、跟进交付并完成经营复盘。',
    flow: ['看团队', '分任务', '跟交付', '做复盘'],
    accent: '团队协同',
  },
  admin: {
    tag: '管理员上手路线',
    title: '用 3 分钟完成企业运行检查',
    subtitle: '先看企业运行状态，再检查账号权限、知识配置和需要人工处理的系统事项。',
    flow: ['看状态', '管账号', '查配置', '保运行'],
    accent: '企业管理',
  },
  partner: {
    tag: '合作伙伴上手路线',
    title: '先看合作范围，再完成交付闭环',
    subtitle: '只处理已授权的合作事项，按任务要求提交结果，并持续跟进验收状态。',
    flow: ['看范围', '接任务', '交结果', '跟验收'],
    accent: '合作执行',
  },
  staff: {
    tag: '员工上手路线',
    title: '今天该做什么，一眼就能找到',
    subtitle: '先看自己的待办和数据，再调用数字员工协助，完成后提交结果等待验收。',
    flow: ['看待办', '补数据', '做任务', '交结果'],
    accent: '我的执行',
  },
};

function trackFor(role?: string): OnboardingTrack {
  if (role === 'boss') return 'owner';
  if (role === 'admin') return 'admin';
  if (role === 'partner') return 'partner';
  if (['ops_director', 'manager'].includes(String(role || ''))) return 'manager';
  return 'staff';
}

function tasksFor(track: OnboardingTrack): OnboardingTask[] {
  if (track === 'owner') {
    return [
      {
        id: 'owner-overview',
        title: '看懂经营全貌',
        description: '先看关键指标、异常和待办，决定今天最先处理哪件事。',
        path: '/',
        module: 'dashboard',
        icon: <ShopOutlined />,
        action: '打开驾驶舱',
      },
      {
        id: 'owner-dispatch',
        title: '认识餐饮数字员工',
        description: '按真实岗位找人，带上业务背景、真实材料、交付格式和期限再派活。',
        path: '/employees',
        module: 'marshals',
        icon: <AppstoreOutlined />,
        action: '去找数字员工',
      },
      {
        id: 'owner-review',
        title: '掌握任务验收',
        description: '在任务中心看运行进度、输入输出、失败原因和待人工验收结果。',
        path: '/tasks',
        module: 'execution',
        icon: <UnorderedListOutlined />,
        action: '打开任务中心',
      },
      {
        id: 'owner-analysis',
        title: '完成一次经营复盘',
        description: '从真实经营记录下钻到问题、原因和下一步动作。',
        path: '/analysis',
        module: 'analysis',
        icon: <BarChartOutlined />,
        action: '查看经营洞察',
      },
      {
        id: 'owner-setup',
        title: '补齐企业配置',
        description: '设置员工权限、企业知识和外部能力，让后续交付更贴合门店。',
        path: '/system',
        module: 'system',
        icon: <SettingOutlined />,
        action: '检查系统配置',
      },
    ];
  }

  if (track === 'admin') {
    return [
      {
        id: 'admin-overview',
        title: '查看企业运行状态',
        description: '先看当前企业的经营入口、异常提醒和需要管理人员处理的事项。',
        path: '/',
        module: 'dashboard',
        icon: <ShopOutlined />,
        action: '打开经营管理台',
      },
      {
        id: 'admin-users',
        title: '熟悉用户与权限管理',
        description: '进入管理后台维护账号、组织和角色权限，确保每个人只看到该看的内容。',
        path: '/admin',
        module: 'system',
        icon: <TeamOutlined />,
        action: '打开管理后台',
      },
      {
        id: 'admin-system',
        title: '检查企业系统配置',
        description: '核对知识库、审批、提示词和外部能力配置，保证业务链路可正常运行。',
        path: '/system',
        module: 'system',
        icon: <SettingOutlined />,
        action: '检查系统管理',
      },
    ];
  }

  if (track === 'partner') {
    return [
      {
        id: 'partner-overview',
        title: '确认合作工作台',
        description: '先确认当前企业、合作身份和已授权入口，不处理范围外数据。',
        path: '/',
        module: 'dashboard',
        icon: <CompassOutlined />,
        action: '打开合伙人工作台',
      },
      {
        id: 'partner-execution',
        title: '处理合作任务',
        description: '阅读负责人、截止时间和验收标准，完成后提交具体结果与证明。',
        path: '/execution',
        module: 'execution',
        icon: <ScheduleOutlined />,
        action: '打开合作任务',
      },
      {
        id: 'partner-review',
        title: '跟进运行与验收',
        description: '查看授权任务的输入输出、失败原因和验收状态，按反馈补充材料。',
        path: '/tasks',
        module: 'execution',
        icon: <UnorderedListOutlined />,
        action: '查看任务结果',
      },
    ];
  }

  if (track === 'manager') {
    return [
      {
        id: 'manager-overview',
        title: '查看经营协同台',
        description: '先看团队范围内的经营异常、今日待办和关键变化。',
        path: '/',
        module: 'dashboard',
        icon: <TeamOutlined />,
        action: '打开协同台',
      },
      {
        id: 'manager-store',
        title: '熟悉门店日常',
        description: '查看巡店、交接和日常经营动作，知道数据从哪里回到驾驶舱。',
        path: '/store-ops',
        module: 'dashboard',
        icon: <DatabaseOutlined />,
        action: '查看门店日常',
      },
      {
        id: 'manager-dispatch',
        title: '把问题交给数字员工',
        description: '按岗位匹配能力，提交真实材料并跟进数字员工的交付。',
        path: '/employees',
        module: 'marshals',
        icon: <AppstoreOutlined />,
        action: '去派活',
      },
      {
        id: 'manager-execution',
        title: '跟进团队执行',
        description: '查看待执行、进行中和待验收任务，及时处理卡点。',
        path: '/execution',
        module: 'execution',
        icon: <ScheduleOutlined />,
        action: '打开执行看板',
      },
      {
        id: 'manager-analysis',
        title: '复盘经营结果',
        description: '把数据变化穿刺到问题、责任动作和下一轮安排。',
        path: '/analysis',
        module: 'analysis',
        icon: <BarChartOutlined />,
        action: '开始复盘',
      },
    ];
  }

  return [
    {
      id: 'staff-home',
      title: '先看我的工作台',
      description: '确认今天自己的待办、客户、数据和已经开通的工作入口。',
      path: '/',
      module: 'dashboard',
      icon: <CompassOutlined />,
      action: '打开我的工作台',
    },
    {
      id: 'staff-task',
      title: '处理我的任务',
      description: '接单、执行、提交结果，并随时查看老板或管理层的验收状态。',
      path: '/execution',
      module: 'execution',
      icon: <ScheduleOutlined />,
      action: '查看我的任务',
    },
    {
      id: 'staff-customer',
      title: '跟进我的客户',
      description: '只看本人授权客户，记录沟通结果和明确的下一步动作。',
      path: '/growth',
      module: 'growth',
      icon: <TeamOutlined />,
      action: '查看我的客户',
    },
    {
      id: 'staff-assistant',
      title: '请数字员工协助',
      description: '遇到不会做的事，按岗位找到数字员工并说明真实工作要求。',
      path: '/employees',
      module: 'marshals',
      icon: <AppstoreOutlined />,
      action: '找数字员工',
    },
    {
      id: 'staff-content',
      title: '完成内容工作',
      description: '进入内容生产仓处理本人可见的生成、审阅和发布协作。',
      path: '/content',
      module: 'content',
      icon: <ExperimentOutlined />,
      action: '进入内容生产仓',
    },
  ];
}

function safeReadIds(key: string) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式下本地缓存不可写，服务端完成态仍可正常使用 */
  }
}

function safeGet(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 本地缓存不可写时无需额外处理 */
  }
}

const target = (selector: string) => () => document.querySelector<HTMLElement>(selector);

export default function RoleOnboarding({
  user,
  modules,
  navigate,
  manualOpenNonce = 0,
  compact = false,
  suspended = false,
}: Props) {
  const track = trackFor(user?.role);
  const copy = TRACK_COPY[track];
  const availableModules = useMemo(() => new Set(modules), [modules]);
  const tasks = useMemo(() => {
    const filtered = tasksFor(track).filter(task => availableModules.has(task.module));
    if (filtered.length) return filtered;
    const firstAvailable = [
      { module: 'advisor', path: '/advisor', title: '打开我的工作参谋' },
      { module: 'assets', path: '/assets', title: '查看企业知识资产' },
      { module: 'activities', path: '/activities', title: '查看营销活动' },
      { module: 'content', path: '/content', title: '进入内容生产仓' },
      { module: 'growth', path: '/growth', title: '进入会员增长' },
      { module: 'execution', path: '/execution', title: '打开任务看板' },
      { module: 'system', path: '/system', title: '查看系统管理' },
      { module: 'dashboard', path: '/', title: '打开我的工作台' },
      { module: 'marshals', path: '/employees', title: '认识餐饮数字员工' },
      { module: 'analysis', path: '/analysis', title: '查看经营洞察' },
    ].find(item => availableModules.has(item.module));
    if (!firstAvailable) return [];
    return [
      {
        id: `${track}-first-entry-${firstAvailable.module}`,
        title: firstAvailable.title,
        description: '先认识当前账号已经开通的工作入口，再从这里开始第一项真实工作。',
        path: firstAvailable.path,
        module: firstAvailable.module,
        icon: <CompassOutlined />,
        action: '打开工作入口',
      },
    ];
  }, [availableModules, track]);
  const [currentVersion, setCurrentVersion] = useState(FALLBACK_VERSION);
  const progressKey = useMemo(
    () =>
      `nanowork_role_onboarding_progress_v${currentVersion}:${user?.tenant?.id || 0}:${user?.id || 0}:${user?.role || 'staff'}`,
    [currentVersion, user?.id, user?.role, user?.tenant?.id],
  );
  const seenKey = useMemo(
    () =>
      `nanowork_role_onboarding_seen_v${currentVersion}:${user?.tenant?.id || 0}:${user?.id || 0}:${user?.role || 'staff'}`,
    [currentVersion, user?.id, user?.role, user?.tenant?.id],
  );
  const pendingKey = useMemo(
    () =>
      `nanowork_role_onboarding_pending_v${currentVersion}:${user?.tenant?.id || 0}:${user?.id || 0}:${user?.role || 'staff'}`,
    [currentVersion, user?.id, user?.role, user?.tenant?.id],
  );
  const [completedIds, setCompletedIds] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [serverComplete, setServerComplete] = useState(false);
  const [terminalOutcome, setTerminalOutcome] = useState<OnboardingState['outcome']>(null);
  const [pendingOutcome, setPendingOutcome] = useState<OnboardingState['outcome']>(null);
  const [replayMode, setReplayMode] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [narrowViewport, setNarrowViewport] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches,
  );
  const previousManualNonce = useRef(manualOpenNonce);
  const loadGeneration = useRef(0);
  const suspendedRef = useRef(suspended);
  const isCompact = compact || narrowViewport;

  useEffect(() => {
    suspendedRef.current = suspended;
    if (!suspended) return;
    const timer = window.setTimeout(() => {
      setDrawerOpen(false);
      setTourOpen(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [suspended]);

  useEffect(() => {
    const timer = window.setTimeout(() => setCompletedIds(safeReadIds(progressKey)), 0);
    return () => window.clearTimeout(timer);
  }, [progressKey]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 820px)');
    const onChange = (event: MediaQueryListEvent) => setNarrowViewport(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    let active = true;
    let timer = 0;
    api
      .get('/meta/onboarding', { silent: true })
      .then((raw: OnboardingState | { onboarding?: OnboardingState }) => {
        if (!active || generation !== loadGeneration.current) return;
        const state = 'onboarding' in raw && raw.onboarding ? raw.onboarding : (raw as OnboardingState);
        const version = Number(state.currentVersion) || FALLBACK_VERSION;
        if (version !== currentVersion) {
          setCurrentVersion(version);
          return;
        }
        const localPending = safeGet(pendingKey);
        const validPending = localPending === 'completed' || localPending === 'dismissed' ? localPending : null;
        if (state.complete) {
          setServerComplete(true);
          setTerminalOutcome(state.outcome || null);
          setPendingOutcome(null);
          setReplayMode(false);
          safeRemove(pendingKey);
          safeSet(seenKey, state.outcome || 'completed');
          if (state.outcome === 'completed') {
            const allTaskIds = tasks.map(task => task.id);
            setCompletedIds(allTaskIds);
            safeSet(progressKey, JSON.stringify(allTaskIds));
          }
        } else if (validPending) {
          // 服务端恢复前尊重用户刚刚的完成/跳过选择，并由下方重试 effect 补传。
          setServerComplete(true);
          setTerminalOutcome(validPending);
          setPendingOutcome(validPending);
          if (validPending === 'completed') {
            const allTaskIds = tasks.map(task => task.id);
            setCompletedIds(allTaskIds);
            safeSet(progressKey, JSON.stringify(allTaskIds));
          }
        } else {
          setServerComplete(false);
          setTerminalOutcome(null);
          setPendingOutcome(null);
          setReplayMode(false);
          timer = window.setTimeout(() => {
            if (!suspendedRef.current) setDrawerOpen(true);
          }, 650);
        }
        setReady(true);
      })
      .catch(() => {
        if (!active || generation !== loadGeneration.current) return;
        const localPending = safeGet(pendingKey);
        const locallySeen = localPending || safeGet(seenKey);
        const validOutcome = locallySeen === 'completed' || locallySeen === 'dismissed' ? locallySeen : null;
        setServerComplete(Boolean(locallySeen));
        setTerminalOutcome(validOutcome);
        setPendingOutcome(localPending === 'completed' || localPending === 'dismissed' ? localPending : null);
        if (validOutcome === 'completed') {
          const allTaskIds = tasks.map(task => task.id);
          setCompletedIds(allTaskIds);
          safeSet(progressKey, JSON.stringify(allTaskIds));
        }
        setReady(true);
        if (!locallySeen)
          timer = window.setTimeout(() => {
            if (!suspendedRef.current) setDrawerOpen(true);
          }, 650);
      });
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [currentVersion, pendingKey, progressKey, seenKey, tasks, user?.id, user?.role, user?.tenant?.id]);

  useEffect(() => {
    if (pendingOutcome !== 'completed' && pendingOutcome !== 'dismissed') return;
    let active = true;
    let retryTimer = 0;
    const sync = async () => {
      try {
        await api.put('/meta/onboarding', { outcome: pendingOutcome }, { silent: true });
        if (!active) return;
        safeRemove(pendingKey);
        setPendingOutcome(null);
      } catch {
        if (active) retryTimer = window.setTimeout(sync, 15_000);
      }
    };
    const onOnline = () => {
      window.clearTimeout(retryTimer);
      void sync();
    };
    retryTimer = window.setTimeout(sync, 15_000);
    window.addEventListener('online', onOnline);
    return () => {
      active = false;
      window.clearTimeout(retryTimer);
      window.removeEventListener('online', onOnline);
    };
  }, [pendingKey, pendingOutcome]);

  useEffect(() => {
    if (manualOpenNonce !== previousManualNonce.current) {
      previousManualNonce.current = manualOpenNonce;
      setTourOpen(false);
      setDrawerOpen(true);
    }
  }, [manualOpenNonce]);

  const done = tasks.filter(task => completedIds.includes(task.id)).length;
  const progress = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

  const markOutcome = async (outcome: 'completed' | 'dismissed') => {
    // 立即使此前发出的 GET 失效，避免旧未完成态晚到后覆盖本次操作。
    loadGeneration.current += 1;
    setServerComplete(true);
    setTerminalOutcome(outcome);
    setPendingOutcome(outcome);
    setReplayMode(false);
    setDrawerOpen(false);
    setTourOpen(false);
    safeSet(seenKey, outcome);
    safeSet(pendingKey, outcome);
    if (outcome === 'completed') {
      const allTaskIds = tasks.map(task => task.id);
      setCompletedIds(allTaskIds);
      safeSet(progressKey, JSON.stringify(allTaskIds));
    }
    try {
      await api.put('/meta/onboarding', { outcome }, { silent: true });
      safeRemove(pendingKey);
      setPendingOutcome(null);
      if (outcome === 'completed') message.success('上手完成，接下来直接开始工作吧');
    } catch {
      message.warning('本机已记住，本次上手状态将在服务恢复后重新同步');
    }
  };

  const openTask = (task: OnboardingTask) => {
    const next = completedIds.includes(task.id) ? completedIds : [...completedIds, task.id];
    setCompletedIds(next);
    safeSet(progressKey, JSON.stringify(next));
    setDrawerOpen(false);
    navigate(task.path);
    if (tasks.length > 0 && tasks.every(item => next.includes(item.id))) void markOutcome('completed');
  };

  const resetTasks = () => {
    setCompletedIds([]);
    safeSet(progressKey, '[]');
    setReplayMode(true);
  };

  const desktopSteps: TourProps['steps'] = [
    {
      title: copy.tag,
      description: `${copy.title}。这次只认识最常用的入口，不会替你提交任何业务动作。`,
      placement: 'center',
    },
    {
      title: '左边按一天的工作顺序排好了',
      description: '从“看经营”到“派活干活、做内容、配置”，系统只展示当前账号有权限使用的入口。',
      target: target('[data-onboarding="navigation"]'),
      placement: 'right',
    },
    {
      title: '这里就是当前工作的主区域',
      description: `${copy.accent}相关的数据、输入、输出和下一步动作都会在这里完成。`,
      target: target('[data-onboarding="workspace"]'),
      placement: 'top',
    },
    {
      title: '找功能不用翻菜单',
      description: '搜索模块或按 ⌘K / Ctrl K，可快速跳到客户、内容和常用功能。',
      target: target('[data-onboarding="search"]'),
      placement: 'bottom',
    },
    ...(availableModules.has('advisor')
      ? [
          {
            title: track === 'staff' ? '不会做时先问工作助手' : '需要判断时先问经营助手',
            description: '它会结合当前经营记录给出分析和行动建议；涉及外发、价格和收益时仍由真人确认。',
            target: target('[data-onboarding="assistant"]'),
            placement: 'bottom' as const,
          },
        ]
      : []),
    {
      title: '忘了随时回来',
      description: '帮助中心会永久保留“角色上手清单”，关闭后也能重新打开。',
      target: target('[data-onboarding="help"]'),
      placement: 'bottom',
    },
  ];

  const mobileSteps: TourProps['steps'] = [
    {
      title: copy.tag,
      description: `${copy.title}。手机版只保留高频入口，完整能力可随时切回电脑版。`,
      placement: 'center',
    },
    {
      title: '手机上先处理最要紧的事',
      description: '首页会根据角色展示经营数据、数字员工、任务和已经开通的核心工作台。',
      target: target('[data-onboarding="workspace"]'),
      placement: 'bottom',
    },
    {
      title: '底部切换高频工作',
      description: '首页、客户、内容和“我的”会按你的权限自动出现，不会看到无权入口。',
      target: target('[data-onboarding="navigation"]'),
      placement: 'top',
    },
    {
      title: '需要时重新打开',
      description: '点右上角问号，可随时回到这份角色上手清单。',
      target: target('[data-onboarding="help"]'),
      placement: 'bottom',
    },
  ];

  const responsiveSteps: TourProps['steps'] = [
    {
      title: copy.tag,
      description: `${copy.title}。当前屏幕较窄，系统已经把导航收成横向任务栏，功能和电脑版一致。`,
      placement: 'center',
    },
    {
      title: '上方横向切换工作',
      description: '从看经营到派活、内容和配置，左右滑动即可找到当前账号有权限使用的入口。',
      target: target('[data-onboarding="navigation"]'),
      placement: 'bottom',
    },
    {
      title: '这里处理当前工作',
      description: `${copy.accent}相关的数据、输入、输出和下一步动作都会在主区域完成。`,
      target: target('[data-onboarding="workspace"]'),
      placement: 'top',
    },
    {
      title: '忘了随时回来',
      description: '右上角问号会永久保留“角色上手清单”，关闭后也能重新打开。',
      target: target('[data-onboarding="help"]'),
      placement: 'bottom',
    },
  ];

  return (
    <>
      {ready && !suspended && (!serverComplete || replayMode) && !drawerOpen && !tourOpen && (
        <button
          type="button"
          className={`role-onboarding-fab ${isCompact ? 'is-compact' : ''} ${compact ? 'is-mobile-surface' : ''}`}
          onClick={() => setDrawerOpen(true)}
        >
          <span className="role-onboarding-fab-count">
            {done}/{tasks.length}
          </span>
          <span>
            <strong>快速上手</strong>
            <small>{done ? `还剩 ${Math.max(0, tasks.length - done)} 步` : '从第一步开始'}</small>
          </span>
          <RocketOutlined />
        </button>
      )}

      <Drawer
        className="role-onboarding-drawer"
        rootClassName={`role-onboarding-drawer-root ${compact ? 'is-mobile-surface' : ''}`}
        width={isCompact ? undefined : 476}
        height={isCompact ? '88%' : undefined}
        placement={isCompact ? 'bottom' : 'right'}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={
          <span className="role-onboarding-drawer-title">
            <RocketOutlined /> 角色上手清单
          </span>
        }
      >
        <section className="role-onboarding-hero" aria-labelledby="role-onboarding-title">
          <Tag color="blue">{copy.tag}</Tag>
          <h2 id="role-onboarding-title">
            {user?.name ? `${user.name}，` : ''}
            {copy.title}
          </h2>
          <p>{copy.subtitle}</p>
          <div className="role-onboarding-flow" aria-label={copy.flow.join('到')}>
            {copy.flow.map((item, index) => (
              <span key={item}>
                <b>{index + 1}</b>
                {item}
              </span>
            ))}
          </div>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={() => {
              setDrawerOpen(false);
              setTourOpen(true);
            }}
          >
            先用 60 秒认识界面
          </Button>
        </section>

        <section className="role-onboarding-checklist" aria-labelledby="role-onboarding-checklist-title">
          <div className="role-onboarding-progress-head">
            <div>
              <span>第一轮真实上手</span>
              <strong id="role-onboarding-checklist-title">按顺序打开常用工作入口</strong>
            </div>
            <b>
              {done}/{tasks.length}
            </b>
          </div>
          <Progress percent={progress} showInfo={false} strokeColor="var(--ui-primary)" />
          <div className="role-onboarding-task-list">
            {tasks.map((task, index) => {
              const completed = completedIds.includes(task.id);
              return (
                <button
                  type="button"
                  className={`role-onboarding-task ${completed ? 'is-complete' : ''}`}
                  key={task.id}
                  onClick={() => openTask(task)}
                >
                  <span className="role-onboarding-task-index">{completed ? <CheckOutlined /> : index + 1}</span>
                  <span className="role-onboarding-task-icon">{task.icon}</span>
                  <span className="role-onboarding-task-copy">
                    <strong>{task.title}</strong>
                    <small>{task.description}</small>
                    <em>{completed ? '已了解，可再次打开' : task.action} →</em>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {serverComplete && terminalOutcome === 'completed' && !replayMode && (
          <div className="role-onboarding-complete">
            <CheckCircleFilled />
            <span>
              <strong>这条上手路线已经完成</strong>
              <small>你可以继续回看，也可以在本次使用中重新浏览全部入口。</small>
            </span>
          </div>
        )}

        <div className="role-onboarding-actions">
          {done > 0 && (
            <Button type="text" onClick={resetTasks}>
              本次重新浏览
            </Button>
          )}
          <Button onClick={() => (serverComplete ? setDrawerOpen(false) : void markOutcome('dismissed'))}>
            {serverComplete ? '关闭' : '稍后再说'}
          </Button>
          <Button type="primary" onClick={() => void markOutcome('completed')}>
            我已经会用了
          </Button>
        </div>
        <p className="role-onboarding-note">这里只帮助认识入口，不会代替你提交、发布、审批或产生 AI 费用。</p>
      </Drawer>

      <Tour
        rootClassName="role-onboarding-tour"
        open={tourOpen}
        steps={compact ? mobileSteps : narrowViewport ? responsiveSteps : desktopSteps}
        type="primary"
        mask={{ color: 'rgba(7, 29, 54, 0.62)' }}
        onClose={() => setTourOpen(false)}
        onFinish={() => {
          setTourOpen(false);
          setDrawerOpen(true);
        }}
        indicatorsRender={(current, total) => `${current + 1} / ${total}`}
      />
    </>
  );
}
