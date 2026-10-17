// ================================================================
// S1 Skill Semantic Understanding — runs after an admin uploads/updates
// a Skill (async). Extracts nine semantic metadata fields from the Skill
// CONTENT (not the name). The rule layer writes these to Skill metadata
// columns + SkillScenarioLink rows. S1 never writes Skill.prompt and
// never publishes a formal Skill.
// ================================================================

import { callAgnes, parseWorkerJson } from './agnesCaller';
import { S1_SYSTEM } from './prompts';

export interface S1Output {
  purpose: string;
  capabilities: string[];
  constraints: string[];
  applicable_domains: string[];
  applicable_task_types: string[];
  scenario_tags: string[];
  scenario_features: string[];
  negative_applicability: string[];
  required_conditions: string[];
  optional_conditions: string[];
}

export async function runS1(skill: { name: string; description?: string; prompt: string }): Promise<S1Output | null> {
  try {
    const raw = await callAgnes(
      S1_SYSTEM,
      JSON.stringify({ name: skill.name, description: skill.description ?? '', prompt: skill.prompt.slice(0, 8000) }),
      { model: 'Agnes-2.5-flash', temperature: 0, maxTokens: 2048, timeoutMs: 20000 },
    );
    const parsed = parseWorkerJson<S1Output>(raw);
    if (!parsed) return null;
    const arr = (v: any): string[] => (Array.isArray(v) ? v.map(String) : []);
    return {
      purpose: String(parsed.purpose ?? ''),
      capabilities: arr(parsed.capabilities),
      constraints: arr(parsed.constraints),
      applicable_domains: arr(parsed.applicable_domains),
      applicable_task_types: arr(parsed.applicable_task_types),
      scenario_tags: arr(parsed.scenario_tags),
      scenario_features: arr(parsed.scenario_features),
      negative_applicability: arr(parsed.negative_applicability),
      required_conditions: arr(parsed.required_conditions),
      optional_conditions: arr(parsed.optional_conditions),
    };
  } catch (err: any) {
    console.warn(`[S1] failed: ${err?.message}`);
    return null;
  }
}
