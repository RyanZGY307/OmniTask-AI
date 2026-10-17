// ================================================================
// M1 Initial Profiler — executes a single (model, scenario) Model
// Profile Job (jobKind=model_profile, or model_scenario when fanned
// out by M2/M3). Loads the model profile + scenario definition +
// similar-scenario historical evidence, calls Agnes with M1_SYSTEM,
// Schema-validates the 7-field output, and writes ONLY the prior
// fields to the ModelScenarioCompatibility row (upsert). Evidence-
// backed stats columns are never touched here (R13 CP10 isolation).
// ================================================================

import { prismaKnowledge, prismaUser } from '../db';
import { getDynamicModels, type ModelRegistryEntry } from '../configSync';
import { callAgnes, parseWorkerJson } from '../scenarioWorkers/agnesCaller';
import { M1_SYSTEM } from './prompts';
import { writeM1Prior } from './ruleEvidenceUpdate';

export interface M1Output {
  semantic_fit: 'high' | 'medium' | 'low' | 'reject';
  capability_fit: number;
  quality_expectation: number;
  reason_codes: string[];
  risk: 'low' | 'medium' | 'high';
  confidence: number;
  experiment_priority: number;
}

const SEMANTIC_FITS: M1Output['semantic_fit'][] = ['high', 'medium', 'low', 'reject'];
const RISKS: M1Output['risk'][] = ['low', 'medium', 'high'];

// Shared M1 execution path. Called directly for jobKind=model_profile and
// via dynamic import by M2/M3 fan-out jobs (jobKind=model_scenario) so a
// single code path owns prior writing for all three workers.
export async function runM1Task(modelId: string, scenarioId: string, opts: { poolVersion?: string | null } = {}): Promise<M1Output> {
  const entry = getDynamicModels()[modelId] as ModelRegistryEntry | undefined;
  if (!entry) throw new Error(`model not in registry: ${modelId}`);

  const scenario = await prismaKnowledge.scenario.findUnique({ where: { id: scenarioId } });
  if (!scenario) throw new Error(`scenario not found: ${scenarioId}`);

  const hierarchy = buildHierarchy(scenario);

  // Similar-scenario historical evidence: matrix rows for sibling scenarios
  // (same family via parent chain), capped, stats-only (no user distribution).
  const siblingRows = await loadSiblingEvidence(scenario, hierarchy);

  const userPrompt = JSON.stringify({
    model: {
      key: modelId,
      version: entry.apiModel,
      status: entry.status,
      capabilities: entry.capabilities,
      quality_profile: entry.qualityProfile,
      speed_profile: entry.speedProfile,
      context_window: entry.contextWindow,
      category: entry.category,
    },
    scenario: {
      id: scenarioId,
      name: scenario.name,
      category: scenario.category,
      description: scenario.description ?? '',
      tags: parseTags(scenario.tags),
      path: scenario.path ?? '',
      parent_id: scenario.parent_id ?? null,
    },
    hierarchy,
    similar_evidence: siblingRows,
  });

  const raw = await callAgnes(M1_SYSTEM, userPrompt, {
    model: 'Agnes-3.0-flash',
    temperature: 0,
    maxTokens: 2048,
    timeoutMs: 30_000,
  });

  const parsed = parseWorkerJson<M1Output>(raw, {
    semantic_fit: SEMANTIC_FITS,
    risk: RISKS,
  });
  if (!parsed || !SEMANTIC_FITS.includes(parsed.semantic_fit)) {
    throw new Error('M1 produced no parseable output (schema validation failed)');
  }

  const out: M1Output = {
    semantic_fit: parsed.semantic_fit,
    capability_fit: num(parsed.capability_fit, 0.5),
    quality_expectation: num(parsed.quality_expectation, 0.5),
    reason_codes: strArr(parsed.reason_codes),
    risk: RISKS.includes(parsed.risk) ? parsed.risk : 'medium',
    confidence: num(parsed.confidence, 0.5),
    experiment_priority: num(parsed.experiment_priority, 0.5),
  };

  // Prior write: only prior fields, never the evidence columns (CP10).
  await writeM1Prior(modelId, scenarioId, out, {
    poolVersion: opts.poolVersion ?? null,
    inherited: Boolean(scenario.parent_id),
    inheritedFromScenarioId: scenario.parent_id ?? null,
  });

  return out;
}

// Execute a queued ModelProfileJob row of kind model_profile / model_scenario.
// Mirrors the skillAnalysis executor: terminal guards, run, complete/fail.
// The pool executor claims the row into RUNNING with lease/heartbeat before
// calling this; here we only run the task and record the terminal state.
export async function executeM1Job(jobId: string): Promise<void> {
  const job = await prismaUser.modelProfileJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  if (job.status === 'COMPLETED' || job.status === 'FAILED') return;
  if (!job.modelId || !job.scenarioId) {
    await markJobFailed(job.id, 'job missing modelId/scenarioId');
    return;
  }

  try {
    const out = await runM1Task(job.modelId, job.scenarioId, { poolVersion: job.poolVersion });
    await prismaUser.modelProfileJob.update({
      where: { id: job.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        resultJson: JSON.stringify(out),
        lastError: null,
      },
    });
  } catch (err: any) {
    await markJobFailed(job.id, String(err?.message ?? err));
  }
}

async function markJobFailed(jobId: string, reason: string): Promise<void> {
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

// ==================== Input assembly helpers ====================

// Parent chain of the scenario (path segments), e.g. coding/android/runtime.
function buildHierarchy(scenario: { parent_id?: string | null; path?: string | null }): string[] {
  const path = scenario.path || scenario.parent_id || '';
  return path.split('/').filter(Boolean);
}

// Sibling scenario ids: the scenario itself plus up to 4 ancestor family
// ids (segments of the parent chain) so the prompt stays bounded even for
// wide hierarchies.
function siblingScenarioIds(scenario: { id: string; parent_id?: string | null; path?: string | null }, hierarchy: string[]): string[] {
  const ids: string[] = [scenario.id];
  const ancestors = hierarchy.slice(0, -1);
  for (const seg of ancestors) ids.push(seg);
  if (scenario.parent_id && !ids.includes(scenario.parent_id)) ids.push(scenario.parent_id);
  return ids.slice(0, 5);
}

async function loadSiblingEvidence(
  scenario: { id: string; parent_id?: string | null; path?: string | null },
  hierarchy: string[],
): Promise<{ model_id: string; compatibility: number; experiment_count: number; unique_user_count: number; recent_performance: number }[]> {
  const ids = siblingScenarioIds(scenario, hierarchy);
  const rows = await prismaKnowledge.modelScenarioCompatibility.findMany({
    where: { scenarioId: { in: ids } },
    take: 20,
  });
  return rows.map((r) => ({
    model_id: r.modelId,
    compatibility: r.compatibility,
    experiment_count: r.experimentCount,
    unique_user_count: r.uniqueUserCount,
    recent_performance: r.recentPerformance,
  }));
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : String(raw).split(',').filter(Boolean);
  } catch {
    return String(raw).split(',').filter(Boolean);
  }
}

function strArr(v: any): string[] {
  return Array.isArray(v) ? v.map(String).slice(0, 12) : [];
}

function num(v: any, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : dflt;
}
