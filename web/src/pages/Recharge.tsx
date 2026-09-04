import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Row,
  Col,
  Table,
  Tag,
  Button,
  Modal,
  message,
  Empty,
  Alert,
  Segmented,
  QRCode,
  Radio,
  Spin,
  Popover,
} from 'antd';
import {
  WalletOutlined,
  GiftOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  WechatOutlined,
  AlipayCircleOutlined,
  CrownOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { api, getUser } from '../api/client';
import { StatCard, Panel, ErrorState } from '../components/Kit';
import { Result } from 'antd';
import './Recharge.css';

const TAG_COLOR: Record<string, string> = {
  体验: 'default',
  超值: 'cyan',
  热门: 'blue',
  推荐: 'orange',
  旗舰: 'red',
  年度: 'gold',
};
const PLAN_STATUS: Record<string, { label: string; color: string; tone?: string }> = {
  none: { label: '未开通年度套餐', color: 'default' },
  active: { label: '生效中', color: 'success' },
  expiring: { label: '即将到期', color: 'warning', tone: 'warn' },
  expired: { label: '已到期', color: 'error', tone: 'danger' },
};

type Equivalents = {
  credits: number;
  images: number;
  videos: number;
  textTasks: number;
  unit: {
    imageCredits: number;
    videoCredits: number;
    textTaskCredits: number;
    // 每单位供应商成本（元，价目表口径）
    imageCostYuan?: number;
    videoCostYuan?: number;
    textTaskCostYuan?: number;
  };
  // 当前积分对应的理论供应商成本（元）= credits × creditYuan ÷ marginFactor
  supplierCostYuan?: number;
  marginFactor?: number;
  // observed = 文本 token 假设来自本企业真实流水均值；price_table = 固定 2k+1k 假设
  basis?: 'price_table' | 'observed';
  observedSample?: { calls: number; avgTokens: { input: number; output: number } } | null;
  assumptions: {
    creditYuan: number;
    marginMultiplier: number;
    formula: string;
    // 后端按当前毛利系数生成的口径文案（如"售价 = 中转站成本 × 2"），前端不写死倍数
    marginLabel?: string;
    text: { label: string };
    image: { label: string };
    video: { label: string; durationSeconds: number };
  };
};

const fmt = (n: any) => Number(n ?? 0).toLocaleString();
// 成本小字：≥1 元保留 2 位，<1 元保留到分/厘（¥0.09、¥0.108）
const fmtYuan = (n: any) => {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '—';
  return v >= 1 ? v.toFixed(2) : v.toFixed(v >= 0.1 ? 2 : 3);
};
const validDaysLabel = (days: any) => {
  const d = Number(days || 0);
  if (!d) return '';
  if (d % 365 === 0) return `${d / 365} 年`;
  if (d % 30 === 0) return `${d / 30} 个月`;
  return `${d} 天`;
};

// 套餐卡上的权益文案：全部来自接口字段，不写死数字
function planTerms(p: any) {
  const terms: string[] = [];
  if (p.seat_limit) terms.push(`含 ${p.seat_limit} 个账号`);
  if (p.valid_days) terms.push(`有效期 ${validDaysLabel(p.valid_days)}`);
  if (p.bonus_credits > 0) terms.push(`赠 ${fmt(p.bonus_credits)} 积分`);
  terms.push(p.total_credits > 0 ? `含 ${fmt(p.total_credits)} 积分` : '不含积分（按用量充值）');
  return terms;
}

export default function Recharge() {
  const [packages, setPackages] = useState<any[]>([]);
  const [bal, setBal] = useState<any>({ credits: 0, totalRecharged: 0, totalSpent: 0, logs: [], plan: null });
  const [orders, setOrders] = useState<any[]>([]);
  const [eq, setEq] = useState<Equivalents | null>(null);
  const [tab, setTab] = useState('套餐充值');
  const [orderResult, setOrderResult] = useState<any>(null);
  // 在线支付通道（后端已配置微信/支付宝时非空；为空保持对公转账旧流程）
  const [channels, setChannels] = useState<any[]>([]);
  const [pickPkg, setPickPkg] = useState<any>(null); // 通道选择弹窗中的套餐
  const [payChannel, setPayChannel] = useState<string>('');
  const [placing, setPlacing] = useState(false);
  const [payOrder, setPayOrder] = useState<any>(null); // {orderNo, qrUrl, channel, channelName, package}
  const [payStatus, setPayStatus] = useState<string>('待支付');

  const [loadError, setLoadError] = useState(false);
  const loadBal = useCallback(() => api.get('/recharge/balance').then(setBal), []);
  const loadPkgs = useCallback(() => api.get('/recharge/packages').then(setPackages), []);
  const loadOrders = useCallback(() => api.get('/recharge/orders').then(setOrders), []);
  const loadAll = useCallback(() => {
    setLoadError(false);
    Promise.allSettled([loadBal(), loadPkgs(), loadOrders()]).then(results => {
      if (results.some(r => r.status === 'rejected')) setLoadError(true);
    });
  }, [loadBal, loadOrders, loadPkgs]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      loadAll();
      api
        .get('/recharge/channels')
        .then((r: any) => {
          const list = Array.isArray(r?.channels) ? r.channels : [];
          setChannels(list);
          if (list.length) setPayChannel(list[0].channel);
        })
        .catch(() => {});
    });
    return () => cancelAnimationFrame(frame);
  }, [loadAll]);

  // 积分权益换算：按当前余额取一次（单位积分同时用于各套餐卡的"约可用"换算，与服务端同一公式）
  const balanceCredits = Number(bal.credits ?? 0);
  useEffect(() => {
    api
      .get(`/recharge/equivalents?credits=${Math.max(0, Math.floor(balanceCredits))}`)
      .then(setEq)
      .catch(() => {});
  }, [balanceCredits]);
  const estUse = useCallback(
    (c: number) => {
      if (!eq?.unit) return '权益换算加载中…';
      const n = (unit: number) => (unit > 0 ? Math.floor(c / unit) : 0);
      return `≈ ${fmt(n(eq.unit.imageCredits))} 张图 / ${fmt(n(eq.unit.videoCredits))} 条 ${eq.assumptions?.video?.durationSeconds ?? 30} 秒视频 / ${fmt(n(eq.unit.textTaskCredits))} 次文本任务`;
    },
    [eq],
  );

  const planPkgs = useMemo(() => packages.filter(p => p.kind === 'plan'), [packages]);
  const creditPkgs = useMemo(() => packages.filter(p => p.kind !== 'plan'), [packages]);
  const plan = bal.plan || null;
  const planStatus = PLAN_STATUS[plan?.status || 'none'] || PLAN_STATUS.none;

  // 扫码支付轮询：每 3 秒查一次订单状态（页面不可见时暂停，省流量也防后台空转）
  useEffect(() => {
    if (!payOrder || payStatus === '已支付') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      api
        .get(`/recharge/orders/${payOrder.orderNo}/status`)
        .then((s: any) => {
          if (s.status === '已支付') {
            setPayStatus('已支付');
            message.success(payOrder.package?.kind === 'plan' ? '支付成功，套餐已开通' : '支付成功，积分已到账');
            loadBal().catch(() => {});
            loadOrders().catch(() => {});
          } else if (s.status === '已取消') {
            setPayStatus('已取消');
          }
        })
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [loadBal, loadOrders, payOrder, payStatus]);

  // 在线扫码下单（已配置支付通道）
  const placeOnlineOrder = async () => {
    if (!pickPkg || !payChannel) return;
    setPlacing(true);
    try {
      const res = await api.post('/recharge/orders', { packageId: pickPkg.id, channel: payChannel });
      setPickPkg(null);
      setPayStatus('待支付');
      setPayOrder(res);
      loadOrders().catch(() => {});
    } catch {
      /* api 层已提示错误 */
    } finally {
      setPlacing(false);
    }
  };

  const orderSummary = (pkg: any) =>
    pkg.kind === 'plan' ? (
      <div className="rc-order-box">
        支付金额 <b className="rc-price">¥{fmt(pkg.price_yuan)}</b>
        <br />
        {planTerms(pkg).join(' · ')}
        <br />
        <span className="rc-muted">
          {pkg.bonus_credits > 0 ? `赠送积分 ${estUse(pkg.bonus_credits)}` : '积分按用量另行充值'}
        </span>
      </div>
    ) : (
      <div className="rc-order-box">
        支付金额 <b className="rc-price">¥{fmt(pkg.price_yuan)}</b>
        <br />
        到账积分 <b className="rc-credit">{fmt(pkg.total_credits)}</b>（含赠送 {fmt(pkg.bonus_credits)}）<br />
        <span className="rc-muted">{estUse(pkg.total_credits)}</span>
      </div>
    );

  const buy = (pkg: any) => {
    if (channels.length) {
      setPickPkg(pkg);
      return;
    }
    Modal.confirm({
      title: `确认下单：${pkg.name}`,
      content: orderSummary(pkg),
      okText: '确认下单',
      cancelText: '取消',
      onOk: async () => {
        // 下单期间 Modal.confirm 会自动在「确认下单」按钮上显示 loading（onOk 返回 Promise）
        const res = await api.post('/recharge/orders', { packageId: pkg.id });
        setOrderResult(res);
        loadOrders().catch(() => {});
      },
    });
  };

  const role = getUser()?.role;
  if (role !== 'boss') {
    return (
      <Result
        status="info"
        title="充值中心仅企业老板可操作"
        subTitle="企业积分由老板统一充值、全员共享使用。如需充值请联系企业负责人。"
      />
    );
  }

  const renderPackage = (p: any) => (
    <Col xs={24} sm={12} lg={8} xl={6} key={p.id}>
      <div className="rc-pkg" data-kind={p.kind || 'credits'}>
        {p.tag && (
          <Tag color={TAG_COLOR[p.tag] || 'blue'} className="rc-pkg-tag">
            {p.tag}
          </Tag>
        )}
        <div className="rc-pkg-name">{p.name}</div>
        <div className="rc-pkg-price">
          ¥{fmt(p.price_yuan)}
          {p.kind === 'plan' && p.valid_days ? <small> / {validDaysLabel(p.valid_days)}</small> : null}
        </div>
        {p.kind === 'plan' ? (
          <ul className="rc-pkg-terms">
            {planTerms(p).map(t => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        ) : (
          <>
            <div className="rc-pkg-credits">{fmt(p.total_credits)} 积分</div>
            {p.bonus_credits > 0 && <div className="rc-pkg-bonus">含赠送 {fmt(p.bonus_credits)} 分</div>}
          </>
        )}
        <div className="rc-pkg-est">
          {p.kind === 'plan'
            ? p.bonus_credits > 0
              ? `赠送积分${estUse(p.bonus_credits)}`
              : '积分按用量另行充值'
            : estUse(p.total_credits)}
        </div>
        <Button type="primary" block className="rc-pkg-buy" onClick={() => buy(p)}>
          {p.kind === 'plan'
            ? plan?.code === p.code && plan?.status !== 'expired'
              ? '续费 / 顺延'
              : '立即开通'
            : '立即充值'}
        </Button>
      </div>
    </Col>
  );

  const assumptions = eq?.assumptions;

  return (
    <div className="rc-page">
      {loadError && <ErrorState description="部分充值数据拉取失败，余额或订单可能显示不全。" onRetry={loadAll} />}

      {/* 我的套餐 */}
      <div className="rc-plan" data-status={plan?.status || 'none'}>
        <div className="rc-plan-cell">
          <span className="rc-plan-label">我的套餐</span>
          <span className="rc-plan-title">
            <CrownOutlined /> {plan?.code ? plan.name : '未开通年度套餐'}
            <Tag color={planStatus.color}>{planStatus.label}</Tag>
          </span>
          <span className="rc-plan-hint">
            {plan?.code ? `开通于 ${plan.startedAt || '-'}` : '开通年度套餐后可获得账号席位与赠送积分'}
          </span>
        </div>
        <div className="rc-plan-cell">
          <span className="rc-plan-label">账号席位</span>
          <span className="rc-plan-value">
            {plan?.seatsUsed ?? 0}
            <small>/ {plan?.seatLimit ?? '不限'}</small>
          </span>
          <span className="rc-plan-hint">停用的账号不占席位</span>
        </div>
        <div className="rc-plan-cell">
          <span className="rc-plan-label">到期日</span>
          <span className="rc-plan-value">{plan?.expiresAt || '—'}</span>
          <span className="rc-plan-hint" data-tone={planStatus.tone}>
            {plan?.daysLeft == null
              ? '—'
              : plan.daysLeft < 0
                ? `已过期 ${-plan.daysLeft} 天，功能暂未锁定，请尽快续费`
                : plan.daysLeft === 0
                  ? '今天到期'
                  : `剩余 ${plan.daysLeft} 天`}
          </span>
        </div>
        <div className="rc-plan-cell">
          <span className="rc-plan-label">套餐赠送积分</span>
          <span className="rc-plan-value">{plan?.bonusCredits != null ? fmt(plan.bonusCredits) : '—'}</span>
          <span className="rc-plan-hint">{plan?.code ? '每次开通/续费时到账' : '见下方年度套餐'}</span>
        </div>
      </div>

      {/* 余额概览 */}
      <Row gutter={[12, 12]}>
        <Col xs={24} md={8}>
          <StatCard
            icon={<WalletOutlined />}
            color="var(--ui-accent)"
            label="企业积分余额"
            value={fmt(bal.credits)}
            suffix="分"
          />
        </Col>
        <Col xs={12} md={8}>
          <StatCard
            icon={<GiftOutlined />}
            color="var(--chart-2)"
            label="累计充值"
            value={fmt(bal.totalRecharged)}
            suffix="分"
          />
        </Col>
        <Col xs={12} md={8}>
          <StatCard
            icon={<ThunderboltOutlined />}
            color="var(--warn)"
            label="累计消耗"
            value={fmt(bal.totalSpent)}
            suffix="分"
          />
        </Col>
      </Row>

      {/* 积分能做什么：数字来自 /recharge/equivalents（价目表反算），气泡展示假设 */}
      <div className="rc-equiv">
        <span className="rc-equiv-title">
          <ThunderboltOutlined /> 当前余额 {fmt(bal.credits)} 积分能做什么
          {assumptions && (
            <Popover
              title="换算假设"
              content={
                <div className="rc-equiv-assumptions">
                  <span>{assumptions.image.label}</span>
                  <span>{assumptions.video.label}</span>
                  <span>{assumptions.text.label}</span>
                  <span>
                    1 积分 = ¥{assumptions.creditYuan}；{assumptions.formula}（毛利系数{' '}
                    {eq?.marginFactor ?? assumptions.marginMultiplier}）
                  </span>
                  {assumptions.marginLabel && <span>{assumptions.marginLabel}</span>}
                  {eq?.supplierCostYuan != null && (
                    <span>
                      当前 {fmt(eq.credits)} 积分对应供应商成本约 ¥{fmtYuan(eq.supplierCostYuan)}（积分面值 ÷ 毛利系数{' '}
                      {eq.marginFactor ?? assumptions.marginMultiplier}）；每项后的"≈ ¥"为该产出的单位供应商成本。
                    </span>
                  )}
                  <span>
                    {eq?.basis === 'observed' && eq.observedSample
                      ? `文本任务 token 口径取自本企业 ${fmt(eq.observedSample.calls)} 次真实调用均值（输入 ${fmt(eq.observedSample.avgTokens.input)} / 输出 ${fmt(eq.observedSample.avgTokens.output)}）。`
                      : '文本任务 token 口径为固定假设；本企业真实调用达 5 次后自动改用真实均值。'}
                  </span>
                  <span>结果为按当前价目表的估算，实际以真实用量结算。</span>
                </div>
              }
            >
              <InfoCircleOutlined aria-label="查看换算假设" />
            </Popover>
          )}
        </span>
        {eq ? (
          <span className="rc-equiv-items">
            <span>
              ≈ <b>{fmt(eq.images)}</b> 张图
              {eq.unit.imageCostYuan != null && (
                <small className="rc-equiv-cost">≈ ¥{fmtYuan(eq.unit.imageCostYuan)} 成本/张</small>
              )}
            </span>
            <span>
              <b>{fmt(eq.videos)}</b> 条 {assumptions?.video.durationSeconds ?? 30} 秒视频
              {eq.unit.videoCostYuan != null && (
                <small className="rc-equiv-cost">≈ ¥{fmtYuan(eq.unit.videoCostYuan)} 成本/条</small>
              )}
            </span>
            <span>
              <b>{fmt(eq.textTasks)}</b> 次文本任务
              {eq.unit.textTaskCostYuan != null && (
                <small className="rc-equiv-cost">
                  ≈ ¥{fmtYuan(eq.unit.textTaskCostYuan)} 成本/次{eq.basis === 'observed' ? '（真实均值）' : ''}
                </small>
              )}
            </span>
          </span>
        ) : (
          <Spin size="small" />
        )}
      </div>

      <Alert
        type="info"
        showIcon
        message={
          eq
            ? `计费规则：1 积分 = ¥${eq.assumptions.creditYuan}；按中转站真实 AI 成本 ×${eq.marginFactor ?? eq.assumptions.marginMultiplier} 扣减。典型文本任务约 ${eq.unit.textTaskCredits} 分/次、生图约 ${eq.unit.imageCredits} 分/张、${eq.assumptions.video.durationSeconds} 秒视频约 ${eq.unit.videoCredits} 分/条。企业内所有账号共享同一积分池。`
            : '计费规则：按真实 AI 成本上浮后扣减积分，企业内所有账号共享同一积分池。'
        }
      />

      <Segmented value={tab} onChange={v => setTab(v as string)} options={['套餐充值', '充值记录', '消耗明细']} />

      {tab === '套餐充值' && (
        <>
          {planPkgs.length > 0 && (
            <>
              <div className="rc-group-title">
                年度套餐 <span>含账号席位与有效期，赠送积分在开通时到账</span>
              </div>
              <Row gutter={[14, 14]}>{planPkgs.map(renderPackage)}</Row>
            </>
          )}
          <div className="rc-group-title">
            积分包 <span>按用量充值，到账即用</span>
          </div>
          <Row gutter={[14, 14]}>{creditPkgs.map(renderPackage)}</Row>
        </>
      )}

      {tab === '充值记录' && (
        <Panel title="充值记录">
          <Table
            size="small"
            rowKey="id"
            dataSource={orders}
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无充值记录" /> }}
            columns={[
              {
                title: '订单号',
                dataIndex: 'order_no',
                render: (v: string) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{v}</span>,
              },
              { title: '套餐', dataIndex: 'package_name' },
              { title: '金额', dataIndex: 'price_yuan', align: 'right', render: (v: number) => `¥${v}` },
              {
                title: '积分',
                dataIndex: 'credits',
                align: 'right',
                render: (v: number) =>
                  v > 0 ? <b style={{ color: 'var(--ui-accent)' }}>{v.toLocaleString()}</b> : <span>套餐</span>,
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 90,
                render: (v: string) => (
                  <Tag color={v === '已支付' ? 'green' : v === '待支付' ? 'gold' : 'default'}>{v}</Tag>
                ),
              },
              {
                title: '时间',
                dataIndex: 'created_at',
                width: 150,
                render: (v: string) => <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>{v}</span>,
              },
              {
                title: '操作',
                width: 70,
                render: (_: any, r: any) =>
                  r.status === '待支付' ? (
                    <button
                      type="button"
                      className="ui-link-button"
                      onClick={() =>
                        api.post(`/recharge/orders/${r.id}/cancel`, {}).then(() => {
                          message.success('已取消');
                          loadOrders().catch(() => {});
                        })
                      }
                    >
                      取消
                    </button>
                  ) : (
                    <CheckCircleOutlined style={{ color: 'var(--chart-2)' }} />
                  ),
              },
            ]}
          />
        </Panel>
      )}

      {tab === '消耗明细' && (
        <Panel title="积分流水（充值入账 + 功能消耗，对账明细）">
          <Table
            size="small"
            rowKey={(_, i) => String(i)}
            dataSource={bal.logs}
            pagination={{ pageSize: 12 }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无流水" /> }}
            columns={[
              {
                title: '项目',
                dataIndex: 'feature',
                render: (v: string, r: any) => (
                  <span>
                    {v}
                    {r.model && <Tag style={{ marginLeft: 6, fontSize: 10 }}>{r.model}</Tag>}
                  </span>
                ),
              },
              {
                title: '类型',
                dataIndex: 'kind',
                width: 80,
                render: (v: string) => (
                  <Tag color={v === 'recharge' ? 'green' : v === 'bonus' ? 'gold' : 'blue'} style={{ fontSize: 11 }}>
                    {v === 'recharge'
                      ? '充值'
                      : v === 'bonus'
                        ? '套餐赠送'
                        : v === 'text'
                          ? '文本'
                          : v === 'image'
                            ? '生图'
                            : v === 'video'
                              ? '视频'
                              : v}
                  </Tag>
                ),
              },
              {
                title: '积分变动',
                dataIndex: 'credits',
                align: 'right',
                width: 100,
                render: (v: number) =>
                  v < 0 ? (
                    <b style={{ color: 'var(--chart-2)' }}>+{(-v).toLocaleString()}</b>
                  ) : (
                    <span style={{ color: 'var(--danger)' }}>-{v.toLocaleString()}</span>
                  ),
              },
              {
                title: '余额',
                dataIndex: 'balance_after',
                align: 'right',
                width: 100,
                render: (v: number) => (v ?? 0).toLocaleString(),
              },
              {
                title: '时间',
                dataIndex: 'created_at',
                width: 150,
                render: (v: string) => <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>{v}</span>,
              },
            ]}
          />
        </Panel>
      )}

      {/* 在线支付：通道选择（仅后端已配置支付通道时进入） */}
      <Modal
        open={!!pickPkg}
        title={pickPkg ? `确认下单：${pickPkg.name}` : ''}
        okText="下单并生成收款码"
        cancelText="取消"
        confirmLoading={placing}
        onOk={placeOnlineOrder}
        onCancel={() => setPickPkg(null)}
      >
        {pickPkg && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
            {orderSummary(pickPkg)}
            <div>
              <div style={{ marginBottom: 8, color: 'var(--ui-muted)' }}>选择支付方式</div>
              <Radio.Group value={payChannel} onChange={e => setPayChannel(e.target.value)} buttonStyle="solid">
                {channels.map((c: any) => (
                  <Radio.Button key={c.channel} value={c.channel}>
                    {c.channel === 'wechat' ? (
                      <WechatOutlined style={{ color: '#09bb07', marginRight: 6 }} />
                    ) : (
                      <AlipayCircleOutlined style={{ color: '#1677ff', marginRight: 6 }} />
                    )}
                    {c.name}
                  </Radio.Button>
                ))}
              </Radio.Group>
            </div>
          </div>
        )}
      </Modal>

      {/* 在线支付：扫码 + 状态轮询（每3秒；支付成功自动刷新余额） */}
      <Modal
        open={!!payOrder}
        title={payStatus === '已支付' ? '支付成功' : `请使用${payOrder?.channelName || ''}扫码支付`}
        onCancel={() => {
          setPayOrder(null);
          loadOrders();
        }}
        maskClosable={false}
        footer={[
          <Button
            key="close"
            onClick={() => {
              setPayOrder(null);
              loadOrders();
            }}
          >
            {payStatus === '已支付' ? '完成' : '暂不支付，关闭'}
          </Button>,
        ]}
      >
        {payOrder && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '8px 0' }}>
            {payStatus === '已支付' ? (
              <Result
                status="success"
                title={payOrder.package?.kind === 'plan' ? '套餐已开通' : '积分已到账'}
                style={{ padding: 12 }}
                subTitle={
                  payOrder.package?.kind === 'plan'
                    ? `${payOrder.package?.name}已生效${payOrder.package?.bonus_credits > 0 ? `，赠送 ${fmt(payOrder.package.bonus_credits)} 积分已充入企业积分池` : ''}`
                    : `${payOrder.package?.name}（${fmt(payOrder.package?.total_credits)} 积分）已充入企业积分池`
                }
              />
            ) : (
              <>
                <QRCode
                  value={payOrder.qrUrl || '-'}
                  size={200}
                  status={payStatus === '已取消' ? 'expired' : 'active'}
                />
                <div style={{ fontSize: 13, color: 'var(--ui-text)' }}>
                  订单 <b style={{ fontFamily: 'monospace' }}>{payOrder.orderNo}</b>　金额{' '}
                  <b style={{ color: 'var(--danger)' }}>¥{payOrder.package?.price_yuan}</b>
                </div>
                {payStatus === '已取消' ? (
                  <Alert type="warning" showIcon message="订单已取消，二维码失效" />
                ) : (
                  <div
                    style={{ fontSize: 12, color: 'var(--ui-muted)', display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <Spin size="small" /> 等待支付中，支付成功后自动到账（二维码30分钟内有效）
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Modal>

      {/* 下单成功：收款指引 */}
      <Modal
        open={!!orderResult}
        footer={[
          <Button
            key="ok"
            type="primary"
            onClick={() => {
              setOrderResult(null);
              loadBal().catch(() => {});
            }}
          >
            我知道了
          </Button>,
        ]}
        onCancel={() => setOrderResult(null)}
        title="订单已提交，请完成支付"
      >
        {orderResult && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
            <div className="rc-order-box">
              <div>
                订单号：<b style={{ fontFamily: 'monospace' }}>{orderResult.orderNo}</b>
              </div>
              <div>
                套餐：{orderResult.package?.name}　金额：
                <b className="rc-price">¥{orderResult.package?.price_yuan}</b>
              </div>
              <div>
                {orderResult.package?.kind === 'plan' ? (
                  <>权益：{planTerms(orderResult.package).join(' · ')}</>
                ) : (
                  <>
                    到账积分：<b className="rc-credit">{fmt(orderResult.package?.total_credits)}</b>
                  </>
                )}
              </div>
            </div>
            <Alert type="warning" showIcon message={orderResult.payGuide} />
            <div style={{ fontSize: 12, color: 'var(--ui-muted)' }}>
              支付完成后，平台确认到账，{orderResult.package?.kind === 'plan' ? '套餐自动生效、赠送积分' : '积分将自动'}
              充入企业积分池，可在「充值记录」查看状态。
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
