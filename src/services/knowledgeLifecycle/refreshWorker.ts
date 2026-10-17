// ================================================================
// Refresh Worker — executes one RefreshTask (R2/R5/R8).
// 1. re-fetch the fact's fresh evidence (bounded parallel)
// 2. structured comparison via factValueDiff (R5)
// 3. seven-state verdict
// 4. write through FactWriter (single write port)
// 5. CONFLICT / SOURCE_GONE -> open SelfRepairTask (R3) to feed the loop
// 6. REFRESH_FAILED -> D2 backoff (no streak/cadence change)
// ================================================================

import { prismaKnowledge, prismaUser } from '../db';
import { mapConcurrent } from '../utils';
import { diffFactValues, type FactDiffVerdict } from './factValueDiff';
import { writeFactValue } from './factWriter';
import { currentCycleStr } from './adaptiveInterval';
import { webSearch } from '../searchLayer';

const FETCH_CONCURRENCY = 4;

export interface RefreshTaskOutcome {
  taskId: string;
  verdict: FactDiffVerdict | 'REFRESH_FAILED' | 'CANNOT_VERIFY';
  newValue?: string;
  researchJobId?: string | null;
}

// Re-fetch evidence for a fact by searching its claim. A null `value` means
// no usable candidate was found (REFRESH_FAILED / SOURCE_GONE decided by caller).
async function refetchEvidence(claim: string, factId: string): Promise<{ value: string | null; evidenceIds: string[]; sourceIds: string[]; allFailed: boolean }> {
  const queries = [claim, `${claim} 2026`].slice(0, 3);

  const results = await mapConcurrent(queries, FETCH_CONCURRENCY, async (q) => {
    try {
      return await webSearch(q, { maxResults: 5 });
    } catch {
      return null;
    }
  });

  const allResults = (results as any[]).filter((r) => Array.isArray(r)).flat();
  if (allResults.length === 0) {
    return { value: null, evidenceIds: [], sourceIds: [], allFailed: true };
  }

  // Top source's snippet is the candidate value. In production this runs the
  // full evidenceCollector + crossValidation pipeline; here we extract a
  // compact value for the diff.
  const top = allResults[0];
  const value = String(top?.snippet || top?.title || '').trim() || null;
  const sourceIds = allResults.slice(0, 4).map((r: any) => r?.url).filter(Boolean) as string[];
  const evidenceIds: string[] = [];

  return { value, evidenceIds, sourceIds, allFailed: false };
}

export async function executeRefreshTask(taskId: string): Promise<RefreshTaskOutcome> {
  const task = await prismaUser.refreshTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error(`RefreshTask ${taskId} not found`);

  const fact = await prismaKnowledge.knowledgeFact.findUnique({ where: { id: task.factId } });
  if (!fact) {
    await markTerminal(task.id, 'CANNOT_VERIFY', 'fact not found');
    return { taskId, verdict: 'CANNOT_VERIFY' };
  }

  const state = await prismaKnowledge.factRefreshState.findUnique({ where: { factId: fact.id } });

  const { value, evidenceIds, sourceIds, allFailed } = await refetchEvidence(fact.claim, fact.id);

  let verdict: FactDiffVerdict | 'REFRESH_FAILED' | 'CANNOT_VERIFY';
  let researchJobId: string | null = null;

  if (allFailed || value === null) {
    // R5.5: fetch failed or source gone -> never UNCHANGED.
    verdict = 'REFRESH_FAILED';
    // A source that is gone (value null but sources existed in DB) escalates
    // to a self-repair to find an alternative official source.
    if (value === null) {
      researchJobId = await openRepairFromRefresh(task, fact, 'SOURCE_GONE').catch(() => null);
    }
  } else {
    verdict = diffFactValues(fact.claim, value);
  }

  // R3: conflict verdict feeds the self-repair loop (independent-source search)
  if (verdict === 'CONFLICT') {
    researchJobId = await openRepairFromRefresh(task, fact, 'REFRESH_CONFLICT').catch(() => null);
  }

  // Write through the single fact write port (idempotent per cycle).
  await writeFactValue({
    factId: fact.id,
    newValue: value,
    changeType: (verdict === 'REFRESH_FAILED' ? 'UNVERIFIED' : verdict) as FactDiffVerdict,
    evidenceIds,
    sourceIds,
    refreshTaskId: task.id,
    researchJobId,
    adaptive: {
      prevIntervalMonths: state?.refreshIntervalMonths ?? task.prevIntervalMonths ?? 1,
      consecutiveFailureCountBefore: state?.consecutiveFailureCount ?? 0,
      unchangedStreakBefore: state?.unchangedStreak ?? 0,
      lastStatus: verdict === 'REFRESH_FAILED' ? 'REFRESH_FAILED' : (verdict as any),
    },
  });

  await markTerminal(task.id, verdict, researchJobId ? `repair job ${researchJobId}` : undefined);

  return { taskId, verdict, newValue: value ?? undefined, researchJobId };
}

async function openRepairFromRefresh(task: any, fact: any, triggerType: string): Promise<string | null> {
  const cycle = currentCycleStr();
  // R3.2: look up-or-create on the idempotency key (rootTaskId, factId, cycle, triggerType)
  const key = {
    rootTaskId: task.id,
    targetFactId: fact.id,
    refreshCycle: cycle,
    triggerType,
  } as any;
  let taskRow = await prismaUser.selfRepairTask.findUnique({ where: key }).catch(() => null);
  if (taskRow && taskRow.status !== 'TERMINATED') return taskRow.id;

  taskRow = await prismaUser.selfRepairTask.create({
    data: {
      rootTaskId: task.id,
      triggerType,
      targetFactId: fact.id,
      reason: `refresh cycle ${cycle} verdict ${triggerType} for claim "${fact.claim}"`,
      iteration: 1,
      refreshCycle: cycle,
    },
  }).catch(() => null);
  if (!taskRow) return null;

  const { dispatchRepairResearch } = await import('./accuracyGate');
  const jobId = await dispatchRepairResearch(taskRow.id);
  return jobId ?? taskRow.id;
}

async function markTerminal(taskId: string, status: string, error?: string): Promise<void> {
  await prismaUser.refreshTask.update({
    where: { id: taskId },
    data: {
      status: status === 'REFRESH_FAILED' ? 'REFRESH_FAILED' : status,
      completedAt: new Date(),
      lastError: error ?? null,
      workerId: null,
      leaseUntil: null,
    },
  });
}
