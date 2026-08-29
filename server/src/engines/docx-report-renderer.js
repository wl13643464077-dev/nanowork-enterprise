import fs from "node:fs";
import path from "node:path";

import * as fontkit from "fontkit";
import JSZip from "jszip";
import subsetFont from "subset-font";
import {
  AlignmentType,
  BorderStyle,
  CharacterSet,
  Document,
  Footer,
  Header,
  LevelFormat,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  TabStopPosition,
  TabStopType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlignTable,
  WidthType,
} from "docx";

// /2：中文字体按文档字符子集化嵌入（15MB→数百KB）；封面标题改用正文首个
// H1，不再印被100字上限拦腰截断的任务标题。
export const DOCX_RENDER_VERSION = "docx-report-layout/2";
export const DOCX_CJK_FONT_FAMILY = "Arial Unicode MS";

// LibreOffice's OOXML reader intermittently rejects the random font keys
// emitted by docx, even though those packages decrypt to a valid TTF. A
// stable key makes the same embedded font deterministic across Word and the
// bundled headless LibreOffice used for previews. This is obfuscation, not a
// security key, so OOXML permits it to be reused between documents.
const LIBREOFFICE_FONT_KEY = "34ef3e0d-f556-fb84-37ac-32166042f660";

const A4_WIDTH = 11_906;
const A4_HEIGHT = 16_838;
const PAGE_MARGIN = 1_008;
const CONTENT_WIDTH = A4_WIDTH - PAGE_MARGIN * 2;

const COLOR = Object.freeze({
  ink: "1F2937",
  blue: "1F4E78",
  accent: "B5652A",
  muted: "667085",
  line: "CDD5DF",
  paleBlue: "EAF1F8",
  paleGold: "FBF4EA",
  paleGray: "F5F7FA",
  white: "FFFFFF",
});

let activeCjkFontFamily = DOCX_CJK_FONT_FAMILY;
const FONT = Object.freeze({
  get ascii() {
    return activeCjkFontFamily;
  },
  get hAnsi() {
    return activeCjkFontFamily;
  },
  get eastAsia() {
    return activeCjkFontFamily;
  },
  get cs() {
    return activeCjkFontFamily;
  },
  hint: "eastAsia",
});

const WORD_BORDER = Object.freeze({
  color: COLOR.line,
  size: 5,
  style: BorderStyle.SINGLE,
});

let embeddedCjkFont;

const DOCX_FONT_SIGNATURES = new Set(["00010000", "4f54544f", "74727565", "74797031"]);

function docxFontCandidates() {
  const windowsRoot = String(process.env.WINDIR || process.env.SystemRoot || "C:\\Windows").trim();
  return [
    process.env.DOCX_FONT_PATH,
    process.env.PDF_FONT_PATH,
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode MS.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.otf",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttf",
    "/usr/local/share/fonts/NotoSansCJK-Regular.otf",
    path.join(windowsRoot, "Fonts", "simhei.ttf"),
    path.join(windowsRoot, "Fonts", "msyh.ttc"),
  ].filter(Boolean);
}

function inspectFontCandidate(candidatePath) {
  const resolvedPath = path.resolve(String(candidatePath));
  const extension = path.extname(resolvedPath).toLowerCase();
  if (![".ttf", ".otf"].includes(extension)) return null;
  let data;
  try {
    data = fs.readFileSync(resolvedPath);
  } catch {
    return null;
  }
  if (data.length < 12 || !DOCX_FONT_SIGNATURES.has(data.subarray(0, 4).toString("hex"))) {
    return null;
  }

  let font;
  try {
    font = fontkit.create(data);
  } catch {
    return null;
  }
  const probe = "中文报告餐饮经营数据战略开店竞品商圈证据行动授权";
  if ([...probe].some((char) => !font.hasGlyphForCodePoint(char.codePointAt(0)))) return null;
  if (font["OS/2"]?.fsType?.noEmbedding || font["OS/2"]?.fsType?.bitmapOnly) return null;

  return {
    data,
    family: String(process.env.DOCX_FONT_FAMILY || "").trim()
      || font.familyName
      || font.fullName
      || DOCX_CJK_FONT_FAMILY,
    path: resolvedPath,
  };
}

