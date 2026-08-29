import { Router } from 'express';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { db, q, getConfig, setConfig, getTenantConfig, setTenantConfig, modulesFor, curTenant, mergeMarshal, tenantOf } from '../db.js';
import { hashPassword, logOp, requireRole, pageParams, safeJsonParse } from '../util.js';
import { loadRestaurantCatalog } from '../catalog/restaurant.js';
import { dispatchPolicy, saveDispatchPolicy } from '../engines/employee-dispatch-policy.js';
import { billing } from '../engines/credits.js';
import { adjust, balanceOfTenant } from '../engines/credits.js';
import {
  routing,
  maskedKey,
  yunwuAvailable,
  yunwuUsage,
  yunwuApiKey,
  yunwuKeySource,
} from '../engines/yunwu.js';
import { providerResponseError, sanitizeProviderError } from '../engines/provider-errors.js';
import { getRules } from '../engines/risk.js';
import {
  buildRuntimeReadiness,
  recordRuntimeReadinessCheck,
} from '../engines/runtime-readiness.js';

// ===== 管理后台 API（仅 boss/admin；PRD V2 §20-21 管理后台）=====
const r = Router();
r.use(requireRole('boss', 'admin'));

const ALL_MODULES = [
  { key: 'dashboard', name: '总控台' }, { key: 'advisor', name: '老板参谋' },
  { key: 'marshals', name: '餐饮数字员工' }, { key: 'growth', name: '增长中心' },
  { key: 'activities', name: '活动中心' }, { key: 'content', name: '内容生产仓' },
  { key: 'execution', name: '经营执行' }, { key: 'analysis', name: '经营分析' },
  { key: 'assets', name: '数据资产' }, { key: 'system', name: '系统管理' },
];
const USER_ROLES = new Set(['boss', 'ops_director', 'manager', 'admin', 'sales', 'partner']);
const USER_STATUSES = new Set(['启用', '停用']);
const MODULE_KEYS = new Set(ALL_MODULES.map(item => item.key));
const CURRENT_DEPARTMENT_CODES = Object.freeze(Array.from({ length: 8 }, (_, index) => `M-${String(index + 1).padStart(2, '0')}`));
const CURRENT_DEPARTMENT_CODE_SET = new Set(CURRENT_DEPARTMENT_CODES);
const CURRENT_DEPARTMENT_SQL = CURRENT_DEPARTMENT_CODES.map(() => '?').join(',');

function catalogEmployeesForDepartment(marshalId) {
  return q.all(`SELECT id,marshal_id,employee_idx,key,person,name,duty,status,last_output_id
    FROM specialists WHERE marshal_id=? AND employee_idx BETWEEN 101 AND 161 ORDER BY sort,employee_idx`, marshalId)
    .map(employee => ({ ...employee, active: 1 }));
}

function requirePlatformConfigOwner(req, res, next) {
  if (curTenant() !== 1) return res.status(403).json({ error: '模型通道、平台计费和API密钥仅平台总部可配置' });
  next();
}

// ===== BE-M5：SSRF 防护 =====
// 旧实现只对主机名字符串做黑名单匹配，攻击者用一个解析到 127.0.0.1/10.x 的域名（或 DNS rebinding）
// 即可绕过，让服务端拿着 API Key 去打内网。现改为：字面 IP 直接判、域名先解析 DNS 再逐个校验
// 解析结果，任一地址落在环回/内网/链路本地/CGNAT/组播等禁区一律拒绝。仅总部租户可改该配置。
function forbiddenV4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  return a === 0                                  // 0.0.0.0/8 "本网络"
    || a === 127                                  // 环回
    || a === 10                                   // RFC1918
    || (a === 172 && b >= 16 && b <= 31)          // RFC1918
    || (a === 192 && b === 168)                   // RFC1918
    || (a === 169 && b === 254)                   // 链路本地（含云厂商元数据 169.254.169.254）
    || (a === 100 && b >= 64 && b <= 127)         // CGNAT 100.64.0.0/10（含 Tailscale 内网）
    || (a === 192 && b === 0 && c === 0)          // IETF 协议保留
    || a >= 224;                                  // 组播/保留/广播
}
export function isForbiddenAddress(ip) {
  const family = net.isIP(String(ip || ''));
  if (!family) return true;                        // 非法地址一律按禁区处理
  if (family === 4) return forbiddenV4(ip);
  const lower = String(ip).toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4 映射地址
  if (mapped) return forbiddenV4(mapped[1]);
  return lower === '::' || lower === '::1'         // 未指定/环回
    || /^fe[89ab]/.test(lower)                     // 链路本地 fe80::/10
    || /^f[cd]/.test(lower);                       // ULA fc00::/7
}

