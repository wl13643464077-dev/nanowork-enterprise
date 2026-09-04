// 多门店批量导入模板（连锁过渡方案：美团接口暂不做，门店人工上传）。
// 每个模板 = 一张 Excel：表头说明 sheet + 数据 sheet（示例行 + 门店名下拉校验 + 枚举下拉）。
// 模板表头与 routes/dataintake.js 的 TARGETS 字段别名一一对应，下载后原样回传即可被识别。
import ExcelJS from 'exceljs';

export const COST_TEMPLATE_CATEGORIES = Object.freeze(['食材', '人力', '房租', '水电', '营销', '其他']);
export const REVIEW_PLATFORMS = Object.freeze(['美团', '饿了么', '大众点评', '抖音', '其他']);
export const STORE_BIZ_TYPES = Object.freeze(['快餐', '正餐', '茶饮', '火锅', '其他']);
export const STORE_STATUSES = Object.freeze(['营业中', '筹备中', '已关店']);
export const DISH_STATUSES = Object.freeze(['在售', '下架']);

// columns[].key 必须是目标表字段名（TARGETS[target].fields 的 key），header 是该字段首个中文别名。
export const IMPORT_TEMPLATES = Object.freeze([
  {
    key: 'stores',
    target: 'stores',
    label: '门店清单',
    sheet: '门店清单',
    description: '一行一家门店。门店名称在本企业内唯一；同名再次导入 = 更新该门店。',
    columns: [
      { key: 'name', header: '门店名称', required: true, note: '必填，企业内唯一，例：万达店' },
      { key: 'code', header: '门店编码', note: '选填，例：WD001；其他表可用编码代替门店名称' },
      { key: 'city', header: '城市' },
      { key: 'area', header: '商圈/区域' },
      { key: 'address', header: '地址' },
      { key: 'biz_type', header: '业态', enum: STORE_BIZ_TYPES, note: '快餐/正餐/茶饮/火锅/其他' },
      { key: 'status', header: '门店状态', enum: STORE_STATUSES, note: '营业中/筹备中/已关店' },
      { key: 'opened_at', header: '开业日期', note: 'YYYY-MM-DD' },
    ],
    samples: [
      ['万达店', 'WD001', '成都', '万达广场', '万达广场3楼', '快餐', '营业中', '2024-05-01'],
      ['龙湖店', 'LH002', '成都', '龙湖天街', '龙湖天街B1', '快餐', '营业中', '2025-01-15'],
    ],
  },
  {
    key: 'dishes',
    target: 'dishes',
    label: '菜品与售价',
    sheet: '菜品与售价',
    description: '一行一道菜。同店同名菜品再次导入 = 更新售价/成本/状态。门店名称留空 = 当前门店/默认店。',
    storeColumn: true,
    columns: [
      { key: 'store_name', header: '门店名称', store: true, note: '从下拉选择；填门店编码也可以' },
      { key: 'name', header: '菜品名称', required: true },
      { key: 'category', header: '分类', note: '例：主食/小菜/饮品' },
      { key: 'price', header: '售价', required: true, note: '数字，元' },
      { key: 'cost', header: '成本', note: '数字，元，可空' },
      { key: 'unit', header: '单位', note: '份/碗/杯' },
      { key: 'code', header: '菜品编码' },
      { key: 'status', header: '状态', enum: DISH_STATUSES, note: '在售/下架' },
    ],
    samples: [
      ['万达店', '招牌牛肉面', '主食', 28, 9.5, '碗', 'D001', '在售'],
      ['万达店', '凉拌黄瓜', '小菜', 8, 2, '份', 'D002', '在售'],
    ],
  },
  {
    key: 'store_daily',
    target: 'store_daily',
    label: '每日营业汇总（按店按日）',
    sheet: '每日营业汇总',
    description: '一行 = 一家店一天的日结。同店同日再次导入 = 覆盖当日数据，不会重复累计。收银日结单/外卖后台截图也可在「拍照/截图导入」里识别。',
    storeColumn: true,
    columns: [
      { key: 'store_name', header: '门店名称', store: true, note: '从下拉选择；填门店编码也可以' },
      { key: 'date', header: '日期', required: true, note: 'YYYY-MM-DD' },
      { key: 'revenue', header: '营收', required: true, note: '当日实收金额，元' },
      { key: 'orders', header: '订单数', note: '整数' },
      { key: 'avg_ticket', header: '客单价', note: '留空时按 营收/订单数 自动计算' },
      { key: 'delivery_revenue', header: '外卖营收', note: '元，可空' },
      { key: 'delivery_ratio', header: '外卖占比', note: '0-100 的百分数或 0-1 小数；留空时按外卖营收/营收计算' },
      { key: 'refunds', header: '退款', note: '元，可空' },
      { key: 'note', header: '备注' },
    ],
    samples: [
      ['万达店', '2026-09-01', 8650, 312, '', 3120, '', 86, '周一'],
      ['龙湖店', '2026-09-01', 6420, 240, '', 2900, '', 0, ''],
    ],
  },
  {
    key: 'costs',
    target: 'costs',
    label: '成本（按店按月）',
    sheet: '成本按店按月',
    description: '一行 = 一家店一个月的一个成本类别（食材/人力/房租/水电/营销/其他）。同店同月同类别再次导入 = 覆盖金额。',
    storeColumn: true,
    columns: [
      { key: 'store_name', header: '门店名称', store: true, note: '从下拉选择；填门店编码也可以' },
      { key: 'month', header: '月份', required: true, note: 'YYYY-MM，例：2026-08' },
      { key: 'category', header: '成本类别', required: true, enum: COST_TEMPLATE_CATEGORIES, note: '食材/人力/房租/水电/营销/其他（人工=人力，租金=房租）' },
      { key: 'amount', header: '金额', required: true, note: '数字，元' },
      { key: 'note', header: '备注' },
    ],
    samples: [
      ['万达店', '2026-08', '食材', 86500, ''],
      ['万达店', '2026-08', '人力', 52000, '含社保'],
      ['万达店', '2026-08', '房租', 30000, ''],
      ['万达店', '2026-08', '水电', 6800, ''],
      ['万达店', '2026-08', '其他', 2400, '耗材'],
    ],
  },
  {
    key: 'staff_stores',
    target: 'staff_stores',
    label: '员工与门店归属',
    sheet: '员工门店归属',
    description: '把已有员工账号归属到门店（只改归属，不新建账号）。账号或姓名至少填一个；姓名重名时必须填账号。',
    storeColumn: true,
    columns: [
      { key: 'account', header: '登录账号', note: '员工登录用的用户名，优先按它匹配' },
      { key: 'name', header: '姓名', note: '账号留空时按姓名匹配（重名会提示）' },
      { key: 'phone', header: '手机号' },
      { key: 'store_name', header: '门店名称', store: true, required: true, note: '从下拉选择；填门店编码也可以' },
    ],
    samples: [
      ['zhangsan', '张三', '13800000001', '万达店'],
      ['', '李四', '', '龙湖店'],
    ],
  },
  {
    key: 'reviews',
    target: 'reviews',
    label: '评价导入',
    sheet: '评价导入',
    description: '平台好评差评台账。同平台+同日期+同内容视为同一条，不会重复入库。',
    storeColumn: true,
    columns: [
      { key: 'store_name', header: '门店名称', store: true, note: '从下拉选择；填门店编码也可以' },
      { key: 'platform', header: '平台', enum: REVIEW_PLATFORMS, note: '美团/饿了么/大众点评/抖音/其他' },
      { key: 'rating', header: '评分', required: true, note: '1-5 的整数' },
      { key: 'content', header: '评价内容', required: true },
      { key: 'author', header: '评价人' },
      { key: 'review_date', header: '评价日期', note: 'YYYY-MM-DD' },
    ],
    samples: [
      ['万达店', '美团', 5, '牛肉给得足，汤很鲜', '匿名用户', '2026-08-30'],
      ['龙湖店', '饿了么', 2, '等了快一个小时才送到，面都坨了', '小王', '2026-08-31'],
    ],
  },
]);

