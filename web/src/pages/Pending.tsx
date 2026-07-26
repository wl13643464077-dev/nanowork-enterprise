import { Button, Card, Result } from 'antd';
import { useNavigate } from 'react-router-dom';
import { clearAuth, getUser } from '../api/client';

export default function Pending() {
  const nav = useNavigate();
  const u = getUser();
  const stopped = u?.tenant?.status === '已停用';
  return (
    <main style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'radial-gradient(circle at 15% 15%, rgba(44,118,220,.28), transparent 32%), radial-gradient(circle at 85% 82%, rgba(38,116,210,.18), transparent 30%), linear-gradient(135deg,#041326 0%,#071d36 48%,#031020 100%)', padding: '28px 16px' }}>
      <Card style={{ width: 'min(100%, 520px)', borderRadius: 20, borderColor: 'rgba(137,184,238,.32)', boxShadow: '0 28px 80px rgba(0,8,19,.4)' }}
        styles={{ body: { padding: '30px clamp(18px,5vw,32px)' } }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 4 }}>
          <img src="/brand/nanowork-icon.svg" alt="纳米Work" width={42} height={42} />
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: 15, fontWeight: 750, color: 'var(--ui-text)' }}>纳米Work行业版</div>
            <div style={{ fontSize: 10.5, color: 'var(--ui-muted)', marginTop: 1 }}>企业经营入口</div>
          </div>
        </div>
        <Result
          status={stopped ? 'error' : 'info'}
          title={stopped ? '企业账号已停用' : '企业账号审核中'}
          subTitle={stopped
            ? '您的企业账号已被停用，如需恢复请联系平台客服。'
            : `「${u?.tenant?.name || '您的企业'}」已提交注册，正在等待平台审核开通。开通后即可登录使用全部功能，我们会尽快处理。`}
          extra={<Button type="primary" onClick={() => { clearAuth(); nav('/login'); }}>返回登录</Button>}
        />
      </Card>
    </main>
  );
}
