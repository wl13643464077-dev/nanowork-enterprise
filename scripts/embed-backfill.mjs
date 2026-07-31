// 给存量知识库文档批量生成向量（首次部署 / 升级 RAG 后跑一次）
// 同时生成分块向量（kb_chunks），长文档按块召回
// 用法：node scripts/embed-backfill.mjs
import { q, initSchema, migrateV2 } from "../server/src/db.js";
import { embedDocSync } from "../server/src/engines/rag.js";
initSchema();
migrateV2(); // 确保 embedding 列与 kb_chunks 表存在

// 待处理：整文向量缺失，或长文档还没有分块记录
const docs = q.all(`SELECT id, title, body FROM kb_docs WHERE enabled = 1
  AND (embedding IS NULL OR (LENGTH(COALESCE(body,'')) > 700 AND NOT EXISTS (SELECT 1 FROM kb_chunks c WHERE c.doc_id = kb_docs.id)))`);
console.log(`待向量化文档：${docs.length} 篇`);
let ok = 0,
  fail = 0;
for (const d of docs) {
  try {
    const success = await embedDocSync(d.id, d.title, d.body);
    if (success) {
      ok++;
      process.stdout.write(".");
    } else {
      fail++;
      process.stdout.write("x");
    }
  } catch {
    fail++;
    process.stdout.write("x");
  }
}
console.log(`\n完成：成功 ${ok}，失败 ${fail}（含分块向量）`);
