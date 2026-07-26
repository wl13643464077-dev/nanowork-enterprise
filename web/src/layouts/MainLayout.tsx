import { useEffect, useState } from 'react';
import { Menu, Input, Badge, Avatar, Dropdown, Popover, List, Empty, Tag, Tooltip, Drawer, Tabs, Button, Modal, Alert, message } from 'antd';
import {
  DashboardOutlined, RobotOutlined, RiseOutlined, CalendarOutlined,
  ExperimentOutlined, ScheduleOutlined, BarChartOutlined, GoldOutlined, SettingOutlined,
  BellOutlined, MailOutlined, QuestionCircleOutlined, LogoutOutlined,
  ThunderboltOutlined, UserOutlined, ControlOutlined, WalletOutlined, MobileOutlined,
  PictureOutlined, MessageOutlined,
  HistoryOutlined, RightOutlined, SendOutlined, SwapOutlined,
  BgColorsOutlined, CheckOutlined, LinkOutlined, SyncOutlined,
  AppstoreOutlined, ToolOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, getUser, clearAuth } from '../api/client';

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
  '/analysis': 'analysis', '/assets': 'assets', '/data-intake': 'system', '/system': 'system',
};

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
    // 60s 轮询：后台生成/员工任务完成的铃铛通知不用等切页或手动点开
    const timer = setInterval(() => api.get('/sys/notifications').then(setNotifs).catch(() => {}), 60000);
    return () => clearInterval(timer);
  }, [loc.pathname]);
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
    const timer = window.setInterval(() => {
      api.get(`/sys/feishu/oauth/status?state=${encodeURIComponent(personalFeishuBind.state)}`)
        .then((data: any) => {
          if (data.status === 'bound') {
            setPersonalFeishuStatus('bound');
            setPersonalFeishuBind(null);
            api.get('/sys/feishu/me').then(setPersonalFeishu).catch(() => {});
            message.success(`飞书已绑定${data.receiverName ? `：${data.receiverName}` : ''}`);
          } else if (['expired', 'error', 'missing'].includes(data.status)) {
            setPersonalFeishuStatus(data.status);
          }
        })
        .catch(() => {});
    }, 1800);
    return () => window.clearInterval(timer);
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
      <style>{STYLES}</style>

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
            <span className="os-credit" onClick={() => { if (user?.role === 'boss') nav('/recharge'); }}>
              ◆ {Number(credits).toLocaleString()} 积分
            </span>
          </Tooltip>
          <Tooltip title="问老板参谋">
            <button className="os-ask-brain" aria-label="问老板参谋" onClick={() => nav('/advisor')}>
              <RobotOutlined /><span className="os-ask-brain-label">问老板参谋</span>
            </button>
          </Tooltip>
          <Tooltip title="手机版（H5）"><MobileOutlined className="os-ic" onClick={() => nav('/m')} /></Tooltip>
          {['boss', 'admin'].includes(user?.role) && (
            <Tooltip title="管理后台"><ControlOutlined className="os-ic" onClick={() => (location.href = '/admin')} /></Tooltip>
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
                      <div style={{ fontSize: 10.5, color: '#c2c9d6' }}>{(n.created_at || '').slice(5, 16)}</div>
                    </div>
                  </List.Item>
                )} />
              {notifs.length > 0 && <a style={{ fontSize: 12 }} onClick={() => api.post('/sys/notifications/read').then(() => api.get('/sys/notifications').then(setNotifs))}>全部标为已读</a>}
            </div>
          }>
            <Badge count={unread} size="small"><BellOutlined className="os-ic" /></Badge>
          </Popover>
          <Tooltip title="消息中心">
            <Badge count={unread} size="small"><MailOutlined className="os-ic" onClick={() => { setMailOpen(true); reloadNotifs(100); }} /></Badge>
          </Tooltip>
          <Tooltip title="帮助中心"><QuestionCircleOutlined className="os-ic" onClick={() => setHelpOpen(true)} /></Tooltip>
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
          <div className="os-page-body"><Outlet /></div>
        </main>

        {/* 右侧：老板经营助手 */}
        <aside className={`os-right ${aiOpen ? '' : 'os-right-min'}`}>
          {aiOpen ? (
            <>
              <div className="os-right-head">
                <span><RobotOutlined /> 老板经营助手</span>
                <RightOutlined className="os-ic-sm" onClick={() => setAiOpen(false)} />
              </div>
              <div className="os-sec">
                <div className="os-sec-t">今日提醒</div>
                {notifs.slice(0, 3).map((n: any) => (
                  <div className="os-rmd" key={n.id} onClick={() => openNotif(n)}>
                    <span className="os-rmd-dot" />{n.title}
                  </div>
                ))}
                {notifs.length === 0 && <div className="os-empty">今日暂无新提醒</div>}
              </div>
              <div className="os-sec">
                <div className="os-sec-t">老板待办 <Tag className="os-cnt">{todos.length}</Tag></div>
                {todos.slice(0, 3).map((n: any) => (
                  <div className="os-todo" key={n.id} onClick={() => openNotif(n)}>{n.title}</div>
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

      <Drawer title={<>📨 消息中心 <Tag color="blue">{notifs.length} 条</Tag></>} width={460}
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
                <div style={{ fontSize: 10.5, color: '#c2c9d6', marginTop: 2 }}>{(n.created_at || '').slice(0, 16)}</div>
              </div>
            </List.Item>
          )} />
      </Drawer>

      <Drawer title="❓ 帮助中心" width={420} open={helpOpen} onClose={() => setHelpOpen(false)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13, color: '#3d4a5f', lineHeight: 1.8 }}>
          <div style={{ background: 'var(--ui-surface-2)', borderRadius: 10, padding: 14 }}>
            <b>🚀 老板每日10分钟</b><br />
            ① 老板驾驶舱看 KPI 与异常 ② 点开指标穿刺到订单/会员 ③ 把下一步动作派给对应数字员工
          </div>
          <div style={{ background: 'var(--ui-surface-2)', borderRadius: 10, padding: 14 }}>
            <b>👥 餐饮数字员工怎么用</b><br />
            按分部或问题关键词找到员工，先看必要输入和交付物，再派活。任务完成后可以审阅、采纳并沉淀到企业知识库。
          </div>
          <div style={{ background: 'var(--ui-surface-2)', borderRadius: 10, padding: 14 }}>
            <b>💰 积分规则</b><br />
            AI调用按模型计费：员工话术≈1分、老板对话≈11-69分、生图75分。余额不足会被拦截，找管理员充值（管理后台→积分管理）。
          </div>
          <div style={{ background: 'var(--ui-warning-surface)', borderRadius: 10, padding: 14, color: '#8a551d' }}>
            <b>⚠️ 风控红线</b><br />
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

const STYLES = `
.os-shell{--g:var(--ui-primary); --g2:var(--ui-primary-soft); --ink:var(--ui-text); --muted:var(--ui-muted); --b:var(--ui-border);
  position:fixed; inset:0; display:flex; flex-direction:column; background:var(--ui-bg); overflow:hidden;
  font-family:'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif}

/* 顶部状态栏 */
.os-top{height:62px; flex-shrink:0; display:flex; align-items:center; gap:18px; padding:0 20px;
  background:var(--ui-chrome); border-bottom:1px solid var(--b); box-shadow:0 6px 24px rgba(20,48,82,.045); z-index:3}
.os-brand{display:flex; align-items:center; gap:9px; min-width:0}
.os-brand-mark{width:38px; height:38px; object-fit:contain; flex:0 0 auto; filter:drop-shadow(0 7px 14px rgba(19,84,161,.16))}
.os-brand-name{font-size:16px; font-weight:760; letter-spacing:-.2px; color:var(--ui-text); white-space:nowrap}
.os-brand-name span{margin-left:5px; padding-left:7px; border-left:1px solid var(--ui-border); color:var(--ui-primary); font-size:11px; font-weight:650}
.os-brand-sub{font-size:11.5px; color:var(--muted); white-space:nowrap}
.os-brand-div{color:var(--ui-border)}
.os-brand-tenant{font-size:12px; color:var(--ui-primary); white-space:nowrap}
.os-status{display:flex; align-items:center; gap:7px; font-size:11.5px; color:var(--muted); white-space:nowrap}
.os-dot{width:6px; height:6px; border-radius:50%; display:inline-block; margin-left:12px}
.os-dot:first-child{margin-left:0}
.os-dot-g{background:#5fd39a; box-shadow:0 0 7px #5fd39a}
.os-dot-y{background:#e6b450; box-shadow:0 0 7px #e6b450; animation:os-blink 1.6s ease-in-out infinite}
@keyframes os-blink{0%,100%{opacity:1} 50%{opacity:.35}}
.os-top-actions{margin-left:auto; display:flex; align-items:center; gap:16px}
.os-credit{cursor:pointer; font-size:12px; font-weight:600; color:var(--ui-text); background:var(--ui-surface-2); border:1px solid var(--ui-border); padding:5px 11px; border-radius:8px; white-space:nowrap}
.os-ask-brain{cursor:pointer; font-size:12px; color:#fff; background:linear-gradient(135deg,#2c76dc,#0751a3); border:1px solid transparent; padding:7px 13px; border-radius:9px; display:flex; align-items:center; gap:6px; box-shadow:0 8px 18px rgba(23,105,210,.18); transition:transform .2s,filter .2s}
.os-ask-brain:hover{background:var(--ui-surface); color:var(--ui-primary)}
.os-ask-brain .anticon{font-size:14px}
.os-ic{font-size:17px; color:var(--ui-text-2); cursor:pointer; transition:color .2s}
.os-ic:hover{color:var(--g)}
.os-user{display:flex; align-items:center; gap:8px; cursor:pointer; flex-shrink:0}
.os-user-name{font-size:13px; color:var(--ink); white-space:nowrap}

/* 中区三栏 */
.os-mid{flex:1; display:flex; min-height:0}

/* 左侧作战系统 */
.os-left{width:208px; flex-shrink:0; display:flex; flex-direction:column; background:linear-gradient(180deg,#071d36 0%,#06182d 100%); border-right:1px solid #102d4b; overflow-y:auto; color:#dbeaff}
.os-left-title{padding:18px 20px 9px; font-size:10px; letter-spacing:2.4px; color:#6f96c2; font-weight:600}
.os-left .ant-menu{background:transparent !important; border:none !important; flex:1}
.os-left .ant-menu-item{color:#a9bfd7 !important; border-radius:9px !important; margin:3px 10px !important; width:auto !important; height:40px; line-height:40px}
.os-left .ant-menu-item .anticon{color:#77a9df !important; font-size:15px}
.os-left .ant-menu-item:hover{color:#eef6ff !important; background:rgba(73,135,205,.13) !important}
.os-left .ant-menu-item-selected{color:#fff !important; background:linear-gradient(135deg,rgba(44,118,220,.92),rgba(11,83,158,.9)) !important; font-weight:600; box-shadow:0 9px 22px rgba(0,55,121,.22)}
.os-left .ant-menu-item-selected .anticon{color:#fff !important}
.os-culture{padding:13px 18px; border-top:1px solid rgba(117,160,207,.14); text-align:left}
.os-culture-line{font-size:10px; letter-spacing:.6px; color:#6e91b7; line-height:1.8}
.os-me{display:flex; align-items:center; gap:9px; padding:11px 14px; border-top:1px solid rgba(117,160,207,.14)}
.os-me-name{font-size:12.5px; font-weight:600; color:#eaf4ff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.os-me-sub{font-size:10.5px; color:#7695b6}

/* 中间内容（浅色） */
.os-center{flex:1; min-width:0; display:flex; flex-direction:column; background:var(--ui-bg); overflow:hidden}
.os-page-head{height:46px; flex-shrink:0; display:flex; align-items:center; padding:0 20px; background:var(--ui-chrome); border-bottom:1px solid var(--ui-border)}
.os-page-title{font-size:15px; font-weight:700; letter-spacing:-.2px; color:var(--ui-text)}
.os-page-body{flex:1; overflow:auto; padding:18px}

/* 右侧 AI经营秘书长 */
.os-right{width:228px; flex-shrink:0; display:flex; flex-direction:column; gap:11px; padding:14px; overflow-y:auto;
  background:var(--ui-chrome); border-left:1px solid var(--b)}
.os-right-min{width:50px; padding:10px 0; align-items:center}
.os-right-open{width:34px; height:34px; border-radius:10px; cursor:pointer; color:var(--g); background:var(--ui-primary-soft); border:1px solid var(--b); font-size:16px}
.os-right-head{display:flex; align-items:center; justify-content:space-between; font-size:14px; font-weight:700; color:var(--g)}
.os-ic-sm{font-size:13px; color:var(--muted); cursor:pointer}
.os-ic-sm:hover{color:var(--g)}
.os-sec{background:var(--ui-surface-2); border:1px solid var(--b); border-radius:12px; padding:12px}
.os-sec-t{font-size:12.5px; font-weight:600; color:var(--ui-primary); margin-bottom:9px; display:flex; align-items:center; gap:6px}
.os-cnt{background:var(--ui-primary-soft) !important; color:var(--g) !important; border:none !important; font-size:11px; margin:0}
.os-rmd{font-size:12.5px; color:var(--ui-text-2); padding:5px 0; cursor:pointer; display:flex; align-items:center; line-height:1.5}
.os-rmd:hover{color:var(--g)}
.os-rmd-dot{width:5px; height:5px; border-radius:50%; background:var(--g); margin-right:8px; flex-shrink:0}
.os-todo{font-size:12.5px; color:var(--ui-text-2); padding:6px 10px; margin-bottom:6px; background:var(--ui-surface); border-radius:8px; cursor:pointer; border-left:2px solid var(--ui-primary)}
.os-todo:hover{color:var(--ui-primary); background:var(--ui-surface)}
.os-empty{font-size:12px; color:var(--ui-muted); padding:4px 0}
.os-suggest-txt{font-size:12.5px; color:var(--ui-text-2); line-height:1.7}
.os-suggest-btn{margin-top:9px; cursor:pointer; font-size:12px; color:var(--g); background:transparent; border:none; padding:0}
.os-suggest-btn:hover{color:var(--ui-primary-strong)}
.os-ask{margin-top:auto}
.os-ask .ant-input{background:var(--ui-surface); border:1px solid var(--b); color:var(--ink); border-radius:10px; font-size:13px}
.os-ask .ant-input::placeholder{color:var(--ui-muted)}
.os-ask .ant-input:focus,.os-ask .ant-input:hover{border-color:rgba(44,118,220,.55)}
.os-ask-send{width:100%; margin-top:8px; cursor:pointer; height:38px; border:none; border-radius:6px; font-size:13.5px; font-weight:600; letter-spacing:0; color:var(--ui-on-primary); background:var(--ui-primary); display:flex; align-items:center; justify-content:center; gap:6px}
.os-ask-send:hover{filter:brightness(1.06)}

/* 底部快捷作战栏 */
.os-bottom{height:56px; flex-shrink:0; display:flex; align-items:center; gap:16px; padding:0 18px;
  background:var(--ui-chrome); border-top:1px solid var(--b)}
.os-bottom-label{font-size:11px; letter-spacing:2px; color:var(--ui-primary); font-weight:600; white-space:nowrap}
.os-quick{display:flex; gap:10px; overflow-x:auto}
.os-quick-btn{display:flex; align-items:center; gap:7px; cursor:pointer; white-space:nowrap; flex-shrink:0;
  font-size:12.5px; color:var(--ui-text-2); background:var(--ui-surface-2); border:1px solid var(--b); padding:7px 14px; border-radius:10px; transition:all .2s}
.os-quick-btn .anticon{color:var(--g)}
.os-quick-btn:hover{color:var(--g); background:var(--ui-primary-soft); border-color:rgba(44,118,220,.38); transform:translateY(-1px)}

@media (max-width:1320px){ .os-status{display:none} }
@media (max-width:1180px){
  .os-ask-brain{width:32px; height:32px; padding:0; border-radius:6px; justify-content:center}
  .os-ask-brain-label{display:none}
}
@media (max-width:1000px){ .os-right{display:none} .os-brand-sub{display:none} }
@media (max-width:820px){
  .os-shell{position:fixed; overflow:hidden}
  .os-top{height:50px; padding:0 10px; gap:8px}
  .os-brand{gap:6px}
  .os-brand-name{font-size:14px}
  .os-brand-sub,.os-brand-div,.os-brand-tenant,.os-status,.os-ask-brain,.os-user-name,.os-top-actions .os-ic:nth-of-type(n+2){display:none}
  .os-top-actions{gap:9px}
  .os-credit{font-size:11px; padding:3px 8px}
  .os-mid{flex-direction:column; min-height:0}
  .os-left{width:100%; height:54px; flex-direction:row; align-items:center; overflow-x:auto; overflow-y:hidden; border-right:none; border-bottom:1px solid var(--b)}
  .os-left-title,.os-culture,.os-me{display:none}
  .os-left .ant-menu{display:flex !important; flex:0 0 auto; min-width:max-content}
  .os-left .ant-menu-item{height:38px !important; line-height:38px !important; margin:7px 4px !important; padding-inline:12px !important; flex-shrink:0}
  .os-center{flex:1; min-height:0; width:100%}
  .os-page-head{height:38px; padding:0 12px}
  .os-page-body{padding:10px; overflow:auto}
  .os-bottom{display:none}
}
`;
