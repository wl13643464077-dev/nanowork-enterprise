import Anthropic from '@anthropic-ai/sdk';
import { q, getConfig, curTenant, promptOverride } from '../db.js';
import { today } from '../util.js';
import * as yunwu from './yunwu.js';
import { skillByKey, skillFallbackFor } from './skills.js';
import { roleListAllows } from './access.js';
import { wrapUntrusted, UNTRUSTED_GUARD } from './risk.js';
import { employeeTemplateFallback } from '../employee-workbench.js';
import { refsBlock, webSearch } from './websearch.js';

// ===== AI 编排服务（PRD V2 §15）：云雾API主通道（按角色分层路由模型）→ Claude备用 → 知识库模板引擎兜底 =====
const MODEL = process.env.AI_MODEL || 'claude-opus-4-8';
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ timeout: 20000, maxRetries: 1 }) : null;

export const aiAvailable = () => yunwu.yunwuAvailable() || !!client;
export const aiChannel = () => (yunwu.yunwuAvailable() ? 'yunwu' : client ? 'claude' : 'template');
let tokenUsage = { input: 0, output: 0, calls: 0 };
export const getTokenUsage = () => tokenUsage;

// 知识库注入：按分类取生效文档，截断（PRD §15.3 单次≤3000字）
// 可运营提示词（系统管理·提示词模板）：老板升级保存后全员即时生效
export function promptFor(code, fallback = '') {
  const base = q.get('SELECT role_card, output_rule, style FROM prompts WHERE code = ?', code) || {};
  const ov = promptOverride(code) || {};
  const role_card = ov.role_card ?? base.role_card;
  const output_rule = ov.output_rule ?? base.output_rule;
  const style = ov.style ?? base.style;
  const parts = [role_card, output_rule, style].filter(Boolean);
  return parts.length ? parts.join('；') : fallback;
}

// 余弦相似度（两向量已等维）
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// AI-C2：最小相似度阈值（后台 rag_min_similarity 可调，env RAG_MIN_SIMILARITY 兜底）。
// 低于阈值的块视为与问题无关，宁可不注入也不硬塞进 prompt 污染回答。
const RAG_MIN_SIM_DEFAULT = 0.25;
export function ragMinSimilarity() {
  const v = Number(getConfig('rag_min_similarity', null) ?? process.env.RAG_MIN_SIMILARITY);
  return Number.isFinite(v) ? Math.min(0.95, Math.max(0, v)) : RAG_MIN_SIM_DEFAULT;
}

// AI-C2 纯函数（可单测）：语义候选按相似度排序 + 阈值截断 + 组装注入文本。
// candidates: [{ doc:{id,category,title}, text, sim, seq }]；sim=-1 表示该候选无向量，同样被阈值挡下。
// 返回 { ctx, refs }，refs 去重到文档粒度并携带本轮最高相似度（引用溯源用）。
export function selectKbExcerpts(candidates = [], { minSim = RAG_MIN_SIM_DEFAULT, maxChars = 3000, excerptChars = 1200, maxExcerpts = 6 } = {}) {
  const eligible = candidates.filter(c => c.doc && c.sim >= minSim).sort((a, b) => b.sim - a.sim);
  let ctx = '';
  const used = new Map();
  let excerpts = 0;
  for (const cand of eligible) {
    const header = `\n【${cand.doc.category}·${cand.doc.title}${cand.seq != null ? `·段${cand.seq + 1}` : ''}】\n`;
    const remaining = maxChars - ctx.length - header.length - 1;
    if (remaining <= 0) break;
    // One long document must not crowd every other relevant source out of the prompt.
    const excerpt = String(cand.text || '').slice(0, Math.min(excerptChars, remaining)).trim();
    if (!excerpt) continue;
    ctx += `${header}${excerpt}\n`;
    const prev = used.get(cand.doc.id);
    if (!prev || cand.sim > prev.sim) {
      used.set(cand.doc.id, { id: cand.doc.id, category: cand.doc.category, title: cand.doc.title, sim: Math.round(cand.sim * 1000) / 1000 });
    }
    if (++excerpts >= maxExcerpts) break; // Top-K 上限
  }
  return { ctx, refs: [...used.values()] };
}

