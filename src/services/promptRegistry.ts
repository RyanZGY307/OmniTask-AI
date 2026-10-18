// ================================================================
// Prompt Registry — CRUD + version management for Prompt Atoms
// ================================================================

import { prismaKnowledge } from './db';

export type AtomStatus = 'draft' | 'validated' | 'published' | 'disabled' | 'archived';
export type AtomCategory = 'core' | 'task' | 'research' | 'knowledge' | 'verification' | 'output' | 'scenario' | 'domain' | 'skill' | 'agent';

export interface PromptAtomInput {
  id: string;
  category: AtomCategory;
  purpose: string;
  priority: number;
  requires?: string[];
  conflicts_with?: string[];
  compatible_with?: string[];
  conditions?: Record<string, any>;
  parent?: string | null;
  extends?: string[];
  override?: string | null;
  status?: AtomStatus;
  version?: string;
  tags?: string[];
  deprecated_by?: string | null;
}

export interface AtomVersionInput {
  atomId: string;
  version: string;
  instruction: string;
  metadata?: Record<string, any>;
  created_by?: string | null;
}

interface DefaultPromptAtomSeed {
  id: string;
  purpose: string;
  priority: number;
  instruction: string;
}

// ================================================================
// Metadata decoding helpers
//
// The PromptAtom model stores every collection field as a JSON string that
// defaults to "". The dependency/conflict resolvers read these off the
// snapshot returned by getActiveVersions(), so they must be decoded HERE —
// otherwise each resolver sees "" (or, for a naive `|| []`, still a
// malformed empty string) and silently treats every atom as having no
// requires / conflicts_with / parent / extends at all.
//
// Fail-closed rules, matching parseAtomList():
//   - "" / null / undefined / non-string -> []
//   - a value that OPENS like JSON but fails to parse -> []
//     (a truncated array must never become phantom ids)
//   - otherwise legacy comma-separated ids are accepted
//   - entries are trimmed, non-strings dropped, duplicates removed
// ================================================================

export function parseMetadataList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return [...new Set(raw.filter((v): v is string => typeof v === 'string').map((s) => s.trim()).filter(Boolean))];
  }
  if (typeof raw !== 'string') return [];
  const text = raw.trim();
  if (!text) return [];
  const looksLikeJson = text[0] === '[' || text[0] === '{' || text[0] === '"';
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.filter((v): v is string => typeof v === 'string').map((s) => s.trim()).filter(Boolean))];
    }
    return looksLikeJson ? [] : [text];
  } catch {
    // JSON-ish parse failure fails closed; a plain legacy string is still
    // accepted as a comma-separated id list.
    return looksLikeJson ? [] : text.split(',').map((s) => s.trim()).filter(Boolean);
  }
}

function parseMetadataObject(raw: unknown): Record<string, any> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Small, deterministic baseline atoms referenced by the default scenarios and
// local task classifier. Seeded only when the ID is absent; admin-authored
// atoms are never overwritten by a deployment startup.
const DEFAULT_PROMPT_ATOM_SEEDS: DefaultPromptAtomSeed[] = [
  {
    id: 'task.data_analysis',
    purpose: 'Analyze supplied data with explicit methods, evidence, and caveats.',
    priority: 75,
    instruction: 'For data-analysis requests, first identify the available fields, units, scope, and data limitations. Base conclusions only on supplied or verifiable data; do not invent measurements. Show the method or comparison used, distinguish observation from interpretation, call out missing or anomalous values, and present the result in a structure suited to the question.',
  },
  {
    id: 'task.anomaly_detection',
    purpose: 'Identify and explain potential anomalies without overclaiming.',
    priority: 80,
    instruction: 'For anomaly-detection requests, establish the relevant baseline or comparison group before labeling a value anomalous. Separate unusual observations from confirmed errors, state the detection criteria and uncertainty, and do not infer causes from an outlier alone. Ask for the data or schema when it is not available.',
  },
  {
    id: 'task.explanation',
    purpose: 'Explain concepts clearly at the depth appropriate to the request.',
    priority: 70,
    instruction: 'For explanation requests, answer the central question directly, then build the explanation in a clear sequence from the user’s apparent context. Define necessary terms, use a concrete example when it improves understanding, and distinguish established facts from assumptions or uncertainty. Do not add unrelated detail.',
  },
  {
    id: 'task.creative',
    purpose: 'Generate original creative material while honoring user constraints.',
    priority: 65,
    instruction: 'For creative requests, identify and follow the user’s constraints on purpose, audience, tone, format, length, and required elements. Produce coherent, specific, original material rather than generic filler. Where constraints conflict, prioritize explicit requirements and briefly surface any unavoidable trade-off.',
  },
];

