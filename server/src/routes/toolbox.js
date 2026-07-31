import { Router } from 'express';
import { db, q } from '../db.js';
import { logOp, safeJsonParse } from '../util.js';
import {
  generateToolboxRun,
  ToolboxValidationError,
  validateToolRunPayload,
} from '../engines/toolbox.js';
import { aiAvailable } from '../engines/ai.js';
import { textModelFor } from '../engines/yunwu.js';
import {
  estimateCallCredits,
  holdCredits,
  releaseHold,
  settleHold,
} from '../engines/credits.js';
import { twoPhaseBillingSummary } from '../engines/two-phase-delivery.js';
import { buildEmployeeExecutionProfile } from '../employee-workbench.js';

const r = Router();
const TOOLBOX_AUDIT_ROLES = new Set(['boss', 'ops_director', 'admin', 'platform_super']);

function jsonArray(value) {
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function jsonObject(value) {
  const parsed = safeJsonParse(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function canAuditAllRuns(user) {
  return TOOLBOX_AUDIT_ROLES.has(user?.role);
}

function visibleProvenance(value, user) {
  const provenance = jsonObject(value);
  if (canAuditAllRuns(user) || !provenance.employeeSnapshot) return provenance;
  const snapshot = {
    ...provenance.employeeSnapshot,
    prompts: undefined,
    systemContext: undefined,
    workMethod: provenance.employeeSnapshot.workMethod
      ? { ...provenance.employeeSnapshot.workMethod, manualMarkdown: null }
      : provenance.employeeSnapshot.workMethod,
  };
  return { ...provenance, employeeSnapshot: snapshot };
}

function toRun(row, user) {
  if (!row) return null;
  return {
    id: row.id,
    toolKey: row.tool_key,
    toolTitle: row.tool_title,
    title: row.title,
    status: row.status,
    employeeIdx: row.employee_idx,
    employeeName: row.employee_name,
    inputSummary: row.input_summary,
    resultMd: row.result_md,
    assumptions: jsonArray(row.assumptions_json),
    evidence: jsonArray(row.evidence_json),
    provenance: visibleProvenance(row.provenance_json, user),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseLimit(value) {
  if (value === undefined) return 20;
  if (typeof value !== 'string' || !/^\d{1,2}$/.test(value)) {
    throw new ToolboxValidationError('limit必须是1-50之间的整数');
  }
  const limit = Number(value);
  if (limit < 1 || limit > 50) throw new ToolboxValidationError('limit必须是1-50之间的整数');
  return limit;
}

function parseRunId(value) {
  const text = String(value || '');
  if (!/^\d{1,15}$/.test(text) || Number(text) < 1 || !Number.isSafeInteger(Number(text))) {
    throw new ToolboxValidationError('运行记录ID格式不正确');
  }
  return Number(text);
}

r.get('/runs', (req, res) => {
  try {
    const limit = parseLimit(req.query.limit);
    const rows = canAuditAllRuns(req.user)
      ? q.scopedAll('tool_runs', 'ORDER BY created_at DESC, id DESC LIMIT ?', limit)
      : q.scopedAll('tool_runs', 'AND created_by=? ORDER BY created_at DESC, id DESC LIMIT ?', req.user.id, limit);
    res.set('Cache-Control', 'private, no-store');
    res.json({ runs: rows.map(row => toRun(row, req.user)) });
  } catch (error) {
    if (error instanceof ToolboxValidationError) return res.status(400).json({ error: error.message });
    throw error;
  }
});

r.get('/runs/:id', (req, res) => {
  try {
    const id = parseRunId(req.params.id);
    const row = canAuditAllRuns(req.user)
      ? q.scopedGet('tool_runs', 'AND id = ?', id)
      : q.scopedGet('tool_runs', 'AND id=? AND created_by=?', id, req.user.id);
    if (!row) return res.status(404).json({ error: '工具运行记录不存在' });
    res.set('Cache-Control', 'private, no-store');
    res.json({ run: toRun(row, req.user) });
  } catch (error) {
    if (error instanceof ToolboxValidationError) return res.status(400).json({ error: error.message });
    throw error;
  }
});

r.post('/runs', async (req, res, next) => {
  let input;
  let hold = null;
  let runId = null;
  try {
    input = validateToolRunPayload(req.body);
  } catch (error) {
    if (error instanceof ToolboxValidationError) return res.status(400).json({ error: error.message });
    return next(error);
  }

  try {
    const specialist = q.get(`SELECT id,employee_idx,person,name FROM specialists WHERE employee_idx=? LIMIT 1`,
      input.definition.employeeIdx);
    const employeeName = specialist?.person || input.definition.employeeName;
    const employeeExecution = buildEmployeeExecutionProfile(input.definition.employeeIdx, {
      tenantId: req.user.tenant_id,
      user: req.user,
    });
    const config = employeeExecution.workbench.workConfig;
    const holdModel = config.textModel || textModelFor(req.user.role);
    if (aiAvailable()) {
      const estimatedCredits = estimateCallCredits({
        kind: 'text',
        model: holdModel,
        outputTokens: config.outputLength === 'full' ? 5000 : 2500,
        texts: [employeeExecution.systemContext, JSON.stringify(input.inputs)],
      });
      if (config.maxCost != null && estimatedCredits > Number(config.maxCost)) {
        throw Object.assign(new Error(`本次预计需${estimatedCredits}积分，超过员工配置的${config.maxCost}积分上限`), { status: 422 });
      }
      hold = holdCredits({
        userId: req.user.id,
        feature: `经营工具箱·${input.definition.title}`,
        kind: 'text',
        model: holdModel,
        credits: estimatedCredits,
        note: `工具“${input.title}”按完整员工提示词与${config.outputLength}篇幅预授权；未交付则全额退回。`,
      });
    }
    const draft = await generateToolboxRun(input.definition, input.inputs, {
      employeeExecution,
      role: req.user.role,
    });
    const inputJson = JSON.stringify(input.inputs);
    const assumptionsJson = JSON.stringify(draft.assumptions);
    const evidenceJson = JSON.stringify(draft.evidence);
    const initialBilling = hold
      ? twoPhaseBillingSummary({ state: 'held', hold, note: '已预授权，等待业务产物落库与实际用量结算。' })
      : {
          state: 'not_applicable',
          estimatedCredits: 0,
          heldCredits: 0,
          chargedCredits: 0,
          credits: 0,
          pendingReconciliation: false,
          note: '当前没有外部 AI 通道，生成的是未完成模板底稿，不产生费用。',
        };
    const provenance = { ...draft.provenance, billing: initialBilling };
    const provenanceJson = JSON.stringify(provenance);

    db.exec('SAVEPOINT create_toolbox_run');
    try {
      const inserted = q.run(`INSERT INTO tool_runs(
        tool_key,tool_title,title,status,employee_idx,employee_name,specialist_id,created_by,
        input_json,input_summary,result_md,assumptions_json,evidence_json,provenance_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      input.definition.key, input.definition.title, input.title, 'done', input.definition.employeeIdx, employeeName,
      specialist?.id || null, req.user.id, inputJson, draft.inputSummary, draft.resultMd, assumptionsJson, evidenceJson, provenanceJson);
      runId = Number(inserted.lastInsertRowid);
      q.run(`INSERT INTO tool_run_events(
        run_id,event_type,tool_key,employee_idx,user_id,status,source_system,metadata_json
      ) VALUES(?,?,?,?,?,?,?,?)`, runId, 'generated', input.definition.key, input.definition.employeeIdx,
      req.user.id, 'done', draft.provenance.sourceSystem, JSON.stringify({
        promptVersion: draft.provenance.promptVersion,
        mode: draft.provenance.mode,
        confidence: draft.provenance.confidence,
      }));
      db.exec('RELEASE SAVEPOINT create_toolbox_run');
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT create_toolbox_run');
      db.exec('RELEASE SAVEPOINT create_toolbox_run');
      throw error;
    }

    let billing = initialBilling;
    if (hold) {
      try {
        const settled = settleHold(hold, {
          usage: draft.provenance.usage || {},
          model: draft.provenance.model || holdModel,
          aiMode: draft.provenance.mode,
          note: draft.provenance.mode === 'api'
            ? '工具产物已落库，按真实用量结算'
            : '供应商未形成产物，模板底稿零扣费',
        });
        if (!settled) throw new Error('工具箱预授权未完成本次结算');
        billing = twoPhaseBillingSummary({
          state: 'settled',
          hold,
          settled,
          note: draft.provenance.mode === 'api'
            ? '工具产物已交付并完成实际用量结算。'
            : '仅形成模板底稿，预授权已全额退回。',
        });
        hold = null;
      } catch (settleError) {
        billing = twoPhaseBillingSummary({
          state: 'pending_reconciliation',
          hold,
          error: settleError,
          note: '工具产物已落库，但预授权尚未确认实扣，需人工对账。',
        });
        hold = null;
      }
    }
    provenance.billing = billing;
    q.run(`UPDATE tool_runs SET provenance_json=?,updated_at=datetime('now','localtime') WHERE id=?`,
      JSON.stringify(provenance), runId);
    const row = q.scopedGet('tool_runs', 'AND id = ?', runId);
    logOp(req.user, '经营工具箱', '运行工具并回流数据', `${input.definition.key}#${runId}`);
    res.status(201).json({
      run: toRun(row, req.user),
      billing,
      message: draft.provenance.mode === 'api'
        ? `${input.definition.title}已由数字员工生成，结果已保存到工具运行记录`
        : `${input.definition.title}只生成了待补材料的模板底稿，尚未完成真实员工交付`,
    });
  } catch (error) {
    if (hold) {
      try { releaseHold(hold, `工具箱任务未交付（${String(error?.message || '').slice(0, 80)}），预授权全额退回`); } catch { /* 保留待对账 */ }
      hold = null;
    }
    next(error);
  }
});

export default r;
