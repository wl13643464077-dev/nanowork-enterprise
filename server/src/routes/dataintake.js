import { Router } from 'express';
import { createHash } from 'node:crypto';
import { db, q, curTenant } from '../db.js';
import { logOp, today } from '../util.js';
import { embedDoc } from '../engines/rag.js';
import { archiveAndDelete, tableRows } from '../engines/deletion.js';

const r = Router();
const MANAGER_ROLES = new Set(['boss', 'ops_director', 'admin']);
const MAX_SHEETS = 10;
const MAX_ROWS_PER_SHEET = 5000;
const MAX_TOTAL_ROWS = 10000;
const MAX_COLUMNS = 128;
const MAX_CELL_TEXT = 1000;
const LONG_TEXT_FIELDS = new Set(['body', 'detail', 'week_problem', 'next_action']);
const NUMERIC_FIELDS_BY_TARGET = {
  daily_ops: ['content_count', 'new_leads', 'invited', 'arrived', 'deals', 'deal_amount', 'repurchase_amount', 'active_partners', 'orders', 'marketing_cost'],
  activities: ['target_join', 'target_deal', 'budget', 'invited', 'signed_up', 'arrived', 'converted', 'revenue', 'cost', 'satisfaction'],
  orders: ['amount'],
};
const INTEGER_IMPORT_FIELDS = new Set([
  'content_count', 'new_leads', 'invited', 'arrived', 'deals', 'active_partners', 'orders',
  'target_join', 'target_deal', 'signed_up', 'converted',
]);
const ENUM_FIELDS_BY_TARGET = {
  leads: {
    stage: new Set(['新线索', '已沟通', '已邀约', '已到店', '已成交', '复购', '已流失']),
    budget_level: new Set(['高', '中', '低', '未知']),
  },
  activities: {
    status: new Set(['策划中', '筹备中', '报名中', '进行中', '已结束', '已复盘']),
  },
  partners: {
    status: new Set(['活跃', '沉默', '暂停', '退出']),
  },
  tasks: {
    status: new Set(['待执行', '进行中', '待审核', '已完成']),
    priority: new Set(['低', '中', '高', '紧急']),
  },
};
const ENUM_ALIASES = {
  leads: {
    stage: {
      '新线索': ['待跟进', '未跟进', '新客户', '新增客户', '初次接触', '初步接洽'],
      '已沟通': ['已联系', '沟通中', '跟进中', '意向客户', '有意向', '已跟进'],
      '已邀约': ['邀约中', '已预约', '预约成功', '待到店'],
      '已到店': ['到店', '已到访', '已到馆', '已到场', '已品鉴'],
      '已成交': ['成交', '已购买', '已签约', '付款客户'],
      '复购': ['复购客户', '老客户', '多次购买'],
      '已流失': ['流失', '无意向', '战败', '无效线索', '已放弃'],
    },
    budget_level: {
      '高': ['a', 'a类', '高意向', '高预算'],
      '中': ['b', 'b类', '中意向', '中预算'],
      '低': ['c', 'c类', '低意向', '低预算'],
      '未知': ['无', '未评估', '待评估', '不详'],
    },
  },
  activities: {
    status: {
      '策划中': ['待开始', '未开始', '策划', '拟定'],
      '筹备中': ['筹备', '准备中', '待执行'],
      '报名中': ['报名', '招募中', '邀约中'],
      '进行中': ['进行', '执行中'],
      '已结束': ['完成', '已完成', '结束', '已结项'],
      '已复盘': ['复盘完成', '已总结'],
    },
  },
  partners: {
    status: {
      '活跃': ['正常', '启用', '合作中'], '沉默': ['低活跃', '待激活'], '暂停': ['停用', '休眠'], '退出': ['解约', '已退出'],
    },
  },
  tasks: {
    status: {
      '待执行': ['未开始', '待办', '新建'], '进行中': ['进行', '执行中'], '待审核': ['待验收', '待审批'], '已完成': ['完成', '已结束'],
    },
    priority: {
      '低': ['p3', '一般'], '中': ['p2', '正常'], '高': ['p1', '重要'], '紧急': ['p0', '特急', '紧急重要'],
    },
  },
};
const ENUM_FALLBACKS = {
  leads: { stage: '新线索', budget_level: '未知' },
  activities: { status: '策划中' },
  partners: { status: '活跃' },
  tasks: { status: '待执行', priority: '中' },
};
const LEGACY_LEAD_SOURCE_MAP = { '品鉴会': '门店活动', '合伙人推荐': '合作伙伴推荐' };
const LEGACY_ACTIVITY_TYPE_MAP = {
  '品鉴会': '门店主题活动',
  '沙龙会': '门店主题活动',
  '招商说明会': '渠道合作活动',
  '回厂游': '门店参访活动',
};
const normalizeActivityType = value => {
  const type = String(value || '').trim();
  return LEGACY_ACTIVITY_TYPE_MAP[type] || type || '门店主题活动';
};
const DATE_FIELDS_BY_TARGET = {
  leads: ['next_follow_at'],
  daily_ops: ['date'],
  activities: ['date'],
  partners: ['joined_at'],
  orders: ['created_at'],
  tasks: ['due_at'],
};

const TARGETS = {
  leads: {
    label: '客户/线索表', required: ['name'],
    fields: {
      name: ['客户姓名', '姓名', '客户', '名称'], phone: ['手机号', '手机', '电话', '联系电话'], wechat: ['微信', '微信号'],
      source: ['来源', '客户来源', '渠道'], identity_tag: ['身份', '身份标签', '客户类型'], interest: ['意向', '意向产品', '兴趣'],
      budget_level: ['预算', '预算级别', '预算等级'], stage: ['阶段', '客户阶段', '状态'], region: ['地区', '区域', '城市'],
      company: ['公司', '企业', '企业名称'], referrer: ['推荐人', '转介绍人'], next_follow_at: ['下次跟进', '跟进时间'], next_action: ['下一步', '下一步动作'],
    },
  },
  daily_ops: {
    label: '经营日报表', required: ['date'],
    fields: {
      date: ['日期', '时间'], content_count: ['内容数', '内容产出', '发布内容'], new_leads: ['新增线索', '新客户', '线索数'],
      invited: ['邀约', '邀约数'], arrived: ['到店', '到场'], deals: ['成交', '成交数'], deal_amount: ['成交金额', '销售额', '营收'],
      repurchase_amount: ['复购金额', '复购'], active_partners: ['活跃合作伙伴', '合作伙伴活跃', '活跃合伙人', '合伙人活跃'], orders: ['订单', '订单数'],
      marketing_cost: ['营销费用', '投放费用', '费用'], week_problem: ['问题', '经营问题'], next_action: ['下一步', '下一步动作'],
    },
  },
  activities: {
    label: '活动表', required: ['title', 'date'],
    fields: {
      title: ['活动名称', '活动', '标题', '名称'], type: ['活动类型', '类型'], status: ['状态', '活动状态'], date: ['日期', '活动日期'],
      location: ['地点', '地址', '活动地点'], target_join: ['目标人数', '目标到场'], target_deal: ['目标成交', '成交目标'], budget: ['预算'],
      invited: ['邀约', '邀约人数'], signed_up: ['报名', '报名人数'], arrived: ['到场', '到场人数'], converted: ['成交', '成交人数'],
      revenue: ['收入', '营收', '成交金额'], cost: ['成本', '费用'], satisfaction: ['满意度'],
    },
  },
  partners: {
    label: '合作伙伴表', required: ['name'],
    fields: {
      name: ['合作伙伴姓名', '合作伙伴', '合伙人姓名', '姓名', '合伙人', '名称'], level: ['级别', '等级', '合作伙伴类型', '合伙人类型'], region: ['地区', '区域', '城市'],
      phone: ['手机号', '手机', '电话'], status: ['状态'], joined_at: ['加入时间', '签约时间', '日期'],
    },
  },
  orders: {
    label: '订单表', required: ['customer', 'amount'],
    fields: {
      customer: ['客户姓名', '客户', '姓名'], phone: ['手机号', '手机', '电话'], product: ['产品', '产品名称', '商品'], amount: ['金额', '订单金额', '成交金额'],
      type: ['订单类型', '类型'], region: ['地区', '区域'], channel: ['渠道', '来源'], created_at: ['订单时间', '成交时间', '日期'],
    },
  },
  tasks: {
    label: '员工任务表', required: ['title'],
    fields: {
      title: ['任务名称', '任务', '标题'], detail: ['任务说明', '详情', '要求'], type: ['任务类型', '类型'], status: ['状态', '任务状态'],
      priority: ['优先级'], assignee: ['负责人', '执行人', '员工'], due_at: ['截止时间', '截止日期'], source: ['来源', '任务来源'],
    },
  },
  knowledge: {
    label: '知识库资料', required: ['title', 'body'],
    fields: {
      category: ['分类', '知识分类'], title: ['标题', '知识标题', '名称'], body: ['内容', '正文', '知识内容', '说明'],
    },
  },
};

