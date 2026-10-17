// ================================================================
// Payment Runtime — Orchestrator
// ================================================================
//
// detect → normalize → attribute → verify → billing → credit grant
//
// NEVER allows AI to directly execute credit grants.
// All financial operations go through CreditLedger.

import { prisma } from './db';
import { attribute, type AttributionInput, type AttributionResult } from './paymentAttribution';
import { verify, saveVerification, type VerificationInput, type VerificationResult } from './paymentVerification';
import { grantCredits } from './finance/billingLedger';
import { PERMANENT_PACK_VALID_DAYS } from '../config';

function toJson(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

// ==================== Provider Adapters (lazy loaded) ====================

async function getAdapter(provider: string) {
  switch (provider.toLowerCase()) {
    case 'tng': return import('./paymentAdapterTng');
    case 'shopeepay': return import('./paymentAdapterShopeePay');
    case 'paypal': return import('./paymentAdapterPaypal');
    case 'alipay': return import('./paymentAdapterAlipay');
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

// ==================== Process Incoming Payment ====================

export interface ProcessResult {
  paymentId: string;
  status: string;
  attribution: AttributionResult;
  verification?: VerificationResult;
  creditGranted?: number;
  balanceAfter?: number;
  reason: string;
}

export async function processPayment(
  provider: string,
  rawData: any,
  sourceType: string = 'unknown',
): Promise<ProcessResult> {
  // 1. Get adapter and normalize
  const adapter = await getAdapter(provider);
  const normalized = adapter.normalize(rawData);

  // 2. Build idempotency key
  const idempotencyKey = normalized.providerTransactionId
    ? `${provider}:${normalized.providerTransactionId}:payment`
    : `${provider}:${Date.now()}:${Math.random().toString(36).substring(2, 8)}`;

  // 3. Idempotency check
  const existingPayment = await prisma.payment.findUnique({
    where: { idempotencyKey },
  });
  if (existingPayment) {
    const existingAttribution = await prisma.paymentAttribution.findFirst({
      where: { paymentId: existingPayment.id },
      orderBy: { createdAt: 'desc' },
    });
    return {
      paymentId: existingPayment.id,
      status: 'duplicate',
      attribution: {
        status: 'unmatched' as any,
        orderId: existingPayment.orderId || undefined,
        userId: existingPayment.userId || undefined,
        confidence: 0,
        evidence: [] as any,
        reason: 'Already processed (idempotent)',
      },
      reason: 'Payment already processed',
    };
  }

  // 4. Create Payment record
  const payment = await prisma.payment.create({
    data: {
      provider: provider.toUpperCase() as any,
      providerTransactionId: normalized.providerTransactionId,
      providerReference: normalized.providerReference,
      providerAccountId: normalized.providerAccountId,
      amount: normalized.amount,
      currency: normalized.currency,
      status: 'DETECTED',
      payerDisplayName: normalized.payerDisplayName,
      payerPhone: normalized.payerPhone,
      payerEmail: normalized.payerEmail,
      payerAccountId: normalized.payerAccountId,
      recipientDisplayName: normalized.recipientDisplayName,
      recipientAccountId: normalized.recipientAccountId,
      occurredAt: normalized.occurredAt,
      rawProviderData: toJson(rawData),
      normalizedData: toJson(normalized),
      idempotencyKey,
      sourceType,
    },
  });

  try {
    // 5. Attribution
    const attributionInput: AttributionInput = {
      paymentId: payment.id,
      provider: normalized.provider,
      providerTransactionId: normalized.providerTransactionId,
      providerReference: normalized.providerReference,
      providerAccountId: normalized.providerAccountId,
      orderId: normalized.orderId,
      amount: normalized.amount,
      currency: normalized.currency,
      payerDisplayName: normalized.payerDisplayName,
      payerPhone: normalized.payerPhone,
      payerEmail: normalized.payerEmail,
      payerAccountId: normalized.payerAccountId,
      recipientAccountId: normalized.recipientAccountId,
      occurredAt: normalized.occurredAt,
      rawProviderData: rawData,
    };

    const attribution = await attribute(attributionInput);

    // Save attribution
    await prisma.paymentAttribution.create({
      data: {
        paymentId: payment.id,
        orderId: attribution.orderId,
        userId: attribution.userId,
        status: attribution.status.toUpperCase() as any,
        confidence: attribution.confidence,
        matchMethod: attribution.matchMethod,
        evidenceSummary: toJson({ evidence: attribution.evidence, candidates: attribution.candidates }),
        reason: attribution.reason,
      },
    });

    // Update payment with attribution results
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        orderId: attribution.orderId,
        userId: attribution.userId,
        attributionStatus: attribution.status.toUpperCase() as any,
        status: attribution.status === 'matched' ? 'VERIFYING' : attribution.status === 'duplicate' ? 'DUPLICATE' : 'UNMATCHED',
      },
    });

    // If not matched, create exception and return
    if (attribution.status !== 'matched') {
      if (attribution.status === 'ambiguous' || attribution.status === 'candidate_found') {
        await createException({
          paymentId: payment.id,
          orderId: attribution.orderId,
          userId: attribution.userId,
          type: attribution.status === 'ambiguous' ? 'AMBIGUOUS_ATTRIBUTION' : 'UNMATCHED_PAYMENT',
          detail: attribution.reason,
          evidence: attribution,
        });
      }

      return {
        paymentId: payment.id,
        status: attribution.status,
        attribution,
        reason: attribution.reason,
      };
    }

    // 6. Verification (only if attribution matched)
    if (!attribution.orderId) {
      return {
        paymentId: payment.id,
        status: 'error',
        attribution,
        reason: 'Attribution matched but no orderId returned',
      };
    }

    const verificationInput: VerificationInput = {
      paymentId: payment.id,
      orderId: attribution.orderId,
      amount: normalized.amount,
      currency: normalized.currency,
      recipientAccountId: normalized.recipientAccountId,
      providerTransactionId: normalized.providerTransactionId,
      occurredAt: normalized.occurredAt,
    };

    const verification = await verify(verificationInput);
    await saveVerification(payment.id, verification);

    // Update payment status
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: verification.passed ? 'VERIFIED' : 'FAILED',
        verificationStatus: verification.passed ? 'verified' : 'failed',
      },
    });

    if (!verification.passed) {
      // Create exception for verification failure
      let exceptionType: any = 'AMOUNT_MISMATCH';
      if (!verification.checks.amount.passed && verification.checks.amount.received > (verification.checks.amount.expected || 0)) {
        exceptionType = 'OVERPAYMENT';
      } else if (!verification.checks.amount.passed) {
        exceptionType = 'UNDERPAYMENT';
      } else if (!verification.checks.currency.passed) {
        exceptionType = 'CURRENCY_MISMATCH';
      }

      await createException({
        paymentId: payment.id,
        orderId: attribution.orderId,
        userId: attribution.userId,
        type: exceptionType,
        detail: verification.reason,
        evidence: { verification, attribution },
      });

      return {
        paymentId: payment.id,
        status: 'verification_failed',
        attribution,
        verification,
        reason: verification.reason,
      };
    }

    // 7. Billing — update order and issue credits
    const billingResult = await processBilling(payment.id, attribution.orderId, attribution.userId!, normalized.amount);

    // 8. Learn identity from verified payment
    if (attribution.userId) {
      await learnIdentity(attribution.userId, provider, normalized).catch(() => {});
    }

    return {
      paymentId: payment.id,
      status: 'completed',
      attribution,
      verification,
      creditGranted: billingResult.creditsGranted,
      balanceAfter: billingResult.balanceAfter,
      reason: 'Payment verified and credits issued',
    };

  } catch (err: any) {
    // Update payment status on error
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'FAILED' },
    });

    await createException({
      paymentId: payment.id,
      type: 'PROVIDER_ERROR',
      detail: `Processing error: ${err.message}`,
    });

    return {
      paymentId: payment.id,
      status: 'error',
      attribution: { status: 'unmatched', confidence: 0, evidence: [], reason: err.message },
      reason: `Processing error: ${err.message}`,
    };
  }
}

