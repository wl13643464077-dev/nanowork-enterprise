#!/usr/bin/env node
// Creates a private migration snapshot. Never imports the application DB module.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const json = (value) =>
  JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
const inside = (root, candidate) =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);
function seedPasswordMatches(stored) {
  const [salt, hex] = String(stored || "").split(":");
  if (!salt || !/^[a-f0-9]{64}$/i.test(hex || "")) return false;
  return crypto.timingSafeEqual(
    crypto.scryptSync("123456", salt, 32),
    Buffer.from(hex, "hex"),
  );
}
function strongPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(password, salt, 32).toString("hex")}`;
}
function privateWrite(file, content) {
  fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
}
function readTables(db) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => {
      const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
      const order = columns
        .filter((column) => column.pk)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => quote(column.name));
      const rows = db
        .prepare(
          `SELECT * FROM ${quote(name)}${order.length ? ` ORDER BY ${order.join(",")}` : ""}`,
        )
        .all();
      return { name, columns, rows };
    });
}
function visitStrings(value, visit, pointer = "") {
  if (typeof value === "string") {
    // Some historical snapshots contain another JSON document as a string.
    let nested;
    try {
      nested = JSON.parse(value);
    } catch {
      /* plain business text */
    }
    if (nested && typeof nested === "object")
      return visitStrings(nested, visit, pointer);
    visit(value, pointer);
  } else if (Array.isArray(value))
    value.forEach((item, index) =>
      visitStrings(item, visit, `${pointer}/${index}`),
    );
  else if (value && typeof value === "object")
    Object.entries(value).forEach(([key, item]) =>
      visitStrings(item, visit, `${pointer}/${key}`),
    );
}
function migrateString(value, sourceRoot, destinationRoot) {
  if (typeof value !== "string") return value;
  const direct = value.replaceAll(`${sourceRoot}/`, `${destinationRoot}/`);
  if (direct !== value) return direct;
  // Covers escaped slash/unicode JSON storage without rewriting untouched JSON.
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  const rewrite = (item) =>
    typeof item === "string"
      ? migrateString(item, sourceRoot, destinationRoot)
      : Array.isArray(item)
        ? item.map(rewrite)
        : item && typeof item === "object"
          ? Object.fromEntries(
              Object.entries(item).map(([key, child]) => [key, rewrite(child)]),
            )
          : item;
  const next = rewrite(parsed);
  return json(next) === json(parsed) ? value : json(next);
}

export async function prepareDataMigration({
  source = path.join(ROOT, "server/data/nanowork-preview.db"),
  outputDir = "/private/tmp/namiwork-production-data-20260906",
  sourceDataRoot = path.dirname(source),
  destinationDataRoot = "/var/lib/nanowork/data",
} = {}) {
  source = fs.realpathSync(source);
  sourceDataRoot = fs.realpathSync(sourceDataRoot);
  outputDir = path.resolve(outputDir);
  destinationDataRoot = path.posix.normalize(destinationDataRoot);
  if (
    !path.isAbsolute(destinationDataRoot) ||
    inside(sourceDataRoot, outputDir)
  )
    throw new Error("迁移输出必须与源数据目录分离");
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  if (
    fs.lstatSync(outputDir).isSymbolicLink() ||
    !fs.statSync(outputDir).isDirectory()
  )
    throw new Error("输出目录必须为真实私有目录");
  fs.chmodSync(outputDir, 0o700);
  const destination = path.join(outputDir, "nanowork-industry.db");
  for (const name of [
    "nanowork-industry.db",
    "credentials.txt",
    "migration-report.json",
    "upload-manifest.json",
  ])
    if (fs.existsSync(path.join(outputDir, name)))
      throw new Error(
        "输出已存在，请使用新的私有目录；不会覆盖备份或重新生成凭据",
      );
  privateWrite(destination, "");
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(sourceDb, destination);
  } finally {
    sourceDb.close();
  }
  fs.chmodSync(destination, 0o600);
  const copy = new DatabaseSync(destination);
  const report = {
    createdAt: new Date().toISOString(),
    source,
    destination,
    sourceOpenedReadOnly: true,
    destinationDataRoot,
    status: "checking",
    errors: [],
    externalPaths: [],
    pathChanges: [],
    rotatedSeedAccounts: [],
  };
  const manifest = new Map();
  try {
    copy.exec("PRAGMA journal_mode=DELETE");
    const integrity = Object.values(
      copy.prepare("PRAGMA integrity_check").get(),
    )[0];
    if (integrity !== "ok") throw new Error("备份完整性校验失败");
    const before = readTables(copy);
    report.rowCounts = Object.fromEntries(
      before.map((table) => [table.name, table.rows.length]),
    );
    report.tenantBalances = (
      before.find((table) => table.name === "tenants")?.rows || []
    ).map(({ id, credits }) => ({ id, credits }));
    const users = before.find((table) => table.name === "users")?.rows || [];
    const userTenants = new Map(
      users.map((user) => [Number(user.id), Number(user.tenant_id)]),
    );
    const issues = new Set();
    const error = (code, context, details = {}) => {
      const item = { code, ...context, ...details };
      const key = json(item);
      if (!issues.has(key)) {
        issues.add(key);
        report.errors.push(item);
      }
    };
    const checkFile = (absolute, context, { tenantId, url } = {}) => {
      const resolved = path.resolve(absolute);
      if (!inside(sourceDataRoot, resolved)) {
        error("PATH_OUTSIDE_DATA", context, { path: absolute });
        return;
      }
      if (!fs.existsSync(resolved)) {
        error("FILE_MISSING", context, { path: absolute });
        return;
      }
      const real = fs.realpathSync(resolved);
      if (!inside(sourceDataRoot, real)) {
        error("SYMLINK_OUTSIDE_DATA", context, { path: absolute });
        return;
      }
      const stat = fs.statSync(real);
      if (!stat.isFile()) {
        error("NOT_A_FILE", context, { path: absolute });
        return;
      }
      const relative = path
        .relative(sourceDataRoot, resolved)
        .split(path.sep)
        .join("/");
      const tenantMatch = relative.match(
        /^uploads\/(?:files|ai-sales-video|avatar|avatars)\/(\d+)(?:\/|$)/,
      );
      if (
        tenantMatch &&
        tenantId != null &&
        Number(tenantMatch[1]) !== Number(tenantId)
      )
        error("PATH_TENANT_MISMATCH", context, { path: absolute });
      if (!manifest.has(relative))
        manifest.set(relative, {
          relative,
          bytes: stat.size,
          sha256: hash(fs.readFileSync(real)),
          ...(url ? { url } : {}),
          references: [],
        });
      manifest.get(relative).references.push(context);
    };
    for (const table of before)
      for (const row of table.rows) {
        const context = {
          table: table.name,
          id: row.id ?? null,
          tenantId: row.tenant_id ?? null,
        };
        if (table.name === "uploaded_files") {
          if (userTenants.get(Number(row.user_id)) !== Number(row.tenant_id))
            error("UPLOAD_OWNER_TENANT_MISMATCH", context);
          if (!row.file_path) error("UPLOAD_PATH_MISSING", context);
          else
            checkFile(row.file_path, context, {
              tenantId: row.tenant_id,
              url: row.file_url,
            });
          if (row.file_url?.startsWith("/uploads/")) {
            let local;
            try {
              local = path.resolve(
                sourceDataRoot,
                `.${decodeURIComponent(row.file_url.split(/[?#]/)[0])}`,
              );
            } catch {
              error("UPLOAD_URL_INVALID", context);
            }
            if (local && path.resolve(row.file_path || "") !== local)
              error("UPLOAD_URL_PATH_MISMATCH", context);
          } else error("UPLOAD_URL_NOT_LOCAL", context);
        }
        for (const [column, value] of Object.entries(row))
          if (typeof value === "string")
            visitStrings(value, (text, pointer) => {
              const ref = { ...context, column, pointer };
              if (text.startsWith(sourceDataRoot + "/"))
                checkFile(text, ref, { tenantId: row.tenant_id });
              else if (
                /^\/(?:Users|private|tmp|home|var\/folders|opt)\//.test(text)
              )
                report.externalPaths.push({
                  ...ref,
                  path: text.split(/[?#\n]/)[0],
                });
              const urls =
                text.match(/\/uploads\/[^\s\x22\x27`<>\[\]{}()]+/g) || [];
              for (const url of urls) {
                // Absolute source paths are already checked, not a second URL reference.
                if (text.startsWith(sourceDataRoot + "/")) continue;
                let decoded;
                try {
                  decoded = decodeURIComponent(url.split(/[?#]/)[0]);
                } catch {
                  error("LOCAL_URL_INVALID", ref);
                  continue;
                }
                checkFile(path.resolve(sourceDataRoot, `.${decoded}`), ref, {
                  tenantId: row.tenant_id,
                  url,
                });
              }
            });
      }
    report.uploadedFileCount = report.rowCounts.uploaded_files || 0;
    report.verifiedLocalFileCount = manifest.size;
    if (report.errors.length) {
      report.status = "blocked_missing_or_unsafe_files";
      privateWrite(
        path.join(outputDir, "migration-report.json"),
        JSON.stringify(report, null, 2),
      );
      privateWrite(
        path.join(outputDir, "upload-manifest.json"),
        JSON.stringify([...manifest.values()], null, 2),
      );
      return report;
    }
    const changedOriginals = new Map();
    const credentials = [];
    copy.exec("BEGIN IMMEDIATE");
    try {
      for (const table of before) {
        const primary = table.columns
          .filter((column) => column.pk)
          .sort((a, b) => a.pk - b.pk)
          .map((column) => column.name);
        for (let index = 0; index < table.rows.length; index++) {
          const row = table.rows[index],
            changes = {};
          for (const [column, value] of Object.entries(row)) {
            const migrated = migrateString(
              value,
              sourceDataRoot,
              destinationDataRoot,
            );
            if (migrated !== value) {
              changes[column] = migrated;
              report.pathChanges.push({
                table: table.name,
                id: row.id ?? null,
                column,
              });
            }
          }
          if (
            table.name === "users" &&
            seedPasswordMatches(row.password_hash)
          ) {
            const password = crypto.randomBytes(24).toString("base64url");
            changes.password_hash = strongPasswordHash(password);
            changes.auth_version = Number(row.auth_version || 0) + 1;
            credentials.push({
              id: row.id,
              tenantId: row.tenant_id,
              username: row.username,
              role: row.role,
              password,
            });
            report.rotatedSeedAccounts.push({
              id: row.id,
              tenantId: row.tenant_id,
              role: row.role,
            });
          }
          if (!Object.keys(changes).length) continue;
          if (!primary.length)
            throw new Error(`需迁移的表缺少主键：${table.name}`);
          copy
            .prepare(
              `UPDATE ${quote(table.name)} SET ${Object.keys(changes)
                .map((column) => `${quote(column)}=?`)
                .join(
                  ",",
                )} WHERE ${primary.map((column) => `${quote(column)} IS ?`).join(" AND ")}`,
            )
            .run(
              ...Object.values(changes),
              ...primary.map((column) => row[column]),
            );
          changedOriginals.set(
            `${table.name}:${index}`,
            Object.fromEntries(
              Object.keys(changes).map((column) => [column, row[column]]),
            ),
          );
        }
      }
      const after = readTables(copy);
      for (let t = 0; t < before.length; t++) {
        const table = after[t];
        for (let index = 0; index < table.rows.length; index++)
          Object.assign(
            table.rows[index],
            changedOriginals.get(`${table.name}:${index}`) || {},
          );
        if (hash(json(table.rows)) !== hash(json(before[t].rows)))
          throw new Error(`非授权数据变动：${table.name}`);
      }
      copy.exec("COMMIT");
    } catch (error) {
      copy.exec("ROLLBACK");
      throw error;
    }
    report.preservedAllRowsAndOtherValues = true;
    report.status = report.externalPaths.length
      ? "ready_with_external_path_review"
      : "ready";
    report.integrity = Object.values(
      copy.prepare("PRAGMA integrity_check").get(),
    )[0];
    report.changedPasswordCount = credentials.length;
    const secretText = [
      "纳米Work 新公网实例初始凭据（仅限私密交付）",
      "仅列出与公开种子密码完全匹配并在迁移副本中已重置的账户。",
      "本机账户未修改；其他已有密码保持不变。",
      "",
      ...credentials.flatMap((item) => [
        `账号：${item.username}`,
        `租户：${item.tenantId}；角色：${item.role}；用户ID：${item.id}`,
        `初始密码：${item.password}`,
        "",
      ]),
    ].join("\n");
    privateWrite(path.join(outputDir, "credentials.txt"), secretText);
    privateWrite(
      path.join(outputDir, "upload-manifest.json"),
      JSON.stringify([...manifest.values()], null, 2),
    );
  } finally {
    copy.close();
    fs.chmodSync(destination, 0o600);
  }
  report.databaseSha256 = hash(fs.readFileSync(destination));
  privateWrite(
    path.join(outputDir, "migration-report.json"),
    JSON.stringify(report, null, 2),
  );
  return report;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((item) => {
      const [key, ...value] = item.replace(/^--/, "").split("=");
      return [key, value.join("=")];
    }),
  );
  const report = await prepareDataMigration({
    ...(args.source ? { source: args.source } : {}),
    ...(args.output ? { outputDir: args.output } : {}),
    ...(args["data-root"] ? { sourceDataRoot: args["data-root"] } : {}),
    ...(args["destination-data-root"]
      ? { destinationDataRoot: args["destination-data-root"] }
      : {}),
  });
  console.log(
    JSON.stringify({
      status: report.status,
      destination: report.destination,
      uploadedFileCount: report.uploadedFileCount,
      verifiedLocalFileCount: report.verifiedLocalFileCount,
      pathChanges: report.pathChanges.length,
      changedPasswordCount: report.changedPasswordCount,
      errors: report.errors.length,
      externalPaths: report.externalPaths.length,
    }),
  );
  if (report.status.startsWith("blocked")) process.exitCode = 1;
}
