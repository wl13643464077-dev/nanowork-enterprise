import "./env.js";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { createPrivateArtifact, assertPrivateArtifact } from "./engines/private-artifact.js";
import { prepareDatabaseStorage } from "./engines/database-storage.js";

// 本项目运行数据默认只允许当前用户访问。umask 会保护随后由 SQLite
// 创建的数据库、WAL/SHM 以及运行期文件；不会修改 /tmp 或自定义路径的父目录权限。
process.umask(0o077);

const safeJsonParse = (value, fallback = null) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
// 默认使用新项目独立数据库；测试或独立部署只能通过 NANOWORK_DB 显式指定。
export const DB_PATH =
  process.env.NANOWORK_DB || path.join(DATA_DIR, "nanowork-industry.db");

prepareDatabaseStorage({ databasePath: DB_PATH, dataDirectory: DATA_DIR,
  protectDataDirectory: process.env.NODE_ENV !== "test" });
export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
// 面向百人级并发的写竞争加固：
// - busy_timeout：并发写事务冲突时等待重试，而不是直接抛 SQLITE_BUSY 把
//   业务请求打失败（长 AI 任务落库与 HTTP 写并发是常态）。
// - synchronous=NORMAL：WAL 模式官方推荐档位；断电最多回退最后一个
//   checkpoint 之后的事务，不会损坏数据库，写吞吐显著提升。
// - cache_size 负值单位为 KiB：加大页缓存，降低热点查询 IO。
db.exec("PRAGMA busy_timeout = 8000;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA cache_size = -32000;");

export function backupDatabase(destination) {
  const output = path.resolve(destination);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (fs.existsSync(output)) throw new Error("备份文件已存在，请重新发起备份");
  // VACUUM INTO accepts an existing empty file. Establish exclusive ownership
  // and native permissions before any database bytes are written.
  createPrivateArtifact(output);
  const escaped = output.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  const backup = new DatabaseSync(output, { readOnly: true });
  try {
    const integrity = Object.values(
      backup.prepare("PRAGMA integrity_check").get() || {},
    )[0];
    if (integrity !== "ok")
      throw new Error(`备份完整性校验失败：${integrity || "unknown"}`);
  } finally {
    backup.close();
  }
  fs.chmodSync(output, 0o600);
  assertPrivateArtifact(output);
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
    onboarding_version INTEGER NOT NULL DEFAULT 0,
    onboarding_role TEXT,
    onboarding_completed_at TEXT,
    onboarding_outcome TEXT CHECK(onboarding_outcome IS NULL OR onboarding_outcome IN ('completed','dismissed')),
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
    concerns TEXT DEFAULT '[]',    -- JSON [{text,resolved,suggestionId,createdAt}]，话术正文存 lead_ai_suggestions
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
  -- 合规半自动分发（B6）：排期到期提醒与 T+1/3/7 催复盘的幂等台账。
  -- kind='schedule_due' 时 day=0；kind='followup' 时 day∈{1,3,7}。不做任何自动发布。
  CREATE TABLE IF NOT EXISTS content_publish_followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    content_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('schedule_due','followup')),
    day INTEGER NOT NULL DEFAULT 0 CHECK(day IN (0,1,3,7)),
    publish_log_id INTEGER,
    notified_user_ids TEXT NOT NULL DEFAULT '[]',
    notified_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(tenant_id,content_id,kind,day)
  );
  CREATE INDEX IF NOT EXISTS idx_content_publish_followups_content
    ON content_publish_followups(tenant_id,content_id,kind,day);
  -- 发布后人工回填的平台数据（浏览/点赞/收藏/评论/订单 + 可选截图）；平台未核验。
  CREATE TABLE IF NOT EXISTS content_publish_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    content_id INTEGER NOT NULL,
    publish_log_id INTEGER,
    channel TEXT,
    views INTEGER CHECK(views IS NULL OR views >= 0),
    likes INTEGER CHECK(likes IS NULL OR likes >= 0),
    saves INTEGER CHECK(saves IS NULL OR saves >= 0),
    comments INTEGER CHECK(comments IS NULL OR comments >= 0),
    orders INTEGER CHECK(orders IS NULL OR orders >= 0),
    screenshot_file_id INTEGER,
    note TEXT NOT NULL DEFAULT '',
    verification TEXT NOT NULL DEFAULT 'manual_unverified',
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_content_publish_metrics_content
    ON content_publish_metrics(tenant_id,content_id,created_at DESC,id DESC);
  CREATE TABLE IF NOT EXISTS content_automation_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    employee_idx INTEGER NOT NULL CHECK(employee_idx BETWEEN 0 AND 9),
    topic TEXT NOT NULL CHECK(length(topic) BETWEEN 1 AND 100),
    requirement TEXT NOT NULL DEFAULT '' CHECK(length(requirement) <= 2000),
    brief_json TEXT NOT NULL DEFAULT '{}',
    content_type TEXT NOT NULL,
    content_count INTEGER NOT NULL DEFAULT 3 CHECK(content_count BETWEEN 1 AND 10),
    frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly')),
    run_time TEXT NOT NULL CHECK(
      run_time GLOB '[0-2][0-9]:[0-5][0-9]'
      AND CAST(substr(run_time,1,2) AS INTEGER) BETWEEN 0 AND 23
    ),
    weekday INTEGER CHECK(weekday BETWEEN 1 AND 7),
    approval_mode TEXT NOT NULL DEFAULT 'auto' CHECK(approval_mode IN ('auto','risk','always')),
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
    employee_canonical_snapshot TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS agent_task_supersessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    superseded_task_id INTEGER NOT NULL,
    replacement_task_id INTEGER NOT NULL,
    superseded_output_id INTEGER NOT NULL,
    replacement_output_id INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    reason TEXT NOT NULL,
    validation_snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    CHECK(superseded_task_id <> replacement_task_id),
    CHECK(superseded_output_id <> replacement_output_id),
    UNIQUE(tenant_id,superseded_task_id)
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
  CREATE TABLE IF NOT EXISTS kb_embedding_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    doc_id INTEGER NOT NULL,
    hold_id INTEGER,
    status TEXT NOT NULL DEFAULT 'preparing',
    planned_calls INTEGER NOT NULL,
    credits_per_call INTEGER NOT NULL,
    attempted_calls INTEGER NOT NULL DEFAULT 0,
    persisted_calls INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_kb_embedding_jobs_recovery
    ON kb_embedding_jobs(tenant_id,status,created_at);
  CREATE TABLE IF NOT EXISTS kb_health_events (
    -- 知识库健康事件（P0-2）：查询向量化失败 / 检索命中零向量文档 / 回填需求与回填结果
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('query_embed_failed','zero_vector_doc','backfill_needed','backfill_run')),
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_kb_health_events_tenant_kind
    ON kb_health_events(tenant_id,kind,created_at);
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
    assigned_by INTEGER,
    parent_task_id INTEGER,
    source_ref_type TEXT,
    source_ref_id INTEGER,
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
    source_ref_type TEXT,
    source_ref_id INTEGER,
    reviewer_id INTEGER,
    reviewed_at TEXT,
    review_reason TEXT,
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
    user_id INTEGER, type TEXT, title TEXT, body TEXT, link TEXT,
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
    region TEXT, channel TEXT, store_id INTEGER,
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
  CREATE TABLE IF NOT EXISTS order_item_commits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    order_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(tenant_id,order_id,idempotency_key)
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
  CREATE INDEX IF NOT EXISTS idx_order_item_commits_order ON order_item_commits(tenant_id, order_id);
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
export const curTenant = () => _tctx.getStore() ?? 1; // 当前请求租户（无上下文=总部1）
export const runWithTenant = (tid, fn) => _tctx.run(Number(tid) || 1, fn);

// 需按租户隔离的业务表（系统级表如 marshals/prompts/recharge_packages/users/tenants 不在内）
const ISOLATED = new Set([
  "leads",
  "follow_ups",
  "lead_ai_suggestions",
  "partners",
  "partner_actions",
  "daily_ops",
  "activities",
  "activity_invites",
  "contents",
  "materials",
  "content_templates",
  "agent_tasks",
  "agent_task_supersessions",
  "battle_plans",
  "weekly_reviews",
  "approvals",
  "kb_docs",
  "goals",
  "tasks",
  "task_submissions",
  "employee_point_logs",
  "employee_awards",
  "biz_assets",
  "asset_flows",
  "orders",
  "lead_journey",
  "ai_conversations",
  "ai_messages",
  "marshal_chat_sessions",
  "marshal_chat_msgs",
  "media_jobs",
  "op_logs",
  "custom_agents",
  "uploaded_files",
  "generated_artifacts",
  "conversation_memories",
  "dashboard_widget_preferences",
  "activity_plan_drafts",
  "custom_agent_chat_sessions",
  "custom_agent_chat_msgs",
  "data_import_jobs",
  "data_import_commits",
  "data_import_items",
  "deleted_records",
  "scheduled_runs",
  "notifications",
  "tool_runs",
  "tool_run_events",
  "tool_run_feishu_exports",
  "tool_run_pcal_edits",
  "toolbox_automation_configs",
  "toolbox_automation_runs",
  "avatar_jobs",
  "avatar_voices",
  "text_video_jobs",
  "wechat_draft_deliveries",
  "employee_workbench_configs",
  "content_employee_workbench_configs",
  "content_employee_runs",
  "content_connector_runs",
  "content_automation_rules",
  "content_automation_runs",
  "content_pipeline_schedules",
  "content_pipeline_schedule_runs",
  "content_production_pipeline_idempotency",
  "content_publish_logs",
  "content_publish_followups",
  "content_publish_metrics",
  "content_material_refs",
  "kb_embedding_jobs",
  "stores",
  "dishes",
  "order_items",
  "order_item_commits",
  "costs",
  // 门店日常 & 评价中心（各 INSERT 均已显式写 tenant_id，登记只为激活读写兜底防线）
  "store_checklist_marks",
  "dish_soldout_marks",
  "shift_assignments",
  "attendance_records",
  "store_reviews",
  "inventory_items",
  "inventory_moves",
  "delivery_daily",
  "store_daily_ops",
  // 数字员工自动进化
  "employee_evolution_notes",
  "employee_evolution_proposals",
  // 拆解师爆款结构卡（engines/content-benchmark-cards.js 懒建表；INSERT 显式带 tenant_id，登记为读写兜底）
  "content_benchmark_cards",
  // 注：specialists（数字员工）与 marshals（内部任务分部）一样是全局基础数据，全租户共享同一份编制，
  // 不在隔离集——读取本就应跨租户取全量；如误列入会导致非总部企业看到 0 个专员。
]);
function matchParen(s, open) {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") d++;
    else if (s[i] === ")") {
      d--;
      if (d === 0) return i;
    }
  }
  return -1;
}
// 给隔离表的 INSERT 自动注入 tenant_id 列与值（写入侧零散漏防护）。
// 兜底（BE-C2）：INSERT..SELECT / 无列名清单 / 畸形语句无法注入时直接抛错，
// 绝不静默落 DEFAULT 1（总部租户）——显式写 tenant_id 列可放行，平台级操作请用 qRaw.run。
function injectTenantInsert(sql, tid) {
  const head = sql.match(
    /^\s*INSERT(?:\s+OR\s+\w+)?\s+INTO\s+([a-z_][a-z0-9_]*)/i,
  );
  if (!head || !ISOLATED.has(head[1].toLowerCase())) return sql;
  const reject = (why) => {
    throw new Error(
      `隔离表 ${head[1]} 的 INSERT 无法自动注入 tenant_id（${why}）：` +
        `请显式指定 tenant_id 列，平台级跨租户写入请改用 qRaw.run。SQL：${sql.trim().slice(0, 120)}`,
    );
  };
  let colOpen = head[0].length;
  while (colOpen < sql.length && /\s/.test(sql[colOpen])) colOpen++;
  if (sql[colOpen] !== "(")
    return reject("缺少列名清单，如 INSERT..SELECT/裸 VALUES");
  const colClose = matchParen(sql, colOpen);
  if (colClose < 0) return reject("列名清单括号不闭合");
  if (/\btenant_id\b/i.test(sql.slice(colOpen, colClose))) return sql; // 已显式指定
  const vIdx = sql.toUpperCase().indexOf("VALUES", colClose);
  if (vIdx < 0) return reject("无 VALUES 子句，如 INSERT..SELECT");
  let pos = vIdx + "VALUES".length,
    cursor = 0,
    out = "",
    patched = 0;
  while (pos < sql.length) {
    while (/\s/.test(sql[pos])) pos++;
    if (sql[pos] !== "(") break;
    const valClose = matchParen(sql, pos);
    if (valClose < 0) return reject("VALUES 值组括号不闭合");
    out += sql.slice(cursor, valClose) + `,${tid}`;
    cursor = valClose;
    patched++;
    pos = valClose + 1;
    while (/\s/.test(sql[pos])) pos++;
    if (sql[pos] !== ",") break;
    pos++;
  }
  if (!patched) return reject("未找到可注入的 VALUES 值组");
  out += sql.slice(cursor);
  out = out.slice(0, colClose) + ",tenant_id" + out.slice(colClose);
  return out;
}

