// ================================================================
// M4 Drift Re-evaluator — runs on a drift_reeval job: judges whether
// a (model, scenario) row has drifted, and what the rule layer should
// do (lower / re-experiment / rebuild prior). M4 NEVER writes the
// final compatibility value — the rule engine recomputes it. The row
// status is moved to 'reevaluating' (or 'experimental' when
// lower_compatibility) and M1 rebuild tasks are queued when
// rebuild_prior=true (R14 / spec CP7).
// ================================================================

import { prismaKnowledge, prismaUser } from '../db';
import { createModelProfileJob } from './m2NewScenario';

export interface M4Output {
  drift: boolean;
  lower_compatibility: boolean;
  re_experiment: boolean;
  rebuild_prior: boolean;
  reason: string;
}

export async function executeM4Job(jobId: string): Promise<void> {
  const job = await prismaUser.modelProfileJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  if (job.status === 'COMPLETED' || job.status === 'FAILED') return;
  if (!job.modelId || !job.scenarioId) {
    await markFailed(job.id, 'job missing modelId/scenarioId');
    return;
  }

  const row = await prismaKnowledge.modelScenarioCompatibility.findUnique({
    where: { modelId_scenarioId: { modelId: job.modelId, scenarioId: job.scenarioId } },
  });
  if (!row) {
    await markFailed(job.id, 'matrix row not found');
    return;
  }

  // Recent M5 outcomes for this (model, scenario): outcome distribution.
  const recentOutcomes = await prismaUser.modelProfileJob.findMany({
    where: { jobKind: 'outcome', modelId: job.modelId, scenarioId: job.scenarioId, status: 'COMPLETED' },
    orderBy: { queuedAt: 'desc' },
    take: 20,
    select: { resultJson: true },
  });
  const outcomeCounts = countOutcomes(recentOutcomes.map((o) => o.resultJson));

  const parsed = deterministicM4(row, outcomeCounts);

  // Rule layer: status transitions + M1 rebuild queueing. AI never
  // rewrites compatibility here (CP7 / R14).
  let status = row.status;
  if (parsed.drift || parsed.lower_compatibility) {
    status = parsed.lower_compatibility ? 'experimental' : 'reevaluating';
  }
  if (parsed.re_experiment) {
    status = 'experimental';
  }

  await prismaKnowledge.modelScenarioCompatibility.update({
    where: { modelId_scenarioId: { modelId: job.modelId, scenarioId: job.scenarioId } },
    data: {
      status,
      lastEvaluated: new Date(),
    },
  });

  if (parsed.rebuild_prior) {
    // Rebuild via M1 re-profile against the current pool version.
    await createModelProfileJob({
      jobKind: 'model_profile',
      trigger: 'drift',
      modelId: job.modelId,
      scenarioId: job.scenarioId,
      poolVersion: job.poolVersion ?? null,
    });
  }

  await prismaUser.modelProfileJob.update({
    where: { id: job.id },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      resultJson: JSON.stringify(parsed),
      lastError: null,
    },
  });
}

// Deterministic drift decision (no LLM): recent performance vs prior
// compatibility + the recent M5 outcome distribution.
export function deterministicM4(
  row: { compatibility: number; experimentCount: number; uniqueUserCount: number; recentPerformance: number | null },
  recent: Record<string, number>,
): M4Output {
  const total = Object.values(recent).reduce((a, b) => a + b, 0);
  const neg =
    (recent['correction'] ?? 0) +
    (recent['model_issue_signal'] ?? 0) +
    (recent['scenario_issue_signal'] ?? 0) +
    (recent['output_issue_signal'] ?? 0);
  const negRate = total > 0 ? neg / total : 0;
  const perf = row.recentPerformance ?? row.compatibility;
  const perfDelta = perf - row.compatibility; // <0 => recent perf below prior compatibility
  const enough = total >= 5;

  const drift = (enough && perfDelta < -0.1) || (enough && negRate > 0.5);
  const lower_compatibility = drift && negRate > 0.4;
  const weakEvidence = row.experimentCount < 5 || row.uniqueUserCount < 3;
  const re_experiment = drift && weakEvidence;
  const rebuild_prior = drift && (lower_compatibility || weakEvidence);

  const reason = drift
    ? `deterministic drift: recent perf ${perf.toFixed(2)} vs prior ${row.compatibility} (delta ${perfDelta.toFixed(2)}), negative-outcome rate ${negRate.toFixed(2)} over ${total} samples`
    : 'no drift signal (deterministic)';

  return { drift, lower_compatibility, re_experiment, rebuild_prior, reason };
}

// Aggregate M5 outcome labels from job resultJson payloads.
function countOutcomes(resultJsons: (string | null)[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const raw of resultJsons) {
    if (!raw) continue;
    try {
      const o = JSON.parse(raw);
      const label = String(o?.outcome ?? 'unknown');
      counts[label] = (counts[label] ?? 0) + 1;
    } catch {
      continue;
    }
  }
  return counts;
}

function asBool(v: any): boolean {
  return v === true || v === 'true';
}

async function markFailed(jobId: string, reason: string): Promise<void> {
  await prismaUser.modelProfileJob.update({
    where: { id: jobId },
    data: {
      status: 'FAILED',
      lastError: reason.slice(0, 2000),
      attemptCount: { increment: 1 },
      completedAt: new Date(),
    },
  }).catch(() => undefined);
}
