import { useState } from 'react';
import { Alert, Button, Form, Input, Modal, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api, clearAuth } from '../api/client';

// 任何已登录企业账号（老板 / 副账号 / 平台管理员）修改本人密码。
// 服务端校验当前密码并吊销全部会话，所以成功后必须清空本地登录态并回到登录页。
export default function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (busy) return;
    form.resetFields();
    setError(null);
    onClose();
  };

  const submit = async (values: { currentPassword: string; password: string }) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(
        '/auth/password',
        { currentPassword: values.currentPassword, password: values.password },
        { silent: true },
      );
      form.resetFields();
      clearAuth();
      message.success('密码已修改，请使用新密码重新登录');
      onClose();
      nav('/login?login=1');
    } catch (e: any) {
      setError(e?.message || '修改失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="修改登录密码" onCancel={close} footer={null} destroyOnClose maskClosable={!busy}>
      <p className="muted" style={{ marginTop: 0 }}>
        修改成功后，本账号在所有设备上的登录都会失效，需要用新密码重新登录。忘记当前密码请联系企业主账号或平台管理员重置。
      </p>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
        <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
          <Input.Password autoComplete="current-password" maxLength={128} />
        </Form.Item>
        <Form.Item
          name="password"
          label="新密码"
          rules={[
            { required: true, message: '请输入新密码' },
            { min: 8, message: '密码至少 8 位' },
            { max: 128, message: '密码最多 128 位' },
            ({ getFieldValue }) => ({
              validator: (_, value) =>
                !value || getFieldValue('currentPassword') !== value
                  ? Promise.resolve()
                  : Promise.reject(new Error('新密码不能与当前密码相同')),
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" maxLength={128} />
        </Form.Item>
        <Form.Item
          name="confirmPassword"
          label="再次输入新密码"
          dependencies={['password']}
          rules={[
            { required: true, message: '请再次输入新密码' },
            ({ getFieldValue }) => ({
              validator: (_, value) =>
                !value || getFieldValue('password') === value
                  ? Promise.resolve()
                  : Promise.reject(new Error('两次密码不一致')),
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" maxLength={128} />
        </Form.Item>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={close} disabled={busy}>
            取消
          </Button>
          <Button type="primary" htmlType="submit" loading={busy}>
            保存新密码
          </Button>
        </div>
      </Form>
    </Modal>
  );
}