// ===== BE-C2 读侧作用域强制：隔离表读查询的安全入口 =====
// 自动以参数占位追加 tenant_id 过滤（首个绑定参数即当前租户），开发者忘写 WHERE tenant_id 也不会跨租户泄露。
// tail 只允许为空或以 AND / ORDER BY / GROUP BY / LIMIT 开头；条件顶层禁止裸 OR
// （防 `tenant_id=? AND a OR b` 优先级击穿隔离，需要 OR 请自行加括号）。
function scopedSelect(table, tail = "", cols = "*") {
  if (!ISOLATED.has(table))
    throw new Error(
      `scoped 查询仅限隔离表：${table} 不在隔离集（全局表请直接用 q.all/q.get）`,
    );
  const t = String(tail || "").trim();
  if (t && !/^(AND|ORDER\s+BY|GROUP\s+BY|LIMIT)\b/i.test(t)) {
    throw new Error(
      `scoped 查询附加片段须以 AND/ORDER BY/GROUP BY/LIMIT 开头：${t.slice(0, 60)}`,
    );
  }
  for (let i = 0, depth = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "'") {
      i = t.indexOf("'", i + 1);
      if (i < 0) break;
      continue;
    } // 跳过字符串字面量
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (
      depth === 0 &&
      /^or\b/i.test(t.slice(i)) &&
      (i === 0 || /[\s)]/.test(t[i - 1]))
    ) {
      throw new Error(
        `scoped 查询顶层禁止裸 OR（会击穿 tenant_id 过滤），请加括号：${t.slice(0, 60)}`,
      );
    }
  }
  return `SELECT ${cols} FROM ${table} WHERE tenant_id = ?${t ? ` ${t}` : ""}`;
}

// ===== 写入观察钩子（事件总线用）=====
// q.run 是业务写入的唯一常规入口；观察者只拿到 (sql, result, tenantId) 做刷新信号派生，
// 不改写 SQL、不参与事务。观察者异常绝不反噬业务写入。无观察者时零开销。
const writeObservers = new Set();
export function onWrite(observer) {
  writeObservers.add(observer);
  return () => writeObservers.delete(observer);
}
function runObserved(sql, p) {
  const result = db.prepare(injectTenantInsert(sql, curTenant())).run(...p);
  if (writeObservers.size && result?.changes) {
    const tid = curTenant();
    for (const observer of writeObservers) {
      try {
        observer(sql, result, tid);
      } catch (error) {
        console.error("[db] 写入观察者异常:", error?.message || error);
      }
    }
  }
  return result;
}

export const q = {
  all: (sql, ...p) => db.prepare(sql).all(...p),
  get: (sql, ...p) => db.prepare(sql).get(...p),
  run: (sql, ...p) => runObserved(sql, p),
  // 读侧作用域包装（BE-C2）：q.scopedAll('leads', 'AND stage = ? ORDER BY created_at DESC', stage)
  scopedAll: (table, tail = "", ...p) =>
    db.prepare(scopedSelect(table, tail)).all(curTenant(), ...p),
  scopedGet: (table, tail = "", ...p) =>
    db.prepare(scopedSelect(table, tail)).get(curTenant(), ...p),
  scopedCount: (table, tail = "", ...p) =>
    db.prepare(scopedSelect(table, tail, "COUNT(*) n")).get(curTenant(), ...p)
      ?.n || 0,
};
// 跨租户写入（平台超管/迁移用）：绕过自动注入，显式指定 tenant_id
export const qRaw = { run: (sql, ...p) => db.prepare(sql).run(...p) };

