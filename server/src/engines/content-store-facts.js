import { q } from '../db.js';
import { curStore, defaultStoreId } from './store-scope.js';

// ===== 门店事实包（Store Fact Pack）=====
// 把门店真实台账（stores / dishes / order_items / store_reviews / kb_docs / 开店向导答案）
// 整理成内容生成可直接引用、可回溯来源的事实清单。三条内容链路（内容仓 generateContent、
// 内容员工工作台 runtime context、AI 带货员 grounding）共用同一份事实包与同一段 prompt 块。
//
// 原则：
// - 只给事实，不编数据；拿不到的关键项进 missing，prompt 明确写「未获取」。
// - 全部 SQL 显式带 tenant_id；门店选择 storeId → curStore() → 租户默认店（不懒创建）。
// - 顾客评价原句默认只做「内部证据」（usage:'internal_evidence'）：老板不希望把顾客原话
//   直接搬到对外文案里（隐私与平台合规——评价平台对搬运用户评论有限制，顾客也未授权被引用）。
//   对外只能引用 rating_summary 这种聚合口径（条数 / 平均分 / 高频词）。
// - 任何异常都不能让内容生成失败：出错时返回空事实包并标记 degraded。

export const STORE_FACT_KINDS = Object.freeze([
  'store_name',
  'address',
  'city',
  'area',
  'hours',
  'avg_ticket',
  'seats',
  'category',
  'signature_dish',
  'dish_price',
  'review_quote',
  'rating_summary',
  'brand_note',
]);

export const STORE_FACT_SOURCES = Object.freeze([
  'stores',
  'dishes',
  'order_items',
  'store_reviews',
  'kb_docs',
  'onboarding',
]);

export const STORE_FACT_INTERNAL_EVIDENCE = 'internal_evidence';

// 缺失清单里的关键项（中文标签即 prompt 中「未获取」所列文案）
export const STORE_FACT_REQUIRED_LABELS = Object.freeze({
  store_name: '门店名称',
  address: '地址',
  hours: '营业时间',
  avg_ticket: '人均消费',
  signature_dish: '招牌菜',
  rating_summary: '顾客评价',
});

export const STORE_FACT_EMPTY_PROMPT =
  '【门店真实事实】尚未录入门店与菜品信息，正文涉及价格/地址/菜名必须写"待补充"';

const SOURCE_LABELS = Object.freeze({
  stores: '门店档案',
  dishes: '菜品表',
  order_items: '订单明细',
  store_reviews: '评价中心',
  kb_docs: '知识库',
  onboarding: '开店向导',
});

const BRAND_NOTE_KB_CATEGORIES = Object.freeze(['企业档案', '品牌资料', '门店资料']);
const SIGNATURE_DISH_LIMIT = 5;
const REVIEW_QUOTE_LIMIT = 6;
const REVIEW_QUOTE_CHARS = 60;
const BRAND_NOTE_LIMIT = 3;
const BRAND_NOTE_CHARS = 200;
const RATING_WINDOW_DAYS = 30;

// 评价高频词：只认这些可对外的中性/正向表达，避免把顾客个性化原话当成「高频词」带出去
const REVIEW_KEYWORDS = Object.freeze([
  '分量足', '分量大', '上菜快', '出餐快', '服务好', '服务热情', '态度好', '环境好', '环境干净',
  '干净', '卫生', '性价比高', '实惠', '便宜', '味道好', '好吃', '味道不错', '新鲜', '入味',
  '停车方便', '位置好', '交通方便', '安静', '适合聚餐', '适合家庭', '适合朋友', '回头客',
  '会再来', '推荐', '不踩雷', '排队', '人气高',
]);

const STORE_OPTIONAL_COLUMNS = Object.freeze({
  hours: ['business_hours', 'hours', 'opening_hours', 'open_hours'],
  avg_ticket: ['avg_ticket', 'avg_price', 'per_capita', 'avg_spend'],
  seats: ['seats', 'seat_count'],
  signature: ['is_signature', 'signature'],
});

