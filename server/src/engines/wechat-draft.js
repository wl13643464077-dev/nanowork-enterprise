import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";

import { curTenant, getConfig, q, runWithTenant, setConfig } from "../db.js";
import {
  findHoldByRef,
  holdCredits,
  releaseHold,
  settleHold,
} from "./credits.js";
import { assertContentDeliverable } from "./delivery-state.js";
import { resolveFfmpeg } from "./media-binaries.js";

export const WECHAT_DRAFT_BILLING_REF = "wechat_draft_delivery";
export const WECHAT_DRAFT_FIXED_CREDITS = 1;
export const WECHAT_DRAFT_MARKER_PREFIX = "nanowork-wechat-draft:";
export const WECHAT_DRAFT_DEFAULT_THEME = "orange";
const TERMINAL_STATES = new Set(["done", "blocked", "failed"]);
const MAX_CONTENT_IMAGES = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_WECHAT_CONTENT_IMAGE_BYTES = 990 * 1024;
const IMAGE_PROCESS_TIMEOUT_MS = 30_000;
const MAX_BODY_CHARS = 100_000;
const DEFAULT_CONFIRM_DELAY_MS = 5 * 60 * 1000;
const OFFICIAL_API_ORIGIN = "https://api.weixin.qq.com";
const OFFICIAL_CDN_HOSTS = new Set([
  "mmbiz.qpic.cn",
  "mmbiz.qlogo.cn",
  "mmbiz.qpic.com",
]);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_ROOT = path.resolve(__dirname, "..", "..", "data", "uploads");
const COVER_FONT_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "node_modules",
  "@fontsource",
  "noto-sans-sc",
  "files",
  "noto-sans-sc-chinese-simplified-700-normal.woff",
);

const WECHAT_DRAFT_THEME_DEFINITIONS = Object.freeze({
  orange: Object.freeze({
    name: "橙心暖阳",
    emoji: "🍊",
    color: "#ff7f2a",
    strong: "#ff7f2a",
    quote: "border-left:4px solid #ff7f2a;background:#fff7f0;color:#8c5a33;",
    heading: "pill",
  }),
  ink: Object.freeze({
    name: "墨黑极简",
    emoji: "🖤",
    color: "#111111",
    strong: "#111111",
    quote: "border-left:3px solid #111;background:#f6f6f6;color:#555;",
    heading: "bar",
  }),
  techblue: Object.freeze({
    name: "科技蓝",
    emoji: "🔷",
    color: "#1e6fff",
    strong: "#1e6fff",
    quote: "border-left:4px solid #1e6fff;background:#f0f6ff;color:#3a5a8c;",
    heading: "numbered",
  }),
  jade: Object.freeze({
    name: "翡翠绿",
    emoji: "🌿",
    color: "#00b96b",
    strong: "#00875a",
    quote: "border-left:4px solid #00b96b;background:#f0fbf5;color:#3c7a5d;",
    heading: "highlight",
  }),
  violet: Object.freeze({
    name: "姹紫",
    emoji: "💜",
    color: "#8a4baf",
    strong: "#8a4baf",
    quote: "border-left:4px solid #c084fc;background:#faf5ff;color:#7c5295;",
    heading: "violet",
  }),
  scarlet: Object.freeze({
    name: "红绯热烈",
    emoji: "🧧",
    color: "#e63946",
    strong: "#e63946",
    quote: "border-left:4px solid #e63946;background:#fdf0f0;color:#a4494f;",
    heading: "scarlet",
  }),
  aqua: Object.freeze({
    name: "蔚蓝渐变",
    emoji: "🌊",
    color: "#00a6fb",
    strong: "#0582ca",
    quote: "border-left:4px solid #4facfe;background:#eef8ff;color:#3c6e91;",
    heading: "aqua",
  }),
  magazine: Object.freeze({
    name: "杂志留白",
    emoji: "📖",
    color: "#c0a062",
    strong: "#a8863d",
    quote:
      "border:none;background:#faf7f0;color:#8c7a55;text-align:center;font-style:italic;",
    heading: "magazine",
    serif: true,
  }),
  sakura: Object.freeze({
    name: "樱花软糯",
    emoji: "🌸",
    color: "#ff7eb3",
    strong: "#e05a92",
    quote: "border-left:4px solid #ffb3d1;background:#fff5f9;color:#b06a88;",
    heading: "sakura",
  }),
  gold: Object.freeze({
    name: "商务\u938f金",
    emoji: "🏆",
    color: "#b8860b",
    strong: "#a8781a",
    quote: "border-left:4px solid #b8860b;background:#faf6ec;color:#7d6a3a;",
    heading: "gold",
  }),
  geek: Object.freeze({
    name: "极客终端",
    emoji: "💻",
    color: "#00c853",
    strong: "#00a344",
    quote: "border-left:4px solid #00c853;background:#f2faf4;color:#4a7a58;",
    heading: "geek",
  }),
  guochao: Object.freeze({
    name: "国风朱砂",
    emoji: "🏮",
    color: "#c1272d",
    strong: "#c1272d",
    quote: "border-left:4px solid #c1272d;background:#faf4f0;color:#8c5347;",
    heading: "guochao",
    serif: true,
  }),
});

export const WECHAT_DRAFT_THEMES = Object.freeze(
  Object.entries(WECHAT_DRAFT_THEME_DEFINITIONS).map(([key, theme]) =>
    Object.freeze({
      key,
      name: theme.name,
      emoji: theme.emoji,
      color: theme.color,
    }),
  ),
);

function failure(message, status = 400, code = "WECHAT_DRAFT_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

function normalizeWechatDraftTheme(value) {
  const key = String(value || WECHAT_DRAFT_DEFAULT_THEME)
    .trim()
    .toLowerCase();
  if (!Object.hasOwn(WECHAT_DRAFT_THEME_DEFINITIONS, key)) {
    throw failure("公众号排版主题不存在", 400, "WECHAT_DRAFT_THEME_INVALID");
  }
  return key;
}

export function listWechatDraftThemes() {
  return {
    themes: WECHAT_DRAFT_THEMES.map((theme) => ({ ...theme })),
    default: WECHAT_DRAFT_DEFAULT_THEME,
  };
}

function cleanText(value, max = 240) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw failure(`${label}不正确`, 400, "WECHAT_DRAFT_ID_INVALID");
  }
  return id;
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function tableExists(name) {
  return Boolean(
    q.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name),
  );
}

function configKey(tenantId) {
  return `wechat_mp:${positiveId(tenantId, "租户编号")}`;
}

function readCredentials(tenantId) {
  const value = parseObject(getConfig(configKey(tenantId), {}));
  return {
    appId: cleanText(value.appId || value.appid, 80),
    appSecret: String(value.appSecret || value.secret || "")
      .trim()
      .slice(0, 200),
  };
}

function assertConfigured(credentials) {
  if (!credentials.appId || !credentials.appSecret) {
    throw failure(
      "还没配置微信公众号 AppID / AppSecret",
      409,
      "WECHAT_DRAFT_NOT_CONFIGURED",
    );
  }
}

export function publicWechatConfig(tenantId = curTenant()) {
  const value = readCredentials(tenantId);
  return {
    configured: Boolean(value.appId && value.appSecret),
    appIdSet: Boolean(value.appId),
    appSecretSet: Boolean(value.appSecret),
    credentialsReturned: false,
  };
}

export function saveWechatConfig({ tenantId = curTenant(), appId, appSecret }) {
  const tid = positiveId(tenantId, "租户编号");
  const current = readCredentials(tid);
  const nextAppId = String(appId ?? "").trim() || current.appId;
  const nextSecret = String(appSecret ?? "").trim() || current.appSecret;
  if (!/^[A-Za-z0-9_-]{6,80}$/u.test(nextAppId)) {
    throw failure("AppID 格式不正确", 400, "WECHAT_APP_ID_INVALID");
  }
  if (nextSecret.length < 8 || nextSecret.length > 200) {
    throw failure("AppSecret 格式不正确", 400, "WECHAT_APP_SECRET_INVALID");
  }
  setConfig(configKey(tid), { appId: nextAppId, appSecret: nextSecret });
  return publicWechatConfig(tid);
}

const WECHAT_ERROR_HINTS = Object.freeze({
  40013: "AppID 不正确",
  40125: "AppSecret 不正确或已重置",
  41004: "AppSecret 缺失",
  40001: "AppSecret 已失效",
  40164: "服务器 IP 未加入公众号白名单",
  48001: "该公众号没有草稿箱接口权限",
  45009: "微信接口调用次数超限",
  45110: "公众号草稿箱已满",
  40007: "封面素材无效",
});

export class WechatProviderError extends Error {
  constructor(
    message,
    { code = "WECHAT_PROVIDER_ERROR", status = 502, definitive = false } = {},
  ) {
    super(message);
    this.name = "WechatProviderError";
    this.code = code;
    this.status = status;
    this.definitive = definitive;
  }
}

function assertOfficialCdnUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new WechatProviderError("微信返回的图片地址无效", {
      code: "WECHAT_IMAGE_URL_INVALID",
    });
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !OFFICIAL_CDN_HOSTS.has(parsed.hostname.toLowerCase()) ||
    parsed.username ||
    parsed.password
  ) {
    throw new WechatProviderError("微信返回了非官方素材地址", {
      code: "WECHAT_IMAGE_URL_UNTRUSTED",
    });
  }
  parsed.protocol = "https:";
  return parsed.toString();
}

function providerErrorFromPayload(payload) {
  const errcode = Number(payload?.errcode || 0);
  if (!errcode) return null;
  return new WechatProviderError(
    `${WECHAT_ERROR_HINTS[errcode] || "微信接口明确拒绝了请求"}（${errcode}）`,
    {
      code: `WECHAT_${errcode}`,
      status: 400,
      definitive: true,
    },
  );
}

