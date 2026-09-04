// 拍照/截图识别报表 → 严格 JSON（json_schema）→ 转成数据录入中枢 preview 同构的「工作表」。
// 只负责：schema 定义、供应商输出解析与校验、置信度标记、行转 sheet。计费与路由在 routes/dataintake.js。
import { jsonSchemaFormat } from './yunwu.js';

export const VISION_KINDS = Object.freeze(['daily_summary', 'menu', 'cost_receipt', 'delivery_report', 'auto']);
export const VISION_KIND_LABELS = Object.freeze({
  daily_summary: '收银日结单 / 每日营业汇总',
  menu: '菜单照片',
  cost_receipt: '进货单 / 发票 / 成本票据',
  delivery_report: '外卖平台后台截图',
  auto: '自动判断',
});
// 字段置信度低于此值 → 前端标黄要求人工确认
export const LOW_CONFIDENCE = 0.75;
export const MAX_VISION_FILES = 10;
export const MAX_VISION_FILE_BYTES = 10 * 1024 * 1024;
export const VISION_OUTPUT_TOKENS = 2400;
export const VISION_EXTRACT_MODE_PREFIX = 'AI识图·结构化';

const nullable = type => ({ type: [type, 'null'] });
const confidenceField = { type: 'number', minimum: 0, maximum: 1 };
const stringList = { type: 'array', items: { type: 'string' } };

