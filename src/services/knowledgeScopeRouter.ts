// ================================================================
// Knowledge Scope Router — pre-retrieval knowledge domain selection
// ================================================================
// Decides WHICH knowledge scopes to search FIRST before running the
// Knowledge Runtime. It is intentionally a lightweight, rule+metadata
// layer (no LLM call) that narrows the candidate set:
//
//   TaskClassifier → Knowledge Scope Router → Knowledge Runtime
//
// It does NOT:
//   - replace Skill Auto Selection
//   - replace the model Router
//   - mutate the Knowledge DB (that is the Knowledge Organizer)
//   - call the Research Planner (that runs on insufficiency, later)
//
// Failure of this router must NEVER fail the chat: every consumer is
// expected to fall back to the existing, unscoped Knowledge Runtime.

import { prismaKnowledge } from './db';
import type { TaskClassification } from './taskClassifier';

// ==================== Types ====================

export interface KnowledgeScope {
  /** Scopes to search first (highest relevance). */
  primaryScopes: string[];
  /** Secondary scopes, searched only when primary results are insufficient. */
  secondaryScopes: string[];
  /** Scopes explicitly excluded for this query (e.g. unrelated domains). */
  excludedScopes: string[];
  /** Normalized query variants used to widen/dedupe retrieval. */
  queryVariants: string[];
  /** How deep to retrieve (number of chunks/facts to aim for). */
  retrievalDepth: number;
  /** Whether verification-level evidence must be prioritized. */
  verificationRequired: boolean;
  /** The detected knowledge object/entity id, if any. */
  objectId?: string;
  /** The detected knowledge object canonical name, if any. */
  objectName?: string;
  /** Region the scope is biased toward, if any. */
  region?: string;
}

export interface ScopeInput {
  message: string;
  taskClassification?: TaskClassification;
  taskType?: string;
  domain?: string;
  region?: string;
  needsVerification?: boolean;
}

// ==================== Task type → default scopes ====================
// Reuses the existing KnowledgeCategory.objectType vocabulary; NOT a new
// taxonomy. Only used as a default when no specific entity is detected.

const TASK_TYPE_SCOPES: Record<string, { primary: string[]; secondary: string[]; depth: number }> = {
  coding:      { primary: ['code_bug', 'software'], secondary: ['cs_concept'], depth: 4 },
  research:    { primary: ['software', 'smart_device', 'cs_concept'], secondary: ['science', 'geography', 'history'], depth: 8 },
  analysis:    { primary: ['smart_device', 'science', 'cs_concept'], secondary: ['software'], depth: 6 },
  math:        { primary: ['math_formula'], secondary: ['science'], depth: 4 },
  planning:    { primary: ['general', 'software'], secondary: ['smart_device'], depth: 5 },
  question:    { primary: ['general'], secondary: ['software', 'smart_device', 'science'], depth: 5 },
  writing:     { primary: ['general'], secondary: [], depth: 3 },
  translation: { primary: ['language'], secondary: ['general'], depth: 3 },
  simple_chat: { primary: [], secondary: [], depth: 0 },
  complex:     { primary: ['general', 'software'], secondary: ['smart_device', 'science'], depth: 6 },
};

// Knowledge categories / object types considered "unrelated" to code/tech
// questions; they are excluded to narrow the candidate set.
const TECH_EXCLUDED = ['organism', 'astronomy', 'geography', 'history'];

// ==================== Metadata cache (60s TTL) ====================

interface MetadataCache {
  objectTypes: string[];
  categories: string[];
  timestamp: number;
}

let _metaCache: MetadataCache | null = null;
const META_TTL_MS = 60_000;

async function loadMetadata(): Promise<{ objectTypes: string[]; categories: string[] }> {
  const now = Date.now();
  if (_metaCache && now - _metaCache.timestamp < META_TTL_MS) {
    return { objectTypes: _metaCache.objectTypes, categories: _metaCache.categories };
  }
  try {
    const [objs, cats] = await Promise.all([
      prismaKnowledge.knowledgeObject.findMany({
        where: { status: 'ACTIVE' },
        select: { objectType: true },
        take: 500,
      }),
      prismaKnowledge.knowledgeCategory.findMany({
        select: { name: true },
        take: 500,
      }),
    ]);
    const objectTypes = [...new Set(objs.map(o => o.objectType).filter(Boolean))] as string[];
    const categories = cats.map(c => c.name);
    _metaCache = { objectTypes, categories, timestamp: now };
  } catch {
    // If metadata is unavailable, fall back to whatever is cached (may be
    // stale) or empty — the caller must tolerate an empty scope list.
    if (_metaCache) return { objectTypes: _metaCache.objectTypes, categories: _metaCache.categories };
    _metaCache = { objectTypes: [], categories: [], timestamp: now };
  }
  return { objectTypes: _metaCache.objectTypes, categories: _metaCache.categories };
}

// ==================== Entity detection (lightweight, no LLM) ====================

