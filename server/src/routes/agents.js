import { Router } from 'express';
import { q, curTenant } from '../db.js';
import { logOp, safeJsonArray } from '../util.js';
import { marshalChat } from '../engines/ai.js';
import { applyChatRiskControl } from '../engines/risk.js';
import { recordKbCitations } from '../engines/rag.js';
import { precheckByRole, charge } from '../engines/credits.js';
import { directivesFor, skillByKey } from '../engines/skills.js';
import { attachmentRefsForStorage, rehydrateMessageHistory, resolveRequestedAttachments } from '../engines/filehub.js';
import { canAccessOwner, userScopeClause } from '../engines/access.js';

// ===== 自定义智能体（用户自建；三档：simple 提示词 / normal +技能 / expert +技能+人设）=====
const r = Router();
const TIERS = new Set(['simple', 'normal', 'expert']);
const MAX_MESSAGE_CHARS = 20000;
const MAX_INLINE_IMAGE_CHARS = 11_200_000;

function agentForUser(id, user) {
  const agent = q.get(`SELECT * FROM custom_agents WHERE tenant_id=? AND id=?`, curTenant(), id);
  return agent && canAccessOwner(user, agent.creator_id) ? agent : null;
}

function normalizedAgent(body, current = {}) {
  const tier = body.tier ?? current.tier ?? 'simple';
  if (!TIERS.has(tier)) throw Object.assign(new Error('智能体档位不正确'), { status: 400 });
  const name = String(body.name ?? current.name ?? '').trim();
  const prompt = String(body.prompt ?? current.prompt ?? '').trim();
  const emoji = String(body.emoji ?? current.emoji ?? '🤖').trim() || '🤖';
  const persona = tier === 'expert' ? String(body.persona ?? current.persona ?? '').trim() : '';
  const rawSkills = body.skills ?? safeJsonArray(current.skills);
  if (!Array.isArray(rawSkills)) throw Object.assign(new Error('智能体技能格式不正确'), { status: 400 });
  const skillLimit = tier === 'normal' ? 2 : tier === 'expert' ? 6 : 0;
  const requestedSkills = [...new Set(rawSkills.map(value => String(value).trim()).filter(Boolean))];
  const skills = tier === 'simple' ? [] : requestedSkills;
  if (skills.length > skillLimit) throw Object.assign(new Error(`${tier === 'normal' ? '普通' : '专家'}档最多配置${skillLimit}个技能`), { status: 400 });
  if (skills.some(key => !skillByKey(key))) throw Object.assign(new Error('智能体包含未知技能'), { status: 400 });
  if (!name) throw Object.assign(new Error('请填写智能体名称'), { status: 400 });
  if (!prompt) throw Object.assign(new Error('请填写提示词（智能体的核心指令）'), { status: 400 });
  if (name.length > 60 || emoji.length > 16 || prompt.length > 20000 || persona.length > 8000) {
    throw Object.assign(new Error('智能体配置超过长度上限'), { status: 400 });
  }
  return { name, emoji, tier, prompt, skills, persona };
}

// 本企业的智能体列表（custom_agents 已纳入租户隔离集，q.run 写入自动带 tenant_id）
r.get('/', (req, res) => {
  const scope = userScopeClause(req.user, 'creator_id');
  res.json(q.all(`SELECT id,name,emoji,tier,prompt,skills,persona,creator_id,created_at
    FROM custom_agents WHERE tenant_id=?${scope.sql} ORDER BY id DESC`, curTenant(), ...scope.params)
    .map(a => ({ ...a, skills: safeJsonArray(a.skills) })));
});

