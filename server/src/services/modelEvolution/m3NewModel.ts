// ================================================================
// M3 New Model Profiler — fan-out for a newly registered model:
// one ModelProfileJob per (newModel x every published scenario in
// the Global Scenario Registry) (R7.4: only the new model, never
// re-profile old models). Execution reuses the shared M1 code path
// via m1Profiler.executeM1Job (jobKind=model_scenario, trigger=
// new_model).
// ================================================================

import { prismaKnowledge } from '../db';
import { createModelProfileJob } from './m2NewScenario';
import { buildPoolVersion } from './modelPool';

export interface M3FanOutResult {
  modelId: string;
  enqueued: number;
  totalScenarios: number;
  poolVersion: string;
}

// Enqueue M3 jobs: newModel x all published scenarios. Pool version is
// the current baseline snapshot so the priors are traceable (R8.3).
// Only published + experimental scenarios are fanned out; deprecated /
// merged scenarios are excluded.
export async function enqueueM3ModelJobs(modelId: string): Promise<M3FanOutResult> {
  const poolVersion = buildPoolVersion(null).versionHash;
  const scenarios = await prismaKnowledge.scenario.findMany({
    where: { status: { in: ['published', 'experimental'] } },
    select: { id: true },
  });

  let enqueued = 0;
  for (const s of scenarios) {
    const jobId = await createModelProfileJob({
      jobKind: 'model_scenario',
      trigger: 'new_model',
      modelId,
      scenarioId: s.id,
      poolVersion,
    });
    if (jobId) enqueued++;
  }

  return { modelId, enqueued, totalScenarios: scenarios.length, poolVersion };
}
