"use strict";

function normalizeUpdateFeedUrl(input) {
  if (typeof input !== "string" || !input.trim()) return null;
  try {
    const parsed = new URL(input.trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function getUpdateEligibility({ isPackaged, enabled, feedUrl }) {
  if (!isPackaged) return { enabled: false, reason: "not-packaged" };
  if (!["1", "true"].includes(String(enabled || "").toLowerCase())) {
    return { enabled: false, reason: "not-enabled" };
  }
  const normalizedFeed = normalizeUpdateFeedUrl(feedUrl);
  if (!normalizedFeed) return { enabled: false, reason: "invalid-feed" };
  return { enabled: true, feedUrl: normalizedFeed };
}

function showMessageBox(dialog, parentWindow, options) {
  return parentWindow
    ? dialog.showMessageBox(parentWindow, options)
    : dialog.showMessageBox(options);
}

async function configureAutoUpdates(options) {
  const eligibility = getUpdateEligibility({
    isPackaged: options.app.isPackaged,
    enabled: options.enabled,
    feedUrl: options.feedUrl,
  });
  if (!eligibility.enabled) return eligibility;

  const { autoUpdater, dialog } = options;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({ provider: "generic", url: eligibility.feedUrl });

  autoUpdater.on("update-available", async (info) => {
    const result = await showMessageBox(dialog, options.getParentWindow?.(), {
      type: "info",
      title: "发现新版本",
      message: `纳米Work ${info.version} 已可用`,
      detail: "是否现在下载桌面客户端更新？",
      buttons: ["下载更新", "稍后"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0)
      await autoUpdater.downloadUpdate().catch(() => {});
  });

  autoUpdater.on("update-downloaded", async (info) => {
    const result = await showMessageBox(dialog, options.getParentWindow?.(), {
      type: "info",
      title: "更新已准备好",
      message: `纳米Work ${info.version} 已下载完成`,
      detail: "是否立即重启并安装？",
      buttons: ["立即重启", "稍后"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) autoUpdater.quitAndInstall(false, true);
  });

  // Update failures are non-fatal. Never surface raw feed URLs or response bodies.
  autoUpdater.on("error", () => {});
  await autoUpdater.checkForUpdates().catch(() => {});
  return eligibility;
}

module.exports = {
  normalizeUpdateFeedUrl,
  getUpdateEligibility,
  configureAutoUpdates,
};