// 知识库检索（真向量 RAG，AI-C2 加固版）：按分类+权限取候选 → query 向量化按余弦相似度召回 Top-K（≤3000字）
// 返回 { text, refs, degraded, mode }：
//   mode='semantic' 向量召回（阈值截断后可能为空=知识库与问题无关，不再硬塞热度内容）
//   mode='hot'      热度排序（无 query 属正常模式；embedding 失败/库未向量化时 degraded=true 并打点告警）
export async function kbSearch(categories = [], role = null, query = null, options = {}) {
  // “员工产出”是用户主动入档的跨场景知识，所有 AI 入口都应可按语义抽调。
  const cats = [...new Set([...(categories.length ? categories : ['品牌资料', '招商政策', '话术案例', '客户画像']), '员工产出'])];
  const list = cats.map(() => '?').join(',');
  let docs = q.all(`SELECT id, category, title, body, callable_roles, embedding, ref_count FROM kb_docs WHERE tenant_id = ${curTenant()} AND enabled = 1 AND category IN (${list})`, ...cats);
  if (role && role !== 'boss') docs = docs.filter(d => {
    return roleListAllows(d.callable_roles, role);
  });
  if (!docs.length) return { text: '', refs: [], degraded: false, mode: 'empty' };

  const qvec = query ? await yunwu.embed(query, options.embedTimeoutMs, options.signal) : null;
  let text = '';
  let refs = [];
  let mode = 'hot';
  let degraded = false;
  let useHot = !qvec;
  if (query && !qvec) {
    // AI-C2②：embedding 超时/失败不再被当成“检索成功”静默吞掉——打点告警 + 结果标记降级
    degraded = true;
    console.warn(`[rag] 查询向量化失败或超时（tenant=${curTenant()}），已降级 ref_count 热度排序，结果未经语义相关性校验`);
  }
  if (qvec) {
    // 分块召回：有块的文档按块打分（长文档后半段也能命中），无块的文档按整文向量打分，统一排序
    const byId = new Map(docs.map(d => [d.id, d]));
    const ids = docs.map(d => d.id);
    const chunkRows = q.all(`SELECT doc_id, seq, text, embedding FROM kb_chunks WHERE doc_id IN (${ids.map(() => '?').join(',')})`, ...ids);
    const chunkedDocIds = new Set(chunkRows.map(c => c.doc_id));
    const candidates = [];
    for (const c of chunkRows) {
      let sim = -1;
      if (c.embedding) { try { sim = cosine(qvec, JSON.parse(c.embedding)); } catch { /* 坏向量降级 */ } }
      candidates.push({ doc: byId.get(c.doc_id), text: String(c.text || ''), sim, seq: c.seq });
    }
    for (const d of docs) {
      if (chunkedDocIds.has(d.id)) continue;
      let sim = -1;
      if (d.embedding) { try { sim = cosine(qvec, JSON.parse(d.embedding)); } catch { /* 坏向量降级 */ } }
      candidates.push({ doc: d, text: String(d.body || ''), sim, seq: null });
    }
    if (!candidates.some(c => c.sim >= 0)) {
      // 库未向量化：热度兜底，但如实标记降级（不冒充语义检索成功）
      useHot = true;
      degraded = true;
      console.warn(`[rag] 知识库候选均无向量（tenant=${curTenant()}），已降级 ref_count 热度排序，请触发向量回填`);
    } else {
      const picked = selectKbExcerpts(candidates, { minSim: ragMinSimilarity() });
      text = picked.ctx;
      refs = picked.refs;
      mode = 'semantic'; // 阈值截断后可能为空注入：知识库与本问题无关，属正常结果而非降级
    }
  }
  if (useHot) {
    // 无 query / 向量化失败 / 库未向量化：退回热度排序整文摘录（不阻塞 AI）
    const ranked = [...docs].sort((a, b) => (b.ref_count || 0) - (a.ref_count || 0));
    let excerpts = 0;
    for (const d of ranked) {
      const header = `\n【${d.category}·${d.title}】\n`;
      const remaining = 3000 - text.length - header.length - 1;
      if (remaining <= 0) break;
      const excerpt = String(d.body || '').slice(0, Math.min(1200, remaining)).trim();
      if (!excerpt) continue;
      text += `${header}${excerpt}\n`;
      refs.push({ id: d.id, category: d.category, title: d.title, sim: null });
      if (++excerpts >= 6) break; // Top-K 上限
    }
    mode = 'hot';
  }
  // BE-M7：批量计数——单条 UPDATE 代替逐文档写（每次检索 N 次写 → 1 次写）
  if (refs.length) {
    const ids = refs.map(r => r.id);
    q.run(`UPDATE kb_docs SET ref_count = ref_count + 1 WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  }
  return { text, refs, degraded, mode };
}

// 兼容入口：仅要注入文本的调用方（generate-ppt/活动方案等）继续拿字符串
export async function kbContext(categories = [], role = null, query = null, options = {}) {
  return (await kbSearch(categories, role, query, options)).text;
}

function styleCard() {
  const ov = promptOverride('PROMPT-03');
  const p = ov || q.get(`SELECT style FROM prompts WHERE code = 'PROMPT-03'`);
  return p?.style || '表达风格：有格局、有能量、有商业穿透力，但接地气、能执行；禁用浮夸空话与绝对化用语；价格、优惠与收益没有可靠依据时不填具体数字，并标注“以有权限负责人书面确认为准”。';
}
function outputRule() {
  const ov = promptOverride('PROMPT-02');
  const p = ov || q.get(`SELECT output_rule FROM prompts WHERE code = 'PROMPT-02'`);
  return p?.output_rule || '输出须具体可执行：涉及任务时包含【今日目标】【具体动作】【话术】【执行人】【截止时间】【检查标准】六要素。';
}

function anthropicContent(content) {
  if (!Array.isArray(content)) return String(content ?? '');
  const blocks = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image_url') {
      const url = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
      const match = String(url || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/);
      if (match) blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: '（本轮多模态内容无法转换）' }];
}

export function toAnthropicMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message && ['user', 'assistant'].includes(message.role))
    .map(message => ({ role: message.role, content: anthropicContent(message.content) }));
}

async function callClaude(system, userMsg, maxTokens = 2000, messages, { deep = false, timeoutMs, responseSchema } = {}) {
  // adaptive thinking：模型按问题难度自适应深思（Opus 4.8 不传 thinking 则完全不思考，须显式开启）
  // effort：深度会诊 high、常规内容 medium（成本/时延平衡）
  // cache_control（顶层自动缓存）：多轮会诊/员工对话的历史前缀命中缓存，费用约降 90%、响应更快
  // AI-C3：结构化输出走官方 output_config.format（json_schema），保证正文是合法 JSON，不再靠正则抠
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: Math.max(maxTokens, deep ? 8000 : 4000), // thinking 与正文共享 max_tokens，留足余量防截断
    thinking: { type: 'adaptive' },
    output_config: { effort: deep ? 'high' : 'medium', ...(responseSchema ? { format: { type: 'json_schema', schema: responseSchema.schema } } : {}) },
    cache_control: { type: 'ephemeral' },
    system, messages: toAnthropicMessages(messages || [{ role: 'user', content: userMsg }]),
  }, { timeout: Math.max(Number(timeoutMs) || 0, deep ? 105000 : 60000) });
  const usage = { inputTokens: resp.usage?.input_tokens || 0, outputTokens: resp.usage?.output_tokens || 0 };
  tokenUsage.input += usage.inputTokens;
  tokenUsage.output += usage.outputTokens;
  tokenUsage.calls += 1;
  return { text: resp.content.filter(b => b.type === 'text').map(b => b.text).join(''), usage };
}

// Claude 流式：SDK stream 助手，text 事件逐段回调，finalMessage 拿完整用量
async function callClaudeStream(system, userMsg, maxTokens = 2000, messages, { deep = false, timeoutMs, onDelta, responseSchema } = {}) {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: Math.max(maxTokens, deep ? 8000 : 4000),
    thinking: { type: 'adaptive' },
    output_config: { effort: deep ? 'high' : 'medium', ...(responseSchema ? { format: { type: 'json_schema', schema: responseSchema.schema } } : {}) },
    cache_control: { type: 'ephemeral' },
    system, messages: toAnthropicMessages(messages || [{ role: 'user', content: userMsg }]),
  }, { timeout: Math.max(Number(timeoutMs) || 0, deep ? 105000 : 60000) });
  stream.on('text', t => onDelta?.(t));
  const resp = await stream.finalMessage();
  const usage = { inputTokens: resp.usage?.input_tokens || 0, outputTokens: resp.usage?.output_tokens || 0 };
  tokenUsage.input += usage.inputTokens;
  tokenUsage.output += usage.outputTokens;
  tokenUsage.calls += 1;
  return { text: resp.content.filter(b => b.type === 'text').map(b => b.text).join(''), usage };
}

// 统一入口：云雾（按 role 路由模型）→ Claude → 模板引擎
// 返回 {text, mode, model, usage:{inputTokens,outputTokens}} 供积分引擎实扣
// 流式：传 onDelta 即走流式通道逐段回调；某通道输出一半失败切换下一通道时先回调 onReset（客户端清屏重来）
// AI-C3：responseSchema={name,schema} 时云雾走 OpenAI response_format(json_schema)、Claude 走 output_config.format，
// 模型层保证 JSON 合法；任一通道不支持时报错沿既有降级链继续（云雾→Claude→模板），不会 502。
export async function generate({ kind, system, userMsg, fallback, maxTokens = 2000, role = 'sales', model, messages, timeoutMs, signal, deep = false, onDelta, onReset, responseSchema }) {
  let emitted = 0;
  const tapDelta = onDelta ? (t) => { emitted += t.length; onDelta(t); } : undefined;
  const resetIfPartial = () => { if (emitted > 0) { emitted = 0; onReset?.(); } };
  if (yunwu.yunwuAvailable()) {
    try {
      const params = {
        role, model, system, maxTokens, timeoutMs, signal,
        responseFormat: responseSchema ? yunwu.jsonSchemaFormat(responseSchema.name, responseSchema.schema) : undefined,
        messages: messages || [{ role: 'user', content: userMsg }],
      };
      const r = tapDelta ? await yunwu.chatStream({ ...params, onDelta: tapDelta }) : await yunwu.chat(params);
      tokenUsage.calls++; tokenUsage.input += r.inputTokens; tokenUsage.output += r.outputTokens;
      return { text: r.text, mode: 'api', model: r.model, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens } };
    } catch (e) {
      if (e?.status === 499 || signal?.aborted) throw e;
      console.error(`[ai] ${kind} 云雾调用失败(${e?.message})，尝试备用通道`);
      resetIfPartial();
    }
  }
  if (client) {
    try {
      const claude = tapDelta
        ? await callClaudeStream(system, userMsg, maxTokens, messages, { deep, timeoutMs, onDelta: tapDelta, responseSchema })
        : await callClaude(system, userMsg, maxTokens, messages, { deep, timeoutMs, responseSchema });
      return { text: claude.text, mode: 'api', model: MODEL, usage: claude.usage };
    } catch (e) {
      if (e?.status === 499 || signal?.aborted) throw e;
      console.error(`[ai] ${kind} Claude调用失败，降级模板模式:`, e?.message);
      resetIfPartial();
    }
  }
  const text = fallback();
  onDelta?.(text); // 模板兜底：一次性推给流式客户端
  return { text, mode: 'template', model: 'template', usage: { inputTokens: 0, outputTokens: 0 } };
}

// ===== 模板引擎：知识库变量填充 + 轮换（保证无 Key 时演示可用且贴近业务）=====
const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];
let seedCounter = Date.now() % 997;
const nextSeed = () => (seedCounter = (seedCounter * 31 + 7) % 100003);

const HOOKS = [
  '同样是招牌菜，为什么有的顾客吃完还会再来？', '餐饮老板，今天的客流高峰准备好了吗？',
  '菜单不是菜名清单，而是门店最重要的成交页面', '一道新品上架前，先把成本、出品和顾客反馈算清楚',
  '节日聚餐怎么设计套餐，顾客更容易看懂？', '门店体验做得好，顾客才愿意主动推荐',
];
const SCENES = ['工作日午餐', '周末家庭聚餐', '企业团建用餐', '外卖晚餐', '节日聚餐', '会员复购'];
const PAINS = ['客流波动大', '顾客看菜单难选择', '到店后等待流失', '会员复购偏低', '备货与损耗难平衡'];

export function tplShortVideo(topic, n = 3) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = nextSeed();
    out.push(`【短视频脚本 ${i + 1}】主题：${topic}
钩子（前3秒）：${pick(HOOKS, s)}
正文口播：
  很多老板问我，${pick(PAINS, s + 1)}怎么办？今天给你讲透。
  先看门店真实数据：${pick(SCENES, s + 2)}的进店、点单、等位和复购分别卡在哪里，再只改一个关键动作。
  这条视频请用【门店真实菜品】【实测出餐时间】【已核实顾客反馈】替换占位信息，不能编造销量、口碑或效果。
拍摄要点：门店场景开场 → 招牌产品或服务动作特写 → 店员说明 → 清晰字幕
发布建议：话题 #餐饮经营 #${topic}；发布时间以账号历史数据为准
行动入口：邀请顾客查看菜单、预约或咨询；活动、价格与库存经门店确认后再写入`);
  }
  return out.join('\n\n');
}

export function tplMoments(topic, n = 5) {
  const kinds = [
    ['产品介绍', (s) => `围绕${pick(SCENES, s)}，把「${topic}」讲清楚：适合谁、包含什么、怎样点更合适。菜品、分量、价格和供应状态请以门店当日确认信息为准。`],
    ['门店故事', () => `一家门店的可信感，来自每天重复做对的小事。围绕「${topic}」记录一道真实工序、一次服务改进或一项食安检查，不虚构顾客评价和经营结果。`],
    ['活动预告', (s) => `门店计划在本周${pick(['四', '五', '六'], s)}围绕「${topic}」开展到店主题活动。流程、容量、菜单和权益正在由负责人确认，确认后再发布准确报名信息。`],
    ['复购关怀', () => `给老顾客做一次有用的提醒：围绕「${topic}」说明新品、时令菜或服务变化。是否有优惠、何时供应，以门店审核后的信息为准。`],
    ['本地增长', () => `围绕「${topic}」介绍门店服务的真实客群与场景。合作方式、费用、收益和授权范围不由AI承诺，需由负责人书面确认。`],
  ];
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = nextSeed();
    const [tag, fn] = kinds[i % kinds.length];
    out.push(`【朋友圈 ${i + 1}·${tag}】对象：${pick(['周边顾客', '老客户', '本地社群', '意向合作方'], s)}\n${fn(s)}`);
  }
  return out.join('\n\n');
}

export function tplCommunity(topic, n = 3) {
  const t = [
    (s) => `【互动话题】各位群友，${pick(SCENES, s)}时你最在意口味、分量、出餐速度还是环境？欢迎说说真实体验。`,
    () => `【活动预告草稿】门店正在筹备“${topic}”主题活动。请负责人确认日期、容量、菜单、价格和报名方式后再发布，不使用“最后名额”等未经核实的稀缺表达。`,
    () => `【答疑】关于“${topic}”，可以先说明适合人群、可选菜品和到店流程；食材、过敏原、价格与库存问题以门店当天确认信息为准。`,
  ];
  return Array.from({ length: n }, (_, i) => t[i % t.length](nextSeed())).join('\n\n');
}

export function tplInvite(topic, n = 10) {
  const tags = ['新客-咨询', '到店顾客-待回访', '团餐客户-有需求', '老客-待复购', '合作方-待沟通'];
  const goals = ['到店体验', '需求沟通', '用餐方案确认'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = nextSeed();
    const tag = tags[i % tags.length]; const goal = pick(goals, s);
    out.push(`【话术 ${i + 1}】客户类型：${tag} ｜ 邀约目标：${goal}
"${pick(['王总', '李总', '张姐', '陈哥'], s)}，${pick([
      `您好，门店正在准备“${topic}”的到店方案。日期、菜单和可预约时段确认后，我可以把准确信息发给您；您更关注口味、人数还是预算？`,
      `上次您提到${pick(PAINS, s)}，我们可以先按真实需求整理一页“${topic}”方案。您愿意先线上看菜单，还是到店沟通？`,
      `您好，想跟您确认一下近期是否有“${topic}”相关用餐需求。人数、忌口、预算和时间明确后，再由门店给出可执行方案。`,
    ], s + 3)}"
