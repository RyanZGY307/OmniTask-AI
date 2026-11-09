// ================================================================
// RSI 调度器：信号扫描 + 灰度监控 + 暂停到期清理。
// 与 index.ts 既有 setInterval 装饰一致；RSI 扫描使用顾问锁防多实例重叠。
// 指标只从真实表取（RequestTrace / ModelCall / ObsEvent / RsiJob）。
// ================================================================

// 样本份额常量：候选组至少需要的对照比例（0.1 = 成本异常检测的最小样本比）
const CANDIDATES_SHARE = 0.1;
const MIN_SAMPLES = 10;
/** DB 故障期间的短时内存缓冲上限；不是持久可靠机制，仅降损。 */
const SIGNAL_BUFFER_MAX = 200;

import { prismaKnowledge, prismaUser } from '../db';
import { bridgeSignals, dedupeKey, type BridgeSource, type RsiSignal, type TraceSample } from './signalBridge';
import { listRsiProviders } from './rsiProviderConfig';
import { primeRsiProviderCache } from './rsiQuotaGate';
import { checkPause, expireOverduePauses } from './systemPause';
import { writeAudit } from './audit';
import { enqueueRsiJob } from './queue';
import { monitorRollout } from './pipeline';
import { collectChatMetrics, collectGroup, type GroupStats } from './metrics';
import { bufferSignals, drainSignalBuffer, bufferedSignalCount } from './signalBridge';

const LOCK_KEY = 4829182740; // purge=4829182734，互不冲突

async function withAdvisoryLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const lock = await prismaKnowledge.$queryRaw`SELECT pg_try_advisory_lock(${LOCK_KEY}::bigint) AS acquired`;
  const acquired = Array.isArray(lock) ? (lock[0] as { acquired: boolean })?.acquired : null;
  if (!acquired) return null;
  try { return await fn(); } finally {
    try { await prismaKnowledge.$queryRaw`SELECT pg_advisory_unlock(${LOCK_KEY}::bigint) AS released`; } catch { /* 连接断开自动释放 */ }
  }
}


async function fetchTraces(since: Date): Promise<TraceSample[]> {
  return prismaUser.requestTrace.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' }, take: 200,
    select: {
      id: true, requestId: true, status: true, finishReason: true, durationMs: true,
      totalTokens: true, totalApiCostUsd: true, createdAt: true,
    },
  });
}

/** 扫描最近观测事件与真实请求痕迹，产生 RSI 信号并入队。 */
export async function scanSignals(lookbackMinutes = 15): Promise<{ bridged: number; enqueued: number; buffered: number }> {
  const since = new Date(Date.now() - lookbackMinutes * 60_000);
  let obsEvents: any[] = [];
  let recoveries: Array<{ id: string; kind: string; attemptCount: number; updatedAt: Date }> = [];
  let traces: TraceSample[] = [];
  let dbFailed = false;
  try {
    [obsEvents, recoveries, traces] = await Promise.all([
      prismaUser.obsEvent.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' }, take: 200,
        select: { id: true, kind: true, severity: true, title: true, domain: true, ts: true },
      }),
      prismaUser.rsiJob.findMany({
        where: { status: 'FAILED', updatedAt: { gte: since } },
        take: 100, select: { id: true, kind: true, attemptCount: true, updatedAt: true },
      }),
      fetchTraces(since),
    ]);
  } catch (e) {
    // DB 不可用：信号先入有界内存缓冲，恢复后由补偿扫描补入队
    dbFailed = true;
    obsEvents = [{
      id: `memory:${Date.now()}`, kind: 'db_connection_failed', level: 'high',
      message: `scheduler 取数失败: ${String((e as Error)?.message ?? e).slice(0, 300)}`,
      domain: 'rsi_scheduler', createdAt: new Date(),
    }];
  }

  const obsMapped = obsEvents.map((e) => ({
    id: e.id, kind: e.kind, level: (e as any).level ?? (e as any).severity, message: (e as any).message ?? (e as any).title,
    domain: e.domain, createdAt: (e as any).createdAt ?? (e as any).ts,
  }));
  const src: BridgeSource = { obsEvents: obsMapped, workerRecoveries: recoveries, traces, now: new Date() };
  const signals = bridgeSignals(src);
  if (dbFailed) {
    const n = bufferSignals(signals);
    await writeAudit({ action: 'signal_buffered', scope: 'rsi_scheduler', metadata: { count: signals.length, buffered: n }, reason: 'db_unavailable' }).catch(() => undefined);
    return { bridged: signals.length, enqueued: 0, buffered: n };
  }

  // DB 恢复后补偿：把缓冲残余并入本次扫描
  const drained = drainSignalBuffer();
  const all = [...signals, ...drained];
  const seen = new Set<string>();
  let enqueued = 0;
  const recentCandidates = await prismaKnowledge.changeRequest.findMany({
    where: { createdAt: { gte: since } }, take: 500, select: { assetKey: true, createdAt: true },
  }).catch(() => [] as Array<{ assetKey: string; createdAt: Date }>);
  const lastForAsset = new Map<string, number>();
  for (const c of recentCandidates) {
    lastForAsset.set(c.assetKey, Math.max(lastForAsset.get(c.assetKey) ?? 0, c.createdAt.getTime()));
  }
  const COOLDOWN_MS = 5 * 60_000;
  for (const s of all) {
    const key = dedupeKey(s);
    if (seen.has(key)) continue;
    const last = lastForAsset.get(s.assetKey);
    if (last && Date.now() - last < COOLDOWN_MS) continue;
    lastForAsset.set(s.assetKey, Date.now());
    seen.add(key);
    const currentContent = await resolveCurrentContent(s.assetType, s.assetKey);
    await enqueueRsiJob('rsi_run', {
      kind: s.kind, assetType: s.assetType, assetKey: s.assetKey, severity: s.severity,
      riskLevel: s.riskLevel, message: s.message, sourceId: s.sourceId, currentContent,
    });
    enqueued++;
  }
  return { bridged: all.length, enqueued, buffered: 0 };
}

