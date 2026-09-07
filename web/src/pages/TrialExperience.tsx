import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Form, Input, Progress, Result, Spin } from 'antd';
import { Link, useParams } from 'react-router-dom';
import { TrialHistory, newTrialRequestId, trialError, trialProviderLabel, trialRequest } from './TrialShared';
import type { TrialConversation, TrialEmployee, TrialLead } from './TrialShared';
import TrialEmployeePicker, { TrialEmployeeGuide } from './TrialEmployeePicker';
import './Trial.css';

type TrialLanding = {
  title: string;
  salesPhone: string;
  employees: TrialEmployee[];
  disclosure: string;
  turnLimit: number;
  provider?: string;
  providerLabel?: string;
};

export default function TrialExperience() {
  const { token = '' } = useParams();
  const storageKey = `nanowork-trial-${token}`;
  const [landing, setLanding] = useState<TrialLanding | null>(null);
  const [accessToken, setAccessToken] = useState(() => localStorage.getItem(storageKey) || '');
  const [restoring, setRestoring] = useState(() => Boolean(localStorage.getItem(storageKey)));
  const [lead, setLead] = useState<TrialLead | null>(null);
  const [conversations, setConversations] = useState<TrialConversation[]>([]);
  const [employeeId, setEmployeeId] = useState<string>();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fatal, setFatal] = useState('');
  const retry = useRef<{ employeeId: string; message: string; requestId: string } | null>(null);
  const sending = useRef(false);

  const refresh = useCallback(
    async (sessionToken = accessToken) => {
      if (!sessionToken) return;
      const result = await trialRequest(`/trial/${encodeURIComponent(token)}/session`, { token: sessionToken });
      setLead(result.lead);
      setConversations(result.conversations || []);
    },
    [accessToken, token],
  );
  useEffect(() => {
    let active = true;
    trialRequest<TrialLanding>(`/trial/${encodeURIComponent(token)}`)
      .then(result => {
        if (active) {
          setLanding(result);
          setEmployeeId(result.employees?.[0]?.id);
        }
      })
      .catch(error => {
        if (active) setFatal(trialError(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token]);
  useEffect(() => {
    if (!accessToken) return;
    const frame = requestAnimationFrame(() => {
      void refresh()
        .catch(error => setError(trialError(error)))
        .finally(() => setRestoring(false));
    });
    return () => cancelAnimationFrame(frame);
  }, [refresh, accessToken]);
  useEffect(() => {
    if (lead?.status !== 'pending') return;
    const timer = window.setInterval(() => {
      void refresh().catch(() => {});
    }, 10000);
    return () => window.clearInterval(timer);
  }, [lead?.status, refresh]);

  const apply = async (values: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      const result = await trialRequest(`/trial/${encodeURIComponent(token)}/apply`, { method: 'POST', body: values });
      localStorage.setItem(storageKey, result.accessToken);
      setAccessToken(result.accessToken);
      setLead(result.lead);
      await refresh(result.accessToken);
    } catch (error) {
      setError(trialError(error));
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    const text = draft.trim();
    if (!text || !employeeId || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    if (retry.current?.message !== text || retry.current?.employeeId !== employeeId)
      retry.current = { employeeId, message: text, requestId: newTrialRequestId() };
    try {
      const result = await trialRequest(`/trial/${encodeURIComponent(token)}/chat`, {
        method: 'POST',
        token: accessToken,
        body: retry.current,
      });
      setLead(result.lead);
      setDraft('');
      retry.current = null;
      await refresh();
    } catch (error) {
      setError(trialError(error));
      // 请求断线时先读服务端记录；已成功的问答仍保留，次数以服务端为准。
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
      sending.current = false;
    }
  };
  const selected = landing?.employees.find(item => item.id === employeeId);
  const exhausted = lead && lead.remainingTurns <= 0;
  const chooseEmployee = (id: string) => {
    setEmployeeId(id);
    // 只记录客户主动选岗；没有同意新版说明的旧客户可继续使用，不因兴趣记录失败而中断。
    if (accessToken && lead?.status === 'approved') {
      void trialRequest(`/trial/${encodeURIComponent(token)}/interest`, {
        method: 'POST',
        token: accessToken,
        body: { employeeId: id },
      }).catch(() => {});
    }
  };

  return (
    <main className="trial-shell trial-mobile">
      <header className="trial-header">
        <Link to="/login" className="trial-brand">
          纳米 Work
        </Link>
        <span className="trial-muted">餐饮数字员工</span>
      </header>
      {loading ? (
        <div className="trial-loading">
          <Spin size="large" />
        </div>
      ) : fatal ? (
        <Result
          status="info"
          title="这个体验暂不可用"
          subTitle={fatal}
          extra={<Button onClick={() => window.location.reload()}>重新查看</Button>}
        />
      ) : (
        landing && (
          <>
            <section className="trial-hero">
              <span className="trial-eyebrow">给餐饮老板的 AI 工作伙伴</span>
              <h1>
                把想法说出来，
                <br />
                让数字员工帮你做。
              </h1>
              <p>新品推广怎么写，差评如何回复，活动怎样安排？说说你的门店，马上看看能用的结果。</p>
              <div className="trial-benefits">
                <span>说一句需求</span>
                <span>拿到完整正文</span>
                <span>复制就能用</span>
              </div>
            </section>
            <section className="trial-panel">
              <h2>先选一位员工，看看怎么用</h2>
              <TrialEmployeePicker
                employees={landing.employees}
                value={employeeId}
                onChange={chooseEmployee}
                disabled={busy}
              />
              <TrialEmployeeGuide employee={selected} onExample={setDraft} disabled={busy} />
            </section>
            <section className="trial-panel">
              <div className="trial-section-title">
                <h2>{landing.title || '数字员工限次体验'}</h2>
                <span className="trial-pill">
                  {landing.turnLimit || 2} 次问答 ·{' '}
                  {trialProviderLabel(landing.provider, landing.providerLabel || '360 智脑')}
                </span>
              </div>
              {landing.salesPhone && (
                <p className="trial-muted">
                  专属邀请：<a href={`tel:${landing.salesPhone}`}>{landing.salesPhone}</a>
                </p>
              )}
              {error && <Alert type="error" showIcon message={error} className="trial-notice" />}
              {restoring && (
                <div className="trial-loading">
                  <Spin aria-label="读取你的体验记录" />
                </div>
              )}
              {!lead && !restoring && (
                <>
                  <p>
                    填写资料，邀请人审核后即可开始。本邀请固定使用
                    {trialProviderLabel(landing.provider, landing.providerLabel || '360 智脑')}，体验费用由邀请人承担。
                  </p>
                  <Form layout="vertical" requiredMark={false} onFinish={apply}>
                    <Form.Item name="name" label="你的称呼" rules={[{ required: true, message: '请填写你的称呼' }]}>
                      <Input autoComplete="name" maxLength={40} />
                    </Form.Item>
                    <Form.Item
                      name="phone"
                      label="手机号"
                      rules={[
                        { required: true, message: '请填写手机号' },
                        { pattern: /^1\d{10}$/, message: '请输入 11 位手机号' },
                      ]}
                    >
                      <Input autoComplete="tel" inputMode="tel" maxLength={11} />
                    </Form.Item>
                    <Form.Item name="storeName" label="门店名称（选填）">
                      <Input autoComplete="organization" maxLength={80} />
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
                        {landing.disclosure ||
                          '我同意保存本次申请与体验记录，并向邀请人及平台管理员展示我的手机号、使用次数和对话内容，用于审核、服务与联系。'}
                      </Checkbox>
                    </Form.Item>
                    <Button htmlType="submit" type="primary" size="large" block loading={busy}>
                      申请 2 次体验
                    </Button>
                  </Form>
                </>
              )}
              {lead?.status === 'pending' && (
                <Result
                  status="info"
                  title="申请已送达，等待审核"
                  subTitle="邀请人或平台管理员同意后，这里会自动更新。"
                  extra={
                    <Button onClick={() => void refresh().catch(error => setError(trialError(error)))}>
                      查看审核状态
                    </Button>
                  }
                />
              )}
              {lead && ['paused', 'rejected'].includes(lead.status) && (
                <Result
                  status="info"
                  title={lead.status === 'paused' ? '体验已暂停' : '本次申请未通过'}
                  subTitle="如需帮助，请联系页面上方的邀请人。"
                  extra={
                    <Button onClick={() => void refresh().catch(error => setError(trialError(error)))}>刷新状态</Button>
                  }
                />
              )}
              {lead?.status === 'approved' && (
                <>
                  <div className="trial-turns">
                    <strong>{exhausted ? '两次体验已完成' : `还可以体验 ${lead.remainingTurns} 次`}</strong>
                    <Progress
                      percent={Math.min(100, (lead.usedTurns / (landing.turnLimit || 2)) * 100)}
                      showInfo={false}
                      strokeColor="var(--ui-primary)"
                    />
                  </div>
                  {!exhausted ? (
                    <>
                      <p className="trial-muted">本次由「{selected?.name || '数字员工'}」为你提供文字建议。</p>
                      <div className="trial-field-label" id="trial-message-label">
                        你的需求
                      </div>
                      <Input.TextArea
                        id="trial-message"
                        aria-labelledby="trial-message-label"
                        value={draft}
                        onChange={event => setDraft(event.target.value)}
                        autoSize={{ minRows: 4, maxRows: 10 }}
                        maxLength={6000}
                        disabled={busy}
                        placeholder="例如：我开火锅店，新推鲜切牛肉，帮我写一篇让人有食欲的小红书文案。"
                      />
                      <Button
                        className="trial-send"
                        type="primary"
                        size="large"
                        block
                        loading={busy}
                        disabled={!draft.trim() || !employeeId}
                        onClick={() => void send()}
                      >
                        {busy ? '数字员工正在工作' : `开始这次问答（剩余 ${lead.remainingTurns} 次）`}
                      </Button>
                      <p className="trial-small trial-muted">
                        每次发送并成功得到回复计 1 次。没有生成可用结果时可重试。
                      </p>
                    </>
                  ) : (
                    <>
                      <p>你的输入与结果仍保存在下面，可随时展开、复制。想继续使用更多数字员工，请联系邀请人。</p>
                      {landing.salesPhone && (
                        <Button block type="primary" size="large" href={`tel:${landing.salesPhone}`}>
                          联系邀请人，了解完整产品
                        </Button>
                      )}
                    </>
                  )}
                </>
              )}
            </section>
            {conversations.length > 0 && (
              <section className="trial-panel">
                <h2>我的体验记录</h2>
                <TrialHistory conversations={conversations} />
              </section>
            )}
            <footer className="trial-footer">
              纳米 Work · 让餐饮老板把时间留给生意
              <br />
              <Link to="/login">了解完整产品</Link>
            </footer>
          </>
        )
      )}
    </main>
  );
}
