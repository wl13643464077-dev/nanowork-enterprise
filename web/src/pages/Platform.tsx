import { useCallback, useEffect, useState } from 'react';
import { Row, Col, Table, Tag, Button, Modal, Form, Input, InputNumber, Select, Checkbox, message, Segmented, Empty, Switch, Space, DatePicker } from 'antd';
import { useNavigate } from 'react-router-dom';
import { ShopOutlined, AuditOutlined, WalletOutlined, AppstoreOutlined, LogoutOutlined, DollarOutlined } from '@ant-design/icons';
import { api, clearAuth, exportCsv } from '../api/client';

// 积分流水类型（与企业内一致）
const KIND_LABEL: Record<string, string> = { text: '文本', image: '生图', video: '生视频', recharge: '充值/调整' };
const KIND_OPTS = Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }));
import { StatCard, Panel, ErrorState } from '../components/Kit';

const MOD_NAME: Record<string, string> = {
  dashboard: '总控台', advisor: '老板参谋', marshals: '餐饮数字员工', growth: '增长中心', activities: '活动中心',
  content: '内容生产仓', execution: '经营执行', analysis: '经营分析', assets: '数据资产', system: '系统管理',
};
const ALL_MODULES = Object.keys(MOD_NAME);
const PLANS = ['基础版', '标准版', '旗舰版'];
const parseModules = (value: any): string[] => {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : ALL_MODULES;
  } catch {
    return ALL_MODULES;
  }
};

