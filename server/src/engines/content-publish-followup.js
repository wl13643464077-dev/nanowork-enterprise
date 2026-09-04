// 合规半自动分发（B6）：排期提醒 / 一键复制发布包 / T+1/3/7 催复盘 / 内容级数据回填。
//
// 宣讲纪要：自动分发已暂停，避免被小红书等平台判定违规。本模块只做三件事——
//   1. 到期提醒人工去发（不调用任何平台 API、不代发）；
//   2. 把分发官产物或正文整理成可复制的发布包（不编造字段，拿不到给 null）；
//   3. 发布后按 T+1/3/7 催人回填真实数据，回填后停止；不自动扣费跑复盘。
// 幂等台账：content_publish_followups(kind='schedule_due' day=0 | kind='followup' day∈{1,3,7})。
import { q, curTenant } from '../db.js';
import { notify, safeJsonParse } from '../util.js';
import { xhsVersionId } from './content-xhs-output.js';

export const PUBLISH_FOLLOWUP_DAYS = Object.freeze([1, 3, 7]);
export const PUBLISH_CHANNEL_MAX_LENGTH = 40;
export const PUBLISH_SCHEDULE_MAX_DAYS_AHEAD = 366;
// 只对最近 14 天内的发布做催复盘：功能上线时不给几个月前的旧发布补发 T+7。
export const PUBLISH_FOLLOWUP_WINDOW_DAYS = 14;
export const PUBLISH_METRIC_KEYS = Object.freeze(['views', 'likes', 'saves', 'comments', 'orders']);
export const PUBLISH_METRIC_MAX = 1_000_000_000;
export const PUBLISH_METRICS_NOTE_MAX_LENGTH = 500;
const NOTIFICATION_TYPE = 'content_publish';
const IMAGE_MATERIAL_TYPES = new Set(['产品图', '海报', '图片', 'AI图片', 'Logo']);
const HASHTAG_RE = /#([^\s#，。！？、,.!?；;：:()（）【】\[\]]{1,30})/gu;
const DAY_MS = 86_400_000;

function httpError(message, status = 400, code = null) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function tenantIdOf(explicit) {
  const value = Number(explicit);
  return Number.isInteger(value) && value > 0 ? value : curTenant();
}