// ==================== Process from OCR Screenshot ====================

export async function processProofPayment(
  orderId: string,
  proofId: string,
  ocrResult: any,
  userId: string,
): Promise<ProcessResult> {
  // Build normalized data from OCR
  const rawData = {
    ...ocrResult,
    source: 'screenshot_ocr',
    orderId,
    proofId,
  };

  // Process through standard pipeline
  const result = await processPayment(ocrResult.payment_method || 'unknown', rawData, 'screenshot_ocr');

  // If attribution found no match but we have an orderId from context, override
  if (result.attribution.status !== 'matched' && result.attribution.status !== 'duplicate') {
    // Force-link to the order since user explicitly uploaded proof for this order
    const order = await prisma.paymentOrder.findUnique({ where: { orderId } });
    if (order && order.userId === userId) {
      // Manual override — user's proof, user's order
      await prisma.payment.update({
        where: { id: result.paymentId },
        data: {
          orderId,
          userId,
          attributionStatus: 'MANUALLY_MATCHED',
        },
      });

      await prisma.paymentAttribution.create({
        data: {
          paymentId: result.paymentId,
          orderId,
          userId,
          status: 'MANUALLY_MATCHED',
          confidence: 0.85,
          matchMethod: 'user_proof_upload',
          reason: 'User uploaded proof for specific order — context match',
        },
      });

      // Re-verify with the linked order
      const verificationInput: VerificationInput = {
        paymentId: result.paymentId,
        orderId,
        amount: ocrResult.amount,
        currency: ocrResult.currency || order.currency,
        providerTransactionId: ocrResult.transaction_id,
        occurredAt: ocrResult.date ? new Date(`${ocrResult.date}T${ocrResult.time || '00:00:00'}`) : undefined,
      };

      const verification = await verify(verificationInput);
      await saveVerification(result.paymentId, verification);

      if (verification.passed) {
        await prisma.payment.update({
          where: { id: result.paymentId },
          data: { status: 'VERIFIED', verificationStatus: 'verified' },
        });

        const billingResult = await processBilling(result.paymentId, orderId, userId, ocrResult.amount);

        return {
          paymentId: result.paymentId,
          status: 'completed',
          attribution: {
            status: 'matched' as any,
            orderId,
            userId,
            confidence: 0.85,
            matchMethod: 'user_proof_upload',
            evidence: [],
            reason: 'Context-matched via proof upload',
          },
          verification,
          creditGranted: billingResult.creditsGranted,
          balanceAfter: billingResult.balanceAfter,
          reason: 'Payment verified via proof upload and credits issued',
        };
      }

      return {
        paymentId: result.paymentId,
        status: 'verification_failed',
        attribution: {
          status: 'matched' as any,
          orderId,
          userId,
          confidence: 0.85,
          matchMethod: 'user_proof_upload',
          evidence: [],
          reason: 'Context-matched but verification failed',
        },
        verification,
        reason: verification.reason,
      };
    }
  }

  return result;
}

