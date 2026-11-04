// 单 Agent 模式：一次主模型轮 →（可选一次工具轮）→ 直接收敛。无计划工件、无 advisor。
import type { PatternRunner } from '../runner';
import type { RunContext, RunEnv, RunOutcome } from '../runner';
import { EventEmitter, RunBudget, modelTurn, toolSpecsFor, callIdempotencyKey } from '../runner';
import type { ModelMessage } from '../../model/types';

export const singleAgentRunner: PatternRunner = {
  id: 'single_agent',
  async run(ctx: RunContext, env: RunEnv): Promise<RunOutcome> {
    const emitter = new EventEmitter(env.store);
    const budget = new RunBudget(ctx);
    const messages: ModelMessage[] = [
      ...ctx.history,
      { role: 'user', content: ctx.userMessage },
    ];
    if (!budget.takeModelCall()) return { state: 'budget_exhausted', reason: 'maxModelCalls' };
    budget.takeStep();
    await emitter.emit(ctx.runId, { type: 'step.started', level: 'info', payload: { seq: budget.steps, kind: 'model', title: '主模型轮' } });
    const r = await modelTurn(env, ctx, { stepId: `s${budget.steps}`, messages, tools: toolSpecsFor(env.tools), tier: ctx.depth === 'd1' ? 'light' : 'standard' });
    if (!r.ok) return { state: 'failed', finalText: r.text, errorKind: r.errorKind };
    if (r.toolCalls.length > 0) {
      const call = r.toolCalls[0];                       // 单 Agent：只执行第一个调用（保守最少语义）
      if (!budget.takeStep()) return { state: 'budget_exhausted', reason: 'maxSteps' };
      const t = await toolTurnSafe(env, ctx, `s${budget.steps}`, call);
      if (t.kind === 'waiting_approval') return { state: 'waiting_approval', approvalId: t.approvalId!, promptSummary: t.summary, decisionKey: t.decisionKey };
      if (t.kind === 'denied' || t.kind === 'error') {
        await emitter.emit(ctx.runId, { type: 'step.failed', level: 'error', payload: { seq: budget.steps, errorKind: t.reason ?? 'tool_failed' } });
        return { state: 'failed', finalText: r.text, errorKind: t.reason ?? 'tool_failed' };
      }
    }
    await emitter.emit(ctx.runId, { type: 'run.completed', level: 'info', payload: { finalText: r.text } });
    return { state: 'completed', finalText: r.text };
  },
};

import { toolTurn as toolTurnImpl } from '../runner';
async function toolTurnSafe(env: RunEnv, ctx: RunContext, stepId: string, call: { id: string; name: string; args: Record<string, unknown> }) {
  const argsJson = JSON.stringify(call.args);
  return toolTurnImpl(env, ctx, { stepId, call, argsJson, idemKey: callIdempotencyKey(stepId, call.id) });
}
