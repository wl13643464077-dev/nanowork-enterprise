// AI 带货员 · 供应商可拉取的一次性令牌 URL（TTS 音轨 / 9:16 首帧）
//
// 与 avatar-provider-assets.js 同一做法：素材落到 uploaded_files（租户目录），对外只给
// 带签名、限时、限用途的 HTTPS 地址 `${PUBLIC_BASE}/api/ai-sales-video/provider-assets/:token`，
// 云雾/百炼拉取时校验签名、租户、用途、文件真实路径与大小。没有 HTTPS 公网 base URL
// 时返回 null，调用方必须 blocked（音轨需公网可达地址，请在演示服务器运行）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { curTenant, q, runWithTenant } from '../db.js';
import { signToken, verifyToken } from '../util.js';
import { parseProviderMediaUrl } from './provider-media-download.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_ROOT = path.resolve(__dirname, '..', '..', 'data', 'uploads', 'files');
const TOKEN_PURPOSE = 'ai_sales_video_provider_asset';
export const AI_SALES_VIDEO_PROVIDER_ASSET_PURPOSES = Object.freeze(['ai-sales-video-audio', 'ai-sales-video-frame']);
const ALLOWED_PURPOSES = new Set(AI_SALES_VIDEO_PROVIDER_ASSET_PURPOSES);
const ALLOWED_MIME = /^(?:image\/(?:jpeg|png|webp)|audio\/(?:mpeg|wav|mp4))$/iu;
const MAX_BYTES = 15 * 1024 * 1024;
export const AI_SALES_VIDEO_PROVIDER_ASSET_ROUTE = '/api/ai-sales-video/provider-assets';

function purposeMatchesMime(purpose, mime) {
  return (
    ALLOWED_MIME.test(String(mime || '')) &&
    ((purpose === 'ai-sales-video-audio' && String(mime).startsWith('audio/')) ||
      (purpose === 'ai-sales-video-frame' && String(mime).startsWith('image/')))
  );
}

function safePublicBaseUrl(value) {
  let parsed;
  try {
    // Inspect hash before the shared parser removes it.
    if (new URL(String(value || '').trim()).hash) return null;
    parsed = parseProviderMediaUrl(String(value || '').trim());
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== '443') ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  return parsed.href.replace(/\/+$/gu, '');
}

export function aiSalesVideoProviderPublicBaseUrl(value = null) {
  return safePublicBaseUrl(
    value ||
      process.env.AI_SALES_VIDEO_PUBLIC_BASE_URL ||
      process.env.AVATAR_PROVIDER_PUBLIC_BASE_URL ||
      process.env.PUBLIC_BASE_URL ||
      process.env.APP_PUBLIC_URL,
  );
}

export function createAiSalesVideoProviderAssetUrl(
  { tenantId, fileId, purpose },
  { publicBaseUrl = null, ttlSeconds = 60 * 60 } = {},
) {
  const base = aiSalesVideoProviderPublicBaseUrl(publicBaseUrl);
  const tid = Number(tenantId);
  const id = Number(fileId);
  const filePurpose = String(purpose || '');
  if (
    !base ||
    !Number.isSafeInteger(tid) ||
    tid <= 0 ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !ALLOWED_PURPOSES.has(filePurpose)
  ) {
    return null;
  }
  const token = signToken(
    { tokenPurpose: TOKEN_PURPOSE, tenantId: tid, fileId: id, filePurpose },
    Math.min(3 * 60 * 60, Math.max(5 * 60, Number(ttlSeconds) || 60 * 60)),
  );
  return `${base}${AI_SALES_VIDEO_PROVIDER_ASSET_ROUTE}/${encodeURIComponent(token)}`;
}

function extFor(mime) {
  const value = String(mime || '').toLowerCase();
  if (value === 'image/png') return 'png';
  if (value === 'image/webp') return 'webp';
  if (value === 'image/jpeg') return 'jpg';
  if (value === 'audio/wav') return 'wav';
  if (value === 'audio/mp4') return 'm4a';
  return 'mp3';
}

