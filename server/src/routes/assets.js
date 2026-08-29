import { Router } from 'express';
import { q, curTenant } from '../db.js';
import { logOp, monthStart, pct, daysAgo, pageParams } from '../util.js';
import { hasFullDataAccess, isManagerRole, scopedUserIds } from '../engines/access.js';
import { archiveAndDelete, deleteList, deletionDenied, isBossLike, isManagerLike, tableRows } from '../engines/deletion.js';
import { loadContentDeliveryState } from '../engines/delivery-state.js';

const r = Router();
const VALID_CATEGORIES = new Set(['内容资产', '知识资产', '客户资产', '数据资产', '品牌资产']);
const VALID_STATUSES = new Set(['使用中', '闲置', '待归档', '已归档']);
const PUBLIC_ASSET_OWNERS = ['总部', '内容生产仓', '增长中心', '知识库', '餐饮数字员工'];
const countOf = (sql, ...params) => q.get(sql, ...params)?.n || 0;
const clean = (v, fallback = '') => String(v ?? fallback).trim();
const num = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;


function placeholders(values) {
  return values.map(() => '?').join(',');
}

function scopedPeople(user) {
  const ids = scopedUserIds(user);
  if (ids === null) return { full: true, ids: null, names: [] };
  if (!ids.length) return { full: false, ids: [], names: [] };
  const names = q.all(
    `SELECT name FROM users WHERE tenant_id = ${curTenant()} AND id IN (${placeholders(ids)})`,
    ...ids,
  ).map(x => x.name).filter(Boolean);
  if (isManagerRole(user)) names.push(...PUBLIC_ASSET_OWNERS);
  return { full: false, ids, names };
}

function assetScope(user, alias = '') {
  if (hasFullDataAccess(user)) return { sql: '', params: [] };
  const prefix = alias ? `${alias}.` : '';
  const { ids, names } = scopedPeople(user);
  const parts = [];
  const params = [];
  if (ids?.length) {
    parts.push(`${prefix}creator_id IN (${placeholders(ids)})`);
    params.push(...ids);
  }
  if (names.length) {
    parts.push(`${prefix}owner IN (${placeholders(names)})`);
    params.push(...names);
  }
  if (!parts.length) return { sql: ' AND 1=0', params: [] };
  return { sql: ` AND (${parts.join(' OR ')})`, params };
}

function assetWhere(req, alias = '', extra = '', extraParams = []) {
  const prefix = alias ? `${alias}.` : '';
  const scope = assetScope(req.user, alias);
  return {
    where: `${prefix}tenant_id = ${curTenant()}${scope.sql}${extra ? ` AND (${extra})` : ''}`,
    params: [...scope.params, ...extraParams],
  };
}

function assetCount(req, extra = '', extraParams = []) {
  const { where, params } = assetWhere(req, '', extra, extraParams);
  return countOf(`SELECT COUNT(*) n FROM biz_assets WHERE ${where}`, ...params);
}

function sourceDetail(res, title, note, rows) {
  res.json({
    title,
    note,
    columns: [
      { title: '资产', dataIndex: 'name' },
      { title: '分类', dataIndex: 'category' },
      { title: '状态', dataIndex: 'status' },
      { title: '归属', dataIndex: 'owner' },
      { title: '来源', dataIndex: 'source_type' },
      { title: '登记人', dataIndex: 'creator' },
      { title: '登记时间', dataIndex: 'created_at' },
      { title: '备注', dataIndex: 'note' },
    ],
    rows,
  });
}

function sampleAssets(req, filter, params = []) {
  const scoped = assetWhere(req, 'a', filter, params);
  return q.all(`SELECT a.id, a.name, a.category, a.status, a.owner, a.source_type,
      COALESCE(u.name, a.owner, '-') creator, a.note, a.created_at
    FROM biz_assets a
    LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.creator_id
    WHERE ${scoped.where}
    ORDER BY a.created_at DESC
    LIMIT 30`, ...scoped.params);
}

function assetVisualRows(req, filter = '', params = [], order = 'created_at DESC', limit = 80) {
  const scoped = assetWhere(req, 'a', filter, params);
  return q.all(`SELECT a.id, a.name, a.category, a.value, a.status, a.use_count, a.owner, a.source_type,
      COALESCE(u.name, a.owner, '-') creator, a.note, a.created_at, a.updated_at
    FROM biz_assets a
    LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.creator_id
    WHERE ${scoped.where}
    ORDER BY ${order}
    LIMIT ${limit}`, ...scoped.params);
}

function assetVisualDetail(res, title, note, rows, summary = []) {
  res.json({
    title,
    note,
    summary,
    columns: [
      { title: '资产', dataIndex: 'name' },
      { title: '分类', dataIndex: 'category' },
      { title: '估值', dataIndex: 'value', type: 'money' },
      { title: '状态', dataIndex: 'status' },
      { title: '调用', dataIndex: 'use_count' },
      { title: '归属', dataIndex: 'owner' },
      { title: '来源', dataIndex: 'source_type' },
      { title: '登记人', dataIndex: 'creator' },
      { title: '登记时间', dataIndex: 'created_at' },
    ],
    rows,
  });
}

