// 爆款结构卡（Benchmark Structure Cards）
//
// 拆解师（idx 2）把老板粘贴的链接/截图 + 公开转载页检索拆成「只借结构、不抄事实」的
// 结构卡；通过岗位契约后每卡一行写入 content_benchmark_cards，并同步到知识库分类
// 「爆款结构卡」。撰稿人（idx 3）与 AI 带货员（idx 10）通过 runtime context 的
// `benchmarkCards` / `benchmarkFewShot` 取回作为 few-shot。
//
// 边界：
// - 不抓取需要登录态的小红书/抖音页面；链接路径只走 collectLinkScriptSourceEvidence
//   （ASR → 受控抓取 → 公开转载页搜索兜底），来源统一标 secondhand。
// - 全部 SQL 显式带 tenant_id；表已登记 ISOLATED，INSERT 也会被 q.run 自动注入兜底。
// - 任何异常都不能让内容生成失败：few-shot 读取失败返回空数组并标记 degraded。
import { curTenant, db, q } from '../db.js';

export const BENCHMARK_CARD_KB_CATEGORY = '爆款结构卡';
export const BENCHMARK_CARD_FEWSHOT_HEADING = '【可借鉴的爆款结构（只借结构，不抄事实）】';
export const BENCHMARK_HOOK_TYPES = Object.freeze(['数字', '悬念', '身份代入', '反常识', '对比']);
export const BENCHMARK_CARD_SOURCE_TYPES = Object.freeze(['live', 'link', 'screenshot', 'manual']);
export const BENCHMARK_CARD_FIELDS = Object.freeze([
  'platform',
  'hook_type',
  'opening_3s',
  'structure',
  'emotion_trigger',
  'selling_point_presentation',
  'cta_type',
  'hashtags',
  'duration_or_length',
  'pacing_notes',
  'reusable_pattern',
  'risk_flags',
  'source',
]);
// 撰稿人 / AI 带货员默认读取 few-shot 的工位
export const BENCHMARK_FEWSHOT_STATIONS = Object.freeze(new Set([3, 10]));
export const BENCHMARK_FEWSHOT_DEFAULT_LIMIT = 3;
export const BENCHMARK_CARD_VERIFIED = Object.freeze({ pending: 0, verified: 1, deleted: -1 });

export function benchmarkLearningRequested(employeeIdx, task = {}) {
  return Number(employeeIdx) === 2 && (task.type === '爆款拆解'
    || /爆款|结构卡/u.test([task.title, task.direction, task.material, task.requirement].filter(Boolean).join('\n')));
}

export function structureCardsPromptBlock({ platform = null, city = null, category = null } = {}) {
  const scope = [city, category].map(item => String(item || '').trim()).filter(Boolean).join(' ');
  return [
    '【爆款结构卡·必须输出 structure_cards】',
    '除 benchmarks / comment_insights / user_language / takeaways 外，还必须输出 structure_cards（1-8 张），每张字段全部必填：',
    `platform、hook_type（${BENCHMARK_HOOK_TYPES.join(' | ')}）、opening_3s、structure（实际顺序数组，如 ["痛点","场景","产品","证据","行动"]）、emotion_trigger、selling_point_presentation、cta_type、hashtags[]（不带#）、duration_or_length、pacing_notes、reusable_pattern、risk_flags[]、source{url|null,type(${BENCHMARK_CARD_SOURCE_TYPES.join('|')}),fetchedAt}。`,
    'source.url 只能填本次已验证来源快照中的 URL（链接样本填原链接或转载页 URL，截图样本 url 填 null、type 填 screenshot）。',
    '只借结构、节奏、钩子与 CTA 形式；不得把样本里的门店名、价格、销量、评价当作可复用事实写进 reusable_pattern。',
    scope ? `同城品类口径：${scope}${platform ? `；目标平台：${platform}` : ''}。` : (platform ? `目标平台：${platform}。` : ''),
    '公开转载页 / 合集来源属于二手来源，结构判断要保守，并在 risk_flags 标明“二手来源”。',
  ].filter(Boolean).join('\n');
}

