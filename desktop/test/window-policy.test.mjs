import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  installNavigationPolicy,
  installSessionSecurity,
} = require("../src/window-policy.cjs");

class FakeWebContents extends EventEmitter {
  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }
}

test("window policy applies the same secure options to same-origin popups", () => {
  const webContents = new FakeWebContents();
  installNavigationPolicy(webContents, {
    getAllowedOrigin: () => "https://work.example.com",
    shell: { openExternal: async () => {} },
  });

  const result = webContents.windowOpenHandler({
    url: "https://work.example.com/reports/1",
  });
  assert.equal(result.action, "allow");
  assert.equal(
    result.overrideBrowserWindowOptions.webPreferences.preload,
    undefined,
  );
  assert.equal(
    result.overrideBrowserWindowOptions.webPreferences.nodeIntegration,
    false,
  );
  assert.equal(
    result.overrideBrowserWindowOptions.webPreferences.contextIsolation,
    true,
  );
  assert.equal(
    result.overrideBrowserWindowOptions.webPreferences.sandbox,
    true,
  );
  assert.equal(
    result.overrideBrowserWindowOptions.webPreferences.webSecurity,
    true,
  );
});

test("window policy sends clean external HTTPS to the system browser and blocks unsafe destinations", () => {
  const opened = [];
  const webContents = new FakeWebContents();
  installNavigationPolicy(webContents, {
    getAllowedOrigin: () => "https://work.example.com",
    shell: { openExternal: async (url) => opened.push(url) },
  });

  assert.deepEqual(
    webContents.windowOpenHandler({ url: "https://docs.example.com/guide" }),
    { action: "deny" },
  );
  assert.deepEqual(opened, ["https://docs.example.com/guide"]);
  assert.deepEqual(
    webContents.windowOpenHandler({ url: "http://docs.example.com/guide" }),
    { action: "deny" },
  );
  assert.deepEqual(
    webContents.windowOpenHandler({ url: "file:///tmp/secret" }),
    { action: "deny" },
  );
  assert.deepEqual(opened, ["https://docs.example.com/guide"]);
});

test("cross-origin main-frame navigation is prevented while same-origin navigation proceeds", () => {
  const opened = [];
  const webContents = new FakeWebContents();
  installNavigationPolicy(webContents, {
    getAllowedOrigin: () => "https://work.example.com",
    shell: { openExternal: async (url) => opened.push(url) },
  });

  let prevented = false;
  webContents.emit(
    "will-navigate",
    { preventDefault: () => (prevented = true) },
    "https://docs.example.com/guide",
  );
  assert.equal(prevented, true);
  assert.deepEqual(opened, ["https://docs.example.com/guide"]);

  prevented = false;
  webContents.emit(
    "will-navigate",
    { preventDefault: () => (prevented = true) },
    "https://work.example.com/employees",
  );
  assert.equal(prevented, false);
});

test("current Electron navigation event objects are handled without deprecated positional URL arguments", () => {
  const opened = [];
  const webContents = new FakeWebContents();
  installNavigationPolicy(webContents, {
    getAllowedOrigin: () => "https://work.example.com",
    shell: { openExternal: async (url) => opened.push(url) },
  });

  let prevented = false;
  webContents.emit("will-redirect", {
    url: "https://docs.example.com/new-location",
    preventDefault: () => (prevented = true),
  });
  assert.equal(prevented, true);
  assert.deepEqual(opened, ["https://docs.example.com/new-location"]);
});

test("only same-origin managed remote pages may write the sanitized clipboard", () => {
  const fakeSession = {
    setPermissionRequestHandler(handler) {
      this.requestHandler = handler;
    },
    setPermissionCheckHandler(handler) {
      this.checkHandler = handler;
    },
    setDevicePermissionHandler(handler) {
      this.deviceHandler = handler;
    },
  };
  const managedContents = {
    id: 7,
    getURL: () => "https://work.example.com/employees",
  };
  installSessionSecurity(fakeSession, {
    getAllowedOrigin: () => "https://work.example.com",
    isManagedRemoteContents: (webContents) => webContents?.id === 7,
  });

  let requestResult = false;
  fakeSession.requestHandler(
    managedContents,
    "clipboard-sanitized-write",
    (value) => (requestResult = value),
    { requestingUrl: "https://work.example.com/employees" },
  );
  assert.equal(requestResult, true);
  assert.equal(
    fakeSession.checkHandler(
      managedContents,
      "clipboard-sanitized-write",
      "https://work.example.com",
    ),
    true,
  );

  requestResult = true;
  fakeSession.requestHandler(
    managedContents,
    "media",
    (value) => (requestResult = value),
  );
  assert.equal(requestResult, false);
  assert.equal(
    fakeSession.checkHandler(
      managedContents,
      "clipboard-read",
      "https://work.example.com",
    ),
    false,
  );
  assert.equal(
    fakeSession.checkHandler(
      { id: 8, getURL: () => "https://work.example.com/employees" },
      "clipboard-sanitized-write",
      "https://work.example.com",
    ),
    false,
  );
  assert.equal(
    fakeSession.checkHandler(
      managedContents,
      "clipboard-sanitized-write",
      "https://evil.example.com",
    ),
    false,
  );
  assert.equal(fakeSession.deviceHandler({ deviceType: "usb" }), false);
});