export async function validatedProviderBase(value, {
  resolve = host => lookup(host, { all: true, verbatim: true }),
} = {}) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw Object.assign(new Error('API BaseURL 格式不正确'), { status: 400 }); }
  if (!['https:', 'http:'].includes(url.protocol)) throw Object.assign(new Error('API BaseURL 仅支持 HTTP/HTTPS'), { status: 400 });
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw Object.assign(new Error('生产环境 API BaseURL 必须使用 HTTPS'), { status: 400 });
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const rejectPrivate = () => { throw Object.assign(new Error('API BaseURL 不允许指向本机或内网地址'), { status: 400 }); };
  let addresses;
  if (net.isIP(host)) {
    addresses = [host];                            // 字面 IP：直接校验
  } else {
    // 明显的本机/内网域名后缀与无点主机名直接拒绝，不必浪费一次解析
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
      || host.endsWith('.internal') || !host.includes('.')) rejectPrivate();
    try {
      addresses = (await resolve(host)).map(item => (typeof item === 'string' ? item : item?.address)).filter(Boolean);
    } catch { throw Object.assign(new Error('API BaseURL 域名无法解析，请检查后重试'), { status: 400 }); }
    if (!addresses.length) throw Object.assign(new Error('API BaseURL 域名无法解析，请检查后重试'), { status: 400 });
  }
  if (addresses.some(isForbiddenAddress)) rejectPrivate();
  return url.toString().replace(/\/+$/, '');
}

function normalizedUserText(value, label, maxLength) {
  if (typeof value !== 'string') throw Object.assign(new Error(`${label}格式不正确`), { status: 400 });
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw Object.assign(new Error(`${label}长度必须为1到${maxLength}字`), { status: 400 });
  return normalized;
}

function normalizedModules(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > MODULE_KEYS.size) throw Object.assign(new Error('模块权限格式不正确'), { status: 400 });
  const modules = [...new Set(value.map(item => String(item).trim()))];
  if (modules.some(item => !MODULE_KEYS.has(item))) throw Object.assign(new Error('模块权限包含无效值'), { status: 400 });
  return modules;
}

// —— 概览（严格本企业口径：所有用量/消耗仅统计当前租户；消耗=正向扣分，排除充值流水）——
r.get('/overview', (req, res) => {
  const T = curTenant();
  const cy = billing().creditYuan;                 // 1积分对应人民币（默认 0.01 元）
  const TODAY = `date(created_at)=date('now','localtime')`;
  // 消耗只算 credits>0 的扣费流水；充值(credits<0)/调整不计入"消耗"
  const todayUse = q.get(`SELECT COALESCE(SUM(credits),0) c, COUNT(*) n FROM credit_logs WHERE tenant_id = ${T} AND credits > 0 AND ${TODAY}`) || {};
  // 本企业 AI 用量（替代原来的全局进程计数器，那个是跨租户的）
  const usage = q.get(`SELECT
      COALESCE(SUM(CASE WHEN kind='text'  THEN 1 ELSE 0 END),0) textCalls,
      COALESCE(SUM(CASE WHEN kind='image' THEN 1 ELSE 0 END),0) images,
      COALESCE(SUM(CASE WHEN kind='video' THEN 1 ELSE 0 END),0) videos,
      COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output
    FROM credit_logs WHERE tenant_id = ${T} AND ai_mode != 'recharge'`) || {};
  res.json({
    users: q.get(`SELECT COUNT(*) n FROM users WHERE tenant_id = ${T} AND role != 'platform_super'`)?.n || 0,
    activeToday: q.get(`SELECT COUNT(DISTINCT o.user_id) n FROM op_logs o LEFT JOIN users u ON u.id=o.user_id
      WHERE o.tenant_id = ${T} AND date(o.created_at)=date('now','localtime') AND (u.role IS NULL OR u.role != 'platform_super')`)?.n || 0,
    totalCredits: q.get(`SELECT credits n FROM tenants WHERE id = ${T}`)?.n || 0,
    todayCredits: todayUse.c || 0,
    todaySpendYuan: Math.round((todayUse.c || 0) * cy * 100) / 100,   // 老板今日实际花费（人民币）
    todayCalls: todayUse.n || 0,
    aiCalls: q.get(`SELECT COUNT(*) n FROM credit_logs WHERE tenant_id = ${T} AND ai_mode != 'recharge'`)?.n || 0,
    pendingApprovals: q.get(`SELECT COUNT(*) n FROM approvals WHERE tenant_id = ${T} AND status='待审核'`)?.n || 0,
    channel: yunwuAvailable() ? 'yunwu' : 'template',
    readiness: buildRuntimeReadiness({ tenantId: T }),
    usage,
  });
});

