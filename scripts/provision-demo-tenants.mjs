#!/usr/bin/env node
// 纳米Work行业版 · 生产模式下通过 HTTP API 幂等创建演示企业与账号（不依赖 SEED_DEMO）
//
// 用法：
//   NANOWORK_SUPER_PASSWORD='***' node scripts/provision-demo-tenants.mjs \
//     --manifest ops/deploy/demo-tenants.example.json \
//     --base-url https://demo.example.com \
//     [--super-username super] [--out ./provision-output] [--dry-run] [--no-top-up]
//
//   超管密码只从环境变量 NANOWORK_SUPER_PASSWORD（或 PLATFORM_SUPER_PASSWORD）读取，不接受命令行参数。
//   在服务器本机执行时 --base-url 用 http://127.0.0.1:3107 可绕过 Caddy。
//
// 用到的端点（均已在 server/src/routes 中核对字段）：
//   POST /api/auth/login                       {username,password} → {token,user}        （platform_super / boss）
//   POST /api/auth/logout
//   POST /api/auth/register                    {company,contactName,phone,username,password} → {tenantId}
//                                              公开接口；按 IP 每小时限 REGISTER_IP_MAX_ATTEMPTS（默认 5，含成功）
//   GET  /api/platform/tenants                 租户列表（super）
//   GET  /api/platform/tenants/:id             租户详情含 users（super）
//   POST /api/platform/tenants/:id/approve     {modules,plan,grantCredits,seatLimit}（super）
//   POST /api/platform/tenants/:id/update      {modules,plan,status,seatLimit}（super）
//   POST /api/platform/tenants/:id/credits     {delta,note}（super；非零整数）
//   GET  /api/admin/users                      本企业账号列表（boss）
//   POST /api/admin/users                      {username,password,name,role,dept,phone}（boss；受 seat_limit 约束）
//
// 幂等规则：
//   - 租户按"企业名"或"老板账号"匹配已存在则复用，不重复注册
//   - 已开通的租户不再 approve；plan/seatLimit/modules 与清单不同则走 update
//   - 积分：低于清单目标值时补足到目标（不扣减）；--no-top-up 关闭
//   - 子账号按用户名存在即跳过；密码不会被重置
//
// 输出：
//   <out>/demo-accounts-<ts>.md     账号卡片（含密码，0600；唯一一次输出密码的地方）
//   <out>/provision-result-<ts>.json 结果（无密码）
//   stdout 只打印用户名与状态，不打印密码。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROLE_SET = new Set(["boss", "ops_director", "manager", "admin", "sales", "partner"]);
const MODULE_SET = new Set(["dashboard", "advisor", "marshals", "growth", "activities", "content", "execution", "analysis", "assets", "system"]);
const REGISTER_USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{3,39}$/; // routes/auth.js register
const ADMIN_USERNAME = /^[a-zA-Z0-9_.@-]{3,64}$/; // routes/admin.js POST /users
const PHONE = /^1\d{10}$/;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const opts = {
  manifest: "",
  baseUrl: "http://127.0.0.1:3107",
  superUsername: "super",
  out: path.resolve("provision-output"),
  dryRun: false,
  topUp: true,
};
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  const next = () => {
    const value = args[++i];
    if (value == null) usageError(`${arg} 需要值`);
    return value;
  };
  if (arg === "-h" || arg === "--help") {
    printHelp();
    process.exit(0);
  } else if (arg === "--manifest") opts.manifest = next();
  else if (arg.startsWith("--manifest=")) opts.manifest = arg.slice(11);
  else if (arg === "--base-url") opts.baseUrl = next();
  else if (arg.startsWith("--base-url=")) opts.baseUrl = arg.slice(11);
  else if (arg === "--super-username") opts.superUsername = next();
  else if (arg.startsWith("--super-username=")) opts.superUsername = arg.slice(17);
  else if (arg === "--out") opts.out = path.resolve(next());
  else if (arg.startsWith("--out=")) opts.out = path.resolve(arg.slice(6));
  else if (arg === "--dry-run") opts.dryRun = true;
  else if (arg === "--no-top-up") opts.topUp = false;
  else usageError(`未知参数：${arg}`);
}

