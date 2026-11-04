// Multi-Agent：主脑拆解→子代理并行执行→合并→收敛。
// 并行边界（诚实声明）：
//  - **模型轮真并行**（N 个子代理的 chat 并发；上限 maxConcurrency，默认 3）——延迟收益在这儿。
//  - **工具调用串行化**：子代理并行阶段只"收集"工具调用，执行统一走 toolTurn 漏斗。
//    理由：DEC-02 审批语义 = 单 Run 同时只有一个 waiting_approval；事件 seq 单调（EventStore 单写者）。
//  - 因此"无副作用的子任务真并行、有副作用的子任务经同一审批门"——不是假装全parallel。
import type { PatternRunner } from '../runner';
import type { RunContext, RunEnv, RunOutcome } from '../runner';
import { EventEmitter, RunBudget, modelTurn, toolTurn, callIdempotencyKey, toolSpecsFor } from '../runner';
import type { ModelMessage, ToolCallRequest } from '../../model/types';
import { parsePlan } from './planExecute';

/** 并发上限（子代理 chat 并行度）；0/负数=串行 */
export function resolveConcurrency(hint?: number): number {
  if (hint === undefined) return 3;
  return hint > 0 ? Math.min(hint, 8) : 1;   // 上限 8：防 fan-out 失控
}

