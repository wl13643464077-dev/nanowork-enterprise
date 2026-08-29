// ===== 脚本技能：把员工产出的 Markdown 渲染成真实 Office 文件（可下载）=====
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import PDFDocument from 'pdfkit';
import * as fontkit from 'fontkit';
import fs from 'node:fs';
import path from 'node:path';
import { DOCX_RENDER_VERSION, renderMarkdownDocx } from './docx-report-renderer.js';

const strip = (s = '') => s.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').replace(/`(.*?)`/g, '$1').trim();

// 行级 Markdown 解析 → 结构块
function parseMd(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const blocks = []; let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { i++; continue; }
    if (/^\|.*\|$/.test(t)) {
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        rows.push(lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => strip(c))); i++;
      }
      const clean = rows.filter(r => !r.every(c => /^:?-{2,}:?$/.test(c) || c === ''));
      if (clean.length) blocks.push({ type: 'table', rows: clean });
      continue;
    }
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) { blocks.push({ type: 'heading', level: h[1].length, text: strip(h[2]) }); i++; continue; }
    const b = t.match(/^[-*+]\s+(.*)$/);
    if (b) { blocks.push({ type: 'bullet', text: strip(b[1]) }); i++; continue; }
    const n = t.match(/^\d+[.)]\s+(.*)$/);
    if (n) { blocks.push({ type: 'bullet', text: strip(n[1]) }); i++; continue; }
    blocks.push({ type: 'para', text: strip(t) }); i++;
  }
  return blocks;
}

export async function mdToDocx(md, title = '文档') {
  return renderMarkdownDocx(md, title);
}

export const XLSX_RENDER_VERSION = 'xlsx-layout/3';
const XLSX_CJK_FONT = 'Arial Unicode MS';

const XLSX_COL_PROFILES = Object.freeze({
  1: [[32, 105]],
  2: [[18, 30], [34, 78]],
  3: [[18, 27], [18, 30], [34, 62]],
  4: [[16, 22], [22, 34], [18, 26], [28, 44]],
});

function xlsxVisualLength(value) {
  return [...String(value || '')].reduce((total, char) =>
    total + (/[^\u0000-\u00ff]/u.test(char) ? 2 : 1), 0);
}

function xlsxColumnWidths(tables, maxColumns) {
  const fallbackProfile = Array.from({ length: maxColumns }, () => [14, 26]);
  const profile = XLSX_COL_PROFILES[maxColumns] || fallbackProfile;
  return profile.map(([minimum, maximum], index) => {
    let observed = minimum;
    for (const table of tables) {
      for (const row of table.rows) {
        observed = Math.max(observed, xlsxVisualLength(row[index]) + 2);
      }
    }
    return Math.min(maximum, Math.max(minimum, observed));
  });
}

function xlsxWrappedLineCount(value, width) {
  const source = String(value || '');
  if (!source) return 1;
  return source.split('\n').reduce((total, line) =>
    total + Math.max(1, Math.ceil(xlsxVisualLength(line) / Math.max(8, width - 2))), 0);
}

function xlsxRowHeight(values, widths, { minimum = 20, maximum = 400 } = {}) {
  const lines = values.reduce((largest, value, index) =>
    Math.max(largest, xlsxWrappedLineCount(value, widths[index] || widths.at(-1) || 24)), 1);
  return Math.min(maximum, Math.max(minimum, 7 + lines * 15));
}

function xlsxBorder(color = 'D8E0E8') {
  const edge = { style: 'thin', color: { argb: color } };
  return { top: edge, left: edge, bottom: edge, right: edge };
}

