// ================================================================
// Billing Ledger — the ONLY path that mutates credit balances (R8)
// ================================================================
//
// Backed by the single CreditLedger table. Every entry is immutable and
// carries provider/model/token/cost/version/trace dimensions. Duplicate
// idempotency keys are rejected instead of applying twice (R8.4).
//
// Operations: grant, reserve, charge, refund, reversal.

import { prisma } from '../db';
import { Prisma } from '@prisma/client-user';
import { DecimalInput, d, roundUsd } from './money';

export type LedgerType = 'purchase' | 'deduction' | 'refund' | 'reserve' | 'reversal';

export interface LedgerInput {
  userId: string;
  /** credits are a unit count; positive value, sign derived from operation */
  credits: number;
  idempotencyKey: string;
  type: LedgerType;
  description?: string;
  paymentId?: string;
  orderId?: string;
  metadata?: any;
  pricingVersionId?: string;
  traceId?: string;
  requestId?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  actualCostUsd?: DecimalInput | null;
  protectedCostUsd?: DecimalInput | null;
  protectedCostMyr?: DecimalInput | null;
  creditsUsed?: DecimalInput | null;
  /** create a CreditBatch (expiring credits) — used by grants */
  batch?: { validDays: number; source: string } | null;
}

export interface LedgerResult {
  success: boolean;
  duplicate: boolean;
  balanceAfter: number;
  ledgerId: string;
}

const NEGATIVE: LedgerType[] = ['deduction', 'reserve', 'reversal'];

function isNegative(type: LedgerType): boolean {
  return NEGATIVE.includes(type);
}

function decimalOrNull(value: DecimalInput | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return roundUsd(value).toNumber();
}

export async function applyEntry(input: LedgerInput): Promise<LedgerResult> {
  if (!input.idempotencyKey) throw new Error('idempotencyKey is required');
  if (!(input.credits >= 0)) throw new Error('credits must be non-negative');

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.creditLedger.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) {
        return { success: true, duplicate: true, balanceAfter: existing.balanceAfter, ledgerId: existing.id };
      }

      const user = await tx.user.findUnique({ where: { id: input.userId } });
      if (!user) throw new Error(`User not found: ${input.userId}`);

      const negative = isNegative(input.type);
      const signed = negative ? -input.credits : input.credits;

      // 快速失败：先用当前读到的余额挡掉明显不足的情况。
      if (user.creditBalance + signed < -0.000001) throw new Error('积分不足');

      // 原子增减，而不是「读出来 → 相加 → 整值覆写」。
      // 旧写法是 balanceAfter = user.creditBalance + signed 之后
      // update({ creditBalance: balanceAfter })：两个并发事务都读到 100、
      // 都写回 99，其中一次扣费被静默吞掉（丢失更新）。increment 由数据库
      // 串行执行，并发扣费不会互相覆盖余额。
      const updated = await tx.user.update({
        where: { id: input.userId },
        data: { creditBalance: { increment: signed } },
      });
      const balanceAfter = updated.creditBalance;
      // 精确复检：并发下真实结果可能为负，此时抛错让整个事务回滚。
      if (balanceAfter < -0.000001) throw new Error('积分不足');

      const entry = await tx.creditLedger.create({
        data: {
          userId: input.userId,
          paymentId: input.paymentId,
          orderId: input.orderId,
          type: input.type,
          amount: signed,
          balanceAfter,
          description: input.description,
          idempotencyKey: input.idempotencyKey,
          metadata: input.metadata,
          status: input.type === 'reserve' ? 'reserved' : 'settled',
          traceId: input.traceId,
          requestId: input.requestId,
          provider: input.provider,
          model: input.model,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          totalTokens: input.totalTokens,
          actualCostUsd: decimalOrNull(input.actualCostUsd),
          protectedCostUsd: decimalOrNull(input.protectedCostUsd),
          protectedCostMyr: decimalOrNull(input.protectedCostMyr),
          creditsUsed: decimalOrNull(input.creditsUsed),
          pricingVersionId: input.pricingVersionId,
        },
      });

      await tx.creditTransaction.create({
        data: {
          userId: input.userId,
          amount: signed,
          balance: balanceAfter,
          type: input.type,
          description: input.description,
          model: input.model,
        },
      });

      if (input.batch && !negative) {
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + input.batch.validDays);
        await tx.creditBatch.create({
          data: {
            userId: input.userId,
            amount: input.credits,
            remaining: input.credits,
            source: input.batch.source,
            description: input.description,
            expiryDate,
          },
        });
      }

      // 余额已由上面的原子 increment 更新到位，此处不再整值覆写 ——
      // 那会把其他并发事务刚写入的余额又按本事务的旧值覆盖回去。
      return { success: true, duplicate: false, balanceAfter, ledgerId: entry.id };
    });
  } catch (err: any) {
    // Concurrent duplicate: unique constraint on idempotencyKey.
    if (err?.code === 'P2002') {
      const existing = await prisma.creditLedger.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) {
        return { success: true, duplicate: true, balanceAfter: existing.balanceAfter, ledgerId: existing.id };
      }
    }
    throw err;
  }
}

// ==================== Typed operations ====================

export async function grantCredits(input: Omit<LedgerInput, 'type'> & { type?: LedgerType }): Promise<LedgerResult> {
  return applyEntry({ ...input, type: input.type || 'purchase' });
}

export async function reserveCredits(input: Omit<LedgerInput, 'type'>): Promise<LedgerResult> {
  return applyEntry({ ...input, type: 'reserve' });
}

export async function chargeCredits(input: Omit<LedgerInput, 'type'>): Promise<LedgerResult> {
  return applyEntry({ ...input, type: 'deduction' });
}

export async function refundCredits(input: Omit<LedgerInput, 'type'>): Promise<LedgerResult> {
  return applyEntry({ ...input, type: 'refund' });
}

export async function reverseCredits(input: Omit<LedgerInput, 'type'>): Promise<LedgerResult> {
  return applyEntry({ ...input, type: 'reversal' });
}

// Sum of all ledger entries = authoritative balance (R8.2)
export async function computeLedgerBalance(userId: string): Promise<Prisma.Decimal> {
  const result = await prisma.creditLedger.aggregate({ where: { userId }, _sum: { amount: true } });
  return d(result._sum.amount || 0);
}
