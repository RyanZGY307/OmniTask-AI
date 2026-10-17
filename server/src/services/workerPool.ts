// ================================================================
// Worker Pool — in-process worker with lease/heartbeat.
// Shared global concurrency across research + organization + evolution jobs.
// ================================================================

import { prismaUser } from './db';

const TICK_INTERVAL_MS = 2_000;
const LEASE_DURATION_MS = 5 * 60 * 1_000;

let maxConcurrency: number = parseInt(process.env.RESEARCH_MAX_CONCURRENCY || '5', 10) || 5;

let workerId: string | null = null;
let timer: NodeJS.Timeout | null = null;
let inFlight = 0;

// Job queues share one pool and one global concurrency limit:
// research, organization, evolution, refresh, skill-analysis (S1) and
// M-series model-profile jobs (M1-M6).
type JobKind = 'research' | 'organization' | 'evolution' | 'refresh' | 'skillAnalysis' | 'modelProfile' | 'contextCompression';
export type { JobKind };
type JobExecutor = (job: any) => Promise<void>;
let researchExecutor: JobExecutor = async (job) => {
  await executeResearchJobInternal(job.id);
};
let orgExecutor: JobExecutor = async (job) => {
  await executeOrgJobInternal(job.id);
};
let evolutionExecutor: JobExecutor = async (job) => {
  await executeEvolutionJobInternal(job.id);
};
let refreshExecutor: JobExecutor = async (job) => {
  const mod = await import('./knowledgeLifecycle/refreshWorker');
  await mod.executeRefreshTask(job.id);
};
let skillAnalysisExecutor: JobExecutor = async (job) => {
  const mod = await import('./skillAnalysisWorker');
  await mod.executeSkillAnalysisJob(job.id);
};
const MODEL_PROFILE_CAP = 8;
// M-series jobs are additionally capped at this value; configurable via
// MODEL_PROFILE_MAX_CONCURRENCY (default 8) so batched fan-outs cannot
// starve the research/organization/evolution queues.
let maxModelProfileConcurrency: number = parseInt(process.env.MODEL_PROFILE_MAX_CONCURRENCY || String(MODEL_PROFILE_CAP), 10) || MODEL_PROFILE_CAP;
let modelProfileExecutor: JobExecutor = async (job) => {
  const mod = await import('./modelEvolution/modelProfileJob');
  await mod.executeModelProfileJob(job.id);
};
let contextCompressionExecutor: JobExecutor = async (job) => {
  const mod = await import('./contextMemory/compressionWorker');
  await mod.runCompressionJob(job.id);
};

async function executeResearchJobInternal(jobId: string): Promise<void> {
  const mod = await import('./researchExecutor');
  await mod.executeResearchJob(jobId);
}

async function executeOrgJobInternal(jobId: string): Promise<void> {
  const mod = await import('./knowledgeOrg/orgRuntime');
  await mod.executeOrganizationJob(jobId);
}

async function executeEvolutionJobInternal(job: any): Promise<void> {
  const jobId = typeof job === 'string' ? job : job.id;
  const { completeEvolutionJob, failEvolutionJob } = await import('./evolutionManager');
  const jobRow = await prismaUser.evolutionJob.findUnique({ where: { id: jobId } });
  if (!jobRow) return;
  // Guard: never re-execute a job that reached a terminal state
  // (e.g., claimed concurrently by another runner).
  if (jobRow.status === 'COMPLETED' || jobRow.status === 'FAILED') return;
  const { runEvolutionPipeline } = await import('./evolution');
  // runEvolutionPipeline has an internal try/catch and records its own audit
  // rows; we mirror the terminal state back to the job row.
  try {
    await runEvolutionPipeline(jobRow.userId, jobRow.conversationId, jobRow.region || undefined);
    await completeEvolutionJob(jobId, JSON.stringify({ completedAt: new Date().toISOString() }));
  } catch (err) {
    await failEvolutionJob(jobId, String(err?.message ?? err));
  }
}

export function setJobExecutor(executor: JobExecutor): void {
  researchExecutor = executor;
}

export function setOrgJobExecutor(executor: JobExecutor): void {
  orgExecutor = executor;
}

export function setEvolutionJobExecutor(executor: JobExecutor): void {
  evolutionExecutor = executor;
}

export function setRefreshJobExecutor(executor: JobExecutor): void {
  refreshExecutor = executor;
}

export function setModelProfileJobExecutor(executor: JobExecutor): void {
  modelProfileExecutor = executor;
}