function printHelp() {
  console.log(`用法：NANOWORK_SUPER_PASSWORD='***' node scripts/provision-demo-tenants.mjs --manifest <json> [选项]

选项：
  --manifest <path>        租户清单 JSON（示例：ops/deploy/demo-tenants.example.json）
  --base-url <url>         服务地址，默认 http://127.0.0.1:3107（服务器本机执行时推荐）
  --super-username <name>  平台超管用户名，默认 super
  --out <dir>              输出目录，默认 ./provision-output（账号卡片 0600）
  --dry-run                只校验清单并打印计划，不发任何请求，不需要超管密码
  --no-top-up              不补足积分（默认低于目标值时补到目标值）
  -h, --help               帮助

环境变量：
  NANOWORK_SUPER_PASSWORD  或 PLATFORM_SUPER_PASSWORD：平台超管密码（必需，除 --dry-run）

清单格式（tenants[]）：
  key            唯一标识（用于文件与日志）
  company        企业名（≤120）              industry   业态说明（只进卡片）
  contactName    联系人（≤40）               phone      手机号（1 开头 11 位，可省略）
  plan           套餐名（默认 标准版）        seatLimit  席位上限（含老板；默认 10）
  modules        模块数组或 null（null=全部）  credits    目标积分（整数，默认 0）
  approve        是否开通（默认 true；false 则停留在"待审核"，用于演示审批流）
  boss           {username,password,name}；password 为 null/省略则自动生成
  managers[]     {username,password,name,role=ops_director|manager|admin,dept}
  employees[]    {username,password,name,role=sales|partner,dept}`);
}

function usageError(message) {
  console.error(`[provision] ${message}`);
  console.error("使用 --help 查看用法");
  process.exit(2);
}

if (!opts.manifest) usageError("必须指定 --manifest");
let baseUrl;
try {
  baseUrl = new URL(opts.baseUrl);
  if (!["http:", "https:"].includes(baseUrl.protocol)) throw new Error("协议必须是 http/https");
} catch (error) {
  usageError(`--base-url 无效：${error.message}`);
}
if (baseUrl.protocol === "http:" && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(baseUrl.hostname)) {
  usageError("非回环地址必须使用 https（密码会明文经过网络）");
}
const BASE = baseUrl.href.replace(/\/+$/u, "");

// ---------------------------------------------------------------------------
// 清单校验
// ---------------------------------------------------------------------------
const manifestPath = path.resolve(opts.manifest);
if (!fs.existsSync(manifestPath)) usageError(`清单不存在：${manifestPath}`);
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
  usageError(`清单不是合法 JSON：${error.message}`);
}
const tenants = Array.isArray(manifest?.tenants) ? manifest.tenants : null;
if (!tenants || !tenants.length) usageError("清单缺少非空 tenants 数组");

const problems = [];
const seenUsernames = new Map();
const seenKeys = new Set();
const generatedPasswords = new Set();

