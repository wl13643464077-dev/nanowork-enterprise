#!/usr/bin/env node
// 纳米Work行业版 · 生产/公网演示环境启动前自检
//
// 用法：
//   node scripts/preflight-production.mjs [--env-file /etc/nanowork/server.env] [--json] [--quiet] [--min-free-gb 2]
//
// 不加 --env-file 时只看 process.env（systemd ExecStartPre 场景：EnvironmentFile 已注入）。
// 加 --env-file 时按 server/src/env.js 同样的规则解析文件，process.env 里已有的键优先。
//
// 退出码：0 = 无 FAIL（可有 WARN）；1 = 存在 FAIL；2 = 参数错误。
// 只读检查，不连接任何外部服务，不打印任何密钥值。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SERVER_DIR = path.join(ROOT, "server");
const DATA_DIR = path.join(SERVER_DIR, "data");
const WEB_DIST = path.join(ROOT, "web", "dist");

const args = process.argv.slice(2);
const opts = { envFile: null, json: false, quiet: false, minFreeGb: 2 };
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") {
    printHelp();
    process.exit(0);
  } else if (arg === "--env-file") {
    opts.envFile = args[++i];
    if (!opts.envFile) usageError("--env-file 需要路径");
  } else if (arg.startsWith("--env-file=")) {
    opts.envFile = arg.slice("--env-file=".length);
  } else if (arg === "--json") {
    opts.json = true;
  } else if (arg === "--quiet") {
    opts.quiet = true;
  } else if (arg === "--min-free-gb") {
    opts.minFreeGb = Number(args[++i]);
    if (!Number.isFinite(opts.minFreeGb) || opts.minFreeGb < 0) usageError("--min-free-gb 需要非负数字");
  } else if (arg.startsWith("--min-free-gb=")) {
    opts.minFreeGb = Number(arg.slice("--min-free-gb=".length));
  } else {
    usageError(`未知参数：${arg}`);
  }
}

function printHelp() {
  console.log(`用法：node scripts/preflight-production.mjs [选项]

选项：
  --env-file <path>   解析 KEY=value 文件并合并进 process.env（已存在的键不覆盖）
  --json              以 JSON 输出全部检查结果
  --quiet             只输出 WARN/FAIL 与总结
  --min-free-gb <n>   data 目录所在磁盘最少剩余空间（默认 2）
  -h, --help          显示帮助

检查项：Node 版本、NODE_ENV、必填 env、JWT_SECRET 强度、超管密码、SEED_DEMO、TZ、HOST/TRUST_PROXY/CORS/PUBLIC_BASE_URL、
        调度器开关、AI 通道、高德 Web 服务（未配置只 WARN）、ffmpeg/ffprobe/pdftoppm、中文字体、data 目录与数据库权限、
        写入测试、磁盘余量、web/dist、node_modules。`);
}

function usageError(message) {
  console.error(`[preflight] ${message}`);
  console.error("使用 --help 查看用法");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// env 加载（与 server/src/env.js 同规则）
// ---------------------------------------------------------------------------
if (opts.envFile) {
  const resolved = path.resolve(opts.envFile);
  if (!fs.existsSync(resolved)) usageError(`env 文件不存在：${resolved}`);
  for (const line of fs.readFileSync(resolved, "utf8").split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("#") || !value.includes("=")) continue;
    const separator = value.indexOf("=");
    const key = value.slice(0, separator).trim();
    const raw = value.slice(separator + 1).trim();
    const parsed =
      raw.length >= 2 && raw[0] === raw.at(-1) && ['"', "'"].includes(raw[0]) ? raw.slice(1, -1) : raw;
    if (key && process.env[key] == null) process.env[key] = parsed;
  }
}
const env = process.env;

// ---------------------------------------------------------------------------
// 结果收集
// ---------------------------------------------------------------------------
const results = [];
const record = (status, key, message, detail) => {
  results.push({ status, key, message, ...(detail ? { detail } : {}) });
};
const pass = (key, message, detail) => record("PASS", key, message, detail);
const warn = (key, message, detail) => record("WARN", key, message, detail);
const fail = (key, message, detail) => record("FAIL", key, message, detail);
const present = (key) => String(env[key] || "").trim().length > 0;