function resolveEmbeddedCjkFont() {
  if (embeddedCjkFont) return embeddedCjkFont;
  const candidate = docxFontCandidates()
    .map(inspectFontCandidate)
    .find(Boolean);
  if (!candidate) {
    throw new Error(
      "缺少可嵌入的完整中文 DOCX 字体；请安装 TTF/OTF 中文字体或设置 DOCX_FONT_PATH（不支持 WOFF/WOFF2/TTC）",
    );
  }
  activeCjkFontFamily = candidate.family;
  embeddedCjkFont = Object.freeze({
    name: candidate.family,
    data: Buffer.from(candidate.data),
    path: candidate.path,
  });
  return embeddedCjkFont;
}

// 渲染器自身注入的固定文案 + 中文字形探针：这些字符不在正文里也必须进入
// 字体子集，否则页眉页脚、表格标题或嵌入校验会缺字形。
const DOCX_STATIC_TEXT_CORPUS = [
  "纳米Work行业版",
  "数字员工交付报告",
  "数字员工报告",
  "数据明细（长内容按字段展开）",
  "暂无正文内容。",
  "第 / 页",
  "·…—－", // 页眉分隔符与截断省略号
  "中文报告餐饮经营数据战略开店竞品商圈证据行动授权",
  "0123456789",
].join("");

// 整包内嵌完整CJK字体曾让单份Word报告膨胀到15MB（Arial Unicode约23MB）。
// 这里按“正文实际字符+固定文案+全部可见ASCII”做确定性子集，通常收敛到
// 几百KB，同时保留“无中文字体的机器也能正确显示”的原保证。
// 子集失败时回退整包字体：宁可文件大，绝不产出缺字形的报告。
async function subsetCjkFontForDocument(cjkFont, textCorpus) {
  const characters = new Set([...String(textCorpus || "")]);
  for (let code = 0x20; code <= 0x7e; code += 1)
    characters.add(String.fromCharCode(code));
  for (const char of DOCX_STATIC_TEXT_CORPUS) characters.add(char);
  try {
    const data = await subsetFont(cjkFont.data, [...characters].join(""), {
      targetFormat: "sfnt",
    });
    if (!data?.length || data.length >= cjkFont.data.length) return cjkFont;
    return { ...cjkFont, data: Buffer.from(data) };
  } catch (error) {
    console.warn(
      `[docx] 中文字体子集化失败，回退整包嵌入：${error?.message || error}`,
    );
    return cjkFont;
  }
}

function obfuscateOpenXmlFont(fontData, key = LIBREOFFICE_FONT_KEY) {
  const keyBytes = Buffer.from(key.replaceAll("-", ""), "hex").reverse();
  if (keyBytes.length !== 16) throw new Error("DOCX 字体混淆密钥必须是 16 字节 GUID");
  const obfuscated = Buffer.from(fontData);
  for (let index = 0; index < Math.min(32, obfuscated.length); index += 1) {
    obfuscated[index] ^= keyBytes[index % keyBytes.length];
  }
  return obfuscated;
}

