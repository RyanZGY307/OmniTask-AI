// ================================================================
// Expression Routes — Human-Like Expression Learning Runtime
// ================================================================

import { Router, Response } from 'express';
import { prisma } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import {
  getExpressionContext,
  learnFromUserMessage,
  applyFeedback,
  setAdaptationStrength,
  deletePattern,
  applyExpressionDecay,
} from '../services/expressionLearning';

const router = Router();

router.get('/profile', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const profile = await prisma.expressionProfile.findUnique({
      where: { userId: req.user!.id },
      include: {
        patterns: { where: { status: { in: ['active', 'learning'] } }, orderBy: { confidence: 'desc' } },
        emojis: { where: { status: { in: ['active', 'learning'] } }, orderBy: { confidence: 'desc' } },
        dialects: { where: { status: { in: ['active', 'learning'] } }, orderBy: { confidence: 'desc' } },
      },
    });
    if (!profile) return res.json({ profile: null });
    res.json({ profile });
  } catch {
    res.status(500).json({ error: '获取表达画像失败' });
  }
});

router.get('/patterns', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const profile = await prisma.expressionProfile.findUnique({ where: { userId: req.user!.id } });
    if (!profile) return res.json({ patterns: [] });
    const dimension = req.query.dimension ? String(req.query.dimension) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const patterns = await prisma.expressionPattern.findMany({
      where: {
        expressionProfileId: profile.id,
        ...(dimension ? { dimension } : {}),
        ...(status ? { status } : { status: { in: ['active', 'learning', 'disabled', 'superseded'] } }),
      },
      orderBy: { confidence: 'desc' },
    });
    res.json({ patterns });
  } catch {
    res.status(500).json({ error: '获取表达模式失败' });
  }
});

router.post('/learn', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const message = String(req.body?.message || '');
    if (!message.trim()) return res.status(400).json({ error: '缺少 message' });
    const result = await learnFromUserMessage(req.user!.id, message, { language: req.body?.language });
    res.json(result);
  } catch {
    res.status(500).json({ error: '学习失败' });
  }
});

router.post('/feedback', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { action, patternId, targetPattern, correction, note } = req.body || {};
    if (!action) return res.status(400).json({ error: '缺少 action' });
    const ok = await applyFeedback(req.user!.id, {
      action,
      patternId,
      targetPattern,
      correction,
      note,
    });
    if (!ok) return res.status(400).json({ error: '反馈未应用（画像不存在或参数无效）' });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: '提交反馈失败' });
  }
});

router.put('/strength', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const strength = Number(req.body?.strength);
    if (Number.isNaN(strength)) return res.status(400).json({ error: 'strength 必须为 0-3' });
    const ok = await setAdaptationStrength(req.user!.id, strength);
    if (!ok) return res.status(400).json({ error: '画像不存在' });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: '设置强度失败' });
  }
});

router.delete('/patterns/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const ok = await deletePattern(req.user!.id, String(req.params.id));
    if (!ok) return res.status(404).json({ error: '表达模式不存在' });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: '删除表达模式失败' });
  }
});

router.get('/history', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const profile = await prisma.expressionProfile.findUnique({ where: { userId: req.user!.id } });
    if (!profile) return res.json({ history: [] });
    const history = await prisma.expressionFeedback.findMany({
      where: { expressionProfileId: profile.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ history });
  } catch {
    res.status(500).json({ error: '获取学习历史失败' });
  }
});

router.post('/decay', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const result = await applyExpressionDecay(req.user!.id);
    res.json(result);
  } catch {
    res.status(500).json({ error: '衰减处理失败' });
  }
});

export default router;
