import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rendererDirectory = fileURLToPath(
  new URL("../renderer/", import.meta.url),
);
const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));

test("the local settings page uses a restrictive CSP and no inline executable content", async () => {
  const html = await readFile(`${rendererDirectory}/settings.html`, "utf8");
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /style-src 'self'/);
  assert.match(html, /form-action 'none'/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/i);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
});

test("the settings preload exposes only four fielded invoke methods and no generic IPC primitive", async () => {
  const preload = await readFile(
    `${sourceDirectory}/settings-preload.cjs`,
    "utf8",
  );
  assert.equal((preload.match(/ipcRenderer\.invoke\(/g) || []).length, 4);
  assert.doesNotMatch(
    preload,
    /ipcRenderer\.(?:send|sendSync|on|once|postMessage)\s*\(/,
  );
  assert.doesNotMatch(preload, /require\((?!["']electron["'])/);
});

test("settings renderer inserts status as text rather than HTML", async () => {
  const renderer = await readFile(`${rendererDirectory}/settings.js`, "utf8");
  assert.match(renderer, /statusTitle\.textContent/);
  assert.match(renderer, /statusDetail\.textContent/);
  assert.doesNotMatch(
    renderer,
    /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
  );
});
