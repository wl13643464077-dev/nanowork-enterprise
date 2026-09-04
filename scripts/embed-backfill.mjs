// 给存量知识库文档批量生成向量（首次部署 / 升级 RAG 后跑一次）
// 同时生成分块向量（kb_chunks），长文档按块召回
//
// 用法：node scripts/embed-backfill.mjs [--tenant=ID] [--dry-run] [--limit=N] [--cursor-file=PATH] [--reset] [--help]
//   --tenant      只处理某个租户的文档
//   --dry-run     只列出将要处理的文档，不调用向量服务、不写库
//   --limit       本次最多处理 N 篇（默认 200），配合游标可分多次跑完
//   --cursor-file 断点游标文件（默认 .embed-backfill.cursor.json，按 doc_id 续跑）
//   --reset       忽略已有游标，从头开始
//   --help / -h   显示说明（不打开数据库）
//
// 进度实时输出“已处理/总数/失败”；每处理一篇即写游标，中断后重跑自动从下一篇继续。
import fs from "node:fs";
import path from "node:path";
import {
  BACKFILL_USAGE,
  formatBackfillProgress,
  parseBackfillArgs,
  parseCursor,
  selectBackfillBatch,
  serializeCursor,
} from "../server/src/engines/kb-backfill-plan.js";

const options = parseBackfillArgs(process.argv.slice(2));
if (options.help) {
  console.log(BACKFILL_USAGE);
  process.exit(0);
}
if (options.errors.length) {
  for (const error of options.errors) console.error(`参数错误：${error}`);
  console.error("");
  console.error(BACKFILL_USAGE);
  process.exit(2);
}

// 帮助/参数错误已在上面退出；只有真的要干活才加载数据库与向量引擎
const { q, initSchema, migrateV2 } = await import("../server/src/db.js");
const { embedDocSync } = await import("../server/src/engines/rag.js");

initSchema();
migrateV2(); // 确保 embedding 列与 kb_chunks 表存在

const cursorPath = path.resolve(process.cwd(), options.cursorFile);
const cursor = options.reset
  ? { lastDocId: 0, tenant: options.tenant, processed: 0 }
  : parseCursor(
      fs.existsSync(cursorPath) ? fs.readFileSync(cursorPath, "utf8") : "",
      { tenant: options.tenant },
    );
if (cursor.discarded) {
  console.log(`游标文件已忽略（${cursor.discarded}），从头开始`);
} else if (cursor.lastDocId > 0) {
  console.log(`从游标 doc#${cursor.lastDocId} 之后继续（此前已处理 ${cursor.processed} 篇）`);
}

// 待处理：整文向量缺失，或长文档还没有分块记录
const tenantClause = options.tenant ? " AND tenant_id = ?" : "";
const tenantParams = options.tenant ? [options.tenant] : [];
const pending = q.all(
  `SELECT id, tenant_id, title, body FROM kb_docs WHERE enabled = 1${tenantClause}
  AND (embedding IS NULL OR trim(embedding) = ''
       OR (LENGTH(COALESCE(body,'')) > 700 AND NOT EXISTS (SELECT 1 FROM kb_chunks c WHERE c.doc_id = kb_docs.id)))
  ORDER BY id`,
  ...tenantParams,
);
const { batch, remaining } = selectBackfillBatch(pending, {
  lastDocId: cursor.lastDocId,
  limit: options.limit,
});
console.log(
  `待向量化文档：${pending.length} 篇${options.tenant ? `（租户 ${options.tenant}）` : ""}；本次处理 ${batch.length} 篇，游标之后剩余 ${remaining} 篇`,
);

if (options.dryRun) {
  for (const doc of batch) {
    console.log(`  [dry-run] doc#${doc.id} tenant=${doc.tenant_id} 《${String(doc.title || "").slice(0, 40)}》`);
  }
  console.log("dry-run 结束：未调用向量服务、未写库、未更新游标");
  process.exit(0);
}

let ok = 0;
let fail = 0;
let processed = 0;
const total = batch.length;
const persistCursor = (lastDocId) => {
  try {
    fs.writeFileSync(
      cursorPath,
      serializeCursor({
        lastDocId,
        tenant: options.tenant,
        processed: cursor.processed + processed,
      }),
    );
  } catch (error) {
    console.error(`游标写入失败：${error?.message || error}`);
  }
};

for (const doc of batch) {
  let success = false;
  try {
    success = await embedDocSync(doc.id, doc.title, doc.body);
  } catch (error) {
    console.error(`\n  doc#${doc.id} 失败：${String(error?.message || error).slice(0, 120)}`);
  }
  processed += 1;
  if (success) ok += 1;
  else fail += 1;
  persistCursor(doc.id);
  process.stdout.write(`\r${formatBackfillProgress({ processed, total, failed: fail, docId: doc.id })}   `);
}
console.log(`\n完成：成功 ${ok}，失败 ${fail}（含分块向量）；游标 doc#${batch.length ? batch[batch.length - 1].id : cursor.lastDocId}`);
if (remaining > 0) {
  console.log(`还有 ${remaining} 篇未处理，再次运行同一命令即可从游标继续。`);
} else if (batch.length) {
  console.log("全部处理完毕；下次运行如需从头重跑请加 --reset。");
}
