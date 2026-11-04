// Graph Workflow：模型产出 DAG（节点 model/tool/human_gate，条件边）→ 拓扑执行。
import type { PatternRunner } from '../runner';
import type { RunContext, RunEnv, RunOutcome } from '../runner';
import { EventEmitter, RunBudget, modelTurn, toolTurn, callIdempotencyKey, toolSpecsFor } from '../runner';
import type { ModelMessage } from '../../model/types';

export type GraphNodeKind = 'model' | 'tool' | 'human_gate';
export interface GraphNode { id: string; kind: GraphNodeKind; title: string; toolName?: string; args?: Record<string, unknown>; condition?: string; }
export interface GraphEdge { from: string; to: string; }
export interface GraphDefinition { nodes: GraphNode[]; edges: GraphEdge[]; }

/** 解析 ```graph 代码块 JSON；失败=null（上层降级处理） */
export function parseGraph(text: string): GraphDefinition | null {
  const m = /```graph\s*\n([\s\S]*?)```/.exec(text);
  if (!m) return null;
  try {
    const g = JSON.parse(m[1]) as GraphDefinition;
    if (!Array.isArray(g.nodes) || g.nodes.length === 0 || !g.nodes.every((n) => n && typeof n.id === 'string' && typeof n.kind === 'string')) return null;
    return { nodes: g.nodes, edges: Array.isArray(g.edges) ? g.edges : [] };
  } catch { return null; }
}

/** 拓扑排序（Kahn）；环或未知边=null（拒绝执行，不伪造） */
export function topoOrder(g: GraphDefinition): string[] | null {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of g.nodes) { indeg.set(n.id, 0); adj.set(n.id, []); }
  for (const e of g.edges) {
    if (!indeg.has(e.from) || !indeg.has(e.to)) return null;   // 边引用未知节点
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    adj.get(e.from)!.push(e.to);
  }
  const q = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const out: string[] = [];
  while (q.length > 0) {
    const id = q.shift()!;
    out.push(id);
    for (const to of adj.get(id) ?? []) {
      indeg.set(to, (indeg.get(to) ?? 1) - 1);
      if (indeg.get(to) === 0) q.push(to);
    }
  }
  return out.length === g.nodes.length ? out : null;
}

export const graphWorkflowRunner: PatternRunner = {
  id: 'graph_workflow',
  async run(ctx: RunContext, env: RunEnv): Promise<RunOutcome> {
    const emitter = new EventEmitter(env.store);
    const budget = new RunBudget(ctx);

    if (!budget.takeModelCall()) return { state: 'budget_exhausted', reason: 'maxModelCalls' };
    if (!budget.takeStep()) return { state: 'budget_exhausted', reason: 'maxSteps' };
    const planStep = `s${budget.steps}`;
    const plan = await modelTurn(env, ctx, {
      stepId: planStep,
      messages: [...ctx.history, { role: 'user', content: `${ctx.userMessage}\n\n请产出 DAG（\`\`\`graph JSON：{"nodes":[{"id","kind":"model|tool|human_gate","title","toolName?","args?"}],"edges":[{"from","to"}]}）` }],
      tier: 'strong',
    });
    if (!plan.ok) return { state: 'failed', finalText: plan.text, errorKind: plan.errorKind };
    const graph = parseGraph(plan.text);
    if (!graph) {
      await emitter.emit(ctx.runId, { type: 'model_call.degraded', level: 'warn', payload: { stepId: planStep, kind: 'graph_unparsable', detail: '坏图定义→按计划文本顺序退化为单轮答复' } });
      await emitter.emit(ctx.runId, { type: 'run.completed', level: 'info', payload: { finalText: plan.text } });
      return { state: 'completed', finalText: plan.text };
    }
    const order = topoOrder(graph);
    if (!order) {
      await emitter.emit(ctx.runId, { type: 'run.failed', level: 'error', payload: { errorKind: 'graph_cycle' } });
      return { state: 'failed', finalText: '图定义存在环或未知节点边，已拒绝执行', errorKind: 'graph_cycle' };
    }
    const results: string[] = [];
    for (const nodeId of order) {
      const node = graph.nodes.find((n) => n.id === nodeId)!;
      if (budget.exhausted) return { state: 'budget_exhausted', reason: 'limits' };
      if (!budget.takeStep()) return { state: 'budget_exhausted', reason: 'maxSteps' };
      const stepId = `s${budget.steps}`;
      await emitter.emit(ctx.runId, { type: 'step.started', level: 'info', payload: { seq: budget.steps, kind: node.kind, title: node.title, node: node.id } });
      if (node.kind === 'tool' && node.toolName) {
        if (!budget.takeModelCall()) return { state: 'budget_exhausted', reason: 'maxModelCalls' };
        const call = { id: `g_${node.id}`, name: node.toolName, args: node.args ?? {} };
        const t = await toolTurn(env, ctx, { stepId, call, argsJson: JSON.stringify(call.args), idemKey: callIdempotencyKey(stepId, call.id) });
        if (t.kind === 'waiting_approval') return { state: 'waiting_approval', approvalId: t.approvalId!, promptSummary: t.summary, decisionKey: t.decisionKey };
        results.push(`${node.id}: ${JSON.stringify(t.result?.output ?? { ok: t.kind === 'ok' })}`);
      } else if (node.kind === 'human_gate') {
        // 人工门：无供应商侧决策，必须人工放行（决策键 = gate 节点 id|参数，供恢复期注入）
        const gateArgsJson = JSON.stringify(node.args ?? {});
        const ap = env.approvals.request({ runId: ctx.runId, stepId, toolId: `gate:${node.id}`, normalizedArgsJson: gateArgsJson, riskLevel: 'r2', summary: `人工门 ${node.title}` });
        await emitter.emit(ctx.runId, { type: 'approval.requested', level: 'warn', payload: { approvalId: ap.id, stepId, toolFingerprint: ap.toolFingerprint, riskLevel: 'r2', summary: ap.summary, expiresAt: 'run-terminal', node: node.id } });
        return { state: 'waiting_approval', approvalId: ap.id, promptSummary: ap.summary, decisionKey: `gate:${node.id}|${gateArgsJson}` };
      } else {
        if (!budget.takeModelCall()) return { state: 'budget_exhausted', reason: 'maxModelCalls' };
        const r = await modelTurn(env, ctx, { stepId, messages: [{ role: 'user', content: `节点 ${node.id}：${node.title}\n已完成：\n${results.join('\n') || '（无）'}` }], tools: toolSpecsFor(env.tools), tier: 'standard' });
        if (!r.ok) return { state: 'failed', finalText: r.text, errorKind: r.errorKind };
        results.push(`${node.id}: ${r.text}`);
      }
      await emitter.emit(ctx.runId, { type: 'step.succeeded', level: 'info', payload: { stepId, title: node.title, node: node.id } });
    }
    const finalText = results.join('\n');
    await emitter.emit(ctx.runId, { type: 'run.completed', level: 'info', payload: { finalText, graph: true } });
    return { state: 'completed', finalText };
  },
};
