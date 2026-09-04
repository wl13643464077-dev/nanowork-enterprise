// 测试临时 SQLite 库的安全清理。
//
// 背景：Windows 不允许删除仍被进程持有句柄的文件。db.js 的 DatabaseSync 单例在
// 进程退出前一直打开，after() 里直接 fs.rmSync(dbPath) 会抛 EPERM，把本来全绿的
// 测试文件标成 hookFailed。macOS/Linux 允许删打开中的文件，所以此前没暴露。
//
// 策略：先关闭 db.js 单例（释放句柄，WAL 模式关闭时会自动 checkpoint 并移除
// -wal/-shm），再删文件；仍遇到 EPERM/EBUSY 就短暂等待重试；最终失败只 warn 不抛，
// 因为临时文件残留不该让业务断言的结果失真。
import fs from "node:fs";
import path from "node:path";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
const DB_SUFFIXES = ["", "-wal", "-shm"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function warn(message) {
  console.warn(`[test/helpers/temp-db] ${message}`);
}

/**
 * 关闭 db.js 导出的共享连接（幂等）。
 *
 * 仅当 expectedDbPath 与当前进程的 NANOWORK_DB 一致时才动态 import db.js：
 * 该模块在 import 时就会按 NANOWORK_DB（缺省则是真实数据目录）建库，
 * 若测试根本没加载过 db.js，这里贸然 import 会凭空创建一个数据库。
 */
export async function closeSharedDb(expectedDbPath) {
  if (!expectedDbPath) return false;
  const current = process.env.NANOWORK_DB;
  if (!current || path.resolve(current) !== path.resolve(expectedDbPath)) {
    return false;
  }
  try {
    const mod = await import("../../src/db.js");
    if (path.resolve(mod.DB_PATH) !== path.resolve(expectedDbPath)) return false;
    mod.db.close();
    return true;
  } catch (err) {
    // ERR_INVALID_STATE：测试已自行 close；其他错误一律吞掉，清理不能失败测试
    if (err?.code !== "ERR_INVALID_STATE") {
      warn(`关闭共享数据库连接失败（已忽略）：${err?.code || err?.message || err}`);
    }
    return false;
  }
}

/**
 * 带重试的 fs.rmSync(force)。返回是否删除成功（目标不存在也算成功）。
 */
export async function removePathSafely(
  target,
  { recursive = false, attempts = 6, baseDelayMs = 40 } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.rmSync(target, { force: true, recursive });
      return true;
    } catch (err) {
      const code = err?.code;
      if (!RETRYABLE.has(code) || attempt === attempts) {
        warn(`临时文件清理失败（已忽略）：${target} → ${code || err?.message || err}`);
        return false;
      }
      await sleep(baseDelayMs * attempt);
    }
  }
  return false;
}

/**
 * 删除临时 SQLite 库（主文件 + -wal + -shm）。
 * 默认先尝试关闭 db.js 共享连接；传 { closeDb: false } 可跳过（例如测试已自行 close）。
 */
export async function removeTempDbSafely(dbPath, { closeDb = true, ...rmOptions } = {}) {
  if (!dbPath || dbPath === ":memory:") return true;
  if (closeDb) await closeSharedDb(dbPath);
  let ok = true;
  for (const suffix of DB_SUFFIXES) {
    ok = (await removePathSafely(`${dbPath}${suffix}`, rmOptions)) && ok;
  }
  return ok;
}

/**
 * 递归删除临时目录；若目录内有本进程打开的临时库，传 dbPath 以先关闭连接。
 */
export async function removeTempDirSafely(dir, { dbPath, ...rmOptions } = {}) {
  if (!dir) return true;
  if (dbPath) await removeTempDbSafely(dbPath, rmOptions);
  return removePathSafely(dir, { ...rmOptions, recursive: true });
}