跟进策略：当天未回复→次日上午补一条语音；确认后→会前1天再次确认+当天上午发定位`);
  }
  return out.join('\n\n');
}

export function tplInvestment(topic) {
  return `【招商文案 · 需人工审核后方可外发】主题：${topic}
—— 朋友圈版 ——
我们正在整理餐饮门店合作说明，重点讲清品牌定位、门店模型、运营支持与双方责任。
合作层级、投入、费用、收益模型、区域授权和退出机制，必须以双方审核后的正式文件为准。
AI只生成沟通草稿，不代替尽调、合同审查或经营承诺。
—— 私信邀请版 ——
"您好，我们正在安排一场餐饮门店合作说明会，具体时间和议程确认后可以发给您。现场会说明合作边界与需进一步核验的信息；如您有兴趣，我先了解您的经营经验和关注点。"
⚠️ 风控提示：本内容涉及招商政策表述，已自动进入人工确认队列；收益类数字一律不得由AI填充。`;
}

export function tplRepurchase(topic) {
  return `【会员复购三件套】节点：${topic}
① 私信触达：
"您好，围绕${topic}，门店整理了适合【用餐人数/偏好】的方案草稿。若您愿意，可以告诉我人数、时间和忌口；菜单、价格与可预约时段由门店确认后发给您。"
② 朋友圈：
围绕${topic}，门店将根据真实供应情况发布用餐方案。菜品、价格、预约和优惠信息确认后再公布，不使用未经核实的库存或名额表达。
③ 方案标题建议：《${topic}·按人数与预算整理的用餐方案》
触达清单逻辑：近180天成交客户 + 用餐偏好 + 历史到店记录；只使用已授权客户数据，并按复购价值与联系意愿排序。`;
}

export function tplOffer(topic, n = 6) {
  const scenes = ['到店用餐', '老客复购', '企业团餐', '节日聚餐', '预约订餐', '顾客转介绍'];
  return Array.from({ length: n }).map((_, i) => {
    const scene = scenes[i % scenes.length];
    return `【优惠话术 ${i + 1}｜${scene}】
