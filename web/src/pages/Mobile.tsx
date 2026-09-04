// 移动端 H5：店长/一线员工在店内用手机也能完成派活、看进度、审阅与处理待办。
// 5 个底部 Tab：首页 / 派活 / 任务 / 待办 / 我的；「客户」「内容」并入首页二级入口。
// 全部复用 PC 端后端 API；PC 预览时居中 480px 模拟手机。各 Tab 拆成 components/mobile/*。
import { useState } from 'react';
import { Badge } from 'antd';
import {
  HomeOutlined,
  SendOutlined,
  UnorderedListOutlined,
  InboxOutlined,
  UserOutlined,
  QuestionCircleOutlined,
  ArrowLeftOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { getUser } from '../api/client';
import { useStoreVersion } from '../api/store-context';
import { useRealtimeEvents } from '../hooks/useRealtimeEvents';
import { useInboxCount } from '../components/InboxDrawer';
import StoreSwitcher from '../components/StoreSwitcher';
import RoleOnboarding from '../components/RoleOnboarding';
import FeatureGuideCenter from '../components/FeatureGuideCenter';
import MobileHome, { hasMobileHomeAccess } from '../components/mobile/MobileHome';
import MobileCustomers from '../components/mobile/MobileCustomers';
import MobileContent from '../components/mobile/MobileContent';
import MobileMe from '../components/mobile/MobileMe';
import MobileDispatch from '../components/mobile/MobileDispatch';
import MobileTasks from '../components/mobile/MobileTasks';
import MobileInbox from '../components/mobile/MobileInbox';
import { mobilePath, parseMobileLocation, tabOfView, type MobileTab } from '../components/mobile/mobileRoutes';
import './Mobile.css';

const TABS: { key: MobileTab; label: string; icon: JSX.Element }[] = [
  { key: 'home', label: '首页', icon: <HomeOutlined /> },
  { key: 'dispatch', label: '派活', icon: <SendOutlined /> },
  { key: 'tasks', label: '任务', icon: <UnorderedListOutlined /> },
  { key: 'inbox', label: '待办', icon: <InboxOutlined /> },
  { key: 'me', label: '我的', icon: <UserOutlined /> },
];

const SUBVIEW_TITLE: Record<string, string> = { customers: '客户', content: '内容' };

export default function Mobile() {
  const nav = useNavigate();
  const loc = useLocation();
  const user = getUser() || {};
  const mods: string[] = Array.isArray(user.modules) ? user.modules : [];
  const role = String(user.role || '');
  const { view, params } = parseMobileLocation(loc.pathname, loc.search);
  const storeVersion = useStoreVersion();

  // 实时事件流：移动端不在 MainLayout 内，这里自行挂载单例连接；断连时各处轮询自动恢复
  const { connected: realtimeConnected } = useRealtimeEvents();
  const inbox = useInboxCount(realtimeConnected);

  // 按企业开通的模块过滤 Tab：派活需 marshals；任务列表需 execution（只有 marshals 时仍可看刚派出的任务）
  const tabs = TABS.filter(tab => {
    if (tab.key === 'home') return hasMobileHomeAccess(mods, role);
    if (tab.key === 'dispatch') return mods.includes('marshals');
    if (tab.key === 'tasks') return mods.includes('execution') || mods.includes('marshals');
    return true;
  });
  const activeTab = tabOfView(view);
  const [onboardingNonce, setOnboardingNonce] = useState(0);
  const [featureGuideOpen, setFeatureGuideOpen] = useState(false);
  const goTab = (tab: MobileTab) => nav(mobilePath(tab));
  const isSubview = view === 'customers' || view === 'content';

  return (
    <div className="mobile-shell">
      <header data-onboarding="mobile-header" className="mobile-header">
        {isSubview ? (
          <button type="button" className="mobile-header-back" aria-label="返回首页" onClick={() => goTab('home')}>
            <ArrowLeftOutlined />
            <span>{SUBVIEW_TITLE[view]}</span>
          </button>
        ) : (
          <div className="mobile-header-brand">
            <div className="mobile-header-title">纳米Work · {user.tenant?.name || '餐饮门店'}</div>
            <StoreSwitcher stores={user.tenant?.stores || []} bound={user.storeId ?? null} />
          </div>
        )}
        <div className="mobile-header-actions">
          <span className="mobile-header-user">{user.name}</span>
          <button
            type="button"
            data-onboarding="help"
            aria-label="打开功能使用指引"
            onClick={() => setFeatureGuideOpen(true)}
            className="mobile-help-button"
          >
            <QuestionCircleOutlined />
          </button>
        </div>
      </header>

      <main data-onboarding="workspace" className="mobile-workspace" key={storeVersion}>
        {view === 'home' && <MobileHome nav={nav} user={user} mods={mods} inboxCount={inbox.count} />}
        {view === 'customers' && <MobileCustomers />}
        {view === 'content' && <MobileContent />}
        {view === 'dispatch' && <MobileDispatch nav={nav} params={params} />}
        {view === 'tasks' && (
          <MobileTasks nav={nav} params={params} mods={mods} user={user} realtimeConnected={realtimeConnected} />
        )}
        {view === 'inbox' && <MobileInbox nav={nav} onChanged={inbox.refresh} />}
        {view === 'me' && <MobileMe user={user} nav={nav} />}
      </main>

      <div data-onboarding="navigation" role="tablist" aria-label="底部导航" className="mobile-tabbar">
        {tabs.map(tab => {
          const active = activeTab === tab.key;
          const badge = tab.key === 'inbox' ? inbox.count : 0;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={badge ? `${tab.label}，${badge} 件待处理` : tab.label}
              className={`mobile-tab${active ? ' mobile-tab--active' : ''}`}
              onClick={() => goTab(tab.key)}
            >
              <Badge count={badge} size="small" overflowCount={99} offset={[4, 0]}>
                <span className="mobile-tab-icon">{tab.icon}</span>
              </Badge>
              <span className="mobile-tab-label">{tab.label}</span>
            </button>
          );
        })}
      </div>
      <RoleOnboarding
        user={user}
        modules={mods}
        navigate={path => nav(path)}
        manualOpenNonce={onboardingNonce}
        suspended={featureGuideOpen}
        compact
      />
      <FeatureGuideCenter
        open={featureGuideOpen}
        onClose={() => setFeatureGuideOpen(false)}
        currentPath="/m"
        modules={mods}
        role={user.role}
        navigate={path => nav(path)}
        compact
        contextKey={view}
        onOpenOnboarding={() => setOnboardingNonce(value => value + 1)}
      />
    </div>
  );
}
