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
const {
  buildEmployeeRagQuery,
  EMPLOYEE_PROVIDER_CALL_BUDGET,
  employeeOutputTokenBudget,
  employeeRagMinSimilarity,
  selectKbExcerpts,
  kbSearch,
  kbContext,
  ragMinSimilarity,
} = await import('../src/engines/ai.js');
const { recordKbCitations, citationsFor } = await import('../src/engines/rag.js');

initSchema();
migrateV2();

const doc = (id, title) => ({ id, category: '品牌资料', title });

test('buildEmployeeRagQuery：只保留岗位语义和真实需求，清理逐岗验收模板噪声', () => {
  const query = buildEmployeeRagQuery(
    { name: '内部调度容器', duty: '仅负责调度' },
    {
      title: '[真实API逐岗验收] 重做高峰后厨叫单与出餐口控制',
      type: '执行方案',
      requirement: [
        '任务唯一标识：nonce-restaurant-134-7fc533',
        '执行岗位：出餐协调员；岗位职责：高峰出餐管理。',
        '这是生产接口的真实云模型调用验收，不是模板演示。',
        '业务对象：纳米Work验收门店A。',
        '统一已知事实：营业额100000元，订单2000单。',
        '岗位材料：',
        '1. 近30天高峰时段催菜记录：本轮已提供“岗位验收资料-134-1”；资料口径为2026-07-01至2026-07-31。',
        '晚市有三次同桌菜品间隔超过20分钟，请优先定位叫单与出餐口交接断点。',
        '期望交付：高峰出餐流程图；异常升级规则。',
        '边界：不得声称已经发布、采购或付款。',
      ].join('\n'),
    },
    {
      workbench: {
        identity: { name: '出餐协调员', duty: '管理后厨叫单、出餐口节奏和同桌齐菜' },
        workMethod: { deliverables: ['高峰出餐流程图', '异常升级规则', '班次复盘表'] },
        jobProfile: { expectedDeliverables: ['高峰出餐流程图'] },
      },
    },
  );

  assert.match(query, /数字员工：出餐协调员/u);
  assert.match(query, /岗位职责：管理后厨叫单、出餐口节奏和同桌齐菜/u);
  assert.match(query, /任务：重做高峰后厨叫单与出餐口控制/u);
  assert.match(query, /任务类型：执行方案/u);
  assert.match(query, /岗位交付物：高峰出餐流程图；异常升级规则；班次复盘表/u);
  assert.match(query, /晚市有三次同桌菜品间隔超过20分钟/u, '实际用户业务需求必须保留');
  assert.match(query, /所需材料：近30天高峰时段催菜记录/u, '保留岗位相关的材料主题');
  for (const noise of ['nonce', '真实API', '真实云模型', '统一已知事实', '业务对象', '岗位验收资料', '发布边界']) {
    assert.equal(query.includes(noise), false, `RAG query 不得包含验收噪声：${noise}`);
  }
  assert.ok(query.length <= 1000, '聚焦查询必须有硬性长度上限');
});

test('employeeOutputTokenBudget：完整与标准岗位交付使用可容纳完整正文的预算', () => {
  assert.equal(EMPLOYEE_PROVIDER_CALL_BUDGET, 3);
  assert.equal(employeeOutputTokenBudget('full'), 20_000);
  assert.equal(employeeOutputTokenBudget('standard'), 8_000);
  assert.equal(employeeOutputTokenBudget('full') * EMPLOYEE_PROVIDER_CALL_BUDGET, 60_000);
});

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

test('employeeRagMinSimilarity：员工执行默认宁缺毋滥，且支持独立阈值', () => {
  setConfig('rag_min_similarity', null);
  setConfig('employee_rag_min_similarity', null);
  assert.equal(employeeRagMinSimilarity(), 0.62);
  setConfig('rag_min_similarity', 0.7);
  assert.equal(employeeRagMinSimilarity(), 0.7, '全局阈值更严时不得降低');
  setConfig('employee_rag_min_similarity', 0.58);
  assert.equal(employeeRagMinSimilarity(), 0.58, '员工专用显式配置优先');
  setConfig('rag_min_similarity', null);
  setConfig('employee_rag_min_similarity', null);
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

test('kbSearch：有查询但 embedding 不可用时停止注入，不能拿热度冒充相关性', async () => {
  await runWithTenant(1, async () => {
    q.run(`INSERT INTO kb_docs(category,title,body,enabled,ref_count) VALUES(?,?,?,?,?)`,
      'RAG测试乙', '热门文档', '热度排序兜底正文', 1, 9);
    const out = await kbSearch(['RAG测试乙'], null, '有查询但无法向量化');
    assert.equal(out.mode, 'unavailable');
    assert.equal(out.degraded, true, 'embedding 失败必须标记降级');
    assert.equal(out.text, '');
    assert.deepEqual(out.refs, []);

    // 无 query 的热度模式属正常设计，不算降级
    const noQuery = await kbSearch(['RAG测试乙'], null, null);
    assert.equal(noQuery.mode, 'hot');
    assert.equal(noQuery.degraded, false);
  });
});

test('kbSearch：知识库未向量化时同样停止注入并标记 degraded', async () => {
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
      assert.equal(out.mode, 'unavailable');
      assert.equal(out.degraded, true, '候选全无向量必须如实标记降级');
      assert.equal(out.text, '');
      assert.deepEqual(out.refs, []);
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