export default function Platform() {
  const nav = useNavigate();
  const [tab, setTab] = useState('开通管理');
  const [ov, setOv] = useState<any>({});
  const [ana, setAna] = useState<any>(null);
  const [tenants, setTenants] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [packages, setPackages] = useState<any[]>([]);
  const [approve, setApprove] = useState<any>(null);
  const [pkgEdit, setPkgEdit] = useState<any>(null);
  const [aForm] = Form.useForm();
  const [pForm] = Form.useForm();

  const [loadError, setLoadError] = useState(false);
  const loadAll = () => {
    setLoadError(false);
    // 五路数据并发拉取；全部失败视为整页失败，显示错误态而不是"一切正常但没数据"
    Promise.allSettled([
      api.get('/platform/overview').then(setOv),
      api.get('/platform/analytics').then(setAna),
      api.get('/platform/tenants').then(setTenants),
      api.get('/platform/recharge-orders').then(setOrders),
      api.get('/platform/packages').then(setPackages),
    ]).then(results => {
      if (results.every(r => r.status === 'rejected')) setLoadError(true);
    });
  };
  useEffect(() => { loadAll(); }, []);

  const openApprove = (t: any) => {
    setApprove(t);
    aForm.setFieldsValue({ modules: t.modules ? parseModules(t.modules) : ALL_MODULES, plan: t.plan || '标准版', seatLimit: t.seat_limit || 50, grantCredits: t.status === '待审核' ? 10000 : 0 });
  };
  const submitApprove = () => aForm.validateFields().then(v => {
    api.post(`/platform/tenants/${approve.id}/approve`, v).then(() => {
      message.success(approve.status === '待审核' ? '账号已开通' : '已更新'); setApprove(null); loadAll();
    });
  });
  const setStatus = (t: any, status: string) =>
    api.post(`/platform/tenants/${t.id}/update`, { status }).then(() => { message.success(`已${status}`); loadAll(); });
  const directCredit = (t: any) => {
    let val = 0;
    Modal.confirm({
      title: `给「${t.name}」直充/扣减积分`,
      content: <InputNumber style={{ width: '100%' }} placeholder="正数充值，负数扣减" onChange={(v) => { val = Number(v) || 0; }} />,
      onOk: () => { if (val) api.post(`/platform/tenants/${t.id}/credits`, { delta: val, note: '平台直充' }).then(() => { message.success('已处理'); loadAll(); }); },
    });
  };
  const confirmOrder = (o: any) => Modal.confirm({
    title: '确认收到款项？', content: `确认后将向「${o.tenant_name}」充入 ${o.credits.toLocaleString()} 积分（¥${o.price_yuan}）`,
    okText: '确认到账', onOk: () => api.post(`/platform/recharge-orders/${o.id}/confirm`, {}).then(() => { message.success('已确认到账'); loadAll(); }),
  });
  const openPkg = (p: any) => { setPkgEdit(p); pForm.setFieldsValue({ ...p, enabled: !!p.enabled }); };
  const submitPkg = () => pForm.validateFields().then(v => {
    api.put(`/platform/packages/${pkgEdit.id}`, v).then(() => { message.success('已保存'); setPkgEdit(null); loadAll(); });
  });

  const logout = () => { clearAuth(); nav('/login'); };
  const pendingTenants = tenants.filter(t => t.status === '待审核');

  return (
    <div style={{ minHeight: '100vh', background: 'var(--ui-surface-2)' }}>
      <div style={{ height: 56, background: 'linear-gradient(90deg,var(--ui-border-strong),var(--ui-primary-strong))', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', padding: '0 24px', color: '#fff' }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>纳米Work行业版 · 平台运营后台</div>
        <Space>
          <span style={{ fontSize: 13, opacity: 0.9 }}>平台超级管理员</span>
          <Button size="small" ghost icon={<LogoutOutlined />} onClick={logout}>退出</Button>
        </Space>
      </div>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1400, margin: '0 auto' }}>
        {loadError && <ErrorState description="平台数据全部拉取失败，页面数据可能为空或过期。" onRetry={loadAll} />}
        <Row gutter={[12, 12]}>
          <Col xs={12} md={6}><StatCard icon={<ShopOutlined />} color="var(--ui-accent)" label="客户企业" value={ov.tenants ?? 0} suffix="家" /></Col>
          <Col xs={12} md={6}><StatCard icon={<AuditOutlined />} color="#f6a02d" label="待开通企业" value={ov.pending ?? 0} suffix="家" onClick={() => setTab('开通管理')} /></Col>
          <Col xs={12} md={6}><StatCard icon={<WalletOutlined />} color="#22c4a8" label="累计充值额" value={`¥${(ov.rechargeYuan ?? 0).toLocaleString()}`} /></Col>
          <Col xs={12} md={6}><StatCard icon={<DollarOutlined />} color="#f25b6b" label="待确认订单" value={ov.pendingOrders ?? 0} suffix="笔" /></Col>
        </Row>

        <Segmented value={tab} onChange={(v) => setTab(v as string)} options={['开通管理', '概览', '运营分析', '积分流水', '客户企业', '充值订单', '套餐管理']} />

        {tab === '开通管理' && (
          <Panel title={<><AuditOutlined style={{ color: '#f6a02d' }} /> 企业注册开通</>}
            extra={<Tag color={pendingTenants.length ? 'gold' : 'green'}>{pendingTenants.length ? `${pendingTenants.length} 家待开通` : '暂无待开通'}</Tag>}>
            <Table size="small" rowKey="id" dataSource={pendingTenants} pagination={{ pageSize: 10 }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待开通企业" /> }}
              columns={[
                { title: '企业 / 餐饮门店', dataIndex: 'name', render: (v: string, r: any) => <span><b>{v}</b><br /><span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>注册时间：{(r.created_at || '').slice(0, 16) || '-'}</span></span> },
                { title: '联系人', dataIndex: 'contact_name', width: 120, render: (v: string, r: any) => <span>{v || '-'}<br /><span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{r.phone || '-'}</span></span> },
                { title: '初始账号', dataIndex: 'user_count', width: 90, align: 'right', render: (v: number) => `${v || 0} 个` },
                { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color="gold">{v}</Tag> },
                { title: '开通动作', width: 140, render: (_: any, r: any) => <Button type="primary" size="small" onClick={() => openApprove(r)}>开通账号</Button> },
              ]} />
          </Panel>
        )}

        {tab === '运营分析' && ana && (
          <>
            <Row gutter={[12, 12]}>
              <Col xs={12} md={6}><StatCard icon={<ShopOutlined />} color="#22c4a8" label="活跃企业（近3天用过AI）" value={ana.summary.active} suffix={`/${ana.summary.total}`} /></Col>
              <Col xs={12} md={6}><StatCard icon={<AuditOutlined />} color="#f25b6b" label="流失预警（14天没动静）" value={ana.summary.churning} suffix="家" /></Col>
              <Col xs={12} md={6}><StatCard icon={<WalletOutlined />} color="var(--ui-accent)" label="付费企业 / ARPU" value={ana.summary.paying} suffix={`家 · ¥${(ana.summary.arpu||0).toLocaleString()}`} /></Col>
              <Col xs={12} md={6}><StatCard icon={<DollarOutlined />} color="#f6a02d" label="累计营收（客户充值）" value={`¥${(ana.summary.totalRevenue||0).toLocaleString()}`} /></Col>
            </Row>
            <Row gutter={[12, 12]}>
              <Col xs={12} md={8}><StatCard icon={<AuditOutlined />} color="#f25b6b" label="平台真实成本（云雾API·至今）" value={`¥${(ana.summary.totalCost||0).toLocaleString()}`} /></Col>
              <Col xs={12} md={8}><StatCard icon={<DollarOutlined />} color="#22c4a8" label="客户已消耗价值（按售价）" value={`¥${(ana.summary.consumedYuan||0).toLocaleString()}`} /></Col>
              <Col xs={12} md={8}><StatCard icon={<WalletOutlined />} color="#8a7450" label="AI转售毛利率（消耗−成本）" value={`${ana.summary.marginRate||0}`} suffix="%" /></Col>
            </Row>
            <Row gutter={[12, 12]}>
              <Col xs={24} lg={10}>
                <Panel title={<><DollarOutlined style={{ color: '#f6a02d' }} /> 营收趋势（近6月已到账充值）</>}>
                  {(ana.revByMonth || []).length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无充值" /> :
                    ana.revByMonth.map((r: any) => {
                      const max = Math.max(...ana.revByMonth.map((x: any) => x.yuan), 1);
                      return (
                        <div key={r.m} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0', fontSize: 12.5 }}>
                          <span style={{ width: 56, color: 'var(--ui-text-2)' }}>{r.m}</span>
                          <div style={{ flex: 1, background: 'var(--ui-border)', borderRadius: 4, height: 18 }}>
                            <div style={{ width: `${(r.yuan / max) * 100}%`, minWidth: 30, height: 18, borderRadius: 4, background: 'linear-gradient(90deg,#f6a02d,#f8c46a)', color: '#fff', fontSize: 10.5, textAlign: 'right', paddingRight: 5, lineHeight: '18px' }}>¥{r.yuan}</div>
                          </div>
                          <span style={{ width: 40, color: 'var(--ui-muted)', fontSize: 11 }}>{r.cnt}单</span>
                        </div>
                      );
                    })}
                </Panel>
              </Col>
              <Col xs={24} lg={14}>
                <Panel title={<><ShopOutlined style={{ color: 'var(--ui-accent)' }} /> 企业健康度 / 续费预警</>}
                  extra={ana.summary.lowBalance > 0 && <Tag color="red">{ana.summary.lowBalance} 家积分见底，建议催充</Tag>}>
                  <Table size="small" rowKey="id" dataSource={ana.tenants} pagination={{ pageSize: 8, size: 'small' }} scroll={{ x: 880 }}
                    columns={[
                      { title: '企业', dataIndex: 'name', ellipsis: true, fixed: 'left', width: 150, render: (v: string, r: any) => <span><b>{v}</b> <Tag style={{ fontSize: 10 }}>{r.plan}</Tag></span> },
                      { title: '健康度', dataIndex: 'health', width: 84, render: (v: string) => <Tag color={v === '活跃' ? 'green' : v === '一般' ? 'blue' : v === '流失预警' ? 'red' : 'default'}>{v}</Tag> },
                      { title: '闲置', dataIndex: 'idleDays', width: 60, align: 'right', render: (v: any) => v == null ? '—' : <span style={{ color: v > 14 ? '#f25b6b' : 'var(--ui-text-2)' }}>{v}天</span> },
                      { title: '余额', dataIndex: 'credits', align: 'right', width: 84, render: (v: number, r: any) => <span style={{ color: r.lowBalance ? '#f25b6b' : 'var(--ui-accent)', fontWeight: 600 }}>{(v||0).toLocaleString()}</span> },
                      { title: '累计充值', dataIndex: 'total_recharged', align: 'right', width: 84, render: (v: number) => (v||0).toLocaleString() },
                      { title: '消耗积分', dataIndex: 'spent', align: 'right', width: 80, render: (v: number) => (v||0).toLocaleString() },
                      { title: '调用', dataIndex: 'calls', width: 56, align: 'right' },
                      { title: '真实成本', dataIndex: 'cost', align: 'right', width: 84, render: (v: number) => `¥${(v||0).toFixed(2)}` },
                      { title: '毛利', dataIndex: 'margin', align: 'right', width: 84, render: (v: number) => <b style={{ color: (v||0) >= 0 ? '#16a34a' : '#f25b6b' }}>¥{(v||0).toFixed(2)}</b> },
                      { title: '账号', dataIndex: 'users', width: 50, align: 'right' },
                    ]} />
                </Panel>
              </Col>
            </Row>
          </>
        )}

        {tab === '积分流水' && <PlatformCreditLogs tenants={tenants} />}

        {(tab === '概览' || tab === '客户企业') && (
          <Panel title={<><ShopOutlined style={{ color: 'var(--ui-accent)' }} /> 客户企业（租户）</>}>
            <Table size="small" rowKey="id" dataSource={tenants} pagination={{ pageSize: 12 }}
              columns={[
                { title: '企业名称', dataIndex: 'name', render: (v: string, r: any) => <span><b>{v}</b>{r.id === 1 && <Tag color="gold" style={{ marginLeft: 6 }}>总部自营</Tag>}</span> },
                { title: '联系人', dataIndex: 'contact_name', width: 90, render: (v: string, r: any) => <span>{v || '-'}<br /><span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{r.phone || ''}</span></span> },
                { title: '状态', dataIndex: 'status', width: 84, render: (v: string) => <Tag color={v === '已开通' ? 'green' : v === '待审核' ? 'gold' : 'red'}>{v}</Tag> },
                { title: '套餐', dataIndex: 'plan', width: 80 },
                { title: '账号/席位', width: 80, align: 'right', render: (_: any, r: any) => <span style={{ color: r.user_count >= (r.seat_limit||0) ? '#f25b6b' : 'var(--ui-text)' }}>{r.user_count}/{r.seat_limit ?? '-'}</span> },
                { title: '积分池', dataIndex: 'credits', align: 'right', render: (v: number) => <b style={{ color: 'var(--ui-accent)' }}>{(v ?? 0).toLocaleString()}</b> },
                { title: '累计充值', dataIndex: 'total_recharged', align: 'right', render: (v: number) => (v ?? 0).toLocaleString() },
                { title: '操作', width: 200, render: (_: any, r: any) => r.id === 1 ? <span style={{ color: 'var(--ui-muted)' }}>—</span> : (
                  <Space size={4} wrap>
                    <Button size="small" type="primary" onClick={() => openApprove(r)}>{r.status === '待审核' ? '开通账号' : '调整权限'}</Button>
                    <Button size="small" onClick={() => directCredit(r)}>直充</Button>
                    {r.status === '已开通'
                      ? <Button size="small" danger onClick={() => setStatus(r, '已停用')}>停用</Button>
                      : r.status === '已停用' ? <Button size="small" onClick={() => setStatus(r, '已开通')}>启用</Button> : null}
                  </Space>
                ) },
              ]} />
          </Panel>
        )}

        {tab === '充值订单' && (
          <Panel title={<><WalletOutlined style={{ color: '#22c4a8' }} /> 充值订单（确认到账即发放积分）</>}>
            <Table size="small" rowKey="id" dataSource={orders} pagination={{ pageSize: 12 }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无订单" /> }}
              columns={[
                { title: '订单号', dataIndex: 'order_no', render: (v: string) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{v}</span> },
                { title: '企业', dataIndex: 'tenant_name' },
                { title: '套餐', dataIndex: 'package_name', width: 90 },
                { title: '金额', dataIndex: 'price_yuan', align: 'right', width: 80, render: (v: number) => <b style={{ color: '#f25b6b' }}>¥{v}</b> },
                { title: '积分', dataIndex: 'credits', align: 'right', width: 90, render: (v: number) => v.toLocaleString() },
                { title: '状态', dataIndex: 'status', width: 84, render: (v: string) => <Tag color={v === '已支付' ? 'green' : v === '待支付' ? 'gold' : 'default'}>{v}</Tag> },
                { title: '时间', dataIndex: 'created_at', width: 150, render: (v: string) => <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>{v}</span> },
                { title: '操作', width: 110, render: (_: any, r: any) => r.status === '待支付'
                  ? <Button size="small" type="primary" onClick={() => confirmOrder(r)}>确认到账</Button>
                  : <span style={{ color: 'var(--ui-muted)', fontSize: 12 }}>{r.paid_at?.slice(5, 16) || '—'}</span> },
              ]} />
          </Panel>
        )}

        {tab === '套餐管理' && (
          <Panel title={<><AppstoreOutlined style={{ color: '#f6a02d' }} /> 充值套餐</>}>
            <Table size="small" rowKey="id" dataSource={packages} pagination={false}
              columns={[
                { title: '套餐名', dataIndex: 'name', render: (v: string, r: any) => <span><b>{v}</b>{r.tag && <Tag style={{ marginLeft: 6 }}>{r.tag}</Tag>}</span> },
                { title: '价格', dataIndex: 'price_yuan', align: 'right', render: (v: number) => `¥${v}` },
                { title: '基础积分', dataIndex: 'base_credits', align: 'right', render: (v: number) => v.toLocaleString() },
                { title: '赠送', dataIndex: 'bonus_credits', align: 'right', render: (v: number) => <span style={{ color: '#22c4a8' }}>+{v.toLocaleString()}</span> },
                { title: '到账积分', dataIndex: 'total_credits', align: 'right', render: (v: number) => <b style={{ color: 'var(--ui-accent)' }}>{v.toLocaleString()}</b> },
                { title: '启用', dataIndex: 'enabled', width: 70, render: (v: number) => <Tag color={v ? 'green' : 'default'}>{v ? '在售' : '下架'}</Tag> },
                { title: '操作', width: 70, render: (_: any, r: any) => <a onClick={() => openPkg(r)}>编辑</a> },
              ]} />
          </Panel>
        )}
      </div>

      {/* 开通账号 / 调整权限 */}
      <Modal open={!!approve} onCancel={() => setApprove(null)} onOk={submitApprove} okText={approve?.status === '待审核' ? '开通' : '保存'}
        title={approve ? `${approve.status === '待审核' ? '开通账号' : '调整权限'} · ${approve.name}` : ''}>
        <Form form={aForm} layout="vertical">
          <Form.Item name="plan" label="套餐">
            <Select options={PLANS.map(p => ({ value: p, label: p }))} />
          </Form.Item>
          <Form.Item name="seatLimit" label="账号席位上限（该企业最多可创建多少个账号）" rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} min={1} max={500} addonAfter="个账号" placeholder="如 50" />
          </Form.Item>
          <Form.Item name="modules" label="开通模块（该企业可见的功能）">
            <Checkbox.Group options={ALL_MODULES.map(m => ({ label: MOD_NAME[m], value: m }))} />
          </Form.Item>
          <Form.Item name="grantCredits" label="赠送体验积分（仅首次开通发放）">
            <InputNumber style={{ width: '100%' }} min={0} step={1000} addonAfter="积分" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 套餐编辑 */}
      <Modal open={!!pkgEdit} onCancel={() => setPkgEdit(null)} onOk={submitPkg} okText="保存"
        title={pkgEdit ? `编辑套餐 · ${pkgEdit.name}` : ''}>
        <Form form={pForm} layout="vertical">
          <Form.Item name="name" label="套餐名" rules={[{ required: true }]}><Input /></Form.Item>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="price_yuan" label="价格(元)" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={1} /></Form.Item></Col>
            <Col span={12}><Form.Item name="bonus_credits" label="赠送积分"><InputNumber style={{ width: '100%' }} min={0} step={100} /></Form.Item></Col>
          </Row>
          <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginBottom: 12 }}>到账积分 = 价格×100 + 赠送（基础积分按价格自动计算）</div>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="tag" label="标签"><Input placeholder="热门/推荐/旗舰" /></Form.Item></Col>
            <Col span={12}><Form.Item name="enabled" label="在售" valuePropName="checked"><Switch /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
}

