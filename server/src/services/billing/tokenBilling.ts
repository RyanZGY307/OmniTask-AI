// ================================================================
// Token Billing — Actual vs Display two-token separation.
//
//   ACTUAL  = raw provider usage. Immutable. Backend cost analysis,
//             model evolution, latency, quality. NEVER shown to user.
//   DISPLAY = inflation-multiplier-adjusted consumption. Shown to user
//             and used for credit deduction. NEVER used for cost.
//
// Only OUTPUT tokens are inflated (except overflow transfer). Input is
// never inflated. The 20% ceiling is a hard system limit.
//
// All pure functions here are deterministic — no randomness, no I/O.
// ================================================================

import { MODEL_REGISTRY, type ModelRegistryEntry } from '../../config';
import { getDynamicModels } from '../configSync';

// Three chat modes. fast is the baseline (no inflation); standard +10%;
// thinking +20%. MAX_ALLOWED_MULTIPLIER is a defensive hard cap — the
// actual runtimes never exceed it, it exists to guard the registry.
export const MODE_MULTIPLIER = {
  fast: 1.0,
  standard: 1.1,
  thinking: 1.2,
} as const;

export type ChatMode = keyof typeof MODE_MULTIPLIER;

export const MAX_ALLOWED_MULTIPLIER = 1.2;

// Invalid / unknown modes fall back to fast (multiplier 1.0).
export function normalizeMode(mode: string | undefined | null): ChatMode {
  if (mode && mode in MODE_MULTIPLIER) return mode as ChatMode;
  return 'fast';
}

export function multiplierFor(mode: ChatMode): number {
  const m = MODE_MULTIPLIER[mode] ?? MODE_MULTIPLIER.fast;
  // Defensive: never exceed the hard system ceiling.
  return Math.min(m, MAX_ALLOWED_MULTIPLIER);
}

export interface BillingResult {
  displayInput: number;
  displayOutput: number;
  displayTotal: number;
  overflowTransferred: boolean;
  overflowAmount: number;
}

// Core engine: convert actual provider tokens into user-visible
// consumption. Deterministic.
export function calculateBilling(
  actualInput: number,
  actualOutput: number,
  mode: ChatMode,
  verifiedOutputLimit: number | null,
): BillingResult {
  // Defend against negative / NaN provider values.
  const inp = Math.max(0, Math.floor(Number.isFinite(actualInput) ? actualInput : 0));
  const out = Math.max(0, Math.floor(Number.isFinite(actualOutput) ? actualOutput : 0));

  const multiplier = multiplierFor(mode);

  // 1) fast mode: return actuals verbatim — the baseline is never inflated.
  if (mode === 'fast') {
    return {
      displayInput: inp,
      displayOutput: out,
      displayTotal: inp + out,
      overflowTransferred: false,
      overflowAmount: 0,
    };
  }

  // 2) Unknown model limit: no inflation. 宁少不多 (charge less, never more).
  if (verifiedOutputLimit === null || !Number.isFinite(verifiedOutputLimit) || verifiedOutputLimit <= 0) {
    return {
      displayInput: inp,
      displayOutput: out,
      displayTotal: inp + out,
      overflowTransferred: false,
      overflowAmount: 0,
    };
  }

  // 3) Inflate output only. Math.ceil ensures whole tokens.
  const inflatedOutput = Math.min(Math.ceil(out * multiplier), Number.MAX_SAFE_INTEGER);

  // 4) Within limit: inflate normally, output only.
  if (inflatedOutput <= verifiedOutputLimit) {
    return {
      displayInput: inp,
      displayOutput: inflatedOutput,
      displayTotal: inp + inflatedOutput,
      overflowTransferred: false,
      overflowAmount: 0,
    };
  }

  // 5) Overflow: cap output at the limit, transfer the surplus to input.
  //    displayTotal is invariant = actualInput + inflatedOutput.
  const overflow = inflatedOutput - verifiedOutputLimit;
  return {
    displayInput: inp + overflow,
    displayOutput: verifiedOutputLimit,
    displayTotal: inp + inflatedOutput,
    overflowTransferred: true,
    overflowAmount: overflow,
  };
}

// Anti-reverse-engineering: deterministic rounding (no randomness).
// Same input always yields the same result. Used on display values
// before they reach the user so the exact multiplier is not recoverable
// from token counts.
export function deterministicRound(tokens: number): number {
  const n = Math.max(0, Math.floor(tokens));
  if (n < 100) return n;
  if (n < 1000) return Math.ceil(n / 10) * 10;
  return Math.ceil(n / 50) * 50;
}

// Apply anti-reverse-engineering rounding to a billing result and
// re-sum displayTotal so the total stays consistent.
export function applyAntiReverseRounding(result: BillingResult): BillingResult {
  const displayInput = deterministicRound(result.displayInput);
  const displayOutput = deterministicRound(result.displayOutput);
  return {
    ...result,
    displayInput,
    displayOutput,
    displayTotal: displayInput + displayOutput,
  };
}

// Credit deduction always uses displayTotal; cost accounting always uses
// actualTotal. This is the single point where display tokens convert to
// credits.
export function deductCredits(result: BillingResult, modelKey: string): number {
  const modelInfo: ModelRegistryEntry | undefined =
    (getDynamicModels()[modelKey] as ModelRegistryEntry) ?? (MODEL_REGISTRY as Record<string, ModelRegistryEntry>)[modelKey];
  const costPer1k = modelInfo?.costPer1k ?? 0;
  if (costPer1k <= 0) return 0;
  return Math.ceil((result.displayTotal / 1000) * costPer1k);
}

// Record persisted to TokenUsage (see schema-user.prisma). actualTotal =
// actualInput + actualOutput; displayTotal = displayInput + displayOutput.
// The two totals may diverge under overflow transfer.
export interface TokenUsageRecord {
  // ===== Actual (backend-only) =====
  actualInputTokens: number;
  actualOutputTokens: number;
  actualTotalTokens: number;

  // ===== Display (user-facing + deduction) =====
  displayInputTokens: number;
  displayOutputTokens: number;
  displayTotalTokens: number;

  // ===== Billing metadata =====
  mode: ChatMode;
  multiplier: number;
  overflowTransferred: boolean;
  overflowAmount: number;

  // ===== Model limit provenance =====
  model: string;
  modelVersion?: string | null;
  verifiedOutputLimit: number | null;
  limitSource?: 'provider_api' | 'official_sdk' | 'official_docs' | 'unknown';
  limitVerifiedAt?: string | null;
}

export type LimitSource = 'provider_api' | 'official_sdk' | 'official_docs' | 'unknown';
