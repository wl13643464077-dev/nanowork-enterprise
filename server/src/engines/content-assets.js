import { curTenant, q } from '../db.js';

const BASE_VALUE_BY_TYPE = Object.freeze({
  '短视频脚本': 200,
  '朋友圈文案': 50,
  '社群话题': 40,
  '私聊邀约话术': 60,
  '优惠话术': 60,
  '招商文案': 150,
  '复购礼赠文案': 80,
  '合伙人每日素材包': 120,
  AIPPT: 180,
});

export function contentAssetBaseValue(content = {}) {
  const type = String(content.type || '');
  if (Object.hasOwn(BASE_VALUE_BY_TYPE, type)) return BASE_VALUE_BY_TYPE[type];
  if (type.includes('视频')) return 220;
  if (type.includes('图片') || type.includes('海报') || type.includes('封面')) return 160;
  return 80;
}

function contentRow(contentOrId, tenantId) {
  if (contentOrId && typeof contentOrId === 'object') return contentOrId;
  const id = Number(contentOrId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return q.get(`SELECT * FROM contents WHERE tenant_id=? AND id=?`, tenantId, id) || null;
}

/**
 * Idempotently registers the business asset represented by a usable content row.
 * This function deliberately does not start a transaction so callers can include
 * status changes, approval decisions and publication entries in one atomic unit.
 */
export function ensureContentAsset(contentOrId, {
  tenantId = curTenant(),
  creatorId = null,
  note = '',
} = {}) {
  const content = contentRow(contentOrId, tenantId);
  if (!content) {
    throw Object.assign(new Error('待登记的内容不存在'), { status: 404 });
  }
  const contentId = Number(content.id);
  const baseValue = contentAssetBaseValue(content);
  const effectBonus = Math.max(0, Number(content.effect_leads || 0)) * 10;
  const minimumValue = baseValue + effectBonus;
  const publishCount = Number(q.get(`SELECT COUNT(*) n FROM content_publish_logs
    WHERE tenant_id=? AND content_id=?`, tenantId, contentId)?.n || 0);
  const existing = q.get(`SELECT * FROM biz_assets
    WHERE tenant_id=? AND source_type='content' AND source_id=?
    ORDER BY id LIMIT 1`, tenantId, contentId);
  const ownerId = Number(creatorId || content.creator_id) || null;
  const assetName = content.title || content.topic || `内容#${contentId}`;
  const traceNote = note || `来源=内容生产仓；content#${contentId}；状态=${content.status || '-'}；效果按人工发布登记回流。`;

  if (existing) {
    q.run(`UPDATE biz_assets
      SET name=COALESCE(NULLIF(name,''),?),
          value=CASE WHEN COALESCE(value,0)<? THEN ? ELSE value END,
          use_count=CASE WHEN COALESCE(use_count,0)<? THEN ? ELSE use_count END,
          creator_id=COALESCE(creator_id,?),
          note=CASE WHEN note IS NULL OR note='' THEN ? ELSE note END,
          updated_at=datetime('now','localtime')
      WHERE tenant_id=? AND id=?`,
    assetName, minimumValue, minimumValue, publishCount, publishCount,
    ownerId, traceNote, tenantId, existing.id);
    return {
      ...q.get(`SELECT * FROM biz_assets WHERE tenant_id=? AND id=?`, tenantId, existing.id),
      existed: true,
    };
  }

  const inserted = q.run(`INSERT INTO biz_assets(
    name,category,value,status,use_count,owner,source_type,source_id,creator_id,note
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
  assetName, '内容资产', minimumValue, '使用中', publishCount, '内容生产仓',
  'content', contentId, ownerId, traceNote);
  return q.get(`SELECT * FROM biz_assets WHERE tenant_id=? AND id=?`, tenantId, inserted.lastInsertRowid);
}
