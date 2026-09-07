import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const requireWeb = createRequire(
  new URL("../../web/package.json", import.meta.url),
);
const ts = requireWeb("typescript");
const read = (file) =>
  fs.readFileSync(new URL(`../../web/src/${file}`, import.meta.url), "utf8");
const component = (name) =>
  Object.assign(function Mock() {}, { displayName: name });
const jsx = (type, props) => ({ type, props });
function load(file, dependencies = {}) {
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
      if (name === "react/jsx-runtime")
        return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "./seatRequestModel") return model;
      if (name === "./SeatRequestPanel")
        return { SeatQuota: component("SeatQuota") };
      if (name === "@ant-design/icons")
        return { ReloadOutlined: component("ReloadOutlined") };
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected import: ${name}`);
    },
    module,
    module.exports,
  );
  return module.exports;
}
const model = load("components/seatRequestModel.ts");
function nodes(tree, predicate, found = []) {
  if (Array.isArray(tree)) {
    tree.forEach((node) => nodes(node, predicate, found));
    return found;
  }
  if (!tree || typeof tree !== "object") return found;
  if (predicate(tree)) found.push(tree);
  nodes(tree.props?.children, predicate, found);
  return found;
}
const byName = (tree, name) =>
  nodes(tree, (node) => node.type?.displayName === name);
const button = (tree, label) =>
  byName(tree, "Button").find((node) => node.props.children === label);
const strings = (tree) =>
  JSON.stringify(tree, (key, value) =>
    typeof value === "function" ? undefined : value,
  );
const tick = () => new Promise((resolve) => setImmediate(resolve));
const baseSummary = {
  primaryAccount: {
    id: 7,
    username: "owner",
    name: "主负责人",
    role: "boss",
    status: "启用",
  },
  primaryAssignmentRequired: false,
  includedPrimarySeats: 1,
  includedSubSeats: 4,
  purchasedExtraSeats: 0,
  legacyExtraSeats: 0,
  seatLimit: 5,
  seatsUsed: 5,
  subSeatLimit: 4,
  subSeatsUsed: 4,
  availableSubSeats: 0,
  canRequestAdditionalSeats: true,
};
const baseRequest = {
  id: 12,
  tenantId: 4,
  tenantName: "山禾餐厅",
  requestedByName: "主负责人",
  additionalSeats: 3,
  reason: "新店成员",
  status: "requested",
  amountFen: null,
  orderId: null,
  createdAt: "2026-09-05T00:00:00Z",
};
function harness(file, initial, exported = "default", props = {}) {
  let cursor = 0;
  const state = [],
    effects = [],
    calls = [],
    pending = [];
  let response = initial;
  const form = {
    values: {},
    resetFields() {
      this.values = {};
    },
    async validateFields() {
      return this.values;
    },
  };
  const Form = component("Form");
  Form.Item = component("Form.Item");
  Form.useForm = () => [form];
  const Input = component("Input");
  Input.TextArea = component("Input.TextArea");
  const ant = new Proxy(
    { Form, Input },
    {
      get(target, key) {
        return (target[key] ||= component(String(key)));
      },
    },
  );
  const api = {
    async get(url) {
      calls.push({ method: "GET", url });
      if (response instanceof Error) throw response;
      return typeof response === "function" ? response(url) : response;
    },
    post(url, body) {
      calls.push({ method: "POST", url, body });
      return new Promise((resolve, reject) =>
        pending.push({ resolve, reject }),
      );
    },
  };
  const hooks = {
    useState(initialValue) {
      const index = cursor++;
      if (!(index in state))
        state[index] =
          typeof initialValue === "function" ? initialValue() : initialValue;
      return [
        state[index],
        (value) => {
          state[index] =
            typeof value === "function" ? value(state[index]) : value;
        },
      ];
    },
    useRef(value) {
      const index = cursor++;
      return (state[index] ||= { current: value });
    },
    useCallback(fn) {
      return fn;
    },
    useEffect(fn) {
      effects.push(fn);
    },
  };
  const Component = load(file, {
    react: hooks,
    antd: ant,
    "../api/client": { api },
  })[exported];
  return {
    calls,
    pending,
    form,
    setResponse(value) {
      response = value;
    },
    render() {
      cursor = 0;
      return Component(props);
    },
    async mount() {
      this.render();
      globalThis.requestAnimationFrame = (fn) => {
        fn();
        return 1;
      };
      globalThis.cancelAnimationFrame = () => {};
      effects.splice(0).forEach((effect) => effect());
      await tick();
      return this.render();
    },
  };
}

test("报价无默认价，精确转分；收款仅使用已冻结订单且必须有凭据", () => {
  for (const amount of [undefined, null, 0, -1, 1.001, NaN, Infinity])
    assert.throws(() => model.seatQuotePayload(amount));
  assert.deepEqual(model.seatQuotePayload(329.99, " 商定价格 "), {
    amountFen: 32999,
    note: "商定价格",
  });
  assert.throws(() => model.seatPaymentPayload(baseRequest, "bank-1"));
  const quoted = {
    ...baseRequest,
    status: "quoted",
    orderId: 45,
    amountFen: 32999,
  };
  assert.throws(() => model.seatPaymentPayload(quoted, " "));
  assert.deepEqual(model.seatPaymentPayload(quoted, " bank-1 "), {
    paymentReference: "bank-1",
  });
  assert.equal(model.seatAmount(null), "待平台报价");
  assert.equal(model.seatAmount(32999), "¥329.99");
});

test("额度未读取/读取失败不写不限，副管理员可看额度但没有申请或取消按钮", async () => {
  const failed = harness(
    "components/SeatRequestPanel.tsx",
    new Error("网络未连接"),
  );
  assert.doesNotMatch(strings(failed.render()), /存量不限额|副账号已用/);
  const failedTree = await failed.mount();
  assert.match(strings(failedTree), /网络未连接/);
  assert.equal(button(failedTree, "提交扩容申请"), undefined);
  const sub = harness("components/SeatRequestPanel.tsx", {
    items: [baseRequest],
    summary: { ...baseSummary, canRequestAdditionalSeats: false },
  });
  const tree = await sub.mount();
  assert.equal(button(tree, "提交扩容申请"), undefined);
  assert.equal(byName(tree, "Popconfirm").length, 0);
  assert.match(strings(tree), /仅主账号可提交或取消/);
  assert.equal(sub.calls.filter((call) => call.method === "POST").length, 0);
});

test("主账号提交真实数量且快速重复点击只创建一次，成功不提前声称增加额度", async () => {
  const ui = harness("components/SeatRequestPanel.tsx", {
    items: [],
    summary: baseSummary,
  });
  let tree = await ui.mount();
  const submit = byName(tree, "Form")[0].props.onFinish;
  const first = submit({ additionalSeats: 3, reason: " 新店 " });
  await submit({ additionalSeats: 3, reason: "重复" });
  assert.deepEqual(ui.calls.at(-1), {
    method: "POST",
    url: "/admin/seat-requests",
    body: { additionalSeats: 3, reason: "新店" },
  });
  assert.equal(ui.pending.length, 1);
  ui.setResponse({ items: [baseRequest], summary: baseSummary });
  ui.pending[0].resolve({ request: baseRequest, summary: baseSummary });
  await first;
  tree = ui.render();
  assert.equal(button(tree, "提交扩容申请"), undefined);
  assert.match(strings(tree), /尚未增加额度/);
  assert.equal(byName(tree, "Popconfirm").length, 1);
});

test("主账号取消开放申请使用专用接口，主账号待确认不猜测身份", async () => {
  const ui = harness("components/SeatRequestPanel.tsx", {
    items: [baseRequest],
    summary: baseSummary,
  });
  let tree = await ui.mount();
  const pending = byName(tree, "Popconfirm")[0].props.onConfirm();
  assert.equal(ui.calls.at(-1).url, "/admin/seat-requests/12/cancel");
  ui.setResponse({
    items: [{ ...baseRequest, status: "cancelled" }],
    summary: baseSummary,
  });
  ui.pending[0].resolve({
    request: { ...baseRequest, status: "cancelled" },
    summary: baseSummary,
  });
  await pending;
  tree = ui.render();
  assert.match(strings(tree), /额度未变更/);
  assert.ok(button(tree, "提交扩容申请"));
  const unassigned = harness("components/SeatRequestPanel.tsx", {
    items: [],
    summary: {
      ...baseSummary,
      primaryAccount: null,
      primaryAssignmentRequired: true,
      canRequestAdditionalSeats: false,
    },
  });
  const unassignedTree = await unassigned.mount();
  assert.match(strings(unassignedTree), /请联系平台确认本企业主账号/);
  assert.equal(button(unassignedTree, "提交扩容申请"), undefined);
});

test("平台实际组件报价提交正金额到申请，不调用充值确认，不设置默认价格", async () => {
  const ui = harness(
    "components/PlatformSeatRequests.tsx",
    { items: [baseRequest], summary: null },
    "default",
    { tenants: [{ id: 4, name: "山禾餐厅" }] },
  );
  let tree = await ui.mount();
  button(tree, "填写报价").props.onClick();
  tree = ui.render();
  assert.equal(ui.form.values.amountYuan, undefined);
  ui.form.values = { amountYuan: 329.99, note: "约定总价" };
  byName(tree, "Modal")[0].props.onOk();
  await tick();
  assert.deepEqual(ui.calls.at(-1), {
    method: "POST",
    url: "/platform/seat-requests/12/quote",
    body: { amountFen: 32999, note: "约定总价" },
  });
  const quoted = {
    ...baseRequest,
    status: "quoted",
    amountFen: 32999,
    orderId: 45,
    orderNo: "S-45",
  };
  ui.setResponse({ items: [quoted], summary: null });
  ui.pending[0].resolve({ request: quoted, summary: baseSummary });
  await tick();
  tree = ui.render();
  assert.match(strings(tree), /¥329.99/);
  assert.match(strings(tree), /等待确认收款，尚未增加额度/);
  assert.equal(
    ui.calls.filter((call) => call.url.includes("/confirm")).length,
    0,
  );
});

test("平台确认对应同一冻结订单，凭据必填；回执失败不展示成功或虚增额度", async () => {
  const quoted = {
    ...baseRequest,
    status: "quoted",
    amountFen: 32999,
    orderId: 45,
    orderNo: "S-45",
  };
  const ui = harness(
    "components/PlatformSeatRequests.tsx",
    { items: [quoted], summary: null },
    "default",
    { tenants: [] },
  );
  let tree = await ui.mount();
  button(tree, "确认收款并开通").props.onClick();
  tree = ui.render();
  ui.form.values = { paymentReference: " " };
  byName(tree, "Modal")[0].props.onOk();
  await tick();
  assert.equal(ui.pending.length, 0);
  ui.form.values = { paymentReference: " bank-20260905 " };
  tree = ui.render();
  byName(tree, "Modal")[0].props.onOk();
  await tick();
  assert.deepEqual(ui.calls.at(-1), {
    method: "POST",
    url: "/platform/recharge-orders/45/confirm",
    body: { paymentReference: "bank-20260905" },
  });
  ui.pending[0].reject(new Error("确认请求断开，请核对订单"));
  await tick();
  tree = ui.render();
  assert.match(strings(tree), /确认请求断开/);
  assert.equal(
    byName(tree, "Alert").filter((node) => node.props.type === "success")
      .length,
    0,
  );
  byName(tree, "Modal")[0].props.onOk();
  await tick();
  assert.equal(ui.calls.at(-1).url, "/platform/recharge-orders/45/confirm");
  ui.setResponse({ items: [{ ...quoted, status: "applied" }], summary: null });
  ui.pending[1].resolve({
    ok: true,
    duplicated: true,
    seatRequest: { ...quoted, status: "applied" },
    seatSummary: {
      ...baseSummary,
      purchasedExtraSeats: 3,
      seatLimit: 8,
      subSeatLimit: 7,
      availableSubSeats: 3,
    },
  });
  await tick();
  tree = ui.render();
  assert.match(strings(tree), /此前已完成.*¥329.99.*3 个副账号已开通.*8 个/);
  assert.match(strings(tree), /未赠送积分/);
});

test("平台主账号只选本企业已启用老板，多个候选不默认猜选", async () => {
  const summary = {
    ...baseSummary,
    primaryAccount: null,
    primaryAssignmentRequired: true,
    canRequestAdditionalSeats: false,
  };
  const ui = harness(
    "components/PlatformSeatRequests.tsx",
    (url) =>
      url.includes("seat-requests")
        ? { items: [], summary }
        : {
            users: [
              {
                id: 7,
                name: "候选一",
                username: "one",
                role: "boss",
                status: "启用",
              },
              {
                id: 8,
                name: "候选二",
                username: "two",
                role: "boss",
                status: "启用",
              },
              {
                id: 9,
                name: "停用",
                username: "off",
                role: "boss",
                status: "停用",
              },
              {
                id: 10,
                name: "管理员",
                username: "admin",
                role: "admin",
                status: "启用",
              },
            ],
          },
    "PrimaryAccountBinding",
    { tenantId: 4 },
  );
  let tree = await ui.mount();
  const select = byName(tree, "Select")[0];
  assert.deepEqual(
    select.props.options.map((item) => item.value),
    [7, 8],
  );
  assert.equal(select.props.value, undefined);
  assert.equal(button(tree, "确认绑定主账号").props.disabled, true);
  select.props.onChange(8);
  tree = ui.render();
  button(tree, "确认绑定主账号").props.onClick();
  assert.deepEqual(ui.calls.at(-1), {
    method: "POST",
    url: "/platform/tenants/4/primary-account",
    body: { userId: 8 },
  });
  ui.pending[0].reject(new Error("账号已停用"));
  await tick();
  assert.equal(
    byName(ui.render(), "Alert").filter((node) => node.props.type === "success")
      .length,
    0,
  );
});

test("套餐席位描述区分新基础包与历史记录，企业表不把已建人数当作启用占用", () => {
  assert.equal(model.planSeatDescription(5), "1 个主账号 + 4 个副账号");
  for (const seats of [2, 20, 50]) {
    const label = model.planSeatDescription(seats);
    assert.match(label, new RegExp(`历史套餐记录 ${seats} 个账号`));
    assert.match(label, /企业额度保持不变，扩容另申请/);
    assert.doesNotMatch(label, /含 \d+ 个账号/);
  }
  assert.equal(
    model.planSeatDescription(undefined),
    "企业额度保持不变，扩容另申请",
  );
  const platform = read("pages/Platform.tsx"),
    recharge = read("pages/Recharge.tsx");
  assert.match(platform, /planSeatDescription\(p\.seat_limit\)/);
  assert.match(recharge, /planSeatDescription\(p\.seat_limit\)/);
  assert.match(platform, /已建账号 \{r\.user_count \?\? '待读取'\}/);
  assert.match(platform, /席位额度/);
  assert.match(platform, /r\.seat_limit === null \? '不限'/);
  assert.doesNotMatch(platform, /r\.user_count >=/);
});

test("入口保留原充值功能，席位扩容去专用流程且移除直接额度修改", () => {
  const admin = read("pages/Admin.tsx"),
    platform = read("pages/Platform.tsx"),
    recharge = read("pages/Recharge.tsx"),
    invitations = read("components/InvitationManager.tsx");
  assert.match(admin, /<SeatRequestPanel refreshKey=\{seatRefresh\}/);
  assert.match(admin, /dataIndex: 'accountType'/);
  assert.match(admin, /disabled=\{editing\?\.accountType === 'primary'\}/);
  assert.doesNotMatch(
    platform,
    /name="seatLimit"|name="seat_limit"|seatLimit: t\.seat_limit/,
  );
  assert.match(
    platform,
    /pkgEdit\?\.kind === 'plan' \? pkgEdit\.seat_limit : 5/,
  );
  assert.match(
    platform,
    /o\.kind === 'seat_addon'[\s\S]{0,80}setTab\('席位申请'\)/,
  );
  assert.match(
    recharge,
    /r\.kind === 'seat_addon'[\s\S]{0,150}href="\/admin\?tab=users&seatRequest=1"/,
  );
  assert.doesNotMatch(recharge, /plan\?\.seatLimit \?\? '不限'/);
  assert.match(invitations, /均为副账号/);
  assert.match(invitations, /href="\/admin\?tab=users&seatRequest=1"/);
});