开场：${scene === '到店用餐' ? '先了解您的用餐人数、口味和时间，再推荐合适菜品，不催您立即下单。' : '我先记录您的需求，实际权益、价格和可预约时段以门店确认单为准。'}
权益表达：围绕「${topic}」整理一版用餐组合草稿；价格、折扣、库存和名额必须由门店核验，不在未确认时对外承诺。
推进句：您方便提供人数、预算、忌口和用餐时间吗？我让门店确认后再回复。`;
  }).join('\n\n');
}

export function tplPartnerPack(theme) {
  return `【协作伙伴每日素材包】${today()} ｜ 今日主题：${theme}
■ 学习卡（5分钟）：讲清门店招牌产品的适合场景、食材信息、口味和点单建议；食品安全与过敏原信息需以门店确认口径为准。
■ 朋友圈素材（审核后使用，配门店当日实拍图）：
1. ${pick(HOOKS, nextSeed())}——请补充已核实的菜品与服务信息。
2. ${theme}，需要了解菜单或到店流程的顾客可以咨询；价格、库存和活动以门店确认为准。
■ 短视频脚本（口播30秒）：钩子"${pick(HOOKS, nextSeed())}" → 三个已核实卖点 → 清晰行动入口
■ 今日邀约动作：按负责人确认的客户名单与联系频次执行；话术见素材库“私聊邀约话术”
■ 晚间打卡（21:00前）：是否学习/是否发圈/是否发视频/邀约人数/意向客户数/今日问题`;
}

export function tplActivityPlan({ title, type, goal, audience, budget, date }) {
  return JSON.stringify({
    title, type, date,
    theme: `${title} · 门店主题用餐活动`,
    flow: [
      { time: '18:30-19:00', item: '签到与用餐需求确认；收集个人信息前先取得授权' },
      { time: '19:00-19:15', item: '门店与菜单介绍：只使用已核实的品牌、食材和工艺信息' },
      { time: '19:15-19:45', item: '招牌产品体验与口味反馈记录；主动询问忌口和过敏原' },
      { time: '19:45-20:05', item: '服务场景说明与真实顾客问题答疑，不编造证言' },
      { time: '20:05-20:25', item: `${goal}方案讲解；若有权益，只发布负责人已审核内容` },
      { time: '20:25-20:40', item: '一对一需求沟通；下单、价格和外部承诺由人工确认' },
      { time: '20:40', item: '反馈回收与后续联系授权确认' },
    ],
    materials: ['按核定人数准备的餐具与食材', '过敏原与食安提示', '签到与授权说明', '菜单/方案手册', '反馈表', '已审核权益说明（如有）'],
    invites: `从已授权CRM客户中圈选：${audience}；活动容量、桌型和接待人手由门店负责人按场地与服务能力核定`,
    sop: ['确认活动目标与容量', '负责人审核菜单、价格和权益', '活动前确认并发送准确信息', '现场记录需求与异常', '经客户授权后回访', '依据真实数据复盘'],
    kpi: { 邀约确认率: '待按历史数据设定', 报名到场率: '待按历史数据设定', 现场成交率: '待按历史数据设定', 加微率: '仅统计已授权客户', 'ROI': '按真实收入与成本核算' },
    budgetNote: `预算档位：${budget || '待确认'}；食材、人员、场地、物料与损耗成本需由门店逐项核验`,
  });
}

function attachmentEvidence(attachments = []) {
  if (!attachments.length) return '';
  return attachments.slice(0, 3).map(a => {
    const name = a?.name || '上传文件';
    const lines = String(a?.content || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 8);
    const preview = lines.join('\n').slice(0, 700) || '文件内容为空，无法读取有效字段';
    return `- 我已读取【用户上传·${name}】；依据【用户上传·${name}】可见的内容片段：\n${preview}`;
  }).join('\n');
}

export function tplDiagnosis(diagType, question, dataSummary, attachments = [], recommendedMarshals = []) {
  const attachSection = attachments.length
    ? `\n\n② 上传文件依据\n${attachmentEvidence(attachments)}\n\n基于【用户上传·${attachments[0]?.name || '上传文件'}】的可读内容，本次判断会优先参考文件字段与表格样本；若需要更精确结论，请继续补充完整成交额、客户阶段、跟进次数、负责人等字段。`
    : '';
  return `【${diagType || '经营诊断'}】围绕您的问题「${question}」，基于近30天经营数据给出初步判断：

