// ================================================================
// Margin Engine — gross margin and adjustment direction (R4)
// ================================================================

import { Prisma } from '@prisma/client-user';
import {
  ADJUST_STEP,
  Decimal,
  DecimalInput,
  MARGIN_HIGH,
  MARGIN_LOW,
  applyStep,
  d,
  grossMargin,
  revenueMyr,
  roundPrice,
  toNumber,
} from './money';

export type AdjustmentDirection = 1 | -1 | 0;

export interface MarginDecision {
  direction: AdjustmentDirection;
  margin: Prisma.Decimal;
  reason: string;
}

export function decideDirection(margin: DecimalInput): MarginDecision {
  const m = d(margin);
  if (m.lt(MARGIN_LOW)) return { direction: 1, margin: m, reason: `margin ${m.times(100).toFixed(2)}% < 20% → +5%` };
  if (m.gt(MARGIN_HIGH)) return { direction: -1, margin: m, reason: `margin ${m.times(100).toFixed(2)}% > 40% → -5%` };
  return { direction: 0, margin: m, reason: `margin ${m.times(100).toFixed(2)}% within 20%-40% → hold` };
}

export interface MarginRow {
  key: string;
  priceUsd: Prisma.Decimal;
  costMyr: Prisma.Decimal;
  revenueMyr: Prisma.Decimal;
  margin: Prisma.Decimal;
}

export function computeRowMargin(key: string, priceUsd: DecimalInput, costMyr: DecimalInput, marketRate: DecimalInput): MarginRow {
  const revenue = revenueMyr(priceUsd, marketRate);
  return {
    key,
    priceUsd: d(priceUsd),
    costMyr: d(costMyr),
    revenueMyr: revenue,
    margin: grossMargin(revenue, costMyr),
  };
}

export function aggregateMargin(rows: MarginRow[]): Prisma.Decimal {
  if (rows.length === 0) return new Prisma.Decimal(0);
  const revenue = rows.reduce((acc, r) => acc.plus(r.revenueMyr), new Prisma.Decimal(0));
  const cost = rows.reduce((acc, r) => acc.plus(r.costMyr), new Prisma.Decimal(0));
  return grossMargin(revenue, cost);
}

export function nextCandidatePrice(priceUsd: DecimalInput, direction: AdjustmentDirection): Prisma.Decimal {
  return roundPrice(applyStep(d(priceUsd), direction));
}

export { ADJUST_STEP, toNumber };
