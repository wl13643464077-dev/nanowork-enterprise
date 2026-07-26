import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ===== AI-C2 测试：RAG 相似度阈值截断 / 降级标记 / 引用溯源落库 =====
const DBP = path.join(os.tmpdir(), `shanmei-rag-quality-${process.pid}.db`);
for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
process.env.NANOWORK_DB = DBP;
process.env.YUNWU_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { initSchema, migrateV2, q, runWithTenant, setConfig } = await import('../src/db.js');
const { selectKbExcerpts, kbSearch, kbContext, ragMinSimilarity } = await import('../src/engines/ai.js');
const { recordKbCitations, citationsFor } = await import('../src/engines/rag.js');

initSchema();
migrateV2();

const doc = (id, title) => ({ id, category: '品牌资料', title });

test('selectKbExcerpts：低于最小相似度阈值的块不注入，无向量候选(sim=-1)一律挡下', () => {
  const candidates = [
    { doc: doc(1, '高相关'), text: '高相关正文', sim: 0.9, seq: null },
    { doc: doc(2, '中相关'), text: '中相关正文', sim: 0.5, seq: 0 },
    { doc: doc(3, '低相关'), text: '低相关正文', sim: 0.1, seq: null },
    { doc: doc(4, '无向量'), text: '无向量正文', sim: -1, seq: null },
  ];
  const { ctx, refs } = selectKbExcerpts(candidates, { minSim: 0.25 });
  assert.match(ctx, /高相关正文/);
  assert.match(ctx, /中相关正文/);
  assert.doesNotMatch(ctx, /低相关正文/, '低于阈值的块不得注入 prompt');
  assert.doesNotMatch(ctx, /无向量正文/, '无向量候选不得混进语义召回结果');
  assert.deepEqual(refs.map(r => r.id).sort(), [1, 2]);
});

test('selectKbExcerpts：全部低于阈值时返回空注入（宁缺毋滥），且引用列表为空', () => {
  const { ctx, refs } = selectKbExcerpts([
    { doc: doc(1, '甲'), text: '正文A', sim: 0.05, seq: null },
    { doc: doc(2, '乙'), text: '正文B', sim: 0.2, seq: null },
  ], { minSim: 0.25 });
  assert.equal(ctx, '');
  assert.equal(refs.length, 0);
});

test('selectKbExcerpts：同文档多块引用去重到文档粒度并保留最高相似度', () => {
  const { refs } = selectKbExcerpts([
    { doc: doc(7, '长文档'), text: '第一段', sim: 0.8, seq: 0 },
    { doc: doc(7, '长文档'), text: '第二段', sim: 0.6, seq: 1 },
  ], { minSim: 0.25 });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].id, 7);
  assert.equal(refs[0].sim, 0.8);
});

test('ragMinSimilarity：默认 0.25，后台 rag_min_similarity 配置可调', () => {
  assert.equal(ragMinSimilarity(), 0.25);
  setConfig('rag_min_similarity', 0.6);
  assert.equal(ragMinSimilarity(), 0.6);
  setConfig('rag_min_similarity', null);
  assert.equal(ragMinSimilarity(), 0.25);
});

