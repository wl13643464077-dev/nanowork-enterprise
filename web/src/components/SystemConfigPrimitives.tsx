import type { ReactNode } from 'react';
import { InputNumber } from 'antd';

export function createSystemConfigPrimitives(canSaveConfig: boolean) {
  const numField = (label: string, value: any, onChange: (next: any) => void, options: any = {}) => (
    <div key={label}>
      <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>{label}</div>
      <InputNumber
        size="small"
        style={{ width: '100%' }}
        value={value}
        disabled={!canSaveConfig}
        min={0}
        onChange={next => onChange(next ?? 0)}
        {...options}
      />
    </div>
  );
  const cfgGroup = (title: string, body: ReactNode) => (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          color: 'var(--ui-text)',
          marginBottom: 8,
          paddingLeft: 8,
          borderLeft: '3px solid var(--ui-accent)',
        }}
      >
        {title}
      </div>
      {body}
    </div>
  );
  const grid = (children: ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 10 }}>
      {children}
    </div>
  );
  return { numField, cfgGroup, grid };
}
