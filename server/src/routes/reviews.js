import { Router } from 'express';
import { curTenant, q } from '../db.js';
import { logOp, pageParams, requireRole } from '../util.js';
import { generate } from '../engines/ai.js';
import { textModelFor, yunwuAvailable } from '../engines/yunwu.js';
import { assertRealAiOutput } from '../engines/ai-delivery-status.js';
import {
  estimateCallCredits,
  holdCredits,
  precheckByRole,
  releaseHold,
  settleHold,
} from '../engines/credits.js';
import { executeHeldDelivery } from '../engines/two-phase-delivery.js';

// ===== 评价中心：好评差评台账 + AI 回复稿（真实计费）+ 差评预警 =====
// 台账来源：手录单条 / 批量导入（前端解析 Excel 后提交 JSON）。
// AI 只生成回复稿，是否发布由人在平台上操作（外发动作永远人工）。

const r = Router();
const PLATFORMS = new Set(['美团', '饿了么', '大众点评', '抖音', '其他']);
const STATUSES = new Set(['待回复', '已回复', '无需回复']);
// 差评六类归因（行业 SOP：归因→流程节点→整改，同一条选一个主因）
const CATEGORIES = ['漏发错发', '口味出品', '配送问题', '服务态度', '出餐慢', '恶意差评'];
const CATEGORY_SET = new Set(CATEGORIES);
// 简易归因规则：录入/导入时按关键词自动预归因，人工可改
const CATEGORY_RULES = [
  // 「少」必须限定缺件语境（少发/少送/少给），避免把「分量变少」误归为漏发
  { category: '漏发错发', pattern: /漏(发|送|了)|少(发|送|给)|错(菜|单|发|送)|没(给|放|收到|送)/u },
  { category: '配送问题', pattern: /配送|骑手|外卖员|洒|撒|漏(汤|汁)|凉(了|的)|送(错|慢)|保温/u },
  { category: '出餐慢', pattern: /等(了|位)|太慢|久|超时|催|半天|小时/u },
  { category: '服务态度', pattern: /态度|服务员|不理|凶|冷漠|骂|吵|爱答不理/u },
  { category: '口味出品', pattern: /难吃|咸|淡|辣|油腻|腥|不新鲜|变质|异物|头发|口味|味道|分量|量少/u },
];

function autoCategory(rating, content) {
  if (rating > 3) return null;
  const text = String(content || '');
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(text)) return rule.category;
  }
  return '口味出品';
}

// 差评回复黄金线：超过 24 小时未公开回复即为超时（平台权重与口碑双输）。
// 起算时间：有 review_date（平台上的真实评价日期）用它——导入一条平台上已挂 3 天的差评
// 应立即报超时，而不是从录入时刻再宽限 24 小时；没有才退回录入时刻。
// dashboard 的驾驶舱待办复用同一份 SQL，避免两处口径漂移。
export const REVIEW_SLA_HOURS = 24;
export const OVERDUE_SQL = `status='待回复' AND rating<=3 AND (
  CASE WHEN review_date IS NOT NULL
    THEN review_date < date('now','localtime')
    ELSE created_at <= datetime('now','localtime','-${REVIEW_SLA_HOURS} hours')
  END
)`;

// 宽松解析评价日期：兼容 2026-08-27 / 2026/8/27 / Excel cellDates 导出的 ISO 串
function normalizeReviewDate(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/u);
  if (!match) return null;
  const [, year, month, day] = match;
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function normalizeReviewInput(raw) {
  const rating = Number(raw?.rating);
  const content = String(raw?.content || '').trim();
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { error: '评分必须是 1-5 的整数' };
  if (!content) return { error: '评价内容不能为空' };
  if (content.length > 2000) return { error: '评价内容过长（超过 2000 字）' };
  const platform = PLATFORMS.has(String(raw?.platform)) ? String(raw.platform) : '其他';
  return {
    platform,
    rating,
    content,
    author: String(raw?.author || '').slice(0, 50) || null,
    storeName: String(raw?.storeName || raw?.store_name || '').slice(0, 80) || null,
    reviewDate: normalizeReviewDate(raw?.reviewDate || raw?.review_date),
  };
}

// 去重口径（手录与导入共用）：同平台+同日期+同内容视为同一条
function findDuplicateReview(normalized) {
  return q.get(
    `SELECT id FROM store_reviews WHERE tenant_id=? AND platform=? AND content=? AND COALESCE(review_date,'')=COALESCE(?,'')`,
    curTenant(),
    normalized.platform,
    normalized.content,
    normalized.reviewDate,
  );
}

