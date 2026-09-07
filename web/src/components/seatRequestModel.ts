export type SeatSummary = {
  primaryAccount: { id: number; username: string; name: string; role: string; status: string } | null;
  primaryAssignmentRequired: boolean;
  includedPrimarySeats: number;
  includedSubSeats: number;
  purchasedExtraSeats: number;
  legacyExtraSeats: number | null;
  seatLimit: number | null;
  seatsUsed: number;
  subSeatLimit: number | null;
  subSeatsUsed: number;
  availableSubSeats: number | null;
  canRequestAdditionalSeats: boolean;
};

export type SeatRequest = {
  id: number;
  tenantId: number;
  tenantName: string;
  requestedByName: string;
  additionalSeats: number;
  reason: string;
  status: 'requested' | 'quoted' | 'applied' | 'rejected' | 'cancelled';
  amountFen: number | null;
  quoteNote?: string;
  closeReason?: string;
  orderId: number | null;
  orderNo?: string;
  orderStatus?: string;
  paymentReference?: string;
  appliedAt?: string;
  createdAt: string;
};

export const SEAT_REQUEST_STATUS = {
  requested: { label: '待报价', color: 'processing' },
  quoted: { label: '已报价，待确认收款', color: 'warning' },
  applied: { label: '已开通', color: 'success' },
  rejected: { label: '未通过', color: 'default' },
  cancelled: { label: '已取消', color: 'default' },
};

export const isOpenSeatRequest = (item: SeatRequest) => item.status === 'requested' || item.status === 'quoted';
export const seatAmount = (amountFen: number | null) =>
  amountFen == null ? '待平台报价' : `¥${(amountFen / 100).toFixed(2)}`;
export const seatDate = (value?: string) => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—');

export const planSeatDescription = (seatLimit: number | null | undefined) =>
  seatLimit === 5
    ? '1 个主账号 + 4 个副账号'
    : `${seatLimit == null ? '' : `历史套餐记录 ${seatLimit} 个账号；`}企业额度保持不变，扩容另申请`;

export function seatQuotePayload(amountYuan: number | null | undefined, note?: string) {
  const amountFen = Math.round(Number(amountYuan) * 100);
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0 || Math.abs(Number(amountYuan) * 100 - amountFen) > 0.00001)
    throw new Error('请输入大于 0 的报价金额，最多保留两位小数');
  return { amountFen, ...(note?.trim() ? { note: note.trim() } : {}) };
}

export function seatPaymentPayload(request: SeatRequest, paymentReference: string) {
  if (request.status !== 'quoted' || !request.orderId || !(Number(request.amountFen) > 0))
    throw new Error('该申请尚未生成有效报价订单，请刷新核对');
  if (!paymentReference.trim()) throw new Error('请填写实际收款的流水号或凭据编号');
  return { paymentReference: paymentReference.trim() };
}

export function isSeatSummary(value: unknown): value is SeatSummary {
  if (!value || typeof value !== 'object') return false;
  const data = value as SeatSummary;
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  return (
    count(data.seatsUsed) &&
    count(data.subSeatsUsed) &&
    count(data.purchasedExtraSeats) &&
    [data.seatLimit, data.subSeatLimit, data.availableSubSeats, data.legacyExtraSeats].every(
      value => value === null || count(value),
    ) &&
    typeof data.primaryAssignmentRequired === 'boolean' &&
    typeof data.canRequestAdditionalSeats === 'boolean'
  );
}
