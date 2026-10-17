// ================================================================
// Model Limits — auto-discovery of max output tokens per model.
//
// Runs at INITIALIZATION ONLY (boot + 30-day refresh + new model /
// version change). NEVER at request time. Request path reads the
// cached ModelLimit row (getVerifiedOutputLimit) with no discovery.
//
// Discovery priority (strict, no blogs / forums / third-party tables):
//   1. provider_api   — official model-metadata API
//   2. official_sdk   — provider SDK metadata
//   3. official_docs  — provider official docs
//   4. unknown        — no inflation applied (宁少不多)
//
// Every limit update appends to ModelLimitHistory (never overwritten)
// so Model Evolution can trace capability drift.
// ================================================================

import { prismaUser } from '../db';
import { getApiKey } from '../apiKeyPool';
import { getDynamicModels, type ModelRegistryEntry } from '../configSync';

export interface ModelLimits {
  modelId: string;
  version?: string;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
  contextWindow: number | null;
  source: 'provider_api' | 'official_sdk' | 'official_docs' | 'unknown';
  sourceUrl?: string;
  verifiedAt: string; // ISO timestamp
  status: 'verified' | 'stale' | 'unknown';
}

interface PartialLimits {
  inputTokenLimit?: number | null;
  outputTokenLimit?: number | null;
  contextWindow?: number | null;
  sourceUrl?: string;
}

const STALE_MS = 30 * 24 * 60 * 60 * 1000;

function baseLimits(modelId: string): Omit<ModelLimits, 'source' | 'status' | 'verifiedAt'> {
  return {
    modelId,
    inputTokenLimit: null,
    outputTokenLimit: null,
    contextWindow: null,
  };
}

