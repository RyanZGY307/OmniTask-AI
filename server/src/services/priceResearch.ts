// ================================================================
// Price Research — realtime price lookup (ephemeral, never persisted)
// Prices are cached in memory only; they are NEVER written to the
// Knowledge DB. The cache key includes every dimension to prevent
// cross-contamination (China 256GB != Malaysia 512GB).
// ================================================================

import { prismaKnowledge } from './db';
import { webSearch, type SearchResult } from './searchLayer';

export interface PriceEntry {
  amount: number;
  currency: string;
  seller: string;
  platform: string;
  region: string;
  configuration: string;
  condition: string;
  rating?: number;
  reviewCount?: number;
  retrievedAt: Date;
}

export interface PriceResult {
  prices: PriceEntry[];
  lowest: number;
  highest: number;
  currency: string;
  variant: string;
  configuration: string;
  retrievedAt: Date;
  sourceCount: number;
  error?: string;
}

export interface PriceResearchOptions {
  region?: string;
  platform?: string;
  configuration?: string;
  currency?: string;
  forceRefresh?: boolean;
}

const PRICE_CACHE_TTL_MS = 15 * 60 * 1000;
const PRICE_HARD_TIMEOUT_MS = 15 * 1000;
const MAX_CACHE_ENTRIES = 500;
const MAX_RESULTS_PER_QUERY = 8;

interface CacheEntry {
  result: PriceResult;
  storedAt: number;
}

const priceCache = new Map<string, CacheEntry>();

function buildCacheKey(objectId: string, variantId: string | undefined, o: PriceResearchOptions): string {
  return [
    objectId,
    variantId ?? '*',
    o.region ?? '*',
    o.platform ?? '*',
    o.configuration ?? '*',
    o.currency ?? '*',
  ].join(':');
}

function storeInCache(key: string, result: PriceResult): void {
  if (priceCache.size >= MAX_CACHE_ENTRIES) {
    const keys = Array.from(priceCache.keys());
    for (const k of keys.slice(0, Math.floor(MAX_CACHE_ENTRIES / 2))) {
      priceCache.delete(k);
    }
  }
  priceCache.set(key, { result, storedAt: Date.now() });
}

function extractPrices(text: string): Array<{ amount: number; currency: string }> {
  const out: Array<{ amount: number; currency: string }> = [];
  const re = /([¥€$£]|\bUSD\b|\bEUR\b|\bGBP\b|\bJPY\b|\bCNY\b|\bMYR\b|\bSGD\b|\bTHB\b|\bIDR\b|\bINR\b|\bPHP\b|\bAUD\b|\bCAD\b)\s*([£$€¥]?)\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const amount = parseFloat(m[3].replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount < 1 || amount > 1_000_000) continue;
    let currency = m[1].toUpperCase();
    if (m[2]) {
      currency = m[2] === '£' ? 'GBP' : m[2] === '€' ? 'EUR' : m[2] === '¥' ? 'CNY' : 'USD';
    }
    out.push({ amount, currency });
  }
  return out;
}

async function runPriceSearch(
  objectId: string,
  opts: PriceResearchOptions,
  region: string,
  configuration: string,
  currency: string,
): Promise<{ entries: PriceEntry[]; domains: string[] }> {
  const obj = await prismaKnowledge.knowledgeObject.findUnique({
    where: { id: objectId },
    select: { canonicalName: true },
  });
  const name = obj?.canonicalName || objectId;

  const queries: string[] = [
    `${name} ${configuration} price official site ${region}`,
  ];
  if (opts.platform) {
    queries.push(`${name} ${opts.platform} ${region} ${configuration} price`);
  }
  queries.push(`${name} ${region} ${configuration} buy ${currency} price`);

  const all: SearchResult[] = [];
  const start = Date.now();
  for (const q of queries) {
    if (Date.now() - start > PRICE_HARD_TIMEOUT_MS) break;
    try {
      const res = await webSearch(q, { region, maxResults: MAX_RESULTS_PER_QUERY });
      all.push(...res);
    } catch (err: any) {
      console.warn(`[PriceResearch] search query failed (${q}): ${err?.message ?? err}`);
    }
  }

  const entries: PriceEntry[] = [];
  const seen = new Set<string>();
  const domains = new Set<string>();
  for (const r of all) {
    domains.add(r.domain);
    const text = `${r.title} ${r.snippet}`;
    for (const p of extractPrices(text)) {
      const dedupeKey = `${p.currency}:${p.amount}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      entries.push({
        amount: p.amount,
        currency: p.currency,
        seller: r.domain,
        platform: opts.platform ?? r.domain,
        region,
        configuration,
        condition: 'NEW',
        retrievedAt: new Date(),
      });
    }
  }

  return { entries, domains: Array.from(domains) };
}

export async function researchPrice(
  objectId: string,
  variantId?: string,
  opts: PriceResearchOptions = {},
): Promise<PriceResult> {
  const key = buildCacheKey(objectId, variantId, opts);
  const cached = priceCache.get(key);

  if (cached && !opts.forceRefresh && Date.now() - cached.storedAt < PRICE_CACHE_TTL_MS) {
    return cached.result;
  }

  const region = opts.region ?? 'GLOBAL';
  const configuration = opts.configuration ?? 'standard';
  const currency = opts.currency ?? 'USD';
  const variant = variantId ?? 'base';

  const searchPromise = runPriceSearch(objectId, opts, region, configuration, currency).catch((err: any) => {
    console.warn(`[PriceResearch] search failed: ${err?.message ?? err}`);
    return { entries: [] as PriceEntry[], domains: [] as string[] };
  });
  const timeoutSentinel = new Promise<null>((resolve) => setTimeout(() => resolve(null), PRICE_HARD_TIMEOUT_MS));
  const searched = await Promise.race([searchPromise, timeoutSentinel]);

  if (searched === null) {
    if (cached) return cached.result;
    return {
      prices: [],
      lowest: 0,
      highest: 0,
      currency,
      variant,
      configuration,
      retrievedAt: new Date(),
      sourceCount: 0,
      error: `price research timed out after ${PRICE_HARD_TIMEOUT_MS / 1000}s; no cached result available`,
    };
  }

  const { entries, domains } = searched;
  const lowest = entries.length > 0 ? Math.min(...entries.map((e) => e.amount)) : 0;
  const highest = entries.length > 0 ? Math.max(...entries.map((e) => e.amount)) : 0;

  const result: PriceResult = {
    prices: entries,
    lowest,
    highest,
    currency,
    variant,
    configuration,
    retrievedAt: new Date(),
    sourceCount: entries.length > 0
      ? new Set(entries.map((e) => e.platform)).size
      : domains.length,
  };
  if (entries.length === 0) {
    result.error = 'no prices found in search results';
  }

  storeInCache(key, result);
  return result;
}
