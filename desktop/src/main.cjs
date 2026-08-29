"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const electron = require("electron");
const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, net, shell } =
  electron;
const {
  DEFAULT_SERVER_URL,
  ServerUrlError,
  normalizeServerUrl,
  readDesktopConfig,
  resolveApplicationUrl,
  writeDesktopConfig,
} = require("./config.cjs");
const { checkServerHealth } = require("./health.cjs");
const {
  chooseAvailableDownloadPathSync,
  createRemoteWebPreferences,
  createSettingsWebPreferences,
  isTrustedSettingsSender,
} = require("./security.cjs");
const {
  installNavigationPolicy,
  installSessionSecurity,
} = require("./window-policy.cjs");
const {
  focusOrReconnectMainWindow,
  isUsableWindow,
  visibleWindowOrUndefined,
} = require("./window-lifecycle.cjs");
const { configureAutoUpdates, getUpdateEligibility } = require("./updater.cjs");

const CHANNELS = Object.freeze({
  get: "nanowork:settings:get",
  check: "nanowork:settings:check",
  save: "nanowork:settings:save",
  retry: "nanowork:settings:retry",
});
const SETTINGS_HTML_PATH = path.join(
  __dirname,
  "..",
  "renderer",
  "settings.html",
);
const SETTINGS_URL = pathToFileURL(SETTINGS_HTML_PATH).href;
const SETTINGS_PRELOAD_PATH = path.join(__dirname, "settings-preload.cjs");
const HEALTH_TIMEOUT_MS = 6_000;
const PAGE_LOAD_TIMEOUT_MS = 7_500;
const SMOKE_MODE = process.env.NANOWORK_DESKTOP_SMOKE === "1";
const SMOKE_SETTINGS =
  SMOKE_MODE && process.env.NANOWORK_DESKTOP_SMOKE_SETTINGS === "1";

app.enableSandbox();

if (SMOKE_MODE) {
  const smokeUserData = process.env.NANOWORK_DESKTOP_SMOKE_USER_DATA;
  app.setPath(
    "userData",
    smokeUserData ||
      path.join(app.getPath("temp"), `nanowork-desktop-smoke-${process.pid}`),
  );
}

let mainWindow = null;
let settingsWindow = null;
let activeConfig = { serverUrl: DEFAULT_SERVER_URL, updatedAt: null };
let connectionAttempt = 0;
let activeLoadInProgress = false;
let failurePrompt = null;
let quitting = false;
const managedRemoteContents = new Set();
const hardenedSessions = new WeakSet();
const downloadSessions = new WeakSet();

function configPath() {
  return path.join(app.getPath("userData"), "desktop-config.json");
}

function showMessageBox(parentWindow, options) {
  return parentWindow
    ? dialog.showMessageBox(parentWindow, options)
    : dialog.showMessageBox(options);
}

function currentApplicationUrl() {
  return resolveApplicationUrl(
    activeConfig.serverUrl,
    SMOKE_MODE ? process.env.NANOWORK_DESKTOP_SMOKE_PATH : undefined,
  );
}

function healthCheck(serverUrl) {
  return checkServerHealth(serverUrl, {
    timeoutMs: HEALTH_TIMEOUT_MS,
    fetchImpl:
      typeof net?.fetch === "function"
        ? (url, options) => net.fetch(url, options)
        : globalThis.fetch,
  });
}

async function waitForSmokeRenderer(window) {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const rendered = await window.webContents
      .executeJavaScript(
        `Boolean(document.querySelector('#root')?.childElementCount > 0 && document.title.includes('纳米Work'))`,
        true,
      )
      .catch(() => false);
    if (rendered) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function waitForSmokeSettings(window) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const ready = await window.webContents
      .executeJavaScript(
        `Boolean(
          ['getSettings', 'checkServer', 'saveServer', 'retry'].every(
            name => typeof window.nanoWorkDesktop?.[name] === 'function'
          ) && document.querySelector('#server-url')?.value
        )`,
        true,
      )
      .catch(() => false);
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function showNotification(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, silent: true }).show();
}

