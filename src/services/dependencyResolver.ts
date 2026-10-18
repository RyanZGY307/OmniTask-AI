// ================================================================
// Dependency Resolver — resolves requires, parent, extends, override
// ================================================================

import { getActiveVersions } from './promptRegistry';
import type { ActiveVersionEntry } from './promptRegistry';

export interface DependencyResult {
  resolved_atoms: string[];
  removed_atoms: string[];
  conflicts: Array<{ atom: string; reason: string }>;
  missing_deps: string[];
}

// `versions` is an optional pre-fetched snapshot from `getActiveVersions()`.
// Passing it avoids a redundant DB query per request (todo 3).
export async function resolveDependencies(
  atomIds: string[],
  versions?: Record<string, ActiveVersionEntry>,
): Promise<DependencyResult> {
  const vs = versions ?? (await getActiveVersions());
  const resolved = new Set<string>();
  const removed = new Set<string>();
  const conflicts: Array<{ atom: string; reason: string }> = [];
  const missingDeps: string[] = [];
  const visited = new Set<string>();

  async function resolve(id: string): Promise<void> {
    if (visited.has(id)) return;
    visited.add(id);

    const atom = vs[id];
    if (!atom) {
      missingDeps.push(id);
      return;
    }

    // Check conflicts
    for (const conflictId of atom.conflicts_with ?? []) {
      if (resolved.has(conflictId)) {
        conflicts.push({ atom: id, reason: `conflicts_with ${conflictId}` });
        removed.add(id);
        return;
      }
    }

    // Resolve requires (dependencies)
    for (const dep of atom.requires ?? []) {
      if (dep !== id && !resolved.has(dep)) {
        await resolve(dep);
        if (missingDeps.includes(dep)) {
          conflicts.push({ atom: id, reason: `missing dependency: ${dep}` });
          removed.add(id);
          return;
        }
      }
    }

    // Resolve parent
    const parentId = atom.parent;
    if (parentId && parentId !== id && !resolved.has(parentId)) {
      await resolve(parentId);
      if (missingDeps.includes(parentId)) {
        conflicts.push({ atom: id, reason: `missing parent: ${parentId}` });
        removed.add(id);
        return;
      }
    }

    // Resolve extends
    for (const extId of atom.extends ?? []) {
      if (extId !== id && !resolved.has(extId)) {
        await resolve(extId);
      }
    }

    resolved.add(id);
  }

  for (const id of atomIds) {
    await resolve(id);
  }

  return {
    resolved_atoms: [...resolved],
    removed_atoms: [...removed],
    conflicts,
    missing_deps: [...new Set(missingDeps)],
  };
}
