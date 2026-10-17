// ================================================================
// Payment Attribution Engine — Multi-Signal Order/User Matching
// ================================================================
//
// Priority hierarchy:
//   L1 STRONG:  Transaction ID, Order Reference, Provider Account
//   L2 MEDIUM:  Exact Amount + Currency, Recipient, Time Window
//   L3 WEAK:    Display Name, Partial Name, Phone, Email
//
// Deterministic rules first. Ambiguous → Exception Queue.
// Accuracy > Automation Rate.

import { prisma } from './db';

export interface AttributionInput {
  paymentId: string;
  provider: string;
  providerTransactionId?: string;
  providerReference?: string;
  providerAccountId?: string;
  orderId?: string;
  userId?: string;
  amount: number;
  currency: string;
  payerDisplayName?: string;
  payerPhone?: string;
  payerEmail?: string;
  payerAccountId?: string;
  recipientAccountId?: string;
  occurredAt?: Date;
  rawProviderData?: any;
}

export interface AttributionResult {
  status: 'matched' | 'candidate_found' | 'ambiguous' | 'unmatched' | 'duplicate';
  orderId?: string;
  userId?: string;
  confidence: number;
  matchMethod?: string;
  evidence: EvidenceItem[];
  reason: string;
  candidates?: { orderId: string; userId: string; score: number; reasons: string[] }[];
}

export interface EvidenceItem {
  type: string;
  value: string;
  strength: 'STRONG' | 'MEDIUM' | 'WEAK';
  matched: boolean;
  detail?: string;
}

// ==================== Main Attribution ====================

