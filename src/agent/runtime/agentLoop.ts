// AgentLoop 派发器（M1）：建 Run → 选模式（档位门禁+降级记录）→ 派发 Runner → 挂起/恢复/终态事件。
// 恢复语义（M1 诚实边界）：挂起后整轮重跑 + decisions 注入已批准项（幂等键防副作用重放）；
// 事件投影+断点恢复（projection + Checkpoint）在 M2 落地（见 roadmap M2）。
import type { EventStore } from '../events/types';
import type { ModelClient } from '../model/types';
import type { ToolRegistry } from '../tools/registry';
import type { ApprovalService, Approval } from '../policy/approval';
import { getRunner } from './patterns/index';
import { selectPattern, PATTERNS, type PatternId, type Tier } from './patterns/types';
import { EventEmitter, type RunContext, type RunEnv, type RunOutcome } from './runner';
import { BudgetGuard } from './guard';
import { CheckpointService } from './checkpoint/checkpointService';
import { SubagentRunner, type ParentToolChannel } from './subagent';
import { toolTurn } from './runner';
import { SkillRegistry } from './skills';
import { Advisor } from './advisor';
import type { HostMcpAdapter } from './mcp';
import { estimateTokens, pickLevel, c0Compact, c1Compact, DEFAULT_POLICY, type CompactLevel } from './compactor';
import { projectRun } from '../events/projection';
import type { ModelMessage } from '../model/types';

export interface RunRequest {
  runId: string; taskId: string; userId: string; conversationId?: string;
  objective: string; userMessage: string;
  history?: RunContext['history'];
  tier: Tier;
  requestedPattern?: PatternId;
  featureHints?: { decomposable?: boolean; skillMatch?: boolean; multiPerspective?: boolean; conditionalFlow?: boolean };
  signals: RunContext['signals'];
  workspaceRoots: string[];
  limits?: Partial<RunContext['limits']>;
  /** M2：运行期预算护栏（可选；缺省=仅步数/模型调用上限） */
  budget?: { maxCostUsd?: number; maxWallclockMs?: number };
}

export interface RunHandle {
  runId: string;
  outcome: RunOutcome;
  pattern: PatternId;
  selection: ReturnType<typeof selectPattern>;
  /** 便捷查询：最后一次运行的预算/压缩观测 */
  observations: { costUsd: number; steps: number; compactLog: CompactLevel[] };
}

export interface AgentLoopDeps {
  store: EventStore; model: ModelClient; tools: ToolRegistry; approvals: ApprovalService;
  /** M3 可选注入（缺省=该能力关闭，UI 显示不可用而非伪造） */
  checkpoints?: CheckpointService;
  subagents?: SubagentRunner;
  skills?: SkillRegistry;
  advisor?: Advisor;
  mcp?: HostMcpAdapter;
  /** Multi-Agent 子代理 chat 并行度（可选；缺省=3，见 multiAgent.resolveConcurrency） */
  maxConcurrency?: number;
}

export class AgentLoop {
  private lastReq?: RunRequest;
  private guard?: BudgetGuard;
  readonly deps: AgentLoopDeps;
  private lastObservations: RunHandle['observations'] = { costUsd: 0, steps: 0, compactLog: [] };

  constructor(deps: AgentLoopDeps) { this.deps = deps; }

