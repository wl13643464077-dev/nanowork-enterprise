import { Router } from 'express';
import { createNativeChatSession, listNativeChatSessions, publicNativeChatSession, sendNativeChatMessage, confirmNativeChatPlan, revalidateNativeChatPlan } from '../engines/native-creative-chat.js';

const router = Router();
const route = handler => async (req, res) => {
  try { await handler(req, res); }
  catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : '对话暂时无法处理，已保存的消息仍可查看', code: error.code || 'NATIVE_CHAT_UNAVAILABLE' }); }
};
router.get('/native-chat/sessions', route((req, res) => res.json({ sessions: listNativeChatSessions(req.user, Number(req.query.employeeIdx)) })));
router.post('/native-chat/sessions', route((req, res) => res.status(201).json({ session: createNativeChatSession(req.user, Number(req.body?.employeeIdx)) })));
router.get('/native-chat/sessions/:id', route((req, res) => res.json({ session: publicNativeChatSession(req.user, req.params.id) })));
router.post('/native-chat/sessions/:id/revalidate', route((req, res) => res.json({ session: revalidateNativeChatPlan({ actor: req.user, sessionId: req.params.id, planVersion: req.body?.planVersion }) })));
router.post('/native-chat/sessions/:id/messages', route(async (req, res) => {
  const release = req.aiGuard?.defer?.(360000) || (() => {});
  try {
    const session = await sendNativeChatMessage({ actor: req.user, sessionId: req.params.id, message: req.body?.message,
      fileIds: req.body?.fileIds, options: req.body?.options, requestKey: req.body?.requestKey, runtime: req.app.locals.nativeCreativeChatRuntime || {} });
    res.json({ session });
  } finally { release(); }
}));
router.post('/native-chat/sessions/:id/confirm', route(async (req, res) => res.json(await confirmNativeChatPlan({
  actor: req.user, sessionId: req.params.id, planVersion: req.body?.planVersion, requestKey: req.body?.requestKey,
  runtime: req.app.locals.nativeCreativeChatRuntime || {}, videoRuntime: req.app.locals.aiSalesVideoRuntime || {}, xhsRuntime: req.app.locals.aiXhsNoteRuntime || {},
}))));
export default router;
