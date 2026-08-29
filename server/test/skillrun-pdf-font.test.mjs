import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';

import { mdToPdf, resolvePdfFontPath } from '../src/engines/skillrun.js';

const require = createRequire(import.meta.url);
const originalPdfFontPath = process.env.PDF_FONT_PATH;
const pdfTmpRoot = path.join(process.cwd(), 'tmp', 'pdfs');
fs.mkdirSync(pdfTmpRoot, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(pdfTmpRoot, 'skillrun-font-'));

after(() => {
  if (originalPdfFontPath === undefined) delete process.env.PDF_FONT_PATH;
  else process.env.PDF_FONT_PATH = originalPdfFontPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function bundledPopplerBinary(name) {
  const runtimePath = path.join(
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
  if (fs.existsSync(runtimePath)) return runtimePath;
  const probe = spawnSync(name, ['-v'], { encoding: 'utf8' });
  return probe.error?.code === 'ENOENT' ? null : name;
}

function countDarkPixelsInTitle(pngPath) {
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  const scaleX = png.width / 595.28;
  const scaleY = png.height / 841.89;
  const left = Math.floor(48 * scaleX);
  const right = Math.min(png.width, Math.ceil(500 * scaleX));
  const top = Math.floor(48 * scaleY);
  const bottom = Math.min(png.height, Math.ceil(84 * scaleY));
  let darkPixels = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (png.width * y + x) * 4;
      const [red, green, blue, alpha] = png.data.subarray(offset, offset + 4);
      if (alpha > 0 && red < 110 && green < 110 && blue < 110) darkPixels += 1;
    }
  }
  return darkPixels;
}

test('中文 PDF 字体只接受可嵌入且包含中文字形的 TTF/OTF', () => {
  const resolved = resolvePdfFontPath();
  assert.match(resolved.path, /\.(?:ttf|otf)$/i);
  assert.doesNotMatch(resolved.path, /\.woff2?$/i);
  assert.ok(['system', 'configured'].includes(resolved.source));
  assert.ok(resolved.postscriptName);

  try {
    const bundledWoff2 = require.resolve('@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff2');
    process.env.PDF_FONT_PATH = bundledWoff2;
    assert.throws(
      () => resolvePdfFontPath(),
      error => /PDF_FONT_PATH/.test(error.message) && /仅支持可嵌入的 TTF\/OTF/.test(error.message),
    );

    process.env.PDF_FONT_PATH = resolved.path;
    const configured = resolvePdfFontPath();
    assert.equal(configured.path, resolved.path);
    assert.equal(configured.source, 'configured');
  } finally {
    if (originalPdfFontPath === undefined) delete process.env.PDF_FONT_PATH;
    else process.env.PDF_FONT_PATH = originalPdfFontPath;
  }
});

test('实际生成的中文 PDF 嵌入字体、可提取文本且 Poppler 渲染有可见中文字形', async t => {
  const pdfPath = path.join(tmpDir, '中文报告.pdf');
  const renderBase = path.join(tmpDir, '中文报告-page');
  const title = '中文字体渲染验证';
  const pdf = await mdToPdf([
    '# 餐饮经营诊断',
    '',
    '本报告用于验证中文内容能够正常显示、复制与下载。',
    '',
    '- 客流趋势稳定',
    '- 建议优化午市套餐',
  ].join('\n'), title);
  fs.writeFileSync(pdfPath, pdf);

  assert.equal(pdf.subarray(0, 4).toString('ascii'), '%PDF');
  const pdfStructure = pdf.toString('latin1');
  assert.match(pdfStructure, /\/ToUnicode\b/, 'PDF 应包含中文字符映射表');
  assert.match(pdfStructure, /\/FontFile(?:2|3)\b/, 'PDF 应嵌入 TrueType/OpenType 字体资源');

  const pdfFonts = bundledPopplerBinary('pdffonts');
  if (pdfFonts) {
    const result = spawnSync(pdfFonts, [pdfPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\byes\s+yes\b/, 'Poppler 应识别到已嵌入、已子集化字体');
  } else {
    t.diagnostic('pdffonts 不可用，已由 PDF 字体资源断言覆盖嵌入检查');
  }

  const pdfToText = bundledPopplerBinary('pdftotext');
  if (pdfToText) {
    const textPath = path.join(tmpDir, '中文报告.txt');
    const result = spawnSync(pdfToText, ['-enc', 'UTF-8', pdfPath, textPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const extracted = fs.readFileSync(textPath, 'utf8');
    assert.match(extracted, /中文字体渲染验证/);
    assert.match(extracted, /餐饮经营诊断/);
  } else {
    t.diagnostic('pdftotext 不可用，跳过文本提取断言');
  }

  const pdfToPpm = bundledPopplerBinary('pdftoppm');
  if (!pdfToPpm) {
    t.diagnostic('pdftoppm 不可用，跳过渲染像素断言');
    return;
  }
  const render = spawnSync(pdfToPpm, ['-f', '1', '-singlefile', '-r', '144', '-png', pdfPath, renderBase], { encoding: 'utf8' });
  assert.equal(render.status, 0, render.stderr || render.stdout);
  const renderedPng = `${renderBase}.png`;
  assert.ok(fs.existsSync(renderedPng));
  assert.ok(countDarkPixelsInTitle(renderedPng) > 200, '标题区域应包含可见的深色中文字形，不能是空白页');
});
