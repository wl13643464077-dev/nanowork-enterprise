import { Router } from 'express';
import { db, q, curTenant } from '../db.js';
import { logOp, safeJsonArray } from '../util.js';
import { marshalChat } from '../engines/ai.js';
import { applyChatRiskControl } from '../engines/risk.js';
import { recordKbCitations } from '../engines/rag.js';
import {
  precheckByRole,
  estimateCallCredits,
  holdCredits,
  settleHold,
} from '../engines/credits.js';
import { routing, textModelFor } from '../engines/yunwu.js';
import { executeHeldDelivery, withImmediateTransaction } from '../engines/two-phase-delivery.js';
import { directivesFor, skillByKey } from '../engines/skills.js';
import { attachmentRefsForStorage, rehydrateMessageHistory, resolveRequestedAttachments } from '../engines/filehub.js';
import { canAccessOwner, userScopeClause } from '../engines/access.js';
import {
  aiFailurePayload,
  aiFailureReleaseNote,
  assertRealAiOutput,
  releaseFailedAiHold,
} from '../engines/ai-delivery-status.js';
import {
  exportCustomAgent,
  parseAgentImport,
  sourceWorkflowEnvelope,
} from '../engines/agent-workflow-import.js';

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
// last_used_at 取该用户在该智能体下最近一次会话时间，用于“最近使用”排序展示。
r.get('/', (req, res) => {
  const scope = userScopeClause(req.user, 'a.creator_id');
  res.json(q.all(`SELECT a.id,a.name,a.emoji,a.tier,a.prompt,a.skills,a.persona,a.creator_id,a.created_at,
      (a.source_workflow IS NOT NULL) imported,
      (SELECT MAX(COALESCE(s.updated_at,s.created_at)) FROM custom_agent_chat_sessions s
        WHERE s.tenant_id=a.tenant_id AND s.agent_id=a.id AND s.user_id=?) last_used_at
    FROM custom_agents a WHERE a.tenant_id=?${scope.sql} ORDER BY a.id DESC`,
  req.user.id, curTenant(), ...scope.params)
    .map(a => ({ ...a, imported: Number(a.imported) === 1, skills: safeJsonArray(a.skills) })));
});

// 导出：不含租户/创建者等内部字段，可直接再导入本平台。
r.get('/:id/export', (req, res) => {
  const agent = agentForUser(req.params.id, req.user);
  if (!agent) return res.status(404).json({ error: '智能体不存在或无权访问' });
  logOp(req.user, '智能体', '导出智能体', agent.name);
  res.json(exportCustomAgent(agent));
});

// 导入预览：只解析与编译，不落库；前端“预览步骤 → 确认创建”的第一步。
function importSourceOf(body) {
  if (body && typeof body === 'object' && body.payload !== undefined) return body.payload;
  if (body && typeof body === 'object' && body.text !== undefined) return body.text;
  return body;
}

r.post('/import/preview', (req, res) => {
  try {
    const parsed = parseAgentImport(importSourceOf(req.body));
    const input = normalizedAgent(parsed.agent);
    res.json({ kind: parsed.kind, agent: input, workflow: parsed.workflow });
  } catch (error) { res.status(error.status || 500).json({ error: error.message, code: error.code }); }
});

