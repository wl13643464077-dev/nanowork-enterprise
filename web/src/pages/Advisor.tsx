import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Row,
  Col,
  Card,
  Button,
  Input,
  Tag,
  Steps,
  Avatar,
  Empty,
  Spin,
  Progress,
  message,
  Select,
  Tooltip,
  Drawer,
  List,
  Space,
  Badge,
} from 'antd';
import {
  SendOutlined,
  RobotOutlined,
  BulbOutlined,
  DatabaseOutlined,
  GlobalOutlined,
  ThunderboltOutlined,
  TeamOutlined,
  HistoryOutlined,
  RadarChartOutlined,
  ApartmentOutlined,
  RightOutlined,
  LoadingOutlined,
  PlusOutlined,
  AudioOutlined,
  FolderOpenOutlined,
  PushpinOutlined,
  CopyOutlined,
  FolderAddOutlined,
  CarryOutOutlined,
} from '@ant-design/icons';
import { api, getUser, notifyCredits, safeUrl } from '../api/client';
import type { AdvisorConversation, AdvisorCapability } from '../api/types';
import { Panel } from '../components/Kit';
import { Markdown } from '../components/Markdown';
import { useQuery, QueryStatus } from '../hooks/useQuery';
import { Chart } from '../components/Charts';
import { UnifiedFilePicker, type UploadedFileRef } from '../components/UnifiedFilePicker';
import { ArtifactActions } from '../components/ArtifactActions';
import { useNavigate } from 'react-router-dom';

const { TextArea } = Input;

const DIAG_TYPES = [
  { label: '经营诊断', icon: '📊' },
  { label: '战略诊断', icon: '🎯' },
  { label: '销售诊断', icon: '💰' },
  { label: '产品诊断', icon: '📦' },
  { label: '团队诊断', icon: '👥' },
  { label: '风险诊断', icon: '⚠️' },
];

// 真实阶段（由实际事件驱动：提交 → 首个流式分片 → 完成），不再用定时器演出假进度
const STEP_DEFS = [
  { title: '问题已提交', desc: '问题与附件已送达老板参谋' },
  { title: 'AI 生成中', desc: '流式返回中，内容逐段呈现' },
  { title: '完成', desc: '结论、来源与推荐转派已就绪' },
];
const STEP_DONE = STEP_DEFS.length + 1; // 全部完成标记

const DEFAULT_QUESTIONS = [
  '本月销售下滑的主要原因是什么？',
  '高意向客户迟迟不成交怎么办？',
  '下周到店主题活动如何提升到场率？',
  '团队执行力不足怎么改善？',
];
const Q_ICONS = ['📉', '🤝', '🍽️', '🚀'];
const buttonResetStyle = {
  appearance: 'none',
  border: 0,
  padding: 0,
  margin: 0,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'inherit',
} as const;

interface Msg {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  loading?: boolean;
  typing?: boolean;
  mode?: string;
  sources?: { title: string; url: string; snippet?: string }[];
  webNote?: string | null;
  deep?: boolean;
  serverId?: number;
}

