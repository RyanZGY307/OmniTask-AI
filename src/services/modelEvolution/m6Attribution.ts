// ================================================================
// M6 Attribution Judge — depends on M5 output. Produces a signed
// attribution coefficient over (model / model_scenario / scenario /
// prompt / skill / knowledge / requirement_change). M6 only PROPOSES
// coefficients; it never writes the final DB score. The rule
// statistics engine (ruleEvidenceUpdate.updateMatrixRow) consumes the
// coefficients, applies time-decay + cross-user weighting, and writes
// the matrix row (R12 / R13 — selection and evaluation are isolated).
// ================================================================

import { createHash } from 'crypto';
import { prismaKnowledge, prismaUser } from '../db';
import { updateMatrixRow } from './ruleEvidenceUpdate';

export type M6Target =
  | 'model'
  | 'model_scenario'
  | 'scenario'
  | 'prompt'
  | 'skill'
  | 'knowledge'
  | 'requirement_change';

const M6_TARGETS: M6Target[] = [
  'model', 'model_scenario', 'scenario', 'prompt', 'skill', 'knowledge', 'requirement_change',
];
const M6_DIRECTIONS = ['positive', 'negative', 'neutral'] as const;

export interface M6Input {
  m5Outcome: string;
  scenarioId: string;
  modelId: string;
  promptSummary?: string;
  skillIds?: string[];
  knowledgeRefs?: string[];
  verificationPassed?: boolean | null;
  historicalExperiments?: number;
  fallbackUsed?: boolean;
}

export interface M6Output {
  target: M6Target;
  direction: 'positive' | 'negative' | 'neutral';
  strength: number; // signed: positive > 0, negative < 0, neutral = 0
  confidence: number;
  reason: string;
}

// Deterministic attribution (no LLM): maps the structured M5 outcome plus the
// involved components (fallback / verification / skill / knowledge) to a
// signed coefficient. The rule statistics engine (updateMatrixRow) already
// derives success/correction/verification from target + direction, so this is
// the only piece that was previously delegated to Agnes.
export async function runM6(input: M6Input): Promise<M6Output | null> {
  return deterministicM6(input);
}

export function deterministicM6(input: M6Input): M6Output {
  const out = input.m5Outcome;
  const fallback = Boolean(input.fallbackUsed);
  const verif = input.verificationPassed;
  const skills = input.skillIds?.length ?? 0;
  const knowledge = input.knowledgeRefs?.length ?? 0;

  let target: M6Target;
  let direction: M6Output['direction'];
  let magnitude: number;
  let reason: string;

  switch (out) {
    case 'success':
      target = 'model_scenario'; direction = 'positive'; magnitude = 0.5;
      reason = 'M5 success: confirms model x scenario compatibility';
      break;
    case 'partial_success':
      target = 'model_scenario'; direction = 'neutral'; magnitude = 0;
      reason = 'M5 partial success: no directional signal';
      break;
    case 'requirement_change':
      target = 'requirement_change'; direction = 'neutral'; magnitude = 0;
      reason = 'user changed the requirement; not attributable to model/skill';
      break;
    case 'model_issue_signal':
      target = 'model'; direction = 'negative'; magnitude = 0.5;
      reason = 'M5 flags a model issue';
      break;
    case 'scenario_issue_signal':
      target = 'scenario'; direction = 'negative'; magnitude = 0.4;
      reason = 'M5 flags scenario mismatch; model x scenario row unaffected';
      break;
    case 'output_issue_signal':
      target = 'model'; direction = 'negative'; magnitude = 0.35;
      reason = 'M5 flags an output issue -> model';
      break;
    case 'correction':
      if (fallback) { target = 'model'; direction = 'negative'; magnitude = 0.4; reason = 'correction with model fallback -> model'; }
      else if (skills) { target = 'skill'; direction = 'negative'; magnitude = 0.35; reason = 'correction with skill involved -> skill (matrix row untouched)'; }
      else if (knowledge) { target = 'knowledge'; direction = 'negative'; magnitude = 0.35; reason = 'correction with knowledge refs -> knowledge'; }
      else if (verif === false) { target = 'model'; direction = 'negative'; magnitude = 0.4; reason = 'correction + verification failed -> model'; }
      else { target = 'model'; direction = 'negative'; magnitude = 0.3; reason = 'correction with no other component -> model'; }
      break;
    default: // 'uncertain'
      target = 'model_scenario'; direction = 'neutral'; magnitude = 0;
      reason = 'M5 uncertain: no attribution';
      break;
  }

  const strength = direction === 'negative' ? -magnitude : direction === 'neutral' ? 0 : magnitude;
  return { target, direction, strength, confidence: out === 'uncertain' ? 0.3 : 0.6, reason };
}

