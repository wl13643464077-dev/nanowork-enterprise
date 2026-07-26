import { useState } from 'react';
import { Button, Card, Form, Input, message, Result } from 'antd';
import { ShopOutlined, UserOutlined, LockOutlined, PhoneOutlined, ContactsOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';

export default function Register() {
  const nav = useNavigate();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [form] = Form.useForm();

  const submit = async (v: any) => {
    if (v.password !== v.confirm) { message.error('两次密码不一致'); return; }
    setLoading(true);
    try {
      await api.post('/auth/register', { company: v.company, contactName: v.contactName, phone: v.phone, username: v.username, password: v.password });
      setDone(true);
    } catch (e: any) {
      message.error(e?.message || '注册失败');
    } finally { setLoading(false); }
  };

  return (
    <main style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'radial-gradient(circle at 15% 15%, rgba(44,118,220,.28), transparent 32%), radial-gradient(circle at 85% 82%, rgba(38,116,210,.18), transparent 30%), linear-gradient(135deg,#041326 0%,#071d36 48%,#031020 100%)', padding: '28px 16px' }}>
      <Card style={{ width: 'min(100%, 460px)', borderRadius: 20, borderColor: 'rgba(137,184,238,.32)', boxShadow: '0 28px 80px rgba(0,8,19,.4)' }} styles={{ body: { padding: '32px clamp(20px,6vw,34px)' } }}>
        {done ? (
          <Result status="success" title="注册成功！"
            subTitle="平台审核开通后即可登录使用。我们会尽快处理（通常当天），开通后将站内通知您。"
            extra={<Button type="primary" onClick={() => nav('/login')}>返回登录</Button>} />
        ) : (
          <>
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <img src="/brand/nanowork-icon.svg" alt="纳米Work" width={58} height={58}
                style={{ display: 'block', margin: '0 auto 12px', filter: 'drop-shadow(0 12px 24px rgba(17,78,151,.2))' }} />
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ui-text)' }}>企业注册 · 开通纳米Work行业版</div>
              <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginTop: 4 }}>注册后由平台审核开通，分配功能权限与套餐</div>
            </div>
            <Form form={form} onFinish={submit} layout="vertical" requiredMark={false}>
              <Form.Item name="company" label="企业 / 餐饮门店名称" rules={[{ required: true, message: '请输入企业名称' }]}>
                <Input size="large" prefix={<ShopOutlined />} placeholder="如：山禾餐厅（中心店）" maxLength={40} />
              </Form.Item>
              <Form.Item name="contactName" label="联系人" rules={[{ required: true, message: '请输入联系人' }]}>
                <Input size="large" prefix={<ContactsOutlined />} placeholder="负责人姓名" maxLength={20} />
              </Form.Item>
              <Form.Item name="phone" label="联系电话" rules={[{ required: true, message: '请输入手机号' }, { pattern: /^1\d{10}$/, message: '手机号格式不正确' }]}>
                <Input size="large" prefix={<PhoneOutlined />} placeholder="11位手机号" maxLength={11} />
              </Form.Item>
              <Form.Item name="username" label="登录账号" rules={[{ required: true, message: '请输入登录账号' }, { min: 4, message: '至少4位' }]}>
                <Input size="large" prefix={<UserOutlined />} placeholder="企业管理员登录账号（字母/数字）" maxLength={20} />
              </Form.Item>
              <Form.Item name="password" label="登录密码" rules={[{ required: true, message: '请输入密码' }, { min: 8, message: '至少8位' }]}>
                <Input.Password size="large" prefix={<LockOutlined />} placeholder="至少8位" />
              </Form.Item>
              <Form.Item name="confirm" label="确认密码" dependencies={['password']} rules={[
                { required: true, message: '请再次输入密码' },
                ({ getFieldValue }) => ({ validator: (_: any, value: string) => !value || getFieldValue('password') === value ? Promise.resolve() : Promise.reject(new Error('两次输入的密码不一致')) }),
              ]}>
                <Input.Password size="large" prefix={<LockOutlined />} placeholder="再次输入密码" />
              </Form.Item>
              <Button type="primary" size="large" htmlType="submit" block loading={loading}
                style={{ background: 'linear-gradient(135deg,#2c76dc,#0751a3)', border: 'none', height: 46, boxShadow: '0 10px 24px rgba(23,105,210,.2)' }}>
                提交注册申请
              </Button>
            </Form>
            <div style={{ textAlign: 'center', marginTop: 16, fontSize: 13 }}>
              已有账号？<a onClick={() => nav('/login')}>返回登录</a>
            </div>
          </>
        )}
      </Card>
    </main>
  );
}
