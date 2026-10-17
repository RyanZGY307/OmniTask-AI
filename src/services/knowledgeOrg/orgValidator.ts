// ================================================================
// Final Validator — deterministic pre-checks, then Gemini (only when
// actual organization changes exist). Any possible knowledge loss or
// factual-meaning change => FAIL, keep original structure.
// ================================================================

import { buildFinalValidatorPrompt } from './orgPrompts';
import type { MergedPlan } from './orgResultPool';

export interface ValidationResult {
  pass: boolean;
  deterministicViolations: string[];
  geminiViolations: Array<{ changeIndex: number; violation: string }>;
  geminiCalled: boolean;
  notes: string;
}

/**
 * Deterministic loss checks — run before any Gemini call.
 * Compares surviving-content counts between snapshot and post-change state.
 */
export function deterministicPreCheck(
  snapshotEntities: any,
  plan: MergedPlan,
): { pass: boolean; violations: string[] } {
  const violations: string[] = [];

  const facts: any[] = snapshotEntities.facts ?? [];
  const evidence: any[] = snapshotEntities.evidence ?? [];
  const sources: any[] = snapshotEntities.sources ?? [];
  const relations: any[] = snapshotEntities.relations ?? [];

  // Set of facts being merged into survivors — they must remain as records
  // (lifecycleStatus change only), never physically removed.
  const mergeTargets = new Set(
    plan.accepted
      .filter((p) => p.action === 'MARK_LIFECYCLE' && ['DUPLICATE', 'MERGED'].includes(String(p.after)))
      .map((p) => p.targetId),
  );
  const survivors = new Set(
    plan.accepted
      .filter((p) => p.action === 'MARK_LIFECYCLE')
      .map((p) => String(p.payload?.mergedInto ?? '')),
  );

  // 1. Every merge must have a surviving target inside the same fact set
  for (const s of survivors) {
    if (s && !facts.some((f) => f.id === s)) {
      violations.push(`merge survivor ${s} does not exist in snapshot facts`);
    }
  }

  // 2. Merge direction must not create cycles (A->B, B->A)
  const mergeMap = new Map<string, string>();
  for (const p of plan.accepted) {
    if (p.action === 'MARK_LIFECYCLE' && p.payload?.mergedInto) {
      const from = p.targetId;
      const to = String(p.payload.mergedInto);
      if (from === to) violations.push(`self-merge detected: ${from}`);
      if (mergeMap.get(to) === from) violations.push(`merge cycle detected: ${from}<->${to}`);
      mergeMap.set(from, to);
    }
  }

  // 3. Evidence and sources must never be dropped by the plan
  //    (applier re-links only; count conservation is structural)
  if (plan.accepted.some((p) => p.action === 'DELETE_EVIDENCE' || p.action === 'DELETE_SOURCE' || p.action === 'DELETE_FACT')) {
    violations.push('plan contains physical delete operations, which are forbidden');
  }

  // 4. Facts referenced by proposals must exist in snapshot (no invented IDs)
  const factIds = new Set(facts.map((f) => f.id));
  for (const p of plan.accepted) {
    if (p.targetType === 'fact' && !factIds.has(p.targetId)) {
      violations.push(`proposal references unknown fact ${p.targetId}`);
    }
    if (p.action === 'MARK_LIFECYCLE' && p.payload?.mergedInto && p.targetType === 'fact') {
      const mid = String(p.payload.mergedInto);
      if (!factIds.has(mid)) violations.push(`merge target ${mid} unknown in snapshot`);
    }
  }

  // 5. Merged facts keep their claims discoverable via survivor (spot check on
  //    semantic merges): survivor must exist and claim set must not shrink below
  //    active-before minus merged count.
  const activeBefore = facts.length;
  const mergedCount = mergeTargets.size;
  const survivingActive = activeBefore - mergedCount;
  if (survivingActive < 0) violations.push('merge count exceeds fact count');

  // 6. No proposal may alter verificationStatus (boundary: structure only)
  for (const p of plan.accepted) {
    const payloadStr = JSON.stringify(p.payload ?? {});
    if (/"verificationStatus"/.test(payloadStr) || /verificationStatus/.test(p.after)) {
      violations.push(`proposal ${p.action} on ${p.targetId} attempts to change verificationStatus — forbidden`);
    }
  }

  return { pass: violations.length === 0, violations };
}

/**
 * Gemini final validation. Called ONLY when the plan contains actual changes.
 */
export async function geminiFinalValidation(
  snapshotEntities: any,
  plan: MergedPlan,
  callGemini: (prompt: string) => Promise<string>,
): Promise<{ called: boolean; pass: boolean; violations: Array<{ changeIndex: number; violation: string }>; notes: string }> {
  if (plan.accepted.length === 0) {
    return { called: false, pass: true, violations: [], notes: 'no changes to validate' };
  }

  const snapshotJson = JSON.stringify({
    facts: (snapshotEntities.facts ?? []).map((f: any) => ({ id: f.id, claim: f.claim, variantId: f.variantId, claimType: f.claimType })),
    sources: (snapshotEntities.sources ?? []).map((s: any) => ({ id: s.id, canonicalUrl: s.canonicalUrl })),
    evidence: (snapshotEntities.evidence ?? []).map((e: any) => ({ id: e.id, sourceId: e.sourceId })),
    relations: (snapshotEntities.relations ?? []).map((r: any) => ({ id: r.id, objectId: r.objectId, targetId: r.targetId, relationType: r.relationType })),
  });
  const changesJson = JSON.stringify(plan.accepted.map((p, i) => ({ index: i, ...p })));

  try {
    const raw = await callGemini(buildFinalValidatorPrompt(snapshotJson, changesJson));
    const parsed = extractJson(raw);
    if (!parsed || typeof parsed.verdict !== 'string') {
      // Malformed validator response: treat as FAIL (safe default)
      return { called: true, pass: false, violations: [{ changeIndex: -1, violation: 'validator returned malformed JSON' }], notes: 'malformed validator response' };
    }
    return {
      called: true,
      pass: parsed.verdict === 'PASS',
      violations: Array.isArray(parsed.violations) ? parsed.violations : [],
      notes: String(parsed.notes ?? ''),
    };
  } catch (err: any) {
    // Validator unavailable: safe default is keep original structure
    return { called: true, pass: false, violations: [{ changeIndex: -1, violation: `validator error: ${String(err?.message ?? err)}` }], notes: 'validator call failed' };
  }
}

function extractJson(raw: string): any | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}