// 本接口只聚合本地配置、进程状态与最近一次显式测试记录，严禁在 GET 中探测外部服务。
r.get('/runtime-readiness', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(buildRuntimeReadiness({ tenantId: curTenant() }));
});

// —— 用户与组织 ——
r.get('/users', (req, res) => {
  const rows = q.all(`SELECT u.id,u.username,u.name,u.role,u.dept,u.phone,u.status,u.modules,u.last_login_at,u.created_at,
    (SELECT COALESCE(SUM(l.credits),0) FROM credit_logs l WHERE l.tenant_id=u.tenant_id AND l.user_id=u.id
      AND l.credits>0 AND l.created_at>=date('now','start of month')) ai_spent_month
    FROM users u WHERE u.tenant_id = ${curTenant()} AND u.role != 'platform_super' ORDER BY u.id`);
  res.json(rows.map(u => ({ ...u, modules: safeJsonParse(u.modules, null), effectiveModules: modulesFor(u) })));
});
r.post('/users', (req, res) => {
  const { username, password, name, role, dept, phone, credits = 0 } = req.body || {};
  if (!username || !password || !name) return res.status(400).json({ error: '用户名/密码/姓名必填' });
  const account = String(username).trim();
  if (!/^[a-zA-Z0-9_.@-]{3,64}$/.test(account)) return res.status(400).json({ error: '用户名须为3到64位字母、数字或 . _ @ -' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: '初始密码须为8到128位' });
  let displayName;
  try { displayName = normalizedUserText(name, '姓名', 60); } catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  const initialCredits = Number(credits);
  if (!Number.isSafeInteger(initialCredits) || initialCredits < 0 || initialCredits > 100000000) return res.status(400).json({ error: '增发积分必须是0到1亿之间的整数' });
  const userRole = role || 'sales';
  if (!USER_ROLES.has(userRole)) return res.status(400).json({ error: '账号角色无效' });
  // 安全：必须显式落到本企业（users 非自动注入表，缺 tenant_id 会落到总部租户1 → 跨租户建号/接管）
  const tid = curTenant();
  const seat = q.get('SELECT seat_limit FROM tenants WHERE id = ?', tid)?.seat_limit ?? 5;
  const used = q.get('SELECT COUNT(*) n FROM users WHERE tenant_id = ?', tid)?.n || 0;
  if (used >= seat) return res.status(400).json({ error: `账号数已达企业上限（${seat}个），如需扩容请联系平台` });
  let transactionOpen = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const result = q.run('INSERT INTO users(username,password_hash,name,role,dept,phone,credits,tenant_id) VALUES(?,?,?,?,?,?,0,?)',
      account, hashPassword(password), displayName, userRole, String(dept || '').trim().slice(0, 80), String(phone || '').trim().slice(0, 40), tid);
    if (initialCredits > 0) adjust({ userId: result.lastInsertRowid, delta: initialCredits, operatorId: req.user.id, note: '新增账号时增发企业共享积分', manageTransaction: false });
    db.exec('COMMIT');
    transactionOpen = false;
    logOp(req.user, '管理后台', '新增用户', username);
    res.json({ id: result.lastInsertRowid });
  } catch (error) {
    if (transactionOpen) { try { db.exec('ROLLBACK'); } catch { /* no active transaction */ } }
    const duplicate = String(error?.message || '').includes('UNIQUE constraint failed: users.username');
    res.status(error?.status || 400).json({ error: duplicate ? '用户名已存在' : (error?.message || '新增账号失败') });
  }
});
r.put('/users/:id', (req, res) => {
  // 租户归属守卫：管理后台只能改本企业用户，杜绝按裸 id 改到别家账号的密码/角色（越权提权/接管）
  if (!q.get(`SELECT id FROM users WHERE tenant_id = ${curTenant()} AND id = ?`, req.params.id)) return res.status(404).json({ error: '用户不存在' });
  const { name, role, dept, status, password, modules } = req.body || {};
  if (password !== undefined && password && String(password).length < 8) return res.status(400).json({ error: '重置密码至少8位' });
  if (password && String(password).length > 128) return res.status(400).json({ error: '重置密码最长128位' });
  if (role !== undefined && !USER_ROLES.has(role)) return res.status(400).json({ error: '账号角色无效' });
  if (status !== undefined && !USER_STATUSES.has(status)) return res.status(400).json({ error: '账号状态无效' });
  let normalizedName; let normalizedModuleList;
  try {
    if (name !== undefined) normalizedName = normalizedUserText(name, '姓名', 60);
    if (modules !== undefined) normalizedModuleList = normalizedModules(modules);
  } catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  const updates = []; const values = [];
  const add = (column, value) => { updates.push(`${column}=?`); values.push(value); };
  if (name !== undefined) add('name', normalizedName);
  if (role !== undefined) add('role', role);
  if (dept !== undefined) add('dept', String(dept || '').trim().slice(0, 80));
  if (status !== undefined) add('status', status);
  if (password) {
    add('password_hash', hashPassword(password));
    updates.push('auth_version=COALESCE(auth_version,0)+1');
  }
  if (modules !== undefined) add('modules', normalizedModuleList === null ? null : JSON.stringify(normalizedModuleList));
  if (updates.length) q.run(`UPDATE users SET ${updates.join(',')} WHERE tenant_id=? AND id=?`, ...values, curTenant(), req.params.id);
  logOp(req.user, '管理后台', '修改用户', `user#${req.params.id}`);
  res.json({ ok: true });
});
r.get('/org', (req, res) => {
  res.json(q.all(`SELECT dept, COUNT(*) n, GROUP_CONCAT(name) members FROM users WHERE tenant_id = ${curTenant()} GROUP BY dept`));
});

