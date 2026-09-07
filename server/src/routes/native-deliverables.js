import { Router } from 'express';
import { buildNativeDeliverable } from '../engines/native-deliverables.js';

const router = Router();
router.get('/:kind/:id/download', (req, res) => {
  try {
    const bundle = buildNativeDeliverable(req.params.kind, req.params.id, req.user);
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="digital-employee-delivery.zip"; filename*=UTF-8''${encodeURIComponent(bundle.downloadName)}`);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(bundle.bytes);
  } catch (error) {
    const status = [400, 403, 404, 409].includes(error.status) ? error.status : 500;
    res.status(status).json({ error: status === 500 ? '成果暂时无法打包，请稍后重试' : error.message });
  }
});
export default router;