  /**
   * 运行期上下文压缩检查（M2 接线）：调用方在 ReAct 类循环的每轮前调用。
   * 返回（可能已压缩的）消息序列；压缩事件落库（run.compacted）。
   * 红线：user.input 原话、进行中审批/提问不受压缩（protectedRoles: ['user']）。
   */
  async compactIfNeeded(runId: string, messages: ModelMessage[], contextWindow: number): Promise<ModelMessage[]> {
    if (!this.lastObservations) this.lastObservations = { costUsd: 0, steps: 0, compactLog: [] };
    const { tokens, estimator } = estimateTokens(messages);
    const ratio = contextWindow > 0 ? tokens / contextWindow : 0;
    const level = pickLevel(ratio);
    if (!level) return messages;
    const emitter = new EventEmitter(this.deps.store);
    let next = messages;
    if (level === 'c2' || level === 'c3') {
      const r = await c1Compact(this.deps.model, messages, { protectedRoles: ['user'], keepRecent: 4 });
      next = r.messages;
      if (r.summary === null && level === 'c3') next = c0Compact(messages, 4).messages;   // C1 失败再回落 C0
      else if (r.summary === null) next = c0Compact(messages, 4).messages;
    } else {
      next = c0Compact(messages, 4).messages;
    }
    this.lastObservations.compactLog.push(level);
    await emitter.emit(runId, { type: 'run.compacted', level: 'info', payload: { level, ratio, tokensEstimator: estimator, kept: next.length, origin: messages.length } });
    return next;
  }

