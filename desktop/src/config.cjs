"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const CONFIG_SCHEMA_VERSION = 1;
const DEFAULT_SERVER_URL = "http://127.0.0.1:3107";

class ServerUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = "ServerUrlError";
  }
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/.test(part)) &&
    Number(octets[0]) === 127
  );
}

function normalizeServerUrl(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new ServerUrlError("请输入服务器地址");
  }

  let parsed;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new ServerUrlError("服务器地址必须是完整的 HTTPS URL");
  }

  if (parsed.username || parsed.password) {
    throw new ServerUrlError("服务器地址不能包含用户名或密码");
  }
  if (parsed.search || parsed.hash) {
    throw new ServerUrlError("服务器地址不能包含查询参数或锚点");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new ServerUrlError("请只填写服务器根地址，不要带路径");
  }

  const isHttps = parsed.protocol === "https:";
  const isAllowedLocalHttp =
    parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
  if (!isHttps && !isAllowedLocalHttp) {
    throw new ServerUrlError("远程服务器必须使用 HTTPS；HTTP 仅限本机回环地址");
  }

  return parsed.origin;
}

function resolveApplicationUrl(serverUrl, requestedPath) {
  const origin = normalizeServerUrl(serverUrl);
  if (typeof requestedPath !== "string" || !requestedPath) return origin;
  try {
    const candidate = new URL(requestedPath, `${origin}/`);
    return candidate.origin === origin &&
      ["http:", "https:"].includes(candidate.protocol)
      ? candidate.href
      : origin;
  } catch {
    return origin;
  }
}

function defaultConfig() {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    serverUrl: DEFAULT_SERVER_URL,
    updatedAt: null,
  };
}

async function readDesktopConfig(configPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
    if (parsed?.schemaVersion !== CONFIG_SCHEMA_VERSION) return defaultConfig();
    const serverUrl = normalizeServerUrl(parsed.serverUrl);
    return {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      serverUrl,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return defaultConfig();
  }
}

async function writeDesktopConfig(configPath, serverUrl) {
  const normalized = normalizeServerUrl(serverUrl);
  const nextConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    serverUrl: normalized,
    updatedAt: new Date().toISOString(),
  };
  const directory = path.dirname(configPath);
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(directory, { recursive: true });

  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, configPath);
    return nextConfig;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

module.exports = {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_SERVER_URL,
  ServerUrlError,
  isLoopbackHostname,
  normalizeServerUrl,
  resolveApplicationUrl,
  readDesktopConfig,
  writeDesktopConfig,
};
