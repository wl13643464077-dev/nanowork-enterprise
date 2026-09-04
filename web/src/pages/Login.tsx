import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Form, Input, message } from 'antd';
import {
  BarChartOutlined,
  CheckSquareOutlined,
  CloseOutlined,
  CommentOutlined,
  EditOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  ShopOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, setAuth } from '../api/client';
import { SoundToggle, useLoginSound } from '../components/AuthEffects';
import '../components/AuthShell.css';
import './Login.css';

const REMEMBER_KEY = 'nanowork_industry_remember_user';

/**
 * Login v6 —— 宣传落地页 + 滑入式登录面板。
 * 老板第一眼看懂产品是干啥的（hero 配图 + 功能卡 + 员工墙 + 流程），看好再点「登录」。
 * 落地页只展示平台真实事实，不放编造的经营数字。
 */

// 平台真实事实
const STATS = [
  { value: '61', label: '餐饮数字员工 · 8 大分部' },
  { value: '10', label: '内容生产数字员工' },
  { value: '10', label: '门店日常管理功能' },
  { value: '¥0.4起', label: '单次派活成本（两阶段计费）' },
];

const FEATURES = [
  {
    key: 'employees',
    image: '/landing/feature-employees.jpg',
    icon: <TeamOutlined />,
    title: '61 位懂餐饮的数字员工',
    points: [
      '选址、菜单、食安、供应链、运营、增长、财务、连锁 8 大分部岗位专家',
      '每位员工带完整岗位手册、质量门与安全边界，产出可追溯可审计',
      '每张员工卡标明「单次成本 → 参考创造价值」，花多少钱赚多少心里有数',
    ],
  },
  {
    key: 'content',
    image: '/landing/feature-content.jpg',
    icon: <EditOutlined />,
    title: '内容生产仓 · 10 工位流水线',
    points: [
      '趋势选题、爆款拆解、撰稿、配图、封面、分发、复盘一条线',
      '10 个 Paihuo 内容工位 + 1 个 AI 带货扩展岗，与 61 位餐饮员工合计 72 位',
      '对标外包 300–1500 元/篇的内容，数字员工几毛钱一次',
      '普通内部产出通过质量与账务门禁后自动采用；外发、付费和不可逆动作仍需人工确认',
    ],
  },
  {
    key: 'storeops',
    image: '/landing/feature-storeops.jpg',
    icon: <CheckSquareOutlined />,
    title: '门店日常 · 开门七件事一屏管完',
    points: [
      '开店/闭店/交接班检查清单，勾一项留一条痕，漏检老板第一屏就能看到',
      '晨检、消毒、留样食安三件套台账，市监局检查随时拿得出来',
      '排班表＋员工打卡＋沽清板＋库存订货＋外卖日报，店长每天的活全在这',
      'AI 晨会助手：按昨天真实营收、差评和今日排班，生成店长照着念的晨会稿',
    ],
  },
  {
    key: 'reputation',
    image: '/landing/feature-reputation.jpg',
    icon: <CommentOutlined />,
    title: '口碑与会员 · 差评当天回',
    points: [
      '美团/饿了么/大众点评评价台账，差评置顶预警到老板首屏',
      'AI 按你门店的语气起草回复：针对具体问题给具体改进，不是模板道歉',
      '客户生日自动提醒＋AI 祝福话术，成本最低的复购动作',
      '客户跟进「今日必跟」：到期和超期客户按急迫度排好，点开就能跟',
    ],
  },
  {
    key: 'inspection',
    image: '/landing/feature-inspection.jpg',
    icon: <SafetyCertificateOutlined />,
    title: '巡店督导 · 拍照即出巡店记录',
    points: [
      '上传巡店照片和检查记录，自动生成评分 + 问题清单 + 整改时限',
      '食安、出品、服务、卫生、陈列五大板块逐项核查',
      '每个督导每月查了多少店、每个店多少分，老板后台一目了然',
    ],
  },
  {
    key: 'analytics',
    image: '/landing/feature-analytics.jpg',
    icon: <BarChartOutlined />,
    title: '老板驾驶舱 + 经营工具箱',
    points: [
      '打开 3 秒看完：4 个关键数、最要紧的一件事、堵着的待办',
      '一句话组建协同小队：AI 挑人、队长拆解分工、干完自动汇总＋行动计划',
      '今日必发、私域日历、竞品盯梢、线索雷达等 8 件每日即用工具',
      '每个 AI 结论都能穿透到输入、产出原文和证据链',
    ],
  },
];

