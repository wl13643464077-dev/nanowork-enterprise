import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(serverDir, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('新项目默认端口在后端、开发代理、环境模板和 README 中一致', () => {
  assert.match(read('server/src/index.js'), /const PORT = process\.env\.PORT \|\| 3107;/);
  assert.match(read('web/vite.config.ts'), /http:\/\/127\.0\.0\.1:3107/);
  assert.match(read('server/.env.example'), /^NODE_ENV=development$/m);
  assert.match(read('server/.env.example'), /^HOST=127\.0\.0\.1$/m);
  assert.match(read('server/.env.example'), /^PORT=3107$/m);
  assert.match(read('README.md'), /http:\/\/127\.0\.0\.1:3107/);
});

test('生产 HTTP 装配可测试复用，启动副作用仍只保留在 index', () => {
  const app = read('server/src/app.js');
  const entry = read('server/src/index.js');
  assert.match(app, /export function createApp\(/);
  assert.match(entry, /const app = createApp\(\);/);
  assert.match(entry, /initSchema\(\);/);
  assert.match(entry, /recoverStaleAiWorkAcrossTenants\(\)/);
  assert.match(entry, /startSchedulerIfEnabled\(\{ runTick: runSchedulerTick \}\);/);
  assert.match(entry, /app\.listen\(PORT, HOST,/);
  assert.doesNotMatch(app, /\binitSchema\(\)|\bstartSchedulerIfEnabled\(|\bapp\.listen\(/);

  const rawCallback = app.indexOf("app.use('/api/recharge/notify', rechargeNotifyRoutes)");
  const jsonParser = app.indexOf("app.use(express.json({ limit: '32mb' }))");
  assert.ok(rawCallback >= 0 && jsonParser > rawCallback, '支付回调必须在全局 JSON 解析器之前挂载');
  assert.match(
    app,
    /app\.use\('\/api\/data-intake', authMiddleware, tenantScope, tenantGate, moduleGuard\('system'\), dataIntakeRoutes\)/,
  );
  assert.match(app, /throw new Error\(`未知模块守卫：\$\{moduleId\}`\)/);
});

test('环境模板不预置凭据，并列出公开 URL 与常用限流边界', () => {
  const env = read('server/.env.example');
  for (const key of ['YUNWU_API_KEY', 'ANTHROPIC_API_KEY', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET']) {
    assert.match(env, new RegExp(`^${key}=$`, 'm'), `${key} 必须默认留空`);
  }
  for (const key of [
    'PUBLIC_BASE_URL', 'APP_PUBLIC_URL', 'FEISHU_PUBLIC_BASE_URL',
    'LOGIN_ACCOUNT_MAX_FAILURES', 'LOGIN_IP_MAX_FAILURES', 'REGISTER_IP_MAX_ATTEMPTS',
    'AI_TENANT_RATE_PER_MINUTE', 'AI_TENANT_BURST', 'AI_MAX_CONCURRENT',
  ]) assert.match(env, new RegExp(`^${key}=`, 'm'), `${key} 必须在模板中明示`);
});

test('会话边界只使用 nanowork 命名，前端不从 localStorage 迁移会话', () => {
  const util = read('server/src/util.js');
  const auth = read('server/src/routes/auth.js');
  const client = read('web/src/api/client.ts');
  const foreignSessionName = ['shanmei', 'session'].join('_');
  const foreignTokenName = ['shanmei', 'token'].join('_');
  const foreignUserName = ['shanmei', 'user'].join('_');
  assert.match(util, /SESSION_COOKIE = 'nanowork_session'/);
  assert.equal(util.includes(foreignSessionName), false);
  assert.equal(auth.includes(foreignSessionName), false);
  assert.equal(client.includes(foreignTokenName), false);
  assert.equal(client.includes(foreignUserName), false);
  assert.doesNotMatch(client, /localStorage\.(getItem|setItem)/);
});

test('Paihuo 内容目录使用可移植相对来源并保留源 SHA', () => {
  const catalog = JSON.parse(read('server/catalog/content-crew.json'));
  assert.equal(catalog.source.referenceProject, '派活AI');
  assert.equal(catalog.source.referencePath, 'app/skills/registry.py');
  assert.equal(path.isAbsolute(catalog.source.referencePath), false);
  assert.equal(catalog.source.referenceSha256, '9663481bfb2a709209281c1eb356783f9d5b4047dc54124cfa27f3e4986237dc');
  assert.doesNotMatch(read('docs/内容生产仓.md'), /\/Users\//);
});

test('Paihuo 内容目录原始用户文案不残留发布版本标签，不依赖运行时遮盖', () => {
  const catalog = JSON.parse(read('server/catalog/content-crew.json'));
  const visibleText = [];
  const collectStrings = value => {
    if (typeof value === 'string') visibleText.push(value);
    else if (Array.isArray(value)) value.forEach(collectStrings);
    else if (value && typeof value === 'object') Object.values(value).forEach(collectStrings);
  };
  collectStrings(catalog);

  assert.doesNotMatch(visibleText.join('\n'), /\bV1(?:\.0)?\b|(?:产品|系统|发布)版本(?:号|标签)?/u);
  assert.doesNotMatch(read('server/src/catalog/content-crew.js'), /\.replaceAll\([^\n]*V1/u);
  assert.equal(catalog.schemaVersion, 'paihuo-content-crew.v2');
  const publisher = catalog.employees.find(employee => employee.idx === 8);
  assert.ok(publisher.outputKeys.includes('versions'));
  assert.match(publisher.outputSchema.contract, /"versions"/u);
});

test('内容审阅与返工的用户提示不暴露技术版本话术', () => {
  const visibleRuntimeMessages = [
    'web/src/data/contentFactoryConstants.tsx',
    'server/src/routes/content.js',
    'server/src/routes/content-employee-workbench.js',
    'server/src/routes/employee-outputs.js',
    'server/src/engines/delivery-state.js',
    'server/src/engines/restaurant-output-review.js',
    'server/src/engines/restaurant-output-contract.js',
  ].map(read).join('\n');

  assert.doesNotMatch(
    visibleRuntimeMessages,
    /(?:return\s+|error:\s+|failureReasons\.push\(|httpError\([^\n]*|description:\s+)[^\n]*版本/u,
  );
});

test('根包只做工作流编排，verify 包含租户隔离检查', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.scripts['check:isolation'], 'node scripts/check-isolation.mjs');
  assert.match(pkg.scripts.verify, /npm run check:isolation/);
  assert.deepEqual(Object.keys(lock.packages), ['']);
});

test('认证响应显式暴露安全的租户数据模式字段', () => {
  const auth = read('server/src/routes/auth.js');
  assert.equal(auth.match(/dataMode: tenant\.data_mode \?\? 'live'/g)?.length, 2);
});

test('核心界面不再展示演示横幅、旧驾驶舱名称或技术版本标签', () => {
  const visibleUi = [
    'web/src/layouts/MainLayout.tsx',
    'web/src/pages/Dashboard.tsx',
    'web/src/pages/ContentFactory.tsx',
    'web/src/pages/System.tsx',
    'web/src/pages/Toolbox.tsx',
    'web/src/components/EmployeeWorkbench.tsx',
    'web/src/components/EmployeeOutputInsights.tsx',
  ].map(read).join('\n');
  for (const forbidden of [
    '门店驾驶舱',
    '含合成演示数据',
    '不代表真实经营成效',
    'V1.0',
    'v1.0',
    '提示词修订标识',
    '岗位档案修订标识',
    '配置修订：',
    '来源修订',
    '修订号自动',
  ]) {
    assert.equal(visibleUi.includes(forbidden), false, `核心界面不得展示“${forbidden}”`);
  }
  assert.doesNotMatch(visibleUi, />v\{[^}]*version[^}]*\}</u);
});
