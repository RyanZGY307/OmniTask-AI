import { Router, Response } from 'express';
import { prisma } from '../services/db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

// ===== Existing endpoints (unchanged) =====

router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const entries = await prisma.memoryEntry.findMany({ where: { userId: req.user!.id, isActive: true }, orderBy: { updatedAt: 'desc' }, take: 50 });
    res.json({ entries });
  } catch { res.status(500).json({ error: '获取记忆失败' }); }
});

router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { content, category, level } = req.body;
    const entry = await prisma.memoryEntry.create({ data: { userId: req.user!.id, content, category: category || 'general', level: level || 1 } });
    res.json({ entry });
  } catch { res.status(500).json({ error: '创建记忆失败' }); }
});

router.put('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    // 先确认归属：MemoryEntry 属当前登录用户，且不允许改写 userId
    const existing = await prisma.memoryEntry.findUnique({ where: { id: String(req.params.id) } });
    if (!existing || existing.userId !== req.user!.id) return res.status(404).json({ error: '记忆不存在' });
    const { content, category, level, isActive } = req.body || {};
    const data: { content?: string; category?: string; level?: number; isActive?: boolean } = {};
    if (typeof content === 'string') data.content = content;
    if (typeof category === 'string') data.category = category;
    if (typeof level === 'number') data.level = level;
    if (typeof isActive === 'boolean') data.isActive = isActive;
    const entry = await prisma.memoryEntry.update({ where: { id: existing.id }, data });
    res.json({ entry });
  } catch { res.status(500).json({ error: '更新记忆失败' }); }
});

router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.memoryEntry.findUnique({ where: { id: String(req.params.id) } });
    if (!existing || existing.userId !== req.user!.id) return res.status(404).json({ error: '记忆不存在' });
    await prisma.memoryEntry.update({ where: { id: existing.id }, data: { isActive: false } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: '删除记忆失败' }); }
});

// ===== New: Long-Term Memory endpoints =====

router.get('/long-term', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { type, status, limit } = req.query;
    const where: any = { userId: req.user!.id };
    if (type) where.type = String(type);
    if (status) where.status = String(status);
    else where.status = { in: ['active', 'reinforced'] };

    const entries = await prisma.longTermMemory.findMany({
      where,
      orderBy: { importance: 'desc' },
      take: parseInt(String(limit)) || 50,
    });
    res.json({ entries, total: entries.length });
  } catch { res.status(500).json({ error: '获取长期记忆失败' }); }
});

router.delete('/long-term/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const mem = await prisma.longTermMemory.findUnique({ where: { id: String(req.params.id) } });
    if (!mem || mem.userId !== req.user!.id) return res.status(404).json({ error: '记忆不存在' });

    await prisma.longTermMemory.update({ where: { id: mem.id }, data: { status: 'deleted', deletedAt: new Date() } });
    await prisma.memoryEvent.create({ data: { memoryId: mem.id, eventType: 'deleted', detail: 'User requested deletion' } });

    res.json({ success: true });
  } catch { res.status(500).json({ error: '删除失败' }); }
});

router.get('/long-term/:id/events', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const mem = await prisma.longTermMemory.findUnique({ where: { id: String(req.params.id) } });
    if (!mem || mem.userId !== req.user!.id) return res.status(404).json({ error: '记忆不存在' });

    const events = await prisma.memoryEvent.findMany({
      where: { memoryId: mem.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ events });
  } catch { res.status(500).json({ error: '获取事件失败' }); }
});

// ===== New: File Memory endpoints =====

router.get('/files', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const files = await prisma.fileRecord.findMany({
      where: { userId: req.user!.id, status: 'active' },
      include: { _count: { select: { facts: true, versions: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    res.json({ files });
  } catch { res.status(500).json({ error: '获取文件列表失败' }); }
});

router.get('/files/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const file = await prisma.fileRecord.findUnique({
      where: { id: String(req.params.id) },
      include: { versions: { orderBy: { version: 'desc' } }, facts: { where: { status: 'active' } } },
    });
    if (!file || file.userId !== req.user!.id) return res.status(404).json({ error: '文件不存在' });
    res.json({ file });
  } catch { res.status(500).json({ error: '获取文件详情失败' }); }
});

export default router;