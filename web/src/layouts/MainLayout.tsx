import { Suspense, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import {
  Menu,
  Input,
  Badge,
  Avatar,
  Dropdown,
  Popover,
  List,
  Empty,
  Tag,
  Tooltip,
  Drawer,
  Tabs,
  Button,
  Modal,
  Alert,
  message,
} from 'antd';
import {
  DashboardOutlined,
  RobotOutlined,
  RiseOutlined,
  CalendarOutlined,
  CheckSquareOutlined,
  CommentOutlined,
  ExperimentOutlined,
  ScheduleOutlined,
  UnorderedListOutlined,
  BarChartOutlined,
  GoldOutlined,
  SettingOutlined,
  ShopOutlined,
  BellOutlined,
  MailOutlined,
  QuestionCircleOutlined,
  LogoutOutlined,
  UserOutlined,
  ControlOutlined,
  WalletOutlined,
  MobileOutlined,
  SendOutlined,
  SwapOutlined,
  BgColorsOutlined,
  CheckOutlined,
  LinkOutlined,
  SyncOutlined,
  AppstoreOutlined,
  ToolOutlined,
  RocketOutlined,
  TeamOutlined,
  WarningOutlined,
  SearchOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, getUser, clearAuth } from '../api/client';
import { PageSkeleton } from '../components/Kit';
import CommandPalette, { rememberRecent } from '../components/CommandPalette';
import { RouteErrorBoundary } from '../components/AppErrorBoundary';
import './MainLayout.css';

// 左侧任务导航：用实体店老板能立即理解的语言描述，而不是技术模块名。
// group 字段把 13 个一级项按「老板一天里的动作顺序」聚成 4 组：
// 先看数据 → 再派活干活 → 产出内容 → 最后才是配置。
// 此前全部平铺，13 个同级项无任何层次，老板要逐个读完才能找到入口。
const MENUS = [
  { key: '/', icon: <DashboardOutlined />, label: '老板驾驶舱', mod: 'dashboard', group: 'watch' },
  { key: '/analysis', icon: <BarChartOutlined />, label: '经营洞察', mod: 'analysis', group: 'watch' },
  {
    key: '/store-data',
    icon: <ShopOutlined />,
    label: '门店数据',
    mod: 'analysis',
    managerOnly: true,
    group: 'watch',
  },
  { key: '/advisor', icon: <RobotOutlined />, label: '老板参谋', mod: 'advisor', group: 'work' },
  { key: '/employees', icon: <AppstoreOutlined />, label: '餐饮数字员工', mod: 'marshals', group: 'work' },
  { key: '/tasks', icon: <UnorderedListOutlined />, label: '任务中心', mod: 'execution', group: 'work' },
  { key: '/execution', icon: <ScheduleOutlined />, label: '经营执行', mod: 'execution', group: 'work' },
  { key: '/store-ops', icon: <CheckSquareOutlined />, label: '门店日常', mod: 'dashboard', group: 'work' },
  { key: '/reviews', icon: <CommentOutlined />, label: '评价中心', mod: 'dashboard', group: 'work' },
  { key: '/activities', icon: <CalendarOutlined />, label: '营销活动', mod: 'activities', group: 'work' },
  { key: '/growth', icon: <RiseOutlined />, label: '会员增长', mod: 'growth', group: 'work' },
  { key: '/content', icon: <ExperimentOutlined />, label: '内容生产仓', mod: 'content', group: 'make' },
  { key: '/toolbox', icon: <ToolOutlined />, label: '经营工具箱', mod: 'content', group: 'make' },
  { key: '/assets', icon: <GoldOutlined />, label: '知识资产', mod: 'assets', group: 'make' },
  { key: '/system', icon: <SettingOutlined />, label: '系统管理', mod: 'system', group: 'setup' },
  { key: '/recharge', icon: <WalletOutlined />, label: '充值中心', bossOnly: true, group: 'setup' },
];

const MENU_GROUPS: { key: string; label: string }[] = [
  { key: 'watch', label: '看经营' },
  { key: 'work', label: '派活干活' },
  { key: 'make', label: '做内容' },
  { key: 'setup', label: '配置' },
];

const ROLE_NAME: Record<string, string> = {
  boss: '老板',
  ops_director: '门店运营',
  manager: '管理层',
  sales: '一线员工',
  admin: '系统管理员',
  partner: '合作伙伴',
};
const THEME_KEY = 'nanowork_industry_theme_v1';
const NAV_COLLAPSED_KEY = 'nanowork_nav_collapsed_v1';
// 快捷键提示按平台显示（Mac 显示 ⌘K，其余显示 Ctrl K）
const isMacLike =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

const KEY_OF_PATH: Record<string, string> = {
  '/': 'dashboard',
  '/advisor': 'advisor',
  '/employees': 'marshals',
  '/marshals': 'marshals',
  '/toolbox': 'content',
  '/growth': 'growth',
  '/activities': 'activities',
  '/content': 'content',
  '/execution': 'execution',
  '/tasks': 'execution',
  '/store-ops': 'dashboard',
  '/reviews': 'dashboard',
  '/analysis': 'analysis',
  '/store-data': 'analysis',
  '/assets': 'assets',
  '/data-intake': 'system',
  '/system': 'system',
};

// 无障碍：给非 button 的可点击元素补键盘可达性（role/tabIndex/Enter/Space），不改布局结构
function pressable(fn: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: fn,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fn();
      }
    },
  };
}

