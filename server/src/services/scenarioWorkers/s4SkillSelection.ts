// ================================================================
// S4 Final Skill Selection — deterministic "do we need a Skill at all"
// call, combining S2's per-skill decisions + tier/experiment constraints.
//
// No LLM: S2 already made the semantic per-skill fit judgment
// (use / experimental / reject / none); S4 is a pure selection rule over
// those decisions. Invariants preserved:
//   - empty selection is a legitimate terminal state (selected = []);
//   - a non-empty candidate set does not force a selection (only S2's
//     "use" decisions become selections; experimental ones are staged,
//     never auto-selected);
//   - duplicate skills are never both selected (dedup by skill_id).
// ================================================================

import type { S2Output } from './s2SkillJudge';

export interface S4Input {
  s2: S2Output;
  scenario: { id: string; name: string; category: string };
  user_tier?: string; // permission tier
  experiment_constraints?: string[];
}

export interface S4Output {
  selected_skill_ids: string[]; // allowed to be []
  empty_selection: boolean;
  confidence: number;
  selection_reason: string;
  rejected_skill_ids: string[];
  experiment_candidates: string[];
}

export async function runS4(input: S4Input): Promise<S4Output> {
  const decisions = input.s2?.decisions ?? [];
  const use = decisions.filter((d) => d.decision === 'use');
  const experimental = decisions.filter((d) => d.decision === 'experimental');
  const rejected = decisions.filter((d) => d.decision === 'reject');

  // Only S2's "use" decisions are selected. Experimental skills are bounded
  // and never force a selection; a "use" skill is excluded from the
  // experimental list (dedup by skill_id).
  const selected = use.map((d) => d.skill_id);
  const cap = experimentCap(input.experiment_constraints);
  const experiment_candidates = experimental
    .slice(0, cap)
    .map((d) => d.skill_id)
    .filter((id) => !selected.includes(id));

  const empty_selection = selected.length === 0;
  const baseConfidence =
    typeof input.s2?.overall_confidence === 'number'
      ? Math.max(0, Math.min(1, input.s2.overall_confidence))
      : 0.5;
  const confidence = empty_selection ? 0.3 : baseConfidence;

  const parts: string[] = [];
  if (selected.length) parts.push(`selected: ${selected.join(', ')}`);
  if (experiment_candidates.length) parts.push(`experimental: ${experiment_candidates.join(', ')} (cap ${cap})`);
  if (rejected.length) parts.push(`rejected: ${rejected.map((d) => d.skill_id).join(', ')}`);
  if (empty_selection) parts.push('no S2 "use" decision -> empty selection');
  if (input.user_tier) parts.push(`tier=${input.user_tier}`);
  const selection_reason = parts.join('; ') || 'no skill candidates';

  return {
    selected_skill_ids: selected,
    empty_selection,
    confidence,
    selection_reason,
    rejected_skill_ids: rejected.map((d) => d.skill_id),
    experiment_candidates,
  };
}

// Experiment cap: parse 'experiment<=N' / 'experiments<=N' from constraints;
// default 1 (parity with the P3 Exploit/Explore explore limit).
function experimentCap(constraints?: string[]): number {
  for (const c of constraints ?? []) {
    const m = c.match(/experiment(?:s)?\s*<=?\s*(\d+)/i);
    if (m) return parseInt(m[1], 10);
  }
  return 1;
}
