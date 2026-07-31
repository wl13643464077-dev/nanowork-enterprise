import { Router } from 'express';
import { db, q, curTenant, mergeMarshal, mergeMarshals } from '../db.js';
import { logOp, daysAgo, monthStart, pct } from '../util.js';
import { advisorReply } from '../engines/ai.js';
import { applyChatRiskControl } from '../engines/risk.js';
import { recordKbCitations } from '../engines/rag.js';
import { funnel } from '../engines/scoring.js';
import { healthScore } from '../engines/health.js';
import { nextFestival } from '../engines/plans.js';
import { precheckByRole, estimateCallCredits, holdCredits, settleHold, releaseHold } from '../engines/credits.js';
import { textModelFor, routing } from '../engines/yunwu.js';
import { webSearch } from '../engines/websearch.js';
import { attachmentRefsForStorage, rehydrateMessageHistory, resolveAttachments } from '../engines/filehub.js';
import { userScopeClause } from '../engines/access.js';
import {
  executeHeldDelivery,
  twoPhaseBillingSummary,
  withImmediateTransaction,
} from '../engines/two-phase-delivery.js';

const r = Router();

function dataSummary() {
  const ops = q.get(`SELECT SUM(new_leads) leads, SUM(invited) invited, SUM(arrived) arrived, SUM(deals) deals, SUM(deal_amount) amount
    FROM daily_ops WHERE tenant_id = ${curTenant()} AND date >= ?`, daysAgo(30)) || {};
  const orderFacts = q.get(`SELECT COUNT(*) deals, COALESCE(SUM(amount),0) amount FROM orders
    WHERE tenant_id = ${curTenant()} AND created_at >= ?`, daysAgo(30)) || {};
  const leadFacts = q.get(`SELECT COUNT(*) leads FROM leads WHERE tenant_id = ${curTenant()} AND created_at >= ?`, daysAgo(30)) || {};
  const goal = q.get(`SELECT revenue_target FROM goals WHERE tenant_id = ${curTenant()} AND period = ?`, monthStart().slice(0, 7)) || {};
  const monthOrders = q.get(`SELECT COALESCE(SUM(amount),0) a FROM orders WHERE tenant_id = ${curTenant()} AND created_at >= ?`, monthStart())?.a || 0;
  const monthOps = q.get(`SELECT SUM(deal_amount) a FROM daily_ops WHERE tenant_id = ${curTenant()} AND date >= ?`, monthStart())?.a || 0;
  const mAmount = monthOrders || monthOps;
  const { bottleneck } = funnel();
  return {
    leads: leadFacts.leads || ops.leads || 0, invited: ops.invited || 0, arrived: ops.arrived || 0,
    deals: orderFacts.deals || ops.deals || 0, amount: orderFacts.amount || ops.amount || 0,
    revenueRate: pct(mAmount, goal.revenue_target || 500000),
    convRate: pct(ops.deals || 0, ops.leads || 0),
    partnerRate: healthScore().subs.find(s => s.key === 'partner')?.note?.match(/[\d.]+/)?.[0] || 0,
    aCount: q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()} AND grade='A' AND stage NOT IN ('已成交','复购','已流失')`)?.n || 0,
    pendingApprovals: q.get(`SELECT COUNT(*) n FROM approvals WHERE tenant_id = ${curTenant()} AND status='待审核'`)?.n || 0,
    bottleneck, festival: nextFestival(30)?.theme,
  };
}

r.get('/suggested', (req, res) => {
  const s = dataSummary();
  const qs = [
    `本月营收完成率只有 ${s.revenueRate}%，最快的追赶路径是什么？`,
    s.bottleneck ? `漏斗卡在「${s.bottleneck}」环节，怎么破？` : '当前漏斗哪个环节值得加大投入？',
    s.festival ? `${s.festival}这一仗该怎么打？` : '下个节日战役如何提前布局？',
    `${s.aCount} 个A类客户，先攻哪几个？`,
  ];
  res.json({ questions: qs, summary: s });
});

r.get('/conversations', (req, res) => {
  res.json(q.all(`SELECT c.*,(SELECT COUNT(*) FROM ai_messages m WHERE m.tenant_id=c.tenant_id AND m.conversation_id=c.id) msg_count
    FROM ai_conversations c WHERE c.tenant_id = ${curTenant()} AND c.user_id = ?
    ORDER BY COALESCE(c.pinned,0) DESC,COALESCE(c.updated_at,c.created_at) DESC LIMIT 30`, req.user.id));
});
r.get('/conversations/:id/messages', (req, res) => {
  const sess = q.get(`SELECT id FROM ai_conversations WHERE tenant_id = ${curTenant()} AND user_id = ? AND id = ?`, req.user.id, req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  // 必须同时校验 tenant_id + user_id：否则传入任意 conversation_id 可读到同企业或别家企业的对话消息（越权/IDOR）
  res.json(q.all(`SELECT * FROM ai_messages WHERE tenant_id = ${curTenant()} AND conversation_id = ? ORDER BY id`, req.params.id));
});

r.put('/conversations/:id', (req, res) => {
  const sess = q.get(`SELECT * FROM ai_conversations WHERE tenant_id=? AND user_id=? AND id=?`, curTenant(), req.user.id, req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  const { title, pinned, memory } = req.body || {};
  if (title !== undefined) q.run(`UPDATE ai_conversations SET title=?,updated_at=datetime('now','localtime') WHERE id=?`, String(title).trim().slice(0, 60) || sess.title, sess.id);
  if (pinned !== undefined) q.run(`UPDATE ai_conversations SET pinned=?,updated_at=datetime('now','localtime') WHERE id=?`, pinned ? 1 : 0, sess.id);
  if (memory !== undefined) q.run(`UPDATE ai_conversations SET memory=?,updated_at=datetime('now','localtime') WHERE id=?`, String(memory).slice(0, 8000), sess.id);
  res.json(q.get(`SELECT * FROM ai_conversations WHERE tenant_id=? AND id=?`, curTenant(), sess.id));
});

r.get('/memories', (req, res) => {
  res.json(q.all(`SELECT * FROM conversation_memories WHERE tenant_id=? AND user_id=? AND scope='advisor' ORDER BY pinned DESC,id DESC LIMIT 100`, curTenant(), req.user.id));
});

r.post('/conversations/:id/memory', (req, res) => {
  const sess = q.get(`SELECT * FROM ai_conversations WHERE tenant_id=? AND user_id=? AND id=?`, curTenant(), req.user.id, req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: '记忆内容不能为空' });
  const title = String(req.body?.title || sess.title || '会话记忆').slice(0, 80);
  const out = q.run(`INSERT INTO conversation_memories(user_id,scope,session_id,title,content,tags) VALUES(?,?,?,?,?,?)`,
    req.user.id, 'advisor', sess.id, title, content.slice(0, 6000), JSON.stringify(req.body?.tags || []));
  const combined = [sess.memory, content].filter(Boolean).join('\n---\n').slice(-8000);
  q.run(`UPDATE ai_conversations SET memory=?,updated_at=datetime('now','localtime') WHERE id=?`, combined, sess.id);
  logOp(req.user, '老板参谋', '保存会话记忆', title);
  res.json({ id: out.lastInsertRowid, memory: combined });
});

const ADVISOR_WEB_RESULT_LIMIT = 5;
const ADVISOR_WEB_FIELD_LIMITS = Object.freeze({
  title: 200,
  snippet: 160,
  url: 1024,
});
// hold 必须先于联网检索，因此按路由真正允许注入的最坏字段长度预留联网上下文；
// 检索完成后仍会用同一组边界截断，保证实际发送内容不超过预授权口径。
const ADVISOR_WEB_HOLD_RESERVE = '网'.repeat(
  ADVISOR_WEB_RESULT_LIMIT * Object.values(ADVISOR_WEB_FIELD_LIMITS)
    .reduce((total, value) => total + value, 0),
);

function normalizeAdvisorWebResults(results) {
  if (!Array.isArray(results)) return [];
  return results.slice(0, ADVISOR_WEB_RESULT_LIMIT).map(item => ({
    title: String(item?.title || '').trim().slice(0, ADVISOR_WEB_FIELD_LIMITS.title),
    snippet: String(item?.snippet || '').replace(/\s+/g, ' ').trim()
      .slice(0, ADVISOR_WEB_FIELD_LIMITS.snippet),
    url: String(item?.url || '').trim().slice(0, ADVISOR_WEB_FIELD_LIMITS.url),
  })).filter(item => item.title && item.url);
}

const ADVISOR_CHAT_DEPS = Object.freeze({
  advisorReplyFn: advisorReply,
  applyChatRiskControlFn: applyChatRiskControl,
  estimateCallCreditsFn: estimateCallCredits,
  holdCreditsFn: holdCredits,
  precheckByRoleFn: precheckByRole,
  recordKbCitationsFn: recordKbCitations,
  releaseHoldFn: releaseHold,
  settleHoldFn: settleHold,
  webSearchFn: webSearch,
});

export function createAdvisorChatHandler(overrides = {}) {
  const deps = { ...ADVISOR_CHAT_DEPS, ...overrides };
  return async (req, res) => {
    let hold = null;
    let sendEvent = null;
    try {
      const { conversationId, attachments, fileIds } = req.body || {};
      if (typeof req.body?.question !== 'string') return res.status(400).json({ error: '问题必须是文本' });
      const question = req.body.question.trim();
      if (!question) return res.status(400).json({ error: '问题不能为空' });
      if (question.length > 12000) return res.status(400).json({ error: '问题最长12000字' });
      const diagType = typeof req.body?.diagType === 'string' && req.body.diagType.trim()
        ? req.body.diagType.trim().slice(0, 40) : '经营诊断';
      const marshalCode = req.body?.marshalCode == null ? '' : String(req.body.marshalCode).trim();
      if (marshalCode && !/^M-\d{2}$/.test(marshalCode)) return res.status(400).json({ error: '数字员工分部编号格式不正确' });
      const marshalRow = marshalCode
        ? q.get('SELECT * FROM marshals WHERE code = ? AND online = 1', marshalCode)
        : null;
      if (marshalCode && !marshalRow) return res.status(404).json({ error: '数字员工分部不存在' });
      const useWeb = req.body?.web === true;
      const useDeep = req.body?.deep === true;
      const useStream = req.body?.stream === true;

      if (conversationId !== undefined && conversationId !== null && conversationId !== '') {
        const parsed = Number(conversationId);
        if (!Number.isInteger(parsed) || parsed <= 0) return res.status(400).json({ error: '会话编号格式不正确' });
      }
      let cid = Number(conversationId || 0);
      if (cid) {
        const current = q.get(
          `SELECT id FROM ai_conversations
           WHERE tenant_id = ${curTenant()} AND user_id = ? AND id = ?`,
          req.user.id,
          cid,
        );
        if (!current) return res.status(404).json({ error: '会话不存在' });
      }

      if (fileIds !== undefined && !Array.isArray(fileIds)) return res.status(400).json({ error: '文件列表格式不正确' });
      const requestedFileIds = [...new Set((fileIds || []).map(Number))];
      if (requestedFileIds.length > 6 || requestedFileIds.some(id => !Number.isInteger(id) || id <= 0)) {
        return res.status(400).json({ error: '一次最多引用6个有效文件' });
      }
      const resolvedFiles = resolveAttachments(requestedFileIds, req.user, 6);
      if (resolvedFiles.length !== requestedFileIds.length) {
        return res.status(404).json({ error: '部分文件不存在或无权访问' });
      }
      if (attachments !== undefined && !Array.isArray(attachments)) {
        return res.status(400).json({ error: '附件内容格式不正确' });
      }
      if ((attachments || []).length > 3) return res.status(400).json({ error: '一次最多提交3个内嵌附件' });
      const inlineAttachments = (attachments || []).map((attachment, index) => {
        if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
          throw Object.assign(new Error(`第${index + 1}个附件格式不正确`), { status: 400 });
        }
        const name = typeof attachment.name === 'string'
          ? attachment.name.trim().slice(0, 200)
          : '';
        if (!name) throw Object.assign(new Error(`第${index + 1}个附件缺少文件名`), { status: 400 });
        if (typeof attachment.content !== 'string') {
          throw Object.assign(new Error(`第${index + 1}个附件内容必须是文本`), { status: 400 });
        }
        return { name, content: attachment.content.slice(0, 16000) };
      });
      const allAttachments = [...resolvedFiles, ...inlineAttachments].slice(0, 6);
      const history = cid
        ? rehydrateMessageHistory(q.all(
          `SELECT role,content,attachments_json FROM ai_messages
           WHERE tenant_id=? AND conversation_id=?
           ORDER BY id DESC LIMIT 12`,
          curTenant(),
          cid,
        ).reverse(), req.user)
        : [];
      const sess = cid
        ? q.get(
          `SELECT memory,summary FROM ai_conversations
           WHERE tenant_id=? AND id=?`,
          curTenant(),
          cid,
        ) || {}
        : {};
      const sharedMemory = q.all(
        `SELECT content FROM conversation_memories
         WHERE tenant_id=? AND user_id=? AND scope='advisor'
           AND (session_id=? OR session_id IS NULL) AND pinned=1
         ORDER BY id DESC LIMIT 8`,
        curTenant(),
        req.user.id,
        cid || -1,
      ).map(item => item.content).reverse().join('\n');
      const memoryText = [sess.summary, sess.memory, sharedMemory].filter(Boolean).join('\n');
      const s = dataSummary();
      const recCodes = s.bottleneck === '已成交'
        ? ['M-05', 'M-07']
        : s.bottleneck === '已邀约' || s.bottleneck === '已到店'
          ? ['M-06', 'M-05']
          : ['M-06', 'M-07'];
      const marshalCatalog = mergeMarshals(q.all(
        'SELECT id,code,name,title,emoji,avatar FROM marshals WHERE online = 1 ORDER BY sort',
      ));
      const marshalByCode = new Map(marshalCatalog.map(item => [item.code, item]));
      const recommended = recCodes.map(code => marshalByCode.get(code)).filter(Boolean);
      const marshal = marshalRow ? mergeMarshal(marshalRow) : null;
      const feature = [
        marshal ? `老板参谋会诊·${marshal.name}` : '老板参谋诊断',
        useWeb ? '联网' : null,
        useDeep ? '深度思考' : null,
      ].filter(Boolean).join('·');
      const holdModel = useDeep ? routing().deepThink : textModelFor(req.user.role);

      // 所有联网、RAG 和模型供应商调用之前，先按本轮实际上下文与联网最坏边界完成预授权。
      deps.precheckByRoleFn(req.user.id, 'text', useDeep ? 'boss' : req.user.role);
      hold = deps.holdCreditsFn({
        userId: req.user.id,
        feature,
        kind: 'text',
        model: holdModel,
        credits: deps.estimateCallCreditsFn({
          model: holdModel,
          outputTokens: useDeep ? 8000 : 4000,
          texts: [
            question,
            ...allAttachments.map(item => String(item.content || '').slice(0, 4000)),
            ...history.map(item => item.content),
            memoryText.slice(0, 5000),
            useWeb ? ADVISOR_WEB_HOLD_RESERVE : '',
          ],
        }),
        refType: cid ? 'advisor_conversation' : null,
        refId: cid || null,
      });

      // 预授权成功后才记录本轮输入；输入事务失败同样属于未交付，外层会全额释放占扣。
      withImmediateTransaction(db, () => {
        if (!cid) {
          const created = q.run(
            'INSERT INTO ai_conversations(user_id,title,diag_type) VALUES(?,?,?)',
            req.user.id,
            question.slice(0, 24),
            diagType,
          );
          cid = Number(created.lastInsertRowid);
        }
        q.run(
          `INSERT INTO ai_messages(conversation_id,role,content,attachments_json)
           VALUES(?,?,?,?)`,
          cid,
          'user',
          `${question}${allAttachments.length ? `\n[附件×${allAttachments.length}: ${allAttachments.map(item => item.name).join('、')}]` : ''}${useWeb ? '\n[联网检索已开启]' : ''}${useDeep ? '\n[深度思考已开启]' : ''}`,
          allAttachments.length ? JSON.stringify(attachmentRefsForStorage(allAttachments)) : null,
        );
        q.run(
          `UPDATE credit_holds SET ref_type='advisor_conversation',ref_id=?
           WHERE tenant_id=? AND id=? AND status='held'`,
          cid,
          curTenant(),
          hold.holdId,
        );
      });

      // SSE 仅先建立通道；模型增量在服务端缓冲。助手消息、风控、引用与摘要事务成功前，
      // 不把正文交付客户端，避免“答案已看见但业务落库失败后退款”。
      let bufferedText = '';
      if (useStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        sendEvent = object => {
          if (!res.writableEnded) res.write(`data: ${JSON.stringify(object)}\n\n`);
        };
      }

      const deliveryHold = hold;
      hold = null;
      const delivered = await executeHeldDelivery({
        hold: deliveryHold,
        generate: async () => {
          let webRefs = [];
          let webNote = null;
          if (useWeb) {
            const search = await deps.webSearchFn(`${question} 餐饮门店 行业`);
            webRefs = normalizeAdvisorWebResults(search?.results);
            webNote = search?.note || null;
          }
          const output = await deps.advisorReplyFn({
            diagType,
            question,
            dataSummary: s,
            role: req.user.role,
            marshal,
            attachments: allAttachments,
            webRefs,
            deep: useDeep,
            history,
            memory: memoryText,
            marshalCatalog,
            recommendedMarshals: recommended,
            signal: req.requestSignal,
            onDelta: useStream ? (text => { bufferedText += String(text || ''); }) : undefined,
            onReset: useStream ? (() => { bufferedText = ''; }) : undefined,
          });
          return { ...output, webRefs, webNote };
        },
        persist: output => withImmediateTransaction(db, () => {
          const assistantText = output.text + (output.webRefs.length
            ? `\n\n📎 联网来源：\n${output.webRefs.map((item, index) => `[${index + 1}] ${item.title} ${item.url}`).join('\n')}`
            : '');
          const message = q.run(
            'INSERT INTO ai_messages(conversation_id,role,content) VALUES(?,?,?)',
            cid,
            'assistant',
            assistantText,
          );
          const assistantMessageId = Number(message.lastInsertRowid);
          const risk = deps.applyChatRiskControlFn({
            targetType: 'ai_message',
            targetId: assistantMessageId,
            title: `会诊输出：${question.slice(0, 40)}`,
            text: output.text,
            submitterId: req.user.id,
          });
          deps.recordKbCitationsFn({
            targetType: 'ai_message',
            targetId: assistantMessageId,
            kb: output.kb,
          });
          const latest = q.all(
            `SELECT role,content FROM ai_messages
             WHERE tenant_id=? AND conversation_id=?
             ORDER BY id DESC LIMIT 8`,
            curTenant(),
            cid,
          ).reverse();
          const summary = latest.map(item => `${item.role === 'user' ? '用户' : 'AI'}：${String(item.content).replace(/\s+/g, ' ').slice(0, 220)}`)
            .join('\n')
            .slice(0, 3500);
          q.run(
            `UPDATE ai_conversations
             SET summary=?,updated_at=datetime('now','localtime')
             WHERE tenant_id=? AND id=?`,
            summary,
            curTenant(),
            cid,
          );
          q.run(
            `UPDATE credit_holds SET ref_type='ai_message',ref_id=?
             WHERE tenant_id=? AND id=? AND status='held'`,
            assistantMessageId,
            curTenant(),
            deliveryHold.holdId,
          );
          return { assistantMessageId, risk };
        }),
        settle: deps.settleHoldFn,
        release: deps.releaseHoldFn,
        settlement: output => ({
          usage: output.usage,
          model: output.model,
          aiMode: output.mode,
          note: '顾问助手消息、风控、引用证据与会话摘要已完成业务落库',
        }),
        releaseNote: '顾问联网、生成或业务产物落库失败，预授权全额退回',
      });

      // 会诊正文、风控、引用与计费均已完成；审计日志是旁路记录，
      // 写入异常不能把已交付且已结算的结果伪装成 500。
      try {
        logOp(
          req.user,
          '老板参谋',
          '发起会诊',
          `${diagType}${useWeb ? '+联网' : ''}${useDeep ? '+深思' : ''}`,
        );
      } catch (logError) {
        console.error('[advisor] 会诊操作日志写入失败:', logError?.message);
      }
      const payload = {
        conversationId: cid,
        assistantMessageId: delivered.delivery.assistantMessageId,
        reply: delivered.output.text,
        mode: delivered.output.mode,
        model: delivered.output.model,
        recommended,
        billing: delivered.billing,
        risk: delivered.delivery.risk,
        kb: delivered.output.kb,
        sources: delivered.output.webRefs,
        webNote: delivered.output.webNote,
        deep: useDeep,
        steps: [
          useWeb ? '联网检索' : null,
          '问题判断',
          '智能体调度',
          useDeep ? '深度推演' : null,
          '风险提示',
          '方案生成',
        ].filter(Boolean),
      };
      if (sendEvent) {
        // 以最终持久化文本为准；供应商的中途分片仅用于保持其流式超时与取消语义。
        sendEvent({ delta: delivered.output.text || bufferedText });
        sendEvent({ done: true, ...payload });
        res.end();
      } else {
        res.json(payload);
      }
    } catch (error) {
      let billing = error.billing || null;
      if (hold) {
        try {
          const released = deps.releaseHoldFn(
            hold,
            `会诊未完成（${String(error?.message || '').slice(0, 60)}），预授权全额退回`,
          );
          billing = twoPhaseBillingSummary({
            state: 'released',
            hold,
            settled: released,
            note: '本次未形成可交付产物，预授权已全额退回。',
          });
        } catch (releaseError) {
          billing = twoPhaseBillingSummary({
            state: 'pending_reconciliation',
            hold,
            error: releaseError,
            note: '本次未形成可交付产物，但预授权释放异常，已保留待人工对账。',
          });
        }
        hold = null;
      }
      if (req.requestSignal?.aborted) {
        if (res.headersSent && !res.writableEnded) res.end();
        return;
      }
      const errorPayload = {
        error: error.message,
        requestId: req.requestId,
        ...(billing ? { billing } : {}),
      };
      if (res.headersSent) {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
          res.end();
        }
        return;
      }
      res.status(error.status || 500).json(errorPayload);
    }
  };
}

r.post('/chat', createAdvisorChatHandler());

// 会诊输出的执行动作行解析：匹配「【今日目标】xxx ｜【执行人】xxx ｜【截止】xxx ｜【检查标准】xxx」类结构
function parseActionLines(text) {
  const out = [];
  for (const raw of String(text || '').split(/\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const seg = line.match(/【(今日目标|本周目标|本月目标|执行动作|动作)】([^｜|]+)/);
    if (!seg) continue;
    out.push({
      title: seg[2].trim().slice(0, 80),
      owner: line.match(/【执行人】([^｜|]+)/)?.[1]?.trim() || null,
      due: line.match(/【截止(?:时间)?】([^｜|]+)/)?.[1]?.trim() || null,
      check: line.match(/【检查标准】([^｜|]+)/)?.[1]?.trim() || null,
      raw: line.slice(0, 500),
    });
  }
  return out;
}

// 会诊结果一键转任务（看建议→落执行闭环）：把 AI 回复中的执行动作落成待办，执行中心可见可跟
r.post('/messages/:id/to-tasks', (req, res) => {
  try {
    const msg = q.get(`SELECT m.id, m.content, c.user_id FROM ai_messages m
      JOIN ai_conversations c ON c.id = m.conversation_id AND c.tenant_id = m.tenant_id
      WHERE m.tenant_id = ${curTenant()} AND m.id = ? AND m.role = 'assistant'`, req.params.id);
    if (!msg || msg.user_id !== req.user.id) return res.status(404).json({ error: '消息不存在或无权访问' });
    const actions = parseActionLines(msg.content);
    // 未识别出结构化动作时兜底生成一条总任务，正文进详情
    const items = actions.length ? actions : [{
      title: `会诊待办：${String(msg.content).replace(/\s+/g, ' ').trim().slice(0, 60)}`,
      owner: null, due: null, check: null, raw: String(msg.content).slice(0, 500),
    }];
    const created = [];
    for (const a of items.slice(0, 10)) {
      const detail = [
        a.owner ? `执行人：${a.owner}` : null,
        a.due ? `截止：${a.due}` : null,
        a.check ? `检查标准：${a.check}` : null,
        `来源：AI会诊 #${msg.id}`,
        a.raw,
      ].filter(Boolean).join('\n');
      const r0 = q.run(`INSERT INTO tasks(title,detail,type,status,priority,assignee_id,source) VALUES(?,?,?,?,?,?,?)`,
        a.title, detail, '其他', '待执行', '中', req.user.id, '会诊');
      created.push({ id: r0.lastInsertRowid, title: a.title });
    }
    logOp(req.user, '老板参谋', '会诊转任务', `${created.length}条`);
    res.json({ created });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// 转派数字员工分部（会诊 → 协同任务；marshalCodes 字段保留接口兼容）