function which(binary) {
  if (!binary) return null;
  if (binary.includes("/") || binary.includes("\\")) {
    return fs.existsSync(binary) ? binary : null;
  }
  const dirs = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, binary + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep searching */
      }
    }
  }
  return null;
}

function runVersion(binary, argsList = ["-version"]) {
  try {
    const result = spawnSync(binary, argsList, { encoding: "utf8", timeout: 5000 });
    if (result.status !== 0) return null;
    return String(result.stdout || result.stderr || "").split(/\r?\n/)[0].slice(0, 120);
  } catch {
    return null;
  }
}

function modeOf(target) {
  try {
    const stat = fs.statSync(target);
    return { mode: stat.mode & 0o777, uid: stat.uid, isDir: stat.isDirectory(), isFile: stat.isFile() };
  } catch {
    return null;
  }
}

const octal = (mode) => `0${mode.toString(8)}`;

// ---------------------------------------------------------------------------
// 1. Node 版本
// ---------------------------------------------------------------------------
{
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    fail("node", `Node ${process.version} 过低，需要 ≥ 22.12（node:sqlite）`);
  } else if (major < 24) {
    warn("node", `Node ${process.version} 可用，但建议与 CI 一致使用 24.x LTS`);
  } else {
    pass("node", `Node ${process.version}`);
  }
  try {
    await import("node:sqlite");
    pass("node:sqlite", "node:sqlite 可加载");
  } catch (error) {
    fail("node:sqlite", `node:sqlite 无法加载：${error?.message || error}`);
  }
}

// ---------------------------------------------------------------------------
// 2. NODE_ENV / 必填 env
// ---------------------------------------------------------------------------
if (env.NODE_ENV === "production") {
  pass("NODE_ENV", "production");
} else {
  fail("NODE_ENV", `NODE_ENV=${env.NODE_ENV || "(未设置)"}，公网环境必须为 production`);
}

for (const key of ["HOST", "PORT", "PUBLIC_BASE_URL", "CORS_ORIGINS", "TRUST_PROXY"]) {
  if (!present(key)) fail(`env:${key}`, `${key} 未设置`);
}

// ---------------------------------------------------------------------------
// 3. JWT_SECRET / 超管密码（复用 server/src/security-config.js 的规则，纯函数无副作用）
// ---------------------------------------------------------------------------
let securityConfig = null;
try {
  securityConfig = await import(pathToFileURL(path.join(SERVER_DIR, "src", "security-config.js")).href);
} catch (error) {
  warn("security-config", `无法加载 server/src/security-config.js（${error?.message || error}），退回内置规则`);
}
const jwtSecretStrengthError =
  securityConfig?.jwtSecretStrengthError ||
  ((value) => {
    const secret = String(value || "");
    if (Buffer.byteLength(secret, "utf8") < 32) return "必须至少 32 字节";
    if (new Set([...secret]).size < 8) return "字符变化不足";
    if (/(change.?me|replace.?me|example|password|secret|please.?rotate|在此|请填写|占位)/i.test(secret)) return "不能使用示例或占位值";
    return "";
  });
const platformSuperPasswordStrengthError =
  securityConfig?.platformSuperPasswordStrengthError ||
  ((value) => {
    const password = String(value || "");
    if (password.length < 12) return "必须至少 12 位";
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((p) => p.test(password)).length;
    if (classes < 3) return "必须包含大小写字母、数字、特殊字符中的至少三类";
    return "";
  });

{
  const problem = jwtSecretStrengthError(env.JWT_SECRET);
  if (problem) fail("JWT_SECRET", `JWT_SECRET ${problem}（生成：openssl rand -base64 48）`);
  else pass("JWT_SECRET", `长度 ${Buffer.byteLength(env.JWT_SECRET, "utf8")} 字节，强度通过`);
}