// Detects a candidate knowledge object by fuzzy-matching the message against
// ACTIVE KnowledgeObject canonical names. Only runs when the message is
// long enough to contain a plausible entity (>= 4 chars).
async function detectObject(message: string): Promise<{ id: string; name: string } | null> {
  const trimmed = message.trim();
  if (trimmed.length < 4) return null;
  try {
    // CJK: match the longest known canonical name that appears as a
    // substring. Latin: word-boundary match on the name or first 2 words.
    const objs = await prismaKnowledge.knowledgeObject.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, canonicalName: true },
      take: 500,
      orderBy: { canonicalName: 'asc' },
    });
    const lower = trimmed.toLowerCase();
    let best: { id: string; name: string; len: number } | null = null;
    for (const o of objs) {
      const name = String(o.canonicalName || '');
      if (!name) continue;
      const needle = name.toLowerCase();
      let hit = false;
      if (needle.length >= 4 && lower.includes(needle)) {
        hit = true;
      } else {
        // Latin short-name fallback: first word boundary match
        const firstWord = needle.split(/\s+/)[0];
        if (firstWord && firstWord.length >= 4 && new RegExp(`\\b${firstWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower)) {
          hit = true;
        }
      }
      if (hit && (!best || name.length > best.len)) {
        best = { id: o.id, name, len: name.length };
      }
    }
    if (best) return { id: best.id, name: best.name };
  } catch {
    // Object detection is best-effort; never fail the router.
  }
  return null;
}

// ==================== Scope router ====================

export async function routeKnowledgeScope(input: ScopeInput): Promise<KnowledgeScope> {
  const { message, taskClassification, taskType, domain, region, needsVerification } = input;

  // Task type: prefer the explicit taskType arg, else the classification.
  const effectiveTaskType = taskType || taskClassification?.taskType || 'question';
  const rule = TASK_TYPE_SCOPES[effectiveTaskType] || TASK_TYPE_SCOPES.question;

  // Detect the specific knowledge object (if any) — this is the strongest
  // scope signal and overrides the task-type default.
  const detected = await detectObject(message);

  // Load real Knowledge DB metadata so we only reference scopes that exist.
  const meta = await loadMetadata();

  // Build primary / secondary from rules + detected entity + explicit domain.
  const primary = new Set<string>(rule.primary);
  const secondary = new Set<string>(rule.secondary);

  if (detected) {
    // Detected object: its objectType + categories become primary scopes.
    const obj = await prismaKnowledge.knowledgeObject.findUnique({
      where: { id: detected.id },
      include: { categories: { include: { category: true } } },
    }).catch(() => null);
    if (obj) {
      if (obj.objectType) primary.add(String(obj.objectType));
      for (const oc of obj.categories || []) {
        const catName = (oc as any).category?.name;
        if (catName) primary.add(String(catName));
      }
    }
  }

  if (domain) primary.add(String(domain));

  // Technical/code questions: exclude unrelated domains to narrow the set.
  const excluded = new Set<string>();
  if (effectiveTaskType === 'coding' || effectiveTaskType === 'math') {
    for (const t of TECH_EXCLUDED) excluded.add(t);
  }

  // Query variants: the raw message plus the detected object name (deduped).
  const variants = [message.trim()];
  if (detected && detected.name && !message.toLowerCase().includes(detected.name.toLowerCase())) {
    variants.push(detected.name);
  }
  variants.push(...variants.slice(0, 2).map(v => v.toLowerCase()));

  // retrievalDepth: explicit domain or research tasks retrieve more.
  let depth = rule.depth;
  if (domain) depth = Math.max(depth, 6);
  if (effectiveTaskType === 'research') depth = Math.max(depth, 8);
  depth = Math.max(0, Math.min(depth, 10));

  return {
    primaryScopes: [...primary].filter(s => !excluded.has(s)),
    secondaryScopes: [...secondary].filter(s => !excluded.has(s) && !primary.has(s)),
    excludedScopes: [...excluded],
    queryVariants: [...new Set(variants)].slice(0, 4),
    retrievalDepth: depth,
    verificationRequired: !!needsVerification || effectiveTaskType === 'research' || effectiveTaskType === 'coding',
    objectId: detected?.id,
    objectName: detected?.name,
    region,
  };
}

// Helper used by tests / callers to validate a scope against real metadata.
export async function validateScope(scope: KnowledgeScope): Promise<KnowledgeScope> {
  const meta = await loadMetadata();
  const valid = new Set([...meta.objectTypes, ...meta.categories]);
  // Keep only scopes that actually exist in the DB; drop unknowns so the
  // retrieval layer can rely on them being real categories/objectTypes.
  if (valid.size === 0) return scope; // metadata unavailable: pass through
  const filter = (list: string[]) => list.filter(s => valid.has(s));
  return {
    ...scope,
    primaryScopes: filter(scope.primaryScopes),
    secondaryScopes: filter(scope.secondaryScopes),
  };
}

export { loadMetadata, detectObject };
