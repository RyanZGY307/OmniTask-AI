// ================================================================
// 对话记忆压缩任务派发器（后台执行）
//
// 为什么独立于 workerPool：workerPool 的 JobKind 对应的是 user 库里的
// researchJob / organizationJob / modelProfileJob 等表，而本任务的表在
// conversation 库（ContextCompressionTask），两者的租约/心跳/失败语义不同。
// 复用 workerPool 会需要改动它的全部查询路径，风险大于收益，故按同样范式
// 独立实现：轮询取任务 + 租约防并发 + 有界并发 + 启动恢复 + 幂等重入。
//
// 幂等与可恢复（任务书 5.10）：
//   - runCompressionTask 已保证 COMPLETED 可直接返回、分段结果可复用；
//   - 租约过期后任务回到 QUEUED 而不是卡死，进程重启也不会丢失任务。
// ================================================================

import { prismaConversation } from '../db';
import { runCompressionTask, ACTIVE_TASK_STATUSES, type TaskStatus } from './index';

/** 租约时长：一次分段压缩 + 合并可能跨多个模型调用，给足时间 */
const LEASE_MS = 5 * 60 * 1000;
/** 单进程并发上限：避免压缩任务挤占推理资源（同时仍在跑的用户聊天优先） */
const MAX_CONCURRENCY = Number(process.env.MEMORY_COMPRESSION_CONCURRENCY || 2);
/** 空闲轮询间隔 */
const POLL_IDLE_MS = Number(process.env.MEMORY_COMPRESSION_POLL_IDLE_MS || 5000);
/** 有任务时的轮询间隔 */
const POLL_BUSY_MS = 1500;

let running = 0;
let timer: NodeJS.Timeout | null = null;
let started = false;
const leaseUntilOf = new Map<string, Date>();

/**
 * 取一个可执行任务。
 *
 * 并发控制（任务书 10.3）的两个层次：
 *   1. 同一对话同时只允许一个活动任务 —— 由 enqueueIfIdle 在创建时保证。
 *   2. 同一任务不被两个 worker 同时执行 —— 由本函数的租约保证。
 * 这里用 updateMany 做 CAS：只有 status 还是 PENDING（或 QUEUED）时才抢占。
 */
async function claimTask(): Promise<string | null> {
  const now = new Date();
  const lease = new Date(now.getTime() + LEASE_MS);
  const candidates = await prismaConversation.contextCompressionTask.findMany({
    where: {
      status: { in: ['PENDING', 'QUEUED'] },
      OR: [
        // 未启动过
        { startedAt: null },
        // 或租约已过期（上一个 worker 挂了）
        { startedAt: { lt: new Date(now.getTime() - LEASE_MS) } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_CONCURRENCY,
    select: { id: true, status: true },
  });

  for (const t of candidates) {
    // CAS：只接受仍处于可领取状态的任务。若另一进程抢先，count 为 0 就跳过。
    const claimed = await prismaConversation.contextCompressionTask.updateMany({
      where: { id: t.id, status: { in: ['PENDING', 'QUEUED'] } },
      data: { status: 'RUNNING', startedAt: now },
    });
    if (claimed.count === 1) {
      leaseUntilOf.set(t.id, lease);
      return t.id;
    }
  }
  return null;
}

function schedule(delayMs: number): void {
  if (!started) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    await loop();
  }, delayMs);
  timer.unref?.();
}

async function loop(): Promise<void> {
  if (!started) return;
  const pending = await prismaConversation.contextCompressionTask.count({
    where: { status: { in: ['PENDING', 'QUEUED'] } },
  }).catch(() => 0);
  while (running < MAX_CONCURRENCY) {
    const id = await claimTask().catch(() => null);
    if (!id) break;
    running++;
    const taskId = id;
    void (async () => {
      try {
        const res = await runCompressionTask(taskId);
        if (!res.ok) console.warn(`[MemoryWorker] task ${taskId} failed: ${res.error}`);
      } catch (err: any) {
        console.error(`[MemoryWorker] task ${taskId} threw: ${err?.message}`);
        await prismaConversation.contextCompressionTask.updateMany({
          where: { id: taskId, status: { in: ACTIVE_TASK_STATUSES } },
          data: { status: 'FAILED', errorDetails: `worker 未捕获异常: ${String(err?.message || err).slice(0, 500)}`, completedAt: new Date() },
        }).catch(() => undefined);
      } finally {
        leaseUntilOf.delete(taskId);
        running--;
      }
    })();
  }
  const hasMore = pending > 0 || running > 0;
  schedule(hasMore ? POLL_BUSY_MS : POLL_IDLE_MS);
}

/**
 * 启动恢复（任务书 5.10 / 十章）：进程重启后，之前处于活动状态但未完成的任务
 * 必须能继续。这里把"活动但租约过期"的任务重新置为可领取。
 *
 * 注意不是无条件把所有活动任务重置：刚被本进程其他 pump 抢占的任务会被
 * updateMany 的 status 条件挡掉。
 */
export async function recoverInterruptedTasks(): Promise<number> {
  const staleBefore = new Date(Date.now() - LEASE_MS);
  const res = await prismaConversation.contextCompressionTask.updateMany({
    where: {
      status: 'RUNNING',
      OR: [{ startedAt: null }, { startedAt: { lt: staleBefore } }],
    },
    data: { status: 'PENDING' },
  });
  if (res.count > 0) {
    console.log(`[MemoryWorker] recovered ${res.count} interrupted task(s)`);
  }
  return res.count;
}

export function startMemoryCompressionWorker(): void {
  if (started) return;
  started = true;
  void (async () => {
    try {
      await recoverInterruptedTasks();
    } catch (err: any) {
      console.warn('[MemoryWorker] recover failed:', err?.message);
    }
    await loop();
  })();
  console.log(`[MemoryWorker] started (concurrency=${MAX_CONCURRENCY}, idle=${POLL_IDLE_MS}ms)`);
}

export function stopMemoryCompressionWorker(): void {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** 立即执行某任务（管理界面"手动触发压缩"用；与轮询共用同一并发上限） */
export async function runTaskNow(taskId: string) {
  return runCompressionTask(taskId);
}

export function getMemoryWorkerStats() {
  return {
    running,
    queued: leaseUntilOf.size,
    concurrency: MAX_CONCURRENCY,
    leaseMs: LEASE_MS,
    started,
  };
}

export type { TaskStatus };
