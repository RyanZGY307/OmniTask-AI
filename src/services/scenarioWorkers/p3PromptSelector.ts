// ================================================================
// P3 Prompt Selector — evaluates candidate Atoms (≤20) against the
// resolved scenario. Output is AI candidates + two-stage rule selection
// (hard gate first, then Exploit/Explore). No global quality score.
// ================================================================

import { callAgnes, parseWorkerJson } from './agnesCaller';
import { P3_SYSTEM } from './prompts';

export interface CandidateAtom {
  atom: { id: string; version: string; category: string; content?: string };
  compat: {
    experiment_count: number;
    unique_user_count: number;
    correction_count: number;
    success_rate: number;
    lifecycle: string;
  } | null;
}

export type FitLevel = 'high_fit' | 'medium_fit' | 'experimental_fit' | 'low_fit' | 'reject';

export interface P3Result {
  candidates: Array<{
    atom_id: string;
    fit_level: FitLevel;
    compatibility_estimate: number;
    reason_codes: string[];
    experiment_value: number;
  }>;
  selected_atom_ids: string[];
  experimental_atom_ids: string[];
  no_suitable_prompt: boolean;
  degraded?: boolean;
}

export async function runP3(
  scenario: { id: string; name: string; category: string },
  atoms: CandidateAtom[],
): Promise<P3Result> {
  try {
    const raw = await callAgnes(
      P3_SYSTEM,
      JSON.stringify({ scenario, atoms: atoms.map((a) => ({ atom: a.atom, compat: a.compat })) }),
      { model: 'Agnes-3.0-flash', temperature: 0.1, maxTokens: 3072, timeoutMs: 15000 },
    );
    const FIT: FitLevel[] = ['high_fit', 'medium_fit', 'experimental_fit', 'low_fit', 'reject'];
    const parsed = parseWorkerJson(raw, { fit_level: FIT } as any);
    if (!parsed?.candidates) throw new Error('P3 missing candidates');
    const candidates = (parsed.candidates as any[])
      .filter((c) => c && c.atom_id && FIT.includes(c.fit_level))
      .map((c) => ({
        atom_id: String(c.atom_id),
        fit_level: c.fit_level as FitLevel,
        compatibility_estimate: typeof c.compatibility_estimate === 'number' ? c.compatibility_estimate : 0.5,
        reason_codes: Array.isArray(c.reason_codes) ? c.reason_codes.map(String) : [],
        experiment_value: typeof c.experiment_value === 'number' ? c.experiment_value : 0,
      }));
    return {
      candidates,
      selected_atom_ids: Array.isArray(parsed.selected_atom_ids) ? parsed.selected_atom_ids.map(String) : [],
      experimental_atom_ids: Array.isArray(parsed.experimental_atom_ids) ? parsed.experimental_atom_ids.map(String) : [],
      no_suitable_prompt: !!parsed.no_suitable_prompt,
    };
  } catch (err: any) {
    // Degraded: raw retrieval output, no AI weighting.
    console.warn(`[P3] degraded: ${err?.message}`);
    return {
      candidates: atoms.slice(0, 4).map((a) => ({
        atom_id: a.atom.id,
        fit_level: 'medium_fit' as FitLevel,
        compatibility_estimate: 0.5,
        reason_codes: ['rule_retrieval_fallback'],
        experiment_value: 0,
      })),
      selected_atom_ids: atoms.slice(0, 1).map((a) => a.atom.id),
      experimental_atom_ids: [],
      no_suitable_prompt: atoms.length === 0,
      degraded: true,
    };
  }
}

// Rule layer stage 1: hard gate. Filter out reject / low_fit / version-invalid /
// permission-denied / category-conflicting atoms. Safety/privacy atoms are
// never delta-modified (rule whitelist, hardcoded).
export function p3HardGate(candidates: P3Result['candidates'], atoms: CandidateAtom[]): P3Result['candidates'] {
  const atomById = new Map(atoms.map((a) => [a.atom.id, a]));
  return candidates.filter((c) => {
    if (c.fit_level === 'reject' || c.fit_level === 'low_fit') return false;
    const atom = atomById.get(c.atom_id);
    if (!atom) return false;
    // safety/privacy atoms are never delta-modified by P3
    const cat = atom.atom.category?.toLowerCase();
    if (cat === 'safety' || cat === 'privacy' || c.atom_id === 'core.truth_standard') return false;
    return true;
  });
}

// Rule layer stage 2: Exploit / Explore.
// - Exploit: high_fit && unique_user_count >= 5 && correction_rate below threshold
// - Explore: experimental_fit (or medium_fit with insufficient samples), max K (default 1)
export function p3ExploitExplore(
  candidates: P3Result['candidates'],
  atoms: CandidateAtom[],
  opts: { exploitMinUsers?: number; correctionThreshold?: number; exploreLimit?: number } = {},
): { exploit: P3Result['candidates']; explore: P3Result['candidates'] } {
  const { exploitMinUsers = 5, correctionThreshold = 0.3, exploreLimit = 1 } = opts;
  const atomById = new Map(atoms.map((a) => [a.atom.id, a]));
  const exploit: P3Result['candidates'] = [];
  const explore: P3Result['candidates'] = [];
  for (const c of candidates) {
    const compat = atomById.get(c.atom_id)?.compat;
    const total = compat?.experiment_count ?? 0;
    const corrRate = total > 0 ? (compat?.correction_count ?? 0) / total : 0;
    if (c.fit_level === 'high_fit' && (compat?.unique_user_count ?? 0) >= exploitMinUsers && corrRate < correctionThreshold) {
      exploit.push(c);
    } else if (c.fit_level === 'experimental_fit' || (c.fit_level === 'medium_fit' && total < exploitMinUsers)) {
      if (explore.length < exploreLimit) explore.push(c);
    }
  }
  return { exploit, explore };
}