export class OfficialWechatDraftProvider {
  constructor({ fetchFn = globalThis.fetch, timeoutMs = 60_000 } = {}) {
    if (typeof fetchFn !== "function") throw new Error("fetchFn is required");
    this.fetchFn = fetchFn;
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || 60_000);
    this.tokens = new Map();
  }

  async request(url, init = {}) {
    if (!(url instanceof URL) || url.origin !== OFFICIAL_API_ORIGIN) {
      throw new WechatProviderError("微信 API 地址不在官方允许列表", {
        code: "WECHAT_API_ORIGIN_INVALID",
      });
    }
    try {
      const response = await this.fetchFn(url, {
        ...init,
        redirect: "error",
        signal: init.signal || AbortSignal.timeout(this.timeoutMs),
      });
      if (!response?.ok) {
        throw new WechatProviderError("微信 API 暂时不可用", {
          code: "WECHAT_HTTP_ERROR",
          status: 502,
        });
      }
      const payload = await response.json();
      const explicit = providerErrorFromPayload(payload);
      if (explicit) throw explicit;
      return payload;
    } catch (error) {
      if (error instanceof WechatProviderError) throw error;
      throw new WechatProviderError("微信 API 请求结果不确定", {
        code:
          error?.name === "TimeoutError"
            ? "WECHAT_TIMEOUT"
            : "WECHAT_NETWORK_UNCERTAIN",
        status: 503,
        definitive: false,
      });
    }
  }

  async accessToken({ tenantId, credentials, force = false }) {
    assertConfigured(credentials);
    const fingerprint = sha256(`${credentials.appId}:${credentials.appSecret}`);
    const cached = this.tokens.get(Number(tenantId));
    if (
      !force &&
      cached?.fingerprint === fingerprint &&
      cached.expiresAt > Date.now() + 120_000
    ) {
      return cached.token;
    }
    const url = new URL("/cgi-bin/stable_token", OFFICIAL_API_ORIGIN);
    const payload = await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credential",
        appid: credentials.appId,
        secret: credentials.appSecret,
        force_refresh: Boolean(force),
      }),
    });
    const token = String(payload.access_token || "").trim();
    if (!token) {
      throw new WechatProviderError("微信未返回有效访问令牌", {
        code: "WECHAT_TOKEN_MISSING",
      });
    }
    this.tokens.set(Number(tenantId), {
      fingerprint,
      token,
      expiresAt:
        Date.now() + Math.max(300, Number(payload.expires_in) || 7200) * 1000,
    });
    return token;
  }

  async testConnection(input) {
    await this.accessToken({ ...input, force: true });
    return { ok: true };
  }

  async uploadContentImage({
    tenantId,
    credentials,
    bytes,
    filename = "content.jpg",
  }) {
    const token = await this.accessToken({ tenantId, credentials });
    const url = new URL("/cgi-bin/media/uploadimg", OFFICIAL_API_ORIGIN);
    url.searchParams.set("access_token", token);
    const form = new FormData();
    form.append(
      "media",
      new Blob([bytes], { type: detectImage(bytes).mime }),
      filename,
    );
    const payload = await this.request(url, { method: "POST", body: form });
    return { url: assertOfficialCdnUrl(payload.url) };
  }

  async uploadCover({ tenantId, credentials, bytes, filename = "cover.png" }) {
    const token = await this.accessToken({ tenantId, credentials });
    const url = new URL("/cgi-bin/material/add_material", OFFICIAL_API_ORIGIN);
    url.searchParams.set("access_token", token);
    url.searchParams.set("type", "image");
    const form = new FormData();
    form.append(
      "media",
      new Blob([bytes], { type: detectImage(bytes).mime }),
      filename,
    );
    const payload = await this.request(url, { method: "POST", body: form });
    const mediaId = cleanText(payload.media_id, 200);
    if (!mediaId) {
      throw new WechatProviderError("微信未返回封面素材编号", {
        code: "WECHAT_COVER_MEDIA_ID_MISSING",
      });
    }
    return { mediaId };
  }

  async addDraft({ tenantId, credentials, article }) {
    const token = await this.accessToken({ tenantId, credentials });
    const url = new URL("/cgi-bin/draft/add", OFFICIAL_API_ORIGIN);
    url.searchParams.set("access_token", token);
    const payload = await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ articles: [article] }),
    });
    return { mediaId: cleanText(payload.media_id, 200) };
  }

  async findDraftByMarker({ tenantId, credentials, marker }) {
    const token = await this.accessToken({ tenantId, credentials });
    let offset = 0;
    for (let page = 0; page < 4; page += 1) {
      const url = new URL("/cgi-bin/draft/batchget", OFFICIAL_API_ORIGIN);
      url.searchParams.set("access_token", token);
      const payload = await this.request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offset, count: 20, no_content: 0 }),
      });
      const items = Array.isArray(payload.item) ? payload.item : [];
      for (const item of items) {
        const articles = Array.isArray(item?.content?.news_item)
          ? item.content.news_item
          : [];
        if (
          articles.some((entry) =>
            String(entry?.content || "").includes(marker),
          )
        ) {
          return { mediaId: cleanText(item.media_id, 200) };
        }
      }
      offset += items.length;
      if (!items.length || offset >= Number(payload.total_count || 0)) break;
    }
    return { mediaId: "" };
  }
}

function detectImage(bytes) {
  const value = Buffer.from(bytes || []);
  if (
    value.length >= 8 &&
    value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return { ext: "png", mime: "image/png" };
  }
  if (
    value.length >= 3 &&
    value[0] === 0xff &&
    value[1] === 0xd8 &&
    value[2] === 0xff
  ) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  throw failure(
    "公众号素材只接受真实 PNG / JPEG 图片",
    409,
    "WECHAT_IMAGE_INVALID",
  );
}

function resolveTenantImage(tenantId, fileId) {
  const id = positiveId(fileId, "图片素材编号");
  const row = q.get(
    `SELECT id,name,file_path,file_url,mime,size,purpose FROM uploaded_files
    WHERE tenant_id=? AND id=?`,
    tenantId,
    id,
  );
  if (!row) {
    throw failure(
      "图片素材不存在或不属于当前企业",
      404,
      "WECHAT_IMAGE_NOT_FOUND",
    );
  }
  let root;
  let absolute;
  try {
    root = fs.realpathSync(path.join(UPLOAD_ROOT, String(tenantId)));
    absolute = fs.realpathSync(path.resolve(String(row.file_path || "")));
  } catch {
    throw failure("图片素材文件已丢失", 409, "WECHAT_IMAGE_MISSING");
  }
  const stat = fs.lstatSync(absolute);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    !absolute.startsWith(`${root}${path.sep}`) ||
    stat.size <= 0 ||
    stat.size > MAX_IMAGE_BYTES ||
    stat.size !== Number(row.size || 0)
  ) {
    throw failure(
      "图片素材完整性校验失败",
      409,
      "WECHAT_IMAGE_INTEGRITY_INVALID",
    );
  }
  const bytes = fs.readFileSync(absolute);
  const format = detectImage(bytes);
  if (
    row.mime &&
    !new Set([format.mime, format.ext === "jpg" ? "image/jpg" : ""]).has(
      String(row.mime),
    )
  ) {
    throw failure(
      "图片素材声明类型与内容不一致",
      409,
      "WECHAT_IMAGE_MIME_MISMATCH",
    );
  }
  return {
    id,
    name: path.basename(cleanText(row.name, 180) || `image.${format.ext}`),
    bytes,
    format,
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  const out = Buffer.alloc(4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return out;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([
    length,
    name,
    data,
    crc32(Buffer.concat([name, data])),
  ]);
}

let cachedCoverFont = null;

function coverFont() {
  if (cachedCoverFont) return cachedCoverFont;
  try {
    cachedCoverFont = fontkit.openSync(COVER_FONT_PATH);
  } catch {
    throw failure(
      "默认封面字体不可用，请手动上传封面",
      409,
      "WECHAT_COVER_FONT_UNAVAILABLE",
    );
  }
  return cachedCoverFont;
}

function transformedPoint(x, y, transform) {
  return {
    x: transform.originX + Number(x || 0) * transform.scale,
    y: transform.baselineY - Number(y || 0) * transform.scale,
  };
}

function flattenGlyphPath(glyph, transform) {
  const contours = [];
  let contour = [];
  let current = { x: 0, y: 0 };
  let start = null;
  const finish = () => {
    if (contour.length > 2) {
      if (
        contour[0].x !== contour.at(-1).x ||
        contour[0].y !== contour.at(-1).y
      )
        contour.push({ ...contour[0] });
      contours.push(contour);
    }
    contour = [];
    start = null;
  };
  for (const command of glyph.path.commands || []) {
    const args = command.args || [];
    if (command.command === "moveTo") {
      finish();
      current = { x: Number(args[0]), y: Number(args[1]) };
      start = { ...current };
      contour.push(transformedPoint(current.x, current.y, transform));
    } else if (command.command === "lineTo") {
      current = { x: Number(args[0]), y: Number(args[1]) };
      contour.push(transformedPoint(current.x, current.y, transform));
    } else if (command.command === "quadraticCurveTo") {
      const from = { ...current };
      const control = { x: Number(args[0]), y: Number(args[1]) };
      const to = { x: Number(args[2]), y: Number(args[3]) };
      for (let step = 1; step <= 8; step += 1) {
        const t = step / 8;
        const inverse = 1 - t;
        contour.push(
          transformedPoint(
            inverse * inverse * from.x +
              2 * inverse * t * control.x +
              t * t * to.x,
            inverse * inverse * from.y +
              2 * inverse * t * control.y +
              t * t * to.y,
            transform,
          ),
        );
      }
      current = to;
    } else if (command.command === "bezierCurveTo") {
      const from = { ...current };
      const controlA = { x: Number(args[0]), y: Number(args[1]) };
      const controlB = { x: Number(args[2]), y: Number(args[3]) };
      const to = { x: Number(args[4]), y: Number(args[5]) };
      for (let step = 1; step <= 10; step += 1) {
        const t = step / 10;
        const inverse = 1 - t;
        contour.push(
          transformedPoint(
            inverse ** 3 * from.x +
              3 * inverse * inverse * t * controlA.x +
              3 * inverse * t * t * controlB.x +
              t ** 3 * to.x,
            inverse ** 3 * from.y +
              3 * inverse * inverse * t * controlA.y +
              3 * inverse * t * t * controlB.y +
              t ** 3 * to.y,
            transform,
          ),
        );
      }
      current = to;
    } else if (command.command === "closePath") {
      if (start) current = { ...start };
      finish();
    }
  }
  finish();
  return contours;
}

function fillContours(mask, maskWidth, maskHeight, contours) {
  const points = contours.flat();
  if (!points.length) return;
  const minY = Math.max(
    0,
    Math.floor(Math.min(...points.map((point) => point.y))),
  );
  const maxY = Math.min(
    maskHeight - 1,
    Math.ceil(Math.max(...points.map((point) => point.y))),
  );
  for (let y = minY; y <= maxY; y += 1) {
    const scanY = y + 0.5;
    const intersections = [];
    for (const contour of contours) {
      for (let index = 1; index < contour.length; index += 1) {
        const left = contour[index - 1];
        const right = contour[index];
        if (
          (left.y <= scanY && right.y > scanY) ||
          (right.y <= scanY && left.y > scanY)
        ) {
          intersections.push(
            left.x +
              ((scanY - left.y) * (right.x - left.x)) / (right.y - left.y),
          );
        }
      }
    }
    intersections.sort((a, b) => a - b);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const startX = Math.max(0, Math.ceil(intersections[index] - 0.5));
      const endX = Math.min(
        maskWidth - 1,
        Math.floor(intersections[index + 1] - 0.5),
      );
      if (endX >= startX)
        mask.fill(1, y * maskWidth + startX, y * maskWidth + endX + 1);
    }
  }
}

