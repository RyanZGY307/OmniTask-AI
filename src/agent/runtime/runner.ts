// Runner 契约与共享执行助手（所有架构模式共用）
// 事件流：所有状态迁移必须落 EventStore（append-only）；模式差异只在控制流。
import type { AgentEvent, EventDraft, EventStore } from '../events/types';
import type { ModelClient, ModelMessage, ToolCallRequest, UsageBlock, ModelTier } from '../model/types';
import type { ToolRegistry, ToolResult } from '../tools/registry';
import { assessRisk } from '../policy/risk';
import type { ApprovalService } from '../policy/approval';
import { idempotencyKey } from '../events/ids';
import { PATTERNS, type PatternId, type Tier } from './patterns/types';
import type { AdvisorThresholds } from './advisor';

export interface RunContext {
  runId: string; taskId: string; userId: string; conversationId?: string;
  objective: string; userMessage: string;
  history: ModelMessage[];           // 宿主历史（已按其语义折叠）
  tier: Tier;
  depth: 'd1' | 'd2' | 'd3';
  workspaceRoots: string[];
  limits: { maxSteps: number; maxModelCalls: number; };
  signals: { dependencyDepth: number; goalAmbiguity: number; riskSideEffect: number; irreversibility: number; externalToolNeed: number; recoveryCost: number; verifiability: number };
  /** M1 恢复注入：挂起期人工决策（键=versionedToolId|argsJson）。M2 起改为 checkpoint 恢复 */
  decisions?: Record<string, 'approved' | 'denied'>;
  /**
   * M2 幂等恢复：挂起前已成功的 toolCallId 集合（来自 checkpoint/projection）。
   * toolTurn 见到这些调用 → 不再执行、发 tool.replayed_skipped、返回 kind='skipped_idempotent'——
   * 否则"整轮重放 + decisions 注入"会把写/bash 等副作用再执行一次（红线：幂等键不得退化成空话）。
   */
  replay?: { succeededToolCallIds?: ReadonlySet<string>; succeededToolFingerprints?: ReadonlySet<string>; note?: string };
}

export type RunOutcome =
  | { state: 'completed'; finalText: string }
  | { state: 'failed'; finalText: string; errorKind: string }
  | { state: 'waiting_approval'; approvalId: string; promptSummary: string; decisionKey?: string }
  | { state: 'waiting_user'; requestId: string; promptSummary: string; decisionKey?: string }
  | { state: 'budget_exhausted'; reason: string }
  | { state: 'canceled' };

export interface RunEnv {
  /** advisor 触发器阈值（可覆盖=标定实验入口；缺省=DEFAULT_ADVISOR_THRESHOLDS 设计值） */
  advisorThresholds?: AdvisorThresholds;
  store: EventStore; model: ModelClient; tools: ToolRegistry; approvals: ApprovalService;
  now?: () => string;
  /** M2：运行期上下文压缩钩子（AgentLoop 注入；返回压缩后的消息或 null=不压缩） */
  onCompact?: (runId: string, messages: import('../model/types').ModelMessage[], contextWindow: number) => Promise<import('../model/types').ModelMessage[] | null>;
  /**
   * M3：d3 无进展时的 advisor 钩子（AgentLoop 注入；未注入=不打扰）。
   * 必须如实返回 invoked=false 而非伪造 consulted（事件字段由本返回值决定）。
   */
  /** Multi-Agent 子代理 chat 并行度（未设=3；工具执行始终串行走审批漏斗） */
  maxConcurrency?: number;
  /** Route+Skill：宿主技能注册表（未注入=内置档案回退，事件如实标注 source） */
  skills?: import('./skills').SkillRegistry;
  onNoProgress?: (ctx: { runId: string; taskSummary: string; plan: string; stepsSinceArtifact: number }) => Promise<{
    invoked: boolean; agree?: boolean; objections?: number; suggestion?: string; adopted?: boolean;
  }>;
}

export interface PatternRunner {
  readonly id: PatternId;
  run(ctx: RunContext, env: RunEnv): Promise<RunOutcome>;
}

/** 步骤计数与模型调用计数（按 Run） */
export class RunBudget {
  steps = 0; modelCalls = 0;
  readonly ctx: RunContext;
  constructor(ctx: RunContext) { this.ctx = ctx; }
  takeStep(): boolean { this.steps++; return this.steps <= this.ctx.limits.maxSteps; }
  takeModelCall(): boolean { this.modelCalls++; return this.modelCalls <= this.ctx.limits.maxModelCalls; }
  get exhausted(): boolean { return this.steps > this.ctx.limits.maxSteps || this.modelCalls > this.ctx.limits.maxModelCalls; }
}

export class EventEmitter {
  readonly store: EventStore;
  readonly now: () => string;
  constructor(store: EventStore, now: () => string = () => new Date().toISOString()) { this.store = store; this.now = now; }
  async emit(runId: string, draft: Omit<EventDraft, 'runId'>): Promise<AgentEvent> {
    return this.store.append(runId, draft as EventDraft);
  }
  time(): string { return this.now(); }
}

