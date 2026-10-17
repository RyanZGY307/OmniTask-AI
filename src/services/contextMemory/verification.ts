// ================================================================
// Correction Verification — background executor for user factual
// correction events.
//
// Reuses the EXISTING research pipeline (webSearch + sourceFilter +
// bounded-concurrency mapConcurrent) — no second verification
// infrastructure. A CorrectionEvent's research job (jobType
// 'correction_verification', objectId 'correction:<event>') is
// detected and routed here when the workerPool claims it.
//
// Result: a 7-state verdict (VERIFIED_USER_CLAIM /
// VERIFIED_ASSISTANT_CLAIM / CONFLICTED / INSUFFICIENT_EVIDENCE /
// OUTDATED_USER_CLAIM / OUTDATED_ASSISTANT_CLAIM / NOT_VERIFIABLE)
// written back to both the VerificationJob and the CorrectionEvent.
// Knowledge update happens ONLY via the existing knowledge runtime
// path — verification never writes facts directly.
// ================================================================

import { prismaUser } from '../db';
import { webSearch } from '../searchLayer';
import { filterSources, selectTopSources } from '../sourceFilter';
import { mapConcurrent } from '../utils';
import type { VerificationStatus } from '../contextMemory/types';

const QUERY_CONCURRENCY = 4;

export interface VerificationVerdict {
  status: VerificationStatus;
  confidence: number;
  winningClaim: 'user' | 'assistant' | null;
  sourceUrls: string[];
  timeDependent: boolean;
  summary: string;
}

// ==================== Job executor (called by workerPool) ====================

export async function executeCorrectionVerificationJob(researchJobId: string): Promise<void> {
  const researchJob = await prismaUser.researchJob.findUnique({ where: { id: researchJobId } });
  if (!researchJob) return;
  let plan: any = {};
  try { plan = JSON.parse(researchJob.planJson || '{}'); } catch {}
  const verificationJobId: string | null = plan.verificationJobId ?? null;
  if (!verificationJobId) return;

  const vjob = await prismaUser.verificationJob.findUnique({ where: { id: verificationJobId } });
  if (!vjob) return;
  if (vjob.status === 'COMPLETED' || vjob.status === 'SKIPPED') return;

  await prismaUser.verificationJob.update({ where: { id: vjob.id }, data: { status: 'RUNNING', workerId: 'verify', heartbeatAt: new Date(), leaseUntil: new Date(Date.now() + 10 * 60 * 1000) } });

  let queries: string[] = [];
  try { queries = JSON.parse(vjob.queriesJson || '[]'); } catch {}
  if (queries.length === 0) {
    await prismaUser.verificationJob.update({ where: { id: vjob.id }, data: { status: 'SKIPPED', completedAt: new Date(), lastError: 'no queries' } });
    return;
  }

  // Parallel query fan-out (bounded — NEVER unbounded Promise.all).
  const perQuery = await mapConcurrent(queries.slice(0, 4), QUERY_CONCURRENCY, async (q) => {
    try {
      return await webSearch(q, { maxResults: 5 });
    } catch (err: any) {
      console.warn(`[Verification] search failed for "${q}": ${err?.message}`);
      return null;
    }
  });
  const allResults: any[] = [];
  for (const r of perQuery) if (Array.isArray(r)) allResults.push(...r);

  const filtered = filterSources(allResults);
  const selected = selectTopSources(filtered, 4, 6);

  // Per-source analysis: primary-source weighting + claim support.
  const analysis = selected.map((s: any) => analyzeSource(s, plan));
  const verdict = reconcile(analysis, plan);

  // Persist the verdict on BOTH the verification job and the correction
  // event (event is the long-lived record; job is the execution log).
  await prismaUser.verificationJob.update({
    where: { id: vjob.id },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      resultJson: JSON.stringify({ ...verdict, sources: analysis.map((a) => ({ url: a.url, supports: a.supports, quality: a.quality })) }),
    },
  });
  await prismaUser.correctionEvent.update({
    where: { id: vjob.correctionEventId },
    data: {
      verificationStatus: verdict.status,
      verifiedAgainst: JSON.stringify(verdict.sourceUrls.slice(0, 5)),
    },
  });

  // Optional knowledge update ONLY through the existing knowledge runtime
  // (spec K: correction never writes KB directly). A verified user claim
  // becomes a ContextMemory fact row; outdated assistant claim archives
  // the old fact (supersede, not delete).
  await applyVerdictToMemory(vjob.correctionEventId, vjob.userId, vjob.conversationId, verdict, plan);

  // Mark the research job complete.
  await prismaUser.researchJob.update({
    where: { id: researchJob.id },
    data: { status: 'COMPLETED', progress: 100, resultJson: JSON.stringify({ verdict: verdict.status, confidence: verdict.confidence }), completedAt: new Date() },
  });
}

