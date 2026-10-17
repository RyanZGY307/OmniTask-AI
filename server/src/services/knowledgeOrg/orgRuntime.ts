// ================================================================
// Self-Organization Runtime — full pipeline orchestrator
//
// Trigger → Job dedupe → Scope → Immutable Snapshot → Scan (deterministic
// first, semantic via Gemini only when needed) → Task split → Parallel
// Workers (proposals only) → Result Pool → Cross-worker conflict check
// → Unified merge → Deterministic pre-checks → Gemini Final Validator
// (only when changes exist) → orgApplier (single-threaded write) →
// Re-embed affected facts.
//
// Boundaries: never researches, never calls Research Runtime.
// Gemini budget: 1 (scan) + up to 8 (workers) + 1 (validator) = 10 max.
// 10 is a hard cap, NOT a target — deterministic paths skip Gemini.
// ================================================================

import { prismaUser, prismaKnowledge } from '../db';
import { callAgnesForText, isAgnesAvailable } from '../knowledgeOrganizerGemini';
import { buildSnapshot, type BuiltSnapshot, type OrgScopeType } from './orgSnapshot';
import { deterministicScan, semanticScan, needsSemanticScan, type OrgIssue } from './orgScanner';
import { splitTasks, runWorkers, type WorkerResult } from './orgWorkers';
import { mergeResults, type MergedPlan } from './orgResultPool';
import { deterministicPreCheck, geminiFinalValidation } from './orgValidator';
import { applyPlan } from './orgApplier';
import { indexKnowledgeChunk } from '../vectorSearch';
import { stampNewFact, archiveFactRefreshState } from '../knowledgeLifecycle/factTimeStamper';
import { runAccuracyGate, recordGateDecision, dispatchRepairResearch } from '../knowledgeLifecycle/accuracyGate';

// ---------------- Job lifecycle ----------------

const ACTIVE_ORG_STATUSES = ['QUEUED', 'RUNNING', 'SCANNING', 'PROPOSING', 'MERGING', 'VALIDATING', 'APPLYING'];

export async function createOrganizationJob(
  scopeType: OrgScopeType,
  scopeId: string,
  triggerReason: string,
  objectId?: string,
  priority?: number,
): Promise<{ jobId: string; reused: boolean }> {
  const active = await prismaUser.organizationJob.findFirst({
    where: { scopeType, scopeId, status: { in: ACTIVE_ORG_STATUSES } },
  });
  if (active) return { jobId: active.id, reused: true };

  const job = await prismaUser.organizationJob.create({
    data: {
      scopeType,
      scopeId,
      objectId: objectId ?? null,
      triggerReason,
      status: 'QUEUED',
      priority: priority ?? 5,
    },
  });
  return { jobId: job.id, reused: false };
}

export async function findOrganizationJob(jobId: string) {
  return prismaUser.organizationJob.findUnique({ where: { id: jobId } });
}

function setJobStatus(jobId: string, status: string, extra?: Record<string, any>): Promise<any> {
  return prismaUser.organizationJob.update({ where: { id: jobId }, data: { status, ...extra } });
}

async function completeOrgJob(jobId: string, resultJson: string): Promise<void> {
  await prismaUser.organizationJob.update({
    where: { id: jobId },
    data: {
      status: 'COMPLETED',
      progress: 100,
      resultJson,
      leaseUntil: null,
      workerId: null,
      completedAt: new Date(),
    },
  });
}

export async function failOrgJob(jobId: string, error: string): Promise<void> {
  const job = await prismaUser.organizationJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  const next = (job.attemptCount ?? 0) + 1;
  const permanent = next >= 3;
  await prismaUser.organizationJob.update({
    where: { id: jobId },
    data: {
      status: permanent ? 'FAILED' : 'RETRYING',
      attemptCount: next,
      lastError: error,
      leaseUntil: null,
      workerId: null,
      ...(permanent ? { completedAt: new Date() } : {}),
    },
  });
  if (!permanent) {
    const delayMs = Math.min(60_000, 1_000 * 2 ** (next - 1));
    setTimeout(() => {
      prismaUser.organizationJob.updateMany({
        where: { id: jobId, status: 'RETRYING' },
        data: { status: 'QUEUED', queuedAt: new Date() },
      }).catch(() => undefined);
    }, delayMs).unref();
  }
}

// ---------------- Trigger detection ----------------

export async function checkOrganizationTrigger(objectId: string): Promise<{ needed: boolean; reason: string }> {
  const [factCount, relationCount, activeFacts] = await Promise.all([
    prismaKnowledge.knowledgeFact.count({ where: { objectId } }),
    prismaKnowledge.knowledgeRelation.count({
      where: { OR: [{ objectId }, { targetId: objectId }] },
    }),
    prismaKnowledge.knowledgeFact.count({ where: { objectId, lifecycleStatus: 'ACTIVE' } }),
  ]);

  const inactive = factCount - activeFacts;
  if (inactive >= 5) {
    return { needed: true, reason: 'ACCUMULATION: 5+ facts in inactive lifecycle states' };
  }
  if (factCount >= 40) {
    return { needed: true, reason: 'ACCUMULATION: 40+ facts accumulated' };
  }
  if (relationCount >= 20) {
    return { needed: true, reason: 'MANY_CHANGES: 20+ relations' };
  }
  return { needed: false, reason: 'below trigger thresholds' };
}

