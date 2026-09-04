// 海报指定汉字矢量叠字引擎。
//
// 图像模型生成汉字幻觉严重，菜名/价格/门店名必须 100% 准确：
// 模型只负责“无字底图”，文字由本引擎用 Noto Sans SC 轮廓生成 SVG，
// 经 resvg 与底图一次渲染成最终 PNG。全程不调用模型、不计费。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CjkFontError, cjkTextToSvgPaths, escapeXml, layoutCjkText, svgNumber } from "./cjk-font.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const POSTER_TEXT_ROLES = Object.freeze(["title", "price", "store", "subtitle", "badge"]);
export const POSTER_TEXT_POSITIONS = Object.freeze(["top", "bottom", "center"]);
export const POSTER_TEXT_ALIGNS = Object.freeze(["left", "center", "right"]);
export const POSTER_TEXT_MAX_LAYERS = 6;
export const POSTER_TEXT_MAX_CHARS = 60;
export const POSTER_TEXT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const POSTER_TEXT_MAX_CANVAS = 4096;
// 测试可用 NANOWORK_POSTER_TEXT_UPLOAD_ROOT 指到临时目录；生产固定在受保护的 uploads 下。
export const POSTER_TEXT_UPLOAD_ROOT = process.env.NANOWORK_POSTER_TEXT_UPLOAD_ROOT
  ? path.resolve(process.env.NANOWORK_POSTER_TEXT_UPLOAD_ROOT)
  : path.resolve(__dirname, "..", "..", "data", "uploads", "poster-text");
export const POSTER_TEXT_NO_TEXT_DIRECTIVE =
  "画面不要出现任何文字、字母、数字、价格、标语、水印或Logo；所有文案将由系统在后期以矢量文字精确叠加，请为顶部与底部留出干净的留白区域。";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SVG_BYTES = 40 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
let resvgModulePromise = null;

export class PosterTextOverlayError extends Error {
  constructor(message, { status = 400, code = "POSTER_TEXT_OVERLAY_INVALID" } = {}) {
    super(message);
    this.name = "PosterTextOverlayError";
    this.status = status;
    this.code = code;
  }
}

const failure = (message, status, code) => new PosterTextOverlayError(message, { status, code });

// 各角色的视觉规格（相对于画布短边 base 的比例）。
const ROLE_STYLES = Object.freeze({
  title: Object.freeze({
    maxSize: 0.085,
    minSize: 0.045,
    maxLines: 2,
    fill: "#ffffff",
    stroke: "#1a1a1a",
    strokeWidth: 0.008,
    backing: "rgba(0,0,0,0.42)",
    weight: 700,
    order: 0,
  }),
  subtitle: Object.freeze({
    maxSize: 0.05,
    minSize: 0.03,
    maxLines: 2,
    fill: "#ffffff",
    stroke: "#1a1a1a",
    strokeWidth: 0.006,
    backing: "rgba(0,0,0,0.36)",
    weight: 500,
    order: 1,
  }),
  price: Object.freeze({
    maxSize: 0.11,
    minSize: 0.05,
    maxLines: 1,
    fill: "#ffd54a",
    stroke: null,
    strokeWidth: 0,
    backing: "#c8102e",
    weight: 900,
    monospaceDigits: true,
    order: 2,
  }),
  badge: Object.freeze({
    maxSize: 0.05,
    minSize: 0.028,
    maxLines: 1,
    fill: "#ffffff",
    stroke: null,
    strokeWidth: 0,
    backing: "#e0532f",
    weight: 700,
    order: 3,
  }),
  store: Object.freeze({
    maxSize: 0.045,
    minSize: 0.026,
    maxLines: 2,
    fill: "#ffffff",
    stroke: "#1a1a1a",
    strokeWidth: 0.005,
    backing: "rgba(0,0,0,0.5)",
    weight: 700,
    order: 4,
  }),
});

function cleanText(value, max = POSTER_TEXT_MAX_CHARS) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function normalizePosition(value) {
  if (value === undefined || value === null || value === "") return "bottom";
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (POSTER_TEXT_POSITIONS.includes(text)) return text;
    throw failure(`position 仅支持 ${POSTER_TEXT_POSITIONS.join("/")} 或 {x,y}`);
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const x = Number(value.x);
    const y = Number(value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
      throw failure("position.x/y 必须是非负数（0-1 表示比例，>1 表示像素）");
    }
    return { x, y };
  }
  throw failure("position 格式无效");
}

