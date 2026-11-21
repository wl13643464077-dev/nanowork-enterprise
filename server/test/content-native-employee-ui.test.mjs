import * as personalBillingCopy from "../../web/src/components/personalApiBilling.js";
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
const component = (name) =>
  Object.assign(function MockComponent() {}, { displayName: name });
function all(tree, predicate, result = []) {
  if (Array.isArray(tree)) {
    tree.forEach((child) => all(child, predicate, result));
    return result;
  }
  if (!tree || typeof tree !== "object") return result;
  if (predicate(tree)) result.push(tree);
  all(tree.props?.children, predicate, result);
  return result;
}
const byName = (tree, name) =>
  all(tree, (node) => node.type?.displayName === name);
const button = (tree, label) =>
  byName(tree, "Button").find((node) => node.props.children === label);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness(file, initialProps, responses = {}) {
  let cursor = 0,
    props = initialProps;
  const state = [],
    effects = [],
    calls = [],
    notices = [],
    creditUpdates = [],
    timers = [];
  const form = {
    values: {
      model: "MiniMax-Hailuo-2.3",
      brief: "制作招牌菜带货视频",
      brandName: "山禾小馆",
    },
    async validateFields() {
      return this.values;
    },
    setFieldsValue(values) {
      this.values = { ...this.values, ...values };
    },
  };
  const Form = component("Form");
  Form.Item = component("Form.Item");
  Form.useForm = () => [form];
  Form.useWatch = (key) => form.values[key];
  const Input = component("Input");
  Input.TextArea = component("Input.TextArea");
  const Typography = { Title: component("Typography.Title") };
  const Modal = component("Modal");
  Modal.confirm = () => {};
  const message = new Proxy(
    {},
    { get: (_, key) => (value) => notices.push({ key, value }) },
  );
  const ant = new Proxy(
    { Form, Input, Typography, Modal, message },
    {
      get(target, key) {
        return (target[key] ||= component(String(key)));
      },
    },
  );
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
    useCallback(fn) {
      return fn;
    },
    useEffect(fn) {
      effects.push(fn);
    },
  };
  const api = {
    async get(url) {
      calls.push({ method: "GET", url });
      if (url === "/content/ai-xhs-note/options") {
        return responses.options
          ? responses.options()
          : {
              imageModel: "gpt-image-2",
              imageCount: 3,
              creditsPerImage: 18,
              imageTotalCredits: 54,
              textBilling: "actual_usage",
              available: true,
            };
      }
      return responses.get ? responses.get(url) : { ready: true, voices: [] };
    },
    async post(url, body) {
      calls.push({ method: "POST", url, body });
      return responses.post
        ? responses.post(url, body)
        : {
            jobId: 6,
            status: "blocked",
            reason: "模拟生成前检查，未调用供应商",
          };
    },
  };
  const source = read(file).replace(/^import ['"].*\.css['"];?$/gm, "");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(
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
          getUser: () => responses.user || { role: "boss" },
          notifyCredits: (balance) => creditUpdates.push(balance),
        };
      if (name === "./UnifiedFilePicker")
        return { UnifiedFilePicker: component("UnifiedFilePicker") };
      if (name === "./useReferenceImages")
        return {
          useReferenceImages: () => ({
            refImgs: [],
            setRefImgs() {},
            onPickRef() {},
          }),
        };
      if (name === "./AiSalesVideoPanel")
        return { default: component("AiSalesVideoPanel") };
      if (name === "./NativeEmployeeChat")
        return { default: component("NativeEmployeeChat") };
      if (name === "./NativeDeliverableDownloadButton")
        return { default: component("NativeDeliverableDownloadButton") };
      if (name === "./SalesVideoPublishKit" || name === "./XhsPhonePreview")
        return { default: component(name.slice(2)) };
      if (name === "./Markdown") return { Markdown: component("Markdown") };
      if (name === "./TaskFeedback")
        return { default: component("TaskFeedback") };
      if (name === "./SpecialistTaskHistory")
        return { default: component("SpecialistTaskHistory") };
      if (name === "./AiXhsNotePanel")
        return { default: component("AiXhsNotePanel") };
      throw new Error(`Unexpected dependency ${name}`);
    },
    module,
    module.exports,
  );
  globalThis.window = {
    setTimeout(fn, delay) {
      timers.push({ fn, delay });
      return timers.length;
    },
    clearTimeout() {},
    sessionStorage: { getItem: () => null, setItem() {} },
  };
  return {
    exports: module.exports,
    calls,
    notices,
    creditUpdates,
    timers,
    form,
    startEffect(fragment) {
      const effect = effects.findLast((fn) => fn.toString().includes(fragment));
      assert.ok(effect, `Missing effect: ${fragment}`);
      return effect();
    },
    render(nextProps) {
      if (nextProps) props = nextProps;
      cursor = 0;
      return module.exports.default(props);
    },
    renderExport(name, nextProps) {
      if (nextProps) props = nextProps;
      cursor = 0;
      return module.exports[name](props);
    },
    async mount() {
      this.render();
      effects.splice(0).forEach((effect) => effect());
      await tick();
      return this.render();
    },
  };
}
async function deliverXhs(ui, id) {
  let tree = await ui.mount();
  byName(tree, "NativeEmployeeChat")[0].props.onGeneration({
    kind: "xhs",
    jobId: id,
    pollUrl: `/content/ai-xhs-note/jobs/${id}`,
  });
  await tick();
  assert.ok(
    ui.calls.some(
      (call) =>
        call.method === "GET" && call.url === `/content/ai-xhs-note/jobs/${id}`,
    ),
  );
  assert.equal(
    ui.calls.some((call) => call.method === "POST"),
    false,
  );
  ui.calls.splice(0);
  return ui.render();
}

const videoProps = {
  open: true,
  embedded: true,
  onOpenChange() {},
  refImgs: [{ id: "3", name: "招牌菜", url: "/uploads/test.jpg", size: 1 }],
  setRefImgs() {},
  onPickRef() {},
  loadMaterials() {},
  loadSummary() {},
  loadMediaJobs() {},
  onTaskSubmitted() {},
};

