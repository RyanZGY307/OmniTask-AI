// ================================================================
// RSI Worker executor：被 workerPool 以 job 调用。
// 幂等：重复执行同一 RUNNING → COMPLETED 的任务直接返回。
// ================================================================

import { prismaUser } from '../db';
import { runSignalToCandidate } from './pipeline';
import { scheduledSignalScan, scheduledRolloutCheck, scheduledPauseExpiry } from './scheduler';
import { completeRsiJob, failRsiJob } from './queue';
import { isWorkerPaused } from './systemPause';
import { writeAudit } from './audit';

export async function executeRsiJob(jobId: string): Promise<void> {
  const job = await prismaUser.rsiJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  if (job.status === 'COMPLETED' || job.status === 'FAILED') return; // 幂等
  try {
    if (await isWorkerPaused('rsi')) {
      await writeAudit({ action: 'guard_blocked', reason: 'worker_paused', scope: 'rsi' });
      return;
    }
    const payload = job.payload ? JSON.parse(job.payload) : {};
    if (job.kind === 'signal_scan') {
      await scheduledSignalScan();
      await completeRsiJob(jobId, {});
      return;
    }
    if (job.kind === 'rollout_check') {
      await scheduledRolloutCheck();
      await completeRsiJob(jobId, {});
      return;
    }
    // rsi_run：需要 signal 上下文
    if (!payload || !payload.assetKey || !payload.sourceId) {
      await completeRsiJob(jobId, { skipped: 'no_signal' });
      return;
    }
    const outcome = await runSignalToCandidate({
      signal: {
        kind: payload.kind, assetType: payload.assetType, assetKey: payload.assetKey,
        severity: payload.severity ?? 'medium', riskLevel: payload.riskLevel ?? 'r1',
        message: payload.message ?? '', observedAt: new Date().toISOString(),
        sourceId: payload.sourceId, evidenceRefs: [payload.sourceId],
      },
      currentContent: payload.currentContent ?? '',
      allowedAssetKeys: payload.allowedAssetKeys,
    });
    await completeRsiJob(jobId, { status: outcome.status, denied: outcome.denied, stages: outcome.stages.length });
  } catch (err) {
    await failRsiJob(jobId, String((err as Error)?.message ?? err));
  }
}