/**
 * 校验并规范化 textOverlay 入参。返回 { layers } 或在为空时抛 400。
 */
export function normalizePosterTextOverlay(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw failure("textOverlay 必须是对象 { layers: [...] }");
  }
  const rawLayers = Array.isArray(input.layers) ? input.layers : null;
  if (!rawLayers || !rawLayers.length) throw failure("textOverlay.layers 至少需要一层文字");
  if (rawLayers.length > POSTER_TEXT_MAX_LAYERS) {
    throw failure(`textOverlay.layers 最多 ${POSTER_TEXT_MAX_LAYERS} 层`);
  }
  const layers = rawLayers.map((layer, index) => {
    if (!layer || typeof layer !== "object" || Array.isArray(layer)) {
      throw failure(`第${index + 1}层文字必须是对象`);
    }
    const text = cleanText(layer.text);
    if (!text) throw failure(`第${index + 1}层文字不能为空`);
    if ([...String(layer.text)].length > POSTER_TEXT_MAX_CHARS) {
      throw failure(`第${index + 1}层文字最多 ${POSTER_TEXT_MAX_CHARS} 字`);
    }
    const role = String(layer.role || "title").trim().toLowerCase();
    if (!POSTER_TEXT_ROLES.includes(role)) {
      throw failure(`第${index + 1}层 role 仅支持 ${POSTER_TEXT_ROLES.join("/")}`);
    }
    const align = String(layer.align || "center").trim().toLowerCase();
    if (!POSTER_TEXT_ALIGNS.includes(align)) {
      throw failure(`第${index + 1}层 align 仅支持 ${POSTER_TEXT_ALIGNS.join("/")}`);
    }
    let maxWidth = null;
    if (layer.maxWidth !== undefined && layer.maxWidth !== null && layer.maxWidth !== "") {
      maxWidth = Number(layer.maxWidth);
      if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
        throw failure(`第${index + 1}层 maxWidth 必须是正数（0-1 表示比例，>1 表示像素）`);
      }
    }
    return {
      text,
      role,
      position: normalizePosition(layer.position ?? (role === "store" ? "bottom" : role === "badge" ? "top" : undefined)),
      align,
      maxWidth,
    };
  });
  return { layers };
}

function normalizeCanvas(canvas, fallback) {
  const w = Math.round(Number(canvas?.w ?? canvas?.width ?? fallback?.w));
  const h = Math.round(Number(canvas?.h ?? canvas?.height ?? fallback?.h));
  if (
    !Number.isSafeInteger(w) || !Number.isSafeInteger(h) ||
    w < 64 || h < 64 || w > POSTER_TEXT_MAX_CANVAS || h > POSTER_TEXT_MAX_CANVAS
  ) {
    throw failure(`画布尺寸无效（64-${POSTER_TEXT_MAX_CANVAS} 像素）`);
  }
  return { w, h };
}

function resolveLength(value, total) {
  if (value === null || value === undefined) return null;
  return value <= 1 ? value * total : value;
}

/**
 * 自动换行 + 缩放：先在 maxFontSize→minFontSize 之间缩小字号；
 * 仍超宽则按字/词换行；行数超过 maxLines 时继续缩小到硬下限，保证文字完整不丢字。
 */
