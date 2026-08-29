"use strict";

const {
  classifyNavigation,
  createRemoteWebPreferences,
} = require("./security.cjs");

function openExternalSafely(shell, url) {
  try {
    const result = shell.openExternal(url, { activate: true });
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // Opening a browser is best-effort; unsafe fallbacks are intentionally not used.
  }
}

function installNavigationPolicy(webContents, options) {
  const getAllowedOrigin = options.getAllowedOrigin;
  const shell = options.shell;

  webContents.setWindowOpenHandler(({ url }) => {
    const classification = classifyNavigation(url, getAllowedOrigin());
    if (classification === "allow") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: createRemoteWebPreferences(),
        },
      };
    }
    if (classification === "external") openExternalSafely(shell, url);
    return { action: "deny" };
  });

  const handleNavigation = (event, url) => {
    const targetUrl = typeof url === "string" ? url : event?.url;
    const classification = classifyNavigation(targetUrl, getAllowedOrigin());
    if (classification === "allow") return;
    event.preventDefault();
    if (classification === "external") openExternalSafely(shell, targetUrl);
  };
  webContents.on("will-navigate", handleNavigation);
  webContents.on("will-redirect", handleNavigation);
  webContents.on("will-attach-webview", (event) => event.preventDefault());
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function mayWriteSanitizedClipboard(
  webContents,
  permission,
  requestingUrl,
  options,
) {
  if (permission !== "clipboard-sanitized-write") return false;
  if (!options?.isManagedRemoteContents?.(webContents)) return false;

  const allowedOrigin = originOf(options.getAllowedOrigin?.());
  let activeUrl = requestingUrl;
  if (!activeUrl && typeof webContents?.getURL === "function") {
    try {
      activeUrl = webContents.getURL();
    } catch {
      return false;
    }
  }
  return Boolean(allowedOrigin && originOf(activeUrl) === allowedOrigin);
}

function installSessionSecurity(electronSession, options = {}) {
  electronSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) =>
      callback(
        mayWriteSanitizedClipboard(
          webContents,
          permission,
          details?.requestingUrl,
          options,
        ),
      ),
  );
  electronSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin) =>
      mayWriteSanitizedClipboard(
        webContents,
        permission,
        requestingOrigin,
        options,
      ),
  );
  if (typeof electronSession.setDevicePermissionHandler === "function") {
    electronSession.setDevicePermissionHandler(() => false);
  }
}

module.exports = {
  installNavigationPolicy,
  installSessionSecurity,
  openExternalSafely,
};
