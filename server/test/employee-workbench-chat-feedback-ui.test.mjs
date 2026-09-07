import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const requireWeb = createRequire(
  new URL("../../web/package.json", import.meta.url),
);
const ts = requireWeb("typescript");
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

function mountFeedback(initialProps, responses = {}) {
  let cursor = 0;
  const state = [];
  const effects = [];
  const calls = [];
  const notices = [];
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in state))
        state[index] = typeof initial === "function" ? initial() : initial;
      return [
        state[index],
        (value) => {
          state[index] =
            typeof value === "function" ? value(state[index]) : value;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      return (state[index] ||= { current: initial });
    },
    useEffect(fn) {
      effects.push(fn);
    },
  };
  const antd = new Proxy(
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
      return responses.get?.(url);
    },
    async post(url, body) {
      calls.push({ method: "POST", url, body });
      return responses.post?.(url, body);
    },
  };
  const module = { exports: {} };
  const compiled = ts.transpileModule(
    read("components/ConversationTaskFeedback.tsx"),
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
      if (name === "antd") return antd;
      if (name === "../api/client") return { api };
      throw new Error(`unexpected dependency: ${name}`);
    },
    module,
    module.exports,
  );
  return {
    calls,
    notices,
    render() {
      cursor = 0;
      return module.exports.default(initialProps);
    },
    async mount() {
      this.render();
      effects.splice(0).forEach((effect) => effect());
      await tick();
      return this.render();
    },
  };
}

test("普通员工历史在对话内读取详情、折叠结果并保留任务中心入口", () => {
  const source = read("components/EmployeeWorkbench.tsx");
  assert.match(source, /employee-workbench\/content\/\$\{idx\}\/runs\?limit=8/);
  assert.match(
    source,
    /employee-workbench\/content\/\$\{idx\}\/runs\/\$\{id\}/,
  );
  assert.match(source, /aria-label="内容员工聊天记录"/);
  assert.match(
    source,
    /aria-expanded=\{\s*selectedRun\?\.id === run\.id && expandedContentRunId === run\.id && contentResultOpen\s*\}/,
  );
  assert.match(source, /ewb-chat-result-disclosure/);
  assert.match(source, /open=\{contentResultOpen\}/);
  assert.match(
    source,
    /onToggle=\{event => setContentResultOpen\(event\.currentTarget\.open\)\}/,
  );
  assert.match(source, /open=\{restaurantResultOpen\}/);
  assert.match(
    source,
    /onToggle=\{event => setRestaurantResultOpen\(event\.currentTarget\.open\)\}/,
  );
  assert.match(source, /\{selectedRun\.requirement && \(/);
  assert.match(source, /\{restaurantTask\.requirement && \(/);
  assert.match(source, /全部历史 · 任务中心/);
  assert.match(
    source,
    /employee-workbench\/content\/\$\{idx\}\/runs\/\$\{selectedRun\.id\}\/review/,
  );
  assert.match(source, /kind="content"/);
  assert.match(source, /kind="restaurant"/);
});

test("一句话使用我只取岗位首个示例并预填输入，不自动提交", () => {
  const source = read("components/EmployeeWorkbench.tsx");
  assert.match(
    source,
    /stringList\(profile\.dispatch\.guidance\?\.taskExamples\)\[0\]/,
  );
  assert.match(source, />一句话使用我</);
  assert.match(
    source,
    /dispatchForm\.setFieldValue\('question', oneLineExample\)/,
  );
  assert.match(source, /点击只会填入输入框，你确认后再发送/);
  const handler = source.slice(
    source.indexOf("const useOneLineExample"),
    source.indexOf("const useOneLineExample") + 650,
  );
  assert.doesNotMatch(handler, /dispatchForm\.submit|api\.(?:get|post)/);
  assert.match(source, /const oneLineExample = !dedicatedContentTask/);
});

test("待审结果先完成业务审阅，再用同一选择记录员工经验", async () => {
  const events = [];
  let detailReads = 0;
  const task = {
    kind: "content",
    id: 18,
    resultVersion: { inputHash: "input-18", outputHash: "output-18" },
    feedbackAvailability: { available: true },
  };
  const reviewedTask = {
    ...task,
    resultVersion: {
      inputHash: "input-18",
      outputHash: "selected-candidate-18",
    },
  };
  const saved = {
    ...task,
    feedback: { decision: "reject", currentVersion: true },
    feedbackAvailability: { available: false },
  };
  const ui = mountFeedback(
    {
      kind: "content",
      taskId: 18,
      businessReview: {
        required: true,
        canReview: true,
        async onSubmit(decision, note) {
          events.push({ stage: "business", decision, note });
        },
      },
    },
    {
      get: () => (++detailReads === 1 ? task : reviewedTask),
      post: (_url, body) => {
        events.push({
          stage: "learning",
          decision: body.decision,
          note: body.note,
        });
        return { ok: true, task: saved };
      },
    },
  );
  let tree = await ui.mount();
  assert.deepEqual(
    ui.calls.map((call) => `${call.method} ${call.url}`),
    ["GET /task-center/content/18"],
  );
  button(tree, "不采纳，保留原稿").props.onClick();
  await tick();
  assert.deepEqual(events, []);
  assert.match(String(ui.notices[0]?.value), /请写一句不采纳的原因/);

  const input = nodes(tree, (node) => node.type?.displayName === "TextArea")[0];
  input.props.onChange({ target: { value: "  开头缺少门店特色  " } });
  tree = ui.render();
  button(tree, "不采纳，保留原稿").props.onClick();
  await tick();
  assert.deepEqual(events, [
    { stage: "business", decision: "reject", note: "开头缺少门店特色" },
    { stage: "learning", decision: "reject", note: "开头缺少门店特色" },
  ]);
  const feedbackCall = ui.calls.at(-1);
  assert.equal(feedbackCall.url, "/task-center/content/18/feedback");
  assert.deepEqual(feedbackCall.body.resultVersion, reviewedTask.resultVersion);
  assert.ok(feedbackCall.body.requestKey);
});

test("业务选择已保存但经验写入失败时，只重试经验记录", async () => {
  let businessCalls = 0;
  let feedbackCalls = 0;
  const task = {
    kind: "restaurant",
    id: 26,
    resultVersion: { inputHash: "input-26", outputHash: "output-26" },
    feedbackAvailability: { available: true },
  };
  const ui = mountFeedback(
    {
      kind: "restaurant",
      taskId: 26,
      businessReview: {
        required: true,
        canReview: true,
        async onSubmit() {
          businessCalls += 1;
        },
      },
    },
    {
      get: () => task,
      post: () => {
        feedbackCalls += 1;
        if (feedbackCalls === 1) throw new Error("学习服务暂时不可用");
        return {
          ok: true,
          task: {
            ...task,
            feedback: { decision: "adopt", currentVersion: true },
            feedbackAvailability: { available: false },
          },
        };
      },
    },
  );
  let tree = await ui.mount();
  button(tree, "我采纳").props.onClick();
  await tick();
  tree = ui.render();
  assert.equal(businessCalls, 1);
  assert.equal(feedbackCalls, 1);
  assert.match(JSON.stringify(tree), /业务选择已经保存/);
  button(tree, "补记采纳经验").props.onClick();
  await tick();
  assert.equal(businessCalls, 1);
  assert.equal(feedbackCalls, 2);
  assert.equal(ui.notices.at(-1)?.key, "success");
});