function text(value, max = 400) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function money(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

// 与 content-output-contract.js 的 normalizedConcreteValue('price') 同构：cny:38.00
function priceValue(amount) {
  return `cny:${Number(amount).toFixed(2)}`;
}

function priceText(amount) {
  return `¥${Number(amount).toFixed(2)}`;
}

function dateOnly(value) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/u);
  return match ? match[1] : null;
}

function tableColumns(table) {
  try {
    return new Set(q.all(`PRAGMA table_info("${table}")`).map(row => row.name));
  } catch {
    return new Set();
  }
}

function firstExistingColumn(columns, candidates) {
  return candidates.find(name => columns.has(name)) || null;
}

function factId(source, sourceId, suffix = null) {
  const base = `fact:${source}:${sourceId == null ? 'summary' : sourceId}`;
  return suffix ? `${base}:${suffix}` : base;
}

function makeFact({ id, kind, claim, value = null, source, sourceId = null, freshness = null, usage }) {
  const fact = {
    id,
    kind,
    claim,
    value,
    source,
    sourceId: sourceId == null ? null : Number(sourceId),
    freshness,
  };
  if (usage) fact.usage = usage;
  return fact;
}

function emptyPack(tenantId, generatedAt, extra = {}) {
  return {
    tenantId,
    storeId: null,
    storeName: null,
    storeCount: 0,
    multiStore: false,
    facts: [],
    missing: Object.values(STORE_FACT_REQUIRED_LABELS),
    generatedAt,
    ...extra,
  };
}

function loadStore(tenantId, storeId) {
  const id = Number(storeId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return q.get('SELECT * FROM stores WHERE tenant_id=? AND id=?', tenantId, id) || null;
}

// 门店选择：入参 storeId（须属于本租户）→ 当前门店上下文 → 租户默认店（不懒创建）
function resolveStore(tenantId, storeId) {
  const explicit = Number(storeId);
  if (Number.isInteger(explicit) && explicit > 0) {
    return loadStore(tenantId, explicit);
  }
  const ctx = curStore();
  if (ctx != null) {
    const row = loadStore(tenantId, ctx);
    if (row) return row;
  }
  const fallback = defaultStoreId(tenantId, { create: false });
  return fallback ? loadStore(tenantId, fallback) : null;
}

function parseOnboardingAnswers(tenantId) {
  const columns = tableColumns('tenants');
  if (!columns.has('onboarding_answers')) return {};
  const row = q.get('SELECT onboarding_answers FROM tenants WHERE id=?', tenantId);
  if (!row?.onboarding_answers) return {};
  try {
    const parsed = JSON.parse(row.onboarding_answers);
    const answers = parsed?.answers;
    return answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {};
  } catch {
    return {};
  }
}

function storeFacts(store, columns) {
  const facts = [];
  if (!store) return facts;
  const freshness = dateOnly(store.created_at);
  const push = (kind, claim, value = null) => {
    facts.push(makeFact({
      id: factId('stores', store.id, kind),
      kind,
      claim,
      value,
      source: 'stores',
      sourceId: store.id,
      freshness,
    }));
  };
  const name = text(store.name, 80);
  if (name) push('store_name', `门店名称「${name}」`, name);
  const address = text(store.address, 160);
  if (address) push('address', `门店地址：${address}`, address);
  const city = text(store.city, 40);
  if (city) push('city', `所在城市：${city}`, city);
  const area = text(store.area || store.region, 60);
  if (area) push('area', `所在商圈/区域：${area}`, area);
  const hoursColumn = firstExistingColumn(columns, STORE_OPTIONAL_COLUMNS.hours);
  const hours = hoursColumn ? text(store[hoursColumn], 80) : '';
  if (hours) push('hours', `营业时间：${hours}`, hours);
  const ticketColumn = firstExistingColumn(columns, STORE_OPTIONAL_COLUMNS.avg_ticket);
  const ticket = ticketColumn ? money(store[ticketColumn]) : null;
  if (ticket) push('avg_ticket', `人均消费 ${priceText(ticket)}`, priceValue(ticket));
  const seatsColumn = firstExistingColumn(columns, STORE_OPTIONAL_COLUMNS.seats);
  const seats = seatsColumn ? Number(store[seatsColumn]) : NaN;
  if (Number.isFinite(seats) && seats > 0) push('seats', `座位数：${Math.round(seats)} 个`, Math.round(seats));
  const category = text(store.biz_type, 30);
  if (category) push('category', `业态：${category}`, category);
  return facts;
}

function normalizeDishName(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\s「」『』《》【】()（）]/gu, '').toLowerCase();
}

