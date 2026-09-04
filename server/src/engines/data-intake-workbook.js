// 服务端读取已上传的 xlsx/csv 为「工作表数组」（与前端 SheetJS 解析结果同构：rows[0] 是表头）。
// 用于开店向导等没有浏览器解析环节的场景；前端上传 Excel 仍由浏览器解析后回传。
import ExcelJS from 'exceljs';

const MAX_SHEETS = 10;
const MAX_ROWS = 5001; // 含表头

function cellValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const y = value.getUTCFullYear(); const m = String(value.getUTCMonth() + 1).padStart(2, '0'); const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('');
    if (value.result !== undefined) return cellValue(value.result);
    if (value.text !== undefined) return String(value.text);
    if (value.hyperlink !== undefined) return String(value.text || value.hyperlink);
    return '';
  }
  return value;
}

function parseCsvLine(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; } else if (ch === '"') quoted = false; else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(current); current = ''; } else current += ch;
  }
  out.push(current);
  return out.map(cell => cell.trim());
}

export function sheetsFromCsv(text, name = 'Sheet1') {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  const rows = lines.slice(0, MAX_ROWS).map(parseCsvLine);
  return rows.length ? [{ name, rows }] : [];
}

export async function sheetsFromXlsx(buffer, name = '') {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheets = [];
  for (const ws of wb.worksheets) {
    if (ws.state && ws.state !== 'visible') continue; // 隐藏的下拉源等辅助 sheet
    const rows = [];
    ws.eachRow({ includeEmpty: false }, row => {
      if (rows.length >= MAX_ROWS) return;
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(values.map(cellValue));
    });
    if (rows.length) sheets.push({ name: name ? `${name} / ${ws.name}` : ws.name, rows });
    if (sheets.length >= MAX_SHEETS) break;
  }
  return sheets;
}

export async function sheetsFromBuffer(buffer, ext, name = '') {
  const lower = String(ext || '').toLowerCase();
  if (lower === 'csv' || lower === 'tsv' || lower === 'txt') {
    const text = buffer.toString('utf8');
    return sheetsFromCsv(lower === 'tsv' ? text.replace(/\t/g, ',') : text, name || 'CSV');
  }
  if (lower === 'xlsx' || lower === 'xlsm') return sheetsFromXlsx(buffer, name);
  throw Object.assign(new Error(`暂不支持在服务端解析 .${lower} 文件，请另存为 .xlsx 或 .csv`), { status: 400 });
}