export async function attribute(input: AttributionInput): Promise<AttributionResult> {
  const evidence: EvidenceItem[] = [];

  // ==================== L1: Deterministic Rules ====================

  // 1. Check idempotency — duplicate provider transaction
  if (input.providerTransactionId) {
    const existing = await prisma.payment.findFirst({
      where: {
        provider: input.provider as any,
        providerTransactionId: input.providerTransactionId,
        status: { notIn: ['FAILED', 'CANCELLED'] },
        id: { not: input.paymentId },
      },
    });

    if (existing) {
      return {
        status: 'duplicate',
        orderId: existing.orderId || undefined,
        userId: existing.userId || undefined,
        confidence: 1.0,
        matchMethod: 'duplicate_transaction_id',
        evidence: [makeEvidence('provider_transaction_id', input.providerTransactionId, 'STRONG', true, 'Exact duplicate')],
        reason: `Transaction ID ${input.providerTransactionId} already processed`,
      };
    }
  }

  // 2. Explicit order ID in payment
  if (input.orderId) {
    const order = await prisma.paymentOrder.findUnique({
      where: { orderId: input.orderId },
    });

    if (order) {
      const amountMatch = Math.abs(order.expectedAmount - input.amount) < 0.01;
      const currencyMatch = order.currency === input.currency;

      evidence.push(makeEvidence('order_reference', input.orderId, 'STRONG', true));
      evidence.push(makeEvidence('amount', `${input.amount}`, amountMatch ? 'STRONG' : 'MEDIUM', amountMatch,
        amountMatch ? 'Exact match' : `Expected ${order.expectedAmount}, got ${input.amount}`));
      evidence.push(makeEvidence('currency', input.currency, 'STRONG', currencyMatch));

      if (amountMatch && currencyMatch && order.status === 'AWAITING_PAYMENT') {
        await saveEvidence(input.paymentId, evidence);
        return {
          status: 'matched',
          orderId: order.orderId,
          userId: order.userId,
          confidence: 0.98,
          matchMethod: 'explicit_order_reference',
          evidence,
          reason: 'Exact order reference match with amount and currency verification',
        };
      }

      if (!amountMatch || !currencyMatch) {
        await saveEvidence(input.paymentId, evidence);
        return {
          status: 'ambiguous',
          orderId: order.orderId,
          userId: order.userId,
          confidence: 0.5,
          matchMethod: 'order_reference_amount_mismatch',
          evidence,
          reason: `Order reference matched but amount/currency mismatch`,
        };
      }
    }
  }

  // 3. Provider reference matching
  if (input.providerReference) {
    const refOrder = await prisma.paymentOrder.findFirst({
      where: { orderId: input.providerReference },
    });
    if (refOrder && refOrder.status === 'AWAITING_PAYMENT') {
      const amountMatch = Math.abs(refOrder.expectedAmount - input.amount) < 0.01;
      const currencyMatch = refOrder.currency === input.currency;

      evidence.push(makeEvidence('provider_reference', input.providerReference, 'STRONG', true));
      evidence.push(makeEvidence('amount', `${input.amount}`, amountMatch ? 'STRONG' : 'MEDIUM', amountMatch));
      evidence.push(makeEvidence('currency', input.currency, 'STRONG', currencyMatch));

      if (amountMatch && currencyMatch) {
        await saveEvidence(input.paymentId, evidence);
        return {
          status: 'matched',
          orderId: refOrder.orderId,
          userId: refOrder.userId,
          confidence: 0.95,
          matchMethod: 'provider_reference',
          evidence,
          reason: 'Provider reference matched order',
        };
      }
    }
  }

  // ==================== L2: Multi-Signal Matching ====================

  // Find candidate orders
  const timeWindowMs = 30 * 60 * 1000; // 30 minutes
  const occurredAt = input.occurredAt || new Date();

  const candidateOrders = await prisma.paymentOrder.findMany({
    where: {
      status: 'AWAITING_PAYMENT',
      expectedAmount: { gte: input.amount - 0.02, lte: input.amount + 0.02 },
      currency: input.currency,
      createdAt: { lte: new Date(occurredAt.getTime() + timeWindowMs) },
      expiresAt: { gte: new Date(occurredAt.getTime() - timeWindowMs) },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  if (candidateOrders.length === 0) {
    // Try wider search (any status that hasn't been paid)
    const widerCandidates = await prisma.paymentOrder.findMany({
      where: {
        status: { in: ['AWAITING_PAYMENT', 'PROOF_UPLOADED', 'AI_REVIEWING', 'UNDERPAID', 'INVALID'] },
        expectedAmount: { gte: input.amount - 0.02, lte: input.amount + 0.02 },
        currency: input.currency,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    if (widerCandidates.length === 0) {
      await saveEvidence(input.paymentId, evidence);
      return {
        status: 'unmatched',
        confidence: 0,
        evidence,
        reason: 'No candidate orders found matching amount and currency',
      };
    }

    // Use wider candidates
    return await rankAndDecide(input, widerCandidates, evidence, input.paymentId);
  }

  return await rankAndDecide(input, candidateOrders, evidence, input.paymentId);
}

// ==================== Candidate Ranking ====================

async function rankAndDecide(
  input: AttributionInput,
  candidates: any[],
  evidence: EvidenceItem[],
  paymentId: string,
): Promise<AttributionResult> {
  const ranked: { orderId: string; userId: string; score: number; reasons: string[] }[] = [];

  for (const order of candidates) {
    let score = 0;
    const reasons: string[] = [];

    // Amount match (within tolerance)
    const amountDiff = Math.abs(order.expectedAmount - input.amount);
    if (amountDiff < 0.01) {
      score += 30;
      reasons.push('Exact amount match');
    } else if (amountDiff < 0.02) {
      score += 25;
      reasons.push('Near-exact amount match');
    }

    // Currency match
    if (order.currency === input.currency) {
      score += 20;
      reasons.push('Currency match');
    }

    // Time proximity
    if (input.occurredAt && order.createdAt) {
      const diffMs = Math.abs(input.occurredAt.getTime() - order.createdAt.getTime());
      if (diffMs < 5 * 60 * 1000) {
        score += 20;
        reasons.push('Within 5 min of order creation');
      } else if (diffMs < 15 * 60 * 1000) {
        score += 15;
        reasons.push('Within 15 min of order creation');
      } else if (diffMs < 30 * 60 * 1000) {
        score += 10;
        reasons.push('Within 30 min of order creation');
      }
    }

    // Recipient account match
    if (input.recipientAccountId && order.recipient) {
      if (normalizeAccount(input.recipientAccountId) === normalizeAccount(order.recipient)) {
        score += 15;
        reasons.push('Recipient account match');
      }
    }

    // User identity match (L3 — weak)
    if (input.payerDisplayName && order.userId) {
      const identity = await prisma.paymentProviderIdentity.findUnique({
        where: { userId_provider: { userId: order.userId, provider: input.provider as any } },
      });

      if (identity) {
        const names = JSON.parse(identity.displayNames || '[]') as string[];
        const normalized = JSON.parse(identity.normalizedNames || '[]') as string[];
        const payerNorm = normalizeAccount(input.payerDisplayName);

        if (names.some((n: string) => normalizeAccount(n) === payerNorm)) {
          score += 10;
          reasons.push('Display name matches known identity');
        } else if (normalized.some((n: string) => payerNorm.includes(n.toLowerCase()))) {
          score += 5;
          reasons.push('Partial name match');
        }
      }
    }

    // Provider account match (if user has a known account on this provider)
    if (input.payerAccountId && order.userId) {
      const identity = await prisma.paymentProviderIdentity.findUnique({
        where: { userId_provider: { userId: order.userId, provider: input.provider as any } },
      });
      if (identity && identity.accountId === input.payerAccountId) {
        score += 15;
        reasons.push('Provider account ID match');
      }
    }

    ranked.push({ orderId: order.orderId, userId: order.userId, score, reasons });
  }

  // Sort by score descending
  ranked.sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    await saveEvidence(paymentId, evidence);
    return {
      status: 'unmatched',
      confidence: 0,
      evidence,
      reason: 'No candidates after ranking',
    };
  }

  const best = ranked[0];

  // Add name evidence (always weak)
  if (input.payerDisplayName) {
    evidence.push(makeEvidence('display_name', input.payerDisplayName, 'WEAK', false, 'Weak identity signal only'));
  }

  // Decision logic
  if (best.score >= 70 && (ranked.length === 1 || best.score > (ranked[1]?.score || 0) * 1.4)) {
    // Clear winner
    evidence.push(makeEvidence('multi_signal_score', `${best.score}`, 'MEDIUM', true, best.reasons.join('; ')));
    await saveEvidence(paymentId, evidence);
    return {
      status: 'matched',
      orderId: best.orderId,
      userId: best.userId,
      confidence: Math.min(0.95, best.score / 100),
      matchMethod: 'multi_signal',
      evidence,
      reason: `Multi-signal match (score: ${best.score}): ${best.reasons.join(', ')}`,
      candidates: ranked.slice(0, 5),
    };
  }

  if (best.score >= 50) {
    // Possible match but not confident
    evidence.push(makeEvidence('multi_signal_score', `${best.score}`, 'MEDIUM', false, 'Score below confident threshold'));
    await saveEvidence(paymentId, evidence);
    return {
      status: 'candidate_found',
      orderId: best.orderId,
      userId: best.userId,
      confidence: best.score / 100,
      matchMethod: 'multi_signal_weak',
      evidence,
      reason: `Possible match (score: ${best.score}) but below confident threshold. Needs review.`,
      candidates: ranked.slice(0, 5),
    };
  }

  // Ambiguous
  await saveEvidence(paymentId, evidence);
  return {
    status: 'ambiguous',
    confidence: best.score / 100,
    evidence,
    reason: `Multiple weak candidates, highest score: ${best.score}`,
    candidates: ranked.slice(0, 5),
  };
}

// ==================== Helpers ====================

function makeEvidence(
  type: string,
  value: string,
  strength: EvidenceItem['strength'],
  matched: boolean,
  detail?: string,
): EvidenceItem {
  return { type, value, strength, matched, detail };
}

async function saveEvidence(paymentId: string, evidence: EvidenceItem[]): Promise<void> {
  for (const e of evidence) {
    await prisma.paymentEvidence.create({
      data: {
        paymentId,
        type: e.type,
        value: e.value,
        source: 'attribution_engine',
        strength: e.strength as any,
        verified: e.matched,
        metadata: e.detail ? JSON.stringify({ detail: e.detail }) : undefined,
      },
    }).catch(() => {});
  }
}

function normalizeAccount(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[*]+/g, '')
    .replace(/[^\w\s]/g, '')
    .trim();
}