function dishMatchesWanted(dish, wanted) {
  const name = normalizeDishName(dish.name);
  if (!name) return false;
  return wanted.some(token => token && (name.includes(token) || token.includes(name)));
}

function salesRankByDish(tenantId, storeId) {
  const rank = new Map();
  try {
    const rows = q.all(
      `SELECT oi.dish_id dish_id, SUM(oi.qty) qty FROM order_items oi
       JOIN dishes d ON d.id=oi.dish_id AND d.tenant_id=oi.tenant_id
       WHERE oi.tenant_id=? AND d.store_id=? AND oi.dish_id IS NOT NULL
       GROUP BY oi.dish_id ORDER BY qty DESC, oi.dish_id LIMIT 20`,
      tenantId,
      storeId,
    );
    rows.forEach((row, index) => rank.set(Number(row.dish_id), { order: index, qty: Number(row.qty) || 0 }));
  } catch {
    // 订单明细缺表/缺列时退回菜品表顺序
  }
  return rank;
}

function dishFacts(tenantId, store, { dishNames, limit }) {
  if (!store) return { facts: [], hasDishes: false };
  const columns = tableColumns('dishes');
  const signatureColumn = firstExistingColumn(columns, STORE_OPTIONAL_COLUMNS.signature);
  const dishes = q.all(
    `SELECT * FROM dishes WHERE tenant_id=? AND store_id=? AND (status IS NULL OR status<>'下架')
     ORDER BY id LIMIT 200`,
    tenantId,
    store.id,
  );
  if (!dishes.length) return { facts: [], hasDishes: false };
  const wanted = (Array.isArray(dishNames) ? dishNames : [])
    .map(normalizeDishName)
    .filter(Boolean);
  const sales = salesRankByDish(tenantId, store.id);
  // 招牌菜优先级：调用方点名 → 订单销量 Top → 菜品表标记 → 菜品表顺序
  const priority = dish => {
    if (wanted.length && dishMatchesWanted(dish, wanted)) return 0;
    if (sales.has(Number(dish.id))) return 1;
    if (signatureColumn && Number(dish[signatureColumn]) === 1) return 2;
    return 3;
  };
  const ordered = dishes
    .map((dish, index) => ({ dish, index, tier: priority(dish) }))
    .sort((left, right) => {
      if (left.tier !== right.tier) return left.tier - right.tier;
      if (left.tier === 1) return sales.get(Number(left.dish.id)).order - sales.get(Number(right.dish.id)).order;
      return left.index - right.index;
    })
    .map(entry => entry.dish);
  const facts = [];
  ordered.forEach((dish, index) => {
    const name = text(dish.name, 60);
    if (!name) return;
    const price = money(dish.price);
    const category = text(dish.category, 30);
    const isSignature = index < SIGNATURE_DISH_LIMIT;
    if (!isSignature && !price) return; // 非招牌且没价格的菜对文案没有可引用价值
    const soldQty = sales.get(Number(dish.id))?.qty;
    const head = `${isSignature ? '招牌菜' : '菜品'}「${name}」${price ? `售价 ${priceText(price)}` : '（售价未录入）'}`;
    const notes = [];
    if (category) notes.push(`分类：${category}`);
    if (isSignature && soldQty > 0) notes.push(`订单明细累计销量 ${soldQty} 份`);
    facts.push(makeFact({
      id: factId('dishes', dish.id),
      kind: isSignature ? 'signature_dish' : 'dish_price',
      claim: `${head}${notes.length ? `（${notes.join('；')}）` : ''}`,
      value: price ? priceValue(price) : null,
      source: 'dishes',
      sourceId: dish.id,
      freshness: dateOnly(dish.updated_at || dish.created_at),
    }));
  });
  return { facts: facts.slice(0, Math.max(SIGNATURE_DISH_LIMIT, limit)), hasDishes: true };
}

