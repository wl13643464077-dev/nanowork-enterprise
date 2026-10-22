import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('AI带货员仅在面板打开时恢复历史任务，关闭后停止稳定轮询链', () => {
  const panel = fs.readFileSync(
    path.join(root, 'web/src/components/AiSalesVideoPanel.tsx'),
    'utf8',
  );
  assert.match(panel, /pollingActiveRef/u);
  assert.match(panel, /panelOpenRef/u);
  assert.match(panel, /initialJobId/u);
  assert.match(panel, /if \(!open\) return;[\s\S]{0,300}sessionStorage\.getItem/u);
  assert.match(panel, /return \(\) => \{\s*panelOpenRef\.current = false;\s*clearPolling\(\);/u);
  assert.match(panel, /const current = await api\.get\(safePollUrl, \{ silent: true \}\);[\s\S]{0,180}if \(\s*!panelOpenRef\.current/u);
  assert.match(panel, /pollJobRef\.current === safeJobId[\s\S]{0,160}pollingActiveRef\.current/u);
  assert.doesNotMatch(
    panel,
    /\[applyPollResult, clearPolling, loadMaterials, loadMediaJobs, loadSummary, polling\]/u,
  );
  assert.match(panel, /刷新任务结果/u);
  assert.match(panel, /recover-ai-sales-video/u);
  assert.match(panel, /复用原任务恢复成片（不重复生成）/u);
  assert.match(panel, /confirmCharge: true/u);
  assert.match(panel, /确认恢复并预授权/u);
  assert.match(panel, /口播发布前提醒/u);
  assert.match(panel, /发布前建议调整口播/u);
  assert.match(panel, /前3秒钩子/u);
  assert.match(panel, /行动邀请/u);
});