function installDownloadPolicy(electronSession) {
  if (downloadSessions.has(electronSession)) return;
  downloadSessions.add(electronSession);
  electronSession.on("will-download", (_event, item, sourceWebContents) => {
    if (
      !sourceWebContents ||
      !managedRemoteContents.has(sourceWebContents.id)
    ) {
      item.cancel();
      return;
    }

    const downloadsDirectory = app.getPath("downloads");
    fs.mkdirSync(downloadsDirectory, { recursive: true });
    const destination = chooseAvailableDownloadPathSync(
      downloadsDirectory,
      item.getFilename(),
    );
    item.setSavePath(destination);
    const ownerWindow = BrowserWindow.fromWebContents(sourceWebContents);

    item.on("updated", () => {
      const total = item.getTotalBytes();
      if (isUsableWindow(ownerWindow) && total > 0) {
        ownerWindow.setProgressBar(
          Math.min(1, item.getReceivedBytes() / total),
        );
      }
    });
    item.once("done", (_downloadEvent, state) => {
      if (isUsableWindow(ownerWindow)) ownerWindow.setProgressBar(-1);
      const filename = path.basename(destination);
      if (state === "completed") {
        showNotification("下载完成", `${filename} 已保存到下载文件夹`);
      } else if (state !== "cancelled") {
        showNotification("下载失败", `${filename} 未能下载，请重试`);
      }
    });
  });
}

function hardenSession(electronSession) {
  if (!hardenedSessions.has(electronSession)) {
    installSessionSecurity(electronSession, {
      getAllowedOrigin: () => activeConfig.serverUrl,
      isManagedRemoteContents: (webContents) =>
        Boolean(webContents && managedRemoteContents.has(webContents.id)),
    });
    hardenedSessions.add(electronSession);
  }
  installDownloadPolicy(electronSession);
}

function hardenRemoteWindow(window) {
  const webContents = window.webContents;
  managedRemoteContents.add(webContents.id);
  hardenSession(webContents.session);
  installNavigationPolicy(webContents, {
    getAllowedOrigin: () => activeConfig.serverUrl,
    shell,
  });
  webContents.on("did-create-window", (childWindow) =>
    hardenRemoteWindow(childWindow),
  );
  webContents.once("destroyed", () =>
    managedRemoteContents.delete(webContents.id),
  );
}

function createMainWindow() {
  const window = new BrowserWindow({
    title: "纳米Work",
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#f7f5f1",
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: createRemoteWebPreferences(),
  });
  hardenRemoteWindow(window);
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, _description, _validatedUrl, isMainFrame) => {
      if (
        isMainFrame &&
        errorCode !== -3 &&
        !activeLoadInProgress &&
        !quitting
      ) {
        void showConnectionFailure("页面连接中断，请重试");
      }
    },
  );
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

function createSettingsWindow() {
  if (isUsableWindow(settingsWindow)) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  const window = new BrowserWindow({
    title: "纳米Work · 服务器设置",
    width: 620,
    height: 610,
    minWidth: 520,
    minHeight: 540,
    resizable: true,
    maximizable: false,
    show: false,
    backgroundColor: "#f7f5f1",
    parent:
      isUsableWindow(mainWindow) && mainWindow.isVisible()
        ? mainWindow
        : undefined,
    modal: false,
    webPreferences: createSettingsWebPreferences(SETTINGS_PRELOAD_PATH),
  });
  hardenSession(window.webContents.session);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== SETTINGS_URL) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (settingsWindow === window) settingsWindow = null;
  });
  void window.loadFile(SETTINGS_HTML_PATH).catch(() => {
    dialog.showErrorBox(
      "无法打开服务器设置",
      "客户端安装文件不完整，请重新安装。",
    );
  });
  settingsWindow = window;
  return window;
}