interface SubTask { title: string; toolHint?: string; }
interface PendingCall { subIndex: number; call: ToolCallRequest; }
interface SubState { index: number; title: string; text: string; toolOutputs: string[]; waitingApproval?: RunOutcome & { state: 'waiting_approval' }; failed?: RunOutcome & { state: 'failed' }; }

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export const multiAgentRunner: PatternRunner = {
  id: 'multi_agent',
  async run(ctx: RunContext, env: RunEnv): Promise<RunOutcome> {
    const emitter = new EventEmitter(env.store);
    const budget = new RunBudget(ctx);
    // 并发上限从 env.maxConcurrency 读（未设=默认 3；宿主可调，不进入持久契约）
    const conc = resolveConcurrency(env.maxConcurrency);

    if (!budget.takeModelCall()) return { state: 'budget_exhausted', reason: 'maxModelCalls' };
    if (!budget.takeStep()) return { state: 'budget_exhausted', reason: 'maxSteps' };
    const planStep = `s${budget.steps}`;
    const plan = await modelTurn(env, ctx, {
      stepId: planStep,
      messages: [...ctx.history, { role: 'user', content: `${ctx.userMessage}\n\n请拆解为可独立执行的子任务（\`\`\`plan JSON 数组，每项 {"title":"...","toolHint":"可选"}）` }],
      tier: 'strong',
    });
    if (!plan.ok) return { state: 'failed', finalText: plan.text, errorKind: plan.errorKind };
    const subs: SubTask[] = parsePlan(plan.text);
    await emitter.emit(ctx.runId, { type: 'step.succeeded', level: 'info', payload: { stepId: planStep, title: '主脑拆解', planSize: subs.length, concurrency: conc } });

    const states: SubState[] = subs.map((s, i) => ({ index: i, title: s.title, text: '', toolOutputs: [] }));

    // —— 阶段 A：并行模型轮（只收集工具调用，不执行）——
    await mapLimit(subs, conc, async (sub, i) => {
      if (budget.exhausted) return;
      if (!budget.takeModelCall()) return;
      if (!budget.takeStep()) return;
      const stepId = `s${budget.steps}`;
      await emitter.emit(ctx.runId, { type: 'step.started', level: 'info', payload: { seq: budget.steps, kind: 'model', title: `子代理 ${i + 1}: ${sub.title}`, parallel: true } });
      const messages: ModelMessage[] = [
        { role: 'system', content: `你是子代理，只负责：${sub.title}。不得越出范围；结论用 200 字内汇报。` },
        { role: 'user', content: sub.title },
      ];
      const r = await modelTurn(env, ctx, { stepId, messages, tools: toolSpecsFor(env.tools), tier: 'light' });
      if (!r.ok) { states[i].failed = { state: 'failed', finalText: r.text, errorKind: r.errorKind }; await emitter.emit(ctx.runId, { type: 'step.failed', level: 'error', payload: { stepId, title: sub.title, errorKind: r.errorKind } }); return; }
      states[i].text = r.text;
      (r.toolCalls ?? []).forEach((call) => { (states[i] as SubState & { pending?: PendingCall[] }).pending = [...((states[i] as SubState & { pending?: PendingCall[] }).pending ?? []), { subIndex: i, call }]; });
      await emitter.emit(ctx.runId, { type: 'step.succeeded', level: 'info', payload: { stepId, title: sub.title, toolsRequested: (r.toolCalls ?? []).length } });
    });

    const failed = states.find((s) => s.failed);
    if (failed?.failed) return failed.failed;

    // —— 阶段 B：工具串行漏斗（审批门保持单等待语义）——
    for (const s of states) {
      const pending = (s as SubState & { pending?: PendingCall[] }).pending ?? [];
      for (const pc of pending) {
        if (budget.exhausted) return { state: 'budget_exhausted', reason: 'limits' };
        if (!budget.takeStep()) return { state: 'budget_exhausted', reason: 'maxSteps' };
        const tStepId = `s${budget.steps}t${s.index}`;
        const t = await toolTurn(env, ctx, { stepId: tStepId, call: pc.call, argsJson: JSON.stringify(pc.call.args), idemKey: callIdempotencyKey(tStepId, pc.call.id) });
        if (t.kind === 'waiting_approval') return { state: 'waiting_approval', approvalId: t.approvalId!, promptSummary: t.summary, decisionKey: t.decisionKey };
        s.toolOutputs.push(`[${s.title}] ${JSON.stringify(t.result?.output ?? { ok: t.kind === 'ok', errorKind: t.reason })}`);
      }
    }

    // —— 阶段 C：有工具结果的子代理补一次汇报轮（并行）——
    const needFollowUps = states.filter((s) => s.toolOutputs.length > 0);
    if (needFollowUps.length > 0) {
      await mapLimit(needFollowUps, conc, async (s) => {
        if (!budget.takeModelCall()) return;
        const stepId = `s${budget.steps}f${s.index}`;
        const r = await modelTurn(env, ctx, {
          stepId,
          messages: [
            { role: 'system', content: `你是子代理，只负责：${s.title}。基于工具结果更新你的汇报（≤200 字）。` },
            { role: 'user', content: `你的初步结论：${s.text}\n工具结果：\n${s.toolOutputs.join('\n')}` },
          ],
          tier: 'light',
        });
        if (r.ok) { s.text = r.text; await emitter.emit(ctx.runId, { type: 'step.succeeded', level: 'info', payload: { stepId, title: `${s.title}（补报）` } }); }
      });
    }

    // —— 合并 ——
    const results = states.map((s) => `### ${s.title}\n${s.text}${s.toolOutputs.length > 0 ? `\n${s.toolOutputs.join('\n')}` : ''}`);
    if (!budget.takeModelCall()) return { state: 'budget_exhausted', reason: 'maxModelCalls' };
    if (!budget.takeStep()) return { state: 'budget_exhausted', reason: 'maxSteps' };
    const mergeStep = `s${budget.steps}`;
    const final = await modelTurn(env, ctx, {
      stepId: mergeStep,
      messages: [...ctx.history, { role: 'user', content: ctx.userMessage }, { role: 'assistant', content: `子代理汇报：\n${results.join('\n\n')}` }, { role: 'user', content: '合并为最终答复，标注各子任务结论。' }],
      tier: 'standard',
    });
    if (!final.ok) return { state: 'failed', finalText: final.text, errorKind: final.errorKind };
    await emitter.emit(ctx.runId, { type: 'run.completed', level: 'info', payload: { finalText: final.text, merged: true, subtasks: states.length, concurrency: conc } });
    return { state: 'completed', finalText: final.text };
  },
};
