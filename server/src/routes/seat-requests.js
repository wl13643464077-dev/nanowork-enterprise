import { Router } from 'express';
import { listSeatRequests, createSeatRequest, quoteSeatRequest, cancelSeatRequest, rejectSeatRequest } from '../engines/seat-requests.js';

export function createSeatRequestsRouter(scope) {
  const router = Router();
  const endpoint = action => (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { action(req, res); }
    catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : '席位操作失败，请稍后重试', code: error.code || 'SEAT_REQUEST_ERROR' }); }
  };
  router.get('/', endpoint((req, res) => res.json(listSeatRequests(req.user, scope, req.query))));
  if (scope === 'platform') {
    router.post('/:id/quote', endpoint((req, res) => res.json(quoteSeatRequest(req.user, req.params.id, req.body))));
    router.post('/:id/reject', endpoint((req, res) => res.json(rejectSeatRequest(req.user, req.params.id, req.body))));
  } else {
    router.post('/', endpoint((req, res) => res.status(201).json(createSeatRequest(req.user, req.body))));
    router.post('/:id/cancel', endpoint((req, res) => res.json(cancelSeatRequest(req.user, req.params.id))));
  }
  return router;
}