// ---------------- Priority 1: Provider official metadata API ----------------
async function fetchFromProviderAPI(modelId: string, provider: string): Promise<PartialLimits | null> {
  // Provider metadata endpoints are provider-specific. For OpenAI/DeepSeek/
  // Gemini-family the official model-metadata listing exposes per-model
  // limits. We only call it when an API key for the provider is available
  // (no anonymous scraping of third-party tables).
  const key = getApiKey(provider);
  if (!key) return null;
  const baseUrls: Record<string, string> = {
    openai: 'https://api.openai.com/v1/models',
    deepseek: 'https://api.deepseek.com/models',
  };
  const base = baseUrls[provider];
  if (!base) return null;
  try {
    const res = await fetch(base, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const hit = (data.data ?? data.models ?? []).find(
      (m: any) => m.id === modelId || m.apiModel === modelId,
    );
    if (!hit) return null;
    return {
      outputTokenLimit: hit.max_completion_tokens ?? hit.maxTokens ?? hit.outputTokenLimit ?? null,
      contextWindow: hit.context_window ?? hit.contextWindow ?? hit.maxContextTokens ?? null,
      inputTokenLimit: hit.inputTokenLimit ?? null,
      sourceUrl: `${base}/${modelId}`,
    };
  } catch {
    return null;
  }
}

// ---------------- Priority 2: Provider official SDK ----------------
// Today the SDK path is a thin wrapper over the same authoritative
// metadata (SDK-published limits). Kept as a distinct source tag so a
// future SDK that ships its own limit tables can slot in without
// touching the caller.
async function fetchFromSDK(modelId: string, provider: string): Promise<PartialLimits | null> {
  // No SDK-published limit tables are wired in this deployment; the
  // provider API is the authoritative source. Return null to fall
  // through to the next priority rather than fabricate a limit.
  void modelId;
  void provider;
  return null;
}

// ---------------- Priority 3: Provider official docs ----------------
// Parsing live docs is intentionally NOT automated (fragile, and the
// spec forbids third-party model tables). This hook is reserved for a
// manually-maintained official-docs snapshot keyed by provider.
async function fetchFromOfficialDocs(modelId: string, provider: string): Promise<PartialLimits | null> {
  void modelId;
  void provider;
  return null;
}

export async function discoverModelLimits(
  modelId: string,
  provider: string,
): Promise<ModelLimits> {
  const base = baseLimits(modelId);
  const nowIso = new Date().toISOString();

  // 1) Provider API
  try {
    const limits = await fetchFromProviderAPI(modelId, provider);
    if (limits && (limits.outputTokenLimit || limits.contextWindow)) {
      return {
        ...base,
        inputTokenLimit: limits.inputTokenLimit ?? null,
        outputTokenLimit: limits.outputTokenLimit ?? null,
        contextWindow: limits.contextWindow ?? null,
        sourceUrl: limits.sourceUrl,
        source: 'provider_api',
        status: 'verified',
        verifiedAt: nowIso,
      };
    }
  } catch { /* fall through */ }

  // 2) Official SDK
  try {
    const limits = await fetchFromSDK(modelId, provider);
    if (limits && (limits.outputTokenLimit || limits.contextWindow)) {
      return {
        ...base,
        inputTokenLimit: limits.inputTokenLimit ?? null,
        outputTokenLimit: limits.outputTokenLimit ?? null,
        contextWindow: limits.contextWindow ?? null,
        sourceUrl: limits.sourceUrl,
        source: 'official_sdk',
        status: 'verified',
        verifiedAt: nowIso,
      };
    }
  } catch { /* fall through */ }

  // 3) Official docs
  try {
    const limits = await fetchFromOfficialDocs(modelId, provider);
    if (limits && (limits.outputTokenLimit || limits.contextWindow)) {
      return {
        ...base,
        inputTokenLimit: limits.inputTokenLimit ?? null,
        outputTokenLimit: limits.outputTokenLimit ?? null,
        contextWindow: limits.contextWindow ?? null,
        sourceUrl: limits.sourceUrl,
        source: 'official_docs',
        status: 'verified',
        verifiedAt: nowIso,
      };
    }
  } catch { /* fall through */ }

  // 4) Unknown — no inflation. The model registry's static maxTokens is
  //    a reasonable fallback for the OUTPUT limit when the model is
  //    known to the system; it is tagged 'unknown' so the caller treats
  //    it conservatively.
  const model = getDynamicModels()[modelId];
  const fallbackOutput = (model as ModelRegistryEntry | undefined)?.maxTokens ?? null;
  return {
    ...base,
    outputTokenLimit: fallbackOutput,
    contextWindow: (model as ModelRegistryEntry | undefined)?.contextWindow ?? null,
    source: 'unknown',
    status: 'unknown',
    verifiedAt: nowIso,
  };
}

// ---------------- Staleness ----------------
export function isStale(limit: { verifiedAt: Date | string }): boolean {
  const ts = limit.verifiedAt instanceof Date ? limit.verifiedAt.getTime() : new Date(limit.verifiedAt).getTime();
  return Date.now() - ts > STALE_MS;
}

// ---------------- Persist with history ----------------
export async function saveModelLimit(modelId: string, limits: ModelLimits): Promise<void> {
  const existing = await prismaUser.modelLimit.findUnique({ where: { modelId } });
  if (existing && existing.outputTokenLimit) {
    await prismaUser.modelLimitHistory.create({
      data: {
        modelId,
        version: existing.version,
        outputTokenLimit: existing.outputTokenLimit,
        source: existing.source,
        verifiedAt: existing.verifiedAt,
      },
    });
  }

  await prismaUser.modelLimit.upsert({
    where: { modelId },
    update: {
      version: limits.version ?? null,
      inputTokenLimit: limits.inputTokenLimit,
      outputTokenLimit: limits.outputTokenLimit,
      contextWindow: limits.contextWindow,
      source: limits.source,
      sourceUrl: limits.sourceUrl ?? null,
      verifiedAt: new Date(limits.verifiedAt),
      status: limits.status,
    },
    create: {
      modelId,
      version: limits.version ?? null,
      inputTokenLimit: limits.inputTokenLimit,
      outputTokenLimit: limits.outputTokenLimit,
      contextWindow: limits.contextWindow,
      source: limits.source,
      sourceUrl: limits.sourceUrl ?? null,
      verifiedAt: new Date(limits.verifiedAt),
      status: limits.status,
    },
  });
}

// ---------------- Init / refresh ----------------
export async function initializeModelLimits(): Promise<void> {
  const models = getDynamicModels();
  const entries = Object.entries(models);
  console.log(`[ModelLimits] Checking ${entries.length} models...`);

  for (const [key, info] of entries) {
    const existing = await prismaUser.modelLimit.findUnique({ where: { modelId: key } });

    const needsDiscovery =
      !existing ||
      existing.status === 'unknown' ||
      isStale(existing) ||
      existing.version !== info.apiModel;

    if (needsDiscovery) {
      const limits = await discoverModelLimits(info.apiModel, info.provider);
      limits.version = info.apiModel;
      await saveModelLimit(key, limits);
      console.log(`[ModelLimits] ${key} -> ${limits.source} (out=${limits.outputTokenLimit})`);
    }
  }
}

// ---------------- Request-path read (cache only, no discovery) ----------------
export async function getVerifiedOutputLimit(modelKey: string): Promise<number | null> {
  const limit = await prismaUser.modelLimit.findUnique({ where: { modelId: modelKey } });
  if (!limit || limit.status === 'unknown') return null;
  return limit.outputTokenLimit; // null => caller does not inflate
}

export interface ModelLimitRow {
  modelId: string;
  version: string | null;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
  contextWindow: number | null;
  source: string;
  sourceUrl: string | null;
  verifiedAt: Date | null;
  status: string;
}

export async function getModelLimitRow(modelKey: string): Promise<ModelLimitRow | null> {
  const row = await prismaUser.modelLimit.findUnique({ where: { modelId: modelKey } });
  if (!row) return null;
  return {
    modelId: row.modelId,
    version: row.version,
    inputTokenLimit: row.inputTokenLimit,
    outputTokenLimit: row.outputTokenLimit,
    contextWindow: row.contextWindow,
    source: row.source,
    sourceUrl: row.sourceUrl,
    verifiedAt: row.verifiedAt,
    status: row.status,
  };
}

// Headroom = how far the verified output limit sits above a given actual
// output count. Used by the admin panel to show billing margin.
export function headroom(limit: number | null, actualOutput: number): number | null {
  if (limit === null) return null;
  return Math.max(0, limit - actualOutput);
}