/**
 * 把字节落到租户上传目录并登记 uploaded_files（purpose 限定），返回行。
 * 必须在 runWithTenant(tenantId) 上下文内调用（uploaded_files 有租户默认列）。
 */
export async function persistAiSalesVideoProviderAsset({ tenantId, userId, purpose, bytes, mime, label = 'asset' }) {
  const tid = Number(tenantId);
  if (!Number.isSafeInteger(tid) || tid <= 0 || Number(curTenant()) !== tid) {
    throw Object.assign(new Error('租户文件上下文不一致'), {
      status: 500,
      code: 'AI_SALES_VIDEO_TENANT_CONTEXT_INVALID',
    });
  }
  if (
    !Number.isSafeInteger(Number(userId)) ||
    Number(userId) <= 0 ||
    !q.get('SELECT id FROM users WHERE tenant_id=? AND id=?', tid, Number(userId))
  ) {
    throw Object.assign(new Error('供应商素材账号与企业不一致'), {
      status: 403,
      code: 'AI_SALES_VIDEO_TENANT_CONTEXT_INVALID',
    });
  }
  if (!ALLOWED_PURPOSES.has(String(purpose || ''))) {
    throw Object.assign(new Error('供应商素材用途不合法'), {
      status: 400,
      code: 'AI_SALES_VIDEO_ASSET_PURPOSE_INVALID',
    });
  }
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) {
    throw Object.assign(new Error('供应商素材为空或超过大小上限'), {
      status: 400,
      code: 'AI_SALES_VIDEO_ASSET_INVALID',
    });
  }
  if (!purposeMatchesMime(purpose, mime)) {
    throw Object.assign(new Error('供应商素材类型不合法'), { status: 400, code: 'AI_SALES_VIDEO_ASSET_INVALID' });
  }
  const ext = extFor(mime);
  await fsp.mkdir(UPLOAD_ROOT, { recursive: true, mode: 0o750 });
  const root = await fsp.realpath(UPLOAD_ROOT);
  let directory = root;
  // Validate each parent before descending: mkdir must not follow a tenant or
  // purpose symlink/junction outside this managed upload tree.
  for (const component of [String(tid), purpose]) {
    directory = path.join(directory, component);
    try {
      await fsp.mkdir(directory, { mode: 0o750 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = await fsp.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (await fsp.realpath(directory)) !== directory) {
      throw Object.assign(new Error('供应商素材目录不安全'), {
        code: 'AI_SALES_VIDEO_ASSET_PATH_INVALID',
        status: 409,
      });
    }
  }
  const storedName = `${Date.now()}-${crypto.randomBytes(10).toString('hex')}.${ext}`;
  const absolute = path.join(directory, storedName);
  const fileUrl = `/uploads/files/${tid}/${purpose}/${encodeURIComponent(storedName)}`;
  try {
    await fsp.writeFile(absolute, bytes, { flag: 'wx', mode: 0o600 });
    const inserted = q.run(
      `INSERT INTO uploaded_files(
        user_id,name,stored_name,ext,mime,size,purpose,file_path,file_url,
        extracted_text,extract_mode
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      userId,
      `${String(label || 'asset')
        .replace(/[^a-z0-9_-]/giu, '_')
        .slice(0, 60)}.${ext}`,
      storedName,
      ext,
      String(mime).toLowerCase(),
      bytes.length,
      purpose,
      absolute,
      fileUrl,
      '',
      'AI带货员供应商素材',
    );
    return q.get('SELECT * FROM uploaded_files WHERE tenant_id=? AND id=?', tid, inserted.lastInsertRowid);
  } catch (error) {
    await fsp.rm(absolute, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * 路由默认 publishAsset：落库 + 签名 URL；无公网 base URL 时返回 null。
 */
export function createAiSalesVideoAssetPublisher({
  tenantId,
  userId,
  publicBaseUrl = null,
  ttlSeconds = 2 * 60 * 60,
  includeMetadata = false,
} = {}) {
  return async ({ bytes, mime, purpose, label }) => {
    if (!aiSalesVideoProviderPublicBaseUrl(publicBaseUrl)) return null;
    const row = await persistAiSalesVideoProviderAsset({ tenantId, userId, purpose, bytes, mime, label });
    const url = createAiSalesVideoProviderAssetUrl(
      { tenantId, fileId: row.id, purpose },
      { publicBaseUrl, ttlSeconds },
    );
    return includeMetadata
      ? { url, fileId: Number(row.id), sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
      : url;
  };
}

// Recovery reads by tenant + creator + purpose + immutable byte hash, never a
// caller-supplied path or an expired provider URL. Copy into the recovery temp
// directory after read-back so ffmpeg cannot race a later uploaded-file edit.
export async function readAiSalesVideoVoiceAsset({ tenantId, userId, fileId, sha256 }) {
  if (
    Number(curTenant()) !== Number(tenantId) ||
    !Number.isSafeInteger(Number(fileId)) ||
    Number(fileId) <= 0 ||
    !/^[a-f0-9]{64}$/u.test(String(sha256 || ''))
  )
    throw Object.assign(new Error('原配音资产标识无效'), { code: 'AI_SALES_VOICE_ASSET_INVALID', status: 409 });
  const row = q.get(
    "SELECT file_path,size,mime FROM uploaded_files WHERE tenant_id=? AND id=? AND user_id=? AND purpose='ai-sales-video-audio'",
    tenantId,
    fileId,
    userId,
  );
  try {
    if (!row || !purposeMatchesMime('ai-sales-video-audio', row.mime)) throw new Error('missing');
    const root = path.join(await fsp.realpath(UPLOAD_ROOT), String(tenantId), 'ai-sales-video-audio');
    const actual = await fsp.realpath(row.file_path),
      stat = await fsp.lstat(row.file_path);
    if (
      !actual.startsWith(`${root}${path.sep}`) ||
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > MAX_BYTES ||
      stat.size !== Number(row.size)
    )
      throw new Error('unsafe');
    const bytes = await fsp.readFile(actual);
    if (bytes.length !== stat.size || crypto.createHash('sha256').update(bytes).digest('hex') !== sha256)
      throw new Error('changed');
    return bytes;
  } catch {
    throw Object.assign(new Error('原配音资产缺失、已改变或不属于本次任务，不能重复生成代替'), {
      code: 'AI_SALES_VOICE_ASSET_UNAVAILABLE',
      status: 409,
    });
  }
}

function safeAssetFromToken(token) {
  if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) return null;
  const payload = verifyToken(token);
  const tenantId = Number(payload?.tenantId);
  const fileId = Number(payload?.fileId);
  const purpose = String(payload?.filePurpose || '');
  if (
    payload?.tokenPurpose !== TOKEN_PURPOSE ||
    !Number.isFinite(payload?.exp) ||
    payload.exp <= Date.now() ||
    !Number.isSafeInteger(tenantId) ||
    tenantId <= 0 ||
    !Number.isSafeInteger(fileId) ||
    fileId <= 0 ||
    !ALLOWED_PURPOSES.has(purpose)
  ) {
    return null;
  }
  return runWithTenant(tenantId, () => {
    const row = q.get(
      `SELECT id,tenant_id,purpose,file_path,mime,size
      FROM uploaded_files WHERE tenant_id=? AND id=? AND purpose=?`,
      tenantId,
      fileId,
      purpose,
    );
    if (!row || !purposeMatchesMime(purpose, row.mime)) return null;
    try {
      const realRoot = path.join(fs.realpathSync(UPLOAD_ROOT), String(tenantId), purpose);
      const realFile = fs.realpathSync(String(row.file_path || ''));
      const stat = fs.lstatSync(String(row.file_path || ''));
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.size <= 0 ||
        stat.size > MAX_BYTES ||
        stat.size !== Number(row.size || 0) ||
        !realFile.startsWith(`${realRoot}${path.sep}`)
      ) {
        return null;
      }
      return { row, realFile };
    } catch {
      return null;
    }
  });
}

export function serveAiSalesVideoProviderAsset(req, res) {
  const asset = safeAssetFromToken(String(req.params?.token || ''));
  if (!asset) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', asset.row.mime);
  res.setHeader('Content-Length', String(asset.row.size));
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(asset.realFile, error => {
    if (error && !res.headersSent) res.status(404).end();
  });
}
