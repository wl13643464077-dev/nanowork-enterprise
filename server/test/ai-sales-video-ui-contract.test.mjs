import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('AI带货员恢复历史任务后只启动一条稳定轮询链', () => {
  const panel = fs.readFileSync(
    path.join(root, 'web/src/components/AiSalesVideoPanel.tsx'),
    'utf8',
  );
  assert.match(panel, /pollingActiveRef/u);
  assert.match(panel, /restoredResultRef/u);
  assert.match(panel, /initialJobId/u);
  assert.match(panel, /if \(restoredResultRef\.current\) return/u);
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
});
