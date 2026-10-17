import { Router, Response } from 'express';
import { prisma } from '../services/db';
import { authMiddleware, AuthRequest, adminAuth } from '../middleware/auth';

const router = Router();

router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { type, title, content, attachments } = req.body;
    if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: '标题和内容必填' });
    const feedback = await prisma.feedback.create({
      data: { userId: req.user!.id, type: type || 'bug', title: title.trim(), content: content.trim(), attachments: attachments || null },
    });
    res.status(201).json({ feedback });
  } catch { res.status(500).json({ error: '提交失败' }); }
});

router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const feedbacks = await prisma.feedback.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' } });
    res.json({ feedbacks });
  } catch { res.status(500).json({ error: '获取反馈失败' }); }
});

router.get('/admin', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const status = String(req.query.status || '');
    const where: any = {};
    if (status) where.status = status;
    const feedbacks = await prisma.feedback.findMany({
      where, include: { user: { select: { username: true, email: true } } }, orderBy: { createdAt: 'desc' }, take: 100,
    });
    res.json({ feedbacks });
  } catch { res.status(500).json({ error: '获取反馈失败' }); }
});

router.patch('/admin/:id', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { status, reply } = req.body;
    const data: any = {};
    if (status) data.status = status;
    if (reply !== undefined) data.reply = reply;
    const feedback = await prisma.feedback.update({ where: { id: String(req.params.id) }, data });
    res.json({ feedback });
  } catch { res.status(500).json({ error: '更新失败' }); }
});

export default router;