import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
const requireWeb = createRequire(
  new URL("../../web/package.json", import.meta.url),
);
const ts = requireWeb("typescript");
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const read = (file) =>
  fs.readFileSync(new URL(`../../web/src/${file}`, import.meta.url), "utf8");
const jsx = (type, props) => ({ type, props });
const mock = (name) => Object.assign(() => {}, { displayName: name });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function nodes(tree, predicate, result = []) {
  if (Array.isArray(tree))
    tree.forEach((child) => nodes(child, predicate, result));
  else if (tree && typeof tree === "object") {
    if (predicate(tree)) result.push(tree);
    nodes(tree.props?.children, predicate, result);
  }
  return result;
}
const button = (tree, label) =>
  nodes(
    tree,
    (node) =>
      node.type?.displayName === "Button" && node.props.children === label,
  )[0];
function mountComponent(file, initialProps, responses = {}) {
  let cursor = 0,
    props = initialProps;
  const state = [],
    effects = [],
    calls = [],
    updates = [],
    notices = [],
    navigation = [];
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in state))
        state[i] = typeof initial === "function" ? initial() : initial;
      return [
        state[i],
        (value) => {
          state[i] = typeof value === "function" ? value(state[i]) : value;
        },
      ];
    },
    useRef(initial) {
      const i = cursor++;
      return (state[i] ||= { current: initial });
    },
    useCallback(fn) {
      return fn;
    },
    useEffect(fn) {
      effects.push(fn);
    },
    lazy() {
      return mock("LazyAuxiliary");
    },
    Suspense: mock("Suspense"),
  };
  const ant = new Proxy(
    {
      Input: Object.assign(mock("Input"), { TextArea: mock("TextArea") }),
      message: new Proxy(
        {},
        { get: (_, key) => (value) => notices.push({ key, value }) },
      ),
    },
    { get: (object, key) => (object[key] ||= mock(String(key))) },
  );
  const api = {
    async get(url) {
      calls.push({ method: "GET", url });
      return responses.get?.(url) || { employees: [] };
    },
    async post(url, body) {
      calls.push({ method: "POST", url, body });
      return responses.post?.(url, body);
    },
  };
  const module = { exports: {} };
  const compiled = ts.transpileModule(
    read(file).replace(/^import ['"].*\.css['"];?$/gm, ""),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  new Function("require", "module", "exports", compiled)(
    (name) => {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime")
        return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "antd") return ant;
      if (name === "@ant-design/icons")
        return new Proxy({}, { get: (_, key) => mock(String(key)) });
      if (name === "react-router-dom")
        return {
          useNavigate: () => (value) => navigation.push(value),
          useSearchParams: () => [new URLSearchParams(responses.query || "")],
        };
      if (name === "../api/client")
        return { api, getUser: () => ({ role: "boss" }) };
      if (name.endsWith("contentCrewConfig"))
        return {
          CONTENT_CREW_STATIONS: [
            {
              key: "commerce_video",
              order: 10,
              employeeIdx: 10,
              name: "AI带货员",
              taskTypes: ["视频"],
            },
            {
              key: "xhs_note",
              order: 11,
              employeeIdx: 11,
              name: "AI小红书种草员",
              taskTypes: ["图文"],
            },
          ],
        };
      return { default: mock(name), sampleBriefFromSample: () => "" };
    },
    module,
    module.exports,
  );
  return {
    calls,
    notices,
    navigation,
    updates,
    effects,
    render(next) {
      if (next) props = next;
      cursor = 0;
      return module.exports.default(props);
    },
    async mount() {
      this.render();
      const cleanups = effects.splice(0).map((fn) => fn());
      await tick();
      return {
        tree: this.render(),
        cleanup: () => cleanups.forEach((fn) => fn?.()),
      };
    },
  };
}