// ===== V2 增量迁移：积分体系 / 菜单级权限 / 数字员工提示词 / 媒体生成任务 =====
export function migrateV2() {
  const addCol = (table, col, def) => {
    if (
      !/^[a-z_][a-z0-9_]*$/i.test(table) ||
      !/^[a-z_][a-z0-9_]*$/i.test(col)
    ) {
      throw new Error(`非法迁移标识符：${table}.${col}`);
    }
    // 新库中的少数兼容表会在本函数稍后由 CREATE IF NOT EXISTS 建立，届时已包含目标列。
    const tableExists = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table);
    if (!tableExists) return;
    const exists = db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .some((item) => item.name === col);
    if (!exists) db.exec(`ALTER TABLE "${table}" ADD COLUMN "${col}" ${def}`);
  };
  const migrateAvatarJobsMultiEngineInput = () => {
    const columns = db.prepare(`PRAGMA table_info("avatar_jobs")`).all();
    if (!columns.length) return;
    const audioColumn = columns.find((item) => item.name === "audio_file_id");
    const names = new Set(columns.map((item) => item.name));
    const alreadyCurrent =
      Number(audioColumn?.notnull || 0) === 0 &&
      [
        "input_mode",
        "script",
        "voice_id",
        "prompt",
        "engine_requested",
        "tts_attempt_json",
      ].every((name) => names.has(name));
    if (alreadyCurrent) return;

    const value = (name, fallback) =>
      names.has(name) ? `"${name}"` : fallback;
    const selectColumns = [
      "id",
      "tenant_id",
      "created_by",
      "title",
      "image_file_id",
      "audio_file_id",
      value(
        "input_mode",
        "CASE WHEN audio_file_id IS NULL THEN 'script' ELSE 'audio' END",
      ),
      value("script", "''"),
      value("voice_id", "NULL"),
      value("prompt", "''"),
      value("engine_requested", "'auto'"),
      "duration_seconds",
      "status",
      "billing_status",
      "billing_model",
      "held_credits",
      "settled_credits",
      "retry_count",
      "progress",
      "steps_json",
      "provider_name",
      "provider_task_id",
      "provider_result_json",
      value("tts_attempt_json", "NULL"),
      "usage_json",
      "cost_json",
      "output_file_id",
      "result_url",
      "result_sha256",
      "result_bytes",
      "error_code",
      "error_message",
      "timeout_at",
      "started_at",
      "completed_at",
      "cancelled_at",
      "created_at",
      "updated_at",
    ].join(",");
    const insertColumns = [
      "id",
      "tenant_id",
      "created_by",
      "title",
      "image_file_id",
      "audio_file_id",
      "input_mode",
      "script",
      "voice_id",
      "prompt",
      "engine_requested",
      "duration_seconds",
      "status",
      "billing_status",
      "billing_model",
      "held_credits",
      "settled_credits",
      "retry_count",
      "progress",
      "steps_json",
      "provider_name",
      "provider_task_id",
      "provider_result_json",
      "tts_attempt_json",
      "usage_json",
      "cost_json",
      "output_file_id",
      "result_url",
      "result_sha256",
      "result_bytes",
      "error_code",
      "error_message",
      "timeout_at",
      "started_at",
      "completed_at",
      "cancelled_at",
      "created_at",
      "updated_at",
    ].join(",");
    db.exec("PRAGMA foreign_keys=OFF");
    try {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE avatar_jobs_multi_engine (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          created_by INTEGER NOT NULL,
          title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
          image_file_id INTEGER NOT NULL,
          audio_file_id INTEGER,
          input_mode TEXT NOT NULL DEFAULT 'audio'
            CHECK(input_mode IN ('audio','script')),
          script TEXT NOT NULL DEFAULT '',
          voice_id TEXT,
          prompt TEXT NOT NULL DEFAULT '',
          engine_requested TEXT NOT NULL DEFAULT 'auto'
            CHECK(engine_requested IN ('auto','runninghub','heygen','kling')),
          duration_seconds INTEGER NOT NULL CHECK(duration_seconds IN (15,30,60)),
          status TEXT NOT NULL DEFAULT 'queued'
            CHECK(status IN ('queued','running','done','failed','cancelled')),
          billing_status TEXT NOT NULL DEFAULT 'pending'
            CHECK(billing_status IN ('pending','held','settled','released','included','pending_reconciliation')),
          billing_model TEXT NOT NULL,
          held_credits INTEGER NOT NULL DEFAULT 0,
          settled_credits INTEGER,
          retry_count INTEGER NOT NULL DEFAULT 0,
          progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
          steps_json TEXT NOT NULL DEFAULT '[]',
          provider_name TEXT,
          provider_task_id TEXT,
          provider_result_json TEXT,
          tts_attempt_json TEXT,
          usage_json TEXT,
          cost_json TEXT,
          output_file_id INTEGER,
          result_url TEXT,
          result_sha256 TEXT,
          result_bytes INTEGER,
          error_code TEXT,
          error_message TEXT,
          timeout_at TEXT,
          started_at TEXT,
          completed_at TEXT,
          cancelled_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          FOREIGN KEY(created_by) REFERENCES users(id),
          FOREIGN KEY(image_file_id) REFERENCES uploaded_files(id),
          FOREIGN KEY(audio_file_id) REFERENCES uploaded_files(id),
          FOREIGN KEY(output_file_id) REFERENCES uploaded_files(id)
        );
        INSERT INTO avatar_jobs_multi_engine(${insertColumns})
          SELECT ${selectColumns} FROM avatar_jobs;
        DROP TABLE avatar_jobs;
        ALTER TABLE avatar_jobs_multi_engine RENAME TO avatar_jobs;
        CREATE INDEX idx_avatar_jobs_tenant_created
          ON avatar_jobs(tenant_id,created_at DESC,id DESC);
        CREATE INDEX idx_avatar_jobs_recovery
          ON avatar_jobs(tenant_id,status,billing_status,updated_at);
        COMMIT;`);
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys=ON");
    }
  };
  const defaultMarshalAvatar = (code) => `/avatars/${code}.png`;
  // 巡店归档冻结标准库版本（派活AI-R7标准移植）。新库由下方 CREATE TABLE
  // 自带此列；这里只为已存在的老库补列。
  addCol("store_inspections", "standards_version", "TEXT");
  addCol("users", "credits", "INTEGER DEFAULT 0");
  addCol("users", "manager_id", "INTEGER");
  addCol("users", "modules", "TEXT"); // JSON 数组，用户级菜单覆盖（空=继承角色）
  addCol("users", "auth_version", "INTEGER DEFAULT 0"); // 改密后递增，立即吊销历史会话
  addCol(
    "wechat_draft_deliveries",
    "theme_key",
    "TEXT NOT NULL DEFAULT 'orange'",
  );
  migrateAvatarJobsMultiEngineInput();
  addCol("marshals", "prompt", "TEXT");
  addCol("marshals", "avatar", "TEXT"); // 内部任务分部头像
  addCol("marshals", "synced_at", "TEXT"); // 最近同步时间
  // 餐饮数字员工目录元数据。保留 marshal_id/name/duty/status 以兼容既有派活主外键和查询。
  addCol("specialists", "employee_idx", "INTEGER");
  addCol("specialists", "key", "TEXT");
  addCol("specialists", "person", "TEXT");
  addCol("specialists", "emoji", "TEXT");
  addCol("specialists", "description", "TEXT");
  addCol("specialists", "profile_json", "TEXT DEFAULT '{}'");
  addCol("specialists", "group_name", "TEXT");
  addCol("specialists", "sort", "INTEGER DEFAULT 0");
  addCol("agent_tasks", "employee_profile_version", "TEXT");
  addCol("agent_tasks", "employee_prompt_hash", "TEXT");
  addCol("agent_tasks", "employee_capabilities_snapshot", "TEXT");
  addCol("agent_tasks", "employee_config_snapshot", "TEXT");
  addCol("agent_tasks", "employee_skills_snapshot", "TEXT");
  addCol("agent_tasks", "employee_canonical_snapshot", "TEXT");
  addCol("agent_tasks", "employee_input_snapshot", "TEXT");
  addCol("agent_tasks", "employee_web_snapshot", "TEXT");
  addCol("agent_tasks", "approval_routing_policy_snapshot", "TEXT");
  // 自定义智能体工作流导入：保留导入时的原始 JSON（本平台导出或通用步骤式工作流）以便回溯。
  addCol("custom_agents", "source_workflow", "TEXT");
  // 契约分级与“失败不交白卷”（P0-1）：档位快照、失败原因、机器校验报告（不含正文）
  addCol("agent_tasks", "contract_tier", "TEXT");
  addCol("agent_tasks", "fail_reason", "TEXT");
  addCol("agent_tasks", "contract_report", "TEXT");
  addCol("task_submissions", "reviewer_id", "INTEGER");
  addCol("task_submissions", "reviewed_at", "TEXT");
  addCol("task_submissions", "review_reason", "TEXT");
  addCol("task_submissions", "source_ref_type", "TEXT");
  addCol("task_submissions", "source_ref_id", "INTEGER");
  addCol("materials", "source_type", "TEXT");
  addCol("materials", "source_id", "INTEGER");
  addCol("materials", "creator_id", "INTEGER");
  addCol("materials", "note", "TEXT");
  addCol("materials", "body_snapshot", "TEXT");
  addCol("materials", "artifact_snapshot_json", "TEXT");
  addCol("materials", "snapshot_hash", "TEXT");
  // 视频/图片样片库：is_sample=1 表示样片；sample_scope='platform' 为平台级共享
  //（platform_super 上传，全租户可读），'tenant' 为租户自有（严格隔离）。
  addCol("materials", "is_sample", "INTEGER DEFAULT 0");
  addCol("materials", "sample_tags", "TEXT");
  addCol("materials", "sample_note", "TEXT");
  addCol("materials", "sample_scope", "TEXT");
  addCol("contents", "source_type", "TEXT");
  addCol("contents", "source_id", "INTEGER");
  // 合规半自动分发（B6）：人工排期与目标平台。到期只提醒、不自动发布。
  // scheduled_publish_at 存 ISO-8601 UTC 字串，与调度器 JS 时钟直接字典序比较。
  addCol("contents", "scheduled_publish_at", "TEXT");
  addCol("contents", "publish_channel", "TEXT");
  // idx_contents_scheduled_publish 依赖 contents.tenant_id，该列在下方多租户补列循环后才
  // 一定存在（全新库此处尚无该列会报 no such column），索引创建挪到 idx_approvals_assigned 旁。
  addCol(
    "content_automation_rules",
    "brief_json",
    "TEXT NOT NULL DEFAULT '{}'",
  );
  // 旧表的 CHECK 只允许 risk/always，SQLite 无法直接 ALTER CHECK。
  // 只重建规则定义并原样复制历史行，不改写存量规则的策略。
  const automationRuleTable = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='content_automation_rules'`,
    )
    .get();
  if (
    automationRuleTable?.sql &&
    !/approval_mode\s+IN\s*\([^)]*'auto'/iu.test(automationRuleTable.sql)
  ) {
    db.exec(`
      ALTER TABLE content_automation_rules RENAME TO content_automation_rules_legacy_modes;
      CREATE TABLE content_automation_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        employee_idx INTEGER NOT NULL CHECK(employee_idx BETWEEN 0 AND 9),
        topic TEXT NOT NULL CHECK(length(topic) BETWEEN 1 AND 100),
        requirement TEXT NOT NULL DEFAULT '' CHECK(length(requirement) <= 2000),
        brief_json TEXT NOT NULL DEFAULT '{}',
        content_type TEXT NOT NULL,
        content_count INTEGER NOT NULL DEFAULT 3 CHECK(content_count BETWEEN 1 AND 10),
        frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly')),
        run_time TEXT NOT NULL CHECK(
          run_time GLOB '[0-2][0-9]:[0-5][0-9]'
          AND CAST(substr(run_time,1,2) AS INTEGER) BETWEEN 0 AND 23
        ),
        weekday INTEGER CHECK(weekday BETWEEN 1 AND 7),
        approval_mode TEXT NOT NULL DEFAULT 'auto' CHECK(approval_mode IN ('auto','risk','always')),
        next_run_at TEXT,
        last_run_at TEXT,
        last_status TEXT,
        last_error TEXT,
        last_content_id INTEGER,
        created_by INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO content_automation_rules(
        id,tenant_id,name,enabled,employee_idx,topic,requirement,brief_json,content_type,
        content_count,frequency,run_time,weekday,approval_mode,next_run_at,last_run_at,
        last_status,last_error,last_content_id,created_by,created_at,updated_at
      )
      SELECT
        id,tenant_id,name,enabled,employee_idx,topic,requirement,brief_json,content_type,
        content_count,frequency,run_time,weekday,approval_mode,next_run_at,last_run_at,
        last_status,last_error,last_content_id,created_by,created_at,updated_at
      FROM content_automation_rules_legacy_modes;
      DROP TABLE content_automation_rules_legacy_modes;
    `);
  }
  addCol("biz_assets", "creator_id", "INTEGER");
  addCol("biz_assets", "url", "TEXT");
  addCol("biz_assets", "note", "TEXT");
  addCol("asset_flows", "operator_id", "INTEGER");
  addCol("media_jobs", "task_id", "TEXT");
  addCol("media_jobs", "result_id", "INTEGER"); // 后台文本生成完成后指向 contents.id
  for (const table of ["contents", "media_jobs"]) {
    addCol(table, "content_employee_idx", "INTEGER");
    addCol(table, "content_employee_key", "TEXT");
    addCol(table, "content_employee_name", "TEXT");
    addCol(table, "content_employee_group", "TEXT");
    addCol(table, "content_run_mode", "TEXT");
    addCol(table, "profile_version", "TEXT");
    addCol(table, "prompt_hash", "TEXT");
    addCol(table, "snapshot_json", "TEXT");
  }
  addCol("content_templates", "tags", "TEXT");
  addCol("content_templates", "description", "TEXT");
  addCol("content_templates", "source", "TEXT");
  addCol("login_logs", "tenant_id", "INTEGER DEFAULT 0");
  db.exec(`UPDATE login_logs
    SET tenant_id=COALESCE((SELECT tenant_id FROM users WHERE users.username=login_logs.username LIMIT 1),0)
    WHERE tenant_id IS NULL OR tenant_id=0`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_login_logs_tenant_created ON login_logs(tenant_id,created_at)",
  );
  for (const row of db
    .prepare(`SELECT id, code, avatar FROM marshals WHERE code LIKE 'M-__'`)
    .all()) {
    if (!row.avatar)
      db.prepare("UPDATE marshals SET avatar = ? WHERE id = ?").run(
        defaultMarshalAvatar(row.code),
        row.id,
      );
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
  const any = db
    .prepare("SELECT COUNT(*) n FROM users WHERE credits > 0")
    .get();
  if (any && any.n === 0) {
    const grants = {
      boss: 100000,
      ops_director: 50000,
      sales: 20000,
      admin: 30000,
      partner: 5000,
    };
    for (const [role, c] of Object.entries(grants))
      db.prepare("UPDATE users SET credits = ? WHERE role = ?").run(c, role);
  }
  // 三级权限出厂矩阵（客户口径）：老板=总控+老板参谋+餐饮数字员工（含审批所在的系统管理）；
  // 中层管理=其余经营模块；员工=基础模块+按部门匹配。
  // 这里只补齐平台默认项；`role_modules:<tenant>` / `dept_modules:<tenant>` 等租户显式配置
  // 始终由 getTenantConfig 优先读取，升级迁移不得擅自扩权或覆盖。
  const DEFAULT_ROLE_MODULES = {
    boss: [
      "dashboard",
      "advisor",
      "marshals",
      "growth",
      "activities",
      "content",
      "execution",
      "analysis",
      "assets",
      "system",
    ], // 超级权限：全模块+管理后台
    ops_director: [
      "dashboard",
      "marshals",
      "growth",
      "activities",
      "content",
      "execution",
      "analysis",
      "assets",
      "system",
    ], // 中层：经营执行面+数字员工调度；老板参谋仍为老板专属决策位
    sales: ["dashboard", "execution"], // 员工基础包，部门追加见 dept_modules
    admin: ["dashboard", "system"],
    partner: ["execution"],
  };
  const DEFAULT_DEPT_MODULES = {
    // 当前餐饮组织：三个一线部门都承担顾客/商机跟进；会员运营与团餐销售还承担活动运营。
    前厅服务: ["growth"],
    会员运营: ["growth", "activities"],
    团餐销售: ["growth", "activities"],
    内容生产部: ["content"],
    // 历史组织名称继续兼容，避免既有账号升级后丢失入口。
    销售部: ["growth"],
    活动部: ["activities"],
    内容部: ["content"],
    运营中心: ["growth", "activities", "content"],
  };
  const DEFAULT_FEATURE_FLAGS = {
    "content.image": ["boss", "ops_director", "sales"],
    "content.video": ["boss", "ops_director"],
    "data.export": ["boss", "ops_director"],
  };
  const mergePlatformDefaults = (key, defaults) => {
    const currentRow = db
      .prepare("SELECT value FROM sys_config WHERE key = ?")
      .get(key);
    const current = currentRow ? safeJsonParse(currentRow.value, null) : null;
    const merged =
      current && typeof current === "object" && !Array.isArray(current)
        ? { ...defaults, ...current }
        : defaults;
    db.prepare(
      `INSERT INTO sys_config(key,value) VALUES(?,?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run(key, JSON.stringify(merged));
  };
  const MATRIX_VERSION = 5; // V5：餐饮现用部门名称接入业务模块，保留旧部门及租户覆盖语义
  const ver = db
    .prepare(`SELECT value FROM sys_config WHERE key = 'role_modules_version'`)
    .get();
  if (!ver || Number(safeJsonParse(ver.value, 0)) < MATRIX_VERSION) {
    mergePlatformDefaults("role_modules", DEFAULT_ROLE_MODULES);
    mergePlatformDefaults("dept_modules", DEFAULT_DEPT_MODULES);
    mergePlatformDefaults("feature_flags", DEFAULT_FEATURE_FLAGS);
    db.prepare(
      `INSERT INTO sys_config(key,value) VALUES('role_modules_version',?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run(JSON.stringify(MATRIX_VERSION));
  }
  // 内部任务分部默认提示词（空则按职责生成）
  const ms = db
    .prepare("SELECT id, name, title, duty, prompt FROM marshals")
    .all();
  for (const m of ms) {
    if (!m.prompt) {
      db.prepare(
        "UPDATE marshals SET prompt = ?, synced_at = datetime('now','localtime') WHERE id = ?",
      ).run(
        `你是餐饮数字员工组织的「${m.name}」内部任务分部。职责：${m.duty}。输出必须基于用户提供的信息，结论具体可执行；缺少必要输入时明确列出。涉及食品安全、法律、财务、个人数据或外部执行时，必须标明人工复核与授权边界。`,
        m.id,
      );
    }
  }

  // V3：客户生命周期节点（官方11节点口径，来自谈判表 DASH-02 客户补充）+ 客户行业字段
  addCol("leads", "industry", "TEXT");
  // 会员生日营销：客户生日（MM-DD 或 YYYY-MM-DD），近 N 天生日客户主动关怀
  addCol("leads", "birthday", "TEXT");
  // V4：知识库附件（文档/图片上传，FR-SYS-08）
  addCol("kb_docs", "file_path", "TEXT");
  addCol("kb_docs", "file_type", "TEXT");
  addCol("kb_docs", "file_name", "TEXT");
  // Activity plan approval workflow: draft -> ops review -> boss final review -> calendar sync.
  addCol("activities", "plan_status", "TEXT DEFAULT '未提交'");
  addCol("activities", "plan_submitted_at", "TEXT");
  addCol("activities", "plan_approved_at", "TEXT");
  addCol("activities", "plan_approval_id", "INTEGER");
  addCol("tasks", "activity_id", "INTEGER");
  addCol("tasks", "activity_plan_item", "TEXT");
  addCol("tasks", "assigned_by", "INTEGER");
  addCol("tasks", "parent_task_id", "INTEGER");
  addCol("tasks", "source_ref_type", "TEXT");
  addCol("tasks", "source_ref_id", "INTEGER");
  addCol("tasks", "feishu_notified", "INTEGER DEFAULT 0");
  addCol("approvals", "payload", "TEXT");
  addCol("approvals", "approval_level", "TEXT");
  addCol("approvals", "parent_id", "INTEGER");
  // 企业审批路由：老板可按业务类型选择单级、两级或金额阈值，并可指定负责人。
  // 每张审批单保存创建时的不可变规则快照，避免规则变更影响在途任务。
  addCol("approvals", "assigned_reviewer_id", "INTEGER");
  addCol("approvals", "approval_policy_snapshot", "TEXT");
  // V5：知识库权限（FR-SYS-09）：visible_roles=谁可查看，callable_roles=谁的AI调用可引用；NULL=全部角色
  addCol("kb_docs", "visible_roles", "TEXT");
  addCol("kb_docs", "callable_roles", "TEXT");
  // 对话上下文与产出档案：历史不再只做展示，服务端会真正带入下一轮模型调用。
  addCol("ai_conversations", "updated_at", "TEXT");
  addCol("ai_conversations", "summary", "TEXT");
  addCol("ai_conversations", "memory", "TEXT");
  addCol("ai_conversations", "pinned", "INTEGER DEFAULT 0");
  addCol("ai_messages", "attachments_json", "TEXT");
  addCol("ai_messages", "artifact_id", "INTEGER");
  addCol("marshal_chat_sessions", "tenant_id", "INTEGER DEFAULT 1");
  addCol("marshal_chat_sessions", "updated_at", "TEXT");
  addCol("marshal_chat_sessions", "summary", "TEXT");
  addCol("marshal_chat_sessions", "memory", "TEXT");
  addCol("marshal_chat_sessions", "pinned", "INTEGER DEFAULT 0");
  addCol("marshal_chat_msgs", "tenant_id", "INTEGER DEFAULT 1");
  addCol("marshal_chat_msgs", "attachments_json", "TEXT");
  addCol("marshal_chat_msgs", "artifact_id", "INTEGER");
  db.prepare(
    `UPDATE ai_conversations SET updated_at=COALESCE(updated_at,created_at) WHERE updated_at IS NULL`,
  ).run();
  db.prepare(
    `UPDATE marshal_chat_sessions SET updated_at=COALESCE(updated_at,created_at) WHERE updated_at IS NULL`,
  ).run();
  // 知识库分类可自定义（默认七类）
  const kbCats = db
    .prepare(`SELECT value FROM sys_config WHERE key = 'kb_categories'`)
    .get();
  if (!kbCats)
    db.prepare(
      `INSERT INTO sys_config(key,value) VALUES('kb_categories',?)`,
    ).run(
      JSON.stringify([
        "品牌资料",
        "经营制度",
        "菜单产品",
        "沟通案例",
        "顾客画像",
        "数据规范",
        "员工产出",
      ]),
    );
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
  addCol(
    "tenants",
    "data_mode",
    "TEXT NOT NULL DEFAULT 'live' CHECK(data_mode IN ('live','demo'))",
  );
  addCol("users", "tenant_id", "INTEGER DEFAULT 1");
  // 角色化新手指引完成态：由服务端版本、当前岗位和当前登录用户共同判定。
  // 历史账号默认 version=0，升级后自然进入新版本指引，不需要批量回填。
  addCol("users", "onboarding_version", "INTEGER NOT NULL DEFAULT 0");
  addCol("users", "onboarding_role", "TEXT");
  addCol("users", "onboarding_completed_at", "TEXT");
  addCol(
    "users",
    "onboarding_outcome",
    "TEXT CHECK(onboarding_outcome IS NULL OR onboarding_outcome IN ('completed','dismissed'))",
  );
  addCol("credit_logs", "tenant_id", "INTEGER DEFAULT 1");
  addCol("materials", "tenant_id", "INTEGER DEFAULT 1");
  // 历史会话在加 tenant_id 列时会先拿到默认值1，必须按会话所有者回填，否则非总部租户升级后会丢失历史。
  db.prepare(
    `UPDATE marshal_chat_sessions SET tenant_id=COALESCE(
    (SELECT u.tenant_id FROM users u WHERE u.id=marshal_chat_sessions.user_id), tenant_id, 1
  )`,
  ).run();
  db.prepare(
    `UPDATE marshal_chat_msgs SET tenant_id=COALESCE(
    (SELECT s.tenant_id FROM marshal_chat_sessions s WHERE s.id=marshal_chat_msgs.session_id), tenant_id, 1
  )`,
  ).run();
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_users_manager ON users(tenant_id, manager_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_materials_creator ON materials(tenant_id, creator_id)",
  );
  for (const mgr of db
    .prepare(
      `SELECT tenant_id, id FROM users
    WHERE role IN ('ops_director','manager') ORDER BY tenant_id, id`,
    )
    .all()) {
    db.prepare(
      `UPDATE users SET manager_id = ?
      WHERE tenant_id = ? AND manager_id IS NULL AND role IN ('sales','partner')`,
    ).run(mgr.id, mgr.tenant_id);
  }

  // 本公司 = 租户1（已开通、全模块）；积分池首次迁移 = 现有各账号积分之和
  const t1 = db.prepare("SELECT id FROM tenants WHERE id = 1").get();
  if (!t1) {
    const pool =
      db.prepare("SELECT COALESCE(SUM(credits),0) s FROM users").get()?.s || 0;
    db.prepare(
      `INSERT INTO tenants(id,name,contact_name,status,plan,credits,total_recharged,approved_at)
      VALUES(1,'Nano Work 企业','企业负责人','已开通','旗舰版',?,?,datetime('now','localtime'))`,
    ).run(pool, pool);
    db.prepare("UPDATE users SET tenant_id = 1 WHERE tenant_id IS NULL").run();
  }

  // 充值套餐种子（充得多送得多；到账积分 = 价格×100 + 赠送）
  if (
    (db.prepare("SELECT COUNT(*) n FROM recharge_packages").get()?.n || 0) === 0
  ) {
    const pkgs = [
      ["体验包", 99, 9900, 100, 10000, "体验", 1],
      ["基础包", 599, 59900, 6100, 66000, "超值", 2],
      ["标准包", 1299, 129900, 20100, 150000, "热门", 3],
      ["专业包", 2999, 299900, 60100, 360000, "推荐", 4],
      ["旗舰包", 9999, 999900, 300100, 1300000, "旗舰", 5],
    ];
    const ins = db.prepare(
      "INSERT INTO recharge_packages(name,price_yuan,base_credits,bonus_credits,total_credits,tag,sort) VALUES(?,?,?,?,?,?,?)",
    );
    for (const p of pkgs) ins.run(...p);
  }

  // ===== V8：年度套餐/计划模型（2026-09 成都招商会定价：9800 元/年，5 账号，赠 6 万积分）=====
  // recharge_packages 同时承载「纯积分包」(kind=credits) 与「年度套餐」(kind=plan)：
  // - credits 包沿用 base/bonus/total 口径，total_credits 在支付成功时一次入账；
  // - plan 包 total_credits 表示套餐自带积分（本档为 0，不含积分），bonus_credits 在套餐生效时
  //   作为独立 bonus 流水入账，与购买积分区分开。enabled/sort 复用为 is_active/sort_order 语义。
  addCol("recharge_packages", "code", "TEXT"); // 固定判重键（种子/接口按 code 幂等）
  addCol("recharge_packages", "kind", "TEXT DEFAULT 'credits'");
  addCol("recharge_packages", "seat_limit", "INTEGER");
  addCol("recharge_packages", "valid_days", "INTEGER");
  addCol("recharge_packages", "features", "TEXT"); // JSON，预留（试用档/月付档/多门店阶梯价）
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_recharge_packages_code ON recharge_packages(code) WHERE code IS NOT NULL",
  );
  // 租户当前生效套餐（保留旧 plan 文本标签不删；seat_limit 已在 V7 存在，年度套餐生效时覆写）
  addCol("tenants", "plan_code", "TEXT");
  addCol("tenants", "plan_started_at", "TEXT");
  addCol("tenants", "plan_expires_at", "TEXT");
  addCol("tenants", "plan_status", "TEXT DEFAULT 'none'"); // none/active/expiring/expired
  {
    const p = DEFAULT_PLAN_PACKAGE;
    const existed = db
      .prepare("SELECT id FROM recharge_packages WHERE code = ?")
      .get(p.code);
    if (!existed) {
      db.prepare(
        `INSERT INTO recharge_packages(code,name,kind,price_yuan,base_credits,bonus_credits,total_credits,seat_limit,valid_days,features,tag,sort,enabled)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)`,
      ).run(
        p.code,
        p.name,
        p.kind,
        p.priceYuan,
        p.credits,
        p.bonusCredits,
        p.credits,
        p.seatLimit,
        p.validDays,
        JSON.stringify(p.features),
        p.tag,
        p.sort,
      );
    }
  }

  // ===== V9：租户级模型路由 + 月度 AI 积分预算（2026-09-02 宣讲会承诺，本轮只做租户级）=====
  // tenant_model_routing：每家企业一行，routing_json 与 yunwu.js DEFAULT_ROUTING 同形，
  // 解析优先级 租户覆盖 > sys_config.model_routing（平台全局）> DEFAULT_ROUTING（见 engines/yunwu.js routing()）。
  // 表按 tenant_id 主键、显式带租户读写，属系统级配置表，不进 ISOLATED 自动注入集合。
  db.exec(`
  CREATE TABLE IF NOT EXISTS tenant_model_routing (
    tenant_id INTEGER PRIMARY KEY,
    routing_json TEXT NOT NULL,
    updated_by INTEGER,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  `);
  // 月度预算：NULL=不限；达到 budget_alert_ratio 当天首次触发通知老板（engines/credits.js）。
  addCol("tenants", "monthly_credit_budget", "INTEGER");
  addCol("tenants", "budget_alert_ratio", "REAL DEFAULT 0.8");
  // 预算/用量报表按租户 + 时间聚合，credit_logs 此前只有 user_id 索引
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_credit_logs_tenant_created ON credit_logs(tenant_id, created_at)",
  );
  // 按人月度配额：本轮只预留列 + 读取统计（precheck 只记录 quotaState，不拦截）；
  // 按人强制拦截为后续版本，见建议清单 B1。
  addCol("users", "monthly_credit_quota", "INTEGER");

  // ===== V7：多租户数据隔离 + 账号配额（FR-SAAS-06）=====
  addCol("tenants", "seat_limit", "INTEGER DEFAULT 5"); // 企业账号席位上限
  db.prepare(`UPDATE tenants SET seat_limit = 999 WHERE id = 1`).run(); // 总部不限
  // 业务表统一加 tenant_id（默认1=总部历史数据归属）
  for (const t of [
    "leads",
    "follow_ups",
    "lead_ai_suggestions",
    "partners",
    "partner_actions",
    "daily_ops",
    "activities",
    "activity_invites",
    "contents",
    "materials",
    "content_templates",
    "agent_tasks",
    "battle_plans",
    "weekly_reviews",
    "approvals",
    "kb_docs",
    "goals",
    "tasks",
    "task_submissions",
    "biz_assets",
    "employee_point_logs",
    "employee_awards",
    "asset_flows",
    "orders",
    "lead_journey",
    "ai_conversations",
    "ai_messages",
    "media_jobs",
    "op_logs",
    "notifications",
    "specialists",
  ]) {
    addCol(t, "tenant_id", "INTEGER DEFAULT 1");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_approvals_assigned
    ON approvals(tenant_id,status,assigned_reviewer_id,created_at)`);
  // 合规半自动分发（B6）排期索引：contents.tenant_id 已由上方补列循环保证存在。
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contents_scheduled_publish
    ON contents(tenant_id,scheduled_publish_at)
    WHERE scheduled_publish_at IS NOT NULL`);
  addCol("notifications", "link", "TEXT");
  // 门店订单完整性：订单头明确归属门店；明细批量提交使用独立幂等账本。
  addCol("orders", "store_id", "INTEGER");
  // 开店向导（租户级新手引导，routes/onboarding.js）：pending/in_progress/completed/skipped。
  // 首次加列时，已经在用系统的老企业（有门店/知识/任务数据）直接记为 skipped，
  // 避免升级后被强制拉进向导；只有空白新企业保持 pending。
  const onboardingColumnFresh = !db
    .prepare(`PRAGMA table_info("tenants")`)
    .all()
    .some((item) => item.name === "onboarding_status");
  addCol("tenants", "onboarding_status", "TEXT DEFAULT 'pending'");
  addCol("tenants", "onboarding_answers", "TEXT");
  addCol("tenants", "onboarding_completed_at", "TEXT");
  if (onboardingColumnFresh) {
    db.prepare(
      `UPDATE tenants SET onboarding_status='skipped'
       WHERE COALESCE(onboarding_status,'pending')='pending'
         AND (
           EXISTS(SELECT 1 FROM stores s WHERE s.tenant_id=tenants.id)
           OR EXISTS(SELECT 1 FROM kb_docs k WHERE k.tenant_id=tenants.id)
           OR EXISTS(SELECT 1 FROM agent_tasks t WHERE t.tenant_id=tenants.id)
         )`,
    ).run();
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_item_commits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 1,
      order_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(tenant_id,order_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_order_item_commits_order
      ON order_item_commits(tenant_id,order_id);
    CREATE INDEX IF NOT EXISTS idx_orders_tenant_store_date
      ON orders(tenant_id,store_id,created_at);
  `);
  db.prepare(
    `UPDATE notifications SET tenant_id=COALESCE(
    (SELECT u.tenant_id FROM users u WHERE u.id=notifications.user_id), tenant_id, 1
  )`,
  ).run();
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(tenant_id,user_id,read,created_at)",
  );
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_activity_assignment
    ON tasks(tenant_id, activity_id, activity_plan_item)
    WHERE activity_id IS NOT NULL AND activity_plan_item IS NOT NULL`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_tasks_activity ON tasks(tenant_id, activity_id, status)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(tenant_id, parent_task_id, status)",
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_submissions_source_ref
    ON task_submissions(tenant_id,source_ref_type,source_ref_id)`);
  // 重建带全局 UNIQUE 的聚合表为「租户+时间」复合唯一（否则多租户同日/同期冲突串数据）
  const rebuild = (table, cols, uniqCol) => {
    const cur =
      db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
        .get(table)?.sql || "";
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
  rebuild(
    "daily_ops",
    `id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, content_count INTEGER DEFAULT 0, new_leads INTEGER DEFAULT 0, invited INTEGER DEFAULT 0, arrived INTEGER DEFAULT 0, deals INTEGER DEFAULT 0, deal_amount REAL DEFAULT 0, repurchase_amount REAL DEFAULT 0, active_partners INTEGER DEFAULT 0, orders INTEGER DEFAULT 0, marketing_cost REAL DEFAULT 0, week_problem TEXT, next_action TEXT`,
    "date",
  );
  rebuild(
    "goals",
    `id INTEGER PRIMARY KEY AUTOINCREMENT, period TEXT, revenue_target REAL DEFAULT 0, leads_target INTEGER DEFAULT 0, partner_target INTEGER DEFAULT 0, activity_target INTEGER DEFAULT 0`,
    "period",
  );
  rebuild(
    "battle_plans",
    `id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, theme TEXT, audience TEXT, plan TEXT, created_at TEXT DEFAULT (datetime('now','localtime'))`,
    "date",
  );
  rebuild(
    "weekly_reviews",
    `id INTEGER PRIMARY KEY AUTOINCREMENT, week TEXT NOT NULL, report TEXT, created_at TEXT DEFAULT (datetime('now','localtime'))`,
    "week",
  );

  // V8：知识库向量列（真向量 RAG 语义检索，FR-KB-RAG）
  addCol("kb_docs", "embedding", "TEXT"); // JSON 浮点数组（1536维），空=未向量化（检索时降级）
  // 内容自动沉淀知识库的稳定来源键：旧库增量加列；NULL 来源的历史/手工知识不受唯一约束。
  addCol("kb_docs", "source_type", "TEXT");
  addCol("kb_docs", "source_id", "INTEGER");
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
    employee_idx INTEGER NOT NULL CHECK(employee_idx BETWEEN 101 AND 161),
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
  `);
  // V10：目录扩到 101-161（巡店督导）。旧库 CHECK(101-160) 无法 ALTER，按 SQLite 12 步法重建。
  {
    const legacySql =
      db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='employee_workbench_configs'`,
        )
        .get()?.sql || "";
    if (legacySql.includes("BETWEEN 101 AND 160")) {
      db.exec(`
        CREATE TABLE employee_workbench_configs_v10 (
          tenant_id INTEGER NOT NULL,
          employee_idx INTEGER NOT NULL CHECK(employee_idx BETWEEN 101 AND 161),
          prompt_override TEXT,
          work_config_json TEXT NOT NULL DEFAULT '{}',
          skills_json TEXT NOT NULL DEFAULT '[]',
          revision INTEGER NOT NULL DEFAULT 1,
          updated_by INTEGER,
          updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          PRIMARY KEY(tenant_id,employee_idx)
        );
        INSERT INTO employee_workbench_configs_v10 SELECT * FROM employee_workbench_configs;
        DROP TABLE employee_workbench_configs;
        ALTER TABLE employee_workbench_configs_v10 RENAME TO employee_workbench_configs;
        CREATE INDEX IF NOT EXISTS idx_employee_workbench_configs_tenant
          ON employee_workbench_configs(tenant_id,employee_idx);
      `);
    }
  }
  db.exec(`
  -- V10：巡店督导（#161）归档表——督导×月、门店×月统计的唯一数据源
  CREATE TABLE IF NOT EXISTS store_inspections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL UNIQUE,
    content_id INTEGER,
    supervisor_user_id INTEGER,
    supervisor_name TEXT,
    store_name TEXT NOT NULL,
    inspection_type TEXT NOT NULL DEFAULT '例行巡店',
    score REAL NOT NULL,
    sub_scores_json TEXT NOT NULL DEFAULT '{}',
    issue_count INTEGER NOT NULL DEFAULT 0,
    high_issues INTEGER NOT NULL DEFAULT 0,
    issues_json TEXT NOT NULL DEFAULT '[]',
    rectified_json TEXT,
    standards_version TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_store_inspections_tenant_time ON store_inspections(tenant_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_store_inspections_tenant_store ON store_inspections(tenant_id, store_name);
  -- ===== 门店日清（开店/闭店/交接班 + 食安三件套）：每日勾选留痕 =====
  CREATE TABLE IF NOT EXISTS store_checklist_marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    checklist_key TEXT NOT NULL,     -- opening/closing/handover/morning_check/disinfect/sample
    item_key TEXT NOT NULL,
    done_by INTEGER,
    done_by_name TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(tenant_id, date, checklist_key, item_key)
  );
  CREATE INDEX IF NOT EXISTS idx_checklist_marks_tenant_date ON store_checklist_marks(tenant_id, date);
  -- ===== 今日沽清（菜品估清）：按天记录状态切换日志，当日最后一条为准 =====
  CREATE TABLE IF NOT EXISTS dish_soldout_marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    dish_id INTEGER NOT NULL,
    soldout INTEGER NOT NULL DEFAULT 1,
    marked_by INTEGER,
    marked_by_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_soldout_tenant_date ON dish_soldout_marks(tenant_id, date, dish_id);
  -- ===== 排班：谁哪天哪个班（班次模板为代码常量） =====
  CREATE TABLE IF NOT EXISTS shift_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    shift_key TEXT NOT NULL,          -- morning/middle/evening/full/off
    assigned_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(tenant_id, user_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_shifts_tenant_date ON shift_assignments(tenant_id, date);
  -- ===== 考勤：员工上下班打卡 =====
  CREATE TABLE IF NOT EXISTS attendance_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    clock_in TEXT,
    clock_out TEXT,
    UNIQUE(tenant_id, user_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_attendance_tenant_date ON attendance_records(tenant_id, date);
  -- ===== 评价中心：平台好评差评台账（手录/导入），AI 回复稿 + 人工确认回填 =====
  CREATE TABLE IF NOT EXISTS store_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    platform TEXT NOT NULL DEFAULT '美团',   -- 美团/饿了么/大众点评/抖音/其他
    rating INTEGER NOT NULL,                 -- 1-5
    content TEXT NOT NULL,
    author TEXT,
    store_name TEXT,
    review_date TEXT,
    status TEXT NOT NULL DEFAULT '待回复',    -- 待回复/已回复/无需回复
    category TEXT,                            -- 差评六类归因（行业SOP：归因决定整改责任）
    reply TEXT,
    replied_at TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_reviews_tenant_status ON store_reviews(tenant_id, status, rating);
  CREATE INDEX IF NOT EXISTS idx_reviews_tenant_date ON store_reviews(tenant_id, review_date);
  -- ===== 库存台账：原料/物料当前量与安全线，变动全留痕 =====
  CREATE TABLE IF NOT EXISTS inventory_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    category TEXT,
    unit TEXT NOT NULL DEFAULT '份',
    quantity REAL NOT NULL DEFAULT 0,
    safe_line REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_by_name TEXT,
    UNIQUE(tenant_id, name)
  );
  CREATE TABLE IF NOT EXISTS inventory_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    delta REAL NOT NULL,
    reason TEXT NOT NULL,             -- 入库/出库/盘点修正
    note TEXT,
    moved_by INTEGER,
    moved_by_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_inventory_moves_tenant_item ON inventory_moves(tenant_id, item_id, created_at);
  -- ===== 外卖日报：按平台按天手录/导入的运营数据 =====
  CREATE TABLE IF NOT EXISTS delivery_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    platform TEXT NOT NULL,           -- 美团/饿了么/其他
    orders INTEGER NOT NULL DEFAULT 0,
    revenue REAL NOT NULL DEFAULT 0,
    rating REAL,
    avg_prep_minutes REAL,
    bad_reviews INTEGER NOT NULL DEFAULT 0,
    recorded_by INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(tenant_id, date, platform)
  );
  CREATE INDEX IF NOT EXISTS idx_delivery_daily_tenant_date ON delivery_daily(tenant_id, date);
  -- ===== 门店每日营业汇总（连锁过渡方案：门店人工上传/拍照识别的日结数据，按店按日唯一）=====
  -- daily_ops 是租户级经营日报（UNIQUE(tenant_id,date)），无法按店拆分；本表承接多门店汇总，
  -- 同店同日重复导入 = 覆盖。source 记录来源（excel_import / vision_import / manual）。
  CREATE TABLE IF NOT EXISTS store_daily_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    store_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    revenue REAL NOT NULL DEFAULT 0,
    orders INTEGER,                    -- 可空：未识别/未填写不落 0
    avg_ticket REAL,
    delivery_revenue REAL,
    delivery_ratio REAL,
    refunds REAL,
    note TEXT,
    source TEXT NOT NULL DEFAULT 'excel_import',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(tenant_id, store_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_store_daily_ops_tenant_date ON store_daily_ops(tenant_id, date);
  -- ===== 数字员工自动进化（Warp 自我改进模式）：
  -- 老板验收反馈（通过/驳回+理由）→ 改进器 AI 提炼「实战心得」提案 → 人审采纳 → 派活注入。
  -- notes 是员工的进化沉淀（原则+为什么+证据），proposals 是待人审的进化提案。
  CREATE TABLE IF NOT EXISTS employee_evolution_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    specialist_id INTEGER NOT NULL,
    note TEXT NOT NULL,               -- 心得原则（写原则不写死规则）
    rationale TEXT,                   -- 为什么（让员工能举一反三）
    evidence TEXT,                    -- 来源反馈摘要（可追溯）
    status TEXT NOT NULL DEFAULT 'active',  -- active/retired
    proposal_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    retired_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_evolution_notes_tenant_specialist
    ON employee_evolution_notes(tenant_id, specialist_id, status);
  CREATE TABLE IF NOT EXISTS employee_evolution_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    specialist_id INTEGER NOT NULL,
    summary TEXT,
    proposal_json TEXT NOT NULL,      -- { additions:[{note,rationale,evidence}], retireNoteIds:[], verdict }
    signals_json TEXT,                -- 输入反馈信号快照（审计口径）
    status TEXT NOT NULL DEFAULT '待审核',  -- 待审核/已采纳/已驳回
    created_by INTEGER,
    decided_by INTEGER,
    decided_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_evolution_proposals_tenant_specialist
    ON employee_evolution_proposals(tenant_id, specialist_id, status, id DESC);
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
  CREATE TABLE IF NOT EXISTS content_connector_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    employee_idx INTEGER NOT NULL CHECK(employee_idx BETWEEN 0 AND 9),
    connector_kind TEXT NOT NULL,
    connector_mode TEXT NOT NULL,
    status TEXT NOT NULL,
    input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
    output_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    completed_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_content_connector_runs_tenant_employee
    ON content_connector_runs(tenant_id,employee_idx,id DESC);
  CREATE INDEX IF NOT EXISTS idx_content_connector_runs_tenant_creator
    ON content_connector_runs(tenant_id,created_by,id DESC);
  CREATE TABLE IF NOT EXISTS content_automation_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    employee_idx INTEGER NOT NULL CHECK(employee_idx BETWEEN 0 AND 9),
    topic TEXT NOT NULL CHECK(length(topic) BETWEEN 1 AND 100),
    requirement TEXT NOT NULL DEFAULT '' CHECK(length(requirement) <= 2000),
    brief_json TEXT NOT NULL DEFAULT '{}',
    content_type TEXT NOT NULL,
    content_count INTEGER NOT NULL DEFAULT 3 CHECK(content_count BETWEEN 1 AND 10),
    frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly')),
    run_time TEXT NOT NULL CHECK(
      run_time GLOB '[0-2][0-9]:[0-5][0-9]'
      AND CAST(substr(run_time,1,2) AS INTEGER) BETWEEN 0 AND 23
    ),
    weekday INTEGER CHECK(weekday BETWEEN 1 AND 7),
    approval_mode TEXT NOT NULL DEFAULT 'auto' CHECK(approval_mode IN ('auto','risk','always')),
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
  CREATE TABLE IF NOT EXISTS avatar_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
    image_file_id INTEGER NOT NULL,
    audio_file_id INTEGER,
    input_mode TEXT NOT NULL DEFAULT 'audio'
      CHECK(input_mode IN ('audio','script')),
    script TEXT NOT NULL DEFAULT '',
    voice_id TEXT,
    prompt TEXT NOT NULL DEFAULT '',
    engine_requested TEXT NOT NULL DEFAULT 'auto'
      CHECK(engine_requested IN ('auto','runninghub','heygen','kling')),
    duration_seconds INTEGER NOT NULL CHECK(duration_seconds IN (15,30,60)),
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK(status IN ('queued','running','done','failed','cancelled')),
    billing_status TEXT NOT NULL DEFAULT 'pending'
      CHECK(billing_status IN ('pending','held','settled','released','included','pending_reconciliation')),
    billing_model TEXT NOT NULL,
    held_credits INTEGER NOT NULL DEFAULT 0,
    settled_credits INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0,
    progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
    steps_json TEXT NOT NULL DEFAULT '[]',
    provider_name TEXT,
    provider_task_id TEXT,
    provider_result_json TEXT,
    tts_attempt_json TEXT,
    usage_json TEXT,
    cost_json TEXT,
    output_file_id INTEGER,
    result_url TEXT,
    result_sha256 TEXT,
    result_bytes INTEGER,
    error_code TEXT,
    error_message TEXT,
    timeout_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(created_by) REFERENCES users(id),
    FOREIGN KEY(image_file_id) REFERENCES uploaded_files(id),
    FOREIGN KEY(audio_file_id) REFERENCES uploaded_files(id),
    FOREIGN KEY(output_file_id) REFERENCES uploaded_files(id)
  );
  CREATE INDEX IF NOT EXISTS idx_avatar_jobs_tenant_created
    ON avatar_jobs(tenant_id,created_at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS idx_avatar_jobs_recovery
    ON avatar_jobs(tenant_id,status,billing_status,updated_at);
  CREATE TABLE IF NOT EXISTS avatar_voices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    source_file_id INTEGER NOT NULL,
    label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 24),
    provider_voice_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','ready','failed')),
    billing_status TEXT NOT NULL DEFAULT 'pending'
      CHECK(billing_status IN ('pending','held','settled','released','pending_reconciliation')),
    billing_model TEXT NOT NULL DEFAULT 'minimax-voice-clone',
    provider_attempt_json TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(created_by) REFERENCES users(id),
    FOREIGN KEY(source_file_id) REFERENCES uploaded_files(id),
    UNIQUE(tenant_id,provider_voice_id)
  );
  CREATE INDEX IF NOT EXISTS idx_avatar_voices_tenant_created
    ON avatar_voices(tenant_id,created_at DESC,id DESC);
  CREATE TABLE IF NOT EXISTS text_video_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
    mode TEXT NOT NULL DEFAULT 'images' CHECK(mode IN ('images','clips')),
    body TEXT NOT NULL CHECK(length(body) BETWEEN 20 AND 12000),
    params_json TEXT NOT NULL DEFAULT '{}',
    script TEXT,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK(status IN ('queued','running','done','failed','cancelled')),
    billing_status TEXT NOT NULL DEFAULT 'pending'
      CHECK(billing_status IN ('pending','held','settled','released','included','pending_reconciliation')),
    billing_model TEXT NOT NULL DEFAULT 'text-video-composer',
    held_credits INTEGER NOT NULL DEFAULT 0,
    settled_credits INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0,
    progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
    steps_json TEXT NOT NULL DEFAULT '[]',
    usage_json TEXT,
    cost_json TEXT,
    render_evidence_json TEXT,
    output_file_id INTEGER,
    result_url TEXT,
    result_sha256 TEXT,
    result_bytes INTEGER,
    duration_seconds REAL,
    error_code TEXT,
    error_message TEXT,
    timeout_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(created_by) REFERENCES users(id),
    FOREIGN KEY(output_file_id) REFERENCES uploaded_files(id)
  );
  CREATE INDEX IF NOT EXISTS idx_text_video_jobs_tenant_created
    ON text_video_jobs(tenant_id,created_at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS idx_text_video_jobs_recovery
    ON text_video_jobs(tenant_id,status,billing_status,updated_at);
  CREATE TABLE IF NOT EXISTS wechat_draft_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('content','pipeline')),
    source_id INTEGER NOT NULL,
    source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint)=64),
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
    author TEXT NOT NULL DEFAULT '' CHECK(length(author) <= 8),
    theme_key TEXT NOT NULL DEFAULT 'orange',
    request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
    request_key TEXT NOT NULL CHECK(length(request_key)=24),
    status TEXT NOT NULL DEFAULT 'processing'
      CHECK(status IN ('processing','submitting','submitted','done','blocked','failed')),
    billing_status TEXT NOT NULL DEFAULT 'pending'
      CHECK(billing_status IN ('pending','held','settled','released','pending_reconciliation')),
    fixed_credits INTEGER NOT NULL DEFAULT 1 CHECK(fixed_credits > 0),
    held_credits INTEGER NOT NULL DEFAULT 0 CHECK(held_credits >= 0),
    settled_credits INTEGER CHECK(settled_credits >= 0),
    cover_file_id INTEGER,
    image_file_ids_json TEXT NOT NULL DEFAULT '[]',
    provider_media_id TEXT,
    provider_attempt_json TEXT NOT NULL DEFAULT '{}',
    error_code TEXT,
    error_message TEXT,
    submitted_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(created_by) REFERENCES users(id),
    FOREIGN KEY(cover_file_id) REFERENCES uploaded_files(id)
  );
  CREATE INDEX IF NOT EXISTS idx_wechat_drafts_tenant_created
    ON wechat_draft_deliveries(tenant_id,created_at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS idx_wechat_drafts_recovery
    ON wechat_draft_deliveries(tenant_id,status,billing_status,updated_at);
  CREATE INDEX IF NOT EXISTS idx_wechat_drafts_request
    ON wechat_draft_deliveries(tenant_id,request_hash,id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_drafts_active_source
    ON wechat_draft_deliveries(tenant_id,source_type,source_id)
    WHERE status IN ('processing','submitting','submitted');
  CREATE TABLE IF NOT EXISTS tool_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    tool_key TEXT NOT NULL CHECK(tool_key IN ('hot','remix','pcal','bench','warm','leads','shot','menu-copy','link-script','vars')),
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
    progress_json TEXT NOT NULL DEFAULT '[]',
    error_json TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    execution_state TEXT NOT NULL DEFAULT 'queued'
      CHECK(execution_state IN ('queued','running','retrying','done','failed')),
    last_heartbeat_at TEXT,
    timeout_at TEXT,
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
    tool_key TEXT NOT NULL CHECK(tool_key IN ('hot','remix','pcal','bench','warm','leads','shot','menu-copy','link-script','vars')),
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
  CREATE TABLE IF NOT EXISTS tool_run_feishu_exports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    run_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'syncing'
      CHECK(status IN ('syncing','done','failed')),
    table_name TEXT NOT NULL DEFAULT '',
    table_id TEXT NOT NULL DEFAULT '',
    synced INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    error_json TEXT,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(tenant_id,run_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tool_run_feishu_exports_tenant_status
    ON tool_run_feishu_exports(tenant_id,status,updated_at DESC,id DESC);
  CREATE TABLE IF NOT EXISTS tool_run_pcal_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    run_id INTEGER NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    calendar_json TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(tenant_id,run_id,version),
    FOREIGN KEY(run_id) REFERENCES tool_runs(id),
    FOREIGN KEY(created_by) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_tool_run_pcal_edits_latest
    ON tool_run_pcal_edits(tenant_id,run_id,version DESC);
  CREATE TABLE IF NOT EXISTS toolbox_automation_configs (
    tenant_id INTEGER NOT NULL,
    automation_key TEXT NOT NULL
      CHECK(automation_key IN ('hot_daily','bench_weekly')),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    created_by INTEGER NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    last_success_key TEXT,
    last_success_at TEXT,
    last_tool_run_id INTEGER,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    PRIMARY KEY(tenant_id,automation_key),
    FOREIGN KEY(created_by) REFERENCES users(id),
    FOREIGN KEY(last_tool_run_id) REFERENCES tool_runs(id)
  );
  CREATE INDEX IF NOT EXISTS idx_toolbox_automation_configs_due
    ON toolbox_automation_configs(tenant_id,enabled,automation_key);
  CREATE TABLE IF NOT EXISTS toolbox_automation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    automation_key TEXT NOT NULL
      CHECK(automation_key IN ('hot_daily','bench_weekly')),
    trigger TEXT NOT NULL CHECK(trigger IN ('scheduled','manual')),
    claim_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'claimed'
      CHECK(status IN ('claimed','enqueuing','running','completing','done','failed')),
    attempt_count INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER NOT NULL,
    tool_run_id INTEGER,
    config_snapshot_json TEXT NOT NULL DEFAULT '{}',
    request_json TEXT NOT NULL DEFAULT '{}',
    result_snapshot_json TEXT NOT NULL DEFAULT '{}',
    failure_json TEXT,
    knowledge_id INTEGER,
    notification_id INTEGER,
    next_retry_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(tenant_id,claim_key),
    FOREIGN KEY(created_by) REFERENCES users(id),
    FOREIGN KEY(tool_run_id) REFERENCES tool_runs(id),
    FOREIGN KEY(knowledge_id) REFERENCES kb_docs(id),
    FOREIGN KEY(notification_id) REFERENCES notifications(id)
  );
  CREATE INDEX IF NOT EXISTS idx_toolbox_automation_runs_recovery
    ON toolbox_automation_runs(tenant_id,status,next_retry_at,updated_at);
  CREATE INDEX IF NOT EXISTS idx_toolbox_automation_runs_tool
    ON toolbox_automation_runs(tenant_id,tool_run_id);
  `);
  addCol("tenant_marshal_overrides", "online", "INTEGER");
  addCol("tenant_marshal_overrides", "synced_at", "TEXT");
  // 数字员工自我介绍（老板叮嘱 + 每周校验状态）：按 (tenant_id, specialist_id) 追加在既有覆盖行上，
  // 没有覆盖行时读取侧回落到 catalog 默认介绍。
  addCol("tenant_specialist_overrides", "self_intro", "TEXT");
  addCol("tenant_specialist_overrides", "self_intro_source", "TEXT");
  addCol("tenant_specialist_overrides", "self_intro_updated_at", "TEXT");
  addCol("tenant_specialist_overrides", "self_intro_verified_at", "TEXT");
  addCol("tenant_specialist_overrides", "self_intro_check_status", "TEXT");
  addCol("tenant_specialist_overrides", "self_intro_check_note", "TEXT");
  // 进化心得/提案的员工域：restaurant 时 specialist_id 指 specialists.id；
  // content 时 specialist_id 存内容员工 idx（0-10），两域各自独立取数与注入。
  addCol("employee_evolution_notes", "domain", "TEXT NOT NULL DEFAULT 'restaurant'");
  addCol("employee_evolution_proposals", "domain", "TEXT NOT NULL DEFAULT 'restaurant'");
  // 发布时冻结版本归因；旧日志/回填留 NULL，不用当前选版伪造历史归属。
  addCol("content_publish_logs", "attribution_json", "TEXT");
  addCol("content_publish_metrics", "attribution_json", "TEXT");
  // 评价归因列：老库（表已存在但无此列）在建表语句之后补列
  addCol("store_reviews", "category", "TEXT");
  addCol("data_import_commits", "request_hash", "TEXT");
  addCol("tool_runs", "progress_json", "TEXT NOT NULL DEFAULT '[]'");
  addCol("tool_runs", "error_json", "TEXT");
  addCol("tool_runs", "retry_count", "INTEGER NOT NULL DEFAULT 0");
  addCol(
    "tool_runs",
    "execution_state",
    "TEXT NOT NULL DEFAULT 'queued' CHECK(execution_state IN ('queued','running','retrying','done','failed'))",
  );
  addCol("tool_runs", "last_heartbeat_at", "TEXT");
  addCol("tool_runs", "timeout_at", "TEXT");
  addCol(
    "tool_run_feishu_exports",
    "calendar_version",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addCol(
    "tool_run_feishu_exports",
    "export_version",
    "INTEGER NOT NULL DEFAULT 1",
  );
  // SQLite 无法 ALTER CHECK；旧库的工具键可能缺少后续新增项。成对重建主表与事件表，
  // 显式列复制所有历史行，不改写旧任务、积分关联或自增ID。整段 DDL 在同一事务内幂等完成。
  const toolRunsSql =
    db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_runs'`,
      )
      .get()?.sql || "";
  const toolEventsSql =
    db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_run_events'`,
      )
      .get()?.sql || "";
  if (
    toolRunsSql &&
    toolEventsSql &&
    (!toolRunsSql.includes("'menu-copy'") ||
      !toolEventsSql.includes("'menu-copy'") ||
      !toolRunsSql.includes("'link-script'") ||
      !toolEventsSql.includes("'link-script'"))
  ) {
    // 根因加固：RENAME tool_runs 时 SQLite 会把其它表里 REFERENCES tool_runs 的
    // 外键定义同步改写成 legacy 名（3.25+ 新语义默认改写；foreign_keys=ON 时旧语义
    // 也会改写），随后 DROP legacy 表就让 toolbox_automation_runs 等子表外键悬空。
    // 因此必须同时关掉两条改写路径：foreign_keys 只能在事务外设置（事务内是 no-op），
    // legacy_alter_table=ON 让 RENAME 走旧行为、不动其它表的定义。
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("PRAGMA legacy_alter_table=ON");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE tool_run_events RENAME TO tool_run_events_legacy_menu_copy;
        ALTER TABLE tool_runs RENAME TO tool_runs_legacy_menu_copy;
        CREATE TABLE tool_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          tool_key TEXT NOT NULL CHECK(tool_key IN ('hot','remix','pcal','bench','warm','leads','shot','menu-copy','link-script','vars')),
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
          progress_json TEXT NOT NULL DEFAULT '[]',
          error_json TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          execution_state TEXT NOT NULL DEFAULT 'queued'
            CHECK(execution_state IN ('queued','running','retrying','done','failed')),
          last_heartbeat_at TEXT,
          timeout_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          FOREIGN KEY(specialist_id) REFERENCES specialists(id),
          FOREIGN KEY(created_by) REFERENCES users(id)
        );
        INSERT INTO tool_runs(
          id,tenant_id,tool_key,tool_title,title,status,employee_idx,employee_name,
          specialist_id,created_by,input_json,input_summary,result_md,assumptions_json,
          evidence_json,provenance_json,progress_json,error_json,retry_count,
          execution_state,last_heartbeat_at,timeout_at,created_at,updated_at
        )
        SELECT
          id,tenant_id,tool_key,tool_title,title,status,employee_idx,employee_name,
          specialist_id,created_by,input_json,input_summary,result_md,assumptions_json,
          evidence_json,provenance_json,progress_json,error_json,retry_count,
          execution_state,last_heartbeat_at,timeout_at,created_at,updated_at
        FROM tool_runs_legacy_menu_copy;
        CREATE TABLE tool_run_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          run_id INTEGER NOT NULL,
          event_type TEXT NOT NULL DEFAULT 'generated' CHECK(event_type IN ('generated')),
          tool_key TEXT NOT NULL CHECK(tool_key IN ('hot','remix','pcal','bench','warm','leads','shot','menu-copy','link-script','vars')),
          employee_idx INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('done','failed')),
          source_system TEXT NOT NULL DEFAULT 'nanowork' CHECK(source_system='nanowork'),
          metadata_json TEXT NOT NULL DEFAULT '{}',
          occurred_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          FOREIGN KEY(run_id) REFERENCES tool_runs(id),
          FOREIGN KEY(user_id) REFERENCES users(id)
        );
        INSERT INTO tool_run_events(
          id,tenant_id,run_id,event_type,tool_key,employee_idx,user_id,status,
          source_system,metadata_json,occurred_at
        )
        SELECT
          id,tenant_id,run_id,event_type,tool_key,employee_idx,user_id,status,
          source_system,metadata_json,occurred_at
        FROM tool_run_events_legacy_menu_copy;
        DROP TABLE tool_run_events_legacy_menu_copy;
        DROP TABLE tool_runs_legacy_menu_copy;
        CREATE INDEX idx_tool_runs_tenant_created
          ON tool_runs(tenant_id,created_at DESC,id DESC);
        CREATE INDEX idx_tool_runs_tenant_employee
          ON tool_runs(tenant_id,employee_idx,created_at DESC);
        CREATE INDEX idx_tool_run_events_tenant_time
          ON tool_run_events(tenant_id,occurred_at DESC,id DESC);
        CREATE UNIQUE INDEX idx_tool_run_events_generated_once
          ON tool_run_events(tenant_id,run_id,event_type);
        COMMIT;
      `);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* transaction already closed */
      }
      throw error;
    } finally {
      db.exec("PRAGMA legacy_alter_table=OFF");
      db.exec("PRAGMA foreign_keys=ON");
    }
  }

  // 自愈迁移：修复历史事故留下的悬空外键。早期版本的 menu-copy 迁移在 RENAME 时
  // 没有关掉外键改写，导致 toolbox_automation_runs / toolbox_automation_configs /
  // tool_run_pcal_edits 的外键被 SQLite 自动改写成 REFERENCES "tool_runs_legacy_menu_copy"，
  // 而 legacy 表随后已被 DROP——这些表从此任何写操作都报 no such table。
  // 这里扫描所有定义里还残留 legacy 名的表，按官方推荐的重建流程逐表修复：
  // 建修正表 → 显式列复制 → DROP 旧表 → RENAME 回原名 → 重建原有索引。
  // 修好的库定义里不再含 legacy 名，扫描为空，因此重复执行天然幂等。
  const danglingFkTables = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type='table' AND sql LIKE '%legacy_menu_copy%'
         AND name NOT LIKE '%legacy_menu_copy%'`,
    )
    .all();
  if (danglingFkTables.length > 0) {
    // 与上面同理：重建期间关闭外键检查（防止 DROP/复制被悬空外键卡死），并用旧版
    // RENAME 语义防止“改回原名”这步再次改写其它表的外键定义、造成二次事故。
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("PRAGMA legacy_alter_table=ON");
    try {
      for (const { name, sql } of danglingFkTables) {
        const tempName = `${name}_fk_fix`;
        // 外键指回真实表（去掉 _legacy_menu_copy 后缀），其余定义原样保留
        const fixedSql = sql
          .replace(/"?(\w+)_legacy_menu_copy"?/gu, "$1")
          .replace(
            new RegExp(`^(CREATE\\s+TABLE\\s+)("?)${name}\\2`, "iu"),
            (_m, head) => `${head}"${tempName}"`,
          );
        const columns = db
          .prepare(`PRAGMA table_info("${name}")`)
          .all()
          .map((col) => `"${col.name}"`)
          .join(",");
        // 显式建的索引会随 DROP TABLE 一起消失，先记下 DDL 以便原样重建；
        // 自动索引（主键/UNIQUE 约束）的 sql 为 NULL，会由建表语句自动恢复。
        const indexSqls = db
          .prepare(
            `SELECT sql FROM sqlite_master
             WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`,
          )
          .all(name)
          .map((row) => row.sql);
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec(fixedSql);
          db.exec(
            `INSERT INTO "${tempName}"(${columns}) SELECT ${columns} FROM "${name}"`,
          );
          db.exec(`DROP TABLE "${name}"`);
          db.exec(`ALTER TABLE "${tempName}" RENAME TO "${name}"`);
          for (const indexSql of indexSqls) db.exec(indexSql);
          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* transaction already closed */
          }
          throw error;
        }
      }
    } finally {
      db.exec("PRAGMA legacy_alter_table=OFF");
      db.exec("PRAGMA foreign_keys=ON");
    }
  }
  addCol("activity_plan_drafts", "target_join", "INTEGER DEFAULT 12");

  // 餐饮数字员工由 restaurant.json 的 101-160 权威目录统一维护。
  // 分部级租户覆盖只改变内部任务分部，不再自动生成任何员工覆盖；因此重复迁移/重启也是幂等安全的。

  // 内容生产仓的业务值继续兼容历史 API；基础提示词必须保持行业中立且不带任何旧项目品牌。
  const promptSeeds = [
    [
      "GEN-IMG",
      "AI图片通用提示词",
      "你是餐饮品牌的商业视觉导演，服务菜品、门店、活动和员工内容场景。",
      "输出主体、场景、光线、构图、材质、镜头与负向约束；品牌、价格和食品功效信息必须以企业资料为准。",
      "真实、克制、可落地；不生成错误文字，不伪造顾客评价或经营成效。",
    ],
    [
      "GEN-VIDEO",
      "AI视频通用提示词",
      "你是餐饮品牌的视频导演，负责把菜品、门店、人物和活动转成可执行镜头。",
      "明确镜头顺序、运动、时长、主体动作、字幕建议与首尾帧；缺少事实输入时标记待确认。",
      "叙事清楚、适合真实拍摄；不虚构食品功效、价格优惠、顾客评价或经营成效。",
    ],
    [
      "GEN-PPT",
      "AIPPT结构化提示词",
      "你是餐饮经营演示文稿策划师，负责把经营数据、活动方案和复盘内容整理为可演示结构。",
      "只输出结构化JSON；每页3-5条要点，每条不超过24字；备注使用自然、清楚的提词。",
      "结论基于已提供的数据；缺失信息标为待确认，不编造金额、收益或监管结论。",
    ],
    [
      "CON-COPY-SHORT-VIDEO",
      "AI文案-短视频脚本",
      "你是餐饮短视频脚本策划，目标是用真实菜品、门店服务和人物故事建立顾客兴趣。",
      "每条脚本包含开场、画面/口播、顾客场景、事实依据、行动引导与人工复核项；不得承诺功效、最低价或虚构热销。",
      "短句、强场景、可拍摄；优先真实门店、菜品制作、员工协作和顾客已授权素材。",
    ],
    [
      "CON-COPY-MOMENTS",
      "AI文案-朋友圈文案",
      "你是餐饮门店的朋友圈经营文案员工，负责把可核验的菜品、服务和活动信息写得自然。",
      "输出种草、门店日常、活动预告和会员提醒等不同用途文案；每条有开头、正文和低压力行动引导。",
      "自然、有烟火气；价格、库存、顾客评价和活动权益必须由负责人确认。",
    ],
    [
      "CON-COPY-COMMUNITY",
      "AI文案-社群话题",
      "你是餐饮门店的社群运营员工，负责用轻话题促进真实互动，再承接人工服务。",
      "每条包含发群开场、互动问题、管理员追问和人工承接语；不得群内压单或制造虚假稀缺。",
      "轻、短、可互动；发布时间、菜品供应和活动权益均标记为待门店确认。",
    ],
    [
      "CON-COPY-INVITE",
      "AI文案-私聊邀约话术",
      "你是餐饮门店的顾客沟通辅助员工，负责把已授权顾客推进到到店、预订、活动或复购。",
      "按顾客场景输出开场、联系理由、低压力邀约和二次跟进；尊重退订与隐私边界。",
      "像真人沟通，不像强推模板；价格、座位、菜品供应和活动名额必须实时确认。",
    ],
    [
      "CON-COPY-OFFER",
      "AI文案-权益沟通话术",
      "你是餐饮门店的权益表达与风控员工，负责把已确认的会员或活动权益讲清楚。",
      "只表达已提供的适用对象、条件、有效期和确认方式；不得杜撰价格、优惠、限量、返利或保证名额。",
      "清楚、克制、可核验；所有权益以企业当前有效规则为准。",
    ],
    [
      "CON-COPY-INVESTMENT",
      "AI文案-合作推广文案",
      "你是餐饮企业的合作推广内容员工，负责说明合作场景、资源边界和沟通路径。",
      "合作身份、政策、投入和收益数字只能引用企业已提供资料；缺失项必须标记待确认，并提示人工审阅与采纳。",
      "稳重、可信、合规；先说明适配条件与流程，不承诺收益。",
    ],
    [
      "CON-COPY-REPURCHASE",
      "AI文案-会员复购文案",
      "你是餐饮门店的会员复购内容员工，负责基于已授权顾客标签和真实消费场景设计沟通。",
      "输出私信、朋友圈、方案标题和触达清单；不得伪造消费记录、偏好、评价或优惠。",
      "体面、有人情味、尊重退订；菜品供应、价格与活动信息需门店确认。",
    ],
    [
      "CON-COPY-PARTNER-PACK",
      "AI文案-员工每日素材包",
      "你是餐饮门店的内容训练与每日素材包员工，负责提供可学习、可发布、可检查的任务包。",
      "包含学习卡、朋友圈素材、短视频脚本、今日顾客服务动作与复盘项；每项注明输入依据和检查标准。",
      "动作清楚、简单可执行；外发前由负责人审核，不自动发布。",
    ],
  ];
  const insertPrompt =
    db.prepare(`INSERT INTO prompts(code,name,role_card,output_rule,style)
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
  CREATE TABLE IF NOT EXISTS agent_task_supersessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    superseded_task_id INTEGER NOT NULL,
    replacement_task_id INTEGER NOT NULL,
    superseded_output_id INTEGER NOT NULL,
    replacement_output_id INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    reason TEXT NOT NULL,
    validation_snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    CHECK(superseded_task_id <> replacement_task_id),
    CHECK(superseded_output_id <> replacement_output_id),
    UNIQUE(tenant_id,superseded_task_id)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_task_supersessions_replacement
    ON agent_task_supersessions(tenant_id,replacement_task_id,created_at);
  CREATE TRIGGER IF NOT EXISTS trg_agent_task_supersessions_no_update
    BEFORE UPDATE ON agent_task_supersessions
    BEGIN
      SELECT RAISE(ABORT,'agent_task_supersessions append-only');
    END;
  CREATE TRIGGER IF NOT EXISTS trg_agent_task_supersessions_no_delete
    BEFORE DELETE ON agent_task_supersessions
    BEGIN
      SELECT RAISE(ABORT,'agent_task_supersessions append-only');
    END;
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

  // ===== V11：多门店（连锁）——追加式列 + 默认门店回填（幂等；见 migrateMultiStore）=====
  migrateMultiStore(addCol);
}

// 多门店数据模型（连锁客户）：所有列可空、默认回落，单店客户零感知。
// - users.store_id：NULL=总部/全店；stores.is_default：每租户至多一家默认门店。
// - 业务表 store_id：历史 NULL 行回填为该租户默认门店（只对已有业务数据的租户创建默认店；
//   空白新租户在首次写入时由 engines/store-scope.js 的 defaultStoreId() 懒创建，不打扰开店向导）。
// - store_checklist_marks / delivery_daily / inventory_items 的 UNIQUE 原本按租户唯一，多店会互相冲突，
//   首次迁移时重建为「租户+门店」复合唯一（以 store_id 列缺失作为一次性触发条件）。
const MULTI_STORE_TABLES = Object.freeze([
  "orders",
  "costs",
  "tasks",
  "store_inspections",
  "store_checklist_marks",
  "dish_soldout_marks",
  "shift_assignments",
  "attendance_records",
  "inventory_items",
  "inventory_moves",
  "delivery_daily",
  "daily_ops",
  "store_reviews",
]);
function migrateMultiStore(addCol) {
  addCol("users", "store_id", "INTEGER");
  addCol("stores", "code", "TEXT");
  addCol("stores", "is_default", "INTEGER DEFAULT 0");
  addCol("stores", "region", "TEXT");
  addCol("stores", "manager_user_id", "INTEGER");
  addCol("stores", "status", "TEXT DEFAULT '营业中'");

  const hasCol = (table, col) =>
    db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .some((item) => item.name === col);
  // UNIQUE 需包含 store_id 的三张表：仅在 store_id 列尚不存在时重建一次（新库此时表刚建好、为空）
  const rebuildWithStore = (table, columnsSql, copyCols, indexSql) => {
    if (hasCol(table, "store_id")) return;
    db.exec(`
      DROP TABLE IF EXISTS ${table}__ms;
      CREATE TABLE ${table}__ms (${columnsSql});
      INSERT INTO ${table}__ms (${copyCols},store_id) SELECT ${copyCols},NULL FROM ${table};
      DROP TABLE ${table};
      ALTER TABLE ${table}__ms RENAME TO ${table};
      ${indexSql}
    `);
  };
  rebuildWithStore(
    "store_checklist_marks",
    `id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, date TEXT NOT NULL,
     checklist_key TEXT NOT NULL, item_key TEXT NOT NULL, done_by INTEGER, done_by_name TEXT, note TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), store_id INTEGER,
     UNIQUE(tenant_id, store_id, date, checklist_key, item_key)`,
    "id,tenant_id,date,checklist_key,item_key,done_by,done_by_name,note,created_at",
    "CREATE INDEX IF NOT EXISTS idx_checklist_marks_tenant_date ON store_checklist_marks(tenant_id, date);",
  );
  rebuildWithStore(
    "delivery_daily",
    `id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, date TEXT NOT NULL, platform TEXT NOT NULL,
     orders INTEGER NOT NULL DEFAULT 0, revenue REAL NOT NULL DEFAULT 0, rating REAL, avg_prep_minutes REAL,
     bad_reviews INTEGER NOT NULL DEFAULT 0, recorded_by INTEGER,
     updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), store_id INTEGER,
     UNIQUE(tenant_id, store_id, date, platform)`,
    "id,tenant_id,date,platform,orders,revenue,rating,avg_prep_minutes,bad_reviews,recorded_by,updated_at",
    "CREATE INDEX IF NOT EXISTS idx_delivery_daily_tenant_date ON delivery_daily(tenant_id, date);",
  );
  rebuildWithStore(
    "inventory_items",
    `id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, name TEXT NOT NULL, category TEXT,
     unit TEXT NOT NULL DEFAULT '份', quantity REAL NOT NULL DEFAULT 0, safe_line REAL NOT NULL DEFAULT 0,
     updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), updated_by_name TEXT, store_id INTEGER,
     UNIQUE(tenant_id, store_id, name)`,
    "id,tenant_id,name,category,unit,quantity,safe_line,updated_at,updated_by_name",
    "",
  );
  for (const table of MULTI_STORE_TABLES) addCol(table, "store_id", "INTEGER");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_tenant_store ON users(tenant_id, store_id);
    CREATE INDEX IF NOT EXISTS idx_stores_tenant_default ON stores(tenant_id, is_default);
    CREATE INDEX IF NOT EXISTS idx_orders_tenant_store_created ON orders(tenant_id, store_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_tenant_store ON tasks(tenant_id, store_id);
  `);

  // 回填：按租户循环（每条 SQL 都带 tenant_id 条件）。
  const tenants = db.prepare("SELECT id, name FROM tenants ORDER BY id").all();
  const firstStore = db.prepare(
    "SELECT id FROM stores WHERE tenant_id=? ORDER BY is_default DESC, id LIMIT 1",
  );
  const hasDefault = db.prepare(
    "SELECT id FROM stores WHERE tenant_id=? AND is_default=1 ORDER BY id LIMIT 1",
  );
  const orphanCounters = MULTI_STORE_TABLES.map((table) =>
    db.prepare(
      `SELECT COUNT(*) n FROM ${table} WHERE tenant_id=? AND store_id IS NULL`,
    ),
  );
  const backfillers = MULTI_STORE_TABLES.map((table) =>
    db.prepare(
      `UPDATE ${table} SET store_id=? WHERE tenant_id=? AND store_id IS NULL`,
    ),
  );
  for (const tenant of tenants) {
    let defaultId = hasDefault.get(tenant.id)?.id ?? null;
    if (!defaultId) {
      const first = firstStore.get(tenant.id);
      if (first) {
        db.prepare(
          "UPDATE stores SET is_default=1 WHERE tenant_id=? AND id=?",
        ).run(tenant.id, first.id);
        defaultId = first.id;
      }
    }
    const orphanRows = orphanCounters.reduce(
      (sum, stmt) => sum + Number(stmt.get(tenant.id)?.n || 0),
      0,
    );
    if (!orphanRows) continue;
    if (!defaultId) {
      // 有历史业务数据却没有门店的老租户：建一家默认门店承接（名称=企业名，兜底「总店」）
      defaultId = Number(
        db
          .prepare(
            `INSERT INTO stores(tenant_id,name,is_default,biz_type,status)
             VALUES(?,?,1,'快餐','营业中')`,
          )
          .run(tenant.id, String(tenant.name || "").trim() || "总店")
          .lastInsertRowid,
      );
    }
    for (const stmt of backfillers) stmt.run(defaultId, tenant.id);
  }
}