export function fitTextLines({
  text,
  maxWidth,
  maxFontSize,
  minFontSize,
  maxLines = 2,
  hardFloor = 12,
  measure,
}) {
  const chars = [...String(text || "")];
  const wrap = (size) => {
    const lines = [];
    let current = "";
    for (const char of chars) {
      const candidate = current + char;
      if (!current || measure(candidate, size) <= maxWidth) {
        current = candidate;
        continue;
      }
      // 拉丁词尽量不从中间断开
      const breakAt = /[A-Za-z0-9]/u.test(char) ? current.lastIndexOf(" ") : -1;
      if (breakAt > 0) {
        lines.push(current.slice(0, breakAt).trim());
        current = `${current.slice(breakAt + 1)}${char}`;
      } else {
        lines.push(current.trim());
        current = char === " " ? "" : char;
      }
    }
    if (current.trim()) lines.push(current.trim());
    return lines.filter(Boolean);
  };
  let fontSize = maxFontSize;
  while (fontSize > minFontSize && measure(text, fontSize) > maxWidth) {
    fontSize = Math.max(minFontSize, fontSize * 0.92);
  }
  let lines = wrap(fontSize);
  while (lines.length > maxLines && fontSize > hardFloor) {
    fontSize = Math.max(hardFloor, fontSize * 0.9);
    lines = wrap(fontSize);
  }
  return { fontSize: Math.round(fontSize * 100) / 100, lines, wrapped: lines.length > 1 };
}

function measureWith(style) {
  return (text, size) =>
    layoutCjkText(text, size, { weight: style.weight, monospaceDigits: Boolean(style.monospaceDigits) }).width;
}

/**
 * 计算每层的字号、行、块尺寸；只做数学，不生成 SVG，便于单测。
 */
export function layoutPosterTextLayers(layers, canvas) {
  const { w, h } = canvas;
  const base = Math.min(w, h);
  const margin = Math.round(base * 0.05);
  const blocks = layers.map((layer, index) => {
    const style = ROLE_STYLES[layer.role];
    const paddingX = Math.round(base * 0.03);
    const paddingY = Math.round(base * 0.018);
    const requested = resolveLength(layer.maxWidth, w);
    const maxTextWidth = Math.max(
      base * 0.2,
      Math.min(w - margin * 2 - paddingX * 2, requested ?? w - margin * 2 - paddingX * 2),
    );
    const fitted = fitTextLines({
      text: layer.text,
      maxWidth: maxTextWidth,
      maxFontSize: style.maxSize * base,
      minFontSize: style.minSize * base,
      maxLines: style.maxLines,
      measure: measureWith(style),
    });
    const lineHeight = fitted.fontSize * 1.28;
    const lineWidths = fitted.lines.map((line) => measureWith(style)(line, fitted.fontSize));
    const textWidth = Math.max(...lineWidths, 0);
    return {
      index,
      layer,
      style,
      fontSize: fitted.fontSize,
      lines: fitted.lines,
      lineWidths,
      lineHeight,
      paddingX,
      paddingY,
      width: textWidth + paddingX * 2,
      height: fitted.lines.length * lineHeight + paddingY * 2,
      wrapped: fitted.wrapped,
    };
  });

  const gap = Math.round(base * 0.015);
  const groups = { top: [], center: [], bottom: [] };
  for (const block of blocks) {
    if (typeof block.layer.position === "string") groups[block.layer.position].push(block);
  }
  for (const group of Object.values(groups)) group.sort((a, b) => a.style.order - b.style.order || a.index - b.index);

  const stackHeight = (group) => group.reduce((sum, block) => sum + block.height, 0) + Math.max(0, group.length - 1) * gap;
  let y = margin;
  for (const block of groups.top) {
    block.y = y;
    y += block.height + gap;
  }
  y = h - margin - stackHeight(groups.bottom);
  for (const block of groups.bottom) {
    block.y = y;
    y += block.height + gap;
  }
  y = (h - stackHeight(groups.center)) / 2;
  for (const block of groups.center) {
    block.y = y;
    y += block.height + gap;
  }
  for (const block of blocks) {
    const { align } = block.layer;
    if (typeof block.layer.position === "object") {
      const px = resolveLength(block.layer.position.x, w);
      const py = resolveLength(block.layer.position.y, h);
      block.y = Math.min(Math.max(0, py), h - block.height);
      block.x = align === "left" ? px : align === "right" ? px - block.width : px - block.width / 2;
    } else {
      block.x = align === "left" ? margin : align === "right" ? w - margin - block.width : (w - block.width) / 2;
    }
    block.x = Math.min(Math.max(0, block.x), Math.max(0, w - block.width));
    block.y = Math.min(Math.max(0, block.y), Math.max(0, h - block.height));
  }
  return { canvas: { w, h }, blocks };
}

