import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Form,
  Input,
  Popconfirm,
  Select,
  Spin,
  Tag,
  Tooltip,
  Upload,
  message,
} from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  ImportOutlined,
  PlusOutlined,
  RobotOutlined,
  SendOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { api, getUser, notifyCredits } from '../api/client';
import { Markdown } from '../components/Markdown';
import { UnifiedFilePicker, type UploadedFileRef } from '../components/UnifiedFilePicker';
import './Agents.css';

/**
 * 我的智能体（B11）：自定义智能体的前端入口。
 * 后端 /api/agents/* 早已存在（CRUD、会话、对话、导出/导入），此前前端零调用。
 * 对话接口是普通 JSON（非 SSE），这里不做假流式；附件复用统一文件中心，费用走统一 billing。
 * 只暴露 agents.js 已支持的字段：name / emoji / tier / prompt / skills / persona。
 */

interface AgentRow {
  id: number;
  name: string;
  emoji: string;
  tier: 'simple' | 'normal' | 'expert';
  prompt: string;
  skills: string[];
  persona: string;
  creator_id: number;
  created_at: string;
  imported?: boolean;
  last_used_at?: string | null;
}

interface SessionRow {
  id: number;
  title: string;
  created_at: string;
  updated_at?: string | null;
  msg_count?: number;
}

interface ChatMessage {
  id: number | string;
  role: 'user' | 'assistant';
  content: string;
  loading?: boolean;
  model?: string;
  credits?: number;
  riskLevel?: string;
}

interface SkillOption {
  key: string;
  name: string;
  cat?: string;
}

interface ImportPreview {
  kind: 'nanowork_export' | 'prompt_workflow';
  agent: { name: string; emoji: string; tier: string; prompt: string; skills: string[]; persona: string };
  workflow: {
    name?: string;
    description?: string;
    steps?: { index: number; title: string; prompt: string }[];
    variables?: { key: string; label: string }[];
    undeclaredVariables?: string[];
  } | null;
}

const TIER_LABEL: Record<string, string> = { simple: '基础·仅提示词', normal: '进阶·+技能', expert: '专家·+技能+人设' };
const TIER_SKILL_LIMIT: Record<string, number> = { simple: 0, normal: 2, expert: 6 };

function purposeOf(agent: AgentRow) {
  const firstLine = String(agent.prompt || '')
    .split('\n')
    .map(line => line.trim())
    .find(Boolean);
  return firstLine || '（未填写用途）';
}

