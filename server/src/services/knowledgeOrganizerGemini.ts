// ================================================================
// Knowledge Organizer — Subsystem LLM helper (Agnes-backed).
// All provider calls route through the shared backend key pool
// (apiKeyPool / callAgnes). Subsystem reasoning only ever uses
// Agnes 2.5 / 3.0-flash (migrated off Gemini).
// ================================================================

import { callAgnes } from './scenarioWorkers/agnesCaller';
import { getKeyPoolSize } from './apiKeyPool';

const AGNES_MODEL = 'agnes-3.0-flash';

export function isAgnesAvailable(): boolean {
  return getKeyPoolSize('agnes') > 0;
}

export interface AgnesTextOptions {
  temperature?: number;
  maxTokens?: number;
}

export async function callAgnesForText(prompt: string, opts: AgnesTextOptions = {}): Promise<string> {
  // Single-prompt call (passed as the user message) through the shared Agnes pool.
  return callAgnes('', prompt, {
    model: AGNES_MODEL,
    temperature: opts.temperature ?? 0.1,
    maxTokens: opts.maxTokens ?? 4096,
    timeoutMs: 60_000,
  });
}
