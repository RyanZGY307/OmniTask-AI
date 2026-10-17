// ================================================================
// Rule Evidence Update — the statistics engine that (a) M6 feeds into
// via updateMatrixRow, and (b) the realtime experiment loop calls
// after each real answer.
//
// Two strictly separated write paths (R13 / CP10):
//   - writeM1Prior(...)     : M1/M2/M3 prior fields only
//                             (semanticFit, quality prior, poolVersion,
//                              inherited, status='experimental')
//   - updateMatrixRow(...)  : evidence-backed stats only
//                             (counts, userDistribution,
//                              recentPerformance, evidenceStrength,
//                              compatibility)
// No function writes both sides.
// ================================================================

import { prismaKnowledge } from '../db';
import type { M1Output } from './m1Profiler';

// User-hash tokens are capped: a row tracks at most 50 tokens so the
// matrix row stays a bounded payload (spec "store up to 50 userHash
// tokens in userDistribution").
const MAX_USER_HASHES = 50;
// recentPerformance is an EMA over the last experiments: 0.8 old +
// 0.2 new outcome.
const EMA_ALPHA = 0.2;

// ==================== M1 prior write (selection side) ====================

export interface M1PriorOpts {
  poolVersion?: string | null;
  inherited?: boolean;
  inheritedFromScenarioId?: string | null;
}

// Write ONLY the prior fields of a (model, scenario) row. If the row
// does not exist yet it is created with the prior as initial value and
// status='experimental'. An existing row's evidence-backed stats are
// NEVER overwritten; on a fresh row compatibility = quality prior,
// and on an existing row the compatibility field is left to the rule
// engine (only semanticFit/inherited metadata refresh).
export async function writeM1Prior(
  modelId: string,
  scenarioId: string,
  out: M1Output,
  opts: M1PriorOpts = {},
): Promise<void> {
  const inherited = opts.inherited ?? false;

  const existing = await prismaKnowledge.modelScenarioCompatibility.findUnique({
    where: { modelId_scenarioId: { modelId, scenarioId } },
  });

  if (existing) {
    // Refresh prior metadata only; keep all evidence columns intact.
    await prismaKnowledge.modelScenarioCompatibility.update({
      where: { modelId_scenarioId: { modelId, scenarioId } },
      data: {
        semanticFit: out.semantic_fit,
        confidence: Math.max(existing.confidence, out.confidence),
        inherited,
        inheritedFromScenarioId: inherited ? (opts.inheritedFromScenarioId ?? existing.inheritedFromScenarioId) : null,
        poolVersion: opts.poolVersion ?? existing.poolVersion,
        status: existing.status === 'experimental' ? 'experimental' : existing.status,
        lastEvaluated: new Date(),
      },
    });
    return;
  }

  // New row: prior seeds the initial compatibility and confidence.
  await prismaKnowledge.modelScenarioCompatibility.create({
    data: {
      modelId,
      scenarioId,
      compatibility: out.quality_expectation,
      confidence: out.confidence,
      semanticFit: out.semantic_fit,
      inherited,
      inheritedFromScenarioId: inherited ? (opts.inheritedFromScenarioId ?? null) : null,
      poolVersion: opts.poolVersion ?? null,
      status: 'experimental',
      lastEvaluated: new Date(),
    },
  });
}

// ==================== Evidence update (evaluation side) ====================

export interface MatrixUpdateInput {
  success?: boolean;
  correction?: boolean;
  verificationPassed?: boolean;
  fallbackUsed?: boolean;
  userId: string;
  direction?: 'positive' | 'negative' | 'neutral';
  strength?: number;
}