① 问题判断
${dataSummary.bottleneck ? `数据显示当前漏斗最大卡点在「${dataSummary.bottleneck}」环节，` : ''}本月营收完成率 ${dataSummary.revenueRate}%，线索成交率 ${dataSummary.convRate}%，协作伙伴日均活跃率 ${dataSummary.partnerRate}%。${dataSummary.revenueRate < 80 ? '目标达成存在缺口，需要立即聚焦高确定性动作。' : '整体节奏健康，可考虑放大获客投入。'}

${attachSection}

${attachments.length ? '③' : '②'} 数据依据
近30天：新增线索 ${dataSummary.leads}，邀约 ${dataSummary.invited}，到店 ${dataSummary.arrived}，成交 ${dataSummary.deals} 单 / ¥${Number(dataSummary.amount || 0).toLocaleString()}；A类客户 ${dataSummary.aCount} 人待攻坚。

${attachments.length ? '④' : '③'} 建议动作（按优先级）
1.【今日目标】A类客户全量触达 ｜【执行人】销售团队 ｜【截止】今日20:00 ｜【检查标准】每人新增跟进记录
2.【今日目标】生成“${dataSummary.festival || '当季主题'}”日更内容包并进入审核 ｜【执行人】品牌与增长部 ｜【截止】10:00 ｜【检查标准】菜品、价格、库存与活动信息均有核验记录
3.【本周目标】按场地与服务能力设计1场到店主题活动 ｜【执行人】门店运营部 ｜【检查标准】按门店历史基线记录邀约、到场、成交与顾客反馈

${attachments.length ? '⑤' : '④'} 需要您拍板的事项
- ${dataSummary.pendingApprovals || 0} 条高风险内容待终审
- 高预算、特殊折扣或需对外承诺的A类客户，是否由您亲自确认（建议名单见会员增长·重点客户）

是否需要我转派对应数字员工分部深入会诊？（推荐：${recommendedMarshals.map(item => item.name).join(' + ') || '请选择合适数字员工分部'}）`;
}

function historyAttachmentExcerpts(history = [], limit = 3) {
  const attachments = [];
  for (const item of Array.isArray(history) ? history : []) {
    const text = String(item?.content || '');
    const pattern = /【历史附件·([^】\n]{1,200})】\n([\s\S]*?)(?=\n【历史附件·|$)/g;
    for (const match of text.matchAll(pattern)) {
      attachments.push({ name: match[1], content: match[2].trim().slice(0, 5000), historical: true });
      if (attachments.length >= limit) return attachments;
    }
  }
  return attachments;
}

export function tplMarshalOutput(marshal, task) {
  const rawDivisionNumber = Number.parseInt(String(marshal.code || '').slice(2), 10);
  // 历史库的第9/10分部任务仍可读取，但职责分别归并到当前的数据分部和合规分部。
  const divisionCode = rawDivisionNumber === 9 ? 'M-07' : rawDivisionNumber === 10 ? 'M-03' : marshal.code;
  const currentRole = [marshal.name, marshal.title, marshal.duty, marshal.skills].filter(Boolean).join(' ');
  const expectedDomain = {
    'M-01': /战略|开店|筹备|选址|定位/,
    'M-02': /菜单|产品|菜品|研发|定价/,
    'M-03': /食安|食品安全|合规|审核|风险/,
    'M-04': /供应链|库存|采购|损耗|供应商/,
    'M-05': /门店|运营|服务|排班|现场/,
    'M-06': /品牌|增长|营销|内容|获客/,
    'M-07': /财务|数据|成本|分析|复盘|洞察/,
    'M-08': /连锁|可持续|加盟|复制|组织/,
  }[divisionCode];
  if (expectedDomain && !expectedDomain.test(currentRole)) {
    return `【${marshal.name}交付】${task.title}\n职责定位：${marshal.duty || marshal.title || '按当前企业配置执行'}\n能力范围：${marshal.skills || '以当前任务为准'}\n\n1. 任务判断：围绕“${task.title}”先确认目标、对象与约束。\n2. 执行动作：按优先级拆成负责人、截止时间和检查标准。\n3. 交付要求：${task.requirement || '输出可直接执行的方案，并标明需要老板确认的事项。'}\n4. 风险边界：涉及价格、收益、合同或对外承诺时，必须人工确认。`;
  }
  const m = {
    'M-01': () => `【开店与战略判断】${task.title}\n先核对目标客群、商圈、门店模型、预算和时间约束，再形成选址/开店/经营优先级清单。缺少客流、租金或竞争数据时只列假设，不编造结论。`,
    'M-02': () => `【菜单与产品方案】${task.title}\n场景：${pick(SCENES, nextSeed())}。请补齐菜品成本、售价、销量、毛利、出品时长与顾客反馈后再排序。涉及食材、过敏原、价格和供应状态时，以门店与负责人确认信息为准。`,
    'M-03': () => `【食安与合规检查】${task.title}\n检查食品安全、广告表达、个人信息、合同与对外承诺风险。AI只提供风险清单和待核验项；监管结论、整改完成状态与外发内容必须由具备权限的负责人确认。`,
    'M-04': () => `【供应链与库存建议】${task.title}\n${task.requirement || ''}\n按真实库存、销量、交期、保质期和损耗记录计算补货建议。缺少字段时列出数据缺口，不臆测可用库存或供应商履约能力。`,
    'M-05': () => `【门店运营动作】${task.title}\n围绕客流、等位、点单、出餐、服务与闭店复盘拆解动作。排班、服务容量和完成时限需由店长结合当日实际确认；异常与顾客反馈要留痕。`,
    'M-06': () => `【品牌与增长方案】${task.title}\n${task.requirement || ''}\n按目标客群、真实产品信息和渠道数据设计内容与到店路径。不得编造顾客证言、销量或“最后名额”；价格、优惠、库存和活动容量由门店审核后发布。`,
    'M-07': () => `【财务与数据解读】${task.title}\n先说明统计周期、口径和数据完整性，再定位营收、毛利、损耗、客流或漏斗卡点。只基于可追溯数据给结论；预测必须标注假设，并列出需要负责人确认的成本与财务口径。`,
    'M-08': () => `【连锁与可持续方案】${task.title}\n先验证单店SOP、人员能力、供应稳定性和单位经济模型，再讨论复制。加盟、收益、区域授权与合同条款不得由AI承诺，必须经过尽调和人工审批。`,
  };
  return (m[divisionCode] || (() => `【${marshal.name}产出】${task.title}\n${outputRule()}`))();
}
function nextFestivalName() {
  const f = [['2026-06-19', '端午'], ['2026-09-25', '中秋'], ['2026-12-20', '年会季'], ['2027-02-11', '春节']];
  const t = today();
  return (f.find(x => x[0] >= t) || f[0])[1];
}

// ===== AI-C3 结构化输出 JSON Schema（云雾 response_format 与 Claude output_config.format 通用）=====
// 约束：所有 object 必须 additionalProperties:false + 全字段 required（Claude 严格模式要求），不用 min/max 等不支持的关键字
export const PPT_DECK_SCHEMA = {
  name: 'ppt_deck',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'subtitle', 'pages'],
    properties: {
      title: { type: 'string', description: '演示文稿主标题' },
      subtitle: { type: 'string', description: '副标题' },
      pages: {
        type: 'array',
        description: '正文页（封面页不算在内）',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'bullets', 'note'],
          properties: {
            title: { type: 'string', description: '页标题' },
            bullets: { type: 'array', items: { type: 'string' }, description: '每页3-5条要点，每条≤24字' },
            note: { type: 'string', description: '演讲备注一句话（口语化提词）' },
          },
        },
      },
    },
  },
};

export const ACTIVITY_PLAN_SCHEMA = {
  name: 'activity_plan',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['theme', 'flow', 'materials', 'invites', 'sop', 'kpi', 'budgetNote'],
    properties: {
      theme: { type: 'string', description: '活动主题' },
      flow: {
        type: 'array',
        description: '活动流程（按时间排序）',
        items: {
          type: 'object', additionalProperties: false, required: ['time', 'item'],
          properties: { time: { type: 'string' }, item: { type: 'string' } },
        },
      },
      materials: { type: 'array', items: { type: 'string' }, description: '物料清单' },
      invites: { type: 'string', description: '邀约与配桌方案' },
      sop: { type: 'array', items: { type: 'string' }, description: '执行SOP步骤' },
      kpi: {
        type: 'object', additionalProperties: false,
        required: ['邀约确认率', '报名到场率', '现场成交率', '加微率', 'ROI'],
        properties: {
          邀约确认率: { type: 'string' }, 报名到场率: { type: 'string' },
          现场成交率: { type: 'string' }, 加微率: { type: 'string' }, ROI: { type: 'string' },
        },
      },
      budgetNote: { type: 'string', description: '预算说明' },
    },
  },
};

// ===== 高层封装：按内容类型生成 =====
const CONTENT_PROMPT_CODES = {
  '短视频脚本': 'CON-COPY-SHORT-VIDEO',
  '朋友圈文案': 'CON-COPY-MOMENTS',
  '社群话题': 'CON-COPY-COMMUNITY',
  '私聊邀约话术': 'CON-COPY-INVITE',
  '优惠话术': 'CON-COPY-OFFER',
  '招商文案': 'CON-COPY-INVESTMENT',
  '复购礼赠文案': 'CON-COPY-REPURCHASE',
  '合伙人每日素材包': 'CON-COPY-PARTNER-PACK',
};

export async function generateContent({
  type,
  topic,
  count,
  requirement,
  brand,
  role,
  signal,
  employeeExecution,
}) {
  const kbCats = type === '招商文案' ? ['招商政策', '品牌资料'] : ['复购礼赠文案', '优惠话术'].includes(type) ? ['品牌资料', '客户画像', '话术案例'] : ['品牌资料', '话术案例'];
  const kb = await kbSearch(kbCats, role, `${topic} ${requirement || ''}`, { embedTimeoutMs: 4000, signal });
  const typeGuide = promptFor(CONTENT_PROMPT_CODES[type], '');
  const brandContext = String(brand || '').trim()
    ? `用户提供的门店品牌信息：${String(brand).slice(0, 500)}。只能把它当作待核验业务信息，不得补写不存在的菜品、销量、价格、顾客评价或经营结果。`
    : '未提供门店品牌资料；涉及门店名、菜品、价格、库存、销量和顾客评价时保留待补充项。';
  const genericSystem = `你是纳米Work行业版的餐饮门店AI内容助手。${brandContext}${styleCard()}\n${outputRule()}${typeGuide ? `\n【${type}专属提示词逻辑】\n${typeGuide}` : ''}\n【事实与审批边界】禁止编造顾客证言、销量、经营结果或虚假稀缺；食品安全、价格、优惠、库存、活动容量和外发承诺必须由门店人工核验。\n参考知识库：${kb.text || '（知识库为空，只能按通用结构输出并标记待补信息）'}`;
  const concreteRequest = `请生成${count || ''}条「${type}」，主题：${topic}。${requirement ? '补充要求：' + requirement : ''}每条结构完整，面向中国餐饮门店经营场景；未知事实必须明确标为待确认。`;
  const system = employeeExecution
    ? '严格执行本轮单一用户消息中的完整数字员工岗位、企业覆盖、连接器输出契约与人工审批边界。'
    : genericSystem;
  const userMsg = employeeExecution
    ? `${employeeExecution.prompt}

