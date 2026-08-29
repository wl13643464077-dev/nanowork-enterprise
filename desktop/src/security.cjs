"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

function createRemoteWebPreferences() {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    navigateOnDragDrop: false,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    safeDialogs: true,
    safeDialogsMessage: "此页面已打开多个对话框。",
  };
}

function createSettingsWebPreferences(preload) {
  return {
    ...createRemoteWebPreferences(),
    preload,
  };
}

function classifyNavigation(targetUrl, allowedOrigin) {
  try {
    const target = new URL(targetUrl);
    const allowed = new URL(allowedOrigin);
    if (target.username || target.password) return "block";
    if (
      target.origin === allowed.origin &&
      target.protocol === allowed.protocol
    )
      return "allow";
    if (target.protocol === "https:") return "external";
  } catch {
    // Invalid and non-absolute targets are never navigation destinations.
  }
  return "block";
}

function isTrustedSettingsSender(event, expectedSettingsUrl) {
  const senderFrame = event?.senderFrame;
  const mainFrame = event?.sender?.mainFrame;
  return Boolean(
    senderFrame &&
    mainFrame &&
    senderFrame === mainFrame &&
    senderFrame.url === expectedSettingsUrl,
  );
}

function sanitizeDownloadFilename(input) {
  const leaf = String(input || "")
    .split(/[\\/]/)
    .pop();
  let cleaned = (leaf || "")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[<>:"|?*]/g, "_")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 180)
    .trim()
    .replace(/[. ]+$/g, "");
  if (!cleaned) cleaned = "download";

  const basename = cleaned.slice(
    0,
    cleaned.length - path.extname(cleaned).length,
  );
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(basename))
    cleaned = `_${cleaned}`;
  return cleaned;
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function chooseAvailableDownloadPath(directory, unsafeFilename) {
  const filename = sanitizeDownloadFilename(unsafeFilename);
  const extension = path.extname(filename);
  const stem =
    filename.slice(0, filename.length - extension.length) || "download";
  let candidate = path.join(directory, filename);
  let suffix = 1;
  while (await pathExists(candidate)) {
    candidate = path.join(directory, `${stem} (${suffix})${extension}`);
    suffix += 1;
  }
  return candidate;
}

function chooseAvailableDownloadPathSync(directory, unsafeFilename) {
  const filename = sanitizeDownloadFilename(unsafeFilename);
  const extension = path.extname(filename);
  const stem =
    filename.slice(0, filename.length - extension.length) || "download";
  let candidate = path.join(directory, filename);
  let suffix = 1;
  while (fsSync.existsSync(candidate)) {
    candidate = path.join(directory, `${stem} (${suffix})${extension}`);
    suffix += 1;
  }
  return candidate;
}

module.exports = {
  createRemoteWebPreferences,
  createSettingsWebPreferences,
  classifyNavigation,
  isTrustedSettingsSender,
  sanitizeDownloadFilename,
  chooseAvailableDownloadPath,
  chooseAvailableDownloadPathSync,
};