function drawCoverTitle(raw, width, height, title) {
  const font = coverFont();
  const oversample = 2;
  const maskWidth = width * oversample;
  const maskHeight = height * oversample;
  const mask = new Uint8Array(maskWidth * maskHeight);
  const text = [...cleanText(title, 48)].slice(0, 24).join("") || "NanoWork";
  const lines = [];
  for (let index = 0; index < text.length; index += 12) {
    lines.push(text.slice(index, index + 12));
    if (lines.length === 2) break;
  }
  const fontSize = 56;
  const scale = (fontSize / Number(font.unitsPerEm || 1_000)) * oversample;
  const lineHeight = 74 * oversample;
  const blockTop = (maskHeight - lines.length * lineHeight) / 2;
  for (const [lineIndex, line] of lines.entries()) {
    const run = font.layout(line);
    const advance = run.positions.reduce(
      (sum, position) => sum + Number(position.xAdvance || 0),
      0,
    );
    let penX = 0;
    const startX = (maskWidth - advance * scale) / 2;
    const baselineY =
      blockTop + lineIndex * lineHeight + Number(font.ascent || 1_000) * scale;
    for (let index = 0; index < run.glyphs.length; index += 1) {
      const position = run.positions[index];
      const contours = flattenGlyphPath(run.glyphs[index], {
        originX: startX + (penX + Number(position.xOffset || 0)) * scale,
        baselineY: baselineY - Number(position.yOffset || 0) * scale,
        scale,
      });
      fillContours(mask, maskWidth, maskHeight, contours);
      penX += Number(position.xAdvance || 0);
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const topLeft = y * oversample * maskWidth + x * oversample;
      const coverage =
        mask[topLeft] +
        mask[topLeft + 1] +
        mask[topLeft + maskWidth] +
        mask[topLeft + maskWidth + 1];
      if (!coverage) continue;
      const alpha = coverage / 4;
      const pixel = y * (1 + width * 3) + 1 + x * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        raw[pixel + channel] = Math.round(
          raw[pixel + channel] + (255 - raw[pixel + channel]) * alpha,
        );
      }
    }
  }
}

function coverBaseColor(title, accentColor) {
  const match = /^#([a-f0-9]{6})$/iu.exec(String(accentColor || ""));
  if (match) {
    const value = Number.parseInt(match[1], 16);
    return [
      Math.max(18, Math.round(((value >> 16) & 0xff) * 0.72)),
      Math.max(18, Math.round(((value >> 8) & 0xff) * 0.72)),
      Math.max(18, Math.round((value & 0xff) * 0.72)),
    ];
  }
  const digest = crypto
    .createHash("sha256")
    .update(String(title || "NanoWork"))
    .digest();
  return [digest[0] % 150, 70 + (digest[1] % 120), 90 + (digest[2] % 130)];
}

export function createWechatDefaultCover(title, accentColor = "") {
  const width = 900;
  const height = 383;
  const rgb = coverBaseColor(title, accentColor);
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = Math.min(
        255,
        rgb[0] + Math.floor((x / width) * 45),
      );
      raw[row + 2 + x * 3] = Math.min(
        255,
        rgb[1] + Math.floor((x / width) * 35),
      );
      raw[row + 3 + x * 3] = Math.min(
        255,
        rgb[2] + Math.floor((x / width) * 25),
      );
    }
  }
  drawCoverTitle(raw, width, height, title);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function selectWechatDraftCover({
  explicitCover = null,
  providerCover = null,
  providerImages = [],
  title = "",
  theme = WECHAT_DRAFT_DEFAULT_THEME,
} = {}) {
  if (explicitCover) return { image: explicitCover, origin: "explicit" };
  if (providerCover) return { image: providerCover, origin: "pipeline_cover" };
  const firstProviderImage = Array.isArray(providerImages)
    ? providerImages[0]
    : null;
  if (firstProviderImage) {
    return { image: firstProviderImage, origin: "pipeline_body_first" };
  }
  const themeKey = normalizeWechatDraftTheme(theme);
  return {
    image: {
      id: null,
      name: "nanowork-cover.png",
      bytes: createWechatDefaultCover(
        title,
        WECHAT_DRAFT_THEME_DEFINITIONS[themeKey].color,
      ),
      format: { ext: "png", mime: "image/png" },
    },
    origin: "generated_title",
  };
}

function runImageProcess(
  command,
  args,
  bytes,
  {
    timeoutMs = IMAGE_PROCESS_TIMEOUT_MS,
    maxOutputBytes = MAX_IMAGE_BYTES,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    let outputBytes = 0;
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("image processing timed out"));
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => finish(error));
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGKILL");
        finish(new Error("image processing output exceeded limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 2_000)
        stderr += String(chunk).slice(0, 2_000 - stderr.length);
    });
    child.once("close", (code) => {
      if (code !== 0) {
        finish(
          new Error(`image processing failed (${code}): ${stderr.slice(-300)}`),
        );
        return;
      }
      finish(null, Buffer.concat(stdout));
    });
    child.stdin.once("error", (error) => finish(error));
    child.stdin.end(bytes);
  });
}

export function createWechatImageProcessor({
  // 统一解析器兜底：launchd 的最小 PATH 找不到裸命令时改用绝对路径。
  ffmpegPath = process.env.WECHAT_IMAGE_FFMPEG_PATH ||
    process.env.FFMPEG_PATH ||
    resolveFfmpeg() ||
    "ffmpeg",
  runner = runImageProcess,
} = {}) {
  return Object.freeze({
    async toJpegUnderLimit({
      bytes,
      maxBytes = MAX_WECHAT_CONTENT_IMAGE_BYTES,
    }) {
      const input = Buffer.from(bytes || []);
      for (const width of [1_200, 960, 760, 600]) {
        for (const quality of [3, 7, 11, 15]) {
          let output;
          try {
            output = await runner(
              ffmpegPath,
              [
                "-hide_banner",
                "-loglevel",
                "error",
                "-threads",
                "1",
                "-i",
                "pipe:0",
                "-vf",
                `scale=w='min(${width},iw)':h=-2`,
                "-frames:v",
                "1",
                "-an",
                "-c:v",
                "mjpeg",
                "-q:v",
                String(quality),
                "-pix_fmt",
                "yuvj420p",
                "-f",
                "image2pipe",
                "pipe:1",
              ],
              input,
              { maxOutputBytes: MAX_IMAGE_BYTES },
            );
          } catch {
            output = null;
          }
          if (output && output.length > 0 && output.length <= maxBytes) {
            try {
              if (detectImage(output).mime === "image/jpeg") {
                return {
                  bytes: output,
                  filenameExtension: "jpg",
                  mime: "image/jpeg",
                };
              }
            } catch {
              // 无效输出继续降质/缩小，绝不上传未验证字节。
            }
          }
        }
      }
      throw failure(
        "图片无法在本地压缩到 990KB 以内，请换图后重试",
        409,
        "WECHAT_IMAGE_COMPRESSION_FAILED",
      );
    },
  });
}

async function normalizedWechatImage(image, imageProcessor) {
  if (image.bytes.length <= MAX_WECHAT_CONTENT_IMAGE_BYTES) return image;
  const converted = await imageProcessor.toJpegUnderLimit({
    bytes: image.bytes,
    filename: image.name,
    maxBytes: MAX_WECHAT_CONTENT_IMAGE_BYTES,
  });
  const bytes = Buffer.from(converted?.bytes || []);
  if (
    bytes.length <= 0 ||
    bytes.length > MAX_WECHAT_CONTENT_IMAGE_BYTES ||
    detectImage(bytes).mime !== "image/jpeg"
  ) {
    throw failure(
      "图片本地压缩结果无效",
      409,
      "WECHAT_IMAGE_COMPRESSION_INVALID",
    );
  }
  return {
    ...image,
    name: `${path.basename(image.name, path.extname(image.name)) || "image"}.jpg`,
    bytes,
    format: { ext: "jpg", mime: "image/jpeg" },
  };
}

function escapeHtml(value) {
  return String(value || "").replace(
    /[&<>"']/gu,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function decodeLinkEntities(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"');
}

function themeDefinition(themeValue) {
  const key = normalizeWechatDraftTheme(themeValue);
  return { key, ...WECHAT_DRAFT_THEME_DEFINITIONS[key] };
}

function wechatBaseFont(theme) {
  return theme.serif
    ? "Optima-Regular,PingFangTC-light,'Songti SC',STSong,'Noto Serif CJK SC',serif"
    : "-apple-system,BlinkMacSystemFont,'Helvetica Neue','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
}

function themedHeading(theme, text, number) {
  const common = "margin:28px 0 16px";
  if (theme.heading === "bar") {
    return `<section style="margin:30px 0 16px"><span style="display:inline-block;border-left:6px solid #111;padding-left:12px;font-size:18px;font-weight:800;color:#111;letter-spacing:1px">${text}</span></section>`;
  }
  if (theme.heading === "numbered") {
    return `<section style="${common}"><span style="font-size:22px;font-weight:800;color:#1e6fff;font-style:italic">${String(number).padStart(2, "0")}</span><span style="display:inline-block;margin-left:10px;font-size:17px;font-weight:700;color:#222;border-bottom:3px solid #1e6fff;padding-bottom:4px">${text}</span></section>`;
  }
  if (theme.heading === "highlight") {
    return `<section style="${common}"><span style="display:inline-block;font-size:17px;font-weight:700;color:#00875a;background:linear-gradient(to top,#c9f4dd 40%,transparent 40%);padding:0 6px">${text}</span></section>`;
  }
  if (theme.heading === "violet") {
    return `<section style="${common};text-align:center"><span style="display:inline-block;background:linear-gradient(90deg,#8a4baf,#c084fc);color:#fff;font-size:17px;font-weight:700;padding:7px 24px;border-radius:6px;box-shadow:3px 3px 0 #ead6f8">${text}</span></section>`;
  }
  if (theme.heading === "scarlet") {
    return `<section style="${common}"><span style="display:inline-block;background:#fdecee;border-left:5px solid #e63946;color:#c1121f;font-size:17px;font-weight:700;padding:7px 14px">${text}</span></section>`;
  }
  if (theme.heading === "aqua") {
    return `<section style="${common};text-align:center"><span style="display:inline-block;background:linear-gradient(120deg,#4facfe,#00f2fe);color:#fff;font-size:17px;font-weight:700;padding:7px 26px;border-radius:99px 4px 99px 4px">${text}</span></section>`;
  }
  if (theme.heading === "magazine") {
    return `<section style="margin:34px 0 18px;text-align:center"><span style="font-size:13px;color:#c0a062;letter-spacing:4px">—&nbsp;&nbsp;</span><span style="font-size:18px;font-weight:700;color:#333;letter-spacing:2px">${text}</span><span style="font-size:13px;color:#c0a062;letter-spacing:4px">&nbsp;&nbsp;—</span></section>`;
  }
  if (theme.heading === "sakura") {
    return `<section style="${common}"><span style="display:inline-block;background:#fff0f6;border:2px dashed #ff7eb3;color:#e05a92;font-size:17px;font-weight:700;padding:6px 18px;border-radius:16px">${text}</span></section>`;
  }
  if (theme.heading === "gold") {
    return `<section style="${common}"><span style="display:inline-block;background:#1f2430;color:#e6c26e;font-size:17px;font-weight:700;padding:7px 18px;border-radius:4px;letter-spacing:1px">${text}</span></section>`;
  }
  if (theme.heading === "geek") {
    return `<section style="${common}"><span style="font-family:Menlo,Consolas,monospace;color:#00a344;font-size:17px;font-weight:700"><span style="color:#bbb">##&nbsp;</span>${text}</span><section style="height:2px;background:linear-gradient(90deg,#00c853,transparent);margin-top:6px;max-width:280px"></section></section>`;
  }
  if (theme.heading === "guochao") {
    return `<section style="margin:30px 0 16px;text-align:center"><span style="color:#c1272d;font-size:18px">「</span><span style="font-size:18px;font-weight:700;color:#3a3a3a;letter-spacing:2px">${text}</span><span style="color:#c1272d;font-size:18px">」</span></section>`;
  }
  return `<section style="${common};text-align:left"><span style="display:inline-block;background:linear-gradient(90deg,#ff7f2a,#ffb347);color:#fff;font-size:17px;font-weight:700;padding:6px 16px;border-radius:99px">${text}</span></section>`;
}

function renderInlineMarkdown(value, theme, refs) {
  const code = [];
  const links = [];
  const preserveLink = (html) => {
    const index = links.push(html) - 1;
    return `\uE000LINK${index}\uE001`;
  };
  let html = escapeHtml(
    String(value || "").replace(/!\[[^\]\n]*\]\([^\n)]*\)/gu, ""),
  );
  html = html.replace(/`([^`\n]+)`/gu, (_match, text) => {
    const index =
      code.push(
        `<code style="background:rgba(27,31,35,.05);color:${theme.color};padding:2px 5px;border-radius:3px;font-size:13.5px;font-family:Menlo,Consolas,monospace">${text}</code>`,
      ) - 1;
    return `\uE000CODE${index}\uE001`;
  });
  html = html.replace(
    /\[([^\]\n]{1,500})\]\((https?:\/\/[^\s<>\n)]{1,2000})\)/giu,
    (_match, label, escapedHref) => {
      let parsed;
      try {
        parsed = new URL(decodeLinkEntities(escapedHref));
      } catch {
        return label;
      }
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password
      )
        return label;
      const hostname = parsed.hostname.toLowerCase();
      if (
        parsed.protocol === "https:" &&
        (hostname === "mp.weixin.qq.com" ||
          hostname.endsWith(".mp.weixin.qq.com"))
      ) {
        return preserveLink(
          `<a href="${escapeHtml(parsed.toString())}" style="color:${theme.color};text-decoration:none">${label}</a>`,
        );
      }
      if (refs.length >= 100) return label;
      refs.push({
        label: decodeLinkEntities(label).replace(/[*_`]/gu, ""),
        url: parsed.toString(),
      });
      return preserveLink(
        `<span style="color:${theme.color}">${label}<sup style="font-size:11px">[${refs.length}]</sup></span>`,
      );
    },
  );
  html = html
    .replace(
      /\*\*([^*\n]+)\*\*/gu,
      `<strong style="color:${theme.strong}">$1</strong>`,
    )
    .replace(
      /__([^_\n]+)__/gu,
      `<strong style="color:${theme.strong}">$1</strong>`,
    )
    .replace(
      /(^|[^*])\*([^*\n]+)\*(?!\*)/gu,
      '$1<em style="color:#888">$2</em>',
    )
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/gu, '$1<em style="color:#888">$2</em>');
  return html
    .replace(
      /\uE000LINK(\d+)\uE001/gu,
      (_match, index) => links[Number(index)] || "",
    )
    .replace(
      /\uE000CODE(\d+)\uE001/gu,
      (_match, index) => code[Number(index)] || "",
    );
}

