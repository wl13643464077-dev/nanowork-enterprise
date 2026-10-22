import * as personalBillingCopy from "../../web/src/components/personalApiBilling.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
const req = createRequire(new URL("../../web/package.json", import.meta.url));
const ts = req("typescript");
const read = (file) =>
  fs.readFileSync(new URL(`../../web/src/${file}`, import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const jsx = (type, props) => ({ type, props });
const component = (name) => Object.assign(() => {}, { displayName: name });
function nodes(tree, predicate, result = []) {
  if (Array.isArray(tree))
    tree.forEach((item) => nodes(item, predicate, result));
  else if (tree && typeof tree === "object") {
    if (predicate(tree)) result.push(tree);
    nodes(tree.props?.children, predicate, result);
  }
  return result;
}
const named = (tree, name) =>
  nodes(tree, (node) => node.type?.displayName === name);
const button = (tree, text) =>
  named(tree, "Button").find((node) => node.props.children === text);
const field = (tree, label) =>
  nodes(tree, (node) => node.props?.["aria-label"] === label)[0];

function mount(file, initialProps, handlers = {}) {
  let cursor = 0,
    props = initialProps,
    tree,
    user = { id: 8, tenant: { id: 3 }, role: "boss" };
  const state = [],
    effects = [],
    timers = [],
    calls = [],
    creditUpdates = [],
    notices = [];
  const same = (a, b) =>
    a &&
    b &&
    a.length === b.length &&
    a.every((value, i) => Object.is(value, b[i]));
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
    useCallback(fn, deps) {
      const i = cursor++;
      if (!state[i] || !same(state[i].deps, deps)) state[i] = { fn, deps };
      return state[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const old = state[i];
      if (!old || !same(old.deps, deps)) {
        state[i] = { deps, cleanup: old?.cleanup };
        effects.push(() => {
          old?.cleanup?.();
          state[i].cleanup = fn();
        });
      }
    },
  };
  const Input = Object.assign(component("Input"), {
    TextArea: component("TextArea"),
  });
  const ant = new Proxy(
    {
      Input,
      message: new Proxy(
        {},
        { get: (_, key) => (value) => notices.push({ key, value }) },
      ),
    },
    { get: (object, key) => (object[key] ||= component(String(key))) },
  );
  const api = {
    async get(url) {
      calls.push({ method: "GET", url });
      return handlers.get?.(url) ?? { sessions: [] };
    },
    async post(url, body) {
      calls.push({ method: "POST", url, body });
      return handlers.post?.(url, body);
    },
  };
  const module = { exports: {} };
  const code = ts.transpileModule(
    read(file).replace(/^import ['"].*\.css['"];?$/gm, ""),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  new Function("require", "module", "exports", code)(
    (name) => {
      if (name === "./personalApiBilling.js") return personalBillingCopy;
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime")
        return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "antd") return ant;
      if (name === "@ant-design/icons")
        return new Proxy({}, { get: (_, key) => component(String(key)) });
      if (name === "../api/client")
        return {
          api,
          getUser: () => user,
          notifyCredits(balance) {
            creditUpdates.push(balance);
          },
        };
      if (name === "../api/store-context")
        return { storeHeaders: () => ({ "X-Store-Id": "2" }) };
      if (name === "./Markdown") return { Markdown: component("Markdown") };
      if (name === "./UnifiedFilePicker")
        return { UnifiedFilePicker: component("UnifiedFilePicker") };
      throw new Error(`unexpected dependency ${name}`);
    },
    module,
    module.exports,
  );
  globalThis.window = {
    setTimeout(fn) {
      timers.push({ fn, active: true, interval: false });
      return timers.length;
    },
    setInterval(fn) {
      timers.push({ fn, active: true, interval: true });
      return timers.length;
    },
    clearTimeout(id) {
      if (timers[id - 1]) timers[id - 1].active = false;
    },
    clearInterval(id) {
      if (timers[id - 1]) timers[id - 1].active = false;
    },
  };
  return {
    calls,
    creditUpdates,
    notices,
    timers,
    get tree() {
      return tree;
    },
    render(nextProps) {
      if (nextProps) props = nextProps;
      cursor = 0;
      tree = (module.exports.default || module.exports.UnifiedFilePicker)(
        props,
      );
      return tree;
    },
    async flush() {
      for (let i = 0; i < 4; i++) {
        this.render();
        effects.splice(0).forEach((fn) => fn());
        await tick();
      }
      return tree;
    },
    async mount() {
      return this.flush();
    },
    setUser(value) {
      user = value;
    },
    cleanup() {
      state.forEach((value) => value?.cleanup?.());
    },
  };
}
const options = {
  available: true,
  creditsPerImage: 18,
  imageCounts: [6, 9, 12],
  styles: ["seed", "review", "guide", "visit", "new_product", "story"].map(
    (id) => ({ id, label: id }),
  ),
  coverLayouts: ["photo", "collage4", "headline"].map((id) => ({
    id,
    label: id,
  })),
};
const baseProps = {
  open: true,
  employeeIdx: 11,
  canDispatch: true,
  imageOptions: options,
  mediaReady: true,
  onGeneration() {},
};
const draftSession = (idx) => ({
  id: 41,
  employeeIdx: idx,
  status: "draft",
  files: [],
  messages: [],
  currentPlan: null,
  generation: null,
});

test("恢复聊天历史不写入旧结算余额，新消息完成只读取当前钱包一次", async () => {
  const user = { id: 8, tenant: { id: 3 }, role: "boss", credits: 175822 };
  let session = {
    ...draftSession(10),
    status: "ready",
    options: { durationSeconds: 15 },
    messages: [
      {
        id: 1,
        role: "assistant",
        content: "历史方案",
        billing: { state: "settled", balance: 176907 },
      },
    ],
    currentPlan: {
      version: 1,
      ready: true,
      options: { durationSeconds: 15 },
      summary: "完整方案",
    },
  };
  const ui = mount(
    "components/NativeEmployeeChat.tsx",
    { ...baseProps, employeeIdx: 10 },
    {
      get: (url) =>
        url === "/auth/me"
          ? user
          : url.includes("?")
            ? { sessions: [session] }
            : { session },
      post(url, body) {
        session = {
          ...session,
          messages: [
            ...session.messages,
            { id: 2, role: "user", content: body.message },
            {
              id: 3,
              role: "assistant",
              content: "已保存的返回结果",
              billing: { state: "settled", balance: 176000 },
            },
          ],
          currentPlan: { ...session.currentPlan, version: 2 },
        };
        return { session };
      },
    },
  );
  ui.setUser(user);
  let tree = await ui.mount();
  assert.deepEqual(ui.creditUpdates, []);
  assert.equal(ui.calls.filter((call) => call.url === "/auth/me").length, 0);
  field(tree, "发给数字员工的消息").props.onChange({
    target: { value: "口播再自然一点。" },
  });
  tree = ui.render();
  button(tree, "发送").props.onClick();
  await ui.flush();
  assert.deepEqual(ui.creditUpdates, [175822]);
  assert.equal(ui.calls.filter((call) => call.url === "/auth/me").length, 1);
  ui.cleanup();
});

test("已有视频结果在长对话之前只显示一次，未启用置顶的图文布局保持原位置", async () => {
  for (const resultFirst of [true, false]) {
    const session = {
      ...draftSession(resultFirst ? 10 : 11),
      status: "ready",
      messages: [{ id: 1, role: "assistant", content: "完整历史对话" }],
      currentPlan: {
        version: 1,
        ready: true,
        summary: "完整原方案",
        options: { durationSeconds: 15 },
      },
    };
    const result = jsx("section", {
      "aria-label": "真实媒体结果",
      children: "既有播放器和下载",
    });
    const ui = mount(
      "components/NativeEmployeeChat.tsx",
      {
        ...baseProps,
        employeeIdx: session.employeeIdx,
        resultFirst,
        children: result,
      },
      {
        get: (url) =>
          url.includes("?") ? { sessions: [session] } : { session },
      },
    );
    const tree = await ui.mount();
    const ordered = nodes(tree, () => true);
    assert.equal(
      nodes(tree, (node) => node.props?.["aria-label"] === "真实媒体结果")
        .length,
      1,
    );
    const resultIndex = ordered.indexOf(result);
    const messagesIndex = ordered.findIndex(
      (node) => node.props?.className === "native-employee-chat__messages",
    );
    assert.equal(resultIndex < messagesIndex, resultFirst);
    assert.ok(
      named(tree, "Markdown").some(
        (node) => node.props.content === "完整历史对话",
      ),
    );
    assert.ok(
      named(tree, "Markdown").some(
        (node) => node.props.content === "完整原方案",
      ),
    );
    assert.equal(
      ui.calls.some((call) => call.method === "POST"),
      false,
    );
    ui.cleanup();
  }
});

test("带货新对话默认15秒，主题加照片即可发消息；示例只填草稿", async () => {
  let session = draftSession(10);
  const selected = [];
  const ui = mount(
    "components/NativeEmployeeChat.tsx",
    {
      ...baseProps,
      employeeIdx: 10,
      onVideoDurationChange: (value) => selected.push(value),
    },
    {
      post(url, body) {
        if (url.endsWith("/sessions")) return { session };
        session = {
          ...session,
          status: "ready",
          options: body.options,
          messages: [
            { id: 1, role: "user", content: body.message },
            { id: 2, role: "assistant", content: "真实服务端方案" },
          ],
          currentPlan: {
            version: 1,
            ready: true,
            options: body.options,
            script: { shots: [{ index: 1, voiceover: "服务端口播" }] },
          },
        };
        return { session };
      },
    },
  );
  let tree = await ui.mount();
  assert.equal(field(tree, "生成30秒（两段）").props.checked, false);
  assert.equal(selected.at(-1), 15);
  const example = named(field(tree, "使用示例"), "Button")[0];
  example.props.onClick();
  tree = ui.render();
  assert.match(
    field(tree, "发给数字员工的消息").props.value,
    /15秒.*脚本你来写/,
  );
  assert.equal(ui.calls.filter((call) => call.method === "POST").length, 0);
  field(tree, "发给数字员工的消息").props.onChange({
    target: { value: "下班聚餐，脚本你来写。" },
  });
  named(tree, "UnifiedFilePicker")[0].props.onChange([
    { id: 3, name: "门头", file_url: "/uploads/shop.jpg" },
  ]);
  tree = ui.render();
  button(tree, "发送").props.onClick();
  tree = await ui.flush();
  const sent = ui.calls.find((call) => call.url.endsWith("/messages"));
  assert.deepEqual(sent.body.options, { durationSeconds: 15 });
  assert.deepEqual(sent.body.fileIds, [3]);
  assert.equal(sent.body.message, "下班聚餐，脚本你来写。");
  assert.equal(button(tree, "确认脚本，生成 15 秒视频").props.disabled, false);
  ui.cleanup();
});

test("勾选30秒不立即收费或确认旧方案，仅发送时长修改后确认新版本", async () => {
  let session = {
    ...draftSession(10),
    status: "ready",
    options: { durationSeconds: 15 },
    messages: [{ id: 1, role: "assistant", content: "15秒已写好" }],
    currentPlan: {
      ready: true,
      version: 1,
      options: { durationSeconds: 15 },
      summary: "15秒脚本",
    },
  };
  const ui = mount(
    "components/NativeEmployeeChat.tsx",
    { ...baseProps, employeeIdx: 10 },
    {
      get: (url) => (url.includes("?") ? { sessions: [session] } : { session }),
      post(url, body) {
        if (url.endsWith("/messages"))
          session = {
            ...session,
            options: body.options,
            messages: [
              ...session.messages,
              { id: 2, role: "user", content: body.message },
              { id: 3, role: "assistant", content: "两段方案已更新" },
            ],
            currentPlan: {
              ready: true,
              version: 2,
              options: body.options,
              summary: "30秒两段脚本",
            },
          };
        return { session };
      },
    },
  );
  let tree = await ui.mount();
  field(tree, "生成30秒（两段）").props.onChange({ target: { checked: true } });
  tree = ui.render();
  assert.equal(button(tree, "确认脚本，生成 15 秒视频").props.disabled, true);
  button(tree, "确认脚本，生成 15 秒视频").props.onClick();
  assert.equal(ui.calls.filter((call) => call.method === "POST").length, 0);
  assert.equal(button(tree, "发送").props.disabled, false);
  button(tree, "发送").props.onClick();
  tree = await ui.flush();
  const sent = ui.calls.find((call) => call.url.endsWith("/messages"));
  assert.deepEqual(sent.body.options, { durationSeconds: 30 });
  assert.equal(sent.body.fileIds, undefined);
  assert.match(sent.body.message, /30 秒（两段）/);
  assert.doesNotMatch(sent.body.message, /张图|用餐场景/);
  const confirm = button(tree, "确认脚本，生成 30 秒视频");
  assert.equal(confirm.props.disabled, false);
  confirm.props.onClick();
  await ui.flush();
  assert.equal(
    ui.calls.find((call) => call.url.endsWith("/confirm")).body.planVersion,
    2,
  );
  ui.cleanup();
});

test("首次发送暂未取得回执时保留30秒选择和输入，不自动重发", async () => {
  const session = { ...draftSession(10), options: { durationSeconds: 15 } };
  const ui = mount(
    "components/NativeEmployeeChat.tsx",
    { ...baseProps, employeeIdx: 10 },
    {
      get: (url) => (url.includes("?") ? { sessions: [] } : { session }),
      post(url) {
        if (url.endsWith("/sessions")) return { session };
        throw new Error("请求暂未确认");
      },
    },
  );
  let tree = await ui.mount();
  field(tree, "生成30秒（两段）").props.onChange({ target: { checked: true } });
  field(tree, "发给数字员工的消息").props.onChange({
    target: { value: "用门头照片介绍这家店。" },
  });
  tree = ui.render();
  button(tree, "发送").props.onClick();
  tree = await ui.flush();
  assert.equal(field(tree, "生成30秒（两段）").props.checked, true);
  assert.equal(
    field(tree, "发给数字员工的消息").props.value,
    "用门头照片介绍这家店。",
  );
  assert.equal(
    ui.calls.filter((call) => call.url.endsWith("/messages")).length,
    1,
  );
  assert.ok(
    ui.calls.some(
      (call) => call.method === "GET" && call.url.endsWith("/sessions/41"),
    ),
  );
  ui.cleanup();
});

test("历史视频缺时长沿用30秒；服务端解析时长覆盖选项；新对话重置15秒", async () => {
  let session = {
    ...draftSession(10),
    status: "ready",
    messages: [{ id: 1, role: "assistant", content: "历史两段稿" }],
    currentPlan: { version: 1, ready: true, summary: "历史方案" },
  };
  const selected = [];
  const ui = mount(
    "components/NativeEmployeeChat.tsx",
    {
      ...baseProps,
      employeeIdx: 10,
      onVideoDurationChange: (value) => selected.push(value),
    },
    {
      get: (url) => (url.includes("?") ? { sessions: [session] } : { session }),
      post(url, body) {
        session = {
          ...session,
          options: { durationSeconds: 15 },
          messages: [
            ...session.messages,
            { id: 2, role: "user", content: body.message },
            { id: 3, role: "assistant", content: "按文字要求改为15秒" },
          ],
          currentPlan: {
            version: 2,
            ready: true,
            summary: "15秒新方案",
            options: { durationSeconds: 15 },
          },
        };
        return { session };
      },
    },
  );
  let tree = await ui.mount();
  assert.equal(field(tree, "生成30秒（两段）").props.checked, true);
  assert.equal(selected.at(-1), 30);
  assert.equal(button(tree, "确认脚本，生成 30 秒视频").props.disabled, false);
  field(tree, "发给数字员工的消息").props.onChange({
    target: { value: "改成15秒就好。" },
  });
  tree = ui.render();
  button(tree, "发送").props.onClick();
  tree = await ui.flush();
  assert.equal(
    ui.calls.find((call) => call.url.endsWith("/messages")).body.options
      .durationSeconds,
    30,
  );
  assert.equal(field(tree, "生成30秒（两段）").props.checked, false);
  assert.equal(selected.at(-1), 15);
  assert.equal(button(tree, "确认脚本，生成 15 秒视频").props.disabled, false);
  field(tree, "生成30秒（两段）").props.onChange({ target: { checked: true } });
  tree = ui.render();
  button(tree, "新对话").props.onClick();
  tree = await ui.flush();
  assert.equal(field(tree, "生成30秒（两段）").props.checked, false);
  assert.equal(field(tree, "待确认方案"), undefined);
  ui.cleanup();
});

test("快捷选项可以单独发起改稿，照片继续使用会话原图；未核验费用仍保留完整方案", async () => {
  let session = {
    ...draftSession(11),
    status: "ready",
    messages: [{ id: 1, role: "assistant", content: "服务端已有方案" }],
    currentPlan: {
      version: 1,
      ready: true,
      options: { imageCount: 6 },
      output: { title: "真实标题", body: "保留全文" },
    },
  };
  const ui = mount("components/NativeEmployeeChat.tsx", baseProps, {
    get: (url) => (url.includes("?") ? { sessions: [session] } : { session }),
    post(url, body) {
      session = {
        ...session,
        messages: [
          ...session.messages,
          { id: 2, role: "user", content: body.message },
          { id: 3, role: "assistant", content: "已按12图重新规划" },
        ],
        currentPlan: {
          ...session.currentPlan,
          version: 2,
          options: body.options,
        },
      };
      return { session };
    },
  });
  let tree = await ui.mount();
  field(tree, "图片数量").props.onChange(12);
  tree = ui.render();
  assert.equal(button(tree, "发送").props.disabled, false);
  button(tree, "发送").props.onClick();
  tree = await ui.flush();
  const sent = ui.calls.find((call) => call.method === "POST");
  assert.equal(sent.body.fileIds, undefined);
  assert.equal(sent.body.options.imageCount, 12);
  assert.match(sent.body.message, /12 张图/);
  assert.equal(
    ui.calls.some((call) => call.url.endsWith("/confirm")),
    false,
  );
  ui.cleanup();
  session = {
    ...session,
    status: "billing_pending",
    currentPlan: { ...session.currentPlan, ready: false },
  };
  const pending = mount(
    "components/NativeEmployeeChat.tsx",
    { ...baseProps, mediaReady: false },
    {
      get: (url) => (url.includes("?") ? { sessions: [session] } : { session }),
    },
  );
  tree = await pending.mount();
  assert.ok(
    named(tree, "Markdown").some((node) =>
      node.props.content.includes("保留全文"),
    ),
  );
  assert.equal(
    named(tree, "Button").find((node) =>
      String(node.props.children).startsWith("确认"),
    ).props.disabled,
    true,
  );
  assert.equal(button(tree, "发送").props.disabled, true);
  pending.cleanup();
});

test("图片拖放复用上传限制且不预先识图；重复拖入和disabled不产生额外上传", async () => {
  const previousReader = globalThis.FileReader;
  const changed = [];
  let finish;
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = "data:image/png;base64,aGVsbG8=";
      queueMicrotask(() => this.onload());
    }
  };
  try {
    const props = {
      files: [],
      onChange: (value) => changed.push(value),
      imagesOnly: true,
      recognize: false,
      dropEnabled: true,
      purpose: "ai_xhs_note",
    };
    const ui = mount("components/UnifiedFilePicker.tsx", props, {
      post: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    let tree = await ui.mount();
    const drop = {
      preventDefault() {},
      dataTransfer: {
        files: [{ name: "菜品.png", type: "image/png", size: 100 }],
      },
    };
    tree.props.onDrop(drop);
    tree.props.onDrop(drop);
    await tick();
    assert.equal(ui.calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(ui.calls[0].url, "/files/upload");
    assert.equal(ui.calls[0].body.recognize, false);
    assert.equal(ui.calls[0].body.purpose, "ai_xhs_note");
    finish({
      file: { id: 3, name: "菜品.png", file_url: "/uploads/tenant-dish.png" },
    });
    await ui.flush();
    assert.equal(changed[0][0].id, 3);
    tree = ui.render({ ...props, disabled: true });
    tree.props.onDrop(drop);
    await tick();
    assert.equal(ui.calls.filter((call) => call.method === "POST").length, 1);
    tree = ui.render(props);
    tree.props.onDrop({
      preventDefault() {},
      dataTransfer: {
        files: [
          { name: "too-large.png", type: "image/png", size: 16 * 1024 * 1024 },
        ],
      },
    });
    await ui.flush();
    assert.equal(ui.calls.filter((call) => call.method === "POST").length, 1);
    assert.ok(ui.notices.some((item) => item.value.includes("超过15MB")));
  } finally {
    globalThis.FileReader = previousReader;
  }
});

test("空对话不伪造员工回复，6/9/12与六风格来自真实选项，未发送不生成", async () => {
  const ui = mount("components/NativeEmployeeChat.tsx", baseProps);
  const tree = await ui.mount();
  assert.deepEqual(ui.calls, [
    { method: "GET", url: "/content/native-chat/sessions?employeeIdx=11" },
  ]);
  assert.equal(named(tree, "Markdown").length, 0);
  assert.equal(field(tree, "待确认方案"), undefined);
  assert.deepEqual(
    field(tree, "图片数量").props.options.map((item) => item.value),
    [6, 9, 12],
  );
  assert.equal(field(tree, "内容风格").props.options.length, 6);
  assert.equal(button(tree, "发送").props.disabled, true);
  assert.equal(named(tree, "UnifiedFilePicker")[0].props.recognize, false);
  assert.equal(named(tree, "UnifiedFilePicker")[0].props.dropEnabled, true);
  assert.equal(button(tree, "全部历史 · 任务中心").props.href, "/tasks");
});

test("两岗使用示例点击只填草稿和快捷选项，不上传假照片或自动付费提交", async () => {
  for (const employeeIdx of [10, 11]) {
    const ui = mount("components/NativeEmployeeChat.tsx", {
      ...baseProps,
      employeeIdx,
    });
    let tree = await ui.mount();
    const exampleSection = field(tree, "使用示例");
    const choices = named(exampleSection, "Button");
    assert.equal(choices.length, 3);
    const example = choices[0];
    example.props.onClick();
    tree = ui.render();
    assert.equal(
      field(tree, "发给数字员工的消息").props.value,
      example.props.children,
    );
    assert.deepEqual(named(tree, "UnifiedFilePicker")[0].props.files, []);
    assert.equal(
      ui.calls.some((call) => call.method === "POST"),
      false,
    );
    if (employeeIdx === 10) assert.match(example.props.children, /脚本你来写/);
    else {
      assert.equal(field(tree, "封面形式").props.value, "collage4");
      assert.equal(field(tree, "图片数量").props.value, 6);
    }
    ui.cleanup();
  }
});

test("文字照片先发送真实对话，改稿后确认版本；双击不多发消息或媒体生成", async () => {
  for (const employeeIdx of [10, 11]) {
    let session = draftSession(employeeIdx),
      version = 0;
    const generated = [];
    const ui = mount(
      "components/NativeEmployeeChat.tsx",
      {
        ...baseProps,
        employeeIdx,
        onGeneration: (value) => generated.push(value),
      },
      {
        post(url, body) {
          if (url.endsWith("/sessions")) return { session };
          if (url.endsWith("/messages")) {
            version++;
            session = {
              ...session,
              status: "ready",
              files: [
                { id: 3, name: "门头原图", file_url: "/uploads/real-shop.png" },
              ],
              messages: [
                ...session.messages,
                {
                  id: version * 2,
                  role: "user",
                  content: body.message,
                  fileIds: body.fileIds,
                },
                {
                  id: version * 2 + 1,
                  role: "assistant",
                  content: `模拟服务端真实回复${version}，不由前端编造。`,
                },
              ],
              currentPlan: {
                version,
                ready: true,
                summary: "模拟服务端计划",
                options: body.options,
                script:
                  employeeIdx === 10
                    ? { shots: [{ index: 1, voiceover: "模拟中文稿" }] }
                    : undefined,
                output:
                  employeeIdx === 11
                    ? { title: "门店标题", body: "模拟文稿", tags: ["招牌菜"] }
                    : undefined,
              },
            };
            return { session };
          }
          const generation = {
            kind: employeeIdx === 10 ? "video" : "xhs",
            jobId: 77,
            pollUrl: "/content/test/77",
            planVersion: version,
          };
          session = { ...session, status: "generating", generation };
          return { session, generation };
        },
      },
    );
    let tree = await ui.mount();
    field(tree, "发给数字员工的消息").props.onChange({
      target: { value: "这是山禾小馆，先看照片给方案。" },
    });
    named(tree, "UnifiedFilePicker")[0].props.onChange([
      { id: 3, name: "门头原图", file_url: "/uploads/real-shop.png" },
    ]);
    tree = ui.render();
    button(tree, "发送").props.onClick();
    button(tree, "发送").props.onClick();
    tree = await ui.flush();
    const sent = ui.calls.filter((call) => call.url.endsWith("/messages"));
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body.fileIds, [3]);
    assert.ok(sent[0].body.requestKey);
    assert.equal(
      ui.calls.some((call) => call.url.endsWith("/confirm")),
      false,
    );
    assert.equal(
      named(tree, "Markdown").find((node) =>
        node.props.content.includes("模拟服务端真实回复"),
      ).props.content,
      "模拟服务端真实回复1，不由前端编造。",
    );
    assert.ok(
      nodes(
        tree,
        (node) =>
          node.type === "img" && node.props.src === "/uploads/real-shop.png",
      ).length,
    );
    field(tree, "发给数字员工的消息").props.onChange({
      target: { value: "不要写虚构口感，再短一点。" },
    });
    if (employeeIdx === 11) field(tree, "图片数量").props.onChange(12);
    tree = ui.render();
    const confirmation = named(tree, "Button").find((node) =>
      String(node.props.children).startsWith("确认"),
    );
    assert.equal(confirmation.props.disabled, true);
    confirmation.props.onClick();
    assert.equal(
      ui.calls.some((call) => call.url.endsWith("/confirm")),
      false,
    );
    button(tree, "发送").props.onClick();
    tree = await ui.flush();
    const confirm = named(tree, "Button").find((node) =>
      String(node.props.children).startsWith("确认"),
    );
    assert.equal(confirm.props.disabled, false);
    confirm.props.onClick();
    confirm.props.onClick();
    await ui.flush();
    const confirms = ui.calls.filter((call) => call.url.endsWith("/confirm"));
    assert.equal(confirms.length, 1);
    assert.equal(confirms[0].body.planVersion, 2);
    assert.ok(confirms[0].body.requestKey);
    assert.equal(generated.length, 1);
    if (employeeIdx === 11)
      assert.equal(
        ui.calls.filter((call) => call.url.endsWith("/messages"))[1].body
          .options.imageCount,
        12,
      );
    assert.equal(
      ui.calls.some((call) =>
        ["/content/ai-sales-video", "/content/ai-xhs-note"].includes(call.url),
      ),
      false,
    );
    ui.cleanup();
  }
});

test("客户端消息超时先GET恢复；不自动重发，收到真正回复后恢复确认", async () => {
  let session = draftSession(11);
  const ui = mount("components/NativeEmployeeChat.tsx", baseProps, {
    get: (url) => (url.includes("?") ? { sessions: [] } : { session }),
    post(url, body) {
      if (url.endsWith("/sessions")) return { session };
      session = {
        ...session,
        status: "thinking",
        messages: [{ id: 1, role: "user", content: body.message, fileIds: [] }],
      };
      throw new Error("请求超时，结果需查询");
    },
  });
  let tree = await ui.mount();
  field(tree, "发给数字员工的消息").props.onChange({
    target: { value: "保留这条用户输入" },
  });
  button(ui.render(), "发送").props.onClick();
  tree = await ui.flush();
  assert.equal(
    field(tree, "发给数字员工的消息").props.value,
    "保留这条用户输入",
  );
  assert.equal(
    ui.calls.filter((call) => call.url.endsWith("/messages")).length,
    1,
  );
  assert.ok(
    ui.calls.some((call) => call.method === "GET" && call.url.endsWith("/41")),
  );
  session = {
    ...session,
    status: "ready",
    messages: [
      ...session.messages,
      { id: 2, role: "assistant", content: "真正已完成的回复" },
    ],
    currentPlan: { ready: true, version: 1, options: { imageCount: 6 } },
  };
  ui.timers.find((timer) => timer.active && timer.interval).fn();
  tree = await ui.flush();
  assert.equal(field(tree, "发给数字员工的消息").props.value, "");
  assert.equal(
    ui.calls.filter((call) => call.url.endsWith("/messages")).length,
    1,
  );
  assert.equal(
    named(tree, "Button").find((node) =>
      String(node.props.children).startsWith("确认"),
    ).props.disabled,
    false,
  );
  ui.cleanup();
});

test("明确退回预授权的失败保留输入，用户再次发送才创建新尝试", async () => {
  let session = draftSession(11);
  const ui = mount("components/NativeEmployeeChat.tsx", baseProps, {
    post(url, body) {
      if (url.endsWith("/sessions")) return { session };
      session = {
        ...session,
        status: "failed",
        messages: [
          ...session.messages,
          {
            id: session.messages.length + 1,
            role: "user",
            content: body.message,
          },
          {
            id: session.messages.length + 2,
            role: "assistant",
            status: "failed",
            content: "调用前检查未通过，预授权退回。",
            billing: { state: "released" },
          },
        ],
      };
      return { session };
    },
  });
  let tree = await ui.mount();
  field(tree, "发给数字员工的消息").props.onChange({
    target: { value: "保留原消息等待重试" },
  });
  button(ui.render(), "发送").props.onClick();
  tree = await ui.flush();
  assert.equal(
    field(tree, "发给数字员工的消息").props.value,
    "保留原消息等待重试",
  );
  assert.equal(
    ui.calls.filter((call) => call.url.endsWith("/messages")).length,
    1,
  );
  button(tree, "发送").props.onClick();
  await ui.flush();
  const attempts = ui.calls.filter((call) => call.url.endsWith("/messages"));
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].body.requestKey, attempts[1].body.requestKey);
  ui.cleanup();
});

test("已保存原稿可免费重新检查，重复点击只有一次请求并接收新方案版本", async () => {
  const old = {
    ...draftSession(10),
    status: "draft",
    messages: [{ id: 1, role: "assistant", content: "欢迎到罗二火锅坐坐" }],
    currentPlan: {
      version: 3,
      ready: false,
      script: { shots: [{ index: 1, voiceover: "欢迎到罗二火锅坐坐" }] },
    },
  };
  let resolve;
  const ui = mount(
    "components/NativeEmployeeChat.tsx",
    { ...baseProps, employeeIdx: 10 },
    {
      get: (url) =>
        url.includes("?") ? { sessions: [old] } : { session: old },
      post: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
  );
  let tree = await ui.mount();
  assert.match(JSON.stringify(tree), /不重复生成，也不新增费用/);
  const check = button(tree, "重新检查方案");
  assert.equal(check.props.disabled, false);
  check.props.onClick();
  check.props.onClick();
  await ui.flush();
  const requests = ui.calls.filter((call) => call.method === "POST");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/content/native-chat/sessions/41/revalidate");
  assert.deepEqual(requests[0].body, { planVersion: 3 });
  resolve({
    session: {
      ...old,
      status: "ready",
      currentPlan: { ...old.currentPlan, version: 4, ready: true },
    },
  });
  tree = await ui.flush();
  assert.equal(button(tree, "重新检查方案"), undefined);
  assert.equal(button(tree, "确认脚本，生成 30 秒视频").props.disabled, false);
  assert.match(JSON.stringify(tree), /欢迎到罗二火锅坐坐/);
  assert.equal(
    ui.calls.some(
      (call) => call.url.endsWith("/messages") || call.url.endsWith("/confirm"),
    ),
    false,
  );
  ui.cleanup();
});

test("重新检查遵守费用、执行与确认状态，关闭后的晚回复不覆盖新对话", async () => {
  const base = {
    ...draftSession(10),
    status: "draft",
    currentPlan: {
      version: 2,
      ready: false,
      output: { title: "保留标题", body: "完整原稿" },
    },
  };
  for (const extra of [
    { status: "thinking" },
    { status: "billing_pending" },
    { status: "generating" },
    {
      generation: {
        kind: "xhs",
        jobId: 7,
        planVersion: 2,
        pollUrl: "/content/ai-xhs-note/jobs/7",
      },
    },
    { currentPlan: { version: 2, ready: false } },
  ]) {
    const session = { ...base, ...extra };
    const ui = mount(
      "components/NativeEmployeeChat.tsx",
      { ...baseProps, employeeIdx: 10 },
      {
        get: (url) =>
          url.includes("?") ? { sessions: [session] } : { session },
      },
    );
    const tree = await ui.mount();
    assert.equal(button(tree, "重新检查方案"), undefined);
    assert.equal(
      ui.calls.some((call) => call.method === "POST"),
      false,
    );
    ui.cleanup();
  }
  let resolve;
  const ui = mount(
    "components/NativeEmployeeChat.tsx",
    { ...baseProps, employeeIdx: 10 },
    {
      get: (url) =>
        url.includes("?") ? { sessions: [base] } : { session: base },
      post: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
  );
  let tree = await ui.mount();
  field(tree, "发给数字员工的消息").props.onChange({
    target: { value: "还没有发送的修改意见" },
  });
  button(ui.render(), "重新检查方案").props.onClick();
  await tick();
  ui.render({ ...baseProps, employeeIdx: 10, open: false });
  await ui.flush();
  resolve({
    session: {
      ...base,
      currentPlan: {
        ...base.currentPlan,
        version: 3,
        ready: true,
        output: { title: "晚到的结果", body: "不能覆盖" },
      },
    },
  });
  tree = await ui.flush();
  assert.doesNotMatch(JSON.stringify(tree), /晚到的结果|不能覆盖/);
  assert.equal(
    field(tree, "发给数字员工的消息").props.value,
    "还没有发送的修改意见",
  );
  ui.cleanup();
});

test("派活关闭不发消息；图片服务不可用仍可聊，不能确认付费出图；关闭后晚回执不跨岗", async () => {
  const forbidden = mount("components/NativeEmployeeChat.tsx", {
    ...baseProps,
    canDispatch: false,
  });
  let tree = await forbidden.mount();
  field(tree, "发给数字员工的消息").props.onChange({
    target: { value: "不能派活" },
  });
  tree = forbidden.render();
  button(tree, "发送").props.onClick();
  await forbidden.flush();
  assert.equal(
    forbidden.calls.some((call) => call.method === "POST"),
    false,
  );
  let resolve;
  const generated = [];
  const ui = mount(
    "components/NativeEmployeeChat.tsx",
    {
      ...baseProps,
      mediaReady: false,
      onGeneration: (value) => generated.push(value),
    },
    {
      post: (url) =>
        url.endsWith("/sessions")
          ? { session: draftSession(11) }
          : new Promise((done) => {
              resolve = done;
            }),
    },
  );
  tree = await ui.mount();
  field(tree, "发给数字员工的消息").props.onChange({
    target: { value: "只讨论方案" },
  });
  button(ui.render(), "发送").props.onClick();
  await tick();
  ui.render({ ...baseProps, open: false });
  await ui.flush();
  resolve({
    session: {
      ...draftSession(11),
      status: "ready",
      messages: [{ id: 1, role: "assistant", content: "旧租户私密回复" }],
      generation: { kind: "xhs", jobId: 7, pollUrl: "/content/old/7" },
    },
  });
  await ui.flush();
  assert.deepEqual(generated, []);
  assert.doesNotMatch(JSON.stringify(ui.tree), /旧租户私密回复/);
  ui.setUser({ id: 9, tenant: { id: 4 }, role: "boss" });
  const switched = ui.render({ ...baseProps, employeeIdx: 10, open: true });
  assert.equal(field(switched, "发给数字员工的消息").props.value, "");
  assert.deepEqual(named(switched, "UnifiedFilePicker")[0].props.files, []);
  tree = await ui.flush();
  assert.doesNotMatch(JSON.stringify(tree), /旧租户私密回复|只讨论方案/);
  ui.cleanup();
});

test("发布包下载只认受控路径，携带cookie和门店上下文，ZIP成功才保存，错误不假下载", async () => {
  const originalFetch = globalThis.fetch,
    originalDocument = globalThis.document;
  const create = URL.createObjectURL,
    revoke = URL.revokeObjectURL;
  const requests = [],
    anchors = [],
    released = [];
  try {
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options });
      return new Response("PK-test-package", {
        status: 200,
        headers: { "Content-Type": "application/zip" },
      });
    };
    globalThis.document = {
      createElement() {
        const anchor = {
          click() {
            anchors.push({ href: this.href, download: this.download });
          },
        };
        return anchor;
      },
    };
    URL.createObjectURL = () => "blob:test-zip";
    URL.revokeObjectURL = (value) => released.push(value);
    const ui = mount("components/NativeDeliverableDownloadButton.tsx", {
      url: "/api/content/native-deliverables/xhs/7/download",
      name: "山禾发布包.zip",
    });
    let tree = await ui.mount();
    button(tree, "一键打包下载").props.onClick();
    button(tree, "一键打包下载").props.onClick();
    await ui.flush();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.credentials, "same-origin");
    assert.deepEqual(requests[0].options.headers, { "X-Store-Id": "2" });
    assert.deepEqual(anchors, [
      { href: "blob:test-zip", download: "山禾发布包.zip" },
    ]);
    ui.timers[0].fn();
    assert.deepEqual(released, ["blob:test-zip"]);
    tree = ui.render({ url: "https://untrusted.example/archive.zip" });
    assert.equal(tree, null);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "无权下载这条任务" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    tree = ui.render({
      url: "/api/content/native-deliverables/sales/9/download",
      label: "一键下载 ZIP",
    });
    button(tree, "一键下载 ZIP").props.onClick();
    await ui.flush();
    assert.match(ui.notices.at(-1).value, /无权下载这条任务/);
    assert.equal(anchors.length, 1);
    globalThis.fetch = async () =>
      new Response("<html>登录</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    button(ui.render(), "一键下载 ZIP").props.onClick();
    await ui.flush();
    assert.match(ui.notices.at(-1).value, /不是发布包/);
    assert.equal(anchors.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  }
});

test("测试员原生聊天对话与配图方案不展示企业积分报价", async () => {
  const session = { id: 77, employeeIdx: 11, status: "ready", files: [], options: { imageCount: 6 },
    messages: [{ id: 1, role: "assistant", content: "已保存方案", billing: { state: "settled", chargedCredits: 0, costYuan: 0.031 } }],
    currentPlan: { version: 1, ready: true, summary: "图文方案", options: { imageCount: 6 } } };
  const ui = mount("components/NativeEmployeeChat.tsx", baseProps, { get: url => url.includes("?") ? { sessions: [session] } : { session } });
  ui.setUser({ id: 8, tenant: { id: 3 }, role: "boss", accountType: "tester" });
  const tree = await ui.mount();
  const hints = nodes(tree, node => node.props?.className === "native-employee-chat__hint").map(node => JSON.stringify(node.props.children)).join(" ");
  assert.match(hints, /个人API计费.*0\.0310/);
  assert.match(hints, /本方案 6 张图.*API Key/);
  assert.doesNotMatch(hints, /积分|预授权|未扣费|免费/);
  assert.equal(ui.calls.some(call => call.method === "POST"), false);
  ui.cleanup();
});