export function setContextCompressionJobExecutor(executor: JobExecutor): void {
  contextCompressionExecutor = executor;
}

function workerName(): string {
  if (!workerId) {
    workerId = `worker-${process.pid}-${Date.now().toString(36)}`;
  }
  return workerId;
}

async function claimNextJob(): Promise<{ job: any; kind: JobKind } | null> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_DURATION_MS);

  // Research keeps historical priority, then organization, then evolution.
  const research = await prismaUser.researchJob.findFirst({
    where: { status: 'QUEUED' },
    orderBy: [{ priority: 'asc' }, { queuedAt: 'asc' }],
    take: 1,
  });
  if (research) {
    const claimed = await prismaUser.researchJob.updateMany({
      where: { id: research.id, status: 'QUEUED' },
      data: { status: 'RUNNING', workerId: workerName(), heartbeatAt: now, leaseUntil, startedAt: research.startedAt ?? now, progress: 0 },
    });
    if (claimed.count === 0) return null;
    const job = await prismaUser.researchJob.findUnique({ where: { id: research.id } });
    return { job, kind: 'research' };
  }

  const org = await prismaUser.organizationJob.findFirst({
    where: { status: 'QUEUED' },
    orderBy: [{ priority: 'asc' }, { queuedAt: 'asc' }],
    take: 1,
  });
  if (org) {
    const claimed = await prismaUser.organizationJob.updateMany({
      where: { id: org.id, status: 'QUEUED' },
      data: { status: 'RUNNING', workerId: workerName(), heartbeatAt: now, leaseUntil, startedAt: org.startedAt ?? now, progress: 0 },
    });
    if (claimed.count === 0) return null;
    const job = await prismaUser.organizationJob.findUnique({ where: { id: org.id } });
    return { job, kind: 'organization' };
  }

  const evolution = await prismaUser.evolutionJob.findFirst({
    where: { status: 'QUEUED' },
    orderBy: [{ priority: 'asc' }, { queuedAt: 'asc' }],
    take: 1,
  });
  if (evolution) {
    const claimed = await prismaUser.evolutionJob.updateMany({
      where: { id: evolution.id, status: 'QUEUED' },
      data: {
        status: 'RUNNING',
        workerId: workerName(),
        heartbeatAt: now,
        leaseUntil,
        startedAt: evolution.startedAt ?? now,
      },
    });
    if (claimed.count === 0) return null;
    const job = await prismaUser.evolutionJob.findUnique({ where: { id: evolution.id } });
    return { job, kind: 'evolution' };
  }

  // Knowledge refresh tasks share the same pool but claim last so that
  // existing research/organization/evolution jobs keep their precedence.
  const refresh = await prismaUser.refreshTask.findFirst({
    where: { status: 'QUEUED' },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    take: 1,
  });
  if (refresh) {
    const claimed = await prismaUser.refreshTask.updateMany({
      where: { id: refresh.id, status: 'QUEUED' },
      data: {
        status: 'RUNNING',
        workerId: workerName(),
        heartbeatAt: now,
        leaseUntil,
        startedAt: refresh.startedAt ?? now,
      },
    });
    if (claimed.count === 0) return null;
    const job = await prismaUser.refreshTask.findUnique({ where: { id: refresh.id } });
    return { job, kind: 'refresh' };
  }

  // S1 skill-analysis jobs claim last of all (lowest precedence).
  const s1 = await prismaUser.skillAnalysisJob.findFirst({
    where: { status: 'QUEUED' },
    orderBy: [{ queuedAt: 'asc' }],
    take: 1,
  });
  if (s1) {
    const claimed = await prismaUser.skillAnalysisJob.updateMany({
      where: { id: s1.id, status: 'QUEUED' },
      data: {
        status: 'RUNNING',
        workerId: workerName(),
        startedAt: s1.startedAt ?? now,
      },
    });
    if (claimed.count === 0) return null;
    const job = await prismaUser.skillAnalysisJob.findUnique({ where: { id: s1.id } });
    return { job, kind: 'skillAnalysis' };
  }

  // M-series model-profile jobs claim last of all (lowest precedence),
  // bounded at maxModelProfileConcurrency so batched M1/M4/M5/M6
  // fan-outs cannot crowd out the other queues.
  const mp = await prismaUser.modelProfileJob.findFirst({
    where: { status: 'QUEUED' },
    orderBy: [{ queuedAt: 'asc' }],
    take: 1,
  });
  if (mp) {
    const modelProfileRunning = await prismaUser.modelProfileJob.count({
      where: { status: 'RUNNING', workerId: workerName() },
    });
    if (modelProfileRunning >= maxModelProfileConcurrency) return null;
    const claimed = await prismaUser.modelProfileJob.updateMany({
      where: { id: mp.id, status: 'QUEUED' },
      data: {
        status: 'RUNNING',
        workerId: workerName(),
        heartbeatAt: now,
        leaseUntil,
      },
    });
    if (claimed.count === 0) return null;
    const job = await prismaUser.modelProfileJob.findUnique({ where: { id: mp.id } });
    return { job, kind: 'modelProfile' };
  }

  // Context-compression jobs claim after model-profile so memory
  // maintenance never starves the AI worker queues.
  const cc = await prismaUser.contextCompressionJob.findFirst({
    where: { status: 'QUEUED' },
    orderBy: [{ queuedAt: 'asc' }],
    take: 1,
  });
  if (cc) {
    const claimed = await prismaUser.contextCompressionJob.updateMany({
      where: { id: cc.id, status: 'QUEUED' },
      data: {
        status: 'RUNNING',
        workerId: workerName(),
        leaseUntil,
      },
    });
    if (claimed.count === 0) return null;
    const job = await prismaUser.contextCompressionJob.findUnique({ where: { id: cc.id } });
    return { job, kind: 'contextCompression' };
  }

  return null;
}