function backingRect(block) {
  const radius = Math.round(block.fontSize * 0.28);
  return (
    `<rect x="${svgNumber(block.x)}" y="${svgNumber(block.y)}" width="${svgNumber(block.width)}"` +
    ` height="${svgNumber(block.height)}" rx="${svgNumber(radius)}" fill="${escapeXml(block.style.backing)}"/>`
  );
}

function blockPaths(block, canvas) {
  const parts = [];
  const { style } = block;
  const anchorX =
    block.layer.align === "left"
      ? block.x + block.paddingX
      : block.layer.align === "right"
        ? block.x + block.width - block.paddingX
        : block.x + block.width / 2;
  block.lines.forEach((line, lineIndex) => {
    // 基线：行盒顶部 + 约 0.92 字号（Noto Sans SC ascent ≈ 1.16em，视觉上取 0.92 居中）
    const baseline = block.y + block.paddingY + lineIndex * block.lineHeight + block.fontSize * 0.98;
    const rendered = cjkTextToSvgPaths({
      text: line,
      fontSize: block.fontSize,
      x: anchorX,
      baseline,
      align: block.layer.align,
      weight: style.weight,
      monospaceDigits: Boolean(style.monospaceDigits),
      fill: style.fill,
      stroke: style.stroke,
      strokeWidth: style.stroke ? Math.max(1, style.strokeWidth * Math.min(canvas.w, canvas.h)) : 0,
      strokeOpacity: 0.85,
    });
    parts.push(rendered.svg);
  });
  return parts.join("");
}

/**
 * 纯函数：生成叠字 SVG（可选嵌入底图 dataUrl）。文字全部以 <path> 轮廓输出，
 * 同时以 <desc> 携带转义后的原文便于审计/测试。
 */
export function buildOverlaySvg({ canvas, layers, imageDataUrl = null, layout = null }) {
  const size = normalizeCanvas(canvas, canvas);
  const normalized = normalizePosterTextOverlay({ layers });
  const computed = layout || layoutPosterTextLayers(normalized.layers, size);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size.w}" height="${size.h}" viewBox="0 0 ${size.w} ${size.h}">`,
  ];
  if (imageDataUrl) {
    if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/u.test(imageDataUrl)) {
      throw failure("底图 dataUrl 格式无效", 400, "POSTER_TEXT_BASE_IMAGE_INVALID");
    }
    parts.push(
      `<image href="${imageDataUrl}" xlink:href="${imageDataUrl}" x="0" y="0" width="${size.w}" height="${size.h}" preserveAspectRatio="xMidYMid slice"/>`,
    );
  }
  for (const block of computed.blocks) {
    parts.push(`<g data-role="${escapeXml(block.layer.role)}"><desc>${escapeXml(block.layer.text)}</desc>`);
    parts.push(backingRect(block));
    parts.push(blockPaths(block, size));
    parts.push("</g>");
  }
  parts.push("</svg>");
  const svg = parts.join("");
  if (Buffer.byteLength(svg) > MAX_SVG_BYTES) {
    throw failure("叠字 SVG 超过安全上限", 413, "POSTER_TEXT_SVG_TOO_LARGE");
  }
  return svg;
}

