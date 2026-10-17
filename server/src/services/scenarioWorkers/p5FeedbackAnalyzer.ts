// ================================================================
// P5 Feedback Analyzer — "what happened" from user follow-up. 11-field
// output, no attribution coefficients (that's E1's job).
// ================================================================

import { callAgnes, parseWorkerJson } from './agnesCaller';
import { P5_SYSTEM } from './prompts';

export interface P5Input {
  original_user_message: string;
  follow_up_message: string;
  original_outcome_hint?: string;
  selected_skill_ids?: string[];
}

export type P5Outcome =
  | 'solved' | 'partially_solved' | 'unsolved' | 'worsened'
  | 'abandoned' | 'not_attempted' | 'clarified' | 'escalated' | 'unknown';

export interface P5Output {
  outcome: P5Outcome;
  positive_signals: string[];
  negative_signals: string[];
  corrections: string[];
  accepted_parts: string[];
  rejected_parts: string[];
  new_requirements: string[];
  scenario_change_signal: number;
  prompt_change_signal: number;
  skill_change_signal: number;
  confidence: number;
}

const OUTCOMES: P5Outcome[] = [
  'solved', 'partially_solved', 'unsolved', 'worsened',
  'abandoned', 'not_attempted', 'clarified', 'escalated', 'unknown',
];

export async function runP5(input: P5Input): Promise<P5Output | null> {
  try {
    const raw = await callAgnes(P5_SYSTEM, JSON.stringify(input), {
      model: 'Agnes-2.5-flash',
      temperature: 0,
      maxTokens: 2048,
      timeoutMs: 10000,
    });
    const parsed = parseWorkerJson<P5Output>(raw, { outcome: OUTCOMES } as any);
    if (!parsed?.outcome || !OUTCOMES.includes(parsed.outcome)) return null;
    return {
      outcome: parsed.outcome,
      positive_signals: strArr(parsed.positive_signals),
      negative_signals: strArr(parsed.negative_signals),
      corrections: strArr(parsed.corrections),
      accepted_parts: strArr(parsed.accepted_parts),
      rejected_parts: strArr(parsed.rejected_parts),
      new_requirements: strArr(parsed.new_requirements),
      scenario_change_signal: num(parsed.scenario_change_signal, 0),
      prompt_change_signal: num(parsed.prompt_change_signal, 0),
      skill_change_signal: num(parsed.skill_change_signal, 0),
      confidence: num(parsed.confidence, 0.5),
    };
  } catch (err: any) {
    console.warn(`[P5] failed: ${err?.message}`);
    return null;
  }
}

function strArr(v: any): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}
function num(v: any, dflt: number): number {
  return typeof v === 'number' ? v : dflt;
}
