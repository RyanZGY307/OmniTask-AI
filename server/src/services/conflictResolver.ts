// ================================================================
// Conflict Resolver — detects and resolves conflicts between atoms
// ================================================================

import { getActiveVersions } from './promptRegistry';

export interface ConflictResult {
  conflicts: Array<{ atom: string; conflict_with: string; resolution: string }>;
  final_atoms: string[];
}

export async function resolveConflicts(atomIds: string[]): Promise<ConflictResult> {
  const versions = await getActiveVersions();
  const conflicts: Array<{ atom: string; conflict_with: string; resolution: string }> = [];
  const kept = new Set<string>();
  const priorityMap = new Map<string, number>();

  for (const id of atomIds) {
    const atom = versions[id];
    if (atom) priorityMap.set(id, (atom as any).priority || 50);
  }

  for (let i = 0; i < atomIds.length; i++) {
    const id = atomIds[i];
    const atom = versions[id];
    if (!atom) continue;

    let conflictFound = false;
    for (const conflictId of (atom as any).conflicts_with || []) {
      if (kept.has(conflictId)) {
        const conflictAtom = versions[conflictId];
        const idPriority = priorityMap.get(id) || 50;
        const conflictPriority = conflictAtom ? ((conflictAtom as any).priority || 50) : 50;

        if (idPriority >= conflictPriority) {
          // New atom wins
          conflicts.push({ atom: id, conflict_with: conflictId, resolution: `higher_priority(${idPriority}>=${conflictPriority})` });
          kept.delete(conflictId);
          kept.add(id);
        } else {
          // Existing atom wins
          conflicts.push({ atom: id, conflict_with: conflictId, resolution: `existing_priority(${conflictPriority}>${idPriority})` });
          conflictFound = true;
        }
        break;
      }
    }
    if (!conflictFound) kept.add(id);
  }

  return { conflicts, final_atoms: [...kept] };
}
