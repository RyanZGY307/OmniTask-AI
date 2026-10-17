// ================================================================
// E1 Attribution Judge — signed attribution coefficients over
// P5 + S3 + SelectionDecision + compat snapshot. E1 proposes; the rule
// statistics engine computes new compatibility values (AI never writes
// success_rate directly).
// ================================================================

import type { P5Output } from './p5FeedbackAnalyzer';
import type { S3Output } from './s3SkillOutcome';

export interface E1Input {
  p5: P5Output | null;
  s3: S3Output | null;
  decision: {
    selected_atom_ids: string[];
    selected_skill_ids: string[];
    scenario_id: string | null;
  };
  compat_snapshot: {
    prompt: Record<string, number>;
    skill: Record<string, number>;
  };
}

export interface E1Output {
  attribution: {
    prompt: number;
    skill: Record<string, number>;
    scenario: number;
    model: number;
    output_format: number;
  };
  primary_cause: string;
  secondary_causes: string[];
  evolution_actions: string[];
  confidence: number;
}

// Deterministic attribution (no LLM): signed blame coefficients are derived
// from P5's change signals + S3's per-component impact signals. primary_cause
// is the most-blamed component; evolution_actions are the rule-layer fixes.
export async function runE1(input: E1Input): Promise<E1Output | null> {
  return deterministicE1(input);
}

export function deterministicE1(input: E1Input): E1Output {
  const p5 = input.p5;
  const s3 = input.s3;
  const selectedSkills = input.decision?.selected_skill_ids ?? [];

  // A component's blame is a negative coefficient, proportional to the
  // change/impact signal attributed to it by P5 / S3.
  const prompt = -clamp01(p5?.prompt_change_signal ?? 0);
  const scenario = -clamp01(p5?.scenario_change_signal ?? 0);
  const skillSignal = -clamp01(s3?.skill_specific_signal ?? p5?.skill_change_signal ?? 0);
  const skill: Record<string, number> = {};
  if (selectedSkills.length && skillSignal < 0) {
    const per = skillSignal / selectedSkills.length;
    for (const id of selectedSkills) skill[id] = per;
  }
  const model = 0; // E1's input carries no model signal; that is M6's job
  const output_format = 0;

  const ranked: Array<[string, number]> = [
    ['prompt', prompt],
    ['scenario', scenario],
    ['model', model],
    ...selectedSkills.map((id) => [`skill:${id}`, skill[id] ?? 0] as [string, number]),
  ];
  ranked.sort((a, b) => a[1] - b[1]); // most negative first
  const primary = ranked[0];
  const primary_cause = primary[1] < 0 ? primary[0] : 'unknown';
  const secondary_causes = ranked
    .filter((c) => c[1] < 0 && c[0] !== primary[0])
    .slice(0, 2)
    .map((c) => c[0]);

  const evolution_actions: string[] = [];
  if (primary_cause === 'prompt') evolution_actions.push('adjust_prompt_atom');
  else if (primary_cause === 'scenario') evolution_actions.push('refine_scenario');
  else if (primary_cause.startsWith('skill:')) evolution_actions.push('reselect_skill');
  else if (primary_cause === 'model') evolution_actions.push('reselect_model');

  return {
    attribution: { prompt, skill, scenario, model, output_format },
    primary_cause,
    secondary_causes,
    evolution_actions,
    confidence: p5 || s3 ? 0.6 : 0.3,
  };
}

function clamp01(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

function num(v: any, dflt: number): number {
  return typeof v === 'number' ? v : dflt;
}
function normalizeSkillCoeffs(v: any): Record<string, number> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v)) out[k] = typeof val === 'number' ? val : 0;
  return out;
}