// SQLite datetime('now','localtime') 写出的 'YYYY-MM-DD HH:MM:SS' 按本机本地时间解析。
export function parseDbLocalTime(value) {
  if (!value) return null;
  const text = String(value).trim();
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/u.test(text) ? text.replace(' ', 'T') : text);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function isoOrNull(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function contentTitle(content) {
  return String(content?.title || content?.topic || `内容#${content?.id}`).trim().slice(0, 60);
}

const ATTRIBUTION_SCHEMA = 'nanowork.content-publish-attribution/1';
const unknownAttribution = () => ({ schema: ATTRIBUTION_SCHEMA, source: 'legacy_unknown', versionId: null, strategy: null, employeeIdx: null, sourceRunId: null });

function legacySingleStrategy(snapshot) {
  // 不能从现在的 xhsSelection 推断旧日志曾发过哪个版本。
  if (snapshot?.xhsOutput) return null;
  const parsed = snapshot?.contract?.parsedOutput;
  const versions = Array.isArray(parsed?.versions) ? parsed.versions : null;
  return versions && versions.length !== 1 ? null : cleanText(versions ? versions[0]?.strategy : parsed?.strategy, 80) || null;
}

export function readPublishAttribution(raw) {
  const parsed = safeJsonParse(raw, null);
  if (!isPlainObject(parsed) || parsed.schema !== ATTRIBUTION_SCHEMA
    || !['xhs_selected', 'legacy_single', 'unversioned', 'legacy_unknown'].includes(parsed.source)) return unknownAttribution();
  if (parsed.source === 'xhs_selected' && (!/^xhs-[a-f0-9]{24}$/u.test(parsed.versionId || '') || !cleanText(parsed.strategy, 80))) return unknownAttribution();
  return {
    schema: ATTRIBUTION_SCHEMA, source: parsed.source,
    versionId: parsed.source === 'xhs_selected' ? parsed.versionId : null,
    strategy: ['xhs_selected', 'legacy_single'].includes(parsed.source) ? cleanText(parsed.strategy, 80) || null : null,
    employeeIdx: Number.isInteger(parsed.employeeIdx) && parsed.employeeIdx >= 0 && parsed.employeeIdx <= 10 ? parsed.employeeIdx : null,
    sourceRunId: Number.isSafeInteger(parsed.sourceRunId) && parsed.sourceRunId > 0 ? parsed.sourceRunId : null,
  };
}

export function captureContentPublishAttribution(content) {
  const snapshot = safeJsonParse(content.snapshot_json, null);
  const result = {
    ...unknownAttribution(), source: 'unversioned',
    employeeIdx: Number.isInteger(content.content_employee_idx) ? content.content_employee_idx : null,
    sourceRunId: content.source_type === 'content_employee_run' && Number(content.source_id) > 0 ? Number(content.source_id) : null,
  };
  if (snapshot?.xhsOutput) {
    const selected = Array.isArray(snapshot.xhsOutput.versions)
      ? snapshot.xhsOutput.versions.find(version => xhsVersionId(version) === snapshot.xhsSelection?.versionId) : null;
    if (!selected || !selected.strategy) throw httpError('请先选择有效的小红书发布版本', 409);
    return { ...result, source: 'xhs_selected', versionId: xhsVersionId(selected), strategy: selected.strategy };
  }
  const strategy = legacySingleStrategy(snapshot);
  return strategy ? { ...result, source: 'legacy_single', strategy } : result;
}

function bossIds(tenantId) {
  return q
    .all(`SELECT id FROM users WHERE tenant_id=? AND role='boss' AND status='启用' ORDER BY id`, tenantId)
    .map(row => Number(row.id));
}

function uniqueUserIds(list) {
  return [...new Set(list.map(Number).filter(id => Number.isInteger(id) && id > 0))];
}

function notifyMany(userIds, title, body, link) {
  for (const userId of userIds) notify(userId, NOTIFICATION_TYPE, title, body, link);
  return userIds;
}

export function publishAssistantLink(contentId, tab) {
  return `/content?publishAssistant=${Number(contentId)}${tab ? `&assistantTab=${tab}` : ''}`;
}

// ===== 排期 =====

export function normalizePublishSchedule(body, { now = new Date() } = {}) {
  if (!isPlainObject(body)) throw httpError('请求体必须是对象');
  const rawAt = body.scheduledAt;
  if (rawAt === null || rawAt === '' || rawAt === undefined) {
    return { scheduledAt: null, channel: null, cleared: true };
  }
  const parsed = typeof rawAt === 'string' || typeof rawAt === 'number' ? Date.parse(String(rawAt)) : Number.NaN;
  if (!Number.isFinite(parsed)) throw httpError('排期时间格式无效，请使用 ISO-8601 时间');
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (parsed < nowMs - 5 * 60_000) throw httpError('排期时间不能早于当前时间');
  if (parsed > nowMs + PUBLISH_SCHEDULE_MAX_DAYS_AHEAD * DAY_MS) {
    throw httpError(`排期时间不能晚于 ${PUBLISH_SCHEDULE_MAX_DAYS_AHEAD} 天以后`);
  }
  const channel = typeof body.channel === 'string' ? body.channel.trim() : '';
  if (!channel) throw httpError('请填写目标平台/渠道');
  if (channel.length > PUBLISH_CHANNEL_MAX_LENGTH) {
    throw httpError(`目标平台名称不能超过${PUBLISH_CHANNEL_MAX_LENGTH}个字符`);
  }
  return { scheduledAt: new Date(parsed).toISOString(), channel, cleared: false };
}

/**
 * 写入排期。重新排期会清掉上一次的到期提醒台账，让新时间到期时再提醒一次。
 */
export function saveContentPublishSchedule(content, schedule, { tenantId } = {}) {
  const tid = tenantIdOf(tenantId);
  q.run(
    `UPDATE contents SET scheduled_publish_at=?,publish_channel=? WHERE tenant_id=? AND id=?`,
    schedule.scheduledAt,
    schedule.channel,
    tid,
    content.id,
  );
  q.run(
    `DELETE FROM content_publish_followups WHERE tenant_id=? AND content_id=? AND kind='schedule_due'`,
    tid,
    content.id,
  );
  return {
    contentId: Number(content.id),
    scheduledAt: schedule.scheduledAt,
    channel: schedule.channel,
    cleared: schedule.cleared === true,
  };
}

/**
 * 到期未登记发布的排期 → 给内容创建者发一次站内通知（幂等：schedule_due 台账）。
 * 每个调度 tick 调用；无排期时是一条索引命中的空查询。
 */
export function runContentPublishScheduleReminders({ tenantId, now = new Date() } = {}) {
  const tid = tenantIdOf(tenantId);
  const nowIso = isoOrNull(now) || new Date().toISOString();
  const due = q.all(
    `SELECT c.id,c.title,c.topic,c.creator_id,c.publish_channel,c.scheduled_publish_at
    FROM contents c
    WHERE c.tenant_id=? AND c.scheduled_publish_at IS NOT NULL AND c.scheduled_publish_at<=?
      AND NOT EXISTS (
        SELECT 1 FROM content_publish_followups f
        WHERE f.tenant_id=c.tenant_id AND f.content_id=c.id AND f.kind='schedule_due'
      )
    ORDER BY c.scheduled_publish_at,c.id
    LIMIT 200`,
    tid,
    nowIso,
  );
  const reminded = [];
  for (const content of due) {
    // 排期前一天以内或之后已有发布登记 → 视为已发，不再提醒（旧发布不影响新排期）。
    const scheduledMs = Date.parse(content.scheduled_publish_at);
    const publishedSince = q
      .all(`SELECT created_at FROM content_publish_logs WHERE tenant_id=? AND content_id=?`, tid, content.id)
      .some(log => {
        const at = parseDbLocalTime(log.created_at);
        return at && at.getTime() >= scheduledMs - DAY_MS;
      });
    if (publishedSince) {
      q.run(
        `INSERT OR IGNORE INTO content_publish_followups(tenant_id,content_id,kind,day,notified_user_ids)
        VALUES(?,?,'schedule_due',0,'[]')`,
        tid,
        content.id,
      );
      continue;
    }
    const recipients = uniqueUserIds(content.creator_id ? [content.creator_id] : bossIds(tid));
    const claimed = q.run(
      `INSERT OR IGNORE INTO content_publish_followups(tenant_id,content_id,kind,day,notified_user_ids)
      VALUES(?,?,'schedule_due',0,?)`,
      tid,
      content.id,
      JSON.stringify(recipients),
    );
    if (!claimed.changes) continue;
    const channel = content.publish_channel || '目标平台';
    notifyMany(
      recipients,
      `《${contentTitle(content)}》该发到${channel}了，点此复制文案`,
      `排期时间已到。系统不会代你发布：打开发布助手一键复制发布包，发完后回来点“我已发布，去登记”。`,
      publishAssistantLink(content.id, 'pack'),
    );
    reminded.push({ contentId: Number(content.id), channel, recipients });
  }
  return reminded;
}

// ===== 发布包 =====

function distributorVersions(snapshot) {
  const contract = isPlainObject(snapshot?.contract) ? snapshot.contract : null;
  if (!contract) return null;
  const parsed = contract.parsedOutput;
  if (Array.isArray(parsed?.versions) && parsed.versions.length) return parsed.versions;
  const artifact = (Array.isArray(contract.artifacts) ? contract.artifacts : [])
    .find(item => item?.kind === 'publish_packages' && typeof item.content === 'string');
  if (artifact) {
    const json = safeJsonParse(artifact.content, null);
    if (Array.isArray(json?.versions) && json.versions.length) return json.versions;
  }
  return null;
}

function cleanText(value, max) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function cleanStringList(value, max = 20) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => (typeof item === 'string' ? item.trim().replace(/^#/u, '') : ''))
    .filter(Boolean)
    .slice(0, max);
}

export function extractHashtags(text) {
  const seen = new Set();
  for (const match of String(text || '').matchAll(HASHTAG_RE)) {
    const tag = match[1].trim();
    if (tag && !seen.has(tag)) seen.add(tag);
    if (seen.size >= 20) break;
  }
  return [...seen];
}

function copyTextFor({ title, body, hashtags }) {
  const tags = hashtags.length ? hashtags.map(tag => `#${tag}`).join(' ') : '';
  return [title, body, tags].filter(Boolean).join('\n\n');
}

function contentImages(contentId, tid) {
  return q
    .all(
      `SELECT m.id,m.name,m.type,m.url
      FROM content_material_refs ref
      JOIN materials m ON m.tenant_id=ref.tenant_id AND m.id=ref.material_id
      WHERE ref.tenant_id=? AND ref.target_type='content' AND ref.target_id=?
      ORDER BY ref.id`,
      tid,
      contentId,
    )
    .filter(row => IMAGE_MATERIAL_TYPES.has(String(row.type || '')) && typeof row.url === 'string' && row.url.trim())
    .map(row => ({ id: Number(row.id), name: row.name || null, type: row.type || null, url: row.url }));
}

/**
 * 按平台整理的发布包。分发官（idx 8）产物存在时复用其 versions；否则用正文组装。
 * 分发官契约没有“首评”字段，firstComment 恒为 null，不编造。
 */
export function buildContentPublishPack(content, { tenantId } = {}) {
  const tid = tenantIdOf(tenantId);
  const snapshot = safeJsonParse(content.snapshot_json, {}) || {};
  const images = contentImages(content.id, tid);
  const versions = distributorVersions(snapshot);
  const fallbackPlatform = cleanText(content.publish_channel, PUBLISH_CHANNEL_MAX_LENGTH)
    || cleanText(content.channel, PUBLISH_CHANNEL_MAX_LENGTH);
  let packs;
  let source;
  if (isPlainObject(snapshot.xhsOutput)) {
    const chosen = snapshot.xhsOutput.versions?.find(version => xhsVersionId(version) === snapshot.xhsSelection?.versionId);
    if (!chosen) throw httpError('请先选择有效的小红书发布版本', 409);
    source = 'xhs_selected';
    const hashtags = cleanStringList(chosen.tags);
    packs = [{
      platform: '小红书', versionId: snapshot.xhsSelection.versionId, strategy: chosen.strategy,
      title: chosen.title, coverText: chosen.cover_text, body: chosen.body, hashtags,
      firstComment: chosen.comment_prompt, images, imagePlan: snapshot.xhsOutput.image_plan,
      bestTime: null, checklist: ['核对门店事实', '确认图片授权', '核对AI辅助创作标注'],
      note: chosen.self_score.note,
      copyText: copyTextFor({ title: chosen.title, body: chosen.body, hashtags }),
    }];
  } else if (versions) {
    source = 'distributor';
    packs = versions.map(version => {
      const title = cleanText(version?.title, 300);
      const body = cleanText(version?.body, 20_000);
      const hashtags = cleanStringList(version?.tags);
      return {
        platform: cleanText(version?.platform, PUBLISH_CHANNEL_MAX_LENGTH),
        title,
        body,
        hashtags,
        firstComment: null,
        images,
        bestTime: cleanText(version?.best_time, 200),
        checklist: cleanStringList(version?.checklist, 10),
        note: cleanText(version?.note, 2_000),
        copyText: copyTextFor({ title, body, hashtags }),
      };
    });
  } else {
    source = 'content';
    const title = cleanText(content.title, 300);
    const body = cleanText(content.body, 20_000);
    const hashtags = extractHashtags(body);
    packs = [{
      platform: fallbackPlatform,
      title,
      body,
      hashtags,
      firstComment: null,
      images,
      bestTime: null,
      checklist: [],
      note: null,
      copyText: copyTextFor({ title, body, hashtags }),
    }];
  }
  return {
    contentId: Number(content.id),
    title: contentTitle(content),
    source,
    schedule: {
      scheduledAt: content.scheduled_publish_at || null,
      channel: content.publish_channel || null,
    },
    packs,
    disclaimer: '发布包由你手动复制到平台发布；系统不代发、不操作账号。字段取不到时为 null，不会补造。',
  };
}

// ===== T+1/3/7 催复盘 =====

function firstPublishLogs(tid, { sinceDays = PUBLISH_FOLLOWUP_WINDOW_DAYS, now = new Date() } = {}) {
  const nowIso = isoOrNull(now) || new Date().toISOString();
  return q.all(
    `SELECT l.content_id,MIN(l.id) AS log_id,MIN(l.created_at) AS published_at,
      c.title,c.topic,c.creator_id,c.publish_channel,c.channel
    FROM content_publish_logs l
    JOIN contents c ON c.tenant_id=l.tenant_id AND c.id=l.content_id
    WHERE l.tenant_id=? AND l.created_at>=datetime(?,'localtime',?) AND l.created_at<=datetime(?,'localtime')
    GROUP BY l.content_id
    ORDER BY published_at,l.content_id
    LIMIT 500`,
    tid,
    nowIso,
    `-${Math.max(1, Number(sinceDays) || PUBLISH_FOLLOWUP_WINDOW_DAYS)} days`,
    nowIso,
  );
}

function metricsCount(tid, contentId) {
  return Number(q.get(
    `SELECT COUNT(*) n FROM content_publish_metrics WHERE tenant_id=? AND content_id=?`,
    tid,
    contentId,
  )?.n || 0);
}

function registrantOf(tid, logId) {
  const row = q.get(`SELECT created_by FROM content_publish_logs WHERE tenant_id=? AND id=?`, tid, logId);
  return row?.created_by == null ? null : Number(row.created_by);
}

export function followupDaysDue(publishedAt, now) {
  const base = publishedAt instanceof Date ? publishedAt : parseDbLocalTime(publishedAt);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!base || !Number.isFinite(nowMs)) return [];
  const elapsedDays = Math.floor((nowMs - base.getTime()) / DAY_MS);
  return PUBLISH_FOLLOWUP_DAYS.filter(day => elapsedDays >= day);
}

/**
 * 每日 10:00（上海时钟）由调度器 runOnce('publish_followup:<date>') 调用。
 * 对发布后第 1/3/7 天且尚未回填效果数据的内容，各通知一次登记人与老板；
 * 调度器停机漏掉的低档只补台账不补通知，避免一次连发三条。回填后停止。
 */
export function runContentPublishFollowups({ tenantId, now = new Date() } = {}) {
  const tid = tenantIdOf(tenantId);
  const sent = [];
  for (const row of firstPublishLogs(tid, { now })) {
    if (metricsCount(tid, row.content_id) > 0) continue;
    const dueDays = followupDaysDue(row.published_at, now);
    if (!dueDays.length) continue;
    const target = dueDays.at(-1);
    const already = q.get(
      `SELECT 1 FROM content_publish_followups WHERE tenant_id=? AND content_id=? AND kind='followup' AND day=?`,
      tid,
      row.content_id,
      target,
    );
    if (already) continue;
    const recipients = uniqueUserIds([registrantOf(tid, row.log_id), row.creator_id, ...bossIds(tid)]);
    for (const day of dueDays) {
      q.run(
        `INSERT OR IGNORE INTO content_publish_followups(tenant_id,content_id,kind,day,publish_log_id,notified_user_ids)
        VALUES(?,?,'followup',?,?,?)`,
        tid,
        row.content_id,
        day,
        row.log_id,
        JSON.stringify(day === target ? recipients : []),
      );
    }
    notifyMany(
      recipients,
      `《${contentTitle(row)}》发布已 ${target} 天，回填浏览/点赞/收藏数，复盘官才能帮你分析下一篇`,
      `发布渠道：${row.publish_channel || row.channel || '未记录'}。点此打开发布助手回填数据；回填后不会自动扣费跑复盘，由你决定是否派复盘官。`,
      publishAssistantLink(row.content_id, 'metrics'),
    );
    sent.push({ contentId: Number(row.content_id), day: target, recipients });
  }
  return sent;
}

// ===== 数据回填 =====

function nonNegativeInt(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw httpError(`${label}必须是非负整数`);
  }
  if (value > PUBLISH_METRIC_MAX) throw httpError(`${label}不能超过${PUBLISH_METRIC_MAX}`);
  return value;
}

