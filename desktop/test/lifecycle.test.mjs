import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  focusOrReconnectMainWindow,
  visibleWindowOrUndefined,
} = require("../src/window-lifecycle.cjs");

function fakeWindow({ visible = true, minimized = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => minimized,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };
}

test("a second launch recreates and reconnects a closed macOS main window instead of showing an empty shell", () => {
  const created = fakeWindow({ visible: false });
  let current = null;
  let reconnects = 0;
  const action = focusOrReconnectMainWindow({
    getWindow: () => current,
    setWindow: (value) => (current = value),
    createWindow: () => created,
    reconnect: () => (reconnects += 1),
  });

  assert.equal(action, "reconnect");
  assert.equal(current, created);
  assert.equal(reconnects, 1);
  assert.deepEqual(created.calls, []);
});

test("a hidden failed window retries connection while a loaded visible window is restored and focused", () => {
  const hidden = fakeWindow({ visible: false });
  let reconnects = 0;
  assert.equal(
    focusOrReconnectMainWindow({
      getWindow: () => hidden,
      setWindow: () => {},
      createWindow: () => assert.fail("must not recreate a usable window"),
      reconnect: () => (reconnects += 1),
    }),
    "reconnect",
  );
  assert.equal(reconnects, 1);
  assert.deepEqual(hidden.calls, []);

  const visible = fakeWindow({ visible: true, minimized: true });
  assert.equal(
    focusOrReconnectMainWindow({
      getWindow: () => visible,
      setWindow: () => {},
      createWindow: () => assert.fail("must not recreate a usable window"),
      reconnect: () =>
        assert.fail("must not reconnect a loaded visible window"),
    }),
    "focus",
  );
  assert.deepEqual(visible.calls, ["restore", "show", "focus"]);
});

test("a connection failure dialog is app-modal until its parent window is visible", () => {
  assert.equal(visibleWindowOrUndefined(null), undefined);
  assert.equal(
    visibleWindowOrUndefined({
      isDestroyed: () => true,
      isVisible: () => true,
    }),
    undefined,
  );
  assert.equal(
    visibleWindowOrUndefined(fakeWindow({ visible: false })),
    undefined,
  );

  const visible = fakeWindow({ visible: true });
  assert.equal(visibleWindowOrUndefined(visible), visible);
});

test("macOS activation is registered after startup and reuses reconnect semantics", async () => {
  const source = await readFile(
    new URL("../src/main.cjs", import.meta.url),
    "utf8",
  );
  const startupIndex = source.indexOf("await startApplication();");
  const activationIndex = source.indexOf(
    'app.on("activate", focusOrReconnectApplicationWindow)',
  );

  assert.ok(startupIndex >= 0);
  assert.ok(activationIndex > startupIndex);
  assert.equal(source.includes('app.on("activate", () =>'), false);
});

test("update dialogs never attach to a hidden application window", async () => {
  const source = await readFile(
    new URL("../src/main.cjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /getParentWindow:\s*\(\)\s*=>\s*visibleWindowOrUndefined\(mainWindow\)/,
  );
});