export async function heartbeat(jobId: string, kind: JobKind): Promise<void> {
  const now = new Date();
  const data = { heartbeatAt: now, leaseUntil: new Date(now.getTime() + LEASE_DURATION_MS) } as any;
  if (kind === 'research') {
    await prismaUser.researchJob.updateMany({ where: { id: jobId, status: 'RUNNING' }, data });
  } else if (kind === 'organization') {
    await prismaUser.organizationJob.updateMany({ where: { id: jobId, status: 'RUNNING' }, data });
  } else if (kind === 'refresh') {
    await prismaUser.refreshTask.updateMany({ where: { id: jobId, status: 'RUNNING' }, data });
  } else if (kind === 'skillAnalysis') {
    await prismaUser.skillAnalysisJob.updateMany({ where: { id: jobId, status: 'RUNNING' }, data: { updatedAt: now } });
  } else if (kind === 'modelProfile') {
    await prismaUser.modelProfileJob.updateMany({ where: { id: jobId, status: 'RUNNING' }, data });
  } else if (kind === 'contextCompression') {
    await prismaUser.contextCompressionJob.updateMany({ where: { id: jobId, status: 'RUNNING' }, data: { updatedAt: now } });
  } else {
    await prismaUser.evolutionJob.updateMany({ where: { id: jobId, status: 'RUNNING' }, data });
  }
}

export async function recoverStaleJobs(): Promise<number> {
  const now = new Date();
  const [staleResearch, staleOrg, staleEvolution, staleRefresh, staleModelProfile, staleContextCompression] = await Promise.all([
    prismaUser.researchJob.findMany({ where: { status: 'RUNNING', leaseUntil: { lt: now } } }),
    prismaUser.organizationJob.findMany({ where: { status: 'RUNNING', leaseUntil: { lt: now } } }),
    prismaUser.evolutionJob.findMany({ where: { status: 'RUNNING', leaseUntil: { lt: now } } }),
    prismaUser.refreshTask.findMany({ where: { status: 'RUNNING', leaseUntil: { lt: now } } }),
    prismaUser.modelProfileJob.findMany({ where: { status: 'RUNNING', leaseUntil: { lt: now } } }),
    prismaUser.contextCompressionJob.findMany({ where: { status: 'RUNNING', leaseUntil: { lt: now } } }),
  ]);

  for (const job of staleResearch) {
    await prismaUser.researchJob.update({
      where: { id: job.id },
      data: { status: 'QUEUED', workerId: null, leaseUntil: null, queuedAt: now },
    });
  }
  for (const job of staleOrg) {
    await prismaUser.organizationJob.update({
      where: { id: job.id },
      data: { status: 'QUEUED', workerId: null, leaseUntil: null },
    });
  }
  for (const job of staleEvolution) {
    await prismaUser.evolutionJob.update({
      where: { id: job.id },
      data: { status: 'QUEUED', workerId: null, leaseUntil: null },
    });
  }
  for (const job of staleRefresh) {
    await prismaUser.refreshTask.update({
      where: { id: job.id },
      data: { status: 'QUEUED', workerId: null, leaseUntil: null },
    });
  }
  for (const job of staleModelProfile) {
    await prismaUser.modelProfileJob.update({
      where: { id: job.id },
      data: { status: 'QUEUED', workerId: null, leaseUntil: null, heartbeatAt: null, queuedAt: now },
    });
  }
  for (const job of staleContextCompression) {
    await prismaUser.contextCompressionJob.update({
      where: { id: job.id },
      data: { status: 'QUEUED', workerId: null, leaseUntil: null, queuedAt: now },
    });
  }

  const total = staleResearch.length + staleOrg.length + staleEvolution.length + staleRefresh.length + staleModelProfile.length + staleContextCompression.length;
  if (total > 0) {
    console.log(`[WorkerPool] recovered ${total} stale job(s)`);
  }
  return total;
}

