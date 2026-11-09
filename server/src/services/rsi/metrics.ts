// ================================================================
// RSI 指标层 — 真实运行指标采集与统计口径。
//
// 硬规则（对应第六阶段任务书第七节）：
// 1. 延迟优先取 ModelCall.latencyMs 的完整样本，算真 P95（nearest-rank）；
// 2. 没有完整样本时，明确返回 avgLatencyMs 并标记 p95Available=false，
//    绝不允许把平均值命名为 P95；
// 3. 任何指标缺失都不得判定为 promote；
// 4. 成功率/错误率定义全局唯一，见 successOf/errorOf。
// ================================================================

// DB client 延迟加载：本地/CI 无 @prisma/client 时仍可加载纯统计逻辑（与
// concurrencyLease.ts 同模式）。任何真正触库的调用都会抛 db_unavailable。
type DbRef = { requestTrace: { findMany: (a: unknown) => Promise<any[]> } } | null;
let prismaUserRef: DbRef = null;
try { prismaUserRef = (require('../db') as { prismaUser: DbRef }).prismaUser; } catch { prismaUserRef = null; }
const prismaUser = new Proxy({} as DbRef, {
  get(_t, prop) {
    if (!prismaUserRef) throw new Error('db_unavailable');
    return (prismaUserRef as Record<string, unknown>)[prop as string];
  },
}) as DbRef;

export interface RawSample {
  status: string;
  finishReason?: string | null;
  durationMs?: number | null;
  latencyMs?: number | null;   // 单次模型调用真实延迟（ModelCall.latencyMs）
  totalTokens?: number | null;
  totalApiCostUsd?: number | null;
  creditsCharged?: number | null;
  sourceId: string;
}

export interface GroupStats {
  samples: number;
  successes: number;
  failures: number;
  errorEvents: number;
  latencySamples: number[];   // 完整样本才有值
  totalTokens: number;
  totalApiCostUsd: number;
  sourceIds: string[];
}

export interface ComputedGroup {
  samples: number;
  successRate: number;
  errorRate: number;
  p95LatencyMs: number | null;      // 真 P95（无完整样本时为 null）
  avgLatencyMs: number | null;      // 平均延迟（独立命名，不冒充 P95）
  p95Available: boolean;
  errorEvents: number;
}

export type ComputedMetrics = ComputedGroup;

/** 判定口径集中于此：finishReason=error/aborted 或 status 非成功计为失败。 */
export function isFailure(s: RawSample): boolean {
  const st = (s.status ?? '').toUpperCase();
  const fr = (s.finishReason ?? '').toLowerCase();
  if (fr === 'error' || fr === 'aborted') return true;
  return st !== 'OK' && st !== 'SUCCESS' && st !== 'COMPLETED';
}

export function collectGroup(samples: RawSample[]): GroupStats {
  const latency: number[] = [];
  let successes = 0, failures = 0, tokens = 0, cost = 0;
  const sourceIds: string[] = [];
  for (const s of samples) {
    if (typeof s.latencyMs === 'number' && s.latencyMs > 0) latency.push(s.latencyMs);
    if (isFailure(s)) failures++; else successes++;
    tokens += s.totalTokens ?? 0;
    cost += s.totalApiCostUsd ?? 0;
    if (sourceIds.length < 50) sourceIds.push(s.sourceId);
  }
  return { samples: samples.length, successes, failures, errorEvents: failures, latencySamples: latency, totalTokens: tokens, totalApiCostUsd: cost, sourceIds };
}

