// ================================================================
// Devices / Handoff / Browser session APIs
//   GET  /api/devices
//   POST /api/devices/pair
//   POST /api/devices/:id/revoke
//   POST /api/tasks/:id/handoff
//   POST /api/browser/sessions
//   GET  /api/browser/sessions/:id
//   POST /api/browser/sessions/:id/pause | resume | takeover |
//        /api/browser/sessions/:id/awaiting-user | finish
// ================================================================

import { Router, Response } from 'express';
import { prisma, prismaConversation } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { addEvent, createTrace, newTraceId, newRequestId } from '../services/trace';

export const devicesRouter = Router();
export const tasksRouter = Router();
export const browserRouter = Router();

const DEVICE_TYPES = ['desktop_web', 'mobile_app', 'mobile_web'];
const BROWSER_PHASES = ['observe', 'understand', 'plan', 'permission', 'act', 'verify'];

async function newTrace(userId: string): Promise<string> {
  const traceId = newTraceId();
  await createTrace({ traceId, requestId: newRequestId(), userId });
  return traceId;
}

// ============ Devices ============

devicesRouter.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  const devices = await prisma.deviceSession.findMany({
    where: { userId: req.user!.id, status: 'active' },
    orderBy: { lastActiveAt: 'desc' },
  });
  res.json({ devices });
});

devicesRouter.post('/pair', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const deviceType = String(req.body?.deviceType || 'desktop_web');
  if (!DEVICE_TYPES.includes(deviceType)) { res.status(400).json({ error: 'Invalid deviceType' }); return; }
  const label = req.body?.label ? String(req.body.label) : null;
  const capabilities = Array.isArray(req.body?.capabilities) ? req.body.capabilities : [];

  // One active session per deviceType — re-pairing revokes the old one
  const existing = await prisma.deviceSession.findFirst({ where: { userId, deviceType, status: 'active' } });
  if (existing) {
    await prisma.deviceSession.update({ where: { id: existing.id }, data: { status: 'revoked' } });
  }
  const session = await prisma.deviceSession.create({
    data: { userId, deviceType, label, status: 'active', capabilities: JSON.stringify(capabilities), lastActiveAt: new Date() },
  });
  const traceId = await newTrace(userId);
  await addEvent(traceId, 'DEVICE', { paired: true, deviceType, deviceId: session.id }, 'success');
  res.status(201).json({ device: session });
});

devicesRouter.post('/:id/revoke', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const d = await prisma.deviceSession.findFirst({ where: { id: String(req.params.id), userId } });
  if (!d) { res.status(404).json({ error: 'Device not found' }); return; }
  await prisma.deviceSession.update({ where: { id: d.id }, data: { status: 'revoked' } });
  const traceId = await newTrace(userId);
  await addEvent(traceId, 'DEVICE', { deviceId: d.id, revoked: true }, 'success');
  res.json({ ok: true });
});

// ============ Task handoff ============

tasksRouter.post('/:id/handoff', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const conversationId = String(req.params.id);
  const conv = await prismaConversation.conversation.findFirst({ where: { id: conversationId, userId } });
  if (!conv) { res.status(404).json({ error: 'Conversation not found' }); return; }
  const fromDevice = req.body?.fromDevice ? String(req.body.fromDevice) : null;
  const toDevice = req.body?.toDevice ? String(req.body.toDevice) : null;
  const reason = req.body?.reason ? String(req.body.reason) : null;

  const handoff = await prisma.taskHandoff.create({
    data: { userId, conversationId, fromDevice, toDevice, reason, status: 'pending' },
  });
  const traceId = await newTrace(userId);
  await addEvent(traceId, 'DEVICE', { handoffId: handoff.id, fromDevice, toDevice, conversationId }, 'pending');
  res.status(201).json({ handoff });
});

// ============ Browser sessions ============
// Browser agent runtime: session lifecycle (pause / takeover / resume /
// verify) is fully implemented so any browser task is observable,
// pausable, resumable and verifiable. Actual page automation is a
// declared adapter boundary (provider status: stub).

browserRouter.post('/sessions', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const url = req.body?.url ? String(req.body.url) : null;
  const task = req.body?.task ? String(req.body.task) : null;
  const session = await prisma.browserSession.create({
    data: {
      userId,
      status: 'active',
      url,
      phase: 'observe',
      result: task ? JSON.stringify({ task }) : undefined,
    },
  });
  const traceId = await newTrace(userId);
  await addEvent(traceId, 'BROWSER', { sessionId: session.id, url, started: true }, 'active');
  res.status(201).json({ session });
});

