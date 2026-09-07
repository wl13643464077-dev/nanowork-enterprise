import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { q, curTenant } from '../db.js';
import { canAccessOwner } from './access.js';
import { readTenantUploadedFileByUrl } from './filehub.js';
import { xhsNoteMarkdown } from './ai-xhs-note.js';

const VIDEO_ROOT = fileURLToPath(new URL('../../data/uploads/ai-sales-video/', import.meta.url));
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_VIDEO_BYTES = 180 * 1024 * 1024;
const parsed = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const fail = (message, status = 404) => Object.assign(new Error(message), { status });
const safeName = (value, fallback) => String(value || '').replace(/[\\/\x00-\x1f\x7f:*?"<>|]/g, '_').replace(/^\.+/, '').trim().slice(0, 72) || fallback;

export function nativeDownloadMetadata(kind, id, title) {
  if (!['xhs', 'sales'].includes(kind) || !Number.isSafeInteger(Number(id)) || Number(id) < 1) return {};
  return {
    downloadUrl: `/api/content/native-deliverables/${kind}/${Number(id)}/download`,
    downloadName: `${safeName(title, kind === 'xhs' ? '小红书图文' : '带货视频')}-交付包.zip`,
  };
}

export function readLocalVideo(url, tenantId, videoRoot = VIDEO_ROOT) {
  const prefix = `/uploads/ai-sales-video/${tenantId}/`;
  const name = String(url || '').slice(prefix.length);
  if (!String(url || '').startsWith(prefix) || !/^[a-zA-Z0-9_-]+\.mp4$/.test(name)) throw fail('成片未保存在本地');
  // Deployment intentionally links server/data to the persistent data volume.
  // Resolve that managed root first; tenant directories and files must still
  // remain real children, never symlinks to another tenant or external files.
  const root = path.join(fs.realpathSync(videoRoot), String(tenantId));
  const absolute = path.join(root, name);
  // The database owns the URL; still do not follow replaced tenant folders or
  // file symlinks out of the managed media directory.
  if (fs.realpathSync(root) !== root || fs.realpathSync(absolute) !== absolute) throw fail('成片文件路径已变化');
  const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_VIDEO_BYTES) throw fail('成片为空或超过打包大小限制');
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

export function nativeSalesScriptText(script) {
  if (!Array.isArray(script?.shots) || !script.shots.length) return '';
  return script.shots.map((shot, index) => [
    `第${index + 1}段（${shot.start ?? index * 15}–${shot.end ?? (index + 1) * 15}秒）`,
    `口播：${shot.voiceover || ''}`,
    `画面：${shot.visual || ''}`,
    shot.subtitle ? `字幕：${shot.subtitle}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

/** Export saved results only. No provider calls, new holds, adoption or writes. */
export function buildNativeDeliverable(kind, id, user) {
  const tenantId = Number(curTenant());
  const taskId = Number(id);
  if (!['xhs', 'sales'].includes(kind) || !Number.isSafeInteger(taskId) || taskId < 1 || !Number(user?.id)) throw fail('任务不存在');
  const row = kind === 'xhs'
    ? q.get("SELECT * FROM contents WHERE tenant_id=? AND id=? AND source_type='ai_xhs_note'", tenantId, taskId)
    : q.get('SELECT * FROM media_jobs WHERE tenant_id=? AND id=?', tenantId, taskId);
  if (!row || !canAccessOwner(user, kind === 'xhs' ? row.creator_id : row.user_id)) throw fail('任务不存在');
  const snapshot = parsed(row.snapshot_json);
  if (kind === 'sales' && snapshot.workflow !== 'ai_sales_video') throw fail('任务不存在');
  const zip = new AdmZip();
  let bytes = 0;
  let resultCount = 0;
  const notes = [];
  const add = (name, data, isResult = true) => {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    if (!body.length) return false;
    if (bytes + body.length > MAX_BUNDLE_BYTES) { notes.push(`${name}：超过整包大小限制，请单独下载。`); return false; }
    zip.addFile(name, body);
    bytes += body.length;
    if (isResult) resultCount++;
    return true;
  };
  const input = snapshot.input || {};
  const brief = input.brief || snapshot.brief || row.prompt || row.topic || '';
  const brandName = input.brandName || snapshot.brandName || row.brand || '';
  add('输入需求.txt', [brandName ? `品牌：${brandName}` : '', brief ? `需求：${brief}` : ''].filter(Boolean).join('\n\n'), false);

  if (kind === 'xhs') {
    const output = snapshot.editedOutput || snapshot.output;
    const markdown = output ? xhsNoteMarkdown(output) : String(row.body || '');
    if (markdown.trim()) add('小红书文案.txt', markdown);
    if (output?.title) add('标题.txt', output.title, false);
    if (output?.firstComment) add('评论区首评.txt', output.firstComment, false);
    if (Array.isArray(output?.generatedImagePlan)) add('配图方案.txt', output.generatedImagePlan.map((page, i) =>
      `${i + 1}. ${page.label || page.role || page.id || '配图'}\n${[page.caption, page.purpose, page.visualTask || page.visual || page.visualBrief].filter(Boolean).join('\n')}`).join('\n\n'), false);
    const images = q.all(`SELECT id,user_id,status,url,snapshot_json FROM media_jobs WHERE tenant_id=? AND kind='image'
      AND CASE WHEN json_valid(snapshot_json) THEN json_extract(snapshot_json,'$.source') END='ai_xhs_note_image'
      AND CASE WHEN json_valid(snapshot_json) THEN json_extract(snapshot_json,'$.contentId') END=? ORDER BY id`, tenantId, taskId);
    let included = 0;
    for (const [index, image] of images.entries()) {
      const state = parsed(image.snapshot_json);
      const label = safeName(state.label || ({ cover: '封面', detail: '菜品特写', scene: '用餐场景' }[state.role]) || `配图${index + 1}`, '配图');
      const order = String(index + 1).padStart(2, '0');
      if (image.user_id !== row.creator_id || image.status !== '成功' || !image.url) { notes.push(`第${index + 1}张 ${label}：尚未完成，本包保留其他已生成成果。`); continue; }
      try {
        const uploaded = q.get('SELECT user_id,ext FROM uploaded_files WHERE tenant_id=? AND file_url=?', tenantId, image.url);
        if (!uploaded || uploaded.user_id !== row.creator_id || !['png', 'jpg', 'jpeg', 'webp'].includes(uploaded.ext)) throw fail('图片归属或格式不符');
        const loaded = readTenantUploadedFileByUrl({ tenantId, fileUrl: image.url });
        if (add(`图片/${order}-${label}.${uploaded.ext}`, loaded.bytes)) included++;
      } catch { notes.push(`第${index + 1}张 ${label}：本地文件暂不可读取，请在历史任务中核对。`); }
    }
    const expected = input.generateImages === false ? 0 : Number(input.imageCount || 3);
    notes.unshift(`选择图片：${expected}张；本包包含：${included}张。`, '图片按发布顺序编号，01为封面。AI创意配图不代表现场实拍。');
    if (expected > images.length) notes.push(`另有${expected - images.length}张配图尚未生成。`);
  } else {
    const durationSeconds = snapshot.durationSeconds ?? 30;
    const expectedSegments = durationSeconds === 15 ? 1 : 2;
    if ([15, 30].includes(durationSeconds)) notes.push(`选择视频：${durationSeconds}秒；原生生成${expectedSegments}段。`);
    const script = nativeSalesScriptText(snapshot.script);
    if (script) add('视频脚本.txt', script);
    let fullVideo = false;
    if (row.status === '成功' && row.url) {
      try { fullVideo = add('带货视频.mp4', readLocalVideo(row.url, tenantId)); }
      catch { notes.push('视频本地文件暂不可打包，已保留可读取的脚本，请在历史任务中核对。'); }
    }
    if (!fullVideo) {
      let count = 0;
      const seen = new Set();
      for (const part of Array.isArray(snapshot.partialResults) ? snapshot.partialResults : []) {
        if (!Number.isSafeInteger(part?.index) || part.index < 1 || part.index > expectedSegments || seen.has(part.index) || !/^[a-f0-9]{64}$/.test(part.sha256 || '')
          || !Number.isFinite(part.durationSeconds) || part.durationSeconds <= 0 || part.durationSeconds > 16) continue;
        seen.add(part.index);
        if (part.url !== `/uploads/ai-sales-video/${tenantId}/partial-${taskId}-${part.index}-${part.sha256.slice(0, 24)}.mp4`) continue;
        try {
          const bytes = readLocalVideo(part.url, tenantId);
          if (createHash('sha256').update(bytes).digest('hex') !== part.sha256) throw fail('片段文件已变化');
          if (add(`已生成片段/0${part.index}-${part.durationSeconds}秒原片段.mp4`, bytes)) count++;
        } catch { notes.push(`第${part.index}段原片段暂不可读取，请在历史任务中核对。`); }
      }
      notes.push(`完整视频尚未完成；本包保留已保存的脚本${count ? `和${count}段原始片段` : ''}。原片段未加后期字幕，费用状态仍以任务中心为准。`);
    } else notes.push('保留原生成音轨。成片字幕按脚本估时，请预览核对声音、字幕与品牌信息。');
  }
  if (!resultCount) throw fail('任务还没有可打包的成果，请生成后再下载', 409);
  add('交付说明.txt', [`任务：${row.title || row.topic || row.prompt || (kind === 'xhs' ? '小红书图文' : '带货视频')}`,
    `记录时间：${row.created_at || ''}`, ...notes, '本包由已保存成果生成，下载不会再次调用AI。历史与采纳记录请在任务中心查看。'].join('\n\n'), false);
  return { ...nativeDownloadMetadata(kind, taskId, brandName || row.title || row.topic), bytes: zip.toBuffer() };
}
