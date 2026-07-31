import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  backgroundEmbeddingMaxCalls,
  backgroundEmbeddingsEnabled,
  buildEmbeddingPlan,
  createEmbeddingQueue,
} from '../src/engines/rag.js';
import { createAiConcurrencyPool } from '../src/ai-limits.js';

test('后台向量化默认关闭，只有显式开关才允许产生外部费用', () => {
  assert.equal(backgroundEmbeddingsEnabled({}), false);
  assert.equal(backgroundEmbeddingsEnabled({ ENABLE_BACKGROUND_EMBEDDINGS: 'false' }), false);
  assert.equal(backgroundEmbeddingsEnabled({ ENABLE_BACKGROUND_EMBEDDINGS: 'true' }), true);
  assert.equal(backgroundEmbeddingsEnabled({ ENABLE_BACKGROUND_EMBEDDINGS: '1' }), true);
});

test('单文档向量调用默认最多 8 次且硬上限 16，短文不重复生成分块向量', () => {
  const longBody = Array.from(
    { length: 30 },
    (_, index) => `第${index + 1}段。${'经营数据与流程说明。'.repeat(50)}`,
  ).join('\n\n');
  assert.equal(backgroundEmbeddingMaxCalls({}), 8);
  assert.equal(backgroundEmbeddingMaxCalls({ BACKGROUND_EMBED_MAX_CALLS_PER_DOC: '999' }), 16);
  assert.equal(buildEmbeddingPlan('长文', longBody).callCount, 8);
  assert.equal(buildEmbeddingPlan('长文', longBody, { maxCalls: 3 }).callCount, 3);
  assert.equal(buildEmbeddingPlan('短文', '只有一小段').callCount, 1);
});

test('后台向量队列严格限制并发，完成一个任务后才领取下一项', async () => {
  let running = 0;
  let maxObserved = 0;
  const releases = [];
  const queue = createEmbeddingQueue({
    maxConcurrent: 2,
    schedule: callback => callback(),
  });
  const job = () => new Promise(resolve => {
    running += 1;
    maxObserved = Math.max(maxObserved, running);
    releases.push(() => {
      running -= 1;
      resolve();
    });
  });

  queue.enqueue(job);
  queue.enqueue(job);
  queue.enqueue(job);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(queue.stats(), {
    queued: 1,
    active: 2,
    maxConcurrent: 2,
    maxQueued: 100,
    maxTenantPending: 20,
    maxTenantActive: 1,
    tenants: {
      __legacy__: { queued: 1, active: 2 },
    },
  });
  assert.equal(maxObserved, 2);

  releases.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(queue.stats(), {
    queued: 0,
    active: 2,
    maxConcurrent: 2,
    maxQueued: 100,
    maxTenantPending: 20,
    maxTenantActive: 1,
    tenants: {
      __legacy__: { queued: 0, active: 2 },
    },
  });
  assert.equal(maxObserved, 2);
  assert.equal(releases.length, 2);

  releases.shift()();
  releases.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(queue.stats(), {
    queued: 0,
    active: 0,
    maxConcurrent: 2,
    maxQueued: 100,
    maxTenantPending: 20,
    maxTenantActive: 1,
    tenants: {},
  });
});