// ---------------- Main execution pipeline ----------------

export interface ExecutionResult {
  ok: boolean;
  jobId: string;
  status: string;
  geminiCallsUsed: number;
  summary: Record<string, any>;
}

export async function executeOrganizationJob(jobId: string): Promise<ExecutionResult> {
  const job = await prismaUser.organizationJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Organization job ${jobId} not found`);

  const scopeType = job.scopeType as OrgScopeType;
  const scopeId = job.scopeId;
  let geminiCallsUsed = 0;
  let snapshot: BuiltSnapshot | null = null;

  const geminiCall = async (prompt: string): Promise<string> => {
    if (!isAgnesAvailable()) {
      throw new Error('Gemini not configured — semantic organization unavailable');
    }
    geminiCallsUsed++;
    return callAgnesForText(prompt, { temperature: 0 });
  };

  try {
    // 1. Immutable snapshot
    await setJobStatus(jobId, 'RUNNING');
    snapshot = await buildSnapshot(scopeType, scopeId);
    await setJobStatus(jobId, 'SCANNING', { snapshotRef: snapshot.id, snapshotHash: snapshot.hash });

    // 2. Structure scan: deterministic always; Gemini only when needed
    const { issues: detIssues, semanticCandidates } = await deterministicScan(snapshot.entities);
    let semanticIssues: OrgIssue[] = [];
    if (needsSemanticScan(semanticCandidates)) {
      semanticIssues = await semanticScan(semanticCandidates, geminiCall);
    }
    const allIssues = [...detIssues, ...semanticIssues];

    // 3. Task split (max 8 workers, deterministic separation)
    await setJobStatus(jobId, 'PROPOSING');
    const { tasks, geminiTasks } = splitTasks(allIssues);

    // 4. Parallel workers: deterministic tasks in code, semantic via Gemini
    const { results, geminiCallsUsed: _w } = await runWorkers(
      tasks,
      geminiTasks,
      snapshot.entities,
      geminiCall,
    );
    void _w;

    // 5. Result pool: cross-worker conflict check + unified merge
    await setJobStatus(jobId, 'MERGING');
    const plan = mergeResults(results as WorkerResult[]);

    // 6. Deterministic pre-checks (no Gemini)
    await setJobStatus(jobId, 'VALIDATING');
    const preCheck = deterministicPreCheck(snapshot.entities, plan);
    if (!preCheck.pass) {
      const result = {
        rejected: true,
        reason: 'deterministic pre-check failed',
        violations: preCheck.violations,
        geminiCallsUsed,
      };
      await completeOrgJob(jobId, JSON.stringify(result));
      return { ok: false, jobId, status: 'COMPLETED', geminiCallsUsed, summary: result as any };
    }

    // 7. Gemini Final Validator — only when actual changes exist
    let validation = { pass: true, called: false, violations: [] as Array<{ changeIndex: number; violation: string }>, notes: 'no changes' };
    if (plan.accepted.length > 0) {
      validation = await geminiFinalValidation(snapshot.entities, plan, geminiCall);
    }
    if (!validation.pass) {
      const result = {
        rejected: true,
        reason: 'final validation failed',
        violations: validation.violations,
        conflicts: plan.conflicts.map((c) => ({ type: c.type, detail: c.detail })),
        rejectedProposals: plan.rejected.length,
        geminiCallsUsed,
      };
      await completeOrgJob(jobId, JSON.stringify(result));
      return { ok: false, jobId, status: 'COMPLETED', geminiCallsUsed, summary: result as any };
    }

    // 8. Apply (single-threaded writer)
    await setJobStatus(jobId, 'APPLYING', { progress: 80 });
    const apply = await applyPlan(job, snapshot, plan, scopeType, scopeId);
    if (!apply.ok) {
      await failOrgJob(jobId, apply.error ?? 'apply failed');
      return { ok: false, jobId, status: 'FAILED', geminiCallsUsed, summary: { applyError: apply.error } };
    }

    // 9. Re-embed only affected facts (unchanged knowledge untouched)
    const affected = collectAffectedFactIds(snapshot.entities, plan.accepted);
    for (const factId of affected) {
      const fact = await prismaKnowledge.knowledgeFact.findUnique({ where: { id: factId } });
      if (fact && fact.lifecycleStatus === 'ACTIVE') {
        await indexKnowledgeChunk(factId, fact.claim);
      }
    }

    // 10. Lifecycle + Accuracy Gate hooks (knowledge self-repair loop).
    //     Gated by KNOWLEDGE_LIFECYCLE_ENABLED so the org pipeline's 8-step
    //     structure (R10) is untouched when the flag is off.
    const lifecycleEnabled = process.env.KNOWLEDGE_LIFECYCLE_ENABLED !== 'false';
    const gateFactIds = [...new Set(affected)];
    let gatedFacts: string[] = [];
    if (lifecycleEnabled && gateFactIds.length > 0) {
      // a) facts whose lifecycle left ACTIVE are frozen out of the refresh
      //    scheduler (D3) without deleting their history (R6).
      for (const p of plan.accepted) {
        if (p.action === 'MARK_LIFECYCLE' && p.targetType === 'fact') {
          const to = String(p.payload?.lifecycleStatus ?? p.payload?.after ?? 'ARCHIVED');
          if (to !== 'ACTIVE') {
            await archiveFactRefreshState(p.targetId).catch(() => undefined);
          }
        }
      }
      // b) newly created facts get their FactRefreshState stamped so the
      //    periodic refresh scheduler can dispatch them (R1).
      for (const p of plan.accepted) {
        if (p.action === 'CREATE_FACT' || p.action === 'SPLIT_FACT') {
          const fact = await prismaKnowledge.knowledgeFact.findUnique({
            where: { id: p.targetId },
            select: { lifecycleStatus: true, verificationStatus: true },
          });
          if (fact) {
            await stampNewFact({
              factId: p.targetId,
              lifecycleStatus: fact.lifecycleStatus,
              verificationStatus: fact.verificationStatus,
              initialIntervalMonths: 1,
            }).catch(() => undefined);
          }
        }
      }
      // c) accuracy gate: only new/changed facts touched by this job (R5.6),
      //    not a whole-DB scan. Non-PASS verdicts open a SelfRepairTask.
      const gateResults = await Promise.allSettled(
        gateFactIds.map(async (factId) => {
          const fact = await prismaKnowledge.knowledgeFact.findUnique({ where: { id: factId } });
          if (!fact) return null;
          const gateResult = await runAccuracyGate({
            fact: {
              id: fact.id,
              claim: fact.claim,
              claimType: fact.claimType,
              verificationStatus: fact.verificationStatus,
              confidence: fact.confidence,
              validTo: fact.validTo,
              createdAt: fact.createdAt,
            },
            evidence: [], // gate pre-filter runs on rule layer when no live evidence
          });
          if (gateResult.verdict === 'PASS') return null;
          const { repairTaskId } = await recordGateDecision({
            factId: fact.id,
            result: gateResult,
            rootTaskId: jobId, // the org job is the repair root for gate-triggered repairs
            triggerType: 'ACCURACY_GATE',
          });
          if (repairTaskId) {
            await dispatchRepairResearch(repairTaskId).catch(() => undefined);
          }
          return fact.id;
        }),
      );
      gatedFacts = gateResults
        .filter((r): r is PromiseFulfilledResult<string | null> => r.status === 'fulfilled' && r.value !== null)
        .map((r) => r.value as string);
    }

    const result = {
      applied: true,
      recordId: apply.recordId,
      changes: apply.changesCount,
      issuesFound: allIssues.length,
      issueTypes: [...new Set(allIssues.map((i) => i.issueType))],
      conflicts: plan.conflicts.length,
      rejectedProposals: plan.rejected.length,
      workersUsed: results.length,
      geminiCallsUsed,
      affectedFactIds: affected,
      afterSnapshot: apply.afterSnapshotRef,
      accuracyGate: { checked: gateFactIds.length, flagged: gatedFacts },
    };
    await completeOrgJob(jobId, JSON.stringify(result));
    return { ok: true, jobId, status: 'COMPLETED', geminiCallsUsed, summary: result as any };
  } catch (err: any) {
    await failOrgJob(jobId, String(err?.message ?? err));
    return {
      ok: false,
      jobId,
      status: 'FAILED',
      geminiCallsUsed,
      summary: { error: String(err?.message ?? err), partial: { snapshot: snapshot?.id ?? null } },
    };
  }
}

/** Facts whose content or links were modified by the plan (candidates for re-embed). */
function collectAffectedFactIds(
  snapshotEntities: any,
  accepted: Array<{ action: string; targetType: string; targetId: string; payload: any }>,
): string[] {
  const ids = new Set<string>();
  const factIds = new Set((snapshotEntities.facts ?? []).map((f: any) => f.id));
  for (const p of accepted) {
    if (p.targetType === 'fact' && factIds.has(p.targetId)) ids.add(p.targetId);
    if (p.action === 'MARK_LIFECYCLE' && p.payload?.mergedInto) ids.add(String(p.payload.mergedInto));
    if (p.action === 'SPLIT_FACT') ids.add(p.targetId);
  }
  return [...ids];
}