async function executeJob(job: any, kind: JobKind): Promise<void> {
  const executor =
    kind === 'research' ? researchExecutor :
    kind === 'organization' ? orgExecutor :
    kind === 'refresh' ? refreshExecutor :
    kind === 'skillAnalysis' ? skillAnalysisExecutor :
    kind === 'modelProfile' ? modelProfileExecutor :
    kind === 'contextCompression' ? contextCompressionExecutor :
    evolutionExecutor;
  const hb = setInterval(() => {
    heartbeat(job.id, kind).catch(() => undefined);
  }, TICK_INTERVAL_MS * 5);

  try {
    await executor(job);
  } catch {
    // Terminal-state handlers live inside each executor (research / org /
    // evolution) which mark their own job row on failure. Any error that
    // leaks out of an executor is swallowed here so a single bad job can
    // never crash the shared tick loop.
  } finally {
    clearInterval(hb);
  }
}

async function tick(): Promise<void> {
  const [researchRunning, orgRunning, evolutionRunning, refreshRunning, s1Running, mpRunning] = await Promise.all([
    prismaUser.researchJob.count({ where: { status: 'RUNNING', workerId: workerName() } }),
    prismaUser.organizationJob.count({ where: { status: 'RUNNING', workerId: workerName() } }),
    prismaUser.evolutionJob.count({ where: { status: 'RUNNING', workerId: workerName() } }),
    prismaUser.refreshTask.count({ where: { status: 'RUNNING', workerId: workerName() } }),
    prismaUser.skillAnalysisJob.count({ where: { status: 'RUNNING', workerId: workerName() } }),
    prismaUser.modelProfileJob.count({ where: { status: 'RUNNING', workerId: workerName() } }),
  ]);
  // M-series jobs are additionally capped at maxModelProfileConcurrency;
  // clamp their running count so the kind cap is enforced at claim time.
  const running =
    researchRunning + orgRunning + evolutionRunning +
    refreshRunning + s1Running +
    Math.min(mpRunning, maxModelProfileConcurrency);
  const slots = Math.max(0, maxConcurrency - running - inFlight);
  if (slots === 0) return;

  for (let i = 0; i < slots; i++) {
    const claimed = await claimNextJob();
    if (!claimed) break;
    inFlight++;
    executeJob(claimed.job, claimed.kind).finally(() => {
      inFlight--;
    });
  }
}

export function getWorkerStats(): Promise<{
  active: number;
  queued: number;
  completedToday: number;
  failedToday: number;
}> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return Promise.all([
    prismaUser.researchJob.count({ where: { status: 'RUNNING' } }),
    prismaUser.researchJob.count({ where: { status: 'QUEUED' } }),
    prismaUser.researchJob.count({ where: { status: 'COMPLETED', completedAt: { gte: startOfToday } } }),
    prismaUser.researchJob.count({ where: { status: 'FAILED', completedAt: { gte: startOfToday } } }),
  ]).then(([active, queued, completedToday, failedToday]) => ({
    active,
    queued,
    completedToday,
    failedToday,
  }));
}

export async function initWorkerPool(
  config?: { maxConcurrency?: number },
): Promise<void> {
  if (config?.maxConcurrency) maxConcurrency = config.maxConcurrency;

  await recoverStaleJobs();

  if (!timer) {
    workerName();
    console.log(
      `[WorkerPool] started (worker=${workerId}, concurrency=${maxConcurrency}, queues=research+organization+evolution+refresh)`,
    );
    timer = setInterval(() => {
      tick().catch((err) => {
        console.error('[WorkerPool] tick failed:', err?.message ?? err);
      });
    }, TICK_INTERVAL_MS);
    timer.unref();
  }
}

export function stopWorkerPool(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  console.log('[WorkerPool] stopped');
}

export { claimNextJob };