async function stabilizeEmbeddedFontForLibreOffice(packedDocx, cjkFont) {
  const zip = await JSZip.loadAsync(packedDocx);
  const fontTableEntry = zip.file("word/fontTable.xml");
  if (!fontTableEntry) throw new Error("DOCX 缺少 word/fontTable.xml，无法校验中文字体嵌入");

  const fontTableXml = await fontTableEntry.async("string");
  const stabilizedFontTableXml = fontTableXml.replace(
    /w:fontKey="\{[^}]+\}"/gu,
    `w:fontKey="{${LIBREOFFICE_FONT_KEY}}"`,
  );
  if (stabilizedFontTableXml === fontTableXml) {
    throw new Error("DOCX fontTable 未声明可替换的嵌入字体密钥");
  }

  const embeddedFontEntries = Object.keys(zip.files)
    .filter((name) => /^word\/fonts\/[^/]+\.odttf$/u.test(name));
  if (embeddedFontEntries.length !== 1) {
    throw new Error(`DOCX 预期嵌入 1 个中文字体，实际为 ${embeddedFontEntries.length} 个`);
  }

  zip.file("word/fontTable.xml", stabilizedFontTableXml);
  zip.file(
    embeddedFontEntries[0],
    obfuscateOpenXmlFont(cjkFont.data),
    { binary: true },
  );
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

function cleanText(value = "") {
  return String(value)
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/&nbsp;/giu, " ")
    .replace(/\\([\\`*{}\[\]()#+.!_>|-])/gu, "$1")
    .trim();
}

function plainText(value = "") {
  return cleanText(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, "$1（$2）")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\*([^*]+)\*/gu, "$1")
    .replace(/_([^_]+)_/gu, "$1")
    .trim();
}

function inlineRuns(value, base = {}) {
  const source = cleanText(value);
  const runs = [];
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/gu;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) {
      runs.push(new TextRun({ text: source.slice(cursor, match.index), font: FONT, ...base }));
    }
    const token = match[0];
    if (token.startsWith("**") || token.startsWith("__")) {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true, font: FONT, ...base }));
    } else if (token.startsWith("`")) {
      runs.push(new TextRun({
        text: token.slice(1, -1),
        color: COLOR.blue,
        font: FONT,
        shading: { type: ShadingType.CLEAR, fill: COLOR.paleGray },
        ...base,
      }));
    } else if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/u);
      const text = link ? `${link[1]}（${link[2]}）` : token;
      runs.push(new TextRun({ text, color: COLOR.blue, underline: {}, font: FONT, ...base }));
    } else {
      runs.push(new TextRun({ text: token.slice(1, -1), italics: true, font: FONT, ...base }));
    }
    cursor = match.index + token.length;
  }
  if (cursor < source.length) {
    runs.push(new TextRun({ text: source.slice(cursor), font: FONT, ...base }));
  }
  return runs.length ? runs : [new TextRun({ text: source, font: FONT, ...base })];
}

function splitTableRow(line) {
  const placeholder = "\u0000PIPE\u0000";
  return String(line)
    .trim()
    .replace(/\\\|/gu, placeholder)
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => plainText(cell.replaceAll(placeholder, "|")));
}

