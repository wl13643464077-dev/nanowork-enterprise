import './env.js';
import crypto from 'node:crypto';
import { curTenant, db, initSchema, migrateV2, q, runWithTenant, setConfig } from './db.js';
import { ensureBaselineCatalogs } from './baseline.js';
import { hashPassword, today, daysAgo, isoWeek } from './util.js';
import { rescoreAll } from './engines/scoring.js';
import { generateBattlePlan, generateWeeklyReview } from './engines/plans.js';
import { loadContentAdoptionAvailability } from './engines/delivery-state.js';

// 可复现伪随机
let _s = 20260611;
const rnd = () => (_s = (_s * 1103515245 + 12345) % 2147483648) / 2147483648;
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pk = (arr) => arr[Math.floor(rnd() * arr.length)];

// 这些标题只用来识别 2026-06 版本写入的旧演示占位记录。
// 识别时还会同时核对数字员工编号、创建人、原始状态、执行快照和下游证据，
// 不会仅凭标题修改用户数据。
const LEGACY_DEMO_EMPLOYEE_TASKS = Object.freeze([
  { employeeIdx: 101, title: '新店开业30天行动清单', status: '已完成', creator: 'yunying', collab: false },
  { employeeIdx: 108, title: '本周招牌菜组合建议', status: '待审阅', creator: 'yunying', collab: false },
  { employeeIdx: 116, title: '后厨日常食安检查表', status: '已完成', creator: 'yunying', collab: false },
  { employeeIdx: 125, title: '核心食材供应风险盘点', status: '执行中', creator: 'yunying', collab: false },
  { employeeIdx: 132, title: '午市高峰排班优化', status: '已完成', creator: 'yunying', collab: false },
  { employeeIdx: 140, title: '七天短视频选题表', status: '待审阅', creator: 'yunying', collab: false },
  { employeeIdx: 147, title: '本月现金流滚动表', status: '已完成', creator: 'yunying', collab: false },
  { employeeIdx: 150, title: '单店Prime Cost诊断', status: '已完成', creator: 'yunying', collab: false },
  { employeeIdx: 153, title: '午晚餐与渠道分群分析', status: '已完成', creator: 'yunying', collab: false },
  { employeeIdx: 154, title: '上周经营复盘与本周动作', status: '已完成', creator: 'yunying', collab: false },
  { employeeIdx: 155, title: '第二家店复制条件清单', status: '待审阅', creator: 'yunying', collab: false },
  { employeeIdx: 160, title: '周末会员日活动作战板', status: '执行中', creator: 'yunying', collab: false },
  { employeeIdx: 108, title: '夏季菜单上新协同', status: '执行中', creator: 'guan', collab: true },
  { employeeIdx: 154, title: '周经营复盘协同', status: '执行中', creator: 'guan', collab: true },
]);

const LEGACY_DEMO_APPROVALS = Object.freeze([
  { targetType: 'content', title: '社区联名活动朋友圈（含合作政策表述）', summary: '命中规则：未经确认的收益描述', risk: 'high', rules: '["INVEST_RETURN"]', status: '待审核', submitter: 'sales2' },
  { targetType: 'content', title: '季节限定套餐功效文案', summary: '命中规则：绝对化用语', risk: 'medium', rules: '["ABS_WORD"]', status: '待审核', submitter: 'sales1' },
  { targetType: 'content', title: '企业团餐报价沟通话术', summary: '命中规则：价格承诺', risk: 'high', rules: '["PRICE_PROMISE"]', status: '待审核', submitter: 'sales3' },
  { targetType: 'quote', title: '客户王建华企业团餐方案（金额¥5,800）', summary: '大额方案需老板终审', risk: 'high', rules: '[]', status: '待审核', submitter: 'sales1' },
  { targetType: 'content', title: '商圈联合会员日邀请函', summary: '活动对外文案需审核', risk: 'medium', rules: '["FORCE"]', status: '已通过', submitter: 'yunying' },
  { targetType: 'content', title: '招牌套餐短视频脚本（含"最适合"表述）', summary: '命中规则：绝对化用语', risk: 'medium', rules: '["ABS_WORD"]', status: '已驳回', submitter: 'sales2' },
]);

const DEMO_RECONCILED_ASSET_NOTE = '演示模板未经真实执行与审批，升级时已停用该占位资产';
const DEMO_UNADOPTABLE_MODE = /(?:^|[_-])(?:template|fallback|failed)(?:$|[_-])/iu;
const DEMO_QUALITY_RECONCILIATION_CODE = 'DEMO_UNADOPTABLE_CONTENT_RECONCILED';
const DEMO_QUALITY_RECONCILIATION_REASON =
  '系统质量对账：历史演示模板/降级/失败底稿未形成可采纳产物，已移出人工审阅队列；请补充材料并恢复真实执行通道后重新派活。';
const DEMO_QUALITY_RUN_ERROR = '失败需返工（质检未通过）：未形成可验收产物，系统已移出人工审阅队列；修正材料或生成结果后可重跑。';

const DEMO_MANUAL_TASK_TITLES = new Set([
  '生成今日一键日更包并交门店负责人审核',
  'A类客户TOP10电话跟进',
  '企业团餐意向客户触达（TOP30）',
  '新品试吃会邀约确认',
  '新品试吃会物料清单采购',
  '沉默会员分层唤醒（8人）',
  '上周流失客户原因复盘录入',
  '社区联名活动议程初稿',
  '季节限定菜试吃名单确认',
  '本周内容效果数据登记',
  '企业客户王总方案修订（价格需老板确认）',
  '新线索48小时首触清扫',
]);
const DEMO_MANUAL_TASK_PATTERN = /^(?:夏季新品|双人招牌套餐|季节限定菜|新品试吃会预热|端午家庭聚餐|企业团餐|社区联名|老板IP日常|顾客证言|午市工作餐)相关任务·(?:[1-9]|1\d|20)$/u;
const DEMO_MANUAL_SUBMISSION_CONTENTS = new Set([
  '已完成，截图见素材库',
  '已按SOP执行，结果回写CRM',
  '完成80%，剩余明日上午收尾',
  '已完成并同步相关同事',
]);

const blankExecutionValue = value => value == null || String(value).trim() === '';

