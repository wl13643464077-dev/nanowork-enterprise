import { useEffect, useState } from 'react';
import { Button, Checkbox, Form, Input, message } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api, setAuth } from '../api/client';
import AuthShell, { AuthBrand, TrustMarks, enterDelay } from '../components/AuthShell';

const REMEMBER_KEY = 'nanowork_industry_remember_user';

// 产品真实闭环（不展示任何编造的经营数字）
const LOOP_STEPS = [
  { title: '经营数据', desc: '看板与预警' },
  { title: '员工诊断', desc: '定位问题' },
  { title: '派活执行', desc: '产出可交付' },
  { title: '结果回流', desc: '沉淀知识库' },
];

const StepArrow = () => (
  <svg className="au-loop-arrow" width="18" height="10" viewBox="0 0 18 10" aria-hidden="true">
    <path d="M1 5h14m0 0-4-3.4M15 5l-4 3.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default function Login() {
  const nav = useNavigate();
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    const saved = localStorage.getItem(REMEMBER_KEY);
    if (saved) form.setFieldsValue({ username: saved, remember: true });
  }, [form]);

  const submit = async (values: { username: string; password: string; remember?: boolean }) => {
    setLoading(true);
    try {
      const data = await api.post('/auth/login', { username: values.username, password: values.password });
      if (values.remember) localStorage.setItem(REMEMBER_KEY, values.username);
      else localStorage.removeItem(REMEMBER_KEY);
      setAuth(data.token, data.user);
      if (data.user.role === 'platform_super') {
        message.success('欢迎，平台管理员');
        nav('/platform');
        return;
      }
      const status = data.user.tenant?.status;
      if (status && status !== '已开通') {
        message.warning(status === '待审核' ? '企业账号正在审核中，开通后即可使用' : '企业账号已停用，请联系平台服务人员', 4);
        nav('/pending');
        return;
      }
      message.success(`欢迎回来，${data.user.name}`);
      const isMobile = /Mobile|Android|iPhone|iPad|Windows Phone/i.test(navigator.userAgent);
      nav(isMobile ? '/m' : '/');
    } finally {
      setLoading(false);
    }
  };

  const aside = (
    <>
      <div className="au-enter" style={enterDelay(0)}>
        <AuthBrand />
      </div>
      <div className="au-copy">
        <div className="au-eyebrow au-enter" style={enterDelay(80)}>
          <i /> 面向餐饮门店的 AI 经营工作台
        </div>
        <h1 className="au-enter" style={enterDelay(140)}>
          把经营看清楚，
          <br />
          把活派下去
        </h1>
        <p className="au-enter" style={enterDelay(220)}>
          经营数据、餐饮数字员工和每日工具，在一个工作台里形成闭环。发现问题，交给对的岗位，跟到结果回流。
        </p>
        <div className="au-industry au-enter" style={enterDelay(300)}>
          当前深耕 <b>餐饮行业</b> · 更多行业陆续开放
        </div>
      </div>
      <div className="au-loop au-enter" style={enterDelay(380)}>
        <div className="au-loop-title">经营闭环 · 从发现问题到结果回流</div>
        <div className="au-loop-steps">
          {LOOP_STEPS.map((step, index) => (
            <div className="au-loop-step" key={step.title}>
              {index > 0 && <StepArrow />}
              <div>
                <strong>{step.title}</strong>
                <small>{step.desc}</small>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );

  return (
    <AuthShell layout="split" aside={aside} ariaLabel="企业登录">
      <div className="au-kicker">企业经营入口</div>
      <h2>回到你的门店工作台</h2>
      <p className="au-card-sub">登录后查看经营数据、数字员工进度与今日待办</p>
      <Form form={form} onFinish={submit} requiredMark={false} size="large" layout="vertical">
        <Form.Item label="账号" name="username" rules={[{ required: true, message: '请输入账号' }]}>
          <Input prefix={<UserOutlined />} placeholder="账号 / 手机号" autoComplete="username" aria-label="账号" />
        </Form.Item>
        <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password prefix={<LockOutlined />} placeholder="请输入密码" autoComplete="current-password" aria-label="密码" />
        </Form.Item>
        <div className="au-form-row">
          <Form.Item name="remember" valuePropName="checked" noStyle>
            <Checkbox>记住账号</Checkbox>
          </Form.Item>
          <button type="button" className="au-link" onClick={() => message.info('请联系企业管理员重置密码')}>
            忘记密码
          </button>
        </div>
        <Button type="primary" htmlType="submit" block loading={loading} className="au-submit">
          进入经营工作台
        </Button>
      </Form>
      <div className="au-foot-row">
        <span>还没有企业账号？</span>
        <button type="button" className="au-link" onClick={() => nav('/register')}>
          申请开通
        </button>
      </div>
      <TrustMarks />
    </AuthShell>
  );
}
