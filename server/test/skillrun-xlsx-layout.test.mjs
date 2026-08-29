import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { PNG } from 'pngjs';

import { mdToXlsx, XLSX_RENDER_VERSION } from '../src/engines/skillrun.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-xlsx-layout-'));

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const reportMarkdown = `# 太原吾悦广场毛血旺开店报告

> 竞品与商圈画像 · 员工 #102 · 本次任务期

## 报告摘要

| 交付成果 | 摘要 |
| --- | --- |
| 核心结论 | 商圈具备家庭聚餐与川菜消费基础，但商场内直接竞品、租金和真实餐段客流仍需到店补证，不能把公开榜单写成真实交易数据。 |

## 来源与风险

| 来源 | 期间 | 支持事实 |
| --- | --- | --- |
| 高德公开榜单 | 本次材料 | 公开页面展示餐饮地点和道路可达性，仅支持地点存在性与公开分类，不代表真实交易额。 |
| 真实时间等时圈 | 本次材料 | 步行、骑行和驾车三种路网边界用于界定验证范围。 |

| 风险 | 状态 | 行动 | 授权边界 |
| --- | --- | --- | --- |
| 商场内直接竞品尚未核验 | 待复核 | 研究员在一个工作日内到店采集同层竞品、菜单价和餐段客流，完成后提交老板复核。 | 外部动作授权：否 |
| 租金与真实成交数据缺失 | 证据缺口 | 运营经理补充租赁条件和收银样本，未补证前不得外发为最终定案。 | 财务或监管承诺授权：否 |`;

function availableBinary(name) {
  const bundledPoppler = path.join(
    os.homedir(),
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'native',
    'poppler',
    'poppler',
    'bin',
    name,
  );
  if (fs.existsSync(bundledPoppler)) return bundledPoppler;
  const probe = spawnSync(
    name,
    name === 'soffice' ? ['--version'] : name === 'qlmanage' ? ['-h'] : ['-v'],
    { encoding: 'utf8' },
  );
  return probe.error?.code === 'ENOENT' ? null : name;
}

function pngInkPixels(filePath) {
  const png = PNG.sync.read(fs.readFileSync(filePath));
  let ink = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const red = png.data[offset];
    const green = png.data[offset + 1];
    const blue = png.data[offset + 2];
    const alpha = png.data[offset + 3];
    if (alpha > 0 && (red < 238 || green < 238 || blue < 238)) ink += 1;
  }
  return ink;
}

function quickLookTitleGlyphPixels(filePath) {
  const png = PNG.sync.read(fs.readFileSync(filePath));
  const maxY = Math.min(png.height, Math.ceil(png.height * 0.16));
  const bandRows = [];
  for (let y = 0; y < maxY; y += 1) {
    let navyPixels = 0;
    for (let x = 0; x < png.width; x += 1) {
      const offset = (png.width * y + x) * 4;
      const red = png.data[offset];
      const green = png.data[offset + 1];
      const blue = png.data[offset + 2];
      if (red < 80 && green < 125 && blue < 165 && blue > red) navyPixels += 1;
    }
    if (navyPixels > png.width * 0.45) bandRows.push(y);
  }
  assert.ok(bandRows.length >= 8, 'QuickLook 未找到报告顶部深蓝标题带');
  const firstBandStart = bandRows[0];
  let firstBandEnd = firstBandStart;
  for (const y of bandRows.slice(1)) {
    if (y !== firstBandEnd + 1) break;
    firstBandEnd = y;
  }
  let left = png.width;
  let right = 0;
  for (let y = firstBandStart; y <= firstBandEnd; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (png.width * y + x) * 4;
      const red = png.data[offset];
      const green = png.data[offset + 1];
      const blue = png.data[offset + 2];
      if (red < 80 && green < 125 && blue < 165 && blue > red) {
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
  }
  let lightPixels = 0;
  for (let y = firstBandStart; y <= firstBandEnd; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = (png.width * y + x) * 4;
      const red = png.data[offset];
      const green = png.data[offset + 1];
      const blue = png.data[offset + 2];
      const alpha = png.data[offset + 3];
      if (alpha > 0 && red > 215 && green > 215 && blue > 215) lightPixels += 1;
    }
  }
  return lightPixels;
}

