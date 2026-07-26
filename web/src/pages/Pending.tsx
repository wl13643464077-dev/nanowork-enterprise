import { Button, Result } from 'antd';
import { useNavigate } from 'react-router-dom';
import { clearAuth, getUser } from '../api/client';
import AuthShell, { AuthBrand } from '../components/AuthShell';

export default function Pending() {
  const nav = useNavigate();
  const u = getUser();
  const stopped = u?.tenant?.status === '已停用';
  return (
    <AuthShell ariaLabel="企业账号状态">
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <AuthBrand compact />
      </div>
      <Result
        status={stopped ? 'error' : 'info'}
        title={stopped ? '企业账号已停用' : '企业账号审核中'}
        subTitle={
          stopped
            ? '您的企业账号已被停用，如需恢复请联系平台客服。'
            : `「${u?.tenant?.name || '您的企业'}」已提交注册，正在等待平台审核开通。开通后即可登录使用全部功能，我们会尽快处理。`
        }
        extra={
          <Button type="primary" className="au-submit" onClick={() => { clearAuth(); nav('/login'); }}>
            返回登录
          </Button>
        }
      />
    </AuthShell>
  );
}