browserRouter.get('/sessions/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  const s = await prisma.browserSession.findFirst({ where: { id: String(req.params.id), userId: req.user!.id } });
  if (!s) { res.status(404).json({ error: 'Session not found' }); return; }
  let result: any = null;
  if (s.result) { try { result = JSON.parse(s.result); } catch { result = s.result; } }
  res.json({ session: { ...s, result } });
});

browserRouter.post('/sessions/:id/pause', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const s = await prisma.browserSession.findFirst({ where: { id: String(req.params.id), userId } });
  if (!s) { res.status(404).json({ error: 'Session not found' }); return; }
  if (s.status === 'completed' || s.status === 'revoked') { res.status(409).json({ error: `Session is ${s.status}` }); return; }
  const updated = await prisma.browserSession.update({ where: { id: s.id }, data: { status: 'paused' } });
  const traceId = await newTrace(userId);
  await addEvent(traceId, 'BROWSER', { sessionId: s.id, paused: true }, 'paused');
  res.json({ session: updated });
});

browserRouter.post('/sessions/:id/resume', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const s = await prisma.browserSession.findFirst({ where: { id: String(req.params.id), userId } });
  if (!s) { res.status(404).json({ error: 'Session not found' }); return; }
  if (s.status === 'completed' || s.status === 'revoked') { res.status(409).json({ error: `Session is ${s.status}` }); return; }
  const phase = BROWSER_PHASES.includes(s.phase) ? s.phase : 'act';
  const updated = await prisma.browserSession.update({ where: { id: s.id }, data: { status: 'active', phase } });
  const traceId = await newTrace(userId);
  await addEvent(traceId, 'BROWSER', { sessionId: s.id, resumed: true, phase }, 'active');
  res.json({ session: updated });
});

// Human takeover — required at MFA / CAPTCHA / verification checkpoints.
// The AI never proceeds through these on its own.
browserRouter.post('/sessions/:id/takeover', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const s = await prisma.browserSession.findFirst({ where: { id: String(req.params.id), userId } });
  if (!s) { res.status(404).json({ error: 'Session not found' }); return; }
  if (s.status !== 'awaiting_user') { res.status(409).json({ error: 'Session is not awaiting user takeover' }); return; }
  const updated = await prisma.browserSession.update({ where: { id: s.id }, data: { status: 'active', phase: 'act' } });
  const traceId = await newTrace(userId);
  await addEvent(traceId, 'BROWSER', { sessionId: s.id, takeover: true, pendingAction: s.pendingAction }, 'active');
  res.json({ session: updated });
});

// Security checkpoint: MFA / CAPTCHA / email / SMS — pause and hand off
// to the user. Webpage content is external data, never instructions.
browserRouter.post('/sessions/:id/awaiting-user', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const s = await prisma.browserSession.findFirst({ where: { id: String(req.params.id), userId } });
  if (!s) { res.status(404).json({ error: 'Session not found' }); return; }
  const reason = req.body?.reason ? String(req.body.reason) : s.pendingAction;
  const updated = await prisma.browserSession.update({
    where: { id: s.id },
    data: { status: 'awaiting_user', phase: 'permission', pendingAction: reason },
  });
  const traceId = await newTrace(userId);
  await addEvent(traceId, 'BROWSER', { sessionId: s.id, awaitingUser: true, checkpoint: reason }, 'awaiting_user');
  res.json({ session: updated });
});

// Finish with explicit verification (AI self-report alone is not enough)
browserRouter.post('/sessions/:id/finish', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const s = await prisma.browserSession.findFirst({ where: { id: String(req.params.id), userId } });
  if (!s) { res.status(404).json({ error: 'Session not found' }); return; }
  if (s.status === 'completed' || s.status === 'revoked') { res.status(409).json({ error: `Session is ${s.status}` }); return; }
  let prev: any = {};
  if (typeof s.result === 'string' && s.result) {
    try { prev = JSON.parse(s.result); } catch { prev = {}; }
  }
  const verified = req.body?.verified === true;
  const summary = req.body?.summary ? String(req.body.summary) : null;
  const updated = await prisma.browserSession.update({
    where: { id: s.id },
    data: { status: verified ? 'completed' : 'failed', phase: 'verify', result: JSON.stringify({ ...prev, verified, summary }) },
  });
  const traceId = await newTrace(userId);
  await addEvent(traceId, 'BROWSER', { sessionId: s.id, verified, summary }, verified ? 'success' : 'error');
  res.json({ session: updated });
});
