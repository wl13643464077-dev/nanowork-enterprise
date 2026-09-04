// scripts/embed-backfill.mjs 的纯函数部分（P0-2）：参数解析、按 doc_id 游标的断点
// 续跑批次选择、进度文案。无 I/O，便于单测；文件读写留在脚本里。

export const DEFAULT_BACKFILL_LIMIT = 200;
export const DEFAULT_CURSOR_FILE = ".embed-backfill.cursor.json";

export const BACKFILL_USAGE = [
  "用法：node scripts/embed-backfill.mjs [--tenant=ID] [--dry-run] [--limit=N] [--cursor-file=PATH] [--reset]",
  "",
  "给存量知识库文档批量生成整文向量与分块向量（kb_chunks）。",
  "",
  "  --tenant=ID       只处理某个租户的文档（默认全部租户）",
  "  --dry-run         只列出将要处理的文档，不调用向量服务、不写库、不更新游标",
  `  --limit=N         本次最多处理 N 篇（默认 ${DEFAULT_BACKFILL_LIMIT}），配合游标可分多次跑完`,
  `  --cursor-file=P   断点游标文件（默认 ${DEFAULT_CURSOR_FILE}，按 doc_id 续跑）`,
  "  --reset           忽略已有游标，从头开始",
  "  --help, -h        显示本说明",
  "",
  "进度实时输出“已处理/总数/失败”；每处理一篇即写游标，中断后重跑自动从下一篇继续。",
  "换了 --tenant 过滤条件时旧游标自动作废。系统页“知识库健康 → 立即回填”与每日 04:00",
  "调度器走的是同一后台队列；本脚本适合首次部署/升级后一次性批量补齐。",
].join("\n");

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 解析 `node scripts/embed-backfill.mjs [--tenant=ID] [--dry-run] [--limit=N] [--cursor-file=PATH] [--reset]`
 * 也接受 `--tenant ID` / `--limit N` 的空格写法。
 */
export function parseBackfillArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const options = {
    tenant: null,
    dryRun: false,
    limit: DEFAULT_BACKFILL_LIMIT,
    cursorFile: DEFAULT_CURSOR_FILE,
    reset: false,
    help: false,
    errors: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    const [flag, inlineValue] = raw.includes("=")
      ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)]
      : [raw, undefined];
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        index += 1;
        return next;
      }
      return undefined;
    };
    switch (flag) {
      case "--tenant": {
        const value = takeValue();
        const tenant = Number(value);
        if (!Number.isSafeInteger(tenant) || tenant <= 0) {
          options.errors.push(`--tenant 需要正整数租户ID，收到：${value ?? "(空)"}`);
        } else options.tenant = tenant;
        break;
      }
      case "--limit": {
        const value = takeValue();
        const limit = Number(value);
        if (!Number.isSafeInteger(limit) || limit <= 0) {
          options.errors.push(`--limit 需要正整数，收到：${value ?? "(空)"}`);
        } else options.limit = limit;
        break;
      }
      case "--cursor-file": {
        const value = takeValue();
        if (!value) options.errors.push("--cursor-file 需要文件路径");
        else options.cursorFile = value;
        break;
      }
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--reset":
        options.reset = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        options.errors.push(`未知参数：${raw}`);
    }
  }
  return options;
}

/** 游标文件内容 → { lastDocId, tenant }；损坏或为空时返回起点。 */
export function parseCursor(raw, { tenant = null } = {}) {
  if (!raw) return { lastDocId: 0, tenant, processed: 0 };
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const lastDocId = Number(parsed?.lastDocId);
    const savedTenant = parsed?.tenant == null ? null : Number(parsed.tenant);
    // 换了租户过滤条件时游标不可复用（doc_id 全局递增但集合不同）。
    if ((savedTenant ?? null) !== (tenant ?? null)) {
      return { lastDocId: 0, tenant, processed: 0, discarded: "tenant_mismatch" };
    }
    return {
      lastDocId: Number.isSafeInteger(lastDocId) && lastDocId > 0 ? lastDocId : 0,
      tenant,
      processed: positiveInt(parsed?.processed, 0),
    };
  } catch {
    return { lastDocId: 0, tenant, processed: 0, discarded: "corrupt" };
  }
}

export function serializeCursor({ lastDocId, tenant = null, processed = 0 }) {
  return JSON.stringify({
    version: 1,
    lastDocId: Number(lastDocId) || 0,
    tenant: tenant ?? null,
    processed: Number(processed) || 0,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * 从待处理文档中选出本次批次：只取 id 大于游标的文档，按 id 升序，最多 limit 篇。
 * 返回 { batch, remaining, nextCursor }；nextCursor 为批次内最大 id（空批次沿用旧游标）。
 */
export function selectBackfillBatch(docs, { lastDocId = 0, limit = DEFAULT_BACKFILL_LIMIT } = {}) {
  const cursor = Number(lastDocId) || 0;
  const cap = positiveInt(limit, DEFAULT_BACKFILL_LIMIT);
  const eligible = (Array.isArray(docs) ? docs : [])
    .filter((doc) => Number.isSafeInteger(Number(doc?.id)) && Number(doc.id) > cursor)
    .sort((a, b) => Number(a.id) - Number(b.id));
  const batch = eligible.slice(0, cap);
  return {
    batch,
    remaining: Math.max(0, eligible.length - batch.length),
    nextCursor: batch.length ? Number(batch[batch.length - 1].id) : cursor,
  };
}

export function formatBackfillProgress({ processed, total, failed, docId = null }) {
  const done = Number(processed) || 0;
  const all = Number(total) || 0;
  const bad = Number(failed) || 0;
  const percent = all > 0 ? Math.round((done / all) * 100) : 100;
  return `[${done}/${all} ${percent}%] 失败 ${bad}${docId != null ? ` · 当前 doc#${docId}` : ""}`;
}

/** 按 SQL 语义列出“待向量化”的判定，供脚本与测试共用同一口径。 */
export function needsBackfill(doc, { chunkCount = 0, longDocChars = 700 } = {}) {
  const hasEmbedding = doc?.embedding != null && String(doc.embedding).trim() !== "";
  const bodyLength = String(doc?.body || "").length;
  if (!hasEmbedding) return true;
  return bodyLength > longDocChars && Number(chunkCount) === 0;
}