function strictObject(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

// 每个字段一个置信度（0-1）。strict 模式要求 required 全列，缺的字段模型必须显式给 null。
function fieldConfidenceSchema(fields) {
  return strictObject(Object.fromEntries(fields.map(field => [field, confidenceField])));
}

const DAILY_SUMMARY_FIELDS = ['date', 'storeName', 'revenue', 'orders', 'avgTicket', 'deliveryRevenue', 'refunds'];
const DAILY_SUMMARY_SCHEMA = strictObject({
  date: nullable('string'),
  storeName: nullable('string'),
  revenue: nullable('number'),
  orders: nullable('integer'),
  avgTicket: nullable('number'),
  deliveryRevenue: nullable('number'),
  refunds: nullable('number'),
  confidence: confidenceField,
  fieldConfidence: fieldConfidenceSchema(DAILY_SUMMARY_FIELDS),
  fieldsUnreadable: stringList,
});

const MENU_ITEM_FIELDS = ['name', 'price', 'category', 'unit'];
const MENU_SCHEMA = strictObject({
  storeName: nullable('string'),
  items: {
    type: 'array',
    items: strictObject({
      name: nullable('string'),
      price: nullable('number'),
      category: nullable('string'),
      unit: nullable('string'),
      confidence: confidenceField,
      fieldConfidence: fieldConfidenceSchema(MENU_ITEM_FIELDS),
      fieldsUnreadable: stringList,
    }),
  },
  confidence: confidenceField,
  fieldsUnreadable: stringList,
});

const COST_CATEGORIES = ['食材', '人力', '房租', '水电', '营销', '其他'];
const COST_RECEIPT_FIELDS = ['date', 'storeName', 'vendor', 'category', 'amount'];
const COST_RECEIPT_SCHEMA = strictObject({
  date: nullable('string'),
  storeName: nullable('string'),
  vendor: nullable('string'),
  category: { type: ['string', 'null'], enum: [...COST_CATEGORIES, null] },
  amount: nullable('number'),
  confidence: confidenceField,
  fieldConfidence: fieldConfidenceSchema(COST_RECEIPT_FIELDS),
  fieldsUnreadable: stringList,
});

const DELIVERY_PLATFORMS = ['美团', '饿了么', '其他'];
const DELIVERY_REPORT_FIELDS = ['date', 'storeName', 'platform', 'orders', 'revenue', 'rating', 'avgPrepMinutes', 'badReviews'];
const DELIVERY_REPORT_SCHEMA = strictObject({
  date: nullable('string'),
  storeName: nullable('string'),
  platform: { type: ['string', 'null'], enum: [...DELIVERY_PLATFORMS, null] },
  orders: nullable('integer'),
  revenue: nullable('number'),
  rating: nullable('number'),
  avgPrepMinutes: nullable('number'),
  badReviews: nullable('integer'),
  confidence: confidenceField,
  fieldConfidence: fieldConfidenceSchema(DELIVERY_REPORT_FIELDS),
  fieldsUnreadable: stringList,
});

const AUTO_SCHEMA = strictObject({
  kind: { type: 'string', enum: ['daily_summary', 'menu', 'cost_receipt', 'delivery_report', 'unknown'] },
  daily_summary: { anyOf: [DAILY_SUMMARY_SCHEMA, { type: 'null' }] },
  menu: { anyOf: [MENU_SCHEMA, { type: 'null' }] },
  cost_receipt: { anyOf: [COST_RECEIPT_SCHEMA, { type: 'null' }] },
  delivery_report: { anyOf: [DELIVERY_REPORT_SCHEMA, { type: 'null' }] },
});

export const VISION_SCHEMAS = Object.freeze({
  daily_summary: DAILY_SUMMARY_SCHEMA,
  menu: MENU_SCHEMA,
  cost_receipt: COST_RECEIPT_SCHEMA,
  delivery_report: DELIVERY_REPORT_SCHEMA,
  auto: AUTO_SCHEMA,
});

export function visionResponseFormat(kind) {
  const schema = VISION_SCHEMAS[kind];
  if (!schema) throw Object.assign(new Error('不支持的识别类型'), { status: 400 });
  return jsonSchemaFormat(`data_intake_${kind}`, schema);
}

const COMMON_RULES = [
  '你是餐饮门店经营数据录入助手，只从图片/文本中抄录真实可见的数字与文字。',
  '看不清、被遮挡、没有出现的字段一律输出 null，并把字段名写进 fieldsUnreadable；绝对不要猜、不要补 0。',
  '金额去掉货币符号与千分位，输出数字；日期统一为 YYYY-MM-DD（年份缺失时结合图中其他信息判断，仍不确定就 null）。',
  'fieldConfidence 里每个字段给 0-1 的把握程度：清晰印刷体 0.9 以上，手写/模糊 0.5-0.8，靠推断 0.5 以下。',
  '只输出 JSON，不要任何解释。',
];

export function visionSystemPrompt(kind) {
  const specific = {
    daily_summary: '这是一张收银日结单、营业汇总或外卖平台当日汇总截图。提取：日期、门店名、营收（实收/营业额）、订单数（单量/笔数）、客单价、外卖营收、退款。',
    menu: '这是菜单照片/菜单表格。逐道菜输出名称、售价、分类（如图中有分区标题）、单位；套餐按一道菜处理；没有价格的菜 price 为 null。',
    cost_receipt: '这是进货单、发票、水电单或工资表等成本票据。提取日期、门店名、供应商/收款方、成本类别（食材/人力/房租/水电/营销/其他）、合计金额。',
    delivery_report: '这是外卖平台（美团/饿了么）商家后台的日数据截图。提取日期、门店名、平台、订单数、营收（实收）、评分、平均出餐时长（分钟）、差评数。',
    auto: '先判断图片是收银日结单(daily_summary)、菜单(menu)、成本票据(cost_receipt)还是外卖后台截图(delivery_report)，把 kind 填好并只填对应的那个对象，其他对象为 null；都不是则 kind=unknown 且四个对象全为 null。',
  }[kind];
  return [...COMMON_RULES, specific].join('\n');
}

const isNum = value => typeof value === 'number' && Number.isFinite(value);
const num = value => (isNum(value) ? value : null);
const int = value => (isNum(value) && Number.isInteger(value) ? value : isNum(value) ? Math.round(value) : null);
const text = (value, max = 200) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const clamp01 = value => (isNum(value) ? Math.min(1, Math.max(0, value)) : 0);
const list = value => (Array.isArray(value) ? value.map(item => String(item ?? '').trim()).filter(Boolean) : []);

function normalizeDate(value) {
  const raw = text(value, 40);
  if (!raw) return null;
  const match = raw.replace(/[年/.]/g, '-').replace(/月/g, '-').replace(/日/g, '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return null;
  const y = Number(match[1]); const m = Number(match[2]); const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseJsonStrict(raw) {
  const body = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw Object.assign(new Error('识别结果不是合法 JSON，已放弃本次结果'), { status: 502, code: 'VISION_OUTPUT_INVALID' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('识别结果结构不正确'), { status: 502, code: 'VISION_OUTPUT_INVALID' });
  }
  return parsed;
}

function confidenceMap(source, fields) {
  const out = {};
  for (const field of fields) out[field] = clamp01(source?.[field]);
  return out;
}

// 字段值为 null 或声明不可读 → 值置空，置信度归 0（前端必须人工填或删行）
function applyUnreadable(values, confidences, unreadable) {
  for (const field of Object.keys(values)) {
    if (values[field] === null || unreadable.includes(field)) {
      values[field] = null;
      confidences[field] = 0;
      if (!unreadable.includes(field)) unreadable.push(field);
    }
  }
}

function normalizeDailySummary(parsed) {
  const values = {
    date: normalizeDate(parsed.date),
    storeName: text(parsed.storeName, 80),
    revenue: num(parsed.revenue),
    orders: int(parsed.orders),
    avgTicket: num(parsed.avgTicket),
    deliveryRevenue: num(parsed.deliveryRevenue),
    refunds: num(parsed.refunds),
  };
  const confidences = confidenceMap(parsed.fieldConfidence, DAILY_SUMMARY_FIELDS);
  const unreadable = list(parsed.fieldsUnreadable);
  applyUnreadable(values, confidences, unreadable);
  return { kind: 'daily_summary', confidence: clamp01(parsed.confidence), rows: [{ values, confidences, unreadable }] };
}

function normalizeMenu(parsed) {
  const storeName = text(parsed.storeName, 80);
  const items = Array.isArray(parsed.items) ? parsed.items.slice(0, 300) : [];
  const rows = items.map(item => {
    const values = {
      storeName,
      name: text(item?.name, 60),
      price: num(item?.price),
      category: text(item?.category, 40),
      unit: text(item?.unit, 10),
    };
    const confidences = { storeName: storeName ? 0.9 : 0, ...confidenceMap(item?.fieldConfidence, MENU_ITEM_FIELDS) };
    const unreadable = list(item?.fieldsUnreadable);
    applyUnreadable(values, confidences, unreadable);
    return { values, confidences, unreadable };
  }).filter(row => row.values.name || row.values.price !== null);
  return { kind: 'menu', confidence: clamp01(parsed.confidence), rows, fieldsUnreadable: list(parsed.fieldsUnreadable) };
}

function normalizeCostReceipt(parsed) {
  const values = {
    date: normalizeDate(parsed.date),
    storeName: text(parsed.storeName, 80),
    vendor: text(parsed.vendor, 80),
    category: COST_CATEGORIES.includes(parsed.category) ? parsed.category : null,
    amount: num(parsed.amount),
  };
  const confidences = confidenceMap(parsed.fieldConfidence, COST_RECEIPT_FIELDS);
  const unreadable = list(parsed.fieldsUnreadable);
  applyUnreadable(values, confidences, unreadable);
  return { kind: 'cost_receipt', confidence: clamp01(parsed.confidence), rows: [{ values, confidences, unreadable }] };
}

function normalizeDeliveryReport(parsed) {
  const values = {
    date: normalizeDate(parsed.date),
    storeName: text(parsed.storeName, 80),
    platform: DELIVERY_PLATFORMS.includes(parsed.platform) ? parsed.platform : null,
    orders: int(parsed.orders),
    revenue: num(parsed.revenue),
    rating: num(parsed.rating),
    avgPrepMinutes: num(parsed.avgPrepMinutes),
    badReviews: int(parsed.badReviews),
  };
  const confidences = confidenceMap(parsed.fieldConfidence, DELIVERY_REPORT_FIELDS);
  const unreadable = list(parsed.fieldsUnreadable);
  applyUnreadable(values, confidences, unreadable);
  return { kind: 'delivery_report', confidence: clamp01(parsed.confidence), rows: [{ values, confidences, unreadable }] };
}

const NORMALIZERS = {
  daily_summary: normalizeDailySummary,
  menu: normalizeMenu,
  cost_receipt: normalizeCostReceipt,
  delivery_report: normalizeDeliveryReport,
};

/**
 * 供应商文本 → 规范化识别结果。kind='auto' 时按模型判定的 kind 分派；无法判定抛 422。
 * @returns {{kind:string, confidence:number, rows:{values:object, confidences:object, unreadable:string[]}[]}}
 */
export function parseVisionOutput(kind, rawText) {
  const parsed = parseJsonStrict(rawText);
  if (kind === 'auto') {
    const detected = String(parsed.kind || 'unknown');
    if (!NORMALIZERS[detected] || !parsed[detected] || typeof parsed[detected] !== 'object') {
      throw Object.assign(new Error('无法判断这张图片是日结单、菜单、票据还是外卖后台截图，请手动选择识别类型后重试'), {
        status: 422, code: 'VISION_KIND_UNKNOWN',
      });
    }
    return NORMALIZERS[detected](parsed[detected]);
  }
  const normalizer = NORMALIZERS[kind];
  if (!normalizer) throw Object.assign(new Error('不支持的识别类型'), { status: 400 });
  return normalizer(parsed);
}

// 识别结果 → 与 Excel 上传同构的工作表：第一行是中文表头（对应 TARGETS 别名），后续每行一条记录。
// 每行附带 fieldConfidence / unreadableFields，供路由在 rowsFromSheet 之后合并进预览行。
const SHEET_LAYOUT = {
  daily_summary: {
    target: 'store_daily',
    columns: [
      ['storeName', '门店名称'], ['date', '日期'], ['revenue', '营收'], ['orders', '订单数'],
      ['avgTicket', '客单价'], ['deliveryRevenue', '外卖营收'], ['refunds', '退款'],
    ],
  },
  menu: {
    target: 'dishes',
    columns: [['storeName', '门店名称'], ['name', '菜品名称'], ['category', '分类'], ['price', '售价'], ['unit', '单位']],
  },
  cost_receipt: {
    target: 'costs',
    columns: [['storeName', '门店名称'], ['date', '日期'], ['category', '成本类别'], ['amount', '金额'], ['vendor', '备注']],
  },
  delivery_report: {
    target: 'delivery_daily',
    columns: [
      ['storeName', '门店名称'], ['date', '日期'], ['platform', '平台'], ['orders', '订单数'], ['revenue', '营收'],
      ['rating', '评分'], ['avgPrepMinutes', '平均出餐分钟'], ['badReviews', '差评数'],
    ],
  },
};

export function visionTargetFor(kind) {
  return SHEET_LAYOUT[kind]?.target || null;
}

export function visionResultToSheet(result, file) {
  const layout = SHEET_LAYOUT[result.kind];
  if (!layout) throw Object.assign(new Error('识别类型无法转换为导入表'), { status: 400 });
  const headers = layout.columns.map(([, header]) => header);
  const rows = result.rows.map(row => layout.columns.map(([field]) => {
    const value = row.values[field];
    return value === null || value === undefined ? '' : value;
  }));
  const rowMeta = result.rows.map(row => {
    const fieldConfidence = {};
    const lowConfidenceFields = [];
    const unreadableFields = [];
    for (const [field, header] of layout.columns) {
      const confidence = Number(row.confidences[field] ?? 0);
      fieldConfidence[header] = confidence;
      if (row.values[field] === null || row.values[field] === undefined) unreadableFields.push(header);
      else if (confidence < LOW_CONFIDENCE) lowConfidenceFields.push(header);
    }
    return { fieldConfidence, lowConfidenceFields, unreadableFields };
  });
  return {
    name: String(file?.name || `识别结果#${file?.id || ''}`),
    target: layout.target,
    rows: [headers, ...rows],
    source: {
      type: 'vision',
      kind: result.kind,
      fileId: Number(file?.id) || null,
      fileName: file?.name || '',
      fileUrl: file?.file_url || null,
      confidence: result.confidence,
    },
    rowMeta,
  };
}

// 供应商返回的字段名称到中文表头（前端展示"哪些字段没识别出来"时用）
export function headerForField(kind, field) {
  const layout = SHEET_LAYOUT[kind];
  return layout?.columns.find(([key]) => key === field)?.[1] || field;
}