/** 入队时解析当前生产内容，避免首轮提案基于空内容（读不到就留空，由 pipeline 短路）。 */
async function resolveCurrentContent(assetType: string, assetKey: string): Promise<string> {
  try {
    const { resolveReleasedContent } = await import('./assetRegistry');
    const r = await resolveReleasedContent(assetKey);
    if (r?.content) return r.content;
  } catch { /* 资产尚未登记 */ }
  try {
    if (assetType === 'knowledge_object') {
      const obj = await prismaKnowledge.knowledgeObject.findFirst({ where: { canonicalName: assetKey }, select: { description: true } });
      if (obj?.description) return String(obj.description);
    }
    if (assetType === 'knowledge_fact') {
      const last = assetKey.split(':').pop() ?? assetKey;
      const fact = await prismaKnowledge.knowledgeFact.findFirst({ where: { id: last }, select: { claim: true } }).catch(() => null);
      if (fact?.claim) return String(fact.claim);
    }
  } catch { /* 忽略 */ }
  return '';
}

/** DB 恢复后补偿：把内存缓冲里的信号补入队。 */
export async function flushSignalBuffer(): Promise<{ flushed: number; skipped: number }> {
  if (bufferedSignalCount() === 0) return { flushed: 0, skipped: 0 };
  const buffered = drainSignalBuffer();
  let flushed = 0, skipped = 0;
  for (const s of buffered) {
    try {
      const currentContent = await resolveCurrentContent(s.assetType, s.assetKey);
      await enqueueRsiJob('rsi_run', {
        kind: s.kind, assetType: s.assetType, assetKey: s.assetKey, severity: s.severity,
        riskLevel: s.riskLevel, message: s.message, sourceId: s.sourceId, currentContent,
      });
      flushed++;
    } catch { skipped++; }
  }
  await writeAudit({ action: 'signal_flushed', scope: 'rsi_scheduler', metadata: { flushed, skipped } }).catch(() => undefined);
  return { flushed, skipped };
}

/** 定时入口：锁内扫描；拿不到锁直接跳过（多实例只跑一个）。 */
export async function scheduledSignalScan(): Promise<{ ran: boolean; bridged?: number; enqueued?: number }> {
  const paused = await checkPause({ scope: 'global', resource: '*', level: 'write' }).catch((e) => ({ paused: true, reason: String(e.message) }));
  if (paused.paused) return { ran: false };
  const res = await withAdvisoryLock(() => scanSignals());
  if (res === null) return { ran: false };
  await writeAudit({ action: 'signal_bridged', scope: 'global', metadata: res }).catch(() => undefined);
  return { ran: true, ...res };
}