function isTableDivider(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function isBlockStart(lines, index) {
  const text = String(lines[index] || "").trim();
  if (!text) return true;
  if (/^```/u.test(text)) return true;
  if (/^#{1,6}\s+/u.test(text)) return true;
  if (/^>\s?/u.test(text)) return true;
  if (/^(?:[-+*]|\d+[.)])\s+/u.test(text)) return true;
  if (/^(?:-{3,}|\*{3,}|_{3,})$/u.test(text)) return true;
  return /^\|.*\|$/u.test(text) && isTableDivider(lines[index + 1] || "");
}

function parseMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/gu, "\n").split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const raw = lines[index];
    const text = raw.trim();
    if (!text) {
      index += 1;
      continue;
    }

    if (/^```/u.test(text)) {
      const language = text.slice(3).trim();
      const body = [];
      index += 1;
      while (index < lines.length && !/^```/u.test(lines[index].trim())) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language, text: body.join("\n") });
      continue;
    }

    if (/^\|.*\|$/u.test(text) && isTableDivider(lines[index + 1] || "")) {
      const rows = [splitTableRow(text)];
      index += 2;
      while (index < lines.length && /^\|.*\|$/u.test(lines[index].trim())) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", rows });
      continue;
    }

    const heading = text.match(/^(#{1,6})\s+(.+)$/u);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: plainText(heading[2]) });
      index += 1;
      continue;
    }

    const quote = text.match(/^>\s?(.*)$/u);
    if (quote) {
      const body = [];
      while (index < lines.length) {
        const current = lines[index].trim().match(/^>\s?(.*)$/u);
        if (!current) break;
        body.push(current[1]);
        index += 1;
      }
      blocks.push({ type: "quote", text: body.join("\n") });
      continue;
    }

    const list = raw.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/u);
    if (list) {
      blocks.push({
        type: "list",
        ordered: /^\d/u.test(list[2]),
        ordinal: /^\d/u.test(list[2]) ? Number.parseInt(list[2], 10) : null,
        level: Math.min(2, Math.floor(list[1].replace(/\t/gu, "    ").length / 2)),
        text: list[3],
      });
      index += 1;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/u.test(text)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    const body = [text];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
      body.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: body.join(" ") });
  }
  return blocks;
}

function visualLength(value) {
  return [...String(value || "")].reduce(
    (total, char) => total + (/[^\u0000-\u00ff]/u.test(char) ? 2 : 1),
    0,
  );
}

function normalizeRows(rows) {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  return {
    columnCount,
    rows: rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] || "")),
  };
}

function shouldStackTable(rows, columnCount) {
  if (columnCount > 4 || rows.length > 14) return true;
  return rows.slice(1).some((row) => {
    const lengths = row.map(visualLength);
    return lengths.some((length) => length > 92)
      || lengths.reduce((sum, length) => sum + length, 0) > 230;
  });
}

function tableColumnWidths(rows, columnCount) {
  const profiles = {
    1: [1],
    2: [0.32, 0.68],
    3: [0.25, 0.32, 0.43],
    4: [0.19, 0.25, 0.25, 0.31],
  };
  const fallback = Array.from({ length: columnCount }, () => 1 / columnCount);
  const profile = profiles[columnCount] || fallback;
  const observed = Array.from({ length: columnCount }, (_, column) => Math.max(
    6,
    ...rows.map((row) => Math.min(60, visualLength(row[column]))),
  ));
  const observedTotal = observed.reduce((sum, value) => sum + value, 0);
  const blended = profile.map((base, index) => base * 0.65 + (observed[index] / observedTotal) * 0.35);
  const widths = blended.map((share) => Math.floor(CONTENT_WIDTH * share));
  widths[widths.length - 1] += CONTENT_WIDTH - widths.reduce((sum, value) => sum + value, 0);
  return widths;
}

function tableBorders() {
  return {
    top: WORD_BORDER,
    bottom: WORD_BORDER,
    left: WORD_BORDER,
    right: WORD_BORDER,
    insideHorizontal: WORD_BORDER,
    insideVertical: WORD_BORDER,
  };
}

function tableCell(text, { header = false, width } = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlignTable.TOP,
    margins: { top: 90, right: 110, bottom: 90, left: 110 },
    shading: header
      ? { type: ShadingType.CLEAR, fill: COLOR.blue, color: "auto" }
      : undefined,
    children: [new Paragraph({
      style: "TableText",
      spacing: { after: 0, line: 300 },
      children: inlineRuns(text, header
        ? { bold: true, color: COLOR.white, size: 19 }
        : { color: COLOR.ink, size: 19 }),
    })],
  });
}

function renderShortTable(rows, columnCount) {
  const widths = tableColumnWidths(rows, columnCount);
  return [
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: widths,
      layout: TableLayoutType.FIXED,
      alignment: AlignmentType.LEFT,
      borders: tableBorders(),
      rows: rows.map((row, rowIndex) => new TableRow({
        tableHeader: rowIndex === 0,
        cantSplit: true,
        children: row.map((cell, columnIndex) => tableCell(cell, {
          header: rowIndex === 0,
          width: widths[columnIndex],
        })),
      })),
    }),
    new Paragraph({ style: "BodyText", spacing: { after: 90 }, children: [] }),
  ];
}

function renderStackedTable(rows) {
  const [headers, ...dataRows] = rows;
  if (!dataRows.length) return renderShortTable(rows, headers.length);
  const children = [new Paragraph({
    style: "TableBlockTitle",
    children: inlineRuns("数据明细（长内容按字段展开）", { bold: true }),
  })];

  dataRows.forEach((row, rowIndex) => {
    const lead = row.find((value) => visualLength(value) > 0 && visualLength(value) <= 42);
    children.push(new Paragraph({
      style: "TableRecordHeading",
      children: inlineRuns(`记录 ${rowIndex + 1}${lead ? ` · ${lead}` : ""}`, { bold: true }),
    }));
    headers.forEach((header, columnIndex) => {
      const value = row[columnIndex] || "";
      if (!header && !value) return;
      children.push(new Paragraph({
        style: "FieldLabel",
        children: inlineRuns(header || `字段 ${columnIndex + 1}`, { bold: true }),
      }));
      children.push(new Paragraph({
        style: "FieldValue",
        children: inlineRuns(value || "—"),
      }));
    });
    if (rowIndex < dataRows.length - 1) {
      children.push(new Paragraph({
        style: "FieldDivider",
        border: { bottom: WORD_BORDER },
        children: [],
      }));
    }
  });
  return children;
}

function renderTable(block) {
  const normalized = normalizeRows(block.rows);
  return shouldStackTable(normalized.rows, normalized.columnCount)
    ? renderStackedTable(normalized.rows)
    : renderShortTable(normalized.rows, normalized.columnCount);
}

function paragraphStyles() {
  // Do not emit w:lang on the run defaults: the bundled headless
  // LibreOffice build misroutes Asian glyphs away from an embedded OOXML font
  // when w:lang and an explicit East Asian font are combined.
  const normalRun = { font: FONT, size: 21, color: COLOR.ink };
  return [
    {
      id: "Normal",
      name: "Normal",
      next: "Normal",
      quickFormat: true,
      run: normalRun,
      paragraph: { spacing: { line: 330, after: 120 }, widowControl: true },
    },
    {
      id: "ReportTitle",
      name: "Report Title",
      basedOn: "Normal",
      next: "BodyText",
      quickFormat: true,
      run: { ...normalRun, bold: true, color: COLOR.blue, size: 38 },
      paragraph: { spacing: { before: 0, after: 220 }, keepNext: true, keepLines: true, outlineLevel: 0 },
    },
    {
      id: "ReportHeading1",
      name: "Report Heading 1",
      basedOn: "Normal",
      next: "BodyText",
      quickFormat: true,
      run: { ...normalRun, bold: true, color: COLOR.blue, size: 30 },
      paragraph: { spacing: { before: 300, after: 120 }, keepNext: true, keepLines: true, outlineLevel: 0 },
    },
    {
      id: "ReportHeading2",
      name: "Report Heading 2",
      basedOn: "Normal",
      next: "BodyText",
      quickFormat: true,
      run: { ...normalRun, bold: true, color: COLOR.ink, size: 26 },
      paragraph: { spacing: { before: 240, after: 100 }, keepNext: true, keepLines: true, outlineLevel: 1 },
    },
    {
      id: "ReportHeading3",
      name: "Report Heading 3",
      basedOn: "Normal",
      next: "BodyText",
      quickFormat: true,
      run: { ...normalRun, bold: true, color: COLOR.accent, size: 23 },
      paragraph: { spacing: { before: 190, after: 80 }, keepNext: true, keepLines: true, outlineLevel: 2 },
    },
    {
      id: "ReportHeading4",
      name: "Report Heading 4",
      basedOn: "Normal",
      next: "BodyText",
      quickFormat: true,
      run: { ...normalRun, bold: true, color: COLOR.ink, size: 21 },
      paragraph: { spacing: { before: 150, after: 70 }, keepNext: true, keepLines: true, outlineLevel: 3 },
    },
    {
      id: "BodyText",
      name: "Body Text",
      basedOn: "Normal",
      next: "BodyText",
      quickFormat: true,
      run: normalRun,
      paragraph: { spacing: { line: 340, after: 125 }, widowControl: true },
    },
    {
      id: "Quote",
      name: "Quote",
      basedOn: "BodyText",
      next: "BodyText",
      quickFormat: true,
      run: { ...normalRun, color: COLOR.muted, italics: true },
      paragraph: {
        indent: { left: 320, right: 160 },
        spacing: { line: 330, before: 80, after: 150 },
        border: { left: { ...WORD_BORDER, color: COLOR.accent, size: 18, space: 12 } },
        shading: { type: ShadingType.CLEAR, fill: COLOR.paleGold, color: "auto" },
      },
    },
    {
      id: "CodeBlock",
      name: "Code Block",
      basedOn: "BodyText",
      next: "BodyText",
      run: { ...normalRun, color: COLOR.blue, size: 19 },
      paragraph: {
        indent: { left: 220, right: 220 },
        spacing: { line: 280, before: 80, after: 150 },
        shading: { type: ShadingType.CLEAR, fill: COLOR.paleGray, color: "auto" },
      },
    },
    {
      id: "TableText",
      name: "Table Text",
      basedOn: "Normal",
      next: "TableText",
      run: { ...normalRun, size: 19 },
      paragraph: { spacing: { line: 300, after: 0 }, widowControl: true },
    },
    {
      id: "TableBlockTitle",
      name: "Table Block Title",
      basedOn: "ReportHeading3",
      next: "TableRecordHeading",
      run: { ...normalRun, bold: true, color: COLOR.blue, size: 22 },
      paragraph: { spacing: { before: 130, after: 90 }, keepNext: true, keepLines: true },
    },
    {
      id: "TableRecordHeading",
      name: "Table Record Heading",
      basedOn: "BodyText",
      next: "FieldLabel",
      run: { ...normalRun, bold: true, color: COLOR.white, size: 20 },
      paragraph: {
        spacing: { before: 110, after: 70 },
        keepNext: true,
        keepLines: true,
        shading: { type: ShadingType.CLEAR, fill: COLOR.blue, color: "auto" },
      },
    },
    {
      id: "FieldLabel",
      name: "Field Label",
      basedOn: "BodyText",
      next: "FieldValue",
      run: { ...normalRun, bold: true, color: COLOR.accent, size: 19 },
      paragraph: { spacing: { before: 75, after: 25 }, keepNext: true, keepLines: true },
    },
    {
      id: "FieldValue",
      name: "Field Value",
      basedOn: "BodyText",
      next: "FieldLabel",
      run: { ...normalRun, size: 20 },
      paragraph: { indent: { left: 120 }, spacing: { line: 330, after: 90 }, widowControl: true },
    },
    {
      id: "FieldDivider",
      name: "Field Divider",
      basedOn: "BodyText",
      next: "TableRecordHeading",
      run: { ...normalRun, size: 4 },
      paragraph: { spacing: { before: 20, after: 70 } },
    },
  ];
}

function documentHeader(title) {
  const fullTitle = plainText(title);
  const shortTitle =
    fullTitle.length > 42 ? `${fullTitle.slice(0, 41)}…` : fullTitle;
  return new Header({
    children: [new Paragraph({
      style: "BodyText",
      border: { bottom: { ...WORD_BORDER, color: COLOR.blue, size: 8, space: 8 } },
      spacing: { after: 70 },
      children: [
        new TextRun({ text: "纳米Work行业版", bold: true, color: COLOR.blue, size: 17, font: FONT }),
        new TextRun({ text: `  ·  ${shortTitle}`, color: COLOR.muted, size: 16, font: FONT }),
      ],
    })],
  });
}

function documentFooter() {
  return new Footer({
    children: [new Paragraph({
      style: "BodyText",
      tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
      border: { top: { ...WORD_BORDER, size: 5, space: 8 } },
      spacing: { before: 60, after: 0 },
      children: [
        new TextRun({ text: "数字员工交付报告", color: COLOR.muted, size: 16, font: FONT }),
        new TextRun({ text: "\t第 ", color: COLOR.muted, size: 16, font: FONT }),
        new TextRun({ children: [PageNumber.CURRENT], color: COLOR.blue, bold: true, size: 16, font: FONT }),
        new TextRun({ text: " / ", color: COLOR.muted, size: 16, font: FONT }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], color: COLOR.blue, bold: true, size: 16, font: FONT }),
        new TextRun({ text: " 页", color: COLOR.muted, size: 16, font: FONT }),
      ],
    })],
  });
}

function renderBlocks(blocks, title) {
  const children = [new Paragraph({
    style: "ReportTitle",
    children: inlineRuns(title, { bold: true, color: COLOR.blue, size: 38 }),
  })];

  const normalizedTitle = plainText(title).replace(/\s+/gu, "");
  let firstMeaningful = true;
  let orderedListInstance = 0;
  let previousBlockWasOrderedList = false;
  for (const block of blocks) {
    if (
      firstMeaningful
      && block.type === "heading"
      && block.level === 1
      && plainText(block.text).replace(/\s+/gu, "") === normalizedTitle
    ) {
      firstMeaningful = false;
      continue;
    }
    firstMeaningful = false;

    if (block.type === "heading") {
      const levels = [
        "ReportHeading1",
        "ReportHeading2",
        "ReportHeading3",
        "ReportHeading4",
      ];
      children.push(new Paragraph({
        style: levels[Math.min(3, Math.max(0, block.level - 1))],
        children: inlineRuns(block.text, { bold: true }),
      }));
    } else if (block.type === "paragraph") {
      children.push(new Paragraph({ style: "BodyText", children: inlineRuns(block.text) }));
    } else if (block.type === "quote") {
      const quoteLines = String(block.text).split("\n");
      children.push(new Paragraph({
        style: "Quote",
        children: quoteLines.flatMap((line, index) => [
          ...(index ? [new TextRun({ break: 1, font: FONT })] : []),
          ...inlineRuns(line, { color: COLOR.muted, italics: true }),
        ]),
      }));
    } else if (block.type === "list") {
      if (block.ordered && (!previousBlockWasOrderedList || block.ordinal === 1)) {
        orderedListInstance += 1;
      }
      children.push(new Paragraph({
        bullet: block.ordered ? undefined : { level: block.level },
        numbering: block.ordered
          ? { reference: "report-numbering", level: block.level, instance: orderedListInstance }
          : undefined,
        spacing: { line: 340, after: 100 },
        children: inlineRuns(block.text),
      }));
    } else if (block.type === "code") {
      children.push(new Paragraph({
        style: "CodeBlock",
        children: [new TextRun({ text: block.text, font: FONT, color: COLOR.blue, size: 19 })],
      }));
    } else if (block.type === "rule") {
      children.push(new Paragraph({
        style: "BodyText",
        border: { bottom: { ...WORD_BORDER, color: COLOR.accent, size: 9, space: 6 } },
        spacing: { before: 60, after: 100 },
        children: [],
      }));
    } else if (block.type === "table") {
      children.push(...renderTable(block));
    }
    previousBlockWasOrderedList = block.type === "list" && block.ordered;
  }
  return children;
}

export async function renderMarkdownDocx(markdown, title = "数字员工报告") {
  const safeTitle = plainText(title || "数字员工报告").slice(0, 120) || "数字员工报告";
  const source = String(markdown || "").trim();
  const blocks = parseMarkdown(source || "暂无正文内容。");
  // 任务标题在列表里被截断到100字，句子会拦腰断在封面上（如“……驾车3”）。
  // 报告正文的首个H1是模型按契约写的完整报告题目，优先用它当文档大标题；
  // 传入标题只留给页眉短摘要与文件元数据。
  const firstHeading = blocks.find(
    (block) => block.type === "heading" && plainText(block.text).trim(),
  );
  const displayTitle =
    firstHeading && firstHeading.level === 1
      ? plainText(firstHeading.text).slice(0, 120)
      : safeTitle;
  const fullCjkFont = resolveEmbeddedCjkFont();
  const cjkFont = await subsetCjkFontForDocument(
    fullCjkFont,
    `${source}${safeTitle}${displayTitle}`,
  );

  const document = new Document({
    title: safeTitle,
    subject: "数字员工交付报告",
    creator: "纳米Work行业版",
    lastModifiedBy: "纳米Work行业版",
    description: "由数字员工生成、按老板可读报告版式导出的 Word 文档",
    fonts: [{
      name: cjkFont.name,
      data: cjkFont.data,
      characterSet: CharacterSet.GB_2312,
    }],
    styles: {
      default: {
        document: {
          run: {
            font: FONT,
            size: 21,
            color: COLOR.ink,
          },
          paragraph: { spacing: { line: 330, after: 120 }, widowControl: true },
        },
      },
      paragraphStyles: paragraphStyles(),
    },
    numbering: {
      config: [{
        reference: "report-numbering",
        levels: [0, 1, 2].map((level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
          style: {
            paragraph: { indent: { left: 420 + level * 360, hanging: 260 } },
            run: { font: FONT, color: COLOR.blue },
          },
        })),
      }],
    },
    sections: [{
      properties: {
        page: {
          size: { width: A4_WIDTH, height: A4_HEIGHT, orientation: PageOrientation.PORTRAIT },
          margin: {
            top: 1_080,
            right: PAGE_MARGIN,
            bottom: 1_080,
            left: PAGE_MARGIN,
            header: 360,
            footer: 360,
            gutter: 0,
          },
        },
      },
      headers: { default: documentHeader(safeTitle) },
      footers: { default: documentFooter() },
      children: renderBlocks(blocks, displayTitle),
    }],
  });

  const packedDocx = await Packer.toBuffer(document);
  return stabilizeEmbeddedFontForLibreOffice(packedDocx, cjkFont);
}
