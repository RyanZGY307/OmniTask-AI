// ================================================================
// M5 Model Outcome Analyzer — runs on outcome jobs (async, after the
// original answer is delivered). Describes "what happened" from the
// user follow-up as one of eight outcomes. M5 never modifies the
// ModelScenarioCompatibility matrix (R12); it only emits outcome +
// issue signals + confidence for M6 attribution.
// ================================================================

import { prismaUser } from '../db';
import { callAgnes, parseWorkerJson } from '../scenarioWorkers/agnesCaller';
import { M5_SYSTEM } from './prompts';

export type M5Outcome =
  | 'success'
  | 'partial_success'
  | 'correction'
  | 'requirement_change'
  | 'model_issue_signal'
  | 'scenario_issue_signal'
  | 'output_issue_signal'
  | 'uncertain';

const M5_OUTCOMES: M5Outcome[] = [
  'success', 'partial_success', 'correction', 'requirement_change',
  'model_issue_signal', 'scenario_issue_signal', 'output_issue_signal', 'uncertain',
];

export interface M5Input {
  scenarioId: string;
  modelId: string;
  originalRequest: string;
  followUp: string;
  previousOutputSummary?: string;
  verificationPassed?: boolean | null;
  fallbackUsed?: boolean;
  promptSummary?: string;
  skillIds?: string[];
  knowledgeRefs?: string[];
}

export interface M5Output {
  outcome: M5Outcome;
  model_issue_signal: number;
  scenario_issue_signal: number;
  output_issue_signal: number;
  confidence: number;
}

// Pure M5 analysis (no job bookkeeping). Exposed for tests and M6
// chaining; returns null when the output fails Schema validation.
export async function runM5(input: M5Input): Promise<M5Output | null> {
  try {
    const userPrompt = JSON.stringify({
      scenario_id: input.scenarioId,
      model: input.modelId,
      original_request: input.originalRequest.slice(0, 4000),
      follow_up: input.followUp.slice(0, 4000),
      previous_output_summary: input.previousOutputSummary?.slice(0, 2000) ?? '',
      verification_passed: input.verificationPassed ?? null,
      fallback_used: input.fallbackUsed ?? false,
      prompt_summary: input.promptSummary?.slice(0, 1000) ?? '',
      skill_ids: input.skillIds ?? [],
      knowledge_refs: input.knowledgeRefs ?? [],
    });

    const raw = await callAgnes(M5_SYSTEM, userPrompt, {
      model: 'Agnes-2.5-flash',
      temperature: 0,
      maxTokens: 1024,
      timeoutMs: 20_000,
    });

    const parsed = parseWorkerJson<M5Output>(raw, { outcome: M5_OUTCOMES });
    if (!parsed || !M5_OUTCOMES.includes(parsed.outcome)) return null;

    return {
      outcome: parsed.outcome,
      model_issue_signal: num(parsed.model_issue_signal, 0),
      scenario_issue_signal: num(parsed.scenario_issue_signal, 0),
      output_issue_signal: num(parsed.output_issue_signal, 0),
      confidence: num(parsed.confidence, 0.5),
    };
  } catch (err: any) {
    console.warn(`[M5] failed: ${err?.message}`);
    return null;
  }
}