const TARGET_TABLES = {
  leads: 'leads',
  daily_ops: 'daily_ops',
  activities: 'activities',
  partners: 'partners',
  orders: 'orders',
  tasks: 'tasks',
  knowledge: 'kb_docs',
};

const TARGET_ENTITY_TYPES = {
  leads: 'lead',
  daily_ops: 'daily_op',
  activities: 'activity',
  partners: 'partner',
  orders: 'order',
  tasks: 'task',
  knowledge: 'kb_doc',
};

const TARGET_MODULES = {
  leads: '客户管理',
  daily_ops: '经营日报',
  activities: '活动作战',
  partners: '合作伙伴管理',
  orders: '销售订单',
  tasks: '组织协同',
  knowledge: '知识库',
};

const TARGET_ASSET_SOURCE = {
  leads: 'lead',
  daily_ops: 'daily_ops',
  activities: 'activity',
  partners: 'partner',
  orders: 'order',
  tasks: 'task',
  knowledge: 'kb',
};

const SYNC_DESTINATIONS = {
  leads: [
    { key: 'growth', label: '增长作战室', path: '/growth' },
    { key: 'dashboard', label: '总裁驾驶舱', path: '/' },
    { key: 'analysis', label: '复盘进化中心', path: '/analysis' },
    { key: 'advisor', label: '战略中枢', path: '/advisor' },
    { key: 'assets', label: '数据资产舱', path: '/assets' },
  ],
  orders: [
    { key: 'dashboard', label: '总裁驾驶舱', path: '/' },
    { key: 'analysis', label: '复盘进化中心', path: '/analysis' },
    { key: 'execution', label: '组织协同舱', path: '/execution' },
    { key: 'advisor', label: '战略中枢', path: '/advisor' },
    { key: 'assets', label: '数据资产舱', path: '/assets' },
  ],
  daily_ops: [
    { key: 'dashboard', label: '总裁驾驶舱', path: '/' },
    { key: 'analysis', label: '复盘进化中心', path: '/analysis' },
    { key: 'execution', label: '组织协同舱', path: '/execution' },
    { key: 'advisor', label: '战略中枢', path: '/advisor' },
    { key: 'assets', label: '数据资产舱', path: '/assets' },
  ],
  activities: [
    { key: 'activities', label: '活动作战室', path: '/activities' },
    { key: 'dashboard', label: '总裁驾驶舱', path: '/' },
    { key: 'analysis', label: '复盘进化中心', path: '/analysis' },
    { key: 'assets', label: '数据资产舱', path: '/assets' },
  ],
  partners: [
    { key: 'execution', label: '组织协同舱', path: '/execution' },
    { key: 'dashboard', label: '总裁驾驶舱', path: '/' },
    { key: 'assets', label: '数据资产舱', path: '/assets' },
  ],
  tasks: [
    { key: 'execution', label: '组织协同舱', path: '/execution' },
    { key: 'dashboard', label: '总裁驾驶舱', path: '/' },
    { key: 'assets', label: '数据资产舱', path: '/assets' },
  ],
  knowledge: [
    { key: 'system', label: '知识库', path: '/system?tab=kb' },
    { key: 'advisor', label: '战略中枢', path: '/advisor' },
    { key: 'marshals', label: '餐饮数字员工', path: '/marshals' },
    { key: 'assets', label: '数据资产舱', path: '/assets' },
  ],
};

const FIELD_LABELS = {
  name: '姓名', phone: '手机号', wechat: '微信号', source: '来源', identity_tag: '身份标签', interest: '意向产品',
  budget_level: '预算等级', stage: '客户阶段', region: '地区', company: '企业名称', referrer: '推荐人',
  next_follow_at: '下次跟进', next_action: '下一步动作', date: '日期', content_count: '内容数', new_leads: '新增线索',
  invited: '邀约数', arrived: '到场数', deals: '成交数', deal_amount: '成交金额', repurchase_amount: '复购金额',
  active_partners: '活跃合作伙伴', orders: '订单数', marketing_cost: '营销费用', week_problem: '经营问题', title: '标题',
  type: '类型', status: '状态', location: '地点', target_join: '目标人数', target_deal: '目标成交', budget: '预算',
  signed_up: '报名数', converted: '成交人数', revenue: '收入', cost: '成本', satisfaction: '满意度', level: '级别',
  joined_at: '加入时间', customer: '客户姓名', product: '产品', amount: '金额', channel: '渠道', created_at: '业务时间',
  detail: '任务说明', priority: '优先级', assignee: '负责人', due_at: '截止时间', category: '分类', body: '正文',
};

function normalized(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_\-—/（）()]/g, '');
}

function normalizedEnumValue(target, field, value) {
  const allowed = ENUM_FIELDS_BY_TARGET[target]?.[field];
  if (!allowed || value === undefined || value === null || value === '') return value;
  const raw = String(value).trim();
  if (allowed.has(raw)) return raw;
  const token = normalized(raw);
  for (const [canonical, aliases] of Object.entries(ENUM_ALIASES[target]?.[field] || {})) {
    if (normalized(canonical) === token || aliases.some(alias => normalized(alias) === token)) return canonical;
  }
  return ENUM_FALLBACKS[target]?.[field] || raw;
}

function normalizeImportedRow(target, row) {
  const output = { ...row };
  for (const field of Object.keys(ENUM_FIELDS_BY_TARGET[target] || {})) {
    if (Object.prototype.hasOwnProperty.call(output, field)) output[field] = normalizedEnumValue(target, field, output[field]);
  }
  if (target === 'activities' && Object.prototype.hasOwnProperty.call(output, 'satisfaction')) {
    const value = numeric(output.satisfaction);
    output.satisfaction = value > 5 && value <= 100 ? Number((value / 20).toFixed(2)) : value;
  }
  if (target === 'activities' && Object.prototype.hasOwnProperty.call(output, 'type')) output.type = normalizeActivityType(output.type);
  if (target === 'leads' && Object.prototype.hasOwnProperty.call(output, 'source')) {
    const source = String(output.source || '').trim();
    output.source = LEGACY_LEAD_SOURCE_MAP[source] || source;
  }
  return output;
}

function fieldLookup(def) {
  const map = new Map();
  for (const [field, aliases] of Object.entries(def.fields)) {
    map.set(normalized(field), field);
    aliases.forEach(alias => map.set(normalized(alias), field));
  }
  return map;
}

function classify(headers) {
  let best = null;
  for (const [key, def] of Object.entries(TARGETS)) {
    const lookup = fieldLookup(def);
    const mapping = headers.map(h => lookup.get(normalized(h)) || null);
    const hits = mapping.filter(Boolean).length;
    const requiredHits = def.required.filter(f => mapping.includes(f)).length;
    const score = hits * 2 + requiredHits * 4;
    if (!best || score > best.score) best = { key, def, mapping, score, hits, requiredHits };
  }
  return best;
}

