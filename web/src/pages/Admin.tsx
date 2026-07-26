import { useEffect, useState } from 'react';
import {
  Alert, Avatar, Badge, Button, Checkbox, Col, DatePicker, Drawer, Empty, Form, Input, InputNumber,
  Modal, Row, Select, Space, Switch, Table, Tag, message,
} from 'antd';
import {
  ApiOutlined, AuditOutlined, CloudSyncOutlined, DashboardOutlined, DollarOutlined,
  EditOutlined, FireOutlined, GoldOutlined, PlusOutlined, RobotOutlined,
  RollbackOutlined, SafetyCertificateOutlined, TeamOutlined, ThunderboltOutlined, UserOutlined,
} from '@ant-design/icons';
import { api, fmtMoney, getUser, exportCsv } from '../api/client';
import { StatCard, Panel } from '../components/Kit';
import { Chart, CHART_COLORS, baseGrid, axisStyle } from '../components/Charts';

// ===== 常量与小工具 =====
const ROLE_NAME: Record<string, string> = { boss: '老板', ops_director: '管理层', sales: '员工', admin: '管理员', partner: '合伙人' };
const ROLE_COLOR: Record<string, string> = { boss: 'gold', ops_director: 'blue', sales: 'green', admin: 'purple', partner: 'orange' };
const ROLE_OPTIONS = Object.keys(ROLE_NAME).map(k => ({ value: k, label: ROLE_NAME[k] }));
const FEATURE_NAME: Record<string, string> = { 'content.image': 'AI图片生成', 'content.video': 'AI视频生成', 'data.export': '数据导出' };
// 积分流水类型（kind）：用于筛选与导出，看清"积分花在了什么上"
const KIND_LABEL: Record<string, string> = { text: '文本', image: '生图', video: '生视频', recharge: '充值/调整' };
const KIND_OPTS = Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }));
const MODE_TAG: Record<string, { c: string; t: string }> = {
  api: { c: 'blue', t: '真实API' }, template: { c: 'default', t: '模板' }, admin: { c: 'purple', t: '管理员调整' },
};
const MONO = 'SFMono-Regular, Consolas, Menlo, monospace';

const roleTag = (r: string) => <Tag color={ROLE_COLOR[r] || 'default'}>{ROLE_NAME[r] || r || '-'}</Tag>;
const statusTag = (s: string) => <Tag color={(s || '启用') === '启用' ? 'green' : 'red'}>{s || '启用'}</Tag>;

function FieldRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
      <div style={{ width: 96, fontSize: 12.5, color: 'var(--ui-text-2)', flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}
const chip = (label: string, val: React.ReactNode) => (
  <div key={label} style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
    <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ui-text)' }}>{val ?? 0}</div>
    <div style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{label}</div>
  </div>
);

const MENU = [
  { key: 'overview', label: '概览', icon: <DashboardOutlined /> },
  { key: 'users', label: '用户与组织', icon: <TeamOutlined /> },
  { key: 'perms', label: '角色与权限', icon: <SafetyCertificateOutlined /> },
  { key: 'marshals', label: '员工管理', icon: <RobotOutlined /> },
  { key: 'api', label: '接口管理', icon: <ApiOutlined /> },
  { key: 'credits', label: '积分管理', icon: <GoldOutlined /> },
  { key: 'logs', label: '日志与安全', icon: <AuditOutlined /> },
];

// ===== 主组件：自带整页布局（深色侧边栏 + 白色顶栏 + 浅灰主区）=====
export default function Admin() {
  const user = getUser();
  const [tab, setTab] = useState('overview');

  if (!user || !['boss', 'admin'].includes(user.role)) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--ui-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty description={
          <div style={{ color: 'var(--ui-text-2)' }}>
            当前账号无权访问管理后台（仅限老板 / 系统管理员）
            <div style={{ marginTop: 14 }}>
              <Button type="primary" icon={<RollbackOutlined />} onClick={() => (location.href = '/')}>返回前台</Button>
            </div>
          </div>
        } />
      </div>
    );
  }

  return (
    <div className="admin-shell">
      <style>{ADMIN_STYLES}</style>
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <img src="/brand/nanowork-icon.svg" alt="纳米Work" />
          <div className="admin-brand-copy">
            <div>纳米Work行业版</div>
            <span>管理后台 Admin</span>
          </div>
        </div>
        <nav className="admin-menu" aria-label="管理后台导航">
          {MENU.map(it => (
            <button type="button" key={it.key} onClick={() => setTab(it.key)}
              className={`admin-menu-item ${tab === it.key ? 'active' : ''}`}>{it.icon}<span>{it.label}</span></button>
          ))}
        </nav>
        <div className="admin-sidebar-foot">
          仅老板 / 管理员可访问<br />配置保存后即时生效
        </div>
      </aside>

      {/* 右侧：顶栏 + 内容 */}
      <div className="admin-main">
        <header className="admin-topbar">
          <div className="admin-topbar-title">管理后台 · 纳米Work行业版</div>
          <Space size={12} className="admin-topbar-actions">
            <Button size="small" icon={<RollbackOutlined />} onClick={() => (location.href = '/')}>返回前台</Button>
            <span className="admin-current-user"><UserOutlined /> {user.name}</span>
            {roleTag(user.role)}
          </Space>
        </header>
        <div className="admin-content">
          {tab === 'overview' && <Overview onTab={setTab} />}
          {tab === 'users' && <UsersOrg />}
          {tab === 'perms' && <Permissions />}
          {tab === 'marshals' && <MarshalsAdmin />}
          {tab === 'api' && <ApiConfig />}
          {tab === 'credits' && <CreditsAdmin />}
          {tab === 'logs' && <LogsSecurity />}
        </div>
      </div>
    </div>
  );
}

const ADMIN_STYLES = `
.admin-shell{display:flex;min-height:100dvh;background:var(--ui-bg)}
.admin-sidebar{width:220px;flex:0 0 220px;display:flex;flex-direction:column;position:sticky;top:0;height:100dvh;overflow-y:auto;user-select:none;color:#dbeaff;background:linear-gradient(180deg,#071d36 0%,#06182d 100%);border-right:1px solid #102d4b}
.admin-brand{display:flex;align-items:center;gap:10px;padding:18px 18px 14px;border-bottom:1px solid rgba(117,160,207,.16);margin-bottom:10px}
.admin-brand img{width:36px;height:36px;flex:0 0 auto;filter:drop-shadow(0 8px 16px rgba(0,0,0,.18))}
.admin-brand-copy{min-width:0}.admin-brand-copy>div{font-size:14px;font-weight:700;color:#fff;white-space:nowrap}.admin-brand-copy span{display:block;margin-top:2px;font-size:10.5px;color:#7695b6;white-space:nowrap}
.admin-menu{display:flex;flex:1;flex-direction:column}.admin-menu-item{display:flex;align-items:center;gap:10px;margin:2px 10px;padding:10px 14px;border:0;border-radius:8px;background:transparent;color:#a9bfd7;cursor:pointer;font:inherit;font-size:13.5px;font-weight:400;line-height:1.4;text-align:left;transition:background .18s,color .18s,transform .18s;white-space:nowrap}.admin-menu-item:hover{background:rgba(73,135,205,.13);color:#eef6ff}.admin-menu-item.active{background:linear-gradient(135deg,rgba(44,118,220,.94),rgba(11,83,158,.92));color:#fff;font-weight:600;box-shadow:0 9px 22px rgba(0,55,121,.22)}
.admin-sidebar-foot{margin-top:auto;padding:14px 18px;border-top:1px solid rgba(117,160,207,.14);color:#6f91b5;font-size:11px;line-height:1.8}
.admin-main{display:flex;flex:1;min-width:0;flex-direction:column}.admin-topbar{position:sticky;top:0;z-index:20;min-height:52px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 20px;background:var(--ui-surface);border-bottom:1px solid var(--ui-border)}.admin-topbar-title{color:var(--ui-text);font-size:15px;font-weight:600}.admin-current-user{color:var(--ui-text-2);font-size:13px}.admin-content{flex:1;min-width:0;padding:20px}
.admin-catalog-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;max-height:240px;overflow:auto}.admin-catalog-person{min-width:0;padding:9px 10px;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-surface-2)}.admin-catalog-person b,.admin-catalog-person span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.admin-catalog-person b{color:var(--ui-text);font-size:11.5px}.admin-catalog-person span{margin-top:2px;color:var(--ui-muted);font-size:10.5px}
@media(max-width:820px){.admin-shell{flex-direction:column}.admin-sidebar{position:relative;width:100%;height:auto;flex:0 0 auto;flex-direction:row;align-items:center;overflow-x:auto;overflow-y:hidden;border-right:0;border-bottom:1px solid #102d4b}.admin-brand{flex:0 0 auto;margin:0;padding:9px 12px;border:0;border-right:1px solid rgba(117,160,207,.16)}.admin-brand img{width:34px;height:34px}.admin-brand-copy span{display:none}.admin-menu{flex:0 0 auto;flex-direction:row}.admin-menu-item{flex:0 0 auto;margin:6px 3px;padding:9px 11px}.admin-sidebar-foot{display:none}.admin-topbar{padding:7px 12px}.admin-current-user{display:none}.admin-content{padding:12px}.admin-catalog-grid{grid-template-columns:1fr}}
@media(max-width:520px){.admin-brand-copy{display:none}.admin-topbar-title{font-size:13px}.admin-topbar-actions .ant-tag{display:none}}
`;

