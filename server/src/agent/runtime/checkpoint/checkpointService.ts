// CheckpointService：每 N 个事件步自动存档 + 挂起点（waiting_*）强制存档。
// M3：AgentLoop 注入；恢复时把 skipToolCalls 以 decisions 同构键（idempotencyKey）交给 toolTurn。
import type { EventStore } from '../../events/types';
import type { CheckpointStore, Checkpoint } from './checkpointStore';
import { EventEmitter } from '../runner';

export class CheckpointService {
  private dirty = 0;
  readonly store: EventStore;
  readonly cps: CheckpointStore;
  readonly every: number;
  constructor(store: EventStore, cps: CheckpointStore, every: number = 5) {
    this.store = store; this.cps = cps; this.every = every;
  }

  /** 事件步进后调用；到达间隔或 force=true 时存档 */
  async tick(runId: string, force = false): Promise<Checkpoint | null> {
    this.dirty++;
    if (!force && this.dirty < this.every) return null;
    this.dirty = 0;
    const events = await this.store.getEvents(runId);
    const cp = await this.cps.save(runId, events);
    await new EventEmitter(this.store).emit(runId, { type: 'step.succeeded', level: 'info', payload: { kind: 'checkpoint', checkpointId: cp.id, atEventSeq: cp.atEventSeq, version: cp.version } });
    return cp;
  }
}
