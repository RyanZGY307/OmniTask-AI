// ================================================================
// P2 Scenario Resolver — six-state resolution over retrieval candidates.
// The AI only proposes; the rule layer executes any DB writes
// (create_child/create_new -> Scenario row, merge/split -> EvolutionCandidate).
// ================================================================

import { callAgnes, parseWorkerJson } from './agnesCaller';
import { P2_SYSTEM } from './prompts';
import type { ScenarioUnderstanding } from './p1ScenarioAnalyzer';

export interface CandidateScenario {
  scenario: { id: string; name: string; category: string; path?: string; parent_id?: string };
  hit_reasons: string[];
  similarity?: number;
}

export type Resolution =
  | 'reuse_exact'
  | 'inherit_existing'
  | 'create_child'
  | 'create_new'
  | 'merge_candidate'
  | 'split_candidate';

export interface P2Result {
  resolution: Resolution;
  matched_scenario_id: string | null;
  new_scenario: {
    name: string;
    category: string;
    description: string;
    parent_id: string | null;
    path: string | null;
  } | null;
  inherited_from: string | null;
  reason: string;
  degraded?: boolean;
}

export async function runP2(
  p1: ScenarioUnderstanding,
  candidates: CandidateScenario[],
): Promise<P2Result> {
  try {
    const raw = await callAgnes(
      P2_SYSTEM,
      JSON.stringify({ p1, candidates }),
      { model: 'Agnes-2.5-flash', temperature: 0, maxTokens: 2048, timeoutMs: 10000 },
    );
    const RESOLUTIONS: Resolution[] = [
      'reuse_exact', 'inherit_existing', 'create_child', 'create_new', 'merge_candidate', 'split_candidate',
    ];
    const parsed = parseWorkerJson(raw, { resolution: RESOLUTIONS } as any);
    if (!parsed?.resolution || !RESOLUTIONS.includes(parsed.resolution as Resolution)) {
      throw new Error('P2 resolution out of enum');
    }
    return {
      resolution: parsed.resolution as Resolution,
      matched_scenario_id: parsed.matched_scenario_id ?? (candidates[0]?.scenario.id ?? null),
      new_scenario: parsed.new_scenario
        ? {
            name: String(parsed.new_scenario.name ?? ''),
            category: String(parsed.new_scenario.category ?? p1.domain ?? 'general'),
            description: String(parsed.new_scenario.description ?? p1.goal ?? ''),
            parent_id: parsed.new_scenario.parent_id ?? null,
            path: parsed.new_scenario.path ?? null,
          }
        : null,
      inherited_from: parsed.inherited_from ?? null,
      reason: String(parsed.reason ?? ''),
    };
  } catch (err: any) {
    // Degraded: use Top-1 retrieval candidate directly, no new scenario created.
    const top = candidates[0]?.scenario;
    console.warn(`[P2] degraded -> reuse Top-1: ${err?.message}`);
    return {
      resolution: top ? 'reuse_exact' : 'create_new',
      matched_scenario_id: top?.id ?? null,
      new_scenario: null,
      inherited_from: null,
      reason: 'p2_failed fallback to top candidate',
      degraded: true,
    };
  }
}
