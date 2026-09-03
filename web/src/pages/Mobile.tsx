// 移动端 H5（私域命脉）：底部 Tab 精简版，聚焦手机高频场景——看数据 / 跟客户 / 发素材 / 我的
// 复用 PC 端全部后端 API，移动优先卡片式布局；PC 预览时居中 480px 模拟手机
import { useEffect, useRef, useState } from 'react';
import { List, Card, Button, Drawer, Input, Tag, Spin, Empty, message, Avatar } from 'antd';
import {
  HomeOutlined,
  TeamOutlined,
  ExperimentOutlined,
  UserOutlined,
  DollarOutlined,
  RiseOutlined,
  ClockCircleOutlined,
  CalendarOutlined,
  MessageOutlined,
  CopyOutlined,
  LogoutOutlined,
  DesktopOutlined,
  AppstoreOutlined,
  ToolOutlined,
  BarChartOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api, getUser, clearAuth, fmtMoney, notifyCredits } from '../api/client';
import { stageColor, gradeColor } from '../components/Kit';
import { Markdown } from '../components/Markdown';
import { useQuery, QueryStatus } from '../hooks/useQuery';
import RoleOnboarding from '../components/RoleOnboarding';
import FeatureGuideCenter from '../components/FeatureGuideCenter';
import type { DashboardSummary, DashboardBriefing, Lead, ContentItem } from '../api/types';
import './Mobile.css';

const TABS = [
  { key: 'home', label: '首页', icon: <HomeOutlined />, mod: 'dashboard' },
  { key: 'customers', label: '客户', icon: <TeamOutlined />, mod: 'growth' },
  { key: 'content', label: '内容', icon: <ExperimentOutlined />, mod: 'content' },
  { key: 'me', label: '我的', icon: <UserOutlined />, mod: null },
];

export default function Mobile() {
  const nav = useNavigate();
  const user = getUser() || {};
  // 按企业开通的模块权限过滤底部 Tab（无 growth 权限的员工不显示「客户」，无 content 不显示「内容」）
  const mods: string[] = Array.isArray(user.modules) ? user.modules : [];
  const hasHomeAccess =
    mods.includes('dashboard') ||
    CORE_WORKSPACES.some(item => mods.includes(item.mod) && item.roles.includes(String(user.role || '')));
  const tabs = TABS.filter(t => (t.key === 'home' ? hasHomeAccess : !t.mod || mods.includes(t.mod)));
  const [tab, setTab] = useState(tabs[0]?.key || 'me');
  const [onboardingNonce, setOnboardingNonce] = useState(0);
  const [featureGuideOpen, setFeatureGuideOpen] = useState(false);

  return (
    <div
      style={{
        maxWidth: 480,
        margin: '0 auto',
        minHeight: '100vh',
        background: 'var(--ui-surface-2)',
        position: 'relative',
        boxShadow: '0 0 24px rgba(0,0,0,.06)',
      }}
    >
      {/* 顶栏 */}
      <div
        data-onboarding="mobile-header"
        style={{
          background: 'var(--ui-surface)',
          color: 'var(--ui-text)',
          borderBottom: '1px solid var(--ui-border)',
          padding: '14px 16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 16 }}>纳米Work · {user.tenant?.name || '餐饮门店'}</div>
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
      </div>

      <div data-onboarding="workspace" className="mobile-workspace">
        {tab === 'home' && <MHome nav={nav} user={user} mods={mods} />}
        {tab === 'customers' && <MCustomers />}
        {tab === 'content' && <MContent />}
        {tab === 'me' && <MMe user={user} nav={nav} />}
      </div>

      {/* 底部 TabBar（role=tablist + 键盘可达） */}
      <div
        data-onboarding="navigation"
        role="tablist"
        aria-label="底部导航"
        style={{
          position: 'fixed',
          bottom: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          width: '100%',
          maxWidth: 480,
          background: 'var(--ui-surface)',
          borderTop: '1px solid var(--ui-border)',
          display: 'flex',
          height: 60,
          zIndex: 20,
        }}
      >
        {tabs.map(t => (
          <div
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            tabIndex={0}
            onClick={() => setTab(t.key)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setTab(t.key);
              }
            }}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              color: tab === t.key ? 'var(--ui-accent)' : 'var(--ui-muted)',
              cursor: 'pointer',
            }}
          >
            <span style={{ fontSize: 19 }}>{t.icon}</span>
            <span style={{ fontSize: 11 }}>{t.label}</span>
          </div>
        ))}
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
        contextKey={tab}
        onOpenOnboarding={() => setOnboardingNonce(value => value + 1)}
      />
    </div>
  );
}

