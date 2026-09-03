import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AI_SALES_VIDEO_DURATION_SECONDS,
  AI_SALES_VIDEO_SEGMENT_COUNT,
  AI_SALES_VIDEO_SEGMENT_SECONDS,
  buildAiSalesVideoPlan,
  executeAiSalesVideoPlan,
} from '../src/engines/ai-sales-video.js';

test('AI sales-video plan is deterministic, three segments, and explicitly blocked without composer', async () => {
  const plan = buildAiSalesVideoPlan({
    brief: '突出手工牛肉面的现做体验和午市到店动作',
    model: 'MiniMax-Hailuo-2.3-Fast',
    references: [
      { source: 'file', id: 11, name: '人物.png', ext: 'png', contentSha256: 'a'.repeat(64) },
      { source: 'file', id: 12, name: '菜品.jpg', ext: 'jpg', contentSha256: 'b'.repeat(64) },
    ],
  });
  assert.equal(plan.durationSeconds, AI_SALES_VIDEO_DURATION_SECONDS);
  assert.equal(plan.segmentCount, AI_SALES_VIDEO_SEGMENT_COUNT);
  assert.deepEqual(plan.segments.map(segment => segment.durationSeconds), [10, 10, 10]);
  assert.equal(plan.scriptMode, 'template');
  assert.equal(plan.composer.status, 'authorization_required');

  const result = await executeAiSalesVideoPlan({ plan });
  assert.equal(result.status, 'blocked');
  assert.equal(result.providerCalls, 0);
  assert.equal(result.url, null);
  assert.deepEqual(result.segments.map(segment => segment.status), ['blocked', 'blocked', 'blocked']);
});

test('injectable provider/composer executes exactly three ten-second segments for tests', async () => {
  const plan = buildAiSalesVideoPlan({
    brief: '展示招牌菜和门店服务',
    references: [{ source: 'inline', dataUrl: 'data:image/png;base64,YWJj' }],
  });
  const submitted = [];
  const invocationMarkers = [];
  const segmentStates = [];
  const result = await executeAiSalesVideoPlan({
    plan,
    onProviderInvocationStarted: async ({ segment }) => {
      invocationMarkers.push(segment.index);
    },
    onSegmentState: async state => {
      segmentStates.push(state);
    },
    submitSegment: async input => {
      assert.equal(invocationMarkers.at(-1), input.segment.index, '供应商调用前必须先写入调用标记');
      submitted.push(input);
      return {
        taskId: `task-${input.segment.index}`,
        url: `https://provider.test/segment-${input.segment.index}.mp4`,
      };
    },
    compose: async ({ segments }) => {
      assert.equal(segments.length, AI_SALES_VIDEO_SEGMENT_COUNT);
      assert.deepEqual(segments.map(segment => segment.durationSeconds), [AI_SALES_VIDEO_SEGMENT_SECONDS, 10, 10]);
      return { url: 'https://cdn.test/composed-30s.mp4' };
    },
  });
  assert.equal(result.status, 'success');
  assert.equal(result.providerCalls, 3);
  assert.equal(result.url, 'https://cdn.test/composed-30s.mp4');
  assert.equal(result.composition.url, 'https://cdn.test/composed-30s.mp4');
  assert.deepEqual(submitted.map(input => input.durationSeconds), [10, 10, 10]);
  assert.deepEqual(invocationMarkers, [1, 2, 3]);
  assert.deepEqual(
    segmentStates.map(state => [state.segment.index, state.status]),
    [
      [1, 'provider_ready'], [1, 'downloaded'],
      [2, 'provider_ready'], [2, 'downloaded'],
      [3, 'provider_ready'], [3, 'downloaded'],
    ],
  );
  assert.ok(segmentStates.every(state => !Object.hasOwn(state, 'url') && !Object.hasOwn(state, 'localPath')));
});

test('a durable invocation marker failure stops execution before the paid provider call', async () => {
  const plan = buildAiSalesVideoPlan({
    brief: '验证调用前的账务安全标记',
    references: [{ source: 'inline', dataUrl: 'data:image/png;base64,YWJj' }],
  });
  let providerCalls = 0;
  await assert.rejects(
    executeAiSalesVideoPlan({
      plan,
      onProviderInvocationStarted: async () => {
        throw new Error('durable marker unavailable');
      },
      submitSegment: async () => {
        providerCalls += 1;
        return { url: 'https://provider.test/must-not-run.mp4' };
      },
      compose: async () => ({ url: 'https://cdn.test/must-not-run.mp4' }),
    }),
    /durable marker unavailable/u,
  );
  assert.equal(providerCalls, 0);
});

test('brief and reference validation rejects empty input', () => {
  assert.throws(() => buildAiSalesVideoPlan({ brief: '', references: [] }), /brief不能为空/u);
  assert.throws(() => buildAiSalesVideoPlan({ brief: '有卖点', references: [] }), /至少上传1张/u);
  assert.throws(() => buildAiSalesVideoPlan({ brief: '有卖点', references: new Array(7).fill({}) }), /最多上传6张/u);
});

test('H3 plan uses two fifteen-second segments while keeping the final film at 30 seconds', () => {
  const plan = buildAiSalesVideoPlan({
    brief: '用人物、菜品和门店图生成到店带货片',
    model: 'MiniMax-H3',
    references: [{ source: 'inline', dataUrl: 'data:image/png;base64,YWJj' }],
  });
  assert.equal(plan.durationSeconds, 30);
  assert.equal(plan.segmentCount, 2);
  assert.equal(plan.segmentDurationSeconds, 15);
  assert.deepEqual(plan.segments.map(segment => segment.durationSeconds), [15, 15]);
});
