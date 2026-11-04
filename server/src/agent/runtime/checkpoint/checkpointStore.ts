// Checkpoint 存储与恢复（替代 M1/M2 的"整轮重放"）：事件水位 → 物化态 → 只重放未完成步骤。
// 语义（core-data-model §6.3）：恢复 = 最后 checkpoint + 事件增量重放；幂等键保证已成功副作用不重放。
import type { AgentEvent, EventStore } from '../../events/types';
import { projectRun, type RunProjection } from '../../events/projection';
import { idempotencyKey } from '../../events/ids';

export interface Checkpoint {
  id: string;
  runId: string;
  version: number;
  atEventSeq: number;
  projection: RunProjection;
  createdAt: string;
}

export interface CheckpointStore {
  save(runId: string, events: AgentEvent[]): Promise<Checkpoint>;
  latest(runId: string): Promise<Checkpoint | null>;
  /** 恢复：最后一个 checkpoint + 其后事件增量重放（已成功 toolCall 不进重放清单） */
  resumePlan(runId: string): Promise<{ checkpoint: Checkpoint | null; projection: RunProjection; replayFromSeq: number; skipToolCalls: string[] }>;
}

export class InMemoryCheckpointStore implements CheckpointStore {
  private byRun = new Map<string, Checkpoint[]>();

  async save(runId: string, events: AgentEvent[]): Promise<Checkpoint> {
    const list = this.byRun.get(runId) ?? [];
    const cp: Checkpoint = {
      id: `cp_${runId}_${list.length + 1}`,
      runId,
      version: list.length + 1,
      atEventSeq: events.length > 0 ? events[events.length - 1].seq : 0,
      projection: projectRun(events),
      createdAt: new Date().toISOString(),
    };
    list.push(cp);
    this.byRun.set(runId, list);
    return cp;
  }

  async latest(runId: string): Promise<Checkpoint | null> {
    const list = this.byRun.get(runId) ?? [];
    return list.length > 0 ? list[list.length - 1] : null;
  }

  async resumePlan(runId: string): Promise<{ checkpoint: Checkpoint | null; projection: RunProjection; replayFromSeq: number; skipToolCalls: string[] }> {
    const cp = await this.latest(runId);
    const base = cp?.projection ?? projectRun([]);
    return {
      checkpoint: cp,
      projection: { ...base, runId },
      replayFromSeq: cp?.atEventSeq ?? 0,
      skipToolCalls: [...base.succeededToolCalls],
    };
  }
}

/** 从事件存储重建（无 checkpoint 时的全量兜底） */
export async function rebuild(store: EventStore, runId: string): Promise<RunProjection> {
  return projectRun(await store.getEvents(runId));
}

/** 重放清单：给定历史 toolCall（stepId, callId, toolId, argsJson）判定哪些可跳过 */
export function replaySchedule(projection: RunProjection, calls: Array<{ stepId: string; toolCallId: string }>): Array<{ stepId: string; toolCallId: string; key: string; skip: boolean }> {
  return calls.map((c) => {
    const key = idempotencyKey(c.stepId, c.toolCallId);
    return { ...c, key, skip: projection.succeededToolCalls.has(c.toolCallId) };
  });
}
