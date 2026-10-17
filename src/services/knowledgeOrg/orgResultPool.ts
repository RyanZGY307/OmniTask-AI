// ================================================================
// Result Pool — collect worker proposals, cross-worker conflict check,
// unified merge. Rules: consistent -> accept; coexistable -> keep both;
// conflicting -> do not force; uncertain -> keep original structure.
// ================================================================

import type { OrgProposal, WorkerResult } from './orgWorkers';

export interface MergedPlan {
  accepted: OrgProposal[];
  rejected: Array<{ proposal: OrgProposal; reason: string }>;
  conflicts: Array<{ type: string; detail: string; proposals: OrgProposal[] }>;
}

const WRITE_CONFLICT_ACTIONS = new Set([
  'MERGE_FACT', 'SPLIT_FACT', 'MOVE_FACT', 'SET_VARIANT', 'SET_VERSION',
  'MARK_LIFECYCLE', 'MERGE_OBJECT', 'MOVE_CATEGORY',
]);

function sameTarget(a: OrgProposal, b: OrgProposal): boolean {
  return a.targetId === b.targetId && a.targetType === b.targetType;
}

function proposalsEquivalent(a: OrgProposal, b: OrgProposal): boolean {
  return sameTarget(a, b)
    && a.action === b.action
    && JSON.stringify(a.payload ?? {}) === JSON.stringify(b.payload ?? {});
}

/**
 * Merge all worker results into a single plan.
 * - Identical proposals from multiple workers: deduplicated, accepted once.
 * - Same target with different outcomes: conflict. Resolvable only when one
 *   side is a strict duplicate-mark whose payload agrees; otherwise rejected
 *   (keep original structure).
 * - Semantic-duplicate merge pairs must agree on direction; contradictory
 *   direction (A->B vs B->A) is rejected as unresolvable.
 */
export function mergeResults(results: WorkerResult[]): MergedPlan {
  const all: OrgProposal[] = results.flatMap((r) => r.proposals ?? []);
  const accepted: OrgProposal[] = [];
  const rejected: MergedPlan['rejected'] = [];
  const conflicts: MergedPlan['conflicts'] = [];

  // Group by target
  const byTarget = new Map<string, OrgProposal[]>();
  for (const p of all) {
    const key = `${p.targetType}:${p.targetId}`;
    const list = byTarget.get(key) ?? [];
    list.push(p);
    byTarget.set(key, list);
  }

  for (const [, group] of byTarget) {
    if (group.length === 1) {
      accepted.push(group[0]);
      continue;
    }

    // Deduplicate equivalent proposals
    const unique: OrgProposal[] = [];
    for (const p of group) {
      if (!unique.some((u) => proposalsEquivalent(u, p))) unique.push(p);
    }
    if (unique.length === 1) {
      accepted.push(unique[0]);
      continue;
    }

    // Same action MARK_LIFECYCLE to DUPLICATE with same mergedInto: equivalent
    const lifecycleTargets = unique.filter((p) => p.action === 'MARK_LIFECYCLE');
    if (lifecycleTargets.length === unique.length) {
      const mergedIntos = new Set(lifecycleTargets.map((p) => String(p.payload?.mergedInto ?? '')));
      if (mergedIntos.size === 1) {
        accepted.push(lifecycleTargets[0]);
        continue;
      }
      // Different merge targets (e.g., A->B and A->C): unresolvable, reject all
      conflicts.push({
        type: 'MERGE_TARGET_CONFLICT',
        detail: `target ${group[0].targetId} has conflicting merge directions: ${[...mergedIntos].join(', ')}`,
        proposals: unique,
      });
      for (const p of unique) rejected.push({ proposal: p, reason: 'conflicting merge direction across workers' });
      continue;
    }

    // Any write-conflicting different actions on the same target: reject all
    const hasWriteConflict = unique.some((p) => WRITE_CONFLICT_ACTIONS.has(p.action))
      && new Set(unique.map((p) => `${p.action}:${JSON.stringify(p.payload ?? {})}`)).size > 1;
    if (hasWriteConflict) {
      conflicts.push({
        type: 'WRITE_CONFLICT',
        detail: `multiple workers propose different modifications for ${group[0].targetType} ${group[0].targetId}`,
        proposals: unique,
      });
      for (const p of unique) rejected.push({ proposal: p, reason: 'cross-worker write conflict; original structure preserved' });
      continue;
    }

    // Coexistable (read-only ops like RELINK_EVIDENCE on same evidence with different facts): keep all
    accepted.push(...unique);
  }

  // Guard: never accept proposals that create new knowledge
  for (const p of accepted) {
    if (p.action === 'CREATE_FACT' || p.action === 'CREATE_EVIDENCE' || p.action === 'CREATE_SOURCE') {
      const idx = accepted.indexOf(p);
      if (idx >= 0) accepted.splice(idx, 1);
      rejected.push({ proposal: p, reason: 'boundary violation: Self-Organization must not create new knowledge' });
    }
  }

  return { accepted, rejected, conflicts };
}
