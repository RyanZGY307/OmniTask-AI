// ================================================================
// Organization Snapshot — immutable, write-once
// Small scopes (object/variant/version) -> full dataJson
// Large scopes (category/subtree)        -> manifest of {type,id,hash} + hash
// A snapshot NEVER changes once created; it always represents the
// knowledge base state at organization start.
// ================================================================

import { createHash } from 'crypto';
import { prismaKnowledge } from '../db';

export type OrgScopeType = 'object' | 'variant' | 'version' | 'category' | 'subtree';

const SMALL_SCOPES: OrgScopeType[] = ['object', 'variant', 'version'];
const LARGE_SCOPES: OrgScopeType[] = ['category', 'subtree'];

// Max serialized size for a full snapshot before degrading to manifest (~256KB)
const FULL_SNAPSHOT_LIMIT = 256 * 1024;

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function factHash(f: any): string {
  return sha256(JSON.stringify([f.id, f.claim, f.claimType, f.verificationStatus, f.lifecycleStatus, f.variantId, f.version, f.supersededBy]));
}

interface SnapshotEntities {
  object?: any;
  variants?: any[];
  facts?: any[];
  factEvidence?: any[];
  evidence?: any[];
  sources?: any[];
  relations?: any[];
  categories?: any[];
  objectCategories?: any[];
}

function entityList(e: SnapshotEntities): Array<{ type: string; id: string; hash: string }> {
  const out: Array<{ type: string; id: string; hash: string }> = [];
  if (e.object) out.push({ type: 'object', id: e.object.id, hash: sha256(JSON.stringify(e.object)) });
  for (const v of e.variants ?? []) out.push({ type: 'variant', id: v.id, hash: sha256(JSON.stringify(v)) });
  for (const f of e.facts ?? []) out.push({ type: 'fact', id: f.id, hash: factHash(f) });
  for (const fe of e.factEvidence ?? []) out.push({ type: 'factEvidence', id: `${fe.factId}:${fe.evidenceId}`, hash: sha256(JSON.stringify(fe)) });
  for (const ev of e.evidence ?? []) out.push({ type: 'evidence', id: ev.id, hash: sha256(JSON.stringify(ev)) });
  for (const s of e.sources ?? []) out.push({ type: 'source', id: s.id, hash: sha256(JSON.stringify(s)) });
  for (const r of e.relations ?? []) out.push({ type: 'relation', id: r.id, hash: sha256(JSON.stringify(r)) });
  for (const c of e.categories ?? []) out.push({ type: 'category', id: c.id, hash: sha256(JSON.stringify(c)) });
  for (const oc of e.objectCategories ?? []) out.push({ type: 'objectCategory', id: `${oc.objectId}:${oc.categoryId}`, hash: sha256(JSON.stringify(oc)) });
  return out;
}

async function loadObjectEntities(rootObjectId: string, variantId?: string): Promise<SnapshotEntities> {
  const object = await prismaKnowledge.knowledgeObject.findUnique({
    where: { id: rootObjectId },
    include: { categories: true },
  });
  if (!object) throw new Error(`KnowledgeObject ${rootObjectId} not found`);

  const variantWhere: any = { objectId: rootObjectId };
  if (variantId) variantWhere.id = variantId;

  const variants = await prismaKnowledge.knowledgeVariant.findMany({ where: variantWhere });
  const facts = await prismaKnowledge.knowledgeFact.findMany({
    where: { objectId: rootObjectId, ...(variantId ? { variantId } : {}), lifecycleStatus: 'ACTIVE' },
  });
  const factIds = facts.map((f) => f.id);
  const factEvidence = factIds.length
    ? await prismaKnowledge.knowledgeFactEvidence.findMany({ where: { factId: { in: factIds } } })
    : [];
  const evidenceIds = [...new Set(factEvidence.map((fe) => fe.evidenceId))];
  const evidence = evidenceIds.length
    ? await prismaKnowledge.evidence.findMany({ where: { id: { in: evidenceIds } } })
    : [];
  const sourceIds = [...new Set(evidence.map((e) => e.sourceId))];
  const sources = sourceIds.length
    ? await prismaKnowledge.evidenceSource.findMany({ where: { id: { in: sourceIds } } })
    : [];
  const relations = await prismaKnowledge.knowledgeRelation.findMany({
    where: { OR: [{ objectId: rootObjectId }, { targetId: rootObjectId }] },
  });

  return {
    object,
    variants,
    facts,
    factEvidence,
    evidence,
    sources,
    relations,
    categories: object.categories.map((oc: any) => ({ id: oc.categoryId, primary: oc.primary })),
    objectCategories: object.categories,
  };
}