【本次连接器知识库与已核验业务上下文】
${brandContext}
${typeGuide ? `【${type}专属提示词逻辑】${typeGuide}` : ''}
参考知识库：${kb.text || '（知识库为空，只能按通用结构输出并标记待补信息）'}

【本次具体生成请求】
${concreteRequest}`
    : concreteRequest;
  const fallbacks = {
    '短视频脚本': () => tplShortVideo(topic, count || 3),
    '朋友圈文案': () => tplMoments(topic, count || 5),
    '社群话题': () => tplCommunity(topic, count || 3),
    '私聊邀约话术': () => tplInvite(topic, count || 10),
    '优惠话术': () => tplOffer(topic, count || 6),
    '招商文案': () => tplInvestment(topic),
    '复购礼赠文案': () => tplRepurchase(topic),
    '合伙人每日素材包': () => tplPartnerPack(topic),
  };
  const fallback = fallbacks[type] || (() => `【${type}】主题：${topic}\n${tplMoments(topic, 2)}`);
  const outputLength = employeeExecution?.config?.outputLength;
  const maxTokens = outputLength === 'full' ? 4000 : outputLength === 'lite' ? 1800 : 3000;
  const configuredModel = String(employeeExecution?.config?.textModel || '').trim();
  const timeoutMs = Number(employeeExecution?.config?.timeoutSeconds) > 0
    ? Number(employeeExecution.config.timeoutSeconds) * 1000
    : 85000;
  const out = await generate({
    kind: type,
    system,
    userMsg,
    fallback,
    maxTokens,
    role,
    model: configuredModel && configuredModel !== 'inherit' ? configuredModel : undefined,
    timeoutMs,
    signal,
  });
  // AI-C2：把本次引用的知识文档与降级标记随结果带回（落库溯源 + 响应标记由路由层完成）
  return { ...out, kb: { refs: kb.refs, degraded: kb.degraded, mode: kb.mode } };
}

export async function advisorReply({ diagType, question, dataSummary, role, marshal, attachments, webRefs, deep, history = [], memory = '', marshalCatalog = [], recommendedMarshals = [], signal, onDelta, onReset }) {
  const kb = await kbSearch([], role, question, { embedTimeoutMs: 4000, signal });
  const effectiveAttachments = (attachments || []).length ? attachments : historyAttachmentExcerpts(history);
  const styleExtra = promptFor('ADVISOR-STYLE', '');
  const persona = marshal
    ? `本次会诊由「${marshal.name}」（${marshal.title || '企业智能体'}）主答。当前职责：${marshal.duty || '按本轮问题执行'}；当前能力：${marshal.skills || '按当前职责执行'}。这些当前配置优先于历史提示词。${marshal.prompt ? `工作方法参考：${marshal.prompt}` : ''}`
    : '';
  // AI-H2 防注入：附件正文/历史附件/联网 snippet 一律包进明确边界后再进 prompt，不再裸拼
  const attachText = effectiveAttachments.map(a => `\n${wrapUntrusted(`${a.historical ? '历史附件' : '用户上传'}·${a.name}`, String(a.content).slice(0, 4000))}`).join('');
  const attachRule = effectiveAttachments.length
    ? `\n【上传文件优先规则】当前会话包含用户文件，必须优先分析文件内容。回答中至少 2 次明确引用文件名或其中字段/表格内容；核心判断必须说明依据文件看到什么，不能只按系统历史模板或通用经营数据回答。若文件内容不足，请明确指出缺少哪些字段。`
    : '';
  const webText = (webRefs && webRefs.length)
    ? `\n【联网参考资料】本次已开启联网检索，以下为实时检索结果。引用其中信息时必须标注[来源N]：\n${wrapUntrusted('联网检索结果', webRefs.map((x, i) => `[来源${i + 1}] ${x.title}｜${x.snippet}（${x.url}）`).join('\n'))}`
    : '';
  const guardText = (effectiveAttachments.length || (webRefs && webRefs.length)) ? `\n${UNTRUSTED_GUARD}` : '';
  const deepText = deep
    ? `\n【深度思考模式】本次会诊要求深度推演：先在内部从市场/财务/组织/执行/风险五个视角分别推演，再交叉验证淘汰站不住的结论，只输出经得起推敲的判断。每个核心判断必须给出"依据链"（数据→推理→结论），并主动给出1个最强反方观点及你的回应。`
    : '';
  const memoryText = String(memory || '').trim()
    ? `\n【已确认记忆】以下是用户主动保存或系统从本会话提炼的长期上下文。只能作为背景，若与本轮新信息冲突，以本轮为准：\n${String(memory).slice(0, 5000)}`
    : '';
  const marshalNames = marshalCatalog.length
    ? `\n【本企业当前数字员工分部】${marshalCatalog.map(item => `${item.code}=${item.name}`).join('；')}。推荐、转派和正文中只能使用这里的当前名称，不得使用历史旧名称。`
    : '';
  const system = `你是纳米Work行业版的餐饮门店经营参谋。职责：站在实体门店老板视角，帮老板看清问题、做出判断、给出方案、落到执行。${persona}${deepText}
