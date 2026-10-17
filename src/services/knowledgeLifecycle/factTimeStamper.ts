// ================================================================
// Fact Time Stamper — D3 onboarding + recordedAt invariant (R1).
// When a KnowledgeFact is first written, initialize its FactRefreshState
// so the periodic refresh scheduler can dispatch it. recordedAt is
// always KnowledgeFact.createdAt (no separate column).
// ================================================================

import { prismaKnowledge } from '../db';
import { currentCycleStr } from './adaptiveInterval';

export interface FactOnboardingInput {
  factId: string;
  lifecycleStatus: string;
  verificationStatus: string;
  // initial priority hint (from claim type: official/verified get higher priority)
  initialPriority?: 1 | 2 | 3 | 4;
  // initial cadence in months (default 1)
  initialIntervalMonths?: number;
}

// Idempotent: if a FactRefreshState already exists for the fact, leave it.
// D3: non-ACTIVE lifecycle or non-refreshable verification -> archived = true
// so the scheduler never dispatches it, but the row still exists for audit.
export async function stampNewFact(input: FactOnboardingInput): Promise<void> {
  const { factId, lifecycleStatus, verificationStatus, initialPriority, initialIntervalMonths } = input;

  const existing = await prismaKnowledge.factRefreshState.findUnique({ where: { factId } });
  if (existing) return; // idempotent — already stamped

  const refreshable =
    lifecycleStatus === 'ACTIVE' &&
    ['VERIFIED', 'SUPPORTED', 'CONFLICTED', 'UNVERIFIED'].includes(verificationStatus);

  const now = new Date();
  const intervalMonths = initialIntervalMonths ?? 1;
  const nextRefreshAt = new Date(now.getTime() + Math.round(intervalMonths * 30.44 * 24 * 60 * 60 * 1000));

  await prismaKnowledge.factRefreshState.create({
    data: {
      factId,
      nextRefreshAt,
      refreshIntervalMonths: intervalMonths,
      priority: initialPriority ?? 3,
      consecutiveFailureCount: 0,
      unchangedStreak: 0,
      refreshCycle: currentCycleStr(now),
      archived: !refreshable,
    },
  });
}

// Called when a fact's lifecycle leaves ACTIVE (MERGED/ARCHIVED/etc):
// freeze dispatch without deleting the row (D3 + history retention R6).
export async function archiveFactRefreshState(factId: string): Promise<void> {
  await prismaKnowledge.factRefreshState.updateMany({
    where: { factId },
    data: { archived: true },
  });
}
