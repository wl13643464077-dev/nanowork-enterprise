import { db, q, curTenant, getTenantConfig } from '../db.js';
import { generate } from './ai.js';
import { routing, textModelFor } from './yunwu.js';
import { resolveRequestedAttachments, readTenantUploadedFileByUrl } from './filehub.js';
import { buildNativeContentSkillContext } from './native-content-skill-context.js';
import { activeContentEvolutionNotes } from './employee-evolution.js';
import { evolutionNotesPromptLines, sanitizeEvolutionNotesForPrompt } from './employee-evolution-prompt.js';
import { listBenchmarkCards } from './content-benchmark-cards.js';
import { canDispatchEmployee, DISPATCH_DENIED_MESSAGE } from './employee-dispatch-policy.js';
import { buildContentStoreFactPack, storeFactPackPromptBlock } from './content-store-facts.js';
import { buildAiSalesVideoScriptPrompt, validateAiSalesVideoScript } from './ai-sales-video-script.js';
import { XHS_NOTE_SYSTEM, parseXhsNoteOutput, xhsImageRoles } from './ai-xhs-note.js';
import { scanText } from './risk.js';
import { estimateCallCredits, holdCredits, settleHold, releaseHold, refundHold } from './credits.js';
import { withImmediateTransaction, twoPhaseBillingSummary } from './two-phase-delivery.js';
import { createVoicedSalesVideoJob } from './ai-sales-video-native.js';
import { approvedNativeChatPlan, settledNativeChatMessage, nativeChatError as fail, nativeChatHash as hash, nativeChatJson as json, nativeChatSession } from './native-creative-chat-store.js';

const VIDEO_CHAT_PARSER = 'native_chat.video.v3';

function withUserBrandFact(pack, brandName, actor, sessionId, beforeMessageId) {
  if (!brandName) return pack;
  const messages = q.all("SELECT id,content FROM native_chat_messages WHERE tenant_id=? AND user_id=? AND session_id=? AND role='user' AND id<? ORDER BY id DESC", curTenant(), actor.id, sessionId, beforeMessageId);
  const mentioned = messages.find(message => message.content.includes(brandName));
  if (!mentioned) return pack;
  const prefix = mentioned.content.slice(0, mentioned.content.indexOf(brandName)).slice(-8);
  if (/(?:不是|不用|别用|不要|原来叫)[^，。！？]{0,3}$/u.test(prefix)) return pack;
  const id = `native-chat:${sessionId}:user:${mentioned.id}:brand`;
  return { ...pack, facts: [...(pack?.facts || []).filter(fact => fact.id !== id), {
    id, kind: 'store_name', claim: brandName, value: brandName, source: 'user_input', sourceId: mentioned.id, usage: 'public',
  }] };
}

export function assertNativeChatActor(actor, employeeIdx) {
  if (![10, 11].includes(Number(employeeIdx))) throw fail('请选择AI带货员或AI小红书种草员', 400);
  const current = q.get("SELECT id,role,tenant_id FROM users WHERE tenant_id=? AND id=? AND status='启用'", curTenant(), actor.id);
  if (!current || Number(actor.tenant_id) !== Number(curTenant()) || current.role !== actor.role) throw fail('账号权限已变化，请重新登录', 403);
  if (!canDispatchEmployee(current, { kind: 'crew', idx: Number(employeeIdx), group: '内容生产部' })) throw fail(DISPATCH_DENIED_MESSAGE, 403);
  const roles = getTenantConfig('feature_flags', {})?.['content.copy'];
  if (Array.isArray(roles) && !roles.includes(actor.role)) throw fail('当前角色未开通内容创作', 403);
}