// ===== ① 概览（本企业口径：用量/消耗仅本企业；卡片可点击钻取看明细）=====
function Overview({ onTab }: { onTab: (k: string) => void }) {
  const [ov, setOv] = useState<any>({});
  const [stats, setStats] = useState<any>({ byDay: [], byFeature: [], byModel: [], byUser: [] });
  const [drill, setDrill] = useState<string | null>(null);
  const [active, setActive] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  useEffect(() => {
    api.get('/admin/overview').then(setOv);
    api.get('/admin/credits/stats').then(setStats);
  }, []);
  const byDay = [...(stats.byDay || [])].reverse();
  const u = ov.usage || {};
  const openActive = () => { api.get('/admin/active-today').then(setActive); setDrill('active'); };
  const openCalls = () => { api.get('/admin/credits/logs?size=30').then((d: any) => setLogs(d.rows || [])); setDrill('calls'); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Alert type="info" showIcon style={{ borderRadius: 10 }}
        message="本页用量 / 消耗 / 调用均为【本企业】数据；「今日花费」是按充值价折算的消耗金额（即你的支出）。点击卡片可查看明细。" />
      <Row gutter={[12, 12]}>
        <Col xs={12} md={8} xl={4}><StatCard icon={<TeamOutlined />} color="var(--ui-accent)" label="用户数" value={ov.users ?? '-'} suffix="人" onClick={() => onTab('users')} /></Col>
        <Col xs={12} md={8} xl={4}><StatCard icon={<ThunderboltOutlined />} color="#22c4a8" label="今日活跃" value={ov.activeToday ?? '-'} suffix="人" onClick={openActive} /></Col>
        <Col xs={12} md={8} xl={4}><StatCard icon={<GoldOutlined />} color="#8a7450" label="积分余额" value={(ov.totalCredits ?? 0).toLocaleString()} suffix="分" onClick={() => onTab('credits')} /></Col>
        <Col xs={12} md={8} xl={4}><StatCard icon={<FireOutlined />} color="#f6a02d" label="今日消耗积分" value={(ov.todayCredits ?? 0).toLocaleString()} suffix="分" onClick={() => setDrill('spend')} /></Col>
        <Col xs={12} md={8} xl={4}><StatCard icon={<DollarOutlined />} color="#f25b6b" label="今日花费" value={fmtMoney(ov.todaySpendYuan)} onClick={() => setDrill('spend')} /></Col>
        <Col xs={12} md={8} xl={4}><StatCard icon={<RobotOutlined />} color="#70757a" label="AI调用(累计)" value={(ov.aiCalls ?? 0).toLocaleString()} suffix="次" onClick={openCalls} /></Col>
      </Row>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={8}>
          <Panel title="AI通道状态 · 本企业用量" extra={<Badge status={ov.channel === 'yunwu' ? 'success' : 'warning'} />}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: ov.channel === 'yunwu' ? '#16a34a' : '#e0a253' }}>
                  {ov.channel === 'yunwu' ? '云雾API已连接' : '模板模式'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginTop: 2 }}>
                  {ov.channel === 'yunwu' ? 'AI调用走真实通道，按量计费扣积分' : '未配置API Key，AI输出为内置模板，不扣积分'}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
                {chip('文本调用', u.textCalls)}{chip('生图', u.images)}{chip('生视频', u.videos)}
                {chip('输入tokens', (u.input ?? 0).toLocaleString())}{chip('输出tokens', (u.output ?? 0).toLocaleString())}{chip('今日调用', ov.todayCalls)}
              </div>
              <div style={{ background: 'var(--ui-warning-surface)', borderRadius: 8, padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12.5, color: '#e0a253', fontWeight: 600 }}>待审批内容</span>
                <span style={{ fontSize: 18, fontWeight: 700, color: ov.pendingApprovals > 0 ? '#f25b6b' : '#16a34a' }}>{ov.pendingApprovals ?? 0} 条</span>
              </div>
            </div>
          </Panel>
        </Col>
        <Col xs={24} lg={16}>
          <Panel title="近14天积分消耗（本企业）">
            <Chart height={262} option={{
              tooltip: { trigger: 'axis', valueFormatter: (v: any) => `${v} 分` },
              grid: baseGrid,
              xAxis: { type: 'category', data: byDay.map((x: any) => (x.d || '').slice(5)), ...axisStyle },
              yAxis: { type: 'value', ...axisStyle },
              series: [{ name: '消耗积分', type: 'bar', barWidth: 16, data: byDay.map((x: any) => x.credits), itemStyle: { color: 'var(--ui-accent)', borderRadius: [4, 4, 0, 0] } }],
            }} />
          </Panel>
        </Col>
      </Row>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={13}>
          <Panel title="功能消耗排行（本企业）">
            <Table size="small" rowKey="feature" pagination={false} dataSource={stats.byFeature || []}
              columns={[
                { title: '功能', dataIndex: 'feature' },
                { title: '次数', dataIndex: 'n', align: 'right' },
                { title: '消耗积分', dataIndex: 'credits', align: 'right', render: (v: number) => <b>{(v ?? 0).toLocaleString()}</b> },
                { title: '折合人民币', dataIndex: 'yuan', align: 'right', render: (v: number) => `¥${(v ?? 0).toFixed(2)}` },
              ] as any} />
          </Panel>
        </Col>
        <Col xs={24} lg={11}>
          <Panel title="模型消耗分布（本企业）">
            <Chart height={250} option={{
              tooltip: { trigger: 'item', formatter: '{b}：{c} 分（{d}%）' },
              color: CHART_COLORS,
              series: [{
                type: 'pie', radius: ['42%', '68%'],
                itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
                label: { fontSize: 11, color: 'var(--ui-text-2)' },
                data: (stats.byModel || []).map((x: any) => ({ name: x.model, value: x.credits })),
              }],
            }} />
          </Panel>
        </Col>
      </Row>

      {/* 钻取：今日活跃员工 */}
      <Modal open={drill === 'active'} title="今日活跃员工" footer={null} onCancel={() => setDrill(null)} width={560}>
        <Table size="small" rowKey="user_id" pagination={false} dataSource={active}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="今日暂无活跃" /> }}
          columns={[
            { title: '员工', dataIndex: 'name', render: (v: string, r: any) => <>{v} {roleTag(r.role)}</> },
            { title: '操作次数', dataIndex: 'actions', align: 'right' },
            { title: '最近操作', dataIndex: 'last_action' },
            { title: '时间', dataIndex: 'last_at', render: (v: string) => (v || '').slice(11, 16) },
          ] as any} />
      </Modal>

      {/* 钻取：今日消耗明细（按功能 + 按员工）*/}
      <Modal open={drill === 'spend'} title="消耗明细（本企业）" footer={null} onCancel={() => setDrill(null)} width={680}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>按功能</div>
            <Table size="small" rowKey="feature" pagination={false} dataSource={stats.byFeature || []}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无消耗" /> }}
              columns={[
                { title: '功能', dataIndex: 'feature' },
                { title: '次数', dataIndex: 'n', align: 'right' },
                { title: '消耗积分', dataIndex: 'credits', align: 'right', render: (v: number) => (v ?? 0).toLocaleString() },
                { title: '折合人民币', dataIndex: 'yuan', align: 'right', render: (v: number) => `¥${(v ?? 0).toFixed(2)}` },
              ] as any} />
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>按员工</div>
            <Table size="small" rowKey="user_id" pagination={false} dataSource={stats.byUser || []}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无消耗" /> }}
              columns={[
                { title: '员工', dataIndex: 'name', render: (v: string) => v || '—' },
                { title: '次数', dataIndex: 'n', align: 'right' },
                { title: '消耗积分', dataIndex: 'credits', align: 'right', render: (v: number) => (v ?? 0).toLocaleString() },
                { title: '折合人民币', dataIndex: 'yuan', align: 'right', render: (v: number) => `¥${(v ?? 0).toFixed(2)}` },
              ] as any} />
          </div>
        </div>
      </Modal>

      {/* 钻取：AI调用流水 */}
      <Modal open={drill === 'calls'} title="最近 AI 调用流水（本企业）" footer={null} onCancel={() => setDrill(null)} width={720}>
        <Table size="small" rowKey="id" pagination={{ pageSize: 10, size: 'small' }} dataSource={logs}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无调用" /> }}
          columns={[
            { title: '时间', dataIndex: 'created_at', render: (v: string) => (v || '').slice(5, 16) },
            { title: '用户', dataIndex: 'user_name', render: (v: string) => v || '—' },
            { title: '功能', dataIndex: 'feature' },
            { title: '模型', dataIndex: 'model', render: (v: string) => v || '—' },
            { title: '积分', dataIndex: 'credits', align: 'right', render: (v: number) => v > 0 ? <b style={{ color: '#f25b6b' }}>-{v}</b> : <span style={{ color: '#16a34a' }}>+{-v}</span> },
            { title: '模式', dataIndex: 'ai_mode', render: (v: string) => <Tag color={MODE_TAG[v]?.c || 'default'}>{MODE_TAG[v]?.t || v}</Tag> },
          ] as any} />
      </Modal>
    </div>
  );
}