// ==================== Billing ====================

async function processBilling(
  paymentId: string,
  orderId: string,
  userId: string,
  amount: number,
): Promise<{ creditsGranted: number; balanceAfter: number }> {
  const order = await prisma.paymentOrder.findUnique({ where: { orderId } });
  if (!order) throw new Error(`Order ${orderId} not found`);

  // Determine credits to grant. Prefer the credit amount locked on the order
  // at creation time (R6.2); fall back to the plan for legacy orders.
  const isPack = order.plan.startsWith('pack-');
  const isYearly = order.plan.includes('yearly');
  const isUltraLegacy = order.plan.startsWith('ultra');

  let creditsToGrant = order.lockedCredits || 0;
  if (!creditsToGrant) {
    if (isPack) {
      creditsToGrant = parseInt(order.plan.replace('pack-', '')) || 0;
    } else if (isUltraLegacy) {
      // Legacy Ultra: single grant, 30-day validity (tier retired).
      const ultraGrants: Record<string, number> = { ultra_monthly: 5000, ultra_yearly: 5000 };
      creditsToGrant = ultraGrants[order.plan] || 5000;
    } else {
      // Pro: monthly grant amount. (Batches are sized per-plan below.)
      creditsToGrant = 3000;
    }
  }

  const description = isPack
    ? `积分包购买: ${creditsToGrant} 积分`
    : isUltraLegacy
      ? `订阅购买（遗留 Ultra）: ${order.plan}`
      : `Pro 订阅购买: ${order.plan}`;

  if (creditsToGrant > 0) {
    let lastBalance = 0;
    if (isPack) {
      // Top-up packs: single permanent batch.
      const result = await grantCredits({
        userId,
        paymentId,
        orderId,
        credits: creditsToGrant,
        description,
        idempotencyKey: `credit_grant_${paymentId}`,
        pricingVersionId: order.pricingVersionId || undefined,
        metadata: { orderPlan: order.plan, paidAmount: amount },
        batch: { validDays: PERMANENT_PACK_VALID_DAYS, source: 'purchase' },
      });
      lastBalance = result.balanceAfter;
    } else if (isUltraLegacy) {
      const result = await grantCredits({
        userId,
        paymentId,
        orderId,
        credits: creditsToGrant,
        description,
        idempotencyKey: `credit_grant_${paymentId}`,
        pricingVersionId: order.pricingVersionId || undefined,
        metadata: { orderPlan: order.plan, paidAmount: amount },
        batch: { validDays: 30, source: 'subscription' },
      });
      lastBalance = result.balanceAfter;
    } else {
      // Pro: monthly plan = 1 batch of 3000 (30-day validity); yearly plan
      // = 12 monthly batches of 3000, batch i expiring at start + 30*(i+1)
      // days so they roll off one per month over the year.
      const batches = isYearly ? 12 : 1;
      for (let i = 0; i < batches; i++) {
        const result = await grantCredits({
          userId,
          paymentId,
          orderId,
          credits: 3000,
          description: batches > 1 ? `${description}（第 ${i + 1}/${batches} 月批次）` : description,
          // Distinct idempotency key per batch; payment-level key only on
          // the first batch so a retry never double-grants.
          idempotencyKey: i === 0 ? `credit_grant_${paymentId}` : `credit_grant_${paymentId}_batch_${i}`,
          pricingVersionId: order.pricingVersionId || undefined,
          metadata: { orderPlan: order.plan, paidAmount: amount, batchIndex: i, batchCount: batches },
          batch: { validDays: 30, source: 'subscription' },
        });
        lastBalance = result.balanceAfter;
      }
    }
  }

  // Mark the order as credit-granted (audit).
  await prisma.paymentOrder.update({
    where: { orderId },
    data: {
      creditGranted: true,
      creditGrantedAt: new Date(),
      creditValidDays: isPack ? PERMANENT_PACK_VALID_DAYS : isUltraLegacy ? 30 : 30,
    },
  }).catch(() => {});

  // Update order status
  const newVerifiedTotal = order.verifiedTotal + amount;
  const newRemaining = Math.max(0, order.expectedAmount - newVerifiedTotal);

  await prisma.paymentOrder.update({
    where: { orderId },
    data: {
      verifiedTotal: newVerifiedTotal,
      remainingAmount: newRemaining,
      status: newRemaining <= 0 ? 'PAID' : 'UNDERPAID',
    },
  });

  // Activate subscription if applicable
  if (!order.plan.startsWith('pack-') && newRemaining <= 0) {
    await activateSubscription(userId, order.plan);
  }

  // Update payment status
  await prisma.payment.update({
    where: { id: paymentId },
    data: { status: 'COMPLETED' },
  });

  // Audit log
  await prisma.paymentAuditLog.create({
    data: {
      orderId,
      action: 'CREDIT_ISSUED',
      detail: `Payment ${paymentId}: ${creditsToGrant} credits granted to ${userId}`,
    },
  }).catch(() => {});

  return { creditsGranted: creditsToGrant, balanceAfter: order.lockedCredits ? creditsToGrant : creditsToGrant };
}

