// ================================================================
// Structure Scanner — deterministic first, Gemini only for semantics
// ================================================================

import { prismaKnowledge } from '../db';
import { buildSemanticScanPrompt, ORG_MODEL } from './orgPrompts';

export type OrgIssueType =
  | 'DUPLICATE_OBJECT' | 'DUPLICATE_FACT' | 'MIXED_FACT' | 'WRONG_CATEGORY'
  | 'MIXED_VARIANT' | 'MIXED_VERSION' | 'DUPLICATE_SOURCE' | 'DUPLICATE_RELATION'
  | 'ORPHAN_EVIDENCE' | 'STRUCTURE_ERROR'
  | 'SEMANTIC_DUPLICATE_FACT' | 'SEMANTIC_DUPLICATE_OBJECT'
  | 'VARIANT_ATTRIBUTION' | 'VERSION_ATTRIBUTION';

export interface OrgIssue {
  issueType: OrgIssueType;
  entityIds: string[];
  detail: string;
  deterministic: boolean;
  confidence: number;
}

const MAX_SEMANTIC_SAMPLE_ITEMS = 120;
const GEMINI_SCAN_THRESHOLD = 4; // need >=4 near-duplicate candidates before calling Gemini

function normClaim(claim: string): string {
  return String(claim ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokens(text: string): Set<string> {
  return new Set(String(text ?? '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((t) => t.length > 1));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function normUrl(url: string): string {
  return String(url ?? '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

// ---------------- Deterministic scan (no Gemini) ----------------

export async function deterministicScan(scopeEntities: any): Promise<{ issues: OrgIssue[]; semanticCandidates: any[] }> {
  const issues: OrgIssue[] = [];
  const facts: any[] = scopeEntities.facts ?? [];
  const sources: any[] = scopeEntities.sources ?? [];
  const relations: any[] = scopeEntities.relations ?? [];
  const evidence: any[] = scopeEntities.evidence ?? [];
  const factEvidence: any[] = scopeEntities.factEvidence ?? [];
  const variants: any[] = scopeEntities.variants ?? [];
  const semanticCandidates: any[] = [];

  // 1. Exact duplicate facts (same normalized claim + same variant)
  const byClaim = new Map<string, any[]>();
  for (const f of facts) {
    const key = `${normClaim(f.claim)}|${f.variantId ?? 'none'}`;
    const list = byClaim.get(key) ?? [];
    list.push(f);
    byClaim.set(key, list);
  }
  for (const [, group] of byClaim) {
    if (group.length >= 2) {
      issues.push({
        issueType: 'DUPLICATE_FACT',
        entityIds: group.map((f) => f.id),
        detail: `${group.length} facts with identical claim and variant`,
        deterministic: true,
        confidence: 1,
      });
    }
  }

  // 2. Semantic duplicate candidates (high token overlap, not exact) — Gemini only if enough
  const seen = new Set<string>();
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const a = facts[i]; const b = facts[j];
      if (a.variantId !== b.variantId) continue; // different variant: never merge candidates
      const key = `${normClaim(a.claim)}|${normClaim(b.claim)}`;
      if (seen.has(key) || normClaim(a.claim) === normClaim(b.claim)) continue;
      const sim = jaccard(tokens(a.claim), tokens(b.claim));
      if (sim >= 0.6) {
        seen.add(key);
        semanticCandidates.push({ ids: [a.id, b.id], claims: [a.claim, b.claim], sim });
      }
    }
  }

  // 3. Mixed facts (heuristic: multiple independent numeric values / sentence count)
  for (const f of facts) {
    const sentences = f.claim.split(/[。.!?！？\n]/).filter((s: string) => s.trim().length > 4);
    const numbers = (f.claim.match(/\d+(?:\.\d+)?/g) ?? []).length;
    const distinctUnits = new Set((f.claim.match(/\d+(?:\.\d+)?\s*(?:g|kg|mAh|mm|inch|W|h|GB|MP|mAh|Hz|mAh)/gi) ?? []).map((u: string) => u.replace(/[\d.\s]/g, '')));
    if (sentences.length >= 3 && numbers >= 2 && distinctUnits.size >= 2) {
      issues.push({
        issueType: 'MIXED_FACT',
        entityIds: [f.id],
        detail: `claim appears to contain multiple independent facts (${sentences.length} sentences, ${distinctUnits.size} unit kinds)`,
        deterministic: true,
        confidence: 0.8,
      });
    }
  }

  // 4. Mixed variants in one node: facts with same claim text but different variant values
  const variantValueGroups = new Map<string, any[]>();
  for (const f of facts) {
    const key = normClaim(f.claim);
    const list = variantValueGroups.get(key) ?? [];
    list.push(f);
    variantValueGroups.set(key, list);
  }
  for (const [, group] of variantValueGroups) {
    const variantIds = new Set(group.map((f) => f.variantId ?? 'none'));
    if (group.length >= 2 && variantIds.size > 1 && variants.length >= 2) {
      // Same claim text across different variants — likely legitimate per-variant facts;
      // only flag when claims are identical but variants exist and facts are NOT linked to them
      const unlinked = group.filter((f) => !f.variantId);
      if (unlinked.length > 0 && variantIds.size >= 1) {
        issues.push({
          issueType: 'MIXED_VARIANT',
          entityIds: unlinked.map((f) => f.id),
          detail: 'identical claims exist under specific variants while duplicates remain unlinked',
          deterministic: true,
          confidence: 0.85,
        });
      }
    }
  }

  // 5. Duplicate sources (same normalized URL / same domain+title)
  const byUrl = new Map<string, any[]>();
  for (const s of sources) {
    const key = normUrl(s.canonicalUrl);
    const list = byUrl.get(key) ?? [];
    list.push(s);
    byUrl.set(key, list);
  }
  for (const [url, group] of byUrl) {
    if (group.length >= 2) {
      issues.push({
        issueType: 'DUPLICATE_SOURCE',
        entityIds: group.map((s) => s.id),
        detail: `${group.length} sources normalize to ${url}`,
        deterministic: true,
        confidence: 1,
      });
    }
  }

  // 6. Duplicate relations (same object+target+type)
  const byRel = new Map<string, any[]>();
  for (const r of relations) {
    const key = `${r.objectId}|${r.targetId ?? 'none'}|${r.relationType}`;
    const list = byRel.get(key) ?? [];
    list.push(r);
    byRel.set(key, list);
  }
  for (const [, group] of byRel) {
    if (group.length >= 2) {
      issues.push({
        issueType: 'DUPLICATE_RELATION',
        entityIds: group.map((r) => r.id),
        detail: `${group.length} identical relations`,
        deterministic: true,
        confidence: 1,
      });
    }
  }

  // 7. Orphan evidence (evidence linked to no fact, or links pointing to missing facts)
  const linkedEvidence = new Set(factEvidence.map((fe) => fe.evidenceId));
  const factIdSet = new Set(facts.map((f) => f.id));
  const orphanEv = evidence.filter((e) => !linkedEvidence.has(e.id));
  if (orphanEv.length > 0) {
    issues.push({
      issueType: 'ORPHAN_EVIDENCE',
      entityIds: orphanEv.map((e) => e.id),
      detail: `${orphanEv.length} evidence items linked to no fact`,
      deterministic: true,
      confidence: 1,
    });
  }
  const danglingLinks = factEvidence.filter((fe) => !factIdSet.has(fe.factId));
  if (danglingLinks.length > 0) {
    issues.push({
      issueType: 'STRUCTURE_ERROR',
      entityIds: danglingLinks.map((fe) => `${fe.factId}:${fe.evidenceId}`),
      detail: `${danglingLinks.length} fact-evidence links point to facts outside scope`,
      deterministic: true,
      confidence: 1,
    });
  }

  // 8. Facts whose variantId points to a variant outside this scope's variant set
  const variantIdSet = new Set(variants.map((v) => v.id));
  const badVariantFacts = facts.filter((f) => f.variantId && !variantIdSet.has(f.variantId));
  if (badVariantFacts.length > 0) {
    issues.push({
      issueType: 'STRUCTURE_ERROR',
      entityIds: badVariantFacts.map((f) => f.id),
      detail: 'facts reference variants outside scope',
      deterministic: true,
      confidence: 1,
    });
  }

  return { issues, semanticCandidates };
}

// ---------------- Semantic scan (Gemini, only when needed) ----------------

export function needsSemanticScan(semanticCandidates: any[]): boolean {
  return semanticCandidates.length >= GEMINI_SCAN_THRESHOLD;
}

export async function semanticScan(semanticCandidates: any[], callGemini: (prompt: string) => Promise<string>): Promise<OrgIssue[]> {
  if (!needsSemanticScan(semanticCandidates)) return [];

  const sample = semanticCandidates
    .slice(0, MAX_SEMANTIC_SAMPLE_ITEMS)
    .map((c, i) => `${i}. [${c.ids.join(', ')}] "${c.claims[0]}" vs "${c.claims[1]}" (overlap ${c.sim.toFixed(2)})`)
    .join('\n');

  try {
    const raw = await callGemini(buildSemanticScanPrompt(sample));
    const parsed = extractJson(raw);
    if (!parsed || !Array.isArray(parsed.issues)) return [];
    return parsed.issues
      .filter((iss: any) => typeof iss?.issueType === 'string' && Array.isArray(iss?.entityIds) && Number(iss?.confidence) >= 0.7)
      .map((iss: any) => ({
        issueType: iss.issueType as OrgIssueType,
        entityIds: iss.entityIds.map(String),
        detail: String(iss.detail ?? ''),
        deterministic: false,
        confidence: Number(iss.confidence),
      }));
  } catch (err: any) {
    console.warn(`[OrgScanner] semantic scan failed (${err?.message ?? err}); proceeding with deterministic issues only`);
    return [];
  }
}

function extractJson(raw: string): any | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

export { ORG_MODEL };
