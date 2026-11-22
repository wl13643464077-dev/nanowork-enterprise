import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const requireWeb = createRequire(
  new URL("../../web/package.json", import.meta.url),
);
const ts = requireWeb("typescript");
const read = (file) =>
  readFileSync(new URL(`../../web/src/${file}`, import.meta.url), "utf8");
const source = read("components/DashboardRoleHeader.tsx");
const exports = {};
const element = (type, props) => ({ type, props });
vm.runInNewContext(
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText,
  {
    exports,
    require(name) {
      if (name.endsWith(".css")) return {};
      if (name === "antd") return { Row: "Row", Col: "Col" };
      if (name === "react/jsx-runtime")
        return { jsx: element, jsxs: element, Fragment: "Fragment" };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  },
);

function buttons(node, found = []) {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    node.forEach((child) => buttons(child, found));
    return found;
  }
  if (node.type === "button") found.push(node);
  buttons(node.props?.children, found);
  return found;
}

test("老板空首页只有三个结果入口，点击直接导航且不提交任务", () => {
  const guide = exports.buildDashboardGuide("boss", [
    "advisor",
    "content",
    "execution",
    "growth",
    "marshals",
    "activities",
    "analysis",
    "system",
  ]);
  assert.deepEqual(
    Array.from(guide, (item) => item.to),
    ["/advisor", "/content?task=ai-sales-video", "/content?task=ai-xhs-note"],
  );
  assert.deepEqual(
    Array.from(guide, (item) => item.title),
    ["获得经营建议", "生成带货视频", "生成小红书图文"],
  );
  const destinations = [];
  const tree = exports.default({
    role: "boss",
    isEmpty: true,
    guide,
    summary: "",
    onNavigate: (to) => destinations.push(to),
  });
  const actions = buttons(tree);
  assert.equal(actions.length, 3);
  for (const action of actions) action.props.onClick();
  assert.deepEqual(destinations, [
    "/advisor",
    "/content?task=ai-sales-video",
    "/content?task=ai-xhs-note",
  ]);
  assert.doesNotMatch(source, /充值积分|按下面.*步|跟着引导完成第一轮/u);
});

test("结果入口按真实模块授权过滤，未知角色和平台超管不能进入企业快捷入口", () => {
  for (const role of [
    "boss",
    "ops_director",
    "manager",
    "sales",
    "partner",
    "admin",
  ]) {
    assert.deepEqual(
      Array.from(
        exports.buildDashboardGuide(role, ["advisor"]),
        (item) => item.to,
      ),
      ["/advisor"],
    );
    assert.deepEqual(
      Array.from(
        exports.buildDashboardGuide(role, ["content"]),
        (item) => item.to,
      ),
      ["/content?task=ai-sales-video", "/content?task=ai-xhs-note"],
    );
    assert.equal(
      exports.buildDashboardGuide(role, ["dashboard", "system", "execution"])
        .length,
      0,
    );
  }
  for (const role of [undefined, "", "unknown", "platform_super"]) {
    assert.equal(
      exports.buildDashboardGuide(role, ["advisor", "content"]).length,
      0,
    );
  }
  assert.equal(
    buttons(
      exports.default({
        role: "boss",
        isEmpty: true,
        guide: [],
        summary: "",
        onNavigate() {},
      }),
    ).length,
    0,
  );
  assert.equal(
    buttons(
      exports.default({
        role: "boss",
        isEmpty: false,
        guide: exports.buildDashboardGuide("boss", ["advisor"]),
        summary: "",
        onNavigate() {},
      }),
    ).length,
    0,
  );
});

test("自定义工作流保留员工页入口、原路由与模块权限，主导航合并高亮", () => {
  const layout = read("layouts/MainLayout.tsx");
  const employees = read("pages/Employees.tsx");
  const app = read("App.tsx");
  const menus = layout.match(/const MENUS = \[([\s\S]*?)\n\];/)[1];
  assert.doesNotMatch(menus, /key: '\/agents'/);
  assert.match(layout, /if \(pathname === '\/agents'\) return '\/employees'/);
  assert.match(
    employees,
    /<Link to="\/agents"[\s\S]*?自定义员工 \/ 导入工作流\s*<\/Link>/,
  );
  assert.match(
    app,
    /path="\/agents"[\s\S]*?<ModuleOnly moduleKey="marshals">[\s\S]*?<Agents \/>/,
  );
});

test("员工无匹配时一键清除全部筛选，包括隐藏的introCheck，并保留任务深链", () => {
  const employees = read("pages/Employees.tsx");
  const body = employees.match(
    /const clearFilters = \(\) => \{([\s\S]*?)\n  \};/,
  )[1];
  const changes = {};
  vm.runInNewContext(`(() => {${body}})()`, {
    URLSearchParams,
    params: new URLSearchParams(
      "q=毛利&group=错误分部&status=执行中&introCheck=needs_review&employee=101&task=12",
    ),
    setKeyword: (value) => {
      changes.keyword = value;
    },
    setDebouncedKeyword: (value) => {
      changes.debouncedKeyword = value;
    },
    setGroup: (value) => {
      changes.group = value;
    },
    setStatusFilter: (value) => {
      changes.status = value;
    },
    setParams: (value) => {
      changes.query = value.toString();
    },
  });
  assert.deepEqual(changes, {
    keyword: "",
    debouncedKeyword: "",
    group: "全部分部",
    status: "",
    query: "employee=101&task=12",
  });
  assert.match(
    employees,
    /<Empty className="employee-empty"[\s\S]*?<Button onClick=\{clearFilters\}>/,
  );
  assert.match(employees, /introReviewOnly &&[\s\S]*?onClick=\{clearFilters\}/);
});

test("工具箱自动化默认收起且在单次运行之后，展开动作不保存、启用或执行规则", () => {
  const toolbox = read("pages/Toolbox.tsx");
  assert.match(
    toolbox,
    /expandedAutomationKey, setExpandedAutomationKey\] = useState<ToolboxAutomationKey \| null>\(null\)/,
  );
  assert.match(
    toolbox,
    /<\/Form>[\s\S]*?<details[\s\S]*?open=\{automationExpanded\}/,
  );
  assert.match(toolbox, /\{automationExpanded && automationPanel\}/);
  const toggle = toolbox.match(/onToggle=\{([\s\S]*?)\n\s*style=/)[1];
  assert.match(toggle, /setExpandedAutomationKey/);
  assert.doesNotMatch(
    toggle,
    /api\.|persistAutomationConfig|toggleAutomation|runAutomationNow/,
  );
  assert.match(toolbox, /automationConfig\?\.enabled[\s\S]*?已启用/);
  const poll = toolbox.match(
    /const loadRuns = useCallback\(([\s\S]*?)\n  useEffect/,
  )[1];
  assert.doesNotMatch(poll, /loadAutomations/);
  assert.match(
    toolbox,
    /if \(!automationKey\) return undefined;[\s\S]*?loadAutomations\(\)/,
  );
});
