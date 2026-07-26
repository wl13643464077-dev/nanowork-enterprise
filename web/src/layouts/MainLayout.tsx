import { Suspense, useEffect, useState, type KeyboardEvent } from 'react';
import { Menu, Input, Badge, Avatar, Dropdown, Popover, List, Empty, Tag, Tooltip, Drawer, Tabs, Button, Modal, Alert, message } from 'antd';
import {
  DashboardOutlined, RobotOutlined, RiseOutlined, CalendarOutlined,
  ExperimentOutlined, ScheduleOutlined, BarChartOutlined, GoldOutlined, SettingOutlined, ShopOutlined,
  BellOutlined, MailOutlined, QuestionCircleOutlined, LogoutOutlined,
  ThunderboltOutlined, UserOutlined, ControlOutlined, WalletOutlined, MobileOutlined,
  PictureOutlined, MessageOutlined,
  HistoryOutlined, RightOutlined, SendOutlined, SwapOutlined,
  BgColorsOutlined, CheckOutlined, LinkOutlined, SyncOutlined,
  AppstoreOutlined, ToolOutlined, RocketOutlined, TeamOutlined, WarningOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, getUser, clearAuth } from '../api/client';
import { PageSkeleton } from '../components/Kit';
import './MainLayout.css';

// 左侧任务导航：用实体店老板能立即理解的语言描述，而不是技术模块名。
const MENUS = [
  { key: '/', icon: <DashboardOutlined />, label: '老板驾驶舱', mod: 'dashboard' },
  { key: '/advisor', icon: <RobotOutlined />, label: '老板参谋', mod: 'advisor' },
  { key: '/employees', icon: <AppstoreOutlined />, label: '餐饮数字员工', mod: 'marshals' },
  { key: '/toolbox', icon: <ToolOutlined />, label: '经营工具箱', mod: 'content' },
  { key: '/growth', icon: <RiseOutlined />, label: '会员增长', mod: 'growth' },
  { key: '/activities', icon: <CalendarOutlined />, label: '营销活动', mod: 'activities' },
  { key: '/content', icon: <ExperimentOutlined />, label: '内容生产仓', mod: 'content' },
  { key: '/execution', icon: <ScheduleOutlined />, label: '今日经营', mod: 'execution' },
  { key: '/analysis', icon: <BarChartOutlined />, label: '经营洞察', mod: 'analysis' },
  { key: '/store-data', icon: <ShopOutlined />, label: '门店数据', mod: 'analysis' },
  { key: '/assets', icon: <GoldOutlined />, label: '知识资产', mod: 'assets' },
  { key: '/system', icon: <SettingOutlined />, label: '系统管理', mod: 'system' },
  { key: '/recharge', icon: <WalletOutlined />, label: '充值中心', bossOnly: true },
];

// 底部「快捷作战栏」——一键直达对应模块去生成（高频动作入口）
const QUICK = [
  { icon: <AppstoreOutlined />, label: '找员工派活', to: '/employees', mod: 'marshals' },
  { icon: <ThunderboltOutlined />, label: '今日必发', to: '/toolbox?tool=hot', mod: 'content' },
  { icon: <CalendarOutlined />, label: '做营销活动', to: '/activities', mod: 'activities' },
  { icon: <MessageOutlined />, label: '会员唤醒话术', to: '/growth', mod: 'growth' },
  { icon: <PictureOutlined />, label: '做产品海报', to: '/toolbox?tool=shot', mod: 'content' },
  { icon: <HistoryOutlined />, label: '看经营复盘', to: '/analysis', mod: 'analysis' },
];

const ROLE_NAME: Record<string, string> = { boss: '老板', ops_director: '门店运营', sales: '一线员工', admin: '系统管理员' };
const THEME_KEY = 'nanowork_industry_theme_v1';

const KEY_OF_PATH: Record<string, string> = {
  '/': 'dashboard', '/advisor': 'advisor', '/employees': 'marshals', '/marshals': 'marshals', '/toolbox': 'content', '/growth': 'growth',
  '/activities': 'activities', '/content': 'content', '/execution': 'execution',
  '/analysis': 'analysis', '/store-data': 'analysis', '/assets': 'assets', '/data-intake': 'system', '/system': 'system',
};

