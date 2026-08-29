import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ===== AI-C3 测试：结构化输出（response_format / json_schema）与降级链保持 =====
const DBP = path.join(os.tmpdir(), `shanmei-structured-${process.pid}.db`);
for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { initSchema, migrateV2 } = await import('../src/db.js');
const yunwu = await import('../src/engines/yunwu.js');
const { generate, PPT_DECK_SCHEMA, ACTIVITY_PLAN_SCHEMA } = await import('../src/engines/ai.js');

initSchema();
migrateV2();

// 严格模式 JSON Schema 校验器：所有 object 必须 additionalProperties:false 且全字段 required（Claude/OpenAI 严格模式共同要求）
function assertStrictSchema(node, trail = '$') {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'object') {
    assert.equal(node.additionalProperties, false, `${trail} 缺 additionalProperties:false`);
    const keys = Object.keys(node.properties || {});
    assert.ok(keys.length > 0, `${trail} object 无字段定义`);
    assert.deepEqual([...(node.required || [])].sort(), [...keys].sort(), `${trail} required 必须覆盖全部字段`);
    for (const [k, child] of Object.entries(node.properties)) assertStrictSchema(child, `${trail}.${k}`);
  }
  if (node.type === 'array') {
    assert.ok(node.items, `${trail} array 缺 items`);
    assertStrictSchema(node.items, `${trail}[]`);
  }
}

test('AIPPT / 活动方案 schema：合法严格模式 JSON Schema（两条通道通用）', () => {
  for (const s of [PPT_DECK_SCHEMA, ACTIVITY_PLAN_SCHEMA]) {
    assert.ok(s.name, 'schema 需带 name');
    assertStrictSchema(s.schema);
  }
  // 关键业务字段齐全
  assert.deepEqual(PPT_DECK_SCHEMA.schema.required.sort(), ['pages', 'subtitle', 'title']);
  assert.deepEqual(ACTIVITY_PLAN_SCHEMA.schema.required.sort(),
    ['budgetNote', 'flow', 'invites', 'kpi', 'materials', 'sop', 'theme']);
});

test('jsonSchemaFormat：OpenAI 兼容 response_format 包裹（json_schema + strict）', () => {
  const rf = yunwu.jsonSchemaFormat('deck', PPT_DECK_SCHEMA.schema);
  assert.equal(rf.type, 'json_schema');
  assert.equal(rf.json_schema.name, 'deck');
  assert.equal(rf.json_schema.strict, true);
  assert.equal(rf.json_schema.schema, PPT_DECK_SCHEMA.schema);
});

test('yunwu.chat：responseFormat 随请求体下发 response_format 字段', async () => {
  process.env.YUNWU_API_KEY = 'sk-test-structured';
  const realFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: '{"title":"t","subtitle":"s","pages":[]}' },
          finish_reason: 'length',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    };
  };
  try {
    const out = await yunwu.chat({
      role: 'boss', system: '系统提示',
      messages: [{ role: 'user', content: '出PPT' }],
      responseFormat: yunwu.jsonSchemaFormat('ppt_deck', PPT_DECK_SCHEMA.schema),
    });
    assert.equal(captured.response_format.type, 'json_schema');
    assert.equal(captured.response_format.json_schema.name, 'ppt_deck');
    assert.ok(JSON.parse(out.text).title, '返回正文应是合法 JSON');
    assert.equal(out.finishReason, 'length');

    // 不传 responseFormat 时请求体不得携带 response_format（避免不支持的模型无谓报错）
    await yunwu.chat({ role: 'boss', messages: [{ role: 'user', content: '普通对话' }] });
    assert.equal(captured.response_format, undefined);
  } finally {
    globalThis.fetch = realFetch;
    process.env.YUNWU_API_KEY = '';
  }
});

test('yunwu.chat：未知终止原因收敛为安全枚举，不透传上游原文', async () => {
  process.env.YUNWU_API_KEY = 'sk-test-structured';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: { content: '安全正文' },
        finish_reason: 'unexpected upstream detail with spaces',
      }],
      usage: { prompt_tokens: 2, completion_tokens: 2 },
    }),
  });
  try {
    const out = await yunwu.chat({
      role: 'boss',
      messages: [{ role: 'user', content: '检查终止原因' }],
    });
    assert.equal(out.finishReason, 'unknown');
    assert.equal(JSON.stringify(out).includes('unexpected upstream detail'), false);
  } finally {
    globalThis.fetch = realFetch;
    process.env.YUNWU_API_KEY = '';
  }
});

