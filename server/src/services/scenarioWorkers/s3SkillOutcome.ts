// ================================================================
// S3 Skill Outcome Analyzer — per-(skill, scenario) impact assessment.
// Causal separation: "Skill capability wrong" vs "Prompt constraint
// wrong" (a correct-capability Skill under a too-restrictive Prompt is
// prompt_wrong, NOT a negative signal for that skill×scenario pair).
// ================================================================

import { callAgnes, parseWorkerJson } from './agnesCaller';
import { S3_SYSTEM } from './prompts';

export type S3Impact =
  | 'skill_helped' | 'skill_harmed' | 'skill_irrelevant' | 'skill_uncertain'
  | 'scenario_wrong' | 'prompt_wrong' | 'output_wrong' | 'requirement_changed'
  | 'mixed_cause';

export interface S3Input {
  skill_id: string;
  scenario_id: string;
  scenario_name: string;
  p5: Record<string, any>; // P5 output ("what happened")
  selected_atom_ids?: string[];
}

export interface S3Output {
  impact: S3Impact;
  skill_specific_signal: number;
  scenario_specific_signal: number;
  prompt_signal: number;
  confidence: number;
  compatibility_adjustment_direction: 'increase' | 'decrease' | 'unchanged' | 'uncertain';
  evidence: string[];
}

const IMPACTS: S3Impact[] = [
  'skill_helped', 'skill_harmed', 'skill_irrelevant', 'skill_uncertain',
  'scenario_wrong', 'prompt_wrong', 'output_wrong', 'requirement_changed', 'mixed_cause',
];

export async function runS3(input: S3Input): Promise<S3Output | null> {
  try {
    const raw = await callAgnes(S3_SYSTEM, JSON.stringify(input), {
      model: 'Agnes-3.0-flash',
      temperature: 0,
      maxTokens: 2048,
      timeoutMs: 15000,
    });
    const parsed = parseWorkerJson<S3Output>(raw, { impact: IMPACTS } as any);
    if (!parsed?.impact || !IMPACTS.includes(parsed.impact)) return null;
    return {
      impact: parsed.impact,
      skill_specific_signal: num(parsed.skill_specific_signal, 0.5),
      scenario_specific_signal: num(parsed.scenario_specific_signal, 0.5),
      prompt_signal: num(parsed.prompt_signal, 0),
      confidence: num(parsed.confidence, 0.5),
      compatibility_adjustment_direction: (
        ['increase', 'decrease', 'unchanged', 'uncertain'].includes(parsed.compatibility_adjustment_direction)
          ? parsed.compatibility_adjustment_direction
          : 'uncertain'
      ),
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String) : [],
    };
  } catch (err: any) {
    console.warn(`[S3] failed: ${err?.message}`);
    return null;
  }
}

function num(v: any, dflt: number): number {
  return typeof v === 'number' ? v : dflt;
}
