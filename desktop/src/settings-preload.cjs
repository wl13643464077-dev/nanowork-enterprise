"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = Object.freeze({
  get: "nanowork:settings:get",
  check: "nanowork:settings:check",
  save: "nanowork:settings:save",
  retry: "nanowork:settings:retry",
});

contextBridge.exposeInMainWorld(
  "nanoWorkDesktop",
  Object.freeze({
    getSettings: () => ipcRenderer.invoke(CHANNELS.get),
    checkServer: (serverUrl) => ipcRenderer.invoke(CHANNELS.check, serverUrl),
    saveServer: (serverUrl, allowUnhealthy = false) =>
      ipcRenderer.invoke(CHANNELS.save, {
        serverUrl,
        allowUnhealthy: allowUnhealthy === true,
      }),
    retry: () => ipcRenderer.invoke(CHANNELS.retry),
  }),
);