export function detectImageFormat(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24) return null;
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.subarray(12, 16).toString("ascii") === "IHDR") {
    return { mime: "image/png", ext: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          mime: "image/jpeg",
          ext: "jpg",
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + length;
    }
    return { mime: "image/jpeg", ext: "jpg", width: null, height: null };
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    const chunk = bytes.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X" && bytes.length >= 30) {
      return {
        mime: "image/webp",
        ext: "webp",
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    }
    if (chunk === "VP8 " && bytes.length >= 30) {
      return {
        mime: "image/webp",
        ext: "webp",
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21);
      return { mime: "image/webp", ext: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { mime: "image/webp", ext: "webp", width: null, height: null };
  }
  return null;
}

async function loadResvg() {
  if (!resvgModulePromise) resvgModulePromise = import("@resvg/resvg-js");
  try {
    const module = await resvgModulePromise;
    if (typeof module?.renderAsync !== "function") throw new Error("renderAsync missing");
    return module;
  } catch {
    resvgModulePromise = null;
    throw failure("服务器缺少可用的矢量栅格化组件", 503, "POSTER_TEXT_RASTER_UNAVAILABLE");
  }
}

export async function renderSvgToPng(svg, { width, height } = {}) {
  const resvg = await loadResvg();
  let rendered;
  try {
    rendered = await resvg.renderAsync(svg, { fitTo: { mode: "original" }, logLevel: "error" });
  } catch {
    throw failure("叠字图层栅格化失败", 502, "POSTER_TEXT_RASTER_FAILED");
  }
  const bytes = Buffer.from(rendered.asPng());
  const format = detectImageFormat(bytes);
  if (
    !format || format.mime !== "image/png" ||
    (width && format.width !== width) || (height && format.height !== height)
  ) {
    throw failure("叠字结果不是可验证的 PNG", 502, "POSTER_TEXT_RASTER_INVALID");
  }
  return bytes;
}

async function readImageInput({ imageBuffer, imagePath }) {
  if (Buffer.isBuffer(imageBuffer)) return imageBuffer;
  if (typeof imagePath === "string" && imagePath) {
    const resolved = path.resolve(imagePath);
    const stat = await fsp.lstat(resolved).catch(() => null);
    if (!stat || !stat.isFile()) throw failure("底图文件不存在", 400, "POSTER_TEXT_BASE_IMAGE_MISSING");
    if (stat.size > POSTER_TEXT_MAX_IMAGE_BYTES) throw failure("底图超过大小上限", 413, "POSTER_TEXT_BASE_IMAGE_TOO_LARGE");
    return fsp.readFile(resolved);
  }
  throw failure("缺少底图（imageBuffer 或 imagePath）");
}

/**
 * 主入口：底图 + 文字层 → { png, svg, width, height, baseFormat, layout }。
 */
export async function renderPosterTextOverlay({ imageBuffer, imagePath, layers, canvas } = {}) {
  const normalized = normalizePosterTextOverlay({ layers });
  const bytes = await readImageInput({ imageBuffer, imagePath });
  if (bytes.length > POSTER_TEXT_MAX_IMAGE_BYTES) {
    throw failure("底图超过大小上限", 413, "POSTER_TEXT_BASE_IMAGE_TOO_LARGE");
  }
  const format = detectImageFormat(bytes);
  if (!format) throw failure("底图必须是 PNG/JPEG/WebP", 400, "POSTER_TEXT_BASE_IMAGE_INVALID");
  const size = normalizeCanvas(canvas, { w: format.width, h: format.height });
  const layout = layoutPosterTextLayers(normalized.layers, size);
  const svg = buildOverlaySvg({
    canvas: size,
    layers: normalized.layers,
    layout,
    imageDataUrl: `data:${format.mime};base64,${bytes.toString("base64")}`,
  });
  const png = await renderSvgToPng(svg, { width: size.w, height: size.h });
  return {
    png,
    svg,
    width: size.w,
    height: size.h,
    baseFormat: format,
    layers: layout.blocks.map((block) => ({
      role: block.layer.role,
      text: block.layer.text,
      fontSize: block.fontSize,
      lines: block.lines.length,
      wrapped: block.wrapped,
    })),
  };
}

/**
 * 从用户提示词里剥离将由系统叠加的文字，并追加“无字”指令，避免模型再画一版错字。
 */
export function stripOverlayTextFromPrompt(prompt, layers, { directive = POSTER_TEXT_NO_TEXT_DIRECTIVE } = {}) {
  let text = String(prompt ?? "");
  const texts = (Array.isArray(layers) ? layers : [])
    .map((layer) => cleanText(layer?.text))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const fragment of texts) {
    text = text.split(fragment).join(" ");
    // 价格常见的裸数字写法（如 “39.9” / “¥39.9” / “39.9元”）也一并去掉
    const numeric = fragment.replace(/[^0-9.]/gu, "");
    if (numeric && /^\d+(?:\.\d+)?$/u.test(numeric) && numeric.length >= 2) {
      text = text.replace(new RegExp(`[¥￥]?${numeric.replace(/\./gu, "\\.")}\\s*元?`, "gu"), " ");
    }
  }
  text = text
    .replace(/[“”"「」『』]\s*[“”"「」『』]/gu, " ")
    .replace(/(?:标题|菜名|价格|门店名?|店名|文字|写着|写上|标注|字样)[:：]?\s*(?=[，,。；;、\s]|$)/gu, " ")
    .replace(/\s+([，,。；;、])/gu, "$1")
    .replace(/([，,。；;、])(?:\s*[，,。；;、])+/gu, "$1")
    .replace(/^[，,。；;、\s]+/u, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return directive ? `${text}\n${directive}` : text;
}

const TENANT_SEGMENT = /^\d{1,10}$/u;

/**
 * 把底图与叠字成品落盘到受保护的 uploads 目录，返回可供 uploadAccessGuard 校验的 URL。
 */
export async function persistPosterTextArtifacts({
  tenantId,
  jobId,
  basePng,
  baseFormat,
  finalPng,
  root = POSTER_TEXT_UPLOAD_ROOT,
}) {
  const tenant = String(tenantId ?? "");
  const job = String(jobId ?? "");
  if (!TENANT_SEGMENT.test(tenant) || !TENANT_SEGMENT.test(job)) {
    throw failure("落盘路径参数无效", 500, "POSTER_TEXT_PATH_INVALID");
  }
  const directory = path.resolve(root, tenant);
  if (!directory.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw failure("落盘目录越界", 500, "POSTER_TEXT_PATH_INVALID");
  }
  await fsp.mkdir(directory, { recursive: true });
  const baseExt = baseFormat?.ext || "png";
  const baseName = `${job}-base.${baseExt}`;
  const finalName = `${job}-final.png`;
  await fsp.writeFile(path.join(directory, baseName), basePng, { flag: "w", mode: 0o600 });
  await fsp.writeFile(path.join(directory, finalName), finalPng, { flag: "w", mode: 0o600 });
  return {
    baseImageUrl: `/uploads/poster-text/${tenant}/${baseName}`,
    url: `/uploads/poster-text/${tenant}/${finalName}`,
    baseImagePath: path.join(directory, baseName),
    finalImagePath: path.join(directory, finalName),
  };
}

/**
 * 供应商返回的图片可能是 b64 或 https URL；统一取回字节以便叠字。
 */
export async function loadGeneratedImageBytes(output, { signal, fetchFn = globalThis.fetch, maxBytes = POSTER_TEXT_MAX_IMAGE_BYTES } = {}) {
  if (output?.b64) {
    const buffer = Buffer.from(String(output.b64).replace(/^data:[^;]+;base64,/u, ""), "base64");
    if (!buffer.length || buffer.length > maxBytes) throw failure("供应商图片数据无效", 502, "POSTER_TEXT_BASE_IMAGE_INVALID");
    return buffer;
  }
  const url = String(output?.url || "").trim();
  const dataMatch = url.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/u);
  if (dataMatch) {
    const buffer = Buffer.from(dataMatch[1], "base64");
    if (!buffer.length || buffer.length > maxBytes) throw failure("供应商图片数据无效", 502, "POSTER_TEXT_BASE_IMAGE_INVALID");
    return buffer;
  }
  if (!/^https:\/\//iu.test(url)) throw failure("供应商未返回可下载的图片", 502, "POSTER_TEXT_BASE_IMAGE_INVALID");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    const response = await fetchFn(url, { signal: controller.signal, redirect: "follow" });
    if (!response?.ok) throw failure("下载供应商图片失败", 502, "POSTER_TEXT_BASE_IMAGE_FETCH_FAILED");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > maxBytes) throw failure("供应商图片大小无效", 502, "POSTER_TEXT_BASE_IMAGE_INVALID");
    return buffer;
  } catch (error) {
    if (error instanceof PosterTextOverlayError) throw error;
    throw failure("下载供应商图片失败", 502, "POSTER_TEXT_BASE_IMAGE_FETCH_FAILED");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

export function posterTextOverlaySummary(layers) {
  return (Array.isArray(layers) ? layers : []).map((layer) => ({ role: layer.role, text: layer.text }));
}

export { CjkFontError };

export function ensurePosterTextUploadRoot() {
  fs.mkdirSync(POSTER_TEXT_UPLOAD_ROOT, { recursive: true });
  return POSTER_TEXT_UPLOAD_ROOT;
}