function Stat({ icon, color, label, value, suffix }: any) {
  return (
    <Card size="small" styles={{ body: { padding: 12 } }} style={{ borderRadius: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 9,
            background: `color-mix(in srgb, ${color} 10%, transparent)`,
            color,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
          }}
        >
          {icon}
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{label}</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--ui-text)' }}>
            {value}
            <span style={{ fontSize: 11, color: 'var(--ui-muted)', marginLeft: 2 }}>{suffix}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

const CORE_WORKSPACES = [
  {
    key: 'employees',
    mod: 'marshals',
    roles: ['boss', 'ops_director', 'manager', 'sales'],
    title: '餐饮数字员工',
    description: '查看岗位数字员工与当前状态',
    path: '/employees',
    icon: <AppstoreOutlined />,
    color: '#1769e0',
  },
  {
    key: 'execution',
    mod: 'execution',
    roles: ['boss', 'ops_director', 'manager', 'sales', 'partner', 'admin'],
    title: '任务看板',
    description: '接收、完成并提交本人或团队任务',
    path: '/execution',
    icon: <ClockCircleOutlined />,
    color: '#c07020',
  },
  {
    key: 'toolbox',
    mod: 'content',
    roles: ['boss', 'ops_director', 'manager', 'sales'],
    title: '经营工具箱',
    description: '按经营场景调用实战工具',
    path: '/toolbox',
    icon: <ToolOutlined />,
    color: '#0f9f89',
  },
  {
    key: 'content',
    mod: 'content',
    roles: ['boss', 'ops_director', 'manager', 'sales'],
    title: '内容生产仓',
    description: '进入选题、生产与内容管理',
    path: '/content',
    icon: <ExperimentOutlined />,
    color: '#7a5bd8',
  },
  {
    key: 'analysis',
    mod: 'analysis',
    roles: ['boss', 'ops_director', 'manager'],
    title: '经营分析',
    description: '查看门店数据与经营洞察',
    path: '/analysis',
    icon: <BarChartOutlined />,
    color: '#d27b20',
  },
];

function MHome({ nav, user, mods }: { nav: (path: string) => void; user: any; mods: string[] }) {
  // useQuery：loading/empty/error/retry 四态，失败可见可重试（此前 .catch(()=>{}) 会永远转圈）
  const hasDashboard = mods.includes('dashboard');
  const canViewManagementBriefing = hasDashboard && ['boss', 'ops_director', 'manager', 'admin'].includes(user.role);
  const workspaces = CORE_WORKSPACES.filter(item => mods.includes(item.mod) && item.roles.includes(user.role));
  const summaryQ = useQuery<DashboardSummary>('/dashboard/summary', [], { enabled: hasDashboard });
  const briefQ = useQuery<DashboardBriefing>('/dashboard/briefing', [], {
    enabled: canViewManagementBriefing,
    isEmpty: d => !d?.briefing?.length,
  });
  const s = summaryQ.data;
  if (hasDashboard && !s) return <QueryStatus q={summaryQ} height={200} />;
  const briefing = briefQ.data?.briefing || [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {s && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Stat icon={<DollarOutlined />} color="var(--ui-accent)" label="今日销售" value={fmtMoney(s.todaySales)} />
          <Stat icon={<RiseOutlined />} color="var(--chart-2)" label="本月新客" value={s.monthLeads ?? 0} suffix="人" />
          <Stat
            icon={<ClockCircleOutlined />}
            color="var(--warn)"
            label="待跟进"
            value={s.pendingFollow ?? 0}
            suffix="人"
          />
          <Stat
            icon={<CalendarOutlined />}
            color="var(--chart-3)"
            label="进行活动"
            value={s.runningActivities ?? 0}
            suffix="场"
          />
        </div>
      )}
      {workspaces.length > 0 && (
        <Card size="small" title="核心工作台" style={{ borderRadius: 12 }} styles={{ body: { padding: 10 } }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
            {workspaces.map(item => (
              <button
                key={item.key}
                type="button"
                onClick={() => nav(item.path)}
                aria-label={`进入${item.title}`}
                style={{
                  minWidth: 0,
                  padding: 11,
                  border: '1px solid var(--ui-border)',
                  borderRadius: 10,
                  background: 'var(--ui-surface)',
                  color: 'var(--ui-text)',
                  textAlign: 'left',
                  cursor: 'pointer',
                  font: 'inherit',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 7, color: item.color, fontSize: 17 }}>
                  {item.icon}
                  <strong style={{ color: 'var(--ui-text)', fontSize: 13 }}>{item.title}</strong>
                </span>
                <span
                  style={{ display: 'block', marginTop: 6, color: 'var(--ui-muted)', fontSize: 11, lineHeight: 1.45 }}
                >
                  {item.description}
                </span>
              </button>
            ))}
          </div>
        </Card>
      )}
      {canViewManagementBriefing && (
        <Card size="small" title="🎯 今日经营简报" style={{ borderRadius: 12 }} styles={{ body: { padding: 12 } }}>
          {briefing.length ? (
            briefing.map((b, i) => (
              <div
                key={i}
                style={{
                  fontSize: 12.5,
                  color: 'var(--ui-text-2)',
                  lineHeight: 1.7,
                  padding: '5px 0',
                  borderBottom: i < briefing.length - 1 ? '1px solid var(--ui-surface-2)' : 'none',
                }}
              >
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

function MCustomers() {
  const leadsQ = useQuery<{ rows: Lead[] }>('/growth/leads?size=30&sort=follow');
  const rows = leadsQ.data?.rows || [];
  const [cur, setCur] = useState<Lead | null>(null);
  const [detail, setDetail] = useState<Lead | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const detailRequestRef = useRef(0);
  const [note, setNote] = useState('');
  const [ai, setAi] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const loadDetail = (lead: Lead) => {
    const serial = ++detailRequestRef.current;
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    api
      .get(`/growth/leads/${lead.id}`, { silent: true })
      .then(data => {
        if (serial === detailRequestRef.current) setDetail(data);
      })
      .catch((error: any) => {
        if (serial === detailRequestRef.current) setDetailError(error?.message || '客户详情加载失败');
      })
      .finally(() => {
        if (serial === detailRequestRef.current) setDetailLoading(false);
      });
  };
  const open = (r: Lead) => {
    setCur(r);
    setNote('');
    setAi('');
    loadDetail(r);
  };
  const addFollow = () => {
    if (!note.trim() || saving || !cur) return; // 防连点重复提交
    setSaving(true);
    api
      .post(`/growth/leads/${cur.id}/follow`, { content: note })
      .then(() => {
        message.success('已记录跟进');
        setNote('');
        return api.get(`/growth/leads/${cur.id}`).then(setDetail);
      })
      .finally(() => setSaving(false));
  };
  const genReply = () => {
    if (!cur) return;
    setAiLoading(true);
    api
      .post('/growth/suggest-reply', { leadId: cur.id, context: cur.interest || '客户咨询' })
      .then(r => {
        setAi(r.suggestions || '');
        if (!r.suggestions) message.info('暂无话术建议，可补充客户兴趣点后重试');
        notifyCredits(r.billing?.balance);
      })
      .finally(() => setAiLoading(false));
  };
  if (leadsQ.loading || leadsQ.error) return <QueryStatus q={leadsQ} height={200} />;
  return (
    <>
      <List
        dataSource={rows}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无客户" /> }}
        renderItem={(r: Lead) => (
          <Card
            size="small"
            style={{ borderRadius: 12, marginBottom: 8 }}
            styles={{ body: { padding: 12 } }}
            onClick={() => open(r)}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{r.name}</span>
                <Tag color={gradeColor[r.grade] || 'default'} style={{ marginLeft: 6, fontSize: 10 }}>
                  {r.grade}类
                </Tag>
              </div>
              <Tag color={stageColor[r.stage] || 'default'} style={{ margin: 0 }}>
                {r.stage}
              </Tag>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', marginTop: 4 }}>
              {r.identity_tag || '—'} · {r.interest || '暂无兴趣点'} · 评分{r.score}
            </div>
          </Card>
        )}
      />
      <Drawer
        open={!!cur}
        placement="bottom"
        height="86%"
        onClose={() => {
          detailRequestRef.current += 1;
          setCur(null);
          setDetail(null);
          setDetailError('');
          setDetailLoading(false);
        }}
        title={cur ? `${cur.name}（${cur.grade}类 · ${cur.stage}）` : ''}
      >
        {detailLoading ? (
          <Spin />
        ) : detailError ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={detailError}>
            <Button type="primary" disabled={!cur} onClick={() => cur && loadDetail(cur)}>
              重新加载
            </Button>
          </Empty>
        ) : !detail ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="客户详情证据未返回" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Card size="small" style={{ borderRadius: 10 }}>
              <div style={{ fontSize: 12.5, lineHeight: 2, color: 'var(--ui-text-2)' }}>
                <div>
                  📱 {detail.phone || '—'} ｜ 来源：{detail.source || '—'}
                </div>
                <div>
                  💰 预算：{detail.budget_level} ｜ 成交概率：{detail.score}分
                </div>
                {detail.next_action && <div>👉 下一步：{detail.next_action}</div>}
              </div>
            </Card>
            <div>
              <Button
                type="primary"
                block
                icon={<MessageOutlined />}
                loading={aiLoading}
                onClick={genReply}
                style={{ background: 'var(--ui-primary)', border: 'none' }}
              >
                AI 生成跟进话术
              </Button>
              {ai && (
                <Card size="small" style={{ marginTop: 8, borderRadius: 10, background: 'var(--ui-surface-2)' }}>
                  <div style={{ fontSize: 12.5, lineHeight: 1.8, color: 'var(--ui-text-2)' }}>
                    <Markdown content={ai} />
                  </div>
                  <Button
                    size="small"
                    icon={<CopyOutlined />}
                    style={{ marginTop: 6 }}
                    onClick={() => {
                      navigator.clipboard?.writeText(ai);
                      message.success('已复制');
                    }}
                  >
                    复制
                  </Button>
                </Card>
              )}
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>记一笔跟进</div>
              <Input.TextArea
                rows={2}
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="今天和客户聊了什么…"
              />
              <Button type="primary" block loading={saving} style={{ marginTop: 8 }} onClick={addFollow}>
                保存跟进
              </Button>
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                跟进记录（{(detail.follows || []).length}）
              </div>
              {(detail.follows || []).slice(0, 6).map((f: any, i: number) => (
                <div
                  key={i}
                  style={{
                    fontSize: 12,
                    color: 'var(--ui-text-2)',
                    padding: '5px 0',
                    borderBottom: '1px solid var(--ui-surface-2)',
                  }}
                >
                  <span style={{ color: 'var(--ui-muted)' }}>{(f.created_at || '').slice(5, 16)}</span> {f.content}
                </div>
              ))}
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}

function MContent() {
  const contentQ = useQuery<{ rows: ContentItem[] }>(
    '/content/list?status=' + encodeURIComponent('可使用') + '&size=30',
  );
  if (contentQ.loading || contentQ.error) return <QueryStatus q={contentQ} height={200} />;
  const usableRows = (contentQ.data?.rows || []).filter(item => item.delivery?.canUse === true);
  return (
    <List
      dataSource={usableRows}
      locale={{
        emptyText: (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无已人工采纳内容，请先到内容生产仓生成并完成审阅"
          />
        ),
      }}
      renderItem={(r: ContentItem) => (
        <Card size="small" style={{ borderRadius: 12, marginBottom: 8 }} styles={{ body: { padding: 12 } }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <Tag color="blue" style={{ margin: 0 }}>
              {r.type}
            </Tag>
            <Button
              size="small"
              icon={<CopyOutlined />}
              disabled={r.delivery?.canUse !== true}
              onClick={() => {
                navigator.clipboard?.writeText(r.body || '');
                message.success('已复制，去微信粘贴发布');
              }}
            >
              复制发圈
            </Button>
          </div>
          <div
            style={{ fontSize: 12.5, color: 'var(--ui-text-2)', lineHeight: 1.7, maxHeight: 120, overflow: 'hidden' }}
          >
            {r.body}
          </div>
        </Card>
      )}
    />
  );
}

function MMe({ user, nav }: any) {
  const [bal, setBal] = useState<any>(null);
  useEffect(() => {
    if (user.role === 'boss')
      api
        .get('/recharge/balance')
        .then(setBal)
        .catch(() => {});
  }, [user.role]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card style={{ borderRadius: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Avatar
            size={48}
            style={{ background: 'var(--ui-primary)', color: 'var(--ui-on-primary)' }}
            icon={<UserOutlined />}
          />
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{user.name}</div>
            <div style={{ fontSize: 12, color: 'var(--ui-muted)' }}>
              {user.tenant?.name} ·{' '}
              {{
                boss: '老板',
                ops_director: '运营负责人',
                manager: '管理层',
                sales: '员工',
                admin: '系统管理员',
                partner: '合作伙伴',
              }[user.role as string] || '员工'}
            </div>
          </div>
        </div>
      </Card>
      {bal && (
        <Card size="small" style={{ borderRadius: 12 }} title="💰 企业积分">
          <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--ui-accent)' }}>
            {(bal.credits ?? 0).toLocaleString()}
            <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}> 分</span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', marginTop: 4 }}>
            累计充值 {(bal.totalRecharged ?? 0).toLocaleString()} · 已消耗 {(bal.totalSpent ?? 0).toLocaleString()}
          </div>
        </Card>
      )}
      <Button block icon={<DesktopOutlined />} onClick={() => nav('/')}>
        切换到电脑版（功能更全）
      </Button>
      <Button
        block
        danger
        icon={<LogoutOutlined />}
        onClick={() => {
          clearAuth();
          nav('/login');
        }}
      >
        退出登录
      </Button>
      <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--ui-muted)', marginTop: 8 }}>
        纳米Work行业版 · 移动版
      </div>
    </div>
  );
}
