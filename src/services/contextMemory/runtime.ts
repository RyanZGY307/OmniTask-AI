// ================================================================
// Context Memory Runtime — realtime write + retrieval.
//
// writeMemory(): persist the current user message (P1) + extracted
// high-value events (P2) + update Active Task State (P3) + detect and
// dispatch a verification trigger for factual corrections. Runs in
// the realtime path but is cheap (a few indexed inserts) and never
// blocks the response.
//
// retrieveContext(): builds the final Context Package by merging
// Active Task + latest requirements/preferences + corrections +
// relevant history + recent AI output, ordered by P0>P1>P2>P3>P4>P5>
// P6>P7 with superseded/archived filtering. Pure rule/DB, no LLM.
//
// The current user message (P0) is ALWAYS passed through verbatim by
// the caller; this store never re-summaries it.
// ================================================================

import { prismaUser } from '../db';
import { extractEvents, type ExtractionInput } from './extract';
import {
  resolveContextBudget,
  PRIORITY,
  clamp01,
  msgDedupeKey,
  correctionDedupeKey,
  type ContextMemoryBudget,
} from './types';

export interface WriteMemoryInput {
  userId: string;
  conversationId: string;
  messageId: string;
  message: string;
  recentHistory: Array<{ role: string; content: string; messageId?: string }>;
  tier?: string;
  scenarioId?: string | null;
  conversationArtifacts?: string[];
  assistantClaimMessageId?: string | null; // the AI message being corrected (if known)
}

export interface WriteMemoryResult {
  ok: boolean;
  eventsWritten: number;
  correctionEventId: string | null;
  verificationJobId: string | null;
  activeTaskUpdated: boolean;
}

// ==================== Write path (realtime, cheap) ====================

export async function writeMemory(input: WriteMemoryInput): Promise<WriteMemoryResult> {
  const tier = input.tier ?? 'FREE';
  const extraction = extractEvents({
    message: input.message,
    messageId: input.messageId,
    recentHistory: input.recentHistory,
    conversationArtifacts: input.conversationArtifacts,
    scenarioId: input.scenarioId,
  });

  let eventsWritten = 0;
  let correctionEventId: string | null = null;
  let verificationJobId: string | null = null;
  let activeTaskUpdated = false;

  // 1) Persist the raw user message (P1). Idempotent via dedupeKey.
  const msgKey = msgDedupeKey(input.conversationId, input.messageId, 'user_message');
  await upsertMemory({
    userId: input.userId,
    conversationId: input.conversationId,
    type: 'user_message',
    content: input.message.slice(0, 4000),
    priority: PRIORITY.user_message,
    importance: extraction.importance,
    dedupeKey: msgKey,
    provenanceMessageId: input.messageId,
    scenarioId: input.scenarioId ?? null,
    entities: JSON.stringify(extraction.reference?.targetType === 'artifact' ? [extraction.reference.targetId] : []),
    references: extraction.reference.targetType !== 'none' ? JSON.stringify(extraction.reference) : null,
  });
  eventsWritten++;

  // 2) Persist high-value events (P2).
  const now = new Date();
  if (extraction.correction.detected) {
    const corrKey = correctionDedupeKey(input.conversationId, input.messageId, input.assistantClaimMessageId ?? null);
    const corr = await upsertCorrectionEvent({
      userId: input.userId,
      conversationId: input.conversationId,
      dedupeKey: corrKey,
      messageFromId: input.messageId,
      assistantClaimId: input.assistantClaimMessageId ?? null,
      kind: extraction.correction.kind,
      targetsPreviousAiOutput: extraction.correction.targetsPreviousAiOutput,
      verificationRequired: extraction.correction.verificationRequired,
      claimSummary: extraction.correction.claimSummary ?? null,
      userClaim: extraction.correction.userClaim ?? null,
    });
    correctionEventId = corr.id;
    eventsWritten++;

    // Factual corrections immediately become a verification trigger
    // (never wait for a compression cycle, spec).
    if (extraction.correction.kind === 'factual' && extraction.correction.verificationRequired) {
      verificationJobId = await dispatchVerificationJob({
        correctionEventId: corr.id,
        userId: input.userId,
        conversationId: input.conversationId,
        claimSummary: extraction.correction.claimSummary,
        userClaim: extraction.correction.userClaim,
      });
    }
  }

  if (extraction.requirementChange) {
    await upsertMemory({
      userId: input.userId,
      conversationId: input.conversationId,
      type: 'event',
      eventKind: 'requirement',
      content: input.message.slice(0, 1000),
      priority: PRIORITY.event,
      importance: 0.8,
      dedupeKey: msgDedupeKey(input.conversationId, input.messageId, 'req'),
      provenanceMessageId: input.messageId,
    });
    eventsWritten++;
  }
  if (extraction.preferenceChange) {
    await upsertMemory({
      userId: input.userId,
      conversationId: input.conversationId,
      type: 'event',
      eventKind: 'preference',
      content: input.message.slice(0, 1000),
      priority: PRIORITY.event,
      importance: 0.75,
      dedupeKey: msgDedupeKey(input.conversationId, input.messageId, 'pref'),
      provenanceMessageId: input.messageId,
    });
    eventsWritten++;
  }
  if (extraction.decisionMade) {
    await upsertMemory({
      userId: input.userId,
      conversationId: input.conversationId,
      type: 'event',
      eventKind: 'decision',
      content: input.message.slice(0, 1000),
      priority: PRIORITY.event,
      importance: 0.9,
      dedupeKey: msgDedupeKey(input.conversationId, input.messageId, 'decision'),
      provenanceMessageId: input.messageId,
    });
    eventsWritten++;
  }
  if (extraction.taskStageChange) {
    activeTaskUpdated = await applyTaskStageChange(input.userId, input.conversationId, extraction.taskStageChange, input.message);
  }

  // 3) Mark the previous user_message event superseded-if-supersede (the
  // newest requirement/correction overrides the older one). Low-risk:
  // only supersede matching eventKind when the new one is higher priority.
  // (Handled lazily by retrieval; no destructive delete here.)

  void now;
  return { ok: true, eventsWritten, correctionEventId, verificationJobId, activeTaskUpdated };
}