function fmtTime(value?: string | null) {
  return value ? String(value).slice(0, 16) : '';
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function Agents() {
  const user = getUser();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<UploadedFileRef[]>([]);
  const [sending, setSending] = useState(false);
  const [skills, setSkills] = useState<SkillOption[] | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AgentRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importError, setImportError] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [form] = Form.useForm();
  const tier = Form.useWatch('tier', form) as string | undefined;
  const chatRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(0);

  const selected = useMemo(() => agents.find(item => item.id === selectedId) || null, [agents, selectedId]);

  const loadAgents = useCallback(() => {
    setAgentsLoading(true);
    return api
      .get('/agents', { silent: true })
      .then((rows: AgentRow[]) => {
        const list = Array.isArray(rows) ? rows : [];
        setAgents(list);
        setSelectedId(current => (current && list.some(item => item.id === current) ? current : list[0]?.id || null));
      })
      .catch(() => {})
      .finally(() => setAgentsLoading(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      void loadAgents();
      // 技能库接口仅老板/管理员/平台超管可见；其余角色只能建“基础”档智能体。
      api
        .get('/marshals/skills/common', { silent: true })
        .then((rows: SkillOption[]) => setSkills(Array.isArray(rows) ? rows : []))
        .catch(() => setSkills([]));
    });
    return () => {
      cancelled = true;
    };
  }, [loadAgents]);

  const loadSessions = useCallback((agentId: number) => {
    const version = ++viewRef.current;
    setSessions([]);
    setSessionId(null);
    setMessages([]);
    api
      .get(`/agents/${agentId}/chats`, { silent: true })
      .then((rows: SessionRow[]) => {
        if (version === viewRef.current) setSessions(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    queueMicrotask(() => loadSessions(selectedId));
  }, [selectedId, loadSessions]);

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const openSession = (sid: number | null) => {
    const version = ++viewRef.current;
    setSessionId(sid);
    setMessages([]);
    if (!sid) return;
    api
      .get(`/agents/chats/${sid}/messages`, { silent: true })
      .then((rows: any[]) => {
        if (version !== viewRef.current) return;
        setMessages((rows || []).map(row => ({ id: row.id, role: row.role, content: row.content })));
      })
      .catch(() => {});
  };

  const send = async () => {
    const text = input.trim();
    if (!selected || sending || (!text && !attachments.length)) return;
    const version = viewRef.current;
    const loadingId = `pending-${Date.now()}`;
    setSending(true);
    setInput('');
    setMessages(prev => [
      ...prev,
      { id: `${loadingId}-user`, role: 'user', content: text || `（附件 ${attachments.length} 个）` },
      { id: loadingId, role: 'assistant', content: '', loading: true },
    ]);
    try {
      const res = await api.post(`/agents/${selected.id}/chat`, {
        message: text,
        sessionId: sessionId || undefined,
        fileIds: attachments.length ? attachments.map(file => file.id) : undefined,
      });
      setAttachments([]);
      if (res?.billing) {
        notifyCredits(res.billing.balance);
        if (Number(res.billing.credits) > 0) message.success(`本次对话消耗 ${res.billing.credits} 积分`);
      }
      if (version !== viewRef.current) return;
      if (res?.sessionId && res.sessionId !== sessionId) {
        setSessionId(Number(res.sessionId));
        api
          .get(`/agents/${selected.id}/chats`, { silent: true })
          .then((rows: SessionRow[]) => setSessions(Array.isArray(rows) ? rows : []))
          .catch(() => {});
      }
      setMessages(prev =>
        prev.map(item =>
          item.id === loadingId
            ? {
                id: res?.assistantMessageId || loadingId,
                role: 'assistant',
                content: res?.reply || '（暂无回复内容）',
                model: res?.model,
                credits: res?.billing?.credits,
                riskLevel: res?.risk?.level,
              }
            : item,
        ),
      );
    } catch {
      if (version === viewRef.current) setMessages(prev => prev.filter(item => item.id !== loadingId));
    } finally {
      setSending(false);
    }
  };

  const openEditor = (agent: AgentRow | null) => {
    setEditing(agent);
    form.setFieldsValue(
      agent
        ? {
            name: agent.name,
            emoji: agent.emoji,
            tier: agent.tier,
            prompt: agent.prompt,
            skills: agent.skills,
            persona: agent.persona,
          }
        : { name: '', emoji: '🤖', tier: 'simple', prompt: '', skills: [], persona: '' },
    );
    setEditorOpen(true);
  };

  const submitEditor = async () => {
    const values = await form.validateFields();
    const payload = {
      name: String(values.name || '').trim(),
      emoji: String(values.emoji || '🤖').trim(),
      tier: values.tier || 'simple',
      prompt: String(values.prompt || '').trim(),
      skills: values.tier === 'simple' ? [] : values.skills || [],
      persona: values.tier === 'expert' ? String(values.persona || '').trim() : '',
    };
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/agents/${editing.id}`, payload);
        message.success('智能体已更新');
      } else {
        const created = await api.post('/agents', payload);
        message.success('智能体已创建');
        await loadAgents();
        if (created?.id) setSelectedId(Number(created.id));
        setEditorOpen(false);
        return;
      }
      await loadAgents();
      setEditorOpen(false);
    } catch {
      /* 错误提示由 api 层统一弹出 */
    } finally {
      setSaving(false);
    }
  };

  const removeAgent = async (agent: AgentRow) => {
    await api.del(`/agents/${agent.id}`);
    message.success(`已删除「${agent.name}」`);
    await loadAgents();
  };

  const exportAgent = async (agent: AgentRow) => {
    const data = await api.get(`/agents/${agent.id}/export`);
    downloadJson(`${agent.name}.nanowork-agent.json`, data);
    message.success('已导出为本平台 JSON，可在其他企业账号导入');
  };

  const previewImport = async () => {
    setImportBusy(true);
    setImportError('');
    try {
      const res = await api.post('/agents/import/preview', { text: importText }, { silent: true });
      setImportPreview(res);
    } catch (error: any) {
      setImportPreview(null);
      setImportError(error?.message || '无法解析该工作流');
    } finally {
      setImportBusy(false);
    }
  };

  const confirmImport = async () => {
    setImportBusy(true);
    try {
      const res = await api.post('/agents/import', { text: importText });
      message.success(`已创建智能体「${res?.agent?.name || ''}」`);
      setImportOpen(false);
      setImportText('');
      setImportPreview(null);
      await loadAgents();
      if (res?.id) setSelectedId(Number(res.id));
    } catch {
      /* 错误提示由 api 层统一弹出 */
    } finally {
      setImportBusy(false);
    }
  };

  const readImportFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setImportText(String(reader.result || ''));
      setImportPreview(null);
      setImportError('');
    };
    reader.onerror = () => message.error('读取文件失败');
    reader.readAsText(file, 'utf-8');
    return false;
  };

  const skillLimit = TIER_SKILL_LIMIT[tier || 'simple'] || 0;
  const canConfigureSkills = (skills?.length || 0) > 0;
  const canManage = (agent: AgentRow) =>
    ['boss', 'admin'].includes(user?.role) || Number(agent.creator_id) === Number(user?.id);

  return (
    <div className="agents-page">
      <aside className="agents-side" aria-label="智能体列表">
        <div className="agents-side__head">
          <div className="agents-side__title">
            <RobotOutlined /> 我的智能体
          </div>
          <div className="agents-side__actions">
            <Tooltip title="导入工作流">
              <Button
                size="small"
                icon={<ImportOutlined />}
                aria-label="导入工作流"
                onClick={() => setImportOpen(true)}
              />
            </Tooltip>
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openEditor(null)}>
              新建
            </Button>
          </div>
        </div>
        <div className="agents-list">
          {agentsLoading && !agents.length ? (
            <div className="agents-empty">
              <Spin />
            </div>
          ) : agents.length === 0 ? (
            <div className="agents-empty">
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="还没有智能体。把分散在其他平台的工作流整理成提示词步骤，导入后就能在这里统一对话。"
              >
                <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor(null)}>
                  新建智能体
                </Button>
              </Empty>
            </div>
          ) : (
            agents.map(agent => (
              <button
                type="button"
                key={agent.id}
                className={`agents-list__item${agent.id === selectedId ? ' agents-list__item--active' : ''}`}
                aria-pressed={agent.id === selectedId}
                onClick={() => setSelectedId(agent.id)}
              >
                <span className="agents-list__emoji" aria-hidden="true">
                  {agent.emoji || '🤖'}
                </span>
                <span className="agents-list__body">
                  <span className="agents-list__name">
                    {agent.name}
                    {agent.imported && <Tag color="purple">导入</Tag>}
                  </span>
                  <span className="agents-list__purpose">{purposeOf(agent)}</span>
                  <span className="agents-list__meta">
                    {TIER_LABEL[agent.tier] || agent.tier}
                    {agent.skills?.length ? ` · 技能 ${agent.skills.length}` : ''}
                    {agent.last_used_at ? ` · 最近使用 ${fmtTime(agent.last_used_at)}` : ' · 尚未使用'}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="agents-main" aria-label="智能体对话">
        {selected ? (
          <>
            <div className="agents-main__head">
              <div className="agents-main__title">
                <span aria-hidden="true">{selected.emoji || '🤖'}</span>
                <span className="agents-main__title-name">{selected.name}</span>
                <Tag>{TIER_LABEL[selected.tier] || selected.tier}</Tag>
              </div>
              <div className="agents-main__actions">
                <Tooltip title="导出为本平台 JSON">
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    aria-label="导出智能体"
                    onClick={() => exportAgent(selected)}
                  />
                </Tooltip>
                {canManage(selected) && (
                  <>
                    <Button size="small" icon={<EditOutlined />} onClick={() => openEditor(selected)}>
                      编辑
                    </Button>
                    <Popconfirm
                      title={`删除「${selected.name}」？`}
                      description="历史会话记录一并不可再访问。"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => removeAgent(selected)}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} aria-label="删除智能体" />
                    </Popconfirm>
                  </>
                )}
              </div>
            </div>
            <div className="agents-sessions">
              <Select
                className="agents-sessions__select"
                placeholder="新对话（发送第一条消息后自动建会话）"
                value={sessionId ?? undefined}
                allowClear
                options={sessions.map(session => ({
                  value: session.id,
                  label: `${session.title || '未命名会话'} · ${session.msg_count ?? 0} 条 · ${fmtTime(session.updated_at || session.created_at)}`,
                }))}
                onChange={value => openSession(value ? Number(value) : null)}
              />
              <Button size="small" onClick={() => openSession(null)}>
                新对话
              </Button>
            </div>
            <div className="agents-chat" ref={chatRef}>
              {messages.length === 0 && (
                <div className="agents-chat__hint">
                  <b>用途：</b>
                  {purposeOf(selected)}
                  <br />
                  直接输入任务或问题；可附带文件。每次回复按实际模型与 token 计费，回复下方会显示本次消耗。
                </div>
              )}
              {messages.map(item => (
                <div key={item.id} className={`agents-msg agents-msg--${item.role}`}>
                  <div className="agents-msg__bubble">
                    {item.loading ? (
                      <Spin size="small" />
                    ) : item.role === 'assistant' ? (
                      <Markdown content={item.content} />
                    ) : (
                      <div className="agents-msg__text">{item.content}</div>
                    )}
                    {!item.loading && item.role === 'assistant' && (item.model || item.credits !== undefined) && (
                      <div className="agents-msg__meta">
                        {item.model && <Tag>{item.model}</Tag>}
                        {item.credits !== undefined && <Tag color="gold">{item.credits} 积分</Tag>}
                        {item.riskLevel && item.riskLevel !== 'none' && (
                          <Tag color="orange">风控：{item.riskLevel}</Tag>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="agents-composer">
              <UnifiedFilePicker files={attachments} onChange={setAttachments} purpose="chat" compact label="附件" />
              <div className="agents-composer__row">
                <Input.TextArea
                  className="agents-composer__input"
                  aria-label="发给智能体的消息"
                  value={input}
                  onChange={event => setInput(event.target.value)}
                  autoSize={{ minRows: 2, maxRows: 8 }}
                  maxLength={20000}
                  placeholder={`交给「${selected.name}」的任务…（Enter 发送，Shift+Enter 换行）`}
                  onPressEnter={event => {
                    if (event.shiftKey) return;
                    event.preventDefault();
                    void send();
                  }}
                />
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  loading={sending}
                  disabled={!input.trim() && !attachments.length}
                  onClick={() => void send()}
                >
                  发送
                </Button>
              </div>
              <div className="agents-composer__foot">
                <span>费用：按企业统一计费规则预扣、实结；失败自动退回。</span>
                <span>{sessionId ? `会话 #${sessionId}` : '新对话'}</span>
              </div>
            </div>
          </>
        ) : (
          <div className="agents-empty">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择左侧一个智能体开始对话，或新建 / 导入一个。" />
          </div>
        )}
      </section>

      <Drawer
        title={editing ? `编辑「${editing.name}」` : '新建智能体'}
        width={520}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        extra={
          <Button type="primary" loading={saving} onClick={() => void submitEditor()}>
            {editing ? '保存' : '创建'}
          </Button>
        }
      >
        <Form form={form} layout="vertical" initialValues={{ tier: 'simple', emoji: '🤖', skills: [] }}>
          <Form.Item label="名称" name="name" rules={[{ required: true, message: '请填写智能体名称' }, { max: 60 }]}>
            <Input placeholder="例如：新店开业筹备助手" />
          </Form.Item>
          <Form.Item label="图标（emoji）" name="emoji" rules={[{ max: 16 }]}>
            <Input placeholder="🤖" />
          </Form.Item>
          <Form.Item label="档位" name="tier">
            <Select
              options={[
                { value: 'simple', label: TIER_LABEL.simple },
                { value: 'normal', label: TIER_LABEL.normal, disabled: !canConfigureSkills },
                { value: 'expert', label: TIER_LABEL.expert, disabled: !canConfigureSkills },
              ]}
            />
          </Form.Item>
          {!canConfigureSkills && skills !== null && (
            <div className="agents-form__hint">技能库仅老板 / 系统管理员可配置，当前账号只能创建“基础”档智能体。</div>
          )}
          <Form.Item
            label="系统提示词（智能体的核心指令，第一句写清一句话用途）"
            name="prompt"
            rules={[{ required: true, message: '请填写提示词' }, { max: 20000 }]}
          >
            <Input.TextArea
              autoSize={{ minRows: 8, maxRows: 20 }}
              placeholder="第一行：这个智能体用来做什么。然后写清工作步骤、输出格式与禁止事项。"
            />
          </Form.Item>
          {tier && tier !== 'simple' && (
            <Form.Item
              label={`允许使用的技能（最多 ${skillLimit} 个）`}
              name="skills"
              rules={[{ type: 'array', max: skillLimit, message: `最多选择 ${skillLimit} 个技能` }]}
            >
              <Select
                mode="multiple"
                maxCount={skillLimit}
                options={(skills || []).map(skill => ({
                  value: skill.key,
                  label: `${skill.name}${skill.cat ? ` · ${skill.cat}` : ''}`,
                }))}
                placeholder="从企业技能库中选择"
              />
            </Form.Item>
          )}
          {tier === 'expert' && (
            <Form.Item label="人设（专家档）" name="persona" rules={[{ max: 8000 }]}>
              <Input.TextArea autoSize={{ minRows: 3, maxRows: 10 }} placeholder="说话风格、立场、专业背景…" />
            </Form.Item>
          )}
          <div className="agents-form__hint">
            知识库范围沿用企业知识库（按角色可见范围检索），不需要单独配置；模型由企业模型路由决定，回复下方会标明实际模型。
          </div>
        </Form>
      </Drawer>

      <Drawer title="导入工作流为智能体" width={640} open={importOpen} onClose={() => setImportOpen(false)}>
        <Alert
          className="agents-import__notice"
          type="info"
          showIcon
          message="支持本平台 JSON 与通用步骤式工作流 JSON"
          description={
            <>
              通用格式：<code>{'{ name, description, steps:[{ title, prompt }], variables:[{ key, label }] }'}</code>
              ，导入时会把步骤编译成一个带编号与变量占位说明的系统提示词。
              <br />
              扣子 / 火山 / 龙虾等平台的私有格式暂不直接兼容，请先在原平台把工作流导出或整理为上述提示词步骤再导入。
            </>
          }
        />
        <Upload.Dragger accept=".json,application/json" showUploadList={false} beforeUpload={readImportFile}>
          <p>
            <UploadOutlined /> 点击或拖入 JSON 文件
          </p>
        </Upload.Dragger>
        <Input.TextArea
          aria-label="粘贴工作流 JSON"
          className="agents-import__text"
          value={importText}
          onChange={event => {
            setImportText(event.target.value);
            setImportPreview(null);
            setImportError('');
          }}
          autoSize={{ minRows: 8, maxRows: 16 }}
          placeholder='或直接粘贴 JSON，例如：{"name":"新店开业筹备","steps":[{"title":"确认信息","prompt":"向用户确认 {{store_name}} 的开业日期"}],"variables":[{"key":"store_name","label":"门店名称"}]}'
        />
        {importError && <Alert className="agents-import__preview" type="error" showIcon message={importError} />}
        {importPreview && (
          <div className="agents-import__preview">
            <div className="agents-import__preview-title">
              {importPreview.agent.emoji} {importPreview.agent.name}
              <Tag color={importPreview.kind === 'prompt_workflow' ? 'purple' : 'blue'}>
                {importPreview.kind === 'prompt_workflow' ? '通用步骤式工作流' : '本平台导出'}
              </Tag>
              <Tag>{TIER_LABEL[importPreview.agent.tier] || importPreview.agent.tier}</Tag>
            </div>
            {importPreview.workflow?.description && (
              <div className="agents-form__hint">{importPreview.workflow.description}</div>
            )}
            {!!importPreview.workflow?.variables?.length && (
              <div className="agents-form__hint">
                变量：
                {importPreview.workflow.variables.map(item => (
                  <Tag key={item.key}>{`{{${item.key}}} ${item.label}`}</Tag>
                ))}
                {!!importPreview.workflow.undeclaredVariables?.length && (
                  <span>（步骤中出现但未声明的占位符已自动补进说明）</span>
                )}
              </div>
            )}
            {!!importPreview.workflow?.steps?.length && (
              <ol className="agents-import__steps">
                {importPreview.workflow.steps.map(step => (
                  <li key={step.index}>
                    <b>{step.title}</b>
                    <div className="agents-import__step-prompt">{step.prompt}</div>
                  </li>
                ))}
              </ol>
            )}
            <details>
              <summary>查看编译后的系统提示词</summary>
              <pre className="agents-import__prompt">{importPreview.agent.prompt}</pre>
            </details>
          </div>
        )}
        <div className="agents-import__actions">
          <Button
            disabled={!importText.trim()}
            loading={importBusy && !importPreview}
            onClick={() => void previewImport()}
          >
            预览步骤
          </Button>
          <Button
            type="primary"
            disabled={!importPreview}
            loading={importBusy && !!importPreview}
            onClick={() => void confirmImport()}
          >
            确认创建智能体
          </Button>
        </div>
      </Drawer>
    </div>
  );
}
