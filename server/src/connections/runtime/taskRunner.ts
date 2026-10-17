// ================================================================
// Universal Connect Runtime v2 — Task Runner
// Long-running task state machine with checkpoint/resume
// ================================================================

import { prisma } from '../../services/db';
import type { TaskStatus } from '../types';

export interface TaskRunInput {
  userId: string;
  conversationId?: string;
  title?: string;
  providerId?: string;
  connectionId?: string;
  taskType: string;
  description?: string;
  timeoutMinutes?: number;
}

export interface TaskRunResult {
  id: string;
  status: TaskStatus;
  progress: number;
  result?: any;
  error?: string;
  checkpoint?: any;
}

export async function createTaskRun(input: TaskRunInput): Promise<TaskRunResult> {
  const timeoutAt = input.timeoutMinutes
    ? new Date(Date.now() + input.timeoutMinutes * 60 * 1000)
    : null;

  const run = await prisma.taskRun.create({
    data: {
      userId: input.userId,
      conversationId: input.conversationId,
      title: input.title,
      providerId: input.providerId,
      connectionId: input.connectionId,
      taskType: input.taskType,
      status: 'created',
      progress: 0,
      timeoutAt,
    },
  });

  return toResult(run);
}

export async function updateTaskRun(
  runId: string,
  userId: string,
  updates: Partial<Pick<TaskRunResult, 'status' | 'progress' | 'result' | 'error' | 'checkpoint'>>,
): Promise<TaskRunResult> {
  const run = await prisma.taskRun.findFirst({ where: { id: runId, userId } });
  if (!run) throw new Error('Task not found');

  const updated = await prisma.taskRun.update({
    where: { id: runId },
    data: {
      ...updates,
      updatedAt: new Date(),
      ...(updates.status === 'completed' ? { completedAt: new Date() } : {}),
      ...(updates.status === 'failed' ? { completedAt: new Date() } : {}),
    },
  });

  return toResult(updated);
}

export async function pauseTaskRun(runId: string, userId: string): Promise<TaskRunResult> {
  return updateTaskRun(runId, userId, { status: 'paused' as TaskStatus });
}

export async function resumeTaskRun(runId: string, userId: string): Promise<TaskRunResult> {
  const run = await prisma.taskRun.findFirst({ where: { id: runId, userId, status: 'paused' } });
  if (!run) throw new Error('Task not found or not paused');
  return updateTaskRun(runId, userId, { status: 'resuming' as TaskStatus });
}

export async function cancelTaskRun(runId: string, userId: string): Promise<TaskRunResult> {
  return updateTaskRun(runId, userId, { status: 'cancelled' as TaskStatus });
}

export async function timeoutTaskRun(runId: string, userId: string): Promise<TaskRunResult> {
  return updateTaskRun(runId, userId, { status: 'timeout' as TaskStatus, error: 'Task timed out' });
}

export async function listUserTasks(userId: string, limit = 20): Promise<TaskRunResult[]> {
  const runs = await prisma.taskRun.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return runs.map(toResult);
}

export async function findPendingTasks(userId: string): Promise<TaskRunResult[]> {
  const now = new Date();
  const runs = await prisma.taskRun.findMany({
    where: {
      userId,
      status: { in: ['created', 'queued', 'running', 'waiting_approval', 'waiting_auth'] },
      timeoutAt: { gte: now },
    },
    orderBy: { createdAt: 'asc' },
  });
  return runs.map(toResult);
}

export async function cleanupExpiredTasks(userId: string): Promise<number> {
  const expired = await prisma.taskRun.updateMany({
    where: {
      userId,
      status: { in: ['created', 'queued', 'running', 'waiting_approval', 'waiting_auth'] },
      timeoutAt: { lt: new Date() },
    },
    data: { status: 'timeout' as TaskStatus, error: 'Task expired' },
  });
  return expired.count;
}

function toResult(run: any): TaskRunResult {
  return {
    id: run.id,
    status: run.status as TaskStatus,
    progress: run.progress || 0,
    result: run.result,
    error: run.error,
    checkpoint: run.checkpoint,
  };
}
