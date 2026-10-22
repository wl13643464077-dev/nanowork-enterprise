import { Router } from 'express';
import QRCode from 'qrcode';
import { authMiddleware } from '../util.js';
import { applyTester, updateTesterStatus, updateTesterDepartment, listTesters, testerMe, setTesterKey, clearTesterKey, setTesterProvider,
  changeTesterPassword, createTesterInvitation, listTesterInvitations, pauseTesterInvitation,
  publicTrial, applyTrial, trialSession, trialCampaignMaterialFile, listTesterLeads, testerLeadDetail, updateLeadStatus,
  ownConversations, testerChat, trialChat, recordTrialInterest } from '../engines/tester-trials.js';
import { testerAnalytics } from '../engines/tester-analytics.js';

function endpoint(action) {
  return (req, res) => {
    res.set('Cache-Control', 'no-store');
    Promise.resolve().then(() => action(req, res)).catch(error => {
      if (res.headersSent || res.writableEnded) return;
      // Never return upstream errors, encrypted fields, credentials or stacks.
      res.status(error?.status || 500).json({ error: error?.status ? error.message : '体验服务暂时不可用，请稍后重试',
        code: error?.code || 'TESTER_ERROR' });
    });
  };
}

function requestLimit(max, windowMs) {
  const attempts = new Map();
  return (req, res, next) => {
    const now = Date.now();
    for (const [key, row] of attempts) if (row.until <= now) attempts.delete(key);
    const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const current = attempts.get(key);
    if (current && current.count >= max) {
      res.set('Retry-After', String(Math.ceil((current.until - now) / 1000)));
      return res.status(429).json({ error: '操作过于频繁，请稍后重试', code: 'RATE_LIMITED' });
    }
    if (attempts.size >= 10000 && !current) return res.status(429).json({ error: '当前申请较多，请稍后重试', code: 'RATE_LIMITED' });
    attempts.set(key, current ? { ...current, count: current.count + 1 } : { count: 1, until: now + windowMs });
    next();
  };
}
const origin = req => `${req.protocol}://${req.get('host')}`;
const accessToken = req => String(req.get('X-Trial-Token') || '');
async function withQr(invitation) {
  return { ...invitation, qrDataUrl: await QRCode.toDataURL(invitation.url, { width: 320, margin: 2, errorCorrectionLevel: 'M' }) };
}
function analyticsOptions(query) {
  const options = {};
  for (const [key, value] of Object.entries(query)) {
    if (!['days', 'scope', 'ownerUserId', 'department'].includes(key) || typeof value !== 'string') {
      throw Object.assign(new Error('客户看板查询参数无效'), { status: 400, code: 'INVALID_ANALYTICS_QUERY' });
    }
    options[key] = value;
  }
  return options;
}

export function createTesterRouter({ chatFn } = {}) {
  const r = Router();
  r.post('/apply', requestLimit(8, 3600000), endpoint((req, res) => res.status(201).json(applyTester(req.body))));
  r.use(authMiddleware);
  r.get('/me', endpoint((req, res) => res.json(testerMe(req.user))));
  r.get('/analytics', endpoint((req, res) => res.json(testerAnalytics(req.user, analyticsOptions(req.query)))));
  r.put('/provider', endpoint((req, res) => res.json(setTesterProvider(req.user, req.body?.provider))));
  r.put('/key', endpoint((req, res) => res.json(setTesterKey(req.user, req.body?.apiKey, req.body?.provider))));
  r.delete('/key', endpoint((req, res) => res.json(clearTesterKey(req.user, req.body?.provider ?? req.query?.provider))));
  r.post('/password', requestLimit(10, 600000), endpoint(async (req, res) => res.json(await changeTesterPassword(req.user, req.body))));
  r.get('/conversations', endpoint((req, res) => res.json(ownConversations(req.user))));
  r.post('/chat', requestLimit(100, 3600000), endpoint(async (req, res) => res.json(await testerChat(req.user, req.body, { ...(chatFn ? { chatFn } : {}), signal: req.requestSignal }))));
  r.get('/invitations', endpoint(async (req, res) => res.json(await Promise.all(listTesterInvitations(req.user, origin(req)).map(withQr)))));
  r.post('/invitations', endpoint(async (req, res) => res.status(201).json(await withQr(createTesterInvitation(req.user, req.body, origin(req))))));
  r.delete('/invitations/:id', endpoint((req, res) => res.json(pauseTesterInvitation(req.user, req.params.id))));
  r.get('/leads', endpoint((req, res) => res.json(listTesterLeads(req.user))));
  r.get('/leads/:id', endpoint((req, res) => res.json(testerLeadDetail(req.user, req.params.id))));
  r.patch('/leads/:id', endpoint((req, res) => res.json(updateLeadStatus(req.user, req.params.id, req.body?.status))));
  r.get('/admin/applications', endpoint((req, res) => res.json(listTesters(req.user))));
  r.patch('/admin/applications/:id/department', endpoint((req, res) => res.json(updateTesterDepartment(req.user, req.params.id, req.body?.department))));
  r.get('/admin/analytics', endpoint((req, res) => res.json(testerAnalytics(req.user, analyticsOptions(req.query), true))));
  r.patch('/admin/applications/:id', endpoint((req, res) => res.json(updateTesterStatus(req.user, req.params.id, req.body?.status))));
  r.get('/admin/invitations', endpoint(async (req, res) => res.json(await Promise.all(listTesterInvitations(req.user, origin(req), true).map(withQr)))));
  r.delete('/admin/invitations/:id', endpoint((req, res) => res.json(pauseTesterInvitation(req.user, req.params.id, true))));
  r.get('/admin/leads', endpoint((req, res) => res.json(listTesterLeads(req.user, true))));
  r.get('/admin/leads/:id', endpoint((req, res) => res.json(testerLeadDetail(req.user, req.params.id, true))));
  r.patch('/admin/leads/:id', endpoint((req, res) => res.json(updateLeadStatus(req.user, req.params.id, req.body?.status, true))));
  return r;
}

export function createPublicTrialRouter({ chatFn } = {}) {
  const r = Router();
  r.use(requestLimit(240, 600000));
  r.get('/:token', endpoint((req, res) => res.json(publicTrial(req.params.token))));
  r.post('/:token/apply', requestLimit(12, 3600000), endpoint((req, res) => res.status(201).json(applyTrial(req.params.token, req.body))));
  r.get('/:token/session', endpoint((req, res) => res.json(trialSession(req.params.token, accessToken(req)))));
  r.get('/:token/conversations/:id/materials/:slot', endpoint(async (req, res) => {
    const file = await trialCampaignMaterialFile(req.params.token, accessToken(req), req.params.id, req.params.slot);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', file.bytes.length);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${file.fileName}"`);
    res.end(file.bytes);
  }));
  r.post('/:token/interest', endpoint((req, res) => res.json(recordTrialInterest(req.params.token, accessToken(req), req.body))));
  r.post('/:token/chat', endpoint(async (req, res) => res.json(await trialChat(req.params.token, accessToken(req), req.body,
    { ...(chatFn ? { chatFn } : {}), signal: req.requestSignal }))));
  return r;
}

export default createTesterRouter();
export const publicTrialRouter = createPublicTrialRouter();