// ==================== Subscription Activation ====================

async function activateSubscription(userId: string, plan: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  const isYearly = plan.includes('yearly');
  // Ultra was retired: legacy ultra_* orders still settle to the legacy
  // ULTRA tier value (PRO-equivalent entitlements). New sales only
  // activate PRO.
  const tier = plan.startsWith('pro') ? 'PRO' : plan.startsWith('ultra') ? 'ULTRA' : null;
  if (!tier) return;

  const endDate = new Date();
  if (isYearly) endDate.setFullYear(endDate.getFullYear() + 1);
  else endDate.setMonth(endDate.getMonth() + 1);

  await prisma.user.update({
    where: { id: userId },
    data: {
      subscriptionTier: tier as any,
      subscriptionEnd: endDate,
    },
  });
}

// ==================== Identity Learning ====================

async function learnIdentity(userId: string, provider: string, normalized: any): Promise<void> {
  const displayNames: string[] = [];
  if (normalized.payerDisplayName) displayNames.push(normalized.payerDisplayName);

  const normalizedNames: string[] = [];
  for (const name of displayNames) {
    const parts = name.toLowerCase().trim().split(/\s+/).filter((w: string) => w.length > 1);
    normalizedNames.push(...parts);
  }

  if (displayNames.length === 0) return;

  await prisma.paymentProviderIdentity.upsert({
    where: { userId_provider: { userId, provider: provider.toUpperCase() as any } },
    create: {
      userId,
      provider: provider.toUpperCase() as any,
      displayNames: JSON.stringify(displayNames),
      normalizedNames: JSON.stringify(normalizedNames),
      phone: normalized.payerPhone,
      email: normalized.payerEmail,
      accountId: normalized.payerAccountId,
      verifiedCount: 1,
      source: 'verified_payment',
    },
    update: {},
  });

  // Merge new display names
  const existing = await prisma.paymentProviderIdentity.findUnique({
    where: { userId_provider: { userId, provider: provider.toUpperCase() as any } },
  });

  if (existing) {
    const currentNames = JSON.parse(existing.displayNames || '[]') as string[];
    const merged = [...new Set([...currentNames, ...displayNames])];

    const currentNormalized = JSON.parse(existing.normalizedNames || '[]') as string[];
    const mergedNormalized = [...new Set([...currentNormalized, ...normalizedNames])];

    await prisma.paymentProviderIdentity.update({
      where: { id: existing.id },
      data: {
        displayNames: JSON.stringify(merged),
        normalizedNames: JSON.stringify(mergedNormalized),
        verifiedCount: existing.verifiedCount + 1,
        lastObservedAt: new Date(),
        phone: normalized.payerPhone || existing.phone,
        email: normalized.payerEmail || existing.email,
        accountId: normalized.payerAccountId || existing.accountId,
      },
    });
  }
}

