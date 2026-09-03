import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('角色化新手指引挂在全局外壳并只生成当前账号有权进入的任务', () => {
  const onboarding = read('web/src/components/RoleOnboarding.tsx');
  const layout = read('web/src/layouts/MainLayout.tsx');

  assert.match(onboarding, /type OnboardingTrack = 'owner' \| 'manager' \| 'partner' \| 'staff' \| 'admin'/);
  assert.match(onboarding, /role === 'boss'[\s\S]*return 'owner'/);
  assert.match(onboarding, /role === 'admin'[\s\S]*return 'admin'/);
  assert.match(onboarding, /role === 'partner'[\s\S]*return 'partner'/);
  assert.match(onboarding, /\['ops_director', 'manager'\][\s\S]*return 'manager'/);
  assert.match(onboarding, /tasksFor\(track\)\.filter\(task => availableModules\.has\(task\.module\)\)/);
  assert.match(onboarding, /id: 'owner-dispatch'[\s\S]*module: 'marshals'/);
  assert.match(onboarding, /id: 'staff-task'[\s\S]*module: 'execution'/);
  assert.match(onboarding, /id: 'partner-execution'[\s\S]*module: 'execution'/);
  assert.match(layout, /<RoleOnboarding[\s\S]*?user=\{user\}[\s\S]*?modules=\{modules\}/);
  for (const anchor of ['search', 'assistant', 'help', 'navigation', 'workspace']) {
    assert.match(layout, new RegExp(`data-onboarding="${anchor}"`));
  }
});

test('完成与跳过由服务端同步，跳过不会在重新打开时伪报为已完成', () => {
  const onboarding = read('web/src/components/RoleOnboarding.tsx');
  const layout = read('web/src/layouts/MainLayout.tsx');

  assert.match(onboarding, /api[\s\S]*\.get\('\/meta\/onboarding'/);
  assert.match(onboarding, /api\.put\('\/meta\/onboarding', \{ outcome \}/);
  assert.match(onboarding, /setTerminalOutcome\(state\.outcome \|\| null\)/);
  assert.match(onboarding, /serverComplete && terminalOutcome === 'completed'/);
  assert.match(onboarding, /markOutcome\('dismissed'\)/);
  assert.match(onboarding, /markOutcome\('completed'\)/);
  assert.match(layout, /打开我的新手指引/);
  assert.match(layout, /setOnboardingNonce\(value => value \+ 1\)/);
});

test('独立手机工作台复用同一账号完成态，并让 partner 看得到其 execution 入口', () => {
  const mobile = read('web/src/pages/Mobile.tsx');
  const onboarding = read('web/src/components/RoleOnboarding.tsx');

  assert.match(mobile, /<RoleOnboarding[\s\S]*modules=\{mods\}[\s\S]*compact/);
  assert.match(mobile, /data-onboarding="navigation"/);
  assert.match(mobile, /data-onboarding="workspace"/);
  assert.match(mobile, /data-onboarding="help"/);
  assert.match(
    mobile,
    /key: 'execution'[\s\S]*roles: \['boss', 'ops_director', 'manager', 'sales', 'partner', 'admin'\]/,
  );
  assert.match(onboarding, /compact \? mobileSteps : narrowViewport \? responsiveSteps : desktopSteps/);
});