// ---------------------------------------------------------------------------
// 4. 数据库路径、data 目录权限、超管是否已存在
// ---------------------------------------------------------------------------
const dbPath = String(env.NANOWORK_DB || "").trim() || path.join(DATA_DIR, "nanowork-industry.db");
let hasPlatformSuper = null;
{
  const dataStat = modeOf(DATA_DIR);
  let realData = null;
  try {
    realData = fs.realpathSync(DATA_DIR);
  } catch {
    /* missing */
  }
  if (!dataStat) {
    warn("data-dir", `${DATA_DIR} 不存在（首次启动会自动创建为 0700；生产建议先由 deploy.sh 建成指向 /var/lib/nanowork/data 的符号链接）`);
  } else if (!dataStat.isDir) {
    fail("data-dir", `${DATA_DIR} 不是目录`);
  } else {
    const isLink = fs.lstatSync(DATA_DIR).isSymbolicLink();
    const where = isLink ? `${DATA_DIR} -> ${realData}` : DATA_DIR;
    if (process.platform !== "win32" && dataStat.mode !== 0o700) {
      fail("data-dir", `${where} 权限 ${octal(dataStat.mode)}，要求 0700`);
    } else {
      pass("data-dir", `${where}${process.platform === "win32" ? "" : ` 权限 ${octal(dataStat.mode)}`}`);
    }
    if (process.platform !== "win32" && typeof process.getuid === "function" && dataStat.uid !== process.getuid()) {
      warn("data-dir:owner", `data 目录属主 uid=${dataStat.uid} 与当前进程 uid=${process.getuid()} 不同；若不是以 nanowork 用户运行本检查可忽略`);
    }
    if (dbPath !== ":memory:") {
      const dbDir = path.dirname(dbPath);
      let dbDirReal = null;
      try {
        dbDirReal = fs.realpathSync(dbDir);
      } catch {
        /* missing */
      }
      if (realData && dbDirReal && dbDirReal !== realData && !dbDirReal.startsWith(realData + path.sep)) {
        warn("db-path", `NANOWORK_DB 所在目录 ${dbDirReal} 与 server/data 实际目录 ${realData} 不同；备份脚本会以 NANOWORK_DB 为准，uploads 仍在 server/data/uploads`);
      }
    }
    // 写入测试：进程能否在 data 目录建文件（systemd ReadWritePaths 是否放开）
    const probe = path.join(DATA_DIR, `.preflight-${process.pid}`);
    try {
      fs.writeFileSync(probe, "ok", { mode: 0o600 });
      fs.rmSync(probe, { force: true });
      pass("data-dir:write", "data 目录可写");
    } catch (error) {
      fail("data-dir:write", `data 目录不可写：${error?.message || error}`);
    }
  }

  if (dbPath === ":memory:") {
    fail("db", "NANOWORK_DB=:memory: 不能用于生产");
  } else {
    const dbStat = modeOf(dbPath);
    if (!dbStat) {
      warn("db", `数据库尚不存在：${dbPath}（首次启动将创建；需要 PLATFORM_SUPER_PASSWORD）`);
      hasPlatformSuper = false;
    } else if (!dbStat.isFile) {
      fail("db", `${dbPath} 不是文件`);
    } else {
      if (process.platform !== "win32" && dbStat.mode !== 0o600) {
        fail("db", `${dbPath} 权限 ${octal(dbStat.mode)}，要求 0600`);
      } else {
        pass("db", `${dbPath}（${Math.round(fs.statSync(dbPath).size / 1024 / 1024)} MB）`);
      }
      for (const suffix of ["-wal", "-shm"]) {
        const side = modeOf(`${dbPath}${suffix}`);
        if (side && process.platform !== "win32" && side.mode !== 0o600) {
          warn("db:sidecar", `${dbPath}${suffix} 权限 ${octal(side.mode)}，服务启动时会自动改为 0600`);
        }
      }
      try {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          const integrity = Object.values(db.prepare("PRAGMA quick_check").get() || {})[0];
          if (integrity === "ok") pass("db:quick_check", "PRAGMA quick_check = ok");
          else fail("db:quick_check", `PRAGMA quick_check = ${integrity}`);
          const hasUsers = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
          if (hasUsers) {
            hasPlatformSuper = Boolean(db.prepare("SELECT id FROM users WHERE role='platform_super' LIMIT 1").get());
            pass("db:platform_super", hasPlatformSuper ? "已存在 platform_super 账号" : "尚无 platform_super（首次启动会按 env 创建）");
          } else {
            hasPlatformSuper = false;
          }
        } finally {
          db.close();
        }
      } catch (error) {
        warn("db:open", `只读打开数据库失败：${error?.message || error}（服务运行中且 WAL 被锁时可忽略）`);
      }
    }
  }
}

