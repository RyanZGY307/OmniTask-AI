import { prisma } from '../services/db';

export type RequestStatus = string;
export type EventType = string;
export type ErrorSeverity = string;

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function newTraceId(): string {
  return `tr_${uid()}`;
}

export function newRequestId(): string {
  return `req_${uid()}`;
}

/* ================================================================
   Create Trace
   ================================================================ */

export async function createTrace(params: {
  traceId: string;
  requestId: string;
  userId?: string;
  conversationId?: string;
  messageId?: string;
  parentMessageId?: string;
  requestedModel?: string;
  mode?: string;
  region?: string;
}): Promise<void> {
  try {
    await prisma.requestTrace.create({
      data: {
        id: params.traceId,
        requestId: params.requestId,
        userId: params.userId,
        conversationId: params.conversationId,
        messageId: params.messageId,
        parentMessageId: params.parentMessageId,
        requestedModel: params.requestedModel,
        mode: params.mode,
        region: params.region,
        environment: process.env.NODE_ENV || 'production',
        client: 'web',
        appVersion: process.env.APP_VERSION || '3.7.0',
        status: 'PROCESSING',
        startedAt: new Date(),
      },
    });
  } catch (err) {
    console.error('[TRACE] createTrace failed:', err);
  }
}

/* ================================================================
   Add Event
   ================================================================ */

export async function addEvent(traceId: string, eventType: EventType, payload?: any, status?: string, durationMs?: number): Promise<void> {
  try {
    await prisma.event.create({
      data: { traceId, eventType, payload: payload || undefined, status, durationMs },
    });
  } catch (err) {
    console.error('[TRACE] addEvent failed:', err);
  }
}

/* ================================================================
   Add Model Call
   ================================================================ */

export async function addModelCall(traceId: string, data: {
  provider?: string;
  requestedModel?: string;
  selectedModel?: string;
  modelVersion?: string;
  mode?: string;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  status?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  providerRawUsage?: any;
  inputCostUsd?: number;
  outputCostUsd?: number;
  totalCostUsd?: number;
  finishReason?: string;
  httpStatus?: number;
  errorMessage?: string;
}): Promise<void> {
  try {
    await prisma.modelCall.create({
      data: { traceId, ...data },
    });
  } catch (err) {
    console.error('[TRACE] addModelCall failed:', err);
  }
}

/* ================================================================
   Add Tool Call
   ================================================================ */

export async function addToolCall(traceId: string, data: {
  toolCallId?: string;
  toolName?: string;
  toolVersion?: string;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  status?: string;
  inputSize?: number;
  outputSize?: number;
  toolCostUsd?: number;
  errorCode?: string;
  errorMessage?: string;
}): Promise<void> {
  try {
    await prisma.toolCall.create({
      data: { traceId, ...data },
    });
  } catch (err) {
    console.error('[TRACE] addToolCall failed:', err);
  }
}

/* ================================================================
   Add Error
   ================================================================ */

export async function addError(traceId: string, data: {
  requestId?: string;
  userId?: string;
  errorType?: string;
  errorCode?: string;
  message?: string;
  stage?: string;
  provider?: string;
  model?: string;
  httpStatus?: number;
  retryCount?: number;
  recoverable?: boolean;
  resolved?: boolean;
  severity?: ErrorSeverity;
  stack?: string;
}): Promise<void> {
  try {
    await prisma.errorLog.create({
      data: {
        traceId,
        ...data,
        severity: data.severity || 'ERROR',
      },
    });
  } catch (err) {
    console.error('[TRACE] addError failed:', err);
  }
}

/* ================================================================
   Add Billing Transaction
   ================================================================ */