r.get('/source-map', (req, res) => {
  res.json({
    cards: [
      {
        key: 'content',
        title: '内容资产',
        source: '内容生产仓、AI图片/视频/PPT、发布登记、素材库',
        table: 'contents / media_jobs / materials / biz_assets',
        count: assetCount(req, `(category = ? OR source_type IN ('content','media_job'))`, ['内容资产']),
        upload: '生成结果可一键导入素材库；外部素材可批量导入',
        trace: '资产 → 来源内容/媒体任务 → 提示词/模型/审核状态 → 调用记录',
      },
      {
        key: 'knowledge',
        title: '知识资产',
        source: '系统知识库、活动复盘、员工产出沉淀',
        table: 'kb_docs / weekly_reviews / biz_assets',
        count: assetCount(req, `(category = ? OR source_type = 'kb')`, ['知识资产']),
        upload: '系统管理可上传文档；资产页可登记知识资产摘要',
        trace: '资产 → 知识库文档 → 更新记录 → AI引用',
      },
      {
        key: 'customer',
        title: '客户资产',
        source: '增长中心线索、跟进记录、订单与复购',
        table: 'leads / follow_ups / orders',
        count: assetCount(req, `(category = ? OR source_type = 'lead')`, ['客户资产']),
        upload: '客户明细从增长中心批量导入；资产页只登记汇总型资产',
        trace: '资产 → 客户档案 → 跟进时间线 → 成交/复购订单',
      },
      {
        key: 'operations',
        title: '经营数据资产',
        source: '订单、经营日报、活动、合伙人和员工任务',
        table: 'orders / daily_ops / activities / partners / tasks / biz_assets',
        count: assetCount(req, `source_type IN ('order','daily_ops','activity','partner','task')`),
        upload: '数据录入中枢确认写入后自动同步资产台账',
        trace: '资产 → 业务事实表 → 导入批次/责任人 → 驾驶舱与复盘',
      },
      {
        key: 'manual',
        title: '人工/批量导入',
        source: '线下资源、外部文件、门店物料、品牌资料',
        table: 'biz_assets / asset_flows',
        count: assetCount(req, `source_type IN ('manual','manual_upload')`),
        upload: '支持粘贴表格批量导入，自动写入流转时间线',
        trace: '资产 → 导入人/备注/链接 → 后续状态流转',
      },
    ],
    rules: [
      '资产估值是内部管理口径，不等同市场价格；默认值可在导入时覆盖。',
      '员工只看本人登记或归属本人的资产；经理看下属范围；老板/管理员看全局。',
      '每次状态流转、人工导入都会写入资产流转动态，便于老板追溯来源和责任人。',
    ],
  });
});

r.get('/source-samples/:key', (req, res) => {
  const key = req.params.key;
  if (key === 'content') {
    return sourceDetail(res, '内容资产来源样本', '来自内容生产仓、AI媒体任务和素材入库；点击资产列表行可继续追溯原始内容/媒体任务。', sampleAssets(req, `(a.category = ? OR a.source_type IN ('content','media_job'))`, ['内容资产']));
  }
  if (key === 'knowledge') {
    return sourceDetail(res, '知识资产来源样本', '来自知识库上传、活动复盘和员工产出沉淀；可追溯到知识库文档或人工登记记录。', sampleAssets(req, `(a.category = ? OR a.source_type = 'kb')`, ['知识资产']));
  }
  if (key === 'customer') {
    return sourceDetail(res, '客户资产来源样本', '来自增长中心客户档案、成交客户沉淀和客户跟进资产化；客户明细仍以增长中心为事实源。', sampleAssets(req, `(a.category = ? OR a.source_type = 'lead')`, ['客户资产']));
  }
  if (key === 'operations') {
    return sourceDetail(res, '经营数据资产来源样本', '来自数据录入中枢确认写入的订单、日报、活动、合伙人与任务事实表。',
      sampleAssets(req, `a.source_type IN ('order','daily_ops','activity','partner','task')`));
  }
  if (key === 'manual') {
    return sourceDetail(res, '人工/批量导入记录', '展示手工登记和批量导入资产，包含导入人、归属、备注和后续流转入口。', sampleAssets(req, `a.source_type IN ('manual','manual_upload')`));
  }
  res.status(404).json({ error: '未知来源类型' });
});