{
  const configured = String(env.PLATFORM_SUPER_PASSWORD || "");
  if (configured) {
    const problem = platformSuperPasswordStrengthError(configured);
    if (problem) fail("PLATFORM_SUPER_PASSWORD", `超管密码 ${problem}`);
    else pass("PLATFORM_SUPER_PASSWORD", `已设置（用户名 ${env.PLATFORM_SUPER_USERNAME || "super"}），强度通过`);
  } else if (hasPlatformSuper === false) {
    fail("PLATFORM_SUPER_PASSWORD", "库中尚无 platform_super，首次启动必须提供 PLATFORM_SUPER_PASSWORD");
  } else {
    warn("PLATFORM_SUPER_PASSWORD", "未设置；仅当库中已有 platform_super 时可省略（deploy.sh 的就绪矩阵登录会需要它）");
  }
}

// ---------------------------------------------------------------------------
// 5. SEED_DEMO / 调度器 / 时区
// ---------------------------------------------------------------------------
if (String(env.SEED_DEMO || "").trim() === "true") {
  fail("SEED_DEMO", "SEED_DEMO=true 在 production 会直接抛错退出；演示租户请用 scripts/provision-demo-tenants.mjs");
} else {
  pass("SEED_DEMO", "未开启");
}

{
  const enabled = /^(?:1|true|yes|on)$/i.test(String(env.ENABLE_SCHEDULER || "").trim());
  const maxConcurrent = Number.parseInt(String(env.SCHEDULER_MAX_CONCURRENT || ""), 10);
  (enabled ? pass : warn)(
    "ENABLE_SCHEDULER",
    enabled
      ? `调度器开启（并发 ${Number.isInteger(maxConcurrent) && maxConcurrent > 0 ? Math.min(16, maxConcurrent) : 2}）；请确认已先做一次 backup.sh`
      : "调度器关闭：自动内容任务/定时规则不会运行（演示需要时设 ENABLE_SCHEDULER=true 并重启）",
  );
}

{
  const offsetMinutes = -new Date().getTimezoneOffset();
  if (env.TZ !== "Asia/Shanghai") {
    fail("TZ", `TZ=${env.TZ || "(未设置)"}，必须为 Asia/Shanghai（systemd 单元 Environment=TZ=Asia/Shanghai）`);
  } else if (offsetMinutes !== 480) {
    fail("TZ", `TZ=Asia/Shanghai 但进程实际偏移 UTC${offsetMinutes >= 0 ? "+" : ""}${offsetMinutes / 60}；检查 tzdata 是否安装`);
  } else {
    pass("TZ", "Asia/Shanghai（UTC+8）");
  }
}