// ==================== Active Task State (P3) ====================

export interface ActiveTaskSnapshot {
  task: string | null;
  stage: string | null;
  status: string;
  currentGoal: string | null;
  constraints: string[];
  updatedAt: Date;
}

export async function getActiveTask(userId: string, conversationId: string): Promise<ActiveTaskSnapshot | null> {
  const row = await prismaUser.activeTaskState.findUnique({
    where: { userId_conversationId: { userId, conversationId } },
  });
  if (!row) return null;
  let constraints: string[] = [];
  try { constraints = row.constraints ? JSON.parse(row.constraints) : []; } catch { constraints = []; }
  return {
    task: row.task,
    stage: row.stage,
    status: row.status,
    currentGoal: row.currentGoal,
    constraints,
    updatedAt: row.updatedAt,
  };
}

async function applyTaskStageChange(userId: string, conversationId: string, stage: string, message: string): Promise<boolean> {
  const existing = await prismaUser.activeTaskState.findUnique({
    where: { userId_conversationId: { userId, conversationId } },
  });

  // discussion_only is a constraint, not a stage value.
  if (stage === 'discussion_only') {
    const constraints = new Set<string>();
    if (existing?.constraints) { try { for (const c of JSON.parse(existing.constraints)) constraints.add(c); } catch {} }
    constraints.add('discussion_only');
    constraints.add('no_implementation_yet');
    if (existing) {
      await prismaUser.activeTaskState.update({
        where: { userId_conversationId: { userId, conversationId } },
        data: {
          stage: existing.stage ?? 'design',
          constraints: JSON.stringify([...constraints]),
          currentGoal: message.slice(0, 300),
          payloadJson: existing.payloadJson, // keep prior state
        },
      });
    } else {
      await prismaUser.activeTaskState.create({
        data: {
          userId, conversationId,
          stage: 'design',
          status: 'in_progress',
          constraints: JSON.stringify([...constraints]),
          currentGoal: message.slice(0, 300),
        },
      });
    }
    return true;
  }

  // A concrete stage transition (implementation etc.) clears the
  // discussion-only constraint (supersede, don't delete).
  const constraints: string[] = [];
  if (existing?.constraints) {
    try {
      for (const c of JSON.parse(existing.constraints)) {
        if (stage === 'implementation' && (c === 'discussion_only' || c === 'no_implementation_yet')) continue;
        constraints.push(c);
      }
    } catch {}
  }

  if (existing) {
    await prismaUser.activeTaskState.update({
      where: { userId_conversationId: { userId, conversationId } },
      data: {
        stage,
        status: 'in_progress',
        constraints: JSON.stringify(constraints),
        currentGoal: existing.currentGoal ?? message.slice(0, 300),
        payloadJson: JSON.stringify(existing), // prior state superseded, kept
      },
    });
  } else {
    await prismaUser.activeTaskState.create({
      data: { userId, conversationId, stage, status: 'in_progress', constraints: JSON.stringify(constraints) },
    });
  }
  return true;
}

