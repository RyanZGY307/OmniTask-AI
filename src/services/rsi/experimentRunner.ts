// ================================================================
// ExperimentRunner — 隔离实验（确定性校验为主 + 固定输入/固定任务可重复）。
// 知识类资产通过 region A/B（复用 regionInsight 记录比较结论）。
// 不创建影子库；对 Prompt/Skill 使用真实 Agent Runtime 最小闭环。
// ================================================================

import type { ProposalPayload, BaselineSnapshot } from './types';
import { validateCandidate, type ValidationInput } from './candidateValidator';
import { computeGroup, type GroupStats, type ComputedMetrics } from './metrics';
import { computeMetrics, compare } from './baselineComparator';

export interface DeterministicCheckResult {
  ok: boolean;
  violations: string[];
  diffRatio: number;
}

export function runDeterministicChecks(input: ValidationInput): DeterministicCheckResult {
  const r = validateCandidate(input);
  return { ok: r.ok, violations: r.violations, diffRatio: r.diffRatio };
}

/** 基线指标计算：从固定窗口的原始计数聚合，口径与 rollout 一致。 */
export function computeBaseline(baselineGroup: GroupStats): BaselineSnapshot {
  const m = computeMetrics(baselineGroup);
  return {
    windowHours: 24,
    samples: m.samples,
    metrics: {
      successRate: m.successRate,
      errorRate: m.errorRate,
      latencyMs: m.latencyMs,
    },
    sourceIds: [],
  };
}

/** region A/B 结论（知识类资产）：以覆盖率/冲突率为确定性指标。 */
export function compareRegionAB(
  control: { coverage: number; conflicts: number; samples: number },
  variant: { coverage: number; conflicts: number; samples: number },
  minSamples = 30,
): { better: boolean; note: string } {
  const enough = control.samples >= minSamples && variant.samples >= minSamples;
  const coverageDelta = variant.coverage - control.coverage;
  const conflictDelta = variant.conflicts - control.conflicts;
  const better = enough && coverageDelta > 0 && conflictDelta <= 0;
  return { better, note: enough ? (better ? '变体覆盖率更高且冲突未升' : '变体未优于对照') : '样本不足' };
}

/** 隔离实验入口：先确定性校验，再（可选）真实运行时结果比对。 */
export function runIsolatedExperiment(input: {
  deterministic: ValidationInput;
  runtime?: { controlGroup: GroupStats; variantGroup: GroupStats; minSamples?: number; sameGroupGuard?: boolean };
}): {
  passed: boolean;
  stage: 'deterministic' | 'runtime' | 'ab';
  violations: string[];
  comparison?: ReturnType<typeof compare>;
} {
  const det = runDeterministicChecks(input.deterministic);
  if (!det.ok) return { passed: false, stage: 'deterministic', violations: det.violations };
  if (input.runtime) {
    // 同组自比防护：control 与 variant 不能是同一批数据
    const sameGroup = input.runtime.controlGroup === input.runtime.variantGroup
      || (input.runtime.sameGroupGuard === true
          && input.runtime.controlGroup.sourceIds.length === input.runtime.variantGroup.sourceIds.length
          && input.runtime.controlGroup.sourceIds.every((v, i) => v === input.runtime.variantGroup.sourceIds[i]));
    if (input.runtime.minSamples !== undefined && input.runtime.controlGroup.samples < input.runtime.minSamples) {
      return { passed: false, stage: 'runtime', violations: ['control_samples_insufficient'] };
    }
    if (input.runtime.minSamples !== undefined && input.runtime.variantGroup.samples < input.runtime.minSamples) {
      return { passed: false, stage: 'runtime', violations: ['variant_samples_insufficient'] };
    }
    if (sameGroup) {
      return { passed: false, stage: 'runtime', violations: ['control_and_variant_identical: 对照组与实验组不能是同一组数据'] };
    }
    const c = compare(computeMetrics(input.runtime.controlGroup), computeMetrics(input.runtime.variantGroup), input.runtime.minSamples);
    return { passed: c.better, stage: 'runtime', violations: [], comparison: c };
  }
  return { passed: true, stage: 'deterministic', violations: [] };
}