export async function mdToXlsx(md, title = '表格') {
  const parsedBlocks = parseMd(md);
  const blocks = parsedBlocks.length
    ? parsedBlocks
    : [{ type: 'para', text: String(md || '').trim() }];
  const tables = blocks.filter(block => block.type === 'table');
  const maxColumns = Math.max(
    1,
    ...tables.flatMap(table => table.rows.map(row => row.length)),
  );
  const widths = xlsxColumnWidths(tables, maxColumns);
  const wb = new ExcelJS.Workbook();
  wb.creator = '纳米Work行业版';
  wb.subject = '数字员工交付报告';
  wb.title = String(title || '表格');
  wb.created = new Date(0);
  wb.modified = new Date(0);
  const ws = wb.addWorksheet((title || 'Sheet1').slice(0, 28).replace(/[\\/*?:[\]]/g, ' '), {
    properties: {
      defaultRowHeight: 20,
      pageSetUpPr: { fitToPage: true, autoPageBreaks: false },
    },
  });
  widths.forEach((width, index) => {
    ws.getColumn(index + 1).width = width;
  });

  const colors = {
    navy: '17365D',
    blue: '1F4E78',
    paleBlue: 'DCE6F1',
    paleGray: 'F4F6F8',
    white: 'FFFFFF',
    ink: '1F2937',
    muted: '52606D',
  };
  const tableRanges = [];
  const mergeTextRow = (value, style = {}) => {
    const text = String(value || '');
    const row = ws.addRow([text]);
    if (maxColumns > 1) ws.mergeCells(row.number, 1, row.number, maxColumns);
    const cell = row.getCell(1);
    cell.font = style.font || { name: XLSX_CJK_FONT, size: 10.5, color: { argb: colors.ink } };
    cell.fill = style.fill || { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.white } };
    cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true, ...(style.alignment || {}) };
    if (style.border) cell.border = style.border;
    row.height = style.height || xlsxRowHeight([text], [widths.reduce((sum, width) => sum + width, 0)], {
      minimum: style.minimumHeight || 22,
    });
    return row;
  };
  const addSpacer = () => {
    const row = ws.addRow([]);
    row.height = 7;
  };

  if (blocks[0]?.type !== 'heading' && String(title || '').trim()) {
    blocks.unshift({ type: 'heading', level: 1, text: String(title).trim() });
  }

  blocks.forEach((block, blockIndex) => {
    if (block.type === 'heading') {
      if (ws.lastRow && ws.lastRow.values.some(Boolean)) addSpacer();
      const level = Math.min(Math.max(Number(block.level) || 1, 1), 4);
      mergeTextRow(block.text, level === 1
        ? {
            font: { name: XLSX_CJK_FONT, size: 18, bold: true, color: { argb: colors.white } },
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.navy } },
            minimumHeight: 34,
          }
        : {
            font: { name: XLSX_CJK_FONT, size: level === 2 ? 13 : 11, bold: true, color: { argb: colors.navy } },
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: level === 2 ? colors.paleBlue : colors.paleGray } },
            border: xlsxBorder('B4C7DC'),
            minimumHeight: level === 2 ? 28 : 24,
          });
      return;
    }

    if (block.type === 'table') {
      const startRow = ws.rowCount + 1;
      const tableColumns = Math.max(1, ...block.rows.map(values => values.length));
      const tableWidths = Array.from({ length: tableColumns }, (_, index) =>
        index === tableColumns - 1
          ? widths.slice(index).reduce((sum, width) => sum + width, 0)
          : widths[index]);
      block.rows.forEach((values, rowIndex) => {
        const normalized = Array.from({ length: maxColumns }, (_, index) => String(values[index] || ''));
        const row = ws.addRow(normalized);
        if (tableColumns < maxColumns)
          ws.mergeCells(row.number, tableColumns, row.number, maxColumns);
        row.height = xlsxRowHeight(normalized.slice(0, tableColumns), tableWidths, {
          minimum: rowIndex === 0 ? 27 : 22,
        });
        for (let column = 1; column <= maxColumns; column += 1) {
          const cell = row.getCell(column);
          cell.font = {
            name: XLSX_CJK_FONT,
            size: rowIndex === 0 ? 10.5 : 10,
            bold: rowIndex === 0,
            color: { argb: rowIndex === 0 ? colors.white : colors.ink },
          };
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: {
              argb: rowIndex === 0
                ? colors.blue
                : rowIndex % 2 === 0
                  ? colors.paleGray
                  : colors.white,
            },
          };
          cell.border = xlsxBorder();
          cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
        }
      });
      tableRanges.push({ startRow, endRow: ws.rowCount });
      if (blockIndex < blocks.length - 1) addSpacer();
      return;
    }

    const isQuote = block.type === 'para' && /^>\s*/u.test(block.text || '');
    const text = block.type === 'bullet'
      ? `• ${block.text}`
      : String(block.text || '').replace(/^>\s*/u, '');
    mergeTextRow(text, isQuote
      ? {
          font: { name: XLSX_CJK_FONT, size: 10, italic: true, color: { argb: colors.muted } },
          fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.paleGray } },
          border: xlsxBorder('D8E0E8'),
        }
      : undefined);
  });

  while (ws.lastRow && ws.lastRow.values.every(value => !value)) {
    ws.spliceRows(ws.lastRow.number, 1);
  }
  // actualRowCount 只统计非空行数量；报告内部有分节留白，打印区域必须使用
  // 最后一个真实行号，否则尾部表格会被错误截掉。
  const lastRow = Math.max(1, ws.lastRow?.number || 1);
  const lastColumn = ws.getColumn(maxColumns).letter;
  const singleTable = tableRanges.length === 1 ? tableRanges[0] : null;
  const frozenRows = singleTable ? singleTable.startRow : 1;
  ws.views = [{
    state: 'frozen',
    ySplit: frozenRows,
    activeCell: `A${Math.min(lastRow, frozenRows + 1)}`,
    showGridLines: false,
  }];
  if (singleTable) {
    ws.autoFilter = {
      from: { row: singleTable.startRow, column: 1 },
      to: { row: singleTable.endRow, column: maxColumns },
    };
  }
  ws.pageSetup = {
    paperSize: 9,
    orientation: maxColumns >= 3 ? 'landscape' : 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: false,
    verticalCentered: false,
    printArea: `A1:${lastColumn}${lastRow}`,
    margins: {
      left: 0.35,
      right: 0.35,
      top: 0.55,
      bottom: 0.55,
      header: 0.2,
      footer: 0.25,
    },
  };
  ws.headerFooter.oddFooter = '&L纳米Work行业版&C第 &P / &N 页&R数字员工交付报告';
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function mdToPptx(md, title = '演示') {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = '纳米Work行业版';
  pptx.subject = title;
  pptx.title = title;
  pptx.theme = { headFontFace: 'PingFang SC', bodyFontFace: 'PingFang SC', lang: 'zh-CN' };

  const colors = {
    ink: '171719',
    bg: 'F7F4EC',
    white: 'FFFFFF',
    gold: 'B88A3B',
    gold2: 'DAB369',
    blue: '2E5B72',
    muted: '68645C',
    line: 'D8CEBB',
  };

  const splitSections = () => {
    const raw = String(md || '').replace(/\r/g, '').trim();
    let parts = raw.split(/\n\s*---+\s*\n/g).map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) return parts;
    parts = [];
    let cur = [];
    for (const line of raw.split('\n')) {
      if (/^#{1,2}\s+/.test(line.trim()) && cur.length) {
        parts.push(cur.join('\n').trim());
        cur = [line];
      } else cur.push(line);
    }
    if (cur.join('').trim()) parts.push(cur.join('\n').trim());
    return parts.filter(Boolean);
  };

  const sections = splitSections().slice(0, 12);
  const fallbackSections = sections.length ? sections : [`# ${title}\n- 请补充演示内容`];

  const footer = (slide, page) => {
    slide.addShape(pptx.ShapeType.line, { x: 0.55, y: 6.92, w: 12.25, h: 0, line: { color: colors.line, width: 1 } });
    slide.addText('纳米Work行业版', { x: 0.6, y: 7.05, w: 2.2, h: 0.18, fontSize: 8.5, color: colors.muted, margin: 0 });
    slide.addText(String(page).padStart(2, '0'), { x: 12.22, y: 7.02, w: 0.5, h: 0.2, fontSize: 9, bold: true, color: colors.gold, align: 'right', margin: 0 });
  };
  const linesFromBlocks = (blocks) => {
    const out = [];
    for (const bk of blocks) {
      if (bk.type === 'bullet') out.push(bk.text);
      else if (bk.type === 'para' && bk.text.length <= 90) out.push(bk.text);
      else if (bk.type === 'table') {
        for (const row of bk.rows.slice(0, 4)) out.push(row.slice(0, 3).join('  /  '));
      }
    }
    return out.filter(Boolean).slice(0, 7);
  };

  fallbackSections.forEach((section, idx) => {
    const blocks = parseMd(section);
    const headingIndex = blocks.findIndex(b => b.type === 'heading');
    const slideTitle = headingIndex >= 0 ? blocks[headingIndex].text : (idx === 0 ? title : `第${idx + 1}页`);
    const bodyBlocks = blocks.filter((_, i) => i !== headingIndex && blocks[i].type !== 'heading');
    const lines = linesFromBlocks(bodyBlocks);

    const sl = pptx.addSlide();
    if (idx === 0) {
      sl.background = { color: colors.ink };
      sl.addText(slideTitle || title, { x: 0.8, y: 1.55, w: 7.2, h: 1.05, fontSize: 38, bold: true, color: colors.white, margin: 0, fit: 'shrink' });
      sl.addShape(pptx.ShapeType.line, { x: 0.82, y: 2.86, w: 1.7, h: 0, line: { color: colors.gold, width: 3 } });
      if (lines.length) {
        sl.addText(lines.slice(0, 4).join(' / '), { x: 0.82, y: 3.25, w: 7.2, h: 0.75, fontSize: 15, color: colors.gold2, margin: 0, fit: 'shrink' });
      }
      sl.addShape(pptx.ShapeType.arc, { x: 8.55, y: -0.6, w: 5.0, h: 5.0, adjustPoint: 0.35, line: { color: colors.gold, transparency: 35, width: 1.1 }, fill: { color: colors.ink, transparency: 100 } });
      sl.addText('纳米Work行业版', { x: 0.84, y: 6.78, w: 2.4, h: 0.2, fontSize: 9, color: 'A8A296', margin: 0 });
      return;
    }

    sl.background = { color: colors.bg };
    sl.addText(slideTitle || title, { x: 0.65, y: 0.45, w: 10.4, h: 0.52, fontSize: 25, bold: true, color: colors.ink, margin: 0, fit: 'shrink' });
    sl.addShape(pptx.ShapeType.line, { x: 0.65, y: 1.16, w: 1.75, h: 0, line: { color: colors.gold, width: 2.2 } });
    if (lines.length) {
      sl.addText(lines.map(t => ({ text: t, options: { bullet: { indent: 12 }, hanging: 4, breakLine: true } })), {
        x: 0.82, y: 1.65, w: 6.15, h: 4.95,
        fontSize: lines.length > 5 ? 13.5 : 15,
        color: colors.ink,
        breakLine: false,
        fit: 'shrink',
        paraSpaceAfterPt: 8,
        margin: 0.04,
      });
    }
    const boxX = 7.55;
    sl.addShape(pptx.ShapeType.roundRect, { x: boxX, y: 1.7, w: 4.65, h: 3.9, rectRadius: 0.08, fill: { color: colors.white }, line: { color: colors.line, width: 1 } });
    sl.addShape(pptx.ShapeType.rect, { x: boxX, y: 1.7, w: 0.1, h: 3.9, fill: { color: idx % 2 ? colors.gold : colors.blue }, line: { color: idx % 2 ? colors.gold : colors.blue, transparency: 100 } });
    sl.addText('本页主观点', { x: boxX + 0.28, y: 2.02, w: 3.8, h: 0.3, fontSize: 14, bold: true, color: colors.ink, margin: 0 });
    sl.addText(lines[0] || slideTitle || title, { x: boxX + 0.28, y: 2.55, w: 3.9, h: 1.35, fontSize: 18, bold: true, color: colors.blue, margin: 0, fit: 'shrink' });
    sl.addText('保持一页一个判断，便于老板汇报和团队执行。', { x: boxX + 0.28, y: 4.35, w: 3.8, h: 0.55, fontSize: 11, color: colors.muted, margin: 0, fit: 'shrink' });
    footer(sl, idx + 1);
  });

  if (!fallbackSections.length) {
    const sl = pptx.addSlide();
    sl.background = { color: colors.ink };
    sl.addText(title, { x: 0.5, y: 2.3, w: 9, h: 1.3, fontSize: 34, bold: true, color: colors.gold2, align: 'center' });
  }
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
}

