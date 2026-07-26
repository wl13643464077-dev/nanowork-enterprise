import './env.js';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

// 本项目运行数据默认只允许当前用户访问。umask 会保护随后由 SQLite
// 创建的数据库、WAL/SHM 以及运行期文件；不会修改 /tmp 或自定义路径的父目录权限。
process.umask(0o077);

const safeJsonParse = (value, fallback = null) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(DATA_DIR, 0o700);
// 默认使用新项目独立数据库；测试或独立部署只能通过 NANOWORK_DB 显式指定。
export const DB_PATH = process.env.NANOWORK_DB || path.join(DATA_DIR, 'nanowork-industry.db');

function protectDatabaseFiles() {
  if (DB_PATH === ':memory:') return;
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${DB_PATH}${suffix}`;
    if (fs.existsSync(target)) fs.chmodSync(target, 0o600);
  }
}

protectDatabaseFiles();
export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
protectDatabaseFiles();

export function backupDatabase(destination) {
  const output = path.resolve(destination);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (fs.existsSync(output)) throw new Error('备份文件已存在，请重新发起备份');
  const escaped = output.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  const backup = new DatabaseSync(output, { readOnly: true });
  try {
    const integrity = Object.values(backup.prepare('PRAGMA integrity_check').get() || {})[0];
    if (integrity !== 'ok') throw new Error(`备份完整性校验失败：${integrity || 'unknown'}`);
  } finally { backup.close(); }
  fs.chmodSync(output, 0o600);
  return output;
}

export function initSchema() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,            -- boss | ops_director | sales | partner | admin
    dept TEXT,
    phone TEXT,
    avatar TEXT,
    status TEXT DEFAULT '启用',
    auth_version INTEGER DEFAULT 0,
    last_login_at TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    wechat TEXT,
    source TEXT,                   -- 短视频/朋友圈/社群/转介绍/主题试吃/到店/员工推荐
    identity_tag TEXT,             -- 企业主/高管/个体创业者/普通消费者
    interest TEXT,
    budget_level TEXT DEFAULT '未知', -- 高/中/低/未知
    stage TEXT DEFAULT '新线索',    -- 新线索/已沟通/已邀约/已到店/已成交/复购/已流失
    score INTEGER DEFAULT 0,
    grade TEXT DEFAULT 'C',
    score_detail TEXT,             -- JSON 评分构成
    owner_id INTEGER,
    next_follow_at TEXT,
    next_action TEXT,
    region TEXT,
    company TEXT,
    concerns TEXT DEFAULT '[]',    -- JSON [{text,resolved}]
    deal_amount REAL DEFAULT 0,
    deal_reason TEXT,
    lost_reason TEXT,
    referrer TEXT,
    path_type TEXT,                -- 消费客户/团购客户/合伙人候选/馆主候选
    last_interact_at TEXT,
    boss_alert INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS follow_ups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    user_id INTEGER,
    content TEXT,
    stage_after TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS lead_ai_suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    user_id INTEGER,
    context TEXT,
    suggestion TEXT,
    purpose TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS partners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    level TEXT,                    -- 城市合伙人/馆主/区域运营商
    region TEXT,
    phone TEXT,
    status TEXT DEFAULT '活跃',
    joined_at TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS partner_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    studied INTEGER DEFAULT 0,
    posted_moments INTEGER DEFAULT 0,
    posted_videos INTEGER DEFAULT 0,
    invited INTEGER DEFAULT 0,
    invite_count INTEGER DEFAULT 0,
    intent_count INTEGER DEFAULT 0,
    arrive_count INTEGER DEFAULT 0,
    deal_count INTEGER DEFAULT 0,
    problem TEXT,
    score INTEGER DEFAULT 0,
    UNIQUE(partner_id, date)
  );
  CREATE TABLE IF NOT EXISTS daily_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,
    content_count INTEGER DEFAULT 0,
    new_leads INTEGER DEFAULT 0,
    invited INTEGER DEFAULT 0,
    arrived INTEGER DEFAULT 0,
    deals INTEGER DEFAULT 0,
    deal_amount REAL DEFAULT 0,
    repurchase_amount REAL DEFAULT 0,
    active_partners INTEGER DEFAULT 0,
    orders INTEGER DEFAULT 0,
    marketing_cost REAL DEFAULT 0,
    week_problem TEXT,
    next_action TEXT
  );
  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    type TEXT,                     -- 主题试吃/新品发布/企业团餐沙龙/合作说明会/会员日
    status TEXT DEFAULT '策划中',   -- 策划中/筹备中/报名中/进行中/已结束/已复盘
    date TEXT,
    end_date TEXT,
    location TEXT,
    target_join INTEGER DEFAULT 0,
    target_deal REAL DEFAULT 0,
    budget REAL DEFAULT 0,
    cost REAL DEFAULT 0,
    invited INTEGER DEFAULT 0,
    signed_up INTEGER DEFAULT 0,
    arrived INTEGER DEFAULT 0,
    converted INTEGER DEFAULT 0,
    revenue REAL DEFAULT 0,
    satisfaction REAL DEFAULT 0,
    plan TEXT,                     -- JSON 策划案
    review TEXT,                   -- JSON 复盘
    checklist TEXT DEFAULT '[]',   -- JSON 筹备清单
    owner_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS activity_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL,
    lead_id INTEGER NOT NULL,
    status TEXT DEFAULT '待邀约',   -- 待邀约/已邀约/已报名/已到场/已转化/爽约
    note TEXT,
    UNIQUE(activity_id, lead_id)
  );
  CREATE TABLE IF NOT EXISTS contents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,            -- 短视频脚本/朋友圈文案/社群话题/私聊邀约话术/招商文案/复购礼赠文案/AI图片/AIPPT/AI音频/活动策划/周报/作战计划
    title TEXT,
    body TEXT,
    topic TEXT,
    brand TEXT DEFAULT '',
    status TEXT DEFAULT '草稿',     -- 草稿/待审核/可使用/已发布/已驳回
    risk_flags TEXT DEFAULT '[]',
    risk_level TEXT DEFAULT 'none',
    ai_mode TEXT DEFAULT 'template', -- api | template
    creator_id INTEGER,
    marshal_id INTEGER,
    content_employee_idx INTEGER,
    content_employee_key TEXT,
    content_employee_name TEXT,
    content_employee_group TEXT,
    content_run_mode TEXT,
    profile_version TEXT,
    prompt_hash TEXT,
    snapshot_json TEXT,
    source_type TEXT,
    source_id INTEGER,
    channel TEXT,
    effect_views INTEGER DEFAULT 0,
    effect_leads INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS content_publish_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    content_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    views INTEGER NOT NULL DEFAULT 0 CHECK(views >= 0),
    leads INTEGER NOT NULL DEFAULT 0 CHECK(leads >= 0),
    idempotency_key TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(tenant_id,content_id,idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_content_publish_logs_content
    ON content_publish_logs(tenant_id,content_id,created_at DESC,id DESC);
  CREATE TABLE IF NOT EXISTS content_automation_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    employee_idx INTEGER NOT NULL CHECK(employee_idx BETWEEN 0 AND 9),
    topic TEXT NOT NULL CHECK(length(topic) BETWEEN 1 AND 100),
    requirement TEXT NOT NULL DEFAULT '' CHECK(length(requirement) <= 2000),
    content_type TEXT NOT NULL,
    content_count INTEGER NOT NULL DEFAULT 3 CHECK(content_count BETWEEN 1 AND 10),
    frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly')),
    run_time TEXT NOT NULL CHECK(
      run_time GLOB '[0-2][0-9]:[0-5][0-9]'
      AND CAST(substr(run_time,1,2) AS INTEGER) BETWEEN 0 AND 23
    ),
    weekday INTEGER CHECK(weekday BETWEEN 1 AND 7),
    approval_mode TEXT NOT NULL DEFAULT 'always' CHECK(approval_mode IN ('risk','always')),
    next_run_at TEXT,
    last_run_at TEXT,
    last_status TEXT,
    last_error TEXT,
    last_content_id INTEGER,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS content_automation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    rule_id INTEGER NOT NULL,
    trigger TEXT NOT NULL CHECK(trigger IN ('scheduled','immediate')),
    claim_key TEXT NOT NULL,
    scheduled_for TEXT,
    status TEXT NOT NULL DEFAULT '运行中' CHECK(status IN ('运行中','成功','失败')),
    content_id INTEGER,
    initiated_by INTEGER,
    profile_version TEXT,
    prompt_hash TEXT,
    snapshot_json TEXT,
    error TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    finished_at TEXT,
    UNIQUE(tenant_id,rule_id,trigger,claim_key)
  );
  CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, type TEXT, tags TEXT, url TEXT,
    source_type TEXT, source_id INTEGER, note TEXT,
    body_snapshot TEXT,
    artifact_snapshot_json TEXT,
    snapshot_hash TEXT,
    use_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS content_material_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    target_type TEXT NOT NULL CHECK(target_type IN ('content','media_job')),
    target_id INTEGER NOT NULL,
    material_id INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(tenant_id,target_type,target_id,material_id)
  );
  CREATE INDEX IF NOT EXISTS idx_content_material_refs_target
    ON content_material_refs(tenant_id,target_type,target_id,id);
  CREATE INDEX IF NOT EXISTS idx_content_material_refs_material
    ON content_material_refs(tenant_id,material_id,id);
  CREATE TABLE IF NOT EXISTS content_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, type TEXT, prompt TEXT, tags TEXT, description TEXT, source TEXT,
    use_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS marshals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE, name TEXT, title TEXT, emoji TEXT,
    duty TEXT, skills TEXT, kb_deps TEXT, allies TEXT,
    online INTEGER DEFAULT 1, sort INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS custom_agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    name TEXT, emoji TEXT, tier TEXT DEFAULT 'simple',
    prompt TEXT, skills TEXT, persona TEXT,
    creator_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS specialists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marshal_id INTEGER NOT NULL,
    name TEXT, duty TEXT, status TEXT DEFAULT '空闲',
    last_output_id INTEGER,
    employee_idx INTEGER,
    key TEXT,
    person TEXT,
    emoji TEXT,
    description TEXT,
    profile_json TEXT DEFAULT '{}',
    group_name TEXT,
    sort INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS agent_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marshal_id INTEGER NOT NULL,
    specialist_id INTEGER,
    title TEXT, type TEXT, requirement TEXT,
    status TEXT DEFAULT '执行中',   -- 执行中/待审阅/已完成/已驳回
    is_collab INTEGER DEFAULT 0,
    collab_marshals TEXT,
    due_at TEXT,
    output_id INTEGER,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS battle_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,
    theme TEXT, audience TEXT,
    plan TEXT,                     -- JSON 完整计划
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS weekly_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week TEXT UNIQUE NOT NULL,     -- 2026-W23
    report TEXT,                   -- JSON
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT, target_id INTEGER,
    title TEXT, summary TEXT,
    risk_level TEXT, rules_hit TEXT,
    status TEXT DEFAULT '待审核',   -- 待审核/已通过/已驳回
    submitter_id INTEGER, reviewer_id INTEGER,
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    decided_at TEXT
  );
  CREATE TABLE IF NOT EXISTS kb_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT,                 -- 品牌资料/招商政策/话术案例/客户画像
    title TEXT, body TEXT,
    source_type TEXT,              -- 可选来源类型；内容自动沉淀使用 content
    source_id INTEGER,             -- 来源业务记录 id，与 source_type/tenant_id 共同幂等
    enabled INTEGER DEFAULT 1,
    ref_count INTEGER DEFAULT 0,
    version INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS kb_chunks (
    -- RAG 分块召回：长文档切块分别向量化，按块检索（租户隔离经由 doc_id JOIN kb_docs 保证，不单独存 tenant_id）
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id);
  CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE, name TEXT, role_card TEXT, output_rule TEXT, style TEXT,
    version INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT UNIQUE,            -- 2026 / 2026-Q2 / 2026-06
    revenue_target REAL DEFAULT 0,
    leads_target INTEGER DEFAULT 0,
    partner_target INTEGER DEFAULT 0,
    activity_target INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, detail TEXT,
    type TEXT,                     -- 内容/邀约/跟进/活动/培训/数据/其他
    status TEXT DEFAULT '待执行',   -- 待执行/进行中/待审核/已完成
    priority TEXT DEFAULT '中',
    assignee_id INTEGER,
    due_at TEXT,
    source TEXT DEFAULT '手动',     -- 作战计划/手动/数字员工/活动
    risk INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    done_at TEXT
  );
  CREATE TABLE IF NOT EXISTS task_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER, user_id INTEGER,
    content TEXT, result TEXT DEFAULT '待审核', -- 待审核/通过/驳回
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS employee_point_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT,
    source TEXT DEFAULT 'manual',
    operator_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS employee_awards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    period TEXT NOT NULL,
    award_type TEXT DEFAULT '月度优秀员工',
    score INTEGER DEFAULT 0,
    comment TEXT,
    operator_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(user_id, period, award_type)
  );
  CREATE TABLE IF NOT EXISTS biz_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, category TEXT,      -- 内容资产/知识资产/客户资产/数据资产/品牌资产
    value REAL DEFAULT 0,
    status TEXT DEFAULT '使用中',   -- 使用中/闲置/待归档/已归档
    use_count INTEGER DEFAULT 0,
    owner TEXT,
    source_type TEXT, source_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS asset_flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER, action TEXT, note TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS ai_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, title TEXT, diag_type TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER, role TEXT, content TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, type TEXT, title TEXT, body TEXT,
    read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS op_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, username TEXT, module TEXT, action TEXT, target TEXT, ip TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS login_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER DEFAULT 0,
    username TEXT, success INTEGER, ip TEXT, ua TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER, product TEXT, amount REAL, type TEXT, -- 到店/外卖/团餐/定制
    region TEXT, channel TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS sys_config (
    key TEXT PRIMARY KEY, value TEXT
  );
  -- ===== 餐饮真数据模型（审计报告 P0）：门店/菜品/订单明细/成本 =====
  -- 新表直接内建 tenant_id（与 content_publish_logs 等新表一致，不依赖 migrateV2 补列），
  -- 并登记进下方 ISOLATED 集合：INSERT 自动注入租户、读取走 q.scopedAll/scopedGet。
  CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    code TEXT,
    address TEXT,
    city TEXT,
    area TEXT,
    biz_type TEXT DEFAULT '快餐',        -- 快餐/正餐/茶饮/火锅/其他
    opened_at TEXT,
    status TEXT DEFAULT '营业中',         -- 营业中/筹备中/已关店
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS dishes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    store_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    code TEXT,
    category TEXT,
    price REAL DEFAULT 0,
    cost REAL DEFAULT 0,
    unit TEXT,
    status TEXT DEFAULT '在售',           -- 在售/下架
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS order_items (
    -- 订单明细：orders 表保留为订单头（o.product 字段不动，向后兼容）
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    order_id INTEGER NOT NULL,
    dish_id INTEGER,
    dish_name_snapshot TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    amount REAL NOT NULL DEFAULT 0,
    discount REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    store_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    category TEXT NOT NULL,               -- 食材/人力/房租/水电/营销/其他
    amount REAL NOT NULL,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_stores_tenant_status ON stores(tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_dishes_tenant_store ON dishes(tenant_id, store_id, status);
  CREATE INDEX IF NOT EXISTS idx_order_items_tenant_order ON order_items(tenant_id, order_id);
  CREATE INDEX IF NOT EXISTS idx_order_items_tenant_dish ON order_items(tenant_id, dish_id);
  CREATE INDEX IF NOT EXISTS idx_costs_tenant_date ON costs(tenant_id, date);
  CREATE INDEX IF NOT EXISTS idx_costs_tenant_store ON costs(tenant_id, store_id, date);
  CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
  CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(owner_id);
  CREATE INDEX IF NOT EXISTS idx_follow_lead ON follow_ups(lead_id);
  CREATE INDEX IF NOT EXISTS idx_lead_ai_suggestions_lead ON lead_ai_suggestions(lead_id);
  CREATE INDEX IF NOT EXISTS idx_pa_date ON partner_actions(date);
  CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(created_at);
  `);
}