/** 模型轮：chat + model_call 事件 + 降级事件 */
export async function modelTurn(env: RunEnv, ctx: RunContext, opts: {
  stepId: string; messages: ModelMessage[]; tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  tier?: string; thinking?: { mode: string; budgetTokens?: number };
}): Promise<{ ok: true; text: string; toolCalls: ToolCallRequest[]; errorKind?: string } | { ok: false; errorKind: string; text: string }> {
  const res = await env.model.chat({
    role: 'main', modelRef: { tier: (opts.tier ?? 'standard') as ModelTier },
    systemPrompt: 'system', messages: opts.messages, tools: opts.tools,
    thinking: opts.thinking,
    metadata: { runId: ctx.runId, stepId: opts.stepId, taskId: ctx.taskId, attempt: 0 },
  });
  const emitter = new EventEmitter(env.store);
  await emitter.emit(ctx.runId, {
    type: 'model_call.finished', level: 'info',
    payload: {
      stepId: opts.stepId, modelKey: res.modelRef.modelKey, provider: res.capabilitySnapshot.provider ?? 'unknown',
      finishReason: res.finishReason, latencyMs: res.latencyMs,
      // R-11：替身调用必须在事件流可见（L4 R5 门禁判据）；供应商未声明 = 视为真实
      simulated: res.simulated ?? env.model.simulated ?? false,
      usageSource: res.usage.source, input: res.usage.input, output: res.usage.output,
      toolCalls: res.toolCalls?.map((c) => c.name) ?? [],
    },
  });
  for (const d of res.degraded ?? []) {
    await emitter.emit(ctx.runId, { type: 'model_call.degraded', level: 'warn', payload: { stepId: opts.stepId, kind: d.kind, detail: d.detail } });
  }
  if (res.finishReason === 'error') return { ok: false, errorKind: res.errorKind ?? 'unknown', text: res.text };
  return { ok: true, text: res.text, toolCalls: res.toolCalls ?? [] };
}

export interface ToolTurnOutcome {
  kind: 'ok' | 'waiting_approval' | 'denied' | 'error' | 'skipped_idempotent';
  approvalId?: string; result?: ToolResult; risk: string; summary: string; reason?: string;
  /** 恢复注入键：`versionedToolId|argsJson`（决策通过后 resume() 以此键放行） */
  decisionKey?: string;
}

