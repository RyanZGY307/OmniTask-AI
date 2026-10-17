// ================================================================
// Versioned Merge — version-safe merge of organized knowledge
// Facts are never deleted; contradictions supersede (version+1).
// ================================================================

import { prismaKnowledge } from './db';
import { VALID_CLAIM_TYPES } from './knowledgeValidator';
import type { OrganizedKnowledge, OrganizedFact } from './knowledgeOrganizer';

export interface MergeResult {
  created: number;
  updated: number;
  superseded: number;
  conflicts: number;
  version: number;
}

function normClaim(claim: string): string {
  return String(claim ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// Strip numeric values so "4GB RAM" and "8GB RAM" collide as the same topic
function topicKey(claim: string): string {
  return normClaim(claim).replace(/\d+(?:\.\d+)?/g, '');
}

function clamp01(v: any, fallback = 0.5): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

function safeClaimType(v: any): string {
  const s = String(v ?? '').toUpperCase();
  return (VALID_CLAIM_TYPES as readonly string[]).includes(s) ? s : 'UNKNOWN';
}

function toDate(v: any): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface ExistingFact {
  id: string;
  claim: string;
  variantId: string | null;
  confidence: number;
  version: number;
}

function matchKeyOf(f: { claim: string; variantId: string | null }): string {
  return `${normClaim(f.claim)}::${f.variantId ?? ''}`;
}

async function resolveTargetId(tx: any, targetIdOrName: string): Promise<string | null> {
  const t = String(targetIdOrName ?? '').trim();
  if (!t) return null;
  const byId = await tx.knowledgeObject.findUnique({ where: { id: t }, select: { id: true } });
  if (byId) return byId.id;
  if (t.length >= 2 && t.length <= 64) {
    const byName = await tx.knowledgeObject.findFirst({
      where: { canonicalName: { equals: t } },
      select: { id: true },
    });
    if (byName) return byName.id;
  }
  return null;
}

export async function mergeKnowledge(organized: OrganizedKnowledge, objectId: string): Promise<MergeResult> {
  const result: MergeResult = { created: 0, updated: 0, superseded: 0, conflicts: 0, version: 0 };
  const factsIn = (organized?.facts ?? []).filter((f) => f && String(f.claim ?? '').trim());
  const relationsIn = organized?.relations ?? [];
  if (!objectId) return result;
  if (factsIn.length === 0 && relationsIn.length === 0) {
    const maxV = await prismaKnowledge.knowledgeFact.findFirst({
      where: { objectId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    result.version = maxV?.version ?? 0;
    return result;
  }

  result.version = await prismaKnowledge.$transaction(async (tx) => {
    const variantRows = await tx.knowledgeVariant.findMany({ where: { objectId }, select: { id: true } });
    const validVariants = new Set(variantRows.map((v) => v.id));

    const current = await tx.knowledgeFact.findMany({
      where: { objectId, verificationStatus: { not: 'SUPERSEDED' } },
      select: { id: true, claim: true, variantId: true, confidence: true, version: true },
    });
    const currentFacts: ExistingFact[] = current.map((f: any) => ({
      id: f.id,
      claim: f.claim,
      variantId: f.variantId ?? null,
      confidence: f.confidence,
      version: f.version,
    }));
    const existingByKey = new Map<string, ExistingFact>();
    const byTopic = new Map<string, ExistingFact[]>();
    for (const f of currentFacts) {
      const key = `${normClaim(f.claim)}::${f.variantId ?? ''}`;
      existingByKey.set(key, f);
      const tk = topicKey(f.claim);
      const arr = byTopic.get(tk) ?? [];
      arr.push(f);
      byTopic.set(tk, arr);
    }

    const allEvIds = Array.from(new Set(
      factsIn.flatMap((f) => (Array.isArray(f.evidenceIds) ? f.evidenceIds : [])).filter(Boolean),
    )).map(String);
    const validEvidence = new Set<string>();
    if (allEvIds.length > 0) {
      const found = await tx.evidence.findMany({ where: { id: { in: allEvIds } }, select: { id: true } });
      for (const e of found) validEvidence.add(e.id);
    }

    // Merge batch duplicates (same claim+variant) so all evidence links are kept
    const batch = new Map<string, { fact: OrganizedFact; evIds: string[] }>();
    for (const f of factsIn) {
      const variantId = f.variantId && validVariants.has(f.variantId) ? f.variantId : null;
      const key = `${normClaim(f.claim)}::${variantId ?? ''}`;
      const evIds = (Array.isArray(f.evidenceIds) ? f.evidenceIds : [])
        .map(String)
        .filter((id) => validEvidence.has(id));
      const prev = batch.get(key);
      if (prev) prev.evIds.push(...evIds);
      else batch.set(key, { fact: { ...f, variantId: variantId ?? undefined }, evIds });
    }

    for (const { fact, evIds } of batch.values()) {
      const claim = String(fact.claim).trim();
      const variantId = (fact.variantId && validVariants.has(fact.variantId) ? fact.variantId : null);
      const mk = `${normClaim(claim)}::${variantId ?? ''}`;
      const confidence = clamp01(fact.confidence);
      const observedAt = toDate(fact.observedAt);
      const validFrom = toDate(fact.validFrom);
      const validTo = toDate(fact.validTo);

      const linkEvidence = async (factId: string) => {
        if (evIds.length === 0) return;
        const linked = await tx.knowledgeFactEvidence.findMany({
          where: { factId },
          select: { evidenceId: true },
        });
        const linkedSet = new Set(linked.map((l: any) => l.evidenceId));
        for (const eid of evIds) {
          if (!linkedSet.has(eid)) {
            await tx.knowledgeFactEvidence.create({ data: { factId, evidenceId: eid } });
          }
        }
      };

      const existing = existingByKey.get(mk);
      if (existing) {
        // Supporting evidence: link new evidence, bump confidence
        await linkEvidence(existing.id);
        const newConf = Math.min(0.95, Math.max(existing.confidence, confidence) + 0.05);
        await tx.knowledgeFact.update({
          where: { id: existing.id },
          data: {
            confidence: newConf,
            ...(observedAt ? { observedAt } : {}),
            ...(validFrom ? { validFrom } : {}),
            ...(validTo ? { validTo } : {}),
          },
        });
        existing.confidence = newConf;
        result.updated++;
        continue;
      }

      const topic = topicKey(claim);
      const collisions = (byTopic.get(topic) ?? []).filter((x) => matchKeyOf(x) !== mk);
      if (collisions.length > 0) {
        // Contradiction: new version, supersede the older fact(s)
        const base = collisions[0];
        const newFact = await tx.knowledgeFact.create({
          data: {
            objectId,
            variantId: variantId ?? base.variantId,
            claim,
            claimType: safeClaimType(fact.claimType),
            confidence,
            version: base.version + 1,
            ...(observedAt ? { observedAt } : {}),
            ...(validFrom ? { validFrom } : {}),
            ...(validTo ? { validTo } : {}),
          },
        });
        await linkEvidence(newFact.id);
        for (const c of collisions) {
          await tx.knowledgeFact.update({
            where: { id: c.id },
            data: { verificationStatus: 'SUPERSEDED', supersededBy: newFact.id },
          });
          result.superseded++;
        }
        result.conflicts += collisions.length;
        result.created++;
        const rec: ExistingFact = {
          id: newFact.id,
          claim,
          variantId: variantId ?? base.variantId,
          confidence,
          version: base.version + 1,
        };
        existingByKey.set(mk, rec);
        const arr = byTopic.get(topic) ?? [];
        arr.push(rec);
        byTopic.set(topic, arr);
        continue;
      }

      // New fact
      const newFact = await tx.knowledgeFact.create({
        data: {
          objectId,
          variantId,
          claim,
          claimType: safeClaimType(fact.claimType),
          confidence,
          version: 1,
          ...(observedAt ? { observedAt } : {}),
          ...(validFrom ? { validFrom } : {}),
          ...(validTo ? { validTo } : {}),
        },
      });
      await linkEvidence(newFact.id);
      result.created++;
      const rec: ExistingFact = { id: newFact.id, claim, variantId, confidence, version: 1 };
      existingByKey.set(mk, rec);
      const arr = byTopic.get(topic) ?? [];
      arr.push(rec);
      byTopic.set(topic, arr);
    }

    for (const r of relationsIn) {
      const targetId = await resolveTargetId(tx, r?.targetId);
      if (!targetId) {
        console.warn(`[VersionedMerge] relation target "${r?.targetId ?? ''}" not resolvable; skipped`);
        continue;
      }
      const relationType = String(r?.relationType ?? 'RELATED_TO').toUpperCase();
      const found = await tx.knowledgeRelation.findFirst({
        where: { objectId, targetId, relationType },
      });
      if (!found) {
        await tx.knowledgeRelation.create({
          data: {
            objectId,
            targetId,
            relationType,
            ...(r?.description ? { description: String(r.description).slice(0, 300) } : {}),
          },
        });
      }
    }

    const maxV = await tx.knowledgeFact.findFirst({
      where: { objectId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return maxV?.version ?? 0;
  });

  return result;
}