/**
 * Idempotently seed the minimal built-in Prompt Atom baseline at startup.
 * Each atom and its first published version are created in one transaction;
 * existing rows (including disabled or admin-customized rows) are left alone.
 * Returns IDs created by this invocation.
 */
export async function seedDefaultPromptAtoms(): Promise<string[]> {
  const created: string[] = [];
  for (const seed of DEFAULT_PROMPT_ATOM_SEEDS) {
    try {
      const didCreate = await prismaKnowledge.$transaction(async (tx) => {
        const existing = await tx.promptAtom.findUnique({ where: { id: seed.id }, select: { id: true } });
        if (existing) return false;

        await tx.promptAtom.create({
          data: {
            id: seed.id,
            category: 'task',
            purpose: seed.purpose,
            priority: seed.priority,
            requires: '[]',
            conflicts_with: '[]',
            compatible_with: '[]',
            extends: '[]',
            status: 'published',
            version: '1.0.0',
            tags: JSON.stringify(['builtin', 'seed']),
          },
        });
        await tx.promptAtomVersion.create({
          data: {
            atomId: seed.id,
            version: '1.0.0',
            instruction: seed.instruction,
            metadata: JSON.stringify({ origin: 'builtin_seed' }),
            status: 'published',
            published_at: new Date(),
            created_by: 'system-seed',
          },
        });
        return true;
      });
      if (didCreate) created.push(seed.id);
    } catch (error: any) {
      // Another server replica may win the unique-ID race during deployment.
      if (error?.code !== 'P2002') throw error;
    }
  }
  if (created.length > 0) invalidateActiveVersions();
  return created;
}

export async function upsertAtom(input: PromptAtomInput): Promise<{ id: string; status: string }> {
  const { requires = [], conflicts_with = [], compatible_with = [], extends: extends_ = [], tags = [] } = input;
  const result = await prismaKnowledge.promptAtom.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      category: input.category,
      purpose: input.purpose,
      priority: input.priority,
      requires: JSON.stringify(requires),
      conflicts_with: JSON.stringify(conflicts_with),
      compatible_with: JSON.stringify(compatible_with),
      conditions: input.conditions ? JSON.stringify(input.conditions) : undefined,
      parent: input.parent,
      extends: JSON.stringify(extends_),
      override: input.override,
      status: input.status || 'draft',
      version: input.version || '1.0.0',
      tags: JSON.stringify(tags),
      deprecated_by: input.deprecated_by,
    },
    update: {
      category: input.category,
      purpose: input.purpose,
      priority: input.priority,
      requires: JSON.stringify(requires),
      conflicts_with: JSON.stringify(conflicts_with),
      compatible_with: JSON.stringify(compatible_with),
      conditions: input.conditions ? JSON.stringify(input.conditions) : undefined,
      parent: input.parent,
      extends: JSON.stringify(extends_),
      override: input.override,
      status: input.status || undefined,
      version: input.version || undefined,
      tags: JSON.stringify(tags),
      deprecated_by: input.deprecated_by,
    },
  });
  invalidateActiveVersions();
  return { id: result.id, status: result.status };
}

export async function createAtomVersion(input: AtomVersionInput): Promise<string> {
  const version = await prismaKnowledge.promptAtomVersion.create({
    data: {
      atomId: input.atomId,
      version: input.version,
      instruction: input.instruction,
      metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
      created_by: input.created_by,
      published_at: input.metadata?.published ? new Date() : undefined,
    },
  });
  invalidateActiveVersions();
  return version.id;
}

export async function publishAtomVersion(atomId: string, version: string, createdBy?: string): Promise<void> {
  await prismaKnowledge.promptAtomVersion.updateMany({
    where: { atomId, status: 'published' },
    data: { status: 'superseded' },
  });
  await prismaKnowledge.promptAtomVersion.update({
    where: { atomId_version: { atomId, version } },
    data: { status: 'published', published_at: new Date(), created_by: createdBy || null },
  });
  await prismaKnowledge.promptAtom.update({
    where: { id: atomId },
    data: { version, status: 'published', updatedAt: new Date() },
  });
  invalidateActiveVersions();
}

export async function getPublishedAtom(id: string): Promise<any | null> {
  return prismaKnowledge.promptAtom.findUnique({
    where: { id, status: 'published' },
    include: { versions: { where: { status: 'published' }, take: 1, orderBy: { created_at: 'desc' } } },
  });
}

export async function getAllPublishedAtoms(category?: string): Promise<any[]> {
  const where: any = { status: 'published' };
  if (category) where.category = category;
  return prismaKnowledge.promptAtom.findMany({ where, orderBy: { priority: 'desc' }, include: { versions: { where: { status: 'published' }, take: 1 } } });
}

