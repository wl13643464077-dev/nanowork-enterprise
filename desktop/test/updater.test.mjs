import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  normalizeUpdateFeedUrl,
  getUpdateEligibility,
  configureAutoUpdates,
} = require("../src/updater.cjs");

test("update feeds require clean HTTPS URLs", () => {
  assert.equal(
    normalizeUpdateFeedUrl("https://releases.example.com/nanowork/"),
    "https://releases.example.com/nanowork/",
  );
  for (const value of [
    "",
    "http://releases.example.com",
    "https://user:secret@releases.example.com",
    "https://releases.example.com/feed?token=secret",
    "file:///tmp/feed",
  ]) {
    assert.equal(normalizeUpdateFeedUrl(value), null, value);
  }
});

test("updates stay disabled unless a packaged build explicitly opts in with a valid HTTPS feed", () => {
  assert.deepEqual(
    getUpdateEligibility({
      isPackaged: false,
      enabled: "true",
      feedUrl: "https://releases.example.com",
    }),
    {
      enabled: false,
      reason: "not-packaged",
    },
  );
  assert.deepEqual(
    getUpdateEligibility({
      isPackaged: true,
      enabled: "",
      feedUrl: "https://releases.example.com",
    }),
    {
      enabled: false,
      reason: "not-enabled",
    },
  );
  assert.deepEqual(
    getUpdateEligibility({
      isPackaged: true,
      enabled: "true",
      feedUrl: "http://releases.example.com",
    }),
    {
      enabled: false,
      reason: "invalid-feed",
    },
  );
  assert.deepEqual(
    getUpdateEligibility({
      isPackaged: true,
      enabled: "true",
      feedUrl: "https://releases.example.com",
    }),
    {
      enabled: true,
      feedUrl: "https://releases.example.com/",
    },
  );
});

test("disabled updates perform no updater calls or network checks", async () => {
  const calls = [];
  const result = await configureAutoUpdates({
    app: { isPackaged: true },
    enabled: "false",
    feedUrl: "https://releases.example.com",
    autoUpdater: new Proxy(
      {},
      { get: (_target, key) => () => calls.push(key) },
    ),
    dialog: {},
  });
  assert.deepEqual(result, { enabled: false, reason: "not-enabled" });
  assert.deepEqual(calls, []);
});

test("a missing feed performs no updater calls even when the update flag is enabled", async () => {
  const calls = [];
  const result = await configureAutoUpdates({
    app: { isPackaged: true },
    enabled: "true",
    feedUrl: "",
    autoUpdater: new Proxy(
      {},
      { get: (_target, key) => () => calls.push(key) },
    ),
    dialog: {},
  });
  assert.deepEqual(result, { enabled: false, reason: "invalid-feed" });
  assert.deepEqual(calls, []);
});

test("an eligible updater configures only the validated generic HTTPS feed and checks once", async () => {
  const calls = [];
  const listeners = new Map();
  const autoUpdater = {
    setFeedURL(value) {
      calls.push(["feed", value]);
    },
    on(name, handler) {
      listeners.set(name, handler);
    },
    async checkForUpdates() {
      calls.push(["check"]);
    },
  };
  const result = await configureAutoUpdates({
    app: { isPackaged: true },
    enabled: "true",
    feedUrl: "https://releases.example.com/nanowork/",
    autoUpdater,
    dialog: {},
  });

  assert.deepEqual(result, {
    enabled: true,
    feedUrl: "https://releases.example.com/nanowork/",
  });
  assert.deepEqual(calls, [
    [
      "feed",
      {
        provider: "generic",
        url: "https://releases.example.com/nanowork/",
      },
    ],
    ["check"],
  ]);
  assert.deepEqual([...listeners.keys()].sort(), [
    "error",
    "update-available",
    "update-downloaded",
  ]);
  assert.equal(autoUpdater.autoDownload, false);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);
});