r.get('/visual-drill/:kind', (req, res) => {
  const kind = req.params.kind;
  const category = clean(req.query.category);
  const status = clean(req.query.status);
  const date = clean(req.query.date);
  const part = clean(req.query.part);
  const warning = clean(req.query.warning);

  if (kind === 'category') {
    if (!category) return res.status(400).json({ error: '缺少分类' });
    const rows = assetVisualRows(req, 'a.category = ?', [category], 'a.created_at DESC', 120);
    return assetVisualDetail(res, `${category}明细`, '来自资产分类概览。这里展示该分类下的资产来源、归属、估值和状态；点击任意资产继续查看来源对象与流转时间线。', rows);
  }

  if (kind === 'value-trend') {
    if (!date) return res.status(400).json({ error: '缺少趋势日期' });
    const rows = assetVisualRows(req, 'date(a.created_at) <= ?', [date], 'a.value DESC', 120);
    const scoped = assetWhere(req, 'a', 'date(a.created_at) <= ?', [date]);
    const summary = q.all(`SELECT a.category, COUNT(*) n, SUM(a.value) v
      FROM biz_assets a WHERE ${scoped.where}
      GROUP BY a.category ORDER BY v DESC`, ...scoped.params);
    return assetVisualDetail(res, `截至 ${date} 的资产沉淀`, '来自资产价值趋势。口径是该日期之前已经登记的资产累计值，按估值从高到低列出，可继续进入单资产溯源。', rows, summary);
  }

  if (kind === 'health') {
    const map = {
      活跃资产占比: { title: '活跃资产占比明细', filter: 'a.status = ?', params: ['使用中'], order: 'a.use_count DESC' },
      近30天调用占比: { title: '近30天调用资产', filter: 'a.updated_at >= ? AND a.use_count > 0', params: [daysAgo(30)], order: 'a.updated_at DESC' },
      信息完整度: { title: '信息完整资产', filter: "a.name IS NOT NULL AND a.category IS NOT NULL AND a.value > 0 AND COALESCE(a.source_type,'') != ''", params: [], order: 'a.updated_at DESC' },
    };
    const cfg = map[part] || { title: '资产健康度明细', filter: '', params: [], order: 'a.updated_at DESC' };
    const rows = assetVisualRows(req, cfg.filter, cfg.params, cfg.order, 120);
    return assetVisualDetail(res, cfg.title, '来自资产健康度评分。健康度由活跃资产、近30天调用、信息完整度加权计算；明细用于核对分数是否真实。', rows);
  }

  if (kind === 'warning') {
    const map = {
      idle: { title: '闲置超90天资产', filter: 'a.status = ? AND a.updated_at < ?', params: ['闲置', daysAgo(90)] },
      incomplete: { title: '信息不完整资产', filter: "(a.value <= 0 OR a.category IS NULL OR COALESCE(a.source_type,'') = '')", params: [] },
      lowUse: { title: '零调用资产', filter: 'a.use_count = 0 AND a.created_at < ?', params: [daysAgo(30)] },
    };
    const cfg = map[warning] || map.lowUse;
    const rows = assetVisualRows(req, cfg.filter, cfg.params, 'a.updated_at ASC', 120);
    return assetVisualDetail(res, cfg.title, '来自资产预警。这里不是说明文字，而是直接列出触发预警的资产，便于逐条核验、激活或归档。', rows);
  }

  if (kind === 'lifecycle') {
    if (!status) return res.status(400).json({ error: '缺少状态' });
    const rows = assetVisualRows(req, 'a.status = ?', [status], 'a.updated_at DESC', 120);
    return assetVisualDetail(res, `${status}资产`, '来自资产生命周期分布。按当前资产状态钻取，点击资产行可查看谁登记、从哪里来、何时发生过流转。', rows);
  }

  if (kind === 'value-category') {
    if (!category) return res.status(400).json({ error: '缺少分类' });
    const rows = assetVisualRows(req, 'a.category = ?', [category], 'a.value DESC', 120);
    return assetVisualDetail(res, `${category}价值构成`, '来自资产价值分布。按分类估值聚合后钻取到具体资产，方便核对高价值资产是否真实、是否可复用。', rows);
  }

  if (kind === 'top-used') {
    const rows = assetVisualRows(req, 'a.use_count > 0', [], 'a.use_count DESC', 80);
    return assetVisualDetail(res, '资产使用热度明细', '来自资产使用TOP。调用次数表示素材引用、知识引用、内容复用等累计使用热度，点击资产可看来源和流转。', rows);
  }

  if (kind === 'flows') {
    const scope = assetScope(req.user, 'a');
    return res.json({
      title: '资产流转动态明细',
      note: '来自资产流转动态。每次导入、启用、更新、归档都会写入这里；点击行可进入对应资产溯源。',
      columns: [
        { title: '资产', dataIndex: 'asset_name' },
        { title: '动作', dataIndex: 'action' },
        { title: '说明', dataIndex: 'note' },
        { title: '操作人', dataIndex: 'operator_name' },
        { title: '时间', dataIndex: 'created_at' },
      ],
      rows: q.all(`SELECT f.id, f.asset_id, a.name asset_name, f.action, f.note, COALESCE(u.name, '-') operator_name, f.created_at
        FROM asset_flows f
        JOIN biz_assets a ON a.id = f.asset_id AND a.tenant_id = f.tenant_id
        LEFT JOIN users u ON u.tenant_id = f.tenant_id AND u.id = f.operator_id
        WHERE f.tenant_id = ${curTenant()}${scope.sql}
        ORDER BY f.created_at DESC LIMIT 120`, ...scope.params),
    });
  }

  res.status(404).json({ error: '未知可视化钻取类型' });
});

r.get('/summary', (req, res) => {
  const base = assetWhere(req);
  const total = q.get(`SELECT COUNT(*) n, SUM(value) v FROM biz_assets WHERE ${base.where}`, ...base.params) || {};
  const month = assetWhere(req, '', 'created_at >= ?', [monthStart()]);
  const monthNew = countOf(`SELECT COUNT(*) n FROM biz_assets WHERE ${month.where}`, ...month.params);
  const active = assetWhere(req, '', 'status = ?', ['使用中']);
  const inUse = countOf(`SELECT COUNT(*) n FROM biz_assets WHERE ${active.where}`, ...active.params);
  const calls = q.get(`SELECT SUM(use_count) n FROM biz_assets WHERE ${base.where}`, ...base.params)?.n || 0;
  const last = assetWhere(req, '', 'created_at < ?', [monthStart()]);
  const lastMonthV = q.get(`SELECT SUM(value) v FROM biz_assets WHERE ${last.where}`, ...last.params)?.v || 1;
  res.json({
    total: total.n || 0,
    totalValue: Math.round(total.v || 0),
    monthNew,
    inUse,
    useRate: pct(inUse, total.n || 1),
    calls,
    valueGrowth: pct(Math.round(total.v || 0) - lastMonthV, lastMonthV),
  });
});

