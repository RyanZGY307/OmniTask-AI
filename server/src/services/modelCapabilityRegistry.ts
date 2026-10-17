// ================================================================
// Model Capability Registry — per-model parameter support
// ================================================================

import { prismaUser } from './db';

export interface ModelCapability {
  modelKey: string;
  supportsTemperature: boolean;
  minTemperature: number;
  maxTemperature: number;
  supportsTopP: boolean;
  minTopP: number;
  maxTopP: number;
  supportsReasoning: boolean;
  supportsFrequencyPenalty: boolean;
  supportsPresencePenalty: boolean;
  supportsStructuredOutput: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsJSONMode: boolean;
  supportsN: boolean;
  supportsLogprobs: boolean;
  maxOutputTokens: number;
  maxContextTokens: number;
  metadata?: any;
}

const DEFAULT_CAPABILITY: ModelCapability = {
  modelKey: '',
  supportsTemperature: true,
  minTemperature: 0,
  maxTemperature: 2,
  supportsTopP: true,
  minTopP: 0,
  maxTopP: 1,
  supportsReasoning: false,
  supportsFrequencyPenalty: false,
  supportsPresencePenalty: false,
  supportsStructuredOutput: false,
  supportsTools: false,
  supportsVision: false,
  supportsStreaming: true,
  supportsJSONMode: false,
  supportsN: false,
  supportsLogprobs: false,
  maxOutputTokens: 8192,
  maxContextTokens: 32768,
};

export async function getModelCapability(modelKey: string): Promise<ModelCapability> {
  try {
    const cap = await prismaUser.modelCapability.findUnique({ where: { modelKey } });
    if (!cap) return { ...DEFAULT_CAPABILITY, modelKey };
    return {
      modelKey,
      supportsTemperature: cap.supportsTemperature,
      minTemperature: cap.minTemperature,
      maxTemperature: cap.maxTemperature,
      supportsTopP: cap.supportsTopP,
      minTopP: cap.minTopP,
      maxTopP: cap.maxTopP,
      supportsReasoning: cap.supportsReasoning,
      supportsFrequencyPenalty: cap.supportsFrequencyPenalty,
      supportsPresencePenalty: cap.supportsPresencePenalty,
      supportsStructuredOutput: cap.supportsStructuredOutput,
      supportsTools: cap.supportsTools,
      supportsVision: cap.supportsVision,
      supportsStreaming: cap.supportsStreaming,
      supportsJSONMode: cap.supportsJSONMode,
      supportsN: cap.supportsN,
      supportsLogprobs: cap.supportsLogprobs,
      maxOutputTokens: cap.maxOutputTokens,
      maxContextTokens: cap.maxContextTokens,
    };
  } catch {
    return { ...DEFAULT_CAPABILITY, modelKey };
  }
}

export async function upsertModelCapability(input: Partial<ModelCapability> & { modelKey: string }): Promise<void> {
  const data = {
    supportsTemperature: input.supportsTemperature ?? true,
    minTemperature: input.minTemperature ?? 0,
    maxTemperature: input.maxTemperature ?? 2,
    supportsTopP: input.supportsTopP ?? true,
    minTopP: input.minTopP ?? 0,
    maxTopP: input.maxTopP ?? 1,
    supportsReasoning: input.supportsReasoning ?? false,
    supportsFrequencyPenalty: input.supportsFrequencyPenalty ?? false,
    supportsPresencePenalty: input.supportsPresencePenalty ?? false,
    supportsStructuredOutput: input.supportsStructuredOutput ?? false,
    supportsTools: input.supportsTools ?? false,
    supportsVision: input.supportsVision ?? false,
    supportsStreaming: input.supportsStreaming ?? true,
    supportsJSONMode: input.supportsJSONMode ?? false,
    supportsN: input.supportsN ?? false,
    supportsLogprobs: input.supportsLogprobs ?? false,
    maxOutputTokens: input.maxOutputTokens ?? 8192,
    maxContextTokens: input.maxContextTokens ?? 32768,
    metadata: input.metadata,
  };
  await prismaUser.modelCapability.upsert({
    where: { modelKey: input.modelKey },
    create: { modelKey: input.modelKey, ...data },
    update: data,
  });
}

export function clampTemperature(temp: number, cap: ModelCapability): number {
  if (!cap.supportsTemperature) return 0;
  return Math.max(cap.minTemperature, Math.min(cap.maxTemperature, temp));
}

export function clampTopP(topP: number, cap: ModelCapability): number {
  if (!cap.supportsTopP) return 1;
  return Math.max(cap.minTopP, Math.min(cap.maxTopP, topP));
}

export function filterUnsupportedParams<T extends Record<string, any>>(params: T, cap: ModelCapability): T {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (key === 'temperature' && !cap.supportsTemperature) continue;
    if (key === 'top_p' && !cap.supportsTopP) continue;
    if (key === 'frequency_penalty' && !cap.supportsFrequencyPenalty) continue;
    if (key === 'presence_penalty' && !cap.supportsPresencePenalty) continue;
    if (key === 'response_format' && !cap.supportsStructuredOutput && !cap.supportsJSONMode) continue;
    if (key === 'tools' && !cap.supportsTools) continue;
    if (key === 'n' && !cap.supportsN) continue;
    if (key === 'logprobs' && !cap.supportsLogprobs) continue;
    result[key] = value;
  }
  return result as T;
}