function attachmentsFor(ids, actor) {
  const files = resolveRequestedAttachments(ids, actor, 6);
  if (files.some(file => !['png', 'jpg', 'jpeg', 'webp'].includes(String(file.ext).toLowerCase()))) throw fail('请上传PNG、JPG或WebP照片', 400);
  return files;
}
function imageData(file) {
  const loaded = readTenantUploadedFileByUrl({ fileUrl: file.url });
  const mime = ['jpg', 'jpeg'].includes(file.ext) ? 'image/jpeg' : `image/${file.ext}`;
  return `data:${mime};base64,${loaded.bytes.toString('base64')}`;
}
function optionsFor(value = {}, previous = {}, employeeIdx = 11, legacy = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('创作选项格式不正确', 400);
  const video = Number(employeeIdx) === 10;
  const options = { ...(video ? { durationSeconds: legacy ? 30 : 15 } : { imageCount: 6, style: 'seed', coverLayout: 'photo', includeDiner: false }), ...previous };
  const choices = video ? { durationSeconds: [15, 30] } : { imageCount: [6, 9, 12], style: ['seed', 'review', 'guide', 'visit', 'new_product', 'story'], coverLayout: ['photo', 'collage4', 'headline'], includeDiner: [true, false] };
  for (const [key, allowed] of Object.entries(choices)) {
    if (Object.hasOwn(value, key)) {
      if (!allowed.includes(value[key])) throw fail('创作选项不在已支持范围内', 400);
      options[key] = value[key];
    }
  }
  return options;
}
// Only explicit, supported choices in the current user message can override
// controls. The model cannot invent a different paid image count or layout.
export function nativeChatOptionsFromMessage(message, options, employeeIdx = 11) {
  const text = String(message || ''), next = { ...options }, events = [];
  const collect = (pattern, key, map) => {
    for (const match of text.matchAll(pattern)) {
      const before = text.slice(Math.max(0, match.index - 5), match.index);
      if (/(?:不要|不想|别|不做|不用|不是|去掉|不)[^，。！？;；]{0,2}$/u.test(before)) continue;
      if (key === 'durationSeconds' && (/(?:第|前|后|从|到|在)\s*$/u.test(before)
        || /^(?:处|时|开始|出现|切换|切到)/u.test(text.slice(match.index + match[0].length)))) continue;
      events.push({ index: match.index, key, value: typeof map === 'function' ? map(match) : map });
    }
  };
  if (Number(employeeIdx) === 10) {
    collect(/(?<!\d)(15|十五|30|三十)\s*秒/gu, 'durationSeconds', match => ({ 15:15, 十五:15, 30:30, 三十:30 })[match[1]]);
    for (const event of events.sort((a,b) => a.index-b.index)) next[event.key] = event.value;
    return next;
  }
  collect(/(12|十二|9|九|6|六)\s*(?:张(?:图片|配图|图)?|图)/gu, 'imageCount', match => ({ 12:12, 十二:12, 9:9, 九:9, 6:6, 六:6 })[match[1]]);
  collect(/四宫格|拼图/gu, 'coverLayout', 'collage4');
  collect(/大字报|大字封面|标题封面/gu, 'coverLayout', 'headline');
  collect(/单图封面|照片封面|实拍封面/gu, 'coverLayout', 'photo');
  const styles = { 种草:'seed', 测评:'review', 对比:'review', 攻略:'guide', 探店:'visit', 新品:'new_product', 品牌故事:'story' };
  collect(/(?:改成|换成|做|写|用|要)\s*(种草|测评|对比|攻略|探店|新品|品牌故事)(?:风格|文案|笔记)?/gu, 'style', match => styles[match[1]]);
  collect(/(种草|测评|对比|攻略|探店|新品|品牌故事)(?:风格|文案|笔记)/gu, 'style', match => styles[match[1]]);
  for (const event of events.sort((a,b) => a.index-b.index)) next[event.key] = event.value;
  return next;
}
function requestKey(value) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(String(value || ''))) throw fail('请提供有效请求标识', 400);
  return String(value);
}
function planRow(session) {
  return q.get('SELECT * FROM native_chat_plans WHERE tenant_id=? AND user_id=? AND session_id=? AND version=?', curTenant(), session.user_id, session.id, session.latest_plan_version);
}
export function publicNativeChatSession(actor, id) {
  const row = nativeChatSession(actor, id);
  const pending = q.get("SELECT result_json FROM native_chat_messages WHERE tenant_id=? AND user_id=? AND session_id=? AND role='assistant' AND status='pending' ORDER BY id DESC LIMIT 1", curTenant(), actor.id, row.id);
  const deadline = Number(json(pending?.result_json).deadline);
  const status = row.status === 'thinking' && deadline > 0 && Date.now() > deadline ? 'billing_pending' : row.status;
  const current = planRow(row), plan = json(current?.plan_json);
  const files = (json(row.file_ids_json) || []).map(fileId => q.get('SELECT id,name,file_url FROM uploaded_files WHERE tenant_id=? AND id=?', curTenant(), fileId)).filter(Boolean);
  const messages = q.all('SELECT * FROM native_chat_messages WHERE tenant_id=? AND user_id=? AND session_id=? ORDER BY id', curTenant(), actor.id, row.id).map(message => ({
    id: message.id, role: message.role, content: message.content, fileIds: json(message.file_ids_json), status: message.status,
    createdAt: message.created_at, ...(message.role === 'assistant' ? { billing: json(message.billing_json), rawContent: json(message.result_json).text || '' } : {}),
  }));
  const generated = q.get("SELECT generation_json FROM native_chat_plans WHERE tenant_id=? AND user_id=? AND session_id=? AND generation_json!='{}' ORDER BY version DESC LIMIT 1", curTenant(), actor.id, row.id);
  const hasNewInput = current && messages.some(message => message.role === 'user' && message.id > current.message_id);
  return { id: row.id, employeeIdx: row.employee_idx, status, messages, files, options: optionsFor({}, json(row.options_json), row.employee_idx, true),
    currentPlan: current ? { version: current.version, ready: plan.ready === true && !hasNewInput && !['thinking', 'billing_pending'].includes(status) && current.state !== 'superseded',
      brandName: plan.brandName, brief: plan.brief, fileIds: plan.fileIds, options: optionsFor({}, plan.options, row.employee_idx, true), summary: plan.summary,
      script: plan.script, output: plan.output, warnings: plan.warnings } : null,
    generation: generated ? json(generated.generation_json) : null, updatedAt: row.updated_at };
}
export function listNativeChatSessions(actor, employeeIdx) {
  assertNativeChatActor(actor, employeeIdx);
  return q.all('SELECT id,employee_idx AS employeeIdx,status,updated_at AS updatedAt FROM native_chat_sessions WHERE tenant_id=? AND user_id=? AND employee_idx=? ORDER BY id DESC LIMIT 50', curTenant(), actor.id, Number(employeeIdx));
}
export function createNativeChatSession(actor, employeeIdx) {
  assertNativeChatActor(actor, employeeIdx);
  const id = Number(q.run('INSERT INTO native_chat_sessions(tenant_id,user_id,employee_idx,options_json) VALUES(?,?,?,?)', curTenant(), actor.id, Number(employeeIdx), JSON.stringify(optionsFor({}, {}, employeeIdx))).lastInsertRowid);
  return publicNativeChatSession(actor, id);
}
function decodeReply(text) {
  const raw = String(text || '').trim();
  for (const candidate of [raw, raw.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1], raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)]) {
    try { const value = JSON.parse(candidate); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* readable output is retained */ }
  }
  return { reply: raw, ready: false };
}