// ==================== Correction events + verification dispatch ====================

async function upsertCorrectionEvent(data: {
  userId: string;
  conversationId: string;
  dedupeKey: string;
  messageFromId: string;
  assistantClaimId: string | null;
  kind: string;
  targetsPreviousAiOutput: boolean;
  verificationRequired: boolean;
  claimSummary: string | null;
  userClaim: string | null;
}): Promise<{ id: string }> {
  const row = await prismaUser.correctionEvent.upsert({
    where: { userId_conversationId_dedupeKey: { userId: data.userId, conversationId: data.conversationId, dedupeKey: data.dedupeKey } },
    create: {
      userId: data.userId,
      conversationId: data.conversationId,
      dedupeKey: data.dedupeKey,
      messageFromId: data.messageFromId,
      assistantClaimId: data.assistantClaimId,
      kind: data.kind,
      targetsPreviousAiOutput: data.targetsPreviousAiOutput,
      verificationRequired: data.verificationRequired,
      claimSummary: data.claimSummary,
      userClaim: data.userClaim,
      verificationStatus: 'UNVERIFIED',
    },
    update: {}, // idempotent: first write wins
  });
  return { id: row.id };
}

// dispatchVerificationJob reuses the EXISTING research-job infrastructure
// (ResearchJob + workerPool) — no second verification pipeline. The
// correction-specific plan is carried in planJson.
async function dispatchVerificationJob(args: {
  correctionEventId: string;
  userId: string;
  conversationId: string;
  claimSummary?: string;
  userClaim?: string;
}): Promise<string | null> {
  try {
    // Idempotent: reuse an active verification job for the same correction.
    const existing = await prismaUser.verificationJob.findFirst({
      where: { correctionEventId: args.correctionEventId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (existing) return existing.id;

    const queries = buildVerificationQueries(args.claimSummary, args.userClaim);
    const job = await prismaUser.verificationJob.create({
      data: {
        correctionEventId: args.correctionEventId,
        userId: args.userId,
        conversationId: args.conversationId,
        status: 'QUEUED',
        queriesJson: JSON.stringify(queries),
      },
    });

    // Enqueue into the shared research queue via ResearchJob so the
    // workerPool picks it up with bounded concurrency. The planJson
    // flags it as a verification job pointing back at the correction.
    await prismaUser.researchJob.create({
      data: {
        objectId: `correction:${args.correctionEventId}`,
        variantId: null,
        jobType: 'correction_verification',
        status: 'QUEUED',
        priority: 4,
        planJson: JSON.stringify({
          verificationJobId: job.id,
          correctionEventId: args.correctionEventId,
          queries,
          claimSummary: args.claimSummary,
          userClaim: args.userClaim,
        }),
      },
    });
    return job.id;
  } catch (err: any) {
    console.warn('[ContextMemory] verification dispatch failed:', err?.message);
    return null;
  }
}

// Decompose a factual correction into parallel, independent research
// queries (spec Step 5). These fan out to separate retrieval + analysis.
// Exported for tests.
export function buildVerificationQueries(claimSummary: string | undefined, userClaim: string | undefined): string[] {
  const base = [userClaim, claimSummary].filter(Boolean).join(' vs ');
  if (!base) return [];
  const queries = [
    `${base} — official confirmation / release notes`,
    `${base} — latest version / current state from primary source`,
    `${base} — release date / time of change`,
  ];
  return Array.from(new Set(queries)).slice(0, 4);
}

// ==================== Memory upsert helpers ====================

interface UpsertMemoryInput {
  userId: string;
  conversationId: string;
  type: string;
  content: string;
  priority: number;
  importance?: number;
  dedupeKey?: string | null;
  eventKind?: string | null;
  provenanceMessageId?: string | null;
  scenarioId?: string | null;
  entities?: string | null;
  references?: string | null;
}

async function upsertMemory(input: UpsertMemoryInput): Promise<void> {
  if (!input.dedupeKey) {
    await prismaUser.contextMemory.create({
      data: {
        userId: input.userId,
        conversationId: input.conversationId,
        type: input.type,
        content: input.content,
        priority: input.priority,
        importance: clamp01(input.importance ?? 0.5),
        eventKind: input.eventKind ?? null,
        provenanceMessageId: input.provenanceMessageId ?? null,
        scenarioId: input.scenarioId ?? null,
        entities: input.entities ?? null,
        references: input.references ?? null,
      },
    });
    return;
  }
  await prismaUser.contextMemory.upsert({
    where: { userId_conversationId_dedupeKey: { userId: input.userId, conversationId: input.conversationId, dedupeKey: input.dedupeKey } },
    create: {
      userId: input.userId,
      conversationId: input.conversationId,
      type: input.type,
      content: input.content,
      priority: input.priority,
      importance: clamp01(input.importance ?? 0.5),
      eventKind: input.eventKind ?? null,
      provenanceMessageId: input.provenanceMessageId ?? null,
      scenarioId: input.scenarioId ?? null,
      entities: input.entities ?? null,
      references: input.references ?? null,
    },
    update: {}, // idempotent first-write
  });
}

// ==================== Retrieval (realtime, no LLM) ====================

export interface ContextPackage {
  activeTask: ActiveTaskSnapshot | null;
  recentUserMessages: string[]; // P1
  corrections: Array<{ kind: string; userClaim: string | null; status: string }>;
  requirements: string[];
  preferences: string[];
  decisions: string[];
  facts: string[]; // P5 verified facts
  compressedHistory: string; // P6
  recentAiOutputs: string[]; // P4
  totalItems: number;
}

export async function retrieveContext(
  userId: string,
  conversationId: string,
  tier: string,
): Promise<ContextPackage> {
  const budget = resolveContextBudget(tier);

  // Superseded + archived rows are excluded from the package.
  const activeWhere = {
    userId,
    conversationId,
    status: 'active',
  } as const;

  const [activeTask, recentUser, corrections, reqs, prefs, decisions, facts, compressed] =
    await Promise.all([
      getActiveTask(userId, conversationId),
      prismaUser.contextMemory.findMany({
        where: { ...activeWhere, type: 'user_message' },
        orderBy: { createdAt: 'desc' },
        take: budget.recentUserMessageWindow,
        select: { content: true },
      }),
      prismaUser.correctionEvent.findMany({
        where: { userId, conversationId, verificationRequired: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { kind: true, userClaim: true, verificationStatus: true },
      }),
      prismaUser.contextMemory.findMany({
        where: { ...activeWhere, eventKind: 'requirement' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { content: true },
      }),
      prismaUser.contextMemory.findMany({
        where: { ...activeWhere, eventKind: 'preference' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { content: true },
      }),
      prismaUser.contextMemory.findMany({
        where: { ...activeWhere, eventKind: 'decision' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { content: true },
      }),
      prismaUser.contextMemory.findMany({
        where: { ...activeWhere, type: 'fact' },
        orderBy: { importance: 'desc' },
        take: Math.min(budget.longTermItems, 40),
        select: { content: true },
      }),
      prismaUser.contextMemory.findMany({
        where: { ...activeWhere, type: 'compressed' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { content: true },
      }),
    ]);

  // P4 relevant AI outputs — take recent, capped by retrieval depth.
  const aiOuts = await prismaUser.contextMemory.findMany({
    where: { ...activeWhere, type: 'ai_output' },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { content: true },
  });

  const pkg: ContextPackage = {
    activeTask,
    recentUserMessages: recentUser.map((r) => r.content),
    corrections: corrections.map((c) => ({ kind: c.kind, userClaim: c.userClaim, status: c.verificationStatus })),
    requirements: reqs.map((r) => r.content),
    preferences: prefs.map((r) => r.content),
    decisions: decisions.map((r) => r.content),
    facts: facts.map((f) => f.content),
    compressedHistory: compressed[0]?.content ?? '',
    recentAiOutputs: aiOuts.map((a) => a.content),
    totalItems: 0,
  };
  pkg.totalItems =
    pkg.recentUserMessages.length + pkg.corrections.length + pkg.requirements.length +
    pkg.preferences.length + pkg.decisions.length + pkg.facts.length + pkg.recentAiOutputs.length;
  return pkg;
}

// ==================== Budget pressure check (drives compression) ====================

export interface BudgetStatus {
  overBudget: boolean;
  activeCount: number;
  estimatedBytes: number;
  reason: 'ok' | 'long_term_items' | 'compressed_bytes' | 'retrieval_depth';
}

// Write a single Context Memory event row for a generated artifact
// (e.g. `artifact_created` after a successful audio/image/video
// generation). Fire-and-forget safe: never throws.
export async function writeContextMemoryEvent(
  userId: string,
  conversationId: string,
  event: {
    eventType: string;
    artifactType?: string;
    artifactId?: string;
    messageId?: string;
    model?: string;
    format?: string;
    generationId?: string;
    [k: string]: any;
  },
): Promise<void> {
  try {
    await prismaUser.contextMemory.create({
      data: {
        userId,
        conversationId,
        type: 'event',
        eventKind: event.eventType,
        content: JSON.stringify(event).slice(0, 2000),
        priority: 2,
        importance: 0.8,
        status: 'active',
        entities: event.artifactId ? JSON.stringify([event.artifactId]) : null,
        references: event.artifactId ? JSON.stringify({ targetType: 'artifact', targetId: event.artifactId, artifactType: event.artifactType }) : null,
      },
    });
  } catch (err: any) {
    console.warn('[ContextMemory] event write failed:', err?.message);
  }
}

export async function checkBudget(
  userId: string,
  conversationId: string,
  tier: string,
): Promise<BudgetStatus> {
  const budget = resolveContextBudget(tier);
  const [longTerm, compressedRows, activeCount] = await Promise.all([
    prismaUser.contextMemory.count({
      where: { userId, conversationId, type: { in: ['fact', 'event'] }, status: 'active' },
    }),
    prismaUser.contextMemory.findMany({
      where: { userId, conversationId, type: 'compressed', status: 'active' },
      select: { content: true },
    }),
    prismaUser.contextMemory.count({ where: { userId, conversationId, status: 'active' } }),
  ]);

  const compressedBytes = compressedRows.reduce((s, r) => s + (r.content?.length ?? 0), 0);

  if (longTerm > budget.longTermItems) {
    return { overBudget: true, activeCount, estimatedBytes: compressedBytes, reason: 'long_term_items' };
  }
  if (compressedBytes > budget.compressedHistoryBytes) {
    return { overBudget: true, activeCount, estimatedBytes: compressedBytes, reason: 'compressed_bytes' };
  }
  if (activeCount > budget.retrievalDepth * 2) {
    return { overBudget: true, activeCount, estimatedBytes: compressedBytes, reason: 'retrieval_depth' };
  }
  return { overBudget: false, activeCount, estimatedBytes: compressedBytes, reason: 'ok' };
}
