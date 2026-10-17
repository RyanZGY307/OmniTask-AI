import { prisma } from './db';

export function startOrderCleanupJob(): void {
  // Run every 5 minutes
  setInterval(async () => {
    try {
      const result = await prisma.paymentOrder.updateMany({
        where: {
          status: { in: ['AWAITING_PAYMENT'] },
          expiresAt: { lt: new Date() },
        },
        data: { status: 'EXPIRED' },
      });

      if (result.count > 0) {
        console.log(`[OrderCleanup] Expired ${result.count} orders`);
      }
    } catch (err) {
      console.error('[OrderCleanup] Error:', err);
    }
  }, 5 * 60 * 1000);

  console.log('[OrderCleanup] Scheduled (every 5 minutes)');
}