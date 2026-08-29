"use strict";

const api = window.nanoWorkDesktop;
const form = document.querySelector("#settings-form");
const serverUrlInput = document.querySelector("#server-url");
const checkButton = document.querySelector("#check-button");
const saveButton = document.querySelector("#save-button");
const forceSaveButton = document.querySelector("#force-save-button");
const retryButton = document.querySelector("#retry-button");
const statusBox = document.querySelector("#status");
const statusTitle = document.querySelector("#status-title");
const statusDetail = document.querySelector("#status-detail");
const version = document.querySelector("#version");

function setBusy(busy) {
  checkButton.disabled = busy;
  saveButton.disabled = busy;
  forceSaveButton.disabled = busy;
  retryButton.disabled = busy;
  serverUrlInput.disabled = busy;
}

function setStatus(kind, title, detail) {
  statusBox.className = `status status-${kind}`;
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
}

function hideForceSave() {
  forceSaveButton.classList.add("hidden");
}

async function checkConnection() {
  hideForceSave();
  setBusy(true);
  setStatus("loading", "正在检查连接", "客户端正在访问 /api/health…");
  try {
    const result = await api.checkServer(serverUrlInput.value);
    if (result.ok) {
      serverUrlInput.value = result.serverUrl;
      setStatus("success", "服务器可用", result.message);
    } else {
      setStatus(
        result.validationError ? "error" : "warning",
        result.validationError ? "地址不合法" : "服务器暂不可达",
        result.message,
      );
    }
    return result;
  } catch {
    setStatus("error", "检查失败", "客户端无法完成连接检查，请重试。");
    return { ok: false };
  } finally {
    setBusy(false);
  }
}

async function saveServer(allowUnhealthy) {
  setBusy(true);
  hideForceSave();
  setStatus("loading", "正在保存", "正在验证地址并重新连接…");
  try {
    const result = await api.saveServer(serverUrlInput.value, allowUnhealthy);
    if (result.requiresConfirmation) {
      setStatus(
        "warning",
        "服务器暂不可达",
        `${result.message}。确认地址无误后，可以仍然保存。`,
      );
      forceSaveButton.classList.remove("hidden");
      return;
    }
    if (!result.ok) {
      setStatus(
        result.validationError ? "error" : "warning",
        result.validationError ? "无法保存" : "连接失败",
        result.message,
      );
      return;
    }
    serverUrlInput.value = result.serverUrl;
    setStatus(
      result.connected ? "success" : "warning",
      result.connected ? "已保存并连接" : "地址已保存",
      result.message,
    );
    if (result.connected) window.setTimeout(() => window.close(), 450);
  } catch {
    setStatus("error", "保存失败", "未能保存地址，原有设置没有被覆盖。");
  } finally {
    setBusy(false);
  }
}

checkButton.addEventListener("click", () => void checkConnection());
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveServer(false);
});
forceSaveButton.addEventListener("click", () => void saveServer(true));
retryButton.addEventListener("click", async () => {
  setBusy(true);
  hideForceSave();
  setStatus("loading", "正在重试", "使用已保存的地址连接…");
  try {
    const result = await api.retry();
    setStatus(
      result.ok ? "success" : "warning",
      result.ok ? "已重新连接" : "仍然无法连接",
      result.message,
    );
    if (result.ok) window.setTimeout(() => window.close(), 450);
  } catch {
    setStatus("error", "重试失败", "请检查网络或修改服务器地址。");
  } finally {
    setBusy(false);
  }
});

void api
  .getSettings()
  .then((settings) => {
    serverUrlInput.value = settings.serverUrl;
    version.textContent = `v${settings.version} · ${settings.platform} · Electron ${settings.electron}`;
    setStatus("loading", "已读取当前地址", "点击“检查连接”或直接保存。");
    serverUrlInput.focus();
    serverUrlInput.select();
  })
  .catch(() => {
    setStatus("error", "无法读取设置", "请关闭窗口后重试。");
    setBusy(true);
  });