function markdownCells(line) {
  const trimmed = String(line || "")
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isMarkdownTable(lines, index) {
  if (!String(lines[index] || "").includes("|")) return false;
  const separators = markdownCells(lines[index + 1]);
  return (
    separators.length > 0 &&
    separators.every((cell) => /^:?-{3,}:?$/u.test(cell))
  );
}

function startsMarkdownBlock(lines, index) {
  const line = String(lines[index] || "");
  return (
    /^\s*```/u.test(line) ||
    /^#{1,6}\s+/u.test(line) ||
    /^\s*>/u.test(line) ||
    /^\s*[-+*]\s+/u.test(line) ||
    /^\s*\d+[.)]\s+/u.test(line) ||
    /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line) ||
    isMarkdownTable(lines, index)
  );
}

function renderMarkdownBlocks(body, theme, refs) {
  const lines = String(body || "")
    .replace(/\r\n?/gu, "\n")
    .split("\n");
  const blocks = [];
  let headingNumber = 0;
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = /^\s*```[^\n]*$/u.test(line);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/u.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        `<pre style="background:#282c34;color:#abb2bf;padding:14px;border-radius:6px;overflow-x:auto;font-size:13px;line-height:1.6;margin:0 0 18px"><code style="font-family:Menlo,Consolas,monospace">${escapeHtml(code.join("\n"))}</code></pre>`,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      const text = renderInlineMarkdown(heading[2], theme, refs);
      if (heading[1].length <= 2) {
        headingNumber += 1;
        blocks.push(themedHeading(theme, text, headingNumber));
      } else if (heading[1].length === 3) {
        blocks.push(
          `<section style="margin:22px 0 12px"><span style="font-size:16px;font-weight:700;color:${theme.color}">◆ ${text}</span></section>`,
        );
      } else {
        blocks.push(
          `<section style="margin:18px 0 10px;font-size:15.5px;font-weight:700;color:#333">${text}</section>`,
        );
      }
      index += 1;
      continue;
    }
    if (/^\s*>/u.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>/u.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/u, ""));
        index += 1;
      }
      blocks.push(
        `<blockquote style="margin:20px 0;padding:14px 16px;border-radius:4px;font-size:14.5px;line-height:1.8;${theme.quote}">${quote.map((item) => renderInlineMarkdown(item, theme, refs)).join("<br />")}</blockquote>`,
      );
      continue;
    }
    const unordered = /^\s*[-+*]\s+(.+)$/u.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/u.exec(line);
    if (unordered || ordered) {
      const tag = unordered ? "ul" : "ol";
      const items = [];
      const matcher = unordered ? /^\s*[-+*]\s+(.+)$/u : /^\s*\d+[.)]\s+(.+)$/u;
      while (index < lines.length) {
        const item = matcher.exec(lines[index]);
        if (!item) break;
        items.push(
          `<li style="margin:6px 0;font-size:15.5px;color:#3a3a3a;line-height:1.8;letter-spacing:.5px">${renderInlineMarkdown(item[1], theme, refs)}</li>`,
        );
        index += 1;
      }
      const padding = tag === "ul" ? 22 : 24;
      blocks.push(
        `<${tag} style="margin:0 0 18px;padding-left:${padding}px">${items.join("")}</${tag}>`,
      );
      continue;
    }
    if (isMarkdownTable(lines, index)) {
      const headers = markdownCells(lines[index]);
      index += 2;
      const rows = [];
      while (
        index < lines.length &&
        lines[index].includes("|") &&
        lines[index].trim()
      ) {
        rows.push(markdownCells(lines[index]));
        index += 1;
      }
      const head = headers
        .map(
          (cell) =>
            `<th style="border:1px solid #ddd;padding:8px;background:${theme.color};color:#fff;font-weight:700">${renderInlineMarkdown(cell, theme, refs)}</th>`,
        )
        .join("");
      const bodyRows = rows
        .map(
          (cells) =>
            `<tr>${headers.map((_header, cellIndex) => `<td style="border:1px solid #ddd;padding:8px;color:#3a3a3a">${renderInlineMarkdown(cells[cellIndex] || "", theme, refs)}</td>`).join("")}</tr>`,
        )
        .join("");
      blocks.push(
        `<table style="border-collapse:collapse;margin:0 0 18px;width:100%;font-size:14px"><thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody></table>`,
      );
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
      blocks.push(
        `<section style="margin:26px 0;height:1px;background:linear-gradient(90deg,transparent,${theme.color},transparent)"></section>`,
      );
      index += 1;
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !startsMarkdownBlock(lines, index)
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(
      `<p style="margin:0 0 18px;font-size:15.5px;color:#3a3a3a;line-height:1.85;letter-spacing:.6px;text-align:justify">${paragraph.map((item) => renderInlineMarkdown(item, theme, refs)).join("<br />")}</p>`,
    );
  }
  return blocks.join("");
}

function weaveWechatImages(html, imageUrls) {
  const figures = imageUrls.map(
    (url) =>
      `<section style="margin:8px 0 20px;text-align:center"><img src="${escapeHtml(url)}" style="max-width:100%;border-radius:8px;display:block;margin:0 auto" /></section>`,
  );
  if (!figures.length) return html;
  const paragraphs = html.split("</p>");
  if (paragraphs.length <= 1) return html + figures.join("");
  const slots = paragraphs.length - 1;
  const step = Math.max(2, Math.round(slots / figures.length));
  const output = [];
  let used = 0;
  for (let index = 0; index < paragraphs.length; index += 1) {
    output.push(paragraphs[index]);
    if (index >= paragraphs.length - 1) continue;
    output.push("</p>");
    if (used < figures.length && (index + 1) % step === 0) {
      output.push(figures[used]);
      used += 1;
    }
  }
  while (used < figures.length) {
    output.push(figures[used]);
    used += 1;
  }
  return output.join("");
}