// ===== ② 用户与组织 =====
function UsersOrg() {
  const [users, setUsers] = useState<any[]>([]);
  const [org, setOrg] = useState<any[]>([]);
  const [modules, setModules] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>(null);
  const [permUser, setPermUser] = useState<any>(null);
  const [permChecked, setPermChecked] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [editForm] = Form.useForm();
  const [addForm] = Form.useForm();

  const load = () => { api.get('/admin/users').then(setUsers); api.get('/admin/org').then(setOrg); };
  useEffect(() => { load(); api.get('/admin/permissions').then((p: any) => setModules(p.modules || [])); }, []);

  const openEdit = (r: any) => { setEditing(r); editForm.setFieldsValue({ name: r.name, role: r.role, dept: r.dept, status: r.status || '启用', password: '' }); };
  const saveEdit = async () => {
    const v = await editForm.validateFields();
    const body: any = { name: v.name, role: v.role, dept: v.dept, status: v.status };
    if (v.password && v.password.trim()) body.password = v.password.trim();
    await api.put(`/admin/users/${editing.id}`, body);
    message.success(`已保存「${v.name}」${body.password ? '，密码已重置' : ''}`);
    setEditing(null); load();
  };

  const openPerm = (r: any) => { setPermUser(r); setPermChecked(r.effectiveModules || []); };
  const savePerm = async () => {
    await api.put(`/admin/users/${permUser.id}`, { modules: permChecked });
    message.success('已保存用户级菜单权限（覆盖优先于角色默认）');
    setPermUser(null); load();
  };
  const restorePerm = async () => {
    await api.put(`/admin/users/${permUser.id}`, { modules: null });
    message.success('已恢复继承角色默认菜单');
    setPermUser(null); load();
  };

  const addUser = async () => {
    const v = await addForm.validateFields();
    await api.post('/admin/users', v);
    message.success(`用户「${v.name}」已创建`);
    setAdding(false); addForm.resetFields(); load();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Panel title="用户列表" extra={<Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setAdding(true)}>新增用户</Button>}>
        <Table size="small" rowKey="id" dataSource={users} pagination={{ pageSize: 10, showSizeChanger: false }}
          columns={[
            { title: '用户名', dataIndex: 'username', render: (v: string) => <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{v}</span> },
            { title: '姓名', dataIndex: 'name', render: (v: string) => <b>{v}</b> },
            {
              title: '角色', dataIndex: 'role',
              render: (v: string, r: any) => <Space size={4}>{roleTag(v)}{r.modules ? <Tag color="geekblue" style={{ fontSize: 10 }}>菜单自定义</Tag> : null}</Space>,
            },
            { title: '部门', dataIndex: 'dept', render: (v: string) => v || '-' },
            { title: '本月AI消耗', dataIndex: 'ai_spent_month', align: 'right', render: (v: number) => <b>{(v ?? 0).toLocaleString()}</b> },
            { title: '状态', dataIndex: 'status', render: statusTag },
            { title: '最后登录', dataIndex: 'last_login_at', render: (v: string) => <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>{v || '-'}</span> },
            {
              title: '操作', key: 'op', width: 130,
              render: (_: any, r: any) => <Space size={10}><a onClick={() => openEdit(r)}>编辑</a><a onClick={() => openPerm(r)}>菜单权限</a></Space>,
            },
          ] as any} />
      </Panel>

      <Panel title="部门组织">
        <Row gutter={[12, 12]}>
          {org.map((d: any) => (
            <Col xs={24} sm={12} lg={8} key={d.dept || '未设部门'}>
              <div style={{ border: '1px solid var(--ui-border)', borderRadius: 10, padding: 14, height: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontWeight: 600, color: 'var(--ui-text)' }}>{d.dept || '未设部门'}</span>
                  <Tag color="blue">{d.n} 人</Tag>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {String(d.members || '').split(',').filter(Boolean).map((m: string) => <Tag key={m} style={{ marginRight: 0 }}>{m}</Tag>)}
                </div>
              </div>
            </Col>
          ))}
        </Row>
      </Panel>

      {/* 编辑用户 */}
      <Modal title={`编辑用户 · ${editing?.name || ''}`} open={!!editing} onCancel={() => setEditing(null)} onOk={saveEdit} okText="保存" forceRender>
        <Form form={editForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}><Input /></Form.Item>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="role" label="角色"><Select options={ROLE_OPTIONS} /></Form.Item></Col>
            <Col span={12}><Form.Item name="status" label="状态"><Select options={[{ value: '启用', label: '启用' }, { value: '禁用', label: '禁用' }]} /></Form.Item></Col>
          </Row>
          <Form.Item name="dept" label="部门"><Input placeholder="如：销售部" /></Form.Item>
          <Form.Item name="password" label="重置密码" rules={[{ min: 8, message: '至少8位' }]}><Input.Password placeholder="留空则不修改" autoComplete="new-password" /></Form.Item>
        </Form>
      </Modal>

      {/* 菜单权限（用户级覆盖） */}
      <Modal title={`菜单权限 · ${permUser?.name || ''}`} open={!!permUser} onCancel={() => setPermUser(null)}
        footer={[
          <Button key="restore" danger onClick={restorePerm}>恢复继承角色</Button>,
          <Button key="cancel" onClick={() => setPermUser(null)}>取消</Button>,
          <Button key="ok" type="primary" onClick={savePerm}>保存覆盖</Button>,
        ]}>
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          message="用户级覆盖优先于角色默认"
          description={permUser?.modules
            ? '该用户当前为「用户级自定义」菜单，保存后继续覆盖角色默认。'
            : `该用户当前继承角色「${ROLE_NAME[permUser?.role] || permUser?.role}」的默认菜单，保存后将转为用户级自定义。`} />
        <Checkbox.Group value={permChecked} onChange={v => setPermChecked(v as string[])}
          options={modules.map((m: any) => ({ label: m.name, value: m.key }))}
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }} />
      </Modal>

      {/* 新增用户 */}
      <Modal title="新增用户" open={adding} onCancel={() => setAdding(false)} onOk={addUser} okText="创建" forceRender>
        <Form form={addForm} layout="vertical" style={{ marginTop: 12 }} initialValues={{ role: 'sales', credits: 0 }}>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}><Input autoComplete="off" /></Form.Item></Col>
            <Col span={12}><Form.Item name="password" label="初始密码" rules={[{ required: true, message: '请输入密码' }, { min: 8, message: '至少8位' }]}><Input.Password autoComplete="new-password" /></Form.Item></Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}><Input /></Form.Item></Col>
            <Col span={12}><Form.Item name="role" label="角色"><Select options={ROLE_OPTIONS} /></Form.Item></Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="dept" label="部门"><Input placeholder="如：销售部" /></Form.Item></Col>
            <Col span={12}><Form.Item name="credits" label="同步增发企业共享积分"><InputNumber min={0} step={100} style={{ width: '100%' }} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
}

