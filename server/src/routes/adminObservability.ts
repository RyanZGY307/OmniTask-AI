import { Router, Response } from 'express';
import { authMiddleware, adminAuth, AuthRequest } from '../middleware/auth';
import { prisma } from '../services/db';

const router = Router();

router.use(authMiddleware, adminAuth);

router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const hours = parseInt(String(req.query.hours)) || 24;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const [
      totalRequests, successCount, failedCount,
      totalTokensResult, totalCreditsResult, totalCostResult, avgLatencyResult,
    ] = await Promise.all([
      prisma.requestTrace.count({ where: { createdAt: { gte: since } } }),
      prisma.requestTrace.count({ where: { createdAt: { gte: since }, status: 'SUCCESS' } }),
      prisma.requestTrace.count({ where: { createdAt: { gte: since }, status: { in: ['FAILED', 'TIMEOUT'] } } }),
      prisma.requestTrace.aggregate({ where: { createdAt: { gte: since } }, _sum: { totalTokens: true } }),
      prisma.billingTransaction.aggregate({ where: { createdAt: { gte: since }, reason: 'ai_usage' }, _sum: { amount: true } }),
      prisma.requestTrace.aggregate({ where: { createdAt: { gte: since } }, _sum: { totalApiCostUsd: true } }),
      prisma.requestTrace.aggregate({ where: { createdAt: { gte: since }, durationMs: { not: null } }, _avg: { durationMs: true } }),
    ]);

    const successRate = totalRequests > 0 ? (successCount / totalRequests * 100) : 100;
    const errorRate = totalRequests > 0 ? (failedCount / totalRequests * 100) : 0;

    const perModel = await prisma.requestTrace.groupBy({
      by: ['selectedModel'],
      where: { createdAt: { gte: since }, selectedModel: { not: null } },
      _count: { id: true },
      _sum: { totalTokens: true, totalApiCostUsd: true },
      _avg: { durationMs: true },
    });

    const perModelStats = await Promise.all(
      perModel.map(async (m) => {
        const failed = await prisma.requestTrace.count({
          where: { createdAt: { gte: since }, selectedModel: m.selectedModel, status: { in: ['FAILED', 'TIMEOUT'] } },
        });
        return {
          model: m.selectedModel,
          requests: m._count.id,
          totalTokens: m._sum.totalTokens || 0,
          totalCostUsd: m._sum.totalApiCostUsd || 0,
          avgLatencyMs: Math.round(m._avg.durationMs || 0),
          errorRate: m._count.id > 0 ? (failed / m._count.id * 100) : 0,
        };
      }),
    );

    res.json({
      period: `${hours}h`, totalRequests,
      successRate: Math.round(successRate * 10) / 10,
      errorRate: Math.round(errorRate * 10) / 10,
      totalTokens: totalTokensResult._sum.totalTokens || 0,
      totalCreditsUsed: Math.abs(totalCreditsResult._sum.amount || 0),
      totalApiCostUsd: totalCostResult._sum.totalApiCostUsd || 0,
      avgLatencyMs: Math.round(avgLatencyResult._avg.durationMs || 0),
      perModel: perModelStats,
    });
  } catch (err) {
    console.error('Observability stats error:', err);
    res.status(500).json({ error: '获取统计失败' });
  }
});

router.get('/traces', async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page)) || 1;
    const limit = Math.min(parseInt(String(req.query.limit)) || 50, 200);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.model) where.selectedModel = { contains: String(req.query.model) };
    if (req.query.userId) where.userId = req.query.userId;
    if (req.query.conversationId) where.conversationId = req.query.conversationId;

    if (req.query.search) {
      const search = String(req.query.search);
      where.OR = [
        { id: { contains: search } },
        { requestId: { contains: search } },
        { selectedModel: { contains: search } },
      ];
    }

    if (req.query.from || req.query.to) {
      where.createdAt = {};
      if (req.query.from) where.createdAt.gte = new Date(String(req.query.from));
      if (req.query.to) where.createdAt.lte = new Date(String(req.query.to));
    }

    const [traces, total] = await Promise.all([
      prisma.requestTrace.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, requestId: true, userId: true, conversationId: true,
          createdAt: true, durationMs: true, status: true,
          selectedModel: true, provider: true, mode: true,
          totalTokens: true, inputTokens: true, outputTokens: true,
          creditsCharged: true, totalApiCostUsd: true,
          ttftMs: true, finishReason: true,
        },
      }),
      prisma.requestTrace.count({ where }),
    ]);

    res.json({ traces, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Traces list error:', err);
    res.status(500).json({ error: '获取请求列表失败' });
  }
});

router.get('/traces/:id', async (req: AuthRequest, res: Response) => {
  try {
    const trace = await prisma.requestTrace.findUnique({
      where: { id: String(req.params.id) },
      include: {
        events: { orderBy: { timestamp: 'asc' } },
        modelCalls: true,
        toolCalls: true,
        errors: true,
        billingTransactions: true,
      },
    });

    if (!trace) return res.status(404).json({ error: 'Trace not found' });
    res.json({ trace });
  } catch (err) {
    console.error('Trace detail error:', err);
    res.status(500).json({ error: '获取请求详情失败' });
  }
});

router.get('/errors', async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page)) || 1;
    const limit = Math.min(parseInt(String(req.query.limit)) || 50, 200);
    const skip = (page - 1) * limit;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const where: any = { createdAt: { gte: since } };
    if (req.query.severity) where.severity = req.query.severity;
    if (req.query.stage) where.stage = req.query.stage;
    if (req.query.errorType) where.errorType = req.query.errorType;

    const [errors, total] = await Promise.all([
      prisma.errorLog.findMany({
        where, skip, take: limit,
        orderBy: { timestamp: 'desc' },
        include: { trace: { select: { id: true, selectedModel: true, userId: true } } },
      }),
      prisma.errorLog.count({ where }),
    ]);

    res.json({ errors, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Errors list error:', err);
    res.status(500).json({ error: '获取错误列表失败' });
  }
});

router.get('/billing', async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page)) || 1;
    const limit = Math.min(parseInt(String(req.query.limit)) || 50, 200);
    const skip = (page - 1) * limit;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const where: any = { createdAt: { gte: since } };
    if (req.query.userId) where.userId = req.query.userId;
    if (req.query.model) where.model = String(req.query.model);

    const [transactions, total] = await Promise.all([
      prisma.billingTransaction.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.billingTransaction.count({ where }),
    ]);

    res.json({ transactions, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Billing list error:', err);
    res.status(500).json({ error: '获取计费列表失败' });
  }
});

export default router;