// 老板的一天：让看页面的老板直接代入自己的营业日
const DAY_TIMELINE = [
  { time: '08:30', title: 'AI 晨会要点', desc: '系统读完昨天的营收、差评、沽清，晨会稿已经写好，店长照着念' },
  { time: '09:00', title: '员工打卡 · 开店日清', desc: '开店检查、晨检消毒逐项打勾，谁做的几点做的都有记录' },
  { time: '11:30', title: '沽清与库存', desc: '哪个菜卖完了点一下全店同步；库存低于安全线自动出订货清单' },
  { time: '14:00', title: '差评当天回', desc: '中午的差评 AI 已起草好回复，你确认一下，复制到平台发布' },
  { time: '16:00', title: '一句话派活', desc: '「帮我把外卖分做上4.8」——AI 组好协同小队，队长拆解，各岗开工' },
  { time: '21:30', title: '今日一眼收账', desc: '营收、新客、任务完成率一屏看完，员工填的数实时汇总到你这' },
];

// 员工墙（真实生成肖像 + 真实岗位）
const WALL = [
  { file: 'emp-01', name: '赵先机', role: '市场机会研究' },
  { file: 'emp-08', name: '王菜单', role: '菜单架构规划' },
  { file: 'emp-17', name: '朱哈普', role: 'HACCP 食安' },
  { file: 'emp-27', name: '严订货', role: '需求预测补货' },
  { file: 'emp-36', name: '喻排班', role: '需求驱动排班' },
  { file: 'emp-42', name: '苏种草', role: '社媒与UGC' },
  { file: 'emp-50', name: '昌本利', role: '单店损益' },
  { file: 'emp-61', name: '查巡巡', role: '巡店督导' },
  { file: 'emp-12', name: '卫菜工', role: '菜单工程分析' },
  { file: 'emp-44', name: '葛会员', role: 'CRM 忠诚度' },
  { file: 'crew-03', name: '撰稿人', role: '文案初稿' },
  { file: 'crew-06', name: '封面师', role: '封面设计' },
  { file: 'emp-56', name: '俞爬坡', role: '新店爬坡' },
  { file: 'emp-38', name: '水客诉', role: '客诉补救' },
  { file: 'crew-00', name: '趋势官', role: '热点选题' },
  { file: 'emp-60', name: '店小满', role: '超级店长' },
];

const FLOW = [
  { title: '看清问题', desc: '首页诊断与预警把经营异常摆到台面上' },
  { title: '把活派下去', desc: '选对岗位的数字员工，几毛钱一次，几分钟出活' },
  { title: '采用与授权', desc: '普通内部产出自动采用；外发、付费和不可逆动作人工确认' },
  { title: '结果回流', desc: '采纳的经验沉淀进知识库，员工越用越懂你的店' },
];

// 滚动进入视口时给区块加 in-view，驱动 CSS 入场动效（一次性，不反复闪）
function useReveal() {
  useEffect(() => {
    const targets = Array.from(document.querySelectorAll('.lp-reveal'));
    if (!targets.length || !('IntersectionObserver' in window)) {
      targets.forEach(el => el.classList.add('in-view'));
      return;
    }
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in-view');
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.18 },
    );
    targets.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, []);
}