function rowsFromSheet(sheet) {
  const rows = Array.isArray(sheet?.rows) ? sheet.rows.slice(0, MAX_ROWS_PER_SHEET + 1) : [];
  const headers = (rows[0] || []).slice(0, MAX_COLUMNS).map(x => String(x ?? '').trim());
  const auto = classify(headers);
  const forcedKey = TARGETS[sheet?.target] ? sheet.target : null;
  const detected = forcedKey ? (() => {
    const def = TARGETS[forcedKey];
    const lookup = fieldLookup(def);
    const mapping = headers.map(h => lookup.get(normalized(h)) || null);
    return { key: forcedKey, def, mapping, hits: mapping.filter(Boolean).length, requiredHits: def.required.filter(f => mapping.includes(f)).length };
  })() : auto;
  const mappedRows = rows.slice(1).filter(row => Array.isArray(row) && row.some(v => String(v ?? '').trim())).map((row, index) => {
    const data = {};
    detected.mapping.forEach((field, i) => { if (i < MAX_COLUMNS && field && row[i] !== undefined && row[i] !== '') data[field] = row[i]; });
    let sanitized = data;
    let error = '';
    try {
      sanitized = normalizeImportedRow(detected.key, sanitizedImportRow(detected.def, data));
      const missing = detected.def.required.filter(field => String(sanitized[field] ?? '').trim() === '');
      if (missing.length) error = `缺少${missing.join('、')}`;
      else {
        validateImportRow(detected.key, sanitized);
        validateImportDates(detected.key, sanitized);
      }
      return { rowNumber: index + 2, data: sanitized, valid: !error, missing, error };
    } catch (validationError) {
      error = validationError instanceof Error ? validationError.message : '数据格式不正确';
      return { rowNumber: index + 2, data: sanitized, valid: false, missing: [], error };
    }
  });
  return {
    sheet: String(sheet?.name || 'Sheet1'), target: detected.key, targetLabel: detected.def.label,
    confidence: Math.min(100, Math.round((detected.hits / Math.max(1, headers.length)) * 70 + (detected.requiredHits / detected.def.required.length) * 30)),
    headers, mapping: detected.mapping, rows: mappedRows, required: detected.def.required,
    validRows: mappedRows.filter(x => x.valid).length, invalidRows: mappedRows.filter(x => !x.valid).length,
  };
}

function numeric(value) {
  if (value == null || String(value).trim() === '') return 0;
  const n = Number(String(value ?? '').replace(/[,，￥¥%]/g, ''));
  if (!Number.isFinite(n)) throw new Error(`不是有效数字：${value}`);
  return n;
}

function validateImportRow(target, row) {
  for (const field of NUMERIC_FIELDS_BY_TARGET[target] || []) {
    if (row[field] === undefined || row[field] === null || row[field] === '') continue;
    const value = numeric(row[field]);
    if (value < 0 || value > 1_000_000_000_000) throw new Error(`字段“${field}”必须是0到1万亿之间的数字`);
    if (INTEGER_IMPORT_FIELDS.has(field) && !Number.isInteger(value)) throw new Error(`字段“${field}”必须是整数`);
    if (field === 'satisfaction' && value > 5) throw new Error('满意度支持0到5分评分或0到100百分比');
  }
  for (const [field, allowed] of Object.entries(ENUM_FIELDS_BY_TARGET[target] || {})) {
    if (row[field] !== undefined && row[field] !== null && row[field] !== '' && !allowed.has(String(row[field]).trim())) {
      throw new Error(`字段“${field}”可选值：${[...allowed].join('、')}`);
    }
  }
}

function validateImportDates(target, row) {
  for (const field of DATE_FIELDS_BY_TARGET[target] || []) {
    if (row[field] === undefined || row[field] === null || row[field] === '') continue;
    try {
      parsedDateParts(row[field]);
    } catch (error) {
      throw new Error(`字段“${field}”${error.message}`);
    }
  }
}

const pad2 = value => String(value).padStart(2, '0');

function validDateParts(year, month, day) {
  const y = Number(year); const m = Number(month); const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d ? { year: y, month: m, day: d } : null;
}

function parsedDateParts(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const compact = String(Math.trunc(value));
    if (/^(?:19|20|21|22|23|24|25|26|27|28|29)\d{6}$/.test(compact)) {
      const date = validDateParts(compact.slice(0, 4), compact.slice(4, 6), compact.slice(6, 8));
      if (date) return { ...date, hour: 0, minute: 0, second: 0, hasTime: false };
    }
    if (value > 0) {
      const wholeDays = Math.floor(value);
      const millis = Math.round((value - wholeDays) * 86400000);
      const d = new Date(Date.UTC(1899, 11, 30) + wholeDays * 86400000 + millis);
      const date = validDateParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      if (!date) throw new Error(`无效 Excel 日期序列值：${value}`);
      return {
        ...date,
        hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), hasTime: millis > 0,
      };
    }
  }
  const raw = String(value).trim().replace(/\s+/g, ' ').replace(/[年/.]/g, '-').replace(/月/g, '-').replace(/日/g, '').trim();
  const yearFirst = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?$/);
  const yearLast = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})(?:[ T](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?$/);
  const match = yearFirst || yearLast;
  if (!match) throw new Error(`无法识别日期：${value}`);

  let year; let month; let day; let hour; let minute; let second;
  if (yearFirst) {
    [, year, month, day, hour, minute, second] = match;
  } else {
    const first = Number(match[1]); const secondPart = Number(match[2]);
    year = match[3].length === 2 ? 2000 + Number(match[3]) : match[3];
    // SheetJS/Excel 常见年末格式按 M/D/YYYY；首段大于12时按 D/M/YYYY 兼容。
    month = first > 12 ? secondPart : first;
    day = first > 12 ? first : secondPart;
    [, , , , hour, minute, second] = match;
  }
  const date = validDateParts(year, month, day);
  if (!date) throw new Error(`无效日期：${value}`);
  const h = hour == null ? 0 : Number(hour);
  const min = minute == null ? 0 : Number(minute);
  const sec = second == null ? 0 : Number(second);
  if (h > 23 || min > 59 || sec > 59) throw new Error(`无效时间：${value}`);
  return { ...date, hour: h, minute: min, second: sec, hasTime: hour != null };
}

function dateValue(value) {
  const parts = parsedDateParts(value);
  return parts ? `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` : null;
}

function dateTimeValue(value) {
  const parts = parsedDateParts(value);
  if (!parts) return null;
  const date = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  return parts.hasTime ? `${date} ${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}` : date;
}

function sanitizedImportRow(def, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('行数据格式不正确');
  const out = {};
  for (const field of Object.keys(def.fields)) {
    const value = input[field];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'object') throw new Error(`字段“${field}”只能填写文本、数字或日期`);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`字段“${field}”不是有效数字`);
      out[field] = value;
      continue;
    }
    const limit = LONG_TEXT_FIELDS.has(field) ? (field === 'body' ? 60000 : 8000) : MAX_CELL_TEXT;
    out[field] = String(value).trim().slice(0, limit);
  }
  return out;
}

const IMPORT_UPDATE_TABLES = new Set(['leads', 'daily_ops', 'activities', 'partners', 'orders', 'tasks', 'kb_docs']);

