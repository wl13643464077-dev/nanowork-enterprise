#!/usr/bin/env node
// 纳米Work行业版 · 版本化数据库迁移运行器
// 要点：
//   - 迁移文件放 scripts/migrations/NNNN-说明.mjs，导出 up(db) 与 down(db)（db 为 node:sqlite DatabaseSync）
//   - 已应用版本记录在业务库内的 schema_migrations 表（version, name, applied_at, checksum）
//   - 每次 up 前自动做 VACUUM INTO 快照（backups/migrate-<时间戳>.sqlite），快照失败则拒绝迁移
//   - 每个迁移在事务内执行，失败自动回滚该迁移；已应用文件禁止改动（checksum 校验）
//
// 用法（Node ≥ 22.12，与 server 同要求）：
//   node scripts/migrate.mjs status                # 查看已应用/待应用
//   node scripts/migrate.mjs up [目标版本号]       # 应用全部（或至目标版本）
//   node scripts/migrate.mjs down [步数=1]         # 回退最近 N 个迁移（需迁移实现 down）
//   node scripts/migrate.mjs create <说明>         # 生成新迁移文件骨架
//   NANOWORK_DB=/path/to.db node scripts/migrate.mjs up  # 指定库（默认 server/data/nanowork-industry.db）
//
// 生产迁移前必须先停止写入并完成独立数据库快照；本项目不继承来源项目的部署脚本。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { prepareDatabaseStorage } from "../server/src/engines/database-storage.js";
import { createPrivateArtifact, assertPrivateArtifact } from "../server/src/engines/private-artifact.js";

// 迁移快照、SQLite WAL/SHM 与新建文件默认仅当前用户可访问。
// 这里只设置进程 umask，不修改 /tmp 或自定义数据库父目录的权限。
process.umask(0o077);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const DATA_DIR = path.join(ROOT, "server", "data");
const DB_PATH =
  process.env.NANOWORK_DB || path.join(DATA_DIR, "nanowork-industry.db");
const SNAPSHOT_DIR =
  process.env.MIGRATE_SNAPSHOT_DIR || path.join(ROOT, "backups");

const [, , cmd = "status", arg] = process.argv;

function fail(msg) {
  console.error(`[migrate] ${msg}`);
  process.exit(1);
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}-[\w一-鿿.-]+\.mjs$/.test(f))
    .sort()
    .map((f) => {
      const version = Number(f.slice(0, 4));
      const source = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
      return {
        version,
        file: f,
        checksum: crypto
          .createHash("sha256")
          .update(source)
          .digest("hex")
          .slice(0, 16),
      };
    });
}

function openDb() {
  if (!fs.existsSync(DB_PATH) && cmd !== "create")
    fail(
      `数据库不存在：${DB_PATH}（首次建库由 server 启动时 initSchema 完成，迁移只做增量）`,
    );
  prepareDatabaseStorage({ databasePath: DB_PATH, dataDirectory: DATA_DIR,
    protectDataDirectory: process.env.NODE_ENV !== "test" });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT DEFAULT (datetime('now','localtime'))
  );`);
  return db;
}

function appliedRows(db) {
  return db
    .prepare(
      "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
    )
    .all();
}

function snapshot() {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(SNAPSHOT_DIR, `migrate-${stamp}.sqlite`);
  createPrivateArtifact(out);
  const src = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${out.replaceAll("'", "''")}'`);
  } finally {
    src.close();
  }
  const check = new DatabaseSync(out, { readOnly: true });
  try {
    const integrity = Object.values(
      check.prepare("PRAGMA integrity_check").get() || {},
    )[0];
    if (integrity !== "ok") {
      fs.rmSync(out, { force: true });
      fail(`迁移前快照完整性异常：${integrity}`);
    }
  } finally {
    check.close();
  }
  fs.chmodSync(out, 0o600);
  assertPrivateArtifact(out);
  console.log(`[migrate] 迁移前快照：${out}`);
  return out;
}

function verifyChecksums(db, files) {
  const applied = new Map(appliedRows(db).map((r) => [r.version, r]));
  for (const f of files) {
    const row = applied.get(f.version);
    if (row && row.checksum !== f.checksum) {
      fail(
        `迁移文件 ${f.file} 与已应用记录 checksum 不一致（已应用的迁移禁止修改；新的变更请新建迁移文件）`,
      );
    }
  }
  return applied;
}

async function loadMigration(file) {
  const mod = await import(pathToFileUrl(path.join(MIGRATIONS_DIR, file)));
  if (typeof mod.up !== "function") fail(`${file} 未导出 up(db)`);
  return mod;
}
function pathToFileUrl(p) {
  return "file://" + p.replace(/\\/g, "/");
}

