import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";
import { PNG } from "pngjs";

import {
  DOCX_RENDER_VERSION,
  renderMarkdownDocx,
} from "../src/engines/docx-report-renderer.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanowork-docx-layout-"));
const keepArtifacts = process.env.KEEP_DOCX_LAYOUT_ARTIFACTS === "1";

after(() => {
  if (!keepArtifacts) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const longEvidence = [
  "公开页面只能支持地点存在性、公开分类与道路可达性，不能替代真实交易额、租金和餐段客流。研究员必须到店核验同层直接竞品、菜单价格、排队时长与翻台情况，证据补齐前不得外发为最终定案。",
  "步行、骑行和驾车等时圈用于界定实地验证范围；边界来自真实路网而非固定半径。下一轮调研需要在午餐、晚餐和周末家庭聚餐三个时段分别记录客流、候位与竞品促销，避免把单一时点误写成稳定趋势。",
  "现有公开评价能够提示口味、分量、服务与环境主题，但样本并不等于目标商场内的成交结构。运营经理应补充租赁条件、收银样本和外卖平台后台数据，并将来源、期间、责任人和核验状态写入证据台账。",
  "建议先进行七天低成本验证：完成商场三层竞品走访、三餐段客流计数、二十份菜单价格采集和十位目标顾客访谈。只有当客单、毛利、租金承受力与复购意愿同时达到门槛时，才进入签约和对外承诺。",
];

const longTableRows = Array.from({ length: 9 }, (_, index) => {
  const sequence = index + 1;
  const evidence = longEvidence[index % longEvidence.length];
  return `| 核验事项 ${sequence} | 第 ${sequence} 轮 | ${evidence} | 责任人在第 ${sequence} 个工作日内补齐照片、时间戳、来源期间与结论，并在内部证据台账标明可用边界。 |`;
}).join("\n");

const reportMarkdown = `# 太原吾悦广场毛血旺开店报告

> 竞品与商圈画像 · 员工 #102 · 本次任务期

## 执行摘要

- 商圈具备家庭聚餐与川菜消费基础，但商场内直接竞品仍需到店补证。
- 公开榜单只作为位置与品类线索，不冒充真实交易数据。

1. 先完成七天低成本验证。
2. 再由老板根据证据台账决定是否进入签约。

## 核心判断

| 判断 | 当前状态 | 老板动作 |
| --- | --- | --- |
| 家庭聚餐需求 | 初步成立 | 验证午晚餐与周末客流 |
| 商场内竞争强度 | 待补证 | 采集同层竞品与菜单价格 |

## 证据、风险与行动台账

| 来源 | 期间 | 支持事实 | 下一步行动 |
| --- | --- | --- | --- |
${longTableRows}

## 风险与授权边界

- 租金、真实成交和商场内直接竞品仍是证据缺口。
- 自动外发、付费采购、签约和财务承诺均未授权。
- 内部报告可自动生成，外部不可逆动作必须另行确认。

## 七天行动计划

1. 第一天完成同层竞品与菜单价格采集。
2. 第二至四天覆盖午餐、晚餐和周末餐段客流。
3. 第五至六天访谈目标顾客并复核租赁条件。
4. 第七天形成开店、调整或放弃三选一建议。`;

let reportBufferPromise;
function reportBuffer() {
  reportBufferPromise ||= renderMarkdownDocx(
    reportMarkdown,
    "太原吾悦广场毛血旺开店报告",
  );
  return reportBufferPromise;
}

function occurrences(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function renderRuntime() {
  const python = process.env.CODEX_BUNDLED_PYTHON
    || "/Users/wanglei/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
  const script = process.env.CODEX_RENDER_DOCX_SCRIPT
    || "/Users/wanglei/.codex/plugins/cache/openai-primary-runtime/documents/26.805.11740/skills/documents/render_docx.py";
  return fs.existsSync(python) && fs.existsSync(script) ? { python, script } : null;
}

function pageMetrics(filePath) {
  const png = PNG.sync.read(fs.readFileSync(filePath));
  let ink = 0;
  let bodyInk = 0;
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  const bodyTop = Math.floor(png.height * 0.09);
  const bodyBottom = Math.floor(png.height * 0.89);
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      const red = png.data[offset];
      const green = png.data[offset + 1];
      const blue = png.data[offset + 2];
      const alpha = png.data[offset + 3];
      if (alpha === 0 || (red > 242 && green > 242 && blue > 242)) continue;
      ink += 1;
      if (y >= bodyTop && y <= bodyBottom) bodyInk += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { width: png.width, height: png.height, ink, bodyInk, minX, minY, maxX, maxY };
}

test("DOCX 报告嵌入按文档子集化的中文字体并提供稳定的 A4 报告结构", async () => {
  assert.equal(DOCX_RENDER_VERSION, "docx-report-layout/2");
  const buffer = await reportBuffer();
  assert.ok(buffer.length > 40_000, "DOCX 必须实际嵌入中文字体子集，而不是空 fontTable");
  assert.ok(
    buffer.length < 3_000_000,
    "字体必须按文档字符子集化；整包嵌入曾让单份报告膨胀到15MB",
  );

  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file("word/document.xml").async("string");
  const stylesXml = await zip.file("word/styles.xml").async("string");
  const fontTableXml = await zip.file("word/fontTable.xml").async("string");
  const fontRelsXml = await zip.file("word/_rels/fontTable.xml.rels").async("string");
  const headerXml = await zip.file("word/header1.xml").async("string");
  const footerXml = await zip.file("word/footer1.xml").async("string");
  const embeddedFont = await zip.file("word/fonts/font1.odttf").async("nodebuffer");

  const fontName = fontTableXml.match(/<w:font w:name="([^"]+)"/u)?.[1];
  assert.ok(fontName, "fontTable 必须声明中文字体名称");
  assert.match(fontTableXml, /<w:embedRegular\b/u);
  assert.match(fontTableXml, /w:fontKey="\{34ef3e0d-f556-fb84-37ac-32166042f660\}"/u);
  assert.match(fontTableXml, /<w:charset w:val="86"/u);
  assert.match(fontRelsXml, /relationships\/font/u);
  assert.ok(embeddedFont.length > 20_000, "嵌入字体不能是占位文件");

  // 子集化不许丢字形：解开OOXML混淆（前32字节与GUID逆序异或）后，
  // 正文与页眉页脚的每个字符都必须能在嵌入字体里找到字形。
  const fontKeyBytes = Buffer.from("34ef3e0df556fb8437ac32166042f660", "hex").reverse();
  const deobfuscated = Buffer.from(embeddedFont);
  for (let index = 0; index < Math.min(32, deobfuscated.length); index += 1) {
    deobfuscated[index] ^= fontKeyBytes[index % fontKeyBytes.length];
  }
  const fontkit = await import("fontkit");
  const embedded = fontkit.create(deobfuscated);
  const requiredText = `${reportMarkdown}纳米Work行业版数字员工交付报告数据明细（长内容按字段展开）第页…`;
  const missingGlyphs = [...new Set([...requiredText])]
    .filter((char) => /\S/u.test(char))
    .filter((char) => !embedded.hasGlyphForCodePoint(char.codePointAt(0)));
  assert.deepEqual(missingGlyphs, [], "子集字体缺少文档实际使用的字形");

  for (const script of ["ascii", "hAnsi", "eastAsia", "cs"]) {
    assert.match(stylesXml, new RegExp(`w:${script}="${fontName}"`, "u"));
  }
  assert.doesNotMatch(stylesXml, /<w:lang\b/u, "避免 LibreOffice 将嵌入中文字体错误路由为缺字字体");
  assert.match(stylesXml, /w:styleId="Normal"/u);
  assert.match(stylesXml, /w:styleId="ReportTitle"/u);
  for (const level of [1, 2, 3, 4]) {
    assert.equal(
      occurrences(stylesXml, new RegExp(`w:styleId="ReportHeading${level}"`, "gu")),
      1,
      `报告标题样式 ${level} 必须唯一`,
    );
    assert.equal(
      occurrences(stylesXml, new RegExp(`w:styleId="Heading${level}"`, "gu")),
      1,
      `不能重复覆盖 docx 内建 Heading${level} 样式`,
    );
  }
  assert.match(stylesXml, /<w:keepNext\/>/u);

  assert.match(documentXml, /<w:pgSz w:w="11906" w:h="16838" w:orient="portrait"\/>/u);
  assert.match(documentXml, /<w:pgMar w:top="1080" w:right="1008" w:bottom="1080" w:left="1008"/u);
  assert.match(documentXml, /<w:headerReference\b/u);
  assert.match(documentXml, /<w:footerReference\b/u);
  assert.match(headerXml, /纳米Work行业版/u);
  assert.match(footerXml, /数字员工交付报告/u);
  assert.match(footerXml, />PAGE</u);
  assert.match(footerXml, />NUMPAGES</u);

  assert.equal(occurrences(documentXml, /<w:tbl>/gu), 1, "长文本台账必须转成字段块，不能继续塞进宽表");
  assert.match(documentXml, /<w:tblHeader\/>/u);
  assert.match(documentXml, /<w:cantSplit\/>/u);
  assert.match(documentXml, /数据明细（长内容按字段展开）/u);
  for (const evidence of longEvidence) assert.match(documentXml, new RegExp(evidence.slice(0, 24), "u"));
  assert.match(documentXml, /<w:pStyle w:val="ReportTitle"\/>/u);
  assert.match(documentXml, /<w:pStyle w:val="ReportHeading2"\/>/u);
  assert.match(documentXml, /<w:numPr>/u);
});

test("DOCX 经 documents 技能 render_docx 全页渲染后中文、分页和边界均可读", async (t) => {
  const runtime = renderRuntime();
  if (!runtime) {
    t.skip("当前环境没有 bundled Python 或 documents/render_docx.py；OOXML 契约测试仍执行");
    return;
  }

  const buffer = await reportBuffer();
  if (keepArtifacts) t.diagnostic(`视觉验收产物：${tmpDir}`);
  const docxPath = path.join(tmpDir, "report.docx");
  const renderDir = path.join(tmpDir, "rendered");
  fs.mkdirSync(renderDir, { recursive: true });
  fs.writeFileSync(docxPath, buffer);

  const rendered = spawnSync(runtime.python, [
    runtime.script,
    docxPath,
    "--output_dir",
    renderDir,
    "--emit_pdf",
    "--verbose",
  ], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: "/private/tmp", TEMP: "/private/tmp", TMP: "/private/tmp" },
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);

  const pages = fs.readdirSync(renderDir)
    .filter((name) => /^page-\d+\.png$/u.test(name))
    .sort((left, right) => Number.parseInt(left.match(/\d+/u)[0], 10)
      - Number.parseInt(right.match(/\d+/u)[0], 10));
  assert.ok(pages.length >= 2 && pages.length <= 8, `异常分页数量：${pages.length}`);

  const pageDetails = pages.map((page, index) => ({
    page,
    index,
    metrics: pageMetrics(path.join(renderDir, page)),
  }));
  pageDetails.forEach(({ page, index, metrics }) => {
    t.diagnostic(`${page}: ink=${metrics.ink}, bodyInk=${metrics.bodyInk}, bounds=${metrics.minX},${metrics.minY}-${metrics.maxX},${metrics.maxY}, index=${index + 1}`);
  });
  pageDetails.forEach(({ page, metrics }) => {
    assert.ok(metrics.ink > 7_000, `${page} 不应是空白页`);
    assert.ok(metrics.bodyInk > 1_500, `${page} 正文区域不应只剩页眉页脚`);
    assert.ok(metrics.minX > 20 && metrics.maxX < metrics.width - 20, `${page} 存在左右裁切风险`);
    assert.ok(metrics.minY > 10 && metrics.maxY < metrics.height - 10, `${page} 存在上下裁切风险`);
  });

  const pdfPath = path.join(renderDir, "report.pdf");
  assert.ok(fs.existsSync(pdfPath), "render_docx --emit_pdf 必须保留视觉验收 PDF");
  const extracted = spawnSync(runtime.python, [
    "-c",
    "from pypdf import PdfReader; import sys; print('\\n'.join((p.extract_text() or '') for p in PdfReader(sys.argv[1]).pages))",
    pdfPath,
  ], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: "/private/tmp" },
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout);
  assert.match(extracted.stdout, /太原吾悦广场毛血旺开店报告/u);
  assert.match(extracted.stdout, /公开页面只能支持地点存在性/u);
  assert.match(extracted.stdout, /自动外发、付费采购、签约和财务承诺均未授权/u);
  assert.match(extracted.stdout, /1\.\s*第一天完成同层竞品与菜单价格采集/u);
  assert.doesNotMatch(extracted.stdout, /3\.\s*第一天完成同层竞品与菜单价格采集/u);
  assert.match(extracted.stdout, /第 1 \/ /u);
  assert.doesNotMatch(extracted.stdout, /[�□]{2,}/u, "PDF 文字层不能退化为乱码或方框");
});
