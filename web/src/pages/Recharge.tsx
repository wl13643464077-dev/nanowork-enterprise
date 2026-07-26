import { useEffect, useState } from 'react';
import { Row, Col, Table, Tag, Button, Modal, message, Empty, Alert, Segmented } from 'antd';
import { WalletOutlined, GiftOutlined, ThunderboltOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { api, getUser } from '../api/client';
import { StatCard, Panel } from '../components/Kit';
import { Result } from 'antd';

const TAG_COLOR: Record<string, string> = { 体验: 'default', 超值: 'cyan', 热门: 'blue', 推荐: 'orange', 旗舰: 'red' };
// 消耗锚点（用于"约可用"换算提示）
const estUse = (c: number) => `≈ ${Math.floor(c / 75)} 张图 / ${Math.floor(c / 1500)} 条视频 / ${(c / 1).toLocaleString()} 次文本`;

export default function Recharge() {
  const [packages, setPackages] = useState<any[]>([]);
  const [bal, setBal] = useState<any>({ credits: 0, totalRecharged: 0, totalSpent: 0, logs: [] });
  const [orders, setOrders] = useState<any[]>([]);
  const [tab, setTab] = useState('套餐充值');
  const [orderResult, setOrderResult] = useState<any>(null);

  const loadBal = () => api.get('/recharge/balance').then(setBal).catch(() => {});
  const loadPkgs = () => api.get('/recharge/packages').then(setPackages).catch(() => {});
  const loadOrders = () => api.get('/recharge/orders').then(setOrders).catch(() => {});
  useEffect(() => { loadBal(); loadPkgs(); loadOrders(); }, []);

  const buy = (pkg: any) => {
    Modal.confirm({
      title: `确认下单：${pkg.name}`,
      content: <div style={{ fontSize: 13, lineHeight: 2 }}>
        支付金额 <b style={{ color: '#f25b6b' }}>¥{pkg.price_yuan}</b><br />
        到账积分 <b style={{ color: 'var(--ui-accent)' }}>{pkg.total_credits.toLocaleString()}</b>（含赠送 {pkg.bonus_credits.toLocaleString()}）<br />
        <span style={{ color: 'var(--ui-muted)', fontSize: 12 }}>{estUse(pkg.total_credits)}</span>
      </div>,
      okText: '确认下单', cancelText: '取消',
      onOk: async () => {
        // 下单期间 Modal.confirm 会自动在「确认下单」按钮上显示 loading（onOk 返回 Promise）
        const res = await api.post('/recharge/orders', { packageId: pkg.id });
        setOrderResult(res); loadOrders();
      },
    });
  };

  const role = getUser()?.role;
  if (role !== 'boss' && role !== 'platform_super') {
    return <Result status="info" title="充值中心仅企业老板可操作"
      subTitle="企业积分由老板统一充值、全员共享使用。如需充值请联系企业负责人。" />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 余额概览 */}
      <Row gutter={[12, 12]}>
        <Col xs={24} md={8}><StatCard icon={<WalletOutlined />} color="var(--ui-accent)" label="企业积分余额"
          value={(bal.credits ?? 0).toLocaleString()} suffix="分" /></Col>
        <Col xs={12} md={8}><StatCard icon={<GiftOutlined />} color="#22c4a8" label="累计充值"
          value={(bal.totalRecharged ?? 0).toLocaleString()} suffix="分" /></Col>
        <Col xs={12} md={8}><StatCard icon={<ThunderboltOutlined />} color="#f6a02d" label="累计消耗"
          value={(bal.totalSpent ?? 0).toLocaleString()} suffix="分" /></Col>
      </Row>

      <Alert type="info" showIcon
        message="计费规则：1 积分 = ¥0.01；按真实 AI 成本 ×1.5 扣减。文本≈1分/次起、生图约75分/张、生视频约1500分/条。企业内所有账号共享同一积分池。" />

      <Segmented value={tab} onChange={(v) => setTab(v as string)} options={['套餐充值', '充值记录', '消耗明细']} />

      {tab === '套餐充值' && (
        <Row gutter={[14, 14]}>
          {packages.map(p => (
            <Col xs={24} sm={12} lg={8} xl={6} key={p.id}>
              <div style={{ border: '1px solid var(--ui-surface)', borderRadius: 14, padding: 18, position: 'relative', background: 'var(--ui-surface)', height: '100%',
                boxShadow: '0 2px 10px rgba(28,36,52,.05)' }}>
                {p.tag && <Tag color={TAG_COLOR[p.tag] || 'blue'} style={{ position: 'absolute', top: 14, right: 14 }}>{p.tag}</Tag>}
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ui-text)' }}>{p.name}</div>
                <div style={{ margin: '12px 0 4px' }}>
                  <span style={{ fontSize: 30, fontWeight: 800, color: '#f25b6b' }}>¥{p.price_yuan}</span>
                </div>
                <div style={{ fontSize: 14, color: 'var(--ui-accent)', fontWeight: 600 }}>{p.total_credits.toLocaleString()} 积分</div>
                {p.bonus_credits > 0 && <div style={{ fontSize: 12, color: '#22c4a8', marginTop: 2 }}>含赠送 {p.bonus_credits.toLocaleString()} 分</div>}
                <div style={{ fontSize: 11, color: 'var(--ui-muted)', margin: '8px 0 14px', lineHeight: 1.6, minHeight: 32 }}>{estUse(p.total_credits)}</div>
                <Button type="primary" block onClick={() => buy(p)}
                  style={{ background: 'linear-gradient(90deg,var(--ui-primary-strong),#70757a)', border: 'none' }}>立即充值</Button>
              </div>
            </Col>
          ))}
        </Row>
      )}

      {tab === '充值记录' && (
        <Panel title="充值记录">
          <Table size="small" rowKey="id" dataSource={orders} pagination={{ pageSize: 10, hideOnSinglePage: true }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无充值记录" /> }}
            columns={[
              { title: '订单号', dataIndex: 'order_no', render: (v: string) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{v}</span> },
              { title: '套餐', dataIndex: 'package_name' },
              { title: '金额', dataIndex: 'price_yuan', align: 'right', render: (v: number) => `¥${v}` },
              { title: '积分', dataIndex: 'credits', align: 'right', render: (v: number) => <b style={{ color: 'var(--ui-accent)' }}>{v.toLocaleString()}</b> },
              { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={v === '已支付' ? 'green' : v === '待支付' ? 'gold' : 'default'}>{v}</Tag> },
              { title: '时间', dataIndex: 'created_at', width: 150, render: (v: string) => <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>{v}</span> },
              { title: '操作', width: 70, render: (_: any, r: any) => r.status === '待支付'
                ? <a onClick={() => api.post(`/recharge/orders/${r.id}/cancel`, {}).then(() => { message.success('已取消'); loadOrders(); })}>取消</a>
                : <CheckCircleOutlined style={{ color: '#22c4a8' }} /> },
            ]} />
        </Panel>
      )}

      {tab === '消耗明细' && (
        <Panel title="积分流水（充值入账 + 功能消耗，对账明细）">
          <Table size="small" rowKey={(_, i) => String(i)} dataSource={bal.logs} pagination={{ pageSize: 12 }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无流水" /> }}
            columns={[
              { title: '项目', dataIndex: 'feature', render: (v: string, r: any) => <span>{v}{r.model && <Tag style={{ marginLeft: 6, fontSize: 10 }}>{r.model}</Tag>}</span> },
              { title: '类型', dataIndex: 'kind', width: 80, render: (v: string) => <Tag color={v === 'recharge' ? 'green' : 'blue'} style={{ fontSize: 11 }}>{v === 'recharge' ? '充值' : v === 'text' ? '文本' : v === 'image' ? '生图' : v === 'video' ? '视频' : v}</Tag> },
              { title: '积分变动', dataIndex: 'credits', align: 'right', width: 100,
                render: (v: number) => v < 0
                  ? <b style={{ color: '#22c4a8' }}>+{(-v).toLocaleString()}</b>
                  : <span style={{ color: '#f25b6b' }}>-{v.toLocaleString()}</span> },
              { title: '余额', dataIndex: 'balance_after', align: 'right', width: 100, render: (v: number) => (v ?? 0).toLocaleString() },
              { title: '时间', dataIndex: 'created_at', width: 150, render: (v: string) => <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>{v}</span> },
            ]} />
        </Panel>
      )}

      {/* 下单成功：收款指引 */}
      <Modal open={!!orderResult} footer={[<Button key="ok" type="primary" onClick={() => { setOrderResult(null); loadBal(); }}>我知道了</Button>]}
        onCancel={() => setOrderResult(null)} title="订单已提交，请完成支付">
        {orderResult && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
            <div style={{ background: 'var(--ui-surface-2)', borderRadius: 10, padding: '12px 14px', lineHeight: 2 }}>
              <div>订单号：<b style={{ fontFamily: 'monospace' }}>{orderResult.orderNo}</b></div>
              <div>套餐：{orderResult.package?.name}　金额：<b style={{ color: '#f25b6b' }}>¥{orderResult.package?.price_yuan}</b></div>
              <div>到账积分：<b style={{ color: 'var(--ui-accent)' }}>{orderResult.package?.total_credits?.toLocaleString()}</b></div>
            </div>
            <Alert type="warning" showIcon message={orderResult.payGuide} />
            <div style={{ fontSize: 12, color: 'var(--ui-muted)' }}>支付完成后，平台确认到账，积分将自动充入企业积分池，可在「充值记录」查看状态。</div>
          </div>
        )}
      </Modal>
    </div>
  );
}