function ToolChip({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...buttonResetStyle,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 10px',
        borderRadius: 14,
        fontSize: 11.5,
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'all .2s',
        background: active ? 'var(--ui-surface)' : 'var(--ui-surface)',
        color: active ? 'var(--ui-accent)' : 'var(--ui-muted)',
        border: `1px solid ${active ? 'var(--ui-surface)' : 'transparent'}`,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

export default function Advisor() {
  const nav = useNavigate();
  const user = getUser();
  const [questions, setQuestions] = useState<string[]>(DEFAULT_QUESTIONS);
  const [diagType, setDiagType] = useState('经营诊断');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState<any>(null);
  // useQuery：读路径四态（loading/empty/error/retry）+ 版本号防竞态
  const conversationsQ = useQuery<AdvisorConversation[]>('/advisor/conversations');
  const conversations = conversationsQ.data || [];
  const capabilityQ = useQuery<AdvisorCapability>('/advisor/capability', [], { isEmpty: d => !d?.radar?.length });
  const capability: AdvisorCapability = capabilityQ.data || { radar: [], networkStatus: [] };
  const [recommended, setRecommended] = useState<any[]>([]);
  const [stepActive, setStepActive] = useState(-1); // -1 未开始 / 0-3 进行中 / 4 全部完成
  const [stepDetails, setStepDetails] = useState<string[]>([]);
  const [lastQuestion, setLastQuestion] = useState('');
  const [webOn, setWebOn] = useState(false);
  const [deepOn, setDeepOn] = useState(false);
  const [draftNotice, setDraftNotice] = useState('');
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [artifacts, setArtifacts] = useState<any[]>([]);
  const [memories, setMemories] = useState<any[]>([]);
  const [now] = useState(() => new Date());

  const chatRef = useRef<HTMLDivElement>(null);
  const stepTimersRef = useRef<any[]>([]);
  const idRef = useRef(1);
  const conversationViewRef = useRef(0);
  const nextId = () => idRef.current++;

  const clearTimers = () => {
    stepTimersRef.current.forEach(clearTimeout);
    stepTimersRef.current = [];
  };

  useEffect(() => {
    api
      .get('/advisor/suggested')
      .then(d => {
        if (d?.questions?.length) setQuestions(d.questions);
      })
      .catch(() => {});
    refreshWorkspace();
    return clearTimers;
  }, []);

  // 消息变化时自动滚到底部
  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const [attachments, setAttachments] = useState<UploadedFileRef[]>([]);
  const [ownerMarshal, setOwnerMarshal] = useState<string | undefined>(undefined);
  const [listening, setListening] = useState(false);

  // 数据导入：附加实时经营数据摘要
  const importData = async () => {
    const d = await api.get('/advisor/suggested');
    const content = JSON.stringify(d.summary, null, 2);
    const b64 = btoa(unescape(encodeURIComponent(content)));
    const result = await api.post('/files/upload', {
      name: '近30天经营数据摘要.json',
      mime: 'application/json',
      b64,
      purpose: 'advisor',
      recognize: false,
    });
    setAttachments(prev => [...prev, result.file].slice(-6));
    message.success('已附加近30天经营数据摘要');
  };

  function refreshWorkspace() {
    api
      .get('/files/artifacts?mine=1')
      .then(d => setArtifacts(d || []))
      .catch(() => {});
    api
      .get('/advisor/memories')
      .then(d => setMemories(d || []))
      .catch(() => {});
  }

  const remember = async (m: Msg) => {
    if (!conversationId) return message.warning('请先开始一轮会诊');
    await api.post(`/advisor/conversations/${conversationId}/memory`, {
      title: lastQuestion || `${diagType}会诊`,
      content: m.content,
    });
    message.success('已写入本会话记忆，后续提问会自动带入');
    refreshWorkspace();
  };

  const archiveArtifact = async (a: any) => {
    await api.post(`/files/artifacts/${a.id}/archive`, { category: '员工产出' });
    message.success('已入档知识库，后续AI可以抽调');
    refreshWorkspace();
  };

  // 语音输入（浏览器 Web Speech API，不支持时提示）
  const toggleVoice = () => {
    const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
    if (!SR) {
      message.info('当前浏览器不支持语音输入，请使用 Chrome/Edge');
      return;
    }
    const rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = false;
    rec.onresult = (e: any) => setInput(v => v + (e.results[0][0].transcript || ''));
    rec.onend = () => setListening(false);
    setListening(true);
    rec.start();
  };

  const send = async (q?: string) => {
    const question = (q ?? input).trim();
    if (!question || sending) return;
    setSending(true);
    setDraftNotice('');
    setInput('');
    setLastQuestion(question);
    clearTimers();
    const loadingId = nextId();
    const viewVersion = conversationViewRef.current;
    setMessages(prev => [
      ...prev,
      { id: nextId(), role: 'user', content: question },
      { id: loadingId, role: 'assistant', content: '', loading: true },
    ]);
    // 阶段进度由真实事件驱动：此处进入「问题已提交」，收到首个流式分片时进入「AI 生成中」
    setStepActive(0);
    setStepDetails([]);
    try {
      // 真流式（SSE）：delta 逐段渲染，reset 表示服务端通道切换需清屏重来
      const res = await api.stream(
        '/advisor/chat',
        {
          conversationId: conversationId || undefined,
          diagType,
          question,
          marshalCode: ownerMarshal || undefined,
          fileIds: attachments.length ? attachments.map(a => a.id) : undefined,
          web: webOn || undefined,
          deep: deepOn || undefined,
          stream: true,
        },
        ev => {
          if (viewVersion !== conversationViewRef.current) return;
          if (ev.reset)
            setMessages(prev =>
              prev.map(m => (m.id === loadingId ? { ...m, content: '', loading: true, typing: false } : m)),
            );
          else if (typeof ev.delta === 'string') {
            setStepActive(prev => (prev >= 0 && prev < 1 ? 1 : prev)); // 首个分片：真实进入「AI 生成中」
            setMessages(prev =>
              prev.map(m =>
                m.id === loadingId ? { ...m, loading: false, typing: true, content: (m.content || '') + ev.delta } : m,
              ),
            );
          }
        },
      );
      setAttachments([]);
      if (res.billing) {
        notifyCredits(res.billing.balance);
        if (res.billing.credits > 0) message.success(`本次会诊消耗 ${res.billing.credits} 积分`);
      }
      conversationsQ.retry();
      if (viewVersion !== conversationViewRef.current) return;
      clearTimers();
      setStepActive(STEP_DONE);
      if (Array.isArray(res.steps)) setStepDetails(res.steps);
      if (res.conversationId) setConversationId(res.conversationId);
      setRecommended(res.recommended || []);
      // 收尾：以服务端最终文本为准，挂载来源/模式/深度标记
      setMessages(prev =>
        prev.map(m =>
          m.id === loadingId
            ? {
                ...m,
                serverId: res.assistantMessageId,
                sources: res.sources || [],
                webNote: res.webNote,
                deep: !!res.deep,
                mode: res.mode,
                content: res.reply || m.content || '（暂无回复内容）',
                loading: false,
                typing: false,
              }
            : m,
        ),
      );
      if (webOn && res.webNote) message.info(res.webNote);
    } catch {
      if (viewVersion !== conversationViewRef.current) return;
      clearTimers();
      setStepActive(-1);
      setMessages(prev => prev.filter(m => m.id !== loadingId));
    } finally {
      setSending(false);
    }
  };

  const loadConversation = (c: any) => {
    const viewVersion = ++conversationViewRef.current;
    clearTimers();
    setConversationId(c.id);
    if (c.diag_type) setDiagType(c.diag_type);
    setLastQuestion(c.title || '');
    setStepActive(-1);
    setStepDetails([]);
    setRecommended([]);
    api
      .get(`/advisor/conversations/${c.id}/messages`)
      .then((list: any[]) => {
        if (viewVersion === conversationViewRef.current)
          setMessages((list || []).map((m: any) => ({ id: m.id, serverId: m.id, role: m.role, content: m.content })));
      })
      .catch(() => {});
  };

  const newSession = () => {
    conversationViewRef.current++;
    clearTimers();
    setConversationId(null);
    setMessages([]);
    setStepActive(-1);
    setStepDetails([]);
    setRecommended([]);
    setLastQuestion('');
    setInput('');
    setDraftNotice('');
  };

  const primeQuestion = (q: string) => {
    setInput(q);
    setDraftNotice('已带入输入框，点击「开始诊断」后才会调用AI并按积分计费。');
    message.info('问题已带入输入框，确认开始诊断后才会消耗积分');
  };

  const dispatchMarshals = async (codes: string[], names: string[]) => {
    if (!codes.length) return;
    const res = await api.post('/advisor/dispatch', {
      marshalCodes: codes,
      title: (lastQuestion || `${diagType}会诊`).slice(0, 50),
    });
    const dispatched: string[] = res?.dispatched?.length ? res.dispatched : names;
    message.success(`已转派：${dispatched.join('、')}`);
  };

  const stepItems = STEP_DEFS.map((s, i) => {
    const status: 'wait' | 'process' | 'finish' =
      stepActive === STEP_DONE
        ? 'finish'
        : stepActive === -1
          ? 'wait'
          : i < stepActive
            ? 'finish'
            : i === stepActive
              ? 'process'
              : 'wait';
    const detail = stepDetails[i] && stepDetails[i] !== s.title ? stepDetails[i] : s.desc;
    return {
      title: (
        <span
          style={{
            fontSize: 12.5,
            fontWeight: status === 'wait' ? 400 : 600,
            color: status === 'wait' ? 'var(--ui-muted)' : 'var(--ui-text)',
          }}
        >
          {s.title}
        </span>
      ),
      description: <span style={{ fontSize: 11.5, color: 'var(--ui-muted)' }}>{detail}</span>,
      status,
      icon: status === 'process' ? <LoadingOutlined /> : undefined,
    };
  });

  const networkStatus: any[] = capability.networkStatus || [];
  const onlineCount = networkStatus.filter(n => n.online || n.running).length;
  const runningCount = networkStatus.filter(n => n.running).length;
  const synergyPct = networkStatus.length ? Math.round((runningCount / networkStatus.length) * 100) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Row gutter={[12, 12]}>
        {/* ===== 左侧主区（2/3）===== */}
        <Col xs={24} lg={16}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* AI 欢迎卡 */}
            <Card
              size="small"
              styles={{ body: { padding: 18 } }}
              style={{
                borderRadius: 10,
                border: '1px solid var(--ui-surface)',
                background: 'linear-gradient(135deg,var(--ui-surface) 0%,var(--ui-surface) 55%,var(--ui-surface) 100%)',
              }}
            >
              <div style={{ display: 'flex', gap: 14 }}>
                <Avatar
                  size={54}
                  style={{
                    background: 'linear-gradient(135deg,#26242f,var(--ui-surface-2))',
                    flexShrink: 0,
                    border: '1px solid rgba(218,179,105,.5)',
                    boxShadow: '0 4px 14px rgba(218,179,105,.22)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <svg width="26" height="33" viewBox="0 0 60 88" aria-hidden="true">
                    <defs>
                      <linearGradient id="advlogo" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor="#fff6e0" />
                        <stop offset="1" stopColor="var(--ui-primary)" />
                      </linearGradient>
                    </defs>
                    <rect
                      x="6"
                      y="6"
                      width="48"
                      height="76"
                      rx="3"
                      fill="none"
                      stroke="url(#advlogo)"
                      strokeWidth="3"
                    />
                  </svg>
                </Avatar>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--ui-text)' }}>纳米Work老板参谋</span>
                    <Tag color="blue" style={{ fontSize: 10.5, lineHeight: '16px', margin: 0 }}>
                      AI
                    </Tag>
                    <span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>
                      今天 {String(now.getHours()).padStart(2, '0')}:{String(now.getMinutes()).padStart(2, '0')}
                    </span>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 13, color: 'var(--ui-text-2)', lineHeight: 1.8 }}>
                    您好，{user?.name || '老板'}，我是您的老板参谋。我已接入餐饮数字员工智能体与全量经营数据，
                    可以为您做全局经营判断、智能体调度、风险提示与方案生成。您可以直接输入经营问题，
                    也可以点击下方「猜你想问」快速开始一次会诊。
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 14, fontSize: 12, fontWeight: 600, color: 'var(--ui-text-2)' }}>
                <BulbOutlined style={{ color: '#f6a02d' }} /> 猜你想问
              </div>
              <Row gutter={[8, 8]} style={{ marginTop: 8 }}>
                {questions.slice(0, 4).map((q, i) => (
                  <Col xs={24} sm={12} key={i}>
                    <button
                      type="button"
                      onClick={() => primeQuestion(q)}
                      style={{
                        ...buttonResetStyle,
                        width: '100%',
                        textAlign: 'left',
                        background: 'var(--ui-surface)',
                        border: '1px solid var(--ui-surface)',
                        borderRadius: 8,
                        padding: '9px 12px',
                        fontSize: 12.5,
                        color: 'var(--ui-text-2)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <span style={{ fontSize: 14 }}>{Q_ICONS[i % Q_ICONS.length]}</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {q}
                      </span>
                      <RightOutlined style={{ fontSize: 10, color: '#bcc7d6' }} />
                    </button>
                  </Col>
                ))}
              </Row>
            </Card>

            {/* 诊断类型胶囊行 */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {DIAG_TYPES.map(d => {
                const active = diagType === d.label;
                return (
                  <button
                    type="button"
                    key={d.label}
                    onClick={() => setDiagType(d.label)}
                    style={{
                      ...buttonResetStyle,
                      padding: '6px 16px',
                      borderRadius: 18,
                      fontSize: 12.5,
                      cursor: 'pointer',
                      userSelect: 'none',
                      fontWeight: active ? 600 : 400,
                      transition: 'all .2s',
                      background: active ? 'var(--ui-primary)' : 'var(--ui-surface)',
                      color: active ? 'var(--ui-on-primary)' : 'var(--ui-text-2)',
                      border: `1px solid ${active ? 'var(--ui-primary)' : 'var(--ui-surface)'}`,
                      boxShadow: active ? '0 2px 8px color-mix(in srgb, var(--ui-primary) 30%, transparent)' : 'none',
                    }}
                  >
                    {d.icon} {d.label}
                  </button>
                );
              })}
            </div>

            {/* 对话区 */}
            {messages.length > 0 && (
              <Panel
                title={
                  <>
                    <RobotOutlined style={{ color: 'var(--ui-accent)' }} /> AI会诊对话
                  </>
                }
                extra={
                  <Space size={6}>
                    <Tag color="blue" style={{ fontSize: 11, margin: 0 }}>
                      {diagType}
                    </Tag>
                    <Button
                      size="small"
                      type="text"
                      icon={<FolderOpenOutlined />}
                      onClick={() => {
                        refreshWorkspace();
                        setWorkspaceOpen(true);
                      }}
                    >
                      产出档案
                    </Button>
                  </Space>
                }
                style={{ height: 'auto' }}
              >
                <div
                  ref={chatRef}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                    maxHeight: 430,
                    minHeight: 160,
                    overflow: 'auto',
                    background: 'var(--ui-surface-2)',
                    borderRadius: 8,
                    padding: 12,
                  }}
                >
                  {messages.map(m => (
                    <div
                      key={m.id}
                      style={{ display: 'flex', gap: 8, justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}
                    >
                      {m.role === 'assistant' && (
                        <Avatar size={28} style={{ background: 'var(--ui-primary)', fontSize: 14, flexShrink: 0 }}>
                          AI
                        </Avatar>
                      )}
                      <div
                        style={{
                          maxWidth: '80%',
                          padding: '9px 12px',
                          fontSize: 13,
                          lineHeight: 1.75,
                          borderRadius: m.role === 'user' ? '10px 10px 2px 10px' : '2px 10px 10px 10px',
                          background: m.role === 'user' ? 'var(--ui-primary)' : 'var(--ui-surface)',
                          color: m.role === 'user' ? 'var(--ui-on-primary)' : 'var(--ui-text-2)',
                          border: m.role === 'user' ? 'none' : '1px solid var(--ui-border)',
                          boxShadow: m.role === 'assistant' ? '0 1px 3px rgba(28,36,52,.04)' : 'none',
                        }}
                      >
                        {m.loading ? (
                          <span style={{ color: 'var(--ui-muted)', fontSize: 12.5 }}>
                            <Spin size="small" style={{ marginRight: 8 }} />
                            老板参谋正在分析您的问题…
                          </span>
                        ) : (
                          <>
                            {m.role === 'assistant' ? (
                              <div style={{ wordBreak: 'break-word' }}>
                                <Markdown content={m.content} />
                                {m.typing && <span style={{ color: 'var(--ui-accent)' }}>▍</span>}
                              </div>
                            ) : (
                              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</div>
                            )}
                            {!m.typing && !!m.sources?.length && (
                              <div
                                style={{
                                  marginTop: 8,
                                  padding: '8px 10px',
                                  background: 'var(--ui-surface-2)',
                                  borderRadius: 8,
                                  border: '1px solid var(--ui-border)',
                                }}
                              >
                                <div
                                  style={{ fontSize: 11, fontWeight: 600, color: 'var(--ui-accent)', marginBottom: 4 }}
                                >
                                  🌐 联网来源（{m.sources.length}条，点击查看原文）
                                </div>
                                {m.sources.map((s, i) => (
                                  <a
                                    key={i}
                                    href={safeUrl(s.url)}
                                    target="_blank"
                                    rel="noreferrer"
                                    style={{
                                      display: 'block',
                                      fontSize: 11.5,
                                      lineHeight: 1.9,
                                      textDecoration: 'none',
                                    }}
                                  >
                                    <Tag
                                      color="blue"
                                      style={{ fontSize: 10, lineHeight: '14px', padding: '0 4px', marginRight: 4 }}
                                    >
                                      来源{i + 1}
                                    </Tag>
                                    <span style={{ color: 'var(--ui-text-2)' }}>{s.title}</span>
                                  </a>
                                ))}
                              </div>
                            )}
                            {(m.mode === 'template' || m.deep) && !m.typing && (
                              <div
                                style={{
                                  marginTop: 6,
                                  textAlign: 'right',
                                  display: 'flex',
                                  gap: 4,
                                  justifyContent: 'flex-end',
                                }}
                              >
                                {m.deep && (
                                  <Tag color="purple" style={{ fontSize: 10.5, lineHeight: '16px', margin: 0 }}>
                                    🧠 深度思考·{'gpt-5.5'}
                                  </Tag>
                                )}
                                {m.mode === 'template' && (
                                  <Tag color="orange" style={{ fontSize: 10.5, lineHeight: '16px', margin: 0 }}>
                                    模板模式
                                  </Tag>
                                )}
                              </div>
                            )}
                            {m.role === 'assistant' && !m.typing && !m.loading && (
                              <div
                                style={{
                                  marginTop: 7,
                                  paddingTop: 6,
                                  borderTop: '1px solid var(--ui-border)',
                                  display: 'flex',
                                  justifyContent: 'flex-end',
                                  gap: 2,
                                  flexWrap: 'wrap',
                                }}
                              >
                                <Tooltip title="复制本次回答">
                                  <Button
                                    size="small"
                                    type="text"
                                    icon={<CopyOutlined />}
                                    onClick={() => {
                                      navigator.clipboard?.writeText(m.content);
                                      message.success('已复制');
                                    }}
                                  >
                                    复制
                                  </Button>
                                </Tooltip>
                                <Tooltip title="保存为会话记忆，后续提问自动带入">
                                  <Button
                                    size="small"
                                    type="text"
                                    icon={<PushpinOutlined />}
                                    onClick={() => remember(m)}
                                  >
                                    记住
                                  </Button>
                                </Tooltip>
                                {m.serverId && (
                                  <Tooltip title="把回复中的执行动作一键生成待办任务（执行中心可跟进）">
                                    <Button
                                      size="small"
                                      type="text"
                                      icon={<CarryOutOutlined />}
                                      onClick={async () => {
                                        const out = await api.post(`/advisor/messages/${m.serverId}/to-tasks`);
                                        message.success(
                                          `已生成 ${out.created?.length || 0} 条待办，到「执行中心」跟进`,
                                        );
                                      }}
                                    >
                                      转任务
                                    </Button>
                                  </Tooltip>
                                )}
                                <ArtifactActions
                                  title={(lastQuestion || `${diagType}报告`).slice(0, 50)}
                                  content={m.content}
                                  sourceType="advisor"
                                  sourceId={m.serverId || m.id}
                                  onGenerated={refreshWorkspace}
                                />
                              </div>
                            )}
                          </>
                        )}
                      </div>
                      {m.role === 'user' && (
                        <Avatar size={28} style={{ background: 'var(--ui-text)', fontSize: 12, flexShrink: 0 }}>
                          {(user?.name || '我').slice(0, 1)}
                        </Avatar>
                      )}
                    </div>
                  ))}
                </div>
              </Panel>
            )}

            {/* 底部输入框 */}
            <Card size="small" styles={{ body: { padding: 12 } }} style={{ borderRadius: 10 }}>
              <TextArea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                autoSize={{ minRows: 2, maxRows: 5 }}
                placeholder={`请输入您想咨询的经营问题（当前：${diagType}），老板参谋将为您智能分析…`}
                style={{ border: 'none', boxShadow: 'none', padding: '4px 2px', fontSize: 13 }}
              />
              {draftNotice && (
                <div style={{ marginTop: 6, fontSize: 11.5, color: '#f6a02d' }}>
                  <BulbOutlined /> {draftNotice}
                </div>
              )}
              <div
                style={{
                  marginTop: 10,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <UnifiedFilePicker
                    compact
                    files={attachments}
                    onChange={setAttachments}
                    purpose="advisor"
                    maxFiles={6}
                    label="上传文件/图片"
                  />
                  <ToolChip icon={<DatabaseOutlined />} label="数据导入" onClick={importData} />
                  <ToolChip
                    icon={<AudioOutlined />}
                    label={listening ? '聆听中…' : '语音输入'}
                    active={listening}
                    onClick={toggleVoice}
                  />
                  <Tooltip title="开启后先实时检索全网资讯（行业动态/竞品/政策），检索结果注入会诊并附来源链接">
                    <span>
                      <ToolChip
                        icon={<GlobalOutlined />}
                        label={webOn ? '联网·已开' : '联网'}
                        active={webOn}
                        onClick={() => {
                          setWebOn(v => !v);
                          if (!webOn) message.success('已开启联网检索：会诊前将实时搜索全网资讯并标注来源');
                        }}
                      />
                    </span>
                  </Tooltip>
                  <Tooltip title="开启后升级到老板级模型(gpt-5.5)做五视角推演+依据链+反方观点，耗时与积分更高">
                    <span>
                      <ToolChip
                        icon={<ThunderboltOutlined />}
                        label={deepOn ? '深度思考·已开' : '深度思考'}
                        active={deepOn}
                        onClick={() => {
                          setDeepOn(v => !v);
                          if (!deepOn) message.success('已开启深度思考：升级 gpt-5.5 深度推演（消耗积分较高）');
                        }}
                      />
                    </span>
                  </Tooltip>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>Enter 开始诊断 / Shift+Enter 换行</span>
                  <Select
                    allowClear
                    placeholder="选择协同分部"
                    size="small"
                    style={{ width: 170 }}
                    value={ownerMarshal}
                    onChange={setOwnerMarshal}
                    options={(capability.networkStatus || []).map((n: any) => ({
                      value: n.code,
                      label: (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <Avatar
                            size={18}
                            src={n.avatar || undefined}
                            style={{ background: 'var(--ui-surface-2)', fontSize: 10 }}
                          >
                            {n.emoji}
                          </Avatar>
                          <span>{n.name}</span>
                        </span>
                      ),
                    }))}
                  />
                  <Button type="primary" icon={<SendOutlined />} loading={sending} onClick={() => send()}>
                    开始诊断
                  </Button>
                </div>
              </div>
            </Card>

            <Panel
              title={
                <>
                  <ThunderboltOutlined style={{ color: 'var(--ui-primary)' }} /> 数字员工分部快捷入口
                </>
              }
              extra={
                <button type="button" className="ui-link-button" onClick={() => nav('/employees')}>
                  查看60名员工
                </button>
              }
              style={{ height: 'auto' }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(132px,1fr))', gap: 8 }}>
                {(capability.networkStatus || []).map((marshal: any) => (
                  <button
                    key={marshal.id || marshal.code}
                    type="button"
                    aria-label={`调用${marshal.name}`}
                    onClick={() => nav(`/employees?group=${encodeURIComponent(marshal.name)}`)}
                    style={{
                      minWidth: 0,
                      minHeight: 54,
                      padding: '7px 9px',
                      border: '1px solid var(--ui-border)',
                      borderRadius: 7,
                      background: 'var(--ui-surface-2)',
                      color: 'var(--ui-text)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <Avatar
                      size={32}
                      src={marshal.avatar || undefined}
                      style={{ background: 'var(--ui-surface)', flexShrink: 0 }}
                    >
                      {marshal.emoji || 'AI'}
                    </Avatar>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span
                        style={{
                          display: 'block',
                          fontSize: 12.5,
                          fontWeight: 700,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {marshal.name}
                      </span>
                      <span
                        style={{
                          display: 'block',
                          marginTop: 2,
                          fontSize: 10.5,
                          color: 'var(--ui-muted)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {marshal.title || (marshal.running ? '执行中' : '在线待命')}
                      </span>
                    </span>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: marshal.online ? '#22c4a8' : 'var(--ui-muted)',
                        flexShrink: 0,
                      }}
                    />
                  </button>
                ))}
              </div>
            </Panel>
          </div>
        </Col>

        {/* ===== 右侧栏（1/3）===== */}
        <Col xs={24} lg={8}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* ① AI初步判断 */}
            <Panel
              title={
                <>
                  <BulbOutlined style={{ color: 'var(--ui-accent)' }} /> AI初步判断
                </>
              }
              style={{ height: 'auto' }}
              extra={
                stepActive === STEP_DONE ? (
                  <Tag color="success" style={{ fontSize: 11, margin: 0 }}>
                    已完成
                  </Tag>
                ) : stepActive >= 0 ? (
                  <Tag color="processing" style={{ fontSize: 11, margin: 0 }}>
                    分析中
                  </Tag>
                ) : (
                  <span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>待启动</span>
                )
              }
            >
              <Steps direction="vertical" size="small" items={stepItems} />
              {stepActive === -1 && (
                <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--ui-muted)', lineHeight: 1.7 }}>
                  请选择问题或输入问题；点击「开始诊断」后，右侧流程会逐步推进并显示本次会诊步骤。
                </div>
              )}
            </Panel>

            {/* ② 推荐协同分部 */}
            <Panel
              title={
                <>
                  <TeamOutlined style={{ color: '#8a7450' }} /> 推荐协同分部
                </>
              }
              style={{ height: 'auto' }}
              extra={
                recommended.length > 1 && (
                  <button
                    type="button"
                    className="ui-link-button"
                    style={{ fontSize: 12 }}
                    onClick={() =>
                      dispatchMarshals(
                        recommended.map((r: any) => r.code),
                        recommended.map((r: any) => r.name),
                      )
                    }
                  >
                    全部转派
                  </button>
                )
              }
            >
              {recommended.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--ui-muted)', textAlign: 'center', padding: '14px 0' }}>
                  发起会诊后，AI 将为您推荐适合协同的数字员工分部
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {recommended.map((r: any) => (
                    <div
                      key={r.code}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        background: 'var(--ui-surface-2)',
                        borderRadius: 8,
                        padding: '8px 10px',
                      }}
                    >
                      <Avatar
                        size={32}
                        src={r.avatar || undefined}
                        style={{ background: 'var(--ui-surface-2)', fontSize: 16, flexShrink: 0 }}
                      >
                        {r.emoji}
                      </Avatar>
                      <div
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 12.5,
                          fontWeight: 600,
                          color: 'var(--ui-text)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {r.name}
                      </div>
                      <Button
                        size="small"
                        type="primary"
                        ghost
                        style={{ fontSize: 11.5 }}
                        onClick={() => dispatchMarshals([r.code], [r.name])}
                      >
                        转派会诊
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            {/* ③ 最近会诊 */}
            <Panel
              title={
                <>
                  <HistoryOutlined style={{ color: '#f6a02d' }} /> 最近会诊
                </>
              }
              style={{ height: 'auto' }}
              extra={
                <button type="button" className="ui-link-button" style={{ fontSize: 12 }} onClick={newSession}>
                  <PlusOutlined /> 新会诊
                </button>
              }
            >
              {conversationsQ.loading || conversationsQ.error || conversationsQ.empty ? (
                <QueryStatus q={conversationsQ} emptyText="暂无会诊记录" height={80} />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 220, overflow: 'auto' }}>
                  {conversations.slice(0, 8).map((c: any) => (
                    <button
                      type="button"
                      key={c.id}
                      onClick={() => loadConversation(c)}
                      style={{
                        ...buttonResetStyle,
                        width: '100%',
                        textAlign: 'left',
                        padding: '7px 8px',
                        borderRadius: 8,
                        cursor: 'pointer',
                        background: c.id === conversationId ? 'var(--ui-surface-2)' : 'transparent',
                      }}
                    >
                      <div
                        style={{
                          fontSize: 12.5,
                          color: 'var(--ui-text)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontWeight: c.id === conversationId ? 600 : 400,
                        }}
                      >
                        {c.pinned ? <PushpinOutlined style={{ color: 'var(--ui-primary)', marginRight: 5 }} /> : null}
                        {c.title}
                      </div>
                      <div
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 3 }}
                      >
                        <Space size={4}>
                          <Tag color="blue" style={{ fontSize: 10.5, lineHeight: '15px', margin: 0 }}>
                            {c.diag_type}
                          </Tag>
                          <span style={{ fontSize: 10.5, color: 'var(--ui-muted)' }}>{c.msg_count || 0}条</span>
                        </Space>
                        <span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>
                          {(c.updated_at || c.created_at || '').replace('T', ' ').slice(5, 16)}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </Panel>

            {/* ④ 能力矩阵 */}
            <Panel
              title={
                <>
                  <RadarChartOutlined style={{ color: '#22c4a8' }} /> 能力矩阵
                </>
              }
              style={{ height: 'auto' }}
            >
              {capability.radar?.length ? (
                <Chart
                  height={210}
                  option={{
                    tooltip: { trigger: 'item' },
                    radar: {
                      indicator: capability.radar.map((r: any) => ({ name: r.name, max: 100 })),
                      radius: '64%',
                      axisName: { color: 'var(--ui-text-2)', fontSize: 11 },
                      splitArea: { areaStyle: { color: ['var(--ui-surface)', 'var(--ui-surface-2)'] } },
                      splitLine: { lineStyle: { color: 'var(--ui-surface)' } },
                      axisLine: { lineStyle: { color: 'var(--ui-surface)' } },
                    },
                    series: [
                      {
                        type: 'radar',
                        data: [
                          {
                            name: '能力评分',
                            value: capability.radar.map((r: any) => r.score),
                            areaStyle: { color: 'rgba(43,109,239,.22)' },
                            lineStyle: { color: 'var(--ui-accent)', width: 2 },
                            itemStyle: { color: 'var(--ui-accent)' },
                            symbolSize: 3,
                          },
                        ],
                      },
                    ],
                  }}
                />
              ) : (
                <QueryStatus q={capabilityQ} emptyText="暂无能力数据" height={210} />
              )}
            </Panel>

            {/* ⑤ 分部协同网络状态 */}
            <Panel
              title={
                <>
                  <ApartmentOutlined style={{ color: '#70757a' }} /> 数字员工分部协同状态
                </>
              }
              style={{ height: 'auto' }}
              extra={
                <span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>
                  在线 {onlineCount}/{networkStatus.length}
                </span>
              }
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {networkStatus.map((n: any) => (
                  <div
                    key={n.code}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      background: 'var(--ui-surface)',
                      borderRadius: 8,
                      padding: '6px 8px',
                    }}
                  >
                    <Avatar
                      size={22}
                      src={n.avatar || undefined}
                      style={{ background: 'var(--ui-surface-2)', fontSize: 11, flexShrink: 0 }}
                    >
                      {n.emoji}
                    </Avatar>
                    <span
                      style={{
                        flex: 1,
                        fontSize: 11.5,
                        color: 'var(--ui-text-2)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {n.name || ''}
                    </span>
                    {n.running ? (
                      <Tag color="processing" style={{ fontSize: 10, lineHeight: '15px', margin: 0, padding: '0 4px' }}>
                        运行中
                      </Tag>
                    ) : n.online ? (
                      <Tag color="success" style={{ fontSize: 10, lineHeight: '15px', margin: 0, padding: '0 4px' }}>
                        在线
                      </Tag>
                    ) : (
                      <Tag style={{ fontSize: 10, lineHeight: '15px', margin: 0, padding: '0 4px' }}>离线</Tag>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 10 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 11,
                    color: 'var(--ui-muted)',
                    marginBottom: 4,
                  }}
                >
                  <span>当前协同强度</span>
                  <span style={{ color: 'var(--ui-accent)', fontWeight: 600 }}>{synergyPct}%</span>
                </div>
                <Progress percent={synergyPct} showInfo={false} size="small" strokeColor="var(--ui-accent)" />
              </div>
            </Panel>
          </div>
        </Col>
      </Row>

      <Drawer
        title={
          <Space>
            <FolderOpenOutlined />
            产出档案与会话记忆
            <Badge count={artifacts.length + memories.length} />
          </Space>
        }
        width={560}
        open={workspaceOpen}
        onClose={() => setWorkspaceOpen(false)}
      >
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>可下载产出</div>
        <List
          size="small"
          dataSource={artifacts}
          locale={{
            emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="对回答点“生成文件”后会保存到这里" />,
          }}
          renderItem={(a: any) => (
            <List.Item
              actions={[
                <a key="download" href={safeUrl(a.file_url)} target="_blank" rel="noreferrer">
                  下载
                </a>,
                a.kb_doc_id ? (
                  <Tag key="archived" color="green">
                    已入档
                  </Tag>
                ) : (
                  <button type="button" key="archive" className="ui-link-button" onClick={() => archiveArtifact(a)}>
                    <FolderAddOutlined /> 入档
                  </button>
                ),
              ]}
            >
              <List.Item.Meta
                title={
                  <Space>
                    {a.title}
                    <Tag>{String(a.format).toUpperCase()}</Tag>
                  </Space>
                }
                description={`${(a.created_at || '').slice(0, 16)} · ${a.status || '可用'}`}
              />
            </List.Item>
          )}
        />
        <div style={{ fontSize: 13, fontWeight: 700, margin: '18px 0 8px' }}>已保存记忆</div>
        <List
          size="small"
          dataSource={memories}
          locale={{
            emptyText: (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="对关键回答点“记住”，后续对话会自动调用" />
            ),
          }}
          renderItem={(m: any) => (
            <List.Item>
              <List.Item.Meta
                title={m.title || '会话记忆'}
                description={
                  <div style={{ whiteSpace: 'pre-wrap', maxHeight: 92, overflow: 'hidden' }}>{m.content}</div>
                }
              />
            </List.Item>
          )}
        />
      </Drawer>
    </div>
  );
}