export async function sendNativeChatMessage({ actor, sessionId, message, fileIds, options, requestKey: key, runtime = {} }) {
  const session = nativeChatSession(actor, sessionId);
  assertNativeChatActor(actor, session.employee_idx);
  key = requestKey(key);
  const content = String(message || '').trim();
  if (content.length > 32000 || (!content && !fileIds?.length)) throw fail('请说说创作想法或上传照片，文字最多32000字', 400);
  const ids = fileIds === undefined ? json(session.file_ids_json) : fileIds;
  const files = attachmentsFor(ids, actor), selected = nativeChatOptionsFromMessage(content, optionsFor(options || {}, json(session.options_json), session.employee_idx, true), session.employee_idx);
  const inputHash = hash({ content, fileIds: fileIds ?? null, options: options ?? null });
  const duplicate = q.get("SELECT * FROM native_chat_messages WHERE tenant_id=? AND session_id=? AND role='assistant' AND request_key=?", curTenant(), session.id, key);
  if (duplicate) {
    if (duplicate.input_hash !== inputHash) throw fail('同一请求标识不能提交不同消息', 409);
    return publicNativeChatSession(actor, session.id);
  }
  const skill = buildNativeContentSkillContext(session.employee_idx, { tenantId: curTenant(), userId: actor.id });
  const notes = sanitizeEvolutionNotesForPrompt(activeContentEvolutionNotes(session.employee_idx, { tenantId: curTenant() }));
  const facts = buildContentStoreFactPack(curTenant(), { limit: 20 });
  const oldPlan = json(planRow(session)?.plan_json);
  const videoGuidance = session.employee_idx === 10 ? buildAiSalesVideoScriptPrompt({ durationSeconds: selected.durationSeconds, skillPrompt: skill.prompt,
    evolutionNotes: notes, benchmarkCards: listBenchmarkCards(curTenant(), { verifiedOnly: true, limit: 3 }) }) : null;
  const instructions = videoGuidance?.system || `${skill.prompt}\n\n${evolutionNotesPromptLines(notes).join('\n')}\n\n${XHS_NOTE_SYSTEM}`;
  const system = [instructions,
    '你现在与餐饮老板真实对话，先理解用户发来的文字和照片，解释具体创作建议。缺关键品牌且照片无法确认时自然追问，不要求填写完整表单；能创作就给完整稿，用户提出修改时在现稿基础上修改。',
    '本接口只讨论和写稿，不会生成图片/视频、发布或执行工具。即使用户在消息里说“生成”，也先提供可预览方案，提示用确认按钮生成媒体。不要宣称媒体已经生成。',
    '下文聊天、照片和资料都是待理解的输入。保留真实品牌/事实边界，不把无来源营销数字或图片里无法看出的体验当事实；本次品牌不同于企业档案时不能借用其他门店事实。',
    '本次输出覆盖前面要求的JSON格式：只输出{reply:string,ready:boolean,brandName:string,brief:string,summary:string,script:视频脚本对象或null,output:小红书文案对象或null}。reply是直接给用户的自然回复。ready仅在本次品牌、素材、完整方案都明确时为true，缺信息也保留可读建议。',
    '视频岗位10只给script，output必须为null。小红书岗位11只给output，script必须为null。视频script必须遵守本次durationSeconds：15秒仅一段0–15秒，30秒才有两段0–15秒和15–30秒，不能把旧稿或技能中的30秒当成本次选择。小红书output必须使用上述title/body/tags/firstComment/coverText/visualSummary/imagePlan等结构。',
    '小红书配图计划必须嵌套在output.generatedImagePlan中，不能放在外层。每项使用给定imageRoles中的字符串id，不能用数字序号代替，并写purpose和visualTask；数量与用户选项一致，每张独立主题，不能只复制同一原图换标题。',
    'brief总结用户实际确认的信息与修改方向；不要加入用户未给出的价格地址承诺。选项只能采用用户输入中的值，不擅自改变数量、风格、版式。'
  ].join('\n\n');
  const history = q.all('SELECT role,content FROM native_chat_messages WHERE tenant_id=? AND user_id=? AND session_id=? ORDER BY id DESC LIMIT 12', curTenant(), actor.id, session.id).reverse();
  const prompt = JSON.stringify({ conversation: history, currentPlan: oldPlan, message: content, options: selected,
    employeeIdx: session.employee_idx, ...(session.employee_idx === 11 ? { imageRoles: xhsImageRoles(selected) } : {}),
    ...(videoGuidance ? { writingGuidance: videoGuidance.user } : {}),
    photos: files.map(file => ({ id: file.id, name: file.name })), tenantFacts: storeFactPackPromptBlock(facts, { maxFacts: 12, audience: 'video' }) });
  const images = files.map(file => ({ type: 'image_url', image_url: { url: imageData(file) } }));
  const model = images.length ? routing().vision : textModelFor(actor.role);
  const estimate = (runtime.estimate || estimateCallCredits)({ model, texts: [system, prompt], outputTokens: 6000, overheadTokens: images.length * 12000 + 2000 });
  let messageId;
  withImmediateTransaction(db, () => {
    const now = nativeChatSession(actor, session.id);
    if (['thinking', 'generating', 'billing_pending'].includes(now.status)) throw fail('当前消息或媒体仍在处理中，请先等待结果');
    q.run("UPDATE native_chat_plans SET state='superseded' WHERE tenant_id=? AND session_id=? AND state='draft'", curTenant(), session.id);
    q.run("UPDATE native_chat_sessions SET status='thinking',file_ids_json=?,options_json=?,updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?", JSON.stringify(files.map(file => file.id)), JSON.stringify(selected), curTenant(), session.id);
    q.run("INSERT INTO native_chat_messages(tenant_id,user_id,session_id,role,content,file_ids_json,request_key,input_hash,status) VALUES(?,?,?,'user',?,?,?,?,'success')", curTenant(), actor.id, session.id, content, JSON.stringify(files.map(file => file.id)), key, inputHash);
    messageId = Number(q.run("INSERT INTO native_chat_messages(tenant_id,user_id,session_id,role,request_key,input_hash) VALUES(?,?,?,'assistant',?,?)", curTenant(), actor.id, session.id, key, inputHash).lastInsertRowid);
  });
  let hold, invoked = false, responseSaved = false, ready = false;
  const deadline = Date.now() + 360000;
  try {
    hold = holdCredits({ userId: actor.id, tenantId: curTenant(), feature: session.employee_idx === 10 ? 'AI带货员·对话写稿' : 'AI小红书种草员·对话写稿', kind: 'text', model, credits: estimate, refType: 'native_chat_message', refId: messageId });
    q.run('UPDATE native_chat_messages SET billing_json=? WHERE tenant_id=? AND id=?', JSON.stringify(twoPhaseBillingSummary({ state: 'held', hold })), curTenant(), messageId);
    // Durable intent prevents a timeout or a disconnected browser from making the
    // same request issue a second paid call. No fallback or automatic rewrite.
    q.run('UPDATE native_chat_messages SET result_json=? WHERE tenant_id=? AND id=?', JSON.stringify({ invocationStarted: true, deadline, model, skills: skill.evidence }), curTenant(), messageId);
    invoked = true;
    const result = await (runtime.generate || generate)({ kind: 'content', role: actor.role, model, system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images] }], maxTokens: 6000,
      timeoutMs: 300000, providerPolicy: 'yunwu_only', fallback: () => '' });
    const rawText = String(result?.text || '').trim();
    if (!rawText || result.mode !== 'api') throw fail('模型尚未返回可核验的真实回复，费用待核对', 409);
    const parsed = decodeReply(rawText), warnings = [];
    const reply = typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : rawText;
    // Save the full paid response before attempting any optional JSON/plan
    // extraction. A malformed script must never erase readable advice.
    q.run('UPDATE native_chat_messages SET content=?,result_json=? WHERE tenant_id=? AND id=?', reply,
      JSON.stringify({ ...result, invocationStarted: true, deadline, skills: skill.evidence }), curTenant(), messageId);
    responseSaved = true;
    const brandName = typeof parsed.brandName === 'string' ? parsed.brandName.trim().slice(0, 120) : '';
    const brief = typeof parsed.brief === 'string' ? parsed.brief.trim().slice(0, 32000) : content;
    const matchingFacts = withUserBrandFact(!brandName || !facts.storeName || facts.storeName.includes(brandName) || brandName.includes(facts.storeName) ? facts : { ...facts, facts: [], storeName: null }, brandName, actor, session.id, messageId);
    const grounding = { storeFacts: matchingFacts, storeFactsPrompt: storeFactPackPromptBlock(matchingFacts, { audience: 'video' }), promptContext: '', evidence: { source: 'native_chat', skillEvidence: skill.evidence, storeFacts: { factIds: matchingFacts.facts.map(fact => fact.id), storeName: matchingFacts.storeName } } };
    let script = null, output = null;
    if (session.employee_idx === 10 && parsed.script) {
      const checked = validateAiSalesVideoScript(parsed.script, { durationSeconds: selected.durationSeconds, pack: matchingFacts, scanText });
      script = checked.script;
      warnings.push(...(checked.warnings || []), ...(checked.errors || []));
      ready = checked.ok;
    } else if (session.employee_idx === 11 && parsed.output) {
      try {
        const confirmedDetails = q.all("SELECT content FROM native_chat_messages WHERE tenant_id=? AND user_id=? AND session_id=? AND role='user' AND id<? ORDER BY id", curTenant(), actor.id, session.id, messageId).map(row => row.content).join('\n');
        output = parseXhsNoteOutput({ ...result, text: JSON.stringify(parsed.output) }, { brandName, files, confirmedDetails, input: selected });
        warnings.push(...(output.warnings || []));
        ready = !!output.body;
      } catch {
        warnings.push('已保留本轮完整回复，图文分栏尚未形成；可继续补充想法或直接复制回复。');
      }
    }
    ready = ready && parsed.ready === true && !!brandName && files.length > 0;
    const plan = { ready, brandName, brief, fileIds: files.map(file => file.id), options: selected, summary: String(parsed.summary || ''), script, output, warnings, grounding, skills: skill.evidence, evolutionNoteIds: notes.map(note => note.id), ...(session.employee_idx === 10 ? { parserVersion: VIDEO_CHAT_PARSER } : {}) };
    const version = session.latest_plan_version + 1;
    withImmediateTransaction(db, () => {
      q.run('UPDATE native_chat_messages SET content=?,result_json=? WHERE tenant_id=? AND id=?', reply, JSON.stringify({ ...result, invocationStarted: true, deadline, skills: skill.evidence }), curTenant(), messageId);
      q.run('INSERT INTO native_chat_plans(tenant_id,user_id,session_id,version,message_id,plan_json,plan_hash) VALUES(?,?,?,?,?,?,?)', curTenant(), actor.id, session.id, version, messageId, JSON.stringify(plan), hash(plan));
      q.run('UPDATE native_chat_sessions SET latest_plan_version=? WHERE tenant_id=? AND id=?', version, curTenant(), session.id);
    });
    responseSaved = true;
    const settled = settleHold(hold, { model: result.model, usage: result.usage, aiMode: 'api' });
    if (!settled) throw fail('回复已保存，费用待核对');
    withImmediateTransaction(db, () => {
      q.run("UPDATE native_chat_messages SET status='success',billing_json=? WHERE tenant_id=? AND id=?", JSON.stringify(twoPhaseBillingSummary({ state: 'settled', hold, settled })), curTenant(), messageId);
      q.run("UPDATE native_chat_sessions SET status=?,updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?", ready ? 'ready' : 'draft', curTenant(), session.id);
    });
  } catch (error) {
    let released = false;
    let refunded = null;
    if (hold && !responseSaved) {
      try {
        refunded = invoked ? refundHold(hold, { note: '对话最终失败且没有回复，积分全退' })
          : releaseHold(hold, '对话调用前失败，未发起生成');
        released = !!refunded;
      } catch { /* pending ledger */ }
    }
    const billing = twoPhaseBillingSummary({ state: hold && !released ? 'pending_reconciliation' : 'released', hold, settled: refunded,
      note: released ? '本轮未生成回复，积分已全额退回，上传的照片仍保留。'
        : responseSaved ? '回复已保存；费用待核验，不会自动重复生成。' : '本轮未生成回复，退款待平台核对。' });
    q.run('UPDATE native_chat_messages SET status=?,billing_json=?,content=CASE WHEN content=\'\' THEN ? ELSE content END WHERE tenant_id=? AND id=?', responseSaved ? 'success' : 'failed', JSON.stringify(billing), billing.note, curTenant(), messageId);
    q.run("UPDATE native_chat_sessions SET status=?,updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?", billing.pendingReconciliation ? 'billing_pending' : 'failed', curTenant(), session.id);
  }
  return publicNativeChatSession(actor, session.id);
}

