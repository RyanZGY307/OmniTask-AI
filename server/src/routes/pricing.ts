// ================================================================
// Pricing API — current prices, audit & admin trigger
// ================================================================
//
// R10.3: the server is the only source of authoritative prices.
// R10.2: LLM code paths never set prices here.
// R6.4: historical orders remain restorable from saved versions.

import { Router, Response } from 'express';
import { authMiddleware, adminAuth, AuthRequest } from '../middleware/auth';
import { prisma } from '../services/db';
import {
  getActivePricingVersion,
  runDailyPricingJob,
  bootstrapInitialPricingVersion,
} from '../services/finance/pricingEngine';
import { getActiveFxVersion } from '../services/finance/fxVersion';

const router = Router();

// Public, authoritative current pricing for client display
router.get('/current', authMiddleware, async (_req: AuthRequest, res: Response) => {
  try {
    const [active, fx] = await Promise.all([getActivePricingVersion(), getActiveFxVersion()]);
    res.json({
      active,
      fx: fx ? { id: fx.id, rate: fx.rate.toFixed(10), fetchedAt: fx.fetchedAt } : null,
    });
  } catch (err) {
    console.error('GET /pricing/current:', err);
    res.status(500).json({ error: '获取定价失败' });
  }
});

// Admin: trigger the daily pricing job manually
router.post('/admin/run', authMiddleware, adminAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const report = await runDailyPricingJob();
    res.json(report);
  } catch (err: any) {
    console.error('POST /pricing/admin/run:', err);
    res.status(500).json({ error: '定价任务执行失败' });
  }
});

// Admin: bootstrap the initial pricing version
router.post('/admin/bootstrap', authMiddleware, adminAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await bootstrapInitialPricingVersion();
    res.json(result);
  } catch (err: any) {
    console.error('POST /pricing/admin/bootstrap:', err);
    res.status(500).json({ error: '定价初始化失败' });
  }
});

// Admin: pricing version history
router.get('/admin/history', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit)) || 20, 100);
    const rows = await prisma.pricingVersion.findMany({
      take: limit,
      orderBy: { publishedAt: 'desc' },
      include: { creditPricingVersion: true, fxVersion: true },
    });
    res.json({ versions: rows });
  } catch (err) {
    console.error('GET /pricing/admin/history:', err);
    res.status(500).json({ error: '获取定价历史失败' });
  }
});

// Admin: FX version history
router.get('/admin/fx', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit)) || 20, 100);
    const rows = await prisma.fxVersion.findMany({ take: limit, orderBy: { fetchedAt: 'desc' } });
    res.json({ versions: rows });
  } catch (err) {
    console.error('GET /pricing/admin/fx:', err);
    res.status(500).json({ error: '获取汇率历史失败' });
  }
});

// Admin: restore an order's full pricing/cost context (R6.4)
router.get('/admin/order/:orderId/context', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const orderId = String(req.params.orderId);
    const order = await prisma.paymentOrder.findUnique({
      where: { orderId },
    });
    if (!order) return res.status(404).json({ error: '订单不存在' });

    const context: any = {
      orderId,
      plan: order.plan,
      currency: order.currency,
      expectedAmount: order.expectedAmount,
      lockedPriceUsd: order.lockedPriceUsd ? order.lockedPriceUsd.toFixed(10) : null,
      lockedCredits: order.lockedCredits,
      creditValidDays: order.creditValidDays,
      creditGranted: order.creditGranted,
      pricingVersionId: order.pricingVersionId,
      fxVersionId: order.fxVersionId,
      providerPricingVersionId: order.providerPricingVersionId,
      creditPricingVersionId: order.creditPricingVersionId,
    };

    if (order.creditPricingVersionId) {
      const cpv = await prisma.creditPricingVersion.findUnique({ where: { id: order.creditPricingVersionId } });
      context.creditPricing = cpv;
    }
    if (order.fxVersionId) {
      const fx = await prisma.fxVersion.findUnique({ where: { id: order.fxVersionId } });
      context.fx = fx ? { rate: fx.rate.toFixed(10), fetchedAt: fx.fetchedAt } : null;
    }

    res.json({ context });
  } catch (err) {
    console.error('GET /pricing/admin/order context:', err);
    res.status(500).json({ error: '获取订单定价上下文失败' });
  }
});

// Admin: billing ledger for a user
router.get('/admin/ledger/:userId', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit)) || 50, 500);
    const entries = await prisma.creditLedger.findMany({
      where: { userId: String(req.params.userId) },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    res.json({ entries });
  } catch (err) {
    console.error('GET /pricing/admin/ledger:', err);
    res.status(500).json({ error: '获取账务记录失败' });
  }
});

export default router;
