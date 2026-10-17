import { Router, Response } from 'express';
import { prismaKnowledge } from '../services/db';
import { authMiddleware, adminAuth, AuthRequest } from '../middleware/auth';
import { getTodayBudget, setSystemPoolTotal, incrementBudgetCounter } from '../services/evolutionBudget';

const router = Router();
router.use(authMiddleware);

router.get('/dashboard', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const budget = await getTodayBudget();
    const [totalSignals, totalCandidates, promoted, rejected] = await Promise.all([
      prismaKnowledge.evolutionSignal.count(),
      prismaKnowledge.evolutionCandidate.count(),
      prismaKnowledge.evolutionCandidate.count({ where: { status: 'promoted' } }),
      prismaKnowledge.evolutionCandidate.count({ where: { status: 'rejected' } }),
    ]);
    res.json({ budget, totalSignals, totalCandidates, promoted, rejected });
  } catch { res.status(500).json({ error: '获取进化仪表盘失败' }); }
});

router.get('/signals', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page)) || 1;
    const limit = parseInt(String(req.query.limit)) || 20;
    const skip = (page - 1) * limit;
    const [signals, total] = await Promise.all([
      prismaKnowledge.evolutionSignal.findMany({ skip, take: limit, orderBy: { createdAt: 'desc' } }),
      prismaKnowledge.evolutionSignal.count(),
    ]);
    res.json({ signals, total, page, pages: Math.ceil(total / limit) });
  } catch { res.status(500).json({ error: '获取信号失败' }); }
});

router.get('/candidates', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const status = String(req.query.status || '');
    const page = parseInt(String(req.query.page)) || 1;
    const limit = parseInt(String(req.query.limit)) || 20;
    const skip = (page - 1) * limit;
    const where: any = {};
    if (status) where.status = status;
    const [candidates, total] = await Promise.all([
      prismaKnowledge.evolutionCandidate.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      prismaKnowledge.evolutionCandidate.count({ where }),
    ]);
    res.json({ candidates, total, page, pages: Math.ceil(total / limit) });
  } catch { res.status(500).json({ error: '获取候选失败' }); }
});

router.get('/reports', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page)) || 1;
    const limit = parseInt(String(req.query.limit)) || 20;
    const skip = (page - 1) * limit;
    const [reports, total] = await Promise.all([
      prismaKnowledge.evaluationReport.findMany({ skip, take: limit, orderBy: { createdAt: 'desc' } }),
      prismaKnowledge.evaluationReport.count(),
    ]);
    res.json({ reports, total, page, pages: Math.ceil(total / limit) });
  } catch { res.status(500).json({ error: '获取报告失败' }); }
});

router.get('/insights', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const region = String(req.query.region || '');
    const where: any = { isActive: true };
    if (region) where.region = region;
    const insights = await prismaKnowledge.regionInsight.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 50 });
    res.json({ insights });
  } catch { res.status(500).json({ error: '获取洞察失败' }); }
});

router.get('/budget', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const budget = await getTodayBudget();
    res.json({ budget });
  } catch { res.status(500).json({ error: '获取预算失败' }); }
});

router.post('/budget/pool', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { total } = req.body;
    const budget = await setSystemPoolTotal(total);
    res.json({ budget });
  } catch { res.status(500).json({ error: '更新预算失败' }); }
});

router.post('/candidates/:id/promote', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const candidate = await prismaKnowledge.evolutionCandidate.update({
      where: { id: String(req.params.id) },
      data: { status: 'promoted', promotedAt: new Date() },
    });
    await incrementBudgetCounter('promoteCount');
    res.json({ candidate });
  } catch { res.status(500).json({ error: '提升失败' }); }
});

router.post('/candidates/:id/reject', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { reason } = req.body;
    const candidate = await prismaKnowledge.evolutionCandidate.update({
      where: { id: String(req.params.id) },
      data: { status: 'rejected', rejectedAt: new Date(), rejectReason: reason },
    });
    await incrementBudgetCounter('rejectCount');
    res.json({ candidate });
  } catch { res.status(500).json({ error: '拒绝失败' }); }
});

router.get('/audit', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page)) || 1;
    const limit = parseInt(String(req.query.limit)) || 20;
    const skip = (page - 1) * limit;
    const [logs, total] = await Promise.all([
      prismaKnowledge.evolutionAudit.findMany({ skip, take: limit, orderBy: { createdAt: 'desc' } }),
      prismaKnowledge.evolutionAudit.count(),
    ]);
    res.json({ logs, total, page, pages: Math.ceil(total / limit) });
  } catch { res.status(500).json({ error: '获取审计日志失败' }); }
});

export default router;