function reviewStoreClause(columns, storeId) {
  if (!columns.has('store_id') || !storeId) return { sql: '', params: [] };
  // 历史评价可能没归属门店（store_id NULL），单店客户仍应看到全部评价
  return { sql: ' AND (store_id IS NULL OR store_id=?)', params: [storeId] };
}

function reviewKeywords(contents) {
  const counts = new Map();
  for (const content of contents) {
    const seen = new Set();
    for (const keyword of REVIEW_KEYWORDS) {
      if (!seen.has(keyword) && content.includes(keyword)) {
        seen.add(keyword);
        counts.set(keyword, (counts.get(keyword) || 0) + 1);
      }
    }
  }
  const threshold = contents.length >= 4 ? 2 : 1;
  return [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh'))
    .slice(0, 3)
    .map(([keyword]) => keyword);
}

function reviewFacts(tenantId, store, includeReviews) {
  const columns = tableColumns('store_reviews');
  if (!columns.size) return [];
  const scope = reviewStoreClause(columns, store?.id);
  const facts = [];
  const window = q.get(
    `SELECT COUNT(*) n, AVG(rating) avg_rating FROM store_reviews
     WHERE tenant_id=? AND COALESCE(review_date, created_at) >= date('now','localtime','-${RATING_WINDOW_DAYS} days')${scope.sql}`,
    tenantId,
    ...scope.params,
  );
  let summaryRow = window;
  let windowLabel = `近 ${RATING_WINDOW_DAYS} 天`;
  if (!Number(window?.n)) {
    summaryRow = q.get(
      `SELECT COUNT(*) n, AVG(rating) avg_rating FROM store_reviews WHERE tenant_id=?${scope.sql}`,
      tenantId,
      ...scope.params,
    );
    windowLabel = '累计';
  }
  const total = Number(summaryRow?.n) || 0;
  if (!total) return facts;
  const positive = q.all(
    `SELECT id, rating, platform, content, COALESCE(review_date, created_at) reviewed_at FROM store_reviews
     WHERE tenant_id=? AND rating>=4${scope.sql}
     ORDER BY COALESCE(review_date, created_at) DESC, id DESC LIMIT 200`,
    tenantId,
    ...scope.params,
  );
  const keywords = reviewKeywords(positive.map(row => text(row.content, 500)));
  const avg = Number(summaryRow.avg_rating);
  facts.push(makeFact({
    id: factId('store_reviews', null),
    kind: 'rating_summary',
    claim: `${windowLabel} ${total} 条评价，平均 ${Number.isFinite(avg) ? avg.toFixed(1) : '—'} 分${keywords.length ? `，高频词：${keywords.join('/')}` : ''}`,
    value: { count: total, avgRating: Number.isFinite(avg) ? Number(avg.toFixed(2)) : null, window: windowLabel, keywords },
    source: 'store_reviews',
    sourceId: null,
    freshness: dateOnly(positive[0]?.reviewed_at),
  }));
  if (!includeReviews) return facts;
  for (const row of positive.slice(0, REVIEW_QUOTE_LIMIT)) {
    const quote = text(row.content, REVIEW_QUOTE_CHARS);
    if (!quote) continue;
    facts.push(makeFact({
      id: factId('store_reviews', row.id),
      kind: 'review_quote',
      claim: `顾客评价（${text(row.platform, 12) || '平台'} ${Number(row.rating)}★）：「${quote}」`,
      value: quote,
      source: 'store_reviews',
      sourceId: row.id,
      freshness: dateOnly(row.reviewed_at),
      usage: STORE_FACT_INTERNAL_EVIDENCE,
    }));
  }
  return facts;
}

function brandNoteFacts(tenantId) {
  const placeholders = BRAND_NOTE_KB_CATEGORIES.map(() => '?').join(',');
  const rows = q.all(
    `SELECT id, category, title, body, updated_at FROM kb_docs
     WHERE tenant_id=? AND (enabled IS NULL OR enabled=1) AND category IN (${placeholders})
     ORDER BY updated_at DESC, id DESC LIMIT ${BRAND_NOTE_LIMIT}`,
    tenantId,
    ...BRAND_NOTE_KB_CATEGORIES,
  );
  return rows
    .map(row => {
      const title = text(row.title, 80);
      const body = text(row.body, BRAND_NOTE_CHARS);
      if (!title && !body) return null;
      return makeFact({
        id: factId('kb_docs', row.id),
        kind: 'brand_note',
        claim: `${text(row.category, 20)}「${title || '未命名'}」：${body}`,
        value: body,
        source: 'kb_docs',
        sourceId: row.id,
        freshness: dateOnly(row.updated_at),
      });
    })
    .filter(Boolean);
}

function onboardingFacts(tenantId, answers, { hasDishes, presentKinds }) {
  const facts = [];
  if (!answers || !Object.keys(answers).length) return facts;
  const push = (field, kind, claim, value = null, usage) => {
    facts.push(makeFact({
      id: factId('onboarding', tenantId, field),
      kind,
      claim,
      value,
      source: 'onboarding',
      sourceId: tenantId,
      freshness: null,
      usage,
    }));
  };
  if (!hasDishes && Array.isArray(answers.signatureDishes)) {
    answers.signatureDishes
      .map(name => text(name, 30))
      .filter(Boolean)
      .slice(0, SIGNATURE_DISH_LIMIT)
      .forEach((name, index) => {
        facts.push(makeFact({
          id: factId('onboarding', tenantId, `signature_${index}`),
          kind: 'signature_dish',
          claim: `招牌菜「${name}」（开店向导登记，售价未录入）`,
          value: null,
          source: 'onboarding',
          sourceId: tenantId,
          freshness: null,
        }));
      });
  }
  const ticket = money(answers.avgTicket);
  if (ticket && !presentKinds.has('avg_ticket')) {
    push('avgTicket', 'avg_ticket', `人均消费约 ${priceText(ticket)}（开店向导登记）`, priceValue(ticket));
  }
  const seats = Number(answers.seats);
  if (Number.isFinite(seats) && seats > 0 && !presentKinds.has('seats')) {
    push('seats', 'seats', `座位数约 ${Math.round(seats)} 个（开店向导登记）`, Math.round(seats));
  }
  if (!presentKinds.has('address')) {
    const address = text(answers.address, 120);
    if (address) push('address', 'address', `门店地址：${address}（开店向导登记）`, address);
  }
  if (!presentKinds.has('city')) {
    const city = text(answers.city, 30);
    if (city) push('city', 'city', `所在城市：${city}（开店向导登记）`, city);
  }
  if (!presentKinds.has('area')) {
    const district = text(answers.district, 60);
    if (district) push('district', 'area', `所在商圈/位置：${district}（开店向导登记）`, district);
  }
  if (!presentKinds.has('category')) {
    const bizType = text(answers.bizType, 20);
    if (bizType) push('bizType', 'category', `业态：${bizType}（开店向导登记）`, bizType);
  }
  const groups = Array.isArray(answers.customerGroups)
    ? answers.customerGroups.map(item => text(item, 20)).filter(Boolean)
    : [];
  if (groups.length) push('customerGroups', 'brand_note', `主要客群：${groups.join('、')}（开店向导登记）`, groups);
  // 经营目标与头疼事只用于把握方向，不该出现在对外文案里
  const goal = text(answers.goal, 20);
  const goalTarget = text(answers.goalTarget, 60);
  if (goal) {
    push('goal', 'brand_note', `未来 90 天经营目标：${goal}${goalTarget ? `（${goalTarget}）` : ''}`, goal, STORE_FACT_INTERNAL_EVIDENCE);
  }
  const pain = text(answers.painPoint, 200);
  if (pain) push('painPoint', 'brand_note', `老板最头疼的事：${pain}`, pain, STORE_FACT_INTERNAL_EVIDENCE);
  return facts;
}

// 事实排序：对外可引用且最具体的优先，内部证据最后（超出 limit / maxFacts 时先被裁掉）
const KIND_ORDER = Object.freeze([
  'store_name', 'category', 'address', 'city', 'area', 'hours', 'avg_ticket', 'seats',
  'signature_dish', 'rating_summary', 'brand_note', 'dish_price', 'review_quote',
]);

function orderFacts(facts) {
  const rank = fact => {
    const base = KIND_ORDER.indexOf(fact.kind);
    return (fact.usage === STORE_FACT_INTERNAL_EVIDENCE ? 100 : 0) + (base < 0 ? 50 : base);
  };
  return facts
    .map((fact, index) => ({ fact, index, rank: rank(fact) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(entry => entry.fact);
}

function computeMissing(facts) {
  const kinds = new Set(facts.map(fact => fact.kind));
  return Object.entries(STORE_FACT_REQUIRED_LABELS)
    .filter(([kind]) => !kinds.has(kind))
    .map(([, label]) => label);
}

/**
 * 构造门店事实包。永不抛错：查询失败返回空包（degraded:true）。
 *
 * @param {number} tenantId 租户 id（所有 SQL 显式带 tenant_id）
 * @param {object} [options]
 * @param {number|null} [options.storeId] 指定门店；不传则 curStore() → 默认店
 * @param {string[]} [options.dishNames] 调用方点名的菜品，优先作为招牌菜
 * @param {number} [options.limit=24] 事实条数上限
 * @param {boolean} [options.includeReviews=true] 是否带顾客评价原句（内部证据）
 */
export function buildContentStoreFactPack(tenantId, {
  storeId = null,
  dishNames = [],
  limit = 24,
  includeReviews = true,
} = {}) {
  const generatedAt = new Date().toISOString();
  const tid = Number(tenantId);
  if (!Number.isInteger(tid) || tid <= 0) return emptyPack(null, generatedAt, { degraded: true });
  const cap = Math.max(1, Math.min(64, Number(limit) || 24));
  try {
    const storeColumns = tableColumns('stores');
    if (!storeColumns.size) return emptyPack(tid, generatedAt, { degraded: true });
    const storeCount = Number(q.get('SELECT COUNT(*) n FROM stores WHERE tenant_id=?', tid)?.n) || 0;
    const store = resolveStore(tid, storeId);
    const facts = [...storeFacts(store, storeColumns)];
    const dishes = dishFacts(tid, store, { dishNames, limit: cap });
    facts.push(...dishes.facts);
    facts.push(...reviewFacts(tid, store, includeReviews !== false));
    facts.push(...brandNoteFacts(tid));
    const presentKinds = new Set(facts.map(fact => fact.kind));
    facts.push(...onboardingFacts(tid, parseOnboardingAnswers(tid), {
      hasDishes: dishes.hasDishes,
      presentKinds,
    }));
    const ordered = orderFacts(facts).slice(0, cap);
    return {
      tenantId: tid,
      storeId: store ? Number(store.id) : null,
      storeName: store ? text(store.name, 80) || null : null,
      storeCount,
      multiStore: storeCount > 1,
      facts: ordered,
      missing: computeMissing(ordered),
      generatedAt,
    };
  } catch (error) {
    return emptyPack(tid, generatedAt, {
      degraded: true,
      error: String(error?.message || error).slice(0, 200),
    });
  }
}

export function storeFactById(pack, id) {
  if (!pack || !Array.isArray(pack.facts)) return null;
  return pack.facts.find(fact => fact?.id === id) || null;
}

/**
 * 纯文本 prompt 块。无事实时只输出「尚未录入」一句，不得让缺事实导致生成失败。
 * audience: 'content'（文案）| 'video'（口播/视频脚本）
 */
export function storeFactPackPromptBlock(pack, { maxFacts = 16, audience = 'content' } = {}) {
  const facts = Array.isArray(pack?.facts) ? pack.facts.filter(fact => fact && fact.id && fact.claim) : [];
  if (!facts.length) return STORE_FACT_EMPTY_PROMPT;
  const cap = Math.max(1, Math.min(64, Number(maxFacts) || 16));
  const lines = ['【门店真实事实（只能引用，不得改数、不得编造）】'];
  if (pack.storeName) {
    lines.push(`门店：${pack.storeName}${pack.storeId ? `（门店编号 ${pack.storeId}${pack.multiStore ? '，连锁多店中的当前门店' : ''}）` : ''}`);
  }
  for (const fact of orderFacts(facts).slice(0, cap)) {
    const source = SOURCE_LABELS[fact.source] || fact.source || '未知来源';
    const internal = fact.usage === STORE_FACT_INTERNAL_EVIDENCE ? '内部证据·不得对外原句引用：' : '';
    lines.push(`- [${fact.id}] ${internal}${fact.claim}（来源：${source}）`);
  }
  const missing = Array.isArray(pack.missing) ? pack.missing.filter(Boolean) : [];
  if (missing.length) {
    lines.push(`【未获取】${missing.join('、')}——如需提及必须写"待补充"`);
  }
  lines.push('规则：引用事实时在 facts_used 中登记 fact id（facts_used: [{ claim, factId }]）；标注「内部证据」的条目只能用于把握方向与选题，不得写入对外正文或口播。');
  if (audience === 'video') {
    lines.push('口播与字幕中读出的价格、地址、菜名必须与上述事实逐字一致；未获取项在口播中只能说"以门店公示为准"。');
  }
  return lines.join('\n');
}

/**
 * 校验 facts_used：每条 { claim, factId } 的 factId 必须存在于事实包；
 * usage:'internal_evidence' 的条目不得被引用；min 为条数下限。
 */
export function validateFactsUsed(factsUsed, pack, { min = 0 } = {}) {
  const errors = [];
  const used = [];
  const list = factsUsed == null ? [] : factsUsed;
  if (!Array.isArray(list)) {
    return { ok: false, errors: ['facts_used 必须是数组，格式 [{ claim, factId }]'], used };
  }
  const seen = new Set();
  list.forEach((entry, index) => {
    const path = `facts_used[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${path} 必须是 { claim, factId } 对象`);
      return;
    }
    const id = typeof entry.factId === 'string' ? entry.factId.trim() : '';
    const claim = typeof entry.claim === 'string' ? entry.claim.trim() : '';
    if (!id) {
      errors.push(`${path}.factId 缺失`);
      return;
    }
    if (!claim) errors.push(`${path}.claim 缺失`);
    const fact = storeFactById(pack, id);
    if (!fact) {
      errors.push(`${path}.factId「${id}」不在门店事实包中`);
      return;
    }
    if (fact.usage === STORE_FACT_INTERNAL_EVIDENCE) {
      errors.push(`${path}.factId「${id}」是内部证据（${fact.kind}），不得对外引用原句`);
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);
    used.push({ factId: id, claim, kind: fact.kind, source: fact.source, sourceId: fact.sourceId });
  });
  const floor = Math.max(0, Number(min) || 0);
  if (used.length < floor) {
    errors.push(`facts_used 至少需登记 ${floor} 条门店事实，当前 ${used.length} 条`);
  }
  return { ok: errors.length === 0, errors, used };
}
