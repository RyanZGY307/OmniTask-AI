// ================================================================
// Context Memory — types, tier budgets, and shared helpers.
//
// Layering (spec): Context Memory = "what happened in the past, what
// is worth keeping". It sits between the raw Message table and
// Context-Aware Intent Analysis. Realtime retrieval is rule/DB based
// (millisecond budget); AI-driven compression and correction
// verification run as bounded background jobs.
//
// Budgets are resolved from the user's entitlement tier — never from
// prompt text or model-side heuristics (spec: "runtime membership /
// entitlement -> context budget resolver -> memory retrieval budget").
// ================================================================

export type ContextMemoryType =
  | 'user_message' // P1 raw user text
  | 'ai_output'    // P4 relevant assistant output
  | 'event'        // P2 corrections / requirements / preferences / task changes / decisions / references
  | 'fact'         // P5 durable verified facts
  | 'compressed'   // P6 compressed history
  | 'low_value';   // P7 low-value raw (fast-compressable)

export type EventKind =
  | 'correction'
  | 'requirement'
  | 'preference'
  | 'task_change'
  | 'decision'
  | 'reference'
  | 'fact';

export type VerificationStatus =
  | 'UNVERIFIED'
  | 'VERIFIED_USER_CLAIM'
  | 'VERIFIED_ASSISTANT_CLAIM'
  | 'CONFLICTED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'OUTDATED_USER_CLAIM'
  | 'OUTDATED_ASSISTANT_CLAIM'
  | 'NOT_VERIFIABLE';

export type CorrectionKind =
  | 'factual'
  | 'task'
  | 'preference'
  | 'opinion'
  | 'requirement';

export interface ContextMemoryBudget {
  tier: 'FREE' | 'PRO';
  // "Recent user raw messages kept near-verbatim" — a soft window, NOT
  // a hard truncation: the current P0 message is always kept in full
  // and other slots are filled by information value, not recency alone.
  recentUserMessageWindow: number;
  activeTaskBytes: number;         // ActiveTask payload budget
  longTermItems: number;          // durable (fact/decision/correction) entries
  compressedHistoryBytes: number; // P6 compressed history budget
  retrievalDepth: number;         // how far back retrieval may search
  retentionDays: number;          // how long P7 low-value history survives
}

// Unified tier/entitlement budget config (spec: keep numbers out of any
// system prompt; adjust capacity here only).
// Ranges per spec — Free: 10–18 msgs / 8–13 KB task / ~1000 long-term /
// 50–100 KB compressed / shallow; Pro: 20–30 msgs / 15–30 KB task /
// ~3000 long-term / 500 KB–1 MB compressed / deep.
const BUDGETS: Record<'FREE' | 'PRO', ContextMemoryBudget> = {
  FREE: {
    tier: 'FREE',
    recentUserMessageWindow: 10,
    activeTaskBytes: 8 * 1024,
    longTermItems: 1000,
    compressedHistoryBytes: 50 * 1024,
    retrievalDepth: 200,
    retentionDays: 30,
  },
  PRO: {
    tier: 'PRO',
    recentUserMessageWindow: 20,
    activeTaskBytes: 15 * 1024,
    longTermItems: 3000,
    compressedHistoryBytes: 500 * 1024,
    retrievalDepth: 2000,
    retentionDays: 180,
  },
};

// ULTRA (if present) and unknown tiers reuse PRO budgets this round:
// the spec says only implement Free/Pro Context budgets and Ultra must
// not be required for Context Memory to work.
export function resolveContextBudget(tier: string | null | undefined): ContextMemoryBudget {
  const t = (tier || 'FREE').toUpperCase();
  if (t === 'PRO' || t === 'ULTRA') return BUDGETS.PRO;
  return BUDGETS.FREE;
}

// ==================== Context-Aware Intent output shape ====================

export interface ContextReference {
  targetType: 'artifact' | 'ai_option' | 'ai_output' | 'file' | 'scenario' | 'task' | 'none';
  targetId?: string;
  ordinal?: number;
  summary?: string;
}

export interface CorrectionSignal {
  detected: boolean;
  kind: CorrectionKind;
  targetsPreviousAiOutput: boolean;
  verificationRequired: boolean;
  claimSummary?: string;
  userClaim?: string;
}

export interface ContextAwareIntentResult {
  // Existing dimensions stay authoritative; these are ADDED signals
  // (spec: minimal new fields, don't redesign downstream systems).
  contextRelation: 'new_request' | 'continuation' | 'correction' | 'requirement_change' | 'preference_change' | 'reference' | 'opinion';
  requirementChange: boolean;
  preferenceChange: boolean;
  capabilityIntent: string | null;
  artifactRequired: boolean;
  inAppPreview: boolean;
  reference: ContextReference | null;
  correction: CorrectionSignal;
  scenarioStable: boolean;
  // Merged context signals consumed by the Intent Analysis extension.
  activeTask: { task: string | null; stage: string | null; status: string; constraints: string[] } | null;
  openCorrections: Array<{ kind: string; userClaim: string | null; status: string }>;
  recentRequirements: string[];
  recentPreferences: string[];
}

// ==================== Priority mapping (P0..P7) ====================

export const PRIORITY: Record<ContextMemoryType, number> = {
  user_message: 1,
  event: 2,
  fact: 5,
  ai_output: 4,
  compressed: 6,
  low_value: 7,
};

// P0 is the current user message — it never lives in this store; it is
// always passed through verbatim by retrieval.

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ==================== Deterministic dedupe keys (idempotency) ====================

export function msgDedupeKey(conversationId: string, messageId: string, kind: string): string {
  return `${kind}:${conversationId}:${messageId}`;
}

export function correctionDedupeKey(conversationId: string, userMessageId: string, assistantClaimId: string | null): string {
  return `correction:${conversationId}:${userMessageId}:${assistantClaimId || 'none'}`;
}

export function compressionDedupeKey(conversationId: string, inputMemoryIds: string[], version: number): string {
  const rangeKey = inputMemoryIds.slice(0, 3).join('|') + ':' + inputMemoryIds.length + ':' + version;
  return `compress:${conversationId}:${rangeKey}`;
}
