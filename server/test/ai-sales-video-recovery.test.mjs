import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  AiSalesVideoRecoveryError,
  recoverAiSalesVideoFromExistingTasks,
  safeAiSalesVideoProviderTaskId,
} from '../src/engines/ai-sales-video-recovery.js';

function planFor(count = 3) {
  const durationSeconds = count === 2 ? 15 : 10;
  return {
    workflow: 'ai_sales_video',
    model: count === 2 ? 'MiniMax-H3' : 'MiniMax-Hailuo-2.3',
    durationSeconds: 30,
    segments: Array.from({ length: count }, (_, offset) => ({
      index: offset + 1,
      durationSeconds,
      title: `镜头${offset + 1}`,
    })),
  };
}

function executionFor(count = 3) {
  return {
    invocationStarted: true,
    invocationCount: count,
    segments: Array.from({ length: count }, (_, offset) => ({
      index: offset + 1,
      durationSeconds: count === 2 ? 15 : 10,
      status: 'downloaded',
      taskId: `existing-task-${offset + 1}`,
    })),
  };
}

async function localDownload({ outputDir, index }) {
  const filePath = path.join(outputDir, `clip-${index}.mp4`);
  await fsp.writeFile(filePath, Buffer.from(`clip-${index}`));
  return {
    path: filePath,
    absolutePath: filePath,
    sha256: String(index).repeat(64),
    bytes: 6,
  };
}

function composedResult(tenantId, segmentCount) {
  return {
    path: `/private/internal/tenant-${tenantId}/sales-video.mp4`,
    absolutePath: `/private/internal/tenant-${tenantId}/sales-video.mp4`,
    url: `/uploads/ai-sales-video/${tenantId}/recovered-sales-video.mp4`,
    sha256: 'f'.repeat(64),
    durationSeconds: 30,
    width: 1080,
    height: 1920,
    videoCodec: 'h264',
    audioCodec: 'aac',
    segmentCount,
  };
}

test('recovery reuses three existing task IDs, downloads and composes without a submit boundary', async () => {
  const queryCalls = [];
  const downloadCalls = [];
  const composeCalls = [];
  const progress = [];
  const result = await recoverAiSalesVideoFromExistingTasks({
    tenantId: 7,
    plan: planFor(3),
    providerExecution: executionFor(3),
    intervalMs: 1,
    timeoutMs: 100,
    query: async ({ taskId, model, signal }) => {
      queryCalls.push({ taskId, model, signal });
      return {
        status: 'Success',
        url: `https://temporary.provider.invalid/${taskId}?secret=ephemeral`,
      };
    },
    download: async (input) => {
      downloadCalls.push(input);
      return localDownload(input);
    },
    compose: async (input) => {
      composeCalls.push(input);
      assert.equal(input.tenantId, 7);
      assert.equal(input.targetDurationSeconds, 30);
      assert.equal(input.segments.length, 3);
      assert.ok(input.segments.every(file => file.includes('nanowork-ai-sales-recovery-')));
      return composedResult(7, 3);
    },
    onProgress: async snapshot => progress.push(snapshot),
  });

  assert.deepEqual(queryCalls.map(call => call.taskId), [
    'existing-task-1',
    'existing-task-2',
    'existing-task-3',
  ]);
  assert.equal(downloadCalls.length, 3);
  assert.equal(composeCalls.length, 1);
  assert.equal(result.status, 'success');
  assert.equal(result.result.providerCalls, 0);
  assert.equal(result.result.reusedProviderTasks, 3);
  assert.equal(result.result.recovery.providerSubmissions, 0);
  assert.equal(result.providerExecution.recovery.providerSubmissions, 0);
  assert.equal(result.providerExecution.recovery.stage, 'completed');
  assert.ok(result.providerExecution.updatedAt.endsWith('Z'));
  assert.ok(result.providerExecution.lastActivityAt.endsWith('Z'));
  assert.deepEqual(
    result.providerExecution.segments.map(segment => segment.status),
    ['downloaded', 'downloaded', 'downloaded'],
  );
  const publicJson = JSON.stringify(result);
  assert.doesNotMatch(publicJson, /temporary\.provider/u);
  assert.doesNotMatch(publicJson, /secret=ephemeral/u);
  assert.doesNotMatch(publicJson, /nanowork-ai-sales-recovery-/u);
  assert.doesNotMatch(publicJson, /\/private\/internal/u);
  assert.doesNotMatch(publicJson, /absolutePath|localPath/u);
  assert.ok(progress.length >= 7);
  assert.ok(progress.every(item => item.recovery.providerSubmissions === 0));
});
test('two existing H3 tasks can be reused for the same fixed 30-second contract', async () => {
  const result = await recoverAiSalesVideoFromExistingTasks({
    tenantId: 3,
    plan: planFor(2),
    providerExecution: executionFor(2),
    query: async ({ taskId }) => ({
      status: 'Success',
      url: `https://provider.invalid/${taskId}.mp4`,
    }),
    download: localDownload,
    compose: async ({ segments }) => {
      assert.equal(segments.length, 2);
      return composedResult(3, 2);
    },
  });
  assert.equal(result.result.durationSeconds, 30);
  assert.equal(result.result.providerCalls, 0);
  assert.equal(result.result.reusedProviderTasks, 2);
});