test("AI带货卡片默认15秒且保留30秒选项，照样片只沿用风格和材料不继承旧时长", () => {
  const { CONTENT_CREW_STATIONS } = harness(
    "components/contentCrewConfig.ts",
    {},
  ).exports;
  const video = CONTENT_CREW_STATIONS.find(
    (station) => station.employeeIdx === 10,
  );
  assert.equal(video.name, "AI带货员");
  assert.equal(video.taskTypes[0], "15秒带货视频");
  assert.ok(video.taskTypes.includes("30秒带货视频（可选）"));
  assert.match(video.duty, /15秒.*可选30秒/);
  assert.match(video.intro, /确认后.*默认15秒一段.*可选30秒两段/);
  assert.doesNotMatch(video.intro, /三段镜头/);
  const xhs = CONTENT_CREW_STATIONS.find(
    (station) => station.employeeIdx === 11,
  );
  assert.deepEqual(xhs.taskTypes, [
    "小红书种草图文",
    "标题与标签",
    "评论区首评",
  ]);
  const { sampleBriefFromSample } = harness(
    "components/ContentSampleLibrary.tsx",
    {},
  ).exports;
  const sample = Object.freeze({
    name: "下班聚餐",
    durationSeconds: 30,
    tags: Object.freeze(["火锅", "探店"]),
    note: "参考平稳运镜，不编造优惠。",
  });
  const brief = sampleBriefFromSample(sample);
  assert.match(brief, /^照样片「下班聚餐」的风格做一条15秒带货视频。/);
  assert.match(brief, /火锅、探店/);
  assert.match(brief, /参考平稳运镜，不编造优惠。/);
  assert.doesNotMatch(brief, /30秒/);
  assert.equal(sample.durationSeconds, 30);
});

test("专岗派活直接嵌入真实技能表单，保留任务深链和样片预填且无二次打开按钮", () => {
  let changed = 0,
    submitted = 0;
  const props = {
    employeeIdx: 10,
    active: true,
    available: true,
    initialJobId: 81,
    presetBrief: { key: 1, text: "照这个风格做一条" },
    onChanged: () => changed++,
    onTaskSubmitted: () => submitted++,
  };
  const ui = harness("components/ContentSpecialistDispatch.tsx", props);
  let tree = ui.render();
  const video = byName(tree, "AiSalesVideoPanel")[0];
  assert.equal(video.props.embedded, true);
  assert.equal(video.props.open, true);
  assert.equal(video.props.initialJobId, 81);
  assert.equal(video.props.presetBrief.text, props.presetBrief.text);
  assert.equal(byName(tree, "Button").length, 0);
  video.props.onTaskSubmitted();
  assert.equal(changed, 1);
  assert.equal(submitted, 1);
  tree = ui.render({
    ...props,
    employeeIdx: 11,
    active: false,
    available: false,
  });
  const xhs = byName(tree, "AiXhsNotePanel")[0];
  assert.equal(xhs.props.embedded, true);
  assert.equal(xhs.props.open, false);
  assert.equal(xhs.props.canDispatch, false);
});

test("带货技能直接嵌入对话，确认回执接入原任务轮询，Modal不再重复生成", async () => {
  let submitted = 0;
  const ui = harness("components/AiSalesVideoPanel.tsx", {
    ...videoProps,
    onTaskSubmitted: () => submitted++,
  });
  let tree = await ui.mount();
  const chat = byName(tree, "NativeEmployeeChat")[0];
  assert.equal(chat.props.employeeIdx, 10);
  assert.equal(byName(tree, "Form").length, 0);
  assert.equal(byName(tree, "Modal").length, 0);
  chat.props.onGeneration({
    kind: "video",
    jobId: 6,
    pollUrl: "/content/media-jobs/6",
  });
  await tick();
  assert.equal(
    ui.calls.some((call) => call.method === "POST"),
    false,
  );
  assert.ok(ui.calls.some((call) => call.url === "/content/media-jobs/6"));
  assert.equal(submitted, 1);
  tree = ui.render({ ...videoProps, embedded: false });
  assert.equal(byName(tree, "Modal")[0].props.title, "AI带货员");
  assert.equal(byName(tree, "Modal")[0].props.footer, null);
});

test("带货员本次回执进入同一任务输入输出，预览和打包使用服务端交付URL", async () => {
  const ui = harness(
    "components/AiSalesVideoPanel.tsx",
    { ...videoProps, initialJobId: 6 },
    {
      get: (url) =>
        url.endsWith("/options")
          ? { ready: true }
          : {
              jobId: 6,
              status: "成功",
              url: "/uploads/video.mp4",
              downloadUrl: "/api/content/native-deliverables/sales/6/download",
              downloadName: "带货包.zip",
            },
    },
  );
  const tree = await ui.mount();
  const result = byName(tree, "Alert").find((node) =>
    button(node.props.description, "查看输入输出 · 采纳或不采纳"),
  );
  assert.equal(
    button(result.props.description, "查看输入输出 · 采纳或不采纳").props.href,
    "/tasks?kind=media&id=6",
  );
  assert.equal(
    all(tree, (node) => node.type === "video")[0].props.src,
    "/uploads/video.mp4",
  );
  assert.equal(
    byName(tree, "NativeDeliverableDownloadButton")[0].props.url,
    "/api/content/native-deliverables/sales/6/download",
  );
});

test("恢复旧视频任务不覆盖当前余额；终态手动刷新只取一次当前钱包，处理中不重复读取", async () => {
  const user = { id: 7, tenant: { id: 1 }, role: "boss", credits: 175822 };
  let status = "成功";
  const ui = harness(
    "components/AiSalesVideoPanel.tsx",
    { ...videoProps, initialJobId: 8 },
    {
      user,
      get: (url) => {
        if (url.endsWith("/options")) return { ready: true };
        if (url === "/auth/me") return user;
        return {
          id: 8,
          status,
          billing: { state: "settled", balance: 176907 },
          previewUrl: "/uploads/old-video.mp4",
        };
      },
    },
  );
  let tree = await ui.mount();
  assert.deepEqual(ui.creditUpdates, []);
  assert.equal(ui.creditUpdates.at(-1) ?? user.credits, 175822);
  assert.equal(ui.calls.filter((call) => call.url === "/auth/me").length, 0);
  const result = byName(tree, "Alert").find((node) =>
    button(node.props.description, "刷新任务结果"),
  );
  button(result.props.description, "刷新任务结果").props.onClick();
  await tick();
  assert.deepEqual(ui.creditUpdates, [175822]);
  assert.equal(ui.calls.filter((call) => call.url === "/auth/me").length, 1);
  status = "处理中";
  tree = ui.render();
  byName(tree, "NativeEmployeeChat")[0].props.onGeneration({
    kind: "video",
    jobId: 9,
    pollUrl: "/content/media-jobs/9",
  });
  await tick();
  ui.timers.at(-1).fn();
  await tick();
  assert.deepEqual(ui.creditUpdates, [175822]);
  assert.equal(ui.calls.filter((call) => call.url === "/auth/me").length, 1);
});