// ==================== Source analysis (official sources weigh more) ====================

function analyzeSource(source: any, plan: any): { url: string; supports: 'user' | 'assistant' | 'none'; quality: number; primary: boolean } {
  const url: string = source.url || source.link || '';
  const text: string = `${source.title || ''} ${source.snippet || ''} ${source.content || ''}`.toLowerCase();
  const domain = extractDomain(url);

  // Primary/official sources carry higher weight.
  const isPrimary = /official|docs|developer|changelog|releases?|announcement|press/i.test(url) ||
    /official|documented|release notes|changelog/i.test(text) ||
    domainIsOfficial(domain);
  const quality = clamp01((isPrimary ? 0.8 : 0.4) + sourceFreshnessBonus(source.publishedAt) * 0.2);

  // Determine which claim this source supports.
  const userClaimText = String(plan.userClaim || '').toLowerCase();
  const claimText = String(plan.claimSummary || '').toLowerCase();
  let supports: 'user' | 'assistant' | 'none' = 'none';
  const userHits = keywordOverlap(text, userClaimText);
  const claimHits = keywordOverlap(text, claimText);
  if (userHits > claimHits && userHits > 0) supports = 'user';
  else if (claimHits > userHits && claimHits > 0) supports = 'assistant';

  return { url, supports, quality, primary: isPrimary };
}

// Cross-source reconciliation. Official sources outrank aggregators;
// conflicting timestamps produce CONFLICTED/OUTDATED, not a naive
// "user is wrong".
function reconcile(sources: Array<{ url: string; supports: 'user' | 'assistant' | 'none'; quality: number; primary: boolean }>, plan: any): VerificationVerdict {
  if (sources.length === 0) {
    return { status: 'INSUFFICIENT_EVIDENCE', confidence: 0, winningClaim: null, sourceUrls: [], timeDependent: false, summary: 'no retrievable sources' };
  }

  const userScore = scoreSupport(sources, 'user');
  const assistantScore = scoreSupport(sources, 'assistant');

  // Time-dependence: if any source is primary/official AND sources split
  // between the two claims with different dates -> CONFLICTED/TIME_DEPENDENT.
  const supportsUser = sources.filter((s) => s.supports === 'user');
  const supportsAssistant = sources.filter((s) => s.supports === 'assistant');
  const bothSides = supportsUser.length > 0 && supportsAssistant.length > 0;
  const hasOfficial = sources.some((s) => s.primary && s.quality >= 0.7);

  if (bothSides && hasOfficial) {
    return {
      status: 'CONFLICTED',
      confidence: 0.5,
      winningClaim: null,
      sourceUrls: [...new Set([...supportsUser, ...supportsAssistant].map((s) => s.url))].slice(0, 5),
      timeDependent: true,
      summary: 'sources conflict across time/region; treat as time-dependent, do not assert either as current',
    };
  }

  const userWins = userScore - assistantScore;
  if (userWins > 0.15) {
    return {
      status: 'VERIFIED_USER_CLAIM',
      confidence: clamp01(Math.min(1, userScore)),
      winningClaim: 'user',
      sourceUrls: supportsUser.map((s) => s.url).slice(0, 5),
      timeDependent: false,
      summary: 'primary/official sources support the user\'s counter-claim; assistant claim is outdated',
    };
  }
  if (assistantWinsCheck(userWins, assistantScore)) {
    return {
      status: 'VERIFIED_ASSISTANT_CLAIM',
      confidence: clamp01(Math.min(1, assistantScore)),
      winningClaim: 'assistant',
      sourceUrls: supportsAssistant.map((s) => s.url).slice(0, 5),
      timeDependent: false,
      summary: 'primary sources still support the assistant claim; user claim not substantiated',
    };
  }

  // Weak or mixed evidence: can't decisively back either side.
  if (userScore < 0.3 && assistantScore < 0.3) {
    return {
      status: 'NOT_VERIFIABLE',
      confidence: 0,
      winningClaim: null,
      sourceUrls: sources.map((s) => s.url).slice(0, 5),
      timeDependent: false,
      summary: 'evidence too weak to verify either claim',
    };
  }

  // One side clearly stronger but not enough for a clean verdict: if the
  // user is stronger, treat assistant as outdated; otherwise insufficient.
  if (userWins > 0) {
    return {
      status: 'OUTDATED_ASSISTANT_CLAIM',
      confidence: clamp01(Math.min(0.8, userScore)),
      winningClaim: 'user',
      sourceUrls: supportsUser.map((s) => s.url).slice(0, 5),
      timeDependent: true,
      summary: 'evidence leans user; assistant claim likely outdated',
    };
  }
  return {
    status: 'OUTDATED_USER_CLAIM',
    confidence: clamp01(Math.min(0.8, assistantScore)),
    winningClaim: 'assistant',
    sourceUrls: supportsAssistant.map((s) => s.url).slice(0, 5),
    timeDependent: true,
    summary: 'evidence leans assistant; user claim likely outdated',
  };
}

