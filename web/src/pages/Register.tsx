import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Form, Input, Result, Segmented } from 'antd';
import { ShopOutlined, UserOutlined, LockOutlined, PhoneOutlined, ContactsOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import AuthShell, { AuthBrand, TrustMarks } from '../components/AuthShell';
import './Register.css';

type RegistrationMode = 'invite' | 'apply';
type InvitationPreview = {
  valid: true;
  type: 'new_tenant' | 'existing_tenant';
  tenantName?: string;
  roleLabel: string;
  expiresAt: string;
};
type RegistrationValues = { company?: string; contactName: string; phone?: string; username: string; password: string };

export function invitationCodeFromHash(hash: string) {
  return new URLSearchParams(hash.replace(/^#/, '')).get('invite')?.trim() || '';
}

export function registrationPayload(
  mode: RegistrationMode,
  values: RegistrationValues,
  code: string,
  preview: InvitationPreview | null,
) {
  const body = {
    contactName: values.contactName,
    phone: values.phone,
    username: values.username,
    password: values.password,
  };
  if (mode === 'apply') return { ...body, company: values.company };
  if (!code.trim() || !preview?.valid) throw new Error('请先核验有效的邀请码');
  return { ...body, inviteCode: code.trim(), ...(preview.type === 'new_tenant' ? { company: values.company } : {}) };
}

export default function Register() {
  const nav = useNavigate();
  const [initialCode] = useState(() => invitationCodeFromHash(window.location.hash));
  const [mode, setMode] = useState<RegistrationMode>(() =>
    !initialCode && new URLSearchParams(window.location.search).get('mode') === 'apply' ? 'apply' : 'invite',
  );
  const [inviteCode, setInviteCode] = useState(initialCode);
  const [preview, setPreview] = useState<{ code: string; data: InvitationPreview } | null>(null);
  const [checking, setChecking] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const previewRequest = useRef(0);
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [done, setDone] = useState<{ canLogin: boolean; message: string } | null>(null);
  const [form] = Form.useForm();

  const previewInvitation = useCallback(async (rawCode: string) => {
    const code = rawCode.trim();
    const request = ++previewRequest.current;
    setPreview(null);
    setPreviewError('');
    if (!code) {
      setPreviewError('请输入邀请码');
      return;
    }
    setChecking(true);
    try {
      const data = await api.post('/auth/invitations/preview', { code }, { silent: true });
      if (request !== previewRequest.current) return;
      if (
        data?.valid !== true ||
        !['new_tenant', 'existing_tenant'].includes(data.type) ||
        !data.roleLabel ||
        (data.type === 'existing_tenant' && !data.tenantName)
      )
        throw new Error('邀请码信息未能确认，请重新核验');
      setPreview({ code, data });
    } catch (error) {
      if (request === previewRequest.current)
        setPreviewError(error instanceof Error ? error.message : '邀请码核验失败，请重试');
    } finally {
      if (request === previewRequest.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    const acceptHash = () => {
      const code = invitationCodeFromHash(window.location.hash);
      if (!code) return;
      setMode('invite');
      setInviteCode(code);
      setSubmitError('');
      void previewInvitation(code);
    };
    const frame = requestAnimationFrame(() => {
      if (initialCode) void previewInvitation(initialCode);
    });
    window.addEventListener('hashchange', acceptHash);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('hashchange', acceptHash);
      previewRequest.current += 1;
    };
  }, [initialCode, previewInvitation]);

  const changeCode = (value: string) => {
    previewRequest.current += 1;
    setInviteCode(value);
    setPreview(null);
    setChecking(false);
    setPreviewError('');
    setSubmitError('');
  };
  const changeMode = (value: RegistrationMode) => {
    previewRequest.current += 1;
    setMode(value);
    setPreview(null);
    setChecking(false);
    setPreviewError('');
    setSubmitError('');
  };
  const validPreview = preview?.code === inviteCode.trim() ? preview.data : null;
  const showForm = mode === 'apply' || Boolean(validPreview);

  const submit = async (values: RegistrationValues) => {
    if (mode === 'invite' && (!validPreview || checking)) {
      setSubmitError('请先核验当前邀请码，确认企业和角色后再注册');
      return;
    }
    setLoading(true);
    setSubmitError('');
    try {
      const result = await api.post('/auth/register', registrationPayload(mode, values, inviteCode, validPreview), {
        silent: true,
      });
      if (!result?.ok || (mode === 'invite' && result.canLogin !== true))
        throw new Error('注册结果尚未确认，请联系邀请人核对后再操作');
      setDone({
        canLogin: result.canLogin === true,
        message:
          result.message || (mode === 'invite' ? '账号已开通，可以登录使用。' : '申请已提交，平台审核开通后即可登录。'),
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '注册失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell ariaLabel="企业注册">
      {done ? (
        <Result
          status="success"
          title={done.canLogin ? '注册完成' : '开通申请已提交'}
          subTitle={done.message}
          extra={
            <Button type="primary" className="au-submit" onClick={() => nav('/login')}>
              {done.canLogin ? '去登录' : '返回登录'}
            </Button>
          }
        />
      ) : (
        <>
          <div style={{ marginBottom: 'var(--space-5)' }}>
            <AuthBrand compact />
          </div>
          <h2>{mode === 'invite' ? '使用邀请码注册' : '申请企业开通'}</h2>
          <p className="au-card-sub">
            {mode === 'invite' ? '核验邀请码后，确认企业和角色即可注册。' : '提交企业信息，由平台审核开通。'}
          </p>
          <Segmented
            className="register-modes"
            block
            value={mode}
            disabled={loading}
            onChange={value => changeMode(value as RegistrationMode)}
            options={[
              { label: '邀请码注册', value: 'invite' },
              { label: '申请企业开通', value: 'apply' },
            ]}
          />
          {mode === 'invite' && (
            <div className="register-invitation">
              <Form.Item label="邀请码" htmlFor="register-invite-code" layout="vertical">
                <div className="register-code-row">
                  <Input
                    id="register-invite-code"
                    value={inviteCode}
                    onChange={event => changeCode(event.target.value)}
                    disabled={loading}
                    placeholder="粘贴邀请人发来的邀请码"
                    maxLength={160}
                    autoComplete="off"
                    onPressEnter={() => void previewInvitation(inviteCode)}
                  />
                  <Button
                    loading={checking}
                    disabled={loading || !inviteCode.trim()}
                    onClick={() => void previewInvitation(inviteCode)}
                  >
                    核验邀请码
                  </Button>
                </div>
              </Form.Item>
              {previewError && <Alert type="error" showIcon message={previewError} />}
              {validPreview && (
                <Alert
                  type="success"
                  showIcon
                  message={
                    validPreview.type === 'new_tenant'
                      ? '新企业开通邀请'
                      : `加入 ${validPreview.tenantName || '受邀企业'}`
                  }
                  description={`注册角色：${validPreview.roleLabel}。企业和角色由邀请码确定。`}
                />
              )}
            </div>
          )}
          {showForm && (
            <Form form={form} onFinish={submit} layout="vertical" requiredMark={false} size="large" disabled={loading}>
              {(mode === 'apply' || validPreview?.type === 'new_tenant') && (
                <Form.Item
                  name="company"
                  label="企业 / 餐饮门店名称"
                  rules={[{ required: true, message: '请输入企业名称' }]}
                >
                  <Input prefix={<ShopOutlined />} placeholder="如：山禾餐厅（中心店）" maxLength={120} />
                </Form.Item>
              )}
              <Form.Item name="contactName" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}>
                <Input prefix={<ContactsOutlined />} placeholder="真实姓名" maxLength={40} autoComplete="name" />
              </Form.Item>
              <Form.Item
                name="phone"
                label="联系电话"
                rules={[
                  { required: true, message: '请输入手机号' },
                  { pattern: /^1\d{10}$/, message: '手机号格式不正确' },
                ]}
              >
                <Input prefix={<PhoneOutlined />} placeholder="11位手机号" maxLength={11} autoComplete="tel" />
              </Form.Item>
              <Form.Item
                name="username"
                label="登录账号"
                rules={[
                  { required: true, message: '请输入登录账号' },
                  { pattern: /^[A-Za-z0-9][A-Za-z0-9_.-]{3,39}$/, message: '请用4到40位字母、数字、点、横线或下划线' },
                ]}
              >
                <Input
                  prefix={<UserOutlined />}
                  placeholder="4到40位字母或数字等"
                  maxLength={40}
                  autoComplete="username"
                />
              </Form.Item>
              <Form.Item
                name="password"
                label="登录密码"
                rules={[
                  { required: true, message: '请输入密码' },
                  { min: 8, max: 128, message: '密码须为8到128位' },
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined />}
                  placeholder="至少8位"
                  maxLength={128}
                  autoComplete="new-password"
                />
              </Form.Item>
              <Form.Item
                name="confirm"
                label="确认密码"
                dependencies={['password']}
                rules={[
                  { required: true, message: '请再次输入密码' },
                  ({ getFieldValue }) => ({
                    validator: (_, value) =>
                      !value || getFieldValue('password') === value
                        ? Promise.resolve()
                        : Promise.reject(new Error('两次输入的密码不一致')),
                  }),
                ]}
              >
                <Input.Password
                  prefix={<LockOutlined />}
                  placeholder="再次输入密码"
                  maxLength={128}
                  autoComplete="new-password"
                />
              </Form.Item>
              {submitError && (
                <Alert
                  className="register-error"
                  type="error"
                  showIcon
                  message="未完成注册"
                  description={submitError}
                />
              )}
              <Button
                type="primary"
                htmlType="submit"
                block
                loading={loading}
                className="au-submit"
                disabled={mode === 'invite' && (!validPreview || checking)}
              >
                {mode === 'invite' ? '确认注册' : '提交开通申请'}
              </Button>
            </Form>
          )}
          <div className="au-foot-row">
            <span>已有账号？</span>
            <button type="button" className="au-link" onClick={() => nav('/login')}>
              返回登录
            </button>
          </div>
          <TrustMarks />
        </>
      )}
    </AuthShell>
  );
}
