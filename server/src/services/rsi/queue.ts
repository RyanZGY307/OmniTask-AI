// ================================================================
// RSI 任务入队（RsiJob 表，与 researchJob/evolutionJob 同库同语义）。
// 只提供入队；执行由 workerPool 的 rsi executor 完成。
// ================================================================

import { prismaUser } from '../db';

export type RsiJobKind = 'signal_scan' | 'rsi_run' | 'rollout_check';

export async function enqueueRsiJob(kind: RsiJobKind, payload?: Record<string, unknown>): Promise<string> {
  const row = await prismaUser.rsiJob.create({
    data: {
      kind,
      payload: payload ? JSON.stringify(payload).slice(0, 5000) : null,
      priority: kind === 'signal_scan' ? 8 : 5,
      status: 'QUEUED',
    },
  });
  return row.id;
}

export async function completeRsiJob(id: string, result?: Record<string, unknown>): Promise<void> {
  try {
    await prismaUser.rsiJob.updateMany({
      where: { id, status: 'RUNNING' },
      data: { status: 'COMPLETED', completedAt: new Date(), resultJson: result ? JSON.stringify(result).slice(0, 5000) : null },
    });
  } catch { /* 终态由 worker 负责 */ }
}

export async function failRsiJob(id: string, error: string): Promise<void> {
  try {
    await prismaUser.rsiJob.updateMany({
      where: { id, status: 'RUNNING' },
      data: { status: 'FAILED', completedAt: new Date(), lastError: error.slice(0, 500) },
    });
  } catch { /* noop */ }
}