export function normalizePublishMetrics(body) {
  if (!isPlainObject(body)) throw httpError('请求体必须是对象');
  const labels = { views: '浏览量', likes: '点赞数', saves: '收藏数', comments: '评论数', orders: '订单数' };
  const metrics = {};
  for (const key of PUBLISH_METRIC_KEYS) metrics[key] = nonNegativeInt(body[key], labels[key]);
  let screenshotFileId = null;
  if (body.screenshotFileId !== undefined && body.screenshotFileId !== null && body.screenshotFileId !== '') {
    if (!Number.isInteger(body.screenshotFileId) || body.screenshotFileId <= 0) {
      throw httpError('截图文件编号无效');
    }
    screenshotFileId = body.screenshotFileId;
  }
  const hasMetric = PUBLISH_METRIC_KEYS.some(key => metrics[key] !== null);
  if (!hasMetric && !screenshotFileId) throw httpError('请至少填写一项平台数据或上传一张数据截图');
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, PUBLISH_METRICS_NOTE_MAX_LENGTH) : '';
  const channel = typeof body.channel === 'string' && body.channel.trim()
    ? body.channel.trim().slice(0, PUBLISH_CHANNEL_MAX_LENGTH)
    : null;
  return { ...metrics, screenshotFileId, note, channel };
}

