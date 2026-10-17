// ================================================================
// Agnes Caller — shared model-invocation layer for the 10 Worker set.
// Generalized from evolution.ts callAgnesForEvolution: pool-based key
// selection + 429/5xx retry + per-call timeout. Every Worker routes
// through this so no Worker talks to a provider directly.
// ================================================================

import { getApiKey, reportKeySuccess, reportKeyFailure, getKeyPoolSize } from '../apiKeyPool';
import { PROVIDER_BASE_URLS } from '../../config';

export interface AgnesCallOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export async function callAgnes(systemPrompt: string, userPrompt: string, opts: AgnesCallOptions = {}): Promise<string> {
  const model = String(opts.model ?? 'agnes-3.0-flash').toLowerCase(); // Agnes gateway model ids are lowercase
  const temperature = opts.temperature ?? 0;
  const maxTokens = opts.maxTokens ?? 4096;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const baseUrl = PROVIDER_BASE_URLS.agnes;
  const poolSize = getKeyPoolSize('agnes');

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < Math.max(poolSize, 1); attempt++) {
    const apiKey = getApiKey('agnes');
    if (!apiKey) throw new Error('No Agnes API key available');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: maxTokens,
          temperature,
        }),
      });

      if (res.ok) {
        clearTimeout(timer);
        reportKeySuccess('agnes', apiKey, Date.now() - start);
        const data = (await res.json()) as any;
        return data.choices?.[0]?.message?.content?.trim() || '';
      }

      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        reportKeyFailure('agnes', apiKey, `HTTP ${res.status}`);
        lastErr = new Error(`Agnes ${res.status}`);
        continue;
      }
      throw new Error(`Agnes error: ${res.status}`);
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') {
        reportKeyFailure('agnes', apiKey, `timeout ${timeoutMs}ms`);
        lastErr = new Error(`Agnes call timed out after ${timeoutMs}ms`);
        if (attempt === Math.max(poolSize, 1) - 1) throw lastErr;
        continue;
      }
      reportKeyFailure('agnes', apiKey, err.message);
      lastErr = err;
      if (attempt === Math.max(poolSize, 1) - 1) throw err;
    }
  }
  throw lastErr ?? new Error('All Agnes keys exhausted');
}

// Parse a Worker JSON response. Worker prompts are contractually "JSON only,
// no markdown". This helper strips an optional code fence and validates the
// result against an enum whitelist where provided; a parse failure yields
// null so the caller can apply its degradation path (R14).
export function parseWorkerJson<T = any>(raw: string, allowedEnum?: Record<string, string[]>): T | null {
  let text = (raw || '').trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: any;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (allowedEnum) {
    for (const [field, allowed] of Object.entries(allowedEnum)) {
      const val = obj[field];
      if (val !== undefined && !allowed.includes(val)) {
        // Illegal enum value -> treat as degraded (null) rather than a crash.
        return null;
      }
    }
  }
  return obj as T;
}
