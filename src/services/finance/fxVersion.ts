// ================================================================
// FX Version — immutable daily USD/MYR market-rate snapshots
// ================================================================
//
// R3.1 fetch daily USD/MYR market rate
// R3.2 persist an immutable FxVersion for every successful fetch
// R3.4 if the fetch fails, keep the last valid version and block release

import { prisma } from '../db';
import { Prisma } from '@prisma/client-user';
import { d, roundRate, toNumber } from './money';

export const FX_SOURCE = 'open.er-api.com';
export const BASE_CURRENCY = 'USD';
export const QUOTE_CURRENCY = 'MYR';

export interface FxVersionInfo {
  id: string;
  rate: Prisma.Decimal;
  fetchedAt: Date;
  source: string;
}

export async function fetchMarketRate(quote: string = QUOTE_CURRENCY): Promise<number | null> {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!res.ok) throw new Error(`rate api status ${res.status}`);
    const data = (await res.json()) as any;
    if (data?.result !== 'success') throw new Error('rate api returned non-success');
    const rate = data?.rates?.[quote];
    if (typeof rate !== 'number' || !isFinite(rate) || rate <= 0) throw new Error(`missing rate for ${quote}`);
    return rate;
  } catch (err) {
    console.error('[FX] daily rate fetch failed:', err);
    return null;
  }
}

export async function createFxVersion(rate: number | string, quote: string = QUOTE_CURRENCY, source: string = FX_SOURCE): Promise<FxVersionInfo> {
  const value = roundRate(rate);
  if (d(value).lte(0)) throw new Error('invalid FX rate');
  // 数据库冷启动写慢，默认 5s 的交互事务超时会在 P1008 场景下
  // 触发 P2028（transaction already closed）。放宽到 20s。
  const created = await prisma.$transaction(async (tx) => {
    await tx.fxVersion.updateMany({
      where: { baseCurrency: BASE_CURRENCY, quoteCurrency: quote, isActive: true },
      data: { isActive: false },
    });
    return tx.fxVersion.create({
      data: {
        baseCurrency: BASE_CURRENCY,
        quoteCurrency: quote,
        rate: value.toNumber(),
        source,
        isActive: true,
      },
    });
  }, { timeout: 20000 });
  return { id: created.id, rate: d(created.rate), fetchedAt: created.fetchedAt, source };
}

export async function getActiveFxVersion(quote: string = QUOTE_CURRENCY): Promise<FxVersionInfo | null> {
  const row = await prisma.fxVersion.findFirst({
    where: { baseCurrency: BASE_CURRENCY, quoteCurrency: quote, isActive: true },
    orderBy: { fetchedAt: 'desc' },
  });
  if (!row) return null;
  return { id: row.id, rate: d(row.rate), fetchedAt: row.fetchedAt, source: row.source };
}

export async function getActiveMarketRate(quote: string = QUOTE_CURRENCY): Promise<Prisma.Decimal | null> {
  const version = await getActiveFxVersion(quote);
  return version ? version.rate : null;
}

export async function captureDailyFx(quote: string = QUOTE_CURRENCY): Promise<{ ok: true; version: FxVersionInfo } | { ok: false; reason: string }> {
  const rate = await fetchMarketRate(quote);
  if (rate === null) return { ok: false, reason: 'fetch_failed' };
  const version = await createFxVersion(rate, quote);
  return { ok: true, version };
}

// Convenience for display / non-authoritative paths. Never used for cost.
export async function getRateNumber(quote: string = QUOTE_CURRENCY): Promise<number> {
  const rate = await getActiveMarketRate(quote);
  return rate ? toNumber(rate) : 1;
}
