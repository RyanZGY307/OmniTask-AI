// ================================================================
// P1 Scenario Analyzer — "specifically which scene is this happening in".
// Runs in true parallel with W0 (R1): input never contains this request's
// W0 live output, only an optional cached_intent. Degrades to rule
// signature when the call times out (8s) or JSON is malformed (R1.5).
// ================================================================

import { callAgnes, parseWorkerJson } from './agnesCaller';
import { P1_SYSTEM } from './prompts';

export interface P1Input {
  user_message: string;
  conversation_history?: Array<{ role: string; content: string }>;
  region?: string;
  language?: string;
  cached_intent?: Record<string, any>; // previous request's W0 result (optional)
  known_scenario_signatures?: string[]; // R1.2: lightweight retrieval hint
}

export interface ScenarioUnderstanding {
  scenario_signature: string;
  intent: string;
  domain: string;
  object: string;
  goal: string;
  constraints: string[];
  output: string;
  capability: string;
  knowledge: string;
  tool: string;
  risk: string;
  freshness: string;
  contextual_features: string[];
  new_scenario_candidate: { is_new: boolean; reason: string };
  confidence: number;
  degraded?: boolean;
}

export async function runP1(input: P1Input, timeoutMs = 8000): Promise<ScenarioUnderstanding> {
  try {
    const raw = await callAgnes(P1_SYSTEM, JSON.stringify(input), {
      model: 'Agnes-2.5-flash',
      temperature: 0,
      maxTokens: 2048,
      timeoutMs,
    });
    const parsed = parseWorkerJson(raw);
    if (!parsed?.scenario_signature) throw new Error('P1 missing scenario_signature');
    return {
      scenario_signature: String(parsed.scenario_signature),
      intent: String(parsed.intent ?? ''),
      domain: String(parsed.domain ?? ''),
      object: String(parsed.object ?? ''),
      goal: String(parsed.goal ?? ''),
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints.map(String) : [],
      output: String(parsed.output ?? ''),
      capability: String(parsed.capability ?? ''),
      knowledge: String(parsed.knowledge ?? ''),
      tool: String(parsed.tool ?? ''),
      risk: String(parsed.risk ?? ''),
      freshness: String(parsed.freshness ?? ''),
      contextual_features: Array.isArray(parsed.contextual_features) ? parsed.contextual_features.map(String) : [],
      new_scenario_candidate: {
        is_new: !!parsed.new_scenario_candidate?.is_new,
        reason: String(parsed.new_scenario_candidate?.reason ?? ''),
      },
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    };
  } catch (err: any) {
    // R1.5: degraded — caller falls back to rule signature from W0 domains/tasks.
    console.warn(`[P1] degraded: ${err?.message}`);
    return {
      scenario_signature: ruleSignature(input),
      intent: input.cached_intent?.intent ?? '',
      domain: input.cached_intent?.domain ?? input.region ?? 'general',
      object: '',
      goal: input.user_message.slice(0, 120),
      constraints: [],
      output: '',
      capability: '',
      knowledge: '',
      tool: '',
      risk: '',
      freshness: '',
      contextual_features: [],
      new_scenario_candidate: { is_new: false, reason: 'degraded' },
      confidence: 0.3,
      degraded: true,
    };
  }
}

// Rule-layer signature fallback: domains + tasks + object (zero model).
function ruleSignature(input: P1Input): string {
  const domain = input.cached_intent?.domain ?? input.region ?? 'general';
  const intent = input.cached_intent?.intent ?? 'task';
  return `${domain}:${intent}`.toLowerCase();
}
