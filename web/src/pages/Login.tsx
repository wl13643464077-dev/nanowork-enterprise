import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Button, Checkbox, Form, Input, message } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api, setAuth } from '../api/client';

const REMEMBER_KEY = 'nanowork_industry_remember_user';
const INDUSTRIES = ['餐饮门店', '茶饮咖啡', '零售便利', '美业门店', '健身运动', '宠物服务'];
const LIVE_SIGNALS = [
  { label: '今日营业额', value: '¥ 18,642', delta: '+8.7%' },
  { label: '午市翻台率', value: '2.34', delta: '+0.18' },
  { label: '待处理事项', value: '6', delta: '2项紧急' },
];

type NodePoint = { x: number; y: number; vx: number; vy: number; radius: number; alpha: number };

export default function Login() {
  const nav = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(false);
  const [industryIndex, setIndustryIndex] = useState(0);
  const [form] = Form.useForm();
  const industry = useMemo(() => INDUSTRIES[industryIndex], [industryIndex]);

  useEffect(() => {
    const saved = localStorage.getItem(REMEMBER_KEY);
    if (saved) form.setFieldsValue({ username: saved, remember: true });
  }, [form]);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    const timer = window.setInterval(() => setIndustryIndex(index => (index + 1) % INDUSTRIES.length), 2600);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;
    let raf = 0;
    let points: NodePoint[] = [];

    const resize = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.max(20, Math.min(54, Math.round((width * height) / 21000)));
      points = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        radius: 1 + Math.random() * 1.8,
        alpha: 0.28 + Math.random() * 0.5,
      }));
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);
      for (let i = 0; i < points.length; i += 1) {
        const point = points[i];
        if (!reduced) {
          point.x += point.vx;
          point.y += point.vy;
          if (point.x < -12) point.x = width + 12;
          if (point.x > width + 12) point.x = -12;
          if (point.y < -12) point.y = height + 12;
          if (point.y > height + 12) point.y = -12;
        }
        context.beginPath();
        context.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
        context.fillStyle = `rgba(89, 159, 255, ${point.alpha})`;
        context.fill();
        for (let j = i + 1; j < points.length; j += 1) {
          const next = points[j];
          const dx = point.x - next.x;
          const dy = point.y - next.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance > 132) continue;
          context.beginPath();
          context.moveTo(point.x, point.y);
          context.lineTo(next.x, next.y);
          context.strokeStyle = `rgba(65, 134, 224, ${(1 - distance / 132) * 0.18})`;
          context.lineWidth = 0.7;
          context.stroke();
        }
      }
      if (!reduced) raf = window.requestAnimationFrame(draw);
    };

    resize();
    draw();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.cancelAnimationFrame(raf);
    };
  }, []);

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

  return (
    <main className="nw-login-shell">
      <style>{STYLES}</style>
      <a className="nw-skip" href="#login-form">跳到登录表单</a>
      <canvas ref={canvasRef} className="nw-network" aria-hidden="true" />
      <div className="nw-grid" aria-hidden="true" />
      <div className="nw-orbit nw-orbit-a" aria-hidden="true" />
      <div className="nw-orbit nw-orbit-b" aria-hidden="true" />

      <section className="nw-story" aria-label="纳米Work行业版介绍">
        <div className="nw-brand-lockup">
          <img src="/brand/nanowork-icon.svg" alt="纳米Work" />
          <div>
            <div className="nw-brand-name">纳米Work<span>行业版</span></div>
            <div className="nw-brand-en">NANOWORK · INDUSTRY OPERATING SYSTEM</div>
          </div>
        </div>

        <div className="nw-copy">
          <div className="nw-eyebrow"><span /> 为实体门店而生的经营工作台</div>
          <h1>进入千行百业，<br />赋能每一个认真创业的老板</h1>
          <p>经营数据、行业数字员工和每日工具，在一个工作台里形成闭环。看清问题，然后把活派下去。</p>
          <div className="nw-industry-line" aria-live="polite">
            <span>正在服务</span>
            <strong key={industry}>{industry}</strong>
            <i>老板</i>
          </div>
        </div>

        <div className="nw-live-card">
          <div className="nw-live-head">
            <span><i />门店经营信号</span>
            <time>动态经营视图</time>
          </div>
          <div className="nw-live-grid">
            {LIVE_SIGNALS.map((signal, index) => (
              <div className="nw-signal" key={signal.label} style={{ '--delay': `${index * 110}ms` } as CSSProperties}>
                <span>{signal.label}</span>
                <strong>{signal.value}</strong>
                <em>{signal.delta}</em>
              </div>
            ))}
          </div>
          <div className="nw-route">
            <span>数据异常</span><b />
            <span>员工诊断</span><b />
            <span>动作落地</span><b />
            <span>结果回流</span>
          </div>
        </div>
      </section>

      <section className="nw-auth-wrap" aria-label="企业登录">
        <div className="nw-auth-glow" aria-hidden="true" />
        <div className="nw-auth-card" id="login-form">
          <div className="nw-auth-kicker">企业经营入口</div>
          <h2>回到你的门店工作台</h2>
          <p className="nw-auth-sub">登录后查看经营数据、数字员工进度与今日待办</p>
          <Form form={form} onFinish={submit} requiredMark={false} size="large" layout="vertical">
            <Form.Item label="账号" name="username" rules={[{ required: true, message: '请输入账号' }]}>
              <Input prefix={<UserOutlined />} placeholder="账号 / 手机号" autoComplete="username" aria-label="账号" />
            </Form.Item>
            <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="请输入密码" autoComplete="current-password" aria-label="密码" />
            </Form.Item>
            <div className="nw-form-row">
              <Form.Item name="remember" valuePropName="checked" noStyle><Checkbox>记住账号</Checkbox></Form.Item>
              <button type="button" onClick={() => message.info('请联系企业管理员重置密码')}>忘记密码</button>
            </div>
            <Button type="primary" htmlType="submit" block loading={loading} className="nw-submit">进入经营工作台</Button>
          </Form>
          <div className="nw-auth-foot">
            <span>还没有企业账号？</span>
            <button type="button" onClick={() => nav('/register')}>申请开通</button>
          </div>
          <div className="nw-trust"><span>数据按企业隔离</span><span>关键动作可追溯</span><span>AI外发需确认</span></div>
        </div>
      </section>

      <footer className="nw-login-foot">纳米Work行业版 · 让每一家实体店都有一支懂行业、能落地的数字员工队伍</footer>
    </main>
  );
}