/**
 * 内容级数据回填：写 content_publish_metrics，标记 manual_unverified，
 * 通知老板/创建者“可派复盘官分析”（不自动扣费）。与流水线级 metrics 独立。
 */
export function recordContentPublishMetrics(content, values, actor, { tenantId } = {}) {
  const tid = tenantIdOf(tenantId);
  content = q.get('SELECT * FROM contents WHERE tenant_id=? AND id=?', tid, content.id);
  if (!content) throw httpError('内容不存在或不属于本企业', 404);
  if (values.screenshotFileId) {
    const file = q.get(
      `SELECT id,user_id,mime,ext FROM uploaded_files WHERE tenant_id=? AND id=?`,
      tid,
      values.screenshotFileId,
    );
    if (!file) throw httpError('截图文件不存在或不属于本企业', 404);
    const isImage = /^image\//iu.test(String(file.mime || '')) || /^(png|jpe?g|webp|gif)$/iu.test(String(file.ext || ''));
    if (!isImage) throw httpError('截图必须是图片文件');
  }
  const latestLog = q.get(
    `SELECT id,channel,attribution_json FROM content_publish_logs WHERE tenant_id=? AND content_id=?
      AND (? IS NULL OR channel=?) ORDER BY created_at DESC,id DESC LIMIT 1`,
    tid,
    content.id,
    values.channel, values.channel,
  );
  const anyLog = q.get('SELECT id FROM content_publish_logs WHERE tenant_id=? AND content_id=? LIMIT 1', tid, content.id);
  if (anyLog && !latestLog) throw httpError('该渠道没有发布登记，请先登记对应渠道再回填数据', 409, 'CONTENT_PUBLISH_CHANNEL_REQUIRED');
  if (!anyLog && content.status !== '已发布') throw httpError('请先登记发布再回填数据', 409, 'CONTENT_PUBLISH_LOG_REQUIRED');
  const attribution = readPublishAttribution(latestLog?.attribution_json);
  const inserted = q.run(
    `INSERT INTO content_publish_metrics(
      tenant_id,content_id,publish_log_id,channel,views,likes,saves,comments,orders,screenshot_file_id,note,verification,created_by,attribution_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'manual_unverified',?,?)`,
    tid,
    content.id,
    latestLog?.id ?? null,
    values.channel || latestLog?.channel || content.publish_channel || content.channel || null,
    values.views,
    values.likes,
    values.saves,
    values.comments,
    values.orders,
    values.screenshotFileId,
    values.note,
    actor.id,
    JSON.stringify(attribution),
  );
  const metricId = Number(inserted.lastInsertRowid);
  const registrant = latestLog ? registrantOf(tid, latestLog.id) : null;
  let recipients = uniqueUserIds([content.creator_id, registrant, ...bossIds(tid)]).filter(id => id !== Number(actor.id));
  if (!recipients.length) recipients = uniqueUserIds([actor.id]);
  const filled = PUBLISH_METRIC_KEYS.filter(key => values[key] !== null).map(key => `${key}=${values[key]}`).join('，');
  notifyMany(
    recipients,
    `《${contentTitle(content)}》已回填发布数据，可派复盘官分析`,
    `${actor.name || '同事'}回填：${filled || '仅截图'}${values.screenshotFileId ? '（附数据截图）' : ''}。数据为人工录入、平台未核验；需要复盘时请手动派复盘官，系统不会自动扣费。`,
    publishAssistantLink(content.id, 'timeline'),
  );
  return { metricId, recipients, publishLogId: latestLog?.id ?? null, attribution };
}