// Execute a queued outcome job. The full request/follow-up context is
// carried in resultJson-style payload attached at enqueue time; when
// absent, M5 degrades to 'uncertain' (no matrix impact, spec R12.5).
export async function executeM5Job(jobId: string): Promise<void> {
  const job = await prismaUser.modelProfileJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  if (job.status === 'COMPLETED' || job.status === 'FAILED') return;
  if (!job.modelId || !job.scenarioId) {
    await markFailed(job.id, 'job missing modelId/scenarioId');
    return;
  }

  // Enqueue-time payload (optional): { originalRequest, followUp, ... }.
  // Declared with `any` so the caller can pass a richer payload that
  // includes user_id / fallback_used (not part of M5Input) without a
  // separate widening step.
  let payload: any = {};
  try {
    payload = job.resultJson ? JSON.parse(job.resultJson) : {};
  } catch {
    payload = {};
  }

  let out = await runM5({
    scenarioId: job.scenarioId,
    modelId: job.modelId,
    originalRequest: String(payload.originalRequest ?? ''),
    followUp: String(payload.followUp ?? ''),
    previousOutputSummary: payload.previousOutputSummary,
    verificationPassed: payload.verificationPassed,
    fallbackUsed: payload.fallbackUsed,
    promptSummary: payload.promptSummary,
    skillIds: payload.skillIds,
    knowledgeRefs: payload.knowledgeRefs,
  });

  if (!out) {
    // No parseable M5 output: record uncertain, let the matrix only
    // accumulate experiment_count via M6 (spec: M5 uncertain path).
    out = {
      outcome: 'uncertain',
      model_issue_signal: 0,
      scenario_issue_signal: 0,
      output_issue_signal: 0,
      confidence: 0,
    };
  }

  await prismaUser.modelProfileJob.update({
    where: { id: job.id },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      resultJson: JSON.stringify(out),
      lastError: null,
    },
  });

  // Chain M6 attribution unless M5 is uncertain (no attribution from
  // uncertain signals — spec Error Handling).
  if (out.outcome !== 'uncertain') {
    await enqueueM6Attribution(
      {
        id: job.id,
        modelId: job.modelId,
        scenarioId: job.scenarioId,
        poolVersion: job.poolVersion,
      },
      out,
      payload,
    );
  }
}

// Enqueue a M5 outcome job for a (model, scenario) request that just
// finished. The caller attaches the request/follow-up payload so the
// M5 executor does not need to re-query the conversation store.
export async function enqueueM5Outcome(
  data: {
    modelId: string;
    scenarioId: string;
    poolVersion?: string | null;
    userId?: string;
    trigger?: string;
  } & Partial<Record<keyof M5Input, any>>,
): Promise<string | null> {
  const { createModelProfileJob } = await import('./m2NewScenario');
  const id = await createModelProfileJob({
    jobKind: 'outcome',
    trigger: data.trigger ?? 'user_feedback',
    modelId: data.modelId,
    scenarioId: data.scenarioId,
    poolVersion: data.poolVersion ?? null,
  });
  if (!id) return null;
  // Attach the full M5 input payload (and M6 context) to the job row
  // so the executor can run without re-reading the conversation store.
  const payload: Record<string, any> = { ...data };
  if (data.userId) payload.user_id = data.userId;
  await prismaUser.modelProfileJob.update({
    where: { id },
    data: { resultJson: JSON.stringify(payload) },
  }).catch(() => undefined);
  return id;
}

export async function enqueueM6Attribution(
  job: { id: string; modelId: string; scenarioId: string; poolVersion: string | null },
  m5: M5Output,
  payload: Partial<M5Input> & { user_id?: string; fallback_used?: boolean },
): Promise<string | null> {
  // Lazy import to keep the module graph acyclic.
  const { createModelProfileJob } = await import('./m2NewScenario');
  const attributionInput = JSON.stringify({
    m5,
    scenario_id: job.scenarioId,
    model: job.modelId,
    prompt_summary: payload.promptSummary ?? '',
    skill_ids: payload.skillIds ?? [],
    knowledge_refs: payload.knowledgeRefs ?? [],
    verification_passed: payload.verificationPassed ?? null,
    fallback_used: payload.fallback_used ?? false,
    user_id: payload.user_id ?? 'anonymous',
  });
  const id = await createModelProfileJob({
    jobKind: 'attribution',
    trigger: 'user_feedback',
    modelId: job.modelId,
    scenarioId: job.scenarioId,
    poolVersion: job.poolVersion,
  });
  if (id) {
    // Attach M5 result + context so M6 can read it without a second call.
    await prismaUser.modelProfileJob.update({
      where: { id },
      data: { resultJson: attributionInput },
    }).catch(() => undefined);
  }
  return id;
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