// 内部任务分部：全局基线 + 当前租户覆盖合并
export function mergeMarshal(base) {
  if (!base) return base;
  const ov = db
    .prepare(
      "SELECT * FROM tenant_marshal_overrides WHERE tenant_id=? AND marshal_code=?",
    )
    .get(curTenant(), base.code);
  if (ov)
    for (const k of [
      "name",
      "title",
      "duty",
      "skills",
      "prompt",
      "kb_deps",
      "online",
      "synced_at",
    ])
      if (ov[k] != null && ov[k] !== "") base[k] = ov[k];
  return base;
}
export function mergeMarshals(rows) {
  return rows.map(mergeMarshal);
}
export function mergeSpecialist(base) {
  if (!base) return base;
  const ov = db
    .prepare(
      "SELECT name,duty,active FROM tenant_specialist_overrides WHERE tenant_id=? AND specialist_id=?",
    )
    .get(curTenant(), base.id);
  if (!ov) return base;
  return {
    ...base,
    name: ov.name || base.name,
    duty: ov.duty || base.duty,
    active: ov.active == null ? 1 : ov.active,
  };
}
export function mergeSpecialists(rows) {
  return rows.map(mergeSpecialist).filter((item) => item.active !== 0);
}
export function specialistsForMarshal(marshalId) {
  return mergeSpecialists(
    db
      .prepare(
        "SELECT id,marshal_id,name,duty,status,last_output_id FROM specialists WHERE marshal_id=? ORDER BY id",
      )
      .all(marshalId),
  );
}
// 提示词：当前租户覆盖（无则 null，调用方回退全局）
export function promptOverride(code) {
  return (
    db
      .prepare(
        "SELECT role_card, output_rule, style FROM tenant_prompt_overrides WHERE tenant_id=? AND code=?",
      )
      .get(curTenant(), code) || null
  );
}

