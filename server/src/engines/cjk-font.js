// 共享中文字体工具：把 @fontsource/noto-sans-sc 的 woff2 子集用 fontkit 解析，
// 再把文字转成 SVG <path> 轮廓，供 resvg 无字体环境栅格化。
//
// 设计取舍：text-video.js / wechat-draft.js 各自持有一份同源逻辑且已被
// 大量测试锁定错误码；本模块作为独立共享实现供新引擎（海报叠字等）复用，
// 不改动原调用点，避免并行开发期间的连锁回归。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import * as fontkit from "fontkit";

const localRequire = createRequire(import.meta.url);

export const CJK_FONT_FAMILY = "Noto Sans SC";
export const CJK_FONT_DEFAULT_WEIGHT = 700;
const SUPPORTED_WEIGHTS = new Set([400, 500, 600, 700, 800, 900]);
const FONT_FILE_NAME = /^noto-sans-sc-[a-z0-9-]+-\d{3}-normal\.woff2$/u;
const SVG_PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]*$/u;
const MAX_GLYPH_PATH_CHARS = 250_000;

const fontFileCache = new Map();
const rangeIndexCache = new Map();

export class CjkFontError extends Error {
  constructor(message, { status = 503, code = "CJK_FONT_UNAVAILABLE" } = {}) {
    super(message);
    this.name = "CjkFontError";
    this.status = status;
    this.code = code;
  }
}

function normalizeWeight(weight) {
  const value = Number(weight);
  return SUPPORTED_WEIGHTS.has(value) ? value : CJK_FONT_DEFAULT_WEIGHT;
}

function fontCssPath(weight) {
  return localRequire.resolve(`@fontsource/noto-sans-sc/${weight}.css`);
}

function primaryFontPath(weight) {
  return localRequire.resolve(
    `@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-${weight}-normal.woff2`,
  );
}

function fontDirectoryReal(weight) {
  return fs.realpathSync(path.dirname(primaryFontPath(weight)));
}

function parseFontRange(raw) {
  const value = String(raw || "")
    .trim()
    .replace(/^U\+/iu, "");
  if (!value) return null;
  if (value.includes("?")) {
    const start = Number.parseInt(value.replace(/\?/gu, "0"), 16);
    const end = Number.parseInt(value.replace(/\?/gu, "F"), 16);
    return Number.isSafeInteger(start) && Number.isSafeInteger(end)
      ? { start, end }
      : null;
  }
  const [startText, endText = startText] = value.split("-", 2);
  const start = Number.parseInt(startText, 16);
  const end = Number.parseInt(endText, 16);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end)
    ? { start, end }
    : null;
}