// ---------------------------------------------------------------------------
// 6. 网络边界：HOST / TRUST_PROXY / CORS / PUBLIC_BASE_URL
// ---------------------------------------------------------------------------
{
  const host = String(env.HOST || "127.0.0.1").trim();
  if (["127.0.0.1", "localhost", "::1"].includes(host)) pass("HOST", `${host}:${env.PORT || 3107}（仅回环，公网由 Caddy 反代）`);
  else warn("HOST", `HOST=${host} 会直接暴露到网卡；若已由防火墙限制可忽略，否则改回 127.0.0.1`);

  const trust = String(env.TRUST_PROXY || "loopback").trim();
  if (/^\d+$/.test(trust)) {
    (Number(trust) === 1 ? pass : warn)("TRUST_PROXY", `TRUST_PROXY=${trust}${Number(trust) === 1 ? "（一跳：同机 Caddy）" : "，请确认代理层数确实如此"}`);
  } else if (trust === "loopback") {
    pass("TRUST_PROXY", "loopback（Caddy 在同机时等效于 1）");
  } else {
    warn("TRUST_PROXY", `TRUST_PROXY=${trust}，请确认与真实代理拓扑一致`);
  }

  const origins = String(env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!origins.length) {
    fail("CORS_ORIGINS", "为空：production 下不放行 localhost，浏览器/桌面端跨源请求会被拒");
  } else {
    const bad = origins.filter((o) => !/^https:\/\/[^/]+$/.test(o));
    if (bad.length) fail("CORS_ORIGINS", `以下 origin 不是 https 且不含路径：${bad.join(", ")}`);
    else pass("CORS_ORIGINS", origins.join(", "));
  }

  for (const key of ["PUBLIC_BASE_URL", "APP_PUBLIC_URL"]) {
    const value = String(env[key] || "").trim();
    if (!value) {
      (key === "PUBLIC_BASE_URL" ? fail : warn)(key, `${key} 未设置（生产下 routes/system.js 生成回调地址需要）`);
      continue;
    }
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") fail(key, `${key} 必须是 https://`);
      else if (url.pathname !== "/" || url.search || url.hash) warn(key, `${key} 建议只填协议+域名`);
      else if (origins.length && !origins.includes(url.origin)) warn(key, `${key} 的 origin 不在 CORS_ORIGINS 中`);
      else pass(key, url.origin);
    } catch {
      fail(key, `${key} 不是合法 URL`);
    }
  }
}