// 全平台积分流水（平台超管：跨企业可筛选可导出，含真实成本——平台方自己的账）
function PlatformCreditLogs({ tenants }: { tenants: any[] }) {
  const [logs, setLogs] = useState<any>({ total: 0, rows: [] });
  const [tenantId, setTenantId] = useState<number | undefined>(undefined);
  const [kind, setKind] = useState<string | undefined>(undefined);
  const [range, setRange] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const qs = useCallback(() => {
    const p = new URLSearchParams();
    if (tenantId) p.set('tenantId', String(tenantId));
    if (kind) p.set('kind', kind);
    if (range[0]) p.set('from', range[0]);
    if (range[1]) p.set('to', range[1]);
    return p.toString();
  }, [kind, range, tenantId]);
  useEffect(() => { api.get(`/platform/credit-logs?page=${page}&size=20&${qs()}`).then(setLogs); }, [page, qs]);
  const doExport = async () => {
    const d = await api.get(`/platform/credit-logs?export=1&${qs()}`);
    const rows = (d.rows || []).map((r: any) => [
      r.created_at, r.tenant_name || '', r.user_name || '', r.feature || '', KIND_LABEL[r.kind] || r.kind || '', r.model || '',
      `${r.input_tokens || 0}+${r.output_tokens || 0}`, r.credits > 0 ? r.credits : 0, r.credits < 0 ? -r.credits : 0,
      r.spend_yuan ?? '', r.cost_yuan ?? 0, r.balance_after,
    ]);
    exportCsv(`全平台积分流水_${new Date().toISOString().slice(0, 10)}`,
      ['时间', '企业', '用户', '功能', '类型', '模型', 'tokens(入+出)', '消耗积分', '充值积分', '折合售价¥', '真实成本¥', '余额'], rows);
    message.success(`已导出 ${rows.length} 条`);
  };
  return (
    <Panel title={<><WalletOutlined style={{ color: 'var(--ui-accent)' }} /> 全平台积分流水（跨企业 · 可筛选导出）</>} extra={
      <Space wrap size={6}>
        <Select allowClear showSearch placeholder="按企业" size="small" style={{ width: 160 }} optionFilterProp="label"
          options={tenants.filter((t: any) => t.id > 1).map((t: any) => ({ value: t.id, label: t.name }))}
          onChange={(v: any) => { setTenantId(v); setPage(1); }} />
        <Select allowClear placeholder="按类型" size="small" style={{ width: 110 }} options={KIND_OPTS}
          onChange={(v: any) => { setKind(v); setPage(1); }} />
        <DatePicker.RangePicker size="small" style={{ width: 220 }}
          onChange={(d: any) => { setRange(d ? [d[0].format('YYYY-MM-DD'), d[1].format('YYYY-MM-DD')] : []); setPage(1); }} />
        <Button size="small" type="primary" ghost onClick={doExport} disabled={!logs.total}>导出CSV</Button>
      </Space>
    }>
      <Table size="small" rowKey="id" dataSource={logs.rows} scroll={{ x: 1040 }}
        pagination={{ current: page, pageSize: 20, total: logs.total, onChange: (p: number) => setPage(p), showSizeChanger: false, size: 'small', showTotal: (t: number) => `共 ${t} 条` }}
        columns={[
          { title: '时间', dataIndex: 'created_at', width: 140, render: (v: string) => <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>{v}</span> },
          { title: '企业', dataIndex: 'tenant_name', width: 130, ellipsis: true, render: (v: string) => <b>{v || '—'}</b> },
          { title: '用户', dataIndex: 'user_name', width: 76, render: (v: string) => v || '—' },
          { title: '功能', dataIndex: 'feature' },
          { title: '类型', dataIndex: 'kind', width: 60, render: (v: string) => KIND_LABEL[v] || v || '-' },
          { title: '模型', dataIndex: 'model', render: (v: string) => v || '-' },
          { title: '积分', dataIndex: 'credits', align: 'right', render: (v: number) => v > 0 ? <b style={{ color: '#f25b6b' }}>-{v}</b> : v < 0 ? <b style={{ color: '#16a34a' }}>+{-v}</b> : '0' },
          { title: '折合售价', dataIndex: 'spend_yuan', align: 'right', render: (v: number) => v == null ? '—' : `¥${v}` },
          { title: '真实成本', dataIndex: 'cost_yuan', align: 'right', render: (v: number) => `¥${v ?? 0}` },
          { title: '余额', dataIndex: 'balance_after', align: 'right', render: (v: number) => (v ?? 0).toLocaleString() },
        ]} />
    </Panel>
  );
}
