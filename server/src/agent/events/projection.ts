// 事件→物化态投影与恢复判定（docs/architecture/execution-flow 场景 C 的可执行版）
// 规则（core-data-model §6.3/§6.4）：
//  - 恢复 = 最后 checkpoint + 事件重放；幂等键保证已成功副作用不重放
//  - 已成功 toolCall（收到 tool.result 且 ok=true）在恢复时跳过（tool.replayed_skipped）
//  - waiting_* 挂起点必须恢复为可见状态（审批卡/提问卡重连重现）
import type { AgentEvent } from './types';

export interface RunProjection {
  runId: string;
  state: 'created' | 'running' | 'waiting_user' | 'waiting_approval' | 'recovering' | 'completed' | 'failed' | 'canceled' | 'timed_out' | 'budget_exhausted';
  depth: string;
  modelTier: string;
  lastSeq: number;
  succeededToolCalls: Set<string>;   // 幂等跳过集合（toolCallId 粒度）
  /** 幂等跳过集合（稳定粒度）：toolId|argsJson —— resume 重放时 toolCallId/stepId 都会变，只有工具+参数不变 */
  succeededToolFingerprints: Set<string>;
  pendingApprovals: string[];
  pendingUserInputs: string[];
}

export function projectRun(events: AgentEvent[]): RunProjection {
  const p: RunProjection = {
    runId: '',
    state: 'created',
    depth: 'd2',
    modelTier: 'standard',
    lastSeq: 0,
    succeededToolCalls: new Set<string>(),
    succeededToolFingerprints: new Set<string>(),
    pendingApprovals: [],
    pendingUserInputs: [],
  };
  for (const e of events) {
    p.runId = e.runId;
    p.lastSeq = e.seq;
    switch (e.type) {
      case 'run.created':
        p.state = 'created';
        p.depth = String(e.payload.depth ?? p.depth);
        p.modelTier = String(e.payload.modelTier ?? p.modelTier);
        break;
      case 'run.started': p.state = 'running'; break;
      case 'run.restored': p.state = 'running'; break;
      case 'approval.requested': {
        p.state = 'waiting_approval';
        p.pendingApprovals.push(String(e.payload.approvalId));
        break;
      }
      case 'approval.decided':
      case 'approval.expired': {
        const id = String(e.payload.approvalId);
        p.pendingApprovals = p.pendingApprovals.filter((x) => x !== id);
        p.state = 'running';
        break;
      }
      case 'userinput.requested': {
        p.state = 'waiting_user';
        p.pendingUserInputs.push(String(e.payload.requestId));
        break;
      }
      case 'userinput.answered': {
        const id = String(e.payload.requestId);
        p.pendingUserInputs = p.pendingUserInputs.filter((x) => x !== id);
        p.state = 'running';
        break;
      }
      case 'tool.result': {
        const tc = String(e.payload.toolCallId);
        if (e.payload.ok === true) {
          p.succeededToolCalls.add(tc);
          const fp = `${String(e.payload.toolId)}|${String(e.payload.argsJson ?? '')}`;
          if (e.payload.argsJson !== undefined) p.succeededToolFingerprints.add(fp);
        }
        break;
      }
      case 'run.completed': p.state = 'completed'; break;
      case 'run.failed': p.state = 'failed'; break;
      case 'run.canceled': p.state = 'canceled'; break;
      case 'run.budget_exhausted': p.state = 'budget_exhausted'; break;
      default: break;
    }
  }
  return p;
}

/** 恢复时判定：该 toolCall 是否已成功执行（跳过重放） */
export function shouldSkipReplay(projection: RunProjection, toolCallId: string): boolean {
  return projection.succeededToolCalls.has(toolCallId);
}
