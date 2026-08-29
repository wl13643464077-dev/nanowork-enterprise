import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { q, runWithTenant } from "../db.js";
import { signToken, verifyToken } from "../util.js";
import { isPublicWebAddress } from "./controlled-web-evidence.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_ROOT = path.resolve(
  __dirname,
  "..",
  "..",
  "data",
  "uploads",
  "files",
);
const TOKEN_PURPOSE = "avatar_provider_asset";
const ALLOWED_PURPOSES = new Set(["avatar-image", "avatar-provider-audio"]);
const ALLOWED_MIME = /^(?:image\/(?:jpeg|png|webp)|audio\/(?:mpeg|wav|mp4))$/iu;
const MAX_BYTES = 25 * 1024 * 1024;

function privateHost(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  return (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home") ||
    host.endsWith(".arpa") ||
    (!isIP(host) && !host.includes(".")) ||
    (isIP(host) && !isPublicWebAddress(host))
  );
}

function safePublicBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    parsed.search ||
    parsed.hash ||
    privateHost(parsed.hostname)
  ) {
    return null;
  }
  return parsed.href.replace(/\/+$/gu, "");
}

export function avatarProviderPublicBaseUrl(value = null) {
  return safePublicBaseUrl(
    value ||
      process.env.AVATAR_PROVIDER_PUBLIC_BASE_URL ||
      process.env.PUBLIC_BASE_URL ||
      process.env.APP_PUBLIC_URL,
  );
}

export function createAvatarProviderAssetUrl(
  { tenantId, fileId, purpose },
  { publicBaseUrl = null, ttlSeconds = 60 * 60 } = {},
) {
  const base = avatarProviderPublicBaseUrl(publicBaseUrl);
  const tid = Number(tenantId);
  const id = Number(fileId);
  const filePurpose = String(purpose || "");
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
    {
      tokenPurpose: TOKEN_PURPOSE,
      tenantId: tid,
      fileId: id,
      filePurpose,
    },
    Math.min(2 * 60 * 60, Math.max(5 * 60, Number(ttlSeconds) || 60 * 60)),
  );
  return `${base}/api/avatar/provider-assets/${encodeURIComponent(token)}`;
}

function safeAssetFromToken(token) {
  const payload = verifyToken(token);
  const tenantId = Number(payload?.tenantId);
  const fileId = Number(payload?.fileId);
  const purpose = String(payload?.filePurpose || "");
  if (
    payload?.tokenPurpose !== TOKEN_PURPOSE ||
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
    if (!row || !ALLOWED_MIME.test(String(row.mime || ""))) return null;
    const tenantRoot = path.resolve(UPLOAD_ROOT, String(tenantId));
    let realRoot;
    let realFile;
    try {
      realRoot = fs.realpathSync(tenantRoot);
      realFile = fs.realpathSync(String(row.file_path || ""));
      const stat = fs.lstatSync(realFile);
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
    } catch {
      return null;
    }
    return { row, realFile };
  });
}

export function serveAvatarProviderAsset(req, res) {
  const asset = safeAssetFromToken(String(req.params?.token || ""));
  if (!asset) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", asset.row.mime);
  res.setHeader("Content-Length", String(asset.row.size));
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(asset.realFile, (error) => {
    if (error && !res.headersSent) res.status(404).end();
  });
}
