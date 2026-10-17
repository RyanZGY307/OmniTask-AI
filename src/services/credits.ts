import { addBillingTransaction } from './trace';
import { prisma } from './db';
import { chargeCredits, grantCredits, refundCredits as ledgerRefund } from './finance/billingLedger';

export async function deductCredits(
  userId: string,
  amount: number,
  model: string,
  description?: string,
  traceId?: string,
  requestId?: string,
): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');
  if (user.creditBalance < amount) throw new Error('积分不足');

  const balanceBefore = user.creditBalance;

  const result = await chargeCredits({
    userId,
    credits: amount,
    idempotencyKey: requestId ? `bill_${requestId}` : `deduct_${userId}_${traceId || Date.now()}`,
    model,
    description: description || `模型调用: ${model}`,
    traceId,
    requestId,
    creditsUsed: amount,
  });

  if (traceId && !result.duplicate) {
    await addBillingTransaction(traceId, {
      requestId,
      userId,
      amount: -amount,
      balanceBefore,
      balanceAfter: result.balanceAfter,
      reason: 'ai_usage',
      model,
      pricingVersion: '2026-09',
      idempotencyKey: requestId ? `bill_${requestId}` : undefined,
    });
  }

  return result.balanceAfter;
}

export async function refundCredits(
  userId: string,
  amount: number,
  model: string,
  traceId?: string,
  requestId?: string,
): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  const balanceBefore = user.creditBalance;

  const result = await ledgerRefund({
    userId,
    credits: amount,
    idempotencyKey: requestId ? `refund_bill_${requestId}` : `refund_${userId}_${traceId || Date.now()}`,
    model,
    description: `退款: ${model}`,
    traceId,
    requestId,
  });

  if (traceId && !result.duplicate) {
    await addBillingTransaction(traceId, {
      requestId,
      userId,
      amount,
      balanceBefore,
      balanceAfter: result.balanceAfter,
      reason: 'refund',
      model,
      pricingVersion: '2026-09',
    });
  }

  return result.balanceAfter;
}

export async function addCredits(userId: string, amount: number, type: string, description?: string): Promise<number> {
  const result = await grantCredits({
    userId,
    credits: amount,
    type: 'purchase',
    idempotencyKey: `grant_${type}_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    description,
  });
  return result.balanceAfter;
}

export async function addCreditPack(userId: string, credits: number, expiryDays: number, description: string): Promise<void> {
  await grantCredits({
    userId,
    credits,
    type: 'purchase',
    idempotencyKey: `pack_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    description,
    batch: { validDays: expiryDays, source: 'purchase' },
  });
}

export async function getActiveBatches(userId: string): Promise<any[]> {
  return prisma.creditBatch.findMany({ where: { userId, isActive: true, expiryDate: { gt: new Date() } }, orderBy: { expiryDate: 'asc' } });
}

export async function getExpiringBatches(userId: string, days: number): Promise<any[]> {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + days);
  return prisma.creditBatch.findMany({ where: { userId, isActive: true, expiryDate: { gt: new Date(), lt: futureDate } }, orderBy: { expiryDate: 'asc' } });
}

export async function checkDailyLimit(userId: string, feature: string): Promise<{ allowed: boolean; used: number; limit: number }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');
  const tier = user.subscriptionTier;
  const now = new Date();
  const limits: Record<string, Record<string, number>> = {
    // Free tier ships think/video/research unlimited (product decision);
    // only concurrency guards remain in the runtimes.
    think: { STANDARD: Infinity, PRO: Infinity, ULTRA: Infinity },
    video: { STANDARD: Infinity, PRO: Infinity, ULTRA: Infinity },
    research: { STANDARD: Infinity, PRO: Infinity, ULTRA: Infinity },
    // Audio generation is a product-defined FREE UNLIMITED capability:
    // neither tier deducts any quota and no daily counter exists. The
    // Infinity short-circuit below returns allowed:true immediately —
    // this limits PRODUCT entitlement only, not concurrency (which is
    // protected separately by the AudioConcurrencyGuard in the runtime).
    audio_generation: { STANDARD: Infinity, PRO: Infinity, ULTRA: Infinity },
  };
  const limit = limits[feature]?.[tier] ?? 0;
  if (limit === Infinity) return { allowed: true, used: 0, limit: -1 };
  let used = 0;
  let resetTime = new Date();
  if (feature === 'think') { used = user.dailyThinkUsed; resetTime = user.dailyThinkReset; }
  if (feature === 'video') { used = user.dailyVideoUsed; resetTime = user.dailyVideoReset; }
  if (feature === 'research') { used = user.dailyResearchUsed; resetTime = user.dailyResearchReset; }
  if (now > resetTime) {
    used = 0;
    const newReset = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    if (feature === 'think') await prisma.user.update({ where: { id: userId }, data: { dailyThinkUsed: 0, dailyThinkReset: newReset } });
    if (feature === 'video') await prisma.user.update({ where: { id: userId }, data: { dailyVideoUsed: 0, dailyVideoReset: newReset } });
    if (feature === 'research') await prisma.user.update({ where: { id: userId }, data: { dailyResearchUsed: 0, dailyResearchReset: newReset } });
  }
  return { allowed: used < limit, used, limit };
}

export async function incrementDailyUsage(userId: string, feature: string): Promise<void> {
  // Increment atomically capped to the per-feature daily limit so a burst of
  // concurrent requests cannot push the counter past the limit (TOCTOU fix).
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;
  const tier = user.subscriptionTier;
  const limits: Record<string, Record<string, number>> = {
    think: { STANDARD: Infinity, PRO: Infinity, ULTRA: Infinity },
    video: { STANDARD: Infinity, PRO: Infinity, ULTRA: Infinity },
    research: { STANDARD: Infinity, PRO: Infinity, ULTRA: Infinity },
    // Audio generation is unlimited for all tiers — never increment any
    // counter. (Mirror of the checkDailyLimit table above.)
    audio_generation: { STANDARD: Infinity, PRO: Infinity, ULTRA: Infinity },
  };
  const limit = limits[feature]?.[tier] ?? 0;
  if (limit === Infinity) {
    if (feature === 'think') await prisma.user.update({ where: { id: userId }, data: { dailyThinkUsed: { increment: 1 } } });
    if (feature === 'video') await prisma.user.update({ where: { id: userId }, data: { dailyVideoUsed: { increment: 1 } } });
    if (feature === 'research') await prisma.user.update({ where: { id: userId }, data: { dailyResearchUsed: { increment: 1 } } });
    return;
  }
  // Only increment when the current value is still under the limit; this keeps
  // concurrent increments bounded by the tier limit (last one that sees
  // used < limit wins).
  if (feature === 'think') {
    await prisma.user.updateMany({
      where: { id: userId, dailyThinkUsed: { lt: limit } },
      data: { dailyThinkUsed: { increment: 1 } },
    });
  } else if (feature === 'video') {
    await prisma.user.updateMany({
      where: { id: userId, dailyVideoUsed: { lt: limit } },
      data: { dailyVideoUsed: { increment: 1 } },
    });
  } else if (feature === 'research') {
    await prisma.user.updateMany({
      where: { id: userId, dailyResearchUsed: { lt: limit } },
      data: { dailyResearchUsed: { increment: 1 } },
    });
  }
}