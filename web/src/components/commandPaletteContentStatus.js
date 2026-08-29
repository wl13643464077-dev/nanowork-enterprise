export const COMMAND_PALETTE_RECONCILIATION_STATUS = '业务暂不可采用（待账务对账）';
export const COMMAND_PALETTE_UNVERIFIED_ADOPTION_STATUS = '可验收（人工采纳状态待核验）';

const text = value => String(value ?? '').trim();
const isReconciliationStatus = value => /待账务对账|待对账/u.test(text(value));

/**
 * 命令面板只能展示权威交付投影，不能把数据库兼容字段“可使用”直接翻译成
 * 已经人工采纳。delivery.displayStatus 优先级最高；缺少展示文案时再使用
 * delivery.canUse。完全没有 delivery 的旧记录必须保持“待核验”。
 */
export function commandPaletteContentStatus(record) {
  const delivery = record?.delivery && typeof record.delivery === 'object' ? record.delivery : null;
  const rawStatus = text(record?.status);

  if (delivery) {
    const authoritativeStatus = text(delivery.displayStatus);
    if (authoritativeStatus) {
      return isReconciliationStatus(authoritativeStatus) ? COMMAND_PALETTE_RECONCILIATION_STATUS : authoritativeStatus;
    }

    const reconciliationEvidence =
      [rawStatus, delivery.presentationKey, delivery.reason, delivery.nextAction, delivery.billing?.state].some(
        isReconciliationStatus,
      ) ||
      text(delivery.presentationKey) === 'business_blocked' ||
      text(delivery.billing?.state) === 'pending_reconciliation';
    if (reconciliationEvidence) return COMMAND_PALETTE_RECONCILIATION_STATUS;

    if (delivery.canUse === true) {
      return rawStatus === '已发布' ? '已发布' : '已人工采纳（可用于业务）';
    }
    if (delivery.canUse === false) {
      if (rawStatus === '待审核') return '待人工审阅';
      if (rawStatus === '已驳回') return '失败需返工（人工审阅未通过）';
      return '业务暂不可采用';
    }
  }

  if (isReconciliationStatus(rawStatus)) return COMMAND_PALETTE_RECONCILIATION_STATUS;
  if (rawStatus === '可使用') return COMMAND_PALETTE_UNVERIFIED_ADOPTION_STATUS;
  if (rawStatus === '待审核') return '待人工审阅';
  if (rawStatus === '已驳回') return '失败需返工（人工审阅未通过）';
  return rawStatus || '状态未知';
}