test('kbSearch：向量召回按相似度过滤并返回引用清单（mode=semantic 不降级）', async () => {
  await runWithTenant(1, async () => {
    q.run(`INSERT INTO kb_docs(category,title,body,enabled,embedding) VALUES(?,?,?,?,?)`,
      'RAG测试甲', '相关文档', '这是与问题高度相关的正文内容', 1, JSON.stringify([1, 0, 0]));
    q.run(`INSERT INTO kb_docs(category,title,body,enabled,embedding) VALUES(?,?,?,?,?)`,
      'RAG测试甲', '无关文档', '这是与问题完全无关的正文内容', 1, JSON.stringify([0, 1, 0]));
    process.env.YUNWU_API_KEY = 'sk-test-rag';
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/embeddings')) {
        return { ok: true, json: async () => ({ data: [{ embedding: [1, 0, 0] }] }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    try {
      const out = await kbSearch(['RAG测试甲'], null, '相关问题');
      assert.equal(out.mode, 'semantic');
      assert.equal(out.degraded, false);
      assert.match(out.text, /相关文档/);
      assert.doesNotMatch(out.text, /无关文档/, '相似度低于阈值的文档不得注入');
      assert.equal(out.refs.length, 1);
      assert.equal(out.refs[0].title, '相关文档');
      assert.ok(out.refs[0].sim > 0.9);
    } finally {
      globalThis.fetch = realFetch;
      process.env.YUNWU_API_KEY = '';
    }
  });
});

test('kbSearch：embedding 不可用时不冒充检索成功——标记 degraded 并退回热度排序', async () => {
  await runWithTenant(1, async () => {
    q.run(`INSERT INTO kb_docs(category,title,body,enabled,ref_count) VALUES(?,?,?,?,?)`,
      'RAG测试乙', '热门文档', '热度排序兜底正文', 1, 9);
    const out = await kbSearch(['RAG测试乙'], null, '有查询但无法向量化');
    assert.equal(out.mode, 'hot');
    assert.equal(out.degraded, true, 'embedding 失败必须标记降级');
    assert.match(out.text, /热门文档/);
    assert.equal(out.refs[0].sim, null, '热度降级的引用不得伪造相似度');

    // 无 query 的热度模式属正常设计，不算降级
    const noQuery = await kbSearch(['RAG测试乙'], null, null);
    assert.equal(noQuery.mode, 'hot');
    assert.equal(noQuery.degraded, false);
  });
});

test('kbSearch：知识库未向量化时同样标记 degraded（不静默）', async () => {
  await runWithTenant(1, async () => {
    q.run(`INSERT INTO kb_docs(category,title,body,enabled) VALUES(?,?,?,?)`,
      'RAG测试丙', '未向量化文档', '尚未生成向量的正文', 1);
    process.env.YUNWU_API_KEY = 'sk-test-rag';
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/embeddings')) {
        return { ok: true, json: async () => ({ data: [{ embedding: [1, 0, 0] }] }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    try {
      const out = await kbSearch(['RAG测试丙'], null, '任意问题');
      assert.equal(out.mode, 'hot');
      assert.equal(out.degraded, true, '候选全无向量必须如实标记降级');
      assert.match(out.text, /未向量化文档/);
    } finally {
      globalThis.fetch = realFetch;
      process.env.YUNWU_API_KEY = '';
    }
  });
});

test('kbContext 兼容入口：仍返回纯文本字符串（活动方案/生成PPT等旧调用不破坏）', async () => {
  await runWithTenant(1, async () => {
    const text = await kbContext(['RAG测试乙'], null, null);
    assert.equal(typeof text, 'string');
    assert.match(text, /热门文档/);
  });
});

test('引用溯源：答案落库后 kb_citations 可回答"依据哪份资料"', () => {
  runWithTenant(1, () => {
    const kb = {
      refs: [
        { id: 11, category: '品牌资料', title: '青花清品牌手册', sim: 0.87 },
        { id: 12, category: '话术案例', title: '品鉴会邀约话术', sim: 0.52 },
      ],
      degraded: false, mode: 'semantic',
    };
    const n = recordKbCitations({ targetType: 'ai_message', targetId: 9001, kb });
    assert.equal(n, 2);
    const rows = citationsFor('ai_message', 9001);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.doc_id), [11, 12]);
    assert.equal(rows[0].doc_title, '青花清品牌手册');
    assert.equal(rows[0].rag_mode, 'semantic');
    assert.equal(rows[0].degraded, 0);

    // 降级检索的引用也如实标记
    recordKbCitations({ targetType: 'content', targetId: 9002, kb: { refs: [{ id: 13, category: '品牌资料', title: '热门文档', sim: null }], degraded: true, mode: 'hot' } });
    const degradedRows = citationsFor('content', 9002);
    assert.equal(degradedRows[0].degraded, 1);
    assert.equal(degradedRows[0].rag_mode, 'hot');
    assert.equal(degradedRows[0].similarity, null);

    // 未引用知识库时不落行
    assert.equal(recordKbCitations({ targetType: 'ai_message', targetId: 9003, kb: { refs: [], degraded: false, mode: 'empty' } }), 0);
    assert.equal(citationsFor('ai_message', 9003).length, 0);
  });
});

test('引用溯源：租户隔离——A 租户的引用 B 租户查不到', () => {
  runWithTenant(2, () => {
    recordKbCitations({ targetType: 'ai_message', targetId: 9100, kb: { refs: [{ id: 21, category: '品牌资料', title: '租户2资料', sim: 0.9 }], degraded: false, mode: 'semantic' } });
    assert.equal(citationsFor('ai_message', 9100).length, 1);
  });
  runWithTenant(1, () => {
    assert.equal(citationsFor('ai_message', 9100).length, 0, '跨租户不得读取引用记录');
  });
});