// 同篇内容在同渠道的多次回填是累计快照，不能把 T+1/T+3/T+7 相加。
// 旧记录只有单一明确策略时才可归因；多版本未选定时保留未知，不猜“获胜版本”。
export function contentStrategyMetricsSummary(tenantId, { days = 30, employeeIdx = null } = {}) {
  const tid = tenantIdOf(tenantId);
  if (employeeIdx !== null && (!Number.isInteger(employeeIdx) || employeeIdx < 0 || employeeIdx > 10)) {
    throw httpError('内容员工编号必须在0-10之间');
  }
  const windowDays = Math.min(366, Math.max(1, Math.trunc(Number(days) || 30)));
  const rows = q.all(
    `WITH snapshots AS (
      SELECT m.content_id,m.channel,m.views,m.likes,m.saves,m.comments,m.attribution_json,c.snapshot_json,c.content_employee_idx,
        ROW_NUMBER() OVER (
          PARTITION BY m.content_id,COALESCE(m.channel,''),
            CASE WHEN json_valid(m.attribution_json) THEN json_extract(m.attribution_json,'$.versionId') ELSE NULL END
          ORDER BY m.created_at DESC,m.id DESC
        ) AS position
      FROM content_publish_metrics m
      JOIN contents c ON c.tenant_id=m.tenant_id AND c.id=m.content_id
      WHERE m.tenant_id=?
        AND m.created_at>=datetime('now','localtime',?)
        AND m.created_at<=datetime('now','localtime')
    ) SELECT * FROM snapshots WHERE position=1`,
    tid, `-${windowDays} days`,
  );
  const groups = new Map();
  for (const row of rows) {
    const attribution = readPublishAttribution(row.attribution_json);
    const ownerIdx = row.attribution_json == null ? row.content_employee_idx : attribution.employeeIdx;
    if (employeeIdx !== null && ownerIdx !== employeeIdx) continue;
    const strategy = row.attribution_json == null
      ? legacySingleStrategy(safeJsonParse(row.snapshot_json, null)) : attribution.strategy;
    if (!strategy) continue;
    const channel = cleanText(row.channel, PUBLISH_CHANNEL_MAX_LENGTH);
    const key = JSON.stringify([strategy, channel]);
    if (!groups.has(key)) {
      groups.set(key, { strategy, channel, contentIds: new Set(), versionIds: new Set(), saves: [], likes: [], comments: [] });
    }
    const group = groups.get(key);
    group.contentIds.add(Number(row.content_id));
    if (attribution.versionId) group.versionIds.add(attribution.versionId);
    if (row.views === null || Number(row.views) <= 0) continue;
    for (const name of ['saves', 'likes', 'comments']) {
      if (row[name] !== null && Number.isFinite(Number(row[name]))) {
        group[name].push(Number(row[name]) / Number(row.views) * 100);
      }
    }
  }
  const average = values => values.length
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100
    : null;
  return [...groups.values()].map(group => ({
    strategy: group.strategy,
    channel: group.channel,
    contents: group.contentIds.size,
    versionIds: [...group.versionIds].sort(),
    rateSampleCounts: { saves: group.saves.length, likes: group.likes.length, comments: group.comments.length },
    avgSaveRate: average(group.saves),
    avgLikeRate: average(group.likes),
    avgCommentRate: average(group.comments),
    verification: 'manual_unverified',
  })).sort((a, b) => a.strategy.localeCompare(b.strategy) || String(a.channel).localeCompare(String(b.channel)));
}