// Apply one real-experiment outcome to the matrix row: increment the
// right counters, maintain the user-hash set + recentPerformance EMA,
// recompute evidenceStrength (R4.3) and compatibility (R12.5 rule
// engine value — distinct from the M1 prior).
export async function updateMatrixRow(modelId: string, scenarioId: string, input: MatrixUpdateInput): Promise<void> {
  const row = await prismaKnowledge.modelScenarioCompatibility.findUnique({
    where: { modelId_scenarioId: { modelId, scenarioId } },
  });

  if (!row) {
    // An experiment implies a routing decision which implies a prior
    // row; if missing (cold start), create a minimal row so stats
    // accumulate and the next M1/M2 can seed it properly.
    await prismaKnowledge.modelScenarioCompatibility.create({
      data: { modelId, scenarioId, status: 'experimental' },
    });
    return updateMatrixRow(modelId, scenarioId, input);
  }

  // ---- counters ----
  let successCount = row.successCount;
  let correctionCount = row.correctionCount;
  let verificationCount = row.verificationCount;
  let fallbackCount = row.fallbackCount;
  let experimentCount = row.experimentCount + 1;

  if (input.success) successCount++;
  if (input.correction) correctionCount++;
  if (input.verificationPassed) verificationCount++;
  if (input.fallbackUsed) fallbackCount++;

  // ---- user-hash set (capped at 50) ----
  let userHashes = parseUserHashes(row.userDistribution);
  if (!userHashes.includes(input.userId)) {
    userHashes.push(input.userId);
    if (userHashes.length > MAX_USER_HASHES) userHashes = userHashes.slice(userHashes.length - MAX_USER_HASHES);
  }
  const uniqueUserCount = userHashes.length;

  // ---- recentPerformance EMA ----
  const successBool = input.success ? 1 : 0;
  const recentPerformance = clamp01(0.8 * row.recentPerformance + EMA_ALPHA * successBool);

  // ---- evidenceStrength (R4.3, exact formula) ----
  const correctionRate = experimentCount > 0 ? correctionCount / experimentCount : 0;
  const evidenceStrength = clamp01(
    Math.min(1, uniqueUserCount / 8) * 0.5 +
    Math.min(1, Math.log2(experimentCount + 1) / 6) * 0.3 +
    (1 - correctionRate) * 0.2,
  );

  // ---- compatibility (R12.5 rule-engine value) ----
  // Linear prior hand-off: staticWeight = 1 - evidenceStrength, so the
  // M1 prior (quality expectation captured at row creation) fades as
  // real evidence accumulates. The M1 semantic prior is not re-queried
  // here; compatibility is the evidence-backed value.
  const m1Prior = row.compatibility; // best available prior anchor
  const evidenceRate = successCount + verificationCount;
  const evidenceBase = experimentCount > 0 ? evidenceRate / experimentCount : recentPerformance;
  const staticWeight = 1 - evidenceStrength;
  const compatibility = clamp01(staticWeight * m1Prior + evidenceStrength * evidenceBase);

  await prismaKnowledge.modelScenarioCompatibility.update({
    where: { modelId_scenarioId: { modelId, scenarioId } },
    data: {
      successCount,
      correctionCount,
      verificationCount,
      fallbackCount,
      experimentCount,
      uniqueUserCount,
      userDistribution: JSON.stringify(userHashes),
      recentPerformance,
      evidenceStrength,
      compatibility,
      lastExperimentAt: new Date(),
    },
  });

  await promoteIfStable(modelId, scenarioId, uniqueUserCount, recentPerformance, evidenceStrength);
}

// Promote experimental -> stable when the cross-user threshold is met
// (R4.4), and bump the model's scenario-diversity counter on first
// transition into stable for this scenario.
export async function promoteIfStable(
  modelId: string,
  scenarioId: string,
  uniqueUserCount: number,
  recentPerformance: number,
  evidenceStrength: number,
): Promise<void> {
  const row = await prismaKnowledge.modelScenarioCompatibility.findUnique({
    where: { modelId_scenarioId: { modelId, scenarioId } },
  });
  if (!row) return;
  if (row.status !== 'experimental') return;
  if (uniqueUserCount < 3 || recentPerformance < 0.6 || evidenceStrength < 0.7) return;

  await prismaKnowledge.modelScenarioCompatibility.update({
    where: { modelId_scenarioId: { modelId, scenarioId } },
    data: { status: 'stable' },
  });

  // Bump the per-model stable scenario count (scenario_diversity, R4.4).
  // This row's transition IS the first time this scenario became stable
  // for the model (the row was experimental, now stable), so increment
  // exactly once.
  await prismaKnowledge.modelScenarioDiversity.upsert({
    where: { modelKey: modelId },
    update: { stableCount: { increment: 1 } },
    create: { modelKey: modelId, stableCount: 1 },
  });
}

// ==================== Helpers ====================

function parseUserHashes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    // Support both the plain-token array form and the legacy
    // [{userIdHash, share}] object form.
    if (Array.isArray(v)) {
      return v.map((e: any) => (typeof e === 'object' && e?.userIdHash ? String(e.userIdHash) : String(e))).slice(0, MAX_USER_HASHES);
    }
    return [];
  } catch {
    return [];
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