// ===== 多租户上下文（数据隔离地基）=====
const _tctx = new AsyncLocalStorage();
export const curTenant = () => _tctx.getStore() ?? 1;             // 当前请求租户（无上下文=总部1）
export const runWithTenant = (tid, fn) => _tctx.run(Number(tid) || 1, fn);

// 需按租户隔离的业务表（系统级表如 marshals/prompts/recharge_packages/users/tenants 不在内）
const ISOLATED = new Set([
  'leads', 'follow_ups', 'lead_ai_suggestions', 'partners', 'partner_actions', 'daily_ops', 'activities', 'activity_invites',
  'contents', 'materials', 'content_templates', 'agent_tasks', 'battle_plans', 'weekly_reviews', 'approvals',
  'kb_docs', 'goals', 'tasks', 'task_submissions', 'employee_point_logs', 'employee_awards', 'biz_assets', 'asset_flows', 'orders', 'lead_journey',
  'ai_conversations', 'ai_messages', 'marshal_chat_sessions', 'marshal_chat_msgs', 'media_jobs', 'op_logs', 'custom_agents',
  'uploaded_files', 'generated_artifacts', 'conversation_memories', 'dashboard_widget_preferences',
  'activity_plan_drafts', 'custom_agent_chat_sessions', 'custom_agent_chat_msgs', 'data_import_jobs', 'data_import_commits', 'data_import_items',
  'deleted_records', 'scheduled_runs', 'notifications', 'tool_runs', 'tool_run_events',
  'employee_workbench_configs', 'content_employee_workbench_configs', 'content_employee_runs',
  'content_automation_rules', 'content_automation_runs', 'content_publish_logs', 'content_material_refs',
  'stores', 'dishes', 'order_items', 'costs',
  // 注：specialists（数字员工）与 marshals（内部任务分部）一样是全局基础数据，全租户共享同一份编制，
  // 不在隔离集——读取本就应跨租户取全量；如误列入会导致非总部企业看到 0 个专员。
]);
function matchParen(s, open) {
  let d = 0;
  for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) return i; } }
  return -1;
}
// 给隔离表的 INSERT 自动注入 tenant_id 列与值（写入侧零散漏防护）。
// 兜底（BE-C2）：INSERT..SELECT / 无列名清单 / 畸形语句无法注入时直接抛错，
// 绝不静默落 DEFAULT 1（总部租户）——显式写 tenant_id 列可放行，平台级操作请用 qRaw.run。
function injectTenantInsert(sql, tid) {
  const head = sql.match(/^\s*INSERT(?:\s+OR\s+\w+)?\s+INTO\s+([a-z_][a-z0-9_]*)/i);
  if (!head || !ISOLATED.has(head[1].toLowerCase())) return sql;
  const reject = (why) => {
    throw new Error(`隔离表 ${head[1]} 的 INSERT 无法自动注入 tenant_id（${why}）：` +
      `请显式指定 tenant_id 列，平台级跨租户写入请改用 qRaw.run。SQL：${sql.trim().slice(0, 120)}`);
  };
  let colOpen = head[0].length;
  while (colOpen < sql.length && /\s/.test(sql[colOpen])) colOpen++;
  if (sql[colOpen] !== '(') return reject('缺少列名清单，如 INSERT..SELECT/裸 VALUES');
  const colClose = matchParen(sql, colOpen);
  if (colClose < 0) return reject('列名清单括号不闭合');
  if (/\btenant_id\b/i.test(sql.slice(colOpen, colClose))) return sql; // 已显式指定
  const vIdx = sql.toUpperCase().indexOf('VALUES', colClose);
  if (vIdx < 0) return reject('无 VALUES 子句，如 INSERT..SELECT');
  let pos = vIdx + 'VALUES'.length, cursor = 0, out = '', patched = 0;
  while (pos < sql.length) {
    while (/\s/.test(sql[pos])) pos++;
    if (sql[pos] !== '(') break;
    const valClose = matchParen(sql, pos);
    if (valClose < 0) return reject('VALUES 值组括号不闭合');
    out += sql.slice(cursor, valClose) + `,${tid}`;
    cursor = valClose;
    patched++;
    pos = valClose + 1;
    while (/\s/.test(sql[pos])) pos++;
    if (sql[pos] !== ',') break;
    pos++;
  }
  if (!patched) return reject('未找到可注入的 VALUES 值组');
  out += sql.slice(cursor);
  out = out.slice(0, colClose) + ',tenant_id' + out.slice(colClose);
  return out;
}

