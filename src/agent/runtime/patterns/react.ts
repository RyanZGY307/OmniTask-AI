// ReAct 模式：思考→行动→观察 迭代循环（上限=RunBudget；无计划工件；advisor 由 D3 触发）。
import type { PatternRunner } from '../runner';
import type { RunContext, RunEnv, RunOutcome } from '../runner';
import { EventEmitter, RunBudget, modelTurn, toolTurn, callIdempotencyKey, toolSpecsFor } from '../runner';
import { estimateTokens, DEFAULT_POLICY } from '../compactor';
import type { ModelMessage } from '../../model/types';
import { DEFAULT_ADVISOR_THRESHOLDS, shouldInvokeAdvisor } from '../advisor';

export const reactRunner: PatternRunner = {
  id: 'react',
  async run(ctx: RunContext, env: RunEnv): Promise<RunOutcome> {
    const emitter = new EventEmitter(env.store);
    const budget = new RunBudget(ctx);
    let messages: ModelMessage[] = [...ctx.history, { role: 'user', content: ctx.userMessage }];
    let stepsSinceArtifact = 0;
    for (let i = 0; i < ctx.limits.maxSteps; i++) {
      if (budget.exhausted) return { state: 'budget_exhausted', reason: 'limits' };
      // M2：上下文超软阈值→压缩（user.input 原话保护在 Compactor 内）；超硬阈值由 agentLoop.compactIfNeeded 触发
      const ctxWindow = env.model.describe({ tier: ctx.depth === 'd1' ? 'light' : 'standard' }).contextWindow;
      const { tokens } = estimateTokens(messages);
      if (tokens / ctxWindow >= DEFAULT_POLICY.softRatio) {
        const compacted = await env.onCompact?.(ctx.runId, messages, ctxWindow);
        if (compacted) messages = compacted;
      }
      if (!budget.takeModelCall()) return { state: 'budget_exhausted', reason: 'maxModelCalls' };
      if (!budget.takeStep()) return { state: 'budget_exhausted', reason: 'maxSteps' };
      const stepId = `s${budget.steps}`;
      await emitter.emit(ctx.runId, { type: 'step.started', level: 'info', payload: { seq: budget.steps, kind: 'model', title: `ReAct 轮 ${i + 1}` } });
      const r = await modelTurn(env, ctx, { stepId, messages, tools: toolSpecsFor(env.tools), tier: ctx.depth === 'd1' ? 'light' : 'standard' });
      if (!r.ok) {
        await emitter.emit(ctx.runId, { type: 'run.failed', level: 'error', payload: { errorKind: r.errorKind } });
        return { state: 'failed', finalText: r.text, errorKind: r.errorKind };
      }
      if (r.toolCalls.length === 0) {
        // 无工具调用 = 模型认为收敛（ReAct 终止条件）
        await emitter.emit(ctx.runId, { type: 'run.completed', level: 'info', payload: { finalText: r.text } });
        return { state: 'completed', finalText: r.text };
      }
      messages.push({ role: 'assistant', content: r.text });
      for (const call of r.toolCalls) {
        if (!budget.takeStep()) return { state: 'budget_exhausted', reason: 'maxSteps' };
        const tStepId = `s${budget.steps}`;
        const t = await toolTurn(env, ctx, { stepId: tStepId, call, argsJson: JSON.stringify(call.args), idemKey: callIdempotencyKey(tStepId, call.id) });
        if (t.kind === 'waiting_approval') return { state: 'waiting_approval', approvalId: t.approvalId!, promptSummary: t.summary, decisionKey: t.decisionKey };
        if (t.kind === 'denied' || t.kind === 'error') {
          messages.push({ role: 'tool', content: JSON.stringify({ ok: false, errorKind: t.reason ?? (t.result?.errorKind ?? 'error') }), toolCallId: call.id, name: call.name });
          continue;
        }
        messages.push({ role: 'tool', content: JSON.stringify(t.result?.output ?? {}), toolCallId: call.id, name: call.name });
      }
      stepsSinceArtifact++;
      // M3：d3 + 无进展 → advisor 第三意见（未注入钩子=不打扰，事件如实记 invoked:false）
      const adTh = env.advisorThresholds ?? DEFAULT_ADVISOR_THRESHOLDS;
      if (shouldInvokeAdvisor({ kind: 'no_progress', detail: 'steps_since_artifact', stepsSinceArtifact }, adTh) && ctx.depth === 'd3') {
        let advice: Awaited<ReturnType<NonNullable<RunEnv['onNoProgress']>>> = { invoked: false };
        if (env.onNoProgress) {
          advice = await env.onNoProgress({ runId: ctx.runId, taskSummary: ctx.objective, plan: messages.map((m) => m.content).join('\n').slice(-2000), stepsSinceArtifact });
        }
        await emitter.emit(ctx.runId, { type: 'no_progress.detected', level: 'warn', payload: { stepsSinceArtifact, thresholds: { ...adTh }, advisorInvoked: advice.invoked, advisorAgree: advice.agree, advisorObjections: advice.objections, advisorSuggestion: advice.suggestion, advisorAdopted: advice.adopted } });
      }
    }
    return { state: 'budget_exhausted', reason: 'maxSteps' };
  },
};
