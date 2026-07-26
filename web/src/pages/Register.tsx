import { useState } from 'react';
import { Button, Form, Input, message, Result } from 'antd';
import { ShopOutlined, UserOutlined, LockOutlined, PhoneOutlined, ContactsOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import AuthShell, { AuthBrand, TrustMarks } from '../components/AuthShell';

export default function Register() {
  const nav = useNavigate();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [form] = Form.useForm();

  const submit = async (v: any) => {
    setLoading(true);
    try {
      await api.post('/auth/register', { company: v.company, contactName: v.contactName, phone: v.phone, username: v.username, password: v.password });
      setDone(true);
    } catch (e: any) {
      message.error(e?.message || '注册失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell ariaLabel="企业注册">
      {done ? (
        <Result
          status="success"
          title="注册成功！"
          subTitle="平台审核开通后即可登录使用。我们会尽快处理（通常当天），开通后将站内通知您。"
          extra={<Button type="primary" className="au-submit" onClick={() => nav('/login')}>返回登录</Button>}
        />
      ) : (
        <>
          <div style={{ marginBottom: 'var(--space-5)' }}>
            <AuthBrand compact />
          </div>
          <div className="au-kicker">企业注册</div>
          <h2>开通纳米Work行业版</h2>
          <p className="au-card-sub">注册后由平台审核开通，分配功能权限与套餐</p>
          <Form form={form} onFinish={submit} layout="vertical" requiredMark={false} size="large">
            <Form.Item name="company" label="企业 / 餐饮门店名称" rules={[{ required: true, message: '请输入企业名称' }]}>
              <Input prefix={<ShopOutlined />} placeholder="如：山禾餐厅（中心店）" maxLength={40} />
            </Form.Item>
            <Form.Item name="contactName" label="联系人" rules={[{ required: true, message: '请输入联系人' }]}>
              <Input prefix={<ContactsOutlined />} placeholder="负责人姓名" maxLength={20} />
            </Form.Item>
            <Form.Item name="phone" label="联系电话" rules={[{ required: true, message: '请输入手机号' }, { pattern: /^1\d{10}$/, message: '手机号格式不正确' }]}>
              <Input prefix={<PhoneOutlined />} placeholder="11位手机号" maxLength={11} />
            </Form.Item>
            <Form.Item name="username" label="登录账号" rules={[{ required: true, message: '请输入登录账号' }, { min: 4, message: '至少4位' }]}>
              <Input prefix={<UserOutlined />} placeholder="企业管理员登录账号（字母/数字）" maxLength={20} />
            </Form.Item>
            <Form.Item name="password" label="登录密码" rules={[{ required: true, message: '请输入密码' }, { min: 8, message: '至少8位' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="至少8位" />
            </Form.Item>
            <Form.Item
              name="confirm"
              label="确认密码"
              dependencies={['password']}
              rules={[
                { required: true, message: '请再次输入密码' },
                ({ getFieldValue }) => ({
                  validator: (_: any, value: string) =>
                    !value || getFieldValue('password') === value ? Promise.resolve() : Promise.reject(new Error('两次输入的密码不一致')),
                }),
              ]}
            >
              <Input.Password prefix={<LockOutlined />} placeholder="再次输入密码" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading} className="au-submit">
              提交注册申请
            </Button>
          </Form>
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
