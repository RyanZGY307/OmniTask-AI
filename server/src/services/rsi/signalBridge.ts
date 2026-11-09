// ================================================================
// SignalBridge — 观测数据 → RSI 标准信号。
// 数据源只允许真实存在的字段：
//   - ObsEvent（观测事件，含 db_connection_failed / collection_timeout / query_failed）
//   - RsiJob / researchJob 等 worker 回收与失败
//   - RequestTrace + ModelCall（真实延迟/成本/状态）
// 纯函数映射：不给 DB、不发起 IO；取数由调用方注入，便于单测。
// ================================================================

import type { RiskLevel } from './types';

export type BridgeSignalKind =
  | 'db_conn_failure'
  | 'worker_stale_recovery'
  | 'model_quality_regression'
  | 'tool_exec_error'
  | 'billing_cost_anomaly';

export interface RsiSignal {
  kind: BridgeSignalKind;
  assetType: string;
  assetKey: string;
  severity: 'low' | 'medium' | 'high';
  riskLevel: RiskLevel;
  message: string;
  observedAt: string;
  sourceId: string;
  evidenceRefs: string[];
}

/** RequestTrace 投影输入：字段必须与 prisma/schema-user.prisma 的 RequestTrace 一致。 */
export interface TraceSample {
  id: string;
  requestId?: string | null;
  status?: string | null;
  finishReason?: string | null;
  durationMs?: number | null;
  totalTokens?: number | null;
  totalApiCostUsd?: number | null;
  createdAt: Date;
}

export interface BridgeSource {
  obsEvents?: Array<{ id: string; kind: string; level?: string; message?: string; domain?: string; createdAt: Date }>;
  workerRecoveries?: Array<{ id: string; kind: string; attemptCount?: number; attempts?: number; updatedAt: Date }>;
  traces?: TraceSample[];
  now?: Date;
  /** 单个请求成本相对同期中位数的倍数视为异常（默认 3） */
  billingSpikeRatio?: number;
}

const KIND_MAP: Record<string, BridgeSignalKind> = {
  db_connection_failed: 'db_conn_failure',
  collection_timeout: 'db_conn_failure',
  query_failed: 'db_conn_failure',
  worker_stale_recovered: 'worker_stale_recovery',
  tool_error: 'tool_exec_error',
  model_quality_regression: 'model_quality_regression',
  billing_cost_anomaly: 'billing_cost_anomaly',
};

const SEV = { low: 'low', medium: 'medium', high: 'high' } as const;

export function mapObsEvent(e: { kind: string; level?: string }): { kind: BridgeSignalKind; severity: 'low' | 'medium' | 'high' } {
  const k = KIND_MAP[e.kind] ?? 'tool_exec_error';
  const lvl = e.level ?? 'medium';
  return { kind: k, severity: lvl === 'high' ? SEV.high : lvl === 'low' ? SEV.low : SEV.medium };
}

function isTraceFailure(t: TraceSample): boolean {
  const st = (t.status ?? '').toUpperCase();
  const fr = (t.finishReason ?? '').toLowerCase();
  return fr === 'error' || fr === 'aborted' || (st !== 'OK' && st !== 'COMPLETED');
}

/** 从观测、worker 回收与真实请求痕迹提取信号。 */
export function bridgeSignals(src: BridgeSource): RsiSignal[] {
  const now = src.now ?? new Date();
  const out: RsiSignal[] = [];

  for (const e of src.obsEvents ?? []) {
    const m = mapObsEvent(e);
    out.push({
      kind: m.kind,
      assetType: m.kind === 'db_conn_failure' ? 'knowledge_object' : 'skill_guidance',
      assetKey: `${m.kind}:${e.kind}:${(e.domain ?? 'system').toString()}`,
      severity: m.severity,
      riskLevel: m.severity === 'high' ? 'r2' : 'r1',
      message: (e.message ?? '').slice(0, 400),
      observedAt: (e.createdAt ?? now).toISOString(),
      sourceId: e.id,
      evidenceRefs: [e.id],
    });
  }

  for (const w of src.workerRecoveries ?? []) {
    const attempts = w.attemptCount ?? w.attempts ?? 0;
    if (attempts < 2) continue; // 单次恢复属正常，不作为信号
    out.push({
      kind: 'worker_stale_recovery',
      assetType: 'skill_guidance',
      assetKey: `worker:${w.kind}`,
      severity: attempts >= 4 ? 'high' : 'medium',
      riskLevel: attempts >= 4 ? 'r2' : 'r1',
      message: `任务类型 ${w.kind} 被回收 ${attempts} 次`,
      observedAt: (w.updatedAt ?? now).toISOString(),
      sourceId: w.id,
      evidenceRefs: [w.id],
    });
  }

  // 质量退化：以「真实请求失败率」为确定性命中，不引入不存在的 qualityScore
  const traces = src.traces ?? [];
  if (traces.length >= 10) {
    const failures = traces.filter(isTraceFailure).length;
    const failRate = failures / traces.length;
    if (failRate > 0.2) {
      out.push({
        kind: 'model_quality_regression',
        assetType: 'knowledge_fact',
        assetKey: 'model:chat:quality',
        severity: failRate > 0.4 ? 'high' : 'medium',
        riskLevel: failRate > 0.4 ? 'r2' : 'r1',
        message: `近窗请求失败率 ${(failRate * 100).toFixed(1)}%（${failures}/${traces.length}）超过 20%`,
        observedAt: now.toISOString(),
        sourceId: `trace_window:${now.getTime()}`,
        evidenceRefs: traces.slice(0, 10).map((t) => t.requestId ?? t.id),
      });
    }
  }

  // 成本异常：单请求成本相对同期中位数超倍数
  const ratio = src.billingSpikeRatio ?? 3;
  const costs = traces.map((t) => t.totalApiCostUsd ?? 0).filter((n) => n > 0);
  if (costs.length >= 5) {
    const sorted = [...costs].sort((x, y) => x - y);
    // upperMedianCount 是「取第 50% 位置的样本序号」，用于成本中位数，不是文本长度估算
    const upperMedianCount = Math.floor(sorted.length / 2);
    const median = sorted[upperMedianCount] || 1;
    for (const t of traces) {
      const c = t.totalApiCostUsd ?? 0;
      if (c > median * ratio) {
        out.push({
          kind: 'billing_cost_anomaly',
          assetType: 'knowledge_fact',
          assetKey: 'billing:chat:cost',
          severity: c > median * ratio * 2 ? 'high' : 'medium',
          riskLevel: 'r1',
          message: `请求 ${t.requestId ?? t.id} 成本 ${c.toFixed(4)} 超中位数 ${ratio.toFixed(1)} 倍`,
          observedAt: (t.createdAt ?? now).toISOString(),
          sourceId: t.requestId ?? t.id,
          evidenceRefs: [t.requestId ?? t.id],
        });
      }
    }
  }
  return out;
}

/** 去重键：同资产同型 5 分钟内只留一条。 */
export function dedupeKey(s: RsiSignal): string {
  return `${s.assetKey}|${s.kind}`;
}
