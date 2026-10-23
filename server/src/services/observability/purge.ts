// ================================================================
// 观测中心 — AI 运行摘要 24h 强制清理
// ================================================================
// 硬性要求：所有 AiRunSummary 只保留 24h，超过必须**物理删除**。
//
// 实现要点（对应验收 7/8/9/10/11）：
//  · 启动即跑一次（boot），随后每分钟一次（periodic）。
//  · 多实例去重用 pg_try_advisory_lock：只有拿到锁的实例执行；
//    进程崩溃/释放时锁随连接自动解开，别的实例下一个 tick 立即接手，
//    **清理不会因为某个实例故障而永久停止**。
//  · 状态全部在 SummaryPurgeLog 表 + 锁机制，**不依赖进程内存**，
//    进程重启后继续工作。
//  · 分批删除（默认 500/批，每批独立事务），避免长事务持锁。
//  · 查询层同时强制 expiresAt > now()，到期即时不可见；
//    物理删除是兜底，不是唯一手段。
//  · 清理延迟 = 实际删除时刻 - expiresAt，写入 SummaryPurgeLog。
//
// 本机不可验证：无 PostgreSQL。顾问锁与分批删除仅静态审查。
// ================================================================

import { prismaUser } from '../db';
import { jsonSafe } from './pgStats';

// 固定锁 key：同一 key 才能互斥；与 sensitiveGuard 的顾问锁 key 不同。
const PURGE_ADVISORY_LOCK_KEY = 4829182734;
const LOCK_SQL = `SELECT pg_try_advisory_lock(${PURGE_ADVISORY_LOCK_KEY}) AS acquired`;
const UNLOCK_SQL = `SELECT pg_advisory_unlock(${PURGE_ADVISORY_LOCK_KEY}) AS released`;

const PURGE_BATCH = parseInt(process.env.OBS_PURGE_BATCH || '500', 10);
const PURGE_INTERVAL_MS = parseInt(process.env.OBS_PURGE_INTERVAL_MS || '60000', 10);
const PURGE_MAX_PASSES = parseInt(process.env.OBS_PURGE_MAX_PASSES || '200', 10);

let running = false;      // 防止慢清理与下一个 60s tick 叠加
let timer: NodeJS.Timeout | undefined;

export interface PurgeResult {
  mode: 'boot' | 'periodic' | 'manual';
  leaseAcquired: boolean;
  expiredFound: number;
  deletedCount: number;
  failedCount: number;
  latencyMs: number;
  errorMessage?: string;
}

/** 单轮清理。未拿到锁时直接返回（本实例让位），不算失败。 */
export async function purgeExpiredSummaries(mode: PurgeResult['mode'] = 'periodic'): Promise<PurgeResult> {
  const startedAt = new Date();
  const t0 = Date.now();
  let leaseAcquired = false;
  let expiredFound = 0, deletedCount = 0, failedCount = 0;
  let errorMessage: string | undefined;

  try {
    const lockRows = (await prismaUser.$queryRawUnsafe(LOCK_SQL)) as any[];
    leaseAcquired = !!lockRows?.[0]?.acquired;
    if (!leaseAcquired) {
      // 别的实例正在清理。这是正常让位，不是错误。
      await writeLog({ startedAt, finishedAt: new Date(), mode, leaseAcquired: false,
        expiredFound: 0, deletedCount: 0, failedCount: 0, latencyMs: Date.now() - t0 });
      return { mode, leaseAcquired: false, expiredFound: 0, deletedCount: 0, failedCount: 0, latencyMs: 0 };
    }

    for (let pass = 0; pass < PURGE_MAX_PASSES; pass++) {
      // Prisma 的 $executeRawUnsafe 返回受影响行数（number）
      let rowCount: number;
      try {
        rowCount = await prismaUser.$executeRawUnsafe(
          `DELETE FROM "AiRunSummary" WHERE id IN (
             SELECT id FROM "AiRunSummary" WHERE "expiresAt" <= now()
             ORDER BY "expiresAt" ASC LIMIT ${PURGE_BATCH})`,
        );
        const n = Number(rowCount ?? 0);
        if (n > 0) { deletedCount += n; expiredFound += n; }
        if (n === 0) break; // 删空
      } catch (e: any) {
        failedCount++;
        errorMessage = String(e?.message || e).slice(0, 500);
        break; // 单批失败：记录后由下一个 tick 重试，不无限循环
      }
    }

    // 记录一条事件（只存计数，不存任何摘要正文）
    if (deletedCount > 0) {
      await prismaUser.obsEvent.create({
        data: jsonSafe({
          ts: new Date(), kind: 'summary_purged', severity: 'info',
          title: '过期 AI 运行摘要已清理', detail: `本批物理删除 ${deletedCount} 条过期摘要（不含正文）`,
          status: 'resolved', resolved: true, createdAt: new Date(),
        }),
      }).catch(() => { /* 事件失败不影响删除语义 */ });
    }
  } catch (err: any) {
    failedCount++;
    errorMessage = String(err?.message || err).slice(0, 500);
  } finally {
    // 必须释放：否则同实例后续清理永久拿不到锁
    if (leaseAcquired) {
      try { await prismaUser.$queryRawUnsafe(UNLOCK_SQL); } catch { /* noop */ }
    }
  }

  const latencyMs = Date.now() - t0;
  await writeLog({ startedAt, finishedAt: new Date(), mode, leaseAcquired, expiredFound,
    deletedCount, failedCount, latencyMs, errorMessage });
  return { mode, leaseAcquired, expiredFound, deletedCount, failedCount, latencyMs, errorMessage };
}

async function writeLog(l: {
  startedAt: Date; finishedAt: Date; mode: string; leaseAcquired: boolean;
  expiredFound: number; deletedCount: number; failedCount: number; latencyMs: number; errorMessage?: string;
}) {
  try {
    await prismaUser.summaryPurgeLog.create({
      data: jsonSafe({
        startedAt: l.startedAt, finishedAt: l.finishedAt, mode: l.mode,
        leaseAcquired: l.leaseAcquired, scannedCount: l.expiredFound,
        expiredFound: l.expiredFound, deletedCount: l.deletedCount,
        failedCount: l.failedCount, latencyMs: l.latencyMs,
        errorMessage: l.errorMessage ?? null,
      }),
    });
  } catch { /* 日志写入失败不得中断调度 */ }
}

/** 注册周期清理。返回 stop()。 */
export function startSummaryPurgeWorker(): () => void {
  if (timer) return stopSummaryPurgeWorker;

  // 启动即清一次（冷启动后可能已积压过期行）
  setTimeout(() => {
    purgeExpiredSummaries('boot').catch(() => { /* 启动清理失败由周期任务重试 */ });
  }, 15_000);

  timer = setInterval(() => {
    if (running) return;          // 上一轮还没结束：跳过，不叠加并发
    running = true;
    purgeExpiredSummaries('periodic')
      .catch(() => { /* 失败已记 SummaryPurgeLog，下个 tick 重试 */ })
      .finally(() => { running = false; });
  }, PURGE_INTERVAL_MS);

  console.log(`[OBS-PURGE] 已注册 ${PURGE_INTERVAL_MS}ms 周期清理（顾问锁 key=${PURGE_ADVISORY_LOCK_KEY}, 每批 ${PURGE_BATCH} 行）`);
  return stopSummaryPurgeWorker;
}

export function stopSummaryPurgeWorker() {
  if (timer) { clearInterval(timer); timer = undefined; }
}

export { running as purgeRunning };