function updateProvided(table, id, row, transforms, { touchUpdatedAt = false } = {}) {
  if (!IMPORT_UPDATE_TABLES.has(table)) throw new Error('不支持更新该数据表');
  const assignments = [];
  const values = [];
  for (const [field, transform] of Object.entries(transforms)) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
    if (!/^[a-z_]+$/.test(field)) throw new Error('导入字段配置不安全');
    assignments.push(`${field}=?`);
    values.push(transform(row[field]));
  }
  if (touchUpdatedAt) assignments.push("updated_at=datetime('now','localtime')");
  if (!assignments.length) return;
  q.run(`UPDATE ${table} SET ${assignments.join(',')} WHERE tenant_id=? AND id=?`, ...values, curTenant(), id);
}

function importRow(target, row, user) {
  if (target === 'leads') {
    const phoneMatches = row.phone
      ? q.all(`SELECT id FROM leads WHERE tenant_id=? AND phone=? ORDER BY id LIMIT 2`, curTenant(), String(row.phone)) : [];
    const wechatMatches = row.wechat
      ? q.all(`SELECT id FROM leads WHERE tenant_id=? AND wechat=? ORDER BY id LIMIT 2`, curTenant(), String(row.wechat)) : [];
    if (phoneMatches.length > 1) throw new Error(`手机号“${row.phone}”已关联多个客户，请先清理重复数据`);
    if (wechatMatches.length > 1) throw new Error(`微信号“${row.wechat}”已关联多个客户，请先清理重复数据`);
    if (phoneMatches[0] && wechatMatches[0] && Number(phoneMatches[0].id) !== Number(wechatMatches[0].id)) {
      throw new Error(`客户“${row.name}”的手机号与微信号分别匹配到不同客户，请人工确认后再导入`);
    }
    let existed = phoneMatches[0] || wechatMatches[0] || null;
    if (!existed && !row.phone && !row.wechat) {
      const candidates = q.all(`SELECT id FROM leads WHERE tenant_id=? AND name=? ORDER BY id LIMIT 2`, curTenant(), String(row.name));
      if (candidates.length > 1) throw new Error(`客户“${row.name}”存在重名，请补充手机号或微信号后再导入`);
      existed = candidates[0] || null;
    }
    const data = {
      name: String(row.name).trim(), phone: row.phone ? String(row.phone).trim() : null, wechat: row.wechat ? String(row.wechat).trim() : null,
      source: row.source || '集中导入', identity_tag: row.identity_tag || null, interest: row.interest || null,
      budget_level: row.budget_level || '未知', stage: row.stage || '新线索', region: row.region || null, company: row.company || null,
      referrer: row.referrer || null, next_follow_at: dateTimeValue(row.next_follow_at), next_action: row.next_action || null,
    };
    if (existed) {
      const before = businessRecord('leads', existed.id);
      updateProvided('leads', existed.id, row, {
        name: value => String(value).trim(),
        phone: value => String(value).trim(),
        wechat: value => String(value).trim(),
        source: value => String(value).trim(),
        identity_tag: value => String(value).trim(),
        interest: value => String(value).trim(),
        budget_level: value => String(value).trim(),
        stage: value => String(value).trim(),
        region: value => String(value).trim(),
        company: value => String(value).trim(),
        referrer: value => String(value).trim(),
        next_follow_at: dateTimeValue,
        next_action: value => String(value).trim(),
      }, { touchUpdatedAt: true });
      return { id: existed.id, action: '更新', before };
    }
    const out = q.run(`INSERT INTO leads(name,phone,wechat,source,identity_tag,interest,budget_level,stage,owner_id,region,company,referrer,next_follow_at,next_action)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, data.name, data.phone, data.wechat, data.source, data.identity_tag, data.interest, data.budget_level, data.stage,
      user.id, data.region, data.company, data.referrer, data.next_follow_at, data.next_action);
    return { id: out.lastInsertRowid, action: '新增' };
  }
  if (target === 'daily_ops') {
    const date = dateValue(row.date);
    const existed = q.get(`SELECT id FROM daily_ops WHERE tenant_id=? AND date=?`, curTenant(), date);
    if (existed) {
      const before = businessRecord('daily_ops', existed.id);
      updateProvided('daily_ops', existed.id, row, {
        content_count: numeric, new_leads: numeric, invited: numeric, arrived: numeric, deals: numeric,
        deal_amount: numeric, repurchase_amount: numeric, active_partners: numeric, orders: numeric, marketing_cost: numeric,
        week_problem: value => String(value).trim(), next_action: value => String(value).trim(),
      });
      return { id: existed.id, action: '更新', before };
    }
    const out = q.run(`INSERT INTO daily_ops(date,content_count,new_leads,invited,arrived,deals,deal_amount,repurchase_amount,active_partners,orders,marketing_cost,week_problem,next_action)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, date, numeric(row.content_count), numeric(row.new_leads),
      numeric(row.invited), numeric(row.arrived), numeric(row.deals), numeric(row.deal_amount), numeric(row.repurchase_amount), numeric(row.active_partners),
      numeric(row.orders), numeric(row.marketing_cost), row.week_problem || null, row.next_action || null);
    return { id: out.lastInsertRowid, action: '新增' };
  }
  if (target === 'activities') {
    const date = dateValue(row.date);
    const existed = q.get(`SELECT id FROM activities WHERE tenant_id=? AND title=? AND date=? LIMIT 1`, curTenant(), String(row.title), date);
    const vals = [normalizeActivityType(row.type), row.status || '策划中', row.location || null, numeric(row.target_join), numeric(row.target_deal), numeric(row.budget),
      numeric(row.invited), numeric(row.signed_up), numeric(row.arrived), numeric(row.converted), numeric(row.revenue), numeric(row.cost), numeric(row.satisfaction)];
    if (existed) {
      const before = businessRecord('activities', existed.id);
      updateProvided('activities', existed.id, row, {
        type: normalizeActivityType, status: value => String(value).trim(), location: value => String(value).trim(),
        target_join: numeric, target_deal: numeric, budget: numeric, invited: numeric, signed_up: numeric,
        arrived: numeric, converted: numeric, revenue: numeric, cost: numeric, satisfaction: numeric,
      });
      return { id: existed.id, action: '更新', before };
    }
    const out = q.run(`INSERT INTO activities(title,date,type,status,location,target_join,target_deal,budget,invited,signed_up,arrived,converted,revenue,cost,satisfaction,owner_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, String(row.title), date, ...vals, user.id);
    return { id: out.lastInsertRowid, action: '新增' };
  }
  if (target === 'partners') {
    let existed = row.phone ? q.get(`SELECT id FROM partners WHERE tenant_id=? AND phone=? LIMIT 1`, curTenant(), String(row.phone)) : null;
    if (!existed) {
      const candidates = q.all(`SELECT id FROM partners WHERE tenant_id=? AND name=? ORDER BY id LIMIT 2`, curTenant(), String(row.name));
      if (candidates.length > 1) throw new Error(`合作伙伴“${row.name}”存在重名，请补充手机号后再导入`);
      existed = candidates[0] || null;
    }
    if (existed) {
      const before = businessRecord('partners', existed.id);
      updateProvided('partners', existed.id, row, {
        name: value => String(value).trim(), level: value => String(value).trim(), region: value => String(value).trim(),
        phone: value => String(value).trim(), status: value => String(value).trim(), joined_at: dateValue,
      });
      return { id: existed.id, action: '更新', before };
    }
    const out = q.run(`INSERT INTO partners(name,level,region,phone,status,joined_at) VALUES(?,?,?,?,?,?)`, String(row.name), row.level || null, row.region || null,
      row.phone || null, row.status || '活跃', dateValue(row.joined_at));
    return { id: out.lastInsertRowid, action: '新增' };
  }
  if (target === 'orders') {
    let lead = row.phone ? q.get(`SELECT id FROM leads WHERE tenant_id=? AND phone=? LIMIT 1`, curTenant(), String(row.phone)) : null;
    if (!lead) {
      const candidates = q.all(`SELECT id FROM leads WHERE tenant_id=? AND name=? ORDER BY id LIMIT 2`, curTenant(), String(row.customer));
      if (candidates.length > 1) throw new Error(`客户“${row.customer}”存在重名，请在订单表补充手机号`);
      lead = candidates[0] || null;
    }
    if (!lead) {
      const businessAt = dateTimeValue(row.created_at) || today();
      const created = q.run(`INSERT INTO leads(name,phone,source,identity_tag,interest,budget_level,stage,owner_id,region,last_interact_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, String(row.customer).trim(), row.phone ? String(row.phone).trim() : null,
      '订单导入自动建档', '普通消费者', row.product || null, '未知', '已成交', user.id, row.region || null,
      businessAt, businessAt, businessAt);
      lead = { id: Number(created.lastInsertRowid) };
      syncImportedAsset('leads', businessRecord('leads', lead.id), user);
    }
    const out = q.run(`INSERT INTO orders(lead_id,product,amount,type,region,channel,created_at) VALUES(?,?,?,?,?,?,?)`, lead.id, row.product || '未填写产品',
      numeric(row.amount), row.type || '零售', row.region || null, row.channel || null, dateTimeValue(row.created_at) || today());
    return { id: out.lastInsertRowid, action: '新增' };
  }
  if (target === 'tasks') {
    let assignee = null;
    if (row.assignee) {
      const candidates = q.all(`SELECT id FROM users WHERE tenant_id=? AND (name=? OR username=?) ORDER BY id LIMIT 2`, curTenant(), String(row.assignee), String(row.assignee));
      if (candidates.length > 1) throw new Error(`负责人“${row.assignee}”存在重名，请填写唯一账号`);
      if (!candidates.length) throw new Error(`未找到负责人“${row.assignee}”，请先创建员工账号或修正姓名`);
      [assignee] = candidates;
    }
    const out = q.run(`INSERT INTO tasks(title,detail,type,status,priority,assignee_id,due_at,source) VALUES(?,?,?,?,?,?,?,?)`, String(row.title), row.detail || '',
      row.type || '其他', row.status || '待执行', row.priority || '中', assignee?.id || user.id, dateTimeValue(row.due_at), row.source || '集中导入');
    return { id: out.lastInsertRowid, action: '新增' };
  }
  if (target === 'knowledge') {
    const category = row.category || '品牌资料';
    const title = String(row.title); const body = String(row.body);
    const candidates = q.all(`SELECT id FROM kb_docs WHERE tenant_id=? AND category=? AND title=? ORDER BY id LIMIT 2`,
      curTenant(), String(category), title);
    if (candidates.length > 1) throw new Error(`知识“${title}”在“${category}”分类下存在重名，请先合并或重命名后再导入`);
    const existed = candidates[0] || null;
    if (existed) {
      const before = businessRecord('knowledge', existed.id);
      updateProvided('kb_docs', existed.id, row, {
        category: value => String(value).trim(), title: value => String(value).trim(), body: value => String(value),
      });
      q.run(`UPDATE kb_docs SET enabled=1,embedding=NULL,version=version+1,updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?`, curTenant(), existed.id);
      embedDoc(existed.id, title, body);
      return { id: existed.id, action: '更新', before };
    }
    const out = q.run(`INSERT INTO kb_docs(category,title,body,enabled) VALUES(?,?,?,1)`, category, title, body);
    embedDoc(out.lastInsertRowid, title, body);
    return { id: out.lastInsertRowid, action: '新增' };
  }
  throw new Error('不支持的目标数据表');
}

function parseJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function businessRecord(target, recordId) {
  const table = TARGET_TABLES[target];
  if (!table) throw new Error('导入记录目标无效');
  return q.get(`SELECT * FROM ${table} WHERE tenant_id=? AND id=?`, curTenant(), Number(recordId)) || null;
}

function importedAssetDescriptor(target, row) {
  if (target === 'leads') {
    const stageValue = ['已成交', '复购'].includes(row.stage) ? 1200 : row.stage === '已到店' ? 800 : 500;
    return { name: `${row.name}·客户档案`, category: '客户资产', value: stageValue, owner: '增长中心' };
  }
  if (target === 'daily_ops') return { name: `${row.date}·经营日报`, category: '数据资产', value: 320, owner: '数据录入中枢' };
  if (target === 'activities') return { name: `${row.title}·活动数据`, category: '数据资产', value: 420, owner: '活动中心' };
  if (target === 'partners') return { name: `${row.name}·合作伙伴档案`, category: '客户资产', value: 600, owner: '组织协同' };
  if (target === 'orders') {
    const lead = q.get('SELECT name FROM leads WHERE tenant_id=? AND id=?', curTenant(), row.lead_id);
    return { name: `${row.product || '未填写产品'}·${lead?.name || '客户'}订单`, category: '数据资产', value: 360, owner: '经营分析' };
  }
  if (target === 'tasks') return { name: `${row.title}·任务数据`, category: '数据资产', value: 220, owner: '组织协同' };
  if (target === 'knowledge') return { name: row.title, category: '知识资产', value: 260, owner: '知识库' };
  return null;
}

function syncImportedAsset(target, row, user) {
  const sourceType = TARGET_ASSET_SOURCE[target];
  const descriptor = importedAssetDescriptor(target, row);
  if (!sourceType || !descriptor || !row?.id) return null;
  const existing = q.get(`SELECT id FROM biz_assets WHERE tenant_id=? AND source_type=? AND source_id=? ORDER BY id LIMIT 1`,
    curTenant(), sourceType, row.id);
  const note = `数据录入中枢自动同步：${TARGETS[target]?.label || target}#${row.id}`;
  if (existing) {
    q.run(`UPDATE biz_assets SET name=?,category=?,value=?,status='使用中',owner=?,creator_id=COALESCE(creator_id,?),
      note=?,updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?`,
    descriptor.name, descriptor.category, descriptor.value, descriptor.owner, user.id, note, curTenant(), existing.id);
    return Number(existing.id);
  }
  const out = q.run(`INSERT INTO biz_assets(name,category,value,status,use_count,owner,source_type,source_id,creator_id,note)
    VALUES(?,?,?,'使用中',0,?,?,?,?,?)`,
  descriptor.name, descriptor.category, descriptor.value, descriptor.owner, sourceType, row.id, user.id, note);
  q.run('INSERT INTO asset_flows(asset_id,action,note,operator_id) VALUES(?,?,?,?)',
    out.lastInsertRowid, '数据同步', note, user.id);
  return Number(out.lastInsertRowid);
}

function syncPayload(results) {
  const targets = [...new Set(results.filter(result => Number(result.imported) > 0).map(result => result.target))];
  const destinations = [];
  const seen = new Set();
  for (const target of targets) {
    for (const destination of SYNC_DESTINATIONS[target] || []) {
      if (seen.has(destination.key)) continue;
      seen.add(destination.key);
      destinations.push(destination);
    }
  }
  return { status: 'completed', targets, destinations, checkedAt: new Date().toISOString() };
}

function logicalRecord(target, row) {
  if (!row) return null;
  const output = {};
  for (const field of Object.keys(TARGETS[target]?.fields || {})) {
    if (Object.prototype.hasOwnProperty.call(row, field)) output[field] = row[field];
  }
  if (target === 'orders') {
    const lead = row.lead_id ? q.get('SELECT name,phone FROM leads WHERE tenant_id=? AND id=?', curTenant(), row.lead_id) : null;
    output.customer = lead?.name || '';
    output.phone = lead?.phone || '';
  }
  if (target === 'tasks') {
    const assignee = row.assignee_id ? q.get('SELECT name,username FROM users WHERE tenant_id=? AND id=?', curTenant(), row.assignee_id) : null;
    output.assignee = assignee?.username || assignee?.name || '';
  }
  return output;
}