const PDF_FONT_EXTENSIONS = new Set(['.ttf', '.otf']);
const PDF_FONT_SIGNATURES = new Set(['00010000', '4f54544f', '74727565', '74797031']);
const PDF_FONT_CJK_PROBE = '中文报告餐饮经营数据';

function inspectPdfFontCandidate(candidatePath, source) {
  const rawPath = String(candidatePath || '').trim();
  if (!rawPath) return { valid: false, reason: '路径为空' };
  const resolvedPath = path.resolve(rawPath);
  const extension = path.extname(resolvedPath).toLowerCase();
  if (!PDF_FONT_EXTENSIONS.has(extension)) {
    return { valid: false, reason: `不支持 ${extension || '无扩展名'}；仅支持可嵌入的 TTF/OTF` };
  }

  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return { valid: false, reason: '文件不存在或不可访问' };
  }
  if (!stat.isFile()) return { valid: false, reason: '路径不是字体文件' };

  let signature;
  try {
    const fd = fs.openSync(resolvedPath, 'r');
    try {
      const header = Buffer.alloc(4);
      if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) {
        return { valid: false, reason: '字体文件头不完整' };
      }
      signature = header.toString('hex');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { valid: false, reason: '字体文件不可读取' };
  }
  if (!PDF_FONT_SIGNATURES.has(signature)) {
    return { valid: false, reason: '文件不是标准 TrueType/OpenType 字体' };
  }

  let font;
  try {
    font = fontkit.openSync(resolvedPath);
  } catch {
    return { valid: false, reason: '字体解析失败，无法由 PDF 生成器可靠嵌入' };
  }
  const missingGlyph = [...PDF_FONT_CJK_PROBE].find(char => !font.hasGlyphForCodePoint(char.codePointAt(0)));
  if (missingGlyph) return { valid: false, reason: `缺少中文字符“${missingGlyph}”的字形` };

  return {
    valid: true,
    font: {
      path: resolvedPath,
      format: extension.slice(1),
      source,
      postscriptName: font.postscriptName || font.fullName || null,
    },
  };
}

