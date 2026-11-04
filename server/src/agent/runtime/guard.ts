// Guard：成本/时间/输出预算的运行期护栏（超限即停，不静默续跑）
export interface BudgetState { costUsd: number; steps: number; startedAt: number; }

export interface BudgetLimit { maxCostUsd?: number; maxSteps?: number; maxWallclockMs?: number; }

export class BudgetGuard {
  state: BudgetState;
  readonly limit: BudgetLimit;
  readonly now: () => number;
  constructor(limit: BudgetLimit, now: () => number = () => Date.now()) {
    this.limit = limit;
    this.now = now;
    this.state = { costUsd: 0, steps: 0, startedAt: now() };
  }
  addCost(usd: number): void { this.state.costUsd += usd; }
  addStep(): void { this.state.steps += 1; }
  exceeded(): { exceeded: boolean; reason?: string } {
    if (this.limit.maxCostUsd !== undefined && this.state.costUsd >= this.limit.maxCostUsd) return { exceeded: true, reason: `cost ${this.state.costUsd}≥${this.limit.maxCostUsd}` };
    if (this.limit.maxSteps !== undefined && this.state.steps >= this.limit.maxSteps) return { exceeded: true, reason: `steps ${this.state.steps}≥${this.limit.maxSteps}` };
    if (this.limit.maxWallclockMs !== undefined && this.now() - this.state.startedAt >= this.limit.maxWallclockMs) return { exceeded: true, reason: 'wallclock' };
    return { exceeded: false };
  }
}