r.get('/drill/:kind', (req, res) => {
  const kind = req.params.kind;
  const catWhere = assetWhere(req);
  const cats = q.all(`SELECT category, COUNT(*) n, SUM(value) v, SUM(use_count) calls
    FROM biz_assets WHERE ${catWhere.where}
    GROUP BY category ORDER BY v DESC`, ...catWhere.params);
  const rows = (extra = '', params = [], order = 'created_at DESC', limit = 60) => {
    const scoped = assetWhere(req, '', extra, params);
    return q.all(`SELECT id, name, category, value, status, use_count, owner, source_type, created_at
      FROM biz_assets WHERE ${scoped.where} ORDER BY ${order} LIMIT ${limit}`, ...scoped.params);
  };
  if (kind === 'total') return res.json({
    title: '资产构成（按类别）',
    cats,
    rows: rows('', [], 'created_at DESC', 60),
    note: '五类资产：客户/内容/知识/数据/品牌；新内容、新客户、员工产出、知识库录入均可自动登记。',
  });
  if (kind === 'value') return res.json({
    title: '资产价值构成（估值口径）',
    cats,
    rows: rows('', [], 'value DESC', 30),
    note: '估值为内部管理口径：按资产类型基准价×活跃度系数；客户资产按成交/意向分层估值，不代表市场公允价值。',
  });
  if (kind === 'month-new') return res.json({
    title: '本月新增资产',
    rows: rows('created_at >= ?', [monthStart()], 'created_at DESC', 100),
    note: '来源：内容生产仓产出、新客户建档、员工产出采纳、知识库录入和人工批量导入。',
  });
  if (kind === 'in-use') return res.json({
    title: '使用中资产',
    rows: rows('status = ?', ['使用中'], 'use_count DESC', 60),
    note: '状态为“使用中”的资产；长期未调用将进入闲置盘点建议。',
  });
  if (kind === 'use-rate') {
    const scoped = assetWhere(req);
    const sts = q.all(`SELECT status, COUNT(*) n FROM biz_assets WHERE ${scoped.where} GROUP BY status ORDER BY n DESC`, ...scoped.params);
    return res.json({
      title: '资产状态分布（使用率口径）',
      sts,
      rows: rows('status != ?', ['使用中'], 'created_at DESC', 40),
      note: '使用率 = 使用中 ÷ 资产总数；下表为非使用中资产，建议盘点激活或归档。',
    });
  }
  if (kind === 'calls') return res.json({
    title: '调用次数 TOP（资产热度）',
    rows: rows('use_count > 0', [], 'use_count DESC', 30),
    note: '调用=被引用/使用的累计次数（素材引用、知识库被AI引用、内容复用等）。',
  });
  res.status(400).json({ error: '未知钻取类型' });
});

r.get('/categories', (req, res) => {
  const scoped = assetWhere(req);
  res.json(q.all(`SELECT category, COUNT(*) n, SUM(value) v FROM biz_assets WHERE ${scoped.where} GROUP BY category ORDER BY v DESC`, ...scoped.params));
});

r.get('/value-trend', (req, res) => {
  const scoped = assetWhere(req);
  const rows = q.all(`SELECT strftime('%Y-%W', created_at) wk, MIN(date(created_at)) d
    FROM biz_assets WHERE ${scoped.where}
    GROUP BY wk ORDER BY wk DESC LIMIT 10`, ...scoped.params);
  const trend = rows.reverse().map(x => {
    const cum = assetWhere(req, '', 'date(created_at) <= ?', [x.d]);
    return {
      week: x.d,
      value: Math.round(q.get(`SELECT SUM(value) v FROM biz_assets WHERE ${cum.where}`, ...cum.params)?.v || 0),
      count: countOf(`SELECT COUNT(*) n FROM biz_assets WHERE ${cum.where}`, ...cum.params),
    };
  });
  res.json(trend);
});

r.get('/health', (req, res) => {
  const base = assetWhere(req);
  const total = countOf(`SELECT COUNT(*) n FROM biz_assets WHERE ${base.where}`, ...base.params) || 1;
  const active = assetWhere(req, '', 'status = ?', ['使用中']);
  const recent = assetWhere(req, '', 'updated_at >= ? AND use_count > 0', [daysAgo(30)]);
  const completeWhere = assetWhere(req, '', "name IS NOT NULL AND category IS NOT NULL AND value > 0 AND COALESCE(source_type,'') != ''");
  const activeCount = countOf(`SELECT COUNT(*) n FROM biz_assets WHERE ${active.where}`, ...active.params);
  const recentUsed = countOf(`SELECT COUNT(*) n FROM biz_assets WHERE ${recent.where}`, ...recent.params);
  const complete = countOf(`SELECT COUNT(*) n FROM biz_assets WHERE ${completeWhere.where}`, ...completeWhere.params);
  const score = Math.round(pct(activeCount, total) * 0.5 + pct(recentUsed, total) * 0.3 + pct(complete, total) * 0.2);
  res.json({
    score: Math.min(100, score),
    subs: [
      { name: '活跃资产占比', value: pct(activeCount, total) },
      { name: '近30天调用占比', value: pct(recentUsed, total) },
      { name: '信息完整度', value: pct(complete, total) },
    ],
  });
});

