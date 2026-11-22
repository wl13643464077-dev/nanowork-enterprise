import { Router } from 'express';
import { logOp, requireRole } from '../util.js';
import {
  archiveBrandPack,
  brandKnowledgeOverview,
  collectBrandKnowledgePack,
  confirmBrandPack,
  recollectBrandDimensions,
  setDimensionIncluded,
  updateBrandDimension,
} from '../engines/brand-knowledge-pack.js';

const r = Router();
const READ_ROLES = ['boss', 'ops_director', 'admin'];
const WRITE_ROLES = ['boss', 'ops_director', 'admin'];

function sendError(res, error, fallback) {
  return res.status(error.status || 500).json({
    error: error.status ? error.message : fallback,
    code: error.code || 'BRAND_KB_ERROR',
  });
}

r.get('/', requireRole(...READ_ROLES), (req, res) => {
  try {
    res.json(brandKnowledgeOverview());
  } catch (error) {
    sendError(res, error, '品牌知识包读取失败');
  }
});

r.post('/collect', requireRole(...WRITE_ROLES), async (req, res) => {
  try {
    const pack = await collectBrandKnowledgePack({
      brandName: req.body?.brandName,
      packRole: req.body?.packRole,
      packId: req.body?.packId,
      userId: req.user?.id,
      upgrade: false,
    });
    logOp(req.user, '品牌知识包', pack.packRole === 'competitor' ? '竞品联网采集' : '联网采集', pack.brandName);
    res.json(pack);
  } catch (error) {
    sendError(res, error, '品牌知识包采集失败，请稍后重试');
  }
});

r.post('/upgrade', requireRole(...WRITE_ROLES), async (req, res) => {
  try {
    const overview = brandKnowledgeOverview();
    const targetId = req.body?.packId !== undefined && req.body?.packId !== null && req.body?.packId !== ''
      ? Number(req.body.packId)
      : null;
    const matchedCompetitor = targetId
      ? (overview.competitors || []).find(item => item.id === targetId)
      : null;
    const brandName = req.body?.brandName || matchedCompetitor?.brandName || overview.pack?.brandName;
    const pack = await collectBrandKnowledgePack({
      brandName,
      packRole: req.body?.packRole,
      packId: targetId,
      userId: req.user?.id,
      upgrade: true,
    });
    logOp(req.user, '品牌知识包', pack.packRole === 'competitor' ? '竞品升级采集' : '升级采集', pack.brandName);
    res.json(pack);
  } catch (error) {
    sendError(res, error, '品牌知识包升级失败，请稍后重试');
  }
});

r.put('/dimensions/:id', requireRole(...WRITE_ROLES), (req, res) => {
  try {
    const pack = updateBrandDimension(req.params.id, {
      body: req.body?.body,
      title: req.body?.title,
    });
    logOp(req.user, '品牌知识包', '修改维度', String(req.params.id));
    res.json(pack);
  } catch (error) {
    sendError(res, error, '维度保存失败');
  }
});

r.put('/dimensions/:id/include', requireRole(...WRITE_ROLES), (req, res) => {
  try {
    const pack = setDimensionIncluded(req.params.id, req.body?.included !== false);
    logOp(req.user, '品牌知识包', req.body?.included === false ? '剔除维度' : '勾选维度', String(req.params.id));
    res.json(pack);
  } catch (error) {
    sendError(res, error, '维度挑选失败');
  }
});

r.post('/recollect', requireRole(...WRITE_ROLES), async (req, res) => {
  try {
    const pack = await recollectBrandDimensions({
      packId: req.body?.packId,
      keys: req.body?.keys,
      feedback: req.body?.feedback,
      userId: req.user?.id,
    });
    logOp(req.user, '品牌知识包', '重抓纠错', pack.brandName);
    res.json(pack);
  } catch (error) {
    sendError(res, error, '品牌知识包重抓失败，请稍后重试');
  }
});

r.post('/confirm', requireRole(...WRITE_ROLES), (req, res) => {
  try {
    const pack = confirmBrandPack(req.body?.packId);
    logOp(req.user, '品牌知识包', pack.packRole === 'competitor' ? '竞品确认入库' : '确认入库', pack.brandName);
    res.json(pack);
  } catch (error) {
    sendError(res, error, '确认入库失败');
  }
});

r.delete('/dimensions/:id', requireRole(...WRITE_ROLES), (req, res) => {
  try {
    const pack = setDimensionIncluded(req.params.id, false);
    logOp(req.user, '品牌知识包', '剔除维度', String(req.params.id));
    res.json(pack);
  } catch (error) {
    sendError(res, error, '维度删除失败');
  }
});

r.delete('/:id', requireRole(...WRITE_ROLES), (req, res) => {
  try {
    const result = archiveBrandPack(req.params.id);
    logOp(
      req.user,
      '品牌知识包',
      result.packRole === 'competitor' ? '删除竞品档案' : '删除知识包',
      String(result.id),
    );
    res.json(result);
  } catch (error) {
    sendError(res, error, '品牌知识包删除失败');
  }
});

r.delete('/', requireRole('boss', 'admin'), (req, res) => {
  try {
    const result = archiveBrandPack();
    logOp(req.user, '品牌知识包', '删除知识包', String(result.id));
    res.json(result);
  } catch (error) {
    sendError(res, error, '品牌知识包删除失败');
  }
});

export default r;