async function loadPageWithTimeout(window, url) {
  let timer;
  try {
    await Promise.race([
      window.loadURL(url),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error("page-load-timeout"), {
                code: "PAGE_LOAD_TIMEOUT",
              }),
            ),
          PAGE_LOAD_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function connectToServer({ promptOnFailure = false } = {}) {
  const attempt = ++connectionAttempt;
  const health = await healthCheck(activeConfig.serverUrl);
  if (attempt !== connectionAttempt)
    return { ok: false, superseded: true, message: "连接已由新请求取代" };
  if (!health.ok) {
    if (promptOnFailure) void showConnectionFailure(health.message);
    return health;
  }

  if (!isUsableWindow(mainWindow)) mainWindow = createMainWindow();
  activeLoadInProgress = true;
  try {
    await loadPageWithTimeout(mainWindow, currentApplicationUrl());
    if (SMOKE_MODE && !(await waitForSmokeRenderer(mainWindow))) {
      throw new Error("smoke-renderer-not-ready");
    }
    if (attempt !== connectionAttempt)
      return { ok: false, superseded: true, message: "连接已由新请求取代" };
    mainWindow.show();
    mainWindow.focus();
    return { ok: true, status: health.status, message: "已连接并打开纳米Work" };
  } catch {
    if (isUsableWindow(mainWindow)) mainWindow.webContents.stop();
    const failed = {
      ok: false,
      status: null,
      message: "服务已响应，但页面未能在预期时间内打开",
    };
    if (promptOnFailure) void showConnectionFailure(failed.message);
    return failed;
  } finally {
    activeLoadInProgress = false;
  }
}

async function showConnectionFailure(reason) {
  if (failurePrompt || quitting) return failurePrompt;
  failurePrompt = showMessageBox(visibleWindowOrUndefined(mainWindow), {
    type: "warning",
    title: "无法连接纳米Work",
    message: "暂时无法打开业务服务",
    detail: `当前地址：${activeConfig.serverUrl}\n${reason}`,
    buttons: ["重试", "修改地址", "退出"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })
    .then(({ response }) => {
      if (response === 0)
        setImmediate(() => void connectToServer({ promptOnFailure: true }));
      else if (response === 1) createSettingsWindow();
      else app.quit();
    })
    .finally(() => {
      failurePrompt = null;
    });
  return failurePrompt;
}

function trustedSettingsEvent(event) {
  if (!isTrustedSettingsSender(event, SETTINGS_URL))
    throw new Error("UNTRUSTED_SETTINGS_IPC");
}

function normalizeInputForIpc(value) {
  if (typeof value !== "string" || value.length > 2048)
    throw new Error("服务器地址不合法");
  return normalizeServerUrl(value);
}

function registerSettingsIpc() {
  ipcMain.handle(CHANNELS.get, async (event) => {
    trustedSettingsEvent(event);
    return {
      serverUrl: activeConfig.serverUrl,
      updatedAt: activeConfig.updatedAt,
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
    };
  });
  ipcMain.handle(CHANNELS.check, async (event, value) => {
    trustedSettingsEvent(event);
    try {
      const serverUrl = normalizeInputForIpc(value);
      return { serverUrl, ...(await healthCheck(serverUrl)) };
    } catch (error) {
      return {
        ok: false,
        validationError: true,
        status: null,
        message: error.message,
      };
    }
  });
  ipcMain.handle(CHANNELS.save, async (event, payload) => {
    trustedSettingsEvent(event);
    try {
      if (
        !payload ||
        typeof payload !== "object" ||
        typeof payload.allowUnhealthy !== "boolean"
      ) {
        throw new Error("保存请求格式不正确");
      }
      const serverUrl = normalizeInputForIpc(payload.serverUrl);
      const health = await healthCheck(serverUrl);
      if (!health.ok && !payload.allowUnhealthy) {
        return { ...health, serverUrl, requiresConfirmation: true };
      }
      const previousOrigin = activeConfig.serverUrl;
      activeConfig = await writeDesktopConfig(configPath(), serverUrl);
      if (
        previousOrigin !== activeConfig.serverUrl &&
        isUsableWindow(mainWindow)
      ) {
        mainWindow.destroy();
        mainWindow = null;
      }
      if (!health.ok) {
        return {
          ok: true,
          connected: false,
          serverUrl,
          message: "地址已保存，但服务当前不可达",
        };
      }
      const connection = await connectToServer({ promptOnFailure: false });
      return { ...connection, connected: connection.ok, serverUrl };
    } catch (error) {
      return {
        ok: false,
        validationError: error instanceof ServerUrlError,
        status: null,
        message:
          error instanceof ServerUrlError
            ? error.message
            : "无法保存服务器地址，原有设置未改变",
      };
    }
  });
  ipcMain.handle(CHANNELS.retry, async (event) => {
    trustedSettingsEvent(event);
    return connectToServer({ promptOnFailure: false });
  });
}

function showAbout() {
  void showMessageBox(visibleWindowOrUndefined(mainWindow), {
    type: "info",
    title: "关于纳米Work",
    message: `纳米Work ${app.getVersion()}`,
    detail: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}\n${process.platform} ${process.arch}\n服务器：${activeConfig.serverUrl}`,
    buttons: ["确定"],
    noLink: true,
  });
}

function installApplicationMenu() {
  const appMenu = {
    label: "纳米Work",
    submenu: [
      { label: "关于纳米Work", click: showAbout },
      { type: "separator" },
      {
        label: "服务器设置…",
        accelerator: "CmdOrCtrl+,",
        click: createSettingsWindow,
      },
      { type: "separator" },
      { role: "quit", label: "退出纳米Work" },
    ],
  };
  const template = [
    ...(process.platform === "darwin" ? [appMenu] : []),
    {
      label: "文件",
      submenu: [
        {
          label: "服务器设置…",
          accelerator: "CmdOrCtrl+,",
          click: createSettingsWindow,
        },
        { type: "separator" },
        process.platform === "darwin"
          ? { role: "close", label: "关闭窗口" }
          : { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        ...(process.platform === "darwin"
          ? [{ type: "separator" }, { role: "front", label: "前置全部窗口" }]
          : []),
      ],
    },
    ...(process.platform === "darwin"
      ? []
      : [
          {
            label: "帮助",
            submenu: [{ label: "关于纳米Work", click: showAbout }],
          },
        ]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function startUpdaterIfEligible() {
  const enabled = process.env.NANOWORK_UPDATE_ENABLED;
  const feedUrl = process.env.NANOWORK_UPDATE_URL;
  const eligibility = getUpdateEligibility({
    isPackaged: app.isPackaged,
    enabled,
    feedUrl,
  });
  if (!eligibility.enabled) return eligibility;
  try {
    const { autoUpdater } = require("electron-updater");
    return configureAutoUpdates({
      app,
      autoUpdater,
      dialog,
      enabled,
      feedUrl,
      getParentWindow: () => visibleWindowOrUndefined(mainWindow),
    });
  } catch {
    return { enabled: false, reason: "updater-unavailable" };
  }
}

async function startApplication() {
  activeConfig = await readDesktopConfig(configPath());
  if (SMOKE_MODE && process.env.NANOWORK_DESKTOP_SERVER_URL) {
    activeConfig = {
      ...activeConfig,
      serverUrl: normalizeServerUrl(process.env.NANOWORK_DESKTOP_SERVER_URL),
    };
  }
  registerSettingsIpc();
  installApplicationMenu();
  mainWindow = createMainWindow();
  const connection = await connectToServer({ promptOnFailure: !SMOKE_MODE });
  if (SMOKE_MODE) {
    let smokePassed = connection.ok;
    if (smokePassed && SMOKE_SETTINGS) {
      const window = createSettingsWindow();
      smokePassed = await waitForSmokeSettings(window);
    }
    setTimeout(() => app.exit(smokePassed ? 0 : 1), smokePassed ? 750 : 50);
    return;
  }
  void startUpdaterIfEligible();
}

function focusOrReconnectApplicationWindow() {
  return focusOrReconnectMainWindow({
    getWindow: () => mainWindow,
    setWindow: (window) => {
      mainWindow = window;
    },
    createWindow: createMainWindow,
    reconnect: () => void connectToServer({ promptOnFailure: true }),
  });
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", focusOrReconnectApplicationWindow);
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app
    .whenReady()
    .then(async () => {
      await startApplication();
      if (!SMOKE_MODE) {
        app.on("activate", focusOrReconnectApplicationWindow);
      }
    })
    .catch(() => {
      if (SMOKE_MODE) {
        app.exit(1);
        return;
      }
      dialog.showErrorBox(
        "纳米Work 启动失败",
        "客户端未能完成启动，请重新安装后再试。",
      );
      app.quit();
    });
}