// ---------------------------------------------------------------------------
// 7. AI 通道（只检查是否配置，不外呼）
// ---------------------------------------------------------------------------
if (present("YUNWU_API_KEY")) {
  const base = String(env.YUNWU_BASE_URL || "").trim();
  if (base && !/^https:\/\//.test(base)) fail("YUNWU_BASE_URL", "生产下 API BaseURL 必须为 https");
  else pass("AI", `YUNWU_API_KEY 已配置（${base || "默认 base"}）；连接测试需在管理后台显式执行`);
} else if (present("ANTHROPIC_API_KEY")) {
  pass("AI", "ANTHROPIC_API_KEY 已配置");
} else {
  warn("AI", "未配置任何 AI 通道：数字员工将走本地模板底稿，无法演示真实生成");
}

// ---------------------------------------------------------------------------
// 7b. 高德 Web 服务（第 9 通道，选址/商圈岗位）：未配置只 WARN，不阻塞启动
// ---------------------------------------------------------------------------
{
  if (present("AMAP_WEB_KEY")) {
    const base = String(env.AMAP_BASE_URL || "").trim();
    if (base && !/^https:\/\//.test(base)) {
      warn("AMAP", `AMAP_BASE_URL=${base} 不是 https，运行时会忽略并回默认 https://restapi.amap.com`);
    } else {
      pass("AMAP", `AMAP_WEB_KEY 已配置（${base || "默认 base"}）；连接测试需在 管理后台 → 接口管理 显式执行（10009 = Key 平台类型不是“Web服务”）`);
    }
  } else {
    warn("AMAP", "未配置 AMAP_WEB_KEY：选址岗位 101/102/104 回落 OSM 与公开检索，报告会如实标注“未接入高德实时数据”");
  }
  const idx = String(env.NANOWORK_TRADE_AREA_EMPLOYEE_IDX || "").trim();
  if (idx) {
    const parsed = idx.split(",").map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
    if (!parsed.length) warn("NANOWORK_TRADE_AREA_EMPLOYEE_IDX", `“${idx}” 解析不出任何岗位序号，运行时会回默认 101,102,104`);
    else pass("NANOWORK_TRADE_AREA_EMPLOYEE_IDX", `商圈事实触发岗位：${parsed.join(",")}`);
  }
}

// ---------------------------------------------------------------------------
// 8. 外部可执行文件：ffmpeg / ffprobe / pdftoppm
// ---------------------------------------------------------------------------
{
  const ffmpeg = which(String(env.FFMPEG_PATH || "").trim() || "ffmpeg");
  const ffprobe = which(String(env.FFPROBE_PATH || "").trim() || "ffprobe");
  if (ffmpeg) {
    const v = runVersion(ffmpeg);
    (v ? pass : fail)("ffmpeg", v ? `${ffmpeg}：${v}` : `${ffmpeg} 存在但执行失败`);
  } else {
    fail("ffmpeg", "找不到 ffmpeg（AI 带货视频/文字视频合成依赖）；apt install ffmpeg 或设置 FFMPEG_PATH");
  }
  if (ffprobe) {
    const v = runVersion(ffprobe);
    (v ? pass : fail)("ffprobe", v ? `${ffprobe}：${v}` : `${ffprobe} 存在但执行失败`);
  } else {
    fail("ffprobe", "找不到 ffprobe；apt install ffmpeg 或设置 FFPROBE_PATH");
  }
  const pdftoppm = which("pdftoppm");
  if (pdftoppm) pass("pdftoppm", `${pdftoppm}（poppler-utils，与 CI 一致）`);
  else warn("pdftoppm", "找不到 pdftoppm（服务端运行时不直接调用，但与 CI 依赖不一致；apt install poppler-utils）");
}

// ---------------------------------------------------------------------------
// 9. 中文字体：PDF/DOCX 需要单文件 TTF/OTF；ffmpeg drawtext 需要 fontconfig 可见 Noto Sans CJK SC
// ---------------------------------------------------------------------------
{
  const FONT_SIGNATURES = new Set(["00010000", "4f54544f", "74727565"]); // TrueType / OTTO / 'true'
  const inspect = (file) => {
    if (!file) return { ok: false, reason: "未设置" };
    if (!fs.existsSync(file)) return { ok: false, reason: "文件不存在" };
    const ext = path.extname(file).toLowerCase();
    if (![".ttf", ".otf"].includes(ext)) return { ok: false, reason: `扩展名 ${ext || "(无)"} 不受支持（不支持 TTC/WOFF）` };
    const fd = fs.openSync(file, "r");
    try {
      const header = Buffer.alloc(4);
      fs.readSync(fd, header, 0, 4, 0);
      if (!FONT_SIGNATURES.has(header.toString("hex"))) return { ok: false, reason: "不是标准 TrueType/OpenType 文件头" };
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true };
  };
  const candidates = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.otf",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttf",
    "/usr/local/share/fonts/NotoSansCJK-Regular.otf",
  ];
  for (const key of ["PDF_FONT_PATH", "DOCX_FONT_PATH"]) {
    const configured = String(env[key] || "").trim();
    if (configured) {
      const check = inspect(configured);
      (check.ok ? pass : fail)(key, check.ok ? configured : `${configured}：${check.reason}`);
    } else {
      const found = candidates.find((c) => inspect(c).ok);
      if (found) pass(key, `未设置，自动探测到 ${found}`);
      else if (key === "PDF_FONT_PATH") fail(key, "未设置且系统无可嵌入的单文件中文字体（fonts-noto-cjk 的 .ttc 不算）；运行 install-ubuntu.sh 或设置 PDF_FONT_PATH");
      else warn(key, "未设置；DOCX 渲染将回退 PDF_FONT_PATH");
    }
  }
  const fcList = which("fc-list");
  if (fcList) {
    const out = spawnSync(fcList, [], { encoding: "utf8", timeout: 8000 });
    if (/Noto Sans CJK SC/i.test(out.stdout || "")) pass("fontconfig", "Noto Sans CJK SC 可被 ffmpeg drawtext 使用");
    else warn("fontconfig", "fontconfig 未列出 Noto Sans CJK SC（apt install fonts-noto-cjk），文字视频字幕可能回退其他字体");
  } else {
    warn("fontconfig", "找不到 fc-list，无法确认 ffmpeg drawtext 字体");
  }
}

