import { Router, Response } from 'express';
import { prisma } from '../services/db';
import { authMiddleware, adminAuth, AuthRequest } from '../middleware/auth';
import { getDynamicPacks, getDynamicPricing } from '../services/configSync';
import { RECIPIENTS } from '../config';
import { convertFromUSD } from '../services/exchangeRate';
import { preCheckProof, computeSHA256 } from '../services/paymentReview';
import { processProofPayment, processPayment, adminApprove } from '../services/paymentRuntime';
import { lockPackPricing, lockSubscriptionPricing } from '../services/finance/pricingEngine';

const router = Router();

// ==================== User: Create Order ====================

router.post('/orders', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { plan, paymentMethod } = req.body;
    if (!plan || !paymentMethod) return res.status(400).json({ error: '缺少参数' });

    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: '用户不存在' });

    const currency = user.currency || 'USD';
    let expectedAmount = 0;

    if (plan.startsWith('pack-')) {
      const pack = (getDynamicPacks() as any[]).find((p: any) => p.id === plan);
      if (!pack) return res.status(400).json({ error: '无效积分包' });
      expectedAmount = pack.price;
    } else if (plan === 'pro_monthly') {
      expectedAmount = getDynamicPricing().PRO.monthly;
    } else if (plan === 'pro_yearly') {
      expectedAmount = getDynamicPricing().PRO.yearly;
    } else {
      // The Ultra tier was retired: its plans are no longer sellable.
      if (plan === 'ultra_monthly' || plan === 'ultra_yearly') {
        return res.status(400).json({ error: '该套餐已下架，请购买 Pro 或积分包' });
      }
      return res.status(400).json({ error: '无效套餐' });
    }

    let localAmount = expectedAmount;
    if (currency !== 'USD') localAmount = await convertFromUSD(expectedAmount, currency);

    const recipients = (RECIPIENTS as any)[paymentMethod];
    if (!recipients) return res.status(400).json({ error: '无效支付方式' });

    // R6.1 / R11.2 — lock the active price and all four version identifiers on
    // order creation. Historical orders never see later pricing releases.
    let orderLock = plan.startsWith('pack-')
      ? await lockPackPricing(plan)
      : await lockSubscriptionPricing('PRO');

    if (orderLock) {
      // The authoritative customer price comes from the active Pricing Version.
      // The static config table is only a fallback for legacy orders.
      expectedAmount = orderLock.priceUsd.toNumber();
      localAmount = currency === 'USD' ? expectedAmount : await convertFromUSD(expectedAmount, currency);
    }

    const orderId = `OMNITASK-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const order = await prisma.paymentOrder.create({
      data: {
        orderId, userId: user.id, plan,
        expectedAmount: localAmount, currency, paymentMethod,
        recipient: recipients[0].name,
        status: 'AWAITING_PAYMENT',
        remainingAmount: localAmount, expiresAt,
        pricingVersionId: orderLock?.pricingVersionId ?? null,
        fxVersionId: orderLock?.fxVersionId ?? null,
        providerPricingVersionId: orderLock?.providerPricingVersionId ?? null,
        creditPricingVersionId: orderLock?.creditPricingVersionId ?? null,
        lockedPriceUsd: orderLock ? orderLock.priceUsd.toNumber() : null,
        lockedCredits: orderLock?.credits ?? null,
        creditValidDays: orderLock?.validDays ?? null,
      },
    });

    // Create initial Payment record (PENDING)
    await prisma.payment.create({
      data: {
        provider: paymentMethod.toUpperCase() as any,
        orderId,
        userId: user.id,
        amount: localAmount,
        currency,
        status: 'PENDING',
        sourceType: 'order_created',
      },
    });

    res.json({ order });
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ error: '创建订单失败' });
  }
});

// ==================== User: Get Active Order ====================

router.get('/orders', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const order = await prisma.paymentOrder.findFirst({
      where: { userId: req.user!.id, status: { in: ['AWAITING_PAYMENT', 'PROOF_UPLOADED', 'AI_REVIEWING', 'UNDERPAID', 'INVALID', 'SUSPECTED_TAMPERING'] } },
      orderBy: { createdAt: 'desc' },
      include: { proofs: true, reviews: true, transactions: true },
    });
    res.json({ order });
  } catch { res.status(500).json({ error: '获取订单失败' }); }
});

// ==================== User: Get Order Detail ====================

router.get('/orders/:orderId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const order = await prisma.paymentOrder.findUnique({
      where: { orderId: String(req.params.orderId) },
      include: { proofs: true, reviews: true, transactions: true, auditLogs: { orderBy: { createdAt: 'desc' } } },
    });
    if (!order || order.userId !== req.user!.id) return res.status(404).json({ error: '订单不存在' });
    res.json({ order });
  } catch { res.status(500).json({ error: '获取订单失败' }); }
});

// ==================== User: Cancel Order ====================
// 仅未进入人工审核的订单可以自行取消；已上传凭证/已入账的订单需走退款流程。
router.post('/orders/:orderId/cancel', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const order = await prisma.paymentOrder.findUnique({ where: { orderId: String(req.params.orderId) } });
    if (!order || order.userId !== req.user!.id) return res.status(404).json({ error: '订单不存在' });
    if (!['AWAITING_PAYMENT', 'PROOF_UPLOADED', 'AI_REVIEWING'].includes(order.status)) {
      return res.status(400).json({ error: '该订单已处理，无法取消' });
    }
    const updated = await prisma.paymentOrder.update({ where: { orderId: order.orderId }, data: { status: 'CANCELLED' } });
    res.json({ success: true, order: updated });
  } catch { res.status(500).json({ error: '取消订单失败' }); }
});

// ==================== User: Upload Proof (v2 Pipeline) ====================

router.post('/orders/:orderId/proofs', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const orderId = String(req.params.orderId);
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: '请上传截图' });

    const order = await prisma.paymentOrder.findUnique({ where: { orderId } });
    if (!order || order.userId !== req.user!.id) return res.status(404).json({ error: '订单不存在' });
    if (order.status === 'PAID') return res.status(400).json({ error: '订单已支付' });
    if (order.status === 'EXPIRED' || order.status === 'CANCELLED') return res.status(400).json({ error: '订单已过期或取消' });
    if (new Date() > order.expiresAt) {
      await prisma.paymentOrder.update({ where: { orderId }, data: { status: 'EXPIRED' } });
      return res.status(400).json({ error: '订单已过期' });
    }

    const fileHash = computeSHA256(Buffer.from(imageBase64, 'base64'));
    const proof = await prisma.paymentProof.create({
      data: { orderId, userId: req.user!.id, fileUrl: `proofs/${orderId}/${Date.now()}.jpg`, fileHash },
    });
    await prisma.paymentOrder.update({ where: { orderId }, data: { status: 'AI_REVIEWING' } });

    // Step 1: Pre-check (OCR + basic validations)
    const preCheck = await preCheckProof(orderId, proof.id, imageBase64, new Date());

    if (preCheck.decision !== 'PASS_TO_RUNTIME') {
      // Map pre-check failures to order status
      const statusMap: Record<string, string> = {
        'WINDOW_OBSTRUCTION': 'INVALID',
        'PAYMENT_METHOD_MISMATCH': 'INVALID',
        'AMOUNT_UNREADABLE': 'INVALID',
        'UPLOAD_TOO_LATE': 'INVALID',
        'DATE_BEFORE_ORDER': 'INVALID',
        'DUPLICATE_FILE': 'INVALID',
      };

      await prisma.paymentOrder.update({
        where: { orderId },
        data: { status: (statusMap[preCheck.decision] || 'INVALID') as any },
      });

      await prisma.paymentReview.create({
        data: {
          orderId, proofId: proof.id,
          decision: preCheck.decision as any,
          aiOutput: preCheck.ocr as any,
          riskScore: preCheck.riskScore,
          reason: preCheck.reason,
        },
      });

      await prisma.paymentAuditLog.create({
        data: { orderId, action: preCheck.decision, detail: preCheck.reason },
      });

      return res.json({
        order: await prisma.paymentOrder.findUnique({ where: { orderId }, include: { proofs: true, reviews: true, transactions: true } }),
        review: { decision: preCheck.decision, reason: preCheck.reason, riskScore: preCheck.riskScore },
      });
    }

    // Step 2: Process through Payment Runtime (attribution → verification → billing → credit)
    const result = await processProofPayment(orderId, proof.id, preCheck.ocr, req.user!.id);

    // Save review record for backward compatibility
    const reviewDecision = result.status === 'completed' ? 'PASS' :
      result.status === 'verification_failed' ? 'AMOUNT_MISMATCH' : 'INVALID_PROOF';

    await prisma.paymentReview.create({
      data: {
        orderId, proofId: proof.id,
        decision: reviewDecision as any,
        aiOutput: preCheck.ocr as any,
        riskScore: result.status === 'completed' ? 0 : 0.5,
        reason: result.reason,
      },
    });

    await prisma.paymentAuditLog.create({
      data: { orderId, action: 'PAYMENT_PROCESSED', detail: `Status: ${result.status}. ${result.reason}` },
    });

    const updatedOrder = await prisma.paymentOrder.findUnique({
      where: { orderId },
      include: { proofs: true, reviews: true, transactions: true },
    });

    res.json({
      order: updatedOrder,
      review: {
        decision: reviewDecision,
        reason: result.reason,
        riskScore: result.status === 'completed' ? 0 : 0.5,
        remainingAmount: updatedOrder?.remainingAmount,
        creditGranted: result.creditGranted,
        balanceAfter: result.balanceAfter,
      },
      paymentId: result.paymentId,
      attributionStatus: result.attribution.status,
    });
  } catch (err) {
    console.error('Upload proof error:', err);
    res.status(500).json({ error: '上传失败' });
  }
});

// ==================== User: Get QR Code ====================

router.get('/qr/:method', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const qr = await prisma.paymentQRCode.findUnique({ where: { method: String(req.params.method) } });
    if (!qr || !qr.isActive) return res.status(404).json({ error: '暂无此支付方式' });
    res.json({ qr });
  } catch { res.status(500).json({ error: '获取失败' }); }
});

// ==================== User: Get Pricing / Prices ====================
// 前端 settings/payment 页一次性拉取：币别、模型/会员价目、充值包、支付方式。
// 注册在 /orders/:orderId 之前以保证静态路径优先匹配。

router.get('/prices', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const currency = String(req.query.currency || 'CNY').toUpperCase();
    const packs = getDynamicPacks();
    const methods = Object.entries(RECIPIENTS).map(([key, recipients]) => {
      const first = (recipients as any[])[0];
      return { id: key, method: key, label: first?.label, name: first?.name, active: !!first };
    }).filter((m) => m.active);

    res.json({
      currency,
      prices: getDynamicPricing(),
      packPrices: packs.map((p) => ({
        id: p.id,
        credits: p.credits,
        priceUsd: p.price,
        currency: p.currency,
      })),
      paymentMethods: methods,
    });
  } catch {
    res.status(500).json({ error: '获取失败' });
  }
});

// ==================== User: Get Payment Methods ====================

router.get('/methods', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const methods = Object.entries(RECIPIENTS).map(([key, recipients]) => ({
      id: key,
      name: (recipients as any[])[0].label,
      recipient: (recipients as any[])[0].name,
    }));
    res.json({ methods });
  } catch { res.status(500).json({ error: '获取失败' }); }
});

// ==================== Admin: List Payments ====================

router.get('/admin/payments', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page)) || 1;
    const limit = Math.min(parseInt(String(req.query.limit)) || 50, 200);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.provider) where.provider = req.query.provider;
    if (req.query.attributionStatus) where.attributionStatus = req.query.attributionStatus;

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          attributions: { orderBy: { createdAt: 'desc' }, take: 1 },
          verifications: { orderBy: { createdAt: 'desc' }, take: 1 },
          evidences: true,
        },
      }),
      prisma.payment.count({ where }),
    ]);

    res.json({ payments, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Admin payments error:', err);
    res.status(500).json({ error: '获取支付列表失败' });
  }
});

// ==================== Admin: Get Payment Detail ====================

router.get('/admin/payments/:paymentId', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: String(req.params.paymentId) },
      include: {
        attributions: { orderBy: { createdAt: 'desc' } },
        verifications: { orderBy: { createdAt: 'desc' } },
        evidences: true,
        creditLedgerEntries: true,
        refund: true,
      },
    });
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    res.json({ payment });
  } catch (err) {
    console.error('Admin payment detail error:', err);
    res.status(500).json({ error: '获取支付详情失败' });
  }
});

// ==================== Admin: List Exceptions ====================

router.get('/admin/exceptions', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(String(req.query.page)) || 1;
    const limit = Math.min(parseInt(String(req.query.limit)) || 50, 200);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.type) where.exceptionType = req.query.type;

    const [exceptions, total] = await Promise.all([
      prisma.paymentException.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.paymentException.count({ where }),
    ]);

    res.json({ exceptions, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Admin exceptions error:', err);
    res.status(500).json({ error: '获取异常队列失败' });
  }
});

// ==================== Admin: Approve Payment ====================

router.post('/admin/payments/:paymentId/approve', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { orderId, userId, reason } = req.body;
    if (!orderId || !userId || !reason) return res.status(400).json({ error: '缺少参数' });

    const result = await adminApprove(
      String(req.params.paymentId),
      req.user!.id,
      orderId, userId, reason,
    );

    res.json({ result });
  } catch (err) {
    console.error('Admin approve error:', err);
    res.status(500).json({ error: '审批失败' });
  }
});

// ==================== Admin: Reject Payment ====================

router.post('/admin/payments/:paymentId/reject', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { reason } = req.body;
    const paymentId = String(req.params.paymentId);

    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'FAILED' },
    });

    await prisma.paymentException.updateMany({
      where: { paymentId, status: 'open' },
      data: {
        status: 'resolved',
        resolution: `Admin rejected: ${reason}`,
        resolvedBy: req.user!.id,
        resolvedAt: new Date(),
      },
    });

    await prisma.paymentAuditLog.create({
      data: { orderId: '', action: 'ADMIN_REJECT', detail: `Admin rejected payment ${paymentId}: ${reason}` },
    }).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error('Admin reject error:', err);
    res.status(500).json({ error: '拒绝失败' });
  }
});

// ==================== Admin: Ledger ====================

router.get('/admin/ledger', authMiddleware, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.query.userId as string;
    const page = parseInt(String(req.query.page)) || 1;
    const limit = Math.min(parseInt(String(req.query.limit)) || 50, 200);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (userId) where.userId = userId;

    const [entries, total] = await Promise.all([
      prisma.creditLedger.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.creditLedger.count({ where }),
    ]);

    res.json({ entries, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Admin ledger error:', err);
    res.status(500).json({ error: '获取积分账本失败' });
  }
});

export default router;