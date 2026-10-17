// ================================================================
// Research Manager — create/reuse research jobs (System DB)
// ================================================================

import { prismaUser, prismaKnowledge } from './db';
import { planResearch, type ResearchPlan } from './researchPlanner';

const ACTIVE_STATUSES = ['QUEUED', 'RUNNING', 'COLLECTING'];
const MAX_ATTEMPTS = 3;

export async function createResearchJob(
  objectId: string,
  variantId: string | null,
  jobType: string,
  priority?: number,
  planJson?: string,
): Promise<string> {
  const job = await prismaUser.researchJob.create({
    data: {
      objectId,
      variantId: variantId ?? null,
      jobType,
      status: 'QUEUED',
      priority: priority ?? 5,
      planJson: planJson ?? null,
    },
  });
  return job.id;
}

export async function findActiveJob(
  objectId: string,
  variantId?: string,
  jobType?: string,
): Promise<any | null> {
  return prismaUser.researchJob.findFirst({
    where: {
      objectId,
      variantId: variantId || null,
      ...(jobType ? { jobType } : {}),
      status: { in: ACTIVE_STATUSES },
    },
    orderBy: [{ priority: 'asc' }, { queuedAt: 'asc' }],
  });
}

export async function reuseOrCreateJob(
  objectId: string,
  variantId: string | null,
  jobType: string,
  gapDescription: string,
  opts?: { region?: string },
): Promise<{ jobId: string; reused: boolean }> {
  const active = await findActiveJob(objectId, variantId || undefined, jobType);
  if (active) {
    return { jobId: active.id, reused: true };
  }
  const planJson = await buildPlannerJobPlan(objectId, gapDescription, opts?.region);
  const jobId = await createResearchJob(objectId, variantId, jobType, 5, planJson);
  return { jobId, reused: false };
}

// Build a full Planner-backed planJson for a new job. Fetches the knowledge
// object + existing facts to feed planResearch; degrades to a minimal plan
// (queries + legacy fields) when the Planner or lookups are unavailable so a
// job can always be created and executed.
// Build a full Planner-backed planJson for a new job. Fetches the knowledge
// object + existing facts to feed planResearch; degrades to a minimal plan
// (queries + legacy fields) when the Planner or lookups are unavailable so a
// job can always be created and executed.
async function buildPlannerJobPlan(objectId: string, gapDescription: string, region?: string): Promise<string> {
  let object: any = null;
  let existingFacts: any[] = [];
  try {
    object = await prismaKnowledge.knowledgeObject.findUnique({ where: { id: objectId } });
    existingFacts = await prismaKnowledge.knowledgeFact.findMany({
      where: { objectId, lifecycleStatus: 'ACTIVE' },
      select: { claimType: true },
      take: 200,
    });
  } catch {
    // Lookups failed: fall through to the minimal legacy plan below.
  }

  let planJson: string;
  try {
    const plan = await planResearch(
      object ?? { id: objectId, objectType: 'general', title: gapDescription },
      { gapDescription },
      existingFacts,
      region ? { region } : undefined,
    );
    // Persist the full ResearchPlan plus the executor-compat `queries` field.
    const payload: Record<string, unknown> = {
      ...(plan as unknown as Record<string, unknown>),
      queries: plan.searchQueries,
      gapDescription,
      plannedAt: new Date().toISOString(),
    };
    planJson = JSON.stringify(payload);
  } catch (err) {
    // Planner unavailable: keep the legacy minimal shape so the executor's
    // fallback (objectType → 'default') still works.
    planJson = JSON.stringify({
      gapDescription,
      queries: [gapDescription],
      plannedAt: new Date().toISOString(),
    });
  }
  return planJson;
}

export async function completeJob(jobId: string, resultJson: string): Promise<void> {
  await prismaUser.researchJob.update({
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

export async function failJob(jobId: string, error: string): Promise<void> {
  const job = await prismaUser.researchJob.findUnique({ where: { id: jobId } });
  if (!job) return;

  const nextAttempt = (job.attemptCount ?? 0) + 1;
  const failedPermanently = nextAttempt >= MAX_ATTEMPTS;

  await prismaUser.researchJob.update({
    where: { id: jobId },
    data: {
      status: failedPermanently ? 'FAILED' : 'RETRYING',
      attemptCount: nextAttempt,
      lastError: error,
      leaseUntil: null,
      workerId: null,
      ...(failedPermanently ? { completedAt: new Date() } : {}),
    },
  });

  if (!failedPermanently) {
    const delayMs = Math.min(60_000, 1_000 * 2 ** (nextAttempt - 1));
    setTimeout(() => {
      prismaUser.researchJob
        .updateMany({
          where: { id: jobId, status: 'RETRYING' },
          data: { status: 'QUEUED', queuedAt: new Date() },
        })
        .catch(() => undefined);
    }, delayMs).unref();
  }
}

export async function findResearchJob(jobId: string): Promise<any | null> {
  return prismaUser.researchJob.findUnique({ where: { id: jobId } });
}

/**
 * Atomically claim a QUEUED job for foreground execution.
 * Prevents the background worker pool from picking up the same job
 * while the caller is running it inline. Returns true only if the
 * caller won the claim.
 */
export async function claimResearchJobForForeground(jobId: string): Promise<boolean> {
  const leaseUntil = new Date(Date.now() + 15 * 60 * 1000);
  const claimed = await prismaUser.researchJob.updateMany({
    where: { id: jobId, status: 'QUEUED' },
    data: {
      status: 'RUNNING',
      workerId: 'foreground',
      heartbeatAt: new Date(),
      leaseUntil,
      startedAt: new Date(),
      progress: 0,
    },
  });
  return claimed.count === 1;
}

export async function listQueues(): Promise<Array<{ objectId: string; pending: number; inFlight: number; failed: number }>> {
  const all = await prismaUser.researchJob.findMany({
    where: { status: { in: ['QUEUED', 'RUNNING', 'FAILED'] } },
    select: { objectId: true, status: true },
  });
  const map = new Map<string, { pending: number; inFlight: number; failed: number }>();
  for (const r of all) {
    const key = r.objectId || 'unknown';
    const entry = map.get(key) ?? { pending: 0, inFlight: 0, failed: 0 };
    if (r.status === 'QUEUED') entry.pending++;
    else if (r.status === 'RUNNING') entry.inFlight++;
    else if (r.status === 'FAILED') entry.failed++;
    map.set(key, entry);
  }
  return Array.from(map.entries()).map(([objectId, counts]) => ({ objectId, ...counts }));
}