export async function addBillingTransaction(traceId: string, data: {
  requestId?: string;
  userId?: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  reason?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalApiCostUsd?: number;
  pricingVersion?: string;
  idempotencyKey?: string;
}): Promise<void> {
  try {
    const existing = data.idempotencyKey
      ? await prisma.billingTransaction.findUnique({ where: { idempotencyKey: data.idempotencyKey } })
      : null;
    if (existing) return;

    await prisma.billingTransaction.create({
      data: { traceId, ...data },
    });
  } catch (err) {
    console.error('[TRACE] addBillingTransaction failed:', err);
  }
}

/* ================================================================
   Complete Trace
   ================================================================ */

export async function completeTrace(traceId: string, data: {
  status: RequestStatus;
  selectedModel?: string;
  provider?: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalApiCostUsd?: number;
  creditsCharged?: number;
  creditsRefunded?: number;
  creditsBefore?: number;
  creditsAfter?: number;
  finishReason?: string;
  ttftMs?: number;
  streamDurationMs?: number;
  streamInterrupted?: boolean;
  streamInterruptionReason?: string;
  cancelledBy?: string;
  pricingVersion?: string;
}): Promise<void> {
  try {
    const trace = await prisma.requestTrace.findUnique({ where: { id: traceId } });
    if (!trace) return;

    const completedAt = new Date();
    const durationMs = trace.startedAt ? completedAt.getTime() - trace.startedAt.getTime() : undefined;

    await prisma.requestTrace.update({
      where: { id: traceId },
      data: {
        status: data.status,
        completedAt,
        durationMs,
        selectedModel: data.selectedModel,
        provider: data.provider,
        totalTokens: data.totalTokens,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        cachedInputTokens: data.cachedInputTokens,
        reasoningTokens: data.reasoningTokens,
        totalApiCostUsd: data.totalApiCostUsd,
        creditsCharged: data.creditsCharged,
        creditsRefunded: data.creditsRefunded,
        creditsBefore: data.creditsBefore,
        creditsAfter: data.creditsAfter,
        finishReason: data.finishReason,
        ttftMs: data.ttftMs,
        streamDurationMs: data.streamDurationMs,
        streamInterrupted: data.streamInterrupted || false,
        streamInterruptionReason: data.streamInterruptionReason,
        cancelledBy: data.cancelledBy,
        pricingVersion: data.pricingVersion || '2026-09',
        promptVersion: 'system-v1',
        routerVersion: 'router-v1',
      },
    });
  } catch (err) {
    console.error('[TRACE] completeTrace failed:', err);
  }
}

/* ================================================================
   Cleanup — delete traces older than 7 days
   ================================================================ */

export async function cleanupOldTraces(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await prisma.requestTrace.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (result.count > 0) {
      console.log(`[TRACE CLEANUP] Deleted ${result.count} old traces and cascaded events/errors/calls`);
    }
    return result.count;
  } catch (err) {
    console.error('[TRACE CLEANUP] Error:', err);
    return 0;
  }
}

/* ================================================================
   Stream Timing Helpers
   ================================================================ */

export class StreamTimer {
  requestStartedAt = new Date();
  streamStartedAt?: Date;
  firstTokenAt?: Date;
  streamCompletedAt?: Date;
  tokenCount = 0;

  onStreamStart() {
    this.streamStartedAt = new Date();
  }

  onFirstToken() {
    if (!this.firstTokenAt) this.firstTokenAt = new Date();
    this.tokenCount++;
  }

  onToken() {
    this.tokenCount++;
  }

  onStreamEnd() {
    this.streamCompletedAt = new Date();
  }

  get ttftMs(): number | undefined {
    if (!this.firstTokenAt) return undefined;
    return this.firstTokenAt.getTime() - this.requestStartedAt.getTime();
  }

  get streamDurationMs(): number | undefined {
    if (!this.streamStartedAt || !this.streamCompletedAt) return undefined;
    return this.streamCompletedAt.getTime() - this.streamStartedAt.getTime();
  }

  get totalDurationMs(): number {
    const end = this.streamCompletedAt || new Date();
    return end.getTime() - this.requestStartedAt.getTime();
  }
}