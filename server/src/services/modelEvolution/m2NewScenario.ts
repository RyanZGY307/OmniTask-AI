// ================================================================
// M2 New Scenario Profiler — fan-out for a newly registered scenario:
// one ModelProfileJob per (newScenario x each model in the CURRENT
// runtime pool). The pool comes from modelPool (dynamic, entitlement
// aware, no hardcoded model lists — R1/R7.3). Each fanned-out job is
// executed by the shared M1 code path (m1Profiler.executeM1Job), so
// M2 itself only enqueues.
//
// Empty pool -> no jobs created; the realtime request path falls back
// to the Cold Start Rule (spec Error Handling).
// ================================================================

import { prismaUser } from '../db';
import { getAvailableModels, buildPoolVersion } from './modelPool';
import type { PoolModel } from './modelPool';
import { executeM1Job } from './m1Profiler';

export interface M2FanOutResult {
  scenarioId: string;
  enqueued: number;
  poolVersion: string;
}

// Enqueue M2 jobs: newScenario x runtime pool. `user` is the tier context
// the pool was derived under; pass null for the baseline (standard) pool.
// Pool version is persisted on each job row for traceability (R8.3); the
// optional ModelPoolVersion table is not required for this path.
export async function enqueueM2ScenarioJobs(
  scenarioId: string,
  user: { subscriptionTier?: string } | null = null,
): Promise<M2FanOutResult> {
  const pool: PoolModel[] = getAvailableModels(user);
  const poolVersion = buildPoolVersion(user).versionHash;

  if (pool.length === 0) {
    // Empty pool: nothing to profile; requests use the Cold Start Rule.
    return { scenarioId, enqueued: 0, poolVersion };
  }

  let enqueued = 0;
  for (const m of pool) {
    const jobId = await createModelProfileJob({
      jobKind: 'model_scenario',
      trigger: 'new_scenario',
      modelId: m.key,
      scenarioId,
      poolVersion,
    });
    if (jobId) enqueued++;
  }

  return { scenarioId, enqueued, poolVersion };
}

// Shared job creation helper for all M-series fan-outs (M2/M3/M4).
export async function createModelProfileJob(data: {
  jobKind: 'model_profile' | 'model_scenario' | 'drift_reeval' | 'outcome' | 'attribution';
  trigger: string;
  modelId?: string | null;
  scenarioId?: string | null;
  poolVersion?: string | null;
}): Promise<string | null> {
  try {
    const job = await prismaUser.modelProfileJob.create({
      data: {
        jobKind: data.jobKind,
        trigger: data.trigger,
        modelId: data.modelId ?? null,
        scenarioId: data.scenarioId ?? null,
        poolVersion: data.poolVersion ?? null,
        status: 'QUEUED',
      },
    });
    return job.id;
  } catch (err: any) {
    console.warn(`[M2] failed to enqueue modelProfileJob: ${err?.message}`);
    return null;
  }
}

// M2 fan-out jobs are consumed by the shared M1 execution path.
export { executeM1Job };