test('XLSX 报告使用自适应列宽、全量换行、长文本行高与可读打印区域', async t => {
  assert.equal(XLSX_RENDER_VERSION, 'xlsx-layout/3');
  const buffer = await mdToXlsx(reportMarkdown, '太原吾悦广场开店报告');
  assert.ok(buffer.length > 5_000);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.equal(workbook.worksheets.length, 1);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.actualColumnCount, 4);
  assert.ok(sheet.actualRowCount >= 12);
  assert.ok(sheet.lastRow.values.some(Boolean), '打印区尾部不应留下空白行');

  const widths = [1, 2, 3, 4].map(column => sheet.getColumn(column).width);
  assert.ok(widths[0] >= 16 && widths[0] <= 22);
  assert.ok(widths[1] >= 22 && widths[1] <= 34);
  assert.ok(widths[2] >= 18 && widths[2] <= 26);
  assert.ok(widths[3] >= 28 && widths[3] <= 44);
  assert.equal(new Set(widths).size, 4, '报告列不能继续使用统一 22 字符宽度');
  assert.equal(sheet.views[0].state, 'frozen');
  assert.equal(sheet.views[0].ySplit, 1);
  assert.equal(sheet.autoFilter, undefined, '多段报告表格不应套用一个错误的全局筛选器');
  assert.equal(sheet.pageSetup.orientation, 'landscape');
  assert.equal(sheet.pageSetup.fitToPage, true);
  assert.equal(sheet.pageSetup.fitToWidth, 1);
  assert.equal(sheet.pageSetup.fitToHeight, 0);
  assert.equal(sheet.pageSetup.printArea, `A1:D${sheet.rowCount}`);
  assert.equal(sheet.pageSetup.printTitlesRow, undefined);

  let formulas = 0;
  let errorCells = 0;
  let longTextRowHeight = 0;
  const fontNames = new Set();
  const text = [];
  sheet.eachRow(row => {
    row.eachCell({ includeEmpty: false }, cell => {
      assert.equal(cell.alignment?.vertical, 'top');
      assert.equal(cell.alignment?.wrapText, true);
      if (cell.type === ExcelJS.ValueType.Formula) formulas += 1;
      if (cell.type === ExcelJS.ValueType.Error) errorCells += 1;
      const cellText = String(cell.text || cell.value || '');
      fontNames.add(cell.font?.name);
      text.push(cellText);
      if (cellText.includes('公开页面展示餐饮地点')) longTextRowHeight = Number(row.height || 0);
    });
  });
  assert.equal(formulas, 0);
  assert.equal(errorCells, 0);
  assert.deepEqual([...fontNames], ['Arial Unicode MS']);
  assert.ok(longTextRowHeight >= 37, '长来源说明必须获得多行安全行高');
  assert.match(text.join('\n'), /高德公开榜单/u);
  assert.match(text.join('\n'), /未补证前不得外发为最终定案/u);
  assert.match(text.join('\n'), /外部动作授权：否/u);
  assert.match(text.join('\n'), /财务或监管承诺授权：否/u);

  const zip = await JSZip.loadAsync(buffer);
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const stylesXml = await zip.file('xl/styles.xml').async('string');
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  assert.match(stylesXml, /<alignment[^>]*vertical="top"[^>]*wrapText="1"/u);
  assert.match(stylesXml, /<name val="Arial Unicode MS"\/>/u);
  assert.match(sheetXml, /<pane[^>]*ySplit="1"[^>]*state="frozen"/u);
  assert.match(sheetXml, /<pageSetup[^>]*orientation="landscape"/u);
  assert.match(sheetXml, /<pageSetup[^>]*fitToWidth="1"/u);
  assert.match(sheetXml, /<pageSetup[^>]*fitToHeight="0"/u);
  assert.match(workbookXml, /_xlnm\.Print_Area/u);
  assert.doesNotMatch(sheetXml, /t="e"/u);

  const soffice = availableBinary('soffice');
  const pdftoppm = availableBinary('pdftoppm');
  const pdftotext = availableBinary('pdftotext');
  const xlsxPath = path.join(tmpDir, 'report.xlsx');
  const renderDir = path.join(tmpDir, 'render');
  fs.mkdirSync(renderDir, { recursive: true });
  fs.writeFileSync(xlsxPath, buffer);
  if (soffice && pdftoppm && pdftotext) {
    const profileDir = path.join(tmpDir, 'lo-profile');
    const defaultFontEnvironment = { ...process.env };
    delete defaultFontEnvironment.FONTCONFIG_FILE;
    delete defaultFontEnvironment.FONTCONFIG_PATH;
    const converted = spawnSync(soffice, [
      `-env:UserInstallation=file://${profileDir}`,
      '--headless',
      '--convert-to',
      'pdf',
      '--outdir',
      renderDir,
      xlsxPath,
    ], { encoding: 'utf8', env: defaultFontEnvironment });
    assert.equal(converted.status, 0, converted.stderr || converted.stdout);
    const pdfPath = path.join(renderDir, 'report.pdf');
    assert.ok(fs.existsSync(pdfPath), converted.stderr || converted.stdout);
    const extractedTextPath = path.join(renderDir, 'report.txt');
    const extracted = spawnSync(pdftotext, ['-enc', 'UTF-8', pdfPath, extractedTextPath], {
      encoding: 'utf8',
      env: defaultFontEnvironment,
    });
    assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout);
    const extractedText = fs.readFileSync(extractedTextPath, 'utf8');
    const compactText = extractedText.replace(/\s+/gu, '');
    const chineseCharacterCount = (extractedText.match(/[\u3400-\u9fff]/gu) || []).length;
    assert.ok(chineseCharacterCount >= 100, `默认 LibreOffice PDF 中文过少：${chineseCharacterCount}`);
    for (const sentinel of [
      '太原吾悦广场毛血旺开店报告',
      '高德公开榜单',
      '租金与真实成交数据缺失',
      '未补证前不得外发',
      '外部动作授权：否',
      '财务或监管承诺授权：否',
    ]) {
      assert.match(compactText, new RegExp(sentinel, 'u'), `默认 LibreOffice PDF 缺少中文哨兵：${sentinel}`);
    }
    t.diagnostic(`默认 LibreOffice PDF 可提取 ${chineseCharacterCount} 个中文字符；该断言仅验证文本语义，不替代字形视觉验收`);
    const rasterBase = path.join(renderDir, 'page');
    const rastered = spawnSync(pdftoppm, ['-png', '-r', '96', pdfPath, rasterBase], { encoding: 'utf8' });
    assert.equal(rastered.status, 0, rastered.stderr || rastered.stdout);
    const pages = fs.readdirSync(renderDir)
      .filter(name => /^page-\d+\.png$/u.test(name))
      .sort();
    assert.ok(pages.length >= 1 && pages.length <= 3, `异常分页数量：${pages.length}`);
    for (const page of pages) {
      assert.ok(pngInkPixels(path.join(renderDir, page)) > 2_000, `${page} 不应是空白打印页`);
    }
  } else {
    t.diagnostic('soffice、pdftoppm 或 pdftotext 不可用；跳过 PDF 语义与分页验收');
  }

  const qlmanage = availableBinary('qlmanage');
  if (qlmanage) {
    const quickLookDir = path.join(tmpDir, 'quicklook');
    fs.mkdirSync(quickLookDir, { recursive: true });
    const preview = spawnSync(qlmanage, ['-t', '-s', '2400', '-o', quickLookDir, xlsxPath], {
      encoding: 'utf8',
    });
    assert.equal(preview.status, 0, preview.stderr || preview.stdout);
    const quickLookPng = path.join(quickLookDir, 'report.xlsx.png');
    assert.ok(fs.existsSync(quickLookPng), preview.stderr || preview.stdout);
    const titleGlyphPixels = quickLookTitleGlyphPixels(quickLookPng);
    assert.ok(titleGlyphPixels > 700, `QuickLook 深蓝标题带中文字形像素不足：${titleGlyphPixels}`);
    t.diagnostic(`系统 QuickLook 标题带检测到 ${titleGlyphPixels} 个浅色中文字形像素`);
  } else {
    t.diagnostic('qlmanage 不可用；跳过 macOS QuickLook 中文字形验收');
  }
});

test('单一数据表冻结表头并启用表内自动筛选', async () => {
  const buffer = await mdToXlsx(`| 门店 | 客流 | 状态 |
| --- | --- | --- |
| 吾悦广场店 | 120 | 已核验 |
| 迎泽店 | 98 | 待复核 |`, '门店数据');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.views[0].state, 'frozen');
  assert.equal(sheet.views[0].ySplit, 2);
  assert.deepEqual(sheet.autoFilter, 'A2:C4');
  assert.equal(sheet.pageSetup.printArea, 'A1:C4');
});