function menusFor(modules: string[], role?: string) {
  return MENUS.filter((menu: any) => {
    if (menu.bossOnly && role !== 'boss') return false;
    if (menu.managerOnly && !['boss', 'ops_director', 'manager', 'admin'].includes(role || '')) return false;
    return !menu.mod || modules.includes(menu.mod);
  });
}

export default function MainLayout() {
  const nav = useNavigate();
  const loc = useLocation();
  const user = getUser();
  const dailyGuide =
    user?.role === 'boss'
      ? {
          title: '老板每日10分钟',
          body: '① 老板驾驶舱看 KPI 与异常 ② 点开指标穿刺到订单/会员 ③ 把下一步动作派给对应数字员工',
        }
      : user?.role === 'ops_director' || user?.role === 'manager'
        ? {
            title: '管理层每日协同',
            body: '① 经营协同台看团队待办与异常 ② 穿刺到客户、活动和任务 ③ 分派动作并跟进审核结果',
          }
        : user?.role === 'admin'
          ? {
              title: '管理员每日检查',
              body: '① 经营管理台核对企业运行状态 ② 检查权限、审批与任务积压 ③ 把业务决策交给对应负责人',
            }
          : {
              title: '我的每日执行',
              body: '① 我的工作台看待办 ② 进入任务完成工作 ③ 提交结果并跟进审核状态',
            };
  const [notifs, setNotifs] = useState<any[]>([]);
  const [credits, setCredits] = useState<number>(user?.credits ?? 0);
  const [modules, setModules] = useState<string[]>(user?.modules || Object.values(KEY_OF_PATH));
  const canUseAdvisor = modules.includes('advisor');
  const assistantCopy =
    user?.role === 'boss'
      ? { title: '老板经营助手', entry: '问老板参谋', todo: '老板待办', short: '经营助手' }
      : user?.role === 'ops_director' || user?.role === 'manager'
        ? { title: '经营协同助手', entry: '问经营参谋', todo: '管理层待办', short: '协同助手' }
        : user?.role === 'admin'
          ? { title: '经营管理助手', entry: '问经营参谋', todo: '管理待办', short: '管理助手' }
          : { title: '我的工作助手', entry: '问工作参谋', todo: '我的待办', short: '工作助手' };
  const assistantSuggestion = modules.includes('analysis')
    ? { path: '/analysis', label: '查看经营穿刺 →' }
    : modules.includes('execution')
      ? { path: '/execution', label: '查看我的任务 →' }
      : { path: '/advisor', label: '进入完整参谋 →' };
  const [aiOpen, setAiOpen] = useState(false);
  const [ask, setAsk] = useState('');
  const [uiTheme, setUiTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'nano');
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return localStorage.getItem(NAV_COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const changeAppearance = (key: string) => {
    if (['nano', 'midnight'].includes(key)) {
      localStorage.setItem(THEME_KEY, key);
      setUiTheme(key);
      window.dispatchEvent(new CustomEvent('nanowork-theme-change', { detail: { theme: key } }));
    }
  };
  const visibleMenus = menusFor(modules, user?.role);
  const current = MENUS.find(m => m.key === loc.pathname) || visibleMenus[0] || MENUS[0];
  const currentGroup = MENU_GROUPS.find(group => group.key === current.group)?.label || '经营工作台';
  const menuLabel = (m: any) => {
    if (m.mod === 'advisor') {
      if (user?.role === 'boss') return '老板参谋';
      if (user?.role === 'ops_director' || user?.role === 'manager' || user?.role === 'admin') return '经营参谋';
      return '我的工作参谋';
    }
    // 角色化改名只针对首页（/）：门店日常、评价中心等同挂 dashboard 模块的
    // 菜单项必须保留各自名称，否则侧栏会出现多个“老板驾驶舱”。
    if (m.mod !== 'dashboard' || m.key !== '/') return m.label;
    if (user?.role === 'sales') return '我的工作台';
    if (user?.role === 'partner') return '合伙人工作台';
    if (user?.role === 'ops_director' || user?.role === 'manager') return '经营协同台';
    if (user?.role === 'admin') return '经营管理台';
    if (user?.role === 'boss') return '老板驾驶舱';
    return '我的工作台';
  };
  // 分组渲染：只保留有可见项的组，避免权限受限用户看到空标题
  const menuItems = useMemo(
    () =>
      MENU_GROUPS.map(g => {
        const children = visibleMenus
          .filter(m => m.group === g.key)
          .map(m => ({ key: m.key, icon: m.icon, label: menuLabel(m) }));
        return children.length ? { key: `grp-${g.key}`, type: 'group' as const, label: g.label, children } : null;
      }).filter(Boolean),
    // menuLabel 只依赖 user.role，随 visibleMenus 一起变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleMenus, user?.role],
  );
  // 命令面板的导航项：与侧栏同源同权限，带分组名做为副标题
  const paletteNavItems = useMemo(
    () =>
      visibleMenus.map(m => ({
        key: m.key,
        label: menuLabel(m),
        group: MENU_GROUPS.find(g => g.key === m.group)?.label,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleMenus, user?.role],
  );

  // 全局 ⌘K / Ctrl+K：在输入框里也生效（用户可能正在填表时想跳走）
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const platformModifier = isMacLike ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (platformModifier && !e.altKey && !e.shiftKey && !e.repeat && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdkOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(NAV_COLLAPSED_KEY, String(navCollapsed));
    } catch {
      /* 隐私模式下 localStorage 不可写，不影响本次会话使用 */
    }
  }, [navCollapsed]);

  // 记录最近访问，供命令面板在空查询时优先展示
  useEffect(() => {
    const hit = MENUS.find(m => m.key === loc.pathname);
    if (hit) rememberRecent(hit.key, menuLabel(hit));
    // menuLabel 仅依赖 user.role
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname, user?.role]);

  useEffect(() => {
    api
      .get('/sys/notifications')
      .then(setNotifs)
      .catch(() => {});
    // 60s 轮询：带可见性门控（后台标签页不发请求）；依赖为空数组，切页不再重建定时器
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible')
        api
          .get('/sys/notifications')
          .then(setNotifs)
          .catch(() => {});
    }, 60000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    api
      .get('/auth/me')
      .then(me => {
        setCredits(me.credits ?? 0);
        if (me.modules?.length) setModules(me.modules);
      })
      .catch(() => {});
    const onCredits = (e: any) => setCredits(current => e.detail?.balance ?? current);
    window.addEventListener('credits-updated', onCredits);
    return () => window.removeEventListener('credits-updated', onCredits);
  }, []);
  useEffect(() => {
    const need = KEY_OF_PATH[loc.pathname];
    if (need && modules.length && !modules.includes(need)) {
      const first = menusFor(modules, user?.role)[0]?.key || '/';
      if (loc.pathname !== first) nav(first, { replace: true });
    }
  }, [loc.pathname, modules, nav, user?.role]);
  const unread = notifs.filter(n => !n.read).length;

  const NOTIF_LINK: Record<string, { link: string; name: string }> = {
    approval: { link: '/system?tab=approvals', name: '审批中心' },
    lead: { link: '/growth', name: '会员增长' },
    follow: { link: '/growth', name: '会员增长' },
    partner: { link: '/execution', name: '经营执行' },
    marshal: { link: '/employees', name: '餐饮数字员工' },
    activity: { link: '/activities', name: '营销活动' },
    task: { link: '/tasks', name: '任务中心' },
  };
  const notificationTarget = (notification: any) => {
    const fallback = NOTIF_LINK[notification?.type];
    const explicit =
      typeof notification?.link === 'string' &&
      notification.link.length <= 1000 &&
      /^\/(?!\/)[^\\\r\n]*$/u.test(notification.link)
        ? notification.link
        : '';
    if (explicit) return { link: explicit, name: fallback?.name || '查看详情' };
    return fallback;
  };
  const reloadNotifs = (size = 20) =>
    api
      .get(`/sys/notifications?size=${size}`)
      .then(setNotifs)
      .catch(() => {});
  const openNotif = (n: any) => {
    if (!n.read)
      api
        .post(`/sys/notifications/${n.id}/read`)
        .then(() => reloadNotifs(mailOpen ? 100 : 20))
        .catch(() => {});
    const t = notificationTarget(n);
    if (t) {
      setMailOpen(false);
      nav(t.link);
    }
  };
  const [mailOpen, setMailOpen] = useState(false);
  const [mailTab, setMailTab] = useState('all');
  const [helpOpen, setHelpOpen] = useState(false);
  const [personalFeishuOpen, setPersonalFeishuOpen] = useState(false);
  const [personalFeishu, setPersonalFeishu] = useState<any>(null);
  const [personalFeishuBind, setPersonalFeishuBind] = useState<any>(null);
  const [personalFeishuStatus, setPersonalFeishuStatus] = useState('idle');
  const [personalFeishuLoading, setPersonalFeishuLoading] = useState(false);
  const startPersonalFeishuBinding = () => {
    setPersonalFeishuLoading(true);
    setPersonalFeishuStatus('pending');
    setPersonalFeishuBind(null);
    api
      .post('/sys/feishu/oauth/start', { baseUrl: window.location.origin })
      .then((data: any) => setPersonalFeishuBind(data))
      .catch(() => setPersonalFeishuStatus('error'))
      .finally(() => setPersonalFeishuLoading(false));
  };
  const openPersonalFeishuBinding = () => {
    setPersonalFeishuOpen(true);
    setPersonalFeishuLoading(true);
    api
      .get('/sys/feishu/me')
      .then((data: any) => {
        setPersonalFeishu(data);
        if (data.appReady && !data.bound) startPersonalFeishuBinding();
      })
      .finally(() => setPersonalFeishuLoading(false));
  };
  useEffect(() => {
    if (!personalFeishuOpen || !personalFeishuBind?.state || personalFeishuStatus !== 'pending') return;
    // 指数退避轮询（1.8s→3s→5s→8s，5 分钟封顶停止），替代固定 1.8s 无上限轮询
    const DELAYS = [1800, 3000, 5000, 8000];
    const startedAt = Date.now();
    let attempt = 0;
    let timer = 0;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      if (Date.now() - startedAt > 5 * 60 * 1000) {
        setPersonalFeishuStatus('expired');
        return;
      }
      api
        .get(`/sys/feishu/oauth/status?state=${encodeURIComponent(personalFeishuBind.state)}`)
        .then((data: any) => {
          if (data.status === 'bound') {
            setPersonalFeishuStatus('bound');
            setPersonalFeishuBind(null);
            api
              .get('/sys/feishu/me')
              .then(setPersonalFeishu)
              .catch(() => {});
            message.success(`飞书已绑定${data.receiverName ? `：${data.receiverName}` : ''}`);
            return;
          }
          if (['expired', 'error', 'missing'].includes(data.status)) {
            setPersonalFeishuStatus(data.status);
            return;
          }
          attempt += 1;
          timer = window.setTimeout(tick, DELAYS[Math.min(attempt, DELAYS.length - 1)]);
        })
        .catch(() => {
          timer = window.setTimeout(tick, DELAYS[DELAYS.length - 1]);
        });
    };
    timer = window.setTimeout(tick, DELAYS[0]);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [personalFeishuOpen, personalFeishuBind?.state, personalFeishuStatus]);
  const mailNotifs =
    mailTab === 'all'
      ? notifs
      : notifs.filter(n =>
          mailTab === 'approval'
            ? n.type === 'approval'
            : mailTab === 'customer'
              ? ['lead', 'follow'].includes(n.type)
              : mailTab === 'work'
                ? ['task', 'marshal', 'partner', 'activity'].includes(n.type)
                : true,
        );

  const todos = notifs.filter(n => ['approval', 'task'].includes(n.type));
  const askBrain = () => {
    nav('/advisor', { state: { q: ask.trim() } });
    setAsk('');
    setAiOpen(false);
  };

  const Logo = <img className="os-brand-mark" src="/brand/nanowork-icon.svg" alt="纳米Work" />;

  return (
    <div className="os-shell">
      {/* 顶部：企业状态栏 */}
      <header className="os-top">
        <div className="os-brand">
          {Logo}
          <span className="os-brand-name">
            纳米Work<span>行业版</span>
          </span>
          <span className="os-brand-sub">实体门店智能经营工作台</span>
          <span className="os-brand-div">｜</span>
          <span className="os-brand-tenant">当前门店：{user?.tenant?.name || '当前企业'}</span>
        </div>
        {/* 原为三条永不变化的静态文案（数据口径/岗位档案/任务产出），占着顶栏黄金位置却不可点。
            换成命令面板入口：同样的位置，变成真正能用的全局搜索与快捷动作。 */}
        <div className="os-status">
          <button
            type="button"
            className="os-cmdk-trigger"
            aria-label={`打开全局搜索与命令面板（${isMacLike ? '⌘K' : 'Ctrl+K'}）`}
            aria-keyshortcuts={isMacLike ? 'Meta+K' : 'Control+K'}
            onClick={() => setCmdkOpen(true)}
          >
            <SearchOutlined />
            <span className="os-cmdk-label">搜模块、客户、内容…</span>
            <kbd className="os-cmdk-kbd">{isMacLike ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
        </div>
        <div className="os-top-actions">
          <Dropdown
            trigger={['click']}
            menu={{
              onClick: ({ key }) => changeAppearance(key),
              items: [
                {
                  key: 'nano',
                  label: (
                    <span>
                      <i
                        style={{
                          display: 'inline-block',
                          width: 10,
                          height: 10,
                          borderRadius: 2,
                          background: '#fff',
                          border: '1px solid #b9c9dc',
                          marginRight: 8,
                        }}
                      />
                      纳米明亮 {uiTheme === 'nano' && <CheckOutlined />}
                    </span>
                  ),
                },
                {
                  key: 'midnight',
                  label: (
                    <span>
                      <i
                        style={{
                          display: 'inline-block',
                          width: 10,
                          height: 10,
                          borderRadius: 2,
                          background: '#071d36',
                          border: '1px solid #4d79a9',
                          marginRight: 8,
                        }}
                      />
                      深海夜间 {uiTheme === 'midnight' && <CheckOutlined />}
                    </span>
                  ),
                },
              ],
            }}
          >
            <Tooltip title="界面主题">
              <BgColorsOutlined className="os-ic" />
            </Tooltip>
          </Dropdown>
          <Tooltip
            title={user?.role === 'boss' ? '企业积分余额 · 点击进入充值中心' : '企业积分余额 · 充值由老板统一管理'}
          >
            <span
              className="os-credit"
              aria-label={user?.role === 'boss' ? '企业积分余额，点击进入充值中心' : '企业积分余额'}
              {...(user?.role === 'boss' ? pressable(() => nav('/recharge')) : {})}
            >
              ◆ {Number(credits).toLocaleString()} 积分
            </span>
          </Tooltip>
          {canUseAdvisor && (
            <Tooltip title={assistantCopy.entry}>
              <button
                type="button"
                className="os-ask-brain"
                aria-label={`打开${assistantCopy.title}`}
                aria-expanded={aiOpen}
                aria-controls="boss-assistant-inspector"
                onClick={() => setAiOpen(true)}
              >
                <RobotOutlined />
                <span className="os-ask-brain-label">{assistantCopy.short}</span>
              </button>
            </Tooltip>
          )}
          <Tooltip title="手机版（H5）">
            <button type="button" className="os-icon-btn" aria-label="打开手机版（H5）" onClick={() => nav('/m')}>
              <MobileOutlined className="os-ic" />
            </button>
          </Tooltip>
          {['boss', 'admin'].includes(user?.role) && (
            <Tooltip title="管理后台">
              <button
                type="button"
                className="os-icon-btn"
                aria-label="打开管理后台"
                onClick={() => (location.href = '/admin')}
              >
                <ControlOutlined className="os-ic" />
              </button>
            </Tooltip>
          )}
          <Popover
            trigger="click"
            placement="bottomRight"
            content={
              <div style={{ width: 320 }}>
                <List
                  size="small"
                  dataSource={notifs.slice(0, 8)}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无通知" /> }}
                  renderItem={(n: any) => (
                    <List.Item onClick={() => openNotif(n)} style={{ cursor: 'pointer' }}>
                      <div style={{ width: '100%' }}>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: n.read ? 400 : 600,
                            display: 'flex',
                            justifyContent: 'space-between',
                            gap: 8,
                          }}
                        >
                          <span>
                            {!n.read && <Badge status="processing" />} {n.title}
                          </span>
                          {notificationTarget(n) && (
                            <Tag color="blue" style={{ fontSize: 10, marginInlineEnd: 0 }}>
                              {notificationTarget(n)?.name} ›
                            </Tag>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: '#9aa4b5' }}>{n.body}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--ui-muted)' }}>
                          {(n.created_at || '').slice(5, 16)}
                        </div>
                      </div>
                    </List.Item>
                  )}
                />
                {notifs.length > 0 && (
                  <button
                    type="button"
                    className="ui-link-button"
                    style={{ fontSize: 12 }}
                    onClick={() =>
                      api.post('/sys/notifications/read').then(() => api.get('/sys/notifications').then(setNotifs))
                    }
                  >
                    全部标为已读
                  </button>
                )}
              </div>
            }
          >
            <Badge count={unread} size="small">
              <BellOutlined className="os-ic" />
            </Badge>
          </Popover>
          <Tooltip title="消息中心">
            <Badge count={unread} size="small">
              <button
                type="button"
                className="os-icon-btn"
                aria-label="打开消息中心"
                onClick={() => {
                  setMailOpen(true);
                  reloadNotifs(100);
                }}
              >
                <MailOutlined className="os-ic" />
              </button>
            </Badge>
          </Tooltip>
          <Tooltip title="帮助中心">
            <button type="button" className="os-icon-btn" aria-label="打开帮助中心" onClick={() => setHelpOpen(true)}>
              <QuestionCircleOutlined className="os-ic" />
            </button>
          </Tooltip>
          <Dropdown
            menu={{
              items: [
                {
                  key: 'switch',
                  icon: <SwapOutlined />,
                  label: `账号：${ROLE_NAME[user?.role] || user?.role}`,
                  disabled: true,
                },
                { key: 'feishu', icon: <LinkOutlined />, label: '绑定我的飞书' },
                { key: 'logout', icon: <LogoutOutlined />, label: '退出登录' },
              ],
              onClick: ({ key }) => {
                if (key === 'feishu') openPersonalFeishuBinding();
                if (key === 'logout') {
                  clearAuth();
                  nav('/login');
                }
              },
            }}
          >
            <div className="os-user">
              <Avatar size={30} style={{ background: 'var(--ui-primary)' }} icon={<UserOutlined />} />
              <span className="os-user-name">{user?.name}</span>
            </div>
          </Dropdown>
        </div>
      </header>

      <div className="os-mid">
        {/* 左侧：企业作战系统 */}
        <aside className={`os-left ${navCollapsed ? 'os-left--collapsed' : ''}`} aria-label="经营模块导航">
          <div className="os-left-head">
            <span className="os-left-title">门店经营中心</span>
            <Tooltip title={navCollapsed ? '展开导航' : '收起导航'} placement="right">
              <button
                type="button"
                className="os-nav-toggle"
                aria-label={navCollapsed ? '展开经营模块导航' : '收起经营模块导航'}
                aria-expanded={!navCollapsed}
                onClick={() => setNavCollapsed(value => !value)}
              >
                {navCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              </button>
            </Tooltip>
          </div>
          <Menu
            mode="inline"
            theme="dark"
            inlineCollapsed={navCollapsed}
            selectedKeys={[current.key]}
            items={menuItems}
            onClick={({ key }) => nav(key)}
          />
          <div className="os-culture">
            <div className="os-culture-line">进入千行百业，赋能每一个认真创业的老板</div>
          </div>
          <div className="os-me">
            <Avatar size={32} style={{ background: 'var(--ui-primary)' }} icon={<UserOutlined />} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="os-me-name">{user?.name}</div>
              <div className="os-me-sub">{ROLE_NAME[user?.role] || user?.role}</div>
            </div>
          </div>
        </aside>

        {/* 中间：企业经营大屏（内容页保持浅色清晰） */}
        <main className="os-center">
          <div className="os-page-head">
            <div className="os-page-heading">
              <span className="os-page-context">{currentGroup}</span>
              <span className="os-page-title">{menuLabel(current)}</span>
            </div>
            {canUseAdvisor && (
              <button
                type="button"
                className="os-page-assistant"
                aria-label={`打开${assistantCopy.title}`}
                aria-expanded={aiOpen}
                aria-controls="boss-assistant-inspector"
                onClick={() => setAiOpen(true)}
              >
                <RobotOutlined />
                <span>{assistantCopy.short}</span>
              </button>
            )}
          </div>
          <div className="os-page-body">
            {/* 路由级边界：单页异常不再白屏整站，外壳与导航保持可用 */}
            <RouteErrorBoundary resetKey={`${loc.pathname}${loc.search}`}>
              <Suspense fallback={<PageSkeleton />}>
                <Outlet />
              </Suspense>
            </RouteErrorBoundary>
          </div>
        </main>
      </div>

      {canUseAdvisor && (
        <Drawer
          className="os-ai-drawer"
          rootClassName="os-ai-drawer-root"
          title={
            <span className="os-ai-title">
              <RobotOutlined /> {assistantCopy.title}
            </span>
          }
          width={400}
          open={aiOpen}
          onClose={() => setAiOpen(false)}
          extra={
            <Button
              type="text"
              size="small"
              onClick={() => {
                setAiOpen(false);
                nav('/advisor');
              }}
            >
              进入完整参谋
            </Button>
          }
        >
          <div id="boss-assistant-inspector" className="os-ai-inspector">
            <section className="os-sec" aria-labelledby="assistant-reminders-title">
              <div id="assistant-reminders-title" className="os-sec-t">
                今日提醒
              </div>
              {notifs.slice(0, 3).map((n: any) => (
                <div className="os-rmd" key={n.id} {...pressable(() => openNotif(n))}>
                  <span className="os-rmd-dot" />
                  {n.title}
                </div>
              ))}
              {notifs.length === 0 && <div className="os-empty">今日暂无新提醒</div>}
            </section>
            <section className="os-sec" aria-labelledby="assistant-todos-title">
              <div id="assistant-todos-title" className="os-sec-t">
                {assistantCopy.todo} <Tag className="os-cnt">{todos.length}</Tag>
              </div>
              {todos.slice(0, 3).map((n: any) => (
                <div className="os-todo" key={n.id} {...pressable(() => openNotif(n))}>
                  {n.title}
                </div>
              ))}
              {todos.length === 0 && <div className="os-empty">暂无待办事项</div>}
            </section>
            <section className="os-sec os-suggest" aria-labelledby="assistant-suggestion-title">
              <div id="assistant-suggestion-title" className="os-sec-t">
                今日建议
              </div>
              <div className="os-suggest-txt">
                根据当前已记录的指标与任务，先核对异常，再把下一步动作派给对应数字员工。
              </div>
              <button className="os-suggest-btn" onClick={() => nav(assistantSuggestion.path)}>
                {assistantSuggestion.label}
              </button>
            </section>
            <div className="os-ask">
              <div id="boss-assistant-question-label" className="os-ask-label">
                交给经营助手
              </div>
              <Input.TextArea
                id="boss-assistant-question"
                aria-labelledby="boss-assistant-question-label"
                value={ask}
                onChange={e => setAsk(e.target.value)}
                placeholder="例如：找出本周最需要老板拍板的问题"
                autoSize={{ minRows: 3, maxRows: 6 }}
                onPressEnter={e => {
                  if (e.shiftKey) return;
                  e.preventDefault();
                  askBrain();
                }}
              />
              <div className="os-ask-foot">
                <span>Shift + Enter 换行</span>
                <button className="os-ask-send" onClick={askBrain} disabled={!ask.trim()}>
                  <SendOutlined /> 开始分析
                </button>
              </div>
            </div>
          </div>
        </Drawer>
      )}

      <Drawer
        title={
          <>
            <MailOutlined /> 消息中心 <Tag color="blue">{notifs.length} 条</Tag>
          </>
        }
        width={460}
        open={mailOpen}
        onClose={() => setMailOpen(false)}
        extra={
          <Button size="small" onClick={() => api.post('/sys/notifications/read').then(() => reloadNotifs(100))}>
            全部已读
          </Button>
        }
      >
        <Tabs
          size="small"
          activeKey={mailTab}
          onChange={setMailTab}
          items={[
            { key: 'all', label: '全部' },
            { key: 'approval', label: '审批' },
            { key: 'customer', label: '会员' },
            { key: 'work', label: '员工任务/活动' },
          ]}
        />
        <List
          size="small"
          dataSource={mailNotifs}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无消息" /> }}
          renderItem={(n: any) => (
            <List.Item
              onClick={() => openNotif(n)}
              style={{
                cursor: 'pointer',
                background: n.read ? 'transparent' : 'var(--ui-surface-2)',
                borderRadius: 8,
                padding: '10px 12px',
                marginBottom: 6,
              }}
            >
              <div style={{ width: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: n.read ? 400 : 600 }}>
                    {!n.read && <Badge status="processing" />} {n.title}
                  </span>
                  {notificationTarget(n) && (
                    <Tag color="blue" style={{ fontSize: 10, marginInlineEnd: 0, flexShrink: 0 }}>
                      来源：{notificationTarget(n)?.name} ›
                    </Tag>
                  )}
                </div>
                <div style={{ fontSize: 12, color: '#9aa4b5', marginTop: 2 }}>{n.body}</div>
                <div style={{ fontSize: 10.5, color: 'var(--ui-muted)', marginTop: 2 }}>
                  {(n.created_at || '').slice(0, 16)}
                </div>
              </div>
            </List.Item>
          )}
        />
      </Drawer>

      <Drawer
        title={
          <>
            <QuestionCircleOutlined /> 帮助中心
          </>
        }
        width={420}
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            fontSize: 13,
            color: 'var(--ui-text-2)',
            lineHeight: 1.8,
          }}
        >
          <div style={{ background: 'var(--ui-surface-2)', borderRadius: 10, padding: 14 }}>
            <b>
              <RocketOutlined /> {dailyGuide.title}
            </b>
            <br />
            {dailyGuide.body}
          </div>
          <div style={{ background: 'var(--ui-surface-2)', borderRadius: 10, padding: 14 }}>
            <b>
              <TeamOutlined /> 餐饮数字员工怎么用
            </b>
            <br />
            按分部或问题关键词找到员工，用一句话说明要解决的问题即可派活。岗位会自行补齐公开信息并调用技能、知识库和联网工具；任务进度、结果与费用统一在任务中心查看。
          </div>
          <div style={{ background: 'var(--ui-surface-2)', borderRadius: 10, padding: 14 }}>
            <b>
              <WalletOutlined /> 积分规则
            </b>
            <br />
            AI 调用按实际模型和 token
            计费，提交前会预留额度，交付失败会按结算规则释放。余额不足时请联系老板或企业管理员处理。
          </div>
          <div style={{ background: 'var(--ui-warning-surface)', borderRadius: 10, padding: 14, color: '#8a551d' }}>
            <b>
              <WarningOutlined /> 风控红线
            </b>
            <br />
            系统不自动外发任何内容；价格/收益数字AI不填充，命中即进审批。这是合规设计。
          </div>
        </div>
      </Drawer>

      <Modal
        open={personalFeishuOpen}
        footer={null}
        width={500}
        title={
          <>
            <LinkOutlined /> 绑定我的飞书
          </>
        }
        onCancel={() => {
          setPersonalFeishuOpen(false);
          setPersonalFeishuBind(null);
          setPersonalFeishuStatus('idle');
        }}
      >
        {personalFeishuLoading && !personalFeishu && (
          <div style={{ padding: 28, textAlign: 'center', color: 'var(--ui-muted)' }}>正在读取飞书绑定状态…</div>
        )}
        {personalFeishu && !personalFeishu.appReady && (
          <Alert
            type="warning"
            showIcon
            message="企业尚未配置飞书应用"
            description="请让老板或管理员先到“系统管理 → 配置与备份”填写飞书 App ID 和 App Secret。"
          />
        )}
        {personalFeishu?.appReady && personalFeishu?.bound && personalFeishuStatus !== 'pending' ? (
          <div>
            <Alert
              type="success"
              showIcon
              message={`已绑定${personalFeishu.receiverName ? `：${personalFeishu.receiverName}` : ''}`}
              description="活动任务、审批和经营提醒可以通过飞书应用机器人单独发送给你。"
            />
            <Button icon={<SyncOutlined />} onClick={startPersonalFeishuBinding} style={{ marginTop: 14 }}>
              重新绑定
            </Button>
          </div>
        ) : personalFeishu?.appReady ? (
          <div style={{ textAlign: 'center' }}>
            <Alert
              type="info"
              showIcon
              style={{ textAlign: 'left', marginBottom: 14 }}
              message="请使用本人的飞书账号扫码授权"
              description="绑定只作用于当前中台账号，不会覆盖老板或其他员工。"
            />
            {personalFeishuBind?.qrDataUrl ? (
              <img
                src={personalFeishuBind.qrDataUrl}
                alt="个人飞书绑定二维码"
                style={{ width: 260, height: 260, maxWidth: '100%' }}
              />
            ) : (
              <div style={{ padding: 36, color: 'var(--ui-muted)' }}>
                {personalFeishuLoading ? '正在生成二维码…' : '二维码尚未生成'}
              </div>
            )}
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Button
                type="primary"
                disabled={!personalFeishuBind?.authorizeUrl}
                onClick={() => window.open(personalFeishuBind.authorizeUrl, '_blank')}
              >
                打开飞书授权页
              </Button>
              <Button icon={<SyncOutlined />} loading={personalFeishuLoading} onClick={startPersonalFeishuBinding}>
                刷新二维码
              </Button>
            </div>
            <div
              style={{
                marginTop: 10,
                fontSize: 12,
                color: personalFeishuStatus === 'error' ? '#c24141' : 'var(--ui-muted)',
              }}
            >
              {personalFeishuStatus === 'pending' && '等待扫码授权，成功后会自动更新。'}
              {personalFeishuStatus === 'expired' && '二维码已过期，请刷新后重试。'}
              {personalFeishuStatus === 'error' && '绑定失败，请刷新二维码后重试。'}
              {personalFeishuStatus === 'missing' && '绑定会话已失效，请刷新二维码。'}
            </div>
          </div>
        ) : null}
      </Modal>

      <CommandPalette open={cmdkOpen} onClose={() => setCmdkOpen(false)} navItems={paletteNavItems} modules={modules} />
    </div>
  );
}
