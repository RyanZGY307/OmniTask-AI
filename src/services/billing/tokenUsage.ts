// ================================================================
// Token Usage Integration — the chat-path entry point.
//
//   provider usage → actual tokens → verified output limit →
//   calculateBilling (display + overflow) → credit deduction
//   (Postgres transaction + retry) → TokenUsage row → user view.
//
// The user-facing view NEVER includes actual tokens, multiplier,
// overflow, model limits, source, verifiedAt, or headroom.
// ================================================================

import { prismaUser, withRetry } from '../db';
import {
  calculateBilling,
  deductCredits,
  applyAntiReverseRounding,
  normalizeMode,
  multiplierFor,
  type ChatMode,
  type BillingResult,
  type LimitSource,
} from './tokenBilling';
import { getVerifiedOutputLimit, getModelLimitRow } from './modelLimits';

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TokenUsageInput {
  userId: string;
  sessionId?: string;
  messageId?: string;
  modelKey: string;
  mode: string | ChatMode;
  providerUsage: ProviderUsage;
  traceId?: string;
  requestId?: string;
}

export interface UserTokenView {
  tokenUsage: {
    displayInput: number;
    displayOutput: number;
    displayTotal: number;
  };
  creditsUsed: number;
}

// Assemble a TokenUsage row's data (actual + display + metadata).
export function buildUsageRecord(input: {
  userId: string;
  sessionId?: string;
  messageId?: string;
  model: string;
  modelVersion?: string | null;
  actualInput: number;
  actualOutput: number;
  billing: BillingResult;
  mode: ChatMode;
  multiplier: number;
  verifiedOutputLimit: number | null;
  limitSource: LimitSource;
  limitVerifiedAt?: string | null;
}) {
  const actualTotal = input.actualInput + input.actualOutput;
  return {
    userId: input.userId,
    sessionId: input.sessionId ?? null,
    messageId: input.messageId ?? null,
    actualInputTokens: input.actualInput,
    actualOutputTokens: input.actualOutput,
    actualTotalTokens: actualTotal,
    displayInputTokens: input.billing.displayInput,
    displayOutputTokens: input.billing.displayOutput,
    displayTotalTokens: input.billing.displayTotal,
    mode: input.mode,
    multiplier: input.multiplier,
    overflowTransferred: input.billing.overflowTransferred,
    overflowAmount: input.billing.overflowAmount,
    model: input.model,
    modelVersion: input.modelVersion ?? null,
    verifiedOutputLimit: input.verifiedOutputLimit,
    limitSource: input.limitSource,
    limitVerifiedAt: input.limitVerifiedAt ? new Date(input.limitVerifiedAt) : null,
  };
}

// Under Postgres, concurrent credit deductions can hit serialization
// conflicts (P2034/40001/40P01 deadlock). Credit deduction + usage write
// happen in one
// transaction with 3 retries (200ms * attempt backoff) so a concurrent
// writer never silently loses an update.
export async function deductUserCredits(
  userId: string,
  credits: number,
  usageData: Record<string, any>,
): Promise<void> {
  const MAX = 3;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      await prismaUser.$transaction(async (tx: any) => {
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) throw new Error('User not found');
        if (user.creditBalance + 0 < credits) {
          // Insufficient credits: still record usage (actual is immutable,
          // cost tracking continues) but do not over-deduct below zero.
          await tx.tokenUsage.create({ data: usageData });
          return;
        }
        await tx.user.update({
          where: { id: userId },
          data: { creditBalance: { decrement: credits } },
        });
        await tx.tokenUsage.create({ data: usageData });
      });
      return;
    } catch (err: any) {
      const busy =
        /serialization failure|deadlock/i.test(err?.message ?? '') ||
        err?.code === 'P1017' ||
        err?.code === 'P1001';
      // Insufficient-credits path returns early without throwing; only DB
      // lock/contention retries here.
      if (busy && attempt < MAX) {
        await new Promise((r) => setTimeout(r, attempt * 200));
        continue;
      }
      if (!busy) {
        // Non-lock errors (e.g. the "User not found" case) propagate.
        throw err;
      }
    }
  }
  // Reaching here means we exhausted retries on a busy lock.
  throw new Error('DB_BUSY: credit deduction failed after retries');
}

export async function processTokenUsage(input: TokenUsageInput): Promise<UserTokenView> {
  const mode = normalizeMode(input.mode);
  const actualInput = Math.max(0, Math.floor(input.providerUsage.inputTokens || 0));
  const actualOutput = Math.max(0, Math.floor(input.providerUsage.outputTokens || 0));

  // 1) Verified output limit (cache read only — never discover here).
  const verifiedOutputLimit = await getVerifiedOutputLimit(input.modelKey).catch(() => null);

  // 2) Billing (display + overflow transfer).
  const billing = calculateBilling(actualInput, actualOutput, mode, verifiedOutputLimit);

  // 3) Anti-reverse-engineering rounding before the user sees anything.
  const display = applyAntiReverseRounding(billing);
  const multiplier = multiplierFor(mode);

  // 4) Model limit provenance.
  const row = await getModelLimitRow(input.modelKey).catch(() => null);

  const usageData = buildUsageRecord({
    userId: input.userId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    model: input.modelKey,
    modelVersion: row?.version ?? null,
    actualInput,
    actualOutput,
    billing,
    mode,
    multiplier,
    verifiedOutputLimit,
    limitSource: row?.source ?? 'unknown',
    limitVerifiedAt: row?.verifiedAt?.toISOString() ?? null,
  });

  // 5) Credit deduction (display-based) inside a retried transaction.
  const creditsUsed = deductCredits(display, input.modelKey);
  await withRetry(() => deductUserCredits(input.userId, creditsUsed, usageData), 3, 'deductUserCredits');

  // 6) User view — display values + credits only. No actual/multiplier/
  //    limit/source/headroom leaks.
  return {
    tokenUsage: {
      displayInput: display.displayInput,
      displayOutput: display.displayOutput,
      displayTotal: display.displayTotal,
    },
    creditsUsed,
  };
}