// ===== ③ 角色与权限（核心：权限勾选矩阵） =====
function Permissions() {
  const [meta, setMeta] = useState<any>(null);
  const [rm, setRm] = useState<Record<string, string[]>>({});
  const [ff, setFf] = useState<Record<string, string[]>>({});
  const [dm, setDm] = useState<Record<string, string[]>>({});

  const load = () => api.get('/admin/permissions').then((d: any) => { setMeta(d); setRm(d.roleModules || {}); setFf(d.featureFlags || {}); setDm(d.deptModules || {}); });
  useEffect(() => { load(); }, []);

  const toggleRm = (role: string, mod: string) => setRm(prev => {
    const list = prev[role] || [];
    return { ...prev, [role]: list.includes(mod) ? list.filter(x => x !== mod) : [...list, mod] };
  });
  const toggleFf = (feat: string, role: string) => setFf(prev => {
    const list = prev[feat] || [];
    return { ...prev, [feat]: list.includes(role) ? list.filter(x => x !== role) : [...list, role] };
  });
  const saveMatrix = () => api.put('/admin/permissions', { roleModules: rm }).then(() => { message.success('权限矩阵已保存，立即生效'); load(); });
  const saveFeatures = () => api.put('/admin/permissions', { featureFlags: ff }).then(() => { message.success('功能级权限已保存，立即生效'); load(); });
  const toggleDm = (dept: string, mod: string) => setDm(prev => {
    const list = prev[dept] || [];
    return { ...prev, [dept]: list.includes(mod) ? list.filter(x => x !== mod) : [...list, mod] };
  });
  const saveDept = () => api.put('/admin/permissions', { deptModules: dm }).then(() => { message.success('部门映射已保存：员工 = 角色基础包 ∪ 部门追加'); load(); });

  if (!meta) return <div style={{ padding: 60, textAlign: 'center', color: 'var(--ui-muted)' }}>加载中…</div>;
  const featKeys = Array.from(new Set([...Object.keys(FEATURE_NAME), ...Object.keys(ff)]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Alert type="info" showIcon message="双重校验机制"
        description="此处勾选同时控制：前端菜单隐藏 + 后端接口双重校验，保存后立即生效。如需对单个用户单独放开或收紧菜单，请到「用户与组织 → 菜单权限」设置用户级覆盖（优先于角色默认）。" />

      <Panel title="角色 × 模块 权限矩阵" extra={<Button type="primary" size="small" onClick={saveMatrix}>保存矩阵</Button>}>
        <Table size="small" rowKey="key" pagination={false} dataSource={meta.roles} scroll={{ x: 1000 }}
          columns={[
            {
              title: '角色 \\ 模块', dataIndex: 'name', fixed: 'left', width: 150,
              render: (v: string, r: any) => <><b style={{ color: 'var(--ui-text)' }}>{v}</b><div style={{ fontSize: 11, color: 'var(--ui-muted)', fontFamily: MONO }}>{r.key}</div></>,
            },
            ...meta.modules.map((m: any) => ({
              title: <div style={{ textAlign: 'center' as const }}>{m.name}</div>,
              key: m.key, align: 'center' as const,
              render: (_: any, r: any) => <Checkbox checked={(rm[r.key] || []).includes(m.key)} onChange={() => toggleRm(r.key, m.key)} />,
            })),
          ] as any} />
      </Panel>

      <Panel title="功能级权限" extra={<Button type="primary" size="small" onClick={saveFeatures}>保存功能权限</Button>}>
        <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginBottom: 10 }}>控制高成本AI能力与数据导出的角色开关（勾选 = 允许使用）</div>
        <Table size="small" rowKey="fkey" pagination={false} dataSource={featKeys.map(k => ({ fkey: k }))}
          columns={[
            {
              title: '功能', dataIndex: 'fkey', width: 220,
              render: (k: string) => <><b style={{ color: 'var(--ui-text)' }}>{FEATURE_NAME[k] || k}</b><div style={{ fontSize: 11, color: 'var(--ui-muted)', fontFamily: MONO }}>{k}</div></>,
            },
            ...meta.roles.map((role: any) => ({
              title: role.name, key: role.key, align: 'center' as const,
              render: (_: any, r: any) => <Checkbox checked={(ff[r.fkey] || []).includes(role.key)} onChange={() => toggleFf(r.fkey, role.key)} />,
            })),
          ] as any} />
      </Panel>

      <Panel title="员工部门映射（三级权限·员工层）" extra={<Button type="primary" size="small" onClick={saveDept}>保存部门映射</Button>}>
        <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginBottom: 10 }}>
          员工实际可见 = 员工角色基础包（总控台+经营执行） ∪ 所在部门追加模块。例：销售部员工自动追加「增长中心」。
        </div>
        <Table size="small" rowKey="dept" pagination={false}
          dataSource={Array.from(new Set([...(meta.depts || []), ...Object.keys(dm)])).map((d: string) => ({ dept: d }))}
          columns={[
            { title: '部门', dataIndex: 'dept', width: 150, render: (v: string) => <b style={{ color: 'var(--ui-text)' }}>{v}</b> },
            ...meta.modules.filter((m: any) => !['dashboard', 'system'].includes(m.key)).map((m: any) => ({
              title: <div style={{ textAlign: 'center' as const }}>{m.name}</div>,
              key: m.key, align: 'center' as const,
              render: (_: any, r: any) => <Checkbox checked={(dm[r.dept] || []).includes(m.key)} onChange={() => toggleDm(r.dept, m.key)} />,
            })),
          ] as any} />
      </Panel>
    </div>
  );
}

