import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createRemoteWebPreferences,
  createSettingsWebPreferences,
  classifyNavigation,
  isTrustedSettingsSender,
  sanitizeDownloadFilename,
  chooseAvailableDownloadPath,
} = require("../src/security.cjs");

test("remote windows expose no preload, Node, webview, or weakened renderer boundary", () => {
  const preferences = createRemoteWebPreferences();
  assert.equal(preferences.preload, undefined);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.webSecurity, true);
  assert.equal(preferences.webviewTag, false);
  assert.equal(preferences.navigateOnDragDrop, false);
  assert.equal(preferences.allowRunningInsecureContent, false);
  assert.equal(preferences.experimentalFeatures, false);
  assert.equal(preferences.nodeIntegrationInWorker, false);
  assert.equal(preferences.nodeIntegrationInSubFrames, false);
  assert.equal(preferences.safeDialogs, true);
});

test("only the local settings window receives the minimal settings preload", () => {
  const preferences = createSettingsWebPreferences("/app/settings-preload.cjs");
  assert.equal(preferences.preload, "/app/settings-preload.cjs");
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.webSecurity, true);
  assert.equal(preferences.webviewTag, false);
});

test("navigation keeps same-origin URLs in-app, opens clean external HTTPS in the browser, and blocks the rest", () => {
  const origin = "https://work.example.com";
  assert.equal(
    classifyNavigation(
      "https://work.example.com/employees?employee=101",
      origin,
    ),
    "allow",
  );
  assert.equal(
    classifyNavigation("https://docs.example.com/guide", origin),
    "external",
  );
  assert.equal(
    classifyNavigation("https://user:secret@docs.example.com/guide", origin),
    "block",
  );
  assert.equal(
    classifyNavigation("http://docs.example.com/guide", origin),
    "block",
  );
  assert.equal(classifyNavigation("javascript:alert(1)", origin), "block");
  assert.equal(classifyNavigation("file:///etc/passwd", origin), "block");
  assert.equal(classifyNavigation("not a URL", origin), "block");
});

test("settings IPC accepts only the settings main frame with the exact local file URL", () => {
  const expectedUrl = pathToFileURL(
    "/Applications/NanoWork/settings.html",
  ).href;
  const mainFrame = { url: expectedUrl };
  const trustedEvent = { senderFrame: mainFrame, sender: { mainFrame } };

  assert.equal(isTrustedSettingsSender(trustedEvent, expectedUrl), true);
  assert.equal(
    isTrustedSettingsSender(
      { senderFrame: { url: expectedUrl }, sender: { mainFrame } },
      expectedUrl,
    ),
    false,
  );
  assert.equal(
    isTrustedSettingsSender(
      {
        senderFrame: { url: "https://work.example.com" },
        sender: { mainFrame: { url: "https://work.example.com" } },
      },
      expectedUrl,
    ),
    false,
  );
  assert.equal(isTrustedSettingsSender({}, expectedUrl), false);
});

test("download filenames cannot escape Downloads or retain control/reserved characters", () => {
  assert.equal(sanitizeDownloadFilename("../../secret.txt"), "secret.txt");
  assert.equal(sanitizeDownloadFilename("..\\..\\secret.txt"), "secret.txt");
  assert.equal(
    sanitizeDownloadFilename("report\u0000:<final>?.pdf"),
    "report___final__.pdf",
  );
  assert.equal(sanitizeDownloadFilename("   ...   "), "download");
  assert.equal(sanitizeDownloadFilename("CON"), "_CON");
});

test("download paths do not silently overwrite an existing file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nanowork-download-"));
  await writeFile(path.join(directory, "report.pdf"), "existing");
  await writeFile(path.join(directory, "report (1).pdf"), "existing");

  assert.equal(
    await chooseAvailableDownloadPath(directory, "report.pdf"),
    path.join(directory, "report (2).pdf"),
  );
});
