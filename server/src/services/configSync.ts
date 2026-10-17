// ================================================================
// Dynamic Config — runtime-overridable models & pricing
// ================================================================
//
// Loads ModelConfig, CreditPack, SubscriptionPricing from DB
// and merges them with the hardcoded defaults in config.ts.
// Consumers should call the exported getters instead of importing
// the raw constants directly.
//
// Boot-time only: reads from DB once, caches in memory.
// Admin API writes to DB; a server restart re-reads everything.

import { prisma } from './db';
import { setModelRateLimit } from './rateGate';
import {
  MODEL_REGISTRY as HARDCODED_MODELS,
  CREDIT_PACKS as HARDCODED_PACKS,
  PRICING as HARDCED_PRICING,
  LEGACY_ULTRA_PRICING,
  SUBSCRIPTION_GRANTS as HARDCODED_GRANTS,
  type ModelRegistryEntry,
} from '../config';
import type { RateLimitBlock } from './rateLimiter';

export type { ModelRegistryEntry };

// provider → 厂商显示名。未命中时回退 provider 本身（首字母大写）。
export const PROVIDER_VENDOR: Record<string, string> = {
  openai: 'ChatGPT',
  anthropic: 'Claude',
  google: 'Gemini',
  deepseek: 'DeepSeek',
  xiaomi: 'Xiaomi MiMO',
  agnes: 'Agnes',
};
export function vendorFor(provider: string, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  return PROVIDER_VENDOR[provider] || (provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : provider);
}

// 去厂商前缀（openai/）与 :后缀（:batch）后的可读显示名；admin 手填 displayName 优先。
export function strippedDisplayName(apiModel: string, provider: string, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  let name = apiModel || '';
  // 去掉 “vendor/” 前缀（若前缀等于 provider 名，或任一已知厂商前缀）
  const slash = name.indexOf('/');
  if (slash > 0) name = name.slice(slash + 1);
  // 去掉 “:batch” / “:generateContent” 等后缀
  const colon = name.indexOf(':');
  if (colon > 0) name = name.slice(0, colon);
  return name;
}

// ==================== In-memory cache ====================

let _dynamicModels: Record<string, ModelRegistryEntry> | null = null;
let _dynamicPacks: { id: string; credits: number; price: number; currency: string }[] | null = null;
type LegacyUltraPricing = { monthly: number; yearly: number; creditGrant: number };
let _dynamicPricing: Record<string, { monthly: number; yearly: number; creditGrant: number }> | null = null;
let _legacyUltraPricing: LegacyUltraPricing = LEGACY_ULTRA_PRICING;

// ==================== Model Registry ====================

export async function loadModelConfigs(): Promise<Record<string, ModelRegistryEntry>> {
  if (_dynamicModels) return _dynamicModels;

  const dbModels = await prisma.modelConfig.findMany({
    where: { enabled: true, status: { not: 'disabled' } },
  });

  const merged: Record<string, ModelRegistryEntry> = { ...HARDCODED_MODELS };

  for (const db of dbModels) {
    const block: RateLimitBlock = db.rateLimit ? safeParseBlock(db.rateLimit) : {};
    setModelRateLimit(db.modelKey, block);
    merged[db.modelKey] = {
      provider: db.provider || 'custom',
      apiModel: db.apiModel,
      displayName: db.displayName || strippedDisplayName(db.apiModel, db.provider),
      vendor: vendorFor(db.provider, db.vendor),
      tier: (db.tier as any) || 'FREE',
      maxTokens: db.maxTokens,
      contextWindow: db.contextWindow,
      costPer1k: db.costPer1k,
      category: db.category || 'general',
      status: (db.status as 'online' | 'offline' | 'maintenance') || 'online',
      enabled: db.enabled,
      lastVerifiedAt: new Date().toISOString(),
      capabilities: JSON.parse(db.capabilities || '[]'),
      supportsReasoning: db.supportsReasoning,
      supportsTools: db.supportsTools,
      supportsVision: db.supportsVision,
      supportsStreaming: db.supportsStreaming,
      supportsStructuredOutput: db.supportsStructuredOutput,
      qualityProfile: db.qualityProfile,
      speedProfile: db.speedProfile,
      reliabilityProfile: db.reliabilityProfile,
    };
  }

  _dynamicModels = merged;
  return merged;
}