// 解析用户可见模块：用户级覆盖 > （角色默认 ∪ 员工部门追加），再 ∩ 租户开通模块
export function modulesFor(user) {
  const row = db
    .prepare("SELECT modules, dept, role, tenant_id FROM users WHERE id = ?")
    .get(user.id);
  const role = row?.role || user.role;
  const tid = row?.tenant_id ?? user.tenant_id ?? 1; // 用用户真实租户读权限（登录态 curTenant 尚未就绪，不能用它）
  const matrix = getTenantConfig("role_modules", {}, tid);
  let mods;
  if (row?.modules) {
    try {
      mods = JSON.parse(row.modules);
    } catch {
      /* fallthrough */
    }
  }
  if (!mods) {
    // `manager` 是系统允许创建且在各业务路由中被认作管理层的正式角色。
    // 历史租户的角色矩阵可能尚未写入 manager；仅在缺省时继承
    // ops_director，显式配置（包括刻意收窄为 []）必须原样生效。
    const base = Object.prototype.hasOwnProperty.call(matrix, role)
      ? matrix[role]
      : role === "manager" &&
          Object.prototype.hasOwnProperty.call(matrix, "ops_director")
        ? matrix.ops_director
        : ["dashboard"];
    if (role === "sales") {
      const deptMap = getTenantConfig("dept_modules", {}, tid);
      const extra = deptMap[row?.dept || user.dept] || [];
      mods = [...new Set([...base, ...extra])];
    } else mods = base;
  }
  // 平台超管不受租户模块限制（跨租户运维）
  if (role === "platform_super") return mods;
  // 租户开通模块作为上限（NULL=全部开通；本公司租户1不限制）
  const t = db.prepare("SELECT modules FROM tenants WHERE id = ?").get(tid);
  if (t?.modules) {
    try {
      const allow = JSON.parse(t.modules);
      mods = mods.filter((m) => allow.includes(m));
    } catch {
      /* keep */
    }
  }
  return mods;
}

