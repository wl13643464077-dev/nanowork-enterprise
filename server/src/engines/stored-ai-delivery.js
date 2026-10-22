import { curTenant, q } from '../db.js';

const json = column => `CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END`;

// Used only by synchronous text/image routes whose persist step is atomic.
// Match this hold, not an older result in the same conversation or activity.
// A read failure propagates: the delivery executor must then retain the hold.
export function hasStoredAiDelivery(hold) {
  const tenantId = Number(hold?.tenantId || curTenant());
  const holdId = Number(hold?.holdId);
  if (!Number.isSafeInteger(holdId) || holdId < 1) return false;
  const row = q.get('SELECT * FROM credit_holds WHERE tenant_id=? AND id=?', tenantId, holdId);
  if (!row) throw new Error('无法核验本次预授权的成果记录');
  if (Number(row.user_id) !== Number(hold.userId)) throw new Error('成果预授权用户不匹配');

  if (row.ref_type === 'agent_task') {
    const output = q.get(`SELECT t.status,t.contract_report,c.snapshot_json FROM agent_tasks t JOIN contents c
      ON c.tenant_id=t.tenant_id AND c.id=t.output_id
      WHERE t.tenant_id=? AND t.id=? AND t.created_by=?
      AND c.creator_id=? AND length(trim(COALESCE(c.body,'')))>0`,
    tenantId, row.ref_id, row.user_id, row.user_id);
    if (!output) return false;
    // A retained diagnostic draft is not a delivered result merely because its
    // body is nonempty. Use the same acceptance gate as the task's accept API.
    if (output.status === '草稿待处理') {
      let report;
      try { report = JSON.parse(output.contract_report || 'null'); }
      catch { throw new Error('无法核验员工草稿的交付状态'); }
      if (report?.acceptable !== true) return false;
    }
    let snapshot;
    try { snapshot = JSON.parse(output.snapshot_json || 'null'); }
    catch { throw new Error('无法核验员工产物的交付快照'); }
    return !(snapshot?.employeeDraft && snapshot.employeeDraft.acceptable !== true);
  }

  if (q.get(`SELECT id FROM contents WHERE tenant_id=? AND creator_id=?
    AND length(trim(COALESCE(body,'')))>0
    AND json_extract(${json('snapshot_json')},'$.billing.holdId')=? LIMIT 1`,
  tenantId, row.user_id, holdId)) return true;

  const byRef = {
    ai_message: ['ai_messages', 'content'],
    custom_agent_msg: ['custom_agent_chat_msgs', 'content'],
    lead_ai_suggestion: ['lead_ai_suggestions', 'suggestion'],
    activity_plan_draft: ['activity_plan_drafts', 'plan'],
  }[row.ref_type];
  if (byRef) {
    const [table, column] = byRef; // Fixed server-owned identifiers only.
    return Boolean(q.get(`SELECT id FROM ${table} WHERE tenant_id=? AND id=?
      AND length(trim(COALESCE(${column},'')))>0`, tenantId, row.ref_id));
  }
  if (row.ref_type === 'content_automation_run') {
    return Boolean(q.get(`SELECT c.id FROM content_automation_runs r JOIN contents c
      ON c.tenant_id=r.tenant_id AND c.id=r.content_id
      WHERE r.tenant_id=? AND r.id=? AND length(trim(COALESCE(c.body,'')))>0`, tenantId, row.ref_id));
  }
  if (row.ref_type === 'media_job') {
    return Boolean(q.get(`SELECT m.id FROM media_jobs m LEFT JOIN contents c
      ON c.tenant_id=m.tenant_id AND c.id=m.result_id
      WHERE m.tenant_id=? AND m.id=? AND
      (length(trim(COALESCE(m.url,'')))>0 OR length(trim(COALESCE(c.body,'')))>0)`, tenantId, row.ref_id));
  }
  if (row.ref_type === 'activity') {
    return Boolean(q.get(`SELECT id FROM activities WHERE tenant_id=? AND id=? AND
      (json_extract(${json('plan')},'$.aiMeta.billing.holdId')=?
       OR json_extract(${json('review')},'$.aiMeta.billing.holdId')=?)`,
    tenantId, row.ref_id, holdId, holdId));
  }
  // Remaining callers either return an in-memory response or commit a single
  // transaction immediately before returning. Their failed persist leaves no
  // accessible result; settlement errors are handled after persist separately.
  return false;
}
