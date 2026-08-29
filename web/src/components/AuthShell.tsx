import type { CSSProperties, ReactNode } from 'react';
import './AuthShell.css';

/**
 * AuthShell —— Login / Register / Pending 三页共享的认证外壳。
 * 统一：mesh 动态背景、品牌 lockup、玻璃卡片规格、进场编排、页脚。
 * layout='split'：左叙事 + 右表单（登录页）；layout='center'：单卡居中。
 */

export function enterDelay(ms: number): CSSProperties {
  return { '--d': `${ms}ms` } as CSSProperties;
}

export function AuthBrand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="au-brand">
      <img src="/brand/nanowork-icon.svg" alt="纳米Work" />
      <div>
        <div className="au-brand-name" style={compact ? { fontSize: 'var(--font-4)' } : undefined}>
          纳米Work<span>行业版</span>
        </div>
        <div className="au-brand-sub">NANOWORK · INDUSTRY OPERATING SYSTEM</div>
      </div>
    </div>
  );
}

export function TrustMarks() {
  const check = (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M2 6.2 5 9l5-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
  return (
    <div className="au-trust">
      <span>{check}数据按企业隔离</span>
      <span>{check}关键动作可追溯</span>
      <span>{check}AI外发需人工确认</span>
    </div>
  );
}

export default function AuthShell({
  layout = 'center',
  aside,
  ariaLabel,
  backdrop,
  children,
}: {
  layout?: 'split' | 'center';
  aside?: ReactNode;
  ariaLabel: string;
  /** 页面级增强动效层（光流、员工星阵等），渲染在 mesh 背景之上、内容之下 */
  backdrop?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className={`au-shell au-${layout}`}>
      <a className="au-skip" href="#auth-card">
        跳到表单
      </a>
      <div className="au-mesh" aria-hidden="true">
        <i className="au-blob au-blob-a" />
        <i className="au-blob au-blob-b" />
        <i className="au-blob au-blob-c" />
        <i className="au-blob au-blob-d" />
        {layout === 'split' && (
          <svg className="au-hex" viewBox="0 0 420 460" aria-hidden="true">
            <path d="M210 18 386 120v204L210 426 34 324V120Z" />
            <path d="M210 92 322 156v128L210 348 98 284V156Z" />
          </svg>
        )}
      </div>
      {backdrop}
      {layout === 'split' && aside ? (
        <section className="au-story" aria-label="产品介绍">
          {aside}
        </section>
      ) : null}
      <section className="au-panel" aria-label={ariaLabel}>
        <div className="au-card au-enter" id="auth-card" style={enterDelay(160)}>
          {children}
        </div>
      </section>
      <footer className="au-pagefoot">纳米Work行业版 · 让每一家餐饮门店都有一支懂行业、能落地的数字员工队伍</footer>
    </main>
  );
}