r.get('/', (req, res) => {
  const { size, offset } = pageParams(req.query);
  const conditions = ['tenant_id=?'];
  const params = [curTenant()];
  const status = String(req.query.status || '');
  if (STATUSES.has(status)) {
    conditions.push('status=?');
    params.push(status);
  }
  const platform = String(req.query.platform || '');
  if (PLATFORMS.has(platform)) {
    conditions.push('platform=?');
    params.push(platform);
  }
  if (req.query.bad === '1') conditions.push('rating <= 3');
  const category = String(req.query.category || '');
  if (CATEGORY_SET.has(category)) {
    conditions.push('category=?');
    params.push(category);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = q.get(`SELECT COUNT(*) n FROM store_reviews ${where}`, ...params)?.n || 0;
  const rows = q.all(
    `SELECT *, CASE WHEN ${OVERDUE_SQL} THEN 1 ELSE 0 END slaOverdue
     FROM store_reviews ${where}
     ORDER BY CASE WHEN ${OVERDUE_SQL} THEN 0 WHEN status='待回复' AND rating<=3 THEN 1 WHEN status='待回复' THEN 2 ELSE 3 END,
       COALESCE(review_date, date(created_at)) DESC, id DESC
     LIMIT ? OFFSET ?`,
    ...params,
    size,
    offset,
  );
  res.set('Cache-Control', 'private, no-store');
  res.json({ total, rows: rows.map(row => ({ ...row, slaOverdue: Number(row.slaOverdue) === 1 })) });
});

// 差评归因统计 + 被点名的菜（差评正文匹配菜品名）：整改抓手
r.get('/insights', (req, res) => {
  const categoryRows = q.all(
    `SELECT COALESCE(category,'未归因') category, COUNT(*) n
     FROM store_reviews WHERE tenant_id=? AND rating<=3
     GROUP BY COALESCE(category,'未归因') ORDER BY n DESC`,
    curTenant(),
  );
  const dishes = q.all(
    `SELECT name FROM dishes WHERE tenant_id=? AND (status IS NULL OR status != '下架')`,
    curTenant(),
  );
  const badBodies = q.all(
    `SELECT content FROM store_reviews WHERE tenant_id=? AND rating<=3
     ORDER BY id DESC LIMIT 300`,
    curTenant(),
  );
  const mentioned = dishes
    .map(dish => ({
      name: dish.name,
      count: badBodies.filter(row => String(row.content || '').includes(dish.name)).length,
    }))
    .filter(item => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  res.set('Cache-Control', 'private, no-store');
  res.json({
    categories: categoryRows.map(row => ({ category: row.category, count: Number(row.n) })),
    mentionedDishes: mentioned,
    slaHours: REVIEW_SLA_HOURS,
  });
});

r.get('/summary', (req, res) => {
  const row = q.get(
    `SELECT COUNT(*) total,
      SUM(CASE WHEN rating<=3 THEN 1 ELSE 0 END) bad,
      SUM(CASE WHEN status='待回复' THEN 1 ELSE 0 END) pending,
      SUM(CASE WHEN status='待回复' AND rating<=3 THEN 1 ELSE 0 END) pendingBad,
      SUM(CASE WHEN ${OVERDUE_SQL} THEN 1 ELSE 0 END) slaOverdue,
      ROUND(AVG(rating),2) avgRating
     FROM store_reviews WHERE tenant_id=?`,
    curTenant(),
  ) || {};
  res.set('Cache-Control', 'private, no-store');
  res.json({
    total: Number(row.total) || 0,
    bad: Number(row.bad) || 0,
    pending: Number(row.pending) || 0,
    pendingBad: Number(row.pendingBad) || 0,
    slaOverdue: Number(row.slaOverdue) || 0,
    slaHours: REVIEW_SLA_HOURS,
    avgRating: row.avgRating != null ? Number(row.avgRating) : null,
  });
});

r.post('/', (req, res) => {
  const normalized = normalizeReviewInput(req.body || {});
  if (normalized.error) return res.status(400).json({ error: normalized.error });
  // 双击提交/重复录入防线：与导入共用同一去重口径
  const duplicate = findDuplicateReview(normalized);
  if (duplicate) return res.status(409).json({ error: '这条评价已录入过（同平台同日期同内容），无需重复录入' });
  const category = CATEGORY_SET.has(String(req.body?.category))
    ? String(req.body.category)
    : autoCategory(normalized.rating, normalized.content);
  const created = q.run(
    `INSERT INTO store_reviews(tenant_id,platform,rating,content,author,store_name,review_date,category,created_by)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    curTenant(),
    normalized.platform,
    normalized.rating,
    normalized.content,
    normalized.author,
    normalized.storeName,
    normalized.reviewDate,
    category,
    req.user.id,
  );
  logOp(req.user, '评价中心', '录入评价', `${normalized.platform}·${normalized.rating}星${category ? `·${category}` : ''}`);
  res.json({ ok: true, id: Number(created.lastInsertRowid), category });
});

// 人工修正归因（归因决定整改责任，允许一键改）
r.put('/:id/category', (req, res) => {
  const review = q.get('SELECT id FROM store_reviews WHERE tenant_id=? AND id=?', curTenant(), Number(req.params.id));
  if (!review) return res.status(404).json({ error: '评价不存在' });
  const category = String(req.body?.category || '');
  if (category && !CATEGORY_SET.has(category)) return res.status(400).json({ error: `归因仅支持：${CATEGORIES.join('/')}` });
  q.run('UPDATE store_reviews SET category=? WHERE tenant_id=? AND id=?', category || null, curTenant(), review.id);
  res.json({ ok: true });
});

// 批量导入：前端解析 Excel/CSV 后提交 rows 数组；逐行校验，坏行如实返回不静默丢弃。
// 超过 500 行直接拒绝（而不是静默截断丢行）——前端会自动分批提交。
r.post('/import', (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: '没有可导入的评价行' });
  if (rows.length > 500) {
    return res.status(400).json({ error: `单次最多导入 500 条（本次 ${rows.length} 条），请分批提交` });
  }
  let imported = 0;
  const failures = [];
  for (let index = 0; index < rows.length; index += 1) {
    const normalized = normalizeReviewInput(rows[index]);
    if (normalized.error) {
      failures.push({ row: index + 1, error: normalized.error });
      continue;
    }
    const duplicate = findDuplicateReview(normalized);
    if (duplicate) {
      failures.push({ row: index + 1, error: '重复评价（已存在），跳过' });
      continue;
    }
    q.run(
      `INSERT INTO store_reviews(tenant_id,platform,rating,content,author,store_name,review_date,category,created_by)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      curTenant(),
      normalized.platform,
      normalized.rating,
      normalized.content,
      normalized.author,
      normalized.storeName,
      normalized.reviewDate,
      autoCategory(normalized.rating, normalized.content),
      req.user.id,
    );
    imported += 1;
  }
  logOp(req.user, '评价中心', '批量导入评价', `成功${imported}条/失败${failures.length}条`);
  res.json({ ok: true, imported, failures });
});

// AI 生成回复稿：真实计费、fail-closed；生成后仅回填草稿，发布仍由人工在平台完成
r.post('/:id/ai-reply', async (req, res) => {
  const review = q.get('SELECT * FROM store_reviews WHERE tenant_id=? AND id=?', curTenant(), Number(req.params.id));
  if (!review) return res.status(404).json({ error: '评价不存在' });
  if (!yunwuAvailable()) return res.status(503).json({ error: '真实 AI 通道未配置，无法生成回复' });
  const tone = String(req.body?.tone || '').slice(0, 60);
  const model = textModelFor('sales');
  let hold = null;
  try {
    precheckByRole(req.user.id, 'text', req.user.role);
    hold = holdCredits({
      userId: req.user.id,
      feature: '评价中心·AI 回复稿',
      kind: 'text',
      model,
      credits: estimateCallCredits({ model, outputTokens: 3000, texts: [review.content] }),
      refType: 'store_review',
      refId: review.id,
    });
    const deliveryHold = hold;
    hold = null;
    const delivered = await executeHeldDelivery({
      hold: deliveryHold,
      generate: async () => {
        let output = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          // 按差评归因套用行业 SOP 话术策略（黄金原则：不争辩、不删评、不刷好评）
          const categoryPlaybook = {
            漏发错发: '策略：承认核对疏忽→说明已加强「打包二次核对+封签」流程→给出补救路径（联系平台补发/退款）→欢迎回复订单号跟进。',
            口味出品: '策略：感谢具体反馈→说明该菜品已反馈后厨复盘（口味校准/出品标准）→邀请顾客再来验证改进，可提到会为TA留意这道菜。',
            配送问题: '策略：说明配送环节与骑手调度相关但门店主动担责→已优化打包（加固、二次封口、汤汁分装）→本单愿意协商补救。',
            服务态度: '策略：直接认错不找借口→说明已与当班同事复盘并按服务标准重新培训→诚恳邀请顾客再来感受变化。',
            出餐慢: '策略：承认高峰期节奏没控好→给出具体动作（加开出餐岗位/上调爆单时段备货）→邀请下次到店优先安排。',
            恶意差评: '策略：保持克制专业，用温和的事实说明（已核对当日记录、曾尝试联系未果）让旁观顾客自行判断，邀请对方联系核实；绝不争吵、不阴阳怪气。',
          };
          output = await generate({
            kind: 'store-review-reply',
            system: [
              `你是餐饮门店的口碑运营，替老板写${review.platform}平台的评价回复。`,
              '铁律：不与顾客争辩、不承诺删评换补偿、不诱导好评（平台会惩罚且伤口碑）。',
              '要求：',
              review.rating <= 3
                ? `- 这是差评（归因：${review.category || '未归因'}）：先真诚道歉并针对顾客提到的具体问题回应（不狡辩、不模板化），给出已经或将要采取的改进动作，邀请顾客再来验证；语气诚恳不卑微。`
                : '- 这是好评：具体感谢顾客提到的点（不要泛泛"感谢支持"），自然带出一个招牌或新品，欢迎再来。',
              review.rating <= 3 && review.category && categoryPlaybook[review.category]
                ? `- ${categoryPlaybook[review.category]}`
                : '',
              '- 不承诺赔偿金额或折扣数字；不留电话/微信；不出现"亲"这种客服腔。',
              `- 长度 60-140 字。${tone ? `语气要求：${tone}。` : ''}`,
              '- 只输出回复正文，不要任何前后缀。',
              `【顾客评价（${review.rating} 星）】${review.content}`,
            ].filter(Boolean).join('\n'),
            userMsg: '请输出回复正文。',
            fallback: () => '',
            maxTokens: 3000,
            role: req.user.role,
            model,
            providerPolicy: 'yunwu_only',
            signal: req.requestSignal,
          });
          const retryable =
            output?.mode !== 'api' &&
            ['provider_rate_limited', 'provider_empty_output'].includes(output?.providerFailure?.code);
          if (!retryable || attempt === 2) break;
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        assertRealAiOutput(output, { label: '评价回复', noDelivery: '本次不生成回复稿，也不扣费' });
        const text = String(output.text || '').replace(/^["'「『]+|["'」』]+$/gu, '').trim();
        if (text.length < 20) throw Object.assign(new Error('回复稿过短，已拒收，请重试'), { status: 422 });
        return { text, output };
      },
      persist: generated => generated.text,
      settle: settleHold,
      release: releaseHold,
      settlement: generated => ({
        usage: generated.output.usage,
        model: generated.output.model,
        aiMode: generated.output.mode,
        note: `评价回复稿：${review.platform} ${review.rating}星`,
      }),
      requirePositiveApiUsage: true,
      releaseNote: '评价回复稿未交付，预授权全额退回',
    });
    res.set('Cache-Control', 'private, no-store');
    return res.json({
      draft: delivered.delivery,
      billing: delivered.billing,
      boundary: '这只是回复草稿；确认后请复制到平台发布，系统不会代替你对外发布。',
    });
  } catch (error) {
    if (hold) {
      try {
        releaseHold(hold, '评价回复未进入模型生成，预授权全额退回');
      } catch { /* 保留原始错误 */ }
      hold = null;
    }
    return res.status(error.status || 502).json({
      error: String(error?.message || '评价回复生成失败').slice(0, 200),
      ...(error.billing ? { billing: error.billing } : {}),
    });
  }
});

// 保存回复并更新状态（人工确认后回填）
r.put('/:id/reply', (req, res) => {
  const review = q.get('SELECT id FROM store_reviews WHERE tenant_id=? AND id=?', curTenant(), Number(req.params.id));
  if (!review) return res.status(404).json({ error: '评价不存在' });
  const reply = String(req.body?.reply || '').trim();
  const status = STATUSES.has(String(req.body?.status)) ? String(req.body.status) : reply ? '已回复' : '待回复';
  if (status === '已回复' && !reply) return res.status(400).json({ error: '标记已回复前请填写回复内容' });
  q.run(
    `UPDATE store_reviews SET reply=?, status=?, replied_at=CASE WHEN ?='已回复' THEN datetime('now','localtime') ELSE replied_at END
     WHERE tenant_id=? AND id=?`,
    reply || null,
    status,
    status,
    curTenant(),
    review.id,
  );
  logOp(req.user, '评价中心', status === '已回复' ? '确认回复' : '更新评价状态', `#${review.id} → ${status}`);
  res.json({ ok: true });
});

// 评价台账是口碑复盘依据：物理删除只留给老板/管理员/运营总监，防止员工无痕销毁差评
r.delete('/:id', requireRole('boss', 'admin', 'ops_director'), (req, res) => {
  const review = q.get('SELECT id FROM store_reviews WHERE tenant_id=? AND id=?', curTenant(), Number(req.params.id));
  if (!review) return res.status(404).json({ error: '评价不存在' });
  q.run('DELETE FROM store_reviews WHERE tenant_id=? AND id=?', curTenant(), review.id);
  logOp(req.user, '评价中心', '删除评价', `#${review.id}`);
  res.json({ ok: true });
});

export default r;