async function loadCategoryObjectIds(categoryId: string, recursive: boolean): Promise<string[]> {
  const links = await prismaKnowledge.knowledgeObjectCategory.findMany({ where: { categoryId } });
  let objectIds = links.map((l) => l.objectId);

  if (recursive) {
    // subtree: include descendant categories (one level of children via parent link if modeled; fallback: flat)
    const childCats = await prismaKnowledge.knowledgeCategory.findMany({
      where: { OR: [{ parentId: categoryId }] } as any,
      select: { id: true },
    }).catch(() => []);
    for (const child of childCats) {
      const childIds = await loadCategoryObjectIds(child.id, recursive);
      objectIds = objectIds.concat(childIds);
    }
  }
  return [...new Set(objectIds)];
}

export interface BuiltSnapshot {
  id: string;
  hash: string;
  mode: 'full' | 'manifest';
  entities: SnapshotEntities;
}

/**
 * Create an immutable snapshot. Write-once: we never update an existing
 * snapshot row; every organization run creates a fresh snapshot.
 */
export async function buildSnapshot(
  scopeType: OrgScopeType,
  scopeId: string,
): Promise<BuiltSnapshot> {
  let entities: SnapshotEntities;
  let objectId: string | null = null;

  if (scopeType === 'object') {
    objectId = scopeId;
    entities = await loadObjectEntities(scopeId);
  } else if (scopeType === 'variant') {
    const variant = await prismaKnowledge.knowledgeVariant.findUnique({ where: { id: scopeId } });
    if (!variant) throw new Error(`KnowledgeVariant ${scopeId} not found`);
    objectId = variant.objectId;
    entities = await loadObjectEntities(variant.objectId, scopeId);
  } else if (scopeType === 'version') {
    // scopeId format: "<objectId>:<versionInt>"
    const [objId, verStr] = scopeId.split(':');
    const version = parseInt(verStr, 10);
    if (!objId || !Number.isFinite(version)) throw new Error(`Invalid version scope: ${scopeId}`);
    objectId = objId;
    const base = await loadObjectEntities(objId);
    entities = { ...base, facts: (base.facts ?? []).filter((f) => f.version === version) };
  } else {
    // category / subtree: load objects under category
    const objectIds = await loadCategoryObjectIds(scopeId, scopeType === 'subtree');
    const objects = await prismaKnowledge.knowledgeObject.findMany({
      where: { id: { in: objectIds } },
      include: { categories: true },
    });
    const facts = await prismaKnowledge.knowledgeFact.findMany({
      where: { objectId: { in: objectIds }, lifecycleStatus: 'ACTIVE' },
    });
    const relations = await prismaKnowledge.knowledgeRelation.findMany({
      where: { OR: [{ objectId: { in: objectIds } }, { targetId: { in: objectIds } }] },
    });
    const category = await prismaKnowledge.knowledgeCategory.findUnique({ where: { id: scopeId } });
    entities = { object: null, variants: [], facts, factEvidence: [], evidence: [], sources: [], relations, categories: category ? [category] : [], objectCategories: objects.flatMap((o) => o.categories) };
  }

  const serialized = JSON.stringify(entities);

  // Adaptive: full snapshot for small scopes, manifest when too large
  const useFull = SMALL_SCOPES.includes(scopeType as any) && serialized.length <= FULL_SNAPSHOT_LIMIT;
  const manifest = entityList(entities);
  const manifestJson = JSON.stringify(manifest);
  const hash = sha256(useFull ? serialized : manifestJson);

  const snap = await prismaKnowledge.organizationSnapshot.create({
    data: {
      scopeType,
      scopeId,
      dataJson: useFull ? serialized : null,
      manifestJson,
      hash,
    },
  });

  return { id: snap.id, hash, mode: useFull ? 'full' : 'manifest', entities };
}

/** Verify a snapshot hash still matches captured content (integrity check). */
export async function verifySnapshot(snapshotId: string): Promise<{ ok: boolean; hash?: string }> {
  const snap = await prismaKnowledge.organizationSnapshot.findUnique({ where: { id: snapshotId } });
  if (!snap) return { ok: false };
  const manifest = JSON.parse(snap.manifestJson || '[]');
  const recomputed = sha256(snap.dataJson ?? JSON.stringify(manifest));
  return { ok: recomputed === snap.hash, hash: snap.hash };
}