test("带货完成但未业务入库仍用授权previewUrl显示成片、单视频下载和ZIP，费用状态独立", async () => {
  for (const billingState of ["settled", "pending_reconciliation"]) {
    const previewUrl = "/uploads/ai-sales-video/1/sales-video-real.mp4";
    const ui = harness(
      "components/AiSalesVideoPanel.tsx",
      { ...videoProps, initialJobId: 15 },
      {
        get: (url) =>
          url.endsWith("/options")
            ? { ready: true }
            : {
                id: 15,
                status: "成功",
                technicalStatus: "成功",
                url: null,
                previewUrl,
                urlAvailable: true,
                businessUsable: false,
                canExport: false,
                downloadUrl:
                  "/api/content/native-deliverables/sales/15/download",
                downloadName: "15秒带货视频.zip",
                salesVideo: {
                  voiceMode: "voiced",
                  audioMode: "provider_native",
                  durationSeconds: 15,
                  stage: "complete",
                },
                billing: {
                  state: billingState,
                  pendingReconciliation: billingState !== "settled",
                },
              },
      },
    );
    let tree = await ui.mount();
    const chat = byName(tree, "NativeEmployeeChat")[0];
    assert.equal(chat.props.resultFirst, true);
    const videos = all(tree, (node) => node.type === "video");
    assert.equal(videos.length, 1);
    assert.equal(videos[0].props.src, previewUrl);
    assert.equal(videos[0].props.controls, true);
    assert.equal(videos[0].props.playsInline, true);
    assert.equal(button(tree, "下载视频").props.href, previewUrl);
    assert.equal(button(tree, "下载视频").props.download, true);
    const zip = byName(tree, "NativeDeliverableDownloadButton");
    assert.equal(zip.length, 1);
    assert.equal(
      zip[0].props.url,
      "/api/content/native-deliverables/sales/15/download",
    );
    assert.equal(zip[0].props.label, "一键下载 ZIP");
    if (billingState !== "settled")
      assert.match(JSON.stringify(tree), /费用待核对/);
    videos[0].props.onError();
    tree = ui.render();
    assert.ok(
      byName(tree, "Alert").some((node) =>
        String(node.props.message).includes("视频暂未加载"),
      ),
    );
    assert.equal(button(tree, "下载视频").props.href, previewUrl);
    assert.equal(
      ui.calls.some((call) => call.method === "POST"),
      false,
    );
  }
});

test("未获授权的成片不从私有快照拼地址；已有脚本ZIP仍置前且只出现一次", async () => {
  const ui = harness(
    "components/AiSalesVideoPanel.tsx",
    { ...videoProps, initialJobId: 15 },
    {
      get: (url) =>
        url.endsWith("/options")
          ? { ready: true }
          : {
              id: 15,
              status: "失败",
              url: null,
              previewUrl: null,
              urlAvailable: true,
              snapshot_json: { result: { url: "/uploads/private.mp4" } },
              downloadUrl: "/api/content/native-deliverables/sales/15/download",
              billing: { state: "pending_reconciliation" },
            },
    },
  );
  const tree = await ui.mount();
  assert.equal(all(tree, (node) => node.type === "video").length, 0);
  assert.equal(button(tree, "下载视频"), undefined);
  assert.equal(byName(tree, "NativeDeliverableDownloadButton").length, 1);
  assert.equal(byName(tree, "NativeEmployeeChat")[0].props.resultFirst, true);
  assert.doesNotMatch(JSON.stringify(tree), /private\.mp4/);
  assert.equal(
    ui.calls.some((call) => call.method === "POST"),
    false,
  );
});

test("Wan对话确认保留真实生成服务与费用门槛，不再显示音色授权或旧表单", async () => {
  const ui = harness("components/AiSalesVideoPanel.tsx", videoProps, {
    get: () => ({
      ready: true,
      audioMode: "provider_native",
      voices: [],
      estimatedMaxCredits: 360,
    }),
  });
  const tree = await ui.mount();
  const chat = byName(tree, "NativeEmployeeChat")[0];
  assert.equal(chat.props.mediaReady, true);
  assert.match(chat.props.mediaQuote, /360.*上游实际扣费结算/);
  assert.equal(byName(tree, "Form").length, 0);
  assert.doesNotMatch(
    JSON.stringify(tree),
    /3次配音|实测配音时长|有声生成配置未就绪|voiceId/,
  );
  assert.equal(
    ui.calls.some((call) => call.method === "POST"),
    false,
  );
});

test("带货按选中时长使用服务端独立报价，切换不追加请求或推算价格", async () => {
  const ui = harness("components/AiSalesVideoPanel.tsx", videoProps, {
    get: () => ({
      ready: true,
      durationSeconds: 15,
      estimatedMaxCredits: 330,
      durationOptions: [
        { durationSeconds: 15, segmentCount: 1, estimatedMaxCredits: 330 },
        { durationSeconds: 30, segmentCount: 2, estimatedMaxCredits: 740 },
      ],
    }),
  });
  let tree = await ui.mount();
  let chat = byName(tree, "NativeEmployeeChat")[0];
  assert.match(chat.props.mediaQuote, /15秒.*330 积分/);
  assert.equal(chat.props.mediaReady, true);
  const reads = ui.calls.length;
  chat.props.onVideoDurationChange(30);
  tree = ui.render();
  chat = byName(tree, "NativeEmployeeChat")[0];
  assert.match(chat.props.mediaQuote, /30秒.*740 积分/);
  assert.equal(chat.props.mediaReady, true);
  assert.equal(ui.calls.length, reads);
  assert.equal(
    ui.calls.some((call) => call.method === "POST"),
    false,
  );

  const incomplete = harness("components/AiSalesVideoPanel.tsx", videoProps, {
    get: () => ({ ready: true, durationSeconds: 15, estimatedMaxCredits: 330 }),
  });
  tree = await incomplete.mount();
  byName(tree, "NativeEmployeeChat")[0].props.onVideoDurationChange(30);
  chat = byName(incomplete.render(), "NativeEmployeeChat")[0];
  assert.equal(chat.props.mediaReady, false);
  assert.equal(chat.props.mediaQuote, undefined);
});

