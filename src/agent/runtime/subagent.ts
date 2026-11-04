// Subagent 派发（M3）：父 Agent 在 Run 内派发隔离子任务（persona + 工具子集 + 只读共享上下文）。
// 边界（extension-contracts §3.2）：子代理不得自行提升档位/越过审批门；结果回传父级后由父级决定。
// v1 串行派发（与 agent Prisma Step.seq 串行约束一致）；并行派发为后续项。
// 边界说明（2026-10-25）：本类是「宿主/AgentLoop 派发独立子任务」的入口（AgentLoop.subagentChannel）。
// 模式层的 multi_agent 子代理循环不走本类（它有自己已验证的 mapLimit 并行语义，但工具同样经 toolTurn 同一 Guard 通道）——
// 两条路径共用同一个审批门实现，不存在"绕过审批"的分叉。
import type { ModelClient } from '../model/types';
import type { ToolRegistry } from '../tools/registry';
import type { EventStore } from '../events/types';
import { EventEmitter, toolTurn, type ToolTurnOutcome } from './runner';
import type { ToolCallRequest, ModelMessage } from '../model/types';
import type { RunContext } from './runner';

export interface SubagentSpec {
  id: string;
  title: string;
  systemPrompt: string;
  toolSubset: string[];        // versioned tool ids；空=无工具
  tier: 'light' | 'standard' | 'strong';
  maxSteps: number;
}

export interface SubagentResult {
  specId: string;
  ok: boolean;
  text: string;
  stepsUsed: number;
  errorKind?: string;
}

export interface SubagentDeps { model: ModelClient; tools: ToolRegistry; store: EventStore; }

/** 父级 Guard 通道（AgentLoop 注入 toolTurn 包装）；宿主侧补充声明——agent 源缺失此导出，tsx 不类型检查故未暴露 */
export type ParentToolChannel = (call: ToolCallRequest, idemKey: string) => Promise<ToolTurnOutcome>;

export class SubagentRunner {
  readonly deps: SubagentDeps;
  /** 父级 Guard 通道（AgentLoop 注入 toolTurn 包装）；未注入=子代理完全无工具执行权 */
  parentToolChannel?: ParentToolChannel;
  /** 父级 Run 上下文（提供 workspaceRoots 等；审批门/授权复检需要） */
  parentCtx?: RunContext;
  constructor(deps: SubagentDeps) { this.deps = deps; }

  async run(spec: SubagentSpec, task: string, parent: { runId: string }): Promise<SubagentResult> {
    const emitter = new EventEmitter(this.deps.store);
    let steps = 0;
    let toolFailures = 0;
    let toolSuccesses = 0;
    // workspaceRoots 为空是安全隐患：传给 toolTurn 的 ctx 需有真实根目录（由父级注入）
    const ctxWithRoots: RunContext | undefined = this.parentCtx;
    const messages: ModelMessage[] = [
      { role: 'system', content: spec.systemPrompt },
      { role: 'user', content: task },
    ];
    const tools = spec.toolSubset
      .map((id) => this.deps.tools.get(id))
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
      .map((s) => ({ name: s.id, description: s.description, inputSchema: s.inputSchema }));
    for (let i = 0; i < spec.maxSteps; i++) {
      steps++;
      const res = await this.deps.model.chat({
        role: 'main', modelRef: { tier: spec.tier },
        systemPrompt: spec.systemPrompt, messages, tools,
        metadata: { runId: parent.runId, stepId: `sub_${spec.id}_${i}`, taskId: spec.id, attempt: 0 },
      });
      if (res.finishReason === 'error') {
        await emitter.emit(parent.runId, { type: 'step.failed', level: 'error', payload: { kind: 'subagent', specId: spec.id, errorKind: res.errorKind ?? 'unknown' } });
        return { specId: spec.id, ok: false, text: res.text, stepsUsed: steps, errorKind: res.errorKind ?? 'unknown' };
      }
      if ((res.toolCalls ?? []).length === 0) {
        // 诚实判定：本轮工具调用全部失败（无一次成功执行）→ 不得报 ok（模型可能只是放弃了）
        const ok = toolFailures === 0 || toolSuccesses > 0;
        await emitter.emit(parent.runId, { type: 'step.succeeded', level: ok ? 'info' : 'warn', payload: { kind: 'subagent', specId: spec.id, stepsUsed: steps, toolFailures, toolSuccesses } });
        return { specId: spec.id, ok, text: res.text, stepsUsed: steps, ...(ok ? {} : { errorKind: 'subagent_tools_failed' }) };
      }
      messages.push({ role: 'assistant', content: res.text });
      // 工具执行必须经父级 Guard 通道（toolTurn 语义：定级→r3/r2 审批→授权→事件）。
      // 红线：子代理不得自行执行工具（无单独审批通道）；通道未注入时一律 tool_not_in_subset 拒绝。
      for (const call of res.toolCalls ?? []) {
        const spec2 = this.deps.tools.get(call.name);
        if (!spec2 || !spec.toolSubset.includes(call.name) || !this.parentToolChannel) {
          toolFailures++;
          messages.push({ role: 'tool', content: JSON.stringify({ ok: false, errorKind: 'tool_not_in_subset' }), toolCallId: call.id, name: call.name });
          continue;
        }
        const t = await this.parentToolChannel(call, `sub_${spec.id}_${i}:${call.id}`);
        if (t.kind === 'waiting_approval') return { specId: spec.id, ok: false, text: `等待人工批准（${t.approvalId}）`, stepsUsed: steps, errorKind: 'waiting_approval' };
        if (t.kind === 'ok') toolSuccesses++; else toolFailures++;
        messages.push({ role: 'tool', content: JSON.stringify(t.result?.output ?? { ok: t.kind === 'ok', errorKind: t.reason }), toolCallId: call.id, name: call.name });
      }
    }
    // 步数用尽=未自然收敛：如实标 ok:false（不得把"没做完"报成成功）
    return { specId: spec.id, ok: false, text: '（子代理步数用尽，未收敛）', stepsUsed: steps, errorKind: 'max_steps_exhausted' };
  }
}