test("生产仓实际组件只加载员工，主按钮到统一历史，辅助工具默认关闭", async () => {
  const ui = mountComponent("pages/ContentFactory.tsx", {});
  const { tree } = await ui.mount();
  assert.deepEqual(
    ui.calls.map((call) => call.url),
    ["/content/crew"],
  );
  button(tree, "全部历史 · 任务中心").props.onClick();
  assert.deepEqual(ui.navigation, ["/tasks"]);
  assert.equal(
    nodes(tree, (node) => node.type?.displayName === "LazyAuxiliary").length,
    0,
  );
  assert(
    nodes(tree, (node) => node.type === "details").every(
      (node) => node.props.open !== true,
    ),
  );
  const source = read("pages/ContentFactory.tsx");
  assert.doesNotMatch(
    source,
    /ContentEmployeeTaskCenter|WechatDraftStudio|手动创作工作台|\/content\/generate|\/content\/list\?/,
  );
  assert.match(source, /ContentPipelineWorkbench/);
  assert.match(
    source,
    /resourceTab && <ContentResourceLibrary|resourceTab && \(/,
  );
});

test("采纳提交真实统一字段，双击只发一次；失败执行状态和费用由原回执保留", async () => {
  let resolve;
  const task = {
    kind: "generated_content",
    id: 41,
    state: "failed",
    output: "完整草稿",
    billing: { state: "pending_reconciliation" },
    resultVersion: { inputHash: "input-41", outputHash: "output-41" },
    feedbackAvailability: { available: true },
  };
  const updated = [];
  const ui = mountComponent(
    "components/TaskFeedback.tsx",
    { task, onUpdated: (value) => updated.push(value) },
    {
      post: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
  );
  let { tree } = await ui.mount();
  const input = nodes(tree, (node) => node.type?.displayName === "TextArea")[0];
  assert.equal(input.props.maxLength, 2000);
  input.props.onChange({ target: { value: "  保留短段，少用套话  " } });
  tree = ui.render();
  button(tree, "采纳这份结果").props.onClick();
  button(tree, "采纳这份结果").props.onClick();
  await tick();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].url, "/task-center/generated_content/41/feedback");
  assert.equal(ui.calls[0].body.decision, "adopt");
  assert.equal(ui.calls[0].body.note, "保留短段，少用套话");
  assert.ok(ui.calls[0].body.requestKey);
  assert.deepEqual(ui.calls[0].body.resultVersion, task.resultVersion);
  const returned = {
    ...task,
    feedback: { decision: "adopt", learned: true },
    feedbackAvailability: { available: false },
  };
  resolve({ ok: true, task: returned });
  await tick();
  assert.equal(updated[0].state, "failed");
  assert.equal(updated[0].billing.state, "pending_reconciliation");
  tree = ui.render({
    task: returned,
    onUpdated: (value) => updated.push(value),
  });
  assert.equal(button(tree, "采纳这份结果"), undefined);
  assert.match(JSON.stringify(tree), /已记录采纳/);
});