export async function getAtomVersions(atomId: string): Promise<any[]> {
  return prismaKnowledge.promptAtomVersion.findMany({ where: { atomId }, orderBy: { created_at: 'desc' } });
}

export async function setAtomStatus(atomId: string, status: AtomStatus): Promise<void> {
  await prismaKnowledge.promptAtom.update({ where: { id: atomId }, data: { status } });
  invalidateActiveVersions();
}

// ================================================================
// Active-version snapshot cache
//
// composePrompt() runs on every chat request, so getActiveVersions() is a
// per-request read of the whole published-atom set. The snapshot is cached
// in-process with a short TTL and is explicitly invalidated by every
// mutation in this module. TTL bounds staleness for out-of-process
// writers; the hooks make in-process publish/disable visible immediately.
//
// Safety: this cache only ever mirrors the DB — it is never consulted to
// skip a permission / compatibility / status check. A stale entry can only
// omit a freshly published atom (which fails closed to base capability),
// never admit a disabled one, because disabled atoms are absent from the
// query itself and every mutation drops the snapshot.
// ================================================================

export interface ActiveVersionEntry {
  version: string;
  instruction: string;
  category: string;
  priority: number;
  // Decoded atom metadata. The dependency + conflict resolvers need these to
  // actually resolve dependencies or detect conflicts; without them both
  // resolvers degrade to "atom exists / atom is missing" only.
  requires: string[];
  conflicts_with: string[];
  compatible_with: string[];
  extends: string[];
  parent: string | null;
  tags: string[];
  conditions: Record<string, any>;
}

const ACTIVE_VERSIONS_TTL_MS = Number(process.env.CORTX_ATOM_CACHE_TTL_MS ?? 30_000);

let activeVersionsCache: { at: number; value: Record<string, ActiveVersionEntry> } | null = null;
let activeVersionEpoch = 0;

/** Drop the cached snapshot. Called by every atom/version mutation. */
export function invalidateActiveVersions(): void {
  activeVersionsCache = null;
  activeVersionEpoch += 1;
}

/** Monotonic counter bumped on every invalidation. */
export function getActiveVersionsEpoch(): number {
  return activeVersionEpoch;
}

export async function getActiveVersions(opts?: { force?: boolean }): Promise<Record<string, ActiveVersionEntry>> {
  const now = Date.now();
  if (!opts?.force && activeVersionsCache && now - activeVersionsCache.at < ACTIVE_VERSIONS_TTL_MS) {
    return activeVersionsCache.value;
  }

  const atoms = await prismaKnowledge.promptAtom.findMany({
    where: { status: 'published' },
    include: { versions: { where: { status: 'published' }, take: 1, orderBy: { created_at: 'desc' } } },
  });
  const out: Record<string, ActiveVersionEntry> = {};
  for (const a of atoms as any[]) {
    const v = a.versions?.[0];
    if (!v) continue;
    out[a.id] = {
      version: v.version,
      instruction: v.instruction,
      // category + priority were previously dropped here, so composePrompt's
      // grouping fell back to 'core' for every atom, collapsing the whole
      // [SYSTEM]/[TASK]/[KNOWLEDGE] section layout into one group.
      category: a.category || 'core',
      priority: typeof a.priority === 'number' ? a.priority : 0,
      requires: parseMetadataList(a.requires),
      conflicts_with: parseMetadataList(a.conflicts_with),
      compatible_with: parseMetadataList(a.compatible_with),
      extends: parseMetadataList(a.extends),
      parent: a.parent ?? null,
      tags: parseMetadataList(a.tags),
      conditions: parseMetadataObject(a.conditions),
    };
  }

  activeVersionsCache = { at: now, value: out };
  return out;
}

/** Ops/test hook: inspect cache state without touching the DB. */
export function getActiveVersionsCacheStats(): { cached: boolean; ageMs: number | null; epoch: number; size: number } {
  return {
    cached: activeVersionsCache !== null,
    ageMs: activeVersionsCache ? Date.now() - activeVersionsCache.at : null,
    epoch: activeVersionEpoch,
    size: activeVersionsCache ? Object.keys(activeVersionsCache.value).length : 0,
  };
}

export async function compareVersions(atomId: string, v1: string, v2: string): Promise<{ v1: any; v2: any }> {
  const [a, b] = await Promise.all([
    prismaKnowledge.promptAtomVersion.findUnique({ where: { atomId_version: { atomId, version: v1 } } }),
    prismaKnowledge.promptAtomVersion.findUnique({ where: { atomId_version: { atomId, version: v2 } } }),
  ]);
  return { v1: a, v2: b };
}