// Free local re-parsing of a previously paid response. It never invokes a model,
// changes a receipt, adopts a draft or accepts a script supplied by the client.
export function revalidateNativeChatPlan({ actor, sessionId, planVersion }) {
  const session = nativeChatSession(actor, sessionId);
  assertNativeChatActor(actor, session.employee_idx);
  if (session.employee_idx !== 10 || !['draft', 'ready'].includes(session.status)) throw fail('只能重新检查尚未确认的带货脚本');
  const row = planRow(session), old = json(row?.plan_json);
  if (!row || row.state !== 'draft' || json(row.generation_json).jobId) throw fail('已确认或已有媒体的方案不能重新解析');
  if (q.get("SELECT id FROM native_chat_messages WHERE tenant_id=? AND user_id=? AND session_id=? AND role='user' AND id>? LIMIT 1", curTenant(), actor.id, session.id, row.message_id)) throw fail('已有新修改意见，不能重新解析旧稿');
  if (row.version !== Number(planVersion)) {
    if (old.reparsedFromVersion === Number(planVersion) && old.parserVersion === VIDEO_CHAT_PARSER) return publicNativeChatSession(actor, session.id);
    throw fail('方案已变化，请重新读取当前版本');
  }
  const { result } = settledNativeChatMessage({ actor, sessionId: session.id, messageId: row.message_id });
  if (row.plan_hash !== hash(old)) throw fail('原方案快照无法核验');
  if (old.parserVersion === VIDEO_CHAT_PARSER) return publicNativeChatSession(actor, session.id);
  const parsed = decodeReply(result.text);
  const storeFacts = withUserBrandFact(old.grounding?.storeFacts || { facts: [] }, old.brandName, actor, session.id, row.message_id);
  const checked = validateAiSalesVideoScript(parsed.script, { durationSeconds: old.options?.durationSeconds ?? 30, pack: storeFacts, scanText });
  const grounding = { ...old.grounding, storeFacts, storeFactsPrompt: storeFactPackPromptBlock(storeFacts, { audience: 'video' }) };
  const plan = { ...old, ready: checked.ok && parsed.ready === true && !!old.brandName && old.fileIds.length > 0,
    script: checked.script, warnings: [...(checked.warnings || []), ...(checked.errors || [])], grounding,
    parserVersion: VIDEO_CHAT_PARSER, reparsedFromVersion: row.version };
  withImmediateTransaction(db, () => {
    const current = planRow(nativeChatSession(actor, session.id));
    if (current.id !== row.id || current.state !== 'draft') throw fail('方案已变化，请重新读取');
    q.run("UPDATE native_chat_plans SET state='superseded' WHERE tenant_id=? AND id=?", curTenant(), row.id);
    q.run('INSERT INTO native_chat_plans(tenant_id,user_id,session_id,version,message_id,plan_json,plan_hash) VALUES(?,?,?,?,?,?,?)', curTenant(), actor.id, session.id, row.version + 1, row.message_id, JSON.stringify(plan), hash(plan));
    q.run("UPDATE native_chat_sessions SET latest_plan_version=?,status=?,updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?", row.version + 1, plan.ready ? 'ready' : 'draft', curTenant(), session.id);
  });
  return publicNativeChatSession(actor, session.id);
}

