// ================================================================
// Model Quota Registry — LLM rate limits from DB, not hardcoded
// ================================================================

import { prismaUser } from './db';

export interface ModelQuotaConfig {
  rpmLimit?: number;
  tpmLimit?: number;
  dailyLimit?: number;
  maxConcurrency: number;
  requestTimeout: number;
}

export interface ModelQuotaInput {
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  dailyLimit?: number | null;
  maxConcurrency?: number;
  requestTimeout?: number;
  tokenBudget?: number | null;
  source?: string;
}

const DEFAULTS: Pick<ModelQuotaConfig, 'maxConcurrency' | 'requestTimeout'> = {
  maxConcurrency: 5,
  requestTimeout: 60,
};

const MINUTE_MS = 60 * 1000;

interface UsageWindow {
  requests: number[];
  tokens: number;
  windowStart: number;
  dayDate: string;
  dayTokens: number;
}

const windows = new Map<string, UsageWindow>();

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function ensureWindow(modelKey: string, now: number): UsageWindow {
  let w = windows.get(modelKey);
  if (!w) {
    w = { requests: [], tokens: 0, windowStart: now, dayDate: dayKey(now), dayTokens: 0 };
    windows.set(modelKey, w);
  }
  if (now - w.windowStart >= MINUTE_MS) {
    w.requests = [];
    w.tokens = 0;
    w.windowStart = now;
  }
  if (w.dayDate !== dayKey(now)) {
    w.dayDate = dayKey(now);
    w.dayTokens = 0;
  }
  return w;
}

function normalizeValue(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

export async function getQuota(modelKey: string): Promise<ModelQuotaConfig> {
  try {
    const row = await prismaUser.modelQuota.findUnique({ where: { modelKey } });
    return {
      rpmLimit: normalizeValue(row?.rpmLimit),
      tpmLimit: normalizeValue(row?.tpmLimit),
      dailyLimit: normalizeValue(row?.dailyLimit),
      maxConcurrency: row?.maxConcurrency ?? DEFAULTS.maxConcurrency,
      requestTimeout: row?.requestTimeout ?? DEFAULTS.requestTimeout,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function upsertQuota(modelKey: string, data: ModelQuotaInput): Promise<void> {
  const normalized: ModelQuotaInput = {
    rpmLimit: normalizeValue(data.rpmLimit) ?? null,
    tpmLimit: normalizeValue(data.tpmLimit) ?? null,
    dailyLimit: normalizeValue(data.dailyLimit) ?? null,
    tokenBudget: normalizeValue(data.tokenBudget) ?? null,
    maxConcurrency: data.maxConcurrency ?? DEFAULTS.maxConcurrency,
    requestTimeout: data.requestTimeout ?? DEFAULTS.requestTimeout,
    source: data.source ?? 'default',
  };

  await prismaUser.modelQuota.upsert({
    where: { modelKey },
    update: normalized,
    create: {
      modelKey,
      rpmLimit: normalized.rpmLimit,
      tpmLimit: normalized.tpmLimit,
      dailyLimit: normalized.dailyLimit,
      tokenBudget: normalized.tokenBudget,
      maxConcurrency: normalized.maxConcurrency,
      requestTimeout: normalized.requestTimeout,
      source: normalized.source ?? 'default',
    },
  });
}

export async function canExecute(
  modelKey: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const quota = await getQuota(modelKey);
  const now = Date.now();
  const w = ensureWindow(modelKey, now);

  if (quota.rpmLimit !== undefined) {
    w.requests = w.requests.filter((ts) => now - ts < MINUTE_MS);
    if (w.requests.length >= quota.rpmLimit) {
      return { allowed: false, reason: `rpm limit ${quota.rpmLimit} reached` };
    }
  }

  if (quota.tpmLimit !== undefined && w.tokens >= quota.tpmLimit) {
    return { allowed: false, reason: `tpm limit ${quota.tpmLimit} reached` };
  }

  if (quota.dailyLimit !== undefined && w.dayTokens >= quota.dailyLimit) {
    return { allowed: false, reason: `daily limit ${quota.dailyLimit} reached` };
  }

  return { allowed: true };
}

export async function recordUsage(modelKey: string, tokens: number): Promise<void> {
  const now = Date.now();
  const w = ensureWindow(modelKey, now);
  w.requests.push(now);
  w.requests = w.requests.filter((ts) => now - ts < MINUTE_MS);
  const safeTokens = typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : 0;
  w.tokens += safeTokens;
  w.dayTokens += safeTokens;
}
