// ================================================================
// Model Pool — runtime candidate-model discovery + Pool Versioning.
// R1: never hardcode model lists. Candidate pool is derived at runtime:
//   User -> Entitlement -> Model Registry (getDynamicModels) -> Capability/
//   Permission/Context/Health filtering -> actual candidate pool.
// R8: pool version hash tracks which model set + provider health + key pool
//     the initial M1/M2/M3 priors were built against.
// ================================================================

import { createHash } from 'crypto';
import { getDynamicModels, type ModelRegistryEntry } from '../configSync';
import { getHealthScore } from '../modelPerformanceStore';
import { getKeyPoolSize } from '../apiKeyPool';
import type { ModelRegistryEntry as FullEntry } from '../../config';

export interface PoolModel {
  key: string;
  version: string;       // apiModel
  status: string;        // online | offline | maintenance
  capabilities: string[];
  tier: string;
  provider: string;
  contextWindow: number;
  costPer1k: number;
  qualityProfile: number;
  speedProfile: number;
}

export interface PoolVersion {
  versionHash: string;
  models: PoolModel[];
  providerHealth: Record<string, number>;
  keyPool: Record<string, number>;
  snapshotAt: string;
}

// User-tier ordering. Tier "FREE" maps to the lowest rung (treated as
// STANDARD). "ULTRA" is retired and behaves as the PRO rung for legacy
// accounts.
const TIER_ORDER: Record<string, number> = { STANDARD: 0, FREE: 0, PRO: 1, ULTRA: 1 };

function tierIndex(t: string): number {
  return TIER_ORDER[t] ?? 0;
}

// Runtime candidate pool for a user: entitlement-filtered, active models only.
// This is the single source of truth for "what models can this user actually
// use right now" — no hardcoded membership->model map (R1).
export function getAvailableModels(user: { subscriptionTier?: string } | null): PoolModel[] {
  const userTier = user?.subscriptionTier ? tierIndex(user.subscriptionTier) : 0;
  const registry = getDynamicModels() as Record<string, FullEntry>;

  const pool: PoolModel[] = [];
  for (const [key, entry] of Object.entries(registry)) {
    // image/video are handled by a separate media pipeline, not the chat router
    if (entry.category === 'image' || entry.category === 'video') continue;
    // entitlement: model tier must not exceed the user's tier (R2)
    if (tierIndex(entry.tier) > userTier) continue;
    // availability: only enabled + online models are candidates
    if (!entry.enabled) continue;
    if (entry.status === 'offline') continue;

    pool.push({
      key,
      version: entry.apiModel,
      status: entry.status,
      capabilities: entry.capabilities,
      tier: entry.tier,
      provider: entry.provider,
      contextWindow: entry.contextWindow,
      costPer1k: entry.costPer1k,
      qualityProfile: entry.qualityProfile,
      speedProfile: entry.speedProfile,
    });
  }
  return pool;
}

// Deterministic pool-version hash: sorted model set + provider health bucket
// + key-pool availability (R8). Changes in any of these produce a new hash,
// which is what detects a "major pool change" that should re-trigger M1.
export function computePoolVersionHash(models: PoolModel[], providerHealth: Record<string, number>, keyPool: Record<string, number>): string {
  const sorted = [...models].sort((a, b) => a.key.localeCompare(b.key));
  const modelPart = sorted
    .map((m) => `${m.key}@${m.version}:${m.status}:${m.capabilities.slice().sort().join(',')}`)
    .join('|');

  // bucket provider health into coarse levels so transient jitter does not
  // churn the version; only "major" shifts (e.g. online<->degraded) matter.
  const healthPart = Object.keys(providerHealth)
    .sort()
    .map((p) => `${p}:${bucketHealth(providerHealth[p])}`)
    .join('|');

  const keyPart = Object.keys(keyPool)
    .sort()
    .map((p) => `${p}:${keyPool[p] > 0 ? 1 : 0}`)
    .join('|');

  return createHash('sha1').update(`${modelPart}::${healthPart}::${keyPart}`).digest('hex').slice(0, 16);
}

function bucketHealth(score: number): string {
  if (score >= 0.7) return 'good';
  if (score >= 0.3) return 'degraded';
  return 'down';
}

// Build a full pool version snapshot for the current user-visible pool.
export function buildPoolVersion(user: { subscriptionTier?: string } | null): PoolVersion {
  const models = getAvailableModels(user);
  const providerHealth: Record<string, number> = {};
  for (const m of models) {
    const health = getHealthScore(m.key);
    providerHealth[m.provider] = Math.min(providerHealth[m.provider] ?? 0.7, health);
  }
  const keyPool: Record<string, number> = {};
  for (const p of new Set(models.map((m) => m.provider))) {
    keyPool[p] = getKeyPoolSize(p);
  }
  return {
    versionHash: computePoolVersionHash(models, providerHealth, keyPool),
    models,
    providerHealth,
    keyPool,
    snapshotAt: new Date().toISOString(),
  };
}

// Diff two pool versions to find which models changed (added/removed/
// capability/version shift). Used for incremental M1 re-profiling (R8.4):
// only affected combinations are recomputed, never the whole matrix.
export function diffPoolVersions(
  prev: PoolVersion,
  next: PoolVersion,
): { added: string[]; removed: string[]; changed: string[] } {
  const prevKeys = new Set(prev.models.map((m) => m.key));
  const nextKeys = new Set(next.models.map((m) => m.key));
  const prevMap = new Map(prev.models.map((m) => [m.key, m]));
  const nextMap = new Map(next.models.map((m) => [m.key, m]));

  const added = [...nextKeys].filter((k) => !prevKeys.has(k));
  const removed = [...prevKeys].filter((k) => !nextKeys.has(k));
  const changed = [...nextKeys].filter((k) => {
    const a = prevMap.get(k);
    const b = nextMap.get(k);
    if (!a || !b) return false;
    const capA = a.capabilities.slice().sort().join(',');
    const capB = b.capabilities.slice().sort().join(',');
    return a.version !== b.version || a.status !== b.status || capA !== capB;
  });

  return { added, removed, changed };
}

// A "major change" that forces a new Pool Version + incremental M1 re-profile.
export function isMajorPoolChange(
  prev: PoolVersion | null,
  next: PoolVersion,
): boolean {
  if (!prev) return true; // first init
  if (prev.versionHash === next.versionHash) return false;
  const diff = diffPoolVersions(prev, next);
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}

// Detect which combinations need re-profiling after a pool change (R8.4).
// Added models -> all scenarios; changed models -> all scenarios;
// removed models -> their rows are deprecated (no re-profile).
// The caller expands modelId x scenarioRegistry into concrete tasks.
export function affectedModelKeysForPoolChange(
  prev: PoolVersion | null,
  next: PoolVersion,
): string[] {
  if (!prev) return []; // first-init is handled separately by full M1 fan-out
  const diff = diffPoolVersions(prev, next);
  return diff.added.concat(diff.changed);
}

export type { ModelRegistryEntry };