export const TEMPLATE_BY_KEY = new Map(IMPORT_TEMPLATES.map(item => [item.key, item]));

export function templateCatalog() {
  return IMPORT_TEMPLATES.map(item => ({
    key: item.key,
    target: item.target,
    label: item.label,
    sheet: item.sheet,
    description: item.description,
    storeColumn: Boolean(item.storeColumn),
    columns: item.columns.map(column => ({
      key: column.key,
      header: column.header,
      required: Boolean(column.required),
      note: column.note || '',
      options: column.enum ? [...column.enum] : column.store ? 'stores' : null,
    })),
    downloadPath: `/api/data-intake/templates/${item.key}.xlsx`,
  }));
}

const columnLetter = index => {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

const safeSheetName = value => String(value || 'Sheet1').replace(/[\\/*?:[\]]/g, ' ').slice(0, 28);
const VALIDATION_ROWS = 2000;

// Excel 列表校验的公式字面量上限 255 字符；门店多时改用隐藏「门店列表」sheet 的区域引用。
function storeListFormula(names, listSheetName) {
  const inline = `"${names.join(',')}"`;
  if (names.length && inline.length <= 250 && !names.some(name => /[,"]/.test(name))) return inline;
  return `'${listSheetName}'!$A$2:$A$${names.length + 1}`;
}

/**
 * 生成模板工作簿。
 * @param {string} key 模板 key
 * @param {{name:string,code?:string|null}[]} stores 本租户门店（用于下拉）
 * @returns {Promise<Buffer>}
 */
export async function buildTemplateWorkbook(key, stores = []) {
  const template = TEMPLATE_BY_KEY.get(String(key || ''));
  if (!template) throw Object.assign(new Error('模板不存在'), { status: 404 });
  const storeNames = [...new Set((Array.isArray(stores) ? stores : []).map(store => String(store?.name || '').trim()).filter(Boolean))];

  const wb = new ExcelJS.Workbook();
  wb.creator = '纳米Work行业版';
  wb.created = new Date();

  const notes = wb.addWorksheet('填写说明');
  notes.columns = [
    { header: '列名', key: 'header', width: 16 },
    { header: '是否必填', key: 'required', width: 10 },
    { header: '填写要求', key: 'note', width: 60 },
  ];
  notes.addRow({ header: `【${template.label}】`, required: '', note: template.description });
  notes.addRow({ header: '通用', required: '', note: '第一行是表头请勿改动；示例行请删掉或改成真实数据；日期用 YYYY-MM-DD；金额只填数字。' });
  if (template.storeColumn) {
    notes.addRow({
      header: '门店名称',
      required: '',
      note: storeNames.length
        ? `已按你企业现有 ${storeNames.length} 家门店生成下拉：${storeNames.slice(0, 12).join('、')}${storeNames.length > 12 ? ' …' : ''}。填了系统里没有的门店名，导入预览会标红并让你选择「新建门店」或「改为默认店」，不会悄悄归到别的店。`
        : '你的企业还没有门店档案，请先导入「门店清单」或在预览时选择「新建门店」。',
    });
  }
  for (const column of template.columns) {
    notes.addRow({ header: column.header, required: column.required ? '必填' : '选填', note: column.note || '' });
  }
  notes.getRow(1).font = { bold: true };
  notes.getColumn('note').alignment = { wrapText: true, vertical: 'top' };

  const ws = wb.addWorksheet(safeSheetName(template.sheet), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = template.columns.map(column => ({
    header: column.header,
    key: column.key,
    width: Math.max(12, Math.min(40, column.header.length * 2 + 8)),
  }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF1FF' } };
  for (const sample of template.samples) ws.addRow(sample);
  const sampleFont = { italic: true, color: { argb: 'FF8B949E' } };
  for (let index = 0; index < template.samples.length; index++) ws.getRow(index + 2).font = sampleFont;

  let listSheet = null;
  template.columns.forEach((column, index) => {
    const letter = columnLetter(index);
    if (column.store && storeNames.length) {
      if (!listSheet) {
        listSheet = wb.addWorksheet('门店列表', { state: 'veryHidden' });
        listSheet.addRow(['门店名称']);
        for (const name of storeNames) listSheet.addRow([name]);
      }
      const formula = storeListFormula(storeNames, '门店列表');
      for (let row = 2; row <= VALIDATION_ROWS; row++) {
        ws.getCell(`${letter}${row}`).dataValidation = {
          type: 'list',
          allowBlank: !column.required,
          formulae: [formula],
          showErrorMessage: true,
          errorStyle: 'warning',
          errorTitle: '门店不在清单中',
          error: '系统里没有这家门店。仍可填写，导入预览时会让你选择新建门店或改为默认店。',
        };
      }
    } else if (column.enum) {
      for (let row = 2; row <= VALIDATION_ROWS; row++) {
        ws.getCell(`${letter}${row}`).dataValidation = {
          type: 'list',
          allowBlank: !column.required,
          formulae: [`"${column.enum.join(',')}"`],
          showErrorMessage: true,
          errorTitle: '取值不在范围内',
          error: `只能填：${column.enum.join('/')}`,
        };
      }
    }
    if (column.note) {
      ws.getCell(`${letter}1`).note = `${column.required ? '【必填】' : '【选填】'}${column.note}`;
    }
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function templateFileName(key) {
  const template = TEMPLATE_BY_KEY.get(String(key || ''));
  return `纳米Work_${template?.label || key}_导入模板.xlsx`;
}