// ===== ④ 员工管理 =====
function MarshalsAdmin() {
  const [list, setList] = useState<any[]>([]);
  const [cur, setCur] = useState<any>(null);
  const [kbCats, setKbCats] = useState<string[]>([]);
  const [kbStat, setKbStat] = useState<Record<string, number>>({});
  const [form] = Form.useForm();

  const load = () => api.get('/admin/marshals').then(setList);
  useEffect(() => {
    load();
    api.get('/sys/kb/categories').then((c: string[]) => setKbCats(Array.isArray(c) ? c : [])).catch(() => {});
    api.get('/sys/kb').then((docs: any[]) => {
      const stat: Record<string, number> = {};
      (Array.isArray(docs) ? docs : []).forEach((d: any) => { if (d.enabled) stat[d.category] = (stat[d.category] || 0) + 1; });
      setKbStat(stat);
    }).catch(() => {});
  }, []);

  const toggleOnline = (m: any, v: boolean) =>
    api.put(`/admin/marshals/${m.id}`, { online: v }).then(() => { message.success(`${m.name} 已${v ? '上线' : '下线'}`); load(); });
  const openEdit = (m: any) => {
    setCur(m);
    form.setFieldsValue({
      name: m.name, title: m.title, duty: m.duty, skills: m.skills, prompt: m.prompt,
      kbDeps: String(m.kb_deps || '').split(/[,，、]/).filter(Boolean),
    });
  };
  const buildPayload = (v: any) => {
    const p = {
      ...v,
      kb_deps: (v.kbDeps || []).join(','),
    };
    delete p.kbDeps;
    return p;
  };
  const save = async () => {
    const v = await form.validateFields();
    const res = await api.put(`/admin/marshals/${cur.id}`, buildPayload(v));
    message.info(res.hint || '已保存');
    load();
  };
  const sync = async () => {
    const v = await form.validateFields();
    const saved = await api.put(`/admin/marshals/${cur.id}`, buildPayload(v));
    await api.post(`/admin/marshals/${cur.id}/sync`);
    message.success(saved.hint || '分部配置已同步，前台新调用立即生效');
    setCur(null); load();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Alert type="info" showIcon message="编辑保存为草稿，点击「同步到前台」后对新的AI调用生效（PRD §12 配置同步机制）。" />
      <Row gutter={[12, 12]}>
        {list.map(m => (
          <Col xs={24} sm={12} xl={8} key={m.id}>
            <div style={{ background: 'var(--ui-surface)', border: '1px solid var(--ui-border)', borderRadius: 10, padding: 16, height: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Avatar size={42} src={m.avatar || undefined} style={{ background: 'var(--ui-surface-2)', fontSize: 20, flexShrink: 0 }}>{m.emoji}</Avatar>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: 'var(--ui-text)' }}>{m.name} <Badge status={m.online ? 'success' : 'default'} /></div>
                  <div style={{ fontSize: 12, color: 'var(--ui-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.title}</div>
                </div>
                <Switch size="small" checked={!!m.online} onChange={v => toggleOnline(m, v)} />
              </div>
              <div style={{ fontSize: 12, color: 'var(--ui-text-2)', lineHeight: 1.6, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: 38 }}>{m.duty}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {String(m.skills || '').split(/[,，、]/).filter(Boolean).slice(0, 4).map((s: string) => <Tag key={s} color="blue" style={{ fontSize: 11, marginRight: 0 }}>{s.trim()}</Tag>)}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto', paddingTop: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--ui-muted)' }}><CloudSyncOutlined /> 最近同步：{m.synced_at || '未同步'}</span>
                <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(m)}>编辑</Button>
              </div>
            </div>
          </Col>
        ))}
      </Row>

      <Drawer title={cur ? <Space><Avatar size={24} src={cur.avatar || undefined} style={{ background: 'var(--ui-surface-2)', fontSize: 12 }}>{cur.emoji}</Avatar>编辑 · {cur.name}</Space> : '编辑餐饮分部'} width={560} open={!!cur} onClose={() => setCur(null)} forceRender
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Button onClick={() => setCur(null)}>取消</Button>
            <Space>
              <Button onClick={save}>保存草稿</Button>
              <Button type="primary" icon={<CloudSyncOutlined />} onClick={sync}>同步到前台</Button>
            </Space>
          </div>
        }>
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="这里只配置餐饮分部，不编辑数字员工目录"
          description="修改仅对本企业的分部定位、职责、能力、知识库和提示词生效；保存或同步都不会改名、重排或重新匹配 101—160 号权威数字员工。" />
        <Form form={form} layout="vertical">
          <Row gutter={12}>
            <Col span={12}><Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}><Input /></Form.Item></Col>
            <Col span={12}><Form.Item name="title" label="称号"><Input /></Form.Item></Col>
          </Row>
          <Form.Item name="duty" label="职责"><Input.TextArea rows={3} /></Form.Item>
          <Form.Item name="skills" label="能力标签（逗号分隔）"><Input placeholder="如：短视频脚本,朋友圈文案,社群话题" /></Form.Item>
          <Form.Item label={`权威员工目录（只读 · ${(cur?.specialists || []).length}人）`}
            extra="员工姓名、岗位、编号和分部归属由 restaurant.json 统一托管；如需调整目录，应走目录修订与校验流程。">
            <div className="admin-catalog-grid">
              {(cur?.specialists || []).map((employee: any) => (
                <div className="admin-catalog-person" key={employee.employee_idx || employee.id}>
                  <b>#{employee.employee_idx} · {employee.person || employee.name}</b>
                  <span>{employee.name} · {employee.status || '空闲'}</span>
                </div>
              ))}
            </div>
          </Form.Item>
          <Form.Item name="kbDeps" label={<span>📚 加载知识库（按分类勾选，<b style={{ color: '#16a34a' }}>自动跟随更新</b>）</span>}
            extra="勾选分类即可——该分类下的知识库文档无论后续怎么新增、修改、上传，员工对话/产出时都会实时引用最新的「已启用」文档，无需重新配置。括号内为该分类当前启用文档数（随数据库实时变化）。">
            <Checkbox.Group style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}
              options={kbCats.filter(c => c !== '员工产出').map(c => ({ label: `${c}（${kbStat[c] || 0}篇）`, value: c }))} />
          </Form.Item>
          <Form.Item name="prompt" label="系统提示词（System Prompt）">
            <Input.TextArea rows={8} style={{ fontFamily: MONO, fontSize: 12.5 }} />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}

