// ================================================================
// Model Profile Jobs — persistent-queue executor for the M-series
// background workers. Called by the workerPool tick; claims a queued
// row, runs the right executor per jobKind (model_profile / model_
// scenario -> M1 shared path, drift_reeval -> M4, outcome -> M5,
// attribution -> M6), and records the terminal state.
// ================================================================

import { prismaUser } from '../db';
import { executeM1Job } from './m1Profiler';
import { executeM4Job } from './m4DriftReeval';
import { executeM5Job } from './m5Outcome';
import { executeM6Job } from './m6Attribution';

export interface ModelProfileJobResult {
  jobId: string;
  ok: boolean;
  jobKind: string;
  error?: string;
}

export async function executeModelProfileJob(jobId: string): Promise<ModelProfileJobResult> {
  const job = await prismaUser.modelProfileJob.findUnique({ where: { id: jobId } });
  if (!job) return { jobId, ok: false, jobKind: '', error: 'job not found' };
  // Terminal guard: never re-run a completed/failed row.
  if (job.status === 'COMPLETED' || job.status === 'FAILED') {
    return { jobId, ok: false, jobKind: job.jobKind, error: `already ${job.status}` };
  }

  try {
    switch (job.jobKind) {
      case 'model_profile':
      case 'model_scenario':
        await executeM1Job(jobId);
        break;
      case 'drift_reeval':
        await executeM4Job(jobId);
        break;
      case 'outcome':
        await executeM5Job(jobId);
        break;
      case 'attribution':
        await executeM6Job(jobId);
        break;
      default:
        await markFailed(jobId, `unknown jobKind: ${job.jobKind}`);
        return { jobId, ok: false, jobKind: job.jobKind, error: `unknown jobKind: ${job.jobKind}` };
    }
  } catch (err: any) {
    // Executor-level failure: the M executors catch their own parse/API
    // errors and mark FAILED. Anything that leaks out (DB errors,
    // unexpected throws) is recorded the same way so the row reaches
    // a terminal state and the pool does not re-claim it forever.
    await markFailed(jobId, String(err?.message ?? err));
    return { jobId, ok: false, jobKind: job.jobKind, error: String(err?.message ?? err) };
  }

  const done = await prismaUser.modelProfileJob.findUnique({ where: { id: jobId } });
  const ok = done?.status === 'COMPLETED';
  return { jobId, ok, jobKind: job.jobKind, error: ok ? undefined : done?.lastError ?? 'job not completed' };
}

async function markFailed(jobId: string, reason: string): Promise<void> {
  await prismaUser.modelProfileJob.update({
    where: { id: jobId },
    data: {
      status: 'FAILED',
      lastError: reason.slice(0, 2000),
      attemptCount: { increment: 1 },
      completedAt: new Date(),
    },
  }).catch(() => undefined);
}

// Retrying policy: a FAILED row whose attemptCount is below the cap is
// re-queued by the pool on the next tick. Retry happens at claim time:
// the pool only claims status=QUEUED rows, so this helper re-queues a
// failed job explicitly.
export async function retryModelProfileJob(jobId: string): Promise<void> {
  const job = await prismaUser.modelProfileJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'FAILED') return;
  const MAX_ATTEMPTS = 3;
  if (job.attemptCount >= MAX_ATTEMPTS) return;
  await prismaUser.modelProfileJob.update({
    where: { id: jobId },
    data: { status: 'QUEUED', workerId: null, leaseUntil: null, heartbeatAt: null, queuedAt: new Date() },
  }).catch(() => undefined);
}