function itemView(item) {
  const snapshot = parseJson(item.current_snapshot, {});
  const live = item.status === 'active' ? businessRecord(item.target_table, item.record_id) : null;
  return {
    id: Number(item.id),
    jobId: Number(item.job_id),
    target: item.target_table,
    targetLabel: TARGETS[item.target_table]?.label || item.target_table,
    recordId: Number(item.record_id),
    rowNumber: item.source_row,
    sheet: item.sheet_name,
    importAction: item.import_action,
    status: item.status,
    recordExists: Boolean(live),
    data: logicalRecord(item.target_table, live || snapshot),
    editableFields: Object.keys(TARGETS[item.target_table]?.fields || {}).map(key => ({ key, label: FIELD_LABELS[key] || key })),
    operatorName: item.last_operator_name,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

function trackedItem(itemId) {
  return q.get(`SELECT i.*, j.created_at AS job_created_at
    FROM data_import_items i JOIN data_import_jobs j ON j.tenant_id=i.tenant_id AND j.id=i.job_id
    WHERE i.tenant_id=? AND i.id=?`, curTenant(), Number(itemId));
}

function assertEditableItem(item) {
  if (!item) throw Object.assign(new Error('导入记录不存在'), { status: 404 });
  if (item.status !== 'active') throw Object.assign(new Error('该导入记录已处理，不能重复修改或删除'), { status: 409 });
  const latest = q.get(`SELECT id FROM data_import_items
    WHERE tenant_id=? AND target_table=? AND record_id=? AND status='active' ORDER BY id DESC LIMIT 1`,
  curTenant(), item.target_table, item.record_id);
  if (Number(latest?.id) !== Number(item.id)) {
    throw Object.assign(new Error('该业务记录还有更新的导入操作，请先处理最新一条记录'), { status: 409 });
  }
  const live = businessRecord(item.target_table, item.record_id);
  if (!live) throw Object.assign(new Error('业务记录已在其他模块被删除，当前导入记录不能继续操作'), { status: 409 });
  const expected = parseJson(item.current_snapshot, null);
  if (!expected || JSON.stringify(live) !== JSON.stringify(expected)) {
    throw Object.assign(new Error('该数据已在其他业务模块发生变化，请刷新后到对应模块确认，系统未覆盖现有数据'), { status: 409 });
  }
  return live;
}

function sanitizedEditRow(target, def, input) {
  const data = normalizeImportedRow(target, sanitizedImportRow(def, input));
  for (const field of Object.keys(def.fields)) {
    if (Object.prototype.hasOwnProperty.call(input || {}, field) && (input[field] === '' || input[field] === null)) data[field] = null;
  }
  return data;
}

const asText = value => value == null ? null : String(value).trim();

function resolveOrderLead(data) {
  let lead = data.phone ? q.get('SELECT id FROM leads WHERE tenant_id=? AND phone=? LIMIT 1', curTenant(), String(data.phone)) : null;
  if (!lead && data.customer) {
    const candidates = q.all('SELECT id FROM leads WHERE tenant_id=? AND name=? ORDER BY id LIMIT 2', curTenant(), String(data.customer));
    if (candidates.length > 1) throw new Error(`客户“${data.customer}”存在重名，请填写手机号`);
    [lead] = candidates;
  }
  if (!lead) throw new Error(`未找到客户“${data.customer || data.phone || ''}”，请先修正客户资料`);
  return lead;
}

function resolveTaskAssignee(value) {
  if (!value) return null;
  const candidates = q.all('SELECT id FROM users WHERE tenant_id=? AND (name=? OR username=?) ORDER BY id LIMIT 2', curTenant(), String(value), String(value));
  if (candidates.length > 1) throw new Error(`负责人“${value}”存在重名，请填写唯一账号`);
  if (!candidates.length) throw new Error(`未找到负责人“${value}”`);
  return candidates[0];
}

function updateTrackedRecord(target, recordId, data) {
  if (target === 'leads') {
    for (const field of ['phone', 'wechat']) {
      if (!data[field]) continue;
      const conflict = q.get(`SELECT id FROM leads WHERE tenant_id=? AND ${field}=? AND id<>? LIMIT 1`, curTenant(), String(data[field]), recordId);
      if (conflict) throw new Error(`${FIELD_LABELS[field]}已关联其他客户，请先核对`);
    }
    updateProvided('leads', recordId, data, {
      name: asText, phone: asText, wechat: asText, source: asText, identity_tag: asText, interest: asText,
      budget_level: asText, stage: asText, region: asText, company: asText, referrer: asText,
      next_follow_at: dateTimeValue, next_action: asText,
    }, { touchUpdatedAt: true });
  } else if (target === 'daily_ops') {
    updateProvided('daily_ops', recordId, data, {
      date: dateValue, content_count: numeric, new_leads: numeric, invited: numeric, arrived: numeric, deals: numeric,
      deal_amount: numeric, repurchase_amount: numeric, active_partners: numeric, orders: numeric, marketing_cost: numeric,
      week_problem: asText, next_action: asText,
    });
  } else if (target === 'activities') {
    updateProvided('activities', recordId, data, {
      title: asText, type: asText, status: asText, date: dateValue, location: asText, target_join: numeric,
      target_deal: numeric, budget: numeric, invited: numeric, signed_up: numeric, arrived: numeric,
      converted: numeric, revenue: numeric, cost: numeric, satisfaction: numeric,
    });
  } else if (target === 'partners') {
    updateProvided('partners', recordId, data, {
      name: asText, level: asText, region: asText, phone: asText, status: asText, joined_at: dateValue,
    });
  } else if (target === 'orders') {
    const lead = resolveOrderLead(data);
    q.run(`UPDATE orders SET lead_id=?,product=?,amount=?,type=?,region=?,channel=?,created_at=? WHERE tenant_id=? AND id=?`,
      lead.id, data.product || '未填写产品', numeric(data.amount), data.type || '零售', data.region || null,
      data.channel || null, dateTimeValue(data.created_at) || today(), curTenant(), recordId);
  } else if (target === 'tasks') {
    const assignee = resolveTaskAssignee(data.assignee);
    q.run(`UPDATE tasks SET title=?,detail=?,type=?,status=?,priority=?,assignee_id=?,due_at=?,source=? WHERE tenant_id=? AND id=?`,
      data.title, data.detail || '', data.type || '其他', data.status || '待执行', data.priority || '中', assignee?.id || null,
      dateTimeValue(data.due_at), data.source || '集中导入', curTenant(), recordId);
  } else if (target === 'knowledge') {
    updateProvided('kb_docs', recordId, data, { category: asText, title: asText, body: value => String(value ?? '') });
    q.run(`UPDATE kb_docs SET enabled=1,embedding=NULL,version=version+1,updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?`, curTenant(), recordId);
    embedDoc(recordId, data.title, data.body);
  } else throw new Error('不支持修改该类导入数据');
}

function restoreSnapshot(target, recordId, snapshot) {
  const table = TARGET_TABLES[target];
  if (!table || !snapshot) throw new Error('原始数据快照不完整，无法撤回');
  const allowed = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  const columns = Object.keys(snapshot).filter(column => allowed.has(column) && !['id', 'tenant_id'].includes(column));
  if (!columns.length) throw new Error('原始数据快照没有可恢复字段');
  q.run(`UPDATE ${table} SET ${columns.map(column => `${column}=?`).join(',')} WHERE tenant_id=? AND id=?`,
    ...columns.map(column => snapshot[column]), curTenant(), recordId);
  if (target === 'knowledge') embedDoc(recordId, snapshot.title, snapshot.body);
}

const DEPENDENCY_RULES = {
  leads: [['follow_ups', 'lead_id', '跟进记录'], ['lead_ai_suggestions', 'lead_id', 'AI建议'], ['orders', 'lead_id', '订单'], ['lead_journey', 'lead_id', '客户旅程'], ['activity_invites', 'lead_id', '活动邀约']],
  partners: [['partner_actions', 'partner_id', '合作伙伴行动']],
  activities: [['activity_invites', 'activity_id', '活动邀约'], ['tasks', 'activity_id', '活动任务']],
  tasks: [['task_submissions', 'task_id', '任务提交']],
  knowledge: [['generated_artifacts', 'kb_doc_id', '产出物']],
};

function importedAssetChildren(target, recordId) {
  const sourceType = TARGET_ASSET_SOURCE[target];
  if (!sourceType) return { rows: [], flows: [] };
  const rows = tableRows('biz_assets', 'source_type=? AND source_id=?', sourceType, recordId);
  const ids = rows.map(row => row.id);
  const flows = ids.length
    ? q.all(`SELECT * FROM asset_flows WHERE tenant_id=? AND asset_id IN (${ids.map(() => '?').join(',')})`, curTenant(), ...ids)
    : [];
  return { rows, flows };
}

function recordDependencies(target, recordId) {
  const hits = [];
  for (const [table, column, label, extra] of DEPENDENCY_RULES[target] || []) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    if (!columns.includes(column) || !columns.includes('tenant_id')) continue;
    const count = q.get(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id=? AND ${column}=?${extra ? ` AND ${extra}` : ''}`, curTenant(), recordId)?.n || 0;
    if (count) hits.push(`${label}${count}条`);
  }
  return hits;
}

function recordTitle(target, row) {
  return String(row?.name || row?.title || row?.date || row?.product || `${TARGETS[target]?.label || target}#${row?.id || ''}`);
}

r.use((req, res, next) => {
  if (!MANAGER_ROLES.has(req.user.role)) return res.status(403).json({ error: '集中数据录入仅老板、运营总监或管理员可操作' });
  next();
});

r.get('/schema', (_req, res) => {
  res.json(Object.entries(TARGETS).map(([key, def]) => ({
    key,
    label: def.label,
    required: def.required,
    fields: Object.keys(def.fields),
    editableFields: Object.keys(def.fields).map(field => ({ key: field, label: FIELD_LABELS[field] || field })),
  })));
});

r.get('/history', (req, res) => {
  const requested = Number(req.query.limit || 100);
  const limit = Number.isInteger(requested) ? Math.max(1, Math.min(200, requested)) : 100;
  const rows = q.all(`SELECT i.* FROM data_import_items i
    WHERE i.tenant_id=? ORDER BY i.id DESC LIMIT ?`, curTenant(), limit);
  res.json(rows.map(itemView));
});

r.get('/jobs', (req, res) => {
  const requested = Number(req.query.limit || 30);
  const limit = Number.isInteger(requested) ? Math.max(1, Math.min(100, requested)) : 30;
  const rows = q.all(`SELECT id,target_table,mapping,total_rows,imported_rows,skipped_rows,error_rows,created_at
    FROM data_import_jobs WHERE tenant_id=? ORDER BY id DESC LIMIT ?`, curTenant(), limit);
  res.json(rows.map(row => {
    const metadata = parseJson(row.mapping, []);
    const errors = parseJson(row.error_rows, []);
    const imported = Number(row.imported_rows || 0);
    const skipped = Number(row.skipped_rows || 0);
    return {
      id: Number(row.id),
      target: row.target_table,
      targetLabel: TARGETS[row.target_table]?.label || row.target_table,
      sheet: !Array.isArray(metadata) ? String(metadata?.sheet || '') : '',
      total: Number(row.total_rows || 0),
      imported,
      skipped,
      errors: Array.isArray(errors) ? errors.slice(0, 20) : [],
      status: imported > 0 && skipped > 0 ? 'partial' : imported > 0 ? 'success' : 'failed',
      createdAt: row.created_at,
    };
  }));
});

r.post('/reconcile', (req, res) => {
  const rows = q.all(`SELECT DISTINCT i.target_table,i.record_id,i.user_id
    FROM data_import_items i
    WHERE i.tenant_id=? AND i.status='active'`, curTenant());
  let assets = 0;
  const targets = new Set();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of rows) {
      if (!TARGETS[item.target_table]) continue;
      const live = businessRecord(item.target_table, item.record_id);
      if (!live) continue;
      const assetId = syncImportedAsset(item.target_table, live, {
        id: Number(item.user_id || req.user.id),
        name: '系统数据同步',
      });
      if (assetId) assets++;
      targets.add(item.target_table);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
  const results = [...targets].map(target => ({ target, imported: 1 }));
  res.json({ ok: true, checked: rows.length, assets, sync: syncPayload(results) });
});

r.put('/items/:id', (req, res) => {
  const item = trackedItem(req.params.id);
  try {
    const live = assertEditableItem(item);
    const def = TARGETS[item.target_table];
    const patch = sanitizedEditRow(item.target_table, def, req.body?.data || {});
    if (!Object.keys(patch).length) return res.status(400).json({ error: '没有需要修改的字段' });
    const merged = { ...logicalRecord(item.target_table, live), ...patch };
    const missing = def.required.filter(field => String(merged[field] ?? '').trim() === '');
    if (missing.length) return res.status(400).json({ error: `必填字段不能为空：${missing.map(field => FIELD_LABELS[field] || field).join('、')}` });
    validateImportRow(item.target_table, merged);
    validateImportDates(item.target_table, merged);

    db.exec('BEGIN IMMEDIATE');
    try {
      updateTrackedRecord(item.target_table, item.record_id, merged);
      const current = businessRecord(item.target_table, item.record_id);
      syncImportedAsset(item.target_table, current, req.user);
      q.run(`UPDATE data_import_items SET current_snapshot=?,last_operator_id=?,last_operator_name=?,updated_at=datetime('now','localtime')
        WHERE tenant_id=? AND id=?`, JSON.stringify(current), req.user.id, req.user.name || req.user.username || '', curTenant(), item.id);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
    logOp(req.user, '数据录入中枢', '修改导入数据', `${item.target_table}#${item.record_id} / import-item#${item.id}`);
    res.json({ ok: true, item: itemView(trackedItem(item.id)) });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || '修改失败' });
  }
});

r.delete('/items/:id', (req, res) => {
  const item = trackedItem(req.params.id);
  try {
    const live = assertEditableItem(item);
    if (item.import_action === '更新') {
      const original = parseJson(item.original_snapshot, null);
      db.exec('BEGIN IMMEDIATE');
      try {
        restoreSnapshot(item.target_table, item.record_id, original);
        syncImportedAsset(item.target_table, businessRecord(item.target_table, item.record_id), req.user);
        q.run(`UPDATE data_import_items SET status='reverted',last_operator_id=?,last_operator_name=?,updated_at=datetime('now','localtime')
          WHERE tenant_id=? AND id=?`, req.user.id, req.user.name || req.user.username || '', curTenant(), item.id);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
        throw error;
      }
      logOp(req.user, '数据录入中枢', '撤回导入更新', `${item.target_table}#${item.record_id} / import-item#${item.id}`);
      return res.json({ ok: true, action: 'reverted', message: '已撤回本次更新，原有业务数据已恢复' });
    }

    const dependencies = recordDependencies(item.target_table, item.record_id);
    if (dependencies.length) {
      return res.status(409).json({ error: `该数据已产生业务关联（${dependencies.join('、')}），请到对应业务模块确认后处理，系统未直接删除` });
    }
    const assets = importedAssetChildren(item.target_table, item.record_id);
    const archiveId = archiveAndDelete(req, {
      entityType: TARGET_ENTITY_TYPES[item.target_table] || item.target_table,
      entityId: item.record_id,
      table: TARGET_TABLES[item.target_table],
      row: live,
      module: TARGET_MODULES[item.target_table] || '数据录入中枢',
      title: recordTitle(item.target_table, live),
      summary: `由数据录入中枢删除，导入记录#${item.id}`,
      children: { biz_assets: assets.rows, asset_flows: assets.flows },
      requiredRole: 'boss',
      reason: '导入数据纠错',
    }, () => {
      for (const asset of assets.rows) q.run('DELETE FROM asset_flows WHERE tenant_id=? AND asset_id=?', curTenant(), asset.id);
      for (const asset of assets.rows) q.run('DELETE FROM biz_assets WHERE tenant_id=? AND id=?', curTenant(), asset.id);
      q.run(`DELETE FROM ${TARGET_TABLES[item.target_table]} WHERE tenant_id=? AND id=?`, curTenant(), item.record_id);
      q.run(`UPDATE data_import_items SET status='deleted',last_operator_id=?,last_operator_name=?,updated_at=datetime('now','localtime')
        WHERE tenant_id=? AND id=?`, req.user.id, req.user.name || req.user.username || '', curTenant(), item.id);
    });
    logOp(req.user, '数据录入中枢', '删除导入数据', `${item.target_table}#${item.record_id} / archive#${archiveId}`);
    res.json({ ok: true, action: 'deleted', archiveId, message: '已删除并进入回收站，老板可在系统管理中恢复' });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || '删除失败' });
  }
});

