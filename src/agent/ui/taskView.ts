// 任务列表/详情 UI 的**状态契约**（M4）：宿主前端（Next.js）消费 EventStore 事件流渲染。
// 宿主落点：server/src/agent/ui/taskView.ts（由 OmniTask-Agent src/ui/taskView.ts 整体复制，
// 仅修正 import 后缀以适配宿主 tsconfig——无 allowImportingTsExtensions）。
// 投影唯一事实源 = 事件流：服务端在每个查询端点用本模块把 Event[] 折叠成 TaskCardVM 返回前端，
// 前端不得另存任务状态、不得本地推断未送达事件（禁乐观渲染）。
// 本文件是纯函数投影：事件 → 视图模型（不引 DOM/React，宿主侧直接映射组件）。
// 口径：UI 只展示事件已发生的事实；不得本地推断未送达的事件（禁止乐观渲染）。
import type { AgentEvent, EventType } from '../events/types';

export type TaskPhase =
  | 'created' | 'selected' | 'running' | 'waiting_approval' | 'waiting_user'
  | 'compacting' | 'restoring' | 'completed' | 'failed' | 'canceled' | 'budget_exhausted';

export interface TaskCardVM {
  runId: string;
  pattern?: string;            // pattern.selected.payload.pattern
  patternLabel?: string;
  phase: TaskPhase;
  steps: number;               // step.started 计数
  approvalsPending: number;
  userInputsPending: number;
  lastEventType: EventType | null;
  lastEventSeq: number;
  finalText?: string;          // run.completed.payload.finalText
  errorKind?: string;          // run.failed/step.failed payload.errorKind
  downgradedFrom?: string;     // pattern.downgraded
}

export interface TaskEventRowVM {
  seq: number;
  type: EventType;
  level: AgentEvent['level'];
  ts: string;
  summary: string;             // 一行人话摘要（供列表展开）
}

/** 单 Run 视图模型：按事件序折叠（UI 只读投影，无本地状态） */
export function projectTaskCard(events: AgentEvent[]): TaskCardVM {
  const card: TaskCardVM = { runId: '', phase: 'created', steps: 0, approvalsPending: 0, userInputsPending: 0, lastEventType: null, lastEventSeq: 0 };
  for (const e of events) {
    card.runId = e.runId;
    card.lastEventType = e.type;
    card.lastEventSeq = e.seq;
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case 'run.created': card.phase = 'created'; break;
      case 'pattern.selected': card.phase = 'selected'; card.pattern = String(p.pattern); card.patternLabel = String(p.label); break;
      case 'pattern.downgraded': card.downgradedFrom = String((p as { from?: string }).from); break;
      case 'run.started': card.phase = 'running'; break;
      case 'run.restored': card.phase = 'restoring'; break;
      case 'run.compacted': card.phase = 'compacting'; break;
      case 'step.started': card.steps += 1; card.phase = 'running'; break;
      case 'approval.requested': card.phase = 'waiting_approval'; card.approvalsPending += 1; break;
      case 'approval.decided': card.approvalsPending = Math.max(0, card.approvalsPending - 1); card.phase = 'running'; break;
      case 'approval.expired': card.approvalsPending = Math.max(0, card.approvalsPending - 1); break;
      case 'userinput.requested': card.phase = 'waiting_user'; card.userInputsPending += 1; break;
      case 'userinput.answered': card.userInputsPending = Math.max(0, card.userInputsPending - 1); card.phase = 'running'; break;
      case 'run.completed': card.phase = 'completed'; card.finalText = typeof p.finalText === 'string' ? p.finalText : undefined; break;
      case 'run.failed': card.phase = 'failed'; card.errorKind = typeof p.errorKind === 'string' ? p.errorKind : undefined; break;
      case 'run.canceled': card.phase = 'canceled'; break;
      case 'run.budget_exhausted': card.phase = 'budget_exhausted'; card.errorKind = typeof p.reason === 'string' ? p.reason : undefined; break;
      default: break;
    }
  }
  return card;
}

/** 事件行人话摘要（列表展开行） */
export function summarizeEvent(e: AgentEvent): string {
  const p = e.payload as Record<string, unknown>;
  const s = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
  switch (e.type) {
    case 'pattern.selected': return `选择架构：${s(p.label)}（${s(p.reason)}）`;
    case 'pattern.downgraded': return `档位门禁：${s(p.from)}→${s(p.to)}`;
    case 'run.depth_decided': return `深度档：${s(p.depth)}`;
    case 'step.started': return `步骤 ${s(p.seq)}：${s(p.title)}`;
    case 'tool.requested': return `工具 ${s(p.toolId)}（${s(p.riskLevel)}）`;
    case 'tool.result': return `工具结果：${p.ok === true ? '成功' : `失败 ${s(p.errorKind)}`}`;
    case 'approval.requested': return `审批请求：${s(p.summary)}`;
    case 'approval.decided': return `审批决定：${s(p.decision)}`;
    case 'userinput.requested': return `提问：${s(p.prompt)}`;
    case 'no_progress.detected': return `无进展（${s(p.stepsSinceArtifact)} 步）`;
    case 'run.compacted': return `压缩 ${s(p.level)}（≈${s(p.origin)}→${s(p.kept)} 条）`;
    case 'model_call.degraded': return `降级：${s(p.kind)} ${s(p.detail)}`;
    case 'run.completed': return `完成：${(s(p.finalText) || '').slice(0, 80)}`;
    case 'run.failed': return `失败：${s(p.errorKind)}`;
    default: return e.type;
  }
}

export function toEventRows(events: AgentEvent[]): TaskEventRowVM[] {
  return events.map((e) => ({ seq: e.seq, type: e.type, level: e.level, ts: e.ts, summary: summarizeEvent(e) }));
}
