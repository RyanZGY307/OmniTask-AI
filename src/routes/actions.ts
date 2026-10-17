// ================================================================
// Action Approval API
//   POST /api/actions                      — create / run a tool action
//   POST /api/actions/:id/approve           — approve a pending action
//   POST /api/actions/:id/reject           — reject a pending action
//   GET  /api/actions/pending               — list pending approvals
//   GET  /api/actions/tools                 — available tools
// ================================================================

import { Router, Request, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { createAction, approveAction, rejectAction, listPendingActions, toolView } from '../connections/actions';
import { GITHUB_TOOLS } from '../connections/github';
import { LEGACY_TOOLS } from '../connections/providers';

const router = Router();

router.get('/tools', authMiddleware, (_req: AuthRequest, res: Response) => {
  const githubTools = Object.entries(GITHUB_TOOLS).map(([id, t]) => ({
    id,
    description: t.description,
    riskLevel: t.riskLevel,
    readOnly: t.readOnly,
    requiredCapabilities: t.requiredCapabilities,
    provider: 'github',
  }));
  // 通用浏览器登录 + 多类 token 工具（供 AI/前端调用）
  const providerTools = LEGACY_TOOLS
    .filter((t) => t.providerId === 'web' || t.providerId === 'web-token')
    .map((t) => ({
      id: t.id,
      description: t.description || t.action,
      riskLevel: t.riskLevel,
      readOnly: t.readOnly,
      requiredCapabilities: t.capabilities,
      provider: t.providerId,
    }));
  res.json({ tools: [...githubTools, ...providerTools] });
});

router.get('/pending', authMiddleware, async (req: AuthRequest, res: Response) => {
  const pending = await listPendingActions(req.user!.id);
  res.json({ pending });
});

router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  res.json({ tool: toolView(String(req.params.id)) });
});

router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const toolId = String(req.body?.toolId || '');
  const connectionId = String(req.body?.connectionId || '');
  if (!toolId || !connectionId) {
    res.status(400).json({ error: 'toolId and connectionId are required' });
    return;
  }
  try {
    const out = await createAction({
      userId,
      connectionId,
      toolId,
      args: req.body?.args,
      traceId: req.body?.traceId ? String(req.body.traceId) : undefined,
      requestedBy: req.body?.deviceId ? String(req.body.deviceId) : undefined,
    });
    res.status(out.executed || out.status === 'pending' ? 201 : 200).json({ ...out, tool: toolView(toolId) });
  } catch (err: any) {
    const status = err.message?.includes('Connection not found') || err.message?.includes('Unknown tool') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.post('/:id/approve', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const out = await approveAction(req.user!.id, String(req.params.id), req.body?.deviceId ? String(req.body.deviceId) : undefined);
    res.json(out);
  } catch (err: any) {
    res.status(err.message === 'Action not found' ? 404 : 500).json({ error: err.message });
  }
});

router.post('/:id/reject', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const out = await rejectAction(
      req.user!.id,
      String(req.params.id),
      req.body?.deviceId ? String(req.body.deviceId) : undefined,
      req.body?.reason ? String(req.body.reason) : undefined,
    );
    res.json(out);
  } catch (err: any) {
    res.status(err.message === 'Action not found' ? 404 : 500).json({ error: err.message });
  }
});

export default router;