// ===== BE-C2 读侧作用域强制：隔离表读查询的安全入口 =====
// 自动以参数占位追加 tenant_id 过滤（首个绑定参数即当前租户），开发者忘写 WHERE tenant_id 也不会跨租户泄露。
// tail 只允许为空或以 AND / ORDER BY / GROUP BY / LIMIT 开头；条件顶层禁止裸 OR
// （防 `tenant_id=? AND a OR b` 优先级击穿隔离，需要 OR 请自行加括号）。
function scopedSelect(table, tail = '', cols = '*') {
  if (!ISOLATED.has(table)) throw new Error(`scoped 查询仅限隔离表：${table} 不在隔离集（全局表请直接用 q.all/q.get）`);
  const t = String(tail || '').trim();
  if (t && !/^(AND|ORDER\s+BY|GROUP\s+BY|LIMIT)\b/i.test(t)) {
    throw new Error(`scoped 查询附加片段须以 AND/ORDER BY/GROUP BY/LIMIT 开头：${t.slice(0, 60)}`);
  }
  for (let i = 0, depth = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "'") { i = t.indexOf("'", i + 1); if (i < 0) break; continue; } // 跳过字符串字面量
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /^or\b/i.test(t.slice(i)) && (i === 0 || /[\s)]/.test(t[i - 1]))) {
      throw new Error(`scoped 查询顶层禁止裸 OR（会击穿 tenant_id 过滤），请加括号：${t.slice(0, 60)}`);
    }
  }
  return `SELECT ${cols} FROM ${table} WHERE tenant_id = ?${t ? ` ${t}` : ''}`;
}

export const q = {
  all: (sql, ...p) => db.prepare(sql).all(...p),
  get: (sql, ...p) => db.prepare(sql).get(...p),
  run: (sql, ...p) => db.prepare(injectTenantInsert(sql, curTenant())).run(...p),
  // 读侧作用域包装（BE-C2）：q.scopedAll('leads', 'AND stage = ? ORDER BY created_at DESC', stage)
  scopedAll: (table, tail = '', ...p) => db.prepare(scopedSelect(table, tail)).all(curTenant(), ...p),
  scopedGet: (table, tail = '', ...p) => db.prepare(scopedSelect(table, tail)).get(curTenant(), ...p),
  scopedCount: (table, tail = '', ...p) => db.prepare(scopedSelect(table, tail, 'COUNT(*) n')).get(curTenant(), ...p)?.n || 0,
};
// 跨租户写入（平台超管/迁移用）：绕过自动注入，显式指定 tenant_id
export const qRaw = { run: (sql, ...p) => db.prepare(sql).run(...p) };

