import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEFAULT_SERVER_URL,
  normalizeServerUrl,
  resolveApplicationUrl,
  readDesktopConfig,
  writeDesktopConfig,
} = require("../src/config.cjs");

test("defaults to the local NanoWork service", () => {
  assert.equal(DEFAULT_SERVER_URL, "http://127.0.0.1:3107");
});

test("normalizes HTTPS origins and loopback HTTP origins", () => {
  const accepted = new Map([
    ["https://work.example.com", "https://work.example.com"],
    ["https://work.example.com:8443/", "https://work.example.com:8443"],
    ["http://localhost:3107/", "http://localhost:3107"],
    ["http://127.0.0.2:3107", "http://127.0.0.2:3107"],
    ["http://[::1]:3107", "http://[::1]:3107"],
  ]);

  for (const [input, expected] of accepted) {
    assert.equal(normalizeServerUrl(input), expected, input);
  }
});

test("rejects remote HTTP and URLs that are not a bare trustworthy origin", () => {
  const rejected = [
    "",
    "work.example.com",
    "http://work.example.com",
    "http://192.168.1.10:3107",
    "https://user:secret@work.example.com",
    "https://work.example.com/path",
    "https://work.example.com/?tenant=1",
    "https://work.example.com/#section",
    "file:///tmp/index.html",
    "javascript:alert(1)",
  ];

  for (const input of rejected) {
    assert.throws(
      () => normalizeServerUrl(input),
      { name: "ServerUrlError" },
      input,
    );
  }
});

test("resolves smoke paths only within the configured server origin", () => {
  assert.equal(
    resolveApplicationUrl(
      "https://work.example.com",
      "/employees?employee=101",
    ),
    "https://work.example.com/employees?employee=101",
  );
  assert.equal(
    resolveApplicationUrl(
      "https://work.example.com",
      "//evil.example.com/path",
    ),
    "https://work.example.com",
  );
  assert.equal(
    resolveApplicationUrl("https://work.example.com", "javascript:alert(1)"),
    "https://work.example.com",
  );
});

test("writes a schema-versioned config atomically and reads it back", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "nanowork-desktop-config-"),
  );
  const configPath = path.join(directory, "nested", "desktop-config.json");

  const saved = await writeDesktopConfig(
    configPath,
    "https://work.example.com",
  );
  const raw = JSON.parse(await readFile(configPath, "utf8"));

  assert.equal(saved.serverUrl, "https://work.example.com");
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.serverUrl, "https://work.example.com");
  assert.match(raw.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(await readDesktopConfig(configPath), raw);

  const replaced = await writeDesktopConfig(
    configPath,
    "https://next.example.com",
  );
  assert.equal(replaced.serverUrl, "https://next.example.com");
  assert.equal(
    (await readDesktopConfig(configPath)).serverUrl,
    "https://next.example.com",
  );
});

test("falls back safely when the config is missing or corrupted", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "nanowork-desktop-config-"),
  );
  const missingPath = path.join(directory, "missing.json");
  const corruptPath = path.join(directory, "corrupt.json");
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(corruptPath, "{bad json", "utf8"),
  );

  assert.equal(
    (await readDesktopConfig(missingPath)).serverUrl,
    DEFAULT_SERVER_URL,
  );
  assert.equal(
    (await readDesktopConfig(corruptPath)).serverUrl,
    DEFAULT_SERVER_URL,
  );
});
