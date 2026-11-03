// 事件类型与信封（docs/interfaces/task-events-and-user-input.md §7.1 词表的 M0 子集）
// TS  erasable 语法：无 enum/namespace；字符串字面量联合 + const 对象。

export const EVENT_LEVELS = ['info', 'warn', 'error'] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

export const EVENT_TYPES = [
  'run.created', 'run.depth_decided', 'run.depth_switched', 'run.started',
  'run.compacted', 'run.budget_exhausted', 'run.restored',
  'step.started', 'step.succeeded', 'step.failed', 'step.denied', 'step.skipped', 'step.timed_out',
  'model_call.started', 'model_call.finished', 'model_call.degraded',
  'tool.requested', 'tool.approved', 'tool.denied', 'tool.result', 'tool.replayed_skipped',
  'approval.requested', 'approval.decided', 'approval.expired',
  'user.input', 'userinput.requested', 'userinput.answered',
  'no_progress.detected', 'run.completed', 'run.failed', 'run.canceled',
  'pattern.selected', 'pattern.downgraded', 'pattern.switched', 'pattern.completed',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** append-only 事件信封（泛型 payload 由各 type 的载荷接口约束） */
export interface AgentEvent<P = Record<string, unknown>> {
  id: string;
  runId: string;
  seq: number;
  type: EventType;
  level: EventLevel;
  ts: string; // ISO-8601
  payload: P;
}

/** 待追加事件（seq/id/ts 由 store 分配） */
export type EventDraft<P = Record<string, unknown>> = Omit<AgentEvent<P>, 'id' | 'seq' | 'ts'> & {
  ts?: string;
};

// —— 关键载荷（M0 覆盖最小集；其余按 §7.1 词表扩展）——
export interface RunCreatedPayload { taskId: string; conversationId?: string; userId: string; depth: string; modelTier: string; }
export interface ToolRequestedPayload { stepId: string; toolCallId: string; toolId: string; toolVersion: string; riskLevel: string; idempotencyKey: string; argsSummary: string; }
export interface ToolResultPayload { stepId: string; toolCallId: string; toolId: string; ok: boolean; errorKind?: string; durationMs?: number; replayed?: boolean; }
export interface ApprovalRequestedPayload { approvalId: string; stepId: string; toolFingerprint: string; riskLevel: string; summary: string; expiresAt: string; }
export interface ApprovalDecidedPayload { approvalId: string; decision: 'approved' | 'denied' | 'expired' | 'canceled'; by?: string; }
export interface UserInputPayload { requestId: string; stepId: string; kind: string; prompt: string; options?: Array<{ label: string; value: string }>; allowCustom: boolean; }
export interface UserInputAnsweredPayload { requestId: string; answer: { selected?: string[]; custom?: string }; }
export interface RunRestoredPayload { fromCheckpointId: string; atEventSeq: number; skippedToolCalls: string[]; }
export interface NoProgressPayload { stepsSinceArtifact: number; advisorInvoked: boolean; }

export interface EventStore {
  append(runId: string, draft: EventDraft): Promise<AgentEvent>;
  appendBatch(runId: string, drafts: EventDraft[]): Promise<AgentEvent[]>;
  getEvents(runId: string, afterSeq?: number): Promise<AgentEvent[]>;
  lastSeq(runId: string): Promise<number>;
}