r.get('/', (req, res) => {
  const { category, status, kw } = req.query;
  const { size, offset } = pageParams(req.query);
  const filters = [];
  const filterParams = [];
  if (category) { filters.push('category = ?'); filterParams.push(category); }
  if (status) { filters.push('status = ?'); filterParams.push(status); }
  if (kw) { filters.push('name LIKE ?'); filterParams.push(`%${kw}%`); }
  const scoped = assetWhere(req, '', filters.join(' AND '), filterParams);
  const total = countOf(`SELECT COUNT(*) n FROM biz_assets WHERE ${scoped.where}`, ...scoped.params);
  const rows = q.all(`SELECT * FROM biz_assets WHERE ${scoped.where} ORDER BY value DESC LIMIT ? OFFSET ?`, ...scoped.params, size, offset);
  res.json({ total, rows });
});

r.get('/top-used', (req, res) => {
  const scoped = assetWhere(req);
  res.json(q.all(`SELECT id,name,category,use_count,value FROM biz_assets WHERE ${scoped.where} ORDER BY use_count DESC LIMIT 5`, ...scoped.params));
});

r.get('/warnings', (req, res) => {
  const pick = (extra, params = []) => {
    const scoped = assetWhere(req, '', extra, params);
    return q.all(`SELECT id,name,category FROM biz_assets WHERE ${scoped.where} LIMIT 10`, ...scoped.params);
  };
  const idle = pick('status = ? AND updated_at < ?', ['闲置', daysAgo(90)]);
  const incomplete = pick("(value <= 0 OR category IS NULL OR COALESCE(source_type,'') = '')");
  const lowUse = pick('use_count = 0 AND created_at < ?', [daysAgo(30)]);
  res.json({ idle, incomplete, lowUse, counts: { idle: idle.length, incomplete: incomplete.length, lowUse: lowUse.length } });
});

r.get('/lifecycle', (req, res) => {
  const scoped = assetWhere(req);
  res.json(q.all(`SELECT status, COUNT(*) n FROM biz_assets WHERE ${scoped.where} GROUP BY status`, ...scoped.params));
});

r.get('/flows', (req, res) => {
  const scope = assetScope(req.user, 'a');
  res.json(q.all(`SELECT f.*, a.name asset_name, u.name operator_name
    FROM asset_flows f
    JOIN biz_assets a ON a.id = f.asset_id AND a.tenant_id = f.tenant_id
    LEFT JOIN users u ON u.tenant_id = f.tenant_id AND u.id = f.operator_id
    WHERE f.tenant_id = ${curTenant()}${scope.sql}
    ORDER BY f.created_at DESC LIMIT 12`, ...scope.params));
});

