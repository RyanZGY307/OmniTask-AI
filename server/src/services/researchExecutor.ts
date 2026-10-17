// ================================================================
// Research Executor — Executes a single Research Job
// ================================================================

import { prismaUser } from './db';
import { prismaKnowledge } from './db';
import { collectEvidence } from './evidenceCollector';
import { completeJob, failJob } from './researchManager';
import { heartbeat } from './workerPool';
import { webSearch } from './searchLayer';
import { filterSources, selectTopSources } from './sourceFilter';
import { routeSources } from './sourceRouter';
import { mapConcurrent } from './utils';

// Plan query resolution: prefer the executor-compat field `queries`,
// then the Planner-canonical `searchQueries`, then the legacy fallback.
// This keeps historical jobs (objectType/region/gapDescription only) working.
export function resolveSearchQueries(plan: any): string[] {
  if (Array.isArray(plan?.queries) && plan.queries.length > 0) return plan.queries;
  if (Array.isArray(plan?.searchQueries) && plan.searchQueries.length > 0) return plan.searchQueries;
  return [plan?.objectType || 'default'];
}

// When the plan is Planner-produced (carries sourcePriorities/dimensions),
// let sourceRouter route the plan to prioritized source queries. Merged
// queries are appended to the Planner's own searchQueries (deduped, capped)
// so the executor still searches a bounded, prioritized set. Legacy plans
// without sourcePriorities skip routing entirely (no behavior change).
export function isPlannerPlan(plan: any): boolean {
  return Array.isArray(plan?.sourcePriorities) && plan.sourcePriorities.length > 0;
}

export function expandQueriesWithRouting(baseQueries: string[], plan: any, object: any): string[] {
  if (!isPlannerPlan(plan)) return baseQueries;
  try {
    const routes = routeSources(plan, object);
    const routed: string[] = [];
    for (const r of routes) {
      for (const q of r.queries ?? []) {
        if (q && q.trim()) routed.push(q.trim());
      }
    }
    // Dedupe against base queries, cap total to keep executor bounded.
    const merged = new Set<string>(baseQueries);
    for (const q of routed) merged.add(q);
    return Array.from(merged).slice(0, 8);
  } catch {
    // Routing is a best-effort enhancement; never fail the job for it.
    return baseQueries;
  }
}

export async function executeResearchJob(jobId: string): Promise<void> {
  const job = await prismaUser.researchJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  // Guard: never re-execute a job that reached a terminal state
  // (e.g., claimed concurrently by another runner).
  if (job.status === 'COMPLETED' || job.status === 'FAILED') return;

  // Correction-verification jobs are routed to the dedicated verifier,
  // which reuses the same bounded web pipeline and writes a 7-state
  // verdict back to the CorrectionEvent. No second verification system.
  if (job.jobType === 'correction_verification') {
    const { executeCorrectionVerificationJob } = await import('./contextMemory/verification');
    await executeCorrectionVerificationJob(jobId);
    return;
  }

  // Parse plan
  let plan: any = {};
  try { plan = JSON.parse(job.planJson || '{}'); } catch {}

  // Phase 1: Search sources
  await prismaUser.researchJob.update({ where: { id: jobId }, data: { status: 'COLLECTING' } });

  const baseQueries = resolveSearchQueries(plan).slice(0, 5);
  // Planner-backed plans: expand the query set via sourceRouter routing.
  // Legacy plans pass through unchanged.
  const searchQueries = expandQueriesWithRouting(
    baseQueries,
    plan,
    {
      id: job.objectId,
      objectType: String(plan?.objectType ?? job.objectId ?? ''),
      title: String(plan?.objectName ?? plan?.objectType ?? job.objectId ?? ''),
    },
  ).slice(0, 5);
  const allResults: any[] = [];

  // R8: bounded-concurrent query fan-out (limit 3) instead of serial await;
  // independent queries share the key pool with no shared state. A per-query
  // failure never aborts the batch — mapConcurrent yields null for it.
  const QUERY_CONCURRENCY = 3;
  // 按需选择搜索引擎：plan 可指定 'perplexity'/'tavily'/'duckduckgo'/'google'，默认 'auto'。
  const engine = (['auto', 'perplexity', 'tavily', 'duckduckgo', 'google'] as const).includes(plan?.searchEngine) ? plan.searchEngine : undefined;
  const perQuery = await mapConcurrent(searchQueries.slice(0, 5), QUERY_CONCURRENCY, async (query) => {
    try {
      return await webSearch(query, { maxResults: 10, engine });
    } catch (err: any) {
      console.warn(`[Research] Search failed for "${query}": ${err.message}`);
      return null;
    }
  });
  for (const r of perQuery) {
    if (Array.isArray(r)) allResults.push(...r);
  }

  // Phase 2: Filter and select
  const filtered = filterSources(allResults);
  const selected = selectTopSources(filtered, 3, 8);

  // Phase 3: Collect evidence
  await prismaUser.researchJob.update({ where: { id: jobId }, data: { status: 'ANALYZING' } });

  // 研究记录必须先的在写入证据：Evidence.researchRecordId 是对
  // ResearchRecord 的外键，先建 PENDING 记录才能让证据落库。
  // objectId 缺失的老任务没有可挂靠的对象，证据走 researchRecordId=null 的遗留路径。
  const record = job.objectId
    ? await prismaKnowledge.researchRecord.create({
        data: {
          objectId: job.objectId,
          variantId: job.variantId ?? null,
          researchScope: String(plan?.researchScope || plan?.gapDescription || 'general knowledge research'),
          researchPlanJson: job.planJson || '{}',
          status: 'PENDING',
        },
      })
    : null;
  const evidence = await collectEvidence(selected, record?.id ?? null, job.variantId ?? null);

  // Phase 4: Write into knowledge DB（自补缺落库：证据→事实）+ complete
  await prismaUser.researchJob.update({ where: { id: jobId }, data: { status: 'WRITING' } });
  let fill: any = null;
  if (record) {
    try {
      const { fillFromResearch } = await import('./researchFill');
      fill = await fillFromResearch({
        jobId,
        recordId: record.id,
        objectId: job.objectId,
        variantId: job.variantId ?? null,
        plan,
        evidence,
      });
    } catch (err: any) {
      console.warn(`[Research] fillFromResearch failed for job ${jobId}:`, err?.message);
      await prismaKnowledge.researchRecord.updateMany({
        where: { id: record.id, status: 'PENDING' },
        data: { status: 'FAILED', completedAt: new Date() },
      });
    }
  }
  const resultJson = JSON.stringify({
    sourcesCount: selected.length,
    evidenceCount: evidence.length,
    factsWritten: fill?.factsWritten ?? 0,
    blindSpotsResolved: fill?.blindSpotsResolved ?? 0,
    orgTriggered: fill?.orgTriggered ?? false,
    plan,
  });

  await completeJob(jobId, resultJson);

  // Self-repair closed loop (R3): if this research job was spawned by a
  // SelfRepairTask (lineage on rootTaskId), route its evidence back through
  // the repair ingest so the fact gets cross-validated, written, and the
  // repair task resolved / escalated / terminated.
  if (job.rootTaskId) {
    try {
      const { ingestRepairEvidence } = await import('./knowledgeLifecycle/repairIngest');
      await ingestRepairEvidence(jobId);
    } catch (err) {
      console.warn(`[Research] repair ingest failed for job ${jobId}:`, (err as any)?.message);
    }
  }
}

export async function heartbeatForJob(jobId: string): Promise<void> {
  await heartbeat(jobId, 'research');
}