// 数字滚动：进入视口后从 0 滚到目标值（纯展示，数值为平台真实事实）
function CountUp({ value }: { value: string }) {
  const match = value.match(/^([^\d]*)(\d+(?:\.\d+)?)(.*)$/u);
  const ref = useRef<HTMLElement>(null);
  const [display, setDisplay] = useState(match ? '0' : value);
  useEffect(() => {
    if (!match) return;
    const target = Number(match[2]);
    const el = ref.current;
    if (!el || !('IntersectionObserver' in window)) {
      setDisplay(match[2]);
      return;
    }
    let raf = 0;
    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect();
        const start = performance.now();
        const duration = 1100;
        const tick = (now: number) => {
          const progress = Math.min(1, (now - start) / duration);
          const eased = 1 - (1 - progress) ** 3;
          const current = target * eased;
          setDisplay(Number.isInteger(target) ? String(Math.round(current)) : current.toFixed(1));
          if (progress < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!match) return <strong ref={ref}>{value}</strong>;
  return (
    <strong ref={ref}>
      {match[1]}
      {display}
      {match[3]}
    </strong>
  );
}

export default function Login() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [panelOpen, setPanelOpen] = useState(params.get('login') === '1');
  const [form] = Form.useForm();
  const sound = useLoginSound();
  // 磁性光晕（proximity hover）：事件委托，一个 handler 更新容器内所有卡片的
  // 鼠标相对坐标，CSS 用径向渐变在落点处画高亮——点击前先「预览」你要点的卡。
  const glowMove = useCallback((event: React.MouseEvent<HTMLElement>) => {
    for (const card of event.currentTarget.querySelectorAll<HTMLElement>('[data-glow]')) {
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
      card.style.setProperty('--my', `${event.clientY - rect.top}px`);
    }
  }, []);
  useReveal();

  useEffect(() => {
    const saved = (localStorage.getItem(REMEMBER_KEY) || '').trim();
    // 历史版本曾把 undefined 存成字面量字符串，回填会变成“undefinedguan”。
    if (!saved || saved === 'undefined' || saved === 'null') {
      if (saved) localStorage.removeItem(REMEMBER_KEY);
      return;
    }
    form.setFieldsValue({ username: saved, remember: true });
  }, [form]);

  const openLogin = useCallback(() => {
    setPanelOpen(true);
    sound.press();
  }, [sound]);

  const closeLogin = useCallback(() => {
    setPanelOpen(false);
    if (params.get('login')) {
      const next = new URLSearchParams(params);
      next.delete('login');
      setParams(next, { replace: true });
    }
  }, [params, setParams]);

  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeLogin();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panelOpen, closeLogin]);

  const submit = async (values: { username: string; password: string; remember?: boolean }) => {
    setLoading(true);
    setLoginError('');
    sound.press();
    try {
      const data = await api.post(
        '/auth/login',
        { username: values.username, password: values.password },
        { silent: true },
      );
      const usernameToRemember = String(values.username || '').trim();
      if (values.remember && usernameToRemember) localStorage.setItem(REMEMBER_KEY, usernameToRemember);
      else localStorage.removeItem(REMEMBER_KEY);
      setAuth(data.token, data.user);
      sound.success();
      if (data.user.role === 'platform_super') {
        message.success('欢迎，平台管理员');
        nav('/platform');
        return;
      }
      const status = data.user.tenant?.status;
      if (status && status !== '已开通') {
        message.warning(
          status === '待审核' ? '企业账号正在审核中，开通后即可使用' : '企业账号已停用，请联系平台服务人员',
          4,
        );
        nav('/pending');
        return;
      }
      message.success(`欢迎回来，${data.user.name}`);
      const isMobile = /Mobile|Android|iPhone|iPad|Windows Phone/i.test(navigator.userAgent);
      nav(isMobile ? '/m' : '/');
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : '登录失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const hideBroken = (event: React.SyntheticEvent<HTMLImageElement>) => {
    event.currentTarget.classList.add('lp-img-hidden');
  };

  return (
    <main className="lp-shell">
      <a className="lp-skip" href="#lp-login-cta">
        跳到登录
      </a>

      <div className="lp-dark-zone">
        <nav className="lp-nav" aria-label="页面导航">
          <div className="lp-nav-brand">
            <img src="/brand/nanowork-icon.svg" alt="" />
            <strong>
              纳米Work<span>行业版</span>
            </strong>
          </div>
          <div className="lp-nav-links">
            <a href="#lp-day">老板的一天</a>
            <a href="#lp-features">产品能力</a>
            <a href="#lp-wall">数字员工</a>
            <a href="#lp-flow">怎么用</a>
          </div>
          <button type="button" className="lp-nav-login" id="lp-login-cta" onClick={openLogin}>
            登录
          </button>
        </nav>

        <header className="lp-hero">
          <div className="lp-aurora" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <div className="lp-hero-copy">
            <span className="lp-eyebrow lp-rise" style={{ animationDelay: '0.05s' }}>
              纳米Work 行业版 · 餐饮经营工作台
            </span>
            <h1 className="lp-rise" style={{ animationDelay: '0.15s' }}>
              店里的活，交给
              <br />
              <em>72 位数字员工</em>去干
            </h1>
            <p className="lp-hero-sub lp-rise" style={{ animationDelay: '0.28s' }}>
              不只是 AI 参谋——日清打卡、排班考勤、库存沽清、差评回复、生日关怀、外卖日报，
              门店每天要干的活一屏管完；你一句话，对口的数字员工接活就干，没干成不收钱。
            </p>
            <div className="lp-hero-ctas lp-rise" style={{ animationDelay: '0.4s' }}>
              <button type="button" className="lp-cta-main" onClick={openLogin}>
                进入经营工作台
              </button>
              <button type="button" className="lp-cta-ghost" onClick={() => nav('/register')}>
                申请企业开通
              </button>
            </div>
            <div className="lp-hero-trust lp-rise" style={{ animationDelay: '0.52s' }}>
              <span>数据按企业隔离</span>
              <span>关键动作可追溯</span>
              <span>AI 外发需人工确认</span>
            </div>
          </div>
          <div className="lp-hero-visual lp-rise" style={{ animationDelay: '0.3s' }}>
            <img src="/landing/hero.jpg" alt="纳米Work 数字员工在餐饮门店中协助经营" onError={hideBroken} />
            <div className="lp-hero-fallback" aria-hidden="true">
              <ShopOutlined />
            </div>
            <div className="lp-float lp-float-a">
              <img src="/avatars/employees/emp-61.jpg" alt="" onError={hideBroken} />
              <div>
                <strong>巡店记录已生成</strong>
                <span>查巡巡 · 巡店督导</span>
              </div>
            </div>
            <div className="lp-float lp-float-b">
              <img src="/avatars/employees/emp-12.jpg" alt="" onError={hideBroken} />
              <div>
                <strong>菜单工程分析完成</strong>
                <span>卫菜工 · 约 41 积分/次</span>
              </div>
            </div>
          </div>
        </header>

        <section className="lp-stats lp-reveal" aria-label="平台事实">
          {STATS.map(item => (
            <div className="lp-stat" key={item.label}>
              <CountUp value={item.value} />
              <span>{item.label}</span>
            </div>
          ))}
        </section>
      </div>

      <section className="lp-section lp-reveal" id="lp-day" aria-label="老板的一天">
        <div className="lp-section-head">
          <h2>开一天店，它陪你干一天</h2>
          <p>从早上的晨会到晚上收账，每个时点都有它在干活——不是多一个软件，是多一个班子。</p>
        </div>
        <div className="lp-day" onMouseMove={glowMove}>
          {DAY_TIMELINE.map((slot, index) => (
            <div className="lp-day-slot" data-glow key={slot.time} style={{ transitionDelay: `${index * 0.07}s` }}>
              <time>{slot.time}</time>
              <h4>{slot.title}</h4>
              <p>{slot.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-section lp-reveal" id="lp-features" aria-label="产品能力">
        <div className="lp-section-head">
          <h2>你请不起的团队，这里全都有</h2>
          <p>每一项能力都是真实闭环：看得到输入、看得到产出、看得到成本，普通内部结果自动采用。</p>
        </div>
        <div className="lp-features" onMouseMove={glowMove}>
          {FEATURES.map(feature => (
            <article className="lp-feature" data-glow key={feature.key}>
              <div className="lp-feature-media">
                <i aria-hidden="true">{feature.icon}</i>
                <img src={feature.image} alt="" loading="lazy" onError={hideBroken} />
              </div>
              <div className="lp-feature-body">
                <h3>{feature.title}</h3>
                <ul>
                  {feature.points.map(point => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section lp-reveal" id="lp-wall" aria-label="数字员工">
        <div className="lp-section-head">
          <h2>见见你的新员工</h2>
          <p>72 位数字员工各有姓名、岗位手册和技能库——不是一个聊天框套 72 个名字。</p>
        </div>
        <div className="lp-wall-marquee" aria-hidden="false">
          <div className="lp-wall-track">
            {[...WALL, ...WALL].map((member, index) => (
              <figure key={`${member.file}-${index}`} aria-hidden={index >= WALL.length}>
                <img
                  src={`/avatars/employees/${member.file}.jpg`}
                  alt={index < WALL.length ? `${member.name} · ${member.role}` : ''}
                  loading="lazy"
                  onError={hideBroken}
                />
                <figcaption>
                  <b>{member.name}</b>
                  {member.role}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section lp-reveal" id="lp-flow" aria-label="使用流程">
        <div className="lp-section-head">
          <h2>四步跑通经营闭环</h2>
          <p>不是多一个软件，而是多一支每天上班的队伍。</p>
        </div>
        <div className="lp-flow" onMouseMove={glowMove}>
          {FLOW.map((step, index) => (
            <div className="lp-flow-step" data-glow key={step.title} style={{ transitionDelay: `${index * 0.08}s` }}>
              <i>{index + 1}</i>
              <h4>{step.title}</h4>
              <p>{step.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-cta-band lp-reveal">
        <h2>今天就把第一单活派出去</h2>
        <p>登录后 3 分钟内，你就能拿到第一份数字员工交付</p>
        <button type="button" className="lp-cta-main" onClick={openLogin}>
          立即登录
        </button>
      </section>

      <footer className="lp-foot">纳米Work行业版 · 让每一家实体店都有一支懂行业、能落地的数字员工队伍</footer>

      {panelOpen && (
        <>
          <div className="lp-login-mask" role="presentation" onClick={closeLogin} />
          <aside className="lp-login-panel" role="dialog" aria-modal="true" aria-label="企业登录">
            <button type="button" className="lp-login-close" aria-label="关闭登录面板" onClick={closeLogin}>
              <CloseOutlined />
            </button>
            <div className="au-min">
              <div className="au-min-brand">
                <img src="/brand/nanowork-icon.svg" alt="" width={48} height={48} />
              </div>
              <h1 className="au-min-title">欢迎回到纳米Work</h1>
              <p className="au-min-sub">登录后继续你的门店经营工作台</p>
              <Form
                className="au-min-form"
                form={form}
                onFinish={submit}
                onValuesChange={() => setLoginError('')}
                requiredMark={false}
                size="large"
                layout="vertical"
              >
                {loginError && <Alert className="lp-login-error" type="error" showIcon message={loginError} />}
                <Form.Item name="username" rules={[{ required: true, message: '请输入账号' }]}>
                  <Input
                    prefix={<UserOutlined />}
                    placeholder="账号 / 手机号"
                    autoComplete="username"
                    aria-label="账号"
                  />
                </Form.Item>
                <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
                  <Input.Password
                    prefix={<LockOutlined />}
                    placeholder="密码"
                    autoComplete="current-password"
                    aria-label="密码"
                  />
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
              <div className="au-min-foot">
                <span>还没有企业账号？</span>
                <button type="button" className="au-link" onClick={() => nav('/register')}>
                  申请开通
                </button>
              </div>
              <div className="au-min-trust">
                <SoundToggle on={sound.soundOn} onToggle={sound.toggle} />
              </div>
            </div>
          </aside>
        </>
      )}
    </main>
  );
}
