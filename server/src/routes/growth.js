import { Router } from 'express';
import { q, curTenant } from '../db.js';
import { authMiddleware, maskPhone, logOp, notify, today, pct, pageParams, safeJsonArray, safeJsonParse } from '../util.js';
import { rescoreLead, funnel } from '../engines/scoring.js';
import { generate, kbContext, tplInvite } from '../engines/ai.js';
import { precheck, precheckByRole, charge } from '../engines/credits.js';
import { accessibleUserExists, canAccessOwner, userScopeClause } from '../engines/access.js';
import { archiveAndDelete, deleteList, deletionDenied, isBossLike, isManagerLike, tableRows } from '../engines/deletion.js';

const r = Router();
const STAGES = ['新线索', '已沟通', '已邀约', '已到店', '已成交', '复购'];

// ===== 客户生命周期 11 节点 =====
// 新写入只使用餐饮门店口径；历史酒类项目节点在读取时映射，不再继续写入旧值。
const JOURNEY_NODES = ['新线索', '已联系', '已建档', '已邀约', '已到店', '已体验', '已选品', '待成交', '已成交', '复购', '转介绍'];
const LEGACY_JOURNEY_NODE_MAP = { '已到馆': '已到店', '已品鉴': '已体验', '已报价': '已选品' };
// 运营阶段 → 生命周期节点映射（阶段推进时自动点亮）
const STAGE_TO_NODES = { '已沟通': ['已联系'], '已邀约': ['已邀约'], '已到店': ['已到店'], '已成交': ['待成交', '已成交'], '复购': ['复购'] };
const canonicalJourneyNode = node => LEGACY_JOURNEY_NODE_MAP[node] || node;
function markJourney(leadId, node, by, note) {
  const canonical = canonicalJourneyNode(node);
  if (!JOURNEY_NODES.includes(canonical)) return;
  q.run(`INSERT OR IGNORE INTO lead_journey(lead_id,node,at,by,note) VALUES(?,?,datetime('now','localtime'),?,?)`, leadId, canonical, by || null, note || null);
}
// 关键词点亮：旧词仅用于识别历史输入，落库始终写当前餐饮节点。
function markByKeywords(leadId, text, by) {
  if (!text) return;
  if (/到店体验|用餐体验|试吃|试菜|品鉴|品酒|试饮|回厂游/.test(text)) markJourney(leadId, '已体验', by, text.slice(0, 60));
  if (/选品|菜单|报价|方案|价格沟通|政策沟通|合同/.test(text)) markJourney(leadId, '已选品', by, text.slice(0, 60));
}

const VALID_STAGES = [...STAGES, '已流失'];
const VALID_SOURCES = ['短视频', '朋友圈', '社群', '转介绍', '门店活动', '到店', '合作伙伴推荐', '外卖平台', '大众点评', '地图搜索'];
const LEGACY_SOURCE_MAP = { '品鉴会': '门店活动', '合伙人推荐': '合作伙伴推荐' };
const VALID_IDENTITIES = ['企业主', '高管', '个体创业者', '普通消费者'];
const VALID_BUDGETS = ['高', '中', '低', '未知'];

const cleanText = v => {
  const s = String(v ?? '').trim();
  return s || null;
};
const normalizeLeadSource = (value, fallback = '到店') => {
  const source = cleanText(value);
  if (!source) return fallback;
  return LEGACY_SOURCE_MAP[source] || (VALID_SOURCES.includes(source) ? source : source);
};
const pickChoice = (v, list, fallback) => {
  const s = cleanText(v);
  if (!s) return fallback;
  return list.includes(s) ? s : fallback;
};
const normalizeDate = v => {
  const s = cleanText(v);
  if (!s) return null;
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return s.slice(0, 20);
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
};
function resolveBatchOwner(req, rawOwnerId) {
  const id = Number(rawOwnerId);
  if (!id) return req.user.id;
  return accessibleUserExists(req.user, id) ? id : req.user.id;
}
function normalizeLeadBatchRow(raw, req) {
  const b = raw || {};
  const provided = b._provided || {};
  const has = f => (provided[f] !== undefined ? !!provided[f] : cleanText(b[f]) !== null);
  return {
    name: cleanText(b.name),
    phone: cleanText(b.phone),
    wechat: cleanText(b.wechat),
    source: pickChoice(normalizeLeadSource(b.source), VALID_SOURCES, '到店'),
    identity_tag: pickChoice(b.identity_tag, VALID_IDENTITIES, '普通消费者'),
    interest: cleanText(b.interest),
    budget_level: pickChoice(b.budget_level, VALID_BUDGETS, '未知'),
    stage: pickChoice(b.stage, VALID_STAGES, '新线索'),
    owner_id: resolveBatchOwner(req, b.owner_id),
    region: cleanText(b.region),
    company: cleanText(b.company),
    next_follow_at: normalizeDate(b.next_follow_at),
    next_action: cleanText(b.next_action),
    note: cleanText(b.note),
    _provided: {
      source: has('source'),
      identity_tag: has('identity_tag'),
      interest: has('interest'),
      budget_level: has('budget_level'),
      stage: has('stage'),
      owner_id: has('owner_id'),
      region: has('region'),
      company: has('company'),
      next_follow_at: has('next_follow_at'),
      next_action: has('next_action'),
      wechat: has('wechat'),
      phone: has('phone'),
    },
  };
}
function findBatchDuplicate(row, req) {
  if (!row.phone) return null;
  let sql = `SELECT * FROM leads WHERE tenant_id = ${curTenant()} AND phone = ?`;
  const params = [row.phone];
  const scope = userScopeClause(req.user, 'owner_id');
  sql += scope.sql; params.push(...scope.params);
  return q.get(`${sql} ORDER BY id DESC LIMIT 1`, ...params);
}
function updateBatchLead(id, row) {
  const fields = ['name', 'phone', 'wechat', 'source', 'identity_tag', 'interest', 'budget_level', 'stage', 'owner_id', 'region', 'company', 'next_follow_at', 'next_action'];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (row._provided && f !== 'name' && !row._provided[f]) continue;
    if (row[f] !== undefined && row[f] !== null && row[f] !== '') {
      sets.push(`${f} = ?`);
      params.push(row[f]);
    }
  }
  if (sets.length) q.run(`UPDATE leads SET ${sets.join(', ')}, updated_at=datetime('now','localtime') WHERE id = ?`, ...params, id);
}
function monthRange(input) {
  const ym = /^\d{4}-\d{2}$/.test(String(input || '')) ? String(input) : today().slice(0, 7);
  const start = `${ym}-01`;
  const d = new Date(`${start}T00:00:00`);
  d.setMonth(d.getMonth() + 1);
  return { ym, start, end: d.toISOString().slice(0, 10) };
}
function leadOwnerScope(req, alias = 'l') {
  return userScopeClause(req.user, `${alias}.owner_id`);
}
function ensureLeadAccess(req, res, id) {
  const lead = q.scopedGet('leads', 'AND id = ?', id); // 作用域包装自动追加 tenant_id 过滤（BE-C2）
  if (!lead || !canAccessOwner(req.user, lead.owner_id)) {
    res.status(404).json({ error: '客户不存在或无权访问' });
    return null;
  }
  return lead;
}

