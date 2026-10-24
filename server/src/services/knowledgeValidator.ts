// ================================================================
// Knowledge Validator — pre-write validation before merging to knowledge
// ================================================================

import { prismaKnowledge } from './db';

export interface CandidateFact {
  objectId: string;
  variantId?: string;
  claim: string;
  claimType: string;
  evidenceIds: string[];
  confidence: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// 单一来源已移至 knowledgeOrg/orgCompliance.ts（纯模块，不拖 Prisma）。
// 此处**再导出**：对外 API 不变，knowledgeOrganizer / versionedMerge 等
// 既有引用方无需改动，且不会形成循环依赖（orgCompliance 不再引用本文件）。
import { VALID_CLAIM_TYPES } from './knowledgeOrg/orgCompliance';
// 对外 API 保持不变（knowledgeOrganizer / versionedMerge 仍从这里 import）；
// 单一来源在纯模块 orgCompliance.ts，避免本文件把 Prisma 依赖传染给整理链路。
export { VALID_CLAIM_TYPES };

const OPINION_MARKERS = [
  'in my opinion', 'i think', 'we think', 'i believe', 'imho', 'personally',
  '我觉得', '我认为', '笔者认为', '主观', 'opinion',
];

const INFERENCE_MARKERS = [
  'inferred', 'inference', 'we assume', 'presumed', 'probably', 'likely', 'possibly',
  '推测', '推断', '估计', '可能', '或许',
];

function matchesAny(text: string, markers: string[]): boolean {
  const s = String(text ?? '').toLowerCase();
  return markers.some((m) => s.includes(m.toLowerCase()));
}

function normClaim(claim: string): string {
  return String(claim ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export async function validateKnowledge(candidateFacts: CandidateFact[]): Promise<ValidationResult> {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };
  const facts = candidateFacts ?? [];

  // ---- Batch DB lookups (evidence existence, variants, duplicate claims) ----
  const allEvidenceIds = Array.from(
    new Set(facts.flatMap((f) => (Array.isArray(f.evidenceIds) ? f.evidenceIds : [])).filter(Boolean)),
  );
  const evidenceIds = new Set<string>();
  if (allEvidenceIds.length > 0) {
    const found = await prismaKnowledge.evidence.findMany({
      where: { id: { in: allEvidenceIds } },
      select: { id: true },
    });
    for (const e of found) evidenceIds.add(e.id);
  }

  const variantIds = Array.from(new Set(facts.map((f) => f.variantId).filter(Boolean) as string[]));
  const variants = new Map<string, any>();
  if (variantIds.length > 0) {
    const foundVariants = await prismaKnowledge.knowledgeVariant.findMany({
      where: { id: { in: variantIds } },
    });
    for (const v of foundVariants) variants.set(v.id, v);
  }

  const objectIds = Array.from(new Set(facts.map((f) => f.objectId).filter(Boolean)));
  const existingFacts = objectIds.length > 0
    ? await prismaKnowledge.knowledgeFact.findMany({
        where: { objectId: { in: objectIds } },
        select: { objectId: true, variantId: true, claim: true },
      })
    : [];
  const claimsByObject = new Map<string, Set<string>>();
  for (const f of existingFacts) {
    const key = `${f.objectId}::${f.variantId ?? ''}`;
    const set = claimsByObject.get(key) ?? new Set<string>();
    set.add(normClaim(f.claim));
    claimsByObject.set(key, set);
  }

  // ---- Per-fact checks ----
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i];
    const label = `fact[${i}]`;

    if (!f.objectId) result.errors.push(`${label}: missing objectId`);
    if (!String(f.claim ?? '').trim()) result.errors.push(`${label}: missing claim`);

    // Evidence checks
    const evIds = Array.isArray(f.evidenceIds) ? f.evidenceIds : [];
    if (evIds.length === 0) {
      result.errors.push(`${label}: at least one evidence ID is required`);
    } else {
      const missing = evIds.filter((id) => !evidenceIds.has(String(id)));
      if (missing.length > 0) {
        result.errors.push(`${label}: evidence IDs not found in Evidence table: ${missing.join(', ')}`);
      }
    }

    // claimType checks
    if (!(VALID_CLAIM_TYPES as readonly string[]).includes(f.claimType)) {
      result.errors.push(`${label}: invalid claimType "${f.claimType}" (must be one of ${VALID_CLAIM_TYPES.join(', ')})`);
    } else {
      if (f.claimType === 'OFFICIAL_FACT' && matchesAny(f.claim, OPINION_MARKERS)) {
        result.errors.push(`${label}: opinion content marked as OFFICIAL_FACT`);
      }
      if (f.claimType === 'MEASURED_RESULT' && matchesAny(f.claim, INFERENCE_MARKERS)) {
        result.errors.push(`${label}: inference content marked as MEASURED_RESULT`);
      }
    }

    // Region / variant consistency
    if (f.variantId) {
      const variant = variants.get(f.variantId);
      if (!variant) {
        result.warnings.push(`${label}: variantId ${f.variantId} not found in KnowledgeVariant`);
      } else {
        const identifiers = [
          variant.variantName,
          variant.modelNumber,
          variant.region,
          variant.market,
          variant.version,
          variant.sku,
          variant.country,
        ]
          .filter(Boolean)
          .map((s) => String(s).toLowerCase());
        const claimLower = String(f.claim ?? '').toLowerCase();
        const mentionsVariant = identifiers.some((id) => id.length > 1 && claimLower.includes(id));
        if (!mentionsVariant) {
          result.warnings.push(
            `${label}: variantId set but claim does not mention any variant identifier (${identifiers.join(', ') || 'n/a'})`,
          );
        }
      }
    }

    // Confidence bounds
    const conf = Number(f.confidence);
    if (Number.isNaN(conf) || conf < 0 || conf > 1) {
      result.errors.push(`${label}: confidence must be between 0 and 1 (got ${String(f.confidence)})`);
    }

    // Duplicate claim for same object + variant
    if (f.objectId && String(f.claim ?? '').trim()) {
      const key = `${f.objectId}::${f.variantId ?? ''}`;
      const existing = claimsByObject.get(key);
      if (existing && existing.has(normClaim(f.claim))) {
        result.errors.push(
          `${label}: duplicate claim already exists for object ${f.objectId} (variant ${f.variantId ?? 'n/a'}); supersede instead`,
        );
      }
    }
  }

  // Also flag intra-batch duplicates
  const seenInBatch = new Map<string, number>();
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i];
    if (!f.objectId || !String(f.claim ?? '').trim()) continue;
    const key = `${f.objectId}::${f.variantId ?? ''}::${normClaim(f.claim)}`;
    const first = seenInBatch.get(key);
    if (first !== undefined) {
      result.warnings.push(`fact[${i}] duplicates fact[${first}] within the same batch`);
    } else {
      seenInBatch.set(key, i);
    }
  }

  result.valid = result.errors.length === 0;
  return result;
}