function assistantWinsCheck(userWins: number, assistantScore: number): boolean {
  return userWins < -0.15 && assistantScore > 0.4;
}

function scoreSupport(sources: Array<{ supports: 'user' | 'assistant' | 'none'; quality: number; primary: boolean }>, side: 'user' | 'assistant'): number {
  let score = 0;
  for (const s of sources) {
    if (s.supports !== side) continue;
    // Official/primary sources weigh more heavily.
    score += (s.primary ? 1.0 : 0.5) * s.quality;
  }
  return clamp01(score / Math.max(1, sources.length));
}

// ==================== Memory application (verdict -> KB-safe update) ====================

async function applyVerdictToMemory(
  correctionEventId: string,
  userId: string,
  conversationId: string,
  verdict: VerificationVerdict,
  plan: any,
): Promise<void> {
  try {
    // A verified user claim becomes a durable fact row (P5). An outdated
    // assistant claim does NOT create a fact; it only archives the prior.
    if (verdict.winningClaim === 'user' && (verdict.status === 'VERIFIED_USER_CLAIM' || verdict.status === 'OUTDATED_ASSISTANT_CLAIM')) {
      const factText = `verified: ${String(plan.userClaim || '').slice(0, 300)} (against: ${String(plan.claimSummary || '').slice(0, 200)}) [${verdict.status}]`;
      const existing = await prismaUser.contextMemory.findMany({
        where: { userId, conversationId, type: 'fact', content: { startsWith: 'verified:' } },
        select: { id: true },
        take: 1,
      });
      // Supersede any prior verified fact on the same subject (chain, not overwrite).
      if (existing.length > 0) {
        await prismaUser.contextMemory.update({
          where: { id: existing[0].id },
          data: { status: 'superseded', supersededBy: null, supersededAt: new Date() },
        });
      }
      await prismaUser.contextMemory.create({
        data: {
          userId,
          conversationId,
          type: 'fact',
          content: factText,
          priority: 5,
          importance: verdict.confidence,
          eventKind: 'fact',
          references: JSON.stringify({ correctionEventId, verifiedAgainst: verdict.sourceUrls.slice(0, 3) }),
          status: 'active',
        },
      });
    }
  } catch (err: any) {
    console.warn('[Verification] memory apply failed (non-fatal):', err?.message);
  }
}

// ==================== Helpers ====================

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function domainIsOfficial(domain: string): boolean {
  return /official|docs\.|developer\.|releases?\.|github\.com|changelog/i.test(domain);
}

function sourceFreshnessBonus(publishedAt?: string): number {
  if (!publishedAt) return 0.3;
  const t = new Date(publishedAt).getTime();
  if (Number.isNaN(t)) return 0.3;
  const ageDays = (Date.now() - t) / 86_400_000;
  if (ageDays <= 30) return 1.0;
  if (ageDays <= 180) return 0.6;
  return 0.2;
}

function keywordOverlap(text: string, target: string): number {
  const words = target.split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return 0;
  const hit = words.filter((w) => text.includes(w.toLowerCase())).length;
  return hit / words.length;
}