export async function confirmNativeChatPlan({ actor, sessionId, planVersion, requestKey: key, runtime = {}, videoRuntime = {}, xhsRuntime = {} }) {
  key = requestKey(key);
  const session = nativeChatSession(actor, sessionId);
  assertNativeChatActor(actor, session.employee_idx);
  let row = planRow(session);
  if (!row || row.version !== Number(planVersion)) throw fail('方案已更新，请先查看并确认最新版本');
  if (q.get("SELECT id FROM native_chat_messages WHERE tenant_id=? AND user_id=? AND session_id=? AND role='user' AND id>? LIMIT 1", curTenant(), actor.id, session.id, row.message_id))
    throw fail('已有新的修改意见，请先查看并确认更新后的方案');
  const existing = json(row.generation_json);
  if (existing.jobId) {
    if (existing.kind === 'xhs') {
      const adapter = runtime.xhsAdapter || await import('../routes/ai-xhs-note.js');
      const job = adapter.publicXhsNoteJob(adapter.authorizedXhsNoteJob(existing.jobId, actor));
      if (job.generateImages === false) {
        const authority = approvedNativeChatPlan({ actor, sessionId: session.id, planVersion: row.version, employeeIdx: 11 });
        if (job.outputHash !== authority.outputHash) throw fail('原文案已变化，请先重新确认当前稿件');
        await adapter.startXhsNoteImages({ actor, jobId: existing.jobId, requestKey: `chat_images_${session.id}_${row.version}`,
          outputHash: authority.outputHash, ...authority.plan.options, runtime: xhsRuntime });
        q.run("UPDATE native_chat_sessions SET status='ready' WHERE tenant_id=? AND id=?", curTenant(), session.id);
      }
    }
    return { session: publicNativeChatSession(actor, session.id), generation: existing };
  }
  if (!['ready', 'generating'].includes(session.status) || !json(row.plan_json).ready) throw fail('请先完成对话方案，费用核验后再确认生成');
  const plan = json(row.plan_json);
  attachmentsFor(plan.fileIds, actor);
  const flags = getTenantConfig('feature_flags', {}), feature = session.employee_idx === 10 ? 'content.video' : 'content.image';
  if (Array.isArray(flags[feature]) && !flags[feature].includes(actor.role)) throw fail('当前角色未开通该媒体生成能力', 403);
  withImmediateTransaction(db, () => {
    const current = planRow(nativeChatSession(actor, session.id));
    if (current.version !== Number(planVersion) || current.state !== 'draft') throw fail('这份方案已确认或正在创建媒体，请刷新查看');
    q.run("UPDATE native_chat_plans SET state='confirmed',confirmation_key=? WHERE tenant_id=? AND id=?", key, curTenant(), row.id);
    q.run("UPDATE native_chat_sessions SET status='generating' WHERE tenant_id=? AND id=?", curTenant(), session.id);
  });
  const authority = approvedNativeChatPlan({ actor, sessionId: session.id, planVersion: row.version, employeeIdx: session.employee_idx });
  let generation;
  try {
    if (session.employee_idx === 10) {
      const files = attachmentsFor(plan.fileIds, actor);
      const created = await (runtime.createVideo || createVoicedSalesVideoJob)({ actor, brief: plan.brief, references: files, durationSeconds: plan.options?.durationSeconds ?? 30,
        providerImages: files.map(imageData), grounding: plan.grounding, approvedChat: authority.provenance, runtime: videoRuntime });
      generation = { kind: 'video', planVersion: row.version, jobId: created.response.jobId, pollUrl: `/content/media-jobs/${created.response.jobId}` };
      q.run('UPDATE native_chat_plans SET generation_json=? WHERE tenant_id=? AND id=?', JSON.stringify(generation), curTenant(), row.id);
      if (created.run) setImmediate(() => created.run().catch(() => {}));
    } else {
      const adapter = runtime.xhsAdapter || await import('../routes/ai-xhs-note.js');
      const job = await adapter.createXhsNoteFromConfirmedChat({ actor, input: { ...plan.options, brandName: plan.brandName, brief: plan.brief, fileIds: plan.fileIds, requestKey: `chat_${session.id}_${row.version}` }, output: plan.output, chatEvidence: authority.provenance });
      generation = { kind: 'xhs', planVersion: row.version, jobId: job.id || job.jobId, pollUrl: `/content/ai-xhs-note/jobs/${job.id || job.jobId}` };
      q.run('UPDATE native_chat_plans SET generation_json=? WHERE tenant_id=? AND id=?', JSON.stringify(generation), curTenant(), row.id);
      await adapter.startXhsNoteImages({ actor, jobId: generation.jobId, requestKey: `chat_images_${session.id}_${row.version}`, outputHash: job.outputHash, ...plan.options, runtime: xhsRuntime });
    }
  } catch (error) {
    // Approval stays durable. Never create another paid job after an uncertain
    // media hand-off; any existing job receipt remains available for inspection.
    q.run("UPDATE native_chat_sessions SET status='failed' WHERE tenant_id=? AND id=?", curTenant(), session.id);
    throw error;
  }
  // The media job owns its asynchronous state. The conversation may continue;
  // later plans retain this generation's version for correct UI association.
  q.run("UPDATE native_chat_sessions SET status='ready',updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?", curTenant(), session.id);
  return { session: publicNativeChatSession(actor, session.id), generation };
}
