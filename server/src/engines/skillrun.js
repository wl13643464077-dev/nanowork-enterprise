// ===== 脚本技能：把员工产出的 Markdown 渲染成真实 Office 文件（可下载）=====
import { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType } from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BUNDLED_PDF_FONT = require.resolve('@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff2');

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
  const blocks = parseMd(md);
  const HEADS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];
  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  for (const bk of blocks) {
    if (bk.type === 'heading') children.push(new Paragraph({ text: bk.text, heading: HEADS[Math.min(bk.level - 1, 3)] }));
    else if (bk.type === 'bullet') children.push(new Paragraph({ text: bk.text, bullet: { level: 0 } }));
    else if (bk.type === 'table') {
      const rows = bk.rows.map((r, ri) => new TableRow({
        children: r.map(c => new TableCell({
          width: { size: Math.floor(100 / r.length), type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: [new TextRun({ text: c, bold: ri === 0 })] })],
        })),
      }));
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
      children.push(new Paragraph({ text: '' }));
    } else children.push(new Paragraph({ text: bk.text }));
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export async function mdToXlsx(md, title = '表格') {
  const blocks = parseMd(md);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet((title || 'Sheet1').slice(0, 28).replace(/[\\/*?:[\]]/g, ' '));
  const tables = blocks.filter(b => b.type === 'table');
  if (tables.length) {
    for (const tb of tables) {
      tb.rows.forEach((r, ri) => { const row = ws.addRow(r); if (ri === 0) row.font = { bold: true }; });
      ws.addRow([]);
    }
    let maxC = 1; tables.forEach(t => t.rows.forEach(r => { maxC = Math.max(maxC, r.length); }));
    for (let c = 1; c <= maxC; c++) ws.getColumn(c).width = 22;
  } else {
    blocks.forEach(b => ws.addRow([b.text || '']));
    ws.getColumn(1).width = 60;
  }
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

export function resolvePdfFontPath() {
  const candidates = [
    process.env.PDF_FONT_PATH ? { path: process.env.PDF_FONT_PATH } : null,
    { path: BUNDLED_PDF_FONT },
    { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.otf' },
    { path: '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttf' },
    { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'NotoSansCJKsc-Regular' },
    { path: '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', family: 'WenQuanYiZenHei' },
    { path: '/System/Library/Fonts/Supplemental/Arial Unicode.ttf' },
    { path: '/System/Library/Fonts/STHeiti Medium.ttc', family: 'STHeitiSC-Medium' },
  ].filter(Boolean);
  const font = candidates.find(item => fs.existsSync(item.path));
  if (!font) throw new Error('缺少可用的中文 PDF 字体，请重新安装服务端依赖或设置 PDF_FONT_PATH');
  return font;
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
    doc.fillColor(ink).fontSize(22).text(String(title || '报告'), { lineGap: 4 });
    doc.moveDown(0.3).strokeColor(gold).lineWidth(2).moveTo(52, doc.y).lineTo(150, doc.y).stroke();
    doc.moveDown(1);

    for (const block of parseMd(md)) {
      if (block.type === 'heading') {
        doc.moveDown(block.level === 1 ? 0.8 : 0.45).fillColor(ink)
          .fontSize(block.level === 1 ? 18 : block.level === 2 ? 15 : 12.5)
          .text(block.text, { lineGap: 3 });
      } else if (block.type === 'bullet') {
        doc.fillColor(ink).fontSize(10.5).text(`• ${block.text}`, { indent: 12, lineGap: 4 });
      } else if (block.type === 'table') {
        block.rows.forEach((row, index) => {
          doc.fillColor(index === 0 ? ink : muted).fontSize(index === 0 ? 10.5 : 9.5)
            .text(row.join('  |  '), { lineGap: 3 });
          doc.strokeColor('#d8cebb').lineWidth(0.5).moveTo(52, doc.y + 1).lineTo(543, doc.y + 1).stroke();
          doc.moveDown(0.25);
        });
        doc.moveDown(0.35);
      } else {
        doc.fillColor(ink).fontSize(10.5).text(block.text, { lineGap: 5 });
        doc.moveDown(0.35);
      }
    }
    doc.moveDown(1).fillColor(muted).fontSize(8.5).text(`由纳米Work行业版 生成 · ${new Date().toLocaleString('zh-CN')}`, { align: 'right' });
    doc.end();
  });
}

// 文件类技能：key → 渲染器（对应 skills.js 的 docx/xlsx/pptx/pdf）
export const FILE_SKILLS = {
  docx: { ext: 'docx', label: 'Word', fn: mdToDocx },
  xlsx: { ext: 'xlsx', label: 'Excel', fn: mdToXlsx },
  pptx: { ext: 'pptx', label: 'PPT', fn: mdToPptx },
  pdf: { ext: 'pdf', label: 'PDF', fn: mdToPdf },
};
export const FILE_SKILL_KEYS = Object.keys(FILE_SKILLS);
