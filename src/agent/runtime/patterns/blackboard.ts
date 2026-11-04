// Blackboard：共享黑板（结构化条目）+ 控制循环，多视角提案直到 CONVERGED/上限。
import type { PatternRunner } from '../runner';
import type { RunContext, RunEnv, RunOutcome } from '../runner';
import { EventEmitter, RunBudget, modelTurn, toolTurn, callIdempotencyKey, toolSpecsFor } from '../runner';
import type { ModelMessage } from '../../model/types';

export interface BoardEntry { author: string; kind: 'hypothesis' | 'evidence' | 'constraint' | 'proposal' | 'critique'; content: string; }

export interface BlackboardState {
  entries: BoardEntry[];
  status: 'open' | 'converged';
  maxRounds: number;
}

export function createBoard(maxRounds = 3): BlackboardState { return { entries: [], status: 'open', maxRounds }; }

/** 控制循环：下一贡献者（按视角轮换）——纯函数，可测 */
export function nextContributor(round: number): string {
  const views = ['advocate', 'critic', 'synthesizer'];
  return views[round % views.length];
}

export function boardText(b: BlackboardState): string {
  return b.entries.map((e) => `[${e.author}/${e.kind}] ${e.content}`).join('\n');
}

/** 收敛判定：synthesizer 输出 CONVERGED 即收敛（委托模型判定，不伪造规则引擎） */
export function isConverged(text: string): boolean {
  return /\bCONVERGED\b/.test(text);
}

export const blackboardRunner: PatternRunner = {
  id: 'blackboard',
  async run(ctx: RunContext, env: RunEnv): Promise<RunOutcome> {
    const emitter = new EventEmitter(env.store);
    const budget = new RunBudget(ctx);
    // 轮数=独立上限（黑板收敛轮），不复用 step 预算；默认 3 轮，宿主可经 limits.maxSteps 收紧
    const maxRounds = Math.max(1, Math.min(6, Math.floor(ctx.limits.maxSteps / 2) || 3));
    const board = createBoard(maxRounds);
    const messages: ModelMessage[] = [
      { role: 'system', content: '你是黑板控制系统的贡献者，按给定视角输出一条条目；视角为 synthesizer 且已达成一致时输出 CONVERGED。' },
      { role: 'user', content: ctx.userMessage },
    ];
    for (let round = 0; round < board.maxRounds; round++) {
      if (budget.exhausted) return { state: 'budget_exhausted', reason: 'limits' };
      if (!budget.takeModelCall()) return { state: 'budget_exhausted', reason: 'maxModelCalls' };
      if (!budget.takeStep()) return { state: 'budget_exhausted', reason: 'maxSteps' };
      const stepId = `s${budget.steps}`;
      const author = nextContributor(round);
      const r = await modelTurn(env, ctx, {
        stepId,
        messages: [...messages, { role: 'user', content: `当前黑板：\n${boardText(board) || '（空）'}\n\n请以 ${author} 视角贡献一条（格式：kind=proposal|critique|evidence|constraint|hypothesis 后换行正文）。` }],
        tools: toolSpecsFor(env.tools),
        tier: round === board.maxRounds - 1 ? 'strong' : 'standard',
      });
      if (!r.ok) return { state: 'failed', finalText: r.text, errorKind: r.errorKind };
      const kind = (/(proposal|critique|evidence|constraint|hypothesis)/.exec(r.text)?.[1] ?? 'proposal') as BoardEntry['kind'];
      let content = r.text;
      // 贡献者请求工具：不得静默吞掉——逐个走 toolTurn（保持单审批门语义），结果并入该条目
      for (const call of r.toolCalls ?? []) {
        if (!budget.takeStep()) return { state: 'budget_exhausted', reason: 'maxSteps' };
        const tStepId = `s${budget.steps}t`;
        const t = await toolTurn(env, ctx, { stepId: tStepId, call, argsJson: JSON.stringify(call.args), idemKey: callIdempotencyKey(tStepId, call.id) });
        if (t.kind === 'waiting_approval') return { state: 'waiting_approval', approvalId: t.approvalId!, promptSummary: t.summary, decisionKey: t.decisionKey };
        content += `\n[工具 ${call.name}] ${JSON.stringify(t.result?.output ?? { ok: t.kind === 'ok', errorKind: t.reason })}`;
      }
      board.entries.push({ author, kind, content });
      await emitter.emit(ctx.runId, { type: 'step.succeeded', level: 'info', payload: { stepId, title: `黑板轮 ${round + 1}（${author}/${kind}）` } });
      if (author === 'synthesizer' && isConverged(r.text)) {
        board.status = 'converged';
        break;
      }
    }
    await emitter.emit(ctx.runId, { type: 'run.completed', level: 'info', payload: { finalText: boardText(board), converged: board.status === 'converged' } });
    return { state: 'completed', finalText: boardText(board) };
  },
};
