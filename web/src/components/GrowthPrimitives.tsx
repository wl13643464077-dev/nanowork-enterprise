import { isValidElement, type ReactNode } from 'react';
import './GrowthPrimitives.css';

/**
 * value 可以是文本/数字，也可以是 ReactNode（如 Tag）。
 * 旧实现统一 String(value)，把 React 元素渲染成了 "[object Object]"。
 * 非法值（普通对象、数组里夹对象）一律按空值显示「—」，不再泄漏到界面。
 */
export function GrowthInfoRow({ label, value }: { label: string; value?: unknown }) {
  let content: ReactNode = '—';
  if (isValidElement(value)) content = value;
  else if (typeof value === 'string') content = value.trim() || '—';
  else if (typeof value === 'number' && Number.isFinite(value)) content = String(value);
  return (
    <div className="growth-info-row">
      <span className="growth-info-row__label">{label}</span>
      <span className="growth-info-row__value">{content}</span>
    </div>
  );
}

export function GrowthSectionTitle({ children }: { children: ReactNode }) {
  return <div className="growth-section-title">{children}</div>;
}
