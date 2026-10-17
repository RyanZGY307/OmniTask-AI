// ================================================================
// Conflict Detection — detect and record conflicts between facts
// ================================================================

import { prismaKnowledge } from './db';

export interface FactInput {
  id: string;
  claim: string;
  value?: string;
  confidence: number;
  variantId?: string;
}

export interface Conflict {
  factIds: string[];
  claim: string;
  values: string[];
  possibleReason: string;
}

const NEGATION_MARKERS = [
  'not', 'no ', "doesn't", "don't", "never", 'non-','non ', '没有', '不是', '不支持', '无法', '并非',
];

function normClaim(claim: string): string {
  return String(claim ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isNegated(value: string): boolean {
  const s = String(value ?? '').toLowerCase();
  return NEGATION_MARKERS.some((m) => s.includes(m));
}

function extractNumber(v: string): number | null {
  const m = String(v ?? '').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function detectReason(values: string[]): string {
  const nums = values.map(extractNumber);
  const allNumeric = nums.every((n) => n !== null);
  if (allNumeric) {
    const arr = nums as number[];
    const maxAbs = Math.max(...arr.map(Math.abs));
    if (maxAbs === 0) return 'numerical discrepancy (all values are zero)';
    const spread = Math.max(...arr) - Math.min(...arr);
    if (spread <= maxAbs * 0.05) {
      return 'values within 5% tolerance (likely rounding or measurement differences)';
    }
    return 'numerical discrepancy (differing measurements, units, or methodologies)';
  }

  const negated = values.filter(isNegated);
  const affirmed = values.filter((v) => !isNegated(v));
  if (negated.length > 0 && affirmed.length > 0) {
    return 'contradictory statements (affirmation vs negation across sources)';
  }

  const distinctUnits = new Set(
    values
      .map((v) => String(v ?? '').match(/\b(gb|mb|ghz|mhz|watt|°c|℃|fps|nm|kg)\b/i)?.[1]?.toLowerCase() ?? '')
      .filter(Boolean),
  );
  if (distinctUnits.size > 1) return 'possible unit mismatch across sources';

  return 'contradictory statements across sources';
}

export function detectConflicts(facts: FactInput[]): Conflict[] {
  const conflicts: Conflict[] = [];
  if (!facts || facts.length === 0) return conflicts;

  const byClaim = new Map<string, FactInput[]>();
  for (const f of facts) {
    const key = normClaim(f.claim);
    if (!key) continue;
    const list = byClaim.get(key) ?? [];
    list.push(f);
    byClaim.set(key, list);
  }

  for (const [key, group] of byClaim.entries()) {
    if (group.length < 2) continue;

    const distinctValues = Array.from(new Set(group.map((f) => String(f.value ?? '').trim())));
    if (distinctValues.length < 2) continue;

    conflicts.push({
      factIds: group.map((f) => f.id),
      claim: key,
      values: distinctValues,
      possibleReason: detectReason(distinctValues),
    });
  }

  return conflicts;
}

export async function recordConflict(factId: string, conflict: Conflict): Promise<void> {
  const fact = await prismaKnowledge.knowledgeFact.findUnique({ where: { id: factId } });
  if (!fact) return;

  await prismaKnowledge.knowledgeFact.update({
    where: { id: factId },
    data: { verificationStatus: 'CONFLICTED' },
  });

  // Also flag sibling facts of the same conflict so they are visible in one pass
  const siblingIds = (conflict.factIds ?? []).filter((id) => id && id !== factId);
  if (siblingIds.length > 0) {
    await prismaKnowledge.knowledgeFact.updateMany({
      where: { id: { in: siblingIds }, verificationStatus: { not: 'CONFLICTED' } },
      data: { verificationStatus: 'CONFLICTED' },
    });
  }

  console.warn(
    `[ConflictDetection] fact ${factId} marked CONFLICTED: "${conflict.claim}" — ${conflict.possibleReason}`,
  );
}