  async start(req: RunRequest): Promise<RunHandle> {
    this.lastReq = req;
    const ctx = ctxOf(req);
    const emitter = new EventEmitter(this.deps.store);
    const guard = new BudgetGuard({ maxCostUsd: req.budget?.maxCostUsd, maxWallclockMs: req.budget?.maxWallclockMs, maxSteps: req.limits?.maxSteps });
    this.lastObservations = { costUsd: 0, steps: 0, compactLog: [] };
    this.guard = guard;
    await emitter.emit(ctx.runId, { type: 'run.created', level: 'info', payload: { taskId: ctx.taskId, conversationId: ctx.conversationId, userId: ctx.userId, depth: ctx.depth, modelTier: 'standard' } });

    const selection = selectPattern({ tier: ctx.tier, signals: ctx.signals, requested: req.requestedPattern, featureHints: req.featureHints });
    await emitter.emit(ctx.runId, { type: 'pattern.selected', level: 'info', payload: { pattern: selection.pattern, label: PATTERNS[selection.pattern].label, reason: selection.reason, tier: ctx.tier } });
    if (selection.downgraded) {
      await emitter.emit(ctx.runId, { type: 'pattern.downgraded', level: 'warn', payload: selection.downgraded });
    }
    ctx.depth = selection.depth;
    await emitter.emit(ctx.runId, { type: 'run.depth_decided', level: 'info', payload: { depth: ctx.depth, pattern: selection.pattern } });
    await emitter.emit(ctx.runId, { type: 'run.started', level: 'info', payload: {} });

    const runner = getRunner(selection.pattern);
    const outcome = await runner.run(ctx, this.#env());
    return this.#settle(ctx, emitter, outcome, selection);
  }

  /**
   * 挂起恢复：决策完成后重跑同模式。
   * M2 幂等保证（2026-10-25 落地）：从 checkpoint 优先、事件投影兜底，取「挂起前已成功的 toolCallId」集合注入 ctx.replay——
   * 重放时这些调用不再执行（发 tool.replayed_skipped），否则写/bash 等副作用会被执行两次。
   * 诚实边界：本实现仍按事件流整轮重建消息（不承诺"从快照秒恢复"），但副作用一次不重放。
   * 注意：skippedToolCalls 必须是**真实跳过的 toolCallId**，不得用 Object.keys(decisions) 冒充（旧实现即是）。
   */
  async resume(handle: RunHandle, decisions: Record<string, 'approved' | 'denied'>): Promise<RunHandle> {
    const req = this.lastReq;
    if (!req) return handle;
    this.lastObservations = { costUsd: 0, steps: 0, compactLog: [] };
    const plan = await this.#replayPlan(handle.runId);
    const ctx: RunContext = { ...ctxOf(req), decisions, replay: { succeededToolFingerprints: plan.succeededToolFingerprints, note: plan.note } };
    const emitter = new EventEmitter(this.deps.store);
    await emitter.emit(ctx.runId, { type: 'run.restored', level: 'info', payload: { fromCheckpointId: plan.fromCheckpointId, atEventSeq: plan.atEventSeq, skippedToolCalls: [...plan.succeededToolFingerprints] } });
    const runner = getRunner(handle.pattern);
    const outcome = await runner.run(ctx, this.#env());
    return this.#settle(ctx, emitter, outcome, handle.selection);
  }

  /** 恢复计划：checkpoint 优先（注入了才有），否则事件投影兜底；两者都无=空集合 */
  async #replayPlan(runId: string): Promise<{ succeededToolFingerprints: ReadonlySet<string>; fromCheckpointId: string; atEventSeq: number; note: string }> {
    if (this.deps.checkpoints) {
      const plan = await this.deps.checkpoints.cps.resumePlan(runId);
      return {
        succeededToolFingerprints: plan.projection.succeededToolFingerprints,
        fromCheckpointId: plan.checkpoint?.id ?? 'none(event-projection)',
        atEventSeq: plan.replayFromSeq,
        note: plan.checkpoint ? 'from-checkpoint' : 'from-event-projection',
      };
    }
    const proj = projectRun(await this.deps.store.getEvents(runId));
    return { succeededToolFingerprints: proj.succeededToolFingerprints, fromCheckpointId: 'none(event-projection)', atEventSeq: proj.lastSeq, note: 'from-event-projection' };
  }

  async decideApproval(approvalId: string, decision: 'approved' | 'denied', by: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.deps.approvals.decide(approvalId, decision, by);
  }

  /** 审批卡回执：判定 + 以 decisionKey 放行重跑 */
  async approveAndResume(handle: RunHandle, approvalId: string, decision: 'approved' | 'denied', decisionKey: string, by: string): Promise<RunHandle> {
    const r = await this.deps.approvals.decide(approvalId, decision, by);
    if (!r.ok) return handle;
    return this.resume(handle, { [decisionKey]: decision });
  }

  /**
   * M3：子代理 Guard 通道（红线）——子代理不得自行执行工具。
   * 注入 toolTurn 包装：子代理的每次工具调用都过定级→r3/r2 审批门→授权复检→事件。
   */
  #parentToolChannel(ctx: RunContext): ParentToolChannel {
    return async (call, idemKey) => toolTurn(this.#env(), ctx, {
      stepId: `sub_${ctx.runId}_${idemKey.split(':')[0]}`, call, argsJson: JSON.stringify(call.args), idemKey,
    });
  }

  /** 供宿主/模式层派发子代理：确保 Guard 通道与父级 ctx 已注入（未注入 deps.subagents 时返回 undefined） */
  subagentChannel(ctx: RunContext): SubagentRunner | undefined {
    if (!this.deps.subagents) return undefined;
    this.deps.subagents.parentToolChannel = this.#parentToolChannel(ctx);
    this.deps.subagents.parentCtx = ctx;
    return this.deps.subagents;
  }

  #env(): RunEnv {
    return {
      store: this.deps.store, model: this.deps.model, tools: this.deps.tools, approvals: this.deps.approvals,
      // M3 注入：未注入 skills 时 route_skill 走 builtin_fallback（事件如实标注 source），不伪造宿主技能
      skills: this.deps.skills,
      maxConcurrency: this.deps.maxConcurrency,
      onCompact: async (runId, messages, contextWindow) => {
        const before = messages.length;
        const out = await this.compactIfNeeded(runId, messages, contextWindow);
        return out.length !== before ? out : null;
      },
      onNoProgress: async ({ runId, taskSummary, plan, stepsSinceArtifact }) => {
        if (!this.deps.advisor) return { invoked: false };
        const op = await this.deps.advisor.consult({ runId, taskSummary, plan, lastError: undefined });
        if (!op) return { invoked: false };   // 顾问不可用→如实不打扰（已由 Advisor 落 degraded 事件）
        // 采纳留痕：advisor 同意=采纳；不同意由"决策理由"注入 plan 摘要（此处 v1 策略：同意即采纳，异议记入事件）
        await this.deps.advisor.recordAdoption(runId, op.agree, op.agree ? 'advisor 同意当前计划' : `advisor 异议 ${op.objections.length} 项：${op.suggestion}`);
        return { invoked: true, agree: op.agree, objections: op.objections.length, suggestion: op.suggestion, adopted: op.agree };
      },
    };
  }

  /** M3 能力面：UI 按此显示可用/不可用（缺注入=不可用，不伪造） */
  capabilities(): { checkpoints: boolean; subagents: boolean; skills: boolean; advisor: boolean; mcp: boolean } {
    return {
      checkpoints: Boolean(this.deps.checkpoints),
      subagents: Boolean(this.deps.subagents),
      skills: Boolean(this.deps.skills),
      advisor: Boolean(this.deps.advisor),
      mcp: Boolean(this.deps.mcp),
    };
  }

  /** M3：挂起/终态时强制 checkpoint（幂等恢复的前提） */
  async checkpointNow(runId: string): Promise<{ ok: boolean; checkpointId?: string }> {
    if (!this.deps.checkpoints) return { ok: false };
    const cp = await this.deps.checkpoints.tick(runId, true);
    return cp ? { ok: true, checkpointId: cp.id } : { ok: false };
  }

  async #settle(ctx: RunContext, emitter: EventEmitter, outcome: RunOutcome, selection: ReturnType<typeof selectPattern>): Promise<RunHandle> {
    // 步数/成本观测：从事件派生（run 级唯一事实源），guard 仅超限报警
    const evts = await this.deps.store.getEvents(ctx.runId);
    this.lastObservations.steps = evts.filter((e) => e.type === 'step.started').length;
    if (this.guard) this.lastObservations.costUsd = this.guard.state.costUsd;
    if (outcome.state === 'waiting_approval') {
      await emitter.emit(ctx.runId, { type: 'approval.requested', level: 'warn', payload: { approvalId: outcome.approvalId, summary: outcome.promptSummary, expiresAt: 'run-terminal' } });
    } else if (outcome.state === 'waiting_user') {
      await emitter.emit(ctx.runId, { type: 'userinput.requested', level: 'info', payload: { requestId: outcome.requestId, prompt: outcome.promptSummary } });
    } else if (outcome.state === 'completed') {
      await emitter.emit(ctx.runId, { type: 'pattern.completed', level: 'info', payload: { pattern: selection.pattern, state: 'completed' } });
    } else if (outcome.state === 'budget_exhausted') {
      await emitter.emit(ctx.runId, { type: 'run.budget_exhausted', level: 'warn', payload: { reason: outcome.reason } });
    }
    // DEC-02：只有终态才使该 Run 的 pending 审批过期；waiting_* 挂起态必须保留 pending
    if (isTerminalState(outcome.state)) this.deps.approvals.expireForRun(ctx.runId);
    // M3 接线：终态/挂起点强制存档（幂等恢复的前提；未注入 checkpoints=能力关闭，不伪造）
    if (this.deps.checkpoints && (isTerminalState(outcome.state) || outcome.state === 'waiting_approval' || outcome.state === 'waiting_user')) {
      await this.checkpointNow(ctx.runId);
    }
    return { runId: ctx.runId, outcome, pattern: selection.pattern, selection, observations: { ...this.lastObservations, compactLog: [...this.lastObservations.compactLog] } };
  }
}

/** 终态判定：仅这些状态才使 Run 的 pending 审批过期（等待态不是终态——DEC-02 单 Run 有效的前提） */
export function isTerminalState(state: RunOutcome['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'budget_exhausted';
}

function ctxOf(req: RunRequest): RunContext {
  return {
    runId: req.runId, taskId: req.taskId, userId: req.userId, conversationId: req.conversationId,
    objective: req.objective, userMessage: req.userMessage, history: req.history ?? [],
    tier: req.tier, depth: 'd2', workspaceRoots: req.workspaceRoots,
    limits: { maxSteps: 12, maxModelCalls: 12, ...(req.limits ?? {}) },
    signals: req.signals,
  };
}