// ===== ⑤ 接口管理 =====
function ApiConfig() {
  const [cfg, setCfg] = useState<any>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const saveKey = () => {
    setKeySaving(true);
    api.put('/admin/api-config', { apiKey: apiKeyInput.trim() || undefined, baseUrl })
      .then(() => { message.success('已保存并即时生效'); setApiKeyInput(''); setTestResult(null); load(); })
      .finally(() => setKeySaving(false));
  };
  const testConn = () => {
    setTesting(true); setTestResult(null);
    api.post('/admin/api-config/test', {}).then(setTestResult).finally(() => setTesting(false));
  };
  const [rt, setRt] = useState<any>(null);
  const [bl, setBl] = useState<any>(null);

  const load = () => api.get('/admin/api-config').then((d: any) => {
    setCfg(d); setBaseUrl(d.channel?.baseUrl || ''); setRt(d.routing || {}); setBl(d.billing || {});
  });
  useEffect(() => { load(); }, []);

  const save = () => api.put('/admin/api-config', { routing: rt, billing: bl, baseUrl })
    .then(() => { message.success('接口配置已保存，立即生效'); load(); });

  if (!cfg || !rt || !bl) return <div style={{ padding: 60, textAlign: 'center', color: 'var(--ui-muted)' }}>加载中…</div>;

  const setTextModel = (role: string, v: string) => setRt({ ...rt, text: { ...rt.text, [role]: v } });
  const setTextPrice = (model: string, field: 'in' | 'out', v: any) => setBl({ ...bl, text: { ...bl.text, [model]: { ...bl.text[model], [field]: v ?? 0 } } });
  const setImagePrice = (model: string, v: any) => setBl({ ...bl, image: { ...bl.image, [model]: v ?? 0 } });
  const setVideoPrice = (model: string, v: any) => setBl({ ...bl, video: { ...bl.video, [model]: v ?? 0 } });
  const setMin = (k: string, v: any) => setBl({ ...bl, minBalance: { ...bl.minBalance, [k]: v ?? 0 } });
  const usage = cfg.usage || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Row gutter={[12, 12]}>
        {/* A. 通道 */}
        <Col xs={24} lg={10}>
          <Panel title="A · AI通道" extra={<Badge status={cfg.channel.available ? 'success' : 'warning'} text={<span style={{ fontSize: 12 }}>{cfg.channel.available ? '已连接' : '未配置密钥'}</span>} />}>
            <FieldRow label="服务商">
              <span style={{ fontWeight: 600, color: 'var(--ui-text)' }}>{cfg.channel.provider}</span>
            </FieldRow>
            <FieldRow label="Base URL">
              <Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} style={{ fontFamily: MONO, fontSize: 12.5 }} />
            </FieldRow>
            <FieldRow label="API Key">
              <Input.Password value={apiKeyInput} onChange={e => setApiKeyInput(e.target.value)}
                placeholder={`当前：${cfg.channel.key}（输入新Key覆盖）`}
                style={{ fontFamily: MONO, fontSize: 12.5 }} autoComplete="new-password" />
            </FieldRow>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
              <Button size="small" type="primary" loading={keySaving} disabled={!apiKeyInput.trim() && baseUrl === (cfg.channel?.baseUrl || '')}
                onClick={saveKey}>保存密钥/地址（立即生效）</Button>
              <Button size="small" loading={testing} onClick={testConn}>🔌 测试连接</Button>
              {testResult && <Tag color={testResult.ok ? 'green' : 'red'} style={{ margin: 0 }}>
                {testResult.ok ? `✓ 连接成功（${testResult.models}个可用模型）` : `✗ ${testResult.error}`}</Tag>}
            </div>
            <div style={{ fontSize: 11, color: 'var(--ui-muted)', marginBottom: 10 }}>客户自助配置：在此粘贴自己的云雾 API Key 保存即生效（无需改服务器文件/重启）；密钥脱敏存储不回显明文。</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
              {chip('文本调用', usage.calls)}{chip('生图', usage.images)}{chip('生视频', usage.videos)}
              {chip('输入tokens', (usage.input ?? 0).toLocaleString())}{chip('输出tokens', (usage.output ?? 0).toLocaleString())}{chip('失败', usage.errors)}
            </div>
          </Panel>
        </Col>

        {/* B. 模型路由 */}
        <Col xs={24} lg={14}>
          <Panel title="B · 分层模型路由">
            {[['boss', '老板'], ['ops_director', '管理层'], ['sales', '员工']].map(([k, label]) => (
              <FieldRow key={k} label={<>文本 · {label}</>}>
                <Input value={rt.text?.[k]} onChange={e => setTextModel(k, e.target.value)} style={{ fontFamily: MONO, fontSize: 12.5 }} />
              </FieldRow>
            ))}
            <FieldRow label="图片模型">
              <Input value={rt.image} onChange={e => setRt({ ...rt, image: e.target.value })} style={{ fontFamily: MONO, fontSize: 12.5 }} />
            </FieldRow>
            <FieldRow label="视频模型清单">
              <Select mode="tags" value={rt.video || []} style={{ width: '100%' }}
                onChange={(v: string[]) => setRt({ ...rt, video: v, videoDefault: v.includes(rt.videoDefault) ? rt.videoDefault : v[0] })}
                tokenSeparators={[',', '，']} placeholder="输入模型名后回车添加" />
            </FieldRow>
            <FieldRow label="默认视频模型">
              <Select value={rt.videoDefault} style={{ width: '100%' }}
                options={(rt.video || []).map((m: string) => ({ value: m, label: m }))}
                onChange={(v: string) => setRt({ ...rt, videoDefault: v })} />
            </FieldRow>
            <div style={{ background: 'var(--ui-warning-surface)', borderRadius: 8, padding: '8px 10px', fontSize: 12, color: '#e0a253' }}>
              视频模型清单等客户提供截图后在此替换，新增/删除即时生效于「内容生产仓」。
            </div>
          </Panel>
        </Col>
      </Row>

      {/* C. 计费配置 */}
      <Panel title="C · 计费配置" extra={<span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>扣减公式：credits = ceil( 成本¥ × 利润系数 ÷ 积分单价 )</span>}>
        <Row gutter={[12, 12]} style={{ marginBottom: 14 }}>
          <Col xs={12} md={5}>
            <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>积分单价（元/积分）</div>
            <InputNumber value={bl.creditYuan} min={0.0001} step={0.001} style={{ width: '100%' }} onChange={v => setBl({ ...bl, creditYuan: v ?? 0.01 })} />
          </Col>
          <Col xs={12} md={5}>
            <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>利润系数</div>
            <InputNumber value={bl.marginMultiplier} min={1} step={0.1} style={{ width: '100%' }} onChange={v => setBl({ ...bl, marginMultiplier: v ?? 1.5 })} />
          </Col>
          {[['text', '文本'], ['image', '图片'], ['video', '视频']].map(([k, label]) => (
            <Col xs={8} md={4} key={k}>
              <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>最低余额 · {label}（分）</div>
              <InputNumber value={bl.minBalance?.[k]} min={0} style={{ width: '100%' }} onChange={v => setMin(k, v)} />
            </Col>
          ))}
        </Row>
        <Row gutter={[12, 12]}>
          <Col xs={24} lg={10}>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ui-text)', marginBottom: 8 }}>文本模型价格（¥/百万token）</div>
            <Table size="small" rowKey="model" pagination={false}
              dataSource={Object.keys(bl.text || {}).map(m => ({ model: m }))}
              columns={[
                { title: '模型', dataIndex: 'model', render: (v: string) => <span style={{ fontFamily: MONO, fontSize: 12 }}>{v === 'default' ? 'default（兜底）' : v}</span> },
                { title: '输入¥', key: 'in', width: 100, render: (_: any, r: any) => <InputNumber size="small" min={0} step={0.5} value={bl.text[r.model]?.in} onChange={v => setTextPrice(r.model, 'in', v)} style={{ width: '100%' }} /> },
                { title: '输出¥', key: 'out', width: 100, render: (_: any, r: any) => <InputNumber size="small" min={0} step={0.5} value={bl.text[r.model]?.out} onChange={v => setTextPrice(r.model, 'out', v)} style={{ width: '100%' }} /> },
              ] as any} />
          </Col>
          <Col xs={24} lg={7}>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ui-text)', marginBottom: 8 }}>图片单价（¥/张）</div>
            <Table size="small" rowKey="model" pagination={false}
              dataSource={Object.keys(bl.image || {}).map(m => ({ model: m }))}
              columns={[
                { title: '模型', dataIndex: 'model', render: (v: string) => <span style={{ fontFamily: MONO, fontSize: 12 }}>{v === 'default' ? 'default（兜底）' : v}</span> },
                { title: '单价¥', key: 'p', width: 110, render: (_: any, r: any) => <InputNumber size="small" min={0} step={0.1} value={bl.image[r.model]} onChange={v => setImagePrice(r.model, v)} style={{ width: '100%' }} /> },
              ] as any} />
          </Col>
          <Col xs={24} lg={7}>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ui-text)', marginBottom: 8 }}>视频单价（¥/条）</div>
            <Table size="small" rowKey="model" pagination={false}
              dataSource={Object.keys(bl.video || {}).map(m => ({ model: m }))}
              columns={[
                { title: '模型', dataIndex: 'model', render: (v: string) => <span style={{ fontFamily: MONO, fontSize: 12 }}>{v === 'default' ? 'default（兜底）' : v}</span> },
                { title: '单价¥', key: 'p', width: 110, render: (_: any, r: any) => <InputNumber size="small" min={0} step={1} value={bl.video[r.model]} onChange={v => setVideoPrice(r.model, v)} style={{ width: '100%' }} /> },
              ] as any} />
          </Col>
        </Row>
      </Panel>

      <div style={{ textAlign: 'right' }}>
        <Button type="primary" size="large" onClick={save}>保存配置</Button>
      </div>
    </div>
  );
}

