// ================================================================
// Model Request Builder — auto-injects final_system_prompt + dynamic params
// Uses Model Capability Registry to clamp/drop unsupported parameters
// ================================================================

import { getDynamicModels } from './configSync';
import { getModelCapability, clampTemperature, clampTopP, filterUnsupportedParams } from './modelCapabilityRegistry';

export interface ModelRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  frequency_penalty?: number;
  presence_penalty?: number;
  response_format?: any;
  tools?: any[];
  n?: number;
  logprobs?: boolean;
  _capability_dropped?: string[];
}

export async function buildModelRequest(
  finalSystemPrompt: string,
  userMessage: string,
  modelKey: string,
  opts?: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    stream?: boolean;
    frequencyPenalty?: number;
    presencePenalty?: number;
    responseFormat?: any;
    tools?: any[];
    n?: number;
    logprobs?: boolean;
  },
): Promise<ModelRequest> {
  const model = getDynamicModels()[modelKey];
  if (!model) throw new Error(`Unknown model: ${modelKey}`);

  const cap = await getModelCapability(modelKey);

  // Build raw params
  const rawParams: Record<string, any> = {
    temperature: opts?.temperature ?? 0.7,
    top_p: opts?.topP ?? 0.9,
    max_tokens: opts?.maxTokens ?? model.maxTokens,
    stream: opts?.stream ?? true,
    frequency_penalty: opts?.frequencyPenalty,
    presence_penalty: opts?.presencePenalty,
    response_format: opts?.responseFormat,
    tools: opts?.tools,
    n: opts?.n,
    logprobs: opts?.logprobs,
  };

  // Clamp temperature
  const clampedTemp = clampTemperature(rawParams.temperature, cap);
  rawParams.temperature = clampedTemp;

  // Clamp top_p
  if (rawParams.top_p !== undefined) {
    rawParams.top_p = clampTopP(rawParams.top_p, cap);
  }

  // Clamp max_tokens
  if (rawParams.max_tokens > cap.maxOutputTokens) {
    rawParams.max_tokens = cap.maxOutputTokens;
  }

  // Filter unsupported params
  const filtered = filterUnsupportedParams(rawParams, cap);

  const droppedKeys = Object.keys(rawParams).filter(
    k => rawParams[k] !== undefined && rawParams[k] !== null && filtered[k] === undefined
  );

  return {
    model: modelKey,
    messages: [
      { role: 'system', content: finalSystemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: filtered.temperature ?? 0.7,
    top_p: filtered.top_p,
    max_tokens: filtered.max_tokens,
    stream: filtered.stream,
    frequency_penalty: filtered.frequency_penalty,
    presence_penalty: filtered.presence_penalty,
    response_format: filtered.response_format,
    tools: filtered.tools,
    n: filtered.n,
    logprobs: filtered.logprobs,
    _capability_dropped: droppedKeys.length > 0 ? droppedKeys : undefined,
  };
}