// 无障碍：给非 button 的可点击元素补键盘可达性（role/tabIndex/Enter/Space），不改布局结构
function pressable(fn: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: fn,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
    },
  };
}

function menusFor(modules: string[], role?: string) {
  return MENUS.filter((menu: any) => {
    if (menu.bossOnly && role !== 'boss') return false;
    if (menu.managerOnly && !['boss', 'ops_director', 'admin'].includes(role || '')) return false;
    return !menu.mod || modules.includes(menu.mod);
  });
}

export default function MainLayout() {
  const nav = useNavigate();
  const loc = useLocation();
  const user = getUser();
  const [notifs, setNotifs] = useState<any[]>([]);
  const [credits, setCredits] = useState<number>(user?.credits ?? 0);
  const [modules, setModules] = useState<string[]>(user?.modules || Object.values(KEY_OF_PATH));
  const [aiOpen, setAiOpen] = useState(true);
  const [ask, setAsk] = useState('');
  const [uiTheme, setUiTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'nano');
  const changeAppearance = (key: string) => {
    if (['nano', 'midnight'].includes(key)) {
      localStorage.setItem(THEME_KEY, key);
      setUiTheme(key);
      window.dispatchEvent(new CustomEvent('nanowork-theme-change', { detail: { theme: key } }));
    }
  };
  const visibleMenus = menusFor(modules, user?.role);
  const visibleQuick = QUICK.filter(item => modules.includes(item.mod));
  const current = MENUS.find(m => m.key === loc.pathname) || visibleMenus[0] || MENUS[0];
  const menuLabel = (m: any) => {
    if (m.mod !== 'dashboard') return m.label;
    if (user?.role === 'sales') return '我的工作台';
    if (user?.role === 'partner') return '合伙人工作台';
    if (user?.role === 'ops_director') return '经营协同台';
    return '老板驾驶舱';
  };

  useEffect(() => {
    api.get('/sys/notifications').then(setNotifs).catch(() => {});
    // 60s 轮询：带可见性门控（后台标签页不发请求）；依赖为空数组，切页不再重建定时器
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') api.get('/sys/notifications').then(setNotifs).catch(() => {});
    }, 60000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    api.get('/auth/me').then((me) => { setCredits(me.credits ?? 0); if (me.modules?.length) setModules(me.modules); }).catch(() => {});
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
    approval: { link: '/system', name: '审批中心' },
    lead: { link: '/growth', name: '会员增长' },
    follow: { link: '/growth', name: '会员增长' },
    partner: { link: '/execution', name: '今日经营' },
    marshal: { link: '/employees', name: '餐饮数字员工' },
    activity: { link: '/activities', name: '营销活动' },
    task: { link: '/execution', name: '今日经营' },
  };
  const reloadNotifs = (size = 20) => api.get(`/sys/notifications?size=${size}`).then(setNotifs).catch(() => {});
  const openNotif = (n: any) => {
    if (!n.read) api.post(`/sys/notifications/${n.id}/read`).then(() => reloadNotifs(mailOpen ? 100 : 20)).catch(() => {});
    const t = NOTIF_LINK[n.type];
    if (t) { setMailOpen(false); nav(t.link); }
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
    api.post('/sys/feishu/oauth/start', { baseUrl: window.location.origin })
      .then((data: any) => setPersonalFeishuBind(data))
      .catch(() => setPersonalFeishuStatus('error'))
      .finally(() => setPersonalFeishuLoading(false));
  };
  const openPersonalFeishuBinding = () => {
    setPersonalFeishuOpen(true);
    setPersonalFeishuLoading(true);
    api.get('/sys/feishu/me')
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
      if (Date.now() - startedAt > 5 * 60 * 1000) { setPersonalFeishuStatus('expired'); return; }
      api.get(`/sys/feishu/oauth/status?state=${encodeURIComponent(personalFeishuBind.state)}`)
        .then((data: any) => {
          if (data.status === 'bound') {
            setPersonalFeishuStatus('bound');
            setPersonalFeishuBind(null);
            api.get('/sys/feishu/me').then(setPersonalFeishu).catch(() => {});
            message.success(`飞书已绑定${data.receiverName ? `：${data.receiverName}` : ''}`);
            return;
          }
          if (['expired', 'error', 'missing'].includes(data.status)) { setPersonalFeishuStatus(data.status); return; }
          attempt += 1;
          timer = window.setTimeout(tick, DELAYS[Math.min(attempt, DELAYS.length - 1)]);
        })
        .catch(() => { timer = window.setTimeout(tick, DELAYS[DELAYS.length - 1]); });
    };
    timer = window.setTimeout(tick, DELAYS[0]);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [personalFeishuOpen, personalFeishuBind?.state, personalFeishuStatus]);
  const mailNotifs = mailTab === 'all' ? notifs : notifs.filter(n =>
    mailTab === 'approval' ? n.type === 'approval'
    : mailTab === 'customer' ? ['lead', 'follow'].includes(n.type)
    : mailTab === 'work' ? ['task', 'marshal', 'partner', 'activity'].includes(n.type)
    : true);

  const todos = notifs.filter(n => ['approval', 'task'].includes(n.type));
  const askBrain = () => { nav('/advisor', { state: { q: ask.trim() } }); setAsk(''); };

  const Logo = <img className="os-brand-mark" src="/brand/nanowork-icon.svg" alt="纳米Work" />;

  return (
    <div className="os-shell">

      {/* 顶部：企业状态栏 */}
      <header className="os-top">
        <div className="os-brand">
          {Logo}
          <span className="os-brand-name">纳米Work<span>行业版</span></span>
          <span className="os-brand-sub">实体门店智能经营工作台</span>
          <span className="os-brand-div">｜</span>
          <span className="os-brand-tenant">当前门店：{user?.tenant?.name || '当前企业'}</span>
        </div>
        <div className="os-status">
          <span className="os-dot os-dot-g" />数据口径 当前企业
          <span className="os-dot os-dot-g" />岗位档案 70岗
          <span className="os-dot os-dot-g" />任务产出 可追溯
        </div>
        <div className="os-top-actions">
          <Dropdown trigger={['click']} menu={{
            onClick: ({ key }) => changeAppearance(key),
            items: [
              { key: 'nano', label: <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#fff', border: '1px solid #b9c9dc', marginRight: 8 }} />纳米明亮 {uiTheme === 'nano' && <CheckOutlined />}</span> },
              { key: 'midnight', label: <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#071d36', border: '1px solid #4d79a9', marginRight: 8 }} />深海夜间 {uiTheme === 'midnight' && <CheckOutlined />}</span> },
            ],
          }}><Tooltip title="界面主题"><BgColorsOutlined className="os-ic" /></Tooltip></Dropdown>
          <Tooltip title="企业积分余额 · 点击进入充值中心">
            <span className="os-credit" aria-label="企业积分余额，点击进入充值中心"
              {...pressable(() => { if (user?.role === 'boss') nav('/recharge'); })}>
              ◆ {Number(credits).toLocaleString()} 积分
            </span>
          </Tooltip>
          <Tooltip title="问老板参谋">
            <button className="os-ask-brain" aria-label="问老板参谋" onClick={() => nav('/advisor')}>
              <RobotOutlined /><span className="os-ask-brain-label">问老板参谋</span>
            </button>
          </Tooltip>
          <Tooltip title="手机版（H5）">
            <button type="button" className="os-icon-btn" aria-label="打开手机版（H5）" onClick={() => nav('/m')}>
              <MobileOutlined className="os-ic" />
            </button>
          </Tooltip>
          {['boss', 'admin'].includes(user?.role) && (
            <Tooltip title="管理后台">
              <button type="button" className="os-icon-btn" aria-label="打开管理后台" onClick={() => (location.href = '/admin')}>
                <ControlOutlined className="os-ic" />
              </button>
            </Tooltip>
          )}
          <Popover trigger="click" placement="bottomRight" content={
            <div style={{ width: 320 }}>
              <List size="small" dataSource={notifs.slice(0, 8)}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无通知" /> }}
                renderItem={(n: any) => (
                  <List.Item onClick={() => openNotif(n)} style={{ cursor: 'pointer' }}>
                    <div style={{ width: '100%' }}>
                      <div style={{ fontSize: 13, fontWeight: n.read ? 400 : 600, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span>{!n.read && <Badge status="processing" />} {n.title}</span>
                        {NOTIF_LINK[n.type] && <Tag color="blue" style={{ fontSize: 10, marginInlineEnd: 0 }}>{NOTIF_LINK[n.type].name} ›</Tag>}
                      </div>
                      <div style={{ fontSize: 12, color: '#9aa4b5' }}>{n.body}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--ui-muted)' }}>{(n.created_at || '').slice(5, 16)}</div>
                    </div>
                  </List.Item>
                )} />
              {notifs.length > 0 && <a style={{ fontSize: 12 }} onClick={() => api.post('/sys/notifications/read').then(() => api.get('/sys/notifications').then(setNotifs))}>全部标为已读</a>}
            </div>
          }>
            <Badge count={unread} size="small"><BellOutlined className="os-ic" /></Badge>
          </Popover>
          <Tooltip title="消息中心">
            <Badge count={unread} size="small">
              <button type="button" className="os-icon-btn" aria-label="打开消息中心" onClick={() => { setMailOpen(true); reloadNotifs(100); }}>
                <MailOutlined className="os-ic" />
              </button>
            </Badge>
          </Tooltip>
          <Tooltip title="帮助中心">
            <button type="button" className="os-icon-btn" aria-label="打开帮助中心" onClick={() => setHelpOpen(true)}>
              <QuestionCircleOutlined className="os-ic" />
            </button>
          </Tooltip>
          <Dropdown menu={{
            items: [
              { key: 'switch', icon: <SwapOutlined />, label: `账号：${ROLE_NAME[user?.role] || user?.role}`, disabled: true },
              { key: 'feishu', icon: <LinkOutlined />, label: '绑定我的飞书' },
              { key: 'logout', icon: <LogoutOutlined />, label: '退出登录' },
            ],
            onClick: ({ key }) => {
              if (key === 'feishu') openPersonalFeishuBinding();
              if (key === 'logout') { clearAuth(); nav('/login'); }
            },
          }}>
            <div className="os-user">
              <Avatar size={30} style={{ background: 'var(--ui-primary)' }} icon={<UserOutlined />} />
              <span className="os-user-name">{user?.name}</span>
            </div>
          </Dropdown>
        </div>
      </header>

      <div className="os-mid">
        {/* 左侧：企业作战系统 */}
        <aside className="os-left">
          <div className="os-left-title">门店经营中心</div>
          <Menu mode="inline" theme="dark" selectedKeys={[current.key]}
            items={visibleMenus.map(m => ({ key: m.key, icon: m.icon, label: menuLabel(m) }))}
            onClick={({ key }) => nav(key)} />
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
            <span className="os-page-title">{menuLabel(current)}</span>
          </div>
          <div className="os-page-body"><Suspense fallback={<PageSkeleton />}><Outlet /></Suspense></div>
        </main>

        {/* 右侧：老板经营助手 */}
        <aside className={`os-right ${aiOpen ? '' : 'os-right-min'}`}>
          {aiOpen ? (
            <>
              <div className="os-right-head">
                <span><RobotOutlined /> 老板经营助手</span>
                <button type="button" className="os-icon-btn" aria-label="收起老板经营助手" onClick={() => setAiOpen(false)}>
                  <RightOutlined className="os-ic-sm" />
                </button>
              </div>
              <div className="os-sec">
                <div className="os-sec-t">今日提醒</div>
                {notifs.slice(0, 3).map((n: any) => (
                  <div className="os-rmd" key={n.id} {...pressable(() => openNotif(n))}>
                    <span className="os-rmd-dot" />{n.title}
                  </div>
                ))}
                {notifs.length === 0 && <div className="os-empty">今日暂无新提醒</div>}
              </div>
              <div className="os-sec">
                <div className="os-sec-t">老板待办 <Tag className="os-cnt">{todos.length}</Tag></div>
                {todos.slice(0, 3).map((n: any) => (
                  <div className="os-todo" key={n.id} {...pressable(() => openNotif(n))}>{n.title}</div>
                ))}
                {todos.length === 0 && <div className="os-empty">暂无待办事项</div>}
              </div>
              <div className="os-sec os-suggest">
                <div className="os-sec-t">今日建议</div>
                <div className="os-suggest-txt">
                  根据当前已记录的指标与任务，先核对异常，再把下一步动作派给对应数字员工。
                </div>
                <button className="os-suggest-btn" onClick={() => nav('/analysis')}>查看经营穿刺 →</button>
              </div>
              <div className="os-ask">
                <Input.TextArea value={ask} onChange={e => setAsk(e.target.value)} placeholder="请输入你想解决的经营问题…"
                  autoSize={{ minRows: 2, maxRows: 4 }} onPressEnter={e => { e.preventDefault(); askBrain(); }} />
                <button className="os-ask-send" onClick={askBrain}><SendOutlined /> 问老板参谋</button>
              </div>
            </>
          ) : (
            <button className="os-right-open" onClick={() => setAiOpen(true)} aria-label="展开老板经营助手"><RobotOutlined /></button>
          )}
        </aside>
      </div>

      {/* 底部：快捷作战栏 */}
      <footer className="os-bottom">
        <span className="os-bottom-label">老板快捷入口</span>
        <div className="os-quick">
          {visibleQuick.map(q => (
            <button className="os-quick-btn" key={q.label} onClick={() => nav(q.to)}>{q.icon}<span>{q.label}</span></button>
          ))}
        </div>
      </footer>

      <Drawer title={<><MailOutlined /> 消息中心 <Tag color="blue">{notifs.length} 条</Tag></>} width={460}
        open={mailOpen} onClose={() => setMailOpen(false)}
        extra={<Button size="small" onClick={() => api.post('/sys/notifications/read').then(() => reloadNotifs(100))}>全部已读</Button>}>
        <Tabs size="small" activeKey={mailTab} onChange={setMailTab} items={[
          { key: 'all', label: '全部' }, { key: 'approval', label: '审批' },
          { key: 'customer', label: '会员' }, { key: 'work', label: '员工任务/活动' },
        ]} />
        <List size="small" dataSource={mailNotifs}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无消息" /> }}
          renderItem={(n: any) => (
            <List.Item onClick={() => openNotif(n)}
              style={{ cursor: 'pointer', background: n.read ? 'transparent' : 'var(--ui-surface-2)', borderRadius: 8, padding: '10px 12px', marginBottom: 6 }}>
              <div style={{ width: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: n.read ? 400 : 600 }}>{!n.read && <Badge status="processing" />} {n.title}</span>
                  {NOTIF_LINK[n.type] && <Tag color="blue" style={{ fontSize: 10, marginInlineEnd: 0, flexShrink: 0 }}>来源：{NOTIF_LINK[n.type].name} ›</Tag>}
                </div>
                <div style={{ fontSize: 12, color: '#9aa4b5', marginTop: 2 }}>{n.body}</div>
                <div style={{ fontSize: 10.5, color: 'var(--ui-muted)', marginTop: 2 }}>{(n.created_at || '').slice(0, 16)}</div>
              </div>
            </List.Item>
          )} />
      </Drawer>

      <Drawer title={<><QuestionCircleOutlined /> 帮助中心</>} width={420} open={helpOpen} onClose={() => setHelpOpen(false)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13, color: 'var(--ui-text-2)', lineHeight: 1.8 }}>
          <div style={{ background: 'var(--ui-surface-2)', borderRadius: 10, padding: 14 }}>
            <b><RocketOutlined /> 老板每日10分钟</b><br />
            ① 老板驾驶舱看 KPI 与异常 ② 点开指标穿刺到订单/会员 ③ 把下一步动作派给对应数字员工
          </div>
          <div style={{ background: 'var(--ui-surface-2)', borderRadius: 10, padding: 14 }}>
            <b><TeamOutlined /> 餐饮数字员工怎么用</b><br />
            按分部或问题关键词找到员工，先看必要输入和交付物，再派活。任务完成后可以审阅、采纳并沉淀到企业知识库。
          </div>
          <div style={{ background: 'var(--ui-surface-2)', borderRadius: 10, padding: 14 }}>
            <b><WalletOutlined /> 积分规则</b><br />
            AI调用按模型计费：员工话术≈1分、老板对话≈11-69分、生图75分。余额不足会被拦截，找管理员充值（管理后台→积分管理）。
          </div>
          <div style={{ background: 'var(--ui-warning-surface)', borderRadius: 10, padding: 14, color: '#8a551d' }}>
            <b><WarningOutlined /> 风控红线</b><br />
            系统不自动外发任何内容；价格/收益数字AI不填充，命中即进审批。这是合规设计。
          </div>
        </div>
      </Drawer>

      <Modal open={personalFeishuOpen} footer={null} width={500} title={<><LinkOutlined /> 绑定我的飞书</>}
        onCancel={() => { setPersonalFeishuOpen(false); setPersonalFeishuBind(null); setPersonalFeishuStatus('idle'); }}>
        {personalFeishuLoading && !personalFeishu && <div style={{ padding: 28, textAlign: 'center', color: 'var(--ui-muted)' }}>正在读取飞书绑定状态…</div>}
        {personalFeishu && !personalFeishu.appReady && (
          <Alert type="warning" showIcon message="企业尚未配置飞书应用"
            description="请让老板或管理员先到“系统管理 → 配置与备份”填写飞书 App ID 和 App Secret。" />
        )}
        {personalFeishu?.appReady && personalFeishu?.bound && personalFeishuStatus !== 'pending' ? (
          <div>
            <Alert type="success" showIcon message={`已绑定${personalFeishu.receiverName ? `：${personalFeishu.receiverName}` : ''}`}
              description="活动任务、审批和经营提醒可以通过飞书应用机器人单独发送给你。" />
            <Button icon={<SyncOutlined />} onClick={startPersonalFeishuBinding} style={{ marginTop: 14 }}>重新绑定</Button>
          </div>
        ) : personalFeishu?.appReady ? (
          <div style={{ textAlign: 'center' }}>
            <Alert type="info" showIcon style={{ textAlign: 'left', marginBottom: 14 }}
              message="请使用本人的飞书账号扫码授权"
              description="绑定只作用于当前中台账号，不会覆盖老板或其他员工。" />
            {personalFeishuBind?.qrDataUrl
              ? <img src={personalFeishuBind.qrDataUrl} alt="个人飞书绑定二维码" style={{ width: 260, height: 260, maxWidth: '100%' }} />
              : <div style={{ padding: 36, color: 'var(--ui-muted)' }}>{personalFeishuLoading ? '正在生成二维码…' : '二维码尚未生成'}</div>}
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Button type="primary" disabled={!personalFeishuBind?.authorizeUrl}
                onClick={() => window.open(personalFeishuBind.authorizeUrl, '_blank')}>打开飞书授权页</Button>
              <Button icon={<SyncOutlined />} loading={personalFeishuLoading} onClick={startPersonalFeishuBinding}>刷新二维码</Button>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: personalFeishuStatus === 'error' ? '#c24141' : 'var(--ui-muted)' }}>
              {personalFeishuStatus === 'pending' && '等待扫码授权，成功后会自动更新。'}
              {personalFeishuStatus === 'expired' && '二维码已过期，请刷新后重试。'}
              {personalFeishuStatus === 'error' && '绑定失败，请刷新二维码后重试。'}
              {personalFeishuStatus === 'missing' && '绑定会话已失效，请刷新二维码。'}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

