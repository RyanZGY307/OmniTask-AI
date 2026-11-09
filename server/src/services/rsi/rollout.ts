// ================================================================
// Rollout — 稳定灰度分流 + 指标门槛 + 晋升/回滚判定（纯函数）。
// 分流键：hash(actorId + ':' + assetKey)，同用户永不跨版本跳变。
// 延迟判定只用真 P95；无样本即 hold，绝不用平均值冒充。
// ================================================================

import type { RiskLevel } from './types';
import { wilsonLowerBound } from './baselineComparator';
import type { ComputedGroup } from './metrics';

/** FNV-1a 32bit，稳定、无依赖、进程无关。 */
export function stableBucket(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}

/** true = 走候选（灰度组）。同一 actorId+assetKey 永久稳定。 */
export function inRollout(actorId: string, assetKey: string, percent: number): boolean {
  if (!(percent > 0)) return false;
  if (percent >= 100) return true;
  return stableBucket(`${actorId}:${assetKey}`) < percent;
}

/** 可配置默认阈值：只读 env，AI 无权修改。 */
export const DEFAULT_THRESHOLDS = {
  minSamples: parseInt(process.env.RSI_MIN_SAMPLES || '30', 10) || 30,
  maxErrorRateIncrease: parseFloat(process.env.RSI_MAX_ERR_RATE_INC || '0.02'),
  maxLatencyIncreasePct: parseFloat(process.env.RSI_MAX_LATENCY_INC || '0.15'),
  minSuccessRateImprovement: parseFloat(process.env.RSI_MIN_SUCCESS_IMPROVE || '0.02'),
  /** 观察期限：超过即强制 hold 并交人工，避免永久 hold */
  maxObservationHours: parseFloat(process.env.RSI_MAX_OBSERVATION_HOURS || '72') || 72,
};

export type Outcome = 'promote' | 'hold' | 'rollback';

export interface DeciderGroup {
  samples: number;
  successRate: number;
  errorRate: number;
  p95LatencyMs: number | null;
  avgLatencyMs: number | null;
  p95Available: boolean;
}

export interface RolloutDecisionInput {
  baseline: DeciderGroup;
  candidate: DeciderGroup;
  riskLevel?: RiskLevel;
  /** 灰度开始时间；超过 maxObservationHours 强制 hold */
  canaryStartedAt?: Date | string | null;
}

function latencyRegressed(b: DeciderGroup, c: DeciderGroup, th = DEFAULT_THRESHOLDS): { hit: boolean; why: string } {
  // 只认真 P95；任一侧无样本 → 无法判定，记为 hold
  if (!c.p95Available || c.p95LatencyMs === null || b.p95LatencyMs === null || b.p95LatencyMs <= 0) {
    return { hit: false, why: 'latency_no_samples' };
  }
  const delta = (c.p95LatencyMs - b.p95LatencyMs) / b.p95LatencyMs;
  return delta > th.maxLatencyIncreasePct ? { hit: true, why: `p95 上升 ${(delta * 100).toFixed(1)}%` } : { hit: false, why: 'latency_ok' };
}

/** 单调判定：样本量 → 观察期限 → 错误率 → 真 P95 → Wilson 下界 → 成功率提升。 */
export function decideOutcome(input: RolloutDecisionInput, th = DEFAULT_THRESHOLDS): { outcome: Outcome; reasons: string[] } {
  const reasons: string[] = [];
  const { baseline: b, candidate: c } = input;

  // 指标缺失/NaN/Infinity 一律不得 promote（fail-closed）
  const nums = [b.samples, c.samples, b.successRate, c.successRate, b.errorRate, c.errorRate, b.latencyMs, c.latencyMs];
  if (!nums.every((n) => Number.isFinite(n))) {
    return { outcome: 'hold', reasons: ['指标缺失或非有限值，判定无效'] };
  }

  if (c.samples < th.minSamples) return { outcome: 'hold', reasons: ['样本不足'] };

  if (input.canaryStartedAt) {
    const started = new Date(input.canaryStartedAt).getTime();
    if (Number.isFinite(started) && Date.now() - started > th.maxObservationHours * 3600_000) {
      return { outcome: 'hold', reasons: ['超过最长观察期限，转人工'] };
    }
  }

  if (c.errorRate - b.errorRate > th.maxErrorRateIncrease) {
    return { outcome: 'rollback', reasons: ['错误率上升超过阈值'] };
  }

  const lat = latencyRegressed(b, c, th);
  if (lat.hit) return { outcome: 'rollback', reasons: [`真 P95 延迟${lat.why}`] };

  // Wilson 下界必须超过基线成功率，否则视为无统计显著提升
  const successes = Math.round(c.successRate * c.samples);
  const lower = wilsonLowerBound(successes, c.samples);
  if (lower <= b.successRate) {
    return { outcome: 'hold', reasons: [`Wilson 下界 ${(lower * 100).toFixed(1)}% 未超基线 ${(b.successRate * 100).toFixed(1)}%`] };
  }

  if (c.successRate - b.successRate < th.minSuccessRateImprovement) {
    return { outcome: 'hold', reasons: ['成功率未达提升门槛'] };
  }
  return { outcome: 'promote', reasons: ['指标达标'] };
}

/** 从 ComputedGroup 适配为判定输入。 */
export function toDecider(g: ComputedGroup): DeciderGroup {
  return {
    samples: g.samples,
    successRate: g.successRate,
    errorRate: g.errorRate,
    p95LatencyMs: g.p95LatencyMs,
    avgLatencyMs: g.avgLatencyMs,
    p95Available: g.p95Available,
  };
}
