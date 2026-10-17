import { Router, Response } from 'express';
import { prisma } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getActiveBatches, getExpiringBatches, addCredits } from '../services/credits';

const router = Router();

router.get('/balance', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: '用户不存在' });
    const batches = await getActiveBatches(user.id);
    res.json({ balance: user.creditBalance, frozen: user.frozenCredits, batches });
  } catch {
    res.status(500).json({ error: '获取余额失败' });
  }
});

router.get('/transactions', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      prisma.creditTransaction.findMany({
        where: { userId: req.user!.id },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.creditTransaction.count({ where: { userId: req.user!.id } }),
    ]);

    res.json({ transactions, total, page, pages: Math.ceil(total / limit) });
  } catch {
    res.status(500).json({ error: '获取交易记录失败' });
  }
});

router.get('/packs', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const { getDynamicPacks } = await import('../services/configSync');
    res.json({ packs: getDynamicPacks() });
  } catch {
    res.status(500).json({ error: '获取积分包失败' });
  }
});

router.get('/batches', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const batches = await getActiveBatches(req.user!.id);
    const expiring = await getExpiringBatches(req.user!.id, 14);
    res.json({ batches, expiring });
  } catch {
    res.status(500).json({ error: '获取积分批次失败' });
  }
});

router.post('/add', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user!.role !== 'ADMIN' && req.user!.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: '需要管理员权限' });
    }
    const { amount, type, description, userId } = req.body;
    const targetId = userId || req.user!.id;
    const newBalance = await addCredits(targetId, amount, type || 'manual', description);
    res.json({ balance: newBalance });
  } catch {
    res.status(500).json({ error: '添加积分失败' });
  }
});

export default router;