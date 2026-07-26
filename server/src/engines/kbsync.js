import { q, curTenant } from '../db.js';
import { embedDoc } from './rag.js';
import { CONTENT_TASK_TYPES_BY_EMPLOYEE } from './content-employee-workbench.js';

// 内容产出 → 知识库自动沉淀（分类映射）：AI生成内容即知识资产，kbContext 即时可引用
// 风控约束：仅「可使用」内容入库；命中风控待审核的，审批通过后由审批流补入（见 routes/system.js）
const CONTENT_EMPLOYEE_KB_CATEGORY = Object.freeze({
  0: '品牌资料',
  1: '品牌资料',
  2: '品牌资料',
  3: '话术案例',
  4: '话术案例',
  5: '品牌资料',
  6: '品牌资料',
  7: '品牌资料',
  8: '话术案例',
  9: '品牌资料',
});
const CONTENT_EMPLOYEE_TASK_KB_CAT = Object.fromEntries(
  Object.entries(CONTENT_TASK_TYPES_BY_EMPLOYEE).flatMap(([idx, taskTypes]) => (
    taskTypes.map(taskType => [taskType, CONTENT_EMPLOYEE_KB_CATEGORY[idx]])
  )),
);

export const CONTENT_KB_CAT = Object.freeze({
  '短视频脚本': '话术案例', '朋友圈文案': '话术案例', '社群话题': '话术案例', '私聊邀约话术': '话术案例', '优惠话术': '话术案例',
  '复购礼赠文案': '话术案例', '合伙人每日素材包': '话术案例', '招商文案': '招商政策', 'AIPPT': '品牌资料',
  ...CONTENT_EMPLOYEE_TASK_KB_CAT,
});

export function syncContentToKb({ contentId, type, title, body, topic }) {
  const cat = CONTENT_KB_CAT[type];
  if (!cat || !body) return null;
  const t = `[${type}] ${title || topic}`;
  const normalizedBody = typeof body === 'string' ? body : JSON.stringify(body);
  const sourceId = Number(contentId);
  const hasContentSource = Number.isSafeInteger(sourceId) && sourceId > 0;

  if (hasContentSource) {
    // 来源内容必须真实存在于当前租户。这样即使调用方传错 id，也不会制造无法回溯的知识。
    const source = q.get(`SELECT id FROM contents WHERE tenant_id=? AND id=?`, curTenant(), sourceId);
    if (!source) return null;
    const existed = q.get(`SELECT id FROM kb_docs
      WHERE tenant_id=? AND source_type='content' AND source_id=?`, curTenant(), sourceId);
    if (existed) return cat;
    const inserted = q.run(`INSERT OR IGNORE INTO kb_docs(
      category,title,body,source_type,source_id,enabled
    ) VALUES(?,?,?,'content',?,1)`, cat, t, normalizedBody, sourceId);
    if (inserted.changes > 0) embedDoc(inserted.lastInsertRowid, t, normalizedBody);
    return cat;
  }

  // 兼容非内容来源的历史调用：无稳定来源键时仍按租户内标题防重。
  if (q.get(`SELECT id FROM kb_docs WHERE tenant_id=? AND title=?`, curTenant(), t)) return cat;
  const r = q.run('INSERT INTO kb_docs(category,title,body,enabled) VALUES(?,?,?,1)',
    cat, t, normalizedBody);
  embedDoc(r.lastInsertRowid, t, normalizedBody);
  return cat;
}
