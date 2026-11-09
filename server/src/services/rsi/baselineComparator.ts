// ================================================================
// BaselineComparator — 基线/候选两组指标对比与统计口径。
// 口径修正（第六阶段）：
// 1. 延迟分化为 p95LatencyMs（真 P95，需完整样本）与 avgLatencyMs（平均值），
//    平均值绝不再被命名为 P95；
// 2. Wilson 95% 下界参与晋升判定：候选成功率的下界未超过基线点估计即不得晋升；
// 3. 指标缺失一律不得 promote；
// 4. 阈值可配置但不允许 AI 修改。
// ================================================================

import type { GroupStats, ComputedGroup } from './metrics';
import { computeGroup, computeP95, computeAvg } from './metrics';

export interface ComputedMetrics {
  samples: number;
  successRate: number;
  errorRate: number;
  /** @deprecated 历史字段：保留旧调用方兼容，值等于 avgLatencyMs；不要当 P95 用 */
  latencyMs: number | null;
  p95LatencyMs: number | null;
  avgLatencyMs: number | null;
  p95Available: boolean;
}

/** 旧接口兼容：latencyMs 已改 nullable（无样本时为 null，不再是 0）。 */
export function computeMetrics(g: GroupStats): ComputedMetrics {
  const c = computeGroup(g);
  return {
    samples: c.samples,
    successRate: c.successRate,
    errorRate: c.errorRate,
    latencyMs: c.avgLatencyMs,
    p95LatencyMs: c.p95LatencyMs,
    avgLatencyMs: c.avgLatencyMs,
    p95Available: c.p95Available,
  };
}

export function wilsonLowerBound(successes: number, trials: number, z = 1.96): number {
  if (trials <= 0) return 0;
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return Math.max(0, (centre - margin) / denom);
}

export interface CompareResult {
  better: boolean;
  baselineSamples: number;
  candidateSamples: number;
  successDelta: number;
  errorDelta: number;
  /** 延迟退化比例；任一侧无延迟样本时为 null（不得据此判定） */
  latencyDeltaPct: number | null;
  candidateWilsonLower: number;
  baselineSuccessRate: number;
  note: string;
}

/** 对比（判定层）：Wilson 下界 > 基线成功率 且 错误率不升 才算 beter。 */
export function compare(
  baseline: ComputedMetrics,
  candidate: ComputedMetrics,
  minSamples = 30,
): CompareResult {
  const successDelta = candidate.successRate - baseline.successRate;
  const errorDelta = candidate.errorRate - baseline.errorRate;
  let latencyDeltaPct: number | null = null;
  if (candidate.p95LatencyMs !== null && baseline.p95LatencyMs !== null && baseline.p95LatencyMs > 0) {
    latencyDeltaPct = (candidate.p95LatencyMs - baseline.p95LatencyMs) / baseline.p95LatencyMs;
  } else if (candidate.avgLatencyMs !== null && baseline.avgLatencyMs !== null && baseline.avgLatencyMs > 0) {
    latencyDeltaPct = (candidate.avgLatencyMs - baseline.avgLatencyMs) / baseline.avgLatencyMs;
  }
  const enough = baseline.samples >= minSamples && candidate.samples >= minSamples;
  const cw = wilsonLowerBound(Math.round(candidate.successRate * candidate.samples), candidate.samples);
  const better = enough
    && successDelta > 0
    && errorDelta <= 0
    && (latencyDeltaPct === null || latencyDeltaPct <= 0.15)
    && cw > baseline.successRate;
  return {
    better,
    baselineSamples: baseline.samples,
    candidateSamples: candidate.samples,
    successDelta,
    errorDelta,
    latencyDeltaPct,
    candidateWilsonLower: cw,
    baselineSuccessRate: baseline.successRate,
    note: enough ? (better ? '候选优于基线' : '候选未优于基线') : '样本不足，判定无效',
  };
}

export { computeP95, computeAvg };
export type { ComputedGroup, GroupStats };
