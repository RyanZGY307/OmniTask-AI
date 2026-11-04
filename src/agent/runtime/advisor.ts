// Advisor（第三意见，D3/Pro 专属；adaptive-execution §8 DEC-03 的代码落地）
// 触发条件（设计值，待实测校准）：连续 K 步无工件进展 / 模型连续两次同类错误 / r3 审批后执行失败。
// Advisor 结构化输出：{agree, objections[], suggestion}；父 Agent 采纳与否必须留痕（不得静默丢弃）。
import type { ModelClient } from '../model/types';
import type { EventStore } from '../events/types';
import { EventEmitter } from './runner';

export interface AdvisorTrigger {
  kind: 'no_progress' | 'repeat_error' | 'post_approval_failure';
  detail: string;
  stepsSinceArtifact?: number;
}

export interface AdvisorOpinion {
  agree: boolean;
  objections: string[];
  suggestion: string;
  modelKey?: string;
}

export interface AdvisorThresholds {
  stepsSinceArtifact: number;   // 默认 4（设计值）
  repeatErrorCount: number;      // 默认 2（设计值）
}

export const DEFAULT_ADVISOR_THRESHOLDS: AdvisorThresholds = { stepsSinceArtifact: 4, repeatErrorCount: 2 };

/** 触发判定（纯函数可测）：false=不打扰 */
export function shouldInvokeAdvisor(t: AdvisorTrigger, th: AdvisorThresholds = DEFAULT_ADVISOR_THRESHOLDS): boolean {
  if (t.kind === 'no_progress') return (t.stepsSinceArtifact ?? 0) >= th.stepsSinceArtifact;
  if (t.kind === 'repeat_error') return true;   // 调用方已按 repeatErrorCount 计数后触发
  if (t.kind === 'post_approval_failure') return true;
  return false;
}

export interface AdvisorDeps { model: ModelClient; store: EventStore; }

export class Advisor {
  private last?: AdvisorOpinion;
  readonly deps: AdvisorDeps;

  constructor(deps: AdvisorDeps) { this.deps = deps; }

  /** 征求第三意见；解析失败=不阻塞主链（留痕 degraded） */
  async consult(ctx: { runId: string; taskSummary: string; plan: string; lastError?: string }): Promise<AdvisorOpinion | null> {
    const emitter = new EventEmitter(this.deps.store);
    const res = await this.deps.model.chat({
      role: 'advisor', modelRef: { tier: 'standard' },
      systemPrompt: '你是 advisor：只对计划/策略给第三意见。输出 JSON：{"agree":boolean,"objections":string[],"suggestion":string}。不得执行任何动作。',
      messages: [{ role: 'user', content: `任务：${ctx.taskSummary}\n当前计划：${ctx.plan}\n${ctx.lastError ? `最近错误：${ctx.lastError}` : ''}` }],
      responseFormat: 'json_object',
      metadata: { runId: ctx.runId, stepId: 'advisor', taskId: 'advisor', attempt: 0 },
    });
    if (res.finishReason === 'error') {
      await emitter.emit(ctx.runId, { type: 'model_call.degraded', level: 'warn', payload: { kind: 'advisor_unavailable', detail: res.errorKind ?? 'unknown' } });
      return null;
    }
    let opinion: AdvisorOpinion | null = null;
    try {
      const parsed = JSON.parse(res.text) as Partial<AdvisorOpinion>;
      opinion = { agree: Boolean(parsed.agree), objections: Array.isArray(parsed.objections) ? parsed.objections.map(String) : [], suggestion: String(parsed.suggestion ?? ''), modelKey: res.modelRef.modelKey };
    } catch {
      await emitter.emit(ctx.runId, { type: 'model_call.degraded', level: 'warn', payload: { kind: 'advisor_bad_json', detail: res.text.slice(0, 200) } });
      return null;
    }
    this.last = opinion;
    await emitter.emit(ctx.runId, { type: 'model_call.finished', level: 'info', payload: { role: 'advisor', agree: opinion.agree, objections: opinion.objections.length, simulated: this.deps.model.simulated ?? false } });
    return opinion;
  }

  /** 采纳留痕（无论采纳或拒绝都发事件；红线：不得静默丢弃 advisor 意见） */
  async recordAdoption(runId: string, adopted: boolean, rationale: string): Promise<void> {
    await new EventEmitter(this.deps.store).emit(runId, { type: 'model_call.degraded', level: 'info', payload: { kind: 'advisor_adoption', adopted, rationale } });
  }

  get lastOpinion(): AdvisorOpinion | undefined { return this.last; }
}