function safeParseBlock(raw: string): RateLimitBlock {
  try { const o = JSON.parse(raw); return o && typeof o === 'object' ? o as RateLimitBlock : {}; } catch { return {}; }
}

export function getDynamicModels(): Record<string, ModelRegistryEntry> {
  return _dynamicModels || HARDCODED_MODELS;
}

export async function refreshModelConfigs(): Promise<void> {
  _dynamicModels = null;
  await loadModelConfigs();
}

// ==================== Credit Packs ====================

export async function loadCreditPacks(): Promise<{ id: string; credits: number; price: number; currency: string }[]> {
  if (_dynamicPacks) return _dynamicPacks;

  const dbPacks = await prisma.creditPack.findMany({
    where: { isActive: true },
    orderBy: { credits: 'asc' },
  });

  // Merge: DB packs override hardcoded by id; keep hardcoded ones not in DB
  const merged = new Map<string, { id: string; credits: number; price: number; currency: string }>();
  for (const p of HARDCODED_PACKS) {
    merged.set(p.id, { id: p.id, credits: p.credits, price: p.price, currency: p.currency || 'USD' });
  }
  for (const p of dbPacks) {
    merged.set(p.id, { id: p.id, credits: p.credits, price: p.price, currency: p.currency || 'USD' });
  }

  _dynamicPacks = [...merged.values()];
  return _dynamicPacks;
}

export function getDynamicPacks(): { id: string; credits: number; price: number; currency: string }[] {
  return _dynamicPacks || HARDCODED_PACKS;
}

export async function refreshCreditPacks(): Promise<void> {
  _dynamicPacks = null;
  await loadCreditPacks();
}

// ==================== Subscription Pricing ====================

export async function loadSubscriptionPricing(): Promise<Record<string, { monthly: number; yearly: number; creditGrant: number }>> {
  if (_dynamicPricing) return _dynamicPricing;

  const dbRows = await prisma.subscriptionPricing.findMany();
  const rowsMap = new Map(dbRows.map(r => [r.tier, r]));

  // ULTRA is a retired tier: its row, if still active in DB, only feeds the
  // legacy price resolver (in-flight ultra_* orders). It is NOT part of
  // the sellable tier set.
  const ultraRow = rowsMap.get('ULTRA');
  if (ultraRow?.isActive) {
    _legacyUltraPricing = {
      monthly: ultraRow.monthlyUsd || LEGACY_ULTRA_PRICING.monthly,
      yearly: ultraRow.yearlyUsd || LEGACY_ULTRA_PRICING.yearly,
      creditGrant: ultraRow.creditGrant || HARDCODED_GRANTS.ULTRA,
    };
  }

  const merged = { ...HARDCED_PRICING };
  for (const [tier, defaults] of Object.entries(merged)) {
    const row = rowsMap.get(tier);
    if (row?.isActive) {
      merged[tier as 'PRO'] = {
        monthly: row.monthlyUsd || defaults.monthly,
        yearly: row.yearlyUsd || defaults.yearly,
        creditGrant: row.creditGrant || HARDCODED_GRANTS[tier as 'PRO'],
      };
    }
  }

  _dynamicPricing = merged;
  return merged;
}

export function getDynamicPricing(): Record<string, { monthly: number; yearly: number; creditGrant: number }> {
  return _dynamicPricing || HARDCED_PRICING;
}

// Legacy resolver: the active/frozen Ultra price. Used only to settle
// in-flight ultra_monthly / ultra_yearly orders; new UI does not offer it.
export function getLegacyUltraPricing(): LegacyUltraPricing {
  return _legacyUltraPricing;
}

export function getDynamicGrants() {
  const pricing = getDynamicPricing();
  return {
    PRO: pricing.PRO.creditGrant,
    ULTRA: getLegacyUltraPricing().creditGrant,
  };
}

export async function refreshSubscriptionPricing(): Promise<void> {
  _dynamicPricing = null;
  _legacyUltraPricing = LEGACY_ULTRA_PRICING;
  await loadSubscriptionPricing();
}

// ==================== Init ====================

export async function initDynamicConfig(): Promise<void> {
  try {
    await loadModelConfigs();
    await loadCreditPacks();
    await loadSubscriptionPricing();
    console.log('[ConfigSync] Dynamic config loaded from DB');
  } catch (err) {
    console.error('[ConfigSync] Failed to load dynamic config, using hardcoded defaults:', err);
  }
}
