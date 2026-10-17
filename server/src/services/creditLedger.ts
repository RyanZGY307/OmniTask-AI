// ================================================================
// Credit Ledger — Immutable, append-only financial ledger
// ================================================================
//
// NEVER directly update User.creditBalance.
// ALL balance changes MUST go through this ledger.
//
// Balance = sum of all CreditLedger entries for a user.

import { prisma } from './db';

export interface GrantInput {
  userId: string;
  paymentId?: string;
  orderId?: string;
  credits: number;
  description?: string;
  idempotencyKey: string;
  metadata?: any;
}

export interface ReversalInput {
  userId: string;
  paymentId?: string;
  credits: number;
  reason: string;
  idempotencyKey: string;
}

// ==================== Grant Credits ====================

export async function grant(input: GrantInput): Promise<{ success: boolean; balanceAfter: number; ledgerId: string }> {
  // Idempotency check
  if (input.idempotencyKey) {
    const existing = await prisma.creditLedger.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      return {
        success: true,
        balanceAfter: existing.balanceAfter,
        ledgerId: existing.id,
      };
    }
  }

  // Use transaction to ensure atomicity
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: input.userId } });
    if (!user) throw new Error(`User not found: ${input.userId}`);

    const balanceBefore = user.creditBalance;
    const balanceAfter = balanceBefore + input.credits;

    // Create ledger entry (immutable)
    const entry = await tx.creditLedger.create({
      data: {
        userId: input.userId,
        paymentId: input.paymentId,
        orderId: input.orderId,
        type: 'purchase',
        amount: input.credits,
        balanceAfter,
        description: input.description || `Credit grant: ${input.credits}`,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata,
      },
    });

    // Update user balance
    await tx.user.update({
      where: { id: input.userId },
      data: { creditBalance: balanceAfter },
    });

    // Also create legacy CreditTransaction for backward compatibility
    await tx.creditTransaction.create({
      data: {
        userId: input.userId,
        amount: input.credits,
        balance: balanceAfter,
        type: 'purchase',
        description: input.description || `Credit grant: ${input.credits}`,
      },
    });

    return { success: true, balanceAfter, ledgerId: entry.id };
  });
}

// ==================== Reverse Credits (for refunds) ====================

export async function reverse(input: ReversalInput): Promise<{ success: boolean; balanceAfter: number }> {
  const idempotencyKey = input.idempotencyKey;

  // Idempotency check
  if (idempotencyKey) {
    const existing = await prisma.creditLedger.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      return { success: true, balanceAfter: existing.balanceAfter };
    }
  }

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: input.userId } });
    if (!user) throw new Error(`User not found: ${input.userId}`);

    const balanceBefore = user.creditBalance;
    const balanceAfter = Math.max(0, balanceBefore - input.credits);

    const entry = await tx.creditLedger.create({
      data: {
        userId: input.userId,
        paymentId: input.paymentId,
        type: 'reversal',
        amount: -input.credits,
        balanceAfter,
        description: `Credit reversal: ${input.reason}`,
        idempotencyKey,
      },
    });

    await tx.user.update({
      where: { id: input.userId },
      data: { creditBalance: balanceAfter },
    });

    await tx.creditTransaction.create({
      data: {
        userId: input.userId,
        amount: -input.credits,
        balance: balanceAfter,
        type: 'reversal',
        description: `Credit reversal: ${input.reason}`,
      },
    });

    return { success: true, balanceAfter };
  });
}

// ==================== Get Ledger History ====================

export async function getLedger(userId: string, limit = 50): Promise<any[]> {
  return prisma.creditLedger.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

// ==================== Compute Balance from Ledger ====================

export async function computeBalance(userId: string): Promise<number> {
  const result = await prisma.creditLedger.aggregate({
    where: { userId },
    _sum: { amount: true },
  });
  return result._sum.amount || 0;
}

// ==================== Verify Balance Consistency ====================

export async function verifyBalanceConsistency(userId: string): Promise<{
  consistent: boolean;
  ledgerBalance: number;
  userBalance: number;
}> {
  const [ledgerBalance, user] = await Promise.all([
    computeBalance(userId),
    prisma.user.findUnique({ where: { id: userId }, select: { creditBalance: true } }),
  ]);

  const userBalance = user?.creditBalance || 0;
  return {
    consistent: Math.abs(ledgerBalance - userBalance) < 0.01,
    ledgerBalance,
    userBalance,
  };
}