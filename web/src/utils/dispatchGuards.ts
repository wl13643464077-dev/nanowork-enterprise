// 派活前后的两道护栏，桌面工作台与手机派活共用：
// 1) 常用问法里没替换完的 {占位符} 不让发出去；2) 积分不足（HTTP 402）时给出余额、用量与差额。
import type { ApiRequestError } from '../api/client';

// 常用问法模板里的占位符形如 {城市}{商圈}{品类}（约定见 RestaurantDispatchAssist.tsx 顶部注释，
// 服务端替换规则见 employee-question-templates.js：花括号内 1~12 个字）。
// 这里只认「花括号内是中文/字母开头的短词、不含空格引号冒号」的形式，避免误伤 JSON 片段等正常文本。
const DISPATCH_PLACEHOLDER = /\{[\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9/、·_-]{0,11}\}/gu;
export function findDispatchPlaceholders(value: unknown) {
  return Array.from(String(value ?? '').matchAll(DISPATCH_PLACEHOLDER), match => ({
    token: match[0],
    index: match.index ?? 0,
  }));
}

// 余额不足（HTTP 402）：工作台路由只透出文案，这里从文案里取出余额与预估用量。
export type CreditShortfall = { balance: number | null; need: number | null };
export function parseCreditShortfall(error: unknown): CreditShortfall | null {
  const failure = error as ApiRequestError | null;
  if (!failure || failure.status !== 402) return null;
  const messageText = String(failure.message || '');
  if (failure.code !== 'INSUFFICIENT_CREDITS' && !/积分(?:余额)?不足/u.test(messageText)) return null;
  const pick = (pattern: RegExp) => {
    const matched = pattern.exec(messageText)?.[1];
    const parsed = matched ? Number(matched.replace(/,/gu, '')) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };
  return { balance: pick(/当前\s*([\d,]+)\s*(?:积分|分)/u), need: pick(/需\s*([\d,]+)\s*(?:积分|分)/u) };
}
export function creditShortfallText(shortfall: CreditShortfall) {
  if (shortfall.balance === null || shortfall.need === null) return '积分余额不足，这次派活还没有发出。';
  const gap = Math.max(0, shortfall.need - shortfall.balance);
  return `当前余额 ${shortfall.balance} 积分，本次预估最多需要 ${shortfall.need} 积分，还差 ${gap} 积分。`;
}