function hasTable(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function countIfTable(table, sql, ...params) {
  if (!hasTable(table)) return 0;
  return Number(db.prepare(sql).get(...params)?.n || 0);
}

function hasRealContentDownstream(tenantId, contentId, ignoredTaskId) {
  return countIfTable('approvals', `SELECT COUNT(*) n FROM approvals
      WHERE tenant_id=? AND target_type='content' AND target_id=?`, tenantId, contentId) > 0
    || countIfTable('content_publish_logs', `SELECT COUNT(*) n FROM content_publish_logs
      WHERE tenant_id=? AND content_id=?`, tenantId, contentId) > 0
    || countIfTable('kb_docs', `SELECT COUNT(*) n FROM kb_docs
      WHERE tenant_id=? AND source_type='content' AND source_id=?`, tenantId, contentId) > 0
    || countIfTable('materials', `SELECT COUNT(*) n FROM materials
      WHERE tenant_id=? AND source_type='content' AND source_id=?`, tenantId, contentId) > 0
    || countIfTable('content_material_refs', `SELECT COUNT(*) n FROM content_material_refs
      WHERE tenant_id=? AND target_type='content' AND target_id=?`, tenantId, contentId) > 0
    || countIfTable('content_automation_runs', `SELECT COUNT(*) n FROM content_automation_runs
      WHERE tenant_id=? AND content_id=?`, tenantId, contentId) > 0
    || countIfTable('media_jobs', `SELECT COUNT(*) n FROM media_jobs
      WHERE tenant_id=? AND result_id=?`, tenantId, contentId) > 0
    || countIfTable('generated_artifacts', `SELECT COUNT(*) n FROM generated_artifacts
      WHERE tenant_id=? AND source_type='content' AND source_id=?`, tenantId, contentId) > 0
    || countIfTable('biz_assets', `SELECT COUNT(*) n FROM biz_assets
      WHERE tenant_id=? AND source_type='content' AND source_id=?
        AND NOT (status='已归档' AND note=?)`,
    tenantId, contentId, DEMO_RECONCILED_ASSET_NOTE) > 0
    || countIfTable('agent_tasks', `SELECT COUNT(*) n FROM agent_tasks
      WHERE tenant_id=? AND output_id=? AND id<>?`, tenantId, contentId, ignoredTaskId) > 0;
}

function seededTemplateContent(row) {
  const body = String(row?.body || '');
  return row?.ai_mode === 'template'
    && (body.startsWith('【待企业核验的内容草案】')
      || body.startsWith('【待企业核验的岗位交付草案】'));
}

function seededManualTask(row) {
  const title = String(row?.title || '');
  return (DEMO_MANUAL_TASK_TITLES.has(title) || DEMO_MANUAL_TASK_PATTERN.test(title))
    && ['yunying', 'sales1', 'sales2', 'sales3'].includes(String(row?.assignee_username || ''))
    && row?.assigned_by == null
    && row?.parent_task_id == null
    && row?.source_ref_type == null
    && row?.source_ref_id == null
    && blankExecutionValue(row?.detail)
    && /^\d{4}-\d{2}-\d{2} 08:(?:00|30):00$/u.test(String(row?.created_at || ''));
}

function hasContentRunDownstream(tenantId, runId) {
  return countIfTable('materials', `SELECT COUNT(*) n FROM materials
      WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?`, tenantId, runId) > 0
    || countIfTable('contents', `SELECT COUNT(*) n FROM contents
      WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?`, tenantId, runId) > 0
    || countIfTable('biz_assets', `SELECT COUNT(*) n FROM biz_assets
      WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?`, tenantId, runId) > 0
    || countIfTable('generated_artifacts', `SELECT COUNT(*) n FROM generated_artifacts
      WHERE tenant_id=? AND source_type='content_employee_run' AND source_id=?`, tenantId, runId) > 0;
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function hasContentQualityDownstream(tenantId, contentId) {
  return countIfTable('content_publish_logs', `SELECT COUNT(*) n FROM content_publish_logs
      WHERE tenant_id=? AND content_id=?`, tenantId, contentId) > 0
    || countIfTable('kb_docs', `SELECT COUNT(*) n FROM kb_docs
      WHERE tenant_id=? AND source_type='content' AND source_id=?`, tenantId, contentId) > 0
    || countIfTable('materials', `SELECT COUNT(*) n FROM materials
      WHERE tenant_id=? AND source_type='content' AND source_id=?`, tenantId, contentId) > 0
    || countIfTable('content_material_refs', `SELECT COUNT(*) n FROM content_material_refs
      WHERE tenant_id=? AND target_type='content' AND target_id=?`, tenantId, contentId) > 0
    || countIfTable('media_jobs', `SELECT COUNT(*) n FROM media_jobs
      WHERE tenant_id=? AND result_id=?`, tenantId, contentId) > 0
    || countIfTable('generated_artifacts', `SELECT COUNT(*) n FROM generated_artifacts
      WHERE tenant_id=? AND source_type='content' AND source_id=?`, tenantId, contentId) > 0
    || countIfTable('biz_assets', `SELECT COUNT(*) n FROM biz_assets
      WHERE tenant_id=? AND source_type='content' AND source_id=?`, tenantId, contentId) > 0;
}

function refsHaveActiveOrChargedHolds(tenantId, refType, refIds) {
  if (!hasTable('credit_holds') || !refIds.length) return false;
  return refIds.some(refId => countIfTable('credit_holds', `SELECT COUNT(*) n FROM credit_holds
      WHERE tenant_id=? AND ref_type=? AND ref_id=?
        AND (status='held' OR COALESCE(settled_credits,0)>0)`,
  tenantId, refType, refId) > 0);
}

/**
 * 幂等清理旧版演示种子造成的假运行/假完成状态。
 *
 * 只处理 data_mode=demo 且同时命中全部种子指纹的记录。任务只要有任何
 * 执行快照、预授权占扣或真实审批/发布/资产等下游证据就原样保留。
 */
export function reconcileDemoSeedPlaceholders({ tenantId = curTenant() } = {}) {
  const tid = Number(tenantId);
  if (!Number.isInteger(tid) || tid <= 0) throw new TypeError('tenantId must be a positive integer');
  if (db.prepare(`SELECT data_mode FROM tenants WHERE id=?`).get(tid)?.data_mode !== 'demo') {
    return {
      tenantId: tid,
      skipped: true,
      approvalsRemoved: 0,
      tasksRemoved: 0,
      draftsRepaired: 0,
      assetsArchived: 0,
      notificationsRemoved: 0,
      manualSubmissionsReconciled: 0,
      contentRunsReconciled: 0,
      qualityFailedApprovalsReconciled: 0,
      qualityFailedContentsReconciled: 0,
      qualityFailedAgentTasksReconciled: 0,
      qualityFailedAutomationRunsReconciled: 0,
    };
  }

  const summary = {
    tenantId: tid,
    skipped: false,
    approvalsRemoved: 0,
    tasksRemoved: 0,
    draftsRepaired: 0,
    assetsArchived: 0,
    notificationsRemoved: 0,
    protectedTasks: 0,
    manualSubmissionsReconciled: 0,
    contentRunsReconciled: 0,
    qualityFailedApprovalsReconciled: 0,
    qualityFailedContentsReconciled: 0,
    qualityFailedAgentTasksReconciled: 0,
    qualityFailedAutomationRunsReconciled: 0,
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    if (hasTable('approvals')) {
      const approvalRows = db.prepare(`SELECT a.*,u.username submitter_username,c.ai_mode,c.body,
          c.snapshot_json content_snapshot_json,c.profile_version content_profile_version,
          c.prompt_hash content_prompt_hash,c.source_type content_source_type,c.source_id content_source_id
        FROM approvals a
        LEFT JOIN users u ON u.id=a.submitter_id AND u.tenant_id=a.tenant_id
        LEFT JOIN contents c ON a.target_type='content' AND c.id=a.target_id AND c.tenant_id=a.tenant_id
        WHERE a.tenant_id=?`).all(tid);
      for (const approval of approvalRows) {
        const signature = LEGACY_DEMO_APPROVALS.find(item => (
          item.targetType === approval.target_type
          && item.title === approval.title
          && item.summary === approval.summary
          && item.risk === approval.risk_level
          && item.rules === approval.rules_hit
          && item.status === approval.status
          && item.submitter === approval.submitter_username
        ));
        if (!signature) continue;
        // 内容类的随机 target_id 只有仍指向种子模板（或已成为孤儿）才删；
        // 如果 ID 后来指向了真实 API 产出，必须保留给人工核对。
        const targetHasExecutionEvidence = [
          approval.content_snapshot_json,
          approval.content_profile_version,
          approval.content_prompt_hash,
          approval.content_source_type,
          approval.content_source_id,
        ].some(value => !blankExecutionValue(value));
        if (approval.target_type === 'content' && approval.target_id != null
          && approval.ai_mode != null
          && (!seededTemplateContent(approval) || targetHasExecutionEvidence)) continue;
        const removed = db.prepare(`DELETE FROM approvals WHERE tenant_id=? AND id=?`).run(tid, approval.id);
        summary.approvalsRemoved += Number(removed.changes || 0);
      }
    }

    // 旧种子若曾把模板内容误登记为“使用中”资产，仅归档无创建人、无备注、
    // 无真实审批/发布的演示资产；保留记录和流转轨迹便于追溯。
    if (hasTable('biz_assets')) {
      const archived = db.prepare(`UPDATE biz_assets AS a
        SET status='已归档',
            note=?,
            updated_at=datetime('now','localtime')
        WHERE a.tenant_id=? AND a.source_type='content' AND a.status<>'已归档'
          AND a.creator_id IS NULL AND COALESCE(a.note,'')=''
          AND EXISTS (
            SELECT 1 FROM contents c
            WHERE c.tenant_id=a.tenant_id AND c.id=a.source_id AND c.ai_mode='template'
              AND (c.body LIKE '【待企业核验的内容草案】%'
                OR c.body LIKE '【待企业核验的岗位交付草案】%')
              AND COALESCE(c.snapshot_json,'')='' AND COALESCE(c.profile_version,'')=''
              AND COALESCE(c.prompt_hash,'')='' AND c.source_type IS NULL AND c.source_id IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM approvals ap
            WHERE ap.tenant_id=a.tenant_id AND ap.target_type='content' AND ap.target_id=a.source_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM content_publish_logs pl
            WHERE pl.tenant_id=a.tenant_id AND pl.content_id=a.source_id
          )`).run(DEMO_RECONCILED_ASSET_NOTE, tid);
      summary.assetsArchived += Number(archived.changes || 0);
    }

    const placeholders = db.prepare(`SELECT t.*,s.employee_idx,u.username creator_username,
        c.ai_mode output_ai_mode,c.body output_body,c.status output_status,
        c.snapshot_json output_snapshot_json,c.profile_version output_profile_version,
        c.prompt_hash output_prompt_hash,c.source_type output_source_type,c.source_id output_source_id
      FROM agent_tasks t
      LEFT JOIN specialists s ON s.id=t.specialist_id
      LEFT JOIN users u ON u.id=t.created_by AND u.tenant_id=t.tenant_id
      LEFT JOIN contents c ON c.id=t.output_id AND c.tenant_id=t.tenant_id
      WHERE t.tenant_id=?`).all(tid);
    for (const task of placeholders) {
      const signature = LEGACY_DEMO_EMPLOYEE_TASKS.find(item => (
        item.employeeIdx === Number(task.employee_idx)
        && item.title === task.title
        && item.status === task.status
        && item.creator === task.creator_username
        && Number(Boolean(item.collab)) === Number(Boolean(task.is_collab))
      ));
      if (!signature) continue;
      const snapshotsAreEmpty = [
        task.employee_profile_version,
        task.employee_prompt_hash,
        task.employee_capabilities_snapshot,
        task.employee_config_snapshot,
        task.employee_skills_snapshot,
        task.employee_input_snapshot,
        task.employee_web_snapshot,
      ].every(blankExecutionValue);
      const hasHold = countIfTable('credit_holds', `SELECT COUNT(*) n FROM credit_holds
        WHERE tenant_id=? AND ref_type='agent_task' AND ref_id=?`, tid, task.id) > 0;
      const outputHasExecutionEvidence = [
        task.output_snapshot_json,
        task.output_profile_version,
        task.output_prompt_hash,
        task.output_source_type,
        task.output_source_id,
      ].some(value => !blankExecutionValue(value));
      if (!snapshotsAreEmpty || outputHasExecutionEvidence || hasHold) {
        summary.protectedTasks += 1;
        continue;
      }
      if (task.output_id != null) {
        if (!seededTemplateContent({ ai_mode: task.output_ai_mode, body: task.output_body })
          || hasRealContentDownstream(tid, Number(task.output_id), Number(task.id))) {
          summary.protectedTasks += 1;
          continue;
        }
        const drafted = db.prepare(`UPDATE contents SET status='草稿'
          WHERE tenant_id=? AND id=? AND ai_mode='template' AND status<>'草稿'`).run(tid, task.output_id);
        summary.draftsRepaired += Number(drafted.changes || 0);
      }
      const removed = db.prepare(`DELETE FROM agent_tasks WHERE tenant_id=? AND id=?`).run(tid, task.id);
      summary.tasksRemoved += Number(removed.changes || 0);
    }

    // 2026-06 旧演示种子曾对人工任务随机写入“通过/待审核”，
    // 会造成任务卡显示待审、实际却没有可审提交。只修正全部命中种子
    // 指纹且没有分派人、审核人、来源引用的单条占位提交；用户真实提交
    // 与审核记录不会被改写。
    if (hasTable('tasks') && hasTable('task_submissions')) {
      const manualRows = db.prepare(`SELECT t.*,u.username assignee_username,
          s.id submission_id,s.user_id submission_user_id,s.content submission_content,
          s.result submission_result,s.source_ref_type submission_source_ref_type,
          s.source_ref_id submission_source_ref_id,s.reviewer_id,s.reviewed_at,s.review_reason,
          (SELECT COUNT(*) FROM task_submissions sx
            WHERE sx.tenant_id=t.tenant_id AND sx.task_id=t.id) submission_count
        FROM tasks t
        LEFT JOIN users u ON u.tenant_id=t.tenant_id AND u.id=t.assignee_id
        LEFT JOIN task_submissions s ON s.tenant_id=t.tenant_id AND s.task_id=t.id
        WHERE t.tenant_id=? AND t.status IN ('待审核','已完成')`).all(tid);
      for (const task of manualRows) {
        if (!seededManualTask(task)
          || Number(task.submission_count) !== 1
          || Number(task.submission_user_id) !== Number(task.assignee_id)
          || !DEMO_MANUAL_SUBMISSION_CONTENTS.has(String(task.submission_content || ''))
          || task.submission_source_ref_type != null
          || task.submission_source_ref_id != null
          || task.reviewer_id != null
          || task.reviewed_at != null
          || !blankExecutionValue(task.review_reason)) continue;
        const expected = task.status === '已完成' ? '通过' : '待审核';
        if (task.submission_result === expected) continue;
        const changed = db.prepare(`UPDATE task_submissions SET result=?
          WHERE tenant_id=? AND id=? AND result=?`).run(
          expected,
          tid,
          task.submission_id,
          task.submission_result,
        );
        summary.manualSubmissionsReconciled += Number(changed.changes || 0);
      }
      if (summary.manualSubmissionsReconciled > 0 && hasTable('op_logs')) {
        db.prepare(`INSERT INTO op_logs(
          tenant_id,user_id,username,module,action,target,ip
        ) VALUES(?,NULL,'system','系统升级','演示任务状态对账',?,'127.0.0.1')`).run(
          tid,
          `按种子指纹修正${summary.manualSubmissionsReconciled}条任务提交结果；未删除任务或提交记录`,
        );
      }
    }

    // 旧版内容员工路由曾把“契约失败+预授权已释放”的运行错留在
    // 待审队列。这类记录无法采纳，也不应继续占用审核队列：升级时
    // 将其改为可重跑的失败态。仅处理演示租户中同时命中全部矛盾
    // 证据的行；有人工审阅、下游素材/内容或未释放 hold 的运行不改写。
    if (hasTable('content_employee_runs')) {
      const contentRunRows = db.prepare(`SELECT id,status,result_md,ai_mode,model,snapshot_json
        FROM content_employee_runs
        WHERE tenant_id=? AND status='待审阅'`).all(tid);
      for (const row of contentRunRows) {
        let snapshot;
        try {
          snapshot = JSON.parse(String(row.snapshot_json || ''));
        } catch {
          continue;
        }
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
        const nestedContract = snapshot.contract && typeof snapshot.contract === 'object'
          && !Array.isArray(snapshot.contract)
          ? snapshot.contract
          : null;
        const contractValid = typeof nestedContract?.valid === 'boolean'
          ? nestedContract.valid
          : snapshot.contractValid;
        const billing = snapshot.billing && typeof snapshot.billing === 'object'
          && !Array.isArray(snapshot.billing)
          ? snapshot.billing
          : null;
        const hasReview = snapshot.review && typeof snapshot.review === 'object'
          && !Array.isArray(snapshot.review) && Object.keys(snapshot.review).length > 0;
        const hasHeldCredits = hasTable('credit_holds') && countIfTable(
          'credit_holds',
          `SELECT COUNT(*) n FROM credit_holds
            WHERE tenant_id=? AND ref_type='content_employee_run' AND ref_id=? AND status='held'`,
          tid,
          row.id,
        ) > 0;
        if (contractValid !== false
          || billing?.state !== 'released'
          || !Object.hasOwn(billing, 'chargedCredits')
          || Number(billing.chargedCredits) !== 0
          || hasReview
          || hasHeldCredits
          || hasContentRunDownstream(tid, Number(row.id))) continue;

        const oldResult = String(row.result_md || '');
        const reconciledAt = new Date().toISOString();
        snapshot.previewMarkdown = null;
        snapshot.artifacts = [];
        if (nestedContract) {
          nestedContract.previewMarkdown = null;
          nestedContract.artifacts = [];
        }
        snapshot.failure = {
          kind: 'demo_reconciliation',
          code: 'DEMO_CONTENT_RUN_CONTRACT_INVALID',
          message: '历史演示运行的输出契约未通过，已移出待审队列；请补充或调整材料后重新派活。',
          retryable: true,
          failedAt: reconciledAt,
        };
        snapshot.reconciliation = {
          version: 'demo-content-run-v1',
          reason: 'invalid_contract_released_billing',
          previousStatus: String(row.status || ''),
          previousAiMode: row.ai_mode || null,
          resultSha256: oldResult
            ? crypto.createHash('sha256').update(oldResult).digest('hex')
            : null,
          resultLength: oldResult.length,
          reconciledAt,
        };
        const changed = db.prepare(`UPDATE content_employee_runs
          SET status='失败',result_md=NULL,ai_mode='failed',model=NULL,snapshot_json=?,
            updated_at=datetime('now','localtime')
          WHERE tenant_id=? AND id=? AND status='待审阅' AND snapshot_json=?`).run(
          JSON.stringify(snapshot),
          tid,
          row.id,
          row.snapshot_json,
        );
        summary.contentRunsReconciled += Number(changed.changes || 0);
      }
      if (summary.contentRunsReconciled > 0 && hasTable('op_logs')) {
        db.prepare(`INSERT INTO op_logs(
          tenant_id,user_id,username,module,action,target,ip
        ) VALUES(?,NULL,'system','系统升级','演示内容员工状态对账',?,'127.0.0.1')`).run(
          tid,
          `将${summary.contentRunsReconciled}条“契约无效且计费已释放”的待审运行改为失败/可重跑；保留运行、计费与供应商证据`,
        );
      }
    }

    // 旧演示版曾把模板/降级/失败底稿连同审批单写成“待审核”，
    // 甚至把对应自动化运行写成“成功”。只有同时命中以下不可伪造的
    // 执行指纹才自动收口：demo 租户、不可采纳模式、零实扣、无真实
    // 来源/下游/人工审阅证据，且来自已锁定快照的内容自动化或餐饮员工。
    if (hasTable('contents') && hasTable('approvals')) {
      const qualityCandidates = db.prepare(`SELECT * FROM contents
        WHERE tenant_id=? AND status='待审核'`).all(tid);
      for (const content of qualityCandidates) {
        if (!DEMO_UNADOPTABLE_MODE.test(String(content.ai_mode || ''))
          || !blankExecutionValue(content.source_type)
          || content.source_id != null
          || hasContentQualityDownstream(tid, Number(content.id))) continue;

        const approvalRows = db.prepare(`SELECT * FROM approvals
          WHERE tenant_id=? AND target_type='content' AND target_id=?
          ORDER BY id`).all(tid, content.id);
        const pendingApprovals = approvalRows.filter(row => row.status === '待审核');
        const hasHumanReviewEvidence = approvalRows.some(row => row.status !== '待审核'
          || row.reviewer_id != null
          || !blankExecutionValue(row.reason)
          || !blankExecutionValue(row.decided_at));
        if (!pendingApprovals.length || hasHumanReviewEvidence) continue;

        const automationRuns = hasTable('content_automation_runs')
          ? db.prepare(`SELECT * FROM content_automation_runs
            WHERE tenant_id=? AND content_id=? ORDER BY id`).all(tid, content.id)
          : [];
        const employeeTasks = hasTable('agent_tasks')
          ? db.prepare(`SELECT * FROM agent_tasks
            WHERE tenant_id=? AND output_id=? ORDER BY id`).all(tid, content.id)
          : [];
        const automationSnapshot = parseJsonObject(content.snapshot_json);
        const contentEmployeeIdx = Number(content.content_employee_idx);
        const automationOrigin = ['automation_immediate', 'automation_scheduled']
          .includes(String(content.content_run_mode || ''))
          && Number.isInteger(contentEmployeeIdx)
          && contentEmployeeIdx >= 0
          && contentEmployeeIdx <= 9
          && !blankExecutionValue(content.profile_version)
          && !blankExecutionValue(content.prompt_hash)
          && Object.keys(automationSnapshot).length > 0
          && automationRuns.length > 0
          && employeeTasks.length === 0
          && automationRuns.every(run => run.status === '成功'
            && run.profile_version === content.profile_version
            && run.prompt_hash === content.prompt_hash
            && Object.keys(parseJsonObject(run.snapshot_json)).length > 0)
          && !refsHaveActiveOrChargedHolds(
            tid,
            'content_automation_run',
            automationRuns.map(run => Number(run.id)),
          );

        const employeeTask = employeeTasks.length === 1 ? employeeTasks[0] : null;
        const employeeEvidence = parseJsonObject(employeeTask?.employee_web_snapshot);
        const employeeOrigin = automationRuns.length === 0
          && employeeTask?.status === '待审阅'
          && !blankExecutionValue(employeeTask.employee_profile_version)
          && !blankExecutionValue(employeeTask.employee_prompt_hash)
          && !blankExecutionValue(employeeTask.employee_capabilities_snapshot)
          && !blankExecutionValue(employeeTask.employee_config_snapshot)
          && !blankExecutionValue(employeeTask.employee_skills_snapshot)
          && employeeEvidence.kind === 'restaurant_employee_execution_evidence'
          && employeeEvidence.web?.attempted === false
          && employeeEvidence.outputContract?.valid === false
          && !refsHaveActiveOrChargedHolds(tid, 'agent_task', [Number(employeeTask.id)]);
        const origin = automationOrigin ? 'content_automation' : employeeOrigin ? 'restaurant_employee' : null;
        if (!origin) continue;

        const adoption = loadContentAdoptionAvailability(content.id, { tenantId: tid });
        if (adoption.canAdopt) continue;

        const reconciledAt = new Date().toISOString();
        const reconciliation = {
          version: 'demo-unadoptable-content-v1',
          code: DEMO_QUALITY_RECONCILIATION_CODE,
          origin,
          retryable: true,
          previousContentStatus: String(content.status || ''),
          previousAiMode: String(content.ai_mode || ''),
          approvalIds: pendingApprovals.map(row => Number(row.id)),
          deliveryCode: adoption.state.code,
          reconciledAt,
        };
        const contentSnapshot = parseJsonObject(content.snapshot_json);
        contentSnapshot.reconciliation = reconciliation;
        if (!contentSnapshot.failure || typeof contentSnapshot.failure !== 'object') {
          contentSnapshot.failure = {
            kind: 'quality_gate',
            code: DEMO_QUALITY_RECONCILIATION_CODE,
            message: DEMO_QUALITY_RUN_ERROR,
            retryable: true,
            failedAt: reconciledAt,
          };
        }
        const contentChanged = db.prepare(`UPDATE contents
          SET status='已驳回',snapshot_json=?
          WHERE tenant_id=? AND id=? AND status='待审核' AND ai_mode=?
            AND COALESCE(source_type,'')='' AND source_id IS NULL`).run(
          JSON.stringify(contentSnapshot),
          tid,
          content.id,
          content.ai_mode,
        );
        if (!contentChanged.changes) continue;
        summary.qualityFailedContentsReconciled += Number(contentChanged.changes);

        const approvalsChanged = db.prepare(`UPDATE approvals
          SET status='已驳回',reviewer_id=NULL,reason=?,decided_at=datetime('now','localtime')
          WHERE tenant_id=? AND target_type='content' AND target_id=? AND status='待审核'
            AND reviewer_id IS NULL AND COALESCE(reason,'')='' AND decided_at IS NULL`).run(
          DEMO_QUALITY_RECONCILIATION_REASON,
          tid,
          content.id,
        );
        summary.qualityFailedApprovalsReconciled += Number(approvalsChanged.changes || 0);

        if (employeeOrigin) {
          employeeEvidence.reconciliation = reconciliation;
          employeeEvidence.failure = {
            kind: 'quality_gate',
            code: DEMO_QUALITY_RECONCILIATION_CODE,
            message: DEMO_QUALITY_RUN_ERROR,
            retryable: true,
            failedAt: reconciledAt,
          };
          const taskChanged = db.prepare(`UPDATE agent_tasks
            SET status='失败',employee_web_snapshot=?
            WHERE tenant_id=? AND id=? AND status='待审阅'`).run(
            JSON.stringify(employeeEvidence),
            tid,
            employeeTask.id,
          );
          summary.qualityFailedAgentTasksReconciled += Number(taskChanged.changes || 0);
        }

        if (automationOrigin) {
          for (const run of automationRuns) {
            const runSnapshot = parseJsonObject(run.snapshot_json);
            runSnapshot.reconciliation = reconciliation;
            const runChanged = db.prepare(`UPDATE content_automation_runs
              SET status='失败',snapshot_json=?,error=?,
                finished_at=COALESCE(finished_at,datetime('now','localtime'))
              WHERE tenant_id=? AND id=? AND status='成功'`).run(
              JSON.stringify(runSnapshot),
              DEMO_QUALITY_RUN_ERROR,
              tid,
              run.id,
            );
            summary.qualityFailedAutomationRunsReconciled += Number(runChanged.changes || 0);
            if (runChanged.changes && hasTable('content_automation_rules')) {
              db.prepare(`UPDATE content_automation_rules
                SET last_status='失败',last_error=?,updated_at=datetime('now','localtime')
                WHERE tenant_id=? AND id=? AND last_content_id=?`).run(
                DEMO_QUALITY_RUN_ERROR,
                tid,
                run.rule_id,
                content.id,
              );
            }
          }
        }
      }
      if (summary.qualityFailedContentsReconciled > 0 && hasTable('op_logs')) {
        db.prepare(`INSERT INTO op_logs(
          tenant_id,user_id,username,module,action,target,ip
        ) VALUES(?,NULL,'system','系统升级','演示无效审批质量对账',?,'127.0.0.1')`).run(
          tid,
          `收口不可采纳内容${summary.qualityFailedContentsReconciled}条、审批${summary.qualityFailedApprovalsReconciled}条、餐饮员工任务${summary.qualityFailedAgentTasksReconciled}条、自动化运行${summary.qualityFailedAutomationRunsReconciled}条；未删除任何记录`,
        );
      }
    }

    // 内容生产仓的演示占位稿尚未填入真实正文，不应进入“待审核”队列。
    // 任何已关联审批、发布或资产的内容都不在自动修复范围内。
    const drafted = db.prepare(`UPDATE contents AS c SET status='草稿'
      WHERE c.tenant_id=? AND c.ai_mode='template' AND c.status='待审核'
        AND c.body LIKE '【待企业核验的内容草案】%'
        AND COALESCE(c.snapshot_json,'')='' AND COALESCE(c.profile_version,'')=''
        AND COALESCE(c.prompt_hash,'')='' AND c.source_type IS NULL AND c.source_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM approvals a
          WHERE a.tenant_id=c.tenant_id AND a.target_type='content' AND a.target_id=c.id)
        AND NOT EXISTS (SELECT 1 FROM content_publish_logs p
          WHERE p.tenant_id=c.tenant_id AND p.content_id=c.id)
        AND NOT EXISTS (SELECT 1 FROM biz_assets b
          WHERE b.tenant_id=c.tenant_id AND b.source_type='content' AND b.source_id=c.id
            AND NOT (b.status='已归档' AND b.note=?))`).run(tid, DEMO_RECONCILED_ASSET_NOTE);
    summary.draftsRepaired += Number(drafted.changes || 0);

    if (hasTable('notifications')) {
      const removed = db.prepare(`DELETE FROM notifications
        WHERE tenant_id=? AND user_id=(SELECT id FROM users WHERE tenant_id=? AND username='guan')
          AND type='approval' AND title='3条高风险内容待您终审'
          AND body='含未经确认的价格与活动表述，请尽快处理'`).run(tid, tid);
      summary.notificationsRemoved += Number(removed.changes || 0);
    }
    db.exec('COMMIT');
    return summary;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw error;
  }
}

export function reconcileDemoSeedPlaceholdersAcrossTenants() {
  if (!hasTable('tenants')) return [];
  return db.prepare(`SELECT id FROM tenants WHERE data_mode='demo' ORDER BY id`).all()
    .map(({ id }) => {
      try {
        return runWithTenant(id, () => reconcileDemoSeedPlaceholders({ tenantId: id }));
      } catch (error) {
        return { tenantId: Number(id), error: String(error?.message || error).slice(0, 500) };
      }
    });
}

export function seed() {
  initSchema();
  migrateV2();
  ensureBaselineCatalogs();
  migrateV2();
  if (q.get('SELECT id FROM users LIMIT 1')) { console.log('[seed] 已有数据，跳过（删除 data/nanowork-industry.db 可重建）'); return; }
  console.log('[seed] 开始生成演示数据...');
  db.exec('BEGIN');

  // ===== 用户 =====
  const users = [
    ['guan', '企业老板', 'boss', '决策层', '13901001001'],
    ['yunying', '李娜', 'ops_director', '门店运营', '13901001002'],
    ['sales1', '王强', 'sales', '前厅服务', '13901001003'],
    ['sales2', '赵敏', 'sales', '会员运营', '13901001004'],
    ['sales3', '孙磊', 'sales', '团餐销售', '13901001005'],
    ['admin', '系统管理员', 'admin', 'IT', '13901001006'],
  ];
  for (const [u, n, r, d, p] of users)
    q.run(`INSERT INTO users(username,password_hash,name,role,dept,phone,last_login_at) VALUES(?,?,?,?,?,?,datetime('now','localtime'))`, u, hashPassword('123456'), n, r, d, p);

  // 演示库第一次启动就必须具备真实的三级组织树，不能依赖“下次重启时迁移回填”。
  // 老板可向管理层下达任务，管理层只可继续分派给自己的启用成员。
  const demoBoss = q.get(`SELECT id FROM users WHERE tenant_id=? AND username='guan'`, curTenant());
  const demoOps = q.get(`SELECT id FROM users WHERE tenant_id=? AND username='yunying'`, curTenant());
  if (!demoBoss || !demoOps) throw new Error('演示组织负责人初始化失败，已取消本次生成');
  const linkedOps = q.run(`UPDATE users SET manager_id=?
    WHERE tenant_id=? AND username='yunying'`, demoBoss.id, curTenant());
  const linkedStaff = q.run(`UPDATE users SET manager_id=?
    WHERE tenant_id=? AND role IN ('sales','partner')`, demoOps.id, curTenant());
  q.run(`UPDATE users SET manager_id=?
    WHERE tenant_id=? AND username='admin'`, demoBoss.id, curTenant());
  const expectedStaffLinks = users.filter(([, , role]) => ['sales', 'partner'].includes(role)).length;
  if (linkedOps.changes !== 1 || linkedStaff.changes !== expectedStaffLinks) {
    throw new Error('演示组织层级初始化不完整，已取消本次生成');
  }
  const salesIds = [3, 4, 5];

  // ===== 推广伙伴（沿用 partners 表的兼容名称） =====
  const regions = ['太原', '大同', '运城', '临汾', '晋中', '北京', '石家庄', '西安', '郑州', '天津'];
  const pNames = ['刘建国', '陈志强', '杨丽华', '周文斌', '吴海燕', '郑明辉', '冯雪梅', '蒋大伟', '韩冬', '曹艳', '彭飞', '董学军', '袁芳', '邓超群', '许文静', '傅强', '沈丽', '曾凡', '吕志远', '魏红', '苏建华', '卢晓东', '蔡敏', '丁国栋', '任丽君', '姚远', '钟伟', '谭晓燕'];
  pNames.forEach((n, i) => {
    const level = i < 4 ? '区域协作方' : i < 12 ? '社区推广人' : '会员推荐官';
    q.run('INSERT INTO partners(name,level,region,phone,status,joined_at) VALUES(?,?,?,?,?,?)',
      n, level, regions[i % regions.length], `139${String(10000000 + i * 137).slice(0, 8)}`, i % 9 === 8 ? '沉默' : '活跃', daysAgo(ri(30, 300)));
  });

  // ===== 客户线索 =====
  const surnames = ['王', '李', '张', '刘', '陈', '杨', '黄', '赵', '吴', '周', '徐', '孙', '马', '朱', '胡', '郭', '何', '高', '林', '罗'];
  const givens = ['伟', '强', '磊', '军', '洋', '勇', '杰', '涛', '明', '超', '艳', '娟', '敏', '静', '丽', '芳', '燕', '玲', '飞', '鹏', '建华', '志强', '春梅', '国栋'];
  const sources = ['短视频', '朋友圈', '社群', '转介绍', '新品试吃会', '自然到店', '会员推荐'];
  const identities = ['企业客户', '家庭顾客', '周边白领', '普通消费者'];
  const interests = ['企业团餐', '季节限定套餐', '家庭聚餐', '节日宴请', '工作餐', '会员权益', '包间预订', '日常用餐'];
  const industries = ['建材', '餐饮', '物流', '医药', '地产', '金融', '制造', '教育', '汽贸', '农业'];
  const concernsPool = ['价格偏高', '想再对比', '口味不确定', '用餐时间待定', '需要和家人商量', '预算未批'];
  const stagesDist = [['新线索', 130], ['已沟通', 110], ['已邀约', 60], ['已到店', 38], ['已成交', 88], ['复购', 26], ['已流失', 28]];
  const lostReasons = ['价格因素', '选择竞品', '需求消失', '联系不上', '时机不对'];

  let leadId = 0;
  for (const [stage, count] of stagesDist) {
    for (let i = 0; i < count; i++) {
      leadId++;
      const name = pk(surnames) + pk(givens);
      const identity = stage === '已成交' || stage === '复购' ? pk(['企业客户', '家庭顾客', '周边白领']) : pk(identities);
      const budget = identity === '企业客户' ? pk(['高', '高', '中', '未知']) : identity === '家庭顾客' ? pk(['中', '高', '低']) : pk(['中', '低', '未知']);
      const createdDaysAgo = ri(1, 120);
      const lastInteract = ['新线索'].includes(stage) ? daysAgo(ri(0, Math.min(createdDaysAgo, 20))) : daysAgo(ri(0, 12));
      const concerns = rnd() < 0.45 ? JSON.stringify([{ text: pk(concernsPool), resolved: rnd() < 0.4 }]) : '[]';
      const dealAmount = stage === '已成交' ? pk([128, 198, 328, 588, 1280, 2980, 5800]) : stage === '复购' ? pk([198, 388, 880, 1980]) : 0;
      const pathType = identity === '企业客户' ? '团餐客户' : identity === '家庭顾客' ? '会员客户' : '消费客户';
      const nextFollow = ['已成交', '复购', '已流失'].includes(stage) ? null
        : `${daysAgo(ri(-5, 2))} ${pk(['10:00', '14:00', '16:00', '19:30'])}`;
      q.run(`INSERT INTO leads(name,phone,wechat,source,identity_tag,interest,budget_level,stage,owner_id,next_follow_at,next_action,region,company,concerns,deal_amount,deal_reason,lost_reason,referrer,path_type,last_interact_at,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        name, `13${ri(5, 9)}${String(ri(10000000, 99999999))}`, `wx_${name}${ri(10, 99)}`,
        pk(sources), identity, pk(interests), budget, stage, pk(salesIds),
        nextFollow, nextFollow ? pk(['电话回访', '发送方案', '邀约主题试吃会', '到店深聊', '微信问候']) : null,
        pk(regions), identity === '企业客户' ? `${pk(regions)}${pk(industries)}${pk(['有限公司', '集团', '商贸'])}` : null,
        concerns, dealAmount,
        stage === '已成交' || stage === '复购' ? pk(['主题试吃会现场成交', '老客转介绍信任', '方案匹配预算', '门店老板亲自跟进']) : null,
        stage === '已流失' ? pk(lostReasons) : null,
        rnd() < 0.2 ? pk(surnames) + '总' : null, pathType, lastInteract,
        `${daysAgo(createdDaysAgo)} ${ri(9, 20)}:${pk(['00', '15', '30', '45'])}:00`, daysAgo(ri(0, 5)));
    }
  }

  // ===== 跟进记录 =====
  const followTexts = ['电话沟通15分钟，对企业团餐方案有兴趣，要求发送报价区间', '微信发送新品试吃会邀请，已确认周四到场', '到店试吃，对双人招牌套餐评价很好', '提出价格顾虑，已说明套餐构成与人均成本', '客户需要和家人商量，约定3天后回访', '发送节日聚餐方案，等待反馈', '客户爽约新品试吃会，重新预约下周', '成交后回访，满意度高，介绍了一位朋友'];
  const allLeads = q.all('SELECT id, stage, owner_id FROM leads');
  for (const l of allLeads) {
    const n = l.stage === '新线索' ? ri(0, 1) : ri(1, 4);
    for (let i = 0; i < n; i++)
      q.run('INSERT INTO follow_ups(lead_id,user_id,content,stage_after,created_at) VALUES(?,?,?,?,?)',
        l.id, l.owner_id, pk(followTexts), l.stage, `${daysAgo(ri(0, 30))} ${ri(9, 21)}:${ri(10, 59)}:00`);
  }

  // ===== 订单 =====
  const products = [['双人招牌套餐', 0.32], ['午市工作餐', 0.24], ['季节限定套餐', 0.16], ['企业团餐', 0.12], ['单人精选套餐', 0.10], ['新客体验套餐', 0.06]];
  const dealLeads = q.all(`SELECT id, deal_amount, region FROM leads WHERE stage IN ('已成交','复购')`);
  for (const l of dealLeads) {
    const n = ri(1, 3);
    for (let i = 0; i < n; i++) {
      const r = rnd(); let acc = 0, prod = products[0][0];
      for (const [p, w] of products) { acc += w; if (r <= acc) { prod = p; break; } }
      q.run('INSERT INTO orders(lead_id,product,amount,type,region,channel,created_at) VALUES(?,?,?,?,?,?,?)',
        l.id, prod, i === 0 ? l.deal_amount || ri(3, 30) * 1000 : ri(2, 20) * 1000,
        prod === '企业团餐' ? '团餐' : rnd() < 0.4 ? '到店' : '外卖',
        l.region, pk(sources), `${daysAgo(ri(0, 110))} ${ri(10, 20)}:00:00`);
    }
  }

  // ===== 经营数据表（120天）=====
  for (let d = 120; d >= 0; d--) {
    const date = daysAgo(d);
    const dow = new Date(date + 'T00:00:00').getDay();
    const weekendBoost = (dow === 5 || dow === 6) ? 1.4 : 1;
    const growth = 1 + (120 - d) / 360; // 缓慢增长趋势
    const newLeads = Math.round(ri(4, 11) * weekendBoost * growth);
    const invited = Math.round(newLeads * 0.55 + ri(0, 3));
    const arrived = Math.round(invited * 0.62);
    const deals = Math.max(0, Math.round(arrived * 0.3 + (rnd() < 0.3 ? 1 : 0)));
    const amount = deals * ri(4, 14) * 1000;
    q.run(`INSERT INTO daily_ops(date,content_count,new_leads,invited,arrived,deals,deal_amount,repurchase_amount,active_partners,orders,marketing_cost)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      date, ri(8, 14), newLeads, invited, arrived, deals, amount,
      rnd() < 0.4 ? ri(5, 30) * 1000 : 0, ri(14, 24), deals + ri(0, 2), ri(800, 2600));
  }

  // ===== 合伙人动作表（近14天）=====
  const partners = q.all('SELECT id, status FROM partners');
  for (let d = 13; d >= 0; d--) {
    const date = daysAgo(d);
    for (const p of partners) {
      const activeProb = p.status === '沉默' ? 0.12 : 0.72;
      if (rnd() > activeProb && d > 0) continue;
      const studied = rnd() < 0.85 ? 1 : 0;
      const moments = ri(0, 3), videos = rnd() < 0.4 ? 1 : 0;
      const invited = rnd() < 0.6 ? 1 : 0, inviteCount = invited ? ri(1, 4) : 0;
      const intent = Math.min(inviteCount, ri(0, 2)), arrive = Math.min(intent, rnd() < 0.5 ? 1 : 0);
      const deal = arrive && rnd() < 0.35 ? 1 : 0;
      const score = studied * 10 + Math.min(moments, 1) * 10 + videos * 15 + inviteCount * 5 + arrive * 20 + deal * 50;
      q.run(`INSERT OR IGNORE INTO partner_actions(partner_id,date,studied,posted_moments,posted_videos,invited,invite_count,intent_count,arrive_count,deal_count,problem,score)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        p.id, date, studied, moments, videos, invited, inviteCount, intent, arrive, deal,
        rnd() < 0.15 ? pk(['客户问价格优惠口径', '需要中秋礼赠素材', '邀约话术被拒率高', '想申请总部到店支持']) : null, score);
    }
  }

  // ===== 活动 =====
  const actTypes = ['新品试吃会', '节日主题活动', '企业团餐沙龙', '社区联名活动', '会员日'];
  const acts = [
    ['夏季招牌菜新品试吃会', '新品试吃会', '报名中', 3, '太原示范餐厅·总店', 24, 12000],
    ['企业团餐与包间方案沙龙', '企业团餐沙龙', '筹备中', 9, '太原示范餐厅·总店', 18, 30000],
    ['周边商圈联合会员日', '社区联名活动', '策划中', 15, '北京分店', 40, 12000],
    ['认真做店·老客会员日', '会员日', '策划中', 21, '太原示范餐厅·总店', 36, 18000],
    ['端午家庭聚餐主题活动', '节日主题活动', '筹备中', 7, '太原示范餐厅·总店', 30, 24000],
  ];
  for (const [t, ty, st, inDays, loc, tj, td] of acts) {
    const date = daysAgo(-inDays);
    q.run(`INSERT INTO activities(title,type,status,date,location,target_join,target_deal,budget,cost,invited,signed_up,arrived,converted,revenue,satisfaction,checklist,owner_id)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      t, ty, st, date, loc, tj, td, ri(8, 30) * 1000, 0,
      st === '报名中' ? ri(18, 30) : st === '筹备中' ? ri(8, 15) : 0,
      st === '报名中' ? ri(8, 12) : 0, 0, 0, 0, 0,
      JSON.stringify([{ item: '场地确认', done: true }, { item: '试吃菜品与食安检查', done: st !== '策划中' }, { item: '邀约名单圈选', done: st === '报名中' }, { item: '物料制作', done: false }, { item: '人员分工彩排', done: false }]), 2);
  }
  for (let i = 0; i < 9; i++) {
    const d = ri(7, 100); const ty = pk(actTypes);
    const invited = ri(20, 40), signed = Math.round(invited * (0.35 + rnd() * 0.3));
    const arrived = Math.round(signed * (0.6 + rnd() * 0.25)), conv = Math.round(arrived * (0.2 + rnd() * 0.3));
    const revenue = conv * ri(6, 18) * 1000; const cost = ri(8, 25) * 1000;
    q.run(`INSERT INTO activities(title,type,status,date,location,target_join,target_deal,budget,cost,invited,signed_up,arrived,converted,revenue,satisfaction,review,owner_id)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      `${pk(['招牌菜', '季节限定', '认真做店', '企业团餐'])}${ty}·第${i + 3}期`, ty, '已复盘', daysAgo(d),
      pk(['太原示范餐厅·总店', '北京分店', '运城分店', '大同分店']), 24, 30000, cost + ri(2, 8) * 1000, cost,
      invited, signed, arrived, conv, revenue, 4 + Math.round(rnd() * 10) / 10,
      JSON.stringify({ ok: ['老客证言环节带动现场氛围', '新品盲测试吃参与度高'], bad: ['确认环节执行不严导致爽约偏多', '活动后回访话术未标准化'], roi: Math.round(revenue / Math.max(cost, 1) * 10) / 10, improvements: ['会前1天确认必须电话+微信双触', '活动后24小时内完成分层回访'] }), 2);
  }
  // 活动邀约名单
  const inviteLeads = q.all(`SELECT id FROM leads WHERE stage IN ('已沟通','已邀约','已到店') LIMIT 60`);
  inviteLeads.forEach((l, i) => {
    q.run('INSERT OR IGNORE INTO activity_invites(activity_id,lead_id,status) VALUES(?,?,?)',
      (i % 2) + 1, l.id, pk(['待邀约', '已邀约', '已报名', '已报名']));
  });

  // ===== 数字员工任务 =====
  // 新演示库不预造“已完成 / 待审阅 / 执行中”的假运行记录。
  // 用户真正派活后，任务、调用快照、计费、产出和审批才由执行链路一次生成。

  // ===== 餐饮门店待核验知识库 =====
  const kbs = [
    ['品牌资料', '企业定位核验建议', '【待企业核验的建议】建议结合真实商圈、客群与业务结构确认企业定位；可围绕真材实料、稳定出品和清楚沟通形成品牌主张，由企业管理员补充实际信息。'],
    ['品牌资料', '菜单结构核验建议', '【待企业核验的建议】建议按单人精选、双人招牌、家庭聚餐、企业团餐与季节限定整理菜单，并由门店逐项确认价格、毛利、过敏原和供应状态。'],
    ['品牌资料', '门店表达核验原则', '【待企业核验的建议】建议采用具体、诚实、可验证的表达，涉及稀缺、功效、收益与价格时写明事实依据和适用条件，并在对外发布前由负责人复核。'],
    ['门店运营', '开闭店检查建议', '【待企业核验的建议】建议开店前核对人员、设备、温控、备货、清洁与预订，闭店后核对现金、库存、损耗、客诉与次日准备，并以门店现行制度为最终口径。'],
    ['门店运营', '高峰期现场协同建议', '【待企业核验的建议】建议在高峰期明确迎宾、点单、传菜、收银和补位角色，并用叫号、出餐时长、退菜与客诉记录支持复盘。'],
    ['食安合规', '食品安全复核建议', '【待企业核验的建议】建议由授权人员依据监管要求和现场检测确认温控、留样、过敏原、消杀与异常处置，数字员工负责整理检查建议和留痕清单。'],
    ['供应链', '核心食材风险台账建议', '【待企业核验的建议】建议按供应商、交期、价格波动、合格证明、替代品和安全库存记录核心食材，并由负责人审批供应商调整与采购承诺。'],
    ['增长运营', '会员分层沟通建议', '【待企业核验的建议】建议按新客、活跃会员、沉默会员和高价值顾客设计差异化触达，由负责人确认联系授权、退订机制、隐私要求与平台规则后执行。'],
    ['增长运营', '主题活动复盘建议', '【待企业核验的建议】建议复盘报名、到场、下单、复购意向、成本与客诉，并分别标注事实数据、人员观察和待验证假设，形成下一轮可核验动作。'],
    ['财务数据', '单店成本核验口径', '【待企业核验的建议】建议围绕营业收入、食材成本、人工成本、房租能耗、营销费用与现金流建立口径，并由财务人员确认会计处理。'],
    ['财务数据', '经营复盘证据链建议', '【待企业核验的建议】建议让每项结论回到原始订单、成本凭证、排班或任务产出；暂缺来源的数据标为待补，核验后再进入正式经营判断。'],
    ['连锁发展', '复制条件核验建议', '【待企业核验的建议】建议从产品标准化、店长梯队、供应稳定、现金储备、食安体系与本店盈利质量评估复制条件，开店收益判断以企业实证和负责人审批为准。'],
  ];
  for (const [c, t, b] of kbs) q.run('INSERT INTO kb_docs(category,title,body,ref_count) VALUES(?,?,?,0)', c, t, b);

  // ===== 内容生产仓 =====
  const cTypes = [['短视频脚本', 22], ['朋友圈文案', 30], ['社群话题', 12], ['私聊邀约话术', 10], ['活动文案', 5], ['会员复购文案', 8], ['员工每日素材包', 14], ['AI图片', 12], ['AIPPT', 4], ['AI音频', 3]];
  const topics = ['夏季新品', '双人招牌套餐', '季节限定菜', '新品试吃会预热', '端午家庭聚餐', '企业团餐', '社区联名', '老板IP日常', '顾客证言', '午市工作餐'];
  for (const [type, n] of cTypes) {
    for (let i = 0; i < n; i++) {
      const topic = pk(topics);
      q.run(`INSERT INTO contents(type,title,body,topic,status,risk_level,ai_mode,creator_id,marshal_id,channel,effect_views,effect_leads,created_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        type, `${topic}·${type}${i + 1}`, `【待企业核验的内容草案】\n主题：${topic}\n交付类型：${type}\n请结合企业真实材料补全正文，并由有权限的负责人审核后决定是否使用或发布。`,
        topic, '草稿', type === '活动文案' ? 'medium' : 'none', 'template',
        pk([2, 3, 4]), type.includes('素材包') ? 8 : type === '活动文案' ? 6 : 3,
        null, 0, 0,
        `${daysAgo(ri(0, 30))} ${ri(7, 21)}:${ri(10, 59)}:00`);
    }
  }

  // ===== 模板与素材 =====
  const tpls = [['新品试吃会邀约包', '私聊邀约话术'], ['沉默会员唤醒三件套', '会员复购文案'], ['社区联名预热', '活动文案'], ['老板IP人设日更', '朋友圈文案'], ['招牌菜种草', '短视频脚本'], ['季节限定菜故事', '短视频脚本'], ['顾客证言模板', '朋友圈文案'], ['新店开业活动包', '社群话题']];
  for (const [n, t] of tpls) q.run('INSERT INTO content_templates(name,type,prompt,use_count) VALUES(?,?,?,?)', n, t, `按「${n}」场景生成${t}`, ri(20, 300));
  const mats = [['门店用餐实拍图集', '图片', '场景,到店'], ['招牌套餐产品图', '图片', '产品'], ['季节限定菜视频素材', '视频', '季节限定,菜品'], ['门店老板口播短视频', '视频', 'IP,口播'], ['品牌手册PDF', '文档', '品牌'], ['后厨备餐流程', '视频', '后厨,流程'], ['顾客证言录音', '音频', '证言'], ['家庭聚餐海报', '图片', '聚餐,节日']];
  for (const [n, t, tg] of mats) q.run('INSERT INTO materials(name,type,tags,use_count) VALUES(?,?,?,?)', n, t, tg, ri(10, 120));

  // ===== 目标（OKR拆解）=====
  q.run(`INSERT INTO goals(period,revenue_target,leads_target,partner_target,activity_target) VALUES
    ('2026', 18000000, 10000, 60, 48),
    ('2026-Q2', 4500000, 2600, 15, 12),
    ('2026-06', 1500000, 900, 5, 4)`);

  // ===== 经营执行任务 =====
  const taskRows = [
    ['生成今日一键日更包并交门店负责人审核', '内容', '已完成', '高', 2, '作战计划'],
    ['A类客户TOP10电话跟进', '跟进', '进行中', '高', 3, '作战计划'],
    ['企业团餐意向客户触达（TOP30）', '跟进', '待执行', '高', 4, '作战计划'],
    ['新品试吃会邀约确认', '邀约', '进行中', '高', 3, '活动'],
    ['新品试吃会物料清单采购', '活动', '待审核', '中', 5, '活动'],
    ['沉默会员分层唤醒（8人）', '会员', '进行中', '中', 2, '作战计划'],
    ['上周流失客户原因复盘录入', '数据', '已完成', '中', 4, '手动'],
    ['社区联名活动议程初稿', '活动', '待审核', '高', 2, '数字员工'],
    ['季节限定菜试吃名单确认', '活动', '待执行', '中', 3, '活动'],
    ['本周内容效果数据登记', '数据', '待执行', '低', 5, '手动'],
    ['企业客户王总方案修订（价格需老板确认）', '跟进', '待审核', '高', 3, '手动'],
    ['新线索48小时首触清扫', '跟进', '进行中', '高', 4, '作战计划'],
  ];
  for (const [t, ty, st, pr, as, src] of taskRows)
    q.run('INSERT INTO tasks(title,type,status,priority,assignee_id,due_at,source,risk,created_at,done_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      t, ty, st, pr, as, `${daysAgo(ri(-2, 0))} 18:00`, src, t.includes('价格') || t.includes('招商') ? 1 : 0,
      `${daysAgo(ri(0, 4))} 08:00:00`, st === '已完成' ? `${daysAgo(0)} ${ri(10, 17)}:00:00` : null);
  for (let i = 0; i < 20; i++) {
    const st = pk(['已完成', '已完成', '已完成', '进行中', '待执行']);
    q.run('INSERT INTO tasks(title,type,status,priority,assignee_id,due_at,source,created_at,done_at) VALUES(?,?,?,?,?,?,?,?,?)',
      `${pk(topics)}相关任务·${i + 1}`, pk(['内容', '邀约', '跟进', '培训', '数据']), st, pk(['高', '中', '低']),
      pk([2, 3, 4, 5]), `${daysAgo(ri(0, 6))} 18:00`, pk(['作战计划', '手动', '数字员工']),
      `${daysAgo(ri(1, 9))} 08:30:00`, st === '已完成' ? `${daysAgo(ri(0, 5))} 16:00:00` : null);
  }
  const doneTasks = q.all(`SELECT id, assignee_id, status FROM tasks WHERE status IN ('已完成','待审核') LIMIT 18`);
  for (const t of doneTasks)
    q.run('INSERT INTO task_submissions(task_id,user_id,content,result,created_at) VALUES(?,?,?,?,?)',
      t.id, t.assignee_id, pk(['已完成，截图见素材库', '已按SOP执行，结果回写CRM', '完成80%，剩余明日上午收尾', '已完成并同步相关同事']),
      t.status === '已完成' ? '通过' : '待审核', `${daysAgo(ri(0, 3))} ${ri(15, 21)}:00:00`);

  // ===== 审批队列 =====
  // 审批必须由真实业务对象提交时创建，演示种子不再用随机 ID 伪造待审事项。

  // ===== 数据资产 =====
  const assetSeed = [
    ['品牌资产', [['示范餐厅品牌VI体系', 180000], ['门店老板IP形象资产', 260000], ['认真做店内容规范', 150000], ['招牌菜故事库', 80000]]],
    ['知识资产', [['门店运营知识库', 60000], ['会员沟通案例库', 45000], ['新品试吃会SOP手册', 38000], ['客诉处理库', 26000]]],
    ['数据资产', [['客户线索数据库（480+）', 96000], ['经营数据表（120天）', 30000], ['推广伙伴动作数据', 18000]]],
  ];
  for (const [cat, items] of assetSeed)
    for (const [n, v] of items)
      q.run('INSERT INTO biz_assets(name,category,value,status,use_count,owner,created_at) VALUES(?,?,?,?,?,?,?)',
        n, cat, v, '使用中', ri(20, 200), '总部', daysAgo(ri(20, 100)));
  // 内容资产：从 contents 自动登记
  const baseVal = { '短视频脚本': 200, '朋友圈文案': 50, '社群话题': 40, '私聊邀约话术': 60, '活动文案': 150, '会员复购文案': 80, '员工每日素材包': 120, 'AI图片': 100, 'AIPPT': 300, 'AI音频': 150 };
  const okContents = q.all(`SELECT id,type,title,effect_leads,created_at FROM contents
    WHERE status IN ('可使用','已发布') AND COALESCE(ai_mode,'')<>'template'`);
  for (const c of okContents)
    q.run('INSERT INTO biz_assets(name,category,value,status,use_count,owner,source_type,source_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      c.title, '内容资产', Math.round((baseVal[c.type] || 50) * (1 + c.effect_leads * 0.1)), pk(['使用中', '使用中', '闲置']),
      ri(1, 40), '内容生产仓', 'content', c.id, c.created_at);
  // 客户资产
  const gradeCnt = q.all(`SELECT grade, COUNT(*) n FROM leads WHERE stage NOT IN ('已流失') GROUP BY grade`);
  q.run('INSERT INTO biz_assets(name,category,value,status,use_count,owner,created_at) VALUES(?,?,?,?,?,?,?)',
    '客户关系资产（A/B/C分级池）', '客户资产',
    gradeCnt.reduce((acc, g) => acc + g.n * (g.grade === 'A' ? 800 : g.grade === 'B' ? 300 : 50), 0),
    '使用中', 300, '增长中心', daysAgo(60));
  const assets = q.all('SELECT id FROM biz_assets ORDER BY RANDOM() LIMIT 25');
  for (const a of assets)
    q.run('INSERT INTO asset_flows(asset_id,action,note,created_at) VALUES(?,?,?,?)',
      a.id, pk(['创建登记', '被AI引用', '价值重估', '状态流转', '被内容生产仓调用']), pk(['自动登记入库', '生成内容时引用', '月度重估+12%', '闲置→使用中', '日更包引用']),
      `${daysAgo(ri(0, 10))} ${ri(8, 20)}:00:00`);

  // ===== 老板参谋会话 =====
  const convs = [
    ['本月营业额下滑原因诊断', '经营诊断', [['user', '本月营业额对比上月下滑了，帮我找找原因'], ['assistant', '【待企业核验的会诊建议】建议先核对午市客流、会员复购、订单、餐段和渠道明细，再依据确认后的变化安排菜单、排班或触达动作。']]],
    ['夏季新品怎么推', '战略诊断', [['user', '夏季菜单要上新，未来三周怎么安排？'], ['assistant', '【待企业核验的会诊建议】可按三步推进：小范围试吃收集反馈、核对成本与出品稳定性、经负责人确认后安排会员日发布；价格、食安与供应承诺同步进入审核清单。']]],
    ['企业团餐客户为什么还没下单', '销售诊断', [['user', '王建华跟了快一个月还没定团餐，帮我看看'], ['assistant', '【待企业核验的会诊建议】建议先确认客户预算、用餐时间和决策条件，再提供两档可比较方案、写明有效期，并约定下一次人工跟进时间。']]],
  ];
  for (const [title, dt, msgs] of convs) {
    const r = q.run('INSERT INTO ai_conversations(user_id,title,diag_type,created_at) VALUES(?,?,?,?)', 1, title, dt, `${daysAgo(ri(1, 6))} 09:30:00`);
    for (const [role, content] of msgs)
      q.run('INSERT INTO ai_messages(conversation_id,role,content) VALUES(?,?,?)', r.lastInsertRowid, role, content);
  }

  // ===== 通知与日志 =====
  const notifs = [
    [1, 'lead', '企业团餐客户提醒：王建华（82分）建议您亲自跟进', '预算与用餐时间待确认'],
    [2, 'partner', '8位推广伙伴连续2日无动作', '已生成提醒任务'],
    [3, 'follow', '今日待跟进客户 12 人，其中 3 人已超期', '请优先处理超期客户'],
    [2, 'activity', '夏季新品试吃会报名已达20人', '距目标还差4人，建议追加邀约'],
  ];
  for (const [uid, ty, t, b] of notifs) q.run('INSERT INTO notifications(user_id,type,title,body) VALUES(?,?,?,?)', uid, ty, t, b);
  const modules = ['会员增长', '内容生产仓', '营销活动', '今日经营', '系统管理', '老板参谋'];
  const actions = ['新增客户', '推进阶段', '生成内容', '审批通过', '导出报表', '修改配置', '派发任务', '发起会诊'];
  for (let i = 0; i < 40; i++)
    q.run('INSERT INTO op_logs(user_id,username,module,action,target,ip,created_at) VALUES(?,?,?,?,?,?,?)',
      ri(1, 5), pk(['企业老板', '李娜', '王强', '赵敏', '孙磊']), pk(modules), pk(actions), `记录#${ri(100, 999)}`,
      `192.168.1.${ri(2, 254)}`, `${daysAgo(ri(0, 5))} ${ri(8, 21)}:${ri(10, 59)}:00`);
  for (let i = 0; i < 20; i++)
    q.run('INSERT INTO login_logs(tenant_id,username,success,ip,ua,created_at) VALUES(1,?,?,?,?,?)',
      pk(['guan', 'yunying', 'sales1', 'sales2', 'sales3', 'unknown_user']), rnd() < 0.9 ? 1 : 0,
      `192.168.1.${ri(2, 254)}`, 'Chrome/126 macOS', `${daysAgo(ri(0, 7))} ${ri(7, 22)}:${ri(10, 59)}:00`);

  // ===== 系统配置（全部业务系数可配，FR-SYS-07）=====
  setConfig('month_revenue_target', 500000);
  setConfig('year_revenue_target', 6000000);
  setConfig('personal_month_target', 60000);
  setConfig('avg_deal_amount', 800);
  setConfig('month_targets', { leads: 900, conversionRate: 8, repurchaseRate: 25, partnerActive: 18, contentPerDay: 10 });
  setConfig('funnel_baseline', { '已沟通': 70, '已邀约': 45, '已到店': 60, '已成交': 35 });
  setConfig('activity_baseline', { inviteSign: 35, signArrive: 70, arriveDeal: 25, referral: 30, roi: 2.0 });
  setConfig('health_weights', { leads: 0.25, conversion: 0.25, repurchase: 0.15, partner: 0.20, content: 0.15 });

  // data_mode 是数据库内的事实标记，不依赖下次启动是否仍携带 SEED_DEMO。
  // 只在本次确实生成演示数据且即将提交时写入；已有数据提前返回时绝不误标。
  const markedTenant = db.prepare(`UPDATE tenants SET data_mode='demo' WHERE id=?`).run(curTenant());
  if (markedTenant.changes !== 1) throw new Error('演示数据租户标记失败，已取消本次生成');
  db.exec('COMMIT');

  // 评分 + 今日作战计划 + 本周周报（引擎实跑）
  rescoreAll();
  generateBattlePlan(today());
  generateWeeklyReview(today());
  console.log('[seed] 完成：演示用户6 / 推广伙伴28 / 线索480 / 经营数据121天 / 活动14 / 内容草稿120 / 餐饮数字员工编制60 / 预造员工任务0');
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  if (process.env.NODE_ENV === 'production') throw new Error('生产环境禁止运行演示种子');
  if (process.env.SEED_DEMO !== 'true') throw new Error('演示种子未启用：请使用 npm run seed:demo 明确确认写入合成演示数据');
  seed();
}
