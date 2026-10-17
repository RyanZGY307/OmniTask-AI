// ================================================================
// Credit Formula — total-cost → credits/1M with 三舍四入 rounding.
//
//   totalCost($) = input + cacheHit + cacheMiss + output   ($/1M)
//   credits/M   = totalCost ÷ 0.01 × 5.56 = totalCost × 556
//   round        = 三舍四入 (decimal ≤ .3 → floor, ≥ .4 → ceil)
//
// Pure, deterministic, no I/O. Negative results clamp to 0.
// ================================================================

/**
 * 三舍四入: round the FIRST decimal place.
 *   .0–.3 → floor ; .4–.9 → floor+1
 * Examples: 372.2→372  372.3→372  372.4→373  372.9→373  0.0→0
 *
 * A small epsilon absorbs float error at the .3 boundary (e.g. 372.3
 * is stored as 372.30000000000001, which would otherwise tip to .3001
 * and wrongly round up to 373).
 */
export function roundCredits(rawCredits: number): number {
  if (!Number.isFinite(rawCredits)) return 0;
  // Clamp negatives so a bad price feed can never produce a negative
  // credit cost.
  const v = Math.max(0, rawCredits);
  const floor = Math.floor(v);
  const decimal = v - floor;
  // Tolerance: treat decimal ≤ 0.3 + 1e-9 as "round down".
  return decimal <= 0.3 + 1e-9 ? floor : floor + 1;
}

/**
 * Compute credits per 1M tokens from the four price components
 * (all $/1M). 总成本 × 556, then 三舍四入.
 */
export function calculateCreditsPer1M(
  inputPrice: number,
  cacheHitPrice: number,
  cacheMissPrice: number,
  outputPrice: number,
): number {
  const totalCost =
    (Number(inputPrice) || 0) +
    (Number(cacheHitPrice) || 0) +
    (Number(cacheMissPrice) || 0) +
    (Number(outputPrice) || 0);
  const raw = totalCost * 556; // (total / 0.01) * 5.56
  return roundCredits(raw);
}

/** Total cost ($/1M) = sum of the four price components. */
export function totalCostOf(
  inputPrice: number,
  cacheHitPrice: number,
  cacheMissPrice: number,
  outputPrice: number,
): number {
  return (
    (Number(inputPrice) || 0) +
    (Number(cacheHitPrice) || 0) +
    (Number(cacheMissPrice) || 0) +
    (Number(outputPrice) || 0)
  );
}

/** Derive the per-1k cost stored on the registry (积分/千token). */
export function costPer1kOf(creditsPer1M: number): number {
  return creditsPer1M / 1000;
}