const STYLES = `
.nw-login-shell{--blue:#2c76dc;--blue-2:#5aa0ff;--navy:#061a31;--navy-2:#0b2e56;position:fixed;inset:0;overflow:auto;display:grid;grid-template-columns:minmax(0,1.25fr) minmax(390px,.75fr);color:#eef6ff;background:radial-gradient(circle at 14% 16%,rgba(44,118,220,.24),transparent 34%),radial-gradient(circle at 80% 78%,rgba(28,94,168,.18),transparent 30%),linear-gradient(135deg,#041326 0%,#071d36 46%,#031020 100%);font-family:'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif}
.nw-skip{position:fixed;left:16px;top:-60px;z-index:20;padding:10px 14px;border-radius:8px;background:#fff;color:#0b3566;transition:top .2s}.nw-skip:focus{top:16px}
.nw-network,.nw-grid{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}.nw-network{opacity:.86}.nw-grid{opacity:.16;background-image:linear-gradient(rgba(119,174,239,.12) 1px,transparent 1px),linear-gradient(90deg,rgba(119,174,239,.12) 1px,transparent 1px);background-size:56px 56px;mask-image:linear-gradient(90deg,#000,transparent 78%)}
.nw-orbit{position:fixed;border:1px solid rgba(92,157,236,.16);border-radius:50%;pointer-events:none}.nw-orbit:before{content:'';position:absolute;width:9px;height:9px;border-radius:50%;background:#65a9ff;box-shadow:0 0 20px #65a9ff}.nw-orbit-a{width:540px;height:540px;left:-190px;bottom:-260px;animation:nw-spin 24s linear infinite}.nw-orbit-a:before{left:71%;top:6%}.nw-orbit-b{width:360px;height:360px;right:18%;top:-250px;animation:nw-spin 18s linear infinite reverse}.nw-orbit-b:before{left:8%;top:68%}
.nw-story{position:relative;z-index:2;min-height:100dvh;padding:48px clamp(42px,7vw,108px) 86px;display:flex;flex-direction:column;justify-content:space-between}
.nw-brand-lockup{display:flex;align-items:center;gap:13px}.nw-brand-lockup img{width:58px;height:58px;filter:drop-shadow(0 12px 24px rgba(0,0,0,.22))}.nw-brand-name{font-size:23px;font-weight:760;letter-spacing:-.5px}.nw-brand-name span{margin-left:6px;font-size:14px;font-weight:600;color:#a9cef8;padding-left:8px;border-left:1px solid rgba(169,206,248,.38)}.nw-brand-en{margin-top:4px;font:500 9px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:1.7px;color:#7799bd}
.nw-copy{max-width:760px;margin:8vh 0 6vh}.nw-eyebrow{display:flex;align-items:center;gap:10px;color:#91b9e7;font-size:13px;letter-spacing:1.8px}.nw-eyebrow span{width:34px;height:1px;background:#5798e8;box-shadow:0 0 10px rgba(87,152,232,.8)}.nw-copy h1{max-width:720px;margin:21px 0 22px;font-size:clamp(42px,5.2vw,76px);line-height:1.08;letter-spacing:-3.2px;text-wrap:balance;color:#f4f8ff;text-shadow:0 18px 48px rgba(0,0,0,.24)}.nw-copy p{max-width:620px;margin:0;color:#a9bfd8;font-size:16px;line-height:1.9;text-wrap:pretty}.nw-industry-line{height:38px;margin-top:30px;display:flex;align-items:center;gap:9px;color:#7799bd;font-size:13px}.nw-industry-line strong{display:inline-block;min-width:92px;color:#7ab7ff;font-size:19px;animation:nw-word .55s cubic-bezier(.2,.8,.2,1)}.nw-industry-line i{font-style:normal;color:#a9bfd8}
.nw-live-card{max-width:720px;padding:18px 20px 15px;border:1px solid rgba(113,169,235,.2);border-radius:18px;background:linear-gradient(130deg,rgba(13,47,83,.78),rgba(7,28,52,.68));box-shadow:0 24px 70px rgba(0,0,0,.22),inset 0 1px rgba(255,255,255,.05);backdrop-filter:blur(16px)}.nw-live-head{display:flex;align-items:center;justify-content:space-between;color:#9bb8d8;font-size:12px}.nw-live-head span{display:flex;align-items:center;gap:8px}.nw-live-head i{width:7px;height:7px;border-radius:50%;background:#4ed39b;box-shadow:0 0 12px #4ed39b;animation:nw-pulse 1.7s ease-in-out infinite}.nw-live-head time{font:500 10px ui-monospace,SFMono-Regular,Menlo,monospace;color:#6487ae}.nw-live-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:14px}.nw-signal{position:relative;padding:11px 13px;border-left:1px solid rgba(105,164,231,.23);animation:nw-rise .65s both;animation-delay:var(--delay)}.nw-signal:first-child{border-left:none}.nw-signal span{display:block;color:#7698bd;font-size:11px}.nw-signal strong{display:block;margin-top:4px;color:#f4f8ff;font:650 21px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}.nw-signal em{position:absolute;right:10px;bottom:13px;color:#65d3a3;font-size:10px;font-style:normal}.nw-route{display:flex;align-items:center;gap:8px;margin-top:13px;padding-top:13px;border-top:1px solid rgba(112,165,225,.14);color:#83a4c8;font-size:10.5px}.nw-route b{flex:1;height:1px;background:linear-gradient(90deg,rgba(65,142,230,.72),rgba(65,142,230,.08));position:relative}.nw-route b:after{content:'';position:absolute;right:0;top:-2px;border-left:4px solid #4b8bd5;border-top:2px solid transparent;border-bottom:2px solid transparent}
.nw-auth-wrap{position:relative;z-index:4;min-height:100dvh;padding:28px clamp(28px,4vw,72px);display:grid;place-items:center;background:linear-gradient(180deg,rgba(3,15,30,.28),rgba(3,15,30,.6));border-left:1px solid rgba(114,166,224,.12)}.nw-auth-glow{position:absolute;width:520px;height:520px;border-radius:50%;background:radial-gradient(circle,rgba(51,128,224,.19),transparent 65%);filter:blur(4px);pointer-events:none}.nw-auth-card{position:relative;width:min(100%,420px);padding:36px 36px 29px;border:1px solid rgba(137,184,238,.24);border-radius:22px;background:rgba(248,252,255,.96);box-shadow:0 34px 90px rgba(0,8,19,.45),inset 0 1px #fff;color:#152942;backdrop-filter:blur(20px)}.nw-auth-kicker{display:inline-flex;padding:4px 9px;border-radius:5px;background:#e7f1fd;color:#2169c3;font-size:11px;font-weight:650;letter-spacing:1.2px}.nw-auth-card h2{margin:18px 0 7px;font-size:27px;line-height:1.2;letter-spacing:-.8px;color:#13263e}.nw-auth-sub{margin:0 0 25px;color:#6a7e96;font-size:13px;line-height:1.7}.nw-auth-card .ant-form-item{margin-bottom:18px}.nw-auth-card .ant-form-item-label{padding-bottom:6px}.nw-auth-card .ant-form-item-label>label{color:#40566f;font-size:12px;font-weight:600}.nw-auth-card .ant-input-affix-wrapper{height:48px;padding-inline:13px;border-radius:10px;border-color:#d9e4f0;background:#f9fbfd;box-shadow:none;transition:border-color .2s,box-shadow .2s,background .2s}.nw-auth-card .ant-input-affix-wrapper:hover{border-color:#7eabe2;background:#fff}.nw-auth-card .ant-input-affix-wrapper-focused{border-color:#2c76dc;background:#fff;box-shadow:0 0 0 3px rgba(44,118,220,.11)}.nw-auth-card .ant-input-prefix{margin-right:10px;color:#7b91aa}.nw-auth-card .ant-input{background:transparent;color:#182b43;font-size:14px}.nw-form-row{display:flex;align-items:center;justify-content:space-between;margin:2px 0 22px;color:#657a92;font-size:12px}.nw-form-row .ant-checkbox-wrapper{color:#657a92;font-size:12px}.nw-form-row button,.nw-auth-foot button{padding:0;border:none;background:transparent;color:#2169c3;cursor:pointer;font:inherit}.nw-submit{height:49px!important;border:none!important;border-radius:10px!important;background:linear-gradient(135deg,#2d7be3,#0751a3)!important;box-shadow:0 13px 28px rgba(27,103,197,.25)!important;font-size:15px!important;font-weight:650!important;letter-spacing:.8px;transition:transform .18s,filter .18s!important}.nw-submit:hover{filter:brightness(1.06)}.nw-submit:active{transform:translateY(1px) scale(.995)}.nw-auth-foot{display:flex;align-items:center;justify-content:center;gap:7px;margin-top:20px;color:#8294a9;font-size:12px}.nw-trust{display:flex;justify-content:center;gap:14px;margin-top:24px;padding-top:18px;border-top:1px solid #e8eef5;color:#8a9aab;font-size:9.5px}.nw-trust span:before{content:'✓';margin-right:4px;color:#337bcf}
.nw-login-foot{position:fixed;z-index:5;left:0;right:0;bottom:18px;text-align:center;color:rgba(138,172,210,.58);font-size:10.5px;letter-spacing:.4px;pointer-events:none}
@keyframes nw-spin{to{transform:rotate(360deg)}}@keyframes nw-word{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes nw-pulse{50%{opacity:.42;transform:scale(.78)}}@keyframes nw-rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
@media(max-width:1050px){.nw-login-shell{grid-template-columns:1fr}.nw-story{min-height:auto;padding:34px 42px 30px}.nw-copy{margin:7vh 0 4vh}.nw-copy h1{font-size:clamp(40px,8vw,68px)}.nw-live-card{display:none}.nw-auth-wrap{min-height:auto;padding:24px 30px 78px;border-left:none}.nw-login-foot{position:absolute}.nw-grid{mask-image:none}}
@media(max-width:620px){.nw-story{padding:24px 20px 22px}.nw-brand-lockup img{width:48px;height:48px}.nw-brand-name{font-size:20px}.nw-brand-en{letter-spacing:.9px}.nw-copy{margin:50px 0 16px}.nw-copy h1{margin:16px 0;font-size:38px;letter-spacing:-1.8px}.nw-copy p{font-size:14px;line-height:1.75}.nw-industry-line{margin-top:18px}.nw-auth-wrap{padding:16px 14px 74px}.nw-auth-card{padding:27px 22px 24px;border-radius:17px}.nw-trust{gap:8px;flex-wrap:wrap}.nw-orbit{display:none}}
@media(prefers-reduced-motion:reduce){.nw-orbit,.nw-live-head i,.nw-industry-line strong,.nw-signal{animation:none!important}.nw-submit,.nw-skip{transition:none!important}}
`;