// 导入：支持本平台导出 JSON 与通用步骤式工作流 JSON；原始 JSON 存 source_workflow 便于回溯。
r.post('/import', (req, res) => {
  try {
    const parsed = parseAgentImport(importSourceOf(req.body));
    const override = req.body && typeof req.body === 'object' && typeof req.body.name === 'string' && req.body.name.trim()
      ? { name: req.body.name.trim() }
      : {};
    const input = normalizedAgent({ ...parsed.agent, ...override });
    const out = q.run(
      'INSERT INTO custom_agents(name,emoji,tier,prompt,skills,persona,creator_id,source_workflow) VALUES(?,?,?,?,?,?,?,?)',
      input.name, input.emoji, input.tier, input.prompt, JSON.stringify(input.skills), input.persona, req.user.id,
      sourceWorkflowEnvelope(parsed, { importedBy: req.user.id }),
    );
    logOp(req.user, '智能体', '导入智能体', `${input.name}（${parsed.kind}）`);
    res.json({ id: out.lastInsertRowid, kind: parsed.kind, agent: input, workflow: parsed.workflow });
  } catch (error) { res.status(error.status || 500).json({ error: error.message, code: error.code }); }
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
  let retrySessionId = null;
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
    retrySessionId = Number(sid);
    q.run(`INSERT INTO custom_agent_chat_msgs(session_id,role,content,attachments_json) VALUES(?,?,?,?)`, sid, 'user', chatText,
      files.length ? JSON.stringify(attachmentRefsForStorage(files)) : null);
    const history = rehydrateMessageHistory(q.all(`SELECT role,content,attachments_json FROM custom_agent_chat_msgs WHERE tenant_id=? AND session_id=?
      AND id < (SELECT MAX(id) FROM custom_agent_chat_msgs WHERE tenant_id=? AND session_id=?) ORDER BY id DESC LIMIT 12`, curTenant(), sid, curTenant(), sid).reverse(), req.user);
    const sess = q.get(`SELECT memory FROM custom_agent_chat_sessions WHERE tenant_id=? AND id=?`, curTenant(), sid) || {};
    const holdModel = image ? routing().vision : textModelFor(req.user.role);
    const hold = holdCredits({
      userId: req.user.id,
      feature: `智能体·${a.name}`,
      kind: 'text',
      model: holdModel,
      credits: estimateCallCredits({
        kind: 'text',
        model: holdModel,
        texts: [
          sysPrompt,
          chatText,
          sess.memory,
          ...history.map(item => item.content),
          ...files.map(file => file.content),
          image || '',
        ],
        outputTokens: 1800,
      }),
      refType: 'custom_agent_session',
      refId: Number(sid),
      note: `自定义智能体#${a.id}会话#${sid}在供应商调用前预授权；助手消息未落库则全额退回。`,
    });
    const delivered = await executeHeldDelivery({
      hold,
      generate: async () => {
        const output = await marshalChat(pseudo, {
          message: chatText,
          originalMessage: chatText,
          history,
          role: req.user.role,
          image,
          skills,
          attachments: files,
          memory: sess.memory || '',
          signal: req.requestSignal,
          // 自定义智能体经常承担完整任务，不应沿用普通闲聊的 85 秒上限。
          timeoutMs: 180000,
        });
        // 模板、空文本、模板模型或零 token 都不是真实交付。
        // 抛错会由两阶段交付释放预授权，且不会落助手消息。
        assertRealAiOutput(output, {
          label: `智能体「${a.name}」`,
          noDelivery: '本次未保存助手回复',
        });
        return output;
      },
      persist: out => withImmediateTransaction(db, () => {
        const msg = q.run(
          `INSERT INTO custom_agent_chat_msgs(session_id,role,content) VALUES(?,?,?)`,
          sid,
          'assistant',
          out.text,
        );
        // AI-H1：自定义智能体输出与内容生产仓同口径过风控（标记+进审批）；
        // AI-C2：引用的知识文档与助手消息在同一业务事务内落库，失败即整单退回。
        const risk = applyChatRiskControl({
          targetType: 'custom_agent_msg',
          targetId: msg.lastInsertRowid,
          title: `智能体输出：${a.name}`,
          text: out.text,
          submitterId: req.user.id,
        });
        recordKbCitations({
          targetType: 'custom_agent_msg',
          targetId: msg.lastInsertRowid,
          kb: out.kb,
        });
        q.run(`UPDATE credit_holds SET ref_type='custom_agent_msg',ref_id=?
          WHERE tenant_id=? AND id=? AND status='held'`, Number(msg.lastInsertRowid), curTenant(), hold.holdId);
        q.run(
          `UPDATE custom_agent_chat_sessions SET updated_at=datetime('now','localtime') WHERE id=?`,
          sid,
        );
        return { assistantMessageId: Number(msg.lastInsertRowid), risk };
      }),
      settle: settleHold,
      release: releaseFailedAiHold,
      settlement: out => ({
        usage: out.usage,
        model: out.model,
        aiMode: out.mode,
        note: '智能体助手消息、风控与引用证据已完成业务落库',
      }),
      releaseNote: aiFailureReleaseNote(`智能体「${a.name}」`),
    });
    try {
      logOp(req.user, '智能体', '智能体对话', a.name);
    } catch (logError) {
      console.error('[custom-agent] 操作日志写入失败:', logError?.message);
    }
    res.json({
      sessionId: sid,
      assistantMessageId: delivered.delivery.assistantMessageId,
      reply: delivered.output.text,
      mode: delivered.output.mode,
      model: delivered.output.model,
      usage: delivered.output.usage,
      aiStatus: 'succeeded',
      deliveryState: 'succeeded',
      retryable: false,
      billing: delivered.billing,
      risk: delivered.delivery.risk,
      kb: delivered.output.kb,
    });
  } catch (e) {
    if (!req.requestSignal?.aborted && !res.headersSent) {
      res.status(e.status || 500).json(aiFailurePayload(e, {
        requestId: req.requestId,
        extra: retrySessionId ? { sessionId: retrySessionId } : {},
      }));
    }
  }
});

export default r;