r.post('/dispatch', (req, res) => {
  if (!Array.isArray(req.body?.marshalCodes)) return res.status(400).json({ error: '数字员工分部列表格式不正确' });
  const marshalCodes = [...new Set(req.body.marshalCodes.map(code => String(code).trim()))];
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!marshalCodes.length || !title) return res.status(400).json({ error: '数字员工分部与议题必填' });
  if (marshalCodes.length > 8 || marshalCodes.some(code => !/^M-0[1-8]$/.test(code))) {
    return res.status(400).json({ error: '一次最多转派8个有效数字员工分部' });
  }
  if (title.length > 200) return res.status(400).json({ error: '会诊议题最长200字' });
  const ms = mergeMarshals(q.all(`SELECT id, code, name FROM marshals WHERE online = 1 AND code IN (${marshalCodes.map(() => '?').join(',')})`, ...marshalCodes));
  if (ms.length !== marshalCodes.length) return res.status(400).json({ error: '数字员工分部列表中包含不存在的编号' });
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const m of ms) {
      q.run(`INSERT INTO agent_tasks(marshal_id,title,type,status,is_collab,collab_marshals,created_by) VALUES(?,?,?,?,1,?,?)`,
        m.id, `【会诊】${title}`, '会诊', '执行中', marshalCodes.join(','), req.user.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw error;
  }
  logOp(req.user, '老板参谋', '转派数字员工分部', marshalCodes.join(','));
  res.json({ dispatched: ms.map(m => m.name) });
});

// 能力矩阵（FR-ADV-06：健康度子项映射五维）
r.get('/capability', (req, res) => {
  const h = healthScore();
  const map = { leads: '营销获客', conversion: '销售转化', repurchase: '客户经营', partner: '组织建设', content: '品牌内容' };
  const taskScope = userScopeClause(req.user, 't.created_by');
  res.json({
    radar: h.subs.map(s => ({ name: map[s.key], score: Math.min(s.score, 100) })),
    networkStatus: mergeMarshals(q.all(`SELECT m.id, m.code, m.name, m.title, m.emoji, m.avatar, m.online,
      (SELECT COUNT(*) FROM agent_tasks t WHERE t.tenant_id = ${curTenant()} AND t.marshal_id = m.id AND t.status = '执行中'${taskScope.sql}) running
      FROM marshals m WHERE m.online = 1 ORDER BY m.sort`, ...taskScope.params)),
  });
});

export default r;
