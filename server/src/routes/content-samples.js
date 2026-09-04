// 样片库端点：/api/content/samples
// - GET    /            登录即可读：平台级共享样片 + 本租户自有样片
// - GET    /:id         单条详情（同样的可见性规则）
// - POST   /import      platform_super / boss：把已上传文件、已完成媒体任务或既有素材标记为样片
// - PATCH  /:id         修改 tags / note / name，或 enabled:false 取消样片
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';

import { curTenant, q } from '../db.js';
import { canAccessOwner } from '../engines/access.js';
import { resolveFfprobe } from '../engines/media-binaries.js';
import {
  SAMPLE_SOURCE_TYPES,
  canImportSample,
  canManageSample,
  ContentSampleError,
  getVisibleSample,
  insertSampleMaterial,
  listSamples,
  markMaterialAsSample,
  normalizeSampleScope,
  probeSampleVideo,
  projectSample,
  sampleTypeForExt,
  sampleTypeForMaterialType,
  updateSample,
  validateSampleFileStat,
} from '../engines/content-samples.js';

const r = Router();
const UPLOAD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'uploads');

function sendError(res, error, requestId) {
  const status = Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 500;
  return res.status(status).json({
    error: status === 500 ? '服务器内部错误' : error.message,
    ...(error?.code ? { code: error.code } : {}),
    ...(requestId ? { requestId } : {}),
  });
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function localUploadPath(url) {
  const clean = String(url || '').split('?')[0];
  if (!clean.startsWith('/uploads/')) return null;
  const relative = decodeURIComponent(clean.slice('/uploads/'.length));
  const resolved = path.resolve(UPLOAD_ROOT, relative);
  if (!resolved.startsWith(`${UPLOAD_ROOT}${path.sep}`)) return null;
  return resolved;
}

async function probeIfLocalVideo(url) {
  const filePath = localUploadPath(url);
  if (!filePath || !/\.mp4$/iu.test(filePath) || !fs.existsSync(filePath) || !resolveFfprobe()) return {};
  try {
    const probe = await probeSampleVideo(filePath);
    return { durationSeconds: probe.duration, width: probe.width, height: probe.height };
  } catch (error) {
    if (error instanceof ContentSampleError && error.code !== 'CONTENT_SAMPLE_FFPROBE_MISSING') throw error;
    return {};
  }
}

r.get('/', (req, res) => {
  try {
    const result = listSamples({
      tenantId: curTenant(),
      type: String(req.query.type || ''),
      tag: String(req.query.tag || ''),
      limit: Number(req.query.limit) || 200,
    });
    res.json({
      ...result,
      canImport: canImportSample(req.user),
      canImportPlatform: String(req.user?.role || '') === 'platform_super',
      total: result.items.length,
    });
  } catch (error) {
    sendError(res, error, req.requestId);
  }
});

r.get('/:id', (req, res) => {
  const row = getVisibleSample(req.params.id, { tenantId: curTenant() });
  if (!row) return res.status(404).json({ error: '样片不存在或不可见' });
  res.json({ ...projectSample(row), canManage: canManageSample(req.user, row) });
});

r.post('/import', async (req, res) => {
  try {
    if (!canImportSample(req.user)) {
      throw new ContentSampleError('只有平台超管或企业老板可以把产物标记为样片', {
        status: 403,
        code: 'CONTENT_SAMPLE_IMPORT_FORBIDDEN',
      });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const isPlatformSuper = String(req.user.role) === 'platform_super';
    const scope = normalizeSampleScope(body.scope, { allowPlatform: isPlatformSuper });
    const tenantId = curTenant();
    const tags = body.tags;
    const note = body.note;
    const fileId = positiveInt(body.fileId);
    const mediaJobId = positiveInt(body.mediaJobId);
    const materialId = positiveInt(body.materialId);
    const chosen = [fileId, mediaJobId, materialId].filter(Boolean).length;
    if (chosen !== 1) {
      throw new ContentSampleError('请且只请提供 fileId / mediaJobId / materialId 之一');
    }

    let row;
    if (fileId) {
      const file = q.get(`SELECT * FROM uploaded_files WHERE tenant_id=? AND id=?`, tenantId, fileId);
      if (!file || (!isPlatformSuper && !canAccessOwner(req.user, file.user_id))) {
        throw new ContentSampleError('文件不存在或无权访问', { status: 404, code: 'CONTENT_SAMPLE_SOURCE_NOT_FOUND' });
      }
      const sampleType = validateSampleFileStat({ ext: file.ext, size: file.size });
      const probe = sampleType === 'video' ? await probeIfLocalVideo(file.file_url) : {};
      row = insertSampleMaterial({
        tenantId,
        scope,
        creatorId: req.user.id,
        name: body.name || file.name,
        sampleType,
        url: file.file_url,
        tags,
        note,
        sourceType: SAMPLE_SOURCE_TYPES.uploaded_file,
        sourceId: file.id,
        artifact: { mimeType: file.mime || undefined, size: file.size, ...probe },
      });
    } else if (mediaJobId) {
      const job = q.get(`SELECT * FROM media_jobs WHERE tenant_id=? AND id=?`, tenantId, mediaJobId);
      if (!job || (!isPlatformSuper && !canAccessOwner(req.user, job.user_id))) {
        throw new ContentSampleError('媒体任务不存在或无权访问', { status: 404, code: 'CONTENT_SAMPLE_SOURCE_NOT_FOUND' });
      }
      if (String(job.status) !== '成功' || !String(job.url || '').trim()) {
        throw new ContentSampleError('媒体任务尚未成功生成成片，不能作为样片', { status: 409, code: 'CONTENT_SAMPLE_SOURCE_NOT_READY' });
      }
      const url = String(job.url).trim();
      if (!url.startsWith('/uploads/') && !/^https:\/\//iu.test(url)) {
        throw new ContentSampleError('媒体任务产物不是可长期访问的文件地址（内嵌数据不能作为样片）', {
          status: 409,
          code: 'CONTENT_SAMPLE_SOURCE_NOT_FILE',
        });
      }
      const sampleType = job.kind === 'video' ? 'video' : 'image';
      const probe = sampleType === 'video' ? await probeIfLocalVideo(url) : {};
      row = insertSampleMaterial({
        tenantId,
        scope,
        creatorId: req.user.id,
        name: body.name || `${sampleType === 'video' ? '视频' : '图片'}样片·${String(job.prompt || '').slice(0, 28) || `任务${job.id}`}`,
        sampleType,
        url,
        tags,
        note,
        sourceType: SAMPLE_SOURCE_TYPES.media_job,
        sourceId: job.id,
        artifact: { ...probe, origin: `media_job:${job.model || ''}` },
      });
    } else {
      const material = q.get(`SELECT * FROM materials WHERE tenant_id=? AND id=?`, tenantId, materialId);
      if (!material) {
        throw new ContentSampleError('素材不存在或无权访问', { status: 404, code: 'CONTENT_SAMPLE_SOURCE_NOT_FOUND' });
      }
      const url = String(material.url || '').trim();
      if (!url.startsWith('/uploads/') && !/^https:\/\//iu.test(url)) {
        throw new ContentSampleError('素材没有可访问的文件地址，不能作为样片', { status: 409, code: 'CONTENT_SAMPLE_SOURCE_NOT_FILE' });
      }
      const sampleType = sampleTypeForMaterialType(material.type) || sampleTypeForExt(url.split('?')[0].split('.').pop());
      if (!sampleType) {
        throw new ContentSampleError('该素材不是视频或图片，不能作为样片', { status: 409, code: 'CONTENT_SAMPLE_SOURCE_TYPE_INVALID' });
      }
      const probe = sampleType === 'video' ? await probeIfLocalVideo(url) : {};
      if (Number(material.is_sample) === 1) {
        // 已是样片：只改 tags / note / name，不改作用域
        row = updateSample(material, { tags, note, name: body.name });
      } else {
        row = markMaterialAsSample(material, { scope, tags, note, name: body.name, sampleType, probe });
      }
    }
    res.status(201).json({ ...projectSample(row), canManage: true });
  } catch (error) {
    sendError(res, error, req.requestId);
  }
});

r.patch('/:id', (req, res) => {
  try {
    const row = getVisibleSample(req.params.id, { tenantId: curTenant() });
    if (!row) return res.status(404).json({ error: '样片不存在或不可见' });
    if (!canManageSample(req.user, row)) {
      throw new ContentSampleError(
        row.sample_scope === 'platform' ? '平台级样片只能由平台超管修改' : '只有本企业老板或平台超管可以修改样片',
        { status: 403, code: 'CONTENT_SAMPLE_MANAGE_FORBIDDEN' },
      );
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const updated = updateSample(row, {
      tags: body.tags,
      note: body.note,
      name: body.name,
      enabled: body.enabled === false ? false : undefined,
    });
    res.json({ ...projectSample(updated), enabled: Number(updated.is_sample) === 1, canManage: true });
  } catch (error) {
    sendError(res, error, req.requestId);
  }
});

export default r;