// 锁入复盘运行的证据快照。数值来自本企业台账，不接受客户端提交的“真实数据”对象。
export function loadContentRetrospectiveEvidence(content, { tenantId, allowCompanyComparison = false } = {}) {
  const tid = tenantIdOf(tenantId);
  const fresh = q.get('SELECT * FROM contents WHERE tenant_id=? AND id=?', tid, content.id);
  if (!fresh) throw httpError('复盘内容不存在或不属于本企业', 404);
  if (fresh.status !== '已发布' && !q.get('SELECT id FROM content_publish_logs WHERE tenant_id=? AND content_id=? LIMIT 1', tid, fresh.id)) throw httpError('内容还没有发布记录', 409);
  const rows = q.all(`WITH snapshots AS (
    SELECT *,ROW_NUMBER() OVER (PARTITION BY COALESCE(channel,'') ORDER BY created_at DESC,id DESC) position
    FROM content_publish_metrics WHERE tenant_id=? AND content_id=? AND created_at<=datetime('now','localtime')
  ) SELECT * FROM snapshots WHERE position=1 ORDER BY id`, tid, fresh.id);
  if (!rows.some(row => PUBLISH_METRIC_KEYS.some(key => row[key] !== null))) {
    throw httpError('请先回填至少一项数值；只有截图还不能直接作为复盘数字依据', 409, 'CONTENT_RETRO_METRICS_REQUIRED');
  }
  const metrics = rows.map(row => {
    const rates = {};
    for (const key of ['likes', 'saves', 'comments']) rates[key] = row.views > 0 && row[key] !== null
      ? Math.round(row[key] / row.views * 10000) / 100 : null;
    return {
      metricId: Number(row.id), publishLogId: row.publish_log_id, channel: row.channel,
      ...Object.fromEntries(PUBLISH_METRIC_KEYS.map(key => [key, row[key]])), rates,
      attribution: readPublishAttribution(row.attribution_json), recordedAt: row.created_at,
    };
  });
  const channels = new Set(metrics.map(row => row.channel));
  const owners = new Set(rows.map(row => row.attribution_json == null
    ? fresh.content_employee_idx : readPublishAttribution(row.attribution_json).employeeIdx));
  const employeeIdx = owners.size === 1 ? [...owners][0] : null;
  const comparisonStats = allowCompanyComparison && Number.isInteger(employeeIdx)
    ? contentStrategyMetricsSummary(tid, { employeeIdx })
      .filter(row => channels.has(row.channel) && row.contents >= 3 && row.rateSampleCounts.saves >= 3) : [];
  const comparable = comparisonStats.filter(row => comparisonStats.filter(other => other.channel === row.channel).length >= 2);
  const labels = { views: '浏览量', likes: '点赞数', saves: '收藏数', comments: '评论数', orders: '订单数' };
  const evidenceText = [
    '【发布回填台账·人工录入，平台未核验】',
    `已发布内容ID：${fresh.id}`,
    ...metrics.flatMap(row => [
      `渠道：${row.channel || '未知'}；版本：${row.attribution.versionId || '未知'}；策略：${row.attribution.strategy || '未知'}`,
      ...PUBLISH_METRIC_KEYS.map(key => `${labels[key]}：${row[key] === null ? '未知' : row[key]}`),
      ...Object.entries({ likes: '点赞率', saves: '收藏率', comments: '评论率' }).map(([key, label]) => `${label}：${row.rates[key] === null ? '未知' : `${row.rates[key]}%`}`),
    ]),
    ...comparable.map(row => `渠道${row.channel}，策略${row.strategy}，${row.contents}篇；收藏率均值${row.avgSaveRate}%；有效样本${row.rateSampleCounts.saves}篇。`),
    comparable.length ? '以上为观察性人工数据，仅比较关联，不证明策略导致效果。' : '没有同渠道、各至少3篇有效收藏率的两组策略样本，不判定胜出策略，不把模型自评分当成效果。',
  ].join('\n');
  return {
    schema: 'nanowork.content-retrospective-evidence/1', tenantId: tid,
    content: { id: Number(fresh.id), title: fresh.title, employeeIdx },
    metrics, comparisonStats: comparable, canCompare: comparable.length > 0,
    verification: 'manual_unverified', instructionAuthority: false, evidenceText,
  };
}

