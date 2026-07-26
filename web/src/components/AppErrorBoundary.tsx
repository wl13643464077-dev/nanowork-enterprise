import React from 'react';
import { Button, Result, Space } from 'antd';
import { HomeOutlined, ReloadOutlined } from '@ant-design/icons';

interface State { failed: boolean; }

export class AppErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error('[UI recovery]', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--ui-bg)' }}>
        <Result
          status="warning"
          title="当前页面内容加载异常"
          subTitle="系统已拦截异常，经营数据不会丢失。可以重新加载当前页面，或返回驾驶舱继续操作。"
          extra={<Space wrap>
            <Button icon={<ReloadOutlined />} onClick={() => window.location.reload()}>重新加载</Button>
            <Button type="primary" icon={<HomeOutlined />} onClick={() => { window.location.href = '/'; }}>返回驾驶舱</Button>
          </Space>}
        />
      </div>
    );
  }
}
