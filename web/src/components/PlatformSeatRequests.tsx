import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Form, Input, InputNumber, Modal, Select, Space, Spin, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import { SeatQuota } from './SeatRequestPanel';
import {
  isSeatSummary,
  SEAT_REQUEST_STATUS,
  seatAmount,
  seatDate,
  seatPaymentPayload,
  seatQuotePayload,
  type SeatRequest,
  type SeatSummary,
} from './seatRequestModel';
import './SeatRequests.css';

export function PrimaryAccountBinding({ tenantId, onChanged }: { tenantId: number; onChanged?: () => void }) {
  const [summary, setSummary] = useState<SeatSummary | null>(null);
  const [users, setUsers] = useState<{ id: number; name: string; username: string }[]>([]);
  const [userId, setUserId] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const epoch = useRef(0);
  const binding = useRef(false);
  const load = useCallback(async () => {
    const version = ++epoch.current;
    setLoading(true);
    setError('');
    try {
      const [requests, detail] = await Promise.all([
        api.get(`/platform/seat-requests?tenantId=${tenantId}`, { silent: true }),
        api.get(`/platform/tenants/${tenantId}`, { silent: true }),
      ]);
      if (!isSeatSummary(requests?.summary) || !Array.isArray(detail?.users)) throw new Error('企业账号信息返回不完整');
      if (version !== epoch.current) return;
      setSummary(requests.summary);
      setUsers(
        detail.users.filter((user: { role: string; status: string }) => user.role === 'boss' && user.status === '启用'),
      );
    } catch (cause) {
      if (version === epoch.current) setError(cause instanceof Error ? cause.message : '企业账号信息加载失败');
    } finally {
      if (version === epoch.current) setLoading(false);
    }
  }, [tenantId]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => void load());
    return () => {
      cancelAnimationFrame(frame);
      epoch.current += 1;
    };
  }, [load]);
  const bind = async () => {
    if (!userId || binding.current || !summary?.primaryAssignmentRequired) return;
    binding.current = true;
    setBusy(true);
    setError('');
    try {
      const data = await api.post(`/platform/tenants/${tenantId}/primary-account`, { userId }, { silent: true });
      if (!data?.ok || !isSeatSummary(data?.summary) || data.summary.primaryAccount?.id !== userId)
        throw new Error('主账号确认回执不完整，请刷新核对');
      setNotice('主账号已确认，原账号名额未增加。');
      await load();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '主账号确认失败，请刷新核对');
    } finally {
      binding.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="seat-primary-binding" aria-label="企业账号额度与主账号">
      {error && (
        <Alert
          type="error"
          message={error}
          action={
            <Button size="small" onClick={() => void load()}>
              重试
            </Button>
          }
        />
      )}
      {notice && <Alert type="success" message={notice} />}
      {loading ? (
        <Spin />
      ) : (
        summary && (
          <>
            <p>
              基础含 1 个主账号 + 4 个副账号；当前总额度 {summary.seatLimit ?? '存量不限额'}，已用 {summary.seatsUsed}{' '}
              个。增加额度请办理席位申请。
            </p>
            {summary.primaryAssignmentRequired ? (
              <>
                <Alert
                  type="warning"
                  showIcon
                  message="主账号待确认"
                  description="请核对企业负责人，再从本企业启用的老板账号中选择。此操作不会新建账号或增加名额。"
                />
                <Select
                  aria-label="确认企业主账号"
                  placeholder="选择本企业启用的老板账号"
                  value={userId}
                  onChange={setUserId}
                  options={users.map(user => ({ value: user.id, label: `${user.name}（${user.username}）` }))}
                  notFoundContent="暂无启用的老板账号"
                />
                <Button onClick={() => void bind()} loading={busy} disabled={!userId || !!error}>
                  确认绑定主账号
                </Button>
              </>
            ) : (
              <p>
                主账号：{summary.primaryAccount?.name}（{summary.primaryAccount?.username}）
              </p>
            )}
          </>
        )
      )}
    </section>
  );
}