function leadDeletePolicy(req, lead) {
  const followCount = q.scopedCount('follow_ups', 'AND lead_id = ?', lead.id);
  const orderCount = q.scopedCount('orders', 'AND lead_id = ?', lead.id);
  const inviteCount = q.scopedCount('activity_invites', 'AND lead_id = ?', lead.id);
  const critical = ['已成交', '复购'].includes(lead.stage) || orderCount > 0 || Number(lead.deal_amount || 0) > 0;
  if (critical) {
    return {
      allowed: isBossLike(req.user),
      requiredRole: 'boss',
      reason: '成交/复购客户或已有订单，属于关键客户资产',
      followCount, orderCount, inviteCount,
    };
  }
  if (isBossLike(req.user)) return { allowed: true, requiredRole: 'boss', reason: '老板/管理员删除客户', followCount, orderCount, inviteCount };
  if (isManagerLike(req.user) && canAccessOwner(req.user, lead.owner_id)) {
    return {
      allowed: true,
      requiredRole: inviteCount || followCount ? 'manager' : 'self',
      reason: inviteCount || followCount ? '管理层删除团队客户及关联沟通记录' : '管理层删除团队客户',
      followCount, orderCount, inviteCount,
    };
  }
  const simpleOwn = Number(lead.owner_id) === Number(req.user.id)
    && ['新线索', '已沟通'].includes(lead.stage)
    && followCount === 0 && inviteCount === 0;
  return {
    allowed: simpleOwn,
    requiredRole: simpleOwn ? 'self' : 'manager',
    reason: simpleOwn ? '本人删除误录客户' : '已有沟通/邀约或不属于本人，需管理层处理',
    followCount, orderCount, inviteCount,
  };
}

