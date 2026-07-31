import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, q, curTenant, getTenantConfig } from '../db.js';
import { logOp, notify } from '../util.js';
import {
  precheck,
  estimateCallCredits,
  holdCredits,
  settleHold,
  releaseHold,
} from '../engines/credits.js';
import { executeHeldDelivery, withImmediateTransaction } from '../engines/two-phase-delivery.js';
import { saveUploadedFile, updateFileExtraction, listFiles, ownedFile, filePublic, isImageExt } from '../engines/filehub.js';
import { FILE_SKILLS } from '../engines/skillrun.js';
import * as yunwu from '../engines/yunwu.js';
import { canAccessOwner, userScopeClause } from '../engines/access.js';
import crypto from 'node:crypto';
import { embedDoc } from '../engines/rag.js';

const r = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'artifacts');
const MANAGERS = new Set(['boss', 'ops_director', 'admin']);

function safeName(value = '产出') {
  return String(value).replace(/[^\w\-\u4e00-\u9fa5]/g, '_').replace(/_+/g, '_').slice(0, 60) || '产出';
}

function artifactForUser(id, user) {
  const row = q.get(`SELECT * FROM generated_artifacts WHERE tenant_id=? AND id=?`, curTenant(), id);
  if (!row) return null;
  return canAccessOwner(user, row.user_id) ? row : null;
}

