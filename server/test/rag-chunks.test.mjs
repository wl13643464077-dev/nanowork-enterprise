import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DBP = path.join(os.tmpdir(), `shanmei-rag-${process.pid}.db`);
for (const file of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
  try { fs.rmSync(file, { force: true }); } catch {}
}
process.env.NANOWORK_DB = DBP;
// 与其他单测一致用 test：本文件只验证分块与 kb_chunks 表，不需要生产语义；
// rag.js → credits.js → util.js 的导入链会在 production 下强校验 JWT_SECRET 并直接抛错。
process.env.NODE_ENV = 'test';

const { initSchema, migrateV2, q } = await import('../src/db.js');
const { chunkText } = await import('../src/engines/rag.js');

initSchema();
migrateV2();

test('chunkText：短文不切、长文按段切且带重叠', () => {
  assert.deepEqual(chunkText('短文档内容'), ['短文档内容']);
  assert.deepEqual(chunkText(''), []);

  const para = '这是一段测试文字，用来验证分块逻辑是否按预期工作。'.repeat(10); // ~250字/段
  const long = [para, para, para, para, para, para].join('\n\n'); // ~1500字
  const chunks = chunkText(long, { size: 600, overlap: 80 });
  assert.ok(chunks.length >= 2, `长文应切成多块，实际 ${chunks.length}`);
  for (const c of chunks) assert.ok(c.length <= 600 + 100 + 80 + 2, `单块不应过长：${c.length}`);
  // 重叠：第二块开头应包含第一块尾部片段
  const tail = chunks[0].slice(-40);
  assert.ok(chunks[1].includes(tail.slice(0, 20)), '相邻块之间应有重叠上下文');
});

test('chunkText：超长无分段文本按句硬切且不超 maxChunks', () => {
  const sentence = '句子内容测试。';
  const giant = sentence.repeat(3000); // ~2.1万字无换行
  const chunks = chunkText(giant, { size: 600, overlap: 80, maxChunks: 40 });
  assert.ok(chunks.length > 1 && chunks.length <= 41, `块数应受限：${chunks.length}`);
});

test('kb_chunks 表：按 doc_id 存取，删除文档时可级联清理', () => {
  q.run(`INSERT INTO kb_docs(tenant_id,category,title,body,enabled) VALUES(1,'品牌资料','测试文档','正文',1)`);
  const docId = q.get('SELECT id FROM kb_docs ORDER BY id DESC LIMIT 1').id;
  q.run('INSERT INTO kb_chunks(doc_id,seq,text,embedding) VALUES(?,?,?,?)', docId, 0, '块一', JSON.stringify([0.1, 0.2]));
  q.run('INSERT INTO kb_chunks(doc_id,seq,text,embedding) VALUES(?,?,?,?)', docId, 1, '块二', null);
  assert.equal(q.get('SELECT COUNT(*) n FROM kb_chunks WHERE doc_id=?', docId).n, 2);
  q.run('DELETE FROM kb_chunks WHERE doc_id=?', docId);
  q.run('DELETE FROM kb_docs WHERE id=?', docId);
  assert.equal(q.get('SELECT COUNT(*) n FROM kb_chunks WHERE doc_id=?', docId).n, 0);
});