r.get('/summary', (req, res) => {
  const t = today();
  const scope = userScopeClause(req.user, 'owner_id');
  const importedOps = q.get(`SELECT COUNT(*) rows,MIN(date) start_date,MAX(date) end_date,
    COALESCE(SUM(new_leads),0) new_leads,COALESCE(SUM(invited),0) invited,
    COALESCE(SUM(arrived),0) arrived,COALESCE(SUM(deals),0) deals,
    COALESCE(SUM(deal_amount),0) deal_amount
    FROM daily_ops WHERE tenant_id=?`, curTenant()) || {};
  res.json({
    todayNew: q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()} AND date(created_at) = ?${scope.sql}`, t, ...scope.params)?.n || 0,
    pending: q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()} AND stage NOT IN ('已成交','复购','已流失')${scope.sql}`, ...scope.params)?.n || 0,
    total: q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()}${scope.sql}`, ...scope.params)?.n || 0,
    invited: q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()} AND stage = '已邀约'${scope.sql}`, ...scope.params)?.n || 0,
    arrived: q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()} AND stage = '已到店'${scope.sql}`, ...scope.params)?.n || 0,
    dealt: q.get(`SELECT COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()} AND stage IN ('已成交','复购')${scope.sql}`, ...scope.params)?.n || 0,
    importedOps: {
      rows: Number(importedOps.rows || 0),
      startDate: importedOps.start_date || null,
      endDate: importedOps.end_date || null,
      newLeads: Number(importedOps.new_leads || 0),
      invited: Number(importedOps.invited || 0),
      arrived: Number(importedOps.arrived || 0),
      deals: Number(importedOps.deals || 0),
      dealAmount: Number(importedOps.deal_amount || 0),
    },
  });
});

r.get('/sources', (req, res) => {
  const scope = userScopeClause(req.user, 'owner_id');
  res.json(q.all(`SELECT source, COUNT(*) n FROM leads WHERE tenant_id = ${curTenant()}${scope.sql} GROUP BY source ORDER BY n DESC`, ...scope.params));
});

r.get('/funnel', (req, res) => res.json(funnel()));

r.get('/follow-report', (req, res) => {
  const { ym, start, end } = monthRange(req.query.month);
  const ownerScope = leadOwnerScope(req);
  const ownerClause = ownerScope.sql.trim();
  const ownerParams = ownerScope.params;
  const whereBase = `f.tenant_id = ${curTenant()} AND f.created_at >= ? AND f.created_at < ?`;
  const summary = {
    month: ym,
    communicatedCustomers: q.get(`SELECT COUNT(DISTINCT f.lead_id) n FROM follow_ups f JOIN leads l ON l.id = f.lead_id
      WHERE ${whereBase} /* tenant_id in whereBase */ ${ownerClause}`, start, end, ...ownerParams)?.n || 0,
    followRecords: q.get(`SELECT COUNT(*) n FROM follow_ups f JOIN leads l ON l.id = f.lead_id
      WHERE ${whereBase} /* tenant_id in whereBase */ ${ownerClause}`, start, end, ...ownerParams)?.n || 0,
    activeStaff: q.get(`SELECT COUNT(DISTINCT f.user_id) n FROM follow_ups f JOIN leads l ON l.id = f.lead_id
      WHERE ${whereBase} /* tenant_id in whereBase */ ${ownerClause}`, start, end, ...ownerParams)?.n || 0,
    nextScheduled: q.get(`SELECT COUNT(*) n FROM leads l WHERE l.tenant_id = ${curTenant()} AND l.next_follow_at IS NOT NULL
      AND l.stage NOT IN ('已成交','复购','已流失') ${ownerClause.replace('l.owner_id', 'l.owner_id')}`, ...ownerParams)?.n || 0,
    overdue: q.get(`SELECT COUNT(*) n FROM leads l WHERE l.tenant_id = ${curTenant()} AND l.next_follow_at < date('now','localtime')
      AND l.stage NOT IN ('已成交','复购','已流失') ${ownerClause.replace('l.owner_id', 'l.owner_id')}`, ...ownerParams)?.n || 0,
  };
  const rows = q.all(`SELECT l.id, l.name, l.stage, l.grade, l.score, l.budget_level, l.interest, l.next_follow_at, l.next_action,
      owner.name owner_name,
      COUNT(f.id) month_follow_count,
      (SELECT COUNT(*) FROM follow_ups fx WHERE fx.lead_id = l.id) total_follow_count,
      (SELECT ff.content FROM follow_ups ff WHERE ff.lead_id = l.id AND ff.created_at >= ? AND ff.created_at < ? ORDER BY ff.created_at DESC LIMIT 1) last_content,
      (SELECT ff.created_at FROM follow_ups ff WHERE ff.lead_id = l.id AND ff.created_at >= ? AND ff.created_at < ? ORDER BY ff.created_at DESC LIMIT 1) last_follow_at,
      (SELECT u2.name FROM follow_ups ff LEFT JOIN users u2 ON u2.id = ff.user_id WHERE ff.lead_id = l.id AND ff.created_at >= ? AND ff.created_at < ? ORDER BY ff.created_at DESC LIMIT 1) last_follower_name,
      (SELECT GROUP_CONCAT(name, '、') FROM (
        SELECT DISTINCT COALESCE(u3.name, '未知账号') name
        FROM follow_ups ff LEFT JOIN users u3 ON u3.id = ff.user_id
        WHERE ff.lead_id = l.id AND ff.created_at >= ? AND ff.created_at < ?
        ORDER BY name
      )) follower_names,
      (SELECT suggestion FROM lead_ai_suggestions s WHERE s.lead_id = l.id ORDER BY s.created_at DESC LIMIT 1) last_ai_suggestion,
      (SELECT created_at FROM lead_ai_suggestions s WHERE s.lead_id = l.id ORDER BY s.created_at DESC LIMIT 1) last_ai_at,
      (SELECT COUNT(*) FROM lead_ai_suggestions s WHERE s.lead_id = l.id AND s.created_at >= ? AND s.created_at < ?) ai_suggestion_count
    FROM follow_ups f
    JOIN leads l ON l.id = f.lead_id
    LEFT JOIN users owner ON owner.id = l.owner_id
    WHERE ${whereBase} /* tenant_id in whereBase */ ${ownerClause}
    GROUP BY l.id
    ORDER BY last_follow_at DESC
    LIMIT 200`,
    start, end, start, end, start, end, start, end, start, end, start, end, ...ownerParams);
  const staff = q.all(`SELECT COALESCE(u.name, '未知账号') name, COUNT(*) follow_count, COUNT(DISTINCT f.lead_id) customer_count, MAX(f.created_at) last_at
    FROM follow_ups f JOIN leads l ON l.id = f.lead_id LEFT JOIN users u ON u.id = f.user_id
    WHERE ${whereBase} /* tenant_id in whereBase */ ${ownerClause}
    GROUP BY f.user_id, u.name
    ORDER BY follow_count DESC`, start, end, ...ownerParams);
  res.json({ month: ym, summary, rows, staff });
});

r.get('/leads', (req, res) => {
  const { stage, grade, kw, owner, source, followStatus, sort = 'score' } = req.query;
  const { size, offset } = pageParams(req.query);
  let where = `WHERE l.tenant_id = ${curTenant()}`; const params = [];
  const scope = leadOwnerScope(req);
  where += scope.sql; params.push(...scope.params);
  if (stage) { where += ' AND l.stage = ?'; params.push(stage); }
  if (grade) { where += ' AND l.grade = ?'; params.push(grade); }
  if (owner) { where += ' AND l.owner_id = ?'; params.push(owner); }
  if (source) { where += ' AND l.source = ?'; params.push(source); }
  if (followStatus === 'followed') where += ' AND EXISTS (SELECT 1 FROM follow_ups f WHERE f.lead_id = l.id)';
  if (followStatus === 'unfollowed') where += ' AND NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.lead_id = l.id)';
  if (followStatus === 'next') where += " AND l.next_follow_at IS NOT NULL AND trim(l.next_follow_at) <> ''";
  if (followStatus === 'overdue') where += " AND l.next_follow_at IS NOT NULL AND trim(l.next_follow_at) <> '' AND l.next_follow_at < date('now','localtime')";
  if (kw) { where += ' AND (l.name LIKE ? OR l.company LIKE ? OR l.phone LIKE ?)'; params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`); }
  const orderBy = {
    score: 'l.score DESC',
    scoreAsc: 'l.score ASC',
    created: 'l.created_at DESC',
    follow: "CASE WHEN l.next_follow_at IS NULL OR trim(l.next_follow_at) = '' THEN 1 ELSE 0 END, l.next_follow_at ASC",
    followDesc: "CASE WHEN l.next_follow_at IS NULL OR trim(l.next_follow_at) = '' THEN 1 ELSE 0 END, l.next_follow_at DESC",
    followCount: 'follow_count DESC, l.score DESC',
    followCountAsc: 'follow_count ASC, l.score DESC',
    lastFollow: 'last_follow_at DESC, l.score DESC',
    lastFollowAsc: 'last_follow_at ASC, l.score DESC',
    source: 'l.source ASC, l.score DESC',
    sourceDesc: 'l.source DESC, l.score DESC',
    stage: 'l.stage ASC, l.score DESC',
    stageDesc: 'l.stage DESC, l.score DESC',
    budget: "CASE l.budget_level WHEN '高' THEN 1 WHEN '中' THEN 2 WHEN '低' THEN 3 ELSE 4 END, l.score DESC",
    budgetLow: "CASE l.budget_level WHEN '低' THEN 1 WHEN '中' THEN 2 WHEN '高' THEN 3 ELSE 4 END, l.score DESC",
    owner: 'u.name ASC, l.score DESC',
    ownerDesc: 'u.name DESC, l.score DESC',
    name: 'l.name ASC',
    nameDesc: 'l.name DESC',
  }[sort] || 'l.score DESC';
  const total = q.get(`SELECT COUNT(*) n FROM leads l ${where}`, ...params)?.n || 0;
  const rows = q.all(`SELECT l.*, u.name owner_name,
    (SELECT COUNT(*) FROM follow_ups f WHERE f.lead_id = l.id) follow_count,
    (SELECT f.created_at FROM follow_ups f WHERE f.lead_id = l.id ORDER BY f.created_at DESC LIMIT 1) last_follow_at,
    (SELECT u2.name FROM follow_ups f LEFT JOIN users u2 ON u2.id = f.user_id WHERE f.lead_id = l.id ORDER BY f.created_at DESC LIMIT 1) last_follower_name,
    (SELECT GROUP_CONCAT(name, '、') FROM (
      SELECT DISTINCT COALESCE(u3.name, '未知账号') name
      FROM follow_ups f LEFT JOIN users u3 ON u3.id = f.user_id
      WHERE f.lead_id = l.id
      ORDER BY name
    )) follower_names
    FROM leads l LEFT JOIN users u ON u.id = l.owner_id
    ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, ...params, size, offset);
  res.json({ total, rows: rows.map(x => ({ ...x, phone: maskPhone(x.phone, req.user.role), concerns: safeJsonArray(x.concerns) })) });
});

r.post('/leads', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: '客户姓名必填' });
  const ownerId = resolveBatchOwner(req, b.owner_id);
  const source = normalizeLeadSource(b.source);
  const result = q.run(`INSERT INTO leads(name,phone,wechat,source,identity_tag,interest,budget_level,owner_id,region,company,next_follow_at,next_action,last_interact_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    b.name, b.phone || null, b.wechat || null, source, b.identity_tag || '普通消费者',
    b.interest || null, b.budget_level || '未知', ownerId, b.region || null, b.company || null,
    b.next_follow_at || null, b.next_action || null, today());
  const lead = rescoreLead(result.lastInsertRowid);
  markJourney(lead.id, '新线索', req.user.name, `来源：${source}`);
  markJourney(lead.id, '已建档', req.user.name, '录入客户线索表');
  logOp(req.user, '增长中心', '新增客户', b.name);
  res.json(lead);
});