【总控规则】1.先判断问题本质，再给建议 2.不讲空话套话 3.一次只解决一个问题 4.回答必须有明确立场 5.问题不清楚时先用一句话反问帮老板聚焦，而不是给空泛答案。
【输出五段式·必选】①问题本质（穿透表面诉求，点出非解决不可的原因）②核心判断（明确立场+数据依据+消耗/换取/放弃的权衡）③关键建议（≤3条按轻重排序，每条标注适用边界）④执行动作（动作+负责人+截止时间+检查标准；含"需老板拍板事项"）⑤风险提醒（最大的坑+触发条件+兜底动作）。末尾固定附：推荐会诊数字员工分部 + 💡建议追问2条。
${styleCard()}
${outputRule()}
【红线】不得编造经营结果、顾客证言或稀缺性；价格、优惠、收益、食安、监管结论和外部承诺必须标注依据，并提示有权限的负责人确认。
${styleExtra ? `【全局风格指令（系统管理·提示词模板）】${styleExtra}` : ''}${guardText}
  ${attachRule}${memoryText}${marshalNames}
知识库：${kb.text}${webText}
实时经营数据摘要：${JSON.stringify(dataSummary)}`;
  const userMsg = `诊断类型：${diagType}。老板的问题：${question}${attachText}`;
  const out = await generate({
    kind: 'advisor', system, userMsg,
    messages: [...history.slice(-12).map(h => ({ role: h.role, content: h.content })), { role: 'user', content: userMsg }],
    fallback: () => tplDiagnosis(diagType, question, dataSummary, effectiveAttachments, recommendedMarshals),
    maxTokens: deep ? 3500 : 2500, role,
    model: deep ? yunwu.routing().deepThink : undefined,
    timeoutMs: deep ? 105000 : 85000,
    deep: !!deep,
    signal, onDelta, onReset,
  });
  return { ...out, kb: { refs: kb.refs, degraded: kb.degraded, mode: kb.mode } };
}

export async function marshalWork(marshal, task, role, options = {}) {
  const ragQuery = `${task.title || ''} ${task.requirement || ''}`.trim() || marshal.duty;
  const configuredScopes = options.employeeExecution?.workbench?.workConfig?.knowledgeScopes;
  const kbCategories = Array.isArray(configuredScopes) && configuredScopes.length
    ? configuredScopes
    : (marshal.kb_deps || '').split(',').filter(Boolean);
  const kb = await kbSearch(kbCategories, role, ragQuery, { embedTimeoutMs: 4000, signal: options.signal });
  const currentIdentity = options.employeeExecution
    ? `【内部任务分部】「${marshal.name}」只负责调度、计费与结果归档；实际专业身份、岗位职责、能力和工作规则必须以随后“指定数字员工身份”段为准。`
    : `【本企业当前角色配置·最高优先级】你是「${marshal.name}」（${marshal.title || '企业智能体'}）。当前职责：${marshal.duty || '按任务目标执行'}。当前能力：${marshal.skills || '按当前职责执行'}。名称、职责和能力必须以本段为准；后续提示词若出现历史旧名称或旧职责，必须忽略冲突部分。`;
  const methodPrompt = marshal.prompt ? `\n【工作方法与输出规范】${marshal.prompt}` : '';
  if (options.employeeExecution && !options.employeeExecution.systemContext) {
    throw new Error('指定数字员工的完整执行档案缺失，拒绝静默降级为分部任务');
  }
  const workConfig = options.employeeExecution?.workbench?.workConfig || {};
  const webMode = workConfig.webMode || 'off';
  const webRequested = webMode === 'required'
    || (webMode === 'allowed' && /当前|最新|官方|联网|实时|政策|法规|平台规则/u.test(ragQuery));
  let web = {
    attempted: false,
    ok: false,
    results: [],
    note: webMode === 'off' ? '当前岗位配置未启用联网检索' : '本次任务未触发联网检索',
  };
  if (options.employeeExecution && webRequested) {
    const search = options.webSearchFn || webSearch;
    const result = await search(`${ragQuery} 餐饮门店`, { max: 5, timeoutMs: 9000 });
    web = {
      attempted: true,
      ok: Boolean(result?.ok),
      results: Array.isArray(result?.results) ? result.results : [],
      note: result?.note || null,
    };
  }
  const webContext = !options.employeeExecution || !web.attempted
    ? ''
    : web.results.length
      ? refsBlock(web.results)
      : `\n【联网核验状态】${web.note || '本次未取得可引用的联网结果'}。禁止凭模型记忆冒充实时检索；所有需要当前官方信息的结论必须列入“待核验项”，并说明需要补查的来源。`;
  const employeeContext = options.employeeExecution
    ? `\n\n${options.employeeExecution.systemContext}`
    : '';
  const attachments = Array.isArray(options.attachments) ? options.attachments.slice(0, 6) : [];
  const attachmentContext = attachments.length
    ? `\n\n${UNTRUSTED_GUARD}\n【本次统一文件中心附件】\n${attachments.map(file => {
      const content = String(file?.content || '').trim();
      if (file?.readable && content) {
        return wrapUntrusted(`用户上传·${file.name || '附件'}`, content.slice(0, 5000));
      }
      return `【附件证据·${file?.name || '附件'}】文件已上传，但没有可读正文；只能记录文件证据，不得声称已识图、已阅读或已核验其中内容。`;
    }).join('\n')}`
    : '';
  const system = `${currentIdentity}${employeeContext}${methodPrompt}\n${styleCard()}\n${outputRule()}\n知识库：${kb.text}${webContext}${attachments.length ? `\n${UNTRUSTED_GUARD}` : ''}`;
  const configuredTimeout = Number(workConfig.timeoutSeconds) * 1000;
  const userMsg = `任务：${task.title}\n类型：${task.type || '常规'}\n要求：${task.requirement || '按职责输出可执行结果'}${attachmentContext}`;
  const image = typeof options.image === 'string' ? options.image : '';
  const configuredModel = image
    ? workConfig.visionModel || workConfig.textModel || undefined
    : workConfig.textModel || undefined;
  const maxTokens = workConfig.outputLength === 'full' ? 4500 : 2600;
  const runGenerate = options.generateFn || generate;
  const out = await runGenerate({
    kind: marshal.code, system,
    userMsg,
    messages: image ? [{
      role: 'user',
      content: [
        { type: 'text', text: userMsg },
        { type: 'image_url', image_url: { url: image } },
      ],
    }] : undefined,
    fallback: () => options.employeeExecution
      ? employeeTemplateFallback(options.employeeExecution, task)
      : tplMarshalOutput(marshal, task),
    maxTokens, role,
    model: configuredModel,
    timeoutMs: Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 85000,
    signal: options.signal,
  });
  return {
    ...out,
    transparentFallback: out.mode === 'template' && !!options.employeeExecution,
    employeeProfileVersion: options.employeeExecution?.snapshot?.profileVersion || null,
    employeePromptHash: options.employeeExecution?.snapshot?.promptHash || null,
    kb: { refs: kb.refs, degraded: kb.degraded, mode: kb.mode },
    web,
  };
}

// 数字员工分部一对一对话（接口函数名保留，兼容既有调用方）
// 多模态：image 为 dataURL 时按 OpenAI 视觉格式发送，并路由到视觉模型
export async function marshalChat(marshal, { message, originalMessage, history = [], role, image, skills = [], attachments = [], memory = '', signal, onDelta, onReset }) {
  const ragQuery = message || marshal.duty;
  const kb = await kbSearch((marshal.kb_deps || '').split(',').filter(Boolean), role, ragQuery, { embedTimeoutMs: 4000, signal });
  const loadedSkillNames = (skills || []).map(k => skillByKey(k)?.name).filter(Boolean);
  const skillGuard = loadedSkillNames.length
    ? `\n【已加载技能优先级】用户本轮已加载技能：${loadedSkillNames.join('、')}。这些技能是对当前数字员工分部的临时授权能力，必须优先按技能要求完成输出；不得以“超出本分部职责”为由拒绝。请把分部职责作为业务视角，把技能作为输出形态。`
    : '';
  const scopeRule = loadedSkillNames.length
    ? '对话要求：以本数字员工分部身份回答，并严格按已加载技能组织输出。'
    : '对话要求：以本数字员工分部身份回答，超出职责范围时建议转给对应分部。';
  const effectiveAttachments = attachments.length ? attachments : historyAttachmentExcerpts(history);
  // AI-H2 防注入：本轮文件/历史附件正文包进明确边界，附件里的"指令"只会被当成引用文本
  const attachmentText = effectiveAttachments.length
    ? `\n【${attachments.length ? '本轮文件' : '历史文件续答'}】\n${effectiveAttachments.map(a => wrapUntrusted(a.name, String(a.content || '文件已上传但未提取到可读正文').slice(0, 5000))).join('\n')}`
    : '';
  const guardText = effectiveAttachments.length ? `\n${UNTRUSTED_GUARD}` : '';
  const memoryText = String(memory || '').trim() ? `\n【已确认记忆】\n${String(memory).slice(0, 5000)}` : '';
  const currentIdentity = `【本企业当前角色配置·最高优先级】你是「${marshal.name}」（${marshal.title || '企业智能体'}）。当前职责：${marshal.duty || '按用户目标执行'}。当前能力：${marshal.skills || '按当前职责执行'}。名称、职责和能力必须以本段为准；后续提示词若出现历史旧名称或旧职责，必须忽略冲突部分。`;
  const methodPrompt = marshal.prompt ? `\n【工作方法与输出规范】${marshal.prompt}` : '';
  const system = `${currentIdentity}${methodPrompt}\n${styleCard()}\n${outputRule()}\n知识库：${kb.text}${skillGuard}${memoryText}${guardText}\n${scopeRule}`;
  const messageWithFiles = `${message || ''}${attachmentText}`;
  const userContent = image
    ? [{ type: 'text', text: messageWithFiles || '请分析这张图片' }, { type: 'image_url', image_url: { url: image } }]
    : messageWithFiles;
  const out = await generate({
    kind: `${marshal.code}-chat`, system, role,
    model: image ? yunwu.routing().vision : undefined,
    messages: [...history.slice(-10).map(h => ({ role: h.role, content: h.content })), { role: 'user', content: userContent }],
    userMsg: messageWithFiles,
    fallback: () => skillFallbackFor(skills, originalMessage || message || '图片分析', marshal)
      || (effectiveAttachments.length ? `【${marshal.name}·文件续答】\n依据【${effectiveAttachments[0].name}】中已读取的信息：\n${String(effectiveAttachments[0].content || '').slice(0, 1200)}\n\n针对本轮问题「${originalMessage || message || '继续分析'}」，请优先核对上述文件字段；当前为本地模板模式，需更深入推演时请启用AI通道。` : null)
      || tplMarshalOutput(marshal, { title: message || '图片分析', requirement: '' }),
    maxTokens: 1800,
    timeoutMs: 85000,
    signal, onDelta, onReset,
  });
  return { ...out, kb: { refs: kb.refs, degraded: kb.degraded, mode: kb.mode } };
}