// ===== ⑥ 积分管理 =====
function CreditsAdmin() {
  const [users, setUsers] = useState<any[]>([]);
  const [poolBalance, setPoolBalance] = useState(0);
  const [logs, setLogs] = useState<any>({ total: 0, rows: [] });
  const [filterUid, setFilterUid] = useState<number | undefined>(undefined);
  const [kind, setKind] = useState<string | undefined>(undefined);
  const [range, setRange] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<any>(null);
  const [form] = Form.useForm();

  const qs = () => {
    const p = new URLSearchParams();
    if (filterUid) p.set('userId', String(filterUid));
    if (kind) p.set('kind', kind);
    if (range[0]) p.set('from', range[0]);
    if (range[1]) p.set('to', range[1]);
    return p.toString();
  };
  const loadUsers = () => api.get('/admin/credits').then((data: any) => {
    if (Array.isArray(data)) { setUsers(data); setPoolBalance(Number(data[0]?.credits || 0)); return; }
    setUsers(data?.users || []); setPoolBalance(Number(data?.balance || 0));
  });
  const loadLogs = () => api.get(`/admin/credits/logs?page=${page}&size=15&${qs()}`).then(setLogs);
  useEffect(() => { loadUsers(); }, []);
  useEffect(() => {
    const p = new URLSearchParams();
    if (filterUid) p.set('userId', String(filterUid));
    if (kind) p.set('kind', kind);
    if (range[0]) p.set('from', range[0]);
    if (range[1]) p.set('to', range[1]);
    api.get(`/admin/credits/logs?page=${page}&size=15&${p.toString()}`).then(setLogs);
  }, [page, filterUid, kind, range]);

  const doExport = async () => {
    const d = await api.get(`/admin/credits/logs?export=1&${qs()}`);
    const rows = (d.rows || []).map((r: any) => [
      r.created_at, r.user_name || '', r.feature || '', KIND_LABEL[r.kind] || r.kind || '', r.model || '',
      `${r.input_tokens || 0}+${r.output_tokens || 0}`, r.credits > 0 ? r.credits : 0, r.credits < 0 ? -r.credits : 0,
      r.spend_yuan ?? '', r.balance_after, MODE_TAG[r.ai_mode]?.t || r.ai_mode,
    ]);
    exportCsv(`积分流水_${new Date().toISOString().slice(0, 10)}`,
      ['时间', '用户', '功能', '类型', '模型', 'tokens(入+出)', '消耗积分', '充值积分', '折合人民币', '余额', '模式'], rows);
    message.success(`已导出 ${rows.length} 条流水`);
  };

  const doAdjust = async () => {
    const v = await form.validateFields();
    const res = await api.post('/admin/credits/adjust', { userId: target.id, delta: v.delta, note: v.note || '' });
    message.success(`企业共享积分池已${v.delta >= 0 ? '增加' : '扣减'} ${Math.abs(v.delta)} 分，当前余额 ${res.balance} 分`);
    setTarget(null); form.resetFields(); loadUsers(); loadLogs();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Alert type="info" showIcon message="积分扣减规则"
        description="企业内账号共用一个积分池；每次AI调用仍按实际发起账号记流水，便于核算个人消耗。管理员增加或扣减会立即作用于企业共享余额。" />

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={9}>
          <Panel title="企业共享积分池" extra={<b style={{ color: 'var(--ui-primary)' }}>{poolBalance.toLocaleString()} 分</b>}>
            <Table size="small" rowKey="id" dataSource={users} pagination={{ pageSize: 8, showSizeChanger: false, size: 'small' }}
              columns={[
                { title: '用户', dataIndex: 'name', render: (v: string, r: any) => <><b>{v}</b><div style={{ fontSize: 11, color: 'var(--ui-muted)', fontFamily: MONO }}>{r.username}</div></> },
                { title: '角色', dataIndex: 'role', render: (v: string) => roleTag(v) },
                { title: '累计消耗', dataIndex: 'spent_credits', align: 'right', render: (v: number) => <b>{(v ?? 0).toLocaleString()}</b> },
                { title: '操作', key: 'op', width: 100, render: (_: any, r: any) => <a onClick={() => { setTarget(r); form.resetFields(); }}>调整共享池</a> },
              ] as any} />
          </Panel>
        </Col>
        <Col xs={24} lg={15}>
          <Panel title="积分流水" extra={
            <Space wrap size={6}>
              <Select allowClear showSearch placeholder="按用户" size="small" style={{ width: 140 }} optionFilterProp="label"
                options={users.map((u: any) => ({ value: u.id, label: `${u.name}（${u.username}）` }))}
                onChange={(v: any) => { setFilterUid(v); setPage(1); }} />
              <Select allowClear placeholder="按类型" size="small" style={{ width: 110 }} options={KIND_OPTS}
                onChange={(v: any) => { setKind(v); setPage(1); }} />
              <DatePicker.RangePicker size="small" style={{ width: 220 }}
                onChange={(d: any) => { setRange(d ? [d[0].format('YYYY-MM-DD'), d[1].format('YYYY-MM-DD')] : []); setPage(1); }} />
              <Button size="small" type="primary" ghost onClick={doExport} disabled={!logs.total}>导出CSV</Button>
            </Space>
          }>
            <Table size="small" rowKey="id" dataSource={logs.rows} scroll={{ x: 860 }}
              pagination={{ current: page, pageSize: 15, total: logs.total, onChange: (p: number) => setPage(p), showSizeChanger: false, size: 'small', showTotal: (t: number) => `共 ${t} 条` }}
              columns={[
                { title: '时间', dataIndex: 'created_at', width: 140, render: (v: string) => <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>{v}</span> },
                { title: '用户', dataIndex: 'user_name', width: 80 },
                { title: '功能', dataIndex: 'feature' },
                { title: '模型', dataIndex: 'model', render: (v: string) => v ? <span style={{ fontFamily: MONO, fontSize: 11.5 }}>{v}</span> : '-' },
                { title: '类型', dataIndex: 'kind', width: 64, render: (v: string) => KIND_LABEL[v] || v || '-' },
                { title: 'tokens（入+出）', key: 'tk', align: 'right', render: (_: any, r: any) => (r.input_tokens || r.output_tokens) ? `${r.input_tokens}+${r.output_tokens}` : '-' },
                { title: '折合人民币', dataIndex: 'spend_yuan', align: 'right', render: (v: number) => v == null ? '—' : `¥${v}` },
                {
                  title: '积分', dataIndex: 'credits', align: 'right',
                  render: (v: number) => v > 0
                    ? <b style={{ color: '#f25b6b' }}>-{v}</b>
                    : v < 0 ? <b style={{ color: '#16a34a' }}>+{Math.abs(v)}</b> : <span style={{ color: 'var(--ui-muted)' }}>0</span>,
                },
                { title: '余额', dataIndex: 'balance_after', align: 'right', render: (v: number) => (v ?? 0).toLocaleString() },
                { title: '模式', dataIndex: 'ai_mode', width: 96, render: (v: string) => <Tag color={MODE_TAG[v]?.c || 'default'}>{MODE_TAG[v]?.t || v}</Tag> },
              ] as any} />
          </Panel>
        </Col>
      </Row>

      <Modal title={target ? `调整企业共享积分池 · 记账账号：${target.name}` : ''}
        open={!!target} onCancel={() => setTarget(null)} onOk={doAdjust} okText="提交" forceRender>
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`当前企业共享余额：${poolBalance.toLocaleString()} 分`} />
          <Form.Item name="delta" label="调整额度（正数增加，负数扣减）"
            rules={[{ required: true, message: '请输入调整额度' }, { validator: (_: any, v: any) => (v === 0 ? Promise.reject(new Error('额度不能为0')) : Promise.resolve()) }]}>
            <InputNumber step={100} style={{ width: '100%' }} placeholder="如 1000 或 -500" />
          </Form.Item>
          <Form.Item name="note" label="备注"><Input placeholder="如：月度充值 / 误操作回收" /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ===== ⑦ 日志与安全 =====
function LogsSecurity() {
  const [sec, setSec] = useState<any>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [ops, setOps] = useState<any[]>([]);
  const [logins, setLogins] = useState<any[]>([]);

  useEffect(() => {
    api.get('/admin/security').then(setSec);
    api.get('/admin/media-jobs').then(setJobs);
    api.get('/sys/logs').then(setOps);
    api.get('/sys/login-logs').then(setLogins);
  }, []);

  const saveSec = () => api.put('/admin/security', sec).then(() => message.success('安全设置已保存'));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={8}>
          <Panel title="安全设置">
            {!sec ? <div style={{ padding: 30, textAlign: 'center', color: 'var(--ui-muted)' }}>加载中…</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <FieldRow label="Token有效期（小时）">
                  <InputNumber min={1} max={168} value={sec.tokenHours} onChange={v => setSec({ ...sec, tokenHours: v ?? 8 })} style={{ width: '100%' }} />
                </FieldRow>
                <FieldRow label="手机号脱敏">
                  <Switch checked={!!sec.maskPhone} onChange={v => setSec({ ...sec, maskPhone: v })} />
                  <span style={{ fontSize: 11, color: 'var(--ui-muted)', marginLeft: 8 }}>员工侧客户手机号显示为 138****8888</span>
                </FieldRow>
                <FieldRow label="可导出数据角色">
                  <Select mode="multiple" value={sec.exportRoles || []} options={ROLE_OPTIONS} style={{ width: '100%' }}
                    onChange={(v: string[]) => setSec({ ...sec, exportRoles: v })} />
                </FieldRow>
                <FieldRow label="登录失败锁定（次）">
                  <InputNumber min={3} max={20} value={sec.loginFailLock} onChange={v => setSec({ ...sec, loginFailLock: v ?? 5 })} style={{ width: '100%' }} />
                </FieldRow>
                <Button type="primary" block onClick={saveSec}>保存安全设置</Button>
              </div>
            )}
          </Panel>
        </Col>
        <Col xs={24} lg={16}>
          <Panel title="媒体任务（生图 / 生视频）">
            <Table size="small" rowKey="id" dataSource={jobs} scroll={{ x: 820 }} pagination={{ pageSize: 6, showSizeChanger: false, size: 'small' }}
              columns={[
                { title: '类型', dataIndex: 'kind', width: 70, render: (v: string) => <Tag color={v === 'image' ? 'blue' : 'purple'}>{v === 'image' ? '图片' : '视频'}</Tag> },
                { title: '模型', dataIndex: 'model', width: 130, render: (v: string) => <span style={{ fontFamily: MONO, fontSize: 11.5 }}>{v || '-'}</span> },
                { title: '提示词', dataIndex: 'prompt', ellipsis: true },
                { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => <Tag color={v === '成功' ? 'green' : v === '失败' ? 'red' : 'processing'}>{v}</Tag> },
                { title: '积分', dataIndex: 'credits', align: 'right', width: 70 },
                { title: '用户', dataIndex: 'user_name', width: 80 },
                { title: '时间', dataIndex: 'created_at', width: 140, render: (v: string) => <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>{v}</span> },
                {
                  title: '预览', key: 'pv', width: 80,
                  render: (_: any, r: any) => r.url && r.kind === 'image'
                    ? <img src={r.url} alt="" height={40} style={{ borderRadius: 4, display: 'block' }} />
                    : r.url ? <a href={r.url} target="_blank" rel="noreferrer">链接</a> : '-',
                },
              ] as any} />
          </Panel>
        </Col>
      </Row>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={13}>
          <Panel title="操作日志">
            <Table size="small" rowKey="id" dataSource={ops} pagination={{ pageSize: 10, showSizeChanger: false, size: 'small' }}
              columns={[
                { title: '时间', dataIndex: 'created_at', width: 140, render: (v: string) => <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>{v}</span> },
                { title: '用户', dataIndex: 'username', width: 90 },
                { title: '模块', dataIndex: 'module', width: 90, render: (v: string) => <Tag>{v}</Tag> },
                { title: '操作', dataIndex: 'action' },
                { title: '对象', dataIndex: 'target', ellipsis: true },
                { title: 'IP', dataIndex: 'ip', width: 110, render: (v: string) => <span style={{ fontFamily: MONO, fontSize: 11.5 }}>{v || '-'}</span> },
              ] as any} />
          </Panel>
        </Col>
        <Col xs={24} lg={11}>
          <Panel title="登录日志">
            <Table size="small" rowKey="id" dataSource={logins} pagination={{ pageSize: 10, showSizeChanger: false, size: 'small' }}
              columns={[
                { title: '时间', dataIndex: 'created_at', width: 140, render: (v: string) => <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>{v}</span> },
                { title: '用户名', dataIndex: 'username', width: 90 },
                { title: '结果', dataIndex: 'success', width: 70, render: (v: number) => <Tag color={v ? 'green' : 'red'}>{v ? '成功' : '失败'}</Tag> },
                { title: 'IP', dataIndex: 'ip', width: 110, render: (v: string) => <span style={{ fontFamily: MONO, fontSize: 11.5 }}>{v || '-'}</span> },
                { title: '设备', dataIndex: 'ua', ellipsis: true, render: (v: string) => <span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{v || '-'}</span> },
              ] as any} />
          </Panel>
        </Col>
      </Row>
    </div>
  );
}