test("15秒结果展示单段口播与真实时长，缺时长的历史结果仍按30秒", async () => {
  const textOf = (value) =>
    Array.isArray(value)
      ? value.map(textOf).join("")
      : value && typeof value === "object"
        ? textOf(value.props?.children)
        : (value ?? "");
  for (const durationSeconds of [15, undefined]) {
    const ui = harness(
      "components/AiSalesVideoPanel.tsx",
      { ...videoProps, initialJobId: 6 },
      {
        get: (url) =>
          url.endsWith("/options")
            ? { ready: true }
            : {
                jobId: 6,
                status: "成功",
                url: "/uploads/video.mp4",
                salesVideo: {
                  voiceMode: "voiced",
                  audioMode: "provider_native",
                  durationSeconds,
                  audioVerified: true,
                  subtitlesBurnedIn: true,
                  script: {
                    shots: [
                      {
                        index: 1,
                        start: 0,
                        end: 15,
                        voiceover: "服务端保存的单段原稿",
                      },
                    ],
                  },
                },
                billing: { state: "settled", chargedCredits: 300 },
              },
      },
    );
    const tree = await ui.mount();
    const result = byName(tree, "Alert").find((node) =>
      button(node.props.description, "查看输入输出 · 采纳或不采纳"),
    );
    const serialized = JSON.stringify(result.props.description);
    assert.match(
      textOf(result.props.description),
      new RegExp(`目标时长${durationSeconds || 30}秒`),
    );
    assert.match(serialized, /服务端保存的单段原稿/);
    assert.doesNotMatch(serialized, /已检测到两段声音/);
  }
});

test("Wan原生进度使用真实音画阶段，字幕来源与历史配音分开说明", async () => {
  const ui = harness(
    "components/AiSalesVideoPanel.tsx",
    {
      ...videoProps,
      initialJobId: 501,
    },
    {
      get: (url) =>
        url.endsWith("/options")
          ? { ready: true, voices: [] }
          : {
              jobId: 501,
              status: "处理中",
              salesVideo: {
                voiceMode: "voiced",
                audioMode: "provider_native",
                stage: "video",
                subtitleTiming: "script_estimated",
              },
              billing: { state: "held", heldCredits: 360 },
            },
    },
  );
  const tree = await ui.mount();
  assert.match(JSON.stringify(tree), /正在生成声音与画面/);
  assert.match(JSON.stringify(tree), /字幕按脚本时段排列，尚未做逐字语音对齐/);
  assert.doesNotMatch(JSON.stringify(tree), /历史任务音色/);
  assert.equal(
    ui.calls.some((call) => call.method === "POST"),
    false,
  );
});

test("两岗把派活权限交给实际聊天控件，面板不自行发起生成", async () => {
  for (const [file, props] of [
    ["AiSalesVideoPanel", videoProps],
    ["AiXhsNotePanel", { open: true, embedded: true, onOpenChange() {} }],
  ]) {
    const ui = harness(`components/${file}.tsx`, {
      ...props,
      canDispatch: false,
    });
    const tree = ui.render();
    assert.equal(
      byName(tree, "NativeEmployeeChat")[0].props.canDispatch,
      false,
    );
    assert.equal(button(tree, "开始工作"), undefined);
    assert.equal(button(tree, "一键生成图文"), undefined);
    assert.equal(
      ui.calls.some((call) => call.method === "POST"),
      false,
    );
  }
});

test("关闭的嵌入技能不加载模型或历史任务，兼容旧小红书Modal", async () => {
  const video = harness("components/AiSalesVideoPanel.tsx", {
    ...videoProps,
    open: false,
  });
  await video.mount();
  const xhs = harness("components/AiXhsNotePanel.tsx", {
    open: false,
    embedded: true,
    onOpenChange() {},
  });
  await xhs.mount();
  assert.deepEqual(video.calls, []);
  assert.deepEqual(xhs.calls, []);
  const modal = byName(
    xhs.render({ open: true, onOpenChange() {} }),
    "Modal",
  ).find((node) => node.props.title === "AI小红书种草员");
  assert.ok(modal);
  assert.equal(modal.props.open, true);
});

test("小红书技能正文优先并保留编辑复制、全文及费用，采纳留在当前工作台且不回到通用dispatch", async () => {
  const output = {
    title: "山禾招牌菜",
    body: "完整正文".repeat(2200),
    tags: ["山禾小馆"],
    firstComment: "欢迎交流",
    imagePlan: [],
    warnings: ["发布前核对活动"],
  };
  const job = {
    id: 22,
    status: "success",
    decision: "pending",
    brandName: "山禾小馆",
    output,
    files: [],
    fileIds: [],
    billing: { state: "settled", chargedCredits: 12 },
  };
  const ui = harness(
    "components/AiXhsNotePanel.tsx",
    { open: true, embedded: true, onOpenChange() {} },
    {
      get: (url) => (url.endsWith("/jobs") ? [job] : job),
      post: () => job,
    },
  );
  let tree = await deliverXhs(ui, job.id);
  const panel = all(
    tree,
    (node) => node.props?.className === "ai-xhs-note-panel",
  )[0];
  assert.equal(byName(panel, "NativeEmployeeChat").length, 1);
  assert.ok(
    all(panel, (node) => node.props?.["aria-label"] === "小红书图文发布包")
      .length,
  );
  assert.equal(
    all(tree, (node) => node.props?.["aria-label"] === "正文")[0].props.value,
    output.body,
  );
  assert.ok(button(tree, "整体复制"));
  assert.ok(button(tree, "保存文案"));
  assert.equal(button(tree, "到任务中心采纳或反馈"), undefined);
  const history = byName(tree, "SpecialistTaskHistory")[0];
  assert.ok(history);
  assert.equal(typeof history.props.onBusinessDecision, "function");
  assert.match(JSON.stringify(tree), /文案费用：12 积分/);
  all(tree, (node) => node.props?.["aria-label"] === "标题")[0].props.onChange({
    target: { value: "老板修改的标题" },
  });
  tree = ui.render();
  assert.equal(
    all(tree, (node) => node.props?.["aria-label"] === "标题")[0].props.value,
    "老板修改的标题",
  );
  assert.equal(byName(tree, "NativeEmployeeChat")[0].props.employeeIdx, 11);
  assert.equal(
    ui.calls.some((call) => call.method === "POST"),
    false,
  );
  assert.equal(
    ui.calls.filter((call) => call.url.endsWith("/dispatch")).length,
    0,
  );
});

test("小红书把多图价格选项交给对话，发送与生成分开确认", async () => {
  const supplied = {
    available: true,
    imageCount: 6,
    creditsPerImage: 18,
    imageTotalCredits: 108,
    imageCounts: [6, 9, 12],
    styles: [
      { id: "seed", label: "种草推荐" },
      { id: "review", label: "对比测评" },
    ],
    coverLayouts: [{ id: "collage4", label: "四宫格拼图" }],
  };
  const ui = harness(
    "components/AiXhsNotePanel.tsx",
    { open: true, embedded: true, onOpenChange() {} },
    { get: () => [], options: () => supplied },
  );
  const tree = await ui.mount();
  const chat = byName(tree, "NativeEmployeeChat")[0];
  assert.deepEqual(chat.props.imageOptions, supplied);
  assert.equal(chat.props.mediaReady, true);
  assert.equal(
    byName(tree, "Form").some((node) => node.props.onFinish),
    false,
  );
  assert.equal(
    ui.calls.some((call) => call.method === "POST"),
    false,
  );
});