// ---------------------------------------------------------------------------
// 10. 磁盘余量、web/dist、node_modules、迁移快照目录
// ---------------------------------------------------------------------------
{
  const target = fs.existsSync(DATA_DIR) ? DATA_DIR : fs.existsSync(path.dirname(dbPath)) ? path.dirname(dbPath) : SERVER_DIR;
  try {
    const stat = fs.statfsSync(target);
    const freeGb = (stat.bavail * stat.bsize) / 1024 ** 3;
    const totalGb = (stat.blocks * stat.bsize) / 1024 ** 3;
    const message = `${target} 所在磁盘剩余 ${freeGb.toFixed(1)} GB / ${totalGb.toFixed(1)} GB`;
    if (freeGb < opts.minFreeGb) fail("disk", `${message}，低于阈值 ${opts.minFreeGb} GB`);
    else if (freeGb < opts.minFreeGb * 2) warn("disk", `${message}，接近阈值`);
    else pass("disk", message);
  } catch (error) {
    warn("disk", `无法读取磁盘信息：${error?.message || error}`);
  }

  const memGb = os.totalmem() / 1024 ** 3;
  (memGb < 3.5 ? warn : pass)("memory", `物理内存 ${memGb.toFixed(1)} GB${memGb < 3.5 ? "：低于 4 GB，视频合成与前端构建可能 OOM（建议服务器上不构建前端，改用 deploy.sh --dist）" : ""}`);

  if (fs.existsSync(path.join(WEB_DIST, "index.html"))) pass("web/dist", "前端产物存在，Express 将同进程托管 SPA");
  else warn("web/dist", "web/dist/index.html 不存在：仅 API 可用，浏览器访问根路径会 404");

  if (fs.existsSync(path.join(SERVER_DIR, "node_modules", "express"))) pass("node_modules", "server/node_modules 已安装");
  else fail("node_modules", "server/node_modules 缺失：先执行 npm ci --omit=dev --prefix server");

  const snapshotDir = String(env.MIGRATE_SNAPSHOT_DIR || "").trim();
  if (!snapshotDir) warn("MIGRATE_SNAPSHOT_DIR", "未设置；scripts/migrate.mjs 会写到代码目录 backups/，在 ProtectSystem=strict 下会失败");
  else if (!fs.existsSync(snapshotDir)) warn("MIGRATE_SNAPSHOT_DIR", `${snapshotDir} 不存在（migrate.mjs 会尝试创建）`);
  else pass("MIGRATE_SNAPSHOT_DIR", snapshotDir);
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
const counts = { PASS: 0, WARN: 0, FAIL: 0 };
for (const item of results) counts[item.status] += 1;

if (opts.json) {
  console.log(JSON.stringify({ ok: counts.FAIL === 0, counts, results }, null, 2));
} else {
  const color = { PASS: "\x1b[32m", WARN: "\x1b[33m", FAIL: "\x1b[31m" };
  const reset = "\x1b[0m";
  const tty = process.stdout.isTTY;
  for (const item of results) {
    if (opts.quiet && item.status === "PASS") continue;
    const tag = tty ? `${color[item.status]}${item.status.padEnd(4)}${reset}` : item.status.padEnd(4);
    console.log(`${tag}  ${item.key.padEnd(24)} ${item.message}`);
  }
  console.log(
    `\n[preflight] PASS ${counts.PASS} / WARN ${counts.WARN} / FAIL ${counts.FAIL} → ${counts.FAIL === 0 ? "可以启动" : "请先修复 FAIL 项"}`,
  );
}
process.exit(counts.FAIL === 0 ? 0 : 1);