export function resolvePdfFontPath() {
  const configuredPath = String(process.env.PDF_FONT_PATH || '').trim();
  if (configuredPath) {
    const configured = inspectPdfFontCandidate(configuredPath, 'configured');
    if (!configured.valid) {
      throw new Error(`PDF_FONT_PATH 无法用于中文 PDF：${configured.reason}（${configuredPath}）`);
    }
    return configured.font;
  }

  const windowsRoot = String(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows').trim();
  const candidates = [
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/Library/Fonts/Arial Unicode.ttf',
    '/Library/Fonts/Arial Unicode MS.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.otf',
    '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttf',
    '/usr/local/share/fonts/NotoSansCJK-Regular.otf',
    path.join(windowsRoot, 'Fonts', 'simhei.ttf'),
  ];
  for (const candidatePath of candidates) {
    const candidate = inspectPdfFontCandidate(candidatePath, 'system');
    if (candidate.valid) return candidate.font;
  }

  throw new Error('缺少可可靠嵌入的中文 PDF 字体；请安装 TTF/OTF 中文字体或设置 PDF_FONT_PATH（不支持 WOFF/WOFF2/TTC）');
}

// PDF 表格逐列真实排版所需的常量：A4 内容区 52..543pt。
const PDF_PAGE_LEFT = 52;
const PDF_PAGE_RIGHT = 543;
const PDF_PAGE_BOTTOM = 788;

function pdfVisualLength(value) {
  return [...String(value || '')].reduce((total, char) =>
    total + (/[^\u0000-\u00ff]/u.test(char) ? 2 : 1), 0);
}

// 按内容比例分配列宽：窄列（日期/状态）不再被均分浪费，长文本列拿到大头。
function pdfColumnWidths(rows, columnCount, totalWidth) {
  const observed = Array.from({ length: columnCount }, () => 6);
  for (const row of rows) {
    for (let index = 0; index < columnCount; index += 1) {
      observed[index] = Math.max(
        observed[index],
        Math.min(46, pdfVisualLength(row[index]) + 2),
      );
    }
  }
  const sum = observed.reduce((a, b) => a + b, 0);
  const minimum = 52;
  const raw = observed.map(width => Math.max(minimum, (width / sum) * totalWidth));
  const scale = totalWidth / raw.reduce((a, b) => a + b, 0);
  return raw.map(width => width * scale);
}

function pdfDrawTable(doc, rows, { ink, muted }) {
  const columnCount = Math.max(...rows.map(row => row.length));
  const gutter = 7;
  const totalWidth = PDF_PAGE_RIGHT - PDF_PAGE_LEFT - gutter * (columnCount - 1);
  const widths = pdfColumnWidths(rows, columnCount, totalWidth);
  const cellFont = index => (index === 0 ? 9.5 : 9);

  rows.forEach((row, rowIndex) => {
    doc.fontSize(cellFont(rowIndex));
    const heights = row.map((cell, column) =>
      doc.heightOfString(String(cell || ''), { width: widths[column], lineGap: 2 }));
    const rowHeight = Math.max(14, ...heights) + 8;
    if (doc.y + rowHeight > PDF_PAGE_BOTTOM) doc.addPage();
    const top = doc.y;
    if (rowIndex === 0) {
      doc.save().rect(PDF_PAGE_LEFT - 3, top - 3, PDF_PAGE_RIGHT - PDF_PAGE_LEFT + 6, rowHeight)
        .fill('#2e5b72').restore();
    } else if (rowIndex % 2 === 0) {
      doc.save().rect(PDF_PAGE_LEFT - 3, top - 3, PDF_PAGE_RIGHT - PDF_PAGE_LEFT + 6, rowHeight)
        .fill('#f5f7fa').restore();
    }
    let x = PDF_PAGE_LEFT;
    row.forEach((cell, column) => {
      doc.fillColor(rowIndex === 0 ? '#ffffff' : column === 0 ? ink : muted)
        .fontSize(cellFont(rowIndex))
        .text(String(cell || ''), x, top, { width: widths[column], lineGap: 2 });
      x += widths[column] + gutter;
    });
    doc.x = PDF_PAGE_LEFT;
    doc.y = top + rowHeight;
    doc.strokeColor('#d8cebb').lineWidth(0.5)
      .moveTo(PDF_PAGE_LEFT - 3, doc.y - 3).lineTo(PDF_PAGE_RIGHT + 3, doc.y - 3).stroke();
  });
  doc.moveDown(0.5);
}

export async function mdToPdf(md, title = '报告') {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 54, right: 52, bottom: 54, left: 52 }, info: { Title: title, Author: '纳米Work行业版' } });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const font = resolvePdfFontPath();
    doc.font(font.path, font.family);
    const gold = '#b88a3b';
    const ink = '#171719';
    const muted = '#68645c';

    // 列表任务标题被截断到100字，直接印在封面会拦腰断句；正文首个H1才是
    // 模型写的完整报告题目，优先用它，传入标题只进PDF元数据。
    const blocks = parseMd(md);
    const firstHeadingIndex = blocks.findIndex(block => block.type === 'heading');
    const coverTitle = firstHeadingIndex >= 0 && blocks[firstHeadingIndex].level === 1
      ? blocks[firstHeadingIndex].text
      : String(title || '报告');
    const bodyBlocks = firstHeadingIndex >= 0 && blocks[firstHeadingIndex].level === 1
      ? blocks.filter((_, index) => index !== firstHeadingIndex)
      : blocks;

    doc.fillColor(ink).fontSize(22).text(coverTitle, { lineGap: 4 });
    doc.moveDown(0.3).strokeColor(gold).lineWidth(2).moveTo(52, doc.y).lineTo(150, doc.y).stroke();

    // 调用方传入的任务标题保留成小字上下文行，让报告能对回派活任务；
    // 任务标题在库里本身按100字截断，句子没收尾时补省略号避免像排版事故。
    const taskTitle = String(title || '').trim();
    const genericTitles = new Set(['报告', '文档', '数字员工报告']);
    if (taskTitle && taskTitle !== coverTitle && !genericTitles.has(taskTitle)) {
      const looksTruncated = taskTitle.length >= 90 && !/[。！？.!?…）)】”"]$/u.test(taskTitle);
      doc.moveDown(0.5).fillColor(muted).fontSize(9.5)
        .text(`任务：${taskTitle}${looksTruncated ? '……' : ''}`, { lineGap: 3 });
    }
    doc.moveDown(1);

    for (const block of bodyBlocks) {
      if (block.type === 'heading') {
        doc.moveDown(block.level === 1 ? 0.8 : 0.45).fillColor(ink)
          .fontSize(block.level === 1 ? 18 : block.level === 2 ? 15 : 12.5)
          .text(block.text, { lineGap: 3 });
      } else if (block.type === 'bullet') {
        doc.fillColor(ink).fontSize(10.5).text(`• ${block.text}`, { indent: 12, lineGap: 4 });
      } else if (block.type === 'table') {
        pdfDrawTable(doc, block.rows, { ink, muted });
      } else {
        doc.fillColor(ink).fontSize(10.5).text(block.text, { lineGap: 5 });
        doc.moveDown(0.35);
      }
    }
    doc.moveDown(1).fillColor(muted).fontSize(8.5).text(`由纳米Work行业版 生成 · ${new Date().toLocaleString('zh-CN')}`, { align: 'right' });
    doc.end();
  });
}

// /2：表格改为按列宽真实排版（表头深底、隔行浅灰、跨页续排），封面标题
// 改用正文首个H1，不再印被截断的任务标题。
export const PDF_RENDER_VERSION = 'pdf-report-layout/2';

// 文件类技能：key → 渲染器（对应 skills.js 的 docx/xlsx/pptx/pdf）
export const FILE_SKILLS = {
  docx: { ext: 'docx', label: 'Word', fn: renderMarkdownDocx, renderVersion: DOCX_RENDER_VERSION },
  xlsx: { ext: 'xlsx', label: 'Excel', fn: mdToXlsx, renderVersion: XLSX_RENDER_VERSION },
  pptx: { ext: 'pptx', label: 'PPT', fn: mdToPptx },
  pdf: { ext: 'pdf', label: 'PDF', fn: mdToPdf, renderVersion: PDF_RENDER_VERSION },
};
export const FILE_SKILL_KEYS = Object.keys(FILE_SKILLS);
