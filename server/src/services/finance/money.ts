// ================================================================
// Money — Decimal-only arithmetic for all financial calculations
// ================================================================
//
// R10.1: every financial amount is a Decimal (never Float).
// Use these helpers everywhere money is computed; never use
// JavaScript number arithmetic for USD/MYR amounts.

import { Prisma } from '@prisma/client-user';

export type DecimalInput = Prisma.Decimal.Value;
export const Decimal = Prisma.Decimal;

// Business constants (spec R2, R4)
export const COST_PROTECTION_FACTOR = new Prisma.Decimal('1.15');
export const COST_FX_RATE = new Prisma.Decimal('4.50');
export const TARGET_MARGIN = new Prisma.Decimal('0.30');
export const MARGIN_LOW = new Prisma.Decimal('0.20');
export const MARGIN_HIGH = new Prisma.Decimal('0.40');
export const ADJUST_STEP = new Prisma.Decimal('0.05');

// Rounding scales
export const USD_SCALE = 6;
export const PRICE_SCALE = 2;
export const RATE_SCALE = 10;

export function d(value: DecimalInput): Prisma.Decimal {
  if (value === null || value === undefined) return new Prisma.Decimal(0);
  return new Prisma.Decimal(value);
}

export function roundScale(value: DecimalInput, scale: number): Prisma.Decimal {
  return d(value).toDecimalPlaces(scale, Prisma.Decimal.ROUND_HALF_UP);
}

export function roundUsd(value: DecimalInput): Prisma.Decimal {
  return roundScale(value, USD_SCALE);
}

export function roundPrice(value: DecimalInput): Prisma.Decimal {
  return roundScale(value, PRICE_SCALE);
}

export function roundRate(value: DecimalInput): Prisma.Decimal {
  return roundScale(value, RATE_SCALE);
}

export function clamp(value: DecimalInput, min?: DecimalInput | null, max?: DecimalInput | null): Prisma.Decimal {
  let v = d(value);
  if (min !== null && min !== undefined && v.lt(d(min))) v = d(min);
  if (max !== null && max !== undefined && v.gt(d(max))) v = d(max);
  return v;
}

export function product(...values: DecimalInput[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((acc, v) => acc.times(d(v)), new Prisma.Decimal(1));
}

export function sum(...values: DecimalInput[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((acc, v) => acc.plus(d(v)), new Prisma.Decimal(0));
}

// R2.1 / R2.2 — cost protection then fixed cost FX
export function protectedCostUsd(actualCostUsd: DecimalInput): Prisma.Decimal {
  return roundUsd(d(actualCostUsd).times(COST_PROTECTION_FACTOR));
}

export function protectedCostMyr(actualCostUsd: DecimalInput): Prisma.Decimal {
  return roundUsd(protectedCostUsd(actualCostUsd).times(COST_FX_RATE));
}

// R3.3 — revenue in MYR uses the live market rate, not the fixed cost rate
export function revenueMyr(priceUsd: DecimalInput, marketRate: DecimalInput): Prisma.Decimal {
  return roundUsd(d(priceUsd).times(d(marketRate)));
}

// R4.2 — gross margin = (revenue - cost) / revenue
export function grossMargin(revenue: DecimalInput, cost: DecimalInput): Prisma.Decimal {
  const rev = d(revenue);
  if (rev.lte(0)) return new Prisma.Decimal(0);
  return rev.minus(d(cost)).div(rev);
}

export function applyStep(price: DecimalInput, direction: 1 | -1 | 0): Prisma.Decimal {
  if (direction === 0) return d(price);
  const factor = direction > 0 ? new Prisma.Decimal(1).plus(ADJUST_STEP) : new Prisma.Decimal(1).minus(ADJUST_STEP);
  return d(price).times(factor);
}

// Integer minor units — used when an exact integer representation is required
export function toMinor(value: DecimalInput, scale: number): bigint {
  return BigInt(roundScale(value, scale).times(new Prisma.Decimal(10).pow(scale)).toFixed(0));
}

export function fromMinor(minor: bigint | number | string, scale: number): Prisma.Decimal {
  return new Prisma.Decimal(minor.toString()).div(new Prisma.Decimal(10).pow(scale));
}

export function toNumber(value: DecimalInput): number {
  return d(value).toNumber();
}

export function toFixedString(value: DecimalInput, scale: number): string {
  return d(value).toFixed(scale);
}

export function serialize(value: DecimalInput): string {
  return d(value).toString();
}