test('后台向量队列明确拒绝单租户和全局等待超限，且为其他租户保留容量', async () => {
  const releases = [];
  const queue = createEmbeddingQueue({
    maxConcurrent: 1,
    maxQueued: 3,
    maxTenantPending: 2,
    maxTenantActive: 1,
    schedule: callback => callback(),
  });
  const job = () => new Promise(resolve => releases.push(resolve));

  assert.equal(queue.enqueue(job, { tenantId: 1 }).accepted, true); // active
  assert.equal(queue.enqueue(job, { tenantId: 1 }).accepted, true); // tenant queued 1
  assert.equal(queue.enqueue(job, { tenantId: 1 }).accepted, true); // tenant queued 2

  assert.deepEqual(queue.enqueue(job, { tenantId: 1 }), {
    accepted: false,
    reason: 'tenant_queue_full',
    queued: 2,
    active: 1,
    tenantQueued: 2,
    tenantActive: 1,
  });

  // 单租户只能占两个 pending 槽，第三个槽仍可由其他租户使用。
  assert.equal(queue.enqueue(job, { tenantId: 2 }).accepted, true);
  assert.deepEqual(queue.enqueue(job, { tenantId: 2 }), {
    accepted: false,
    reason: 'global_queue_full',
    queued: 3,
    active: 1,
    tenantQueued: 1,
    tenantActive: 0,
  });

  assert.deepEqual(queue.stats().tenants, {
    1: { queued: 2, active: 1 },
    2: { queued: 1, active: 0 },
  });

  // 释放全部任务，避免测试把未完成任务留给后续用例。
  while (queue.stats().active || queue.stats().queued) {
    releases.shift()?.();
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('后台向量队列跳过已到 active 上限的租户，其他租户可立即获得并发槽', async () => {
  const started = [];
  const releases = new Map();
  const queue = createEmbeddingQueue({
    maxConcurrent: 2,
    maxQueued: 6,
    maxTenantPending: 4,
    maxTenantActive: 1,
    schedule: callback => callback(),
  });
  const job = name => () => new Promise(resolve => {
    started.push(name);
    releases.set(name, resolve);
  });

  queue.enqueue(job('A1'), { tenantId: 'A' });
  queue.enqueue(job('A2'), { tenantId: 'A' });
  queue.enqueue(job('A3'), { tenantId: 'A' });
  queue.enqueue(job('B1'), { tenantId: 'B' });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(started, ['A1', 'B1']);
  assert.deepEqual(queue.stats().tenants, {
    A: { queued: 2, active: 1 },
    B: { queued: 0, active: 1 },
  });

  releases.get('A1')();
  releases.get('B1')();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['A1', 'B1', 'A2']);
  assert.equal(queue.stats().active, 1);

  releases.get('A2')();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['A1', 'B1', 'A2', 'A3']);

  releases.get('A3')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.stats().active, 0);
  assert.equal(queue.stats().queued, 0);
});

test('后台向量队列保留 enqueue(function) 与 enqueue(function, tenantId) 两种调用', async () => {
  const queue = createEmbeddingQueue({
    maxConcurrent: 1,
    maxQueued: 2,
    maxTenantPending: 1,
    maxTenantActive: 1,
    schedule: callback => callback(),
  });

  assert.equal(queue.enqueue(() => {}).accepted, true);
  assert.equal(queue.enqueue(() => {}, 42).accepted, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.stats().active, 0);
  assert.equal(queue.stats().queued, 0);
});

test('后台向量 worker 必须取得 AI 并发租约，任务终态后精确释放', async () => {
  const pool = createAiConcurrencyPool(1);
  const foregroundLease = pool.tryAcquire({ kind: 'foreground-test' });
  let started = false;
  const queue = createEmbeddingQueue({
    maxConcurrent: 1,
    acquireLease: meta => pool.tryAcquire(meta),
    leaseRetryMs: 5,
  });

  const queued = queue.enqueue(() => { started = true; }, { tenantId: 7 });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(started, false);
  assert.deepEqual(queue.stats().tenants, {
    7: { queued: 1, active: 0 },
  });

  foregroundLease.release();
  const outcome = await queued.completion;
  assert.equal(outcome.ok, true);
  assert.equal(started, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pool.stats(), { inFlight: 0, maxConcurrent: 1 });
});

test('长期拿不到共享 AI 租约时队列等待超时，不会无限悬挂', async () => {
  const pool = createAiConcurrencyPool(1);
  const blockingLease = pool.tryAcquire({ kind: 'blocking-test' });
  let started = false;
  const queue = createEmbeddingQueue({
    maxConcurrent: 1,
    acquireLease: meta => pool.tryAcquire(meta),
    leaseRetryMs: 5,
    maxWaitMs: 20,
  });

  const queued = queue.enqueue(() => { started = true; }, { tenantId: 9 });
  const outcome = await queued.completion;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'lease_wait_timeout');
  assert.equal(started, false);
  assert.equal(queue.stats().queued, 0);
  assert.equal(queue.stats().active, 0);
  blockingLease.release();
});
