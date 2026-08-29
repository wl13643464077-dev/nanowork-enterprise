import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const {
  COMMAND_PALETTE_RECONCILIATION_STATUS,
  COMMAND_PALETTE_UNVERIFIED_ADOPTION_STATUS,
  commandPaletteContentStatus,
} = await import('../../web/src/components/commandPaletteContentStatus.js');
const {
  activityCalendarSyncPresentation,
  dashboardFeishuPresentation,
  generatedArtifactStatusLabel,
  runtimeReadinessConfigLabel,
  runtimeReadinessMeta,
  runtimeReadinessVerificationLabel,
} = await import('../../web/src/components/statusPresentation.js');

test('CommandPalette优先权威delivery状态，缺失delivery时不把raw可使用冒充人工采纳', () => {
  assert.equal(commandPaletteContentStatus({
    status: '可使用',
    delivery: { displayStatus: '待人工审阅', canUse: false },
  }), '待人工审阅');
  assert.equal(commandPaletteContentStatus({
    status: '待审核',
    delivery: { displayStatus: '', canUse: true },
  }), '已人工采纳（可用于业务）');
  assert.equal(commandPaletteContentStatus({
    status: '可使用',
    delivery: { displayStatus: '', canUse: false },
  }), '业务暂不可采用');
  assert.equal(
    commandPaletteContentStatus({ status: '可使用' }),
    COMMAND_PALETTE_UNVERIFIED_ADOPTION_STATUS,
  );
});

test('CommandPalette把权威或历史待对账状态统一显示为业务暂不可采用', () => {
  const fixtures = [
    { status: '待对账' },
    { status: '可使用', delivery: { displayStatus: '待账务对账', canUse: false } },
    {
      status: '可使用',
      delivery: {
        displayStatus: '',
        canUse: false,
        presentationKey: 'business_blocked',
      },
    },
    {
      status: '可使用',
      delivery: {
        displayStatus: '',
        canUse: false,
        billing: { state: 'pending_reconciliation' },
      },
    },
  ];
  for (const fixture of fixtures) {
    assert.equal(commandPaletteContentStatus(fixture), COMMAND_PALETTE_RECONCILIATION_STATUS);
  }
});

test('CommandPalette搜索结果调用统一状态投影，不再直接拼接数据库raw状态', () => {
  const source = read('web/src/components/CommandPalette.tsx');
  assert.match(source, /import \{ commandPaletteContentStatus \} from '\.\/commandPaletteContentStatus\.js'/u);
  assert.match(source, /hint: \[r\.type, commandPaletteContentStatus\(r\)\]/u);
  assert.doesNotMatch(
    source,
    /id: `content-\$\{r\.id\}`[\s\S]{0,320}hint: \[r\.type, r\.status\]/u,
  );
});

test('运行就绪前端只展示三维能力，不再用兼容canExecute宣称笼统可执行', () => {
  const source = read('web/src/components/RuntimeReadiness.tsx');
  assert.match(source, /能生成本地底稿/u);
  assert.match(source, /能交付人工审阅/u);
  assert.match(source, /能执行外部动作/u);
  assert.match(source, /row\.capabilitySummary/u);
  assert.doesNotMatch(source, /row\.canExecute/u);
});

test('知识库页面区分资料入库与语义向量就绪，并提供显式付费回填入口', () => {
  const source = read('web/src/pages/System.tsx');
  assert.match(source, /const kbVector = kbReadiness\.vector/u);
  assert.match(source, /回填缺失向量/u);
  assert.match(source, /ENABLE_BACKGROUND_EMBEDDINGS=true/u);
  assert.match(source, /语义向量/u);
  assert.doesNotMatch(source, /上传\/录入的文档自动向量化/u);
  assert.doesNotMatch(source, /AI 后续回答可随时抽取调度/u);
});

test('运行就绪状态使用已就绪、需配置、需验证等可行动文案', () => {
  assert.equal(runtimeReadinessMeta({ effective: 'connected', verification: 'passed' }).label, '已验证就绪');
  assert.equal(runtimeReadinessMeta({ effective: 'local_ready' }).label, '本地能力已就绪');
  assert.equal(runtimeReadinessMeta({ effective: 'configured_unverified' }).label, '已配置，需验证');
  assert.equal(runtimeReadinessMeta({ effective: 'degraded' }).label, '真实通道未配置');
  assert.equal(runtimeReadinessMeta({ effective: 'manual_only' }).label, '仅支持人工操作');
  assert.equal(runtimeReadinessMeta({ effective: 'disabled' }).label, '已关闭');
  assert.equal(runtimeReadinessMeta({ effective: 'requires_input' }).label, '需提供实时数据');
  assert.equal(runtimeReadinessMeta({ effective: 'connected', verification: 'failed' }).label, '最近验证失败');
  assert.equal(runtimeReadinessConfigLabel({ configuration: 'missing' }), '需要配置');
  assert.equal(runtimeReadinessVerificationLabel({ verification: 'never' }), '尚未验证');
});