// 员工批量导入线索：Excel/CSV/粘贴解析后由前端提交明细，员工默认归属本人
r.post('/leads/batch', (req, res) => {
  const input = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!input.length) return res.status(400).json({ error: '没有可导入的数据' });
  if (input.length > 500) return res.status(400).json({ error: '单次最多导入500条线索' });
  const result = { ok: true, created: [], updated: [], skipped: [], errors: [] };
  for (let i = 0; i < input.length; i++) {
    const rowNo = i + 2;
    const row = normalizeLeadBatchRow(input[i], req);
    if (!row.name) {
      result.skipped.push({ row: rowNo, reason: '客户姓名为空' });
      continue;
    }
    try {
      const exists = findBatchDuplicate(row, req);
      if (exists) {
        updateBatchLead(exists.id, row);
        if (row.note) {
          q.run('INSERT INTO follow_ups(lead_id,user_id,content,stage_after) VALUES(?,?,?,?)', exists.id, req.user.id, row.note, row.stage);
          markByKeywords(exists.id, row.note, req.user.name);
        }
        const lead = rescoreLead(exists.id);
        result.updated.push({ id: exists.id, name: lead.name });
      } else {
        const inserted = q.run(`INSERT INTO leads(name,phone,wechat,source,identity_tag,interest,budget_level,stage,owner_id,region,company,next_follow_at,next_action,last_interact_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          row.name, row.phone, row.wechat, row.source, row.identity_tag, row.interest, row.budget_level, row.stage, row.owner_id,
          row.region, row.company, row.next_follow_at, row.next_action, today());
        const lead = rescoreLead(inserted.lastInsertRowid);
        markJourney(lead.id, '新线索', req.user.name, `批量导入：${row.source || '到店'}`);
        markJourney(lead.id, '已建档', req.user.name, '批量导入客户线索表');
        if (row.note) {
          q.run('INSERT INTO follow_ups(lead_id,user_id,content,stage_after) VALUES(?,?,?,?)', lead.id, req.user.id, row.note, row.stage);
          markByKeywords(lead.id, row.note, req.user.name);
        }
        result.created.push({ id: lead.id, name: lead.name });
      }
    } catch (e) {
      result.errors.push({ row: rowNo, name: row.name, reason: e.message || '导入失败' });
    }
  }
  logOp(req.user, '增长中心', '批量导入线索', `新增${result.created.length} 更新${result.updated.length} 跳过${result.skipped.length} 失败${result.errors.length}`);
  res.json(result);
});

r.get('/leads/:id', (req, res) => {
  const lead = q.get(`SELECT l.*, u.name owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id WHERE l.tenant_id = ${curTenant()} AND l.id = ?`, req.params.id);
  if (!lead || !canAccessOwner(req.user, lead.owner_id)) return res.status(404).json({ error: '客户不存在或无权访问' });
  const follows = q.all('SELECT f.*, u.name user_name FROM follow_ups f LEFT JOIN users u ON u.id=f.user_id WHERE f.lead_id = ? ORDER BY f.created_at DESC LIMIT 20', req.params.id);
  const followers = q.all(`SELECT u.id user_id, COALESCE(u.name, '未知账号') name, COUNT(*) follow_count, MAX(f.created_at) last_at
    FROM follow_ups f LEFT JOIN users u ON u.id = f.user_id
    WHERE f.lead_id = ?
    GROUP BY u.id, u.name
    ORDER BY last_at DESC`, req.params.id);
  const orders = q.all('SELECT id, product, amount, type, channel, created_at FROM orders WHERE lead_id = ? ORDER BY created_at DESC', req.params.id);
  res.json({
    ...lead,
    phone: maskPhone(lead.phone, req.user.role),
    concerns: safeJsonArray(lead.concerns),
    score_detail: safeJsonParse(lead.score_detail, {}),
    follows,
    follow_stats: {
      total: followers.reduce((sum, x) => sum + (Number(x.follow_count) || 0), 0),
      user_count: followers.length,
      last_user: followers[0]?.name || null,
      last_at: followers[0]?.last_at || null,
      followers,
    },
    orders,
  });
});

r.put('/leads/:id', (req, res) => {
  const lead = ensureLeadAccess(req, res, req.params.id);
  if (!lead) return;
  const b = req.body || {};
  const fields = ['name', 'phone', 'wechat', 'source', 'identity_tag', 'interest', 'budget_level', 'owner_id', 'region', 'company', 'next_follow_at', 'next_action', 'path_type', 'referrer'];
  for (const f of fields) if (b[f] !== undefined) {
    const value = f === 'source' ? normalizeLeadSource(b[f]) : b[f];
    q.run(`UPDATE leads SET ${f} = ? WHERE id = ?`, value, req.params.id);
  }
  res.json(rescoreLead(req.params.id));
});

r.delete('/leads/:id', (req, res) => {
  const lead = ensureLeadAccess(req, res, req.params.id);
  if (!lead) return;
  const policy = leadDeletePolicy(req, lead);
  if (!policy.allowed) return deletionDenied(res, policy.requiredRole, policy.reason);
  const assetRows = tableRows('biz_assets', `source_type='lead' AND source_id=?`, lead.id);
  const assetIds = assetRows.map(x => x.id);
  const children = {
    follow_ups: tableRows('follow_ups', 'lead_id=?', lead.id),
    lead_ai_suggestions: tableRows('lead_ai_suggestions', 'lead_id=?', lead.id),
    lead_journey: tableRows('lead_journey', 'lead_id=?', lead.id),
    orders: tableRows('orders', 'lead_id=?', lead.id),
    activity_invites: tableRows('activity_invites', 'lead_id=?', lead.id),
    biz_assets: assetRows,
    asset_flows: assetIds.length ? q.all(`SELECT * FROM asset_flows WHERE tenant_id=? AND asset_id IN (${assetIds.map(() => '?').join(',')})`, curTenant(), ...assetIds) : [],
  };
  const archiveId = archiveAndDelete(req, {
    entityType: 'lead',
    entityId: lead.id,
    table: 'leads',
    row: lead,
    children,
    module: '增长中心',
    title: lead.name,
    summary: `阶段=${lead.stage || '-'}；负责人#${lead.owner_id || '-'}；跟进${policy.followCount}条；订单${policy.orderCount}笔`,
    requiredRole: policy.requiredRole,
    reason: req.body?.reason || policy.reason,
  }, () => {
    deleteList('activity_invites', 'lead_id=?', lead.id);
    deleteList('lead_journey', 'lead_id=?', lead.id);
    deleteList('lead_ai_suggestions', 'lead_id=?', lead.id);
    deleteList('follow_ups', 'lead_id=?', lead.id);
    deleteList('orders', 'lead_id=?', lead.id);
    if (assetIds.length) {
      q.run(`DELETE FROM asset_flows WHERE tenant_id=? AND asset_id IN (${assetIds.map(() => '?').join(',')})`, curTenant(), ...assetIds);
      q.run(`DELETE FROM biz_assets WHERE tenant_id=? AND id IN (${assetIds.map(() => '?').join(',')})`, curTenant(), ...assetIds);
    }
    deleteList('leads', 'id=?', lead.id);
  });
  logOp(req.user, '增长中心', '删除客户入回收站', `${lead.name} / archive#${archiveId}`);
  res.json({ ok: true, archiveId, message: '已删除并进入回收站，老板/管理员可恢复' });
});

// 阶段推进（CRM-02 状态机：只进不退，流失必填原因，回退需总监权限）
r.post('/leads/:id/advance', (req, res) => {
  const lead = ensureLeadAccess(req, res, req.params.id);
  if (!lead) return;
  const { stage, note, deal_amount, deal_reason, lost_reason } = req.body || {};
  const createsOrder = stage === '已成交' || stage === '复购';
  const amount = createsOrder ? Number(deal_amount) : null;
  const suppliedProduct = cleanText(req.body?.product ?? req.body?.order_product);
  const orderProduct = suppliedProduct?.slice(0, 120) || '待确认商品/服务';
  const orderType = cleanText(req.body?.order_type)?.slice(0, 40) || (stage === '复购' ? '复购' : '首次消费');
  if (createsOrder && (!Number.isFinite(amount) || amount <= 0)) {
    return res.status(400).json({ error: stage === '复购' ? '复购必须填写大于0的本次复购金额' : '成交必须填写大于0的成交金额' });
  }
  if (suppliedProduct && suppliedProduct.length > 120) return res.status(400).json({ error: '成交商品/服务不能超过120字' });
  if (stage === '已流失') {
    if (!lost_reason) return res.status(400).json({ error: '转入流失必须填写流失原因（CRM-07）' });
    q.run(`UPDATE leads SET stage=?, lost_reason=?, updated_at=datetime('now','localtime') WHERE id=?`, stage, lost_reason, lead.id);
  } else {
    const from = STAGES.indexOf(lead.stage), to = STAGES.indexOf(stage);
    if (to < 0) return res.status(400).json({ error: '无效阶段' });
    if (to < from && !['boss', 'ops_director'].includes(req.user.role))
      return res.status(403).json({ error: '阶段回退需总监及以上权限并留痕' });
    if (!note) return res.status(400).json({ error: '推进阶段必须填写本次跟进摘要' });
    q.run(`UPDATE leads SET stage=?, deal_amount=COALESCE(?,deal_amount), deal_reason=COALESCE(?,deal_reason),
           last_interact_at=?, updated_at=datetime('now','localtime') WHERE id=?`,
      stage, amount ?? null, deal_reason ?? null, today(), lead.id);
    if (stage === '已成交') {
      q.run('INSERT INTO orders(lead_id,product,amount,type,region,channel) VALUES(?,?,?,?,?,?)',
        lead.id, orderProduct, amount, orderType, lead.region, normalizeLeadSource(lead.source));
      q.run(`INSERT INTO daily_ops(date,deals,deal_amount) VALUES(?,1,?) ON CONFLICT(tenant_id,date) DO UPDATE SET deals=deals+1, deal_amount=deal_amount+excluded.deal_amount`, today(), amount);
    }
    // 复购=同一客户第2笔及以后订单回写（P0-2修复：打通复购数据闭环，复购率不再恒0）
    if (stage === '复购') {
      q.run('INSERT INTO orders(lead_id,product,amount,type,region,channel) VALUES(?,?,?,?,?,?)',
        lead.id, orderProduct, amount, orderType, lead.region, normalizeLeadSource(lead.source));
      q.run(`INSERT INTO daily_ops(date,repurchase_amount,orders) VALUES(?,?,1) ON CONFLICT(tenant_id,date) DO UPDATE SET repurchase_amount=repurchase_amount+excluded.repurchase_amount, orders=orders+1`, today(), amount);
    }
  }
  if (note) q.run('INSERT INTO follow_ups(lead_id,user_id,content,stage_after) VALUES(?,?,?,?)', lead.id, req.user.id, note, stage);
  // 生命周期节点自动点亮（11官方节点）
  for (const node of (STAGE_TO_NODES[stage] || [])) markJourney(lead.id, node, req.user.name, note);
  markByKeywords(lead.id, note, req.user.name);
  if (stage === '复购') markJourney(lead.id, '已成交', req.user.name, '复购客户必经成交');
  logOp(req.user, '增长中心', '推进阶段', `${lead.name} → ${stage}`);
  const updated = rescoreLead(lead.id);
  if (createsOrder && !suppliedProduct) {
    updated.warnings = [{ code: 'ORDER_PRODUCT_UNCONFIRMED', message: '订单已记录为“待确认商品/服务”，请核对实际商品或服务后补全，系统未推测产品。' }];
  }
  res.json(updated);
});

r.post('/leads/:id/follow', (req, res) => {
  const { content, next_follow_at, next_action } = req.body || {};
  if (!content) return res.status(400).json({ error: '跟进内容必填' });
  const lead = ensureLeadAccess(req, res, req.params.id);
  if (!lead) return;
  q.run('INSERT INTO follow_ups(lead_id,user_id,content) VALUES(?,?,?)', req.params.id, req.user.id, content);
  q.run(`UPDATE leads SET last_interact_at=?, next_follow_at=COALESCE(?,next_follow_at), next_action=COALESCE(?,next_action),
         updated_at=datetime('now','localtime') WHERE id=?`, today(), next_follow_at, next_action, req.params.id);
  markJourney(req.params.id, '已联系', req.user.name, content.slice(0, 60));
  markByKeywords(req.params.id, content, req.user.name);
  res.json(rescoreLead(req.params.id));
});

// ===== 客户生命周期节点追踪（11官方节点 + 每节点时间/经办/停留时长）=====
r.get('/leads/:id/journey', (req, res) => {
  const lead = ensureLeadAccess(req, res, req.params.id);
  if (!lead) return;
  const validAt = v => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? v : null); // 容错：非ISO日期不参与时长计算
  const rows = q.all('SELECT node, at, by, note FROM lead_journey WHERE lead_id = ?', lead.id)
    .map(x => ({ ...x, at: validAt(x.at) }));
  const map = {};
  for (const row of rows) {
    const node = canonicalJourneyNode(row.node);
    if (!JOURNEY_NODES.includes(node)) continue;
    // 同时存在新旧节点时优先展示当前节点；旧节点只作为历史读取兼容。
    if (!map[node] || row.node === node) map[node] = { ...row, node };
  }

  // 数据推导兜底：历史数据没有 journey 行时按既有事实补推
  const firstFollow = q.get('SELECT created_at, content FROM follow_ups WHERE lead_id = ? ORDER BY created_at ASC LIMIT 1', lead.id);
  const orders = q.all('SELECT created_at, amount, type FROM orders WHERE lead_id = ? ORDER BY created_at ASC', lead.id);
  const referred = q.all(`SELECT name FROM leads WHERE tenant_id = ${curTenant()} AND referrer = ? AND id != ?`, lead.name, lead.id);
  const stageIdx = STAGES.indexOf(lead.stage);
  const infer = (node, cond, at, note) => {
    if (!map[node] && cond) map[node] = { node, at: at || null, by: '系统推导', note: note || null, inferred: true };
  };
  infer('新线索', true, lead.created_at, `来源：${lead.source || '-'}`);
  infer('已联系', !!firstFollow || stageIdx >= 1, firstFollow?.created_at || lead.updated_at, firstFollow?.content?.slice(0, 50));
  infer('已建档', !!(lead.phone || lead.company), lead.created_at, '档案信息完整');
  infer('已邀约', stageIdx >= 2, null, `当前阶段：${lead.stage}`);
  infer('已到店', stageIdx >= 3, null, `当前阶段：${lead.stage}`);
  infer('待成交', stageIdx >= 4 || (lead.grade === 'A' && stageIdx >= 3), null, lead.grade === 'A' ? 'A类高意向' : null);
  infer('已成交', stageIdx >= 4, orders[0]?.created_at, orders[0] ? `首单 ¥${orders[0].amount}` : lead.deal_reason);
  infer('复购', lead.stage === '复购' || orders.filter(o => o.type === '复购').length > 0,
    orders.find(o => o.type === '复购')?.created_at, orders.filter(o => o.type === '复购').length ? `复购订单 ${orders.filter(o => o.type === '复购').length} 笔` : null);
  infer('转介绍', referred.length > 0, null, referred.length ? `已转介绍：${referred.slice(0, 3).map(x => x.name).join('、')}${referred.length > 3 ? ` 等${referred.length}人` : ''}` : null);

  // 组装：到达节点带时间与停留时长（距下一到达节点）
  const reachedList = JOURNEY_NODES.filter(n => map[n]);
  const journey = JOURNEY_NODES.map((node, i) => {
    const hit = map[node];
    let stayDays = null;
    if (hit?.at) {
      const next = reachedList.slice(reachedList.indexOf(node) + 1).map(n => map[n].at).find(Boolean);
      const end = next ? new Date(next) : new Date();
      stayDays = Math.max(0, Math.round((end - new Date(hit.at)) / 86400000));
    }
    return { node, reached: !!hit, at: hit?.at || null, by: hit?.by || null, note: hit?.note || null, inferred: !!hit?.inferred, stayDays };
  });
  const current = [...journey].reverse().find(x => x.reached)?.node || '新线索';
  const baseAt = validAt(lead.created_at) || journey.find(x => x.at)?.at;
  const totalDays = baseAt ? Math.max(0, Math.round((Date.now() - new Date(baseAt)) / 86400000)) : 0;
  // 下一步建议（按当前节点给执行动作）
  const NEXT_HINT = {
    '新线索': '在企业规定时限内首次联系，补全顾客需求与授权信息', '已联系': '根据顾客已表达的需求邀请到店或参加已确认的门店活动', '已建档': '确认用餐场景、人数、预算、忌口与联系偏好',
    '已邀约': '按活动或预订真实时间确认人数、到店时间与门店位置', '已到店': '完成用餐需求确认，并记录服务体验与食安/过敏原关注项', '已体验': '基于已核实菜单和实际反馈给出适配建议',
    '已选品': '核对商品/服务、数量、价格与履约条件，未确认内容不得承诺', '待成交': '逐项解决顾虑，由有权限人员确认价格、优惠和订单信息', '已成交': '按顾客授权进行回访，核对履约与满意度',
    '复购': '依据真实消费记录做会员关怀、菜单推荐与复购服务', '转介绍': '取得顾客同意后记录转介绍，按企业已公布规则处理',
  };
  res.json({ leadId: lead.id, name: lead.name, stage: lead.stage, journey, current, totalDays, nextHint: NEXT_HINT[current] });
});

