import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Form, Input, InputNumber, Popconfirm, Space, Spin, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import {
  isOpenSeatRequest,
  isSeatSummary,
  SEAT_REQUEST_STATUS,
  seatAmount,
  seatDate,
  type SeatRequest,
  type SeatSummary,
} from './seatRequestModel';
import './SeatRequests.css';

export function SeatQuota({ summary }: { summary: SeatSummary }) {
  return (
    <>
      <div className="seat-quota-grid">
        <div>
          <span>基础账号</span>
          <strong>1 主 + 4 副</strong>
        </div>
        <div>
          <span>副账号已用 / 额度</span>
          <strong>
            {summary.subSeatsUsed} / {summary.subSeatLimit ?? '存量不限额'}
          </strong>
        </div>
        <div>
          <span>可用副账号</span>
          <strong>{summary.availableSubSeats ?? '存量不限额'}</strong>
        </div>
        <div>
          <span>已购追加副账号</span>
          <strong>{summary.purchasedExtraSeats}</strong>
        </div>
        <div>
          <span>保留的存量名额</span>
          <strong>{summary.legacyExtraSeats ?? '存量不限额'}</strong>
        </div>
      </div>
      <p className="seat-muted">
        当前启用 {summary.seatsUsed} 个账号，总额度 {summary.seatLimit ?? '存量不限额'}
        。停用的副账号不占名额；主账号名额独立保留。
      </p>
    </>
  );
}

