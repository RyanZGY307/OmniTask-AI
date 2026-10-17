// ================================================================
// P4 Prompt Generator — generates an experimental Atom version for a
// new scenario with no suitable existing Prompt (R5.5/R6). Output is a
// 15-field draft; the rule layer persists it as draft + experimental
// version + compat placeholder row. P4 NEVER publishes a formal version
// and never touches Core Identity / Safety / Privacy / Truth Standard.
// ================================================================

import { callAgnes, parseWorkerJson } from './agnesCaller';
import { P4_SYSTEM } from './prompts';

export interface P4Input {
  scenario_id: string;
  scenario_tags?: string[];
  user_message: string;
  p1: Record<string, any>;
  p5?: Record<string, any>;
}

export interface P4Output {
  asset_type: string;
  purpose: string;
  scenario_id: string;
  scenario_tags: string[];
  parent_scenario: string | null;
  applicable_conditions: string[];
  required_behavior: string[];
  constraints: string[];
  output_expectation: string;
  tool_expectation: string;
  knowledge_expectation: string;
  verification_expectation: string;
  conflict_notes: string;
  inheritance_source: string | null;
  version_reason: string;
  experiment_hypothesis: string;
}

export async function runP4(input: P4Input): Promise<P4Output | null> {
  try {
    const raw = await callAgnes(P4_SYSTEM, JSON.stringify(input), {
      model: 'Agnes-3.0-flash',
      temperature: 0.3,
      maxTokens: 4096,
      timeoutMs: 20000,
    });
    const parsed = parseWorkerJson<P4Output>(raw);
    if (!parsed?.purpose || !parsed.scenario_id) return null;
    return {
      asset_type: String(parsed.asset_type ?? 'prompt'),
      purpose: String(parsed.purpose),
      scenario_id: String(parsed.scenario_id),
      scenario_tags: Array.isArray(parsed.scenario_tags) ? parsed.scenario_tags.map(String) : (input.scenario_tags ?? []),
      parent_scenario: parsed.parent_scenario ?? null,
      applicable_conditions: Array.isArray(parsed.applicable_conditions) ? parsed.applicable_conditions.map(String) : [],
      required_behavior: Array.isArray(parsed.required_behavior) ? parsed.required_behavior.map(String) : [],
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints.map(String) : [],
      output_expectation: String(parsed.output_expectation ?? ''),
      tool_expectation: String(parsed.tool_expectation ?? ''),
      knowledge_expectation: String(parsed.knowledge_expectation ?? ''),
      verification_expectation: String(parsed.verification_expectation ?? ''),
      conflict_notes: String(parsed.conflict_notes ?? ''),
      inheritance_source: parsed.inheritance_source ?? null,
      version_reason: String(parsed.version_reason ?? ''),
      experiment_hypothesis: String(parsed.experiment_hypothesis ?? ''),
    };
  } catch (err: any) {
    // R6: P4 failure is treated as no_suitable_prompt; caller falls back to
    // inherited candidates only. One retry is allowed by the runtime.
    console.warn(`[P4] failed (will be treated as no_suitable_prompt): ${err?.message}`);
    return null;
  }
}