/** 真 P95（nearest-rank）：样本为空返回 null。 */
export function computeP95(samples: number[]): number | null {
  if (!samples || samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(0.95 * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export function computeAvg(samples: number[]): number | null {
  if (!samples || samples.length === 0) return null;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

export function computeGroup(g: GroupStats): ComputedGroup {
  // 兼容旧 GroupMetrics 输入（只有 latencyTotalMs、无 latencySamples）：
  // 此时 avgLatencyMs 由 latencyTotalMs/samples 推导，它确实是平均值；
  // p95LatencyMs 保持 null 且 p95Available=false，绝不当 P95 使用。
  const rawLatency: number[] = Array.isArray((g as { latencySamples?: number[] }).latencySamples)
    ? (g as { latencySamples: number[] }).latencySamples
    : [];
  const legacyTotal = (g as { latencyTotalMs?: number }).latencyTotalMs;
  const samples = g.samples ?? ((g.successes ?? 0) + (g.failures ?? 0)) ?? 0;
  const avg = computeAvg(rawLatency)
    ?? (typeof legacyTotal === 'number' && samples > 0 ? legacyTotal / samples : null);
  return {
    samples,
    successRate: samples > 0 ? (g.successes ?? 0) / samples : 0,
    errorRate: samples > 0 ? (g.errorEvents ?? 0) / samples : 0,
    p95LatencyMs: computeP95(rawLatency),
    avgLatencyMs: avg,
    p95Available: rawLatency.length > 0,
    errorEvents: g.errorEvents ?? g.failures ?? 0,
  };
}

/** 对话请求指标（含真实模型调用延迟样本）。DB 不可用返回 null，由调用方 fail-closed。 */
export async function collectChatMetrics(
  windowHours = 24,
  filter?: { selectedModel?: string; provider?: string; minSamples?: number },
): Promise<GroupStats | null> {
  const since = new Date(Date.now() - windowHours * 3600 * 1000);
  let traces: any[] = [];
  try {
    traces = await prismaUser.requestTrace.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: { modelCalls: { select: { latencyMs: true, selectedModel: true, provider: true } } },
    });
  } catch {
    return null;
  }
  if (filter?.selectedModel) traces = traces.filter((t) => t.selectedModel === filter.selectedModel);
  if (filter?.provider) traces = traces.filter((t) => t.provider === filter.provider);
  const flat: RawSample[] = [];
  for (const t of traces) {
    const calls: any[] = t.modelCalls ?? [];
    if (calls.length === 0) {
      flat.push({
        status: t.status ?? '', finishReason: t.finishReason ?? null,
        durationMs: t.durationMs ?? null, latencyMs: t.durationMs ?? null,
        totalTokens: t.totalTokens ?? null, totalApiCostUsd: t.totalApiCostUsd ?? null,
        sourceId: t.requestId ?? t.id,
      });
    } else {
      for (const c of calls) {
        flat.push({
          status: t.status ?? '', finishReason: t.finishReason ?? null,
          durationMs: t.durationMs ?? null, latencyMs: c.latencyMs ?? null,
          totalTokens: t.totalTokens ?? null, totalApiCostUsd: t.totalApiCostUsd ?? null,
          sourceId: t.requestId ?? t.id,
        });
      }
    }
  }
  if (filter?.minSamples && flat.length < filter.minSamples) return null;
  return collectGroup(flat);
}

/** 采集原始痕迹样本（供分组/分桶复算，不经过聚合）。DB 不可用返 []。 */
export async function collectRawSamples(windowHours: number, limit = 5000): Promise<RawSample[]> {
  const since = new Date(Date.now() - windowHours * 3600_000);
  try {
    const rows = await prismaUser.requestTrace.findMany({
      where: { createdAt: { gte: since } },
      select: { id: true, requestId: true, status: true, finishReason: true, durationMs: true },
      take: limit, orderBy: { createdAt: 'desc' },
    });
    return rows.map((r: Record<string, unknown>) => ({
      status: String(r.status ?? ''),
      finishReason: (r.finishReason as string | null) ?? null,
      latencyMs: typeof r.durationMs === 'number' ? (r.durationMs as number) : null,
      sourceId: String(r.requestId ?? r.id ?? ''),
    }));
  } catch { return []; }
}

/** 按 assetKey 稳定分桶：灰度组(variant) 与对照组(control)。 */
export function splitByBucket(samples: RawSample[], assetKey: string, percent: number): { variant: RawSample[]; control: RawSample[] } {
  const variant: RawSample[] = [];
  const control: RawSample[] = [];
  const p = Math.max(0, Math.min(100, Math.trunc(percent)));
  for (const s of samples) {
    const key = `${s.sourceId}:${assetKey}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) h ^= key.charCodeAt(i), h = Math.imul(h, 0x01000193) >>> 0;
    if ((h % 100) < p) variant.push(s); else control.push(s);
  }
  return { variant, control };
}