export default function SeatRequestPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [summary, setSummary] = useState<SeatSummary | null>(null);
  const [items, setItems] = useState<SeatRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [form] = Form.useForm();
  const mutation = useRef(false);
  const epoch = useRef(0);
  const load = useCallback(async () => {
    const version = ++epoch.current;
    setLoading(true);
    setError('');
    try {
      const data = await api.get('/admin/seat-requests', { silent: true });
      if (!Array.isArray(data?.items) || !isSeatSummary(data?.summary))
        throw new Error('账号额度返回不完整，请刷新重试');
      if (version !== epoch.current) return;
      setItems(data.items);
      setSummary(data.summary);
    } catch (cause) {
      if (version === epoch.current) setError(cause instanceof Error ? cause.message : '账号额度加载失败');
    } finally {
      if (version === epoch.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => void load());
    return () => {
      cancelAnimationFrame(frame);
      epoch.current += 1;
    };
  }, [load, refreshKey]);

  const openRequest = items.find(isOpenSeatRequest);
  const create = async (values: { additionalSeats: number; reason?: string }) => {
    if (mutation.current || loading || error || !summary?.canRequestAdditionalSeats || openRequest) return;
    mutation.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const data = await api.post(
        '/admin/seat-requests',
        { additionalSeats: values.additionalSeats, reason: values.reason?.trim() },
        { silent: true },
      );
      if (!data?.request?.id || !isSeatSummary(data?.summary)) throw new Error('申请回执不完整，请刷新核对后再操作');
      setNotice(`已申请增加 ${data.request.additionalSeats} 个副账号，等待平台报价；尚未增加额度。`);
      form.resetFields();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '申请未完成，请刷新核对');
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  };
  const cancel = async (request: SeatRequest) => {
    if (mutation.current || loading || error || !summary?.canRequestAdditionalSeats || !isOpenSeatRequest(request))
      return;
    mutation.current = true;
    setBusy(true);
    setError('');
    try {
      const data = await api.post(`/admin/seat-requests/${request.id}/cancel`, {}, { silent: true });
      if (data?.request?.status !== 'cancelled') throw new Error('取消回执不完整，请刷新核对');
      setNotice(`增加 ${request.additionalSeats} 个副账号的申请已取消，额度未变更。`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '取消未完成，请刷新核对');
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="seat-panel" id="seat-requests" aria-label="账号额度与扩容">
      <header className="seat-panel-header">
        <div>
          <h2>账号额度与扩容</h2>
          <p>主账号与权限角色分开。副账号也可拥有老板或管理员权限。</p>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} disabled={busy} onClick={() => void load()}>
          刷新
        </Button>
      </header>
      {error && <Alert type="error" showIcon message="未完成读取或操作" description={`${error}。请先刷新核对状态。`} />}
      {notice && <Alert type="success" showIcon message={notice} />}
      {loading ? (
        <Spin tip="读取账号额度…">
          <div className="seat-loading" />
        </Spin>
      ) : summary ? (
        <>
          <SeatQuota summary={summary} />
          {summary.primaryAssignmentRequired ? (
            <Alert
              type="warning"
              showIcon
              message="主账号待确认"
              description="请联系平台确认本企业主账号，确认后由主账号申请扩容。现有名额保留。"
            />
          ) : (
            <p className="seat-muted">
              主账号：{summary.primaryAccount?.name}（{summary.primaryAccount?.username}）
              {!summary.canRequestAdditionalSeats && '。仅主账号可提交或取消扩容申请。'}
            </p>
          )}
          {openRequest ? (
            <div className="seat-active-request">
              <Space wrap>
                <Tag color={SEAT_REQUEST_STATUS[openRequest.status].color}>
                  {SEAT_REQUEST_STATUS[openRequest.status].label}
                </Tag>
                <strong>增加 {openRequest.additionalSeats} 个副账号</strong>
                <strong>{seatAmount(openRequest.amountFen)}</strong>
              </Space>
              {openRequest.quoteNote && <p>{openRequest.quoteNote}</p>}
              {openRequest.orderNo && <p className="seat-muted">订单：{openRequest.orderNo}</p>}
              <p>平台确认实际收款后开通，当前额度尚未增加。此项仅增加副账号，不赠送积分。</p>
              {summary.canRequestAdditionalSeats && (
                <Popconfirm
                  title="取消这次扩容申请？"
                  description="如已转账，请先联系平台核对款项。"
                  onConfirm={() => cancel(openRequest)}
                  okText="取消申请"
                  cancelText="保留申请"
                >
                  <Button disabled={!!error} loading={busy}>
                    取消申请
                  </Button>
                </Popconfirm>
              )}
            </div>
          ) : (
            summary.canRequestAdditionalSeats && (
              <Form form={form} layout="vertical" onFinish={create} className="seat-request-form">
                <div className="seat-form-fields">
                  <Form.Item
                    name="additionalSeats"
                    label="增加多少个副账号"
                    rules={[{ required: true, type: 'number', min: 1, max: 1000, message: '请输入 1 到 1000 的整数' }]}
                  >
                    <InputNumber min={1} max={1000} precision={0} placeholder="填写数量" />
                  </Form.Item>
                  <Form.Item name="reason" label="说明（选填）">
                    <Input maxLength={500} placeholder="例如：新店需要 3 名成员共同使用" />
                  </Form.Item>
                </div>
                <p className="seat-muted">价格由平台报价，确认收款后开通。提交申请不会扣积分或增加额度。</p>
                <Button type="primary" htmlType="submit" loading={busy} disabled={!!error}>
                  提交扩容申请
                </Button>
              </Form>
            )
          )}
          <details className="seat-history">
            <summary>申请记录（{items.length}）</summary>
            {items.length ? (
              <div className="seat-request-list">
                {items.map(item => (
                  <article key={item.id}>
                    <Space wrap>
                      <Tag color={SEAT_REQUEST_STATUS[item.status].color}>{SEAT_REQUEST_STATUS[item.status].label}</Tag>
                      <strong>增加 {item.additionalSeats} 个副账号</strong>
                      <span>{seatAmount(item.amountFen)}</span>
                    </Space>
                    <p className="seat-muted">
                      {seatDate(item.createdAt)}
                      {item.orderNo ? ` · 订单 ${item.orderNo}` : ''}
                    </p>
                    {item.reason && <p>{item.reason}</p>}
                    {item.quoteNote && <p>{item.quoteNote}</p>}
                    {item.closeReason && <p>处理说明：{item.closeReason}</p>}
                  </article>
                ))}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无扩容申请" />
            )}
          </details>
        </>
      ) : (
        !error && <p className="seat-muted">账号额度待读取</p>
      )}
    </section>
  );
}
