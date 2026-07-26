import { db, q, curTenant } from '../db.js';
import { embed } from './yunwu.js';

// ===== AI-C2 引用溯源：AI 答案落库时记录引用了哪些知识文档 =====
// 会诊消息 / 员工对话 / 内容生产仓产出保存后，把本次检索实际注入 prompt 的 doc id/标题/相似度写入
// kb_citations，随时能回答"这条答案依据哪份资料"，降级检索（热度排序）也如实标记。
let citationTableReady = false;
function ensureCitationTable() {
  // 表的首次创建可能发生在调用方业务事务中；若该事务随后回滚，SQLite 会连同
  // CREATE TABLE 一起回滚，但进程内布尔值不会自动复原。每次命中缓存时仍核验
  // sqlite_master，避免后续请求因“缓存说已建、数据库实际不存在”而连续失败。
  if (citationTableReady
    && db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='kb_citations'`).get()) return;
  db.exec(`
  CREATE TABLE IF NOT EXISTS kb_citations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    target_type TEXT NOT NULL,      -- ai_message / marshal_chat_msg / custom_agent_msg / content
    target_id INTEGER NOT NULL,
    doc_id INTEGER NOT NULL,
    doc_title TEXT, doc_category TEXT,
    similarity REAL,                -- 语义召回时的余弦相似度；热度降级时为 NULL
    rag_mode TEXT,                  -- semantic=向量召回 / hot=热度排序降级
    degraded INTEGER DEFAULT 0,     -- 1=本次检索发生过降级（embedding 失败/库未向量化）
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_kb_citations_target ON kb_citations(tenant_id, target_type, target_id);
  `);
  citationTableReady = true;
}

// kb = kbSearch() 返回的 { refs, degraded, mode }；refs 为空时不落行（答案未依据知识库）
export function recordKbCitations({ targetType, targetId, kb }) {
  const refs = kb?.refs || [];
  if (!targetType || !targetId || !refs.length) return 0;
  ensureCitationTable();
  const insert = db.prepare(`INSERT INTO kb_citations(tenant_id,target_type,target_id,doc_id,doc_title,doc_category,similarity,rag_mode,degraded)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const ref of refs) {
    insert.run(curTenant(), targetType, targetId, ref.id, ref.title || null, ref.category || null,
      ref.sim ?? null, kb.mode || null, kb.degraded ? 1 : 0);
  }
  return refs.length;
}

export function citationsFor(targetType, targetId) {
  ensureCitationTable();
  return q.all(`SELECT doc_id, doc_title, doc_category, similarity, rag_mode, degraded FROM kb_citations
    WHERE tenant_id = ? AND target_type = ? AND target_id = ? ORDER BY id`, curTenant(), targetType, targetId);
}

// 文档切块：段落优先聚合到 ~size 字，超长段落硬切；块间带 overlap 字重叠保持上下文连续
export function chunkText(body, { size = 600, overlap = 80, maxChunks = 40 } = {}) {
  const text = String(body || '').trim();
  if (!text) return [];
  if (text.length <= size + 100) return [text]; // 短文不切
  const paras = text.split(/\n{2,}|\r\n{2,}/).flatMap(p => {
    // 超长段落按句子再切
    if (p.length <= size) return [p];
    const sentences = p.split(/(?<=[。！？!?；;])/);
    const parts = [];
    let cur = '';
    for (const s of sentences) {
      if (cur.length + s.length > size && cur) { parts.push(cur); cur = s; }
      else cur += s;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
  }).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if (cur.length + p.length + 1 > size && cur) {
      chunks.push(cur);
      cur = `${cur.slice(-overlap)}\n${p}`; // 携带上一块尾部做重叠
    } else {
      cur = cur ? `${cur}\n${p}` : p;
    }
    if (chunks.length >= maxChunks) break;
  }
  if (cur.trim() && chunks.length < maxChunks) chunks.push(cur);
  return chunks;
}

function liveDoc(id, tenantId, title, body) {
  return q.get(`SELECT id FROM kb_docs
    WHERE tenant_id=? AND id=? AND title IS ? AND body IS ?`,
  tenantId, id, title ?? null, body ?? null);
}

// 重建某文档的块向量。每次写块都在同一条 SQL 内确认文档仍存在且正文未变化，
// 防止业务事务回滚、内容删除或并发修订后，迟到的异步任务写出孤儿/旧块。
async function rebuildChunks(id, title, body, tenantId) {
  if (!liveDoc(id, tenantId, title, body)) return;
  q.run(`DELETE FROM kb_chunks
    WHERE doc_id=? AND EXISTS(
      SELECT 1 FROM kb_docs WHERE tenant_id=? AND id=? AND title IS ? AND body IS ?
    )`, id, tenantId, id, title ?? null, body ?? null);
  const chunks = chunkText(body);
  if (chunks.length <= 1) return; // 单块=整文向量已覆盖，不重复存
  for (let i = 0; i < chunks.length; i++) {
    const vec = await embed(`${title || ''}\n${chunks[i]}`);
    q.run(`INSERT INTO kb_chunks(doc_id,seq,text,embedding)
      SELECT ?,?,?,?
      WHERE EXISTS(
        SELECT 1 FROM kb_docs WHERE tenant_id=? AND id=? AND title IS ? AND body IS ?
      )`,
    id, i, chunks[i], vec ? JSON.stringify(vec) : null,
    tenantId, id, title ?? null, body ?? null);
  }
}

// 给某知识库文档异步生成并写入向量（不阻塞主流程；失败静默，检索时自动降级）
// 同时生成分块向量：长文档按块召回，避免后半段永远检索不到
export function embedDoc(id, title, body) {
  const text = `${title || ''}\n${String(body || '').slice(0, 4000)}`.trim();
  if (!text) return;
  const tenantId = curTenant();
  setImmediate(async () => {
    try {
      if (!liveDoc(id, tenantId, title, body)) return;
      const vec = await embed(text);
      if (vec) {
        q.run(`UPDATE kb_docs SET embedding=?
          WHERE tenant_id=? AND id=? AND title IS ? AND body IS ?`,
        JSON.stringify(vec), tenantId, id, title ?? null, body ?? null);
      }
      await rebuildChunks(id, title, body, tenantId);
    } catch { /* 静默：检索时无向量自动退回热度排序 */ }
  });
}

// 供 backfill 脚本同步调用（脚本环境无请求上下文）
export async function embedDocSync(id, title, body) {
  const text = `${title || ''}\n${String(body || '').slice(0, 4000)}`.trim();
  if (!text) return false;
  const tenantId = q.get('SELECT tenant_id FROM kb_docs WHERE id=?', id)?.tenant_id;
  if (!tenantId || !liveDoc(id, tenantId, title, body)) return false;
  const vec = await embed(text);
  if (vec) {
    q.run(`UPDATE kb_docs SET embedding=?
      WHERE tenant_id=? AND id=? AND title IS ? AND body IS ?`,
    JSON.stringify(vec), tenantId, id, title ?? null, body ?? null);
  }
  await rebuildChunks(id, title, body, tenantId);
  return !!vec;
}