/** 暂停到期清理入口。 */
export async function scheduledPauseExpiry(): Promise<number> {
  return expireOverduePauses();
}

/** 灰度监控入口：扫 canary 变更，装配真实指标并判定。 */
export async function scheduledRolloutCheck(): Promise<{ checked: number; promoted?: number; rolledBack?: number; held?: number }> {
  const rows = await prismaKnowledge.changeRequest.findMany({
    where: { status: 'canary' }, take: 20, select: { id: true, assetKey: true, canaryPercent: true, updatedAt: true },
  });
  let promoted = 0, rolledBack = 0, held = 0;
  const since = new Date(Date.now() - 25 * 60 * 60_000);
  const traces = await fetchTraces(since).catch(() => [] as TraceSample[]);
  const baseline = collectGroup(traces.map((t) => ({
    status: t.status ?? '', finishReason: t.finishReason ?? null,
    latencyMs: t.durationMs ?? null, sourceId: t.requestId ?? t.id,
  })));
  for (const row of rows) {
    try {
      const percent = row.canaryPercent ?? 5;
      // 候选组 = 灰度桶内的请求（按 requestId hash 稳定分桶），对照组 = 其余
      const inBucket = traces.filter((t) => {
        const key = `${t.requestId ?? t.id}:${row.assetKey}`;
        let h = 0x811c9dc5;
        for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        return (h % 100) < percent;
      });
      if (inBucket.length < 1) { held++; continue; }
      const candidate = collectGroup(inBucket.map((t) => ({
        status: t.status ?? '', finishReason: t.finishReason ?? null,
        latencyMs: t.durationMs ?? null, sourceId: t.requestId ?? t.id,
      })));
      const r = await monitorRollout(row.id, { baseline, candidate, canaryStartedAt: row.updatedAt });
      if (r.outcome === 'promote') promoted++;
      else if (r.outcome === 'rollback') rolledBack++;
      else held++;
    } catch (e) {
      await writeAudit({ action: 'change_transitioned', scope: row.assetKey, reason: `rollout_error:${(e as Error).message}`, metadata: { changeId: row.id } }).catch(() => undefined);
    }
  }
  await writeAudit({
    action: 'change_transitioned', scope: 'rollout_check', reason: 'scan',
    metadata: { count: rows.length, promoted, rolledBack, held },
  }).catch(() => undefined);
  return { checked: rows.length, promoted, rolledBack, held };
}

/** 从真实痕迹装配指标（保留给外部/测试调用）。 */
export async function assembleRolloutMetrics(assetKey: string): Promise<{ baseline: GroupStats; candidate: GroupStats; minSamples: number } | null> {
  const stats = await collectChatMetrics(24);
  if (!stats || stats.samples < MIN_SAMPLES) return null;
  const share = Math.max(MIN_SAMPLES, Math.ceil(stats.samples * CANDIDATES_SHARE));
  return { baseline: stats, candidate: stats, minSamples: share };
}

export function startRsiScheduler(): void {
  const scanMs = parseInt(process.env.RSI_SCAN_INTERVAL_MS || '300000', 10) || 300000;
  const pauseMs = parseInt(process.env.RSI_PAUSE_EXPIRY_MS || '60000', 10) || 60000;
  const rolloutMs = parseInt(process.env.RSI_ROLLOUT_CHECK_MS || '120000', 10) || 120000;
  if (process.env.RSI_SCHEDULER === 'off') { console.log('[RSI] scheduler off by env'); return; }
  setInterval(() => { scheduledSignalScan().catch((e) => console.error('[RSI] scan failed', String(e?.message ?? e))); }, scanMs).unref();
  setInterval(() => { scheduledPauseExpiry().catch(() => undefined); }, pauseMs).unref();
  setInterval(() => { scheduledRolloutCheck().catch(() => undefined); }, rolloutMs).unref();
  // 周期性重预热 RSI provider 缓存，防配置漂移 / 进程内缓存过期
  setInterval(() => {
    listRsiProviders().then((rows) => primeRsiProviderCache(rows)).catch(() => undefined);
  }, 60000).unref();
  console.log(`[RSI] scheduler started scan=${scanMs}ms pause=${pauseMs}ms rollout=${rolloutMs}ms`);
}