test('飞书开关启用不等于已连接，必须同时具备有效验证和外部执行能力', () => {
  assert.equal(dashboardFeishuPresentation(null).label, '飞书状态未读取');
  assert.equal(dashboardFeishuPresentation({
    enabled: true,
    readiness: { effective: 'configured_unverified', verification: 'never', canPerformExternalAction: false },
  }).label, '飞书需连接验证');
  assert.equal(dashboardFeishuPresentation({
    enabled: true,
    readiness: { connected: true, verification: 'passed', canPerformExternalAction: false },
  }).label, '飞书需连接验证');
  assert.equal(dashboardFeishuPresentation({
    enabled: true,
    readiness: { connected: true, verification: 'passed', canPerformExternalAction: true },
  }).label, '飞书已验证就绪');
  assert.equal(dashboardFeishuPresentation({
    enabled: false,
    appReady: true,
    readiness: { configuration: 'ready', verification: 'never' },
  }).label, '飞书待启用');

  const source = read('web/src/pages/Dashboard.tsx');
  assert.match(source, /dashboardFeishuPresentation\(feishu\)/u);
  assert.doesNotMatch(source, /feishu\?\.enabled\s*\?\s*['"]✓ 已连接飞书/u);
});

test('活动日历直写同样必须经过飞书显式验证，应用配置不能冒充可执行', () => {
  assert.equal(activityCalendarSyncPresentation({
    configuredSyncEnabled: true,
    autoSyncReady: false,
    readiness: { connected: false, verification: 'never', canPerformExternalAction: false },
  }).label, '日历直写需连接验证');
  assert.equal(activityCalendarSyncPresentation({
    configuredSyncEnabled: true,
    autoSyncReady: true,
    managers: { count: 2 },
    readiness: { connected: true, verification: 'passed', canPerformExternalAction: true },
  }).label, '日历直写已验证就绪');
  assert.equal(activityCalendarSyncPresentation({
    configuredSyncEnabled: true,
    autoSyncReady: false,
    readiness: { connected: false, verification: 'failed', canPerformExternalAction: false },
  }).label, '日历直写验证失败');

  const route = read('server/src/routes/activities.js');
  const page = read('web/src/pages/Activities.tsx');
  assert.match(route, /autoSyncReady:\s*readiness\?\.connected === true && readiness\?\.canPerformExternalAction === true/u);
  assert.match(page, /activityCalendarSyncPresentation\(calSync\.info\)/u);
  assert.doesNotMatch(page, /日历直写可用/u);
  assert.doesNotMatch(page, /应用机器人已绑定/u);
});

test('文件状态不再把数据库兼容值“可用”原样展示给用户', () => {
  assert.equal(generatedArtifactStatusLabel('可用'), '文件已生成');
  assert.equal(generatedArtifactStatusLabel('已入档'), '已归档到知识库');
  assert.equal(generatedArtifactStatusLabel(''), '文件已生成');
  const source = read('web/src/pages/Advisor.tsx');
  assert.match(source, /generatedArtifactStatusLabel\(a\.status\)/u);
  assert.doesNotMatch(source, /a\.status \|\| ['"]可用['"]/u);
});

test('排行榜只统计并标明已人工采纳内容，不再展示笼统“可用内容”', () => {
  const dashboard = read('web/src/pages/Dashboard.tsx');
  const route = read('server/src/routes/dashboard.js');
  assert.match(dashboard, /已人工采纳内容/u);
  assert.match(route, /已通过交付门禁并由人工采纳/u);
  assert.doesNotMatch(dashboard, /可用内容产出/u);
  assert.doesNotMatch(route, /label: ["']可用内容产出/u);
});

test('AI账务对账把正常生成中的额度标为临时预留，不冒充异常或门禁失败', () => {
  const panel = read('web/src/components/SystemBillingPanel.tsx');
  const system = read('web/src/pages/System.tsx');
  assert.match(panel, /row\?\.stillActive === true/u);
  assert.match(panel, /AI 任务正在生成，临时预留/u);
  assert.match(panel, /交付门禁待检测/u);
  assert.match(panel, /生成中 · 无需处理/u);
  assert.match(system, /summary\?\.requiresAttention/u);
  assert.doesNotMatch(panel, /仍在执行的任务会保持阻断/u);
});