// —— 角色权限矩阵（菜单级勾选，PRD V2 §13）——
r.get('/permissions', (req, res) => {
  const restaurantGroups = loadRestaurantCatalog().groups.map(group => group.name);
  res.json({
    modules: ALL_MODULES,
    roleModules: getTenantConfig('role_modules', {}),
    deptModules: getTenantConfig('dept_modules', {}),
    featureFlags: getTenantConfig('feature_flags', {}),
    employeeDispatchPolicy: dispatchPolicy(),
    employeeGroups: [...restaurantGroups, '内容生产部'],
    depts: q.all(`SELECT DISTINCT dept FROM users WHERE tenant_id = ${curTenant()} AND dept IS NOT NULL AND dept != ''`).map(x => x.dept),
    roles: [
      { key: 'boss', name: '老板' }, { key: 'ops_director', name: '管理层/运营总监' },
      { key: 'sales', name: '员工/销售' }, { key: 'admin', name: '系统管理员' }, { key: 'partner', name: '合伙人' },
    ],
  });
});
r.put('/permissions', (req, res) => {
  const { roleModules, featureFlags, deptModules, employeeDispatchPolicy } = req.body || {};
  if (roleModules) setTenantConfig('role_modules', roleModules);
  if (featureFlags) setTenantConfig('feature_flags', featureFlags);
  if (deptModules) setTenantConfig('dept_modules', deptModules);
  if (employeeDispatchPolicy) saveDispatchPolicy(employeeDispatchPolicy);
  logOp(req.user, '管理后台', '修改权限矩阵', [
    roleModules && '角色矩阵', deptModules && '部门映射', featureFlags && '功能开关',
    employeeDispatchPolicy && '员工派活权限',
  ].filter(Boolean).join('+'));
  res.json({ ok: true });
});

