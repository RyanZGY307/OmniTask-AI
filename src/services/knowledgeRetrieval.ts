// ================================================================
// Knowledge Retrieval — structured + semantic + variant/version filter
// ================================================================

import { prismaKnowledge } from './db';

export interface RetrievalOptions {
  query: string;
  objectId?: string;
  variantId?: string;
  region?: string;
  version?: string;
  claimTypes?: string[];
  minConfidence?: number;
  maxFacts?: number;
  includeEvidence?: boolean;
}

export interface RetrievedKnowledge {
  object: any;
  variants: any[];
  facts: Array<{
    fact: any;
    evidence?: any[];
  }>;
  sources: any[];
  coverage: Record<string, string>; // dimension → COMPLETE | PARTIAL | MISSING
}

export async function retrieveKnowledge(opts: RetrievalOptions): Promise<RetrievedKnowledge> {
  const { query, objectId, variantId, region, version, claimTypes, minConfidence = 0.3, maxFacts = 50, includeEvidence = true } = opts;

  // 1. Find the knowledge object
  let object: any = null;
  if (objectId) {
    object = await prismaKnowledge.knowledgeObject.findUnique({ where: { id: objectId } });
  } else {
    object = await findObjectByName(query);
  }

  if (!object) {
    return { object: null, variants: [], facts: [], sources: [], coverage: { [query]: 'MISSING' } };
  }

  // 2. Find matching variants
  let variants: any[] = [];
  const variantWhere: any = { objectId: object.id };
  if (region) variantWhere.region = region;
  if (version) variantWhere.version = version;
  if (variantId) variantWhere.id = variantId;
  variants = await prismaKnowledge.knowledgeVariant.findMany({
    where: variantWhere,
    include: { object: false },
  });

  // 3. Retrieve facts
  const factWhere: any = {
    objectId: object.id,
    ...(claimTypes?.length ? { claimType: { in: claimTypes } } : {}),
    ...(minConfidence > 0 ? { confidence: { gte: minConfidence } } : {}),
    verificationStatus: { not: 'SUPERSEDED' },
  };

  const facts = await prismaKnowledge.knowledgeFact.findMany({
    where: factWhere,
    orderBy: { confidence: 'desc' },
    take: maxFacts,
    include: includeEvidence
      ? {
          variant: true,
          evidence: {
            include: {
              evidence: {
                include: { source: { select: { id: true, canonicalUrl: true, domain: true, sourceType: true, isOfficial: true, qualityScore: true, retrievedAt: true } } },
              },
            },
          },
        }
      : {},
  });

  // 4. Collect unique sources
  const sourceMap = new Map<string, any>();
  for (const f of facts) {
    for (const ev of (f as any).evidence || []) {
      const src = (ev as any).evidence?.source;
      if (src && !sourceMap.has(src.id)) {
        sourceMap.set(src.id, src);
      }
    }
  }
  const sources = [...sourceMap.values()];

  // 5. Coverage analysis (basic)
  const coverage: Record<string, string> = {};
  const claimTypeCounts: Record<string, number> = {};
  for (const f of facts) {
    claimTypeCounts[f.claimType] = (claimTypeCounts[f.claimType] || 0) + 1;
  }
  coverage['FACTS'] = facts.length > 0 ? (facts.length >= 5 ? 'COMPLETE' : 'PARTIAL') : 'MISSING';
  coverage['OFFICIAL'] = claimTypeCounts['OFFICIAL_FACT'] ? 'PARTIAL' : 'MISSING';
  coverage['MEASURED'] = claimTypeCounts['MEASURED_RESULT'] ? 'PARTIAL' : 'MISSING';
  coverage['EVIDENCE'] = sources.length >= 3 ? 'COMPLETE' : sources.length >= 1 ? 'PARTIAL' : 'MISSING';

  return {
    object,
    variants,
    facts: facts.map(f => ({ fact: f, evidence: (f as any).evidence })),
    sources,
    coverage,
  };
}

async function findObjectByName(name: string): Promise<any | null> {
  // Exact match first
  const exact = await prismaKnowledge.knowledgeObject.findUnique({ where: { canonicalName: name } });
  if (exact) return exact;

  // Fuzzy: contains
  const fuzzy = await prismaKnowledge.knowledgeObject.findFirst({
    where: { canonicalName: { contains: name } },
    orderBy: { canonicalName: 'asc' },
  });
  return fuzzy;
}

export async function searchKnowledgeSemantically(query: string, topK: number = 10): Promise<Array<{ knowledgeId: string; score: number }>> {
  try {
    const { searchByEmbedding } = await import('./vectorSearch');
    const results = await searchByEmbedding(query, topK);
    return results;
  } catch {
    // Fallback: keyword search
    const chunks = await prismaKnowledge.knowledgeBase.findMany({
      where: {
        isActive: true,
        OR: [
          { title: { contains: query } },
          { content: { contains: query } },
        ],
      },
      take: topK,
    });
    return chunks.map((c, i) => ({ knowledgeId: c.id, score: 1 - i * 0.1 }));
  }
}
