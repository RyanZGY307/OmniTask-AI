// ================================================================
// Pricing Engine — immutable Pricing Versions (R5, R6, R7, R11)
// ================================================================
//
// Daily job:
//   capture FX → aggregate margin from real usage → decide ±5% →
//   clamp to safe bounds → validate ladder → publish (max 1/day).
//
// A failed FX fetch or missing cost data NEVER publishes a new version.

import { Prisma } from '@prisma/client-user';
import { prisma } from '../db';
import { getDynamicModels, getDynamicPacks, getDynamicPricing, getDynamicGrants, getLegacyUltraPricing } from '../configSync';
import { PRICING_GUARDRAILS } from '../../config';
import { computeMargin } from './costEngine';
import { getActiveFxVersion, captureDailyFx } from './fxVersion';
import { aggregateMargin, computeRowMargin, decideDirection, nextCandidatePrice } from './marginEngine';
import { DecimalInput, d, roundPrice, toFixedString } from './money';

export interface PackagePriceVersion {
  id: string;
  credits: number;
  priceUsd: string;
  minSafePriceUsd: string;
  maxSafePriceUsd: string;
}

export interface SubscriptionPriceVersion {
  tier: 'PRO' | 'ULTRA';
  priceUsd: string;
  credits: number;
  minSafePriceUsd: string;
  maxSafePriceUsd: string;
}

export interface ActivePricingVersion {
  id: string;
  code: string;
  publishedAt: Date;
  fxVersionId: string | null;
  providerPricingVersionId: string | null;
  creditPricingVersionId: string | null;
  marketRateUsdMyr: Prisma.Decimal | null;
  packages: PackagePriceVersion[];
  subscriptions: SubscriptionPriceVersion[];
  modelCreditsPerM: Record<string, string>;
}

const REFERENCE_PACK_ID = 'pack-1200';

function guardrails() {
  return PRICING_GUARDRAILS;
}

function safeBounds(priceUsd: DecimalInput) {
  const factorMin = d(guardrails().minPriceFactor);
  const factorMax = d(guardrails().maxPriceFactor);
  return { min: roundPrice(d(priceUsd).times(factorMin)), max: roundPrice(d(priceUsd).times(factorMax)) };
}

function modelCreditsPerM(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, info] of Object.entries(getDynamicModels()) as [string, any][]) {
    out[key] = d(info.costPer1k).times(1000).toFixed(0);
  }
  return out;
}

export function buildBaselinePackages(): PackagePriceVersion[] {
  return getDynamicPacks().map((pack) => {
    const { min, max } = safeBounds(pack.price);
    return {
      id: pack.id,
      credits: pack.credits,
      priceUsd: d(pack.price).toFixed(2),
      minSafePriceUsd: toFixedString(min, 2),
      maxSafePriceUsd: toFixedString(max, 2),
    };
  });
}

export function buildBaselineSubscriptions(): SubscriptionPriceVersion[] {
  // PRO is the only sellable tier. ULTRA is legacy-only: its price row is
  // kept so in-flight ultra_* orders and historical Pricing Versions
  // still settle correctly, but it is never offered for sale.
  const tiers: ('PRO' | 'ULTRA')[] = ['PRO', 'ULTRA'];
  return tiers.map((tier) => {
    const price = tier === 'PRO'
      ? getDynamicPricing().PRO.monthly
      : getLegacyUltraPricing().monthly;
    const { min, max } = safeBounds(price);
    return {
      tier,
      priceUsd: d(price).toFixed(2),
      credits: getDynamicGrants()[tier],
      minSafePriceUsd: toFixedString(min, 2),
      maxSafePriceUsd: toFixedString(max, 2),
    };
  });
}

// ==================== Validation (R7.3, R7.4) ====================

export interface LadderItem {
  key: string;
  credits: number;
  priceUsd: DecimalInput;
}

export function validateLadder(items: LadderItem[]): { ok: boolean; reason?: string } {
  const sorted = [...items].sort((a, b) => a.credits - b.credits);
  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];
    if (next.credits === current.credits) continue;
    const curUnit = d(current.priceUsd).div(current.credits);
    const nextUnit = d(next.priceUsd).div(next.credits);
    if (nextUnit.gt(curUnit)) {
      return {
        ok: false,
        reason: `ladder violation: ${next.key} unit ${nextUnit.toFixed(6)} > ${current.key} unit ${curUnit.toFixed(6)}`,
      };
    }
  }
  return { ok: true };
}

function clampPackages(packages: PackagePriceVersion[]): PackagePriceVersion[] {
  return packages.map((p) => {
    const clamped = roundPrice(
      d(p.priceUsd).lt(d(p.minSafePriceUsd))
        ? d(p.minSafePriceUsd)
        : d(p.priceUsd).gt(d(p.maxSafePriceUsd))
          ? d(p.maxSafePriceUsd)
          : d(p.priceUsd),
    );
    return { ...p, priceUsd: toFixedString(clamped, 2) };
  });
}

