// Plan+Execute：计划（todo 列表）→ 顺序执行 → verifier 复核 → 收敛/升级 advisor。
import type { PatternRunner } from '../runner';
import type { RunContext, RunEnv, RunOutcome } from '../runner';
import { EventEmitter, RunBudget, modelTurn, toolTurn, callIdempotencyKey, toolSpecsFor } from '../runner';
import type { ModelMessage } from '../../model/types';
import { DEFAULT_ADVISOR_THRESHOLDS, shouldInvokeAdvisor } from '../advisor';
import { parseActionProtocol } from '../../model/protocol';
import { estimateTokens, DEFAULT_POLICY } from '../compactor';

interface PlanStep { title: string; toolHint?: string }

export const planExecuteRunner: PatternRunner = {
  id: 'plan_execute',
  async run(ctx: RunContext, env: RunEnv): Promise<RunOutcome> {
    const emitter = new EventEmitter(env.store);
    const budget = new RunBudget(ctx);

    // 1) 计划轮：模型输出 ```plan JSON 数组（title + optional toolHint）
    if (!budget.takeModelCall()) return { state: 'budget_exhausted', reason: 'maxModelCalls' };
    if (!budget.takeStep()) return { state: 'budget_exhausted', reason: 'maxSteps' };
    const planStepId = `s${budget.steps}`;
    const plan = await modelTurn(env, ctx, {
      stepId: planStepId,
      messages: [...ctx.history, { role: 'user', content: `${ctx.userMessage}\n\n请先输出计划（\`\`\`plan 代码块，JSON 数组，每项 {"title":"...","toolHint":"可选"}）` }],
      tier: ctx.depth === 'd3' ? 'strong' : 'standard',
    });
    if (!plan.ok) return { state: 'failed', finalText: plan.text, errorKind: plan.errorKind };
    const steps = parsePlan(plan.text);
    await emitter.emit(ctx.runId, { type: 'step.succeeded', level: 'info', payload: { stepId: planStepId, title: '计划', planSize: steps.length } });

    let messages: ModelMessage[] = [...ctx.history, { role: 'user', content: ctx.userMessage }, { role: 'assistant', content: `计划：${steps.map((s) => s.title).join(' → ')}` }];

    // 2) 顺序执行（串行；v1 不支持并行——agent Prisma Step.seq 已为此约束）
    let stepsSinceArtifact = 0;   // 无工件轮数（d3 无进展→advisor 的判据；本模式无 artifact 工具调用即视为无进展）
    const ctxWindow = env.model.describe({ tier: ctx.depth === 'd3' ? 'strong' : 'standard' }).contextWindow;
    for (const [i, ps] of steps.entries()) {
      if (budget.exhausted) return { state: 'budget_exhausted', reason: 'limits' };
      if (!budget.takeModelCall()) return { state: 'budget_exhausted', reason: 'maxModelCalls' };
      if (!budget.takeStep()) return { state: 'budget_exhausted', reason: 'maxSteps' };
      const stepId = `s${budget.steps}`;
      await emitter.emit(ctx.runId, { type: 'step.started', level: 'info', payload: { seq: budget.steps, kind: 'model', title: `执行 ${i + 1}/${steps.length}: ${ps.title}` } });
      // M2：执行中上下文超软阈值→压缩（user.input 原话由 Compactor protectedRoles 保护）
      const { tokens } = estimateTokens(messages);
      if (tokens / ctxWindow >= DEFAULT_POLICY.softRatio) {
        const compacted = await env.onCompact?.(ctx.runId, messages, ctxWindow);
        if (compacted) messages = compacted;
      }
      const r = await modelTurn(env, ctx, { stepId, messages: [...messages, { role: 'user', content: `当前步骤：${ps.title}` }], tools: toolSpecsFor(env.tools), tier: 'standard' });
      if (!r.ok) return { state: 'failed', finalText: r.text, errorKind: r.errorKind };
      if (r.toolCalls.length > 0) {
        const call = r.toolCalls[0];
        const t = await toolTurn(env, ctx, { stepId: `${stepId}t`, call, argsJson: JSON.stringify(call.args), idemKey: callIdempotencyKey(`${stepId}t`, call.id) });
        if (t.kind === 'waiting_approval') return { state: 'waiting_approval', approvalId: t.approvalId!, promptSummary: t.summary, decisionKey: t.decisionKey };
        messages.push({ role: 'tool', content: JSON.stringify(t.result?.output ?? { ok: t.kind === 'ok' }), toolCallId: call.id, name: call.name });
      } else {
        messages.push({ role: 'assistant', content: r.text });
      }
      await emitter.emit(ctx.runId, { type: 'step.succeeded', level: 'info', payload: { stepId, title: ps.title } });
      stepsSinceArtifact++;
      // M3：d3 无进展 → advisor 第三意见（未注入钩子=不打扰，事件如实记 invoked:false）
      const adTh = env.advisorThresholds ?? DEFAULT_ADVISOR_THRESHOLDS;
      if (shouldInvokeAdvisor({ kind: 'no_progress', detail: 'steps_since_artifact', stepsSinceArtifact }, adTh) && ctx.depth === 'd3') {
        let advice: Awaited<ReturnType<NonNullable<RunEnv['onNoProgress']>>> = { invoked: false };
        if (env.onNoProgress) {
          advice = await env.onNoProgress({ runId: ctx.runId, taskSummary: ctx.objective, plan: steps.map((x) => x.title).join(' → '), stepsSinceArtifact });
        }
        await emitter.emit(ctx.runId, { type: 'no_progress.detected', level: 'warn', payload: { stepsSinceArtifact, thresholds: { ...adTh }, advisorInvoked: advice.invoked, advisorAgree: advice.agree, advisorObjections: advice.objections, advisorSuggestion: advice.suggestion, advisorAdopted: advice.adopted } });
      }
    }

    // 3) verifier 复核（DEC-04：低思考即可；独立主模型轮）
    if (!budget.takeModelCall()) return { state: 'budget_exhausted', reason: 'maxModelCalls' };
    if (!budget.takeStep()) return { state: 'budget_exhausted', reason: 'maxSteps' };
    const vStep = `s${budget.steps}`;
    const v = await modelTurn(env, ctx, {
      stepId: vStep,
      messages: [...messages, { role: 'user', content: '作为 verifier 复核本次执行是否达成目标；如未达成给出缺口，否则输出最终答复。' }],
      tier: 'standard',
    });
    if (!v.ok) return { state: 'failed', finalText: v.text, errorKind: v.errorKind };
    await emitter.emit(ctx.runId, { type: 'run.completed', level: 'info', payload: { finalText: v.text, verified: true } });
    return { state: 'completed', finalText: v.text };
  },
};

/** 从模型输出解析计划块：```plan\n[...]\n```；坏 JSON → 单步计划（降级不崩） */
export function parsePlan(text: string): PlanStep[] {
  const m = /```plan\s*\n([\s\S]*?)```/.exec(text);
  if (!m) {
    const calls = parseActionProtocol(text).calls;
    if (calls.length > 0) return calls.map((c) => ({ title: `工具步骤 ${c.name}`, toolHint: c.name }));
    return [{ title: '直接完成' }];
  }
  try {
    const arr = JSON.parse(m[1]) as unknown;
    if (Array.isArray(arr) && arr.every((x) => x && typeof x === 'object' && 'title' in x)) {
      return (arr as Array<{ title: string; toolHint?: string }>).map((s) => ({ title: String(s.title), toolHint: s.toolHint }));
    }
    return [{ title: '直接完成' }];
  } catch {
    return [{ title: '直接完成' }];
  }
}
