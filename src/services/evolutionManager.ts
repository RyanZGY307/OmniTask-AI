// ================================================================
// Evolution Manager — enqueue/dedupe/terminal-state for EvolutionJob
// ================================================================
// Background evolution pipeline jobs. The pipeline itself
// (runEvolutionPipeline) reads recent conversation messages at
// execution time; this module only manages the job row lifecycle.

import { prismaUser } from './db';

const ACTIVE_STATUSES = ['QUEUED', 'RUNNING'];

// Dedupe window: a job for the same (userId, conversationId) enqueued within
// this window is skipped if one is already active or recently completed.
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

export interface EnqueueEvolutionResult {
  jobId: string;
  deduped: boolean;
}

export async function enqueueEvolutionPipelineJob(
  userId: string,
  conversationId: string,
  region?: string,
): Promise<EnqueueEvolutionResult> {
  // Dedupe: one active OR recently-finished job per (user, conversation).
  const windowStart = new Date(Date.now() - DEDUPE_WINDOW_MS);
  const existing = await prismaUser.evolutionJob.findFirst({
    where: {
      userId,
      conversationId,
      OR: [
        { status: { in: ACTIVE_STATUSES } },
        { status: 'COMPLETED', completedAt: { gte: windowStart } },
        { status: 'FAILED', completedAt: { gte: windowStart } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 1,
  });
  if (existing) {
    return { jobId: existing.id, deduped: true };
  }

  const job = await prismaUser.evolutionJob.create({
    data: {
      userId,
      conversationId,
      region: region ?? null,
      status: 'QUEUED',
    },
  });
  return { jobId: job.id, deduped: false };
}

export async function completeEvolutionJob(jobId: string, resultJson: string): Promise<void> {
  await prismaUser.evolutionJob.update({
    where: { id: jobId },
    data: {
      status: 'COMPLETED',
      resultJson,
      leaseUntil: null,
      workerId: null,
      completedAt: new Date(),
    },
  });
}

export async function failEvolutionJob(jobId: string, error: string): Promise<void> {
  await prismaUser.evolutionJob.update({
    where: { id: jobId },
    data: {
      status: 'FAILED',
      lastError: error,
      leaseUntil: null,
      workerId: null,
      completedAt: new Date(),
    },
  });
}

export async function findEvolutionJob(jobId: string): Promise<any | null> {
  return prismaUser.evolutionJob.findUnique({ where: { id: jobId } });
}