test("小红书配图价格读取失败不按零费确认，聊天与历史仍可用", async () => {
  for (const providerOptions of [
    () => {
      throw new Error("价格读取失败");
    },
    () => ({ available: false, reason: "当前角色未开通图片生成" }),
  ]) {
    const ui = harness(
      "components/AiXhsNotePanel.tsx",
      { open: true, embedded: true, onOpenChange() {} },
      { get: () => [], options: providerOptions },
    );
    const tree = await ui.mount();
    const chat = byName(tree, "NativeEmployeeChat")[0];
    assert.equal(chat.props.mediaReady, false);
    assert.equal(chat.props.canDispatch, true);
    assert.ok(
      byName(tree, "Alert").some((node) =>
        /配图价格暂未读取|当前角色未开通图片生成/.test(
          node.props.message || "",
        ),
      ),
    );
    assert.equal(
      ui.calls.some((call) => call.method === "POST"),
      false,
    );
  }
});

test("小红书部分配图失败仍展示成功图片和可编辑文案，仅重试可安全重试的失败图", async () => {
  const output = {
    title: "山禾招牌菜",
    body: "完整文案",
    tags: ["附近美食"],
    firstComment: "欢迎交流",
    imagePlan: [{ fileId: 3, caption: "参考原图" }],
  };
  const job = {
    id: 74,
    status: "success",
    output,
    files: [{ id: 3, name: "原图", file_url: "/uploads/source.jpg" }],
    imageGeneration: {
      model: "gpt-image-2",
      status: "partial",
      items: [
        {
          id: "cover",
          label: "封面",
          status: "success",
          url: "/uploads/cover.png",
          warning: "本地排版未完成，已保留AI创意原图。",
          billing: { state: "settled", chargedCredits: 18 },
        },
        {
          id: "detail",
          label: "菜品特写",
          status: "failed",
          canRetry: false,
          billing: { state: "pending_reconciliation" },
        },
        {
          id: "scene",
          label: "用餐氛围",
          status: "failed",
          canRetry: true,
          billing: { state: "released" },
        },
      ],
    },
    billing: { state: "settled", chargedCredits: 4 },
  };
  const ui = harness(
    "components/AiXhsNotePanel.tsx",
    { open: true, embedded: true, onOpenChange() {} },
    {
      get: (url) => (url.endsWith("/jobs") ? [job] : job),
      post: (url) =>
        url.endsWith("retry-images")
          ? {
              ...job,
              imageGeneration: { ...job.imageGeneration, status: "running" },
            }
          : job,
    },
  );
  let tree = await deliverXhs(ui, job.id);
  const gallery = all(
    tree,
    (node) => node.props?.["aria-label"] === "AI生成配图",
  )[0];
  assert.equal(all(gallery, (node) => node.type === "figure").length, 3);
  assert.deepEqual(
    all(gallery, (node) => node.type === "a").map((node) => node.props.href),
    ["/uploads/cover.png"],
  );
  assert.match(JSON.stringify(gallery), /本图费用：18 积分/);
  assert.match(JSON.stringify(gallery), /本地排版未完成，已保留AI创意原图/);
  assert.equal(
    all(gallery, (node) => node.type === "a")[0].props.download,
    true,
  );
  assert.match(JSON.stringify(gallery), /本图费用待核对/);
  assert.match(JSON.stringify(gallery), /本图预授权已退回/);
  const source = all(tree, (node) => node.type === "details").find((node) =>
    JSON.stringify(node.props.children).includes("查看原始照片与生成记录"),
  );
  assert.ok(source);
  assert.equal(source.props.open, undefined);
  all(tree, (node) => node.props?.["aria-label"] === "正文")[0].props.onChange({
    target: { value: "用户保留的修改稿" },
  });
  tree = ui.render();
  const retry = byName(tree, "Button").find((node) =>
    JSON.stringify(node.props.children).includes("只重试失败的"),
  );
  retry.props.onClick();
  retry.props.onClick();
  await tick();
  const requests = ui.calls.filter((call) => call.method === "POST");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/content/ai-xhs-note/jobs/74/retry-images");
  assert.deepEqual(requests[0].body, { imageIds: ["scene"] });
  tree = ui.render();
  assert.equal(
    all(tree, (node) => node.props?.["aria-label"] === "正文")[0].props.value,
    "用户保留的修改稿",
  );
  assert.ok(button(tree, "整体复制"));
});

test("小红书文案已成功而配图pending或running仍轮询，后续图片响应不覆盖用户修改", async () => {
  for (const imageStatus of ["pending", "running"]) {
    const job = {
      id: 75,
      status: "success",
      output: {
        title: "标题",
        body: "原文",
        tags: [],
        firstComment: "首评",
        imagePlan: [],
      },
      imageGeneration: {
        status: imageStatus,
        items: [{ id: "cover", label: "封面", status: imageStatus }],
      },
    };
    const ui = harness(
      "components/AiXhsNotePanel.tsx",
      { open: true, embedded: true, onOpenChange() {} },
      {
        get: (url) =>
          url.endsWith("/jobs")
            ? [job]
            : {
                ...job,
                imageGeneration: {
                  status: "success",
                  items: [
                    {
                      id: "cover",
                      label: "封面",
                      status: "success",
                      url: "/uploads/final-cover.png",
                    },
                  ],
                },
              },
      },
    );
    let tree = await ui.mount();
    all(
      tree,
      (node) => node.props?.["aria-label"] === "正文",
    )[0].props.onChange({
      target: { value: "图片生成时正在编辑的正文" },
    });
    tree = ui.render();
    assert.equal(byName(tree, "NativeEmployeeChat")[0].props.generating, true);
    const cleanup = ui.startEffect("imageStatus");
    await ui.timers.at(-1).fn();
    tree = ui.render();
    assert.equal(
      all(tree, (node) => node.props?.["aria-label"] === "正文")[0].props.value,
      "图片生成时正在编辑的正文",
    );
    assert.ok(
      all(tree, (node) => node.type === "img").some(
        (node) => node.props.src === "/uploads/final-cover.png",
      ),
    );
    assert.equal(byName(tree, "NativeEmployeeChat")[0].props.generating, false);
    assert.equal(
      ui.calls.filter((call) => call.url.endsWith("/jobs/75")).length,
      1,
    );
    cleanup();
  }
});