test('generate：responseSchema 经云雾通道下发，正文即合法 JSON（不再靠正则抠）', async () => {
  process.env.YUNWU_API_KEY = 'sk-test-structured';
  const realFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"theme":"品鉴会"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 4 },
      }),
    };
  };
  try {
    const out = await generate({
      kind: 'test-structured', system: 's', userMsg: 'u',
      fallback: () => '{"theme":"模板"}',
      responseSchema: ACTIVITY_PLAN_SCHEMA,
    });
    assert.equal(out.mode, 'api');
    assert.equal(captured.response_format.json_schema.name, 'activity_plan');
    assert.equal(JSON.parse(out.text).theme, '品鉴会');
    assert.equal(out.finishReason, 'stop');
  } finally {
    globalThis.fetch = realFetch;
    process.env.YUNWU_API_KEY = '';
  }
});

test('generate：员工契约可强制走云雾SSE并完整聚合JSON、usage与finishReason', async () => {
  process.env.YUNWU_API_KEY = 'sk-test-structured';
  const realFetch = globalThis.fetch;
  let captured = null;
  const encoder = new TextEncoder();
  const contentEvent = `data: ${JSON.stringify({
    choices: [{ delta: { content: '{"theme":"品鉴会"}' } }],
  })}`;
  const finishEvent = `data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 18, completion_tokens: 7 },
  })}`;
  globalThis.fetch = async (_url, opts) => {
    captured = JSON.parse(opts.body);
    return new Response(new ReadableStream({
      start(controller) {
        const splitAt = contentEvent.indexOf('鉴会');
        controller.enqueue(encoder.encode(contentEvent.slice(0, splitAt)));
        controller.enqueue(encoder.encode(`${contentEvent.slice(splitAt)}\n\n${finishEvent}\n\ndata: [DONE]`));
        controller.close();
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const out = await generate({
      kind: 'test-employee-sse', system: 's', userMsg: 'u',
      fallback: () => '{"theme":"模板兜底"}',
      responseSchema: ACTIVITY_PLAN_SCHEMA,
      providerPolicy: 'yunwu_only',
      preferStream: true,
      timeoutMs: 900000,
    });
    assert.equal(captured.stream, true);
    assert.equal(captured.stream_options.include_usage, true);
    assert.equal(out.mode, 'api');
    assert.equal(JSON.parse(out.text).theme, '品鉴会');
    assert.deepEqual(out.usage, { inputTokens: 18, outputTokens: 7 });
    assert.equal(out.finishReason, 'stop');
  } finally {
    globalThis.fetch = realFetch;
    process.env.YUNWU_API_KEY = '';
  }
});

test('yunwu_only失败时模板底稿不通过流式回调冒充云端进度', async () => {
  process.env.YUNWU_API_KEY = 'sk-test-structured';
  const realFetch = globalThis.fetch;
  const deltas = [];
  globalThis.fetch = async () => { throw new Error('模拟云雾握手前故障'); };
  try {
    const out = await generate({
      kind: 'test-employee-progress-fallback',
      system: 's',
      userMsg: 'u',
      fallback: () => '{"theme":"模板兜底"}',
      responseSchema: ACTIVITY_PLAN_SCHEMA,
      providerPolicy: 'yunwu_only',
      preferStream: true,
      onDelta: delta => deltas.push(delta),
      timeoutMs: 1_000,
    });
    assert.equal(out.mode, 'template');
    assert.equal(JSON.parse(out.text).theme, '模板兜底');
    assert.deepEqual(deltas, []);
  } finally {
    globalThis.fetch = realFetch;
    process.env.YUNWU_API_KEY = '';
  }
});

test('降级链保持：带 responseSchema 时云雾失败仍安全落到模板（绝不 502）', async () => {
  process.env.YUNWU_API_KEY = 'sk-test-structured';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('模拟云雾故障'); };
  try {
    const out = await generate({
      kind: 'test-degrade', system: 's', userMsg: 'u',
      fallback: () => '{"theme":"模板兜底"}',
      responseSchema: ACTIVITY_PLAN_SCHEMA,
      timeoutMs: 1000,
    });
    assert.equal(out.mode, 'template');
    assert.equal(JSON.parse(out.text).theme, '模板兜底');
    assert.deepEqual(out.usage, { inputTokens: 0, outputTokens: 0 }, '模板模式不得计费');
  } finally {
    globalThis.fetch = realFetch;
    process.env.YUNWU_API_KEY = '';
  }
});