r.post('/import', (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [req.body || {}];
  if (!rows.length) return res.status(400).json({ error: '没有可导入的资产行' });
  if (rows.length > 200) return res.status(400).json({ error: '单次最多导入200项资产' });
  const created = [];
  const errors = [];
  rows.forEach((row, idx) => {
    const name = clean(row.name || row.资产名称 || row.title);
    if (!name) { errors.push({ row: idx + 1, reason: '缺少资产名称' }); return; }
    const categoryInput = clean(row.category || row.分类);
    const category = VALID_CATEGORIES.has(categoryInput) ? categoryInput : '数据资产';
    const statusInput = clean(row.status || row.状态);
    const status = VALID_STATUSES.has(statusInput) ? statusInput : '使用中';
    // 未填估值记 0（进入「信息不完整资产」清单等待人工补录），不按分类编造默认估值混入资产总值
    const value = Math.max(0, num(row.value ?? row.估值 ?? row.价值, 0));
    const useCount = Math.max(0, Math.round(num(row.use_count ?? row.调用次数, 0)));
    const owner = clean(row.owner || row.归属 || req.user.name, req.user.name);
    const url = clean(row.url || row.link || row.链接);
    const note = clean(row.note || row.备注 || row.source_note || row.来源备注, '人工导入数据资产');
    try {
      const result = q.run(`INSERT INTO biz_assets(name,category,value,status,use_count,owner,source_type,source_id,creator_id,url,note)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        name, category, value, status, useCount, owner, clean(row.source_type || 'manual_upload'), row.source_id ? Number(row.source_id) : null,
        req.user.id, url || null, note);
      const id = result.lastInsertRowid;
      q.run('INSERT INTO asset_flows(asset_id,action,note,operator_id) VALUES(?,?,?,?)',
        id, '人工导入', `${req.user.name || '用户'}导入：${note}`, req.user.id);
      created.push(q.get(`SELECT * FROM biz_assets WHERE tenant_id = ${curTenant()} AND id = ?`, id));
    } catch (e) {
      errors.push({ row: idx + 1, name, reason: e.message || '导入失败' });
    }
  });
  logOp(req.user, '数据资产', '批量导入资产', `成功${created.length} 失败${errors.length}`);
  res.json({ ok: true, created, errors });
});

// 单条创建：与批量导入同一套校验与流水口径；估值允许 0（未估值语义，进入「信息不完整」盘点）
r.post('/', (req, res) => {
  const b = req.body || {};
  const name = clean(b.name);
  if (!name) return res.status(400).json({ error: '请填写资产名称' });
  const categoryInput = clean(b.category);
  if (categoryInput && !VALID_CATEGORIES.has(categoryInput)) return res.status(400).json({ error: '无效资产分类' });
  const statusInput = clean(b.status);
  if (statusInput && !VALID_STATUSES.has(statusInput)) return res.status(400).json({ error: '无效资产状态' });
  const category = categoryInput || '数据资产';
  const status = statusInput || '使用中';
  const value = Math.max(0, num(b.value, 0));   // 0 = 未估值，不虚构估值
  const owner = clean(b.owner || req.user.name, req.user.name);
  const url = clean(b.url);
  const note = clean(b.note, '手动登记资产');
  const result = q.run(`INSERT INTO biz_assets(name,category,value,status,use_count,owner,source_type,creator_id,url,note)
    VALUES(?,?,?,?,0,?,'manual',?,?,?)`,
    name, category, value, status, owner, req.user.id, url || null, note);
  const id = result.lastInsertRowid;
  q.run('INSERT INTO asset_flows(asset_id,action,note,operator_id) VALUES(?,?,?,?)',
    id, '创建', `${req.user.name || '用户'}登记：${note}`, req.user.id);
  logOp(req.user, '数据资产', '新增资产', name);
  res.json({ ok: true, asset: q.get(`SELECT * FROM biz_assets WHERE tenant_id = ${curTenant()} AND id = ?`, id) });
});

// 编辑：仅本人可见范围内的资产可改；每次编辑写流转流水便于追责
r.put('/:id', (req, res) => {
  const a = getVisibleAsset(req, req.params.id);
  if (!a) return res.status(404).json({ error: '资产不存在或无权编辑' });
  const b = req.body || {};
  const sets = [];
  const params = [];
  const changed = [];
  const apply = (field, label, nextValue) => {
    if (String(nextValue ?? '') === String(a[field] ?? '')) return;
    sets.push(`${field} = ?`);
    params.push(nextValue);
    changed.push(label);
  };
  if (b.name !== undefined) {
    const name = clean(b.name);
    if (!name) return res.status(400).json({ error: '资产名称不能为空' });
    apply('name', '名称', name);
  }
  if (b.category !== undefined) {
    const category = clean(b.category);
    if (!VALID_CATEGORIES.has(category)) return res.status(400).json({ error: '无效资产分类' });
    apply('category', '分类', category);
  }
  if (b.status !== undefined) {
    const status = clean(b.status);
    if (!VALID_STATUSES.has(status)) return res.status(400).json({ error: '无效资产状态' });
    apply('status', '状态', status);
  }
  if (b.value !== undefined) apply('value', '估值', Math.max(0, num(b.value, 0)));
  if (b.owner !== undefined) apply('owner', '归属', clean(b.owner));
  if (b.url !== undefined) apply('url', '链接', clean(b.url) || null);
  if (b.note !== undefined) apply('note', '备注', clean(b.note));
  if (!sets.length) return res.json({ ok: true, asset: a, message: '无变更' });
  q.run(`UPDATE biz_assets SET ${sets.join(', ')}, updated_at = datetime('now','localtime') WHERE tenant_id = ? AND id = ?`,
    ...params, curTenant(), a.id);
  q.run('INSERT INTO asset_flows(asset_id,action,note,operator_id) VALUES(?,?,?,?)',
    a.id, '更新', `${req.user.name || '用户'}编辑：${changed.join('、')}`, req.user.id);
  logOp(req.user, '数据资产', '编辑资产', `asset#${a.id} ${changed.join('、')}`);
  res.json({ ok: true, asset: q.get(`SELECT * FROM biz_assets WHERE tenant_id = ${curTenant()} AND id = ?`, a.id) });
});

function getVisibleAsset(req, id) {
  const scoped = assetWhere(req, 'a', 'a.id = ?', [id]);
  return q.get(`SELECT a.* FROM biz_assets a WHERE ${scoped.where}`, ...scoped.params);
}

function assetDeletePolicy(req, asset) {
  const sourceBound = ['content', 'media_job', 'kb', 'lead', 'order', 'daily_ops', 'activity', 'partner', 'task'].includes(String(asset.source_type || ''));
  if (sourceBound) {
    return {
      allowed: isBossLike(req.user),
      requiredRole: 'boss',
      reason: '该资产来自内容/知识库/客户等事实源，需老板/管理员删除，避免源数据和资产台账不一致',
    };
  }
  if (isBossLike(req.user)) return { allowed: true, requiredRole: 'boss', reason: '老板/管理员删除资产' };
  if (isManagerLike(req.user) && getVisibleAsset(req, asset.id)) {
    return { allowed: true, requiredRole: 'manager', reason: '管理层删除团队人工登记资产' };
  }
  const ownManual = Number(asset.creator_id) === Number(req.user.id)
    && ['manual', 'manual_upload', '', null].includes(asset.source_type || '')
    && Number(asset.use_count || 0) === 0;
  return {
    allowed: ownManual,
    requiredRole: ownManual ? 'self' : 'manager',
    reason: ownManual ? '本人删除误导入资产' : '非本人或已有调用记录，需管理层处理',
  };
}

r.get('/:id/trace', (req, res) => {
  const a = getVisibleAsset(req, req.params.id);
  if (!a) return res.status(404).json({ error: '资产不存在或无权查看' });
  const flows = q.all(`SELECT f.action, f.note, f.created_at, COALESCE(u.name, '-') operator_name
    FROM asset_flows f
    LEFT JOIN users u ON u.tenant_id = f.tenant_id AND u.id = f.operator_id
    WHERE f.tenant_id = ${curTenant()} AND f.asset_id = ?
    ORDER BY f.created_at DESC LIMIT 20`, a.id);

  let source = { type: a.source_type || '手动登记', label: '未标注来源', preview: null, leadId: null, link: null };
  if (a.source_type === 'content' && a.source_id) {
    const c = q.get(`SELECT type, title, topic, body, status, ai_mode, created_at FROM contents WHERE tenant_id = ${curTenant()} AND id = ?`, a.source_id);
    if (c) {
      const delivery = loadContentDeliveryState(a.source_id, {
        tenantId: curTenant(),
      });
      const superseded = delivery.code === 'DELIVERY_SUPERSEDED';
      const replacement = delivery.supersededBy || null;
      const replacementLink = replacement?.employeeIdx != null
        ? `/employees?employee=${encodeURIComponent(String(replacement.employeeIdx))}&task=${encodeURIComponent(String(replacement.taskId))}`
        : replacement?.taskId
          ? `/tasks?kind=restaurant&id=${encodeURIComponent(String(replacement.taskId))}`
          : '/content';
      source = {
        type: '内容生产仓产出',
        label: `${c.type}｜${c.title}`,
        // 已被安全修订版取代的正文只保留在审计存储，普通资产溯源不是
        // 审计出口，不能继续通过400字预览旁路读取旧报告。
        preview: superseded ? null : String(c.body || '').slice(0, 400),
        meta: superseded
          ? `状态 ${delivery.reason}`
          : `状态 ${c.status} · ${c.ai_mode === 'api' ? 'AI生成' : '模板生成'} · ${(c.created_at || '').slice(0, 16)}`,
        link: superseded ? replacementLink : '/content',
        ...(superseded
          ? {
              bodyAvailability: 'superseded',
              deliveryState: delivery.code,
              supersededBy: replacement,
            }
          : {}),
      };
    }
  } else if (a.source_type === 'kb' && a.source_id) {
    const k = q.get(`SELECT category,title,body,source_type,source_id,enabled,updated_at
      FROM kb_docs WHERE tenant_id = ${curTenant()} AND id = ?`, a.source_id);
    if (k) {
      const delivery = k.source_type === 'content' && k.source_id
        ? loadContentDeliveryState(k.source_id, { tenantId: curTenant() })
        : null;
      const superseded = delivery?.code === 'DELIVERY_SUPERSEDED';
      const replacement = delivery?.supersededBy || null;
      const replacementLink = replacement?.employeeIdx != null
        ? `/employees?employee=${encodeURIComponent(String(replacement.employeeIdx))}&task=${encodeURIComponent(String(replacement.taskId))}`
        : replacement?.taskId
          ? `/tasks?kind=restaurant&id=${encodeURIComponent(String(replacement.taskId))}`
          : '/system';
      source = {
        type: '知识库文档',
        label: `${k.category}｜${k.title}`,
        // 关联旧报告的知识文档会在取代事务中禁用；资产溯源
        // 仍可看见它的存在，但不能再成为旧正文的读取旁路。
        preview: superseded ? null : String(k.body || '').slice(0, 400),
        meta: superseded
          ? `状态 ${delivery.reason}`
          : `更新于 ${(k.updated_at || '').slice(0, 16)}`,
        link: superseded ? replacementLink : '/system',
        ...(superseded
          ? {
              bodyAvailability: 'superseded',
              deliveryState: delivery.code,
              supersededBy: replacement,
            }
          : {}),
      };
    }
  } else if (a.source_type === 'lead' && a.source_id) {
    const l = q.get(`SELECT id, name, identity_tag, stage, grade, score, deal_amount FROM leads WHERE tenant_id = ${curTenant()} AND id = ?`, a.source_id);
    if (l) source = {
      type: '客户档案',
      label: `${l.name}（${l.identity_tag || '-'}·${l.grade}级·${l.stage}）`,
      preview: `成交概率 ${l.score} 分${l.deal_amount ? `｜累计成交 ¥${l.deal_amount}` : ''}`,
      leadId: l.id,
      link: '/growth',
    };
  } else if (a.source_type === 'order' && a.source_id) {
    const order = q.get(`SELECT o.product,o.amount,o.type,o.channel,o.created_at,l.name customer FROM orders o
      LEFT JOIN leads l ON l.id=o.lead_id WHERE o.tenant_id=${curTenant()} AND o.id=?`, a.source_id);
    if (order) source = { type: '销售订单', label: `${order.product}｜${order.customer || '-'}`, preview: `金额 ¥${Number(order.amount || 0).toLocaleString()}｜${order.type || '-'}`, meta: order.created_at, link: '/analysis' };
  } else if (a.source_type === 'daily_ops' && a.source_id) {
    const daily = q.get(`SELECT date,new_leads,deals,deal_amount,marketing_cost FROM daily_ops WHERE tenant_id=${curTenant()} AND id=?`, a.source_id);
    if (daily) source = { type: '经营日报', label: `${daily.date}｜经营日报`, preview: `新增线索 ${daily.new_leads || 0}｜成交 ${daily.deals || 0}｜成交额 ¥${Number(daily.deal_amount || 0).toLocaleString()}`, link: '/analysis' };
  } else if (a.source_type === 'activity' && a.source_id) {
    const activity = q.get(`SELECT title,date,status,revenue FROM activities WHERE tenant_id=${curTenant()} AND id=?`, a.source_id);
    if (activity) source = { type: '活动数据', label: `${activity.title}｜${activity.date}`, preview: `状态 ${activity.status || '-'}｜收入 ¥${Number(activity.revenue || 0).toLocaleString()}`, link: '/activities' };
  } else if (a.source_type === 'partner' && a.source_id) {
    const partner = q.get(`SELECT name,level,region,status FROM partners WHERE tenant_id=${curTenant()} AND id=?`, a.source_id);
    if (partner) source = { type: '合伙人档案', label: `${partner.name}｜${partner.level || '-'}`, preview: `${partner.region || '-'}｜${partner.status || '-'}`, link: '/execution' };
  } else if (a.source_type === 'task' && a.source_id) {
    const task = q.get(`SELECT title,type,status,due_at FROM tasks WHERE tenant_id=${curTenant()} AND id=?`, a.source_id);
    if (task) source = { type: '员工任务', label: `${task.title}｜${task.type || '-'}`, preview: `状态 ${task.status || '-'}｜截止 ${task.due_at || '-'}`, link: '/execution' };
  } else if (a.source_type === 'media_job' && a.source_id) {
    const j = q.get(`SELECT kind, prompt, model, status, url, created_at FROM media_jobs WHERE tenant_id = ${curTenant()} AND id = ?`, a.source_id);
    if (j) source = {
      type: '媒体生成任务',
      label: `${j.kind || 'media'}｜${j.model || '-'}`,
      preview: String(j.prompt || '').slice(0, 400),
      meta: `状态 ${j.status || '-'} · ${(j.created_at || '').slice(0, 16)}`,
      link: j.url || '/content',
    };
  } else if (['manual', 'manual_upload'].includes(a.source_type || '')) {
    const u = a.creator_id ? q.get(`SELECT name, role FROM users WHERE tenant_id = ${curTenant()} AND id = ?`, a.creator_id) : null;
    source = {
      type: a.source_type === 'manual_upload' ? '人工/批量导入' : '手动登记',
      label: `${a.owner || u?.name || '未标注归属'}｜${a.name}`,
      preview: a.note || '暂无来源备注',
      meta: `导入人 ${u?.name || a.owner || '-'} · ${(a.created_at || '').slice(0, 16)}`,
      link: a.url || null,
    };
  }
  res.json({
    ...a,
    flows,
    source,
    note: '溯源链：资产登记 → 源对象（内容/知识库/客户/人工导入）→ 业务动作（生成/录入/建档/流转）。估值=类型基准价×活跃度，调用次数实时累计。',
  });
});

r.post('/:id/status', (req, res) => {
  const a = getVisibleAsset(req, req.params.id);
  if (!a) return res.status(404).json({ error: '资产不存在或无权流转' });
  const status = clean(req.body?.status);
  if (!VALID_STATUSES.has(status)) return res.status(400).json({ error: '无效资产状态' });
  q.run(`UPDATE biz_assets SET status = ?, updated_at = datetime('now','localtime') WHERE tenant_id = ? AND id = ?`,
    status, curTenant(), a.id);
  q.run('INSERT INTO asset_flows(asset_id,action,note,operator_id) VALUES(?,?,?,?)',
    a.id, '状态流转', `→ ${status}`, req.user.id);
  logOp(req.user, '数据资产', '状态流转', `asset#${a.id} → ${status}`);
  res.json({ ok: true });
});

r.delete('/:id', (req, res) => {
  const a = getVisibleAsset(req, req.params.id);
  if (!a) return res.status(404).json({ error: '资产不存在或无权删除' });
  const policy = assetDeletePolicy(req, a);
  if (!policy.allowed) return deletionDenied(res, policy.requiredRole, policy.reason);
  const children = { asset_flows: tableRows('asset_flows', 'asset_id=?', a.id) };
  const archiveId = archiveAndDelete(req, {
    entityType: 'asset',
    entityId: a.id,
    table: 'biz_assets',
    row: a,
    children,
    module: '数据资产',
    title: a.name,
    summary: `${a.category || '-'}；来源=${a.source_type || '-'}；状态=${a.status || '-'}；调用${a.use_count || 0}次`,
    requiredRole: policy.requiredRole,
    reason: req.body?.reason || policy.reason,
  }, () => {
    deleteList('asset_flows', 'asset_id=?', a.id);
    deleteList('biz_assets', 'id=?', a.id);
  });
  logOp(req.user, '数据资产', '删除资产入回收站', `${a.name} / archive#${archiveId}`);
  res.json({ ok: true, archiveId, message: '已删除并进入回收站，老板/管理员可恢复' });
});

export default r;
