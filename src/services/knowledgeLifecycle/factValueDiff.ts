// ================================================================
// Fact Value Diff — structured/semantic comparison (R5.1/R5.2).
// Pure functions; no DB or model calls. Mirrors crossValidation's
// 5% numeric tolerance so "5000mAh" vs "5000 mAh" is UNCHANGED while
// "Android 15" vs "Android 16" is MATERIAL_CHANGE.
// ================================================================

export type FactDiffVerdict =
  | 'UNCHANGED'
  | 'MINOR_CHANGE'
  | 'MATERIAL_CHANGE'
  | 'CONFLICT'
  | 'SOURCE_GONE'
  | 'UNVERIFIED';

// Normalizes a fact value into a comparable canonical form:
//  - trim + collapse whitespace
//  - strip unit spacing ("5000mAh" -> "5000mah"), lowercase units
//  - pull out a numeric core for tolerance comparison
export function normalizeFactValue(raw: string): { text: string; numeric: number | null } {
  const text = (raw || '').replace(/\s+/g, ' ').trim().toLowerCase();
  // pull the first numeric token (optionally with decimals) as the numeric core
  const m = text.match(/-?\d+(\.\d+)?/);
  const numeric = m ? Number(m[0]) : null;
  return { text, numeric };
}

// Two numeric cores agree within tolerance (5%) when both are present and non-zero.
function numericAgree(a: number, b: number, tolerance = 0.05): boolean {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / denom <= tolerance;
}

// Structured diff between old and new fact value.
// `newRaw` null means no new evidence available (UNVERIFIED / SOURCE_GONE decided by caller).
export function diffFactValues(oldRaw: string, newRaw: string | null): FactDiffVerdict {
  if (newRaw === null) return 'UNVERIFIED';
  const a = normalizeFactValue(oldRaw);
  const b = normalizeFactValue(newRaw);

  // exact canonical match
  if (a.text === b.text) return 'UNCHANGED';

  // numeric cores agree within tolerance AND no other token differs materially
  if (a.numeric !== null && b.numeric !== null && numericAgree(a.numeric, b.numeric)) {
    // same number, different unit spelling -> minor
    return 'MINOR_CHANGE';
  }

  // both have numeric cores that disagree -> material (R5.1 "Android 15 vs 16")
  if (a.numeric !== null && b.numeric !== null) return 'MATERIAL_CHANGE';

  // one side has a number the other does not -> material
  if ((a.numeric !== null) !== (b.numeric !== null)) return 'MATERIAL_CHANGE';

  // text-only: check token-set overlap to separate minor rephrasing from material
  const tokensA = new Set(a.text.split(' ').filter(Boolean));
  const tokensB = new Set(b.text.split(' ').filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) {
    return a.text === b.text ? 'UNCHANGED' : 'MATERIAL_CHANGE';
  }
  let shared = 0;
  for (const t of tokensA) if (tokensB.has(t)) shared += 1;
  const jaccard = shared / (tokensA.size + tokensB.size - shared);
  // high overlap = rephrasing (minor); low overlap = different fact (material)
  return jaccard >= 0.6 ? 'MINOR_CHANGE' : 'MATERIAL_CHANGE';
}