function clampSubscriptions(subscriptions: SubscriptionPriceVersion[]): SubscriptionPriceVersion[] {
  return subscriptions.map((s) => {
    const clamped = roundPrice(
      d(s.priceUsd).lt(d(s.minSafePriceUsd))
        ? d(s.minSafePriceUsd)
        : d(s.priceUsd).gt(d(s.maxSafePriceUsd))
          ? d(s.maxSafePriceUsd)
          : d(s.priceUsd),
    );
    return { ...s, priceUsd: toFixedString(clamped, 2) };
  });
}

// ==================== Publish (R5.1, R7.4) ====================

export interface PublishCandidate {
  packages: PackagePriceVersion[];
  subscriptions: SubscriptionPriceVersion[];
  fxVersionId: string | null;
  providerPricingVersionId: string | null;
  reason: string;
  publisher?: string;
}

export async function publishPricingVersion(candidate: PublishCandidate): Promise<{ ok: boolean; reason?: string; pricingVersionId?: string; code?: string }> {
  const packages = clampPackages(candidate.packages);
  const subscriptions = clampSubscriptions(candidate.subscriptions);

  const packCheck = validateLadder(packages.map((p) => ({ key: p.id, credits: p.credits, priceUsd: p.priceUsd })));
  if (!packCheck.ok) return { ok: false, reason: packCheck.reason };

  const subCheck = validateLadder(subscriptions.map((s) => ({ key: `sub-${s.tier}`, credits: s.credits, priceUsd: s.priceUsd })));
  if (!subCheck.ok) return { ok: false, reason: subCheck.reason };

  const minSafe: Record<string, string> = {};
  const maxSafe: Record<string, string> = {};
  for (const p of packages) {
    minSafe[p.id] = p.minSafePriceUsd;
    maxSafe[p.id] = p.maxSafePriceUsd;
  }
  for (const s of subscriptions) {
    minSafe[`sub-${s.tier}`] = s.minSafePriceUsd;
    maxSafe[`sub-${s.tier}`] = s.maxSafePriceUsd;
  }

  const code = `pv-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;

  const created = await prisma.$transaction(async (tx) => {
    const creditPricing = await tx.creditPricingVersion.create({
      data: {
        packagesJson: JSON.stringify(packages),
        subscriptionJson: JSON.stringify(subscriptions),
        modelCreditsPerMJson: JSON.stringify(modelCreditsPerM()),
        minSafePricesJson: JSON.stringify(minSafe),
        maxSafePricesJson: JSON.stringify(maxSafe),
        status: 'active',
      },
    });

    await tx.pricingVersion.updateMany({
      where: { status: 'active' },
      data: { status: 'superseded' },
    });

    const pricing = await tx.pricingVersion.create({
      data: {
        code,
        fxVersionId: candidate.fxVersionId,
        providerPricingVersionId: candidate.providerPricingVersionId,
        creditPricingVersionId: creditPricing.id,
        publisher: candidate.publisher || 'auto',
        status: 'active',
      },
    });

    return pricing;
  }, { timeout: 20000 });

  return { ok: true, pricingVersionId: created.id, code: created.code };
}

async function publishedTodayCount(): Promise<number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return prisma.pricingVersion.count({ where: { publishedAt: { gte: start } } });
}

// ==================== Active version ====================

export async function getActivePricingVersion(): Promise<ActivePricingVersion | null> {
  const pricing = await prisma.pricingVersion.findFirst({
    where: { status: 'active' },
    orderBy: { publishedAt: 'desc' },
    include: { creditPricingVersion: true, fxVersion: true },
  });
  if (!pricing || !pricing.creditPricingVersion) return null;

  const cpv: any = pricing.creditPricingVersion;
  return {
    id: pricing.id,
    code: pricing.code,
    publishedAt: pricing.publishedAt,
    fxVersionId: pricing.fxVersionId,
    providerPricingVersionId: pricing.providerPricingVersionId,
    creditPricingVersionId: pricing.creditPricingVersionId,
    marketRateUsdMyr: pricing.fxVersion ? d(pricing.fxVersion.rate) : null,
    packages: (cpv.packagesJson as PackagePriceVersion[]) || [],
    subscriptions: (cpv.subscriptionJson as SubscriptionPriceVersion[]) || [],
    modelCreditsPerM: (cpv.modelCreditsPerMJson as Record<string, string>) || {},
  };
}

export async function bootstrapInitialPricingVersion(force = false): Promise<{ ok: boolean; code?: string; reason?: string }> {
  if (!force) {
    const existing = await getActivePricingVersion();
    if (existing) return { ok: true, code: existing.code };
  }

  let fxVersionId: string | null = null;
  const fx = await getActiveFxVersion();
  if (fx) {
    fxVersionId = fx.id;
  } else {
    const captured = await captureDailyFx();
    if (captured.ok) fxVersionId = captured.version.id;
  }

  return publishPricingVersion({
    packages: buildBaselinePackages(),
    subscriptions: buildBaselineSubscriptions(),
    fxVersionId,
    providerPricingVersionId: null,
    reason: 'bootstrap',
    publisher: 'bootstrap',
  });
}

// ==================== Order lock (R6, R11) ====================

export interface OrderLock {
  pricingVersionId: string;
  fxVersionId: string | null;
  providerPricingVersionId: string | null;
  creditPricingVersionId: string | null;
  priceUsd: Prisma.Decimal;
  credits: number;
  marketRateUsdMyr: Prisma.Decimal | null;
  validDays: number;
}

export async function lockPackPricing(packId: string): Promise<OrderLock | null> {
  const active = await getActivePricingVersion();
  if (!active) return null;
  const pack = active.packages.find((p) => p.id === packId);
  if (!pack) return null;
  return {
    pricingVersionId: active.id,
    fxVersionId: active.fxVersionId,
    providerPricingVersionId: active.providerPricingVersionId,
    creditPricingVersionId: active.creditPricingVersionId,
    priceUsd: d(pack.priceUsd),
    credits: pack.credits,
    marketRateUsdMyr: active.marketRateUsdMyr,
    validDays: 90,
  };
}

export async function lockSubscriptionPricing(tier: 'PRO' | 'ULTRA'): Promise<OrderLock | null> {
  const active = await getActivePricingVersion();
  if (!active) return null;
  const sub = active.subscriptions.find((s) => s.tier === tier);
  if (!sub) return null;
  return {
    pricingVersionId: active.id,
    fxVersionId: active.fxVersionId,
    providerPricingVersionId: active.providerPricingVersionId,
    creditPricingVersionId: active.creditPricingVersionId,
    priceUsd: d(sub.priceUsd),
    credits: sub.credits,
    marketRateUsdMyr: active.marketRateUsdMyr,
    validDays: 30,
  };
}

// ==================== Daily pricing job (R4, R5, R3.4) ====================

export interface DailyPricingReport {
  ok: boolean;
  reason?: string;
  published?: boolean;
  code?: string;
  marginPct?: string;
  direction?: number;
  detail?: any;
}

export async function runDailyPricingJob(): Promise<DailyPricingReport> {
  const todayCount = await publishedTodayCount();
  if (todayCount >= guardrails().maxPublishesPerDay) {
    return { ok: true, published: false, reason: 'already_published_today' };
  }

  const fxCapture = await captureDailyFx();
  if (!fxCapture.ok) {
    // R3.4 — keep the last valid FX Version and block release.
    return { ok: false, published: false, reason: 'fx_fetch_failed' };
  }
  const marketRate = fxCapture.version.rate;

  const active = await getActivePricingVersion();
  const packages = active?.packages ?? buildBaselinePackages();
  const subscriptions = active?.subscriptions ?? buildBaselineSubscriptions();

  // 成本 = 套餐价格 USD × 4.50 × 1.15（固定汇率保护）
  // 收入 = 套餐价格 USD × 市场汇率
  let totalCostMyr = new Prisma.Decimal(0);
  let totalRevenueMyr = new Prisma.Decimal(0);

  for (const pkg of packages) {
    const price = d(pkg.priceUsd);
    totalCostMyr = totalCostMyr.plus(price.times('1.15').times('4.50'));
    totalRevenueMyr = totalRevenueMyr.plus(price.times(marketRate));
  }
  for (const sub of subscriptions) {
    const price = d(sub.priceUsd);
    totalCostMyr = totalCostMyr.plus(price.times('1.15').times('4.50'));
    totalRevenueMyr = totalRevenueMyr.plus(price.times(marketRate));
  }

  // 毛利率 = (收入 - 成本) / 收入
  const margin = computeMargin(totalRevenueMyr, new Prisma.Decimal(1), totalCostMyr);
  const decision = decideDirection(margin);
  if (decision.direction === 0) {
    return {
      ok: true, published: false,
      marginPct: margin.times(100).toFixed(2),
      direction: 0,
      detail: { reason: decision.reason, marketRate: marketRate.toFixed(6) },
    };
  }

  const nextPackages = packages.map((p) => ({ ...p, priceUsd: toFixedString(nextCandidatePrice(p.priceUsd, decision.direction), 2) }));
  const nextSubscriptions = subscriptions.map((s) => ({ ...s, priceUsd: toFixedString(nextCandidatePrice(s.priceUsd, decision.direction), 2) }));

  const result = await publishPricingVersion({
    packages: nextPackages,
    subscriptions: nextSubscriptions,
    fxVersionId: fxCapture.version.id,
    providerPricingVersionId: null,
    reason: decision.reason,
  });

  return {
    ok: result.ok,
    published: result.ok,
    code: result.code,
    marginPct: margin.times(100).toFixed(2),
    direction: decision.direction,
    detail: { reason: result.reason || decision.reason, marketRate: marketRate.toFixed(6) },
  };
}
