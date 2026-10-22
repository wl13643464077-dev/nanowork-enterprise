import { useState } from 'react';
import { Alert, Button, Checkbox, Form, Input, Result } from 'antd';
import { Link } from 'react-router-dom';
import { trialError, trialRequest } from './TrialShared';
import './Trial.css';

export default function TesterApply() {
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const submit = async (values: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      await trialRequest('/tester/apply', { method: 'POST', body: values });
      setSubmitted(true);
    } catch (error) {
      setError(trialError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="trial-shell">
      <header className="trial-header">
        <Link to="/login" className="trial-brand">
          纳米 Work
        </Link>
        <Link to="/login?login=1">已有账号，去登录</Link>
      </header>
      <section className="trial-apply-card">
        {submitted ? (
          <Result
            status="success"
            title="申请已提交"
            subTitle="平台管理员审核通过后，使用刚才设置的账号与密码登录，进入测试员工作台。"
            extra={
              <Link to="/login?login=1">
                <Button type="primary">前往登录</Button>
              </Link>
            }
          />
        ) : (
          <>
            <span className="trial-eyebrow">测试员 / 销售伙伴</span>
            <h1>用自己的 Key，体验数字员工</h1>
            <p className="trial-muted">
              审核通过后可选择 OpenLux 或 360 智脑，接入对应的个人 API
              Key，自己体验、生成客户邀请二维码，并查看客户使用情况。此账号仅限本人使用，没有子账号权限。
            </p>
            {error && <Alert type="error" showIcon message={error} className="trial-notice" />}
            <Form layout="vertical" onFinish={submit} requiredMark={false}>
              <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请填写姓名' }, { max: 40 }]}>
                <Input autoComplete="name" maxLength={40} />
              </Form.Item>
              <Form.Item
                name="department"
                label="所属部门／团队"
                extra="填写公司内部统一名称，管理员审核时可校正分类。"
                rules={[{ required: true, whitespace: true, message: '请填写所属部门或团队' }, { max: 40 }]}
              >
                <Input autoComplete="organization" placeholder="例如：成都销售一部、渠道合作团队" maxLength={40} />
              </Form.Item>
              <Form.Item
                name="phone"
                label="本人手机号"
                rules={[
                  { required: true, message: '请填写手机号' },
                  { pattern: /^1\d{10}$/, message: '请输入 11 位手机号' },
                ]}
              >
                <Input inputMode="tel" autoComplete="tel" maxLength={11} />
              </Form.Item>
              <Form.Item
                name="username"
                label="登录账号"
                rules={[
                  { required: true, message: '请设置登录账号' },
                  { pattern: /^[a-zA-Z0-9_]{4,32}$/, message: '请使用 4–32 位字母、数字或下划线' },
                ]}
              >
                <Input autoComplete="username" placeholder="例如 zhangsan01" maxLength={32} />
              </Form.Item>
              <Form.Item
                name="password"
                label="登录密码"
                rules={[
                  { required: true, message: '请设置密码' },
                  { min: 8, message: '密码至少 8 位' },
                ]}
              >
                <Input.Password autoComplete="new-password" maxLength={128} />
              </Form.Item>
              <Form.Item
                name="consent"
                valuePropName="checked"
                rules={[
                  {
                    validator: (_, value) =>
                      value ? Promise.resolve() : Promise.reject(new Error('请阅读并勾选说明')),
                  },
                ]}
              >
                <Checkbox>
                  我同意平台为账号审核、体验邀请及联系客户保存申请与使用记录；我提供的供应商个人 Key
                  所产生的费用由我承担。
                </Checkbox>
              </Form.Item>
              <Button type="primary" htmlType="submit" block size="large" loading={busy}>
                提交申请
              </Button>
            </Form>
          </>
        )}
      </section>
    </main>
  );
}