// 创建：simple 只用提示词；normal 提示词+最多2技能；expert 提示词+技能+人设
r.post('/', (req, res) => {
  try {
    const input = normalizedAgent(req.body || {});
    const out = q.run('INSERT INTO custom_agents(name,emoji,tier,prompt,skills,persona,creator_id) VALUES(?,?,?,?,?,?,?)',
      input.name, input.emoji, input.tier, input.prompt, JSON.stringify(input.skills), input.persona, req.user.id);
    logOp(req.user, '智能体', '创建智能体', input.name);
    res.json({ id: out.lastInsertRowid });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

r.put('/:id', (req, res) => {
  const current = agentForUser(req.params.id, req.user);
  if (!current) return res.status(404).json({ error: '智能体不存在或无权操作' });
  try {
    const input = normalizedAgent(req.body || {}, current);
    q.run(`UPDATE custom_agents SET name=?,emoji=?,tier=?,prompt=?,skills=?,persona=? WHERE tenant_id=? AND id=?`,
      input.name, input.emoji, input.tier, input.prompt, JSON.stringify(input.skills), input.persona, curTenant(), current.id);
    logOp(req.user, '智能体', '编辑智能体', `#${current.id}`);
    res.json({ ok: true });
  } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

r.delete('/:id', (req, res) => {
  const a = agentForUser(req.params.id, req.user);
  if (!a) return res.status(404).json({ error: '智能体不存在或无权操作' });
  q.run(`DELETE FROM custom_agents WHERE tenant_id=? AND id=?`, curTenant(), a.id);
  logOp(req.user, '智能体', '删除智能体', a.name);
  res.json({ ok: true });
});

r.get('/:id/chats', (req, res) => {
  const agent = agentForUser(req.params.id, req.user);
  if (!agent) return res.status(404).json({ error: '智能体不存在或无权访问' });
  res.json(q.all(`SELECT s.*,(SELECT COUNT(*) FROM custom_agent_chat_msgs m WHERE m.tenant_id=s.tenant_id AND m.session_id=s.id) msg_count
    FROM custom_agent_chat_sessions s WHERE s.tenant_id=? AND s.agent_id=? AND s.user_id=? ORDER BY COALESCE(s.updated_at,s.created_at) DESC LIMIT 30`,
    curTenant(), req.params.id, req.user.id));
});

r.get('/chats/:sid/messages', (req, res) => {
  const sess = q.get(`SELECT id FROM custom_agent_chat_sessions WHERE tenant_id=? AND id=? AND user_id=?`, curTenant(), req.params.sid, req.user.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  res.json(q.all(`SELECT id,role,content,attachments_json,created_at FROM custom_agent_chat_msgs WHERE tenant_id=? AND session_id=? ORDER BY id`, curTenant(), req.params.sid));
});

// 与智能体对话：把 提示词 + 人设 + 技能指令 合成 system，复用 marshalChat
r.post('/:id/chat', async (req, res) => {
  try {
    const a = agentForUser(req.params.id, req.user);
    if (!a) return res.status(404).json({ error: '智能体不存在或无权访问' });
    const { message, image, sessionId, fileIds } = req.body || {};
    const chatText = message == null ? '' : typeof message === 'string' ? message.trim() : null;
    if (chatText == null) return res.status(400).json({ error: '消息必须是文本' });
    if (chatText.length > MAX_MESSAGE_CHARS) return res.status(400).json({ error: '消息不能超过20000字' });
    if (image != null && typeof image !== 'string') return res.status(400).json({ error: '图片格式不支持' });
    if (image && !/^data:image\/(png|jpe?g|webp);base64,/.test(image)) return res.status(400).json({ error: '图片格式不支持' });
    if (image && image.length > MAX_INLINE_IMAGE_CHARS) return res.status(413).json({ error: '图片超过8MB，请压缩后重试' });
    const files = resolveRequestedAttachments(fileIds, req.user, 6);
    if (!chatText && !image && !files.length) return res.status(400).json({ error: '消息或附件不能为空' });
    precheckByRole(req.user.id, 'text', req.user.role);
    const skills = safeJsonArray(a.skills);
    const sysPrompt = `${a.prompt}${a.persona ? `\n\n【人设】${a.persona}` : ''}${directivesFor(skills)}`;
    const pseudo = { code: `cagent-${a.id}`, name: a.name, title: '自定义智能体', duty: a.name, prompt: sysPrompt, kb_deps: '' };
    let sid = Number(sessionId || 0);
    if (sessionId && (!Number.isInteger(sid) || sid <= 0)) return res.status(400).json({ error: '会话标识不正确' });
    if (sid) {
      const own = q.get(`SELECT id FROM custom_agent_chat_sessions WHERE tenant_id=? AND id=? AND user_id=? AND agent_id=?`, curTenant(), sid, req.user.id, a.id);
      if (!own) return res.status(404).json({ error: '会话不存在' });
    } else {
      const created = q.run(`INSERT INTO custom_agent_chat_sessions(agent_id,user_id,title) VALUES(?,?,?)`, a.id, req.user.id, (chatText || files[0]?.name || '新对话').slice(0, 40));
      sid = created.lastInsertRowid;
    }
    q.run(`INSERT INTO custom_agent_chat_msgs(session_id,role,content,attachments_json) VALUES(?,?,?,?)`, sid, 'user', chatText,
      files.length ? JSON.stringify(attachmentRefsForStorage(files)) : null);
    const history = rehydrateMessageHistory(q.all(`SELECT role,content,attachments_json FROM custom_agent_chat_msgs WHERE tenant_id=? AND session_id=?
      AND id < (SELECT MAX(id) FROM custom_agent_chat_msgs WHERE tenant_id=? AND session_id=?) ORDER BY id DESC LIMIT 12`, curTenant(), sid, curTenant(), sid).reverse(), req.user);
    const sess = q.get(`SELECT memory FROM custom_agent_chat_sessions WHERE tenant_id=? AND id=?`, curTenant(), sid) || {};
    const out = await marshalChat(pseudo, { message: chatText, originalMessage: chatText, history, role: req.user.role, image, skills,
      attachments: files, memory: sess.memory || '', signal: req.requestSignal });
    const bill = charge({ userId: req.user.id, feature: `智能体·${a.name}`, kind: 'text', model: out.model, usage: out.usage, aiMode: out.mode });
    const msg = q.run(`INSERT INTO custom_agent_chat_msgs(session_id,role,content) VALUES(?,?,?)`, sid, 'assistant', out.text);
    // AI-H1：自定义智能体输出与内容生产仓同口径过风控（标记+进审批）；AI-C2：引用的知识文档落库可溯源
    const risk = applyChatRiskControl({ targetType: 'custom_agent_msg', targetId: msg.lastInsertRowid, title: `智能体输出：${a.name}`, text: out.text, submitterId: req.user.id });
    recordKbCitations({ targetType: 'custom_agent_msg', targetId: msg.lastInsertRowid, kb: out.kb });
    q.run(`UPDATE custom_agent_chat_sessions SET updated_at=datetime('now','localtime') WHERE id=?`, sid);
    logOp(req.user, '智能体', '智能体对话', a.name);
    res.json({ sessionId: sid, assistantMessageId: msg.lastInsertRowid, reply: out.text, mode: out.mode, model: out.model, billing: bill, risk, kb: out.kb });
  } catch (e) {
    if (!req.requestSignal?.aborted && !res.headersSent) res.status(e.status || 500).json({ error: e.message, requestId: req.requestId });
  }
});

export default r;
