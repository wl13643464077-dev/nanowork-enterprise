import type { ReactNode } from 'react';
import './GrowthPrimitives.css';

export function GrowthInfoRow({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="growth-info-row">
      <span className="growth-info-row__label">{label}</span>
      <span className="growth-info-row__value">{value ? String(value) : '-'}</span>
    </div>
  );
}

export function GrowthSectionTitle({ children }: { children: ReactNode }) {
  return <div className="growth-section-title">{children}</div>;
}