function bundledFontRanges(weight) {
  if (rangeIndexCache.has(weight)) return rangeIndexCache.get(weight);
  let css;
  try {
    css = fs.readFileSync(fontCssPath(weight), "utf8");
  } catch {
    throw new CjkFontError("内置中文字体索引不可用");
  }
  const directory = path.dirname(primaryFontPath(weight));
  const directoryReal = fontDirectoryReal(weight);
  const entries = [];
  for (const match of css.matchAll(/@font-face\s*\{([\s\S]*?)\}/gu)) {
    const block = match[1];
    const fileName = block.match(/url\(\.\/files\/([^)'"\s]+\.woff2)\)/u)?.[1];
    const rangeText = block.match(/unicode-range:\s*([^;]+);/u)?.[1];
    if (!FONT_FILE_NAME.test(String(fileName || "")) || !rangeText) continue;
    const ranges = rangeText.split(",").map(parseFontRange).filter(Boolean);
    if (!ranges.length) continue;
    let realCandidate;
    try {
      realCandidate = fs.realpathSync(path.resolve(directory, fileName));
    } catch {
      continue;
    }
    if (!realCandidate.startsWith(`${directoryReal}${path.sep}`)) continue;
    entries.push({ filePath: realCandidate, ranges });
  }
  if (!entries.length) throw new CjkFontError("内置中文字体索引为空");
  rangeIndexCache.set(weight, entries);
  return entries;
}

function loadBundledFont(filePath, weight) {
  let realPath;
  try {
    realPath = fs.realpathSync(filePath);
  } catch {
    throw new CjkFontError("内置中文字体文件不可用");
  }
  if (!realPath.startsWith(`${fontDirectoryReal(weight)}${path.sep}`)) {
    throw new CjkFontError("内置中文字体路径越界", { status: 500 });
  }
  if (fontFileCache.has(realPath)) return fontFileCache.get(realPath);
  let font;
  try {
    font = fontkit.openSync(realPath);
  } catch {
    throw new CjkFontError("内置中文字体无法解析");
  }
  if (
    !font ||
    typeof font.hasGlyphForCodePoint !== "function" ||
    typeof font.layout !== "function" ||
    !Number.isFinite(Number(font.unitsPerEm)) ||
    Number(font.unitsPerEm) <= 0
  ) {
    throw new CjkFontError("内置中文字体格式无效");
  }
  fontFileCache.set(realPath, font);
  return font;
}

/**
 * 返回能绘制该码点的 fontkit 字体对象；找不到字形时抛 400。
 */
export function cjkFontForCodePoint(codePoint, { weight } = {}) {
  const w = normalizeWeight(weight);
  const primary = loadBundledFont(primaryFontPath(w), w);
  if (primary.hasGlyphForCodePoint(codePoint)) return primary;
  for (const entry of bundledFontRanges(w)) {
    if (
      !entry.ranges.some(
        (range) => codePoint >= range.start && codePoint <= range.end,
      )
    ) {
      continue;
    }
    const font = loadBundledFont(entry.filePath, w);
    if (font.hasGlyphForCodePoint(codePoint)) return font;
  }
  throw new CjkFontError(
    "文字包含内置字体无法绘制的字符，请改用中文、字母、数字或常用标点",
    { status: 400, code: "CJK_FONT_GLYPH_UNAVAILABLE" },
  );
}

export function svgNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 1_000_000) {
    throw new CjkFontError("字形坐标无效");
  }
  return Number(number.toFixed(3));
}

export function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function codepoints(text) {
  return [...String(text || "")];
}

const DIGIT_LIKE = /^[0-9]$/u;

/**
 * 逐字形排版，返回可直接拼进 SVG 的路径描述与整行宽度。
 * monospaceDigits：数字与价格符号按固定 0.6em 单元格排布，用于价格等宽突出。
 */
export function layoutCjkText(
  text,
  fontSize,
  { weight, letterSpacing = 0, monospaceDigits = false } = {},
) {
  const size = Number(fontSize);
  if (!Number.isFinite(size) || size <= 0) {
    throw new CjkFontError("字号无效", { status: 400, code: "CJK_FONT_SIZE_INVALID" });
  }
  const glyphs = [];
  let cursor = 0;
  let ascent = 0;
  let descent = 0;
  const monoAdvance = size * 0.6;
  for (const character of codepoints(text)) {
    const codePoint = character.codePointAt(0);
    const font = cjkFontForCodePoint(codePoint, { weight });
    const scale = size / Number(font.unitsPerEm);
    ascent = Math.max(ascent, Number(font.ascent || 0) * scale);
    descent = Math.max(descent, Math.abs(Number(font.descent || 0)) * scale);
    const run = font.layout(character);
    if (!Array.isArray(run?.glyphs) || !run.glyphs.length) {
      throw new CjkFontError("字形排版失败");
    }
    const glyph = run.glyphs[0];
    const position = run.positions[0] || {};
    const naturalAdvance = Number(position.xAdvance || 0) * scale;
    const useMono = monospaceDigits && DIGIT_LIKE.test(character);
    const advance = useMono ? monoAdvance : naturalAdvance;
    const d = String(glyph?.path?.toSVG?.() || "");
    if (d && (d.length > MAX_GLYPH_PATH_CHARS || !SVG_PATH_DATA.test(d))) {
      throw new CjkFontError("字形轮廓无效");
    }
    if (d) {
      glyphs.push({
        d,
        x:
          cursor +
          Number(position.xOffset || 0) * scale +
          (useMono ? (monoAdvance - naturalAdvance) / 2 : 0),
        yOffset: Number(position.yOffset || 0) * scale,
        scale,
      });
    }
    cursor += advance + letterSpacing;
  }
  const width = Math.max(0, cursor - (glyphs.length ? letterSpacing : 0));
  return { glyphs, width, ascent, descent, fontSize: size };
}

export function measureCjkText(text, fontSize, options = {}) {
  return layoutCjkText(text, fontSize, options).width;
}

/**
 * 把一行文字渲染为 <path> 序列。x 为行起点（按 align 解释），baseline 为基线 y。
 */
export function cjkTextToSvgPaths({
  text,
  fontSize,
  x = 0,
  baseline = 0,
  align = "left",
  weight,
  letterSpacing = 0,
  monospaceDigits = false,
  fill = "#ffffff",
  stroke = null,
  strokeWidth = 0,
  strokeOpacity = 1,
  opacity = 1,
} = {}) {
  const layout = layoutCjkText(text, fontSize, {
    weight,
    letterSpacing,
    monospaceDigits,
  });
  const originX =
    align === "center"
      ? x - layout.width / 2
      : align === "right"
        ? x - layout.width
        : x;
  const strokeAttributes =
    stroke && strokeWidth > 0
      ? ` stroke="${escapeXml(stroke)}" stroke-opacity="${svgNumber(strokeOpacity)}" stroke-linejoin="round" paint-order="stroke fill"`
      : "";
  const paths = layout.glyphs
    .map((glyph) => {
      const strokeScaled =
        stroke && strokeWidth > 0
          ? ` stroke-width="${svgNumber(strokeWidth / glyph.scale)}"`
          : "";
      return (
        `<path d="${glyph.d}" transform="translate(${svgNumber(originX + glyph.x)} ${svgNumber(
          baseline - glyph.yOffset,
        )}) scale(${svgNumber(glyph.scale)} ${svgNumber(-glyph.scale)})"` +
        ` fill="${escapeXml(fill)}"${strokeAttributes}${strokeScaled}` +
        (opacity !== 1 ? ` opacity="${svgNumber(opacity)}"` : "") +
        "/>"
      );
    })
    .join("");
  return { svg: paths, width: layout.width, ascent: layout.ascent, descent: layout.descent };
}