// 平台原站域名：来自这些域的样本才不算「二手来源」；其余公开转载页统一 secondhand。
const PLATFORM_ORIGIN_HOSTS = Object.freeze({
  小红书: ['xiaohongshu.com', 'xhslink.com'],
  抖音: ['douyin.com', 'iesdouyin.com'],
  B站: ['bilibili.com', 'b23.tv'],
  快手: ['kuaishou.com', 'chenzhongtech.com'],
  公众号: ['mp.weixin.qq.com', 'weixin.qq.com'],
  视频号: ['channels.weixin.qq.com'],
});

function text(value, max = 400) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hostOf(url) {
  try {
    return new URL(String(url || '')).hostname.replace(/^www\./u, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 根据 URL 推断平台名；识别不了返回 null（不猜）。
 */
export function benchmarkPlatformForUrl(url) {
  const host = hostOf(url);
  if (!host) return null;
  for (const [platform, hosts] of Object.entries(PLATFORM_ORIGIN_HOSTS)) {
    if (hosts.some(domain => host === domain || host.endsWith(`.${domain}`))) return platform;
  }
  return null;
}

/**
 * 是否二手来源：不在平台原站域名下的公开页面（转载/合集/媒体报道）一律 secondhand。
 */
export function benchmarkSourceIsSecondhand(url) {
  return benchmarkPlatformForUrl(url) === null;
}

/**
 * 拆解师公开检索的关键词补强：同城 + 品类 + 平台爆款/探店/转载关键词。
 * content-live-research.js 的 decompose buildQuery 与工作台 attachWorkbenchWebEvidence 共用。
 */
export function benchmarkDecomposeQueryHints({ city = null, category = null, platform = null } = {}) {
  const cityText = text(city, 40);
  const categoryText = text(category, 40);
  const platformText = text(platform, 40);
  const locality = [cityText, categoryText].filter(Boolean).join(' ');
  const platformHints = platformText && /抖音|视频号|快手|B站/u.test(platformText)
    ? ['抖音 探店 热门', '短视频 前3秒 钩子']
    : platformText && /小红书/u.test(platformText)
      ? ['小红书 笔记 爆款', '探店 笔记 标题公式']
      : ['小红书 笔记 爆款', '抖音 探店 热门'];
  return {
    city: cityText || null,
    category: categoryText || null,
    locality: locality || null,
    keywords: [
      ...(locality ? [locality] : []),
      ...platformHints,
      '转载 合集',
    ],
    line: [
      locality ? `同城品类：${locality}` : '',
      `爆款关键词：${[...platformHints, '转载 合集'].join(' / ')}`,
      '只检索公开转载页、合集与媒体报道；不登录、不采集平台账号数据，来源一律按二手来源标注。',
    ].filter(Boolean).join('\n'),
  };
}

let tableReady = false;

export function ensureBenchmarkCardTable() {
  if (tableReady && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='content_benchmark_cards'").get()) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_benchmark_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      employee_run_id INTEGER,
      platform TEXT NOT NULL,
      category TEXT,
      city TEXT,
      card_json TEXT NOT NULL,
      source_url TEXT,
      source_type TEXT NOT NULL DEFAULT 'manual',
      secondhand INTEGER NOT NULL DEFAULT 1,
      verified INTEGER NOT NULL DEFAULT 0,
      verified_by INTEGER,
      verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_content_benchmark_cards_lookup
      ON content_benchmark_cards(tenant_id, verified, platform, category, id DESC);
    CREATE INDEX IF NOT EXISTS idx_content_benchmark_cards_run
      ON content_benchmark_cards(tenant_id, employee_run_id);
  `);
  tableReady = true;
}

function stringList(value, max = 12, itemMax = 80) {
  if (!Array.isArray(value)) return [];
  return value.map(item => text(item, itemMax)).filter(Boolean).slice(0, max);
}

/**
 * 轻量归一（契约已在 content-output-contract.js 严格校验，这里只防脏数据入库）。
 * 返回 null 表示这张卡不可入库。
 */
export function normalizeBenchmarkCard(raw) {
  if (!plainObject(raw)) return null;
  const platform = text(raw.platform, 40);
  const hookType = text(raw.hook_type, 20);
  if (!platform || !BENCHMARK_HOOK_TYPES.includes(hookType)) return null;
  const source = plainObject(raw.source) ? raw.source : {};
  const sourceType = BENCHMARK_CARD_SOURCE_TYPES.includes(source.type) ? source.type : 'manual';
  let sourceUrl = null;
  if (source.url) {
    try {
      const parsed = new URL(String(source.url));
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) {
        parsed.hash = '';
        sourceUrl = parsed.href.slice(0, 2000);
      }
    } catch {
      sourceUrl = null;
    }
  }
  const structure = stringList(raw.structure, 10, 40);
  if (!structure.length) return null;
  return {
    platform,
    hook_type: hookType,
    opening_3s: text(raw.opening_3s, 300),
    structure,
    emotion_trigger: text(raw.emotion_trigger, 200),
    selling_point_presentation: text(raw.selling_point_presentation, 300),
    cta_type: text(raw.cta_type, 80),
    hashtags: stringList(raw.hashtags, 12, 40),
    duration_or_length: text(raw.duration_or_length, 80),
    pacing_notes: text(raw.pacing_notes, 300),
    reusable_pattern: text(raw.reusable_pattern, 400),
    risk_flags: stringList(raw.risk_flags, 8, 80),
    source: {
      url: sourceUrl,
      type: sourceType,
      fetchedAt: text(source.fetchedAt, 40) || null,
      secondhand: source.secondhand === true || benchmarkSourceIsSecondhand(sourceUrl),
    },
  };
}

function publicCard(row) {
  if (!row) return null;
  let card;
  try {
    card = JSON.parse(row.card_json);
  } catch {
    card = null;
  }
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    employeeRunId: row.employee_run_id == null ? null : Number(row.employee_run_id),
    platform: row.platform,
    category: row.category || null,
    city: row.city || null,
    sourceUrl: row.source_url || null,
    sourceType: row.source_type,
    secondhand: Number(row.secondhand) === 1,
    verified: Number(row.verified),
    verifiedBy: row.verified_by == null ? null : Number(row.verified_by),
    verifiedAt: row.verified_at || null,
    createdAt: row.created_at,
    card,
  };
}

function kbTitleFor(id, card) {
  return `${card.platform}·${card.hook_type}钩子·${text(card.opening_3s, 24) || card.structure[0]} #${id}`;
}

function kbBodyFor(card) {
  return [
    `平台：${card.platform}`,
    `钩子类型：${card.hook_type}`,
    `前3秒/首屏：${card.opening_3s}`,
    `结构顺序：${card.structure.join(' → ')}`,
    `情绪触发：${card.emotion_trigger}`,
    `卖点呈现：${card.selling_point_presentation}`,
    `行动召唤：${card.cta_type}`,
    `标签：${card.hashtags.join('、') || '（无）'}`,
    `时长/篇幅：${card.duration_or_length}`,
    `节奏：${card.pacing_notes}`,
    `可复用模式：${card.reusable_pattern}`,
    `风险提示：${card.risk_flags.join('；') || '（无）'}`,
    `来源：${card.source.type}${card.source.secondhand ? '（二手来源）' : ''}${card.source.url ? ` ${card.source.url}` : ''}`,
    '边界：只借结构，不抄事实；任何门店事实必须以本店事实包为准。',
  ].join('\n');
}

/**
 * 拆解师产出通过契约后写待确认结构卡；确认前不进入知识库或下一稿。
 * 调用方必须已处于目标租户上下文（runWithTenant），或显式传 tenantId。
 */
export function insertBenchmarkCards({
  tenantId = curTenant(),
  employeeRunId = null,
  cards,
  category = null,
  city = null,
} = {}) {
  ensureBenchmarkCardTable();
  const tid = Number(tenantId);
  if (!Number.isInteger(tid) || tid <= 0) throw new TypeError('tenantId must be a positive integer');
  const normalized = (Array.isArray(cards) ? cards : []).map(normalizeBenchmarkCard).filter(Boolean);
  const inserted = [];
  for (const card of normalized) {
    const existing = employeeRunId == null ? null : q.get(
      `SELECT * FROM content_benchmark_cards WHERE tenant_id=? AND employee_run_id=? AND card_json=?`,
      tid, Number(employeeRunId), JSON.stringify(card),
    );
    if (existing) {
      inserted.push(publicCard(existing));
      continue;
    }
    const result = q.run(
      `INSERT INTO content_benchmark_cards(
        tenant_id,employee_run_id,platform,category,city,card_json,source_url,source_type,secondhand,verified
      ) VALUES(?,?,?,?,?,?,?,?,?,0)`,
      tid,
      employeeRunId == null ? null : Number(employeeRunId),
      card.platform,
      text(category, 80) || null,
      text(city, 40) || null,
      JSON.stringify(card),
      card.source.url,
      card.source.type,
      card.source.secondhand ? 1 : 0,
    );
    const id = Number(result.lastInsertRowid);
    inserted.push(publicCard(q.get(
      'SELECT * FROM content_benchmark_cards WHERE tenant_id=? AND id=?',
      tid,
      id,
    )));
  }
  return inserted;
}

/**
 * 列出结构卡：默认只返回未软删（verified >= 0）的卡；verified=1 的已确认卡排在前面。
 */
export function listBenchmarkCards(tenantId = curTenant(), {
  platform = null,
  category = null,
  runId = null,
  verifiedOnly = false,
  includeDeleted = false,
  limit = 20,
} = {}) {
  ensureBenchmarkCardTable();
  const tid = Number(tenantId);
  if (!Number.isInteger(tid) || tid <= 0) return [];
  const clauses = [];
  const params = [tid];
  if (!includeDeleted) clauses.push('verified>=0');
  if (verifiedOnly) clauses.push('verified=1');
  const platformText = text(platform, 40);
  if (platformText) {
    clauses.push('platform=?');
    params.push(platformText);
  }
  const categoryText = text(category, 80);
  if (categoryText) {
    clauses.push('category=?');
    params.push(categoryText);
  }
  if (runId != null) {
    clauses.push('employee_run_id=?');
    params.push(Number(runId));
  }
  const bounded = Math.max(1, Math.min(100, Math.trunc(Number(limit)) || 20));
  params.push(bounded);
  return q.all(
    `SELECT * FROM content_benchmark_cards WHERE tenant_id=? ${clauses.length ? `AND ${clauses.join(' AND ')}` : ''}
      ORDER BY verified DESC, id DESC LIMIT ?`,
    ...params,
  ).map(publicCard);
}

export function getBenchmarkCard(tenantId = curTenant(), id) {
  ensureBenchmarkCardTable();
  return publicCard(q.get(
    'SELECT * FROM content_benchmark_cards WHERE tenant_id=? AND id=?',
    Number(tenantId),
    Number(id),
  ));
}

/**
 * 老板/管理员确认「可借鉴」：verified=1。已软删的卡不能再确认。
 */
export function markBenchmarkCardVerified(id, userId, { tenantId = curTenant() } = {}) {
  ensureBenchmarkCardTable();
  db.exec('SAVEPOINT benchmark_verify');
  try {
  const result = q.run(
    `UPDATE content_benchmark_cards
      SET verified=1,verified_by=?,verified_at=datetime('now','localtime')
      WHERE tenant_id=? AND id=? AND verified>=0`,
    Number(userId) || null,
    Number(tenantId),
    Number(id),
  );
  if (!result.changes) {
    db.exec('RELEASE benchmark_verify');
    return null;
  }
  const row = getBenchmarkCard(tenantId, id);
  const title = `[${BENCHMARK_CARD_KB_CATEGORY}] ${kbTitleFor(row.id, row.card)}`;
  const existing = q.get(
    `SELECT id FROM kb_docs WHERE tenant_id=? AND source_type='benchmark_card' AND source_id=?`,
    Number(tenantId), Number(id),
  );
  if (existing) {
    q.run(`UPDATE kb_docs SET enabled=1 WHERE tenant_id=? AND id=?`, Number(tenantId), existing.id);
  } else {
    q.run(`INSERT INTO kb_docs(tenant_id,category,title,body,source_type,source_id,enabled)
      VALUES(?,?,?,?,'benchmark_card',?,1)`, Number(tenantId), BENCHMARK_CARD_KB_CATEGORY,
    title, kbBodyFor(row.card), Number(id));
  }
  db.exec('RELEASE benchmark_verify');
  return row;
  } catch (error) {
    db.exec('ROLLBACK TO benchmark_verify; RELEASE benchmark_verify');
    throw error;
  }
}

/**
 * 软删：verified=-1，不再进入 few-shot 与列表。
 */
export function softDeleteBenchmarkCard(id, userId, { tenantId = curTenant() } = {}) {
  ensureBenchmarkCardTable();
  db.exec('SAVEPOINT benchmark_delete');
  try {
  const result = q.run(
    `UPDATE content_benchmark_cards
      SET verified=-1,verified_by=?,verified_at=datetime('now','localtime')
      WHERE tenant_id=? AND id=? AND verified>=0`,
    Number(userId) || null,
    Number(tenantId),
    Number(id),
  );
  if (!result.changes) {
    db.exec('RELEASE benchmark_delete');
    return null;
  }
  const row = getBenchmarkCard(tenantId, id);
  // 兼容 Cursor 早期按标题同步、尚无 source_id 的知识记录，防止删除后继续召回。
  const legacyTitle = `[${BENCHMARK_CARD_KB_CATEGORY}] ${kbTitleFor(row.id, row.card)}`;
  q.run(`UPDATE kb_docs SET enabled=0 WHERE tenant_id=? AND
    ((source_type='benchmark_card' AND source_id=?) OR (category=? AND title=?))`,
  Number(tenantId), Number(id), BENCHMARK_CARD_KB_CATEGORY, legacyTitle);
  db.exec('RELEASE benchmark_delete');
  return row;
  } catch (error) {
    db.exec('ROLLBACK TO benchmark_delete; RELEASE benchmark_delete');
    throw error;
  }
}

/**
 * few-shot 文本块：标题行 + 每卡 6 行要点。只借结构，不搬事实；老板已确认的卡优先。
 *
 * @param {Array} cards listBenchmarkCards 返回的公开卡对象（也接受裸 card）
 * @param {{platform?:string|null, limit?:number}} options
 */
export function contentBenchmarkFewShotBlock(cards, { platform = null, limit = BENCHMARK_FEWSHOT_DEFAULT_LIMIT } = {}) {
  const list = (Array.isArray(cards) ? cards : [])
    .map(item => (plainObject(item?.card) ? item : { card: item, verified: 0, secondhand: item?.source?.secondhand }))
    .filter(item => plainObject(item.card) && item.card.platform && Number(item.verified) === 1);
  const platformText = text(platform, 40);
  const matched = platformText
    ? list.filter(item => item.card.platform === platformText)
    : list;
  const picked = matched
    .sort((left, right) => Number(right.verified || 0) - Number(left.verified || 0))
    .slice(0, Math.max(1, Math.min(6, Number(limit) || BENCHMARK_FEWSHOT_DEFAULT_LIMIT)));
  if (!picked.length) return '';
  const lines = [BENCHMARK_CARD_FEWSHOT_HEADING];
  picked.forEach((item, index) => {
    const card = item.card;
    const secondhand = item.secondhand ?? card.source?.secondhand;
    lines.push(
      `${index + 1}. 【${card.platform}·${card.hook_type}钩子${Number(item.verified) === 1 ? '·老板已确认' : ''}${secondhand ? '·二手来源' : ''}】`,
      `   开头：${text(card.opening_3s, 120)}`,
      `   结构：${(Array.isArray(card.structure) ? card.structure : []).join(' → ')}`,
      `   情绪/卖点：${text(card.emotion_trigger, 60)}｜${text(card.selling_point_presentation, 80)}`,
      `   CTA/篇幅：${text(card.cta_type, 40)}｜${text(card.duration_or_length, 40)}`,
      `   可复用：${text(card.reusable_pattern, 160)}`,
      `   风险：${(Array.isArray(card.risk_flags) && card.risk_flags.length ? card.risk_flags : ['无']).join('；')}`,
    );
  });
  lines.push('借鉴规则：只复用钩子类型、结构顺序、节奏与CTA形式；门店名、价格、地址、评价等事实一律以本店事实包为准，不得照搬样本事实。');
  return lines.join('\n');
}