/** 工具轮：定级→r3 不自动→审批门→授权复检→执行→事件（tool.* 全落库） */
export async function toolTurn(env: RunEnv, ctx: RunContext, opts: {
  stepId: string; call: ToolCallRequest; argsJson: string; idemKey: string;
  forcedApprovalId?: string;   // 决策完成后续跑时由上层注入已批准的审批
}): Promise<ToolTurnOutcome> {
  const emitter = new EventEmitter(env.store);
  const spec = env.tools.get(opts.call.name);
  if (!spec) {
    await emitter.emit(ctx.runId, { type: 'step.failed', level: 'error', payload: { stepId: opts.stepId, errorKind: 'tool_not_found' } });
    return { kind: 'error', risk: 'r0', summary: 'tool_not_found' };
  }
  const risk = assessRisk(spec, opts.call.args);
  const summary = `${spec.id} ${opts.argsJson.slice(0, 120)}`;
  await emitter.emit(ctx.runId, {
    type: 'tool.requested', level: risk.level === 'r0' || risk.level === 'r1' ? 'info' : 'warn',
    payload: { stepId: opts.stepId, toolCallId: opts.call.id, toolId: spec.id, riskLevel: risk.level, idempotencyKey: opts.idemKey, argsSummary: opts.argsJson.slice(0, 200), reasons: risk.reasons },
  });
  // M2 幂等恢复：同一 (toolId,argsJson) 在挂起前已成功 → 不重复副作用（留痕 tool.replayed_skipped）。
  // 用指纹而非 toolCallId/stepId：resume 重放时模型会给新 toolCallId、步序号也重新计数，两者都不稳定。
  if (ctx.replay?.succeededToolFingerprints?.has(`${spec.id}|${opts.argsJson}`)) {
    await emitter.emit(ctx.runId, { type: 'tool.replayed_skipped', level: 'info', payload: { stepId: opts.stepId, toolCallId: opts.call.id, toolId: spec.id, idempotencyKey: opts.idemKey, reason: 'already_succeeded_before_suspend', note: ctx.replay.note } });
    return { kind: 'skipped_idempotent', risk: 'r0', summary, decisionKey: `${spec.id}|${opts.argsJson}` };
  }
  // 恢复期注入了人工决策：直接放行/拒绝（不再弹卡）
  const decision = ctx.decisions?.[`${spec.id}|${opts.argsJson}`];
  if (decision === 'denied') {
    await emitter.emit(ctx.runId, { type: 'step.denied', level: 'warn', payload: { stepId: opts.stepId, toolCallId: opts.call.id, reason: 'user_denied_recovery' } });
    return { kind: 'denied', risk: risk.level, summary, reason: 'user_denied_recovery' };
  }
  if (decision === 'approved') {
    const result = await env.tools.execute(spec.id, opts.call.args, { runId: ctx.runId, stepId: opts.stepId, idempotencyKey: opts.idemKey, workspaceRoots: ctx.workspaceRoots, budget: { timeoutMs: spec.timeoutMs, outputBudgetTokens: spec.outputBudgetTokens } });
    await emitter.emit(ctx.runId, { type: 'tool.result', level: result.ok ? 'info' : 'error', payload: { stepId: opts.stepId, toolCallId: opts.call.id, toolId: spec.id, ok: result.ok, errorKind: result.errorKind, durationMs: 0, idempotencyKey: opts.idemKey, replayed: true, argsJson: opts.argsJson } });
    if (result.ok && ctx.replay?.succeededToolFingerprints instanceof Set) (ctx.replay.succeededToolFingerprints as Set<string>).add(`${spec.id}|${opts.argsJson}`);
    return { kind: result.ok ? 'ok' : 'error', result, risk: risk.level, summary };
  }
  // r3：绝不自动执行（security §9.2）
  if (risk.level === 'r3' && !opts.forcedApprovalId) {
    const ap = env.approvals.request({ runId: ctx.runId, stepId: opts.stepId, toolId: spec.id, normalizedArgsJson: opts.argsJson, riskLevel: risk.level, summary });
    await emitter.emit(ctx.runId, { type: 'approval.requested', level: 'warn', payload: { approvalId: ap.id, stepId: opts.stepId, toolFingerprint: ap.toolFingerprint, riskLevel: ap.riskLevel, summary, expiresAt: 'run-terminal' } });
    return { kind: 'waiting_approval', approvalId: ap.id, risk: risk.level, summary, decisionKey: `${spec.id}|${opts.argsJson}` };
  }
  // r2：需已批准
  let approvalId = opts.forcedApprovalId;
  if (risk.level === 'r2' && !approvalId) {
    const ap = env.approvals.request({ runId: ctx.runId, stepId: opts.stepId, toolId: spec.id, normalizedArgsJson: opts.argsJson, riskLevel: risk.level, summary });
    await emitter.emit(ctx.runId, { type: 'approval.requested', level: 'warn', payload: { approvalId: ap.id, stepId: opts.stepId, toolFingerprint: ap.toolFingerprint, riskLevel: ap.riskLevel, summary, expiresAt: 'run-terminal' } });
    return { kind: 'waiting_approval', approvalId: ap.id, risk: risk.level, summary, decisionKey: `${spec.id}|${opts.argsJson}` };
  }
  if (approvalId) {
    const auth = env.approvals.authorize(ctx.runId, approvalId, spec.id, opts.argsJson);
    if (!auth.ok) {
      await emitter.emit(ctx.runId, { type: 'step.denied', level: 'warn', payload: { stepId: opts.stepId, toolCallId: opts.call.id, reason: auth.reason } });
      return { kind: 'denied', risk: risk.level, summary, reason: auth.reason };
    }
  }
  const t0 = Date.now();
  const result = await env.tools.execute(spec.id, opts.call.args, {
    runId: ctx.runId, stepId: opts.stepId, idempotencyKey: opts.idemKey,
    workspaceRoots: ctx.workspaceRoots, budget: { timeoutMs: spec.timeoutMs, outputBudgetTokens: spec.outputBudgetTokens },
  });
  await emitter.emit(ctx.runId, {
    type: result.ok ? 'tool.result' : 'step.failed',
    level: result.ok ? 'info' : 'error',
    payload: { stepId: opts.stepId, toolCallId: opts.call.id, toolId: spec.id, ok: result.ok, errorKind: result.errorKind, durationMs: Date.now() - t0, truncated: result.truncated ?? false, replayed: false, argsJson: opts.argsJson },
  });
  // M2 幂等：本次 run 内刚成功的调用立即入集——否则同一轮里模型重复提议同一 (tool,args) 会被执行两次
  if (result.ok && ctx.replay?.succeededToolFingerprints instanceof Set) {
    (ctx.replay.succeededToolFingerprints as Set<string>).add(`${spec.id}|${opts.argsJson}`);
  }
  return { kind: result.ok ? 'ok' : 'error', result, risk: risk.level, summary };
}

/** 每个 toolCall 的幂等键：stepId:toolCallId（core-data-model §6.4） */
export function callIdempotencyKey(stepId: string, toolCallId: string): string {
  return idempotencyKey(stepId, toolCallId);
}

/** 工具集→模型侧 ToolSpecRef 列表 */
export function toolSpecsFor(registry: ToolRegistry): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return registry.listEnabled().map((s) => ({ name: s.id, description: s.description, inputSchema: s.inputSchema }));
}

export function patternLabel(id: PatternId): string {
  return PATTERNS[id].label;
}
