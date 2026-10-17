// ================================================================
// Fact Writer — the ONLY write port for fact truth (R4).
// Every fact-value change flows through writeFactValue in a single
// transaction: fact update + version+1 + FactLifecycleHistory append +
// FactRefreshState write-back. orgApplier only handles structure
// (lifecycle/relation/category); the two are mutually exclusive at
// the factId level.
// ================================================================

import { prismaKnowledge } from '../db';
import { computeAdaptiveInterval, currentCycleStr } from './adaptiveInterval';
import type { FactDiffVerdict } from './factValueDiff';

export interface WriteFactValueInput {
  factId: string;
  newValue: string | null; // null = no new value (e.g. UNVERIFIED)
  changeType: FactDiffVerdict;
  evidenceIds?: string[];
  sourceIds?: string[];
  researchJobId?: string | null;
  refreshTaskId?: string | null;
  // adaptive-interval inputs (from the refresh worker)
  adaptive?: {
    prevIntervalMonths: number;
    consecutiveFailureCountBefore: number;
    unchangedStreakBefore: number;
    lastStatus: 'UNCHANGED' | 'MINOR_CHANGE' | 'MATERIAL_CHANGE' | 'CONFLICT' | 'SOURCE_GONE' | 'UNVERIFIED' | 'REFRESH_FAILED' | 'CANNOT_VERIFY';
  };
  // config snapshot (caller passes the env-resolved config, keeping writer pure-ish)
  refreshConfig?: {
    stableSteps?: number[];
    hotStep?: number;
    maxConsecutiveFailures?: number;
    pauseCyclesAfterMaxFailures?: number;
  };
}

const STABLE_STEPS = [1, 2, 3, 6, 12];
const HOT_STEP = 0.5;
const MAX_FAIL = 3;
const PAUSE_CYCLES = 1;

export async function writeFactValue(input: WriteFactValueInput): Promise<{ newVersion: number; newIntervalMonths: number; priority: number }> {
  const cfg = {
    stableSteps: input.refreshConfig?.stableSteps ?? STABLE_STEPS,
    hotStep: input.refreshConfig?.hotStep ?? HOT_STEP,
    maxConsecutiveFailures: input.refreshConfig?.maxConsecutiveFailures ?? MAX_FAIL,
    pauseCyclesAfterMaxFailures: input.refreshConfig?.pauseCyclesAfterMaxFailures ?? PAUSE_CYCLES,
  };

  const isChange = input.changeType === 'MATERIAL_CHANGE' || input.changeType === 'MINOR_CHANGE';
  const adaptiveInput = input.adaptive;

  const historyEventType = mapToHistoryEvent(input.changeType, input.researchJobId);

  // Run the whole fact write as one transaction so fact version, history
  // audit, and refresh-state write-back stay atomic.
  const [fact, currentInt, currentPriority] = await prismaKnowledge.$transaction(async (tx) => {
    const current = await tx.knowledgeFact.findUnique({ where: { id: input.factId } });
    if (!current) throw new Error(`FactWriter: fact ${input.factId} not found`);

    const newVersion = current.version + 1;
    const shouldUpdateClaim = isChange && input.newValue !== null;
    const verificationStatus = pickVerification(input.changeType, current.verificationStatus);

    const updated = await tx.knowledgeFact.update({
      where: { id: input.factId },
      data: {
        claim: shouldUpdateClaim ? input.newValue : current.claim,
        verificationStatus,
        version: newVersion,
        lastVerifiedAt: new Date(),
      },
    });

    await tx.factLifecycleHistory.create({
      data: {
        factId: input.factId,
        eventType: historyEventType,
        oldValue: isChange ? current.claim : null,
        newValue: isChange && input.newValue ? input.newValue : null,
        changeType: input.changeType,
        evidenceIds: JSON.stringify(input.evidenceIds ?? []),
        sourceIds: JSON.stringify(input.sourceIds ?? []),
        researchJobId: input.researchJobId ?? null,
        refreshTaskId: input.refreshTaskId ?? null,
        refreshCycle: adaptiveInput ? currentCycleStr() : null,
      },
    });

    // FactRefreshState write-back
    let state = await tx.factRefreshState.findUnique({ where: { factId: input.factId } });
    if (!state) {
      state = await tx.factRefreshState.create({
        data: {
          factId: input.factId,
          nextRefreshAt: new Date(),
          refreshIntervalMonths: cfg.stableSteps[0],
          priority: 3,
          consecutiveFailureCount: 0,
          unchangedStreak: 0,
          refreshCycle: currentCycleStr(),
        },
      });
    }

    if (adaptiveInput) {
      const result = computeAdaptiveInterval({
        prevIntervalMonths: state.refreshIntervalMonths,
        lastStatus: adaptiveInput.lastStatus,
        consecutiveFailureCountBefore: adaptiveInput.consecutiveFailureCountBefore,
        unchangedStreakBefore: adaptiveInput.unchangedStreakBefore,
        maxConsecutiveFailures: cfg.maxConsecutiveFailures,
        pauseCyclesAfterMaxFailures: cfg.pauseCyclesAfterMaxFailures,
        stableSteps: cfg.stableSteps,
        hotStep: cfg.hotStep,
        currentCycle: currentCycleStr(),
      });
      await tx.factRefreshState.update({
        where: { factId: input.factId },
        data: {
          nextRefreshAt: result.nextRefreshAt,
          refreshIntervalMonths: result.newIntervalMonths,
          priority: result.priority,
          consecutiveFailureCount: result.consecutiveFailureCount,
          unchangedStreak: result.unchangedStreak,
          pausedUntil: result.pausedUntil,
          lastRefreshAt: new Date(),
          lastRefreshStatus: adaptiveInput.lastStatus,
        },
      });
    } else {
      await tx.factRefreshState.update({
        where: { factId: input.factId },
        data: { lastRefreshAt: new Date(), lastRefreshStatus: input.changeType },
      });
    }

    // capture final refresh-state values to return out of the tx
    const finalState = await tx.factRefreshState.findUnique({ where: { factId: input.factId } });
    const currentInt = finalState?.refreshIntervalMonths ?? cfg.stableSteps[0];
    const currentPriority = finalState?.priority ?? 3;

    return [updated, currentInt, currentPriority];
  });

  return { newVersion: fact.version, newIntervalMonths: currentInt, priority: currentPriority };
}

function pickVerification(changeType: FactDiffVerdict, current: string): string {
  switch (changeType) {
    case 'CONFLICT':
      return 'CONFLICTED';
    case 'UNVERIFIED':
      return 'UNVERIFIED';
    case 'MATERIAL_CHANGE':
    case 'MINOR_CHANGE':
      return current === 'CONFLICTED' ? 'CONFLICTED' : 'VERIFIED';
    default:
      return current;
  }
}

function mapToHistoryEvent(changeType: FactDiffVerdict, researchJobId?: string | null): string {
  if (researchJobId) return 'REPAIRED';
  switch (changeType) {
    case 'MATERIAL_CHANGE': return 'MATERIAL_CHANGE';
    case 'MINOR_CHANGE': return 'MINOR_CHANGE';
    case 'CONFLICT': return 'CONFLICT_OPENED';
    case 'SOURCE_GONE': return 'SOURCE_GONE';
    case 'UNVERIFIED': return 'INSUFFICIENT_EVIDENCE';
    default: return 'REFRESHED';
  }
}
