import { AlertOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { Panel } from './Kit';
import './SystemErrorState.css';

interface SystemErrorStateProps {
  error: string;
  retrying?: boolean;
  onRetry: () => void;
}

/** 系统核心数据不可用时的 fail-closed 状态，避免页面展示过期或猜测数据。 */
export function SystemErrorState({ error, retrying, onRetry }: SystemErrorStateProps) {
  return (
    <Panel>
      <div className="system-error-state">
        <AlertOutlined className="system-error-state__icon" />
        <div className="system-error-state__title">系统数据加载失败</div>
        <div className="system-error-state__message">
          {error || '网络异常或服务暂不可用'}，已停止展示过期内容，请重试。
        </div>
        <Button type="primary" icon={<ReloadOutlined />} loading={retrying} onClick={onRetry}>
          重新加载
        </Button>
      </div>
    </Panel>
  );
}