// —— 分部管理：继续复用旧路由/表名，但对外仅展示当前8个餐饮分部与权威数字员工目录 ——
r.get('/marshals', (req, res) => {
  const rows = q.all(`SELECT id,code,name,title,emoji,avatar,duty,skills,kb_deps,allies,online,prompt,synced_at
    FROM marshals WHERE code IN (${CURRENT_DEPARTMENT_SQL}) ORDER BY sort`, ...CURRENT_DEPARTMENT_CODES);
  res.json(rows.map(row => mergeMarshal({ ...row })).map(department => ({
    ...department,
    entityLabel: '分部',
    memberLabel: '数字员工',
    specialists: catalogEmployeesForDepartment(department.id),
  })));
});
r.put('/marshals/:id', (req, res) => {
  const { name, title, duty, skills, prompt, online, kb_deps, specialists, rematch_specialists: rematchSpecialists } = req.body || {};
  const base = q.get('SELECT * FROM marshals WHERE id = ?', req.params.id);
  if (!base || !CURRENT_DEPARTMENT_CODE_SET.has(base.code)) return res.status(404).json({ error: '分部不存在' });
  const tid = curTenant();
  // 文案/技能/知识库写「本企业覆盖」，不动全局基线（不影响其他企业）
  const ov = q.get('SELECT * FROM tenant_marshal_overrides WHERE tenant_id=? AND marshal_code=?', tid, base.code) || {};
  // restaurant.json 的 101-160 是唯一权威员工目录。旧前端仍可能提交 specialists/rematch_specialists，
  // 为保持请求兼容这里接受参数但不再写 tenant_specialist_overrides，避免改名/职责覆盖60人目录。
  const catalogParametersIgnored = rematchSpecialists === true || specialists !== undefined;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO tenant_marshal_overrides(tenant_id,marshal_code,name,title,duty,skills,prompt,kb_deps,online,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
      ON CONFLICT(tenant_id,marshal_code) DO UPDATE SET name=excluded.name,title=excluded.title,duty=excluded.duty,
        skills=excluded.skills,prompt=excluded.prompt,kb_deps=excluded.kb_deps,online=excluded.online,updated_at=excluded.updated_at`)
      .run(tid, base.code, name ?? ov.name ?? null, title ?? ov.title ?? null, duty ?? ov.duty ?? null,
        skills ?? ov.skills ?? null, prompt ?? ov.prompt ?? null, kb_deps ?? ov.kb_deps ?? null,
        online !== undefined ? (online ? 1 : 0) : (ov.online ?? null));
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
  const merged = mergeMarshal({ ...base });
  const catalogEmployees = catalogEmployeesForDepartment(base.id);
  logOp(req.user, '管理后台', '编辑分部(本企业)', base.code);
  res.json({ ok: true, marshal: merged, specialists: catalogEmployees,
    catalogManaged: true,
    ignoredLegacySpecialistParameters: catalogParametersIgnored,
    hint: catalogParametersIgnored
      ? '分部配置已保存；数字员工名单由权威60人目录管理，旧版自动重匹配和成员改写参数已忽略'
      : '分部配置已保存（仅对本企业生效，不影响其他企业）；同步后新的数字员工调用立即使用' });
});
r.post('/marshals/:id/sync', (req, res) => {
  const m = q.get('SELECT code,name FROM marshals WHERE id = ?', req.params.id);
  if (!m || !CURRENT_DEPARTMENT_CODE_SET.has(m.code)) return res.status(404).json({ error: '分部不存在' });
  q.run(`INSERT INTO tenant_marshal_overrides(tenant_id,marshal_code,synced_at,updated_at)
    VALUES(?,?,datetime('now','localtime'),datetime('now','localtime'))
    ON CONFLICT(tenant_id,marshal_code) DO UPDATE SET synced_at=excluded.synced_at,updated_at=excluded.updated_at`, curTenant(), m.code);
  const synced = q.get('SELECT synced_at FROM tenant_marshal_overrides WHERE tenant_id=? AND marshal_code=?', curTenant(), m.code);
  logOp(req.user, '管理后台', '同步分部配置', m?.name);
  res.json({ ok: true, synced_at: synced?.synced_at });
});

// —— 接口管理：通道/模型路由/价格（PRD V2 §15）——
r.get('/api-config', requirePlatformConfigOwner, (req, res) => {
  const readiness = buildRuntimeReadiness({ tenantId: curTenant() });
  const aiReadiness = readiness.channels.find(item => item.key === 'ai');
  res.json({
    channel: {
      provider: '云雾API (yunwu.ai)',
      baseUrl: getConfig('yunwu_base_url', null) || process.env.YUNWU_BASE_URL || 'https://yunwu.ai/v1',
      key: maskedKey(),
      keySource: yunwuKeySource(),
      keyPersistence: 'environment_only',
      available: yunwuAvailable(),
      readiness: aiReadiness,
    },
    routing: routing(),
    billing: billing(),
    riskRules: getRules(),
    usage: yunwuUsage(),
    readiness,
  });
});
r.put('/api-config', requirePlatformConfigOwner, async (req, res) => {
  const { routing: rt, billing: bl, baseUrl, apiKey } = req.body || {};
  if (apiKey !== undefined && String(apiKey || '').trim()) {
    return res.status(400).json({
      error: 'API Key 仅支持通过服务端 YUNWU_API_KEY 环境变量配置，本次输入未保存',
    });
  }
  if (baseUrl) {
    // 先做 DNS 解析校验（BE-M5），任何失败都不落库
    try { setConfig('yunwu_base_url', await validatedProviderBase(baseUrl)); }
    catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  }
  if (rt) setConfig('model_routing', rt);
  if (bl) setConfig('billing', bl);
  logOp(req.user, '管理后台', '修改接口配置', [rt && '模型路由', bl && '计费', baseUrl && 'BaseURL'].filter(Boolean).join('+'));
  res.json({ ok: true });
});

// 存量版本曾把云雾 Key 明文写入 sys_config。升级后仅兼容读取，绝不自动删除；
// 只有环境变量已接管且总部管理员二次确认时，才允许显式清除旧值。
r.delete('/api-config/legacy-key', requirePlatformConfigOwner, (req, res) => {
  if (req.body?.confirm !== 'DELETE_LEGACY_YUNWU_KEY') {
    return res.status(400).json({ error: '清除旧密钥需要明确二次确认' });
  }
  if (!String(process.env.YUNWU_API_KEY || '').trim()) {
    return res.status(409).json({
      error: '请先配置服务端 YUNWU_API_KEY 环境变量并重启，确认通道已接管后再清除旧数据库密钥',
    });
  }
  const removed = q.run('DELETE FROM sys_config WHERE key=?', 'yunwu_api_key').changes > 0;
  logOp(req.user, '管理后台', '清除旧数据库API密钥', removed ? '已迁移到环境变量' : '旧配置不存在');
  return res.json({ ok: true, removed, keySource: yunwuKeySource() });
});

// 测试连接：校验 Key/BaseURL 是否可用（拉模型清单）
r.post('/api-config/test', requirePlatformConfigOwner, async (req, res) => {
  const tenantId = curTenant();
  let timer;
  try {
    // 测试连接前重新解析校验一次（防存量配置或 DNS rebinding 把已保存域名指回内网）
    const base = await validatedProviderBase(getConfig('yunwu_base_url', null) || process.env.YUNWU_BASE_URL || 'https://yunwu.ai/v1');
    const key = yunwuApiKey();
    if (!key) {
      recordRuntimeReadinessCheck('ai', {
        tenantId,
        outcome: 'failed',
        checkedBy: req.user.id,
        error: '尚未配置 API Key',
      });
      return res.json({
        ok: false,
        error: '尚未配置 API Key',
        readiness: buildRuntimeReadiness({ tenantId }).channels.find(item => item.key === 'ai'),
      });
    }
    const ctrl = new AbortController(); timer = setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: ctrl.signal });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw providerResponseError(resp.status, data, { service: '云雾AI服务' });
    const n = Array.isArray(data?.data) ? data.data.length : 0;
    recordRuntimeReadinessCheck('ai', {
      tenantId,
      outcome: 'passed',
      checkedBy: req.user.id,
      evidence: { provider: 'yunwu', models: n, baseUrl: base },
    });
    logOp(req.user, '管理后台', '测试API连接', `成功，${n}个模型`);
    res.json({
      ok: true,
      models: n,
      base,
      readiness: buildRuntimeReadiness({ tenantId }).channels.find(item => item.key === 'ai'),
    });
  } catch (error) {
    const safe = sanitizeProviderError(error, { service: '云雾AI服务' });
    recordRuntimeReadinessCheck('ai', {
      tenantId,
      outcome: 'failed',
      checkedBy: req.user.id,
      error: safe.message,
    });
    res.json({
      ok: false,
      error: safe.message,
      readiness: buildRuntimeReadiness({ tenantId }).channels.find(item => item.key === 'ai'),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
});

// —— 积分管理 ——
r.get('/credits', (req, res) => {
  const users = q.all(`SELECT u.id,u.username,u.name,u.role,u.dept,
    COALESCE(SUM(CASE WHEN l.credits>0 THEN l.credits ELSE 0 END),0) spent_credits
    FROM users u LEFT JOIN credit_logs l ON l.tenant_id=u.tenant_id AND l.user_id=u.id
    WHERE u.tenant_id=? AND u.role!='platform_super' GROUP BY u.id ORDER BY u.id`, curTenant());
  res.json({ shared: true, balance: balanceOfTenant(curTenant()), users });
});
r.post('/credits/adjust', (req, res) => {
  const { userId, delta, note } = req.body || {};
  const amount = Number(delta);
  if (!Number.isInteger(Number(userId)) || !Number.isInteger(amount) || amount === 0) return res.status(400).json({ error: '用户与整数调整额度必填' });
  // 老板/管理员可为公司积分池增发或扣减（积分池为租户级共享，加分即充入公司池、全员可用）；防误操作设单次上限
  if (Math.abs(amount) > 100000000) return res.status(400).json({ error: '单次调整额度过大（上限 1 亿分）' });
  // 目标用户必须属于本企业（杜绝跨租户调他人积分）
  if (tenantOf(userId) !== curTenant()) return res.status(404).json({ error: '用户不存在' });
  if (balanceOfTenant(curTenant()) + amount < 0) return res.status(400).json({ error: '扣减后企业积分池不能为负数' });
  const out = adjust({ userId, delta: amount, operatorId: req.user.id, note });
  logOp(req.user, '管理后台', '积分调整', `user#${userId} ${amount > 0 ? '+' : ''}${amount}`);
  res.json({ ...out, message: `${amount > 0 ? '已增发' : '已扣减'} ${Math.abs(amount)} 分，公司积分池当前 ${out.balance} 分` });
});
r.get('/credits/logs', (req, res) => {
  const { userId, kind, mode, from, to, export: exp } = req.query;
  let where = `WHERE l.tenant_id = ${curTenant()}`; const params = []; // 仅本企业流水
  if (userId) { where += ' AND l.user_id = ?'; params.push(userId); }
  if (kind) { where += ' AND l.kind = ?'; params.push(kind); }            // 文本/生图/生视频/充值
  if (mode) { where += ' AND l.ai_mode = ?'; params.push(mode); }
  if (from) { where += ' AND date(l.created_at) >= ?'; params.push(from); }
  if (to) { where += ' AND date(l.created_at) <= ?'; params.push(to); }
  const total = q.get(`SELECT COUNT(*) n FROM credit_logs l ${where}`, ...params)?.n || 0;
  // 导出：返回全部匹配行（上限 5000，防一次性拉爆）；否则分页（size/page 经 pageParams 防 NaN/超限）
  const { size, offset } = pageParams(req.query, 20);
  const lim = exp ? 5000 : size;
  const off = exp ? 0 : offset;
  const cy = billing().creditYuan;
  const rows = q.all(`SELECT l.*, u.name user_name FROM credit_logs l LEFT JOIN users u ON u.id=l.user_id
    ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`, ...params, lim, off)
    .map(r => ({ ...r, spend_yuan: r.credits > 0 ? Math.round(r.credits * cy * 100) / 100 : null })); // 消耗折合人民币（老板花费）
  res.json({ total, rows });
});
r.get('/credits/stats', (req, res) => {
  const T = curTenant();
  const cy = billing().creditYuan;
  // 消耗口径：credits>0（扣费），折合人民币=积分×单价（老板花费，非平台成本）
  res.json({
    byFeature: q.all(`SELECT feature, COUNT(*) n, SUM(credits) credits FROM credit_logs WHERE tenant_id = ${T} AND credits > 0 GROUP BY feature ORDER BY credits DESC LIMIT 10`)
      .map(x => ({ ...x, yuan: Math.round((x.credits || 0) * cy * 100) / 100 })),
    byModel: q.all(`SELECT model, COUNT(*) n, SUM(credits) credits FROM credit_logs WHERE tenant_id = ${T} AND credits > 0 AND model != '' GROUP BY model ORDER BY credits DESC`),
    byDay: q.all(`SELECT date(created_at) d, SUM(credits) credits FROM credit_logs WHERE tenant_id = ${T} AND credits > 0 GROUP BY d ORDER BY d DESC LIMIT 14`),
    byUser: q.all(`SELECT l.user_id, u.name, COUNT(*) n, COALESCE(SUM(l.credits),0) credits FROM credit_logs l LEFT JOIN users u ON u.id=l.user_id
      WHERE l.tenant_id = ${T} AND l.credits > 0 GROUP BY l.user_id ORDER BY credits DESC LIMIT 10`)
      .map(x => ({ ...x, yuan: Math.round((x.credits || 0) * cy * 100) / 100 })),
  });
});

// —— 概览钻取：今日活跃员工明细（谁在用、最近一次干了啥）——
r.get('/active-today', (req, res) => {
  res.json(q.all(`SELECT o.user_id, u.name, u.role, COUNT(*) actions, MAX(o.created_at) last_at,
      (SELECT module || '·' || action FROM op_logs o2 WHERE o2.user_id=o.user_id AND o2.tenant_id = ${curTenant()} ORDER BY o2.id DESC LIMIT 1) last_action
    FROM op_logs o LEFT JOIN users u ON u.id=o.user_id
    WHERE o.tenant_id = ${curTenant()} AND date(o.created_at)=date('now','localtime') AND (u.role IS NULL OR u.role != 'platform_super')
    GROUP BY o.user_id ORDER BY actions DESC`));
});

// —— 媒体任务（生图/生视频记录）——
r.get('/media-jobs', (req, res) => {
  res.json(q.all(`SELECT m.*, u.name user_name FROM media_jobs m LEFT JOIN users u ON u.id=m.user_id WHERE m.tenant_id = ${curTenant()} ORDER BY m.id DESC LIMIT 30`));
});

// —— 安全设置 ——
r.get('/security', (req, res) => {
  res.json(getTenantConfig('security', { tokenHours: 8, maskPhone: true, exportRoles: ['boss', 'ops_director'], loginFailLock: 5 }));
});
r.put('/security', (req, res) => {
  setTenantConfig('security', req.body || {});
  logOp(req.user, '管理后台', '修改安全设置', '');
  res.json({ ok: true });
});

export default r;