// ===== 发布助手状态（前端时间轴） =====

export function loadContentPublishAssistantState(content, { tenantId, now = new Date() } = {}) {
  const tid = tenantIdOf(tenantId);
  const logs = q.all(
    `SELECT l.id,l.channel,l.views,l.leads,l.created_by,l.created_at,l.attribution_json,u.name AS created_by_name
    FROM content_publish_logs l
    LEFT JOIN users u ON u.tenant_id=l.tenant_id AND u.id=l.created_by
    WHERE l.tenant_id=? AND l.content_id=?
    ORDER BY l.created_at,l.id`,
    tid,
    content.id,
  );
  const metrics = q.all(
    `SELECT m.id,m.publish_log_id,m.channel,m.views,m.likes,m.saves,m.comments,m.orders,m.screenshot_file_id,
      m.note,m.verification,m.created_by,m.created_at,m.attribution_json,u.name AS created_by_name
    FROM content_publish_metrics m
    LEFT JOIN users u ON u.tenant_id=m.tenant_id AND u.id=m.created_by
    WHERE m.tenant_id=? AND m.content_id=?
    ORDER BY m.created_at DESC,m.id DESC`,
    tid,
    content.id,
  );
  const followups = q.all(
    `SELECT kind,day,publish_log_id,notified_user_ids,notified_at
    FROM content_publish_followups WHERE tenant_id=? AND content_id=? ORDER BY kind,day`,
    tid,
    content.id,
  );
  const publishedAt = logs.length ? parseDbLocalTime(logs[0].created_at) : null;
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  const filled = metrics.length > 0;
  const timeline = PUBLISH_FOLLOWUP_DAYS.map(day => {
    const row = followups.find(item => item.kind === 'followup' && Number(item.day) === day);
    const dueAt = publishedAt ? new Date(publishedAt.getTime() + day * DAY_MS).toISOString() : null;
    let status = 'pending';
    if (!publishedAt) status = 'waiting_publish';
    else if (row) status = 'notified';
    else if (filled) status = 'stopped';
    else if (dueAt && Date.parse(dueAt) <= nowMs) status = 'due';
    return { day, dueAt, status, notifiedAt: row?.notified_at || null };
  });
  const scheduleDue = followups.find(item => item.kind === 'schedule_due');
  return {
    contentId: Number(content.id),
    title: contentTitle(content),
    status: content.status || '草稿',
    schedule: {
      scheduledAt: content.scheduled_publish_at || null,
      channel: content.publish_channel || null,
      remindedAt: scheduleDue?.notified_at || null,
    },
    publishedAt: publishedAt ? publishedAt.toISOString() : null,
    publishLogs: logs.map(row => ({
      id: Number(row.id),
      attribution: readPublishAttribution(row.attribution_json),
      channel: row.channel,
      views: Number(row.views || 0),
      leads: Number(row.leads || 0),
      createdBy: row.created_by == null ? null : Number(row.created_by),
      createdByName: row.created_by_name || null,
      createdAt: row.created_at,
    })),
    metrics: metrics.map(row => ({
      id: Number(row.id),
      attribution: readPublishAttribution(row.attribution_json),
      publishLogId: row.publish_log_id == null ? null : Number(row.publish_log_id),
      channel: row.channel,
      views: row.views,
      likes: row.likes,
      saves: row.saves,
      comments: row.comments,
      orders: row.orders,
      screenshotFileId: row.screenshot_file_id == null ? null : Number(row.screenshot_file_id),
      note: row.note || '',
      verification: row.verification,
      createdBy: row.created_by == null ? null : Number(row.created_by),
      createdByName: row.created_by_name || null,
      createdAt: row.created_at,
    })),
    metricsFilled: filled,
    followupTimeline: timeline,
  };
}
