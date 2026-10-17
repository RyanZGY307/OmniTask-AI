// ================================================================
// Refresh Scheduler — scans FactRefreshState and dispatches RefreshTask
// rows (R2). Idempotent via the @@unique(factId, refreshCycle) key, so
// two scheduler ticks in the same cycle never double-dispatch a fact.
// D3: only refreshable rows are ever dispatched.
// ================================================================

import { prismaKnowledge, prismaUser } from '../db';
import { currentCycleStr, isRefreshDispatchable } from './adaptiveInterval';

export interface DispatchResult {
  cycle: string;
  dispatched: number;
  skipped: number;
}

// Scan due + dispatchable refresh states and enqueue one RefreshTask each.
// `limit` bounds a single tick so a huge backlog cannot flood the pool.
export async function runRefreshScheduler(limit = 200): Promise<DispatchResult> {
  const now = new Date();
  const cycle = currentCycleStr(now);

  // FactRefreshState and KnowledgeFact are both in the Knowledge DB;
  // join to apply the D3 lifecycle/verification filter in one pass.
  const due = await prismaKnowledge.factRefreshState.findMany({
    where: {
      nextRefreshAt: { lte: now },
      archived: false,
    },
    select: {
      factId: true,
      refreshIntervalMonths: true,
      priority: true,
      consecutiveFailureCount: true,
      unchangedStreak: true,
      lastRefreshStatus: true,
      lastRefreshAt: true,
      pausedUntil: true,
      archived: true,
    },
    orderBy: [{ priority: 'asc' }, { nextRefreshAt: 'asc' }],
    take: limit,
  });

  let dispatched = 0;
  let skipped = 0;

  for (const state of due) {
    if (state.pausedUntil && state.pausedUntil.getTime() > now.getTime()) {
      skipped++;
      continue;
    }

    const fact = await prismaKnowledge.knowledgeFact.findUnique({
      where: { id: state.factId },
      select: { lifecycleStatus: true, verificationStatus: true },
    });
    if (!fact) { skipped++; continue; }

    const dispatchable = isRefreshDispatchable({
      archived: state.archived,
      pausedUntil: state.pausedUntil,
      lifecycleStatus: fact.lifecycleStatus,
      verificationStatus: fact.verificationStatus,
    });
    if (!dispatchable) {
      // D3: freeze dispatch for out-of-scope facts
      await prismaKnowledge.factRefreshState.update({
        where: { factId: state.factId },
        data: { archived: true },
      });
      skipped++;
      continue;
    }

    // Idempotent enqueue: skip if this (fact, cycle) is already queued/running.
    const existing = await prismaUser.refreshTask.findUnique({
      where: { factId_refreshCycle: { factId: state.factId, refreshCycle: cycle } },
    });
    if (existing && ['QUEUED', 'RUNNING', 'UNCHANGED', 'MINOR_CHANGE', 'MATERIAL_CHANGE', 'CONFLICT', 'SOURCE_GONE', 'UNVERIFIED'].includes(existing.status)) {
      skipped++;
      continue;
    }

    if (existing) {
      // a terminal REFRESH_FAILED from an earlier attempt this cycle -> allow retry
      await prismaUser.refreshTask.update({
        where: { id: existing.id },
        data: { status: 'QUEUED', priority: state.priority, attemptCount: existing.attemptCount },
      });
    } else {
      await prismaUser.refreshTask.create({
        data: {
          factId: state.factId,
          refreshCycle: cycle,
          status: 'QUEUED',
          priority: state.priority,
          prevIntervalMonths: state.refreshIntervalMonths,
        },
      });
    }
    dispatched++;
  }

  return { cycle, dispatched, skipped };
}

// Pick the next batch of queued refresh tasks for the worker pool (R8.3).
// Returns task ids; the pool claims + executes them.
export async function claimRefreshTasks(slots: number, workerId: string): Promise<string[]> {
  if (slots <= 0) return [];
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 5 * 60 * 1000);

  const tasks = await prismaUser.refreshTask.findMany({
    where: { status: 'QUEUED' },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    take: slots,
  });
  for (const t of tasks) {
    await prismaUser.refreshTask.updateMany({
      where: { id: t.id, status: 'QUEUED' },
      data: {
        status: 'RUNNING',
        workerId,
        heartbeatAt: now,
        leaseUntil,
        startedAt: t.startedAt ?? now,
        attemptCount: t.attemptCount + 1,
      },
    });
  }
  return tasks.map((t) => t.id);
}