// ===== V2 增量迁移：积分体系 / 菜单级权限 / 数字员工提示词 / 媒体生成任务 =====
export function migrateV2() {
  const addCol = (table, col, def) => {
    if (!/^[a-z_][a-z0-9_]*$/i.test(table) || !/^[a-z_][a-z0-9_]*$/i.test(col)) {
      throw new Error(`非法迁移标识符：${table}.${col}`);
    }
    // 新库中的少数兼容表会在本函数稍后由 CREATE IF NOT EXISTS 建立，届时已包含目标列。
    const tableExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
    if (!tableExists) return;
    const exists = db.prepare(`PRAGMA table_info("${table}")`).all().some(item => item.name === col);
    if (!exists) db.exec(`ALTER TABLE "${table}" ADD COLUMN "${col}" ${def}`);
  };
  const defaultMarshalAvatar = (code) => `/avatars/${code}.png`;
  addCol('users', 'credits', 'INTEGER DEFAULT 0');
  addCol('users', 'manager_id', 'INTEGER');
  addCol('users', 'modules', 'TEXT');            // JSON 数组，用户级菜单覆盖（空=继承角色）
  addCol('users', 'auth_version', 'INTEGER DEFAULT 0'); // 改密后递增，立即吊销历史会话
  addCol('marshals', 'prompt', 'TEXT');
  addCol('marshals', 'avatar', 'TEXT');          // 内部任务分部头像
  addCol('marshals', 'synced_at', 'TEXT');       // 最近同步时间
  // 餐饮数字员工目录元数据。保留 marshal_id/name/duty/status 以兼容既有派活主外键和查询。
  addCol('specialists', 'employee_idx', 'INTEGER');
  addCol('specialists', 'key', 'TEXT');
  addCol('specialists', 'person', 'TEXT');
  addCol('specialists', 'emoji', 'TEXT');
  addCol('specialists', 'description', 'TEXT');
  addCol('specialists', 'profile_json', "TEXT DEFAULT '{}'");
  addCol('specialists', 'group_name', 'TEXT');
  addCol('specialists', 'sort', 'INTEGER DEFAULT 0');
  addCol('agent_tasks', 'employee_profile_version', 'TEXT');
  addCol('agent_tasks', 'employee_prompt_hash', 'TEXT');
  addCol('agent_tasks', 'employee_capabilities_snapshot', 'TEXT');
  addCol('agent_tasks', 'employee_config_snapshot', 'TEXT');
  addCol('agent_tasks', 'employee_skills_snapshot', 'TEXT');
  addCol('agent_tasks', 'employee_input_snapshot', 'TEXT');
  addCol('agent_tasks', 'employee_web_snapshot', 'TEXT');
  addCol('materials', 'source_type', 'TEXT');
  addCol('materials', 'source_id', 'INTEGER');
  addCol('materials', 'creator_id', 'INTEGER');
  addCol('materials', 'note', 'TEXT');
  addCol('materials', 'body_snapshot', 'TEXT');
  addCol('materials', 'artifact_snapshot_json', 'TEXT');
  addCol('materials', 'snapshot_hash', 'TEXT');
  addCol('contents', 'source_type', 'TEXT');
  addCol('contents', 'source_id', 'INTEGER');
  addCol('biz_assets', 'creator_id', 'INTEGER');
  addCol('biz_assets', 'url', 'TEXT');
  addCol('biz_assets', 'note', 'TEXT');
  addCol('asset_flows', 'operator_id', 'INTEGER');
  addCol('media_jobs', 'task_id', 'TEXT');
  addCol('media_jobs', 'result_id', 'INTEGER'); // 后台文本生成完成后指向 contents.id
  for (const table of ['contents', 'media_jobs']) {
    addCol(table, 'content_employee_idx', 'INTEGER');
    addCol(table, 'content_employee_key', 'TEXT');
    addCol(table, 'content_employee_name', 'TEXT');
    addCol(table, 'content_employee_group', 'TEXT');
    addCol(table, 'content_run_mode', 'TEXT');
    addCol(table, 'profile_version', 'TEXT');
    addCol(table, 'prompt_hash', 'TEXT');
    addCol(table, 'snapshot_json', 'TEXT');
  }
  addCol('content_templates', 'tags', 'TEXT');
  addCol('content_templates', 'description', 'TEXT');
  addCol('content_templates', 'source', 'TEXT');
  addCol('login_logs', 'tenant_id', 'INTEGER DEFAULT 0');
  db.exec(`UPDATE login_logs
    SET tenant_id=COALESCE((SELECT tenant_id FROM users WHERE users.username=login_logs.username LIMIT 1),0)
    WHERE tenant_id IS NULL OR tenant_id=0`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_login_logs_tenant_created ON login_logs(tenant_id,created_at)');
  for (const row of db.prepare(`SELECT id, code, avatar FROM marshals WHERE code LIKE 'M-__'`).all()) {
    if (!row.avatar) db.prepare('UPDATE marshals SET avatar = ? WHERE id = ?').run(defaultMarshalAvatar(row.code), row.id);
  }
  db.exec(`
  CREATE TABLE IF NOT EXISTS credit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    feature TEXT, kind TEXT, model TEXT,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    cost_yuan REAL DEFAULT 0, credits INTEGER DEFAULT 0, balance_after INTEGER DEFAULT 0,
    ai_mode TEXT DEFAULT 'api', note TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS media_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, kind TEXT, model TEXT, prompt TEXT,
    status TEXT DEFAULT '处理中',  -- 处理中/成功/失败
    url TEXT, task_id TEXT, error TEXT, credits INTEGER DEFAULT 0,
    result_id INTEGER,
    content_employee_idx INTEGER,
    content_employee_key TEXT,
    content_employee_name TEXT,
    content_employee_group TEXT,
    content_run_mode TEXT,
    profile_version TEXT,
    prompt_hash TEXT,
    snapshot_json TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS employee_point_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT,
    source TEXT DEFAULT 'manual',
    operator_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS employee_awards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    period TEXT NOT NULL,
    award_type TEXT DEFAULT '月度优秀员工',
    score INTEGER DEFAULT 0,
    comment TEXT,
    operator_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(user_id, period, award_type)
  );
  CREATE INDEX IF NOT EXISTS idx_credit_user ON credit_logs(user_id);
  CREATE INDEX IF NOT EXISTS idx_employee_points_user ON employee_point_logs(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_employee_awards_user ON employee_awards(user_id, period);
  CREATE TABLE IF NOT EXISTS marshal_chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marshal_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    title TEXT, created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS marshal_chat_msgs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL, role TEXT, content TEXT, image TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_mcs_user ON marshal_chat_sessions(user_id, marshal_id);
  `);
  // 初始积分（仅首次：全部为0时发放）
  const any = db.prepare('SELECT COUNT(*) n FROM users WHERE credits > 0').get();
  if (any && any.n === 0) {
    const grants = { boss: 100000, ops_director: 50000, sales: 20000, admin: 30000, partner: 5000 };
    for (const [role, c] of Object.entries(grants))
      db.prepare('UPDATE users SET credits = ? WHERE role = ?').run(c, role);
  }
  // 三级权限出厂矩阵（客户口径）：老板=总控+老板参谋+餐饮数字员工（含审批所在的系统管理）；
  // 中层管理=其余经营模块；员工=基础模块+按部门匹配。版本号升级时强制刷新默认值。
  const MATRIX_VERSION = 4; // V4：管理层开放餐饮数字员工（管理层是执行调度者，需要派任务/协同/审阅产出）
  const ver = db.prepare(`SELECT value FROM sys_config WHERE key = 'role_modules_version'`).get();
  if (!ver || Number(safeJsonParse(ver.value, 0)) < MATRIX_VERSION) {
    db.prepare(`INSERT INTO sys_config(key,value) VALUES('role_modules',?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify({
      boss: ['dashboard', 'advisor', 'marshals', 'growth', 'activities', 'content', 'execution', 'analysis', 'assets', 'system'], // 超级权限：全模块+管理后台
      ops_director: ['dashboard', 'marshals', 'growth', 'activities', 'content', 'execution', 'analysis', 'assets', 'system'], // 中层：经营执行面+数字员工调度；老板参谋仍为老板专属决策位
      sales: ['dashboard', 'execution'],                                         // 员工基础包，部门追加见 dept_modules
      admin: ['dashboard', 'system'],
      partner: ['execution'],
    }));
    db.prepare(`INSERT INTO sys_config(key,value) VALUES('dept_modules',?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify({
      '销售部': ['growth'],
      '活动部': ['activities'],
      '内容部': ['content'],
      '运营中心': ['growth', 'activities', 'content'],
    }));
    db.prepare(`INSERT INTO sys_config(key,value) VALUES('feature_flags',?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify({
      'content.image': ['boss', 'ops_director', 'sales'],
      'content.video': ['boss', 'ops_director'],
      'data.export': ['boss', 'ops_director'],
    }));
    db.prepare(`INSERT INTO sys_config(key,value) VALUES('role_modules_version',?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(MATRIX_VERSION));
  }
  // 内部任务分部默认提示词（空则按职责生成）
  const ms = db.prepare('SELECT id, name, title, duty, prompt FROM marshals').all();
  for (const m of ms) {
    if (!m.prompt) {
      db.prepare('UPDATE marshals SET prompt = ?, synced_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(
        `你是餐饮数字员工组织的「${m.name}」内部任务分部。职责：${m.duty}。输出必须基于用户提供的信息，结论具体可执行；缺少必要输入时明确列出。涉及食品安全、法律、财务、个人数据或外部执行时，必须标明人工复核与授权边界。`, m.id);
    }
  }

  // V3：客户生命周期节点（官方11节点口径，来自谈判表 DASH-02 客户补充）+ 客户行业字段
  addCol('leads', 'industry', 'TEXT');
  // V4：知识库附件（文档/图片上传，FR-SYS-08）
  addCol('kb_docs', 'file_path', 'TEXT');
  addCol('kb_docs', 'file_type', 'TEXT');
  addCol('kb_docs', 'file_name', 'TEXT');
  // Activity plan approval workflow: draft -> ops review -> boss final review -> calendar sync.
  addCol('activities', 'plan_status', "TEXT DEFAULT '未提交'");
  addCol('activities', 'plan_submitted_at', 'TEXT');
  addCol('activities', 'plan_approved_at', 'TEXT');
  addCol('activities', 'plan_approval_id', 'INTEGER');
  addCol('tasks', 'activity_id', 'INTEGER');
  addCol('tasks', 'activity_plan_item', 'TEXT');
  addCol('tasks', 'assigned_by', 'INTEGER');
  addCol('tasks', 'feishu_notified', 'INTEGER DEFAULT 0');
  addCol('approvals', 'payload', 'TEXT');
  addCol('approvals', 'approval_level', 'TEXT');
  addCol('approvals', 'parent_id', 'INTEGER');
  // V5：知识库权限（FR-SYS-09）：visible_roles=谁可查看，callable_roles=谁的AI调用可引用；NULL=全部角色
  addCol('kb_docs', 'visible_roles', 'TEXT');
  addCol('kb_docs', 'callable_roles', 'TEXT');
  // 对话上下文与产出档案：历史不再只做展示，服务端会真正带入下一轮模型调用。
  addCol('ai_conversations', 'updated_at', 'TEXT');
  addCol('ai_conversations', 'summary', 'TEXT');
  addCol('ai_conversations', 'memory', 'TEXT');
  addCol('ai_conversations', 'pinned', 'INTEGER DEFAULT 0');
  addCol('ai_messages', 'attachments_json', 'TEXT');
  addCol('ai_messages', 'artifact_id', 'INTEGER');
  addCol('marshal_chat_sessions', 'tenant_id', 'INTEGER DEFAULT 1');
  addCol('marshal_chat_sessions', 'updated_at', 'TEXT');
  addCol('marshal_chat_sessions', 'summary', 'TEXT');
  addCol('marshal_chat_sessions', 'memory', 'TEXT');
  addCol('marshal_chat_sessions', 'pinned', 'INTEGER DEFAULT 0');
  addCol('marshal_chat_msgs', 'tenant_id', 'INTEGER DEFAULT 1');
  addCol('marshal_chat_msgs', 'attachments_json', 'TEXT');
  addCol('marshal_chat_msgs', 'artifact_id', 'INTEGER');
  db.prepare(`UPDATE ai_conversations SET updated_at=COALESCE(updated_at,created_at) WHERE updated_at IS NULL`).run();
  db.prepare(`UPDATE marshal_chat_sessions SET updated_at=COALESCE(updated_at,created_at) WHERE updated_at IS NULL`).run();
  // 知识库分类可自定义（默认七类）
  const kbCats = db.prepare(`SELECT value FROM sys_config WHERE key = 'kb_categories'`).get();
  if (!kbCats) db.prepare(`INSERT INTO sys_config(key,value) VALUES('kb_categories',?)`).run(
    JSON.stringify(['品牌资料', '经营制度', '菜单产品', '沟通案例', '顾客画像', '数据规范', '员工产出']));
  // V5：可运营提示词收口（生图/生视频/AIPPT/老板参谋风格 → 系统管理·提示词模板，老板升级即全员生效）
  db.exec(`INSERT OR IGNORE INTO prompts(code,name,role_card,output_rule,style) VALUES
    ('GEN-IMG','AI图片通用提示词','你是餐饮品牌的商业视觉导演，服务菜品、门店、活动和员工内容场景。',NULL,'画面真实可落地，不生成错误文字；品牌、价格和食品功效信息必须以企业资料为准。'),
    ('GEN-VIDEO','AI视频通用提示词','你是餐饮品牌的视频导演，负责把菜品、门店、人物和活动转成可执行镜头。',NULL,'镜头叙事清楚，不虚构顾客评价、经营成效或食品功效；外发前由负责人复核。'),
    ('GEN-PPT','AIPPT结构化提示词','你是餐饮经营演示文稿策划师，输出结构化逐页大纲。','每页3-5条要点，每条不超过24字；演讲备注使用清楚、自然的提词。','结论基于已提供的数据；缺失信息标为待确认，不编造金额、收益或监管结论。'),
    ('ADVISOR-STYLE','老板参谋全局风格指令',NULL,NULL,'回答落到可执行动作；涉及食品安全、金额、承诺和个人数据时给出风险提示；优先引用知识库与可追溯经营数据。')`);
  db.exec(`
  CREATE TABLE IF NOT EXISTS lead_journey (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    node TEXT NOT NULL,            -- 新线索/已联系/已建档/已邀约/已到馆/已品鉴/已报价/待成交/已成交/复购/转介绍
    at TEXT,
    by TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(lead_id, node)
  );
  CREATE INDEX IF NOT EXISTS idx_journey_lead ON lead_journey(lead_id);
  `);

  // ===== V6：SaaS 多租户化（注册售卖 + 充值体系，FR-SAAS-01~05）=====
  // 租户=购买系统的企业；积分池在租户层（企业内多账号共享）；本公司=租户1
  db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,                  -- 企业名称
    contact_name TEXT,                   -- 联系人
    phone TEXT,
    status TEXT DEFAULT '待审核',         -- 待审核 / 已开通 / 已停用
    plan TEXT DEFAULT '标准版',           -- 版本/套餐档（基础版/标准版/旗舰版）
    modules TEXT,                        -- JSON：该租户开通的模块（NULL=全部开通）
    data_mode TEXT NOT NULL DEFAULT 'live' CHECK(data_mode IN ('live','demo')),
    credits INTEGER DEFAULT 0,           -- 企业积分池余额
    total_recharged INTEGER DEFAULT 0,   -- 累计充值积分（对账用）
    note TEXT,
    approved_by INTEGER, approved_at TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS recharge_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, price_yuan REAL NOT NULL,
    base_credits INTEGER NOT NULL, bonus_credits INTEGER DEFAULT 0, total_credits INTEGER NOT NULL,
    tag TEXT, sort INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS recharge_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT UNIQUE NOT NULL,
    tenant_id INTEGER NOT NULL, package_id INTEGER, package_name TEXT,
    price_yuan REAL NOT NULL, credits INTEGER NOT NULL,
    status TEXT DEFAULT '待支付',          -- 待支付 / 已支付 / 已取消
    pay_method TEXT DEFAULT '对公转账/收款码',
    created_by INTEGER, confirmed_by INTEGER, paid_at TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_recharge_tenant ON recharge_orders(tenant_id);
  `);
  addCol('tenants', 'data_mode', "TEXT NOT NULL DEFAULT 'live' CHECK(data_mode IN ('live','demo'))");
  addCol('users', 'tenant_id', 'INTEGER DEFAULT 1');
  addCol('credit_logs', 'tenant_id', 'INTEGER DEFAULT 1');
  addCol('materials', 'tenant_id', 'INTEGER DEFAULT 1');
  // 历史会话在加 tenant_id 列时会先拿到默认值1，必须按会话所有者回填，否则非总部租户升级后会丢失历史。
  db.prepare(`UPDATE marshal_chat_sessions SET tenant_id=COALESCE(
    (SELECT u.tenant_id FROM users u WHERE u.id=marshal_chat_sessions.user_id), tenant_id, 1
  )`).run();
  db.prepare(`UPDATE marshal_chat_msgs SET tenant_id=COALESCE(
    (SELECT s.tenant_id FROM marshal_chat_sessions s WHERE s.id=marshal_chat_msgs.session_id), tenant_id, 1
  )`).run();
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_manager ON users(tenant_id, manager_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_materials_creator ON materials(tenant_id, creator_id)');
  for (const mgr of db.prepare(`SELECT tenant_id, id FROM users
    WHERE role IN ('ops_director','manager') ORDER BY tenant_id, id`).all()) {
    db.prepare(`UPDATE users SET manager_id = ?
      WHERE tenant_id = ? AND manager_id IS NULL AND role IN ('sales','partner')`).run(mgr.id, mgr.tenant_id);
  }

  // 本公司 = 租户1（已开通、全模块）；积分池首次迁移 = 现有各账号积分之和
  const t1 = db.prepare('SELECT id FROM tenants WHERE id = 1').get();
  if (!t1) {
    const pool = db.prepare('SELECT COALESCE(SUM(credits),0) s FROM users').get()?.s || 0;
    db.prepare(`INSERT INTO tenants(id,name,contact_name,status,plan,credits,total_recharged,approved_at)
      VALUES(1,'Nano Work 企业','企业负责人','已开通','旗舰版',?,?,datetime('now','localtime'))`).run(pool, pool);
    db.prepare('UPDATE users SET tenant_id = 1 WHERE tenant_id IS NULL').run();
  }

  // 充值套餐种子（充得多送得多；到账积分 = 价格×100 + 赠送）
  if ((db.prepare('SELECT COUNT(*) n FROM recharge_packages').get()?.n || 0) === 0) {
    const pkgs = [
      ['体验包', 99, 9900, 100, 10000, '体验', 1],
      ['基础包', 599, 59900, 6100, 66000, '超值', 2],
      ['标准包', 1299, 129900, 20100, 150000, '热门', 3],
      ['专业包', 2999, 299900, 60100, 360000, '推荐', 4],
      ['旗舰包', 9999, 999900, 300100, 1300000, '旗舰', 5],
    ];
    const ins = db.prepare('INSERT INTO recharge_packages(name,price_yuan,base_credits,bonus_credits,total_credits,tag,sort) VALUES(?,?,?,?,?,?,?)');
    for (const p of pkgs) ins.run(...p);
  }

  // ===== V7：多租户数据隔离 + 账号配额（FR-SAAS-06）=====
  addCol('tenants', 'seat_limit', 'INTEGER DEFAULT 5');           // 企业账号席位上限
  db.prepare(`UPDATE tenants SET seat_limit = 999 WHERE id = 1`).run(); // 总部不限
  // 业务表统一加 tenant_id（默认1=总部历史数据归属）
  for (const t of ['leads', 'follow_ups', 'lead_ai_suggestions', 'partners', 'partner_actions', 'daily_ops', 'activities',
    'activity_invites', 'contents', 'materials', 'content_templates', 'agent_tasks', 'battle_plans',
    'weekly_reviews', 'approvals', 'kb_docs', 'goals', 'tasks', 'task_submissions', 'biz_assets',
    'employee_point_logs', 'employee_awards', 'asset_flows', 'orders', 'lead_journey', 'ai_conversations', 'ai_messages', 'media_jobs',
    'op_logs', 'notifications', 'specialists']) {
    addCol(t, 'tenant_id', 'INTEGER DEFAULT 1');
  }
  db.prepare(`UPDATE notifications SET tenant_id=COALESCE(
    (SELECT u.tenant_id FROM users u WHERE u.id=notifications.user_id), tenant_id, 1
  )`).run();
  db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(tenant_id,user_id,read,created_at)');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_activity_assignment
    ON tasks(tenant_id, activity_id, activity_plan_item)
    WHERE activity_id IS NOT NULL AND activity_plan_item IS NOT NULL`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_activity ON tasks(tenant_id, activity_id, status)');
  // 重建带全局 UNIQUE 的聚合表为「租户+时间」复合唯一（否则多租户同日/同期冲突串数据）
  const rebuild = (table, cols, uniqCol) => {
    const cur = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table)?.sql || '';
    if (cur.includes(`tenant_id, ${uniqCol}`)) return; // 已重建
    // 旧表此时列序 = 原始列 + 末尾 tenant_id（addCol 所加）；新表列序与之一致，故用 SELECT * 迁移
    db.exec(`
      DROP TABLE IF EXISTS ${table}__new;
      CREATE TABLE ${table}__new (${cols}, tenant_id INTEGER DEFAULT 1, UNIQUE(tenant_id, ${uniqCol}));
      INSERT INTO ${table}__new SELECT * FROM ${table};
      DROP TABLE ${table};
      ALTER TABLE ${table}__new RENAME TO ${table};
    `);
  };
  rebuild('daily_ops', `id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, content_count INTEGER DEFAULT 0, new_leads INTEGER DEFAULT 0, invited INTEGER DEFAULT 0, arrived INTEGER DEFAULT 0, deals INTEGER DEFAULT 0, deal_amount REAL DEFAULT 0, repurchase_amount REAL DEFAULT 0, active_partners INTEGER DEFAULT 0, orders INTEGER DEFAULT 0, marketing_cost REAL DEFAULT 0, week_problem TEXT, next_action TEXT`, 'date');
  rebuild('goals', `id INTEGER PRIMARY KEY AUTOINCREMENT, period TEXT, revenue_target REAL DEFAULT 0, leads_target INTEGER DEFAULT 0, partner_target INTEGER DEFAULT 0, activity_target INTEGER DEFAULT 0`, 'period');
  rebuild('battle_plans', `id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, theme TEXT, audience TEXT, plan TEXT, created_at TEXT DEFAULT (datetime('now','localtime'))`, 'date');
  rebuild('weekly_reviews', `id INTEGER PRIMARY KEY AUTOINCREMENT, week TEXT NOT NULL, report TEXT, created_at TEXT DEFAULT (datetime('now','localtime'))`, 'week');

  // V8：知识库向量列（真向量 RAG 语义检索，FR-KB-RAG）
  addCol('kb_docs', 'embedding', 'TEXT'); // JSON 浮点数组（1536维），空=未向量化（检索时降级）
  // 内容自动沉淀知识库的稳定来源键：旧库增量加列；NULL 来源的历史/手工知识不受唯一约束。
  addCol('kb_docs', 'source_type', 'TEXT');
  addCol('kb_docs', 'source_id', 'INTEGER');
  // 仅回填能唯一、可靠对应的旧内容知识：普通内容要求正文一致；AIPPT 的知识正文是
  // 结构化 deck 摘要，无法与 contents.body 直接相等，因此只在租户内标题两侧均唯一时回填。
  // 有歧义的历史记录继续保留 NULL，避免把手工知识误绑到内容。
  db.exec(`UPDATE kb_docs AS kd
    SET source_type='content',
        source_id=(
          SELECT c.id FROM contents c
          WHERE c.tenant_id=kd.tenant_id
            AND kd.title='[' || c.type || '] ' || COALESCE(NULLIF(c.title,''),c.topic)
            AND (c.type='AIPPT' OR kd.body=c.body)
          ORDER BY c.id LIMIT 1
        )
    WHERE kd.source_type IS NULL
      AND kd.source_id IS NULL
      AND (
        SELECT COUNT(*) FROM contents c
        WHERE c.tenant_id=kd.tenant_id
          AND kd.title='[' || c.type || '] ' || COALESCE(NULLIF(c.title,''),c.topic)
          AND (c.type='AIPPT' OR kd.body=c.body)
      )=1
      AND (
        SELECT COUNT(*) FROM kb_docs kd2
        WHERE kd2.tenant_id=kd.tenant_id
          AND kd2.title=kd.title
          AND kd2.source_type IS NULL
          AND kd2.source_id IS NULL
      )=1
      AND NOT EXISTS (
        SELECT 1 FROM kb_docs linked
        WHERE linked.tenant_id=kd.tenant_id
          AND linked.source_type='content'
          AND linked.source_id=(
            SELECT c.id FROM contents c
            WHERE c.tenant_id=kd.tenant_id
              AND kd.title='[' || c.type || '] ' || COALESCE(NULLIF(c.title,''),c.topic)
              AND (c.type='AIPPT' OR kd.body=c.body)
            ORDER BY c.id LIMIT 1
          )
      )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_docs_tenant_source
    ON kb_docs(tenant_id,source_type,source_id)
    WHERE source_type IS NOT NULL AND source_id IS NOT NULL`);

  // V9：任务分部/提示词租户级覆盖——全局表作基线，企业改的存覆盖表，读取时合并
  db.exec(`
  CREATE TABLE IF NOT EXISTS employee_workbench_configs (
    tenant_id INTEGER NOT NULL,
    employee_idx INTEGER NOT NULL CHECK(employee_idx BETWEEN 101 AND 160),
    prompt_override TEXT,
    work_config_json TEXT NOT NULL DEFAULT '{}',
    skills_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 1,
    updated_by INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    PRIMARY KEY(tenant_id,employee_idx)
  );
  CREATE INDEX IF NOT EXISTS idx_employee_workbench_configs_tenant
    ON employee_workbench_configs(tenant_id,employee_idx);
  CREATE TABLE IF NOT EXISTS content_employee_workbench_configs (
    tenant_id INTEGER NOT NULL,
    employee_idx INTEGER NOT NULL CHECK(employee_idx BETWEEN 0 AND 9),
    prompt_override TEXT,
    work_config_json TEXT NOT NULL DEFAULT '{}',
    skills_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 1,
    updated_by INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    PRIMARY KEY(tenant_id,employee_idx)
  );
  CREATE INDEX IF NOT EXISTS idx_content_employee_workbench_configs_tenant
    ON content_employee_workbench_configs(tenant_id,employee_idx);
  CREATE TABLE IF NOT EXISTS content_employee_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    employee_idx INTEGER NOT NULL CHECK(employee_idx BETWEEN 0 AND 9),
    employee_key TEXT NOT NULL,
    employee_name TEXT NOT NULL,
    employee_group TEXT NOT NULL,
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
    type TEXT NOT NULL,
    requirement TEXT NOT NULL DEFAULT '',
    due_at TEXT,
    status TEXT NOT NULL DEFAULT '生成中'
      CHECK(status IN ('生成中','待审阅','已完成','已驳回','失败')),
    result_md TEXT,
    ai_mode TEXT,
    model TEXT,
    profile_version TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_content_employee_runs_tenant_employee
    ON content_employee_runs(tenant_id,employee_idx,created_at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS idx_content_employee_runs_tenant_status
    ON content_employee_runs(tenant_id,status,created_at DESC,id DESC);
  CREATE TABLE IF NOT EXISTS content_automation_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    employee_idx INTEGER NOT NULL CHECK(employee_idx BETWEEN 0 AND 9),
    topic TEXT NOT NULL CHECK(length(topic) BETWEEN 1 AND 100),
    requirement TEXT NOT NULL DEFAULT '' CHECK(length(requirement) <= 2000),
    content_type TEXT NOT NULL,
    content_count INTEGER NOT NULL DEFAULT 3 CHECK(content_count BETWEEN 1 AND 10),
    frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly')),
    run_time TEXT NOT NULL CHECK(
      run_time GLOB '[0-2][0-9]:[0-5][0-9]'
      AND CAST(substr(run_time,1,2) AS INTEGER) BETWEEN 0 AND 23
    ),
    weekday INTEGER CHECK(weekday BETWEEN 1 AND 7),
    approval_mode TEXT NOT NULL DEFAULT 'always' CHECK(approval_mode IN ('risk','always')),
    next_run_at TEXT,
    last_run_at TEXT,
    last_status TEXT,
    last_error TEXT,
    last_content_id INTEGER,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS content_automation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    rule_id INTEGER NOT NULL,
    trigger TEXT NOT NULL CHECK(trigger IN ('scheduled','immediate')),
    claim_key TEXT NOT NULL,
    scheduled_for TEXT,
    status TEXT NOT NULL DEFAULT '运行中' CHECK(status IN ('运行中','成功','失败')),
    content_id INTEGER,
    initiated_by INTEGER,
    profile_version TEXT,
    prompt_hash TEXT,
    snapshot_json TEXT,
    error TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    finished_at TEXT,
    UNIQUE(tenant_id,rule_id,trigger,claim_key)
  );
  CREATE INDEX IF NOT EXISTS idx_content_automation_rules_due
    ON content_automation_rules(tenant_id,enabled,next_run_at,id);
  CREATE INDEX IF NOT EXISTS idx_content_automation_runs_rule
    ON content_automation_runs(tenant_id,rule_id,id DESC);
  CREATE TABLE IF NOT EXISTS tenant_marshal_overrides (
    tenant_id INTEGER, marshal_code TEXT,
    name TEXT, title TEXT, duty TEXT, skills TEXT, prompt TEXT, kb_deps TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY(tenant_id, marshal_code)
  );
  CREATE TABLE IF NOT EXISTS tenant_specialist_overrides (
    tenant_id INTEGER NOT NULL,
    specialist_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    duty TEXT,
    active INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY(tenant_id, specialist_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_specialist_marshal
    ON tenant_specialist_overrides(tenant_id, specialist_id);
  CREATE TABLE IF NOT EXISTS tenant_prompt_overrides (
    tenant_id INTEGER, code TEXT, role_card TEXT, output_rule TEXT, style TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY(tenant_id, code)
  );
  CREATE TABLE IF NOT EXISTS deleted_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    module TEXT,
    title TEXT,
    summary TEXT,
    required_role TEXT,
    reason TEXT,
    snapshot TEXT NOT NULL,
    child_snapshot TEXT DEFAULT '{}',
    deleted_by INTEGER,
    deleted_by_name TEXT,
    deleted_by_role TEXT,
    restored_by INTEGER,
    restored_by_name TEXT,
    restored_at TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    tenant_id INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_deleted_records_tenant ON deleted_records(tenant_id, restored_at, created_at);
  CREATE TABLE IF NOT EXISTS uploaded_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    ext TEXT,
    mime TEXT,
    size INTEGER DEFAULT 0,
    purpose TEXT DEFAULT 'chat',
    file_path TEXT,
    file_url TEXT,
    extracted_text TEXT,
    extract_mode TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    tenant_id INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_uploaded_files_owner ON uploaded_files(tenant_id,user_id,created_at);
  CREATE TABLE IF NOT EXISTS generated_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    source_type TEXT,
    source_id INTEGER,
    title TEXT NOT NULL,
    format TEXT NOT NULL,
    content TEXT,
    file_url TEXT,
    file_name TEXT,
    status TEXT DEFAULT '可用',
    kb_doc_id INTEGER,
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    tenant_id INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_generated_artifacts_owner ON generated_artifacts(tenant_id,user_id,created_at);
  CREATE TABLE IF NOT EXISTS conversation_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    scope TEXT NOT NULL,
    session_id INTEGER,
    title TEXT,
    content TEXT NOT NULL,
    tags TEXT,
    pinned INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    tenant_id INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_conversation_memories_scope ON conversation_memories(tenant_id,user_id,scope,session_id);
  CREATE TABLE IF NOT EXISTS dashboard_widget_preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    widgets TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    tenant_id INTEGER DEFAULT 1,
    UNIQUE(tenant_id,user_id)
  );
  CREATE TABLE IF NOT EXISTS activity_plan_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    activity_id INTEGER,
    title TEXT NOT NULL,
    type TEXT,
    date TEXT,
    goal TEXT,
    audience TEXT,
    budget TEXT,
    target_join INTEGER DEFAULT 12,
    plan TEXT NOT NULL,
    status TEXT DEFAULT '草稿',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    tenant_id INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_activity_plan_drafts_owner ON activity_plan_drafts(tenant_id,user_id,updated_at);
  CREATE TABLE IF NOT EXISTS custom_agent_chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    title TEXT,
    memory TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    tenant_id INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS custom_agent_chat_msgs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    attachments_json TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    tenant_id INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_custom_agent_sessions_owner ON custom_agent_chat_sessions(tenant_id,user_id,agent_id,updated_at);
  CREATE TABLE IF NOT EXISTS data_import_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    file_id INTEGER,
    target_table TEXT,
    mapping TEXT,
    total_rows INTEGER DEFAULT 0,
    imported_rows INTEGER DEFAULT 0,
    skipped_rows INTEGER DEFAULT 0,
    error_rows TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    tenant_id INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_data_import_jobs_owner ON data_import_jobs(tenant_id,user_id,created_at);
  CREATE TABLE IF NOT EXISTS data_import_commits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    response TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    tenant_id INTEGER DEFAULT 1,
    UNIQUE(tenant_id,user_id,idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS data_import_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    target_table TEXT NOT NULL,
    record_id INTEGER NOT NULL,
    source_row INTEGER,
    sheet_name TEXT,
    import_action TEXT NOT NULL,
    original_snapshot TEXT,
    current_snapshot TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    last_operator_id INTEGER,
    last_operator_name TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    tenant_id INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_data_import_items_job ON data_import_items(tenant_id,job_id,id);
  CREATE INDEX IF NOT EXISTS idx_data_import_items_record ON data_import_items(tenant_id,target_table,record_id,status);
  CREATE TABLE IF NOT EXISTS scheduled_runs (
    tenant_id INTEGER NOT NULL,
    job_key TEXT NOT NULL,
    ran_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY(tenant_id,job_key)
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_runs_time ON scheduled_runs(tenant_id,ran_at);
  CREATE TABLE IF NOT EXISTS tool_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    tool_key TEXT NOT NULL CHECK(tool_key IN ('hot','remix','pcal','bench','warm','leads','shot','vars')),
    tool_title TEXT NOT NULL,
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
    status TEXT NOT NULL DEFAULT 'done' CHECK(status IN ('running','done','failed')),
    employee_idx INTEGER NOT NULL,
    employee_name TEXT NOT NULL,
    specialist_id INTEGER,
    created_by INTEGER NOT NULL,
    input_json TEXT NOT NULL,
    input_summary TEXT NOT NULL,
    result_md TEXT NOT NULL,
    assumptions_json TEXT NOT NULL DEFAULT '[]',
    evidence_json TEXT NOT NULL DEFAULT '[]',
    provenance_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(specialist_id) REFERENCES specialists(id),
    FOREIGN KEY(created_by) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_tool_runs_tenant_created ON tool_runs(tenant_id,created_at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS idx_tool_runs_tenant_employee ON tool_runs(tenant_id,employee_idx,created_at DESC);
  CREATE TABLE IF NOT EXISTS tool_run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    run_id INTEGER NOT NULL,
    event_type TEXT NOT NULL DEFAULT 'generated' CHECK(event_type IN ('generated')),
    tool_key TEXT NOT NULL CHECK(tool_key IN ('hot','remix','pcal','bench','warm','leads','shot','vars')),
    employee_idx INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('done','failed')),
    source_system TEXT NOT NULL DEFAULT 'nanowork' CHECK(source_system='nanowork'),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(run_id) REFERENCES tool_runs(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_tool_run_events_tenant_time ON tool_run_events(tenant_id,occurred_at DESC,id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_run_events_generated_once
    ON tool_run_events(tenant_id,run_id,event_type);
  `);
  addCol('tenant_marshal_overrides', 'online', 'INTEGER');
  addCol('tenant_marshal_overrides', 'synced_at', 'TEXT');
  addCol('data_import_commits', 'request_hash', 'TEXT');
  addCol('activity_plan_drafts', 'target_join', 'INTEGER DEFAULT 12');

  // 餐饮数字员工由 restaurant.json 的 101-160 权威目录统一维护。
  // 分部级租户覆盖只改变内部任务分部，不再自动生成任何员工覆盖；因此重复迁移/重启也是幂等安全的。

  // 内容生产仓的业务值继续兼容历史 API；基础提示词必须保持行业中立且不带任何旧项目品牌。
  const promptSeeds = [
    ['GEN-IMG', 'AI图片通用提示词', '你是餐饮品牌的商业视觉导演，服务菜品、门店、活动和员工内容场景。', '输出主体、场景、光线、构图、材质、镜头与负向约束；品牌、价格和食品功效信息必须以企业资料为准。', '真实、克制、可落地；不生成错误文字，不伪造顾客评价或经营成效。'],
    ['GEN-VIDEO', 'AI视频通用提示词', '你是餐饮品牌的视频导演，负责把菜品、门店、人物和活动转成可执行镜头。', '明确镜头顺序、运动、时长、主体动作、字幕建议与首尾帧；缺少事实输入时标记待确认。', '叙事清楚、适合真实拍摄；不虚构食品功效、价格优惠、顾客评价或经营成效。'],
    ['GEN-PPT', 'AIPPT结构化提示词', '你是餐饮经营演示文稿策划师，负责把经营数据、活动方案和复盘内容整理为可演示结构。', '只输出结构化JSON；每页3-5条要点，每条不超过24字；备注使用自然、清楚的提词。', '结论基于已提供的数据；缺失信息标为待确认，不编造金额、收益或监管结论。'],
    ['CON-COPY-SHORT-VIDEO', 'AI文案-短视频脚本', '你是餐饮短视频脚本策划，目标是用真实菜品、门店服务和人物故事建立顾客兴趣。', '每条脚本包含开场、画面/口播、顾客场景、事实依据、行动引导与人工复核项；不得承诺功效、最低价或虚构热销。', '短句、强场景、可拍摄；优先真实门店、菜品制作、员工协作和顾客已授权素材。'],
    ['CON-COPY-MOMENTS', 'AI文案-朋友圈文案', '你是餐饮门店的朋友圈经营文案员工，负责把可核验的菜品、服务和活动信息写得自然。', '输出种草、门店日常、活动预告和会员提醒等版本；每条有开头、正文和低压力行动引导。', '自然、有烟火气；价格、库存、顾客评价和活动权益必须由负责人确认。'],
    ['CON-COPY-COMMUNITY', 'AI文案-社群话题', '你是餐饮门店的社群运营员工，负责用轻话题促进真实互动，再承接人工服务。', '每条包含发群开场、互动问题、管理员追问和人工承接语；不得群内压单或制造虚假稀缺。', '轻、短、可互动；发布时间、菜品供应和活动权益均标记为待门店确认。'],
    ['CON-COPY-INVITE', 'AI文案-私聊邀约话术', '你是餐饮门店的顾客沟通辅助员工，负责把已授权顾客推进到到店、预订、活动或复购。', '按顾客场景输出开场、联系理由、低压力邀约和二次跟进；尊重退订与隐私边界。', '像真人沟通，不像强推模板；价格、座位、菜品供应和活动名额必须实时确认。'],
    ['CON-COPY-OFFER', 'AI文案-权益沟通话术', '你是餐饮门店的权益表达与风控员工，负责把已确认的会员或活动权益讲清楚。', '只表达已提供的适用对象、条件、有效期和确认方式；不得杜撰价格、优惠、限量、返利或保证名额。', '清楚、克制、可核验；所有权益以企业当前有效规则为准。'],
    ['CON-COPY-INVESTMENT', 'AI文案-合作推广文案', '你是餐饮企业的合作推广内容员工，负责说明合作场景、资源边界和沟通路径。', '合作身份、政策、投入和收益数字只能引用企业已提供资料；缺失项必须标记待确认，并提示人工审核。', '稳重、可信、合规；先说明适配条件与流程，不承诺收益。'],
    ['CON-COPY-REPURCHASE', 'AI文案-会员复购文案', '你是餐饮门店的会员复购内容员工，负责基于已授权顾客标签和真实消费场景设计沟通。', '输出私信、朋友圈、方案标题和触达清单；不得伪造消费记录、偏好、评价或优惠。', '体面、有人情味、尊重退订；菜品供应、价格与活动信息需门店确认。'],
    ['CON-COPY-PARTNER-PACK', 'AI文案-员工每日素材包', '你是餐饮门店的内容训练与每日素材包员工，负责提供可学习、可发布、可检查的任务包。', '包含学习卡、朋友圈素材、短视频脚本、今日顾客服务动作与复盘项；每项注明输入依据和检查标准。', '动作清楚、简单可执行；外发前由负责人审核，不自动发布。'],
  ];
  const insertPrompt = db.prepare(`INSERT INTO prompts(code,name,role_card,output_rule,style)
    VALUES(?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET
      name=excluded.name,role_card=excluded.role_card,output_rule=excluded.output_rule,style=excluded.style`);
  for (const p of promptSeeds) insertPrompt.run(...p);

  // ===== BE-M2 高频查询复合索引：tenant_id 打头，隔离过滤 + 业务条件一次命中 =====
  // （tenant_id 列由上方 V6/V7 addCol 迁移补齐，故必须建在 migrateV2 末尾而非 initSchema）
  db.exec(`
  CREATE TABLE IF NOT EXISTS content_material_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    target_type TEXT NOT NULL CHECK(target_type IN ('content','media_job')),
    target_id INTEGER NOT NULL,
    material_id INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(tenant_id,target_type,target_id,material_id)
  );
  CREATE INDEX IF NOT EXISTS idx_content_material_refs_target
    ON content_material_refs(tenant_id,target_type,target_id,id);
  CREATE INDEX IF NOT EXISTS idx_content_material_refs_material
    ON content_material_refs(tenant_id,material_id,id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contents_source_once
    ON contents(tenant_id,source_type,source_id)
    WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_specialists_employee_idx
    ON specialists(employee_idx) WHERE employee_idx IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_specialists_key
    ON specialists(key) WHERE key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_specialists_group_sort ON specialists(group_name,sort);
  CREATE INDEX IF NOT EXISTS idx_leads_tenant_stage ON leads(tenant_id, stage);
  CREATE INDEX IF NOT EXISTS idx_contents_tenant_created ON contents(tenant_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_contents_content_employee
    ON contents(tenant_id,content_employee_idx,created_at);
  CREATE INDEX IF NOT EXISTS idx_content_publish_logs_content
    ON content_publish_logs(tenant_id,content_id,created_at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS idx_content_automation_rules_due
    ON content_automation_rules(tenant_id,enabled,next_run_at,id);
  CREATE INDEX IF NOT EXISTS idx_content_automation_runs_rule
    ON content_automation_runs(tenant_id,rule_id,id DESC);
  CREATE INDEX IF NOT EXISTS idx_media_jobs_content_employee
    ON media_jobs(tenant_id,content_employee_idx,created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_tasks_tenant ON agent_tasks(tenant_id, marshal_id);
  CREATE INDEX IF NOT EXISTS idx_credit_logs_tenant_created ON credit_logs(tenant_id, created_at);
  CREATE TRIGGER IF NOT EXISTS trg_material_body_snapshot_immutable
    BEFORE UPDATE OF body_snapshot ON materials
    WHEN COALESCE(OLD.body_snapshot,'') <> ''
      AND COALESCE(NEW.body_snapshot,'') <> OLD.body_snapshot
    BEGIN
      SELECT RAISE(ABORT,'material body snapshot is immutable');
    END;
  CREATE TRIGGER IF NOT EXISTS trg_material_artifact_snapshot_immutable
    BEFORE UPDATE OF artifact_snapshot_json ON materials
    WHEN COALESCE(OLD.artifact_snapshot_json,'') <> ''
      AND COALESCE(NEW.artifact_snapshot_json,'') <> OLD.artifact_snapshot_json
    BEGIN
      SELECT RAISE(ABORT,'material artifact snapshot is immutable');
    END;
  CREATE TRIGGER IF NOT EXISTS trg_material_snapshot_hash_immutable
    BEFORE UPDATE OF snapshot_hash ON materials
    WHEN COALESCE(OLD.snapshot_hash,'') <> ''
      AND COALESCE(NEW.snapshot_hash,'') <> OLD.snapshot_hash
    BEGIN
      SELECT RAISE(ABORT,'material snapshot hash is immutable');
    END;
  `);
}

// 内部任务分部：全局基线 + 当前租户覆盖合并
export function mergeMarshal(base) {
  if (!base) return base;
  const ov = db.prepare('SELECT * FROM tenant_marshal_overrides WHERE tenant_id=? AND marshal_code=?').get(curTenant(), base.code);
  if (ov) for (const k of ['name', 'title', 'duty', 'skills', 'prompt', 'kb_deps', 'online', 'synced_at']) if (ov[k] != null && ov[k] !== '') base[k] = ov[k];
  return base;
}
export function mergeMarshals(rows) { return rows.map(mergeMarshal); }
export function mergeSpecialist(base) {
  if (!base) return base;
  const ov = db.prepare('SELECT name,duty,active FROM tenant_specialist_overrides WHERE tenant_id=? AND specialist_id=?').get(curTenant(), base.id);
  if (!ov) return base;
  return {
    ...base,
    name: ov.name || base.name,
    duty: ov.duty || base.duty,
    active: ov.active == null ? 1 : ov.active,
  };
}
export function mergeSpecialists(rows) { return rows.map(mergeSpecialist).filter(item => item.active !== 0); }
export function specialistsForMarshal(marshalId) {
  return mergeSpecialists(db.prepare('SELECT id,marshal_id,name,duty,status,last_output_id FROM specialists WHERE marshal_id=? ORDER BY id').all(marshalId));
}
// 提示词：当前租户覆盖（无则 null，调用方回退全局）
export function promptOverride(code) {
  return db.prepare('SELECT role_card, output_rule, style FROM tenant_prompt_overrides WHERE tenant_id=? AND code=?').get(curTenant(), code) || null;
}

// 解析用户可见模块：用户级覆盖 > （角色默认 ∪ 员工部门追加），再 ∩ 租户开通模块
export function modulesFor(user) {
  const row = db.prepare('SELECT modules, dept, role, tenant_id FROM users WHERE id = ?').get(user.id);
  const role = row?.role || user.role;
  const tid = row?.tenant_id ?? user.tenant_id ?? 1;   // 用用户真实租户读权限（登录态 curTenant 尚未就绪，不能用它）
  const matrix = getTenantConfig('role_modules', {}, tid);
  let mods;
  if (row?.modules) { try { mods = JSON.parse(row.modules); } catch { /* fallthrough */ } }
  if (!mods) {
    const base = matrix[role] || ['dashboard'];
    if (role === 'sales') {
      const deptMap = getTenantConfig('dept_modules', {}, tid);
      const extra = deptMap[row?.dept || user.dept] || [];
      mods = [...new Set([...base, ...extra])];
    } else mods = base;
  }
  // 平台超管不受租户模块限制（跨租户运维）
  if (role === 'platform_super') return mods;
  // 租户开通模块作为上限（NULL=全部开通；本公司租户1不限制）
  const t = db.prepare('SELECT modules FROM tenants WHERE id = ?').get(tid);
  if (t?.modules) { try { const allow = JSON.parse(t.modules); mods = mods.filter(m => allow.includes(m)); } catch { /* keep */ } }
  return mods;
}

// 租户辅助：按用户/租户读取，供计费池与鉴权使用
export function tenantOf(userId) {
  return db.prepare('SELECT tenant_id FROM users WHERE id = ?').get(userId)?.tenant_id ?? null;
}
export function getTenant(tenantId) {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
}

export function getConfig(key, dflt) {
  const row = q.get('SELECT value FROM sys_config WHERE key = ?', key);
  if (!row) return dflt;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
export function setConfig(key, value) {
  q.run('INSERT INTO sys_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
}

// ===== 租户级配置（覆盖层）：每家企业可自定义经营系数，未设则回退平台默认（seed 写的全局值）=====
// 存储为 `key:租户id`；读取顺序：本租户覆盖 → 平台默认(全局 key) → dflt。tid 可显式传入（登录态 curTenant 尚未就绪时用用户真实租户）。
export function getTenantConfig(key, dflt, tid = curTenant()) {
  const own = q.get('SELECT value FROM sys_config WHERE key = ?', `${key}:${tid}`);
  if (own) { try { return JSON.parse(own.value); } catch { return own.value; } }
  return getConfig(key, dflt);
}
export function setTenantConfig(key, value, tid = curTenant()) {
  setConfig(`${key}:${tid}`, value);
}