test("没有派活权限时配图重试按钮与实际请求均被阻止", async () => {
  const job = {
    id: 76,
    status: "success",
    output: {
      title: "标题",
      body: "仍可读的正文",
      tags: [],
      firstComment: "首评",
      imagePlan: [],
    },
    imageGeneration: {
      status: "failed",
      items: [{ id: "scene", label: "氛围", status: "failed", canRetry: true }],
    },
  };
  const ui = harness(
    "components/AiXhsNotePanel.tsx",
    { open: true, embedded: true, canDispatch: true, onOpenChange() {} },
    { get: (url) => (url.endsWith("/jobs") ? [] : job) },
  );
  await deliverXhs(ui, job.id);
  const tree = ui.render({
    open: true,
    embedded: true,
    canDispatch: false,
    onOpenChange() {},
  });
  const retry = byName(tree, "Button").find((node) =>
    JSON.stringify(node.props.children).includes("只重试失败的"),
  );
  assert.equal(retry.props.disabled, true);
  retry.props.onClick();
  await tick();
  assert.equal(
    ui.calls.some((call) => call.method === "POST"),
    false,
  );
  assert.ok(button(tree, "整体复制"));
});

test("内容卡片与深链统一进入员工工作台，真实技能摘要保留且技能进修沿用权限", () => {
  const factory = read("pages/ContentFactory.tsx"),
    workbench = read("components/EmployeeWorkbench.tsx");
  assert.doesNotMatch(
    factory,
    /<AiSalesVideoPanel|<AiXhsNotePanel|setSalesVideoOpen|setXhsNoteOpen/,
  );
  assert.match(
    factory,
    /requestedMediaJobId \|\| requestedTask === 'ai-sales-video' \? 10 : requestedTask === 'ai-xhs-note' \? 11 : null/,
  );
  for (const field of ["capabilityCount", "capabilityNames", "skillCount"])
    assert.match(factory, new RegExp(`${field}:.*remote\\.${field}`));
  assert.match(
    factory,
    /initialMediaJobId=\{crewWorkbenchIdx === 10 \? crewMediaJobId : null\}/,
  );
  assert.match(
    factory,
    /initialSalesVideoBrief=\{crewWorkbenchIdx === 10 \? salesVideoPreset : null\}/,
  );
  assert.match(workbench, /active=\{open\}/);
  assert.match(workbench, /profile\.permissions\.canEditSkills \? \(/);
  assert.match(workbench, /全网进修/);
  assert.match(
    workbench,
    /employee-workbench\/content\/\$\{idx\}\/runs\?limit=8/,
  );
  assert.match(workbench, /loadRunDetail\(Number\(initialRunId\)\)/);
});

test("小红书仅取回明确可恢复的原图片，双击和生成重试不交叉执行，用户修改稿保留", async () => {
  const job = {
    id: 88,
    status: "success",
    output: {
      title: "原标题",
      body: "原文",
      tags: [],
      firstComment: "",
      imagePlan: [],
    },
    imageGeneration: {
      status: "partial",
      items: [
        {
          id: "cover",
          label: "封面",
          status: "success",
          url: "/uploads/cover.png",
          canRecover: true,
          canRetry: false,
        },
        {
          id: "detail",
          label: "详情",
          status: "failed",
          canRecover: false,
          canRetry: false,
        },
        {
          id: "scene",
          label: "场景",
          status: "failed",
          canRecover: true,
          canRetry: false,
        },
        {
          id: "pairing",
          label: "搭配",
          status: "failed",
          canRecover: false,
          canRetry: true,
        },
      ],
    },
  };
  let resolve;
  const ui = harness(
    "components/AiXhsNotePanel.tsx",
    { open: true, embedded: true, onOpenChange() {} },
    {
      get: (url) => (url.endsWith("/jobs") ? [job] : job),
      post: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
  );
  let tree = await deliverXhs(ui, job.id);
  all(tree, (node) => node.props?.["aria-label"] === "正文")[0].props.onChange({
    target: { value: "老板还没保存的修改稿" },
  });
  tree = ui.render();
  const recover = button(tree, "取回已生成图片");
  assert.equal(recover.props.disabled, false);
  assert.match(
    JSON.stringify(tree),
    /复用原任务，不重新生成；沿用原预授权核对结算/,
  );
  recover.props.onClick();
  recover.props.onClick();
  byName(tree, "Button")
    .find((node) =>
      JSON.stringify(node.props.children).includes("只重试失败的"),
    )
    .props.onClick();
  await tick();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].url, "/content/ai-xhs-note/jobs/88/recover-images");
  assert.deepEqual(ui.calls[0].body, { imageIds: ["cover", "scene"] });
  resolve({
    ...job,
    imageGeneration: { ...job.imageGeneration, status: "running" },
  });
  await tick();
  tree = ui.render();
  assert.equal(
    all(tree, (node) => node.props?.["aria-label"] === "正文")[0].props.value,
    "老板还没保存的修改稿",
  );
  assert.equal(byName(tree, "NativeEmployeeChat")[0].props.generating, true);
});