test("无权限或无产物不能反馈；请求失败不假成功；关闭后的旧响应不影响新任务", async () => {
  const base = {
    kind: "media",
    id: 9,
    feedbackAvailability: { available: false, reason: "尚无最终结果" },
  };
  const forbidden = mountComponent("components/TaskFeedback.tsx", {
    task: base,
    onUpdated() {
      assert.fail("must not update");
    },
  });
  const denied = await forbidden.mount();
  assert.equal(button(denied.tree, "采纳这份结果"), undefined);
  assert.deepEqual(forbidden.calls, []);
  let resolve;
  const updated = [];
  const ui = mountComponent(
    "components/TaskFeedback.tsx",
    {
      task: { ...base, feedbackAvailability: { available: true } },
      onUpdated: (value) => updated.push(value),
    },
    {
      post: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
  );
  const { tree, cleanup } = await ui.mount();
  button(tree, "不采纳，保留原稿").props.onClick();
  await tick();
  cleanup();
  resolve({ ok: true, task: { ...base, feedback: { decision: "reject" } } });
  await tick();
  assert.deepEqual(updated, []);
  assert.deepEqual(ui.notices, []);
  const failed = mountComponent(
    "components/TaskFeedback.tsx",
    {
      task: { ...base, feedbackAvailability: { available: true } },
      onUpdated() {
        assert.fail("must not update");
      },
    },
    { post: () => Promise.reject(new Error("暂时无法保存")) },
  );
  const mounted = await failed.mount();
  button(mounted.tree, "采纳这份结果").props.onClick();
  await tick();
  assert.equal(
    failed.notices.some((notice) => notice.key === "success"),
    false,
  );
  assert.match(failed.notices[0].value, /暂时无法保存/);
});

test("任务详情快速切换或关闭，较早请求晚返回不会覆盖当前任务或重新打开抽屉", async () => {
  const source = ts.createSourceFile(
    "TaskCenter.tsx",
    read("pages/TaskCenter.tsx"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let initializer;
  function walk(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText() === "openDetailByRef"
    )
      initializer = node.initializer;
    ts.forEachChild(node, walk);
  }
  walk(source);
  const pending = [],
    shown = [],
    activeDetailKey = { current: "" },
    detailRequestSerial = { current: 0 };
  const bindings = {
    useCallback: (fn) => fn,
    activeDetailKey,
    detailRequestSerial,
    setDetailKey() {},
    setDetail: (value) => shown.push(value),
    setDetailError() {},
    setDetailLoading() {},
    setDetailRefreshing() {},
    api: { get: () => new Promise((resolve) => pending.push(resolve)) },
  };
  const compiled = ts.transpileModule(
    `module.exports = ${initializer.getText()}`,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const module = { exports: {} };
  new Function(...Object.keys(bindings), "module", compiled)(
    ...Object.values(bindings),
    module,
  );
  const first = module.exports("generated_content", 1),
    second = module.exports("generated_content", 2);
  pending[1]({ id: 2 });
  await second;
  pending[0]({ id: 1 });
  await first;
  assert.deepEqual(shown.filter(Boolean), [{ id: 2 }]);
  const last = module.exports("media", 3);
  activeDetailKey.current = "";
  detailRequestSerial.current += 1;
  pending[2]({ id: 3 });
  await last;
  assert.deepEqual(shown.filter(Boolean), [{ id: 2 }]);
  await module.exports("media", 3, "media:3", true);
  assert.equal(pending.length, 3);
});

test("输入照片、完整正文、部分图片与费用保留，未完成图片在文案成功后继续刷新", () => {
  const task = read("pages/TaskCenter.tsx");
  assert.match(task, /generated_content/);
  assert.match(task, /detail\.inputFiles\.map/);
  assert.match(task, /detail\.media\.map/);
  assert.match(task, /media\.billing\?\.label/);
  assert.match(task, /media\.warning/);
  assert.match(task, /detail\.imageGeneration\?\.status/);
  assert.match(task, /<TaskFeedback/);
  assert.match(task, /<summary>任务输入<\/summary>/);
  assert.match(task, /<Markdown content=\{cleanReportBody\(detail\.report\.markdown\)\}/);
  const xhsPanel = read("components/AiXhsNotePanel.tsx");
  assert.match(xhsPanel, /<SpecialistTaskHistory/);
  assert.match(
    xhsPanel,
    /\/content\/ai-xhs-note\/jobs\/\$\{row\.id\}\/decision/,
  );
  assert.match(read("components/EmployeeWorkbench.tsx"), /runs\?limit=8/);
  assert.match(
    read("components/EmployeeWorkbench.tsx"),
    /employee-workbench\/content\/.*\/review/,
  );
});

test("结果变化后保留旧版本说明；当前版本尚不可反馈时不会开放按钮", async () => {
  for (const decision of ["adopt", "reject"]) {
    const task = {
      kind: "generated_content",
      id: 11,
      output: "当前新结果",
      feedback: {
        decision,
        currentVersion: false,
        versionLabel: "图片后来补齐，原选择属于旧版本",
      },
      feedbackAvailability: { available: false },
    };
    const ui = mountComponent("components/TaskFeedback.tsx", {
      task,
      onUpdated() {
        assert.fail("must not update");
      },
    });
    const { tree } = await ui.mount();
    assert.match(
      JSON.stringify(tree),
      decision === "adopt" ? /旧版本采纳/ : /旧版本不采纳/,
    );
    assert.match(JSON.stringify(tree), /图片后来补齐，原选择属于旧版本/);
    assert.equal(button(tree, "采纳这份结果"), undefined);
    assert.equal(button(tree, "不采纳，保留原稿"), undefined);
    assert.deepEqual(ui.calls, []);
  }
});

test("新结果版本可独立选择，提交当前输入输出版本；同版本保存后不可重复", async () => {
  const firstKeys = [];
  for (const outputHash of ["text-only", "images-ready"]) {
    const task = {
      kind: "generated_content",
      id: 11,
      output: "完整结果",
      resultVersion: { inputHash: "same-input", outputHash },
      feedback: {
        decision: "reject",
        currentVersion: false,
        versionLabel: "之前的选择仅适用于旧版本，可对当前结果重新选择。",
      },
      feedbackAvailability: { available: true },
    };
    const updated = [];
    const saved = {
      ...task,
      feedback: { decision: "adopt", currentVersion: true },
      feedbackAvailability: { available: false },
    };
    const ui = mountComponent(
      "components/TaskFeedback.tsx",
      { task, onUpdated: (value) => updated.push(value) },
      { post: () => ({ ok: true, task: saved }) },
    );
    const { tree } = await ui.mount();
    assert.match(JSON.stringify(tree), /旧版本不采纳/);
    assert.ok(button(tree, "不采纳，保留原稿"));
    button(tree, "采纳这份结果").props.onClick();
    await tick();
    assert.equal(ui.calls.length, 1);
    assert.deepEqual(ui.calls[0].body.resultVersion, task.resultVersion);
    firstKeys.push(ui.calls[0].body.requestKey);
    assert.deepEqual(updated, [saved]);
    const locked = ui.render({ task: saved, onUpdated() {} });
    assert.equal(button(locked, "采纳这份结果"), undefined);
    assert.equal(button(locked, "不采纳，保留原稿"), undefined);
  }
  assert.notEqual(firstKeys[0], firstKeys[1]);
  const source = read("pages/TaskCenter.tsx");
  assert.match(
    source,
    /key=\{`[^\n]*detail\.resultVersion\?\.inputHash[^\n]*detail\.resultVersion\?\.outputHash/,
  );
});

test("任务输入真实渲染中文 Markdown；技术字段只留完整原记录，原图及下载不丢失", () => {
  function compile(source, dependencies = {}) {
    const module = { exports: {} };
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }).outputText;
    new Function("require", "module", "exports", compiled)(
      (name) => {
        if (name.endsWith(".css")) return {};
        return dependencies[name] ?? requireWeb(name);
      },
      module,
      module.exports,
    );
    return module.exports;
  }
  const client = compile(read("api/client.ts"), {
    antd: { message: {} },
    "./store-context": {},
  });
  const { Markdown } = compile(read("components/Markdown.tsx"), {
    "../api/client": client,
  });
  const source = ts.createSourceFile(
    "TaskCenter.tsx",
    read("pages/TaskCenter.tsx"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let input, raw, preview;
  function walk(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "TaskMediaPreview"
    )
      preview = node;
    if (ts.isJsxElement(node)) {
      const className = node.openingElement.attributes.properties.find(
        (attr) =>
          ts.isJsxAttribute(attr) && attr.name.getText() === "className",
      )?.initializer?.text;
      if (className === "task-center-disclosure task-center-input")
        input = node;
      if (className === "task-center-input-raw") raw = node;
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
  const renderSection = (node) => {
    const Component = compile(
      `const { Markdown } = require('markdown-under-test');
       const { Button } = require('antd');
       ${preview.getText()}
       module.exports = ({ detail }) => (${node.getText()});`,
      { "markdown-under-test": { Markdown } },
    );
    return (detail) =>
      renderToStaticMarkup(React.createElement(Component, { detail }));
  };
  const renderInput = renderSection(input),
    renderRaw = renderSection(raw);
  const requirement =
    "第一段：只使用门头和菜品中可见的事实。\n\n" +
    "保留老板输入的每个要求。".repeat(900) +
    "\n\n最后一句要求仍然在。";
  const original = `**BrandName：** 罗二火锅\n\n**Brief：** ${requirement}\n\n**RequestKey：** request-private\n\n**FileIds：** 31, 32`;
  const detail = {
    input: original,
    inputDisplay: `**品牌名称：** 罗二火锅\n\n**需求：** ${requirement}`,
    inputFiles: [
      { id: 31, name: "门头照片.png", url: "/uploads/shop-front.png" },
    ],
  };
  const html = renderInput(detail);
  assert.match(html, /<strong>品牌名称：<\/strong> 罗二火锅/u);
  assert.match(html, /<strong>需求：<\/strong>/u);
  assert.match(html, /<p>最后一句要求仍然在。<\/p>/u);
  assert.equal((html.match(/保留老板输入的每个要求。/gu) || []).length, 900);
  assert.doesNotMatch(
    html,
    /BrandName|RequestKey|FileIds|request-private|<pre>/u,
  );
  assert.match(
    html,
    /<img[^>]*src="\/uploads\/shop-front.png"[^>]*alt="门头照片.png"/u,
  );
  assert.match(html, /href="\/uploads\/shop-front.png"[^>]*download/u);
  assert.ok(renderRaw(detail).includes(`<pre>${original}</pre>`));
  let parent = raw.parent;
  while (
    parent &&
    !(
      ts.isJsxElement(parent) &&
      parent.openingElement.tagName.getText() === "details"
    )
  )
    parent = parent.parent;
  assert.ok(parent, "original input remains in a disclosure");
  assert.equal(
    parent.openingElement.attributes.properties.some(
      (attr) => ts.isJsxAttribute(attr) && attr.name.getText() === "open",
    ),
    false,
  );
  const legacy = renderInput({
    input: "## 老任务的完整要求\n\n1. 保留第一项\n2. 保留第二项",
  });
  assert.match(legacy, /<h2>老任务的完整要求<\/h2>/u);
  assert.match(legacy, /<li>保留第一项<\/li>[\s\S]*<li>保留第二项<\/li>/u);
});

test("历史行显示当前或旧版采纳选择，并与真实执行状态分别呈现", () => {
  const source = ts.createSourceFile(
    "TaskCenter.tsx",
    read("pages/TaskCenter.tsx"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const helpers = [];
  let progress;
  function walk(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      ["taskStatusLabel", "policyColor"].includes(node.name?.text)
    )
      helpers.push(node.getText());
    if (ts.isVariableDeclaration(node) && node.name.getText() === "statusColor")
      helpers.push(`const statusColor = ${node.initializer.getText()};`);
    if (
      ts.isJsxElement(node) &&
      node.openingElement.attributes.properties.some(
        (attr) =>
          ts.isJsxAttribute(attr) &&
          attr.name.getText() === "className" &&
          attr.initializer?.text === "task-center-progress",
      )
    )
      progress = node;
    ts.forEachChild(node, walk);
  }
  walk(source);
  const module = { exports: {} };
  const compiled = ts.transpileModule(
    `const { Tag } = require('antd'); ${helpers.join("\n")} module.exports = ({ row }) => (${progress.getText()});`,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  new Function("require", "module", "exports", compiled)(
    requireWeb,
    module,
    module.exports,
  );
  for (const [decision, currentVersion, label, state, displayStatus] of [
    ["adopt", true, "已采纳", "failed", "执行失败，草稿保留"],
    ["reject", true, "不采纳", "done", "生成完成"],
    ["adopt", false, "旧版本采纳", "done", "生成完成"],
    ["reject", false, "旧版本不采纳", "running", "配图生成中"],
  ]) {
    const row = {
      state,
      displayStatus,
      feedback: { decision, currentVersion },
    };
    const before = structuredClone(row);
    const html = renderToStaticMarkup(
      React.createElement(module.exports, { row }),
    );
    assert.match(html, new RegExp(`>${label}<`));
    assert.ok(html.includes(displayStatus));
    assert.deepEqual(row, before);
  }
  const untouched = renderToStaticMarkup(
    React.createElement(module.exports, {
      row: { state: "done", displayStatus: "已完成" },
    }),
  );
  assert.doesNotMatch(untouched, /采纳/u);
  assert.match(untouched, /已完成/u);
});
