import { Router } from 'express';
import { db, q } from '../db.js';
import { logOp, safeJsonParse } from '../util.js';
import {
  generateToolboxDraft,
  ToolboxValidationError,
  validateToolRunPayload,
} from '../engines/toolbox.js';

const r = Router();

function jsonArray(value) {
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function jsonObject(value) {
  const parsed = safeJsonParse(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function toRun(row) {
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
    provenance: jsonObject(row.provenance_json),
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
    const rows = q.scopedAll('tool_runs', 'ORDER BY created_at DESC, id DESC LIMIT ?', limit);
    res.set('Cache-Control', 'private, no-store');
    res.json({ runs: rows.map(toRun) });
  } catch (error) {
    if (error instanceof ToolboxValidationError) return res.status(400).json({ error: error.message });
    throw error;
  }
});

r.get('/runs/:id', (req, res) => {
  try {
    const id = parseRunId(req.params.id);
    const row = q.scopedGet('tool_runs', 'AND id = ?', id);
    if (!row) return res.status(404).json({ error: '工具运行记录不存在' });
    res.set('Cache-Control', 'private, no-store');
    res.json({ run: toRun(row) });
  } catch (error) {
    if (error instanceof ToolboxValidationError) return res.status(400).json({ error: error.message });
    throw error;
  }
});

r.post('/runs', (req, res, next) => {
  let input;
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
    const draft = generateToolboxDraft(input.definition, input.inputs);
    const inputJson = JSON.stringify(input.inputs);
    const assumptionsJson = JSON.stringify(draft.assumptions);
    const evidenceJson = JSON.stringify(draft.evidence);
    const provenanceJson = JSON.stringify(draft.provenance);
    let runId;

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

    const row = q.scopedGet('tool_runs', 'AND id = ?', runId);
    logOp(req.user, '经营工具箱', '运行工具并回流数据', `${input.definition.key}#${runId}`);
    res.status(201).json({
      run: toRun(row),
      message: `${input.definition.title}已生成模板草案，结果已保存到工具运行记录`,
    });
  } catch (error) {
    next(error);
  }
});

export default r;