test("小红书未知结果不提供取回入口，派活受限不发送请求，关闭后旧取回回执不覆盖", async () => {
  const job = {
    id: 89,
    status: "success",
    output: {
      title: "原标题",
      body: "原文",
      tags: [],
      firstComment: "",
      imagePlan: [],
    },
    imageGeneration: {
      status: "failed",
      items: [
        {
          id: "scene",
          label: "场景",
          status: "failed",
          canRetry: false,
          canRecover: false,
        },
      ],
    },
  };
  let resolve;
  const props = { open: true, embedded: true, onOpenChange() {} };
  const ui = harness("components/AiXhsNotePanel.tsx", props, {
    get: (url) => (url.endsWith("/jobs") ? [job] : job),
    post: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  let tree = await deliverXhs(ui, job.id);
  assert.equal(button(tree, "取回已生成图片"), undefined);
  job.imageGeneration.items[0].canRecover = true;
  tree = ui.render({ ...props, canDispatch: false });
  const denied = button(tree, "取回已生成图片");
  assert.equal(denied.props.disabled, true);
  denied.props.onClick();
  await tick();
  assert.equal(ui.calls.length, 0);
  tree = ui.render(props);
  const cleanup = ui.startEffect("imageMutationEpoch");
  await tick();
  button(tree, "取回已生成图片").props.onClick();
  await tick();
  cleanup();
  resolve({
    ...job,
    imageGeneration: {
      status: "success",
      items: [
        {
          id: "scene",
          label: "晚到图片",
          status: "success",
          url: "/uploads/late-recovered.png",
        },
      ],
    },
  });
  await tick();
  tree = ui.render({ ...props, open: false });
  assert.equal(
    all(
      tree,
      (node) =>
        node.type === "img" && node.props.src === "/uploads/late-recovered.png",
    ).length,
    0,
  );
  assert.equal(
    all(tree, (node) => node.props?.["aria-label"] === "正文")[0].props.value,
    "原文",
  );
});

test("带货整单未完成时展示已取回原片段，保留真实时长与未结算状态而不冒称完整成片", async () => {
  const textOf = (value) =>
    Array.isArray(value)
      ? value.map(textOf).join("")
      : typeof value === "string" || typeof value === "number"
        ? String(value)
        : value && typeof value === "object"
          ? textOf(value.props?.children)
          : "";
  for (const status of ["失败", "处理中", "成功"]) {
    const ui = harness(
      "components/AiSalesVideoPanel.tsx",
      { ...videoProps, initialJobId: 91 },
      {
        get: (url) =>
          url.endsWith("/options")
            ? { ready: true }
            : {
                jobId: 91,
                status,
                billing: { state: "pending_reconciliation", heldCredits: 360 },
                salesVideo: {
                  voiceMode: "voiced",
                  audioMode: "provider_native",
                  stage: "video",
                  partialResults: [
                    {
                      index: 1,
                      durationSeconds: 15.04,
                      url: "/uploads/ai-sales-video/3/partial-1.mp4",
                      subtitlesBurnedIn: false,
                      audioSource: "provider_native",
                    },
                    {
                      index: 2,
                      durationSeconds: 15,
                      url: "https://provider.test/secret-signed-video.mp4",
                    },
                  ],
                },
              },
      },
    );
    const tree = await ui.mount();
    const gallery = all(
      tree,
      (node) => node.props?.["aria-label"] === "已取回的原始片段",
    )[0];
    if (status === "成功") {
      assert.equal(gallery, undefined);
      continue;
    }
    assert.match(textOf(gallery), /已取回第1段原始视频，完整成片尚未完成/);
    assert.match(textOf(gallery), /实际片长 15.04 秒/);
    assert.match(textOf(gallery), /尚未添加本地字幕/);
    assert.match(textOf(gallery), /不会自动重新付费生成/);
    assert.doesNotMatch(textOf(gallery), /30秒|已结账|结算完成/);
    const videos = all(gallery, (node) => node.type === "video");
    assert.equal(videos.length, 1);
    assert.equal(
      videos[0].props.src,
      "/uploads/ai-sales-video/3/partial-1.mp4",
    );
    assert.equal(videos[0].props.controls, true);
    assert.doesNotMatch(JSON.stringify(gallery), /provider.test/);
    assert.equal(
      ui.calls.some((call) => call.method === "POST"),
      false,
    );
  }
});

test("两个专岗重开工作台保留完成与失败历史，且只展示各自任务", async () => {
  const videoUi = harness("components/AiSalesVideoPanel.tsx", videoProps, {
    get: (url) => {
      if (url.endsWith("/options")) return { ready: true };
      if (url.includes("/media-jobs?kind=video"))
        return [
          {
            id: 31,
            status: "成功",
            prompt: "招牌毛肚15秒带货视频",
            created_at: "2026-09-06 12:00:00",
            content_employee_idx: 10,
          },
          {
            id: 30,
            status: "失败",
            prompt: "上一条失败视频",
            created_at: "2026-09-06 11:00:00",
            content_employee_idx: 10,
          },
          {
            id: 29,
            status: "成功",
            prompt: "其他视频员工",
            content_employee_idx: 3,
          },
        ];
      return {};
    },
  });
  let tree = await videoUi.mount();
  let history = byName(tree, "SpecialistTaskHistory")[0];
  assert.equal(history.props.title, "带货视频生成历史");
  assert.deepEqual(
    history.props.rows.map((row) => [row.kind, row.id, row.status]),
    [
      ["media", 31, "成功"],
      ["media", 30, "失败"],
    ],
  );

  const xhsJobs = [
    {
      id: 41,
      status: "success",
      brandName: "山禾小馆",
      brief: "毛肚新品种草",
      createdAt: "2026-09-06T12:10:00Z",
      decision: "pending",
      output: {
        title: "毛肚上桌",
        body: "正文",
        tags: ["火锅"],
        firstComment: "首评",
        imagePlan: [],
      },
    },
    {
      id: 40,
      status: "failed",
      brandName: "山禾小馆",
      brief: "失败记录",
      createdAt: "2026-09-06T11:10:00Z",
      decision: "pending",
    },
  ];
  const xhsUi = harness(
    "components/AiXhsNotePanel.tsx",
    { open: true, embedded: true, onOpenChange() {} },
    {
      get: (url) => (url.endsWith("/jobs") ? { jobs: xhsJobs } : xhsJobs[0]),
      post: (url, body) => ({ ...xhsJobs[0], decision: body.decision }),
    },
  );
  tree = await xhsUi.mount();
  history = byName(tree, "SpecialistTaskHistory")[0];
  assert.equal(history.props.title, "小红书图文生成历史");
  assert.deepEqual(
    history.props.rows.map((row) => [row.kind, row.id, row.status]),
    [
      ["generated_content", 41, "success"],
      ["generated_content", 40, "failed"],
    ],
  );
  xhsUi.calls.splice(0);
  await history.props.onBusinessDecision(history.props.rows[0], "adopt");
  assert.equal(xhsUi.calls[0].url, "/content/ai-xhs-note/jobs/41/decision");
  assert.equal(xhsUi.calls[0].body.decision, "adopted");
  assert.equal(xhsUi.calls[0].body.output.title, "毛肚上桌");
});

test("专岗历史展开后才加载详情，带货结果在原页面直接显示反馈入口", async () => {
  const detail = {
    kind: "media",
    id: 51,
    input: "生成一条15秒带货视频",
    output: "中文口播稿",
    resultVersion: { inputHash: "input", outputHash: "output" },
    feedbackAvailability: { available: true },
  };
  const ui = harness(
    "components/SpecialistTaskHistory.tsx",
    {
      title: "带货视频生成历史",
      rows: [
        {
          kind: "media",
          id: 51,
          title: "毛肚带货视频",
          inputSummary: "15秒自然口播",
          status: "成功",
          active: false,
        },
      ],
    },
    { get: () => detail },
  );
  const row = {
    kind: "media",
    id: 51,
    title: "毛肚带货视频",
    inputSummary: "15秒自然口播",
    status: "成功",
    active: false,
  };
  let tree = ui.renderExport("HistoryItem", { row });
  assert.equal(ui.calls.length, 0);
  const disclosure = all(tree, (node) => node.type === "details")[0];
  disclosure.props.onToggle({ currentTarget: { open: true } });
  await tick();
  tree = ui.renderExport("HistoryItem", { row });
  assert.deepEqual(
    ui.calls.map((call) => call.url),
    ["/task-center/media/51"],
  );
  assert.equal(byName(tree, "TaskFeedback")[0].props.task.id, 51);
  assert.equal(
    byName(tree, "Markdown")[0].props.content,
    "生成一条15秒带货视频",
  );
  all(tree, (node) => node.type === "details")[0].props.onToggle({
    currentTarget: { open: false },
  });
  tree = ui.renderExport("HistoryItem", { row });
  assert.equal(
    all(tree, (node) => node.type === "details")[0].props.open,
    false,
  );
  assert.equal(ui.calls.length, 1);
});

test("小红书采纳先保存业务选择，再按最新结果版本记录员工经验", async () => {
  const sequence = [];
  const latest = {
    kind: "generated_content",
    id: 61,
    input: "新品种草",
    output: "正文",
    resultVersion: { inputHash: "latest-input", outputHash: "latest-output" },
    feedbackAvailability: { available: true },
  };
  const row = {
    kind: "generated_content",
    id: 61,
    title: "新品种草",
    inputSummary: "山禾小馆 · 新品种草",
    status: "success",
    active: true,
    businessDecision: "pending",
  };
  const onBusinessDecision = async () => {
    sequence.push("business");
  };
  let updatedTask = latest;
  const onTaskUpdated = (task) => {
    updatedTask = task;
  };
  const ui = harness(
    "components/SpecialistTaskHistory.tsx",
    { row, task: latest, onTaskUpdated, onBusinessDecision },
    {
      get: () => {
        sequence.push("detail");
        return latest;
      },
      post: (_url, body) => {
        sequence.push("feedback");
        return {
          ok: true,
          task: {
            ...latest,
            feedback: { decision: body.decision, currentVersion: true },
            feedbackAvailability: { available: false },
          },
        };
      },
    },
  );
  let tree = ui.renderExport("XhsTaskFeedback");
  button(tree, "采纳这份结果").props.onClick();
  await tick();
  await tick();
  tree = ui.renderExport("XhsTaskFeedback", {
    row,
    task: updatedTask,
    onTaskUpdated,
    onBusinessDecision,
  });
  assert.deepEqual(sequence, ["business", "detail", "feedback"]);
  assert.deepEqual(
    ui.calls.map((call) => [call.method, call.url]),
    [
      ["GET", "/task-center/generated_content/61"],
      ["POST", "/task-center/generated_content/61/feedback"],
    ],
  );
  assert.deepEqual(ui.calls[1].body.resultVersion, latest.resultVersion);
  assert.equal(
    byName(tree, "Tag").some((node) => node.props.children === "已采纳"),
    true,
  );
});

test("小红书业务采纳已保存但经验记录失败时可单独重试且不重复采纳", async () => {
  const latest = {
    kind: "generated_content",
    id: 62,
    input: "晚市套餐种草",
    output: "正文",
    resultVersion: { inputHash: "input-62", outputHash: "output-62" },
    feedbackAvailability: { available: true },
  };
  const row = {
    kind: "generated_content",
    id: 62,
    title: "晚市套餐种草",
    inputSummary: "山禾小馆 · 晚市套餐",
    status: "success",
    businessDecision: "pending",
  };
  let businessCalls = 0;
  let feedbackCalls = 0;
  let updatedTask = latest;
  const requestKeys = [];
  const onBusinessDecision = async () => {
    businessCalls += 1;
  };
  const onTaskUpdated = (task) => {
    updatedTask = task;
  };
  const ui = harness(
    "components/SpecialistTaskHistory.tsx",
    { row, task: latest, onTaskUpdated, onBusinessDecision },
    {
      get: () => latest,
      post: (_url, body) => {
        feedbackCalls += 1;
        requestKeys.push(body.requestKey);
        if (feedbackCalls === 1) throw new Error("经验服务暂时不可用");
        return {
          ok: true,
          task: {
            ...latest,
            feedback: { decision: body.decision, currentVersion: true },
            feedbackAvailability: { available: false },
          },
        };
      },
    },
  );
  let tree = ui.renderExport("XhsTaskFeedback");
  button(tree, "采纳这份结果").props.onClick();
  await tick();
  await tick();
  tree = ui.renderExport("XhsTaskFeedback", {
    row,
    task: updatedTask,
    onTaskUpdated,
    onBusinessDecision,
  });
  assert.equal(businessCalls, 1);
  assert.match(
    byName(tree, "Alert")[0].props.message,
    /采纳状态已保存.*经验记录尚未完成/,
  );
  byName(tree, "Alert")[0].props.action.props.onClick();
  await tick();
  await tick();
  tree = ui.renderExport("XhsTaskFeedback", {
    row,
    task: updatedTask,
    onTaskUpdated,
    onBusinessDecision,
  });
  assert.equal(businessCalls, 1);
  assert.equal(feedbackCalls, 2);
  assert.equal(requestKeys[0], requestKeys[1]);
  assert.equal(
    byName(tree, "Tag").some((node) => node.props.children === "已采纳"),
    true,
  );
});

test("测试员带货报价和小红书账单使用个人API费用，不展示平台积分预占", async () => {
  const user = { accountType: "tester", role: "boss" };
  const video = harness("components/AiSalesVideoPanel.tsx", videoProps, {
    user, get: () => ({ ready: true, durationSeconds: 15, estimatedMaxCredits: 330 }),
  });
  const videoTree = await video.mount();
  const quote = byName(videoTree, "NativeEmployeeChat")[0].props.mediaQuote;
  assert.match(quote, /API Key.*供应商账户扣除/);
  assert.doesNotMatch(quote, /330|积分|预占|余额不足/);
  const job = { id: 120, status: "success", decision: "pending", brandName: "测试店", output: { title: "测试结果", body: "真实存储结果", tags: [], firstComment: "", imagePlan: [] },
    files: [], fileIds: [], billing: { state: "settled", chargedCredits: 0, costYuan: 0.125 } };
  const xhs = harness("components/AiXhsNotePanel.tsx", { open: true, embedded: true, onOpenChange() {} }, {
    user, get: url => url.endsWith("/jobs") ? [job] : job,
  });
  const xhsTree = await deliverXhs(xhs, job.id);
  const visible = all(xhsTree, node => node.props?.className === "ai-xhs-note-billing").map(node => JSON.stringify(node.props.children)).join(" ");
  assert.match(visible, /个人API计费.*0\.1250/);
  assert.doesNotMatch(visible, /文案费用：0|积分|预授权/);
});