r.post('/preview', (req, res) => {
  const sourceSheets = Array.isArray(req.body?.sheets) ? req.body.sheets : [];
  if (sourceSheets.length > MAX_SHEETS) return res.status(400).json({ error: `单次最多识别${MAX_SHEETS}个工作表，请拆分后上传` });
  const totalRows = sourceSheets.reduce((sum, sheet) => sum + Math.max(0, (Array.isArray(sheet?.rows) ? sheet.rows.length : 0) - 1), 0);
  if (totalRows > MAX_TOTAL_ROWS) return res.status(400).json({ error: `单次最多识别${MAX_TOTAL_ROWS}行，请拆分后上传` });
  const sheets = sourceSheets;
  if (!sheets.length) return res.status(400).json({ error: '没有可识别的工作表' });
  res.json({ batches: sheets.map(rowsFromSheet) });
});

r.post('/commit', (req, res) => {
  const sourceBatches = Array.isArray(req.body?.batches) ? req.body.batches : [];
  if (sourceBatches.length > MAX_SHEETS) return res.status(400).json({ error: `单次最多导入${MAX_SHEETS}个工作表，请拆分后处理` });
  const batches = sourceBatches;
  if (!batches.length) return res.status(400).json({ error: '没有待导入数据' });
  const requestedRows = batches.reduce((sum, batch) => sum + (Array.isArray(batch?.rows) ? batch.rows.length : 0), 0);
  if (requestedRows > MAX_TOTAL_ROWS) return res.status(400).json({ error: `单次最多导入${MAX_TOTAL_ROWS}行，请分批处理` });
  const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
  const requestHash = createHash('sha256').update(JSON.stringify(sourceBatches)).digest('hex');
  if (idempotencyKey && !/^[a-zA-Z0-9_-]{8,100}$/.test(idempotencyKey)) {
    return res.status(400).json({ error: '导入请求标识格式不正确' });
  }
  if (idempotencyKey) {
    const existing = q.get(`SELECT response,request_hash FROM data_import_commits
      WHERE tenant_id=? AND user_id=? AND idempotency_key=?`, curTenant(), req.user.id, idempotencyKey);
    if (existing?.request_hash && existing.request_hash !== requestHash) {
      return res.status(409).json({ error: '相同导入请求标识对应了不同数据，请重新选择文件后再导入' });
    }
    if (existing?.response) return res.json({ ...JSON.parse(existing.response), replayed: true });
  }
  const results = [];
  let response;
  db.exec('BEGIN IMMEDIATE');
  try {
    let commitId = null;
    if (idempotencyKey) {
      const claimed = q.run(`INSERT OR IGNORE INTO data_import_commits(user_id,idempotency_key,request_hash) VALUES(?,?,?)`, req.user.id, idempotencyKey, requestHash);
      if (!claimed.changes) {
        const existing = q.get(`SELECT response,request_hash FROM data_import_commits
          WHERE tenant_id=? AND user_id=? AND idempotency_key=?`, curTenant(), req.user.id, idempotencyKey);
        if (existing?.request_hash && existing.request_hash !== requestHash) {
          throw Object.assign(new Error('相同导入请求标识对应了不同数据，请重新选择文件后再导入'), { status: 409 });
        }
        if (!existing?.response) throw Object.assign(new Error('相同导入请求正在处理，请稍后查看结果'), { status: 409 });
        db.exec('COMMIT');
        return res.json({ ...JSON.parse(existing.response), replayed: true });
      }
      commitId = claimed.lastInsertRowid;
    }
    for (const batch of batches) {
      const target = String(batch.target || '');
      const def = TARGETS[target];
      if (!def) { results.push({ sheet: batch.sheet, target, imported: 0, skipped: 0, errors: ['目标数据表无效'] }); continue; }
      const rows = Array.isArray(batch.rows) ? batch.rows.slice(0, MAX_ROWS_PER_SHEET) : [];
      const job = q.run(`INSERT INTO data_import_jobs(user_id,file_id,target_table,mapping,total_rows,imported_rows,skipped_rows,error_rows)
        VALUES(?,?,?,?,?,?,?,?)`, req.user.id, batch.fileId || null, target,
      JSON.stringify({ sheet: String(batch.sheet || ''), columns: batch.mapping || [] }), rows.length, 0, 0, '[]');
      const jobId = Number(job.lastInsertRowid);
      let imported = 0; const errors = []; const items = [];
      for (let i = 0; i < rows.length; i++) {
        const raw = rows[i]?.data || rows[i];
        try {
          const data = normalizeImportedRow(target, sanitizedImportRow(def, raw));
          const missing = def.required.filter(f => String(data[f] ?? '').trim() === '');
          if (missing.length) throw new Error(`缺少：${missing.join('、')}`);
          validateImportRow(target, data);
          validateImportDates(target, data);
          const importedRow = importRow(target, data, req.user);
          const current = businessRecord(target, importedRow.id);
          syncImportedAsset(target, current, req.user);
          const tracked = q.run(`INSERT INTO data_import_items(job_id,user_id,target_table,record_id,source_row,sheet_name,import_action,original_snapshot,current_snapshot,last_operator_id,last_operator_name)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`, jobId, req.user.id, target, Number(importedRow.id), rows[i]?.rowNumber || i + 2,
          String(batch.sheet || ''), importedRow.action, importedRow.before ? JSON.stringify(importedRow.before) : null,
          JSON.stringify(current), req.user.id, req.user.name || req.user.username || '');
          items.push({ id: Number(tracked.lastInsertRowid), recordId: Number(importedRow.id), rowNumber: rows[i]?.rowNumber || i + 2, action: importedRow.action });
          imported++;
        }
        catch (e) { errors.push({ row: rows[i]?.rowNumber || i + 2, error: e.message }); }
      }
      q.run(`UPDATE data_import_jobs SET imported_rows=?,skipped_rows=?,error_rows=? WHERE tenant_id=? AND id=?`,
        imported, errors.length, JSON.stringify(errors.slice(0, 200)), curTenant(), jobId);
      results.push({ jobId, sheet: batch.sheet, target, targetLabel: def.label, total: rows.length, imported, skipped: errors.length, errors: errors.slice(0, 50), items });
    }
    const total = results.reduce((sum, item) => sum + item.imported, 0);
    response = { ok: true, imported: total, results, sync: syncPayload(results) };
    if (commitId) q.run(`UPDATE data_import_commits SET response=? WHERE tenant_id=? AND id=?`, JSON.stringify(response), curTenant(), commitId);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    if (error.status === 409) return res.status(409).json({ error: error.message });
    throw error;
  }
  logOp(req.user, '数据录入中枢', '集中导入', `${batches.length}个工作表 / 成功${response.imported}行`);
  res.json(response);
});

export default r;
