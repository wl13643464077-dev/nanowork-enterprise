import React from 'react';
import { Button, Result, Space } from 'antd';
import { HomeOutlined, ReloadOutlined } from '@ant-design/icons';

interface State {
  failed: boolean;
}

function focusError(ref: React.RefObject<HTMLDivElement | null>) {
  const focus = () => ref.current?.focus();
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(focus);
    return;
  }
  focus();
}

/**
 * 路由级错误边界。
 *
 * 此前全项目只有 AppErrorBoundary 一个挂载点（粒度为整个 App），
 * 任一页面渲染异常就白屏整站、侧栏导航一起消失，用户只能重载。
 * 这个边界压在内容区内部：外壳与导航保持可用。重试时重新加载当前页面，
 * 同时恢复普通渲染异常和发版后旧 chunk/CSS 哈希失效导致的 404。
 * resetKey 变化时仍会自动恢复，所以切页后不会卡在错误态。
 */
export class RouteErrorBoundary extends React.Component<
  React.PropsWithChildren<{ resetKey?: string }>,
  State & { attempt: number }
> {
  state: State & { attempt: number } = { failed: false, attempt: 0 };
  private errorRef = React.createRef<HTMLDivElement>();

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidUpdate(prev: React.PropsWithChildren<{ resetKey?: string }>) {
    // 切换路由即自动脱离错误态，避免用户被困在上一个页面的异常里
    if (this.state.failed && prev.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  componentDidCatch(error: Error) {
    console.error('[UI recovery] route', error);
    focusError(this.errorRef);
  }

  render() {
    if (!this.state.failed) return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
    return (
      <div ref={this.errorRef} role="alert" aria-live="assertive" aria-atomic="true" tabIndex={-1}>
        <Result
          status="warning"
          title="这个页面没能正常显示"
          subTitle="异常已被拦截，经营数据不受影响。重新加载可恢复普通页面异常和发版后的旧资源缓存。"
          extra={
            <Button type="primary" icon={<ReloadOutlined />} onClick={() => window.location.reload()}>
              重试
            </Button>
          }
        />
      </div>
    );
  }
}

export class AppErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { failed: false };
  private errorRef = React.createRef<HTMLDivElement>();

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error('[UI recovery]', error);
    focusError(this.errorRef);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        ref={this.errorRef}
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        tabIndex={-1}
        style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--ui-bg)' }}
      >
        <Result
          status="warning"
          title="当前页面内容加载异常"
          subTitle="系统已拦截异常，经营数据不会丢失。可以重新加载当前页面，或返回驾驶舱继续操作。"
          extra={
            <Space wrap>
              <Button icon={<ReloadOutlined />} onClick={() => window.location.reload()}>
                重新加载
              </Button>
              <Button
                type="primary"
                icon={<HomeOutlined />}
                onClick={() => {
                  window.location.href = '/';
                }}
              >
                返回驾驶舱
              </Button>
            </Space>
          }
        />
      </div>
    );
  }
}