async function cmdStatus() {
  const db = openDb();
  const files = listMigrationFiles();
  const applied = verifyChecksums(db, files);
  console.log(`数据库：${DB_PATH}`);
  if (!files.length) {
    console.log("（scripts/migrations/ 下暂无迁移文件）");
    return;
  }
  for (const f of files) {
    const row = applied.get(f.version);
    console.log(
      `${row ? "[已应用]" : "[待应用]"} ${f.file}${row ? `  @ ${row.applied_at}` : ""}`,
    );
  }
  db.close();
}

async function cmdUp() {
  const target = arg == null ? Infinity : Number(arg);
  if (Number.isNaN(target)) fail(`非法目标版本：${arg}`);
  const db = openDb();
  const files = listMigrationFiles();
  const applied = verifyChecksums(db, files);
  const pending = files.filter(
    (f) => !applied.has(f.version) && f.version <= target,
  );
  if (!pending.length) {
    console.log("[migrate] 无待应用迁移");
    db.close();
    return;
  }
  snapshot();
  const record = db.prepare(
    "INSERT INTO schema_migrations(version,name,checksum) VALUES(?,?,?)",
  );
  for (const f of pending) {
    const mod = await loadMigration(f.file);
    console.log(`[migrate] up ${f.file} ...`);
    db.exec("BEGIN");
    try {
      mod.up(db);
      record.run(f.version, f.file, f.checksum);
      db.exec("COMMIT");
      console.log(`[migrate] up ${f.file} 完成`);
    } catch (e) {
      db.exec("ROLLBACK");
      fail(
        `up ${f.file} 失败并已回滚本迁移：${e.message}\n（数据层面如需整体回退，请使用本次迁移前生成的快照）`,
      );
    }
  }
  db.close();
}

async function cmdDown() {
  const steps = arg == null ? 1 : Number(arg);
  if (!Number.isInteger(steps) || steps < 1) fail(`非法回退步数：${arg}`);
  const db = openDb();
  const files = new Map(listMigrationFiles().map((f) => [f.version, f]));
  const rows = appliedRows(db).reverse().slice(0, steps);
  if (!rows.length) {
    console.log("[migrate] 无已应用迁移可回退");
    db.close();
    return;
  }
  snapshot();
  const del = db.prepare("DELETE FROM schema_migrations WHERE version = ?");
  for (const row of rows) {
    const f = files.get(row.version);
    if (!f)
      fail(
        `找不到已应用迁移 ${row.version}（${row.name}）对应的文件，无法 down`,
      );
    const mod = await loadMigration(f.file);
    if (typeof mod.down !== "function")
      fail(`${f.file} 未实现 down(db)：该迁移只能用迁移前快照恢复`);
    console.log(`[migrate] down ${f.file} ...`);
    db.exec("BEGIN");
    try {
      mod.down(db);
      del.run(row.version);
      db.exec("COMMIT");
      console.log(`[migrate] down ${f.file} 完成`);
    } catch (e) {
      db.exec("ROLLBACK");
      fail(`down ${f.file} 失败并已回滚：${e.message}`);
    }
  }
  db.close();
}

function cmdCreate() {
  if (!arg)
    fail(
      "用法：node scripts/migrate.mjs create <一句话说明，如 add-index-leads-phone>",
    );
  fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
  const next = Math.max(0, ...listMigrationFiles().map((f) => f.version)) + 1;
  const slug = arg
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w一-鿿.-]/g, "");
  const file = path.join(
    MIGRATIONS_DIR,
    `${String(next).padStart(4, "0")}-${slug}.mjs`,
  );
  fs.writeFileSync(
    file,
    `// ${String(next).padStart(4, "0")}-${slug}
// up/down 必须幂等可重跑；
// 破坏性变更（DROP/改列语义）必须在 down 里给出还原路径，给不出就写清"仅能快照恢复"。

/** @param {import('node:sqlite').DatabaseSync} db */
export function up(db) {
  // db.exec(\`ALTER TABLE ... \`);
  throw new Error('尚未实现：请填写 up() 后再运行');
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function down(db) {
  // 与 up 严格互逆；无法互逆时抛错并注明用快照恢复
  throw new Error('尚未实现 down：该迁移只能用迁移前快照恢复');
}
`,
  );
  console.log(`[migrate] 已创建 ${file}`);
}

switch (cmd) {
  case "status":
    await cmdStatus();
    break;
  case "up":
    await cmdUp();
    break;
  case "down":
    await cmdDown();
    break;
  case "create":
    cmdCreate();
    break;
  default:
    fail(`未知命令：${cmd}（可用：status / up / down / create）`);
}