r.post('/upload', async (req, res) => {
  try {
    const { name, b64, mime, purpose = 'chat', recognize = true } = req.body || {};
    if (!name || !b64) return res.status(400).json({ error: '请选择要上传的文件' });
    const saved = saveUploadedFile({ name, b64, mime, purpose, userId: req.user.id });
    let row = saved.row;
    let billing = null;
    if (isImageExt(row.ext) && recognize !== false) {
      try {
        if (!yunwu.yunwuAvailable()) {
          throw Object.assign(new Error('识图通道未配置'), { status: 503 });
        }
        const holdModel = yunwu.routing().vision;
        precheck(req.user.id, 'text', holdModel);
        const hold = holdCredits({
          userId: req.user.id,
          feature: '文件中心·图片识别',
          kind: 'text',
          model: holdModel,
          credits: estimateCallCredits({
            kind: 'text',
            model: holdModel,
            texts: [row.name],
            outputTokens: 1600,
            // 视觉模型的图片 token 不等于 base64 长度；按文件体积给出保守占扣，
            // 同时设置上限避免大图在请求线程分配巨量临时字符串。
            overheadTokens: Math.min(100000, Math.max(6000, Math.ceil(saved.buffer.length / 2))),
          }),
          refType: 'uploaded_file_vision',
          refId: Number(row.id),
          note: `文件#${row.id}图片识别在供应商调用前预授权；正文未落库则全额退回。`,
        });
        const imageMime = row.ext === 'jpg' ? 'jpeg' : row.ext;
        const delivered = await executeHeldDelivery({
          hold,
          generate: () => yunwu.chat({
            model: holdModel,
            system: '你是企业资料识别助手。完整读取图片中的文字、表格、产品、流程和关键数据，按“图片说明、识别内容、可引用字段”输出。不得臆造看不清的信息。',
            messages: [{ role: 'user', content: [
              { type: 'text', text: `文件名：${row.name}。请提取这张图片中可供后续对话引用的全部信息。` },
              { type: 'image_url', image_url: { url: `data:image/${imageMime};base64,${saved.buffer.toString('base64')}` } },
            ] }],
            maxTokens: 1600,
          }),
          persist: out => withImmediateTransaction(
            db,
            () => updateFileExtraction(row.id, out.text, `AI识图（${out.model}）`),
          ),
          settle: settleHold,
          release: releaseHold,
          settlement: out => ({
            usage: {
              inputTokens: out.inputTokens,
              outputTokens: out.outputTokens,
            },
            model: out.model,
            aiMode: 'api',
            note: '图片识别正文已完成业务落库',
          }),
          releaseNote: '图片识别生成或正文落库失败，预授权全额退回',
        });
        billing = delivered.billing;
        row = delivered.delivery;
      } catch (e) {
        row = updateFileExtraction(row.id, '', '图片已存档·识图待重试');
        billing = e.billing || null;
      }
    }
    logOp(req.user, '文件中心', '上传并读取文件', `${row.name} / ${row.extract_mode}`);
    res.json({ file: filePublic(row), billing });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

r.get('/', (req, res) => {
  res.json(listFiles(req.user, { purpose: req.query.purpose, limit: req.query.limit }));
});

r.get('/artifacts', (req, res) => {
  const scope = req.query.mine === '1'
    ? { sql: ' AND user_id=?', params: [req.user.id] }
    : userScopeClause(req.user, 'user_id');
  const params = [curTenant(), ...scope.params];
  let owner = scope.sql;
  if (req.query.q) { owner += ' AND (title LIKE ? OR content LIKE ?)'; params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  res.json(q.all(`SELECT id,user_id,source_type,source_id,title,format,file_url,file_name,status,kb_doc_id,metadata,created_at,updated_at
    FROM generated_artifacts WHERE tenant_id=?${owner} ORDER BY id DESC LIMIT 100`, ...params));
});

r.post('/artifacts/generate', async (req, res) => {
  try {
    const { title = 'AI产出', format = 'docx', content, sourceType = 'manual', sourceId } = req.body || {};
    const skill = FILE_SKILLS[format];
    if (!skill) return res.status(400).json({ error: '支持生成 Word、PDF、Excel 和 PPT 文件' });
    if (!String(content || '').trim()) return res.status(400).json({ error: '没有可生成文件的内容' });
    const body = String(content).slice(0, 120000);
    const buf = await skill.fn(body, String(title).slice(0, 60));
    const dir = path.join(ARTIFACT_DIR, String(curTenant()));
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `${safeName(title)}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}.${skill.ext}`;
    const filePath = path.join(dir, fileName);
    const fileUrl = `/uploads/artifacts/${curTenant()}/${encodeURIComponent(fileName)}`;
    let out;
    try {
      fs.writeFileSync(filePath, buf, { flag: 'wx' });
      out = q.run(`INSERT INTO generated_artifacts(user_id,source_type,source_id,title,format,content,file_url,file_name,metadata)
        VALUES(?,?,?,?,?,?,?,?,?)`, req.user.id, String(sourceType).slice(0, 40), sourceId || null, String(title).slice(0, 100), format, body, fileUrl, fileName,
      JSON.stringify({ size: buf.length }));
    } catch (error) {
      try { fs.rmSync(filePath, { force: true }); } catch { /* best-effort cleanup */ }
      throw error;
    }
    logOp(req.user, '产出档案', `生成${skill.label}`, String(title).slice(0, 80));
    res.json({ id: out.lastInsertRowid, title, format, fileUrl, fileName, size: buf.length });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

r.post('/artifacts/:id/archive', (req, res) => {
  const artifact = artifactForUser(req.params.id, req.user);
  if (!artifact) return res.status(404).json({ error: '产出不存在或无权访问' });
  if (artifact.kb_doc_id) {
    const linked = q.get(`SELECT id FROM kb_docs WHERE tenant_id=? AND id=?`, curTenant(), artifact.kb_doc_id);
    if (linked) return res.json({ ok: true, kbDocId: linked.id, alreadyArchived: true });
    q.run(`UPDATE generated_artifacts SET kb_doc_id=NULL,status='可用',updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?`,
      curTenant(), artifact.id);
  }
  const category = String(req.body?.category || '员工产出').trim().slice(0, 40) || '员工产出';
  const enabled = MANAGERS.has(req.user.role) ? 1 : 0;
  let kb;
  try {
    db.exec('BEGIN IMMEDIATE');
    const fresh = q.get(`SELECT kb_doc_id FROM generated_artifacts WHERE tenant_id=? AND id=?`, curTenant(), artifact.id);
    if (fresh?.kb_doc_id) {
      db.exec('COMMIT');
      return res.json({ ok: true, kbDocId: fresh.kb_doc_id, alreadyArchived: true });
    }
    kb = q.run(`INSERT INTO kb_docs(category,title,body,enabled,file_path,file_type,file_name) VALUES(?,?,?,?,?,?,?)`,
      category, artifact.title, artifact.content || `产出文件：${artifact.file_name}`, enabled, artifact.file_url, artifact.format, artifact.file_name);
    q.run(`UPDATE generated_artifacts SET status='已入档',kb_doc_id=?,updated_at=datetime('now','localtime') WHERE tenant_id=? AND id=?`,
      kb.lastInsertRowid, curTenant(), artifact.id);
    q.run(`INSERT INTO biz_assets(name,category,value,status,owner,source_type,source_id,creator_id,url,note)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, artifact.title, '知识资产', 3000, '使用中', '产出档案', 'kb', kb.lastInsertRowid, req.user.id, artifact.file_url,
    `AI产出入档；格式=${artifact.format}；入档人=${req.user.name}`);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    return res.status(500).json({ error: error.message });
  }
  embedDoc(kb.lastInsertRowid, artifact.title, artifact.content || artifact.file_name);
  if (!enabled) {
    for (const u of q.all(`SELECT id FROM users WHERE tenant_id=? AND role IN ('boss','ops_director','admin')`, curTenant())) {
      notify(u.id, '知识库', `员工产出待启用：${artifact.title}`, `${req.user.name} 已将AI产出入档，审核启用后可被AI调用`);
    }
  }
  logOp(req.user, '产出档案', '入档知识库', artifact.title);
  res.json({ ok: true, kbDocId: kb.lastInsertRowid, enabled });
});

r.post('/:id/archive', (req, res) => {
  const file = ownedFile(req.params.id, req.user, true);
  if (!file) return res.status(404).json({ error: '文件不存在或无权访问' });
  const body = String(file.extracted_text || '').trim();
  if (!body) return res.status(400).json({ error: '该文件尚未提取到可读正文，暂不能入档知识库' });
  const category = String(req.body?.category || '品牌资料').trim();
  const categories = getTenantConfig('kb_categories', ['品牌资料', '招商政策', '产品资料', '话术案例', '客户画像', '数据规范', '员工产出']);
  if (!category || category.length > 60 || !Array.isArray(categories) || !categories.includes(category)) {
    return res.status(400).json({ error: '请选择本企业已配置的知识库分类' });
  }
  const title = String(file.name || '上传资料').replace(/\.[^.]+$/, '').slice(0, 100);
  const enabled = MANAGERS.has(req.user.role) ? 1 : 0;
  let kbDocId;
  try {
    db.exec('BEGIN IMMEDIATE');
    const existing = q.get(`SELECT id FROM kb_docs WHERE tenant_id=? AND file_path=? LIMIT 1`, curTenant(), file.file_url);
    if (existing) {
      db.exec('COMMIT');
      return res.json({ ok: true, kbDocId: existing.id, alreadyArchived: true });
    }
    const kb = q.run(`INSERT INTO kb_docs(category,title,body,enabled,file_path,file_type,file_name) VALUES(?,?,?,?,?,?,?)`,
      category, title, body.slice(0, 60000), enabled, file.file_url, file.ext, file.name);
    kbDocId = kb.lastInsertRowid;
    q.run(`INSERT INTO biz_assets(name,category,value,status,owner,source_type,source_id,creator_id,url,note)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, title, '知识资产', 3000, '使用中', '文件中心', 'kb', kbDocId, req.user.id, file.file_url,
    `上传文件入档；原文件=${file.name}；入档人=${req.user.name}`);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw error;
  }
  embedDoc(kbDocId, title, body);
  if (!enabled) {
    for (const user of q.all(`SELECT id FROM users WHERE tenant_id=? AND role IN ('boss','ops_director','admin')`, curTenant())) {
      notify(user.id, '知识库', `员工资料待启用：${title}`, `${req.user.name} 已将「${file.name}」入档，审核启用后可被AI调用`);
    }
  }
  logOp(req.user, '文件中心', '入档知识库', file.name);
  res.json({ ok: true, kbDocId, enabled });
});

r.get('/:id', (req, res) => {
  const row = ownedFile(req.params.id, req.user, true);
  if (!row) return res.status(404).json({ error: '文件不存在或无权访问' });
  res.json({ ...filePublic(row), content: row.extracted_text || '' });
});

export default r;