r.post('/leads/:id/objection', async (req, res) => {
  const lead = ensureLeadAccess(req, res, req.params.id);
  if (!lead) return;
  try {
    const { text, resolveIndex } = req.body || {};
    const concerns = safeJsonArray(lead.concerns);
    // 即时生成应对话术（CRM-05）：AI 链路先行，成功后才把异议落库——否则积分不足/AI失败会留下脏数据，重试重复追加
    let suggestion = null;
    if (resolveIndex !== undefined) { if (concerns[resolveIndex]) concerns[resolveIndex].resolved = true; }
    else if (text) {
      precheckByRole(req.user.id, 'text', req.user.role);
      const kb = await kbContext(['话术案例'], req.user.role, text || lead.interest);
      const out = await generate({
        kind: 'objection', role: req.user.role,
        system: `你是餐饮门店顾客沟通助手。基于异议处理库提供一段可由员工审核后使用的沟通草稿。不得编造价格、折扣、库存、名额、顾客证言或紧迫性；涉及菜单、食安、过敏原、价格和权益时，只引用已核实信息并提示负责人确认。知识库：${kb}`,
        userMsg: `客户「${lead.name}」（${lead.identity_tag}，预算${lead.budget_level}，阶段${lead.stage}）提出顾虑：「${text}」。给出1段可直接使用的应对话术+1个跟进动作。`,
        fallback: () => `应对话术：感谢您把「${text}」说清楚。为了避免给您不准确的信息，我先确认用餐场景、人数、预算、时间和忌口，再请门店负责人按当前菜单与已审核价格给出适配方案；未确认的优惠、库存和名额我不会先做承诺。\n跟进动作：记录顾客需要核实的问题，由有权限的负责人确认后，按顾客同意的时间和方式回复。`,
      });
      charge({ userId: req.user.id, feature: '增长中心·异议处理', kind: 'text', model: out.model, usage: out.usage, aiMode: out.mode });
      suggestion = out.text;
      concerns.push({ text, resolved: false });
    }
    q.run('UPDATE leads SET concerns = ? WHERE id = ?', JSON.stringify(concerns), lead.id);
    const updated = rescoreLead(lead.id);
    res.json({ lead: updated, suggestion });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// AI 话术推荐（FR-GRW-05，私域跟进工作台：生成可复制话术，不直连微信/企微）
r.post('/suggest-reply', async (req, res) => {
  try {
  precheckByRole(req.user.id, 'text', req.user.role);
  const { leadId, context } = req.body || {};
  const lead = leadId ? q.get(`SELECT * FROM leads WHERE tenant_id = ${curTenant()} AND id = ?`, leadId) : null;
  if (lead && !canAccessOwner(req.user, lead.owner_id)) return res.status(404).json({ error: '客户不存在或无权访问' });
  const kb = await kbContext(['话术案例', '品牌资料'], req.user.role, context || (lead && lead.interest));
  const wantsInvite = /下月|下个月|邀约|门店活动|主题活动|品鉴会|到店|活动/.test(String(context || ''));
  const out = await generate({
    kind: 'reply',
    system: `你是餐饮门店顾客沟通助手。生成3条可由员工审核后复制到微信/企微/短信的回复草稿（每条≤80字，编号）。不得编造活动日期、名额、库存、价格、折扣、顾客证言或紧迫性；涉及价格、菜单、食安与权益时必须说明以门店负责人核实结果为准，并尊重顾客联系授权。知识库：${kb}`,
    userMsg: `客户：${lead ? `${lead.name}（${lead.identity_tag}/${lead.grade}级/阶段${lead.stage}/兴趣${lead.interest}）` : '通用客户'}。当前沟通情境：${context || '客户询问产品'}`,
    fallback: () => wantsInvite
      ? `1. ${lead?.name || '您好'}，我们可以按您的用餐场景整理门店活动信息；日期、接待能力和菜单确认后再发您，您希望哪天了解？\n2. ${lead?.name || '您好'}，如果您愿意到店体验，请告诉我人数、预算、时间和忌口，我先请门店核实可预约时段。\n3. 我可以把已确认的活动流程和菜单发您参考；是否参加由您决定，价格与可预约情况以门店回复为准。`
      : `1. ${lead?.name || '您好'}，您关心的问题我先记录下来，请门店按当前菜单和实际情况核实后回复，避免给您不准确的信息。\n2. 方便补充用餐人数、预算、时间和忌口吗？有了这些信息，我们才能给出适配建议。\n3. 涉及价格、库存或权益的内容，我会先请有权限的负责人确认，再按您同意的方式回复。`,
    role: req.user.role,
  });
  const bill = charge({ userId: req.user.id, feature: '增长中心·私域话术', kind: 'text', model: out.model, usage: out.usage, aiMode: out.mode });
  if (lead?.id) {
    q.run('INSERT INTO lead_ai_suggestions(lead_id,user_id,context,suggestion,purpose) VALUES(?,?,?,?,?)',
      lead.id, req.user.id, context || null, out.text, wantsInvite ? '下月邀约话术' : '私域回复话术');
  }
  res.json({ suggestions: out.text, mode: out.mode, billing: bill });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

r.get('/key-customers', (req, res) => {
  const scope = userScopeClause(req.user, 'owner_id');
  const a = q.all(`SELECT id,name,grade,score,stage,budget_level,interest FROM leads WHERE tenant_id = ${curTenant()} AND grade='A' AND stage NOT IN ('已成交','复购','已流失')${scope.sql} ORDER BY score DESC LIMIT 10`, ...scope.params);
  const closing = q.all(`SELECT id,name,grade,score,stage,budget_level FROM leads WHERE tenant_id = ${curTenant()} AND (score>=80 OR (stage='已到店' AND budget_level IN ('高','中'))) AND stage NOT IN ('已成交','复购','已流失')${scope.sql} ORDER BY score DESC LIMIT 10`, ...scope.params);
  const boss = q.all(`SELECT id,name,grade,score,stage,budget_level FROM leads WHERE tenant_id = ${curTenant()} AND boss_alert=1 AND stage NOT IN ('已成交','复购','已流失')${scope.sql} ORDER BY score DESC LIMIT 10`, ...scope.params);
  res.json({ aList: a, closing, bossList: boss });
});

// 身份判断分流（FLOW-02）
r.post('/leads/:id/path', (req, res) => {
  const lead = ensureLeadAccess(req, res, req.params.id);
  if (!lead) return;
  const { identity = 3, resource = 3, fund = 3, will = 3 } = req.body || {};
  const total = identity + resource + fund + will;
  let path;
  if (fund >= 4 && resource >= 4) path = '门店合作候选';
  else if (resource >= 4 && will >= 3) path = '渠道合作候选';
  else if (identity >= 4) path = '团购客户';
  else path = '消费客户';
  q.run('UPDATE leads SET path_type = ? WHERE id = ?', path, req.params.id);
  logOp(req.user, '增长中心', '身份分流', `lead#${req.params.id} → ${path}`);
  res.json({ path, total, hint: path.includes('候选') ? '已进入合作机会待分配队列，请由负责人按当前数字员工目录选择承接部门' : '进入常规顾客经营路径' });
});

// 员工每日数据上报（FR-GRW-11）：累加进经营数据表，总控台/分析/周报全联动
r.post('/daily-report', (req, res) => {
  const b = req.body || {};
  // 明细表(leads/orders)为唯一事实源：成交单数/成交金额/复购金额由阶段推进自动归集，禁止人工二次上报（P0-3防双计）
  const fields = ['new_leads', 'invited', 'arrived', 'content_count'];
  const vals = fields.map(f => Math.max(0, +b[f] || 0));
  if (vals.every(v => v === 0)) return res.status(400).json({ error: '至少填写一项数据' });
  q.run(`INSERT INTO daily_ops(date,new_leads,invited,arrived,deals,deal_amount,repurchase_amount,content_count)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id,date) DO UPDATE SET
           new_leads = new_leads + excluded.new_leads,
           invited = invited + excluded.invited,
           arrived = arrived + excluded.arrived,
           deals = deals + excluded.deals,
           deal_amount = deal_amount + excluded.deal_amount,
           repurchase_amount = repurchase_amount + excluded.repurchase_amount,
           content_count = content_count + excluded.content_count`,
    today(), ...vals);
  logOp(req.user, '增长中心', '每日数据上报', fields.map((f, i) => vals[i] ? `${f}:${vals[i]}` : null).filter(Boolean).join(' '));
  res.json({ ok: true, date: today(), msg: '已计入今日经营数据，总控台与经营分析实时联动' });
});

// 沟通会话列表（工作台左栏：按最近跟进排序）
r.get('/conversations', (req, res) => {
  const scope = leadOwnerScope(req);
  const where = scope.sql.trim();
  const params = scope.params;
  const rows = q.all(`SELECT l.id, l.name, l.stage, l.grade, l.interest,
    (SELECT content FROM follow_ups f WHERE f.lead_id = l.id ORDER BY f.created_at DESC LIMIT 1) last_msg,
    (SELECT created_at FROM follow_ups f WHERE f.lead_id = l.id ORDER BY f.created_at DESC LIMIT 1) last_at,
    (SELECT u.name FROM follow_ups f LEFT JOIN users u ON u.id = f.user_id WHERE f.lead_id = l.id ORDER BY f.created_at DESC LIMIT 1) last_user_name,
    (SELECT COUNT(*) FROM follow_ups f WHERE f.lead_id = l.id) follow_count
    FROM leads l WHERE l.tenant_id = ${curTenant()} AND l.stage NOT IN ('已流失') ${where} ORDER BY last_at DESC LIMIT 12`, ...params);
  res.json(rows);
});

export default r;