test('unsafe, missing or duplicate task IDs fail before provider query', async () => {
  assert.equal(safeAiSalesVideoProviderTaskId('437344375742887'), '437344375742887');
  assert.equal(safeAiSalesVideoProviderTaskId('https://provider.invalid/task'), null);
  assert.equal(safeAiSalesVideoProviderTaskId('../task'), null);
  let queryCalls = 0;
  for (const bad of [
    [null, 'existing-task-2', 'existing-task-3'],
    ['https://provider.invalid/1', 'existing-task-2', 'existing-task-3'],
    ['same-task', 'same-task', 'existing-task-3'],
  ]) {
    const execution = executionFor(3);
    execution.segments.forEach((segment, index) => {
      segment.taskId = bad[index];
    });
    await assert.rejects(
      recoverAiSalesVideoFromExistingTasks({
        tenantId: 1,
        plan: planFor(3),
        providerExecution: execution,
        query: async () => {
          queryCalls += 1;
          return { status: 'Success', url: 'https://provider.invalid/file.mp4' };
        },
      }),
      error => error instanceof AiSalesVideoRecoveryError
        && error.phase === 'validation'
        && error.retryable === false,
    );
  }
  assert.equal(queryCalls, 0);
});

test('query/download/compose errors are retryable and do not expose temporary URLs or paths', async t => {
  const scenarios = [
    {
      name: 'query',
      overrides: {
        query: async () => {
          throw new Error('credential leaked at https://secret.provider.invalid/token');
        },
      },
      code: 'AI_SALES_VIDEO_RECOVERY_QUERY_FAILED',
    },
    {
      name: 'download',
      overrides: {
        query: async () => ({ status: 'Success', url: 'https://secret.provider.invalid/file.mp4' }),
        download: async () => {
          throw new Error('/tmp/private-provider-download.mp4');
        },
      },
      code: 'AI_SALES_VIDEO_RECOVERY_DOWNLOAD_FAILED',
    },
    {
      name: 'compose',
      overrides: {
        query: async ({ taskId }) => ({ status: 'Success', url: `https://provider.invalid/${taskId}` }),
        download: localDownload,
        compose: async () => {
          throw new Error('/tmp/private-compose.mp4');
        },
      },
      code: 'AI_SALES_VIDEO_RECOVERY_COMPOSE_FAILED',
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let caught;
      try {
        await recoverAiSalesVideoFromExistingTasks({
          tenantId: 1,
          plan: planFor(3),
          providerExecution: executionFor(3),
          intervalMs: 1,
          timeoutMs: 20,
          download: localDownload,
          compose: async () => composedResult(1, 3),
          ...scenario.overrides,
        });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof AiSalesVideoRecoveryError);
      assert.equal(caught.code, scenario.code);
      assert.equal(caught.retryable, true);
      assert.equal(caught.progress.recovery.stage, 'failed');
      assert.equal(caught.progress.recovery.providerSubmissions, 0);
      const publicError = JSON.stringify({
        message: caught.message,
        code: caught.code,
        progress: caught.progress,
      });
      assert.doesNotMatch(publicError, /secret\.provider|private-provider|private-compose/u);
      assert.doesNotMatch(publicError, /https?:\/\//u);
      assert.doesNotMatch(publicError, /\/tmp\//u);
    });
  }
});

test('provider-declared failed task is explicitly not retryable by the no-submit recovery path', async () => {
  await assert.rejects(
    recoverAiSalesVideoFromExistingTasks({
      tenantId: 1,
      plan: planFor(3),
      providerExecution: executionFor(3),
      query: async () => ({ status: 'Failed' }),
    }),
    error => error.code === 'AI_SALES_VIDEO_RECOVERY_PROVIDER_TASK_FAILED'
      && error.retryable === false
      && error.progress.recovery.retryable === false
      && error.progress.recovery.providerSubmissions === 0,
  );
});

test('AbortSignal stops recovery before query and reports a retryable cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  let queryCalls = 0;
  await assert.rejects(
    recoverAiSalesVideoFromExistingTasks({
      tenantId: 1,
      plan: planFor(3),
      providerExecution: executionFor(3),
      signal: controller.signal,
      query: async () => {
        queryCalls += 1;
        return { status: 'Success', url: 'https://provider.invalid/file.mp4' };
      },
    }),
    error => error.code === 'AI_SALES_VIDEO_RECOVERY_ABORTED'
      && error.status === 499
      && error.retryable === true
      && error.progress.recovery.providerSubmissions === 0,
  );
  assert.equal(queryCalls, 0);
});
