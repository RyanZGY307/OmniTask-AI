// ================================================================
// Knowledge Organizer — Gemini-based knowledge organization
// (normalize, classify, dedup, connect, separate fact types)
// ================================================================

import { prismaKnowledge } from './db';
import { callAgnesForText, isAgnesAvailable } from './knowledgeOrganizerGemini';
import { VALID_CLAIM_TYPES } from './knowledgeValidator';

export interface OrganizedFact {
  objectId: string;
  variantId?: string;
  claim: string;
  claimType: string;
  confidence: number;
  evidenceIds: string[];
  observedAt?: string;
  validFrom?: string;
  validTo?: string;
}

export interface OrganizedRelation {
  objectId: string;
  targetId: string;
  relationType: string;
  description?: string;
}

export interface OrganizedKnowledge {
  facts: OrganizedFact[];
  relations: OrganizedRelation[];
  categories: string[];
  unknowns: string[];
  summary: string;
}

const MAX_FACTS = 50;
const MAX_RELATIONS = 20;
const MAX_CATEGORIES = 10;
const MAX_UNKNOWNS = 20;
const EVIDENCE_CONTENT_LIMIT = 2000;

const RELATION_TYPES = [
  'RELATED_TO', 'COMPARED_WITH', 'PART_OF', 'AFFECTS',
  'REPLACED_BY', 'SIMILAR_TO', 'DERIVED_FROM', 'CONTAINS',
];

const BENCHMARK_DOMAINS = ['gsmarena.com', 'notebookcheck.net', 'anandtech.com', 'techpowerbench.com', 'geeksbench.com'];
const FORUM_DOMAINS = ['reddit.com', 'forums.', 'quora.com'];
const SOCIAL_DOMAINS = ['youtube.com', 'twitter.com', 'x.com', 'facebook.com', 'tiktok.com', 'instagram.com'];

function clampConfidence(v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) return 0.5;
  return n;
}

function validClaimType(v: any): string {
  const s = String(v ?? '').toUpperCase();
  return (VALID_CLAIM_TYPES as readonly string[]).includes(s) ? s : 'UNKNOWN';
}

function firstSentence(text: string, limit = 300): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.+?[.!?。？])/);
  return (m ? m[1] : t).slice(0, limit);
}

function deriveSourceType(ev: any): string {
  const st = String(ev?.sourceType ?? '').toUpperCase();
  if (['OFFICIAL', 'BENCHMARK', 'FORUM', 'SOCIAL', 'ACADEMIC', 'DOCUMENT', 'VIDEO', 'IMAGE', 'WEB'].includes(st)) return st;
  if (ev?.metadata?.isOfficial || ev?.isOfficial) return 'OFFICIAL';
  const et = String(ev?.evidenceType ?? '').toUpperCase();
  if (et === 'IMAGE' || et === 'VIDEO') return et;
  if (et === 'MEASUREMENT') return 'BENCHMARK';
  const domain = String(ev?.domain ?? '').toLowerCase();
  if (BENCHMARK_DOMAINS.some((d) => domain.includes(d))) return 'BENCHMARK';
  if (FORUM_DOMAINS.some((d) => domain.includes(d))) return 'FORUM';
  if (SOCIAL_DOMAINS.some((d) => domain.includes(d))) return 'SOCIAL';
  return 'WEB';
}

function sourceTypeToClaimType(st: string): string {
  switch (st) {
    case 'OFFICIAL':
      return 'OFFICIAL_FACT';
    case 'BENCHMARK':
    case 'MEASUREMENT':
      return 'MEASURED_RESULT';
    case 'FORUM':
    case 'SOCIAL':
      return 'USER_REPORT';
    case 'IMAGE':
    case 'VIDEO':
      return 'VISUAL_OBSERVATION';
    default:
      return 'TECHNICAL_ANALYSIS';
  }
}

const FALLBACK_CONFIDENCE: Record<string, number> = {
  OFFICIAL_FACT: 0.9,
  MEASURED_RESULT: 0.75,
  VISUAL_OBSERVATION: 0.6,
  TECHNICAL_ANALYSIS: 0.55,
  USER_REPORT: 0.5,
  INFERENCE: 0.45,
  OPINION: 0.4,
  UNKNOWN: 0.3,
};

