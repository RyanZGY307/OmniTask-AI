// ================================================================
// EvidenceAssembler — 装配证据包（纯函数 + 注入取数）。
// 铁律：缺原始信号或缺基线 → 不得进入 LLM 评估/发布。
// ================================================================

import type { EvidenceBundle, BaselineSnapshot, EvaluationSummary, MetricSample } from './types';
import { redact as redactText } from '../observability/pgStats';
import { isExpired } from '../observability/pgStats';

export interface EvidenceInput {
  signals: Array<{ signalId: string; signalType: string; severity: string; createdAt: string; detail?: string; raw?: string }>;
  context?: { text?: string; toolCalls?: string[] };
  baseline: BaselineSnapshot | null;
  history: EvaluationSummary[];
  currentVersion: number | null;
  relatedChanges: number;
}

export interface EvidenceResult {
  complete: boolean;
  bundle: EvidenceBundle | null;
  missing: string[];
}

/** 装配证据；缺信号或缺基线直接判不完整（fail-closed）。 */
export function assembleEvidence(input: EvidenceInput): EvidenceResult {
  const missing: string[] = [];
  if (!input.signals || input.signals.length === 0) missing.push('signals');
  if (!input.baseline || !input.baseline.metrics || Object.keys(input.baseline.metrics).length === 0) missing.push('baseline');
  if (missing.length > 0) return { complete: false, bundle: null, missing };

  const signals = input.signals.map((s) => ({
    signalId: s.signalId,
    signalType: s.signalType,
    severity: s.severity,
    createdAt: s.createdAt,
    detail: s.detail ? redactText(s.detail).text : undefined,
  }));

  const contextSummary = redactText([input.context?.text ?? '', (input.context?.toolCalls ?? []).join(' ')].join('\n')).text;

  return {
    complete: true,
    missing: [],
    bundle: {
      signals,
      contextSummary,
      baseline: input.baseline as BaselineSnapshot,
      history: input.history.slice(0, 20),
      currentVersion: input.currentVersion,
      relatedChanges: input.relatedChanges,
      assembledAt: new Date().toISOString(),
    },
  };
}

/** 长期证据只保存脱敏摘要；原始对话不落库。 */
export function summarizeForLongTerm(bundle: EvidenceBundle): string {
  const metrics = Object.entries(bundle.baseline.metrics)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(4) : v}`)
    .join(',');
  return JSON.stringify({
    signals: bundle.signals.map((s) => s.signalType),
    baselineWindowHours: bundle.baseline.windowHours,
    samples: bundle.baseline.samples,
    metrics,
    currentVersion: bundle.currentVersion,
    relatedChanges: bundle.relatedChanges,
  });
}

/** 基线样本量判定：不足则不得自动晋升。 */
export function enoughSamples(sample: MetricSample | null, minSamples = 30): boolean {
  return !!sample && sample.sampleCount >= minSamples;
}

/** 是否已超过摘要保留期（复用观测中心 isExpired，语义一致）。 */
export function pastRetention(expiresAt: Date | null): boolean {
  return isExpired(expiresAt);
}
