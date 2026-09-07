import { Router } from 'express';
import { createInvitation, listInvitations, revokeInvitation } from '../engines/invitations.js';

export function createInvitationsRouter(scope) {
  const router = Router();
  const endpoint = action => (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { action(req, res); }
    catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : '邀请码操作失败，请稍后重试', code: error.code || 'INVITATION_ERROR' }); }
  };
  router.get('/', endpoint((req, res) => res.json(listInvitations(req.user, scope))));
  router.post('/', endpoint((req, res) => res.status(201).json(createInvitation(req.user, req.body, scope))));
  router.post('/:id/revoke', endpoint((req, res) => res.json(revokeInvitation(req.user, req.params.id, scope))));
  return router;
}