// 租户辅助：按用户/租户读取，供计费池与鉴权使用
export function tenantOf(userId) {
  return (
    db.prepare("SELECT tenant_id FROM users WHERE id = ?").get(userId)
      ?.tenant_id ?? null
  );
}
export function getTenant(tenantId) {
  return db.prepare("SELECT * FROM tenants WHERE id = ?").get(tenantId);
}

export function getConfig(key, dflt) {
  const row = q.get("SELECT value FROM sys_config WHERE key = ?", key);
  if (!row) return dflt;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}
export function setConfig(key, value) {
  q.run(
    "INSERT INTO sys_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    key,
    JSON.stringify(value),
  );
}

// ===== 租户级配置（覆盖层）：每家企业可自定义经营系数，未设则回退平台默认（seed 写的全局值）=====
// 存储为 `key:租户id`；读取顺序：本租户覆盖 → 平台默认(全局 key) → dflt。tid 可显式传入（登录态 curTenant 尚未就绪时用用户真实租户）。
export function getTenantConfig(key, dflt, tid = curTenant()) {
  const own = q.get(
    "SELECT value FROM sys_config WHERE key = ?",
    `${key}:${tid}`,
  );
  if (own) {
    try {
      return JSON.parse(own.value);
    } catch {
      return own.value;
    }
  }
  return getConfig(key, dflt);
}
export function setTenantConfig(key, value, tid = curTenant()) {
  setConfig(`${key}:${tid}`, value);
}

// ===== 默认年度套餐（2026-09-09 成都招商会敲定；本次只做这一档，字段预留扩展）=====
// 价格单位与 recharge_packages.price_yuan 一致（元）；credits=0 表示不含积分，按用量另行充值；
// bonusCredits 为本次套餐额外赠送、在套餐生效时作为独立 bonus 流水入账。
export const DEFAULT_PLAN_PACKAGE = Object.freeze({
  code: "restaurant_annual_v1",
  name: "餐饮版年度套餐",
  kind: "plan",
  priceYuan: 9800,
  credits: 0,
  bonusCredits: 60000,
  seatLimit: 5,
  validDays: 365,
  tag: "年度",
  sort: 0,
  features: Object.freeze({ roles: ["boss", "ops_director", "sales"], note: "含老板/管理层/员工账号" }),
});
