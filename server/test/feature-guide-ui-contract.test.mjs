import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

/**
 * 执行目录中的真实纯函数，而不是仅靠源码正则猜测权限结果。
 * catalog 不含 JSX，Node 22 可安全剥离其中的 TypeScript 类型后导入。
 */
const runCatalogProbe = (body) => {
  const catalogUrl = pathToFileURL(
    path.join(ROOT, "web/src/components/featureGuideCatalog.ts"),
  ).href;
  const script = `
    import {
      FEATURE_GUIDES,
      canAccessFeatureGuide,
      canAccessFeatureGuideContext,
      findFeatureGuide,
      resolveFeatureGuideContext
    } from ${JSON.stringify(catalogUrl)};
    const value = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(value));
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      script,
    ],
    { cwd: path.join(ROOT, "web"), encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `catalog probe failed:\n${result.stderr || result.stdout}`,
  );
  return JSON.parse(result.stdout);
};

test("功能使用指引覆盖真实业务路由和完整操作闭环", () => {
  const catalog = read("web/src/components/featureGuideCatalog.ts");
  const center = read("web/src/components/FeatureGuideCenter.tsx");

  for (const route of [
    "/",
    "/advisor",
    "/employees",
    "/tasks",
    "/execution",
    "/store-ops",
    "/reviews",
    "/activities",
    "/growth",
    "/content",
    "/toolbox",
    "/analysis",
    "/store-data",
    "/assets",
    "/system",
    "/recharge",
    "/admin",
    "/m",
  ]) {
    assert.ok(
      catalog.includes(`'${route}'`) || catalog.includes(`"${route}"`),
      `missing guide for ${route}`,
    );
  }

  assert.match(catalog, /aliases[\s\S]*\/marshals/);
  assert.match(catalog, /aliases[\s\S]*\/data-intake/);
  assert.match(center, /什么时候用/);
  assert.match(center, /准备什么/);
  assert.match(center, /怎么操作/);
  assert.match(center, /结果在哪里/);
  assert.match(center, /验收标准/);
  assert.match(center, /注意事项/);
});

test("findFeatureGuide 规范化查询、尾斜杠、子路径和历史别名", () => {
  const found = runCatalogProbe(`
    return [
      '/',
      '/employees?employee=101',
      '/employees/101/',
      '/marshals',
      '/data-intake?batch=3',
      '/system/?tab=data-intake',
      '/not-a-real-feature'
    ].map(path => [path, findFeatureGuide(path)?.id || null]);
  `);

  assert.deepEqual(found, [
    ["/", "dashboard"],
    ["/employees?employee=101", "employees"],
    ["/employees/101/", "employees"],
    ["/marshals", "employees"],
    ["/data-intake?batch=3", "system"],
    ["/system/?tab=data-intake", "system"],
    ["/not-a-real-feature", null],
  ]);
});

test("canAccessFeatureGuide 严格镜像 App 的模块与角色权限矩阵", () => {
  const matrix = runCatalogProbe(`
    const cases = [
      ['/toolbox', ['content'], 'sales'],
      ['/toolbox', ['dashboard'], 'boss'],
      ['/tasks', ['execution'], 'sales'],
      ['/tasks', ['content'], 'boss'],
      ['/store-ops', ['dashboard'], 'sales'],
      ['/reviews', ['dashboard'], 'partner'],
      ['/store-ops', ['execution'], 'boss'],
      ['/store-data', ['analysis'], 'boss'],
      ['/store-data', ['analysis'], 'ops_director'],
      ['/store-data', ['analysis'], 'manager'],
      ['/store-data', ['analysis'], 'admin'],
      ['/store-data', ['analysis'], 'sales'],
      ['/store-data', ['dashboard'], 'boss'],
      ['/recharge', [], 'boss'],
      ['/recharge', [], 'admin'],
      ['/admin', [], 'boss'],
      ['/admin', [], 'admin'],
      ['/admin', [], 'manager'],
      ['/m', [], 'sales'],
      ['/m', [], 'platform_super']
    ];
    return cases.map(([path, modules, role]) => {
      const guide = FEATURE_GUIDES.find(item => item.path === path);
      return [path, role, modules.join(','), canAccessFeatureGuide(guide, modules, role)];
    });
  `);

  assert.deepEqual(
    matrix.map((item) => item[3]),
    [
      true,
      false,
      true,
      false,
      true,
      true,
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      true,
      false,
      true,
      true,
      false,
      true,
      false,
    ],
  );
});

test("system 子页上下文按角色过滤，resolve 只覆盖当前上下文并保留基础六段内容", () => {
  const result = runCatalogProbe(`
    const system = FEATURE_GUIDES.find(item => item.id === 'system');
    const roles = ['boss', 'ops_director', 'manager', 'admin', 'sales'];
    const contextKeys = ['overview', 'data-intake', 'approvals', 'billing', 'kb', 'prompts', 'users', 'trash', 'config'];
    const matrix = Object.fromEntries(roles.map(role => [
      role,
      Object.fromEntries(contextKeys.map(key => [key, canAccessFeatureGuideContext(system, key, role)]))
    ]));
    const intake = resolveFeatureGuideContext(system, 'data-intake', 'boss');
    const billing = resolveFeatureGuideContext(system, 'billing', 'boss');
    const unknown = resolveFeatureGuideContext(system, 'does-not-exist', 'boss');
    return {
      matrix,
      intake: {
        title: intake.title,
        firstStep: intake.steps[0],
        acceptanceCount: intake.acceptance.length,
        preparationCount: intake.preparation.length
      },
      billing: {
        title: billing.title,
        inheritedPreparation: billing.preparation.join('|') === system.preparation.join('|'),
        inheritedResult: billing.resultLocation.join('|') === system.resultLocation.join('|')
      },
      unknownIsBase: unknown.title === system.title && unknown.steps.join('|') === system.steps.join('|')
    };
  `);

  assert.deepEqual(result.matrix.boss, {
    overview: true,
    "data-intake": true,
    approvals: true,
    billing: true,
    kb: true,
    prompts: true,
    users: true,
    trash: true,
    config: true,
  });
  assert.equal(result.matrix.ops_director["data-intake"], true);
  assert.equal(result.matrix.ops_director.billing, true);
  assert.equal(result.matrix.ops_director.prompts, false);
  assert.equal(result.matrix.manager["data-intake"], false);
  assert.equal(result.matrix.manager.approvals, true);
  assert.equal(result.matrix.manager.billing, false);
  assert.equal(result.matrix.sales.overview, true);
  assert.equal(result.matrix.sales.approvals, false);
  assert.equal(result.matrix.sales.prompts, false);
  assert.match(result.intake.title, /数据录入中枢/);
  assert.match(result.intake.firstStep, /上传/);
  assert.ok(result.intake.acceptanceCount > 0);
  assert.ok(result.intake.preparationCount > 0);
  assert.match(result.billing.title, /积分与用量/);
  assert.equal(result.billing.inheritedPreparation, true);
  assert.equal(result.billing.inheritedResult, true);
  assert.equal(result.unknownIsBase, true);
});

test("current/all 正文与 displayedGuide footer 一致，当前功能不显示重复导航", () => {
  const center = read("web/src/components/FeatureGuideCenter.tsx");

  assert.match(center, /type ViewMode = 'current' \| 'all'/);
  assert.match(center, /const displayedGuide\s*=/);
  assert.match(center, /value=\{mode\}/);
  assert.match(center, /当前功能/);
  assert.match(center, /全部功能/);
  assert.match(center, /displayedGuide\.id !== accessibleCurrent\?\.id/);
  assert.match(
    center,
    /mode === 'current'[\s\S]*<GuideDetail guide=\{accessibleCurrent\}/,
  );
  assert.match(
    center,
    /className="feature-guide-library-detail"[\s\S]*<GuideDetail[\s\S]*guide=\{selectedGuide\}/,
  );
  assert.match(center, /onClose\(\);[\s\S]*navigate\(displayedGuide\.path\)/);
});

test("搜索与分类可清空，重新打开抽屉不会继承上次筛选或越权选中项", () => {
  const center = read("web/src/components/FeatureGuideCenter.tsx");

  assert.match(center, /afterOpenChange=\{visible =>/);
  assert.match(center, /setQuery\(''\)/);
  assert.match(center, /setCategory\('all'\)/);
  assert.match(center, /allowClear/);
  assert.match(center, /aria-label="搜索功能使用指引"/);
  assert.match(
    center,
    /onChange=\{event => \{[\s\S]*setQuery\(event\.target\.value\)[\s\S]*setSelectedId\(''\)/,
  );
  assert.match(
    center,
    /onChange=\{value => \{[\s\S]*setCategory\(value\)[\s\S]*setSelectedId\(''\)/,
  );
  assert.match(center, /aliases[\s\S]*guide\.keywords/);
  assert.match(center, /没有匹配的功能/);
});

test("context 只作用于当前且有权访问的功能，不泄漏到全部功能中的其他详情", () => {
  const center = read("web/src/components/FeatureGuideCenter.tsx");
  const catalog = read("web/src/components/featureGuideCatalog.ts");

  assert.match(catalog, /export function canAccessFeatureGuideContext/);
  assert.match(catalog, /resolveFeatureGuideContext\([\s\S]*role\?: string/);
  assert.match(
    catalog,
    /canAccessFeatureGuideContext\(guide, resolvedKey, role\)/,
  );
  assert.match(center, /selectedGuide\.id === accessibleCurrent\?\.id/);
  assert.match(
    center,
    /contextKey=\{selectedGuide\.id === accessibleCurrent\?\.id \? resolvedContext : undefined\}/,
  );
  assert.match(center, /resolveFeatureGuideContext\(guide, contextKey, role\)/);
});

test("compact 使用底部抽屉，并在窄屏选择功能后滚动聚焦可读详情", () => {
  const center = read("web/src/components/FeatureGuideCenter.tsx");
  const css = read("web/src/components/FeatureGuideCenter.css");

  assert.match(center, /const isCompact = compact \|\| narrowViewport/);
  assert.match(center, /placement=\{isCompact \? 'bottom' : 'right'\}/);
  assert.match(center, /height=\{isCompact \? '94%' : undefined\}/);
  assert.match(center, /detailRef/);
  assert.match(center, /detailFocusRequest/);
  assert.match(center, /setDetailFocusRequest\(value => value \+ 1\)/);
  assert.match(center, /\[detailFocusRequest, mode, selectedGuide\]/);
  assert.match(center, /scrollIntoView\(/);
  assert.match(center, /\.focus\(/);
  assert.match(center, /ref=\{detailRef\}/);
  assert.match(center, /tabIndex=\{-1\}/);
  assert.match(center, /aria-live="polite"/);
  assert.match(center, /type="button"/);
  assert.match(center, /aria-current=/);
  assert.match(
    css,
    /feature-guide-drawer-root\.is-compact[\s\S]*ant-drawer-content-wrapper/,
  );
  assert.match(css, /feature-guide-library-detail:focus-visible/);
  assert.match(css, /env\(safe-area-inset-bottom/);
});

test("桌面、手机和管理后台均能重复打开功能指引", () => {
  const layout = read("web/src/layouts/MainLayout.tsx");
  const mobile = read("web/src/pages/Mobile.tsx");
  const admin = read("web/src/pages/Admin.tsx");

  assert.match(layout, /<FeatureGuideCenter/);
  assert.match(layout, /本页怎么用/);
  assert.match(layout, /打开功能使用指引/);
  assert.match(mobile, /<FeatureGuideCenter/);
  assert.match(mobile, /data-onboarding="help"/);
  assert.match(admin, /<FeatureGuideCenter/);
  assert.match(admin, /功能使用指引/);
});

test("功能指引是只读帮助，不触发业务提交", () => {
  const center = read("web/src/components/FeatureGuideCenter.tsx");

  assert.doesNotMatch(center, /api\.(post|put|patch|delete)/);
  assert.match(center, /不会替你提交/);
});