export default function PlatformSeatRequests({
  tenants,
  onChanged,
}: {
  tenants: { id: number; name: string }[];
  onChanged?: () => void;
}) {
  const [tenantId, setTenantId] = useState<number>();
  const [items, setItems] = useState<SeatRequest[]>([]);
  const [summary, setSummary] = useState<SeatSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [action, setAction] = useState<{ kind: 'quote' | 'reject' | 'confirm'; request: SeatRequest } | null>(null);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm();
  const epoch = useRef(0);
  const submitting = useRef(false);
  const load = useCallback(async () => {
    const version = ++epoch.current;
    setLoading(true);
    setError('');
    try {
      const data = await api.get(`/platform/seat-requests${tenantId ? `?tenantId=${tenantId}` : ''}`, { silent: true });
      if (!Array.isArray(data?.items) || (tenantId && !isSeatSummary(data?.summary)))
        throw new Error('席位申请列表返回不完整');
      if (version !== epoch.current) return;
      setItems(data.items);
      setSummary(data.summary);
    } catch (cause) {
      if (version === epoch.current) setError(cause instanceof Error ? cause.message : '席位申请加载失败');
    } finally {
      if (version === epoch.current) setLoading(false);
    }
  }, [tenantId]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => void load());
    return () => {
      cancelAnimationFrame(frame);
      epoch.current += 1;
    };
  }, [load]);
  const openAction = (kind: 'quote' | 'reject' | 'confirm', request: SeatRequest) => {
    setActionError('');
    setAction({ kind, request });
  };
  const submit = async () => {
    if (!action || submitting.current) return;
    let values;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setActionError('');
    const request = action.request;
    try {
      if (action.kind === 'quote') {
        const payload = seatQuotePayload(values.amountYuan, values.note);
        const data = await api.post(`/platform/seat-requests/${request.id}/quote`, payload, { silent: true });
        if (data?.request?.status !== 'quoted' || !data.request.orderId)
          throw new Error('报价回执不完整，请刷新核对订单');
        setNotice(
          `「${request.tenantName}」增加 ${request.additionalSeats} 个副账号，报价 ${seatAmount(data.request.amountFen)}，订单 ${data.request.orderNo || data.request.orderId}；等待确认收款，尚未增加额度。`,
        );
      } else if (action.kind === 'confirm') {
        const data = await api.post(
          `/platform/recharge-orders/${request.orderId}/confirm`,
          seatPaymentPayload(request, values.paymentReference || ''),
          { silent: true },
        );
        if (!data?.ok || data?.seatRequest?.status !== 'applied' || !isSeatSummary(data?.seatSummary))
          throw new Error('收款回执不完整，请刷新核对同一订单，勿另建申请');
        setNotice(
          `「${request.tenantName}」${data.duplicated ? '此前已完成' : '已确认收款'} ${seatAmount(request.amountFen)}，${request.additionalSeats} 个副账号已开通；当前总额度 ${data.seatSummary.seatLimit} 个。本次未赠送积分。`,
        );
      } else {
        const data = await api.post(
          `/platform/seat-requests/${request.id}/reject`,
          { reason: values.reason?.trim() },
          { silent: true },
        );
        if (data?.request?.status !== 'rejected') throw new Error('处理回执不完整，请刷新核对');
        setNotice(`「${request.tenantName}」增加 ${request.additionalSeats} 个副账号的申请未通过，额度未变更。`);
      }
      setAction(null);
      await load();
      onChanged?.();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '操作未完成，请核对后重试');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="seat-panel" aria-label="平台席位申请">
      <header className="seat-panel-header">
        <div>
          <h2>席位申请</h2>
          <p>主账号提交申请，平台报价并确认实际收款后开通。扩容仅增加副账号，不赠送积分。</p>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          刷新
        </Button>
      </header>
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        aria-label="筛选企业席位申请"
        placeholder="全部企业"
        value={tenantId}
        onChange={setTenantId}
        options={tenants.map(tenant => ({ value: tenant.id, label: tenant.name }))}
      />
      {error && <Alert type="error" showIcon message="申请列表读取失败" description={error} />}
      {notice && <Alert type="success" showIcon message={notice} />}
      {loading ? (
        <Spin tip="读取申请…">
          <div className="seat-loading" />
        </Spin>
      ) : (
        !error && (
          <>
            {summary && <SeatQuota summary={summary} />}
            {items.length ? (
              <div className="seat-request-list">
                {items.map(item => (
                  <article key={item.id}>
                    <Space wrap>
                      <strong>{item.tenantName}</strong>
                      <Tag color={SEAT_REQUEST_STATUS[item.status].color}>{SEAT_REQUEST_STATUS[item.status].label}</Tag>
                      <strong>增加 {item.additionalSeats} 个副账号</strong>
                      <strong>{seatAmount(item.amountFen)}</strong>
                    </Space>
                    <p className="seat-muted">
                      {item.requestedByName} · {seatDate(item.createdAt)}
                    </p>
                    {item.reason && <p>申请说明：{item.reason}</p>}
                    {item.quoteNote && <p>报价说明：{item.quoteNote}</p>}
                    {item.closeReason && <p>处理说明：{item.closeReason}</p>}
                    {item.orderNo && (
                      <p className="seat-muted">
                        订单 {item.orderNo}
                        {item.paymentReference ? ` · 收款凭据 ${item.paymentReference}` : ''}
                      </p>
                    )}
                    <Space wrap>
                      {item.status === 'requested' && (
                        <Button type="primary" onClick={() => openAction('quote', item)}>
                          填写报价
                        </Button>
                      )}
                      {item.status === 'quoted' && (
                        <Button type="primary" onClick={() => openAction('confirm', item)}>
                          确认收款并开通
                        </Button>
                      )}
                      {['requested', 'quoted'].includes(item.status) && (
                        <Button onClick={() => openAction('reject', item)}>不予开通</Button>
                      )}
                    </Space>
                  </article>
                ))}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无席位申请" />
            )}
          </>
        )
      )}
      <Modal
        open={!!action}
        cancelText="取消"
        title={
          action?.kind === 'quote' ? '填写扩容报价' : action?.kind === 'confirm' ? '确认收款并开通副账号' : '不予开通'
        }
        okText={
          action?.kind === 'quote' ? '确认报价' : action?.kind === 'confirm' ? '已核实收款，开通' : '确认不予开通'
        }
        confirmLoading={busy}
        closable={!busy}
        maskClosable={!busy}
        cancelButtonProps={{ disabled: busy }}
        onCancel={() => setAction(null)}
        onOk={() => void submit()}
        destroyOnHidden
      >
        {action && (
          <>
            <div className="seat-order-summary">
              <strong>
                {action.request.tenantName} · 增加 {action.request.additionalSeats} 个副账号
              </strong>
              {action.kind !== 'quote' && (
                <div>
                  {seatAmount(action.request.amountFen)}
                  {action.request.orderNo ? ` · 订单 ${action.request.orderNo}` : ''}
                </div>
              )}
            </div>
            {actionError && <Alert type="error" showIcon message="未确认完成" description={actionError} />}
            <Form form={form} layout="vertical" preserve={false}>
              {action.kind === 'quote' ? (
                <>
                  <Form.Item
                    name="amountYuan"
                    label="本次扩容总价（元）"
                    rules={[
                      { required: true, message: '请填写实际报价，不预设价格' },
                      {
                        validator: async (_, value) => {
                          seatQuotePayload(value);
                        },
                      },
                    ]}
                  >
                    <InputNumber
                      min={0.01}
                      max={10000000}
                      precision={2}
                      placeholder="填写本次总价"
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                  <Form.Item name="note" label="报价说明（选填）">
                    <Input.TextArea maxLength={500} rows={3} />
                  </Form.Item>
                  <p className="seat-muted">报价确认后生成固定金额与数量的订单。报价本身不会开通账号。</p>
                </>
              ) : action.kind === 'confirm' ? (
                <>
                  <Alert
                    type="warning"
                    showIcon
                    message={`请核实已收到 ${seatAmount(action.request.amountFen)}`}
                    description="只确认本订单实际到账款项。确认后增加对应副账号名额，不充入积分。"
                  />
                  <Form.Item
                    name="paymentReference"
                    label="收款流水号或凭据编号"
                    rules={[{ required: true, whitespace: true, message: '请填写实际收款凭据' }]}
                  >
                    <Input maxLength={200} placeholder="填写银行流水号或线下收款凭据编号" />
                  </Form.Item>
                </>
              ) : (
                <Form.Item name="reason" label="说明（选填）">
                  <Input.TextArea maxLength={500} rows={3} placeholder="如已收款，请先完成款项核对与退款处理" />
                </Form.Item>
              )}
            </Form>
          </>
        )}
      </Modal>
    </section>
  );
}
