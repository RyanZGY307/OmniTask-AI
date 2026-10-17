// ================================================================
// Provider Pricing Version — versioned Provider USD cost parameters
// ================================================================
//
// Provider USD cost (per 1,000,000 tokens) is a BUSINESS INPUT. There
// is no authoritative default: an uncalibrated provider must trigger a
// cost review instead of a fabricated 0 (R1.3 / R1.4).
//
// Supply real negotiated rates via:
//   PROVIDER_COST_TABLE_JSON={"google":{"input":0.10,"output":0.40}}
// Optional cached input rate: {"google":{"input":..,"output":..,"cached":..}}

import { prisma } from '../db';
import { Prisma } from '@prisma/client-user';
import { COST_FX_RATE, COST_PROTECTION_FACTOR, DecimalInput, d, toNumber } from './money';

export interface ProviderCostEntry {
  input: string | number;
  output: string | number;
  cached?: string | number;
}

export async function getActiveProviderPricingVersion(provider: string): Promise<any | null> {
  return prisma.providerPricingVersion.findFirst({
    where: {
      provider,
      effectiveAt: { lte: new Date() },
      OR: [{ expiresAt: null }, { expiresAt: { gte: new Date() } }],
    },
    orderBy: { effectiveAt: 'desc' },
  });
}

export async function createProviderPricingVersion(
  provider: string,
  entry: ProviderCostEntry,
  opts: { protectionFactor?: string | number; costFxRate?: string | number; expiresAt?: Date | null } = {},
): Promise<string> {
  const input = d(entry.input);
  const output = d(entry.output);
  const cached = entry.cached === undefined ? null : d(entry.cached);
  if (input.lt(0) || output.lt(0) || (cached && cached.lt(0))) {
    throw new Error(`invalid provider cost for ${provider}`);
  }
  const row = await prisma.providerPricingVersion.create({
    data: {
      provider,
      inputCostPerMUsd: input.toNumber(),
      outputCostPerMUsd: output.toNumber(),
      cachedCostPerMUsd: cached?.toNumber() ?? null,
      protectionFactor: opts.protectionFactor !== undefined ? d(opts.protectionFactor).toNumber() : toNumber(COST_PROTECTION_FACTOR),
      costFxRate: opts.costFxRate !== undefined ? d(opts.costFxRate).toNumber() : toNumber(COST_FX_RATE),
      effectiveAt: new Date(),
      expiresAt: opts.expiresAt ?? null,
    },
  });
  return row.id;
}

export function loadProviderCostTable(): Record<string, ProviderCostEntry> | null {
  const raw = process.env.PROVIDER_COST_TABLE_JSON;
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed as Record<string, ProviderCostEntry>;
  } catch (err: any) {
    console.error('[ProviderPricing] invalid PROVIDER_COST_TABLE_JSON:', err?.message || err);
    return null;
  }
}

export async function seedProviderPricingFromEnv(): Promise<string[]> {
  const table = loadProviderCostTable();
  if (!table) return [];
  const created: string[] = [];
  for (const [provider, entry] of Object.entries(table)) {
    try {
      const existing = await getActiveProviderPricingVersion(provider);
      if (existing) continue;
      const id = await createProviderPricingVersion(provider, entry);
      created.push(id);
    } catch (err: any) {
      console.error(`[ProviderPricing] seed failed for ${provider}:`, err?.message || err);
    }
  }
  return created;
}

// Compute USD cost from tokens using a ProviderPricingVersion.
// Returns null when parameters are missing — never defaults to 0 (R1.3).
export function computeCostFromPricing(
  pricing: { inputCostPerMUsd: DecimalInput; outputCostPerMUsd: DecimalInput; cachedCostPerMUsd?: DecimalInput | null } | null,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0,
): Prisma.Decimal | null {
  if (!pricing) return null;
  const perM = new Prisma.Decimal(1000000);
  const input = d(pricing.inputCostPerMUsd).times(inputTokens).div(perM);
  const output = d(pricing.outputCostPerMUsd).times(outputTokens).div(perM);
  let total = input.plus(output);
  if (pricing.cachedCostPerMUsd && cachedTokens > 0) {
    total = total.plus(d(pricing.cachedCostPerMUsd).times(cachedTokens).div(perM));
  }
  return total;
}