function deterministicOrganize(evidence: any[], validation: any, conflicts: any[], objectId: string): OrganizedKnowledge {
  const ev = Array.isArray(evidence) ? evidence : [];

  // Group evidence by source type
  const groups = new Map<string, any[]>();
  for (const item of ev) {
    const st = deriveSourceType(item);
    const list = groups.get(st) ?? [];
    list.push(item);
    groups.set(st, list);
  }

  const facts: OrganizedFact[] = [];
  const seen = new Set<string>();
  for (const item of ev) {
    const st = deriveSourceType(item);
    const claimType = sourceTypeToClaimType(st);
    const claim = firstSentence(String(item?.metadata?.title || item?.content || ''));
    if (!claim.trim()) continue;
    const key = claim.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);

    facts.push({
      objectId,
      claim,
      claimType,
      confidence: FALLBACK_CONFIDENCE[claimType] ?? 0.5,
      evidenceIds: item?.id ? [String(item.id)] : [],
      ...(item?.observedAt ? { observedAt: String(item.observedAt) } : {}),
    });
    if (facts.length >= MAX_FACTS) break;
  }

  const unknowns = (Array.isArray(conflicts) ? conflicts : [])
    .map((c: any) => (c?.claim ? `${c.claim} (${Array.isArray(c.values) ? c.values.join(' vs ') : String(c.possibleReason ?? '')})` : null))
    .filter(Boolean)
    .slice(0, MAX_UNKNOWNS);

  const groupDesc = Array.from(groups.entries())
    .map(([st, items]) => `${st}(${items.length})`)
    .join(', ');

  return {
    facts,
    relations: [],
    categories: ['general'],
    unknowns,
    summary: `Deterministic organization (Gemini unavailable): ${facts.length} facts from ${ev.length} evidence items, grouped by source type: ${groupDesc || 'none'}. Validation report had ${Array.isArray(validation?.errors) ? validation.errors.length : 0} errors and ${Array.isArray(validation?.warnings) ? validation.warnings.length : 0} warnings.`,
  };
}