// ==================== Exception Creation ====================

async function createException(data: {
  paymentId?: string;
  orderId?: string;
  userId?: string;
  type: string;
  detail: string;
  evidence?: any;
}): Promise<void> {
  await prisma.paymentException.create({
    data: {
      paymentId: data.paymentId,
      orderId: data.orderId,
      userId: data.userId,
      exceptionType: data.type as any,
      detail: data.detail,
      evidence: data.evidence,
    },
  }).catch((err) => console.error('[PaymentRuntime] createException error:', err));
}

// ==================== Admin Actions ====================

export async function adminApprove(
  paymentId: string,
  adminId: string,
  orderId: string,
  userId: string,
  reason: string,
): Promise<ProcessResult> {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new Error('Payment not found');

  // Create manual attribution
  await prisma.paymentAttribution.create({
    data: {
      paymentId,
      orderId,
      userId,
      status: 'MANUALLY_MATCHED',
      confidence: 1.0,
      matchMethod: 'admin_manual',
      reason: `Admin ${adminId}: ${reason}`,
      reviewedBy: adminId,
      reviewedAt: new Date(),
    },
  });

  await prisma.payment.update({
    where: { id: paymentId },
    data: { orderId, userId, attributionStatus: 'MANUALLY_MATCHED' },
  });

  // Verify
  const verificationInput: VerificationInput = {
    paymentId,
    orderId,
    amount: payment.amount,
    currency: payment.currency,
    providerTransactionId: payment.providerTransactionId || undefined,
    occurredAt: payment.occurredAt || undefined,
  };

  const verification = await verify(verificationInput);
  await saveVerification(paymentId, verification);

  if (!verification.passed) {
    return {
      paymentId,
      status: 'verification_failed',
      attribution: { status: 'matched' as any, orderId, userId, confidence: 1.0, matchMethod: 'admin_manual', evidence: [], reason },
      verification,
      reason: verification.reason,
    };
  }

  // Process billing
  const billingResult = await processBilling(paymentId, orderId, userId, payment.amount);

  // Close any exceptions
  await prisma.paymentException.updateMany({
    where: { paymentId, status: 'open' },
    data: { status: 'resolved', resolution: `Admin approved: ${reason}`, resolvedBy: adminId, resolvedAt: new Date() },
  });

  // Audit
  await prisma.paymentAuditLog.create({
    data: { orderId, action: 'ADMIN_APPROVE', detail: `Admin ${adminId}: ${reason}` },
  }).catch(() => {});

  return {
    paymentId,
    status: 'completed',
    attribution: { status: 'matched' as any, orderId, userId, confidence: 1.0, matchMethod: 'admin_manual', evidence: [], reason },
    verification,
    creditGranted: billingResult.creditsGranted,
    balanceAfter: billingResult.balanceAfter,
    reason: 'Admin approved and credits issued',
  };
}