// Execute a queued attribution job: read M5 result + context from the
// M6 job row's resultJson (attached by M5 chain), run M6, then let the
// rule statistics engine apply the coefficients to the matrix row.
export async function executeM6Job(jobId: string): Promise<void> {
  const job = await prismaUser.modelProfileJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  if (job.status === 'COMPLETED' || job.status === 'FAILED') return;
  if (!job.modelId || !job.scenarioId) {
    await markFailed(job.id, 'job missing modelId/scenarioId');
    return;
  }

  // M6 input was attached by M5 at enqueue time.
  let payload: Record<string, any> = {};
  try {
    payload = job.resultJson ? JSON.parse(job.resultJson) : {};
  } catch {
    payload = {};
  }

  const m5OutcomeLabel = payload.m5 ? String((payload.m5 as any).outcome ?? 'uncertain') : 'uncertain';
  const row = await prismaKnowledge.modelScenarioCompatibility.findUnique({
    where: { modelId_scenarioId: { modelId: job.modelId, scenarioId: job.scenarioId } },
  });

  const out = await runM6({
    m5Outcome: m5OutcomeLabel,
    scenarioId: job.scenarioId,
    modelId: job.modelId,
    promptSummary: payload.prompt_summary,
    skillIds: Array.isArray(payload.skill_ids) ? payload.skill_ids.map(String) : [],
    knowledgeRefs: Array.isArray(payload.knowledge_refs) ? payload.knowledge_refs.map(String) : [],
    verificationPassed: payload.verification_passed ?? null,
    historicalExperiments: row?.experimentCount ?? 0,
    fallbackUsed: Boolean(payload.fallback_used),
  });

  if (!out) {
    await markFailed(job.id, 'M6 produced no parseable output (schema validation failed)');
    return;
  }

  // Rule layer applies the coefficient: only model/model_scenario
  // targets with a negative direction count as a correction; prompt /
  // skill / knowledge / requirement_change targets leave the row alone
  // (spec R12.4 / Error Handling).
  const userIdHash = hashUserId(String(payload.user_id ?? 'anonymous'));
  const success = out.direction === 'positive' && (out.target === 'model' || out.target === 'model_scenario');
  const correction = out.direction === 'negative' && (out.target === 'model' || out.target === 'model_scenario');
  // Verification only applies when the failure is not attributed to the
  // prompt/skill layer: those targets mean the model output was fine but
  // the instruction/skill was wrong, so verification did not "pass".
  const verification = out.target !== 'prompt' && out.target !== 'skill';

  await updateMatrixRow(job.modelId, job.scenarioId, {
    success,
    correction,
    verificationPassed: Boolean(payload.verification_passed) && verification,
    fallbackUsed: Boolean(payload.fallback_used),
    userId: userIdHash,
    direction: out.direction,
    strength: out.strength,
  });

  await prismaUser.modelProfileJob.update({
    where: { id: job.id },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      resultJson: JSON.stringify({ ...out, m5_outcome: m5OutcomeLabel }),
      lastError: null,
    },
  });
}

// Stable hash of a user id so uniqueUserCount / userDistribution stay
// privacy-preserving (no raw ids in the matrix).
export function hashUserId(userId: string): string {
  if (!userId || userId === 'anonymous') return 'anon';
  const digest = createHash('sha1').update(userId).digest('hex');
  return digest.slice(0, 16);
}

function num(v: any, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : dflt;
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
