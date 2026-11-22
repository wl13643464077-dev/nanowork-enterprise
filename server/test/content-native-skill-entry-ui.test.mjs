import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
const requireWeb = createRequire(
  new URL("../../web/package.json", import.meta.url),
);
const ts = requireWeb("typescript");
const source = (name) =>
  ts.createSourceFile(
    name,
    fs.readFileSync(new URL(`../../web/src/${name}`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
const factory = source("pages/ContentFactory.tsx");
const workbench = source("components/EmployeeWorkbench.tsx");
function find(root, predicate) {
  if (predicate(root)) return root;
  let found;
  ts.forEachChild(root, (node) => {
    if (!found) found = find(node, predicate);
  });
  return found;
}
const attr = (opening, name) =>
  opening.attributes.properties.find(
    (item) => ts.isJsxAttribute(item) && item.name.text === name,
  )?.initializer;
function evaluate(node, bindings) {
  const code = ts.transpileModule(`module.exports = (${node.getText()});`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const module = { exports: {} };
  new Function(...Object.keys(bindings), "module", code)(
    ...Object.values(bindings),
    module,
  );
  return module.exports;
}
const variable = (file, name, includes = "") =>
  find(
    file,
    (node) =>
      ts.isVariableDeclaration(node) &&
      node.name.getText() === name &&
      node.initializer?.getText().includes(includes),
  ).initializer;

test("实际技能摘要点击直接定位技能库，派活点击恢复派活，普通成员不越过档案权限", () => {
  const powers = find(
    factory,
    (node) =>
      ts.isJsxOpeningElement(node) &&
      attr(node, "className")?.text === "content-crew-card-powers",
  );
  const primary = find(
    factory,
    (node) =>
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText() === "Button" &&
      node.children.some(
        (child) =>
          ts.isJsxText(child) && child.text.trim() === "打开工作台 · 派活",
      ),
  );
  const selected = {};
  const bindings = {
    station: { employeeIdx: 11 },
    canViewCrewInternals: true,
    setCrewWorkbenchRunId(value) {
      selected.run = value;
    },
    setCrewWorkbenchIdx(value) {
      selected.idx = value;
    },
    setCrewProfileTab(value) {
      selected.tab = value;
    },
  };
  evaluate(attr(powers, "onClick").expression, bindings)();
  assert.deepEqual(selected, { run: null, idx: 11, tab: "skills" });
  evaluate(attr(primary.openingElement, "onClick").expression, bindings)();
  assert.equal(selected.tab, undefined);
  assert.equal(selected.idx, 11);
  evaluate(attr(powers, "onClick").expression, {
    ...bindings,
    canViewCrewInternals: false,
  })();
  assert.equal(selected.tab, undefined);
  const activeState = find(
    workbench,
    (node) =>
      ts.isVariableDeclaration(node) &&
      node.name.getText().startsWith("[activeTab,"),
  );
  const backendState = find(
    workbench,
    (node) =>
      ts.isVariableDeclaration(node) &&
      node.name.getText().startsWith("[backendProfileOpen,"),
  );
  assert.equal(
    evaluate(activeState.initializer, {
      useState: (value) => value,
      initialProfileTab: "skills",
    }),
    "skills",
  );
  assert.equal(
    evaluate(backendState.initializer, {
      useState: (value) => value,
      initialProfileTab: "skills",
    }),
    true,
  );
  const drawer = find(
    workbench,
    (node) =>
      ts.isJsxOpeningElement(node) &&
      attr(node, "className")?.text === "employee-workbench-backend-drawer",
  );
  assert.equal(
    evaluate(attr(drawer, "open").expression, {
      open: true,
      backendProfileOpen: true,
      canViewInternalProfile: false,
    }),
    false,
  );
});

test("实际crew刷新读取最新技能数量，较早请求晚返回不会盖回旧数", async () => {
  const pending = [],
    counts = [];
  const load = evaluate(variable(factory, "loadCrew"), {
    useCallback: (fn) => fn,
    crewRequestSerial: { current: 0 },
    api: {
      get(url) {
        assert.equal(url, "/content/crew");
        return new Promise((resolve) => pending.push(resolve));
      },
    },
    CONTENT_CREW_STATIONS: [
      { order: 10, key: "commerce_video", employeeIdx: 10 },
    ],
    setContentCrew(rows) {
      counts.push(rows[0].skillCount);
    },
    setCrewConnected() {},
    setCrewLoading() {},
  });
  const old = load(),
    fresh = load();
  pending[1]({
    employees: [
      { idx: 10, key: "commerce_video", skillCount: 3, capabilityCount: 1 },
    ],
  });
  await fresh;
  pending[0]({
    employees: [
      { idx: 10, key: "commerce_video", skillCount: 1, capabilityCount: 1 },
    ],
  });
  await old;
  assert.deepEqual(counts, [3]);
});

test("技能变更成功和进修完成通知卡片刷新，失败与无关配置不刷新", async () => {
  let updates = 0;
  const common = {
    idx: 10,
    domain: "content",
    setSaving() {},
    applyProfile() {},
    normalizeProfile: (value) => value,
    loadProfile: async () => {},
    message: { success() {} },
    onSkillsChanged() {
      updates++;
    },
  };
  const mutate = evaluate(variable(workbench, "mutate"), {
    ...common,
    api: { put: async () => ({ profile: {} }) },
  });
  assert.equal(
    await mutate(
      "skills",
      { skills: [{ id: "learned-1", enabled: false }] },
      "已停用",
    ),
    true,
  );
  assert.equal(updates, 1);
  await mutate("config", {}, "已保存");
  assert.equal(updates, 1);
  const failed = evaluate(variable(workbench, "mutate"), {
    ...common,
    api: {
      put: async () => {
        throw new Error("保存失败");
      },
    },
  });
  assert.equal(await failed("skills", {}, "不应成功"), false);
  assert.equal(updates, 1);
  const poll = evaluate(variable(workbench, "poll", "/learning-runs/"), {
    open: true,
    domain: "content",
    idx: 10,
    skillLearningRunId: 5,
    cancelled: false,
    api: {
      get: async () => ({
        run: { id: 5, status: "completed", skillsAdded: 2 },
      }),
    },
    setSkillLearningRun() {},
    refreshProfileQuietly: async () => {},
    onSkillsChanged() {
      updates++;
    },
    message: { success() {}, error() {} },
    window: { setTimeout() {} },
  });
  await poll();
  assert.equal(updates, 2);
});

test("关闭工作台返回卡片会刷新crew，避免展示打开前的旧技能数量", () => {
  const opening = find(
    factory,
    (node) =>
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText() === "EmployeeWorkbench",
  );
  let refreshed = 0;
  const noop = () => {};
  const close = evaluate(attr(opening, "onClose").expression, {
    setCrewWorkbenchIdx: noop,
    setCrewProfileTab: noop,
    setCrewWorkbenchRunId: noop,
    setCrewMediaJobId: noop,
    setSalesVideoPreset: noop,
    setXhsNotePreset: noop,
    setRetroContentId: noop,
    setEmployeeTaskRefreshToken: noop,
    loadMaterials: noop,
    loadSummary: noop,
    loadPending: noop,
    loadPipelinePendingReviews: noop,
    loadEffectTop: noop,
    loadList: noop,
    loadCrew() {
      refreshed++;
    },
  });
  close();
  assert.equal(refreshed, 1);
  assert.equal(
    attr(opening, "onSkillsChanged").expression.getText(),
    "loadCrew",
  );
  assert.equal(
    attr(opening, "initialProfileTab").expression.getText(),
    "crewProfileTab",
  );
});

test("员工切换和关闭重建完整工作台实例，档案关闭仅影响所属实例", () => {
  const keyFor = (props) =>
    evaluate(variable(workbench, "instanceKey"), { props });
  const video = { open: true, domain: "content", idx: 10 };
  const videoKey = keyFor(video);
  assert.equal(keyFor({ ...video }), videoKey);
  assert.notEqual(keyFor({ ...video, idx: 11 }), videoKey);
  assert.notEqual(keyFor({ ...video, open: false }), videoKey);
  assert.notEqual(keyFor({ ...video, domain: "restaurant" }), videoKey);
  assert.notEqual(keyFor({ ...video, initialProfileTab: "skills" }), videoKey);
  const instance = find(
    workbench,
    (node) =>
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText() === "EmployeeWorkbenchInstance",
  );
  assert.equal(attr(instance, "key").expression.getText(), "instanceKey");
  const drawer = find(
    workbench,
    (node) =>
      ts.isJsxOpeningElement(node) &&
      attr(node, "className")?.text === "employee-workbench-backend-drawer",
  );
  const state = { video: true, xhs: true };
  const closeOld = evaluate(attr(drawer, "onClose").expression, {
    setBackendProfileOpen: (value) => {
      state.video = value;
    },
  });
  closeOld();
  assert.deepEqual(state, { video: false, xhs: true });
  assert.equal(attr(drawer, "afterOpenChange"), undefined);
  assert.equal(attr(drawer, "afterClose"), undefined);
});

test("切岗清理后旧档案请求晚返回不能覆盖新员工档案", async () => {
  const effect = find(
    workbench,
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText() === "useEffect" &&
      node.arguments[0]?.getText().includes("requestSerial.current += 1"),
  ).arguments[0];
  const createLoader = (idx) => {
    let resolve;
    const applied = [];
    const requestSerial = { current: 0 };
    const loadProfile = evaluate(variable(workbench, "loadProfile"), {
      useCallback: (fn) => fn,
      open: true,
      idx,
      domain: "content",
      requestSerial,
      api: {
        get(url) {
          assert.equal(url, `/employee-workbench/content/${idx}`);
          return new Promise((done) => {
            resolve = done;
          });
        },
      },
      normalizeProfile: (value) => value,
      applyProfile: (value) => applied.push(value),
      setLoading() {},
      setLoadError() {},
      setProfile() {},
    });
    const pending = loadProfile();
    const cleanup = evaluate(effect, {
      queueMicrotask() {},
      requestSerial,
      runRequestSerial: { current: 0 },
    })();
    return { applied, cleanup, pending, resolve: (value) => resolve(value) };
  };
  const old = createLoader(10);
  old.cleanup();
  const current = createLoader(11);
  current.resolve({ identity: { idx: 11 } });
  await current.pending;
  old.resolve({ identity: { idx: 10 } });
  await old.pending;
  assert.deepEqual(old.applied, []);
  assert.deepEqual(current.applied, [{ identity: { idx: 11 } }]);
  current.cleanup();
});

test("切岗清理后旧进修轮询晚返回不更新技能、发完成提示或继续轮询", async () => {
  const effect = find(
    workbench,
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText() === "useEffect" &&
      node.arguments[0]
        ?.getText()
        .includes("/learning-runs/${skillLearningRunId}"),
  ).arguments[0];
  let resolve;
  const timers = [],
    updates = [],
    notices = [];
  const cleanup = evaluate(effect, {
    open: true,
    idx: 10,
    domain: "content",
    skillLearningRunId: 1,
    skillLearningRunStatus: "running",
    api: {
      get(url) {
        assert.equal(url, "/employee-workbench/content/10/learning-runs/1");
        return new Promise((done) => {
          resolve = done;
        });
      },
    },
    setSkillLearningRun: (value) => updates.push(value),
    refreshProfileQuietly: async () => updates.push("profile"),
    onSkillsChanged: () => updates.push("crew"),
    message: {
      success: (value) => notices.push(value),
      error: (value) => notices.push(value),
    },
    window: {
      setTimeout(fn) {
        timers.push(fn);
        return timers.length;
      },
      clearTimeout() {},
    },
  })();
  const pending = timers[0]();
  cleanup();
  resolve({ run: { id: 1, status: "completed", skillsAdded: 2 } });
  await pending;
  assert.deepEqual(updates, []);
  assert.deepEqual(notices, []);
  assert.equal(timers.length, 1);
});