export function renderWechatDraftHtml({
  title = "",
  body = "",
  imageUrls = [],
  marker = "",
  theme = WECHAT_DRAFT_DEFAULT_THEME,
} = {}) {
  const selectedTheme = themeDefinition(theme);
  const source = String(body || "")
    .slice(0, MAX_BODY_CHARS)
    .replace(/^#\s+.+(?:\n+|$)/u, "")
    .trim();
  const refs = [];
  const trustedImages = (Array.isArray(imageUrls) ? imageUrls : [])
    .slice(0, MAX_CONTENT_IMAGES)
    .map(assertOfficialCdnUrl);
  let html = weaveWechatImages(
    renderMarkdownBlocks(source, selectedTheme, refs),
    trustedImages,
  );
  if (refs.length) {
    const items = refs
      .map(
        (item, index) =>
          `<section style="margin:4px 0;font-size:12.5px;color:#999;word-break:break-all">[${index + 1}] ${escapeHtml(item.label)}: ${escapeHtml(item.url)}</section>`,
      )
      .join("");
    html += `<section style="margin-top:26px;padding-top:12px;border-top:1px dashed #ddd"><section style="font-size:13px;color:#888;font-weight:700;margin-bottom:6px">参考链接</section>${items}</section>`;
  }
  html += `<section style="text-align:center;margin:34px 0 8px"><span style="display:inline-block;font-size:13px;color:${selectedTheme.color};font-weight:700;letter-spacing:6px">· END ·</span><section style="font-size:12.5px;color:#bbb;margin-top:10px">喜欢这篇的话，点个「赞」和「在看」再走吧&nbsp;👇</section></section>`;
  const safeMarker = String(marker || "")
    .replace(/[^a-z0-9:._-]/giu, "")
    .slice(0, 160);
  return `<section style="font-family:${wechatBaseFont(selectedTheme)};padding:4px 2px;background:#fff" data-paihuo-theme="${selectedTheme.key}">${html}</section>\n<!-- ${safeMarker} -->`;
}

function findWechatVersion(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findWechatVersion(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const platform = cleanText(value.platform || value.channel, 30).toLowerCase();
  if (["公众号", "wechat", "weixin", "微信公众号"].includes(platform)) {
    return value;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (
      String(key).includes("公众号") &&
      nested &&
      typeof nested === "object"
    ) {
      return nested;
    }
    const found = findWechatVersion(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

function sourceFromContent(tenantId, sourceId) {
  const row = q.get(
    `SELECT id,title,body,status,source_type,source_id,ai_mode,created_at
    FROM contents WHERE tenant_id=? AND id=?`,
    tenantId,
    sourceId,
  );
  if (!row) throw failure("内容产物不存在", 404, "WECHAT_SOURCE_NOT_FOUND");
  assertContentDeliverable(row.id, {
    tenantId,
    action: "创建微信公众号草稿",
  });
  const body = String(row.body || "").trim();
  if (!body)
    throw failure("内容产物没有可投递正文", 409, "WECHAT_SOURCE_EMPTY");
  const title = cleanText(row.title, 60) || "未命名内容";
  return {
    sourceType: "content",
    sourceId: Number(row.id),
    title,
    digest: cleanText(body, 110),
    body,
    providerAssets: { images: [], cover: null },
    fingerprint: sha256(JSON.stringify({ title, body, status: row.status })),
    sourceDeepLink: `/content?contentId=${row.id}`,
    createdAt: row.created_at,
  };
}

function settledHoldRecord({
  tenantId,
  holdId,
  refType,
  refId,
  chargedCredits,
  requireTokenUsage = false,
}) {
  const id = Number(holdId);
  if (!Number.isSafeInteger(id) || id <= 0 || !tableExists("credit_holds")) {
    return false;
  }
  const row = q.get(
    `SELECT h.status,h.settled_credits,h.ref_type,h.ref_id,
      l.id ledger_id,l.credits ledger_credits,l.ai_mode,l.input_tokens,l.output_tokens
    FROM credit_holds h
    LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
    WHERE h.tenant_id=? AND h.id=?`,
    tenantId,
    id,
  );
  const settled = Number(row?.settled_credits);
  const expected = Number(chargedCredits);
  return Boolean(
    row &&
    row.status === "settled" &&
    Number.isFinite(expected) &&
    expected >= 0 &&
    settled === expected &&
    Number(row.ledger_credits) === settled &&
    Number.isSafeInteger(Number(row.ledger_id)) &&
    String(row.ref_type || "") === String(refType || "") &&
    Number(row.ref_id) === Number(refId) &&
    (!requireTokenUsage ||
      (String(row.ai_mode || "").toLowerCase() === "api" &&
        Number(row.input_tokens || 0) + Number(row.output_tokens || 0) > 0)),
  );
}

function settledPipelineBilling(
  value,
  { tenantId, pipelineId, stationIdx = 8 },
) {
  const billing = parseObject(value);
  const state = String(
    billing.state || billing.billingState || billing.status || "",
  ).toLowerCase();
  const charged = Number(billing.chargedCredits ?? billing.credits);
  if (
    state !== "settled" ||
    billing.pendingReconciliation === true ||
    Number(billing.heldCredits || 0) !== 0 ||
    !Number.isFinite(charged) ||
    charged < 0
  )
    return false;

  const components = parseObject(billing.components);
  const primary = Object.keys(parseObject(components.stationText)).length
    ? parseObject(components.stationText)
    : billing;
  const primaryCharged = Number(primary.chargedCredits ?? primary.credits);
  const stationRefId = Number(pipelineId) * 10 + Number(stationIdx) + 1;
  if (
    !settledHoldRecord({
      tenantId,
      holdId: primary.holdId,
      refType: "content_production_pipeline_station",
      refId: stationRefId,
      chargedCredits: primaryCharged,
      requireTokenUsage: true,
    })
  )
    return false;

  const specialProviders = Array.isArray(components.specialProviders)
    ? components.specialProviders
    : [];
  let componentCredits = primaryCharged;
  for (const item of specialProviders) {
    const providerBilling = parseObject(item?.billing);
    const providerCharged = Number(
      providerBilling.chargedCredits ?? providerBilling.credits,
    );
    if (
      String(providerBilling.state || item?.status || "").toLowerCase() !==
        "settled" ||
      providerBilling.pendingReconciliation === true ||
      Number(providerBilling.heldCredits || 0) !== 0 ||
      item?.delivery?.persisted !== true ||
      !settledHoldRecord({
        tenantId,
        holdId: item?.holdId || providerBilling.holdId,
        refType: item?.refType,
        refId: item?.refId,
        chargedCredits: providerCharged,
      })
    )
      return false;
    componentCredits += providerCharged;
  }
  return Number.isFinite(componentCredits) && componentCredits === charged;
}

function pipelineMaterialIds(handlerEvidence) {
  const attempts =
    parseObject(handlerEvidence)?.productionRuntime?.specialRuntime?.bridge
      ?.attempts;
  if (!Array.isArray(attempts)) return [];
  return [
    ...new Set(
      attempts
        .flatMap((attempt) =>
          Array.isArray(attempt?.delivery?.artifactIds)
            ? attempt.delivery.artifactIds
            : [],
        )
        .map((value) => /^material:(\d+)$/u.exec(String(value || "")))
        .filter(Boolean)
        .map((match) => Number(match[1]))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ];
}

function pipelineProviderAsset({
  tenantId,
  pipelineId,
  stationIdx,
  materialId,
}) {
  const row = q.get(
    `SELECT id,name,body_snapshot,artifact_snapshot_json,snapshot_hash
    FROM materials
    WHERE tenant_id=? AND id=? AND source_type='content_pipeline_provider' AND source_id=?`,
    tenantId,
    materialId,
    pipelineId,
  );
  const metadata = parseObject(row?.artifact_snapshot_json);
  const mime =
    String(metadata.mimeType || "").toLowerCase() === "image/jpg"
      ? "image/jpeg"
      : String(metadata.mimeType || "").toLowerCase();
  const snapshot = String(row?.body_snapshot || "");
  const match =
    /^data:(image\/(?:png|jpeg));base64,([a-z0-9+/]+={0,2})$/iu.exec(snapshot);
  if (
    !row ||
    Number(metadata.pipelineId) !== Number(pipelineId) ||
    Number(metadata.employeeIdx) !== Number(stationIdx) ||
    !["image/png", "image/jpeg"].includes(mime) ||
    !match ||
    match[1].toLowerCase() !== mime ||
    snapshot.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 256 ||
    !/^[a-f0-9]{64}$/u.test(String(row.snapshot_hash || ""))
  ) {
    throw failure(
      "流水线 provider 图片归属或快照证据无效",
      409,
      "WECHAT_PIPELINE_ASSET_INVALID",
    );
  }
  const bytes = Buffer.from(match[2], "base64");
  const actualHash = sha256(bytes);
  const format = detectImage(bytes);
  if (
    bytes.length <= 0 ||
    bytes.length > MAX_IMAGE_BYTES ||
    format.mime !== mime ||
    actualHash !== row.snapshot_hash ||
    (metadata.contentSha256 && metadata.contentSha256 !== actualHash) ||
    (metadata.byteSize != null && Number(metadata.byteSize) !== bytes.length)
  ) {
    throw failure(
      "流水线 provider 图片字节完整性校验失败",
      409,
      "WECHAT_PIPELINE_ASSET_INTEGRITY_FAILED",
    );
  }
  return {
    id: Number(row.id),
    materialId: Number(row.id),
    stationIdx: Number(stationIdx),
    name: path.basename(
      cleanText(row.name, 160) || `pipeline-${row.id}.${format.ext}`,
    ),
    bytes,
    format,
    sha256: actualHash,
    billingRefType: cleanText(metadata.billingRefType, 100),
    billingRefId: Number(metadata.billingRefId),
  };
}

function pipelineProviderAssets(tenantId, pipelineId) {
  const assets = { images: [], cover: null };
  for (const stationIdx of [5, 6]) {
    const station = q.get(
      `SELECT status,handler_evidence_json,billing_evidence_json
      FROM content_production_pipeline_stations
      WHERE tenant_id=? AND pipeline_id=? AND station_idx=?`,
      tenantId,
      pipelineId,
      stationIdx,
    );
    if (!station) continue;
    const materialIds = pipelineMaterialIds(station.handler_evidence_json);
    if (!materialIds.length) continue;
    if (
      station.status !== "completed" ||
      !settledPipelineBilling(station.billing_evidence_json, {
        tenantId,
        pipelineId,
        stationIdx,
      })
    ) {
      throw failure(
        `流水线工位${stationIdx}图片产物尚未完成权威结算`,
        409,
        "WECHAT_PIPELINE_ASSET_BILLING_NOT_READY",
      );
    }
    const billing = parseObject(station.billing_evidence_json);
    const specialProviders = Array.isArray(billing.components?.specialProviders)
      ? billing.components.specialProviders
      : [];
    const resolved = materialIds.map((materialId) =>
      pipelineProviderAsset({
        tenantId,
        pipelineId,
        stationIdx,
        materialId,
      }),
    );
    for (const asset of resolved) {
      const billingLinked = specialProviders.some(
        (item) =>
          String(item?.refType || "") === asset.billingRefType &&
          Number(item?.refId) === asset.billingRefId &&
          Array.isArray(item?.delivery?.artifactIds) &&
          item.delivery.artifactIds.includes(`material:${asset.materialId}`),
      );
      if (!billingLinked) {
        throw failure(
          `流水线工位${stationIdx} provider 图片缺少独立结算绑定`,
          409,
          "WECHAT_PIPELINE_ASSET_BILLING_NOT_READY",
        );
      }
    }
    if (stationIdx === 5)
      assets.images.push(...resolved.slice(0, MAX_CONTENT_IMAGES));
    if (stationIdx === 6 && resolved.length) assets.cover = resolved[0];
  }
  assets.images = assets.images.slice(0, MAX_CONTENT_IMAGES);
  return assets;
}

function sourceFromPipeline(tenantId, sourceId) {
  if (!tableExists("content_production_pipeline_jobs")) {
    throw failure(
      "内容团队流水线尚未初始化",
      409,
      "WECHAT_PIPELINE_UNAVAILABLE",
    );
  }
  const row = q.get(
    `SELECT p.id,p.title,p.status,p.created_at,s.output_json,s.billing_evidence_json,
      s.status station_status,s.attempt
    FROM content_production_pipeline_jobs p
    JOIN content_production_pipeline_stations s
      ON s.tenant_id=p.tenant_id AND s.pipeline_id=p.id AND s.station_idx=8
    WHERE p.tenant_id=? AND p.id=?`,
    tenantId,
    sourceId,
  );
  if (!row) throw failure("流水线发布包不存在", 404, "WECHAT_SOURCE_NOT_FOUND");
  if (
    row.station_status !== "completed" ||
    !settledPipelineBilling(row.billing_evidence_json, {
      tenantId,
      pipelineId: row.id,
      stationIdx: 8,
    })
  ) {
    throw failure(
      "分发官发布包尚未完成真实产物与账务结算",
      409,
      "WECHAT_PIPELINE_PACKAGE_NOT_READY",
    );
  }
  const output = parseObject(row.output_json);
  const version = findWechatVersion(output);
  if (!version) {
    throw failure(
      "分发官发布包中没有公众号主发布包",
      409,
      "WECHAT_PIPELINE_VERSION_MISSING",
    );
  }
  const title = cleanText(version.title || row.title, 60) || "公众号发布包";
  const rawBody =
    version.body || version.content || version.copy || row.output_json;
  const body =
    typeof rawBody === "string"
      ? rawBody.trim()
      : JSON.stringify(rawBody, null, 2);
  if (!body)
    throw failure("流水线发布包没有可投递正文", 409, "WECHAT_SOURCE_EMPTY");
  const providerAssets = pipelineProviderAssets(tenantId, Number(row.id));
  return {
    sourceType: "pipeline",
    sourceId: Number(row.id),
    title,
    digest: cleanText(version.digest || version.summary || body, 110),
    body,
    providerAssets,
    fingerprint: sha256(
      JSON.stringify({
        stationAttempt: Number(row.attempt),
        output,
        billing: parseObject(row.billing_evidence_json),
        providerAssets: [...providerAssets.images, providerAssets.cover]
          .filter(Boolean)
          .map((asset) => ({
            materialId: asset.materialId,
            stationIdx: asset.stationIdx,
            sha256: asset.sha256,
          })),
      }),
    ),
    sourceDeepLink: `/content?pipelineId=${row.id}`,
    createdAt: row.created_at,
  };
}

export function resolveWechatDraftSource({
  tenantId = curTenant(),
  sourceType,
  sourceId,
}) {
  const tid = positiveId(tenantId, "租户编号");
  const id = positiveId(sourceId, "内容来源编号");
  if (sourceType === "content") return sourceFromContent(tid, id);
  if (sourceType === "pipeline") return sourceFromPipeline(tid, id);
  throw failure(
    "草稿来源只能是内容产物或内容团队发布包",
    400,
    "WECHAT_SOURCE_TYPE_INVALID",
  );
}

function publicSource(source) {
  return {
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    title: source.title,
    createdAt: source.createdAt,
    sourceDeepLink: source.sourceDeepLink,
    autoImageCount: source.providerAssets?.images?.length || 0,
    autoCoverAvailable: Boolean(source.providerAssets?.cover),
  };
}

export function listWechatDraftSources({
  tenantId = curTenant(),
  limit = 30,
} = {}) {
  const tid = positiveId(tenantId, "租户编号");
  const take = Math.min(100, Math.max(1, Number(limit) || 30));
  const items = [];
  for (const row of q.all(
    `SELECT id FROM contents WHERE tenant_id=? AND status IN ('可使用','已发布')
    ORDER BY id DESC LIMIT ?`,
    tid,
    take * 3,
  )) {
    try {
      items.push(publicSource(sourceFromContent(tid, Number(row.id))));
    } catch {
      // 来源列表只展示通过既有交付门禁的内容。
    }
    if (items.length >= take) break;
  }
  if (tableExists("content_production_pipeline_jobs")) {
    for (const row of q.all(
      `SELECT p.id FROM content_production_pipeline_jobs p
      JOIN content_production_pipeline_stations s
        ON s.tenant_id=p.tenant_id AND s.pipeline_id=p.id AND s.station_idx=8
      WHERE p.tenant_id=? AND s.status='completed'
      ORDER BY p.id DESC LIMIT ?`,
      tid,
      take * 2,
    )) {
      try {
        items.push(publicSource(sourceFromPipeline(tid, Number(row.id))));
      } catch {
        // 未结算的发布包不进入可投递列表。
      }
      if (items.length >= take) break;
    }
  }
  return items
    .sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
    )
    .slice(0, take);
}

function publicProviderAttempt(value) {
  const attempt = parseObject(value);
  return {
    phase: cleanText(attempt.phase, 40) || null,
    attemptedAt: cleanText(attempt.attemptedAt, 80) || null,
    reconciledAt: cleanText(attempt.reconciledAt, 80) || null,
    imageCount: Number.isSafeInteger(Number(attempt.imageCount))
      ? Number(attempt.imageCount)
      : null,
    coverOrigin: cleanText(attempt.coverOrigin, 40) || null,
    coverUploaded: attempt.coverUploaded === true,
    markerChecked: attempt.markerChecked === true,
    outcome: cleanText(attempt.outcome, 80) || null,
  };
}

function latestBillingRecord(row) {
  return tableExists("credit_holds")
    ? q.get(
        `SELECT h.id,h.log_id,h.status,h.held_credits,h.settled_credits,
          l.credits ledger_credits,l.cost_yuan
        FROM credit_holds h
        LEFT JOIN credit_logs l ON l.tenant_id=h.tenant_id AND l.id=h.log_id
        WHERE h.tenant_id=? AND h.ref_type=? AND h.ref_id=?
        ORDER BY h.id DESC LIMIT 1`,
        row.tenant_id,
        WECHAT_DRAFT_BILLING_REF,
        row.id,
      )
    : null;
}

function authoritativeBillingState(hold) {
  if (!hold) return null;
  if (hold.status === "held") return "held";
  if (hold.status !== "settled") return null;
  const settled = Number(hold.settled_credits);
  const ledger = Number(hold.ledger_credits);
  if (!Number.isFinite(settled) || settled !== ledger) return null;
  return settled === 0 ? "released" : "settled";
}

function billingView(row) {
  const hold = latestBillingRecord(row);
  const state =
    {
      pending: "pending_reconciliation",
      held: "held",
      settled: "settled",
      released: "released",
      pending_reconciliation: "pending_reconciliation",
    }[row.billing_status] || "pending_reconciliation";
  const credits =
    state === "settled"
      ? Number(row.settled_credits ?? hold?.settled_credits ?? 0)
      : state === "held"
        ? Number(row.held_credits || hold?.held_credits || 0)
        : 0;
  return {
    state,
    credits,
    costYuan: hold?.cost_yuan == null ? null : Number(hold.cost_yuan),
    label: {
      held: `已预授权 ${credits} 积分`,
      settled: `已结算 ${credits} 积分`,
      released: "预授权已全额退回",
      pending_reconciliation: "待账务对账",
    }[state],
    authoritative: authoritativeBillingState(hold) === state,
    ledger: {
      source: "credit_holds+credit_logs",
      holdId: hold ? Number(hold.id) : null,
      logId: hold ? Number(hold.log_id) : null,
      heldCredits: hold ? Number(hold.held_credits) : null,
      settledCredits:
        hold?.settled_credits == null ? null : Number(hold.settled_credits),
    },
  };
}

function submissionStartedMs(row) {
  const attempt = parseObject(row.provider_attempt_json);
  return (
    Date.parse(attempt.attemptedAt || "") ||
    Date.parse(row.created_at || "") ||
    Date.now()
  );
}

function publicDelivery(row, confirmDelayMs = DEFAULT_CONFIRM_DELAY_MS) {
  const ageMs = Math.max(0, Date.now() - submissionStartedMs(row));
  const billing = billingView(row);
  return {
    id: Number(row.id),
    sourceType: row.source_type,
    sourceId: Number(row.source_id),
    title: row.title,
    theme: normalizeWechatDraftTheme(row.theme_key),
    status: row.status,
    billingStatus: row.billing_status,
    billing,
    mediaId: row.status === "done" ? row.provider_media_id || "" : "",
    providerAttempt: publicProviderAttempt(row.provider_attempt_json),
    error: row.error_message || "",
    needsReconciliation: ["submitting", "submitted"].includes(row.status),
    canConfirmNotDelivered:
      row.status === "submitting" &&
      row.billing_status === "held" &&
      ageMs >= confirmDelayMs,
    confirmWaitSeconds:
      row.status === "submitting"
        ? Math.max(0, Math.ceil((confirmDelayMs - ageMs) / 1000))
        : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
    deepLink: `/tasks?kind=wechat&id=${row.id}`,
    studioDeepLink: `/content?wechatDeliveryId=${row.id}#wechat-drafts`,
    sourceDeepLink:
      row.source_type === "pipeline"
        ? `/content?pipelineId=${row.source_id}`
        : `/content?contentId=${row.source_id}`,
  };
}

function rowForTenant(tenantId, deliveryId) {
  const row = q.get(
    "SELECT * FROM wechat_draft_deliveries WHERE tenant_id=? AND id=?",
    tenantId,
    deliveryId,
  );
  if (!row) {
    throw failure(
      "公众号草稿投递不存在或无权查看",
      404,
      "WECHAT_DELIVERY_NOT_FOUND",
    );
  }
  return row;
}

function updateAttempt(row, patch) {
  const next = {
    ...publicProviderAttempt(row.provider_attempt_json),
    ...patch,
  };
  q.run(
    `UPDATE wechat_draft_deliveries SET provider_attempt_json=?,updated_at=?
    WHERE tenant_id=? AND id=?`,
    JSON.stringify(next),
    nowIso(),
    row.tenant_id,
    row.id,
  );
}

function failureMessage(error, fallback = "公众号草稿投递失败") {
  if (error instanceof WechatProviderError || Number(error?.status) < 500) {
    return cleanText(error?.message, 300) || fallback;
  }
  return fallback;
}

export function createWechatDraftService({
  provider = new OfficialWechatDraftProvider(),
  imageProcessor = createWechatImageProcessor(),
  fixedCredits = WECHAT_DRAFT_FIXED_CREDITS,
  confirmDelayMs = DEFAULT_CONFIRM_DELAY_MS,
  autoRun = true,
} = {}) {
  const scheduled = new Map();
  const credits = Math.max(
    1,
    Math.ceil(Number(fixedCredits) || WECHAT_DRAFT_FIXED_CREDITS),
  );
  const delay = Math.max(0, Number(confirmDelayMs) || 0);

  function getDelivery(user, deliveryId) {
    const tenantId = positiveId(user?.tenant_id || curTenant(), "租户编号");
    return publicDelivery(
      rowForTenant(tenantId, positiveId(deliveryId, "投递编号")),
      delay,
    );
  }

  function listDeliveries(user, { limit = 50 } = {}) {
    const tenantId = positiveId(user?.tenant_id || curTenant(), "租户编号");
    const take = Math.min(200, Math.max(1, Number(limit) || 50));
    return q
      .all(
        `SELECT * FROM wechat_draft_deliveries
        WHERE tenant_id=? ORDER BY id DESC LIMIT ?`,
        tenantId,
        take,
      )
      .map((row) => publicDelivery(row, delay));
  }

  function releaseAsFailed(row, error, code = "WECHAT_PRE_SUBMIT_FAILED") {
    const liveHold = findHoldByRef(
      WECHAT_DRAFT_BILLING_REF,
      row.id,
      row.tenant_id,
    );
    let billingStatus = row.billing_status;
    try {
      if (liveHold) {
        releaseHold(liveHold, `公众号草稿未送达：${failureMessage(error)}`);
        const released = authoritativeBillingState(latestBillingRecord(row));
        billingStatus =
          released === "released" ? "released" : "pending_reconciliation";
      } else if (row.billing_status === "pending") {
        // 尚未形成 hold，没有积分变动可退。
        billingStatus = "released";
      } else {
        const ledgerState = authoritativeBillingState(latestBillingRecord(row));
        billingStatus =
          ledgerState === "released" ? "released" : "pending_reconciliation";
      }
    } catch {
      billingStatus = "pending_reconciliation";
    }
    q.run(
      `UPDATE wechat_draft_deliveries
      SET status='failed',billing_status=?,error_code=?,error_message=?,updated_at=?,completed_at=?
      WHERE tenant_id=? AND id=? AND status IN ('processing','submitting')`,
      billingStatus,
      cleanText(error?.code || code, 80),
      failureMessage(error),
      nowIso(),
      nowIso(),
      row.tenant_id,
      row.id,
    );
    return rowForTenant(row.tenant_id, row.id);
  }

  function finalizeSubmitted(row) {
    const current = rowForTenant(row.tenant_id, row.id);
    if (current.status === "done") return current;
    if (current.status !== "submitted") return current;
    const liveHold = findHoldByRef(
      WECHAT_DRAFT_BILLING_REF,
      current.id,
      current.tenant_id,
    );
    try {
      if (liveHold) {
        settleHold(liveHold, {
          credits,
          model: "wechat-official-draft-api",
          note: "微信官方 draft/add 已确认返回草稿编号",
        });
      }
      const record = latestBillingRecord(current);
      if (
        authoritativeBillingState(record) !== "settled" ||
        Number(record?.settled_credits) !== credits
      )
        throw new Error("billing settlement missing");
      q.run(
        `UPDATE wechat_draft_deliveries
        SET status='done',billing_status='settled',settled_credits=?,error_code=NULL,
          error_message=NULL,updated_at=?,completed_at=COALESCE(completed_at,?)
        WHERE tenant_id=? AND id=? AND status='submitted'`,
        credits,
        nowIso(),
        nowIso(),
        current.tenant_id,
        current.id,
      );
    } catch {
      q.run(
        `UPDATE wechat_draft_deliveries
        SET billing_status='pending_reconciliation',error_code='WECHAT_BILLING_PENDING',
          error_message='草稿已送达，账务待对账；系统不会重复投递',updated_at=?
        WHERE tenant_id=? AND id=? AND status='submitted'`,
        nowIso(),
        current.tenant_id,
        current.id,
      );
    }
    return rowForTenant(current.tenant_id, current.id);
  }

  async function reconcileRow(row) {
    const current = rowForTenant(row.tenant_id, row.id);
    if (current.status === "done") return current;
    if (current.status === "submitted") return finalizeSubmitted(current);
    if (current.status !== "submitting") {
      throw failure(
        "该投递当前不需要对账",
        409,
        "WECHAT_RECONCILE_NOT_ALLOWED",
      );
    }
    const credentials = readCredentials(current.tenant_id);
    assertConfigured(credentials);
    const found = await provider.findDraftByMarker({
      tenantId: current.tenant_id,
      credentials,
      marker: `${WECHAT_DRAFT_MARKER_PREFIX}${current.request_key}`,
    });
    updateAttempt(current, {
      phase: "reconcile",
      markerChecked: true,
      reconciledAt: nowIso(),
      outcome: found?.mediaId ? "found" : "not_found",
    });
    if (!cleanText(found?.mediaId, 200)) {
      throw failure(
        "最近草稿中尚未找到该隐藏标记；系统不会盲目重发",
        409,
        "WECHAT_DRAFT_NOT_FOUND_BY_MARKER",
      );
    }
    q.run(
      `UPDATE wechat_draft_deliveries
      SET status='submitted',provider_media_id=?,error_code=NULL,error_message=NULL,updated_at=?,submitted_at=COALESCE(submitted_at,?)
      WHERE tenant_id=? AND id=? AND status='submitting'`,
      cleanText(found.mediaId, 200),
      nowIso(),
      nowIso(),
      current.tenant_id,
      current.id,
    );
    return finalizeSubmitted(rowForTenant(current.tenant_id, current.id));
  }

  async function run(deliveryId, tenantId) {
    const tid = positiveId(tenantId, "租户编号");
    const id = positiveId(deliveryId, "投递编号");
    return runWithTenant(tid, async () => {
      let row = rowForTenant(tid, id);
      if (TERMINAL_STATES.has(row.status)) return publicDelivery(row, delay);
      if (row.status === "submitted") {
        return publicDelivery(finalizeSubmitted(row), delay);
      }
      if (row.status === "submitting") {
        try {
          return publicDelivery(await reconcileRow(row), delay);
        } catch (error) {
          if (error?.code === "WECHAT_DRAFT_NOT_FOUND_BY_MARKER") {
            return publicDelivery(rowForTenant(tid, id), delay);
          }
          throw error;
        }
      }
      if (row.status !== "processing") return publicDelivery(row, delay);

      const attempt = parseObject(row.provider_attempt_json);
      if (cleanText(attempt.phase, 40)) {
        // 同一记录只能有一个 processing 执行者。其他进程/请求只读
        // 当前状态，不得释放 hold，更不得重复上传或提交。
        return publicDelivery(row, delay);
      }
      const claimedAt = nowIso();
      const claim = q.run(
        `UPDATE wechat_draft_deliveries
        SET provider_attempt_json=?,updated_at=?
        WHERE tenant_id=? AND id=? AND status='processing' AND billing_status='held'
          AND provider_attempt_json=?`,
        JSON.stringify({
          phase: "claimed",
          attemptedAt: claimedAt,
          markerChecked: false,
          outcome: "claimed",
        }),
        claimedAt,
        tid,
        id,
        row.provider_attempt_json,
      );
      if (!claim.changes) return publicDelivery(rowForTenant(tid, id), delay);
      row = rowForTenant(tid, id);

      let externalSubmissionStarted = false;
      try {
        const credentials = readCredentials(tid);
        assertConfigured(credentials);
        const source = resolveWechatDraftSource({
          tenantId: tid,
          sourceType: row.source_type,
          sourceId: row.source_id,
        });
        if (source.fingerprint !== row.source_fingerprint) {
          throw failure(
            "内容在投递排队后已发生变化，已取消本次投递",
            409,
            "WECHAT_SOURCE_CHANGED",
          );
        }
        const imageIds = parseArray(row.image_file_ids_json)
          .map(Number)
          .filter((value) => Number.isSafeInteger(value) && value > 0)
          .slice(0, MAX_CONTENT_IMAGES);
        const rawImages = [
          ...(source.providerAssets?.images || []),
          ...imageIds.map((fileId) => resolveTenantImage(tid, fileId)),
        ];
        const images = [];
        for (const image of rawImages) {
          images.push(await normalizedWechatImage(image, imageProcessor));
        }
        const selectedCover = selectWechatDraftCover({
          explicitCover: row.cover_file_id
            ? resolveTenantImage(tid, row.cover_file_id)
            : null,
          providerCover: source.providerAssets?.cover,
          providerImages: source.providerAssets?.images,
          title: source.title,
          theme: row.theme_key,
        });
        const cover = await normalizedWechatImage(
          selectedCover.image,
          imageProcessor,
        );
        updateAttempt(row, {
          phase: "uploading",
          attemptedAt: nowIso(),
          imageCount: images.length,
          coverOrigin: selectedCover.origin,
          coverUploaded: false,
          markerChecked: false,
          outcome: "started",
        });
        const imageUrls = [];
        for (const image of images) {
          const uploaded = await provider.uploadContentImage({
            tenantId: tid,
            credentials,
            bytes: image.bytes,
            filename: image.name,
          });
          imageUrls.push(assertOfficialCdnUrl(uploaded?.url));
        }
        const coverUpload = await provider.uploadCover({
          tenantId: tid,
          credentials,
          bytes: cover.bytes,
          filename: cover.name,
        });
        const thumbMediaId = cleanText(coverUpload?.mediaId, 200);
        if (!thumbMediaId) {
          throw new WechatProviderError("微信未返回封面素材编号", {
            code: "WECHAT_COVER_MEDIA_ID_MISSING",
          });
        }
        const marker = `${WECHAT_DRAFT_MARKER_PREFIX}${row.request_key}`;
        const content = renderWechatDraftHtml({
          title: source.title,
          body: source.body,
          imageUrls,
          marker,
          theme: row.theme_key,
        });
        const changed = q.run(
          `UPDATE wechat_draft_deliveries
          SET status='submitting',provider_attempt_json=?,updated_at=?
          WHERE tenant_id=? AND id=? AND status='processing' AND billing_status='held'`,
          JSON.stringify({
            phase: "draft_add",
            attemptedAt: nowIso(),
            imageCount: images.length,
            coverOrigin: selectedCover.origin,
            coverUploaded: true,
            markerChecked: false,
            outcome: "submitting",
          }),
          nowIso(),
          tid,
          id,
        );
        if (!changed.changes) {
          throw failure("草稿投递状态已变化", 409, "WECHAT_STATE_CONFLICT");
        }
        externalSubmissionStarted = true;
        row = rowForTenant(tid, id);
        let mediaId = "";
        try {
          const added = await provider.addDraft({
            tenantId: tid,
            credentials,
            article: {
              title: source.title.slice(0, 60),
              author: cleanText(row.author, 8),
              digest: source.digest.slice(0, 110),
              content,
              thumb_media_id: thumbMediaId,
              need_open_comment: 1,
            },
          });
          mediaId = cleanText(added?.mediaId, 200);
        } catch (error) {
          if (error instanceof WechatProviderError && error.definitive)
            throw error;
          try {
            const found = await provider.findDraftByMarker({
              tenantId: tid,
              credentials,
              marker,
            });
            mediaId = cleanText(found?.mediaId, 200);
          } catch {
            mediaId = "";
          }
          if (!mediaId) {
            updateAttempt(row, {
              phase: "draft_add",
              markerChecked: true,
              reconciledAt: nowIso(),
              outcome: "uncertain",
            });
            q.run(
              `UPDATE wechat_draft_deliveries
              SET error_code='WECHAT_SUBMISSION_UNCERTAIN',
                error_message='微信提交结果不确定，已停止重发并保留预授权',updated_at=?
              WHERE tenant_id=? AND id=? AND status='submitting'`,
              nowIso(),
              tid,
              id,
            );
            return publicDelivery(rowForTenant(tid, id), delay);
          }
        }
        if (!mediaId) {
          try {
            const found = await provider.findDraftByMarker({
              tenantId: tid,
              credentials,
              marker,
            });
            mediaId = cleanText(found?.mediaId, 200);
          } catch {
            mediaId = "";
          }
        }
        if (!mediaId) {
          q.run(
            `UPDATE wechat_draft_deliveries
            SET error_code='WECHAT_SUBMISSION_UNCERTAIN',
              error_message='微信未返回草稿编号，已停止重发',updated_at=?
            WHERE tenant_id=? AND id=? AND status='submitting'`,
            nowIso(),
            tid,
            id,
          );
          return publicDelivery(rowForTenant(tid, id), delay);
        }
        q.run(
          `UPDATE wechat_draft_deliveries
          SET status='submitted',provider_media_id=?,error_code=NULL,error_message=NULL,
            provider_attempt_json=?,submitted_at=?,updated_at=?
          WHERE tenant_id=? AND id=? AND status='submitting'`,
          mediaId,
          JSON.stringify({
            phase: "draft_add",
            attemptedAt: nowIso(),
            imageCount: images.length,
            coverOrigin: selectedCover.origin,
            coverUploaded: true,
            markerChecked: false,
            outcome: "submitted",
          }),
          nowIso(),
          nowIso(),
          tid,
          id,
        );
        return publicDelivery(finalizeSubmitted(rowForTenant(tid, id)), delay);
      } catch (error) {
        row = rowForTenant(tid, id);
        if (
          externalSubmissionStarted &&
          !(error instanceof WechatProviderError && error.definitive)
        ) {
          q.run(
            `UPDATE wechat_draft_deliveries
            SET error_code='WECHAT_SUBMISSION_UNCERTAIN',
              error_message='草稿可能已送达，系统已停止重发并等待对账',updated_at=?
            WHERE tenant_id=? AND id=? AND status='submitting'`,
            nowIso(),
            tid,
            id,
          );
          return publicDelivery(rowForTenant(tid, id), delay);
        }
        return publicDelivery(
          releaseAsFailed(
            row,
            error,
            error instanceof WechatProviderError && error.definitive
              ? "WECHAT_EXPLICIT_REJECTION"
              : "WECHAT_PRE_SUBMIT_FAILED",
          ),
          delay,
        );
      }
    });
  }

  function schedule(deliveryId, tenantId) {
    const key = `${tenantId}:${deliveryId}`;
    if (scheduled.has(key)) return scheduled.get(key);
    const task = Promise.resolve()
      .then(() => run(deliveryId, tenantId))
      .catch((error) => {
        console.error("[wechat-draft]", failureMessage(error));
        return null;
      })
      .finally(() => scheduled.delete(key));
    scheduled.set(key, task);
    return task;
  }

  async function createDelivery({
    user,
    sourceType,
    sourceId,
    coverFileId = null,
    imageFileIds = [],
    author = "",
    theme = WECHAT_DRAFT_DEFAULT_THEME,
  }) {
    const tenantId = positiveId(user?.tenant_id || curTenant(), "租户编号");
    const userId = positiveId(user?.id, "用户编号");
    if (
      !q.get(
        "SELECT id FROM users WHERE tenant_id=? AND id=?",
        tenantId,
        userId,
      )
    ) {
      throw failure("投递账号不存在", 404, "WECHAT_USER_NOT_FOUND");
    }
    assertConfigured(readCredentials(tenantId));
    const source = resolveWechatDraftSource({ tenantId, sourceType, sourceId });
    const themeKey = normalizeWechatDraftTheme(theme);
    const coverId =
      coverFileId == null || coverFileId === ""
        ? null
        : positiveId(coverFileId, "封面素材编号");
    const images = [
      ...new Set(
        (Array.isArray(imageFileIds) ? imageFileIds : [])
          .map(Number)
          .filter((value) => Number.isSafeInteger(value) && value > 0),
      ),
    ];
    const automaticImages = source.providerAssets?.images?.length || 0;
    if (images.length + automaticImages > MAX_CONTENT_IMAGES) {
      throw failure(
        `流水线已自带 ${automaticImages} 张图，正文图合计最多 ${MAX_CONTENT_IMAGES} 张`,
        400,
        "WECHAT_IMAGE_LIMIT",
      );
    }
    if (coverId) resolveTenantImage(tenantId, coverId);
    images.forEach((id) => resolveTenantImage(tenantId, id));
    const requestHash = sha256(
      JSON.stringify({
        tenantId,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceFingerprint: source.fingerprint,
        coverFileId: coverId,
        imageFileIds: images,
        author: cleanText(author, 8),
        theme: themeKey,
      }),
    );
    const existing =
      q.get(
        `SELECT * FROM wechat_draft_deliveries
      WHERE tenant_id=? AND request_hash=? AND status IN ('processing','submitting','submitted','done','blocked')
      ORDER BY id DESC LIMIT 1`,
        tenantId,
        requestHash,
      ) ||
      q.get(
        `SELECT * FROM wechat_draft_deliveries
      WHERE tenant_id=? AND source_type=? AND source_id=?
        AND status IN ('processing','submitting','submitted')
      ORDER BY id DESC LIMIT 1`,
        tenantId,
        source.sourceType,
        source.sourceId,
      );
    if (existing) {
      return {
        delivery: publicDelivery(existing, delay),
        created: false,
        idempotent: true,
      };
    }
    let inserted;
    try {
      inserted = q.run(
        `INSERT INTO wechat_draft_deliveries(
          tenant_id,created_by,source_type,source_id,source_fingerprint,title,author,
          theme_key,request_hash,request_key,status,billing_status,fixed_credits,held_credits,
          cover_file_id,image_file_ids_json,provider_attempt_json,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,'processing','pending',?,?,?,?,'{}',?,?)`,
        tenantId,
        userId,
        source.sourceType,
        source.sourceId,
        source.fingerprint,
        source.title,
        cleanText(author, 8),
        themeKey,
        requestHash,
        requestHash.slice(0, 24),
        credits,
        credits,
        coverId,
        JSON.stringify(images),
        nowIso(),
        nowIso(),
      );
    } catch (error) {
      const active = q.get(
        `SELECT * FROM wechat_draft_deliveries
        WHERE tenant_id=? AND source_type=? AND source_id=?
          AND status IN ('processing','submitting','submitted')
        ORDER BY id DESC LIMIT 1`,
        tenantId,
        source.sourceType,
        source.sourceId,
      );
      if (active) {
        return {
          delivery: publicDelivery(active, delay),
          created: false,
          idempotent: true,
        };
      }
      throw error;
    }
    const deliveryId = Number(inserted.lastInsertRowid);
    try {
      const hold = holdCredits({
        userId,
        tenantId,
        feature: "微信公众号草稿投递",
        kind: "text",
        model: "wechat-official-draft-api",
        credits,
        refType: WECHAT_DRAFT_BILLING_REF,
        refId: deliveryId,
        note: "官方微信 API 草稿投递固定价预授权；提交前失败全退。",
      });
      const changed = q.run(
        `UPDATE wechat_draft_deliveries
        SET billing_status='held',held_credits=?,updated_at=?
        WHERE tenant_id=? AND id=? AND status='processing' AND billing_status='pending'`,
        hold.credits,
        nowIso(),
        tenantId,
        deliveryId,
      );
      if (!changed.changes) {
        releaseHold(hold, "公众号草稿任务状态冲突，预授权全退");
        throw failure("草稿投递开工状态冲突", 409, "WECHAT_STATE_CONFLICT");
      }
    } catch (error) {
      const dangling = findHoldByRef(
        WECHAT_DRAFT_BILLING_REF,
        deliveryId,
        tenantId,
      );
      if (dangling) {
        try {
          releaseHold(dangling, "公众号草稿开工失败，预授权全退");
          q.run(
            `UPDATE wechat_draft_deliveries
            SET status='failed',billing_status='released',error_code='WECHAT_START_FAILED',
              error_message='草稿投递未开工，预授权已退回',updated_at=?,completed_at=?
            WHERE tenant_id=? AND id=?`,
            nowIso(),
            nowIso(),
            tenantId,
            deliveryId,
          );
        } catch {
          q.run(
            `UPDATE wechat_draft_deliveries
            SET status='failed',billing_status='pending_reconciliation',
              error_code='WECHAT_START_BILLING_PENDING',
              error_message='草稿投递未开工，预授权待对账',updated_at=?,completed_at=?
            WHERE tenant_id=? AND id=?`,
            nowIso(),
            nowIso(),
            tenantId,
            deliveryId,
          );
        }
      } else {
        q.run(
          `DELETE FROM wechat_draft_deliveries
          WHERE tenant_id=? AND id=? AND status='processing' AND billing_status='pending'`,
          tenantId,
          deliveryId,
        );
      }
      throw error;
    }
    const delivery = publicDelivery(rowForTenant(tenantId, deliveryId), delay);
    if (autoRun) schedule(deliveryId, tenantId);
    return { delivery, created: true, idempotent: false };
  }

  async function reconcile(user, deliveryId) {
    const tenantId = positiveId(user?.tenant_id || curTenant(), "租户编号");
    const row = rowForTenant(tenantId, positiveId(deliveryId, "投递编号"));
    return publicDelivery(await reconcileRow(row), delay);
  }

  async function confirmNotDelivered(user, deliveryId, input = {}) {
    const tenantId = positiveId(user?.tenant_id || curTenant(), "租户编号");
    const id = positiveId(deliveryId, "投递编号");
    const row = rowForTenant(tenantId, id);
    if (row.status !== "submitting" || row.billing_status !== "held") {
      throw failure(
        "该投递当前不能人工解锁",
        409,
        "WECHAT_CONFIRM_NOT_ALLOWED",
      );
    }
    const ageMs = Date.now() - submissionStartedMs(row);
    if (ageMs < delay) {
      throw failure(
        `微信仍可能在处理，请 ${Math.ceil((delay - ageMs) / 1000)} 秒后再确认`,
        409,
        "WECHAT_CONFIRM_TOO_EARLY",
      );
    }
    if (
      input.confirmedNoDraft !== true ||
      cleanText(input.titleConfirmation, 120) !== cleanText(row.title, 120)
    ) {
      throw failure(
        "请先打开公众号草稿箱核对，并完整输入文章标题",
        400,
        "WECHAT_CONFIRMATION_INVALID",
      );
    }
    const credentials = readCredentials(tenantId);
    assertConfigured(credentials);
    let found;
    try {
      found = await provider.findDraftByMarker({
        tenantId,
        credentials,
        marker: `${WECHAT_DRAFT_MARKER_PREFIX}${row.request_key}`,
      });
    } catch {
      throw failure(
        "最后一次草稿箱核对失败，未退款也未解锁",
        503,
        "WECHAT_FINAL_RECONCILE_FAILED",
      );
    }
    if (cleanText(found?.mediaId, 200)) {
      q.run(
        `UPDATE wechat_draft_deliveries
        SET status='submitted',provider_media_id=?,submitted_at=COALESCE(submitted_at,?),updated_at=?
        WHERE tenant_id=? AND id=? AND status='submitting'`,
        cleanText(found.mediaId, 200),
        nowIso(),
        nowIso(),
        tenantId,
        id,
      );
      return publicDelivery(
        finalizeSubmitted(rowForTenant(tenantId, id)),
        delay,
      );
    }
    return publicDelivery(
      releaseAsFailed(
        row,
        failure(
          "已人工核对并确认未送达",
          409,
          "WECHAT_CONFIRMED_NOT_DELIVERED",
        ),
        "WECHAT_CONFIRMED_NOT_DELIVERED",
      ),
      delay,
    );
  }

  async function recoverAndSchedule() {
    if (!tableExists("wechat_draft_deliveries")) return [];
    const rows = q.all(
      `SELECT * FROM wechat_draft_deliveries
      WHERE tenant_id IN (SELECT id FROM tenants)
        AND status IN ('processing','submitting','submitted')
      ORDER BY id`,
    );
    const report = [];
    for (const row of rows) {
      if (row.status === "processing") {
        const recovered = runWithTenant(row.tenant_id, () =>
          releaseAsFailed(
            row,
            failure(
              "服务重启中断，草稿尚未提交微信",
              409,
              "WECHAT_RECOVERED_PRE_SUBMIT",
            ),
            "WECHAT_RECOVERED_PRE_SUBMIT",
          ),
        );
        report.push({
          id: row.id,
          action:
            recovered.billing_status === "released"
              ? "refunded"
              : "billing_pending",
        });
      } else if (row.status === "submitted") {
        const recovered = runWithTenant(row.tenant_id, () =>
          finalizeSubmitted(row),
        );
        report.push({
          id: row.id,
          action: recovered.status === "done" ? "finalized" : "billing_pending",
        });
      } else {
        // 启动恢复不联网：submitting 必须原样保护，等用户手动
        // reconcile 或下次显式操作再做 marker 只读对账。
        report.push({ id: row.id, action: "protected_uncertain" });
      }
    }
    return report;
  }

  return Object.freeze({
    provider,
    createDelivery,
    getDelivery,
    listDeliveries,
    run,
    schedule,
    reconcile,
    confirmNotDelivered,
    recoverAndSchedule,
    testConnection: async (user) => {
      const tenantId = positiveId(user?.tenant_id || curTenant(), "租户编号");
      const credentials = readCredentials(tenantId);
      assertConfigured(credentials);
      await provider.testConnection({ tenantId, credentials });
      return { ok: true, credentialsReturned: false };
    },
  });
}

export const wechatDraftService = createWechatDraftService();