function extractJson(raw: string): any {
  const cleaned = String(raw ?? '')
    .replace(/^```json?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function sanitizeOrganized(
  parsed: any,
  objectId: string,
  knownVariants: Set<string>,
  knownEvidence: Set<string>,
): Promise<OrganizedKnowledge> {
  const facts: OrganizedFact[] = [];
  const seen = new Set<string>();

  for (const raw of Array.isArray(parsed?.facts) ? parsed.facts : []) {
    if (!raw || typeof raw !== 'object') continue;
    const claim = String(raw.claim ?? '').trim();
    if (!claim) continue;
    const key = claim.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);

    const evidenceIds = (Array.isArray(raw.evidenceIds) ? raw.evidenceIds : [])
      .map((id: any) => String(id))
      .filter(Boolean)
      .filter((id) => !knownEvidence.size || knownEvidence.has(id));

    const fact: OrganizedFact = {
      objectId,
      claim,
      claimType: validClaimType(raw.claimType),
      confidence: clampConfidence(raw.confidence),
      evidenceIds,
    };
    if (raw.variantId && knownVariants.size && knownVariants.has(String(raw.variantId))) {
      fact.variantId = String(raw.variantId);
    }
    if (raw.observedAt) fact.observedAt = String(raw.observedAt);
    if (raw.validFrom) fact.validFrom = String(raw.validFrom);
    if (raw.validTo) fact.validTo = String(raw.validTo);
    facts.push(fact);
    if (facts.length >= MAX_FACTS) break;
  }

  const relations: OrganizedRelation[] = [];
  const relSeen = new Set<string>();
  for (const raw of Array.isArray(parsed?.relations) ? parsed.relations : []) {
    if (!raw || typeof raw !== 'object') continue;
    const targetId = String(raw.targetId ?? '').trim();
    if (!targetId) continue;
    const relationType = RELATION_TYPES.includes(String(raw.relationType).toUpperCase())
      ? String(raw.relationType).toUpperCase()
      : 'RELATED_TO';
    const key = `${targetId}::${relationType}`;
    if (relSeen.has(key)) continue;
    relSeen.add(key);
    relations.push({
      objectId,
      targetId,
      relationType,
      ...(raw.description ? { description: String(raw.description).slice(0, 300) } : {}),
    });
    if (relations.length >= MAX_RELATIONS) break;
  }

  const rawCategories: any[] = Array.isArray(parsed?.categories) ? (parsed.categories as any[]) : [];
  const categories: string[] = Array.from(new Set(
    rawCategories.map((c) => String(c ?? '').trim()).filter(Boolean),
  )).slice(0, MAX_CATEGORIES);

  const rawUnknowns: any[] = Array.isArray(parsed?.unknowns) ? (parsed.unknowns as any[]) : [];
  const unknowns: string[] = rawUnknowns
    .map((u) => String(u ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_UNKNOWNS);

  return {
    facts,
    relations,
    categories,
    unknowns,
    summary: String(parsed?.summary ?? '').slice(0, 1000) || 'Organized by Gemini (no summary provided).',
  };
}

function buildOrganizePrompt(evidence: any[], validation: any, conflicts: any[], objectId: string): string {
  const evCompact = (Array.isArray(evidence) ? evidence : []).map((item) => ({
    id: item?.id ?? null,
    domain: item?.domain ?? null,
    evidenceType: item?.evidenceType ?? null,
    isOfficial: item?.metadata?.isOfficial ?? item?.isOfficial ?? false,
    content: String(item?.content ?? '').slice(0, EVIDENCE_CONTENT_LIMIT),
  }));
  const valCompact = {
    valid: validation?.valid ?? null,
    errors: Array.isArray(validation?.errors) ? validation.errors : [],
    warnings: Array.isArray(validation?.warnings) ? validation.warnings : [],
  };

  return `You are the knowledge organizer for the OmniTask research pipeline.
You receive collected evidence, a pre-write validation report, and detected conflicts for one research job on knowledge object ${objectId}.

Respond with ONLY a strict JSON object (no markdown, no commentary) with EXACTLY this shape:
{
  "facts": [
    {
      "objectId": "${objectId}",
      "variantId": "optional, only if the evidence is about a specific variant",
      "claim": "one atomic, normalized claim",
      "claimType": "OFFICIAL_FACT | MEASURED_RESULT | TECHNICAL_ANALYSIS | VISUAL_OBSERVATION | USER_REPORT | OPINION | INFERENCE | UNKNOWN",
      "confidence": 0.0,
      "evidenceIds": ["ids from the evidence below only"],
      "observedAt": "ISO date or null",
      "validFrom": "ISO date or null",
      "validTo": "ISO date or null"
    }
  ],
  "relations": [
    { "objectId": "${objectId}", "targetId": "id or name of another object", "relationType": "RELATED_TO | COMPARED_WITH | PART_OF | AFFECTS | REPLACED_BY | SIMILAR_TO | DERIVED_FROM | CONTAINS", "description": "short" }
  ],
  "categories": ["suggested taxonomy categories"],
  "unknowns": ["genuinely unresolved questions or contradictions"],
  "summary": "2-4 sentence summary of what was learned"
}

Rules:
1. Normalize terminology so near-identical claims use the same words (deduplicate them into one fact).
2. Each fact is ONE atomic claim. Separate facts (OFFICIAL_FACT, MEASURED_RESULT, VISUAL_OBSERVATION, USER_REPORT) from opinions (OPINION) and inferences (INFERENCE); use UNKNOWN when classification is not possible.
3. Set evidenceIds to the ids of the evidence items that back the claim (from the EVIDENCE section only).
4. Identify relations between objects (compared-with, part-of, affects, ...).
5. Suggest categories that fit a general knowledge taxonomy.
6. confidence must be a number between 0 and 1.

EVIDENCE:
${JSON.stringify(evCompact)}

VALIDATION REPORT:
${JSON.stringify(valCompact)}

CONFLICTS:
${JSON.stringify(Array.isArray(conflicts) ? conflicts : [])}

Respond with JSON only.`;
}

export async function organizeKnowledge(
  researchRecordId: string,
  evidence: any[],
  validation: any,
  conflicts: any[],
): Promise<OrganizedKnowledge> {
  const rec = await prismaKnowledge.researchRecord.findUnique({ where: { id: researchRecordId } });
  if (!rec) throw new Error(`Research record ${researchRecordId} not found`);
  const objectId = rec.objectId;

  const ev = Array.isArray(evidence) ? evidence : [];
  const knownEvidence = new Set(ev.map((item: any) => String(item?.id ?? '')).filter(Boolean));
  const variantRows = await prismaKnowledge.knowledgeVariant.findMany({ where: { objectId }, select: { id: true } });
  const knownVariants = new Set(variantRows.map((v) => v.id));

  if (isAgnesAvailable() && ev.length > 0) {
    try {
      const prompt = buildOrganizePrompt(ev, validation, conflicts, objectId);
      const raw = await callAgnesForText(prompt);
      const parsed = extractJson(raw);
      if (parsed && Array.isArray(parsed.facts)) {
        return await sanitizeOrganized(parsed, objectId, knownVariants, knownEvidence);
      }
      console.warn('[KnowledgeOrganizer] Gemini returned malformed JSON; using deterministic fallback');
    } catch (err: any) {
      console.warn(`[KnowledgeOrganizer] Gemini organize failed (${err?.message ?? err}); using deterministic fallback`);
    }
  }

  return deterministicOrganize(ev, validation, conflicts, objectId);
}