function generatePassword() {
  // 12 位：满足 admin/register ≥8 的要求，也满足超管口径的三类字符，便于现场口述
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#%*";
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  const all = upper + lower + digits + symbols;
  while (chars.length < 12) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function normalizeAccount(raw, { tenantKey, kind, index, defaultRole, allowedRoles, usernameRule, dept }) {
  const where = `${tenantKey}.${kind}${index == null ? "" : `[${index}]`}`;
  if (!raw || typeof raw !== "object") {
    problems.push(`${where}: 必须是对象`);
    return null;
  }
  const username = String(raw.username || "").trim();
  if (!usernameRule.test(username)) problems.push(`${where}.username "${username}" 不符合规则 ${usernameRule}`);
  if (seenUsernames.has(username)) problems.push(`${where}.username "${username}" 与 ${seenUsernames.get(username)} 重复`);
  else seenUsernames.set(username, where);
  let password = raw.password == null || raw.password === "" ? null : String(raw.password);
  let passwordGenerated = false;
  if (password === null) {
    password = generatePassword();
    passwordGenerated = true;
    generatedPasswords.add(password);
  } else if (password.length < 8 || password.length > 128) {
    problems.push(`${where}.password 长度须 8~128`);
  }
  const name = String(raw.name || "").trim();
  if (!name || name.length > 60) problems.push(`${where}.name 必填且 ≤60 字`);
  const role = String(raw.role || defaultRole).trim();
  if (!allowedRoles.has(role)) problems.push(`${where}.role "${role}" 不在允许范围 ${[...allowedRoles].join("/")}`);
  const phone = raw.phone == null || raw.phone === "" ? "" : String(raw.phone).trim();
  if (phone && !PHONE.test(phone)) problems.push(`${where}.phone 格式不正确`);
  return { username, password, passwordGenerated, name, role, dept: String(raw.dept || dept || "").trim().slice(0, 80), phone };
}

const plan = tenants.map((raw, index) => {
  const key = String(raw?.key || `tenant-${index + 1}`).trim();
  if (seenKeys.has(key)) problems.push(`tenants[${index}].key "${key}" 重复`);
  seenKeys.add(key);
  const company = String(raw?.company || "").trim();
  if (!company || company.length > 120) problems.push(`${key}.company 必填且 ≤120 字`);
  const contactName = String(raw?.contactName || "").trim();
  if (contactName.length > 40) problems.push(`${key}.contactName ≤40 字`);
  const phone = raw?.phone == null || raw.phone === "" ? "" : String(raw.phone).trim();
  if (phone && !PHONE.test(phone)) problems.push(`${key}.phone 格式不正确（1 开头 11 位）`);
  const planName = String(raw?.plan || "标准版").trim();
  if (!planName || planName.length > 40) problems.push(`${key}.plan 1~40 字`);
  const seatLimit = raw?.seatLimit == null ? 10 : Number(raw.seatLimit);
  if (!Number.isInteger(seatLimit) || seatLimit < 1 || seatLimit > 10000) problems.push(`${key}.seatLimit 须为 1~10000 的整数`);
  const credits = raw?.credits == null ? 0 : Number(raw.credits);
  if (!Number.isSafeInteger(credits) || credits < 0 || credits > 1_000_000_000) problems.push(`${key}.credits 须为 0~10 亿的整数`);
  let modules = null;
  if (raw?.modules != null) {
    if (!Array.isArray(raw.modules)) problems.push(`${key}.modules 须为数组或 null`);
    else {
      modules = [...new Set(raw.modules.map((m) => String(m).trim()))];
      const invalid = modules.filter((m) => !MODULE_SET.has(m));
      if (invalid.length) problems.push(`${key}.modules 含无效模块 ${invalid.join(",")}`);
      if (!modules.length) modules = null;
    }
  }
  const approve = raw?.approve !== false;
  const boss = normalizeAccount(raw?.boss, {
    tenantKey: key, kind: "boss", defaultRole: "boss", allowedRoles: new Set(["boss"]), usernameRule: REGISTER_USERNAME, dept: "管理层",
  });
  const managers = (Array.isArray(raw?.managers) ? raw.managers : []).map((m, i) => normalizeAccount(m, {
    tenantKey: key, kind: "managers", index: i, defaultRole: "ops_director", allowedRoles: new Set(["ops_director", "manager", "admin"]), usernameRule: ADMIN_USERNAME, dept: "管理层",
  })).filter(Boolean);
  const employees = (Array.isArray(raw?.employees) ? raw.employees : []).map((e, i) => normalizeAccount(e, {
    tenantKey: key, kind: "employees", index: i, defaultRole: "sales", allowedRoles: new Set(["sales", "partner"]), usernameRule: ADMIN_USERNAME, dept: "门店",
  })).filter(Boolean);
  const totalSeats = 1 + managers.length + employees.length;
  if (totalSeats > seatLimit) problems.push(`${key}: 账号总数 ${totalSeats}（老板+管理层+员工）超过 seatLimit ${seatLimit}`);
  if (!approve && (managers.length || employees.length)) {
    problems.push(`${key}: approve=false 时无法创建子账号（/api/admin 受 tenantGate 拦截，待审核租户 403）；请去掉 managers/employees 或改为 approve=true`);
  }
  return {
    key, company, industry: String(raw?.industry || "").trim(), contactName: contactName || (boss?.name ?? ""), phone,
    plan: planName, seatLimit, credits, modules, approve, boss, managers, employees, purpose: String(raw?.purpose || "").trim(),
  };
});

if (problems.length) {
  console.error(`[provision] 清单校验失败（${problems.length} 项）：`);
  for (const item of problems) console.error(`  - ${item}`);
  process.exit(2);
}

console.log(`[provision] 清单 ${manifestPath}`);
console.log(`[provision] 目标 ${BASE}；${plan.length} 家企业，共 ${plan.reduce((n, t) => n + 1 + t.managers.length + t.employees.length, 0)} 个账号${opts.dryRun ? "（dry-run，不发请求）" : ""}`);
if (plan.length > 5) {
  console.log(`[provision] 注意：/api/auth/register 按 IP 每小时限 REGISTER_IP_MAX_ATTEMPTS（默认 5，含成功）。` +
    `新建 ${plan.length} 家时请先在 server.env 临时改为 ≥${plan.length + 2} 并重启，完成后改回。已存在的租户不消耗配额。`);
}

for (const t of plan) {
  console.log(`\n  [${t.key}] ${t.company}${t.industry ? `（${t.industry}）` : ""}`);
  console.log(`    套餐 ${t.plan} · 席位 ${t.seatLimit} · 积分目标 ${t.credits} · 模块 ${t.modules ? t.modules.join(",") : "全部"} · ${t.approve ? "直接开通" : "停留待审核"}`);
  console.log(`    老板   ${t.boss.username}（${t.boss.name}）${t.boss.passwordGenerated ? " 密码自动生成" : ""}`);
  for (const m of t.managers) console.log(`    管理层 ${m.username}（${m.name}/${m.role}）${m.passwordGenerated ? " 密码自动生成" : ""}`);
  for (const e of t.employees) console.log(`    员工   ${e.username}（${e.name}/${e.role}）${e.passwordGenerated ? " 密码自动生成" : ""}`);
}

if (opts.dryRun) {
  console.log("\n[provision] dry-run 结束：清单合法。去掉 --dry-run 并设置 NANOWORK_SUPER_PASSWORD 即可执行。");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------
const superPassword = String(process.env.NANOWORK_SUPER_PASSWORD || process.env.PLATFORM_SUPER_PASSWORD || "");
if (!superPassword) usageError("缺少环境变量 NANOWORK_SUPER_PASSWORD（或 PLATFORM_SUPER_PASSWORD）");
delete process.env.NANOWORK_SUPER_PASSWORD;
delete process.env.PLATFORM_SUPER_PASSWORD;

class HttpError extends Error {
  constructor(status, body, method, pathname) {
    super(`${method} ${pathname} → HTTP ${status}${body?.error ? `：${body.error}` : ""}`);
    this.status = status;
    this.body = body;
  }
}

async function api(pathname, { method = "GET", token, body, retryAfterHint = false } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new HttpError(response.status, payload, method, pathname);
    if (response.status === 429 && retryAfterHint) error.retryAfter = response.headers.get("retry-after");
    throw error;
  }
  return payload;
}

async function login(username, password) {
  const result = await api("/api/auth/login", { method: "POST", body: { username, password } });
  return { token: result.token, user: result.user };
}
async function logout(token) {
  await api("/api/auth/logout", { method: "POST", token }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
const results = [];

const health = await api("/api/health").catch((error) => {
  console.error(`[provision] 无法访问 ${BASE}/api/health：${error.message}`);
  process.exit(1);
});
if (!health?.ok) {
  console.error(`[provision] 健康检查异常：${JSON.stringify(health)}`);
  process.exit(1);
}

let superSession;
try {
  superSession = await login(opts.superUsername, superPassword);
} catch (error) {
  console.error(`[provision] 超管登录失败：${error.message}`);
  process.exit(1);
}
if (superSession.user?.role !== "platform_super") {
  await logout(superSession.token);
  console.error(`[provision] 账号 ${opts.superUsername} 角色是 ${superSession.user?.role}，不是 platform_super`);
  process.exit(1);
}
const superToken = superSession.token;
console.log(`\n[provision] 超管 ${opts.superUsername} 登录成功`);

async function loadTenantIndex() {
  const list = await api("/api/platform/tenants", { token: superToken });
  const byName = new Map();
  const byBoss = new Map();
  for (const tenant of list) {
    if (Number(tenant.id) === 1) continue; // 总部
    byName.set(String(tenant.name).trim(), tenant);
    const detail = await api(`/api/platform/tenants/${tenant.id}`, { token: superToken });
    for (const user of detail.users || []) byBoss.set(String(user.username), { tenant, user });
  }
  return { byName, byBoss };
}

let index = await loadTenantIndex();
let aborted = false;

for (const t of plan) {
  const record = {
    key: t.key, company: t.company, industry: t.industry, purpose: t.purpose, tenantId: null, status: null,
    plan: t.plan, seatLimit: t.seatLimit, credits: null, actions: [], warnings: [],
    accounts: [],
  };
  results.push(record);
  console.log(`\n[${t.key}] ${t.company}`);
  const act = (message) => {
    record.actions.push(message);
    console.log(`  ✓ ${message}`);
  };
  const warnMessage = (message) => {
    record.warnings.push(message);
    console.log(`  ! ${message}`);
  };

  try {
    // 1) 找到或注册租户
    let tenant = index.byName.get(t.company)?.id ? index.byName.get(t.company) : null;
    const bossHit = index.byBoss.get(t.boss.username);
    if (!tenant && bossHit) {
      tenant = bossHit.tenant;
      warnMessage(`老板账号 ${t.boss.username} 已属于租户 #${tenant.id}「${tenant.name}」，按该租户复用（企业名与清单不同）`);
    } else if (tenant && bossHit && Number(bossHit.tenant.id) !== Number(tenant.id)) {
      throw new Error(`企业「${t.company}」是租户 #${tenant.id}，但老板账号 ${t.boss.username} 属于租户 #${bossHit.tenant.id}；请修正清单`);
    }
    let bossPasswordKnown = true;
    if (tenant) {
      act(`租户已存在 #${tenant.id}（${tenant.status}），复用`);
      if (t.boss.passwordGenerated) {
        bossPasswordKnown = false;
        warnMessage("清单未提供老板密码且账号已存在：不会重置密码，也无法用老板身份创建子账号");
        t.boss.password = null;
      }
    } else {
      let registered;
      try {
        registered = await api("/api/auth/register", {
          method: "POST",
          retryAfterHint: true,
          body: { company: t.company, contactName: t.contactName, phone: t.phone || undefined, username: t.boss.username, password: t.boss.password },
        });
      } catch (error) {
        if (error.status === 429) {
          throw new Error(`注册被限流（${error.body?.error || "429"}，Retry-After=${error.retryAfter || "?"}s）。` +
            "请在 /etc/nanowork/server.env 临时提高 REGISTER_IP_MAX_ATTEMPTS 并 systemctl restart nanowork 后重跑；已完成的租户会被幂等跳过");
        }
        throw error;
      }
      const detail = await api(`/api/platform/tenants/${registered.tenantId}`, { token: superToken });
      tenant = detail;
      act(`已注册租户 #${tenant.id}（待审核），老板账号 ${t.boss.username}`);
    }
    record.tenantId = Number(tenant.id);

    // 2) 开通 / 更新
    let detail = await api(`/api/platform/tenants/${tenant.id}`, { token: superToken });
    if (t.approve) {
      if (detail.status !== "已开通") {
        await api(`/api/platform/tenants/${tenant.id}/approve`, {
          method: "POST", token: superToken,
          body: { modules: t.modules, plan: t.plan, grantCredits: 0, seatLimit: t.seatLimit },
        });
        act(`已开通：套餐 ${t.plan}，席位 ${t.seatLimit}，模块 ${t.modules ? t.modules.join(",") : "全部"}`);
      } else {
        const currentModules = Array.isArray(detail.modules) ? [...detail.modules].sort().join(",") : "";
        const wantModules = t.modules ? [...t.modules].sort().join(",") : "";
        const diff = {};
        if (detail.plan !== t.plan) diff.plan = t.plan;
        if (Number(detail.seat_limit) !== t.seatLimit) diff.seatLimit = t.seatLimit;
        if (currentModules !== wantModules) diff.modules = t.modules ?? [];
        if (Object.keys(diff).length) {
          await api(`/api/platform/tenants/${tenant.id}/update`, { method: "POST", token: superToken, body: diff });
          act(`已更新：${Object.keys(diff).join("/")}`);
        } else {
          act("已开通且套餐/席位/模块一致，无需变更");
        }
      }
    } else if (detail.status === "已开通") {
      warnMessage("清单 approve=false 但租户已开通；不做停用，保持现状");
    } else {
      act("按清单保持「待审核」，用于演示审批流");
    }
    detail = await api(`/api/platform/tenants/${tenant.id}`, { token: superToken });
    record.status = detail.status;

    // 3) 积分补足
    const currentCredits = Number(detail.credits) || 0;
    if (opts.topUp && t.credits > currentCredits) {
      const delta = t.credits - currentCredits;
      const result = await api(`/api/platform/tenants/${tenant.id}/credits`, {
        method: "POST", token: superToken, body: { delta, note: `演示环境初始化补足到 ${t.credits}（provision-demo-tenants）` },
      });
      act(`积分 ${currentCredits} → ${result.balance ?? t.credits}（+${delta}）`);
      record.credits = Number(result.balance ?? t.credits);
    } else {
      record.credits = currentCredits;
      act(`积分 ${currentCredits}（目标 ${t.credits}，${opts.topUp ? "无需补足" : "已关闭补足"}）`);
    }

    record.accounts.push({ kind: "老板", role: "boss", username: t.boss.username, name: t.boss.name, dept: t.boss.dept, password: t.boss.password, generated: t.boss.passwordGenerated, created: !bossHit });

    // 4) 子账号（需要老板登录 + 租户已开通）
    if (t.managers.length || t.employees.length) {
      if (record.status !== "已开通") {
        warnMessage("租户未开通，跳过子账号创建");
      } else if (!bossPasswordKnown || !t.boss.password) {
        warnMessage("不知道老板密码，跳过子账号创建（可在清单中填写老板密码后重跑）");
      } else {
        let bossSession;
        try {
          bossSession = await login(t.boss.username, t.boss.password);
        } catch (error) {
          warnMessage(`老板登录失败（${error.message}），跳过子账号创建；请核对清单中的老板密码`);
        }
        if (bossSession) {
          try {
            const existing = new Set((await api("/api/admin/users", { token: bossSession.token })).map((u) => String(u.username)));
            for (const [kind, list] of [["管理层", t.managers], ["员工", t.employees]]) {
              for (const account of list) {
                if (existing.has(account.username)) {
                  act(`${kind} ${account.username} 已存在，跳过`);
                  record.accounts.push({ kind, role: account.role, username: account.username, name: account.name, dept: account.dept, password: account.passwordGenerated ? null : account.password, generated: account.passwordGenerated, created: false });
                  continue;
                }
                await api("/api/admin/users", {
                  method: "POST", token: bossSession.token,
                  body: { username: account.username, password: account.password, name: account.name, role: account.role, dept: account.dept, phone: account.phone || "" },
                });
                act(`已创建${kind} ${account.username}（${account.name}/${account.role}）`);
                record.accounts.push({ kind, role: account.role, username: account.username, name: account.name, dept: account.dept, password: account.password, generated: account.passwordGenerated, created: true });
              }
            }
          } finally {
            await logout(bossSession.token);
          }
        }
      }
    }
  } catch (error) {
    record.error = error.message;
    console.log(`  ✗ ${error.message}`);
    if (/限流|429/u.test(error.message)) {
      aborted = true;
      console.log("  … 后续租户暂停，处理限流后重跑即可");
      break;
    }
  }
  // 新增租户后刷新索引，便于后续租户的冲突判断
  index = await loadTenantIndex();
}

await logout(superToken);

// ---------------------------------------------------------------------------
// 输出：账号卡片（含密码）与结果 JSON（无密码）
// ---------------------------------------------------------------------------
fs.mkdirSync(opts.out, { recursive: true, mode: 0o700 });
const cardPath = path.join(opts.out, `demo-accounts-${stamp}.md`);
const resultPath = path.join(opts.out, `provision-result-${stamp}.json`);

const lines = [];
lines.push(`# 演示账号卡片 · ${startedAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
lines.push("");
lines.push(`- 服务地址：${BASE}`);
lines.push("- 本文件包含明文密码，仅现场发放用；发放后请删除或加密保存。密码不会再次输出。");
lines.push("- 标注「（未知）」表示账号在本次运行前已存在且清单未提供密码，密码未被重置。");
lines.push("");
for (const r of results) {
  lines.push(`## ${r.company}${r.industry ? `（${r.industry}）` : ""}`);
  lines.push("");
  lines.push(`- 用途：${r.purpose || "-"}　租户 #${r.tenantId ?? "-"}　状态：${r.status ?? "-"}　套餐：${r.plan}　席位：${r.seatLimit}　积分：${r.credits ?? "-"}`);
  if (r.error) lines.push(`- **失败**：${r.error}`);
  for (const w of r.warnings) lines.push(`- 提示：${w}`);
  lines.push("");
  lines.push("| 角色 | 账号 | 密码 | 姓名 | 部门 | 本次 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const a of r.accounts) {
    lines.push(`| ${a.kind}/${a.role} | \`${a.username}\` | ${a.password ? `\`${a.password}\`` : "（未知）"} | ${a.name} | ${a.dept || "-"} | ${a.created ? "新建" : "已存在"} |`);
  }
  lines.push("");
}
fs.writeFileSync(cardPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
try {
  fs.chmodSync(cardPath, 0o600);
} catch {
  /* windows */
}
fs.writeFileSync(
  resultPath,
  `${JSON.stringify({
    generatedAt: startedAt.toISOString(),
    baseUrl: BASE,
    manifest: manifestPath,
    aborted,
    tenants: results.map((r) => ({ ...r, accounts: r.accounts.map(({ password, ...rest }) => rest) })),
  }, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);

const failed = results.filter((r) => r.error).length;
console.log(`\n[provision] 完成：${results.length - failed}/${plan.length} 家成功${aborted ? "（因限流提前结束）" : ""}`);
console.log(`[provision] 账号卡片（含密码，0600）：${cardPath}`);
console.log(`[provision] 结果 JSON（无密码）：${resultPath}`);
process.exit(failed || aborted ? 1 : 0);
